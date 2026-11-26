import SmilePlusIcon from '@hugeicons/core-free-icons/SmilePlusIcon'
import { HugeiconsIcon } from '@hugeicons/react-native'
import { QUICK_REACTIONS, type MessageReaction } from '@manor/contracts'
import { REACTION_PALETTE, reactionAfterPick } from '@manor/client-runtime/state'
import { Pressable, ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'

import { GlassSurface } from '@/components/GlassSurface'
import { Text } from '@/components/Text'
import { colors, fonts, radius, spacing } from '@/theme'

const BADGE = 26

/**
 * The emoji on a DM bubble's bottom outer edge: left under an agent's message, right under
 * the user's. The user's own takes itself off on a tap where it may; the agent's wears its accent ring.
 */
export function ReactionBadge({ reaction, color, onRemove }: {
  reaction: MessageReaction
  /** The reacting agent's accent; absent on the user's own reaction. */
  color?: string
  onRemove?: () => void
}) {
  const glass = (
    <GlassSurface radius={BADGE / 2} style={[styles.badge, color === undefined ? null : { borderWidth: 1.5, borderColor: color }]}>
      <Text style={styles.badgeEmoji}>{reaction.emoji}</Text>
    </GlassSurface>
  )
  const spot = [styles.badgeSpot, color === undefined ? styles.badgeLeft : styles.badgeRight]
  if (onRemove === undefined) {
    return <View accessibilityLabel={`Reacted ${reaction.emoji}`} accessibilityRole="image" style={spot}>{glass}</View>
  }
  return (
    <Pressable accessibilityLabel={`Remove your ${reaction.emoji} reaction`} accessibilityRole="button" hitSlop={8} onPress={onRemove} style={spot}>
      {glass}
    </Pressable>
  )
}

/** The pill above a held agent message: the quick reactions, then the way to the fuller set. */
export function ReactionPill({ current, more, onPick, onMore }: {
  current?: MessageReaction
  /** Whether the fuller set stands open in place of the actions. */
  more: boolean
  onPick: (emoji: string | null) => void
  onMore: () => void
}) {
  return (
    <GlassSurface radius={999} style={styles.pill}>
      {QUICK_REACTIONS.map((emoji) => <Choice current={current} emoji={emoji} key={emoji} onPick={onPick} size={44} />)}
      <Pressable
        accessibilityLabel="More emoji"
        accessibilityRole="button"
        accessibilityState={{ expanded: more }}
        onPress={onMore}
        style={({ pressed }) => [styles.choice, { width: 44, height: 44 }, styles.more, (pressed || more) && styles.choiceOn]}
      >
        <HugeiconsIcon color={colors.muted} icon={SmilePlusIcon} size={22} strokeWidth={1.8} />
      </Pressable>
    </GlassSurface>
  )
}

/** The fuller set, standing where the held message's actions were. */
export function ReactionPalette({ current, onPick, style }: {
  current?: MessageReaction
  onPick: (emoji: string | null) => void
  style?: StyleProp<ViewStyle>
}) {
  return (
    <GlassSurface radius={radius.lg} style={style}>
      <ScrollView contentContainerStyle={styles.paletteBody} style={styles.paletteScroll}>
        {REACTION_PALETTE.map((group) => (
          <View key={group.name}>
            <Text style={styles.group}>{group.name}</Text>
            <View style={styles.grid}>
              {group.emoji.map((emoji) => <Choice current={current} emoji={emoji} key={emoji} onPick={onPick} size={42} />)}
            </View>
          </View>
        ))}
      </ScrollView>
    </GlassSurface>
  )
}

function Choice({ current, emoji, onPick, size }: {
  current: MessageReaction | undefined
  emoji: string
  onPick: (emoji: string | null) => void
  size: number
}) {
  return (
    <Pressable
      accessibilityLabel={`React ${emoji}`}
      accessibilityRole="button"
      accessibilityState={{ selected: current?.emoji === emoji }}
      onPress={() => onPick(reactionAfterPick(current, emoji))}
      style={({ pressed }) => [styles.choice, { width: size, height: size }, (pressed || current?.emoji === emoji) && styles.choiceOn]}
    >
      <Text style={styles.choiceEmoji}>{emoji}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  badgeSpot: { position: 'absolute', bottom: -BADGE / 2 - 2, zIndex: 1 },
  badgeLeft: { left: spacing.md },
  badgeRight: { right: spacing.md },
  badge: { minWidth: BADGE, height: BADGE, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  badgeEmoji: { fontSize: 14, lineHeight: 18 },
  pill: { flexDirection: 'row', alignItems: 'center', padding: spacing.xs },
  more: { marginLeft: 2 },
  choice: { alignItems: 'center', justifyContent: 'center', borderRadius: 999 },
  choiceOn: { backgroundColor: colors.surface2 },
  choiceEmoji: { fontSize: 26, lineHeight: 32 },
  paletteScroll: { borderRadius: radius.lg },
  paletteBody: { padding: spacing.sm },
  group: { color: colors.dim, fontFamily: fonts.sans, fontSize: 13, paddingHorizontal: spacing.xs, paddingTop: spacing.xs, paddingBottom: 2 },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
})
