import { useRef, useState } from 'react'
import { ArrowDown01Icon } from '@hugeicons/core-free-icons'
import type { AgentConfig, ChatOverride } from '@manor/contracts'
import { differsFromRoster } from '../runtimeChoices'
import { Avatar } from './Avatar'
import { Icon } from './Icon'
import { RuntimeMenu } from './RuntimeMenu'
import { RuntimeRoster, useRosterNav } from './RuntimeRoster'
import { Popover } from './ui/Popover'
import { useDismiss } from './ui/useDismiss'

interface RuntimeControlsProps {
  /** Whoever this composer can address: the chat's participants, or the household. */
  agents: AgentConfig[]
  overrides: Record<string, ChatOverride>
  disabled: boolean
  /** Personas whose first turn in this chat has already started. */
  startedAgentIds?: readonly string[]
  /** Lets a direct one-persona control use the model-heavy picker used by Single. */
  directLayout?: 'stacked' | 'split'
  /**
   * When false, no menu offers Auto because the composer strip already does.
   * Omitted, each persona still can until her first turn.
   */
  allowAuto?: boolean
  onChange: (agentId: string, override: ChatOverride) => void
}

/**
 * The composer's runtime controls, at any household size. A DM's one persona keeps
 * her own menu; a room of several, however few, folds into one facepile, because a
 * row of bare model menus does not say whose is whose. The panel holds the same
 * Model and Reasoning sections, one persona at a time, rather than a second kind
 * of picker.
 */
export function RuntimeControls({ agents, overrides, disabled, startedAgentIds = [], directLayout = 'stacked', allowAuto = true, onChange }: RuntimeControlsProps) {
  if (agents.length === 0) return null

  if (agents.length === 1) {
    return (
      <>
        {agents.map((agent) => (
          <RuntimeMenu
            key={agent.id}
            agent={agent}
            override={overrides[agent.id] ?? {}}
            disabled={disabled}
            layout={directLayout}
            allowAuto={allowAuto && !startedAgentIds.includes(agent.id) && overrides[agent.id]?.autoResolved !== true}
            onChange={(override) => onChange(agent.id, override)}
          />
        ))}
      </>
    )
  }

  return <RuntimeFacepile agents={agents} overrides={overrides} disabled={disabled} startedAgentIds={startedAgentIds} allowAuto={allowAuto} onChange={onChange} />
}

function RuntimeFacepile({ agents, overrides, disabled, startedAgentIds = [], allowAuto = true, onChange }: RuntimeControlsProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const nav = useRosterNav()

  // Reopening starts at the list: a panel that remembers where you were last is a
  // panel that opens somewhere you did not ask for.
  const close = () => {
    setOpen(false)
    nav.reset()
  }

  // Clicking away is "I am done here"; Escape only undoes the step you just took.
  useDismiss(open, close, {
    within: [rootRef],
    onEscape: () => (nav.selectedId === null ? close() : nav.back()),
  })

  const changed = agents.some((agent) => differsFromRoster(agent, overrides[agent.id] ?? {}))

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        type="button"
        className="flex h-9 min-w-0 cursor-pointer items-center gap-1.5 rounded-full border-0 bg-transparent px-2 text-[12px] text-muted [font:inherit] hover:bg-user-bg hover:text-text disabled:cursor-default disabled:opacity-45"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Model and reasoning per agent, for this chat"
        onClick={() => (open ? close() : setOpen(true))}
      >
        <span className="flex flex-none items-center">
          {agents.map((agent) => (
            <span key={agent.id} className="-ml-1.5 flex first:ml-0">
              <Avatar name={agent.name} color={agent.color} src={agent.avatar} shape={agent.avatarShape} tone={agent.avatarTone} size={18} />
            </span>
          ))}
        </span>
        {changed ? (
          <span role="img" aria-label="changed from default" className="h-1.5 w-1.5 flex-none rounded-full bg-muted" />
        ) : null}
        <Icon icon={ArrowDown01Icon} size={12} />
      </button>

      <Popover
        open={open}
        // overflow-hidden so the sliding view never crosses the rounded border.
        // 360 rather than 300: the name and the runtime are capped, so the job
        // title gets whatever is left, and at 300 that was four letters and an
        // ellipsis. Same width as the mention menu, the other list of personas.
        className="absolute bottom-[calc(100%+8px)] left-0 z-[6] flex max-h-[min(640px,calc(100dvh-128px))] w-[360px] flex-col overflow-hidden rounded-xl border border-line surface-floating px-1.5 py-1.5"
        contentClassName="flex min-h-0 flex-1 flex-col"
        role="menu"
      >
        <RuntimeRoster
          agents={agents}
          overrides={overrides}
          nav={nav}
          startedAgentIds={startedAgentIds}
          allowAuto={allowAuto}
          onConfigureAuto={close}
          onChange={onChange}
        />
      </Popover>
    </div>
  )
}
