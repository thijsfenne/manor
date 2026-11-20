import type { BubbleTint } from '@manor/client-runtime/avatar-bubble'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { StyleSheet } from 'react-native'
import Animated, {
  Extrapolation,
  interpolate,
  ReduceMotion,
  runOnUI,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated'

import { Text } from '@/components/Text'
import { ARRIVAL_SPRING, type Arrival } from '@/lib/arrival'
import { fonts, radius, squircle } from '@/theme'

/** How long after an arrival the list's own scroll to the end is taken as that arrival's. */
const ARM_MS = 400
/** A sent row that lands without a scroll (a short chat) flies from where it is this long after it renders. */
const FLIGHT_FALLBACK_MS = 120
/** The bubble grows back to full size once it nears its slot. */
const GROW_DELAY_MS = 200
const FLIGHT_SCALE = 0.8
const FIELD_HOLD_MS = 650
const FLIGHT_END_MS = 900
/** Every arrival's motion is over by now. */
export const ARRIVAL_SPENT_MS = 1_000
/** A reply is laid out at once and fades in over the last part of the slide. */
const FADE_DELAY_MS = 160
const FADE_MS = 130
/** Reduce Motion: nothing travels, new rows fade in where they land. */
const STILL_FADE_MS = 150
/** A sent row never stays hidden longer than this, whatever became of its flight. */
const SEND_SAFETY_MS = 450

const FLIGHT_IDLE = 0
const FLIGHT_WAITING = 1
const FLIGHT_FLYING = 2

/**
 * The DM transcript's arrival motion, after the phone's own messaging app. The list keeps
 * landing at its end in one frame as before; while an arrival is armed, every jump of its
 * scroll offset is added to `slide`, a translation every row carries, and `slide` springs
 * back to zero, so the chat rises instead of jumping. The scroll and the counter-shift
 * meet in the same frame, because both run on the UI thread off the scroll event.
 * The working face sits in the list's footer and is not shifted: it stays where it is
 * while a reply slots in above it, and appears at its own place while the rows make room.
 */
export interface ArrivalMotion {
  scrollOffset: SharedValue<number>
  slide: SharedValue<number>
  armedUntil: SharedValue<number>
  flight: {
    key: SharedValue<string>
    state: SharedValue<number>
    /** Counts sends, so a timer left by an earlier one cannot end a later flight. */
    serial: SharedValue<number>
    /** 1 at the composer field, 0 in the row's slot. */
    progress: SharedValue<number>
    /** Where the field sits against the row's slot, measured on send. */
    dx: SharedValue<number>
    dy: SharedValue<number>
    /** The part of `dy` the row still travels itself once the slide carries the rest. */
    startDy: SharedValue<number>
    shrink: SharedValue<number>
    grow: SharedValue<number>
  }
}

export interface FieldFlight {
  id: number
  text: string
  /** The composer field, in the chat screen's coordinates. */
  field: { x: number; y: number; width: number; height: number }
}

/** `rowKey` limits the start to the flight of that row, for a timer an earlier send left. */
function startFlight(motion: ArrivalMotion, rowKey?: string) {
  'worklet'
  const { flight, slide } = motion
  if (flight.state.get() !== FLIGHT_WAITING || (rowKey !== undefined && flight.key.get() !== rowKey)) return
  flight.state.set(FLIGHT_FLYING)
  flight.startDy.set(flight.dy.get() - slide.get())
  flight.progress.set(1)
  flight.progress.set(withSpring(0, ARRIVAL_SPRING))
  flight.shrink.set(withSpring(FLIGHT_SCALE, ARRIVAL_SPRING))
  flight.grow.set(withDelay(GROW_DELAY_MS, withSpring(1 / FLIGHT_SCALE, ARRIVAL_SPRING)))
}

export function useArrivalMotion() {
  const scrollOffset = useSharedValue(0)
  const slide = useSharedValue(0)
  const armedUntil = useSharedValue(0)
  const key = useSharedValue('')
  const state = useSharedValue(FLIGHT_IDLE)
  const serial = useSharedValue(0)
  const progress = useSharedValue(0)
  const dx = useSharedValue(0)
  const dy = useSharedValue(0)
  const startDy = useSharedValue(0)
  const shrink = useSharedValue(1)
  const grow = useSharedValue(1)
  const motion = useMemo<ArrivalMotion>(
    () => ({ scrollOffset, slide, armedUntil, flight: { key, state, serial, progress, dx, dy, startDy, shrink, grow } }),
    [scrollOffset, slide, armedUntil, key, state, serial, progress, dx, dy, startDy, shrink, grow],
  )

  useAnimatedReaction(() => scrollOffset.get(), (offset, previous) => {
    if (previous === null || offset === previous || Date.now() > armedUntil.get()) return
    slide.set(slide.get() + offset - previous)
    slide.set(withSpring(0, ARRIVAL_SPRING))
    // Only the scroll that brings the sent row starts its flight, not one the face caused first.
    if (offset > previous && motion.flight.key.get() !== '') startFlight(motion)
  })

  return motion
}

/** Takes the list's next jumps to its end as an arrival's. */
export function armArrival(motion: ArrivalMotion) {
  motion.armedUntil.set(Date.now() + ARM_MS)
}

/** A drag is his own scroll, never an arrival's. */
export function disarmArrival(motion: ArrivalMotion) {
  motion.armedUntil.set(0)
}

/**
 * Readies the flight of a message about to be sent from the field. `dx` and `dy` are the
 * field's bottom right corner against the slot where the row's bottom right will rest.
 * Returns the flight's serial, which rises with every send.
 */
export function requestFlight(motion: ArrivalMotion, dx: number, dy: number) {
  const { flight } = motion
  const serial = flight.serial.get() + 1
  flight.serial.set(serial)
  flight.key.set('')
  flight.dx.set(dx)
  flight.dy.set(dy)
  flight.shrink.set(1)
  flight.grow.set(1)
  flight.state.set(FLIGHT_WAITING)
  armArrival(motion)
  setTimeout(() => {
    if (flight.serial.get() !== serial) return
    flight.state.set(FLIGHT_IDLE)
    flight.key.set('')
  }, FLIGHT_END_MS)
  return serial
}

/** Marks the row that holds the message in flight, once it renders. */
export function claimFlight(motion: ArrivalMotion, rowKey: string) {
  motion.flight.key.set(rowKey)
  setTimeout(() => runOnUI(startFlight)(motion, rowKey), FLIGHT_FALLBACK_MS)
}

/** How long the field's blue copy stays mounted after a send. */
export const FIELD_FLIGHT_MS = FIELD_HOLD_MS

/**
 * One transcript row in a DM. It carries the chat's slide, and when it arrived it fades
 * in (`fade`) or comes up from the field (`send`). The arrival is read once, on mount:
 * a row that scrolls out and back later just appears.
 */
export function ArrivalRow({ motion, rowKey, arrival, still, children }: {
  motion: ArrivalMotion
  rowKey: string
  arrival: Arrival | undefined
  still: boolean
  children: ReactNode
}) {
  const [arrived] = useState(arrival)
  const appear = useSharedValue(arrived === undefined ? 1 : 0)
  useEffect(() => {
    if (arrived === undefined) return undefined
    if (arrived === 'fade' || still) {
      // Opacity only, so it stays under Reduce Motion, which asks for this fade instead of travel.
      appear.set(withDelay(still ? 0 : FADE_DELAY_MS, withTiming(1, { duration: still ? STILL_FADE_MS : FADE_MS, reduceMotion: ReduceMotion.Never })))
      return undefined
    }
    const timer = setTimeout(() => appear.set(withTiming(1, { duration: STILL_FADE_MS })), SEND_SAFETY_MS)
    return () => clearTimeout(timer)
  }, [appear, arrived, still])
  // Shown in the frame its flight starts, from the field's place behind the composer.
  useAnimatedReaction(
    () => motion.flight.key.get() === rowKey && motion.flight.state.get() === FLIGHT_FLYING,
    (flying, was) => {
      if (flying && was !== true) appear.set(1)
    },
  )
  const style = useAnimatedStyle(() => {
    const { flight } = motion
    const flying = flight.key.get() === rowKey && flight.state.get() === FLIGHT_FLYING
    const progress = flying ? flight.progress.get() : 0
    return {
      opacity: appear.get(),
      transform: [
        { translateX: flight.dx.get() * progress },
        { translateY: motion.slide.get() + flight.startDy.get() * progress },
        { scale: flying ? flight.shrink.get() * flight.grow.get() : 1 },
      ],
    }
  })
  return <Animated.View style={[styles.row, style]}>{children}</Animated.View>
}

/**
 * The composer field filled with the bubble's colour, drawn above the composer and any
 * dock over it: it holds the sent words while the field clears behind it, then rides the
 * bubble's own path with its bottom right corner on the bubble's, narrowing to the right,
 * and fades once the bubble has risen clear of the footer it travels behind.
 */
export function SendFlightField({ motion, flight, tint }: { motion: ArrivalMotion; flight: FieldFlight; tint: BubbleTint }) {
  const style = useAnimatedStyle(() => {
    const { state, progress, dx, dy, startDy } = motion.flight
    if (state.get() !== FLIGHT_FLYING) return { opacity: 1, transform: [{ translateX: 0 }, { translateY: 0 }, { scaleX: 1 }] }
    const at = progress.get()
    return {
      opacity: interpolate(at, [0.12, 0.3], [0, 1], Extrapolation.CLAMP),
      transform: [
        { translateX: dx.get() * (at - 1) },
        { translateY: motion.slide.get() + startDy.get() * at - dy.get() },
        { scaleX: interpolate(at, [0, 1], [FLIGHT_SCALE, 1], Extrapolation.CLAMP) },
      ],
    }
  })
  const { field } = flight
  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.field, { left: field.x, top: field.y, width: field.width, height: field.height, backgroundColor: tint.fill }, style]}
    >
      <Text numberOfLines={6} style={[styles.fieldText, { color: tint.ink }]}>{flight.text}</Text>
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  row: { transformOrigin: 'right bottom' },
  field: { position: 'absolute', zIndex: 3, overflow: 'hidden', borderRadius: radius.composer, ...squircle, transformOrigin: 'right center', paddingHorizontal: 10, paddingTop: 7 },
  fieldText: { fontFamily: fonts.sans, fontSize: 17, lineHeight: 23 },
})
