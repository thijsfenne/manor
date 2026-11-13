import MaskedView from '@react-native-masked-view/masked-view'
import { LinearGradient } from 'expo-linear-gradient'
import { useRef } from 'react'
import { ScrollView, StyleSheet, View, type NativeScrollEvent, type NativeSyntheticEvent, type ScrollViewProps, type StyleProp, type ViewStyle } from 'react-native'
import Animated, { ReduceMotion, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated'

import { scrims } from '@/theme'

/** How deep the fade reaches into the list from an edge with more to scroll. */
const FADE = 28
/** The last few points count as the end, so a list resting a hair short of it shows no fade. */
const SLACK = 2
const EDGE_TIMING = { duration: 160, reduceMotion: ReduceMotion.System }

/**
 * A ScrollView whose top and bottom edges fade out while there is more to scroll that
 * way, so a card that holds more than it shows says so. The fade masks the content
 * itself rather than painting a colour over it, so it works on any card surface.
 * `containerStyle` sizes the wrapper (a flex child that must shrink passes
 * `flexShrink: 1`); everything else goes to the ScrollView.
 */
export function FadingScrollView({ containerStyle, onScroll, onLayout, onContentSizeChange, children, ...props }: ScrollViewProps & { containerStyle?: StyleProp<ViewStyle> }) {
  // The frame lives in a ref and the edge flags in shared values, so scrolling never
  // re-renders the list; the mask animates on the UI thread when an edge flips.
  // `above`/`below` are the flags last written: a shared value set from JS lands
  // later, so comparing against `.value` could skip a reversal still in flight.
  const frame = useRef({ offset: 0, visible: 0, content: 0, above: false, below: false })
  const moreAbove = useSharedValue(false)
  const moreBelow = useSharedValue(false)
  const measure = (next: Partial<Pick<typeof frame.current, 'offset' | 'visible' | 'content'>>) => {
    const { offset, visible, content } = Object.assign(frame.current, next)
    // Clamped to the real range, so an iOS bounce or a list that shrank while
    // scrolled never fades an edge with nothing behind it.
    const range = Math.max(0, content - visible)
    const at = Math.min(Math.max(offset, 0), range)
    const above = at > SLACK
    const below = at < range - SLACK
    if (frame.current.above !== above) {
      frame.current.above = above
      moreAbove.value = above
    }
    if (frame.current.below !== below) {
      frame.current.below = below
      moreBelow.value = below
    }
  }
  // Solid mask over each edge, faded away while that edge has more behind it.
  const topStyle = useAnimatedStyle(() => ({ opacity: withTiming(moreAbove.value ? 0 : 1, EDGE_TIMING) }))
  const bottomStyle = useAnimatedStyle(() => ({ opacity: withTiming(moreBelow.value ? 0 : 1, EDGE_TIMING) }))

  const track = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, layoutMeasurement, contentSize } = event.nativeEvent
    measure({ offset: contentOffset.y, visible: layoutMeasurement.height, content: contentSize.height })
    onScroll?.(event)
  }

  const { mask, maskClear } = scrims.light
  return (
    <MaskedView
      // Android's hardware path keeps a stale mask when its layers animate.
      androidRenderingMode="software"
      style={containerStyle}
      maskElement={
        <View style={StyleSheet.absoluteFill}>
          <View style={styles.edge}>
            <LinearGradient colors={[maskClear, mask]} style={StyleSheet.absoluteFill} />
            <Animated.View style={[styles.solid, topStyle]} />
          </View>
          <View style={styles.solid} />
          <View style={styles.edge}>
            <LinearGradient colors={[mask, maskClear]} style={StyleSheet.absoluteFill} />
            <Animated.View style={[styles.solid, bottomStyle]} />
          </View>
        </View>
      }
    >
      <ScrollView
        {...props}
        onContentSizeChange={(width, height) => {
          measure({ content: height })
          onContentSizeChange?.(width, height)
        }}
        onLayout={(event) => {
          measure({ visible: event.nativeEvent.layout.height })
          onLayout?.(event)
        }}
        onScroll={track}
        scrollEventThrottle={16}
      >
        {children}
      </ScrollView>
    </MaskedView>
  )
}

const styles = StyleSheet.create({
  edge: { height: FADE },
  solid: { flex: 1, backgroundColor: scrims.light.mask },
})
