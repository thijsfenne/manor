import { useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated'
import type { AgentConfig } from '@manor/contracts'
import { acceptWorkProposal } from '@manor/client-runtime/work-proposals'
import { WORK_RESULT_CONNECTION_LOST, openWorkDecisions, workConfirmTitle, workResultActionLabels, type Row, type WorkHandoffRow, type WorkResult } from '@manor/client-runtime/state'
import { useWorkProposal } from '@/lib/useWorkProposal'
import { useWorkspaceActions, useWorkspaceStatus } from '@/providers/WorkspaceProvider'
import { glassRise, glassSink } from '@/lib/glassMotion'
import { colors, fonts, radius, spacing } from '@/theme'
import { CardButton } from './CardButton'
import { FadingScrollView } from './FadingScrollView'
import { GlassSurface } from './GlassSurface'
import { Text } from './Text'

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
export function WorkDecisionDock({ rows, inView, agents, onReject, onReveal, onRequestChanges }: {
  rows: readonly Row[]
  inView: ReadonlySet<string> | null
  agents: AgentConfig[]
  onReject: (handoffId: string) => void
  onReveal: (rowKey: string) => void
  /** What to change is written on the card, which comes into the composer's place to take it. */
  onRequestChanges: (row: WorkHandoffRow) => void
}) {
  const open = inView === null ? [] : openWorkDecisions(rows, inView)
  if (open.length === 0) return null
  return (
    // Rises rather than fades: an opacity ancestor turns the glass flat for good.
    <Animated.View entering={glassRise} exiting={glassSink} style={styles.dock}>
      {/* Glass like the cards it pins (2026-11-17). Accept and Confirm are tinted glass
          (2026-11-18, reversing the solid fill of 2026-10-12), so they stay the clear
          decision on the light canvas. */}
      <GlassSurface radius={radius.panel} fallbackStyle={styles.fallback}>
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
                : <ResultRow row={decision.row} result={decision.row.report!} onReveal={onReveal} onRequestChanges={onRequestChanges} />}
            </Animated.View>
          ))}
        </FadingScrollView>
      </GlassSurface>
    </Animated.View>
  )
}

function ProposalRow({ row, agents, onReject, onReveal }: {
  row: WorkHandoffRow
  agents: AgentConfig[]
  onReject: (handoffId: string) => void
  onReveal: (rowKey: string) => void
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

function ResultRow({ row, result, onReveal, onRequestChanges }: {
  row: WorkHandoffRow
  result: WorkResult
  onReveal: (rowKey: string) => void
  onRequestChanges: (row: WorkHandoffRow) => void
}) {
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
        onPress: () => onRequestChanges(row),
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
  onReveal: (rowKey: string) => void
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
      <CardButton
        label={secondary.label}
        variant="quiet"
        accessibilityLabel={`${secondary.label} ${row.title}`}
        disabled={secondary.disabled}
        onPress={secondary.onPress}
      />
      <CardButton
        label={primary.label}
        variant="primary"
        accessibilityLabel={`${primary.action} ${row.title}`}
        {...(primary.hint === undefined ? {} : { accessibilityHint: primary.hint })}
        disabled={primary.disabled}
        busy={primary.busy}
        onPress={primary.onPress}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  // No margin: the footer's top padding is the gap to the composer.
  dock: { width: '100%' },
  // Where glass is missing: the solid raised card with a rim and a floating shadow.
  fallback: {
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
  pressed: { opacity: 0.7 },
})
