import { GitBranchIcon } from '@hugeicons/core-free-icons'
import type { AgentConfig, Chat } from '@manor/contracts'
import { Icon } from '../Icon'
import { ProviderMark } from '../ProviderMark'
import { AgentStack } from './AgentStack'

/**
 * Who runs a session, at the end of a sidebar card or an overview row: a Single
 * session shows its provider's mark (none before a driver is set), a Multiple one
 * the faces of its personas. A session in its own git worktree wears a purple branch
 * on the left of that. The mapping row is gone once the worktree is merged or
 * discarded, so the mark leaves with it. One place for the rule, so both surfaces agree.
 *
 * The row's body lets pointer events through to the card's open button, so the branch
 * takes them back to carry its tooltip and hands a click on to `onOpen`.
 */
export function SessionMark({ chat, agents, onOpen }: {
  chat: Pick<Chat, 'mode' | 'singleDriver' | 'agentIds' | 'checkout'>
  agents: AgentConfig[]
  onOpen?: () => void
}) {
  const who = chat.mode === 'single'
    ? chat.singleDriver === undefined ? null : <ProviderMark driver={chat.singleDriver} size={16} />
    : <AgentStack agentIds={chat.agentIds} agents={agents} size={20} />
  if (chat.checkout.mode !== 'worktree') return who
  return (
    <span className="flex flex-none items-center gap-1.5">
      <span
        role="img"
        aria-label="Worktree"
        title="Worktree"
        data-session-worktree=""
        className="pointer-events-auto grid size-4 flex-none cursor-pointer place-items-center text-worktree"
        onClick={onOpen}
      >
        <Icon icon={GitBranchIcon} size={16} />
      </span>
      {who}
    </span>
  )
}
