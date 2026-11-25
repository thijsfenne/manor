import ArrowUpRight01Icon from '@hugeicons/core-free-icons/ArrowUpRight01Icon'
import { HugeiconsIcon } from '@hugeicons/react-native'
import { quoteText, type AgentConfig, type InlineQuote } from '@manor/contracts'
import { quoteAuthorName } from '@manor/client-runtime/message-quotes'
import { Pressable, StyleSheet } from 'react-native'

import { ScrimScrollView } from '@/components/EdgeScrim'
import { Sheet } from '@/components/Sheet'
import { Text } from '@/components/Text'
import { colors, fonts, radius, spacing, squircle } from '@/theme'

/** Where a quote came from, as the sheet's subtitle. Undefined when nothing is worth naming. */
function quoteSource(quote: InlineQuote, agents: readonly AgentConfig[], showAuthor: boolean): string | undefined {
  if (quote.kind === 'message') return quoteAuthorName(quote, agents, showAuthor)
  return quote.kind === 'note' ? quote.path.split('/').pop() ?? quote.path : quote.context.label
}

/**
 * The whole of a quote that a sent message carries as a `[Quote #n]` pill: its words in
 * full, where they came from, and for a quote of a message in this chat the way back to
 * that message. `quote` null keeps the sheet closed.
 */
export function QuoteRefSheet({
  quote,
  agents,
  showAuthor,
  onClose,
  onOpenSource,
}: {
  quote: InlineQuote | null
  agents: readonly AgentConfig[]
  showAuthor: boolean
  onClose: () => void
  /** Scrolls the transcript to the message a quote was taken from. Absent where there is no transcript. */
  onOpenSource?: (eventId: string) => void
}) {
  const source = quote === null ? undefined : quoteSource(quote, agents, showAuthor)
  const jump = quote?.kind === 'message' && onOpenSource !== undefined ? () => {
    onClose()
    onOpenSource(quote.eventId)
  } : undefined
  return (
    <Sheet onClose={onClose} open={quote !== null} subtitle={source} title="Quote">
      {quote === null ? null : (
        <>
          <ScrimScrollView contentContainerStyle={styles.body}>
            <Text selectable style={styles.text}>{quoteText(quote)}</Text>
          </ScrimScrollView>
          {jump === undefined ? null : (
            <Pressable accessibilityLabel="Show source message" accessibilityRole="button" onPress={jump} style={({ pressed }) => [styles.action, pressed && styles.pressed]}>
              <HugeiconsIcon color={colors.onPrimary} icon={ArrowUpRight01Icon} size={18} strokeWidth={2} />
              <Text style={styles.actionText}>Show source</Text>
            </Pressable>
          )}
        </>
      )}
    </Sheet>
  )
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: spacing.lg, paddingBottom: spacing.lg },
  text: { color: colors.text, fontFamily: fonts.sans, fontSize: 17, lineHeight: 25 },
  action: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, marginHorizontal: spacing.lg, borderRadius: radius.md, ...squircle, backgroundColor: colors.busy },
  actionText: { color: colors.onPrimary, fontFamily: fonts.sans, fontSize: 14, fontWeight: '500' },
  pressed: { opacity: 0.8 },
})
