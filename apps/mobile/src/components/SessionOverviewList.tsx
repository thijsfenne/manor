import ArrowDown01Icon from '@hugeicons/core-free-icons/ArrowDown01Icon'
import { HugeiconsIcon } from '@hugeicons/react-native'
import type { AgentConfig } from '@manor/contracts'
import type { SessionOverview, SessionOverviewGroup, SessionOverviewRow } from '@manor/client-runtime/state'
import { useEffect, useSyncExternalStore } from 'react'
import { QUIET_PAGE_SIZE, readSessionOverviewUI, subscribeSessionOverviewUI, updateSessionOverviewUI } from '@manor/client-runtime/session-overview-ui'
import { Pressable, ScrollView, StyleSheet, View } from 'react-native'

import { DisclosureChevron } from '@/components/DisclosureChevron'
import { SessionMark } from '@/components/SessionMark'
import { Text } from '@/components/Text'
import { colors, fonts, radius, spacing, squircle } from '@/theme'

/** Project thread states use the same English labels as the Mac. */
const GROUPS: { id: SessionOverviewGroup; label: string; hint: string }[] = [
  { id: 'waiting', label: 'Needs you', hint: 'Proposals, questions, reviews and results to confirm.' },
  { id: 'working', label: 'Working', hint: 'Sessions with a turn running.' },
  { id: 'settled', label: 'Settled', hint: 'Settled sessions.' },
]

/**
 * A project thread's Sessions on the phone, grouped as the Mac's overview beside the
 * thread (2026-10-11), with the fold state they share. A tap opens the Session as its
 * own screen; Settled starts folded on every visit.
 */
export function SessionOverviewList({ threadId, overview, agents, onOpen, onRevealProposal }: {
  threadId: string
  overview: SessionOverview
  /** Resolves a Multiple session's faces, the way the home list does. */
  agents: AgentConfig[]
  onOpen: (chatId: string) => void
  /** Goes to a proposal's card in the thread, where its Accept is. */
  onRevealProposal: (rowKey: string) => void
}) {
  const read = () => readSessionOverviewUI(threadId)
  // Settled folds again when the overview closes, so each visit from the thread starts on
  // what is live. A Session pushed over the overview keeps it mounted, and its unfold.
  useEffect(() => () => updateSessionOverviewUI(threadId, (current) => ({ ...current, open: { ...current.open, settled: false } })), [threadId])
  const { open: unfolded, visibleSettled } = useSyncExternalStore(subscribeSessionOverviewUI, read, read)
  const shownSettled = overview.settled.slice(0, visibleSettled)
  const moreSettled = overview.settled.length - shownSettled.length
  const row = (entry: SessionOverviewRow, quiet: boolean) => (
    <Pressable
      key={entry.key}
      accessibilityLabel={entry.chat === null ? `Show proposal ${entry.title}` : `Open ${entry.title}`}
      accessibilityRole="button"
      onPress={() => (entry.chat === null ? onRevealProposal(entry.key) : onOpen(entry.chat.id))}
      style={({ pressed }) => [styles.item, pressed && styles.pressed]}
    >
      <View style={styles.titleRow}>
        <Text numberOfLines={1} style={[styles.title, quiet && styles.quietTitle]}>{entry.title}</Text>
      </View>
      {/* The runtime mark ends the line, where the Mac's overview puts it. */}
      <View style={styles.lineRow}>
        {entry.line === '' ? null : <Text numberOfLines={1} style={styles.line}>{entry.line}</Text>}
        {entry.chat === null ? null : <SessionMark agents={agents} chat={entry.chat} />}
      </View>
    </Pressable>
  )

  return (
    <ScrollView contentContainerStyle={styles.content}>
      {GROUPS.map(({ id, label, hint }) => (
        <View key={id} style={styles.group}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: unfolded[id] }}
            hitSlop={6}
            onPress={() => updateSessionOverviewUI(threadId, (current) => ({ ...current, open: { ...current.open, [id]: !current.open[id] } }))}
            style={({ pressed }) => [styles.foldHeader, pressed && styles.pressed]}
          >
            <DisclosureChevron open={unfolded[id]}>
              <HugeiconsIcon color={colors.dim} icon={ArrowDown01Icon} size={16} strokeWidth={1.7} />
            </DisclosureChevron>
            <Text style={styles.foldLabel}>{label}</Text>
            <Text style={styles.foldCount}>{overview[id].length}</Text>
          </Pressable>
          {!unfolded[id] ? null
            : overview[id].length === 0 ? <Text style={styles.empty}>{hint}</Text>
            : (id === 'settled' ? shownSettled : overview[id]).map((entry) => row(entry, id === 'settled'))}
          {id !== 'settled' || !unfolded[id] || moreSettled <= 0 ? null : (
            <Pressable
              accessibilityRole="button"
              onPress={() => updateSessionOverviewUI(threadId, (current) => ({ ...current, visibleSettled: current.visibleSettled + QUIET_PAGE_SIZE }))}
              style={({ pressed }) => [styles.item, pressed && styles.pressed]}
            >
              <Text style={styles.line}>Show {Math.min(QUIET_PAGE_SIZE, moreSettled)} more</Text>
            </Pressable>
          )}
        </View>
      ))}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  content: { gap: spacing.sm, paddingHorizontal: spacing.lg, paddingTop: spacing.xs, paddingBottom: spacing.xl },
  item: { gap: 2, borderRadius: radius.md, ...squircle, backgroundColor: colors.sheetSurface, paddingHorizontal: spacing.md, paddingVertical: spacing.md },
  pressed: { opacity: 0.7 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  title: { flex: 1, color: colors.text, fontFamily: fonts.sans, fontSize: 15, lineHeight: 20 },
  quietTitle: { color: colors.muted },
  lineRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: spacing.sm },
  line: { flex: 1, color: colors.dim, fontFamily: fonts.sans, fontSize: 13, lineHeight: 18 },
  group: { gap: spacing.sm },
  empty: { color: colors.dim, fontFamily: fonts.sans, fontSize: 14, paddingBottom: spacing.sm },
  foldHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, minHeight: 44 },
  foldLabel: { flex: 1, color: colors.dim, fontFamily: fonts.sans, fontSize: 13, fontWeight: '500' },
  foldCount: { color: colors.dim, fontFamily: fonts.sans, fontSize: 13 },
})
