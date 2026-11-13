import { ArrowRight01Icon, Cancel01Icon } from '@hugeicons/core-free-icons'
import type { Chat, Routine } from '@manor/contracts'
import { describeSchedule, isRunning } from '../../routines'
import { Icon } from '../Icon'
import { Button } from '../ui/Button'
import { DOCK_FLOAT, DOCK_PANEL_GAP, DOCK_PANEL_SHELL } from '../ui/dockPanel'
import { LIST_PANEL_WIDTH } from '../../useRightPanel'
import { IconButton } from '../ui/IconButton'
import { runDate } from './RoutineDetailView'

interface RoutineRunsPanelProps {
  routine: Routine
  runs: readonly Chat[]
  selectedRunId: string
  /** Track width, gutter included. */
  width?: number
  overlay?: boolean
  revealed?: boolean
  onOpenRun: (chatId: string) => void
  onOpenRoutine: (routineId: string) => void
  onClose: () => void
}

/** The run index beside a run thread, mirroring the thread-and-runs split in Claude Code. */
export function RoutineRunsPanel({
  routine,
  runs,
  selectedRunId,
  width = LIST_PANEL_WIDTH,
  overlay = false,
  revealed = true,
  onOpenRun,
  onOpenRoutine,
  onClose,
}: RoutineRunsPanelProps) {
  const running = isRunning(routine)

  return (
    <aside
      className={`${overlay ? `dock-panel-reveal ${DOCK_FLOAT} max-w-[calc(100%-8px)]` : ''} m-2 ml-0 grid min-h-0 grid-rows-[auto_auto_minmax(0,1fr)] ${DOCK_PANEL_SHELL}`}
      data-open={overlay ? revealed : undefined}
      style={{ width: width - DOCK_PANEL_GAP }}
    >
      <div className="flex h-11 items-center justify-between border-b border-line px-3.5">
        <h2 className="m-0 text-label font-medium text-muted">Runs</h2>
        <IconButton icon={Cancel01Icon} label="Close runs" onClick={onClose} />
      </div>

      {/* The routine names itself here; opening it is one explicit control beside that
          name rather than a whole block that happens to be clickable. */}
      <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <span className="block truncate text-[16px] font-semibold text-text">{routine.name}</span>
          <span className="mt-0.5 block text-[13px] text-dim">{describeSchedule(routine)}</span>
        </div>
        <Button
          variant="secondary"
          size="compact"
          className="mt-0.5 flex-none"
          onClick={() => onOpenRoutine(routine.id)}
        >
          Open details
        </Button>
      </div>

      <ol className="m-0 flex min-h-0 list-none flex-col gap-1 overflow-y-auto p-2.5">
        {runs.map((run, index) => {
          const selected = run.id === selectedRunId
          return (
            <li key={run.id}>
              <button
                type="button"
                className={`flex min-h-11 w-full cursor-pointer items-center gap-3 rounded-xl border-0 px-3 py-2 text-left ${
                  selected ? 'bg-user-bg' : 'bg-surface-2/45 hover:bg-surface-2'
                }`}
                aria-current={selected ? 'page' : undefined}
                onClick={() => onOpenRun(run.id)}
              >
                <span className={`h-2 w-2 flex-none rounded-full ${routine.unreadRunIds.includes(run.id) ? 'bg-ok' : 'border border-dim/70'}`} />
                <span className="min-w-0 flex-1 truncate text-label font-medium text-text">
                  {runDate(run.createdAt)}
                </span>
                <span className="flex-none text-[13px] text-dim">
                  {running && index === 0 ? 'Running' : 'View result'}
                </span>
                <Icon icon={ArrowRight01Icon} size={15} className="flex-none text-dim" />
              </button>
            </li>
          )
        })}
      </ol>
    </aside>
  )
}
