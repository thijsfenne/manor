import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { ArrowDown01Icon, Tick02Icon } from '@hugeicons/core-free-icons'
import {
  EASE_OUT,
  INSTANT,
  ITEM_VARIANTS,
  LIST_VARIANTS,
  SPRING_CHEVRON,
  SPRING_PANEL,
} from '../../motion'
import { Icon } from '../Icon'
import { useDismiss } from './useDismiss'
import { usePopupPlacement } from './usePopupPlacement'

export interface SelectOption<T extends string> {
  value: T
  label: string
  /** Drawn on the label in the list and the trigger, such as a font name set in that font. */
  style?: CSSProperties
}

interface SelectProps<T extends string> {
  value: T
  options: readonly SelectOption<T>[]
  onChange: (value: T) => void
  /** Names the control for screen readers; the visible label is a sibling, not a wrapper. */
  label: string
  /** Shown when the value matches no option, which only happens to a stale saved value. */
  placeholder?: string
  disabled?: boolean
  className?: string
  /**
   * The option under the pointer or the arrow keys while the list is open, and null
   * once it closes, so a caller can preview a value before it is chosen.
   */
  onPreview?: (value: T | null) => void
}

const MAX_HEIGHT = 288
/** Below this the list would open into a slit, so it flips instead. */
const MIN_HEIGHT = 140

/**
 * The house's dropdown. A native `<select>` draws its list with the operating
 * system's own colours — a blue macOS highlight in a dark dialog — and gives no
 * say over where the arrow sits, so both are done here instead.
 *
 * Focus stays on the trigger the whole time and the list is driven by
 * `aria-activedescendant`, which is what keeps it honest inside a modal: the
 * popup portals to the body to escape the dialog's `overflow`, and a focus trap
 * that cannot see it would otherwise pull focus straight back out of the list.
 */
export function Select<T extends string>({
  value,
  options,
  onChange,
  label,
  placeholder = 'Choose…',
  disabled = false,
  className = '',
  onPreview,
}: SelectProps<T>) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  const reduce = useReducedMotion() ?? false
  const [open, setOpen] = useState(false)
  const [contentHeight, setContentHeight] = useState(0)
  // A new key each opening, so a list that is still exiting cannot steal the
  // next one's presence and leave the trigger looking open over nothing.
  const opening = useRef(0)
  const placement = usePopupPlacement({ open, triggerRef, maxHeight: MAX_HEIGHT, minHeight: MIN_HEIGHT })
  const visible = open && placement !== null
  // What the arrow keys are pointing at, which is not yet what is chosen. Hover
  // moves it too, so a mouse and a keyboard can never highlight two rows at once.
  const [active, setActive] = useState(0)

  const selected = options.findIndex((option) => option.value === value)
  const current = selected === -1 ? null : options[selected]

  // An exiting list keeps its rows, and their handlers, until its animation ends. The
  // ref lets those rows see the close, so a pointer crossing them cannot preview again.
  const openRef = useRef(open)
  useEffect(() => {
    openRef.current = open
  }, [open])

  const point = (index: number) => {
    setActive(index)
    const option = options[index]
    if (option !== undefined) onPreview?.(option.value)
  }

  const show = () => {
    if (disabled || options.length === 0) return
    point(selected === -1 ? 0 : selected)
    opening.current += 1
    setOpen(true)
  }

  const close = () => {
    setOpen(false)
    onPreview?.(null)
  }

  const hide = () => {
    close()
    triggerRef.current?.focus()
  }

  const choose = (index: number) => {
    const option = options[index]
    if (option !== undefined) onChange(option.value)
    hide()
  }

  // Escape is not in here: the trigger's own key handler takes it, because that path
  // hands focus back rather than dropping it on the body.
  // Armed only once the list has a height. Opening used to call `scrollIntoView`
  // on a clip of height 0, which scrolled the dialog and `layoutMoved` then
  // closed the list before it had grown.
  useDismiss(open && (!visible || contentHeight > 0), close, {
    within: [triggerRef, popupRef],
    layoutMoved: true,
  })

  // Scroll only the list. `scrollIntoView` walks every ancestor, including the
  // dialog, and that is a captured scroll that would dismiss us.
  useEffect(() => {
    if (!open) return
    const list = innerRef.current
    const row = list?.querySelector<HTMLElement>(`[data-index="${active}"]`)
    if (!list || !row) return
    const top = row.offsetTop
    const bottom = top + row.offsetHeight
    if (top < list.scrollTop) list.scrollTop = top
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight
  }, [visible, active])

  // The spring needs a number. Measuring the inner list (already capped by
  // maxHeight) is what lets the outer clip grow from zero without guessing.
  // `placement` is in the deps because the list only mounts once it exists.
  useLayoutEffect(() => {
    const inner = innerRef.current
    if (!open || inner === null) return
    const measure = () => {
      const next = inner.offsetHeight
      if (next > 0) setContentHeight(next)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(inner)
    return () => observer.disconnect()
  }, [visible, options.length, placement])

  const step = (delta: number) => point(Math.max(0, Math.min(options.length - 1, active + delta)))

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!open) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        show()
      }
      return
    }
    switch (event.key) {
      // Tab is the one key that leaves without preventDefault: the list closes and
      // focus moves on, rather than trapping a keyboard behind an open popup.
      case 'Tab':
        close()
        return
      case 'Escape':
        event.preventDefault()
        hide()
        return
      case 'ArrowDown':
        event.preventDefault()
        step(1)
        return
      case 'ArrowUp':
        event.preventDefault()
        step(-1)
        return
      case 'Home':
        event.preventDefault()
        point(0)
        return
      case 'End':
        event.preventDefault()
        point(options.length - 1)
        return
      case 'Enter':
      case ' ':
        event.preventDefault()
        choose(active)
        return
      default:
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        // pr-3 against pl-2.5: an arrow reads tighter to an edge than a letter does,
        // so equal padding would look like the arrow is falling off the field.
        // The focus ring is traded for a lifted border, the way every field-shaped
        // control in the house does it — see the base layer note in styles.css.
        className={`flex w-full cursor-pointer items-center gap-2 rounded-lg border bg-surface-2 py-[7px] pr-3 pl-2.5 text-left text-[13px] outline-none focus-visible:border-dim disabled:cursor-default disabled:opacity-45 ${
          open ? 'border-dim' : 'border-line hover:border-dim'
        } ${current === null ? 'text-dim' : 'text-text'} ${className}`}
        disabled={disabled}
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={visible ? listId : undefined}
        aria-activedescendant={visible ? `${listId}-${active}` : undefined}
        onClick={() => (open ? hide() : show())}
        onKeyDown={onKeyDown}
      >
        <span className="min-w-0 flex-1 truncate" style={current?.style}>{current?.label ?? placeholder}</span>
        <motion.span
          className="flex-none text-muted"
          animate={{ rotate: open ? 180 : 0 }}
          transition={reduce ? INSTANT : SPRING_CHEVRON}
        >
          <Icon icon={ArrowDown01Icon} size={14} />
        </motion.span>
      </button>

      {createPortal(
        <AnimatePresence>
          {visible && placement !== null ? (
            <motion.div
              key={`${listId}-${opening.current}`}
              ref={popupRef}
              id={listId}
              role="listbox"
              aria-label={label}
              className="fixed z-30 overflow-hidden rounded-lg border border-line surface-floating shadow-menu"
              style={{
                left: placement.left,
                top: placement.top,
                bottom: placement.bottom,
                width: placement.width,
                transformOrigin: placement.top === undefined ? 'bottom' : 'top',
              }}
              initial={reduce ? { opacity: 0, height: contentHeight } : { opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: contentHeight }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
              transition={
                reduce
                  ? { duration: 0.12 }
                  : {
                      opacity: { duration: 0.18 },
                      height: SPRING_PANEL,
                    }
              }
              // The trigger keeps focus through the whole interaction; without this the
              // press would move it here and the modal's focus trap would fight back.
              onMouseDown={(event) => event.preventDefault()}
            >
              <motion.div
                ref={innerRef}
                className="max-h-[inherit] overflow-y-auto p-1"
                style={{ maxHeight: placement.maxHeight }}
                variants={reduce ? undefined : LIST_VARIANTS}
                initial={reduce ? false : 'hidden'}
                animate="show"
                exit="hidden"
              >
                {options.map((option, index) => (
                  <motion.button
                    key={option.value}
                    id={`${listId}-${index}`}
                    type="button"
                    role="option"
                    aria-selected={index === selected}
                    data-index={index}
                    tabIndex={-1}
                    variants={reduce ? undefined : ITEM_VARIANTS}
                    transition={reduce ? INSTANT : { duration: 0.2, ease: EASE_OUT }}
                    className={`flex h-8 w-full cursor-pointer items-center gap-2 rounded-md border-0 px-2 text-left text-label text-text ${
                      index === active ? 'bg-user-bg' : 'bg-transparent'
                    }`}
                    onMouseEnter={() => {
                      if (openRef.current) point(index)
                    }}
                    onClick={() => choose(index)}
                  >
                    <span className="min-w-0 flex-1 truncate" style={option.style}>{option.label}</span>
                    {index === selected ? (
                      <Icon className="flex-none" icon={Tick02Icon} size={13} />
                    ) : (
                      <span className="w-[13px] flex-none" aria-hidden="true" />
                    )}
                  </motion.button>
                ))}
              </motion.div>
            </motion.div>
          ) : null}
        </AnimatePresence>,
        document.body,
      )}
    </>
  )
}
