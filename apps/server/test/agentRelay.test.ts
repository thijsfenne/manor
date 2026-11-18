import type {
  AgentConfig,
  AttachedMcpServer,
  Chat,
  Driver,
  RuntimeEvent,
  ServerMessage,
  TurnInput,
} from '@manor/contracts'
import { describe, expect, it, vi } from 'vitest'
import {
  AGENT_RELAY_INBOUND_MAX,
  AGENT_RELAY_OUTBOUND_MAX,
  AgentRelay,
  type RelayTurnContext,
  withRelayExchanges,
} from '../src/agentRelay.js'
import type { UserInputContext } from '../src/interactionCapability.js'
import { Orchestrator } from '../src/orchestrator.js'
import type { TurnResult } from '../src/turnRunner.js'
import { createMemoryStore } from '../src/stores/memoryStore.js'
import { AsyncQueue } from '../src/asyncQueue.js'
import { contextWindowFor } from '@manor/contracts'
import { renderCatchUpEvents, SESSION_CONTEXT_FRACTION } from '../src/composer.js'
import { closeTerminalTurn } from '../src/agentRelayLifecycle.js'
import { createTurnContext } from '../src/turnContext.js'
import { gated, marlow, sage, scratchFor, scripted, smith, until } from './helpers.js'

const agents: AgentConfig[] = [
  { ...marlow, mentionAllowlist: ['sage', 'smith'] },
  { ...sage, mentionAllowlist: ['smith', 'marlow'] },
  { ...smith, mentionAllowlist: ['sage'] },
]

const rootContext = (chatId: string, turnId = 'root-turn'): UserInputContext => ({
  chatId,
  agentId: 'marlow',
  turnId,
  canApprove: true,
  relay: { originChatId: chatId, originTurnId: turnId, depth: 0 },
})

async function relayHarness(options: {
  roster?: AgentConfig[]
  maxDepth?: number
  maxTurns?: number
  run?: (input: {
    pairChat: Chat
    relayId: string
    onMessageStored: () => Promise<void>
    onTurnStarted: (turnId: string) => void
    isCancelled: () => boolean
  }) => Promise<TurnResult>
} = {}) {
  const roster = options.roster ?? agents
  const store = createMemoryStore({ agents: roster })
  const dm = await store.createChat({ kind: 'dm', memberIds: ['marlow'], title: 'Marlow' })
  const stopTurn = vi.fn()
  const broadcastDirectory = vi.fn().mockResolvedValue(undefined)
  const synthesize = vi.fn().mockResolvedValue(undefined)
  const run = options.run ?? (async (input) => {
    await input.onMessageStored()
    input.onTurnStarted('child-turn')
    return { kind: 'answered' as const, text: 'Sage says use the smaller change.', hasReply: true }
  })
  const relay = new AgentRelay({
    store,
    agents: () => roster,
    runtime: {
      isActiveTurn: () => true,
      append: (chatId, draft) => store.appendEvent(chatId, draft).then(() => undefined),
      run,
      synthesize,
      stopTurn,
      broadcastDirectory,
    },
    ...(options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth }),
    ...(options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns }),
  })
  return { relay, store, dm, stopTurn, synthesize, broadcastDirectory }
}

interface ControlledTurn {
  input: TurnInput
  queue: AsyncQueue<RuntimeEvent>
}

function controlledDriver(): { driver: Driver; turns: ControlledTurn[] } {
  const turns: ControlledTurn[] = []
  const driver: Driver = {
    startTurn(input) {
      const queue = new AsyncQueue<RuntimeEvent>()
      turns.push({ input, queue })
      return { events: queue, stop: () => queue.close() }
    },
  }
  return { driver, turns }
}

async function relayLifecycleHarness() {
  const asker = controlledDriver()
  const receiver = gated(() => 'The late specialist reply.')
  const store = createMemoryStore({ agents })
  const dm = await store.createChat({ kind: 'dm', memberIds: ['marlow'], title: 'Marlow' })
  const sent: ServerMessage[] = []
  let orchestrator!: Orchestrator
  orchestrator = new Orchestrator({
    agents: () => agents,
    store,
    mcpServers: () => [],
    resolveDriver: (agent) => agent.id === 'sage' ? receiver.driver : asker.driver,
    ensureScratchDir: scratchFor,
    emit: (message) => {
      sent.push(message)
      closeTerminalTurn(message, (turnId) => orchestrator.closeAgentRelayTurn(turnId))
    },
  })
  const root = orchestrator.submitUserMessage(dm.id, 'Ask Sage.')
  await until(() => asker.turns.length === 1, 'the root lifecycle turn')
  const active = orchestrator.activeTurn(dm.id)
  if (active === undefined) throw new Error('the root lifecycle turn should be active')
  const relayReply = orchestrator.messageAgent(
    rootContext(dm.id, active.turnId),
    'Sage',
    'What is the answer?',
  )
  await until(() => receiver.gates.length === 1, 'the lifecycle receiver turn')
  return { asker, receiver, store, dm, sent, orchestrator, root, relayReply }
}

function finish(turn: ControlledTurn | undefined, text: string): void {
  if (turn === undefined) throw new Error('the controlled turn should exist')
  turn.queue.push({ type: 'result', text })
  turn.queue.close()
}

describe('AgentRelay', () => {
  it('uses one standing unordered pair and records sent and received markers in the DM', async () => {
    const { relay, store, dm, synthesize, broadcastDirectory } = await relayHarness()

    const first = await relay.request(rootContext(dm.id), 'Sage', 'Which change is smallest?')
    expect(first).toContain('Messaged Sage')
    await until(() => synthesize.mock.calls.length === 1, 'the asynchronous return')
    const pair = (await store.listChats()).find((chat) => chat.kind === 'pair')
    const reverse = await store.pairChatFor('sage', 'marlow')
    const targetDm = (await store.listChats()).find(
      (chat) => chat.kind === 'dm' && chat.memberIds[0] === 'sage',
    )

    expect(pair?.id).toBe(reverse.id)
    expect(pair?.memberIds).toEqual(['marlow', 'sage'])
    expect(broadcastDirectory).toHaveBeenCalledOnce()
    expect((await store.loadEvents(dm.id)).filter((event) => event.type === 'agent_relay')).toMatchObject([
      { phase: 'sent', peerAgentId: 'sage', pairChatId: pair?.id, preview: 'Which change is smallest?' },
      { phase: 'received', peerAgentId: 'sage', pairChatId: pair?.id },
    ])
    expect(targetDm).toBeDefined()
    expect((await store.loadEvents(targetDm?.id ?? '')).filter((event) => event.type === 'agent_relay')).toMatchObject([
      { phase: 'received', agentId: 'sage', peerAgentId: 'marlow', pairChatId: pair?.id },
      { phase: 'sent', agentId: 'sage', peerAgentId: 'marlow', pairChatId: pair?.id },
    ])
  })

  it('enforces the depth, callback and repeated-pair guards', async () => {
    const { relay, store, dm } = await relayHarness({ maxDepth: 2 })
    await expect(relay.request(rootContext(dm.id), 'Nobody', 'hello')).rejects.toThrow('No agent named Nobody')

    const pair = await store.pairChatFor('marlow', 'sage')
    const nested = (overrides: Partial<RelayTurnContext> = {}): UserInputContext => ({
      chatId: pair.id,
      agentId: 'sage',
      turnId: 'sage-turn',
      relay: {
        originChatId: dm.id,
        originTurnId: 'root-turn',
        depth: 1,
        parentAgentId: 'marlow',
        ...overrides,
      },
    })
    await expect(relay.request(nested(), 'Marlow', 'callback')).rejects.toThrow('already returns to them')
    await expect(relay.request(nested({ depth: 2 }), 'Smith', 'too deep')).rejects.toThrow('depth is capped at 2')

    await expect(relay.request(nested(), 'Smith', 'first')).resolves.toContain('Message from Smith')
    await expect(relay.request({ ...nested(), turnId: 'sage-turn-2' }, 'Smith', 'again'))
      .rejects.toThrow('already been used')
  })

  it('allows consultation across an empty mention allowlist in both directions', async () => {
    const open = await relayHarness({
      roster: [{ ...marlow, mentionAllowlist: [] }, sage, smith],
    })
    await expect(open.relay.request(rootContext(open.dm.id), 'Smith', 'hello')).resolves.toContain('Messaged Smith')

    const reverse = await relayHarness({ roster: [{ ...marlow, mentionAllowlist: [] }, sage] })
    await expect(reverse.relay.request(rootContext(reverse.dm.id), 'Sage', 'hello')).resolves.toContain('Messaged Sage')
  })

  it('refuses invalid room, identity and payload shapes', async () => {
    const { relay, store, dm } = await relayHarness()
    const group = await store.createChat({ kind: 'group', memberIds: ['marlow', 'sage'] })

    await expect(relay.request(rootContext(group.id), 'Sage', 'wrong room')).rejects.toThrow('only from a direct or relayed')
    await expect(relay.request(rootContext(dm.id), 'Marlow', 'self')).rejects.toThrow('cannot message itself')
    await expect(relay.request(rootContext(dm.id), 'Sage', '')).rejects.toThrow(`between 1 and ${AGENT_RELAY_OUTBOUND_MAX}`)
    await expect(relay.request(rootContext(dm.id), 'Sage', 'x'.repeat(AGENT_RELAY_OUTBOUND_MAX + 1)))
      .rejects.toThrow(`between 1 and ${AGENT_RELAY_OUTBOUND_MAX}`)
  })

  it('caps an inbound answer and labels the truncation', async () => {
    const answer = 'x'.repeat(AGENT_RELAY_INBOUND_MAX + 1)
    const { relay, dm, synthesize } = await relayHarness({
      run: async (input) => {
        await input.onMessageStored()
        return { kind: 'answered', text: answer, hasReply: true }
      },
    })

    await expect(relay.request(rootContext(dm.id), 'Sage', 'short question')).resolves.toContain('Messaged Sage')
    await until(() => synthesize.mock.calls.length === 1, 'the capped return')
    const returned = synthesize.mock.calls[0]?.[0].answer ?? ''
    expect(returned).toContain(`[Reply truncated by Manor at ${AGENT_RELAY_INBOUND_MAX} characters.]`)
    expect(returned).not.toContain('x'.repeat(AGENT_RELAY_INBOUND_MAX + 1))
  })

  it('acknowledges acceptance and records a later receiver startup failure', async () => {
    const { relay, store, dm } = await relayHarness({
      run: () => Promise.reject(new Error('driver did not start')),
    })

    await expect(relay.request(rootContext(dm.id), 'Sage', 'short question'))
      .resolves.toContain('Messaged Sage')
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect((await store.loadEvents(dm.id)).filter((event) => event.type === 'agent_relay'))
      .toMatchObject([{ phase: 'failed', peerAgentId: 'sage' }])
  })

  it('caps agent turns for one originating message and writes the cap note once', async () => {
    const { relay, store, dm } = await relayHarness({ maxTurns: 0 })

    await expect(relay.request(rootContext(dm.id), 'Sage', 'first')).rejects.toThrow('budget exhausted after 0')
    await expect(relay.request(rootContext(dm.id), 'Smith', 'second')).rejects.toThrow('budget exhausted after 0')

    expect((await store.loadEvents(dm.id)).filter(
      (event) => event.type === 'system_note' && event.text.includes('at most 0 agent turns'),
    )).toHaveLength(1)
  })

  it('keeps the turn budget and pair ledger after fast receivers finish', async () => {
    const mercer = { ...smith, id: 'mercer', name: 'Mercer' }
    const { relay, dm, synthesize } = await relayHarness({
      roster: [...agents, mercer],
      maxTurns: 2,
    })

    await expect(relay.request(rootContext(dm.id), 'Sage', 'first'))
      .resolves.toContain('Messaged Sage')
    await until(() => synthesize.mock.calls.length === 1, 'the first fast receiver')
    await expect(relay.request(rootContext(dm.id), 'Sage', 'repeat'))
      .rejects.toThrow('already been used')
    await expect(relay.request(rootContext(dm.id), 'Smith', 'second'))
      .resolves.toContain('Messaged Smith')
    await until(() => synthesize.mock.calls.length === 2, 'the second fast receiver')
    await expect(relay.request(rootContext(dm.id), 'Mercer', 'over budget'))
      .rejects.toThrow('budget exhausted after 2')
    relay.closeTurn('root-turn')
  })

  it('refuses stale or unattended capabilities', async () => {
    const { relay, dm } = await relayHarness()

    await expect(relay.request({ chatId: dm.id, agentId: 'marlow', turnId: 'turn' }, 'Sage', 'hello'))
      .rejects.toThrow('can no longer message')
  })

  it('accepts parallel calls before replies complete, keeps pair guards, and stops every receiver', async () => {
    const releases: Array<(result: TurnResult) => void> = []
    let childCount = 0
    const { relay, dm, stopTurn } = await relayHarness({
      run: async (input) => {
        await input.onMessageStored()
        const childTurnId = `child-turn-${childCount += 1}`
        input.onTurnStarted(childTurnId)
        return new Promise<TurnResult>((resolve) => { releases.push(resolve) })
      },
    })
    const sageRequest = relay.request(rootContext(dm.id), 'Sage', 'wait for Sage')
    const smithRequest = relay.request(rootContext(dm.id), 'Smith', 'wait for Smith')
    await until(() => childCount === 2, 'both relay children to start')

    await expect(Promise.all([sageRequest, smithRequest])).resolves.toEqual([
      expect.stringContaining('Messaged Sage'),
      expect.stringContaining('Messaged Smith'),
    ])
    await expect(relay.request(rootContext(dm.id), 'Sage', 'repeat while pending'))
      .rejects.toThrow('already been used')
    relay.stopFrom('root-turn')
    expect(stopTurn.mock.calls.map(([turnId]) => turnId)).toEqual(['child-turn-1', 'child-turn-2'])
    for (const release of releases) release({ kind: 'stopped' })
  })

  it('reserves every parallel call before room lookup so Stop wins during preflight', async () => {
    const store = createMemoryStore({ agents })
    const dm = await store.createChat({ kind: 'dm', memberIds: ['marlow'], title: 'Marlow' })
    let active = true
    let roomReads = 0
    let releaseRoomRead: (() => void) | undefined
    const roomRead = new Promise<void>((resolve) => { releaseRoomRead = resolve })
    const run = vi.fn(async () => ({
      kind: 'answered' as const,
      text: 'This should never run.',
      hasReply: true,
    }))
    const relay = new AgentRelay({
      store: {
        getChat: async (chatId) => {
          roomReads += 1
          await roomRead
          return store.getChat(chatId)
        },
        createChat: (draft) => store.createChat(draft),
        pairChatFor: (first, second) => store.pairChatFor(first, second),
      },
      agents: () => agents,
      runtime: {
        isActiveTurn: () => active,
        append: (chatId, draft) => store.appendEvent(chatId, draft).then(() => undefined),
        run,
        synthesize: () => Promise.resolve(),
        stopTurn: vi.fn(),
        broadcastDirectory: () => Promise.resolve(),
      },
    })

    const first = relay.request(rootContext(dm.id), 'Sage', 'wait for the room')
    const second = relay.request(rootContext(dm.id), 'Smith', 'also wait for the room')
    await until(() => roomReads === 2, 'both room preflights to start')

    relay.stopFrom('root-turn')
    active = false
    releaseRoomRead?.()
    await expect(Promise.allSettled([first, second])).resolves.toEqual([
      expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ message: 'This turn can no longer message another agent.' }) }),
      expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ message: 'This turn can no longer message another agent.' }) }),
    ])
    expect(run).not.toHaveBeenCalled()
  })

  it('keeps every reserved root call alive when the first acceptance closes the asker turn', async () => {
    const store = createMemoryStore({ agents })
    const dm = await store.createChat({ kind: 'dm', memberIds: ['marlow'], title: 'Marlow' })
    let active = true
    let roomReads = 0
    let releaseSecondRoomRead: (() => void) | undefined
    const secondRoomRead = new Promise<void>((resolve) => { releaseSecondRoomRead = resolve })
    const releases: Array<(result: TurnResult) => void> = []
    const relay = new AgentRelay({
      store: {
        getChat: async (chatId) => {
          roomReads += 1
          if (roomReads === 2) await secondRoomRead
          return store.getChat(chatId)
        },
        createChat: (draft) => store.createChat(draft),
        pairChatFor: (first, second) => store.pairChatFor(first, second),
      },
      agents: () => agents,
      runtime: {
        isActiveTurn: () => active,
        append: (chatId, draft) => store.appendEvent(chatId, draft).then(() => undefined),
        run: async (input) => {
          await input.onMessageStored()
          return new Promise<TurnResult>((resolve) => { releases.push(resolve) })
        },
        synthesize: () => Promise.resolve(),
        stopTurn: vi.fn(),
        broadcastDirectory: () => Promise.resolve(),
      },
    })

    await expect(relay.request(rootContext(dm.id), 'Sage', 'first'))
      .resolves.toContain('Messaged Sage')
    const second = relay.request(rootContext(dm.id), 'Smith', 'second')
    await until(() => roomReads === 2, 'the second reserved room preflight')
    relay.closeTurn('root-turn')
    active = false
    releaseSecondRoomRead?.()

    await expect(second).resolves.toContain('Messaged Smith')
    for (const release of releases) release({ kind: 'stopped' })
  })

  it('lets a receiver outlive a dropped provider and synthesizes its eventual reply', async () => {
    let release: ((result: TurnResult) => void) | undefined
    let childStarted = false
    const running = new Promise<TurnResult>((resolve) => { release = resolve })
    const { relay, dm, stopTurn, synthesize } = await relayHarness({
      run: async (input) => {
        await input.onMessageStored()
        input.onTurnStarted('child-turn')
        childStarted = true
        return running
      },
    })
    const request = relay.request(rootContext(dm.id), 'Sage', 'wait')
    await until(() => childStarted, 'relay to enter its child turn')

    relay.closeTurn('root-turn')
    expect(stopTurn).not.toHaveBeenCalled()
    release?.({ kind: 'answered', text: 'The eventual answer.', hasReply: true })
    await request
    await until(() => synthesize.mock.calls.length === 1, 'the ordinary return')
    expect(synthesize).toHaveBeenCalledWith(expect.objectContaining({
      asker: expect.objectContaining({ id: 'marlow' }),
      target: expect.objectContaining({ id: 'sage' }),
      answer: 'The eventual answer.',
    }))
  })

  it('still stops an in-flight child when a nested asker turn ends', async () => {
    let release: ((result: TurnResult) => void) | undefined
    let childStarted = false
    const running = new Promise<TurnResult>((resolve) => { release = resolve })
    const { relay, store, dm, stopTurn, synthesize } = await relayHarness({
      run: async (input) => {
        await input.onMessageStored()
        input.onTurnStarted('nested-child-turn')
        childStarted = true
        return running
      },
    })
    const pair = await store.pairChatFor('marlow', 'sage')
    const nestedContext: UserInputContext = {
      chatId: pair.id,
      agentId: 'sage',
      turnId: 'sage-turn',
      relay: {
        originChatId: dm.id,
        originTurnId: 'root-turn',
        depth: 1,
        parentAgentId: 'marlow',
      },
    }
    const request = relay.request(nestedContext, 'Smith', 'Check this.')
    await until(() => childStarted, 'the nested child turn')

    relay.closeTurn('sage-turn')
    expect(stopTurn).toHaveBeenCalledWith('nested-child-turn')
    release?.({ kind: 'stopped' })
    await request
    expect(synthesize).not.toHaveBeenCalled()
  })

  it('starts exactly one return without waiting for the asker turn to close', async () => {
    const { relay, dm, synthesize } = await relayHarness()
    await relay.request(rootContext(dm.id), 'Sage', 'wait')
    await until(() => synthesize.mock.calls.length === 1, 'the ordinary return')
    relay.closeTurn('root-turn')
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(synthesize).toHaveBeenCalledOnce()
  })
})

describe('agent relay orchestration', () => {
  it('returns from a nested relay when its pair chat is already occupied', async () => {
    const gate = gated()
    const store = createMemoryStore({ agents })
    const marlowDm = await store.createChat({ kind: 'dm', memberIds: ['marlow'], title: 'Marlow' })
    const smithDm = await store.createChat({ kind: 'dm', memberIds: ['smith'], title: 'Smith' })
    const orchestrator = new Orchestrator({
      agents: () => agents,
      store,
      mcpServers: () => [],
      resolveDriver: () => gate.driver,
      ensureScratchDir: scratchFor,
      emit: () => undefined,
    })
    const smithRoot = orchestrator.submitUserMessage(smithDm.id, 'Ask Sage.')
    await until(() => gate.forChat(smithDm.id).length === 1, 'Smith root')
    const smithRootTurn = orchestrator.activeTurn(smithDm.id)?.turnId
    if (smithRootTurn === undefined) throw new Error('Smith root should be active')
    await orchestrator.messageAgent({
      chatId: smithDm.id, agentId: 'smith', turnId: smithRootTurn,
      canApprove: true,
      relay: { originChatId: smithDm.id, originTurnId: smithRootTurn, depth: 0 },
    }, 'Sage', 'First consultation')
    const busyPair = await store.pairChatFor('smith', 'sage')
    await until(() => gate.forChat(busyPair.id).length === 1, 'the busy pair')

    const marlowRoot = orchestrator.submitUserMessage(marlowDm.id, 'Ask Smith.')
    await until(() => gate.forChat(marlowDm.id).length === 1, 'Marlow root')
    const marlowRootTurn = orchestrator.activeTurn(marlowDm.id)?.turnId
    if (marlowRootTurn === undefined) throw new Error('Marlow root should be active')
    await orchestrator.messageAgent(rootContext(marlowDm.id, marlowRootTurn), 'Smith', 'Second consultation')
    const nestedPair = await store.pairChatFor('marlow', 'smith')
    await until(() => gate.forChat(nestedPair.id).length === 1, 'the nested pair')
    const nestedTurn = orchestrator.activeTurn(nestedPair.id)?.turnId
    if (nestedTurn === undefined) throw new Error('nested turn should be active')
    const nested = orchestrator.messageAgent({
      chatId: nestedPair.id, agentId: 'smith', turnId: nestedTurn,
      canApprove: false,
      relay: { originChatId: marlowDm.id, originTurnId: marlowRootTurn, depth: 1, parentAgentId: 'marlow' },
    }, 'Sage', 'Check this too')
    const answer = await Promise.race([
      nested,
      new Promise<string>((resolve) => setTimeout(() => resolve('timed out'), 100)),
    ])
    expect(answer).toContain('failed before a reply arrived')
    expect(gate.forChat(busyPair.id)).toHaveLength(1)

    gate.forChat(smithDm.id)[0]?.finish()
    gate.forChat(marlowDm.id)[0]?.finish()
    gate.forChat(busyPair.id)[0]?.finish()
    gate.forChat(nestedPair.id)[0]?.finish()
    await Promise.all([smithRoot, marlowRoot])
  })

  it.each([false, true])('restores relay context after rollover and saves a durable seed (steered: %s)', async (steer) => {
    const h = await relayLifecycleHarness()
    const original = (await h.store.loadEvents(h.dm.id)).find((event) => event.type === 'user_message')
    if (original === undefined) throw new Error('the original question should exist')
    await h.store.setChatSummary(h.dm.id, 'Keep the travel plan within the agreed budget.', original.id)
    h.asker.turns[0]?.queue.push({
      type: 'result', text: 'I asked Sage.', sessionId: 'full-session',
      contextTokens: Math.ceil(contextWindowFor(marlow.driver, marlow.model) * SESSION_CONTEXT_FRACTION),
    })
    h.asker.turns[0]?.queue.close()
    await h.root
    await h.relayReply
    h.receiver.gates[0]?.finish()
    await until(() => h.asker.turns.length === 2, 'the fresh return turn')

    let returned = h.asker.turns[1]
    let steering: Promise<void> | undefined
    if (steer) {
      steering = h.orchestrator.submitUserMessage(h.dm.id, 'Also keep the hotel near the station.')
      await until(() => h.asker.turns.length === 3, 'the steered fresh return')
      returned = h.asker.turns[2]
      expect(returned?.input.catchUp).toContainEqual(expect.objectContaining({
        type: 'user_message', text: 'Also keep the hotel near the station.',
      }))
    }
    expect(returned?.input.sessionId).toBeUndefined()
    expect(returned?.input.isFullCatchUp).toBe(true)
    expect(returned?.input.catchUpSummary?.text).toBe('Keep the travel plan within the agreed budget.')
    expect(returned?.input.catchUp).toContainEqual(expect.objectContaining({
      type: 'user_message', source: 'agent_relay', text: 'The late specialist reply.',
    }))
    const canonical = await h.store.loadEvents(h.dm.id)
    const durableIds = new Set(canonical.map((event) => event.id))
    const lastDurableInput = returned?.input.catchUp.filter((event) => durableIds.has(event.id)).at(-1)?.id
    expect(lastDurableInput).toBeDefined()
    returned?.queue.push({ type: 'result', text: 'Here is the complete answer.', sessionId: 'fresh-return' })
    returned?.queue.close()
    await until(() => h.orchestrator.activeTurn(h.dm.id) === undefined, 'the fresh return to finish')
    await steering
    expect(await h.store.getSessions(h.dm.id, 'marlow')).toMatchObject([{
      sessionId: 'fresh-return', seededThroughEventId: lastDurableInput,
    }])

    const followUp = h.orchestrator.submitUserMessage(h.dm.id, 'Continue with that plan.')
    await until(() => h.asker.turns.length === (steer ? 4 : 3), 'the next resumed turn')
    expect(h.asker.turns.at(-1)?.input.sessionId).toBe('fresh-return')
    expect(h.asker.turns.at(-1)?.input.isFullCatchUp).toBe(false)
    finish(h.asker.turns.at(-1), 'Continuing.')
    await followUp
  })

  it('runs the receiver in the standing pair session with untrusted provenance and no approval', async () => {
    const gate = gated()
    const consultationRoster = [
      { ...marlow, mentionAllowlist: [] },
      { ...sage, mentionAllowlist: [] },
      smith,
    ]
    const store = createMemoryStore({ agents: consultationRoster })
    const dm = await store.createChat({ kind: 'dm', memberIds: ['marlow'], title: 'Marlow' })
    const permissions: Array<{ agentId: string; canApprove: boolean; allowRelay: boolean }> = []
    const connectorCapabilities: Array<{ agentId: string; readOnly: boolean }> = []
    const attachment: AttachedMcpServer = {
      server: {
        id: 'test-interaction', name: 'manor', command: 'node', args: [], envKeys: [],
        description: '', writes: false, effectPolicy: 'trusted', tools: [], readOnlyTools: [], schemaChars: 0,
      },
      disabledTools: [],
    }
    const orchestrator = new Orchestrator({
      agents: () => consultationRoster,
      store,
      mcpServers: () => [],
      resolveDriver: () => gate.driver,
      ensureScratchDir: scratchFor,
      emit: () => undefined,
      guardMcp: (attached, context) => {
        connectorCapabilities.push({ agentId: context.agentId, readOnly: context.readOnly })
        return [...attached]
      },
      interactionMcp: (_chatId, agent, _turnId, _allowAsk, granted) => {
        if (granted !== undefined) permissions.push({ agentId: agent.id, canApprove: granted.canApprove, allowRelay: granted.allowRelay })
        return attachment
      },
    })

    const root = orchestrator.submitUserMessage(dm.id, 'Can you ask Sage?')
    await until(() => gate.forChat(dm.id).length === 1, 'the root DM turn')
    const rootTurn = orchestrator.activeTurn(dm.id)
    if (rootTurn === undefined) throw new Error('the DM turn should be active')
    const reply = orchestrator.messageAgent(rootContext(dm.id, rootTurn.turnId), 'Sage', 'What is your verdict?')
    await until(() => gate.gates.length === 2, 'the pair receiver turn')
    const pair = (await store.listChats()).find((chat) => chat.kind === 'pair')
    if (pair === undefined) throw new Error('the pair chat should exist')

    await expect(reply).resolves.toContain('Messaged Sage')
    gate.forChat(dm.id)[0]?.finish()
    await root
    gate.forChat(pair.id)[0]?.finish()
    await until(() => gate.forChat(dm.id).length === 2, 'the consultation return turn')
    gate.forChat(dm.id)[1]?.finish()
    await until(() => orchestrator.activeTurn(dm.id) === undefined, 'the consultation return')

    expect((await store.loadEvents(pair.id))[0]).toMatchObject({
      type: 'user_message',
      source: 'agent_relay',
      authorAgentId: 'marlow',
      originChatId: dm.id,
      originTurnId: rootTurn.turnId,
    })
    expect(await store.getSessions(pair.id, 'sage')).toMatchObject([{ sessionId: `session-${pair.id}-sage` }])
    expect(gate.forChat(pair.id)[0]?.input.catchUp[0]).toMatchObject({ source: 'agent_relay', authorAgentId: 'marlow' })
    expect(gate.forChat(pair.id)[0]?.input.manorFollowUp).toBe(true)
    expect(gate.forChat(dm.id)[0]?.input.agent.character).toContain('reachable names: Sage, Smith')
    expect(permissions).toContainEqual({ agentId: 'sage', canApprove: false, allowRelay: true })
    expect(connectorCapabilities).toContainEqual({ agentId: 'sage', readOnly: true })
  })

  it('returns every inbound reply through one fully capable asker turn without mirroring it into the DM', async () => {
    const capableMarlow = { ...agents[0]!, allowedTools: ['Read', 'Bash'] }
    const capableAgents = [capableMarlow, ...agents.slice(1)]
    const askerGate = gated((input) => input.agent.name === 'Marlow' && input.catchUp.some(
      (event) => event.type === 'user_message' && event.source === 'agent_relay',
    ) ? 'Sage recommends the smaller fix.' : '')
    const receiverGate = gated(() => 'The smaller fix avoids a second delivery path.')
    const store = createMemoryStore({ agents: capableAgents })
    const dm = await store.createChat({ kind: 'dm', memberIds: ['marlow'], title: 'Marlow' })
    const workAttachment: AttachedMcpServer = {
      server: {
        id: 'builtin_work', name: 'work', command: 'node', args: [], envKeys: [],
        description: '', writes: true, effectPolicy: 'trusted', tools: ['start_work'], readOnlyTools: [], schemaChars: 0,
      },
      disabledTools: [],
    }
    const orchestrator = new Orchestrator({
      agents: () => capableAgents,
      store,
      mcpServers: () => [],
      resolveDriver: (agent) => agent.id === 'sage' ? receiverGate.driver : askerGate.driver,
      ensureScratchDir: scratchFor,
      emit: () => undefined,
      workMcp: () => workAttachment,
    })

    const root = orchestrator.submitUserMessage(dm.id, 'Ask Sage for the smallest fix.')
    await until(() => askerGate.forChat(dm.id).length === 1, 'the root asker turn')
    const rootTurn = orchestrator.activeTurn(dm.id)
    if (rootTurn === undefined) throw new Error('the asker turn should be active')
    const relayReply = orchestrator.messageAgent(
      rootContext(dm.id, rootTurn.turnId),
      'Sage',
      'Which fix is smallest?',
    )
    await expect(relayReply).resolves.toContain('Messaged Sage')
    askerGate.forChat(dm.id)[0]?.finish()
    await root
    await until(() => receiverGate.gates.length === 1, 'the receiver turn')
    receiverGate.gates[0]?.finish()

    await until(() => askerGate.forChat(dm.id).length === 2, 'the inbound return turn')
    const returnTurn = askerGate.forChat(dm.id)[1]
    expect(returnTurn?.input.manorFollowUp).toBe(true)
    expect(returnTurn?.input.agent.allowedTools).toEqual(['Read', 'Bash'])
    expect(returnTurn?.input.mcpServers).toContainEqual(workAttachment)
    expect(returnTurn?.input.repoPaths).toEqual([])
    expect(returnTurn?.input.catchUp).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'user_message',
        source: 'agent_relay',
        authorAgentId: 'sage',
        text: 'The smaller fix avoids a second delivery path.',
      }),
    ]))
    returnTurn?.finish()
    await until(() => orchestrator.activeTurn(dm.id) === undefined, 'the visible return reply')

    const dmEvents = await store.loadEvents(dm.id)
    expect(dmEvents.some(
      (event) => event.type === 'agent_message' && event.text === 'Sage recommends the smaller fix.',
    )).toBe(true)
    expect(dmEvents.some(
      (event) => 'text' in event && event.text === 'The smaller fix avoids a second delivery path.',
    )).toBe(false)
  })

  it('queues the consultation return behind work the user starts while the receiver is busy', async () => {
    const askerGate = gated()
    const receiverGate = gated(() => 'The specialist reply.')
    const store = createMemoryStore({ agents })
    const dm = await store.createChat({ kind: 'dm', memberIds: ['marlow'], title: 'Marlow' })
    const orchestrator = new Orchestrator({
      agents: () => agents,
      store,
      mcpServers: () => [],
      resolveDriver: (agent) => agent.id === 'sage' ? receiverGate.driver : askerGate.driver,
      ensureScratchDir: scratchFor,
      emit: () => undefined,
    })

    const root = orchestrator.submitUserMessage(dm.id, 'Ask Sage.')
    await until(() => askerGate.forChat(dm.id).length === 1, 'the root asker turn')
    const rootTurn = orchestrator.activeTurn(dm.id)
    if (rootTurn === undefined) throw new Error('the root asker turn should be active')
    await expect(orchestrator.messageAgent(
      rootContext(dm.id, rootTurn.turnId),
      'Sage',
      'What is the answer?',
    )).resolves.toContain('Messaged Sage')
    askerGate.forChat(dm.id)[0]?.finish()
    await root

    const steering = orchestrator.submitUserMessage(dm.id, 'Handle this meanwhile.')
    await until(() => askerGate.forChat(dm.id).length === 2, 'the intervening user turn')
    await until(() => receiverGate.gates.length === 1, 'the consultation receiver')
    receiverGate.gates[0]?.finish()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(askerGate.forChat(dm.id)).toHaveLength(2)

    askerGate.forChat(dm.id)[1]?.finish()
    await steering
    await until(() => askerGate.forChat(dm.id).length === 3, 'the queued consultation return')
    askerGate.forChat(dm.id)[2]?.finish()
    await until(() => orchestrator.activeTurn(dm.id) === undefined, 'the queued return to finish')
  })

  it('lets the receiver finish after a real provider error and delivers through the terminal hook', async () => {
    const lifecycle = await relayLifecycleHarness()
    const rootTurn = lifecycle.asker.turns[0]
    rootTurn?.queue.push({ type: 'error', message: 'provider connection dropped' })
    rootTurn?.queue.close()
    await lifecycle.root

    lifecycle.receiver.gates[0]?.finish()
    await lifecycle.relayReply
    await until(() => lifecycle.asker.turns.length === 2, 'the provider-drop synthesis turn')
    const returnTurn = lifecycle.asker.turns[1]
    expect(returnTurn?.input.catchUp).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'user_message', source: 'agent_relay', text: 'The late specialist reply.' }),
    ]))
    finish(returnTurn, 'Marlow delivers the late reply.')
    await until(() => lifecycle.orchestrator.activeTurn(lifecycle.dm.id) === undefined, 'the provider-drop synthesis')

    expect((await lifecycle.store.loadEvents(lifecycle.dm.id)).some(
      (event) => event.type === 'agent_message' && event.text === 'Marlow delivers the late reply.',
    )).toBe(true)
    expect(lifecycle.sent.some(
      (message) => message.type === 'turn_state' && message.state === 'error',
    )).toBe(true)
  })

  it('returns exactly once after the accepted tool acknowledgment', async () => {
    const lifecycle = await relayLifecycleHarness()
    const rootTurn = lifecycle.asker.turns[0]
    // Loading the deferred tool schema is not the relay call and keeps the turn open.
    rootTurn?.queue.push({ type: 'tool_use', toolCallId: 'schema-call', tool: 'ToolSearch', detail: 'select:mcp__manor__message_agent' })
    rootTurn?.queue.push({ type: 'tool_result', toolCallId: 'schema-call', outcome: 'success' })
    await until(() => lifecycle.sent.some((message) =>
      message.type === 'event' && message.event.type === 'tool_result' && message.event.toolCallId === 'schema-call',
    ), 'the schema lookup result')
    expect(lifecycle.orchestrator.activeTurn(lifecycle.dm.id)).toBeDefined()
    rootTurn?.queue.push({
      type: 'tool_use',
      toolCallId: 'relay-call',
      tool: 'mcp__manor__message_agent',
    })
    rootTurn?.queue.push({ type: 'tool_result', toolCallId: 'relay-call', outcome: 'success' })
    await lifecycle.root

    expect((await lifecycle.store.loadEvents(lifecycle.dm.id)).filter(
      (event) => event.type === 'system_note' && event.text.includes('without reporting back'),
    )).toEqual([])

    lifecycle.receiver.gates[0]?.finish()
    await lifecycle.relayReply
    await until(() => lifecycle.asker.turns.length === 2, 'the consultation return turn')
    finish(lifecycle.asker.turns[1], 'Marlow states Sage’s actual answer.')
    await until(() => lifecycle.orchestrator.activeTurn(lifecycle.dm.id) === undefined, 'the consultation return')

    const messages = (await lifecycle.store.loadEvents(lifecycle.dm.id))
      .filter((event) => event.type === 'agent_message')
      .map((event) => event.text)
    expect(messages).toEqual(['Marlow states Sage’s actual answer.'])
  })

  it('starts the return from a real terminal done state when the asker stayed silent', async () => {
    const lifecycle = await relayLifecycleHarness()
    lifecycle.receiver.gates[0]?.finish()
    await lifecycle.relayReply
    finish(lifecycle.asker.turns[0], '')
    await lifecycle.root

    await until(() => lifecycle.asker.turns.length === 2, 'the closed-turn synthesis turn')
    finish(lifecycle.asker.turns[1], 'Marlow follows up with the answer.')
    await until(() => lifecycle.orchestrator.activeTurn(lifecycle.dm.id) === undefined, 'the closed-turn synthesis')
    expect((await lifecycle.store.loadEvents(lifecycle.dm.id)).some(
      (event) => event.type === 'agent_message' && event.text === 'Marlow follows up with the answer.',
    )).toBe(true)
  })

  it('still enqueues one return after a successful acknowledgment', async () => {
    const lifecycle = await relayLifecycleHarness()
    lifecycle.receiver.gates[0]?.finish()
    await lifecycle.relayReply
    const rootTurn = lifecycle.asker.turns[0]
    rootTurn?.queue.push({
      type: 'tool_use',
      toolCallId: 'relay-call',
      tool: 'mcp__manor__message_agent',
    })
    rootTurn?.queue.push({ type: 'tool_result', toolCallId: 'relay-call', outcome: 'success' })
    finish(rootTurn, 'Marlow already states Sage’s answer.')
    await lifecycle.root
    await until(() => lifecycle.asker.turns.length === 2, 'the ordinary return turn')
    finish(lifecycle.asker.turns[1], 'Marlow states the returned answer in his own words.')
    await until(() => lifecycle.orchestrator.activeTurn(lifecycle.dm.id) === undefined, 'the ordinary return')

    expect(lifecycle.asker.turns).toHaveLength(2)
    expect((await lifecycle.store.loadEvents(lifecycle.dm.id)).filter(
      (event) => event.type === 'agent_message',
    )).toHaveLength(1)
  })

  it.each([
    ['between its DM turns', 'between'],
    ['while its own DM turn runs', 'during'],
    ['while its own DM turn runs and the user steers it', 'steered'],
  ] as const)('carries a received consultation and its reply into the receiver\'s own DM %s', async (_when, timing) => {
    const asker = gated((input) => input.catchUp.some((event) => event.type === 'user_message' && event.source === 'agent_relay')
      ? 'Sage has it on record.'
      : '')
    const receiver = gated(() => 'Recorded the grant rejection in pipeline.md.')
    const store = createMemoryStore({ agents })
    const askerDm = await store.createChat({ kind: 'dm', memberIds: ['marlow'], title: 'Marlow' })
    const sageDm = await store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })
    const orchestrator = new Orchestrator({
      agents: () => agents,
      store,
      mcpServers: () => [],
      resolveDriver: (agent) => agent.id === 'sage' ? receiver.driver : asker.driver,
      ensureScratchDir: scratchFor,
      emit: () => undefined,
    })

    // Sage holds a provider session in its own DM, so the later turn resumes it.
    const earlier = orchestrator.submitUserMessage(sageDm.id, 'Where is the grant application?')
    await until(() => receiver.forChat(sageDm.id).length === 1, 'the earlier Sage DM turn')
    if (timing === 'between') {
      receiver.forChat(sageDm.id)[0]?.finish()
      await earlier
    }

    const root = orchestrator.submitUserMessage(askerDm.id, 'Tell Sage the grant fund said no.')
    await until(() => asker.forChat(askerDm.id).length === 1, 'the asker turn')
    const rootTurn = orchestrator.activeTurn(askerDm.id)
    if (rootTurn === undefined) throw new Error('the asker turn should be active')
    await orchestrator.messageAgent(rootContext(askerDm.id, rootTurn.turnId), 'Sage', 'The grant fund rejected us. Please record it.')
    asker.forChat(askerDm.id)[0]?.finish()
    await root
    const pair = (await store.listChats()).find((chat) => chat.kind === 'pair')
    if (pair === undefined) throw new Error('the pair chat should exist')
    await until(() => receiver.forChat(pair.id).length === 1, 'the receiver turn')
    receiver.forChat(pair.id)[0]?.finish()
    await until(() => asker.forChat(askerDm.id).length === 2, 'the consultation return')
    asker.forChat(askerDm.id)[1]?.finish()
    await until(() => orchestrator.activeTurn(askerDm.id) === undefined, 'the asker return reply')
    if (timing === 'steered') {
      const steering = orchestrator.submitUserMessage(sageDm.id, 'Only the open applications, please.')
      await until(() => receiver.forChat(sageDm.id).length === 2, 'the steered Sage DM attempt')
      receiver.forChat(sageDm.id)[1]?.finish()
      await Promise.all([earlier, steering])
    } else if (timing === 'during') {
      receiver.forChat(sageDm.id)[0]?.finish()
      await earlier
    }

    const held = receiver.forChat(sageDm.id).length
    const later = orchestrator.submitUserMessage(sageDm.id, 'Did Marlow tell you anything about the grant?')
    await until(() => receiver.forChat(sageDm.id).length === held + 1, 'the later Sage DM turn')
    const laterTurn = receiver.forChat(sageDm.id)[held]
    expect(laterTurn?.input.sessionId).toBe(`session-${sageDm.id}-sage`)
    const seen = renderCatchUpEvents(laterTurn?.input.catchUp ?? [], agents)
    expect(seen).toContain('Marlow messaged you')
    expect(seen).toContain('The grant fund rejected us. Please record it.')
    expect(seen).toContain('Recorded the grant rejection in pipeline.md.')
    expect(seen).not.toContain('Tell Sage the grant fund said no.')
    laterTurn?.finish()
    await later

    // The stored DM keeps only its breadcrumbs; the exchange stays in the pair chat.
    expect((await store.loadEvents(sageDm.id)).filter((event) => event.type === 'system_note')).toEqual([])
    // Read once: the turn after next does not repeat the exchange.
    const next = orchestrator.submitUserMessage(sageDm.id, 'Thanks.')
    await until(() => receiver.forChat(sageDm.id).length === held + 2, 'the next Sage DM turn')
    expect(renderCatchUpEvents(receiver.forChat(sageDm.id)[held + 1]?.input.catchUp ?? [], agents)).toBe('User: Thanks.')
    receiver.forChat(sageDm.id)[held + 1]?.finish()
    await next
  })

  it('carries a relay that landed before a message queued during the previous DM turn', async () => {
    const store = createMemoryStore({ agents })
    const pair = await store.pairChatFor('marlow', 'sage')
    const dm = await store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })
    await store.appendEvent(pair.id, {
      type: 'user_message', text: 'The grant fund rejected us.', mentions: [], source: 'agent_relay', authorAgentId: 'marlow', relayId: 'relay_1',
    })
    await store.appendEvent(dm.id, { type: 'user_message', text: 'Build it in the background.', mentions: [], dispatchState: 'completed' })
    await store.appendEvent(dm.id, {
      type: 'agent_relay', phase: 'received', agentId: 'sage', peerAgentId: 'marlow', pairChatId: pair.id, turnId: 'turn_1', relayId: 'relay_1',
    })
    // Saved while that turn waited on background work, so it runs as the next turn.
    await store.appendEvent(dm.id, { type: 'user_message', text: 'Did Marlow write?', mentions: [], dispatchState: 'started' })
    await store.appendEvent(dm.id, { type: 'turn_result', agentId: 'sage', turnId: 'turn_dm', driver: 'claude' })

    const prepared = await createTurnContext({ store, agents: () => agents }).prepareAttempt({
      chatId: dm.id, agentId: 'sage', driver: 'claude', sessionId: 'session-sage', room: dm, cwd: await scratchFor(dm.id),
    })
    const seen = renderCatchUpEvents(prepared.catchUp, agents)
    expect(seen).toContain('Marlow wrote: "The grant fund rejected us."')
    expect(seen).toContain('Did Marlow write?')
  })

  it('reads a relay only for the DM persona that received it', async () => {
    const store = createMemoryStore({ agents })
    const pair = await store.pairChatFor('marlow', 'sage')
    const dms = {
      sage: await store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' }),
      marlow: await store.createChat({ kind: 'dm', memberIds: ['marlow'], title: 'Marlow' }),
      smith: await store.createChat({ kind: 'dm', memberIds: ['smith'], title: 'Smith' }),
    }
    await store.appendEvent(pair.id, {
      type: 'user_message', text: 'The grant fund rejected us.', mentions: [], source: 'agent_relay', authorAgentId: 'marlow', relayId: 'relay_1',
    })
    const marker = { type: 'agent_relay' as const, pairChatId: pair.id, turnId: 'turn_1', relayId: 'relay_1' }
    await store.appendEvent(dms.sage.id, { ...marker, phase: 'received', agentId: 'sage', peerAgentId: 'marlow' })
    // The asker already holds the exchange in its own turn and relay return.
    await store.appendEvent(dms.marlow.id, { ...marker, phase: 'sent', agentId: 'marlow', peerAgentId: 'sage' })
    // A forged breadcrumb in an unrelated DM must not pull that pair's text in.
    await store.appendEvent(dms.smith.id, { ...marker, phase: 'received', agentId: 'smith', peerAgentId: 'marlow' })
    const read = async (chatId: string) =>
      renderCatchUpEvents(await withRelayExchanges(chatId, [...await store.loadEvents(chatId)], store, agents), agents)

    expect(await read(dms.sage.id)).toContain('Marlow wrote: "The grant fund rejected us."')
    expect(await read(dms.marlow.id)).toBe('')
    expect(await read(dms.smith.id)).toBe('')
  })

  it('does not return pre-tool narration as the receiver reply', async () => {
    const gate = gated()
    const receiver = scripted(() => [
      { type: 'delta', messageId: 'message-1', text: "I'll check." },
      { type: 'message', messageId: 'message-1', text: "I'll check." },
      { type: 'tool_use', toolCallId: 'read-1', tool: 'Read', detail: 'notes.md' },
      { type: 'tool_result', toolCallId: 'read-1', outcome: 'success' },
      { type: 'result', text: "I'll check." },
    ], [])
    const store = createMemoryStore({ agents })
    const dm = await store.createChat({ kind: 'dm', memberIds: ['marlow'], title: 'Marlow' })
    const orchestrator = new Orchestrator({
      agents: () => agents,
      store,
      mcpServers: () => [],
      resolveDriver: (agent) => agent.id === 'sage' ? receiver : gate.driver,
      ensureScratchDir: scratchFor,
      emit: () => undefined,
    })

    const root = orchestrator.submitUserMessage(dm.id, 'Can you ask Sage?')
    await until(() => gate.forChat(dm.id).length === 1, 'the root DM turn')
    const rootTurn = orchestrator.activeTurn(dm.id)
    if (rootTurn === undefined) throw new Error('the DM turn should be active')
    const reply = await orchestrator.messageAgent(rootContext(dm.id, rootTurn.turnId), 'Sage', 'What did you find?')

    expect(reply).toContain('Messaged Sage')
    await new Promise<void>((resolve) => setImmediate(resolve))
    const relayMarker = (await store.loadEvents(dm.id))
      .filter((event) => event.type === 'agent_relay')
      .at(-1)
    expect(relayMarker).toMatchObject({ phase: 'received' })
    expect(relayMarker).not.toHaveProperty('preview')
    const targetDm = (await store.listChats()).find(
      (candidate) => candidate.kind === 'dm' && candidate.memberIds[0] === 'sage',
    )
    expect((await store.loadEvents(targetDm?.id ?? '')).filter((event) => event.type === 'agent_relay'))
      .toMatchObject([{ phase: 'received', peerAgentId: 'marlow' }])

    gate.forChat(dm.id)[0]?.finish()
    await root
  })
})
