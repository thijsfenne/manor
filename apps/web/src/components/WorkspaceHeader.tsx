import {
  Clock01Icon,
  Archive02Icon,
  ArrowLeft01Icon,
  ArrowLeftRightIcon,
  CheckListIcon,
  DashboardSpeed02Icon,
  Mail01Icon,
  Note01Icon,
  PuzzleIcon,
  SidebarLeftIcon,
} from '@hugeicons/core-free-icons'
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { AgentConfig, Project } from '@manor/contracts'
import type { ConnectionStatus } from '../useWorkspace'
import { isHomeRoom } from '../state'
import { ProjectMark } from './ProjectMark'
import { markLetters } from '../projectAppearance'
import { Avatar } from './Avatar'
import { Icon } from './Icon'
import { IconButton } from './ui/IconButton'
import { ProjectBadge } from './ProjectBadge'
import { RoleBadge } from './ui/RoleBadge'
import { ZoomableImage } from './ui/ZoomableImage'
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
  section?: 'plugins' | 'routines' | 'knowledge' | 'reminders' | 'mail' | 'artifacts' | 'usage'
  /** A compact control that changes the named section, kept beside that section title. */
  accessory?: ReactNode
  /** Lets a feature-owned toolbar use the remaining header width. Compact switches stay content-sized. */
  accessoryGrow?: boolean
  /** A feature-owned control on the far edge of the header. */
  trailing?: ReactNode
  /**
   * The desktop top bar only: a one-agent DM's model control, just before the trailing
   * icons. It gives way first in a narrow pane, so name, role and icons keep their room.
   */
  runtime?: ReactNode
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
  const { trailing, runtime } = props
  return createPortal(
    <>
      {/* With a runtime beside it the crumb starts from its own width, so the far
          stronger shrink on the runtime spends that one first. */}
      <div data-top-bar-crumb="" className={`order-1 flex min-w-0 items-center gap-2 ${runtime === undefined ? 'flex-1' : 'flex-[1_1_auto]'}`}>
        <Crumb {...props} compact muted={!slot.focused} />
      </div>
      {runtime === undefined ? null : (
        <TopBarRuntime divider={trailing !== undefined}>{runtime}</TopBarRuntime>
      )}
      {trailing === undefined ? null : <div className="order-3 flex flex-none items-center">{trailing}</div>}
    </>,
    slot.element,
  )
}

/**
 * A control at the top bar's far end that gives way before the crumb does. Shown whole
 * or not at all: once it no longer fits it wraps onto a second line the fixed height
 * clips, since a cut-down model name beside a divider says nothing. The empty first
 * item keeps that first line open. Wrapped away it is inert too, so it leaves the tab
 * order. Only the outer box is positioned, so a card the control opens hangs off it
 * and escapes the clip.
 */
function TopBarRuntime({ divider, children }: { divider: boolean; children: ReactNode }) {
  const clipRef = useRef<HTMLDivElement>(null)
  const itemRef = useRef<HTMLSpanElement>(null)
  const [shown, setShown] = useState(true)
  useEffect(() => {
    const clip = clipRef.current
    const item = itemRef.current
    if (clip === null || item === null) return
    // By ratio: wrapped onto the clipped line the item still touches the box's edge,
    // which counts as intersecting.
    const observer = new IntersectionObserver(([entry]) => setShown((entry?.intersectionRatio ?? 0) > 0.5), { root: clip, threshold: [0, 1] })
    observer.observe(item)
    return () => observer.disconnect()
  }, [])
  return (
    <div data-top-bar-runtime="" className={`relative order-3 flex min-w-0 shrink-[1000] items-center ${divider ? '-mr-1' : ''}`}>
      <div ref={clipRef} className="flex h-7 min-w-0 flex-wrap items-start overflow-hidden">
        <span aria-hidden="true" className="h-7 w-0" />
        {/* Invisible as well as inert, so a card it had open hides with it. */}
        <span ref={itemRef} className={`flex h-7 flex-none items-center gap-2 ${shown ? '' : 'invisible'}`} {...(shown ? {} : { inert: '' })}>
          {children}
          {divider ? <span aria-hidden="true" className="h-4 w-px bg-line" /> : null}
        </span>
      </div>
    </div>
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
      className={`flex min-h-[54px] min-w-0 gap-3 ${overlay ? '' : 'bg-gradient-to-b from-bg via-bg/90 to-transparent '}duration-200 ease-arrive motion-safe:transition-[padding-left] ${
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
        <ProjectMark icon={project.icon} color={project.color} src={project.repoIconSrc} letters={markLetters(project)} size={compact ? 16 : 18} />
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
  // The chip takes under half the row, as a role badge does in the inbox, and the title
  // the rest: with a long title and a long project name both stay readable and neither
  // runs under the panel doors.
  const withChip = project !== undefined && !noProject && persona === undefined && (pairPersonas === undefined || pairPersonas.length === 0)
  const projectBadge = project === undefined ? null : (
    <ProjectBadge name={project.name} icon={project.icon} color={project.color} iconSrc={project.repoIconSrc} letters={markLetters(project)} />
  )

  return (
    <>
      {pairPersonas !== undefined && pairPersonas.length > 0 ? (
        // Each speaker's face sits beside their own name: A ⇄ B, no facepile.
        <span className="flex min-w-10 items-center gap-1.5">
          {pairPersonas.map((member, index) => (
            <Fragment key={member.id}>
              {index === 0 ? null : <Icon icon={ArrowLeftRightIcon} size={compact ? 14 : 16} className="mx-0.5 flex-none text-dim" />}
              <Avatar name={member.name} color={member.color} src={member.avatar} shape={member.avatarShape} tone={member.avatarTone} finish={member.avatarFinish} size={compact ? face : 28} />
              <span className={`min-w-0 truncate text-[14px] font-semibold tracking-[-0.01em] ${titleTone}`}>{member.name}</span>
            </Fragment>
          ))}
        </span>
      ) : persona !== undefined ? (
        onEditPersona !== undefined ? (
          <button
            type="button"
            // pointer-events-auto for the same reason the project chip has it: the
            // overlay header swallows clicks otherwise.
            className="pointer-events-auto -mx-1.5 flex min-w-0 cursor-pointer items-center gap-2 rounded-lg border-0 bg-transparent px-1.5 py-1 text-left [font:inherit] hover:bg-surface-2"
            title={`Agent settings for ${persona.name}`}
            aria-label={`Agent settings for ${persona.name}`}
            onClick={onEditPersona}
          >
            <Avatar name={persona.name} color={persona.color} src={persona.avatar} shape={persona.avatarShape} tone={persona.avatarTone} finish={persona.avatarFinish} size={face} />
            <PersonaLabel persona={persona} tone={titleTone} />
          </button>
        ) : (
          <>
            {persona.avatar === undefined || persona.avatar === '' ? (
              <Avatar name={persona.name} color={persona.color} shape={persona.avatarShape} tone={persona.avatarTone} finish={persona.avatarFinish} size={face} />
            ) : (
              <ZoomableImage
                src={persona.avatar}
                alt={`${persona.name} avatar`}
                frame="pointer-events-auto rounded-full"
                thumbnail={<Avatar name={persona.name} color={persona.color} src={persona.avatar} shape={persona.avatarShape} tone={persona.avatarTone} finish={persona.avatarFinish} size={face} />}
                zoomedClassName="size-80"
                zoomedContent={
                  <Avatar name={persona.name} color={persona.color} src={persona.avatar} shape={persona.avatarShape} tone={persona.avatarTone} finish={persona.avatarFinish} size={320} />
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
        ) : section === 'mail' ? (
          <Icon icon={Mail01Icon} size={17} className="flex-none text-muted" />
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
      {withChip ? (
        <span className="flex max-w-[45%] shrink-0 items-center whitespace-nowrap" title={chipTitle}>
          {onEditProject === undefined ? projectBadge : (
            <button
              type="button"
              className="pointer-events-auto flex min-w-0 cursor-pointer items-center rounded-chip border-0 bg-transparent p-0 [font:inherit] hover:brightness-95"
              title={`${chipTitle}\nEdit project`}
              aria-label="Edit project"
              onClick={onEditProject}
            >
              {projectBadge}
            </button>
          )}
        </span>
      ) : null}
      {accessory === undefined ? null : (
        <div className={accessoryGrow ? 'ml-1 min-w-0 flex-1' : 'ml-1 flex-none'}>{accessory}</div>
      )}
    </>
  )
}

/**
 * Who the DM is with: her name with the same quiet role badge as the inbox beside it.
 * No model line under it: on the desktop the model sits at the bar's far end instead
 * (`runtime`), where it can give way without cutting the name. Name and role
 * share the room as two grid tracks that grow evenly up to their own width: a short one
 * is never cut, and two long ones get half each, so a long role neither hides the name
 * nor runs under the panel doors. A percentage cap would not do here, because the label
 * sizes to its own content.
 */
function PersonaLabel({ persona, tone }: { persona: AgentConfig; tone: string }) {
  return (
    <span className="grid min-w-0 max-w-full auto-cols-[minmax(0,max-content)] grid-flow-col items-center gap-1.5 leading-none">
      <span className={`min-w-0 truncate text-[14px] font-semibold tracking-[-0.01em] ${tone}`}>{persona.name}</span>
      {persona.role === '' ? null : (
        <span className="flex min-w-0">
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
