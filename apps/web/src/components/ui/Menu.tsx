import { useEffect, useRef, useState, type ComponentProps, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Tick02Icon } from '@hugeicons/core-free-icons'
import { Icon } from '../Icon'
import { Popover } from './Popover'
import { useDismiss } from './useDismiss'
import { usePopupPlacement, type PopupPlacement } from './usePopupPlacement'

/** The card every menu sits in. For a menu that places itself, the composer's among them. */
export const MENU_SURFACE = 'rounded-panel border border-line surface-floating p-1'
const CARD = `fixed z-40 overflow-y-auto ${MENU_SURFACE} shadow-menu`
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
 * The sheet of a `useMenu`. Rows are `MenuItem`s; the arrow keys, Home and End move
 * between the ones that can be pressed, wrapping at both ends.
 */
export function Menu({ menu, label, children }: {
  menu: MenuState
  label: string
  children: ReactNode
}) {
  const { popup, open, placement } = menu
  if (typeof document === 'undefined') return null
  return createPortal(
    <Popover open={open} ref={popup} origin="top-right" className={CARD}
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

/**
 * One row of a menu, the same in every menu: an icon where the row is an action, the
 * label, then what sits at the far end (a shortcut, a detail, a chevron). Rows that
 * list the user's own things, a session, a bookmark, a login, go without an icon
 * unless the whole menu has them, so the labels of one menu always line up.
 *
 * `checked` makes the row a choice: it sets `aria-checked` and draws the tick. A row
 * that is not the choice and has something at its far end holds the tick's place, so
 * what trails the labels lines up. The caller names the role (`menuitemradio` or `menuitemcheckbox`). `blocked` is a row
 * that exists and cannot be taken now: it does nothing on a press and the arrow keys
 * pass over it, but it is not `disabled`, so its reason still shows on hover. It dims
 * by colour, not opacity, so a reason the caller puts in the row stays readable.
 * `disabled` is for a row with nothing to say.
 */
export function MenuItem({ icon, trailing, checked, blocked, role = 'menuitem', children, ...button }: Omit<ComponentProps<'button'>, 'type' | 'className' | 'aria-checked' | 'aria-disabled'> & {
  icon?: ComponentProps<typeof Icon>['icon']
  trailing?: ReactNode
  checked?: boolean
  blocked?: string
}) {
  const dead = blocked !== undefined
  return (
    <button {...button} type="button" role={role} aria-checked={checked} aria-disabled={dead || undefined} title={blocked ?? button.title}
      onClick={dead ? undefined : button.onClick}
      className={`flex w-full items-center gap-2 rounded-button-sm border-0 bg-transparent px-3 py-2 text-left text-label disabled:cursor-default disabled:opacity-40 ${
        dead ? 'cursor-default text-dim' : 'cursor-pointer text-text hover:bg-user-bg focus-visible:bg-user-bg'
      }`}>
      {icon === undefined ? null : <Icon icon={icon} size={15} className={dead ? 'flex-none' : 'flex-none text-muted'} />}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {typeof trailing === 'string' ? <span className={dead ? 'flex-none text-meta' : 'flex-none text-meta text-muted'}>{trailing}</span> : trailing}
      {checked === true ? <Icon icon={Tick02Icon} size={13} className="flex-none" /> : null}
      {checked === false && trailing != null ? <span className="w-[13px] flex-none" aria-hidden="true" /> : null}
    </button>
  )
}
