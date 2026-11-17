import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { scrollWithin } from '../src/components/scrollWithin'

// A transcript scroller 400px tall over 2000px of thread, inside an app frame that
// itself overflows: the layout in which `scrollIntoView` used to slide the frame up.
const frame = { scrollTop: 0 }
const scroller = (scrollTop: number) => {
  const box = {
    scrollTop,
    clientHeight: 400,
    scrollHeight: 2000,
    parentElement: frame,
    getBoundingClientRect: () => ({ top: 100 }),
    scrollTo: vi.fn(({ top }: { top: number }) => { box.scrollTop = top }),
  }
  return box
}
/** A message whose top sits `offset` px below the scroller's current top. */
const message = (offset: number, height = 100) => ({
  offsetHeight: height,
  getBoundingClientRect: () => ({ top: 100 + offset }),
  scrollIntoView: vi.fn(),
})
const jump = (box: ReturnType<typeof scroller>, target: ReturnType<typeof message>, block: 'center' | 'start' = 'center') =>
  scrollWithin(box as unknown as HTMLElement, target as unknown as HTMLElement, { block })

describe('scrollWithin', () => {
  let margins = { scrollMarginTop: '0px', scrollMarginBottom: '0px' }
  beforeEach(() => {
    frame.scrollTop = 0
    margins = { scrollMarginTop: '0px', scrollMarginBottom: '0px' }
    vi.stubGlobal('getComputedStyle', () => margins)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('leaves everything still when the transcript is at its end and the source is already on screen', () => {
    const box = scroller(1600)
    const source = message(250)
    jump(box, source)
    expect(box.scrollTo).not.toHaveBeenCalled()
    expect(box.scrollTop).toBe(1600)
    expect(frame.scrollTop).toBe(0)
    expect(source.scrollIntoView).not.toHaveBeenCalled()
  })

  it('centres an off-screen source by scrolling the transcript alone', () => {
    const box = scroller(1600)
    const source = message(-900)
    jump(box, source)
    expect(box.scrollTo).toHaveBeenCalledWith({ top: 1600 - 900 - 150, behavior: 'auto' })
    expect(frame.scrollTop).toBe(0)
    expect(source.scrollIntoView).not.toHaveBeenCalled()
  })

  it('clamps to the top of the thread', () => {
    const box = scroller(100)
    jump(box, message(-80))
    expect(box.scrollTop).toBe(0)
  })

  it('lands a tall message on its first line, short of its top scroll margin', () => {
    margins = { scrollMarginTop: '64px', scrollMarginBottom: '0px' }
    const box = scroller(0)
    jump(box, message(800, 600), 'start')
    expect(box.scrollTop).toBe(800 - 64)
  })
})
