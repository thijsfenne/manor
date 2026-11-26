import {
  MAIL_INBOX_WINDOW,
  MAIL_RECIPIENTS_MAX,
  MAIL_THREAD_MESSAGES_MAX,
  mailBareAddress,
  type ClientMessage,
  type MailCard,
  type MailLabel,
  type MailMessage,
  type MailThread,
  type ServerMessage,
} from '@manor/contracts'
import { MailCache } from './mailCache.js'
import { MailDrafts, type MailAgentRuntime } from './mailDraft.js'
import { MailSender } from './mailSend.js'
import { normalAddress, type MailSource } from './mailSource.js'
import { MailTriage, type MailToolHost } from './mailTriage.js'
import type { OutboundSendPort } from './outboundSend.js'

type MailClientMessage = Extract<ClientMessage, { type: `mail_${string}` }>
type MailStateMessage = Extract<ServerMessage, { type: 'mail_state' }>

interface MailModuleOptions {
  /** Absent on a host with no mailbox configured; the Mail door is hidden there. */
  source?: MailSource
  /** The cache's SQLite file, `paths.mailCache`; `:memory:` keeps it off disk (mock mode, tests). */
  cacheFile: string
  /** The projects that exist now; a sender link to any other is dropped. */
  projectIds: () => Promise<Iterable<string>>
  broadcast: (message: ServerMessage) => void
  now?: () => number
  /** Runs the default agent for drafts and triage; without it both answer that they are unavailable. */
  runtime?: MailAgentRuntime
  /** The user's Send goes through this port; without it a send is refused. */
  send?: OutboundSendPort
  /** Serves the triage run's one tool, the server's MCP HTTP host. */
  toolHost?: MailToolHost
}

const SNIPPET_CHARS = 220

/** A cache file damaged under a running server; replaced rather than reported. */
const isCorrupt = (error: unknown) => {
  const code = (error as { errcode?: unknown } | undefined)?.errcode
  return code === 11 || code === 26 || (error instanceof Error && /malformed|not a database/i.test(error.message))
}

const reason = (error: unknown, fallback: string) => (error instanceof Error && error.message !== '' ? error.message : fallback)

/** Joins addresses with `, ` and stops before the line would pass the contract's limit. */
function recipientLine(addresses: readonly string[]): string {
  let line = ''
  for (const address of addresses) {
    const next = line === '' ? address : `${line}, ${address}`
    if (next.length > MAIL_RECIPIENTS_MAX) break
    line = next
  }
  return line
}

/** `Re: <subject>`, without stacking a second `Re:` on a subject that already has one. */
export const replySubject = (subject: string) => `Re: ${subject.replace(/^(\s*re\s*:\s*)+/i, '')}`.slice(0, 1_000)

/**
 * Where a reply goes by default. To is the newest sender that is not the account; Cc is
 * that message's other To and Cc addresses, minus the account. When the account wrote
 * every message (a thread waiting for an answer), the reply follows up to the newest
 * message's own recipients. Bare addresses only: a display name may hold a comma.
 */
export function mailReplyFor(messages: readonly MailMessage[], account: string, subject: string): MailThread['reply'] {
  const self = normalAddress(account)
  const bare = (value: string) => mailBareAddress(value)
  const answered = [...messages].reverse().find((message) => {
    const from = bare(message.from.address)
    return from !== undefined && from !== self
  })
  const unique = (values: (string | undefined)[], exclude: ReadonlySet<string>) =>
    [...new Set(values.filter((value): value is string => value !== undefined && value !== self && !exclude.has(value)))]
  if (answered !== undefined) {
    const to = bare(answered.from.address)
    const cc = unique([...answered.to, ...answered.cc].map((entry) => bare(entry.address)), new Set(to === undefined ? [] : [to]))
    return { to: to ?? '', cc: recipientLine(cc), subject: replySubject(subject) }
  }
  // A follow-up on the account's own mail. The send path takes one To; the others ride in Cc.
  const newest = messages.at(-1)
  const [to, ...others] = unique((newest?.to ?? []).map((entry) => bare(entry.address)), new Set())
  const cc = unique([...others, ...(newest?.cc ?? []).map((entry) => bare(entry.address))], new Set(to === undefined ? [] : [to]))
  return { to: to ?? '', cc: recipientLine(cc), subject: replySubject(subject) }
}

/**
 * The Mail door's protocol. It owns the mailbox source and the disposable cache: the
 * cache answers at once, a poll on focus brings it up to date, and the only mailbox
 * write is the user's Archive and its Undo, and the only send is the user's Send.
 * Mail that arrives never starts an agent turn by itself: only a reply draft the user
 * asked for and the triage run (scheduled, the user's click, or the open Mail view
 * finding new mail on its poll) do, through `MailDrafts` and `MailTriage`, neither of
 * which can reach Archive or Send.
 *
 * Source calls that change what the Inbox holds (polls, archive, restore) run one at a
 * time, so a poll that listed the Inbox before an archive can never land after it.
 */
export class MailModule {
  private cacheHandle: MailCache | undefined
  private tail: Promise<unknown> = Promise.resolve()
  private pendingPoll: Promise<void> | undefined
  private pollError: string | undefined
  /** Threads whose archive is in flight; a poll leaves them out even when its listing still has them. */
  private readonly archiving = new Set<string>()
  private triageRunning = false
  private readonly drafts: MailDrafts
  private readonly triage: MailTriage
  private readonly sender: MailSender | undefined

  constructor(private readonly options: MailModuleOptions) {
    const { source } = options
    this.cacheHandle = source === undefined ? undefined : MailCache.open(options.cacheFile, source.account())
    // A send still `started` was cut off when the server stopped; whether it left is unknown.
    this.cacheHandle?.markStartedSendClaimsUncertain()
    const account = () => source?.account() ?? ''
    this.drafts = new MailDrafts({
      ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
      account,
      thread: async (threadId) => this.cachedThread(threadId) ?? this.openThread(threadId),
    })
    this.triage = new MailTriage({
      module: this,
      ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
      ...(options.toolHost === undefined ? {} : { toolHost: options.toolHost }),
      account,
      now: () => this.now(),
    })
    this.sender = source === undefined || options.send === undefined ? undefined : new MailSender({
      cache: () => this.cacheHandle,
      port: options.send,
      account: source.account(),
      subject: replySubject,
      now: () => this.now(),
    })
  }

  /** Absent with no source: there is nothing to cache. Slice B's draft, triage and send read and record through it. */
  get cache(): MailCache | undefined {
    return this.cacheHandle
  }

  /**
   * Runs `work` on the cache; a file found damaged while the server runs is replaced by
   * an empty one and `work` runs once more, so the next poll refills it.
   */
  private useCache<T>(cache: MailCache, work: (cache: MailCache) => T): T {
    try {
      return work(cache)
    } catch (error: unknown) {
      const { source } = this.options
      if (!isCorrupt(error) || source === undefined || cache !== this.cacheHandle) throw error
      console.warn('[manor] the mail cache was damaged; starting it again empty')
      try {
        cache.close()
      } catch {
        // Closing a damaged handle may fail too; the file is replaced either way.
      }
      this.cacheHandle = MailCache.open(this.options.cacheFile, source.account(), { fresh: true })
      return work(this.cacheHandle)
    }
  }

  available(): boolean {
    return this.options.source !== undefined
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work, work)
    this.tail = run.catch(() => undefined)
    return run
  }

  /** The whole door as the client draws it; sent on connect, on `mail_load` and after every change. */
  async state(): Promise<MailStateMessage> {
    const { source } = this.options
    const { cache } = this
    if (source === undefined || cache === undefined) {
      return { type: 'mail_state', status: 'off', cards: [], syncedAt: null, triage: { lastRunAt: null, running: false } }
    }
    const projectIds = new Set(await this.options.projectIds())
    const { meta, cards } = this.useCache(cache, (current) => ({ meta: current.meta(), cards: current.cards(projectIds) }))
    return {
      type: 'mail_state',
      status: this.pollError === undefined ? 'ready' : 'error',
      account: source.account().slice(0, 400),
      ...(this.pollError === undefined ? {} : { error: this.pollError.slice(0, 400) }),
      cards,
      syncedAt: meta.syncedAt,
      triage: {
        lastRunAt: meta.triageLastRunAt,
        running: this.triageRunning,
        ...(meta.triageError === undefined ? {} : { error: meta.triageError }),
      },
    }
  }

  async broadcastState(): Promise<void> {
    this.options.broadcast(await this.state())
  }

  /**
   * Polls the Inbox, reconciles the cache and broadcasts the result. Calls that arrive
   * while a poll is queued or running share it; `fresh` queues a new one instead, for a
   * caller that needs a listing taken after its own write. Never throws: a failed poll
   * is broadcast as `status: 'error'` with the cached cards still standing.
   */
  refresh(options: { fresh?: boolean } = {}): Promise<void> {
    const { source } = this.options
    const { cache } = this
    if (source === undefined || cache === undefined) return Promise.resolve()
    if (this.pendingPoll !== undefined && options.fresh !== true) return this.pendingPoll
    const poll: Promise<void> = this.serial(async () => {
      try {
        const inbox = await source.listInbox(MAIL_INBOX_WINDOW)
        this.useCache(this.cacheHandle ?? cache, (current) => current.reconcile(inbox, this.now(), this.archiving))
        this.pollError = undefined
      } catch (error: unknown) {
        this.pollError = reason(error, 'The mailbox could not be read.')
      }
    })
      .then(() => this.broadcastState())
      .catch((error: unknown) => console.warn(`[manor] mail state could not be sent: ${reason(error, 'unknown error')}`))
      .finally(() => {
        if (this.pendingPoll === poll) this.pendingPoll = undefined
      })
    this.pendingPoll = poll
    return poll
  }

  /**
   * The plain-text thread, from the cache while the thread's Inbox messages are the ones
   * it was read with, else from the source. Marks it opened here only: the server's
   * unread flag is never touched. Throws with a reason the user can read.
   */
  async openThread(threadId: string): Promise<MailThread> {
    const { thread, uids } = await this.readThread(threadId)
    // Through what the reader was shown: a message a poll added meanwhile stays unread.
    this.cache?.markOpened(threadId, Math.max(...uids))
    return thread
  }

  /** The cached thread without reading the mailbox, for a draft that must not wait on IMAP. */
  cachedThread(threadId: string): MailThread | undefined {
    return this.cache?.cachedThread(threadId)
  }

  /** The thread and the Inbox uids it was read with. */
  private async readThread(threadId: string): Promise<{ thread: MailThread; uids: number[] }> {
    const { source } = this.options
    const { cache } = this
    if (source === undefined || cache === undefined) throw new Error('This Manor host has no mailbox.')
    const inbox = cache.inboxThread(threadId)
    if (inbox === undefined) throw new Error('This thread is no longer in the Inbox.')
    const cached = cache.cachedThread(threadId)
    if (cached !== undefined) return { thread: cached, uids: inbox.uids }
    const messages = (await source.readThread(inbox)).sort((left, right) => left.at - right.at).slice(-MAIL_THREAD_MESSAGES_MAX)
    const subject = inbox.subject.slice(0, 1_000)
    const thread: MailThread = { threadId, subject, messages, reply: mailReplyFor(messages, source.account(), subject) }
    cache.storeThread(thread, inbox.uids)
    return { thread, uids: inbox.uids }
  }

  /**
   * The newest unlabelled cards with a snippet of each thread's newest message, for the
   * triage run. Reads uncached bodies through the source (never marking them read, and
   * not marking them opened); a thread that will not read gets an empty snippet.
   */
  async unlabelled(limit = 30, offered: ReadonlySet<string> = new Set()): Promise<{ card: MailCard; snippet: string }[]> {
    if (this.cache === undefined) return []
    const cards = (await this.state()).cards.filter((card) => card.label === undefined && !offered.has(card.threadId)).slice(0, limit)
    const out: { card: MailCard; snippet: string }[] = []
    for (const card of cards) {
      let snippet = ''
      try {
        const text = (await this.readThread(card.threadId)).thread.messages.at(-1)?.text ?? ''
        snippet = text.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_CHARS)
      } catch {
        // The headers still let the run judge the mail.
      }
      out.push({ card, snippet })
    }
    return out
  }

  /** The triage agent's label. Refused (false) where the user already set one. Call `broadcastState` after a batch. */
  setAgentLabel(threadId: string, label: MailLabel, why: string): boolean {
    return this.cache?.setLabel(threadId, label, 'agent', why, this.now()) ?? false
  }

  async setTriageRunning(running: boolean): Promise<void> {
    this.triageRunning = running
    await this.broadcastState()
  }

  /** Ends a triage run: `lastRunAt` now, its error or none, `running` false, and the state broadcast. */
  async recordTriageRun(error?: string): Promise<void> {
    this.cache?.recordTriageRun(this.now(), error)
    this.triageRunning = false
    await this.broadcastState()
  }

  /**
   * The schedule's tick, on the server that runs routines: the daily triage run when it
   * is owed. Never throws.
   */
  async tickTriage(): Promise<void> {
    await this.triage.tick().catch((error: unknown) => console.warn(`[manor] the mail triage run failed: ${reason(error, 'unknown error')}`))
  }

  /** A socket went away: its running draft stops, since nobody is left to read it. */
  closeSocket(socket: object): void {
    this.drafts.closeSocket(socket)
  }

  /**
   * `socket` names the asking connection, the same object for every message from it;
   * a draft streams to that connection only. It defaults to `reply` itself.
   */
  async handle(message: MailClientMessage, reply: (message: ServerMessage) => void, socket: object = reply): Promise<void> {
    const { source } = this.options
    const { cache } = this
    const notice = (text: string) => reply({ type: 'notice', kind: 'error', text })
    const result = (requestId: string, ok: boolean, text?: string) =>
      reply({ type: 'mail_result', requestId, ok, ...(text === undefined ? {} : { message: text.slice(0, 600) }) })
    switch (message.type) {
      case 'mail_load':
        reply(await this.state())
        if (message.refresh !== true) return
        await this.refresh()
        // Only a listing that came in says what is new; a failed poll leaves old cards standing.
        if (this.pollError === undefined) await this.triage.look()
        return
      case 'mail_open': {
        try {
          const thread = await this.openThread(message.threadId)
          reply({ type: 'mail_thread', requestId: message.requestId, threadId: message.threadId, result: { status: 'ready', thread } })
          await this.broadcastState()
        } catch (error: unknown) {
          reply({
            type: 'mail_thread',
            requestId: message.requestId,
            threadId: message.threadId,
            result: { status: 'error', message: reason(error, 'This thread could not be read.').slice(0, 400) },
          })
        }
        return
      }
      case 'mail_set_label':
        if (cache === undefined) return notice('This Manor host has no mailbox.')
        if (cache.inboxThread(message.threadId) === undefined) return notice('This thread is no longer in the Inbox.')
        cache.setLabel(message.threadId, message.label, 'user', undefined, this.now())
        await this.broadcastState()
        return
      case 'mail_link_sender': {
        if (cache === undefined) return notice('This Manor host has no mailbox.')
        const address = mailBareAddress(message.address)
        if (address === undefined) return notice('That is not an email address.')
        if (message.projectId !== null && !new Set(await this.options.projectIds()).has(message.projectId)) {
          return notice('That project no longer exists.')
        }
        cache.linkSender(address, message.projectId)
        await this.broadcastState()
        return
      }
      case 'mail_archive':
        if (source === undefined || cache === undefined) return result(message.requestId, false, 'This Manor host has no mailbox.')
        return this.archive(source, cache, message.requestId, message.threadId, result)
      case 'mail_unarchive':
        if (source === undefined || cache === undefined) return result(message.requestId, false, 'This Manor host has no mailbox.')
        return this.unarchive(source, cache, message.requestId, message.threadId, result)
      case 'mail_send': {
        if (this.sender === undefined) return result(message.requestId, false, 'Sending from Mail is not available on this Manor.')
        const outcome = await this.sender.send(message)
        result(message.requestId, outcome.ok, outcome.ok ? undefined : outcome.message)
        // A confirmed send may have moved the thread's label from reply to wait.
        if (outcome.ok) await this.broadcastState()
        return
      }
      case 'mail_triage_run':
        return this.triage.run()
      case 'mail_draft_start':
        return this.drafts.start(socket, message, reply)
      case 'mail_draft_stop':
        this.drafts.stop(socket, message.draftId)
        return
    }
  }

  /**
   * The user's Archive. The card leaves at once; on failure it comes back and the answer
   * carries the reason. The receipt is kept so `mail_unarchive` can undo it.
   */
  private async archive(
    source: MailSource,
    cache: MailCache,
    requestId: string,
    threadId: string,
    result: (requestId: string, ok: boolean, text?: string) => void,
  ): Promise<void> {
    const thread = cache.inboxThread(threadId)
    if (thread === undefined) return result(requestId, false, 'This thread is no longer in the Inbox.')
    const taken = cache.takeThread(threadId)
    this.archiving.add(threadId)
    // Queued before anything awaits. The receipt, the rollback and the release all happen
    // inside the queue, so an Undo or a poll queued behind this move sees its outcome.
    const moved = this.serial(async () => {
      try {
        cache.saveArchive(threadId, await source.archive(thread), this.now())
      } catch (error: unknown) {
        // Rows of an older numbering would be stale uids; the next poll brings the thread back instead.
        if (cache.getMeta('uidValidity') === thread.uidValidity) cache.putBack(taken)
        throw error
      } finally {
        this.archiving.delete(threadId)
      }
    })
    try {
      await this.broadcastState().catch(() => undefined)
      await moved
      result(requestId, true)
    } catch (error: unknown) {
      await this.broadcastState().catch(() => undefined)
      result(requestId, false, reason(error, 'This thread could not be archived.'))
    }
  }

  /** Archive's Undo: puts the thread back in the Inbox and answers once the fresh state is out. */
  private async unarchive(
    source: MailSource,
    cache: MailCache,
    requestId: string,
    threadId: string,
    result: (requestId: string, ok: boolean, text?: string) => void,
  ): Promise<void> {
    try {
      // Looked up in the queue: an Undo pressed while the archive still runs waits for its receipt.
      await this.serial(async () => {
        const receipt = cache.archiveReceipt(threadId)
        if (receipt === undefined) throw new Error('There is nothing to undo for this thread.')
        await source.restore(receipt)
      })
    } catch (error: unknown) {
      return result(requestId, false, reason(error, 'This thread could not be put back in the Inbox.'))
    }
    cache.dropArchive(threadId)
    // A poll queued before the restore would list the Inbox without the thread.
    await this.refresh({ fresh: true })
    result(requestId, true)
  }
}
