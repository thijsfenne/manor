import { draftBlocks, draftDocument } from '@manor/client-runtime/slack-draft-formatting'
import { SlackDraftEditor, SlackDraftPreview } from './SlackDraftEditor'
import { outboundDraftRevision, readOutboundDraftEdit, writeOutboundDraftEdit, type OutboundDraftEdit } from '@manor/client-runtime/outbound-draft-edits'
import slackIcon from '../../../desktop/assets/Slack_icon.svg'
import { useDockDraftActions } from './outboundDockState'
import { Copy01Icon, PencilEdit02Icon, Tick02Icon } from '@hugeicons/core-free-icons'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { plainDraftText } from '@manor/client-runtime/plain-preview'
import type { OutboundDraftThread, SlackRichText } from '@manor/contracts'
import { slackRichTextFallback, SlackRichTextSchema, isOutboundSlackChannelId, OUTBOUND_DRAFT_BODY_MAX, OUTBOUND_DRAFT_SUBJECT_MAX } from '@manor/contracts'
import { draftStatus, snoozeUntilTomorrow, type DraftRecord, type WorkspaceState } from '../state'
import { copyText } from '../clipboard'
import { accentStyle } from '../accent'
import { ExternalLink } from './ExternalLink'
import { Icon } from './Icon'
import { Modal } from './Modal'
import { Button } from './ui/Button'
import { SIDE_SURFACE } from './ui/dockPanel'

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

interface OutboundDraftBubbleProps {
  draft: DraftRecord
  color: string
  connected?: boolean
  actions?: DraftActions
}

/**
 * Where this draft leaves from. Two mailboxes can reach the same address, so the
 * header names the sending account rather than only the channel.
 */
const routeLabel = (draft: DraftRecord) =>
  draft.channel === 'slack'
    ? draft.slackThreadTs === undefined
      ? 'Slack draft'
      : 'Slack thread reply'
    : 'Gmail draft from Personal'

const when = (iso: string) =>
  new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso))

const untilLabel = (ms: number) =>
  new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(ms))

export function OutboundDraftBubble({
  draft,
  color,
  connected = true,
  actions = {},
}: OutboundDraftBubbleProps) {
  const { onSubmit, onDiscard, onSnooze, onIgnore, onRestore, onReadThread, threads } = useDockDraftActions(draft, actions)
  const closed = draft.closed
  const submission = draft.submission
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
  const [threadOpen, setThreadOpen] = useState(false)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(timer.current), [])

  const copy = async () => {
    const copiedRichText = closed === undefined && submission === undefined ? editedRichText : shownRichText
    const text = (copiedRichText === undefined ? plainDraftText(closed?.body ?? submission?.body ?? body) : slackRichTextFallback(copiedRichText))
    if (!(await copyText(text))) return
    setCopied(true)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(false), 1_600)
  }

  const status = draftStatus(draft)
  const open = status === 'open'
  const routeReady = draft.channel === 'gmail' || isOutboundSlackChannelId(draft.slackChannelId)
  const canAct = open && routeReady && connected && onSubmit !== undefined && body.trim().length > 0 && validFormatting
  // Later and Ignore are decisions about the thread, and only a draft that knows its
  // thread can make them stick. Anything else keeps the plain Discard.
  const threadVerbs = draft.thread !== undefined && (onSnooze !== undefined || onIgnore !== undefined)
  // Only a mailbox can be read back in full today. A Slack thread keeps its quote and
  // its verbs, but no "Show more" that every click would fail.
  const readable = draft.channel === 'gmail' && onReadThread !== undefined

  return (
    <div
      data-outbound-card
      className={`w-full min-w-0 shrink-0 rounded-xl px-3.5 py-3 ${SIDE_SURFACE}`}
      style={accentStyle(color)}
    >
      <div className="mb-2 flex items-center gap-1.5 text-label font-medium text-muted">
        {draft.channel === 'slack' ? <img src={slackIcon} alt="" aria-hidden="true" className="size-3.5 shrink-0 object-contain" /> : <Icon icon={PencilEdit02Icon} size={14} />}
        <span>
          {routeLabel(draft)} · {draft.to}
        </span>
      </div>
      {draft.thread === undefined ? null : (
        <ThreadQuote
          thread={draft.thread}
          {...(!readable
            ? {}
            : {
                // Asked for on every opening, so the list is as fresh as the mailbox;
                // a reply from an earlier look stays on screen until this one lands.
                onMore: () => {
                  onReadThread(draft.draftId)
                  setThreadOpen(true)
                },
              })}
        />
      )}
      {draft.channel === 'gmail' ? (
        open ? (
          <input
            aria-label="Draft subject"
            className="mb-2 w-full rounded-md border border-line bg-stage px-2.5 py-1.5 text-[length:var(--msg-size,16px)] text-text [font:inherit] outline-none"
            maxLength={OUTBOUND_DRAFT_SUBJECT_MAX}
            value={subject}
            onChange={(event) => setEdit({ revision: editRevision, body, subject: event.target.value })}
          />
        ) : (closed?.subject ?? submission?.subject ?? draft.subject)?.length ? (
          <p className="mb-2 text-[length:var(--msg-size,16px)] text-text">
            {closed?.subject ?? submission?.subject ?? draft.subject}
          </p>
        ) : null
      ) : null}
      {draft.channel === 'slack' && open ? (
        <SlackDraftEditor key={editRevision} body={body} {...(slackRichText === undefined ? {} : { document: slackRichText })} onChange={(document) => setEdit({ revision: editRevision, body: slackRichTextFallback(document), subject, slackRichText: document })} />
      ) : draft.channel === 'slack' && shownRichText !== undefined ? (
        <div className="mb-3"><SlackDraftPreview document={shownRichText} /></div>
      ) : open ? (
        <textarea
          aria-label="Draft body"
          className="mb-3 min-h-[7.5rem] w-full resize-y rounded-md border border-line bg-stage px-2.5 py-2 text-[length:var(--msg-size,16px)] text-text [font:inherit] outline-none"
          maxLength={OUTBOUND_DRAFT_BODY_MAX}
          value={body}
          onChange={(event) => setEdit({ revision: editRevision, body: event.target.value, subject })}
        />
      ) : (
        <p className="mb-3 whitespace-pre-wrap text-[length:var(--msg-size,16px)] text-text">
          {closed?.body ?? submission?.body ?? draft.body}
        </p>
      )}
      {!routeReady ? (
        <p className="mb-2 text-label text-danger">Copy only: the Slack destination is missing.</p>
      ) : draft.failure !== undefined ? (
        <p className="mb-2 text-label text-danger">{draft.failure}</p>
      ) : submission !== undefined ? (
        <p className="mb-2 text-label text-dim">
          {submission.status === 'uncertain'
            ? submission.message ?? 'Delivery is uncertain. Submit stays locked to prevent a duplicate.'
            : 'Sending started. Submit stays locked to prevent a duplicate.'}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="compact"
          variant="secondary"
          aria-label={copied ? 'Copied' : 'Copy'}
          onClick={() => void copy()}
        >
          <span className="inline-flex items-center gap-1.5">
            <Icon icon={copied ? Tick02Icon : Copy01Icon} size={13} />
            {copied ? 'Copied' : 'Copy'}
          </span>
        </Button>
        {open ? (
          <>
            <Button
              size="compact"
              variant="primary"
              aria-label="Submit"
              disabled={!canAct}
              onClick={() => {
                if (!canAct || onSubmit === undefined) return
                onSubmit(draft.draftId, body, draft.channel === 'gmail' ? subject : undefined, editedRichText)
              }}
            >
              Submit
            </Button>
            {threadVerbs ? (
              <>
                {onSnooze === undefined ? null : (
                  <Button
                    size="compact"
                    variant="ghost"
                    aria-label="Answer tomorrow"
                    disabled={!connected}
                    onClick={() => onSnooze(draft.draftId, snoozeUntilTomorrow())}
                  >
                    Later, tomorrow
                  </Button>
                )}
                {onIgnore === undefined ? null : (
                  <Button
                    size="compact"
                    variant="ghost"
                    aria-label="Ignore this thread"
                    disabled={!connected}
                    onClick={() => onIgnore(draft.draftId)}
                  >
                    Ignore
                  </Button>
                )}
              </>
            ) : onDiscard === undefined ? null : (
              <Button
                size="compact"
                variant="ghost"
                aria-label="Discard draft"
                disabled={!connected}
                onClick={() => onDiscard(draft.draftId)}
              >
                Discard
              </Button>
            )}
          </>
        ) : closed !== undefined ? (
          <AnimatePresence>
            <motion.span
              key={closed.outcome}
              className="inline-flex items-center gap-2 text-label text-dim"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
            >
              {outcomeLabel(closed)}
              {onRestore !== undefined && (status === 'snoozed' || status === 'ignored') ? (
                <Button
                  size="compact"
                  variant="ghost"
                  aria-label="Restore this draft"
                  disabled={!connected}
                  onClick={() => onRestore(draft.draftId)}
                >
                  Restore
                </Button>
              ) : null}
            </motion.span>
          </AnimatePresence>
        ) : null}
      </div>
      {threadOpen && readable && draft.thread !== undefined ? (
        <ThreadModal draft={draft} reply={threads?.[draft.draftId]} onClose={() => setThreadOpen(false)} />
      ) : null}
    </div>
  )
}

/** What happened to it, in words that never claim more than the machine did. */
function outcomeLabel(closed: NonNullable<DraftRecord['closed']>): string {
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
 * the rest is the popup, never a box inside a box.
 */
function ThreadQuote({ thread, onMore }: { thread: OutboundDraftThread; onMore?: () => void }) {
  const earlier = thread.earlierCount
  return (
    <div className="mb-2.5 border-l-2 border-line pl-3">
      <div className="flex items-baseline gap-2 text-label text-dim">
        <span className="min-w-0 truncate text-muted">{thread.previous.from}</span>
        <span className="shrink-0">{when(thread.previous.at)}</span>
        <span className="ml-auto inline-flex shrink-0 items-baseline gap-1.5">
          {earlier > 0 ? <span>{`${String(earlier)} earlier`}</span> : null}
          {onMore !== undefined ? (
            <button
              type="button"
              className="cursor-pointer border-0 bg-transparent p-0 text-label text-muted [font:inherit] hover:text-text"
              onClick={onMore}
            >
              Show more
            </button>
          ) : thread.openUrl === undefined ? null : (
            <ExternalLink
              href={thread.openUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="text-label text-muted no-underline hover:text-text"
            >
              Open
            </ExternalLink>
          )}
        </span>
      </div>
      <p className="m-0 mt-1 line-clamp-3 whitespace-pre-line text-[length:var(--msg-size,16px)] leading-[1.45] text-muted">
        {thread.previous.text}
      </p>
    </div>
  )
}

/**
 * The whole thread, to read and nothing else. There is no reply control in here on
 * purpose: a second place to send is a second send path, and the bubble just closed
 * that door.
 */
function ThreadModal({
  draft,
  reply,
  onClose,
}: {
  draft: DraftRecord
  reply: OutboundThreadReply | undefined
  onClose: () => void
}) {
  const result = reply?.result
  const openUrl = result?.status === 'ready' ? result.openUrl ?? draft.thread?.openUrl : draft.thread?.openUrl
  const openLabel = draft.channel === 'gmail' ? 'Open in Gmail' : 'Open in Slack'
  const subtitle =
    result === undefined
      ? 'Loading…'
      : result.status === 'error'
        ? 'Could not load the thread'
        : `${String(result.messages.length)} ${result.messages.length === 1 ? 'message' : 'messages'} · read only`

  return (
    <Modal title={draft.subject?.trim().length ? draft.subject : draft.to} subtitle={subtitle} width="wide" onClose={onClose}>
      {result === undefined ? (
        <p className="m-0 text-label text-dim">Fetching the conversation from the mailbox…</p>
      ) : result.status === 'error' ? (
        <p className="m-0 text-label text-danger">{result.message}</p>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-4 p-0">
          {result.messages.map((message) => (
            <li key={message.id} className="min-w-0 border-t border-line pt-3 first:border-t-0 first:pt-0">
              <div className="flex flex-wrap items-baseline gap-x-2 text-label text-dim">
                <span className="text-muted">{message.from}</span>
                {message.to === undefined ? null : <span>{`to ${message.to}`}</span>}
                <span className="ml-auto">{when(message.at)}</span>
              </div>
              <p className="m-0 mt-1.5 whitespace-pre-wrap text-[15px] leading-[1.5] text-text">{message.text}</p>
            </li>
          ))}
        </ol>
      )}
      {result?.status === 'ready' && result.truncated ? (
        <p className="m-0 text-label text-dim">Only the most recent {String(result.messages.length)} messages are shown.</p>
      ) : null}
      {openUrl === undefined ? null : (
        <ExternalLink
          href={openUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="w-fit text-label text-muted no-underline hover:text-text"
        >
          {openLabel}
        </ExternalLink>
      )}
    </Modal>
  )
}
