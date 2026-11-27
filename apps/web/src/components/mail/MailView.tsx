import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { RefreshIcon } from '@hugeicons/core-free-icons'
import type { AgentConfig, Chat, Project } from '@manor/contracts'
import type { createWorkspaceCommands } from '@manor/client-runtime/commands'
import { mailCards, type MailState } from '@manor/client-runtime/mail'
import {
  listedMailCards, mailKeyAction, mailNeighbour, mailRange, steppedMailSelection, toggledMailSelection, unlabelledMailCount, type MailKeyAction,
} from '../../mail'
import { toast } from '../../notices'
import { cosOf } from '../../persona'
import type { ConnectionStatus } from '../../useWorkspace'
import { useStableCallback } from '../../useStableCallback'
import { useHeaderRows } from '../TopBar'
import { WorkspaceHeader } from '../WorkspaceHeader'
import { IconButton } from '../ui/IconButton'
import { MailAddToChatDialog, type MailChatDoor } from './MailAddToChatDialog'
import { MailDraftPane } from './MailDraftPane'
import { MailReader } from './MailReader'
import { MailSidebar, MailTriageButton, type MailPick } from './MailSidebar'
import { changeMailReply, dropMailReplies, mailView, openMailReply, setMailView, useMailView } from './mailViewStore'

export type MailCommands = Pick<ReturnType<typeof createWorkspaceCommands>,
  | 'loadMail' | 'openMailThread' | 'setMailLabel' | 'linkMailSender' | 'archiveMailThread'
  | 'unarchiveMailThread' | 'runMailTriage' | 'startMailDraft' | 'stopMailDraft' | 'sendMail'>

/** A key typed into a field is text, never a command of the view. */
const typing = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

const newId = (kind: string) => `mail-${kind}-${crypto.randomUUID()}`

const PANE_TRAVEL = 'min-h-0 min-w-0 duration-[280ms] ease-[var(--ease-arrive)] motion-safe:transition-[flex-basis]'

/**
 * The Mail door: the stage, and through the two sidebar slots the list beside it and the
 * triage button in its title row. Its keys work only while it is on screen.
 */
export function MailView({ mail, agents, projects, chats, chatDoor, status, commands, settingsOpen, sidebarSlot, actionSlot, sidebarCollapsed, onToggleSidebar }: {
  mail: MailState
  agents: AgentConfig[]
  projects: readonly Project[]
  chats: readonly Chat[]
  chatDoor: MailChatDoor
  status: ConnectionStatus
  commands: MailCommands
  settingsOpen: boolean
  sidebarSlot: HTMLElement | null
  actionSlot: HTMLElement | null
  sidebarCollapsed: boolean
  onToggleSidebar?: () => void
}) {
  const { selectedId, tab, query, picked, replies } = useMailView()
  const cards = mailCards(mail)
  const listed = listedMailCards(cards, tab, query)
  const unlabelled = unlabelledMailCount(cards)
  // A thread stays open when a new label or search takes its card off the list, but an
  // empty list has the stage to itself, unless a reply is being written there.
  const current = listed.length === 0 && (selectedId === null || replies[selectedId] === undefined)
    ? null
    : cards.find((entry) => entry.threadId === selectedId) ?? null
  // Only listed cards count as picked, in list order; a pick of two or more hides the thread.
  const pickedListed = listed.filter((entry) => picked.includes(entry.threadId)).map((entry) => entry.threadId)
  const many = pickedListed.length > 1
  const selection = many ? pickedListed : []
  const card = many ? null : current
  const openId = card?.threadId ?? null
  // Where a Shift click starts: the card last clicked, else the open mail.
  const anchor = useRef<string | null>(null)
  const thread = openId === null ? null : mail.threads[openId] ?? null
  const agent = cosOf(agents)
  const headerRows = useHeaderRows()
  const search = useRef<HTMLInputElement>(null)
  const [adding, setAdding] = useState<string | null>(null)
  // The open thread's reply, which shows once the thread is read.
  const replying = thread === null ? null : replies[thread.threadId] ?? null
  const live = status === 'live'

  // Opening the door, a reconnect and every return to the window ask the host to look again.
  const refresh = useStableCallback(() => { commands.loadMail(true) })
  useEffect(() => {
    if (!live) return
    refresh()
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [live, refresh])

  // Also again when the open thread gains mail. The held copy shows while the read runs.
  const read = useStableCallback((threadId: string) => { commands.openMailThread(newId('open'), threadId) })
  useEffect(() => {
    if (live && openId !== null) read(openId)
  }, [live, openId, card?.at, card?.messageCount, read])

  // A reply belongs to its thread and outlives the view, another mail and a pick of several:
  // its draft keeps arriving in `mail.drafts`. Close, a confirmed send and Archive end it.
  const stopDraft = (draftId: string | undefined) => {
    if (draftId !== undefined && mail.drafts[draftId]?.status === 'streaming') commands.stopMailDraft(draftId)
  }
  const endReplies = (threadIds: readonly string[]) => {
    for (const threadId of threadIds) stopDraft(replies[threadId]?.draftId)
    dropMailReplies(threadIds)
  }
  const closeReply = () => {
    if (replying !== null && thread !== null) endReplies([thread.threadId])
  }
  // A send confirmed while the view was away is told on its return.
  useEffect(() => {
    const delivered = Object.entries(mailView().replies)
      .filter(([, entry]) => entry.sendId !== undefined && mail.results[entry.sendId]?.ok === true)
    for (const [, entry] of delivered) toast.success(`Sent to ${entry.sentTo ?? entry.to.trim()}`)
    dropMailReplies(delivered.map(([threadId]) => threadId))
  }, [replies, mail.results])

  const openReply = () => {
    if (thread !== null && replying === null) openMailReply(thread.threadId, { to: thread.reply.to, cc: thread.reply.cc, body: '' })
  }
  /** False when the request could not leave, so the pane keeps what was asked. */
  const startDraft = (instruction?: string, current?: string) => {
    if (replying === null || thread === null) return false
    const { threadId } = thread
    // The host runs one draft at a time and ends the running one without a word, so the
    // client stops it first, else that reply would read as streaming for good.
    for (const entry of Object.values(replies)) stopDraft(entry.draftId)
    const draftId = newId('draft')
    const left = commands.startMailDraft(draftId, threadId, instruction, current)
    if (left) changeMailReply(threadId, { draftId })
    return left
  }
  const send = (to: string, cc: string, body: string) => {
    if (thread === null) return
    const sendId = newId('send')
    if (commands.sendMail(sendId, thread.threadId, to, body, cc)) changeMailReply(thread.threadId, { sendId, sentTo: to })
  }
  const openAdd = () => {
    if (thread !== null) setAdding(thread.threadId)
  }
  /**
   * One request per thread. `clear` ends the pick and opens the neighbour; a single card
   * archived from its menu does that only when it was the open mail.
   */
  const archive = (threadIds: readonly string[], clear: boolean) => {
    const archived = threadIds.flatMap((threadId) => {
      const requestId = newId('archive')
      return commands.archiveMailThread(requestId, threadId) ? [{ requestId, threadId }] : []
    })
    if (archived.length === 0) return
    const gone = archived.map((entry) => entry.threadId)
    endReplies(gone)
    const reopen = clear || (selectedId !== null && gone.includes(selectedId))
    setMailView({ archived, ...(clear ? { picked: [] } : {}), ...(reopen ? { selectedId: mailNeighbour(listed, gone) } : {}) })
  }
  const archiveSelected = () => archive(many ? selection : openId === null ? [] : [openId], true)
  const archiveCard = (threadId: string) => {
    if (selection.includes(threadId)) archiveSelected()
    else archive([threadId], false)
  }
  const select = (threadId: string) => {
    // Picking the open card again retries a read that failed.
    if (threadId === openId && mail.threadErrors[threadId] !== undefined) read(threadId)
    setMailView({ selectedId: threadId, picked: [] })
  }
  /** One card left is simply the open mail, and none leaves nothing open. */
  const pickCards = (next: readonly string[]) => {
    if (next.length > 1) setMailView({ picked: [...next] })
    else if (next[0] === undefined) setMailView({ selectedId: null, picked: [] })
    else select(next[0])
  }
  const click = (threadId: string, pick: MailPick) => {
    // The open mail counts as picked, so the first Cmd click on another card picks both.
    const listedOpen = current !== null && listed.includes(current) ? [current.threadId] : []
    if (pick === 'range') {
      const from = [anchor.current, ...listedOpen].find((id) => listed.some((entry) => entry.threadId === id)) ?? null
      pickCards(mailRange(listed, from, threadId))
      return
    }
    anchor.current = threadId
    if (pick === 'toggle') pickCards(toggledMailSelection(many ? selection : listedOpen, threadId))
    else select(threadId)
  }

  const run = (action: MailKeyAction): boolean => {
    switch (action.kind) {
      case 'step': {
        anchor.current = null
        const next = steppedMailSelection(listed, current?.threadId ?? null, action.step)
        if (next !== null) select(next)
        return true
      }
      case 'label':
        if (openId !== null) commands.setMailLabel(openId, action.label)
        return true
      case 'reply':
        openReply()
        return true
      case 'archive':
        archiveSelected()
        return true
      case 'add':
        openAdd()
        return true
      case 'search':
        if (sidebarCollapsed) onToggleSidebar?.()
        // After the frame in which a folded sidebar comes back, so the field can take focus.
        requestAnimationFrame(() => search.current?.focus())
        return true
      case 'close':
        if (many) {
          anchor.current = null
          setMailView({ picked: [] })
          return true
        }
        if (replying === null) return false
        closeReply()
        return true
    }
  }
  const onKey = useStableCallback((event: KeyboardEvent) => {
    if (settingsOpen || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || typing(event.target)) return
    if (document.querySelector('[role="dialog"], [aria-modal="true"], [role="menu"]') !== null) return
    const action = mailKeyAction(event.key)
    // A held key walks the list, and does everything else once.
    if (action === undefined || (event.repeat && action.kind !== 'step')) return
    if (run(action)) event.preventDefault()
  })
  useEffect(() => {
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onKey])

  const snapshot = mail.snapshot
  const problems = [snapshot?.status === 'error' ? snapshot.error : undefined, snapshot?.triage.error]
    .filter((problem) => problem !== undefined)
  const draftsState = {
    draft: replying?.draftId === undefined ? undefined : mail.drafts[replying.draftId],
    sending: replying?.sendId !== undefined && mail.results[replying.sendId] === undefined,
  }
  const added = adding === null ? undefined : mail.threads[adding]
  const runTriage = agent === null ? undefined : () => { commands.runMailTriage() }

  return (
    <section aria-label="Mail" className={`relative grid min-h-0 min-w-0 ${headerRows} overflow-hidden bg-bg`}>
      {sidebarSlot === null ? null : createPortal(
        <MailSidebar cards={listed} projects={projects} selectedId={openId} picked={selection} tab={tab} query={query} problems={problems}
          searchRef={search} onSelect={click} onArchive={archiveCard}
          onTab={(next) => setMailView({ tab: next, picked: [] })} onQuery={(next) => setMailView({ query: next, picked: [] })} />,
        sidebarSlot,
      )}
      {actionSlot === null || snapshot === null ? null : createPortal(
        <>
          <IconButton icon={RefreshIcon} size={28} label="Check for new mail" onClick={refresh} />
          {agent === null ? null : (
            <MailTriageButton agent={agent} triage={snapshot.triage} unlabelled={unlabelled} onRun={() => { commands.runMailTriage() }} />
          )}
        </>,
        actionSlot,
      )}
      <WorkspaceHeader section="mail" title="Mail" status={status} sidebarCollapsed={sidebarCollapsed}
        {...(onToggleSidebar === undefined ? {} : { onToggleSidebar })} />
      <div className="flex min-h-0 min-w-0">
        <div className={PANE_TRAVEL} style={{ flex: '1 1 0%' }}>
          <MailReader card={card} thread={thread} error={openId === null ? undefined : mail.threadErrors[openId]}
            listed={snapshot === null ? null : listed.length} selected={selection.length} tab={tab} query={query} triage={snapshot?.triage ?? null}
            unlabelled={unlabelled} projects={projects} split={replying !== null}
            onReply={openReply} onAdd={openAdd} onArchive={archiveSelected} onTriage={runTriage}
            onLink={(address, projectId) => { commands.linkMailSender(address, projectId) }} />
        </div>
        {/* Always here at no width, so the pane travels both ways. It gives way to the reader on a narrow stage. */}
        <div className={`relative overflow-hidden ${PANE_TRAVEL} ${replying === null ? '' : 'border-l border-line'}`}
          style={{ flex: `0 1 ${replying === null ? '0px' : 'min(420px, 60%)'}` }}>
          {replying === null || thread === null ? null : (
            <MailDraftPane key={thread.threadId} thread={thread} agent={agent} reply={replying} drafts={draftsState}
              onChange={(change) => changeMailReply(thread.threadId, change)} onClose={closeReply} onStart={startDraft} onStop={() => stopDraft(replying.draftId)} onSend={send} />
          )}
        </div>
      </div>
      {added === undefined ? null : (
        <MailAddToChatDialog thread={added} agents={agents} chats={chats}
          door={chatDoor} onClose={() => setAdding(null)} />
      )}
    </section>
  )
}
