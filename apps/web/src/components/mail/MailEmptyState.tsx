import { BookOpen01Icon, CheckListIcon, HourglassIcon, MailOpen01Icon, MailReply01Icon, SearchRemoveIcon } from '@hugeicons/core-free-icons'
import type { MailTriageState } from '@manor/contracts'
import { mailTimeLabel, type MailTab } from '../../mail'
import { useMinuteClock } from '../../useMinuteClock'
import { Icon } from '../Icon'
import { Button } from '../ui/Button'

/**
 * Why the stage has no thread: an empty tab, a search without a match, nothing picked
 * yet, or several cards picked at once.
 */
export type MailEmptyKind = MailTab | 'search' | 'pick' | 'selected'

const EMPTY = {
  reply: { icon: MailReply01Icon, line: 'Nothing needs your attention.' },
  wait: { icon: HourglassIcon, line: 'Nothing is waiting on someone.' },
  fyi: { icon: BookOpen01Icon, line: 'Nothing to read.' },
  search: { icon: SearchRemoveIcon, line: 'No mail matches this search.' },
  pick: { icon: MailOpen01Icon, line: 'Select a mail to read.' },
} as const

/**
 * The Mail stage while no thread is open, centred over the whole reader. An empty tab also
 * says when mail was last labelled, or that a run is going, and offers a run for the
 * cards one left behind.
 */
export function MailEmptyState({ kind, selected = 0, triage, unlabelled, onTriage }: {
  kind: MailEmptyKind
  /** How many cards are picked, for `selected`. */
  selected?: number
  triage: MailTriageState
  unlabelled: number
  /** Absent when there is no agent to run the labelling. */
  onTriage?: (() => void) | undefined
}) {
  const now = useMinuteClock()
  const { icon, line } = kind === 'selected' ? { icon: CheckListIcon, line: `${selected} mails selected` } : EMPTY[kind]
  const tab = kind !== 'search' && kind !== 'pick' && kind !== 'selected'
  return (
    <div role="status" className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-8 text-center">
      <Icon icon={icon} size={28} className="mb-3 flex-none text-dim" />
      <p className="m-0 text-[14px] leading-5 text-muted">{line}</p>
      {!tab ? null : (
        <>
          <p className="m-0 mt-1 text-meta text-dim tabular-nums">
            {triage.running ? 'Labelling new mail…'
              : triage.lastRunAt === null ? 'Not labelled yet' : `Last labelled ${mailTimeLabel(triage.lastRunAt, now)}`}
          </p>
          {unlabelled === 0 || onTriage === undefined || triage.running ? null : (
            <Button size="small" className="pointer-events-auto mt-4" onClick={onTriage}>
              {`Label ${unlabelled} new`}
            </Button>
          )}
        </>
      )}
    </div>
  )
}
