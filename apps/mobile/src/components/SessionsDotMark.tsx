import type { SessionsDot } from '@manor/client-runtime/state'
import { useEffect } from 'react'
import { StyleSheet } from 'react-native'
import Animated, { Easing, FadeIn, FadeOut, ReduceMotion, cancelAnimation, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated'

import { colors } from '@/theme'

/** The Mac's text swap: 150ms, eased both ways. A dot that changes colour crossfades on the same clock. */
const EASE = Easing.inOut(Easing.ease)
const PULSE_MS = 900

const TONE: Record<SessionsDot, (typeof colors)[keyof typeof colors]> = {
  waiting: colors.warning,
  finished: colors.ok,
  working: colors.muted,
}

/**
 * The dot on a project thread's Sessions button. Yellow when the user is needed, green
 * when a Session finished unseen, a pulsing neutral while one runs. The page-coloured
 * rim keeps it readable over the glass. Under Reduce Motion the pulse holds still.
 */
export function SessionsDotMark({ dot }: { dot: SessionsDot }) {
  const pulse = useSharedValue(1)
  const working = dot === 'working'
  useEffect(() => {
    if (!working) {
      pulse.value = 1
      return undefined
    }
    pulse.value = withRepeat(withTiming(0.35, { duration: PULSE_MS, easing: EASE, reduceMotion: ReduceMotion.System }), -1, true)
    return () => cancelAnimation(pulse)
  }, [working, pulse])
  const style = useAnimatedStyle(() => ({ opacity: pulse.value }))
  return (
    <Animated.View
      accessibilityElementsHidden
      entering={FadeIn.duration(150).easing(EASE)}
      exiting={FadeOut.duration(150).easing(EASE)}
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={styles.slot}
    >
      <Animated.View style={[styles.dot, { backgroundColor: TONE[dot] }, style]} />
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  slot: { position: 'absolute', top: 4, right: 4 },
  dot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: colors.background,
  },
})
