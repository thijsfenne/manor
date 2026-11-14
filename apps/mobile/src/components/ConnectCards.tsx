import Plug01Icon from '@hugeicons/core-free-icons/Plug01Icon'
import { HugeiconsIcon } from '@hugeicons/react-native'
import type { ConnectRecord } from '@manor/client-runtime/state'
import { StyleSheet, View } from 'react-native'

import { Text } from '@/components/Text'
import { colors, fonts, radius, spacing, squircle } from '@/theme'

export const appLabel = (app: string): string => {
  const words = app.replace(/[_-]+/g, ' ').trim()
  return words.length === 0 ? app : `${words[0]!.toUpperCase()}${words.slice(1)}`
}

/**
 * Connect cards as plain status. The sign-in opens in the Mac's browser, so a phone
 * button would open it out of sight; the card only says where it stands.
 */
export function ConnectCards({ cards }: { cards: readonly ConnectRecord[] }) {
  if (cards.length === 0) return null
  return (
    <View style={styles.stack}>
      {cards.map((card) => {
        const status = card.status === 'ready' ? 'Open it on your Mac'
          : card.status === 'waiting' ? 'Finish in your browser'
            : card.status === 'connected' ? 'Connected' : 'Failed'
        const detail = card.status === 'failed' ? card.reason
          : card.status === 'connected' && (card.nextMessage === true || card.kind === 'mcp_oauth')
            ? 'Its tools arrive on your next message.' : undefined
        return (
          <View key={card.connectId} style={styles.card}>
            <View style={styles.line}>
              <HugeiconsIcon color={colors.muted} icon={Plug01Icon} size={16} strokeWidth={1.7} />
              <Text numberOfLines={1} style={styles.name}>
                {appLabel(card.app)}{card.alias === undefined ? '' : <Text style={styles.alias}>{`  ${card.alias}`}</Text>}
              </Text>
              <Text style={[styles.status, card.status === 'connected' && styles.ok, card.status === 'failed' && styles.failed]}>{status}</Text>
            </View>
            {detail === undefined ? null : <Text style={styles.detail}>{detail}</Text>}
          </View>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  stack: { gap: spacing.sm },
  card: {
    backgroundColor: colors.chip,
    borderRadius: radius.md,
    ...squircle,
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
  },
  line: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
  name: { color: colors.text, flex: 1, fontFamily: fonts.sans, fontSize: 14, minWidth: 0 },
  alias: { color: colors.dim },
  status: { color: colors.muted, fontFamily: fonts.sans, fontSize: 13 },
  ok: { color: colors.ok },
  failed: { color: colors.danger },
  detail: { color: colors.muted, fontFamily: fonts.sans, fontSize: 12 },
})
