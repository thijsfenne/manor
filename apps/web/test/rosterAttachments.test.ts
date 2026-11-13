import { describe, expect, it } from 'vitest'
import type { AgentConfig, McpAttachment } from '@manor/contracts'
import { emptyWorkspace, reduce } from '../src/state'

/**
 * The roster reducer drops an unchanged household to keep array identity stable, and
 * for a long while "unchanged" did not look at MCP attachments. A persona whose only
 * edit was which servers it holds therefore arrived looking identical, the old roster
 * was kept, and the agent dialog waited forever for a change that had already been
 * written. These tests exist so attaching a server stays a change.
 */
const persona = (mcpServers: McpAttachment[]): AgentConfig => ({
  id: 'agent_1',
  name: 'Smith',
  color: '#D08A3E',
  character: 'pragmatic engineer',
  driver: 'claude',
  effort: 'high',
  allowedTools: ['Read', 'Edit'],
  mcpServers,
  skillIds: [],
  memoryScope: true,
  description: 'builds things',
  role: 'engineer',
  isCos: false,
  mentionAllowlist: [],
})

const withRoster = (agents: AgentConfig[]) => reduce({ ...emptyWorkspace }, { type: 'roster', agents })

describe('roster attachments', () => {
  it('takes an attachment being added as a change', () => {
    const before = withRoster([persona([])])
    const after = reduce(before, { type: 'roster', agents: [persona([{ serverId: 'mail', disabledTools: [] }])] })
    expect(after).not.toBe(before)
    expect(after.agents[0]?.mcpServers).toEqual([{ serverId: 'mail', disabledTools: [] }])
  })

  it('takes an attachment being removed as a change', () => {
    const before = withRoster([persona([{ serverId: 'gmail', disabledTools: [] }])])
    const after = reduce(before, { type: 'roster', agents: [persona([])] })
    expect(after).not.toBe(before)
    expect(after.agents[0]?.mcpServers).toEqual([])
  })

  it('takes one server being swapped for another as a change', () => {
    const before = withRoster([persona([{ serverId: 'gmail', disabledTools: [] }])])
    const after = reduce(before, { type: 'roster', agents: [persona([{ serverId: 'mail', disabledTools: [] }])] })
    expect(after).not.toBe(before)
    expect(after.agents[0]?.mcpServers[0]?.serverId).toBe('mail')
  })

  it('takes an excluded tool as a change', () => {
    const before = withRoster([persona([{ serverId: 'mail', disabledTools: [] }])])
    const after = reduce(before, {
      type: 'roster',
      agents: [persona([{ serverId: 'mail', disabledTools: ['mail_draft'] }])],
    })
    expect(after).not.toBe(before)
    expect(after.agents[0]?.mcpServers[0]?.disabledTools).toEqual(['mail_draft'])
  })

  it('still drops a genuinely identical roster, so a reconnect repaints nothing', () => {
    const before = withRoster([persona([{ serverId: 'mail', disabledTools: ['mail_draft'] }])])
    const after = reduce(before, {
      type: 'roster',
      agents: [persona([{ serverId: 'mail', disabledTools: ['mail_draft'] }])],
    })
    expect(after).toBe(before)
  })
})
