import type { AgentConfig, McpServerConfig, Routine, SkillConfig } from '@manor/contracts'
import { describe, expect, it } from 'vitest'

import { agentHoldings, agentOfDm, isAgentList } from './agentOverview'

const agent = (id: string, extra: Partial<AgentConfig> = {}) => ({ id, name: id, mcpServers: [], ...extra }) as unknown as AgentConfig

describe('agentOfDm', () => {
  const agents = [agent('marlow'), agent('sage')]
  it('names the persona a DM talks to', () => {
    expect(agentOfDm({ chats: [{ id: 'dm', kind: 'dm', memberIds: ['sage'] }], agents }, 'dm')?.id).toBe('sage')
  })
  it('has none for another kind of chat or a deleted persona', () => {
    expect(agentOfDm({ chats: [{ id: 'g', kind: 'group', memberIds: ['sage'] }], agents }, 'g')).toBeUndefined()
    expect(agentOfDm({ chats: [{ id: 'dm', kind: 'dm', memberIds: ['gone'] }], agents }, 'dm')).toBeUndefined()
  })
})

describe('agentHoldings', () => {
  it('keeps her own tasks and only attached skills and servers the house still has', () => {
    const marlow = agent('marlow', {
      skillIds: ['notes', 'gone'],
      mcpServers: [{ serverId: 'linear', disabledTools: [] }, { serverId: 'removed', disabledTools: [] }],
    })
    const held = agentHoldings({
      routines: [{ id: 'r1', agentId: 'marlow' }, { id: 'r2', agentId: 'sage' }] as Routine[],
      skills: [{ id: 'notes' }, { id: 'other' }] as SkillConfig[],
      mcpServers: [{ id: 'linear' }, { id: 'figma' }] as McpServerConfig[],
    }, marlow)
    expect(held.tasks.map((routine) => routine.id)).toEqual(['r1'])
    expect(held.skills.map((skill) => skill.id)).toEqual(['notes'])
    expect(held.connectors.map((server) => server.id)).toEqual(['linear'])
  })
})

describe('isAgentList', () => {
  it('accepts the three list segments only', () => {
    expect(['tasks', 'skills', 'connectors', 'files', undefined].map(isAgentList)).toEqual([true, true, true, false, false])
  })
})
