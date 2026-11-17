import { draftBlocks, draftDocument } from '@manor/client-runtime/slack-draft-formatting'
import { SlackDraftEditor, SlackDraftPreview } from './SlackDraftEditor'
import { outboundDraftRevision, readOutboundDraftEdit, writeOutboundDraftEdit, type OutboundDraftEdit } from '@manor/client-runtime/outbound-draft-edits'
import Mail01Icon from '@hugeicons/core-free-icons/Mail01Icon'
import SlackIcon from '@hugeicons/core-free-icons/SlackIcon'
import UnfoldMoreIcon from '@hugeicons/core-free-icons/UnfoldMoreIcon'
import { HugeiconsIcon } from '@hugeicons/react-native'
import { draftSettled, draftShown, draftStatus, draftStatusLabel, snoozeUntilTomorrow, type DraftRecord, type WorkspaceState } from '@manor/client-runtime/state'
import type { OutboundDraftThread, SlackRichText } from '@manor/contracts'
import { slackRichTextFallback, SlackRichTextSchema, isOutboundSlackChannelId, OUTBOUND_DRAFT_BODY_MAX, OUTBOUND_DRAFT_SUBJECT_MAX, OUTBOUND_DRAFT_TO_MAX } from '@manor/contracts'
import { useRef, useState, type ReactNode } from 'react'
import { Keyboard, Linking, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native'
import Animated, { Easing, FadeIn, FadeOut, LinearTransition, ReduceMotion } from 'react-native-reanimated'

import { Sheet } from '@/components/Sheet'
import { Text } from '@/components/Text'
import { colors, fonts, radius, spacing, squircle, tracking } from '@/theme'

export type OutboundThreadReply = WorkspaceState['outboundThreads'][string]

/**
 * Everything a draft can do, handed down as one object so the transcript does not
 * grow a prop per verb. Every handler returns whether the socket took the message.
 */
export interface DraftActions {
  onSubmit?: (draftId: string, body: string, subject?: string, slackRichText?: SlackRichText, cc?: string) => boolean
  onDiscard?: (draftId: string) => boolean
  onSnooze?: (draftId: string, until: number) => boolean
  onIgnore?: (draftId: string) => boolean
  onRestore?: (draftId: string) => boolean
  onReadThread?: (draftId: string) => boolean
  /** Full-thread replies by draft id, filled once `onReadThread` has been answered. */
  threads?: Record<string, OutboundThreadReply>
}

type Selection = { start: number; end: number }

interface OutboundDraftBubbleProps {
  draft: DraftRecord
  connected?: boolean
  actions?: DraftActions
  /**
   * Set by a list of drafts, which unfolds one card at a time. Absent, the card keeps
   * its own fold: unfolded while it waits for a decision, folded once it is taken.
   */
  unfolded?: boolean
  onToggle?: () => void
}

/** Reflows the card when its body folds or opens, on the curve the task card uses. */
const SETTLE = LinearTransition.duration(220).easing(Easing.out(Easing.exp)).reduceMotion(ReduceMotion.System)
const FADE_IN = FadeIn.duration(160).reduceMotion(ReduceMotion.System)
const FADE_OUT = FadeOut.duration(100).reduceMotion(ReduceMotion.System)

/**
 * One outbound message, Gmail or Slack, inside the turn that wrote it. Open, it is the
 * mail as it will leave, editable in place. Once Send, Discard, Later or Ignore is
 * taken it folds to its header, and the header reopens it to read, never to act.
 */
export function OutboundDraftBubble({ draft, connected = true, actions = {}, unfolded, onToggle }: OutboundDraftBubbleProps) {
  const { onSubmit, onDiscard, onSnooze, onIgnore, onRestore, onReadThread, threads } = actions
  const closed = draft.closed
  const submission = draft.submission
  const status = draftStatus(draft)
  const open = status === 'open'
  const settled = draftSettled(draft)
  const editRevision = outboundDraftRevision(draft)
  const [edit, setLocalEdit] = useState(() => readOutboundDraftEdit(draft))
  const currentEdit = edit.revision === editRevision ? edit : readOutboundDraftEdit(draft)
  const { body, subject, cc, slackRichText } = currentEdit
  const editedRichText = draft.channel === 'slack' ? slackRichText ?? draftDocument(draftBlocks(body)) : undefined
  const shownRichText = closed?.slackRichText ?? submission?.slackRichText ?? slackRichText
  const validFormatting = editedRichText === undefined || SlackRichTextSchema.safeParse(editedRichText).success
  const setEdit = (next: Partial<OutboundDraftEdit>) => {
    const merged = { ...currentEdit, ...next, revision: editRevision }
    writeOutboundDraftEdit(draft.draftId, merged)
    setLocalEdit(merged)
  }
  // A card picked to be re-read stays open until it is folded again; a fresh decision folds it.
  const [reread, setReread] = useState<string | undefined>(undefined)
  const rereadKey = `${status}:${draft.draftId}`
  const rereadOpen = reread === rereadKey
  const expanded = unfolded ?? (!settled || rereadOpen)
  const toggle = onToggle ?? (settled ? () => setReread(rereadOpen ? undefined : rereadKey) : undefined)

  // The sheet opens over a live keyboard. It takes the keyboard down on the way in
  // and, if the body had focus, hands focus and the caret back on the way out, so
  // reading the thread never costs half a sentence or the place in it.
  const bodyRef = useRef<TextInput>(null)
  const bodyFocused = useRef(false)
  const caret = useRef<Selection | undefined>(undefined)
  const [threadOpen, setThreadOpen] = useState(false)
  const [resumeAt, setResumeAt] = useState<{ selection: Selection } | undefined>(undefined)

  const showThread = () => {
    if (onReadThread === undefined) return
    onReadThread(draft.draftId)
    setResumeAt(bodyFocused.current && caret.current !== undefined ? { selection: caret.current } : undefined)
    Keyboard.dismiss()
    setThreadOpen(true)
  }

  const closeThread = () => setThreadOpen(false)
  // Only once the sheet has actually gone: while it is still sliding away it holds
  // the first responder, and a focus call before that lands nowhere.
  const resumeEditing = () => {
    if (resumeAt !== undefined) bodyRef.current?.focus()
  }

  const gmail = draft.channel === 'gmail'
  const routeReady = gmail || isOutboundSlackChannelId(draft.slackChannelId)
  const canSubmit = open && routeReady && connected && onSubmit !== undefined && body.trim().length > 0 && validFormatting
  // Later and Ignore are decisions about the thread, and only a draft that knows
  // its thread can make them stick. Anything else keeps the plain Discard.
  const threadVerbs = draft.thread !== undefined && (onSnooze !== undefined || onIgnore !== undefined)
  // Only a mailbox can be read back in full today. A Slack thread keeps its quote and
  // its verbs, but no "Show more" that every tap would fail.
  const readable = gmail && onReadThread !== undefined && draft.fullThread !== false
  const shown = draftShown(draft)
  // A reply keeps its thread's subject, so only new mail can retitle itself.
  const subjectEditable = open && draft.thread === undefined
  const shownSubject = subjectEditable ? subject : open ? (draft.subject ?? '') : shown.subject
  const shownCc = open ? cc : shown.cc
  const showHeaderStatus = !expanded || !open
  const snoozedUntil = status === 'snoozed' && closed?.until !== undefined ? `, back ${untilLabel(closed.until)}` : ''
  const restorable = onRestore !== undefined && (status === 'snoozed' || status === 'ignored')

  return (
    <Animated.View layout={SETTLE} style={styles.card}>
      <CardHeader
        channel={draft.channel}
        expanded={expanded}
        {...(toggle === undefined ? {} : { onToggle: toggle })}
        status={showHeaderStatus ? `${draftStatusLabel(draft)}${snoozedUntil}, ${draft.to}` : undefined}
        danger={open && draft.failure !== undefined}
        action={restorable ? (
          <TextButton accessibilityLabel="Restore this draft" disabled={!connected} label="Restore" onPress={() => onRestore(draft.draftId)} />
        ) : undefined}
      />
      {!expanded ? null : (
        <Animated.View entering={FADE_IN} exiting={FADE_OUT} style={styles.content}>
          {draft.thread === undefined ? null : (
            <ThreadQuote thread={draft.thread} {...(readable ? { onMore: showThread } : {})} />
          )}
          {!gmail ? null : subjectEditable ? (
            <TextInput
              accessibilityLabel="Draft subject"
              maxLength={OUTBOUND_DRAFT_SUBJECT_MAX}
              multiline
              submitBehavior="blurAndSubmit"
              onChangeText={(value) => setEdit({ subject: oneLine(value) })}
              placeholder="Subject"
              placeholderTextColor={colors.dim}
              style={styles.subjectInput}
              value={subject}
            />
          ) : shownSubject.length > 0 ? (
            <Text style={styles.subject}>{shownSubject}</Text>
          ) : null}
          <View style={styles.fields}>
            {gmail ? <Field label="From"><Text style={styles.fieldValue}>{draft.from ?? 'Personal Gmail'}</Text></Field> : null}
            <Field label="To"><Text style={styles.fieldValue}>{draft.to}</Text></Field>
            {!gmail ? null : open ? (
              <Field label="Cc">
                <TextInput
                  accessibilityLabel="Draft Cc"
                  maxLength={OUTBOUND_DRAFT_TO_MAX}
                  multiline
                  submitBehavior="blurAndSubmit"
                  onChangeText={(value) => setEdit({ cc: oneLine(value) })}
                  placeholder="Add Cc"
                  placeholderTextColor={colors.dim}
                  style={[styles.fieldValue, styles.fieldInput]}
                  value={cc}
                />
              </Field>
            ) : shownCc.length > 0 ? (
              <Field label="Cc"><Text style={styles.fieldValue}>{shownCc}</Text></Field>
            ) : null}
          </View>
          {draft.channel === 'slack' && open ? (
            <SlackDraftEditor key={editRevision} body={body} {...(slackRichText === undefined ? {} : { document: slackRichText })} onChange={(document) => setEdit({ body: slackRichTextFallback(document), slackRichText: document })} />
          ) : draft.channel === 'slack' && shownRichText !== undefined ? (
            <SlackDraftPreview document={shownRichText} />
          ) : open ? (
            <TextInput
              accessibilityLabel="Draft body"
              maxLength={OUTBOUND_DRAFT_BODY_MAX}
              multiline
              onBlur={() => { bodyFocused.current = false }}
              onChangeText={(value) => setEdit({ body: value })}
              onFocus={() => { bodyFocused.current = true }}
              onSelectionChange={(event) => {
                caret.current = event.nativeEvent.selection
                // The pinned caret has landed once the input reports any selection again.
                if (resumeAt !== undefined) setResumeAt(undefined)
              }}
              ref={bodyRef}
              scrollEnabled={false}
              style={styles.bodyInput}
              value={body}
              {...(resumeAt === undefined || threadOpen ? {} : { selection: resumeAt.selection })}
            />
          ) : (
            <Text selectable style={styles.body}>{shown.body}</Text>
          )}
          {!routeReady ? (
            <Text style={styles.failure}>The Slack destination is missing, so this cannot be sent.</Text>
          ) : draft.failure !== undefined && open ? (
            <Text style={styles.failure}>{draft.failure}</Text>
          ) : submission !== undefined ? (
            <Text style={styles.note}>
              {submission.status === 'uncertain'
                ? submission.message ?? 'Delivery is uncertain. Send stays locked to prevent a duplicate.'
                : 'Sending. Send stays locked to prevent a duplicate.'}
            </Text>
          ) : closed?.outcome === 'submitted' && closed.delivery !== 'delivered' ? (
            <Text style={styles.note}>Saved in this chat. Nothing was sent.</Text>
          ) : null}
          {!open ? null : (
            <View style={styles.actions}>
              {threadVerbs ? (
                <>
                  {onSnooze === undefined ? null : (
                    <TextButton accessibilityLabel="Answer tomorrow" disabled={!connected} label="Later" onPress={() => onSnooze(draft.draftId, snoozeUntilTomorrow())} />
                  )}
                  {onIgnore === undefined ? null : (
                    <TextButton accessibilityLabel="Ignore this thread" disabled={!connected} label="Ignore" onPress={() => onIgnore(draft.draftId)} />
                  )}
                </>
              ) : onDiscard === undefined ? null : (
                <TextButton accessibilityLabel="Discard draft" disabled={!connected} label="Discard" onPress={() => onDiscard(draft.draftId)} />
              )}
              <TextButton
                accessibilityLabel="Send"
                disabled={!canSubmit}
                label="Send"
                onPress={() => {
                  if (!canSubmit || onSubmit === undefined) return
                  if (gmail) onSubmit(draft.draftId, body, subjectEditable ? subject : undefined, editedRichText, cc)
                  else onSubmit(draft.draftId, body, undefined, editedRichText)
                }}
                primary
              />
            </View>
          )}
        </Animated.View>
      )}
      {draft.thread === undefined || !readable ? null : (
        <ThreadSheet draft={draft} onClose={closeThread} onDismiss={resumeEditing} open={threadOpen} reply={threads?.[draft.draftId]} />
      )}
    </Animated.View>
  )
}

/**
 * The app tile and its name, plus where the draft stands once that is the news. The
 * whole row is the fold toggle whenever there is something folded to reopen.
 */
function CardHeader({ channel, expanded, onToggle, status, danger, action }: {
  channel: DraftRecord['channel']
  expanded: boolean
  onToggle?: () => void
  status: string | undefined
  danger: boolean
  action: ReactNode
}) {
  const label = channel === 'slack' ? 'Slack' : 'Mail'
  const content = (
    <>
      <View style={styles.tile}>
        <HugeiconsIcon color={colors.text} icon={channel === 'slack' ? SlackIcon : Mail01Icon} size={16} strokeWidth={1.8} />
      </View>
      <Text style={styles.headerLabel}>{label}</Text>
      {status === undefined ? null : <Text numberOfLines={1} style={[styles.headerStatus, danger && styles.headerDanger]}>{status}</Text>}
    </>
  )
  return (
    <View style={styles.header}>
      {onToggle === undefined ? (
        <View style={styles.headerMain}>{content}</View>
      ) : (
        <Pressable
          accessibilityLabel={expanded ? `Fold ${label.toLowerCase()} card` : `Open ${label.toLowerCase()} card`}
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          hitSlop={6}
          onPress={onToggle}
          style={({ pressed }) => [styles.headerMain, pressed && styles.pressed]}
        >
          {content}
          <View style={styles.headerToggle}>
            <HugeiconsIcon color={colors.dim} icon={UnfoldMoreIcon} size={16} strokeWidth={1.8} />
          </View>
        </Pressable>
      )}
      {action}
    </View>
  )
}

/** One header line of the mail, label muted, divided from the next by a hairline. */
/** A subject or address list wraps to show all of it; a pasted line break becomes a space. */
function oneLine(value: string): string {
  return value.replace(/\r?\n/g, ' ')
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={styles.fieldBody}>{children}</View>
    </View>
  )
}

const when = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso))

const untilLabel = (ms: number) =>
  new Intl.DateTimeFormat('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(ms))

/**
 * The message this draft answers, quoted above the subject so the reply can be judged
 * without leaving the chat. Three lines and no scroll region of its own: the way to
 * the rest is the sheet, never a box that steals the swipe.
 */
function ThreadQuote({ thread, onMore }: { thread: OutboundDraftThread; onMore?: () => void }) {
  const earlier = thread.earlierCount
  const openUrl = thread.openUrl
  return (
    <View style={styles.quote}>
      <View style={styles.quoteHead}>
        <Text numberOfLines={1} style={styles.quoteFrom}>{thread.previous.from}</Text>
        <Text style={styles.quoteWhen}>{when(thread.previous.at)}</Text>
        <View style={styles.quoteTail}>
          {earlier > 0 ? <Text style={styles.quoteWhen}>{`${String(earlier)} earlier`}</Text> : null}
          {onMore !== undefined ? (
            <Pressable accessibilityRole="button" hitSlop={8} onPress={onMore} style={({ pressed }) => pressed && styles.pressed}>
              <Text style={styles.quoteMore}>Show more</Text>
            </Pressable>
          ) : openUrl === undefined ? null : (
            <Pressable
              accessibilityRole="link"
              hitSlop={8}
              onPress={() => void Linking.openURL(openUrl)}
              style={({ pressed }) => pressed && styles.pressed}
            >
              <Text style={styles.quoteMore}>Open</Text>
            </Pressable>
          )}
        </View>
      </View>
      <Text numberOfLines={3} style={styles.quoteText}>{thread.previous.text}</Text>
    </View>
  )
}

/**
 * The whole thread, to read and nothing else. There is no reply control in here on
 * purpose: a second place to send is a second send path, and the bubble just closed
 * that door.
 */
function ThreadSheet({
  draft,
  open,
  reply,
  onClose,
  onDismiss,
}: {
  draft: DraftRecord
  open: boolean
  reply: OutboundThreadReply | undefined
  onClose: () => void
  onDismiss: () => void
}) {
  const result = reply?.result
  const openUrl = result?.status === 'ready' ? result.openUrl ?? draft.thread?.openUrl : draft.thread?.openUrl
  const subtitle =
    result === undefined
      ? 'Loading…'
      : result.status === 'error'
        ? 'Could not load the thread'
        : `${String(result.messages.length)} ${result.messages.length === 1 ? 'message' : 'messages'}, read only`
  return (
    <Sheet onClose={onClose} onDismiss={onDismiss} open={open} subtitle={subtitle} title={draft.subject?.trim().length ? draft.subject : draft.to}>
      <ScrollView contentContainerStyle={styles.sheetContent} keyboardShouldPersistTaps="handled">
        {result === undefined ? (
          <Text style={styles.sheetNote}>Fetching the conversation from the mailbox…</Text>
        ) : result.status === 'error' ? (
          <Text style={styles.failure}>{result.message}</Text>
        ) : (
          result.messages.map((message, index) => (
            <View key={message.id} style={[styles.message, index === 0 && styles.messageFirst]}>
              <View style={styles.messageHead}>
                <Text numberOfLines={1} style={styles.messageFrom}>{message.from}</Text>
                <Text style={styles.quoteWhen}>{when(message.at)}</Text>
              </View>
              {message.to === undefined ? null : <Text numberOfLines={1} style={styles.quoteWhen}>{`to ${message.to}`}</Text>}
              <Text selectable style={styles.messageText}>{message.text}</Text>
            </View>
          ))
        )}
        {result?.status === 'ready' && result.truncated ? (
          <Text style={styles.sheetNote}>{`Only the most recent ${String(result.messages.length)} messages are shown.`}</Text>
        ) : null}
        {openUrl === undefined ? null : (
          <Pressable accessibilityRole="link" hitSlop={8} onPress={() => void Linking.openURL(openUrl)} style={({ pressed }) => [styles.openLink, pressed && styles.pressed]}>
            <Text style={styles.quoteMore}>{draft.channel === 'gmail' ? 'Open in Gmail' : 'Open in Slack'}</Text>
          </Pressable>
        )}
      </ScrollView>
    </Sheet>
  )
}

/** A text-only button; the primary one is the filled pill that sends. */
function TextButton({
  accessibilityLabel,
  disabled = false,
  label,
  onPress,
  primary = false,
}: {
  accessibilityLabel: string
  disabled?: boolean
  label: string
  onPress: () => void
  primary?: boolean
}) {
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={6}
      onPress={onPress}
      style={({ pressed }) => [styles.button, primary && styles.buttonPrimary, disabled && styles.disabled, pressed && styles.pressed]}
    >
      <Text style={[styles.buttonLabel, primary && styles.buttonLabelPrimary]}>{label}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, ...squircle, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, backgroundColor: colors.bubble },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.md },
  headerMain: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 10 },
  tile: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm, ...squircle, backgroundColor: colors.userBubble },
  headerLabel: { color: colors.text, fontFamily: fonts.sans, fontSize: 15 },
  headerStatus: { flexShrink: 1, color: colors.muted, fontFamily: fonts.sans, fontSize: 15 },
  headerDanger: { color: colors.danger },
  headerToggle: { marginLeft: 'auto', width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
  content: { gap: spacing.sm, paddingHorizontal: spacing.lg, paddingBottom: spacing.lg },
  fields: { marginBottom: spacing.xs },
  field: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line, paddingVertical: 10 },
  fieldLabel: { width: 44, color: colors.muted, fontFamily: fonts.sans, fontSize: 15 },
  fieldBody: { flex: 1, minWidth: 0 },
  fieldValue: { color: colors.text, fontFamily: fonts.sans, fontSize: 15 },
  fieldInput: { padding: 0, letterSpacing: tracking.body },
  quote: { gap: 4, borderLeftWidth: 2, borderLeftColor: colors.line, paddingLeft: spacing.md, paddingVertical: 2 },
  quoteHead: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm },
  quoteFrom: { flexShrink: 1, color: colors.muted, fontFamily: fonts.sans, fontSize: 13 },
  quoteWhen: { color: colors.dim, fontFamily: fonts.sans, fontSize: 13 },
  quoteTail: { marginLeft: 'auto', flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  quoteMore: { color: colors.muted, fontFamily: fonts.sans, fontSize: 13, fontWeight: '500' },
  quoteText: { color: colors.muted, fontFamily: fonts.sans, fontSize: 15, lineHeight: 21 },
  subjectInput: { padding: 0, color: colors.text, fontFamily: fonts.sansMedium, fontSize: 16, letterSpacing: tracking.body },
  subject: { color: colors.text, fontFamily: fonts.sans, fontSize: 16, fontWeight: '500', lineHeight: 22 },
  // No box and no fixed frame: the input grows with the mail instead of scrolling inside a transcript row.
  bodyInput: { minHeight: 96, padding: 0, color: colors.text, fontFamily: fonts.sans, fontSize: 16, letterSpacing: tracking.body, lineHeight: 23, textAlignVertical: 'top' },
  body: { color: colors.text, fontFamily: fonts.sans, fontSize: 16, lineHeight: 23 },
  actions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', flexWrap: 'wrap', gap: spacing.xs, marginTop: spacing.xs },
  button: { minHeight: 36, justifyContent: 'center', borderRadius: radius.round, paddingHorizontal: spacing.md },
  buttonPrimary: { backgroundColor: colors.text, paddingHorizontal: spacing.lg, marginLeft: spacing.xs },
  buttonLabel: { color: colors.muted, fontFamily: fonts.sans, fontSize: 14, fontWeight: '500' },
  buttonLabelPrimary: { color: colors.onPrimary },
  failure: { color: colors.danger, fontFamily: fonts.sans, fontSize: 13, lineHeight: 18 },
  note: { color: colors.dim, fontFamily: fonts.sans, fontSize: 13, lineHeight: 18 },
  sheetContent: { gap: spacing.md, paddingHorizontal: spacing.lg, paddingBottom: spacing.xl },
  sheetNote: { color: colors.dim, fontFamily: fonts.sans, fontSize: 13, lineHeight: 18 },
  message: { gap: 4, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line, paddingTop: spacing.md },
  messageFirst: { borderTopWidth: 0, paddingTop: 0 },
  messageHead: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: spacing.sm },
  messageFrom: { flexShrink: 1, color: colors.text, fontFamily: fonts.sans, fontSize: 14, fontWeight: '500' },
  messageText: { color: colors.text, fontFamily: fonts.sans, fontSize: 15, lineHeight: 22 },
  openLink: { alignSelf: 'flex-start', paddingVertical: spacing.xs },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.7 },
})
