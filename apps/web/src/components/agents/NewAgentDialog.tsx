import { useEffect, useRef, useState } from 'react'
import type { AgentConfig, AgentDraft } from '@manor/contracts'
import { PROVIDERS } from '../../runtimes'
import { useRequest, type RequestEvents } from '../../useRequest'
import { Modal } from '../Modal'
import { Button } from '../ui/Button'
import { draftToCreate, newAgentDraft } from './newAgent'
import { NewAgentFields } from './NewAgentFields'

const PROVIDER_ORDER = PROVIDERS.map((option) => option.value).filter((driver) => driver !== 'mock')

/**
 * The New agent door: the short form over the workspace. Create saves the agent and
 * hands its id on once the roster carries it, so the caller can open its DM.
 */
export function NewAgentDialog({ agents, requestEvents, onSaveAgent, onCreated, onClose }: {
  agents: AgentConfig[]
  requestEvents: RequestEvents
  onSaveAgent: (draft: AgentDraft, requestId: string) => boolean
  onCreated: (agentId: string) => void
  onClose: () => void
}) {
  const { start, pending } = useRequest(requestEvents)
  const [draft, setDraft] = useState(() => newAgentDraft(agents))
  const [error, setError] = useState<string | null>(null)
  // The roster and the ack race; the agent opens once both have landed.
  const before = useRef<ReadonlySet<string> | null>(null)
  const [acked, setAcked] = useState(false)
  useEffect(() => {
    if (!acked || before.current === null) return
    const known = before.current
    const created = agents.find((agent) => !known.has(agent.id))
    if (created === undefined) return
    before.current = null
    onCreated(created.id)
  }, [acked, agents, onCreated])

  const create = () => {
    if (draft.name.trim() === '' || pending || before.current !== null) return
    setError(null)
    const ids = new Set(agents.map((agent) => agent.id))
    const sent = start((requestId) => onSaveAgent(draftToCreate(draft), requestId), {
      onAck: () => {
        before.current = ids
        setAcked(true)
      },
      onNotice: (notice) => setError(notice.text),
    })
    if (!sent) setError('Nothing was sent, the connection is down. Try again once it is back.')
  }

  const busy = pending || acked
  return (
    <Modal title="New agent" onClose={onClose}>
      <form className="contents" onSubmit={(event) => { event.preventDefault(); create() }}>
        <NewAgentFields draft={draft} providers={PROVIDER_ORDER} disabled={busy} onChange={(next) => { setError(null); setDraft(next) }} />
        {error === null ? null : <p className="m-0 text-label text-danger" role="alert">{error}</p>}
        <div className="flex items-center gap-3">
          <p className="m-0 min-w-0 flex-1 text-label text-dim">It starts with short instructions you can change in Settings.</p>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={draft.name.trim() === '' || busy}>{busy ? 'Creating…' : 'Create agent'}</Button>
        </div>
      </form>
    </Modal>
  )
}
