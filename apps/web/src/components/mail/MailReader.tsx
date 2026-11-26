import { useState } from 'react'
import { Archive02Icon } from '@hugeicons/core-free-icons'
import { MAIL_LABEL_NAME, type AgentConfig, type MailCard, type MailMessage, type MailThread, type Project } from '@manor/contracts'
import { mailAttachmentSize, mailSenderName, mailTimeLabel } from '../../mail'
import { useMinuteClock } from '../../useMinuteClock'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'
import { Menu, MenuItem, useMenu } from '../ui/Menu'
import { MailAgentOrb, MailProjectSquare } from './MailAgentOrb'

const LABEL_TONE = { reply: 'text-warn', wait: 'text-busy', fyi: '' } as const

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
 * One message. Its text is drawn as plain text only: no markup is read from it and
 * nothing in it becomes a link.
 */
function MailMessageView({ message, newest, now }: { message: MailMessage; newest: boolean; now: number }) {
  const [unfolded, setUnfolded] = useState(false)
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
        <div className="mt-2 max-w-[640px]">
          <div className="text-[14px] leading-[1.6] break-words whitespace-pre-wrap text-text select-text">{message.text}</div>
          {!message.truncated ? null : <p className="m-0 mt-2 text-[12px] text-dim">The rest of this message is not shown.</p>}
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

/** The Mail stage's left pane: the bar of what can be done with the open thread, and the thread. */
export function MailReader({ card, thread, error, empty, agent, projects, split, onReply, onAdd, onArchive, onLink }: {
  /** The open thread's card; null when none is open. */
  card: MailCard | null
  /** Its messages, once read. */
  thread: MailThread | null
  /** Why the latest read failed. */
  error: string | undefined
  /** The listed cards are none. */
  empty: boolean
  agent: AgentConfig | null
  projects: readonly Project[]
  split: boolean
  onReply: () => void
  onAdd: () => void
  onArchive: () => void
  onLink: (address: string, projectId: string | null) => void
}) {
  const now = useMinuteClock()
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div role="toolbar" aria-label="Mail actions" className="flex min-h-14 flex-none items-center gap-1.5 px-4 py-3">
        <Button variant="primary" size="small" className="flex items-center gap-1.5" disabled={thread === null}
          title={agent === null ? undefined : `${agent.name} drafts a reply (R)`} onClick={onReply}>
          <MailAgentOrb agent={agent} />
          Reply
        </Button>
        <Button size="small" disabled={thread === null} title="Add to chat (A)" onClick={onAdd}>Add to chat</Button>
        <span className="flex-1" />
        <IconButton icon={Archive02Icon} iconSize={17} label="Archive" title="Archive (E)" disabled={card === null} onClick={onArchive} />
      </div>
      <div className={`min-h-0 flex-1 overflow-y-auto pt-2 pb-10 ${split ? 'px-7' : 'px-10'}`}>
        {empty ? <p className="m-0 text-[14px] text-muted">No mail in this view.</p> : card === null ? null : (
          <>
            <h2 className="m-0 mb-2 text-[20px] font-medium break-words text-text">{card.subject}</h2>
            <div className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-dim">
              <span className="min-w-0 break-all select-text">{card.from.address}</span>
              {card.label === undefined ? null : <span className={LABEL_TONE[card.label]} title={card.reason}>{MAIL_LABEL_NAME[card.label]}</span>}
              {/* Keyed so an open menu never carries over to another sender. */}
              <MailProjectLink key={card.threadId} projects={projects} projectId={card.projectId} onLink={(projectId) => onLink(card.from.address, projectId)} />
            </div>
            {error === undefined ? null : <p role="alert" className="m-0 mb-4 text-[13px] break-words text-warn">{error}</p>}
            {thread === null ? null : thread.messages.map((message, index) => (
              <MailMessageView key={`${thread.threadId}:${message.id}`} message={message} newest={index === thread.messages.length - 1} now={now} />
            ))}
          </>
        )}
      </div>
    </div>
  )
}
