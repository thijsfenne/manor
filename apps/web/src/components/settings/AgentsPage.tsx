import { ArrowUpRight01Icon, PlusSignIcon } from '@hugeicons/core-free-icons'
import type { AgentConfig, Chat } from '@manor/contracts'
import { AgentSettings, type AgentSettingsProps } from '../agents/AgentSettings'
import { Avatar } from '../Avatar'
import { Icon } from '../Icon'
import { Button } from '../ui/Button'
import { STAGE_PANEL_SHELL } from '../ui/dockPanel'
import { SelectionMarker } from '../ui/SelectionMarker'

const ROW_MARKER = 'settings-agent-row'

/** One list, placement as its subheaders: chat agents first, Session agents below. */
const listOrder = (agents: readonly AgentConfig[]) => [
  ...agents.filter((agent) => agent.placement !== 'session'),
  ...agents.filter((agent) => agent.placement === 'session'),
]

/** The DM an agent's settings dock in. A Session agent has none, nor does an agent never talked to. */
export const dmOf = (chats: readonly Chat[], agent: AgentConfig) => agent.placement === 'session'
  ? undefined
  : chats.find((chat) => chat.kind === 'dm' && chat.memberIds[0] === agent.id)

interface AgentsPageProps extends Omit<AgentSettingsProps, 'agent' | 'onClose'> {
  /** From the Settings location: an id, or nothing for the first agent edited here. */
  agentId: string | undefined
  chats: readonly Chat[]
  onSelect: (agentId: string) => void
  /** Leaves Settings for the agent's DM, its settings open there. */
  onOpenDm: (agentId: string) => void
  /** Opens the short New agent form over the workspace. */
  onNewAgent: () => void
}

/**
 * Every agent in one list. An agent with a DM opens its settings there; the others,
 * Session agents first among them, open the same Agent settings beside the list.
 */
export function AgentsPage({ agentId, chats, onSelect, onOpenDm, onNewAgent, ...settings }: AgentsPageProps) {
  const ordered = listOrder(settings.agents)
  const editedHere = ordered.filter((agent) => dmOf(chats, agent) === undefined)
  const selected = editedHere.find((agent) => agent.id === agentId) ?? editedHere[0]

  const row = (agent: AgentConfig) => {
    const inDm = dmOf(chats, agent) !== undefined
    const current = selected?.id === agent.id
    return (
      <button
        key={agent.id}
        type="button"
        aria-current={current ? 'true' : undefined}
        title={inDm ? `Opens ${agent.name}'s settings in the DM` : undefined}
        className={`relative flex h-10 w-full cursor-pointer items-center gap-2.5 rounded-lg border-0 bg-transparent px-2.5 text-left outline-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary ${
          current ? 'text-text' : 'text-muted hover:bg-surface-2 hover:text-text'
        }`}
        onClick={() => (inDm ? onOpenDm(agent.id) : onSelect(agent.id))}
      >
        {current ? <SelectionMarker layoutId={ROW_MARKER} className="rounded-lg" /> : null}
        <span className="relative flex flex-none">
          <Avatar name={agent.name} color={agent.color} src={agent.avatar} shape={agent.avatarShape} tone={agent.avatarTone} size={24} center />
        </span>
        <span className="relative min-w-0 flex-1 truncate text-[14px]">{agent.name}</span>
        {agent.isCos ? <span className="relative flex-none text-meta text-dim">Chief</span> : null}
        {inDm ? <Icon icon={ArrowUpRight01Icon} size={14} className="relative flex-none text-dim" /> : null}
      </button>
    )
  }

  const group = (title: string, members: AgentConfig[]) =>
    members.length === 0 ? null : (
      <div role="group" aria-label={title} className="pt-3 first:pt-0">
        <h3 className="m-0 px-2.5 pb-1 text-meta font-medium text-dim">{title}</h3>
        {members.map(row)}
      </div>
    )

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="mx-auto w-full max-w-page">
        <header className="flex items-end justify-between gap-6 px-8 pt-10 pb-6 @max-[560px]:px-5 @max-[560px]:pt-7">
          <div className="min-w-0">
            <h1 className="m-0 font-display text-[24px] leading-tight font-semibold tracking-[-0.02em]">Agents</h1>
            <p className="mt-1 mb-0 max-w-[590px] text-[16px] leading-relaxed text-muted">
              Every agent in one list. An agent you talk to opens its settings in its DM.
            </p>
          </div>
          <Button variant="primary" className="inline-flex flex-none items-center gap-2" onClick={onNewAgent}>
            <Icon icon={PlusSignIcon} size={14} />
            New agent
          </Button>
        </header>

        <div className="grid grid-cols-[minmax(0,264px)_minmax(0,1fr)] gap-6 px-6 pb-10 @max-[720px]:grid-cols-1">
          <nav aria-label="Agents list" className="self-start">
            {group('Chat agents', ordered.filter((agent) => agent.placement !== 'session'))}
            {group('Session agents', ordered.filter((agent) => agent.placement === 'session'))}
          </nav>

          {selected === undefined ? (
            <p className="m-0 px-2 text-[14px] text-muted">Every agent here has a DM. Pick one to open its settings there.</p>
          ) : (
            <section
              aria-label="Agent settings"
              className={`${STAGE_PANEL_SHELL} flex h-[min(760px,calc(100dvh-12rem))] min-h-[480px] w-full max-w-[420px] flex-col`}
            >
              {/* Keyed on the agent so another agent never shows this one's draft or page. */}
              <AgentSettings key={selected.id} agent={selected} {...settings} />
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
