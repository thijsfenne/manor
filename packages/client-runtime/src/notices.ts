import { COMPLETION_NOTICE_FLOOR_MS, type Chat, type DesktopDoneNotice, type ServerMessage, type WorkHandoff } from '@manor/contracts'
import { PROVIDERS } from './runtimes'
import { sessionStatus, QUIET_SESSION } from './sessionStatus'
import type { WorkspaceShape } from './quietState'
import { providerPeak } from './usage'
import { activityOf, chatOf, sessionLiveOf, sitsSettled, subagentLineage } from './workspaceSelectors'

/**
 * Manor's notices: what is worth telling the user about a chat they are not looking
 * at, and where that goes. One reading feeds both doors. A focused window shows it
 * in the app's own stack; an unfocused one hands the banner part to the OS (desktop
 * host or phone push). Never both: `noticeRoute` picks one.
 */

/**
 * How long a run has to have taken before it earns an OS banner. A four second
 * answer is one you were still watching even if you clicked away, and the banner
 * would land after you already read it. The in-app notice has no floor: it only
 * shows for a chat that is not on screen, which already answers "were you watching".
 *
 * Hardcoded rather than offered as a setting: nobody can pick this number
 * correctly without first watching themselves work for a week.
 */
export const DONE_FLOOR_MS = COMPLETION_NOTICE_FLOOR_MS

/** The longest body a notice carries; a preview is already cut to 120 by the store. */
const BODY_LIMIT = 180

/** What a notice is about, which picks its icon and its tone. */
export type NoticeKind =
  /** A run ended: a Session is Done, a group or thread answered. */
  | 'done'
  /** A Session reached its goal and waits on Confirm. */
  | 'ready'
  /** A DM reply finished. */
  | 'reply'
  /** A question, approval or secret waits on the user. */
  | 'waiting'
  /** A Session proposal waits for Accept. */
  | 'proposal'
  /** A turn or a routine failed. */
  | 'failed'
  /** A provider's usage limit is reached. */
  | 'limit'
  /** The user's own action went through. */
  | 'success'
  /** The user's own action did not. */
  | 'error'

/** Where Open goes. A notice about no chat names the page that holds its news. */
export type NoticeTarget = { chatId: string } | { page: 'scheduled' | 'usage' }

export interface AppNotice {
  /** Announced once per key: the turn, the question, the proposal version, the failure. */
  key: string
  kind: NoticeKind
  /**
   * One notice per slot: a newer one for the same slot replaces the older. A chat's
   * notices share its id; one about no chat gets its own (`routine:…`, `limit:…`).
   */
  slot: string
  /** The chat it belongs to, so opening that chat clears it and seeing it suppresses it. */
  chatId: string | null
  /** What happened, in a few words or the line that was said. */
  title: string
  /** The Session or chat name (a routine's or provider's for one about no chat). */
  body: string
  /** Waits on the user: stays until opened or dismissed. */
  sticky: boolean
  /** The OS banner it earns when the window is not focused, if any. */
  banner: DonePing | null
  target: NoticeTarget | null
}

/**
 * A notice for one chat, plus what dedupes it: the turn that finished the chat, or
 * the question a persona is waiting on. The desktop host's banner shape.
 */
export interface DonePing extends DesktopDoneNotice {
  key: string
}

interface EndedRun {
  chat: Chat
  turnId: string
  /** Long enough, or announced as an alert, to earn an OS banner. */
  long: boolean
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
 * is the other one: the chat open on screen while you are in another app. Whether
 * you were looking is `noticeRoute`'s question.
 *
 * Driven by the terminal `turn_state` itself rather than by diffing state. A diff
 * would also fire on `clearRunningTurns`, which blanks every running dot on
 * reconnect and ends no work at all.
 */
function endedRun(before: WorkspaceShape, after: WorkspaceShape, msg: ServerMessage, now: number): EndedRun | null {
  if (msg.type !== 'turn_state' || msg.state === 'running' || msg.routineOutcome === 'quiet' || msg.notice === 'silent') return null
  // The run has to have been watched from here, start included. A snapshot hands a
  // reconnecting client a start time for a run it found already going, which is
  // enough to sort a row and run a timer but not enough to call the end of it news.
  const was = activityOf(before, msg.chatId)
  if (was.runningTurns.length === 0) return null
  // A one-time routine's result is the news itself: a reminder lands in a turn that
  // takes milliseconds and that nobody sat and watched begin.
  const alert = msg.notice === 'alert'
  if (!alert && (was.runStartedAt === null || !was.sawStart)) return null
  if (activityOf(after, msg.chatId).runningTurns.length > 0) return null
  const chat = chatOf(after, msg.chatId)
  // Settled is the user having said they are done with this room. Dms and groups
  // never settle, so this only ever stops a project chat.
  if (chat === null || sitsSettled(after, chat)) return null
  const long = alert || (was.runStartedAt !== null && now - was.runStartedAt >= DONE_FLOOR_MS)
  return { chat, turnId: msg.turnId, long }
}

/**
 * A persona that just stopped to wait on the user: an ask card, a permission card or
 * a secret (a password the user has to click in). The done notice cannot cover it,
 * because the turn is still running and cannot finish without the user. No floor for
 * the same reason. Only a live event counts, since a snapshot replaying an old
 * question is not news, and a settled chat stays quiet as it does for Done.
 */
function waitingPing(before: WorkspaceShape, after: WorkspaceShape, msg: ServerMessage): DonePing | null {
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
  return { chatId: chat.id, key: `ask:${requestId}`, title, body: clip(`${lead}: ${first.question.replace(/\s+/g, ' ').trim()}`) }
}

/**
 * Everything one message can announce, for either door. A notice with a `banner` is
 * one the OS also announces (a long run ended, someone waits on the user); the rest
 * (failures, proposals, limits, short runs) only ever show in the app.
 */
export function eventNotices(before: WorkspaceShape, after: WorkspaceShape, msg: ServerMessage, now: number): AppNotice[] {
  switch (msg.type) {
    case 'turn_state': {
      const notice = runNotice(before, after, msg, now)
      return notice === null ? [] : [notice]
    }
    case 'event': {
      const ping = waitingPing(before, after, msg)
      if (ping === null) return []
      return [{
        key: ping.key, kind: 'waiting', slot: ping.chatId, chatId: ping.chatId,
        title: ping.body, body: ping.title,
        sticky: true, banner: ping, target: { chatId: ping.chatId },
      }]
    }
    // The socket folds every patch into a whole directory. The first one on a socket
    // (`relight` still set) is a reading, also after a reconnect.
    case 'directory':
      return before.relight === null ? [...handoffNotices(before, after), ...helperAskNotices(before, after)] : []
    case 'routines':
      return before.unheard.includes('routines') ? [] : routineNotices(before, after)
    case 'provider_usage':
      return before.unheard.includes('provider_usage') ? [] : limitNotices(before, after)
    default:
      return []
  }
}

function runNotice(before: WorkspaceShape, after: WorkspaceShape, msg: Extract<ServerMessage, { type: 'turn_state' }>, now: number): AppNotice | null {
  const run = endedRun(before, after, msg, now)
  if (run === null) return null
  const { chat } = run
  const text = noticeText(after, chat)
  const banner = run.long ? { chatId: chat.id, key: run.turnId, ...text } : null
  const base = { key: run.turnId, slot: chat.id, chatId: chat.id, sticky: false, banner, target: { chatId: chat.id } }
  if (msg.state === 'error') {
    // A routine's run thread shares the routine's slot, so its failure shows once.
    const slot = chat.kind === 'run' && chat.routineId !== null ? `routine:${chat.routineId}` : chat.id
    return { ...base, slot, kind: 'failed', title: chat.kind === 'run' ? 'Routine failed' : 'Turn failed', body: text.title }
  }
  const handoff = after.workHandoffs.find((item) => item.workChatId === chat.id)
  if (handoff !== undefined) {
    const status = sessionStatus(handoff, chat, sessionLiveOf(after)(chat.id))
    // The user owes Confirm or a commit fix, so like a question it waits to be opened.
    if (status === 'ready' || status === 'blocked') return { ...base, kind: 'ready', title: OWED_TITLE[status], body: text.title, sticky: true }
  }
  if (handoff !== undefined || chat.kind === 'project') return { ...base, kind: 'done', title: 'Session done', body: text.title }
  const said = text.body === 'Finished.' ? undefined : text.body
  if (chat.kind === 'dm' || chat.kind === 'group') return { ...base, kind: 'reply', title: said ?? 'Replied', body: text.title }
  return { ...base, kind: 'done', title: said ?? 'Finished', body: text.title }
}

/** What a Session that owes the user a step says in the stack. */
const OWED_TITLE = { ready: 'Waits on Confirm', blocked: 'Commit needs you' } as const

/**
 * A Session that just came to owe the user a step: a proposal to Accept, shown in the
 * chat that proposed it, or a result to Confirm (or a commit that did not land), shown
 * in the Session. The goal's result is published after its turn ended, so this is
 * where reaching the goal is heard; it replaces that turn's Done in the same slot.
 */
function handoffNotices(before: WorkspaceShape, after: WorkspaceShape): AppNotice[] {
  const statusIn = (state: WorkspaceShape, live: ReturnType<typeof sessionLiveOf>) => (handoff: WorkHandoff | undefined) => {
    if (handoff === undefined) return undefined
    const chat = chatOf(state, handoff.workChatId) ?? undefined
    return sessionStatus(handoff, chat, chat === undefined ? QUIET_SESSION : live(chat.id))
  }
  const liveAfter = sessionLiveOf(after)
  const was = statusIn(before, sessionLiveOf(before))
  const now = statusIn(after, liveAfter)
  return after.workHandoffs.flatMap((handoff): AppNotice[] => {
    const status = now(handoff)
    if (status !== 'proposed' && status !== 'ready' && status !== 'blocked') return []
    if (was(before.workHandoffs.find((item) => item.id === handoff.id)) === status) return []
    const chat = chatOf(after, status === 'proposed' ? handoff.sourceChatId : handoff.workChatId)
    if (chat === null || sitsSettled(after, chat, liveAfter)) return []
    const base = { slot: chat.id, chatId: chat.id, banner: null, target: { chatId: chat.id } }
    if (status === 'proposed') {
      return [{ ...base, key: `proposal:${handoff.id}:${handoff.version}`, kind: 'proposal', title: 'Session to Accept', body: handoff.title, sticky: true }]
    }
    return [{ ...base, key: `${status}:${handoff.id}:${handoff.version}`, kind: 'ready', title: OWED_TITLE[status], body: noticeText(after, chat).title, sticky: true }]
  })
}

/**
 * A helper's question. It reaches the client in the directory, not as an event in a
 * chat, and the user answers it in the chat at the top of the helper's line, so that
 * is where the notice points.
 */
function helperAskNotices(before: WorkspaceShape, after: WorkspaceShape): AppNotice[] {
  const asked = new Set(before.subagents.flatMap((child) => child.ask === undefined ? [] : [child.ask.requestId]))
  return after.subagents.flatMap((child): AppNotice[] => {
    if (child.ask === undefined || asked.has(child.ask.requestId)) return []
    const root = subagentLineage(after.subagents, child.id)[0]
    const chat = chatOf(after, root?.parentChatId ?? null)
    if (chat === null || sitsSettled(after, chat)) return []
    const question = child.ask.questions[0]?.question.replace(/\s+/g, ' ').trim() ?? ''
    return [{
      key: `ask:${child.ask.requestId}`, kind: 'waiting', slot: chat.id, chatId: chat.id,
      title: clip(`${child.title} needs you${question === '' ? '' : `: ${question}`}`), body: noticeText(after, chat).title,
      sticky: true, banner: null, target: { chatId: chat.id },
    }]
  })
}

/**
 * A routine run that just failed: a recurring one's failure count went up, or a
 * one-time one ended failed (which resets the count rather than raising it). A failed
 * run does not move `lastRunAt`, so the count is part of the key.
 */
function routineNotices(before: WorkspaceShape, after: WorkspaceShape): AppNotice[] {
  return after.routines.flatMap((routine): AppNotice[] => {
    const was = before.routines.find((item) => item.id === routine.id)
    if (was === undefined) return []
    const recurring = routine.consecutiveFailures > was.consecutiveFailures
    const once = routine.endState === 'failed' && was.endState !== 'failed'
    if (!recurring && !once) return []
    return [{
      key: once ? `routine:${routine.id}:ended:${routine.endedAt}` : `routine:${routine.id}:${routine.lastRunAt}:${routine.consecutiveFailures}`,
      kind: 'failed', slot: `routine:${routine.id}`,
      chatId: routine.chatId, title: 'Routine failed', body: routine.name, sticky: false, banner: null,
      target: routine.chatId === null ? { page: 'scheduled' } : { chatId: routine.chatId },
    }]
  })
}

/** A provider whose fullest window just ran out. A first reading is not news either. */
function limitNotices(before: WorkspaceShape, after: WorkspaceShape): AppNotice[] {
  // The raw reading, not the rounded percentage left: 99.6% used is not out yet.
  const spent = (state: WorkspaceShape, provider: string) => {
    const usage = state.providerUsage.find((item) => item.provider === provider)
    const peak = usage === undefined ? undefined : providerPeak(usage)
    return peak === undefined ? undefined : peak.usedPercent >= 100
  }
  return after.providerUsage.flatMap((usage): AppNotice[] => {
    if (spent(after, usage.provider) !== true || spent(before, usage.provider) !== false) return []
    const name = PROVIDERS.find((option) => option.value === usage.provider)?.label ?? usage.provider
    return [{
      key: `limit:${usage.provider}:${usage.fetchedAt}`, kind: 'limit', slot: `limit:${usage.provider}`, chatId: null,
      title: 'Limit reached', body: name, sticky: false, banner: null, target: { page: 'usage' },
    }]
  })
}

/** Where a notice goes: the app's own stack, the OS banner, or nowhere. */
export type NoticeDoor = 'app' | 'banner' | null

/**
 * The gate. A focused window shows the notice in the app unless its chat is on screen
 * (then the chat itself is the news); an unfocused one hands only bannered notices to
 * the OS. Never both. The phone's push is the server's, so its client only asks "app".
 */
export function noticeRoute(notice: Pick<AppNotice, 'chatId' | 'banner'>, view: { focused: boolean; onScreen: (chatId: string) => boolean }): NoticeDoor {
  if (view.focused) return notice.chatId !== null && view.onScreen(notice.chatId) ? null : 'app'
  return notice.banner !== null ? 'banner' : null
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
 * here rather than at the point the notice is made.
 */
export function unsentPings<T extends { key: string }>(pings: readonly T[], sent: Set<string>): T[] {
  // Long sessions would otherwise grow this forever. A key that is forgotten can only
  // ping twice if its message arrives twice, which nothing replays.
  if (sent.size > 500) sent.clear()
  const fresh: T[] = []
  for (const ping of pings) {
    if (sent.has(ping.key)) continue
    sent.add(ping.key)
    fresh.push(ping)
  }
  return fresh
}

/** A notice standing in the stack. `id` is its key, unique while it stands. */
export interface NoticeEntry extends Omit<AppNotice, 'banner'> {
  at: number
}

/** The most notices on screen at once; older ones wait under them. */
export const VISIBLE_NOTICES = 3
/** How many the stack holds at all, visible or waiting. */
const HELD_NOTICES = 12

/**
 * Puts a notice on top. A newer one for the same slot replaces the older, except that
 * news which owes the user nothing never pushes out a notice that waits on them: the
 * waiting one stays and moves up, since the user still owes that answer.
 */
export function pushNotice(stack: readonly NoticeEntry[], notice: AppNotice | Omit<AppNotice, 'banner'>, at: number): NoticeEntry[] {
  const { banner: _banner, ...rest } = notice as AppNotice
  const held = stack.find((entry) => entry.slot === notice.slot)
  const top = held !== undefined && held.sticky && !notice.sticky ? { ...held, at } : { ...rest, at }
  // The cap only drops news: a waiting notice stays until it is opened or dismissed.
  let news = 0
  return [top, ...stack.filter((entry) => entry.slot !== notice.slot)].filter((entry) => entry.sticky || ++news <= HELD_NOTICES)
}

export function dismissNotice(stack: readonly NoticeEntry[], key: string): readonly NoticeEntry[] {
  return stack.some((entry) => entry.key === key) ? stack.filter((entry) => entry.key !== key) : stack
}

/** Opening a chat, or seeing it in a split pane, clears what it had standing. */
export function clearChatNotices(stack: readonly NoticeEntry[], onScreen: (chatId: string) => boolean): readonly NoticeEntry[] {
  return stack.some((entry) => entry.chatId !== null && onScreen(entry.chatId))
    ? stack.filter((entry) => entry.chatId === null || !onScreen(entry.chatId))
    : stack
}

/** A tiny store either client can hold outside React and read with `useSyncExternalStore`. */
export interface NoticeStore {
  get: () => readonly NoticeEntry[]
  subscribe: (listener: () => void) => () => void
  push: (notice: AppNotice | Omit<AppNotice, 'banner'>) => void
  dismiss: (key: string) => void
  clearChats: (onScreen: (chatId: string) => boolean) => void
  /** Everything, for a client that lets go of the house it showed. */
  clear: () => void
}

export function createNoticeStore(clock: () => number = Date.now): NoticeStore {
  let stack: readonly NoticeEntry[] = []
  const listeners = new Set<() => void>()
  const set = (next: readonly NoticeEntry[]) => {
    if (next === stack) return
    stack = next
    for (const listener of listeners) listener()
  }
  return {
    get: () => stack,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    push: (notice) => set(pushNotice(stack, notice, clock())),
    dismiss: (key) => set(dismissNotice(stack, key)),
    clearChats: (onScreen) => set(clearChatNotices(stack, onScreen)),
    clear: () => set(stack.length === 0 ? stack : []),
  }
}

/** Is this the user's own action confirmed or refused, rather than news from a chat? */
export const isActionNotice = (kind: NoticeKind) => kind === 'success' || kind === 'error'

let actionCount = 0
/** A short confirmation or refusal of something the user just did. One per text at a time. */
export function actionNotice(kind: 'success' | 'error', title: string, body = ''): Omit<AppNotice, 'banner'> {
  actionCount += 1
  return { key: `action:${actionCount}`, kind, slot: `action:${kind}:${title}`, chatId: null, title, body, sticky: false, target: null }
}

const clip = (text: string) => (text.length > BODY_LIMIT ? `${text.slice(0, BODY_LIMIT - 1)}…` : text)

function noticeText(state: WorkspaceShape, chat: Chat): { title: string; body: string } {
  const nameOf = (id: string | undefined) =>
    id === undefined ? undefined : state.agents.find((agent) => agent.id === id)?.name
  // A dm wears the persona's current name for the same reason its row does: the
  // title frozen in when the chat was made would keep a rename in the banner forever.
  const title = (chat.kind === 'dm' ? nameOf(chat.memberIds[0]) : undefined)
    ?? (chat.kind === 'project' && chat.title === 'New chat' ? 'New Session' : chat.title)
  const said = chat.lastMessagePreview?.trim() ?? ''
  if (said === '') return { title, body: 'Finished.' }
  // Naming the speaker earns its space only where the title does not already say it.
  const speaker = chat.kind === 'dm' ? undefined : nameOf(chat.agentIds[0])
  return { title, body: clip(speaker === undefined ? said : `${speaker}: ${said}`) }
}
