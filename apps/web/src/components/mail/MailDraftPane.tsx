import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { ArrowUp02Icon, Cancel01Icon, StopIcon } from '@hugeicons/core-free-icons'
import { motion, useReducedMotion } from 'motion/react'
import { MAIL_DRAFT_BODY_MAX, MAIL_INSTRUCTION_MAX, MAIL_RECIPIENTS_MAX, mailNewRecipients, type AgentConfig, type MailThread } from '@manor/contracts'
import type { MailDraft, MailOutcome } from '@manor/client-runtime/mail'
import { accentStyle } from '../../accent'
import { toast } from '../../notices'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'
import { MailAgentOrb } from './MailAgentOrb'

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
  onStart: (instruction?: string, current?: string) => void
  onStop: () => void
  onSend: (to: string, cc: string, body: string) => void
}

const NOT_IN_THREAD = 'Not in this thread'
/** Inline, because the shared control's own corner class would win over a class here. */
const ROUND = { borderRadius: '9999px' }

/**
 * One recipient line. At rest it lists the entries, each one the thread never saw in the
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
    <div className="flex min-w-0 items-baseline gap-1.5">
      <span className="flex-none">{label}</span>
      {editing ? (
        <input aria-label={label} autoFocus value={value} spellCheck={false} maxLength={MAIL_RECIPIENTS_MAX}
          className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[12px] text-text outline-none"
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
          className="min-w-0 flex-1 cursor-text truncate border-0 bg-transparent p-0 text-left text-[12px] text-dim"
          onClick={() => setEditing(true)}>
          {entries.length === 0 ? <span className="text-dim">Add {label}</span> : entries.map((entry, index) => (
            <span key={`${index}:${entry}`}>
              {index === 0 ? null : ', '}
              {fresh.includes(entry)
                ? <span className="text-warn" title={NOT_IN_THREAD}>{entry}</span>
                : <span className="text-muted">{entry}</span>}
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
 * edit, kept until a new version is asked for. Only Send makes anything leave.
 */
export function MailDraftPane({ thread, agent, drafts, onClose, onStart, onStop, onSend }: MailDraftPaneProps) {
  const reduce = useReducedMotion() ?? false
  const [to, setTo] = useState(thread.reply.to)
  const [cc, setCc] = useState(thread.reply.cc)
  const [body, setBody] = useState('')
  const [instruction, setInstruction] = useState('')
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
  const revise = () => {
    const asked = instruction.trim()
    if (asked === '' || streaming) return
    onStart(asked, body)
    setInstruction('')
  }
  // The Mail view leaves keys typed in fields alone, so Escape in the pane's own fields closes it here.
  const escapes = (event: ReactKeyboardEvent) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    onClose()
  }

  return (
    <aside aria-label="Reply draft" className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="flex min-h-14 flex-none items-center gap-2 px-5 py-3">
        <MailAgentOrb agent={agent} />
        <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-text">{agent?.name}</span>
        <IconButton icon={Cancel01Icon} label="Close" title="Close (Esc)" onClick={onClose} />
      </div>
      <div className="flex flex-none flex-col gap-1 px-5 pb-2 text-[12px] text-dim">
        <RecipientField label="To" value={to} fresh={fresh} onChange={setTo} onEscape={onClose} />
        <RecipientField label="Cc" value={cc} fresh={fresh} onChange={setCc} onEscape={onClose} />
        <div className="truncate" title={thread.reply.subject}>{thread.reply.subject}</div>
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <textarea aria-label="Reply text" value={shown} readOnly={streaming} spellCheck maxLength={MAIL_DRAFT_BODY_MAX}
          className="min-h-0 flex-1 resize-none border-0 bg-transparent px-5 py-3 text-[14px] leading-[1.6] text-text outline-none"
          onChange={(event) => setBody(event.target.value)} onKeyDown={escapes} />
        {streaming && shown === '' ? (
          <motion.span aria-label={`${agent?.name ?? 'The agent'} is writing`} role="status"
            className="pointer-events-none absolute top-[21px] left-5 size-[7px] rounded-full bg-[var(--accent)]"
            style={agent === null ? undefined : accentStyle(agent.color)}
            animate={reduce ? { opacity: 1 } : { opacity: [0.35, 1, 0.35] }}
            transition={reduce ? { duration: 0 } : { duration: 1.2, repeat: Infinity, ease: 'easeInOut' }} />
        ) : null}
        {draft?.message === undefined ? null : <p role="alert" className="m-0 px-5 pb-2 text-[13px] text-warn">{draft.message}</p>}
      </div>
      <div className="flex flex-none justify-end gap-1.5 px-5 pb-3">
        <Button variant="ghost" size="small" onClick={onClose}>Discard</Button>
        <Button variant="primary" size="small" disabled={!canSend} onClick={send}>{sending ? 'Sending…' : 'Send'}</Button>
      </div>
      <form className="mx-5 mb-4 flex flex-none items-center gap-2 rounded-panel bg-surface px-3 py-1.5"
        onSubmit={(event) => {
          event.preventDefault()
          revise()
        }}>
        <input aria-label="Change the draft" value={instruction} maxLength={MAIL_INSTRUCTION_MAX} placeholder={`Ask ${agent?.name ?? 'the agent'} to change it`}
          className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] text-text outline-none placeholder:text-dim"
          onChange={(event) => setInstruction(event.target.value)} onKeyDown={escapes} />
        {streaming ? (
          <IconButton icon={StopIcon} size={26} label="Stop" title="Stop writing" style={ROUND} onClick={onStop} />
        ) : (
          <IconButton icon={ArrowUp02Icon} size={26} label="Ask for a new version" type="submit"
            style={ROUND} disabled={instruction.trim() === ''} />
        )}
      </form>
    </aside>
  )
}
