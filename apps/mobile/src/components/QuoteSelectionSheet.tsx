import { TextSelectionIcon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react-native'
import type { MessageQuote } from '@manor/contracts'
import { quoteFromRange } from '@manor/client-runtime/message-quotes'
import { useState } from 'react'
import { Modal, Pressable, StyleSheet, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { Text } from '@/components/Text'
import { colors, fonts, radius, spacing, squircle } from '@/theme'

export interface QuoteSelectionSource {
  eventId: string
  text: string
  agentId?: string
}

/** Native selection stays native; this sheet only adds Manor's quote action to it. */
export function QuoteSelectionSheet({
  source,
  onClose,
  onQuote,
}: {
  source: QuoteSelectionSource | null
  onClose: () => void
  onQuote: (quote: MessageQuote) => void
}) {
  const insets = useSafeAreaInsets()
  const [range, setRange] = useState({ start: 0, end: 0 })
  if (source === null) return null
  const quote = quoteFromRange(source.eventId, source.text, range.start, range.end, source.agentId)
  return (
    <Modal animationType="slide" onRequestClose={onClose} transparent visible>
      <View style={styles.scrim}>
        <Pressable accessibilityLabel="Close quote selection" accessibilityRole="button" onPress={onClose} style={StyleSheet.absoluteFill} />
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, spacing.lg) }]}>
          <View style={styles.header}>
            <HugeiconsIcon color={colors.muted} icon={TextSelectionIcon} size={18} strokeWidth={1.8} />
            <Text style={styles.title}>Select what you want to quote</Text>
          </View>
          <TextInput
            accessibilityLabel="Source text"
            autoFocus
            contextMenuHidden={false}
            multiline
            onChangeText={() => undefined}
            onSelectionChange={(event) => setRange(event.nativeEvent.selection)}
            selectionColor={colors.busy}
            showSoftInputOnFocus={false}
            style={styles.source}
            value={source.text}
          />
          <Pressable
            accessibilityLabel="Quote selection"
            accessibilityRole="button"
            disabled={quote === undefined}
            onPress={() => {
              if (quote === undefined) return
              onQuote(quote)
              onClose()
            }}
            style={({ pressed }) => [styles.action, quote === undefined && styles.disabled, pressed && quote !== undefined && styles.pressed]}
          >
            <Text style={styles.actionText}>Quote selection</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  scrim: { flex: 1, justifyContent: 'flex-end', backgroundColor: colors.scrim },
  sheet: { gap: spacing.lg, borderTopLeftRadius: radius.composer, borderTopRightRadius: radius.composer, ...squircle, backgroundColor: colors.raised, padding: spacing.lg },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  title: { color: colors.text, fontFamily: fonts.sans, fontSize: 17, fontWeight: '500' },
  source: { maxHeight: 300, borderRadius: radius.md, ...squircle, backgroundColor: colors.surface, padding: spacing.md, color: colors.text, fontFamily: fonts.sans, fontSize: 17, lineHeight: 25 },
  action: { minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md, ...squircle, backgroundColor: colors.busy },
  actionText: { color: colors.onPrimary, fontFamily: fonts.sans, fontSize: 14, fontWeight: '500' },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.8 },
})
