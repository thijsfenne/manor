import { useEffect, useState } from 'react'
import {
  Alert02Icon,
  Delete02Icon,
  Edit02Icon,
  PlayIcon,
  PlusSignIcon,
  Tick02Icon,
} from '@hugeicons/core-free-icons'
import type {
  AgentConfig,
  Chat,
  Project,
  Routine,
  RoutineDraft,
  RoutineRun,
} from '@manor/contracts'
import {
  describeSchedule,
  routineOffLabel,
  emptyRoutineDraft,
  isRunning,
  routineNextRun,
  routineStatus,
  scheduledSections,
  DEFAULT_KIND,
  type ScheduleKind,
} from '../../routines'
import type { Notice } from '../../state'
import { useRequest, type RequestEvents } from '../../useRequest'
import { ConfirmStrip } from '../Confirm'
import { Icon } from '../Icon'
import { Button } from '../ui/Button'
import { Fold, FoldChevron } from '../ui/Fold'
import { SegmentedControl, type SegmentOption } from '../ui/SegmentedControl'
import { useMovedWithin } from '../ui/dockPanel'
import { IconButton } from '../ui/IconButton'
import { RequestNotice } from '../ui/RequestNotice'
import { RoutineDialog } from './RoutineDialog'
import { runDate } from './RoutineDetailView'
import { useRoutineDialog } from './useRoutineDialog'
import { useMinuteClock } from '../../useMinuteClock'

/** One-time tasks and recurring routines answer different questions, so the page shows one at a time. */
const KINDS: readonly SegmentOption<ScheduleKind>[] = [
  { value: 'recurring', label: 'Recurring', tabId: 'scheduled-tab-recurring', panelId: 'scheduled-panel-recurring' },
  { value: 'once', label: 'Once', tabId: 'scheduled-tab-once', panelId: 'scheduled-panel-once' },
]

export interface ChatRoutinesProps {
  /** The conversation these tasks belong to; every routine here posts into it. */
  chatId: string
  /** Who answers a routine made here, which is the persona this direct message is with. */
  agentId: string
  routines: readonly Routine[]
  /** False until the server's routines list has landed, so empty is never guessed. */
  loaded: boolean
  /**
   * The run histories the server has answered with, by routine id. A routine absent
   * from this map has not been asked about yet, which is not a routine that never ran.
   */
  histories: Record<string, { chatId: string | null; runs: RoutineRun[] }>
  projects: Project[]
  chats: Chat[]
  agents: AgentConfig[]
  notice: Notice | null
  requestEvents: RequestEvents
  /** The task opened in place, owned by the host so its back arrow can leave it. */
  selectedId: string | null
  onSelect: (routineId: string | null) => void
  onRequestHistory: (routineId: string) => void
  onSave: (draft: RoutineDraft, requestId: string) => boolean
  onDelete: (routineId: string, requestId: string) => boolean
  onSetEnabled: (routineId: string, enabled: boolean) => boolean
  onRunNow: (routineId: string) => boolean
  onDismissNotice: () => void
  onDialogChange: (open: boolean) => void
}

/**
 * What runs by itself inside one DM: the Scheduled tasks page of Agent settings.
 *
 * The house-wide Scheduled tasks page stays the place routines are managed across every
 * room; this is the same routines seen from the one chat they speak in, so an agent
 * can be given a schedule without leaving the thread it reports to. The list is the
 * page's home and a routine opens in place.
 */
export function ChatRoutines({
  chatId,
  agentId,
  routines,
  loaded,
  histories,
  projects,
  chats,
  agents,
  notice,
  requestEvents,
  selectedId,
  onSelect,
  onRequestHistory,
  onSave,
  onDelete,
  onSetEnabled,
  onRunNow,
  onDismissNotice,
  onDialogChange,
}: ChatRoutinesProps) {
  const [deleting, setDeleting] = useState(false)
  const deletion = useRequest(requestEvents)
  const dialog = useRoutineDialog({ requestEvents, onSave, onDismissNotice, onDialogChange })
  // Falls back to the list on its own when the routine is deleted or moved to
  // another destination, the same way the runtime roster survives a lost persona.
  const selected = routines.find((routine) => routine.id === selectedId) ?? null
  // A delete that was only asked about does not follow the user to another task.
  useEffect(() => setDeleting(false), [selectedId])

  const [pickedKind, setPickedKind] = useState<ScheduleKind | null>(null)
  const kind = pickedKind ?? DEFAULT_KIND

  const movedWithin = useMovedWithin(selected?.id ?? 'list')
  return (
    <>
      {selected === null && loaded ? (
        <div className="flex h-11 shrink-0 items-center gap-1 border-b border-line pr-2 pl-4">
          <SegmentedControl label="Scheduled task kind" options={KINDS} value={kind} onChange={setPickedKind} />
          <span className="flex-1" />
          <IconButton
            icon={PlusSignIcon}
            label="New task in this chat"
            onClick={() => dialog.openDraft(emptyRoutineDraft(null, agentId, chatId))}
          />
        </div>
      ) : null}

      {/* Keyed on the view so the drill-down replays its entry each way, the same two
          classes the runtime roster's list and persona use. */}
      <div
        key={selected?.id ?? 'list'}
        className={`min-h-0 flex-1 overflow-y-auto ${!movedWithin ? '' : selected === null ? 'panel-enter-back' : 'panel-enter-forward'}`}
        {...(selected === null && loaded ? { id: `scheduled-panel-${kind}`, role: 'tabpanel', 'aria-labelledby': `scheduled-tab-${kind}` } : {})}
      >
        {selected === null ? (
          <RoutineList
            kind={kind}
            routines={routines}
            loaded={loaded}
            onOpen={(routineId) => {
              onSelect(routineId)
              onRequestHistory(routineId)
            }}
            onNew={() => dialog.openDraft(emptyRoutineDraft(null, agentId, chatId))}
          />
        ) : (
          <RoutineDetail
            routine={selected}
            history={histories[selected.id]?.runs}
            notice={notice}
            deleting={deleting}
            deletePending={deletion.pending}
            onRequestHistory={onRequestHistory}
            onEdit={() => dialog.openRoutine(selected)}
            onRunNow={() => onRunNow(selected.id)}
            onSetEnabled={(enabled) => onSetEnabled(selected.id, enabled)}
            onAskDelete={() => setDeleting(true)}
            onCancelDelete={() => setDeleting(false)}
            onConfirmDelete={() => {
              setDeleting(false)
              deletion.start((requestId) => onDelete(selected.id, requestId), { onAck: () => onSelect(null) })
            }}
          />
        )}
      </div>

      {dialog.editing === null ? null : (
        <RoutineDialog
          key={dialog.editing.id ?? 'new'}
          initial={dialog.editing}
          projects={projects}
          chats={chats}
          agents={agents}
          fixedTarget={{ kind: 'dm', chatId, agentId }}
          notice={notice}
          pending={dialog.pending}
          onSave={dialog.save}
          onDismissNotice={onDismissNotice}
          onClose={dialog.close}
        />
      )}
    </>
  )
}

interface RoutineListProps {
  kind: ScheduleKind
  routines: readonly Routine[]
  loaded: boolean
  onOpen: (routineId: string) => void
  onNew: () => void
}

function RoutineList({ kind, routines, loaded, onOpen, onNew }: RoutineListProps) {
  const [earlierOpen, setEarlierOpen] = useState(false)
  // Ticks once a minute so a failure leaves Upcoming after its day even when nothing else changes.
  const now = useMinuteClock()
  if (!loaded) return <p className="m-0 px-4 py-4 text-[13px] text-dim">Loading…</p>

  // The same split as the Scheduled tasks page, so a task sits in one place on both.
  const sections = scheduledSections(routines, now)
  const list = (items: readonly Routine[]) => (
    <ol className="m-0 flex list-none flex-col gap-1 p-0">
      {items.map((routine) => (
        <li key={routine.id}>
          <RoutineListRow routine={routine} now={now} onOpen={() => onOpen(routine.id)} />
        </li>
      ))}
    </ol>
  )
  const empty = (title: string, body: string) => (
    <div className="m-2.5 rounded-xl border border-dashed border-line px-4 py-8 text-center">
      <p className="m-0 text-[14px] font-medium text-text">{title}</p>
      <p className="mt-1 mb-4 text-[13px] text-muted">{body}</p>
      <Button variant="primary" size="small" onClick={onNew}>
        New task
      </Button>
    </div>
  )

  if (kind === 'recurring') {
    return sections.recurring.length === 0
      ? empty('Nothing recurring here', 'Give this persona a prompt to answer on a schedule.')
      : <div className="p-2.5">{list(sections.recurring)}</div>
  }
  if (sections.upcoming.length === 0 && sections.earlier.length === 0) {
    return empty('Nothing coming up', 'Ask this persona to remind you or check something later.')
  }
  return (
    <div className="flex flex-col gap-3 p-2.5">
      {sections.upcoming.length === 0
        ? <p className="m-0 px-1.5 pt-1 text-[13px] text-dim">Nothing coming up</p>
        : list(sections.upcoming)}
      {sections.earlier.length === 0 ? null : (
        <section>
          <button
            type="button"
            className="flex h-7 cursor-pointer items-center gap-1.5 rounded-lg border-0 bg-transparent px-1.5 text-left text-dim [font:inherit] hover:bg-surface-2 hover:text-text"
            aria-expanded={earlierOpen}
            onClick={() => setEarlierOpen((open) => !open)}
          >
            <FoldChevron open={earlierOpen} />
            {/* Sized on the spans: `[font:inherit]` on the button outranks a text utility. */}
            <span className="text-[12px] font-medium">Earlier</span>
            <span className="text-[12px] tabular-nums">{sections.earlier.length}</span>
          </button>
          <Fold open={earlierOpen}>
            <div className="mt-1">{list(sections.earlier)}</div>
          </Fold>
        </section>
      )}
    </div>
  )
}

function RoutineListRow({ routine, now, onOpen }: { routine: Routine; now: number; onOpen: () => void }) {
  const running = isRunning(routine, now)
  return (
    <button
      type="button"
      className={`flex w-full cursor-pointer flex-col items-start gap-0.5 rounded-xl border-0 bg-surface-2/45 px-3 py-2.5 text-left hover:bg-surface-2 ${
        routine.enabled ? '' : 'opacity-60'
      }`}
      onClick={onOpen}
    >
      <span className="flex w-full min-w-0 items-center gap-2">
        <span
          className={`h-2 w-2 flex-none rounded-full ${
            running ? 'bg-primary' : routine.enabled ? 'border border-dim/70' : 'border border-dim/40'
          }`}
        />
        <span className="min-w-0 flex-1 truncate text-label font-medium text-text">{routine.name}</span>
      </span>
      {/* The schedule, never the status: a row that said "Ran 09:14" would
          repeat what the transcript beside it is already showing. */}
      <span className="w-full truncate pl-4 text-[13px] text-dim">
        {routine.enabled ? describeSchedule(routine) : `${routineOffLabel(routine)}, ${describeSchedule(routine)}`}
      </span>
    </button>
  )
}

interface RoutineDetailProps {
  routine: Routine
  history: readonly RoutineRun[] | undefined
  notice: Notice | null
  deleting: boolean
  deletePending: boolean
  onRequestHistory: (routineId: string) => void
  onEdit: () => void
  onRunNow: () => void
  onSetEnabled: (enabled: boolean) => void
  onAskDelete: () => void
  onCancelDelete: () => void
  onConfirmDelete: () => void
}

/**
 * One routine at panel width: what it is, whether it is on, and what it has done.
 *
 * Deliberately not the workspace detail view, which is a two-column page at 1180px;
 * squeezing that into 400 would be a rebuild of it rather than a reuse. Editing is
 * the shared dialog, so the fields themselves still live in exactly one place.
 */
function RoutineDetail({
  routine,
  history,
  notice,
  deleting,
  deletePending,
  onRequestHistory,
  onEdit,
  onRunNow,
  onSetEnabled,
  onAskDelete,
  onCancelDelete,
  onConfirmDelete,
}: RoutineDetailProps) {
  const running = isRunning(routine)
  const status = routineStatus(routine)

  // The history is a snapshot of the transcript, so a fire that starts or ends while
  // the panel is open makes the list on screen stale. Both edges are visible on the
  // routine itself, which is what this watches rather than polling.
  useEffect(() => {
    onRequestHistory(routine.id)
  }, [routine.id, routine.runningSince, routine.lastRunAt, onRequestHistory])

  return (
    <div className="flex flex-col gap-4 px-4 py-3.5">
      <div className="min-w-0">
        <h3 className="m-0 text-[16px] font-semibold text-text">{routine.name}</h3>
        {routine.description === '' ? null : (
          <p className="mt-0.5 mb-0 text-[13px] text-muted">{routine.description}</p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {routine.endState !== null ? null : (
          <Button
            variant={routine.enabled ? 'secondary' : 'primary'}
            size="compact"
            onClick={() => onSetEnabled(!routine.enabled)}
          >
            {routine.enabled ? 'Turn off' : 'Turn on'}
          </Button>
        )}
        <Button variant="ghost" size="compact" className="inline-flex items-center gap-1.5" onClick={onEdit}>
          <Icon icon={Edit02Icon} size={13} />
          Edit
        </Button>
        <Button
          variant="ghost"
          size="compact"
          className="inline-flex items-center gap-1.5"
          disabled={!routine.enabled || running}
          title={
            running
              ? 'This is running; its turn is in the conversation beside this panel.'
              : routine.enabled
                ? undefined
                : routine.endState !== null
                  ? 'It already ran once. Edit it and give it a new time to schedule it again.'
                  : 'Turn it on before running it.'
          }
          onClick={onRunNow}
        >
          <Icon icon={PlayIcon} size={13} />
          Run now
        </Button>
      </div>

      <Field label={routine.runAt === null ? 'Repeats' : 'Scheduled'}>
        <p className="m-0 text-[14px] text-text">{describeSchedule(routine)}</p>
        <p className={`mt-0.5 mb-0 text-[13px] ${status.tone === 'error' ? 'text-danger' : 'text-dim'}`}>
          {routine.enabled ? `Next ${routineNextRun(routine)}` : status.text}
        </p>
      </Field>

      <Field label="Instruction">
        <p className="m-0 max-h-[180px] overflow-y-auto rounded-xl border border-line bg-surface-2/50 px-3 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap text-text">
          {routine.prompt}
        </p>
      </Field>

      <Field label="Run history">
        <RunHistory history={history} />
      </Field>

      {deleting ? (
        <ConfirmStrip
          question={`Delete “${routine.name}”? This conversation stays.`}
          onConfirm={onConfirmDelete}
          onCancel={onCancelDelete}
        />
      ) : (
        <Button
          variant="danger"
          size="compact"
          className="inline-flex items-center gap-1.5 self-start"
          disabled={deletePending}
          onClick={onAskDelete}
        >
          <Icon icon={Delete02Icon} size={13} />
          {deletePending ? 'Deleting…' : 'Delete'}
        </Button>
      )}
      {notice === null ? null : <RequestNotice notice={notice} />}
    </div>
  )
}

/**
 * The last runs, read-only on purpose: each one is a turn in the conversation this
 * panel is standing next to, so there is nowhere for a row to lead. Undefined is the
 * server not having answered yet, which is not the same as a routine that never ran.
 */
export function RunHistory({ history }: { history: readonly RoutineRun[] | undefined }) {
  if (history === undefined) return <p className="m-0 text-[13px] text-dim">Loading runs…</p>
  if (history.length === 0) return <p className="m-0 text-[13px] text-dim">No runs yet</p>

  return (
    <ol className="m-0 flex list-none flex-col p-0">
      {history.map((run) => (
        <li key={run.id} className="flex items-center gap-3 border-b border-line/60 py-1.5 last:border-b-0">
          <span className="min-w-0 flex-1 truncate text-[13px] text-text">{runDate(run.startedAt)}</span>
          {run.state === 'running' ? (
            <span className="flex-none text-[12px] text-primary">Running</span>
          ) : (
            // Tighter than the row's own gap, because the words and the mark are one
            // statement about this fire rather than two columns.
            <span className="flex flex-none items-center gap-2">
              {/* A run that found nothing writes nothing in the chat, so this row is
                  the only place it exists. Without the words it is a tick identical
                  to the run that did report something. */}
              {run.state === 'done' && run.outcome === 'quiet' ? (
                <span className="text-[12px] text-dim">0 results</span>
              ) : null}
              {/* The mark carries the outcome, so it names itself rather than relying
                  on a colour nobody can read out loud. */}
              <span
                role="img"
                aria-label={run.state === 'failed' ? 'Failed' : 'Done'}
                title={run.state === 'failed' ? 'Failed' : 'Done'}
                className={`flex-none ${run.state === 'failed' ? 'text-danger' : 'text-dim'}`}
              >
                <Icon icon={run.state === 'failed' ? Alert02Icon : Tick02Icon} size={14} />
              </span>
            </span>
          )}
        </li>
      ))}
    </ol>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section>
      <h4 className="m-0 mb-1.5 text-[13px] font-medium text-dim">{label}</h4>
      {children}
    </section>
  )
}
