import ArrowUpLeft01Icon from '@hugeicons/core-free-icons/ArrowUpLeft01Icon'
import Clock01Icon from '@hugeicons/core-free-icons/Clock01Icon'
import { HugeiconsIcon } from '@hugeicons/react-native'
import { LegendList } from '@legendapp/list/react-native'
import type { Row } from '@manor/client-runtime/state'
import { messageBrief, rowsOf } from '@manor/client-runtime/state'
import { launchDriver, providerHelperKey, providerHelperThread, subagentBarStatus, subagentRuntime, type ChatSubagent, type SubagentState } from '@manor/client-runtime/turn-trace'
import type { AgentConfig, SubagentSummary } from '@manor/contracts'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { Badge } from '@/components/Badge'
import { CHAT_HEADER_HEIGHT } from '@/components/ChatHeader'
import { EdgeScrim } from '@/components/EdgeScrim'
import { GlassSurface } from '@/components/GlassSurface'
import { KickoffCard } from '@/components/KickoffCard'
import { ProviderMark } from '@/components/ProviderMark'
import { RelayedAgentMessage } from '@/components/RelayedAgentMessage'
import { Text } from '@/components/Text'
import { TranscriptCovered, Turn } from '@/components/Turn'
import { useScreenCovered } from '@/lib/useScreenCovered'
import { useLiveThread } from '@/providers/WorkspaceProvider'
import { colors, fonts, radius, spacing, squircle } from '@/theme'

const NOT_REPORTED = 'Not reported'
const ESTIMATED_ROW = 120
/** The bar's own height and the gap above it, which the transcript clears. */
const BAR_SPACE = 84

const startedAt = (ts: number) => new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })

interface SubagentConversationProps {
  subagent: ChatSubagent
  state: SubagentState
  summary: SubagentSummary | undefined
  /** The child's own chat, whose thread it reads; absent for a helper its provider ran inside its own turn. */
  childId: string | undefined
  agents: AgentConfig[]
  connected: boolean
  onOpenChild: (toolCallId: string) => void
  onOpenParent: () => void
}

/**
 * A subagent's whole story on its own screen. It takes no messages from the user, so the
 * bar stands where the composer would, and its questions wait in the parent.
 */
export function SubagentConversation(props: SubagentConversationProps) {
  const insets = useSafeAreaInsets()
  const top = insets.top + CHAT_HEADER_HEIGHT + spacing.lg
  const bottom = insets.bottom + BAR_SPACE
  const { childId } = props
  return (
    <>
      {childId === undefined
        ? <ProviderConversation {...props} bottom={bottom} top={top} />
        : <ChildConversation {...props} bottom={bottom} childId={childId} top={top} />}
      <SubagentBar {...props} />
    </>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={styles.fact}>
      <Text style={styles.factLabel}>{label}</Text>
      <View style={styles.factValue}>{children}</View>
    </View>
  )
}

/** What the launch said and how it ended, at the head of the screen; `below` is the room under it, 10 above a child's handoff card. */
function SubagentFacts({ subagent: { step, agentId }, state, summary, agents, below, note }: Pick<SubagentConversationProps, 'subagent' | 'state' | 'summary' | 'agents'> & { below: number; note?: string }) {
  const driver = summary?.driver ?? launchDriver(step.subagent)
  const runtime = subagentRuntime(driver, summary?.model ?? step.subagent?.model, summary?.effort ?? step.subagent?.effort)
  // Why it ended, once that is the news: a done or running helper has nothing to explain.
  const why = state === 'running' || state === 'done' ? undefined : summary?.reason
  const starter = agents.find((agent) => agent.id === agentId)
  return (
    <View style={[styles.facts, { marginBottom: below }]}>
      <View style={styles.badges}>
        <Badge mark={<HugeiconsIcon color={colors.muted} icon={Clock01Icon} size={12} strokeWidth={1.7} />}>
          {starter === undefined ? startedAt(step.startedAt) : `${starter.name} at ${startedAt(step.startedAt)}`}
        </Badge>
        <Badge mark={driver === undefined ? undefined : <ProviderMark driver={driver} size={12} />}>
          {runtime === undefined ? (driver === undefined ? NOT_REPORTED : 'Its provider') : [runtime.model, runtime.effort].filter(Boolean).join(', ')}
        </Badge>
      </View>
      {note === undefined ? null : <Text style={styles.detail}>{note}</Text>}
      {why === undefined ? null : (
        <Fact label={state === 'failed' ? 'Why it failed' : 'Why it stopped'}><Text selectable style={styles.factText}>{why}</Text></Fact>
      )}
    </View>
  )
}

function SubagentBar({ subagent: { step }, state, summary, onOpenParent }: Pick<SubagentConversationProps, 'subagent' | 'state' | 'summary' | 'onOpenParent'>) {
  const insets = useSafeAreaInsets()
  const [now, setNow] = useState(Date.now)
  const running = state === 'running'
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [running])
  const driver = summary?.driver ?? launchDriver(step.subagent)
  const runtime = subagentRuntime(driver, summary?.model ?? step.subagent?.model, summary?.effort ?? step.subagent?.effort)
  const status = subagentBarStatus(state, {
    startedAt: summary?.startedAt ?? step.startedAt,
    endedAt: summary?.endedAt,
    asking: summary?.ask !== undefined,
  }, now)
  return (
    <>
      <EdgeScrim edge="bottom" height={insets.bottom + BAR_SPACE + spacing.lg} />
      <View pointerEvents="box-none" style={[styles.barHost, { bottom: insets.bottom + spacing.sm }]}>
        <GlassSurface fallbackStyle={styles.barFallback} radius={radius.lg} style={styles.bar}>
          <View style={styles.barText}>
            <View style={styles.barRuntime}>
              {driver === undefined ? null : <ProviderMark driver={driver} size={14} />}
              <Text numberOfLines={1} style={styles.barModel}>{runtime?.model ?? 'Subagent'}</Text>
              {runtime?.effort === undefined ? null : <Text style={styles.barMuted}>{runtime.effort}</Text>}
            </View>
            <Text accessibilityLiveRegion="polite" style={styles.barMuted}>{status}</Text>
          </View>
          <Pressable accessibilityLabel="Open parent" accessibilityRole="button" hitSlop={6} onPress={onOpenParent} style={({ pressed }) => [styles.barAction, pressed && styles.pressed]}>
            <HugeiconsIcon color={colors.text} icon={ArrowUpLeft01Icon} size={16} strokeWidth={1.8} />
            <Text style={styles.barActionText}>Open parent</Text>
          </Pressable>
        </GlassSurface>
      </View>
    </>
  )
}

type ThreadShape = Parameters<typeof rowsOf>[0]

/**
 * A subagent's conversation: its task opens it in the starter's voice, its answer
 * closes it. A Manor child's own thread and the record of a provider's helper both come
 * through here, so every level reads the same. The list reads the thread, so a streamed
 * frame renders this list and not the screen.
 */
function Conversation(props: SubagentConversationProps & { thread: ThreadShape; note?: string; top: number; bottom: number }) {
  const { thread, note, agents, connected, onOpenChild, top, bottom, summary, subagent } = props
  const role = summary?.role ?? subagent.step.subagent?.role
  const rows = useMemo(() => rowsOf(thread), [thread])
  const last = rows.at(-1)?.key
  const covered = useScreenCovered()
  // What a row draws besides its own data: the list redraws a mounted row only when its
  // item or this changes, so the connection dropping or a newer row has to be named here.
  const rowContext = useMemo(() => ({ agents, connected, last, onOpenChild, role }), [agents, connected, last, onOpenChild, role])
  return (
    <TranscriptCovered.Provider value={covered}>
    <LegendList
      contentContainerStyle={[styles.feed, { paddingTop: top, paddingBottom: bottom }]}
      data={rows}
      estimatedItemSize={ESTIMATED_ROW}
      extraData={rowContext}
      initialScrollAtEnd
      keyExtractor={(row) => row.key}
      ListEmptyComponent={<Text style={styles.empty}>{thread.hasSnapshot ? 'Nothing in this thread yet.' : 'Loading conversation…'}</Text>}
      ListHeaderComponent={<SubagentFacts {...props} below={10} {...(note === undefined ? {} : { note })} />}
      maintainScrollAtEnd={covered ? false : { animated: false, on: { dataChange: true, itemLayout: true } }}
      maintainScrollAtEndThreshold={0.15}
      recycleItems={false}
      renderItem={({ item }) => <ChildRow agents={agents} connected={connected} latest={item.key === last} onOpenChild={onOpenChild} role={role} row={item} />}
    />
    </TranscriptCovered.Provider>
  )
}

/** A Manor-run child: its own thread is the whole history. */
function ChildConversation(props: SubagentConversationProps & { childId: string; top: number; bottom: number }) {
  const thread = useLiveThread(props.childId)
  return <Conversation {...props} thread={thread} />
}

/**
 * A helper its provider ran inside its own turn. Manor never gets that conversation, so
 * the screen is built from what the launch row holds, and says so in one line.
 */
function ProviderConversation(props: SubagentConversationProps & { top: number; bottom: number }) {
  const { subagent, state } = props
  // The launch row is rebuilt on every parent render, so the thread follows what it holds.
  const held = providerHelperKey(subagent, state)
  const subagentRef = useRef(subagent)
  subagentRef.current = subagent
  const thread = useMemo(() => providerHelperThread(subagentRef.current, state), [held, state])
  const note = 'Its provider ran this helper inside its own turn, so Manor has its brief, its steps and its result, not its conversation.'
  return <Conversation {...props} thread={thread} note={note} />
}

function ChildRow({ row, agents, connected, latest, onOpenChild, role }: { row: Row; agents: AgentConfig[]; connected: boolean; latest: boolean; onOpenChild: (toolCallId: string) => void; role: string | undefined }) {
  if (row.kind === 'turn') return <View style={styles.row}><Turn agents={agents} connected={connected} latest={latest} onOpenSubagent={onOpenChild} showSpeaker={false} turn={row} /></View>
  if (row.kind !== 'event') return null
  const { event } = row
  // The task opens the thread as a handoff card, like a Session's brief; the facts above say who started it and the card carries the role.
  if (event.type === 'user_message') return (
    <View style={styles.row}>
      {event.source === 'subagent_task'
        ? <KickoffCard agents={agents} files={event.files ?? []} images={event.images ?? []} role={role} text={messageBrief(event)} />
        : <RelayedAgentMessage agents={agents} event={event} />}
    </View>
  )
  if (event.type === 'system_note') return <Text style={[styles.note, event.kind === 'error' && styles.error]}>{event.text}</Text>
  return null
}

const styles = StyleSheet.create({
  feed: { paddingHorizontal: spacing.lg },
  row: { paddingBottom: spacing.xl },
  note: { paddingBottom: spacing.xl, color: colors.muted, fontFamily: fonts.sans, fontSize: 13, lineHeight: 19, textAlign: 'center' },
  error: { color: colors.danger },
  empty: { paddingVertical: spacing.xl, color: colors.muted, fontFamily: fonts.sans, fontSize: 14, textAlign: 'center' },
  facts: { gap: 6 },
  // The when and the on-what, as the read-only chips a role badge uses.
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  fact: { flexDirection: 'row', gap: spacing.md },
  factLabel: { width: 92, color: colors.dim, fontFamily: fonts.sans, fontSize: 13, lineHeight: 19 },
  factValue: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 6 },
  factText: { flexShrink: 1, color: colors.muted, fontFamily: fonts.sans, fontSize: 13, lineHeight: 19 },
  detail: { color: colors.muted, fontFamily: fonts.sans, fontSize: 14, lineHeight: 20 },
  barHost: { position: 'absolute', right: spacing.lg, left: spacing.lg, zIndex: 1 },
  barFallback: { backgroundColor: colors.surface, borderRadius: radius.lg, ...squircle },
  bar: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 60, paddingVertical: spacing.sm, paddingRight: spacing.sm, paddingLeft: spacing.lg },
  barText: { flex: 1, minWidth: 0, gap: 2 },
  barRuntime: { minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 6 },
  barModel: { flexShrink: 1, color: colors.text, fontFamily: fonts.sansMedium, fontSize: 15 },
  barMuted: { color: colors.muted, fontFamily: fonts.sans, fontSize: 13, lineHeight: 18 },
  barAction: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: spacing.xs, paddingHorizontal: spacing.sm },
  barActionText: { color: colors.text, fontFamily: fonts.sans, fontSize: 14 },
  pressed: { opacity: 0.7 },
})
