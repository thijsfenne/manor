import type { ScheduleKind } from '../../routines'
import { SegmentedControl, type SegmentOption } from '../ui/SegmentedControl'

/** Recurring leads: it is the standing work, one-time tasks come and go. */
const KINDS: readonly SegmentOption<ScheduleKind>[] = [
  { value: 'recurring', label: 'Recurring', tabId: 'scheduled-page-tab-recurring', panelId: 'scheduled-page-recurring' },
  { value: 'once', label: 'Once', tabId: 'scheduled-page-tab-once', panelId: 'scheduled-page-once' },
]

/** The Scheduled tasks header switch, beside the title as Plugins has its own. */
export function ScheduledTabs({ kind, onChange }: { kind: ScheduleKind; onChange: (next: ScheduleKind) => void }) {
  // 2px down, so the segment labels sit on the title's optical line, as in PluginsTabs.
  return (
    <span className="mt-0.5 inline-flex">
      <SegmentedControl label="Scheduled task kind" options={KINDS} value={kind} onChange={onChange} />
    </span>
  )
}
