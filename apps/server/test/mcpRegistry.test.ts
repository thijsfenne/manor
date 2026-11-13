import type { AgentConfig, McpServerConfig } from '@manor/contracts'
import { describe, expect, it } from 'vitest'
import { resolveAttachments } from '../src/mcp/attachments.js'
import { createMemoryStore } from '../src/stores/memoryStore.js'

const server = (id: string, name: string, tools: string[] = ['a', 'b']): McpServerConfig => ({
  id,
  name,
  command: '/bin/true',
  args: [],
  envKeys: [],
  description: '',
  writes: false,
  effectPolicy: 'confirm_writes',
  tools,
  readOnlyTools: [],
  schemaChars: 1_000,
})

const agent = (mcpServers: AgentConfig['mcpServers']): AgentConfig => ({
  id: 'sage',
  name: 'Sage',
  color: '#6FA8A0',
  driver: 'claude',
  effort: 'high',
  allowedTools: [],
  mcpServers,
  memoryScope: false,
  role: 'Generalist',
  description: '',
  isCos: false,
  character: 'You are Sage.',
})

describe('resolveAttachments', () => {
  it('gives a persona with no attachments nothing to render', () => {
    expect(resolveAttachments(agent([]), [server('s1', 'supabase')])).toEqual([])
  })

  it('fills in the registry row and keeps the persona exclusions', () => {
    const resolved = resolveAttachments(agent([{ serverId: 's1', disabledTools: ['b'] }]), [server('s1', 'supabase')])
    expect(resolved).toHaveLength(1)
    expect(resolved[0]?.server.name).toBe('supabase')
    expect(resolved[0]?.disabledTools).toEqual(['b'])
  })

  it('renders in registry order, not attachment order', () => {
    // The config becomes part of the request; a key order that shuffles between two
    // turns would invalidate the cached conversation prefix for nothing.
    const registry = [server('s1', 'alpha'), server('s2', 'beta')]
    const attachments = [{ serverId: 's2', disabledTools: [] }, { serverId: 's1', disabledTools: [] }]
    expect(resolveAttachments(agent(attachments), registry).map((a) => a.server.name)).toEqual(['alpha', 'beta'])
  })

  it('drops an attachment whose server is gone rather than failing the turn', () => {
    expect(resolveAttachments(agent([{ serverId: 'deleted', disabledTools: [] }]), [server('s1', 'x')])).toEqual([])
  })

  it('excludes unavailable connectors without losing persona attachments', () => {
    const saved = server('s1', 'composio')
    const holder = agent([{ serverId: saved.id, disabledTools: ['b'] }])
    expect(resolveAttachments(holder, [{ ...saved, unavailable: 'Reconnect required.' }])).toEqual([])
    expect(resolveAttachments(holder, [saved])).toEqual([{ server: saved, disabledTools: ['b'] }])
  })
})

describe('the registry in the store', () => {
  const draft = {
    name: 'supabase', command: '/bin/true', args: [], envKeys: [], description: '', writes: false,
    effectPolicy: 'confirm_writes' as const,
  }
  const probed = { tools: ['list_tables'], readOnlyTools: [], schemaChars: 4_200 }

  it('keeps what the probe learned on the row', async () => {
    const store = createMemoryStore()
    const saved = await store.saveMcpServer(draft, probed)
    expect(saved).toMatchObject({ name: 'supabase', tools: ['list_tables'], schemaChars: 4_200 })
    expect(await store.listMcpServers()).toEqual([saved])
  })

  it('detaches a deleted server from every persona holding it', async () => {
    // No foreign key does this: the attachment list is a jsonb column. Without it a
    // persona would keep an id nothing can resolve.
    const holder = agent([{ serverId: 'mcp_1', disabledTools: [] }])
    const store = createMemoryStore({ agents: [holder] })
    await store.saveMcpServer(draft, probed)
    await store.deleteMcpServer('mcp_1')
    expect(await store.listMcpServers()).toEqual([])
    expect((await store.loadRoster())[0]?.mcpServers).toEqual([])
  })

  it('leaves the attachments of other personas alone', async () => {
    const keeper = { ...agent([{ serverId: 'mcp_2', disabledTools: [] }]), id: 'smith', name: 'Smith' }
    const store = createMemoryStore({ agents: [agent([{ serverId: 'mcp_1', disabledTools: [] }]), keeper] })
    await store.saveMcpServer(draft, probed)
    await store.saveMcpServer({ ...draft, name: 'context7' }, probed)
    await store.deleteMcpServer('mcp_1')
    const roster = await store.loadRoster()
    expect(roster.find((a) => a.id === 'smith')?.mcpServers).toEqual([{ serverId: 'mcp_2', disabledTools: [] }])
  })
})
