import { useRef } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWebviewSnapshot, BrowserWebviewSurface, DesktopBrowserBridge, DesktopBrowserWebviewsBridge } from '@manor/contracts'
import { BrowserWebviewHost } from '../src/components/BrowserWebviewHost'
import { useBrowserSlot } from '../src/useBrowserSlot'

vi.mock('react-dom', async (original) => ({ ...await original<typeof import('react-dom')>(), createPortal: (child: unknown) => child }))
let tree: ReactTestRenderer | undefined
const frames = new Map<number, FrameRequestCallback>()
let frameId = 0
const guests: ReturnType<typeof guest>[] = []
function guest() {
  const listeners = new Map<string, EventListener>()
  return { attributes: new Map<string, string>(), listeners, className: '',
    setAttribute(name: string, value: string) { this.attributes.set(name, value) },
    addEventListener(name: string, listener: EventListener) { listeners.set(name, listener) },
    removeEventListener(name: string) { listeners.delete(name) },
    getWebContentsId: vi.fn(() => 17), remove: vi.fn(),
  }
}
beforeEach(() => {
  guests.length = 0; frames.clear()
  vi.stubGlobal('document', { body: {}, addEventListener: vi.fn(), removeEventListener: vi.fn(), createElement: (tag: string) => { expect(tag).toBe('webview'); const next = guest(); guests.push(next); return next } })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
})
afterEach(() => { act(() => tree?.unmount()); tree = undefined; vi.unstubAllGlobals() })
async function paint() {
  await act(async () => { const pending = [...frames.values()]; frames.clear(); pending.forEach((callback) => callback(0)) })
}
const surface = (over: Partial<BrowserWebviewSurface> = {}): BrowserWebviewSurface => ({
  id: 'tab', token: 'first', partition: 'persist:managed', src: 'about:blank', revision: 1,
  bounds: { x: 200, y: 100, width: 640, height: 360 }, presentation: 'sidebar', ...over,
})
async function setup() {
  let push = (_snapshot: BrowserWebviewSnapshot) => {}
  let initial = (_snapshot: BrowserWebviewSnapshot) => {}
  const bridge: DesktopBrowserWebviewsBridge = {
    onChange: vi.fn((listener) => { push = listener; return vi.fn() }),
    list: vi.fn(() => new Promise<BrowserWebviewSnapshot>((resolve) => { initial = resolve })),
    attach: vi.fn(async () => {}), presented: vi.fn(async () => {}),
  }
  const appended: ReturnType<typeof guest>[] = []
  await act(async () => { tree = create(<BrowserWebviewHost bridge={bridge} />, { createNodeMock: (node) =>
    node.props.className === 'h-full w-full' ? { appendChild: (node: ReturnType<typeof guest>) => {
      expect(node.attributes.get('partition')).toBe('persist:managed')
      expect(node.attributes.has('allowpopups')).toBe(true)
      expect([...node.attributes.keys()]).toEqual(['partition', 'allowpopups', 'src'])
      appended.push(node)
    } } : null,
  }) })
  const publish = async (revision: number, surfaces: BrowserWebviewSurface[]) => { await act(async () => push({ revision, surfaces })) }
  return { bridge, initial, publish, appended }
}

describe('persistent browser guests', () => {
  it('subscribes before listing and never lets an old read replace a pushed guest', async () => {
    const { bridge, publish, initial } = await setup()
    expect(vi.mocked(bridge.onChange).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(bridge.list).mock.invocationCallOrder[0]!)
    await publish(2, [surface()])
    await act(async () => initial({ revision: 1, surfaces: [] }))
    expect(guests).toHaveLength(1)
    expect(guests[0]!.remove).not.toHaveBeenCalled()
    expect(bridge.attach).toHaveBeenCalledWith('tab', 'first', 17)
  })

  it('keeps identity and initial URL across sidebar, floating and hidden layout revisions', async () => {
    const { publish, bridge, appended } = await setup()
    await publish(1, [surface()])
    await paint()
    expect(bridge.presented).not.toHaveBeenCalled()
    await paint()
    expect(bridge.presented).toHaveBeenLastCalledWith('tab', 'first', 1)
    await publish(2, [surface({ revision: 2, presentation: 'floating', src: 'https://must-not-reload.test', bounds: { x: 10, y: 40, width: 384, height: 216 } })])
    await paint()
    await publish(3, [surface({ revision: 3, presentation: 'hidden' })])
    await paint(); await paint()
    expect(appended).toHaveLength(1)
    expect(guests[0]!.className).not.toContain('bg-white')
    expect(tree!.root.findByProps({ 'data-browser-webview': 'tab' }).props.className).not.toContain('bg-white')
    // Pages without a background of their own still land on white, from a plate under the guest.
    expect(tree!.root.findByProps({ 'data-browser-plate': true }).props.className).toContain('bg-page')
    expect(guests[0]!.attributes.get('src')).toBe('about:blank')
    expect(bridge.presented).toHaveBeenLastCalledWith('tab', 'first', 3)
    expect(vi.mocked(bridge.presented).mock.calls.some((call) => call[2] === 2)).toBe(false)
    const wrapper = tree!.root.findByProps({ 'data-browser-webview': 'tab' })
    expect(wrapper.props.style).toMatchObject({ left: 0, top: 0, width: 640, height: 360, zIndex: -1, pointerEvents: 'none' })
    expect(wrapper.props.style.display).toBeUndefined()
    expect(wrapper.props.style.visibility).toBe('hidden')
    await publish(4, [surface({ revision: 4, presentation: 'hidden', painting: true })])
    expect(wrapper.props.style.visibility).toBeUndefined()
    expect(wrapper.props.style.pointerEvents).toBe('none')
    expect(wrapper.props.style.zIndex).toBe(-1)
    await publish(5, [surface({ revision: 5 })])
    expect(wrapper.props.style.pointerEvents).toBe('auto')
    expect(guests).toHaveLength(1)
  })

  it('draws a pinch magnification around the guest without a new layout revision', async () => {
    const { publish, bridge } = await setup()
    await publish(1, [surface()])
    await paint(); await paint()
    const page = () => tree!.root.find((node) => node.type === 'div' && node.props.className === 'h-full w-full')
    expect(page().props.style).toBeUndefined()
    await publish(2, [surface({ magnify: { scale: 2, x: 0.25, y: 0.5 } })])
    expect(page().props.style).toEqual({ transformOrigin: '0 0', transform: 'scale(2) translate(-25%, -50%)' })
    await paint(); await paint()
    expect(bridge.presented).toHaveBeenCalledTimes(1)
    await publish(3, [surface()])
    expect(page().props.style).toBeUndefined()
  })

  it('deduplicates attachment events and rejects obsolete callbacks when a token is replaced or removed', async () => {
    const { publish, bridge } = await setup()
    await publish(1, [surface()])
    const old = guests[0]!
    const late = old.listeners.get('dom-ready')!
    await act(async () => { late(new Event('dom-ready')); old.listeners.get('did-attach')!(new Event('did-attach')) })
    expect(bridge.attach).toHaveBeenCalledOnce()
    await publish(2, [surface({ token: 'replacement' })])
    expect(old.remove).toHaveBeenCalledOnce()
    expect(old.listeners.size).toBe(0)
    await act(async () => late(new Event('dom-ready')))
    expect(bridge.attach).toHaveBeenCalledTimes(2)
    await publish(3, [])
    expect(guests[1]!.remove).toHaveBeenCalledOnce()
    await paint(); await paint()
    expect(bridge.presented).not.toHaveBeenCalled()
  })

  it('ignores an attachment response arriving after its guest was removed', async () => {
    const { publish, bridge } = await setup()
    let attached = () => {}
    vi.mocked(bridge.attach).mockImplementationOnce(() => new Promise<void>((resolve) => { attached = resolve }))
    await publish(1, [surface()])
    await publish(2, [])
    await act(async () => attached())
    await paint(); await paint()
    expect(bridge.presented).not.toHaveBeenCalled()
    expect(guests[0]!.remove).toHaveBeenCalledOnce()
  })

  it('moves a filling sidebar guest with the measured frame, before the host echoes it', async () => {
    let push = (_snapshot: BrowserWebviewSnapshot) => {}
    const webviews: DesktopBrowserWebviewsBridge = {
      onChange: (listener) => { push = listener; return () => {} }, list: () => new Promise(() => {}),
      attach: vi.fn(async () => {}), presented: vi.fn(async () => {}),
    }
    const shell = { webviews, show: vi.fn(async () => {}), hide: vi.fn(async () => {}) } as unknown as DesktopBrowserBridge
    let width = 700
    let resized = () => {}
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resized = callback }
      observe() {}
      disconnect() {}
    })
    function Frame() {
      const frame = useRef<HTMLDivElement>(null)
      useBrowserSlot({ bridge: shell, chatId: 'chat', frame, active: true, presentation: 'sidebar', onError: vi.fn() })
      return <div ref={frame} data-frame />
    }
    await act(async () => { tree = create(<><Frame /><BrowserWebviewHost bridge={webviews} /></>, { createNodeMock: (node) =>
      node.props['data-frame'] ? { getBoundingClientRect: () => ({ x: 300, y: 50, width, height: 500 }), parentElement: null }
        : node.props.className === 'h-full w-full' ? { appendChild: () => {} } : null }) })
    await paint()
    const style = () => tree!.root.findByProps({ 'data-browser-webview': 'tab' }).props.style
    await act(async () => push({ revision: 1, surfaces: [surface({ fill: true })] }))
    expect(style()).toMatchObject({ left: 300, top: 50, width: 700, height: 500 })
    width = 0
    await act(async () => resized())
    expect(style()).toMatchObject({ width: 0, pointerEvents: 'none' })
    expect(shell.show).toHaveBeenCalledOnce()
    await act(async () => push({ revision: 2, surfaces: [surface({ revision: 2 })] }))
    expect(style()).toMatchObject({ left: 200, top: 100, width: 640, height: 360 })
  })

  it('keeps the previous chat’s page out of a new chat’s panel until the host has shown the new one', async () => {
    let push = (_snapshot: BrowserWebviewSnapshot) => {}
    const webviews: DesktopBrowserWebviewsBridge = {
      onChange: (listener) => { push = listener; return () => {} }, list: () => new Promise(() => {}),
      attach: vi.fn(async () => {}), presented: vi.fn(async () => {}),
    }
    let shown = () => {}
    const show = vi.fn(async () => {})
    const shell = { webviews, show, hide: vi.fn(async () => {}) } as unknown as DesktopBrowserBridge
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    function Frame({ chatId, x }: { chatId: string; x: number }) {
      const frame = useRef<HTMLDivElement>(null)
      useBrowserSlot({ bridge: shell, chatId, frame, active: true, presentation: 'sidebar', onError: vi.fn() })
      return <div ref={frame} data-frame={x} />
    }
    const nodes = (node: { props: Record<string, unknown> }) => node.props['data-frame']
      ? { getBoundingClientRect: () => ({ x: node.props['data-frame'], y: 50, width: 700, height: 500 }), parentElement: null }
      : node.props.className === 'h-full w-full' ? { appendChild: () => {} } : null
    await act(async () => { tree = create(<><Frame key="stage" chatId="stage" x={300} /><BrowserWebviewHost bridge={webviews} /></>, { createNodeMock: nodes }) })
    await paint()
    await act(async () => push({ revision: 1, surfaces: [surface({ fill: true })] }))
    const guest = () => tree!.root.findByProps({ 'data-browser-webview': 'tab' }).props
    expect(guest().style).toMatchObject({ left: 300 })

    show.mockImplementationOnce(() => new Promise<void>((resolve) => { shown = resolve }))
    await act(async () => { tree!.update(<><Frame key="work" chatId="work" x={900} /><BrowserWebviewHost bridge={webviews} /></>) })
    await paint()
    expect(show).toHaveBeenLastCalledWith(expect.anything(), 'work', undefined, 'sidebar')
    expect(guest()['data-presentation']).toBe('hidden')
    expect(guest().style).toMatchObject({ zIndex: -1 })

    await act(async () => { shown(); await Promise.resolve() })
    await paint()
    expect(guest()['data-presentation']).toBe('sidebar')
  })

  it('keeps a page hidden when a slot goes back to its chat before the other chat’s show lands', async () => {
    let push = (_snapshot: BrowserWebviewSnapshot) => {}
    const webviews: DesktopBrowserWebviewsBridge = {
      onChange: (listener) => { push = listener; return () => {} }, list: () => new Promise(() => {}),
      attach: vi.fn(async () => {}), presented: vi.fn(async () => {}),
    }
    const pending: (() => void)[] = []
    const show = vi.fn(async () => {})
    const shell = { webviews, show, hide: vi.fn(async () => {}) } as unknown as DesktopBrowserBridge
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    function Frame({ chatId, x }: { chatId: string; x: number }) {
      const frame = useRef<HTMLDivElement>(null)
      useBrowserSlot({ bridge: shell, chatId, frame, active: true, presentation: 'sidebar', onError: vi.fn() })
      return <div ref={frame} data-frame={x} />
    }
    const nodes = (node: { props: Record<string, unknown> }) => node.props['data-frame']
      ? { getBoundingClientRect: () => ({ x: node.props['data-frame'], y: 50, width: 700, height: 500 }), parentElement: null }
      : node.props.className === 'h-full w-full' ? { appendChild: () => {} } : null
    const view = (chatId: string, x: number) => <><Frame key={chatId} chatId={chatId} x={x} /><BrowserWebviewHost bridge={webviews} /></>
    await act(async () => { tree = create(view('a', 300), { createNodeMock: nodes }) })
    await paint()
    const guest = () => tree!.root.findByProps({ 'data-browser-webview': 'tab' }).props
    // B is on screen at A's old place by the time the slot comes back to A.
    show.mockImplementation(() => new Promise<void>((resolve) => { pending.push(resolve) }))
    await act(async () => { tree!.update(view('b', 900)) })
    await paint()
    await act(async () => push({ revision: 1, surfaces: [surface({ fill: true })] }))
    await act(async () => { tree!.update(view('a', 300)) })
    await paint()
    expect(guest()['data-presentation']).toBe('hidden')
    // The host answers from here on; A's own show, queued behind B's, then lands.
    show.mockImplementation(async () => {})
    await act(async () => { for (const resolve of pending) resolve(); for (let i = 0; i < 5; i++) await Promise.resolve() })
    await paint()
    expect(show).toHaveBeenLastCalledWith(expect.anything(), 'a', undefined, 'sidebar')
    expect(guest()['data-presentation']).toBe('sidebar')
  })

  it('hides the guest under a blank tab without giving the slot back to the host', async () => {
    let push = (_snapshot: BrowserWebviewSnapshot) => {}
    const webviews: DesktopBrowserWebviewsBridge = {
      onChange: (listener) => { push = listener; return () => {} }, list: () => new Promise(() => {}),
      attach: vi.fn(async () => {}), presented: vi.fn(async () => {}),
    }
    const show = vi.fn(async () => {})
    const hide = vi.fn(async () => {})
    const shell = { webviews, show, hide } as unknown as DesktopBrowserBridge
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    function Frame({ vacant }: { vacant: boolean }) {
      const frame = useRef<HTMLDivElement>(null)
      useBrowserSlot({ bridge: shell, chatId: 'a', frame, active: true, presentation: 'sidebar', vacant, onError: vi.fn() })
      return <div ref={frame} data-frame={300} />
    }
    const nodes = (node: { props: Record<string, unknown> }) => node.props['data-frame']
      ? { getBoundingClientRect: () => ({ x: 300, y: 50, width: 700, height: 500 }), parentElement: null }
      : node.props.className === 'h-full w-full' ? { appendChild: () => {} } : null
    const view = (vacant: boolean) => <><Frame vacant={vacant} /><BrowserWebviewHost bridge={webviews} /></>
    await act(async () => { tree = create(view(false), { createNodeMock: nodes }) })
    await paint()
    await act(async () => push({ revision: 1, surfaces: [surface({ fill: true })] }))
    const guest = () => tree!.root.findByProps({ 'data-browser-webview': 'tab' }).props
    expect(guest()['data-presentation']).toBe('sidebar')

    await act(async () => { tree!.update(view(true)) })
    await paint()
    expect(guest()['data-presentation']).toBe('hidden')
    expect(guest().style).toMatchObject({ pointerEvents: 'none' })
    expect(hide).not.toHaveBeenCalled()

    await act(async () => { tree!.update(view(false)) })
    await paint()
    expect(guest()['data-presentation']).toBe('sidebar')
    expect(hide).not.toHaveBeenCalled()
  })

  it('clips a sidebar page to what its scrolled panel row leaves on screen, the page keeping its size', async () => {
    let push = (_snapshot: BrowserWebviewSnapshot) => {}
    const webviews: DesktopBrowserWebviewsBridge = {
      onChange: (listener) => { push = listener; return () => {} }, list: () => new Promise(() => {}),
      attach: vi.fn(async () => {}), presented: vi.fn(async () => {}),
    }
    const shell = { webviews, show: vi.fn(async () => {}), hide: vi.fn(async () => {}) } as unknown as DesktopBrowserBridge
    let x = 700
    let resized = () => {}
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resized = callback }
      observe() {}
      disconnect() {}
    })
    // A row floating at 400–1000 that scrolls sideways, inside a static clipping box
    // the row escapes, being absolute against the stage beyond it.
    const stage = { getBoundingClientRect: () => ({ x: 0, y: 0 }), clientLeft: 0, clientTop: 0, clientWidth: 1000, clientHeight: 800, parentElement: null }
    const between = { getBoundingClientRect: () => ({ x: 800, y: 0 }), clientLeft: 0, clientTop: 0, clientWidth: 50, clientHeight: 50, parentElement: stage }
    const row = { getBoundingClientRect: () => ({ x: 400, y: 0 }), clientLeft: 0, clientTop: 0, clientWidth: 600, clientHeight: 800, parentElement: between }
    const styles = new Map<unknown, Partial<CSSStyleDeclaration>>([
      [row, { position: 'absolute', overflowX: 'auto', overflowY: 'auto' }],
      [between, { position: 'static', overflowX: 'hidden', overflowY: 'hidden' }],
      [stage, { position: 'relative', overflowX: 'visible', overflowY: 'visible' }],
    ])
    vi.stubGlobal('window', { innerWidth: 1600, innerHeight: 1000, addEventListener: vi.fn(), removeEventListener: vi.fn() })
    vi.stubGlobal('getComputedStyle', (node: unknown) => styles.get(node) ?? { position: 'static', overflowX: 'visible', overflowY: 'visible' })
    function Frame() {
      const frame = useRef<HTMLDivElement>(null)
      useBrowserSlot({ bridge: shell, chatId: 'chat', frame, active: true, presentation: 'sidebar', onError: vi.fn() })
      return <div ref={frame} data-frame />
    }
    await act(async () => { tree = create(<><Frame /><BrowserWebviewHost bridge={webviews} /></>, { createNodeMock: (node) =>
      node.props['data-frame'] ? { getBoundingClientRect: () => ({ x, y: 40, width: 640, height: 360 }), parentElement: row }
        : node.props.className === 'h-full w-full' ? { appendChild: () => {} } : null }) })
    await paint()
    await act(async () => push({ revision: 1, surfaces: [surface({ fill: true })] }))
    const style = () => tree!.root.findByProps({ 'data-browser-webview': 'tab' }).props.style
    const page = () => tree!.root.findByProps({ 'data-browser-page': true }).props.style
    expect(style()).toMatchObject({ left: 700, top: 40, width: 300, height: 360, pointerEvents: 'auto' })
    expect(page()).toEqual({ left: 0, top: 0, width: 640, height: 360 })
    expect(shell.show).toHaveBeenLastCalledWith({ x: 700, y: 40, width: 640, height: 360 }, 'chat', undefined, 'sidebar')

    // Scrolled back so the page's left edge sits before the row's: cut on that side.
    x = 200
    await act(async () => resized())
    expect(style()).toMatchObject({ left: 400, width: 440 })
    expect(page()).toMatchObject({ left: -200, width: 640 })

    // Scrolled out of the row entirely: nothing of it left to click.
    x = 1100
    await act(async () => resized())
    expect(style()).toMatchObject({ width: 0, pointerEvents: 'none' })
  })

  it('rounds a flush page where it meets the window inset, and keeps it square beside the chat', async () => {
    let push = (_snapshot: BrowserWebviewSnapshot) => {}
    const webviews: DesktopBrowserWebviewsBridge = {
      onChange: (listener) => { push = listener; return () => {} }, list: () => new Promise(() => {}),
      attach: vi.fn(async () => {}), presented: vi.fn(async () => {}),
    }
    const shell = { webviews, show: vi.fn(async () => {}), hide: vi.fn(async () => {}) } as unknown as DesktopBrowserBridge
    let width = 700
    let resized = () => {}
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resized = callback }
      observe() {}
      disconnect() {}
    })
    // The inset at 46,38 to 1276,796 with its 33px corner; a square clipper of the same box inside it.
    const inset = { getBoundingClientRect: () => ({ x: 46, y: 38 }), clientLeft: 0, clientTop: 0, clientWidth: 1230, clientHeight: 758, parentElement: null }
    const stage = { getBoundingClientRect: () => ({ x: 46, y: 38 }), clientLeft: 0, clientTop: 0, clientWidth: 1230, clientHeight: 758, parentElement: inset }
    const radius = (value: string) => ({ borderTopLeftRadius: value, borderTopRightRadius: value, borderBottomRightRadius: value, borderBottomLeftRadius: value })
    const styles = new Map<unknown, Partial<CSSStyleDeclaration>>([
      [inset, { position: 'relative', overflowX: 'hidden', overflowY: 'hidden', ...radius('33px') }],
      [stage, { position: 'relative', overflowX: 'hidden', overflowY: 'hidden', ...radius('0px') }],
    ])
    vi.stubGlobal('window', { innerWidth: 1280, innerHeight: 800, addEventListener: vi.fn(), removeEventListener: vi.fn() })
    vi.stubGlobal('getComputedStyle', (node: unknown) => styles.get(node) ?? { position: 'static', overflowX: 'visible', overflowY: 'visible', ...radius('0px') })
    function Frame() {
      const frame = useRef<HTMLDivElement>(null)
      useBrowserSlot({ bridge: shell, chatId: 'chat', frame, active: true, presentation: 'sidebar', onError: vi.fn() })
      return <div ref={frame} data-frame />
    }
    // The page under the tab strip, from the inset's left edge to the chat column's line.
    await act(async () => { tree = create(<><Frame /><BrowserWebviewHost bridge={webviews} /></>, { createNodeMock: (node) =>
      node.props['data-frame'] ? { getBoundingClientRect: () => ({ x: 46, y: 120, width, height: 676 }), parentElement: stage }
        : node.props.className === 'h-full w-full' ? { appendChild: () => {} } : null }) })
    await paint()
    await act(async () => push({ revision: 1, surfaces: [surface({ fill: true })] }))
    const style = () => tree!.root.findByProps({ 'data-browser-webview': 'tab' }).props.style
    expect(style()).toMatchObject({ left: 46, top: 120, width: 700, height: 676, borderRadius: '0px 0px 0px 33px' })
    expect(shell.show).toHaveBeenLastCalledWith({ x: 46, y: 120, width: 700, height: 676 }, 'chat', undefined, 'sidebar')

    // A fractional edge reaches the guest as it is, so it meets the divider exactly; the host gets whole pixels.
    width = 700.4
    await act(async () => resized())
    expect(style()).toMatchObject({ width: 700.4 })
    expect(shell.show).toHaveBeenLastCalledWith({ x: 46, y: 120, width: 700, height: 676 }, 'chat', undefined, 'sidebar')

    // Mid-slide, 20px short of the inset's right edge: the corner curves in step, inside the inset's arc.
    width = 1210
    await act(async () => resized())
    expect(style()).toMatchObject({ borderRadius: '0px 0px 13px 33px' })

    // The chat hidden: the page reaches the inset's right edge and takes that corner too.
    width = 1230
    await act(async () => resized())
    expect(style()).toMatchObject({ width: 1230, borderRadius: '0px 0px 33px 33px' })
    expect(tree!.root.findByProps({ 'data-browser-plate': true }).props.style.borderRadius).toBe('0px 0px 49.5px 49.5px')
    expect(shell.show).toHaveBeenLastCalledWith({ x: 46, y: 120, width: 1230, height: 676 }, 'chat', undefined, 'sidebar')

    // A device preview stands centred in the slot with the house corner, not the inset's.
    await act(async () => push({ revision: 2, surfaces: [surface({ revision: 2 })] }))
    expect(style().borderRadius).toBe('var(--radius-lg)')
  })
})
