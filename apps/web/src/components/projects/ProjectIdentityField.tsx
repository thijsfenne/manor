import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { DEFAULT_PROJECT_COLOR, type ProjectIcon } from '@manor/contracts'
import { safeHex } from '../../persona'
import { PROJECT_ICON_OPTIONS, projectColorChoices, projectIcon } from '../../projectAppearance'
import { Icon } from '../Icon'
import { Button } from '../ui/Button'
import { useDismiss } from '../ui/useDismiss'
import { formFieldClass, formLabelClass } from '../ui/FormField'

/** The cell every swatch and every glyph in the picker sits in, so the two grids line up. */
const cellClass = 'grid h-10 cursor-pointer place-items-center'
/** Room between the field and the panel, and the least the panel keeps from a screen edge. */
const GAP = 6
const INSET = 8
const markClass =
  'grid h-9 w-9 place-items-center rounded-full border peer-focus-visible:outline-2 peer-focus-visible:outline-offset-1 peer-focus-visible:outline-primary'

interface ProjectIdentityFieldProps {
  name: string
  icon: ProjectIcon
  color: string
  onName: (name: string) => void
  onIcon: (icon: ProjectIcon) => void
  onColor: (color: string) => void
  /** Enter in the name field is the fast yes; the dialog decides whether it can be taken. */
  onEnter: () => void
}

/**
 * A project's name and the face it wears, as one control. The icon sits inside the
 * field it labels and opening it drops the picker underneath, which is the shape
 * this reads best in: colour and icon are chosen together because together is how
 * the sidebar shows them, and a wall of a hundred glyphs has no business standing
 * open in a dialog that is mostly about a name.
 */
export function ProjectIdentityField({
  name,
  icon,
  color,
  onName,
  onIcon,
  onColor,
  onEnter,
}: ProjectIdentityFieldProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const selectedIconRef = useRef<HTMLLabelElement>(null)
  const [open, setOpen] = useState(false)
  const [at, setAt] = useState<{ left: number; top: number } | null>(null)
  const inputId = useId()

  const accent = safeHex(color, DEFAULT_PROJECT_COLOR)
  const swatches = projectColorChoices(color)

  // Escape is handled on the row below, one step at a time; clicking away is the
  // whole visit and closes the picker outright.
  useDismiss(open, () => setOpen(false), { within: [rootRef], onEscape: () => {} })

  /**
   * The panel is fixed to the viewport rather than laid out under the field, which
   * is what keeps it out of the dialog's scroll: an absolutely placed panel makes
   * the card taller, and the card's own `overflow-y-auto` then cuts the catalogue
   * off halfway. Fixed escapes that clip entirely, so the only scrolling left is
   * the icon grid's own. The trade is arithmetic: measure the panel, put it under
   * the field, flip it above when the room below is gone, and keep it on screen.
   */
  useLayoutEffect(() => {
    if (!open) {
      setAt(null)
      return
    }
    const place = () => {
      const trigger = triggerRef.current
      const panel = panelRef.current
      if (trigger === null || panel === null) return
      const anchor = trigger.getBoundingClientRect()
      const { width, height } = panel.getBoundingClientRect()
      const below = anchor.bottom + GAP
      const fits = below + height + INSET <= window.innerHeight
      const left = Math.max(INSET, Math.min(anchor.left, window.innerWidth - width - INSET))
      const top = fits ? below : Math.max(INSET, anchor.top - GAP - height)
      // Scrolling the icon grid is a scroll event too, and it moves nothing: keeping
      // the old object where the numbers match is what stops a render per frame.
      setAt((current) => (current?.left === left && current.top === top ? current : { left, top }))
    }
    place()
    // The dialog behind it can still scroll, and the panel follows the field it belongs to.
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

  // Opening lands on the icon the project already wears, however deep in the
  // catalogue that sits, and puts focus in the panel rather than behind it.
  useEffect(() => {
    if (!open) return
    panelRef.current?.focus({ preventScroll: true })
    selectedIconRef.current?.scrollIntoView({ block: 'nearest' })
  }, [open])

  // Escape inside the picker closes the picker, not the dialog behind it. Stopping
  // the event is what keeps the modal's own Escape from taking the whole room with it.
  const stepBack = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!open || event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    setOpen(false)
  }

  return (
    <div className={formFieldClass}>
      <label className={formLabelClass} htmlFor={inputId}>
        Name
      </label>

      <div ref={rootRef} onKeyDown={stepBack}>
        <div className="flex items-stretch rounded-lg border border-line bg-surface-2 focus-within:border-dim">
          <button
            ref={triggerRef}
            type="button"
            className={`grid w-11 flex-none cursor-pointer place-items-center rounded-l-lg border-r border-line [font:inherit] ${
              open ? 'bg-user-bg' : 'bg-transparent hover:bg-user-bg'
            }`}
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-label="Icon and colour"
            title="Icon and colour"
            onClick={() => setOpen((current) => !current)}
          >
            <span style={{ color: accent }}>
              <Icon icon={projectIcon(icon)} size={17} />
            </span>
          </button>

          <input
            id={inputId}
            className="w-full min-w-0 rounded-r-lg bg-transparent px-2.5 py-[7px] text-[13px] text-text outline-none placeholder:text-dim [font:inherit]"
            autoFocus
            value={name}
            placeholder="Client work"
            onChange={(event) => onName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              onEnter()
            }}
          />
        </div>

        {open ? (
          <div
            ref={panelRef}
            className="fixed z-30 w-[288px] rounded-xl border border-line surface-floating p-2.5 shadow-popover outline-none"
            // Hidden for the one frame it is measured in, so it is never seen at 0,0.
            style={{ left: at?.left ?? 0, top: at?.top ?? 0, visibility: at === null ? 'hidden' : 'visible' }}
            role="dialog"
            aria-label="Icon and colour"
            tabIndex={-1}
          >
            <div className="grid grid-cols-6 gap-1" role="radiogroup" aria-label="Project colour">
              {swatches.map((option) => {
                const selected = option.value.toLowerCase() === accent.toLowerCase()
                return (
                  <label className={cellClass} key={option.value} title={option.label}>
                    <input
                      className="peer sr-only"
                      type="radio"
                      name="project-color"
                      value={option.value}
                      checked={selected}
                      aria-label={option.label}
                      onChange={() => onColor(option.value)}
                    />
                    {/* The swatch carries the colour, so the ring that marks it stays neutral. */}
                    <span className={`${markClass} ${selected ? 'border-text' : 'border-transparent'}`}>
                      <span
                        className="h-[26px] w-[26px] rounded-full"
                        style={{ backgroundColor: option.value }}
                      />
                    </span>
                  </label>
                )
              })}
            </div>

            <div className="my-2 border-t border-line" />

            <div
              className="grid max-h-[216px] grid-cols-6 gap-1 overflow-y-auto overscroll-contain"
              role="radiogroup"
              aria-label="Project icon"
            >
              {PROJECT_ICON_OPTIONS.map((option) => {
                const selected = option.value === icon
                return (
                  <label
                    className={cellClass}
                    key={option.value}
                    ref={selected ? selectedIconRef : undefined}
                    title={option.label}
                  >
                    <input
                      className="peer sr-only"
                      type="radio"
                      name="project-icon"
                      value={option.value}
                      checked={selected}
                      aria-label={option.label}
                      onChange={() => onIcon(option.value)}
                    />
                    {/* The picked glyph wears the picked colour: the pair, exactly as the sidebar will show it. */}
                    <span
                      className={`${markClass} ${
                        selected ? '' : 'border-transparent text-muted hover:bg-surface-2 hover:text-text'
                      }`}
                      style={selected ? { color: accent, borderColor: accent } : undefined}
                    >
                      <Icon icon={option.icon} size={18} />
                    </span>
                  </label>
                )
              })}
            </div>

            <div className="flex justify-end pt-2">
              <Button size="small" onClick={() => setOpen(false)}>
                Done
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
