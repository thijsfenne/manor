import { describe, expect, it } from 'vitest'

import {
  CREDENTIAL_KEY,
  createCredentialStore,
  hostName,
  resolveDevServer,
  serverMediaUri,
  setConnectionOrigin,
  type CredentialStorage,
} from './connection'

const credential = {
  origin: 'https://mac.tailnet.ts.net',
  token: `00000000-0000-4000-8000-000000000001.${'a'.repeat(43)}`,
  deviceId: '00000000-0000-4000-8000-000000000001',
}

function fakeStorage(initial?: Record<string, string>) {
  const values = new Map(Object.entries(initial ?? {}))
  const storage: CredentialStorage = {
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => { values.set(key, value) },
    removeItem: async (key) => { values.delete(key) },
  }
  return { storage, values }
}

describe('credential store', () => {
  it('keeps one entry and reads it back', async () => {
    const { storage, values } = fakeStorage()
    const store = createCredentialStore(storage)
    expect(await store.load()).toBeNull()
    await store.save(credential)
    expect([...values.keys()]).toEqual([CREDENTIAL_KEY])
    expect(await store.load()).toEqual(credential)
    await store.clear()
    expect(await store.load()).toBeNull()
  })

  it('treats unreadable storage and corrupt entries as not paired', async () => {
    expect(await createCredentialStore(fakeStorage({ [CREDENTIAL_KEY]: '{nope' }).storage).load()).toBeNull()
    const locked: CredentialStorage = { ...fakeStorage().storage, getItem: async () => { throw new Error('keychain locked') } }
    expect(await createCredentialStore(locked).load()).toBeNull()
  })
})

describe('dev server override', () => {
  it('applies only in a development build and only to an http origin', () => {
    expect(resolveDevServer('http://127.0.0.1:43180', true)).toBe('http://127.0.0.1:43180')
    expect(resolveDevServer(' http://127.0.0.1:43180/ ', true)).toBe('http://127.0.0.1:43180')
    expect(resolveDevServer('http://127.0.0.1:43180', false)).toBeNull()
    expect(resolveDevServer(undefined, true)).toBeNull()
    expect(resolveDevServer('127.0.0.1:43180', true)).toBeNull()
    expect(resolveDevServer('ws://127.0.0.1:43180/ws', true)).toBeNull()
  })
})

describe('current origin', () => {
  it('names the host and resolves server paths against the connected Mac', () => {
    setConnectionOrigin(null)
    expect(hostName()).toBe('Mac')
    expect(serverMediaUri('/media/a.png')).toBeUndefined()
    expect(serverMediaUri('https://example.invalid/a.png')).toBe('https://example.invalid/a.png')
    setConnectionOrigin(credential.origin)
    expect(hostName()).toBe('mac.tailnet.ts.net')
    expect(serverMediaUri('/media/a.png')).toBe('https://mac.tailnet.ts.net/media/a.png')
  })
})
