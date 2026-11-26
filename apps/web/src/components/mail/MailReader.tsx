import { useState } from 'react'
import { Archive02Icon } from '@hugeicons/core-free-icons'
import { MAIL_LABEL_NAME, type MailCard, type MailMessage, type MailThread, type MailTriageState, type Project } from '@manor/contracts'
import { mailAttachmentSize, mailSearching, mailSenderName, mailTimeLabel, type MailTab } from '../../mail'
import { useMinuteClock } from '../../useMinuteClock'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'
import { Menu, MenuItem, useMenu } from '../ui/Menu'
import { MailEmptyState } from './MailEmptyState'
import { MailHtmlFrame } from './MailHtmlFrame'
import { MailProjectSquare } from './MailProjectSquare'

const LABEL_TONE = { reply: 'text-warn', wait: 'text-busy', fyi: '', other: '' } as const

/** The project every mail from this sender belongs to, and the menu that changes it. */
function MailProjectLink({ projects, projectId, onLink }: {
  projects: readonly Project[]
  projectId: string | undefined
  onLink: (projectId: string | null) => void
}) {
  const [menu, trigger] = useMenu({ maxHeight: 320, minHeight: 120, minWidth: 200 })
  const linked = projects.find((project) => project.id === projectId)
  // A folder taken off the pickers is not offered, but a link already made to it still shows.
  const offered = projects.filter((project) => project.unlisted !== true || project === linked)
  const pick = (next: string | null) => {
    menu.close()
    onLink(next)
  }
  return (
    <>
      <button ref={trigger} type="button" aria-haspopup="menu" aria-expanded={menu.open}
        className="-mx-1.5 flex min-w-0 cursor-pointer items-center gap-1.5 rounded-button-sm border-0 bg-transparent px-1.5 py-0.5 text-[12px] text-dim hover:bg-surface-2 hover:text-text"
        onClick={menu.toggle}>
        {linked === undefined ? 'Link to project' : (
          <>
            <MailProjectSquare name={linked.name} color={linked.color} />
            <span className="min-w-0 truncate">{linked.name}</span>
          </>
        )}
      </button>
      <Menu menu={menu} label="Link to project">
        {offered.map((project) => (
          <MenuItem key={project.id} role="menuitemradio" checked={project === linked} onClick={() => pick(project.id)}>
            <span className="flex min-w-0 items-center gap-2">
              <MailProjectSquare name={project.name} color={project.color} />
              <span className="min-w-0 truncate">{project.name}</span>
            </span>
          </MenuItem>
        ))}
        <MenuItem role="menuitemradio" checked={linked === undefined} onClick={() => pick(null)}>No project</MenuItem>
      </Menu>
    </>
  )
}

/**
 * One message. A mail that brought its own HTML is drawn from it in a sandboxed frame;
 * one without, or one whose HTML will not draw, shows its plain text, in which no markup
 * is read and nothing becomes a link.
 */
function MailMessageView({ message, first, newest, now }: { message: MailMessage; first: boolean; newest: boolean; now: number }) {
  const [unfolded, setUnfolded] = useState(false)
  const [plain, setPlain] = useState(false)
  const html = plain ? undefined : message.html
  const open = newest || unfolded
  const sender = mailSenderName(message.from)
  const time = mailTimeLabel(message.at, now)
  const header = (
    <>
      <span className={`min-w-0 truncate text-[14px] ${open ? 'font-medium text-text' : 'text-muted'}`}>{sender}</span>
      <time dateTime={new Date(message.at).toISOString()} title={new Date(message.at).toLocaleString('en-GB')} className="ml-auto flex-none text-[12px] tabular-nums text-dim">{time}</time>
    </>
  )
  return (
    <article className="border-line py-4 not-first:border-t" aria-label={`${sender}, ${time}`}>
      {newest ? <div className="flex min-w-0 items-baseline gap-3">{header}</div> : (
        <button type="button" aria-expanded={unfolded} className="flex w-full min-w-0 cursor-pointer items-baseline gap-3 border-0 bg-transparent p-0 text-left [font-family:inherit]"
          onClick={() => setUnfolded((current) => !current)}>
          {header}
        </button>
      )}
      {!open ? null : (
        <div className={`mt-2 ${html === undefined ? 'max-w-[640px]' : 'max-w-[720px]'}`}>
          {html === undefined ? (
            <div className="text-[14px] leading-[1.6] break-words whitespace-pre-wrap text-text select-text">{message.text}</div>
          ) : <MailHtmlFrame html={html} later={!first} onFail={() => setPlain(true)} />}
          {/* HTML travels whole or not at all, so only the plain text can be cut. */}
          {html !== undefined || !message.truncated ? null : <p className="m-0 mt-2 text-[12px] text-dim">The rest of this message is not shown.</p>}
          {message.attachments.length === 0 ? null : (
            <ul aria-label="Attachments" className="m-0 mt-3 flex list-none flex-col gap-1 p-0 text-[12px] text-muted">
              {message.attachments.map((attachment, index) => (
                <li key={`${index}:${attachment.name}`} className="flex min-w-0 gap-2">
                  <span className="min-w-0 truncate" title={attachment.name}>{attachment.name}</span>
                  <span className="flex-none text-dim">{mailAttachmentSize(attachment.kb)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </article>
  )
}

/**
 * The Mail stage's left pane: the bar of what can be done with the open thread, and the
 * thread. With none open the bar keeps its height empty and the stage says why.
 */
export function MailReader({ card, thread, error, listed, tab, query, triage, unlabelled, projects, split, onReply, onAdd, onArchive, onLink, onTriage }: {
  /** The open thread's card; null when none is open. */
  card: MailCard | null
  /** Its messages, once read. */
  thread: MailThread | null
  /** Why the latest read failed. */
  error: string | undefined
  /** How many cards the sidebar lists; null until the mailbox has been read. */
  listed: number | null
  tab: MailTab
  query: string
  triage: MailTriageState | null
  /** Cards no labelling run has reached yet. */
  unlabelled: number
  projects: readonly Project[]
  split: boolean
  onReply: () => void
  onAdd: () => void
  onArchive: () => void
  onLink: (address: string, projectId: string | null) => void
  /** Starts a labelling run; absent when there is no agent to run it. */
  onTriage?: (() => void) | undefined
}) {
  const now = useMinuteClock()
  const empty = card !== null || listed === null || triage === null ? null : (
    <MailEmptyState kind={listed > 0 ? 'pick' : mailSearching(query) ? 'search' : tab}
      triage={triage} unlabelled={unlabelled} onTriage={onTriage} />
  )
  return (
    <div className="relative flex h-full min-h-0 min-w-0 flex-col">
      <div role="toolbar" aria-label="Mail actions" className="flex min-h-14 flex-none items-center gap-1.5 px-4 py-3">
        {card === null ? null : (
          <>
            <Button size="small" disabled={thread === null} title="Draft a reply (R)" onClick={onReply}>Reply</Button>
            <Button size="small" disabled={thread === null} title="Add to chat (A)" onClick={onAdd}>Add to chat</Button>
            <span className="flex-1" />
            <IconButton icon={Archive02Icon} iconSize={17} label="Archive" title="Archive (E)" onClick={onArchive} />
          </>
        )}
      </div>
      {empty}
      {card === null ? null : (
        <div className={`min-h-0 flex-1 overflow-y-auto pt-2 pb-10 ${split ? 'px-7' : 'px-10'}`}>
          <h2 className="m-0 mb-2 text-[20px] font-medium break-words text-text">{card.subject}</h2>
          <div className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-dim">
            <span className="min-w-0 break-all select-text">{card.from.address}</span>
            {card.label === undefined ? null : <span className={LABEL_TONE[card.label]} title={card.reason}>{MAIL_LABEL_NAME[card.label]}</span>}
            {/* Keyed so an open menu never carries over to another sender. */}
            <MailProjectLink key={card.threadId} projects={projects} projectId={card.projectId} onLink={(projectId) => onLink(card.from.address, projectId)} />
          </div>
          {error === undefined ? null : <p role="alert" className="m-0 mb-4 text-[13px] break-words text-warn">{error}</p>}
          {thread === null ? null : thread.messages.map((message, index) => (
            <MailMessageView key={`${thread.threadId}:${message.id}`} message={message} first={index === 0} newest={index === thread.messages.length - 1} now={now} />
          ))}
        </div>
      )}
    </div>
  )
}
