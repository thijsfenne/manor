import { COMPLETION_NOTICE_FLOOR_MS, type Chat, type DesktopDoneNotice, type ServerMessage } from '@manor/contracts'
import { activityOf, chatOf, sessionLiveOf, sitsSettled, type WorkspaceShape } from './state'

/**
 * How long a run has to have taken before it is worth interrupting for. A four
 * second answer is one you were still watching even if you clicked away, and the
 * banner would land after you already read it.
 *
 * Hardcoded rather than offered as a setting: nobody can pick this number
 * correctly without first watching themselves work for a week, so a preference
 * here would be a knob that mostly gets set wrong once and blamed later.
 */
export const DONE_FLOOR_MS = COMPLETION_NOTICE_FLOOR_MS

/** The longest body a notice carries; a preview is already cut to 120 by the store. */
const BODY_LIMIT = 180

/**
 * A notice for one chat, plus what dedupes it: the turn that finished the chat, or
 * the question a persona is waiting on.
 */
export interface DonePing extends DesktopDoneNotice {
  key: string
}

/**
 * Whether the message that just landed leaves a chat standing at Done: a run this
 * client watched, now over. One notice per run, not per turn, which is what makes a
 * household work: an @mention hands off to a second persona whose turn starts before
 * the first one's ends, so the chat never passes through this state in between and
 * the exchange pings once at the end.
 *
 * What it deliberately does *not* ask is whether the chat is unread. Unread means
 * "landed in a chat you did not have open", and the commonest way to miss an answer
 * is the other one: the chat open on screen while you are in another app. Reading
 * the inbox's own flag here made the feature silent in exactly that case. Whether
 * you were looking is the host's question and the host answers it — it drops the
 * notice whenever the window has focus — so the renderer's job ends at "this run is
 * over and it was long enough to matter".
 *
 * Driven by the terminal `turn_state` itself rather than by diffing state. A diff
 * would also fire on `clearRunningTurns`, which blanks every running dot on
 * reconnect and ends no work at all — an armful of banners for a socket that came
 * back up.
 */
export function donePing(
  before: WorkspaceShape,
  after: WorkspaceShape,
  msg: ServerMessage,
  now: number,
): DonePing | null {
  if (msg.type !== 'turn_state' || msg.state === 'running' || msg.routineOutcome === 'quiet' || msg.notice === 'silent') return null
  // The run has to have been watched from here, start included. A snapshot hands a
  // reconnecting client a start time for a run it found already going, which is
  // enough to sort a row and run a timer but not enough to call the end of it news:
  // the work happened while this window was away or shut. `sawStart` is the fact
  // that separates the two, and without it the floor below would happily measure a
  // duration nobody here witnessed.
  const was = activityOf(before, msg.chatId)
  if (was.runningTurns.length === 0) return null
  // A one-time routine's result is the news itself: a reminder lands in a turn that
  // takes milliseconds and that nobody sat and watched begin.
  if (msg.notice !== 'alert') {
    if (was.runStartedAt === null || !was.sawStart) return null
    if (now - was.runStartedAt < DONE_FLOOR_MS) return null
  }

  const activity = activityOf(after, msg.chatId)
  if (activity.runningTurns.length > 0) return null

  const chat = chatOf(after, msg.chatId)
  if (chat === null) return null
  // Settled is the user having said they are done with this room. The inbox already
  // refuses to pull such a chat back up when a background turn lands there; a system
  // banner for that same turn would be the identical interruption through a louder
  // door. Dms and groups never settle, so this only ever stops a project chat.
  if (sitsSettled(after, chat)) return null

  return { chatId: chat.id, key: msg.turnId, ...noticeText(after, chat) }
}

/**
 * A persona that just stopped to wait on the user: an ask card or a permission card. The
 * done notice cannot cover it, because the turn is still running and cannot finish
 * without the user. No floor for the same reason. Only a live event counts, since a
 * snapshot replaying an old question is not news, and a settled chat stays quiet as
 * it does for Done. The host still drops it while the window has focus.
 */
export function waitingPing(before: WorkspaceShape, after: WorkspaceShape, msg: ServerMessage): DonePing | null {
  if (msg.type !== 'event' || msg.event.type !== 'user_input_request') return null
  const { requestId, agentId, questions } = msg.event
  if (activityOf(before, msg.chatId).awaitingInput.includes(requestId)) return null
  if (!activityOf(after, msg.chatId).awaitingInput.includes(requestId)) return null
  const chat = chatOf(after, msg.chatId)
  const first = questions[0]
  if (chat === null || first === undefined || sitsSettled(after, chat)) return null
  const { title } = noticeText(after, chat)
  if (first.secret !== undefined) return { chatId: chat.id, key: `ask:${requestId}`, title, body: 'A secret request is waiting' }
  const name = after.agents.find((agent) => agent.id === agentId)?.name
  const wants = first.optionsOnly === true ? 'needs your approval' : 'needs you'
  const lead = chat.kind === 'dm' || name === undefined ? `${wants[0]!.toUpperCase()}${wants.slice(1)}` : `${name} ${wants}`
  const body = `${lead}: ${first.question.replace(/\s+/g, ' ').trim()}`
  return { chatId: chat.id, key: `ask:${requestId}`, title, body: body.length > BODY_LIMIT ? `${body.slice(0, BODY_LIMIT - 1)}…` : body }
}

/** Everything one message can announce: a chat standing at Done, or one waiting on the user. */
export function noticePing(before: WorkspaceShape, after: WorkspaceShape, msg: ServerMessage, now: number): DonePing | null {
  return donePing(before, after, msg, now) ?? waitingPing(before, after, msg)
}

/**
 * How many chats are standing at Done, for the dock. Deliberately the same
 * derivation as the notice and as the inbox's own label, so the badge and the list
 * can never disagree about how much is waiting.
 */
export function doneCount(state: WorkspaceShape): number {
  const live = sessionLiveOf(state)
  return state.chats.filter((chat) => {
    // A run is not an inbox row, so it must not move the dock either.
    if (chat.kind === 'run' || sitsSettled(state, chat, live)) return false
    const activity = activityOf(state, chat.id)
    return activity.unread && activity.runningTurns.length === 0
  }).length
}

/**
 * Filters a queue down to what has not been announced yet, remembering the rest.
 *
 * React runs a state updater more than once under StrictMode and may re-run one
 * whose render it threw away, so the queue these come from is allowed to hold a
 * duplicate. Sending is the part that has to happen exactly once, so the guard sits
 * here rather than at the point the ping is made. A turn id is announced once and
 * only exists once, which makes it the key.
 */
export function unsentPings(pings: readonly DonePing[], sent: Set<string>): DonePing[] {
  // Long sessions would otherwise grow this forever. A turn whose id is forgotten
  // can only ping twice if its terminal state arrives twice, which nothing replays.
  if (sent.size > 500) sent.clear()
  const fresh: DonePing[] = []
  for (const ping of pings) {
    if (sent.has(ping.key)) continue
    sent.add(ping.key)
    fresh.push(ping)
  }
  return fresh
}

function noticeText(state: WorkspaceShape, chat: Chat): { title: string; body: string } {
  const nameOf = (id: string | undefined) =>
    id === undefined ? undefined : state.agents.find((agent) => agent.id === id)?.name
  // A dm wears the persona's current name for the same reason its row does: the
  // title frozen in when the chat was made would keep a rename in the banner forever.
  const title = (chat.kind === 'dm' ? nameOf(chat.memberIds[0]) : undefined) ?? chat.title
  const said = chat.lastMessagePreview?.trim() ?? ''
  if (said === '') return { title, body: 'Finished.' }
  // Naming the speaker earns its space only where the title does not already say it.
  const speaker = chat.kind === 'dm' ? undefined : nameOf(chat.agentIds[0])
  const body = speaker === undefined ? said : `${speaker}: ${said}`
  return { title, body: body.length > BODY_LIMIT ? `${body.slice(0, BODY_LIMIT - 1)}…` : body }
}
