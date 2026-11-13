import type { ClientMessage, ServerMessage, WorkHandoff } from '@manor/contracts'
import type { Store } from './store.js'
import type { Orchestrator } from './orchestrator.js'
import type { WriteCommitMessage } from './commitMessage.js'
import type { ExternalFileOpener } from './externalFiles.js'
import { sessionChangedFiles } from './goalReview.js'
import {
  SessionGitError,
  commitCandidates,
  commitFiles,
  commitPatch,
  fallbackCommitMessage,
  pushBranch,
  readSessionDiff,
  readSessionStatus,
  type SessionCheckout,
} from './sessionGit.js'
import { anyWorktreeMissing, effectiveRepoPaths } from './worktree.js'

const RELEASED = 'This Session’s folder was removed after its work landed in main. Reopen the Session to bring it back.'

type SessionMessage = Extract<ClientMessage, { type: 'session_repo' | 'session_diff' | 'commit_session' | 'push_session' | 'open_session_folder' }>

interface SessionModuleOptions {
  store: Pick<Store, 'getChat' | 'getProject' | 'loadChatWorktrees' | 'loadEvents' | 'workHandoffForTarget'>
  orchestrator: Pick<Orchestrator, 'tryRunExclusive'>
  /** To every window: a Commit outlives the dialog that started it. */
  broadcast: (message: ServerMessage) => void
  writeCommitMessage?: WriteCommitMessage
  /** The host's installed apps, for Open in. Absent where the host has none. */
  externalFiles?: Pick<ExternalFileOpener, 'apps' | 'open'>
  /** A Commit moved a branch; another Session's blocked card may have landed with it. */
  onCommitted?: () => void
}

interface SessionReplyContext {
  reply: (message: ServerMessage) => void
  ack: () => void
}

/** A result the user can still Confirm, read the way the result card reads it. */
export function resultWaits(handoff: WorkHandoff | undefined, chat: { settledAt: number | null; archivedAt: number | null }): boolean {
  return handoff !== undefined && handoff.goalReport !== undefined && handoff.goalConfirmedAt === undefined &&
    handoff.state === 'active' && chat.settledAt === null && chat.archivedAt === null
}

/** Confirm has asked the lead to commit and Manor has not seen it land yet. */
const confirmLanding = (handoff: WorkHandoff | undefined): boolean =>
  handoff?.goalConfirmedAt !== undefined && handoff.goalCompletion?.status === 'pending'

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`

/**
 * The Session panel's Changes and Branch, and the two ways it lands work that Confirm
 * does not: Commit and Push. Confirm stays the only way to land a waiting result, so
 * Commit is refused while one waits, and while Confirm's own commit is underway.
 */
export class SessionModule {
  /** Commits that were acked and have not ended, by the checkout's top folder. */
  private readonly running = new Map<string, { chatId: string; root: string; files: number }>()

  constructor(private readonly options: SessionModuleOptions) {}

  commits(): Extract<ServerMessage, { type: 'session_commits' }> {
    return { type: 'session_commits', commits: [...this.running.values()] }
  }

  async handle(message: SessionMessage, context: SessionReplyContext): Promise<void> {
    switch (message.type) {
      case 'session_repo':
        context.reply(await this.status(message.chatId))
        return
      case 'session_diff':
        context.reply(await this.diff(message.chatId, message.ignoreWhitespace ?? true))
        return
      case 'commit_session':
        await this.commit(message, context)
        return
      case 'push_session':
        await this.push(message, context)
        return
      case 'open_session_folder':
        await this.openFolder(message, context)
        return
    }
  }

  private async checkout(chatId: string): Promise<{ checkout: SessionCheckout; handoff?: WorkHandoff; waiting: boolean; released: boolean } | undefined> {
    const { store } = this.options
    const chat = await store.getChat(chatId)
    if (chat === undefined || chat.projectId === null) return undefined
    const project = await store.getProject(chat.projectId)
    if (project === undefined || project.repoPaths.length === 0) return undefined
    const [mapping, events, handoff] = await Promise.all([
      store.loadChatWorktrees(chatId), store.loadEvents(chatId), store.workHandoffForTarget(chatId),
    ])
    const waiting = resultWaits(handoff, chat)
    // A waiting result without Confirm's record of it is an older one; its scope is read live.
    const held = waiting && handoff?.goalCompletion?.status === 'ready' ? handoff.goalCompletion : undefined
    return {
      checkout: {
        repoPaths: effectiveRepoPaths(project.repoPaths, mapping),
        mapping,
        sessionFiles: waiting ? handoff?.goalChangedFiles ?? sessionChangedFiles(events) : sessionChangedFiles(events),
        ...(held === undefined ? {} : { waiting: held, liveFiles: sessionChangedFiles(events) }),
      },
      ...(handoff === undefined ? {} : { handoff }),
      waiting,
      released: await anyWorktreeMissing(mapping),
    }
  }

  async status(chatId: string): Promise<Extract<ServerMessage, { type: 'session_repo' }>> {
    const empty = { type: 'session_repo' as const, chatId, waiting: false, changes: { files: 0, added: 0, removed: 0 }, repos: [] }
    const found = await this.checkout(chatId)
    if (found === undefined) return empty
    if (found.released) return { ...empty, waiting: found.waiting, error: RELEASED }
    try {
      return { ...empty, ...await readSessionStatus(found.checkout), waiting: found.waiting }
    } catch (error) {
      return { ...empty, waiting: found.waiting, error: reason(error, 'Manor could not read this checkout.') }
    }
  }

  async diff(chatId: string, ignoreWhitespace: boolean): Promise<Extract<ServerMessage, { type: 'session_diff' }>> {
    const empty = { type: 'session_diff' as const, chatId, ignoreWhitespace, waiting: false, files: [], partial: false }
    const found = await this.checkout(chatId)
    if (found === undefined) return empty
    if (found.released) return { ...empty, waiting: found.waiting, error: RELEASED }
    try {
      return { ...empty, ...await readSessionDiff(found.checkout, ignoreWhitespace), waiting: found.waiting }
    } catch (error) {
      return { ...empty, waiting: found.waiting, error: reason(error, 'Manor could not read this diff.') }
    }
  }

  /**
   * Checks the request, acks it so the dialog closes, then commits in the background:
   * the pre-commit hook may test for minutes. What it ends in is broadcast. A refusal
   * before the ack is a notice the open dialog shows; a failure after it is a
   * `session_git_result` with `ok: false`, carrying what the dialog needs to reopen.
   * One commit per checkout at a time; a second is refused, never queued unseen.
   */
  private async commit(message: Extract<SessionMessage, { type: 'commit_session' }>, context: SessionReplyContext): Promise<void> {
    const refuse = (text: string) => context.reply({ type: 'notice', kind: 'error', text })
    const { broadcast } = this.options
    const busy = 'A commit is already running in this checkout. Commit again once it ends.'
    if ([...this.running.values()].some((entry) => entry.chatId === message.chatId)) return refuse(busy)
    const written = message.message.trim()
    const ticked = [...new Set(message.files)]
    let acked = false
    // Read again inside the chat's queue: a turn that ends between the click and here
    // may have changed which files are this Session's.
    const outcome = await this.options.orchestrator.tryRunExclusive(message.chatId, async () => {
      const found = await this.checkout(message.chatId)
      if (found === undefined) return 'This chat has no linked git folder to commit in.'
      if (found.released) return RELEASED
      if (found.waiting) return 'A result is waiting for Confirm. Confirm lands this work, so Commit is not offered until it is settled.'
      if (confirmLanding(found.handoff)) return 'Confirm is landing this Session’s result now. Commit once it has.'
      const candidates = await commitCandidates(found.checkout, message.root)
      if (candidates === undefined) return 'That folder is not part of this Session’s checkout.'
      const stray = message.files.filter((file) => !candidates.files.includes(file))
      if (stray.length > 0) {
        return `Only this Session’s uncommitted files can be committed here, and ${stray.length === 1 ? `${stray[0]} is not one of them` : `${plural(stray.length, 'file')} are not`}. Reopen Commit to see the current list.`
      }
      if (this.running.has(candidates.top)) return busy
      const files = [...new Set(ticked.flatMap((file) => {
        const old = candidates.renamedFrom.get(file)
        return old === undefined ? [file] : [old, file]
      }))]
      this.running.set(candidates.top, { chatId: message.chatId, root: message.root, files: ticked.length })
      broadcast(this.commits())
      context.ack()
      acked = true
      try {
        const subject = written.length > 0
          ? written
          : await this.options.writeCommitMessage?.(message.chatId, await commitPatch(candidates.top, files).catch(() => '')) ?? fallbackCommitMessage(ticked)
        const hash = await commitFiles(candidates.top, files, subject)
        return { ok: true as const, text: `Committed ${plural(ticked.length, 'file')} as ${hash.slice(0, 7)}: ${subject.split('\n')[0]}` }
      } catch (error) {
        return { ok: false as const, text: reason(error, 'The commit failed.') }
      } finally {
        this.running.delete(candidates.top)
      }
    }).catch((error: unknown) => reason(error, 'The commit failed.'))
    if (typeof outcome === 'string') {
      if (!acked) return refuse(outcome)
      // Thrown after the ack: the dialog is gone, so it ends like any failed commit.
      return this.commitEnded(message, { ok: false, text: outcome }, written, ticked)
    }
    if (outcome.occupied) return refuse('A turn is running in this Session. Commit once it ends.')
    if (typeof outcome.value === 'string') return refuse(outcome.value)
    await this.commitEnded(message, outcome.value, written, ticked)
  }

  private async commitEnded(
    message: Extract<SessionMessage, { type: 'commit_session' }>,
    result: { ok: boolean; text: string },
    written: string,
    ticked: readonly string[],
  ): Promise<void> {
    const { broadcast } = this.options
    // Read first, so the panel and the toast change in the same moment. Git has ended
    // either way: a read that fails must not keep every window's spinner going.
    const status = await this.status(message.chatId).catch(() => undefined)
    broadcast({
      type: 'session_git_result', chatId: message.chatId, root: message.root, action: 'commit', ...result,
      ...(result.ok ? {} : { files: [...ticked], message: written }),
      ...(message.requestId === undefined ? {} : { requestId: message.requestId }),
    })
    broadcast(this.commits())
    if (status !== undefined) broadcast(status)
    if (result.ok) this.options.onCommitted?.()
  }

  /** Open in: one of this Session's own folders, in an app this host has installed. */
  private async openFolder(message: Extract<SessionMessage, { type: 'open_session_folder' }>, context: SessionReplyContext): Promise<void> {
    const refuse = (text: string) => context.reply({ type: 'notice', kind: 'error', text })
    const opener = this.options.externalFiles
    if (opener === undefined || !opener.apps.includes(message.app)) return refuse('That application is not available on this Manor host.')
    const found = await this.checkout(message.chatId)
    if (found?.released === true) return refuse(RELEASED)
    if (found === undefined || !found.checkout.repoPaths.includes(message.root)) return refuse('That folder is not part of this Session’s checkout.')
    try {
      await opener.open(message.app, message.root, 'folder')
    } catch {
      refuse('The application could not open that folder.')
    }
  }

  private async push(message: Extract<SessionMessage, { type: 'push_session' }>, context: SessionReplyContext): Promise<void> {
    const found = await this.checkout(message.chatId)
    if (found === undefined || found.released || !found.checkout.repoPaths.includes(message.root)) {
      context.reply({ type: 'notice', kind: 'error', text: found?.released === true ? RELEASED : 'That folder is not part of this Session’s checkout.' })
      return
    }
    try {
      const pushed = await pushBranch(message.root)
      context.reply({ type: 'session_git_result', chatId: message.chatId, root: message.root, action: 'push', ok: true, ...pushed, ...(message.requestId === undefined ? {} : { requestId: message.requestId }) })
      context.ack()
    } catch (error) {
      context.reply({ type: 'notice', kind: 'error', text: reason(error, 'The push failed.') })
    }
    context.reply(await this.status(message.chatId))
  }
}

/** Git's own sentence where there is one; nothing about the server's internals otherwise. */
function reason(error: unknown, fallback: string): string {
  if (error instanceof SessionGitError) return error.message
  return fallback
}
