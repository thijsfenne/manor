import { useId, useRef, useState, type ReactNode } from 'react'
import { Tooltip } from '../ui/Tooltip'

/**
 * A figure that explains itself on hover or focus: the pace mark, a limit bar. One
 * tab stop, read as an image with its full sentence, so the keyboard gets the same
 * words the pointer does.
 */
export function UsageHint({
  label,
  hint,
  className = '',
  children,
}: {
  /** The sentence a screen reader hears in place of the figure. */
  label: string
  hint: ReactNode
  className?: string
  children: ReactNode
}) {
  const ref = useRef<HTMLSpanElement>(null)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const hintId = useId()
  const show = () => setAnchor(ref.current)
  const hide = () => setAnchor(null)
  return (
    <span
      ref={ref}
      role="img"
      aria-label={label}
      aria-describedby={anchor === null ? undefined : hintId}
      tabIndex={0}
      className={`cursor-default outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${className}`}
      onPointerEnter={show}
      onPointerLeave={() => {
        if (document.activeElement !== ref.current) hide()
      }}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {anchor === null ? null : (
        <Tooltip anchor={anchor} id={hintId} onDismiss={hide}>
          {hint}
        </Tooltip>
      )}
    </span>
  )
}
