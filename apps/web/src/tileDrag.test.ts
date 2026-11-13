import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { landingUnder, swallowReleaseClick, tileUnder, type TileLanding } from './components/TileDrag'

const pointer = (type: string, pointerId = 1) => Object.assign(new Event(type), { pointerId })
const click = (target: EventTarget) => {
  const event = new Event('click', { cancelable: true })
  target.dispatchEvent(event)
  return event.defaultPrevented
}

describe('the click after a tile drag', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test('a drop eats the click its own release fires, and not the next one', () => {
    const target = new EventTarget()
    swallowReleaseClick(target, 1, true)
    expect(click(target)).toBe(true)
    vi.runAllTimers()
    expect(click(target)).toBe(false)
  })

  test('after Escape it waits for the release still to come', () => {
    const target = new EventTarget()
    swallowReleaseClick(target, 1, false)
    vi.runAllTimers()
    target.dispatchEvent(pointer('pointerup'))
    expect(click(target)).toBe(true)
    vi.runAllTimers()
    expect(click(target)).toBe(false)
  })

  test('stands down when a new press shows the release was missed', () => {
    const target = new EventTarget()
    swallowReleaseClick(target, 1, false)
    target.dispatchEvent(pointer('pointerdown'))
    target.dispatchEvent(pointer('pointerup'))
    expect(click(target)).toBe(false)
  })
})

describe('the tile under a drag', () => {
  const rect = (left: number, width: number, top = 0, height = 800) => ({ left, top, right: left + width, bottom: top + height, width, height, x: left, y: top, toJSON: () => ({}) })
  // A split Work's left pane: its floating row is 378px wide from x 344 and scrolled to
  // the far end, so Side's column is mostly out of view, over the chat stage and beyond.
  const row = { getBoundingClientRect: () => rect(344, 378) }
  const cell = (left: number) => ({ getBoundingClientRect: () => rect(left, 300), parentElement: row })
  const cells = new Map([['side', cell(110)], ['agents', cell(422)]] as const)

  test('finds a tile where it is in view', () => {
    expect(tileUnder(cells, 'agents', 380, 400)?.target).toBe('side')
    expect(tileUnder(cells, 'side', 600, 400)?.target).toBe('agents')
  })

  test('ignores the part of a tile a scrolled row hides, and the pane beside it', () => {
    expect(tileUnder(cells, 'agents', 200, 400)).toBeNull()
    // The row overflows to the right before it is scrolled: Agents reaches into the other pane.
    const unscrolled = new Map([['side', cell(356)], ['agents', cell(656)]] as const)
    expect(tileUnder(unscrolled, 'side', 800, 400)).toBeNull()
    expect(tileUnder(unscrolled, 'side', 700, 400)?.target).toBe('agents')
  })
})

describe('the landing a drag shows', () => {
  // Beside Browser, a new column previewed over the chat from x 300 to 600.
  const beside: TileLanding = { target: 'browser', drop: 'left', box: { left: 300, top: 50, width: 300, height: 700 } }
  const swap: TileLanding = { target: 'agents', drop: 'swap', box: { left: 700, top: 50, width: 300, height: 700 } }

  test('holds while the pointer moves through the preview off the tiles', () => {
    expect(landingUnder(null, beside, 400, 400)).toBe(beside)
  })

  test('a tile under the pointer wins, and outside both there is none', () => {
    expect(landingUnder(swap, beside, 400, 400)).toBe(swap)
    expect(landingUnder(null, beside, 650, 400)).toBeNull()
    expect(landingUnder(null, null, 400, 400)).toBeNull()
  })
})
