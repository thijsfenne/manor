import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Cancel01Icon } from '@hugeicons/core-free-icons'
import { MAIL_DRAFT_BODY_MAX, MAIL_INSTRUCTION_MAX, MAIL_RECIPIENTS_MAX, mailNewRecipients, type AgentConfig, type MailThread } from '@manor/contracts'
import { NO_CHAT_COMMANDS } from '@manor/client-runtime/chat-commands'
import type { MailDraft, MailOutcome } from '@manor/client-runtime/mail'
import { toast } from '../../notices'
import { Composer } from '../Composer'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'

/** What the host has said about the reply this pane is open for. */
export interface MailDraftsState {
  /** The draft of the latest `onStart`, its `text` always whole; undefined before one left. */
  draft: MailDraft | undefined
  /** A send left and has no answer yet. */
  sending: boolean
  /** The answer to the latest send; `ok` means delivery was confirmed. */
  sendResult: MailOutcome | undefined
}

export interface MailDraftPaneProps {
  thread: MailThread
  /** The default agent, who writes the draft. */
  agent: AgentConfig | null
  drafts: MailDraftsState
  onClose: () => void
  /** Asks for a new draft; `instruction` with `current` asks for a new version of that text. */
  onStart: (instruction?: string, current?: string) => boolean
  onStop: () => void
  onSend: (to: string, cc: string, body: string) => void
}

const NOT_IN_THREAD = 'Not in this thread'
const NO_AGENTS: AgentConfig[] = []
const noChatCommands = () => NO_CHAT_COMMANDS

const FIELD_ROW = 'flex min-w-0 items-baseline gap-3 border-b border-line py-2'
/** A fixed column wide enough for Subject, so the three values start on one line. */
const FIELD_LABEL = 'w-[52px] flex-none text-meta text-dim'
const FIELD_VALUE = 'min-w-0 flex-1 truncate text-[13px] leading-[18px]'

/**
 * One recipient row. At rest it lists the entries, each one the thread never saw in the
 * warn colour, because a reply that quietly reaches a stranger is how mail leaks; a
 * click turns it into a quiet inline field.
 */
function RecipientField({ label, value, fresh, onChange, onEscape }: {
  label: string
  value: string
  fresh: readonly string[]
  onChange: (value: string) => void
  onEscape: () => void
}) {
  const [editing, setEditing] = useState(false)
  const entries = value.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '')
  return (
    <div className={FIELD_ROW}>
      <span className={FIELD_LABEL}>{label}</span>
      {editing ? (
        <input aria-label={label} autoFocus value={value} spellCheck={false} maxLength={MAIL_RECIPIENTS_MAX}
          className={`${FIELD_VALUE} h-[18px] border-0 bg-transparent p-0 text-text outline-none`}
          onChange={(event) => onChange(event.target.value)} onBlur={() => setEditing(false)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
            if (event.key !== 'Escape') return
            event.preventDefault()
            event.stopPropagation()
            onEscape()
          }} />
      ) : (
        <button type="button" aria-label={`Edit ${label}`}
          className={`${FIELD_VALUE} cursor-text border-0 bg-transparent p-0 text-left text-text`}
          onClick={() => setEditing(true)}>
          {entries.length === 0 ? <span className="text-dim">Add {label}</span> : entries.map((entry, index) => (
            <span key={`${index}:${entry}`}>
              {index === 0 ? null : ', '}
              {fresh.includes(entry) ? <span className="text-warn" title={NOT_IN_THREAD}>{entry}</span> : entry}
            </span>
          ))}
        </button>
      )}
    </div>
  )
}

/**
 * The reply split beside the open thread. One pane serves one thread: opening it asks
 * for a draft, the stream fills the text, and once it is done the text is the user's to
 * edit, kept until a new version is asked for in the composer at its foot. Only Send
 * makes anything leave.
 */
export function MailDraftPane({ thread, agent, drafts, onClose, onStart, onStop, onSend }: MailDraftPaneProps) {
  const [to, setTo] = useState(thread.reply.to)
  const [cc, setCc] = useState(thread.reply.cc)
  const [body, setBody] = useState('')
  const [askError, setAskError] = useState<string | null>(null)
  const sentTo = useRef('')
  const { draft, sending, sendResult } = drafts
  const streaming = draft?.status === 'streaming'

  const started = useRef(false)
  useEffect(() => {
    // Once per pane, also where React runs a mount's effects twice.
    if (started.current) return
    started.current = true
    onStart()
  }, [])

  // A finished or stopped stream becomes the text; a failure that wrote nothing keeps
  // what was there. After that the text is the user's until the next version is asked for.
  const settled = draft === undefined || streaming ? undefined : `${draft.draftId}:${draft.status}`
  useEffect(() => {
    if (draft === undefined || settled === undefined) return
    if (draft.status === 'done' || draft.text !== '') setBody(draft.text)
  }, [settled])

  useEffect(() => {
    if (sendResult?.ok !== true) return
    toast.success(`Sent to ${sentTo.current}`)
    onClose()
  }, [sendResult])

  const shown = streaming ? draft.text : body
  const fresh = mailNewRecipients(thread, to, cc)
  const canSend = !streaming && !sending && body.trim() !== '' && to.trim() !== ''
  const send = () => {
    if (!canSend) return
    sentTo.current = to.trim()
    onSend(to.trim(), cc.trim(), body)
  }
  // False keeps the request in the composer.
  const revise = (instruction: string) => {
    if (streaming) return false
    if (instruction.length > MAIL_INSTRUCTION_MAX) {
      setAskError(`A request can be at most ${MAIL_INSTRUCTION_MAX.toLocaleString('en-GB')} characters.`)
      return false
    }
    setAskError(null)
    return onStart(instruction, body)
  }
  // The Mail view leaves keys typed in fields alone, so Escape in the pane's own fields closes it here.
  const escapes = (event: ReactKeyboardEvent) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    onClose()
  }
  const problem = askError ?? draft?.message

  return (
    <aside aria-label="Reply draft" className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="flex min-h-14 flex-none items-center gap-2 py-3 pr-3 pl-5">
        <h2 className="m-0 min-w-0 flex-1 truncate text-[14px] font-medium text-text">Reply</h2>
        <IconButton icon={Cancel01Icon} label="Close" title="Close (Esc)" onClick={onClose} />
      </div>
      <div className="mx-5 flex flex-none flex-col">
        <RecipientField label="To" value={to} fresh={fresh} onChange={setTo} onEscape={onClose} />
        <RecipientField label="Cc" value={cc} fresh={fresh} onChange={setCc} onEscape={onClose} />
        <div className={FIELD_ROW}>
          <span className={FIELD_LABEL}>Subject</span>
          <span className={`${FIELD_VALUE} text-text`} title={thread.reply.subject}>{thread.reply.subject}</span>
        </div>
      </div>
      {/* A hairline as well as the fill: the surface is the stage's own colour. */}
      <div className="mx-5 mt-4 flex min-h-0 flex-1 flex-col rounded-panel border border-line bg-surface">
        <textarea aria-label="Reply text" value={shown} readOnly={streaming} spellCheck maxLength={MAIL_DRAFT_BODY_MAX}
          className="min-h-0 flex-1 resize-none border-0 bg-transparent px-4 pt-3.5 pb-2 text-[14px] leading-[1.6] text-text outline-none"
          onChange={(event) => setBody(event.target.value)} onKeyDown={escapes} />
        <div className="flex flex-none items-center gap-1.5 px-3 pt-1 pb-3">
          <div className="min-w-0 flex-1 pl-1">
            {problem !== undefined ? <p role="alert" className="m-0 break-words text-meta text-warn">{problem}</p>
              : streaming && shown === '' ? <p role="status" className="m-0 text-meta text-dim">Writing…</p>
              : null}
          </div>
          <Button variant="ghost" size="small" onClick={onClose}>Discard</Button>
          <Button variant="primary" size="small" disabled={!canSend} onClick={send}>{sending ? 'Sending…' : 'Send'}</Button>
        </div>
      </div>
      <div className="flex min-w-0 flex-none flex-col px-5 pt-3 pb-4">
        <Composer
          agents={NO_AGENTS}
          commandContext={noChatCommands}
          // A request to the agent about this one draft: nobody else to address, nothing to attach or run.
          allowAgentMentions={false}
          allowWorkDestination={false}
          allowBrowserMentions={false}
          allowComputerMentions={false}
          allowAttachments={false}
          allowSkills={false}
          compact
          placeholder={agent === null ? 'Ask for a change' : `Ask ${agent.name} to change it`}
          draftKey={`mail:${thread.threadId}`}
          onSend={(text) => revise(text)}
          canSend={!streaming && !sending}
          blockedNote={streaming ? 'Wait for this version to finish' : 'Sending the reply…'}
          running={streaming}
          onStop={onStop}
          onEscapeIdle={onClose}
        />
      </div>
    </aside>
  )
}
