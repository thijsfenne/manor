import { isOpenRoom, type AgentConfig, type Chat } from '@manor/contracts'
import { roomAgents } from '@manor/client-runtime/mentions'

/**
 * Who the agents panel lists for one chat, in the order it lists them.
 *
 * A dm or a group carries an invited membership and the orchestrator drops every
 * target outside it, so the rest of the visible household would be rows for personas who
 * cannot answer here. A project chat has no membership: anyone can be mentioned
 * into it at any point, so everyone gets a row, whoever the transcript already
 * knows first and the rest in roster order behind them. A routine's run thread is a
 * project chat in this respect and takes the same branch.
 *
 * That last part is the whole reason this exists. The panel replaces a filter that
 * kept only the personas who had spoken, which left a dormant persona's pin
 * impossible to make and, worse, impossible to see or clear once it was made —
 * while the server went on applying it the moment she was first mentioned.
 */
export function chatRoster(
  agents: AgentConfig[],
  chat: (Pick<Chat, 'kind' | 'memberIds'> & Partial<Pick<Chat, 'mode' | 'legacySessionAgentIds'>>) | null,
  spoke: readonly string[],
): AgentConfig[] {
  // Placement first: a Session lists only Session personas, a DM or group only chat ones.
  const seats = roomAgents(agents, chat)
  if (chat !== null && !isOpenRoom(chat)) {
    const members = new Set(chat.memberIds)
    return seats.filter((agent) => members.has(agent.id))
  }

  const household = seats

  // Partitioned rather than sorted with a rank of Infinity for the dormant half:
  // two dormant personas would compare NaN, and a comparator that returns NaN has
  // no defined answer.
  const rank = new Map(spoke.map((id, index) => [id, index] as const))
  const seated = household
    .filter((agent) => rank.has(agent.id))
    .sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0))
  return [...seated, ...household.filter((agent) => !rank.has(agent.id))]
}
