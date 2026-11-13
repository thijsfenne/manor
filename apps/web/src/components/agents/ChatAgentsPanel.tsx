import { useEffect, type ReactNode } from 'react'
import { Clock01Icon, Cancel01Icon, PlusSignIcon } from '@hugeicons/core-free-icons'
import type { AgentConfig, ChatOverride, Routine } from '@manor/contracts'
import { describeSchedule, isRunning, routineOffLabel } from '../../routines'
import { differsFromRoster } from '../../runtimeChoices'
import { Icon } from '../Icon'
import { DOCK_PANEL_SHELL } from '../ui/dockPanel'
import { IconButton } from '../ui/IconButton'
import { RuntimeRoster, useRosterNav } from '../RuntimeRoster'

interface ChatAgentsPanelProps {
  /** This chat's roster, participants first. See `chatRoster`. */
  agents: AgentConfig[]
  /** Members or participants who are active in this chat. */
  activeAgentIds: readonly string[]
  /** Personas whose first turn in this chat has already started. */
  startedAgentIds: readonly string[]
  overrides: Record<string, ChatOverride>
  /** False while the socket is down: the values stay readable, the picks do not. */
  canEdit: boolean
  onChange: (agentId: string, override: ChatOverride) => void
  /** Only a group has a membership to change, so only a group gets the way in. */
  onEditMembers?: () => void
  /** Routines that post into this chat. Read-only here; see `RoutineDisclosure`. */
  routines?: readonly Routine[]
  /** Where a routine row goes. Absent means the rows are not offered at all. */
  onOpenRoutines?: () => void
  /** The panel's own way out, next to the door that opened it. */
  onClose?: () => void
  /** Beside other panels the card takes its column's full height instead of its roster's. */
  fill?: boolean
  /**
   * The Session's Changes and Branch, where the chat has a linked git folder. Their
   * presence renames the card Session; a Single Session shows them without a roster.
   */
  sessionSections?: ReactNode
  /** The subagents' summary line, always the panel's last section, under Editor. */
  agentsSection?: ReactNode
  /** The phone has no door beside the panel, so a panel without a roster keeps its title bar and close. */
  phone?: boolean
}

/**
 * The household beside the chat, with each persona's model and reasoning behind her
 * own row. It replaces the composer's runtime controls whenever a chat is open, so
 * there is one writer of those two fields per screen rather than two at different
 * scopes.
 *
 * The list and the drill-down are `RuntimeRoster`, the same component the composer's
 * folded panel renders. The user asked for that explicitly: one picker to learn, and one
 * place it can change. An earlier pass expanded rows in place here, on the argument
 * that a docked panel has the room a popover does not; the roster it shares with the
 * composer is worth more than the step it saves.
 */
export function ChatAgentsPanel({
  agents,
  activeAgentIds,
  startedAgentIds,
  overrides,
  canEdit,
  onChange,
  onEditMembers,
  routines = [],
  onOpenRoutines,
  onClose,
  fill = false,
  sessionSections,
  agentsSection,
  phone = false,
}: ChatAgentsPanelProps) {
  const nav = useRosterNav()

  // The popover version starts at the list because it unmounts; this one never does.
  // Losing the socket is the moment its drilled view stops meaning anything, so it
  // steps back rather than sitting on a persona whose picks would be dropped.
  useEffect(() => {
    if (!canEdit) nav.reset()
  }, [canEdit, nav.reset])

  if (agents.length === 0 && sessionSections === undefined && agentsSection === undefined) return null

  // The Session panel has no title bar. Nor has one that only lists subagents, where
  // its door already opens and closes it.
  const session = sessionSections !== undefined || (agents.length === 0 && !phone)
  const pinnedCount = agents.filter((agent) => differsFromRoster(agent, overrides[agent.id] ?? {})).length
  const activeCount = agents.filter((agent) => activeAgentIds.includes(agent.id)).length

  return (
    <section
      aria-label={session ? 'This Session' : 'Agents in this chat'}
      // The shared dock shell, whose overflow-hidden also keeps the sliding view from
      // crossing the rounded border, the same reason the composer's popover has it.
      className={`flex ${fill ? 'h-full' : 'max-h-full'} min-h-0 flex-col ${DOCK_PANEL_SHELL}`}
    >
      {/* The Session panel has no title bar: its rail door opens and closes it, and its
          sections carry their own titles, the way Synara's environment card does. */}
      {session ? null : (
        <div className="flex flex-none items-center gap-2 py-2.5 pr-2.5 pl-3.5">
          <h2 className="m-0 text-[14px] font-medium text-text">Agents</h2>
          <span className="flex-1" />
          <AgentCounts active={activeCount} total={agents.length} pinned={pinnedCount} />
          {/* The same square every other panel's header controls wear. This pair was a
              hand-rolled 22px box, which read as a different kind of control the moment
              the four panels sat in one track. */}
          {onEditMembers === undefined ? null : (
            <IconButton icon={PlusSignIcon} label="Add or remove members" onClick={onEditMembers} />
          )}
          {onClose === undefined ? null : <IconButton icon={Cancel01Icon} label="Close agents" onClick={onClose} />}
        </div>
      )}

      {/* In the Session panel the roster is its first section, titled like the rest. */}
      {session && agents.length > 0 ? (
        <div className="flex flex-none items-center gap-2 px-3.5 pt-3 pb-0.5">
          <h3 className="m-0 text-meta font-medium text-dim">Agents</h3>
          <span className="flex-1" />
          <AgentCounts active={activeCount} total={agents.length} pinned={pinnedCount} />
        </div>
      ) : null}
      {/* The same `role` the composer's popover carries. `RuntimeSections` marks
          its picks `menuitemradio`, and a radio outside a menu is a role with no
          parent to belong to. */}
      {agents.length === 0 ? null : (
        // In the Session panel Changes and Branch follow the roster directly instead of
        // sinking to the foot of a tall column.
        <div role="menu" className={`flex min-h-0 ${session ? 'flex-initial overflow-y-auto' : 'flex-1'} flex-col px-1.5 py-1.5`}>
          <RuntimeRoster
            agents={agents}
            activeAgentIds={activeAgentIds}
            startedAgentIds={startedAgentIds}
            overrides={overrides}
            nav={nav}
            disabled={!canEdit}
            onChange={onChange}
            panel
          />
        </div>
      )}

      {/* Only beside the list: drilled into one persona the panel is about her runtime. */}
      {nav.selectedId === null ? sessionSections : null}

      {/* Only while the list is showing: drilled into one persona the panel is about
          that persona's runtime, and a routine row under it belongs to nothing on
          screen. */}
      {nav.selectedId === null ? (
        <RoutineDisclosure routines={routines} agents={agents} {...(onOpenRoutines === undefined ? {} : { onOpen: onOpenRoutines })} />
      ) : null}

      {nav.selectedId === null ? agentsSection : null}
    </section>
  )
}

/** The roster's own counts, opposite its title: who is active, and who carries a pin. */
function AgentCounts({ active, total, pinned }: { active: number; total: number; pinned: number }) {
  return (
    // Space separates them instead of a middot: two independent facts, not one list.
    <span className="flex items-center gap-3 text-meta text-dim">
      {/* The count a person came for is the one in white; the household size and the
          word after it are the scale it is read against. */}
      <span>
        <span className="text-text">{active}</span>/{total} active
      </span>
      {/* The only place a pin on a persona who has not spoken is ever announced. */}
      {pinned > 0 ? (
        <span>
          <span className="text-text">{pinned}</span> pinned
        </span>
      ) : null}
    </span>
  )
}

/**
 * What arrives in this chat without anybody sending it.
 *
 * Read-only on purpose. A routine outlives the chat it posts into and is managed
 * house-wide in the Routines view, so this is a disclosure and a door, never a second
 * editor: two writers of one schedule is exactly the drift the single view avoided.
 * Absent entirely when this chat has no routines, because a permanent empty heading
 * in a panel about the household is chrome that says nothing.
 */
function RoutineDisclosure({
  routines,
  agents,
  onOpen,
}: {
  routines: readonly Routine[]
  agents: readonly AgentConfig[]
  onOpen?: () => void
}) {
  if (routines.length === 0 || onOpen === undefined) return null
  return (
    <div className="flex-none border-t border-line px-1.5 pt-1.5 pb-1.5">
      <p className="m-0 px-2 pb-1 text-meta font-medium text-dim">Runs on a schedule</p>
      {routines.map((routine) => {
        const agent = agents.find((candidate) => candidate.id === routine.agentId)
        const running = isRunning(routine)
        return (
          <button
            key={routine.id}
            type="button"
            className={`flex w-full cursor-pointer items-center gap-2 rounded-button-sm border-0 bg-transparent px-2 py-1.5 text-left [font:inherit] hover:bg-surface-2 ${
              routine.enabled ? '' : 'opacity-60'
            }`}
            title="Open in Scheduled tasks"
            onClick={onOpen}
          >
            <Icon icon={Clock01Icon} size={13} className="flex-none text-dim" />
            <span className="min-w-0 flex-1 truncate text-[13px] text-text">{routine.name}</span>
            <span className="flex-none text-meta text-dim">
              {running ? 'Running' : routine.enabled ? describeSchedule(routine) : routineOffLabel(routine)}
            </span>
            <span className="flex-none text-meta text-dim">{agent?.name ?? routine.agentId}</span>
          </button>
        )
      })}
    </div>
  )
}
