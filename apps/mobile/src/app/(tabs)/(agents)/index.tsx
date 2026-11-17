import type { AgentConfig } from '@manor/contracts'
import { chatList, chatListPins, createListedState, type ChatListRow } from '@manor/client-runtime/state'
import { router, useFocusEffect } from 'expo-router'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { FlatList, Pressable, StyleSheet, View } from 'react-native'

import { AgentStack } from '@/components/AgentStack'
import { AuthGate } from '@/components/AuthGate'
import { Blobatar } from '@/components/Blobatar'
import { RoleBadge } from '@/components/RoleBadge'
import { SectionScaffold } from '@/components/SectionScaffold'
import { Text } from '@/components/Text'
import { relativeTime } from '@/lib/time'
import { useWorkspace } from '@/providers/WorkspaceProvider'
import { colors, fonts, radius, spacing, squircle } from '@/theme'

const newRequestId = () => `mobile-dm-${Date.now()}-${Math.random().toString(36).slice(2)}`

/** The faces column, so a group's cluster and a DM's portrait start their text at the same x. */
const FACE_WIDTH = 56
const CHIEF_FACE_SIZE = 96
/** Small enough that two pinned personas share one row. */
const PINNED_FACE_SIZE = 72

export default function DirectScreen() {
  return <AuthGate><SectionScaffold title="Agents"><DirectList /></SectionScaffold></AuthGate>
}

/**
 * The messaging inbox: the chief of staff is the fixed way into the house, while
 * every other DM and group keeps the recency order supplied by chatList. A persona
 * with no DM yet is still a row; tapping her creates it before navigating.
 */
function DirectList() {
  const { workspace, status, openChat, createChat, createdChat, clearCreatedChat } = useWorkspace()
  // On the slices the list reads, so a streamed reply elsewhere does not rebuild it.
  const [listedOf] = useState(createListedState)
  const listed = listedOf(workspace)
  const agents = workspace.agents
  const rows = useMemo(() => chatList(listed), [listed])
  // The personas pinned to the top on the Mac, at most two, chief first.
  const heads = chatListPins(agents).flatMap((agent) => {
    const row = rows.find((candidate) => candidate.kind === 'dm' && candidate.agentId === agent.id)
    return row === undefined ? [] : [{ agent, row }]
  })
  const headKeys = new Set(heads.map((head) => head.row.key))
  const conversationRows = rows.filter((row) => !headKeys.has(row.key) && row.chat?.kind !== 'pair')
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // A pending creation settles in the render that sees the server's answer: a
  // notice becomes the error, a dropped connection fails it. The confirmed chat is
  // kept as state rather than derived, because a value the adjustment itself nulls
  // never reaches the commit, and only committed state can feed the navigation
  // effect.
  const [confirmedChatId, setConfirmedChatId] = useState<string | null>(null)
  if (
    createdChat !== null &&
    pending !== null &&
    createdChat.requestId === pending &&
    confirmedChatId !== createdChat.chatId
  ) {
    setConfirmedChatId(createdChat.chatId)
    setPending(null)
  }
  if (pending !== null && workspace.notice?.requestId === pending) {
    setError(workspace.notice.text)
    setPending(null)
  }
  if (pending !== null && status !== 'live') {
    setError('The connection dropped before Manor confirmed the chat.')
    setPending(null)
  }

  useFocusEffect(
    useCallback(
      () => () => {
        setPending(null)
        setConfirmedChatId(null)
        clearCreatedChat()
      },
      [clearCreatedChat],
    ),
  )

  useEffect(() => {
    if (confirmedChatId === null) return
    clearCreatedChat()
    openChat(confirmedChatId)
    router.push({ pathname: '/chat/[id]', params: { id: confirmedChatId } })
  }, [clearCreatedChat, confirmedChatId, openChat])

  const enter = (row: ChatListRow) => {
    if (row.chat !== null) {
      openChat(row.chat.id)
      router.push({ pathname: '/chat/[id]', params: { id: row.chat.id } })
      return
    }
    if (row.agentId === null || status !== 'live' || pending !== null) return
    const requestId = newRequestId()
    setError(null)
    if (createChat({ kind: 'dm', agentId: row.agentId }, { text: '', images: [] }, {}, requestId)) setPending(requestId)
    else setError('Manor could not send the request to your Mac.')
  }

  return (
    <FlatList
      contentContainerStyle={styles.list}
      data={conversationRows}
      keyExtractor={(row) => row.key}
      ListEmptyComponent={heads.length === 0 ? <Text style={styles.empty}>No one to talk to yet. Agents show up once your Mac sends them over.</Text> : null}
      ListHeaderComponent={(
        <View>
          {error === null ? null : <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
          {heads.length === 0 ? null : (
            <View style={styles.heads}>
              {heads.map(({ agent, row }) => (
                <HeadCard
                  key={row.key}
                  agent={agent}
                  compact={heads.length > 1}
                  disabled={pending !== null && row.chat === null}
                  onPress={() => enter(row)}
                  row={row}
                />
              ))}
            </View>
          )}
        </View>
      )}
      renderItem={({ item }) => {
        const agent = item.agentId === null ? undefined : agents.find((candidate) => candidate.id === item.agentId)
        return (
          <ConversationRow
            agent={agent}
            disabled={pending !== null && item.chat === null}
            onPress={() => enter(item)}
            row={item}
            roster={agents}
          />
        )
      }}
    />
  )
}

/**
 * Her turn is running and nothing is blocking it. A question of hers that is open
 * keeps the turn running, but a face thinking out loud over a row that says "Waiting"
 * says the opposite of what the row says; waiting is the user's move, not the persona's.
 */
const busy = (row: ChatListRow) => row.running && !row.waiting

/** A persona pinned above the list, usually the chief of staff. */
function HeadCard({ row, agent, compact, disabled, onPress }: { row: ChatListRow; agent: AgentConfig; compact: boolean; disabled: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityLabel={`Open conversation with ${agent.name}`}
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.chief, compact && styles.chiefCompact, pressed && styles.chiefPressed, disabled && styles.disabled]}
    >
      {/* The face holds a squint while working and blinks at rest. */}
      <Blobatar
        animate={busy(row) ? true : 'blink'}
        color={agent.color}
        name={agent.name}
        shape={agent.avatarShape}
        tone={agent.avatarTone}
        size={compact ? PINNED_FACE_SIZE : CHIEF_FACE_SIZE}
        src={agent.avatar}
        sidebarWorking={busy(row)}
      />
      <View style={styles.chiefNameRow}>
        <View style={styles.chiefNameInner}>
          <Text numberOfLines={1} style={styles.chiefName}>{agent.name}</Text>
          {row.waiting || row.running || row.unread ? (
            <View style={[styles.activityDot, row.waiting ? styles.waitingDot : styles.busyDot]} />
          ) : null}
        </View>
      </View>
      {/* Her role under her name, as the Mac's chief wears it. Her fixed place says she
          is the way in, not what she does, and every other row in the list says both. */}
      <View style={styles.chiefRole}>
        <RoleBadge label={roleLabel(agent)} />
      </View>
    </Pressable>
  )
}

function ConversationRow({
  row,
  agent,
  roster,
  disabled,
  onPress,
}: {
  row: ChatListRow
  agent: AgentConfig | undefined
  roster: AgentConfig[]
  disabled: boolean
  onPress: () => void
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed, disabled && styles.disabled]}
    >
      <View style={styles.face}>
        {agent === undefined ? (
          <AgentStack agentIds={row.agentIds} agents={roster} alive footprint={FACE_WIDTH} size={40} />
        ) : (
          // Every face in the list blinks; the working face also holds a squint.
          <Blobatar
            animate={busy(row) ? true : 'blink'}
            color={agent.color}
            name={agent.name}
            shape={agent.avatarShape}
            tone={agent.avatarTone}
            size={FACE_WIDTH}
            src={agent.avatar}
            sidebarWorking={busy(row)}
          />
        )}
      </View>
      <View style={styles.copy}>
        <View style={styles.titleRow}>
          <Text numberOfLines={1} style={styles.title}>{row.title}</Text>
          <RoleBadge label={row.kind === 'pair' ? 'View only' : agent === undefined ? 'Group' : roleLabel(agent)} />
        </View>
        <Text numberOfLines={1} style={styles.preview}>
          {row.chat === null ? 'No conversation yet. Tap to start.' : row.preview || 'Nothing said yet.'}
        </Text>
      </View>
      <RowMeta row={row} />
    </Pressable>
  )
}

/** Her role, or the nearest true answer when she has none written down. */
const roleLabel = (agent: AgentConfig) => agent.role || (agent.isCos ? 'Chief of staff' : agent.driver)

function RowMeta({ row }: { row: ChatListRow }) {
  return (
    <View style={styles.meta}>
      {row.waiting ? (
        <Text style={styles.waiting}>Waiting</Text>
      ) : row.running ? (
        <Text style={styles.running}>Working</Text>
      ) : row.lastMessageAt === null ? null : (
        <Text style={styles.time}>{relativeTime(row.lastMessageAt)}</Text>
      )}
      {row.unread ? <View style={styles.unreadDot} /> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  list: { width: '100%', maxWidth: 760, alignSelf: 'center', paddingHorizontal: spacing.md, paddingBottom: 48 },
  chief: {
    alignSelf: 'center',
    alignItems: 'center',
    gap: 0,
    marginBottom: spacing.lg,
    borderRadius: radius.lg,
    ...squircle,
    paddingTop: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingBottom: spacing.sm,
  },
  heads: { flexDirection: 'row', justifyContent: 'center', gap: spacing.sm },
  chiefCompact: { flex: 1, minWidth: 0, alignSelf: 'auto' },
  chiefPressed: { opacity: 0.68 },
  // The dot hangs outside the name's flow so the name stays centred; the padding is its room on both sides.
  chiefNameRow: { maxWidth: 240, flexDirection: 'row', justifyContent: 'center', paddingHorizontal: 14 },
  chiefNameInner: { flexShrink: 1, minWidth: 0, justifyContent: 'center' },
  chiefRole: { maxWidth: 240, marginTop: 4, flexDirection: 'row', justifyContent: 'center' },
  chiefName: { flexShrink: 1, color: colors.muted, fontFamily: fonts.sans, fontSize: 18, fontWeight: '500' },
  activityDot: { position: 'absolute', left: '100%', top: '50%', marginLeft: 6, marginTop: -4, width: 8, height: 8, borderRadius: radius.round },
  busyDot: { backgroundColor: colors.busy },
  waitingDot: { backgroundColor: colors.warning },
  row: { minHeight: 68, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, borderRadius: radius.md, ...squircle, marginBottom: spacing.sm, paddingHorizontal: spacing.xs, paddingVertical: spacing.sm },
  rowPressed: { backgroundColor: colors.surface2 },
  disabled: { opacity: 0.38 },
  face: { width: FACE_WIDTH, flexShrink: 0, alignItems: 'center' },
  copy: { flex: 1, minWidth: 0, gap: 6 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  title: { flexShrink: 1, color: colors.text, fontFamily: fonts.sans, fontSize: 18, fontWeight: '500' },
  preview: { color: colors.muted, fontFamily: fonts.sans, fontSize: 13 },
  meta: { flexShrink: 0, minHeight: 44, alignItems: 'flex-end', justifyContent: 'space-between', paddingVertical: 1 },
  time: { color: colors.dim, fontFamily: fonts.sans, fontSize: 12 },
  waiting: { color: colors.warning, fontFamily: fonts.sans, fontSize: 12, fontWeight: '500' },
  running: { color: colors.busy, fontFamily: fonts.sans, fontSize: 12, fontWeight: '500' },
  unreadDot: { width: 7, height: 7, borderRadius: radius.round, backgroundColor: colors.busy },
  error: { color: colors.danger, fontFamily: fonts.sans, fontSize: 13, lineHeight: 18, paddingHorizontal: spacing.md, paddingTop: spacing.md },
  empty: { color: colors.muted, fontFamily: fonts.sans, fontSize: 15, lineHeight: 22, textAlign: 'center', padding: spacing.xl },
})
