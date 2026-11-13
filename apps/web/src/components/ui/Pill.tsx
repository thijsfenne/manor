import { useId, useRef, useState, type ReactNode } from 'react'
import { InformationCircleIcon } from '@hugeicons/core-free-icons'
import { Icon } from '../Icon'
import { Tooltip } from './Tooltip'

interface PillProps {
  label: string
  on: boolean
  /**
   * Struck through when off, for a set you are subtracting from rather than adding
   * to: an excluded MCP tool still exists on the server, and reading it as simply
   * unpicked would lose that.
   */
  struck?: boolean
  /** Tool and server names that are typed somewhere else exactly as they read here. */
  mono?: boolean
  /**
   * What this pill is, for a name that does not say it on its own. Adds an `i` that
   * shows the text on hover; without a hint there is no icon and no extra width.
   */
  hint?: ReactNode
  /**
   * Shown but not choosable, for an option a wider setting already rules out. Still
   * focusable and still showing its hint, because the hint is where the reason lives.
   */
  disabled?: boolean
  /** `sm` sits inside a card's 13px text, such as a result card's open choices. */
  size?: 'md' | 'sm'
  onToggle: () => void
}

/**
 * One choice in a wrapping set of them: Settings' skills, tools and models, and a
 * result card's open choices. Unpicked reads grey in a hairline outline; only the picked
 * one turns blue, a wash with a soft blue edge, so the pick is the one thing that stands out.
 */
export function Pill({ label, on, struck = false, mono = false, hint, disabled = false, size = 'md', onToggle }: PillProps) {
  const ref = useRef<HTMLButtonElement>(null)
  // The pill is the anchor, not the icon: a card that points at the whole thing
  // survives the pointer moving the last two pixels onto the name.
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  const hintId = useId()
  const show = () => setAnchor(ref.current)
  const hide = () => setAnchor(null)

  return (
    <button
      ref={ref}
      type="button"
      aria-pressed={on}
      aria-disabled={disabled || undefined}
      aria-describedby={anchor === null ? undefined : hintId}
      // No `[font:inherit]`: Tailwind emits that arbitrary property after `text-[…]`
      // and `font-medium`, so the shorthand won and every pill rendered at the body's
      // 16px in book weight, whatever the class list said. The base layer inherits the
      // family for buttons anyway, so dropping it is what lets the weight land.
      //
      // 16px is stated here rather than inherited, because 16px is what these pills
      // have rendered at for their whole life and the size they were kept at. The
      // declared 12px was a dead letter under the shorthand, never a size anyone saw.
      className={`inline-flex max-w-full items-center gap-1 rounded-button-sm border font-medium ${
        size === 'sm' ? 'py-1 pl-2.5 text-[12.5px] leading-[1.35]' : 'py-0.5 pl-2 text-[16px]'
      } ${hint === undefined ? (size === 'sm' ? 'pr-2.5' : 'pr-2') : 'pr-1.5'} ${mono ? 'font-mono' : ''} ${
        disabled
          ? 'cursor-default border-line bg-transparent text-dim opacity-60'
          : on
            ? 'cursor-pointer border-busy/40 bg-busy/15 text-text'
            : 'cursor-pointer border-line bg-transparent text-muted hover:bg-surface-2 hover:text-text'
      }`}
      onClick={disabled ? undefined : onToggle}
      // Keyboard gets the same text the pointer gets, and the whole pill is the one
      // tab stop: an icon that focuses on its own would double every grid's length.
      onFocus={hint === undefined ? undefined : show}
      onBlur={hint === undefined ? undefined : hide}
    >
      {/* The strike is the label's, so it never runs through the icon beside it. */}
      <span className={`min-w-0 truncate ${!on && struck ? 'line-through' : ''}`}>{label}</span>
      {hint === undefined ? null : (
        <span
          className="inline-flex opacity-55 hover:opacity-100"
          onPointerEnter={show}
          // Focus outlives the pointer: leaving the icon of a pill that has focus
          // would take away the card the keyboard just opened.
          onPointerLeave={() => {
            if (document.activeElement !== ref.current) hide()
          }}
        >
          <Icon icon={InformationCircleIcon} size={13} />
        </span>
      )}
      {anchor === null ? null : (
        <Tooltip anchor={anchor} id={hintId} onDismiss={hide}>
          {hint}
        </Tooltip>
      )}
    </button>
  )
}

interface PillGroupProps {
  label: string
  /**
   * The whole-row switch. Its label says what the press will do rather than what is
   * true now, because a row of pills already says what is true.
   */
  action?: { label: string; onSelect: () => void }
  children: ReactNode
}

/**
 * A named row of pills with one action over it. The name sits above the row rather
 * than beside it: a left column has to be wide enough for the longest group name and
 * narrow enough to leave room for pills, which is a compromise at every width.
 */
export function PillGroup({ label, action, children }: PillGroupProps) {
  return (
    <div className="flex flex-col gap-1.5" role="group" aria-label={label}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-label text-dim">{label}</span>
        {action === undefined ? null : (
          <button
            type="button"
            className="flex-none cursor-pointer border-0 bg-transparent p-0 text-[16px] text-muted hover:text-text"
            onClick={action.onSelect}
          >
            {action.label}
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  )
}
