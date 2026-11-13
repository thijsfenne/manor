import { useState } from 'react'

/**
 * A binary state you flip in place, for settings that take effect the moment they
 * change. The knob inverts with the track for the same reason the primary button
 * does: this palette is achromatic, so contrast is the only signal available.
 */
export function Switch({
  checked,
  label,
  describedBy,
  indeterminate,
  disabled = false,
  onChange,
}: {
  checked: boolean
  /** Named for readers who cannot see the track; the visible caption sits beside it. */
  label: string
  describedBy?: string
  /** Supplying this opts into checkbox semantics, which can announce a partial group. */
  indeterminate?: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}) {
  // Nothing bounces until it has been thrown once. A settings page mounts every switch
  // it has at the same moment, and a row of them playing their travel on arrival reads
  // as the page settling rather than as state anyone chose.
  const [touched, setTouched] = useState(false)

  return (
    <button
      type="button"
      role={indeterminate === undefined ? 'switch' : 'checkbox'}
      aria-checked={indeterminate ? 'mixed' : checked}
      aria-label={label}
      aria-describedby={describedBy}
      disabled={disabled}
      data-on={checked}
      data-mixed={indeterminate || undefined}
      data-touched={touched}
      className={`switch relative h-5 w-9 flex-none cursor-pointer rounded-full border-0 p-0 disabled:cursor-default disabled:opacity-[0.45] ${
        checked ? 'bg-primary' : 'bg-[color-mix(in_srgb,var(--color-text)_18%,transparent)]'
      }`}
      onClick={() => {
        setTouched(true)
        onChange(indeterminate || !checked)
      }}
    >
      <span
        className={`switch-thumb absolute top-0.5 left-0.5 h-4 w-4 rounded-full ${
          checked ? 'bg-on-primary' : 'bg-text'
        }`}
      />
    </button>
  )
}
