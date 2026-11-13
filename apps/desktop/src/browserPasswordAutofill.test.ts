import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { IpcMainEvent, WebContents } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PASSWORD_CAPTURE_CHANNEL, PASSWORD_FILL_CHANNEL, PASSWORD_FILLED_CHANNEL, PasswordAutofill } from './browserPasswordAutofill'
import { BrowserPasswordStore } from './browserPasswords'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('PasswordAutofill', () => {
  it('offers a submitted login on its tab and saves it only when the user says so', async () => {
    const { autofill, store, submit, page } = await fixture()
    const changed = vi.fn()
    const contents = page('https://example.com/login')
    autofill.watch('tab', contents, changed)

    submit(contents, { kind: 'login', username: 'sam', password: 'secret' })
    expect(changed).toHaveBeenCalledOnce()
    expect(autofill.state('tab', 'https://elsewhere.test/')).toEqual({
      logins: [],
      offer: { kind: 'save', origin: 'https://example.com', username: 'sam' },
    })
    expect(store.list()).toEqual([])

    autofill.answer('tab', 'save')
    expect(autofill.state('tab', 'https://example.com/account')).toEqual({
      logins: [{ id: expect.any(String), username: 'sam' }],
    })
  })

  it('lets a corrected password that is already stored withdraw the wrong Update', async () => {
    const { autofill, store, submit, page } = await fixture()
    const saved = store.save('https://example.com', 'sam', 'right')
    const changed = vi.fn()
    const contents = page('https://example.com/login')
    autofill.watch('tab', contents, changed)
    submit(contents, { kind: 'login', username: 'sam', password: 'wrong' })
    expect(autofill.state('tab', contents.mainFrame.url)?.offer?.kind).toBe('update')
    submit(contents, { kind: 'login', username: 'sam', password: 'right' })
    expect(changed).toHaveBeenCalledTimes(2)
    expect(autofill.state('tab', contents.mainFrame.url)?.offer).toBeUndefined()
    autofill.answer('tab', 'save')
    expect(store.credential(saved.id)?.password).toBe('right')
  })

  it('keeps the offer when saving fails, so a retry still saves it', async () => {
    const { autofill, store, submit, page } = await fixture()
    const contents = page('https://example.com/login')
    autofill.watch('tab', contents, () => {})
    submit(contents, { kind: 'login', username: 'sam', password: 'secret' })
    vi.spyOn(store, 'save').mockImplementationOnce(() => { throw new Error('Keychain unavailable') })
    expect(() => autofill.answer('tab', 'save')).toThrow('Keychain unavailable')
    autofill.answer('tab', 'save')
    expect(store.list()).toHaveLength(1)
  })

  it('withdraws an unanswered offer on its own after five minutes', async () => {
    vi.useFakeTimers()
    try {
      const { autofill, submit, page } = await fixture()
      const changed = vi.fn()
      const contents = page('https://example.com/login')
      autofill.watch('tab', contents, changed)
      submit(contents, { kind: 'login', username: 'sam', password: 'secret' })
      vi.advanceTimersByTime(5 * 60_000)
      expect(changed).toHaveBeenCalledTimes(2)
      expect(autofill.state('tab', contents.mainFrame.url)).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores subframes and pages it does not watch', async () => {
    const { autofill, submit, page } = await fixture()
    const watched = page('https://example.com/')
    autofill.watch('tab', watched, () => {})
    submit(watched, { kind: 'login', username: 'sam', password: 'secret' }, { url: 'https://example.com/' })
    submit(page('https://example.com/'), { kind: 'login', username: 'sam', password: 'secret' })
    expect(autofill.state('tab', 'https://example.com/')).toBeUndefined()
  })

  it('joins the username step of a two-page login to its password', async () => {
    const { autofill, submit, page } = await fixture()
    const contents = page('https://accounts.example.com/')
    autofill.watch('tab', contents, () => {})
    submit(contents, { kind: 'username', username: 'sam@example.invalid' })
    submit(contents, { kind: 'login', username: '', password: 'secret' })
    expect(autofill.state('tab', 'https://accounts.example.com/')?.offer?.username).toBe('sam@example.invalid')
  })

  it('fills only a page on the login site', async () => {
    const { autofill, store, page } = await fixture()
    const saved = store.save('https://example.com', 'sam', 'secret')
    const other = page('https://phish.test/')
    expect(() => autofill.fill(other, saved.id)).toThrow(/another site/)
    expect(other.mainFrame.send).not.toHaveBeenCalled()

    const right = page('https://example.com/login')
    autofill.fill(right, saved.id)
    expect(right.mainFrame.send).toHaveBeenCalledWith(PASSWORD_FILL_CHANNEL, { username: 'sam', password: 'secret' })
  })

  describe('an agent\'s fill request', () => {
    const PASSWORD = 'correct-horse-battery-staple'

    it('names the origin and username but never the password, before and after the fill', async () => {
      const { autofill, store, page, guestAnswers } = await fixture()
      const saved = store.save('https://example.com', 'sam', PASSWORD)
      const contents = page('https://example.com/login')
      guestAnswers(contents, true)

      const lookup = await autofill.agentLookup(contents)
      expect(lookup).toEqual({ pageId: contents.id, origin: 'https://example.com', login: { id: saved.id, username: 'sam' }, passwordField: true })
      const filled = await autofill.agentFill(contents, { pageId: lookup.pageId, origin: lookup.origin, loginId: saved.id })
      expect(filled).toEqual({ username: 'sam' })
      expect(JSON.stringify([lookup, filled])).not.toContain(PASSWORD)
      // Only the page itself was handed the password.
      expect(contents.mainFrame.send).toHaveBeenLastCalledWith(PASSWORD_FILL_CHANNEL, expect.objectContaining({ password: PASSWORD, agent: true }))
    })

    it('refuses when the page moved to another origin before Fill was clicked', async () => {
      const { autofill, store, page, guestAnswers } = await fixture()
      const saved = store.save('https://example.com', 'sam', PASSWORD)
      const contents = page('https://example.com/login')
      guestAnswers(contents, true)
      const lookup = await autofill.agentLookup(contents)
      contents.mainFrame.send.mockClear()

      contents.mainFrame.url = 'https://phish.test/login'
      await expect(autofill.agentFill(contents, { pageId: lookup.pageId, origin: lookup.origin, loginId: saved.id }))
        .rejects.toThrow('The page moved from example.com to phish.test before Fill was clicked, so nothing was filled.')
      expect(contents.mainFrame.send).not.toHaveBeenCalled()
    })

    it('refuses a sign-in page replaced by another on the same origin', async () => {
      const { autofill, store, page, guestAnswers } = await fixture()
      const saved = store.save('https://example.com', 'sam', PASSWORD)
      const first = page('https://example.com/login')
      guestAnswers(first, true)
      const lookup = await autofill.agentLookup(first)
      const replacement = page('https://example.com/login')
      await expect(autofill.agentFill(replacement, { pageId: lookup.pageId, origin: lookup.origin, loginId: saved.id }))
        .rejects.toThrow(/closed or replaced/)
      expect(replacement.mainFrame.send).not.toHaveBeenCalled()
    })

    it('blanks a filled password, raw or URL-encoded, from what the browser hands back', async () => {
      const { autofill, store, page, guestAnswers } = await fixture()
      const saved = store.save('https://example.com', 'sam', 'p@ss word!')
      const contents = page('https://example.com/login')
      guestAnswers(contents, true)
      const lookup = await autofill.agentLookup(contents)
      await autofill.agentFill(contents, { pageId: lookup.pageId, origin: lookup.origin, loginId: saved.id })
      const echoed = autofill.redact({
        url: 'https://example.com/login?password=p%40ss+word%21',
        console: ['typed p@ss word!'],
        title: 'p%40ss%20word!',
      })
      expect(JSON.stringify(echoed)).not.toMatch(/p@ss|p%40ss/)
      expect(echoed.console).toEqual(['typed ••••••••'])
      // Identities stay as they are, so routing and the fill's own binding keep working.
      expect(autofill.redact({ id: 'p@ss word!', title: 'p@ss word!' })).toEqual({ id: 'p@ss word!', title: '••••••••' })
    })

    it('matches the exact origin only, so a subdomain has no saved login', async () => {
      const { autofill, store, page, guestAnswers } = await fixture()
      store.save('https://example.com', 'sam', PASSWORD)
      const contents = page('https://login.example.com/')
      guestAnswers(contents, true)
      expect(await autofill.agentLookup(contents)).toEqual({ pageId: contents.id, origin: 'https://login.example.com', passwordField: true })
    })

    it('holds the page out of screenshots after a fill, until it loads a page whose address carries no password', async () => {
      const { autofill, store, page, guestAnswers } = await fixture()
      const saved = store.save('https://example.com', 'sam', PASSWORD)
      const contents = page('https://example.com/login')
      guestAnswers(contents, true)
      expect(autofill.holds(contents)).toBe(false)
      await autofill.agentFill(contents, { pageId: contents.id, origin: 'https://example.com', loginId: saved.id })
      expect(autofill.holds(contents)).toBe(true)
      contents.emit('did-navigate', {}, `https://example.com/echo?password=${PASSWORD}`)
      expect(autofill.holds(contents)).toBe(true)
      contents.emit('did-navigate', {}, 'https://example.com/home')
      expect(autofill.holds(contents)).toBe(false)
      // A capture running across the fill and that navigation still sees a fill landed.
      expect(autofill.fillsInto(contents)).toBe(1)
    })

    it('refuses a password too short to keep out of the agent\'s view, before any card', async () => {
      const { autofill, store, page, guestAnswers } = await fixture()
      store.save('https://example.com', 'sam', 'abc')
      const contents = page('https://example.com/login')
      guestAnswers(contents, true)
      await expect(autofill.agentLookup(contents)).rejects.toThrow(/too short/)
    })

    it('does not count a fill the page had no password field for', async () => {
      const { autofill, store, page, guestAnswers } = await fixture()
      const saved = store.save('https://example.com', 'sam', PASSWORD)
      const contents = page('https://example.com/login')
      guestAnswers(contents, false)
      await expect(autofill.agentFill(contents, { pageId: contents.id, origin: 'https://example.com', loginId: saved.id }))
        .rejects.toThrow(/could not fill the saved password/)
    })
  })
})

type FakeContents = WebContents & { mainFrame: { url: string; send: ReturnType<typeof vi.fn> } }

describe('a secret card fill', () => {
  it('fills only the document it showed, keeps no copy, and seals the page through its redirects', async () => {
    const { autofill, store, page, submit, guestAnswers } = await fixture()
    const contents = page('https://example.com/login')
    autofill.watch('tab', contents, vi.fn())
    guestAnswers(contents, true)
    const value = 'card-only-value'

    const { pageId } = await autofill.agentField(contents)
    await autofill.agentFillSecret(contents, { pageId, origin: 'https://example.com', value })
    expect(contents.mainFrame.send).toHaveBeenCalledWith(PASSWORD_FILL_CHANNEL, expect.objectContaining({ username: '', password: value, agent: true }))
    expect(autofill.sealed(contents)).toBe(true)
    expect(autofill.redact(`echo ${value}`)).toBe(`echo ${value}`)

    submit(contents, { kind: 'login', username: 'sam', password: value })
    expect(autofill.state('tab', 'https://example.com/login')).toBeUndefined()
    expect(store.list()).toEqual([])

    contents.emit('did-navigate', {}, 'https://example.com/home')
    expect(autofill.sealed(contents)).toBe(true)
    autofill.unseal(contents)
    expect(autofill.sealed(contents)).toBe(false)
  })

  it('names only the origin from before the fill, also after a redirect that spells the value', async () => {
    const { autofill, page, guestAnswers } = await fixture()
    const contents = page('https://example.com/login')
    autofill.watch('tab', contents, vi.fn())
    guestAnswers(contents, true)
    const first = await autofill.agentField(contents)
    await autofill.agentFillSecret(contents, { pageId: first.pageId, origin: 'https://example.com', value: '123456' })

    contents.mainFrame.url = 'https://123456.example.net/'
    contents.emit('did-navigate', {}, 'https://123456.example.net/')

    expect(autofill.sealedOrigin(contents)).toBe('https://example.com')
    const second = await autofill.agentField(contents)
    expect(second.origin).toBe('https://example.com')
    await expect(autofill.agentFillSecret(contents, { pageId: second.pageId, origin: second.origin, value: 'code' })).rejects.toThrow('another site')
    await expect(autofill.agentLookup(contents)).rejects.toThrow('received a secret')
    await expect(autofill.agentFill(contents, { pageId: contents.id, origin: 'https://example.com', loginId: 'x' })).rejects.toThrow('received a secret')
  })

  it('seals the opener of a popup that takes the value, on its own origin, only when the fill goes ahead', async () => {
    const { autofill, page, guestAnswers } = await fixture()
    const popup = page('https://accounts.example.com/login')
    const opener = page('https://app.example.com/')
    autofill.watch('tab', popup, vi.fn())
    guestAnswers(popup, true)
    const { pageId } = await autofill.agentField(popup)

    await expect(autofill.agentFillSecret(popup, { pageId: pageId + 1, origin: 'https://accounts.example.com', value: 'value' }, opener)).rejects.toThrow('nothing was filled')
    expect(autofill.sealed(opener)).toBe(false)

    await autofill.agentFillSecret(popup, { pageId, origin: 'https://accounts.example.com', value: 'value' }, opener)
    expect(autofill.sealedOrigin(opener)).toBe('https://app.example.com')
  })

  it('keeps no capture from a sealed page, so an echoed username step cannot wait for the next login', async () => {
    const { autofill, page, submit, guestAnswers } = await fixture()
    const contents = page('https://example.com/login')
    autofill.watch('tab', contents, vi.fn())
    guestAnswers(contents, true)
    const { pageId } = await autofill.agentField(contents)
    await autofill.agentFillSecret(contents, { pageId, origin: 'https://example.com', value: 'card-only-value' })

    submit(contents, { kind: 'username', username: 'card-only-value' })
    autofill.unseal(contents)
    submit(contents, { kind: 'login', username: '', password: 'later' })

    expect(autofill.state('tab', 'https://example.com/login')?.offer?.username).toBe('')
  })

  it('fills a value too short for a saved login, because the seal does not depend on redaction', async () => {
    const { autofill, page, guestAnswers } = await fixture()
    const contents = page('https://example.com/login')
    autofill.watch('tab', contents, vi.fn())
    guestAnswers(contents, true)
    const { pageId } = await autofill.agentField(contents)

    await autofill.agentFillSecret(contents, { pageId, origin: 'https://example.com', value: '42' })

    expect(autofill.sealed(contents)).toBe(true)
  })

  it('refuses a same-origin navigation while the card waited', async () => {
    const { autofill, page, guestAnswers } = await fixture()
    const contents = page('https://example.com/login')
    guestAnswers(contents, true)
    const { pageId } = await autofill.agentField(contents)

    contents.emit('did-navigate-in-page', {}, 'https://example.com/login#next', true)
    await expect(autofill.agentFillSecret(contents, { pageId, origin: 'https://example.com', value: 'card-only-value' })).rejects.toThrow('nothing was filled')
    expect(autofill.sealed(contents)).toBe(false)
  })

  it('refuses a moved page, a replaced page, a short value and a page that took nothing', async () => {
    const { autofill, page, guestAnswers } = await fixture()
    const contents = page('https://example.com/login')
    guestAnswers(contents, true)
    const target = { pageId: (await autofill.agentField(contents)).pageId, origin: 'https://example.com', value: 'long-enough' }
    guestAnswers(contents, false)

    await expect(autofill.agentFillSecret(page('https://example.com/'), target)).rejects.toThrow('nothing was filled')
    await expect(autofill.agentFillSecret(contents, { ...target, origin: 'https://elsewhere.test' })).rejects.toThrow('another site')
    expect(autofill.sealed(contents)).toBe(false)
    await expect(autofill.agentFillSecret(contents, target)).rejects.toThrow('could not fill')
    expect(autofill.sealed(contents)).toBe(true)
  })
})

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'manor-autofill-'))
  roots.push(root)
  const store = new BrowserPasswordStore(path.join(root, 'passwords.sqlite'), {
    encrypt: (plaintext) => Buffer.from(`sealed:${plaintext}`),
    decrypt: (encrypted) => encrypted.toString().slice('sealed:'.length),
  })
  const ipc = new EventEmitter()
  const autofill = new PasswordAutofill(store, { on: (channel, listener) => { ipc.on(channel, listener); return ipc as never } })
  let nextId = 1
  const page = (url: string): FakeContents => {
    const contents = Object.assign(new EventEmitter(), {
      id: nextId++,
      isDestroyed: () => false,
      mainFrame: { url, send: vi.fn() },
    })
    return contents as unknown as FakeContents
  }
  const submit = (contents: FakeContents, payload: unknown, frame: { url: string } = contents.mainFrame) => {
    ipc.emit(PASSWORD_CAPTURE_CHANNEL, { sender: contents, senderFrame: frame } as unknown as IpcMainEvent, payload)
  }
  /** The guest script's answer to a probe or an agent fill, from the page's main frame. */
  const guestAnswers = (contents: FakeContents, filled: boolean) => {
    contents.mainFrame.send.mockImplementation((_channel: string, request: { requestId?: string }) => {
      if (request.requestId === undefined) return
      queueMicrotask(() => ipc.emit(PASSWORD_FILLED_CHANNEL, { sender: contents, senderFrame: contents.mainFrame } as unknown as IpcMainEvent, { requestId: request.requestId, filled }))
    })
  }
  return { autofill, store, page, submit, guestAnswers }
}
