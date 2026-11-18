import { act, create } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { useAuth, type Auth } from '../src/useAuth'

const ORIGIN = 'https://mac.example.ts.net'
const TOKEN = `${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}.${'a'.repeat(43)}`
const DEVICE_ID = TOKEN.split('.')[0]!

let auth: Auth
const Probe = () => {
  auth = useAuth()
  return null
}

/** A browser window at `href`, with storage that lives as long as the test. */
function stubWindow(href: string, localAccess?: () => Promise<string | null>) {
  const url = new URL(href)
  const storage = new Map<string, string>()
  const replaceState = vi.fn()
  vi.stubGlobal('window', {
    manorDesktop: localAccess === undefined ? undefined : { localAccess },
    location: { origin: url.origin, pathname: url.pathname, hash: url.hash, href },
    history: { replaceState },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  })
  vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (iPhone) Version/18 Mobile Safari/604.1' })
  return { storage, replaceState }
}
const open = async () => { await act(async () => { create(<Probe />) }) }

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('opens with the key of the server on this Mac and never pairs', async () => {
  stubWindow(`${ORIGIN}/`, () => Promise.resolve('the-key'))
  await open()

  expect(auth.state).toEqual({ status: 'local' })
  expect(auth.getToken()).toBe('the-key')
})

it('shows the Connect screen when the desktop shell has no key, or there is no shell', async () => {
  stubWindow(`${ORIGIN}/`, () => Promise.resolve(null))
  await open()
  expect(auth.state).toEqual({ status: 'unpaired', error: null })

  stubWindow(`${ORIGIN}/`)
  await open()
  expect(auth.state).toEqual({ status: 'unpaired', error: null })
  expect(auth.getToken()).toBeNull()
})

it('pairs this browser from a pairing link and takes the code out of the address bar', async () => {
  const { storage, replaceState } = stubWindow(`${ORIGIN}/pair#code=${'c'.repeat(43)}`)
  const fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ token: TOKEN, deviceId: DEVICE_ID }), { status: 200 })))
  vi.stubGlobal('fetch', fetch)
  await open()

  expect(fetch).toHaveBeenCalledWith(`${ORIGIN}/pair`, expect.objectContaining({ body: JSON.stringify({ code: 'c'.repeat(43), name: 'Browser on iPhone' }) }))
  expect(auth.state).toEqual({ status: 'paired', deviceId: DEVICE_ID })
  expect(auth.getToken()).toBe(TOKEN)
  expect(replaceState).toHaveBeenCalledWith(null, '', '/')
  expect([...storage.values()].join()).toContain(TOKEN)
})

it('goes back to the Connect screen when the Mac revoked this browser', async () => {
  const { storage } = stubWindow(`${ORIGIN}/`)
  storage.set(`manor.device.${ORIGIN}`, JSON.stringify({ origin: ORIGIN, token: TOKEN, deviceId: DEVICE_ID }))
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{}', { status: 401 }))))
  await open()
  expect(auth.state).toEqual({ status: 'paired', deviceId: DEVICE_ID })

  await act(async () => { auth.refresh() })

  expect(auth.state).toEqual({ status: 'unpaired', error: 'This browser was removed from Manor. Pair it again.' })
  expect(storage.size).toBe(0)
})
