import { RefreshIcon } from '@hugeicons/core-free-icons'
import type { ServerMessage } from '@manor/contracts'
import { useEffect, useState } from 'react'
import type { RequestEvents } from '../useRequest'
import type { ConnectionStatus } from '../useWorkspace'
import { Markdown } from './Markdown'
import { Button } from './ui/Button'
import { IconButton } from './ui/IconButton'
import { SegmentedControl, type SegmentOption } from './ui/SegmentedControl'

type Response = Extract<ServerMessage, { type: 'chat_summary' }>
type Summary = NonNullable<Response['summary']>
export type ChatSummaryLoad =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; summary: Response['summary']; notes: Response['notes'] }

export type AgentMemoryTab = 'summary' | 'notes'

type Notes = Extract<ServerMessage, { type: 'agent_notes' }>['notes']
export type AgentNotesLoad = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; notes: Notes }

const DATE_TIME = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

const when = (value: number): string => DATE_TIME.format(new Date(value))

/** A missing source timestamp stays visible as missing instead of becoming a guessed range. */
export function agentMemoryCoverage(summary: Summary): string {
  if (summary.fromAt === null || summary.throughAt === null) return 'Source range unavailable'
  if (summary.fromAt === summary.throughAt) return when(summary.throughAt)
  return `${when(summary.fromAt)} to ${when(summary.throughAt)}`
}

/**
 * The rolling summary Manor seeds a fresh session from, as the server holds it now.
 * DMs and project threads answer; `revision` asks again. `noun` names what failed.
 */
export function useChatSummary(
  chatId: string | undefined,
  status: ConnectionStatus,
  requestEvents: RequestEvents,
  onLoad: ((chatId: string, requestId: string) => boolean) | undefined,
  revision: number,
  noun: string,
): ChatSummaryLoad {
  const [state, setState] = useState<ChatSummaryLoad>({ kind: 'loading' })
  useEffect(() => {
    if (chatId === undefined || onLoad === undefined) return
    if (status !== 'live') {
      setState({ kind: 'error', message: `Connect to Manor to load ${noun}.` })
      return
    }
    setState({ kind: 'loading' })
    const requestId = crypto.randomUUID()
    const timer = window.setTimeout(() => setState({ kind: 'error', message: `Loading ${noun} took too long. Try again.` }), 15_000)
    const unsubscribe = requestEvents.subscribe((response) => {
      if (response.requestId !== requestId) return
      if (response.type === 'chat_summary' && response.chatId === chatId) {
        window.clearTimeout(timer)
        setState({ kind: 'ready', summary: response.summary, notes: response.notes })
      } else if (response.type === 'notice') {
        window.clearTimeout(timer)
        setState({ kind: 'error', message: response.text })
      }
    })
    if (!onLoad(chatId, requestId)) {
      window.clearTimeout(timer)
      setState({ kind: 'error', message: `Could not load ${noun}. Try again.` })
    }
    return () => { window.clearTimeout(timer); unsubscribe() }
  }, [chatId, status, requestEvents, onLoad, revision, noun])
  return state
}

/** What the summary covers, when it last moved, and the text itself. Read-only by design. */
export function ChatSummaryView({ summary }: { summary: Summary }) {
  return (
    <>
      <dl className="m-0 grid grid-cols-[4.25rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 border-b border-line px-5 py-4 text-label">
        <dt className="text-dim">Covers</dt>
        <dd
          className="m-0 text-muted tabular-nums"
          title={summary.fromEventId === null
            ? `Through ${summary.throughEventId}`
            : `${summary.fromEventId} through ${summary.throughEventId}`}
        >
          {agentMemoryCoverage(summary)}
        </dd>
        <dt className="text-dim">Updated</dt>
        <dd className="m-0 text-muted tabular-nums">
          <time dateTime={new Date(summary.updatedAt).toISOString()}>{when(summary.updatedAt)}</time>
        </dd>
      </dl>
      <article className="px-5 py-5 text-label leading-[1.6] text-text">
        <Markdown text={summary.text} variant="panel" />
      </article>
    </>
  )
}

interface Props {
  /** The agent's DM, whose compacted conversation is the Summary. An agent without one has only Notes. */
  chatId: string | undefined
  name: string
  /** The agent's memory switch. Off means it keeps no notes, and the Notes tab says so. */
  memory: boolean
  notes: AgentNotesLoad
  tab: AgentMemoryTab
  status: ConnectionStatus
  requestEvents: RequestEvents
  onLoadSummary: ((chatId: string, requestId: string) => boolean) | undefined
  onTab: (tab: AgentMemoryTab) => void
  /** Reads the notes file again; the summary asks again by itself. */
  onRefreshNotes: () => void
}

/**
 * What an agent carries between turns, read-only by design: the compacted conversation
 * of its DM and its standing notes. The Memory page of Agent settings, in both hosts.
 */
export function AgentMemoryView({ chatId, name, memory, notes, tab, status, requestEvents, onLoadSummary, onTab, onRefreshNotes }: Props) {
  const [revision, setRevision] = useState(0)
  const state = useChatSummary(chatId, status, requestEvents, onLoadSummary, revision, 'agent memory')
  const hasSummary = chatId !== undefined && onLoadSummary !== undefined
  const view: AgentMemoryTab = hasSummary ? tab : 'notes'
  const tabs: readonly SegmentOption<AgentMemoryTab>[] = [
    { value: 'summary', label: 'Summary', tabId: 'agent-memory-tab-summary', panelId: 'agent-memory-summary' },
    { value: 'notes', label: 'Notes', tabId: 'agent-memory-tab-notes', panelId: 'agent-memory-notes' },
  ]
  const refresh = () => {
    setRevision((value) => value + 1)
    onRefreshNotes()
  }

  return (
    <>
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-line pr-2 pl-5">
        {hasSummary
          ? <SegmentedControl label="Agent memory view" options={tabs} value={view} onChange={onTab} />
          : <span id="agent-memory-tab-notes" className="text-label font-medium text-muted">Notes</span>}
        <span className="flex-1" />
        <IconButton icon={RefreshIcon} label="Refresh agent memory" onClick={refresh} />
      </div>
      <div
        id={`agent-memory-${view}`}
        role="tabpanel"
        aria-labelledby={`agent-memory-tab-${view}`}
        className="min-h-0 flex-1 overflow-y-auto text-label text-text"
      >
        {view === 'notes' ? <StandingNotes name={name} memory={memory} notes={notes} /> : (
          <>
            {state.kind === 'loading' ? <p role="status" className="m-0 px-5 py-4 text-dim">Loading agent memory…</p> : null}
            {state.kind === 'error' ? (
              <div role="alert" className="px-5 py-4">
                <p>{state.message}</p>
                <Button variant="secondary" size="compact" onClick={refresh}>Retry</Button>
              </div>
            ) : null}
            {state.kind !== 'ready' ? null : state.summary === null
              ? <p className="m-0 px-5 py-4 text-dim">No agent memory saved for this conversation yet.</p>
              : <ChatSummaryView summary={state.summary} />}
          </>
        )}
      </div>
    </>
  )
}

/** The notes file as the agent's next turn gets it, or the honest reason there is none. */
function StandingNotes({ name, memory, notes }: { name: string; memory: boolean; notes: AgentNotesLoad }) {
  if (!memory) {
    return <p className="m-0 px-5 py-4 text-dim">Memory is off, so {name} keeps no notes. Turn memory on under Access, or put lasting rules in the instructions.</p>
  }
  if (notes.kind === 'loading') return <p role="status" className="m-0 px-5 py-4 text-dim">Loading notes…</p>
  if (notes.kind === 'error') return <p role="alert" className="m-0 px-5 py-4 text-danger">{notes.message}</p>
  if (notes.notes === undefined || notes.notes.content.trim() === '') {
    return <p className="m-0 px-5 py-4 text-dim">{name} has no notes yet. When you tell it how you want it to work, it writes that here.</p>
  }
  return (
    <section aria-label="Standing notes">
      <dl className="m-0 grid grid-cols-[4.25rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 border-b border-line px-5 py-4 text-label">
        <dt className="text-dim">Notes</dt>
        <dd className="m-0 truncate text-muted" title={notes.notes.path}>{notes.notes.path}</dd>
      </dl>
      <article className="px-5 py-5 text-label leading-[1.6] text-text">
        <Markdown text={notes.notes.content} variant="panel" />
      </article>
    </section>
  )
}
