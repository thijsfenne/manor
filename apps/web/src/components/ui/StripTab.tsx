import { Cancel01Icon } from '@hugeicons/core-free-icons'
import { Reorder } from 'motion/react'
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { INSTANT, TAB_REORDER } from '../../motion'
import { IconButton } from './IconButton'
import { Popover } from './Popover'
import { useDismiss } from './useDismiss'
import { usePopupPlacement } from './usePopupPlacement'

/** Present inside a `Reorder.Group`: the tab can be dragged to a new place. */
export interface StripTabReorder {
  dragging: boolean
  bounds: RefObject<HTMLDivElement | null>
  onDrop: () => void
}

export interface StripTabMenuItem {
  label: string
  onSelect: () => void
}

/**
 * One tab of a strip: the Browser's tabs and the content tabs of Knowledge and Files
 * share it, so a tab looks and moves the same wherever it stands.
 */
export function StripTab({
  id,
  name,
  title,
  leading,
  active,
  disabled,
  pinned = false,
  closeOnActive = false,
  slim = false,
  badge,
  menu,
  onSelect,
  onClose,
  reorder,
}: {
  /** The tab's value inside a `Reorder.Group`. */
  id: string
  /** The visible label, and the name the close mark and menu are read with. */
  name: string
  title: string
  /** The tab's mark: a favicon, a globe, a file glyph. A pinned tab shows only this. */
  leading: ReactNode
  active: boolean
  disabled: boolean
  /** The square, mark-only shape of a pinned Browser tab, which has no close mark. */
  pinned?: boolean
  /** The active tab keeps its close mark showing, not only on hover. */
  closeOnActive?: boolean
  /** Two px shorter, for a strip in the 38px top bar: as far from its edges as from its neighbours. */
  slim?: boolean
  /** A mark after the label, such as the Browser's unseen dot. */
  badge?: ReactNode
  /** The context menu's items (also on Shift+F10); absent, the tab has no menu. */
  menu?: readonly StripTabMenuItem[]
  onSelect: () => void
  onClose: () => void
  reorder?: StripTabReorder
}) {
  const trigger = useRef<HTMLSpanElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  // The menu mounts on its first open, so a strip of tabs keeps no idle popups in the page.
  const [menuUsed, setMenuUsed] = useState(false)
  const openMenu = () => { setMenuUsed(true); setMenuOpen(true) }
  // Motion keeps an item with ref drag bounds at the same fraction of those bounds
  // whenever the window, the tab or its group resizes. For a tab at rest that is a
  // stray offset, and resizing the panel stacked tabs on top of each other. The
  // bounds are therefore handed over only while the tab is pressed. The release is
  // heard on the window: a press let go just past the tab's edge, short of a drag,
  // never reaches the tab itself.
  const [held, setHeld] = useState(false)
  useEffect(() => {
    if (!held) return
    const release = () => setHeld(false)
    window.addEventListener('pointerup', release)
    window.addEventListener('pointercancel', release)
    return () => {
      window.removeEventListener('pointerup', release)
      window.removeEventListener('pointercancel', release)
    }
  }, [held])
  const placement = usePopupPlacement({ open: menuOpen, triggerRef: trigger, maxHeight: 240, minHeight: 80, minWidth: 156 })
  useDismiss(menuOpen, () => setMenuOpen(false), {
    within: [trigger, popup], layoutMoved: true, contextMenu: true,
    onEscape: () => { setMenuOpen(false); trigger.current?.querySelector('button')?.focus() },
  })
  // A tab opened past the strip's edge is scrolled to, so the one you are on is always in view.
  useEffect(() => {
    if (active) trigger.current?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
  }, [active])
  const hasMenu = menu !== undefined && menu.length > 0
  const closeShown = closeOnActive && active
  const shell = {
    'data-strip-tab': id,
    onContextMenu: (event: ReactMouseEvent) => { event.preventDefault(); if (!disabled && hasMenu) openMenu() },
    // A middle click closes a tab, as in a browser.
    onAuxClick: (event: ReactMouseEvent) => { if (event.button === 1 && !pinned && !disabled) { event.preventDefault(); onClose() } },
    // The title runs to the tab's edge and only gives way, by the close mark's own
    // width, while the mark is showing on hover or keyboard focus.
    className: `group relative flex ${slim ? 'h-[30px]' : 'h-8'} items-center rounded-button ${pinned ? 'w-9 flex-none justify-center' : `min-w-[90px] max-w-[200px] flex-[1_1_200px] gap-1.5 px-2 hover:pr-6 has-[:focus-visible]:pr-6 ${closeShown ? 'pr-6' : ''}`} ${
      active ? 'bg-surface-2 text-text' : 'text-muted hover:bg-surface-2/60'
    }`,
  }
  const openMenuKey = (event: KeyboardEvent) => { if (event.shiftKey && event.key === 'F10' && hasMenu) { event.preventDefault(); openMenu() } }
  const menuItem = 'w-full cursor-pointer rounded-button-sm border-0 bg-transparent px-3 py-2 text-left text-label text-text hover:bg-user-bg disabled:cursor-default'
  const body = (
    <>
      {pinned ? (
        <button type="button" className="grid h-full w-full cursor-pointer place-items-center border-0 bg-transparent p-0 disabled:cursor-default"
          aria-label={`${name}, pinned tab`} title={title}
          disabled={disabled} onClick={onSelect} onKeyDown={openMenuKey}>
          {leading}
        </button>
      ) : (
        <>
          {leading}
          <button type="button"
            className="min-w-0 flex-1 cursor-pointer truncate border-0 bg-transparent p-0 text-left text-meta disabled:cursor-default"
            title={title} aria-current={active ? 'page' : undefined}
            disabled={disabled} onClick={onSelect} onKeyDown={openMenuKey}>
            {name}
          </button>
        </>
      )}
      {badge}
      {pinned ? null : <IconButton
        icon={Cancel01Icon}
        iconSize={12}
        size={20}
        label={`Close ${name}`}
        className={`absolute top-1/2 right-1 -translate-y-1/2 ${closeShown ? '' : 'opacity-0'} group-hover:opacity-100 group-has-[:focus-visible]:opacity-100`}
        disabled={disabled}
        onClick={onClose}
      />}
      {!hasMenu || !menuUsed ? null : createPortal(
        <Popover open={menuOpen} ref={popup} onReady={() => popup.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()}
          style={placement ?? { visibility: 'hidden' }}
          className="fixed z-40 rounded-panel border border-line surface-floating p-1 shadow-menu"
          role="menu" aria-label={`${name} tab actions`}>
          {menu.map((item) => (
            <button key={item.label} type="button" role="menuitem" disabled={disabled} className={menuItem}
              onClick={() => { setMenuOpen(false); item.onSelect() }}>{item.label}</button>
          ))}
        </Popover>, document.body,
      )}
    </>
  )
  if (reorder === undefined) return <span ref={trigger} {...shell}>{body}</span>
  return (
    <Reorder.Item as="span" ref={trigger} value={id} {...shell}
      drag={disabled ? false : 'x'}
      // A tab stops at its group's ends, as in a browser, instead of sliding under
      // the strip's clipped edge or into the pins.
      dragConstraints={held ? reorder.bounds : undefined}
      dragElastic={0}
      // Neighbours slide aside only during a drag; any other layout change (a tab
      // closing, the panel resizing) lands at once, as it did before tabs could move.
      layout="position"
      transition={{ layout: reorder.dragging ? TAB_REORDER : INSTANT }}
      // Ctrl+click is the context click on macOS. Its menu swallows the release, so a
      // press with Ctrl must not arm a drag that would never end.
      onPointerDownCapture={(event: ReactPointerEvent) => { if (event.ctrlKey) event.stopPropagation() }}
      onPointerDown={() => { if (!disabled) setHeld(true) }}
      onDragEnd={reorder.onDrop}>
      {body}
    </Reorder.Item>
  )
}
