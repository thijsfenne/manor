import { CronExpressionParser } from 'cron-parser'

/**
 * When a cron next fires, read in its own zone.
 *
 * Handed to a library rather than hand-rolled because of one week a year: on the
 * October change a 07:00 routine has to stay 07:00 local, and arithmetic on epoch
 * milliseconds turns it into 06:00 for half the year. `from` is exclusive, so the
 * answer is always strictly in the future of the moment asked about — which is also
 * what makes a roll-forward over many missed slots land on one slot rather than
 * walking through all of them.
 */
export function nextRunAfter(cron: string, timezone: string, from: number): number {
  return CronExpressionParser.parse(cron, { currentDate: new Date(from), tz: timezone })
    .next()
    .toDate()
    .getTime()
}

/**
 * How long this schedule leaves between the fire at `at` and the one after it. The
 * grace window is half of this, so a five-minute routine gets a two and a half minute
 * window and a daily one gets the two-hour cap: the same rule reads sensibly at both
 * ends without a per-routine knob.
 */
export function intervalAfter(cron: string, timezone: string, at: number): number {
  return nextRunAfter(cron, timezone, at) - at
}

/**
 * The cron string as it will be stored, or a throw naming the rule it broke.
 *
 * Unlike the other rules in `checkRoutineDraft` this one has no check constraint
 * behind it: Postgres holds a cron as text and would take `every tuesday` happily.
 * It is checked here anyway because both stores compute `next_run_at` from it on the
 * way in, so an unparseable schedule is a row that cannot be written at all — and a
 * refusal that says so beats a parser's error surfacing three layers up.
 */
export function checkCron(cron: string): string {
  const trimmed = cron.trim()
  try {
    CronExpressionParser.parse(trimmed)
  } catch {
    throw new Error(`${cron} is not a cron expression`)
  }
  return trimmed
}

/**
 * The IANA zone as it will be stored, or a throw. A recurring routine is checked by
 * computing its next fire; a one-time one has no cron to compute, so the zone that
 * its confirmation and rows are written in is checked here instead.
 */
export function checkTimezone(timezone: string): string {
  const trimmed = timezone.trim()
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: trimmed })
  } catch {
    throw new Error(`${JSON.stringify(timezone)} is not a timezone`)
  }
  return trimmed
}

/**
 * A moment as the routine's own zone reads it, zone named: `Fri 3 Oct, 10:00 CEST`.
 * Used wherever Manor tells the user when something was or will be, so a reminder set
 * from Lisbon and read in Amsterdam cannot be an hour off without saying so.
 */
export function formatMoment(ts: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: timezone,
    timeZoneName: 'short',
  }).format(new Date(ts))
}
