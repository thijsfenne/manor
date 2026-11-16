import type { ReactNode } from 'react'
import { BotIcon, Cancel01Icon } from '@hugeicons/core-free-icons'
import { isFolder, isOpenRoom, type Chat, type DesktopBrowserBridge, type MessageQuote, type MessageReply, type NoteQuote, type PageContextAttachment } from '@manor/contracts'
import { ProjectSessionsOverview, SessionsOverviewDoor, SettleButton } from '../inbox/ProjectSessionsOverview'
import { ChatPane } from '../ChatPane'
import { ChatPanelRegion } from '../ChatPanelRegion'
import { BrowserPreview } from '../BrowserPreview'
import { ExternalLinkProvider } from '../ExternalLink'
import { ConnectCardProvider } from '../ConnectCards'
import { chatHelperFlags } from '../../chatHelpers'
import { chatRailItems, offersSideChat, type RailItem } from '../RightRail'
import { WorkspaceHeader } from '../WorkspaceHeader'
import { BARE_ROWS, HEADED_ROWS, TopBarSlotContext, type TopBarSlot } from '../TopBar'
import { IconButton } from '../ui/IconButton'
import { Button } from '../ui/Button'
import { DiffReviewContext } from '../session/diffReview'
import { SESSION_SCOPE } from '../session/DiffPanel'
import { DraftStage } from './DraftStage'
import { chatRoster } from '../../chatRoster'
import { chatHasRepo } from '../../sessionRepo'
import { splitPaneContentWidth } from '../../splitStage'
import {
  chatOf,
  ARCHIVE_KEEP_MS,
  isHomeRoom,
  roomOf,
  isProjectThread,
  participantIds,
  sitsSettled,
  threadOf,
  withSessionTitle,
  type SessionOverview,
  type TurnRow,
} from '../../state'
import type { useFloatingBrowser } from '../../useBrowserPlace'
import type { useChatDialogs } from '../../useChatDialogs'
import type { useChatReplies } from '../../useChatReplies'
import { insertQuoteIntoDraft } from '../../composerDrafts'
import type { usePageContexts } from '../../useChatSide'
import type { useOutboundDraftActions } from '../../useOutboundDraftActions'
import type { usePanelSelections } from '../../usePanelSelections'
import type { useRevealRequests } from '../../useRevealRequests'
import { layoutHas, offeredLayout, offeredPanels, type PanelLayout, type useRightPanel } from '../../useRightPanel'
import type { useSplitActions, useSplitStage } from '../../useSplitStage'
import type { Theme } from '../../useTheme'
import type { useWorkspaceNav } from '../../useWorkspaceNav'
import type { Manor } from '../../useWorkspace'

/** One empty list for every pane without page contexts, so the composer keeps its props. */
const NO_PAGE_CONTEXTS: PageContextAttachment[] = []

const NO_SESSIONS: SessionOverview = { waiting: [], working: [], settled: [], archived: [], archiveKeepMs: ARCHIVE_KEEP_MS }

/**
 * What every chat pane on the stage draws from, built by `Workspace` on each render. The
 * Browser place's session column is a pane too, so this travels there as well.
 */
export interface StageKit {
  manor: Manor
  phone: boolean
  /** The chat the stage is about: the one that was clicked, see `open` in `Workspace`. */
  open: Chat | null
  stage: ReturnType<typeof useSplitStage>
  split: ReturnType<typeof useSplitActions>
  nav: ReturnType<typeof useWorkspaceNav>
  dialogs: ReturnType<typeof useChatDialogs>
  rightPanel: ReturnType<typeof useRightPanel>
  panels: ReturnType<typeof usePanelSelections>
  replies: ReturnType<typeof useChatReplies>
  pageContexts: ReturnType<typeof usePageContexts>
  reveals: ReturnType<typeof useRevealRequests>
  floatingBrowser: ReturnType<typeof useFloatingBrowser>
  browserBridge: DesktopBrowserBridge | undefined
  /** The open chat's rail and what its region shows; each pane of a split works out its own. */
  railItems: RailItem[]
  activeLayout: PanelLayout
  /** The open chat's running turns. */
  running: TurnRow[]
  stageWidth: number
  hasVault: boolean
  settingsOpen: boolean
  focusMode: boolean
  /** The screen changed on the way into this render, so the panel region lands without motion. */
  chatSwitched: boolean
  /** The one pane whose region owns the native browser page. */
  browserViewChatId: string | undefined
  sidebarCollapsed: boolean
  onToggleSidebar: () => void
  /** The "show sidebar" handle, only where there is a sidebar to show. */
  sidebarHandle: (() => void) | undefined
  subagentPath: (chatId: string) => readonly string[]
  pushSubagentView: (chatId: string, toolCallId: string) => void
  popSubagentView: (chatId: string) => void
  draftActionsFor: ReturnType<typeof useOutboundDraftActions>
  sendToChat: Manor['sendToChat']
  openWebsiteUrl: (url: string, chatId?: string) => boolean
  sendToBrowser: (url: string) => Promise<void>
  openSessionDiff: (chatId: string) => void
  editAgent: (agentId: string) => void
  /** Opens the blank agent form set to a Session agent. */
  newSessionAgent: () => void
  leaveFocusMode: () => void
  onDialogChange: (open: boolean) => void
}

/**
 * The chat stage: one chat with its panel region, a split of two panes, a project thread
 * beside its sessions overview, or the new-chat draft. Every pane portals its header into
 * the top bar group above it.
 */
export function ChatStage({
  kit,
  draftSide,
  railShown,
  browserShown,
  barSlots,
  canStartChat,
  theme,
}: {
  kit: StageKit
  /** The pane a draft holds in a split, null when there is no draft in one. */
  draftSide: 'left' | 'right' | null
  railShown: boolean
  browserShown: boolean
  barSlots: { left: HTMLElement | null; right: HTMLElement | null }
  canStartChat: boolean
  theme: Theme
}) {
  const { manor, phone, open, stage, split, nav, dialogs, rightPanel, floatingBrowser, browserBridge, running, focusMode } = kit
  const { workspace, status } = manor
  const { visibleSplit, roomUp } = stage
  const { splitStage, splitRightPane, overviewShown, paneSplit } = split
  const { ratio: splitRatio, resizing: splitResizing, resizeProps: splitResizeProps } = stage.ratio
  const { newChatDraft } = dialogs
  const { sidebarCollapsed, onToggleSidebar: toggleSidebar, activeLayout, stageWidth } = kit
  const leftSplitChat = visibleSplit === null ? null : chatOf(workspace, visibleSplit.leftChatId)
  const rightSplitChat = visibleSplit === null ? null : chatOf(workspace, visibleSplit.rightChatId)

  const openProject = roomOf(workspace, open?.projectId)
  const draftProject = roomOf(workspace, dialogs.draftProjectId)
  // "No project" is the home room, so a draft sitting there reads as having none.
  const draftNamedProject = draftProject !== undefined && !isHomeRoom(draftProject.id) ? draftProject : undefined
  // The header names a draft's project only while the bar does: the home room stays under the hood.
  const headerProject = draftProject === undefined ? openProject : draftNamedProject
  const draftAgent = workspace.agents.find((agent) => agent.id === dialogs.draftAgentId)
  const singleChat = open?.mode === 'single'
  // A Single Session has an agents door only for its subagents.
  const agentsDoor = kit.railItems.find((item) => item.id === 'agents')
  const phoneAgentsDoor = agentsDoor !== undefined
  const phoneAgentsBusy = agentsDoor?.busy === true
  /** The persona an open DM is addressed to; a DM has no agents panel to set her in. */
  const dmAgent =
    open?.kind === 'dm' ? workspace.agents.find((agent) => agent.id === open.memberIds[0]) : undefined
  const pairAgents = newChatDraft === null && open?.kind === 'pair'
    ? open.memberIds.flatMap((id) => {
        const agent = workspace.agents.find((candidate) => candidate.id === id)
        return agent === undefined ? [] : [agent]
      })
    : []
  const pairTitle = pairAgents.map((agent) => agent.name).join(' ⇄ ')
  const headerAgent = draftAgent ?? dmAgent

  const paneSlot = (side: 'left' | 'right'): TopBarSlot | null =>
    phone ? null : { element: barSlots[side], focused: visibleSplit === null || roomUp || visibleSplit.focus === side }

  const renderEmptyPane = (side?: 'left' | 'right') => {
    const paneFocused = visibleSplit === null || visibleSplit.focus === side
    const focus = () => {
      if (side !== undefined && !paneFocused) split.focusSplitSide(side)
    }
    return (
      <div
        className={`relative grid h-full min-h-0 min-w-0 ${phone ? HEADED_ROWS : BARE_ROWS} bg-bg`}
        onPointerDown={focus}
        onFocusCapture={focus}
        data-focused={paneFocused ? 'true' : 'false'}
      >
        <WorkspaceHeader
          title="No session open"
          status={status}
          sidebarCollapsed={side !== 'right' && sidebarCollapsed}
          onToggleSidebar={toggleSidebar}
          trailing={side === undefined ? undefined : (
            <IconButton icon={Cancel01Icon} label="Close pane" onClick={() => split.closeSplitSide(side)} />
          )}
        />
        {paneFocused ? null : <div aria-hidden="true" className="split-focus-overlay" />}
        <main className="flex min-h-0 flex-col items-center justify-center gap-3 bg-bg px-5 text-center">
          <p className="m-0 text-dim">Open another session or start a new one.</p>
          <Button disabled={!canStartChat} onClick={() => {
            if (side !== undefined) stage.setSplitDraftSide(side)
            nav.startChat()
          }}>New session</Button>
        </main>
      </div>
    )
  }

  const renderDraftPane = (side: 'left' | 'right') => {
    const paneFocused = visibleSplit === null || visibleSplit.focus === side
    return (
      <div
        className="relative grid h-full min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_auto] bg-bg"
        onPointerDown={() => {
          if (visibleSplit !== null && visibleSplit.focus !== side) split.focusSplitSide(side)
        }}
        onFocusCapture={() => {
          if (visibleSplit !== null && visibleSplit.focus !== side) split.focusSplitSide(side)
        }}
        data-focused={paneFocused ? 'true' : 'false'}
      >
        <WorkspaceHeader
          title={newChatDraft?.target.kind === 'dm' ? 'New chat' : ''}
          persona={headerAgent}
          project={newChatDraft?.target.kind === 'dm' ? draftNamedProject : undefined}
          status={status}
          overlay
          sidebarCollapsed={side === 'left' ? sidebarCollapsed : false}
          onToggleSidebar={toggleSidebar}
          trailing={
            <span className="pointer-events-auto">
              <IconButton icon={Cancel01Icon} label="Close pane" onClick={() => split.closeSplitSide(side)} />
            </span>
          }
        />
        {paneFocused ? null : <div aria-hidden="true" className="split-focus-overlay" />}
        {newChatDraft === null ? null : (
          <DraftStage draft={newChatDraft} inPane phone={phone} theme={theme} manor={manor} dialogs={dialogs} pageContexts={kit.pageContexts} onNewSessionAgent={kit.newSessionAgent} />
        )}
      </div>
    )
  }

  const renderOverviewPane = (thread: Chat) => (
    <div className={`relative grid h-full min-h-0 min-w-0 ${phone ? HEADED_ROWS : BARE_ROWS} bg-bg`}>
      <WorkspaceHeader
        title="Sessions"
        status={status}
        sidebarCollapsed={false}
        trailing={<IconButton icon={Cancel01Icon} label="Close sessions" onClick={() => split.closeSessionsSide(thread.id)} />}
      />
      <main aria-label="Sessions overview" className="min-h-0 min-w-0 bg-bg pt-2">
        <ProjectSessionsOverview
          threadId={thread.id}
          overview={split.sessionOverview ?? NO_SESSIONS}
          agents={workspace.agents}
          onOpen={nav.openChat}
          onRevealProposal={(rowKey) => kit.reveals.reveal(thread.id, { rowKey })}
          onSetSettled={nav.setChatSettled}
          onSetArchived={manor.setChatArchived}
          onDeleteChat={manor.deleteChat}
          project={workspace.projects.find((entry) => entry.threadChatId === thread.id)}
          openLabel={(title) => `Open ${title} on the right`}
        />
      </main>
    </div>
  )

  /**
   * Two panes side by side at the shared ratio. Focus mode shows the focused one alone;
   * the other stays mounted but out of layout, so it comes back with its own state.
   */
  const renderSplitFrame = (left: ReactNode, right: ReactNode, focus: 'left' | 'right') => (
    <div className="relative grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)]">
      <div className="flex min-h-0 min-w-0">
        <div
          className={`min-h-0 min-w-0 ${splitResizing || focusMode ? '' : 'duration-[280ms] ease-[var(--ease-arrive)] motion-safe:transition-[flex-basis]'} ${focusMode && focus !== 'left' ? 'hidden' : ''}`}
          style={{ flex: focusMode ? '1 1 100%' : `0 1 ${splitRatio * 100}%` }}
        >
          <TopBarSlotContext.Provider value={paneSlot('left')}>{left}</TopBarSlotContext.Provider>
        </div>
        <div
          {...splitResizeProps}
          className={`relative z-10 w-0 flex-none cursor-col-resize touch-none outline-none ${focusMode ? 'hidden' : ''}`}
        >
          <div className="absolute inset-y-0 -left-1 w-2" />
        </div>
        <div
          ref={splitRightPane}
          className={`relative min-h-0 min-w-0 ${focusMode ? '' : 'border-l border-line'} ${splitResizing || focusMode ? '' : 'duration-[280ms] ease-[var(--ease-arrive)] motion-safe:transition-[flex-basis]'} ${focusMode && focus !== 'right' ? 'hidden' : ''}`}
          style={{ flex: focusMode ? '1 1 100%' : `0 1 ${(1 - splitRatio) * 100}%` }}
        >
          <TopBarSlotContext.Provider value={paneSlot('right')}>{right}</TopBarSlotContext.Provider>
        </div>
      </div>
    </div>
  )

  const chatPane = (chat: Chat, side: 'left' | 'right') => <StageChatPane kit={kit} chat={chat} side={side} />

  return (
    // The rail sits outside the positioned box below it, so an expanded files
    // panel covers the chat and never the way back out of it.
    <div className="grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)_auto] bg-bg">
    {/* The stage takes a sidebar drag anywhere, the chat's side panel included;
        the pane it would open is the right half, or the right pane of a split. */}
    <div ref={splitStage} className="relative grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)_auto] bg-bg">
      {/* The composer is a row, not an overlay. It grows with the draft, and a
          transcript that reserved a fixed strip for it lost its last message the
          moment the draft outgrew the guess. */}
      <div className="relative grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_auto] bg-bg">
      {visibleSplit !== null ? renderSplitFrame(
        draftSide === 'left' ? renderDraftPane('left') : leftSplitChat === null ? renderEmptyPane('left') : chatPane(leftSplitChat, 'left'),
        draftSide === 'right' ? renderDraftPane('right') : rightSplitChat === null ? renderEmptyPane('right') : chatPane(rightSplitChat, 'right'),
        visibleSplit.focus,
      ) : overviewShown && open !== null ? renderSplitFrame(chatPane(open, 'left'), renderOverviewPane(open), 'left')
      : nav.activeView === 'empty-chat' && newChatDraft === null ? renderEmptyPane() : open !== null && newChatDraft === null ? (
        <div className="relative grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)]">
          {floatingBrowser.floatingChatId === open.id && !focusMode ? (
            <div className="pointer-events-none absolute inset-x-4 top-4 z-[var(--z-browser-controls)] flex justify-end">
              <BrowserPreview key={open.id} chatId={open.id} bridge={browserBridge}
                activity={manor.browserUse[open.id]} sidebarOpen={browserShown}
                manual
                dismissed={floatingBrowser.isDismissed(open.id)}
                onDismiss={() => floatingBrowser.dismiss(open.id)}
                onOpen={() => { floatingBrowser.land(); rightPanel.show('browser') }}
                turns={running} onStop={manor.stopTurn}
              />
            </div>
          ) : null}
          {chatPane(open, 'left')}
        </div>
      ) : (
      <>
      {/* Names the chat the stage is about, which is the one that was clicked. No
          second "opening…" label beside it any more: the title is already that
          chat's, and a thread that is still on its way says so in its own space. */}
      <WorkspaceHeader
        title={newChatDraft === null ? (open?.kind === 'pair' ? pairTitle : (open === null ? 'No chat open' : withSessionTitle(open).title)) : newChatDraft.target.kind === 'dm' ? 'New chat' : ''}
        persona={headerAgent}
        {...(pairAgents.length === 0 ? {} : { pairPersonas: pairAgents })}
        project={newChatDraft === null ? (singleChat && open?.routineId != null ? undefined : headerProject) : newChatDraft.target.kind === 'dm' ? headerProject : undefined}
        {...(newChatDraft === null && singleChat && open?.routineId != null
          ? { section: 'routines' as const, parent: { label: 'Scheduled tasks', onClick: nav.openRoutines } }
          : {})}
        status={status}
        overlay
        sidebarCollapsed={sidebarCollapsed}
        phoneBack={phone}
        onToggleSidebar={toggleSidebar}
        trailing={
          !phone || open === null || open.kind === 'pair' || (singleChat && !phoneAgentsDoor) || newChatDraft !== null ? undefined : (
            <PhoneAgentsButton className="pointer-events-auto relative block" running={running.length > 0 || phoneAgentsBusy}
              selected={layoutHas(activeLayout, 'agents')} onClick={() => rightPanel.show('agents')} />
          )
        }
        {...(!phone && headerProject !== undefined && !isHomeRoom(headerProject.id) && !isFolder(headerProject)
          ? {
              onEditProject: () =>
                dialogs.openProjectDialog({ mode: 'edit', projectId: headerProject.id }),
            }
          : {})}
        {...(headerAgent === undefined
          ? {}
          : // The face in the header opens Agent settings beside the DM, as the rail door does.
            { onEditPersona: () => kit.editAgent(headerAgent.id) })}
      />

      {newChatDraft !== null ? (
        <DraftStage draft={newChatDraft} inPane={false} phone={phone} theme={theme} manor={manor} dialogs={dialogs} pageContexts={kit.pageContexts} onNewSessionAgent={kit.newSessionAgent} />
      ) : (
        <main className="flex min-h-0 min-w-0 justify-center bg-bg">
          <p className="mx-5 mt-14 mb-0 self-start text-dim">
            {emptyStage(workspace.hasDirectory, workspace.chats.length)}
          </p>
        </main>
      )}
      </>
      )}
      </div>

      {!paneSplit && open !== null && railShown ? <StagePanel kit={kit} chat={open} layout={activeLayout} availableWidth={stageWidth} /> : null}
    </div>

    </div>
  )
}

/**
 * One chat on the stage: alone, as either pane of a split, as the thread of a project
 * room, or as the Browser place's session column, which passes `pane` for its own
 * header controls and has no panels of its own.
 */
export function StageChatPane({
  kit,
  chat,
  side,
  pane,
}: {
  kit: StageKit
  chat: Chat
  side: 'left' | 'right'
  pane?: { trailing: ReactNode }
}) {
  const { manor, phone, open, stage, split, nav, dialogs, rightPanel, replies, reveals, focusMode } = kit
  const { workspace, status } = manor
  const { visibleSplit, roomUp, canSplit, roomThreadOf } = stage
  const { overviewShown, stageThreadId, sessionOverview, paneSplit, closeSessionsSide, showOverview } = split
  const { pageContextsByChat, removePageContext } = kit.pageContexts
  const { revealEvent, clearRevealEvent, reveal } = reveals
  // Methods by name: the compiler keys a call like `replies.set(…)` on `replies`, and every
  // object in the kit is new with each push, so a callback calling through it would be too.
  const { set: setReply, clear: clearReply, of: replyOf } = replies
  const { show: showPanel, showFor, toggleFor, layoutFor } = rightPanel
  const { openChat, setChatSettled, openRoutines, goBack } = nav
  const { focusSplitSide, closeSplitSide } = split
  const { openFileFor, reviewerFor } = kit.panels
  const { subagentPath, pushSubagentView, popSubagentView, draftActionsFor, leaveFocusMode, editAgent, openSessionDiff, sendToChat, openWebsiteUrl } = kit
  const { openProjectDialog, bornChat, newChatDraft } = dialogs
  // Both halves of a project room stay live: no scrim, no muted title (2026-10-11).
  const paneFocused = visibleSplit === null || roomUp || visibleSplit.focus === side
  // The thread's toggle for its sessions side, on the thread alone or as the left of its room.
  const sessionsShown = overviewShown || roomUp
  const overviewDoor = pane === undefined && side === 'left' && stageThreadId === chat.id && sessionOverview !== null ? (
      <SessionsOverviewDoor
        threadId={chat.id}
        shown={sessionsShown}
        overview={sessionOverview}
        agents={workspace.agents}
        onOpen={openChat}
        onRevealProposal={(rowKey) => reveal(chat.id, { rowKey })}
        onSetSettled={setChatSettled}
        onSetArchived={manor.setChatArchived}
        onDeleteChat={manor.deleteChat}
        project={workspace.projects.find((entry) => entry.threadChatId === chat.id)}
        {...(phone ? { size: 44 } : {})}
        {...(canSplit ? { onToggle: () => (sessionsShown ? closeSessionsSide(chat.id) : showOverview()) } : {})}
      />
    ) : null
  // A session its thread started is slim: no badge, its settle beside the Session door,
  // and a `Sessions` crumb back to the overview, or to the thread where it stands alone.
  const roomThreadId = pane === undefined ? roomThreadOf(chat.id) : undefined
  const settled = sitsSettled(workspace, chat)
  const settleControl = roomThreadId === undefined ? null : (
    <SettleButton settled={settled} {...(phone ? { size: 44 } : {})} onToggle={() => setChatSettled(chat.id, !settled)} />
  )
  const backToSessions = roomThreadId === undefined ? undefined
    : roomUp && side === 'right' ? showOverview
    : () => openChat(roomThreadId)
  const closePane = visibleSplit === null ? undefined
    : !roomUp ? () => closeSplitSide(side)
    : side === 'right' && visibleSplit.leftChatId !== null ? () => closeSessionsSide(visibleSplit.leftChatId!)
    : undefined
  const items = visibleSplit === null ? kit.railItems : paneRailFor(kit, chat)
  const paneLayout = visibleSplit === null
    ? kit.activeLayout
    : offeredLayout(layoutFor(chat.id), offeredPanels(items, phone))
  // The Browser place's session column has no panels of its own, and the phone opens
  // its one panel from the header's own button.
  const paneRail = pane !== undefined || phone ? undefined : {
    items,
    layout: paneLayout,
    // Against what is on screen, not what is stored: those differ for a chat that
    // cannot browse files, and a click on a visible panel must close that panel.
    onSelect: (id: RailItem['id']) => toggleFor(chat.id, id, paneLayout),
  }
  const agentsDoor = kit.railItems.find((item) => item.id === 'agents')
  const phoneAgents = !phone || open === null || open.kind === 'pair' || (open.mode === 'single' && agentsDoor === undefined) || newChatDraft !== null ? undefined : (
    <PhoneAgentsButton className="relative block" running={kit.running.length > 0 || agentsDoor?.busy === true}
      selected={layoutHas(kit.activeLayout, 'agents')} onClick={() => showPanel('agents')} />
  )
  const reply = replyOf(chat.id)
  return (
  <ExternalLinkProvider open={openWebsiteUrl} chatId={chat.id} picksPageContext={chat.kind !== 'browser' && chat.kind !== 'pair'}>
  <ConnectCardProvider chatId={chat.id} open={manor.openConnectCard} connected={status === 'live'}>
  <DiffReviewContext.Provider value={phone ? undefined : reviewerFor(chat.id)}>
  <ChatPane
    key={`${side}:${chat.id}`}
    chat={chat}
    workspace={workspace}
    status={status}
    phone={phone}
    focused={paneFocused}
    split={paneSplit || pane !== undefined}
    panel={!paneSplit ? null : (
      <StagePanel kit={kit} chat={chat} layout={paneLayout} availableWidth={splitPaneContentWidth(kit.stageWidth, stage.ratio.ratio, side)} />
    )}
    focusMode={focusMode}
    side={side}
    sidebarCollapsed={kit.sidebarCollapsed}
    {...(kit.sidebarHandle === undefined ? {} : { onToggleSidebar: kit.sidebarHandle })}
    {...(closePane === undefined ? {} : { onClose: closePane })}
    onFocus={() => {
      if (visibleSplit !== null && visibleSplit.focus !== side) focusSplitSide(side)
    }}
    {...(paneRail === undefined ? {} : { rail: paneRail })}
    {...(chat.projectId === null || !workspace.projects.some((project) => project.id === chat.projectId && !isFolder(project))
      ? {}
      : { onEditProject: () => openProjectDialog({ mode: 'edit', projectId: chat.projectId! }) })}
    onEditPersona={editAgent}
    onUndoNotes={manor.undoNotesUpdate}
    {...(revealEvent?.chatId === chat.id ? { revealEvent, onEventRevealed: clearRevealEvent } : {})}
    onAcceptWork={manor.acceptWorkHandoff}
    onOpenProjectThread={openChat}
    onRejectWork={manor.rejectWorkHandoff}
    onConfirmGoal={manor.confirmWorkGoal}
    onReviseGoal={manor.reviseWorkGoal}
    onRetryCompletion={manor.retryWorkCompletion}
    onApproveMergeFix={manor.approveMergeFix}
    onOpenDiff={openSessionDiff}
    askSessionRepo={manor.askSessionRepo}
    requestEvents={manor.requestEvents}
    onOpenAgentRelay={openChat}
    onOpenReport={(sessionId) => {
      // Focus mode hides a turn's work, where a report written before goal_reached sits.
      leaveFocusMode()
      openChat(sessionId)
      reveal(sessionId, { report: true })
    }}
    onOpenFile={(path) => openFileFor(chat, path)}
    subagentStage={{
      path: subagentPath(chat.id),
      open: (toolCallId) => pushSubagentView(chat.id, toolCallId),
      back: () => popSubagentView(chat.id),
      load: (childId) => manor.openSubagentThread(childId, chat.id),
      stop: (chatId, toolCallId) => manor.stopSubagent(chatId, toolCallId),
    }}
    {...(!offersSideChat(items) ? {} : {
      onAddToSideChat: (next: MessageQuote) => {
        insertQuoteIntoDraft(`side:${chat.id}`, { kind: 'message', ...next })
        showFor(chat.id, 'side')
      },
    })}
    onOpenRoutines={openRoutines}
    onGoBack={goBack}
    sendToChat={sendToChat}
    stopTurn={manor.stopTurn}
    stopBackground={manor.stopBackground}
    answerUserInput={manor.answerUserInput}
    answerSecretRequest={manor.answerSecretRequest}
    changeSessionAnswer={manor.changeSessionAnswer}
    setChatOverride={manor.setChatOverride}
    setChatCheckout={manor.setChatCheckout}
    askCheckoutStatus={manor.askCheckoutStatus}
    listRepoFiles={manor.listRepoFiles}
    setChatSettled={setChatSettled}
    pageContexts={pageContextsByChat[chat.id] ?? NO_PAGE_CONTEXTS}
    onRemovePageContext={(contextId) => removePageContext(chat.id, contextId)}
    {...(reply === undefined ? {} : { reply, onRemoveReply: () => clearReply(chat.id) })}
    {...(chat.kind === 'dm' || chat.kind === 'group'
      ? { onReply: (next: MessageReply) => setReply(chat.id, next) }
      : {})}
    {...(chat.kind === 'pair'
      ? {}
      : { onQuote: (next: MessageQuote) => insertQuoteIntoDraft(chat.id, { kind: 'message', ...next }) })}
    outboundActions={draftActionsFor(chat.id)}
    {...(pane !== undefined ? { trailing: pane.trailing }
      : settleControl !== null ? { trailing: phoneAgents !== undefined && agentsDoor !== undefined && visibleSplit === null ? <>{phoneAgents}{settleControl}</> : settleControl }
      : overviewDoor === null && visibleSplit === null && phoneAgents !== undefined ? { trailing: phoneAgents } : {})}
    {...(overviewDoor === null ? {} : { endControl: overviewDoor })}
    {...(backToSessions === undefined ? {} : { parent: { label: 'Sessions', onClick: backToSessions, back: true }, inRoom: true })}
    {...(bornChat !== null && bornChat.chatId === chat.id
      ? { birthPending: bornChat.sent }
      : {})}
  />
  </DiffReviewContext.Provider>
  </ConnectCardProvider>
  </ExternalLinkProvider>
  )
}

/** A chat's docked panel region: beside the stage's one chat, or inside its pane of a split. */
function StagePanel({ kit, chat, layout, availableWidth }: { kit: StageKit; chat: Chat; layout: PanelLayout; availableWidth: number }) {
  const { manor, rightPanel, panels, nav } = kit
  const { pageContextsByChat, addPageContext } = kit.pageContexts
  const { noteRequest, clearNoteRequest, reveal } = kit.reveals
  const { showFor, closeFor, moveFor, toggleFor } = rightPanel
  const { openFileFor, setDiffScope } = panels
  const { openWebsiteUrl } = kit
  const { roomThreadOf, visibleSplit } = kit.stage
  const { openGroupDialog } = kit.dialogs
  return (
  <ExternalLinkProvider open={openWebsiteUrl} chatId={chat.id} picksPageContext={chat.kind !== 'browser' && chat.kind !== 'pair'}>
  <ConnectCardProvider chatId={chat.id} open={manor.openConnectCard} connected={manor.status === 'live'}>
  <ChatPanelRegion
    key={chat.id}
    chat={chat}
    manor={manor}
    layout={layout}
    availableWidth={availableWidth}
    overlayResizable={visibleSplit !== null}
    floating={roomThreadOf(chat.id) !== undefined}
    // Holds the docked editors' window keys, which Settings must not leave live under it.
    // Focus mode hides the region (styles.css) without closing it, so its contents
    // stay mounted; it only gives up the keys and the native browser page meanwhile.
    focused={kit.open?.id === chat.id && !kit.settingsOpen && !kit.focusMode}
    ownsBrowserView={kit.browserViewChatId === chat.id && !kit.focusMode}
    phone={kit.phone}
    instant={visibleSplit === null && kit.chatSwitched}
    browserBridge={kit.browserBridge}
    selectedFile={panels.selectedFiles[chat.id] ?? null}
    setSelectedFiles={panels.setSelectedFiles}
    selectedNote={panels.selectedNotes[chat.id] ?? null}
    setSelectedNotes={panels.setSelectedNotes}
    pageContextCount={pageContextsByChat[chat.id]?.length ?? 0}
    onAddPageContext={(context) => addPageContext(chat.id, context)}
    onQuoteNote={(quote) => insertQuoteIntoDraft(chat.id, { kind: 'note', ...quote })}
    {...(!offersSideChat(paneRailFor(kit, chat)) ? {} : {
      onAddNoteToSideChat: (quote: NoteQuote) => {
        insertQuoteIntoDraft(`side:${chat.id}`, { kind: 'note', ...quote })
        showFor(chat.id, 'side')
      },
    })}
    onClose={(id, shown) => closeFor(chat.id, id, shown)}
    onMove={(id, target, drop, shown) => moveFor(chat.id, id, target, drop, shown)}
    onFloat={kit.floatingBrowser.float}
    {...(kit.browserBridge === undefined ? {} : { onSendToBrowser: kit.sendToBrowser, onOpenBrowser: nav.openBrowser })}
    onOpenChat={nav.openChat}
    onRevealMessage={(eventId) => reveal(chat.id, { eventId })}
    onOpenRoutine={nav.openRoutineDetail}
    onOpenRoutines={nav.openRoutines}
    onDialogChange={kit.onDialogChange}
    onEditGroup={() => openGroupDialog({ mode: 'edit', chatId: chat.id })}
    diffScope={panels.diffViews[chat.id] ?? SESSION_SCOPE}
    onDiffScope={(scope) => setDiffScope(chat.id, scope)}
    onToggleDiff={(shown) => toggleFor(chat.id, 'diff', shown, 'agents')}
    onOpenFile={(path) => openFileFor(chat, path)}
    subagentPath={kit.subagentPath(chat.id)}
    onOpenSubagent={(toolCallId) => kit.pushSubagentView(chat.id, toolCallId)}
    {...(noteRequest?.beside === chat.id ? { noteRequest, onNoteRequestHandled: clearNoteRequest } : {})}
  />
  </ConnectCardProvider>
  </ExternalLinkProvider>
  )
}

/** The rail a pane of a split offers for its own chat; the stage's one chat uses `StageKit.railItems`. */
function paneRailFor({ manor, phone, hasVault, browserBridge, stage, subagentPath }: StageKit, chat: Chat) {
  const { workspace, status } = manor
  const project = roomOf(workspace, chat.projectId)
  const paneThread = threadOf(workspace, chat.id)
  const ids = isOpenRoom(chat) ? participantIds(paneThread) : chat.memberIds
  return chatRailItems(chat, {
    phone,
    singleChat: chat.mode === 'single',
    hasProject: project !== undefined,
    canBrowseFiles: project !== undefined && project.repoPaths.length > 0 && status === 'live',
    hasVault,
    hasBrowser: browserBridge !== undefined,
    hasRoster: chatRoster(workspace.agents, chat, ids).length > 0,
    hasRepo: chatHasRepo(workspace, chat),
    projectThread: isProjectThread(workspace, chat.id),
    roomSession: stage.roomThreadOf(chat.id) !== undefined,
    ...chatHelperFlags(workspace, paneThread, chat, subagentPath(chat.id)),
  })
}

/** The phone's way to the agents panel, which it has no rail for; dotted while someone works. */
function PhoneAgentsButton({ className, running, selected, onClick }: {
  className: string
  running: boolean
  selected: boolean
  onClick: () => void
}) {
  return (
    <span className={className}>
      <IconButton
        icon={BotIcon}
        iconSize={18}
        size={44}
        label={running ? 'Agents, someone is working' : 'Agents in this chat'}
        selected={selected}
        onClick={onClick}
      />
      {!running ? null : (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute top-1 right-1 size-2 rounded-full bg-busy ring-2 ring-bg"
        />
      )}
    </span>
  )
}

function emptyStage(hasDirectory: boolean, chatCount: number) {
  if (!hasDirectory) return 'Connecting to the workspace…'
  if (chatCount === 0) return 'No chats yet. Create a project or a chat in the sidebar.'
  return 'Opening a chat…'
}
