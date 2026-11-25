import AlertCircleIcon from '@hugeicons/core-free-icons/AlertCircleIcon'
import ArrowDown01Icon from '@hugeicons/core-free-icons/ArrowDown01Icon'
import CancelCircleIcon from '@hugeicons/core-free-icons/CancelCircleIcon'
import CheckmarkCircle02Icon from '@hugeicons/core-free-icons/CheckmarkCircle02Icon'
import { HugeiconsIcon } from '@hugeicons/react-native'
import type { SubagentSummary } from '@manor/contracts'
import type { ToolStep } from '@manor/client-runtime/state'
import { isManorSubagent, SUBAGENT_STATE_LABEL, launchDriver, subagentKindLine, subagentState, subagentStateOf, subagentTask, type ChatSubagent, type SubagentState } from '@manor/client-runtime/turn-trace'
import { useRef, useState } from 'react'
import { Platform, Pressable, StyleSheet, View, type ColorValue } from 'react-native'

import { DisclosureChevron } from '@/components/DisclosureChevron'
import { ProviderMark } from '@/components/ProviderMark'
import { ScrimScrollView } from '@/components/EdgeScrim'
import { Sheet } from '@/components/Sheet'
import { Spinner } from '@/components/TaskCard'
import { Text } from '@/components/Text'
import { colors, fonts, radius, spacing, squircle } from '@/theme'

/** The right edge of a card says where the helper stands in a glyph, not a word. */
function StateMark({ state }: { state: SubagentState }) {
  if (state === 'running') return <Spinner size={18} />
  if (state === 'done') return <HugeiconsIcon color={colors.muted} icon={CheckmarkCircle02Icon} size={18} strokeWidth={1.8} />
  if (state === 'failed') return <HugeiconsIcon color={colors.danger} icon={AlertCircleIcon} size={18} strokeWidth={1.8} />
  return <HugeiconsIcon color={colors.dim} icon={CancelCircleIcon} size={18} strokeWidth={1.8} />
}

/**
 * One helper as a card in the Agents sheet: the provider's mark, the brief, "Subagent,
 * model, effort" under it and, at the right, a spinner while it works or a check once
 * it is done.
 */
function SubagentCard({ step, state = subagentState(step), background = colors.surface, onPress }: {
  step: ToolStep
  /** Where the helper stands when the directory knows better than its launch row. */
  state?: SubagentState
  background?: ColorValue
  onPress?: () => void
}) {
  const driver = launchDriver(step.subagent)
  const task = subagentTask(step)
  const kind = subagentKindLine(step)
  const body = (
    <>
      {driver === undefined ? null : <View style={styles.mark}><ProviderMark driver={driver} size={18} /></View>}
      <View style={styles.cardText}>
        <Text numberOfLines={1} style={styles.cardTask}>{task}</Text>
        <Text numberOfLines={1} style={styles.cardKind}>{kind}</Text>
      </View>
      <View style={styles.state}><StateMark state={state} /></View>
    </>
  )
  const label = `${task}, ${kind}, ${SUBAGENT_STATE_LABEL[state]}`
  return onPress === undefined ? (
    <View accessibilityLabel={label} accessible style={[styles.card, { backgroundColor: background }]}>{body}</View>
  ) : (
    <Pressable
      accessibilityHint="Opens this subagent"
      accessibilityLabel={label}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.card, { backgroundColor: background }, pressed && styles.pressed]}
    >
      {body}
    </Pressable>
  )
}

interface Listed {
  subagent: ChatSubagent
  state: SubagentState
}

/**
 * The Agents list of one level, which is a chat or a subagent's own screen. Running ones
 * stand first and keep Stop; the finished ones, failed and stopped alike, fold under
 * Previous agents with their count. A row opens that helper's screen. In a subagent's
 * screen a first row leads up to where it came from.
 */
export function SubagentsSheet({ open, onClose, subagents, summary, onOpen, onStop }: {
  open: boolean
  onClose: () => void
  subagents: readonly ChatSubagent[]
  summary: (childId: string) => SubagentSummary | undefined
  onOpen: (toolCallId: string) => void
  /** False when the request could not be sent. */
  onStop?: (toolCallId: string) => boolean
}) {
  const [stopping, setStopping] = useState<Set<string>>(() => new Set())
  const [previousOpen, setPreviousOpen] = useState(false)
  // Another screen cannot be pushed under a sheet iOS still presents, so the way on waits for it to go.
  const after = useRef<(() => void) | null>(null)
  const listed = subagents.map((subagent): Listed => ({ subagent, state: subagentStateOf(subagent, summary) }))
  const running = listed.filter((row) => row.state === 'running')
  const previous = listed.filter((row) => row.state !== 'running')
  const failed = previous.filter((row) => row.state === 'failed').length
  const stop = (toolCallId: string) => {
    if (onStop?.(toolCallId)) setStopping((current) => new Set(current).add(toolCallId))
  }
  const leave = (go: () => void) => {
    if (Platform.OS === 'ios') after.current = go
    onClose()
    if (Platform.OS !== 'ios') go()
  }
  const row = ({ subagent, state }: Listed) => {
    const { step } = subagent
    const callId = step.toolCallId
    const stoppable = state === 'running' && callId !== undefined && isManorSubagent(step) && onStop !== undefined
    return (
      <View key={step.key} style={styles.item}>
        <View style={styles.cardSlot}>
          <SubagentCard
            background={colors.sheetSurface}
            state={state}
            step={step}
            {...(callId === undefined ? {} : { onPress: () => leave(() => onOpen(callId)) })}
          />
        </View>
        {stoppable ? (
          <Pressable
            accessibilityLabel={`Stop subagent ${subagentTask(step)}`}
            accessibilityRole="button"
            disabled={stopping.has(callId)}
            onPress={() => stop(callId)}
            style={styles.stopButton}
          >
            <Text style={styles.stopText}>{stopping.has(callId) ? 'Stopping' : 'Stop'}</Text>
          </Pressable>
        ) : null}
      </View>
    )
  }
  return (
    <Sheet
      onClose={onClose}
      onDismiss={() => {
        const go = after.current
        after.current = null
        go?.()
      }}
      open={open}
      subtitle={running.length === 0 ? `${subagents.length} in this chat` : `${running.length} running`}
      title="Agents"
    >
      <ScrimScrollView contentContainerStyle={styles.content}>
        {subagents.length === 0 ? <Text style={styles.empty}>No agents in this chat.</Text> : null}
        {running.map(row)}
        {previous.length === 0 ? null : (
          <>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: previousOpen }}
              onPress={() => setPreviousOpen((value) => !value)}
              style={({ pressed }) => [styles.previousHeader, pressed && styles.pressed]}
            >
              <DisclosureChevron open={previousOpen}>
                <HugeiconsIcon color={colors.dim} icon={ArrowDown01Icon} size={16} strokeWidth={1.8} />
              </DisclosureChevron>
              <Text style={styles.previousLabel}>Previous agents</Text>
              {failed === 0 ? null : <Text style={styles.failedCount}>{failed} failed</Text>}
              {previousOpen ? null : <Text style={styles.previousCount}>{previous.length}</Text>}
            </Pressable>
            {previousOpen ? previous.map(row) : null}
          </>
        )}
      </ScrimScrollView>
    </Sheet>
  )
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderRadius: radius.md,
    ...squircle,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    paddingHorizontal: spacing.md + 2,
    paddingVertical: spacing.md,
  },
  pressed: { opacity: 0.7 },
  mark: { width: 20, alignItems: 'center' },
  cardText: { flex: 1, minWidth: 0, gap: 1 },
  cardTask: { color: colors.text, fontFamily: fonts.sans, fontSize: 15, lineHeight: 20 },
  cardKind: { color: colors.dim, fontFamily: fonts.sans, fontSize: 13, lineHeight: 18 },
  state: { width: 20, alignItems: 'center' },
  content: { gap: spacing.sm, paddingHorizontal: spacing.lg, paddingBottom: spacing.xl },
  item: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  cardSlot: { flex: 1, minWidth: 0 },
  empty: { color: colors.dim, fontFamily: fonts.sans, fontSize: 14, lineHeight: 20, paddingVertical: spacing.sm },
  previousHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 44, paddingHorizontal: spacing.xs },
  previousLabel: { flex: 1, color: colors.muted, fontFamily: fonts.sans, fontSize: 14 },
  failedCount: { color: colors.danger, fontFamily: fonts.sans, fontSize: 13 },
  previousCount: { color: colors.dim, fontFamily: fonts.sans, fontSize: 13 },
  stopButton: { borderRadius: radius.sm, backgroundColor: colors.surface2, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  stopText: { color: colors.text, fontFamily: fonts.sans, fontSize: 13 },
})
