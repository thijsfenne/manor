import { draftBlocks, draftDocument } from '@manor/client-runtime/slack-draft-formatting'
import { SlackDraftEditor, SlackDraftPreview } from './SlackDraftEditor'
import { outboundDraftRevision, readOutboundDraftEdit, writeOutboundDraftEdit, type OutboundDraftEdit } from '@manor/client-runtime/outbound-draft-edits'
import { Mail01Icon, SlackIcon, UnfoldMoreIcon } from '@hugeicons/core-free-icons'
import { useState, type ReactNode } from 'react'
import type { OutboundDraftThread, SlackRichText } from '@manor/contracts'
import { slackRichTextFallback, SlackRichTextSchema, isOutboundSlackChannelId, OUTBOUND_DRAFT_BODY_MAX, OUTBOUND_DRAFT_SUBJECT_MAX, OUTBOUND_DRAFT_TO_MAX } from '@manor/contracts'
import { draftSettled, draftShown, draftStatus, draftStatusLabel, snoozeUntilTomorrow, type DraftRecord, type WorkspaceState } from '../state'
import { accentStyle } from '../accent'
import { ExternalLink } from './ExternalLink'
import { Icon } from './Icon'
import { Modal } from './Modal'
import { Button } from './ui/Button'

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

interface OutboundDraftBubbleProps {
  draft: DraftRecord
  color: string
  connected?: boolean
  actions?: DraftActions
  /**
   * Set by a list of drafts, which unfolds one card at a time. Absent, the card keeps
   * its own fold: unfolded while it waits for a decision, folded once it is taken.
   */
  unfolded?: boolean
  onToggle?: () => void
}

const when = (iso: string) =>
  new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso))

const untilLabel = (ms: number) =>
  new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(ms))

/** Body type for the card, the chat's own size so a mail reads like the reply around it. */
const BODY_TEXT = 'text-[length:var(--msg-size,16px)] leading-[1.5] text-text'
/** A field that reads as plain text: no box, no handle, it grows with what is typed. */
const PLAIN_FIELD = 'w-full min-w-0 border-0 bg-transparent p-0 text-text [font:inherit] outline-none placeholder:text-dim'

/**
 * One outbound message, Gmail or Slack, inside the turn that wrote it. Open, it is the
 * mail as it will leave, editable in place. Once Send, Discard, Later or Ignore is
 * taken it folds to its header, and the header reopens it to read, never to act.
 */
export function OutboundDraftBubble({
  draft,
  color,
  connected = true,
  actions = {},
  unfolded,
  onToggle,
}: OutboundDraftBubbleProps) {
  const { onSubmit, onDiscard, onSnooze, onIgnore, onRestore, onReadThread, threads } = actions
  const closed = draft.closed
  const submission = draft.submission
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
  const [threadOpen, setThreadOpen] = useState(false)
  const settled = draftSettled(draft)
  // A card picked to be re-read stays open until it is folded again; a fresh decision folds it.
  const [reread, setReread] = useState<string | undefined>(undefined)
  const rereadOpen = reread === `${draftStatus(draft)}:${draft.draftId}`
  const expanded = unfolded ?? (!settled || rereadOpen)
  const toggle = onToggle ?? (settled ? () => setReread(rereadOpen ? undefined : `${draftStatus(draft)}:${draft.draftId}`) : undefined)

  const status = draftStatus(draft)
  const open = status === 'open'
  const routeReady = draft.channel === 'gmail' || isOutboundSlackChannelId(draft.slackChannelId)
  const canAct = open && routeReady && connected && onSubmit !== undefined && body.trim().length > 0 && validFormatting
  // Later and Ignore are decisions about the thread, and only a draft that knows its
  // thread can make them stick. Anything else keeps the plain Discard.
  const threadVerbs = draft.thread !== undefined && (onSnooze !== undefined || onIgnore !== undefined)
  // Only a mailbox can be read back in full today. A Slack thread keeps its quote and
  // its verbs, but no "Show more" that every click would fail.
  const readable = draft.channel === 'gmail' && onReadThread !== undefined && draft.fullThread !== false
  const shown = draftShown(draft)
  // A reply keeps its thread's subject, so only new mail can retitle itself.
  const subjectEditable = open && draft.thread === undefined
  const shownSubject = subjectEditable ? subject : open ? (draft.subject ?? '') : shown.subject
  const shownCc = open ? cc : shown.cc
  const showHeaderStatus = !expanded || !open
  const restorable = onRestore !== undefined && (status === 'snoozed' || status === 'ignored')

  return (
    <div
      data-outbound-card={status}
      className="w-full min-w-0 shrink-0 rounded-dock border border-line bg-bubble"
      style={accentStyle(color)}
    >
      <CardHeader
        channel={draft.channel}
        expanded={expanded}
        {...(toggle === undefined ? {} : { onToggle: toggle })}
        status={showHeaderStatus ? `${draftStatusLabel(draft)}${status === 'snoozed' && closed?.until !== undefined ? `, back ${untilLabel(closed.until)}` : ''} · ${draft.to}` : undefined}
        tone={status === 'open' && draft.failure !== undefined ? 'text-danger' : 'text-muted'}
        action={restorable ? (
          <Button
            size="compact"
            variant="ghost"
            aria-label="Restore this draft"
            disabled={!connected}
            onClick={() => onRestore(draft.draftId)}
          >
            Restore
          </Button>
        ) : undefined}
      />
      <div className="fold" data-open={expanded}>
        <div>
          <div className="px-5 pb-4">
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
              subjectEditable ? (
                <input
                  aria-label="Draft subject"
                  placeholder="Subject"
                  className={`${PLAIN_FIELD} mb-1 font-medium text-[length:var(--msg-size,16px)]`}
                  maxLength={OUTBOUND_DRAFT_SUBJECT_MAX}
                  value={subject}
                  onChange={(event) => setEdit({ subject: event.target.value })}
                />
              ) : shownSubject.length > 0 ? (
                <p className="m-0 mb-1 font-medium text-[length:var(--msg-size,16px)] text-text">{shownSubject}</p>
              ) : null
            ) : null}
            <dl className="m-0 mb-3 text-[15px]">
              {draft.channel === 'gmail' ? <Field label="From">{draft.from ?? 'Personal Gmail'}</Field> : null}
              <Field label="To">{draft.to}</Field>
              {draft.channel !== 'gmail' ? null : open ? (
                <Field label="Cc">
                  <input
                    aria-label="Draft Cc"
                    placeholder="Add Cc"
                    className={PLAIN_FIELD}
                    maxLength={OUTBOUND_DRAFT_TO_MAX}
                    value={cc}
                    onChange={(event) => setEdit({ cc: event.target.value })}
                  />
                </Field>
              ) : shownCc.length > 0 ? <Field label="Cc">{shownCc}</Field> : null}
            </dl>
            {draft.channel === 'slack' && open ? (
              <SlackDraftEditor key={editRevision} body={body} {...(slackRichText === undefined ? {} : { document: slackRichText })} onChange={(document) => setEdit({ body: slackRichTextFallback(document), slackRichText: document })} />
            ) : draft.channel === 'slack' && shownRichText !== undefined ? (
              <SlackDraftPreview document={shownRichText} />
            ) : open ? (
              <textarea
                aria-label="Draft body"
                className={`${PLAIN_FIELD} ${BODY_TEXT} block min-h-[6rem] resize-none [field-sizing:content]`}
                maxLength={OUTBOUND_DRAFT_BODY_MAX}
                value={body}
                onChange={(event) => setEdit({ body: event.target.value })}
              />
            ) : (
              <p className={`m-0 whitespace-pre-wrap ${BODY_TEXT}`}>
                {shown.body}
              </p>
            )}
            {!routeReady ? (
              <p className="m-0 mt-3 text-label text-danger">The Slack destination is missing, so this cannot be sent.</p>
            ) : draft.failure !== undefined && open ? (
              <p className="m-0 mt-3 text-label text-danger">{draft.failure}</p>
            ) : submission !== undefined ? (
              <p className="m-0 mt-3 text-label text-dim">
                {submission.status === 'uncertain'
                  ? submission.message ?? 'Delivery is uncertain. Send stays locked to prevent a duplicate.'
                  : 'Sending. Send stays locked to prevent a duplicate.'}
              </p>
            ) : closed?.outcome === 'submitted' && closed.delivery !== 'delivered' ? (
              <p className="m-0 mt-3 text-label text-dim">Saved in this chat. Nothing was sent.</p>
            ) : null}
            {open ? (
              <div className="mt-4 flex flex-wrap items-center justify-end gap-1">
                {threadVerbs ? (
                  <>
                    {onSnooze === undefined ? null : (
                      <Button size="medium" variant="ghost" aria-label="Answer tomorrow" disabled={!connected} onClick={() => onSnooze(draft.draftId, snoozeUntilTomorrow())}>
                        Later
                      </Button>
                    )}
                    {onIgnore === undefined ? null : (
                      <Button size="medium" variant="ghost" aria-label="Ignore this thread" disabled={!connected} onClick={() => onIgnore(draft.draftId)}>
                        Ignore
                      </Button>
                    )}
                  </>
                ) : null}
                {onDiscard === undefined || threadVerbs ? null : (
                  <Button size="medium" variant="ghost" aria-label="Discard draft" disabled={!connected} onClick={() => onDiscard(draft.draftId)}>
                    Discard
                  </Button>
                )}
                <Button
                  size="medium"
                  variant="primary"
                  className="ml-1 rounded-full px-5"
                  aria-label="Send"
                  disabled={!canAct}
                  onClick={() => {
                    if (!canAct || onSubmit === undefined) return
                    if (draft.channel === 'gmail') onSubmit(draft.draftId, body, subjectEditable ? subject : undefined, editedRichText, cc)
                    else onSubmit(draft.draftId, body, undefined, editedRichText)
                  }}
                >
                  Send
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      </div>
      {threadOpen && readable && draft.thread !== undefined ? (
        <ThreadModal draft={draft} reply={threads?.[draft.draftId]} onClose={() => setThreadOpen(false)} />
      ) : null}
    </div>
  )
}

/**
 * The app tile and its name, plus where the draft stands once that is the news. The
 * whole row is the fold toggle whenever there is something folded to reopen.
 */
function CardHeader({ channel, expanded, onToggle, status, tone, action }: {
  channel: DraftRecord['channel']
  expanded: boolean
  onToggle?: () => void
  status: string | undefined
  tone: string
  action: ReactNode
}) {
  const label = channel === 'slack' ? 'Slack' : 'Mail'
  const content = (
    <>
      <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-user-bg text-text">
        <Icon icon={channel === 'slack' ? SlackIcon : Mail01Icon} size={16} />
      </span>
      <span className="text-[15px] text-text">{label}</span>
      {status === undefined ? null : <span className={`min-w-0 flex-1 truncate text-[15px] ${tone}`}>{status}</span>}
    </>
  )
  return (
    <div className="flex min-w-0 items-center gap-2 px-3.5 py-3">
      {onToggle === undefined ? (
        <div className="flex min-w-0 flex-1 items-center gap-2.5">{content}</div>
      ) : (
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={expanded ? `Fold ${label.toLowerCase()} card` : `Open ${label.toLowerCase()} card`}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 border-0 bg-transparent p-0 text-left [font:inherit]"
          onClick={onToggle}
        >
          {content}
          <span className="ml-auto grid size-7 shrink-0 place-items-center rounded-md text-dim">
            <Icon icon={UnfoldMoreIcon} size={16} />
          </span>
        </button>
      )}
      {action}
    </div>
  )
}

/** One header line of the mail, label muted, divided from the next by a hairline. */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline gap-2 border-b border-line py-2.5">
      <dt className="shrink-0 text-muted">{label}</dt>
      <dd className="m-0 min-w-0 flex-1 truncate text-text">{children}</dd>
    </div>
  )
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
