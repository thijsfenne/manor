import { BookOpen01Icon, Cancel01Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react-native'
import { quoteAuthorName } from '@manor/client-runtime/message-quotes'
import type { AgentConfig, MessageQuote, NoteQuote } from '@manor/contracts'
import { Pressable, StyleSheet, View } from 'react-native'

import { useBubbleTint } from '@/components/bubbleTint'
import { Text } from '@/components/Text'
import { colors, fonts, radius, spacing, squircle } from '@/theme'

/**
 * A selected snapshot in the composer draft, drawn like the sent quote: a thin bar and
 * the excerpt on a faint wash, one line, no sender label.
 */
export function QuoteContextChip({
  quote,
  onRemove,
}: {
  quote: MessageQuote
  onRemove?: () => void
}) {
  const tint = useBubbleTint()
  return (
    <View style={[styles.draftQuote, { borderLeftColor: tint ? tint.ink : colors.dim }, tint && { backgroundColor: tint.wash }]}>
      <Text numberOfLines={1} style={[styles.text, tint && { color: tint.ink }]}>{quote.text}</Text>
      {onRemove === undefined ? null : (
        <Pressable
          accessibilityLabel="Remove selected quote"
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

/**
 * A sent quote in a user bubble, drawn as a blockquote: a thin bar and the excerpt, no
 * fill. On a tinted bubble the bar and text take the bubble's ink (full strength, since
 * dimming it would drop below AA on the fill). The author shows only in a room with
 * several personas.
 */
export function QuoteBlock({
  agents,
  quote,
  showAuthor,
  onOpen,
}: {
  agents: readonly AgentConfig[]
  quote: MessageQuote
  showAuthor: boolean
  onOpen?: () => void
}) {
  const tint = useBubbleTint()
  const author = quoteAuthorName(quote, agents, showAuthor, 'You')
  const ink = tint && { color: tint.ink }
  return (
    <Pressable
      accessibilityLabel={onOpen === undefined ? undefined : author === undefined ? 'Open source message' : `Open source message from ${author}`}
      accessibilityRole={onOpen === undefined ? undefined : 'button'}
      disabled={onOpen === undefined}
      onPress={onOpen}
      style={[styles.block, { borderLeftColor: tint ? tint.ink : colors.dim }]}
    >
      {author === undefined ? null : <Text numberOfLines={1} style={[styles.blockAuthor, ink]}>{author}</Text>}
      <Text numberOfLines={2} style={[styles.blockText, ink]}>{quote.text}</Text>
    </Pressable>
  )
}

/** Selected words from a Knowledge note. Display only; the phone cannot mint these. */
export function NoteQuoteContextChip({ quote }: { quote: NoteQuote }) {
  const tint = useBubbleTint()
  const name = quote.path.split('/').pop() ?? quote.path
  return (
    <View style={[styles.chip, tint && { backgroundColor: tint.chip }]}>
      <View style={styles.content}>
        <HugeiconsIcon color={tint?.ink ?? colors.muted} icon={BookOpen01Icon} size={14} strokeWidth={1.8} />
        <Text numberOfLines={1} style={[styles.name, tint && { color: tint.ink }]}>{name}</Text>
        <Text style={[styles.dot, tint && { color: tint.ink }]}>·</Text>
        <Text numberOfLines={1} style={[styles.text, tint && { color: tint.ink }]}>{quote.text}</Text>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  draftQuote: { minWidth: 0, maxWidth: '100%', flexDirection: 'row', alignItems: 'center', borderLeftWidth: 2, borderTopRightRadius: radius.md, borderBottomRightRadius: radius.md, backgroundColor: colors.chip, paddingLeft: spacing.sm, paddingRight: spacing.xs, paddingVertical: 6 },
  chip: { minWidth: 0, maxWidth: '100%', flexDirection: 'row', alignItems: 'center', borderRadius: radius.md, ...squircle, backgroundColor: colors.chip, paddingHorizontal: spacing.sm, paddingVertical: 6 },
  content: { minWidth: 0, flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  name: { flexShrink: 0, maxWidth: 110, color: colors.text, fontFamily: fonts.sans, fontSize: 13, fontWeight: '500' },
  dot: { color: colors.dim, fontFamily: fonts.sans, fontSize: 13 },
  text: { flexShrink: 1, color: colors.muted, fontFamily: fonts.sans, fontSize: 13 },
  block: { minWidth: 0, maxWidth: '100%', borderLeftWidth: 2, paddingLeft: spacing.sm },
  blockAuthor: { color: colors.text, fontFamily: fonts.sans, fontSize: 12, fontWeight: '500' },
  blockText: { color: colors.muted, fontFamily: fonts.sans, fontSize: 13 },
  remove: { width: 18, height: 18, marginLeft: spacing.xs, alignItems: 'center', justifyContent: 'center' },
})
