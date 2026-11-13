import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  AiMagicIcon,
  AiNetworkIcon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Book02Icon,
  Cancel01Icon,
  Clock01Icon,
  Delete02Icon,
  File01Icon,
  LinkSquare02Icon,
  PencilEdit02Icon,
  UserGroupIcon,
} from '@hugeicons/core-free-icons'
import {
  supportsFastMode,
  type AgentConfig,
  type AgentDraft,
  type McpServerConfig,
  type Routine,
  type ServerMessage,
  type SkillConfig,
  type SubagentPolicy,
} from '@manor/contracts'
import { attachedServers } from '../../mcp'
import { cosOf, fastFor, safeHex } from '../../persona'
import { describeSchedule } from '../../routines'
import { PROVIDERS, defaultModel } from '../../runtimes'
import { CHAT_LIST_PIN_LIMIT } from '../../state'
import { useRequest, type RequestEvents } from '../../useRequest'
import type { ConnectionStatus } from '../../useWorkspace'
import { Avatar } from '../Avatar'
import { ConfirmStrip } from '../Confirm'
import { Icon } from '../Icon'
import { Markdown } from '../Markdown'
import { formHintClass, formInputClass, formLabelClass } from '../ui/FormField'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'
import { Pill } from '../ui/Pill'
import { Switch } from '../ui/Switch'
import { AgentFacePage } from './AgentFacePage'
import { McpSection } from './McpSection'
import { ModelField } from './NewAgentFields'
import { SkillsSection } from './SkillsSection'
import { SubagentsSection, type PersonaSubagents } from './SubagentsSection'
import { sendAfter, useAgentAutosave, type SaveState } from './useAgentAutosave'
import { subscribeAgentPage, takeAgentPage } from '../../agentSettingsIntent'

type Page = 'root' | 'face' | 'instructions' | 'notes' | 'skills' | 'connections' | 'subagents' | 'routines' | 'access'

const PAGE_TITLES: Record<Exclude<Page, 'root'>, string> = {
  face: 'Face',
  instructions: 'Instructions',
  notes: 'Notes',
  skills: 'Skills',
  connections: 'Connections',
  subagents: 'Subagents',
  routines: 'Routines',
  access: 'Access',
}

type Notes = Extract<ServerMessage, { type: 'agent_notes' }>['notes']
type NotesLoad = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; notes: Notes }

export interface AgentSettingsProps {
  agent: AgentConfig
  agents: AgentConfig[]
  registry: McpServerConfig[]
  skills: SkillConfig[]
  routines: Routine[]
  /** Null until the server has answered. */
  subagentPolicy: SubagentPolicy | null
  status: ConnectionStatus
  requestEvents: RequestEvents
  onSaveAgent: (draft: AgentDraft, requestId: string) => boolean
  onDeleteAgent: (agentId: string, requestId: string) => boolean
  onSaveSubagentPolicy: (policy: SubagentPolicy, requestId: string) => boolean
  /** Asks the server for the house policy, which holds this agent's subagent narrowing. */
  onRequestSubagentPolicy: () => void
  onLoadNotes: (agentId: string, requestId: string) => boolean
  /** Absent where the host has its own way out, as Settings does. */
  onClose?: () => void
}

/**
 * One agent's settings: a root that says what the agent is and what it holds, and a
 * page per thing it holds, each a back arrow away. Every change saves as it is made.
 * The same editor in the DM's panel and in Settings → Agents, so key it on the agent.
 */
export function AgentSettings(props: AgentSettingsProps) {
  const { agent, agents, registry, skills, routines, subagentPolicy, status, requestEvents, onSaveAgent, onClose } = props
  const [page, setPage] = useState<Page>('root')
  // A memory-off agent's offered rule, shown on Instructions until the user adds or drops it.
  const [suggestion, setSuggestion] = useState<string | null>(null)
  // Bumped by each chat line's View, so the notes page reads the file as it is now.
  const [notesRead, setNotesRead] = useState(0)
  // A chat line's View or Add to instructions, whether this editor was open already or opens now.
  useEffect(() => {
    const take = () => {
      const intent = takeAgentPage(agent.id)
      if (intent === null) return
      setPage(intent.page)
      setSuggestion(intent.line ?? null)
      setNotesRead((count) => count + 1)
    }
    take()
    return subscribeAgentPage(take)
  }, [agent.id])
  const { onRequestSubagentPolicy } = props
  useEffect(() => onRequestSubagentPolicy(), [onRequestSubagentPolicy])
  const { draft, state, edit } = useAgentAutosave(agent, status, requestEvents, onSaveAgent)
  const notes = useAgentNotes(agent.id, draft.memoryScope, status, requestEvents, props.onLoadNotes, notesRead)
  const subagents = useSubagentsAutosave(agent.id, subagentPolicy, status, requestEvents, props.onSaveSubagentPolicy)
  const name = draft.name.trim() || agent.name
  const own = routines.filter((routine) => routine.agentId === agent.id)

  const header = page === 'root' ? (
    <PanelHeader onClose={onClose}>
      <span className="truncate text-text">Agent settings</span>
    </PanelHeader>
  ) : (
    <PanelHeader onClose={onClose} onBack={() => setPage('root')}>
      <span className="truncate text-dim">{name}</span>
      <Icon icon={ArrowRight01Icon} size={11} />
      <span className="truncate text-text">{PAGE_TITLES[page]}</span>
    </PanelHeader>
  )

  let body: ReactNode
  let footnote: string
  switch (page) {
    case 'root':
      footnote = 'Changes save as you make them.'
      body = (
        <RootPage
          draft={draft}
          agent={agent}
          registry={registry}
          notes={notes}
          routineCount={own.length}
          subagents={subagents.own}
          edit={edit}
          open={setPage}
          requestEvents={requestEvents}
          onDeleteAgent={props.onDeleteAgent}
        />
      )
      break
    case 'face':
      footnote = 'The face, colour and tone show wherever this agent speaks.'
      body = <AgentFacePage draft={draft} onChange={(patch) => edit(patch)} />
      break
    case 'instructions':
      footnote = 'The whole system prompt. After the interview, only you change it.'
      body = (
        <>
          {suggestion === null ? null : (
            <SuggestedLine
              name={name}
              line={suggestion}
              onAdd={() => {
                edit({ character: withLine(draft.character, suggestion) })
                setSuggestion(null)
              }}
              onDismiss={() => setSuggestion(null)}
            />
          )}
          <textarea
            className={`${formInputClass} min-h-[360px] flex-1 resize-none font-mono text-label leading-relaxed`}
            aria-label="Instructions"
            value={draft.character}
            onChange={(event) => edit({ character: event.target.value }, true)}
          />
        </>
      )
      break
    case 'notes':
      footnote = `Kept by ${name} from your chats. Facts about you go to your shared memory.`
      body = <NotesPage name={name} memory={draft.memoryScope} notes={notes} />
      break
    case 'skills':
      footnote = `${name} loads a skill when the task asks for it.`
      body = <SkillsSection draft={draft} skills={skills} onChange={(skillIds) => edit({ skillIds })} />
      break
    case 'connections':
      footnote = 'Writes to outside services still ask you first.'
      body = <McpSection draft={draft} registry={registry} onChange={(mcpServers) => edit({ mcpServers })} />
      break
    case 'subagents':
      footnote = subagents.problem ?? 'What the helpers this agent starts may run on.'
      body = <SubagentsSection agentId={agent.id} driver={draft.driver} policy={subagentPolicy} own={subagents.own} onChange={subagents.change} />
      break
    case 'routines':
      footnote = 'Routines also show on the Scheduled page.'
      body = <RoutinesPage name={name} routines={own} />
      break
    case 'access':
      footnote = 'Who this agent is to the rest of the house.'
      body = <AccessPage draft={draft} agent={agent} agents={agents} edit={edit} />
      break
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {header}
      <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-4 pt-[18px] pb-5 [&>*]:shrink-0">{body}</div>
      <div className="flex shrink-0 items-start gap-2 border-t border-line px-3 py-2 text-meta text-dim">
        <span className="min-w-0 flex-1">{footnote}</span>
        <SaveLine state={state} quiet={page !== 'root'} />
      </div>
    </div>
  )
}

/** The instructions with one more line at the end, on its own line. */
export const withLine = (instructions: string, line: string): string => {
  const kept = instructions.trimEnd()
  return kept === '' ? `${line}\n` : `${kept}\n\n${line}\n`
}

/** The rule a memory-off agent offered, added only when the user says so. */
function SuggestedLine({ name, line, onAdd, onDismiss }: { name: string; line: string; onAdd: () => void; onDismiss: () => void }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2.5">
      <span className="text-meta text-dim">{name} offered this line. It is not in the instructions until you add it.</span>
      <span className="text-[14px] text-text [overflow-wrap:anywhere]">{line}</span>
      <div className="flex gap-2">
        <Button variant="primary" size="small" onClick={onAdd}>Add to instructions</Button>
        <Button size="small" onClick={onDismiss}>Dismiss</Button>
      </div>
    </div>
  )
}

function PanelHeader({ onBack, onClose, children }: { onBack?: () => void; onClose: (() => void) | undefined; children: ReactNode }) {
  return (
    <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-line pr-2 pl-2.5">
      {onBack === undefined ? null : <IconButton icon={ArrowLeft01Icon} label="Back" onClick={onBack} />}
      <h2 className="m-0 flex min-w-0 flex-1 items-center gap-1.5 pl-1 text-label font-normal">{children}</h2>
      {onClose === undefined ? null : <IconButton icon={Cancel01Icon} label="Close agent settings" onClick={onClose} />}
    </div>
  )
}

/** Saved stays implicit on a page; anything else is said wherever the user is. */
function SaveLine({ state, quiet }: { state: SaveState; quiet: boolean }) {
  if (state.kind === 'saved') return quiet ? null : <span role="status" className="flex-none">Saved</span>
  if (state.kind === 'saving') return <span role="status" className="flex-none">Saving…</span>
  return <span role="alert" className="min-w-0 max-w-[60%] text-right text-danger">{state.text}</span>
}

function Group({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      {title === undefined ? null : <span className="pl-0.5 text-meta font-medium text-dim">{title}</span>}
      <div className="overflow-hidden rounded-lg border border-line bg-surface-2 [&>*+*]:border-t [&>*+*]:border-line">{children}</div>
    </div>
  )
}

function Row({ icon, label, value, danger = false, disabled = false, onClick }: {
  icon: Parameters<typeof Icon>[0]['icon']
  label: string
  value?: string
  danger?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      className={`flex min-h-[42px] w-full cursor-pointer items-center gap-2.5 border-0 bg-transparent px-3 text-left text-[14px] outline-none hover:bg-user-bg focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary disabled:cursor-default disabled:opacity-45 ${danger ? 'text-danger' : 'text-muted'}`}
      onClick={onClick}
    >
      <Icon icon={icon} size={16} />
      <span className={danger ? '' : 'text-text'}>{label}</span>
      {danger ? null : (
        <>
          <span className="ml-auto truncate text-label text-dim">{value}</span>
          <Icon icon={ArrowRight01Icon} size={14} />
        </>
      )}
    </button>
  )
}

function SwitchRow({ label, hint, warn = false, checked, disabled = false, onChange }: {
  label: string
  hint?: string
  warn?: boolean
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[14px] text-text">{label}</span>
        {hint === undefined ? null : <span className={`text-meta ${warn ? 'text-warn' : 'text-dim'}`}>{hint}</span>}
      </span>
      <Switch label={label} checked={checked} disabled={disabled} onChange={onChange} />
    </div>
  )
}

function RootPage({ draft, agent, registry, notes, routineCount, subagents, edit, open, requestEvents, onDeleteAgent }: {
  draft: AgentDraft
  agent: AgentConfig
  registry: McpServerConfig[]
  notes: NotesLoad
  routineCount: number
  subagents: PersonaSubagents
  edit: ReturnType<typeof useAgentAutosave>['edit']
  open: (page: Page) => void
  requestEvents: RequestEvents
  onDeleteAgent: (agentId: string, requestId: string) => boolean
}) {
  const { start, pending } = useRequest(requestEvents)
  const [armed, setArmed] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const name = draft.name.trim() || agent.name
  const lines = draft.character.split('\n').length
  // The mock stays offered only to an agent already on it, so it keeps its way out.
  const providers = PROVIDERS.map((option) => option.value).filter((driver) => driver !== 'mock' || agent.driver === 'mock')
  const access = [
    draft.isCos ? 'Chief of staff' : null,
    draft.placement === 'session' ? 'Sessions' : null,
    draft.memoryScope ? 'Memory on' : 'Memory off',
  ].filter((part) => part !== null).join(' · ')

  const remove = () => {
    setArmed(false)
    setProblem(null)
    const sent = start((requestId) => onDeleteAgent(agent.id, requestId), { onNotice: (notice) => setProblem(notice.text) })
    if (!sent) setProblem('Nothing was sent, the connection is down.')
  }

  return (
    <>
      <button
        type="button"
        className="relative cursor-pointer self-center rounded-full border-0 bg-transparent p-0 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        aria-label="Change face"
        title="Change face"
        onClick={() => open('face')}
      >
        <Avatar name={draft.name} color={safeHex(draft.color)} src={draft.avatar} shape={draft.avatarShape} tone={draft.avatarTone} size={72} />
        <span className="absolute right-[-2px] bottom-0.5 grid size-[22px] place-items-center rounded-full border border-line bg-surface-2 text-muted">
          <Icon icon={PencilEdit02Icon} size={12} />
        </span>
      </button>

      <label className="flex flex-col gap-1.5">
        <span className={formLabelClass}>Name</span>
        <input className={formInputClass} value={draft.name} onChange={(event) => edit({ name: event.target.value }, true)} />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className={formLabelClass}>What does {name} help with?</span>
        <textarea
          className={`${formInputClass} resize-none leading-relaxed`}
          rows={2}
          value={draft.description}
          onChange={(event) => edit({ description: event.target.value }, true)}
        />
        <span className={formHintClass}>Routing reads this to decide who takes a task.</span>
      </label>

      <div className="flex flex-col gap-1.5">
        <span className="pl-0.5 text-meta font-medium text-dim">Brain</span>
        <ModelField
          // An agent saved before models were required runs on its driver's default; say which.
          draft={draft.model === undefined ? { ...draft, model: defaultModel(draft.driver) } : draft}
          providers={providers}
          disabled={false}
          opens="down"
          onChange={(next) => edit({ ...next, speed: fastFor(next.driver, next.model, next.speed) })}
        />
      </div>
      <Group>
        {supportsFastMode(draft.driver, draft.model) ? (
          <SwitchRow
            label="Fast mode"
            hint="Answers sooner, at a higher cost per turn."
            checked={draft.speed === 'fast'}
            onChange={(fast) => edit(fast ? { speed: 'fast' } : { speed: undefined })}
          />
        ) : null}
        <Row icon={AiNetworkIcon} label="Subagents" value={subagents === undefined ? 'As in Settings' : 'Narrowed'} onClick={() => open('subagents')} />
      </Group>

      <Group title="Knows">
        <Row icon={File01Icon} label="Instructions" value={`${lines} ${lines === 1 ? 'line' : 'lines'}`} onClick={() => open('instructions')} />
        <Row icon={Book02Icon} label="Notes" value={notesValue(draft.memoryScope, notes)} onClick={() => open('notes')} />
        <Row icon={AiMagicIcon} label="Skills" value={`${draft.skillIds?.length ?? 0} on`} onClick={() => open('skills')} />
        <Row icon={LinkSquare02Icon} label="Connections" value={`${attachedServers(draft, registry).length} on`} onClick={() => open('connections')} />
      </Group>

      <Group title="Does">
        <Row icon={Clock01Icon} label="Routines" value={routineCount === 0 ? 'None yet' : `${routineCount}`} onClick={() => open('routines')} />
        <Row icon={UserGroupIcon} label="Access" value={access} onClick={() => open('access')} />
      </Group>

      <div className="mt-1.5 flex flex-col gap-1.5">
        {armed ? (
          <ConfirmStrip
            wrap
            question={`Delete ${name}? Past messages stay, labelled by id.`}
            onConfirm={remove}
            onCancel={() => setArmed(false)}
          />
        ) : (
          <Group>
            <Row icon={Delete02Icon} label={pending ? 'Deleting…' : `Delete ${name}`} danger disabled={pending} onClick={() => setArmed(true)} />
          </Group>
        )}
        {problem === null ? null : <p role="alert" className="m-0 px-0.5 text-label text-danger">{problem}</p>}
      </div>
    </>
  )
}

function notesValue(memory: boolean, load: NotesLoad): string {
  if (!memory) return 'Memory off'
  if (load.kind !== 'ready') return ''
  if (load.notes === undefined || load.notes.content.trim() === '') return 'Empty'
  const words = load.notes.content.trim().split(/\s+/).length
  return `${words} ${words === 1 ? 'word' : 'words'}`
}

function NotesPage({ name, memory, notes }: { name: string; memory: boolean; notes: NotesLoad }) {
  if (!memory) {
    return <p className="m-0 text-[14px] text-dim">Memory is off, so {name} keeps no notes. Turn memory on under Access, or put lasting rules in the instructions.</p>
  }
  if (notes.kind === 'loading') return <p role="status" className="m-0 text-[14px] text-dim">Loading notes…</p>
  if (notes.kind === 'error') return <p role="alert" className="m-0 text-[14px] text-danger">{notes.message}</p>
  if (notes.notes === undefined || notes.notes.content.trim() === '') {
    return <p className="m-0 text-[14px] text-dim">{name} has no notes yet. When you tell it how you want it to work, it writes that here.</p>
  }
  return (
    <article className="text-label leading-[1.6] text-text">
      <Markdown text={notes.notes.content} variant="panel" />
      {notes.notes.truncated ? <p className="mt-3 mb-0 text-meta text-dim">Over the cap, the rest is only in the file.</p> : null}
    </article>
  )
}

function RoutinesPage({ name, routines }: { name: string; routines: Routine[] }) {
  if (routines.length === 0) {
    return (
      <p className="m-0 text-[14px] text-dim">
        No routines yet. Ask {name} in the chat to do something on a schedule, for example "every Friday at 16:00, draft the weekly status".
      </p>
    )
  }
  return (
    <Group>
      {routines.map((routine) => (
        <div key={routine.id} className="flex flex-col gap-0.5 px-3 py-2.5">
          <span className="text-[14px] text-text">{routine.name}</span>
          <span className="text-meta text-dim">{routine.enabled ? describeSchedule(routine) : `Off · ${describeSchedule(routine)}`}</span>
        </div>
      ))}
    </Group>
  )
}

function AccessPage({ draft, agent, agents, edit }: {
  draft: AgentDraft
  agent: AgentConfig
  agents: AgentConfig[]
  edit: ReturnType<typeof useAgentAutosave>['edit']
}) {
  const session = draft.placement === 'session'
  const holder = cosOf(agents)
  const other = holder !== null && holder.id !== agent.id ? holder : null
  // Counted over the others, so unpinning and pinning again is always allowed.
  const topFull = agents.filter((each) => each.id !== agent.id && each.pinned === true).length >= CHAT_LIST_PIN_LIMIT
  // Summons happen in a shared room, which seats only agents of the same placement.
  const household = agents.filter((each) => each.id !== agent.id &&
    (each.placement === undefined || draft.placement === undefined || (each.placement === 'session') === session))
  const picked = new Set(draft.mentionAllowlist ?? [])

  const toggleSummon = (id: string) => {
    const next = new Set(picked)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    // Roster order rather than click order, so the same picks always save the same list.
    edit({ mentionAllowlist: household.filter((each) => next.has(each.id)).map((each) => each.id) })
  }

  return (
    <>
      <Group>
        <SwitchRow
          label="Memory"
          hint="Gets your personal memory and keeps its own notes. Off means no notes."
          checked={draft.memoryScope}
          onChange={(memoryScope) => edit({ memoryScope })}
        />
        {session ? null : (
          <SwitchRow
            label="Chief of staff"
            hint={!draft.isCos && other !== null
              ? `${other.name} holds it now. Turning this on takes it; only one agent can.`
              : 'Takes every message you do not address to someone else.'}
            warn={!draft.isCos && other !== null}
            checked={draft.isCos}
            onChange={(isCos) => edit({ isCos })}
          />
        )}
        <SwitchRow
          label="Works in Sessions"
          hint={session ? 'Leads and helps in project work. Has no DM.' : 'Can lead and help in project work.'}
          checked={session}
          onChange={(on) => edit(on ? { placement: 'session', isCos: false, pinned: false, railPinned: false } : { placement: 'chat' })}
        />
        {session ? null : (
          <>
            <SwitchRow label="Pin to rail" checked={draft.railPinned === true} onChange={(railPinned) => edit({ railPinned })} />
            <SwitchRow
              label="Pin to top of Agents"
              {...(topFull && draft.pinned !== true ? { hint: `Already ${CHAT_LIST_PIN_LIMIT} pinned there; unpin one first.`, warn: true } : {})}
              checked={draft.pinned === true}
              disabled={topFull && draft.pinned !== true}
              onChange={(pinned) => edit({ pinned })}
            />
          </>
        )}
      </Group>
      {household.length === 0 ? null : (
        <div className="flex flex-col gap-1.5">
          <span className={formLabelClass}>May summon in shared rooms</span>
          <div className="flex flex-wrap gap-1.5">
            {household.map((each) => (
              <Pill key={each.id} label={`@${each.name}`} on={picked.has(each.id)} onToggle={() => toggleSummon(each.id)} />
            ))}
          </div>
          <span className={formHintClass}>Private messages are not restricted.</span>
        </div>
      )}
    </>
  )
}

/** The agent's standing notes as its next turn would get them, asked again when memory flips. */
function useAgentNotes(
  agentId: string,
  memory: boolean,
  status: ConnectionStatus,
  requestEvents: RequestEvents,
  onLoad: (agentId: string, requestId: string) => boolean,
  /** A change reads the notes again. */
  read: number,
): NotesLoad {
  const [load, setLoad] = useState<NotesLoad>({ kind: 'loading' })
  useEffect(() => {
    if (!memory) return
    if (status !== 'live') {
      setLoad({ kind: 'error', message: 'Connect to Manor to load the notes.' })
      return
    }
    setLoad({ kind: 'loading' })
    const requestId = crypto.randomUUID()
    const unsubscribe = requestEvents.subscribe((response) => {
      if (response.requestId !== requestId) return
      if (response.type === 'agent_notes') setLoad({ kind: 'ready', notes: response.notes })
      else if (response.type === 'notice') setLoad({ kind: 'error', message: response.text })
    })
    if (!onLoad(agentId, requestId)) setLoad({ kind: 'error', message: 'Could not load the notes. Try again.' })
    return unsubscribe
  }, [agentId, memory, status, requestEvents, onLoad, read])
  return load
}

/**
 * The agent's subagent narrowing, which lives in the house policy rather than on the
 * agent. Saved as it changes, one write at a time, the latest pick riding on the next.
 */
function useSubagentsAutosave(
  agentId: string,
  policy: SubagentPolicy | null,
  status: ConnectionStatus,
  requestEvents: RequestEvents,
  onSave: (policy: SubagentPolicy, requestId: string) => boolean,
) {
  const { start, cancel } = useRequest(requestEvents)
  const stored: PersonaSubagents = policy?.personas[agentId]
  const [own, setOwn] = useState<PersonaSubagents>(stored)
  const [problem, setProblem] = useState<string | null>(null)
  const latest = useRef(own)
  const pending = useRef(false)
  const busy = useRef(false)
  const outstanding = useRef<string | null>(null)
  const policyRef = useRef(policy)
  policyRef.current = policy
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave

  /** The house policy with this agent's entry as it now stands. */
  const withOwn = (base: SubagentPolicy): SubagentPolicy => {
    const personas = { ...base.personas }
    if (latest.current === undefined) delete personas[agentId]
    else personas[agentId] = latest.current
    return { ...base, personas }
  }

  const flush = () => {
    const base = policyRef.current
    if (!pending.current || busy.current || base === null) return
    pending.current = false
    const next = withOwn(base)
    const sent = start((requestId) => {
      outstanding.current = requestId
      return onSave(next, requestId)
    }, {
      onAck: () => {
        busy.current = false
        flush()
      },
      onNotice: (notice) => {
        busy.current = false
        pending.current = true
        setProblem(notice.text)
      },
    })
    if (!sent) {
      pending.current = true
      setProblem('Not saved, the connection is down.')
      return
    }
    busy.current = true
    setProblem(null)
  }

  // The policy's echo, or a change from Settings, lands while nothing here is waiting.
  const storedKey = JSON.stringify(stored ?? null)
  useEffect(() => {
    if (pending.current || busy.current) return
    latest.current = stored
    setOwn(stored)
    // Keyed on the stored entry only.
  }, [storedKey])

  // Same rules as the agent's own autosave: a dropped answer is given up and the pick
  // goes out again once the connection is back; a pick still waiting goes out on close.
  useEffect(() => {
    if (status !== 'live') {
      if (!busy.current) return
      cancel()
      busy.current = false
      outstanding.current = null
      pending.current = true
      setProblem('Not saved, the connection is down.')
    } else if (pending.current) flush()
    // Keyed on the connection only.
  }, [status])
  useEffect(() => () => {
    const base = policyRef.current
    if (!pending.current || base === null) return
    const next = withOwn(base)
    const save = onSaveRef.current
    sendAfter(requestEvents, busy.current ? outstanding.current : null, () => save(next, crypto.randomUUID()))
    // Runs once, on close; the request events outlive the panel.
  }, [])

  const change = (next: PersonaSubagents) => {
    latest.current = next
    pending.current = true
    setOwn(next)
    flush()
  }

  return { own, change, problem }
}
