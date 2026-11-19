import type { AgentConfig, McpServerConfig, Routine, SkillConfig } from '@manor/contracts'

/** The read-only lists behind an agent's overview, as the route segment names them. */
export const AGENT_LISTS = ['tasks', 'skills', 'connectors'] as const
export type AgentList = (typeof AGENT_LISTS)[number]

export const isAgentList = (value: string | undefined): value is AgentList =>
  AGENT_LISTS.some((list) => list === value)

interface HouseLists {
  chats: readonly { id: string; kind: string; memberIds: readonly string[] }[]
  agents: readonly AgentConfig[]
  routines: readonly Routine[]
  skills: readonly SkillConfig[]
  mcpServers: readonly McpServerConfig[]
}

/** The persona a DM talks to, or undefined once the chat or the persona is gone. */
export function agentOfDm(house: Pick<HouseLists, 'chats' | 'agents'>, chatId: string): AgentConfig | undefined {
  const chat = house.chats.find((candidate) => candidate.id === chatId)
  if (chat?.kind !== 'dm') return undefined
  return house.agents.find((agent) => agent.id === chat.memberIds[0])
}

/**
 * What one agent holds, read from the house lists the phone already keeps: the tasks
 * she answers, the skills and the connectors attached to her. A skill or server the
 * Mac no longer has is left out, as the Mac's own counts leave it out.
 */
export function agentHoldings(house: Omit<HouseLists, 'chats' | 'agents'>, agent: AgentConfig) {
  const skillIds = new Set(agent.skillIds ?? [])
  const serverIds = new Set(agent.mcpServers.map((attachment) => attachment.serverId))
  return {
    tasks: house.routines.filter((routine) => routine.agentId === agent.id),
    skills: house.skills.filter((skill) => skillIds.has(skill.id)),
    connectors: house.mcpServers.filter((server) => serverIds.has(server.id)),
  }
}
