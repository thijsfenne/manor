import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { useStableCallback } from '../useStableCallback'

/**
 * The custom property the transcript stage publishes while a Session's pinned tasks
 * card stands in the way of Jump to latest: how far the card's top edge is above the
 * stage's bottom, in px, else `0px`. The pill lifts to `var(--plan-dock) + gap`.
 * Tailwind reads class names literally, so the pill spells that out itself.
 */
export const PLAN_DOCK = '--plan-dock'

/** Where Jump to latest rests above what the composer covers, and how tall it is (px): `h-7` on the pill. */
const PILL_REST = 32
const PILL_HEIGHT = 28

/**
 * How far above the stage's bottom the pill must lift to clear the card, or 0 when it
 * need not. The card only collides with the pill's resting spot when it reaches into
 * it from below: a card scrolled out of sight under the composer, or one standing
 * above the pill, leaves the pill where it is.
 */
export function planClearance(stageBottom: number, card: { top: number; bottom: number } | null, covered: number): number {
  if (card === null) return 0
  const top = stageBottom - card.top
  const bottom = stageBottom - card.bottom
  const restBottom = covered + PILL_REST
  return top > restBottom && bottom < restBottom + PILL_HEIGHT ? top : 0
}

type PlanDock = {
  attach: (element: HTMLElement | null) => void
  measure: () => void
}

const PlanDockContext = createContext<PlanDock | null>(null)
export const PlanDockProvider = PlanDockContext.Provider

/**
 * Keeps `--plan-dock` on `stageRef`'s element true to where the pinned card is. Call
 * `measure` when the thread scrolls or the stage resizes; the card calls it when its
 * own height changes, so a card that animates its height moves the pill frame by frame.
 * Written straight to the style, so none of it renders the transcript.
 */
export function usePlanDock(stageRef: RefObject<HTMLElement | null>) {
  const cardRef = useRef<HTMLElement | null>(null)
  const measure = useStableCallback(() => {
    const stage = stageRef.current
    if (stage === null) return
    const card = cardRef.current
    if (card === null) {
      // Nothing pinned, which is every DM and project thread: no geometry to read per scroll.
      if (stage.style.getPropertyValue(PLAN_DOCK) !== '') stage.style.setProperty(PLAN_DOCK, '0px')
      return
    }
    const style = getComputedStyle(stage)
    const covered = (parseFloat(style.getPropertyValue('--composer-dock')) || 0) + (parseFloat(style.getPropertyValue('--work-dock')) || 0)
    const px = planClearance(stage.getBoundingClientRect().bottom, card.getBoundingClientRect(), covered)
    stage.style.setProperty(PLAN_DOCK, `${px}px`)
  })
  const [dock] = useState<PlanDock>(() => ({
    attach: (element) => {
      cardRef.current = element
    },
    measure,
  }))
  return dock
}

/**
 * The slot a Session's plan stands in at the end of its turn. While `pinned` (the turn
 * runs) it sticks above the composer and tells the stage where it is as its height
 * changes. The element stays the same when the turn ends, so nothing remounts or moves.
 */
export function PinnedPlan({ pinned, children }: { pinned: boolean; children: ReactNode }) {
  const dock = useContext(PlanDockContext)
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (!pinned || dock === null || element === null) return undefined
    dock.attach(element)
    dock.measure()
    const observer = new ResizeObserver(dock.measure)
    observer.observe(element)
    return () => {
      observer.disconnect()
      dock.attach(null)
      dock.measure()
    }
  }, [pinned, dock])
  return (
    <div
      ref={ref}
      className={pinned ? 'mt-2.5 sticky bottom-[calc(var(--composer-dock,0px)+var(--work-dock,0px)+0.75rem)] z-[3]' : 'mt-2.5'}
    >
      {children}
    </div>
  )
}
