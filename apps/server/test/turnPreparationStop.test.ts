import type { McpServerConfig } from '@manor/contracts'
import { expect, it, vi } from 'vitest'
import { CUA_DRIVER_PATH } from '../src/mcp/computerAttachment.js'
import { Orchestrator } from '../src/orchestrator.js'
import { createMemoryStore } from '../src/stores/memoryStore.js'
import { sage, scratchFor, scripted, seededChat } from './helpers.js'

// A connector token refresh that only ends when the test says so; production bounds it at 15s.
const refresh = vi.hoisted(() => ({ entered: false, release: () => {} }))
vi.mock('../src/mcp/oauth.js', () => ({
  accessTokenFor: async () => {
    refresh.entered = true
    await new Promise<void>((resolve) => { refresh.release = resolve })
    return undefined
  },
  mcpBearerEnvKey: () => 'MANOR_TEST_BEARER',
}))

const remote = { id: 'remote', name: 'Remote', url: 'https://example.invalid/mcp', command: '', args: [], envKeys: [], tools: [], readOnlyTools: [], description: '', writes: false, effectPolicy: 'confirm_writes', schemaChars: 0 } as McpServerConfig
const computer = { id: 'computer', name: 'computer', command: CUA_DRIVER_PATH, args: ['mcp'], envKeys: [], tools: ['click'], readOnlyTools: [], description: '', writes: true, effectPolicy: 'confirm_writes', schemaChars: 0 } as McpServerConfig

it.each(['@Sage hi', '@Sage use @computer', '@Sage use @browser'])('ends "%s" stopped while a connector token refreshes, without starting the provider', async (text) => {
  refresh.entered = false
  const agents = [{ ...sage, mcpServers: [{ serverId: remote.id, disabledTools: [] }, { serverId: computer.id, disabledTools: [] }] }]
  const store = createMemoryStore({ agents })
  const { chatId } = await seededChat(store)
  const resolveDriver = vi.fn(() => scripted(() => [], []))
  const computerTargetReady = vi.fn()
  const orchestrator = new Orchestrator({
    agents: () => agents, store, resolveDriver, computerTargetReady, ensureScratchDir: scratchFor, emit: () => undefined,
    mcpServers: () => [remote, computer],
  })
  const turn = orchestrator.submitUserMessage(chatId, text)
  try {
    await vi.waitFor(() => expect(refresh.entered).toBe(true))
    orchestrator.stop(orchestrator.activeTurn(chatId)!.turnId)
    await turn
    expect(orchestrator.activeTurn(chatId)).toBeUndefined()
    expect(resolveDriver).not.toHaveBeenCalled()
    expect(computerTargetReady).not.toHaveBeenCalled()
    expect((await store.loadEvents(chatId)).at(-1)).toMatchObject({ type: 'system_note', kind: 'aborted' })
  } finally {
    refresh.release()
  }
})

it('ends a turn stopped while the desktop browser is still answering its @browser target', async () => {
  const store = createMemoryStore({ agents: [sage] })
  const { chatId } = await seededChat(store)
  const resolveDriver = vi.fn(() => scripted(() => [], []))
  let asked = false
  const orchestrator = new Orchestrator({
    agents: () => [sage], store, resolveDriver, ensureScratchDir: scratchFor, emit: () => undefined, mcpServers: () => [],
    builtInMcp: () => ({ server: remote, disabledTools: [] }),
    // A silent host: production gives up after 30s, then rejects.
    browserTargetContext: () => { asked = true; return new Promise<string>(() => {}) },
  })
  const turn = orchestrator.submitUserMessage(chatId, '@Sage inspect @browser')
  await vi.waitFor(() => expect(asked).toBe(true))
  orchestrator.stop(orchestrator.activeTurn(chatId)!.turnId)
  await turn
  expect(resolveDriver).not.toHaveBeenCalled()
  expect((await store.loadEvents(chatId)).at(-1)).toMatchObject({ type: 'system_note', kind: 'aborted' })
})
