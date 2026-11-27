import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { SidebarLeftIcon, SidebarRightIcon } from '@hugeicons/core-free-icons'
import { BROWSER_HOME_SESSION_ID, DEFAULT_HOUSE_SETTINGS, NOTE_AI_DEFAULTS, type AgentConfig, type WorkflowSuggestion, type Chat, type PageContextAttachment, type Project, type Routine } from '@manor/contracts'
import { composioBinding } from '../connectors/composioCatalogue'
import { PluginsTabs, PluginsView } from '../plugins/PluginsView'
import { ScheduledTabs } from '../routines/ScheduledTabs'
import type { ChatDestination } from '../artifacts/AddToChatButton'
import { agentTargets, newSessionTarget } from '../AddToChatDialog'
import { retryableLazy } from '../RecoveryBoundary'
import { BrowserSessionEmpty, BrowserSessionMenu } from '../BrowserSessionMenu'
import { BrowserPanel } from '../BrowserPanel'
import type { WorkspaceView } from '../Sidebar'
import { BARE_ROWS, HEADED_ROWS, TopBarSlotContext, useTopBarSlot } from '../TopBar'
import { WorkspaceHeader } from '../WorkspaceHeader'
import { IconButton } from '../ui/IconButton'
import { NEW_CHAT_DRAFT_KEY, readDraft, writeDraft } from '../../composerDrafts'
import { suggestionPrompt } from '../../suggestionPrompt'
import { crossingTargets } from '../../browserCrossing'
import type { DesktopBrowserBridge } from '@manor/contracts'
import type { useBrowserPlace } from '../../useBrowserPlace'
import { useBrowserSessionPane } from '../../useFilesPanel'
import { shownKind, type ScheduleKind } from '../../routines'
import { withSessionTitle, type ChatListRow, type Inbox } from '../../state'
import type { Manor } from '../../useWorkspace'

const UsageView = retryableLazy(() => import('../usage/UsageView').then((module) => module.UsageView))
const ConnectorsView = retryableLazy(() => import('../connectors/ConnectorsView').then((module) => module.ConnectorsView))
const SkillsView = retryableLazy(() => import('../skills/SkillsView').then((module) => module.SkillsView))
const SuggestionsView = retryableLazy(() => import('../suggestions/SuggestionsView').then((module) => module.SuggestionsView))
const RoutinesView = retryableLazy(() => import('../routines/RoutinesView').then((module) => module.RoutinesView))
const KnowledgePanel = retryableLazy(() => import('../knowledge/KnowledgePanel').then((module) => module.KnowledgePanel))
const ArtifactsView = retryableLazy(() => import('../artifacts/ArtifactsView').then((module) => module.ArtifactsView))
const RemindersView = retryableLazy(() => import('../reminders/RemindersView').then((module) => module.RemindersView))
const MailView = retryableLazy(() => import('../mail/MailView').then((module) => module.MailView))

/** Every rail destination that is not the chat stage. */
export type DestinationViewId = Exclude<WorkspaceView, 'chat' | 'new-chat' | 'empty-chat'>

export const isDestinationView = (view: WorkspaceView): view is DestinationViewId =>
  view !== 'chat' && view !== 'new-chat' && view !== 'empty-chat'

/**
 * The stage when a rail door other than Agents or Sessions is open: Knowledge, the
 * Browser place, Reminders, Artifacts, Usage, Plugins and Scheduled tasks. Each is a
 * page of its own; the chat stage beside them stays with `Workspace`.
 */
export function DestinationView({
  view,
  manor,
  phone,
  settingsOpen,
  sidebarCollapsed,
  onToggleSidebar,
  slots,
  noteRequest,
  onNoteRequestHandled,
  reminderRequest,
  onReminderRequestHandled,
  browserBridge,
  browserPlace,
  stageWidth,
  renderSessionPane,
  chatRows,
  chatInbox,
  open,
  pageContextsByChat,
  onAddPageContext,
  newChatProject,
  creating,
  runsByRoutine,
  routineDetail,
  pickedScheduledKind,
  onPickScheduledKind,
  onSelectRoutine,
  onOpenChat,
  onOpenDm,
  onStartChat,
  onShowBrowserPanel,
  onOpenConnectors,
  onOpenSkills,
  onOpenSuggestions,
  onDialogChange,
  onLeaveUsage,
}: {
  view: DestinationViewId
  manor: Manor
  phone: boolean
  settingsOpen: boolean
  sidebarCollapsed: boolean
  /** The "show sidebar" handle, only where there is a sidebar to show. */
  onToggleSidebar: (() => void) | undefined
  /** Where Knowledge, Reminders and Mail portal their lists into the workspace sidebar. */
  slots: {
    knowledge: HTMLDivElement | null
    knowledgeAction: HTMLDivElement | null
    reminders: HTMLDivElement | null
    mail: HTMLDivElement | null
    mailAction: HTMLDivElement | null
  }
  noteRequest: { path: string; beside: string | null; id: number } | null
  onNoteRequestHandled: (id: number) => void
  reminderRequest: { reminderId: string; id: number } | null
  onReminderRequestHandled: (id: number) => void
  browserBridge: DesktopBrowserBridge | undefined
  browserPlace: ReturnType<typeof useBrowserPlace>
  stageWidth: number
  /** The Browser place's session column, drawn as the chat stage draws a pane. */
  renderSessionPane: (chat: Chat, trailing: ReactNode) => ReactNode
  chatRows: ChatListRow[]
  chatInbox: Inbox
  open: Chat | null
  pageContextsByChat: Record<string, PageContextAttachment[]>
  onAddPageContext: (chatId: string, context: PageContextAttachment) => void
  newChatProject: Project | undefined
  creating: boolean
  runsByRoutine: Record<string, Chat[]>
  routineDetail: Routine | undefined
  pickedScheduledKind: ScheduleKind | null
  onPickScheduledKind: (kind: ScheduleKind) => void
  onSelectRoutine: (routineId: string | null) => void
  onOpenChat: (chatId: string) => void
  /** An agent's DM, or the stage addressed to that agent when there is none yet. */
  onOpenDm: (agentId: string) => void
  onStartChat: () => void
  onShowBrowserPanel: (chatId: string) => void
  onOpenConnectors: () => void
  onOpenSkills: () => void
  onOpenSuggestions: () => void
  onDialogChange: (open: boolean) => void
  /** Escape on the Usage page: to wherever it was opened from. */
  onLeaveUsage: () => void
}) {
  const { workspace, status } = manor
  const sidebarToggle = onToggleSidebar === undefined ? {} : { onToggleSidebar }

  if (view === 'knowledge') {
    return (
      // No workspace header. On the desktop the note tree sits in the workspace
      // sidebar like Work's inbox; on the phone it stays this page's own top-left
      // column and carries the drawer handle, since no bar above it holds one.
      <KnowledgePanel
        vault={workspace.vault}
        status={status}
        // The desktop's handle is the top bar's; the phone page carries its own.
        sidebarCollapsed={phone && sidebarCollapsed}
        {...(onToggleSidebar === undefined || !phone ? {} : { onToggleSidebar })}
        {...(phone ? {} : { sidebarSlot: slots.knowledge, sidebarActionSlot: slots.knowledgeAction })}
        onList={manor.listVault}
        onCreateFolder={manor.createVaultFolder}
        onDelete={manor.deleteVaultEntry}
        onRename={manor.renameVaultFile}
        onMove={manor.moveVaultEntry}
        onOpen={manor.readVaultFile}
        onSave={manor.writeVaultFile}
        onClearWrite={manor.clearVaultWrite}
        onEditNote={manor.editVaultNote}
        onForgetNoteEdit={manor.forgetVaultNoteEdit}
        onSaveImage={manor.saveVaultImage}
        onForgetImageSave={manor.forgetVaultImageSave}
        noteAiModel={workspace.houseSettings?.noteAiModel ?? NOTE_AI_DEFAULTS.model}
        onClose={manor.closeVaultNote}
        shortcutsActive={!settingsOpen}
        {...(noteRequest !== null && noteRequest.beside === null ? { openRequest: noteRequest, onOpenRequestHandled: onNoteRequestHandled } : {})}
      />
    )
  }
  if (view === 'browser') {
    return (
      <BrowserPlace
        manor={manor}
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={onToggleSidebar}
        browserBridge={browserBridge}
        place={browserPlace}
        stageWidth={stageWidth}
        renderSessionPane={renderSessionPane}
        chatRows={chatRows}
        chatInbox={chatInbox}
        onOpenChat={onOpenChat}
        onShowBrowserPanel={onShowBrowserPanel}
      />
    )
  }
  if (view === 'reminders') {
    return (
      // Like Knowledge: tiles and lists in the workspace sidebar, the rest on the stage.
      <RemindersView
        reminders={workspace.reminders}
        status={status}
        requestEvents={manor.requestEvents}
        sidebarCollapsed={sidebarCollapsed}
        {...sidebarToggle}
        sidebarSlot={slots.reminders}
        onLoad={manor.loadReminders}
        onLoadCompleted={manor.loadCompletedReminders}
        onWrite={manor.writeReminder}
        selectRequest={reminderRequest}
        onSelectRequestHandled={onReminderRequestHandled}
      />
    )
  }
  if (view === 'mail') {
    return (
      // Like Reminders: the threads in the workspace sidebar, the open one on the stage.
      <MailView
        mail={workspace.mail}
        agents={workspace.agents}
        projects={workspace.projects}
        chats={workspace.chats}
        chatDoor={{
          staged: pageContextsByChat, creating, canStartChat: newChatProject !== undefined,
          stage: onAddPageContext, openChat: onOpenChat, openDm: onOpenDm, startChat: onStartChat,
        }}
        status={status}
        commands={manor.mailCommands}
        settingsOpen={settingsOpen}
        sidebarSlot={slots.mail}
        actionSlot={slots.mailAction}
        sidebarCollapsed={sidebarCollapsed}
        {...sidebarToggle}
      />
    )
  }
  if (view === 'artifacts') {
    return (
      <ArtifactsPage
        manor={manor}
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={onToggleSidebar}
        chatRows={chatRows}
        open={open}
        pageContextsByChat={pageContextsByChat}
        onAddPageContext={onAddPageContext}
        newChatProject={newChatProject}
        creating={creating}
        onOpenChat={onOpenChat}
        onOpenDm={onOpenDm}
        onStartChat={onStartChat}
      />
    )
  }
  if (view === 'usage') {
    return (
      <UsagePage
        manor={manor}
        phone={phone}
        escapeActive={!settingsOpen}
        sidebarCollapsed={sidebarCollapsed}
        sidebarToggle={sidebarToggle}
        onLeave={onLeaveUsage}
      />
    )
  }

  const plugins = view === 'skills' || view === 'connectors' || view === 'suggestions'
  const scheduledKind = shownKind(routineDetail, pickedScheduledKind)
  const switchScheduledKind = (next: ScheduleKind) => {
    if (next === scheduledKind) return
    onPickScheduledKind(next)
    onSelectRoutine(null)
  }
  /**
   * Always a fresh thread, never whichever chat happened to be open. Deciding what a
   * recurring workflow should become is its own conversation, and dropping that
   * prompt into a running one buries it under work it has nothing to do with.
   */
  const discussSuggestion = (suggestion: WorkflowSuggestion) => {
    const current = readDraft(NEW_CHAT_DRAFT_KEY)
    const prompt = suggestionPrompt(suggestion)
    writeDraft(NEW_CHAT_DRAFT_KEY, {
      ...current,
      text: current.text.trim() === '' ? prompt : `${current.text.trimEnd()}\n\n${prompt}`,
    })
    onStartChat()
  }
  return (
    <div className={`grid min-h-0 min-w-0 ${phone ? HEADED_ROWS : BARE_ROWS}`}>
      <WorkspaceHeader
        section={plugins ? 'plugins' : view}
        title={plugins ? 'Plugins' : view === 'routines' ? 'Scheduled tasks' : ''}
        accessory={plugins ? (
          <PluginsTabs
            section={view}
            onOpenConnectors={onOpenConnectors}
            onOpenSkills={onOpenSkills}
            onOpenSuggestions={onOpenSuggestions}
          />
        ) : workspace.hasRoutines ? (
          <ScheduledTabs kind={scheduledKind} onChange={switchScheduledKind} />
        ) : undefined}
        status={status}
        sidebarCollapsed={sidebarCollapsed}
        {...sidebarToggle}
      />
      {plugins ? (
        <PluginsView section={view}>
          {view === 'skills' ? (
            <SkillsView
              agents={workspace.agents}
              skills={workspace.skills}
              candidates={workspace.skillCandidates}
              notice={workspace.notice}
              requestEvents={manor.requestEvents}
              onListCandidates={manor.listSkillCandidates}
              onImport={manor.importSkill}
              onDelete={manor.deleteSkill}
              onDismissNotice={manor.dismissNotice}
              onDialogChange={onDialogChange}
            />
          ) : view === 'connectors' ? (
            <ConnectorsView
              agents={workspace.agents}
              registry={workspace.mcpServers}
              hostStatuses={workspace.mcpHostStatuses}
              mymind={workspace.artifacts.connection}
              notice={workspace.notice}
              requestEvents={manor.requestEvents}
              onSave={manor.saveMcpServer}
              onVerify={manor.verifyMcpServer}
              onVerifyMyMind={manor.verifyMyMind}
              onDelete={manor.deleteMcpServer}
              onDismissNotice={manor.dismissNotice}
              onDialogChange={onDialogChange}
              live={status === 'live'}
              composio={composioBinding(manor)}
              envFile={workspace.systemInfo?.envFile}
              onRequestInfo={manor.requestSystemInfo}
            />
          ) : (
            <SuggestionsView
              ledger={workspace.workflowSuggestions}
              canDiscuss={newChatProject !== undefined}
              onRefresh={manor.listWorkflowSuggestions}
              onDiscuss={discussSuggestion}
            />
          )}
        </PluginsView>
      ) : (
        <RoutinesView
          routines={workspace.routines}
          kind={scheduledKind}
          loaded={workspace.hasRoutines}
          runs={runsByRoutine}
          histories={workspace.routineHistories}
          projects={workspace.projects}
          chats={workspace.chats}
          agents={workspace.agents}
          notice={workspace.notice}
          requestEvents={manor.requestEvents}
          selectedId={routineDetail?.id ?? null}
          onSelect={onSelectRoutine}
          onOpenChat={onOpenChat}
          onRequestHistory={manor.getRoutineRuns}
          onMarkRunsRead={manor.markRoutineRunsRead}
          onMarkAllRunsRead={manor.markAllRoutineRunsRead}
          onSave={manor.saveRoutine}
          onDelete={manor.deleteRoutine}
          onSetEnabled={manor.setRoutineEnabled}
          onRunNow={manor.runRoutineNow}
          onDismissNotice={manor.dismissNotice}
          onDialogChange={onDialogChange}
        />
      )}
    </div>
  )
}

/**
 * The app-owned tab set: one reserved session that outlives every chat and, like a DM
 * strip, is remembered across idle teardown and restart. The session column beside it
 * is a chat of kind `browser`, so its tools drive the tab set on the left.
 */
function BrowserPlace({
  manor,
  sidebarCollapsed,
  onToggleSidebar,
  browserBridge,
  place,
  stageWidth,
  renderSessionPane,
  chatRows,
  chatInbox,
  onOpenChat,
  onShowBrowserPanel,
}: {
  manor: Manor
  sidebarCollapsed: boolean
  onToggleSidebar: (() => void) | undefined
  browserBridge: DesktopBrowserBridge | undefined
  place: ReturnType<typeof useBrowserPlace>
  stageWidth: number
  renderSessionPane: (chat: Chat, trailing: ReactNode) => ReactNode
  chatRows: ChatListRow[]
  chatInbox: Inbox
  onOpenChat: (chatId: string) => void
  onShowBrowserPanel: (chatId: string) => void
}) {
  const { workspace, status } = manor
  const sessionPane = useBrowserSessionPane(stageWidth)
  const crossing = useMemo(() => crossingTargets(chatRows, chatInbox), [chatRows, chatInbox])
  const openInChat = useCallback(async (chatId: string, url: string) => {
    if (browserBridge === undefined) return
    await browserBridge.newTab(chatId, url)
    onShowBrowserPanel(chatId)
    onOpenChat(chatId)
  }, [browserBridge, onShowBrowserPanel, onOpenChat])
  const { sessions, sessionChat, showSession, hidden, toggleHidden } = place
  // On the desktop the chat handle stands at the top bar's far end; without a bar it
  // ends the tab strip.
  const barSlot = useTopBarSlot()
  const chatToggle = (
    <IconButton icon={SidebarRightIcon} iconSize={17}
      label={hidden ? 'Show chat' : 'Hide chat'}
      aria-expanded={!hidden} onClick={toggleHidden} />
  )
  return (
    <div className="relative grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)]">
      {barSlot?.element == null ? null : createPortal(
        <>
          <div className="order-1 flex-1" />
          <div className="order-3 flex flex-none items-center">{chatToggle}</div>
        </>,
        barSlot.element,
      )}
      <div className="grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)_auto]">
      {/* Flush in the stage, edge to edge: the line on the session column is the only seam. */}
      <div className="grid min-h-0 min-w-0">
        <BrowserPanel
          stage
          chatId={BROWSER_HOME_SESSION_ID}
          bridge={browserBridge}
          activity={manor.browserActivity[BROWSER_HOME_SESSION_ID]}
          searchEngine={workspace.houseSettings?.browserSearchEngine ?? DEFAULT_HOUSE_SETTINGS.browserSearchEngine}
          settling={false}
          {...(manor.externalBrowser === null ? {} : { onOpenExternal: manor.openExternalUrl })}
          openInChatTargets={crossing}
          onOpenInChat={openInChat}
          stageLeadingControl={sidebarCollapsed && onToggleSidebar !== undefined ? (
            <IconButton icon={SidebarLeftIcon} iconSize={17}
              label="Show sidebar" title="Show sidebar (⌘S)"
              aria-expanded={false} onClick={onToggleSidebar} />
          ) : undefined}
          stageControl={barSlot === null ? chatToggle : undefined}
        />
      </div>
      {/* The session beside the page. It keeps its own session id, apart from the open chat.
          Hiding narrows the track while the column keeps its width, so it slides out
          rather than squeezing, and goes invisible (unfocusable) once it has left. */}
      <div className={`relative grid min-h-0 min-w-0 overflow-hidden ${sessionPane.resizing ? '' : 'duration-200 ease-arrive motion-safe:transition-[width]'}`}
        style={{ width: hidden ? 0 : sessionPane.width }}
        aria-hidden={hidden}>
      <div className="relative grid h-full min-h-0 border-l border-line"
        style={{ width: sessionPane.width, visibility: hidden ? 'hidden' : 'visible',
          transition: hidden ? 'visibility 0s 200ms' : 'none' }}>
        <div {...sessionPane.resizeProps}
          className="group absolute inset-y-0 left-0 z-30 w-2 touch-none cursor-col-resize outline-none">
          <div className={`pointer-events-none absolute inset-y-0 left-[3px] w-0.5 bg-primary transition-opacity duration-150 group-hover:opacity-40 group-focus-visible:opacity-60 ${
            sessionPane.resizing ? 'opacity-60' : 'opacity-0'}`} />
        </div>
        {/* A column beside the page, like a chat's own panels: its header stays on it
            rather than joining the top bar. */}
        <TopBarSlotContext.Provider value={null}>
        {sessionChat === null
          ? <BrowserSessionEmpty disabled={status !== 'live'} onNew={manor.createBrowserSession} />
          : renderSessionPane(sessionChat,
              <BrowserSessionMenu sessions={sessions} currentId={sessionChat.id}
                disabled={status !== 'live'} onNew={manor.createBrowserSession} onOpen={showSession} />)}
        </TopBarSlotContext.Provider>
      </div>
      </div>
      </div>
    </div>
  )
}

/**
 * Where Artifacts may hand sources, in the dialog's order: the chat on screen, a new
 * Session, every agent's DM, every live project thread, then the five Sessions and
 * groups spoken in most recently. No chat is offered twice.
 */
export function artifactsDestinations({ agents, chats, projects, chatRows, open, staged, canStartChat, creating }: {
  agents: readonly AgentConfig[]
  chats: readonly Chat[]
  projects: readonly Project[]
  chatRows: readonly ChatListRow[]
  open: Chat | null
  staged: Record<string, PageContextAttachment[]>
  canStartChat: boolean
  creating: boolean
}): ChatDestination[] {
  const usedIds = (key: string) => (staged[key] ?? []).map((context) => context.id)
  const live = chats.filter((chat) => chat.archivedAt === null)
  const threads = projects.flatMap((project): ChatDestination[] => {
    const chat = live.find((entry) => entry.id === project.threadChatId)
    return chat === undefined ? [] : [{ id: chat.id, kind: 'chat', label: project.name, owner: { project }, usedIds: usedIds(chat.id) }]
  })
  const dms = agentTargets({ agents, chats, staged, creating })
  // A DM's row carries the persona's current name, which beats the title frozen into
  // the chat when it was made; everything else is titled well enough by itself.
  const titleOf = (chat: Chat) => chatRows.find((row) => row.chat?.id === chat.id)?.title ?? withSessionTitle(chat).title
  // The chat on screen keeps its mark: a DM its agent's face, a thread its project's icon.
  const current = (chat: Chat): ChatDestination => {
    const same = [...dms, ...threads].find((target) => target.id === chat.id)
    return {
      id: chat.id, kind: 'chat', label: same?.label ?? titleOf(chat), detail: 'Current', usedIds: usedIds(chat.id),
      ...(same?.owner === undefined ? {} : { owner: same.owner }),
    }
  }
  // A run belongs to its routine and a side chat lives only in its panel: neither is a
  // room the stage can be moved to, so only Sessions and groups follow the rest.
  const recent = live
    .filter((chat) => (chat.kind === 'project' || chat.kind === 'group') && chat.id !== open?.id
      && !threads.some((target) => target.id === chat.id))
    .sort((a, b) => b.lastMessageAt - a.lastMessageAt)
    .slice(0, 5)
    .map((chat): ChatDestination => ({ id: chat.id, kind: 'chat', label: titleOf(chat), usedIds: usedIds(chat.id) }))
  const list = [
    ...(open === null ? [] : [current(open)]),
    newSessionTarget({ staged, canStart: canStartChat, creating }),
    ...dms,
    ...threads,
    ...recent,
  ]
  // The chat on screen leads and is not offered again lower down.
  return list.filter((target, index) => list.findIndex((other) => other.id === target.id) === index)
}

/**
 * mymind's library, with every chat it may hand sources to. Each carries what it already
 * holds, so a room with no slots left says so before it is picked rather than swallowing
 * the third attachment in silence.
 */
function ArtifactsPage({
  manor,
  sidebarCollapsed,
  onToggleSidebar,
  chatRows,
  open,
  pageContextsByChat,
  onAddPageContext,
  newChatProject,
  creating,
  onOpenChat,
  onOpenDm,
  onStartChat,
}: {
  manor: Manor
  sidebarCollapsed: boolean
  onToggleSidebar: (() => void) | undefined
  chatRows: ChatListRow[]
  open: Chat | null
  pageContextsByChat: Record<string, PageContextAttachment[]>
  onAddPageContext: (chatId: string, context: PageContextAttachment) => void
  newChatProject: Project | undefined
  creating: boolean
  onOpenChat: (chatId: string) => void
  onOpenDm: (agentId: string) => void
  onStartChat: () => void
}) {
  const { workspace, status } = manor
  const destinations = useMemo(() => artifactsDestinations({
    agents: workspace.agents, chats: workspace.chats, projects: workspace.projects, chatRows, open,
    staged: pageContextsByChat, canStartChat: newChatProject !== undefined, creating,
  }), [workspace.agents, workspace.chats, workspace.projects, chatRows, open, pageContextsByChat, newChatProject, creating])

  const addToChat = (contexts: PageContextAttachment[], destination: ChatDestination) => {
    for (const context of contexts) onAddPageContext(destination.id, context)
    // Going there is the point: the sources are staged in a composer, and a composer
    // nobody is looking at is an attachment that vanished.
    if (destination.id === NEW_CHAT_DRAFT_KEY) onStartChat()
    else if (destination.owner !== undefined && 'agent' in destination.owner) onOpenDm(destination.owner.agent.id)
    else onOpenChat(destination.id)
  }

  return (
    <ArtifactsView
      objects={workspace.artifacts.objects}
      spaces={workspace.artifacts.spaces}
      query={workspace.artifacts.query}
      loading={workspace.artifacts.askingQuery !== null}
      loadingMore={workspace.artifacts.loadingMore}
      hasMore={workspace.artifacts.hasMore}
      error={workspace.artifacts.error}
      destinations={destinations}
      attachedContexts={open === null ? [] : pageContextsByChat[open.id] ?? []}
      status={status}
      sidebarCollapsed={sidebarCollapsed}
      {...(onToggleSidebar === undefined ? {} : { onToggleSidebar })}
      onSearch={manor.listMyMindObjects}
      onLoadMore={manor.loadMoreMyMindObjects}
      onOpenSource={(url) => window.open(url, '_blank', 'noopener,noreferrer')}
      onAddToChat={addToChat}
    />
  )
}

/**
 * Usage as a page of its own, opened from the rings' pop-up or the account popover.
 * Its header is a plain title like the other top-level pages. Escape and the top bar's
 * Back return to where it was opened from; an Escape something else claimed
 * first (a select, a menu, a dialog, Settings over it) is left alone.
 */
function UsagePage({ manor, phone, escapeActive, sidebarCollapsed, sidebarToggle, onLeave }: {
  manor: Manor
  phone: boolean
  escapeActive: boolean
  sidebarCollapsed: boolean
  sidebarToggle: { onToggleSidebar?: () => void }
  onLeave: () => void
}) {
  const { workspace, status } = manor
  const leave = useRef(onLeave)
  leave.current = onLeave
  useEffect(() => {
    if (!escapeActive) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      leave.current()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [escapeActive])

  return (
    <div className={`grid min-h-0 min-w-0 ${phone ? HEADED_ROWS : BARE_ROWS}`}>
      <WorkspaceHeader
        section="usage"
        title="Usage"
        status={status}
        sidebarCollapsed={sidebarCollapsed}
        {...sidebarToggle}
      />
      <UsageView
        title="Usage"
        report={workspace.usageReport}
        providerUsage={workspace.providerUsage}
        status={status}
        onLoadReport={manor.loadUsageReport}
        onRefreshLimits={manor.refreshProviderUsage}
      />
    </div>
  )
}
