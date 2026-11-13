import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import { CARD_EXIT_MS } from './HoverCard'

/**
 * Long enough that running the pointer down the sidebar opens nothing, short enough
 * that stopping on a row feels like it answered. The close grace is what lets the
 * pointer cross the gap between the row and the card.
 */
const OPEN_DELAY_MS = 320
const CLOSE_DELAY_MS = 140

interface HoverCardOptions {
  /**
   * Claimed while a card is on screen. The card hangs beside the sidebar rather than
   * inside it, so a pointer moving into it is a pointer that left, and the peek it is
   * anchored to would fold out from under it.
   */
  onHoldPeek?: (claim: boolean) => void
  /**
   * True while rows are being dragged. A card is anchored to where its row was when
   * it opened, so a drag would drag the row out from under it: grabbing anything
   * closes every card outright, and no new one may arm.
   */
  suspended?: boolean
}

interface HoverCardState<E extends HTMLElement> {
  /** Put this on the element the card should sit beside. */
  anchorRef: MutableRefObject<E | null>
  /** Null when nothing is up; `open: false` while the exit animation still runs. */
  card: { anchor: DOMRect; open: boolean } | null
  /** Opens now, cancelling any pending open or close. */
  show: () => void
  /** Starts the fade out and unmounts once it has run its length. */
  hide: () => void
  /** Snaps the card away with no fade. For a right-click, which owns the pointer. */
  dismiss: () => void
  /** Arms the open delay. Ignores anything that is not a mouse: touch has no hover. */
  scheduleShow: (event: { pointerType: string }) => void
  scheduleHide: () => void
}

/**
 * The timing and the anchor behind a row's hover card. Two rows in the sidebar wear
 * one, on the same two delays, and the pair of timers plus the exit-hold state is
 * the whole of what they had in common.
 */
export function useHoverCard<E extends HTMLElement>({
  onHoldPeek,
  suspended = false,
}: HoverCardOptions = {}): HoverCardState<E> {
  const anchorRef = useRef<E | null>(null)
  // Kept mounted with `open: false` for as long as its fade lasts, so the card
  // leaves the way it arrived instead of being cut.
  const [card, setCard] = useState<{ anchor: DOMRect; open: boolean } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const exit = useRef<ReturnType<typeof setTimeout>>(undefined)

  // A pending open that fires after this row is gone would point a card at nothing.
  useEffect(
    () => () => {
      clearTimeout(timer.current)
      clearTimeout(exit.current)
    },
    [],
  )

  // The hold outlasts the fade, which is the stretch where the card is still on
  // screen with nothing under the pointer.
  const cardUp = card !== null
  useEffect(() => {
    if (!cardUp || onHoldPeek === undefined) return
    onHoldPeek(true)
    return () => onHoldPeek(false)
  }, [cardUp, onHoldPeek])

  useEffect(() => {
    if (!suspended) return
    clearTimeout(timer.current)
    clearTimeout(exit.current)
    setCard(null)
  }, [suspended])

  const show = () => {
    clearTimeout(timer.current)
    clearTimeout(exit.current)
    const anchor = anchorRef.current
    if (anchor !== null) setCard({ anchor: anchor.getBoundingClientRect(), open: true })
  }

  const hide = () => {
    clearTimeout(timer.current)
    clearTimeout(exit.current)
    setCard((current) => (current === null ? null : { ...current, open: false }))
    exit.current = setTimeout(() => setCard(null), CARD_EXIT_MS)
  }

  const dismiss = () => {
    clearTimeout(timer.current)
    clearTimeout(exit.current)
    setCard(null)
  }

  const scheduleShow = (event: { pointerType: string }) => {
    // Touch has no hover, so a finger resting on the row must not arm anything. A row
    // the drag passes over is not a row the pointer is resting on either.
    if (event.pointerType !== 'mouse' || suspended) return
    clearTimeout(timer.current)
    timer.current = setTimeout(show, OPEN_DELAY_MS)
  }

  const scheduleHide = () => {
    clearTimeout(timer.current)
    timer.current = setTimeout(hide, CLOSE_DELAY_MS)
  }

  return { anchorRef, card, show, hide, dismiss, scheduleShow, scheduleHide }
}
