/*
 * THESIS: A DM's Files is the Mac's library for that agent, behind the chat or its agent overview, with the viewer for the quick look.
 * FIRST VIEWPORT: Back to the chat, the title Files, the All / Media / Files chips and this week's rows.
 */
import ArrowLeft01Icon from '@hugeicons/core-free-icons/ArrowLeft01Icon'
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router'
import { useCallback } from 'react'
import { StyleSheet, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

import { ConnectGate } from '@/components/ConnectGate'
import { FileLibrary } from '@/components/FileLibrary'
import { GlassIconButton } from '@/components/GlassIconButton'
import { Text } from '@/components/Text'
import { leaveEventReveal } from '@/lib/threadReveal'
import { useWorkspace } from '@/providers/WorkspaceProvider'
import { colors, fonts, spacing } from '@/theme'

export default function DmFilesScreen() {
  return (
    <ConnectGate>
      <DmFiles />
    </ConnectGate>
  )
}

function DmFiles() {
  const { chatId } = useLocalSearchParams<{ chatId: string }>()
  const { workspace, status, getDmFiles } = useWorkspace()
  const back = () => (router.canGoBack() ? router.back() : router.replace({ pathname: '/chat/[id]', params: { id: chatId } }))

  // Asked on focus, so coming back from the chat refreshes the list, and again once the
  // socket is live, since a request sent while it was down went nowhere.
  const agentId = workspace.chats.find((chat) => chat.id === chatId)?.memberIds[0]
  const name = workspace.agents.find((agent) => agent.id === agentId)?.name ?? 'this agent'
  const live = status === 'live'
  useFocusEffect(useCallback(() => {
    if (live) getDmFiles(chatId)
  }, [live, getDmFiles, chatId]))

  return (
    <SafeAreaView edges={['top']} style={styles.screen}>
      <View style={styles.header}>
        <GlassIconButton accessibilityLabel="Back" icon={ArrowLeft01Icon} onPress={back} />
        <View style={styles.heading}>
          <Text maxFontSizeMultiplier={1.35} numberOfLines={1} style={styles.title}>Files</Text>
        </View>
        <View style={styles.side} />
      </View>
      <FileLibrary
        agents={workspace.agents}
        name={name}
        files={workspace.dmFiles[chatId]}
        onShowInChat={(eventId) => {
          leaveEventReveal(chatId, eventId)
          // Opened from the agent's overview too, so go to the chat itself rather than one step back.
          router.dismissTo({ pathname: '/chat/[id]', params: { id: chatId } })
        }}
      />
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  header: {
    minHeight: 76,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingTop: spacing.xs,
    paddingBottom: spacing.md,
  },
  side: { width: 44, height: 44 },
  heading: { flex: 1, minWidth: 0, alignItems: 'center', paddingHorizontal: spacing.sm },
  title: { maxWidth: '100%', color: colors.text, fontFamily: fonts.display, fontSize: 18, letterSpacing: -0.25, textAlign: 'center' },
})
