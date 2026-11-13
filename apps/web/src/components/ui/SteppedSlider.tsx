import type { CSSProperties } from 'react'

/** Native range semantics and keyboard handling, with one named stop per option. */
export function SteppedSlider<T extends string>({
  label,
  options,
  value,
  disabled = false,
  onChange,
}: {
  label: string
  options: readonly { value: T; label: string }[]
  value: T
  disabled?: boolean
  onChange: (value: T) => void
}) {
  if (options.length === 0) return null
  const index = Math.max(0, options.findIndex((option) => option.value === value))
  const last = options.length - 1
  const progress = last > 0 ? index / last : 0

  return (
    <div
      className={`stepped-slider relative flex h-11 items-center ${disabled || last === 0 ? 'opacity-45' : ''}`}
      style={{ '--slider-progress': progress } as CSSProperties}
    >
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 h-8 overflow-hidden rounded-full bg-user-bg">
        <div className="stepped-slider-fill absolute inset-y-0 left-0 rounded-full bg-picked" />
      </div>
      <div aria-hidden="true" className="stepped-slider-stops pointer-events-none absolute inset-y-0">
        {options.map((option, stop) => (
          <span
            key={option.value}
            className="absolute top-1/2 size-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-muted"
            style={{ left: `${last > 0 ? stop / last * 100 : 0}%` }}
          />
        ))}
      </div>
      <input
        type="range"
        className="stepped-slider-input relative m-0 h-11 w-full cursor-pointer appearance-none rounded-full bg-transparent p-1 disabled:cursor-default"
        aria-label={label}
        aria-valuetext={options[index]?.label}
        min={0}
        max={last}
        step={1}
        value={index}
        disabled={disabled || last === 0}
        onChange={(event) => {
          const option = options[Number(event.currentTarget.value)]
          if (option && option.value !== value) onChange(option.value)
        }}
      />
    </div>
  )
}
