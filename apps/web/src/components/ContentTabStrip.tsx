import { PlusSignIcon } from '@hugeicons/core-free-icons'
import { motion, Reorder } from 'motion/react'
import { useRef, useState, type DragEvent, type ReactNode } from 'react'
import { TAB_REORDER } from '../motion'
import { IconButton } from './ui/IconButton'
import { ScrollFade } from './ui/ScrollFade'
import { StripTab, type StripTabMenuItem } from './ui/StripTab'

export interface StripItem {
  id: string
  name: string
  title: string
  leading?: ReactNode
  /** The surface's own menu items, ahead of the strip's move and close. */
  menu?: readonly StripTabMenuItem[]
}

/** A sidebar entry dragged onto the strip; the surface decides which drags it takes. */
export interface StripDrop {
  accepts: (event: DragEvent<HTMLElement>) => boolean
  /** The dropped entry's path, or null when the drop is not one the surface opens. */
  read: (event: DragEvent<HTMLElement>) => string | null
  onDrop: (path: string, index: number) => void
}

/** A tab missing from a drag's order (opened mid-drag) sorts after the ones it holds. */
const rankIn = (order: readonly string[], id: string) => {
  const index = order.indexOf(id)
  return index === -1 ? order.length : index
}

/**
 * The tab strip of a content surface in the top bar: Knowledge's notes, a Files
 * panel's files. Tabs reorder by drag as the Browser's do; a sidebar entry dropped on
 * the strip opens in a new tab where the marker stands.
 */
export function ContentTabStrip({
  label,
  items,
  activeId,
  disabled = false,
  newLabel,
  slim = false,
  onSelect,
  onClose,
  onMove,
  onNew,
  drop,
}: {
  /** Names the strip, such as `Note tabs`. */
  label: string
  items: readonly StripItem[]
  activeId: string | null
  disabled?: boolean
  newLabel: string
  /** Tabs sized for the top bar rather than a panel header. */
  slim?: boolean
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onMove: (id: string, index: number) => void
  onNew: () => void
  drop: StripDrop
}) {
  const group = useRef<HTMLDivElement>(null)
  const strip = useRef<HTMLDivElement>(null)
  // While a tab is dragged the strip follows the pointer's order; the surface's own
  // order lands once the tab is let go.
  const [dragOrder, setDragOrder] = useState<string[] | null>(null)
  // The drop handler reads the order the pointer reached, which may not have rendered yet.
  const dragOrderRef = useRef<string[] | null>(null)
  const shown = dragOrder === null ? items : [...items].sort((left, right) => rankIn(dragOrder, left.id) - rankIn(dragOrder, right.id))
  // Where a dragged sidebar entry would land, as an index and the marker's offset.
  const [marker, setMarker] = useState<{ index: number; x: number } | null>(null)

  const dropTab = (id: string) => {
    const order = dragOrderRef.current
    dragOrderRef.current = null
    setDragOrder(null)
    const index = order?.indexOf(id) ?? -1
    if (index !== -1 && index !== items.findIndex((item) => item.id === id)) onMove(id, index)
  }

  /** The gap nearest the pointer: before the first tab whose middle lies right of it. */
  const markerAt = (clientX: number) => {
    const box = strip.current
    if (box === null) return null
    const origin = box.getBoundingClientRect().left
    const tabs = [...(group.current?.querySelectorAll<HTMLElement>('[data-strip-tab]') ?? [])]
    for (const [index, tab] of tabs.entries()) {
      const rect = tab.getBoundingClientRect()
      if (clientX < rect.left + rect.width / 2) return { index, x: rect.left - origin - 2 }
    }
    const last = tabs.at(-1)?.getBoundingClientRect()
    return { index: tabs.length, x: last === undefined ? 0 : last.right - origin + 2 }
  }

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (disabled || !drop.accepts(event)) return
    event.preventDefault()
    // The sidebar drags as a move; the strip opens a tab and leaves the entry where it is.
    event.dataTransfer.dropEffect = event.dataTransfer.effectAllowed === 'move' ? 'move' : 'copy'
    const next = markerAt(event.clientX)
    if (next !== null && (next.index !== marker?.index || next.x !== marker.x)) setMarker(next)
  }
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    const at = marker?.index ?? items.length
    setMarker(null)
    if (disabled || !drop.accepts(event)) return
    event.preventDefault()
    const path = drop.read(event)
    if (path !== null) drop.onDrop(path, at)
  }

  return (
    <div ref={strip} data-content-tabs="" className="relative flex min-w-0 flex-1 items-center gap-1 [--fade-to:var(--color-surface)]"
      onDragOver={onDragOver}
      // Chromium often leaves `relatedTarget` empty on dragleave, so the pointer decides.
      onDragLeave={(event) => {
        const box = event.currentTarget.getBoundingClientRect()
        if (event.clientX <= box.left || event.clientX >= box.right || event.clientY <= box.top || event.clientY >= box.bottom) setMarker(null)
      }}
      onDrop={onDrop}>
      <ScrollFade label={label} className="min-w-0 flex-initial" scrollerClassName="scrollbar-hidden flex min-w-0 items-center gap-1">
        <Reorder.Group as="div" axis="x" ref={group} values={shown.map((item) => item.id)}
          className="flex min-w-0 flex-1 items-center gap-1"
          onReorder={(ids: string[]) => { dragOrderRef.current = ids; setDragOrder(ids) }}>
          {shown.map((item) => {
            const at = items.indexOf(item)
            return (
              <StripTab key={item.id} id={item.id} name={item.name} title={item.title} leading={item.leading} slim={slim}
                active={item.id === activeId} disabled={disabled} closeOnActive
                onSelect={() => onSelect(item.id)} onClose={() => onClose(item.id)}
                menu={[
                  ...(item.menu ?? []),
                  ...(at > 0 ? [{ label: 'Move tab left', onSelect: () => onMove(item.id, at - 1) }] : []),
                  ...(at < items.length - 1 ? [{ label: 'Move tab right', onSelect: () => onMove(item.id, at + 1) }] : []),
                  { label: 'Close tab', onSelect: () => onClose(item.id) },
                ]}
                reorder={{ dragging: dragOrder !== null, bounds: group, onDrop: () => dropTab(item.id) }} />
            )
          })}
        </Reorder.Group>
      </ScrollFade>
      <IconButton icon={PlusSignIcon} label={newLabel} disabled={disabled} onClick={onNew} />
      {marker === null ? null : (
        <motion.span aria-hidden="true" data-tab-drop-marker=""
          className="pointer-events-none absolute inset-y-0 left-0 my-auto h-5 w-0.5 rounded-full bg-primary"
          initial={{ x: marker.x, opacity: 0 }} animate={{ x: marker.x, opacity: 1 }} transition={TAB_REORDER} />
      )}
    </div>
  )
}
