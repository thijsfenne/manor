import { personaOf, type Row } from '../state'
import type { AgentConfig } from '@manor/contracts'
import { OutboundDraftGroup } from './OutboundDraftGroup'
import type { DraftActions } from './OutboundDraftBubble'
import { useOutboundDock } from './outboundDockState'

export function OutboundDraftDock({ rows, agents, connected, actions }: { rows: Row[]; agents: AgentConfig[]; connected: boolean; actions: DraftActions }) {
  const dock = useOutboundDock()
  const turns = rows.filter((row) => row.kind === 'turn').filter((turn) => turn.drafts.some((draft) => dock?.pinned(draft)))
  if (turns.length === 0) return null
  return (
    <div aria-label="Outbound drafts" className="mb-2 flex max-h-outbound-dock-max w-full min-w-0 max-w-[760px] flex-col gap-2 overflow-y-auto [&>*]:shrink-0">
      {turns.map((turn) => (
        <OutboundDraftGroup
          key={turn.key}
          docked
          drafts={turn.drafts}
          color={personaOf(agents, turn.agentId).color}
          connected={connected}
          actions={actions}
        />
      ))}
    </div>
  )
}
