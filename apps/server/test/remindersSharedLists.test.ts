import { afterEach, describe, expect, it, vi } from 'vitest'
import { refuseSharedDelete } from '../src/mcp/remindersMcp.js'

afterEach(() => { vi.unstubAllEnvs() })

type List = NonNullable<Parameters<typeof refuseSharedDelete>[0]>
const list = (title: string, shared = false) => ({ id: 'L', title, shared }) as List

describe('deleting from a Reminders list', () => {
  it('is refused for a list Reminders flags as shared, and for an unknown list', () => {
    expect(() => refuseSharedDelete(list('Groceries', true))).toThrow(/is shared/)
    expect(() => refuseSharedDelete(undefined)).toThrow(/unknown/)
    expect(() => refuseSharedDelete(list('Private'))).not.toThrow()
  })

  // The flag is lost when the list details cannot be read. The names the user gave still hold.
  it('is refused for a list the user named as shared, whatever the flag says', () => {
    vi.stubEnv('MANOR_REMINDERS_SHARED_LISTS', ' Groceries , Household ')
    expect(() => refuseSharedDelete(list('groceries'))).toThrow(/is shared/)
    expect(() => refuseSharedDelete(list(' Household '))).toThrow(/is shared/)
    expect(() => refuseSharedDelete(list('Private'))).not.toThrow()
  })
})
