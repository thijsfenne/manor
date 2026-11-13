import { useRef } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopBrowserBridge } from '@manor/contracts'
import { useBrowserFrame, useBrowserSlot } from '../src/useBrowserSlot'

let tree: ReactTestRenderer | undefined
const frames = new Map<number, FrameRequestCallback>()
let frameId = 0
let resized: () => void = () => {}
beforeEach(() => {
  frames.clear()
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resized = callback }
    observe() {}
    disconnect() {}
  })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
})
afterEach(async () => { await act(async () => tree?.unmount()); tree = undefined; vi.unstubAllGlobals(); vi.useRealTimers() })
async function tick() {
  await act(async () => { const pending = [...frames.values()]; frames.clear(); pending.forEach((callback) => callback(0)) })
}
function Slots({ bridge, sidebar }: { bridge: DesktopBrowserBridge; sidebar: boolean }) {
  const sidebarRef = useRef<HTMLDivElement>(null), floatingRef = useRef<HTMLDivElement>(null)
  useBrowserSlot({ bridge, chatId: 'chat', frame: sidebarRef, active: sidebar, presentation: 'sidebar', onError: vi.fn() })
  useBrowserSlot({ bridge, chatId: 'chat', frame: floatingRef, active: !sidebar, presentation: 'floating', onError: vi.fn() })
  return <><div ref={sidebarRef} /><div ref={floatingRef} /></>
}
const node = () => ({ getBoundingClientRect: () => ({ x: 12, y: 40, width: 384, height: 216 }) })
describe('browser slot ownership', () => {
  it('hands a single page from sidebar to floating without a competing hide', async () => {
    const show = vi.fn(async () => {}), hide = vi.fn(async () => {})
    const bridge = { webviews: {}, show, hide } as unknown as DesktopBrowserBridge
    await act(async () => { tree = create(<Slots bridge={bridge} sidebar />, { createNodeMock: node }) })
    await tick()
    expect(show).toHaveBeenLastCalledWith({ x: 12, y: 40, width: 384, height: 216 }, 'chat', undefined, 'sidebar')
    await act(async () => tree!.update(<Slots bridge={bridge} sidebar={false} />))
    await tick()
    expect(show).toHaveBeenLastCalledWith(expect.anything(), 'chat', undefined, 'floating')
    expect(hide).not.toHaveBeenCalled()
    await act(async () => tree!.update(<Slots bridge={bridge} sidebar />))
    await tick()
    expect(show).toHaveBeenLastCalledWith(expect.anything(), 'chat', undefined, 'sidebar')
    expect(hide).not.toHaveBeenCalled()
    await act(async () => tree!.unmount())
    expect(hide).toHaveBeenCalledOnce()
  })

  it('serializes a delayed show before handing off, and never activates old shells', async () => {
    let finish = () => {}
    const show = vi.fn<DesktopBrowserBridge['show']>(async () => {}).mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
    const hide = vi.fn(async () => {})
    const bridge = { webviews: {}, show, hide } as unknown as DesktopBrowserBridge
    await act(async () => { tree = create(<Slots bridge={bridge} sidebar />, { createNodeMock: node }) })
    await tick()
    await act(async () => tree!.update(<Slots bridge={bridge} sidebar={false} />))
    await tick()
    expect(show).toHaveBeenCalledOnce()
    await act(async () => finish())
    expect(show).toHaveBeenLastCalledWith(expect.anything(), 'chat', undefined, 'floating')
    expect(hide).not.toHaveBeenCalled()
    const old = { show: vi.fn(), hide: vi.fn() } as unknown as DesktopBrowserBridge
    await act(async () => tree!.update(<Slots bridge={old} sidebar />))
    await tick()
    expect(old.show).not.toHaveBeenCalled()
  })
})


describe('browser slot resize coalescing', () => {
  function delayedSlot() {
    let finish = () => {}
    let width = 384
    const show = vi.fn<DesktopBrowserBridge['show']>(async () => {}).mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
    const hide = vi.fn(async () => {})
    const bridge = { webviews: {}, show, hide } as unknown as DesktopBrowserBridge
    return { bridge, show, hide, finish: () => finish(),
      resize: (value: number) => { width = value },
      node: () => ({ getBoundingClientRect: () => ({ x: 12, y: 40, width, height: 216 }) }),
    }
  }

  it('sends only the latest width after a blocked show, then keeps reasserting', async () => {
    const slot = delayedSlot()
    await act(async () => { tree = create(<Slots bridge={slot.bridge} sidebar />, { createNodeMock: slot.node }) })
    await tick()
    for (let width = 400; width <= 800; width += 10) { slot.resize(width); resized(); await tick() }
    expect(slot.show).toHaveBeenCalledOnce()
    await act(async () => slot.finish())
    expect(slot.show.mock.calls.map(([bounds]) => bounds.width)).toEqual([384, 800])
    for (let i = 0; i < 30; i++) await tick()
    expect(slot.show.mock.calls.map(([bounds]) => bounds.width)).toEqual([384, 800])
  })

  it('discards queued widths when the slot is released and waits to hide', async () => {
    const slot = delayedSlot()
    await act(async () => { tree = create(<Slots bridge={slot.bridge} sidebar />, { createNodeMock: slot.node }) })
    await tick()
    for (let width = 400; width <= 800; width += 10) { slot.resize(width); resized(); await tick() }
    await act(async () => tree!.unmount())
    expect(slot.hide).not.toHaveBeenCalled()
    await act(async () => slot.finish())
    expect(slot.show).toHaveBeenCalledOnce()
    expect(slot.hide).toHaveBeenCalledOnce()
    await tick()
    expect(slot.show).toHaveBeenCalledOnce()
  })

  it('replaces queued sidebar widths with the newest floating bounds on handoff', async () => {
    const slot = delayedSlot()
    await act(async () => { tree = create(<Slots bridge={slot.bridge} sidebar />, { createNodeMock: slot.node }) })
    await tick()
    for (let width = 400; width <= 800; width += 10) { slot.resize(width); resized(); await tick() }
    await act(async () => tree!.update(<Slots bridge={slot.bridge} sidebar={false} />))
    slot.resize(384)
    await tick()
    slot.resize(320)
    resized()
    await tick()
    await act(async () => slot.finish())
    expect(slot.show.mock.calls.map(([bounds]) => bounds.width)).toEqual([384, 320])
    expect(slot.show).toHaveBeenLastCalledWith(expect.anything(), 'chat', undefined, 'floating')
    expect(slot.hide).not.toHaveBeenCalled()
  })
})


describe('live sidebar frame', () => {
  it('follows the measured frame while a show is still pending, and clears on handoff', async () => {
    let width = 384
    const show = vi.fn<DesktopBrowserBridge['show']>(() => new Promise<void>(() => {}))
    const bridge = { webviews: {}, show, hide: vi.fn(async () => {}) } as unknown as DesktopBrowserBridge
    const seen: (number | null)[] = []
    function Probe() { seen.push(useBrowserFrame(bridge.webviews)?.width ?? null); return null }
    const createNodeMock = () => ({ getBoundingClientRect: () => ({ x: 12, y: 40, width, height: 216 }) })
    await act(async () => { tree = create(<><Slots bridge={bridge} sidebar /><Probe /></>, { createNodeMock }) })
    await tick()
    expect(seen.at(-1)).toBe(384)
    width = 640
    await act(async () => resized())
    expect(show).toHaveBeenCalledOnce()
    expect(seen.at(-1)).toBe(640)
    await act(async () => tree!.update(<><Slots bridge={bridge} sidebar={false} /><Probe /></>))
    expect(seen.at(-1)).toBeNull()
  })
})

describe('browser slot layout failures', () => {
  it.each([false, true])('retries temporary failures but blocks a persistent profile failure (%s)', async (persistent) => {
    vi.useFakeTimers()
    let fail = (_reason: Error) => {}
    const show = vi.fn<DesktopBrowserBridge['show']>(async () => {}).mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { fail = reject }))
    const bridge = { webviews: {}, show, hide: vi.fn(async () => {}) } as unknown as DesktopBrowserBridge
    let width = 384
    await act(async () => { tree = create(<Slots bridge={bridge} sidebar />, {
      createNodeMock: () => ({ getBoundingClientRect: () => ({ x: 0, y: 0, width, height: 216 }) }),
    }) })
    await tick()
    width = 800
    resized()
    await tick()
    await act(async () => fail(new Error(persistent ? 'MANOR_BROWSER_PROFILE_UNAVAILABLE' : 'Layout interrupted')))
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    await tick()
    if (persistent) expect(show).toHaveBeenCalledOnce()
    else expect(show).toHaveBeenLastCalledWith(expect.objectContaining({ width: 800 }), 'chat', undefined, 'sidebar')
  })
})
