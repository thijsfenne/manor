import ArrowRight01Icon from '@hugeicons/core-free-icons/ArrowRight01Icon'
import { HugeiconsIcon } from '@hugeicons/react-native'
import type { ToolStep, TurnActivity } from '@manor/client-runtime/state'
import { wakeLine } from '@manor/client-runtime/turn-labels'
import { WAKE_NOTICE, launchDriver, subagentElapsed, subagentRowModel, subagentSteps, subagentStepState, type SubagentRowModel, type SubagentState } from '@manor/client-runtime/turn-trace'
import type { WakeItem } from '@manor/contracts'
import { useEffect, useState } from 'react'
import { Pressable, StyleSheet, View, type ColorValue } from 'react-native'

import { ProviderMark } from '@/components/ProviderMark'
import { ShimmerText } from '@/components/ShimmerText'
import { Text } from '@/components/Text'
import { useSubagentDirectory, useSubagentLaunches } from '@/lib/subagentContext'
import { colors, fonts, radius, spacing, squircle } from '@/theme'

const DOT: Record<SubagentState, ColorValue> = {
  running: colors.text,
  done: colors.ok,
  failed: colors.danger,
  stopped: colors.dim,
}

/** A wake's word on how a helper ended and when, which the row shows in place of its live state. */
interface Notice {
  state: SubagentState
  label: string
  time: string
}

const clock = (ts: number) => new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })

/** A clock that ticks each second only while something runs. */
function useNow(running: boolean): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [running])
  return now
}

/**
 * One helper as a row of the parent's timeline, the Mac's row in the phone's sizes: the
 * provider's mark in a round face with a status dot, its brief over what it does now or
 * what it answered, then its status, its time and a chevron where it opens.
 */
export function SubagentRow({ step, row, notice, onPress }: {
  step: ToolStep
  row: SubagentRowModel
  notice?: Notice
  onPress?: () => void
}) {
  const state = notice?.state ?? row.state
  const status = notice?.label ?? row.status
  const running = notice === undefined && row.state === 'running'
  const now = useNow(running)
  const time = notice?.time ?? subagentElapsed(row, now)
  const driver = launchDriver(step.subagent)
  const tone = state === 'failed' ? styles.danger : undefined
  // The status word stands beside the detail only where it adds something: a notice,
  // or a helper not simply done. Without a detail it takes the detail's line.
  const sideStatus = row.detail !== undefined && (notice !== undefined || state !== 'done')
  const statusText = running
    ? <ShimmerText numberOfLines={1} style={styles.meta} text={status} />
    : <Text numberOfLines={1} style={[styles.meta, tone]}>{status}</Text>
  const body = (
    <>
      <View style={styles.avatar}>
        {driver === undefined ? null : <ProviderMark driver={driver} size={13} />}
        <View style={[styles.dot, { backgroundColor: DOT[state] }]} />
      </View>
      <View style={styles.text}>
        <Text numberOfLines={1} style={styles.title}>{row.title}</Text>
        {row.detail === undefined ? statusText : <Text numberOfLines={1} style={[styles.meta, tone]}>{row.detail}</Text>}
      </View>
      {sideStatus ? <View style={styles.side}>{statusText}</View> : null}
      {time === undefined ? null : <Text style={styles.time}>{time}</Text>}
      {onPress === undefined ? null : <HugeiconsIcon color={colors.dim} icon={ArrowRight01Icon} size={16} strokeWidth={1.7} />}
    </>
  )
  const label = [row.title, status, row.detail, row.kind].filter(Boolean).join(', ')
  return onPress === undefined ? (
    <View accessibilityLabel={label} accessible style={styles.row}>{body}</View>
  ) : (
    <Pressable
      accessibilityHint="Opens this subagent"
      accessibilityLabel={label}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      {body}
    </Pressable>
  )
}

/**
 * The helpers one run of work started, a row each. They stand in the turn while it
 * runs and while any of them still works after it, which only a Manor child does.
 */
export function SubagentRows({ agents, activities, running, onOpen }: {
  agents: readonly ToolStep[]
  /** The turn's whole record, which is where each helper's own steps are. */
  activities: readonly TurnActivity[]
  /** The turn that launched them still goes. */
  running: boolean
  onOpen: ((toolCallId: string) => void) | undefined
}) {
  const directory = useSubagentDirectory()
  return (
    <View style={styles.rows}>
      {agents.map((step) => {
        const childId = step.subagent?.childChatId
        const summary = childId === undefined ? undefined : directory?.(childId)
        const row = subagentRowModel(step, subagentSteps(activities, step), subagentStepState(step, running, directory), summary)
        const callId = step.toolCallId
        return <SubagentRow key={step.key} row={row} step={step} {...(onOpen === undefined || callId === undefined ? {} : { onPress: () => onOpen(callId) })} />
      })}
    </View>
  )
}

/**
 * A wake's line, with each helper it reports on as a notice row that opens it. Background
 * commands and helpers this chat did not launch keep the compact line.
 */
export function WakeNotices({ items, ts }: { items: readonly WakeItem[]; ts: number }) {
  const launches = useSubagentLaunches()
  const directory = useSubagentDirectory()
  const known = items.flatMap((item) => {
    const launch = launches?.byCallId.get(item.toolCallId)
    return launch === undefined ? [] : [{ item, launch }]
  })
  const rest = items.filter((item) => !known.some((entry) => entry.item === item))
  if (known.length === 0) return <Text style={styles.wake}>{wakeLine(items)}</Text>
  const open = launches?.open
  return (
    <View style={styles.rows}>
      {known.map(({ item, launch }) => {
        const childId = launch.step.subagent?.childChatId
        const summary = childId === undefined ? undefined : directory?.(childId)
        const notice = WAKE_NOTICE[item.state]
        return (
          <SubagentRow
            key={item.toolCallId}
            notice={{ ...notice, time: clock(ts) }}
            row={subagentRowModel(launch.step, launch.steps, notice.state, summary)}
            step={launch.step}
            {...(open === undefined ? {} : { onPress: () => open(item.toolCallId) })}
          />
        )
      })}
      {rest.length === 0 ? null : <Text style={styles.wake}>{wakeLine(rest)}</Text>}
    </View>
  )
}

const styles = StyleSheet.create({
  rows: { gap: spacing.sm },
  // A card per helper, as wide as the chat, a little tighter above and below than at the sides.
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 44,
    borderRadius: radius.lg,
    ...squircle,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  pressed: { opacity: 0.7 },
  avatar: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    backgroundColor: colors.fill,
  },
  dot: { position: 'absolute', right: -1, bottom: -1, width: 9, height: 9, borderRadius: 4.5, borderWidth: 2, borderColor: colors.surface },
  text: { flex: 1, minWidth: 0, gap: 1 },
  title: { color: colors.text, fontFamily: fonts.sansMedium, fontSize: 14, lineHeight: 19 },
  meta: { color: colors.dim, fontFamily: fonts.sans, fontSize: 13, lineHeight: 18 },
  danger: { color: colors.danger },
  side: { flexShrink: 0, maxWidth: 96 },
  time: { flexShrink: 0, color: colors.dim, fontFamily: fonts.sans, fontSize: 13, fontVariant: ['tabular-nums'] },
  wake: { color: colors.muted, fontFamily: fonts.sans, fontSize: 13, lineHeight: 19, textAlign: 'center' },
})
