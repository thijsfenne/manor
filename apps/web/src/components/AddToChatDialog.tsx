import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { BubbleChatIcon, SentIcon } from '@hugeicons/core-free-icons'
import type { AgentConfig, Chat, PageContextAttachment } from '@manor/contracts'
import { NEW_CHAT_DRAFT_KEY } from '../composerDrafts'
import { cosOf } from '../persona'
import { markLetters } from '../projectAppearance'
import { stageDraftKey } from '../useChatDialogs'
import type { ChatDestination } from './artifacts/AddToChatButton'
import { Avatar } from './Avatar'
import { Icon } from './Icon'
import { ProjectMark } from './ProjectMark'
import { Button } from './ui/Button'
import { Dialog } from './ui/Dialog'

/** The sources already staged, by composer slot. */
type Staged = Readonly<Record<string, readonly PageContextAttachment[]>>

const stagedIds = (staged: Staged, key: string) => (staged[key] ?? []).map((context) => context.id)

/** The new-chat stage as a target, held back for the same reasons the stage itself is. */
export function newSessionTarget({ staged, canStart, creating }: {
  staged: Staged
  /** False when there is no project to start a Session in. */
  canStart: boolean
  creating: boolean
}): ChatDestination {
  return {
    id: NEW_CHAT_DRAFT_KEY,
    kind: 'new',
    label: 'New Session',
    usedIds: stagedIds(staged, NEW_CHAT_DRAFT_KEY),
    ...(!canStart
      ? { unavailable: 'No project to start one in' }
      : creating
        ? { unavailable: 'A Session is still being started' }
        : {}),
  }
}

/**
 * Every agent's DM, the default agent first. A DM that does not exist yet is offered
 * under its draft's slot, so what is staged there is waiting when the DM opens.
 */
export function agentTargets({ agents, chats, staged, creating }: {
  agents: readonly AgentConfig[]
  chats: readonly Chat[]
  staged: Staged
  creating: boolean
}): ChatDestination[] {
  const dm = (agent: AgentConfig): ChatDestination => {
    const chat = chats.find((entry) => entry.kind === 'dm' && entry.memberIds[0] === agent.id)
    const id = chat?.id ?? stageDraftKey({ kind: 'dm', agentId: agent.id })
    return {
      id, kind: chat === undefined ? 'new' : 'chat', label: agent.name, owner: { agent }, usedIds: stagedIds(staged, id),
      ...(chat === undefined && creating ? { unavailable: 'A chat is still being started' } : {}),
    }
  }
  // An agent that works only inside Sessions has no DM to be written to.
  const messageable = agents.filter((agent) => agent.placement !== 'session')
  const first = cosOf(messageable)
  return [...(first === null ? [] : [first]), ...messageable.filter((agent) => agent !== first)].map(dm)
}

/** What a row is, read out after its name. */
const roomWord = (target: ChatDestination) =>
  target.owner === undefined ? undefined : 'agent' in target.owner ? 'direct message' : 'project chat'

/** An agent's face, a project's icon, or the glyph for a new or any other chat, in one column. */
function TargetMark({ target, dim }: { target: ChatDestination; dim: boolean }) {
  const owner = target.owner
  return (
    <span aria-hidden="true" data-mark={owner === undefined ? target.kind : 'agent' in owner ? 'agent' : 'project'}
      className={`grid w-[22px] flex-none place-items-center ${dim ? 'opacity-45' : ''}`}>
      {owner === undefined ? (
        <Icon icon={target.kind === 'new' ? SentIcon : BubbleChatIcon} size={16} className="text-muted" />
      ) : 'agent' in owner ? (
        <Avatar name={owner.agent.name} color={owner.agent.color} src={owner.agent.avatar} shape={owner.agent.avatarShape}
          tone={owner.agent.avatarTone} finish={owner.agent.avatarFinish} size={22} />
      ) : (
        <ProjectMark icon={owner.project.icon} color={owner.project.color} src={owner.project.repoIconSrc}
          letters={markLetters(owner.project)} size={18} />
      )}
    </span>
  )
}

const ARROW_STEP: Partial<Record<string, 1 | -1>> = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }

interface AddToChatDialogProps {
  targets: readonly ChatDestination[]
  /** Why a target cannot take what is being added, or undefined when it can. */
  blocked: (target: ChatDestination) => string | undefined
  /** The row picked on opening. Absent or blocked, the first open row is. */
  initialId?: string | undefined
  /** What goes along, under the list. Focusable, so the keyboard can scroll all of it. */
  preview?: ReactNode
  /** Called after the dialog asked to close, with the target picked. */
  onAdd: (target: ChatDestination) => void
  onClose: () => void
}

/**
 * Picks the chat something is handed to. Mail and Artifacts each pass their targets and
 * do the staging and the going there in `onAdd`; this only draws the rows and picks one.
 */
export function AddToChatDialog({ targets, blocked, initialId, preview, onAdd, onClose }: AddToChatDialogProps) {
  const open = targets.filter((target) => blocked(target) === undefined)
  const [picked, setPicked] = useState(initialId ?? null)
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
    onAdd(target)
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
      <h2 className="m-0 text-lg font-medium text-text">Add to chat</h2>
      <div role="radiogroup" aria-label="Chat" className="mt-3 flex flex-col gap-0.5">
        {targets.map((target) => {
          const reason = blocked(target)
          const checked = target === selected
          // Each is a tab stop, because the dialog's focus trap counts every enabled button.
          return (
            <button key={target.id} type="button" role="radio" aria-checked={checked}
              aria-label={[target.label, roomWord(target), target.detail, reason].filter((part) => part !== undefined).join(', ')}
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
              <TargetMark target={target} dim={reason !== undefined} />
              <span className="min-w-0 flex-1 truncate">{target.label}</span>
              {reason === undefined
                ? target.detail === undefined ? null : <span className="flex-none text-[12px] text-dim">{target.detail}</span>
                : <span className="flex-none text-[12px] text-dim">{reason}</span>}
            </button>
          )
        })}
      </div>
      {targets.length > 0 ? null : <p className="m-0 mt-3 text-[13px] text-muted">There is no chat to add this to yet.</p>}
      {preview === undefined ? null : (
        <div role="region" aria-label="Preview" tabIndex={0}
          className="mt-4 max-h-40 min-h-20 overflow-y-auto rounded-lg bg-surface-2 px-3 py-2.5">
          {preview}
        </div>
      )}
      {/* Enter on Cancel or Add presses that button and must not also add. */}
      <div className="mt-5 flex flex-none justify-end gap-1.5"
        onKeyDown={(event) => { if (event.key === 'Enter') event.stopPropagation() }}>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={selected === undefined} onClick={() => add()}>Add</Button>
      </div>
    </Dialog>
  )
}
