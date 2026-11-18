import { describe, expect, it, vi } from 'vitest'
import { ManorAuthClient, type ManorSession } from './auth'
const session: ManorSession = {
  access_token: 'access-token', refresh_token: 'refresh-token-long-enough', expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: { id: '00000000-0000-4000-8000-000000000001', email: 'owner@example.invalid' },
}
function storage() {
  const values = new Map<string, string>()
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
}
describe('shared Manor authentication', () => {
  it('preserves the browser receiver for native fetch during login, refresh and logout', async () => {
    const browserFetch = vi.fn<typeof fetch>(function (this: unknown) {
      if (this !== globalThis) throw new TypeError('Illegal invocation')
      return Promise.resolve(new Response(JSON.stringify(session)))
    })
    vi.stubGlobal('fetch', browserFetch)
    try {
      const client = new ManorAuthClient('http://localhost:43179', storage())
      expect(await client.signIn('owner@example.invalid', 'password')).toBeNull()
      await client.refresh()
      await client.signOut()
      expect(browserFetch).toHaveBeenCalledTimes(3)
      expect(await client.getSession()).toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('persists across client restarts and retains a session through a network interruption', async () => {
    const saved = storage()
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(session)))
    const first = new ManorAuthClient('http://localhost:43179', saved, fetcher)
    expect(await first.signIn('owner@example.invalid', 'password')).toBeNull()
    const reopened = new ManorAuthClient('http://localhost:43179', saved, fetcher)
    expect(await reopened.getSession()).toEqual(session)
    fetcher.mockRejectedValueOnce(new Error('offline'))
    await reopened.refresh()
    expect(await reopened.getSession()).toEqual(session)
    fetcher.mockResolvedValueOnce(new Response('{}', { status: 401 }))
    await reopened.refresh()
    expect(await reopened.getSession()).toBeNull()
  })
  it('gives up on a refresh the Mac never answers, so the next one can start', async () => {
    vi.useFakeTimers()
    try {
      const saved = storage()
      const hanging = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      }))
      const client = new ManorAuthClient('http://localhost:43179', saved, vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(session))))
      expect(await client.signIn('owner@example.invalid', 'password')).toBeNull()
      const stalled = new ManorAuthClient('http://localhost:43179', saved, hanging)
      const refresh = stalled.refresh()
      await vi.advanceTimersByTimeAsync(10_000)
      await refresh
      expect(await stalled.getSession()).toEqual(session)
      expect(stalled.refresh()).not.toBe(refresh)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not restore a session from an in-flight refresh after sign-out', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(session)))
    const client = new ManorAuthClient('http://localhost:43179', storage(), fetcher)
    await client.signIn('owner@example.invalid', 'password')
    let release: (response: Response) => void = () => { throw new Error('refresh not started') }
    fetcher.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    const refresh = client.refresh()
    await Promise.resolve()
    fetcher.mockResolvedValueOnce(new Response('{}'))
    await client.signOut()
    release(new Response(JSON.stringify(session)))
    await refresh
    expect(await client.getSession()).toBeNull()
  })

  it('retries a rejected storage read and announces the session it recovers', async () => {
    const saved = storage()
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(session)))
    await new ManorAuthClient('http://localhost:43179', saved, fetcher).signIn('owner@example.invalid', 'password')
    const getItem = vi.fn<(key: string) => Promise<string | null>>(async (key) => saved.getItem(key))
      .mockRejectedValueOnce(new Error('keychain locked'))
    const client = new ManorAuthClient('http://localhost:43179', { ...saved, getItem }, fetcher)
    const heard = vi.fn()
    client.subscribe(heard)
    await expect(client.getSession()).rejects.toThrow('keychain locked')
    expect(await client.getSession()).toEqual(session)
    expect(getItem).toHaveBeenCalledTimes(2)
    expect(heard).toHaveBeenCalledWith(session)
  })

  it('still revokes the server session and tells listeners when local removal fails', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(session)))
    const saved = storage()
    const client = new ManorAuthClient('http://localhost:43179', { ...saved, removeItem: () => Promise.reject(new Error('disk full')) }, fetcher)
    await client.signIn('owner@example.invalid', 'password')
    const heard = vi.fn()
    client.subscribe(heard)
    await client.signOut()
    expect(fetcher).toHaveBeenLastCalledWith('http://localhost:43179/auth/logout', expect.objectContaining({ body: JSON.stringify({ refresh_token: session.refresh_token }) }))
    expect(heard).toHaveBeenCalledWith(null)
    expect(await client.getSession()).toBeNull()
  })
})
