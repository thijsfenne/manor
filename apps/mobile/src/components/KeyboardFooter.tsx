import type { ViewProps } from 'react-native'
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller'
import Animated, { interpolate, useAnimatedStyle } from 'react-native-reanimated'

import { spacing } from '@/theme'

/** The gap a footer keeps above the tab bar, above the keys, and to the sides while the keys are up. */
export const FOOTER_GAP = spacing.sm
/** Its side inset at rest: iOS floats the tab bar 21pt in, so the footer stands a little wider. */
const FOOTER_REST_INSET = spacing.lg

interface KeyboardFooterProps extends ViewProps {
  /** Whether it follows the keyboard at all; off, it stays where the layout put it. */
  enabled: boolean
  /**
   * The space under the footer that the keyboard covers: the tab bar with its margin, from
   * the safe area's bottom inset. It is also how far the footer sinks once the keys are up,
   * so a list that keeps its last row above the footer is told the same distance.
   */
  sink: number
  /**
   * Off, the caller applies `useFooterPadding` inside its own view: a footer that measures
   * itself for the list's bottom inset, or holds a full-width layer such as a scrim.
   */
  padded?: boolean
}

/**
 * The footer's padding: `FOOTER_GAP` above the tab bar, a little wider than the bar at rest,
 * and `FOOTER_GAP` from the edges with the keys up. `KeyboardFooter` applies it unless `padded`
 * is off.
 */
export function useFooterPadding(enabled: boolean, sink: number) {
  const { progress } = useReanimatedKeyboardAnimation()
  return useAnimatedStyle(() => ({
    paddingBottom: sink + FOOTER_GAP,
    paddingHorizontal: interpolate(enabled ? progress.get() : 0, [0, 1], [FOOTER_REST_INSET, FOOTER_GAP]),
  }), [enabled, sink])
}

/**
 * The footer of a tab's screen: the composer, or a toolbar. At rest it stands `FOOTER_GAP`
 * above the tab bar and a little wider, and with the keys up it rides them that far above,
 * widening to the same gap at the sides. Unlike the library's sticky view it never moves
 * below where the layout put it, so a keyboard shorter than the bar (a hardware keyboard
 * shows only its suggestion strip) leaves it above the bar instead of sinking it behind.
 */
export function KeyboardFooter({ enabled, sink, padded = true, style, ...props }: KeyboardFooterProps) {
  const { height, progress } = useReanimatedKeyboardAnimation()
  const padding = useFooterPadding(enabled, sink)
  const ride = useAnimatedStyle(() => ({
    transform: [{ translateY: enabled ? Math.min(0, height.get() + progress.get() * sink) : 0 }],
  }), [enabled, sink])
  return <Animated.View style={[style, padded ? padding : null, ride]} {...props} />
}
