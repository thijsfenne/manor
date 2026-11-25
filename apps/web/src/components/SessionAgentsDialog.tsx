import { ArrowRight01Icon } from '@hugeicons/core-free-icons'
import type { AgentConfig } from '@manor/contracts'
import { Avatar } from './Avatar'
import { Icon } from './Icon'
import { Modal, ModalFooter } from './Modal'
import { Button } from './ui/Button'

/**
 * The personas that work in Sessions. The Agents list holds only chat personas, so
 * this is where one of them is edited, including moving her back to chat, even when
 * she never had a conversation to open the form from.
 */
export function SessionAgentsDialog({
  agents,
  onEdit,
  onNewSessionAgent,
  onClose,
}: {
  agents: AgentConfig[]
  onEdit: (agentId: string) => void
  /** The door that opens the agent form preset to a Session agent. */
  onNewSessionAgent: () => void
  onClose: () => void
}) {
  const sessionAgents = agents.filter((agent) => agent.placement === 'session')
  return (
    <Modal title="Session agents" onClose={onClose}>
      {sessionAgents.length === 0 ? (
        <>
          <p className="m-0 text-label text-muted">No agents work in Sessions.</p>
          <ModalFooter>
            <div className="flex items-center justify-end gap-2 pt-0.5">
              <Button
                variant="primary"
                onClick={() => {
                  onClose()
                  onNewSessionAgent()
                }}
              >
                Add a session agent
              </Button>
            </div>
          </ModalFooter>
        </>
      ) : (
        <ul className="m-0 -mx-2 flex list-none flex-col p-0">
          {sessionAgents.map((agent) => (
            <li key={agent.id}>
              <button
                type="button"
                onClick={() => onEdit(agent.id)}
                className="flex w-full cursor-pointer items-center gap-3 rounded-lg border-0 bg-transparent px-2 py-2 text-left hover:bg-surface-2 focus-visible:bg-surface-2"
              >
                <Avatar name={agent.name} color={agent.color} src={agent.avatar} shape={agent.avatarShape} tone={agent.avatarTone} finish={agent.avatarFinish} size={32} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-medium text-text">{agent.name}</span>
                  {agent.description === '' ? null : <span className="block truncate text-[12.5px] text-muted">{agent.description}</span>}
                </span>
                <Icon icon={ArrowRight01Icon} size={15} className="flex-none text-dim" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  )
}
