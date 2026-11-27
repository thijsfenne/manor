import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { AnimatePresence } from 'motion/react'
import {
  NEW_SINGLE_CHAT_DEFAULT,
  runtimeOn,
  BROWSER_HOME_SESSION_ID,
  type Chat,
  type InlineQuote,
  type MessageReply,
  type PageContextAttachment,
} from '@manor/contracts'
import type { ComposerAttachments } from '@manor/client-runtime/attachments'
import type { NoticeTarget } from '@manor/client-runtime/notices'
import { ChatStage, StageChatPane, type StageKit } from './components/workspace/ChatStage'
import { DestinationView, isDestinationView } from './components/workspace/DestinationView'
import { SettingsLayer, useSettingsDoors } from './components/workspace/SettingsLayer'
import { WorkspaceDialogs } from './components/workspace/WorkspaceDialogs'
import { WorkspaceNavRail } from './components/workspace/WorkspaceNavRail'
import { ExternalLinkProvider } from './components/ExternalLink'
import { ConnectScreen } from './components/ConnectScreen'
import { Onboarding } from './components/onboarding/Onboarding'
import { NewAgentDialog } from './components/agents/NewAgentDialog'
import { AutoRulesConfigProvider } from './components/settings/AutoRulesPage'
import { ViewBoundary } from './components/RecoveryBoundary'
import { useOffModels } from './useOffModels'
import { RepoFileLinkProvider } from './components/RepoFileLink'
import { SplitDragContext, SplitDragLayer } from './components/SplitDrag'
import { NAV_RAIL_WIDTH } from './components/NavRail'
import { Sidebar } from './components/Sidebar'
import type { AgentPins } from './components/chats/ChatListView'
import { cleanDraft, draftOf } from './persona'
import { FRAME_GUTTER, TOP_BAR_HEIGHT, TopBar, TopBarSlotContext, type TopBarSlot } from './components/TopBar'
import { NoticeStack } from './components/NoticeStack'
import { providerUpdateNotice, useProviderUpdates } from './components/ProviderUpdates'
import { sessionGitNotice, useSessionGitToast } from './components/session/SessionGitToast'
import { useMailArchivedNotice } from './components/mail/mailArchivedNotice'
import { SESSION_SCOPE } from './components/session/DiffPanel'
import { FileMarkSprite } from './components/fileMark'
import { chatKindOffersSideChat } from './components/RightRail'
import { BrowserWebviewHost } from './components/BrowserWebviewHost'
import { lastCreatedProjectId } from './lastProject'
import { navDestinationOf, sidebarPanelOf, type NavDestination } from './navDestination'
import type { ScheduleKind } from './routines'
import { chatOf, emptyThread, isHomeRoom, roomOf, rowsOf, threadOf } from './state'
import { desktopBrowser, openWebsiteInBrowser } from './desktopBrowser'
import { routeWebsiteLink } from './websiteLinkRoute'
import { useAuth } from './useAuth'
import { useBrowserPlace, useFloatingBrowser } from './useBrowserPlace'
import { useOutboundDraftActions } from './useOutboundDraftActions'
import { heldProjectDraftId, useChatDialogs } from './useChatDialogs'
import { usePageContexts } from './useChatSide'
import { useChatReplies } from './useChatReplies'
import { useChatSwitcher } from './useChatSwitcher'
import { useFocusMode } from './focusMode'
import { useLastCommitted } from './useLastCommitted'
import { useOpenChatRail } from './useOpenChatRail'
import { useOpenChatRows } from './useOpenChatRows'
import { usePanelSelections } from './usePanelSelections'
import { useProjectThreadCreation } from './useProjectThreadCreation'
import { useRevealRequests } from './useRevealRequests'
import { layoutHas, useRightPanel } from './useRightPanel'
import { useSettings } from './useSettings'
import { useSidebar } from './useSidebar'
import { chatOnStage, focusedSplitChatId, occupiedSplitIds, type SplitStage } from './splitStage'
import { useSplitActions, useSplitStage } from './useSplitStage'
import { subagentChrome } from './subagentChrome'
import { useSubagentViews } from './useSubagentViews'
import { useColorThemes, useTheme } from './useTheme'
import { useViewportWidth } from './useViewportWidth'
import { useWorkspace, type WorkspaceAuth } from './useWorkspace'
import { useWorkspaceLists } from './useWorkspaceLists'
import { useWorkspaceNav } from './useWorkspaceNav'
import { resolveWebSocketUrl } from './webSocketUrl'
import { isPhoneLayout } from './phoneLayout'
import { LiveWorkspaceProvider } from './liveThread'

/** Dev may point elsewhere. A built app talks back to whichever origin served it. */

const WS_URL = resolveWebSocketUrl(import.meta.env.VITE_MANOR_WS, window.location)

export interface Account {
  onForget: () => void
}

/**
 * The door. Nothing below it mounts until this browser's way in is known, so a browser
 * that is not paired gets the Connect screen and never a chat UI that cannot connect.
 * With `VITE_MANOR_AUTH=off` there is no door at all, the mirror of the server's
 * `MANOR_AUTH=off`.
 */
export function App() {
  const auth = useAuth()
  const { state } = auth
  /**
   * Above the door, so a visitor waiting at the Connect screen still follows the OS when
   * it flips. The inline script in index.html has already painted the right theme; this
   * is what keeps it right for the rest of the session.
   */
  const theme = useTheme()

  const workspaceAuth: WorkspaceAuth | undefined = state.status === 'disabled'
    ? undefined
    : { sessionKey: state.status === 'paired' ? state.deviceId : state.status, getToken: auth.getToken, onRejected: auth.refresh }

  if (state.status === 'unknown' || state.status === 'pairing') {
    return <main className="grid h-full place-items-center p-6 text-[13px] text-dim">{state.status === 'pairing' ? 'Pairing this browser…' : 'Opening the workspace…'}</main>
  }
  if (state.status === 'unpaired') return <ConnectScreen error={state.error} />

  const account: Account | undefined = state.status === 'paired' ? { onForget: auth.forget } : undefined

  return <Workspace auth={workspaceAuth} account={account} theme={theme} />
}

function Workspace({
  auth,
  account,
  theme,
}: {
  auth: WorkspaceAuth | undefined
  account: Account | undefined
  theme: ReturnType<typeof useTheme>
}) {
  const manor = useWorkspace(WS_URL, auth)
  const { workspace, status } = manor
  useColorThemes(workspace.houseSettings)
  const viewportWidth = useViewportWidth()
  const phone = isPhoneLayout(viewportWidth)
  /** Focus mode as asked for; see `focusMode` below. While it is on, the hidden chrome's own keys are off. */
  const [focusRequested, setFocusRequested] = useState(false)
  /** The stage's panel region docks only with the sidebar folded; see `sidebarFoldsForPanels`. */
  const [panelFoldsSidebar, setPanelFoldsSidebar] = useState(false)
  const {
    collapsed: sidebarCollapsed,
    foldedForPanel: sidebarFoldedForPanel,
    overlay: sidebarOverlay,
    width: sidebarWidth,
    view: sidebarView,
    peeking,
    resizing: sidebarResizing,
    motion,
    toggle: toggleSidebar,
    setAvailable: setSidebarAvailable,
    closeOverlay: closeSidebarOverlay,
    showView: showSidebarView,
    holdPeek,
    resizeProps,
  } = useSidebar(phone, !focusRequested, panelFoldsSidebar)
  // The server keeps one notice at a time, so exactly one place on screen may
  // show it. While a registry dialog is up, that place is the dialog.
  const [editingSettings, setEditingSettings] = useState(false)
  const settings = useSettings(manor.status === 'live')
  const settingsOpen = settings.location !== null
  const reveals = useRevealRequests()
  const { noteRequest, clearNoteRequest } = reveals

  /**
   * Everything across the window that is not the stage. A panel clamped against the
   * bare viewport measures a chat that does not exist: the sidebar and the rail are
   * already spending 330 of those pixels, and the transcript pays for both.
   */
  const chromeWidth = phone ? 0 : NAV_RAIL_WIDTH + FRAME_GUTTER
  const reservedWidth = (sidebarCollapsed || sidebarOverlay ? 0 : sidebarWidth) + chromeWidth
  /** The room the pinned sidebar holds as the user left it, also while it is folded for a panel. */
  const sidebarRoomWidth = sidebarOverlay || (sidebarCollapsed && !sidebarFoldedForPanel) ? 0 : sidebarWidth
  const pinnedStageWidth = Math.max(0, viewportWidth - chromeWidth - sidebarRoomWidth)
  /**
   * Read once per mount rather than per render: the preload bridge is installed
   * before the first paint or it never is, and this decides whether a rail item and
   * a WebSocket announcement exist at all.
   */
  const [browserBridge] = useState(desktopBrowser)
  // Each split pane owns its rail and panel. Neither may take width from its neighbour.
  const stageWidth = Math.max(0, viewportWidth - reservedWidth)
  // A split is judged on the stage as the user left the sidebar, so a fold for a panel
  // never brings one up; it would take the room the fold was for.
  const stage = useSplitStage(manor, phone, pinnedStageWidth, sidebarView)
  const sidebarRoom = { stageWidth: pinnedStageWidth, width: sidebarRoomWidth, onFold: setPanelFoldsSidebar }
  const { visibleSplit, canSplit, freeSplit, roomThreadOf, splitDraftSide, setSplitDraftSide } = stage

  const listedOpen = chatOf(workspace, workspace.openChatId)
  const listedPending = chatOf(workspace, workspace.pendingChatId)
  // This client has two sidebar destinations. A stale selection from the other
  // list stays off the stage, even while its replacement is loading.
  const onStage = (chat: Chat | null): chat is Chat => chat !== null && chatOnStage(chat, sidebarView)
  const shown = onStage(listedOpen) ? listedOpen : null
  const pending = onStage(listedPending) ? listedPending : null
  /**
   * The chat the stage is about: the one that was clicked, not the one the server has
   * confirmed. A click is answered by showing that chat. Its thread is usually already
   * in memory, because nothing drops a thread that has been read this session, and a
   * chat opened for the first time says it is loading instead. What may never happen
   * is the conversation you just left standing there under the new chat's name, which
   * is what the wait used to look like coming off the new-chat stage: a session you
   * had closed, flashing back for a moment.
   *
   * Sending stays gated on the snapshot (`canSend` below), because an optimistic
   * bubble needs a thread to sit in.
   */
  const open = visibleSplit !== null && focusedSplitChatId(visibleSplit) === null ? null : pending ?? shown
  // Below `open` rather than with the other state: the rail's memory is per chat,
  // so the hook needs to know which one is on the stage.
  // A session in its project room opens on its transcript alone; the Session door brings the panel (2026-10-11).
  // The subagent views are created further down, so the hook reads what covers a chat through a ref.
  const panelsCoveredRef = useRef<(chatId: string) => boolean>(() => false)
  const rightPanel = useRightPanel(open?.id ?? null, sidebarOverlay, !focusRequested, (chatId) => roomThreadOf(chatId) !== undefined,
    (chatId) => { const kind = chatOf(workspace, chatId)?.kind; return kind === undefined || chatKindOffersSideChat(kind) },
    panelsCoveredRef)
  const panels = usePanelSelections(manor, rightPanel)
  // Methods by name: the compiler keys a call like `rightPanel.showFor(…)` on `rightPanel`,
  // which these hooks hand back new with every render, so a callback through it would be too.
  const { show: showRightPanel, showFor: showRightPanelFor, layoutFor } = rightPanel
  const { setDiffScope, openFileFor } = panels
  const { settle } = stage
  const { sendToChat: sendChatMessage, consumeBrowserAttention, setViewedChats } = manor

  const thread = open === null ? emptyThread : threadOf(workspace, open.id)
  const baseRows = rowsOf(thread, open?.kind)
  const showChatRef = useRef<() => void>(() => {})
  const restorePageContextsRef = useRef<(key: string, contexts: PageContextAttachment[]) => void>(() => {})
  const offModels = useOffModels()
  const chatDialogs = useChatDialogs({
    dismissNotice: manor.dismissNotice,
    createChat: manor.createChat,
    requestEvents: manor.requestEvents,
    pendingChatId: workspace.pendingChatId,
    openChatId: workspace.openChatId,
    notice: workspace.notice,
    projects: workspace.projects,
    agents: workspace.agents,
    singleDefault: runtimeOn(NEW_SINGLE_CHAT_DEFAULT, offModels),
    stageChatId: open?.id ?? null,
    stageHasRows: baseRows.length > 0,
    showChatRef,
    restorePageContextsRef,
  })
  const {
    newChatDraft, creating, bornChat, projectDialog, groupDialog, searchOpen, draftProjectId, draftAgentId,
    openProjectDialog, closeProjectDialog, closeGroup, newGroup, editGroup, openSearch, closeSearch,
    beginDraft, clearDraft,
  } = chatDialogs
  const { rows, running } = useOpenChatRows(manor, open?.id, thread, baseRows, bornChat)
  const { chatRows, chatInbox, searchInbox, threadRows, threadlessProjects, switcherItems, runsByRoutine } = useWorkspaceLists(workspace, phone, searchOpen)

  const hasVault = workspace.vault.status === 'ready'
  const hasArtifacts = workspace.artifacts.status === 'ready'
  // The phone has Apple's own Reminders app, which syncs; the door is a Mac-width surface.
  const hasReminders = workspace.reminders.available && !phone
  // A Mac-width surface too, and there only where the host has a mailbox configured.
  const hasMail = workspace.mail.snapshot !== null && workspace.mail.snapshot.status !== 'off' && !phone
  // A folder taken off the picker is never where a new Session lands on its own.
  const listedProjects = workspace.projects.filter((project) => project.unlisted !== true)
  const defaultProjectId = lastCreatedProjectId(workspace.chats, listedProjects)
  // A Session needs no project: with none to go on it starts in the home room.
  const newChatProject =
    roomOf(workspace, draftProjectId ?? heldProjectDraftId() ?? defaultProjectId) ?? listedProjects[0] ?? workspace.home
  // One answer for the button and the ⌘N shortcut alike: a chat can be started
  // only while the server is there to hold it. A room always exists.
  const canStartChat = status === 'live'

  const onChatSettled = (chatId: string) => settle(chatId, newChatDraft !== null)

  const nav = useWorkspaceNav({
    projects: workspace.projects,
    chats: workspace.chats,
    agents: workspace.agents,
    routines: workspace.routines,
    hasDirectory: workspace.hasDirectory,
    hasRoster: workspace.hasRoster,
    hasVault,
    hasVaultStatus: workspace.vault.status !== 'unknown',
    hasArtifacts,
    hasArtifactsStatus: workspace.artifacts.status !== 'unknown',
    hasReminders,
    hasMail,
    hasMailStatus: workspace.mail.snapshot !== null,
    hasBrowser: browserBridge !== undefined,
    hasRoutines: workspace.hasRoutines,
    canStartChat,
    sidebarView,
    showSidebarView,
    openChatOnServer: stage.openChatOnServer,
    dismissNotice: manor.dismissNotice,
    listSkillCandidates: manor.listSkillCandidates,
    listWorkflowSuggestions: manor.listWorkflowSuggestions,
    listMyMindObjects: manor.listMyMindObjects,
    setChatSettledOnServer: manor.setChatSettled,
    onChatSettled,
    inboxReturnId: stage.inboxReturnId,
    createChat: manor.createChat,
    showRunPanel: showRightPanelFor,
    beginDraft,
    clearDraft,
    newChatProject,
    selected: open,
    selectedChat: listedPending ?? listedOpen,
    unsettledInbox: chatInbox.unsettled,
    draftTarget: newChatDraft?.target,
  })
  const {
    activeView,
    routineDetail,
    openChat,
    openDm,
    startChat: beginChat,
    openSkills,
    openConnectors,
    openSuggestions,
    openPlugins,
    openRoutines,
    openRoutineDetail,
    openKnowledge,
    openReminders,
    openMail,
    openArtifacts,
    openBrowser,
    openUsage,
    setChatSettled,
    createGroup,
    showSidebarDestination,
    goBack,
    goForward,
    canBack,
    canForward,
    showChat,
    showEmptyChat,
  } = nav

  // The agent the onboarding creates becomes the first conversation: once the empty
  // house has somebody in it, their DM opens without another click.
  const emptyHouse = workspace.hasRoster && workspace.agents.length === 0
  const wasEmptyHouse = useRef(false)
  useEffect(() => {
    if (emptyHouse) {
      wasEmptyHouse.current = true
      return
    }
    const first = workspace.agents[0]
    if (!wasEmptyHouse.current || first === undefined) return
    wasEmptyHouse.current = false
    openDm(first.id)
  }, [emptyHouse, workspace.agents, openDm])
  // The one rail door the stage is behind, and the list (if any) it brings along.
  const stageKind = activeView === 'new-chat' ? (newChatDraft?.target.kind ?? null) : (open?.kind ?? null)
  const destination = navDestinationOf(activeView, stageKind, sidebarView)
  // The phone keeps Knowledge's tree on its own page: its drawer is the rail alone there.
  const sidebarPanel = phone && destination === 'knowledge' ? null : sidebarPanelOf(destination)
  const [knowledgeSlot, setKnowledgeSlot] = useState<HTMLDivElement | null>(null)
  const [knowledgeActionSlot, setKnowledgeActionSlot] = useState<HTMLDivElement | null>(null)
  const [remindersSlot, setRemindersSlot] = useState<HTMLDivElement | null>(null)
  const [mailSlot, setMailSlot] = useState<HTMLDivElement | null>(null)
  const [mailActionSlot, setMailActionSlot] = useState<HTMLDivElement | null>(null)
  // The phone drawer always opens, because it carries the rail; on the desktop a
  // destination without a list simply has no sidebar.
  const sidebarAvailable = phone || sidebarPanel !== null
  useLayoutEffect(() => {
    setSidebarAvailable(sidebarAvailable)
  }, [sidebarAvailable, setSidebarAvailable])
  /** The "show sidebar" handle, only where there is a sidebar to show. */
  const sidebarHandle = sidebarAvailable ? toggleSidebar : undefined
  // The DM persona on the stage, sent or still a draft, so her rail face can hold the marker.
  const stageAgentId =
    activeView === 'new-chat'
      ? newChatDraft?.target.kind === 'dm' ? newChatDraft.target.agentId : null
      : activeView === 'chat' && open?.kind === 'dm' ? (open.memberIds[0] ?? null) : null
  // A pick on the Scheduled tasks page is a place in history; null hands the choice back to the page.
  const selectRoutine = (routineId: string | null) => (routineId === null ? openRoutines() : openRoutineDetail(routineId))
  // Held here so the Scheduled page finds the kind it was left on.
  const [pickedScheduledKind, setPickedScheduledKind] = useState<ScheduleKind | null>(null)
  const openDestination = (next: NavDestination) => {
    // The door already open brings its folded list back rather than reloading the stage.
    if (!phone && next === destination && sidebarPanelOf(next) !== null && sidebarCollapsed) {
      toggleSidebar()
      return
    }
    if (next === 'work') showSidebarDestination('inbox')
    else if (next === 'chats') showSidebarDestination('chats')
    else if (next === 'knowledge') openKnowledge()
    else if (next === 'reminders') openReminders()
    else if (next === 'artifacts') openArtifacts()
    else if (next === 'browser') openBrowser()
    else if (next === 'routines') openRoutines()
    else if (next === 'mail') openMail()
    else openPlugins()
    closeSidebarOverlay()
  }
  // Usage has no door of its own on the rail, so leaving it is a step back, or the chats when a reload left no history.
  const leaveUsage = () => (canBack ? goBack() : showSidebarDestination('chats'))
  const startChat = () => {
    if (freeSplit !== null && freeSplit.view === 'inbox') setSplitDraftSide(freeSplit.focus)
    beginChat()
  }

  // A draft on the stage is not a chat, so it gets no tile and no "active" slot:
  // the last real chat leads the strip, and landing back on it closes the draft.
  const switcher = useChatSwitcher({
    items: switcherItems,
    activeId: newChatDraft !== null ? null : (open?.id ?? null),
    openChat,
  })

  // A room's remembered session keeps its subagent view while the user is on another screen.
  const subagentViewChatIds = new Set([...occupiedChatIdsOf(visibleSplit, null, open?.id ?? null), ...Object.values(stage.roomSessions)])
  const { sidebarSubagents, activeSubagents, subagentPath, pushSubagentView, popSubagentView, closeSubagentView, openSubagent } =
    useSubagentViews(workspace, openChat, closeSidebarOverlay, subagentViewChatIds)
  useEffect(() => {
    panelsCoveredRef.current = (chatId) => subagentChrome(subagentPath(chatId)).panelHidden
  }, [subagentPath])
  const subagentOnStage = open !== null && activeView === 'chat' && subagentPath(open.id).length > 0
  // A chat's own row always lands on the chat, also from a subagent it started.
  const openChatFromSidebar = (chatId: string) => {
    closeSidebarOverlay()
    closeSubagentView(chatId)
    openChat(chatId)
  }
  /** A Session with its whole diff beside it: a ready card's file count, a Session's own Ready row. */
  const openSessionDiff = (chatId: string) => {
    closeSidebarOverlay()
    setDiffScope(chatId, SESSION_SCOPE)
    showRightPanelFor(chatId, 'diff')
    openChat(chatId)
  }
  const editProject = (projectId: string) => openProjectDialog({ mode: 'edit', projectId })
  // Deleting a project takes its thread, Sessions and chats; the dialog asks first.
  const deleteProject = (projectId: string) => openProjectDialog({ mode: 'edit', projectId, armDelete: true })
  const { createProjectThread, newProjectThread } =
    useProjectThreadCreation(manor, openChatFromSidebar, openProjectDialog, projectDialog)
  // Every real destination dismisses a compact drawer. Switching the Agents and
  // Inbox list does not, because that happens inside the drawer itself.
  useEffect(() => {
    closeSidebarOverlay()
  }, [activeView, open?.id, newChatDraft !== null, routineDetail?.id, closeSidebarOverlay])

  const { railItems, activeLayout, railShown, canBrowseFiles, fileListing } = useOpenChatRail({
    manor,
    open,
    thread,
    newChatDraft,
    draftProjectId,
    splitShown: visibleSplit !== null,
    phone,
    hasVault,
    browserBridge,
    rightPanel,
    roomThreadOf,
    subagentPath,
  })
  /** Everything the sidebar lists, which is everything the stage can be pointed at. */
  const listedChatIds = new Set(workspace.chats.map((chat) => chat.id))

  const providerUpdates = useProviderUpdates(workspace.providerUpdates)
  const sessionGitToast = useSessionGitToast(workspace.sessionGitResults, workspace.sessionCommits, manor.status === 'live')
  const mailNotice = useMailArchivedNotice(workspace.mail, manor.mailCommands.unarchiveMailThread)
  const houseNotices = [
    mailNotice,
    providerUpdateNotice(providerUpdates.toast, manor.updateProviders, providerUpdates.dismissToast),
    sessionGitNotice(sessionGitToast.notice, sessionGitToast.dismiss),
  ].filter((notice) => notice !== null)
  // The stack sits above Settings, so Open leaves it first, as every other door out does.
  const openNoticeTarget = (target: NoticeTarget) => leaveSettingsThen(() => {
    if ('chatId' in target) openChatFromSidebar(target.chatId)
    else if (target.page === 'scheduled') openRoutines()
    else openUsage()
  })()
  const browserShown = railShown && layoutHas(activeLayout, 'browser') && browserBridge !== undefined
  const floatingBrowser = useFloatingBrowser({ browserShown, drafting: newChatDraft !== null, openChatId: open?.id })
  // The simulator floats by the same rules: only by its panel's Float, gone once the panel shows again.
  const floatingSimulator = useFloatingBrowser({ browserShown: railShown && layoutHas(activeLayout, 'simulator'), drafting: newChatDraft !== null, openChatId: open?.id })
  const pageContexts = usePageContexts()
  const { pageContextsByChat, addPageContext, consumePageContexts } = pageContexts
  const chatReplies = useChatReplies()
  const { clear: clearReply } = chatReplies
  // The draft hook calls these from its effects and answers, never while rendering.
  useLayoutEffect(() => {
    showChatRef.current = showChat
    restorePageContextsRef.current = (key, contexts) => {
      for (const context of contexts) addPageContext(key, context)
    }
  })

  const sendToChat = (
    chatId: string,
    text: string,
    attachments: ComposerAttachments,
    pageContexts?: PageContextAttachment[],
    replyTo?: MessageReply,
    quotes?: InlineQuote[],
  ): boolean => {
    const sent = sendChatMessage(chatId, text, attachments, pageContexts, replyTo, quotes)
    if (sent) {
      consumePageContexts(chatId)
      clearReply(chatId)
    }
    return sent
  }

  /**
   * A modal owns the screen. The server keeps one notice at a time, and an open
   * dialog is where that notice belongs.
   */
  // A Session agent has no DM to be interviewed in, so it is made apart and opens in Settings.
  const [newAgentKind, setNewAgentKind] = useState<'chat' | 'session' | null>(null)
  const openNewAgent = () => setNewAgentKind('chat')
  const closeNewAgent = () => setNewAgentKind(null)
  const newAgentOpen = newAgentKind !== null
  const dialogOpen =
    editingSettings || settingsOpen || projectDialog !== null || groupDialog !== null || searchOpen || newAgentOpen

  const settingsDoors = useSettingsDoors(settings, manor.dismissNotice, openNewAgent)
  const { openAutoRules, newAgent, leaveSettingsThen } = settingsDoors
  const newSessionAgent = leaveSettingsThen(() => setNewAgentKind('session'))
  /**
   * Agent settings, one editor in two hosts: an agent with a DM gets it docked in that
   * DM, a Session agent (or one never talked to) gets it in Settings → Agents.
   */
  const editAgent = (agentId: string) => {
    const agent = workspace.agents.find((candidate) => candidate.id === agentId)
    const dm = agent === undefined || agent.placement === 'session'
      ? undefined
      : workspace.chats.find((chat) => chat.kind === 'dm' && chat.memberIds[0] === agentId)
    if (dm === undefined) {
      settingsDoors.editAgent(agentId)
      return
    }
    leaveSettingsThen(() => {
      openDm(agentId)
      showRightPanelFor(dm.id, 'agent')
    })()
  }
  /** A row menu's pin toggle: the stored agent saved again with one pin flipped, as her settings save it. */
  const setAgentPins = (agentId: string, pins: AgentPins) => {
    const agent = workspace.agents.find((candidate) => candidate.id === agentId)
    if (agent !== undefined) manor.saveAgent(cleanDraft({ ...draftOf(agent), ...pins }), crypto.randomUUID())
  }
  const [managingAgents, setManagingAgents] = useState(false)
  const manageAgents = () => setManagingAgents(true)
  const closeManagingAgents = () => setManagingAgents(false)

  /** The source page stays where it was, and login state is shared. */
  const sendToBrowser = async (url: string) => {
    if (browserBridge === undefined) return
    await openWebsiteInBrowser(browserBridge, BROWSER_HOME_SESSION_ID, url)
  }
  const openWebsiteUrl = (url: string, chatId?: string): boolean => routeWebsiteLink(url, {
    browser: browserBridge,
    chat: workspace.chats.find((candidate) => candidate.id === chatId),
    // A chat a subagent view covers has its panel out of sight too, so a link goes to the full Browser.
    roomSession: chatId !== undefined && (roomThreadOf(chatId) !== undefined || subagentChrome(subagentPath(chatId)).panelHidden),
    phone,
    showPanel: (targetChatId) => showRightPanelFor(targetChatId, 'browser'),
    showFullBrowser: openBrowser,
    onFailure: (failedUrl) => window.alert(`Could not open this website in Browser.\n${failedUrl}`),
  })
  const browserPlace = useBrowserPlace({ activeView, workspace, manor })
  const { paneId: browserPaneId, viewedId: browserViewedId } = browserPlace
  const showBrowserPanel = (chatId: string) => showRightPanelFor(chatId, 'browser')

  /** A loaded browser destination reveals the page where the user can keep working with it. */
  useEffect(() => {
    if (browserBridge === undefined || open === null || !manor.browserAttention.has(open.id)) return
    showRightPanel('browser')
    consumeBrowserAttention(open.id)
  }, [manor.browserAttention, consumeBrowserAttention, browserBridge, open?.id, showRightPanel])

  /**
   * Whether the screen changed on the way into this render, by another chat or by the
   * new-chat stage. The rail's panel is remembered per chat, so walking from a chat
   * with the roster open into one with nothing open would otherwise slide the region
   * shut on arrival: an animation the new chat had no part in, playing over the thing
   * it was opened to read. A screen you switch to is simply the screen, already in
   * place. A click on the rail is a different thing and keeps its motion.
   *
   * The mark is moved after the commit and never during the render. `useLingeringPanel`
   * sets state while rendering, which makes React run this body again before anything
   * reaches the DOM; a flag cleared in the first pass is gone in the pass that actually
   * commits, and the transition it was meant to suppress runs anyway. Which is exactly
   * how this read as fixed while nothing had changed on screen.
   */
  const shownScreen = newChatDraft !== null ? 'new-chat' : (open?.id ?? 'none')
  const lastShownScreen = useLastCommitted(shownScreen)
  // A chat coming out of the stage is the exception: that is not a switch, it is a
  // chat appearing, and the rail may open with it rather than be there already.
  const born = lastShownScreen === 'new-chat' && shownScreen === bornChat?.chatId
  const chatSwitched = lastShownScreen !== shownScreen && !born

  const splitActions = useSplitActions(stage, {
    manor,
    sidebarView,
    activeView,
    open,
    newChatDraft,
    bornChatId: bornChat?.chatId ?? null,
    listedChatIds,
    browserPaneId,
    openChat,
    showChat,
    showEmptyChat,
    startChat: beginChat,
    openDm,
    clearDraft,
    closeSidebarOverlay,
  })
  const { onChatStage, paneSplit, openRight, openPinnedDm, dropLane, splitDrag, sidebarGrab, railGrab } = splitActions
  const { ratio: splitRatio, resizing: splitResizing } = stage.ratio
  const draftSide =
    newChatDraft !== null && visibleSplit !== null ? (splitDraftSide ?? visibleSplit.focus) : null
  /**
   * The top bar's groups. Each pane portals its header into the group above it, so the
   * bar holds every pane's breadcrumb and controls and the panes hold none. The phone
   * has no bar and keeps each header in place.
   */
  const [barSlots, setBarSlots] = useState<{ left: HTMLElement | null; right: HTMLElement | null }>({ left: null, right: null })
  const barSlotRefs = {
    left: (element: HTMLElement | null) => setBarSlots((current) => (current.left === element ? current : { ...current, left: element })),
    right: (element: HTMLElement | null) => setBarSlots((current) => (current.right === element ? current : { ...current, right: element })),
  }
  const stageSlot: TopBarSlot | null = phone ? null : { element: barSlots.left, focused: true }
  // Only the stage views draw the split; elsewhere the bar has one group whatever is remembered.
  const splitShown = paneSplit && (activeView === 'chat' || activeView === 'new-chat' || activeView === 'empty-chat')
  const browserPaneIds = visibleSplit === null ? [] : occupiedSplitIds(visibleSplit, draftSide)
    // A pane a subagent view covers hides its panel, so it cannot be the one holding the native page.
    .filter((id) => layoutHas(layoutFor(id), 'browser') && !subagentChrome(subagentPath(id)).panelHidden)
  const browserViewChatId = browserPaneIds.find((id) => id === open?.id) ?? browserPaneIds[0] ?? open?.id
  const occupiedChatIds = occupiedChatIdsOf(visibleSplit, draftSide, newChatDraft === null ? (open?.id ?? null) : null)

  // A run thread in a stage pane is a result shown, so it leaves its routine's unread
  // list (settling it no longer does). Only while the stage is up: the open chat stays
  // selected behind Scheduled and every other rail door, where a run finishing is unseen.
  // A project run's id is its thread's, so the pane ids match it directly.
  const stageUp = activeView === 'chat' || activeView === 'new-chat' || (activeView === 'empty-chat' && visibleSplit !== null)

  /**
   * Focus mode (⌘.): only the transcript stays. The rail, sidebar, panels and composer
   * are hidden rather than closed, so their own state is exactly what leaving brings
   * back. A split shows its focused pane alone. Leaving the stage or opening Settings
   * ends it; the phone has no such mode. Keys in `focusMode.ts`, the composer's reveal
   * in `Composer`.
   */
  const { focusMode, stageCanvas } =
    useFocusMode(focusRequested, setFocusRequested, !phone && !settingsOpen && onChatStage, motion === 'instant')
  const markRoutineRunsRead = manor.markRoutineRunsRead
  useEffect(() => {
    if (!stageUp) return
    for (const routine of workspace.routines) {
      const shown = routine.unreadRunIds.filter((id) => occupiedChatIds.has(id))
      if (shown.length > 0) markRoutineRunsRead(routine.id, shown)
    }
  }, [stageUp, occupiedChatIds, workspace.routines, markRoutineRunsRead])

  // What the user actually sees: no stage behind a rail door, and Focus mode shows a
  // split's focused pane alone. Only those chats keep their news out of the stack.
  const focusedId = newChatDraft === null ? (open?.id ?? null) : null
  useEffect(() => {
    const browserColumn = browserViewedId === null ? [] : [browserViewedId]
    const stageShown = !stageUp ? [] : focusMode ? (focusedId === null ? [] : [focusedId]) : [...occupiedChatIds]
    setViewedChats([...occupiedChatIds, ...browserColumn], [...stageShown, ...browserColumn])
  }, [setViewedChats, occupiedChatIds, browserViewedId, stageUp, focusMode, focusedId])

  const onOpenFile = (path: string) => {
    if (open !== null) openFileFor(open, path)
  }

  const draftActionsFor = useOutboundDraftActions(manor, workspace.outboundThreads)

  const stageKit: StageKit = {
    manor,
    phone,
    open,
    stage,
    split: splitActions,
    nav,
    dialogs: chatDialogs,
    rightPanel,
    panels,
    replies: chatReplies,
    pageContexts,
    reveals,
    floatingBrowser,
    floatingSimulator,
    browserBridge,
    railItems,
    activeLayout,
    running,
    stageWidth,
    sidebarRoom,
    hasVault,
    settingsOpen,
    focusMode,
    chatSwitched,
    browserViewChatId,
    sidebarCollapsed,
    onToggleSidebar: toggleSidebar,
    sidebarHandle,
    subagentPath,
    pushSubagentView,
    popSubagentView,
    draftActionsFor,
    sendToChat,
    openWebsiteUrl,
    sendToBrowser,
    openSessionDiff,
    editAgent,
    newSessionAgent,
    leaveFocusMode: () => setFocusRequested(false),
    onDialogChange: setEditingSettings,
  }

  const navRail = (
    <WorkspaceNavRail
      manor={manor}
      chatRows={chatRows}
      chatInbox={chatInbox}
      destination={destination}
      stageAgentId={stageAgentId}
      usageActive={activeView === 'usage'}
      providerUpdates={providerUpdates.railEntries}
      theme={theme}
      phone={phone}
      hasVault={hasVault}
      hasReminders={hasReminders}
      hasMail={hasMail}
      hasArtifacts={hasArtifacts}
      hasBrowser={browserBridge !== undefined}
      doors={settingsDoors}
      onSelect={openDestination}
      onOpenUsage={openUsage}
      onOpenPin={openPinnedDm}
    />
  )

  // An empty house has nobody to talk to, so the first-run screens stand in for the
  // whole app until the first agent exists. `hasRoster` keeps a slow connection from
  // flashing them at a house that simply has not answered yet.
  if (emptyHouse) {
    return (
      <Onboarding
        profile={workspace.profile}
        connections={workspace.providerConnections}
        agents={workspace.agents}
        requestEvents={manor.requestEvents}
        onSaveProfile={manor.saveProfile}
        onCheckProviders={manor.checkProviders}
        onSignIn={manor.signInProvider}
        onCancelSignIn={manor.cancelProviderSignIn}
        onInstall={manor.installProvider}
        onSaveAgent={manor.saveAgent}
      />
    )
  }

  return (
    <LiveWorkspaceProvider live={manor.live}>
    <ExternalLinkProvider open={openWebsiteUrl}>
    <AutoRulesConfigProvider open={openAutoRules}>
      <FileMarkSprite />
      <BrowserWebviewHost bridge={browserBridge?.webviews} />
      {/* A filename an agent wrote in its reply leads to the panel, on the same terms
          the changed-files card gets: only what this chat's folders actually hold, so
          a chat with nothing to browse leaves the link as the prose it was. */}
      <RepoFileLinkProvider {...(canBrowseFiles ? { files: fileListing?.files } : {})} open={onOpenFile}>
      {/* The window's one notice stack: chat news, action confirmations and the house's
          own progress, in the top right corner under the bar, whatever the panels do.
          Outside the frame Settings makes inert, and above it, so what lands while
          Settings is open is seen and can be reached. In Mail it sits under the row of
          actions, so a notice never covers Archive or a reply's Close. */}
      <NoticeStack
        house={houseNotices}
        agents={workspace.agents}
        onOpen={openNoticeTarget}
        onUndo={(undo) => manor.undoNoticeWrite(undo.chatId, undo.writeId)}
        className={phone ? 'inset-x-2 top-2 items-center' : 'items-end'}
        {...(phone ? {} : { style: { top: TOP_BAR_HEIGHT + (destination === 'mail' ? MAIL_ACTIONS_HEIGHT : 8), right: FRAME_GUTTER + 8 } })}
      />
      {/* The L-frame: the top bar and the rail are one surface, and the sidebar and the
          stage sit together in the inset it frames. The phone has neither. */}
      <div
        className={phone ? 'flex h-full overflow-hidden bg-bg' : `grid h-full overflow-hidden ${focusMode ? 'bg-stage' : 'bg-frame'}`}
        style={phone ? undefined : focusMode ? FOCUS_FRAME_GRID : FRAME_GRID}
        {...(focusMode ? { 'data-focus-mode': '' } : {})}
        {...(settingsOpen ? COVERED : {})}
      >
      {/* The rail first in the page, the bar after it: the rail stays the first navigation
          landmark and the first stop for the keyboard, wherever the grid draws the bar. */}
      {phone ? null : (
        <SplitDragContext.Provider value={railGrab}>
          <div className={`frame-chrome col-start-1 row-start-2 min-h-0 ${focusMode ? 'hidden' : ''}`}>{navRail}</div>
        </SplitDragContext.Provider>
      )}
      {phone ? null : (
        <TopBar
          leadWidth={NAV_RAIL_WIDTH + (sidebarCollapsed || sidebarOverlay ? 0 : sidebarWidth)}
          railWidth={NAV_RAIL_WIDTH}
          animate={!sidebarResizing && motion !== 'instant'}
          split={splitShown ? { ratio: splitRatio, animate: !splitResizing } : null}
          status={status}
          covered={focusMode}
          sidebar={{ collapsed: sidebarCollapsed, ...(sidebarHandle === undefined ? {} : { onToggle: sidebarHandle }) }}
          // Back leaves a subagent view before it leaves the chat under it.
          history={{
            canBack: canBack || subagentOnStage,
            canForward,
            onBack: subagentOnStage ? () => popSubagentView(open.id) : goBack,
            onForward: goForward,
          }}
          onSearch={openSearch}
          slotRefs={barSlotRefs}
        />
      )}
      <div
        ref={stageCanvas}
        className={phone
          ? 'relative flex h-full min-w-0 flex-1'
          // Focus mode runs the stage up under the empty bar, so text scrolls to the window's edge.
          : `stage-canvas relative col-start-2 flex min-h-0 min-w-0 overflow-hidden bg-bg ${focusMode ? 'row-span-2 row-start-1' : 'row-start-2'}`}
        style={phone || focusMode ? undefined : INSET_FRAME}
      >
      <div
        className="relative grid h-full min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)] overflow-hidden bg-bg"
      >
      {/* The room a pinned sidebar takes up. The panel itself floats above this
          rather than filling it, so a peek slides in over the chat instead of
          reflowing it — and the chat always lands in the second track, never in
          this one when the sidebar is away. */}
      <div
        className={`h-full bg-bg ${sidebarResizing || motion === 'instant' ? '' : 'duration-200 ease-arrive motion-safe:transition-[width]'}`}
        style={{ width: sidebarCollapsed || sidebarOverlay || focusMode ? 0 : sidebarWidth }}
      />

      <SplitDragContext.Provider value={sidebarGrab}>
      <Sidebar
        chats={chatRows}
        inbox={chatInbox}
        agents={workspace.agents}
        panel={sidebarPanel}
        knowledgeSlot={setKnowledgeSlot}
        knowledgeActionSlot={setKnowledgeActionSlot}
        remindersSlot={setRemindersSlot}
        mailSlot={setMailSlot}
        mailActionSlot={setMailActionSlot}
        hasDirectory={workspace.hasDirectory}
        width={phone ? (sidebarPanel === null ? NAV_RAIL_WIDTH : viewportWidth) : sidebarWidth}
        mobile={phone}
        {...(phone ? { rail: navRail } : {})}
        // Folded, not toggled: leaving focus mode finds the sidebar as it was.
        collapsed={sidebarCollapsed || focusMode}
        overlay={sidebarOverlay}
        peeking={peeking && !focusMode}
        resizing={sidebarResizing}
        motion={motion}
        resizeProps={resizeProps}
        onToggle={toggleSidebar}
        onHoldPeek={holdPeek}
        activeView={activeView}
        canStartChat={canStartChat}
        {...(isHomeRoom(newChatProject.id) ? {} : { newChatProjectName: newChatProject.name })}
        draftAgentId={draftAgentId}
        notice={
          dialogOpen ? null : workspace.notice
        }
        onEditAgent={editAgent}
        onSetAgentPins={setAgentPins}
        onNewAgent={newAgent}
        onManageAgents={manageAgents}
        onStartChat={startChat}
        onOpenSearch={openSearch}
        onOpenChat={openChatFromSidebar}
        subagentGroups={sidebarSubagents}
        activeSubagents={Object.fromEntries(Object.entries(activeSubagents).filter(([chatId]) => occupiedChatIds.has(chatId)))}
        onOpenSubagent={openSubagent}
        {...(dropLane === 'work' ? { onOpenRight: openRight } : {})}
        {...(canSplit && (activeView === 'chat' || activeView === 'new-chat' || activeView === 'empty-chat')
          ? { occupiedChatIds }
          : {})}
        onOpenDm={openDm}
        onNewGroup={newGroup}
        onEditGroup={editGroup}
        onDeleteChat={manor.deleteChat}
        onSetChatArchived={manor.setChatArchived}
        onSetChatSettled={setChatSettled}
        onDismissNotice={manor.dismissNotice}
        projectThreads={threadRows}
        threadlessProjects={threadlessProjects}
        onCreateProjectThread={createProjectThread}
        onNewProjectThread={newProjectThread}
        onEditProject={editProject}
        onDeleteProject={deleteProject}
        onRemoveProjectThread={manor.removeProjectThread}
      />
      </SplitDragContext.Provider>
      <SplitDragLayer drag={splitDrag} />

      {newAgentKind !== null ? (
        <NewAgentDialog
          session={newAgentKind === 'session'}
          agents={workspace.agents}
          requestEvents={manor.requestEvents}
          onSaveAgent={manor.saveAgent}
          onCreated={(agentId) => {
            closeNewAgent()
            if (newAgentKind === 'session') settings.open('agents', agentId)
            else openDm(agentId)
          }}
          onClose={closeNewAgent}
        />
      ) : null}

      <WorkspaceDialogs
        manor={manor}
        chatRows={chatRows}
        chatInbox={chatInbox}
        searchInbox={searchInbox}
        threadRows={threadRows}
        runsByRoutine={runsByRoutine}
        open={open}
        projectDialog={projectDialog}
        onCloseProjectDialog={closeProjectDialog}
        managingAgents={managingAgents}
        onCloseManagingAgents={closeManagingAgents}
        onEditAgent={editAgent}
        onNewSessionAgent={newSessionAgent}
        groupDialog={groupDialog}
        onCloseGroup={closeGroup}
        onCreateGroup={createGroup}
        searchOpen={searchOpen}
        onCloseSearch={closeSearch}
        canStartChat={canStartChat}
        canOpenNoteBeside={hasVault && open !== null && activeView === 'chat' && !phone}
        reveals={reveals}
        onStartChat={startChat}
        onOpenChat={openChat}
        onShowPanel={showRightPanelFor}
        onOpenKnowledge={openKnowledge}
        onOpenReminders={openReminders}
        switcher={switcher}
      />

      {/* A failed view fails here, beside a working sidebar; moving to another view or chat clears it. */}
      <TopBarSlotContext.Provider value={stageSlot}>
      <ViewBoundary resetKey={`${activeView}:${open?.id ?? ''}`} loading={<div className="min-h-0 min-w-0 p-5 text-dim">Loading view…</div>}>
      {isDestinationView(activeView) ? (
        <DestinationView
          view={activeView}
          manor={manor}
          phone={phone}
          settingsOpen={settingsOpen}
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={sidebarHandle}
          slots={{ knowledge: knowledgeSlot, knowledgeAction: knowledgeActionSlot, reminders: remindersSlot, mail: mailSlot, mailAction: mailActionSlot }}
          noteRequest={noteRequest}
          onNoteRequestHandled={clearNoteRequest}
          reminderRequest={reveals.reminderRequest}
          onReminderRequestHandled={reveals.clearReminderRequest}
          browserBridge={browserBridge}
          browserPlace={browserPlace}
          stageWidth={stageWidth}
          renderSessionPane={(chat, trailing) => <StageChatPane kit={stageKit} chat={chat} side="right" pane={{ trailing }} />}
          chatRows={chatRows}
          chatInbox={chatInbox}
          open={open}
          pageContextsByChat={pageContextsByChat}
          onAddPageContext={addPageContext}
          newChatProject={newChatProject}
          creating={creating}
          runsByRoutine={runsByRoutine}
          routineDetail={routineDetail}
          pickedScheduledKind={pickedScheduledKind}
          onPickScheduledKind={setPickedScheduledKind}
          onSelectRoutine={selectRoutine}
          onOpenChat={openChat}
          onOpenDm={openDm}
          onStartChat={startChat}
          onShowBrowserPanel={showBrowserPanel}
          onOpenConnectors={openConnectors}
          onOpenSkills={openSkills}
          onOpenSuggestions={openSuggestions}
          onDialogChange={setEditingSettings}
          onLeaveUsage={leaveUsage}
        />
      ) : (
        <ChatStage
          kit={stageKit}
          draftSide={draftSide}
          railShown={railShown}
          browserShown={browserShown}
          barSlots={barSlots}
          canStartChat={canStartChat}
          theme={theme.theme}
        />
      )}
      </ViewBoundary>
      </TopBarSlotContext.Provider>
      </div>
      {/* Settings is a modal over the whole window while the workspace stays mounted and
          inert underneath, which is what makes closing exact: same thread, same scroll
          position, same unsent draft. */}
      <AnimatePresence>
      {settings.location === null ? null : (
        <SettingsLayer
          key="settings"
          location={settings.location}
          settings={settings}
          manor={manor}
          theme={theme}
          account={account}
          onNewAgent={newAgent}
          onEditAgent={editAgent}
          onDialogChange={setEditingSettings}
        />
      )}
      </AnimatePresence>
      </div>
      </div>
      </RepoFileLinkProvider>
    </AutoRulesConfigProvider>
    </ExternalLinkProvider>
    </LiveWorkspaceProvider>
  )
}

/** Every chat a stage pane shows: the split's panes, or the one chat on a stage without a split. */
function occupiedChatIdsOf(split: SplitStage | null, draftSide: 'left' | 'right' | null, stageChatId: string | null): Set<string> {
  if (split !== null) return new Set(occupiedSplitIds(split, draftSide))
  return new Set(stageChatId === null ? [] : [stageChatId])
}

/** The row of actions over a mail and over its reply, `min-h-14` in both. */
const MAIL_ACTIONS_HEIGHT = 56

/** The window under the Settings modal: mounted, but out of reach of focus, clicks and screen readers. */
const COVERED = { inert: '' }

/** The desktop window: the top bar across, the rail down the left, the inset in the corner they make. */
const FRAME_GRID = {
  gridTemplateColumns: `${NAV_RAIL_WIDTH}px minmax(0, 1fr)`,
  gridTemplateRows: `${TOP_BAR_HEIGHT}px minmax(0, 1fr)`,
  // What a surface inside the inset subtracts from the window to know its own height.
  '--top-bar-height': `${TOP_BAR_HEIGHT}px`,
  '--frame-gutter': `${FRAME_GUTTER}px`,
} as CSSProperties

/** Focus mode keeps the bar's row for the traffic lights and window drag; the rail's column goes. */
const FOCUS_FRAME_GRID = { ...FRAME_GRID, gridTemplateColumns: '0px minmax(0, 1fr)' } as CSSProperties

/**
 * The inset holding the sidebar and the stage: a frame gutter on the right and bottom,
 * and every corner concentric with a docked panel's (`--radius-frame`).
 */
const INSET_FRAME: CSSProperties = {
  marginRight: FRAME_GUTTER,
  marginBottom: FRAME_GUTTER,
  borderRadius: 'var(--radius-frame)',
}

