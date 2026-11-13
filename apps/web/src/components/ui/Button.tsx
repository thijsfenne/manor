import type { ButtonHTMLAttributes } from 'react'

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
type ButtonSize = 'compact' | 'small' | 'medium'

/**
 * Secondary and danger carry a wash rather than a hairline: a fill of their own text
 * colour at low alpha. Translucent so the button lifts off whatever surface it lands
 * on (dialog, panel, row) instead of matching one of them, and so the light theme
 * needs no second set of values — the wash follows the token that flipped.
 */
const variantClass: Record<ButtonVariant, string> = {
  primary: 'border-transparent bg-primary text-on-primary hover:bg-primary-hover',
  secondary:
    'border-transparent bg-[color-mix(in_srgb,var(--color-text)_8%,transparent)] text-muted hover:bg-[color-mix(in_srgb,var(--color-text)_13%,transparent)] hover:text-text',
  ghost: 'border-transparent bg-transparent text-muted hover:bg-surface-2 hover:text-text',
  danger:
    'border-transparent bg-[color-mix(in_srgb,var(--color-danger)_12%,transparent)] text-danger hover:bg-[color-mix(in_srgb,var(--color-danger)_20%,transparent)]',
}

/**
 * Small and medium differ in geometry, not in type size: both set 14px.
 *
 * Buttons rendered at the body's 16px for a long time, because `[font:inherit]` used to
 * override the size utilities here (see below). 14px is the deliberate size now, chosen
 * so labels sit quieter next to body text.
 *
 * `compact` is the one step further down, for a control that sits beside text it
 * must not compete with.
 */
const sizeClass: Record<ButtonSize, string> = {
  compact: 'rounded-button-sm px-2.5 py-1 text-[13px]',
  small: 'rounded-button-sm px-2.5 py-1 text-[14px]',
  medium: 'rounded-button px-3.5 py-1.5 text-[14px]',
}

/** The same geometry for a control that has to be an element of its own, an external link above all. */
export const buttonClass = (variant: ButtonVariant = 'secondary', size: ButtonSize = 'medium'): string =>
  `cursor-pointer border font-medium disabled:cursor-default disabled:opacity-[0.45] ${variantClass[variant]} ${sizeClass[size]}`

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
}

/**
 * Shared control geometry. Feature components decide the words and the act.
 *
 * No `[font:inherit]` here, and none on any control that states its own size: the
 * shorthand lands after the size utilities in Tailwind's output, so it silently
 * overrode every `text-[12px]` on this component and buttons rendered at the body's
 * 16px. `button { font-family: inherit }` in the base layer is what the shorthand was
 * for, and it does that job without touching size.
 */
export function Button({
  variant = 'secondary',
  size = 'medium',
  className = '',
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`${buttonClass(variant, size)} ${className}`}
      {...props}
    />
  )
}
