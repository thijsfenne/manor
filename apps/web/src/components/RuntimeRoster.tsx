import { useCallback, useState } from 'react'
import { ArrowLeft01Icon, ArrowRight01Icon } from '@hugeicons/core-free-icons'
import type { AgentConfig, ChatOverride } from '@manor/contracts'
import { differsFromRoster, effectiveDriver, isAutoPending, runtimeParts } from '../runtimeChoices'
import { Avatar } from './Avatar'
import { Icon } from './Icon'
import { PANEL_ROW_ARROW, PANEL_ROW_HOVER } from './ui/dockPanel'
import { ProviderMark } from './ProviderMark'
import { RuntimeLabel } from './RuntimeLabel'
import { RuntimeSections } from './RuntimeMenu'
import { useHostAuto } from '../useHostAuto'

/**
 * Where the roster has navigated to. Held by the parent rather than by the view
 * because the surfaces that can be dismissed need to read it: Escape steps back
 * from a persona and only closes from the list, and that is a decision the popover
 * makes, not the list inside it.
 */
export function useRosterNav() {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  /**
   * Which way the last move went, so the incoming view enters from the side it came
   * from. Null until the first navigation: a panel that has only just opened slid in
   * from nowhere, and animating that would be motion answering no question.
   */
  const [direction, setDirection] = useState<'forward' | 'back' | null>(null)

  const enter = useCallback((agentId: string) => {
    setSelectedId(agentId)
    setDirection('forward')
  }, [])

  const back = useCallback(() => {
    setSelectedId(null)
    setDirection('back')
  }, [])

  /** Back to the list with no animation, for a surface that is being put away. */
  const reset = useCallback(() => {
    setSelectedId(null)
    setDirection(null)
  }, [])

  return { selectedId, direction, enter, back, reset }
}

interface RuntimeRosterProps {
  agents: AgentConfig[]
  /** Personas who have a seat in the chat, shown only when a parent supplies it. */
  activeAgentIds?: readonly string[]
  overrides: Record<string, ChatOverride>
  nav: ReturnType<typeof useRosterNav>
  /** True while the socket is down: the values stay readable, the picks do not. */
  disabled?: boolean
  /** Personas whose first turn in this chat has already started. */
  startedAgentIds?: readonly string[]
  /** When false, the composer strip already owns Auto, so no persona menu offers it. */
  allowAuto?: boolean
  /** Puts a surface that can be dismissed away as the Auto rule file opens over it. */
  onConfigureAuto?: () => void
  onChange: (agentId: string, override: ChatOverride) => void
  /** Docked in a panel: its rows wear the panel's row hover and quiet arrow. */
  panel?: boolean
}

/**
 * The household as a list, and one persona's runtime behind it. Two views rather
 * than a list that grows, because an expanded row pushes the rest off a scrolling
 * panel and costs exactly the overview the roster is opened for.
 *
 * Shared verbatim by the composer's folded panel and by the chat's agents card, so
 * there is one picker to learn and one place it can change. The parent owns the
 * frame (width, height, border) and the dismissal; this owns the two views, the
 * direction they enter from.
 */
export function RuntimeRoster({
  agents,
  activeAgentIds,
  overrides,
  nav,
  disabled = false,
  startedAgentIds = [],
  allowAuto = true,
  onConfigureAuto,
  onChange,
  panel = false,
}: RuntimeRosterProps) {
  const hostAuto = useHostAuto()
  const rowHover = panel ? `rounded-button-sm ${PANEL_ROW_HOVER}` : 'rounded-md hover:bg-user-bg'
  // Falls back to the list on its own when the roster loses the selected persona.
  const selected = agents.find((agent) => agent.id === nav.selectedId) ?? null
  const activeIds = activeAgentIds === undefined ? null : new Set(activeAgentIds)
  const startedIds = new Set(startedAgentIds)
  const canEnableAuto = (agent: AgentConfig) =>
    allowAuto && !startedIds.has(agent.id) && overrides[agent.id]?.autoResolved !== true
  const enterClass =
    nav.direction === 'forward'
      ? 'panel-enter-forward'
      : nav.direction === 'back'
        ? 'panel-enter-back'
        : ''

  return (
    <>
      {/* Keyed on the view, so React remounts it and the entry animation replays. */}
      <div key={selected?.id ?? 'list'} className={`flex min-h-0 flex-1 flex-col ${enterClass}`}>
        {selected === null ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            {agents.map((agent) => {
              const override = overrides[agent.id] ?? {}
              // Null means the caller does not track seats (the composer), so every
              // row reads at full strength rather than all of them reading as out.
              const inactive = activeIds !== null && !activeIds.has(agent.id)
              return (
                <button
                  type="button"
                  key={agent.id}
                  disabled={disabled}
                  className={`group flex w-full cursor-pointer items-center gap-2 border-0 bg-transparent px-2 py-1.5 text-left text-[15px] text-text ${rowHover} disabled:cursor-default disabled:opacity-45 disabled:hover:bg-transparent`}
                  onClick={() => nav.enter(agent.id)}
                >
                  {/* Who is in the chat is carried by the face and the name fading,
                      not by a dot beside them: a 6px mark next to a portrait is the
                      quietest thing in the row, and it read as decoration. The two
                      travel together so the pair dims as one thing. */}
                  <span
                    className={`flex min-w-0 items-center gap-2 ${inactive ? 'opacity-40' : ''}`}
                  >
                    <Avatar name={agent.name} color={agent.color} src={agent.avatar} shape={agent.avatarShape} tone={agent.avatarTone} size={24} />
                    {/* Name capped rather than shrinking, so a long one eats itself
                        instead of squeezing the title next to it down to nothing.
                        Tight leading plus truncate clipped Argus's g; a hair of
                        padding keeps descenders inside the hidden box. */}
                    <span className="max-w-[110px] flex-none truncate py-px">{agent.name}</span>
                  </span>
                  {/* What she does, in the words a person scans a roster for. */}
                  <span className="min-w-0 flex-1 truncate text-meta text-dim">{agent.role}</span>
                  {/* Opacity alone says nothing to a screen reader. */}
                  {activeIds?.has(agent.id) ? <span className="sr-only">Active in this chat</span> : null}
                  {/* Says who is off her own settings without opening anything. */}
                  {differsFromRoster(agent, override) ? (
                    <span role="img" aria-label="pinned" className="h-1.5 w-1.5 flex-none rounded-full bg-muted" />
                  ) : null}
                  {/* The runtime travels with the seat, the same way the face and the
                      name do: whoever is in the chat reads at full strength on both
                      edges of the row, and the rest of the household sits behind her.
                      The mark carries brand colour rather than text colour, so its
                      half of the pair fades by opacity instead. The model sits a step
                      quieter than the name and without its reasoning level: the people
                      lead the roster, the level lives one click in. */}
                  <span
                    className={`flex flex-none items-center gap-2 ${inactive ? 'opacity-40' : ''}`}
                  >
                    {isAutoPending(agent, override, hostAuto) ? null : (
                      <ProviderMark driver={effectiveDriver(agent, override)} size={12} />
                    )}
                    <RuntimeLabel {...withoutEffort(runtimeParts(agent, override, hostAuto))} className="max-w-[140px] flex-none text-meta" />
                  </span>
                  <Icon icon={ArrowRight01Icon} size={12} {...(panel ? { className: PANEL_ROW_ARROW } : {})} />
                </button>
              )
            })}
          </div>
        ) : (
          <>
            {/* The way back, and the only thing that says whose settings these are. */}
            <button
              type="button"
              className={`flex w-full cursor-pointer items-center gap-1.5 border-0 bg-transparent px-2 py-1.5 text-left text-[15px] text-text ${rowHover}`}
              onClick={nav.back}
            >
              <Icon icon={ArrowLeft01Icon} size={13} />
              <Avatar name={selected.name} color={selected.color} src={selected.avatar} shape={selected.avatarShape} tone={selected.avatarTone} size={24} />
              <span className="min-w-0 flex-1 truncate py-px">{selected.name}</span>
              <span className="flex-none text-meta text-dim">All agents</span>
            </button>
            <div className="mt-1 flex min-h-0 flex-1 flex-col overflow-hidden border-t border-line">
              <RuntimeSections
                agent={selected}
                override={overrides[selected.id] ?? {}}
                allowAuto={canEnableAuto(selected)}
                {...(onConfigureAuto === undefined ? {} : { onConfigureAuto })}
                onChange={(next) => onChange(selected.id, next)}
              />
            </div>
          </>
        )}
      </div>
    </>
  )
}

const withoutEffort = ({ effort: _effort, ...parts }: ReturnType<typeof runtimeParts>) => parts
