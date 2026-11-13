import { EventEmitter } from 'node:events'
import { runInNewContext } from 'node:vm'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    webContents: { getFocusedWebContents: () => null },
    WebContentsView: class {
      webContents = Object.assign(new EventEmitter(), {
        loadURL: async () => {}, setWindowOpenHandler: () => {}, isDestroyed: () => false,
        getURL: () => 'https://example.com/', getTitle: () => 'Example',
        navigationHistory: { canGoBack: () => false, canGoForward: () => false },
        executeJavaScript: vi.fn(async () => undefined),
        focus: vi.fn(), close: () => {}, getZoomFactor: () => 1, setZoomFactor: vi.fn(),
        enableDeviceEmulation: vi.fn(), disableDeviceEmulation: vi.fn(),
        reloadIgnoringCache: vi.fn(), openDevTools: vi.fn(),
        debugger: Object.assign(new EventEmitter(), {
          attach: () => {}, detach: () => {}, isAttached: () => true,
          sendCommand: vi.fn(async () => ({})),
        }),
      })
      async focusForKeyboard() { return async () => {} }
      magnify = vi.fn()
      overlay = vi.fn()
      setVisible() {}
      async present(bounds: typeof this.bounds) { this.bounds = bounds }
      close() {}
      bounds = { x: 0, y: 0, width: 800, height: 600 }
      getBounds() { return this.bounds }
      setBounds(bounds: typeof this.bounds) { this.bounds = bounds }
    },
  }
})

import { WebContentsView } from 'electron'
import type { BrowserPageView } from './browserWebviews'
import { BrowserTab } from './browserTab'
import { withBrowserInput, withBrowserLayout } from './browserInputAction'
import { noPageAdblock } from './browserAdblock'
import { noPagePasswords } from './browserPasswordAutofill'

describe('BrowserTab page context on a delivered page', () => {
  it('picks inside the page frame and names the address the user opened', async () => {
    const view = new WebContentsView() as unknown as BrowserPageView
    const address = 'http://127.0.0.1:43179/media/chat/e1?view=1&theme=dark'
    vi.spyOn(view.webContents, 'getURL').mockImplementation(() => address)
    vi.spyOn(view.webContents, 'getTitle').mockImplementation(() => 'usage.html')
    const send = vi.mocked(view.webContents.debugger.sendCommand)
    send.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'top' }, childFrames: [{ frame: { id: 'page' } }] } }
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 }
      if (method !== 'Runtime.evaluate') return {}
      if (String(params?.expression).includes('manor-view')) return { result: { value: true } }
      return { result: { value: { kind: 'element', url: 'about:srcdoc', title: '', label: 'Tue bar', text: '92%', html: '<i></i>' } } }
    })
    const tab = new BrowserTab('one', {} as never, () => {}, () => {}, async () => view)

    const picked = await tab.selectPageContext()

    expect(send).toHaveBeenCalledWith('Page.createIsolatedWorld', { frameId: 'page', worldName: 'manor-page-context' })
    const pick = send.mock.calls.find(([method, params]) => method === 'Runtime.evaluate' && !String(params?.expression).includes('manor-view'))
    expect(pick?.[1]).toMatchObject({ contextId: 7 })
    expect(picked).toMatchObject({ kind: 'element', url: address, title: 'usage.html', label: 'Tue bar' })
    tab.close()
  })
})

describe('BrowserTab guest recovery', () => {
  const createTab = () => new BrowserTab('one', {} as never, () => {}, () => {}, async () => {
    const view = new WebContentsView() as unknown as BrowserPageView
    view.close = vi.fn(() => { view.webContents.emit('destroyed') })
    return view
  })

  it('keeps a restored URL lazy and retries after interrupted navigation', async () => {
    const view = new WebContentsView() as unknown as BrowserPageView
    const load = vi.spyOn(view.webContents, 'loadURL')
    const tab = new BrowserTab('one', {} as never, () => {}, () => {}, async () => view)
    tab.restoreUrl('https://example.com/restored')

    expect(tab.peek()).toBeNull()
    expect(tab.state().url).toBe('https://example.com/restored')
    expect(load).not.toHaveBeenCalled()
    await tab.ensureView()
    expect(load).toHaveBeenCalledOnce()
    expect(load).toHaveBeenCalledWith('about:blank')
    const send = vi.mocked(view.webContents.debugger.sendCommand)
    let navigations = 0
    send.mockImplementation(async (method: string) => {
      if (method === 'Page.navigate') {
        navigations += 1
        if (navigations === 1) {
          queueMicrotask(() => view.webContents.emit('before-input-event', {}, { type: 'keyDown', key: 'x' }))
        } else {
          queueMicrotask(() => view.webContents.emit('did-finish-load'))
        }
      }
      return {}
    })
    await expect(tab.loadRestoredUrl()).rejects.toThrow('interrupted by human input')
    expect(tab.state().url).toBe('https://example.com/restored')
    await tab.loadRestoredUrl()
    expect(send.mock.calls.filter(([method]) => method === 'Page.navigate')).toEqual([
      ['Page.navigate', { url: 'https://example.com/restored' }],
      ['Page.navigate', { url: 'https://example.com/restored' }],
    ])
    tab.close()
  })

  it('replaces a failed restore URL after a successful address navigation', async () => {
    const restoredUrl = 'https://example.com/old'
    const newUrl = 'https://example.com/new'
    const view = new WebContentsView() as unknown as BrowserPageView
    let currentUrl = 'about:blank'
    vi.spyOn(view.webContents, 'getURL').mockImplementation(() => currentUrl)
    const tab = new BrowserTab('one', {} as never, () => {}, () => {}, async () => view)
    tab.restoreUrl(restoredUrl)
    const send = vi.mocked(view.webContents.debugger.sendCommand)
    send.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method !== 'Page.navigate') return {}
      if (params?.url === restoredUrl) return { errorText: 'net::ERR_ABORTED' }
      currentUrl = String(params?.url)
      queueMicrotask(() => view.webContents.emit('did-finish-load'))
      return {}
    })

    await expect(tab.loadRestoredUrl()).rejects.toThrow('Browser navigation failed')
    expect(tab.state().url).toBe(restoredUrl)
    await tab.navigate(newUrl)
    expect(tab.state().url).toBe(newUrl)
    await tab.loadRestoredUrl()
    expect(send.mock.calls.filter(([method]) => method === 'Page.navigate')).toEqual([
      ['Page.navigate', { url: restoredUrl }],
      ['Page.navigate', { url: newUrl }],
    ])
    tab.close()
  })

  it.each(['clean-exit', 'killed'])('recreates %s guests without consuming crash recoveries', async (reason) => {
    const tab = createTab()
    for (let exit = 0; exit < 4; exit += 1) {
      const view = await tab.ensureView()
      view.webContents.emit('render-process-gone', {}, { reason })
      expect(view.close).toHaveBeenCalledOnce()
      expect((await tab.ensureView()).webContents).not.toBe(view.webContents)
    }
    tab.close()
  })

  it.each(['crashed', 'oom'])('limits recovery of %s guests even across a normal exit', async (reason) => {
    const tab = createTab()
    for (const exitReason of [reason, 'clean-exit', reason, reason]) {
      const view = await tab.ensureView()
      view.webContents.emit('render-process-gone', {}, { reason: exitReason })
      expect(view.close).toHaveBeenCalledOnce()
    }
    await expect(tab.ensureView()).rejects.toThrow('This browser page repeatedly crashed')
    tab.close()
  })

  it('reports committed visits and their later titles to persistent history', async () => {
    const visit = vi.fn()
    const title = vi.fn()
    const tab = new BrowserTab('one', {} as never, () => {}, () => {}, async () =>
      new WebContentsView() as unknown as BrowserPageView, visit, title)
    const contents = (await tab.ensureView()).webContents

    contents.emit('did-navigate', {}, 'https://example.com/')
    contents.emit('did-navigate-in-page', {}, 'https://embedded.example/#state', false)
    contents.emit('did-navigate-in-page', {}, 'https://example.com/#section', true)
    contents.emit('page-title-updated', {}, 'Example title')

    expect(visit).toHaveBeenCalledWith('https://example.com/', '')
    expect(visit).not.toHaveBeenCalledWith('https://embedded.example/#state', expect.anything())
    expect(visit).toHaveBeenCalledWith('https://example.com/#section', 'Example')
    expect(title).toHaveBeenCalledWith('https://example.com/', 'Example title')
    tab.close()
  })
})

class Element {
  disabled = false
  inert = false
  rect = { left: 10, right: 110, top: 20, bottom: 60 }
  matches() { return this.disabled }
  closest() { return this.inert }
  scrollIntoView() {}
  getBoundingClientRect() { return this.rect }
  contains(other: unknown) { return other === this }
}

describe('BrowserTab agent input', () => {
  let tab: BrowserTab
  let contents: Electron.WebContents
  let element: Element
  let matches: Element[]
  let hit: Element | null
  let style: { visibility: string; display: string }
  let send: Mock<(method: string, params?: Record<string, unknown>) => Promise<unknown>>

  it('returns the focused selector with the page snapshot for keypress review', async () => {
    send.mockResolvedValueOnce({ result: { value: {
      visibleText: 'Search', focusedSelector: '#search', interactiveElements: [],
    } } })
    await expect(tab.snapshot()).resolves.toMatchObject({ focusedSelector: '#search', visibleText: 'Search' })
    expect(send).toHaveBeenCalledWith('Runtime.evaluate', expect.objectContaining({
      expression: expect.stringContaining('document.activeElement'),
    }))
  })

  beforeEach(async () => {
    vi.useFakeTimers()
    tab = new BrowserTab('one', {} as never, () => {}, () => {}, async () => new WebContentsView() as unknown as BrowserPageView)
    contents = (await tab.ensureView()).webContents
    element = new Element()
    matches = [element]
    hit = element
    style = { visibility: 'visible', display: 'block' }
    send = vi.mocked(contents.debugger.sendCommand)
    send.mockClear()
    send.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame-1' } } }
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 17 }
      if (method === 'Runtime.evaluate' && params?.contextId === 17) return {}
      if (method === 'Runtime.evaluate') {
        const value: unknown = runInNewContext(String(params?.expression), {
          document: { querySelectorAll: () => matches, elementFromPoint: () => hit },
          HTMLElement: Element, getComputedStyle: () => style, innerWidth: 800, innerHeight: 600,
        })
        return { result: { value } }
      }
      if (method === 'Input.dispatchMouseEvent') {
        contents.emit('before-mouse-event', {}, {
          type: params?.type === 'mousePressed' ? 'mouseDown' : 'mouseUp',
          button: 'left', x: Number(params?.x) * contents.getZoomFactor(), y: Number(params?.y) * contents.getZoomFactor(),
        })
      }
      if (method === 'Input.dispatchKeyEvent') {
        contents.emit('before-input-event', {}, { type: params?.type === 'rawKeyDown' ? 'keyDown' : params?.type, key: params?.key })
      }
      return {}
    })
  })

  afterEach(async () => { await tab.endAgentUse(); vi.useRealTimers() })

  const humanKey = (contents: EventEmitter) => contents.emit('before-input-event', {}, { type: 'keyDown', key: 'x' })

  it.each([false, true])('defers viewport resize until input settles (failure: %s)', async (fail) => {
    const view = await tab.ensureView()
    let release = () => {}
    const held = new Promise<void>((resolve) => { release = resolve })
    const action = withBrowserInput(contents, async () => {
      await held
      if (fail) throw new Error('Input failed')
    })
    const result = fail ? expect(action).rejects.toThrow('Input failed') : expect(action).resolves.toBeUndefined()
    const resizing = tab.setBounds({ x: 0, y: 0, width: 1280, height: 720 })
    await Promise.resolve()
    expect(view.getBounds().width).toBe(800)
    release()
    await Promise.all([result, resizing])
    expect(view.getBounds()).toEqual({ x: 0, y: 0, width: 1280, height: 720 })
  })

  it('fits a responsive viewport, rotates it and restores natural bounds', async () => {
    const view = await tab.ensureView()
    await tab.setBounds({ x: 100, y: 20, width: 500, height: 600 })
    await tab.configure({ viewport: { width: 390, height: 844 } })
    expect(contents.enableDeviceEmulation).toHaveBeenLastCalledWith(expect.objectContaining({
      viewSize: { width: 390, height: 844 }, scale: 600 / 844,
    }))
    expect(view.getBounds()).toEqual({ x: 211, y: 20, width: 277, height: 600 })
    await tab.configure({ viewport: { width: 844, height: 390 } })
    expect(contents.enableDeviceEmulation).toHaveBeenLastCalledWith(expect.objectContaining({
      viewSize: { width: 844, height: 390 }, scale: 500 / 844,
    }))
    expect(view.getBounds()).toEqual({ x: 100, y: 204, width: 500, height: 231 })
    await tab.configure({ viewport: null })
    expect(contents.disableDeviceEmulation).toHaveBeenCalled()
    expect(view.getBounds()).toEqual({ x: 100, y: 20, width: 500, height: 600 })
    expect(tab.state().settings?.viewport).toBeNull()
  })

  it('finishes viewport changes when a covered page cannot paint', async () => {
    const flush = vi.fn()
    vi.mocked(contents.executeJavaScript).mockImplementation(async (expression: string) =>
      runInNewContext(expression, {
        document: { documentElement: { getBoundingClientRect: flush } },
        requestAnimationFrame: () => 1, setTimeout, clearTimeout,
      }))
    const changing = tab.configure({ viewport: { width: 390, height: 844 } })
    await vi.runAllTimersAsync()
    await changing
    expect(flush).toHaveBeenCalledOnce()
    await expect(withBrowserInput(contents, async () => 'ready')).resolves.toBe('ready')
  })

  it('maps CSS click points to the fitted native surface and restores them when disabled', async () => {
    await tab.configure({ viewport: { width: 390, height: 844 } })
    const clicking = tab.click('#submit')
    await vi.runAllTimersAsync()
    await clicking
    expect(send).toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.objectContaining({
      type: 'mousePressed', x: 60 * (600 / 844), y: 40 * (600 / 844),
    }))
    await tab.configure({ viewport: null })
    send.mockClear()
    const next = tab.click('#submit')
    await vi.runAllTimersAsync()
    await next
    expect(send).toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.objectContaining({ type: 'mousePressed', x: 60, y: 40 }))
  })

  it('recognizes its own native mouse input after page zoom', async () => {
    vi.spyOn(contents, 'getZoomFactor').mockReturnValue(1.25)
    const clicking = tab.click('#submit')
    await vi.runAllTimersAsync()
    await expect(clicking).resolves.toMatchObject({ selector: '#submit' })
    expect(send).toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.objectContaining({ type: 'mousePressed', x: 60, y: 40 }))
  })

  it('holds new input until a queued layout change has finished applying', async () => {
    let release = () => {}
    const held = new Promise<void>((resolve) => { release = resolve })
    let applied = false
    const action = withBrowserInput(contents, async () => { await held })
    const changing = withBrowserLayout(contents, () => { applied = true })
    const next = withBrowserInput(contents, async () => { expect(applied).toBe(true) })
    expect(applied).toBe(false)
    release()
    await Promise.all([action, changing, next])
  })

  it('does not resurrect input stopped while waiting for a layout change', async () => {
    let release = () => {}
    const held = new Promise<void>((resolve) => { release = resolve })
    const changing = withBrowserLayout(contents, async () => { await held })
    const work = vi.fn(async () => {})
    const next = withBrowserInput(contents, work)
    const result = expect(next).rejects.toThrow('Browser agent use stopped')
    await tab.endAgentUse()
    release()
    await Promise.all([changing, result])
    expect(work).not.toHaveBeenCalled()
  })

  it('does not resume queued input after human takeover during layout', async () => {
    await withBrowserInput(contents, async () => {})
    let release = () => {}
    const held = new Promise<void>((resolve) => { release = resolve })
    const changing = withBrowserLayout(contents, async () => { await held })
    const work = vi.fn(async () => {})
    const next = withBrowserInput(contents, work)
    const result = expect(next).rejects.toThrow('Browser agent use stopped')
    humanKey(contents)
    release()
    await Promise.all([changing, result])
    expect(work).not.toHaveBeenCalled()
  })

  it('applies appearance and page zoom, and resets system appearance', async () => {
    await tab.configure({ appearance: 'dark', zoomFactor: 1.25 })
    expect(send).toHaveBeenCalledWith('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] })
    expect(contents.setZoomFactor).toHaveBeenCalledWith(1.25)
    await tab.configure({ appearance: 'system' })
    expect(send).toHaveBeenLastCalledWith('Emulation.setEmulatedMedia', { features: [] })
    await tab.hardReload()
    expect(contents.reloadIgnoringCache).toHaveBeenCalledOnce()
    await tab.openDevTools()
    expect(contents.openDevTools).toHaveBeenCalledWith({ mode: 'detach' })
  })

  it('magnifies the guest from the page pinch and resets it on a new document', async () => {
    const view = new WebContentsView() as unknown as BrowserPageView & { magnify: ReturnType<typeof vi.fn> }
    const send = vi.mocked(view.webContents.debugger.sendCommand)
    const tab = new BrowserTab('one', {} as never, () => {}, () => {}, async () => view)
    await tab.ensureView()
    expect(send).toHaveBeenCalledWith('Runtime.addBinding', { name: '__manorPinch', executionContextName: 'manor-pinch' })
    expect(send).toHaveBeenCalledWith('Page.addScriptToEvaluateOnNewDocument', expect.objectContaining({ worldName: 'manor-pinch', runImmediately: true }))
    const called = (payload: string, name = '__manorPinch') =>
      view.webContents.debugger.emit('message', {}, 'Runtime.bindingCalled', { name, payload })
    called(JSON.stringify({ scale: 2, x: 0.25, y: 0.5 }))
    expect(view.magnify).toHaveBeenLastCalledWith({ scale: 2, x: 0.25, y: 0.5 })
    called(JSON.stringify({ scale: 1, x: 0, y: 0 }))
    expect(view.magnify).toHaveBeenLastCalledWith(undefined)
    const calls = view.magnify.mock.calls.length
    called(JSON.stringify({ scale: 9, x: 0, y: 0 }))
    called('not json')
    called(JSON.stringify({ scale: 2, x: 0, y: 0 }), 'other')
    expect(view.magnify).toHaveBeenCalledTimes(calls)
    expect(view.webContents.setZoomFactor).toHaveBeenCalledTimes(1)
    called(JSON.stringify({ scale: 2, x: 0.25, y: 0.5 }))
    view.webContents.emit('did-start-navigation', {}, 'https://other.example/', false, true)
    view.webContents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://other.example/', true)
    expect(view.magnify).toHaveBeenLastCalledWith({ scale: 2, x: 0.25, y: 0.5 })
    view.webContents.emit('did-navigate', {}, 'https://other.example/')
    expect(view.magnify).toHaveBeenLastCalledWith(undefined)
    tab.close()
  })

  it('pinches around the fingers, pans while magnified and ignores page-made events', async () => {
    const view = new WebContentsView() as unknown as BrowserPageView
    const tab = new BrowserTab('one', {} as never, () => {}, () => {}, async () => view)
    await tab.ensureView()
    const script = vi.mocked(view.webContents.debugger.sendCommand).mock.calls
      .find(([method]) => method === 'Page.addScriptToEvaluateOnNewDocument')?.[1] as { source: string }
    const sent: { scale: number; x: number; y: number }[] = []
    const listeners = new Map<string, (event: object) => void>()
    class Element {}
    // A document 600px taller than the pane, which Chromium scrolls in whole pixels.
    const root = Object.assign(new Element(), {
      parentElement: null, scrollLeft: 0, scrollTop: 0, clientWidth: 800, clientHeight: 600, scrollWidth: 800, scrollHeight: 1200,
      scrollTo(this: { scrollTop: number }, { top }: { top?: number }) {
        if (top !== undefined) this.scrollTop = Math.min(Math.max(Math.floor(top), 0), 600)
      },
    })
    // An inner list whose content fits, which still keeps its overscroll to itself.
    const contained = Object.assign(new Element(), { parentElement: root, scrollTop: 0, clientHeight: 100, scrollHeight: 100 })
    let snap = 'none'
    // Body's overflow is the viewport's while html leaves its own visible.
    const body = Object.assign(new Element(), { parentElement: root })
    let bodyOverflow = 'visible'
    runInNewContext(script.source, {
      __manorPinch: (payload: string) => sent.push(JSON.parse(payload)),
      innerWidth: 800, innerHeight: 600, Element,
      document: { scrollingElement: root, documentElement: root, body },
      getComputedStyle: (node: object) => node === contained
        ? { overflowY: 'auto', overscrollBehaviorY: 'contain', scrollSnapType: 'none' }
        : node === body ? { overflowX: bodyOverflow, overflowY: bodyOverflow, scrollSnapType: 'none' }
          : { overflowX: 'visible', overflowY: 'visible', scrollSnapType: snap },
      addEventListener: (type: string, listener: (event: object) => void, options: { capture?: boolean }) =>
        listeners.set(type === 'scroll' ? 'scroll' : options.capture ? 'pan' : listeners.has('pinch') ? 'swipe' : 'pinch', listener),
      removeEventListener: (_type: string, _listener: unknown, options: { capture?: boolean }) =>
        listeners.delete(options.capture ? 'pan' : 'pinch'),
      setTimeout: (run: () => void) => run(),
      requestAnimationFrame: (run: () => void) => { run(); return 0 },
    })
    const pinch = { ctrlKey: true, deltaMode: 0, clientX: 400, clientY: 300, defaultPrevented: false, isTrusted: true }
    listeners.get('pinch')!({ ...pinch, deltaY: -100 * Math.log(2), isTrusted: false })
    expect(sent).toEqual([])
    listeners.get('pinch')!({ ...pinch, deltaY: -100 * Math.log(2) })
    expect(sent.at(-1)?.scale).toBeCloseTo(2)
    expect(sent.at(-1)?.x).toBeCloseTo(0.25)
    expect(sent.at(-1)?.y).toBeCloseTo(0.25)
    const pan = (deltaX: number, deltaY: number, target: object = root) => {
      const event = { ctrlKey: false, isTrusted: true, deltaMode: 0, deltaX, deltaY, target,
        preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() }
      listeners.get('pan')!(event)
      return event.preventDefault.mock.calls.length > 0
    }
    expect(pan(4000, 0)).toBe(true)
    expect(sent.at(-1)?.x).toBeCloseTo(0.5)
    // Sideways past the edge with nothing to scroll there: the page gets the wheel.
    expect(pan(100, 0)).toBe(false)
    // Down pans the magnified view to its edge first, then scrolls the page at the
    // same on-screen speed, half a pixel per wheel pixel at 2x.
    expect(pan(0, 300)).toBe(true)
    expect(sent.at(-1)?.y).toBeCloseTo(0.5)
    expect(root.scrollTop).toBe(0)
    expect(pan(0, 300)).toBe(true)
    expect(root.scrollTop).toBe(150)
    // Over a list that contains its overscroll, the page behind stays put.
    expect(pan(0, 300, contained)).toBe(false)
    expect(root.scrollTop).toBe(150)
    // Steps below a pixel add up instead of vanishing.
    for (let step = 0; step < 4; step += 1) pan(0, 1)
    expect(root.scrollTop).toBe(152)
    // Up pans the view back before the page moves.
    expect(pan(0, -200)).toBe(true)
    expect(root.scrollTop).toBe(152)
    expect(sent.at(-1)?.y).toBeCloseTo(1 / 3)
    // At the bottom of both, the page gets the wheel for its own handling.
    root.scrollTop = 600
    expect(pan(0, 1000)).toBe(true)
    expect(pan(0, 1000)).toBe(false)
    // A page locked with body { overflow: hidden } stays locked.
    root.scrollTop = 0
    bodyOverflow = 'hidden'
    expect(pan(0, 10)).toBe(false)
    bodyOverflow = 'visible'
    // A scroll-snap page would snap small steps back, so it scrolls the page's own way.
    snap = 'y mandatory'
    expect(pan(0, 10)).toBe(false)
    expect(root.scrollTop).toBe(0)
    listeners.get('pinch')!({ ...pinch, deltaY: 1000 })
    expect(sent.at(-1)).toEqual({ scale: 1, x: 0, y: 0 })
    expect(listeners.has('pan')).toBe(false)
    tab.close()
  })

  it('steps one page when a sideways swipe is let go past the threshold', async () => {
    const view = new WebContentsView() as unknown as BrowserPageView
    let index = 1
    let ahead = false
    const history = { canGoBack: () => true, canGoForward: () => ahead, getActiveIndex: () => index, goBack: vi.fn(), goForward: vi.fn() }
    Object.assign(view.webContents, { navigationHistory: history })
    const tab = new BrowserTab('one', {} as never, () => {}, () => {}, async () => view)
    await tab.ensureView()
    const script = vi.mocked(view.webContents.debugger.sendCommand).mock.calls
      .find(([method]) => method === 'Page.addScriptToEvaluateOnNewDocument')?.[1] as { source: string }
    const sent: string[] = []
    const listeners = new Map<string, (event: object) => void>()
    let release = () => {}
    class Element {
      parentElement: Element | null = null
      contains(node: Element | null): boolean { return node !== null && (node === this || this.contains(node.parentElement)) }
    }
    const node = (): object => ({ style: { setProperty() {} }, setAttribute() {}, append() {}, remove() {}, attachShadow: node })
    // The document spills sideways like Wikipedia in a narrow pane; that alone must not eat the swipe.
    const root = Object.assign(new Element(), { parentElement: null, scrollLeft: 0, clientWidth: 800, scrollWidth: 1041, append() {} })
    const scroller = Object.assign(new Element(), { parentElement: root, scrollLeft: 50, clientWidth: 100, scrollWidth: 300 })
    const text = Object.assign(new Element(), { parentElement: root })
    const page: Record<string, unknown> = {
      __manorPinch: (payload: string) => sent.push(payload),
      innerWidth: 800, innerHeight: 600, Element, Node: Element,
      document: { scrollingElement: root, documentElement: root, body: null, createElement: node, createElementNS: node },
      getComputedStyle: () => ({ overflowX: 'auto' }),
      addEventListener: (type: string, listener: (event: object) => void, options: { capture?: boolean }) =>
        listeners.set(type === 'scroll' ? 'scroll' : options.capture ? 'pan' : listeners.has('pinch') ? 'swipe' : 'pinch', listener),
      removeEventListener: () => {}, clearTimeout: () => {}, requestAnimationFrame: () => 0,
      // A wheel is read after the page's own listeners; a delay is the gesture's release.
      setTimeout: (callback: () => void, delay?: number) => { if (delay === undefined) callback(); else release = callback; return 1 },
    }
    page.top = page
    runInNewContext(script.source, page)
    const swipe = (deltaX: number, target: object = text, defaultPrevented = false) =>
      listeners.get('swipe')!({ isTrusted: true, ctrlKey: false, deltaMode: 0, deltaX, deltaY: 0, target, defaultPrevented })
    const answer = page.__manorSwipeHistory as (back: boolean, forward: boolean) => void

    // An inner scroller that can still move keeps its swipe.
    swipe(-200, scroller)
    release()
    expect(sent).toEqual([])
    // Fingers to the right, past the threshold, then pulled back under it: nothing.
    swipe(-100)
    expect(sent).toEqual([JSON.stringify({ swipe: 'start' })])
    answer(true, false)
    swipe(-100)
    swipe(60)
    release()
    // No page ahead, so a forward swipe never counts.
    swipe(200)
    answer(true, false)
    release()
    expect(sent.filter((payload) => payload !== JSON.stringify({ swipe: 'start' }))).toEqual([])
    // A canvas that cancels the wheel pans itself, whether it claims the first event or a later one.
    const canvas = Object.assign(new Element(), { parentElement: root })
    swipe(-200, canvas, true)
    release()
    swipe(-100, canvas)
    answer(true, false)
    swipe(-100, canvas, true)
    release()
    // So does a page that turns overscroll off, and an inner scroller at its edge that contains it.
    page.getComputedStyle = () => ({ overflowX: 'auto', overscrollBehaviorX: 'none' })
    swipe(-200)
    release()
    const contained = Object.assign(new Element(), { parentElement: root, scrollLeft: 0, clientWidth: 100, scrollWidth: 300 })
    page.getComputedStyle = (node: object) => ({ overflowX: 'auto', overscrollBehaviorX: node === contained ? 'contain' : 'auto' })
    swipe(-200, contained)
    release()
    // An inner scroller under the fingers that moved during the gesture took it, even if it
    // ended at its edge.
    const strip = Object.assign(new Element(), { parentElement: root, scrollLeft: 0, clientWidth: 100, scrollWidth: 300 })
    const inStrip = Object.assign(new Element(), { parentElement: strip })
    swipe(-100, inStrip)
    answer(true, false)
    listeners.get('scroll')!({ target: strip })
    swipe(-100, inStrip)
    release()
    page.getComputedStyle = () => ({ overflowX: 'auto', overscrollBehaviorX: 'auto' })
    expect(sent.filter((payload) => payload !== JSON.stringify({ swipe: 'start' }))).toEqual([])
    // Neither a scroll elsewhere on the page nor a vertical list drifting under the fingers takes the swipe.
    const list = Object.assign(new Element(), { parentElement: root, scrollLeft: 0, clientWidth: 400, scrollWidth: 400 })
    const inList = Object.assign(new Element(), { parentElement: list })
    swipe(-100, inList)
    answer(true, false)
    listeners.get('scroll')!({ target: scroller })
    listeners.get('scroll')!({ target: list })
    swipe(-100, inList)
    release()
    expect(sent.at(-1)).toBe(JSON.stringify({ swipe: 'back' }))

    const bindingCalled = (swipe: string) => view.webContents.debugger.emit('message', {}, 'Runtime.bindingCalled',
      { name: '__manorPinch', payload: JSON.stringify({ swipe }), executionContextId: 7 })
    const answered = () => vi.mocked(view.webContents.debugger.sendCommand).mock.calls
      .filter(([method]) => method === 'Runtime.evaluate').at(-1)?.[1]
    // A site that pushes a route mid-swipe keeps it.
    bindingCalled('start')
    index = 2
    bindingCalled('back')
    expect(history.goBack).not.toHaveBeenCalled()
    bindingCalled('start')
    expect(answered()).toEqual({ contextId: 7, expression: 'globalThis.__manorSwipeHistory?.(true, false)' })
    bindingCalled('back')
    expect(history.goBack).toHaveBeenCalledOnce()
    // Fingers that paused past the threshold and move on are still the same swipe, while
    // a quick swipe the other way is a new one.
    index = 1
    ahead = true
    bindingCalled('start')
    expect(answered()).toEqual({ contextId: 7, expression: 'globalThis.__manorSwipeHistory?.(false, true)' })
    bindingCalled('forward')
    expect(history.goForward).toHaveBeenCalledOnce()
    tab.close()
  })

  it('discards an idle page and reloads its address with its title and mark', async () => {
    const views: BrowserPageView[] = []
    const marks = { record: vi.fn(), lookup: vi.fn(() => 'data:image/png;base64,bWFyaw==') }
    const tab = new BrowserTab('one', {} as never, () => {}, () => {}, async () => {
      const view = new WebContentsView() as unknown as BrowserPageView
      Object.assign(view.webContents, { loadURL: vi.fn(async () => {}) })
      view.close = vi.fn(() => { view.webContents.emit('destroyed') })
      views.push(view)
      return view
    }, () => {}, () => {}, marks)
    await tab.ensureView()

    expect(tab.discard()).toBe(true)
    expect(views[0]!.close).toHaveBeenCalledOnce()
    expect(tab.peek()).toBeNull()
    expect(tab.state()).toMatchObject({ url: 'https://example.com/', title: 'Example', favicon: 'data:image/png;base64,bWFyaw==' })
    expect(tab.discard()).toBe(false)

    await tab.ensureView()
    expect(views[1]!.webContents.loadURL).toHaveBeenCalledWith('https://example.com/')
    tab.close()
  })

  it('tries the next favicon and ignores an icon from a page left during the fetch', async () => {
    const view = new WebContentsView() as unknown as BrowserPageView
    const fetch = vi.fn(async (url: string) => new Response(
      url.endsWith('broken.ico') ? 'missing' : 'icon',
      { status: url.endsWith('broken.ico') ? 404 : 200, headers: { 'content-type': 'image/png' } },
    ))
    const tab = new BrowserTab('one', { fetch } as never, () => {}, () => {}, async () => view)
    await tab.ensureView()
    view.webContents.emit('page-favicon-updated', {}, ['https://example.com/broken.ico', 'https://example.com/icon.png'])
    await vi.waitFor(() => expect(tab.state().favicon).toBe('data:image/png;base64,aWNvbg=='))
    expect(fetch).toHaveBeenCalledTimes(2)

    let release = (_response: Response) => {}
    fetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve }))
    view.webContents.emit('page-favicon-updated', {}, ['https://example.com/late.png'])
    view.webContents.emit('did-start-navigation', {}, 'https://other.example/', false, true)
    release(new Response('old', { headers: { 'content-type': 'image/png' } }))
    await vi.waitFor(() => expect(tab.state().favicon).toBeUndefined())
    tab.close()
  })

  it('dispatches a complete mouse click and does not interrupt itself', async () => {
    const clicking = tab.click('#submit')
    await vi.runAllTimersAsync()
    await expect(clicking).resolves.toMatchObject({ selector: '#submit' })
    expect(send.mock.calls.filter(([method]) => method === 'Input.dispatchMouseEvent')).toEqual([
      ['Input.dispatchMouseEvent', { type: 'mousePressed', x: 60, y: 40, button: 'left', clickCount: 1 }],
      ['Input.dispatchMouseEvent', { type: 'mouseReleased', x: 60, y: 40, button: 'left', clickCount: 1 }],
    ])
    expect(contents.listenerCount('before-mouse-event')).toBe(1)
    expect(contents.listenerCount('did-start-navigation')).toBe(3)
  })

  const cursorClears = () => send.mock.calls.filter(([method, params]) =>
    method === 'Runtime.evaluate' && /, null\)$/.test(String(params?.expression)))

  it('retains the same cursor between actions and removes it when the agent ends', async () => {
    for (let i = 0; i < 2; i += 1) {
      const clicking = tab.click('#submit')
      await vi.runAllTimersAsync()
      await clicking
    }
    expect(cursorClears()).toHaveLength(0)
    expect(send.mock.calls.filter(([method]) => method === 'Page.createIsolatedWorld')).toHaveLength(1)
    await tab.endAgentUse()
    expect(cursorClears()).toHaveLength(1)
    expect(contents.listenerCount('before-mouse-event')).toBe(0)
  })

  it.each(['missing target', 'CDP failure'])('retains the cursor after %s until the agent ends', async (failure) => {
    const clicking = tab.click('#submit')
    await vi.runAllTimersAsync()
    await clicking

    if (failure === 'missing target') matches = []
    else send.mockRejectedValueOnce(new Error('Renderer unavailable'))
    await expect(tab.click('#submit')).rejects.toThrow(
      failure === 'missing target' ? 'No unique, visible' : 'Renderer unavailable',
    )
    expect(cursorClears()).toHaveLength(0)
    expect(contents.listenerCount('before-mouse-event')).toBe(1)

    matches = [element]
    const retry = tab.click('#submit')
    await vi.runAllTimersAsync()
    await expect(retry).resolves.toMatchObject({ selector: '#submit' })
    expect(send.mock.calls.filter(([method]) => method === 'Page.createIsolatedWorld')).toHaveLength(1)
    await tab.endAgentUse()
    expect(cursorClears()).toHaveLength(1)
    expect(contents.listenerCount('before-mouse-event')).toBe(0)
  })

  it('clears on a human click between actions and permits the next agent action', async () => {
    const clicking = tab.click('#submit')
    await vi.runAllTimersAsync()
    await clicking
    contents.emit('before-mouse-event', {}, { type: 'mouseDown', button: 'left', x: 300, y: 200 })
    await Promise.resolve()
    expect(cursorClears()).toHaveLength(1)
    const next = tab.click('#submit')
    await vi.runAllTimersAsync()
    await expect(next).resolves.toMatchObject({ selector: '#submit' })
    expect(send.mock.calls.filter(([method]) => method === 'Page.createIsolatedWorld')).toHaveLength(2)
  })

  it('stops an in-flight action and clears its retained cursor', async () => {
    const dispatch = send.getMockImplementation()!
    send.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      const result = await dispatch(method, params)
      if (params?.type === 'mousePressed') await tab.endAgentUse()
      return result
    })
    await expect(tab.click('#submit')).rejects.toThrow('Browser agent use stopped')
    expect(cursorClears()).toHaveLength(1)
    expect(send).toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.objectContaining({ type: 'mouseReleased', x: -1, y: -1 }))
  })

  it('preserves the cursor on same-document navigation and recreates it after a new document', async () => {
    const clicking = tab.click('#submit')
    await vi.runAllTimersAsync()
    await clicking
    contents.emit('did-start-navigation', {}, 'https://example.com/#next', true, true)
    expect(cursorClears()).toHaveLength(0)
    contents.emit('did-start-navigation', {}, 'https://example.com/next', false, true)
    const next = tab.click('#submit')
    await vi.runAllTimersAsync()
    await next
    expect(cursorClears()).toHaveLength(1)
    expect(send.mock.calls.filter(([method]) => method === 'Page.createIsolatedWorld')).toHaveLength(2)
  })

  it.each(['missing', 'ambiguous', 'hidden', 'disabled', 'inert', 'covered', 'offscreen'])(
    'refuses a %s target before dispatching any mouse input', async (kind) => {
      if (kind === 'missing') matches = []
      if (kind === 'ambiguous') matches.push(new Element())
      if (kind === 'hidden') style.visibility = 'hidden'
      if (kind === 'disabled') element.disabled = true
      if (kind === 'inert') element.inert = true
      if (kind === 'covered') hit = new Element()
      if (kind === 'offscreen') element.rect = { left: 900, right: 1000, top: 20, bottom: 60 }
      await expect(tab.click('#submit')).rejects.toThrow('No unique, visible')
      expect(send.mock.calls.some(([method]) => method === 'Input.dispatchMouseEvent')).toBe(false)
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  it('does not click a stale target after human input during inspection', async () => {
    send.mockImplementationOnce(async () => {
      humanKey(contents)
      return { result: { value: { x: 60, y: 40 } } }
    })
    await expect(tab.click('#submit')).rejects.toThrow('interrupted by human input')
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('clears the rendered cursor and sends no mouse input when a human interrupts the move', async () => {
    const original = send.getMockImplementation()!
    send.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      const result = await original(method, params)
      if (params?.contextId === 17 && String(params.expression).includes('"phase":"move"')) humanKey(contents)
      return result
    })
    await expect(tab.click('#submit')).rejects.toThrow('interrupted by human input')
    expect(send.mock.calls.some(([method]) => method === 'Input.dispatchMouseEvent')).toBe(false)
    expect(send).toHaveBeenLastCalledWith('Runtime.evaluate', expect.objectContaining({
      contextId: 17, expression: expect.stringMatching(/, null\)$/),
    }))
  })

  it('does not recreate click feedback in a new document after navigation starts', async () => {
    const original = send.getMockImplementation()!
    send.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      const result = await original(method, params)
      if (params?.type === 'mouseReleased') {
        contents.emit('did-start-navigation', {}, 'https://example.com/next', false, true)
        contents.emit('did-finish-load')
      }
      return result
    })
    await tab.click('#submit')
    const expressions = send.mock.calls.map(([, params]) => String(params?.expression ?? ''))
    expect(expressions.some((expression) => expression.includes('"phase":"move"'))).toBe(true)
    expect(expressions.some((expression) => expression.includes('"phase":"click"'))).toBe(false)
    expect(expressions.at(-1)).toMatch(/, null\)$/)
  })

  it('releases an interrupted mouse press outside the page, without completing the click', async () => {
    const original = send.getMockImplementation()!
    send.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      const result = await original(method, params)
      if (params?.type === 'mousePressed') humanKey(contents)
      return result
    })
    await expect(tab.click('#submit')).rejects.toThrow('interrupted by human input')
    expect(send).toHaveBeenLastCalledWith('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: -1, y: -1, button: 'left', clickCount: 1,
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not insert agent text after a human takes over the focused field', async () => {
    send.mockImplementationOnce(async () => {
      contents.emit('before-mouse-event', {}, { type: 'mouseDown', button: 'left', x: 30, y: 50 })
      return { result: { value: true } }
    })
    await expect(tab.type('#name', 'agent')).rejects.toThrow('interrupted by human input')
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('releases an interrupted key and removes the pending navigation listeners', async () => {
    const original = send.getMockImplementation()!
    send.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      const result = await original(method, params)
      if (params?.type === 'keyDown') humanKey(contents)
      return result
    })
    await expect(tab.press('Enter')).rejects.toThrow('interrupted by human input')
    expect(send).toHaveBeenCalledWith('Input.dispatchKeyEvent', expect.objectContaining({ type: 'keyUp' }))
    expect(send).toHaveBeenLastCalledWith('Emulation.setFocusEmulationEnabled', { enabled: false })
    expect(contents.listenerCount('before-input-event')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('interrupts a pending navigation, then permits a fresh agent action', async () => {
    const retainedLoadListeners = contents.listenerCount('did-finish-load')
    send.mockImplementationOnce(async () => { humanKey(contents); return {} })
    await expect(tab.navigate('https://example.com/next')).rejects.toThrow('interrupted by human input')
    expect(contents.listenerCount('did-finish-load')).toBe(retainedLoadListeners)
    expect(vi.getTimerCount()).toBe(0)
    const pressing = tab.press('Enter')
    await vi.runAllTimersAsync()
    await expect(pressing).resolves.toEqual({ key: 'Enter' })
  })

  it('interrupts the post-click navigation wait and clears its timers', async () => {
    let released = () => {}
    const releaseSent = new Promise<void>((resolve) => { released = resolve })
    const original = send.getMockImplementation()!
    send.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      const result = await original(method, params)
      if (params?.type === 'mouseReleased') released()
      return result
    })
    const clicking = tab.click('#submit')
    const assertion = expect(clicking).rejects.toThrow('interrupted by human input')
    await releaseSent
    await vi.advanceTimersByTimeAsync(1)
    contents.emit('before-mouse-event', {}, { type: 'mouseWheel', x: 25, y: 25 })
    await assertion
    expect(vi.getTimerCount()).toBe(0)
    expect(contents.listenerCount('did-start-navigation')).toBe(2)
  })

  it('releases a key and cancels navigation waiting after a CDP failure', async () => {
    send.mockResolvedValueOnce({}).mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('Renderer unavailable'))
    await expect(tab.press('Enter')).rejects.toThrow('Renderer unavailable')
    expect(send).toHaveBeenCalledWith('Input.dispatchKeyEvent', expect.objectContaining({ type: 'keyUp' }))
    expect(send).toHaveBeenLastCalledWith('Emulation.setFocusEmulationEnabled', { enabled: false })
    expect(vi.getTimerCount()).toBe(0)
    expect(contents.listenerCount('did-start-navigation')).toBe(3)
    expect(contents.listenerCount('before-input-event')).toBe(1)
    humanKey(contents)
    expect(contents.listenerCount('before-input-event')).toBe(0)
  })

  it('recognizes native key events that arrive after Chromium acknowledged the commands', async () => {
    send.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'Input.dispatchKeyEvent') {
        setTimeout(() => contents.emit('before-input-event', {}, { type: params?.type === 'rawKeyDown' ? 'keyDown' : params?.type, key: params?.key }), 1)
      }
      return {}
    })
    const pressing = tab.press('End')
    const assertion = expect(pressing).resolves.toEqual({ key: 'End' })
    await vi.runAllTimersAsync()
    await assertion
  })
})

describe('BrowserTab popups', () => {
  type Allowed = { action: 'allow'; createWindow: (options: { webContents?: unknown }) => unknown }
  type OpenHandler = (details: { url: string; disposition: string }) => { action: 'deny' } | Allowed
  const popupPage = () => {
    let destroyed = false
    const page = Object.assign(new EventEmitter(), {
      isDestroyed: () => destroyed,
      // Manor is the popup's window, so only its own close is certain; a page's
      // beforeunload must not be asked.
      close: vi.fn((options?: { waitForBeforeUnload?: boolean }) => {
        expect(options?.waitForBeforeUnload).toBe(false)
        destroyed = true
        page.emit('destroyed')
      }),
      setWindowOpenHandler: vi.fn(),
      getZoomFactor: () => 1,
    })
    return page
  }
  const openTab = async () => {
    const onPopup = vi.fn()
    const onChanged = vi.fn()
    const view = new WebContentsView() as unknown as BrowserPageView & { overlay: ReturnType<typeof vi.fn> }
    const setHandler = vi.spyOn(view.webContents, 'setWindowOpenHandler')
    const tab = new BrowserTab('one', {} as never, onChanged, onPopup, async () => view)
    await tab.ensureView()
    const open = setHandler.mock.calls[0]![0] as unknown as OpenHandler
    const input = (type: string) => view.webContents.emit('input-event', {}, { type })
    const host = (url: string) => {
      const result = open({ url, disposition: 'new-window' })
      expect(result.action).toBe('allow')
      const page = popupPage()
      expect((result as Allowed).createWindow({ webContents: page })).toBe(page)
      return page
    }
    return { tab, view, onPopup, onChanged, open, input, host }
  }

  it('draws a scripted popup right after input over its page, once, and names where it is', async () => {
    const { tab, view, onPopup, open, input, host } = await openTab()
    input('mouseDown')
    const page = host('https://accounts.example.com/o/oauth2')
    expect(view.overlay).toHaveBeenCalledWith(page)
    expect(tab.state().signIn).toEqual({ url: 'https://accounts.example.com/o/oauth2' })
    page.emit('did-navigate', {}, 'https://accounts.example.com/challenge')
    page.emit('did-navigate-in-page', {}, 'https://ads.example.com/frame', false)
    expect(tab.state().signIn).toEqual({ url: 'https://accounts.example.com/challenge' })
    // The popup spent the activation; a second one from the same click is blocked.
    expect(open({ url: 'https://ads.example.com/', disposition: 'new-window' })).toEqual({ action: 'deny' })
    expect(onPopup).not.toHaveBeenCalled()
    // The page closing itself after the handshake shows the tab's page again.
    page.close({ waitForBeforeUnload: false })
    expect(tab.state().signIn).toBeUndefined()
    tab.close()
  })

  it('drops a crashed sign-in page and turns a Shift-clicked link into a tab', async () => {
    const { tab, view, onPopup, open, input, host } = await openTab()
    input('mouseDown')
    const page = host('https://accounts.example.com/')
    page.emit('render-process-gone', {}, { reason: 'crashed' })
    expect(page.close).toHaveBeenCalledOnce()
    expect(tab.state().signIn).toBeUndefined()

    input('mouseDown')
    const link = open({ url: 'https://example.com/shift', disposition: 'new-window' }) as Allowed
    expect(link.createWindow({})).toBe(view.webContents)
    expect(onPopup).toHaveBeenCalledWith('https://example.com/shift')
    expect(tab.state().signIn).toBeUndefined()
    tab.close()
  })

  it('opens links after input as background tabs and blocks everything without input', async () => {
    vi.useFakeTimers()
    try {
      const { tab, onPopup, open, input } = await openTab()
      expect(open({ url: 'https://example.com/a', disposition: 'new-window' })).toEqual({ action: 'deny' })
      expect(open({ url: 'https://example.com/b', disposition: 'foreground-tab' })).toEqual({ action: 'deny' })
      input('mouseMove')
      expect(open({ url: 'https://example.com/c', disposition: 'new-window' })).toEqual({ action: 'deny' })
      input('keyDown')
      expect(open({ url: 'https://example.com/d', disposition: 'foreground-tab' })).toEqual({ action: 'deny' })
      input('mouseDown')
      vi.advanceTimersByTime(5_000)
      expect(open({ url: 'https://example.com/e', disposition: 'new-window' })).toEqual({ action: 'deny' })
      expect(onPopup.mock.calls.map(([url]) => url)).toEqual(['https://example.com/d'])
      tab.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not let a new document spend input from the page before it', async () => {
    const { tab, view, onPopup, open, input } = await openTab()
    input('mouseDown')
    view.webContents.emit('did-start-navigation', {}, 'https://example.com/pushed', true, true)
    view.webContents.emit('did-start-navigation', {}, 'https://example.com/frame', false, false)
    input('mouseDown')
    view.webContents.emit('did-start-navigation', {}, 'https://example.com/next', false, true)
    expect(open({ url: 'https://example.com/auto', disposition: 'new-window' })).toEqual({ action: 'deny' })
    expect(open({ url: 'https://example.com/tab', disposition: 'foreground-tab' })).toEqual({ action: 'deny' })
    expect(onPopup).not.toHaveBeenCalled()
    tab.close()
  })

  it('keeps the tab live while its popup is open, cancels it, and closes it with the tab', async () => {
    const { tab, onPopup, input, host } = await openTab()
    input('mouseDown')
    const first = host('https://accounts.example.com/')
    const nested = first.setWindowOpenHandler.mock.calls[0]![0] as OpenHandler
    expect(nested({ url: 'https://example.com/unprompted', disposition: 'new-window' })).toEqual({ action: 'deny' })
    first.emit('input-event', {}, { type: 'mouseUp' })
    expect(nested({ url: 'https://example.com/help', disposition: 'foreground-tab' })).toEqual({ action: 'deny' })
    first.emit('input-event', {}, { type: 'mouseDown' })
    first.emit('did-start-navigation', {}, 'https://example.com/next', false, true)
    expect(nested({ url: 'https://example.com/after', disposition: 'foreground-tab' })).toEqual({ action: 'deny' })
    expect(onPopup.mock.calls.map(([url]) => url)).toEqual(['https://example.com/help'])

    expect(tab.discard()).toBe(false)
    tab.cancelSignIn()
    expect(first.close).toHaveBeenCalledOnce()
    expect(tab.state().signIn).toBeUndefined()
    expect(tab.discard()).toBe(true)

    await tab.ensureView()
    input('mouseDown')
    const second = host('https://accounts.example.com/')
    tab.close()
    expect(second.close).toHaveBeenCalledOnce()
    expect(first.close).toHaveBeenCalledOnce()
  })
})

describe('BrowserTab on a page sealed by a secret card', () => {
  const secretUrl = 'https://sentinel.example.net/result?token=sentinel'
  const setup = async () => {
    const view = new WebContentsView() as unknown as BrowserPageView
    const sealed = new Set<unknown>([view.webContents])
    const filled = vi.fn(async () => {})
    const passwords = {
      ...noPagePasswords,
      sealed: (contents: unknown) => sealed.has(contents),
      sealedOrigin: (contents: unknown) => sealed.has(contents) ? 'https://example.com' : undefined,
      unseal: (contents: unknown) => { sealed.delete(contents) },
      agentFillSecret: filled,
    }
    vi.spyOn(view.webContents, 'getURL').mockImplementation(() => secretUrl)
    vi.spyOn(view.webContents, 'getTitle').mockImplementation(() => 'sentinel title')
    const clear = vi.fn()
    Object.assign(view.webContents.navigationHistory, { clear })
    const open = vi.spyOn(view.webContents, 'setWindowOpenHandler')
    const record = vi.fn()
    const visit = vi.fn()
    const onPopup = vi.fn()
    const browserSession = { fetch: vi.fn(async () => new Response('<svg>sentinel</svg>', { headers: { 'content-type': 'image/svg+xml' } })) }
    const tab = new BrowserTab('one', browserSession as never, () => {}, onPopup, async () => view, visit, () => {}, { record, lookup: () => undefined }, passwords)
    await tab.ensureView()
    const handler = open.mock.calls[0]?.[0] as unknown as (details: { url: string; disposition: string }) => { action: string }
    return { view, tab, sealed, clear, record, visit, onPopup, handler, browserSession, filled }
  }

  it('shows only the origin of a sign-in popup that took the value, and lets it open nothing', async () => {
    const { view, tab, sealed, onPopup, handler, filled } = await setup()
    sealed.clear()
    view.webContents.emit('input-event', {}, { type: 'mouseDown' })
    const allowed = handler({ url: 'https://example.com/popup', disposition: 'new-window' }) as unknown as { createWindow: (options: { webContents: unknown }) => unknown }
    const setHandler = vi.fn()
    const popup = Object.assign(new EventEmitter(), { setWindowOpenHandler: setHandler, isDestroyed: () => false, close: () => {}, getZoomFactor: () => 1 })
    allowed.createWindow({ webContents: popup })

    const target = { pageId: 1, origin: 'https://example.com', value: 'sentinel' }
    await tab.fillSecret(target)
    expect(filled).toHaveBeenCalledWith(popup, target, view.webContents)
    sealed.add(popup)
    popup.emit('did-navigate', {}, secretUrl)
    popup.emit('input-event', {}, { type: 'mouseDown' })

    expect(tab.state().signIn?.url).toBe('https://example.com')
    expect(setHandler.mock.calls[0]?.[0]({ url: secretUrl })).toEqual({ action: 'deny' })
    expect(onPopup).not.toHaveBeenCalled()
    tab.close()
  })

  it('waits for a sealed popup to go before leaving, and keeps its live host out of the ad-block site list', async () => {
    const view = new WebContentsView() as unknown as BrowserPageView
    const sealed = new Set<unknown>()
    const setSiteBlocking = vi.fn()
    const passwords = { ...noPagePasswords, sealed: (contents: unknown) => sealed.has(contents), sealedOrigin: (contents: unknown) => sealed.has(contents) ? 'https://example.com' : undefined }
    const adblock = { ...noPageAdblock, setSiteBlocking }
    const open = vi.spyOn(view.webContents, 'setWindowOpenHandler')
    Object.assign(view.webContents.navigationHistory, { clear: vi.fn() })
    const tab = new BrowserTab('one', {} as never, () => {}, () => {}, async () => view, undefined, undefined, undefined, passwords, adblock)
    await tab.ensureView()
    view.webContents.emit('input-event', {}, { type: 'mouseDown' })
    const allowed = (open.mock.calls[0]?.[0] as unknown as (details: { url: string; disposition: string }) => { createWindow: (options: { webContents: unknown }) => unknown })({ url: 'https://example.com/popup', disposition: 'new-window' })
    const steps: string[] = []
    const popup = Object.assign(new EventEmitter(), {
      setWindowOpenHandler: vi.fn(), isDestroyed: () => false, getZoomFactor: () => 1, reload: vi.fn(),
      close: () => { steps.push('closing'); setTimeout(() => { steps.push('closed'); popup.emit('destroyed') }, 0) },
    })
    allowed.createWindow({ webContents: popup })
    sealed.add(view.webContents).add(popup)
    popup.emit('did-navigate', {}, secretUrl)

    tab.setSiteAdblock(false)
    expect(setSiteBlocking).toHaveBeenCalledWith('https://example.com', false)

    vi.mocked(view.webContents.debugger.sendCommand).mockImplementation(async (method: string) => {
      if (method === 'Page.navigate') {
        steps.push('navigated')
        queueMicrotask(() => view.webContents.emit('did-finish-load'))
      }
      return {}
    })
    await tab.navigate('https://example.com/home')
    expect(steps).toEqual(['closing', 'closed', 'navigated'])
    tab.close()
  })

  it('opens nothing from the sealed page, even right after input', async () => {
    const { tab, onPopup, handler, view } = await setup()
    view.webContents.emit('input-event', {}, { type: 'mouseDown' })

    expect(handler({ url: secretUrl, disposition: 'foreground-tab' })).toEqual({ action: 'deny' })
    expect(handler({ url: secretUrl, disposition: 'new-window' })).toEqual({ action: 'deny' })
    expect(onPopup).not.toHaveBeenCalled()
    tab.close()
  })

  it('takes no favicon from it, nor one that was on its way when the value landed', async () => {
    const { view, tab, sealed, record, browserSession } = await setup()
    view.webContents.emit('page-favicon-updated', {}, ['https://example.com/a.svg'])
    await vi.waitFor(() => expect(tab.state().favicon).toBeUndefined())
    expect(browserSession.fetch).not.toHaveBeenCalled()

    sealed.clear()
    let land = (_: Response) => {}
    browserSession.fetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { land = resolve }))
    view.webContents.emit('page-favicon-updated', {}, ['https://example.com/b.svg'])
    sealed.add(view.webContents)
    land(new Response('<svg>sentinel</svg>', { headers: { 'content-type': 'image/svg+xml' } }))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(record).not.toHaveBeenCalled()
    expect(tab.state().favicon).toBeUndefined()
    tab.close()
  })

  it('keeps its page out of a chat, also when the seal lands during the selection', async () => {
    const { view, tab, sealed } = await setup()
    await expect(tab.selectPageContext()).rejects.toThrow('received a secret')

    sealed.clear()
    vi.mocked(view.webContents.debugger.sendCommand).mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'top' } } }
      if (method !== 'Runtime.evaluate') return {}
      if (String(params?.expression).includes('manor-view')) return { result: { value: false } }
      sealed.add(view.webContents)
      return { result: { value: { kind: 'element', url: secretUrl, title: 'sentinel', label: 'x', text: 'sentinel', html: '<i></i>' } } }
    })
    await expect(tab.selectPageContext()).resolves.toBeNull()
    tab.close()
  })

  it('forgets the sealed history on a chosen address, and records that address', async () => {
    const { view, tab, sealed, clear, visit } = await setup()
    vi.mocked(view.webContents.debugger.sendCommand).mockImplementation(async (method: string) => {
      if (method !== 'Page.navigate') return {}
      vi.spyOn(view.webContents, 'getURL').mockImplementation(() => 'https://example.com/home')
      vi.spyOn(view.webContents, 'getTitle').mockImplementation(() => 'Home')
      view.webContents.emit('did-navigate', {}, 'https://example.com/home')
      queueMicrotask(() => view.webContents.emit('did-finish-load'))
      return {}
    })

    await tab.navigate('https://example.com/home')

    expect(sealed.size).toBe(0)
    expect(clear).toHaveBeenCalledOnce()
    expect(visit).toHaveBeenCalledWith('https://example.com/home', 'Home')
    expect(tab.state()).toMatchObject({ url: 'https://example.com/home', title: 'Home' })
    tab.close()
  })
})
