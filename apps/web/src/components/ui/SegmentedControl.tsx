import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { INSTANT, SEGMENTED_SLIDE } from '../../motion'

export interface SegmentOption<Value extends string> {
  value: Value
  label: string
  tabId: string
  panelId: string
  /** Keeps the segment in place but unselectable, so the control does not reflow when data is absent. */
  disabled?: boolean
}

export interface SymbolSegmentOption<Value extends string> {
  value: Value
  label: string
  symbol: ReactNode
  title?: string
}

type SegmentedControlProps<Value extends string> = {
  label: string
  value: Value
  onChange: (value: Value) => void
  disabled?: boolean
  orientation?: 'horizontal' | 'vertical'
  /** Symbols only: hugs its content at a 28px height, for a control sharing a row with a label. */
  compact?: boolean
  /** Inside a floating menu: the pick takes `menu-selected` and the rest hover on `user-bg`. */
  floating?: boolean
} & (
  | { options: readonly SegmentOption<Value>[]; variant?: 'labels' }
  | { options: readonly SymbolSegmentOption<Value>[]; variant: 'symbols' }
)

const optionDisabled = (option: object | undefined): boolean =>
  option !== undefined && 'disabled' in option && option.disabled === true

/** A compact single-choice switch whose selected surface travels between labels or symbols. */
export function SegmentedControl<Value extends string>({
  label,
  options,
  value,
  onChange,
  disabled = false,
  variant = 'labels',
  orientation = 'horizontal',
  compact = false,
  floating = false,
}: SegmentedControlProps<Value>) {
  const instanceId = useId()
  const buttons = useRef<Array<HTMLButtonElement | null>>([])
  const reduceMotion = useReducedMotion()
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value))

  const moveFocus = (event: KeyboardEvent<HTMLButtonElement>) => {
    const enabled = (index: number) => !optionDisabled(options[index])
    const step = (from: number, direction: 1 | -1) => {
      for (let offset = 1; offset <= options.length; offset += 1) {
        const index = (from + direction * offset + options.length * offset) % options.length
        if (enabled(index)) return index
      }
      return undefined
    }
    let nextIndex: number | undefined
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      nextIndex = step(selectedIndex, -1)
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      nextIndex = step(selectedIndex, 1)
    } else if (event.key === 'Home') {
      nextIndex = step(-1, 1)
    } else if (event.key === 'End') {
      nextIndex = step(options.length, -1)
    }
    if (nextIndex === undefined) return
    event.preventDefault()
    const next = options[nextIndex]
    if (next === undefined) return
    if (disabled) return
    onChange(next.value)
    buttons.current[nextIndex]?.focus()
  }

  return (
    <div
      className={`inline-flex items-center ${
        variant === 'symbols'
          ? orientation === 'vertical'
            ? 'flex-col gap-1'
            : compact ? 'gap-0.5' : 'w-full gap-1'
          : 'gap-0.5 rounded-full'
      }`}
      role={variant === 'symbols' ? 'radiogroup' : 'tablist'}
      aria-label={label}
      aria-orientation={variant === 'symbols' ? orientation : undefined}
    >
      {options.map((option, index) => {
        const selected = option.value === value
        const tabOption = variant === 'labels' ? option as SegmentOption<Value> : undefined
        const symbolOption = variant === 'symbols' ? option as SymbolSegmentOption<Value> : undefined
        return (
          <button
            key={option.value}
            ref={(node) => {
              buttons.current[index] = node
            }}
            id={tabOption?.tabId}
            type="button"
            disabled={disabled || optionDisabled(option)}
            role={variant === 'symbols' ? 'radio' : 'tab'}
            aria-selected={variant === 'labels' ? selected : undefined}
            aria-checked={variant === 'symbols' ? selected : undefined}
            aria-controls={tabOption?.panelId}
            aria-label={symbolOption?.label}
            title={symbolOption?.title ?? symbolOption?.label}
            tabIndex={selected ? 0 : -1}
            className={`relative cursor-pointer border-0 bg-transparent outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-default disabled:opacity-50 ${
              variant === 'symbols'
                ? compact
                  ? 'grid h-7 min-w-7 place-items-center rounded-md px-1.5 text-label'
                  : orientation === 'vertical'
                    ? 'grid h-10 w-10 place-items-center rounded-lg p-0'
                    : 'grid h-10 min-w-0 flex-1 place-items-center rounded-lg p-0'
                : 'h-7 rounded-full px-3 text-label font-medium'
            } ${
              selected ? 'text-text' : `text-muted hover:text-text ${floating ? 'hover:bg-user-bg' : ''}`
            }`}
            onClick={() => onChange(option.value)}
            onKeyDown={moveFocus}
          >
            {selected ? (
              <motion.span
                layoutId={`segmented-control-${instanceId}`}
                className={`absolute inset-0 z-0 rounded-[inherit] ${floating ? 'bg-menu-selected' : 'bg-user-bg'}`}
                initial={false}
                transition={reduceMotion ? INSTANT : SEGMENTED_SLIDE}
              />
            ) : null}
            <span className={`relative z-10 ${variant === 'symbols' ? 'grid place-items-center' : ''}`}>
              {symbolOption?.symbol ?? option.label}
            </span>
          </button>
        )
      })}
    </div>
  )
}
