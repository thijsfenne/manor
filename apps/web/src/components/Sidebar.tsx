import { memo, useLayoutEffect, useState, type ComponentPropsWithoutRef, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import {
  AddTeam02Icon,
  Cancel01Icon,
  PlusSignIcon,
  UserMultiple02Icon,
  Search01Icon,
} from '@hugeicons/core-free-icons'
import type { AgentConfig, Project } from '@manor/contracts'
import type { SidebarPanel } from '../navDestination'
import type { ChatListRow, Inbox, Notice, ProjectThreadRow, SubagentGroup } from '../state'
import type { SidebarMotion } from '../useSidebar'
import { ChatListView, type AgentPins } from './chats/ChatListView'
import { AddAgentIcon } from './customIcons'
import { InboxView } from './inbox/InboxView'
import { ProjectThreadsSection } from './inbox/ProjectThreadsSection'
import { useSplitDragGrab } from './SplitDrag'
import { IconButton } from './ui/IconButton'
import { RequestNotice } from './ui/RequestNotice'

export type WorkspaceView =
  | 'chat'
  | 'new-chat'
  | 'empty-chat'
  | 'skills'
  | 'connectors'
  | 'suggestions'
  | 'routines'
  | 'knowledge'
  | 'reminders'
  | 'mail'
  | 'artifacts'
  | 'browser'
  | 'usage'

interface SidebarProps {
  /** Everyone in the household plus every group, for the Agents list. */
  chats: ChatListRow[]
  /** Every chat in the house, split settled from unsettled, for the Work list. */
  inbox: Inbox
  /** The household, so a row can put a face to the ids its chat carries. */
  agents: AgentConfig[]
  /**
   * Which destination's list the panel holds. Null only inside the phone drawer, for a
   * destination that brings no list: the drawer is then the rail and nothing else.
   */
  panel: SidebarPanel | null
  /**
   * Where the Knowledge page mounts its note tree. The tree keeps its state in the
   * page that edits the notes; the sidebar only lends it the place Work's inbox sits.
   */
  knowledgeSlot?: (node: HTMLDivElement | null) => void
  knowledgeActionSlot?: (node: HTMLDivElement | null) => void
  /** Where the Reminders door mounts its tiles and lists, on the same terms as Knowledge. */
  remindersSlot?: (node: HTMLDivElement | null) => void
  /** Where the Mail door mounts its search, tabs and cards, and its triage button in the title row. */
  mailSlot?: (node: HTMLDivElement | null) => void
  mailActionSlot?: (node: HTMLDivElement | null) => void
  hasDirectory: boolean
  width: number
  /** Phone lets this overlay own the whole viewport and makes its controls touch-sized. */
  mobile?: boolean
  /**
   * The navigation rail, handed in only for the phone drawer. On the desktop the rail
   * stands outside this panel, so folding the panel never takes the doors with it.
   */
  rail?: ReactNode
  /**
   * Folded away. The panel stays mounted rather than unmounting, so nothing it
   * holds is rebuilt on every fold; `visibility` carries the hidden state instead,
   * which also keeps the controls out of the tab order.
   */
  collapsed: boolean
  /** Floating over the stage because pinning it would break the chat width floor. */
  overlay: boolean
  /** Folded away, but floating in because the pointer is at the left edge. */
  peeking: boolean
  /** True while the right edge is actively being dragged. */
  resizing: boolean
  /** What moved the panel last, which is what sets the tempo it moves at. */
  motion: SidebarMotion
  resizeProps: ComponentPropsWithoutRef<'div'>
  activeView: WorkspaceView
  canStartChat: boolean
  newChatProjectName?: string
  /** The persona an unsent DM on the stage is addressed to; that row reads as selected. */
  draftAgentId: string | null
  notice: Notice | null
  /** Opens the persona form for one of the household, from her row in Agents. */
  onEditAgent: (agentId: string) => void
  /** Flips one of a persona's two pins from her row's menu. */
  onSetAgentPins: (agentId: string, pins: AgentPins) => void
  /** Opens an empty persona form: a new agent needs no conversation to exist. */
  onNewAgent: () => void
  /** Opens the list of personas that work in Sessions, which the Agents list leaves out. */
  onManageAgents: () => void
  onStartChat: () => void
  /** Opens the search palette over the workspace; the dialog itself lives above this panel. */
  onOpenSearch: () => void
  onOpenChat: (chatId: string) => void
  onOpenRight?: (chatId: string) => void
  occupiedChatIds?: ReadonlySet<string>
  /** A persona with no DM yet: the stage opens addressed to them, the chat waits. */
  onOpenDm: (agentId: string) => void
  /** Opens the group form, which lives above the sidebar because the stage uses it too. */
  onNewGroup: () => void
  onEditGroup: (chatId: string) => void
  onDeleteChat: (chatId: string) => void
  onSetChatArchived: (chatId: string, archived: boolean) => boolean
  /** Puts a chat down, or picks it back up. Only the Work list offers this. */
  onSetChatSettled: (chatId: string, settled: boolean) => boolean
  onDismissNotice: () => void
  /** The phone drawer's close. On the desktop the top bar holds the sidebar's handle. */
  onToggle: () => void
  /**
   * Claims and releases the peek on behalf of an overlay that hangs outside the
   * panel. Without it a hover card anchored to a peeking sidebar folds the sidebar
   * away the moment the pointer reaches for it.
   */
  onHoldPeek: (claim: boolean) => void
  /** Delegated children by parent chat id, nested under the rows that started them. */
  subagentGroups?: Record<string, SubagentGroup>
  /** The child whose view lies over each chat, which is the row that is active instead of the chat's own. */
  activeSubagents?: Readonly<Record<string, string>>
  /** Opens a parent with one child, or its whole list (null), in the Subagents panel. */
  onOpenSubagent?: (parentChatId: string, toolCallId: string | null) => void
  /** The Projects section above the Sessions list (2026-10-10). */
  projectThreads: ProjectThreadRow[]
  /** Projects without a thread, which the section's + offers. */
  threadlessProjects: Project[]
  onCreateProjectThread: (projectId: string) => void
  /** + then New project: the project form, and its thread once the project exists. */
  onNewProjectThread: () => void
  /** A project row's menu: the Edit project dialog, and the same dialog already asking to delete. */
  onEditProject: (projectId: string) => void
  onDeleteProject: (projectId: string) => void
  onRemoveProjectThread: (projectId: string) => void
}

const PANEL_TITLE: Record<SidebarPanel, string> = { work: 'Sessions', chats: 'Agents', knowledge: 'Knowledge', reminders: 'Reminders', mail: 'Mail' }

/** Arrow keys follow visible work rows across unsettled and settled; DMs stay separate. */
export function navigateSidebarRows(event: KeyboardEvent<HTMLElement>) {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing) return
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
  if (!(event.target instanceof Element)) return
  const current = event.target.closest<HTMLButtonElement>('button[data-sidebar-section]')
  if (current === null || !event.currentTarget.contains(current)) return
  const section = current.dataset.sidebarSection
  const sections = section === 'unsettled' || section === 'settled' ? ['unsettled', 'settled'] : [section]
  const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button[data-sidebar-section]')]
    .filter((row) => sections.includes(row.dataset.sidebarSection) && !row.disabled && !row.closest('.fold[data-open="false"]'))
  const index = rows.indexOf(current)
  if (index === -1) return
  event.preventDefault()
  const next = rows[index + (event.key === 'ArrowDown' ? 1 : -1)]
  if (next === undefined) return
  next.focus({ preventScroll: true })
  next.scrollIntoView({ block: 'nearest' })
  next.click()
}

/** The contextual panel beside the rail: the active destination's own list, nothing else. */
function SidebarNav({
  chats,
  inbox,
  agents,
  panel,
  knowledgeSlot,
  knowledgeActionSlot,
  remindersSlot,
  mailSlot,
  mailActionSlot,
  hasDirectory,
  width,
  mobile = false,
  rail,
  collapsed,
  overlay,
  peeking,
  resizing,
  motion,
  resizeProps,
  activeView,
  canStartChat,
  newChatProjectName,
  draftAgentId,
  notice,
  onEditAgent,
  onSetAgentPins,
  onNewAgent,
  onManageAgents,
  onStartChat,
  onOpenSearch,
  onOpenChat,
  onOpenRight,
  occupiedChatIds,
  onOpenDm,
  onNewGroup,
  onEditGroup,
  onDeleteChat,
  onSetChatArchived,
  onSetChatSettled,
  onDismissNotice,
  onToggle,
  onHoldPeek,
  subagentGroups,
  activeSubagents,
  onOpenSubagent,
  projectThreads,
  threadlessProjects,
  onCreateProjectThread,
  onNewProjectThread,
  onEditProject,
  onDeleteProject,
  onRemoveProjectThread,
}: SidebarProps) {
  const [armed, setArmed] = useState<string | null>(null)

  // Pinned open, the panel sits beside the chat. Floated in on a hover it sits
  // over the chat, but its border remains the only edge treatment in both states.
  const shown = !collapsed || peeking
  // A folded panel that keeps `translate` stays on its own compositor layer, and
  // that layer is what tiles the empty new-chat stage. The slide still uses
  // translate; rest drops it. Peek puts it back for one frame so the next slide
  // still has a from.
  const [parked, setParked] = useState(() => !shown)
  const [fromOffstage, setFromOffstage] = useState(false)
  useLayoutEffect(() => {
    if (shown) {
      if (parked) {
        setParked(false)
        // No slide to set up a starting point for.
        if (motion !== 'instant') setFromOffstage(true)
        return
      }
      if (!fromOffstage) return
      const frame = requestAnimationFrame(() => setFromOffstage(false))
      return () => cancelAnimationFrame(frame)
    }
    setFromOffstage(false)
    const ms = motion === 'instant' ? 0 : motion === 'peek' ? 100 : 200
    const hide = window.setTimeout(() => setParked(true), ms)
    return () => window.clearTimeout(hide)
  }, [shown, parked, fromOffstage, motion])
  const open = shown && !fromOffstage && !parked
  const rest = parked && !fromOffstage && !shown
  const title = panel === null ? null : PANEL_TITLE[panel]

  // Dragged beside the open thread, New session opens its draft in the other pane.
  const grab = useSplitDragGrab()
  const actionSize = mobile ? 44 : undefined
  const newSessionAction = (
    <IconButton
      icon={PlusSignIcon}
      iconSize={mobile ? 17 : 15}
      size={mobile ? 44 : 28}
      label="New session"
      disabled={!canStartChat}
      {...(grab !== null && canStartChat ? { onPointerDown: (event: PointerEvent<HTMLButtonElement>) => grab({ kind: 'new' }, event) } : {})}
      title={
        canStartChat
          ? newChatProjectName === undefined ? 'New session (⌘N)' : `New session in ${newChatProjectName} (⌘N)`
          : 'Manor is not connected'
      }
      onClick={onStartChat}
    />
  )
  const actions = panel === 'work' ? (
    <>
    <IconButton icon={UserMultiple02Icon} iconSize={17} size={actionSize} label="Manage agents" onClick={onManageAgents} />
    {mobile ? newSessionAction : null}
    </>
  ) : panel === 'chats' ? (
    <>
      <IconButton icon={AddTeam02Icon} iconSize={17} size={actionSize} label="New group" onClick={onNewGroup} />
      <IconButton icon={AddAgentIcon} iconSize={17} size={actionSize} label="New agent" onClick={onNewAgent} />
    </>
  ) : panel === 'knowledge' ? <div ref={knowledgeActionSlot} className="flex items-center" />
    : panel === 'mail' ? <div ref={mailActionSlot} className="flex items-center" /> : null
  const list = panel === 'work' ? (
    <div className="flex h-full flex-col">
    <ProjectThreadsSection
      rows={projectThreads}
      available={threadlessProjects}
      mobile={mobile}
      showSelection={activeView === 'chat'}
      {...(occupiedChatIds === undefined ? {} : { occupiedChatIds })}
      onOpen={onOpenChat}
      onCreate={onCreateProjectThread}
      onNewProject={onNewProjectThread}
      onEdit={onEditProject}
      onDelete={onDeleteProject}
      onRemove={onRemoveProjectThread}
    />
    {/* The desktop list leaves out sessions a project thread started; the phone keeps one list with every session. */}
    <div className={`flex flex-none items-center gap-1 pl-2 ${mobile ? 'h-11 pt-2' : 'mt-3 h-8'}`}>
      <h3 className="m-0 min-w-0 flex-1 truncate text-[12px] font-medium text-dim">{mobile ? 'Sessions' : 'Standalone sessions'}</h3>
      {mobile ? null : newSessionAction}
    </div>
    <div className="min-h-0 flex-1">
    <InboxView
      inbox={inbox}
      agents={agents}
      mobile={mobile}
      hasDirectory={hasDirectory}
      showChatSelection={activeView === 'chat'}
      armed={armed}
      onArm={setArmed}
      onOpenChat={onOpenChat}
      {...(onOpenRight === undefined ? {} : { onOpenRight })}
      {...(occupiedChatIds === undefined ? {} : { occupiedChatIds })}
      onDeleteChat={onDeleteChat}
      onSetSettled={onSetChatSettled}
      onSetArchived={onSetChatArchived}
      onHoldPeek={onHoldPeek}
      projectWorkOpen={projectThreads.some((row) => row.running > 0 || row.waiting)}
      {...(subagentGroups === undefined ? {} : { subagentGroups })}
      {...(activeSubagents === undefined ? {} : { activeSubagents })}
      {...(onOpenSubagent === undefined ? {} : { onOpenSubagent })}
    />
    </div>
    </div>
  ) : panel === 'chats' ? (
    <ChatListView
      rows={chats}
      agents={agents}
      hasDirectory={hasDirectory}
      showChatSelection={activeView === 'chat'}
      draftAgentId={draftAgentId}
      {...(occupiedChatIds === undefined ? {} : { occupiedChatIds })}
      armed={armed}
      onArm={setArmed}
      onOpenChat={onOpenChat}
      onOpenDm={onOpenDm}
      onEditAgent={onEditAgent}
      onEditGroup={onEditGroup}
      onDeleteChat={onDeleteChat}
      onSetPins={onSetAgentPins}
      {...(subagentGroups === undefined ? {} : { subagentGroups })}
      {...(activeSubagents === undefined ? {} : { activeSubagents })}
      {...(onOpenSubagent === undefined ? {} : { onOpenSubagent })}
    />
  ) : panel === 'knowledge' ? (
    <div ref={knowledgeSlot} className="min-w-0" />
  ) : panel === 'mail' ? (
    <div ref={mailSlot} className="min-w-0" />
  ) : panel === 'reminders' ? (
    <div ref={remindersSlot} className="min-w-0" />
  ) : null

  return (
    <nav
      // `translate`, not `transform`: Tailwind's translate utilities set the
      // translate property, so transitioning transform animates nothing.
      // On the desktop the panel is the inset's middle step, and its edge against the
      // stage is the frame's own colour.
      className={`absolute inset-y-0 left-0 z-10 flex border-r ${mobile ? 'border-line bg-surface' : 'sidebar-surface border-frame bg-sidebar'} ${
        motion === 'instant' ? '' : `ease-arrive motion-safe:transition-[translate,visibility] ${motion === 'peek' ? 'duration-100' : 'duration-200'}`
      } ${open ? 'visible translate-x-0' : rest ? '!hidden' : 'invisible -translate-x-full'}`}
      style={{ width }}
      aria-label={title === null ? 'Workspace navigation' : `${title} navigation`}
      onKeyDown={navigateSidebarRows}
      data-mobile-nav={mobile ? 'true' : undefined}
    >
      {rail}
      {title === null ? null : (
      <div className="grid min-w-0 flex-1 grid-rows-[auto_minmax(0,1fr)_auto]">
      {mobile ? (
        <div className="flex min-h-[56px] items-center gap-2 pr-[max(8px,env(safe-area-inset-right))] pl-3 pt-[env(safe-area-inset-top)]">
          <span className="min-w-0 flex-1 truncate font-display text-[16px] font-semibold tracking-[-0.01em] text-text">
            {title}
          </span>
          <div className="flex flex-none items-center gap-1">
            {actions}
            {panel === 'knowledge' ? null : <IconButton icon={Search01Icon} iconSize={17} size={44} label="Search" onClick={onOpenSearch} />}
            <IconButton
              icon={Cancel01Icon}
              iconSize={17}
              size={44}
              label="Close sidebar"
              onClick={onToggle}
            />
          </div>
        </div>
      ) : (
      // The window's controls moved up into the top bar, so the destination's name is
      // the panel's first row. pl-3 inside px-2.5 matches the rows below (scroll px-2.5
      // + button px-3), so the title starts on the same X as their icons.
      <div className="flex h-10 flex-none items-center px-2.5 pt-2 box-content">
        <h2 className="m-0 min-w-0 flex-1 truncate pl-3 font-display text-[16px] font-semibold tracking-[-0.01em]">{title}</h2>
        {/* Search lives in the top bar on the desktop, after Back and Forward. */}
        <div className="flex flex-none items-center">{actions}</div>
      </div>
      )}

      <div className="min-h-0 overflow-y-auto overscroll-y-none px-2.5 pb-4">{list}</div>

      {notice === null ? <div /> : (
        <div className={`border-t border-line p-1 ${mobile ? 'pb-[max(4px,env(safe-area-inset-bottom))]' : ''}`}>
          <RequestNotice className="px-2 py-1" notice={notice} onDismiss={onDismissNotice} />
        </div>
      )}
      </div>
      )}

      <div
        {...resizeProps}
        className={`${overlay || title === null ? 'hidden' : 'group'} absolute inset-y-0 right-[-4px] z-10 w-2 touch-none cursor-col-resize outline-none`}
      >
        <span
          className={`absolute inset-y-0 left-1/2 w-px -translate-x-1/2 ${
            resizing
              ? 'bg-primary'
              : 'bg-transparent group-hover:bg-muted group-focus-visible:bg-primary group-active:bg-primary'
          }`}
        />
      </div>

    </nav>
  )
}

/**
 * Memoised because the panel does not move while a persona streams, and without this
 * it re-rendered its whole list on every delta. It only holds if every caller keeps
 * its props stable, which is why `App` hands it callbacks rather than arrows and both
 * lists are memoised on the fields they read.
 */
export const Sidebar = memo(SidebarNav)
