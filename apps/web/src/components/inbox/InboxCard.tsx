import {
  Archive04Icon,
  ArchiveRestoreIcon,
  Clock01Icon,
  Delete02Icon,
} from '@hugeicons/core-free-icons'
import type { AgentConfig, ChatOverride, ProjectIcon as ProjectIconId } from '@manor/contracts'
import { relativeTime } from '../../relativeTime'
import {
  defaultSingleRuntime,
  effectiveDriver,
  isAutoPending,
  readSingleRuntime,
  runtimeParts,
  singleRuntimeVoice,
} from '../../runtimeChoices'
import { personaOf } from '../../state'
import { Avatar } from '../Avatar'
import { Icon } from '../Icon'
import { ProviderMark } from '../ProviderMark'
import { RuntimeLabel } from '../RuntimeLabel'
import { HoverCard } from '../ui/HoverCard'
import { ProjectBadge } from '../ProjectBadge'
import { useHostAuto } from '../../useHostAuto'

export type InboxCardAction = 'archive' | 'restore' | 'delete'

const ACTION: Record<
  InboxCardAction,
  { label: string; icon: typeof Archive04Icon; tone: 'default' | 'danger' }
> = {
  archive: { label: 'Archive Session', icon: Archive04Icon, tone: 'default' },
  restore: { label: 'Restore Session', icon: ArchiveRestoreIcon, tone: 'default' },
  delete: { label: 'Delete Session', icon: Delete02Icon, tone: 'danger' },
}

const WIDTH = 268

/** The badge's shorthand written out. "now ago" is not a thing anyone says. */
const lastActive = (ts: number): string => {
  const age = relativeTime(ts)
  return age === 'now' ? 'Last active just now' : `Last active ${age} ago`
}

interface InboxCardProps {
  title: string
  projectName: string
  projectIcon: ProjectIconId
  projectIconSrc?: string | undefined
  projectLetters?: string | undefined
  projectColor: string
  noProject?: boolean | undefined
  agentIds: string[]
  agents: AgentConfig[]
  lastMessageAt: number
  /** A single session's runtime pin; set, the card names its model instead of a household. */
  single?: ChatOverride
  /** Archive and delete, or restore and delete. The row's right-click offers the same. */
  actions: { kind: InboxCardAction; onSelect: () => void }[]
  /** The side the card opens on; the sessions overview sits on the right and asks for the left. */
  side?: 'left' | 'right'
  /** Where the sidebar row is, in viewport coordinates; the card sits beside it. */
  anchor: DOMRect
  /** False once the row has let go: the card plays its exit and waits to be unmounted. */
  open: boolean
  onClose: () => void
  /** Pointer moving into the card cancels the close the row scheduled. */
  onPointerEnter: () => void
  onPointerLeave: () => void
}

/**
 * What a settled chat was, without opening it. The compact row gives up the project
 * line and the faces to stay a one-liner, so this is where they go: the whole title
 * as written, the room it lives in, who worked in it and when it last moved.
 *
 * Placed exactly like the sidebar's project card, down to the keyframes, because
 * they are the same gesture on two neighbouring rows and two tempos would read as
 * two different things. Both wear `ui/HoverCard` for that reason.
 */
export function InboxCard({
  title,
  projectName,
  projectIcon: icon,
  projectIconSrc,
  projectLetters,
  projectColor,
  noProject,
  agentIds,
  agents,
  lastMessageAt,
  single,
  actions,
  side,
  anchor,
  open,
  onClose,
  onPointerEnter,
  onPointerLeave,
}: InboxCardProps) {
  return (
    <HoverCard
      anchor={anchor}
      open={open}
      width={WIDTH}
      {...(side === undefined ? {} : { side })}
      label={`${title} details`}
      className="p-2.5"
      onClose={onClose}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      {/* Whole title, wrapped: the row it belongs to is the one that had to cut it
          short, and reading it in full is half of why this card exists. */}
      <p className="m-0 text-[14px] leading-snug font-semibold text-text [overflow-wrap:anywhere]">{title}</p>

      <div className="flex flex-col gap-1.5 border-t border-line pt-2">
        <span className="flex min-w-0 items-center">
          <ProjectBadge name={projectName} icon={icon} iconSrc={projectIconSrc} letters={projectLetters} color={projectColor} noProject={noProject} />
        </span>

        {single === undefined ? null : <SingleRuntimeRow override={single} agents={agents} />}

        {single !== undefined || agentIds.length === 0 ? null : (
          // One row for the household in this thread rather than one row each: the
          // question the card answers is who was in it, and three names on three
          // lines pushes the time out of sight for a thread with a crowd in it.
          <span className="flex items-start gap-2 text-[13px] text-muted">
            <span className="flex flex-none flex-col gap-1.5 pt-px">
              {agentIds.map((agentId) => {
                const persona = personaOf(agents, agentId)
                return <Avatar key={agentId} name={persona.name} color={persona.color} src={persona.avatar} shape={persona.avatarShape} tone={persona.avatarTone} finish={persona.avatarFinish} size={15} />
              })}
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-1.5">
              {agentIds.map((agentId) => (
                <span key={agentId} className="truncate leading-[15px]">
                  {personaOf(agents, agentId).name}
                </span>
              ))}
            </span>
          </span>
        )}

        <span className="flex items-center gap-2.5 text-[13px] text-muted">
          <Icon icon={Clock01Icon} size={15} className="flex-none text-dim" />
          <span className="min-w-0 flex-1 truncate">{lastActive(lastMessageAt)}</span>
        </span>
      </div>

      <div className="flex flex-col gap-0.5 border-t border-line pt-2">
        {actions.map((action) => {
          const item = ACTION[action.kind]
          return (
            <button
              type="button"
              key={action.kind}
              className={`flex w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-1.5 py-1 text-left text-label ${
                item.tone === 'danger'
                  ? 'text-danger hover:bg-[color-mix(in_srgb,var(--color-danger)_12%,transparent)]'
                  : 'text-muted hover:bg-user-bg hover:text-text'
              }`}
              onClick={action.onSelect}
            >
              <Icon icon={item.icon} size={14} className="flex-none" />
              {item.label}
            </button>
          )
        })}
      </div>
    </HoverCard>
  )
}

/**
 * What a single session runs on, read the way its composer's model button reads it:
 * the pin over the house default, provider mark, model, effort and the Fast glyph.
 */
function SingleRuntimeRow({ override, agents }: { override: ChatOverride; agents: AgentConfig[] }) {
  const hostAuto = useHostAuto()
  const voice = singleRuntimeVoice(readSingleRuntime(override, defaultSingleRuntime(agents)))
  return (
    <span className="flex items-center gap-2.5 text-[13px] text-muted">
      <span className="grid w-[15px] flex-none place-items-center">
        {isAutoPending(voice, override, hostAuto) ? null : <ProviderMark driver={effectiveDriver(voice, override)} size={13} />}
      </span>
      <RuntimeLabel {...runtimeParts(voice, override, hostAuto)} className="min-w-0 flex-1" />
    </span>
  )
}
