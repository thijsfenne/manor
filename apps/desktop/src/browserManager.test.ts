import { beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  capturePage: vi.fn(async () => ({ isEmpty: () => false, getSize: () => ({ width: 900, height: 600 }), toJPEG: () => Buffer.from('frame') })),
  hosts: [] as Array<{
    closed: boolean
    visible: boolean
    opened: number
    navigatedTo: string[]
    bounds: unknown[]
    updateCoveredPage: ReturnType<typeof vi.fn>
    restored?: { urls: string[]; activeIndex: number; pinnedCount?: number }
    tabs: Array<{ id: string; url: string; pinned?: boolean }>
    activeTabId: string | null
    guestContents?: object
    popup?: (url: string) => void
    audibleNow: boolean
    discarded: number[]
    interrupted: number
  }>,
  snapshot: () => Promise.resolve({
    url: '',
    title: '',
    visibleText: '',
    interactiveElements: [],
    console: [],
  }) as Promise<unknown>,
  close: () => Promise.resolve() as Promise<void>,
  restore: () => Promise.resolve() as Promise<void>,
  selectPageContext: () => Promise.resolve(null) as Promise<unknown>,
}))

vi.mock('./browserWebviews', () => ({ BrowserWebviews: class { close() {} } }))

vi.mock('./browserHost', () => ({
  BrowserHost: class {
    closed = false
    visible = false
    opened = 0
    navigatedTo: string[] = []
    bounds: unknown[] = []
    updateCoveredPage = vi.fn(() => true)
    restored: { urls: string[]; activeIndex: number; pinnedCount?: number } | undefined
    tabs: Array<{ id: string; url: string; pinned?: boolean }> = []
    activeTabId: string | null = null
    guestContents?: object

    constructor(_window?: unknown, _profile?: unknown, _changed?: unknown, _webviews?: unknown,
      _visit?: unknown, _title?: unknown, popup?: (url: string) => void) {
      this.popup = popup
      harness.hosts.push(this)
    }
    popup?: (url: string) => void

    audibleNow = false
    discarded: number[] = []
    interrupted = 0
    interruptInput() { this.interrupted += 1; return Promise.resolve() }
    audible() { return this.audibleNow }
    discardUnseen(afterMs: number) { this.discarded.push(afterMs) }
    hasPreviewWindow() { return false }
    activeWebContents() { return this.guestContents }

    setVisible(visible: boolean, covered = false) {
      this.visible = visible && !covered
      return Promise.resolve()
    }

    setBounds(bounds: unknown) { this.bounds.push(bounds); return Promise.resolve() }
    state() {
      return {
        tabs: this.tabs.map((tab) => ({
          id: tab.id,
          title: '',
          url: tab.url,
          ...(tab.pinned ? { pinned: true } : {}),
          loading: false,
          canGoBack: false,
          canGoForward: false,
        })),
        activeTabId: this.activeTabId,
      }
    }
    newTab() {
      this.opened += 1
      const id = `tab_${this.opened}`
      this.tabs.push({ id, url: 'about:blank' })
      this.activeTabId = id
      return Promise.resolve()
    }
    navigate(url: string) {
      this.navigatedTo.push(url)
      const tab = this.tabs.find((candidate) => candidate.id === this.activeTabId)
      if (tab !== undefined) tab.url = url
      return Promise.resolve({ url, title: '' })
    }
    openInBackground(url: string) {
      this.opened += 1
      this.tabs.push({ id: `tab_${this.opened}`, url })
      this.navigatedTo.push(url)
      return Promise.resolve()
    }
    restoreTabs(urls: string[], activeIndex: number, pinnedCount?: number) {
      this.restored = { urls, activeIndex, ...(pinnedCount === undefined ? {} : { pinnedCount }) }
      this.tabs = urls.map((url, index) => ({ id: `tab_${index + 1}`, url,
        ...(index < (pinnedCount ?? 0) ? { pinned: true } : {}) }))
      this.activeTabId = this.tabs[activeIndex]?.id ?? this.tabs[0]?.id ?? null
      this.opened += urls.length
      this.navigatedTo.push(...urls.filter((url) => url !== 'about:blank' && url !== ''))
      return harness.restore()
    }
    pinTab(tabId: string, pinned: boolean) {
      const index = this.tabs.findIndex((tab) => tab.id === tabId)
      if (index === -1) throw new Error('That browser tab is not open.')
      const [tab] = this.tabs.splice(index, 1)
      tab!.pinned = pinned
      const firstRegular = this.tabs.findIndex((candidate) => !candidate.pinned)
      this.tabs.splice(firstRegular === -1 ? this.tabs.length : firstRegular, 0, tab!)
    }
    snapshot() { return harness.snapshot() }
    selectPageContext() { return harness.selectPageContext() }
    cancelPageContextSelection() { return Promise.resolve() }
    endAgentUse() { return Promise.resolve() }
    previewTarget() { return this.activeTabId === null ? undefined : { tabId: this.activeTabId, contents: { isDestroyed: () => false, capturePage: harness.capturePage } } }
    close() {
      this.closed = true
      return harness.close()
    }
  },
}))

import { BROWSER_PROFILE_PARTITION, BrowserManager } from './browserManager'
import { noPagePasswords } from './browserPasswordAutofill'

const profile = () => ({ clearData: vi.fn(async () => {}), clearCache: vi.fn(async () => {}), clearStorageData: vi.fn(async () => {}) })

describe('BrowserManager lifecycle', () => {
  beforeEach(() => {
    harness.hosts.length = 0
    harness.snapshot = () => Promise.resolve({
      url: '',
      title: '',
      visibleText: '',
      interactiveElements: [],
      console: [],
    })
    harness.close = () => Promise.resolve()
    harness.restore = () => Promise.resolve()
    harness.selectPageContext = () => Promise.resolve(null)
  })

  it('names the shared profile as a disk-backed Electron partition', () => {
    expect(BROWSER_PROFILE_PARTITION).toBe('persist:manor-browser')
  })

  it('accepts shortcuts from the visible browser, stage or chat panel, and only its active guest', async () => {
    const manager = new BrowserManager({} as never, profile() as never)
    const activeGuest = {}
    const otherGuest = {}
    expect(manager.acceptsShortcut()).toBe(false)
    await manager.show({ x: 0, y: 0, width: 800, height: 600 }, 'browser:home')
    harness.hosts[0]!.guestContents = activeGuest
    expect(manager.acceptsShortcut()).toBe(true)
    expect(manager.acceptsShortcut(activeGuest as never)).toBe(true)
    expect(manager.acceptsShortcut(otherGuest as never)).toBe(false)

    await manager.show({ x: 0, y: 0, width: 800, height: 600 }, 'chat_1')
    expect(manager.acceptsShortcut()).toBe(true)
    // The stage's guest is parked now; only the chat panel's own page may claim keys.
    expect(manager.acceptsShortcut(activeGuest as never)).toBe(false)
    await manager.hide()
    expect(manager.acceptsShortcut()).toBe(false)
  })

  it('leaves the page user-owned while selecting context', async () => {
    const manager = new BrowserManager({} as never, profile() as never)
    await manager.show({ x: 0, y: 0, width: 800, height: 600 }, 'chat_1')
    await manager.selectPageContext('chat_1')

    expect(harness.hosts[0]).toMatchObject({ visible: true, closed: false })
  })

  it('starts a fresh idle window when a visible session is parked', async () => {
    vi.useFakeTimers()
    const manager = new BrowserManager({} as never, profile() as never, () => {}, 25)
    await manager.show({ x: 0, y: 0, width: 800, height: 600 }, 'chat_1')
    await vi.advanceTimersByTimeAsync(24)
    await manager.hide()

    await vi.advanceTimersByTimeAsync(1)
    expect(harness.hosts[0]?.closed).toBe(false)
    await vi.advanceTimersByTimeAsync(24)
    expect(harness.hosts[0]?.closed).toBe(true)
    vi.useRealTimers()
  })


  it('destroys a timed-out host before another action can use that chat', async () => {
    vi.useFakeTimers()
    harness.snapshot = () => new Promise(() => {})
    const manager = new BrowserManager({} as never, profile() as never, () => {}, 60_000, 25)
    await manager.show({ x: 0, y: 0, width: 800, height: 600 }, 'chat_1')
    const timedOut = manager.snapshot('chat_1')
    const assertion = expect(timedOut).rejects.toThrow('did not finish that action in time')
    await vi.advanceTimersByTimeAsync(25)
    await assertion

    expect(harness.hosts[0]).toMatchObject({ closed: true })
    expect(harness.hosts).toHaveLength(1)
    await manager.show({ x: 0, y: 0, width: 800, height: 600 }, 'chat_1')
    expect(harness.hosts[1]).toMatchObject({ visible: true })
    harness.snapshot = () => Promise.resolve({
      url: '', title: '', visibleText: '', interactiveElements: [], console: [],
    })
    await manager.snapshot('chat_1')
    expect(harness.hosts).toHaveLength(2)
    vi.useRealTimers()
  })

  it('does not resurrect timeout recovery after the panel was hidden during cleanup', async () => {
    vi.useFakeTimers()
    harness.snapshot = () => new Promise(() => {})
    let finishClose: (() => void) | undefined
    harness.close = () => new Promise<void>((resolve) => { finishClose = resolve })
    const manager = new BrowserManager({} as never, profile() as never, () => {}, 60_000, 25)
    await manager.show({ x: 0, y: 0, width: 800, height: 600 }, 'chat_1')
    const timedOut = manager.snapshot('chat_1')
    const assertion = expect(timedOut).rejects.toThrow('did not finish that action in time')
    await vi.advanceTimersByTimeAsync(25)
    await manager.hide()
    finishClose?.()
    await assertion

    expect(harness.hosts).toHaveLength(1)
    vi.useRealTimers()
  })

  it('passes agent answers and tab state through the saved-password redaction', async () => {
    harness.snapshot = () => Promise.resolve({ url: 'https://example.com/?p=hunter22', title: '', visibleText: 'hunter22', interactiveElements: [], console: [] })
    const passwords = { ...noPagePasswords, redact: <T,>(value: T): T => JSON.parse(JSON.stringify(value).replaceAll('hunter22', '••')) as T }
    const manager = new BrowserManager({} as never, profile() as never, () => {}, undefined, undefined, undefined, undefined, undefined, undefined, passwords)
    await manager.newTab('chat_1', 'https://example.com/?p=hunter22')

    expect(JSON.stringify([await manager.snapshot('chat_1'), await manager.tabs('chat_1')])).not.toContain('hunter22')
  })


  it('opens and navigates an agent tab without blocking human input', async () => {
    const manager = new BrowserManager({} as never, profile() as never)
    await manager.newTab('chat_1', 'https://jobs.example.com/vacancy')

    expect(harness.hosts[0]).toMatchObject({
      opened: 1,
      navigatedTo: ['https://jobs.example.com/vacancy'],
    })
  })

  it('queues a page popup behind the active browser action', async () => {
    const manager = new BrowserManager({} as never, profile() as never)
    await manager.newTab('chat_1')
    let release = () => {}
    harness.snapshot = () => new Promise((resolve) => { release = () => resolve({}) })
    const action = manager.snapshot('chat_1')
    await new Promise<void>((resolve) => setImmediate(resolve))

    harness.hosts[0]?.popup?.('https://example.com/popup')
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(harness.hosts[0]?.opened).toBe(1)
    release()
    await action
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(harness.hosts[0]?.navigatedTo).toContain('https://example.com/popup')
    // A page cannot move what the user is looking at: the popup lands behind the current tab.
    expect(harness.hosts[0]?.activeTabId).toBe('tab_1')
    expect(harness.hosts[0]?.tabs.map((tab) => tab.url)).toEqual(['about:blank', 'https://example.com/popup'])
  })

  it('ignores a popup from a closed browser host', async () => {
    const manager = new BrowserManager({} as never, profile() as never)
    await manager.newTab('chat_1')
    const old = harness.hosts[0]
    await manager.close('chat_1')
    old?.popup?.('https://example.com/late')
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(harness.hosts).toHaveLength(1)
  })

  it('does not restore or save a one-time callback URL in a DM strip', async () => {
    const persisted = new Map([['dm_1', { urls: ['https://example.com/callback?code=one-time'], activeIndex: 0 }]])
    const manager = new BrowserManager(
      {} as never, profile() as never, () => {}, undefined, undefined,
      { load: () => persisted, save: () => {} },
    )
    await manager.show({ x: 0, y: 0, width: 800, height: 600 }, 'dm_1', true)
    expect(harness.hosts[0]?.restored?.urls).toEqual(['about:blank'])

    await manager.newTab('dm_1', 'https://example.com/callback?code=second')
    await manager.closeAll()
    expect(persisted.get('dm_1')?.urls).toContain('about:blank')
    expect(persisted.get('dm_1')?.urls).not.toContain('https://example.com/callback?code=second')
  })

  it('never stores an address that carries a filled password', async () => {
    const persisted = new Map<string, { urls: string[]; activeIndex: number }>()
    const passwords = { ...noPagePasswords, redact: <T,>(value: T): T => JSON.parse(JSON.stringify(value).replaceAll('hunter22', '••')) as T }
    const manager = new BrowserManager(
      {} as never, profile() as never, () => {}, undefined, undefined,
      { load: () => persisted, save: () => {} }, undefined, undefined, undefined, passwords,
    )
    await manager.newTab('dm_1', 'https://example.com/signed-in?password=hunter22')
    await manager.closeAll()
    expect(persisted.get('dm_1')?.urls).toEqual(['about:blank'])
  })

  it('keeps earlier pages when repeated requests prepare and navigate fresh active tabs', async () => {
    const manager = new BrowserManager({} as never, profile() as never)
    await manager.newTab('chat', 'https://example.com/first')
    await manager.newTab('chat')
    await manager.navigate('https://example.com/second', 'chat')
    await manager.hide()
    const state = await manager.newTab('chat')
    expect(state.activeTabId).toBe('tab_3')
    expect(state.tabs.map(({ url }) => url)).toEqual([
      'https://example.com/first', 'https://example.com/second', 'about:blank',
    ])
    await manager.closeAll()
  })

  it('clears only the selected browser data without closing tabs', async () => {
    const browserProfile = profile()
    const manager = new BrowserManager({} as never, browserProfile as never)
    await manager.newTab('one')
    await manager.clearCookies()
    expect(browserProfile.clearStorageData).toHaveBeenCalledWith({ storages: ['cookies'] })
    expect(browserProfile.clearCache).not.toHaveBeenCalled()
    await manager.clearCache()
    expect(browserProfile.clearCache).toHaveBeenCalledOnce()
    expect(browserProfile.clearData).not.toHaveBeenCalled()
    expect(harness.hosts[0]?.closed).toBe(false)
    await manager.closeAll()
  })

  it('closes every live chat before clearing the shared browser profile', async () => {
    const browserProfile = profile()
    const history = {
      record: vi.fn(), updateTitle: vi.fn(), search: vi.fn(() => []), replaceImported: vi.fn(),
      clearImported: vi.fn(), clearAll: vi.fn(), recordFavicon: vi.fn(), favicon: vi.fn(),
      addressMatches: vi.fn(() => ({ sites: [], pages: [] })),
    }
    const manager = new BrowserManager(
      {} as never, browserProfile as never, undefined, undefined, undefined, undefined, undefined, history,
    )
    await manager.show({ x: 0, y: 0, width: 800, height: 600 }, 'chat_1')
    await manager.show({ x: 0, y: 0, width: 800, height: 600 }, 'chat_2')

    await manager.clearData()

    expect(harness.hosts).toHaveLength(2)
    expect(harness.hosts.every((host) => host.closed)).toBe(true)
    expect(browserProfile.clearData).toHaveBeenCalledOnce()
    expect(history.clearAll).toHaveBeenCalledOnce()
  })

  it('searches history without opening a browser host', () => {
    const found = [{ url: 'https://example.com/', title: 'Example', visitCount: 1, lastVisitedAt: 1 }]
    const history = {
      record: vi.fn(), updateTitle: vi.fn(), search: vi.fn(() => found), replaceImported: vi.fn(),
      clearImported: vi.fn(), clearAll: vi.fn(), recordFavicon: vi.fn(), favicon: vi.fn(),
      addressMatches: vi.fn(() => ({ sites: [], pages: [] })),
    }
    const manager = new BrowserManager(
      {} as never, profile() as never, undefined, undefined, undefined, undefined, undefined, history,
    )

    expect(manager.history('example')).toBe(found)
    expect(history.search).toHaveBeenCalledWith('example')
    expect(harness.hosts).toHaveLength(0)
  })

  it('waits for an in-flight action before closing hosts for a profile clear', async () => {
    let finishSnapshot!: () => void
    let sawSnapshot!: () => void
    const snapshotStarted = new Promise<void>((resolve) => {
      sawSnapshot = resolve
    })
    harness.snapshot = () =>
      new Promise((resolve) => {
        sawSnapshot()
        finishSnapshot = () =>
          resolve({ url: '', title: '', visibleText: '', interactiveElements: [], console: [] })
      })
    const browserProfile = profile()
    const manager = new BrowserManager({} as never, browserProfile as never)
    await manager.show({ x: 0, y: 0, width: 800, height: 600 }, 'chat_1')

    const action = manager.snapshot('chat_1')
    await snapshotStarted
    const clearing = manager.clearData()
    await Promise.resolve()

    expect(harness.hosts[0]?.closed).toBe(false)
    expect(browserProfile.clearData).not.toHaveBeenCalled()

    finishSnapshot()
    await action
    await clearing

    expect(harness.hosts[0]?.closed).toBe(true)
    expect(browserProfile.clearData).toHaveBeenCalledOnce()
  })

  it('waits for an in-flight action before closing hosts for a profile switch', async () => {
    let finishSnapshot!: () => void
    let sawSnapshot!: () => void
    const snapshotStarted = new Promise<void>((resolve) => {
      sawSnapshot = resolve
    })
    harness.snapshot = () =>
      new Promise((resolve) => {
        sawSnapshot()
        finishSnapshot = () =>
          resolve({ url: '', title: '', visibleText: '', interactiveElements: [], console: [] })
      })
    const manager = new BrowserManager({} as never, profile() as never)
    await manager.show({ x: 0, y: 0, width: 800, height: 600 }, 'chat_1')

    const action = manager.snapshot('chat_1')
    await snapshotStarted
    const closing = manager.closeAll()
    await Promise.resolve()

    expect(harness.hosts[0]?.closed).toBe(false)

    finishSnapshot()
    await action
    await closing

    expect(harness.hosts[0]?.closed).toBe(true)
  })

  it('does not open a new host until the profile clear has finished', async () => {
    let finishClose!: () => void
    let sawClose!: () => void
    const closed = new Promise<void>((resolve) => {
      sawClose = resolve
    })
    harness.close = () => {
      sawClose()
      return new Promise<void>((resolve) => {
        finishClose = resolve
      })
    }
    let finishClear!: () => void
    let sawClear!: () => void
    const profileClearing = new Promise<void>((resolve) => {
      sawClear = resolve
    })
    const browserProfile = profile()
    browserProfile.clearData = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          sawClear()
          finishClear = resolve
        }),
    )
    const manager = new BrowserManager({} as never, browserProfile as never)
    await manager.show({ x: 0, y: 0, width: 800, height: 600 }, 'chat_1')

    const clearing = manager.clearData()
    await closed
    const raced = manager.snapshot('chat_2')
    await Promise.resolve()

    expect(harness.hosts).toHaveLength(1)
    expect(browserProfile.clearData).not.toHaveBeenCalled()

    finishClose()
    await profileClearing
    expect(harness.hosts).toHaveLength(1)

    finishClear()
    await clearing
    await raced

    expect(harness.hosts).toHaveLength(2)
    expect(harness.hosts[1]?.closed).toBe(false)
  })

  it('lets two chats act at the same time', async () => {
    const pending: Array<() => void> = []
    let sawBoth!: () => void
    const bothLocked = new Promise<void>((resolve) => {
      sawBoth = resolve
    })
    harness.snapshot = () =>
      new Promise((resolve) => {
        pending.push(() =>
          resolve({ url: '', title: '', visibleText: '', interactiveElements: [], console: [] }),
        )
        if (pending.length === 2) sawBoth()
      })
    const manager = new BrowserManager({} as never, profile() as never)
    const first = manager.snapshot('chat_1')
    const second = manager.snapshot('chat_2')
    await bothLocked

    expect(harness.hosts).toHaveLength(2)

    for (const finish of pending) finish()
    await Promise.all([first, second])
  })
})

const bounds = { x: 0, y: 0, width: 800, height: 600 }

describe('BrowserManager DM tab memory', () => {
  beforeEach(() => {
    harness.hosts.length = 0
    harness.snapshot = () => Promise.resolve({
      url: '',
      title: '',
      visibleText: '',
      interactiveElements: [],
      console: [],
    })
    harness.close = () => Promise.resolve()
    harness.restore = () => Promise.resolve()
    harness.selectPageContext = () => Promise.resolve(null)
  })

  it.each(['hide', 'switch'] as const)('does not show a late DM restoration after %s', async (next) => {
    let finishRestore = () => {}
    harness.restore = () => new Promise<void>((resolve) => { finishRestore = resolve })
    const memory = {
      load: () => new Map([['dm_1', { urls: ['https://example.com/'], activeIndex: 0 }]]),
      save: () => {},
    }
    const manager = new BrowserManager({} as never, profile() as never, () => {}, undefined, undefined, memory)
    const opening = manager.show(bounds, 'dm_1', true)
    if (next === 'hide') await manager.hide()
    else await manager.show(bounds, 'chat_2')
    finishRestore()
    await opening

    expect(harness.hosts[0]?.visible).toBe(false)
    if (next === 'switch') expect(harness.hosts[1]?.visible).toBe(true)
    await manager.closeAll()
  })

  it('stopping during restoration prevents a late action from recreating the cursor', async () => {
    let finishRestore = () => {}
    harness.restore = () => new Promise<void>((resolve) => { finishRestore = resolve })
    const snapshot = vi.fn(async () => ({}))
    harness.snapshot = snapshot
    const memory = {
      load: () => new Map([['dm_1', { urls: ['https://example.com/'], activeIndex: 0 }]]),
      save: () => {},
    }
    const manager = new BrowserManager({} as never, profile() as never, () => {}, undefined, undefined, memory)
    await manager.endAgentUse('absent')
    expect(harness.hosts).toHaveLength(0)
    const reading = manager.snapshot('dm_1')
    const assertion = expect(reading).rejects.toThrow('Browser agent use stopped.')
    await manager.endAgentUse('dm_1')
    finishRestore()
    await assertion
    expect(snapshot).not.toHaveBeenCalled()
    // The settled, unseen DM browser closed; the next action restores it again.
    harness.restore = () => Promise.resolve()
    await manager.snapshot('dm_1')
    expect(snapshot).toHaveBeenCalledOnce()
    await manager.closeAll()
  })

  it.each([false, true])('shares one deadline with DM restoration (restore completes: %s)', async (completeRestore) => {
    vi.useFakeTimers()
    let finishRestore = () => {}
    harness.restore = () => new Promise<void>((resolve) => { finishRestore = resolve })
    const snapshot = vi.fn(() => new Promise<unknown>(() => {}))
    harness.snapshot = snapshot
    const memory = {
      load: () => new Map([['dm_1', { urls: ['https://example.com/'], activeIndex: 0 }]]),
      save: () => {},
    }
    const manager = new BrowserManager({} as never, profile() as never, () => {}, 60_000, 25, memory)
    const assertion = expect(manager.snapshot('dm_1')).rejects.toThrow('did not finish that action in time')
    await vi.advanceTimersByTimeAsync(20)
    if (completeRestore) finishRestore()
    await vi.advanceTimersByTimeAsync(5)
    await assertion

    expect(harness.hosts).toHaveLength(1)
    expect(harness.hosts[0]?.closed).toBe(true)
    finishRestore()
    await vi.advanceTimersByTimeAsync(0)
    expect(snapshot).toHaveBeenCalledTimes(completeRestore ? 1 : 0)
    vi.useRealTimers()
  })

  it('restores a remembered DM strip after idle teardown', async () => {
    vi.useFakeTimers()
    const persisted = new Map()
    const manager = new BrowserManager(
      {} as never,
      profile() as never,
      () => {},
      25,
      undefined,
      { load: () => persisted, save: () => {} },
    )
    await manager.show(bounds, 'dm_1', true)
    await manager.newTab('dm_1', 'https://mail.google.com/')
    await manager.hide()

    await vi.advanceTimersByTimeAsync(25)
    expect(harness.hosts[0]?.closed).toBe(true)
    expect(persisted.get('dm_1')).toEqual({
      urls: ['https://mail.google.com/'],
      activeIndex: 0,
    })

    await manager.show(bounds, 'dm_1', true)
    expect(harness.hosts[1]?.restored).toEqual({
      urls: ['https://mail.google.com/'],
      activeIndex: 0,
    })
    vi.useRealTimers()
  })

  it('remembers a DM tab list without any panel show', async () => {
    vi.useFakeTimers()
    const persisted = new Map()
    const manager = new BrowserManager(
      {} as never,
      profile() as never,
      () => {},
      25,
      undefined,
      { load: () => persisted, save: () => {} },
    )
    await manager.newTab('dm_1', 'https://mail.google.com/')

    await vi.advanceTimersByTimeAsync(25)
    expect(harness.hosts[0]?.closed).toBe(true)
    expect(persisted.get('dm_1')).toEqual({
      urls: ['https://mail.google.com/'],
      activeIndex: 0,
    })
    vi.useRealTimers()
  })

  it('remembers a project chat strip after idle teardown too', async () => {
    vi.useFakeTimers()
    const persisted = new Map()
    const manager = new BrowserManager(
      {} as never,
      profile() as never,
      () => {},
      25,
      undefined,
      { load: () => persisted, save: () => {} },
    )
    await manager.show(bounds, 'project_1')
    await manager.newTab('project_1', 'https://mail.google.com/')
    await manager.hide()

    await vi.advanceTimersByTimeAsync(25)
    expect(harness.hosts[0]?.closed).toBe(true)
    await manager.show(bounds, 'project_1')
    expect(harness.hosts[1]?.restored).toEqual({ urls: ['https://mail.google.com/'], activeIndex: 0 })
    vi.useRealTimers()
  })

  it('waits while an agent uses a hidden rail browser and closes it when the agent ends', async () => {
    vi.useFakeTimers()
    const lifecycle = { settledMs: 10, tabDiscardMs: 1_000, sweepMs: 1_000 }
    const manager = new BrowserManager({} as never, profile() as never, () => {}, 100,
      undefined, undefined, undefined, undefined, lifecycle)
    manager.beginAgentUse('chat_1')
    await manager.show(bounds, 'chat_1')
    await manager.hide()
    await vi.advanceTimersByTimeAsync(50)
    expect(harness.hosts[0]?.closed).toBe(false)

    await manager.endAgentUse('chat_1')
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.hosts[0]?.closed).toBe(true)
    vi.useRealTimers()
  })

  it('closes a hidden rail browser after the long clock even while an agent still works', async () => {
    vi.useFakeTimers()
    const lifecycle = { settledMs: 10, tabDiscardMs: 1_000, sweepMs: 1_000 }
    const manager = new BrowserManager({} as never, profile() as never, () => {}, 100,
      undefined, undefined, undefined, undefined, lifecycle)
    manager.beginAgentUse('chat_1')
    await manager.show(bounds, 'chat_1')
    await manager.hide()
    await vi.advanceTimersByTimeAsync(99)
    expect(harness.hosts[0]?.closed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(harness.hosts[0]?.closed).toBe(true)
    vi.useRealTimers()
  })

  it('keeps a rail browser that is being opened while the agent ends', async () => {
    vi.useFakeTimers()
    const lifecycle = { settledMs: 10, tabDiscardMs: 1_000, sweepMs: 1_000 }
    const manager = new BrowserManager({} as never, profile() as never, () => {}, 100,
      undefined, undefined, undefined, undefined, lifecycle)
    manager.beginAgentUse('chat_1')
    await manager.show(bounds, 'chat_1')
    await manager.hide()
    const ending = manager.endAgentUse('chat_1')
    const opening = manager.show(bounds, 'chat_1')
    await Promise.all([ending, opening])
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.hosts).toHaveLength(1)
    expect(harness.hosts[0]).toMatchObject({ closed: false, visible: true })
    vi.useRealTimers()
  })

  it('keeps an open or audible rail browser when the agent ends', async () => {
    vi.useFakeTimers()
    const lifecycle = { settledMs: 10, tabDiscardMs: 1_000, sweepMs: 1_000 }
    const manager = new BrowserManager({} as never, profile() as never, () => {}, 100,
      undefined, undefined, undefined, undefined, lifecycle)
    manager.beginAgentUse('chat_1')
    await manager.show(bounds, 'chat_1')
    await manager.endAgentUse('chat_1')
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.hosts[0]?.closed).toBe(false)

    manager.beginAgentUse('chat_1')
    harness.hosts[0]!.audibleNow = true
    await manager.hide()
    await manager.endAgentUse('chat_1')
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.hosts[0]?.closed).toBe(false)
    vi.useRealTimers()
  })

  it('keeps a parked rail page alive while it makes sound', async () => {
    vi.useFakeTimers()
    const lifecycle = { settledMs: 10, tabDiscardMs: 1_000, sweepMs: 1_000 }
    const manager = new BrowserManager({} as never, profile() as never, () => {}, 100,
      undefined, undefined, undefined, undefined, lifecycle)
    await manager.show(bounds, 'chat_1')
    harness.hosts[0]!.audibleNow = true
    await manager.hide()
    await vi.advanceTimersByTimeAsync(30)
    expect(harness.hosts[0]?.closed).toBe(false)

    harness.hosts[0]!.audibleNow = false
    await vi.advanceTimersByTimeAsync(10)
    expect(harness.hosts[0]?.closed).toBe(true)
    vi.useRealTimers()
  })

  it('interrupts a stopped turn\'s input without letting go of tabs another turn still holds', async () => {
    vi.useFakeTimers()
    const lifecycle = { settledMs: 10, tabDiscardMs: 500, sweepMs: 100 }
    const manager = new BrowserManager({} as never, profile() as never, () => {}, 20,
      undefined, undefined, undefined, undefined, lifecycle)
    await manager.show(bounds, 'browser:home')
    await manager.hide()
    manager.beginAgentUse('browser:home')
    // An action already on its way is refused before it reaches the page.
    let finishSelection = () => {}
    const selecting = new Promise<void>((resolve) => { finishSelection = resolve })
    const cancel = vi.spyOn(harness.hosts[0] as unknown as { cancelPageContextSelection(): Promise<void> }, 'cancelPageContextSelection')
      .mockImplementation(() => selecting)
    const snapshot = vi.fn(async () => ({}))
    harness.snapshot = snapshot
    const reading = manager.snapshot('browser:home')
    const refused = expect(reading).rejects.toThrow('Browser agent use stopped.')
    await vi.waitFor(() => expect(cancel).toHaveBeenCalled())
    await manager.interruptAgentInput('browser:home')
    finishSelection()
    await refused
    expect(snapshot).not.toHaveBeenCalled()
    expect(harness.hosts[0]?.interrupted).toBe(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(harness.hosts[0]?.discarded).toEqual([])

    await manager.endAgentUse('browser:home')
    await vi.advanceTimersByTimeAsync(100)
    expect(harness.hosts[0]?.discarded).toEqual([500])
    await manager.closeAll()
    vi.useRealTimers()
  })

  it('never closes the Browser surface as a whole and sweeps its tabs unless an agent uses it', async () => {
    vi.useFakeTimers()
    const lifecycle = { settledMs: 10, tabDiscardMs: 500, sweepMs: 100 }
    const manager = new BrowserManager({} as never, profile() as never, () => {}, 20,
      undefined, undefined, undefined, undefined, lifecycle)
    await manager.show(bounds, 'browser:home')
    await manager.hide()
    await vi.advanceTimersByTimeAsync(100)
    expect(harness.hosts[0]).toMatchObject({ closed: false, discarded: [500] })

    manager.beginAgentUse('browser:home')
    await vi.advanceTimersByTimeAsync(100)
    expect(harness.hosts[0]?.discarded).toEqual([500])
    await manager.closeAll()
    vi.useRealTimers()
  })

  it('forgets a DM strip when the chat is closed', async () => {
    vi.useFakeTimers()
    const persisted = new Map()
    const manager = new BrowserManager(
      {} as never,
      profile() as never,
      () => {},
      25,
      undefined,
      { load: () => persisted, save: () => {} },
    )
    await manager.show(bounds, 'dm_1', true)
    await manager.newTab('dm_1', 'https://mail.google.com/')
    await manager.close('dm_1')
    expect(persisted.size).toBe(0)

    await manager.show(bounds, 'dm_1', true)
    expect(harness.hosts[1]?.restored).toBeUndefined()
    vi.useRealTimers()
  })

  it('keeps remembered DM strips across closeAll and a new manager', async () => {
    const persisted = new Map()
    const memory = { load: () => persisted, save: () => {} }
    const manager = new BrowserManager({} as never, profile() as never, () => {}, undefined, undefined, memory)
    await manager.show(bounds, 'dm_1', true)
    await manager.newTab('dm_1', 'https://mail.google.com/')
    await manager.closeAll()
    expect(harness.hosts[0]?.closed).toBe(true)
    expect(persisted.get('dm_1')).toEqual({
      urls: ['https://mail.google.com/'],
      activeIndex: 0,
    })

    const restored = new BrowserManager({} as never, profile() as never, () => {}, undefined, undefined, memory)
    await restored.show(bounds, 'dm_1', true)
    expect(harness.hosts[1]?.restored).toEqual({
      urls: ['https://mail.google.com/'],
      activeIndex: 0,
    })
  })

  it('saves a pin immediately and restores the Browser strip', async () => {
    const persisted = new Map()
    const memory = { load: () => persisted, save: vi.fn() }
    const manager = new BrowserManager({} as never, profile() as never, () => {}, undefined, undefined, memory)
    await manager.show(bounds, 'browser:home', true)
    await manager.newTab('browser:home', 'https://one.example/')
    const second = await manager.newTab('browser:home', 'https://two.example/')
    const pinned = await manager.pinTab(second.activeTabId!, 'browser:home', true)

    expect(pinned.tabs.map((tab) => [tab.url, tab.pinned])).toEqual([
      ['https://two.example/', true], ['https://one.example/', undefined],
    ])
    expect(persisted.get('browser:home')).toEqual({
      urls: ['https://two.example/', 'https://one.example/'], activeIndex: 0, pinnedCount: 1,
    })
    expect(memory.save).toHaveBeenCalled()

    await manager.closeAll()
    const reopened = new BrowserManager({} as never, profile() as never, () => {}, undefined, undefined, memory)
    await reopened.show(bounds, 'browser:home', true)
    expect(harness.hosts[1]?.restored).toEqual({
      urls: ['https://two.example/', 'https://one.example/'], activeIndex: 0, pinnedCount: 1,
    })
  })

  it('forgets every remembered strip when clearing the profile', async () => {
    const persisted = new Map()
    const manager = new BrowserManager(
      {} as never,
      profile() as never,
      () => {},
      undefined,
      undefined,
      { load: () => persisted, save: () => {} },
    )
    await manager.show(bounds, 'dm_1', true)
    await manager.newTab('dm_1', 'https://mail.google.com/')
    await manager.clearData()
    expect(persisted.size).toBe(0)

    await manager.show(bounds, 'dm_1', true)
    expect(harness.hosts[1]?.restored).toBeUndefined()
  })
})


describe('BrowserManager preview ownership', () => {
  beforeEach(() => { harness.capturePage.mockClear(); harness.hosts.length = 0 })


  it('sends no frame of a page that took a secret, also when the fill lands during the capture', async () => {
    let sealed = true
    const updates = vi.fn()
    const passwords = { ...noPagePasswords, sealed: () => sealed }
    const manager = new BrowserManager({} as never, profile() as never, () => {}, 25, undefined, undefined, updates, undefined, undefined, passwords)
    await manager.newTab('chat', 'https://example.com/')

    await manager.startPreview('chat', 'first', 'manual')
    expect(harness.capturePage).not.toHaveBeenCalled()
    expect(updates).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'unavailable' }))
    await manager.stopPreview('first')

    sealed = false
    harness.capturePage.mockImplementationOnce(async () => {
      sealed = true
      return { isEmpty: () => false, getSize: () => ({ width: 900, height: 600 }), toJPEG: () => Buffer.from('frame') }
    })
    await manager.startPreview('chat', 'second', 'manual')
    expect(updates).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'frame' }))
    await manager.closeAll()
  })

  it('keeps a manual floating preview alive after agent completion and idle time', async () => {
    vi.useFakeTimers()
    try {
      const updates = vi.fn()
      const manager = new BrowserManager({} as never, profile() as never, () => {}, 25, undefined, undefined, updates)
      await manager.newTab('chat', 'https://example.com/')
      await manager.startPreview('chat', 'manual', 'manual')
      await manager.endAgentUse('chat')
      await vi.advanceTimersByTimeAsync(50)
      expect(updates).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'stopped' }))
      expect(harness.hosts[0]!.closed).toBe(false)
      await manager.stopPreview('manual')
      expect(updates).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'stopped', subscriptionId: 'manual' }))
      await manager.closeAll()
    } finally { vi.useRealTimers() }
  })

  it('waits for the real tab, follows active-tab changes, and rejects stale cleanup', async () => {
    const updates = vi.fn()
    const manager = new BrowserManager({} as never, profile() as never, () => {}, undefined, undefined, undefined, updates)
    await manager.startPreview('chat', 'first')
    expect(harness.hosts).toHaveLength(0)
    await manager.newTab('chat', 'https://example.com/')
    await vi.waitFor(() => expect(updates).toHaveBeenCalledWith(expect.objectContaining({ status: 'frame', subscriptionId: 'first' })))
    await manager.startPreview('chat', 'second')
    updates.mockClear()
    await manager.stopPreview('first')
    expect(updates).not.toHaveBeenCalled()
    await manager.newTab('chat', 'https://example.com/next')
    await vi.waitFor(() => expect(updates).toHaveBeenCalledWith(expect.objectContaining({ status: 'frame', subscriptionId: 'second', tabId: 'tab_2' })))
    await manager.endAgentUse('different-chat')
    expect(updates).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'stopped' }))
    await manager.endAgentUse('chat')
    expect(updates.mock.calls.at(-2)?.[0]).toMatchObject({ status: 'frame', tabId: 'tab_2' })
    expect(updates).toHaveBeenLastCalledWith({ chatId: 'chat', subscriptionId: 'second', status: 'stopped' })
    await manager.closeAll()
  })

  it('cleans up a subscription even if the agent ends before a tab exists', async () => {
    const updates = vi.fn()
    const manager = new BrowserManager({} as never, profile() as never, () => {}, undefined, undefined, undefined, updates)
    await manager.startPreview('chat', 'early')
    await manager.endAgentUse('chat')
    await manager.newTab('chat', 'https://example.com/')
    expect(harness.capturePage).not.toHaveBeenCalled()
    expect(updates).toHaveBeenLastCalledWith({ chatId: 'chat', subscriptionId: 'early', status: 'stopped' })
    await manager.closeAll()
  })
})
