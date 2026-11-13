import type { AgentConfig } from '@manor/contracts'
import { personaOf, type Persona } from '@manor/client-runtime/state'
import { turnFace } from '@manor/client-runtime/face-activity'
import { dmWorkingLabel, type DmWorking } from '@manor/client-runtime/turn-trace'
import { useEffect, useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import Animated, { Easing, Keyframe, LayoutAnimationConfig, ReduceMotion } from 'react-native-reanimated'

import { Blobatar } from '@/components/Blobatar'
import { useFaceState } from '@/lib/useFaceState'
import { ShimmerText } from '@/components/ShimmerText'
import { colors, fonts, spacing } from '@/theme'

/** A label stays at least this long, so a run of quick calls cannot make it flicker. */
const LABEL_HOLD_MS = 2_500

/** The Mac's text swap: 150ms, eased both ways, four points of travel. */
const SWAP_MS = 150
const swapEase = Easing.inOut(Easing.ease)
const arrive = new Keyframe({
  0: { opacity: 0, transform: [{ translateY: 4 }] },
  100: { opacity: 1, transform: [{ translateY: 0 }], easing: swapEase },
}).duration(SWAP_MS).reduceMotion(ReduceMotion.System)
const leave = new Keyframe({
  0: { opacity: 1, transform: [{ translateY: 0 }] },
  100: { opacity: 0, transform: [{ translateY: -4 }], easing: swapEase },
}).duration(SWAP_MS).reduceMotion(ReduceMotion.System)

/**
 * A DM's one sign of life, as on the Mac: her face and a shimmering label at the foot
 * of the chat, under the last message, from the send until her reply is whole.
 * Finished bubbles carry no face; this is the only place it appears. It leaves the
 * moment the reply lands, is stopped or breaks off, without a word about why.
 * A project thread speaks as the project and has no face: on the phone (`bare`) it is
 * this same indicator with the label alone.
 */
export function DmWorkingIndicator({ working, persona, agents, bare = false }: {
  working: DmWorking
  persona: Persona
  agents: AgentConfig[]
  bare?: boolean
}) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [])
  const label = working.kind === 'consult'
    ? `Waiting for ${personaOf(agents, working.peerAgentId).name}…`
    : dmWorkingLabel(working.kind === 'turn' ? working.turn : undefined, now)
  const shown = useHeldLabel(label)
  // The face says what the words say: waiting on a colleague, thinking before a turn has
  // drawn anything, and otherwise whatever her turn is doing.
  const face = useFaceState(working.kind === 'consult' ? 'waiting' : working.kind === 'turn' ? turnFace(working.turn) : 'thinking', undefined, true)
  return (
    <Animated.View
      accessibilityLabel={bare ? shown : `${persona.name}: ${shown}`}
      accessible
      entering={arrive}
      style={styles.indicator}
    >
      {bare ? null : (
        <View style={styles.face}>
          <Blobatar
            animate
            busy
            face={face}
            color={persona.color}
            name={persona.name}
            shape={persona.avatarShape}
            size={32}
            src={persona.avatar}
            tone={persona.avatarTone}
          />
        </View>
      )}
      {/* Keyed by the words, so a new phase swaps in place. The first words arrive with the
          row itself, as on the Mac: their own entering would lift the label twice as far as the face. */}
      <View style={styles.label}>
        <LayoutAnimationConfig skipEntering>
          <Animated.View entering={arrive} exiting={leave} key={shown}>
            <ShimmerText style={styles.text} text={shown} />
          </Animated.View>
        </LayoutAnimationConfig>
      </View>
    </Animated.View>
  )
}

/** The newest label, but never sooner than `LABEL_HOLD_MS` after the last change. */
function useHeldLabel(label: string): string {
  const [shown, setShown] = useState(label)
  const since = useRef(0)
  useEffect(() => {
    if (label === shown) return undefined
    const wait = since.current + LABEL_HOLD_MS - Date.now()
    const apply = () => {
      since.current = Date.now()
      setShown(label)
    }
    if (wait <= 0) {
      apply()
      return undefined
    }
    const timer = setTimeout(apply, wait)
    return () => clearTimeout(timer)
  }, [label, shown])
  return shown
}

const styles = StyleSheet.create({
  // The list cancels its last row's gap, so the footer brings the feed's own gap: the
  // distance a reply keeps from the bubble above it.
  indicator: { minHeight: 32, marginTop: spacing.xl, flexDirection: 'row', alignItems: 'center', gap: 6 },
  face: { marginLeft: -4 },
  label: { flex: 1, minWidth: 0, flexDirection: 'row' },
  text: { color: colors.muted, fontFamily: fonts.sans, fontSize: 15 },
})
