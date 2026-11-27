import { afterEach, expect, it, vi } from 'vitest'
import { CALENDAR_ENV_KEYS } from '../src/mcp/calendarCreate.js'
import { fetchOccurrences } from '../src/mcp/calendarDav.js'

const listing = vi.hoisted(() => ({ fetchCalendars: vi.fn(), fetchCalendarObjects: vi.fn() }))
vi.mock('tsdav', () => ({ createDAVClient: async () => listing }))

afterEach(() => vi.unstubAllEnvs())

it('refuses a listing without calendars instead of reading it as a free agenda', async () => {
  for (const key of CALENDAR_ENV_KEYS) vi.stubEnv(key, 'placeholder')
  listing.fetchCalendars.mockResolvedValue([])
  const day = Date.UTC(2026, 11, 1)
  await expect(fetchOccurrences({ start: day, end: day + 86_400_000 })).rejects.toThrow('listed no calendars')
  expect(listing.fetchCalendarObjects).not.toHaveBeenCalled()
})
