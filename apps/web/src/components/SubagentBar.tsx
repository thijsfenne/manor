import { ArrowUpLeft01Icon } from '@hugeicons/core-free-icons'
import type { DriverName } from '@manor/contracts'
import { Icon } from './Icon'
import { ProviderMark } from './ProviderMark'
import { Button } from './ui/Button'

/**
 * What stands where the composer would in a subagent's view, because a subagent takes
 * no messages from the user: what it runs on, where it stands, and the way back to the
 * parent, which is also where its questions wait and where it is stopped.
 */
export function SubagentBar({ driver, runtime, status, onOpenParent, padding }: {
  driver: DriverName | undefined
  /** Model and effort, split so the model can lead. Absent for a provider's own helper that named none. */
  runtime: { model: string; effort?: string } | undefined
  status: string
  onOpenParent: () => void
  /** The stage footer's own inset, so the bar sits exactly where the composer did. */
  padding: string
}) {
  const label = runtime === undefined ? 'Subagent' : [runtime.model, runtime.effort].filter(Boolean).join(', ')
  return (
    <footer className={`pointer-events-none relative col-start-1 row-start-2 z-[4] flex min-w-0 flex-col items-center bg-transparent ${padding}`}>
      <div aria-hidden="true" data-composer-fade="" className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-16 bg-gradient-to-t from-bg from-50% to-transparent" />
      <div className="@container/subagent-bar pointer-events-auto w-full min-w-0 max-w-[760px]">
        <div
          data-subagent-bar=""
          className="flex min-h-12 items-center gap-3 rounded-composer border border-composer-line bg-composer py-2 pr-2 pl-4 text-[13px]"
        >
          <div className="flex min-w-0 flex-1 items-center gap-3 @max-[560px]/subagent-bar:flex-col @max-[560px]/subagent-bar:items-start @max-[560px]/subagent-bar:gap-0.5">
            <span className="flex min-w-0 max-w-full items-center gap-2">
              {driver === undefined ? null : <ProviderMark driver={driver} size={16} />}
              <span className="min-w-0 truncate font-medium text-text">{runtime?.model ?? 'Subagent'}</span>
              {runtime?.effort === undefined ? null : <span className="flex-none text-muted">{runtime.effort}</span>}
            </span>
            <span aria-hidden="true" className="flex-none text-muted tabular-nums @max-[560px]/subagent-bar:text-[12px]">{status}</span>
            <span role="status" className="sr-only">{`${label} subagent: ${status.replace(/^Working .*/, 'Working')}`}</span>
          </div>
          <Button variant="ghost" size="compact" className="flex flex-none items-center gap-1.5" onClick={onOpenParent}>
            <Icon icon={ArrowUpLeft01Icon} size={14} className="flex-none" />
            <span className="@max-[320px]/subagent-bar:sr-only">Open parent</span>
          </Button>
        </div>
      </div>
    </footer>
  )
}
