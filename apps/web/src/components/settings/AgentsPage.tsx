import { useCallback, useEffect, useRef, useState } from 'react'
import { PlusSignIcon } from '@hugeicons/core-free-icons'
import type { AgentConfig, AgentDraft, McpServerConfig, SkillConfig, SubagentPolicy } from '@manor/contracts'
import { draftOf, emptyDraft } from '../../persona'
import type { Notice } from '../../state'
import { useRequest, type RequestEvents } from '../../useRequest'
import { AgentForm } from '../agents/AgentForm'
import { Avatar } from '../Avatar'
import { Icon } from '../Icon'
import { Button } from '../ui/Button'
import { Select } from '../ui/Select'
import { SelectionMarker } from '../ui/SelectionMarker'

/** A blank form for an agent not created yet. */
export const NEW_AGENT = 'new'
/** The blank form again, already set to a Session agent: the door a Session with nobody to seat opens. */
export const NEW_SESSION_AGENT = 'new-session'

const ROW_MARKER = 'settings-agent-row'

/**
 * The agent the detail shows: the one asked for, a blank form for `new`, else the
 * first in the list. Shared with the workspace, which loads that agent's DM pin.
 */
export function selectedAgentOf(agents: readonly AgentConfig[], agentId: string | undefined): AgentConfig | null {
  if (agentId === NEW_AGENT || agentId === NEW_SESSION_AGENT) return null
  return agents.find((agent) => agent.id === agentId) ?? listOrder(agents)[0] ?? null
}

/** One list, placement as its subheaders: chat agents first, Session agents below. */
const listOrder = (agents: readonly AgentConfig[]) => [
  ...agents.filter((agent) => agent.placement !== 'session'),
  ...agents.filter((agent) => agent.placement === 'session'),
]

interface AgentsPageProps {
  agents: AgentConfig[]
  /** From the Settings location: an id, `new`, or nothing for the first agent. */
  agentId: string | undefined
  registry: McpServerConfig[]
  skills: SkillConfig[]
  subagentPolicy: SubagentPolicy | null
  /** The selected agent's DM pin, when it differs from her default. */
  dmRuntime?: string
  notice: Notice | null
  requestEvents: RequestEvents
  /** Guarded one level up: an unsaved edit is asked about before another agent opens. */
  onSelect: (agentId: string) => void
  onSaveAgent: (draft: AgentDraft, requestId: string) => boolean
  onDeleteAgent: (agentId: string, requestId: string) => boolean
  onSaveSubagentPolicy: (policy: SubagentPolicy, requestId: string) => boolean
  onRequestSubagentPolicy: () => void
  onDismissNotice: () => void
  onDirtyChange: (dirty: boolean) => void
}

/**
 * Every agent in one list beside the form for the selected one, the Scheduled tasks
 * shape. Too narrow for two columns, the list becomes a picker above the form.
 */
export function AgentsPage({
  agents,
  agentId,
  registry,
  skills,
  subagentPolicy,
  dmRuntime,
  notice,
  requestEvents,
  onSelect,
  onSaveAgent,
  onDeleteAgent,
  onSaveSubagentPolicy,
  onRequestSubagentPolicy,
  onDismissNotice,
  onDirtyChange,
}: AgentsPageProps) {
  const { start } = useRequest(requestEvents)
  const [pending, setPending] = useState<'save' | 'delete' | null>(null)
  // Bumped when a save lands. The roster carries the saved persona before the ack does,
  // so the form takes its new baseline from exactly what the server stored.
  const [saves, setSaves] = useState(0)
  const selected = selectedAgentOf(agents, agentId)
  const creating = agentId === NEW_AGENT || agentId === NEW_SESSION_AGENT
  const ordered = listOrder(agents)
  const chatAgents = ordered.filter((agent) => agent.placement !== 'session')
  const sessionAgents = ordered.filter((agent) => agent.placement === 'session')

  // Her subagent narrowing lives in the house policy, read on the way in.
  useEffect(() => onRequestSubagentPolicy(), [onRequestSubagentPolicy])

  // A created agent has an id only once the roster carries her. The roster and the
  // ack race, so whichever lands second selects her.
  const latest = useRef(agents)
  latest.current = agents
  const createdFrom = useRef<Set<string> | null>(null)
  const pickCreated = useCallback(() => {
    const before = createdFrom.current
    if (before === null) return
    const created = latest.current.find((agent) => !before.has(agent.id))
    if (created === undefined) return
    createdFrom.current = null
    onDirtyChange(false)
    onSelect(created.id)
  }, [onDirtyChange, onSelect])
  useEffect(() => pickCreated(), [agents, pickCreated])

  /**
   * Saves the persona, then `followUp` (her subagent narrowing) only once the server
   * has taken her, so a refused persona never leaves a changed policy behind.
   */
  const save = (draft: AgentDraft, followUp?: { send: (requestId: string) => boolean; onUnsent: () => void }) => {
    const before = draft.id === undefined ? new Set(latest.current.map((agent) => agent.id)) : null
    const finish = () => {
      setPending(null)
      setSaves((count) => count + 1)
      if (before === null) return
      createdFrom.current = before
      pickCreated()
    }
    const sent = start((requestId) => onSaveAgent(draft, requestId), {
      onAck: () => {
        if (followUp === undefined) return finish()
        if (start(followUp.send, { onAck: finish, onNotice: () => setPending(null) })) return
        setPending(null)
        followUp.onUnsent()
      },
      onNotice: () => setPending(null),
    })
    if (sent) setPending('save')
    return sent
  }

  const remove = () => {
    if (selected === null) return false
    const id = selected.id
    const sent = start((requestId) => onDeleteAgent(id, requestId), {
      // The detail falls back to the first agent once she leaves the roster.
      onAck: () => {
        setPending(null)
        onDirtyChange(false)
      },
      onNotice: () => setPending(null),
    })
    if (sent) setPending('delete')
    return sent
  }

  const row = (agent: AgentConfig) => {
    const current = !creating && selected?.id === agent.id
    return (
      <button
        key={agent.id}
        type="button"
        aria-current={current ? 'true' : undefined}
        className={`relative flex h-10 w-full cursor-pointer items-center gap-2.5 rounded-lg border-0 bg-transparent px-2.5 text-left outline-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary ${
          current ? 'text-text' : 'text-muted hover:bg-surface-2 hover:text-text'
        }`}
        onClick={() => onSelect(agent.id)}
      >
        {current ? <SelectionMarker layoutId={ROW_MARKER} className="rounded-lg" /> : null}
        <span className="relative flex flex-none">
          <Avatar name={agent.name} color={agent.color} src={agent.avatar} shape={agent.avatarShape} tone={agent.avatarTone} size={24} center />
        </span>
        <span className="relative min-w-0 flex-1 truncate text-[14px]">{agent.name}</span>
        {agent.isCos ? <span className="relative flex-none text-meta text-dim">Chief</span> : null}
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
    // One scroll for the page: the title leaves with it, the list stays beside the form.
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="mx-auto w-full max-w-page">
        <header className="flex items-end justify-between gap-6 px-8 pt-10 pb-6 @max-[560px]:px-5 @max-[560px]:pt-7">
          <div className="min-w-0">
            <h1 className="m-0 font-display text-[24px] leading-tight font-semibold tracking-[-0.02em]">Agents</h1>
            <p className="mt-1 mb-0 max-w-[590px] text-[16px] leading-relaxed text-muted">
              Chat and Session agents in one list. The Agents view opens the same form.
            </p>
          </div>
          <Button variant="primary" className="inline-flex flex-none items-center gap-2" onClick={() => onSelect(NEW_AGENT)}>
            <Icon icon={PlusSignIcon} size={14} />
            New agent
          </Button>
        </header>

        <div className="grid grid-cols-[minmax(0,264px)_minmax(0,1fr)] gap-6 pl-6 @max-[720px]:grid-cols-1 @max-[720px]:pl-0">
          {/* A list taller than the window scrolls itself, inside the frame's top bar and gutter. */}
          <nav
            aria-label="Agents list"
            className="sticky top-6 max-h-[calc(100dvh-1.5rem-var(--top-bar-height,0px)-var(--frame-gutter,0px))] self-start overflow-y-auto pb-8 @max-[720px]:hidden"
          >
            {group('Chat agents', chatAgents)}
            {group('Session agents', sessionAgents)}
          </nav>

          <div className="min-w-0">
            <div className="hidden px-8 pb-4 @max-[720px]:block @max-[560px]:px-5">
              <Select
                label="Agent"
                value={creating ? NEW_AGENT : selected?.id ?? NEW_AGENT}
                options={[
                  ...ordered.map((agent) => ({ value: agent.id, label: agent.placement === 'session' ? `${agent.name} · Session` : agent.name })),
                  { value: NEW_AGENT, label: 'New agent' },
                ]}
                onChange={onSelect}
              />
            </div>
            <div className="max-w-[760px] px-8 pb-12 @max-[560px]:px-5">
              {!creating && selected === null ? (
                <p className="m-0 text-[14px] text-muted">No agents yet. Create the first one.</p>
              ) : (
                <AgentForm
                  key={creating ? agentId : selected?.id ?? ''}
                  initial={agentId === NEW_SESSION_AGENT
                    ? { ...emptyDraft(agents), placement: 'session', isCos: false, pinned: false, railPinned: false }
                    : creating || selected === null ? emptyDraft(agents) : draftOf(selected)}
                  agents={agents}
                  registry={registry}
                  skills={skills}
                  {...(dmRuntime === undefined || creating ? {} : { dmRuntime })}
                  notice={notice}
                  pending={pending}
                  saved={saves}
                  onSave={save}
                  onDelete={remove}
                  onDismissNotice={onDismissNotice}
                  onDirtyChange={onDirtyChange}
                  {...(creating ? {} : { subagentPolicy, onSaveSubagentPolicy })}
                />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
