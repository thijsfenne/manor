/*
 * THESIS: A project's Sessions read as the Mac's overview beside the thread, one step behind the thread, never as a second home list.
 * FIRST VIEWPORT: Back to the thread, then Needs you, Working and Settled with their counts.
 */
import ArrowLeft01Icon from '@hugeicons/core-free-icons/ArrowLeft01Icon'
import { projectSessionOverview } from '@manor/client-runtime/state'
import { router, useLocalSearchParams } from 'expo-router'
import { useMemo } from 'react'
import { StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { AuthGate } from '@/components/AuthGate'
import { CHAT_HEADER_HEIGHT } from '@/components/ChatHeader'
import { EdgeScrim } from '@/components/EdgeScrim'
import { GlassIconButton } from '@/components/GlassIconButton'
import { SessionOverviewList } from '@/components/SessionOverviewList'
import { Text } from '@/components/Text'
import { leaveThreadReveal } from '@/lib/threadReveal'
import { useWorkspace } from '@/providers/WorkspaceProvider'
import { colors, fonts, spacing } from '@/theme'

export default function ProjectSessionsScreen() {
  return (
    <AuthGate>
      <ProjectSessions />
    </AuthGate>
  )
}

function ProjectSessions() {
  const { threadId } = useLocalSearchParams<{ threadId: string }>()
  const { workspace, openChat } = useWorkspace()
  // Inside a tab stack the bottom inset is the tab bar plus the home indicator.
  const insets = useSafeAreaInsets()
  const overview = useMemo(
    // The slices the overview reads, not `workspace`, so the React Compiler keeps this screen.
    () => projectSessionOverview({
      projects: workspace.projects, chats: workspace.chats, workHandoffs: workspace.workHandoffs, activity: workspace.activity,
      subagents: workspace.subagents, backgroundWork: workspace.backgroundWork, houseSettings: workspace.houseSettings,
    }, threadId),
    [workspace.projects, workspace.chats, workspace.workHandoffs, workspace.activity, workspace.subagents, workspace.backgroundWork, workspace.houseSettings, threadId],
  )
  const back = () => (router.canGoBack() ? router.back() : router.replace({ pathname: '/chat/[id]', params: { id: threadId } }))

  return (
    <View style={styles.screen}>
      <SessionOverviewList
        agents={workspace.agents}
        inset={{ top: insets.top + CHAT_HEADER_HEIGHT + spacing.sm, bottom: insets.bottom + spacing.sm }}
        onOpen={(chatId) => {
          openChat(chatId)
          router.push({ pathname: '/chat/[id]', params: { id: chatId } })
        }}
        onRevealProposal={(rowKey) => {
          leaveThreadReveal(threadId, rowKey)
          back()
        }}
        overview={overview}
        threadId={threadId}
      />
      {/* Drawn over the list, as the thread's own header, so rows scroll up softly behind it. */}
      <View pointerEvents="box-none" style={styles.header}>
        <EdgeScrim edge="top" height={insets.top + CHAT_HEADER_HEIGHT + 28} />
        <View pointerEvents="box-none" style={[styles.row, { paddingTop: insets.top + 6 }]}>
          <GlassIconButton accessibilityLabel="Back to the thread" icon={ArrowLeft01Icon} onPress={back} />
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
