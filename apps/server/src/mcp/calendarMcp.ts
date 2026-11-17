import { randomUUID } from 'node:crypto'
import { createDAVClient, type DAVCalendar } from 'tsdav'
import { serveMcp, type JsonRecord } from './stdio.js'
import {
  CALENDAR_CREATE_TOOL,
  CALENDAR_ENV_KEYS,
  buildCalendarIcs,
  parseCalendarCreate,
  whenLabel,
} from './calendarCreate.js'
import { freeSlots, occurrencesInRange, parseRange, type Occurrence } from './calendarRead.js'

/**
 * Manor's own iCloud calendar connector: CalDAV with an app-specific Apple password,
 * spoken over stdio MCP like the mail connector.
 *
 * Notion Calendar shows this calendar but has no API, Composio has no iCloud
 * integration, and the Google Calendar connector cannot see it, so the calendar is
 * reached at its source. Four tools: list calendars, list events, find free time,
 * create an event. No update or delete, deliberately.
 *
 * `create_event` is gated outside this process. The effect broker blocks it in unattended
 * turns and follows the effect mode in attended ones. When it asks, it renders the card
 * from the same arguments with the same parser (`calendarCreate.ts`), so what the user
 * approves is what gets written.
 */

const SERVER_URL = 'https://caldav.icloud.com'
const LIST_MAX_DAYS = 62
const FREE_MAX_DAYS = 31
const EVENTS_MAX = 300

const RESERVED_RULE =
  'Blocks titled "vrij houden" are reserved together-time: they are never free time, ' +
  'never propose them for anything and never schedule into them.'

function tools(): JsonRecord[] {
  return [
    {
      name: 'list_calendars',
      description: 'List the user’s iCloud calendars by name, including shared ones such as "Us is a movie". Use these names in the other tools.',
      annotations: { readOnlyHint: true },
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'list_events',
      description:
        'Events in the user’s iCloud calendars for a day, week or date range, expanded (recurring events appear per occurrence). ' +
        'All times are Europe/Amsterdam. from and to take YYYY-MM-DD (to is inclusive) or YYYY-MM-DDTHH:MM; ' +
        `to defaults to the end of the from day, the range may cover ${LIST_MAX_DAYS} days. ` +
        'All-day events report start and end as their first and last day. Events marked reserved:true are ' +
        `"vrij houden" blocks. ${RESERVED_RULE}`,
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'First day YYYY-MM-DD, or YYYY-MM-DDTHH:MM.' },
          to: { type: 'string', description: 'Last day YYYY-MM-DD (inclusive), or YYYY-MM-DDTHH:MM.' },
          calendars: { type: 'array', items: { type: 'string' }, description: 'Only these calendar names. Default: all.' },
        },
        required: ['from'],
        additionalProperties: false,
      },
    },
    {
      name: 'find_free_time',
      description:
        'Free slots in the user’s iCloud calendars between from and to, inside a daily window (default 08:00–22:00, Europe/Amsterdam). ' +
        'Timed events block unless marked free. All-day events do not block but come back in allDayEvents: mention a trip or ' +
        'holiday before proposing a slot on it. "vrij houden" blocks always block. ' +
        `${RESERVED_RULE} Range at most ${FREE_MAX_DAYS} days.`,
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'First day YYYY-MM-DD, or YYYY-MM-DDTHH:MM.' },
          to: { type: 'string', description: 'Last day YYYY-MM-DD (inclusive), or YYYY-MM-DDTHH:MM.' },
          minMinutes: { type: 'number', description: 'Shortest slot worth returning. Default 30.' },
          dayStart: { type: 'string', description: 'HH:MM. Default 08:00.' },
          dayEnd: { type: 'string', description: 'HH:MM. Default 22:00.' },
          calendars: { type: 'array', items: { type: 'string' }, description: 'Only these calendars block. Default: all.' },
        },
        required: ['from'],
        additionalProperties: false,
      },
    },
    {
      name: CALENDAR_CREATE_TOOL,
      description:
        'Create one event in one of the user’s iCloud calendars. Only after the user explicitly said yes to this exact event: ' +
        'first tell them the title, day, time and calendar and wait for their yes. Manor may then show them an approval card ' +
        'with the same details; a denial means do not retry. Times are Europe/Amsterdam wall-clock time, no offsets. ' +
        'Timed: start YYYY-MM-DDTHH:MM plus end (same format) or durationMinutes. All-day: start YYYY-MM-DD and ' +
        `optionally end as the last day. ${RESERVED_RULE}`,
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          calendar: { type: 'string', description: 'Exact calendar name from list_calendars.' },
          start: { type: 'string', description: 'YYYY-MM-DDTHH:MM, or YYYY-MM-DD for all-day.' },
          end: { type: 'string', description: 'YYYY-MM-DDTHH:MM, or the last day YYYY-MM-DD for all-day.' },
          durationMinutes: { type: 'number', description: 'Instead of end, for a timed event.' },
          location: { type: 'string' },
          notes: { type: 'string' },
        },
        required: ['title', 'calendar', 'start'],
        additionalProperties: false,
      },
    },
  ]
}

type Client = Awaited<ReturnType<typeof createDAVClient>>
let clientPromise: Promise<Client> | undefined

function client(): Promise<Client> {
  const [userKey, passwordKey] = CALENDAR_ENV_KEYS
  const username = process.env[userKey]
  const password = process.env[passwordKey]
  if (!username || !password) {
    throw new Error(`The iCloud calendar is not configured: ${userKey} and ${passwordKey} must be set in apps/server/.env.`)
  }
  clientPromise ??= createDAVClient({
    serverUrl: SERVER_URL,
    credentials: { username, password },
    authMethod: 'Basic',
    defaultAccountType: 'caldav',
  }).catch((error: unknown) => {
    clientPromise = undefined
    throw safeCalDavError('sign in (check the Apple ID and app-specific password)', error)
  })
  return clientPromise
}

/**
 * tsdav errors can quote raw requests and responses, so none of their text reaches
 * the agent: only which step failed and, at most, a three-digit HTTP status.
 */
export function safeCalDavError(step: string, error: unknown): Error {
  const text = error instanceof Error ? error.message : ''
  const status = /\b([45]\d\d)\b/.exec(text)?.[1]
  return new Error(`iCloud CalDAV could not ${step} (${status === undefined ? 'no usable response' : `HTTP ${status}`}).`)
}

async function calDav<T>(step: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error: unknown) {
    throw safeCalDavError(step, error)
  }
}

/** Fetched on every call: a calendar added or shared mid-turn must be visible to the next call. */
async function eventCalendars(): Promise<DAVCalendar[]> {
  const dav = await client()
  const all = await calDav('list calendars', () => dav.fetchCalendars())
  return all.filter((calendar) => calendar.components === undefined || calendar.components.includes('VEVENT'))
}

export function calendarName(calendar: DAVCalendar): string {
  const name = calendar.displayName
  if (typeof name === 'string' && name.trim() !== '') return name.trim()
  return decodeURIComponent(calendar.url.replace(/\/$/, '').split('/').pop() ?? 'calendar')
}

function pick(calendars: DAVCalendar[], names: unknown): DAVCalendar[] {
  if (names === undefined) return calendars
  if (!Array.isArray(names) || names.some((name) => typeof name !== 'string')) throw new Error('calendars must be a list of names.')
  const wanted = new Set(names.map((name: string) => name.trim().toLowerCase()))
  const chosen = calendars.filter((calendar) => wanted.has(calendarName(calendar).toLowerCase()))
  if (chosen.length === 0) {
    throw new Error(`No calendar by that name. Known: ${calendars.map(calendarName).join(', ')}.`)
  }
  return chosen
}

async function occurrences(range: { start: number; end: number }, names: unknown): Promise<Occurrence[]> {
  const dav = await client()
  const calendars = pick(await eventCalendars(), names)
  const timeRange = {
    start: new Date(range.start).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    end: new Date(range.end).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  }
  const resources = await Promise.all(calendars.map(async (calendar) => {
    const objects = await calDav('read events', () => dav.fetchCalendarObjects({ calendar, timeRange }))
    return objects
      .filter((object): object is typeof object & { data: string } => typeof object.data === 'string')
      .map((object) => ({ calendar: calendarName(calendar), data: object.data }))
  }))
  return occurrencesInRange(resources.flat(), range)
}

function eventLine(event: Occurrence): JsonRecord {
  return {
    title: event.title,
    calendar: event.calendar,
    start: event.start,
    end: event.end,
    allDay: event.allDay,
    ...(event.location === undefined ? {} : { location: event.location }),
    ...(event.reserved ? { reserved: true } : {}),
    ...(event.transparent ? { free: true } : {}),
  }
}

async function call(name: unknown, arguments_: JsonRecord): Promise<unknown> {
  if (name === 'list_calendars') {
    const calendars = await eventCalendars()
    return { timeZone: 'Europe/Amsterdam', calendars: calendars.map(calendarName) }
  }
  if (name === 'list_events') {
    const range = parseRange(arguments_.from, arguments_.to, LIST_MAX_DAYS)
    const events = await occurrences(range, arguments_.calendars)
    return {
      timeZone: 'Europe/Amsterdam',
      count: events.length,
      ...(events.length > EVENTS_MAX ? { truncated: `first ${EVENTS_MAX} shown, narrow the range` } : {}),
      events: events.slice(0, EVENTS_MAX).map(eventLine),
    }
  }
  if (name === 'find_free_time') {
    const range = parseRange(arguments_.from, arguments_.to, FREE_MAX_DAYS)
    const minMinutes = arguments_.minMinutes === undefined ? 30 : arguments_.minMinutes
    if (typeof minMinutes !== 'number' || !Number.isFinite(minMinutes) || minMinutes < 1) {
      throw new Error('minMinutes must be a positive number.')
    }
    const events = await occurrences(range, arguments_.calendars)
    const slots = freeSlots(events, range, {
      dayStart: typeof arguments_.dayStart === 'string' ? arguments_.dayStart : '08:00',
      dayEnd: typeof arguments_.dayEnd === 'string' ? arguments_.dayEnd : '22:00',
      minMinutes,
    })
    return {
      timeZone: 'Europe/Amsterdam',
      slots,
      reservedBlocks: events.filter((event) => event.reserved).map(eventLine),
      // Not blocking, but a slot on a holiday is worth mentioning before proposing it.
      allDayEvents: events.filter((event) => event.allDay && !event.reserved).map(eventLine),
    }
  }
  if (name === CALENDAR_CREATE_TOOL) {
    const event = parseCalendarCreate(arguments_)
    const dav = await client()
    const matches = pick(await eventCalendars(), [event.calendar])
    // The approval card names the calendar; two with that name would make it ambiguous.
    if (matches.length !== 1) {
      throw new Error(`${matches.length} calendars are called "${event.calendar}". Nothing was created; ask the user to rename one.`)
    }
    const calendar = matches[0]!
    const uid = randomUUID()
    // A transport failure may still have written the event, so the agent checks before retrying.
    const response = await calDav(
      'confirm the event was created; check with list_events before trying again',
      () => dav.createCalendarObject({ calendar, iCalString: buildCalendarIcs(event, uid), filename: `${uid}.ics` }),
    )
    if (!response.ok) {
      throw new Error(`iCloud refused the event (HTTP ${response.status}). Nothing was created; tell the user rather than retrying.`)
    }
    return {
      created: true,
      title: event.title,
      calendar: calendarName(calendar),
      when: whenLabel(event),
      ...(event.location === undefined ? {} : { location: event.location }),
    }
  }
  throw new Error(`Unknown calendar tool ${String(name)}.`)
}

// Importable for tests without starting a server on their stdin.
if (process.argv[1] !== undefined && /calendarMcp\.(?:ts|mjs)$/.test(process.argv[1])) {
  void serveMcp({
    name: 'manor-icloud-calendar',
    tools: tools(),
    failureMessage: 'The calendar action failed.',
    callTool: async (name, arguments_) => [{ type: 'text', text: JSON.stringify(await call(name, arguments_)) }],
  }, '').catch((error: unknown) => {
    process.stderr.write(`[manor-calendar] ${error instanceof Error ? error.message : 'startup failed'}\n`)
    process.exitCode = 1
  })
}
