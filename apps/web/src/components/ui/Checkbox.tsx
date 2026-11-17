import { Tick02Icon } from '@hugeicons/core-free-icons'
import { Icon } from '../Icon'

/** 14px in a dense row, 16px where the box is a field of its own with a caption. */
export type CheckboxSize = 'small' | 'medium'

const boxClass: Record<CheckboxSize, string> = {
  small: 'h-3.5 w-3.5',
  medium: 'h-4 w-4',
}

const tickSize: Record<CheckboxSize, number> = { small: 10, medium: 12 }

interface CheckboxProps {
  checked: boolean
  /**
   * Only where no visible `<label>` wraps the box. A caption in a wrapping label
   * already names the control, and an `aria-label` here would silently replace it
   * with this shorter one.
   */
  label?: string
  disabled?: boolean
  size?: CheckboxSize
  onChange: (checked: boolean) => void
  className?: string
}

/**
 * A choice you make now and commit later, which is the whole difference from
 * `Switch`: a switch takes effect the moment it moves, a box waits for the
 * dialog's Save. Same achromatic on-state as the switch, so the two read as one
 * family rather than two conventions in the same form.
 *
 * The native input stays in the tree instead of being replaced by a
 * `role="checkbox"` button, because three of the four callers wrap the box in a
 * `<label>` with the caption in it. A button would break that association and the
 * caption would stop toggling; this way the browser keeps its own keyboard,
 * focus and accessibility behaviour, and only the drawing is ours.
 */
export function Checkbox({
  checked,
  label,
  disabled = false,
  size = 'small',
  onChange,
  className = '',
}: CheckboxProps) {
  return (
    <span className={`relative inline-flex flex-none ${boxClass[size]} ${className}`}>
      <input
        className="peer absolute inset-0 z-10 m-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-default"
        type="checkbox"
        checked={checked}
        disabled={disabled}
        {...(label === undefined ? {} : { 'aria-label': label })}
        onChange={(event) => onChange(event.target.checked)}
      />
      <CheckboxBox checked={checked} size={size} />
    </span>
  )
}

/**
 * The drawing on its own, for a row that already is the control: an option a whole
 * button toggles cannot nest an input, and a second box drawn by hand there would be
 * a tickbox that drifts from this one the first time either is touched.
 */
export function CheckboxBox({
  checked,
  size = 'small',
  className = '',
}: {
  checked: boolean
  size?: CheckboxSize
  className?: string
}) {
  return (
    <span
      aria-hidden="true"
      data-checked={checked}
      // A tickbox keeps the ring rather than lifting a border, which is the rule
      // for anything nothing is typed into. It is drawn in styles.css, because the
      // ring belongs to the transparent input next door and has to be moved here.
      className={`checkbox-box pointer-events-none flex flex-none items-center justify-center rounded-sm border duration-150 ease-fade peer-disabled:opacity-45 motion-safe:transition-colors ${boxClass[size]} ${
        checked ? 'border-primary bg-primary' : 'border-line bg-surface-2'
      } ${className}`}
    >
      <Icon
        className="checkbox-tick text-on-primary"
        data-checked={checked}
        icon={Tick02Icon}
        size={tickSize[size]}
        strokeWidth={2.4}
      />
    </span>
  )
}
