import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { mailContextText, type AgentConfig, type Chat, type MailThread, type PageContextAttachment, type Project } from '@manor/contracts'
import { accentStyle } from '../../accent'
import { cosOf } from '../../persona'
import { stageDraftKey } from '../../useChatDialogs'
import { roomFor, type ChatDestination } from '../artifacts/AddToChatButton'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'

/** The way from Mail into a conversation: the staging and navigation the Artifacts door uses. */
export interface MailChatDoor {
  /** The sources already staged, by composer slot. */
  staged: Record<string, PageContextAttachment[]>
  /** A chat is still being made, so a DM that does not exist yet cannot take a source. */
  creating: boolean
  stage: (composerKey: string, context: PageContextAttachment) => void
  openChat: (chatId: string) => void
  /** An agent's DM, or the stage addressed to that agent when there is none yet. */
  openDm: (agentId: string) => void
}

export interface MailAddToChatDialogProps {
  thread: MailThread
  agents: readonly AgentConfig[]
  chats: readonly Chat[]
  projects: readonly Project[]
  /** The project linked to this sender, whose thread is offered first. */
  linkedProjectId: string | undefined
  door: MailChatDoor
  onClose: () => void
}

/** A destination with the mark it wears. `id` is the composer slot the source is staged in. */
export type MailChatTarget = ChatDestination & { color: string } & (
  | { room: 'dm'; agentId: string }
  | { room: 'project' }
)

/** The thread as a source for a message. What the dialog previews is its `text`, unchanged. */
export function mailPageContext(thread: MailThread): PageContextAttachment {
  // A mail may have an empty subject, and a source needs a name.
  const subject = thread.subject.trim() === '' ? '(no subject)' : thread.subject
  return {
    id: `mail:${thread.threadId}`.slice(0, 120),
    kind: 'mail',
    url: '',
    title: subject.slice(0, 500),
    label: subject.slice(0, 240),
    text: mailContextText(thread),
    html: '',
  }
}

/**
 * Where a mail can go: the thread of the sender's project, the default agent's DM, then
 * the other DMs and the other project threads. A long list scrolls in the dialog.
 */
export function mailChatTargets({ agents, chats, projects, linkedProjectId, staged, creating }: {
  agents: readonly AgentConfig[]
  chats: readonly Chat[]
  projects: readonly Project[]
  linkedProjectId: string | undefined
  staged: MailChatDoor['staged']
  creating: boolean
}): MailChatTarget[] {
  const usedIds = (key: string) => (staged[key] ?? []).map((context) => context.id)
  const dm = (agent: AgentConfig): MailChatTarget => {
    const chat = chats.find((entry) => entry.kind === 'dm' && entry.memberIds[0] === agent.id)
    const id = chat?.id ?? stageDraftKey({ kind: 'dm', agentId: agent.id })
    return {
      id, room: 'dm', agentId: agent.id, label: agent.name, color: agent.color, usedIds: usedIds(id),
      kind: chat === undefined ? 'new' : 'chat',
      ...(chat === undefined && creating ? { unavailable: 'A chat is still being started' } : {}),
    }
  }
  const projectThread = (project: Project): MailChatTarget[] => {
    const chat = chats.find((entry) => entry.id === project.threadChatId && entry.archivedAt === null)
    return chat === undefined
      ? []
      : [{ id: chat.id, room: 'project', kind: 'chat', label: project.name, color: project.color, usedIds: usedIds(chat.id) }]
  }
  // An agent that works only inside Sessions has no DM to be written to.
  const messageable = agents.filter((agent) => agent.placement !== 'session')
  const first = cosOf(messageable)
  const linked = projects.find((project) => project.id === linkedProjectId)
  return [
    ...(linked === undefined ? [] : projectThread(linked)),
    ...(first === null ? [] : [dm(first)]),
    ...messageable.filter((agent) => agent !== first).map(dm),
    ...projects.filter((project) => project !== linked).flatMap(projectThread),
  ]
}

const ARROW_STEP: Partial<Record<string, 1 | -1>> = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }

/**
 * Carries the open thread into a conversation the user picks. Add only stages the mail
 * in that chat's composer and opens the chat: sending stays the user's own act.
 */
export function MailAddToChatDialog({ thread, agents, chats, projects, linkedProjectId, door, onClose }: MailAddToChatDialogProps) {
  const context = mailPageContext(thread)
  const targets = mailChatTargets({
    agents, chats, projects, linkedProjectId, staged: door.staged, creating: door.creating,
  })
  // A thread staged there already takes its own slot again, with the text previewed here.
  const blocked = (target: MailChatTarget) =>
    target.unavailable ?? (roomFor(target, [context.id]) ? undefined : 'No room left')
  const open = targets.filter((target) => blocked(target) === undefined)
  const [picked, setPicked] = useState<string | null>(null)
  const selected = open.find((target) => target.id === picked) ?? open[0]
  const radios = useRef(new Map<string, HTMLButtonElement>())
  const initial = useRef(selected?.id)

  // After the dialog's own effect, which has to see the opener before focus moves in.
  useEffect(() => {
    if (initial.current !== undefined) radios.current.get(initial.current)?.focus()
  }, [])

  const add = (target = selected) => {
    if (target === undefined) return
    onClose()
    door.stage(target.id, context)
    // Going there is the point: a source in a composer nobody looks at has vanished.
    if (target.room === 'dm') door.openDm(target.agentId)
    else door.openChat(target.id)
  }
  const onEnter = (event: KeyboardEvent, target = selected) => {
    event.preventDefault()
    if (!event.repeat) add(target)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter') {
      onEnter(event)
      return
    }
    const step = ARROW_STEP[event.key]
    // On the preview the arrows scroll the text.
    if (step === undefined || !(event.target as Element | null)?.matches?.('[role="radio"]')) return
    const next = open[(open.findIndex((target) => target === selected) + step + open.length) % open.length]
    if (next === undefined) return
    event.preventDefault()
    setPicked(next.id)
    radios.current.get(next.id)?.focus()
  }

  return (
    <Dialog label="Add to chat" onClose={onClose} onKeyDown={onKeyDown} trapFocus
      scrimClassName="grid place-items-center" className="flex max-h-full max-w-[480px] flex-col overflow-y-auto p-5">
      <h2 className="m-0 text-lg font-semibold text-text">Add to chat</h2>
      <div role="radiogroup" aria-label="Chat" className="mt-3 flex flex-col gap-0.5">
        {targets.map((target) => {
          const reason = blocked(target)
          const checked = target === selected
          // Each is a tab stop, because the dialog's focus trap counts every enabled button.
          return (
            <button key={target.id} type="button" role="radio" aria-checked={checked}
              aria-label={`${target.label}, ${target.room === 'dm' ? 'direct message' : 'project chat'}${reason === undefined ? '' : `, ${reason}`}`}
              disabled={reason !== undefined}
              ref={(node) => {
                if (node === null) radios.current.delete(target.id)
                else radios.current.set(target.id, node)
              }}
              className={`flex w-full min-w-0 flex-none cursor-pointer items-center gap-2.5 rounded-lg border-0 px-2.5 py-1.5 text-left text-[14px] text-text [font-family:inherit] disabled:cursor-default disabled:text-dim ${
                checked ? 'bg-user-bg' : 'bg-transparent not-disabled:hover:bg-surface-2'}`}
              onClick={() => setPicked(target.id)}
              // Tab can rest on a target that is not picked, and Enter there means that one.
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return
                event.stopPropagation()
                onEnter(event, target)
              }}>
              <span aria-hidden="true" data-mark={target.room} style={accentStyle(target.color)}
                className={`size-4 flex-none bg-[var(--accent)] ${target.room === 'dm' ? 'rounded-full' : 'rounded-sm'}`} />
              <span className="min-w-0 flex-1 truncate">{target.label}</span>
              {reason === undefined ? null : <span className="flex-none text-[12px] text-dim">{reason}</span>}
            </button>
          )
        })}
      </div>
      {targets.length > 0 ? null : <p className="m-0 mt-3 text-[13px] text-muted">There is no chat to add this to yet.</p>}
      {/* Focusable, so the keyboard can scroll through all of what goes along. */}
      <div role="region" aria-label="Preview" tabIndex={0}
        className="mt-4 max-h-40 min-h-20 overflow-y-auto rounded-lg bg-surface-2 px-3 py-2.5">
        <p className="m-0 mb-1 text-[12px] text-warn">Untrusted</p>
        <div data-mail-preview className="text-[12px] break-words whitespace-pre-wrap text-muted select-text">{context.text}</div>
      </div>
      {/* Enter on Cancel or Add presses that button and must not also add. */}
      <div className="mt-5 flex flex-none justify-end gap-1.5"
        onKeyDown={(event) => { if (event.key === 'Enter') event.stopPropagation() }}>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={selected === undefined} onClick={() => add()}>Add</Button>
      </div>
    </Dialog>
  )
}
