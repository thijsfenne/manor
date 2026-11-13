import { useOutboundDraftHeight } from '@/lib/useOutboundDraftHeight'
import { draftBlocks, draftDocument } from '@manor/client-runtime/slack-draft-formatting'
import { SlackDraftEditor, SlackDraftPreview } from './SlackDraftEditor'
import { outboundDraftRevision, readOutboundDraftEdit, writeOutboundDraftEdit, type OutboundDraftEdit } from '@manor/client-runtime/outbound-draft-edits'
import { Image } from 'expo-image'
import { useDockDraftActions } from './outboundDockState'
import { Copy01Icon, PencilEdit02Icon, Tick02Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react-native'
import { plainDraftText } from '@manor/client-runtime/plain-preview'
import { draftStatus, snoozeUntilTomorrow, type DraftRecord, type WorkspaceState } from '@manor/client-runtime/state'
import type { OutboundDraftThread, SlackRichText } from '@manor/contracts'
import { slackRichTextFallback, SlackRichTextSchema, isOutboundSlackChannelId, OUTBOUND_DRAFT_BODY_MAX, OUTBOUND_DRAFT_SUBJECT_MAX } from '@manor/contracts'
import * as Clipboard from 'expo-clipboard'
import { useEffect, useRef, useState } from 'react'
import { Keyboard, Linking, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native'

import { Sheet } from '@/components/Sheet'
import { Text } from '@/components/Text'
import { colors, fonts, radius, spacing, squircle, tracking } from '@/theme'

export type OutboundThreadReply = WorkspaceState['outboundThreads'][string]

/**
 * Everything a draft can do, handed down as one object so the transcript does not
 * grow a prop per verb. Every handler returns whether the socket took the message.
 */
export interface DraftActions {
  onSubmit?: (draftId: string, body: string, subject?: string, slackRichText?: SlackRichText) => boolean
  onDiscard?: (draftId: string) => boolean
  onSnooze?: (draftId: string, until: number) => boolean
  onIgnore?: (draftId: string) => boolean
  onRestore?: (draftId: string) => boolean
  onReadThread?: (draftId: string) => boolean
  /** Full-thread replies by draft id, filled once `onReadThread` has been answered. */
  threads?: Record<string, OutboundThreadReply>
}

type Selection = { start: number; end: number }

/**
 * One prepared Gmail or Slack message, the same card the Mac shows. Submit is the
 * only way anything leaves Manor, so the line above the text names the account that
 * will do the sending rather than only the channel: two mailboxes reach the same
 * address, and only one of them is the right sender.
 */
export function OutboundDraftBubble({
  draft,
  connected = true,
  actions = {},
}: {
  draft: DraftRecord
  connected?: boolean
  actions?: DraftActions
}) {
  const { onSubmit, onDiscard, onSnooze, onIgnore, onRestore, onReadThread, threads } = useDockDraftActions(draft, actions)
  const dockHeight = useOutboundDraftHeight()
  const [cardHeight, setCardHeight] = useState(0)
  const [inputHeight, setInputHeight] = useState(0)
  const inputMaxHeight = Math.max(0, dockHeight - (cardHeight - inputHeight) - spacing.sm)
  const closed = draft.closed
  const submission = draft.submission
  const status = draftStatus(draft)
  const open = status === 'open'
  const editRevision = outboundDraftRevision(draft)
  const [edit, setLocalEdit] = useState(() => readOutboundDraftEdit(draft))
  const currentEdit = edit.revision === editRevision ? edit : readOutboundDraftEdit(draft)
  const { body, subject, slackRichText } = currentEdit
  const editedRichText = draft.channel === 'slack' ? slackRichText ?? draftDocument(draftBlocks(body)) : undefined
  const shownRichText = closed?.slackRichText ?? submission?.slackRichText ?? slackRichText
  const validFormatting = editedRichText === undefined || SlackRichTextSchema.safeParse(editedRichText).success
  const setEdit = (next: OutboundDraftEdit) => {
    writeOutboundDraftEdit(draft.draftId, next)
    setLocalEdit(next)
  }
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(copiedTimer.current), [])

  // The sheet opens over a live keyboard. It takes the keyboard down on the way in
  // and, if the body had focus, hands focus and the caret back on the way out, so
  // reading the thread never costs half a sentence or the place in it.
  const bodyRef = useRef<TextInput>(null)
  const bodyFocused = useRef(false)
  const caret = useRef<Selection | undefined>(undefined)
  const [threadOpen, setThreadOpen] = useState(false)
  const [resumeAt, setResumeAt] = useState<{ selection: Selection } | undefined>(undefined)

  const copy = async () => {
    const copiedRichText = closed === undefined && submission === undefined ? editedRichText : shownRichText
    try {
      await Clipboard.setStringAsync((copiedRichText === undefined ? plainDraftText(closed?.body ?? submission?.body ?? body) : slackRichTextFallback(copiedRichText)))
    } catch {
      return
    }
    setCopied(true)
    clearTimeout(copiedTimer.current)
    copiedTimer.current = setTimeout(() => setCopied(false), 1_600)
  }

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

  const routeReady = draft.channel === 'gmail' || isOutboundSlackChannelId(draft.slackChannelId)
  const canSubmit = open && routeReady && connected && onSubmit !== undefined && body.trim().length > 0 && validFormatting
  // Later and Ignore are decisions about the thread, and only a draft that knows
  // its thread can make them stick. Anything else keeps the plain Discard.
  const threadVerbs = draft.thread !== undefined && (onSnooze !== undefined || onIgnore !== undefined)
  // Only a mailbox can be read back in full today. A Slack thread keeps its quote and
  // its verbs, but no "Show more" that every tap would fail.
  const readable = draft.channel === 'gmail' && onReadThread !== undefined

  return (
    <View style={styles.bubble} onLayout={(event) => setCardHeight(event.nativeEvent.layout.height)}>
      <View style={styles.meta}>
        {draft.channel === 'slack' ? <Image source={require('../../assets/images/Slack_icon.svg')} style={{ width: 13, height: 13 }} contentFit="contain" /> : <HugeiconsIcon color={colors.dim} icon={PencilEdit02Icon} size={13} strokeWidth={1.8} />}
        <Text numberOfLines={1} style={styles.metaText}>{route(draft)}</Text>
      </View>
      <Text numberOfLines={1} style={styles.to}>To {draft.to}</Text>
      {draft.thread === undefined ? null : (
        <ThreadQuote thread={draft.thread} {...(readable ? { onMore: showThread } : {})} />
      )}
      {draft.channel === 'gmail' ? (
        open ? (
          <TextInput
            accessibilityLabel="Draft subject"
            maxLength={OUTBOUND_DRAFT_SUBJECT_MAX}
            onChangeText={(value) => setEdit({ revision: editRevision, body, subject: value })}
            placeholder="Subject"
            placeholderTextColor={colors.dim}
            style={styles.subjectInput}
            value={subject}
          />
        ) : (closed?.subject ?? submission?.subject ?? draft.subject)?.length ? (
          <Text style={styles.subject}>{closed?.subject ?? submission?.subject ?? draft.subject}</Text>
        ) : null
      ) : null}
      {draft.channel === 'slack' && open ? (
        <SlackDraftEditor maxInputHeight={inputMaxHeight} onInputHeight={setInputHeight} key={editRevision} body={body} {...(slackRichText === undefined ? {} : { document: slackRichText })} onChange={(document) => setEdit({ revision: editRevision, body: slackRichTextFallback(document), subject, slackRichText: document })} />
      ) : draft.channel === 'slack' && shownRichText !== undefined ? (
        <View style={{ marginBottom: spacing.md }}><SlackDraftPreview document={shownRichText} /></View>
      ) : open ? (
        <TextInput
          accessibilityLabel="Draft body"
          maxLength={OUTBOUND_DRAFT_BODY_MAX}
          multiline
          onBlur={() => { bodyFocused.current = false }}
          onChangeText={(value) => setEdit({ revision: editRevision, body: value, subject })}
          onFocus={() => { bodyFocused.current = true }}
          onSelectionChange={(event) => {
            caret.current = event.nativeEvent.selection
            // The pinned caret has landed once the input reports any selection again.
            if (resumeAt !== undefined) setResumeAt(undefined)
          }}
          ref={bodyRef}
          style={styles.bodyInput}
          value={body}
          {...(resumeAt === undefined || threadOpen ? {} : { selection: resumeAt.selection })}
        />
      ) : (
        <Text selectable style={styles.body}>{closed?.body ?? submission?.body ?? draft.body}</Text>
      )}
      {!routeReady ? (
        <Text style={styles.failure}>Copy only: the Slack destination is missing.</Text>
      ) : draft.failure !== undefined ? (
        <Text style={styles.failure}>{draft.failure}</Text>
      ) : submission !== undefined ? (
        <Text style={styles.status}>
          {submission.status === 'uncertain'
            ? submission.message ?? 'Delivery is uncertain. Submit stays locked to prevent a duplicate.'
            : 'Sending started. Submit stays locked to prevent a duplicate.'}
        </Text>
      ) : null}
      <View style={styles.actions}>
        <Action
          accessibilityLabel={copied ? 'Copied' : 'Copy'}
          icon={copied ? Tick02Icon : Copy01Icon}
          label={copied ? 'Copied' : 'Copy'}
          onPress={() => void copy()}
        />
        {open ? (
          <>
            <Action
              accessibilityLabel="Submit"
              disabled={!canSubmit}
              label="Submit"
              onPress={() => {
                if (!canSubmit || onSubmit === undefined) return
                onSubmit(draft.draftId, body, draft.channel === 'gmail' ? subject : undefined, editedRichText)
              }}
              primary
            />
            {threadVerbs ? (
              <>
                {onSnooze === undefined ? null : (
                  <Action
                    accessibilityLabel="Answer tomorrow"
                    disabled={!connected}
                    ghost
                    label="Later, tomorrow"
                    onPress={() => onSnooze(draft.draftId, snoozeUntilTomorrow())}
                  />
                )}
                {onIgnore === undefined ? null : (
                  <Action
                    accessibilityLabel="Ignore this thread"
                    disabled={!connected}
                    ghost
                    label="Ignore"
                    onPress={() => onIgnore(draft.draftId)}
                  />
                )}
              </>
            ) : onDiscard === undefined ? null : (
              <Action
                accessibilityLabel="Discard draft"
                disabled={!connected}
                ghost
                label="Discard"
                onPress={() => onDiscard(draft.draftId)}
              />
            )}
          </>
        ) : closed !== undefined ? (
          <>
            <Text style={styles.outcome}>{outcome(closed)}</Text>
            {onRestore !== undefined && (status === 'snoozed' || status === 'ignored') ? (
              <Action
                accessibilityLabel="Restore this draft"
                disabled={!connected}
                ghost
                label="Restore"
                onPress={() => onRestore(draft.draftId)}
              />
            ) : null}
          </>
        ) : null}
      </View>
      {draft.thread === undefined || !readable ? null : (
        <ThreadSheet draft={draft} onClose={closeThread} onDismiss={resumeEditing} open={threadOpen} reply={threads?.[draft.draftId]} />
      )}
    </View>
  )
}

/** Where this draft comes from, which for mail is the mailbox and never just "Gmail". */
function route(draft: DraftRecord): string {
  if (draft.channel === 'slack') return draft.slackThreadTs === undefined ? 'Slack draft' : 'Slack thread reply'
  return 'Gmail draft from Personal'
}

const when = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso))

const untilLabel = (ms: number) =>
  new Intl.DateTimeFormat('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(ms))

/**
 * What happened to it. `recorded` means the machine accepted the text without an
 * external effect, so it says that instead of claiming a send that never left.
 */
function outcome(closed: NonNullable<DraftRecord['closed']>): string {
  switch (closed.outcome) {
    case 'discarded':
      return 'Discarded.'
    case 'snoozed':
      return closed.until === undefined ? 'Later.' : `Later. Back ${untilLabel(closed.until)}.`
    case 'ignored':
      return 'Ignored. This thread stays quiet.'
    case 'submitted':
      return closed.delivery === 'delivered' ? 'Sent.' : 'Saved in this chat. Nothing was sent.'
  }
}

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
        : `${String(result.messages.length)} ${result.messages.length === 1 ? 'message' : 'messages'} · read only`
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

function Action({
  accessibilityLabel,
  disabled = false,
  ghost = false,
  icon,
  label,
  onPress,
  primary = false,
}: {
  accessibilityLabel: string
  disabled?: boolean
  ghost?: boolean
  icon?: IconSvgElement
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
      style={({ pressed }) => [
        styles.action,
        primary && styles.actionPrimary,
        ghost && styles.actionGhost,
        disabled && styles.disabled,
        pressed && styles.pressed,
      ]}
    >
      {icon === undefined ? null : (
        <HugeiconsIcon color={primary ? colors.onPrimary : colors.muted} icon={icon} size={13} strokeWidth={1.8} />
      )}
      <Text style={[styles.actionLabel, primary && styles.actionLabelPrimary]}>{label}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  bubble: { gap: spacing.sm, borderRadius: radius.lg, ...squircle, backgroundColor: colors.raised, padding: spacing.md },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  metaText: { flexShrink: 1, color: colors.muted, fontFamily: fonts.sans, fontSize: 13, fontWeight: '500' },
  to: { color: colors.dim, fontFamily: fonts.sans, fontSize: 13 },
  quote: { gap: 4, borderLeftWidth: 2, borderLeftColor: colors.line, paddingLeft: spacing.md, paddingVertical: 2 },
  quoteHead: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm },
  quoteFrom: { flexShrink: 1, color: colors.muted, fontFamily: fonts.sans, fontSize: 13 },
  quoteWhen: { color: colors.dim, fontFamily: fonts.sans, fontSize: 13 },
  quoteTail: { marginLeft: 'auto', flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  quoteMore: { color: colors.muted, fontFamily: fonts.sans, fontSize: 13, fontWeight: '500' },
  quoteText: { color: colors.muted, fontFamily: fonts.sans, fontSize: 15, lineHeight: 21 },
  subjectInput: { minHeight: 42, borderRadius: radius.md, ...squircle, backgroundColor: colors.surface, color: colors.text, fontFamily: fonts.sans, fontSize: 16, letterSpacing: tracking.body, paddingHorizontal: spacing.md },
  subject: { color: colors.text, fontFamily: fonts.sans, fontSize: 16, fontWeight: '500', lineHeight: 22 },
  // Tall enough to hold a short mail without scrolling inside a transcript row, and
  // free to grow with a longer one rather than hiding the end behind a fixed frame.
  bodyInput: { minHeight: 132, borderRadius: radius.md, ...squircle, backgroundColor: colors.surface, color: colors.text, fontFamily: fonts.sans, fontSize: 16, letterSpacing: tracking.body, lineHeight: 23, paddingHorizontal: spacing.md, paddingTop: spacing.sm, paddingBottom: spacing.sm, textAlignVertical: 'top' },
  body: { color: colors.text, fontFamily: fonts.sans, fontSize: 16, lineHeight: 23 },
  actions: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.sm },
  action: { minHeight: 34, flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: radius.sm, ...squircle, backgroundColor: colors.fill, paddingHorizontal: spacing.md },
  actionPrimary: { backgroundColor: colors.text },
  actionGhost: { backgroundColor: 'transparent', paddingHorizontal: spacing.sm },
  actionLabel: { color: colors.muted, fontFamily: fonts.sans, fontSize: 13, fontWeight: '500' },
  actionLabelPrimary: { color: colors.onPrimary },
  outcome: { flexShrink: 1, color: colors.dim, fontFamily: fonts.sans, fontSize: 13 },
  failure: { color: colors.danger, fontFamily: fonts.sans, fontSize: 13, lineHeight: 18 },
  status: { color: colors.dim, fontFamily: fonts.sans, fontSize: 13, lineHeight: 18 },
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
