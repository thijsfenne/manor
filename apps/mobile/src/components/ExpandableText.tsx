import { useState } from 'react'
import { Pressable, StyleSheet, View, type StyleProp, type TextStyle } from 'react-native'
import Animated, { Easing, LinearTransition, ReduceMotion } from 'react-native-reanimated'

import { colors, fonts, spacing } from '@/theme'
import { Text } from './Text'

const CLOSED_LINES = 2

/**
 * A text cut at the end of its second line. The way to open it appears only when the text
 * really runs past the cut: a copy laid out unclamped, out of sight, counts the lines at
 * this width. By default the way is a "Show more" link under the text; with `tapText` the
 * text itself is the target, for a line that sits between buttons. Either folds it again.
 */
export function ExpandableText({ text, style, tapText = false }: { text: string; style: StyleProp<TextStyle>; tapText?: boolean }) {
  const [open, setOpen] = useState(false)
  const [truncated, setTruncated] = useState(false)
  const toggle = () => setOpen((value) => !value)
  const shown = <Text numberOfLines={open ? undefined : CLOSED_LINES} style={style}>{text}</Text>
  return (
    <Animated.View layout={LinearTransition.duration(220).easing(Easing.out(Easing.exp)).reduceMotion(ReduceMotion.System)}>
      <View>
        {tapText && truncated ? (
          <Pressable accessibilityHint={open ? 'Folds it again' : 'Shows all of it'} accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={toggle}>
            {shown}
          </Pressable>
        ) : shown}
        <Text
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          pointerEvents="none"
          onTextLayout={(event) => setTruncated(event.nativeEvent.lines.length > CLOSED_LINES)}
          style={[style, styles.measure]}
        >
          {text}
        </Text>
      </View>
      {truncated && !tapText ? (
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={toggle}>
          <Text style={styles.showMore}>{open ? 'Show less' : 'Show more'}</Text>
        </Pressable>
      ) : null}
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  measure: { position: 'absolute', left: 0, right: 0, top: 0, opacity: 0 },
  showMore: { alignSelf: 'flex-start', marginTop: spacing.xs, color: colors.text, fontFamily: fonts.sans, fontSize: 13 },
})
