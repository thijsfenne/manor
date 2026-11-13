import { useLayoutEffect, useRef, type ComponentProps } from 'react'

/**
 * A docked panel's card. The region keeps a closing panel mounted while it slides
 * shut, but a close usually clears the panel's selection in the same update, which
 * would swap the open file or note for the empty state mid-slide. While `revealed` is
 * false the card keeps the content it last showed open, inert so a held editor takes
 * no keystrokes its cleared state would drop; its own attributes stay live, so the
 * slide itself still runs. Reopening shows live content again at once, and a close
 * reversed mid-slide gives focus back to where it was in the card.
 */
export function DockPanelAside({ revealed, children, ...props }: ComponentProps<'aside'> & { revealed: boolean }) {
  const card = useRef<HTMLElement>(null)
  const held = useRef(children)
  if (revealed) held.current = children
  const focusedAtClose = useRef<HTMLElement | null>(null)

  // Layout effects run before the browser moves focus off the now-inert card.
  useLayoutEffect(() => {
    const node = card.current
    if (node === null) return
    const active = node.ownerDocument.activeElement
    if (!revealed) {
      focusedAtClose.current = active instanceof HTMLElement && node.contains(active) ? active : null
      return
    }
    const target = focusedAtClose.current
    focusedAtClose.current = null
    if (target?.isConnected && (active === null || active === node.ownerDocument.body)) target.focus({ preventScroll: true })
  }, [revealed])

  return (
    <aside {...props} ref={card} {...(revealed ? {} : { inert: '' })}>
      {revealed ? children : held.current}
    </aside>
  )
}
