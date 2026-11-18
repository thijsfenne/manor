/*
 * THESIS: A subagent reads as its own conversation one step behind the chat that started it, watched and never written to.
 * FIRST VIEWPORT: Back and the task above, where it runs and how it started, then its work, with the way to the parent where the composer would be.
 */
import { chatSubagents, subagentStateOf, subagentTask } from '@manor/client-runtime/turn-trace'
import { chatOf, personaOf, rowsOf, subagentSummaryOf, threadOf, withSessionTitle } from '@manor/client-runtime/state'
import { router, useLocalSearchParams } from 'expo-router'
import { useCallback, useEffect, useMemo } from 'react'
import { StyleSheet, View } from 'react-native'

import { ConnectGate } from '@/components/ConnectGate'
import { ChatHeader } from '@/components/ChatHeader'
import { SubagentConversation } from '@/components/SubagentConversation'
import { Text } from '@/components/Text'
import { useWorkspace } from '@/providers/WorkspaceProvider'
import { SubagentDirectory } from '@/lib/subagentContext'
import { colors, fonts, spacing } from '@/theme'

export default function SubagentScreen() {
  const { callId, chatId, rootId } = useLocalSearchParams<{ callId: string; chatId: string; rootId: string }>()
  return <ConnectGate><SubagentContent callId={callId} chatId={chatId} key={`${chatId}:${callId}`} rootId={rootId} /></ConnectGate>
}

/**
 * `chatId` is the chat whose turn launched this subagent, which for a nested one is its
 * parent's own thread. `rootId` is the chat at the top of the line, which holds the
 * thread while this screen shows it.
 */
function SubagentContent({ callId, chatId, rootId }: { callId: string; chatId: string; rootId: string }) {
  const { workspace, status, openSubagentThread } = useWorkspace()
  const launchThread = threadOf(workspace, chatId)
  const launched = useMemo(() => chatSubagents(rowsOf(launchThread)), [launchThread])
  const subagent = launched.find((candidate) => candidate.step.toolCallId === callId)
  const childId = subagent?.step.subagent?.childChatId
  const summaryOf = useCallback((id: string) => subagentSummaryOf(workspace, id), [workspace.subagents, workspace.threads])
  // The child's own turn rows read the directory from context, as the chat screen's do.
  const listedSubagents = workspace.subagents
  const directory = useMemo(() => (id: string) => listedSubagents.find((child) => child.id === id), [listedSubagents])
  const connected = status === 'live'
  useEffect(() => {
    if (connected && childId !== undefined) openSubagentThread(childId, rootId)
  }, [childId, connected, openSubagentThread, rootId])

  const parentLabel = useMemo(() => {
    if (chatId !== rootId) return summaryOf(chatId)?.title ?? 'Subagent'
    const chat = chatOf(workspace, chatId)
    if (chat === null) return 'Chat'
    return chat.kind === 'dm' ? personaOf(workspace.agents, chat.memberIds[0] ?? 'unknown').name : withSessionTitle(chat).title
  }, [chatId, rootId, summaryOf, workspace.chats, workspace.agents])

  // The way in was a push, so the parent stands underneath with its place kept.
  const openParent = useCallback(() => {
    if (router.canGoBack()) router.back()
    else if (chatId === rootId) router.replace({ pathname: '/chat/[id]', params: { id: chatId } })
    else router.replace('/')
  }, [chatId, rootId])
  const openChild = useCallback((nextCallId: string) => {
    if (childId !== undefined) router.push({ pathname: '/subagent/[callId]', params: { callId: nextCallId, chatId: childId, rootId } })
  }, [childId, rootId])

  const title = subagent === undefined ? 'Subagent' : subagentTask(subagent.step)
  const header = (
    <ChatHeader
      agentIds={[]}
      agents={workspace.agents}
      onBack={openParent}
      subtitle={connected ? parentLabel : status === 'connecting' ? 'Connecting…' : 'Offline'}
      title={title}
    />
  )

  if (subagent === undefined) {
    return (
      <View style={styles.screen}>
        {header}
        <View style={styles.missing}>
          <Text style={styles.missingText}>{launchThread.hasSnapshot ? 'This subagent is no longer in the chat.' : 'Loading subagent…'}</Text>
        </View>
      </View>
    )
  }

  return (
    <SubagentDirectory.Provider value={directory}>
    <View style={styles.screen}>
      <SubagentConversation
        agents={workspace.agents}
        connected={connected}
        onOpenChild={openChild}
        onOpenParent={openParent}
        state={subagentStateOf(subagent, summaryOf)}
        subagent={subagent}
        summary={childId === undefined ? undefined : summaryOf(childId)}
        childId={childId}
      />
      {header}
    </View>
    </SubagentDirectory.Provider>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  missing: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  missingText: { color: colors.muted, fontFamily: fonts.sans, fontSize: 15, textAlign: 'center' },
})
