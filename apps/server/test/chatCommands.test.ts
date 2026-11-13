import {
  CONTEXT_CLEARED_NOTE,
  GOAL_OBJECTIVE_MAX,
  SIDE_CLEAR_FAILED_NOTE,
  SINGLE_CHAT_VOICE,
  chatCommandOf,
  defaultModel,
  parseChatCommand,
  type AgentConfig,
  type Driver,
  type RuntimeEvent,
  type ServerMessage,
  type ThreadEvent,
  type TurnInput,
} from '@manor/contracts'
import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { AsyncQueue } from '../src/asyncQueue.js'
import { LIVE_COMPACT_DONE, LIVE_COMPACT_FAILED, LIVE_COMPACT_NOTE, LIVE_COMPACT_STOPPED, ROLLOVER_COMPACT_DONE } from '../src/drivers/sessionCompact.js'
import { createChatSummaryUpdater } from '../src/chatSummary.js'
import { effectReviewContext } from '../src/effectReviewer.js'
import { groupTurnTranscript } from '../src/groupTurnRouter.js'
import { Orchestrator } from '../src/orchestrator.js'
import { createMemoryStore } from '../src/stores/memoryStore.js'
import { cosRoster, gated, handed, marlow, sage, scratchFor, seededChat, smith, until } from './helpers.js'

const answering = (seen: TurnInput[], compact?: () => RuntimeEvent): Driver => ({
  startTurn(input) {
    seen.push(input)
    const queue = new AsyncQueue<RuntimeEvent>()
    queue.push({ type: 'result', text: 'Answered.', sessionId: input.sessionId ?? `fresh-${input.agent.id}` })
    queue.close()
    return { events: queue, stop: () => queue.close() }
  },
  ...(compact === undefined ? {} : {
    compactSession() {
      const queue = new AsyncQueue<RuntimeEvent>()
      queue.push(compact())
      queue.close()
      return { events: queue, stop: () => queue.close() }
    },
  }),
})

async function setup(driver: Driver, options: { agents?: readonly AgentConfig[]; advanceChatSummary?: (chatId: string) => Promise<boolean>; structuredMemoryRoot?: string } = {}) {
  const agents = options.agents ?? cosRoster
  const store = createMemoryStore({ agents })
  const { chatId, projectId } = await seededChat(store)
  const sent: ServerMessage[] = []
  const orchestrator = new Orchestrator({
    agents: () => agents,
    store,
    mcpServers: () => [],
    skills: () => [],
    resolveDriver: () => driver,
    ensureScratchDir: scratchFor,
    emit: (message) => sent.push(message),
    ...(options.advanceChatSummary === undefined ? {} : { advanceChatSummary: options.advanceChatSummary }),
    ...(options.structuredMemoryRoot === undefined ? {} : { structuredMemoryRoot: options.structuredMemoryRoot }),
  })
  return { orchestrator, store, chatId, projectId, sent }
}

const notesOf = (events: readonly ThreadEvent[]) => events.flatMap((event) => event.type === 'system_note' ? [event.text] : [])
const messagesOf = (events: readonly ThreadEvent[]) => events.filter((event) => event.type === 'user_message')

describe('parsing', () => {
  it('reads only a whole command', () => {
    expect(parseChatCommand('/compact')).toEqual({ name: 'compact' })
    expect(parseChatCommand(' /CLEAR \n')).toEqual({ name: 'clear' })
    expect(parseChatCommand('/goal')).toEqual({ name: 'goal_show' })
    expect(parseChatCommand('/goal clear')).toEqual({ name: 'goal_clear' })
    expect(parseChatCommand('/goal ship it\nand test it')).toEqual({ name: 'goal_set', objective: 'ship it\nand test it' })
    for (const text of ['/compact the logs', '/clear the cache', '/goal/foo', '/goals', '/foo', '/usr/bin/env', '/Users/sam/notes.md', 'use /clear']) {
      expect(parseChatCommand(text), text).toBeUndefined()
    }
  })

  it('leaves anything that carries content a message', () => {
    expect(chatCommandOf({ text: '/clear', images: [{}] })).toBeUndefined()
    expect(chatCommandOf({ text: '/clear', quotes: [{}] })).toBeUndefined()
    expect(chatCommandOf({ text: '/clear', replyTo: {} })).toBeUndefined()
    expect(chatCommandOf({ text: '/clear', images: [], files: [] })).toEqual({ name: 'clear' })
  })
})

describe('commands in the orchestrator', () => {
  it('sends a path-like text to the model as an ordinary message', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, store, chatId } = await setup(answering(seen))
    await orchestrator.submitUserMessage(chatId, '/foo/bar')
    expect(seen).toHaveLength(1)
    expect(messagesOf(await store.loadEvents(chatId))).toMatchObject([{ text: '/foo/bar' }])
  })

  it('refuses with nothing to act on and stores no message', async () => {
    const { orchestrator, store, chatId } = await setup(answering([]))
    await expect(orchestrator.submitUserMessage(chatId, '/compact')).rejects.toThrow('Nothing to compact yet.')
    await expect(orchestrator.submitUserMessage(chatId, '/clear')).rejects.toThrow('Nothing to clear yet.')
    expect(await store.loadEvents(chatId)).toEqual([])
  })

  it.each(['claude', 'codex', 'grok'] as const)('compacts a Single Session in place on %s', async (driver) => {
    const seen: TurnInput[] = []
    let compacted = 0
    const { orchestrator, store, projectId, sent } = await setup(answering(seen, () => {
      compacted += 1
      return { type: 'result', text: '' }
    }))
    const chat = await store.createChat({ projectId, mode: 'single' })
    await store.setChatOverride(chat.id, SINGLE_CHAT_VOICE.id, { driver, model: defaultModel(driver), effort: 'high', auto: false })
    await orchestrator.submitUserMessage(chat.id, 'Hello')
    await orchestrator.submitUserMessage(chat.id, '/compact')
    expect(compacted).toBe(1)
    const events = await store.loadEvents(chat.id)
    expect(notesOf(events)).toContain(LIVE_COMPACT_DONE)
    expect(messagesOf(events)).toHaveLength(1)
    expect(seen).toHaveLength(1)
    // Its own visible turn, which ended, and the session lives on for the next message.
    const states = sent.flatMap((message) => message.type === 'turn_state' ? [message.state] : [])
    expect(states.slice(-2)).toEqual(['running', 'done'])
    await orchestrator.submitUserMessage(chat.id, 'Next')
    expect(seen.at(-1)?.sessionId).toBe(`fresh-${SINGLE_CHAT_VOICE.id}`)
  })

  it('rolls over a room whose record is the summary, summary first', async () => {
    const seen: TurnInput[] = []
    let compacted = 0
    const order: string[] = []
    const agents = cosRoster
    const { orchestrator, store, chatId, projectId } = await setup(answering(seen, () => {
      compacted += 1
      return { type: 'result', text: '' }
    }), {
      agents,
      advanceChatSummary: async () => {
        order.push('summary')
        return true
      },
    })
    const dm = await store.createChat({ kind: 'dm', memberIds: [agents[0]!.id] })
    const thread = await store.createChat({ projectId, mode: 'single' })
    await store.setProjectThread(projectId, thread.id)
    for (const room of [dm.id, chatId, thread.id]) {
      await orchestrator.submitUserMessage(room, 'Hello')
      const held = seen.at(-1)?.agent.id ?? ''
      expect((await store.getSessions(room, held)).length).toBeGreaterThan(0)
      order.length = 0
      const clearSessions = store.clearSessions.bind(store)
      store.clearSessions = async (ids) => {
        order.push('sessions')
        await clearSessions(ids)
      }
      await orchestrator.submitUserMessage(room, '/compact')
      store.clearSessions = clearSessions
      expect(order.at(-1)).toBe('sessions')
      expect(order).toContain('summary')
      expect(order.indexOf('summary')).toBeLessThan(order.indexOf('sessions'))
      expect(await store.getSessions(room, held)).toEqual([])
      expect(notesOf(await store.loadEvents(room))).toContain(ROLLOVER_COMPACT_DONE)
    }
    expect(compacted).toBe(0)
  })

  // Cursor is the real case of the first: its driver holds no `compactSession`.
  it('rolls over when the driver has no compact path or the compact failed', async () => {
    for (const compact of [undefined, (): RuntimeEvent => ({ type: 'error', message: 'nope' })]) {
      const seen: TurnInput[] = []
      const { orchestrator, store, projectId } = await setup(answering(seen, compact))
      const chat = await store.createChat({ projectId, mode: 'single' })
      await orchestrator.submitUserMessage(chat.id, 'Hello')
      await orchestrator.submitUserMessage(chat.id, '/compact')
      expect(await store.getSessions(chat.id, SINGLE_CHAT_VOICE.id)).toEqual([])
      expect(notesOf(await store.loadEvents(chat.id))).toEqual([ROLLOVER_COMPACT_DONE])
      await orchestrator.submitUserMessage(chat.id, 'Next')
      expect(seen.at(-1)).toMatchObject({ isFullCatchUp: true })
      expect(seen.at(-1)?.sessionId).toBeUndefined()
    }
  })

  it('keeps the session and says so when the summary fails or the compact throws', async () => {
    const { orchestrator, store, chatId } = await setup(answering([]), { advanceChatSummary: async () => false })
    await orchestrator.submitUserMessage(chatId, 'Hello')
    await orchestrator.submitUserMessage(chatId, '/compact')
    expect(notesOf(await store.loadEvents(chatId))).toEqual([LIVE_COMPACT_FAILED])
    expect(await store.getSessions(chatId, marlow.id)).toHaveLength(1)

    const thrown = await setup(answering([]), { advanceChatSummary: () => Promise.reject(new Error('no')) })
    await thrown.orchestrator.submitUserMessage(thrown.chatId, 'Hello')
    await thrown.orchestrator.submitUserMessage(thrown.chatId, '/compact')
    expect(notesOf(await thrown.store.loadEvents(thrown.chatId))).toEqual([LIVE_COMPACT_FAILED])
  })

  it('rolls over from a live compact the provider would not start, only with a summary', async () => {
    const driver = { ...answering([]), compactSession: () => { throw new Error('no such binary') } }
    for (const [summarized, note, sessions] of [[true, ROLLOVER_COMPACT_DONE, 0], [false, LIVE_COMPACT_FAILED, 1]] as const) {
      const { orchestrator, store, projectId } = await setup(driver, { advanceChatSummary: async () => summarized })
      const chat = await store.createChat({ projectId, mode: 'single' })
      await orchestrator.submitUserMessage(chat.id, 'Hello')
      await orchestrator.submitUserMessage(chat.id, '/compact')
      expect(notesOf(await store.loadEvents(chat.id))).toEqual([note])
      expect(await store.getSessions(chat.id, SINGLE_CHAT_VOICE.id)).toHaveLength(sessions)
    }
  })

  it('refuses every changing command mid-turn and leaves the turn alone', async () => {
    const { driver, gates } = gated()
    const { orchestrator, store, chatId } = await setup(driver)
    const running = orchestrator.submitUserMessage(chatId, 'Long job')
    await until(() => gates.length === 1, 'the turn')
    for (const text of ['/compact', '/clear', '/goal ship it']) {
      await expect(orchestrator.submitUserMessage(chatId, text)).rejects.toThrow('Wait for the running work to finish')
    }
    gates[0]?.finish()
    await running
    expect(messagesOf(await store.loadEvents(chatId))).toHaveLength(1)
    expect(await store.workHandoffForTarget(chatId)).toBeUndefined()
  })

  it('refuses a compact while background work runs under the chat', async () => {
    const { orchestrator, chatId } = await setup(answering([]))
    await orchestrator.submitUserMessage(chatId, 'Hello')
    vi.spyOn(orchestrator, 'backgroundChatIds').mockReturnValue([chatId])
    await expect(orchestrator.submitUserMessage(chatId, '/compact')).rejects.toThrow('Wait for the running work to finish')
  })

  it('takes a message sent during a compact only after it ended', async () => {
    const seen: TurnInput[] = []
    const compact = new AsyncQueue<RuntimeEvent>()
    const { orchestrator, store, projectId, sent } = await setup({
      ...answering(seen),
      compactSession: () => ({ events: compact, stop: () => compact.close() }),
    })
    const chat = await store.createChat({ projectId, mode: 'single' })
    await orchestrator.submitUserMessage(chat.id, 'Hello')
    const compacting = orchestrator.submitUserMessage(chat.id, '/compact')
    await until(() => sent.some((message) => message.type === 'event' && message.event.type === 'system_note' && message.event.text === LIVE_COMPACT_NOTE), 'the compact note')
    const during = orchestrator.submitUserMessage(chat.id, 'While compacting')
    await until(() => sent.some((message) => message.type === 'event' && message.event.type === 'user_message' && message.event.text === 'While compacting'), 'the waiting message')
    expect(seen).toHaveLength(1)
    compact.push({ type: 'result', text: '' })
    compact.close()
    await Promise.all([compacting, during])
    expect(seen).toHaveLength(2)
    expect(seen.at(-1)?.sessionId).toBeDefined()
  })

  it('reads Stop on a compact as stopped and keeps the session', async () => {
    const stopped: string[] = []
    const compact = new AsyncQueue<RuntimeEvent>()
    const { orchestrator, store, projectId, sent } = await setup({
      ...answering([]),
      compactSession: () => ({ events: compact, stop: () => {
        stopped.push('stopped')
        compact.close()
      } }),
    })
    const chat = await store.createChat({ projectId, mode: 'single' })
    await orchestrator.submitUserMessage(chat.id, 'Hello')
    const before = sent.length
    const compacting = orchestrator.submitUserMessage(chat.id, '/compact')
    await until(() => sent.slice(before).some((message) => message.type === 'event' && message.event.type === 'system_note' && message.event.text === LIVE_COMPACT_NOTE), 'the compact note')
    const running = sent.slice(before).find((message) => message.type === 'turn_state' && message.state === 'running')
    orchestrator.stop(running?.type === 'turn_state' ? running.turnId : '')
    await compacting
    expect(stopped).toEqual(['stopped'])
    expect(notesOf(await store.loadEvents(chat.id))).toContain(LIVE_COMPACT_STOPPED)
    expect(await store.getSessions(chat.id, SINGLE_CHAT_VOICE.id)).toHaveLength(1)
  })

  it('keeps a stopped rollover out of a DM', async () => {
    let finishSummary = (_written: boolean) => {}
    const { orchestrator, store, sent } = await setup(answering([]), {
      advanceChatSummary: () => new Promise((resolve) => { finishSummary = resolve }),
    })
    const dm = await store.createChat({ kind: 'dm', memberIds: [marlow.id] })
    await orchestrator.submitUserMessage(dm.id, 'Hello')
    const before = sent.length
    const compacting = orchestrator.submitUserMessage(dm.id, '/compact')
    await until(() => sent.slice(before).some((message) => message.type === 'event' && message.event.type === 'system_note' && message.event.text === LIVE_COMPACT_NOTE), 'the compact note')
    const running = sent.slice(before).find((message) => message.type === 'turn_state' && message.state === 'running')
    orchestrator.stop(running?.type === 'turn_state' ? running.turnId : '')
    finishSummary(true)
    await compacting
    const note = (await store.loadEvents(dm.id)).find((event) => event.type === 'system_note')
    expect(note).toMatchObject({ kind: 'aborted', text: LIVE_COMPACT_STOPPED, turnId: expect.any(String) })
    expect(await store.getSessions(dm.id, marlow.id)).toHaveLength(1)
  })

  it('clears every persona at once and leaves one marker', async () => {
    const seen: TurnInput[] = []
    const agents: AgentConfig[] = [{ ...sage, memoryScope: true }, { ...marlow, memoryScope: false }, smith]
    const { orchestrator, store } = await setup(answering(seen), { agents })
    const group = await store.createChat({ kind: 'group', memberIds: [sage.id, marlow.id] })
    await orchestrator.submitUserMessage(group.id, '@Sage first secret')
    await orchestrator.submitUserMessage(group.id, '@Marlow second secret')
    await orchestrator.submitUserMessage(group.id, '/clear')
    const events = await store.loadEvents(group.id)
    expect(notesOf(events).filter((text) => text === CONTEXT_CLEARED_NOTE)).toHaveLength(1)
    expect(messagesOf(events)).toHaveLength(2)

    for (const [name, agent] of [['Sage', agents[0]], ['Marlow', agents[1]]] as const) {
      await orchestrator.submitUserMessage(group.id, `@${name} what now`)
      const input = seen.at(-1)
      expect(input?.agent.id).toBe(agent?.id)
      expect(input?.sessionId).toBeUndefined()
      expect(input?.isFullCatchUp).toBe(true)
      expect(JSON.stringify(input?.catchUp)).not.toContain('secret')
      expect(JSON.stringify(input?.catchUp)).not.toContain(CONTEXT_CLEARED_NOTE)
    }
  })

  it('gives the fresh session its standing context by the memory toggle', async () => {
    const structuredMemoryRoot = mkdtempSync(path.join(os.tmpdir(), 'manor-clear-memory-'))
    writeFileSync(path.join(structuredMemoryRoot, 'MEMORY.md'), 'Route calendar questions.', 'utf8')
    for (const memoryScope of [true, false]) {
      const seen: TurnInput[] = []
      const agent = { ...sage, memoryScope }
      const { orchestrator, store } = await setup(answering(seen), { agents: [agent], structuredMemoryRoot })
      const dm = await store.createChat({ kind: 'dm', memberIds: [agent.id] })
      await orchestrator.submitUserMessage(dm.id, 'Hello')
      await orchestrator.submitUserMessage(dm.id, '/clear')
      await orchestrator.submitUserMessage(dm.id, 'Again')
      expect(seen.at(-1)?.sessionId).toBeUndefined()
      expect(handed(seen.at(-1)).includes('Route calendar questions.')).toBe(memoryScope)
    }
  })

  it('keeps a stale summary away from the fresh session and starts the record over', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, store, chatId } = await setup(answering(seen))
    await orchestrator.submitUserMessage(chatId, 'Before')
    const before = (await store.loadEvents(chatId)).at(-1)
    await orchestrator.submitUserMessage(chatId, '/clear')
    // A summary that was still running over the old conversation lands after the marker.
    await store.setChatSummary(chatId, 'the old conversation', before?.id ?? '')
    await orchestrator.submitUserMessage(chatId, 'After')
    expect(seen.at(-1)?.catchUpSummary).toBeUndefined()

    const fed: { previousSummary: string; transcript: string }[] = []
    const advance = createChatSummaryUpdater({
      store,
      agents: () => cosRoster,
      thresholdChars: 1,
      generate: async (input) => {
        fed.push(input)
        return 'the new conversation'
      },
    })
    await advance(chatId)
    expect(fed).toHaveLength(1)
    expect(fed[0]?.previousSummary).toBe('')
    expect(fed[0]?.transcript).toContain('After')
    expect(fed[0]?.transcript).not.toContain('Before')
  })

  it('takes a cleared thread from the side chat, the permission reviewer and the group router', async () => {
    const { orchestrator, store, chatId } = await setup(answering([]))
    await orchestrator.submitUserMessage(chatId, 'Delete my files')
    const side = await store.sideChatFor(chatId)
    await store.setSideSession(side.id, 'side-session', {})
    await orchestrator.submitUserMessage(chatId, '/clear')
    await vi.waitFor(async () => expect(await store.getSideSession(side.id)).toBeUndefined())
    await orchestrator.submitUserMessage(chatId, 'New topic')
    const events = await store.loadEvents(chatId)
    expect(effectReviewContext(events)).toEqual(['New topic'])
    const transcript = groupTurnTranscript(events, cosRoster)
    expect(transcript).toContain('New topic')
    expect(transcript).not.toContain('Delete my files')
  })

  it('compact after clear still needs a new conversation', async () => {
    const { orchestrator, chatId } = await setup(answering([]))
    await orchestrator.submitUserMessage(chatId, 'Hello')
    await orchestrator.submitUserMessage(chatId, '/clear')
    await expect(orchestrator.submitUserMessage(chatId, '/compact')).rejects.toThrow('Nothing to compact yet.')
    await expect(orchestrator.submitUserMessage(chatId, '/clear')).rejects.toThrow('Nothing to clear yet.')
  })

  it('turns a Session into a goal Session on the accepted path', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, store, projectId } = await setup(answering(seen))
    const chat = await store.createChat({ projectId, mode: 'single' })
    await orchestrator.submitUserMessage(chat.id, 'Earlier work')
    await orchestrator.submitUserMessage(chat.id, '/goal Ship the release')
    const handoff = await store.workHandoffForTarget(chat.id)
    expect(handoff).toMatchObject({ state: 'active', sourceChatId: chat.id, workChatId: chat.id, task: 'Ship the release' })
    expect(handoff?.acceptedAt).not.toBeNull()
    expect(seen).toHaveLength(2)
    const kickoff = messagesOf(await store.loadEvents(chat.id)).at(-1)
    expect(kickoff).toMatchObject({ text: 'Ship the release', source: 'work_handoff', workHandoffId: handoff?.id })

    await expect(orchestrator.submitUserMessage(chat.id, '/goal Something else')).rejects.toThrow('already has a goal')
    await orchestrator.submitUserMessage(chat.id, '/goal')
    expect(notesOf(await store.loadEvents(chat.id))).toContain('Goal: Ship the release')
  })

  it('hands a Multiple Session its goal through the room lead', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, store, projectId } = await setup(answering(seen))
    const chat = await store.createChat({ projectId })
    await orchestrator.submitUserMessage(chat.id, '/goal Ship the release')
    expect(await store.workHandoffForTarget(chat.id)).toMatchObject({ leadAgentId: marlow.id, sourceChatId: chat.id })
    expect(seen[0]?.agent.id).toBe(marlow.id)
  })

  it('runs /compact and /goal in a Session nobody leads as the first Session persona, else as before', async () => {
    const owners = async (agents: AgentConfig[]) => {
      const seen: TurnInput[] = []
      const { orchestrator, store, projectId, sent } = await setup(answering(seen), { agents })
      const room = await store.createChat({ projectId })
      await store.appendEvent(room.id, { type: 'user_message', text: 'Earlier', mentions: [] })
      const before = sent.length
      await orchestrator.submitUserMessage(room.id, '/compact')
      const compacted = sent.slice(before).find((message) => message.type === 'turn_state' && message.state === 'running')
      const goal = await store.createChat({ projectId })
      const lead = await orchestrator.submitUserMessage(goal.id, '/goal Ship it')
        .then(async () => (await store.workHandoffForTarget(goal.id))?.leadAgentId, (error: Error) => error.message)
      return { compact: compacted?.type === 'turn_state' ? compacted.agentId : undefined, lead }
    }
    const cos = { ...marlow, placement: 'chat' } as const
    const ellis = { ...smith, id: 'ellis', name: 'Ellis', placement: 'session' } as const
    const argus = { ...smith, id: 'argus', name: 'Argus', placement: 'session' } as const
    expect(await owners([cos, ellis, argus])).toEqual({ compact: 'ellis', lead: 'ellis' })
    // No Session persona: the chief of staff compacts and the goal keeps its refusal.
    expect(await owners([cos, { ...sage, placement: 'chat' }])).toEqual({ compact: 'marlow', lead: 'Nobody here can lead a goal.' })
    // The author's roster order is argus, wren, ellis, and the default Session persona keeps both.
    expect(await owners([cos, argus, { ...ellis, id: 'wren', name: 'Wren' }, ellis])).toEqual({ compact: 'wren', lead: 'wren' })
  })

  it('keeps a side answer still running from saving the session /clear removed', async () => {
    const seen: TurnInput[] = []
    const held = new AsyncQueue<RuntimeEvent>()
    const { orchestrator, store, chatId } = await setup({
      startTurn(input) {
        seen.push(input)
        if (input.threadId === side.id && input.sessionId === undefined && seen.filter((turn) => turn.threadId === side.id).length === 1) return { events: held, stop: () => held.close() }
        return answering([]).startTurn(input)
      },
    })
    const side = await store.sideChatFor(chatId)
    await orchestrator.submitUserMessage(chatId, 'Before')
    const running = orchestrator.submitUserMessage(side.id, 'Explain')
    await until(() => seen.some((turn) => turn.threadId === side.id), 'the side answer')
    await orchestrator.submitUserMessage(chatId, '/clear')
    held.push({ type: 'result', text: 'Old answer', sessionId: 'pre-clear' })
    held.close()
    await running
    await orchestrator.submitUserMessage(side.id, 'Again')
    expect(seen.at(-1)?.sessionId).toBeUndefined()
    expect(JSON.stringify(seen.at(-1)?.catchUp)).not.toContain('Old answer')
    expect(notesOf(await store.loadEvents(side.id))).toEqual([CONTEXT_CLEARED_NOTE])
  })

  it('leaves a side message sent during the side reset behind its marker', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, store, chatId } = await setup(answering(seen))
    const side = await store.sideChatFor(chatId)
    await orchestrator.submitUserMessage(chatId, 'Before')
    await orchestrator.submitUserMessage(side.id, 'Earlier')
    let release = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const clearSideSession = store.clearSideSession.bind(store)
    store.clearSideSession = async (id) => { await gate; await clearSideSession(id) }
    await orchestrator.submitUserMessage(chatId, '/clear')
    const after = orchestrator.submitUserMessage(side.id, 'Sent right after')
    release()
    await after
    expect(JSON.stringify(seen.at(-1)?.catchUp)).toContain('Sent right after')
  })

  it('says so in the side chat when its reset failed', async () => {
    const { orchestrator, store, chatId } = await setup(answering([]))
    const side = await store.sideChatFor(chatId)
    await orchestrator.submitUserMessage(chatId, 'Before')
    await orchestrator.submitUserMessage(side.id, 'Earlier')
    store.clearSideSession = () => Promise.reject(new Error('disk full'))
    await orchestrator.submitUserMessage(chatId, '/clear')
    await orchestrator.submitUserMessage(side.id, 'Still here')
    expect(notesOf(await store.loadEvents(side.id))).toEqual([SIDE_CLEAR_FAILED_NOTE])
    expect(messagesOf(await store.loadEvents(side.id)).at(-1)?.text).toBe('Still here')
  })

  it('leaves a message sent during /clear behind the marker, in the fresh model', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, store, chatId } = await setup(answering(seen))
    await orchestrator.submitUserMessage(chatId, 'Before')
    let release = () => {}
    const clearSessions = store.clearSessions.bind(store)
    const gate = new Promise<void>((resolve) => { release = resolve })
    let entered = false
    store.clearSessions = async (ids) => { entered = true; await gate; await clearSessions(ids) }
    const clearing = orchestrator.submitUserMessage(chatId, '/clear')
    await until(() => entered, 'the clear running')
    const after = orchestrator.submitUserMessage(chatId, 'Sent right after')
    release()
    await Promise.all([clearing, after])
    expect(JSON.stringify(seen.at(-1)?.catchUp)).toContain('Sent right after')
  })

  it('refuses a goal outside a Session and an oversized one before anything changes', async () => {
    const { orchestrator, store, projectId } = await setup(answering([]), { agents: cosRoster })
    const dm = await store.createChat({ kind: 'dm', memberIds: [cosRoster[0]!.id] })
    await expect(orchestrator.submitUserMessage(dm.id, '/goal Ship')).rejects.toThrow('Goals run in Sessions.')
    await expect(orchestrator.submitUserMessage(dm.id, '/goal')).rejects.toThrow('Goals run in Sessions.')
    const chat = await store.createChat({ projectId, mode: 'single' })
    await expect(orchestrator.submitUserMessage(chat.id, `/goal ${'x'.repeat(GOAL_OBJECTIVE_MAX + 1)}`)).rejects.toThrow(`under ${GOAL_OBJECTIVE_MAX}`)
    expect(await store.workHandoffForTarget(chat.id)).toBeUndefined()
    await expect(orchestrator.submitUserMessage(chat.id, '/goal')).rejects.toThrow('No goal yet.')
  })

  it('removes a goal it set, and the Session may set another', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, store, projectId } = await setup(answering(seen))
    const chat = await store.createChat({ projectId, mode: 'single' })
    await expect(orchestrator.submitUserMessage(chat.id, '/goal clear')).rejects.toThrow('This Session has no goal.')
    await orchestrator.submitUserMessage(chat.id, '/goal First')
    await orchestrator.submitUserMessage(chat.id, '/goal clear')
    expect(await store.workHandoffForTarget(chat.id)).toBeUndefined()
    await orchestrator.submitUserMessage(chat.id, '/goal Second')
    expect(await store.workHandoffForTarget(chat.id)).toMatchObject({ task: 'Second' })
  })

  it('keeps an open goal across a clear', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, store, projectId } = await setup(answering(seen))
    const chat = await store.createChat({ projectId, mode: 'single' })
    await orchestrator.submitUserMessage(chat.id, 'Side remark')
    await orchestrator.submitUserMessage(chat.id, '/goal Ship the release')
    await orchestrator.submitUserMessage(chat.id, '/clear')
    await orchestrator.submitUserMessage(chat.id, 'Carry on')
    const input = seen.at(-1)
    expect(input?.sessionId).toBeUndefined()
    expect(JSON.stringify(input?.catchUp)).toContain('Ship the release')
    expect(JSON.stringify(input?.catchUp)).not.toContain('Side remark')
  })
})
