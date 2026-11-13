import { beforeEach, describe, expect, it, vi } from 'vitest'

const tabHarness = vi.hoisted(() => ({
  instances: [] as Array<{
    id: string
    navigatedTo: string[]
    finishNavigate: (() => void) | undefined
    failNavigate: (() => void) | undefined
    viewsEnsured: number
    restoreUrl(url: string): void
    discarded: number
    audibleNow: boolean
    findsStopped: number
    viewport: { width: number; height: number } | null
    setBounds(bounds: { x: number; y: number; width: number; height: number }): Promise<void>
  }>,
  cancel: () => Promise.resolve() as Promise<void>,
}))

vi.mock('./browserWebviews', () => ({ BrowserWebviews: class { destroy() {} } }))

vi.mock('electron', () => {
  class View {
    visible = true
    bounds = { x: 0, y: 0, width: 800, height: 600 }
    webContents = { loadURL: vi.fn(), close: vi.fn(), setBackgroundThrottling: vi.fn(),
      capturePage: vi.fn(async () => ({ isEmpty: () => false, toDataURL: () => 'data:image/png;base64,fixture' })),
    }
    setVisible(visible: boolean) { this.visible = visible }
    setBounds(bounds: typeof this.bounds) { this.bounds = bounds }
    getBounds() { return this.bounds }
  }
  class ContentView {
    children: View[] = []
    addChildView(view: View) {
      if (!this.children.includes(view)) this.children.push(view)
    }
    removeChildView(view: View) {
      const index = this.children.indexOf(view)
      if (index === -1) throw new Error('not a child')
      this.children.splice(index, 1)
    }
  }
  class BrowserWindow {
    id = 1
    contentView = new ContentView()
    webContents = { focus: vi.fn(), getZoomFactor: () => 1 }
    getContentSize() { return [1280, 800] }
    setContentSize() {}
    destroy() {}
  }
  return {
    BrowserWindow,
    WebContentsView: View,
    session: {
      fromPartition: () => ({
        setPermissionCheckHandler() {},
        setPermissionRequestHandler() {},
        clearStorageData: () => Promise.resolve(),
      }),
    },
  }
})

vi.mock('./browserTab', async () => {
  const { WebContentsView } = await import('electron')
  return {
    BrowserTab: class {
      private readonly view = new WebContentsView()
      private restoredUrl: string | null = null
      navigatedTo: string[] = []
      finishNavigate: (() => void) | undefined
      failNavigate: (() => void) | undefined
      viewsEnsured = 0
      viewport: { width: number; height: number } | null = null
      constructor(readonly id: string) {
        tabHarness.instances.push(this)
      }
      state() {
        return {
          id: this.id,
          title: 'New tab',
          url: this.restoredUrl ?? this.navigatedTo.at(-1) ?? 'about:blank',
          loading: false,
          canGoBack: false,
          canGoForward: false,
          settings: { viewport: this.viewport, appearance: 'system', zoomFactor: 1 },
        }
      }
      restoreUrl(url: string) { this.restoredUrl = url === '' ? 'about:blank' : url }
      ensureView() {
        this.viewsEnsured += 1
        return Promise.resolve(this.view)
      }
      loadRestoredUrl() {
        const url = this.restoredUrl
        if (url === null) return Promise.resolve()
        if (url === 'about:blank') {
          this.restoredUrl = null
          return Promise.resolve()
        }
        return this.navigate(url).then(() => undefined)
      }
      peek() { return this.view }
      async setBounds(bounds: { x: number; y: number; width: number; height: number }) {
        await this.ensureView()
        this.view.setBounds(bounds)
      }
      navigate(url: string) {
        this.navigatedTo.push(url)
        return new Promise<{ url: string; title: string }>((resolve, reject) => {
          this.finishNavigate = () => { this.restoredUrl = null; resolve({ url, title: '' }) }
          this.failNavigate = () => reject(new Error('Browser action interrupted by human input.'))
        })
      }
      snapshot() { return Promise.resolve({ url: this.state().url }) }
      cancelPageContextSelection() { return tabHarness.cancel() }
      discarded = 0
      audibleNow = false
      audible() { return this.audibleNow }
      discard() { this.discarded += 1; return true }
      endAgentUse() { return Promise.resolve() }
      findsStopped = 0
      stopFind() { this.findsStopped += 1 }
      close() {}
    },
  }
})

import { BrowserWindow } from 'electron'
import { BrowserHost } from './browserHost'

const browserSession = () => ({
  clearData: vi.fn(async () => {}),
  clearStorageData: vi.fn(async () => {}),
})

describe('BrowserHost bounds', () => {
  it('starts the incoming layout while the outgoing page is still settling', async () => {
    const host = new BrowserHost(new BrowserWindow(), browserSession() as never)
    await host.newTab()
    await host.newTab()
    const [incoming, outgoing] = tabHarness.instances.slice(-2)
    let finish = () => {}
    const parked = new Promise<void>((resolve) => { finish = resolve })
    vi.spyOn(outgoing!, 'setBounds').mockImplementationOnce(() => parked)
    const arriving = vi.spyOn(incoming!, 'setBounds')
    const switching = host.select(incoming!.id)
    try {
      await vi.waitFor(() => expect(arriving).toHaveBeenCalled())
    } finally { finish() }
    await switching
    expect(host.state().activeTabId).toBe(incoming!.id)
  })

  it('scales the measured CSS rectangle by the shell zoom factor', async () => {
    const window = new BrowserWindow()
    ;(window.webContents as { getZoomFactor: () => number }).getZoomFactor = () => 1.0954
    const host = new BrowserHost(window, browserSession() as never)
    await host.setVisible(true)
    const applied = await host.setBounds({ x: 100, y: 50, width: 400, height: 600 })
    expect(applied).toEqual({ x: 110, y: 55, width: 438, height: 657 })
    await host.newTab()
    const view = (await (tabHarness.instances.at(-1) as unknown as { ensureView(): Promise<unknown> }).ensureView()) as {
      bounds: { x: number; y: number; width: number; height: number }
    }
    expect(view.bounds).toEqual({ x: 110, y: 55, width: 438, height: 657 })
    await host.setVisible(false)
    expect(view.bounds).toEqual({ x: 0, y: 0, width: 438, height: 657 })
    // A late sidebar measurement must not resize the hidden preview.
    await host.setBounds({ x: 100, y: 50, width: 400, height: 600 })
    expect(view.bounds).toEqual({ x: 0, y: 0, width: 438, height: 657 })
    await host.setVisible(true)
    expect(view.bounds).toEqual({ x: 110, y: 55, width: 438, height: 657 })
  })

  it.each(['floating', 'responsive'] as const)('keeps the default parked stage for %s pages', async (mode) => {
    const host = new BrowserHost(new BrowserWindow(), browserSession() as never)
    await host.setVisible(true)
    await host.setBounds({ x: 20, y: 30, width: 320, height: 180 }, mode === 'floating' ? 'floating' : 'sidebar')
    await host.newTab()
    const tab = tabHarness.instances.at(-1)!
    if (mode === 'responsive') tab.viewport = { width: 390, height: 844 }
    const layout = vi.spyOn(tab, 'setBounds')
    await host.setVisible(false)
    expect(layout).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 1280, height: 720 }, 'hidden')
  })
})

describe('BrowserHost storage lifecycle', () => {
  it('closes one chat without clearing Manor’s shared login profile', async () => {
    const profile = browserSession()
    const host = new BrowserHost(new BrowserWindow(), profile as never)
    await host.newTab()

    await host.close()

    expect(profile.clearData).not.toHaveBeenCalled()
    expect(profile.clearStorageData).not.toHaveBeenCalled()
  })
})

describe('BrowserHost restore', () => {
  beforeEach(() => {
    tabHarness.instances.length = 0
    tabHarness.cancel = () => Promise.resolve()
  })

  it('does not recreate views or continue restoring after the host closes', async () => {
    const host = new BrowserHost(new BrowserWindow(), browserSession() as never)
    const restoring = host.restoreTabs(['https://example.com/first', 'https://example.com/second'], 1)
    await vi.waitFor(() => expect(tabHarness.instances[1]?.navigatedTo).toEqual(['https://example.com/second']))
    const ensuredBeforeClose = tabHarness.instances.map((tab) => tab.viewsEnsured)
    await host.close()
    tabHarness.instances[1]?.finishNavigate?.()
    await restoring

    expect(tabHarness.instances.map((tab) => tab.viewsEnsured)).toEqual(ensuredBeforeClose)
    expect(tabHarness.instances[0]?.navigatedTo).toEqual([])
    expect(host.state().tabs).toEqual([])
    await expect(host.newTab()).rejects.toThrow('host is closed')
  })

  it('loads only the active tab, then loads a restored tab when selected for agent use', async () => {
    const host = new BrowserHost(new BrowserWindow(), browserSession() as never)
    const restoring = host.restoreTabs(
      ['https://mail.google.com/', 'https://calendar.google.com/'],
      1,
      1,
    )
    await vi.waitFor(() => expect(tabHarness.instances[1]?.navigatedTo).toEqual(['https://calendar.google.com/']))
    expect(tabHarness.instances.map((tab) => tab.navigatedTo)).toEqual([
      [],
      ['https://calendar.google.com/'],
    ])
    expect(tabHarness.instances[0]?.viewsEnsured).toBe(0)
    expect(host.state().tabs.map((tab) => tab.pinned)).toEqual([true, undefined])
    expect(host.state().tabs.map((tab) => tab.url)).toEqual([
      'https://mail.google.com/', 'https://calendar.google.com/',
    ])

    tabHarness.instances[1]?.finishNavigate?.()
    await restoring

    expect(host.state().activeTabId).toBe(tabHarness.instances[1]?.id)
    const selecting = host.select(tabHarness.instances[0]!.id)
    await vi.waitFor(() => expect(tabHarness.instances[0]?.navigatedTo).toEqual(['https://mail.google.com/']))
    tabHarness.instances[0]?.finishNavigate?.()
    await selecting
    expect(host.state().activeTabId).toBe(tabHarness.instances[0]?.id)
    expect(host.state().tabs[0]?.pinned).toBe(true)
    expect((await host.snapshot()).url).toBe('https://mail.google.com/')
  })

  it('retries the restored page when its first navigation is interrupted', async () => {
    const url = 'https://example.com/restored'
    const host = new BrowserHost(new BrowserWindow(), browserSession() as never)
    const restoring = host.restoreTabs([url], 0)
    await vi.waitFor(() => expect(tabHarness.instances[0]?.navigatedTo).toEqual([url]))
    tabHarness.instances[0]?.failNavigate?.()
    await restoring

    expect(host.state().tabs[0]?.url).toBe(url)
    const selecting = host.select(tabHarness.instances[0]!.id)
    await vi.waitFor(() => expect(tabHarness.instances[0]?.navigatedTo).toEqual([url, url]))
    tabHarness.instances[0]?.finishNavigate?.()
    await selecting
    expect((await host.snapshot()).url).toBe(url)
  })
})

describe('BrowserHost pins', () => {
  it('keeps pinned tabs at the left and restores their order and active tab', async () => {
    const host = new BrowserHost(new BrowserWindow(), browserSession() as never)
    await host.newTab()
    const first = host.state().activeTabId!
    await host.newTab()
    const second = host.state().activeTabId!
    await host.newTab()
    const third = host.state().activeTabId!

    host.pinTab(third, true)
    host.pinTab(first, true)
    expect(host.state().tabs.map(({ id, pinned }) => [id, pinned])).toEqual([
      [third, true], [first, true], [second, undefined],
    ])
    expect(host.state().activeTabId).toBe(third)

    const restored = new BrowserHost(new BrowserWindow(), browserSession() as never)
    const beforeRestore = tabHarness.instances.length
    await restored.restoreTabs(['about:blank', 'about:blank', 'about:blank'], 0, 2)
    expect(restored.state().tabs.map((tab) => tab.pinned)).toEqual([true, true, undefined])
    expect(restored.state().activeTabId).toBe(restored.state().tabs[0]?.id)
    expect(tabHarness.instances.slice(beforeRestore).map((tab) => tab.viewsEnsured)).toEqual([1, 0, 0])

    host.pinTab(third, false)
    expect(host.state().tabs.map(({ id, pinned }) => [id, pinned])).toEqual([
      [first, true], [third, undefined], [second, undefined],
    ])
  })

  it('moves a dragged tab within its own group only', async () => {
    const host = new BrowserHost(new BrowserWindow(), browserSession() as never)
    const ids: string[] = []
    for (let i = 0; i < 4; i += 1) { await host.newTab(); ids.push(host.state().activeTabId!) }
    const [a, b, c, d] = ids as [string, string, string, string]
    host.pinTab(a, true)
    const order = () => host.state().tabs.map((tab) => tab.id)

    host.moveTab(d, 1)
    expect(order()).toEqual([a, d, b, c])
    host.moveTab(d, 0)
    expect(order()).toEqual([a, d, b, c])
    host.moveTab(a, 3)
    expect(order()).toEqual([a, d, b, c])
    host.moveTab(b, 9)
    expect(order()).toEqual([a, d, c, b])
    expect(host.state().activeTabId).toBe(d)
    expect(() => host.moveTab('gone', 0)).toThrow('That browser tab is not open.')
  })
})

describe('BrowserHost tab discard', () => {
  it('drops unseen pages but keeps pinned, audible and on-screen tabs live', async () => {
    const host = new BrowserHost(new BrowserWindow(), browserSession() as never)
    const start = tabHarness.instances.length
    for (let index = 0; index < 4; index += 1) await host.newTab()
    const [pinned, audible, parked, active] = tabHarness.instances.slice(start)
    host.pinTab(pinned!.id, true)
    audible!.audibleNow = true
    await host.setVisible(true)

    host.discardUnseen(100, 0)
    host.discardUnseen(100, 99)
    expect(parked!.discarded).toBe(0)
    host.discardUnseen(100, 100)
    expect([pinned, audible, parked, active].map((tab) => tab!.discarded)).toEqual([0, 0, 1, 0])

    await host.setVisible(false)
    host.discardUnseen(100, 250)
    host.discardUnseen(100, 349)
    expect(active!.discarded).toBe(0)
    host.discardUnseen(100, 350)
    expect(active!.discarded).toBe(1)
  })

  it('restarts the unseen clock when a tab is shown between sweeps', async () => {
    const host = new BrowserHost(new BrowserWindow(), browserSession() as never)
    const start = tabHarness.instances.length
    await host.newTab()
    await host.newTab()
    const [old, current] = tabHarness.instances.slice(start)
    await host.setVisible(true)
    host.discardUnseen(100, 0)

    await host.select(old!.id)
    await host.select(current!.id)
    host.discardUnseen(100, 150)
    host.discardUnseen(100, 249)
    expect(old!.discarded).toBe(0)
    host.discardUnseen(100, 250)
    expect(old!.discarded).toBe(1)
  })
  it('restarts every unseen clock when an agent settles', async () => {
    const host = new BrowserHost(new BrowserWindow(), browserSession() as never)
    const start = tabHarness.instances.length
    await host.newTab()
    await host.newTab()
    const [parked] = tabHarness.instances.slice(start)
    host.discardUnseen(100, 0)

    // The manager skips sweeps while an agent works; the tab went unseen far past the limit.
    await host.endAgentUse()
    host.discardUnseen(100, 500)
    host.discardUnseen(100, 599)
    expect(parked!.discarded).toBe(0)
    host.discardUnseen(100, 600)
    expect(parked!.discarded).toBe(1)
  })
})

describe('BrowserHost close', () => {
  beforeEach(() => {
    tabHarness.instances.length = 0
    tabHarness.cancel = () => Promise.resolve()
  })

  it('returns to the tab that was on screen before the closed one', async () => {
    const host = new BrowserHost(new BrowserWindow(), browserSession() as never)
    await host.newTab()
    await host.newTab()
    await host.newTab()
    const [first, second, third] = host.state().tabs.map((tab) => tab.id)
    await host.select(first!)
    await host.select(second!)
    await host.closeTab(second!)
    expect(host.state().activeTabId).toBe(first)
    await host.closeTab(first!)
    expect(host.state().activeTabId).toBe(third)
  })

  it('stops find in the tab being left, not the one coming in', async () => {
    const host = new BrowserHost(new BrowserWindow(), browserSession() as never)
    await host.newTab()
    await host.newTab()
    const [first, second] = tabHarness.instances
    const before = [first!.findsStopped, second!.findsStopped]
    await host.select(first!.id)
    expect([first!.findsStopped, second!.findsStopped]).toEqual([before[0], before[1]! + 1])
  })

  it('keeps a closed page to reopen when a full strip refused it', async () => {
    const host = new BrowserHost(new BrowserWindow(), browserSession() as never)
    await host.restoreTabs(['https://kept.example/', ...Array.from({ length: 49 }, () => '')], 1)
    await host.closeTab(tabHarness.instances[0]!.id)
    await host.newTab()
    await expect(host.reopenClosedTab()).rejects.toThrow('50 tabs')
    await host.closeTab(host.state().activeTabId!)
    void host.reopenClosedTab()
    await vi.waitFor(() => expect(tabHarness.instances.at(-1)?.navigatedTo).toEqual(['https://kept.example/']))
  })
})

describe('BrowserHost popups', () => {
  beforeEach(() => {
    tabHarness.instances.length = 0
    tabHarness.cancel = () => Promise.resolve()
  })

  it('opens a popup behind the active tab and marks it new until it is selected', async () => {
    const host = new BrowserHost(new BrowserWindow(), browserSession() as never)
    await host.newTab()
    const current = host.state().activeTabId
    const opening = host.openInBackground('https://accounts.example.com/login')
    await vi.waitFor(() => expect(tabHarness.instances[1]?.navigatedTo).toEqual(['https://accounts.example.com/login']))
    tabHarness.instances[1]?.finishNavigate?.()
    await opening

    const popup = tabHarness.instances[1]?.id ?? ''
    expect(host.state().activeTabId).toBe(current)
    expect(host.state().tabs.map((tab) => tab.unseen)).toEqual([undefined, true])
    await host.select(popup)
    expect(host.state().tabs.map((tab) => tab.unseen)).toEqual([undefined, undefined])
  })
})
