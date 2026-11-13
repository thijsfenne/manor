import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { IconSvgElement } from '@hugeicons/react'
import { motion, useReducedMotion } from 'motion/react'
import { EASE_OUT, INSTANT } from '../../motion'
import { Tick02Icon } from '@hugeicons/core-free-icons'
import { Icon } from '../Icon'
import { useDismiss } from './useDismiss'

export interface ContextMenuItem {
  label: string
  icon?: IconSvgElement
  /** A mark that is not a HugeIcons glyph, such as an app's logo; drawn where `icon` would be. */
  mark?: ReactNode
  tone?: 'default' | 'danger'
  /** A choice that holds: shown with a tick while on, and read out as checked. */
  checked?: boolean
  disabled?: boolean
  /** Draws a hairline above the item, to set a group apart. */
  separatorBefore?: boolean
  onSelect: () => void
}

interface ContextMenuProps {
  x: number
  y: number
  items: ContextMenuItem[]
  onClose: () => void
}

const INSET = 8

/** A compact desktop context menu, positioned at the pointer and kept on screen. */
export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ x, y })
  const reduce = useReducedMotion() ?? false

  useLayoutEffect(() => {
    const menu = menuRef.current
    if (menu === null) return
    // Layout size, not the bounding rect: the entry animation starts scaled down, and
    // a scaled rect would place a window-tall menu past the bottom edge.
    const bounds = { width: menu.offsetWidth, height: menu.offsetHeight }
    setPosition({
      x: Math.max(INSET, Math.min(x, window.innerWidth - bounds.width - INSET)),
      y: Math.max(INSET, Math.min(y, window.innerHeight - bounds.height - INSET)),
    })
    menu.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
  }, [x, y])

  useDismiss(true, onClose, {
    within: [menuRef],
    layoutMoved: true,
    escape: true,
    windowBlur: true,
    contextMenu: true,
  })

  return createPortal(
    <motion.div
      ref={menuRef}
      // Never taller than the window less its inset on both sides; a long list scrolls.
      className="fixed z-40 max-h-[calc(100dvh-16px)] min-w-[184px] overflow-y-auto overscroll-contain rounded-lg border border-line surface-floating p-1 shadow-menu"
      style={{ left: position.x, top: position.y, transformOrigin: 'top left' }}
      initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: -4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={reduce ? INSTANT : { duration: 0.18, ease: EASE_OUT }}
      role="menu"
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item, index) => [
        item.separatorBefore === true ? <div key={`${index}:separator`} role="separator" className="mx-1 my-1 border-t border-line" /> : null,
        <button
          type="button"
          className={`flex w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2.5 py-1.5 text-left text-label disabled:cursor-default disabled:opacity-45 disabled:hover:bg-transparent ${
            item.tone === 'danger'
              ? 'text-danger hover:bg-[color-mix(in_srgb,var(--color-danger)_12%,transparent)]'
              : 'text-text hover:bg-user-bg'
          }`}
          key={`${index}:${item.label}`}
          role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
          aria-checked={item.checked}
          disabled={item.disabled}
          onClick={() => {
            item.onSelect()
            onClose()
          }}
        >
          {item.mark !== undefined ? <span className="flex flex-none text-muted">{item.mark}</span>
            : item.icon === undefined ? null : <Icon icon={item.icon} size={14} className="flex-none" />}
          <span className="min-w-0 flex-1 truncate">{item.label}</span>
          {item.checked === true ? <Icon icon={Tick02Icon} size={13} className="flex-none" /> : null}
        </button>,
      ])}
    </motion.div>,
    document.body,
  )
}
