import { useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated'
import type { AgentConfig } from '@manor/contracts'
import { acceptWorkProposal } from '@manor/client-runtime/work-proposals'
import { WORK_RESULT_CONNECTION_LOST, openWorkDecisions, workConfirmTitle, workResultActionLabels, type Row, type WorkHandoffRow, type WorkResult } from '@manor/client-runtime/state'
import { useWorkProposal } from '@/lib/useWorkProposal'
import { useWorkspaceActions, useWorkspaceStatus } from '@/providers/WorkspaceProvider'
import { colors, fonts, radius, spacing, squircle } from '@/theme'
import { FadingScrollView } from './FadingScrollView'
import { Text } from './Text'
import { openWorkChangesFromBar, type RevealPlace } from './WorkResultBody'

const ROW_HEIGHT = 48
/** Three rows show; the top of a fourth peeks in under the cut, which says the list scrolls. */
const MAX_HEIGHT = ROW_HEIGHT * 3 + ROW_HEIGHT / 2 + spacing.xs * 2
// Rows come and go as their cards scroll past, so the fade stays short and quiet.
// Reanimated skips it under the system's reduced motion setting.
const FADE_IN = FadeIn.duration(200)
const FADE_OUT = FadeOut.duration(160)

/**
 * The Session cards in this thread that wait on the user and are out of view, one row each
 * above the composer, the phone copy of the Mac bar. A row carries its card's two
 * actions under the card's labels; the rest of the row scrolls to the card. Gone when
 * every open card is in view, and until the thread has said which ones are (`inView` null).
 */
export function WorkDecisionDock({ rows, inView, agents, onReject, onReveal }: {
  rows: readonly Row[]
  inView: ReadonlySet<string> | null
  agents: AgentConfig[]
  onReject: (handoffId: string) => void
  onReveal: (rowKey: string, place?: RevealPlace) => void
}) {
  const open = inView === null ? [] : openWorkDecisions(rows, inView)
  if (open.length === 0) return null
  return (
    <Animated.View entering={FADE_IN} exiting={FADE_OUT} style={styles.dock}>
      {/* A solid card with a rim (2026-10-12): glass on the light canvas left
          Accept and Confirm too faint to find. */}
      <View style={styles.card}>
        <FadingScrollView
          accessibilityLabel="Needs you"
          keyboardShouldPersistTaps="handled"
          style={{ maxHeight: MAX_HEIGHT }}
          contentContainerStyle={styles.list}
        >
          {open.map((decision) => (
            <Animated.View key={decision.row.key} entering={FADE_IN} exiting={FADE_OUT}>
              {decision.kind === 'proposal'
                ? <ProposalRow row={decision.row} agents={agents} onReject={onReject} onReveal={onReveal} />
                : <ResultRow row={decision.row} result={decision.row.report!} onReveal={onReveal} />}
            </Animated.View>
          ))}
        </FadingScrollView>
      </View>
    </Animated.View>
  )
}

function ProposalRow({ row, agents, onReject, onReveal }: {
  row: WorkHandoffRow
  agents: AgentConfig[]
  onReject: (handoffId: string) => void
  onReveal: (rowKey: string, place?: RevealPlace) => void
}) {
  const { acceptWorkHandoff } = useWorkspaceActions()
  const proposal = useWorkProposal(row, agents)
  return (
    <DecisionRow
      kind="Proposal"
      row={row}
      error={proposal.error}
      onReveal={onReveal}
      secondary={{ label: 'Reject', disabled: proposal.accepting, onPress: () => onReject(row.handoffId) }}
      primary={{
        label: proposal.accepting ? 'Accepting…' : 'Accept',
        action: 'Accept',
        busy: proposal.accepting,
        disabled: proposal.accepting,
        onPress: () => void acceptWorkProposal(row, agents, acceptWorkHandoff),
      }}
    />
  )
}

function ResultRow({ row, result, onReveal }: { row: WorkHandoffRow; result: WorkResult; onReveal: (rowKey: string, place?: RevealPlace) => void }) {
  const { acceptWorkResult, askCheckoutStatus } = useWorkspaceActions()
  const connected = useWorkspaceStatus() === 'live'
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const sessionId = result.workChatId

  // The card asks for this too, but it may sit in history that is not rendered yet.
  useEffect(() => {
    if (result.worktree && result.mergeInto === undefined && sessionId !== null) askCheckoutStatus(sessionId)
  }, [result.worktree, result.mergeInto, sessionId, askCheckoutStatus])

  useEffect(() => {
    if (connected) setError((current) => current === WORK_RESULT_CONNECTION_LOST ? null : current)
  }, [connected])

  const confirm = async () => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      await acceptWorkResult(result.handoffId, result.mergeInto, result.version)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That did not go through. Try again.')
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const confirmHint = workConfirmTitle(result)
  const labels = workResultActionLabels(result)
  return (
    <DecisionRow
      kind="Ready"
      row={row}
      error={error}
      onReveal={onReveal}
      secondary={{
        label: labels.secondary,
        disabled: busy || !connected,
        // What to change is written on the card: open its field there and bring the card in.
        onPress: () => openWorkChangesFromBar(result.handoffId, (place) => onReveal(row.key, place)),
      }}
      primary={{
        label: busy ? labels.pending : labels.primary,
        action: labels.primary,
        busy,
        disabled: busy || !connected,
        ...(confirmHint === undefined ? {} : { hint: confirmHint }),
        onPress: () => void confirm(),
      }}
    />
  )
}

interface RowAction {
  label: string
  disabled: boolean
  onPress: () => void
}

function DecisionRow({ kind, row, error, onReveal, secondary, primary }: {
  kind: 'Proposal' | 'Ready'
  row: WorkHandoffRow
  error: string | null
  onReveal: (rowKey: string, place?: RevealPlace) => void
  secondary: RowAction
  /** `action` names the decision for VoiceOver while the label says it is underway. */
  primary: RowAction & { action: string; busy: boolean; hint?: string }
}) {
  return (
    <View style={styles.row}>
      <Pressable
        accessibilityRole="button"
        accessibilityHint="Shows the card in the chat"
        onPress={() => onReveal(row.key)}
        style={({ pressed }) => [styles.reveal, pressed && styles.pressed]}
      >
        <View style={styles.line}>
          <Text style={styles.kind}>{kind}</Text>
          <Text numberOfLines={1} style={styles.title}>{row.title}</Text>
        </View>
        {error === null ? null : <Text accessibilityRole="alert" numberOfLines={1} style={styles.error}>{error}</Text>}
      </Pressable>
      <Pressable
        accessibilityLabel={`${secondary.label} ${row.title}`}
        accessibilityRole="button"
        accessibilityState={{ disabled: secondary.disabled }}
        disabled={secondary.disabled}
        onPress={secondary.onPress}
        style={({ pressed }) => [styles.action, styles.secondary, secondary.disabled && styles.disabled, pressed && styles.pressed]}
      >
        <Text numberOfLines={1} style={styles.secondaryLabel}>{secondary.label}</Text>
      </Pressable>
      <Pressable
        accessibilityLabel={`${primary.action} ${row.title}`}
        {...(primary.hint === undefined ? {} : { accessibilityHint: primary.hint })}
        accessibilityRole="button"
        accessibilityState={{ disabled: primary.disabled, busy: primary.busy }}
        disabled={primary.disabled}
        onPress={primary.onPress}
        style={({ pressed }) => [styles.action, styles.primary, primary.disabled && styles.disabled, pressed && styles.pressed]}
      >
        <Text style={styles.primaryLabel}>{primary.label}</Text>
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  // No margin: the footer's top padding is the gap to the composer.
  dock: { width: '100%' },
  card: {
    overflow: 'hidden',
    borderRadius: radius.lg,
    ...squircle,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    backgroundColor: colors.raised,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.16,
    shadowRadius: 16,
    elevation: 6,
  },
  list: { paddingVertical: spacing.xs, paddingHorizontal: spacing.xs },
  row: { height: ROW_HEIGHT, flexDirection: 'row', alignItems: 'center', gap: spacing.xs, paddingRight: spacing.xs },
  reveal: { flex: 1, minWidth: 0, height: '100%', justifyContent: 'center', paddingHorizontal: spacing.sm },
  line: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm, minWidth: 0 },
  kind: { color: colors.dim, fontFamily: fonts.sans, fontSize: 12 },
  title: { flex: 1, color: colors.text, fontFamily: fonts.sans, fontSize: 15 },
  error: { color: colors.danger, fontFamily: fonts.sans, fontSize: 12 },
  // The card's own verb geometry, so the two read as one control: a quiet ghost beside
  // the filled primary.
  action: { minHeight: 34, justifyContent: 'center', borderRadius: radius.sm, ...squircle },
  secondary: { backgroundColor: 'transparent', paddingHorizontal: spacing.sm },
  primary: { backgroundColor: colors.text, paddingHorizontal: spacing.md },
  secondaryLabel: { color: colors.muted, fontFamily: fonts.sans, fontSize: 13, fontWeight: '500' },
  primaryLabel: { color: colors.onPrimary, fontFamily: fonts.sans, fontSize: 13, fontWeight: '500' },
  disabled: { opacity: 0.7 },
  pressed: { opacity: 0.7 },
})
