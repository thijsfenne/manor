import AlertCircleIcon from '@hugeicons/core-free-icons/AlertCircleIcon'
import Cancel01Icon from '@hugeicons/core-free-icons/Cancel01Icon'
import CheckmarkCircle02Icon from '@hugeicons/core-free-icons/CheckmarkCircle02Icon'
import Tick02Icon from '@hugeicons/core-free-icons/Tick02Icon'
import { HugeiconsIcon } from '@hugeicons/react-native'
import { Image } from 'expo-image'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Pressable, StyleSheet, TextInput, View, type ColorValue } from 'react-native'
import Animated, { FadeIn, FadeOut, LinearTransition, ReduceMotion } from 'react-native-reanimated'
import { WORK_CHANGES_LIMIT, readWorkChangeImages, readWorkChanges, settleWorkChanges, subscribeWorkChanges, writeWorkChangeImages, writeWorkChanges } from '@manor/client-runtime/work-changes'
import { readWorkChangesOpen, setWorkChangesOpen, subscribeWorkProposals } from '@manor/client-runtime/work-proposals'
import { ImageAttachmentSchema, MAX_MESSAGE_ATTACHMENTS, type GoalChoice, type ImageAttachment } from '@manor/contracts'
import { WORK_RESULT_CONNECTION_LOST, evidenceThumbnailRatio, workBlockedReason, workCardStatus, workConfirmTitle, pickWorkChoice, workChangesAsked, workChoicePicked, workResultActionLabels, workResultChoiceList, workResultFiles, workResultLines, workResultWaits, type WorkHandoffRow, type WorkResult, type WorkStatus } from '@manor/client-runtime/state'
import { addImagePasteListener, setImagePasteEnabled } from '../../modules/manor-image-paste/src'
import { useWorkspaceActions, useWorkspaceStatus } from '@/providers/WorkspaceProvider'
import { colors, fonts, radius, spacing, squircle } from '@/theme'
import { AttachmentThumbnail, ImageViewer } from './Attachments'
import { CardButton } from './CardButton'
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
          <View style={[styles.lineIcon, styles.resultIcon]}>
            <HugeiconsIcon color={colors.muted} icon={Tick02Icon} size={15} strokeWidth={1.8} />
          </View>
          <Text selectable style={[styles.result, styles.lineText, settled && styles.mutedText]}>{line}</Text>
        </View>
      ))}
      {result.limitations === undefined ? null : (
        <View style={styles.line}>
          <View style={[styles.lineIcon, styles.limitationIcon]}>
            <HugeiconsIcon color={colors.dim} icon={AlertCircleIcon} size={15} strokeWidth={1.8} />
          </View>
          <Text numberOfLines={2} selectable style={[styles.limitation, styles.lineText]}>{result.limitations}</Text>
        </View>
      )}
    </View>
  )
}

/**
 * The decisions a report leaves to the user, under a divider: each choice's plain question
 * on up to two lines (its title on one line for an older report) and its options as small
 * grey buttons, the picked one in a blue wash. A tap writes `Title: option` into Follow up,
 * which opens, so several picks go to the Session as one message. Follow up stays closed
 * while it holds only picks of a choice's `noChange` option, so Confirm stays in reach.
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
          <Text numberOfLines={choice.question === undefined ? 1 : 2} style={styles.question}>{choice.question ?? choice.title}</Text>
          <View style={styles.options}>
            {choice.options.map((option) => {
              const recommended = option === choice.recommended
              const on = workChoicePicked(picked, choice.title, option)
              return (
                <Pressable
                  key={option}
                  accessibilityRole="button"
                  accessibilityLabel={recommended ? `${option}, recommended` : option}
                  accessibilityHint={option === choice.noChange ? 'Needs no change, so you can confirm right away' : 'Adds this answer to your Follow up message'}
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

/**
 * The result whose Request changes field is being written (2026-11-18): its card stands
 * in the composer's place above the keyboard, and its own slot in the thread stays empty
 * at the same height, so the list does not move. Blur, Cancel and Send put it back.
 */
let docked: string | null = null
const dockListeners = new Set<() => void>()
const subscribeDock = (listener: () => void) => {
  dockListeners.add(listener)
  return () => { dockListeners.delete(listener) }
}
const readDock = () => docked

function dockWorkChanges(handoffId: string | null): void {
  if (docked === handoffId) return
  docked = handoffId
  for (const listener of dockListeners) listener()
}

/** Puts this result's card back in the thread, unless another one took the composer's place since. */
function releaseWorkChanges(handoffId: string): void {
  if (docked === handoffId) dockWorkChanges(null)
}

/** Opens a result's field in the composer's place: the card's Request changes, and the bar's above the composer. */
export function openWorkChanges(handoffId: string): void {
  setWorkChangesOpen(handoffId, true)
  dockWorkChanges(handoffId)
}

/** The result whose card stands in the composer's place, or null; only while its field is open. */
export function useDockedWorkChanges(): string | null {
  const handoffId = useSyncExternalStore(subscribeDock, readDock, readDock)
  const readOpen = () => handoffId !== null && readWorkChangesOpen(handoffId)
  return useSyncExternalStore(subscribeWorkProposals, readOpen, readOpen) ? handoffId : null
}

/** A card whose result still takes Request changes, the same test its body uses for the field. */
export const workChangesDockable = (row: WorkHandoffRow): boolean => row.report?.decision === 'open' && workResultWaits(row)

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

const PICTURE_SIZE = 44

/** The pictures pasted into Request changes, small at the top of the field, each with its own remove. */
function ChangeImages({ handoffId, images }: { handoffId: string; images: readonly ImageAttachment[] }) {
  if (images.length === 0) return null
  return (
    <Animated.View layout={LinearTransition.duration(180).reduceMotion(ReduceMotion.System)} style={styles.pictures}>
      {images.map((image, index) => (
        <Animated.View entering={FadeIn.duration(140).reduceMotion(ReduceMotion.System)} exiting={FadeOut.duration(100).reduceMotion(ReduceMotion.System)} key={`${image.name}:${index}`} style={styles.picture}>
          <Image accessibilityIgnoresInvertColors contentFit="cover" source={{ uri: image.dataUrl }} style={styles.pictureImage} />
          <Pressable
            accessibilityLabel={`Remove ${image.name}`}
            accessibilityRole="button"
            hitSlop={6}
            onPress={() => writeWorkChangeImages(handoffId, images.filter((_, at) => at !== index))}
            style={styles.pictureRemove}
          >
            <HugeiconsIcon color={colors.onPrimary} icon={Cancel01Icon} size={10} strokeWidth={2.2} />
          </Pressable>
        </Animated.View>
      ))}
    </Animated.View>
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
export function WorkResultBody({ result, docked: inDock = false, blocked = false, sessionSettled = false, waits = true, onOpenSession }: {
  result: WorkResult
  /** The Session is settled: Retry waits until the user reopens it, Open Session stays. */
  sessionSettled?: boolean
  /** False while the Session works again or asks: the result is not the user's move yet. */
  waits?: boolean
  /** The header says Merge blocked or Commit blocked, so the reason belongs under it. */
  blocked?: boolean
  onOpenSession?: () => void
  /**
   * The copy in the composer's place, which holds the real field. The card in the thread
   * shows what is written, and a tap there brings the card down here.
   */
  docked?: boolean
}) {
  const { acceptWorkResult, reviseWorkResult, retryWorkResult, askCheckoutStatus } = useWorkspaceActions()
  const handoffId = result.handoffId
  // Shared with the bar's Request changes, which opens this field from above the composer.
  const readChanges = () => readWorkChangesOpen(handoffId)
  const changesOpen = useSyncExternalStore(subscribeWorkProposals, readChanges, readChanges)
  const setWriting = (next: boolean) => setWorkChangesOpen(handoffId, next)
  const fieldFocused = useRef(false)
  // Kept outside the card: the list unmounts a row that scrolls away, and the text has to be there when it returns.
  const readFeedback = () => readWorkChanges(handoffId)
  const feedback = useSyncExternalStore(subscribeWorkChanges, readFeedback, readFeedback)
  const readImages = () => readWorkChangeImages(handoffId)
  const images = useSyncExternalStore(subscribeWorkChanges, readImages, readImages)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const connected = useWorkspaceStatus() === 'live'
  const open = result.decision === 'open' && waits
  const writing = open && changesOpen
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

  // A picture pasted into the field joins it, the same picture the composer would stage:
  // the native paste shrinks it to a JPEG data URL and the wire's own schema checks it.
  useEffect(() => {
    if (!inDock) return
    const subscription = addImagePasteListener((event) => {
      if (!fieldFocused.current) return
      if (event.error === 'too_large') {
        setError('Manor could not shrink this image enough.')
        return
      }
      const current = readWorkChangeImages(handoffId)
      if (current.length >= MAX_MESSAGE_ATTACHMENTS) {
        setError(`You can attach up to ${MAX_MESSAGE_ATTACHMENTS} images.`)
        return
      }
      const parsed = ImageAttachmentSchema.safeParse(event)
      if (!parsed.success) {
        setError('Manor could not attach this image.')
        return
      }
      setError(null)
      writeWorkChangeImages(handoffId, [...current, parsed.data])
    })
    return () => {
      subscription.remove()
      if (fieldFocused.current) setImagePasteEnabled(false)
      // Gone from the composer's place for any reason (the screen was covered, the result
      // moved on): the card is back in the thread, and stays there when the screen returns.
      releaseWorkChanges(handoffId)
    }
  }, [inDock, handoffId])

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
    const next = pickWorkChoice(readWorkChanges(handoffId), choice, option)
    writeWorkChanges(handoffId, next)
    const asked = workChangesAsked(next, result.choices)
    // A pick that opens the field brings it into the composer's place; one already open stays where it is.
    if (asked && !changesOpen) openWorkChanges(handoffId)
    else setWriting(asked)
  }
  const sent = () => {
    settleWorkChanges(handoffId, text, images)
    releaseWorkChanges(handoffId)
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
            <CardButton label="Open Session" onPress={onOpenSession} variant="quiet" />
          )}
          {canRetry ? (
            <CardButton
              accessibilityHint="Runs the commit again under your Confirm"
              busy={busy}
              disabled={busy || !connected}
              label={busy ? 'Retrying…' : 'Retry'}
              onPress={() => void run(() => retryWorkResult(result.handoffId))}
              variant="primary"
            />
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
                  <CardButton label="Open report" onPress={openReport} style={styles.leading} variant="quiet" />
                )}
                <CardButton
                  disabled={busy || !connected}
                  label={labels.secondary}
                  onPress={() => { setError(null); openWorkChanges(handoffId) }}
                  variant="secondary"
                />
                <CardButton
                  {...(confirmHint === undefined ? {} : { accessibilityHint: confirmHint })}
                  busy={busy}
                  disabled={busy || !connected}
                  label={busy ? labels.pending : labels.primary}
                  onPress={() => void run(() => acceptWorkResult(result.handoffId, result.mergeInto, result.version))}
                  variant="primary"
                />
              </>
            ) : null}
          </View>
        </View>
      ) : null}
      {writing ? (
        <View style={styles.writeBox}>
          {inDock ? (
            <View style={styles.field}>
              <ChangeImages handoffId={handoffId} images={images} />
              <TextInput
                accessibilityLabel="Requested changes"
                autoFocus
                // Stays editable while a send is out, or iOS takes the keyboard away under the card.
                editable={connected}
                maxLength={WORK_CHANGES_LIMIT}
                multiline
                onBlur={() => {
                  fieldFocused.current = false
                  setImagePasteEnabled(false)
                  // A send in flight keeps the card here, where its answer or error lands.
                  if (busyRef.current) return
                  // Nothing written closes again, so the card comes back exactly as it left.
                  if (readWorkChanges(handoffId).trim() === '' && readWorkChangeImages(handoffId).length === 0) setWriting(false)
                  releaseWorkChanges(handoffId)
                }}
                onChangeText={(next) => writeWorkChanges(handoffId, next)}
                onFocus={() => {
                  fieldFocused.current = true
                  setImagePasteEnabled(true)
                }}
                placeholder="What should change?"
                placeholderTextColor={colors.dim}
                selectionColor={colors.busy}
                style={[styles.input, images.length > 0 && styles.inputBelowPictures]}
                textAlignVertical="top"
                value={feedback}
              />
            </View>
          ) : (
            // What is written so far; writing happens in the composer's place.
            <Pressable
              accessibilityHint="Opens the field above the keyboard"
              accessibilityLabel="Requested changes"
              accessibilityRole="button"
              accessibilityValue={{ text: feedback }}
              disabled={busy || !connected}
              onPress={() => dockWorkChanges(handoffId)}
              style={styles.field}
            >
              <ChangeImages handoffId={handoffId} images={images} />
              <Text style={[styles.input, images.length > 0 && styles.inputBelowPictures, feedback === '' && styles.placeholder]}>
                {feedback === '' ? 'What should change?' : feedback}
              </Text>
            </Pressable>
          )}
          <View style={[styles.actions, styles.end]}>
            <CardButton
              disabled={busy}
              label="Cancel"
              onPress={() => {
                setWriting(false)
                releaseWorkChanges(handoffId)
              }}
              variant="quiet"
            />
            <CardButton
              busy={busy}
              disabled={busy || !connected || text === ''}
              label={busy ? 'Sending…' : 'Send to Session'}
              onPress={() => void run(() => reviseWorkResult(result.handoffId, result.version, text, [...images]), sent)}
              variant="primary"
            />
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
  // The icon box is as tall as its text's first line, so the icon follows that line when the
  // text wraps. The padding is the optical nudge: the eye centres on the x-height, below the line box middle.
  lineIcon: { justifyContent: 'center' },
  resultIcon: { height: 21, paddingTop: 4 },
  limitationIcon: { height: 18, paddingTop: 2 },
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
  field: { borderRadius: radius.md, ...squircle, backgroundColor: colors.fill },
  input: { minHeight: 88, padding: spacing.md, color: colors.text, fontFamily: fonts.sans, fontSize: 15, lineHeight: 21 },
  // The text's own top padding is the gap under the pictures, and the field keeps its height.
  inputBelowPictures: { minHeight: 88 - PICTURE_SIZE - spacing.md },
  placeholder: { color: colors.dim },
  pictures: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, paddingHorizontal: spacing.md, paddingTop: spacing.md },
  picture: { width: PICTURE_SIZE, height: PICTURE_SIZE },
  pictureImage: { width: PICTURE_SIZE, height: PICTURE_SIZE, borderRadius: radius.sm, ...squircle },
  pictureRemove: { position: 'absolute', top: -5, right: -5, width: 18, height: 18, alignItems: 'center', justifyContent: 'center', borderRadius: 9, backgroundColor: colors.text },
  actions: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.sm },
  end: { justifyContent: 'flex-end' },
  error: { color: colors.danger, fontFamily: fonts.sans, fontSize: 13 },
})
