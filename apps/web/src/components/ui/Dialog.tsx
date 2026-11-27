import { useEffect, useRef, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/** The gutter each inset leaves between the card and the edge of the screen. */
const INSET = { default: 'p-6', wide: 'p-16' } as const

/** What Tab is allowed to land on. Anything the dialog renders is one of these. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

interface DialogProps {
  /** Names the dialog when the card has no visible heading of its own. */
  label?: string
  /** Names the dialog from a heading inside the card. */
  labelledBy?: string
  /**
   * Escape, the backdrop, and any close control the caller renders all land here.
   * What closing means for the draft inside is the caller's decision.
   */
  onClose: () => void
  /**
   * Tab cycles the focusable nodes inside the card. Off for a palette that keeps
   * focus in one field and walks its list with the arrows.
   */
  trapFocus?: boolean
  /**
   * Extra classes on the dimmed room. Placement (centred versus top) lives here,
   * because that is the one thing the two cards do not share.
   */
  scrimClassName?: string
  /**
   * How much room the dimmed page keeps around the card. `wide` is for a card that
   * wants the screen: a picture reads at the size it is given, and a gutter is what
   * keeps it a card rather than a second window.
   */
  inset?: 'default' | 'wide'
  /** Extra classes on the card. Width, padding and overflow belong to the caller. */
  className?: string
  /**
   * No arrival. For a palette opened from the keyboard many times a day, where the
   * first typed letter must not land on a card still settling.
   */
  still?: boolean
  /** Extra key handling after Escape (and the trap, when it is on) have had their say. */
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void
  children: ReactNode
}

/**
 * The house's dialog plumbing: a card over a dimmed room, portalled to the body so
 * no ancestor can clip it, focus handed back to whatever opened it on the way out.
 * The titled form and the search palette both sit on this. The card's look beyond
 * the shared frame (border, surface, arrival) is the caller's.
 */
export function Dialog({
  label,
  labelledBy,
  onClose,
  trapFocus = false,
  scrimClassName = '',
  inset = 'default',
  className = '',
  still = false,
  onKeyDown,
  children,
}: DialogProps) {
  const cardRef = useRef<HTMLDivElement>(null)

  // Whatever had focus when the dialog opened gets it back when it closes, so a
  // keyboard user is returned to the control they pressed rather than to the top.
  useEffect(() => {
    const opener = document.activeElement
    const card = cardRef.current
    // A child that autofocuses has already claimed focus by now; the card itself
    // is the fallback so focus is never left behind the backdrop.
    if (trapFocus && card && !card.contains(document.activeElement)) card.focus()
    return () => {
      if (opener instanceof HTMLElement) opener.focus()
    }
  }, [trapFocus])

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // A dialog opened from inside this one is portalled outside this card, yet its keys
    // still bubble here through React. They are its own: Escape closes only the top one.
    const card = cardRef.current
    if (card !== null && !card.contains(event.target as Node)) return
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (trapFocus && event.key === 'Tab') {
      if (!card) return
      const stops = [...card.querySelectorAll<HTMLElement>(FOCUSABLE)]
      if (stops.length === 0) {
        event.preventDefault()
        return
      }
      const first = stops[0]
      const last = stops[stops.length - 1]
      const at = stops.indexOf(document.activeElement as HTMLElement)
      // Only the two ends need help; everything between them tabs normally.
      if (event.shiftKey && (at === 0 || at === -1)) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && at === stops.length - 1) {
        event.preventDefault()
        first?.focus()
      }
      return
    }
    onKeyDown?.(event)
  }

  // mousedown rather than click: a text selection that starts inside the card and
  // ends on the backdrop would otherwise read as a click on the backdrop.
  const handleBackdrop = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) onClose()
  }

  return createPortal(
    <div
      className={`${still ? '' : 'modal-scrim-in '}fixed inset-0 z-20 bg-scrim ${INSET[inset]} ${scrimClassName}`}
      onMouseDown={handleBackdrop}
    >
      <div
        ref={cardRef}
        data-modal-scroll
        className={`${still ? '' : 'modal-card-in '}w-full rounded-xl border border-line bg-surface outline-none ${className}`}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        aria-labelledby={labelledBy}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        {children}
      </div>
    </div>,
    document.body,
  )
}
