import Cancel01Icon from '@hugeicons/core-free-icons/Cancel01Icon'
import ReplyIcon from '@hugeicons/core-free-icons/ReplyIcon'
import { HugeiconsIcon } from '@hugeicons/react-native'
import type { MessageReply } from '@manor/contracts'
import { Pressable, StyleSheet, View } from 'react-native'

import { useBubbleTint } from '@/components/bubbleTint'
import { Text } from '@/components/Text'
import { colors, fonts, radius, spacing, squircle } from '@/theme'

/** The one answer this draft or sent message explicitly targets. */
export function ReplyContextChip({
  reply,
  name,
  onRemove,
}: {
  reply: MessageReply
  name: string
  onRemove?: () => void
}) {
  const tint = useBubbleTint()
  return (
    <View style={[styles.chip, tint && { backgroundColor: tint.chip }]}>
      <HugeiconsIcon color={tint?.ink ?? colors.muted} icon={ReplyIcon} size={14} strokeWidth={1.8} />
      <Text numberOfLines={1} style={[styles.name, tint && { color: tint.ink }]}>{name}</Text>
      <Text numberOfLines={1} style={[styles.text, tint && { color: tint.ink }]}>{reply.text}</Text>
      {onRemove === undefined ? null : (
        <Pressable
          accessibilityLabel={`Stop replying to ${name}`}
          accessibilityRole="button"
          hitSlop={8}
          onPress={onRemove}
          style={styles.remove}
        >
          <HugeiconsIcon color={colors.dim} icon={Cancel01Icon} size={12} strokeWidth={1.8} />
        </Pressable>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  chip: {
    minWidth: 0,
    maxWidth: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    borderRadius: radius.md,
    ...squircle,
    backgroundColor: colors.chip,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
  },
  name: { flexShrink: 0, maxWidth: 110, color: colors.text, fontFamily: fonts.sans, fontSize: 13, fontWeight: '500' },
  text: { flexShrink: 1, color: colors.muted, fontFamily: fonts.sans, fontSize: 13 },
  remove: { width: 18, height: 18, alignItems: 'center', justifyContent: 'center' },
})
