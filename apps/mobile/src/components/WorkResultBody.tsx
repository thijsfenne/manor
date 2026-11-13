import { AlertCircleIcon, CheckmarkCircle02Icon, Tick02Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react-native'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Pressable, StyleSheet, TextInput, View, type ColorValue } from 'react-native'
import Animated, { FadeIn } from 'react-native-reanimated'
import { readWorkChangesOpen, setWorkChangesOpen, subscribeWorkProposals } from '@manor/client-runtime/work-proposals'
import type { GoalChoice } from '@manor/contracts'
import { WORK_RESULT_CONNECTION_LOST, evidenceThumbnailRatio, workBlockedReason, workCardStatus, workConfirmTitle, pickWorkChoice, workChoicePicked, workResultActionLabels, workResultChoiceList, workResultFiles, workResultLines, type WorkHandoffRow, type WorkResult, type WorkStatus } from '@manor/client-runtime/state'
import { useWorkspaceActions, useWorkspaceStatus } from '@/providers/WorkspaceProvider'
import { colors, fonts, radius, spacing, squircle } from '@/theme'
import { AttachmentThumbnail, ImageViewer } from './Attachments'
import { MergeFixPanel } from './MergeFixPanel'
import { Text } from './Text'

export const WORK_STATUS_TONE: Record<WorkStatus['tone'], ColorValue> = { busy: colors.busy, ready: colors.text, ok: colors.ok, warn: colors.warning, waiting: colors.warning, dim: colors.dim }

/** The dot or check in front of a state word; a landed commit gets the check. */
export function WorkStatusMark({ status }: { status: WorkStatus }) {
  if (status.tone === 'ok' && status.text !== 'Settled') return <HugeiconsIcon color={WORK_STATUS_TONE.ok} icon={CheckmarkCircle02Icon} size={14} strokeWidth={1.8} />
  if (status.tone === 'dim') return null
  return <View style={[styles.dot, { backgroundColor: WORK_STATUS_TONE[status.tone] }]} />
}

/**
 * The one status in an assignment card's header, swapping in place as the Session moves
 * on; Merge blocked or Commit blocked takes the same place when Git does not show it landing.
 */
export function WorkCardStatusLabel({ row }: { row: WorkHandoffRow }) {
  const status = workCardStatus(row)
  if (status === null) return null
  return (
    <Animated.View key={status.text} entering={FadeIn.duration(150)} style={styles.status}>
      <WorkStatusMark status={status} />
      <Text style={[styles.statusLabel, { color: WORK_STATUS_TONE[status.tone] }]}>{status.text}</Text>
    </Animated.View>
  )
}

/**
 * What came of the Session (2026-11-07): at most three short lines, each behind a tick,
 * then the limitation, muted, behind its own mark. The Mac's lines, the same fallback for
 * a report from before points.
 */
function ResultLines({ result, settled }: { result: WorkResult; settled: boolean }) {
  const lines = workResultLines(result)
  return (
    <View style={styles.lines}>
      {lines.map((line, index) => (
        <View key={index} style={styles.line}>
          <HugeiconsIcon color={colors.muted} icon={Tick02Icon} size={15} strokeWidth={1.8} style={styles.lineIcon} />
          <Text selectable style={[styles.result, styles.lineText, settled && styles.mutedText]}>{line}</Text>
        </View>
      ))}
      {result.limitations === undefined ? null : (
        <View style={styles.line}>
          <HugeiconsIcon color={colors.dim} icon={AlertCircleIcon} size={15} strokeWidth={1.8} style={styles.lineIcon} />
          <Text numberOfLines={2} selectable style={[styles.limitation, styles.lineText]}>{result.limitations}</Text>
        </View>
      )}
    </View>
  )
}

/**
 * The decisions a report leaves to the user, under a divider: each question on one line and
 * its options as small grey buttons, the picked one in a blue wash. A tap writes the pick
 * into Follow up, which opens, so several picks go to the Session as one message.
 */
function YourCall({ result, picked, disabled, onPick }: {
  result: WorkResult
  picked: string
  disabled: boolean
  onPick: (choice: GoalChoice, option: string) => void
}) {
  const { choices, more } = workResultChoiceList(result)
  if (choices.length === 0) return null
  return (
    <View style={styles.choices}>
      {choices.map((choice) => (
        <View key={choice.title} style={styles.choice}>
          <Text numberOfLines={1} style={styles.question}>{choice.title}</Text>
          <View style={styles.options}>
            {choice.options.map((option) => {
              const recommended = option === choice.recommended
              const on = workChoicePicked(picked, choice.title, option)
              return (
                <Pressable
                  key={option}
                  accessibilityRole="button"
                  accessibilityLabel={recommended ? `${option}, recommended` : option}
                  accessibilityHint={`Adds "${choice.title}: ${option}" to Follow up, for you to send`}
                  accessibilityState={{ disabled, selected: on }}
                  disabled={disabled}
                  onPress={() => onPick(choice, option)}
                  style={({ pressed }) => [styles.option, on && styles.optionOn, disabled && styles.disabled, pressed && styles.pressed]}
                >
                  <Text numberOfLines={1} style={[styles.optionLabel, on && styles.optionLabelOn]}>{option}</Text>
                </Pressable>
              )
            })}
          </View>
        </View>
      ))}
      {more === 0 ? null : <Text style={styles.meta}>{`+${more} more in the report`}</Text>}
    </View>
  )
}

/** Where a revealed card comes to rest: centred, or with its foot at the bottom of the thread. */
export type RevealPlace = 'center' | 'end'

/** Each result's open Request changes field, so the bar can focus one already open. */
const changeFields = new Map<string, TextInput>()
/** The field the bar asked to focus, for a card that mounts only after the scroll. */
let barOpening: string | null = null
// Long enough for the list's animated scroll to land.
const SCROLL_MS = 450
// Long enough for the keyboard to finish rising and the thread to stop moving with it.
const KEYBOARD_MS = 600

/**
 * Request changes from the bar above the composer: bring the card in, then open and
 * focus its field there, and the field's focus places the card above the keyboard (see
 * `onShowCard`). The scroll goes first because the thread holds itself at its end: a
 * card growing its field, or a keyboard rising, while the thread is at its end pulls
 * it straight back there.
 */
export function openWorkChangesFromBar(handoffId: string, reveal: (place: RevealPlace) => void): void {
  reveal('center')
  setTimeout(() => {
    const field = changeFields.get(handoffId)
    if (field?.isFocused() === true) return
    if (field !== undefined) {
      field.focus()
      return
    }
    barOpening = handoffId
    setWorkChangesOpen(handoffId, true)
  }, SCROLL_MS)
}

// The Mac's thumbnail height, so a result's screenshots read the same on both.
const EVIDENCE_HEIGHT = 32

/**
 * The screenshots the lead named, small at the foot of the card: the first, and a "+N"
 * tile for the rest, so the row never outgrows the actions beside it. A tap opens the
 * phone's full-screen viewer at that picture, the tile at the first one it stands for.
 */
function EvidenceRow({ evidence }: { evidence: WorkResult['evidence'] }) {
  const [open, setOpen] = useState<number | null>(null)
  const first = evidence[0]
  if (first === undefined) return null
  const more = evidence.length - 1
  return (
    <>
      <View accessibilityLabel="Screenshots" style={styles.evidence}>
        <AttachmentThumbnail
          corner={radius.xs}
          image={first}
          onOpen={() => setOpen(0)}
          size={EVIDENCE_HEIGHT}
          top
          width={Math.round(EVIDENCE_HEIGHT * evidenceThumbnailRatio(first))}
        />
        {more === 0 ? null : (
          <Pressable
            accessibilityLabel={`Open ${more} more ${more === 1 ? 'screenshot' : 'screenshots'}`}
            accessibilityRole="button"
            onPress={() => setOpen(1)}
            style={({ pressed }) => [styles.moreTile, pressed && styles.pressed]}
          >
            <Text style={styles.moreLabel}>{`+${more}`}</Text>
          </Pressable>
        )}
      </View>
      {open === null ? null : <ImageViewer images={evidence} initialIndex={open} onClose={() => setOpen(null)} />}
    </>
  )
}

/**
 * The result part of an assignment's card on the phone, the copy of the Mac body: up to
 * three result lines and the limitation, the choices left to the user, then its screenshots
 * small beside Request changes and Confirm, whose hint says what it commits, or Follow up
 * and Close when nothing lands. Open report opens the Session at its newest message, where the report
 * stands; the phone has no scroll to an older one. The card itself opens the Session. The header carries the status; a
 * commit or merge that did not land adds its reason here, with the way into the Session.
 */
export function WorkResultBody({ result, onShowCard, blocked = false, sessionSettled = false, waits = true, onOpenSession }: {
  result: WorkResult
  /** The Session is settled: Retry waits until the user reopens it, Open Session stays. */
  sessionSettled?: boolean
  /** False while the Session works again or asks: the result is not the user's move yet. */
  waits?: boolean
  /** The header says Merge blocked or Commit blocked, so the reason belongs under it. */
  blocked?: boolean
  onOpenSession?: () => void
  /**
   * Brings this card in with its foot at the bottom of the thread. The keyboard lifts the
   * thread by its own height, which leaves a field anywhere higher under the header.
   */
  onShowCard?: () => void
}) {
  const { acceptWorkResult, reviseWorkResult, retryWorkResult, askCheckoutStatus } = useWorkspaceActions()
  const handoffId = result.handoffId
  // Shared with the bar's Request changes, which opens this field from above the composer.
  const readChanges = () => readWorkChangesOpen(handoffId)
  const changesOpen = useSyncExternalStore(subscribeWorkProposals, readChanges, readChanges)
  const setWriting = (next: boolean) => setWorkChangesOpen(handoffId, next)
  const fieldRef = useRef<TextInput | null>(null)
  const bindField = (field: TextInput | null) => {
    fieldRef.current = field
    if (field === null) changeFields.delete(handoffId)
    else changeFields.set(handoffId, field)
  }
  const [feedback, setFeedback] = useState('')
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const connected = useWorkspaceStatus() === 'live'
  const open = result.decision === 'open' && waits
  const writing = open && changesOpen
  const wasWriting = useRef(writing)
  const confirmHint = open ? workConfirmTitle(result) : undefined
  const labels = workResultActionLabels(result)
  const openReport = open && (result.operation === 'none' || result.choices !== undefined) ? onOpenSession : undefined
  const reason = blocked ? workBlockedReason(result) : undefined
  const refused = reason === undefined ? undefined : result.completion?.retryRefused
  const canRetry = reason !== undefined && refused === undefined && !sessionSettled
  const settled = result.decision === 'closed'
  const sessionId = result.workChatId

  // A worktree Session merges into its linked folders' branch; ask once so Confirm can name it.
  useEffect(() => {
    if (open && result.worktree && result.mergeInto === undefined && sessionId !== null) askCheckoutStatus(sessionId)
  }, [open, result.worktree, result.mergeInto, sessionId, askCheckoutStatus])

  // Focus when the field opens, or when the bar asked for it, never just because a card
  // that left it open scrolls back into the list.
  useEffect(() => {
    if (writing && (!wasWriting.current || barOpening === handoffId)) {
      barOpening = null
      fieldRef.current?.focus()
    }
    wasWriting.current = writing
  }, [writing, handoffId])

  // The reconnect snapshot says what happened to a lost action; the card shows that instead.
  useEffect(() => {
    if (connected) setError((current) => current === WORK_RESULT_CONNECTION_LOST ? null : current)
  }, [connected])

  const run = async (action: () => Promise<void>, after?: () => void) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      await action()
      after?.()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That did not go through. Try again.')
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }
  const text = feedback.trim()
  const files = workResultFiles(result)
  const pick = (choice: GoalChoice, option: string) => {
    setError(null)
    setFeedback((current) => pickWorkChoice(current, choice, option))
    setWriting(true)
  }

  return (
    <View style={styles.body}>
      <ResultLines result={result} settled={settled} />
      {open ? <YourCall result={result} picked={feedback} disabled={busy || !connected} onPick={pick} /> : null}
      {reason === undefined ? null : (
        <View style={styles.blocked}>
          <View style={styles.shrink}>
            <Text accessibilityRole="alert" numberOfLines={2} style={styles.limitation}>{reason}</Text>
            {refused === undefined ? null : <Text numberOfLines={2} style={styles.refused}>{refused}</Text>}
          </View>
          {onOpenSession === undefined ? null : (
            <Pressable accessibilityRole="button" onPress={onOpenSession} style={({ pressed }) => [styles.action, styles.ghost, pressed && styles.pressed]}>
              <Text style={styles.actionLabel}>Open Session</Text>
            </Pressable>
          )}
          {canRetry ? (
            <Pressable
              accessibilityRole="button"
              accessibilityHint="Runs the commit again under your Confirm"
              accessibilityState={{ disabled: busy || !connected }}
              disabled={busy || !connected}
              onPress={() => void run(() => retryWorkResult(result.handoffId))}
              style={({ pressed }) => [styles.action, styles.primary, (busy || !connected) && styles.disabled, pressed && styles.pressed]}
            >
              <Text style={[styles.actionLabel, { color: colors.onPrimary }]}>{busy ? 'Retrying…' : 'Retry'}</Text>
            </Pressable>
          ) : null}
        </View>
      )}
      <MergeFixPanel result={result} {...(onOpenSession === undefined ? {} : { onOpenSession })} />

      {result.evidence.length > 0 || (open && !writing) || files !== undefined ? (
        <View style={styles.footer}>
          <EvidenceRow evidence={result.evidence} />
          <View style={[styles.actions, styles.end, styles.trailing]}>
            {/* The phone has no diff to open, so the count is only said. */}
            {files === undefined ? null : <Text style={styles.meta}>{files}</Text>}
            {open && !writing ? (
              <>
                {openReport === undefined ? null : (
                  <Pressable accessibilityRole="button" onPress={openReport} style={({ pressed }) => [styles.action, styles.ghost, styles.leading, pressed && styles.pressed]}>
                    <Text style={styles.actionLabel}>Open report</Text>
                  </Pressable>
                )}
                <Pressable accessibilityRole="button" disabled={busy || !connected} onPress={() => { setError(null); setWriting(true) }} style={({ pressed }) => [styles.action, styles.ghost, pressed && styles.pressed]}>
                  <Text style={styles.actionLabel}>{labels.secondary}</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  {...(confirmHint === undefined ? {} : { accessibilityHint: confirmHint })}
                  disabled={busy || !connected}
                  onPress={() => void run(() => acceptWorkResult(result.handoffId, result.mergeInto, result.version))}
                  style={({ pressed }) => [styles.action, styles.primary, (busy || !connected) && styles.disabled, pressed && styles.pressed]}
                >
                  <Text style={[styles.actionLabel, { color: colors.onPrimary }]}>{busy ? labels.pending : labels.primary}</Text>
                </Pressable>
              </>
            ) : null}
          </View>
        </View>
      ) : null}
      {writing ? (
        <View style={styles.writeBox}>
          <TextInput
            ref={bindField}
            onFocus={() => {
              if (onShowCard !== undefined) setTimeout(onShowCard, KEYBOARD_MS)
            }}
            accessibilityLabel="Requested changes"
            editable={!busy && connected}
            maxLength={40_000}
            multiline
            onChangeText={setFeedback}
            placeholder="What should change?"
            placeholderTextColor={colors.dim}
            selectionColor={colors.busy}
            style={styles.input}
            textAlignVertical="top"
            value={feedback}
          />
          <View style={[styles.actions, styles.end]}>
            <Pressable accessibilityRole="button" disabled={busy} onPress={() => setWriting(false)} style={({ pressed }) => [styles.action, styles.ghost, pressed && styles.pressed]}>
              <Text style={styles.actionLabel}>Cancel</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: busy || !connected || text === '' }}
              disabled={busy || !connected || text === ''}
              onPress={() => void run(() => reviseWorkResult(result.handoffId, result.version, text), () => { setWriting(false); setFeedback('') })}
              style={({ pressed }) => [styles.action, styles.primary, (busy || !connected || text === '') && styles.disabled, pressed && styles.pressed]}
            >
              <Text style={[styles.actionLabel, { color: colors.onPrimary }]}>{busy ? 'Sending…' : 'Send to Session'}</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
      {error === null ? null : <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
    </View>
  )
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.6 },
  body: { gap: spacing.md },
  lines: { gap: spacing.xs },
  line: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  lineIcon: { marginTop: 3 },
  lineText: { flex: 1 },
  question: { color: colors.text, fontFamily: fonts.sans, fontSize: 13, lineHeight: 18 },
  choice: { gap: 6 },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  // A picked option wears the blue wash with plain text, like the Mac's.
  option: { maxWidth: '100%', minHeight: 30, justifyContent: 'center', borderRadius: radius.sm, ...squircle, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, paddingHorizontal: 10 },
  optionOn: { borderColor: colors.busy, backgroundColor: colors.busyWash },
  optionLabel: { color: colors.muted, fontFamily: fonts.sans, fontSize: 13 },
  optionLabelOn: { color: colors.text },
  footer: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'space-between', gap: spacing.sm },
  mutedText: { color: colors.muted },
  status: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 6, height: 6, borderRadius: radius.round },
  statusLabel: { fontFamily: fonts.sans, fontSize: 12 },
  result: { color: colors.text, fontFamily: fonts.sans, fontSize: 15, lineHeight: 21 },
  limitation: { color: colors.muted, fontFamily: fonts.sans, fontSize: 13, lineHeight: 18 },
  refused: { color: colors.dim, fontFamily: fonts.sans, fontSize: 12.5, lineHeight: 17 },
  meta: { color: colors.dim, fontFamily: fonts.sans, fontSize: 12, lineHeight: 17 },
  evidence: { flexDirection: 'row', flexShrink: 0, gap: 6 },
  moreTile: { width: EVIDENCE_HEIGHT, height: EVIDENCE_HEIGHT, alignItems: 'center', justifyContent: 'center', borderRadius: radius.xs, ...squircle, backgroundColor: colors.surface2 },
  moreLabel: { color: colors.muted, fontFamily: fonts.sans, fontSize: 12, fontWeight: '500', fontVariant: ['tabular-nums'] },
  choices: { gap: spacing.md, paddingTop: spacing.md, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  leading: { marginRight: 'auto' },
  trailing: { marginLeft: 'auto' },
  blocked: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  shrink: { flex: 1 },
  writeBox: { gap: spacing.sm },
  input: { minHeight: 88, borderRadius: radius.md, ...squircle, backgroundColor: colors.fill, padding: spacing.md, color: colors.text, fontFamily: fonts.sans, fontSize: 15, lineHeight: 21 },
  actions: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.sm },
  end: { justifyContent: 'flex-end' },
  action: { minHeight: 34, justifyContent: 'center', borderRadius: radius.sm, ...squircle, backgroundColor: colors.fill, paddingHorizontal: spacing.md },
  ghost: { backgroundColor: 'transparent', paddingHorizontal: spacing.sm },
  primary: { backgroundColor: colors.text },
  actionLabel: { color: colors.muted, fontFamily: fonts.sans, fontSize: 13, fontWeight: '500' },
  error: { color: colors.danger, fontFamily: fonts.sans, fontSize: 13 },
})
