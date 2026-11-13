import type { AgentConfig, Driver, ServerMessage } from '@manor/contracts'
import { describe, expect, it } from 'vitest'
import { createMockDriver } from '../src/drivers/mockDriver.js'
import { ManorService } from '../src/service.js'
import { createMemoryStore } from '../src/stores/memoryStore.js'
import { gated, roster, scratchFor, seededChat, until } from './helpers.js'

async function house(driver: Driver = createMockDriver({ deltaDelayMs: 0 })) {
  const store = createMemoryStore({ agents: roster })
  const { projectId } = await seededChat(store)
  const messages: ServerMessage[] = []
  const deleted: string[][] = []
  let agents: readonly AgentConfig[] = await store.loadRoster()
  const service = new ManorService({
    store,
    agents: () => agents,
    setAgents: (next) => {
      agents = next
    },
    mcpServers: () => [],
    setMcpServers: () => undefined,
    resolveDriver: () => driver,
    ensureScratchDir: scratchFor,
    broadcast: (message) => messages.push(message),
    onChatsDeleted: (chatIds) => deleted.push([...chatIds]),
  })
  await service.primeHouseholdState()
  return { store, projectId, service, messages, deleted, agents: () => agents }
}

describe('external household changes', () => {
  it('reloads a directly changed persona into the live roster once', async () => {
    const test = await house()
    const sage = test.agents().find((agent) => agent.id === 'sage')
    if (sage === undefined) throw new Error('missing Sage fixture')
    await test.store.saveAgent({ ...sage, description: 'Changed outside Manor.' })

    await test.service.refreshHousehold({ resource: 'agents', event: 'update', id: 'sage' })
    await test.service.refreshHousehold({ resource: 'agents', event: 'reconnect' })

    expect(test.agents().find((agent) => agent.id === 'sage')?.description).toBe('Changed outside Manor.')
    expect(test.messages.filter((message) => message.type === 'roster')).toHaveLength(1)
  })

  it('broadcasts a directly changed routine and absorbs an unchanged echo', async () => {
    const test = await house()
    await test.store.saveRoutine({
      projectId: test.projectId,
      chatId: null,
      agentId: 'sage',
      name: 'Morning brief',
      description: 'Summarises what changed overnight.',
      prompt: 'What changed overnight?',
      cron: '0 7 * * *',
      timezone: 'Europe/Amsterdam',
      enabled: true,
      notify: false,
      model: null,
      effort: null,
    })

    await test.service.refreshHousehold({ resource: 'routines', event: 'insert' })
    await test.service.refreshHousehold({ resource: 'routines', event: 'reconnect' })

    const updates = test.messages.filter((message) => message.type === 'routines')
    expect(updates).toHaveLength(1)
    expect(updates[0]?.type === 'routines' ? updates[0].routines[0]?.name : undefined).toBe('Morning brief')
  })

  it('does not stop manual work in a dm when its routine is deleted externally', async () => {
    const gate = gated()
    const test = await house(gate.driver)
    const dm = await test.store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })
    const routine = await test.store.saveRoutine({
      projectId: null,
      chatId: dm.id,
      agentId: 'sage',
      name: 'Mention watch',
      description: '',
      prompt: 'Check for new mentions.',
      cron: '0 7 * * *',
      timezone: 'Europe/Amsterdam',
      enabled: true,
      notify: false,
      model: null,
      effort: null,
    })
    await test.service.primeHouseholdState()

    const running = test.service.handle(
      { type: 'send_message', chatId: dm.id, text: 'Keep working.' },
      () => undefined,
    )
    await until(() => gate.forChat(dm.id).length === 1, 'the manual dm turn to start')

    await test.store.deleteRoutine(routine.id)
    await test.service.refreshHousehold({ resource: 'routines', event: 'delete', id: routine.id })

    expect(test.service.activeScratchThreadIds()).toContain(dm.id)
    gate.forChat(dm.id)[0]?.finish()
    await running
  })

  it('cleans up cascaded run chats after an agent delete missed while offline', async () => {
    const gate = gated()
    const test = await house(gate.driver)
    const routine = await test.store.saveRoutine({
      projectId: test.projectId,
      chatId: null,
      agentId: 'sage',
      name: 'Morning brief',
      description: '',
      prompt: 'What changed overnight?',
      cron: '0 7 * * *',
      timezone: 'Europe/Amsterdam',
      enabled: true,
      notify: false,
      model: null,
      effort: null,
    })
    const run = await test.store.createChat({
      projectId: test.projectId,
      kind: 'run',
      routineId: routine.id,
      title: routine.name,
    })
    await test.service.primeHouseholdState()
    const running = test.service.runRoutineTurn(routine, run.id)
    await until(() => gate.forChat(run.id).length === 1, 'the external-delete run to start')

    await test.store.deleteAgent('sage')
    await test.service.refreshHousehold({ resource: 'agents', event: 'reconnect' })
    // Ordinary broadcasts can race ahead of the queued Realtime delete. Neither may
    // erase the older snapshot needed for runtime and native cleanup.
    await test.service.broadcastRoutines()
    await test.service.broadcastDirectory()
    await test.service.directory()
    await test.service.refreshHousehold({ resource: 'routines', event: 'reconnect' })
    await running

    expect(test.deleted).toEqual([[run.id]])
    expect(test.service.activeScratchThreadIds()).not.toContain(run.id)
    const directory = test.messages.filter((message) => message.type === 'directory').at(-1)
    expect(directory?.type === 'directory' ? directory.chats.some((chat) => chat.id === run.id) : true).toBe(false)
  })
})
