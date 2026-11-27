import { mailContextText, type AgentConfig, type Chat, type MailThread, type PageContextAttachment } from '@manor/contracts'
import { NEW_CHAT_DRAFT_KEY } from '../../composerDrafts'
import { AddToChatDialog, agentTargets, newSessionTarget } from '../AddToChatDialog'
import { roomFor, type ChatDestination } from '../artifacts/AddToChatButton'

/** The way from Mail into a conversation: the staging and navigation the Artifacts door uses. */
export interface MailChatDoor {
  /** The sources already staged, by composer slot. */
  staged: Record<string, PageContextAttachment[]>
  /** A chat is still being made, so a DM that does not exist yet cannot take a source. */
  creating: boolean
  /** False when there is no project to start a Session in. */
  canStartChat: boolean
  stage: (composerKey: string, context: PageContextAttachment) => void
  openChat: (chatId: string) => void
  /** An agent's DM, or the stage addressed to that agent when there is none yet. */
  openDm: (agentId: string) => void
  /** Opens the new-chat stage, which takes what is staged under `NEW_CHAT_DRAFT_KEY`. */
  startChat: () => void
}

export interface MailAddToChatDialogProps {
  thread: MailThread
  agents: readonly AgentConfig[]
  chats: readonly Chat[]
  door: MailChatDoor
  onClose: () => void
}

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

/** Where a mail can go: a new Session, the default agent's DM, then the other DMs. */
export function mailChatTargets({ agents, chats, door }: {
  agents: readonly AgentConfig[]
  chats: readonly Chat[]
  door: Pick<MailChatDoor, 'staged' | 'creating' | 'canStartChat'>
}): ChatDestination[] {
  return [
    newSessionTarget({ staged: door.staged, canStart: door.canStartChat, creating: door.creating }),
    ...agentTargets({ agents, chats, staged: door.staged, creating: door.creating }),
  ]
}

/**
 * Carries the open thread into a conversation the user picks. Add only stages the mail
 * in that chat's composer and opens the chat: sending stays the user's own act.
 */
export function MailAddToChatDialog({ thread, agents, chats, door, onClose }: MailAddToChatDialogProps) {
  const context = mailPageContext(thread)
  const targets = mailChatTargets({ agents, chats, door })
  // A thread staged there already takes its own slot again, with the text previewed here.
  const blocked = (target: ChatDestination) =>
    target.unavailable ?? (roomFor(target, [context.id]) ? undefined : 'No room left')
  const open = targets.filter((target) => blocked(target) === undefined)
  // A DM stays the first pick: starting a Session is the bigger step, taken on purpose.
  const initial = open.find((target) => target.id !== NEW_CHAT_DRAFT_KEY) ?? open[0]

  const add = (target: ChatDestination) => {
    door.stage(target.id, context)
    // Going there is the point: a source in a composer nobody looks at has vanished.
    if (target.id === NEW_CHAT_DRAFT_KEY) door.startChat()
    else if (target.owner !== undefined && 'agent' in target.owner) door.openDm(target.owner.agent.id)
    else door.openChat(target.id)
  }

  return (
    <AddToChatDialog targets={targets} blocked={blocked} initialId={initial?.id} onAdd={add} onClose={onClose}
      preview={(
        <>
          <p className="m-0 mb-1 text-[12px] text-warn">Untrusted</p>
          <div data-mail-preview className="text-[12px] break-words whitespace-pre-wrap text-muted select-text">{context.text}</div>
        </>
      )} />
  )
}
