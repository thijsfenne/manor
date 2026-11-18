import { useEffect } from 'react'
import { StyleSheet, type ColorValue } from 'react-native'
import Animated, { Easing, ReduceMotion, useAnimatedProps, useSharedValue, withTiming } from 'react-native-reanimated'
import Svg, { Circle } from 'react-native-svg'

const RING_RADIUS = 9.5
const RING_LENGTH = 2 * Math.PI * RING_RADIUS
const AnimatedCircle = Animated.createAnimatedComponent(Circle)

/**
 * A progress ring that fills as plan steps finish (1/4, 2/4, ...), travelling the whole
 * move on the house curve and standing still under Reduce Motion. The tasks card header
 * and the Sessions overview draw the same ring; only the size and colours differ.
 */
export function PlanRing({ done, total, size = 15, track, trackOpacity = 1, fill }: {
  done: number
  total: number
  size?: number
  track: ColorValue
  trackOpacity?: number
  fill: ColorValue
}) {
  const fraction = total === 0 ? 0 : done / total
  const progress = useSharedValue(fraction)
  useEffect(() => {
    progress.set(withTiming(fraction, { duration: 400, easing: Easing.out(Easing.exp), reduceMotion: ReduceMotion.System }))
  }, [fraction, progress])
  const arc = useAnimatedProps(() => ({
    strokeDashoffset: RING_LENGTH * (1 - progress.get()),
    strokeOpacity: progress.get() > 0 ? 1 : 0,
  }))
  return (
    <Svg height={size} style={styles.ring} viewBox="0 0 24 24" width={size}>
      <Circle cx={12} cy={12} fill="none" r={RING_RADIUS} stroke={track} strokeOpacity={trackOpacity} strokeWidth={3} />
      <AnimatedCircle
        animatedProps={arc}
        cx={12}
        cy={12}
        fill="none"
        r={RING_RADIUS}
        stroke={fill}
        strokeDasharray={`${RING_LENGTH} ${RING_LENGTH}`}
        strokeLinecap="round"
        strokeWidth={3}
      />
    </Svg>
  )
}

const styles = StyleSheet.create({
  ring: { transform: [{ rotate: '-90deg' }] },
})
