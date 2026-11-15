import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { PlusSignIcon } from '@hugeicons/core-free-icons'
import type { AgentConfig, Chat, Project, Routine, RoutineDraft, RoutineRun } from '@manor/contracts'
import { HOME_PROJECT_ID, SINGLE_CHAT_VOICE, driverForModel } from '@manor/contracts'
import { defaultSingleRuntime } from '../../runtimeChoices'
import { accentStyle } from '../../accent'
import { safeHex } from '../../persona'
import { EASE_TRAVEL, INSTANT, SEGMENTED_SLIDE } from '../../motion'
import {
  describeSchedule,
  emptyRoutineDraft,
  isRunning,
  onceLine,
  reachableAgents,
  routineDmChatId,
  routineTimeline,
  routinesNeedAttention,
  routineWaiting,
  scheduledSections,
  type ScheduleKind,
} from '../../routines'
import type { Notice } from '../../state'
import type { RequestEvents } from '../../useRequest'
import { Avatar } from '../Avatar'
import { ProviderMark } from '../ProviderMark'
import { Icon } from '../Icon'
import { Button } from '../ui/Button'
import { Fold, FoldChevron } from '../ui/Fold'
import { RoutineDetail } from './RoutineDetailView'
import { RoutineDialog } from './RoutineDialog'
import { RoutineDot } from './RoutineDot'
import { useRoutineDialog } from './useRoutineDialog'
import { useMinuteClock } from '../../useMinuteClock'

/** Whether Earlier is unfolded, and the finished task it last unfolded for. */
export interface EarlierFold {
  open: boolean
  openedFor: string | undefined
}

/**
 * Earlier unfolds each time a finished task becomes selected, so a task opened from
 * elsewhere is visible, and stays folded when the user folds it with that task still
 * selected. Leaving Earlier forgets the task, so coming back to it unfolds again.
 * Returns the same object when nothing changes, so it is safe to call while rendering.
 */
export const foldEarlierFor = (fold: EarlierFold, selectedEarlierId: string | undefined): EarlierFold => {
  if (selectedEarlierId === fold.openedFor) return fold
  if (selectedEarlierId === undefined) return { ...fold, openedFor: undefined }
  return { open: true, openedFor: selectedEarlierId }
}

interface RoutinesViewProps {
  routines: Routine[]
  /** The segment on show; the switch itself lives in the workspace header. */
  kind: ScheduleKind
  /** False until the server has answered; an absent list is not an empty one. */
  loaded: boolean
  /** Run threads by routine, newest first, for project tasks. */
  runs: Record<string, Chat[]>
  /** Fires inside a continuing DM, keyed by routine; absent until asked for. */
  histories: Record<string, { chatId: string | null; runs: readonly RoutineRun[] }>
  projects: Project[]
  chats: Chat[]
  agents: AgentConfig[]
  notice: Notice | null
  requestEvents: RequestEvents
  /** The task the reader picked, kept in navigation history; null lets the page choose. */
  selectedId: string | null
  onSelect: (routineId: string | null) => void
  onOpenChat: (chatId: string) => void
  onRequestHistory: (routineId: string) => void
  onMarkRunsRead: (routineId: string, runIds: readonly string[]) => void
  onMarkAllRunsRead: () => void
  onSave: (draft: RoutineDraft, requestId: string) => boolean
  onDelete: (routineId: string, requestId: string) => boolean
  onSetEnabled: (routineId: string, enabled: boolean) => boolean
  onRunNow: (routineId: string) => boolean
  onDismissNotice: () => void
  onDialogChange: (open: boolean) => void
}

/**
 * What happens later without the user, house-wide: one-time reminders and checks from a
 * DM, and recurring routines, one kind at a time behind a segmented control. The list
 * sits left and the picked task opens beside it, the Suggestions shape, so the page is
 * its own navigation and the destination needs no sidebar.
 */
export function RoutinesView({
  routines,
  kind,
  loaded,
  runs,
  histories,
  projects,
  chats,
  agents,
  notice,
  requestEvents,
  selectedId,
  onSelect,
  onOpenChat,
  onRequestHistory,
  onMarkRunsRead,
  onMarkAllRunsRead,
  onSave,
  onDelete,
  onSetEnabled,
  onRunNow,
  onDismissNotice,
  onDialogChange,
}: RoutinesViewProps) {
  const dialog = useRoutineDialog({ requestEvents, onSave, onDismissNotice, onDialogChange })
  const reduceMotion = useReducedMotion() ?? false
  const [earlierFold, setEarlierFold] = useState<EarlierFold>({ open: false, openedFor: undefined })
  const rows = useRef(new Map<string, HTMLButtonElement>())
  // Ticks once a minute so a failure leaves Upcoming after its day, and Tomorrow
  // becomes Today at midnight, without waiting for some other update.
  const now = useMinuteClock()
  const sections = scheduledSections(routines, now)

  const picked = selectedId === null ? undefined : routines.find((routine) => routine.id === selectedId)
  const order = kind === 'once' ? [...sections.upcoming, ...sections.earlier] : sections.recurring
  // Resolved while rendering, as Suggestions does: nothing selected never shows, the
  // first row of the segment stands in until the reader picks another.
  const selected = (picked !== undefined && order.includes(picked) ? picked : order[0]) ?? undefined
  const selectedEarlierId = selected !== undefined && sections.earlier.includes(selected) ? selected.id : undefined
  const nextFold = foldEarlierFor(earlierFold, selectedEarlierId)
  if (nextFold !== earlierFold) setEarlierFold(nextFold)
  const earlierShown = nextFold.open
  const visible = kind === 'once' && !earlierShown ? sections.upcoming : order

  // The record arrives from the side the selection came from.
  const previousIndex = useRef(0)
  const index = selected === undefined ? 0 : visible.indexOf(selected)
  const travellingDown = index >= previousIndex.current
  useEffect(() => {
    previousIndex.current = index
  }, [index])

  const pick = (routine: Routine | undefined) => {
    if (routine === undefined) return
    onSelect(routine.id)
    rows.current.get(routine.id)?.focus()
  }
  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = selected === undefined ? -1 : visible.indexOf(selected)
    if (event.key === 'ArrowDown') pick(visible[Math.min(visible.length - 1, at + 1)])
    else if (event.key === 'ArrowUp') pick(visible[Math.max(0, at - 1)])
    else if (event.key === 'Home') pick(visible[0])
    else if (event.key === 'End') pick(visible[visible.length - 1])
    else return
    event.preventDefault()
  }

  // Prefer the existing project-run shape when it is available. A direct message
  // remains a complete destination even when no project exists.
  const first = projects[0]
  const projectAgent = reachableAgents(agents, undefined)[0]
  const firstAgent = agents[0]

  const openNew = () => {
    if (projectAgent === undefined && (first !== undefined || firstAgent === undefined)) {
      const runtime = defaultSingleRuntime(agents)
      dialog.openDraft({ ...emptyRoutineDraft(first?.id ?? HOME_PROJECT_ID, SINGLE_CHAT_VOICE.id), model: runtime.model, effort: runtime.effort })
      return
    }
    if (first !== undefined && projectAgent !== undefined) {
      dialog.openDraft(emptyRoutineDraft(first.id, projectAgent.id))
      return
    }
    if (firstAgent === undefined) return
    dialog.openDraft(emptyRoutineDraft(null, firstAgent.id, routineDmChatId(chats, firstAgent.id)))
  }

  const row = (routine: Routine) => (
    <RoutineRow
      key={routine.id}
      rowRef={(node) => {
        if (node === null) rows.current.delete(routine.id)
        else rows.current.set(routine.id, node)
      }}
      routine={routine}
      agent={agents.find((agent) => agent.id === routine.agentId)}
      waiting={routineWaiting(routine)}
      selected={routine === selected}
      now={now}
      reduceMotion={reduceMotion}
      onOpen={() => onSelect(routine.id)}
    />
  )

  return (
    <main className="flex h-full min-h-0 flex-col">
      <div className="mx-auto flex w-full max-w-page flex-none items-end justify-between gap-6 px-8 pt-10 max-[720px]:px-5 max-[720px]:pt-7 max-[640px]:flex-col max-[640px]:items-stretch max-[640px]:gap-4">
        <div>
          <h1 className="m-0 font-display text-[24px] leading-tight font-semibold tracking-[-0.02em]">Scheduled tasks</h1>
          <p className="mt-1 mb-0 max-w-[590px] text-[16px] leading-relaxed text-muted">
            Run tasks on a schedule or whenever you need them.
          </p>
        </div>
        {!loaded ? null : (
          <div className="flex flex-none items-center gap-2 max-[640px]:self-start">
            {/* Page-wide, so it sits with the page's own act rather than in one task's History. */}
            {!routinesNeedAttention(routines) ? null : (
              <Button variant="ghost" onClick={onMarkAllRunsRead}>
                Mark all as read
              </Button>
            )}
            <Button variant="primary" className="inline-flex items-center gap-2" onClick={openNew}>
              <Icon icon={PlusSignIcon} size={14} />
              New task
            </Button>
          </div>
        )}
      </div>

      {!loaded ? (
        <p className="mx-auto mt-8 mb-0 w-full max-w-page px-8 text-[13px] text-dim">Loading scheduled work…</p>
      ) : selected === undefined ? (
        <div id={`scheduled-page-${kind}`} role="tabpanel" aria-labelledby={`scheduled-page-tab-${kind}`} className="mx-auto w-full max-w-page px-8 pt-6 max-[720px]:px-5">
          <div className="rounded-xl border border-dashed border-line px-6 py-12 text-center">
            <h2 className="m-0 text-[16px] font-semibold">{kind === 'once' ? 'Nothing coming up' : 'Nothing recurring yet'}</h2>
            <p className="mt-1.5 mb-5 text-[13px] text-muted">
              {kind === 'once'
                ? 'Ask an agent in a direct message to remind you or check something later.'
                : 'Set up a prompt an agent answers on a repeating schedule.'}
            </p>
            <Button variant="primary" onClick={openNew}>
              New task
            </Button>
          </div>
        </div>
      ) : (
        <div
          id={`scheduled-page-${kind}`}
          role="tabpanel"
          aria-labelledby={`scheduled-page-tab-${kind}`}
          className="mx-auto grid w-full min-h-0 max-w-page flex-1 grid-cols-[minmax(0,264px)_minmax(0,1fr)] gap-5 px-8 pt-6 pb-8 max-[720px]:px-5 max-[720px]:pb-6 max-[640px]:grid-cols-1 max-[640px]:grid-rows-[minmax(0,34vh)_minmax(0,1fr)] max-[640px]:gap-4"
        >
          <div
            role="listbox"
            aria-label={kind === 'once' ? 'One-time tasks' : 'Recurring tasks'}
            tabIndex={-1}
            className="-ml-2.5 min-h-0 overflow-y-auto outline-none max-[640px]:ml-0"
            onKeyDown={onListKeyDown}
          >
            {kind === 'recurring' ? (
              sections.recurring.map(row)
            ) : (
              <>
                {sections.upcoming.length === 0
                  ? <p className="m-0 px-2.5 py-1.5 text-label text-dim">Nothing coming up</p>
                  : sections.upcoming.map(row)}
                {sections.earlier.length === 0 ? null : (
                  <div role="group" aria-label="Earlier" className="mt-3">
                    <button
                      type="button"
                      className="flex h-7 cursor-pointer items-center gap-1.5 rounded-lg border-0 bg-transparent px-2.5 text-left text-dim [font:inherit] hover:bg-surface-2 hover:text-text"
                      aria-expanded={earlierShown}
                      onClick={() => setEarlierFold({ ...nextFold, open: !earlierShown })}
                    >
                      <FoldChevron open={earlierShown} />
                      {/* Sized on the spans: `[font:inherit]` on the button outranks a text utility. */}
                      <span className="text-[13px] font-medium">Earlier</span>
                      <span className="text-[13px] tabular-nums">{sections.earlier.length}</span>
                    </button>
                    <Fold open={earlierShown}>
                      <div className="mt-1">{sections.earlier.map(row)}</div>
                    </Fold>
                  </div>
                )}
              </>
            )}
          </div>

          {/* `h-fit` opts the pane out of the grid's stretch, so the surface ends where
              the task ends; `max-h-full` puts the scroll back inside it for a long one. */}
          <div className="h-fit max-h-full min-h-0 overflow-y-auto rounded-xl bg-surface px-6 py-5 max-[720px]:px-5">
            <motion.article
              key={selected.id}
              initial={reduceMotion ? false : { opacity: 0, y: travellingDown ? 8 : -8, filter: 'blur(3px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              transition={reduceMotion ? INSTANT : { duration: 0.18, ease: EASE_TRAVEL, opacity: { duration: 0.12 } }}
            >
              <RoutineDetail
                routine={selected}
                runs={runs[selected.id] ?? []}
                history={histories[selected.id]}
                projects={projects}
                agents={agents}
                notice={notice}
                requestEvents={requestEvents}
                onEdit={() => dialog.openRoutine(selected)}
                onOpenChat={onOpenChat}
                onRequestHistory={onRequestHistory}
                onMarkRead={onMarkRunsRead}
                onDelete={onDelete}
                onDeleted={() => onSelect(null)}
                onSetEnabled={onSetEnabled}
                onRunNow={onRunNow}
              />
            </motion.article>
          </div>
        </div>
      )}

      {dialog.editing === null ? null : (
        <RoutineDialog
          key={dialog.editing.id ?? 'new'}
          initial={dialog.editing}
          projects={projects}
          chats={chats}
          agents={agents}
          notice={notice}
          pending={dialog.pending}
          onSave={dialog.save}
          onDismissNotice={onDismissNotice}
          onClose={dialog.close}
        />
      )}
    </main>
  )
}

interface RoutineRowProps {
  rowRef: (node: HTMLButtonElement | null) => void
  routine: Routine
  /** Absent only in the beat between a persona's delete and the routines that follow it. */
  agent: AgentConfig | undefined
  /** A run with a result or a failure that has not been on screen yet. */
  waiting: boolean
  selected: boolean
  now: number
  reduceMotion: boolean
  onOpen: () => void
}

/**
 * One task at list depth: who answers, what it is, and one line for when and how it
 * went. Every act lives in the detail beside the list, so the row only navigates.
 */
function RoutineRow({ rowRef, routine, agent, waiting, selected, now, reduceMotion, onOpen }: RoutineRowProps) {
  const single = routine.agentId === SINGLE_CHAT_VOICE.id
  const driver = driverForModel(routine.model ?? '')
  const once = routine.runAt !== null
  const status = once ? onceLine(routine, now) : routineTimeline(routine, now)
  // Red only while the failed run is unread; once shown, the status line keeps saying Failed.
  const failed = waiting && routine.endState === 'failed' ? 'Failed' : null
  // The roster is what colours the row. Before it lands, and in the beat after a
  // persona is deleted, the id is still a true label and safeHex gives it a face.
  const color = safeHex(agent?.color ?? '')

  return (
    <button
      ref={rowRef}
      type="button"
      role="option"
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      style={accentStyle(color)}
      className={`relative flex w-full cursor-pointer items-center gap-2.5 rounded-lg border-0 bg-transparent px-2.5 py-2 text-left outline-none [font:inherit] duration-150 ease-fade focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary motion-safe:transition-colors ${
        selected ? '' : 'hover:bg-surface-2'
      } ${routine.enabled || routine.endState !== null ? '' : 'opacity-60'}`}
      onClick={onOpen}
    >
      {selected ? (
        <motion.span
          layoutId="scheduled-row"
          className="absolute inset-0 rounded-lg bg-user-bg"
          transition={reduceMotion ? INSTANT : SEGMENTED_SLIDE}
        />
      ) : null}
      <span className="relative flex flex-none" title={single ? undefined : agent?.name ?? routine.agentId}>
        {single ? (
          driver === undefined ? null : <ProviderMark driver={driver} size={20} />
        ) : (
          <Avatar
            name={agent?.name ?? routine.agentId}
            color={color}
            {...(agent?.avatar === undefined ? {} : { src: agent.avatar })}
            {...(agent?.avatarShape === undefined ? {} : { shape: agent.avatarShape })}
            tone={agent?.avatarTone}
            size={24}
          />
        )}
      </span>
      <span className="relative min-w-0 flex-1">
        <span className="block truncate text-label font-medium text-text">{routine.name}</span>
        <span
          className={`block truncate text-[12px] ${
            status.tone === 'error' ? 'text-danger' : status.tone === 'active' ? 'text-text' : 'text-dim'
          }`}
        >
          {once ? status.text : `${describeSchedule(routine)}, ${status.text}`}
        </span>
      </span>
      <span className="relative flex flex-none">
        <RoutineDot running={isRunning(routine, now)} waiting={waiting} failed={failed} />
      </span>
    </button>
  )
}
