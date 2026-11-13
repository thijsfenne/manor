import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RIGHT_PANEL_MOTION_MS, useLingeringPanel } from '../src/useRightPanel'

function Panel({ active, instant = false }: { active: string | null; instant?: boolean }) {
  return createElement('aside', null, useLingeringPanel(active, RIGHT_PANEL_MOTION_MS, instant))
}

let view: ReactTestRenderer
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('window', { setTimeout, clearTimeout })
  act(() => { view = create(createElement(Panel, { active: 'agents' })) })
})
afterEach(() => {
  act(() => view.unmount())
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('panel content during navigation', () => {
  it('removes the previous chat panel immediately on an instant switch', () => {
    act(() => view.update(createElement(Panel, { active: null, instant: true })))
    expect(view.root.findByType('aside').children).toEqual([])
  })

  it('keeps content through an ordinary closing animation, then releases it', () => {
    act(() => view.update(createElement(Panel, { active: null })))
    expect(view.root.findByType('aside').children).toEqual(['agents'])
    act(() => { vi.advanceTimersByTime(RIGHT_PANEL_MOTION_MS) })
    expect(view.root.findByType('aside').children).toEqual([])
  })

  it('cancels a pending close when a different panel opens', () => {
    act(() => view.update(createElement(Panel, { active: null })))
    act(() => view.update(createElement(Panel, { active: 'files', instant: true })))
    act(() => { vi.advanceTimersByTime(RIGHT_PANEL_MOTION_MS) })
    expect(view.root.findByType('aside').children).toEqual(['files'])
  })
})
