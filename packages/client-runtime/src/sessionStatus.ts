import type { BackgroundWork, Chat, WorkHandoff } from '@manor/contracts'

/**
 * What is live in a session's chat right now. The workspace fills it once per chat
 * (`sessionLiveOf`); a reader without a workspace passes `QUIET_SESSION`.
 */
export interface SessionLive {
  /** A turn runs, or work it started does. */
  running: boolean
  /** No turn runs, but background work an ended turn started does, and its end wakes the session. */
  background: boolean
  /** A question of the session's is open and nobody has answered it. */
  asking: boolean
}

export const QUIET_SESSION = { running: false, background: false, asking: false }

/**
 * Where one Session stands, the single reading its card, its overview row and its
 * project row all draw from (2026-10-11). A card that said Working beside an overview
 * that said Needs you was two computations drifting apart.
 *
 * - `proposed`: waits for Accept.
 * - `working`: a turn runs, or work it started does while it runs.
 * - `background`: the turn ended and background work it started still runs; its end wakes
 *   the Session. It reads Waiting, and owes the user nothing (2026-11-18).
 * - `waiting`: a question waits on the user.
 * - `ready`: a result waits for Confirm and nothing runs.
 * - `done`: nothing runs and nothing is asked; the turn ended or was stopped.
 * - `confirmed`: The user confirmed the result and nothing is left to do. It counts as
 *   settled until the user unsettles it (`unsettledAt`); then it reads `done` and stays
 *   active until it is settled again (2026-10-12).
 * - `blocked`: The user confirmed, nothing runs, and Git does not show the commit or merge
 *   landing (2026-10-11). The card said Merging… while the merge sat blocked.
 * - `settled`: The user's own stamp, whatever else is true.
 * - `closed`: rejected, replaced, deleted or archived; no list shows it.
 */
export type SessionStatus = 'proposed' | 'working' | 'background' | 'waiting' | 'ready' | 'done' | 'confirmed' | 'blocked' | 'settled' | 'closed'

export function sessionStatus(handoff: WorkHandoff, chat: Chat | undefined, live: SessionLive): SessionStatus {
  if (handoff.state === 'deleted' || chat?.archivedAt != null) return 'closed'
  const pending = handoff.acceptedAt === null
  // A Session whose chat the directory no longer lists is gone, not waiting.
  if (chat === undefined && (handoff.workChatId !== null || !pending)) return 'closed'
  if (handoff.state === 'settled' || chat?.settledAt != null) {
    // A proposal settled before it ran was rejected or replaced, so nothing is left to settle.
    return pending && handoff.workChatId === null ? 'closed' : 'settled'
  }
  if (pending) return 'proposed'
  if (live.asking) return 'waiting'
  if (handoff.goalConfirmedAt !== undefined) {
    if (live.running && !live.background) return 'working'
    // A commit Git says did not land is the user's move again.
    if (handoff.goalCompletion?.status === 'blocked') return 'blocked'
    // Manor holds a conflict fix for the user's approval before it merges.
    if (handoff.goalCompletion?.merge?.stage === 'approve') return 'blocked'
    if (handoff.goalCompletion?.status === 'pending') return 'working'
    if (live.background) return 'background'
    return handoff.unsettledAt === undefined ? 'confirmed' : 'done'
  }
  // A result stays open while the user's new instruction runs, but the Session is working, not ready.
  if (live.running) return live.background ? 'background' : 'working'
  return handoff.goalReport !== undefined && handoff.goalReachedAt !== undefined ? 'ready' : 'done'
}

/** The overview fold a status stands in; null for one no list shows. */
export function sessionGroup(status: SessionStatus) {
  switch (status) {
    case 'proposed':
    case 'waiting':
    case 'ready':
    case 'done':
    case 'blocked':
      return 'waiting'
    case 'working':
      return 'working'
    case 'background':
      return 'background'
    case 'confirmed':
    case 'settled':
      return 'settled'
    case 'closed':
      return null
  }
}

/** Whether the user can act on this status. A quiet or reopened `done` Session stays listed but owes the user nothing. */
export const needsUser = (status: SessionStatus) =>
  status === 'proposed' || status === 'waiting' || status === 'ready' || status === 'blocked'

/**
 * What a Session in `background` says it waits on: the work's own title when one thing
 * runs, else a count in the words its turn's status line uses.
 */
export function backgroundReason(work: readonly BackgroundWork[]): string {
  const title = work.length === 1 ? work[0]!.title.replace(/\s+/g, ' ').trim() : ''
  if (title !== '') return title
  const agents = work.filter((item) => item.kind === 'agent').length
  return waitingOn(agents, work.length - agents) ?? 'Waiting on background work'
}

/** "Waiting on 3 background agents", "on 1 background command", or both kinds named. */
export function waitingOn(agentCount: number, commandCount: number): string | undefined {
  if (agentCount + commandCount === 0) return undefined
  const agents = `${agentCount} background ${agentCount === 1 ? 'agent' : 'agents'}`
  const commands = `${commandCount} ${agentCount > 0 ? '' : 'background '}${commandCount === 1 ? 'command' : 'commands'}`
  if (commandCount === 0) return `Waiting on ${agents}`
  if (agentCount === 0) return `Waiting on ${commands}`
  return `Waiting on ${agents} and ${commands}`
}
