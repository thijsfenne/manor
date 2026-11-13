import { Cancel01Icon, RefreshIcon } from '@hugeicons/core-free-icons'
import type { ServerMessage } from '@manor/contracts'
import { useEffect, useState, type ComponentPropsWithoutRef, type CSSProperties } from 'react'
import type { RequestEvents } from '../useRequest'
import type { ConnectionStatus } from '../useWorkspace'
import { Markdown } from './Markdown'
import { Button } from './ui/Button'
import { DOCK_FLOAT, DOCK_PANEL_GAP, DOCK_PANEL_SHELL } from './ui/dockPanel'
import { IconButton } from './ui/IconButton'
import { SegmentedControl, type SegmentOption } from './ui/SegmentedControl'

type Response = Extract<ServerMessage, { type: 'chat_summary' }>
type Summary = NonNullable<Response['summary']>
export type ChatSummaryLoad =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; summary: Response['summary']; notes: Response['notes'] }

type View = 'summary' | 'notes'

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
  chatId: string
  status: ConnectionStatus
  requestEvents: RequestEvents
  onLoad: (chatId: string, requestId: string) => boolean
  onClose: () => void
  width: number
  resizing: boolean
  resizeProps: ComponentPropsWithoutRef<'div'>
  overlay?: boolean
  revealed?: boolean
  phone?: boolean
}

/** The standing notes and compacted conversation a DM's agent will receive, read-only by design. */
export function AgentMemoryPanel({
  chatId,
  status,
  requestEvents,
  onLoad,
  onClose,
  width,
  resizing,
  resizeProps,
  overlay = false,
  revealed = true,
  phone = false,
}: Props) {
  const [revision, setRevision] = useState(0)
  // The choice belongs to one DM; opening another chat starts on Summary again.
  const [picked, setPicked] = useState<{ chatId: string; view: View }>({ chatId, view: 'summary' })
  const state = useChatSummary(chatId, status, requestEvents, onLoad, revision, 'agent memory')

  const summary = state.kind === 'ready' ? state.summary : null
  const notes = state.kind === 'ready' ? state.notes : undefined
  const view: View = notes !== undefined && picked.chatId === chatId ? picked.view : 'summary'
  const views: readonly SegmentOption<View>[] = [
    { value: 'summary', label: 'Summary', tabId: 'agent-memory-tab-summary', panelId: 'agent-memory-summary' },
    { value: 'notes', label: 'Notes', tabId: 'agent-memory-tab-notes', panelId: 'agent-memory-notes', disabled: notes === undefined },
  ]

  return (
    <aside
      aria-label="Agent memory"
      className={`${phone ? 'absolute inset-0 z-[8]' : `${overlay ? `dock-panel-reveal ${DOCK_FLOAT} max-w-[calc(100%-16px)]` : 'relative'} my-2 mr-2`} flex min-h-0 flex-col ${DOCK_PANEL_SHELL}`}
      data-open={overlay && !phone ? revealed : undefined}
      style={{
        width: phone ? '100%' : `calc(var(--memory-width) - ${DOCK_PANEL_GAP}px)`,
        '--memory-width': `${width}px`,
      } as CSSProperties}
    >
      {phone ? null : (
        <div
          {...resizeProps}
          className="group absolute inset-y-0 left-0 z-30 w-2 touch-none cursor-col-resize outline-none max-[760px]:hidden"
        >
          <span
            className={`absolute inset-y-0 left-1/2 w-px -translate-x-1/2 ${
              resizing
                ? 'bg-primary'
                : 'bg-transparent group-hover:bg-muted group-focus-visible:bg-primary group-active:bg-primary'
            }`}
          />
        </div>
      )}
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-line pr-2 pl-3.5">
        <h2 className="m-0 min-w-0 flex-1 truncate text-label font-medium text-muted">Agent memory</h2>
        <SegmentedControl label="Agent memory view" options={views} value={view} onChange={(next) => setPicked({ chatId, view: next })} />
        {state.kind === 'ready' ? (
          <IconButton icon={RefreshIcon} label="Refresh agent memory" onClick={() => setRevision((value) => value + 1)} />
        ) : null}
        <IconButton icon={Cancel01Icon} label="Close agent memory" onClick={onClose} />
      </div>

      <div
        id={`agent-memory-${view}`}
        role="tabpanel"
        aria-labelledby={`agent-memory-tab-${view}`}
        className="min-h-0 flex-1 overflow-y-auto text-label text-text"
      >
        {state.kind === 'loading' ? <p role="status" className="px-5 py-4 text-dim">Loading agent memory…</p> : null}
        {state.kind === 'error' ? (
          <div role="alert" className="px-5 py-4">
            <p>{state.message}</p>
            <Button variant="secondary" size="compact" onClick={() => setRevision((value) => value + 1)}>Retry</Button>
          </div>
        ) : null}
        {view !== 'notes' || notes === undefined ? null : (
          <section aria-label="Standing notes">
            <dl className="m-0 grid grid-cols-[4.25rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 border-b border-line px-5 py-4 text-label">
              <dt className="text-dim">Notes</dt>
              <dd className="m-0 truncate text-muted" title={notes.path}>{notes.path}</dd>
              {notes.truncated ? (
                <>
                  <dt className="text-dim">Cut</dt>
                  <dd className="m-0 text-muted">Over the cap, the rest is only in the file.</dd>
                </>
              ) : null}
            </dl>
            <article className="px-5 py-5 text-label leading-[1.6] text-text">
              <Markdown text={notes.content} variant="panel" />
            </article>
          </section>
        )}
        {view === 'summary' && state.kind === 'ready' && summary === null ? (
          <p className="px-5 py-4 text-dim">No agent memory saved for this conversation yet.</p>
        ) : null}
        {view !== 'summary' || summary === null ? null : <ChatSummaryView summary={summary} />}
      </div>
    </aside>
  )
}
