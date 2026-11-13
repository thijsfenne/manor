import { SINGLE_CHAT_VOICE } from '@manor/contracts'
import { useEffect, useRef, useState } from 'react'
import {
  ArrowRight01Icon,
  BubbleChatIcon,
  Delete02Icon,
  Edit02Icon,
  PlayIcon,
} from '@hugeicons/core-free-icons'
import type { AgentConfig, Chat, Project, Routine, RoutineRun } from '@manor/contracts'
import {
  describeSchedule,
  isRunning,
  latestResultRun,
  routineNextRun,
  runHasResult,
  routineOffLabel,
  routineStatus,
} from '../../routines'
import { isHomeRoom, type Notice } from '../../state'
import { useRequest, type RequestEvents } from '../../useRequest'
import { ConfirmStrip } from '../Confirm'
import { Icon } from '../Icon'
import { Markdown } from '../Markdown'
import { Button } from '../ui/Button'
import { Fold, FoldChevron } from '../ui/Fold'
import { Switch } from '../ui/Switch'
import { RequestNotice } from '../ui/RequestNotice'

interface RoutineDetailProps {
  routine: Routine
  /** Run threads of a project task, newest first; only the delete question counts them. */
  runs: readonly Chat[]
  /** Every kind of task's runs, newest first. Absent until asked for, which is not a task that never ran. */
  history: { chatId: string | null; runs: readonly RoutineRun[] } | undefined
  projects: Project[]
  agents: AgentConfig[]
  notice: Notice | null
  requestEvents: RequestEvents
  onEdit: () => void
  /** Opens a run thread, or the DM a task speaks in. */
  onOpenChat: (chatId: string) => void
  onRequestHistory: (routineId: string) => void
  /** A run's result is on screen. */
  onMarkRead: (routineId: string, runIds: readonly string[]) => void
  onDelete: (routineId: string, requestId: string) => boolean
  /** The task is gone; the page picks the next one. */
  onDeleted: () => void
  onSetEnabled: (routineId: string, enabled: boolean) => boolean
  onRunNow: (routineId: string) => boolean
}

/**
 * One task in the pane beside the Scheduled tasks list, in one column: the acts, a
 * compact block of settings, the latest result, every run, then the instruction
 * folded away. Unread follows what is shown: the latest result counts as read once
 * its card scrolls into view, an older run when its History row is unfolded.
 */
export function RoutineDetail({
  routine,
  runs,
  history,
  projects,
  agents,
  notice,
  requestEvents,
  onEdit,
  onOpenChat,
  onRequestHistory,
  onMarkRead,
  onDelete,
  onDeleted,
  onSetEnabled,
  onRunNow,
}: RoutineDetailProps) {
  const [deleting, setDeleting] = useState(false)
  const deletion = useRequest(requestEvents)
  const project = projects.find((entry) => entry.id === routine.projectId)
  const agent = agents.find((entry) => entry.id === routine.agentId)
  const agentName = agent?.name ?? (routine.agentId === SINGLE_CHAT_VOICE.id ? 'Single agent' : routine.agentId)
  const running = isRunning(routine)
  const status = routineStatus(routine)
  const hasStatus = running || !routine.enabled || routine.lastRunAt !== null || routine.lastSkippedAt !== null
  const ended = routine.endState !== null
  // A one-time task has no on and off of its own: it runs once and says how it ended.
  // The switch stays only on a pending one that was previously paused, as the way back.
  const showSwitch = routine.runAt === null || (!ended && !routine.enabled)
  const hideStateLabel = ended || (!routine.enabled && !running)
  const [instructionsOpen, setInstructionsOpen] = useState(false)
  const [openRuns, setOpenRuns] = useState<ReadonlySet<string>>(() => new Set())
  const historyRuns = history?.runs
  const latest = historyRuns === undefined ? undefined : latestResultRun(historyRuns)
  const latestUnread = latest !== undefined && routine.unreadRunIds.includes(latest.id)
  const latestCard = useRef<HTMLDivElement>(null)
  // Unread runs the history on hand has no row for yet. Every dot needs a row that
  // can clear it, so a new one asks again; a mark only shrinks this and asks nothing.
  const unlisted = historyRuns === undefined
    ? ''
    : routine.unreadRunIds.filter((id) => !historyRuns.some((run) => run.id === id)).join(' ')

  useEffect(() => {
    onRequestHistory(routine.id)
  }, [routine.id, routine.chatId, routine.runningSince, routine.lastRunAt, onRequestHistory])

  useEffect(() => {
    if (unlisted !== '') onRequestHistory(routine.id)
  }, [routine.id, unlisted, onRequestHistory])

  // Rendered is not read: on a short window the card can sit below the fold, so the
  // dot goes only once part of it is actually in view.
  useEffect(() => {
    const card = latestCard.current
    if (latest === undefined || !latestUnread || card === null) return
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting !== true) return
      observer.disconnect()
      onMarkRead(routine.id, [latest.id])
    })
    observer.observe(card)
    return () => observer.disconnect()
  }, [routine.id, latest, latestUnread, onMarkRead])

  const toggleRun = (run: RoutineRun) => {
    const opening = !openRuns.has(run.id)
    setOpenRuns((current) => {
      const next = new Set(current)
      if (opening) next.add(run.id)
      else next.delete(run.id)
      return next
    })
    if (opening && routine.unreadRunIds.includes(run.id)) onMarkRead(routine.id, [run.id])
  }

  return (
    <>
      <header className="flex items-start justify-between gap-6 max-[640px]:flex-col">
        <div className="min-w-0">
          <h2 className="m-0 text-[20px] leading-tight font-semibold tracking-[-0.01em]">{routine.name}</h2>
          {routine.description === '' ? null : (
            <p className="mt-1 mb-0 text-label text-muted">{routine.description}</p>
          )}
        </div>
        <div className="flex flex-none flex-wrap items-center gap-1.5">
          {routine.chatId === null ? null : (
            <Button variant="ghost" size="compact" className="inline-flex items-center gap-1.5" onClick={() => onOpenChat(routine.chatId!)}>
              <Icon icon={BubbleChatIcon} size={13} />
              Open chat
            </Button>
          )}
          <Button variant="ghost" size="compact" className="inline-flex items-center gap-1.5" onClick={onEdit}>
            <Icon icon={Edit02Icon} size={13} />
            Edit
          </Button>
          <Button
            variant="primary"
            size="compact"
            className="inline-flex items-center gap-1.5"
            disabled={!routine.enabled || running}
            title={routine.endState !== null ? 'It already ran once. Edit it and give it a new time to schedule it again.' : !routine.enabled ? 'Turn it on before running it.' : undefined}
            onClick={() => onRunNow(routine.id)}
          >
            <Icon icon={PlayIcon} size={13} />
            Run now
          </Button>
        </div>
      </header>

      {/* Settings as one compact block: at pane width a column per field spent the
          whole first screen before the instruction came into view. */}
      <dl className="mt-5 mb-0 grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-6 gap-y-2 text-label">
        {/* Centred, not on the baseline: the switch has no text line to share with the label. */}
        <dt className="self-center text-dim">Status</dt>
        <dd className="m-0 flex min-w-0 flex-wrap items-center gap-2 self-center">
          {!showSwitch ? null : (
            <Switch
              checked={routine.enabled}
              label={routine.enabled ? 'Turn off' : 'Turn on'}
              onChange={(enabled) => onSetEnabled(routine.id, enabled)}
            />
          )}
          {/* An ended or idle-off task's status line already opens with Done, Off and the like. */}
          {hideStateLabel ? null : <span className="text-text">{routine.enabled ? 'Active' : routineOffLabel(routine)}</span>}
          {!hasStatus ? null : (
            <span className={status.tone === 'error' ? 'text-danger' : hideStateLabel ? 'text-text' : 'text-dim'}>{status.text}</span>
          )}
        </dd>
        <dt className="text-dim">Next run</dt>
        <dd className="m-0 text-text">{routineNextRun(routine)}</dd>
        <dt className="text-dim">{routine.runAt === null ? 'Repeats' : 'Scheduled'}</dt>
        <dd className="m-0 text-text">
          {describeSchedule(routine)} <span className="text-dim">· {routine.timezone}</span>
        </dd>
        <dt className="text-dim">Destination</dt>
        <dd className="m-0 truncate text-text">
          {routine.chatId === null
            ? project === undefined
              ? routine.projectId === null || isHomeRoom(routine.projectId) ? 'No project' : 'Project unavailable'
              : project.name
            : `Direct message with ${agentName}`}
        </dd>
        <dt className="text-dim">Agent</dt>
        <dd className="m-0 truncate text-text">{agentName}</dd>
        <dt className="text-dim">When it finishes</dt>
        <dd className="m-0 text-text">{routine.notify ? 'Ask for attention in the inbox' : 'Do not ask for attention'}</dd>
      </dl>

      <section className="mt-6" aria-labelledby="routine-result-title">
        <h3 id="routine-result-title" className="m-0 mb-2 text-[14px] font-medium text-dim">Latest result</h3>
        {history === undefined ? (
          <p className="m-0 text-[14px] text-dim">Loading…</p>
        ) : latest === undefined ? (
          <p className="m-0 text-[14px] text-dim">No result yet. Quiet checks only show in History.</p>
        ) : (
          <div
            ref={latestCard}
            className={`rounded-xl border px-4 py-3 ${
              latest.state === 'failed' ? 'border-danger/35 bg-danger/5' : 'border-line bg-surface-2/50'
            }`}
          >
            <p className="m-0 mb-1.5 text-[13px] text-dim">
              {runDate(latest.startedAt)}
              {latest.state === 'failed' ? <span className="text-danger"> · Failed</span> : null}
            </p>
            <RunResult run={latest} onOpenChat={onOpenChat} />
          </div>
        )}
      </section>

      <section className="mt-6" aria-labelledby="routine-history-title">
        <h3 id="routine-history-title" className="m-0 text-[14px] font-medium text-dim">History</h3>
        {historyRuns === undefined ? (
          <p className="mt-2 mb-0 rounded-xl border border-dashed border-line px-4 py-6 text-center text-[14px] text-dim">
            Loading runs…
          </p>
        ) : historyRuns.length === 0 ? (
          <p className="mt-2 mb-0 rounded-xl border border-dashed border-line px-4 py-6 text-center text-[14px] text-dim">
            No runs yet
          </p>
        ) : (
          <ol className="mt-2 mb-0 flex list-none flex-col gap-1 p-0">
            {historyRuns.map((run) => (
              <HistoryRow
                key={run.id}
                run={run}
                unread={routine.unreadRunIds.includes(run.id)}
                open={openRuns.has(run.id)}
                onToggle={() => toggleRun(run)}
                onOpenChat={onOpenChat}
              />
            ))}
          </ol>
        )}
      </section>

      <section className="mt-6">
        <button
          type="button"
          className="flex h-7 cursor-pointer items-center gap-1.5 rounded-lg border-0 bg-transparent px-0 text-left text-dim [font:inherit] hover:text-text"
          aria-expanded={instructionsOpen}
          aria-controls="routine-instructions"
          onClick={() => setInstructionsOpen((open) => !open)}
        >
          <FoldChevron open={instructionsOpen} />
          {/* Sized on the span: `[font:inherit]` on the button outranks a text utility. */}
          <span className="text-[14px] font-medium">Instructions</span>
        </button>
        <Fold open={instructionsOpen}>
          <div id="routine-instructions" className="mt-2 max-h-[360px] overflow-y-auto rounded-xl border border-line bg-surface-2/50 px-4 py-3">
            <p className="m-0 whitespace-pre-wrap text-[15px] leading-relaxed text-text">{routine.prompt}</p>
          </div>
        </Fold>
      </section>

      <div className="mt-6">
        {deleting ? (
          <ConfirmStrip
            question={
              routine.chatId === null
                ? `Delete “${routine.name}” and its ${runs.length === 1 ? 'run' : 'runs'}?`
                : `Delete “${routine.name}”? Its direct-message conversation stays.`
            }
            onConfirm={() => {
              setDeleting(false)
              deletion.start((requestId) => onDelete(routine.id, requestId), { onAck: onDeleted })
            }}
            onCancel={() => setDeleting(false)}
          />
        ) : (
          <Button
            variant="danger"
            size="compact"
            className="inline-flex items-center gap-1.5"
            disabled={deletion.pending}
            onClick={() => setDeleting(true)}
          >
            <Icon icon={Delete02Icon} size={13} />
            {deletion.pending ? 'Deleting…' : 'Delete'}
          </Button>
        )}
        {notice === null ? null : <div className="mt-3"><RequestNotice notice={notice} /></div>}
      </div>
    </>
  )
}

/** What a run said, or why it failed, with the way to the whole run when it was cut. */
function RunResult({ run, onOpenChat }: { run: RoutineRun; onOpenChat: (chatId: string) => void }) {
  return (
    <>
      {run.result === null ? (
        <p className="m-0 text-[15px] text-dim">
          {run.state === 'failed' ? 'The run ended without saying why.' : 'No text in this result. Open the run to see what it shared.'}
        </p>
      ) : (
        <div className="text-[15px] leading-relaxed text-text">
          <Markdown text={run.result} />
        </div>
      )}
      {run.chatId === null ? null : (
        <button
          type="button"
          className="mt-2 inline-flex cursor-pointer items-center gap-1 rounded-md border-0 bg-transparent p-0 text-dim [font:inherit] hover:text-text"
          onClick={() => onOpenChat(run.chatId!)}
        >
          <span className="text-[13px]">{run.truncated === true ? 'Read the full run' : 'Open run'}</span>
          <Icon icon={ArrowRight01Icon} size={13} />
        </button>
      )}
    </>
  )
}

/** The words after the date: how the run went, or the first line of what it said. */
function runSummary(run: RoutineRun): string {
  if (run.state === 'running') return 'Running'
  if (run.state === 'failed') return 'Failed'
  if (run.outcome === 'quiet') return '0 results'
  const firstLine = run.result?.split('\n').find((line) => line.trim() !== '')
  return firstLine === undefined ? 'Completed' : firstLine.replace(/[#*_`>]/g, '').trim()
}

interface HistoryRowProps {
  run: RoutineRun
  unread: boolean
  open: boolean
  onToggle: () => void
  onOpenChat: (chatId: string) => void
}

/**
 * One run. A row with something to read unfolds in place, which is what reads it; a
 * run still in flight leads to its live thread instead, and one that left nothing
 * behind is a plain line.
 */
function HistoryRow({ run, unread, open, onToggle, onOpenChat }: HistoryRowProps) {
  const quiet = run.state === 'done' && run.outcome === 'quiet'
  // A failure or a published result always unfolds, even without words: it has to be
  // readable to stop being unread. A quiet check unfolds only when it left a line.
  const expandable = runHasResult(run) || (run.state === 'done' && run.result !== null)
  const live = run.state === 'running' && run.chatId !== null
  const rowClass = 'flex min-h-11 w-full items-center gap-3 rounded-xl border-0 bg-transparent px-3.5 py-2 text-left'
  const content = (
    <>
      <span
        aria-hidden
        className={`h-2 w-2 flex-none rounded-full ${
          run.state === 'running' ? 'bg-busy' : !unread ? '' : run.state === 'failed' ? 'bg-danger' : 'bg-ok'
        }`}
      />
      <span className={`flex-none text-[14px] ${unread ? 'font-semibold text-text' : 'font-medium text-text'}`}>
        {runDate(run.startedAt)}
      </span>
      <span
        className={`min-w-0 flex-1 truncate text-right text-[13px] ${
          run.state === 'failed' ? 'text-danger' : run.state === 'running' ? 'text-text' : 'text-dim'
        } ${quiet && !expandable ? 'opacity-70' : ''}`}
      >
        {runSummary(run)}
      </span>
      {unread ? <span className="sr-only">, unread</span> : null}
      {expandable ? (
        <span className="flex-none text-dim"><FoldChevron open={open} /></span>
      ) : live ? (
        <Icon icon={ArrowRight01Icon} size={15} className="flex-none text-dim" />
      ) : (
        <span className="w-[13px] flex-none" />
      )}
    </>
  )

  return (
    <li className="overflow-hidden rounded-xl bg-surface-2/50">
      {expandable ? (
        <button
          type="button"
          className={`${rowClass} cursor-pointer [font:inherit] hover:bg-surface-2`}
          aria-expanded={open}
          aria-controls={`routine-run-${run.id}`}
          onClick={onToggle}
        >
          {content}
        </button>
      ) : live ? (
        <button
          type="button"
          className={`${rowClass} cursor-pointer [font:inherit] hover:bg-surface-2`}
          onClick={() => onOpenChat(run.chatId!)}
        >
          {content}
        </button>
      ) : (
        <div className={rowClass}>{content}</div>
      )}
      {expandable ? (
        <Fold open={open}>
          <div id={`routine-run-${run.id}`} className="px-3.5 pt-0.5 pb-3 pl-[34px]">
            <RunResult run={run} onOpenChat={onOpenChat} />
          </div>
        </Fold>
      ) : null}
    </li>
  )
}

export const runDate = (at: number): string =>
  new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(at)
