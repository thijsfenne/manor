import type {
  WorkflowSuggestion,
  ComposioApp,
  ComposioConnectedApp,
  ComposioKeySource,
  ComposioPageConnect,
  AgentConfig,
  Chat,
  RoutineRun,
  Effort,
  FileWriteResult,
  McpAttachment,
  McpHostStatus,
  McpServerConfig,
  MyMindArtifact,
  MyMindSpace,
  Project,
  ProviderUsage,
  ProviderConnection,
  ProviderUpdate,
  AutoRules,
  UsageReport,
  RepoFileResult,
  Routine,
  ServerMessage,
  SkillCandidate,
  SkillConfig,
  SubagentPolicy,
  SubagentSummary,
  SystemInfo,
  NativeSubagent,
  ThreadEvent,
  UserProfile,
  HouseSettings,
  WorkHandoff,
  ContextFiles,
} from '@manor/contracts'
import { DEFAULT_PROJECT_COLOR, DEFAULT_PROJECT_ICON, HOME_PROJECT_ID, MAX_SESSION_DIFF_FILES, isModelOnlyMessage, splitUserMessage, withQuoteExcerpts, type DmFile, type SessionRepo } from '@manor/contracts'
import { plainPreview } from './plainPreview'
import { NO_REMINDERS_YET, reduceReminders, type RemindersState } from './reminders'
import { IDLE, withActivity, type ChatActivity } from './activityState'
import { repoListingKey } from './workspaceActions'
import {
  answeredAsks,
  hasDurableMessage,
  hasDurableResult,
  reduceThread,
  unansweredAsks,
  type ThreadMessage,
  type ThreadState,
} from './threadState'

/**
 * The server's answer to a request that went nowhere, an unusable project folder
 * so far. Transient: one at a time, replaced by the next answer and cleared by the
 * UI that asked. Kept out of `events` on purpose, it is a fact about a request
 * rather than something that happened in a chat.
 */
export type Notice = Omit<Extract<ServerMessage, { type: 'notice' }>, 'type'>

/**
 * One directory as the server described it. The browser cannot read a
 * filesystem, so the folder picker walks the server's own; this is the whole of
 * what it knows about where it is standing.
 */
export type Listing = Omit<Extract<ServerMessage, { type: 'dir_listing' }>, 'type'>

export interface DirBrowse {
  /** Where the picker is standing, or null before the first listing lands. */
  listing: Listing | null
  /**
   * A list_dirs is out and unanswered. Two honest states, asked and here it is;
   * nothing between them, because there is nothing true to say there.
   */
  asking: boolean
}

const NOT_BROWSING: DirBrowse = { listing: null, asking: false }

/** Two listings describe the same place when they name the same folders in the same order. */
const sameListing = (listing: Listing, next: Listing) =>
  listing.path === next.path &&
  listing.parent === next.parent &&
  listing.entries.length === next.entries.length &&
  listing.entries.every((entry, index) => entry.path === next.entries[index]?.path)

/**
 * Two rosters describe the same household when they hold the same personas, field
 * for field. The roster is re-announced on every reconnect and after every change,
 * and an unchanged one that arrives with a new array identity would repaint every
 * bubble in the transcript for nothing.
 */
function sameRoster(current: AgentConfig[], next: AgentConfig[]) {
  return (
    current.length === next.length &&
    current.every((agent, index) => {
      const other = next[index]
      return (
        other !== undefined &&
        agent.id === other.id &&
        agent.name === other.name &&
        agent.color === other.color &&
        agent.character === other.character &&
        agent.driver === other.driver &&
        agent.model === other.model &&
        agent.effort === other.effort &&
        agent.memoryScope === other.memoryScope &&
        agent.description === other.description &&
        agent.role === other.role &&
        agent.isCos === other.isCos &&
        // Every flag the persona form writes, or a save that only moves one never shows.
        agent.placement === other.placement &&
        agent.pinned === other.pinned &&
        agent.railPinned === other.railPinned &&
        agent.speed === other.speed &&
        agent.avatar === other.avatar &&
        agent.avatarShape === other.avatarShape &&
        agent.avatarTone === other.avatarTone &&
        (agent.skillIds ?? []).length === (other.skillIds ?? []).length &&
        (agent.skillIds ?? []).every((skillId, at) => skillId === (other.skillIds ?? [])[at]) &&
        (agent.mentionAllowlist ?? []).length === (other.mentionAllowlist ?? []).length &&
        (agent.mentionAllowlist ?? []).every(
          (agentId, at) => agentId === (other.mentionAllowlist ?? [])[at],
        ) &&
        agent.allowedTools.length === other.allowedTools.length &&
        agent.allowedTools.every((tool, at) => tool === other.allowedTools[at]) &&
        // Attachments count too, and leaving them out was a silent hang rather than a
        // stale label. A persona whose only change is which servers it holds arrived
        // here looking identical, so the reducer kept the old roster, the agent dialog
        // never saw the change it was waiting for, and its Save button read "Saving…"
        // forever over a write that had already landed. Reopening the dialog showed
        // the old attachments; only a full reload showed the truth.
        sameAttachments(agent.mcpServers, other.mcpServers)
      )
    })
  )
}

/** Two attachment lists say the same thing: same servers, same order, same exclusions. */
const sameAttachments = (current: McpAttachment[], next: McpAttachment[]) =>
  current.length === next.length &&
  current.every((attachment, index) => {
    const other = next[index]
    return (
      other !== undefined &&
      attachment.serverId === other.serverId &&
      attachment.disabledTools.length === other.disabledTools.length &&
      attachment.disabledTools.every((tool, at) => tool === other.disabledTools[at])
    )
  })



/**
 * Snapshot rows are canonical up to the instant their store query ran. A broadcast
 * append can reach this client after that query but before the snapshot reply. Since
 * the transcript is append-only, preserving ids the reply does not contain is the
 * one merge that cannot resurrect deleted state and keeps that race from erasing a
 * just-completed message.
 */
function mergeSnapshotEvents(current: ThreadEvent[], snapshot: ThreadEvent[]): ThreadEvent[] {
  if (current.length === 0) return snapshot
  const included = new Set(snapshot.map((event) => event.id))
  const appended = current.filter((event) => !included.has(event.id))
  return appended.length === 0 ? snapshot : [...snapshot, ...appended]
}

/**
 * A snapshot that continues this client's own copy (`after`). Each of its events either
 * already arrived as a broadcast or is new, and the copy keeps its identity when nothing
 * is, so the rows built from it are not rebuilt for a reopen that changed nothing.
 */
function continueEvents(current: ThreadEvent[], after: string, following: ThreadEvent[], replaced: readonly ThreadEvent[] = []): ThreadEvent[] {
  // Events this copy holds that were rewritten in place while it was away.
  const rewritten = new Map(replaced.map((event) => [event.id, event]))
  const base = rewritten.size === 0 || !current.some((event) => rewritten.has(event.id))
    ? current
    : current.map((event) => rewritten.get(event.id) ?? event)
  if (following.length === 0) return base
  // What the copy holds past `after` came as broadcasts, possibly ahead of events it
  // missed while away. The server's order stands; what it did not send stays behind it.
  const found = base.map((event) => event.id).lastIndexOf(after)
  const cut = found === -1 ? base.length - 1 : found
  const head = new Set(base.slice(0, cut + 1).map((event) => event.id))
  const past = base.slice(cut + 1)
  const heard = new Map(past.map((event) => [event.id, event]))
  const sent = new Set(following.map((event) => event.id))
  const tail = [
    ...following.filter((event) => !head.has(event.id)).map((event) => heard.get(event.id) ?? event),
    ...past.filter((event) => !sent.has(event.id)),
  ]
  return tail.length === past.length && tail.every((event, index) => event === past[index]) ? base : [...base.slice(0, cut + 1), ...tail]
}

function sameCheckoutBranches(
  left: readonly { name: string; available: boolean; reason?: string }[],
  right: readonly { name: string; available: boolean; reason?: string }[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (row, index) =>
        row.name === right[index]?.name &&
        row.available === right[index]?.available &&
        row.reason === right[index]?.reason,
    )
  )
}



/**
 * What each chat waits on, as the live broker lists it. The listing is the authority:
 * the broker opens a question before its event goes out and every listing is read as
 * it is sent, so one that leaves a question out means it no longer holds its turn
 * (answered while this client was away, or superseded when the user wrote instead, which
 * emits no event). Only an answer this client already heard is kept out, because the
 * broker lets go of a question just after its answer event.
 */
function awaitingFromDirectory(
  activity: Record<string, ChatActivity>,
  awaiting: Record<string, string[]>,
  live: Set<string>,
): Record<string, ChatActivity> {
  let next = activity
  for (const chatId of new Set([...Object.keys(activity), ...Object.keys(awaiting)])) {
    if (!live.has(chatId)) continue
    const current = next[chatId] ?? IDLE
    const listed = (awaiting[chatId] ?? []).filter((id) => !current.answeredInput.includes(id))
    if (listed.length === current.awaitingInput.length && listed.every((id, index) => id === current.awaitingInput[index])) continue
    next = withActivity(next, chatId, { ...current, awaitingInput: listed })
  }
  return next
}

function reconcileRunning(
  activity: Record<string, ChatActivity>,
  running: Record<string, string[]>,
): Record<string, ChatActivity> {
  let next = activity
  for (const [chatId, current] of Object.entries(activity)) {
    const active = new Set(running[chatId] ?? [])
    const retained = current.runningTurns.filter((id) => active.has(id))
    if (retained.length === current.runningTurns.length) continue
    next = withActivity(next, chatId, {
      ...current,
      runningTurns: retained,
      runStartedAt: retained.length === 0 ? null : current.runStartedAt,
      sawStart: retained.length > 0 && current.sawStart,
      awaitingInput: retained.length === 0 ? [] : current.awaitingInput,
    })
  }
  return next
}

/**
 * The turns a reconnect directory lists, lit again. Only the first directory after a
 * socket opens does this: a later one may have been read just before a turn's end was
 * announced, and lighting from it would bring the finished turn back. The start time
 * stays unknown (lists then order by the last message) and the run counts as unwatched.
 */
function relightRunning(
  activity: Record<string, ChatActivity>,
  running: Record<string, string[]>,
  live: Set<string>,
  ended: readonly string[],
): Record<string, ChatActivity> {
  let next = activity
  for (const [chatId, turnIds] of Object.entries(running)) {
    if (!live.has(chatId)) continue
    const current = next[chatId] ?? IDLE
    const runningTurns = turnIds.filter((id) => !ended.includes(id)).reduce(withTurn, current.runningTurns)
    if (runningTurns === current.runningTurns) continue
    next = withActivity(next, chatId, { ...current, runningTurns })
  }
  return next
}

/** The home room as a client holds it: nameless, with the folders the host reported. */
export const homeRoom = (repoPaths: readonly string[]): Project => ({
  id: HOME_PROJECT_ID, name: '', icon: DEFAULT_PROJECT_ICON, color: DEFAULT_PROJECT_COLOR, memoryScope: 'knowledge', repoPaths: [...repoPaths],
})

export interface WorkspaceState {
  projects: Project[]
  /**
   * The home room: where a Session without a project works, which is the memory
   * system. Never in `projects`, so no list or menu shows it; found by `roomOf`.
   */
  home: Project
  chats: Chat[]
  workHandoffs: WorkHandoff[]
  /**
   * The household. Workspace state and not thread state: Manor has ONE roster and
   * every chat shows the same one, so a per-thread copy would be a second truth
   * that can go stale while a chat sits open.
   */
  agents: AgentConfig[]
  /** False until the first roster lands, so "no personas" is never guessed. */
  hasRoster: boolean
  /**
   * The MCP registry. Workspace state for the same reason the roster is: one list
   * for the household, which the persona form attaches from.
   */
  mcpServers: McpServerConfig[]
  /** What the currently connected Manor host can actually resolve and verify. */
  mcpHostStatuses: McpHostStatus[]
  /** Imported provider-neutral skills, shared by every chat and agent form. */
  skills: SkillConfig[]
  /** Fresh local import candidates. Null until the Skills screen asks for them. */
  skillCandidates: SkillCandidate[] | null
  /** The read-only workflow ledger. Null until Suggestions asks for it. */
  workflowSuggestions: { available: boolean; suggestions: WorkflowSuggestion[] } | null
  /** Composio's app catalogue for the Connectors page. Null until that page asks for it. */
  composioCatalog: { apps: ComposioApp[]; unavailable?: string } | null
  /** Composio accounts and the page's own connects; null until the page asks, then kept live. */
  composioAccounts: { connected: ComposioConnectedApp[]; connects: ComposioPageConnect[]; unavailable?: string } | null
  /** Where this host's Composio key comes from; never the key. Null until the server says. */
  composioKey: ComposioKeySource | null
  /**
   * Every routine in the house. Workspace state for the same reason the roster is:
   * a routine outlives the chat it posts into, and the view that lists them is
   * house-wide. The server pushes the whole list after every mutation, so nothing
   * here is ever patched in place.
   */
  routines: Routine[]
  /** False until the first routines document lands, so empty is never guessed offline. */
  hasRoutines: boolean
  /** Lazy, reply-only run histories for continuing-DM routines, keyed by routine id. */
  routineHistories: Record<string, { chatId: string | null; runs: RoutineRun[] }>
  /** False until the first directory lands, so the sidebar can tell empty from unknown. */
  hasDirectory: boolean
  /**
   * Set until the next directory lights the turns it lists: from the start and again
   * whenever a socket opens (`clearRunningTurns`). Turns kept running while this client
   * was away, and a Session busy with tools sends no delta or `turn_state` that would
   * light its dot again, so it read Done under Needs you. `ended` holds the turns
   * this socket heard end meanwhile: a listing read just before a turn ended can still
   * arrive after its end, and must not bring it back.
   */
  relight: { ended: readonly string[] } | null
  /** The chat whose thread is on screen. Only ever changes when a snapshot lands. */
  openChatId: string | null
  /** Selected, waiting for its snapshot. The open chat stays rendered until it arrives. */
  pendingChatId: string | null
  /** An intentionally empty stage must not be filled by a late or reconnect snapshot. */
  selectionCleared: boolean
  /**
   * Threads on screen besides `openChatId`. A split's unfocused pane is still being
   * read, so a turn that finishes there is not unread and does not move the dock.
   * Local only; the server still has one open chat.
   */
  viewedChatIds: ReadonlySet<string>
  /**
   * The side chat of each chat that has had its panel opened, keyed by the chat it
   * hangs off. The server owns the pairing (one panel per chat, made on first ask), so
   * this is only what the last `side_chat` reply said, kept so re-opening a panel does
   * not have to ask again.
   */
  sideChats: Record<string, string>
  /**
   * Every thread this session has been told is a panel's, whether or not the chat it
   * hangs off still exists. Kept apart from the mapping above because it answers a
   * different question — "may this land on the stage" rather than "which panel does
   * this chat have" — and because the answer has to outlive the mapping: a chat
   * deleted while its panel's snapshot is in flight prunes the mapping, and the
   * snapshot arrives to a workspace that would otherwise no longer recognise it. Ids
   * only, a handful per session, so nothing is gained by pruning them.
   */
  panelThreads: ReadonlySet<string>
  /**
   * Threads read for something other than the stage, such as a persona's DM pin shown
   * in her config. Their first snapshot may not be adopted as the open chat when
   * nothing is selected; a deliberate open still goes through pending.
   */
  backgroundThreads: ReadonlySet<string>
  /**
   * What each open panel runs on, keyed by the panel's own chat id. The server resolves
   * the defaults before it sends them, so this is always concrete and the selector can
   * render without a second copy of what the default is.
   */
  sideRuntimes: Record<string, { model: string; effort: Effort }>
  /** Threads for chats that have been opened at least once, keyed by chat id. */
  threads: Record<string, ThreadState>
  /** Last lazy full-thread reply per draft; inline context remains on the draft event. */
  outboundThreads: Record<string, Extract<ServerMessage, { type: 'outbound_thread' }>>
  activity: Record<string, ChatActivity>
  /** The last thing the server said about a request of ours, until the UI clears it. */
  notice: Notice | null
  /** Where the folder picker is standing. Empty whenever no picker is open. */
  dirs: DirBrowse
  /**
   * Mentionable files keyed by `repoListingKey`. A chat that is isolated has its
   * own listing; the new-chat draft still keys by project because it has no id yet.
   */
  repoFiles: Record<string, RepoFiles>
  /** The latest requested preview, keyed the same way as `repoFiles`. */
  repoFilePreviews: Record<string, RepoFilePreview>
  /** The answer to the latest save, keyed the same way as `repoFiles`. */
  repoFileWrites: Record<string, RepoFileWrite>
  /** A DM's file library as last listed, keyed by chat. Asked for by its Files page. */
  dmFiles: Record<string, readonly DmFile[]>
  /** Last `checkout_status` reply per chat, asked with the composer. */
  checkoutStatus: Record<string, Extract<ServerMessage, { type: 'checkout_status' }>>
  /**
   * Whether a project's linked folders hold a git root, remembered per project from
   * every `checkout_status` that names one. The answer belongs to the folders, not to
   * the chat that asked, so the composer's checkout row can be right on first paint in
   * a project Manor has already read instead of appearing a round trip late.
   */
  projectHasGit: Record<string, boolean>
  /** The Session panel's Changes and Branch per chat, the last `session_repo` reply. */
  sessionRepos: Record<string, Extract<ServerMessage, { type: 'session_repo' }>>
  /** The last whole-Session diff per chat, asked when the diff pane shows it. */
  sessionDiffs: Record<string, Extract<ServerMessage, { type: 'session_diff' }>>
  /** What the last Commit or Push in a chat did, said under its Branch line. */
  sessionGitResults: Record<string, Extract<ServerMessage, { type: 'session_git_result' }>>
  /**
   * A Commit that failed, by chat and then folder, until a status read shows none of
   * its files uncommitted any more, however they landed. Kept apart from
   * `sessionGitResults` so a later Push, or a Commit of other files, cannot drop it.
   */
  sessionCommitFailures: Record<string, Record<string, Extract<ServerMessage, { type: 'session_git_result' }>>>
  /**
   * The last Push per chat and folder that came back with a pull or merge request page.
   * Kept per folder so a Commit or Push in another folder of the chat cannot drop it.
   */
  sessionPushedLinks: Record<string, Record<string, Extract<ServerMessage, { type: 'session_git_result' }>>>
  /** Session Commits still running on the host, replaced whole by every `session_commits`. */
  sessionCommits: Extract<ServerMessage, { type: 'session_commits' }>['commits']
  /** The user's Obsidian vault, when the machine Manor runs on has one. */
  vault: VaultState
  /** The read-only mymind library, loaded only while the Artifacts surface asks. */
  artifacts: ArtifactsState
  /** Apple Reminders on the Mac host, loaded while the Reminders door is open. */
  reminders: RemindersState
  /**
   * How much of each subscription is spent, house-wide. Workspace state for the
   * same reason the roster is: one account per provider, shared by every chat.
   * Empty until the server says, which the footer shows as no number rather than
   * as a zero.
   */
  providerUsage: ProviderUsage[]
  /** Provider CLIs behind their newest release, house-wide. Empty means nothing to say. */
  providerUpdates: ProviderUpdate[]
  /** Which provider CLIs are installed and signed in on the Mac. Empty until the first answer. */
  providerConnections: ProviderConnection[]
  /**
   * The Usage view's own aggregate, or null before it has been asked for.
   *
   * Kept rather than refetched on every open, so returning to the view shows the
   * numbers immediately and replaces them when the fresh answer lands. Null and stale
   * are different states and the view says which it is showing; a spinner over the
   * previous reading would hide numbers that are still true.
   */
  usageReport: UsageReport | null
  /**
   * The Auto mode rule file, or null before the settings dialog first asked for it.
   * Replaced whole on every answer and on the broadcast after a save.
   */
  autoRules: AutoRules | null
  /**
   * Delegated children as the directory lists them: every running one plus the three
   * most recent finished ones per parent. Their threads are not in `chats`.
   */
  subagents: SubagentSummary[]
  /** Provider-run helpers running now, which the sidebar lists beside `subagents`. */
  nativeSubagents: NativeSubagent[]
  /** Chats whose ended turn left background work running in a live session; see the directory. */
  backgroundChatIds: string[]
  /** What subagents may run, or null before Settings first asked for it. */
  subagentPolicy: SubagentPolicy | null
  /** The user as the rail shows them; null until the server's connect message lands. */
  profile: UserProfile | null
  /** Household settings; null until the server's connect message lands. */
  houseSettings: HouseSettings | null
  /** The standing context files as last read from disk; null before Settings asked. */
  contextFiles: ContextFiles | null
  /** What the Mac runs, for Settings' read-only pages; null before they asked. */
  systemInfo: SystemInfo | null
  /**
   * Child threads opened in a Subagents panel, by child id to parent id. An older child
   * falls out of `subagents` once three newer ones finish, and its thread would go with
   * it; this keeps it as long as its parent is listed, the way `sideChats` does.
   */
  childThreads: Record<string, string>
}

export interface VaultState {
  rename?: { requestId: string; path: string; newPath: string; result: { status: 'renamed'; revision: string } | { status: 'rejected'; message: string } | null }

  folders?: string[]
  previews?: Record<string, string>
  folderWrite?: { path: string; result: { status: 'created' } | { status: 'rejected'; message: string } | null }
  /** This client's own delete, until the server answers it. */
  deletion?: { requestId: string; path: string; result: VaultDeleteResult | null }
  /**
   * This client's own move, until the server answers it. `notify` puts a refusal in the
   * app's notice, for a drop that has no dialog to show it in.
   */
  move?: { requestId: string; path: string; folder: string; notify: boolean; result: VaultMoveResult | null }
  /** The last move any client made, which every open editor follows. */
  moved?: { requestId: string; path: string; newPath: string; kind: 'note' | 'folder' }
  /** The last delete any client made, which every open editor checks its note against. */
  deleted?: { requestId: string; path: string; kind: 'note' | 'folder' }
  /** Where a delete moves a note or folder, for the confirm. Null on a server without a vault. */
  trash?: string | null

  /**
   * Whether this machine has a vault. 'unknown' until the server says, which is not
   * the same as 'none': the Knowledge tab appears when the answer is yes, and a tab
   * that flashed in on every connect would be worse than one that arrives a beat late.
   */
  status: 'unknown' | 'ready' | 'none'
  /** The vault folder's name, for the rail that shows what is being read. */
  name: string | null
  /** Its absolute path, so a note's full path can be copied out of the header. */
  root: string | null
  /** Every note path, relative to the vault root. Null until the listing lands. */
  files: string[] | null
  /** The server's cap cut the listing; the rail says so rather than implying it is whole. */
  truncated: boolean
  /** The note the panel is showing; a null result means the read is in flight. */
  note: VaultNote | null
  /** The answer to the last save; a null result means the write is in flight. */
  write: VaultWrite | null
  /**
   * AI edits that came back and no editor has taken yet, by request id. Keyed because
   * two docked notes can each have one out; the editor that asked drops its own.
   */
  noteEdits?: Record<string, VaultNoteEditResult>
}

export type VaultNoteEditResult = Extract<ServerMessage, { type: 'vault_note_edit' }>['result']

export type VaultDeleteResult = Extract<ServerMessage, { type: 'vault_deleted' }>['result']
export type VaultMoveResult = Extract<ServerMessage, { type: 'vault_moved' }>['result']

/** `path` with the moved entry's old path swapped for its new one, or unchanged outside it. */
export const movedVaultPath = (path: string, from: string, to: string): string =>
  insideVaultEntry(path, from) ? `${to}${path.slice(from.length)}` : path

/** Whether `path` is `entry` or lies inside the folder `entry`. */
export const insideVaultEntry = (path: string, entry: string): boolean => path === entry || path.startsWith(`${entry}/`)

export interface VaultNote {
  path: string
  result: RepoFileResult | null
  /**
   * The path the read in flight was sent for, when a move or rename landed before its
   * reply. That reply still answers for this note: a move never changes the bytes.
   */
  requested?: string
}

export interface VaultWrite {
  path: string
  result: FileWriteResult | null
}

export interface ArtifactsState {
  status: 'unknown' | 'ready' | 'none'
  connection: Extract<ServerMessage, { type: 'mymind_status' }> | null
  objects: MyMindArtifact[]
  spaces: MyMindSpace[]
  query: string
  requestId: string | null
  askingQuery: string | null
  loadingMore: boolean
  hasMore: boolean
  error: string | null
}

const NO_ARTIFACTS_YET: ArtifactsState = {
  status: 'unknown',
  connection: null,
  objects: [],
  spaces: [],
  query: '',
  requestId: null,
  askingQuery: null,
  loadingMore: false,
  hasMore: false,
  error: null,
}

const NO_VAULT_YET: VaultState = {
  status: 'unknown',
  name: null,
  root: null,
  files: null,
  truncated: false,
  note: null,
  write: null,
}


/** One project's mentionable files, exactly as the server described them. */
export interface RepoFiles {
  files: string[]
  /** The server's cap cut the list; the menu admits it rather than implying it saw everything. */
  truncated: boolean
}

export interface RepoFilePreview {
  path: string
  result: RepoFileResult | null
}

export interface RepoFileWrite {
  path: string
  result: FileWriteResult | null
}

export const emptyWorkspace: WorkspaceState = {
  projects: [],
  home: homeRoom([]),
  chats: [],
  workHandoffs: [],
  agents: [],
  hasRoster: false,
  mcpServers: [],
  mcpHostStatuses: [],
  skills: [],
  skillCandidates: null,
  workflowSuggestions: null,
  composioCatalog: null,
  composioAccounts: null,
  composioKey: null,
  routines: [],
  hasRoutines: false,
  routineHistories: {},
  hasDirectory: false,
  relight: { ended: [] },
  openChatId: null,
  pendingChatId: null,
  selectionCleared: false,
  viewedChatIds: new Set(),
  sideChats: {},
  sideRuntimes: {},
  panelThreads: new Set(),
  backgroundThreads: new Set(),
  threads: {},
  outboundThreads: {},
  activity: {},
  notice: null,
  dirs: NOT_BROWSING,
  dmFiles: {},
  repoFiles: {},
  repoFilePreviews: {},
  repoFileWrites: {},
  checkoutStatus: {},
  projectHasGit: {},
  sessionRepos: {},
  sessionDiffs: {},
  sessionGitResults: {},
  sessionCommitFailures: {},
  sessionPushedLinks: {},
  sessionCommits: [],
  vault: NO_VAULT_YET,
  artifacts: NO_ARTIFACTS_YET,
  reminders: NO_REMINDERS_YET,
  providerUsage: [],
  providerUpdates: [],
  providerConnections: [],
  usageReport: null,
  autoRules: null,
  subagents: [],
  nativeSubagents: [],
  backgroundChatIds: [],
  subagentPolicy: null,
  profile: null,
  houseSettings: null,
  contextFiles: null,
  systemInfo: null,
  childThreads: {},
}


/** Drops entries for chats the directory no longer lists, keeping identity when nothing changed. */
function keepLive<T>(map: Record<string, T>, live: Set<string>): Record<string, T> {
  const kept = Object.entries(map).filter(([id]) => live.has(id))
  return kept.length === Object.keys(map).length ? map : Object.fromEntries(kept)
}


/** Longest one-line preview a sidebar row shows; the `chat_previews` cut, mirrored. */
const PREVIEW_LIMIT = 120

/**
 * What the row says under the title, from the event that just landed. Only spoken
 * messages count, the same rule the server's `chat_previews` applies, so a tool step
 * or a system note never becomes what the chat is about. Whitespace collapses because
 * a Markdown reply would otherwise smuggle newlines into a single-line row, and an
 * image-only message leaves the previous line standing rather than blanking it.
 *
 * The Markdown itself goes the same way, and before the cut rather than after it, so
 * the limit is spent on words instead of on a link target nobody can see.
 */
const previewOf = (event: ThreadEvent): string | null => {
  if (event.type !== 'user_message' && event.type !== 'agent_message') return null
  // Manor's instruction to the persona after background work ended, or to the model at all, is not something anyone said.
  if (event.type === 'user_message' && (event.source === 'background_wake' || isModelOnlyMessage(event))) return null
  // A half sentence a stop or failure cut off: a DM never shows it, so neither does the row.
  if (event.type === 'agent_message' && event.interrupted === true) return null
  // Flattening is linear in what it reads, so it reads a bounded window: a long
  // reply cannot make every arriving event pay for text the row will never show.
  const shown = event.type === 'user_message' ? withQuoteExcerpts(splitUserMessage(event).visible, event.quotes) : event.text
  const text = plainPreview(shown.slice(0, PREVIEW_LIMIT * 4)).slice(0, PREVIEW_LIMIT)
  return text === '' ? null : text
}

/**
 * Every directory re-lists every chat with the server's raw line, and flattening each
 * of ~1,000 lines again was most of what a directory cost to land. A line always
 * flattens the same way, so each distinct one is flattened once.
 */
const flatListedPreviews = new Map<string, string>()
const flatListedPreview = (line: string): string => {
  let flat = flatListedPreviews.get(line)
  if (flat === undefined) {
    if (flatListedPreviews.size >= 4096) flatListedPreviews.clear()
    flat = plainPreview(line)
    flatListedPreviews.set(line, flat)
  }
  return flat
}

/**
 * The same flattening for a preview the server cut, applied where the listing lands
 * rather than at each of the four places one is read. The store keeps the line as it
 * was written, Markdown and all, and every reader of it (row, banner, search field)
 * wants the words; doing it here is what keeps the next reader from having to know.
 */
const flattenPreview = (chat: Chat): Chat => {
  if (chat.lastMessagePreview === null) return chat
  const preview = flatListedPreview(chat.lastMessagePreview)
  if (preview === chat.lastMessagePreview) return chat
  return { ...chat, lastMessagePreview: preview === '' ? null : preview }
}

/**
 * The three things about a sidebar row that an arriving event settles: when the chat
 * last moved, who moved it, and what was said. All three are what the server writes
 * when it stores the same event, so this only spares the round trip.
 *
 * The speaker goes to the front, which is the order `chat_participants` promises
 * (most recent first) and the order the memory store's own scan produces. Without
 * it the avatar stack is right for every chat except the one being worked in, since
 * nothing broadcasts a directory at the end of a turn. The preview is here for the
 * same reason, and a lazily created DM has no other source at all: its directory
 * announcement goes out before the opening message exists.
 */
const withLiveChat = (chats: Chat[], chatId: string, event: ThreadEvent): Chat[] => {
  const speaker = 'agentId' in event && event.agentId !== undefined ? event.agentId : null
  const spoken = previewOf(event)
  let changed = false
  const next = chats.map((chat) => {
    if (chat.id !== chatId) return chat
    const lastMessageAt = Math.max(chat.lastMessageAt, event.ts)
    const agentIds =
      speaker === null || chat.agentIds[0] === speaker
        ? chat.agentIds
        : [speaker, ...chat.agentIds.filter((id) => id !== speaker)]
    // An event older than what the row already records is a replay or a snapshot
    // catching up; it may not rewrite the line with something that was said earlier.
    const lastMessagePreview =
      spoken !== null && event.ts >= chat.lastMessageAt ? spoken : chat.lastMessagePreview
    if (
      lastMessageAt === chat.lastMessageAt &&
      agentIds === chat.agentIds &&
      lastMessagePreview === chat.lastMessagePreview
    ) {
      return chat
    }
    changed = true
    return { ...chat, lastMessageAt, agentIds, lastMessagePreview }
  })
  return changed ? next : chats
}

const withTurn = (turns: string[], turnId: string) =>
  turns.includes(turnId) ? turns : [...turns, turnId]

const withoutTurn = (turns: string[], turnId: string) => turns.filter((id) => id !== turnId)

function chatIsViewed(state: WorkspaceState, chatId: string): boolean {
  return state.openChatId === chatId || state.viewedChatIds.has(chatId)
}

/**
 * The dot's whole logic: a turn finished while you were away, plus turns still in
 * flight. Turn ids are counted rather than flagged, so the working state does not
 * blink off between two personas answering the same message. Only a terminal
 * `turn_state` is unread: deltas, tool calls and durable messages are intermediate
 * parts of that turn and may not announce an answer that is not ready yet.
 */
function nextActivity(
  current: ChatActivity,
  msg: ThreadMessage,
  isOpen: boolean,
  now: number,
): ChatActivity {
  const unread =
    current.unread ||
    (!isOpen && msg.type === 'turn_state' && msg.state !== 'running' && msg.routineOutcome !== 'quiet')
  const runningTurns = (() => {
    switch (msg.type) {
      case 'delta':
        return withTurn(current.runningTurns, msg.turnId)
      case 'turn_state':
        return msg.state === 'running'
          ? withTurn(current.runningTurns, msg.turnId)
          : withoutTurn(current.runningTurns, msg.turnId)
      case 'turn_background':
      case 'turn_context':
        return current.runningTurns
      case 'event':
        return current.runningTurns
      case 'usage':
        return current.runningTurns
      case 'chat_overrides':
        return current.runningTurns
    }
  })()
  // Held for the whole run, whichever turn of it ends last; a fresh run starts a
  // fresh key. `turn_state` knows the real start, a delta arriving first uses now.
  const runStartedAt =
    runningTurns.length === 0
      ? null
      : (current.runStartedAt ??
        (msg.type === 'turn_state' && msg.state === 'running' ? (msg.startedAt ?? now) : now))
  // Set only by an explicit `turn_state: running`, which the server sends once, at
  // the moment a turn actually begins: a client that received one was connected and
  // listening when the run started. A snapshot rebuilds a running turn from
  // `activeTurn` instead and never sends this message, which is what keeps a run
  // found already going from counting as watched.
  //
  // Deliberately not "runningTurns went from empty to non-empty". After a reconnect
  // the first thing to arrive can be a delta of a turn already in flight, and that
  // transition looks identical to a start from here. Cleared with the run, so the
  // next one is judged on its own.
  const startedHere = msg.type === 'turn_state' && msg.state === 'running'
  const sawStart = runningTurns.length === 0 ? false : current.sawStart || startedHere
  // A question outlives nothing: the turn that asked it is the only thing that can
  // still read the answer, so its end clears the list whether or not one ever came.
  const asked = msg.type === 'event' ? msg.event : null
  const answering =
    asked?.type === 'user_input_request'
      ? withTurn(current.awaitingInput, asked.requestId)
      : asked?.type === 'user_input_response'
        ? withoutTurn(current.awaitingInput, asked.requestId)
        : current.awaitingInput
  const awaitingInput = runningTurns.length === 0 ? [] : answering
  const answeredInput =
    asked?.type === 'user_input_response'
      ? withTurn(current.answeredInput, asked.requestId)
      : current.answeredInput
  return { unread, runningTurns, runStartedAt, sawStart, awaitingInput, answeredInput }
}

/**
 * The single place server messages change client state. Pure, so the whole
 * streaming lifecycle and every chat-switch race can be exercised without a
 * socket or a DOM.
 */
/**
 * Where a failed Commit's files are now, by their current paths: a file renamed since
 * is matched by its old name too, so Reopen ticks it under the name the dialog lists.
 */
export function failedFilesStill(files: readonly string[], repo: Pick<SessionRepo, 'uncommitted'>): string[] {
  return repo.uncommitted.flatMap((entry) =>
    files.includes(entry.path) || (entry.oldPath !== undefined && files.includes(entry.oldPath)) ? [entry.path] : [])
}

/**
 * Drops the failed Commits a status read proves landed: the read covers their folder
 * in full and lists none of their files as uncommitted. A read that failed, one taken
 * while a result waits (which lists nothing), one without the folder (an unreadable
 * checkout is left out) or one cut at the file limit proves nothing and keeps them.
 */
function settledCommitFailures(
  failures: WorkspaceState['sessionCommitFailures'],
  read: Extract<ServerMessage, { type: 'session_repo' }>,
): WorkspaceState['sessionCommitFailures'] {
  const held = failures[read.chatId]
  if (held === undefined || read.error !== undefined || read.waiting) return failures
  const kept = Object.fromEntries(Object.entries(held).filter(([root, failure]) => {
    const repo = read.repos.find((entry) => entry.root === root)
    return repo === undefined || repo.uncommitted.length >= MAX_SESSION_DIFF_FILES || failedFilesStill(failure.files ?? [], repo).length > 0
  }))
  return Object.keys(kept).length === Object.keys(held).length ? failures : { ...failures, [read.chatId]: kept }
}

/** The open note at its new path after a move or rename, still owning a read in flight for the old one. */
function followedNote(note: VaultNote, path: string): VaultNote {
  if (path === note.path) return note
  return note.result === null ? { path, result: null, requested: note.requested ?? note.path } : { path, result: note.result }
}


export function reduce(
  state: WorkspaceState,
  msg: ServerMessage,
  now: number = Date.now(),
): WorkspaceState {
  switch (msg.type) {
    case 'directory': {
      const live = new Set(msg.chats.map((chat) => chat.id))
      // Side chats are deliberately absent from the directory, so they are not in the
      // set above and everything keyed by chat id would drop them on the next one that
      // lands. Each lives exactly as long as the chat it hangs off: the mapping is kept
      // for a parent that is still listed, and the panel's own thread with it.
      const sideChats = Object.fromEntries(
        Object.entries(state.sideChats).filter(([parentId]) => live.has(parentId)),
      )
      for (const chatId of Object.values(sideChats)) live.add(chatId)
      // A child thread is absent from `chats` the same way; it lives while it is listed,
      // or while an open panel holds it and its parent is still there.
      for (const child of msg.subagents ?? []) live.add(child.id)
      const childThreads = Object.fromEntries(
        Object.entries(state.childThreads).filter(([, parentId]) => live.has(parentId)),
      )
      for (const childId of Object.keys(childThreads)) live.add(childId)
      // A deleted chat takes its thread, its dot, and its selection with it.
      // What waits on the user comes from the live broker's listing, also for chats
      // nobody has open, so a question a steer superseded stops counting.
      const keptActivity = keepLive(state.activity, live)
      const reconciled = msg.runningTurns === undefined ? keptActivity : reconcileRunning(keptActivity, msg.runningTurns)
      const relit = state.relight !== null && msg.runningTurns !== undefined ? relightRunning(reconciled, msg.runningTurns, live, state.relight.ended) : reconciled
      const activity = msg.awaitingInput === undefined ? relit : awaitingFromDirectory(relit, msg.awaitingInput, live)
      let threads = keepLive(state.threads, live)
      if (msg.runningTurns !== undefined) {
        for (const [chatId, thread] of Object.entries(threads)) {
          const active = new Set(msg.runningTurns[chatId] ?? [])
          const retained = thread.liveTurns.filter((turn) => active.has(turn.turnId))
          if (retained.length === thread.liveTurns.length) continue
          threads = { ...threads, [chatId]: { ...thread, liveTurns: retained } }
        }
      }
      return {
        ...state,
        projects: msg.projects,
        chats: msg.chats.map(flattenPreview),
        workHandoffs: msg.workHandoffs,
        hasDirectory: true,
        relight: null,
        subagents: msg.subagents ?? state.subagents,
        nativeSubagents: msg.nativeSubagents ?? [],
        backgroundChatIds: msg.backgroundChatIds ?? [],
        childThreads,
        sideChats,
        openChatId: state.openChatId !== null && live.has(state.openChatId) ? state.openChatId : null,
        pendingChatId:
          state.pendingChatId !== null && live.has(state.pendingChatId) ? state.pendingChatId : null,
        threads,
        activity,
      }
    }

    // The household, and no chat's business: one roster serves every chat, so it
    // is taken out of the union before the default branch below, which reads a
    // chatId this message does not carry.
    case 'roster': {
      // Split here rather than at every call site, and compared list against list so
      // an unchanged roster still returns the same state: this message arrives after
      // every persona write, and a new array each time re-renders every list in the
      // app for a roster that did not move.
      if (state.hasRoster && sameRoster(state.agents, msg.agents)) return state
      return { ...state, agents: msg.agents, hasRoster: true }
    }

    // Chatless like the roster, and taken out of the union before the default
    // branch below, which reads a chatId this message does not carry.
    case 'mcp_servers':
      return { ...state, mcpServers: msg.servers }

    case 'mcp_host_statuses':
      return { ...state, mcpHostStatuses: msg.statuses }

    case 'skills':
      return { ...state, skills: msg.skills }

    case 'skill_candidates':
      return { ...state, skillCandidates: msg.skills }

    case 'workflow_suggestions':
      return {
        ...state,
        workflowSuggestions: { available: msg.available, suggestions: msg.suggestions },
      }

    case 'composio_catalog':
      return { ...state, composioCatalog: { apps: msg.apps, ...(msg.unavailable === undefined ? {} : { unavailable: msg.unavailable }) } }

    // A new or removed key makes whatever the old one listed stale; the page asks again.
    case 'composio_key':
      return msg.source === state.composioKey
        ? state
        : { ...state, composioKey: msg.source, composioCatalog: null, composioAccounts: null }

    case 'composio_accounts':
      return {
        ...state,
        composioAccounts: {
          connected: msg.connected,
          connects: msg.connects,
          ...(msg.unavailable === undefined ? {} : { unavailable: msg.unavailable }),
        },
      }

    // Chatless like the roster, and taken out of the union for the same reason. Taken
    // whole every time: the server re-sends the entire list after every mutation, so
    // there is nothing here to merge and no local copy that could disagree with it.
    case 'routines': {
      // A history outlives a broadcast only while its routine still speaks where it
      // did: gone, or moved to another DM or to its project, it is another history.
      const targets = new Map(msg.routines.map((routine) => [routine.id, routine.chatId] as const))
      const routineHistories = Object.fromEntries(
        Object.entries(state.routineHistories).filter(
          ([routineId, history]) => targets.has(routineId) && targets.get(routineId) === history.chatId,
        ),
      )
      return { ...state, routines: msg.routines, hasRoutines: true, routineHistories }
    }

    // Reply-only and keyed by both routine and target. The server echoes the target so
    // a late answer from before a routine edit cannot populate another panel.
    case 'routine_runs': {
      const routine = state.routines.find((entry) => entry.id === msg.routineId)
      if (routine === undefined || routine.chatId !== msg.chatId) return state
      return {
        ...state,
        routineHistories: {
          ...state.routineHistories,
          [msg.routineId]: { chatId: msg.chatId, runs: msg.runs },
        },
      }
    }

    // The socket layer also reads it for click transport. Only whether the Reminders
    // door can work is rendered state.
    case 'host_capabilities': {
      const reminders = reduceReminders(state.reminders, msg)
      const folders = msg.homeFolders ?? []
      const sameHome = folders.length === state.home.repoPaths.length && folders.every((folder, index) => folder === state.home.repoPaths[index])
      if (reminders === state.reminders && sameHome) return state
      return { ...state, reminders, home: sameHome ? state.home : homeRoom(folders) }
    }
    case 'reminders_state':
    case 'reminders_completed': {
      const reminders = reduceReminders(state.reminders, msg)
      return reminders === state.reminders ? state : { ...state, reminders }
    }

    case 'browser_tool_request':
    case 'browser_session_close':
    case 'browser_session_turns':
    case 'computer_stop_armed':
    // The connection rebuilds every patch into a whole `directory` before it gets here.
    case 'directory_patch':
      return state

    // Chatless like the roster. Taken whole every time, `fetchedAt` included: an
    // identical set of percentages read at a later moment is still a change, because
    // how old the reading is is part of what the panel says.
    case 'provider_usage':
      return { ...state, providerUsage: msg.perProvider }
    case 'provider_updates':
      return { ...state, providerUpdates: msg.updates }
    case 'provider_connections':
      return { ...state, providerConnections: msg.providers }

    // A creator-only transport acknowledgement. The socket layer turns it into a
    // selection and snapshot request; it is not workspace or transcript state.
    case 'project_created':
    case 'chat_created':
      return state

    case 'snapshot': {
      // A snapshot is the durable truth for one chat at query time. Socket appends
      // that arrived while it travelled are merged above. The turn and its unfinished
      // text come back from `activeTurn`: the server announces
      // `running` exactly once, so rebuilding it here is the only way a client that
      // arrived mid-turn gets a timer, a current step and a Stop control.
      const held = state.threads[msg.chatId]
      const events = msg.after !== undefined && held !== undefined
        ? continueEvents(held.events, msg.after, msg.events, msg.replaced)
        : mergeSnapshotEvents(held?.events ?? [], msg.events)
      // The snapshot can be older than a terminal event that already landed here.
      // Rebuilding that turn as `running` would leave the spinner on forever.
      const active =
        msg.activeTurn !== undefined && !hasDurableResult(events, msg.activeTurn.turnId)
          ? msg.activeTurn
          : undefined
      const overrides = msg.overrides ?? {}
      const thread: ThreadState = {
        events,
        usage: msg.usage,
        overrides,
        overrideBase: overrides,
        optimisticOverrides: [],
        liveTurns:
          active === undefined
            ? []
            : [
                {
                  turnId: active.turnId,
                  agentId: active.agentId,
                  // A message may have crossed its durable boundary while the
                  // snapshot was assembled. In that race both copies are present;
                  // the durable one wins so the bubble is never doubled.
                  messages: (active.messages ?? []).filter(
                    (message) => !hasDurableMessage(events, active.turnId, message.messageId),
                  ),
                  state: 'running',
                  startedAt: active.startedAt,
                  ...(active.background === undefined ? {} : { background: active.background }),
                  ...(active.context === undefined ? {} : { context: active.context }),
                },
              ],
        // Anything the user sent is either in these events or was lost with the
        // socket; either way an optimistic copy has nothing left to stand for.
        pending: [],
        hasSnapshot: true,
        // The answer this thread was waiting for, whether or not it was waiting.
        refreshing: false,
        ...(msg.subagent === undefined ? {} : { subagent: msg.subagent }),
      }
      const running = active === undefined ? [] : [active.turnId]
      // A panel's thread is asked for while another chat is on the stage, so it must
      // never become the open chat. Tested against every panel thread this session has
      // heard of rather than the live mapping: the mapping is pruned with its parent,
      // and the window that matters is exactly the one where the parent was deleted
      // while the snapshot it had already asked for was still travelling.
      const isPanelThread = state.panelThreads.has(msg.chatId)
      const opens =
        !isPanelThread &&
        (state.pendingChatId === msg.chatId ||
          state.openChatId === msg.chatId ||
          // A Browser session is loaded beside the Browser stage, never adopted as the
          // stage's chat by default; opening one deliberately still goes through pending.
          (state.openChatId === null && !state.selectionCleared && !state.backgroundThreads.has(msg.chatId) &&
            state.chats.find((chat) => chat.id === msg.chatId)?.kind !== 'browser'))
      const openChatId = opens ? msg.chatId : state.openChatId
      const pendingChatId = state.pendingChatId === msg.chatId ? null : state.pendingChatId
      const runStartedAt = active === undefined ? null : active.startedAt
      // A run rebuilt from `activeTurn` is a run this client found already going: it
      // has a start time, which the sidebar's order and the header's timer need, but
      // nobody here watched it begin. `sawStart` is what keeps that distinction, so
      // a turn that ran while the laptop was shut cannot ping when the socket
      // returns in time to see it end.
      const sawStart = false
      const awaitingInput = active === undefined ? [] : unansweredAsks(events, active.turnId)
      const answeredInput = answeredAsks(events)
      const activity =
        openChatId === msg.chatId || state.viewedChatIds.has(msg.chatId)
          ? withActivity(state.activity, msg.chatId, {
              unread: false,
              runningTurns: running,
              runStartedAt,
              sawStart,
              awaitingInput,
              answeredInput,
            })
          : withActivity(state.activity, msg.chatId, {
              ...(state.activity[msg.chatId] ?? IDLE),
              runningTurns: running,
              runStartedAt,
              sawStart,
              awaitingInput,
              answeredInput,
            })
      const backgroundThreads = state.backgroundThreads.has(msg.chatId)
        ? new Set([...state.backgroundThreads].filter((id) => id !== msg.chatId))
        : state.backgroundThreads
      return {
        ...state,
        openChatId,
        pendingChatId,
        backgroundThreads,
        threads: { ...state.threads, [msg.chatId]: thread },
        activity,
      }
    }

    // Consumed by `useRequest` at the socket boundary. It is transport state, not
    // workspace state, so the reducer keeps nothing from it.
    case 'ack':
      return state

    // Answers a request, not a chat, so it carries no chatId and must be taken
    // out of the union before the default branch below, which reads one.
    case 'notice': {
      const current = state.notice
      const notice =
        current !== null &&
        current.kind === msg.kind &&
        current.text === msg.text &&
        current.requestId === msg.requestId
          ? current
          : {
              kind: msg.kind,
              text: msg.text,
              ...(msg.requestId === undefined ? {} : { requestId: msg.requestId }),
            }
      // Any answer ends the picker's wait. A request the server could not serve
      // comes back as a notice and never as a listing, and a wait that outlives
      // its own answer is exactly the spinner that lies.
      const dirs = state.dirs.asking ? { ...state.dirs, asking: false } : state.dirs
      if (notice === current && dirs === state.dirs) return state
      return { ...state, notice, dirs }
    }

    // Proof of life and nothing else. It changes no state; the socket layer above
    // reads its arrival as "the connection is real" and resets its watchdog.
    // Read-only request responses are consumed by the requesting panel.
    case 'project_memory':
    case 'chat_summary':
    case 'agent_notes':
    case 'heartbeat':
      return state

    // Also chatless: it answers the folder picker, which belongs to no chat.
    case 'dir_listing': {
      const current = state.dirs.listing
      const next = { path: msg.path, parent: msg.parent, entries: msg.entries }
      const same = current !== null && sameListing(current, next)
      if (same && !state.dirs.asking) return state
      return { ...state, dirs: { listing: same ? current : next, asking: false } }
    }

    // A file listing follows the chat when the reply carries one, else the project
    // (new-chat draft). Two chats of one project can disagree about checkout.
    case 'repo_files': {
      const key = repoListingKey(msg.projectId, msg.chatId)
      const current = state.repoFiles[key]
      if (
        current !== undefined &&
        current.truncated === msg.truncated &&
        current.files.length === msg.files.length &&
        current.files.every((file, index) => file === msg.files[index])
      ) {
        return state
      }
      return {
        ...state,
        repoFiles: {
          ...state.repoFiles,
          [key]: { files: msg.files, truncated: msg.truncated },
        },
      }
    }
    case 'dm_files':
      return { ...state, dmFiles: { ...state.dmFiles, [msg.chatId]: msg.files } }
    case 'checkout_status': {
      const key = msg.chatId ?? msg.projectId
      if (key === undefined) return state
      const current = state.checkoutStatus[key]
      // Kept whether or not the rest of the reply moved, and kept even when the reply
      // is about one chat: the next chat in that project reads it before its own
      // status lands.
      const hasGit = msg.gitRoots.length > 0
      const projectHasGit =
        msg.projectId === undefined || state.projectHasGit[msg.projectId] === hasGit
          ? state.projectHasGit
          : { ...state.projectHasGit, [msg.projectId]: hasGit }
      if (
        current !== undefined &&
        current.mode === msg.mode &&
        current.branch === msg.branch &&
        current.dirty === msg.dirty &&
        current.gitRoots.length === msg.gitRoots.length &&
        current.gitRoots.every((root, index) => root === msg.gitRoots[index]) &&
        current.leftover?.branch === msg.leftover?.branch &&
        current.leftover?.dirty === msg.leftover?.dirty &&
        current.homeBranch === msg.homeBranch &&
        sameCheckoutBranches(current.branches, msg.branches)
      ) {
        return projectHasGit === state.projectHasGit ? state : { ...state, projectHasGit }
      }
      return { ...state, checkoutStatus: { ...state.checkoutStatus, [key]: msg }, projectHasGit }
    }

    // Reply-only and project-scoped. A slower response for the previously clicked
    // file must not replace the newer selection.
    case 'repo_file': {
      const key = repoListingKey(msg.projectId, msg.chatId)
      const current = state.repoFilePreviews[key]
      if (current?.path !== msg.path) return state
      return {
        ...state,
        repoFilePreviews: {
          ...state.repoFilePreviews,
          [key]: { path: msg.path, result: msg.result },
        },
      }
    }

    // The same echo rule, for the same reason: a save answered after the panel moved
    // to another file has nothing left to say to anybody.
    case 'repo_write': {
      const key = repoListingKey(msg.projectId, msg.chatId)
      const current = state.repoFileWrites[key]
      if (current?.path !== msg.path) return state
      return {
        ...state,
        repoFileWrites: {
          ...state.repoFileWrites,
          [key]: { path: msg.path, result: msg.result },
        },
      }
    }

    // The four vault messages are chatless like the roster, and taken out of the
    // union before the default branch below, which reads a chatId they do not carry.
    // A capability, pushed on connect beside the roster: the tab exists or it does not.
    case 'vault_status': {
      const status = msg.available ? 'ready' : 'none'
      const trash = msg.trash ?? null
      if (state.vault.status === status && state.vault.name === msg.name && state.vault.root === msg.root && (state.vault.trash ?? null) === trash) {
        return state
      }
      return { ...state, vault: { ...state.vault, status, name: msg.name, root: msg.root, trash } }
    }

    // Re-listed after every save that creates a note, so an unchanged list arriving
    // with a new array identity must not repaint three hundred rows for nothing.
    case 'vault_files': {
      const current = state.vault.files
      if (
        current !== null &&
        state.vault.truncated === msg.truncated &&
        JSON.stringify(state.vault.folders ?? []) === JSON.stringify(msg.folders ?? []) &&
        Object.keys(state.vault.previews ?? {}).length === Object.keys(msg.previews ?? {}).length &&
        Object.entries(msg.previews ?? {}).every(([path, preview]) => state.vault.previews?.[path] === preview) &&
        current.length === msg.files.length &&
        current.every((file, index) => file === msg.files[index])
      ) {
        return state
      }
      return { ...state, vault: { ...state.vault, files: msg.files, folders: msg.folders ?? [], previews: msg.previews ?? {}, truncated: msg.truncated } }
    }

    // Reply-only. A slower answer for the note that was open before must not land on
    // top of the one being read now.
    case 'vault_file': {
      const note = state.vault.note
      if (note?.path === msg.path) return { ...state, vault: { ...state.vault, note: { path: msg.path, result: msg.result } } }
      if (note === null || note.result !== null || note.requested !== msg.path) return state
      // The read for the old path ran before the move: its text is the moved note's text.
      // One that ran after it found nothing, so the pending read is dropped, which lets
      // the panel read the new path again instead of waiting forever.
      return { ...state, vault: { ...state.vault, note: msg.result.status === 'ready' ? { path: note.path, result: msg.result } : null } }
    }

    case 'vault_renamed': {
      if (state.vault.rename?.requestId !== msg.requestId) return state
      const vault = { ...state.vault, rename: { requestId: msg.requestId, path: msg.path, newPath: msg.newPath, result: msg.result } }
      if (msg.result.status === 'renamed') {
        vault.files = vault.files?.map((path) => path === msg.path ? msg.newPath : path).sort((a, b) => a.localeCompare(b, 'en')) ?? null
        vault.previews = { ...vault.previews }
        if (vault.previews[msg.path] !== undefined) vault.previews[msg.newPath] = vault.previews[msg.path]!
        if (msg.path !== msg.newPath) delete vault.previews[msg.path]
        if (vault.note?.path === msg.path) vault.note = followedNote(vault.note, msg.newPath)
        if (vault.write?.path === msg.path) vault.write = null
      }
      return { ...state, vault }
    }
    // A landed delete is broadcast: every client drops the entry, and a read or save
    // for a note inside it is forgotten so nothing writes it back.
    case 'vault_deleted': {
      const own = state.vault.deletion?.requestId === msg.requestId
      if (msg.result.status === 'rejected') {
        return own ? { ...state, vault: { ...state.vault, deletion: { requestId: msg.requestId, path: msg.path, result: msg.result } } } : state
      }
      const gone = (path: string) => insideVaultEntry(path, msg.path)
      const vault: VaultState = {
        ...state.vault,
        files: state.vault.files?.filter((path) => !gone(path)) ?? null,
        folders: (state.vault.folders ?? []).filter((path) => !gone(path)),
        previews: Object.fromEntries(Object.entries(state.vault.previews ?? {}).filter(([path]) => !gone(path))),
        note: state.vault.note !== null && gone(state.vault.note.path) ? null : state.vault.note,
        write: state.vault.write !== null && gone(state.vault.write.path) ? null : state.vault.write,
        deleted: { requestId: msg.requestId, path: msg.path, kind: msg.result.kind },
      }
      if (own) vault.deletion = { requestId: msg.requestId, path: msg.path, result: msg.result }
      return { ...state, vault }
    }
    // A landed move is broadcast: every client rewrites the paths under it, so an open
    // note follows. A save in flight for the old path is forgotten, which lets the editor
    // send its text again to the new path instead of reporting the old one missing.
    case 'vault_moved': {
      const own = state.vault.move?.requestId === msg.requestId
      const answered = own ? { ...state.vault.move!, result: msg.result } : undefined
      if (msg.result.status === 'rejected' || msg.result.newPath === msg.path) {
        if (answered === undefined) return state
        const notice = msg.result.status === 'rejected' && answered.notify ? { notice: { kind: 'error' as const, text: msg.result.message } } : {}
        return { ...state, ...notice, vault: { ...state.vault, move: answered } }
      }
      const { newPath, kind } = msg.result
      const swap = (path: string) => movedVaultPath(path, msg.path, newPath)
      const sorted = (paths: readonly string[]) => paths.map(swap).sort((a, b) => a.localeCompare(b, 'en'))
      const vault: VaultState = {
        ...state.vault,
        files: state.vault.files === null ? null : sorted(state.vault.files),
        folders: sorted(state.vault.folders ?? []),
        previews: Object.fromEntries(Object.entries(state.vault.previews ?? {}).map(([path, preview]) => [swap(path), preview])),
        note: state.vault.note === null ? null : followedNote(state.vault.note, swap(state.vault.note.path)),
        write: state.vault.write !== null && insideVaultEntry(state.vault.write.path, msg.path) ? null : state.vault.write,
        moved: { requestId: msg.requestId, path: msg.path, newPath, kind },
      }
      if (answered !== undefined) vault.move = answered
      return { ...state, vault }
    }
    case 'vault_folder_created': {
      if (state.vault.folderWrite?.path !== msg.path) return state
      return { ...state, vault: { ...state.vault, folderWrite: { path: msg.path, result: msg.result } } }
    }
    case 'vault_note_edit':
      return { ...state, vault: { ...state.vault, noteEdits: { ...state.vault.noteEdits, [msg.requestId]: msg.result } } }

    case 'vault_write': {
      if (state.vault.write?.path !== msg.path) return state
      return { ...state, vault: { ...state.vault, write: { path: msg.path, result: msg.result }, ...(msg.preview === undefined ? {} : { previews: { ...state.vault.previews, [msg.path]: msg.preview } }) } }
    }

    case 'mymind_status': {
      const status = msg.available ? 'ready' : 'none'
      return { ...state, artifacts: { ...state.artifacts, status, connection: msg } }
    }

    case 'mymind_objects': {
      if (state.artifacts.requestId !== msg.requestId) return state
      if (msg.result.status === 'error') {
        return {
          ...state,
          artifacts: {
            ...state.artifacts,
            askingQuery: null,
            loadingMore: false,
            error: msg.result.message,
          },
        }
      }
      const objects = msg.append
        ? mergeMyMindObjects(state.artifacts.objects, msg.result.objects)
        : msg.result.objects
      return {
        ...state,
        artifacts: {
          ...state.artifacts,
          objects,
          spaces: msg.append && msg.result.spaces.length === 0 ? state.artifacts.spaces : msg.result.spaces,
          query: msg.query,
          askingQuery: null,
          loadingMore: false,
          hasMore: msg.result.hasMore,
          error: null,
        },
      }
    }

    // House-wide and reply-only, so it is handled here rather than falling through to
    // the chat-scoped default below, which reads a `chatId` this message has not got.
    case 'usage_report':
      return { ...state, usageReport: msg.report }

    // Reply-only and held by the palette that asked, never by workspace state.
    case 'search_results':
      return state

    case 'auto_rules':
      return { ...state, autoRules: msg.rules }

    case 'subagent_policy':
      return { ...state, subagentPolicy: msg.policy }

    case 'profile':
      return { ...state, profile: msg.profile }

    case 'house_settings':
      return { ...state, houseSettings: msg.settings }

    case 'context_files':
      return { ...state, contextFiles: { root: msg.root, files: msg.files } }

    case 'system_info':
      return { ...state, systemInfo: msg.info }

    case 'outbound_thread':
      return {
        ...state,
        outboundThreads: { ...state.outboundThreads, [msg.draftId]: msg },
      }

    // Reply-only as well, and its `chatId` is the panel's own thread rather than a
    // chat this client is showing: the default below would file activity for a chat
    // nothing has open. Keyed by the parent, which is what the panel is opened from.
    // The panel's own pick, echoed back to the client that made it. Reply-only and
    // chat-scoped to a thread nothing else shows, so it is taken out of the union
    // before the default branch treats it as transcript traffic.
    case 'side_runtime':
      return {
        ...state,
        sideRuntimes: { ...state.sideRuntimes, [msg.chatId]: { model: msg.model, effort: msg.effort } },
      }

    // Reply-only and chat-scoped like the side runtime: taken out before the default
    // branch files them as transcript traffic.
    case 'session_repo':
      return {
        ...state,
        sessionRepos: { ...state.sessionRepos, [msg.chatId]: msg },
        sessionCommitFailures: settledCommitFailures(state.sessionCommitFailures, msg),
      }
    case 'session_diff':
      return { ...state, sessionDiffs: { ...state.sessionDiffs, [msg.chatId]: msg } }
    case 'session_git_result': {
      const sessionGitResults = { ...state.sessionGitResults, [msg.chatId]: msg }
      if (msg.action === 'push' && msg.ok && msg.link !== undefined) {
        return { ...state, sessionGitResults, sessionPushedLinks: { ...state.sessionPushedLinks, [msg.chatId]: { ...state.sessionPushedLinks[msg.chatId], [msg.root]: msg } } }
      }
      if (msg.action !== 'commit' || msg.ok) return { ...state, sessionGitResults }
      return {
        ...state,
        sessionGitResults,
        sessionCommitFailures: { ...state.sessionCommitFailures, [msg.chatId]: { ...state.sessionCommitFailures[msg.chatId], [msg.root]: msg } },
      }
    }
    case 'session_commits':
      return { ...state, sessionCommits: msg.commits }

    case 'side_chat':
      return {
        ...state,
        sideChats: { ...state.sideChats, [msg.parentChatId]: msg.chatId },
        sideRuntimes: { ...state.sideRuntimes, [msg.chatId]: { model: msg.model, effort: msg.effort } },
        panelThreads: state.panelThreads.has(msg.chatId)
          ? state.panelThreads
          : new Set(state.panelThreads).add(msg.chatId),
      }

    default: {
      if (msg.type === 'turn_state' && msg.state !== 'running' && state.relight !== null) {
        state = { ...state, relight: { ended: [...state.relight.ended, msg.turnId] } }
      }
      const isOpen = chatIsViewed(state, msg.chatId)
      const activity = withActivity(
        state.activity,
        msg.chatId,
        nextActivity(state.activity[msg.chatId] ?? IDLE, msg, isOpen, now),
      )
      // The sidebar's order and its faces, kept live. A stream that misses one is
      // corrected by the next directory.
      const chats = msg.type === 'event' ? withLiveChat(state.chats, msg.chatId, msg.event) : state.chats
      const base = chats === state.chats ? state : { ...state, chats }
      const thread = state.threads[msg.chatId]
      // A chat never opened has no transcript to grow; the dot is the whole story.
      if (!thread) return activity === state.activity ? base : { ...base, activity }
      const next = reduceThread(thread, msg, now)
      if (next === thread && activity === state.activity) return base
      return { ...base, threads: { ...state.threads, [msg.chatId]: next }, activity }
    }
  }
}


function mergeMyMindObjects(current: readonly MyMindArtifact[], incoming: readonly MyMindArtifact[]): MyMindArtifact[] {
  const byId = new Map(current.map((artifact) => [artifact.id, artifact]))
  for (const artifact of incoming) byId.set(artifact.id, artifact)
  return [...byId.values()]
}
