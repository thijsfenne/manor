import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AgentConfig, AgentDraft, ServerMessage, ThreadEvent } from '@manor/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { answerInstructionsOffer } from '../src/agentInterview.js'
import { notesUpdateOf, undoNotesUpdate } from '../src/agentNotes.js'
import { createMockDriver } from '../src/drivers/mockDriver.js'
import { UserInputCapabilities } from '../src/interactionCapability.js'
import { interactionMcpAttachment } from '../src/mcp/interactionAttachment.js'
import { ManorService } from '../src/service.js'
import { createMemoryStore } from '../src/stores/memoryStore.js'
import { cosRoster, scratchFor } from './helpers.js'

const folders: string[] = []
afterEach(async () => {
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })))
})

async function memoryFolder(): Promise<string> {
  const folder = await mkdtemp(path.join(tmpdir(), 'manor-notes-'))
  folders.push(folder)
  return folder
}

const NOTES = '# Nova\'s notes\n> capacity: 4/400 words\n- Plans start on Monday\n'

describe('a turn\'s notes change', () => {
  it('counts note lines, not the capacity line or the heading', () => {
    const after = '# Nova\'s notes\n> capacity: 9/400 words\n- Plans start on Monday\n- Write follow-ups in Dutch\n'
    expect(notesUpdateOf(NOTES, after)).toMatchObject({ added: 1, removed: 0, before: NOTES })
    expect(notesUpdateOf(null, after)).toMatchObject({ added: 2, removed: 0, before: null })
    expect(notesUpdateOf(NOTES, NOTES.replace('4/400', '5/400'))).toBeUndefined()
  })

  it('undoes only while the file is exactly as the turn left it', async () => {
    const file = path.join(await memoryFolder(), 'nova.md')
    const after = `${NOTES}- Write follow-ups in Dutch\n`
    await writeFile(file, after)
    const update = notesUpdateOf(NOTES, after)!

    await writeFile(file, `${after}- A later line\n`)
    expect(await undoNotesUpdate(file, update)).toBe('changed')
    expect(await readFile(file, 'utf8')).toBe(`${after}- A later line\n`)

    await writeFile(file, after)
    expect(await undoNotesUpdate(file, update)).toBe('undone')
    expect(await readFile(file, 'utf8')).toBe(NOTES)
  })

  it('removes a file the turn created, and refuses once it is gone', async () => {
    const file = path.join(await memoryFolder(), 'nova.md')
    await writeFile(file, '- Write follow-ups in Dutch\n')
    const update = notesUpdateOf(null, '- Write follow-ups in Dutch\n')!
    expect(await undoNotesUpdate(file, update)).toBe('undone')
    await expect(readFile(file, 'utf8')).rejects.toThrow()
    expect(await undoNotesUpdate(file, update)).toBe('changed')
  })
})

const draft = (memoryScope: boolean): AgentDraft => ({
  name: 'Nova',
  color: '#8B7EC8',
  character: 'You are Nova. You help with this: Plan my week.',
  driver: 'mock',
  effort: 'high',
  mcpServers: [],
  memoryScope,
  role: '',
  description: 'Plan my week.',
  isCos: false,
})

/**
 * The service with a real memory folder and the instructions route wired as `main.ts`
 * wires it. The mock states "mock rule: …" as a persona would: a notes edit with memory
 * on, `offer_instructions_line` with memory off.
 */
async function harness(memoryScope: boolean) {
  const memory = await memoryFolder()
  const store = createMemoryStore({ agents: cosRoster })
  const capabilities = new UserInputCapabilities()
  let live: readonly AgentConfig[] = await store.loadRoster()
  const broadcasts: ServerMessage[] = []
  const service: { current?: ManorService } = {}
  const request = (async (url: string | URL | Request, init?: RequestInit) => {
    const capability = (init?.headers as Record<string, string>)['x-manor-user-input-capability']
    if (!String(url).endsWith('/internal/agent-instructions')) throw new Error(`unexpected broker call ${String(url)}`)
    const answered = answerInstructionsOffer(capabilities, (context, line) => service.current!.offerInstructionsLine(context, line),
      capability, JSON.parse(String(init?.body)))
    return Response.json(answered.payload, { status: answered.status })
  }) as typeof fetch
  const manor = new ManorService({
    store,
    agents: () => live,
    setAgents: (next) => { live = next },
    mcpServers: () => [],
    setMcpServers: () => undefined,
    resolveDriver: () => createMockDriver({ deltaDelayMs: 0, agents: () => live, request }),
    ensureScratchDir: scratchFor,
    broadcast: (message) => broadcasts.push(message),
    memoryTarget: { dailyDir: path.join(memory, 'memory/daily') },
    interactionMcp: (chatId, agent, turnId, allowAsk, permissions) => {
      const offer = permissions?.allowInstructionsOffer === true
      const token = capabilities.issue({ chatId, agentId: agent.id, turnId, ...(offer ? { mayOfferInstructions: true as const } : {}) })
      return interactionMcpAttachment('http://127.0.0.1:1/internal/user-input', token, { allowAsk, allowInstructionsOffer: offer })
    },
  })
  service.current = manor
  const replies: ServerMessage[] = []
  const reply = (message: ServerMessage) => replies.push(message)
  await manor.handle({ type: 'save_agent', agent: draft(memoryScope) }, reply)
  const nova = () => live.find((agent) => agent.name === 'Nova')!
  await manor.handle({ type: 'create_chat', kind: 'dm', memberIds: [nova().id] }, reply)
  const chatId = (await store.listChats()).find((chat) => chat.kind === 'dm' && chat.memberIds[0] === nova().id)!.id
  const notesFile = path.join(memory, 'memory/agents', `${nova().id}.md`)
  /** Sends one message and returns the result of the turn it started. */
  const say = async (text: string, inChat = chatId) => {
    const before = (await store.loadEvents(inChat)).filter((event) => event.type === 'turn_result').length
    await manor.handle({ type: 'send_message', chatId: inChat, text }, reply)
    let results: Extract<ThreadEvent, { type: 'turn_result' }>[] = []
    await vi.waitFor(async () => {
      results = (await store.loadEvents(inChat)).filter((event) => event.type === 'turn_result')
      expect(results.length).toBe(before + 1)
    })
    return results.at(-1)!
  }
  const undo = async (turnId: string) => {
    replies.length = 0
    await manor.handle({ type: 'undo_notes_update', chatId, turnId, requestId: 'undo-1' }, reply)
    return replies
  }
  /** Starts a turn that stays running (the mock's "slow turn") and returns a way to stop it. */
  const hold = async () => {
    const seen = broadcasts.length
    const sent = manor.handle({ type: 'send_message', chatId, text: 'slow turn' }, reply)
    let turnId = ''
    await vi.waitFor(() => {
      const running = broadcasts.slice(seen).find((message) => message.type === 'turn_state' && message.chatId === chatId && message.state === 'running')
      turnId = running?.type === 'turn_state' ? running.turnId : ''
      expect(turnId).not.toBe('')
    })
    return async () => {
      await manor.handle({ type: 'stop', turnId }, reply)
      await sent
      await vi.waitFor(async () => expect((await store.loadEvents(chatId)).some((event) => event.type === 'system_note' && event.turnId === turnId)).toBe(true))
    }
  }
  return { store, chatId, nova, notesFile, say, undo, hold }
}

describe('a lasting rule stated in chat', () => {
  it('goes into the notes with memory on, and Undo puts them back', async () => {
    const test = await harness(true)
    const result = await test.say('mock rule: Write follow-ups in Dutch.')
    expect(result.notesUpdate).toMatchObject({ added: 1, removed: 0, before: null })
    expect(result.instructionsOffer).toBeUndefined()
    expect(await readFile(test.notesFile, 'utf8')).toContain('- Write follow-ups in Dutch.')
    expect(test.nova().character).toBe('You are Nova. You help with this: Plan my week.')

    expect(await test.undo(result.turnId)).toEqual([{ type: 'ack', requestId: 'undo-1' }])
    await expect(readFile(test.notesFile, 'utf8')).rejects.toThrow()
    const stored = (await test.store.loadEvents(test.chatId)).find((event) => event.type === 'turn_result' && event.turnId === result.turnId)
    expect(stored?.type === 'turn_result' && stored.notesUpdate?.undone).toBe(true)
  })

  it('refuses Undo after a later change and leaves the notes as they are', async () => {
    const test = await harness(true)
    const first = await test.say('mock rule: Write follow-ups in Dutch.')
    await test.say('mock rule: Keep answers short.')
    const now = await readFile(test.notesFile, 'utf8')

    const replies = await test.undo(first.turnId)
    expect(replies).toEqual([{ type: 'notice', kind: 'info', text: 'The notes changed since, so nothing was undone.', requestId: 'undo-1' }])
    expect(await readFile(test.notesFile, 'utf8')).toBe(now)
  })

  it('refuses Undo while the agent is mid-turn, and allows it once the turn is done', async () => {
    const test = await harness(true)
    const result = await test.say('mock rule: Write follow-ups in Dutch.')
    const stop = await test.hold()
    expect(await test.undo(result.turnId)).toEqual([{
      type: 'notice', kind: 'info', text: 'It is working right now, so nothing was undone. Try again when it is done.', requestId: 'undo-1',
    }])
    expect(await readFile(test.notesFile, 'utf8')).toContain('- Write follow-ups in Dutch.')
    await stop()
    expect(await test.undo(result.turnId)).toEqual([{ type: 'ack', requestId: 'undo-1' }])
  })

  it('offers no Undo for a notes change made while another turn of the agent ran', async () => {
    const test = await harness(true)
    const group = await test.store.createChat({ kind: 'group', memberIds: [test.nova().id, cosRoster[0]!.id] })
    const stop = await test.hold()
    const result = await test.say('@Nova mock rule: Write follow-ups in Dutch.', group.id)
    expect(await readFile(test.notesFile, 'utf8')).toContain('- Write follow-ups in Dutch.')
    expect(result.agentId).toBe(test.nova().id)
    expect(result.notesUpdate).toBeUndefined()
    await stop()
  })

  it('writes nothing with memory off: no notes, no instructions edit, only the offer', async () => {
    const test = await harness(false)
    const result = await test.say('mock rule: Write follow-ups in Dutch.')
    expect(result.instructionsOffer).toEqual({ line: 'Write follow-ups in Dutch.' })
    expect(result.notesUpdate).toBeUndefined()
    await expect(readFile(test.notesFile, 'utf8')).rejects.toThrow()
    expect(test.nova().character).toBe('You are Nova. You help with this: Plan my week.')
    const events = await test.store.loadEvents(test.chatId)
    expect(events.some((event) => event.type === 'agent_message' && event.text.includes('I keep nothing'))).toBe(true)
  })

  it('refuses the offer to a turn that keeps memory', () => {
    const capabilities = new UserInputCapabilities()
    const token = capabilities.issue({ chatId: 'c', agentId: 'nova', turnId: 't' })
    const offered: string[] = []
    const answer = answerInstructionsOffer(capabilities, (_context, line) => offered.push(line), token, { line: 'Write in Dutch.' })
    expect(answer.status).toBe(409)
    expect(offered).toEqual([])
  })
})
