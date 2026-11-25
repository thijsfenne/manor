import { ArrowUpRight01Icon, PlusSignIcon } from '@hugeicons/core-free-icons'
import type { AgentConfig, AgentDraft, Chat } from '@manor/contracts'
import { useLayoutEffect, useRef, useState } from 'react'
import { cleanDraft, cosOf, draftOf } from '../../persona'
import { useRequest, type RequestEvents } from '../../useRequest'
import { AgentSettings, type AgentSettingsProps } from '../agents/AgentSettings'
import { Avatar } from '../Avatar'
import { Icon } from '../Icon'
import { Button } from '../ui/Button'
import { Select } from '../ui/Select'
import { SelectionMarker } from '../ui/SelectionMarker'
import { SettingsRow } from './SettingsLayout'

const OFFLINE = 'Nothing was sent, the connection is down. Try again once it is back.'
const ROW_MARKER = 'settings-agent-row'
/** The list's sticky top (top-6) plus the page's bottom padding (pb-10), the room it needs besides itself. */
const LIST_ROOM = 24 + 40

/** One list, placement as its subheaders: Session agents first, chat agents below. */
const listOrder = (agents: readonly AgentConfig[]) => [
  ...agents.filter((agent) => agent.placement === 'session'),
  ...agents.filter((agent) => agent.placement !== 'session'),
]

/** The DM an agent's settings dock in. A Session agent has none, nor does an agent never talked to. */
export const dmOf = (chats: readonly Chat[], agent: AgentConfig) => agent.placement === 'session'
  ? undefined
  : chats.find((chat) => chat.kind === 'dm' && chat.memberIds[0] === agent.id)

/** The agent that takes unaddressed messages, the same flag as the Default agent switch in the agent's settings. */
function DefaultAgentRow({ agents, requestEvents, onSaveAgent }: {
  agents: AgentConfig[]
  requestEvents: RequestEvents
  onSaveAgent: (draft: AgentDraft, requestId: string) => boolean
}) {
  const request = useRequest(requestEvents)
  const [problem, setProblem] = useState<string | null>(null)
  const holder = cosOf(agents)
  // The server seats only these as chief: Session agents never are.
  const eligible = agents.filter((agent) => agent.placement !== 'session')

  const pick = (agentId: string) => {
    setProblem(null)
    // Choosing nobody takes the flag off whoever holds it; choosing someone gives it
    // to her, and the server takes it from the previous holder in the same write.
    const target = agentId === '' ? holder : agents.find((agent) => agent.id === agentId)
    if (target === null || target === undefined) return
    const draft = cleanDraft({ ...draftOf(target), isCos: agentId !== '' })
    const sent = request.start((requestId) => onSaveAgent(draft, requestId), {
      noticeInPlace: true,
      onNotice: (notice) => setProblem(notice.text),
    })
    if (!sent) setProblem(OFFLINE)
  }

  return (
    <SettingsRow
      label="Default agent"
      description={problem === null ? 'Answers messages in a shared room that mention nobody, and delegates from there.' : <span className="text-danger" role="status">{problem}</span>}
    >
      <div className="w-[200px]">
        <Select
          label="Default agent"
          value={holder?.id ?? ''}
          disabled={request.pending}
          options={[
            { value: '', label: 'Nobody' },
            ...eligible.map((agent) => ({ value: agent.id, label: agent.name })),
          ]}
          onChange={pick}
        />
      </div>
    </SettingsRow>
  )
}

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
  // The list stays in view while the editor scrolls, but only while it fits the window:
  // a taller list scrolls with the page, or its foot could never be reached.
  const scrollRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLElement>(null)
  const [listFits, setListFits] = useState(true)
  useLayoutEffect(() => {
    const scroller = scrollRef.current
    const list = listRef.current
    if (scroller === null || list === null) return
    const observer = new ResizeObserver(() => setListFits(list.offsetHeight + LIST_ROOM <= scroller.clientHeight))
    observer.observe(scroller)
    observer.observe(list)
    return () => observer.disconnect()
  }, [])

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
        {agent.isCos ? <span className="relative flex-none text-meta text-dim">Default agent</span> : null}
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
    <div ref={scrollRef} className="h-full min-h-0 overflow-y-auto">
      <div className="mx-auto w-full max-w-page">
        <header className="flex items-end justify-between gap-6 px-8 pt-10 pb-6 @max-[560px]:px-5 @max-[560px]:pt-7">
          <h1 className="m-0 min-w-0 font-display text-[24px] leading-tight font-semibold tracking-[-0.02em]">Agents</h1>
          <Button variant="primary" className="inline-flex flex-none items-center gap-2" onClick={onNewAgent}>
            <Icon icon={PlusSignIcon} size={14} />
            New agent
          </Button>
        </header>

        <div className="mx-8 mb-6 border-b border-line @max-[560px]:mx-5">
          <DefaultAgentRow agents={settings.agents} requestEvents={settings.requestEvents} onSaveAgent={settings.onSaveAgent} />
        </div>

        <div className="grid grid-cols-[minmax(0,264px)_minmax(0,1fr)] gap-6 px-6 pb-10 @max-[720px]:grid-cols-1">
          <nav ref={listRef} aria-label="Agents list" className={`self-start ${listFits ? '@min-[720px]:sticky @min-[720px]:top-6' : ''}`}>
            {group('Session agents', ordered.filter((agent) => agent.placement === 'session'))}
            {group('Chat agents', ordered.filter((agent) => agent.placement !== 'session'))}
          </nav>

          {selected === undefined ? (
            <p className="m-0 px-2 text-[14px] text-muted">Every agent here has a DM. Pick one to open its settings there.</p>
          ) : (
            <section
              aria-label="Agent settings"
              // No card: the editor is the page's own content here, as wide as the page has room.
              // No height either, so the editor grows and the page is the one scroll.
              className="flex min-h-[480px] w-full flex-col"
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
