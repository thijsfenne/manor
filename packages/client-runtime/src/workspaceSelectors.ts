import {
  ARCHIVE_RETENTION_MS,
  daysToMs,
  DEFAULT_PROJECT_COLOR,
  DEFAULT_PROJECT_ICON,
  HOME_PROJECT_ID,
  SIDE_CHAT_VOICE,
} from '@manor/contracts'
import type { AgentConfig, Chat, Project, ProjectIcon, SubagentSummary, ThreadEvent, UserInputAnswers, UserInputQuestion, WorkHandoff } from '@manor/contracts'
import { IDLE, type ChatActivity } from './activityState'
import { projectLettersField } from './projectLetters'
import { backgroundReason, needsUser, sessionGroup, sessionStatus, type SessionLive, type SessionStatus } from './sessionStatus'
import { emptyThread, type ThreadState } from './threadState'
import type { WorkspaceState } from './workspaceState'
import type { QuietThread, QuietWorkspace, ThreadShape, WorkspaceShape } from './quietState'

export function threadOf(state: QuietWorkspace, chatId: string): QuietThread
export function threadOf(state: WorkspaceState, chatId: string): ThreadState
export function threadOf(state: WorkspaceShape, chatId: string): ThreadShape
export function threadOf(state: WorkspaceShape, chatId: string): ThreadShape {
  return state.threads[chatId] ?? emptyThread
}

/**
 * The roster plus the one voice that is not on it: the side chat's, which is a model
 * rather than a persona and so has no row to be listed in. Two readers, and both name
 * a speaker rather than offering one: a transcript labelling whoever spoke, and the
 * usage view naming whoever spent. Everywhere else reads `state.agents`.
 */
export const wholeRoster = (state: WorkspaceShape): AgentConfig[] => [...state.agents, SIDE_CHAT_SPEAKER]

/**
 * The side voice as the two naming surfaces need it: an id, a name and a colour, with
 * the rest filled in so it satisfies `AgentConfig`. It never reaches a driver, so none
 * of the rest is read.
 */
export const SIDE_CHAT_SPEAKER: AgentConfig = {
  ...SIDE_CHAT_VOICE,
  character: '',
  driver: 'grok',
  effort: 'medium',
  allowedTools: [],
  mcpServers: [],
  memoryScope: false,
  description: '',
  role: '',
  isCos: false,
}

/** What the transcript renders: the open chat, or nothing pretending to be a chat. */
export function openThread(state: QuietWorkspace): QuietThread
export function openThread(state: WorkspaceState): ThreadState
export function openThread(state: WorkspaceShape): ThreadShape {
  return state.openChatId === null ? emptyThread : threadOf(state, state.openChatId)
}

export const activityOf = (state: Pick<WorkspaceShape, 'activity'>, chatId: string): ChatActivity =>
  state.activity[chatId] ?? IDLE

/** One parent's working children as its sidebar row nests them. */
export interface SubagentGroup {
  /**
   * Every running child, plus a finished one whose own child still runs so that one
   * does not hang loose, in start order with each child's own children right under it.
   * A finished line leaves the sidebar; the Subagents panel keeps the full record.
   */
  children: SidebarSubagent[]
  /** How far below the row a child sits: 0 for its own, 1 for a child's child. */
  depth: Record<string, number>
}

/**
 * One row under a sidebar chat: a Manor-run child, or a provider's own helper, which
 * has no thread or chosen model and is listed only while it runs.
 */
export type SidebarSubagent = Pick<SubagentSummary, 'id' | 'parentChatId' | 'toolCallId' | 'driver' | 'title' | 'state' | 'startedAt'>
  & Partial<Pick<SubagentSummary, 'model' | 'effort'>>

/** Every child the sidebar can draw. A provider-run helper's id is its chat and launch call, never a chat id. */
export function sidebarSubagentRows(state: Pick<WorkspaceShape, 'subagents' | 'nativeSubagents'>): SidebarSubagent[] {
  return [
    ...state.subagents,
    ...state.nativeSubagents.map((helper) => ({ ...helper, id: `${helper.parentChatId}:${helper.toolCallId}`, state: 'running' as const })),
  ]
}

/**
 * A listed child's line of descent, the row's own child first and this one last.
 * Stops at the first parent that is not itself a listed child, which is the chat
 * whose sidebar row carries the whole line.
 */
export function subagentLineage<Child extends Pick<SubagentSummary, 'id' | 'parentChatId'>>(subagents: readonly Child[], childId: string): Child[] {
  const byId = new Map(subagents.map((child) => [child.id, child]))
  const line: Child[] = []
  for (let child = byId.get(childId); child !== undefined && !line.includes(child); child = byId.get(child.parentChatId)) {
    line.unshift(child)
  }
  return line
}

/** Every chat a child's open question waits in: its line of descent's top, never the child. */
function subagentAskChats(subagents: readonly SubagentSummary[]): Set<string> {
  return new Set(subagents.flatMap((child) =>
    child.ask === undefined ? [] : [subagentLineage(subagents, child.id)[0]!.parentChatId]))
}

/**
 * The directory's word on a child, or what its own snapshot says once it fell off that
 * list. A snapshot from while it ran says nothing a launch row does not.
 */
export function subagentSummaryOf(state: Pick<WorkspaceShape, 'subagents' | 'threads'>, childId: string): SubagentSummary | undefined {
  const listed = state.subagents.find((child) => child.id === childId)
  if (listed !== undefined) return listed
  const stored = state.threads[childId]?.subagent
  return stored?.state === 'running' ? undefined : stored
}

/** The question a child under this chat waits on, oldest child first. */
export interface SubagentQuestion {
  /** The child's own chat: the broker holds the turn there, so the answer goes there too. */
  childChatId: string
  title: string
  requestId: string
  questions: UserInputQuestion[]
  /** How many further children wait behind this one. */
  more: number
}

/**
 * A child's question, nested children included. It stands in the chat at the top of
 * its line and never in the child's own view, which takes nothing from the user.
 */
export function openSubagentQuestion(state: Pick<WorkspaceShape, 'subagents'>, chatId: string): SubagentQuestion | null {
  const asking = state.subagents
    .filter((child) => child.ask !== undefined && subagentLineage(state.subagents, child.id)[0]?.parentChatId === chatId)
    .sort((a, b) => a.startedAt - b.startedAt)
  const first = asking[0]
  if (first?.ask === undefined) return null
  return { childChatId: first.id, title: first.title, requestId: first.ask.requestId, questions: first.ask.questions, more: asking.length - 1 }
}

/**
 * The sidebar's working children by the chat whose row shows them; a parent with
 * nothing running has no entry. A child's child has no row of its own to hang off,
 * so it nests under the row its line of descent starts from.
 */
export function subagentGroups(state: WorkspaceShape): Record<string, SubagentGroup> {
  const groups: Record<string, SubagentGroup> = {}
  const rows = sidebarSubagentRows(state)
  const lines = new Map(rows.map((child) => [child.id, subagentLineage(rows, child.id)]))
  // A running child keeps its whole line up to the row in view. The server stops a
  // child's own children when it ends, so a finished parent only stands here for the
  // directory update between its end and theirs.
  const working = new Set(rows
    .filter((child) => child.state === 'running')
    .flatMap((child) => lines.get(child.id)!.map((ancestor) => ancestor.id)))
  // Ordered by the start of each ancestor in turn, so a child's children follow it.
  const ordered = rows.filter((child) => working.has(child.id)).sort((a, b) => {
    const left = lines.get(a.id)!
    const right = lines.get(b.id)!
    for (let at = 0; at < Math.min(left.length, right.length); at++) {
      if (left[at] !== right[at]) return left[at]!.startedAt - right[at]!.startedAt
    }
    return left.length - right.length
  })
  for (const child of ordered) {
    const line = lines.get(child.id)!
    const group = groups[line[0]!.parentChatId] ??= { children: [], depth: {} }
    if (line.length > 1) group.depth[child.id] = line.length - 1
    group.children.push(child)
  }
  return groups
}

/**
 * The instant every list sorts a chat on. A working chat holds the position its run
 * started at instead of riding `lastMessageAt`, which every streamed message bumps:
 * two chats working at once would trade places for the whole run. It takes its real
 * place once the run ends, which is one move on a real event instead of a shuffle.
 */
const orderAt = (state: Pick<WorkspaceShape, 'activity'>, chat: Chat): number => {
  const activity = activityOf(state, chat.id)
  return activity.runningTurns.length > 0 && activity.runStartedAt !== null
    ? activity.runStartedAt
    : chat.lastMessageAt
}

export const chatOf = (state: Pick<WorkspaceShape, 'chats'>, chatId: string | null): Chat | null =>
  chatId === null ? null : (state.chats.find((chat) => chat.id === chatId) ?? null)

/** The three state marks a listed chat shows at rest: a running turn, an open question, an unread answer. */
export interface ChatStanding {
  unread: boolean
  running: boolean
  /** A question of this chat's is open and nobody has answered it. */
  waiting: boolean
}

/**
 * One reading of a chat's standing for every list that shows it (sidebar cards, the
 * sessions overview), so the spinner, Waiting and the unread dot never disagree.
 */
export const standingOf = (activity: ChatActivity): ChatStanding => ({
  unread: activity.unread,
  running: activity.runningTurns.length > 0,
  waiting: activity.awaitingInput.length > 0,
})

export interface SidebarChat extends ChatStanding {
  chat: Chat
  /**
   * The row the stage belongs to, from the click rather than from the snapshot that
   * answers it. A chat being opened is therefore selected while its transcript is
   * still in flight, and the one it replaces is not, so exactly one row is ever lit
   * and the click is answered at once. That a snapshot is still coming is the
   * stage's news to break, not the list's.
   */
  selected: boolean
}

/** The chat the stage is on or heading to, which is the row a list lights. */
const selectedChatId = (state: Pick<WorkspaceShape, 'openChatId' | 'pendingChatId'>) => state.pendingChatId ?? state.openChatId

/**
 * The slices the listed-chat selectors read: `inbox`, `projectThreads`, `chatList` and
 * `sitsSettled`. They are typed by it, so one that reads another slice does not compile.
 */
const LISTED_SLICES = [
  'chats', 'projects', 'agents', 'workHandoffs', 'activity', 'subagents', 'backgroundWork', 'houseSettings', 'openChatId', 'pendingChatId',
] as const satisfies readonly (keyof WorkspaceShape)[]

export type ListedState = Pick<WorkspaceShape, (typeof LISTED_SLICES)[number]>

/**
 * A selector that narrows a workspace to those slices and hands back its previous answer
 * until one of them moves. A streamed text frame changes only `threads`, which no list
 * reads, so a list memoized on this answer holds still through a reply; memoized on the
 * workspace it rebuilt, and redrew every row, on every frame.
 */
export function createListedState(): (state: ListedState) => ListedState {
  let last: ListedState | null = null
  return (state) => {
    if (last !== null && LISTED_SLICES.every((slice) => last![slice] === state[slice])) return last
    last = {
      chats: state.chats, projects: state.projects, agents: state.agents, workHandoffs: state.workHandoffs,
      activity: state.activity, subagents: state.subagents, backgroundWork: state.backgroundWork,
      houseSettings: state.houseSettings, openChatId: state.openChatId, pendingChatId: state.pendingChatId,
    }
    return last
  }
}

export interface SidebarProject {
  project: Project
  chats: SidebarChat[]
}

/**
 * Projects in directory order, each with its own chats nested under it, most
 * recently active first. The server hands them over in that order already; sorting
 * again here is what keeps a chat that just got an event on top without waiting for
 * the next directory broadcast.
 */
export function sidebar(state: WorkspaceShape): SidebarProject[] {
  const childAsks = subagentAskChats(state.subagents)
  return state.projects.map((project) => ({
    project,
    chats: state.chats
      .filter((chat) => chat.projectId === project.id && chat.archivedAt === null)
      .sort((a, b) => orderAt(state, b) - orderAt(state, a))
      .map((chat) => {
        const activity = activityOf(state, chat.id)
        const standing = standingOf(activity)
        return {
          chat,
          selected: selectedChatId(state) === chat.id,
          ...standing,
          waiting: standing.waiting || childAsks.has(chat.id),
        }
      }),
  }))
}

/** One inbox row: the same chat the sidebar knows, plus the room it lives in. */
export interface InboxChat extends SidebarChat {
  /**
   * The room, flattened onto the row: a flat list has no accordion above it to say
   * which project a chat belongs to, so every row wears the project's own name,
   * icon and colour. Flattened rather than carrying the `Project`, because a chat
   * whose project the directory has not listed still has to render as something.
   */
  projectName: string
  projectIcon: ProjectIcon
  /** The project's repo icon link, drawn in place of the glyph while it loads. */
  projectIconSrc?: string
  /** The project's letters, drawn in place of the glyph (`markLetters`). */
  projectLetters?: string
  projectColor: string
  /** The Session has no project: its room is the memory system, which reads as "No project". */
  noProject?: true
  /** Started by its project's thread; the phone names that, the Mac leaves the row out. */
  viaThread?: true
}

export interface Inbox {
  unsettled: InboxChat[]
  settled: InboxChat[]
  /** Archived project chats, newest archive first. The accordion hides when this is empty. */
  archived: InboxChat[]
  /** How long an archived chat stays restorable, as saved in Settings. */
  archiveKeepMs?: number
}

export type InboxSettleLanding =
  | { kind: 'chat'; chatId: string }
  | { kind: 'new-chat' }

/**
 * Where the stage should land when its active inbox chat is settled. Prefer the row
 * below, so working down the list keeps moving forward; at the bottom, keep the last
 * remaining row. An emptied inbox becomes a new draft; the workspace chooses its room
 * from the newest project thread, the same rule as every other New chat entrance.
 */
export function inboxSettleLanding(
  unsettled: readonly InboxChat[],
  settledChat: Chat,
): InboxSettleLanding | undefined {
  const index = unsettled.findIndex((entry) => entry.chat.id === settledChat.id)
  if (index < 0) return undefined
  const next = unsettled[index + 1] ?? unsettled[index - 1]
  if (next !== undefined) return { kind: 'chat', chatId: next.chat.id }
  return settledChat.projectId === null ? undefined : { kind: 'new-chat' }
}

/**
 * Whether a chat is done with. Only a project chat can be: a dm and a group are
 * endless threads, and one carrying a stamp from before that rule still reads as
 * unsettled here — the store no longer writes them, this ignores the ones it did.
 */
// A run settles the same way a project chat does, and is born settled when its
// routine did not ask to be told. A dm and a group never settle.
export const isSettled = (chat: Chat): boolean =>
  (chat.kind === 'project' || chat.kind === 'run') && chat.settledAt !== null

/**
 * Whether a chat sits under Settled as its settle control shows it. A Session reads its
 * shared status, so a confirmed result the user did not stamp is settled here too; any
 * other chat keeps its own stamp. A quiet `done` Session shares the overview's Settled
 * fold but was never settled, so it stays live here and keeps Settle (2026-11-24).
 */
export function sitsSettled(state: Pick<ListedState, 'projects' | 'workHandoffs' | 'activity' | 'subagents' | 'backgroundWork'>, chat: Chat, live = sessionLiveOf(state)) {
  const handoff = handoffIndex(state).byWorkChat.get(chat.id)
  if (handoff === undefined) return isSettled(chat)
  const status = sessionStatus(handoff, chat, live(chat.id))
  return status === 'confirmed' || status === 'settled'
}

/**
 * Whether a settled chat can be put back on the inbox. A project chat always can:
 * settling it is the user's own act and the way back belongs with it. A run never
 * can: it is not an inbox row, so an unsettle would invent one.
 */
/**
 * A project chat is a Session, and the server titles it "New chat" until a title is
 * written. The row says what it is meanwhile; the stored title stays the server's.
 */
export const withSessionTitle = (chat: Chat): Chat =>
  chat.kind === 'project' && chat.title === 'New chat' ? { ...chat, title: 'New Session' } : chat

export const canUnsettle = (_state: WorkspaceShape, chat: Chat): boolean => chat.kind !== 'run'

/**
 * Opening a finished run is reading it. The sidebar orb stays green only while
 * that stamp is still empty, so this is what turns it back into a hollow ring.
 * A turn still in flight waits: settling mid-run would hide a finish you have
 * not actually seen yet if you leave before it ends.
 */
export const shouldSettleOpenRun = (chat: Chat, running: boolean): boolean =>
  chat.kind === 'run' && chat.settledAt === null && !running

/** Client-side alias for the server's default archive retention window. */
export const ARCHIVE_KEEP_MS = ARCHIVE_RETENTION_MS

/**
 * Past its restore window, so the list drops it before the hourly sweep deletes it.
 * `keepMs` is the window saved in Settings; the default stands in before it arrives.
 */
export const isArchiveExpired = (archivedAt: number, now: number, keepMs = ARCHIVE_KEEP_MS): boolean =>
  now - archivedAt >= keepMs

/**
 * Every *project* chat as one flat list, split by whether it has been settled,
 * newest activity first on both sides. The split is the client's: the server orders
 * on `last_message_at` and says nothing about which list a chat belongs in, so
 * settling one moves it between these two without a round trip. A dm, a group
 * and a run are left out: the first two never settle, and a run already has a
 * row under its routine.
 */
export function inbox(state: ListedState, options: { hideThreadSessions?: boolean } = {}): Inbox {
  const rooms = new Map(state.projects.map((project) => [project.id, project]))
  // A project thread has its own row above the list (2026-10-10). The sessions it
  // started stay out of the Mac's list, whose project row carries their state.
  // A hidden project's archived thread stays out as well: it is not a Session, and the
  // project comes back through + in Projects. Its Sessions have no project row to carry
  // them, so they are listed here like any other.
  const threads = threadChatIds(state)
  const liveThreads = new Set(state.chats.flatMap((chat) => threads.has(chat.id) && chat.archivedAt === null ? [chat.id] : []))
  const { threadStarted } = handoffIndex(state)
  const viaThread = (chat: Chat) => {
    const handoff = threadStarted.get(chat.id)
    return handoff !== undefined && liveThreads.has(handoff.sourceChatId)
  }
  const live = sessionLiveOf(state)
  const rows: InboxChat[] = state.chats
    // Runs live under their routine, never here. Notify lights the routine orb;
    // putting the same thread in the inbox was a second row for the same work.
    .filter((chat) => chat.kind === 'project' && !threads.has(chat.id) &&
      !(options.hideThreadSessions === true && viaThread(chat)))
    .sort((a, b) => orderAt(state, b) - orderAt(state, a))
    .map((chat) => {
      const activity = activityOf(state, chat.id)
      // A project chat always names a room, but the directory may not have listed
      // it yet, so the row still has to render as something.
      const project = chat.projectId === null ? undefined : rooms.get(chat.projectId)
      return {
        chat: withSessionTitle(chat),
        projectName: project?.name ?? '',
        projectIcon: project?.icon ?? DEFAULT_PROJECT_ICON,
        ...(project?.repoIconSrc === undefined ? {} : { projectIconSrc: project.repoIconSrc }),
        ...projectLettersField(project),
        projectColor: project?.color ?? DEFAULT_PROJECT_COLOR,
        ...(isHomeRoom(chat.projectId) ? { noProject: true as const } : {}),
        selected: selectedChatId(state) === chat.id,
        ...listedStanding(state, chat, activity, live),
        ...(viaThread(chat) ? { viaThread: true as const } : {}),
      }
    })
  return {
    unsettled: rows.filter((row) => row.chat.archivedAt === null && !sitsSettled(state, row.chat, live)),
    settled: rows.filter((row) => row.chat.archivedAt === null && sitsSettled(state, row.chat, live)),
    archived: rows
      .filter((row) => row.chat.archivedAt !== null)
      .sort((a, b) => (b.chat.archivedAt ?? 0) - (a.chat.archivedAt ?? 0)),
    archiveKeepMs: state.houseSettings === null ? ARCHIVE_KEEP_MS : daysToMs(state.houseSettings.archiveRetentionDays),
  }
}

/**
 * A listed project chat's marks. A Session's come from its shared status, so its sidebar
 * card says what its Work card and overview row say, settled included. A plain chat, or
 * a closed Session no list shows, keeps the chat's own reading.
 */
function listedStanding(state: Pick<ListedState, 'projects' | 'workHandoffs'>, chat: Chat, activity: ChatActivity, live: (chatId: string) => SessionLive) {
  const handoff = handoffIndex(state).byWorkChat.get(chat.id)
  const session = live(chat.id)
  const status = handoff === undefined ? 'closed' : sessionStatus(handoff, chat, session)
  return status === 'closed' ? { ...standingOf(activity), waiting: session.asking } : overviewMarks(status, activity.unread)
}

interface HandoffIndex {
  projects: readonly Project[]
  /** The first handoff naming each Session chat, as `workHandoffs.find` would pick it. */
  byWorkChat: ReadonlyMap<string, WorkHandoff>
  /** The same chats' handoffs, kept only where a project thread started them (`threadStartedHandoff`). */
  threadStarted: ReadonlyMap<string, WorkHandoff>
}

const handoffIndexes = new WeakMap<readonly WorkHandoff[], HandoffIndex>()

/**
 * Handoffs keyed by their Session's chat, built once per directory. The sidebar lists
 * ask once per chat, and a scan of every handoff for each of ~1,000 chats is what made
 * a chat switch or a directory broadcast recompute for tens of milliseconds.
 */
function handoffIndex(state: Pick<WorkspaceShape, 'projects' | 'workHandoffs'>): HandoffIndex {
  const cached = handoffIndexes.get(state.workHandoffs)
  if (cached?.projects === state.projects) return cached
  const threadOfProject = new Map(state.projects.flatMap((project) => project.threadChatId === undefined ? [] : [[project.id, project.threadChatId] as const]))
  const byWorkChat = new Map<string, WorkHandoff>()
  const threadStarted = new Map<string, WorkHandoff>()
  for (const handoff of state.workHandoffs) {
    if (handoff.workChatId === null) continue
    if (!byWorkChat.has(handoff.workChatId)) byWorkChat.set(handoff.workChatId, handoff)
    const thread = threadOfProject.get(handoff.projectId)
    if (thread !== undefined && thread === handoff.sourceChatId && !threadStarted.has(handoff.workChatId)) {
      threadStarted.set(handoff.workChatId, handoff)
    }
  }
  const index = { projects: state.projects, byWorkChat, threadStarted }
  handoffIndexes.set(state.workHandoffs, index)
  return index
}

/** Every project's curated thread (decided 2026-10-10), a hidden project's archived one included. */
const threadChatIds = (state: Pick<WorkspaceShape, 'projects'>): Set<string> =>
  new Set(state.projects.flatMap((project) => project.threadChatId === undefined ? [] : [project.threadChatId]))

/** Whether this chat is a project's curated thread. */
export const isProjectThread = (state: WorkspaceShape, chatId: string): boolean =>
  state.projects.some((project) => project.threadChatId === chatId)

/**
 * The live project thread that started this session, with the handoff that links them. A
 * hidden project's Session stands alone. Typed by the slices it reads, here and on the
 * selectors below, so a caller that memoizes can name exactly those as its dependencies.
 */
export function sessionThreadOf(state: Pick<WorkspaceShape, 'projects' | 'workHandoffs' | 'chats'>, chatId: string): { project: Project; threadChatId: string; handoff: WorkHandoff } | undefined {
  const handoff = handoffIndex(state).threadStarted.get(chatId)
  const project = handoff === undefined ? undefined : state.projects.find((entry) => entry.id === handoff.projectId)
  if (handoff === undefined || project?.threadChatId === undefined) return undefined
  return chatOf(state, project.threadChatId)?.archivedAt === null ? { project, threadChatId: project.threadChatId, handoff } : undefined
}

/**
 * What runs in a chat right now, as every Session reader takes it. The card reads it
 * through `projectWorkHandoffs`, the overview and the project row read it directly.
 * Running counts a turn and the work it started that outlives the turn (a Manor helper,
 * or a provider's helper or shell in its live session); background is that work alone,
 * once no turn runs.
 */
export const sessionLiveOf = (state: Pick<WorkspaceShape, 'activity' | 'subagents' | 'backgroundWork'>): ((chatId: string) => SessionLive) => {
  // Built once per reader, which then asks about every listed chat.
  const helping = new Set(state.subagents.flatMap((child) => child.state === 'running' ? [child.parentChatId] : []))
  const childAsks = subagentAskChats(state.subagents)
  return (chatId: string) => {
    const activity = state.activity[chatId] ?? IDLE
    const turn = activity.runningTurns.length > 0
    const background = Object.hasOwn(state.backgroundWork, chatId) || helping.has(chatId)
    return {
      running: turn || background,
      background: !turn && background,
      asking: activity.awaitingInput.length > 0 || childAsks.has(chatId),
    }
  }
}

/** What a chat's ended turn left running: its live session's work and its running Manor children. */
const backgroundWorkOf = (state: Pick<WorkspaceShape, 'subagents' | 'backgroundWork'>, chatId: string) => [
  ...state.backgroundWork[chatId] ?? [],
  ...state.subagents.flatMap((child) => child.state === 'running' && child.parentChatId === chatId ? [{ title: child.title, kind: 'agent' as const }] : []),
]

/**
 * The overview group a project session stands in. `waiting` reads Needs you, the user's
 * move; `background` reads Waiting, on work the Session started; `settled` holds the
 * finished ones, a quiet `done` Session included (2026-11-24).
 */
export type SessionOverviewGroup = 'waiting' | 'working' | 'background' | 'settled'

/** One row of a project thread's session overview, wearing the sidebar card's state marks. */
export interface SessionOverviewRow extends ChatStanding {
  /** The session's chat id, or its proposal card's row key while it waits for Accept. */
  key: string
  title: string
  /** Null for a proposal, whose session does not exist until Accept. */
  chat: Chat | null
  /** The same reading the session's card in the thread shows. */
  status: SessionStatus
  /**
   * The newest line said in the session, or a proposal's goal; empty before anyone spoke.
   * A Session in `background` says what it waits on instead.
   */
  line: string
  /** When it last moved, the way the sidebar orders it. A running turn's start, else its last message. */
  at: number
}

export interface SessionOverview extends Record<SessionOverviewGroup, SessionOverviewRow[]> {
  /**
   * The thread's Sessions the user archived, newest archived first. The sidebar list leaves
   * these out on the Mac (a thread's Sessions live in this overview), so this is the only
   * place a restore can be offered. Not grouped: an archived Session has no standing.
   */
  archived: SessionOverviewRow[]
  /** The retention window from Settings, so the view can drop a row past its restore window. */
  archiveKeepMs: number
}

/**
 * The sessions a project thread started, newest first, in the groups its overview
 * shows (decided 2026-10-11), each from the Session's shared status. Needs you holds
 * a proposal to accept, a question, a result to confirm or a blocked commit, all of them
 * the user's move, even mid-turn. Working is a running turn. Waiting
 * (2026-11-18) is a turn that ended while work it started still runs (a Manor helper, or
 * a provider's helper or shell in its live session), whose end wakes it; the overview
 * shows that fold only while it has rows. Settled is the user's own stamp, a result they
 * confirmed, or a Session gone quiet without a result, which reads Done and keeps its
 * live row with Settle (2026-11-24). Sessions of the
 * project that the thread did not start are ordinary sessions and stay in the sidebar list.
 */
export function projectSessionOverview(
  state: Pick<WorkspaceShape, 'projects' | 'chats' | 'workHandoffs' | 'activity' | 'subagents' | 'backgroundWork' | 'houseSettings'>,
  threadChatId: string,
): SessionOverview {
  const groups: SessionOverview = {
    waiting: [], working: [], background: [], settled: [], archived: [],
    archiveKeepMs: state.houseSettings === null ? ARCHIVE_KEEP_MS : daysToMs(state.houseSettings.archiveRetentionDays),
  }
  if (!state.projects.some((entry) => entry.threadChatId === threadChatId)) return groups
  const live = sessionLiveOf(state)
  const { threadStarted } = handoffIndex(state)
  const sessions = state.chats.flatMap((chat) => {
    if (chat.kind !== 'project') return []
    const handoff = threadStarted.get(chat.id)
    if (handoff?.sourceChatId !== threadChatId) return []
    if (chat.archivedAt !== null) {
      groups.archived.push({
        key: chat.id, title: chat.title, chat, status: 'closed',
        line: chat.lastMessagePreview ?? '', at: orderAt(state, chat), unread: false, running: false, waiting: false,
      })
      return []
    }
    const status = sessionStatus(handoff, chat, live(chat.id))
    const activity = activityOf(state, chat.id)
    // A legacy proposal owned its chat before Accept; it still leads to its card, not the chat.
    const row = status === 'proposed'
      ? proposalRow(handoff, chat.title)
      : {
          key: chat.id, title: chat.title, chat, status,
          line: status === 'background' ? backgroundReason(backgroundWorkOf(state, chat.id)) : chat.lastMessagePreview ?? '',
          at: orderAt(state, chat), ...overviewMarks(status, activity.unread),
        }
    return [row]
  })
  // A proposal has no chat yet, so it is found from its handoff; Accept turns it into the session's row.
  const proposals = state.workHandoffs.flatMap((handoff) => {
    if (handoff.sourceChatId !== threadChatId || handoff.workChatId !== null || handoff.supersededById !== undefined) return []
    return sessionStatus(handoff, undefined, live('')) === 'proposed' ? [proposalRow(handoff, handoff.title)] : []
  })
  groups.archived.sort((a, b) => (b.chat?.archivedAt ?? 0) - (a.chat?.archivedAt ?? 0))
  for (const row of [...sessions, ...proposals].sort((a, b) => b.at - a.at)) {
    const group = sessionGroup(row.status)
    if (group !== null) groups[group].push(row)
  }
  return groups
}

/** What the phone's Sessions button says about its project: The user is needed, a Session finished unseen, or one runs. */
export type SessionsDot = 'waiting' | 'finished' | 'working'

/**
 * The one dot a project thread's Sessions button wears, strongest first: a question,
 * proposal, result to confirm or blocked commit (`needsthe user`), then a Session that
 * finished with an answer the user has not opened, then any running one. Opening a Session
 * clears its unread mark, which is what clears the green.
 */
export function sessionsDot(overview: SessionOverview): SessionsDot | null {
  if (overview.waiting.some((row) => needsUser(row.status))) return 'waiting'
  if ([...overview.waiting, ...overview.settled].some((row) => row.unread)) return 'finished'
  return overview.working.length > 0 ? 'working' : null
}

/** A proposal's overview row, which leads to its card in the thread where Accept is. */
const proposalRow = (handoff: WorkHandoff, title: string): SessionOverviewRow => ({
  key: `work:${handoff.id}`, title, chat: null, status: 'proposed',
  line: handoff.summary ?? handoff.task ?? '', at: handoff.createdAt, ...overviewMarks('proposed', false),
})

/**
 * A Session row's Standing marks from its status, so its spinner and Waiting say what
 * the card says. Waiting stands for a question or a proposal, the spinner for working.
 */
const overviewMarks = (status: SessionStatus, unread: boolean) => ({
  unread,
  running: status === 'working',
  waiting: status === 'waiting' || status === 'proposed',
})

/** A question a session asked its project thread, waiting there for an answer. */
export interface ThreadQuestion {
  sessionChatId: string
  requestId: string
  agentId: string
  title: string
  questions: UserInputQuestion[]
  /** How many further session questions wait behind this one. */
  more: number
}

/**
 * The oldest session question this thread still holds open, or null. Open means the
 * session's turn still waits on it and no answer note followed it here.
 */
export function openThreadQuestion(state: WorkspaceShape, threadChatId: string): ThreadQuestion | null {
  return threadQuestionIn(threadOf(state, threadChatId).events, state)
}

/** The same reading from a thread's events, for a caller that already holds them. */
export function threadQuestionIn(events: readonly ThreadEvent[], state: Pick<WorkspaceShape, 'activity'>): ThreadQuestion | null {
  const answered = new Set(events.flatMap((event) => event.type === 'system_note' && event.sessionAnswer !== undefined ? [event.sessionAnswer.requestId] : []))
  const open = events.flatMap((event) => {
    const question = event.type === 'system_note' ? event.sessionQuestion : undefined
    if (question === undefined || answered.has(question.requestId)) return []
    return activityOf(state, question.sessionChatId).awaitingInput.includes(question.requestId) ? [question] : []
  })
  const [first, ...rest] = open
  return first === undefined ? null : { ...first, more: rest.length }
}

/**
 * An answer the thread gave a Session from a preference that the user may still replace:
 * the question it answered, keyed by the answer note's id. One the user already replaced is gone.
 */
export interface ChangeableAnswer extends Omit<ThreadQuestion, 'more'> {
  answers: UserInputAnswers
}

export function changeableAnswers(events: readonly ThreadEvent[]): ReadonlyMap<string, ChangeableAnswer> {
  const asked = new Map(events.flatMap((event) => event.type === 'system_note' && event.sessionQuestion !== undefined ? [[event.sessionQuestion.requestId, event.sessionQuestion] as const] : []))
  const changeable = new Map<string, ChangeableAnswer>()
  const noteOf = new Map<string, string>()
  for (const event of events) {
    const answer = event.type === 'system_note' ? event.sessionAnswer : undefined
    if (answer === undefined) continue
    const question = asked.get(answer.requestId)
    if (answer.by === 'thread' && question !== undefined) {
      changeable.set(event.id, { ...question, answers: answer.answers })
      noteOf.set(answer.requestId, event.id)
    } else if (answer.by !== 'thread') changeable.delete(noteOf.get(answer.requestId) ?? '')
  }
  return changeable
}

/** One row of the Projects section: a project with a thread and what its sessions are doing. */
export interface ProjectThreadRow {
  project: Project
  chat: Chat
  selected: boolean
  unread: boolean
  /** Its overview's Working count, "1 running". */
  running: number
  /** A started Session needs the user (`needsthe user`), or the thread's own question waits. */
  waiting: boolean
  /** The newest message in the thread or any session it started. */
  lastActivityAt: number
}

export { HOME_PROJECT_ID }

/**
 * Whether this room is the home room, the memory system a Session without a project
 * works in. No project list holds it, and everything that names a room says "No project".
 */
export const isHomeRoom = (projectId: string | null | undefined): boolean => projectId === HOME_PROJECT_ID

/**
 * The room a chat works in: one of the user's projects, or the home room. Use this to
 * find what a chat can reach (its folders, its files). A list or a menu of projects
 * reads `projects` instead, which never holds the home room.
 */
export const roomOf = (state: { projects: readonly Project[]; home?: Project }, projectId: string | null | undefined): Project | undefined =>
  projectId == null ? undefined : isHomeRoom(projectId) ? state.home : state.projects.find((project) => project.id === projectId)

/** Picker order uses all project chats, including settled and archived activity, without changing sidebar order. */
export function projectsByRecentActivity(state: Pick<WorkspaceShape, 'projects' | 'chats'>): Project[] {
  const latest = new Map<string, number>()
  for (const chat of state.chats) {
    if (chat.projectId === null) continue
    latest.set(chat.projectId, Math.max(latest.get(chat.projectId) ?? -Infinity, chat.lastMessageAt))
  }
  return [...state.projects].sort((a, b) => {
    const left = latest.get(a.id)
    const right = latest.get(b.id)
    if (left === undefined) return right === undefined ? 0 : 1
    if (right === undefined) return -1
    return right - left
  })
}

/** The Projects section, in the projects' own order; a thread whose chat is gone or archived is left out. */
export function projectThreads(state: ListedState): ProjectThreadRow[] {
  return state.projects.flatMap((project) => {
    const chat = project.threadChatId === undefined ? null : chatOf(state, project.threadChatId)
    if (chat === null || chat.archivedAt !== null) return []
    const activity = activityOf(state, chat.id)
    const overview = projectSessionOverview(state, chat.id)
    // A quiet `done` Session sits in Settled but still dates the row, as it did under Needs you.
    const open = [...overview.waiting, ...overview.working, ...overview.settled.filter((row) => row.status === 'done')].flatMap((row) => row.chat === null ? [] : [row.chat])
    return [{
      project,
      chat,
      selected: selectedChatId(state) === chat.id,
      unread: activity.unread,
      running: overview.working.length,
      // Only what the user can act on: a proposal, question, result to confirm or blocked commit.
      waiting: activity.awaitingInput.length > 0 || overview.waiting.some((row) => needsUser(row.status)),
      lastActivityAt: Math.max(chat.lastMessageAt, ...open.map((session) => session.lastMessageAt)),
    }]
  })
}

/**
 * One row of the sidebar's chat list: a persona to talk to, or a group to talk in.
 * A DM row exists for every persona in the household whether or not a chat behind it
 * does, because the list answers "who can I message" and a name that only appears
 * once you have already messaged it answers that badly.
 */
export interface ChatListRow {
  /** The persona for a DM row, the chat for a group; stable as a DM gains its chat. */
  key: string
  kind: 'dm' | 'group' | 'pair'
  /** Null for a persona with no DM yet. Its first send is what creates the chat. */
  chat: Chat | null
  /** Who the DM is with; null on a group row. */
  agentId: string | null
  title: string
  /** The faces on the row: one persona for a DM, the invited set for a group. */
  agentIds: string[]
  /** The last thing said here, one line. Empty for a chat that has none yet. */
  preview: string
  /** Null for a DM nobody has opened yet, which is what sorts it to the bottom. */
  lastMessageAt: number | null
  /** Lit from the click, on the same terms as `SidebarChat['selected']`. */
  selected: boolean
  unread: boolean
  running: boolean
  /** A question of this chat's is open and nobody has answered it. */
  waiting: boolean
}

/**
 * Every persona, plus every group, ordered by what happened last. A
 * persona with no DM yet has nothing to order on and sits at the bottom in roster
 * order, which is the household's own order and not an alphabet nobody chose.
 *
 * Project chats are deliberately absent: they live in a room and the inbox is where
 * the whole house is listed. This view is the messaging one.
 */
export function chatList(state: ListedState): ChatListRow[] {
  const childAsks = subagentAskChats(state.subagents)
  const standing = (chat: Chat) => {
    const activity = activityOf(state, chat.id)
    return {
      selected: selectedChatId(state) === chat.id,
      unread: activity.unread,
      running: activity.runningTurns.length > 0,
      waiting: activity.awaitingInput.length > 0 || childAsks.has(chat.id),
    }
  }

  // A DM is one persona's, and the server keeps exactly one per persona, so the
  // first member is the whole key.
  const dms = new Map<string, Chat>()
  for (const chat of state.chats) {
    const member = chat.kind === 'dm' ? chat.memberIds[0] : undefined
    if (member !== undefined) dms.set(member, chat)
  }

  // Session personas work only inside Sessions, so they have no row to message.
  const rows: ChatListRow[] = state.agents.filter((agent) => agent.placement !== 'session').map((agent) => {
    const chat = dms.get(agent.id) ?? null
    return {
      key: `dm:${agent.id}`,
      kind: 'dm',
      chat,
      agentId: agent.id,
      // The persona's current name, not the title frozen into the chat when it was
      // made: a renamed persona must not keep the old name in the list forever.
      title: agent.name,
      agentIds: [agent.id],
      preview: chat?.lastMessagePreview ?? '',
      lastMessageAt: chat?.lastMessageAt ?? null,
      ...(chat === null
        ? { selected: false, unread: false, running: false, waiting: false }
        : standing(chat)),
    }
  })

  for (const chat of state.chats) {
    if (chat.kind !== 'group') continue
    rows.push({
      key: `chat:${chat.id}`,
      kind: 'group',
      chat,
      agentId: null,
      title: chat.title,
      agentIds: chat.memberIds,
      preview: chat.lastMessagePreview ?? '',
      lastMessageAt: chat.lastMessageAt,
      ...standing(chat),
    })
  }

  for (const chat of state.chats) {
    // Pair rows are created before their opening event can be stored. Keep that
    // implementation gap out of the Agents list; a standing channel begins with its first ask.
    if (chat.kind !== 'pair' || chat.lastMessagePreview === null) continue
    const names = chat.memberIds.map(
      (id) => state.agents.find((agent) => agent.id === id)?.name ?? id,
    )
    rows.push({
      key: `chat:${chat.id}`,
      kind: 'pair',
      chat,
      agentId: null,
      title: names.join(' ⇄ '),
      agentIds: chat.memberIds,
      preview: chat.lastMessagePreview ?? '',
      lastMessageAt: chat.lastMessageAt,
      ...standing(chat),
    })
  }

  // A stable sort, so the personas nobody has messaged keep the roster order they
  // arrived in rather than whatever the comparator happens to leave them in.
  return rows.sort((a, b) => {
    const at = a.chat === null ? null : orderAt(state, a.chat)
    const bt = b.chat === null ? null : orderAt(state, b.chat)
    if (at === null && bt === null) return 0
    if (at === null) return 1
    if (bt === null) return -1
    return bt - at
  })
}

/**
 * The search field's whole logic: match on what the row is called, because that is
 * the only thing a reader can be looking for by name. Case-insensitive and
 * substring, never fuzzy: a list this short does not need guessing.
 */
export function filterChatRows(rows: ChatListRow[], query: string): ChatListRow[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return rows
  return rows.filter((row) => row.title.toLowerCase().includes(needle))
}

/** How many personas the top of the chat list holds; the form refuses a third. */
export const CHAT_LIST_PIN_LIMIT = 2

/**
 * The personas lifted above the chat list, chief of staff first, then roster order.
 * Capped here too, so a roster saved past the limit elsewhere still draws two.
 */
export function chatListPins(agents: readonly AgentConfig[]): AgentConfig[] {
  return chiefFirst(agents.filter((agent) => agent.pinned === true && agent.placement !== 'session')).slice(0, CHAT_LIST_PIN_LIMIT)
}

/** The personas with a face in the desktop rail, chief of staff first, then roster order. */
export function railPins(agents: readonly AgentConfig[]): AgentConfig[] {
  return chiefFirst(agents.filter((agent) => agent.railPinned === true && agent.placement !== 'session'))
}

const chiefFirst = (agents: AgentConfig[]) => [
  ...agents.filter((agent) => agent.isCos === true),
  ...agents.filter((agent) => agent.isCos !== true),
]
