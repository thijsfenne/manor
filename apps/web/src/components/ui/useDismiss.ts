import { useEffect, useRef, type RefObject } from 'react'

interface DismissWhen {
  /**
   * A press outside every one of these dismisses. Omit it and presses are ignored,
   * which is what an overlay that cannot be pressed into wants.
   */
  within?: readonly RefObject<HTMLElement | null>[]
  /**
   * The page scrolled or the window resized. Anything positioned from a measurement
   * taken once is pointing at where its anchor used to be, so it leaves rather than
   * lies. Scroll is captured, because the scroller is usually an ancestor div and
   * scroll does not bubble.
   */
  layoutMoved?: boolean
  /**
   * The overlay's own body, for one that scrolls long content but takes no press
   * dismissal: its scroll is not `layoutMoved`. `within` does the same and more.
   */
  scrollsInside?: RefObject<HTMLElement | null>
  escape?: boolean
  /**
   * Escape, handled differently from a press outside. For an overlay with depth:
   * pressing away is always "I am done here", while Escape should undo one step. A
   * no-op is a legitimate value, and means Escape is owned by something inside.
   */
  onEscape?: () => void
  /** The window lost focus. For overlays nobody presses into, which cannot notice otherwise. */
  windowBlur?: boolean
  /** A right-click anywhere, so a second context menu never opens behind the first. */
  contextMenu?: boolean
}

/**
 * The ways out of an overlay, in one place. Every popup, menu, card and tooltip in
 * the house closes on some subset of these, and eight hand-rolled copies of the
 * same four listeners is how they drift apart.
 *
 * The callback and the refs are read through refs of their own, so a caller may
 * pass them inline without re-subscribing on every render.
 */
export function useDismiss(active: boolean, onDismiss: () => void, when: DismissWhen = {}): void {
  const { within, layoutMoved = false, scrollsInside, escape = false, onEscape, windowBlur = false, contextMenu = false } = when

  const dismiss = useRef(onDismiss)
  dismiss.current = onDismiss
  const inside = useRef(within)
  inside.current = within
  const body = useRef(scrollsInside)
  body.current = scrollsInside
  // Read through a ref so a handler closing over changing state (which step of a
  // popover is open, say) is never the one captured when the overlay first opened.
  const escaped = useRef(onEscape)
  escaped.current = onEscape

  const pressDismisses = within !== undefined
  const escapeDismisses = escape || onEscape !== undefined

  useEffect(() => {
    if (!active) return

    const away = () => dismiss.current()
    const contained = (node: EventTarget | null) =>
      node instanceof Node && inside.current?.some((ref) => ref.current?.contains(node) === true) === true
    const onPointerDown = (event: PointerEvent) => {
      if (contained(event.target)) return
      dismiss.current()
    }
    // A press on a browser page lands in its own guest process and never reaches this
    // document. What does arrive is focus leaving for the `<webview>` element, as a
    // focusin on it or a blur of this window, depending on how Chromium routes it.
    // Checked a tick later, once `activeElement` has settled on the guest.
    let pageCheck: ReturnType<typeof setTimeout> | undefined
    const onFocusLeft = () => {
      clearTimeout(pageCheck)
      pageCheck = setTimeout(() => {
        if (document.activeElement?.localName === 'webview') dismiss.current()
      }, 0)
    }
    // A popup that scrolls its own list, or that `scrollIntoView`s a row, is
    // not the page moving out from under it. Those land on a node inside
    // `within` and must not count as "layout moved".
    const onScroll = (event: Event) => {
      if (contained(event.target)) return
      if (event.target instanceof Node && body.current?.current?.contains(event.target) === true) return
      dismiss.current()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      // Claimed, like Dialog and Select claim theirs, so a page that also closes on
      // Escape (Settings) takes one step back rather than two.
      event.preventDefault()
      const handler = escaped.current
      if (handler === undefined) dismiss.current()
      else handler()
    }

    if (pressDismisses) {
      document.addEventListener('pointerdown', onPointerDown)
      document.addEventListener('focusin', onFocusLeft)
      window.addEventListener('blur', onFocusLeft)
    }
    if (layoutMoved) {
      window.addEventListener('scroll', onScroll, true)
      window.addEventListener('resize', away)
    }
    if (escapeDismisses) document.addEventListener('keydown', onKeyDown)
    if (windowBlur) window.addEventListener('blur', away)
    // A tick later so the right-click that opened this overlay, or a duplicate
    // contextmenu Electron sometimes fires for the same gesture, cannot close it.
    const contextMenuTimer = contextMenu
      ? window.setTimeout(() => document.addEventListener('contextmenu', away), 0)
      : undefined

    return () => {
      if (pressDismisses) {
        document.removeEventListener('pointerdown', onPointerDown)
        document.removeEventListener('focusin', onFocusLeft)
        window.removeEventListener('blur', onFocusLeft)
        clearTimeout(pageCheck)
      }
      if (layoutMoved) {
        window.removeEventListener('scroll', onScroll, true)
        window.removeEventListener('resize', away)
      }
      if (escapeDismisses) document.removeEventListener('keydown', onKeyDown)
      if (windowBlur) window.removeEventListener('blur', away)
      if (contextMenuTimer !== undefined) window.clearTimeout(contextMenuTimer)
      if (contextMenu) document.removeEventListener('contextmenu', away)
    }
  }, [active, pressDismisses, layoutMoved, escapeDismisses, windowBlur, contextMenu])
}
