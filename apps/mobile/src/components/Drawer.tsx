import type { ReactNode } from 'react'
import { useEffect } from 'react'
import { Pressable, StyleSheet, View, useWindowDimensions } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, { interpolate, runOnJS, useAnimatedStyle, useReducedMotion, useSharedValue, withSpring } from 'react-native-reanimated'

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
}

/**
 * The house menu, the way a phone chat app keeps one: behind the page, revealed by
 * sliding the page aside. The page keeps its own header and its own scroll; this
 * only moves it, scales it a touch so it reads as lifted, and takes it back on a
 * tap or a swipe. Owned here rather than by a drawer navigator so each top-level
 * room can keep its own list state while sharing the same house menu gesture.
 */
export function Drawer({ open, onOpenChange, menu, children }: DrawerProps) {
  const { width } = useWindowDimensions()
  const travel = Math.round(width * OPEN_FRACTION)
  const still = useReducedMotion()
  const progress = useSharedValue(open ? 1 : 0)
  const dragStart = useSharedValue(0)

  // `.get()`/`.set()` rather than `.value`: the compiler treats a shared value as
  // frozen state, and these are the accessors Reanimated offers for exactly that.
  useEffect(() => {
    progress.set(still ? (open ? 1 : 0) : withSpring(open ? 1 : 0, SPRING))
  }, [open, progress, still])

  const settle = (to: boolean) => {
    'worklet'
    progress.set(still ? (to ? 1 : 0) : withSpring(to ? 1 : 0, SPRING))
    runOnJS(onOpenChange)(to)
  }

  // Closed: only a swipe that starts in the edge strip is ours, so the inbox rows
  // keep their own swipe. Open: a swipe anywhere on the page closes. Both follow
  // the finger and settle on release by where it left.
  const pan = Gesture.Pan()
    .hitSlop(open ? { left: 0, right: 0, top: 0, bottom: 0 } : { left: 0, width: EDGE })
    .activeOffsetX([-12, 12])
    .failOffsetY([-16, 16])
    .onBegin(() => {
      dragStart.set(progress.get())
    })
    .onUpdate((event) => {
      progress.set(Math.min(1, Math.max(0, dragStart.get() + event.translationX / travel)))
    })
    .onEnd((event) => {
      const flung = Math.abs(event.velocityX) > 500
      settle(flung ? event.velocityX > 0 : progress.get() > 0.5)
    })

  const page = useAnimatedStyle(() => ({
    transform: [
      { translateX: progress.get() * travel },
      { scale: interpolate(progress.get(), [0, 1], [1, 0.94]) },
    ],
    borderRadius: interpolate(progress.get(), [0, 1], [0, 32]),
    ...squircle,
  }))
  const scrim = useAnimatedStyle(() => ({
    opacity: progress.get(),
  }))
  const panel = useAnimatedStyle(() => ({
    opacity: interpolate(progress.get(), [0, 0.4, 1], [0, 0.8, 1]),
    transform: [{ translateX: interpolate(progress.get(), [0, 1], [-travel * 0.3, 0]) }],
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
