import { useState } from 'react'
import { Tick02Icon } from '@hugeicons/core-free-icons'
import type { AgentConfig } from '@manor/contracts'
import type { Notice } from '../../state'
import { useRequest, type RequestEvents } from '../../useRequest'
import { Avatar } from '../Avatar'
import { ConfirmModal } from '../Confirm'
import { Icon } from '../Icon'
import { Modal, ModalFooter } from '../Modal'
import { Button } from '../ui/Button'
import { formFieldClass, formHintClass, formInputClass, formLabelClass, formOptionalClass } from '../ui/FormField'
import { RequestNotice } from '../ui/RequestNotice'

/** A group is more than two people talking; two of them is a DM with extra steps. */
const MIN_MEMBERS = 2

interface GroupDialogProps {
  /** Creating asks for a name too; editing only ever changes who is in the room. */
  mode: 'create' | 'edit'
  agents: AgentConfig[]
  /** Who is in it already: nobody when creating, the group's own members when editing. */
  members: string[]
  /** The group's current title, so the edit dialog says which group it is about. */
  title?: string
  notice?: Notice | null
  requestEvents?: RequestEvents
  /** Members as they should now read, plus the name for a create. */
  onSubmit: (memberIds: string[], name: string, requestId?: string) => boolean
  /** Edit only. Deleting removes the group and its transcript. */
  onDelete?: () => void
  onClose: () => void
}

/**
 * Who is in a group, both ways: the same list makes one and changes one, because
 * adding and removing a persona is the same act as picking the first two and a
 * second dialog would drift from this one. A blank name leaves the title to the
 * server, which names a group after the personas in it.
 */
const NO_REQUEST_EVENTS: RequestEvents = { subscribe: () => () => undefined }

export function GroupDialog({ mode, agents, members, title, notice = null, requestEvents = NO_REQUEST_EVENTS, onSubmit, onDelete, onClose }: GroupDialogProps) {
  const [armed, setArmed] = useState(false)
  return (
    <>
      <Modal title={mode === 'create' ? 'New group' : `Members of ${title ?? 'this group'}`} onClose={onClose}>
        <GroupDialogContent
          mode={mode}
          agents={agents}
          members={members}
          title={title}
          notice={notice}
          requestEvents={requestEvents}
          onSubmit={onSubmit}
          {...(onDelete === undefined ? {} : { onAskDelete: () => setArmed(true) })}
          onClose={onClose}
        />
      </Modal>
      {/* Beside the form rather than in it, so its Escape and Tab stay its own. */}
      {armed && onDelete !== undefined ? (
        <ConfirmModal
          title={`Delete “${title ?? 'this group'}”?`}
          onConfirm={() => {
            setArmed(false)
            onDelete()
          }}
          onCancel={() => setArmed(false)}
        >
          Its messages go with it.
        </ConfirmModal>
      ) : null}
    </>
  )
}

type GroupDialogContentProps = Omit<GroupDialogProps, 'onDelete'> & {
  /** Edit only. Opens the delete question, which the dialog itself owns. */
  onAskDelete?: () => void
}

/** The form inside the portal, separate so its destructive footer is testable without a DOM. */
export function GroupDialogContent({ mode, agents, members, title, notice = null, requestEvents = NO_REQUEST_EVENTS, onSubmit, onAskDelete, onClose }: GroupDialogContentProps) {
  const [picked, setPicked] = useState<string[]>(members)
  const [name, setName] = useState('')
  const request = useRequest(requestEvents)
  const selectableAgents = agents.filter((agent) =>
    agent.placement !== 'session' || members.includes(agent.id))

  const toggle = (agentId: string) => {
    setPicked((current) =>
      current.includes(agentId) ? current.filter((id) => id !== agentId) : [...current, agentId],
    )
  }

  const changed =
    picked.length !== members.length || picked.some((agentId) => !members.includes(agentId))
  const canSubmit = picked.length >= MIN_MEMBERS && (mode === 'create' || changed)

  const submit = () => {
    if (!canSubmit) return
    if (mode === 'edit') {
      onSubmit(picked, name.trim())
      return
    }
    request.start(
      (requestId) => onSubmit(picked, name.trim(), requestId),
      { onAck: onClose },
    )
  }

  return (
    <>
      {mode === 'create' ? (
        <label className={formFieldClass}>
          <span className={formLabelClass}>
            Name <span className={formOptionalClass}>optional</span>
          </span>
          <input
            className={formInputClass}
            value={name}
            placeholder="Left blank, Manor names it"
            autoFocus
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              submit()
            }}
          />
        </label>
      ) : null}

      <section className={formFieldClass}>
        <span className={formLabelClass}>Who is in it</span>
        <ul className="m-0 flex max-h-[280px] list-none flex-col gap-0.5 overflow-y-auto p-0">
          {/* Members whose persona has since been deleted still render, so a ghost
              can be seen and removed; the server refuses adding one back. */}
          {members
            .filter((memberId) => !agents.some((agent) => agent.id === memberId))
            .map((memberId) => {
              const on = picked.includes(memberId)
              return (
                <li key={memberId} className="m-0">
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    className={`flex w-full cursor-pointer items-center gap-2 rounded-lg border-0 px-2 py-1.5 text-left text-[13px] [font:inherit] ${
                      on ? 'bg-user-bg text-text' : 'bg-transparent text-muted hover:bg-surface-2 hover:text-text'
                    }`}
                    onClick={() => toggle(memberId)}
                  >
                    <Avatar name={memberId} color="var(--color-dim)" size={22} />
                    <span className="min-w-0 flex-1 truncate">
                      {memberId} <span className="text-dim">(deleted persona)</span>
                    </span>
                    {on ? <Icon className="flex-none" icon={Tick02Icon} size={14} /> : null}
                  </button>
                </li>
              )
            })}
          {selectableAgents.length === 0 ? (
            <li className="m-0 px-1 py-2 text-[12px] text-dim">No personas yet</li>
          ) : (
            selectableAgents.map((agent) => {
              const on = picked.includes(agent.id)
              return (
                <li key={agent.id} className="m-0">
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    className={`flex w-full cursor-pointer items-center gap-2 rounded-lg border-0 px-2 py-1.5 text-left text-[13px] [font:inherit] ${
                      on ? 'bg-user-bg text-text' : 'bg-transparent text-muted hover:bg-surface-2 hover:text-text'
                    }`}
                    onClick={() => toggle(agent.id)}
                  >
                    <Avatar name={agent.name} color={agent.color} src={agent.avatar} shape={agent.avatarShape} tone={agent.avatarTone} finish={agent.avatarFinish} size={22} />
                    <span className="min-w-0 flex-1 truncate">{agent.name}</span>
                    {on ? <Icon className="flex-none" icon={Tick02Icon} size={14} /> : null}
                  </button>
                </li>
              )
            })
          )}
        </ul>
        <span className={formHintClass}>
          {picked.length < MIN_MEMBERS
            ? `Pick at least ${MIN_MEMBERS}.`
            : `${picked.length} in this group. Only the default agent may hand work to the others.`}
        </span>
      </section>

      {notice === null ? null : <RequestNotice notice={notice} />}

      <ModalFooter>
        <div className="flex items-center gap-2 pt-0.5">
          {mode === 'edit' && onAskDelete !== undefined ? (
            <Button variant="danger" onClick={onAskDelete}>
              Delete group
            </Button>
          ) : null}
          <div className="flex flex-1 justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" onClick={submit} disabled={!canSubmit || request.pending}>
              {mode === 'create' && request.pending ? 'Creating…' : mode === 'create' ? 'Create group' : 'Save members'}
            </Button>
          </div>
        </div>
      </ModalFooter>
    </>
  )
}
