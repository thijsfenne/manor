import { useFocusEffect, useNavigation } from 'expo-router'
import type { ReactNode } from 'react'
import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { BackHandler, Keyboard, StyleSheet, View, useWindowDimensions } from 'react-native'
import { Gesture, GestureDetector, type GestureType } from 'react-native-gesture-handler'
import Animated, { runOnJS, useAnimatedStyle, useReducedMotion, useSharedValue, withSpring, withTiming } from 'react-native-reanimated'

import { pagerSettle } from '@/lib/pagerSettle'
import { rubberBand } from '@/lib/rubberBand'
import { colors } from '@/theme'

const SPRING = { damping: 26, stiffness: 240, mass: 0.8 }
/** Sideways travel before a swipe is the pager's; the vertical give before it is a scroll instead. */
const ACTIVE_X = 14
const FAIL_Y = 12

/**
 * The thread page's swipe. A native sideways scroller in the thread (a code block or a
 * table wider than its column) holds it back, so a sideways swipe on it scrolls it and
 * one anywhere else turns the page.
 */
export const PagerSwipe = createContext<GestureType | undefined>(undefined)

interface ThreadPagerProps {
  /** Whether the second page is there at all; off, the thread sits as it always did. */
  enabled: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The page to the right of the thread. Mounted only while it shows or is on its way. */
  page: ReactNode
  /** The thread. Its transcript wraps itself in `ThreadSwipeArea` to take the swipe. */
  children: ReactNode
}

/**
 * A project thread with its Sessions overview beside it, the way the Mac keeps the
 * overview right of the thread. A swipe to the left on the transcript pulls the overview
 * in as the next page, a swipe to the right on the overview puts it back. Both pages slide
 * and never scale, and the thread underneath stays mounted, so it comes back at the
 * scroll position it was left at.
 *
 * Only the transcript takes the swipe: the composer keeps its own text gestures, and a
 * message keeps its swipe to the right for reply.
 */
export function ThreadPager({ enabled, open, onOpenChange, page, children }: ThreadPagerProps) {
  const { width } = useWindowDimensions()
  const still = useReducedMotion()
  const navigation = useNavigation()
  const showing = enabled && open
  const progress = useSharedValue(showing ? 1 : 0)
  // Where the pager is heading, so a swipe's own settle is not restarted without its
  // speed when the `open` it reports comes back.
  const heading = useSharedValue<0 | 1>(showing ? 1 : 0)
  const dragStart = useSharedValue(0)
  // Mounted the moment it opens, and unmounted only once it has slid away again.
  const [mounted, setMounted] = useState(showing)
  if (showing && !mounted) setMounted(true)

  // The stack's own back swipe would leave the thread, so it is off while the overview
  // shows; a swipe to the right there goes back to the thread instead.
  useEffect(() => {
    navigation.setOptions({ gestureEnabled: !showing })
  }, [showing, navigation])

  // The keys belong to the thread's composer, which slides away with the thread, and
  // Android's back closes the overview before it leaves the thread. On focus only: a
  // Session opened from the overview stands on top and takes its own back.
  useFocusEffect(useCallback(() => {
    if (!showing) return
    Keyboard.dismiss()
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onOpenChange(false)
      return true
    })
    return () => sub.remove()
  }, [showing, onOpenChange]))

  /**
   * Moves the pages to `to` (1 is the overview). `velocity` is a release speed in progress
   * per second, so a swipe's spring carries the fling on; the overview unmounts once it
   * has slid away, unless the pages turned again meanwhile. `.get()`/`.set()` rather than
   * `.value`: the compiler treats a shared value as frozen state, and these are the
   * accessors Reanimated offers for exactly that.
   */
  const animateTo = useCallback((to: 0 | 1, velocity: number) => {
    'worklet'
    heading.set(to)
    const settled = (finished?: boolean) => {
      'worklet'
      if (finished === true && heading.get() === 0) runOnJS(setMounted)(false)
    }
    progress.set(still ? withTiming(to, { duration: 0 }, settled) : withSpring(to, { ...SPRING, velocity }, settled))
  }, [heading, progress, still])

  // The header's Sessions button and Back move the pages without a swipe.
  useEffect(() => {
    const to = showing ? 1 : 0
    if (heading.get() !== to) animateTo(to, 0)
  }, [showing, heading, animateTo])

  /**
   * One pan per page, the same in both: it follows the finger 1:1, gives a fifth of the
   * distance past either page, and on release settles by `pagerSettle` with the spring
   * carrying the fling's speed. A swipe the system cancelled never turns the page.
   */
  const pan = (from: 0 | 1) => Gesture.Pan()
    .enabled(enabled)
    .activeOffsetX(from === 0 ? -ACTIVE_X : ACTIVE_X)
    .failOffsetX(from === 0 ? ACTIVE_X : -ACTIVE_X)
    .failOffsetY([-FAIL_Y, FAIL_Y])
    .onBegin(() => {
      dragStart.set(progress.get())
    })
    .onStart(() => {
      runOnJS(setMounted)(true)
    })
    .onUpdate((event) => {
      progress.set(rubberBand(dragStart.get() - event.translationX / width, 0, 1, 0.2))
    })
    .onEnd((event, success) => {
      const to = pagerSettle(progress.get(), event.velocityX, !success, heading.get())
      // Reported before the move: a move with no distance to go completes at once, and its
      // unmount must not land while `open` still says the overview shows. `heading` first,
      // so the `open` effect sees this swipe's move as already under way.
      heading.set(to)
      runOnJS(onOpenChange)(to === 1)
      animateTo(to, -event.velocityX / width)
    })
  const threadPan = pan(0)
  const pagePan = pan(1)

  const threadStyle = useAnimatedStyle(() => ({ transform: [{ translateX: -progress.get() * width }] }))
  const pageStyle = useAnimatedStyle(() => ({ transform: [{ translateX: (1 - progress.get()) * width }] }))

  return (
    <View style={styles.host}>
      <Animated.View
        accessibilityElementsHidden={showing}
        importantForAccessibility={showing ? 'no-hide-descendants' : 'auto'}
        style={[styles.fill, threadStyle]}
      >
        <PagerSwipe.Provider value={threadPan}>{children}</PagerSwipe.Provider>
      </Animated.View>
      {enabled && mounted ? (
        <GestureDetector gesture={pagePan}>
          <Animated.View
            accessibilityElementsHidden={!showing}
            importantForAccessibility={showing ? 'auto' : 'no-hide-descendants'}
            pointerEvents={showing ? 'auto' : 'none'}
            style={[StyleSheet.absoluteFill, styles.page, pageStyle]}
          >
            {page}
          </Animated.View>
        </GestureDetector>
      ) : null}
    </View>
  )
}

/** The part of the thread a sideways swipe turns the page from: the transcript. */
export function ThreadSwipeArea({ children }: { children: ReactNode }) {
  const pan = useContext(PagerSwipe)
  if (pan === undefined) return <View style={styles.fill}>{children}</View>
  return (
    <GestureDetector gesture={pan}>
      <View collapsable={false} style={styles.fill}>{children}</View>
    </GestureDetector>
  )
}

const styles = StyleSheet.create({
  host: { flex: 1, overflow: 'hidden', backgroundColor: colors.background },
  fill: { flex: 1 },
  page: { backgroundColor: colors.background },
})
