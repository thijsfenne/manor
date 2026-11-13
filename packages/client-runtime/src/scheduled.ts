import type { Routine } from '@manor/contracts'

/**
 * How long a Failed or Expired one-time task stays in Upcoming after it ended. Those
 * are the only endings the user has to act on; a day is long enough to be seen after a
 * night away, short enough that Upcoming never becomes a second history.
 */
export const SCHEDULED_ATTENTION_MS = 24 * 60 * 60 * 1000

/** The three parts of the Scheduled page, on the Mac, in its sidebar and on the phone. */
export interface ScheduledSections {
  /** One-time tasks still to run, next first, after the failures that still want a look. */
  upcoming: Routine[]
  /** One-time tasks that are over and need nothing, newest ending first. */
  earlier: Routine[]
  /** Recurring routines, in the order the server gave them. */
  recurring: Routine[]
}

/** The two things Scheduled tasks shows one at a time: one-time tasks and recurring routines. */
export type ScheduleKind = 'once' | 'recurring'

export const kindOf = (routine: Routine): ScheduleKind => (routine.runAt === null ? 'recurring' : 'once')

/** Unpicked, every Scheduled surface opens on Recurring; Once is one click away. */
export const DEFAULT_KIND: ScheduleKind = 'recurring'

/** The segment on show: a selected task brings its own along, then the reader's pick, then the default. */
export const shownKind = (selected: Routine | undefined, picked: ScheduleKind | null): ScheduleKind =>
  selected !== undefined ? kindOf(selected) : picked ?? DEFAULT_KIND

export const needsAttention = (routine: Routine, now: number): boolean =>
  (routine.endState === 'failed' || routine.endState === 'expired') &&
  routine.endedAt !== null && now - routine.endedAt < SCHEDULED_ATTENTION_MS

export function scheduledSections(routines: readonly Routine[], now: number = Date.now()): ScheduledSections {
  const recurring = routines.filter((routine) => routine.runAt === null)
  const once = routines.filter((routine) => routine.runAt !== null)
  const ended = (routine: Routine) => routine.endedAt ?? routine.runAt ?? 0
  const attention = once.filter((routine) => needsAttention(routine, now)).sort((a, b) => ended(b) - ended(a))
  const pending = once.filter((routine) => routine.endState === null).sort((a, b) => (a.runAt ?? 0) - (b.runAt ?? 0))
  const earlier = once
    .filter((routine) => routine.endState !== null && !needsAttention(routine, now))
    .sort((a, b) => ended(b) - ended(a))
  return { upcoming: [...attention, ...pending], earlier, recurring }
}

/**
 * Calendar days from `now` to `ts` in the zone (the device's when absent): 0 is today,
 * 1 tomorrow. Counted on the calendar, never as `now + 24h`, which lands on the day
 * after tomorrow late on the night the clocks go forward.
 */
export function calendarDaysUntil(ts: number, now: number, timezone?: string): number {
  const day = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'numeric', day: 'numeric', timeZone: timezone })
  const utcDay = (at: number) => {
    const parts = Object.fromEntries(day.formatToParts(new Date(at)).map((part) => [part.type, part.value]))
    return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day))
  }
  return Math.round((utcDay(ts) - utcDay(now)) / 86_400_000)
}
