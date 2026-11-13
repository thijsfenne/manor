import { useRef } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PLAN_DOCK, PinnedPlan, PlanDockProvider, planClearance, usePlanDock } from '../src/components/PinnedPlan'

/**
 * Jump to latest lifts by `--plan-dock`: where the pinned tasks card's top edge is
 * while it stands in the pill's way, 0 when it does not.
 */

// A 800px stage with a 100px composer: the pill rests 32px above it, 28px tall.
const STAGE_BOTTOM = 800
const COVERED = 100
const card = (top: number, bottom: number) => ({ top, bottom })

it('lifts the pill to the top of a card that sticks above the composer, folded or not', () => {
  // Sticks 12px above the composer: bottom at 688.
  expect(planClearance(STAGE_BOTTOM, card(488, 688), COVERED)).toBe(312)
  expect(planClearance(STAGE_BOTTOM, card(642, 688), COVERED)).toBe(158)
})

it('leaves the pill alone with no card, a card below the stage, or one above the pill', () => {
  expect(planClearance(STAGE_BOTTOM, null, COVERED)).toBe(0)
  expect(planClearance(STAGE_BOTTOM, card(820, 1000), COVERED)).toBe(0)
  // Mid-screen, its bottom edge well above where the pill rests (668 to 640).
  expect(planClearance(STAGE_BOTTOM, card(200, 400), COVERED)).toBe(0)
})

it('lifts for a card arriving from below, until its top is behind the composer', () => {
  expect(planClearance(STAGE_BOTTOM, card(600, 760), COVERED)).toBe(200)
  expect(planClearance(STAGE_BOTTOM, card(660, 820), COVERED)).toBe(140)
  expect(planClearance(STAGE_BOTTOM, card(680, 840), COVERED)).toBe(0)
  // The pill rests at 132 to 160 above the bottom: a card ending exactly there clears it.
  expect(planClearance(STAGE_BOTTOM, card(488, 640), COVERED)).toBe(0)
  expect(planClearance(STAGE_BOTTOM, card(488, 641), COVERED)).toBe(312)
})

let rects: { stage: { bottom: number }; card: { top: number; bottom: number } }
let stageStyle: { setProperty: ReturnType<typeof vi.fn>; getPropertyValue: (name: string) => string }
let resize: (() => void) | undefined
let view: ReactTestRenderer

beforeEach(() => {
  rects = { stage: { bottom: STAGE_BOTTOM }, card: { top: 488, bottom: 688 } }
  const values = new Map<string, string>()
  stageStyle = {
    setProperty: vi.fn((name: string, value: string) => values.set(name, value)),
    getPropertyValue: (name) => values.get(name) ?? '',
  }
  resize = undefined
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: (name: string) => (name === '--composer-dock' ? `${COVERED}px` : '') }))
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) {
      resize = callback
    }
    observe() {}
    disconnect() {
      resize = undefined
    }
  })
})
afterEach(() => vi.unstubAllGlobals())

function Stage({ pinned }: { pinned: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const dock = usePlanDock(ref)
  return (
    <PlanDockProvider value={dock}>
      <div ref={ref}>
        <PinnedPlan pinned={pinned}>plan</PinnedPlan>
      </div>
    </PlanDockProvider>
  )
}

const mount = (pinned: boolean) => {
  act(() => {
    view = create(<Stage pinned={pinned} />, {
      createNodeMock: (element) => (element.props.className === undefined
        ? { style: stageStyle, getBoundingClientRect: () => rects.stage }
        : { getBoundingClientRect: () => rects.card }),
    })
  })
}
const published = () => stageStyle.setProperty.mock.calls.map(([name, value]) => `${name}=${value}`)

it('follows the card as it folds, grows or scrolls', () => {
  mount(true)
  // The card's layout effect runs before the stage's ref attaches on a first mount, so
  // the observer's initial callback is what lands the first value.
  act(() => resize?.())
  rects.card = { top: 642, bottom: 688 }
  act(() => resize?.())
  rects.card = { top: 600, bottom: 760 }
  act(() => resize?.())
  expect(published().slice(-3)).toEqual([`${PLAN_DOCK}=312px`, `${PLAN_DOCK}=158px`, `${PLAN_DOCK}=200px`])
})

it('publishes only while pinned, and clears when the turn ends', () => {
  mount(false)
  expect(published()).toEqual([])
  act(() => view.update(<Stage pinned />))
  expect(published()).toEqual([`${PLAN_DOCK}=312px`])
  act(() => view.update(<Stage pinned={false} />))
  expect(published().at(-1)).toBe(`${PLAN_DOCK}=0px`)
  expect(resize).toBeUndefined()
})
