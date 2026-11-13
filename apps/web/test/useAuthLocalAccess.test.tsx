import { act, create } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { useAuth, type Auth } from '../src/useAuth'

const client = vi.hoisted(() => ({
  subscribe: vi.fn(() => () => undefined),
  getSession: vi.fn(() => Promise.resolve(null)),
  setActive: vi.fn(),
  refresh: vi.fn(),
}))
vi.mock('../src/authClient', () => ({ authClient: client }))

let auth: Auth
const Probe = () => {
  auth = useAuth()
  return null
}
const open = async (localAccess: (() => Promise<string | null>) | undefined) => {
  vi.stubGlobal('window', { manorDesktop: localAccess === undefined ? undefined : { localAccess } })
  await act(async () => { create(<Probe />) })
}
afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

it('opens with the key of the server on this Mac and never touches the account', async () => {
  await open(() => Promise.resolve('the-key'))

  expect(auth.state).toEqual({ status: 'local' })
  expect(auth.getToken()).toBe('the-key')
  expect(client.setActive).not.toHaveBeenCalled()
})

it('shows the account door when the desktop shell has no key, or there is no shell', async () => {
  await open(() => Promise.resolve(null))
  expect(auth.state).toEqual({ status: 'signed-out' })
  expect(client.setActive).toHaveBeenCalledWith(true)

  vi.clearAllMocks()
  await open(undefined)
  expect(auth.state).toEqual({ status: 'signed-out' })
  expect(client.setActive).toHaveBeenCalledWith(true)
})
