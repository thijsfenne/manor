import { ArrowLeft01Icon, ArrowRight01Icon, Cancel01Icon } from '@hugeicons/core-free-icons'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { VIEWER_STEP, VIEWER_STEP_TRAVEL } from '../../motion'
import { Icon } from '../Icon'

interface ZoomableImageProps {
  /**
   * Not every source is one. Markdown can hand over an empty link or something that
   * is not a string at all, and a broken picture is worse than no picture: it would
   * be a control that opens onto nothing. Both render as nothing instead.
   */
  src: string | undefined
  alt: string
  /** The button's name when the thumbnail is not the picture itself, such as a "+N" tile. */
  label?: string
  /** How the picture itself looks: its cap, its radius, how it fills the frame. */
  className?: string
  /** What the button around it has to be for the caller's layout to hold. */
  frame?: string
  /** Extra treatment for the full-size picture, such as an avatar's circular crop. */
  zoomedClassName?: string
  /** Makes the full-size picture visibly grow out of the thumbnail that opened it. */
  zoomFromThumbnail?: boolean
  /** Optional live thumbnail while the source still anchors the viewer contract. */
  thumbnail?: ReactNode
  /** Optional live content for the viewer instead of its ordinary enlarged image. */
  zoomedContent?: ReactNode
  /**
   * The pictures this one was sent with, itself at `index`. The open viewer then steps
   * through them with the left and right arrow keys or its Previous and Next buttons,
   * stopping at either end.
   */
  gallery?: { images: readonly GalleryImage[]; index: number }
}

export interface GalleryImage {
  src: string
  alt: string
}

/** Leaves the scrim's 24px breathing room on every side, including mobile browser chrome. */
export const IMAGE_VIEWER_BOUNDS = 'max-h-[calc(100dvh-3rem)] max-w-[calc(100dvw-3rem)]'
/** A gallery's sides keep 64px, so Previous and Next sit beside a wide picture, not on it. */
const GALLERY_VIEWER_BOUNDS = 'max-h-[calc(100dvh-3rem)] max-w-[calc(100dvw-8rem)]'

/**
 * A picture small enough to live in the thread, one press away from being large
 * enough to read. The thumbnail is a real button so the keyboard reaches it and the
 * cursor says what it does; the viewer it opens is portalled, so no bubble's
 * overflow or stacking context can clip it.
 *
 * State is per image on purpose. A viewer hoisted to the app would survive a
 * thumbnail remounting mid-stream, but it would also outlive the message it belongs
 * to, and every image in the transcript would then depend on one provider being
 * mounted above it.
 */
export function ZoomableImage({
  src,
  alt,
  label,
  className = '',
  frame = '',
  zoomedClassName = '',
  zoomFromThumbnail = false,
  thumbnail,
  zoomedContent,
  gallery,
}: ZoomableImageProps) {
  const [zoomed, setZoomed] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  if (src === undefined || src === '') return null
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        // Names the act rather than the picture: the alt text is still in the image
        // under it, and "screenshot.png" alone does not say a press enlarges it.
        aria-label={label ?? (alt === '' ? 'Enlarge image' : `Enlarge ${alt}`)}
        className={`block cursor-zoom-in border-0 bg-transparent p-0 [font:inherit] hover:opacity-90 motion-safe:transition-opacity ${frame}`}
        onClick={() => setZoomed(true)}
      >
        {/* Block, or the button reserves a line box the picture does not fill and
            every thumbnail sits on a few pixels of empty descender space. */}
        {thumbnail ?? <img src={src} alt={alt} className={`block ${className}`} />}
      </button>
      {zoomed ? (
        <ImageLightbox
          src={src}
          alt={alt}
          origin={zoomFromThumbnail ? triggerRef.current?.getBoundingClientRect() : undefined}
          className={zoomedClassName}
          content={zoomedContent}
          gallery={gallery}
          onClose={() => setZoomed(false)}
        />
      ) : null}
    </>
  )
}

/**
 * The picture at its own size, capped by the window. Deliberately no upscaling: a
 * small image blown up is less readable than the small image was. Exported for an
 * opener that is not the thumbnail, such as an `[Image #n]` chip in a sent message.
 */
export function ImageLightbox({
  src,
  alt,
  origin,
  className,
  content,
  gallery,
  onClose,
}: {
  src: string
  alt: string
  origin?: DOMRect
  className: string
  content?: ReactNode
  gallery?: { images: readonly GalleryImage[]; index: number } | undefined
  onClose: () => void
}) {
  const [at, setAt] = useState(gallery?.index ?? 0)
  // Only the picture that was pressed grows out of its thumbnail. Once a step has
  // happened every picture, the pressed one included, drifts in where the viewer is.
  const [stepped, setStepped] = useState(false)
  // Which way the last step went: 1 is next, -1 previous.
  const [direction, setDirection] = useState(1)
  const reduce = useReducedMotion() ?? false
  const shown = stepped ? gallery?.images[at] ?? { src, alt } : { src, alt }
  const count = gallery?.images.length ?? 1
  const bounds = count > 1 ? GALLERY_VIEWER_BOUNDS : IMAGE_VIEWER_BOUNDS
  const closeRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const targetRef = useRef<HTMLElement | null>(null)
  const [originReady, setOriginReady] = useState(origin === undefined)

  const positionOrigin = () => {
    const element = targetRef.current
    if (element === null || origin === undefined) return
    const target = element.getBoundingClientRect()
    if (target.width === 0 || target.height === 0) return

    const originCenterX = origin.left + origin.width / 2
    const originCenterY = origin.top + origin.height / 2
    const targetCenterX = target.left + target.width / 2
    const targetCenterY = target.top + target.height / 2
    element.style.setProperty('--image-zoom-from-x', `${originCenterX - targetCenterX}px`)
    element.style.setProperty('--image-zoom-from-y', `${originCenterY - targetCenterY}px`)
    element.style.setProperty('--image-zoom-from-scale-x', String(origin.width / target.width))
    element.style.setProperty('--image-zoom-from-scale-y', String(origin.height / target.height))
    setOriginReady(true)
  }

  // Measure the final, centred picture before paint. The animation can then start at
  // the exact header-avatar bounds without moving layout or guessing screen sizes.
  useLayoutEffect(positionOrigin, [origin])

  // Same contract as the dialog shell: focus moves in on arrival and returns to the
  // thumbnail that opened it, so a keyboard user lands back in the transcript.
  useEffect(() => {
    const opener = document.activeElement
    closeRef.current?.focus()
    return () => {
      if (opener instanceof HTMLElement) opener.focus()
    }
  }, [])

  const step = (by: -1 | 1) => {
    if (gallery === undefined) return
    const next = Math.min(gallery.images.length - 1, Math.max(0, at + by))
    if (next === at) return
    setDirection(by)
    setAt(next)
    setStepped(true)
    // The button that reached an end turns disabled and would drop focus out of the
    // viewer, taking the arrow keys and Escape with it; the viewer keeps it instead.
    const active = document.activeElement
    if ((next === 0 || next === gallery.images.length - 1) && active instanceof HTMLElement && active.dataset.step !== undefined) {
      dialogRef.current?.focus()
    }
  }

  // Tab walks the viewer's own buttons in a ring; focus never leaves for the page under it.
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (gallery !== undefined && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault()
      step(event.key === 'ArrowLeft' ? -1 : 1)
      return
    }
    if (event.key !== 'Escape' && event.key !== 'Tab') return
    event.preventDefault()
    if (event.key === 'Escape') {
      onClose()
      return
    }
    const controls = [...dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []]
    const from = controls.indexOf(document.activeElement as HTMLButtonElement)
    const next = controls[(from + (event.shiftKey ? -1 : 1) + controls.length) % controls.length] ?? closeRef.current
    next?.focus()
  }

  // The picture keeps its own clicks: dragging it out or right-clicking to save it
  // are the two things you open it for. Everything around it closes.
  const handleBackdrop = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) onClose()
  }

  const travel = reduce ? 0 : VIEWER_STEP_TRAVEL
  const stepButton = 'absolute top-1/2 grid h-9 w-9 -translate-y-1/2 cursor-pointer place-items-center rounded-full border-0 bg-media-scrim text-on-media [font:inherit] disabled:cursor-default disabled:opacity-40'

  return createPortal(
    <div
      ref={dialogRef}
      className="modal-scrim-in fixed inset-0 z-20 grid cursor-zoom-out place-items-center bg-scrim p-6 outline-none"
      role="dialog"
      aria-modal="true"
      aria-label={`${shown.alt === '' ? 'Image' : shown.alt}${count > 1 ? `, ${at + 1} of ${count}` : ''}`}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      onMouseDown={handleBackdrop}
    >
      {stepped ? (
        // Every step is a new picture taking the same cell: the old one drifts out the
        // way the step went while the new one drifts in from the other side.
        <AnimatePresence initial={false} custom={direction} mode="popLayout">
          <motion.img
            key={at}
            src={shown.src}
            alt={shown.alt}
            custom={direction}
            variants={{
              enter: (way: number) => ({ opacity: 0, x: way * travel }),
              rest: { opacity: 1, x: 0 },
              leave: (way: number) => ({ opacity: 0, x: way * -travel }),
            }}
            initial="enter"
            animate="rest"
            exit="leave"
            transition={VIEWER_STEP}
            className={`col-start-1 row-start-1 ${bounds} cursor-default rounded-lg object-contain ${className}`}
          />
        </AnimatePresence>
      ) : content === undefined ? (
        <img
          ref={(element) => {
            targetRef.current = element
          }}
          src={src}
          alt={alt}
          className={`${origin === undefined ? 'modal-card-in' : originReady ? 'image-zoom-from-trigger' : 'opacity-0'} ${bounds} cursor-default rounded-lg object-contain ${className}`}
          onLoad={positionOrigin}
        />
      ) : (
        <div
          ref={(element) => {
            targetRef.current = element
          }}
          className={`${origin === undefined ? 'modal-card-in' : originReady ? 'image-zoom-from-trigger' : 'opacity-0'} ${bounds} cursor-default ${className}`}
        >
          {content}
        </div>
      )}
      <button
        ref={closeRef}
        type="button"
        aria-label="Close"
        title="Close"
        className="absolute top-5 right-5 grid h-9 w-9 cursor-pointer place-items-center rounded-full border-0 bg-media-scrim text-on-media [font:inherit]"
        onClick={onClose}
      >
        <Icon icon={Cancel01Icon} size={16} />
      </button>
      {count > 1 ? (
        <>
          <button type="button" data-step aria-label="Previous image" title="Previous" disabled={at === 0} className={`${stepButton} left-5`} onClick={() => step(-1)}>
            <Icon icon={ArrowLeft01Icon} size={16} />
          </button>
          <button type="button" data-step aria-label="Next image" title="Next" disabled={at === count - 1} className={`${stepButton} right-5`} onClick={() => step(1)}>
            <Icon icon={ArrowRight01Icon} size={16} />
          </button>
        </>
      ) : null}
    </div>,
    document.body,
  )
}
