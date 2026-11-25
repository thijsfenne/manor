/*
 * THESIS: A DM's Files is the Mac's library for that agent, behind the chat or its agent overview, with the viewer for the quick look.
 * FIRST VIEWPORT: Back to the chat, the title Files, the All / Media / Files chips and this week's rows.
 */
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router'
import { useCallback } from 'react'

import { ConnectGate } from '@/components/ConnectGate'
import { FileLibrary } from '@/components/FileLibrary'
import { SectionScaffold } from '@/components/SectionScaffold'
import { leaveEventReveal } from '@/lib/threadReveal'
import { useWorkspace } from '@/providers/WorkspaceProvider'

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
    <SectionScaffold onBack={back} title="Files">
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
    </SectionScaffold>
  )
}
