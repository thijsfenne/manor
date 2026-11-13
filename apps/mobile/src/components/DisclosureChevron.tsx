import { useEffect, type ReactElement } from 'react'
import Animated, { Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated'

/** The 90° turn of a folding section header: points right while folded, down while open. */
export function DisclosureChevron({ open, children }: { open: boolean; children: ReactElement }) {
  const still = useReducedMotion()
  const progress = useSharedValue(open ? 1 : 0)
  useEffect(() => {
    progress.set(still ? (open ? 1 : 0) : withTiming(open ? 1 : 0, { duration: 180, easing: Easing.out(Easing.cubic) }))
  }, [open, progress, still])
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${-90 + progress.get() * 90}deg` }] }))
  return <Animated.View style={style}>{children}</Animated.View>
}
