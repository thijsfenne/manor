import { createContext, useContext, useEffect, useRef } from 'react'
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'
import Animated, { Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withDelay, withSequence, withTiming } from 'react-native-reanimated'

import { colors } from '@/theme'

/**
 * The message a jump in the chat just landed on: a message picked in Search, Show source
 * on a quote, Show in chat from Files. `id` is new per jump, so landing on the same
 * message twice washes it twice. `onLanded` hears where the message sits once the list
 * has settled, so the chat can bring a message deep in a tall turn into view.
 */
export interface LandedMessage {
  eventId: string
  id: number
  onLanded: (view: View) => void
}

export const LandedMessageContext = createContext<LandedMessage | null>(null)

/** The wash runs this long, the same 1.5s the Mac washes a landed message for. */
export const LANDING_WASH_MS = 1500
/** How long the list gets to finish its jump before the message reports where it sits. */
const SETTLE_MS = 120

/**
 * Washes a message when a jump lands on it, and draws nothing otherwise. Place it first
 * inside the message's own box, so the words draw over it.
 */
export function LandingWash({ eventId, style }: { eventId: string; style?: StyleProp<ViewStyle> }) {
  const landed = useContext(LandedMessageContext)
  if (landed === null || landed.eventId !== eventId) return null
  return <Wash key={landed.id} onLanded={landed.onLanded} style={style} />
}

function Wash({ onLanded, style }: { onLanded: (view: View) => void; style?: StyleProp<ViewStyle> }) {
  const ref = useRef<View>(null)
  const opacity = useSharedValue(0)
  const reduceMotion = useReducedMotion()
  useEffect(() => {
    // In and out at the Mac's 15% and 65% marks. With reduced motion it stands still
    // until the chat lets the landing go, LANDING_WASH_MS later.
    opacity.set(reduceMotion ? 1 : withSequence(
      withTiming(1, { duration: LANDING_WASH_MS * 0.15, easing: Easing.out(Easing.quad) }),
      withDelay(LANDING_WASH_MS * 0.5, withTiming(0, { duration: LANDING_WASH_MS * 0.35, easing: Easing.in(Easing.quad) })),
    ))
    const timer = setTimeout(() => {
      if (ref.current !== null) onLanded(ref.current)
    }, SETTLE_MS)
    return () => clearTimeout(timer)
  }, [onLanded, opacity, reduceMotion])
  const wash = useAnimatedStyle(() => ({ opacity: opacity.get() }))
  // The outer view places, rounds and measures; the inner one fades.
  return (
    <View pointerEvents="none" ref={ref} style={[styles.place, style]}>
      <Animated.View style={[styles.wash, wash]} />
    </View>
  )
}

const styles = StyleSheet.create({
  place: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, overflow: 'hidden' },
  wash: { flex: 1, backgroundColor: colors.find },
})
