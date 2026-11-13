import { createElement, useRef } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import type { DesktopBrowserBridge } from '@manor/contracts'
import { useBrowserSlot } from './useBrowserSlot'

const callbacks = new Map<number, FrameRequestCallback>()
let nextFrame = 0
const pumpFrame = () => {
  const current = [...callbacks.values()]
  callbacks.clear()
  for (const callback of current) callback(0)
}

function Slot({ bridge }: { bridge: DesktopBrowserBridge }) {
  const frame = useRef<HTMLDivElement>(null)
  useBrowserSlot({ bridge, chatId: 'chat', frame, active: true, presentation: 'sidebar', onError: () => {} })
  return createElement('div', { ref: frame })
}

afterEach(() => { vi.unstubAllGlobals(); callbacks.clear() })

it('measures an idle browser slot once and updates it when its layout changes', async () => {
  const rect = { x: 10, y: 20, width: 300, height: 200 }
  const measure = vi.fn(() => rect)
  const node = { getBoundingClientRect: measure, parentElement: null }
  const show = vi.fn(async (_bounds: Parameters<DesktopBrowserBridge['show']>[0]) => {})
  const bridge = { webviews: {}, show, hide: async () => {} } as unknown as DesktopBrowserBridge
  const listeners = new Map<string, EventListenerOrEventListenerObject>()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callbacks.set(++nextFrame, callback); return nextFrame })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { callbacks.delete(id) })
  vi.stubGlobal('window', {
    addEventListener: (name: string, listener: EventListenerOrEventListenerObject) => listeners.set(name, listener),
    removeEventListener: (name: string) => listeners.delete(name),
  })
  vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
  let resized: (() => void) | undefined
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resized = callback }
    observe() {}
    disconnect() {}
  })
  let view: ReactTestRenderer
  act(() => { view = create(createElement(Slot, { bridge }), { createNodeMock: () => node }) })
  for (let index = 0; index < 120; index++) act(pumpFrame)
  await act(async () => {})
  expect(measure).toHaveBeenCalledTimes(1)
  expect(show).toHaveBeenCalledTimes(1)
  rect.x = 30
  act(() => { resized?.(); pumpFrame() })
  await act(async () => {})
  expect(show).toHaveBeenCalledTimes(2)
  expect(show.mock.lastCall?.[0]).toMatchObject({ x: 30 })
  act(() => view.unmount())
})
