import { StyleSheet, Text as RNText, type TextProps, type TextStyle } from 'react-native'
import Animated from 'react-native-reanimated'

import { fonts, tracking } from '@/theme'

/**
 * The one Text the app renders. It does two things a native app gets for free.
 *
 * Tracking: RN draws the font without the optical tracking iOS applies natively, so
 * this puts it back by size. A style without a fontSize inherits its parent's
 * tracking, an explicit `letterSpacing` always wins, and mono keeps its own rhythm.
 *
 * Face: the sans is four registered families rather than one with four cuts, because
 * native text finds a face by family name and drops a weight or a slant it cannot
 * find in that one family. So a run asking for 500 or for italic is handed the family
 * that *is* that cut, and the request itself is cleared so nothing is applied twice.
 */
export function Text({ style, ...props }: TextProps) {
  const flat = StyleSheet.flatten(style)
  const size = flat?.fontSize
  const tracked: TextStyle =
    size === undefined || flat?.fontFamily === fonts.mono || size < 13 || size > 17
      ? {}
      : { letterSpacing: size >= 15 ? tracking.body : tracking.small }
  return <RNText style={[tracked, style, face(flat)]} {...props} />
}

/**
 * The cut this run is really in, or null when there is nothing to resolve. Only a run
 * that asks for emphasis is touched: a plain one keeps inheriting whatever the Text
 * above it reads in, which is how a nested span in a code block stays mono.
 */
function face(flat: TextStyle | undefined): TextStyle | null {
  const family = flat?.fontFamily
  if (family !== undefined && family !== fonts.sans) return null
  const medium = flat?.fontWeight !== undefined && EMPHATIC.has(flat.fontWeight)
  const italic = flat?.fontStyle === 'italic'
  if (!medium && !italic) return null
  return {
    fontFamily: medium ? (italic ? fonts.sansMediumItalic : fonts.sansMedium) : fonts.sansItalic,
    fontWeight: '400',
    fontStyle: 'normal',
  }
}

/** Every weight the app writes is 400 or 500; the heavier ones are here so a stray one lands on Medium rather than on nothing. */
const EMPHATIC = new Set<TextStyle['fontWeight']>(['500', 500, '600', 600, '700', 700, 'bold'])

export const AnimatedText = Animated.createAnimatedComponent(Text)
