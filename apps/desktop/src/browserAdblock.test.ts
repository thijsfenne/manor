import { EventEmitter } from 'node:events'
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { CallbackResponse, HeadersReceivedResponse, OnBeforeRequestListenerDetails, OnHeadersReceivedListenerDetails, Session, WebContents } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ADBLOCK_ENGINE_FILE, BrowserAdblock, type AdblockEngine } from './browserAdblock'

const roots: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('BrowserAdblock', () => {
  it('lets requests pass until an engine exists, then blocks and counts them per page', async () => {
    const { adblock, request, page, writeEngine } = await fixture()
    const contents = page(1, 'https://news.example/')
    const changed = vi.fn()
    adblock.watch(contents, changed)

    expect(await request(1, 'https://ads.example/ad.js')).toEqual({})
    await writeEngine()
    await adblock.start()
    vi.useFakeTimers()
    expect(await request(1, 'https://ads.example/ad.js')).toEqual({ cancel: true })
    expect(await request(1, 'https://ads.example/two.js')).toEqual({ cancel: true })
    expect(await request(1, 'https://news.example/app.js')).toEqual({})
    expect(adblock.state(contents, contents.getURL())).toEqual({ blocking: true, blocked: 2 })
    expect(changed).not.toHaveBeenCalled()
    vi.advanceTimersByTime(500)
    expect(changed).toHaveBeenCalledOnce()

    contents.emit('did-navigate')
    expect(adblock.state(contents, contents.getURL())).toEqual({ blocking: true, blocked: 0 })
    adblock.stop()
  })

  it('never blocks the page itself and has no switch for non-web pages', async () => {
    const { adblock, request, page, writeEngine } = await fixture()
    await writeEngine()
    await adblock.start()
    expect(await request(1, 'https://ads.example/', 'mainFrame')).toEqual({})
    expect(adblock.state(page(2, 'about:blank'), 'about:blank')).toBeUndefined()
    adblock.stop()
  })

  it('switches a host off, frames included, and remembers it after a restart', async () => {
    const { adblock, request, page, writeEngine, restart, cosmetics } = await fixture()
    await writeEngine()
    await adblock.start()
    const contents = page(1, 'https://shop.example/checkout')
    adblock.watch(contents, () => {})

    adblock.setSiteBlocking('https://shop.example/', false)
    expect(await request(1, 'https://ads.example/pay-frame.js')).toEqual({})
    expect(adblock.state(contents, contents.getURL())).toEqual({ blocking: false, blocked: 0 })
    expect(await cosmetics(contents)).toBeUndefined()
    adblock.stop()

    const next = await restart()
    await next.adblock.start()
    expect(next.adblock.state(undefined, 'https://shop.example/other')).toEqual({ blocking: false, blocked: 0 })
    expect(next.adblock.state(undefined, 'https://www.shop.example/')).toEqual({ blocking: true, blocked: 0 })
    next.adblock.setSiteBlocking('https://shop.example/', true)
    expect(await next.request(1, 'https://ads.example/pay-frame.js')).toEqual({ cancel: true })
    next.adblock.stop()
  })

  it('adds a filter CSP as its own policy, and judges a page response by its own address', async () => {
    const { adblock, page, writeEngine, headers } = await fixture()
    await writeEngine()
    await adblock.start()
    page(1, 'https://news.example/')
    const site = { 'Content-Security-Policy': ["script-src 'nonce-abc'"] }
    expect(await headers(1, 'https://shop.example/', site)).toEqual({
      responseHeaders: { 'Content-Security-Policy': ["script-src 'nonce-abc'", 'script-src *'] },
    })
    // Still on news.example while shop.example loads; shop's own switch decides its response.
    adblock.setSiteBlocking('https://shop.example/', false)
    expect(await headers(1, 'https://shop.example/', site)).toEqual({})
    adblock.stop()
  })

  it('keeps serving the cached lists when a refresh fails, and skips a fresh cache', async () => {
    const { adblock, request, writeEngine, build, directory, log } = await fixture()
    await writeEngine()
    const old = new Date(Date.now() - 2 * 24 * 60 * 60_000)
    await utimes(path.join(directory, ADBLOCK_ENGINE_FILE), old, old)
    build.mockRejectedValueOnce(new Error('offline'))

    await adblock.start()
    expect(build).toHaveBeenCalledOnce()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('the cached lists stay in use'))
    expect(await request(1, 'https://ads.example/ad.js')).toEqual({ cancel: true })

    await writeEngine()
    await adblock.refreshIfStale()
    expect(build).toHaveBeenCalledOnce()
    adblock.stop()
  })

  it('builds the lists when there is no cache, without holding up requests', async () => {
    const { adblock, request, build, writeEngine } = await fixture()
    let finish: () => void = () => {}
    build.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = () => { void writeEngine().then(resolve) } }))

    const starting = adblock.start()
    await vi.waitFor(() => expect(build).toHaveBeenCalledOnce())
    expect(await request(1, 'https://ads.example/ad.js')).toEqual({})
    finish()
    await starting
    expect(await request(1, 'https://ads.example/ad.js')).toEqual({ cancel: true })
    adblock.stop()
  })
})

/** An engine that blocks anything on ads.example, like a list entry `||ads.example^`. */
const fakeEngine: AdblockEngine = {
  onBeforeRequest: (details, callback) => callback(new URL(details.url).hostname === 'ads.example' ? { cancel: true } : {}),
  // Like Ghostery: the filter directives and every policy it was handed, folded into one.
  onHeadersReceived: (details, callback) => callback(details.resourceType !== 'mainFrame' ? {} : {
    responseHeaders: { 'content-security-policy': [['script-src *', ...Object.values(details.responseHeaders ?? {}).flat()].join(';')] },
  }),
  onInjectCosmeticFilters: async () => {},
  onIsMutationObserverEnabled: async () => true,
}

async function fixture(existing?: string) {
  const directory = existing ?? await mkdtemp(path.join(os.tmpdir(), 'manor-adblock-'))
  if (existing === undefined) roots.push(directory)
  const contents = new Map<number, WebContents>()
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const webRequest = {
    before: null as null | ((details: OnBeforeRequestListenerDetails, callback: (response: CallbackResponse) => void) => void),
    headers: null as null | ((details: OnHeadersReceivedListenerDetails, callback: (response: HeadersReceivedResponse) => void) => void),
  }
  const session = {
    webRequest: {
      onBeforeRequest: (_filter: unknown, listener: typeof webRequest.before) => { webRequest.before = listener ?? null },
      onHeadersReceived: (_filter: unknown, listener: typeof webRequest.headers) => { webRequest.headers = listener ?? null },
    },
    registerPreloadScript: () => 'preload',
    unregisterPreloadScript: () => {},
  } as unknown as Session
  const build = vi.fn<(file: string) => Promise<void>>(async () => { await writeEngine() })
  const log = vi.fn()
  const adblock = new BrowserAdblock({
    directory,
    ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => { handlers.set(channel, handler) } } as never,
    contentsById: (id) => contents.get(id),
    buildEngine: build,
    loadEngine: () => fakeEngine,
    preloadPath: '/preload.js',
    log,
  })
  adblock.attach(session)

  async function writeEngine(): Promise<void> {
    await writeFile(path.join(directory, ADBLOCK_ENGINE_FILE), 'engine')
  }
  function page(id: number, url: string): WebContents & EventEmitter {
    const page = Object.assign(new EventEmitter(), { id, session, getURL: () => url, isDestroyed: () => false }) as unknown as WebContents & EventEmitter
    contents.set(id, page)
    return page
  }
  function request(webContentsId: number, url: string, resourceType = 'script'): Promise<CallbackResponse> {
    return new Promise((resolve) => webRequest.before!({ id: 1, url, resourceType, referrer: '', webContentsId } as OnBeforeRequestListenerDetails, resolve))
  }
  function headers(webContentsId: number, url: string, responseHeaders: Record<string, string[]>): Promise<HeadersReceivedResponse> {
    return new Promise((resolve) => webRequest.headers!({ id: 1, url, resourceType: 'mainFrame', referrer: '', webContentsId, responseHeaders } as unknown as OnHeadersReceivedListenerDetails, resolve))
  }
  function cosmetics(sender: WebContents): unknown {
    return handlers.get('@ghostery/adblocker/inject-cosmetic-filters')!({ sender }, sender.getURL())
  }
  return { adblock, request, headers, page, writeEngine, build, directory, log, cosmetics, restart: () => fixture(directory) }
}
