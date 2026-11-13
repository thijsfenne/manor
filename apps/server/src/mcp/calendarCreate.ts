import { randomUUID } from 'node:crypto'

/**
 * The create half of the iCloud calendar connector, kept free of CalDAV and ical.js
 * because two processes need the same answer from it. The connector builds the event
 * from these arguments, and the effect broker renders the approval card from the very
 * same arguments before the call reaches the connector. One parser means the card
 * cannot say 14:00 while the calendar gets 16:00.
 *
 * Every time here is wall-clock time in Europe/Amsterdam. Agents pass `2026-10-03T14:00`,
 * never an offset, so DST is Manor's problem rather than the model's.
 */

export const CALENDAR_TIME_ZONE = 'Europe/Amsterdam'
export const ICLOUD_CALENDAR_MCP_NAME = 'icloud-calendar'
export const CALENDAR_CREATE_TOOL = 'create_event'
/** The Apple ID and an app-specific password from appleid.apple.com, both in apps/server/.env. */
export const CALENDAR_ENV_KEYS = ['MANOR_ICLOUD_CALDAV_USER', 'MANOR_ICLOUD_CALDAV_PASSWORD'] as const

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::00)?$/
const TITLE_MAX = 200
const TEXT_MAX = 2_000
const TIMED_MAX_MINUTES = 14 * 24 * 60
const ALL_DAY_MAX_DAYS = 31

export interface WallTime { year: number; month: number; day: number; hour: number; minute: number }

export type CalendarCreate = {
  title: string
  calendar: string
  location?: string
  notes?: string
} & (
  | { allDay: false; start: number; end: number }
  /** Dates as `YYYY-MM-DD`; `lastDay` is inclusive, the way people say it. */
  | { allDay: true; firstDay: string; lastDay: string }
)

const offsetFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: CALENDAR_TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
})

/** The Amsterdam wall clock at an instant. */
export function wallTime(instant: number): WallTime {
  const parts = Object.fromEntries(
    offsetFormatter.formatToParts(new Date(instant)).map((part) => [part.type, part.value]),
  )
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute),
  }
}

/** The instant an Amsterdam wall-clock time names. A time inside the spring-forward gap lands an hour later. */
export function amsterdamInstant(time: WallTime): number {
  const asUtc = Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute)
  let guess = asUtc
  for (let pass = 0; pass < 2; pass += 1) {
    const seen = wallTime(guess)
    const offset = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute) - guess
    guess = asUtc - offset
  }
  return guess
}

/**
 * A time Manor acts on must name exactly one moment. On the spring-forward night 02:30
 * does not exist, and on the fall-back night it happens twice; either way the agent
 * picks another time rather than letting Manor guess. Used for event times and for
 * read-range boundaries alike.
 */
export function exactInstant(time: WallTime, text: string): number {
  const candidate = amsterdamInstant(time)
  const same = (instant: number) => {
    const seen = wallTime(instant)
    return seen.year === time.year && seen.month === time.month && seen.day === time.day &&
      seen.hour === time.hour && seen.minute === time.minute
  }
  if (!same(candidate)) throw new Error(`${text} does not exist in Amsterdam: the clocks skip that hour. Use another time.`)
  if (same(candidate - 3_600_000) || same(candidate + 3_600_000)) {
    throw new Error(`${text} happens twice in Amsterdam: the clocks go back that night. Use another time.`)
  }
  return candidate
}

export function parseDate(value: string): WallTime | undefined {
  const match = DATE.exec(value)
  if (match === null) return undefined
  const time = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]), hour: 0, minute: 0 }
  return validCalendarDate(time) ? time : undefined
}

export function parseDateTime(value: string): WallTime | undefined {
  const match = DATE_TIME.exec(value)
  if (match === null) return undefined
  const time = {
    year: Number(match[1]), month: Number(match[2]), day: Number(match[3]),
    hour: Number(match[4]), minute: Number(match[5]),
  }
  if (time.hour > 23 || time.minute > 59) return undefined
  return validCalendarDate(time) ? time : undefined
}

function validCalendarDate(time: WallTime): boolean {
  const date = new Date(Date.UTC(time.year, time.month - 1, time.day))
  return date.getUTCFullYear() === time.year && date.getUTCMonth() === time.month - 1 && date.getUTCDate() === time.day
}

export function dateKey(time: Pick<WallTime, 'year' | 'month' | 'day'>): string {
  return `${time.year}-${pad(time.month)}-${pad(time.day)}`
}

export function addDays(date: string, days: number): string {
  const parsed = parseDate(date)
  if (parsed === undefined) throw new Error(`${date} is not a YYYY-MM-DD date.`)
  const moved = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day + days))
  return dateKey({ year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1, day: moved.getUTCDate() })
}

const pad = (value: number) => String(value).padStart(2, '0')

/**
 * Validates `create_event` arguments. Throws a message the model can act on; the
 * broker treats a throw as "nothing to show, so nothing to approve".
 */
export function parseCalendarCreate(arguments_: unknown): CalendarCreate {
  if (typeof arguments_ !== 'object' || arguments_ === null || Array.isArray(arguments_)) {
    throw new Error('create_event needs an arguments object.')
  }
  const input = arguments_ as Record<string, unknown>
  const title = requiredText(input.title, 'title', TITLE_MAX)
  const calendar = requiredText(input.calendar, 'calendar', TITLE_MAX)
  const location = optionalText(input.location, 'location', TITLE_MAX)
  const notes = optionalText(input.notes, 'notes', TEXT_MAX)
  const extras = {
    ...(location === undefined ? {} : { location }),
    ...(notes === undefined ? {} : { notes }),
  }
  if (typeof input.start !== 'string') throw new Error('create_event needs start, as YYYY-MM-DDTHH:MM or YYYY-MM-DD for an all-day event.')

  const firstDay = parseDate(input.start)
  if (firstDay !== undefined) {
    if (input.durationMinutes !== undefined) throw new Error('An all-day event takes end as its last day, not durationMinutes.')
    const lastDayText = input.end === undefined ? input.start : input.end
    if (typeof lastDayText !== 'string' || parseDate(lastDayText) === undefined) {
      throw new Error('For an all-day event, end must be the last day as YYYY-MM-DD.')
    }
    const days = (Date.parse(`${lastDayText}T00:00:00Z`) - Date.parse(`${input.start}T00:00:00Z`)) / 86_400_000
    if (days < 0) throw new Error('The last day of an all-day event cannot be before its first day.')
    if (days >= ALL_DAY_MAX_DAYS) throw new Error(`An all-day event may span at most ${ALL_DAY_MAX_DAYS} days.`)
    return { title, calendar, ...extras, allDay: true, firstDay: input.start, lastDay: lastDayText }
  }

  const startWall = parseDateTime(input.start)
  if (startWall === undefined) {
    throw new Error('start must be Amsterdam wall-clock time as YYYY-MM-DDTHH:MM, or YYYY-MM-DD for an all-day event. No offsets.')
  }
  const start = exactInstant(startWall, input.start)
  let end: number
  if (input.end !== undefined) {
    if (input.durationMinutes !== undefined) throw new Error('Pass end or durationMinutes, not both.')
    const endWall = typeof input.end === 'string' ? parseDateTime(input.end) : undefined
    if (endWall === undefined) throw new Error('end must be Amsterdam wall-clock time as YYYY-MM-DDTHH:MM.')
    end = exactInstant(endWall, input.end as string)
  } else if (input.durationMinutes !== undefined) {
    const minutes = input.durationMinutes
    if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes <= 0) {
      throw new Error('durationMinutes must be a whole number of minutes above zero.')
    }
    end = start + minutes * 60_000
  } else {
    throw new Error('A timed event needs end or durationMinutes.')
  }
  if (end <= start) throw new Error('The event must end after it starts.')
  if (end - start > TIMED_MAX_MINUTES * 60_000) throw new Error('A timed event may last at most 14 days.')
  return { title, calendar, ...extras, allDay: false, start, end }
}

function requiredText(value: unknown, name: string, max: number): string {
  const text = optionalText(value, name, max)
  if (text === undefined) throw new Error(`create_event needs ${name}.`)
  return text
}

function optionalText(value: unknown, name: string, max: number): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`${name} must be text.`)
  const text = value.trim()
  if (text.length === 0) return undefined
  if (text.length > max) throw new Error(`${name} may be at most ${max} characters.`)
  return text
}

const dayFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
})

/** `Fri 3 Oct 2026`. The date is a calendar day, so it is formatted in UTC on purpose. */
export function dayLabel(date: string): string {
  return dayFormatter.format(new Date(`${date}T00:00:00Z`)).replace(/,/g, '')
}

export function clock(instant: number): string {
  const time = wallTime(instant)
  return `${pad(time.hour)}:${pad(time.minute)}`
}

/** When the event happens, for a human reading an approval card or a reply. */
export function whenLabel(event: CalendarCreate): string {
  if (event.allDay) {
    return event.firstDay === event.lastDay
      ? `${dayLabel(event.firstDay)}, all day`
      : `${dayLabel(event.firstDay)} to ${dayLabel(event.lastDay)}, all day`
  }
  const startDay = dateKey(wallTime(event.start))
  const endDay = dateKey(wallTime(event.end))
  return startDay === endDay
    ? `${dayLabel(startDay)}, ${clock(event.start)}–${clock(event.end)}`
    : `${dayLabel(startDay)} ${clock(event.start)} to ${dayLabel(endDay)} ${clock(event.end)}`
}

/** The approval card's question. Built by Manor from the call arguments, never by the connector. */
export function calendarCreateQuestion(event: CalendarCreate): string {
  const where = event.location === undefined ? '' : ` Location: ${event.location}.`
  const notes = event.notes === undefined ? '' : ' Includes a note.'
  return `Add “${event.title}” to the iCloud calendar “${event.calendar}” on ${whenLabel(event)}?${where}${notes}`
}

/** RFC 5545 TEXT escaping, which also keeps a newline in a title from starting a new property. */
function icsText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n')
}

function icsUtc(instant: number): string {
  return new Date(instant).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

/** Content lines fold at 75 octets; continuation lines start with one space. */
function fold(line: string): string {
  const bytes = Buffer.from(line, 'utf8')
  if (bytes.length <= 75) return line
  const pieces: string[] = []
  let current = ''
  let size = 0
  for (const character of line) {
    const width = Buffer.byteLength(character, 'utf8')
    if (size + width > (pieces.length === 0 ? 75 : 74)) {
      pieces.push(current)
      current = ''
      size = 0
    }
    current += character
    size += width
  }
  pieces.push(current)
  return pieces.join('\r\n ')
}

/**
 * Timed events are written in UTC. Every client renders them in local time, and it
 * avoids shipping a VTIMEZONE block that has to stay right for Amsterdam's rules.
 */
export function buildCalendarIcs(event: CalendarCreate, uid: string = randomUUID(), now: number = Date.now()): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Manor//iCloud calendar connector//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${icsUtc(now)}`,
    ...(event.allDay
      ? [
          `DTSTART;VALUE=DATE:${event.firstDay.replace(/-/g, '')}`,
          `DTEND;VALUE=DATE:${addDays(event.lastDay, 1).replace(/-/g, '')}`,
        ]
      : [`DTSTART:${icsUtc(event.start)}`, `DTEND:${icsUtc(event.end)}`]),
    `SUMMARY:${icsText(event.title)}`,
    ...(event.location === undefined ? [] : [`LOCATION:${icsText(event.location)}`]),
    ...(event.notes === undefined ? [] : [`DESCRIPTION:${icsText(event.notes)}`]),
    'END:VEVENT',
    'END:VCALENDAR',
  ]
  return `${lines.map(fold).join('\r\n')}\r\n`
}
