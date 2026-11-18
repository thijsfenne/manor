import type { PlanProgress } from '@manor/contracts'
import { PlanRing } from '../PlanRing'

/** A working Session's tasks progress in the overview's age slot: the ring and `done/total`, the same count its card shows. */
export function PlanCount({ plan }: { plan: PlanProgress }) {
  return (
    <span className="flex items-center gap-1.5 text-[12px] text-muted tabular-nums" title={`${plan.done} of ${plan.total} tasks done`}>
      <PlanRing done={plan.done} total={plan.total} size={14} trackClass="stroke-line" fillClass="stroke-busy" className="flex-none" />
      {plan.done}/{plan.total}
    </span>
  )
}
