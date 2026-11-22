/*
 * THESIS: A project's Sessions read as the Mac's overview beside the thread, one page right of the thread, never as a second home list.
 * FIRST VIEWPORT: Back to the thread, then Needs you, Working and Settled with their counts.
 */
import ArrowLeft01Icon from '@hugeicons/core-free-icons/ArrowLeft01Icon'
import type { AgentConfig } from '@manor/contracts'
import type { SessionOverview } from '@manor/client-runtime/state'
import { StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { CHAT_HEADER_HEIGHT } from '@/components/ChatHeader'
import { EdgeScrim } from '@/components/EdgeScrim'
import { GlassIconButton } from '@/components/GlassIconButton'
import { SessionOverviewList } from '@/components/SessionOverviewList'
import { Text } from '@/components/Text'
import { colors, fonts, spacing } from '@/theme'

/** A project thread's Sessions, the page `ThreadPager` slides in to the right of the thread. */
export function ProjectSessionsPage({ threadId, overview, agents, onBack, onOpen, onRevealProposal }: {
  threadId: string
  overview: SessionOverview
  agents: AgentConfig[]
  onBack: () => void
  onOpen: (chatId: string) => void
  onRevealProposal: (rowKey: string) => void
}) {
  // Inside a tab stack the bottom inset is the tab bar plus the home indicator.
  const insets = useSafeAreaInsets()

  return (
    <View style={styles.screen}>
      <SessionOverviewList
        agents={agents}
        inset={{ top: insets.top + CHAT_HEADER_HEIGHT + spacing.sm, bottom: insets.bottom + spacing.sm }}
        onOpen={onOpen}
        onRevealProposal={onRevealProposal}
        overview={overview}
        threadId={threadId}
      />
      {/* Drawn over the list, as the thread's own header, so rows scroll up softly behind it. */}
      <View pointerEvents="box-none" style={styles.header}>
        <EdgeScrim edge="top" height={insets.top + CHAT_HEADER_HEIGHT + 28} />
        <View pointerEvents="box-none" style={[styles.row, { paddingTop: insets.top + 6 }]}>
          <GlassIconButton accessibilityLabel="Back to the thread" icon={ArrowLeft01Icon} onPress={onBack} />
          <View style={styles.heading}>
            <Text maxFontSizeMultiplier={1.35} numberOfLines={1} style={styles.title}>Sessions</Text>
          </View>
          <View style={styles.side} />
        </View>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  header: { position: 'absolute', top: 0, right: 0, left: 0 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg },
  side: { width: 44, height: 44 },
  heading: { flex: 1, minWidth: 0, alignItems: 'center', paddingHorizontal: spacing.sm },
  title: { maxWidth: '100%', color: colors.text, fontFamily: fonts.display, fontSize: 18, letterSpacing: -0.25, textAlign: 'center' },
})
