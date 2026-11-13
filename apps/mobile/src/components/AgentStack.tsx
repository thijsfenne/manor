import type { AgentConfig } from '@manor/contracts'
import { knownAgentIds, personaOf } from '@manor/client-runtime/state'
import { StyleSheet, View } from 'react-native'

import { Blobatar } from '@/components/Blobatar'
import { Text } from '@/components/Text'
import { colors, fonts } from '@/theme'

/** Faces shown in a row before the rest become a count, the same ceiling as the desktop. */
const MAX_SHOWN = 3

/**
 * Faces shown inside a footprint. One more than the row, because a square holds a
 * fourth without growing: three sit as a triangle, four fill the corners, and the
 * count beside them is a small badge rather than a face-sized slot, so a group of
 * five still shows five personas' worth of information in one portrait's width.
 */
const MAX_PLACED = 4

/**
 * The personas in a chat as one overlapping cluster, first persona on top. Past
 * three the last slot is a count, so the cluster never grows past its column.
 *
 * With a `footprint` the cluster is a square the size of one portrait instead of a
 * row: up to four marks placed inside it, and past four a small count over the last
 * corner. That is what keeps a group's faces and a DM's portrait starting their text
 * at the same x.
 */
export function AgentStack({
  agentIds: requested,
  agents,
  size,
  footprint,
  alive = false,
}: {
  agentIds: readonly string[]
  agents: AgentConfig[]
  size: number
  footprint?: number
  /** Blink occasionally. For lists of conversations. */
  alive?: boolean
}) {
  const living = alive ? ({ animate: 'blink' } as const) : null
  // An id the roster does not resolve draws no face; an empty footprint keeps its square.
  const agentIds = knownAgentIds(agents, requested)
  if (agentIds.length === 0) return footprint === undefined ? null : <View style={{ width: footprint, height: footprint }} />
  const names = agentIds.map((agentId) => personaOf(agents, agentId).name).join(', ')

  if (footprint !== undefined) {
    const marks = agentIds.slice(0, MAX_PLACED)
    const rest = agentIds.length - marks.length
    const offset = footprint - size
    const places =
      marks.length === 1
        ? [{ left: offset / 2, top: offset / 2 }]
        : marks.length === 2
          ? [{ left: 0, top: 0 }, { left: offset, top: offset }]
          : marks.length === 3
            ? [
                { left: 0, top: 0 },
                { left: offset, top: 0 },
                { left: offset / 2, top: offset },
              ]
            : [
                { left: 0, top: 0 },
                { left: offset, top: 0 },
                { left: 0, top: offset },
                { left: offset, top: offset },
              ]
    // Small enough to sit in the corner of the last face rather than take a face's
    // place, which is what buys the fourth persona her own portrait.
    const badge = Math.round(size * 0.55)

    return (
      <View accessibilityLabel={names} style={{ width: footprint, height: footprint }}>
        {marks.map((agentId, index) => {
          const persona = personaOf(agents, agentId)
          return (
            <View key={agentId} style={[styles.placed, places[index], { zIndex: marks.length - index }]}>
              <Blobatar {...living} color={persona.color} name={persona.name} shape={persona.avatarShape} tone={persona.avatarTone} size={size} src={persona.avatar} />
            </View>
          )
        })}
        {rest > 0 ? (
          <View style={[styles.count, styles.badge, { width: badge, height: badge, borderRadius: badge / 2, zIndex: marks.length + 1 }]}>
            <Text style={[styles.countText, { fontSize: Math.round(badge * 0.52) }]}>+{rest}</Text>
          </View>
        ) : null}
      </View>
    )
  }

  const shown = agentIds.slice(0, MAX_SHOWN)
  const hidden = agentIds.length - shown.length

  return (
    <View accessibilityLabel={names} style={styles.stack}>
      {shown.map((agentId, index) => {
        const persona = personaOf(agents, agentId)
        return (
          // Earlier faces paint over later ones, so each slides under the one before it.
          <View key={agentId} style={[index === 0 ? null : { marginLeft: -Math.round(size * 0.4) }, { zIndex: shown.length - index }]}>
            <Blobatar {...living} color={persona.color} name={persona.name} shape={persona.avatarShape} tone={persona.avatarTone} size={size} src={persona.avatar} />
          </View>
        )
      })}
      {hidden > 0 ? (
        <View style={[styles.count, { width: size, height: size, borderRadius: size / 2, marginLeft: -Math.round(size / 4) }]}>
          <Text style={[styles.countText, { fontSize: Math.round(size * 0.42) }]}>+{hidden}</Text>
        </View>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  stack: { flexDirection: 'row', alignItems: 'center' },
  placed: { position: 'absolute' },
  badge: { position: 'absolute', right: 0, bottom: 0 },
  count: { alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface2, zIndex: 0 },
  countText: { color: colors.muted, fontFamily: fonts.sans, fontWeight: '500' },
})
