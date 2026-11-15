import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Popover } from './Popover'
import { useDismiss } from './useDismiss'
import { usePopupPlacement, type PopupPlacement } from './usePopupPlacement'

const CARD = 'fixed z-40 overflow-y-auto rounded-panel border border-line surface-floating p-1 shadow-menu'
/** What the arrow keys walk and what takes focus on open: every row that can be pressed. */
const ROWS = 'button:not(:disabled):not([aria-disabled="true"])'

/** The row a key moves focus to, or undefined where the key is not one a menu owns. */
export function menuFocusIndex(key: string, index: number, count: number): number | undefined {
  if (count === 0) return undefined
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  if (key === 'ArrowDown' || key === 'ArrowUp') return (index + (key === 'ArrowDown' ? 1 : -1) + count) % count
  return undefined
}

export interface MenuState {
  popup: RefObject<HTMLDivElement>
  open: boolean
  placement: PopupPlacement | null
  toggle(): void
  /** Focus returns to the trigger unless told not to, for a pick that moves focus itself. */
  close(refocus?: boolean): void
}

/**
 * A menu that hangs off a button and portals to the body: the browser's menus and the
 * rail's More panels. The caller draws the trigger and the rows; this holds what every
 * one of them did by hand. A press away or a moved layout closes it and leaves focus
 * where the press put it, a page field included. Escape closes it and returns focus to
 * the trigger. Opening hands focus to the first row.
 *
 * Gives the menu's state and, apart from it, the ref for the button that opens the
 * menu. That button also carries `aria-haspopup="menu"` and `aria-expanded={menu.open}`.
 * The ref stays out of the state because the React Compiler reads an object with a ref
 * in it as a ref, and then refuses every other field of it during render.
 *
 * `disabled` closes an open menu when its trigger goes dead. `onClose` runs on every
 * close, the trigger's own and that one included, for a menu with state of its own to
 * fold away.
 */
export function useMenu({ maxHeight, minHeight, minWidth, disabled = false, onClose }: {
  maxHeight: number
  minHeight: number
  minWidth: number
  disabled?: boolean
  onClose?: () => void
}): [MenuState, RefObject<HTMLButtonElement>] {
  const trigger = useRef<HTMLButtonElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const close = (refocus = true) => {
    setOpen(false)
    onClose?.()
    if (refocus) trigger.current?.focus()
  }
  const placement = usePopupPlacement({ open, triggerRef: trigger, maxHeight, minHeight, minWidth, align: 'end' })
  useDismiss(open, () => close(false), { within: [trigger, popup], onEscape: () => close(), layoutMoved: true })
  // Keyed on `disabled` alone: the menu closes when its trigger goes dead, not on every render it is dead.
  useEffect(() => { if (disabled && open) close(false) }, [disabled])
  // After it is placed: a sheet still hidden while it measures cannot take focus.
  useEffect(() => {
    if (open && placement) popup.current?.querySelector<HTMLButtonElement>(ROWS)?.focus()
  }, [open, placement])
  const toggle = () => { if (open) close(false); else setOpen(true) }
  return [{ popup, open, placement, toggle, close }, trigger]
}

/**
 * The sheet of a `useMenu`. Rows are plain buttons with a menu item role; the arrow
 * keys, Home and End move between the ones that can be pressed, wrapping at both ends.
 * `className` replaces the card where a menu has its own.
 */
export function Menu({ menu, label, className = CARD, children }: {
  menu: MenuState
  label: string
  className?: string
  children: ReactNode
}) {
  const { popup, open, placement } = menu
  if (typeof document === 'undefined') return null
  return createPortal(
    <Popover open={open} ref={popup} origin="top-right" className={className}
      style={placement ?? { visibility: 'hidden' }} role="menu" aria-label={label}>
      <div onKeyDown={(event) => {
        const rows = Array.from(popup.current?.querySelectorAll<HTMLButtonElement>(ROWS) ?? [])
        const next = menuFocusIndex(event.key, rows.indexOf(document.activeElement as HTMLButtonElement), rows.length)
        if (next === undefined) return
        event.preventDefault()
        rows[next]?.focus()
      }}>
        {children}
      </div>
    </Popover>, document.body)
}
