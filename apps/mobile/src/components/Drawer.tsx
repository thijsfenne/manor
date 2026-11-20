import type { ReactNode } from 'react'
import { useEffect } from 'react'
import { Pressable, StyleSheet, View, useWindowDimensions } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, { Extrapolation, interpolate, runOnJS, useAnimatedStyle, useReducedMotion, useSharedValue, withSpring } from 'react-native-reanimated'

import { rubberBand } from '@/lib/rubberBand'
import { colors, squircle } from '@/theme'

/** How far the page slides, and how wide the menu behind it is. */
const OPEN_FRACTION = 0.82
/** The strip along the left edge a swipe can open the menu from. */
const EDGE = 28
const SPRING = { damping: 26, stiffness: 240, mass: 0.8 }

interface DrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  menu: ReactNode
  children: ReactNode
  /** Whether a swipe from the left edge opens it; a closing swipe always works. */
  swipeEnabled?: boolean
}

/**
 * The house menu, the way a phone chat app keeps one: behind the page, revealed by
 * sliding the page aside. The page keeps its own header and its own scroll; this
 * only moves it sideways and takes it back on a tap or a swipe. It wraps the native
 * tab bar, so the bar slides with the page.
 *
 * The page never scales. A tab's stack measures its safe area natively inside the
 * page, and a tab first opened from the menu measures while the page is still
 * aside; a scaled page moves its top and bottom edges, so that stack would keep a
 * short top inset and its header would sit under the status bar.
 */
export function Drawer({ open, onOpenChange, menu, children, swipeEnabled = true }: DrawerProps) {
  const { width } = useWindowDimensions()
  const travel = Math.round(width * OPEN_FRACTION)
  const still = useReducedMotion()
  const progress = useSharedValue(open ? 1 : 0)
  // Where the page is heading, so a swipe's own settle is not restarted without its
  // speed when the `open` it reports comes back.
  const heading = useSharedValue(open ? 1 : 0)
  const dragStart = useSharedValue(0)

  // `.get()`/`.set()` rather than `.value`: the compiler treats a shared value as
  // frozen state, and these are the accessors Reanimated offers for exactly that.
  useEffect(() => {
    const to = open ? 1 : 0
    if (heading.get() === to) return
    heading.set(to)
    progress.set(still ? to : withSpring(to, SPRING))
  }, [open, heading, progress, still])

  /**
   * `velocity` is the release speed in progress per second, so the spring carries the
   * fling on. A fast open may swing a little past open; closed stays a hard edge.
   */
  const settle = (to: boolean, velocity: number) => {
    'worklet'
    heading.set(to ? 1 : 0)
    progress.set(still ? (to ? 1 : 0) : withSpring(to ? 1 : 0, { ...SPRING, velocity, overshootClamping: !to }))
    runOnJS(onOpenChange)(to)
  }

  // Closed: only a swipe that starts in the edge strip is ours, so the inbox rows
  // keep their own swipe. Open: a swipe anywhere on the page closes. Both follow
  // the finger, give a little past open but stop at closed, and settle on release by
  // where it left.
  const pan = Gesture.Pan()
    .enabled(open || swipeEnabled)
    .hitSlop(open ? { left: 0, right: 0, top: 0, bottom: 0 } : { left: 0, width: EDGE })
    .activeOffsetX([-12, 12])
    .failOffsetY([-16, 16])
    .onBegin(() => {
      dragStart.set(progress.get())
    })
    .onUpdate((event) => {
      // Grabbed mid-swing past open, it resists only beyond that point.
      progress.set(Math.max(0, rubberBand(dragStart.get() + event.translationX / travel, 0, Math.max(1, dragStart.get()), 0.2)))
    })
    .onEnd((event, success) => {
      // A swipe the system cancelled goes back where it was heading and changes nothing.
      if (!success) {
        settle(heading.get() === 1, 0)
        return
      }
      const flung = Math.abs(event.velocityX) > 500
      settle(flung ? event.velocityX > 0 : progress.get() > 0.5, event.velocityX / travel)
    })

  const page = useAnimatedStyle(() => ({
    transform: [{ translateX: progress.get() * travel }],
    borderRadius: interpolate(progress.get(), [0, 1], [0, 32], Extrapolation.CLAMP),
    ...squircle,
  }))
  const scrim = useAnimatedStyle(() => ({
    opacity: progress.get(),
  }))
  const panel = useAnimatedStyle(() => ({
    opacity: interpolate(progress.get(), [0, 0.4, 1], [0, 0.8, 1]),
    transform: [{ translateX: interpolate(progress.get(), [0, 1], [-travel * 0.3, 0], Extrapolation.CLAMP) }],
  }))

  return (
    <View style={styles.host}>
      <Animated.View pointerEvents={open ? 'auto' : 'none'} style={[styles.panel, { width: travel }, panel]}>
        {menu}
      </Animated.View>
      <GestureDetector gesture={pan}>
        <Animated.View style={[styles.page, page]}>
          {children}
          <Animated.View pointerEvents={open ? 'auto' : 'none'} style={[StyleSheet.absoluteFill, styles.scrim, scrim]}>
            <Pressable accessibilityLabel="Close menu" onPress={() => onOpenChange(false)} style={styles.fill} />
          </Animated.View>
        </Animated.View>
      </GestureDetector>
    </View>
  )
}

const styles = StyleSheet.create({
  host: { flex: 1, backgroundColor: colors.background },
  panel: { position: 'absolute', top: 0, bottom: 0, left: 0 },
  page: { flex: 1, overflow: 'hidden', backgroundColor: colors.background },
  scrim: { backgroundColor: colors.scrim },
  fill: { flex: 1 },
})
