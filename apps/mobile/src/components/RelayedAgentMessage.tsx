import type { AgentConfig } from '@manor/contracts'
import { personaOf, type Row } from '@manor/client-runtime/state'
import { StyleSheet, View } from 'react-native'

import { Blobatar } from '@/components/Blobatar'
import { Markdown } from '@/components/Markdown'
import { Text } from '@/components/Text'
import { fonts, spacing } from '@/theme'

/** A message a persona wrote, standing in the transcript in her voice rather than his. */
export function RelayedAgentMessage({ event, agents }: {
  event: Extract<Extract<Row, { kind: 'event' }>['event'], { type: 'user_message' }>
  agents: AgentConfig[]
}) {
  const persona = personaOf(agents, event.authorAgentId ?? 'unknown')
  return (
    <View style={styles.message}>
      <View style={styles.speaker}>
        <Blobatar color={persona.color} name={persona.name} shape={persona.avatarShape} tone={persona.avatarTone} size={32} src={persona.avatar} />
        <Text numberOfLines={1} style={[styles.name, { color: persona.color }]}>{persona.name}</Text>
      </View>
      <Markdown agents={agents} bleed text={event.text} />
    </View>
  )
}

const styles = StyleSheet.create({
  message: { gap: spacing.sm },
  speaker: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  name: { flexShrink: 1, fontFamily: fonts.sans, fontSize: 15, fontWeight: '500' },
})
