import {
  Clock01Icon,
  Archive02Icon,
  ArrowLeft01Icon,
  CheckListIcon,
  DashboardSpeed02Icon,
  Note01Icon,
  PuzzleIcon,
  SidebarLeftIcon,
} from '@hugeicons/core-free-icons'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { AgentConfig, Project } from '@manor/contracts'
import type { ConnectionStatus } from '../useWorkspace'
import { isHomeRoom } from '../state'
import { projectIcon } from '../projectAppearance'
import { Avatar } from './Avatar'
import { Icon } from './Icon'
import { IconButton } from './ui/IconButton'
import { ProjectBadge } from './ProjectBadge'
import { RoleBadge } from './ui/RoleBadge'
import { ZoomableImage } from './ui/ZoomableImage'
import { AgentStack } from './inbox/AgentStack'
import { useTopBarSlot } from './TopBar'

interface WorkspaceHeaderProps {
  title: string
  /** A DM's fixed recipient, rendered as identity rather than as a plain chat title. */
  persona?: AgentConfig
  /** The two speakers of a standing view-only agent channel. */
  pairPersonas?: readonly AgentConfig[]
  project?: Project
  /**
   * A project's curated thread (2026-10-10): the room's own icon and name are the
   * title, with no badge, since the badge would only repeat the name beside it.
   */
  projectThread?: boolean
  section?: 'plugins' | 'routines' | 'knowledge' | 'reminders' | 'artifacts' | 'usage'
  /** A compact control that changes the named section, kept beside that section title. */
  accessory?: ReactNode
  /** Lets a feature-owned toolbar use the remaining header width. Compact switches stay content-sized. */
  accessoryGrow?: boolean
  /** A feature-owned control on the far edge of the header. */
  trailing?: ReactNode
  /**
   * The section a detail surface sits inside, rendered as the crumb before the title.
   * Only for a place one level down from a section; the header states the address, the
   * surface below it keeps its own way back.
   */
  parent?: {
    label: string
    onClick: () => void
    /** A way back to where the stage came from, so it leads with a back arrow: a room session's Sessions. */
    back?: boolean
    /** A long crumb, a parent title: it gives way before the title beside it does, down to an ellipsis. */
    shrinks?: boolean
  }
  /** Read only where the header is drawn in place (the phone); the top bar says it once on the desktop. */
  status: ConnectionStatus
  overlay?: boolean
  /**
   * The phone's drawer handle, which lives here because a control inside the panel it
   * hides cannot bring that panel back. On the desktop the top bar's lead area holds it.
   */
  sidebarCollapsed: boolean
  /** At phone width the sidebar is the previous screen, so its handle is a back arrow. */
  phoneBack?: boolean
  /**
   * Absent where the destination has no sidebar to bring back: the rail beside the
   * stage is the way on from there, and a handle for a panel that cannot appear lies.
   */
  onToggleSidebar?: () => void
  /**
   * Opens the project's edit dialog. The chip is the only surface a project still
   * has since the sidebar became the chat list, so managing one starts here.
   */
  onEditProject?: () => void
  /**
   * Opens the persona form for the DM's recipient. Given, the identity block becomes
   * one button, which costs the avatar its zoom: the form shows the same face and can
   * change it, and two acts on one target would need two handles where there is room
   * for one.
   */
  onEditPersona?: () => void
}

/**
 * The stable workspace context above every feature surface. On the desktop it is one
 * group in the window's top bar, above the pane it names; the pane reads which group
 * from context. The phone keeps it in place, over its own screen.
 */
export function WorkspaceHeader(props: WorkspaceHeaderProps) {
  const slot = useTopBarSlot()
  if (slot === null) return <PaneHeader {...props} />
  if (slot.element === null) return null
  const { trailing } = props
  return createPortal(
    <>
      <div className="order-1 flex min-w-0 flex-1 items-center gap-2">
        <Crumb {...props} compact muted={!slot.focused} />
      </div>
      {trailing === undefined ? null : <div className="order-3 flex flex-none items-center">{trailing}</div>}
    </>,
    slot.element,
  )
}

/** The phone's header, drawn over its own screen with the drawer handle beside it. */
function PaneHeader(props: WorkspaceHeaderProps) {
  const {
    trailing,
    status,
    overlay = false,
    sidebarCollapsed,
    phoneBack = false,
    onToggleSidebar,
  } = props

  return (
    <header
      // The left gutter grows by the titlebar inset only while the sidebar is away: with
      // the panel open it is the sidebar's own header that meets the traffic lights, and
      // this header starts well to their right. Transitioned at the panel's own duration
      // so the breadcrumb slides with it instead of jumping when it leaves.
      className={`flex min-h-[54px] min-w-0 gap-3 ${overlay ? '' : 'bg-gradient-to-b from-bg via-bg/90 to-transparent '}duration-200 ease-out motion-safe:transition-[padding-left] ${
        phoneBack
          ? 'items-center px-[max(12px,env(safe-area-inset-left))] py-2 pr-[max(12px,env(safe-area-inset-right))] pt-[max(8px,env(safe-area-inset-top))]'
          : sidebarCollapsed
          ? 'items-start pt-[var(--titlebar-row-pad)] pr-[18px] pl-[calc(1rem+var(--titlebar-inset))]'
          : 'items-center py-2.5 pr-[18px] pl-[18px]'
      } ${overlay ? 'pointer-events-none absolute inset-x-0 top-0 z-[5]' : 'relative'}`}
    >
      {/* Floating over the transcript, the backdrop runs past the header's own box so
          messages scrolling up are gone before they reach the title row. */}
      {overlay ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[76px] bg-gradient-to-b from-bg from-45% via-bg/90 via-70% to-transparent"
        />
      ) : null}
      {/* The window's drag handle while the sidebar is away, over the strip its controls
          already own. Kept to that strip on purpose: a header-wide drag region would
          swallow clicks on the messages this one floats over. */}
      {!sidebarCollapsed || phoneBack ? null : (
        <div
          aria-hidden="true"
          className="drag-region pointer-events-auto absolute top-0 left-0 h-full w-[var(--titlebar-inset)]"
        />
      )}

      {/* Only while the sidebar is away: with the panel open its own toggle is on
          screen, and two handles for one act is one too many. pointer-events-auto
          for the same reason as the save button below. */}
      {!sidebarCollapsed || onToggleSidebar === undefined ? null : (
        <IconButton
          className="pointer-events-auto"
          icon={phoneBack ? ArrowLeft01Icon : SidebarLeftIcon}
          iconSize={17}
          size={phoneBack ? 44 : undefined}
          label={phoneBack ? 'Back to Sessions' : 'Show sidebar'}
          title={phoneBack ? 'Back to Sessions' : 'Show sidebar (⌘S)'}
          aria-expanded={false}
          onClick={onToggleSidebar}
        />
      )}

      {/* min-h-8: with the sidebar away the header aligns to the top so the toggle
          lands on the traffic lights, which would leave the shorter title row floating
          above that button's centre. Matching the 32px button height puts them on one
          line again, and with the sidebar open the row is already that tall. */}
      <div className="flex min-h-8 min-w-0 flex-1 items-center gap-2">
        <Crumb {...props} />
      </div>

      {trailing === undefined ? null : <div className="flex-none">{trailing}</div>}

      {status === 'live' ? null : (
        <span className="flex-none text-meta font-medium text-dim">
          {status === 'connecting' ? 'Connecting…' : 'Offline'}
        </span>
      )}
    </header>
  )
}

/**
 * Where the stage is: a room and its chat, a section, or the persona a DM is with.
 * `compact` is the top bar's row, with its 20px faces; `muted` is an unfocused pane.
 */
function Crumb({
  title,
  persona,
  pairPersonas,
  project,
  projectThread = false,
  section,
  accessory,
  accessoryGrow = false,
  parent,
  onEditProject,
  onEditPersona,
  compact = false,
  muted = false,
}: WorkspaceHeaderProps & { compact?: boolean; muted?: boolean }) {
  const face = compact ? 20 : 36
  const titleTone = muted ? 'text-muted' : 'text-text'
  if (projectThread && project !== undefined && persona === undefined) {
    const mark = (
      <>
        <Icon icon={projectIcon(project.icon)} size={compact ? 16 : 18} className="flex-none" style={{ color: project.color }} />
        <span className={`min-w-0 truncate text-[14px] font-semibold tracking-[-0.01em] ${titleTone}`}>{project.name}</span>
      </>
    )
    return (
      <>
        {onEditProject === undefined ? (
          <span className="flex min-w-0 items-center gap-2" title={projectTitle(project)}>{mark}</span>
        ) : (
          <button
            type="button"
            className="pointer-events-auto -mx-1.5 flex min-w-0 cursor-pointer items-center gap-2 rounded-lg border-0 bg-transparent px-1.5 py-1 text-left [font:inherit] hover:bg-surface-2"
            title={`${projectTitle(project)}\nEdit project`}
            aria-label={`${project.name}, edit project`}
            onClick={onEditProject}
          >
            {mark}
          </button>
        )}
        {accessory === undefined ? null : (
          <div className={accessoryGrow ? 'ml-1 min-w-0 flex-1' : 'ml-1 flex-none'}>{accessory}</div>
        )}
      </>
    )
  }
  // The chip belongs to a Session. One without a project, in the home room, wears none.
  const noProject = project !== undefined && isHomeRoom(project.id)
  const chipTitle = project === undefined ? '' : projectTitle(project)
  const projectBadge = project === undefined ? null : (
    <ProjectBadge name={project.name} icon={project.icon} color={project.color} className="shrink-0" />
  )

  return (
    <>
      {pairPersonas !== undefined && pairPersonas.length > 0 ? (
        <>
          {compact ? (
            <AgentStack agentIds={pairPersonas.map((member) => member.id)} agents={[...pairPersonas]} size={face} />
          ) : (
            <AgentStack
              agentIds={pairPersonas.map((member) => member.id)}
              agents={[...pairPersonas]}
              size={28}
              footprint={46}
            />
          )}
          <span className={`min-w-10 truncate text-[14px] font-semibold tracking-[-0.01em] ${titleTone}`}>{title}</span>
        </>
      ) : persona !== undefined ? (
        onEditPersona !== undefined ? (
          <button
            type="button"
            // pointer-events-auto for the same reason the project chip has it: the
            // overlay header swallows clicks otherwise.
            className="pointer-events-auto -mx-1.5 flex min-w-0 cursor-pointer items-center gap-2 rounded-lg border-0 bg-transparent px-1.5 py-1 text-left [font:inherit] hover:bg-surface-2"
            title={`Edit ${persona.name}`}
            aria-label={`Edit ${persona.name}`}
            onClick={onEditPersona}
          >
            <Avatar name={persona.name} color={persona.color} src={persona.avatar} shape={persona.avatarShape} tone={persona.avatarTone} size={face} />
            <PersonaLabel persona={persona} tone={titleTone} />
          </button>
        ) : (
          <>
            {persona.avatar === undefined || persona.avatar === '' ? (
              <Avatar name={persona.name} color={persona.color} shape={persona.avatarShape} tone={persona.avatarTone} size={face} />
            ) : (
              <ZoomableImage
                src={persona.avatar}
                alt={`${persona.name} avatar`}
                frame="pointer-events-auto rounded-full"
                thumbnail={<Avatar name={persona.name} color={persona.color} src={persona.avatar} shape={persona.avatarShape} tone={persona.avatarTone} size={face} />}
                zoomedClassName="size-80"
                zoomedContent={
                  <Avatar name={persona.name} color={persona.color} src={persona.avatar} shape={persona.avatarShape} tone={persona.avatarTone} size={320} />
                }
                zoomFromThumbnail
              />
            )}
            <PersonaLabel persona={persona} tone={titleTone} />
          </>
        )
      ) : project === undefined ? (
        section === 'plugins' ? (
          <Icon icon={PuzzleIcon} size={17} className="flex-none text-muted" />
        ) : section === 'routines' ? (
          <Icon icon={Clock01Icon} size={17} className="flex-none text-muted" />
        ) : section === 'knowledge' ? (
          <Icon icon={Note01Icon} size={17} className="flex-none text-muted" />
        ) : section === 'reminders' ? (
          <Icon icon={CheckListIcon} size={17} className="flex-none text-muted" />
        ) : section === 'artifacts' ? (
          <Icon icon={Archive02Icon} size={17} className="flex-none text-muted" />
        ) : section === 'usage' ? (
          // The same mark the sidebar row wears, so the two read as one place seen
          // from two distances rather than as two features.
          <Icon icon={DashboardSpeed02Icon} size={17} className="flex-none text-muted" />
        ) : null
      ) : null}
      {parent === undefined || persona !== undefined ? null : (
        <>
          <button
            type="button"
            // pointer-events-auto for the same reason the project chip has it: the
            // overlay header swallows clicks otherwise.
            className={`pointer-events-auto -mx-1.5 flex cursor-pointer items-center rounded-lg border-0 bg-transparent px-1.5 py-1 text-muted [font:inherit] hover:bg-surface-2 hover:text-text ${parent.back === true ? 'gap-1' : ''} ${parent.shrinks === true ? 'min-w-9 shrink-[1000]' : 'flex-none'}`}
            {...(parent.shrinks === true ? { title: parent.label, 'aria-label': `Open parent: ${parent.label}` } : {})}
            onClick={parent.onClick}
          >
            {parent.back === true ? <Icon icon={ArrowLeft01Icon} size={15} className="flex-none" /> : null}
            {/* Sized on the span: `[font:inherit]` on the button outranks a text-size utility
                there. A way back matches the title beside it; a section crumb stays larger. */}
            <span className={`${parent.back === true || parent.shrinks === true ? 'text-[14px] font-medium' : 'text-[15px] font-medium'} ${parent.shrinks === true ? 'min-w-0 truncate' : ''}`}>{parent.label}</span>
          </button>
          <span aria-hidden="true" className="flex-none text-[17px] font-medium text-dim/55">
            /
          </span>
        </>
      )}
      {persona === undefined && (pairPersonas === undefined || pairPersonas.length === 0) ? (
        <span className={`min-w-0 truncate text-[14px] font-semibold tracking-[-0.01em] ${titleTone}`}>{title}</span>
      ) : null}
      {project === undefined || noProject || persona !== undefined || (pairPersonas !== undefined && pairPersonas.length > 0) ? null : (
        <span className="flex flex-none items-center whitespace-nowrap" title={chipTitle}>
          {onEditProject === undefined ? projectBadge : (
            <button
              type="button"
              className="pointer-events-auto flex cursor-pointer items-center rounded-chip border-0 bg-transparent p-0 [font:inherit] hover:brightness-95"
              title={`${chipTitle}\nEdit project`}
              aria-label="Edit project"
              onClick={onEditProject}
            >
              {projectBadge}
            </button>
          )}
        </span>
      )}
      {accessory === undefined ? null : (
        <div className={accessoryGrow ? 'ml-1 min-w-0 flex-1' : 'ml-1 flex-none'}>{accessory}</div>
      )}
    </>
  )
}

/**
 * Who the DM is with: her name with the same quiet role badge as the inbox beside it.
 * No model line under it: the composer is the one place a DM's runtime is shown and
 * changed, and a second read-out here was a third value to keep in step. The badge
 * never shrinks, because a role cut to "E…" names nobody; the name gives way instead.
 */
function PersonaLabel({ persona, tone }: { persona: AgentConfig; tone: string }) {
  return (
    <span className="flex min-w-0 max-w-full items-center gap-1.5 leading-none">
      <span className={`min-w-0 shrink truncate text-[14px] font-semibold tracking-[-0.01em] ${tone}`}>{persona.name}</span>
      {persona.role === '' ? null : (
        <span className="flex-none">
          <RoleBadge label={persona.role} />
        </span>
      )}
    </span>
  )
}

/** The room's identity plus its concrete working context, on hover. */
function projectTitle(project: Project): string {
  return project.repoPaths.length === 0 ? project.name : `${project.name}\n${project.repoPaths.join('\n')}`
}
