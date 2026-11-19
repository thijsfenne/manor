/*
 * THESIS: One thing a DM's agent holds, listed read-only; changing it stays on the Mac.
 * FIRST VIEWPORT: Back to her overview, the list's title, then its rows or what is missing.
 */
import { router, useLocalSearchParams } from 'expo-router'
import { useState } from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'

import { ConnectGate } from '@/components/ConnectGate'
import { EmptyCard } from '@/components/EmptyCard'
import { byName, ConnectorRow, SkillRow } from '@/components/PluginRows'
import { RoutineRow } from '@/components/RoutineRow'
import { SectionScaffold } from '@/components/SectionScaffold'
import { Text } from '@/components/Text'
import { agentHoldings, agentOfDm, isAgentList, type AgentList } from '@/lib/agentOverview'
import { useWorkspace } from '@/providers/WorkspaceProvider'
import { colors, fonts, spacing } from '@/theme'

const TITLES: Record<AgentList, string> = { tasks: 'Scheduled tasks', skills: 'Skills', connectors: 'Connectors' }

export default function AgentListScreen() {
  const { chatId, list } = useLocalSearchParams<{ chatId: string; list: string }>()
  const kind: AgentList = isAgentList(list) ? list : 'tasks'
  const back = () => (router.canGoBack() ? router.back() : router.replace({ pathname: '/agent/[chatId]', params: { chatId } }))
  return (
    <ConnectGate>
      <SectionScaffold onBack={back} title={TITLES[kind]}>
        <AgentListBody chatId={chatId} kind={kind} />
      </SectionScaffold>
    </ConnectGate>
  )
}

function AgentListBody({ chatId, kind }: { chatId: string; kind: AgentList }) {
  const { workspace } = useWorkspace()
  // Read once: a read-only list has no countdown to keep current.
  const [at] = useState(Date.now)
  const agent = agentOfDm(workspace, chatId)
  if (agent === undefined) return <Text style={styles.note}>This agent is no longer in Manor.</Text>
  const holdings = agentHoldings(workspace, agent)

  const items = kind === 'tasks'
    ? holdings.tasks.map((routine) => <RoutineRow agent={agent} at={at} key={routine.id} routine={routine} />)
    : kind === 'skills'
      ? [...holdings.skills].sort(byName).map((skill) => <SkillRow key={skill.id} skill={skill} />)
      : [...holdings.connectors].sort(byName).map((server) => <ConnectorRow key={server.id} server={server} />)
  const empty = {
    tasks: <EmptyCard title="No scheduled tasks" body={`Ask ${agent.name} in this chat to remind you or check something later.`} />,
    skills: <EmptyCard title="No skills on" body={`Turn skills on for ${agent.name} in Agent settings on your Mac.`} />,
    connectors: <EmptyCard title="No connectors on" body={`Attach connectors to ${agent.name} in Agent settings on your Mac.`} />,
  }[kind]

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Text style={styles.note}>{kind === 'tasks' ? 'Run or change these on the Scheduled tasks page or your Mac.' : 'Change these in Agent settings on your Mac.'}</Text>
      {items.length === 0 ? empty : <View style={[styles.rows, kind !== 'tasks' && styles.plugins]}>{items}</View>}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  page: { width: '100%', maxWidth: 760, alignSelf: 'center', gap: spacing.lg, padding: spacing.lg, paddingBottom: 48 },
  note: { color: colors.muted, fontFamily: fonts.sans, fontSize: 15, lineHeight: 21 },
  rows: { gap: spacing.xs },
  // A plugin row pads its own tile, so the list hangs it on the page edge as Plugins does.
  plugins: { marginHorizontal: -spacing.sm },
})
