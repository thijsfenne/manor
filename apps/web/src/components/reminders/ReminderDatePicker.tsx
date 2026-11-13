import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft01Icon, ArrowRight01Icon, Calendar03Icon } from '@hugeicons/core-free-icons'
import { Icon } from '../Icon'
import { IconButton } from '../ui/IconButton'
import { Popover } from '../ui/Popover'
import { useDismiss } from '../ui/useDismiss'
import { usePopupPlacement } from '../ui/usePopupPlacement'
import { calendarWeeks, dayInMonth, dayLabel, monthLabel, monthOf, shiftMonth, stepDay } from './reminderViews'

const WEEKDAYS = [
  ['Mo', 'Monday'],
  ['Tu', 'Tuesday'],
  ['We', 'Wednesday'],
  ['Th', 'Thursday'],
  ['Fr', 'Friday'],
  ['Sa', 'Saturday'],
  ['Su', 'Sunday'],
] as const

/** Seven 34px columns inside the card's padding; the height is the header, weekdays and six weeks. */
const WIDTH = 256
const HEIGHT = 268

const spoken = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
const spokenDay = (day: string) => spoken.format(new Date(`${day}T00:00:00Z`))

interface ReminderDatePickerProps {
  /** `YYYY-MM-DD`, or undefined for a reminder without a date. */
  value: string | undefined
  today: string
  disabled: boolean
  className?: string
  onPick: (day: string) => void
}

/**
 * The details panel's date field. Chromium draws a native date input's popup itself,
 * in its own grey and blue, so the month grid is drawn here the way the Reminders
 * calendar draws it: Monday first, today marked, the chosen day in the primary fill.
 *
 * Focus stays on the trigger and the grid follows `aria-activedescendant`, as in
 * `Select`: the popup portals out of the panel's overflow, and keeping focus home is
 * what lets Escape close only the popup (the panel closes on an Escape nobody took).
 */
export function ReminderDatePicker({ value, today, disabled, className = '', onPick }: ReminderDatePickerProps) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  const gridId = useId()
  const [open, setOpen] = useState(false)
  // The day the keyboard or pointer is on, which is not yet the picked one.
  const [active, setActive] = useState(value ?? today)
  const [month, setMonth] = useState(monthOf(value ?? today))
  const weeks = useMemo(() => calendarWeeks(month), [month])
  const placement = usePopupPlacement({ open, triggerRef, maxHeight: HEIGHT, minHeight: HEIGHT, minWidth: WIDTH })
  const visible = open && placement !== null
  const cellId = (day: string) => `${gridId}-${day}`

  useDismiss(open, () => setOpen(false), { within: [triggerRef, popupRef], layoutMoved: true })
  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  const show = () => {
    if (disabled) return
    const start = value ?? today
    setActive(start)
    setMonth(monthOf(start))
    setOpen(true)
  }

  const hide = () => {
    setOpen(false)
    triggerRef.current?.focus()
  }

  const pick = (day: string) => {
    hide()
    if (day !== value) onPick(day)
  }

  const moveTo = (day: string) => {
    setActive(day)
    setMonth(monthOf(day))
  }

  const turnMonth = (delta: number) => {
    const next = shiftMonth(month, delta)
    setMonth(next)
    setActive(dayInMonth(next, Number(active.slice(8))))
  }

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!open) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        show()
      }
      return
    }
    switch (event.key) {
      // Tab leaves without preventDefault: the grid closes and focus moves on.
      case 'Tab':
        setOpen(false)
        return
      // Taken here, so the panel's own Escape handler sees it handled and stays open.
      case 'Escape':
        event.preventDefault()
        hide()
        return
      case 'Enter':
      case ' ':
        event.preventDefault()
        pick(active)
        return
      default: {
        const next = stepDay(active, event.key)
        if (next === null) return
        event.preventDefault()
        moveTo(next)
      }
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-label="Date"
        aria-haspopup="grid"
        aria-expanded={open}
        aria-controls={visible ? gridId : undefined}
        aria-activedescendant={visible ? cellId(active) : undefined}
        disabled={disabled}
        className={`flex w-full cursor-pointer items-center gap-2 rounded-lg border bg-surface-2 py-[7px] pr-3 pl-2.5 text-left text-[13px] outline-none focus-visible:border-dim disabled:cursor-default disabled:opacity-45 ${
          open ? 'border-dim' : 'border-line hover:border-dim'
        } ${value === undefined ? 'text-dim' : 'text-text'} ${className}`}
        onClick={() => (open ? hide() : show())}
        onKeyDown={onKeyDown}
      >
        <span className="min-w-0 flex-1 truncate">{value === undefined ? 'Add date' : dayLabel(value, today)}</span>
        <Icon icon={Calendar03Icon} size={14} className="flex-none text-muted" />
      </button>

      {typeof document === 'undefined'
        ? null
        : createPortal(
            <Popover
              open={open}
              ref={popupRef}
              origin={placement?.top === undefined ? 'bottom-left' : 'top-left'}
              className="fixed z-40 rounded-panel border border-line surface-floating p-2 shadow-menu"
              style={placement === null ? { visibility: 'hidden' } : { left: placement.left, top: placement.top, bottom: placement.bottom, width: placement.width }}
            >
              {/* Presses land here without taking focus, so the trigger keeps the keyboard. */}
              <div onMouseDown={(event) => event.preventDefault()}>
                <div className="mb-1 flex h-8 items-center gap-0.5 pl-2">
                  <span className="min-w-0 flex-1 truncate text-label font-medium text-text" aria-live="polite">{monthLabel(month)}</span>
                  <IconButton icon={ArrowLeft01Icon} label="Previous month" title="Previous month (Page Up)" size={28} tabIndex={-1} onClick={() => turnMonth(-1)} />
                  <IconButton icon={ArrowRight01Icon} label="Next month" title="Next month (Page Down)" size={28} tabIndex={-1} onClick={() => turnMonth(1)} />
                </div>
                <div id={gridId} role="grid" aria-label={monthLabel(month)}>
                  <div role="row" className="grid grid-cols-7">
                    {WEEKDAYS.map(([short, long]) => (
                      <span key={long} role="columnheader" aria-label={long} className="grid h-7 place-items-center text-meta text-dim">
                        {short}
                      </span>
                    ))}
                  </div>
                  {weeks.map((week) => (
                    <div key={week[0]} role="row" className="grid grid-cols-7">
                      {week.map((day) => {
                        const picked = day === value
                        const isToday = day === today
                        const tone = picked
                          ? 'bg-primary font-medium text-on-primary'
                          : `${day === active ? 'bg-user-bg' : 'bg-transparent'} ${
                              isToday ? 'font-medium text-text ring-1 ring-dim ring-inset' : monthOf(day) === month ? 'text-text' : 'text-dim'
                            }`
                        return (
                          <button
                            key={day}
                            id={cellId(day)}
                            type="button"
                            role="gridcell"
                            tabIndex={-1}
                            aria-selected={picked}
                            aria-current={isToday ? 'date' : undefined}
                            aria-label={spokenDay(day)}
                            className={`grid h-8 w-8 cursor-pointer place-items-center justify-self-center rounded-full border-0 p-0 text-[13px] tabular-nums ${tone}`}
                            onMouseEnter={() => setActive(day)}
                            onClick={() => pick(day)}
                          >
                            {Number(day.slice(8))}
                          </button>
                        )
                      })}
                    </div>
                  ))}
                </div>
              </div>
            </Popover>,
            document.body,
          )}
    </>
  )
}
