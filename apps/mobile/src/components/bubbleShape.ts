import { useState } from 'react'
import type { LayoutChangeEvent } from 'react-native'

import { bubbleText, radius, spacing } from '@/theme'

/** A DM bubble's padding, which his bubble, hers and the send flight's copy all use. */
export const SENT_BUBBLE_PAD = { x: spacing.md + 2, y: spacing.sm + 1 }

const ONE_LINE = bubbleText.lineHeight + SENT_BUBBLE_PAD.y * 2

/** A one-line bubble is a capsule; a taller one takes a softer corner, so it reads as a block. */
export const bubbleCorner = (height: number) => height > ONE_LINE + 2 ? radius.lg : radius.composer

/** The corner for a bubble whose height is only known once it is laid out. */
export function useBubbleCorner(): [corner: number, onLayout: (event: LayoutChangeEvent) => void] {
  const [corner, setCorner] = useState<number>(radius.composer)
  return [corner, (event) => setCorner(bubbleCorner(event.nativeEvent.layout.height))]
}
