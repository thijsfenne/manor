import { createDAVClient, type DAVCalendar } from 'tsdav'
import { CALENDAR_ENV_KEYS } from './calendarCreate.js'
import { occurrencesInRange, type Occurrence, type Range } from './calendarRead.js'

/**
 * The iCloud CalDAV fetch, shared by the calendar connector's stdio process and the
 * server, which reads the user's calendar as text for a Mail reply draft. Bundled into
 * the connector on its own, so it imports nothing from the server.
 */

const SERVER_URL = 'https://caldav.icloud.com'

type Client = Awaited<ReturnType<typeof createDAVClient>>
let clientPromise: Promise<Client> | undefined

export function calendarClient(): Promise<Client> {
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

export async function calDav<T>(step: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error: unknown) {
    throw safeCalDavError(step, error)
  }
}

/** Fetched on every call: a calendar added or shared mid-turn must be visible to the next call. */
export async function eventCalendars(): Promise<DAVCalendar[]> {
  const dav = await calendarClient()
  const all = await calDav('list calendars', () => dav.fetchCalendars())
  return all.filter((calendar) => calendar.components === undefined || calendar.components.includes('VEVENT'))
}

export function calendarName(calendar: DAVCalendar): string {
  const name = calendar.displayName
  if (typeof name === 'string' && name.trim() !== '') return name.trim()
  return decodeURIComponent(calendar.url.replace(/\/$/, '').split('/').pop() ?? 'calendar')
}

/** The calendars named in a tool's `calendars` argument; all of them when it is absent. */
export function pickCalendars(calendars: DAVCalendar[], names: unknown): DAVCalendar[] {
  if (names === undefined) return calendars
  if (!Array.isArray(names) || names.some((name) => typeof name !== 'string')) throw new Error('calendars must be a list of names.')
  const wanted = new Set(names.map((name: string) => name.trim().toLowerCase()))
  const chosen = calendars.filter((calendar) => wanted.has(calendarName(calendar).toLowerCase()))
  if (chosen.length === 0) {
    throw new Error(`No calendar by that name. Known: ${calendars.map(calendarName).join(', ')}.`)
  }
  return chosen
}

/** Occurrences in the range across the named calendars, or all of them; errors are already `safeCalDavError`s. */
export async function fetchOccurrences(range: Range, names?: unknown): Promise<Occurrence[]> {
  const dav = await calendarClient()
  const known = await eventCalendars()
  // The library turns a refused listing into an empty one, and no calendars would read as a free agenda.
  if (known.length === 0) throw new Error('iCloud CalDAV listed no calendars.')
  const calendars = pickCalendars(known, names)
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
