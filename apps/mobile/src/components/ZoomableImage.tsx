import { Image } from 'expo-image'
import { useEffect, useState, type ReactNode } from 'react'
import { StyleSheet, View } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, { runOnJS, useAnimatedStyle, useReducedMotion, useSharedValue, withDecay, withSpring } from 'react-native-reanimated'

import { rubberBand } from '@/lib/rubberBand'
import { clamp, clampPan, DOUBLE_TAP_ZOOM, fittedSize, MAX_ZOOM, MIN_PINCH, panLimit, zoomAround } from '@/lib/zoom'

const SPRING = { damping: 28, stiffness: 300, mass: 0.8 }

/**
 * Which page of a viewer is zoomed. Paging and swipe-to-dismiss wait while the page in
 * view is. A page that leaves view, or a rotation, starts the picture over at fit, so
 * the hold is dropped at the same moment.
 */
export function usePageZoom(page: string, width: number) {
  const [held, setHeld] = useState<string | null>(null)
  const [shown, setShown] = useState({ page, width })
  if (shown.page !== page || shown.width !== width) {
    setShown({ page, width })
    setHeld(null)
  }
  const report = (at: string, isZoomed: boolean) => {
    setHeld((current) => (isZoomed ? at : current === at ? null : current))
  }
  return { locked: held === page, report }
}

/**
 * One full-screen picture that zooms: pinch between fit and 5x around the fingers,
 * drag while zoomed, double-tap between fit and 2x. Past 5x and past the picture's
 * edges it gives a little under the fingers. Letting go at or under fit springs back to
 * fit, past 5x back to 5x. `onZoomedChange` reports when the picture leaves fit and when it is back,
 * for `usePageZoom`. A new frame size, such as a rotation, or the page leaving view
 * starts the picture over at fit. `children` draws over it, such as a loading spinner.
 */
export function ZoomableImage({ uri, name, page, active, width, height, onZoomedChange, onLoad, onError, children }: {
  uri: string
  name: string
  page: string
  active: boolean
  width: number
  height: number
  onZoomedChange: (page: string, zoomed: boolean) => void
  onLoad: () => void
  onError: () => void
  children?: ReactNode
}) {
  const still = useReducedMotion()
  // The picture's width:height once loaded, so a drag stops at its edges instead of the frame's.
  const [aspect, setAspect] = useState<number | null>(null)
  const scale = useSharedValue(1)
  const x = useSharedValue(0)
  const y = useSharedValue(0)
  const start = useSharedValue({ scale: 1, x: 0, y: 0, focalX: 0, focalY: 0 })
  // The fingers' point on the pinch's last move; its end event may count only the finger still down.
  const focal = useSharedValue({ x: 0, y: 0 })
  const fitted = fittedSize(width, height, aspect)

  useEffect(() => {
    scale.set(1)
    x.set(0)
    y.set(0)
  }, [active, width, height, scale, x, y])

  const move = (value: number) => {
    'worklet'
    return still ? value : withSpring(value, SPRING)
  }
  const toFit = () => {
    'worklet'
    scale.set(move(1))
    x.set(move(0))
    y.set(move(0))
    runOnJS(onZoomedChange)(page, false)
  }
  // Past the most zoom it comes back to MAX_ZOOM around the fingers' last point.
  const settle = () => {
    'worklet'
    const current = scale.get()
    if (current <= 1) {
      toFit()
      return
    }
    const to = Math.min(current, MAX_ZOOM)
    const { x: focalX, y: focalY } = focal.get()
    if (to !== current) scale.set(move(to))
    x.set(move(clampPan(zoomAround(focalX, focalX, x.get(), current, to), width, fitted.width, to)))
    y.set(move(clampPan(zoomAround(focalY, focalY, y.get(), current, to), height, fitted.height, to)))
  }
  // Let go past an edge, an axis springs back to it; inside, a fling glides to a stop at the edges.
  const release = (offset: number, velocity: number, limit: number) => {
    'worklet'
    const inside = clamp(offset, -limit, limit)
    if (still) return inside
    return inside === offset ? withDecay({ velocity, clamp: [-limit, limit] }) : withSpring(inside, { ...SPRING, velocity, overshootClamping: true })
  }

  const pinch = Gesture.Pinch()
    .onStart((event) => {
      start.set({ scale: scale.get(), x: x.get(), y: y.get(), focalX: event.focalX - width / 2, focalY: event.focalY - height / 2 })
      runOnJS(onZoomedChange)(page, true)
    })
    .onUpdate((event) => {
      const from = start.get()
      // Scale is a ratio, so the give past MAX_ZOOM is too: a pinch twice too wide shows 1.15x past it.
      const next = Math.exp(rubberBand(Math.log(Math.max(MIN_PINCH, from.scale * event.scale)), Math.log(MIN_PINCH), Math.log(Math.max(MAX_ZOOM, from.scale)), 0.2))
      const at = { x: event.focalX - width / 2, y: event.focalY - height / 2 }
      focal.set(at)
      scale.set(next)
      x.set(zoomAround(at.x, from.focalX, from.x, from.scale, next))
      y.set(zoomAround(at.y, from.focalY, from.y, from.scale, next))
    })
    .onEnd(settle)

  // At fit the drag is never claimed, so the pager and swipe-to-dismiss keep their gestures.
  const pan = Gesture.Pan()
    .maxPointers(1)
    .manualActivation(true)
    .onTouchesMove((_event, manager) => {
      if (scale.get() > 1) manager.activate()
      else manager.fail()
    })
    .onStart(() => {
      start.set({ ...start.get(), x: x.get(), y: y.get() })
    })
    .onUpdate((event) => {
      const from = start.get()
      const limitX = panLimit(width, fitted.width, scale.get())
      const limitY = panLimit(height, fitted.height, scale.get())
      // Grabbed while still out past an edge on its way back, it resists only beyond that point.
      x.set(rubberBand(from.x + event.translationX, Math.min(-limitX, from.x), Math.max(limitX, from.x), 0.3))
      y.set(rubberBand(from.y + event.translationY, Math.min(-limitY, from.y), Math.max(limitY, from.y), 0.3))
    })
    .onEnd((event) => {
      // The edges of the zoom it settles at, when a pinch past MAX_ZOOM is still springing back.
      const to = Math.min(scale.get(), MAX_ZOOM)
      x.set(release(x.get(), event.velocityX, panLimit(width, fitted.width, to)))
      y.set(release(y.get(), event.velocityY, panLimit(height, fitted.height, to)))
    })

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd((event, success) => {
      if (!success) return
      if (scale.get() > 1) {
        toFit()
        return
      }
      // Zoom in on the tapped point, as far as the picture's edges allow.
      scale.set(move(DOUBLE_TAP_ZOOM))
      x.set(move(clampPan(zoomAround(event.x - width / 2, event.x - width / 2, 0, 1, DOUBLE_TAP_ZOOM), width, fitted.width, DOUBLE_TAP_ZOOM)))
      y.set(move(clampPan(zoomAround(event.y - height / 2, event.y - height / 2, 0, 1, DOUBLE_TAP_ZOOM), height, fitted.height, DOUBLE_TAP_ZOOM)))
      runOnJS(onZoomedChange)(page, true)
    })

  const zoomed = useAnimatedStyle(() => ({
    transform: [{ translateX: x.get() }, { translateY: y.get() }, { scale: scale.get() }],
  }))

  return (
    <GestureDetector gesture={Gesture.Simultaneous(pinch, pan, doubleTap)}>
      <View collapsable={false} style={[styles.frame, { width, height }]}>
        <Animated.View style={[styles.content, zoomed]}>
          <Image
            accessibilityIgnoresInvertColors
            accessibilityLabel={name}
            contentFit="contain"
            onError={onError}
            onLoad={(event) => {
              setAspect(event.source.width / event.source.height)
              onLoad()
            }}
            source={{ uri }}
            style={StyleSheet.absoluteFill}
          />
          {children}
        </Animated.View>
      </View>
    </GestureDetector>
  )
}

const styles = StyleSheet.create({
  frame: { overflow: 'hidden' },
  content: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
})
