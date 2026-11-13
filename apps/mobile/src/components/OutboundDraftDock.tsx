import type { Row } from '@manor/client-runtime/state'
import { ScrollView, View } from 'react-native'
import { useOutboundDraftHeight } from '@/lib/useOutboundDraftHeight'
import { spacing } from '@/theme'
import { OutboundDraftGroup } from './OutboundDraftGroup'
import type { DraftActions } from './OutboundDraftBubble'
import { useOutboundDock } from './outboundDockState'

export function OutboundDraftDock({ rows, connected, actions }: { rows: Row[]; connected: boolean; actions: DraftActions }) {
  const maxHeight = useOutboundDraftHeight()
  const dock = useOutboundDock()
  const turns = rows.filter((row) => row.kind === 'turn').filter((turn) => turn.drafts.some((draft) => dock?.pinned(draft)))
  if (turns.length === 0) return null
  return (
    <ScrollView
      accessibilityLabel="Outbound drafts"
      style={{ maxHeight }}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ gap: spacing.sm, paddingBottom: spacing.sm }}
    >
      {turns.map((turn) => (
        <View key={turn.key}>
          <OutboundDraftGroup docked drafts={turn.drafts} connected={connected} actions={actions} />
        </View>
      ))}
    </ScrollView>
  )
}
