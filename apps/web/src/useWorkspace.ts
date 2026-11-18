import { createWorkAcceptance, createWorkspaceCommands, type WorkAcceptanceOptions } from '@manor/client-runtime/commands'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  type AgentDraft,
  type ComposioAlias,
  type AutoRulesDraft,
  type BrowserSessionState,
  type BrowserToolName,
  type SlackRichText,
  type ChatMode,
  type ChatOverride,
  type CheckoutRequest,
  type Effort,
  type ClientMessage,
  type DocumentUpload,
  type FileAttachment,
  type ImageAttachment,
  type InlineQuote,
  type MessageReply,
  type McpServerDraft,
  type PageContextAttachment,
  type ProjectIcon,
  type ProjectMemoryScope,
  type ProviderUpdate,
  type ReminderWrite,
  type RepoFileApp,
  type RoutineDraft,
  type ServerMessage,
  type SubagentPolicy,
  type UserProfile,
  type HouseSettings,
  type UsageWindowDays,
  type ContextFileName,
  type DesktopBrowserBridge,
  type UserInputAnswers,
  BROWSER_HOME_SESSION_ID,
} from '@manor/contracts'
import type { ComposerAttachments } from '@manor/client-runtime/attachments'
import {
  createWorkspaceConnection,
  openChatRequest,
  type ConnectionStatus,
  type SocketAdapter,
  type WorkspaceConnection,
} from '@manor/client-runtime/connection'
import {
  createChatMessage,
  type NewChatTarget,
} from '@manor/client-runtime/commands'
import { desktopBrowser, desktopComputer, desktopNotify, desktopPresence, reuseBrowserTab, type BrowserActivity } from './desktopBrowser'
import { BrowserCursorLifecycle } from './browserCursorLifecycle'
import { doneCount, noticePing, unsentPings, type DonePing } from './doneNotice'
import { animationFrames, createFrameQueue, type FrameQueue } from '@manor/client-runtime/frame-queue'
import type { RequestEvents, RequestResponse } from './useRequest'
import {
  askRepoWrite,
  askMyMindObjects,
  askThread,
  askThreadInBackground,
  askVaultWrite,
  activityOf,
  chatOf,
  clearNotice,
  clearChatSelection,
  clearRepoWrite,
  clearRunningTurns,
  clearVaultWrite,
  forgetVaultNoteEdit,
  closeVaultNote,
  createWorkspaceStore,
  emptyWorkspace,
  forgetDirs,
  reduce,
  selectChat,
  setViewedChats as applyViewedChats,
  settleChatOverride,
  sendingUserMessage,
  shouldSettleOpenRun,
  withChatArchived,
  type LiveWorkspace,
  type QuietWorkspace,
  type WorkspaceState,
  type WorkspaceStore,
} from './state'

export type { ConnectionStatus } from '@manor/client-runtime/connection'

/**
 * What the socket needs from the session. The server verifies once, at the
 * handshake, so the token is read when a connection is made and never after.
 */
export interface WorkspaceAuth {
  /**
   * Changes when the identity does, not when its token does. A routine token
   * refresh must not drop a live socket mid-turn; the connection it authorised is
   * already authorised, and the next one will pick up whatever token is current.
   */
  sessionKey: string
  getToken: () => string | null
  /** A socket that died before it ever opened: usually a token the server refused. */
  onRejected?: () => void
}

/**
 * Where a chat about to be made will live. A room, or the household: a `dm` is with
 * exactly one persona and a `group` with two or more, and neither has a project. One
 * type for all three, because the server validates the same combinations either way
 * and a second creation path would drift from this one.
 */
export type { NewChatTarget } from '@manor/client-runtime/commands'

export const addBrowserAttention = (current: ReadonlySet<string>, chatId: string): ReadonlySet<string> =>
  current.has(chatId) ? current : new Set(current).add(chatId)

export const consumeBrowserAttention = (current: ReadonlySet<string>, chatId: string): ReadonlySet<string> => {
  if (!current.has(chatId)) return current
  const next = new Set(current)
  next.delete(chatId)
  return next
}

/** Preparation stays invisible until the requested destination has actually loaded. */
export function browserRevealAction(
  knownChat: boolean,
  awaitingDestination: boolean,
  tool: BrowserToolName,
  arguments_: Readonly<Record<string, unknown>>,
): 'prepare' | 'reveal' | 'none' {
  if (tool === 'browser_tabs' && arguments_.prepare === true) return 'prepare'
  const loadsDestination = tool === 'browser_navigate'
    || (tool === 'browser_tabs' && typeof arguments_.open === 'string')
    || (tool === 'browser_tabs' && typeof arguments_.select === 'string')
    || (awaitingDestination && (tool === 'browser_snapshot' || tool === 'browser_screenshot'))
  if (!loadsDestination) return 'none'
  return awaitingDestination || !knownChat ? 'reveal' : 'none'
}

export interface Manor {
  /**
   * The quiet view: it keeps its identity while a reply streams, so the app renders
   * only on structural changes. Streamed text is read through `live`.
   */
  workspace: QuietWorkspace
  /** The live state, for the few views that draw streamed text (`useLiveThread`). */
  live: LiveWorkspace
  status: ConnectionStatus
  getProjectMemory: (projectId: string, requestId: string) => boolean
  getChatSummary: (chatId: string, requestId: string) => boolean
  getAgentNotes: (agentId: string, requestId: string) => boolean
  /** Undo on one line a memory tool wrote; the server refuses it when that line changed since. */
  undoMemoryWrite: (chatId: string, writeId: string, requestId: string) => boolean
  /** One palette query; the answer arrives on `requestEvents` as `search_results` with this id. */
  search: (query: string, requestId: string) => boolean
  /** Direct replies for request-scoped UI lifecycles; broadcasts remain workspace state. */
  requestEvents: RequestEvents
  /**
   * Which agent, if any, holds each chat's shared browser this instant. Host-local
   * rather than workspace state: only the Electron window has a browser, and only it
   * can answer for one.
   */
  browserActivity: Record<string, BrowserActivity>
  /** Last browser actor until its turn ends, including the gaps between tools. */
  browserUse: Record<string, BrowserActivity>
  /** Chats whose first browser call still needs to reveal the panel when opened. */
  browserAttention: ReadonlySet<string>
  consumeBrowserAttention: (chatId: string) => void
  /** What this host can hand a link to, if anything. Null on a VPS or a phone. */
  externalBrowser: 'dia' | null
  /** Installed host apps that can receive a repository file. Empty off the local Mac host. */
  repoFileApps: readonly RepoFileApp[]
  openChat: (chatId: string) => void
  clearChat: () => void
  /**
   * Asks for a thread snapshot without moving the stage onto it. A split's right
   * pane needs the transcript while the left chat stays the open one.
   */
  loadChat: (chatId: string) => void
  /**
   * Starts a Browser session without moving the stage onto it. The created id lands in
   * `createdBrowserSession`, for the column beside Browser to show.
   */
  createBrowserSession: (mode: ChatMode) => boolean
  createdBrowserSession: string | null
  /**
   * Extra chat ids to snapshot on reconnect, besides the focused open/pending
   * thread. A split's other pane stays live this way without a second server-open.
   */
  setResumeChats: (chatIds: readonly string[]) => void
  /** Local: these threads are on screen, so unread and the dock treat them as viewed. */
  setViewedChats: (chatIds: readonly string[]) => void
  /**
   * Opens the side panel's thread for one chat, creating it on the server the first
   * time. The answer is a `side_chat` reply naming the thread, whose snapshot this
   * hook then asks for: a panel thread is in no directory, so nothing else would.
   * `fresh` deletes the old thread first, which is how the panel's Clear works.
   */
  openSideChat: (parentChatId: string, fresh?: boolean) => boolean
  /**
   * Puts one side chat on a model and an effort. Both together, because they are one
   * control: which levels a provider honours is decided by the model. The answer is a
   * `side_runtime` echo, or a notice and a panel unchanged for a model no installed
   * CLI offers.
   */
  setSideRuntime: (chatId: string, model: string, effort: Effort) => boolean
  /**
   * Sends into a named thread. A split pane uses this so its box cannot land in the other column.
   */
  sendToChat: (
    chatId: string,
    text: string,
    attachments: ComposerAttachments,
    pageContexts?: PageContextAttachment[],
    replyTo?: MessageReply,
    quotes?: InlineQuote[],
  ) => boolean
  /**
   * Sends into the side panel's thread, which is deliberately not the chat on the
   * stage. Its own function rather than a chatId on `sendToChat`, so the ordinary
   * path keeps its one invariant: what you type in the footer goes to the chat you
   * are looking at.
   */
  sendSideMessage: (
    chatId: string,
    text: string,
    images: ImageAttachment[],
    quotes?: InlineQuote[],
  ) => boolean
  stopTurn: (turnId: string) => void
  /** Stops the background work a chat waits on after its turns ended, and any pending wake. */
  stopBackground: (chatId: string) => void
  /** Stops one Manor-run helper without its parent turn. False when the socket was down. */
  stopSubagent: (chatId: string, toolCallId: string) => boolean
  /** Loads a subagent's child thread into its parent's Subagents panel, never onto the stage. */
  openSubagentThread: (childId: string, parentId: string) => void
  /** Asks for what subagents may run; the answer lands in `workspace.subagentPolicy`. */
  requestSubagentPolicy: () => void
  /** Replaces the subagent policy whole. An ack on success, a notice with the reason otherwise. */
  saveSubagentPolicy: (policy: SubagentPolicy, requestId?: string) => boolean
  /** Replaces the profile whole; the broadcast updates every client. */
  saveProfile: (profile: UserProfile, requestId?: string) => boolean
  /** Replaces the house settings whole; the broadcast updates every client. */
  saveHouseSettings: (settings: HouseSettings, requestId?: string) => boolean
  /** Reads the standing context files from disk into `workspace.contextFiles`. */
  requestContextFiles: () => void
  /** Saves one context file against the disk version it was read at; a newer one refuses it. */
  saveContextFile: (name: ContextFileName, content: string, baseHash: string, requestId?: string) => boolean
  /** Asks what the Mac runs, for Settings' read-only pages. */
  requestSystemInfo: () => void
  /** Asks for Tailscale HTTPS and the paired devices, into `workspace.phoneAccess`. */
  requestPhoneAccess: () => void
  /** Turns Manor's Tailscale HTTPS mapping on or off; the broadcast carries the new state. */
  setTailscaleServe: (on: boolean, requestId?: string) => boolean
  /** Asks for a one-time pairing link, into `workspace.pairingLink`. */
  createPairingLink: (requestId?: string) => boolean
  /** Removes a paired device and closes its open connection. */
  revokeDevice: (deviceId: string, requestId?: string) => boolean
  /** Shows a listed log file in Finder on the Mac. */
  revealLog: (path: string) => boolean
  revealFolder: (folder: 'memory' | 'knowledge') => boolean
  /** Answers an ask-user card. Returns false when the socket was down. */
  answerUserInput: (chatId: string, requestId: string, answers: UserInputAnswers) => boolean
  answerSecretRequest: (chatId: string, requestId: string, value?: string) => boolean
  /** Replaces an answer the project thread gave a Session from a preference; the user's message reaches the Session. */
  changeSessionAnswer: (threadChatId: string, requestId: string, answers: UserInputAnswers) => boolean
  submitOutboundDraft: (chatId: string, draftId: string, body: string, subject?: string, slackRichText?: SlackRichText, cc?: string) => boolean
  discardOutboundDraft: (chatId: string, draftId: string) => boolean
  openConnectCard: (chatId: string, connectId: string) => boolean
  snoozeOutboundDraft: (chatId: string, draftId: string, until: number) => boolean
  ignoreOutboundDraft: (chatId: string, draftId: string) => boolean
  restoreOutboundDraft: (chatId: string, draftId: string) => boolean
  readOutboundThread: (chatId: string, draftId: string) => boolean
  /**
   * `repoPaths` are absolute on the server's machine and may be empty on purpose.
   * The answer is a directory that gained a project, or a notice and nothing
   * created. Returns false when the socket was down and nothing went out.
   */
  createProject: (
    name: string,
    repoPaths: string[],
    icon: ProjectIcon,
    color: string,
    memoryScope: ProjectMemoryScope,
    requestId: string,
  ) => boolean
  /**
   * `overrides` are the model/effort pins picked on the new-chat stage, where no
   * chat id exists yet. They ride along with the create so the opening message
   * cannot run its turn before they land.
   */
  createChat: (
    target: NewChatTarget,
    openingMessage?: {
      text: string
      images: ImageAttachment[]
      files?: FileAttachment[]
      documents?: DocumentUpload[]
      pageContexts?: PageContextAttachment[]
    },
    overrides?: Record<string, ChatOverride>,
    checkout?: CheckoutRequest,
    requestId?: string,
  ) => boolean
  setChatCheckout: (chatId: string, checkout: CheckoutRequest) => boolean
  askCheckoutStatus: (chatId: string) => boolean
  /** The Session panel's Changes and Branch for one chat; the answer lands in `sessionRepos`. */
  askSessionRepo: (chatId: string) => boolean
  /** The whole-Session diff; the answer lands in `sessionDiffs`. */
  askSessionDiff: (chatId: string, ignoreWhitespace: boolean) => boolean
  /** Commits exactly these uncommitted Session files of one folder. An empty message asks Manor to write one. */
  commitSession: (chatId: string, root: string, files: string[], message: string, requestId: string) => boolean
  /** Pushes that folder's current branch, never forced. */
  pushSession: (chatId: string, root: string, requestId: string) => boolean
  /** Opens one of this Session's folders in an app on the Manor host. */
  openSessionFolder: (chatId: string, root: string, app: RepoFileApp) => boolean
  askProjectCheckout: (projectId: string) => boolean
  /**
   * The whole desired membership of a group, add and remove in one write. Groups
   * only: a DM's single member is what the DM is. The directory that follows is
   * authoritative, so nothing here is applied optimistically.
   */
  setChatMembers: (chatId: string, memberIds: string[]) => boolean
  deleteProject: (projectId: string, requestId: string) => boolean
  deleteChat: (chatId: string) => void
  /** Moves a project chat into or out of its project archive. */
  setChatArchived: (chatId: string, archived: boolean) => boolean
  /**
   * Puts a chat down, or picks it back up. The row moves in the inbox immediately;
   * the directory broadcast that follows is authoritative, which is also what rolls
   * a write back that never landed.
   */
  setChatSettled: (chatId: string, settled: boolean) => boolean
  /** Accepts Work and resolves after the server confirms preparation and kickoff. */
  acceptWorkHandoff: (handoffId: string, options: WorkAcceptanceOptions) => Promise<string>
  /** Opts a project into its curated thread; resolves with the thread's chat id (2026-10-10). */
  createProjectThread: (projectId: string) => Promise<string>
  /** Archives the thread and keeps its files; refused while a session it started is open. */
  removeProjectThread: (projectId: string) => Promise<void>
  /** A folder to start Sessions in, without a project thread; resolves on its project id. */
  addFolder: (path: string) => Promise<string>
  /** Takes a folder off the new-Session picker. Its Sessions keep it. */
  removeFolder: (projectId: string) => Promise<void>
  rejectWorkHandoff: (handoffId: string) => boolean
  /** The user agrees a goal Session's lead reached the goal. */
  confirmWorkGoal: (handoffId: string, mergeInto?: string, version?: number, requestId?: string) => boolean
  /** Sends feedback on a reported result back to the same Session. */
  reviseWorkGoal: (handoffId: string, version: number, text: string, requestId?: string) => boolean
  /** Runs a blocked commit or merge again under the Confirm that approved it. */
  retryWorkCompletion: (handoffId: string, requestId?: string) => boolean
  /** The user approves the conflict fix Manor holds before it merges a confirmed Session. */
  approveMergeFix: (handoffId: string, tip: string, requestId?: string) => boolean
  /**
   * Create when the draft has no id, update when it has one. The answer is a new
   * roster for every client, or a notice to this one and a household unchanged.
   * Both return false when the socket was down and nothing went out, because the
   * dialog above them shows a pending state and a pending state must not lie.
   * `interview` on a create opens the new agent's DM on the interview that writes its
   * instructions.
   */
  saveAgent: (agent: AgentDraft, requestId: string, interview?: boolean) => boolean
  deleteAgent: (agentId: string, requestId: string) => boolean
  saveMcpServer: (server: McpServerDraft, requestId: string) => boolean
  verifyMcpServer: (serverId: string, requestId: string) => boolean
  /** Tests Manor's managed mymind key pair through a read-only API endpoint. */
  verifyMyMind: () => boolean
  deleteMcpServer: (serverId: string, requestId: string) => boolean
  /**
   * Create when the draft has no id, update when it has one. The answer is the whole
   * routines list for every client, or a notice to this one and nothing changed.
   */
  saveRoutine: (routine: RoutineDraft, requestId: string) => boolean
  deleteRoutine: (routineId: string, requestId: string) => boolean
  /**
   * On or off, as its own write rather than a save the view assembles: two clients
   * flipping one routine must not be able to compose into a routine neither asked for.
   */
  setRoutineEnabled: (routineId: string, enabled: boolean) => boolean
  /** Fires a routine outside its schedule. The server refuses one that is off. */
  runRoutineNow: (routineId: string) => boolean
  /**
   * Asks for one routine's run history, which is derived from its run threads or
   * its DM rather than pushed with the routines list. Reply-only, so asking twice is
   * harmless and the panel refreshes by asking again.
   */
  getRoutineRuns: (routineId: string) => boolean
  /** Asks for one DM's file library; the answer lands in `workspace.dmFiles`. */
  getDmFiles: (chatId: string) => boolean
  /** Read means shown: marks runs whose result is on screen. The dot goes at once. */
  markRoutineRunsRead: (routineId: string, runIds: readonly string[]) => boolean
  markAllRoutineRunsRead: () => boolean
  /** Refreshes importable SKILL.md files from the server's Claude and Codex homes. */
  listSkillCandidates: () => boolean
  /** Reads the proposal ledger in the memory folder of this Manor host. */
  listWorkflowSuggestions: () => boolean
  /** Asks for Composio's app catalogue and this host's connected accounts. */
  listComposioApps: () => boolean
  /** Opens a fresh sign-in for one app under one alias; the page follows it live. */
  connectComposioApp: (toolkit: string, alias: ComposioAlias, requestId: string) => boolean
  /** Removes the app's accounts under that alias for every agent. */
  disconnectComposioApp: (toolkit: string, alias: ComposioAlias | null, requestId: string) => boolean
  /** Sends the Composio API key once; the server checks it with Composio before it keeps it. */
  setComposioKey: (key: string, requestId: string) => boolean
  /** Removes the key Manor keeps in its data folder. */
  removeComposioKey: (requestId: string) => boolean
  importSkill: (candidateId: string, requestId: string) => boolean
  deleteSkill: (skillId: string, requestId: string) => boolean
  /**
   * The project as it should now read, name, appearance and folders together, because
   * the dialog above it is one form. The answer is a directory for every client, or a
   * notice to this one and a project unchanged.
   */
  updateProject: (
    projectId: string,
    name: string,
    repoPaths: string[],
    icon: ProjectIcon,
    color: string,
    memoryScope: ProjectMemoryScope,
    requestId: string,
  ) => boolean
  /** Walks the server's filesystem for the folder picker; no path means home. */
  listDirs: (path?: string) => void
  /** Closing a picker: forget the walk so the next one starts at home. */
  closeDirs: () => void
  /**
   * Loads the mentionable files of one project, for the composer's `@` menu. Safe to
   * call again: the answer replaces what is held, so a chat opened after a file was
   * added lists it. No wait flag, because the menu never blocks on this.
   */
  listRepoFiles: (projectId: string, chatId?: string) => void
  /**
   * Asks for the usage report of the last `windowDays` days, broken at this client's
   * midnight; the reply replaces what the view holds. False when the socket was down.
   */
  loadUsageReport: (windowDays: UsageWindowDays) => boolean
  /** Asks every provider for a fresh subscription reading; it arrives as `providerUsage`. */
  refreshProviderUsage: () => boolean
  /**
   * Starts provider CLI updates on the host, one provider or every one that can.
   * Progress arrives as `workspace.providerUpdates`. False when the socket was down.
   */
  updateProviders: (provider?: ProviderUpdate['provider']) => boolean
  /** Asks every provider CLI again whether it is installed and signed in; the answer is `workspace.providerConnections`. */
  checkProviders: () => boolean
  /** Starts the provider's own sign-in on the Mac, which opens the browser there. */
  signInProvider: (provider: ProviderUpdate['provider']) => boolean
  /** Stops waiting for a sign-in that was started and abandoned. */
  cancelProviderSignIn: (provider: ProviderUpdate['provider']) => boolean
  installProvider: (provider: ProviderUpdate['provider']) => boolean
  /** Asks for the Auto mode rule file; the answer lands in `workspace.autoRules`. */
  requestAutoRules: () => void
  /**
   * Replaces the Auto rule file whole. Same request contract as `saveAgent`: an ack
   * on success, a notice with the refused rule's reason otherwise.
   */
  saveAutoRules: (rules: AutoRulesDraft, requestId: string) => boolean
  /** Loads or searches the read-only mymind library. */
  listMyMindObjects: (query?: string) => boolean
  /** Pulls the next streamed page for the active mymind listing. */
  loadMoreMyMindObjects: () => boolean
  /** Reads one path from that listing. Returns false when no request left the browser. */
  readRepoFile: (projectId: string, path: string, chatId?: string) => boolean
  /**
   * Saves one of those files back. `baseRevision` is the hash the panel read, which
   * the server refuses to write over when disk has moved since. There is no create
   * here, unlike the vault: the server only accepts paths its own listing offered.
   */
  writeRepoFile: (
    projectId: string,
    path: string,
    content: string,
    baseRevision: string,
    chatId?: string,
  ) => boolean
  /** Opens one listed repository file in an app advertised by this host. */
  openRepoFile: (projectId: string, path: string, app: RepoFileApp, chatId?: string) => boolean
  /** Drops the last save's answer, for a panel that has moved past what it said. */
  clearRepoWrite: (projectId: string, chatId?: string) => void
  /**
   * Every note in the vault. Asked when the Knowledge tab opens rather than pushed
   * with the directory: the tab may never be opened in a session, and the listing is
   * a walk of the whole folder. Safe to call again; the answer replaces what is held.
   */
  listVault: () => void
  createVaultFolder: (path: string) => boolean
  /** Moves a note or folder to Manor's trash. False when the socket is down. */
  deleteVaultEntry: (requestId: string, path: string) => boolean
  renameVaultFile: (requestId: string, path: string, newPath: string, baseRevision: string) => boolean
  /**
   * Moves a note or folder into `folder` (`''` is the top level). `notify` shows a refusal
   * in the app's notice, for a drop with no dialog. False when nothing left the browser.
   */
  moveVaultEntry: (requestId: string, path: string, folder: string, notify: boolean) => boolean
  /** Opens one note. Returns false when no request left the browser. */
  readVaultFile: (path: string) => boolean
  /**
   * Saves one note. `baseRevision` is the hash the editor read, which the server
   * refuses to write over when disk has moved since; `null` means create, and is
   * refused if the path already exists. Returns false when nothing went out.
   */
  writeVaultFile: (path: string, content: string, baseRevision: string | null) => boolean
  /** Drops the last save's answer, for an editor that has moved past what it said. */
  clearVaultWrite: () => void
  /**
   * Asks for one AI edit of a note's text: the replacement for `selection`, or the
   * whole edited note without one. The answer lands in `vault.noteEdits` under
   * `requestId` and is a proposal; nothing is written. False when nothing went out.
   */
  editVaultNote: (requestId: string, note: string, selection: { from: number; to: number } | null, instruction: string) => boolean
  /** Ends the wait for that edit: the job stops, and an answer already here is dropped. */
  forgetVaultNoteEdit: (requestId: string, cancel: boolean) => void
  /** Closes the open note. */
  closeVaultNote: () => void
  /**
   * Asks the Mac for a fresh Reminders snapshot. The Reminders door calls it on open, on
   * window focus and on a timer; an answer that changed nothing repaints nothing.
   */
  loadReminders: () => boolean
  /** One page of completed reminders, newest first, from `offset`. */
  loadCompletedReminders: (offset: number) => boolean
  /**
   * One write to Apple Reminders. The server broadcasts the fresh snapshot, then answers
   * `requestId` with an ack or a notice. False when nothing left the browser.
   */
  writeReminder: (requestId: string, action: ReminderWrite) => boolean
  /** Drops the server's last notice, for a UI that has moved past what it answered. */
  dismissNotice: () => void
  /**
   * Opens a website through a browser capability advertised by this host. False
   * leaves the anchor untouched, which is the VPS, mobile and disconnected fallback.
   */
  openExternalUrl: (url: string) => boolean
  /**
   * Pin a model/effort for one agent in the open chat, for this chat only. The
   * override sent replaces what the server holds; an empty one clears the pin.
   * The answer is a `chat_overrides` broadcast, so the control never has to
   * guess whether its click landed.
   */
  setChatOverride: (agentId: string, override: ChatOverride, chatId?: string) => boolean
}

/**
 * The create as it goes on the wire. Pure, because the three targets differ only in
 * these few fields and getting one of them wrong is invisible until the server
 * refuses it: a project chat carries no `kind`, and a home chat carries no
 * `projectId` at all rather than a null one.
 *
 * A DM's chat is made here, by its first send, and not by the click that opened the
 * stage: the server keeps one DM per persona, so an opening message is what turns a
 * name in the list into a conversation.
 */
export { createChatMessage } from '@manor/client-runtime/commands'

/** The request prefix that marks a create as a Browser session, which must not take the stage. */
/** The host beats every 15s; a value older than two beats is no longer evidence. */
const PRESENCE_REPLAY_MS = 30_000
const BROWSER_SESSION_REQUEST = 'browser-session-'

/**
 * Owns the socket lifecycle for the whole workspace. Every server message goes
 * through the pure reducer; the hook itself only decides when to connect, what
 * to re-request, and which freshly created chat to open.
 */
export function useWorkspace(url: string, auth?: WorkspaceAuth): Manor {
  // Outside React: a text frame changes the store, and only its live readers render.
  const storeRef = useRef<WorkspaceStore | null>(null)
  if (storeRef.current === null) storeRef.current = createWorkspaceStore(emptyWorkspace)
  const store = storeRef.current
  const { update: applyWorkspace } = store
  const workspace = useSyncExternalStore(store.subscribe, store.quiet, store.quiet)
  const [status, setStatus] = useState<ConnectionStatus>('connecting')
  const myMindRequestId = useRef<string | null>(null)
  const requestListeners = useRef(new Set<(response: RequestResponse) => boolean | void>())
  const workAcceptance = useRef(createWorkAcceptance())
  const overrideRequests = useRef(new Map<string, string>())
  const requestEventsRef = useRef<RequestEvents | null>(null)
  if (requestEventsRef.current === null) {
    requestEventsRef.current = {
      subscribe: (listener) => {
        requestListeners.current.add(listener)
        return () => requestListeners.current.delete(listener)
      },
    }
  }
  /**
   * Server messages wait here for the next animation frame and are then reduced as
   * one batch, so a persona streaming at 40 to 80 deltas a second costs one render
   * per frame rather than one per delta. Arrival order is kept, and the reducer is
   * untouched: it still sees exactly the messages it always did, in order.
   */
  const framesRef = useRef<FrameQueue<ServerMessage> | null>(null)
  /**
   * Chats that finished during the fold, waiting to be announced. Queued here
   * rather than announced in place because the fold runs inside a state updater,
   * which React is free to run twice; the effect below is where exactly-once lives.
   */
  const donePings = useRef<DonePing[]>([])
  const sentPings = useRef(new Set<string>())
  if (framesRef.current === null) {
    framesRef.current = createFrameQueue<ServerMessage>(
      (batch) => {
        const now = Date.now()
        applyWorkspace((current) => {
          // Not `batch.reduce(reduce, …)`: `Array.reduce` would pass the index
          // straight into the reducer's `now` parameter and date every event to the
          // epoch. Stepped by hand anyway, because a done notice is decided from the
          // state on either side of the one message that ended the run.
          let state = current
          for (const msg of batch) {
            const before = state
            state = reduce(state, msg)
            const ping = noticePing(before, state, msg, now)
            if (ping !== null) donePings.current.push(ping)
          }
          return state
        })
      },
      animationFrames,
      // The end of a run cannot wait for a frame that is not coming. Every other
      // message here is a repaint, and a repaint nobody can see is worth batching;
      // this one is the notification's trigger, and the whole point of the
      // notification is that the window is behind something else. A persona stopping
      // to ask is the same kind of trigger.
      (msg) => (msg.type === 'turn_state' && msg.state !== 'running')
        || (msg.type === 'event' && msg.event.type === 'user_input_request'),
    )
  }
  /**
   * Every state change that is *not* a server message. It empties the queue first, so
   * anything the socket said before this call is already folded in: without that, a
   * snapshot still waiting in the queue would land after a chat switch and reopen the
   * chat the user just left.
   */
  const setWorkspace = useCallback((change: (state: WorkspaceState) => WorkspaceState) => {
    framesRef.current?.flush()
    applyWorkspace(change)
  }, [])
  const socketRef = useRef<WorkspaceConnection | null>(null)
  const externalBrowserRef = useRef<'dia' | null>(null)
  /**
   * Who is driving each chat's shared browser this instant. Deliberately outside
   * `workspace`: it is not durable chat state, it is true only for this host, and a
   * second Manor window has no browser to speak for. Where each browser *is* lives
   * in the desktop host and reaches the panel by its own push, so it is not mirrored
   * here — one copy of that fact, in the process that owns it.
   */
  const [browserActivity, setBrowserActivity] = useState<Record<string, BrowserActivity>>({})
  const [browserUse, setBrowserUse] = useState<Record<string, BrowserActivity>>({})
  /** First use stays pending per chat until that chat is actually on screen. */
  const [browserAttention, setBrowserAttention] = useState<ReadonlySet<string>>(() => new Set())
  const [createdBrowserSession, setCreatedBrowserSession] = useState<string | null>(null)
  const browserChats = useRef(new Set<string>())
  const browserDestinations = useRef(new Set<string>())
  const [externalBrowser, setExternalBrowser] = useState<'dia' | null>(null)
  const [repoFileApps, setRepoFileApps] = useState<RepoFileApp[]>([])
  // Held in a ref, not a dependency: only the session key below reconnects.
  const authRef = useRef(auth)
  authRef.current = auth
  const sessionKey = auth?.sessionKey ?? ''
  // Mirrors of state the socket callbacks need without re-opening the socket.
  const openIdRef = useRef<string | null>(null)
  const pendingIdRef = useRef<string | null>(null)
  const resumeChatIdsRef = useRef<readonly string[]>([])
  const chatsRef = useRef(workspace.chats)
  chatsRef.current = workspace.chats
  const threadsRef = useRef(workspace.threads)
  threadsRef.current = workspace.threads

  useEffect(() => {
    openIdRef.current = workspace.openChatId
    pendingIdRef.current = workspace.pendingChatId
  }, [workspace.openChatId, workspace.pendingChatId])

  /**
   * Hands what finished to the desktop host, which drops it again if the window has
   * focus. Anything queued implies the state it was folded from changed, so this
   * effect is always reached with the queue still fresh. Without a host — a plain
   * browser tab, or a shell older than the bridge — the queue is emptied and nothing
   * is shown, deliberately: there is no page-level fallback.
   */
  useEffect(() => {
    if (donePings.current.length === 0) return
    const pings = donePings.current
    donePings.current = []
    const notify = desktopNotify()
    if (notify === undefined) return
    for (const ping of unsentPings(pings, sentPings.current)) {
      const { chatId, title, body } = ping
      // A host that cannot show a banner must not take the renderer down with it.
      // Loud rather than swallowed, for the same reason a dropped send is: the whole
      // failure mode of this feature is silence, and a silence with no console line
      // behind it costs a debugging session to tell from a rule that simply refused.
      void notify.show({ chatId, title, body }).catch((error: unknown) => {
        console.warn('manor: the desktop host refused a done notice', chatId, error)
      })
    }
  }, [workspace])

  /**
   * The dock count, pushed only when it moves. Every streamed delta produces a new
   * workspace, and an unchanged number sent sixty times a second is IPC nobody asked
   * for; `-1` is the start value so the first real count, zero included, still goes.
   */
  const badgeRef = useRef(-1)
  useEffect(() => {
    const notify = desktopNotify()
    if (notify === undefined) return
    const count = doneCount(workspace)
    if (count === badgeRef.current) return
    badgeRef.current = count
    void notify.badge(count).catch((error: unknown) => {
      console.warn('manor: the desktop host refused the dock count', count, error)
    })
  }, [workspace])

  /**
   * The Mac's presence, relayed so the server can hold phone pushes while the user is at
   * it. Straight to the socket rather than through `send`: heartbeats while offline
   * are expected, not a dropped command. A fresh `true` is replayed on open so a
   * reconnect does not wait a beat to be heard; an older one is not, because replaying
   * it would revive presence the host stopped vouching for.
   */
  const presenceRef = useRef<{ active: boolean; at: number } | null>(null)
  useEffect(() => desktopPresence()?.onChange((active) => {
    presenceRef.current = { active, at: Date.now() }
    socketRef.current?.send({ type: 'desktop_presence', active })
  }), [])

  const send = useCallback((msg: ClientMessage) => {
    if (socketRef.current?.send(msg) !== true) {
      // Loud on purpose: a silently dropped send is how the zombie-socket bug
      // stayed invisible for a whole debugging session.
      console.warn('manor: dropped a send, no open socket', msg.type)
      return false
    }
    return true
  }, [])
  const commands = useMemo(() => createWorkspaceCommands(send, setWorkspace), [send, setWorkspace])
  // Built once per socket, so each is as stable as a `useCallback` over `send`.
  const { stopTurn, stopBackground, stopSubagent, answerUserInput, answerSecretRequest, changeSessionAnswer, submitOutboundDraft, discardOutboundDraft, snoozeOutboundDraft, ignoreOutboundDraft, restoreOutboundDraft } = commands
  const openSubagentThread = useCallback(
    (childId: string, parentId: string) =>
      void commands.openSubagentThread(childId, parentId, threadsRef.current[childId], socketRef.current?.holds(childId) === true, socketRef.current?.syncOf(childId)),
    [commands],
  )
  const readOutboundThread = useCallback(
    (chatId: string, draftId: string) => commands.readOutboundThread(chatId, draftId, `outbound-thread-${crypto.randomUUID()}`),
    [commands],
  )

  useEffect(() => {
    const browserCursors = new BrowserCursorLifecycle(desktopBrowser, (chatId) => {
      setBrowserUse((current) => omit(current, chatId))
    }, (chatId) => chatsRef.current.find((chat) => chat.id === chatId)?.kind === 'browser' ? BROWSER_HOME_SESSION_ID : chatId)
    const connection = createWorkspaceConnection({
      url,
      auth: {
        getToken: () => authRef.current?.getToken() ?? null,
        onRejected: () => authRef.current?.onRejected?.(),
      },
      sockets: {
        openState: WebSocket.OPEN,
        create: (target) => new WebSocket(target) as unknown as SocketAdapter,
      },
      onStatus: setStatus,
      onOpen: () => {
        externalBrowserRef.current = null
        setExternalBrowser(null)
        setRepoFileApps([])
        // Every running dot starts dark on a fresh socket. A turn that ended while
        // this client was offline was announced to nobody, and only the chat below
        // gets a snapshot; a chat still working re-lights its own dot on its next
        // frame, so the sidebar converges to truth either way.
        setWorkspace(clearRunningTurns)
        const heard = presenceRef.current
        if (heard !== null && Date.now() - heard.at < PRESENCE_REPLAY_MS) {
          socketRef.current?.send({ type: 'desktop_presence', active: heard.active })
        }
        if (desktopBrowser() !== undefined) {
          send({ type: 'browser_host_ready', ...(desktopComputer() === undefined ? {} : { computerStop: true as const }) })
        }
        // The server has no memory of what this client was reading. The focused
        // thread first, then any other pane still on screen, so a split's second
        // transcript does not stay stale until it is clicked.
        const reopen = pendingIdRef.current ?? openIdRef.current
        const resume: string[] = []
        if (reopen !== null) resume.push(reopen)
        for (const id of resumeChatIdsRef.current) {
          if (!resume.includes(id)) resume.push(id)
        }
        // A new socket holds nothing. A copy that knows its rewrite position still asks only for what it missed.
        for (const chatId of resume) send(openChatRequest(chatId, threadsRef.current[chatId], false, socketRef.current?.syncOf(chatId)))
      },
      onClose: () => {
        // The server can no longer disarm Escape through this socket, so the shell
        // posts the stop itself and lets go of Escape only once it has landed.
        void desktopComputer()?.connectionLost?.()
        browserCursors.disconnect()
        workAcceptance.current.cancel()
        externalBrowserRef.current = null
        setRepoFileApps([])
        overrideRequests.current.clear()
      },
      onInvalidMessage: () => console.warn('manor: server message failed the contract'),
      onMessage: (parsed) => {
        browserCursors.receive(parsed)
        workAcceptance.current.receive(parsed)
        // The palette's answer goes to the palette that asked; workspace state never holds it.
        if (parsed.type === 'search_results') {
          for (const listener of requestListeners.current) listener(parsed)
          return
        }
        if ((parsed.type === 'project_memory' || parsed.type === 'chat_summary' || parsed.type === 'agent_notes') && parsed.requestId !== undefined) {
          const response: RequestResponse = { ...parsed, requestId: parsed.requestId }
          for (const listener of requestListeners.current) listener(response)
        }
        // Sent to its creator just ahead of the ack, so the form that asked knows which
        // project it made by the time that ack closes it.
        if (parsed.type === 'project_created' && parsed.requestId !== undefined) {
          const response: RequestResponse = { ...parsed, requestId: parsed.requestId }
          for (const listener of requestListeners.current) listener(response)
        }
        // Answers skip the frame queue, so fold in what arrived before them first: a
        // listener that drops an optimistic copy on the answer must see the state the
        // server sent ahead of it in the same render, not a frame later.
        if (parsed.type === 'ack' || (parsed.type === 'notice' && parsed.requestId !== undefined)) framesRef.current?.flush()
        if (parsed.type === 'ack') {
          const chatId = overrideRequests.current.get(parsed.requestId)
          if (chatId !== undefined) {
            overrideRequests.current.delete(parsed.requestId)
            setWorkspace((current) => settleChatOverride(current, chatId, parsed.requestId))
          }
          for (const listener of requestListeners.current) listener(parsed)
          return
        }
        if (parsed.type === 'notice' && parsed.requestId !== undefined) {
          const requestId = parsed.requestId
          const chatId = overrideRequests.current.get(requestId)
          if (chatId !== undefined) {
            overrideRequests.current.delete(requestId)
            setWorkspace((current) => settleChatOverride(current, chatId, requestId))
          }
          const response: RequestResponse = { ...parsed, requestId }
          let inPlace = false
          for (const listener of requestListeners.current) if (listener(response) === true) inPlace = true
          // Shown where it was asked, as a refused Undo is on its own line: no toast as well.
          if (inPlace) return
        }
        if (parsed.type === 'browser_tool_request') {
          // The request and its result bracket exactly the moment the page is not
          // The user's, which is the same moment the desktop host holds its input.
          const { chatId, actor, tool, turnId } = parsed
          const stillUsing = browserCursors.begin(chatId, actor.id, turnId)
          setBrowserUse((current) => ({ ...current, [chatId]: { agentId: actor.id, agentName: actor.name, tool } }))
          const reveal = browserRevealAction(
            browserChats.current.has(chatId), browserDestinations.current.has(chatId), tool, parsed.arguments,
          )
          if (reveal === 'prepare') browserDestinations.current.add(chatId)
          setBrowserActivity((current) => ({
            ...current,
            [chatId]: { agentId: actor.id, agentName: actor.name, tool },
          }))
          void (async () => {
            const browser = desktopBrowser()
            try {
              await browser?.beginAgentUse?.(chatId)
            } catch {
              // Lifetime is optional. The tool still has to answer.
            }
            const reply = stillUsing()
              ? await answerBrowserTool(parsed, browser, stillUsing)
              : { type: 'browser_tool_result' as const, requestId: parsed.requestId, ok: false as const, error: 'Browser agent use stopped.' }
            if (reply.ok) {
              if (reveal === 'prepare') browserChats.current.add(chatId)
              if (reveal === 'reveal') {
                browserChats.current.add(chatId)
                browserDestinations.current.delete(chatId)
                setBrowserAttention((current) => addBrowserAttention(current, chatId))
              }
            } else if (reveal === 'prepare') browserDestinations.current.delete(chatId)
            browserCursors.finish(stillUsing)
            setBrowserActivity((current) => omit(current, chatId))
            send(reply)
          })()
          return
        }
        if (parsed.type === 'computer_stop_armed') {
          // The server holds the first action until this answer says Escape works.
          const { stopToken, stopUrl } = parsed
          const stop = stopToken === undefined || stopUrl === undefined ? undefined : { token: stopToken, url: stopUrl }
          const arming = desktopComputer()?.setStopArmed(parsed.armed, stop) ?? Promise.reject(new Error('No stop bridge.'))
          const { armId } = parsed
          if (armId !== undefined) {
            void arming.then(
              () => { send({ type: 'computer_stop_ack', armId, ok: true }) },
              () => { send({ type: 'computer_stop_ack', armId, ok: false }) },
            )
          } else void arming.catch(() => undefined)
          return
        }
        if (parsed.type === 'browser_session_close') {
          const { chatId } = parsed
          browserChats.current.delete(chatId)
          browserDestinations.current.delete(chatId)
          setBrowserActivity((current) => omit(current, chatId))
          setBrowserAttention((current) => consumeBrowserAttention(current, chatId))
          void desktopBrowser()?.close(chatId)
          return
        }
        if (parsed.type === 'host_capabilities') {
          externalBrowserRef.current = parsed.externalBrowser
          setExternalBrowser(parsed.externalBrowser)
          setRepoFileApps(parsed.repoFileApps ?? [])
          // Whether the Reminders door can work is workspace state; the reducer keeps it.
          framesRef.current?.push(parsed)
          return
        }
        if (parsed.type === 'side_chat') {
          // The panel's thread is in no directory and nothing has ever opened it, so
          // this is where its events are asked for. Only while the chat it hangs off
          // is still the one on screen: a reply that arrives after the user has moved
          // on is a snapshot nobody is showing, and the panel asks again when it is.
          const { parentChatId } = parsed
          if (parentChatId === openIdRef.current || parentChatId === pendingIdRef.current) {
            send({ type: 'open_chat', chatId: parsed.chatId })
            framesRef.current?.push(parsed)
            // Marked after the push, and `setWorkspace` empties the queue first, so the
            // mark lands on the thread the message above just filed. A thread already on
            // screen — this is a reconnect re-reading it — says it is waiting, because
            // the snapshot on its way clears everything sent in the meantime.
            setWorkspace((current) => askThread(current, parsed.chatId))
            return
          }
          framesRef.current?.push(parsed)
          return
        }
        if (parsed.type === 'chat_created') {
          // Creator-only and exact. A broadcast directory can contain somebody
          // else's concurrent create, so diffing ids cannot answer this question.
          if (parsed.requestId?.startsWith(BROWSER_SESSION_REQUEST) === true) {
            send({ type: 'open_chat', chatId: parsed.chatId })
            setWorkspace((current) => askThread(current, parsed.chatId))
            setCreatedBrowserSession(parsed.chatId)
            return
          }
          setWorkspace((current) => selectChat(current, parsed.chatId))
          send({ type: 'open_chat', chatId: parsed.chatId })
          return
        }
        framesRef.current?.push(parsed)
      },
    })
    socketRef.current = connection

    return () => {
      if (socketRef.current === connection) socketRef.current = null
      workAcceptance.current.cancel()
      browserCursors.disconnect()
      connection.dispose()
      // Whatever the dying socket said in the last frame still counts. A dropped
      // `turn_result` here would leave a finished turn spinning until the next one.
      // This covers unmount as well as a reconnect, so the queue needs no teardown of
      // its own; one that could be shut for good would be shut by StrictMode's
      // mount-time cleanup and never speak again.
      framesRef.current?.flush()
    }
  }, [url, sessionKey, send])

  const openChat = useCallback(
    (chatId: string) => {
      const alreadyOpen = openIdRef.current === chatId && pendingIdRef.current === null
      setWorkspace((current) => selectChat(current, chatId))
      if (!alreadyOpen) send(openChatRequest(chatId, threadsRef.current[chatId], socketRef.current?.holds(chatId) === true, socketRef.current?.syncOf(chatId)))
    },
    [send],
  )

  const loadChat = useCallback(
    (chatId: string) => {
      send(openChatRequest(chatId, threadsRef.current[chatId], socketRef.current?.holds(chatId) === true, socketRef.current?.syncOf(chatId)))
      setWorkspace((current) => askThreadInBackground(current, chatId))
    },
    [send],
  )

  const clearChat = useCallback(() => {
    setWorkspace(clearChatSelection)
  }, [setWorkspace])

  const setResumeChats = useCallback((chatIds: readonly string[]) => {
    resumeChatIdsRef.current = chatIds
  }, [])

  const setViewedChats = useCallback((chatIds: readonly string[]) => {
    setWorkspace((current) => applyViewedChats(current, chatIds))
  }, [])

  const sendToChat = useCallback(
    (
      chatId: string,
      text: string,
      attachments: ComposerAttachments,
      pageContexts: PageContextAttachment[] = [],
      replyTo?: MessageReply,
      quotes?: InlineQuote[],
    ) => {
      const { images, files, documents } = attachments
      const sent = send({
        type: 'send_message',
        chatId,
        text,
        images,
        files,
        ...(documents.length === 0 ? {} : { documents }),
        pageContexts,
        ...(replyTo === undefined ? {} : { replyTo }),
        ...(quotes?.length ? { quotes } : {}),
      })
      // Only a send that actually left gets a bubble. The composer clears itself on
      // a true return, so a bubble for a dropped send would be the only copy of a
      // message nobody has.
      if (sent) setWorkspace((current) => sendingUserMessage(current, chatId, text, {
        images,
        files,
        documents,
        pageContexts,
        ...(replyTo === undefined ? {} : { replyTo }),
        ...(quotes?.length ? { quotes } : {}),
      }))
      return sent
    },
    [send],
  )

  const openSideChat = useCallback(
    (parentChatId: string, fresh = false) =>
      send({ type: 'open_side_chat', chatId: parentChatId, ...(fresh ? { fresh } : {}) }),
    [send],
  )

  // No optimistic write: the server resolves the pick (it refuses a model no CLI
  // offers) and echoes it back, so the label always says what the next turn will
  // actually run on rather than what was clicked.
  const setSideRuntime = useCallback(
    (chatId: string, model: string, effort: Effort) =>
      send({ type: 'set_side_runtime', chatId, model, effort }),
    [send],
  )

  // Same optimistic bubble as the footer's send, for the same reason: the server only
  // writes a user message down when its turn runs, and a question asked while the last
  // answer is still streaming would otherwise vanish until that turn ends.
  const sendSideMessage = useCallback(
    (chatId: string, text: string, images: ImageAttachment[], quotes?: InlineQuote[]) => {
      const sent = send({
        type: 'send_message',
        chatId,
        text,
        images,
        ...(quotes?.length ? { quotes } : {}),
      })
      if (sent) setWorkspace((current) => sendingUserMessage(current, chatId, text, {
        images,
        ...(quotes?.length ? { quotes } : {}),
      }))
      return sent
    },
    [send, setWorkspace],
  )

  const requestSubagentPolicy = useCallback(() => {
    send({ type: 'get_subagent_policy' })
  }, [send])

  const saveSubagentPolicy = useCallback(
    (policy: SubagentPolicy, requestId?: string) => {
      setWorkspace(clearNotice)
      return send({ type: 'save_subagent_policy', policy, ...(requestId === undefined ? {} : { requestId }) })
    },
    [send, setWorkspace],
  )

  const saveProfile = useCallback(
    (profile: UserProfile, requestId?: string) => {
      setWorkspace(clearNotice)
      return send({ type: 'save_profile', profile, ...(requestId === undefined ? {} : { requestId }) })
    },
    [send, setWorkspace],
  )

  const saveHouseSettings = useCallback(
    (settings: HouseSettings, requestId?: string) => {
      setWorkspace(clearNotice)
      return send({ type: 'save_house_settings', settings, ...(requestId === undefined ? {} : { requestId }) })
    },
    [send, setWorkspace],
  )

  const requestContextFiles = useCallback(() => {
    send({ type: 'get_context_files' })
  }, [send])

  const saveContextFile = useCallback(
    (name: ContextFileName, content: string, baseHash: string, requestId?: string) => {
      setWorkspace(clearNotice)
      return send({ type: 'save_context_file', name, content, baseHash, ...(requestId === undefined ? {} : { requestId }) })
    },
    [send, setWorkspace],
  )

  const requestSystemInfo = useCallback(() => {
    send({ type: 'get_system_info' })
  }, [send])

  const requestPhoneAccess = useCallback(() => {
    send({ type: 'get_phone_access' })
  }, [send])
  const setTailscaleServe = useCallback(
    (on: boolean, requestId?: string) => send({ type: 'set_tailscale_serve', on, ...(requestId === undefined ? {} : { requestId }) }),
    [send],
  )
  const createPairingLink = useCallback(
    (requestId?: string) => send({ type: 'create_pairing_link', ...(requestId === undefined ? {} : { requestId }) }),
    [send],
  )
  const revokeDevice = useCallback(
    (deviceId: string, requestId?: string) => send({ type: 'revoke_device', deviceId, ...(requestId === undefined ? {} : { requestId }) }),
    [send],
  )

  const revealLog = useCallback((path: string) => send({ type: 'reveal_log', path }), [send])
  const revealFolder = useCallback((folder: 'memory' | 'knowledge') => send({ type: 'reveal_folder', folder }), [send])

  const openConnectCard = useCallback(
    (chatId: string, connectId: string) => send({ type: 'open_connect_card', chatId, connectId }),
    [send],
  )

  const openExternalUrl = useCallback(
    (url: string) =>
      externalBrowserRef.current === 'dia' && send({ type: 'open_external_url', url }),
    [send],
  )

  const openRepoFile = useCallback(
    (projectId: string, path: string, app: RepoFileApp, chatId?: string) =>
      send({ type: 'open_repo_file', projectId, path, app, ...(chatId === undefined ? {} : { chatId }) }),
    [send],
  )

  const getProjectMemory = useCallback(
    (projectId: string, requestId: string) => send({ type: 'get_project_memory', projectId, requestId }),
    [send],
  )

  const getChatSummary = useCallback(
    (chatId: string, requestId: string) => send({ type: 'get_chat_summary', chatId, requestId }),
    [send],
  )
  const getAgentNotes = useCallback(
    (agentId: string, requestId: string) => send({ type: 'get_agent_notes', agentId, requestId }),
    [send],
  )
  const undoMemoryWrite = useCallback(
    (chatId: string, writeId: string, requestId: string) => send({ type: 'undo_memory_write', chatId, writeId, requestId }),
    [send],
  )

  // Asking again clears the previous answer first, exactly like updateProject: the
  // old rejection belonged to the folder that was picked before this one.
  const createProject = useCallback(
    (name: string, repoPaths: string[], icon: ProjectIcon, color: string, memoryScope: ProjectMemoryScope, requestId: string, threadRuntime?: ChatOverride) => {
      setWorkspace(clearNotice)
      return send({ type: 'create_project', name, repoPaths, icon, color, memoryScope, requestId, ...(threadRuntime === undefined ? {} : { threadRuntime }) })
    },
    [send],
  )

  const listDirs = useCallback(
    (path?: string) => {
      commands.listDirs(path)
    },
    [commands],
  )

  const closeDirs = useCallback(() => setWorkspace(forgetDirs), [])

  // The stage and the chat pane each ask for the open chat's listing and checkout in
  // the same commit. One answer reaches both, so an identical read already sent in this
  // task is not sent again: the second `git ls-files` or `git status` only competed with
  // the first one for the same reply.
  const askedThisTask = useRef(new Set<string>())
  const sendRead = useCallback((msg: ClientMessage) => {
    const key = JSON.stringify(msg)
    if (askedThisTask.current.has(key)) return true
    const sent = send(msg)
    if (sent) {
      if (askedThisTask.current.size === 0) setTimeout(() => askedThisTask.current.clear(), 0)
      askedThisTask.current.add(key)
    }
    return sent
  }, [send])

  const listRepoFiles = useCallback(
    (projectId: string, chatId?: string) => {
      sendRead({
        type: 'list_repo_files',
        projectId,
        ...(chatId === undefined ? {} : { chatId }),
      })
    },
    [sendRead],
  )

  // No optimistic "asking" state. The view keeps the previous report on screen while a
  // fresh one is in flight, because numbers that are still true beat a spinner over
  // them; only the very first open has nothing to show.
  const loadUsageReport = useCallback(
    (windowDays: UsageWindowDays) =>
      send({ type: 'get_usage_report', windowDays, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
    [send],
  )

  const refreshProviderUsage = useCallback(() => send({ type: 'refresh_provider_usage' }), [send])

  const updateProviders = useCallback(
    (provider?: ProviderUpdate['provider']) =>
      send(provider === undefined ? { type: 'update_providers' } : { type: 'update_providers', provider }),
    [send],
  )

  const checkProviders = useCallback(() => send({ type: 'check_providers' }), [send])
  const signInProvider = useCallback((provider: ProviderUpdate['provider']) => send({ type: 'sign_in_provider', provider }), [send])
  const cancelProviderSignIn = useCallback((provider: ProviderUpdate['provider']) => send({ type: 'cancel_provider_sign_in', provider }), [send])
  const installProvider = useCallback((provider: ProviderUpdate['provider']) => send({ type: 'install_provider', provider }), [send])

  const requestAutoRules = useCallback(() => {
    send({ type: 'get_auto_rules' })
  }, [send])

  const saveAutoRules = useCallback(
    (rules: AutoRulesDraft, requestId: string) => {
      setWorkspace(clearNotice)
      return send({ type: 'save_auto_rules', rules, requestId })
    },
    [send],
  )

  const listMyMindObjects = useCallback(
    (query = '') => {
      const normalized = query.trim()
      const requestId = crypto.randomUUID()
      const cancelRequestId = myMindRequestId.current
      const asked = send({
        type: 'list_mymind_objects',
        query: normalized,
        requestId,
        ...(cancelRequestId === null ? {} : { cancelRequestId }),
      })
      if (asked) {
        myMindRequestId.current = requestId
        setWorkspace((current) => askMyMindObjects(current, normalized, requestId))
      }
      return asked
    },
    [send],
  )

  const loadMoreMyMindObjects = useCallback(() => {
    const requestId = myMindRequestId.current
    if (requestId === null) return false
    return commands.loadMoreMyMindObjects(requestId)
  }, [commands])

  const readRepoFile = useCallback(
    (projectId: string, path: string, chatId?: string) => commands.readRepoFile(projectId, path, chatId),
    [commands],
  )

  const writeRepoFile = useCallback(
    (projectId: string, path: string, content: string, baseRevision: string, chatId?: string) => {
      const asked = send({
        type: 'write_repo_file',
        projectId,
        path,
        content,
        baseRevision,
        ...(chatId === undefined ? {} : { chatId }),
      })
      if (asked) setWorkspace((current) => askRepoWrite(current, projectId, path, chatId))
      return asked
    },
    [send],
  )

  const forgetRepoWrite = useCallback(
    (projectId: string, chatId?: string) => setWorkspace((current) => clearRepoWrite(current, projectId, chatId)),
    [],
  )

  const listVault = useCallback(() => {
    send({ type: 'list_vault' })
  }, [send])

  const createVaultFolder = useCallback((path: string) => {
    const asked = send({ type: 'create_vault_folder', path })
    if (asked) setWorkspace((current) => ({ ...current, vault: { ...current.vault, folderWrite: { path, result: null } } }))
    return asked
  }, [send])

  const deleteVaultEntry = useCallback((requestId: string, path: string) => {
    const asked = send({ type: 'delete_vault_entry', requestId, path })
    if (asked) setWorkspace((current) => ({ ...current, vault: { ...current.vault, deletion: { requestId, path, result: null } } }))
    return asked
  }, [send])

  const renameVaultFile = useCallback((requestId: string, path: string, newPath: string, baseRevision: string) => {
    const asked = send({ type: 'rename_vault_file', requestId, path, newPath, baseRevision })
    if (asked) setWorkspace((current) => ({ ...current, vault: { ...current.vault, rename: { requestId, path, newPath, result: null } } }))
    return asked
  }, [send])

  const moveVaultEntry = useCallback((requestId: string, path: string, folder: string, notify: boolean) => {
    const asked = send({ type: 'move_vault_entry', requestId, path, folder })
    if (asked) setWorkspace((current) => ({ ...current, vault: { ...current.vault, move: { requestId, path, folder, notify, result: null } } }))
    return asked
  }, [send])

  const readVaultFile = useCallback((path: string) => commands.readVaultFile(path), [commands])

  const writeVaultFile = useCallback(
    (path: string, content: string, baseRevision: string | null) => {
      const asked = send({ type: 'write_vault_file', path, content, baseRevision })
      // Only a save that actually left marks itself pending. A button that says
      // "Saving…" for a message nobody has is the lying spinner again.
      if (asked) setWorkspace((current) => askVaultWrite(current, path))
      return asked
    },
    [send],
  )

  const forgetVaultWrite = useCallback(() => setWorkspace(clearVaultWrite), [])

  const editVaultNote = useCallback(
    (requestId: string, note: string, selection: { from: number; to: number } | null, instruction: string) =>
      send({ type: 'edit_vault_note', requestId, note, instruction, ...(selection === null ? {} : { selection }) }),
    [send],
  )
  const dropVaultNoteEdit = useCallback((requestId: string, cancel: boolean) => {
    if (cancel) send({ type: 'cancel_vault_note_edit', requestId })
    setWorkspace((current) => forgetVaultNoteEdit(current, requestId))
  }, [send])

  const search = useCallback(
    (query: string, requestId: string) => send({ type: 'search', query, requestId }),
    [send],
  )
  const loadReminders = useCallback(() => send({ type: 'reminders_load' }), [send])
  const loadCompletedReminders = useCallback(
    (offset: number) => send({ type: 'reminders_load_completed', offset }),
    [send],
  )
  const writeReminder = useCallback(
    (requestId: string, action: ReminderWrite) => send({ type: 'reminders_write', requestId, action }),
    [send],
  )
  const closeNote = useCallback(() => setWorkspace(closeVaultNote), [])

  const createChat = useCallback(
    (
      target: NewChatTarget,
      openingMessage?: {
        text: string
        images: ImageAttachment[]
        files?: FileAttachment[]
        documents?: DocumentUpload[]
        pageContexts?: PageContextAttachment[]
        quotes?: InlineQuote[]
      },
      overrides?: Record<string, ChatOverride>,
      checkout?: CheckoutRequest,
      requestId?: string,
    ) => send(createChatMessage(target, openingMessage, overrides, checkout, requestId)),
    [send],
  )

  const createBrowserSession = useCallback(
    (mode: ChatMode) => send(createChatMessage(
      { kind: 'browser', mode }, undefined, undefined, undefined, `${BROWSER_SESSION_REQUEST}${crypto.randomUUID()}`,
    )),
    [send],
  )

  const setChatCheckout = useCallback(
    (chatId: string, checkout: CheckoutRequest) => send({ type: 'set_chat_checkout', chatId, checkout }),
    [send],
  )

  const askCheckoutStatus = useCallback(
    (chatId: string) => sendRead({ type: 'checkout_status', chatId }),
    [sendRead],
  )

  const askSessionRepo = useCallback(
    (chatId: string) => send({ type: 'session_repo', chatId }),
    [send],
  )
  const askSessionDiff = useCallback(
    (chatId: string, ignoreWhitespace: boolean) => send({ type: 'session_diff', chatId, ignoreWhitespace }),
    [send],
  )
  const commitSession = useCallback(
    (chatId: string, root: string, files: string[], message: string, requestId: string) =>
      send({ type: 'commit_session', chatId, root, files, message, requestId }),
    [send],
  )
  const pushSession = useCallback(
    (chatId: string, root: string, requestId: string) => send({ type: 'push_session', chatId, root, requestId }),
    [send],
  )
  const openSessionFolder = useCallback(
    (chatId: string, root: string, app: RepoFileApp) => send({ type: 'open_session_folder', chatId, root, app }),
    [send],
  )

  const askProjectCheckout = useCallback(
    (projectId: string) => send({ type: 'checkout_status', projectId }),
    [send],
  )

  const setChatMembers = useCallback(
    (chatId: string, memberIds: string[]) => {
      setWorkspace(clearNotice)
      return send({ type: 'set_chat_members', chatId, memberIds })
    },
    [send],
  )

  const deleteProject = useCallback(
    (projectId: string, requestId: string) => send({ type: 'delete_project', projectId, requestId }),
    [send],
  )

  const deleteChat = useCallback((chatId: string) => void send({ type: 'delete_chat', chatId }), [send])

  const setChatArchived = useCallback(
    (chatId: string, archived: boolean) => {
      const sent = send({ type: 'set_chat_archived', chatId, archived })
      if (sent) setWorkspace((current) => withChatArchived(current, chatId, archived))
      return sent
    },
    [send],
  )

  // Optimistic: the row has to leave
  // the list under the cursor that clicked it, and the server's directory is what
  // settles the truth a moment later.
  const setChatSettled = useCallback(
    (chatId: string, settled: boolean) => commands.setChatSettled(chatId, settled),
    [commands],
  )

  const rejectWorkHandoff = useCallback(
    (handoffId: string) => send({ type: 'reject_work_handoff', handoffId }),
    [send],
  )

  const confirmWorkGoal = useCallback(
    (handoffId: string, mergeInto?: string, version?: number, requestId?: string) =>
      commands.confirmWorkGoal(handoffId, mergeInto, version, requestId),
    [commands],
  )
  const reviseWorkGoal = useCallback(
    (handoffId: string, version: number, text: string, requestId?: string) =>
      commands.reviseWorkGoal(handoffId, version, text, requestId),
    [commands],
  )
  const retryWorkCompletion = useCallback(
    (handoffId: string, requestId?: string) => commands.retryWorkCompletion(handoffId, requestId),
    [commands],
  )

  const approveMergeFix = useCallback(
    (handoffId: string, tip: string, requestId?: string) => commands.approveMergeFix(handoffId, tip, requestId),
    [commands],
  )

  const acceptWorkHandoff = useCallback(
    (handoffId: string, options: WorkAcceptanceOptions) =>
      workAcceptance.current.accept(send, crypto.randomUUID(), handoffId, options),
    [send],
  )

  const createProjectThread = useCallback(
    (projectId: string) => workAcceptance.current.projectThread(send, crypto.randomUUID(), projectId, 'create'),
    [send],
  )

  const removeProjectThread = useCallback(
    (projectId: string) => workAcceptance.current.projectThread(send, crypto.randomUUID(), projectId, 'remove').then(() => undefined),
    [send],
  )

  const addFolder = useCallback(
    (path: string) => workAcceptance.current.folder(send, crypto.randomUUID(), { add: path }),
    [send],
  )

  const removeFolder = useCallback(
    (projectId: string) => workAcceptance.current.folder(send, crypto.randomUUID(), { remove: projectId }).then(() => undefined),
    [send],
  )

  // A finished run that was opened is settled, which keeps it out of pushes and the
  // inbox's unsettled list. It no longer drives the routine orb; `App` clears that
  // from `unreadRunIds` while the thread is actually on the stage.
  const openRun = chatOf(workspace, workspace.openChatId)
  const openRunBusy =
    openRun === null ? false : activityOf(workspace, openRun.id).runningTurns.length > 0
  useEffect(() => {
    if (openRun === null || !shouldSettleOpenRun(openRun, openRunBusy)) return
    setChatSettled(openRun.id, true)
  }, [openRun, openRunBusy, setChatSettled])

  const dismissNotice = useCallback(() => setWorkspace(clearNotice), [])

  // Asking again clears the previous answer first: the old error belongs to the
  // folder list that was on screen before this one.
  const updateProject = useCallback(
    (projectId: string, name: string, repoPaths: string[], icon: ProjectIcon, color: string, memoryScope: ProjectMemoryScope, requestId: string) => {
      setWorkspace(clearNotice)
      return send({ type: 'update_project', projectId, name, repoPaths, icon, color, memoryScope, requestId })
    },
    [send],
  )

  // Same rule as createProject: the old answer was about the draft as it was, and
  // a refusal left over from the previous Save would read as this one's.
  const saveAgent = useCallback(
    (agent: AgentDraft, requestId: string, interview = false) => {
      setWorkspace(clearNotice)
      return send({ type: 'save_agent', agent, requestId, ...(interview ? { interview: true as const } : {}) })
    },
    [send],
  )

  const setChatOverride = useCallback(
    (agentId: string, override: ChatOverride, chatId = openIdRef.current) => {
      if (chatId === null) return false
      const requestId = crypto.randomUUID()
      overrideRequests.current.set(requestId, chatId)
      if (commands.setChatOverride(chatId, agentId, override, requestId)) return true
      overrideRequests.current.delete(requestId)
      return false
    },
    [commands],
  )

  const deleteAgent = useCallback(
    (agentId: string, requestId: string) => {
      setWorkspace(clearNotice)
      return send({ type: 'delete_agent', agentId, requestId })
    },
    [send],
  )

  // The server probes the server before it saves it, so this round trip is slower
  // than the others here: it starts a process and waits for its tool list.
  const saveMcpServer = useCallback(
    (server: McpServerDraft, requestId: string) => {
      setWorkspace(clearNotice)
      return send({ type: 'save_mcp_server', server, requestId })
    },
    [send],
  )

  const deleteMcpServer = useCallback(
    (serverId: string, requestId: string) => {
      setWorkspace(clearNotice)
      return send({ type: 'delete_mcp_server', serverId, requestId })
    },
    [send],
  )

  const verifyMcpServer = useCallback(
    (serverId: string, requestId: string) => {
      setWorkspace(clearNotice)
      return send({ type: 'verify_mcp_server', serverId, requestId })
    },
    [send],
  )

  const verifyMyMind = useCallback(() => {
    setWorkspace(clearNotice)
    return send({ type: 'verify_mymind' })
  }, [send])

  // Same rule as saveAgent: the previous answer was about the draft as it was, and a
  // refusal left over from the last Save would read as this one's.
  const saveRoutine = useCallback(
    (routine: RoutineDraft, requestId: string) => {
      setWorkspace(clearNotice)
      return send({ type: 'save_routine', routine: { ...routine, description: routine.description ?? '' }, requestId })
    },
    [send],
  )

  const deleteRoutine = useCallback(
    (routineId: string, requestId: string) => {
      setWorkspace(clearNotice)
      return send({ type: 'delete_routine', routineId, requestId })
    },
    [send],
  )

  const setRoutineEnabled = useCallback(
    (routineId: string, enabled: boolean) => {
      setWorkspace(clearNotice)
      return send({ type: 'set_routine_enabled', routineId, enabled })
    },
    [send],
  )

  const runRoutineNow = useCallback(
    (routineId: string) => {
      setWorkspace(clearNotice)
      return send({ type: 'run_routine_now', routineId })
    },
    [send],
  )

  // No `clearNotice`: this is a read, and wiping the last answer to a save because a
  // panel refreshed its history would throw away a refusal the form is still showing.
  const getRoutineRuns = useCallback((routineId: string) => commands.getRoutineRuns(routineId), [commands])
  const getDmFiles = useCallback((chatId: string) => commands.getDmFiles(chatId), [commands])
  const markRoutineRunsRead = useCallback(
    (routineId: string, runIds: readonly string[]) => commands.markRoutineRunsRead(routineId, runIds),
    [commands],
  )
  const markAllRoutineRunsRead = useCallback(() => commands.markAllRoutineRunsRead(), [commands])

  const listSkillCandidates = useCallback(() => send({ type: 'list_skill_candidates' }), [send])

  const listWorkflowSuggestions = useCallback(() => send({ type: 'list_workflow_suggestions' }), [send])
  const listComposioApps = useCallback(() => send({ type: 'list_composio_apps' }), [send])
  const connectComposioApp = useCallback(
    (toolkit: string, alias: ComposioAlias, requestId: string) => send({ type: 'connect_composio_app', toolkit, alias, requestId }),
    [send],
  )
  const disconnectComposioApp = useCallback(
    (toolkit: string, alias: ComposioAlias | null, requestId: string) => send({ type: 'disconnect_composio_app', toolkit, alias, requestId }),
    [send],
  )
  const setComposioKey = useCallback((key: string, requestId: string) => send({ type: 'set_composio_key', key, requestId }), [send])
  const removeComposioKey = useCallback((requestId: string) => send({ type: 'remove_composio_key', requestId }), [send])

  const importSkill = useCallback(
    (candidateId: string, requestId: string) => {
      setWorkspace(clearNotice)
      return send({ type: 'import_skill', candidateId, requestId })
    },
    [send],
  )

  const deleteSkill = useCallback(
    (skillId: string, requestId: string) => {
      setWorkspace(clearNotice)
      return send({ type: 'delete_skill', skillId, requestId })
    },
    [send],
  )

  const clearBrowserAttention = useCallback((chatId: string) => {
    setBrowserAttention((current) => consumeBrowserAttention(current, chatId))
  }, [])

  return {
    workspace,
    live: store,
    status,
    requestEvents: requestEventsRef.current,
    getProjectMemory,
    getChatSummary,
    getAgentNotes,
    undoMemoryWrite,
    search,
    browserActivity,
    browserUse,
    browserAttention,
    consumeBrowserAttention: clearBrowserAttention,
    externalBrowser,
    openChat,
    clearChat,
    loadChat,
    createBrowserSession,
    createdBrowserSession,
    setResumeChats,
    setViewedChats,
    openSideChat,
    setSideRuntime,
    sendToChat,
    sendSideMessage,
    stopTurn,
    stopBackground,
    stopSubagent,
    openSubagentThread,
    requestSubagentPolicy,
    saveSubagentPolicy,
    saveProfile,
    saveHouseSettings,
    requestContextFiles,
    saveContextFile,
    requestSystemInfo,
    requestPhoneAccess,
    setTailscaleServe,
    createPairingLink,
    revokeDevice,
    revealLog,
    revealFolder,
    answerUserInput,
    answerSecretRequest,
    changeSessionAnswer,
    submitOutboundDraft,
    discardOutboundDraft,
    openConnectCard,
    snoozeOutboundDraft,
    ignoreOutboundDraft,
    restoreOutboundDraft,
    readOutboundThread,
    createProject,
    createChat,
    setChatCheckout,
    askCheckoutStatus,
    askSessionRepo,
    askSessionDiff,
    commitSession,
    pushSession,
    openSessionFolder,
    askProjectCheckout,
    setChatMembers,
    deleteProject,
    deleteChat,
    setChatArchived,
    setChatSettled,
    acceptWorkHandoff,
    createProjectThread,
    removeProjectThread,
    addFolder,
    removeFolder,
    rejectWorkHandoff,
    confirmWorkGoal,
    reviseWorkGoal,
    retryWorkCompletion,
    approveMergeFix,
    saveAgent,
    deleteAgent,
    saveMcpServer,
    verifyMcpServer,
    verifyMyMind,
    deleteMcpServer,
    saveRoutine,
    deleteRoutine,
    setRoutineEnabled,
    runRoutineNow,
    getRoutineRuns,
    getDmFiles,
    markRoutineRunsRead,
    markAllRoutineRunsRead,
    listSkillCandidates,
    listWorkflowSuggestions,
    listComposioApps,
    connectComposioApp,
    disconnectComposioApp,
    setComposioKey,
    removeComposioKey,
    importSkill,
    deleteSkill,
    updateProject,
    listDirs,
    closeDirs,
    loadUsageReport,
    refreshProviderUsage,
    updateProviders,
    checkProviders,
    signInProvider,
    cancelProviderSignIn,
    installProvider,
    requestAutoRules,
    saveAutoRules,
    listMyMindObjects,
    loadMoreMyMindObjects,
    listRepoFiles,
    readRepoFile,
    writeRepoFile,
    clearRepoWrite: forgetRepoWrite,
    listVault,
    createVaultFolder,
    deleteVaultEntry,
    renameVaultFile,
    moveVaultEntry,
    readVaultFile,
    writeVaultFile,
    clearVaultWrite: forgetVaultWrite,
    editVaultNote,
    forgetVaultNoteEdit: dropVaultNoteEdit,
    closeVaultNote: closeNote,
    loadReminders,
    loadCompletedReminders,
    writeReminder,
    dismissNotice,
    repoFileApps,
    openRepoFile,
    openExternalUrl,
    setChatOverride,
  }
}

function omit<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record
  const next = { ...record }
  delete next[key]
  return next
}

/** Saved-login metadata is for the user's chrome only; agents get the tab strip without it. */
function withoutPasswords(state: BrowserSessionState): BrowserSessionState {
  return { ...state, tabs: state.tabs.map(({ passwords: _passwords, ...tab }) => tab) }
}

/** A secret card's two server-built steps. The value passes through here once and stays in nothing. */
function fillSecret(browser: DesktopBrowserBridge, chatId: string, arguments_: Record<string, unknown>) {
  if (browser.findPasswordField === undefined || browser.fillSecret === undefined) {
    throw new Error('This Manor desktop app is too old to fill a secret. Quit and reopen it.')
  }
  if (arguments_.step === 'probe') return browser.findPasswordField(chatId)
  const { tabId, pageId, origin, value } = arguments_
  if (typeof tabId !== 'string' || typeof pageId !== 'number' || typeof origin !== 'string' || typeof value !== 'string') {
    throw new Error('Invalid secret fill request.')
  }
  return browser.fillSecret(chatId, { tabId, pageId, origin, value })
}

/** The two server-built steps of an agent's saved-login fill; the password stays in the desktop host. */
function fillSavedLogin(browser: DesktopBrowserBridge, chatId: string, arguments_: Record<string, unknown>) {
  if (browser.findSavedLogin === undefined || browser.fillSavedLogin === undefined) {
    throw new Error('This Manor desktop app is too old to fill saved logins.')
  }
  if (arguments_.step === 'lookup') {
    return browser.findSavedLogin(chatId, typeof arguments_.username === 'string' ? arguments_.username : undefined)
  }
  const { tabId, pageId, origin, loginId } = arguments_
  if (arguments_.step !== 'fill' || typeof tabId !== 'string' || typeof pageId !== 'number' ||
    typeof origin !== 'string' || typeof loginId !== 'string') {
    throw new Error('Invalid saved login request.')
  }
  return browser.fillSavedLogin(chatId, { tabId, pageId, origin, loginId })
}

export async function answerBrowserTool(
  request: Extract<ServerMessage, { type: 'browser_tool_request' }>,
  browser: DesktopBrowserBridge | undefined,
  /** Checked again between the native steps of one tool, so a Stop lands mid-tool too. */
  stillUsing: () => boolean = () => true,
): Promise<Extract<ClientMessage, { type: 'browser_tool_result' }>> {
  const proceed = () => {
    if (!stillUsing()) throw new Error('Browser agent use stopped.')
  }
  if (browser === undefined) {
    return {
      type: 'browser_tool_result',
      requestId: request.requestId,
      ok: false,
      error: 'No Manor desktop browser host is connected.',
    }
  }
  try {
    const result = await (async () => {
      switch (request.tool) {
        case 'browser_navigate': {
          const url = String(request.arguments.url ?? '')
          const reused = await reuseBrowserTab(browser, request.chatId, url, proceed)
          if (reused !== undefined) return { url: reused.tab.url, title: reused.tab.title }
          proceed()
          return browser.navigate(url, request.chatId)
        }
        case 'browser_snapshot':
          return browser.snapshot(request.chatId)
        case 'browser_click':
          return browser.click(String(request.arguments.selector ?? ''), request.chatId)
        case 'browser_type':
          return browser.type(
            String(request.arguments.selector ?? ''),
            String(request.arguments.text ?? ''),
            request.chatId,
          )
        case 'browser_press':
          return browser.press(String(request.arguments.key ?? ''), request.chatId)
        case 'browser_scroll':
          return browser.scroll(
            Number(request.arguments.deltaX),
            Number(request.arguments.deltaY),
            request.chatId,
          )
        case 'browser_screenshot':
          return browser.screenshot(request.chatId)
        case 'browser_tabs': {
          const select = request.arguments.select
          const open = request.arguments.open
          if (typeof open === 'string') {
            if (select !== undefined) throw new Error('Select a tab or open a URL, not both.')
            const reused = request.arguments.forceNew === true
              ? undefined
              : await reuseBrowserTab(browser, request.chatId, open, proceed)
            if (reused !== undefined) return withoutPasswords(reused.state)
            proceed()
            return withoutPasswords(await browser.newTab(request.chatId, open))
          }
          return withoutPasswords(await browser.tabs(request.chatId, typeof select === 'string' ? select : undefined))
        }
        case 'browser_fill_login':
          return request.arguments.step === 'probe' || request.arguments.step === 'fill_secret'
            ? fillSecret(browser, request.chatId, request.arguments)
            : fillSavedLogin(browser, request.chatId, request.arguments)
      }
    })()
    return { type: 'browser_tool_result', requestId: request.requestId, ok: true, result }
  } catch (error: unknown) {
    return {
      type: 'browser_tool_result',
      requestId: request.requestId,
      ok: false,
      error: error instanceof Error ? error.message : 'The browser action failed.',
    }
  }
}
