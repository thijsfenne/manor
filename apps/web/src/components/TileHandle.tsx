import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'

const STEP = 16

/**
 * A drag handle between panels that share the region: a column's edge (`x`) or the
 * split between two stacked panels (`y`). `grab` reads the sizes on screen when a
 * gesture starts and returns what to do with each pixel of movement since then, so
 * the pointer, the arrow keys and a squeezed column all start from the same place.
 * Looks and reads like a panel's own resize edge: a line only on hover, focus or drag.
 */
export function TileHandle({ axis, label, className, style, grab, onReset, onResizing }: {
  axis: 'x' | 'y'
  label: string
  /** Where it sits in its column's layer. */
  className: string
  style?: CSSProperties
  grab: (handle: HTMLElement) => (delta: number) => void
  onReset: () => void
  onResizing: (resizing: boolean) => void
}) {
  const move = useRef<((delta: number) => void) | null>(null)
  const origin = useRef(0)
  const [active, setActive] = useState(false)
  // A layout change can take the handle away mid-drag; the region must not stay frozen.
  useEffect(() => () => {
    if (move.current !== null) onResizing(false)
  }, [onResizing])
  const at = (event: ReactPointerEvent) => (axis === 'x' ? event.clientX : event.clientY)
  const end = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (move.current === null) return
    move.current = null
    setActive(false)
    onResizing(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }
  return (
    <div
      role="separator"
      aria-label={label}
      // A column edge is a vertical line, a split between stacked panels a horizontal one.
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      tabIndex={0}
      title="Drag to resize. Double-click to reset."
      // Lets the page guests stand aside for the drag, as a panel's own edge does.
      data-panel-resizing={active ? true : undefined}
      className={`group pointer-events-auto absolute touch-none outline-none ${
        axis === 'x' ? 'w-2 cursor-col-resize' : 'h-2 cursor-row-resize'
      } ${className}`}
      style={style}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        origin.current = at(event)
        move.current = grab(event.currentTarget)
        setActive(true)
        onResizing(true)
      }}
      onPointerMove={(event) => move.current?.(at(event) - origin.current)}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={onReset}
      onKeyDown={(event) => {
        const delta = axis === 'x'
          ? { ArrowLeft: -STEP, ArrowRight: STEP }[event.key]
          : { ArrowUp: -STEP, ArrowDown: STEP }[event.key]
        if (delta === undefined) return
        event.preventDefault()
        grab(event.currentTarget)(delta)
      }}
    >
      <div
        className={`pointer-events-none absolute bg-primary transition-opacity duration-150 group-hover:opacity-40 group-focus-visible:opacity-60 ${
          active ? 'opacity-60' : 'opacity-0'
        } ${axis === 'x' ? 'inset-y-0 left-[3px] w-0.5' : 'inset-x-0 top-[3px] h-0.5'}`}
      />
    </div>
  )
}
