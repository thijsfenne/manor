import type { AgentConfig, Driver, ServerMessage } from '@manor/contracts'
import { describe, expect, it, vi } from 'vitest'
import { createMockDriver } from '../src/drivers/mockDriver.js'
import { groupTurnRouterThreadId, type RouteGroupTurn } from '../src/groupTurnRouter.js'
import { Orchestrator } from '../src/orchestrator.js'
import type { Store } from '../src/store.js'
import { createMemoryStore } from '../src/stores/memoryStore.js'
import { cosRoster, scratchFor, scripted } from './helpers.js'

/**
 * Routing in the two home-scope kinds. A project chat routes exactly the way it did
 * before this feature existed, which the last test in this file is here to hold.
 *
 * `cosRoster` is Marlow (chief of staff), Sage and Smith.
 */
async function harness(
  driver: Driver,
  agents: readonly AgentConfig[] = cosRoster,
  routeGroupTurn?: RouteGroupTurn,
) {
  const store: Store = createMemoryStore({ agents })
  const sent: ServerMessage[] = []
  const orchestrator = new Orchestrator({
    agents: () => agents,
    store,
    mcpServers: () => [],
    resolveDriver: () => driver,
    ensureScratchDir: scratchFor,
    emit: (message) => sent.push(message),
    ...(routeGroupTurn === undefined ? {} : { routeGroupTurn }),
  })
  return { orchestrator, store, sent }
}

const speakers = async (store: Store, chatId: string) =>
  (await store.loadEvents(chatId))
    .filter((event) => event.type === 'agent_message')
    .map((event) => ('agentId' in event ? event.agentId : ''))

const notes = async (store: Store, chatId: string) =>
  (await store.loadEvents(chatId))
    .filter((event) => event.type === 'system_note')
    .map((event) => ('text' in event ? event.text : ''))

describe('home-scope routing', () => {
  it('sends an un-mentioned message in a DM to the persona whose DM it is', async () => {
    // The chief of staff answering a message addressed to Smith is exactly the
    // failure a DM exists to prevent.
    const { orchestrator, store } = await harness(createMockDriver({ deltaDelayMs: 0 }))
    const dm = await store.createChat({ kind: 'dm', memberIds: ['smith'], title: 'Smith' })

    await orchestrator.submitUserMessage(dm.id, 'how does the driver interface work?')

    expect(await speakers(store, dm.id)).toEqual(['smith'])
    expect(await notes(store, dm.id)).toEqual([])
  })

  it('sends an un-mentioned message in a group to the chief of staff when it is a member', async () => {
    const { orchestrator, store } = await harness(createMockDriver({ deltaDelayMs: 0 }))
    const group = await store.createChat({ kind: 'group', memberIds: ['marlow', 'sage'] })

    await orchestrator.submitUserMessage(group.id, 'where are we?')

    expect(await speakers(store, group.id)).toEqual(['marlow'])
  })

  it('lets the group router select one or several members from message and conversation context', async () => {
    const route = vi.fn<RouteGroupTurn>().mockResolvedValue(['sage', 'smith'])
    const { orchestrator, store } = await harness(
      createMockDriver({ deltaDelayMs: 0 }),
      cosRoster,
      route,
    )
    const group = await store.createChat({ kind: 'group', memberIds: ['marlow', 'sage', 'smith'] })
    await orchestrator.submitUserMessage(group.id, '@Sage set the scene')

    await orchestrator.submitUserMessage(group.id, 'any concerns with this plan?')

    expect(await speakers(store, group.id)).toEqual(['sage', 'sage', 'smith'])
    expect(route).toHaveBeenCalledOnce()
    expect(route).toHaveBeenCalledWith(expect.objectContaining({
      chatId: group.id,
      message: 'any concerns with this plan?',
      fallbackAgentIds: ['sage'],
    }))
    const routed = route.mock.calls[0]?.[0]
    expect(routed?.members.map((agent) => agent.id)).toEqual(['marlow', 'sage', 'smith'])
    expect(routed?.transcript).toContain('Sage:')
  })

  it.each(['Hey', 'Hey guys', 'Hoi allemaal'])(
    'addresses the group greeting %j to every member without spending a model turn',
    async (message) => {
      const route = vi.fn<RouteGroupTurn>().mockResolvedValue(['marlow'])
      const { orchestrator, store } = await harness(
        createMockDriver({ deltaDelayMs: 0 }),
        cosRoster,
        route,
      )
      const group = await store.createChat({ kind: 'group', memberIds: ['marlow', 'sage', 'smith'] })

      await orchestrator.submitUserMessage(group.id, message)

      expect(await speakers(store, group.id)).toEqual(['marlow', 'sage', 'smith'])
      expect(route).not.toHaveBeenCalled()
    },
  )

  it.each(['Can you guys evaluate Manor?', 'Kunnen jullie Manor evalueren?'])(
    'asks the model to judge sufficient responders for substantive group wording %j',
    async (message) => {
      const route = vi.fn<RouteGroupTurn>().mockResolvedValue(['sage'])
      const { orchestrator, store } = await harness(
        createMockDriver({ deltaDelayMs: 0 }),
        cosRoster,
        route,
      )
      const group = await store.createChat({ kind: 'group', memberIds: ['marlow', 'sage', 'smith'] })

      await orchestrator.submitUserMessage(group.id, message)

      expect(await speakers(store, group.id)).toEqual(['sage'])
      expect(route).toHaveBeenCalledOnce()
      expect(route).toHaveBeenCalledWith(expect.objectContaining({ message }))
    },
  )

  it('keeps explicit group mentions, DMs and project chats out of the group router', async () => {
    const route = vi.fn<RouteGroupTurn>().mockResolvedValue(['smith'])
    const { orchestrator, store } = await harness(
      createMockDriver({ deltaDelayMs: 0 }),
      cosRoster,
      route,
    )
    const group = await store.createChat({ kind: 'group', memberIds: ['marlow', 'sage'] })
    const dm = await store.createChat({ kind: 'dm', memberIds: ['smith'] })
    const project = (await store.listChats()).find((chat) => chat.kind === 'project')
    if (project === undefined) throw new Error('expected the seeded project chat')

    await orchestrator.submitUserMessage(group.id, '@Sage answer this')
    await orchestrator.submitUserMessage(dm.id, 'answer this')
    await orchestrator.submitUserMessage(project.id, 'answer this')

    expect(route).not.toHaveBeenCalled()
    expect(await speakers(store, group.id)).toEqual(['sage'])
    expect(await speakers(store, dm.id)).toEqual(['smith'])
    expect(await speakers(store, project.id)).toEqual(['marlow'])
  })

  it('falls back to the previous routing when the group router is unavailable', async () => {
    const route = vi.fn<RouteGroupTurn>().mockRejectedValue(new Error('router unavailable'))
    const { orchestrator, store } = await harness(
      createMockDriver({ deltaDelayMs: 0 }),
      cosRoster,
      route,
    )
    const group = await store.createChat({ kind: 'group', memberIds: ['marlow', 'sage'] })

    await orchestrator.submitUserMessage(group.id, 'where are we?')

    expect(await speakers(store, group.id)).toEqual(['marlow'])
    expect(await notes(store, group.id)).toEqual([])
  })

  it('falls back to one live member when a routed group has no chief of staff', async () => {
    const route = vi.fn<RouteGroupTurn>().mockRejectedValue(new Error('router unavailable'))
    const { orchestrator, store } = await harness(
      createMockDriver({ deltaDelayMs: 0 }),
      cosRoster.filter((agent) => !agent.isCos),
      route,
    )
    const group = await store.createChat({ kind: 'group', memberIds: ['sage', 'smith'] })

    await orchestrator.submitUserMessage(group.id, 'where are we?')

    expect(await speakers(store, group.id)).toEqual(['sage'])
    expect(await notes(store, group.id)).toEqual([])
  })

  it('protects an active group router scratch job until its selection returns', async () => {
    let finishRoute: (ids: string[]) => void = () => undefined
    const route = vi.fn<RouteGroupTurn>(() => new Promise((resolve) => {
      finishRoute = resolve
    }))
    const { orchestrator, store } = await harness(
      createMockDriver({ deltaDelayMs: 0 }),
      cosRoster,
      route,
    )
    const group = await store.createChat({ kind: 'group', memberIds: ['marlow', 'sage'] })

    const sending = orchestrator.submitUserMessage(group.id, 'who should answer?')
    while (route.mock.calls.length === 0) await Promise.resolve()
    expect(orchestrator.activeGroupRouterThreadIds()).toEqual([groupTurnRouterThreadId(group.id)])

    finishRoute(['sage'])
    await sending
    expect(orchestrator.activeGroupRouterThreadIds()).toEqual([])
  })

  it('answers an un-mentioned message in a group without the chief of staff by asking for a name', async () => {
    // Rejected on the way here: everyone answers (expensive and chaotic) and a
    // per-group lead (configuration for a problem Manor does not have).
    const { orchestrator, store } = await harness(createMockDriver({ deltaDelayMs: 0 }))
    const group = await store.createChat({ kind: 'group', memberIds: ['sage', 'smith'] })

    await orchestrator.submitUserMessage(group.id, 'where are we?')

    expect(await speakers(store, group.id)).toEqual([])
    expect(await notes(store, group.id)).toEqual([
      'Nobody in this chat takes un-mentioned messages, so mention someone by name to get an answer.',
    ])
  })

  it('says so when a mentioned persona is not in this chat, and runs the ones that are', async () => {
    const { orchestrator, store } = await harness(createMockDriver({ deltaDelayMs: 0 }))
    const group = await store.createChat({ kind: 'group', memberIds: ['marlow', 'sage'] })

    await orchestrator.submitUserMessage(group.id, '@Sage @Smith what first?')

    expect(await speakers(store, group.id)).toEqual(['sage'])
    expect(await notes(store, group.id)).toEqual(["Smith isn't in this chat."])
    // Said under the user's own message, not as a line of its own.
    const events = await store.loadEvents(group.id)
    expect(events.find((event) => event.type === 'system_note')).toMatchObject({ hintFor: events.find((event) => event.type === 'user_message')?.id })
  })

  it('treats a typed agent mention in a DM as plain text and still answers as its fixed persona', async () => {
    // The composer does not offer agent mentions in a DM. The server holds the same
    // boundary for pasted text and older clients, so a DM can never become a group.
    const { orchestrator, store } = await harness(createMockDriver({ deltaDelayMs: 0 }))
    const dm = await store.createChat({ kind: 'dm', memberIds: ['sage'] })

    await orchestrator.submitUserMessage(dm.id, '@Smith can you look?')

    expect(await speakers(store, dm.id)).toEqual(['sage'])
    expect(await notes(store, dm.id)).toEqual([])
    expect((await store.loadEvents(dm.id)).find((event) => event.type === 'user_message')).toMatchObject({
      mentions: [],
    })
  })

  it('keeps a summoning persona inside the room', async () => {
    // Marlow's allowlist names the whole house, but in a group he may only reach
    // the people who are in it: membership beats the allowlist, silently, because
    // a persona reaching outside the room is the persona's mistake and not the
    // user's.
    const summoning = cosRoster.map((agent) =>
      agent.isCos ? { ...agent, mentionAllowlist: ['sage', 'smith'] } : agent,
    )
    const { orchestrator, store } = await harness(
      scripted((input) => [
        { type: 'result', text: `@Sage @Smith please take this`, sessionId: `s-${input.agent.id}` },
      ], []),
      summoning,
    )
    const group = await store.createChat({ kind: 'group', memberIds: ['marlow', 'sage'] })

    await orchestrator.submitUserMessage(group.id, 'sort this out')

    expect(await speakers(store, group.id)).toEqual(['marlow', 'sage'])
    // Silently: no note about Smith, because the user did not mention him.
    expect(await notes(store, group.id)).toEqual([])
  })

  it('leaves a project chat routing exactly as it was', async () => {
    const { orchestrator, store } = await harness(createMockDriver({ deltaDelayMs: 0 }))
    const [chat] = await store.listChats()
    if (chat === undefined) throw new Error('the memory store should seed one chat')

    await orchestrator.submitUserMessage(chat.id, 'no names at all')
    await orchestrator.submitUserMessage(chat.id, '@Smith and you')

    // The chief of staff by default, the mentioned persona when there is one, and
    // nobody is ever refused for not being a member: a project chat has none.
    expect(await speakers(store, chat.id)).toEqual(['marlow', 'smith'])
    expect(await notes(store, chat.id)).toEqual([])
  })
})
