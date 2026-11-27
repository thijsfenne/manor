import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { INSTANT, SEGMENTED_SLIDE } from '../../motion'
import { Tooltip } from './Tooltip'

export interface SegmentOption<Value extends string> {
  value: Value
  label: string
  tabId: string
  panelId: string
  /** Keeps the segment in place but unselectable, so the control does not reflow when data is absent. */
  disabled?: boolean
  /** What picking this segment means, shown in a tooltip on hover and keyboard focus. */
  hint?: string
  /**
   * How many items the segment holds, drawn muted after the label. `name` is what a screen
   * reader hears after the label instead, such as "3 mails".
   */
  count?: { value: number; name: string }
}

/** Long enough that a pointer crossing the control on its way elsewhere opens nothing. */
const HINT_DELAY_MS = 400

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
  /**
   * Labels in a narrow column: 12px segments, and one that does not fit wraps to the next
   * line. Only Left and Right move between them; Up and Down stay with the list below.
   */
  dense?: boolean
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
  dense = false,
}: SegmentedControlProps<Value>) {
  const instanceId = useId()
  const buttons = useRef<Array<HTMLButtonElement | null>>([])
  const reduceMotion = useReducedMotion()
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value))
  const hintId = useId()
  const [hinted, setHinted] = useState<{ anchor: HTMLButtonElement; text: string } | null>(null)
  const hintTimer = useRef<number | undefined>(undefined)
  const hideHint = () => {
    window.clearTimeout(hintTimer.current)
    setHinted(null)
  }
  const showHint = (anchor: HTMLButtonElement, text: string | undefined, delay: number) => {
    window.clearTimeout(hintTimer.current)
    if (text === undefined) return setHinted(null)
    hintTimer.current = window.setTimeout(() => setHinted({ anchor, text }), delay)
  }
  useEffect(() => () => window.clearTimeout(hintTimer.current), [])

  const moveFocus = (event: KeyboardEvent<HTMLButtonElement>) => {
    const enabled = (index: number) => !optionDisabled(options[index])
    const step = (from: number, direction: 1 | -1) => {
      for (let offset = 1; offset <= options.length; offset += 1) {
        const index = (from + direction * offset + options.length * offset) % options.length
        if (enabled(index)) return index
      }
      return undefined
    }
    if (dense && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) return
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
          : `gap-0.5 rounded-full ${dense ? 'flex-wrap' : ''}`
      }`}
      role={variant === 'symbols' ? 'radiogroup' : 'tablist'}
      aria-label={label}
      aria-orientation={variant === 'symbols' ? orientation : undefined}
    >
      {options.map((option, index) => {
        const selected = option.value === value
        const tabOption = variant === 'labels' ? option as SegmentOption<Value> : undefined
        const symbolOption = variant === 'symbols' ? option as SymbolSegmentOption<Value> : undefined
        const hint = tabOption?.hint
        const count = tabOption?.count
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
            aria-label={symbolOption?.label ?? (count === undefined ? undefined : `${option.label}, ${count.name}`)}
            aria-describedby={hint !== undefined && hinted?.text === hint ? hintId : undefined}
            title={symbolOption?.title ?? symbolOption?.label}
            tabIndex={selected ? 0 : -1}
            className={`relative cursor-pointer border-0 bg-transparent outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-default disabled:opacity-50 ${
              variant === 'symbols'
                ? compact
                  ? 'grid h-7 min-w-7 place-items-center rounded-md px-1.5 text-label'
                  : orientation === 'vertical'
                    ? 'grid h-10 w-10 place-items-center rounded-lg p-0'
                    : 'grid h-10 min-w-0 flex-1 place-items-center rounded-lg p-0'
                : dense ? 'h-6 rounded-full px-2 text-[12px] font-medium' : 'h-7 rounded-full px-3 text-label font-medium'
            } ${
              selected ? 'text-text' : `text-muted hover:text-text ${floating ? 'hover:bg-user-bg' : ''}`
            }`}
            onClick={() => onChange(option.value)}
            onKeyDown={moveFocus}
            onPointerEnter={hint === undefined ? undefined : (event) => showHint(event.currentTarget, hint, HINT_DELAY_MS)}
            // A keyboard user's hint stays while focus does, wherever the pointer goes.
            onPointerLeave={hint === undefined ? undefined : (event) => {
              if (!event.currentTarget.matches(':focus-visible')) hideHint()
            }}
            // Arrow keys move focus and the pick together, so the hint follows the pick.
            onFocus={hint === undefined ? undefined : (event) => {
              if (event.currentTarget.matches(':focus-visible')) showHint(event.currentTarget, hint, 0)
            }}
            onBlur={hint === undefined ? undefined : hideHint}
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
              {count === undefined ? null : <span className="ml-1.5 font-normal tabular-nums text-muted">{count.value}</span>}
            </span>
          </button>
        )
      })}
      {hinted === null ? null : (
        <Tooltip anchor={hinted.anchor} id={hintId} onDismiss={hideHint}>
          {hinted.text}
        </Tooltip>
      )}
    </div>
  )
}
