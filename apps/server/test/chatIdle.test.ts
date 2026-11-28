import { describe, expect, it } from 'vitest'
import { createMockDriver } from '../src/drivers/mockDriver.js'
import { Orchestrator } from '../src/orchestrator.js'
import { createMemoryStore } from '../src/stores/memoryStore.js'
import { cosRoster, scratchFor } from './helpers.js'

/** The quiet re-settle hangs on this: a chat says once its turn queue ran empty, and only then reads idle. */
describe('chat idle signal', () => {
  it('fires after the errand, when nothing runs or waits in the chat any more', async () => {
    const store = createMemoryStore({ agents: cosRoster })
    const idle: { chatId: string; idle: boolean }[] = []
    const orchestrator: Orchestrator = new Orchestrator({
      agents: () => cosRoster, store, mcpServers: () => [], resolveDriver: () => createMockDriver({ deltaDelayMs: 0 }),
      ensureScratchDir: scratchFor, emit: () => undefined,
      onChatIdle: (chatId) => idle.push({ chatId, idle: orchestrator.isIdle(chatId) }),
    })
    const dm = await store.createChat({ kind: 'dm', memberIds: ['smith'], title: 'Smith' })
    expect(orchestrator.isIdle(dm.id)).toBe(true)

    await orchestrator.submitUserMessage(dm.id, 'how does the driver interface work?')

    expect(idle.length).toBeGreaterThan(0)
    expect(idle.every((entry) => entry.chatId === dm.id && entry.idle)).toBe(true)
  })

  it('reads busy while a forwarded message prepares its Session, so a quiet re-settle cannot stamp it then', async () => {
    const store = createMemoryStore({ agents: cosRoster })
    const orchestrator = new Orchestrator({
      agents: () => cosRoster, store, mcpServers: () => [], resolveDriver: () => createMockDriver({ deltaDelayMs: 0 }),
      ensureScratchDir: scratchFor, emit: () => undefined,
    })
    const dm = await store.createChat({ kind: 'dm', memberIds: ['smith'], title: 'Smith' })
    let idleWhilePreparing: boolean | undefined
    const { finished } = await orchestrator.forwardUserMessage(dm.id, {
      text: 'still clipped', forwardedFrom: { threadChatId: 'thread', eventId: 'evt' },
    }, async () => { idleWhilePreparing = orchestrator.isIdle(dm.id) })
    await finished

    expect(idleWhilePreparing).toBe(false)
  })
})
