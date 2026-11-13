import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Cancel01Icon } from '@hugeicons/core-free-icons'
import { Dialog } from './ui/Dialog'
import { IconButton } from './ui/IconButton'

interface ModalProps {
  /** Names the dialog for screen readers and heads the card. */
  title: string
  /**
   * The context the card cannot show because it covers it: what this form is about
   * when that is settled elsewhere. A sentence, never a control.
   */
  subtitle?: string
  /**
   * How wide the card may get. A short form stays at the default; a form with
   * side-by-side fields or a wall of choices says so here rather than overflowing
   * a width picked for something else.
   */
  width?: 'default' | 'wide'
  /**
   * Escape, the backdrop, and the card's own close route all land here. What
   * closing means for the draft inside is the caller's decision, not this shell's.
   */
  onClose: () => void
  children: ReactNode
}

const widthClass: Record<NonNullable<ModalProps['width']>, string> = {
  default: 'max-w-[460px]',
  wide: 'max-w-[720px]',
}

/**
 * A titled form on the shared dialog shell. The shell owns the room and the trap;
 * this owns the heading, the width the form asked for, and the one way out that is
 * visible before it is tried: Escape and the backdrop only exist once you know them.
 */
export function Modal({ title, subtitle, width = 'default', onClose, children }: ModalProps) {
  const titleId = useId()

  return (
    <Dialog
      labelledBy={titleId}
      onClose={onClose}
      trapFocus
      scrimClassName="grid place-items-center"
      className={`flex max-h-full ${widthClass[width]} flex-col gap-5 overflow-y-auto p-5`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          {/* Tracking goes negative where the old 15px ran positive: letter spacing that
              opens up a small label reads as slack once the same words are this size. */}
          <h2 className="m-0 text-[20px] font-semibold tracking-[-0.01em]" id={titleId}>
            {title}
          </h2>
          {subtitle === undefined ? null : (
            <p className="mt-1 mb-0 text-label text-muted">{subtitle}</p>
          )}
        </div>
        {/* Negative margins pull the button's padding back, so the mark itself sits
            on the card's padding line the way the title does. */}
        <IconButton icon={Cancel01Icon} label="Close" onClick={onClose} className="-mt-1 -mr-1.5" />
      </div>
      {children}
    </Dialog>
  )
}

/** A modal needs a divider only when its content can disappear behind the actions. */
export const modalOverflows = (scrollHeight: number, clientHeight: number): boolean =>
  scrollHeight > clientHeight + 1

/**
 * Actions that remain reachable while a long dialog scrolls. Negative outer margins
 * consume the modal's padding and put the bar against the card edges; the inner
 * padding is what gives the buttons their room.
 *
 * The bar keeps more room under the buttons than above them, and no negative top
 * margin: the card's own 20px gap is what stands it clear of the last field. A dialog
 * ends in its most consequential control, and a Save crowded into the corner of the
 * card reads as the edge of the window.
 */
export function ModalFooter({ children }: { children: ReactNode }) {
  const footerRef = useRef<HTMLDivElement>(null)
  const [divided, setDivided] = useState(false)

  useLayoutEffect(() => {
    const scroller = footerRef.current?.closest<HTMLElement>('[data-modal-scroll]')
    if (scroller === undefined || scroller === null) return

    const measure = () => setDivided(modalOverflows(scroller.scrollHeight, scroller.clientHeight))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(scroller)
    return () => observer.disconnect()
  })

  return (
    <div
      ref={footerRef}
      className={`sticky bottom-[-20px] z-10 -mx-5 -mb-5 bg-surface px-5 pt-5 pb-6 border-t ${
        divided ? 'border-line' : 'border-transparent'
      }`}
      data-divided={divided || undefined}
    >
      {children}
    </div>
  )
}
