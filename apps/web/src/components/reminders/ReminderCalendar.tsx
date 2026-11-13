import { useMemo, type ReactNode } from 'react'
import { ArrowLeft01Icon, ArrowRight01Icon } from '@hugeicons/core-free-icons'
import type { Reminder, ReminderList } from '@manor/contracts'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'
import { listColor } from './RemindersSidebar'
import { calendarWeeks, monthLabel, monthOf, remindersByDay, shiftMonth } from './reminderViews'

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const

interface ReminderCalendarProps {
  reminders: readonly Reminder[]
  lists: readonly ReminderList[]
  today: string
  /** `YYYY-MM` on show. Held by the page so switching layouts keeps the month. */
  month: string
  selectedId: string | null
  composer?: ReactNode
  /** Stands in for the grid when nothing in the scope has a date. */
  undatedState: ReactNode
  onMonth: (month: string) => void
  onSelect: (id: string) => void
}

/** The month layout: dated reminders on their day, Monday first as the Dutch calendar runs. */
export function ReminderCalendar({
  reminders,
  lists,
  today,
  month,
  selectedId,
  composer,
  undatedState,
  onMonth,
  onSelect,
}: ReminderCalendarProps) {
  const weeks = useMemo(() => calendarWeeks(month), [month])
  const byDay = useMemo(() => remindersByDay(reminders), [reminders])
  const dated = byDay.size > 0

  return (
    <div className="grid min-h-0 grid-rows-[auto_auto_minmax(0,1fr)] px-4 pt-4 pb-4 lg:px-6">
      <div>{composer}</div>
      <div className="flex h-11 items-center gap-1">
        <h3 className="m-0 min-w-0 flex-1 truncate text-[15px] font-medium text-text" aria-live="polite">{monthLabel(month)}</h3>
        <IconButton icon={ArrowLeft01Icon} label="Previous month" onClick={() => onMonth(shiftMonth(month, -1))} />
        <Button variant="ghost" size="compact" disabled={month === monthOf(today)} onClick={() => onMonth(monthOf(today))}>
          Today
        </Button>
        <IconButton icon={ArrowRight01Icon} label="Next month" onClick={() => onMonth(shiftMonth(month, 1))} />
      </div>
      {!dated ? (
        <div className="grid min-h-0 place-items-center">{undatedState}</div>
      ) : (
        <div className="grid min-h-0 grid-rows-[auto_repeat(6,minmax(0,1fr))] overflow-hidden rounded-2xl border border-line" role="grid" aria-label={monthLabel(month)}>
          <div role="row" className="grid grid-cols-7 border-b border-line">
            {WEEKDAYS.map((weekday) => (
              <span key={weekday} role="columnheader" className="px-2.5 py-1.5 text-meta text-dim">{weekday}</span>
            ))}
          </div>
          {weeks.map((week) => (
            <div key={week[0]} role="row" className="grid min-h-0 grid-cols-7 border-b border-line last:border-b-0">
              {week.map((day) => {
                const inMonth = monthOf(day) === month
                const isToday = day === today
                const items = byDay.get(day) ?? []
                return (
                  <div
                    key={day}
                    role="gridcell"
                    aria-label={`${day}${items.length === 0 ? '' : `, ${items.length} reminder${items.length === 1 ? '' : 's'}`}`}
                    className={`flex min-h-[72px] min-w-0 flex-col gap-0.5 border-r border-line p-1 last:border-r-0 ${inMonth ? '' : 'bg-surface'}`}
                  >
                    <span
                      className={`mb-0.5 grid h-6 min-w-6 place-items-center self-start rounded-full px-1 text-[12px] tabular-nums ${
                        isToday ? 'bg-primary font-medium text-on-primary' : inMonth ? 'text-muted' : 'text-dim'
                      }`}
                    >
                      {Number(day.slice(8))}
                    </span>
                    <div className="flex min-h-0 flex-col gap-0.5 overflow-y-auto [scrollbar-width:none]">
                      {items.map((reminder) => {
                        const list = lists.find((candidate) => candidate.id === reminder.listId)
                        const selected = reminder.id === selectedId
                        return (
                          <button
                            key={reminder.id}
                            type="button"
                            data-reminder-row={reminder.id}
                            aria-current={selected ? 'true' : undefined}
                            title={reminder.title}
                            className={`flex h-6 w-full flex-none cursor-pointer items-center gap-1.5 rounded-md border-0 px-1.5 text-left text-[12px] ${
                              selected ? 'bg-user-bg' : 'bg-transparent hover:bg-surface-2'
                            } ${day < today ? 'text-danger' : 'text-text'}`}
                            onClick={() => onSelect(reminder.id)}
                          >
                            <span aria-hidden="true" className="h-1.5 w-1.5 flex-none rounded-full" style={{ background: listColor(list) }} />
                            {reminder.due?.time === undefined ? null : <span className="flex-none tabular-nums text-dim">{reminder.due.time}</span>}
                            <span className="min-w-0 flex-1 truncate">{reminder.title}</span>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
