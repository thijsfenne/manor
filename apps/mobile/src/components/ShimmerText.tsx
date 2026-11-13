import MaskedView from '@react-native-masked-view/masked-view'
import { LinearGradient } from 'expo-linear-gradient'
import { useEffect, useState } from 'react'
import { StyleSheet, View, type LayoutChangeEvent, type StyleProp, type TextStyle } from 'react-native'
import Animated, { cancelAnimation, Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated'

import { Text } from '@/components/Text'
import { shimmerTones, useScheme } from '@/theme'

/** One pass of the band, edge to edge. The Mac's `shimmer-text` runs on the same clock. */
const SWEEP = 2000

interface ShimmerTextProps {
  text: string
  numberOfLines?: number
  /** The type this label would read in when it were settled; only its colour is taken over. */
  style?: StyleProp<TextStyle>
}

/**
 * A label that is waiting on something, in the Mac's own shimmer rather than a pulse:
 * the glyphs sit in the muted tone and a band of the full text colour walks across
 * them, so the words stay legible the whole time and the sweep only ever brightens.
 *
 * The web paints that band onto a duplicate of the string and clips it to the glyph
 * shapes; native has no `background-clip: text`, so the same picture is built the one
 * way a phone can build it, a mask of the text over a base fill with the gradient
 * travelling above it. The invisible copy underneath is what gives the mask a size.
 *
 * Applied by state, never by role: a shimmer on a settled label is a lie about work
 * in flight. Under reduced motion the band is not slowed but dropped, and what is
 * left is the muted label, which is the same thing the Mac is left with.
 */
export function ShimmerText({ text, numberOfLines = 1, style }: ShimmerTextProps) {
  const still = useReducedMotion()
  const tone = shimmerTones[useScheme()]
  const [width, setWidth] = useState(0)
  const shift = useSharedValue(0)

  useEffect(() => {
    if (still || width === 0) return undefined
    shift.value = 0
    shift.value = withRepeat(withTiming(1, { duration: SWEEP, easing: Easing.linear }), -1, false)
    return () => {
      cancelAnimation(shift)
      shift.value = 0
    }
  }, [shift, still, width])

  // The band is as wide as the label and starts one label-width off its left edge, so
  // the bright centre enters and leaves past both ends instead of blinking on at them.
  const band = useAnimatedStyle(() => ({ transform: [{ translateX: width * (shift.value * 2 - 1) }] }))

  if (still) {
    return (
      <Text numberOfLines={numberOfLines} style={[style, { color: tone.base }]}>
        {text}
      </Text>
    )
  }

  return (
    <MaskedView
      maskElement={
        <Text numberOfLines={numberOfLines} style={[style, styles.mask]}>
          {text}
        </Text>
      }
      onLayout={(event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width)}
      style={styles.host}
    >
      <Text numberOfLines={numberOfLines} style={[style, styles.sizer]}>
        {text}
      </Text>
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: tone.base }]} />
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, band]}>
        <LinearGradient
          colors={[tone.clear, tone.glow, tone.clear]}
          end={{ x: 1, y: 0.5 }}
          start={{ x: 0, y: 0.5 }}
          style={StyleSheet.absoluteFill}
        />
      </Animated.View>
    </MaskedView>
  )
}

const styles = StyleSheet.create({
  host: { flexShrink: 1 },
  mask: { color: shimmerTones.mask },
  sizer: { opacity: 0 },
})
