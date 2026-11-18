import type { ReactNode } from 'react'
import { Icon } from '../Icon'

interface BadgeProps {
  /** A mark for what kind of thing this names. Optional; most badges are a word. */
  icon?: Parameters<typeof Icon>[0]['icon']
  /** A brand mark in place of the icon, such as a provider's logo in its own colours. */
  mark?: ReactNode
  /**
   * A runtime identity colour, a project's for instance. It colours the icon and a
   * faint fill in place of the outline; the text keeps its token colour, because
   * these swatches are only guaranteed to hold up as icon colours.
   */
  tint?: string
  /** Sits inside a 12px line of meta text without growing it. */
  size?: 'default' | 'inline'
  /** Native hover text for what the label alone leaves out. */
  title?: string
  className?: string
  children: ReactNode
}

/**
 * A read-only label on something else: a tag, a space, a source attachment's kind.
 *
 * Not `Pill`, which is a toggle with two fills and an aria-pressed state. This one is
 * never a control, so it never takes a hover or a press, and the outline is what says
 * so: at this size a border reads as "attached to the thing above it" where a fill
 * reads as "you can press this". A tinted badge trades the outline for its colour.
 */
export function Badge({ icon, mark, tint, size = 'default', title, className = '', children }: BadgeProps) {
  const inline = size === 'inline'
  return (
    <span
      title={title}
      className={`inline-flex min-w-0 max-w-full items-center rounded-chip text-meta ${
        inline ? 'gap-1 py-px pr-1.5 pl-1 font-medium' : 'gap-1.5 px-2 py-1'
      } ${tint === undefined ? 'border border-line bg-surface-2 text-muted' : 'text-text'} ${className}`}
      style={tint === undefined ? undefined : { backgroundColor: `color-mix(in srgb, ${tint} 16%, transparent)` }}
    >
      {mark}
      {icon === undefined ? null : (
        <Icon icon={icon} size={inline ? 12 : 13} className="flex-none" {...(tint === undefined ? {} : { style: { color: tint } })} />
      )}
      <span className="min-w-0 truncate">{children}</span>
    </span>
  )
}
