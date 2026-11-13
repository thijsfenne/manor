import { randomUUID } from 'node:crypto'
import {
  SlackRichTextSchema,
  slackRichTextFallback,
  type SlackRichText,
  OUTBOUND_DRAFT_BODY_MAX,
  OUTBOUND_DRAFT_SUBJECT_MAX,
  OUTBOUND_DRAFT_TO_MAX,
  OutboundDraftContentSchema,
  type OutboundDraftContent,
  type OutboundThreadMessage,
  type ServerMessage,
  type ThreadEvent,
} from '@manor/contracts'
import type { OutboundRoute, OutboundSendPort } from './outboundSend.js'
import type { ConnectOutcome } from './mcp/connectLinks.js'
import type { DraftEvent, OutboundThreadKey, Store } from './store.js'

/** The turn a draft is prepared in. */
export interface DraftContext {
  chatId: string
  agentId: string
  turnId: string
  /** False for unattended and relayed turns, which never show a connect card. */
  canApprove?: boolean
}

export type PrepareResult =
  | { draftId: string }
  | { suppressed: 'snoozed'; until: number }
  /** Nothing can send on this channel yet. `pending` and `failed` mean a connect card is in the chat. */
  | { notConnected: 'unavailable' | 'pending' | 'failed'; reason?: string }

/** The reply that stands under a sent draft, in the persona's own bubble. */
export const sentConfirmation = (draft: { to: string }) => `Sent to ${draft.to}.`

export interface OutboundThreadReader {
  read(draft: Extract<ThreadEvent, { type: 'outbound_draft' }>): Promise<{
    messages: OutboundThreadMessage[]
    truncated: boolean
    openUrl?: string
  }>
}

export type OutboundDraftPort = Pick<
  OutboundDrafts,
  'submit' | 'discard' | 'snooze' | 'ignore' | 'restore' | 'readThread'
>

interface OutboundDraftsOptions {
  store: Pick<
    Store,
    | 'loadEvents'
    | 'appendEvent'
    | 'listUnresolvedOutboundSubmissions'
    | 'getOutboundThreadDecision'
    | 'saveOutboundThreadDecision'
    | 'deleteOutboundThreadDecision'
  >
  send: OutboundSendPort
  emit: (message: ServerMessage) => void
  threadReader?: OutboundThreadReader
  /**
   * Puts a connect card for the channel's app in the turn and waits on it like a
   * Composio connect call. Undefined when this host cannot offer one (no Composio).
   */
  connect?: (context: DraftContext, channel: OutboundDraftContent['channel'], inTime: () => boolean) => Promise<ConnectOutcome | undefined>
  /** Test seam for the prepare deadline. */
  prepareBudgetMs?: number
  now?: () => number
}

/**
 * Codex ends an MCP call at 60 seconds. The connect card holds 45 of them, and the link
 * before it and the route lookups after it share what is left.
 */
const PREPARE_BUDGET_MS = 55_000

/** What a prepare learned about how the draft would leave; empty on the test port. */
type SendRoute = { kind?: OutboundRoute['kind']; from?: string }

const prepared = (events: readonly ThreadEvent[], draftId: string) =>
  events.find(
    (event): event is Extract<ThreadEvent, { type: 'outbound_draft' }> =>
      event.type === 'outbound_draft' && event.draftId === draftId,
  )

const latestClosure = (events: readonly ThreadEvent[], draftId: string) => {
  let closure: Extract<ThreadEvent, { type: 'outbound_draft_closed' }> | undefined
  for (const event of events) {
    if (event.type !== 'outbound_draft_closed' && event.type !== 'outbound_draft_reopened') continue
    if (event.draftId !== draftId) continue
    if (event.type === 'outbound_draft_closed') closure = event
    if (event.type === 'outbound_draft_reopened') closure = undefined
  }
  return closure
}

const threadKey = (
  draft: Pick<OutboundDraftContent, 'channel' | 'thread'> & {
    mailAccount?: 'personal'
    slackChannelId?: string
  },
): OutboundThreadKey | undefined => {
  if (draft.thread === undefined) return undefined
  const route = draft.channel === 'gmail' ? (draft.mailAccount ?? 'personal') : draft.slackChannelId
  return route === undefined
    ? undefined
    : { channel: draft.channel, route, threadId: draft.thread.threadId }
}

const submissionStatus = (events: readonly ThreadEvent[], draftId: string) => {
  let status: Extract<ThreadEvent, { type: 'outbound_draft_submission' }>['status'] | undefined
  for (const event of events) {
    if (event.type === 'outbound_draft_submission' && event.draftId === draftId) status = event.status
  }
  return status
}

const submissionLocksDraft = (status: ReturnType<typeof submissionStatus>) =>
  status === 'started' || status === 'uncertain' || status === 'delivered'

export class OutboundDrafts {
  private readonly closing = new Set<string>()

  constructor(private readonly options: OutboundDraftsOptions) {}

  /** A `started` claim can only survive startup when the previous process died. */
  async reconcileStarted(): Promise<number> {
    const unresolved = await this.options.store.listUnresolvedOutboundSubmissions()
    for (const { chatId, event } of unresolved) {
      await this.write(chatId, {
        type: 'outbound_draft_submission',
        agentId: event.agentId,
        turnId: event.turnId,
        draftId: event.draftId,
        submissionId: event.submissionId,
        status: 'uncertain',
        message: 'The server restarted before delivery could be confirmed. Do not submit this draft again.',
        channel: event.channel,
        to: event.to,
        ...(event.subject === undefined ? {} : { subject: event.subject }),
        ...(event.cc === undefined ? {} : { cc: event.cc }),
        body: event.body,
        ...(event.mailAccount === undefined ? {} : { mailAccount: event.mailAccount }),
        ...(event.slackChannelId === undefined ? {} : { slackChannelId: event.slackChannelId }),
        ...(event.slackThreadTs === undefined ? {} : { slackThreadTs: event.slackThreadTs }),
        ...(event.slackRichText === undefined ? {} : { slackRichText: event.slackRichText }),
      })
    }
    return unresolved.length
  }

  /**
   * The agent's prepare call. A draft only lands when something can send it: the host's
   * own connection or a Composio account. Otherwise the turn gets a connect card, and a
   * sign-in finished while the call waits still lands the draft in the same turn.
   */
  async prepare(context: DraftContext, draft: OutboundDraftContent): Promise<PrepareResult> {
    // The route lookups, the link and the card's own hold all count against the agent's
    // tool call. Past the deadline nothing new starts and nothing is recorded: the agent
    // has stopped listening by then.
    const deadline = { passed: false }
    let timer: NodeJS.Timeout | undefined
    const late = new Promise<'late'>((resolve) => {
      timer = setTimeout(() => { deadline.passed = true; resolve('late') }, this.options.prepareBudgetMs ?? PREPARE_BUDGET_MS)
    })
    try {
      const routed = await Promise.race([this.routeFor(context, draft.channel, () => !deadline.passed), late])
      if (routed === 'late') return { notConnected: 'failed', reason: 'connecting took too long' }
      if ('notConnected' in routed) return routed
      return await this.record(context.chatId, context.agentId, context.turnId, draft, routed)
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * How the draft would leave, after a connect card when nothing can send it yet. A Gmail
   * card always names its sender, because Send refuses any other account.
   */
  private async routeFor(
    context: DraftContext,
    channel: OutboundDraftContent['channel'],
    inTime: () => boolean,
  ): Promise<SendRoute | Extract<PrepareResult, { notConnected: unknown }>> {
    const route = this.options.send.route
    if (route === undefined) return {}
    const sender = (found: OutboundRoute) => channel === 'gmail' && found.from === undefined
      ? { notConnected: 'failed' as const, reason: 'the Gmail address could not be read' }
      : found
    const first = await route.call(this.options.send, channel)
    if (first !== undefined) return sender(first)
    if (!inTime()) return { notConnected: 'failed', reason: 'connecting took too long' }
    const outcome = context.canApprove === false ? undefined : await this.options.connect?.(context, channel, inTime)
    if (outcome === undefined) return { notConnected: 'unavailable' }
    if (outcome.status !== 'connected') {
      return { notConnected: outcome.status, ...(outcome.status === 'failed' ? { reason: outcome.reason } : {}) }
    }
    const fresh = await route.call(this.options.send, channel)
    return fresh === undefined ? { notConnected: 'failed', reason: 'the new account cannot send yet' } : sender(fresh)
  }

  async record(
    chatId: string,
    agentId: string,
    turnId: string,
    draft: OutboundDraftContent & { thread?: undefined },
    route?: SendRoute,
  ): Promise<{ draftId: string }>
  async record(
    chatId: string,
    agentId: string,
    turnId: string,
    draft: OutboundDraftContent,
    route?: SendRoute,
  ): Promise<{ draftId: string } | { suppressed: 'snoozed'; until: number }>
  async record(
    chatId: string,
    agentId: string,
    turnId: string,
    draft: OutboundDraftContent,
    route?: SendRoute,
  ): Promise<{ draftId: string } | { suppressed: 'snoozed'; until: number }> {
    const parsed = OutboundDraftContentSchema.safeParse(draft)
    if (!parsed.success) throw new Error('Invalid outbound draft.')
    const from = parsed.data.channel === 'gmail' ? route?.from : undefined
    const decisionKey = threadKey(parsed.data)
    if (decisionKey !== undefined) {
      const decision = await this.options.store.getOutboundThreadDecision(decisionKey)
      // Ignore remains durable bookkeeping; preparing a new card does not restore the old one.
      if (decision?.kind === 'snoozed') {
        if (decision.until > (this.options.now?.() ?? Date.now())) {
          return { suppressed: 'snoozed', until: decision.until }
        }
        await this.options.store.deleteOutboundThreadDecision(decisionKey)
      }
    }
    const draftId = `${turnId}:${agentId}:${randomUUID()}`
    await this.write(chatId, {
      type: 'outbound_draft',
      agentId,
      turnId,
      draftId,
      channel: parsed.data.channel,
      to: parsed.data.to,
      ...(parsed.data.channel === 'gmail' && parsed.data.subject !== undefined && parsed.data.subject !== ''
        ? { subject: parsed.data.subject }
        : {}),
      ...(parsed.data.channel === 'gmail' && parsed.data.cc !== undefined && parsed.data.cc.trim() !== ''
        ? { cc: parsed.data.cc.trim() }
        : {}),
      ...(from === undefined || from === '' ? {} : { from }),
      ...(parsed.data.channel === 'gmail'
        ? { mailAccount: parsed.data.mailAccount ?? 'personal' as const }
        : {
            ...(parsed.data.slackChannelId === undefined ? {} : { slackChannelId: parsed.data.slackChannelId }),
            ...(parsed.data.slackThreadTs === undefined ? {} : { slackThreadTs: parsed.data.slackThreadTs }),
            ...(parsed.data.slackRichText === undefined ? {} : { slackRichText: parsed.data.slackRichText }),
          }),
      body: parsed.data.channel === 'slack' && parsed.data.slackRichText !== undefined
        ? slackRichTextFallback(parsed.data.slackRichText) : parsed.data.body,
      ...(parsed.data.thread === undefined ? {} : { thread: parsed.data.thread }),
      // The full thread is read over the host's own mailbox. A Composio-only Gmail has
      // none, so its card keeps the quote and offers no Show more that could only fail.
      ...(parsed.data.channel === 'gmail' && parsed.data.thread !== undefined && route?.kind === 'composio' ? { fullThread: false } : {}),
    })
    return { draftId }
  }

  async submit(
    chatId: string,
    draftId: string,
    body: string,
    subject?: string,
    slackRichText?: SlackRichText,
    cc?: string,
  ): Promise<boolean> {
    if (cc !== undefined && cc.length > OUTBOUND_DRAFT_TO_MAX) return false
    if (slackRichText !== undefined) {
      const parsed = SlackRichTextSchema.safeParse(slackRichText)
      if (!parsed.success) return false
      slackRichText = parsed.data
      body = slackRichTextFallback(slackRichText)
    }
    if (body.trim().length === 0 || body.length > OUTBOUND_DRAFT_BODY_MAX) return false
    if (subject !== undefined && subject.length > OUTBOUND_DRAFT_SUBJECT_MAX) return false

    const key = `${chatId}\0${draftId}`
    if (this.closing.has(key)) return false
    this.closing.add(key)

    try {
      const events = await this.options.store.loadEvents(chatId)
      const draft = prepared(events, draftId)
      if (draft === undefined || latestClosure(events, draftId) !== undefined || submissionLocksDraft(submissionStatus(events, draftId))) return false
      if (draft.channel !== 'slack' && slackRichText !== undefined) return false
      // An older text-only client must not silently discard a rich draft's formatting.
      const lastSubmission = events.filter((event) => event.type === 'outbound_draft_submission' && event.draftId === draftId).at(-1)
      const currentRichText = lastSubmission?.type === 'outbound_draft_submission' ? lastSubmission.slackRichText : draft.slackRichText
      if (currentRichText !== undefined && slackRichText === undefined) return false
      // A reply keeps its thread's subject: Gmail threads by it, and Composio's reply tool
      // cannot set one. The card shows it read-only, and an edit sent anyway is ignored.
      const resolvedSubject = draft.channel !== 'gmail' ? undefined : draft.thread === undefined ? (subject ?? draft.subject) : draft.subject
      const subjectField = resolvedSubject === undefined || resolvedSubject === ''
        ? {}
        : { subject: resolvedSubject }
      const resolvedCc = draft.channel === 'gmail' ? (cc ?? draft.cc)?.trim() : undefined
      const ccField = resolvedCc === undefined || resolvedCc === '' ? {} : { cc: resolvedCc }
      const destination = draft.channel === 'gmail'
        ? { mailAccount: draft.mailAccount ?? 'personal' as const }
        : {
            ...(draft.slackChannelId === undefined ? {} : { slackChannelId: draft.slackChannelId }),
            ...(draft.slackThreadTs === undefined ? {} : { slackThreadTs: draft.slackThreadTs }),
            ...(slackRichText === undefined ? {} : { slackRichText }),
          }
      const submissionId = randomUUID()
      const submission = {
        agentId: draft.agentId,
        turnId: draft.turnId,
        draftId,
        submissionId,
        channel: draft.channel,
        to: draft.to,
        ...subjectField,
        ...ccField,
        ...destination,
        body,
      }

      // This append is the send claim. If it fails, no external call happens. If the
      // process dies after the call, the durable `started` state still blocks retry.
      await this.write(chatId, {
        type: 'outbound_draft_submission',
        status: 'started',
        ...submission,
      })

      const result = await this.options.send.send({
        channel: draft.channel,
        to: draft.to,
        ...subjectField,
        ...ccField,
        ...(draft.channel === 'gmail' && draft.from !== undefined ? { from: draft.from } : {}),
        ...destination,
        ...(draft.channel === 'gmail' && draft.thread !== undefined ? { gmailThreadId: draft.thread.threadId } : {}),
        body,
        submissionId,
      })
      if (!result.ok) {
        await this.write(chatId, {
          type: 'outbound_draft_submission',
          status: result.certainty === 'safe' ? 'failed' : 'uncertain',
          message: result.message,
          ...submission,
        })
        return false
      }

      await this.write(chatId, {
        type: 'outbound_draft_submission',
        status: 'delivered',
        delivery: result.delivery,
        ...submission,
      })
      // Only a confirmed delivery earns the persona's "sent": a recorded test send, a
      // failure and an uncertain outcome all return before this line.
      if (result.delivery === 'delivered') {
        await this.write(chatId, {
          type: 'agent_message',
          agentId: draft.agentId,
          turnId: draft.turnId,
          text: sentConfirmation(draft),
        }).catch((error: unknown) => console.warn('[manor] could not add the sent confirmation', error))
      }
      return true
    } finally {
      this.closing.delete(key)
    }
  }

  async discard(chatId: string, draftId: string): Promise<boolean> {
    const key = `${chatId}\0${draftId}`
    if (this.closing.has(key)) return false
    this.closing.add(key)

    try {
      const events = await this.options.store.loadEvents(chatId)
      const draft = prepared(events, draftId)
      if (draft === undefined || latestClosure(events, draftId) !== undefined || submissionLocksDraft(submissionStatus(events, draftId))) return false
      await this.write(chatId, {
        type: 'outbound_draft_closed',
        agentId: draft.agentId,
        turnId: draft.turnId,
        draftId,
        outcome: 'discarded',
        channel: draft.channel,
        to: draft.to,
        ...(draft.channel === 'gmail'
          ? { mailAccount: draft.mailAccount ?? 'personal' as const }
          : {
              ...(draft.slackChannelId === undefined ? {} : { slackChannelId: draft.slackChannelId }),
              ...(draft.slackThreadTs === undefined ? {} : { slackThreadTs: draft.slackThreadTs }),
              ...(draft.slackRichText === undefined ? {} : { slackRichText: draft.slackRichText }),
            }),
      })
      return true
    } finally {
      this.closing.delete(key)
    }
  }

  async snooze(chatId: string, draftId: string, until: number): Promise<boolean> {
    if (!Number.isSafeInteger(until) || until <= (this.options.now?.() ?? Date.now())) return false
    return this.decide(chatId, draftId, { kind: 'snoozed', until })
  }

  async ignore(chatId: string, draftId: string): Promise<boolean> {
    return this.decide(chatId, draftId, { kind: 'ignored' })
  }

  async restore(chatId: string, draftId: string): Promise<boolean> {
    const lock = `${chatId}\0${draftId}`
    if (this.closing.has(lock)) return false
    this.closing.add(lock)
    try {
      const events = await this.options.store.loadEvents(chatId)
      const draft = prepared(events, draftId)
      const closure = latestClosure(events, draftId)
      if (draft === undefined || (closure?.outcome !== 'ignored' && closure?.outcome !== 'snoozed')) return false
      const decisionKey = threadKey(draft)
      if (decisionKey === undefined) return false
      await this.options.store.deleteOutboundThreadDecision(decisionKey)
      await this.write(chatId, {
        type: 'outbound_draft_reopened',
        agentId: draft.agentId,
        turnId: draft.turnId,
        draftId,
      })
      return true
    } finally {
      this.closing.delete(lock)
    }
  }

  async readThread(chatId: string, draftId: string): Promise<{
    messages: OutboundThreadMessage[]
    truncated: boolean
    openUrl?: string
  } | undefined> {
    if (this.options.threadReader === undefined) return undefined
    const draft = prepared(await this.options.store.loadEvents(chatId), draftId)
    if (draft?.thread === undefined) return undefined
    return this.options.threadReader.read(draft)
  }

  private async decide(
    chatId: string,
    draftId: string,
    decision: { kind: 'ignored' } | { kind: 'snoozed'; until: number },
  ): Promise<boolean> {
    const lock = `${chatId}\0${draftId}`
    if (this.closing.has(lock)) return false
    this.closing.add(lock)
    try {
      const events = await this.options.store.loadEvents(chatId)
      const draft = prepared(events, draftId)
      if (draft === undefined || latestClosure(events, draftId) !== undefined || submissionLocksDraft(submissionStatus(events, draftId))) return false
      const decisionKey = threadKey(draft)
      if (decisionKey === undefined) return false
      await this.options.store.saveOutboundThreadDecision(decisionKey, decision)
      await this.write(chatId, {
        type: 'outbound_draft_closed',
        agentId: draft.agentId,
        turnId: draft.turnId,
        draftId,
        outcome: decision.kind,
        ...(decision.kind === 'snoozed' ? { until: decision.until } : {}),
        channel: draft.channel,
        to: draft.to,
        ...(draft.channel === 'gmail'
          ? { mailAccount: draft.mailAccount ?? 'personal' as const }
          : {
              ...(draft.slackChannelId === undefined ? {} : { slackChannelId: draft.slackChannelId }),
              ...(draft.slackThreadTs === undefined ? {} : { slackThreadTs: draft.slackThreadTs }),
              ...(draft.slackRichText === undefined ? {} : { slackRichText: draft.slackRichText }),
            }),
      })
      return true
    } finally {
      this.closing.delete(lock)
    }
  }

  private async write(chatId: string, draft: DraftEvent): Promise<void> {
    const event = await this.options.store.appendEvent(chatId, draft)
    this.options.emit({ type: 'event', chatId, event })
  }
}
