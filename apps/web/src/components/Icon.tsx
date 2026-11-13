import { HugeiconsIcon } from '@hugeicons/react'
import type { ComponentProps } from 'react'

type IconProps = ComponentProps<typeof HugeiconsIcon>

/**
 * The one place icon defaults live: every icon in Manor goes through this so a
 * glyph never has to repeat its size or restate that it follows the text color.
 * Import the glyph from @hugeicons/core-free-icons and pass it as
 * `icon`; solid variants are for active/selected states only.
 */
export function Icon({ size = 14, color = 'currentColor', strokeWidth = 1.8, ...rest }: IconProps) {
  return <HugeiconsIcon size={size} color={color} strokeWidth={strokeWidth} {...rest} />
}
