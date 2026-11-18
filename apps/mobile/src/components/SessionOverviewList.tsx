import AlertCircleIcon from '@hugeicons/core-free-icons/AlertCircleIcon'
import ArrowDown01Icon from '@hugeicons/core-free-icons/ArrowDown01Icon'
import CircleCheckIcon from '@hugeicons/core-free-icons/CircleCheckIcon'
import HourglassIcon from '@hugeicons/core-free-icons/HourglassIcon'
import Progress03Icon from '@hugeicons/core-free-icons/Progress03Icon'
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react-native'
import type { AgentConfig } from '@manor/contracts'
import type { SessionOverview, SessionOverviewGroup, SessionOverviewRow } from '@manor/client-runtime/state'
import { useEffect, useSyncExternalStore } from 'react'
import { QUIET_PAGE_SIZE, readSessionOverviewUI, subscribeSessionOverviewUI, updateSessionOverviewUI } from '@manor/client-runtime/session-overview-ui'
import { Pressable, ScrollView, StyleSheet, View, type ColorValue } from 'react-native'

import { DisclosureChevron } from '@/components/DisclosureChevron'
import { PlanRing } from '@/components/PlanRing'
import { SessionMark } from '@/components/SessionMark'
import { Text } from '@/components/Text'
import { colors, fonts, radius, spacing, squircle } from '@/theme'

/** Project thread states use the same English labels and marks as the Mac; a fold with no rows drops to dim, and Waiting shows only with rows. */
const GROUPS: { id: SessionOverviewGroup; label: string; hint: string; icon: IconSvgElement; tone: ColorValue }[] = [
  { id: 'waiting', label: 'Needs you', hint: 'Proposals, questions, reviews and results to confirm.', icon: AlertCircleIcon, tone: colors.warning },
  { id: 'working', label: 'Working', hint: 'Sessions with a turn running.', icon: Progress03Icon, tone: colors.busy },
  { id: 'background', label: 'Waiting', hint: 'Sessions waiting on background work they started.', icon: HourglassIcon, tone: colors.muted },
  { id: 'settled', label: 'Settled', hint: 'Settled sessions.', icon: CircleCheckIcon, tone: colors.dim },
]

/**
 * A project thread's Sessions on the phone, grouped as the Mac's overview beside the
 * thread (2026-10-11), with the fold state they share. A tap opens the Session as its
 * own screen; Settled starts folded on every visit.
 */
export function SessionOverviewList({ threadId, overview, agents, inset, onOpen, onRevealProposal }: {
  threadId: string
  /** Room for the header floating above the list and the tab bar below it. */
  inset: { top: number; bottom: number }
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
  const row = (entry: SessionOverviewRow, quiet: boolean, working = false) => {
    const plan = working ? entry.chat?.planProgress : undefined
    return (
      <Pressable
        key={entry.key}
        accessibilityLabel={entry.chat === null ? `Show proposal ${entry.title}` : `Open ${entry.title}`}
        accessibilityRole="button"
        accessibilityValue={plan === undefined ? undefined : { text: `${plan.done} of ${plan.total} tasks done` }}
        onPress={() => (entry.chat === null ? onRevealProposal(entry.key) : onOpen(entry.chat.id))}
        style={({ pressed }) => [styles.item, pressed && styles.pressed]}
      >
        <View style={styles.titleRow}>
          <Text numberOfLines={1} style={[styles.title, quiet && styles.quietTitle]}>{entry.title}</Text>
          {/* A working Session's tasks progress, the count its card shows; nothing before it has a card. */}
          {plan === undefined ? null : (
            <View style={styles.plan}>
              <PlanRing done={plan.done} fill={colors.busy} size={14} total={plan.total} track={colors.line} />
              <Text style={styles.planCount}>{plan.done}/{plan.total}</Text>
            </View>
          )}
        </View>
        {/* The runtime mark ends the line, where the Mac's overview puts it. */}
        <View style={styles.lineRow}>
          {entry.line === '' ? null : <Text numberOfLines={1} style={styles.line}>{entry.line}</Text>}
          {entry.chat === null ? null : <SessionMark agents={agents} chat={entry.chat} />}
        </View>
      </Pressable>
    )
  }

  return (
    <ScrollView
      contentContainerStyle={[styles.content, { paddingTop: inset.top, paddingBottom: inset.bottom }]}
      scrollIndicatorInsets={inset}
    >
      {GROUPS.map(({ id, label, hint, icon, tone }) => id === 'background' && overview[id].length === 0 ? null : (
        <View key={id} style={styles.group}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: unfolded[id] }}
            hitSlop={6}
            onPress={() => updateSessionOverviewUI(threadId, (current) => ({ ...current, open: { ...current.open, [id]: !current.open[id] } }))}
            style={styles.foldHeader}
          >
            {/* The Mac's resting fill is surface-2 at half strength; a dynamic colour cannot be
                mixed at use time, so the full fill sits behind at half opacity and goes whole on press. */}
            {({ pressed }) => (
              <>
                <View style={[styles.foldFill, pressed && styles.foldFillPressed]} />
                <HugeiconsIcon color={overview[id].length === 0 ? colors.dim : tone} icon={icon} size={16} strokeWidth={1.7} />
                <Text numberOfLines={1} style={styles.foldLabel}>{label}</Text>
                <Text style={styles.foldCount}>{overview[id].length}</Text>
                <DisclosureChevron open={unfolded[id]}>
                  <HugeiconsIcon color={colors.dim} icon={ArrowDown01Icon} size={16} strokeWidth={1.7} />
                </DisclosureChevron>
              </>
            )}
          </Pressable>
          {!unfolded[id] ? null
            : overview[id].length === 0 ? <Text style={styles.empty}>{hint}</Text>
            : (id === 'settled' ? shownSettled : overview[id]).map((entry) => row(entry, id === 'settled', id === 'working'))}
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
  content: { gap: spacing.sm, paddingHorizontal: spacing.lg },
  item: { gap: 2, borderRadius: radius.md, ...squircle, backgroundColor: colors.sheetSurface, paddingHorizontal: spacing.md, paddingVertical: spacing.md },
  pressed: { opacity: 0.7 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  title: { flex: 1, color: colors.text, fontFamily: fonts.sans, fontSize: 15, lineHeight: 20 },
  quietTitle: { color: colors.muted },
  plan: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  planCount: { color: colors.muted, fontFamily: fonts.sans, fontSize: 12, lineHeight: 16, fontVariant: ['tabular-nums'] },
  lineRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: spacing.sm },
  line: { flex: 1, color: colors.dim, fontFamily: fonts.sans, fontSize: 13, lineHeight: 18 },
  group: { gap: spacing.sm },
  empty: { color: colors.dim, fontFamily: fonts.sans, fontSize: 14, paddingBottom: spacing.sm },
  foldHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 44, paddingHorizontal: spacing.md },
  foldFill: { ...StyleSheet.absoluteFill, borderRadius: radius.md, ...squircle, backgroundColor: colors.surface2, opacity: 0.5 },
  foldFillPressed: { opacity: 1 },
  foldLabel: { flexShrink: 1, color: colors.dim, fontFamily: fonts.sans, fontSize: 13, fontWeight: '500' },
  foldCount: { flex: 1, color: colors.dim, fontFamily: fonts.sans, fontSize: 12, fontVariant: ['tabular-nums'] },
})
