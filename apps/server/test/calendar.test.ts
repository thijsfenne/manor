import { describe, expect, it } from 'vitest'
import { buildCalendarIcs, parseCalendarCreate } from '../src/mcp/calendarCreate.js'
import { safeCalDavError } from '../src/mcp/calendarDav.js'
import { freeSlots, occurrencesInRange, parseRange } from '../src/mcp/calendarRead.js'

const ics = (...events: string[]) => [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:test',
  'BEGIN:VTIMEZONE', 'TZID:Europe/Amsterdam',
  'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'DTSTART:19810329T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'DTSTART:19961027T030000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD',
  'END:VTIMEZONE',
  ...events,
  'END:VCALENDAR',
].join('\r\n')

const vevent = (...lines: string[]) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'].join('\r\n')

describe('iCloud calendar reads', () => {
  it('expands a weekly series in Amsterdam time across the DST change, with a moved and a cancelled occurrence', () => {
    const data = ics(
      vevent('UID:padel', 'SUMMARY:Padel', 'DTSTART;TZID=Europe/Amsterdam:20261019T190000',
        'DTEND;TZID=Europe/Amsterdam:20261019T200000', 'RRULE:FREQ=WEEKLY', 'EXDATE;TZID=Europe/Amsterdam:20261102T190000'),
      vevent('UID:padel', 'SUMMARY:Padel (later)', 'RECURRENCE-ID;TZID=Europe/Amsterdam:20261026T190000',
        'DTSTART;TZID=Europe/Amsterdam:20261026T203000', 'DTEND;TZID=Europe/Amsterdam:20261026T213000'),
    )
    const events = occurrencesInRange([{ calendar: 'Thuis', data }], parseRange('2026-10-19', '2026-11-09', 62))
    expect(events.map((event) => [event.title, event.start, event.end])).toEqual([
      ['Padel', '2026-10-19T19:00', '2026-10-19T20:00'],
      ['Padel (later)', '2026-10-26T20:30', '2026-10-26T21:30'],
      ['Padel', '2026-11-09T19:00', '2026-11-09T20:00'],
    ])
  })

  it('reports all-day events by first and last day, and only "vrij houden" all-day blocks take free time', () => {
    const data = ics(
      vevent('UID:trip', 'SUMMARY:Weekend Gent', 'DTSTART;VALUE=DATE:20261003', 'DTEND;VALUE=DATE:20261005'),
      vevent('UID:us', 'SUMMARY:Vrij houden', 'DTSTART;VALUE=DATE:20261004', 'DTEND;VALUE=DATE:20261005'),
      vevent('UID:tentative', 'SUMMARY:Misschien borrel', 'TRANSP:TRANSPARENT',
        'DTSTART:20261003T160000Z', 'DTEND:20261003T180000Z'),
      vevent('UID:lunch', 'SUMMARY:Lunch', 'DTSTART:20261003T100000Z', 'DTEND:20261003T113000Z'),
    )
    const range = parseRange('2026-10-03', '2026-10-04', 31)
    const events = occurrencesInRange([{ calendar: 'Us is a movie', data }], range)
    const trip = events.find((event) => event.title === 'Weekend Gent')
    expect(trip).toMatchObject({ allDay: true, start: '2026-10-03', end: '2026-10-04', reserved: false })
    expect(events.find((event) => event.title === 'Vrij houden')?.reserved).toBe(true)

    expect(freeSlots(events, range, { dayStart: '09:00', dayEnd: '22:00', minMinutes: 30 })).toEqual([
      { start: '2026-10-03T09:00', end: '2026-10-03T12:00', minutes: 180 },
      { start: '2026-10-03T13:30', end: '2026-10-03T22:00', minutes: 510 },
    ])
  })

  it('finds a long occurrence that began weeks before the range, and a moved one whose original slot is far away', () => {
    const data = ics(
      vevent('UID:summer', 'SUMMARY:Zomerhuis', 'DTSTART;VALUE=DATE:20250701', 'DTEND;VALUE=DATE:20250815', 'RRULE:FREQ=YEARLY'),
      vevent('UID:book', 'SUMMARY:Boekenclub', 'DTSTART;TZID=Europe/Amsterdam:20260601T200000',
        'DTEND;TZID=Europe/Amsterdam:20260601T210000', 'RRULE:FREQ=MONTHLY;BYMONTHDAY=1'),
      vevent('UID:book', 'SUMMARY:Boekenclub (verzet)', 'RECURRENCE-ID;TZID=Europe/Amsterdam:20260601T200000',
        'DTSTART;TZID=Europe/Amsterdam:20260810T200000', 'DTEND;TZID=Europe/Amsterdam:20260810T210000'),
    )
    const events = occurrencesInRange([{ calendar: 'Thuis', data }], parseRange('2026-08-10', '2026-08-10', 1))
    expect(events.map((event) => [event.title, event.start])).toEqual([
      ['Zomerhuis', '2026-07-01'],
      ['Boekenclub (verzet)', '2026-08-10T20:00'],
    ])
    const june = occurrencesInRange([{ calendar: 'Thuis', data }], parseRange('2026-06-01', '2026-06-01', 1))
    expect(june.map((event) => event.title)).toEqual([])
  })

  it('treats a day in `to` as inclusive and refuses offsets', () => {
    const range = parseRange('2026-10-25', '2026-10-25', 1)
    expect((range.end - range.start) / 3_600_000).toBe(25)
    expect(() => parseRange('2026-10-25T10:00Z', undefined, 1)).toThrow(/without an offset/)
    expect(() => parseRange('2026-03-29T02:30', '2026-03-29', 1)).toThrow(/does not exist/)
    expect(() => parseRange('2026-10-25', '2026-10-25T02:30', 1)).toThrow(/happens twice/)
  })
})

describe('iCloud calendar create', () => {
  it('reads Amsterdam wall time, including after the clocks go back, and round-trips through the reader', () => {
    const event = parseCalendarCreate({
      title: 'Etentje, met; Anna\nextra',
      calendar: 'Thuis',
      start: '2026-10-26T19:00',
      durationMinutes: 90,
      location: 'De Vishal',
    })
    const data = buildCalendarIcs(event, 'uid-1', Date.UTC(2026, 8, 29))
    expect(data).toContain('DTSTART:20261026T180000Z')
    expect(data).toContain('SUMMARY:Etentje\\, met\\; Anna\\nextra')
    const [read] = occurrencesInRange([{ calendar: 'Thuis', data }], parseRange('2026-10-26', undefined, 1))
    expect(read).toMatchObject({ start: '2026-10-26T19:00', end: '2026-10-26T20:30', location: 'De Vishal' })
  })

  it('writes an all-day end as the day after the last day', () => {
    const data = buildCalendarIcs(parseCalendarCreate({
      title: 'Vakantie', calendar: 'Thuis', start: '2026-12-24', end: '2026-12-26',
    }))
    expect(data).toContain('DTSTART;VALUE=DATE:20261224')
    expect(data).toContain('DTEND;VALUE=DATE:20261227')
  })

  it('refuses ambiguous or impossible events', () => {
    const base = { title: 'x', calendar: 'Thuis' }
    expect(() => parseCalendarCreate({ ...base, start: '2026-10-03T19:00' })).toThrow(/end or durationMinutes/)
    expect(() => parseCalendarCreate({ ...base, start: '2026-10-03T19:00', end: '2026-10-03T18:00' })).toThrow(/after it starts/)
    expect(() => parseCalendarCreate({ ...base, start: '2026-02-30T19:00', durationMinutes: 30 })).toThrow(/wall-clock/)
    expect(() => parseCalendarCreate({ title: 'x', start: '2026-10-03', calendar: '' })).toThrow(/calendar/)
    expect(() => parseCalendarCreate({ ...base, start: '2026-03-29T02:30', durationMinutes: 30 })).toThrow(/does not exist/)
    expect(() => parseCalendarCreate({ ...base, start: '2026-10-25T02:30', durationMinutes: 30 })).toThrow(/happens twice/)
    expect(() => parseCalendarCreate({ ...base, start: '2026-10-25T03:00', durationMinutes: 30 })).not.toThrow()
  })

  it('never lets CalDAV error text reach the agent', () => {
    const error = safeCalDavError('read events', new Error('401 Unauthorized: Authorization: Basic dXNlcjpzZWNyZXQ= password=hunter2'))
    expect(error.message).toBe('iCloud CalDAV could not read events (HTTP 401).')
  })
})
