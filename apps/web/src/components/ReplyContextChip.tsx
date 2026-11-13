import { ReplyIcon } from '@hugeicons/core-free-icons'
import type { AgentConfig, MessageReply } from '@manor/contracts'
import { SourceContextChip } from './PageContextChip'

/** The one message this draft or sent bubble explicitly answers. */
export function ReplyContextChip({
  reply,
  agents,
  appearance,
  onRemove,
}: {
  reply: MessageReply
  agents: readonly AgentConfig[]
  appearance?: 'default' | 'composer'
  onRemove?: () => void
}) {
  const name = agents.find((agent) => agent.id === reply.agentId)?.name ?? reply.agentId
  return <SourceContextChip
    detail={reply.text}
    icon={ReplyIcon}
    name={name}
    removeLabel={`Stop replying to ${name}`}
    title={`${name}\n${reply.text}`}
    {...(appearance === undefined ? {} : { appearance })}
    {...(onRemove === undefined ? {} : { onRemove })}
  />
}
