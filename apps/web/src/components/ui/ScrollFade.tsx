import { useCallback, useEffect, useRef, type ReactNode } from 'react'

/** How much scroll distance the edge takes to reach full strength, in pixels. */
const RAMP = 28

interface ScrollFadeProps {
  /** Sits on the outer box, so margins and `first:`/`last:` rules still see a child. */
  className?: string
  /** Sits on the scroller itself, for a row whose children are the scrolled items. */
  scrollerClassName?: string
  /** Names the scroller as a group, for a row of controls such as tabs. */
  label?: string
  children: ReactNode
}

/**
 * A horizontal scroller that says so. Each edge carries a gradient that is only there
 * while there is something behind it: it ramps up over the first {@link RAMP} pixels
 * of scroll and is gone again once that side has nothing left to hide, so a table
 * that fits shows no edges at all.
 *
 * The gradient fades to `--fade-to`, which defaults to the page background. A
 * container on a different surface sets that variable rather than passing a colour.
 *
 * Opacity is written straight to the DOM instead of held in state: this reacts to
 * every scroll frame, and a re-render per frame under a streaming reply is the one
 * thing the transcript cannot afford.
 */
export function ScrollFade({ className, scrollerClassName, label, children }: ScrollFadeProps) {
  const scroller = useRef<HTMLDivElement>(null)
  const start = useRef<HTMLDivElement>(null)
  const end = useRef<HTMLDivElement>(null)

  const sync = useCallback(() => {
    const box = scroller.current
    if (box === null) return
    const hidden = box.scrollWidth - box.clientWidth
    // Sub-pixel widths mean the far end lands a fraction short of the maximum, which
    // would leave a permanent sliver of gradient at a scroll the user cannot undo.
    const behindEnd = Math.max(0, hidden - box.scrollLeft - 1)
    if (start.current !== null) start.current.style.opacity = `${Math.min(1, box.scrollLeft / RAMP)}`
    if (end.current !== null) end.current.style.opacity = `${Math.min(1, behindEnd / RAMP)}`
  }, [])

  useEffect(() => {
    const box = scroller.current
    if (box === null) return
    sync()
    // The content decides whether there is anything to hide, and it keeps changing:
    // a reply streams in, the window resizes, an image inside finally loads.
    const observer = new ResizeObserver(sync)
    observer.observe(box)
    if (box.firstElementChild !== null) observer.observe(box.firstElementChild)
    // A row of items that already sit at their minimum width grows its overflow
    // without resizing anything, so an added or removed child counts as well.
    const children = new MutationObserver(sync)
    children.observe(box, { childList: true })
    return () => { observer.disconnect(); children.disconnect() }
  }, [sync])

  return (
    <div className={`relative ${className ?? ''}`}>
      <div ref={scroller} role={label === undefined ? undefined : 'group'} aria-label={label}
        className={`overflow-x-auto ${scrollerClassName ?? ''}`} onScroll={sync}>
        {children}
      </div>
      <div
        ref={start}
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-0 w-10 bg-gradient-to-r from-[var(--fade-to,var(--color-bg))] to-transparent opacity-0"
      />
      <div
        ref={end}
        aria-hidden
        className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-[var(--fade-to,var(--color-bg))] to-transparent opacity-0"
      />
    </div>
  )
}
