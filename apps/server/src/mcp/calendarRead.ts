import ICAL from 'ical.js'
import {
  addDays,
  amsterdamInstant,
  dateKey,
  exactInstant,
  parseDate,
  parseDateTime,
  wallTime,
} from './calendarCreate.js'

/**
 * The read half of the iCloud calendar connector: raw iCalendar resources in,
 * occurrences inside a range out, plus free time between them. No network here, so
 * the awkward parts (recurrence, moved occurrences, all-day dates, DST) are unit
 * tested against fixtures instead of the user's real calendar.
 */

export interface CalendarResource {
  calendar: string
  data: string
}

export interface Occurrence {
  title: string
  calendar: string
  allDay: boolean
  /** Instants, for sorting and free-time maths. All-day occurrences use Amsterdam midnight. */
  startsAt: number
  endsAt: number
  /** All-day: `YYYY-MM-DD` first and last (inclusive) day. Timed: Amsterdam `YYYY-MM-DDTHH:MM`. */
  start: string
  end: string
  location?: string
  /** A "vrij houden" block: reserved together-time, never free and never to be filled. */
  reserved: boolean
  /** Marked free (TRANSP:TRANSPARENT) in the source, so it does not block free time. */
  transparent: boolean
}

export interface Range { start: number; end: number }

/**
 * Upper bound on recurrence steps for one series. Steps before the range are cheap
 * (no occurrence details), so a daily rule from 2000 still reaches today.
 */
const RECURRENCE_STEPS_MAX = 100_000
/** Covers a series whose occurrences lengthen by an hour across a DST change. */
const DST_SLACK_MS = 3_600_000

const RESERVED = /vrij\s*-?\s*houden/i

export function isReservedTitle(title: string): boolean {
  return RESERVED.test(title)
}

/**
 * `from` and `to` accept a day (`YYYY-MM-DD`) or an Amsterdam wall time. A day in
 * `to` is inclusive: from 2026-10-01 to 2026-10-01 is that whole Wednesday.
 */
export function parseRange(from: unknown, to: unknown, maxDays: number): Range {
  if (typeof from !== 'string') throw new Error('from is required, as YYYY-MM-DD or YYYY-MM-DDTHH:MM.')
  const start = boundary(from, false)
  // Without `to`, the range runs to the end of the day `from` falls on.
  const end = to === undefined ? boundary(from.slice(0, 10), true) : typeof to === 'string'
    ? boundary(to, true)
    : undefined
  if (start === undefined || end === undefined) {
    throw new Error('from and to must be YYYY-MM-DD or YYYY-MM-DDTHH:MM in Amsterdam time, without an offset.')
  }
  if (end <= start) throw new Error('to must be after from.')
  if (end - start > maxDays * 86_400_000 + 3_600_000) throw new Error(`A range may cover at most ${maxDays} days.`)
  return { start, end }
}

function boundary(value: string, isEnd: boolean): number | undefined {
  const day = parseDate(value)
  if (day !== undefined) return amsterdamInstant(isEnd ? parseDate(addDays(value, 1))! : day)
  const time = parseDateTime(value)
  return time === undefined ? undefined : exactInstant(time, value)
}

let amsterdamRegistered = false

/**
 * Most resources carry their own VTIMEZONE, which is registered as it is met. The
 * fallback covers a resource that names Europe/Amsterdam without defining it.
 */
function ensureAmsterdam(): void {
  if (amsterdamRegistered || ICAL.TimezoneService.has('Europe/Amsterdam')) {
    amsterdamRegistered = true
    return
  }
  const component = new ICAL.Component(ICAL.parse(AMSTERDAM_VTIMEZONE))
  ICAL.TimezoneService.register(component)
  amsterdamRegistered = true
}

export function occurrencesInRange(resources: readonly CalendarResource[], range: Range): Occurrence[] {
  ensureAmsterdam()
  const found: Occurrence[] = []
  for (const resource of resources) {
    let root: InstanceType<typeof ICAL.Component>
    try {
      root = new ICAL.Component(ICAL.parse(resource.data))
    } catch {
      // One malformed resource must not hide the rest of the week.
      continue
    }
    for (const zone of root.getAllSubcomponents('vtimezone')) {
      const tzid = zone.getFirstPropertyValue('tzid')
      if (typeof tzid === 'string' && !ICAL.TimezoneService.has(tzid)) ICAL.TimezoneService.register(zone)
    }
    const events = root.getAllSubcomponents('vevent')
    const masters = events.filter((event) => !event.hasProperty('recurrence-id'))
    const overrides = events.filter((event) => event.hasProperty('recurrence-id'))
    for (const master of masters) {
      const event = new ICAL.Event(master)
      if (!event.isRecurring()) {
        push(found, resource.calendar, event, event.startDate, event.endDate, range)
        continue
      }
      // Occurrences replaced by an override are reported at their overridden time below.
      const uid = master.getFirstPropertyValue('uid')
      const replaced = new Set(overrides
        .filter((override) => override.getFirstPropertyValue('uid') === uid)
        .map((override) => instant(override.getFirstPropertyValue('recurrence-id'))))
      // An occurrence starting this long before the range can still run into it.
      const reach = spanMs(event) + DST_SLACK_MS
      const iterator = event.iterator()
      for (let step = 0; step < RECURRENCE_STEPS_MAX; step += 1) {
        const next = iterator.next()
        if (next === undefined || next === null) break
        const nominal = next.toJSDate().getTime()
        if (nominal >= range.end) break
        if (nominal + reach < range.start || replaced.has(nominal)) continue
        const details = event.getOccurrenceDetails(next)
        push(found, resource.calendar, details.item, details.startDate, details.endDate, range)
      }
    }
    // Every override stands on its own start and end, wherever its original slot was.
    for (const override of overrides) {
      const event = new ICAL.Event(override)
      push(found, resource.calendar, event, event.startDate, event.endDate, range)
    }
  }
  return found.sort((a, b) => a.startsAt - b.startsAt || a.title.localeCompare(b.title))
}

type IcalTime = InstanceType<typeof ICAL.Time>
type IcalEvent = InstanceType<typeof ICAL.Event>

function instant(value: unknown): number {
  return value instanceof ICAL.Time ? value.toJSDate().getTime() : NaN
}

function spanMs(event: IcalEvent): number {
  const start = event.startDate.toJSDate().getTime()
  const end = event.endDate?.toJSDate().getTime() ?? start
  return Math.max(0, end - start, event.startDate.isDate ? 86_400_000 : 0)
}

function push(
  found: Occurrence[],
  calendar: string,
  event: IcalEvent,
  startDate: IcalTime,
  endDate: IcalTime | null | undefined,
  range: Range,
): void {
  if (event.component.getFirstPropertyValue('status') === 'CANCELLED') return
  const allDay = startDate.isDate
  const title = event.summary || '(no title)'
  let startsAt: number
  let endsAt: number
  let start: string
  let end: string
  if (allDay) {
    const firstDay = dateKey(startDate)
    // DTEND on a date is exclusive; a missing one means a single day.
    const endExclusive = endDate?.isDate === true ? dateKey(endDate) : addDays(firstDay, 1)
    const lastDay = endExclusive > firstDay ? addDays(endExclusive, -1) : firstDay
    startsAt = amsterdamInstant(parseDate(firstDay)!)
    endsAt = amsterdamInstant(parseDate(addDays(lastDay, 1))!)
    start = firstDay
    end = lastDay
  } else {
    startsAt = startDate.toJSDate().getTime()
    endsAt = endDate === null || endDate === undefined ? startsAt : endDate.toJSDate().getTime()
    start = localStamp(startsAt)
    end = localStamp(endsAt)
  }
  const overlaps = endsAt > range.start && startsAt < range.end
  const instantInRange = endsAt === startsAt && startsAt >= range.start && startsAt < range.end
  if (!overlaps && !instantInRange) return
  const location = event.location
  found.push({
    title,
    calendar,
    allDay,
    startsAt,
    endsAt,
    start,
    end,
    ...(typeof location === 'string' && location.trim() !== '' ? { location: location.trim() } : {}),
    reserved: isReservedTitle(title),
    transparent: event.component.getFirstPropertyValue('transp') === 'TRANSPARENT',
  })
}

function localStamp(instant: number): string {
  const time = wallTime(instant)
  return `${dateKey(time)}T${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`
}

export interface FreeSlot { start: string; end: string; minutes: number }

export interface FreeTimeOptions {
  /** Daily window in Amsterdam time, `HH:MM`. */
  dayStart: string
  dayEnd: string
  minMinutes: number
}

/**
 * Free time is the daily window minus anything that blocks. Timed events block unless
 * marked free. All-day events do not block (birthdays, holidays, "Anna in Parijs"),
 * with one exception: a "vrij houden" block is together-time and blocks whether it is
 * timed or all-day.
 */
export function freeSlots(occurrences: readonly Occurrence[], range: Range, options: FreeTimeOptions): FreeSlot[] {
  const [startHour, startMinute] = clockParts(options.dayStart)
  const [endHour, endMinute] = clockParts(options.dayEnd)
  if (endHour * 60 + endMinute <= startHour * 60 + startMinute) throw new Error('dayEnd must be after dayStart.')
  const busy = occurrences
    .filter((event) => event.reserved || (!event.allDay && !event.transparent))
    .map((event) => ({ start: event.startsAt, end: event.endsAt }))
    .sort((a, b) => a.start - b.start)

  const slots: FreeSlot[] = []
  let day = dateKey(wallTime(range.start))
  const lastDay = dateKey(wallTime(range.end - 1))
  for (let guard = 0; day <= lastDay && guard < 400; guard += 1, day = addDays(day, 1)) {
    const date = parseDate(day)!
    const windowStart = Math.max(range.start, amsterdamInstant({ ...date, hour: startHour, minute: startMinute }))
    const windowEnd = Math.min(range.end, amsterdamInstant({ ...date, hour: endHour, minute: endMinute }))
    let cursor = windowStart
    for (const block of busy) {
      if (block.end <= cursor || block.start >= windowEnd) continue
      if (block.start > cursor) addSlot(slots, cursor, Math.min(block.start, windowEnd), options.minMinutes)
      cursor = Math.max(cursor, block.end)
      if (cursor >= windowEnd) break
    }
    if (cursor < windowEnd) addSlot(slots, cursor, windowEnd, options.minMinutes)
  }
  return slots
}

function addSlot(slots: FreeSlot[], start: number, end: number, minMinutes: number): void {
  const minutes = Math.floor((end - start) / 60_000)
  if (minutes < minMinutes) return
  slots.push({ start: localStamp(start), end: localStamp(end), minutes })
}

function clockParts(value: string): [number, number] {
  const match = /^(\d{2}):(\d{2})$/.exec(value)
  const hour = match === null ? NaN : Number(match[1])
  const minute = match === null ? NaN : Number(match[2])
  if (!(hour >= 0 && hour <= 24 && minute >= 0 && minute <= 59) || (hour === 24 && minute !== 0)) {
    throw new Error(`${value} is not a HH:MM time.`)
  }
  return [hour, minute]
}

const AMSTERDAM_VTIMEZONE = [
  'BEGIN:VTIMEZONE',
  'TZID:Europe/Amsterdam',
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:+0100',
  'TZOFFSETTO:+0200',
  'TZNAME:CEST',
  'DTSTART:19700329T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:+0200',
  'TZOFFSETTO:+0100',
  'TZNAME:CET',
  'DTSTART:19701025T030000',
  'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
  'END:STANDARD',
  'END:VTIMEZONE',
].join('\r\n')
