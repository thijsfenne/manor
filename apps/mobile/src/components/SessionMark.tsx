import GitBranchIcon from '@hugeicons/core-free-icons/GitBranchIcon'
import { HugeiconsIcon } from '@hugeicons/react-native'
import type { AgentConfig, Chat } from '@manor/contracts'
import { StyleSheet, View } from 'react-native'

import { AgentStack } from '@/components/AgentStack'
import { ProviderMark } from '@/components/ProviderMark'
import { colors } from '@/theme'

/**
 * Who runs a session, at the end of a list row or a project's Sessions row: a Single
 * session shows its provider's mark (none before a driver is set), a Multiple one the
 * faces of its personas. A session in its own git worktree also wears the Mac's purple
 * branch on the left. The phone's copy of the web `SessionMark`, one rule for every
 * phone list; `stackSize` lets the roomier home card keep its larger faces.
 */
export function SessionMark({ chat, agents, stackSize = 20 }: {
  chat: Pick<Chat, 'mode' | 'singleDriver' | 'agentIds' | 'checkout'>
  agents: AgentConfig[]
  stackSize?: number
}) {
  const who = chat.mode === 'single'
    ? chat.singleDriver === undefined ? null : <ProviderMark driver={chat.singleDriver} size={16} />
    : <AgentStack agentIds={chat.agentIds} agents={agents} size={stackSize} />
  if (chat.checkout.mode !== 'worktree') return who
  return (
    <View style={styles.row}>
      <View accessibilityLabel="Worktree" accessibilityRole="image" accessible>
        <HugeiconsIcon color={colors.worktree} icon={GitBranchIcon} size={16} strokeWidth={1.8} />
      </View>
      {who}
    </View>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
})
