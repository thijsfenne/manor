import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  ARCHIVE_RETENTION_MS,
  DEFAULT_HOUSE_SETTINGS,
  ClientMessageSchema,
  routineDmTarget,
  ServerMessageSchema,
  NEW_SINGLE_CHAT_DEFAULT,
  SIDE_CHAT_DEFAULTS,
  defaultSingleRuntime,
  driverForModel,
  type AgentConfig,
  type McpServerConfig,
  type McpServerDraft,
  type ServerMessage,
  type TurnInput,
} from '@manor/contracts'
import { beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest'
import { createChatMessage } from '@manor/client-runtime/commands'
import type { GenerateChatTitle } from '../src/chatTitle.js'
import { createMockDriver } from '../src/drivers/mockDriver.js'
import type { MyMindClient } from '../src/mymind.js'
import { ManorService } from '../src/service.js'
import { welcomePrompt } from '../src/projectThreads.js'
import type { Store } from '../src/store.js'
import { createMemoryStore } from '../src/stores/memoryStore.js'
import { openVault, type Vault } from '../src/vault.js'
import { WorkModule } from '../src/workModule.js'
import {
  cosRoster,
  endless,
  gated,
  partialEndless,
  recording,
  roster,
  sage,
  scratchFor,
  seededChat,
  sessionIdIn,
  until,
} from './helpers.js'

/**
 * The service over one live roster cell, the same shape `main.ts` wires: the getter
 * is what every consumer reads, and an agent write replaces what it returns.
 */
function service(
  store: Store,
  driver = createMockDriver({ deltaDelayMs: 0 }),
  generateTitle?: GenerateChatTitle,
  probeMcpServer?: (draft: McpServerDraft) => Promise<{
    tools: string[]
    readOnlyTools: string[]
    schemaChars: number
    verifiedBy?: string
  }>,
  vault?: Vault,
  externalLinks?: { externalBrowser: 'dia'; openExternalUrl: (url: string) => Promise<void> },
  answerUserInput?: (
    chatId: string,
    requestId: string,
    answers: import('@manor/contracts').UserInputAnswers,
  ) => Promise<boolean>,
  onChatsDeleted?: (chatIds: readonly string[]) => void,
  mymind?: MyMindClient,
  answerSecretRequest?: (chatId: string, requestId: string, value?: string) => boolean,
) {
  const broadcast: ServerMessage[] = []
  const replies: ServerMessage[] = []
  let live: readonly AgentConfig[] = roster
  let registry: readonly McpServerConfig[] = []
  const manor = new ManorService({
    store,
    agents: () => live,
    setAgents: (next) => {
      live = next
    },
    mcpServers: () => registry,
    setMcpServers: (next) => {
      registry = next
    },
    resolveDriver: () => driver,
    ensureScratchDir: scratchFor,
    broadcast: (message) => broadcast.push(message),
    hostEnv: {
      SUPABASE_ACCESS_TOKEN: 'present',
      ...(mymind === undefined
        ? {}
        : { MANOR_MYMIND_KEY_ID: 'present', MANOR_MYMIND_SECRET: 'present' }),
    },
    ...(generateTitle === undefined ? {} : { generateTitle }),
    ...(probeMcpServer === undefined ? {} : { probeMcpServer }),
    ...(vault === undefined ? {} : { vault }),
    ...(externalLinks ?? {}),
    ...(answerUserInput === undefined ? {} : { answerUserInput }),
    ...(answerSecretRequest === undefined ? {} : { answerSecretRequest }),
    ...(onChatsDeleted === undefined ? {} : { onChatsDeleted }),
    ...(mymind === undefined ? {} : { mymind }),
  })
  const reply = (message: ServerMessage) => replies.push(message)
  return { manor, broadcast, replies, reply, agents: () => live, mcpServers: () => registry }
}

const lastDirectory = (messages: ServerMessage[]) => messages.filter((message) => message.type === 'directory').at(-1)

describe('ManorService', () => {
  it('rechecks blocked Session cards when a chat opens and when any exchange ends', async () => {
    const recheck = vi.spyOn(WorkModule.prototype, 'recheckBlocked').mockResolvedValue(undefined)
    onTestFinished(() => { recheck.mockRestore() })
    const store = createMemoryStore({ agents: roster })
    const { chatId } = await seededChat(store)
    const { manor, reply } = service(store)
    await manor.handle({ type: 'open_chat', chatId }, reply)
    expect(recheck).toHaveBeenCalledTimes(1)
    await manor.handle({ type: 'send_message', chatId, text: '@Sage hello' }, reply)
    await vi.waitFor(() => expect(recheck).toHaveBeenCalledTimes(2))
  })

  it.each(['single', 'house'] as const)('opens accepted %s Work for either client while its kickoff is still running', async (mode) => {
    const store = createMemoryStore({ agents: roster })
    const { projectId } = await seededChat(store)
    const source = await store.createChat({ kind: 'dm', memberIds: ['sage'] })
    const { handoff } = await store.reserveWorkHandoff({
      sourceChatId: source.id, sourceTurnId: 'source', projectId, projectName: 'Manor',
      title: 'Open accepted Work', task: 'Report the accepted mode.', authorAgentId: 'sage',
      leadAgentId: 'sage', leadAgentName: 'Sage', supportingAgentIds: [], supportingAgentNames: [],
    })
    const { driver, forChat } = gated()
    const { manor, replies, reply, broadcast } = service(store, driver)
    await manor.handle({ type: 'accept_work_handoff', handoffId: handoff.id, requestId: 'accept', mode,
      ...(mode === 'single' ? { runtime: { driver: 'codex', model: 'gpt-5.6-sol', effort: 'medium' } as const } : {}),
    }, reply)
    const ack = replies.find((message) => message.type === 'ack' && message.requestId === 'accept')
    if (ack?.type !== 'ack' || ack.workChatId === undefined) throw new Error('Missing accepted Work target')
    const target = ack.workChatId
    await until(() => forChat(target).length === 1, 'the kickoff to start')
    try {
      expect(lastDirectory(broadcast)?.chats).toContainEqual(expect.objectContaining({ id: target, mode }))
      await manor.handle({ type: 'open_chat', chatId: target }, reply)
      const snapshot = ServerMessageSchema.parse(replies.at(-1))
      expect(snapshot).toMatchObject({ type: 'snapshot', chatId: target,
        activeTurn: { agentId: mode === 'single' ? '__single__' : 'sage' },
        events: expect.arrayContaining([expect.objectContaining({ type: 'user_message', workHandoffId: handoff.id })]),
      })
    } finally {
      forChat(target)[0]?.finish()
    }
    await until(() => broadcast.some((message) => message.type === 'turn_state' && message.chatId === target && message.state === 'done'), 'the kickoff to finish')
  })

  it.each([
    { driver: 'claude', model: 'claude-opus-5', effort: 'medium' },
    { driver: 'codex', model: 'gpt-5.6-sol', effort: 'medium' },
    { driver: 'grok', model: 'grok-4.6', effort: 'medium' },
    { driver: 'cursor', model: 'cursor-composer-2.5', effort: 'medium' },
  ] as const)('accepts Single Work on $driver without starting the proposed personas', async (runtime) => {
    const store = createMemoryStore({ agents: [...roster, { ...sage, id: 'marlow', name: 'Jeeves' }] })
    const { projectId } = await seededChat(store)
    const source = await store.createChat({ kind: 'dm', memberIds: ['marlow'], title: 'Jeeves' })
    await store.appendEvent(source.id, { type: 'user_message', text: 'Private source history.', mentions: [] })
    const { handoff } = await store.reserveWorkHandoff({
      sourceChatId: source.id, sourceTurnId: 'proposal_turn', authorAgentId: 'marlow',
      projectId, projectName: 'Manor', title: 'Single handoff',
      task: 'Verify the accepted session mode and report the result. Do not change code or files.',
      leadAgentId: 'removed', leadAgentName: 'Removed persona',
      supportingAgentIds: ['sage'], supportingAgentNames: ['Sage'],
    })
    const seen: TurnInput[] = []
    const { manor, replies, reply, broadcast } = service(store, recording(createMockDriver({ deltaDelayMs: 0 }), seen))
    const command = ClientMessageSchema.parse({
      type: 'accept_work_handoff', handoffId: handoff.id, requestId: 'accept_single', mode: 'single', runtime,
    })
    await manor.handle(command, reply)
    const target = (await store.listWorkHandoffs())[0]!.workChatId!
    await until(() => broadcast.some((message) => message.type === 'turn_state' && message.chatId === target && message.state === 'done'), 'Single kickoff to finish')
    expect(replies).toContainEqual({ type: 'ack', requestId: 'accept_single', workChatId: target })
    expect(await store.getChat(target)).toMatchObject({ mode: 'single', singleDriver: runtime.driver })
    expect(await store.loadChatOverrides(target)).toEqual({ __single__: runtime })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.agent).toMatchObject({ id: '__single__', ...runtime, mentionAllowlist: [] })
    expect(seen[0]?.agent.character).not.toContain('[Manor] Routing in this Work thread:')
    expect(seen[0]?.agent.character).toContain('accepted Single mode takes precedence over persona assignments in the kickoff')
    expect(seen[0]?.agent.character).toContain('Carry out the substantive task and keep its constraints')
    expect(seen[0]?.agent.character).toContain('Never claim a proposed persona ran or a check passed without evidence')
    expect(JSON.stringify(seen[0]?.catchUp)).not.toContain('Private source history')
    expect(seen[0]?.catchUp?.find((event) => event.type === 'user_message')).not.toHaveProperty('workTargetLeadId')
    expect(seen[0]?.catchUp?.find((event) => event.type === 'user_message')).not.toHaveProperty('workSupportingAgentIds')
    const kickoffs = (await store.loadEvents(target)).filter((event) => event.type === 'user_message')
    expect(kickoffs).toEqual([
      expect.objectContaining({ workHandoffId: handoff.id, workAuthorAgentId: 'marlow', workAuthorAgentName: 'Jeeves' }),
    ])
    // The user's text is the task alone; the opening line is Manor's, for the model.
    expect(kickoffs[0]!.text).toBe(handoff.task)
    const instruction = kickoffs[0]!.type === 'user_message' ? kickoffs[0]!.instruction ?? '' : ''
    expect(instruction).toMatch(/^\[Manor\] Session accepted as Single with/)
    expect(instruction).toContain(runtime.model)
    expect(instruction).not.toMatch(/Smith|Removed persona|Sage/)
    expect(seen[0]?.catchUp?.find((event) => event.type === 'user_message')).toMatchObject({ text: handoff.task, instruction })
    expect((await store.listWorkHandoffs())[0]?.task).toBe(handoff.task)
    await manor.handle(ClientMessageSchema.parse({ type: 'accept_work_handoff', handoffId: handoff.id, mode: 'house' }), reply)
    expect(seen).toHaveLength(1)
    expect(await store.getChat(target)).toMatchObject({ mode: 'single' })
  })

  it.each([
    { driver: 'claude', model: 'claude-opus-5', effort: 'medium' },
    { driver: 'codex', model: 'gpt-5.6-sol', effort: 'medium' },
    { driver: 'grok', model: 'grok-4.6', effort: 'medium' },
    { driver: 'cursor', model: 'cursor-composer-2.5', effort: 'medium' },
  ] as const)('creates a single $driver session with its runtime before sending the opening message', async (runtime) => {
    const store = createMemoryStore({ agents: [] })
    const project = (await store.listProjects())[0]!
    const seen: TurnInput[] = []
    const { manor, replies, reply, broadcast } = service(store, recording(createMockDriver({ deltaDelayMs: 0 }), seen))
    await manor.handle(ClientMessageSchema.parse(createChatMessage(
      { kind: 'project', projectId: project.id, mode: 'single' },
      { text: 'Hello', images: [] },
      { __single__: runtime, sage: { model: 'opus' } },
    )), reply)
    const created = replies.find((message) => message.type === 'chat_created')!
    expect(created).toBeDefined()
    if (created.type !== 'chat_created') throw new Error('missing chat')
    await until(() => seen.length === 1, 'single opening turn')
    expect(await store.getChat(created.chatId)).toMatchObject({ mode: 'single' })
    expect(lastDirectory(broadcast)?.chats.find((chat) => chat.id === created.chatId)?.singleDriver).toBe(runtime.driver)
    expect(seen[0]!.agent).toMatchObject(runtime)
    await manor.handle({ type: 'set_chat_override', chatId: created.chatId, agentId: '__single__', override: { ...runtime, effort: 'high' } }, reply)
    expect(await store.loadChatOverrides(created.chatId)).toEqual({ __single__: { ...runtime, effort: 'high' } })
    const switched = { driver: 'cursor', model: 'cursor-composer-2.5', effort: 'medium' } as const
    await manor.handle({ type: 'set_chat_override', chatId: created.chatId, agentId: '__single__', override: switched }, reply)
    expect(lastDirectory(broadcast)?.chats.find((chat) => chat.id === created.chatId)?.singleDriver).toBe('cursor')
    const reconnected = ServerMessageSchema.parse(await manor.directory())
    expect(lastDirectory([reconnected])?.chats.find((chat) => chat.id === created.chatId)?.singleDriver).toBe('cursor')
    await manor.handle({ type: 'set_chat_override', chatId: created.chatId, agentId: '__single__', override: {} }, reply)
    expect(await store.loadChatOverrides(created.chatId)).toEqual({})
  })

  it('keeps at most one empty chat beside the Browser', async () => {
    const store = createMemoryStore({ agents: roster })
    const deleted: string[][] = []
    const { manor, replies, reply } = service(
      store, undefined, undefined, undefined, undefined, undefined, undefined, (chatIds) => deleted.push([...chatIds]),
    )
    const start = async () => {
      await manor.handle(ClientMessageSchema.parse(createChatMessage({ kind: 'browser' })), reply)
      const created = replies.filter((message) => message.type === 'chat_created').at(-1)
      if (created?.type !== 'chat_created') throw new Error('missing chat')
      return created.chatId
    }
    const browserChats = async () => (await store.listChats()).filter((chat) => chat.kind === 'browser').map((chat) => chat.id)
    const talked = await start()
    await store.appendEvent(talked, { type: 'user_message', text: 'Look at this page.', mentions: [] })
    const untouched = await start()
    const current = await start()

    expect(deleted).toEqual([[untouched]])
    expect((await browserChats()).sort()).toEqual([talked, current].sort())

    // Two starts at once, a double click from two windows: each clears before it
    // creates, so the later one always survives the other's sweep.
    await Promise.all([0, 1].map(() =>
      manor.handle(ClientMessageSchema.parse(createChatMessage({ kind: 'browser' })), reply)))
    expect((await browserChats()).filter((id) => id !== talked).length).toBeGreaterThan(0)
  })

  it('runs a Browser session on one model and refuses one with personas', async () => {
    const store = createMemoryStore({ agents: roster })
    const { manor, replies, reply } = service(store)
    await manor.handle({ type: 'create_chat', kind: 'browser', mode: 'house' }, reply)
    expect((await store.listChats()).some((chat) => chat.kind === 'browser')).toBe(false)
    expect(replies.at(-1)).toMatchObject({ type: 'notice', kind: 'error' })
    await manor.handle(ClientMessageSchema.parse(createChatMessage({ kind: 'browser' })), reply)
    expect((await store.listChats()).find((chat) => chat.kind === 'browser')).toMatchObject({ mode: 'single' })
  })

  it('creates a Single chat on Auto without a runtime pin', async () => {
    const store = createMemoryStore({ agents: [] })
    const project = (await store.listProjects())[0]!
    const { manor, replies, reply } = service(store)
    await manor.handle(ClientMessageSchema.parse({ type: 'create_chat', projectId: project.id, mode: 'single' }), reply)
    const created = replies.find((message) => message.type === 'chat_created')
    expect(created).toBeDefined()
    if (created?.type !== 'chat_created') throw new Error('missing chat')
    expect(await store.getChat(created.chatId)).toMatchObject({ mode: 'single' })
    expect(await store.loadChatOverrides(created.chatId)).toEqual({})
  })

  it('refuses invalid single runtime choices without creating an empty chat', async () => {
    const store = createMemoryStore()
    const project = (await store.listProjects())[0]!
    const before = await store.listChats()
    const { manor, replies, reply } = service(store)
    for (const overrides of [
      { __single__: { auto: false as const } },
      { __single__: { driver: 'mock' as const, model: 'grok-4.5', effort: 'medium' as const } },
      { __single__: { driver: 'codex' as const, model: 'claude-opus-5', effort: 'medium' as const } },
    ]) {
      await manor.handle(ClientMessageSchema.parse({ type: 'create_chat', projectId: project.id, mode: 'single', overrides }), reply)
      expect(replies.at(-1)).toMatchObject({ type: 'notice', kind: 'error' })
    }
    expect(await store.listChats()).toEqual(before)
  })

  it('removes a new single chat when its required runtime cannot be saved', async () => {
    const store = createMemoryStore()
    const project = (await store.listProjects())[0]!
    const before = await store.listChats()
    const seen: TurnInput[] = []
    const { manor, replies, reply } = service({ ...store, setChatOverride: async () => { throw new Error('disk refused') } }, recording(createMockDriver(), seen))
    await manor.handle(ClientMessageSchema.parse({
      type: 'create_chat', projectId: project.id, mode: 'single',
      overrides: { __single__: { driver: 'codex', model: 'gpt-5.6-sol', effort: 'medium' } },
      openingMessage: { text: 'Do not run without this pin.' },
    }), reply)
    expect(replies.at(-1)).toMatchObject({ type: 'notice', kind: 'error', text: expect.stringContaining('disk refused') })
    expect(await store.listChats()).toEqual(before)
    expect(seen).toEqual([])
  })
  it('carries a selected message quote from the wire into storage and runtime context', async () => {
    const store = createMemoryStore({ agents: roster })
    const { chatId } = await seededChat(store)
    const source = await store.appendEvent(chatId, { type: 'user_message', text: 'First. Second.', mentions: [] })
    const quotes = [{ kind: 'message' as const, eventId: source.id, text: 'Second.' }]
    const text = '@Sage why [Quote #1]?'
    const seen: TurnInput[] = []
    const { manor, reply, broadcast } = service(store, recording(createMockDriver({ deltaDelayMs: 0 }), seen))
    await manor.handle(ClientMessageSchema.parse({ type: 'send_message', chatId, text, quotes }), reply)
    expect((await store.loadEvents(chatId)).find((event) => event.type === 'user_message' && event.text === text))
      .toMatchObject({ quotes })
    expect(seen[0]?.catchUp).toContainEqual(expect.objectContaining({ type: 'user_message', quotes }))
    expect(broadcast).toContainEqual(expect.objectContaining({ type: 'event', event: expect.objectContaining({ quotes }) }))
  })

  it('places the single quote of a phone build older than inline quotes', async () => {
    const store = createMemoryStore({ agents: roster })
    const { chatId } = await seededChat(store)
    const source = await store.appendEvent(chatId, { type: 'user_message', text: 'First. Second.', mentions: [] })
    const seen: TurnInput[] = []
    const { manor, reply } = service(store, recording(createMockDriver({ deltaDelayMs: 0 }), seen))
    const quote = { eventId: source.id, text: 'Second.' }
    await manor.handle(ClientMessageSchema.parse({ type: 'send_message', chatId, text: '@Sage why?', quote }), reply)
    const text = '@Sage why? [Quote #1]'
    expect((await store.loadEvents(chatId)).find((event) => event.type === 'user_message' && event.text === text))
      .toMatchObject({ quotes: [{ kind: 'message', ...quote }] })
    expect(seen).toHaveLength(1)
  })

  it('refuses a quote from a phone build older than inline quotes when its event is not in the chat', async () => {
    const store = createMemoryStore({ agents: roster })
    const { chatId } = await seededChat(store)
    const { manor, reply } = service(store)
    const quote = { eventId: 'evt_elsewhere', text: 'Second.' }
    const send = ClientMessageSchema.parse({ type: 'send_message', chatId, text: '@Sage why?', quote })
    await manor.handle(send, reply).catch(() => undefined)
    expect((await store.loadEvents(chatId)).some((event) => event.type === 'user_message' && event.text.startsWith('@Sage why?')))
      .toBe(false)
  })

  it('reads the current DM summary and exact covered range only for the requester', async () => {
    const store = createMemoryStore({ agents: roster })
    const dm = await store.createChat({ kind: 'dm', memberIds: ['sage'] })
    const { manor, replies, reply, broadcast } = service(store)
    const request = ClientMessageSchema.parse({ type: 'get_chat_summary', chatId: dm.id, requestId: 'summary-1' })
    await manor.handle(request, reply)
    expect(replies.at(-1)).toEqual({ type: 'chat_summary', chatId: dm.id, requestId: 'summary-1', summary: null })
    const first = await store.appendEvent(dm.id, { type: 'user_message', text: 'A proposal.', mentions: [] })
    const through = await store.appendEvent(dm.id, { type: 'user_message', text: 'Still conditional.', mentions: [] })
    await store.setChatSummary(dm.id, 'A conditional proposal.', through.id)
    const held = await store.getChatSummary(dm.id)
    const tail = await store.appendEvent(dm.id, { type: 'user_message', text: 'Not summarized yet.', mentions: [] })
    await manor.handle(request, reply)
    expect(replies.at(-1)).toEqual(ServerMessageSchema.parse({
      type: 'chat_summary', chatId: dm.id, requestId: 'summary-1', summary: {
        text: held!.summary, fromEventId: first.id, fromAt: first.ts,
        throughEventId: through.id, throughAt: through.ts, updatedAt: held!.updatedAt,
      },
    }))
    expect(await store.getChatSummary(dm.id)).toEqual(held)
    await store.setChatSummary(dm.id, 'Updated summary.', tail.id)
    await manor.handle(request, reply)
    expect(replies.at(-1)).toMatchObject({ summary: { text: 'Updated summary.', throughEventId: tail.id, throughAt: tail.ts } })
    expect(broadcast).toEqual([])
  })

  it("shows a DM's standing notes only when its persona's turns receive them", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'manor-dm-notes-'))
    const dailyDir = path.join(root, 'memory', 'daily')
    mkdirSync(path.join(root, 'memory', 'agents'), { recursive: true })
    const notesPath = path.join(root, 'memory', 'agents', 'sage.md')
    writeFileSync(notesPath, '# Sage\n\n- Coach, do not answer.\n', 'utf8')
    let live: readonly AgentConfig[] = [{ ...sage, memoryScope: true }]
    const store = createMemoryStore({ agents: roster })
    const dm = await store.createChat({ kind: 'dm', memberIds: ['sage'] })
    const manor = new ManorService({
      store, agents: () => live, setAgents: () => {}, mcpServers: () => [], setMcpServers: () => {},
      resolveDriver: () => createMockDriver({ deltaDelayMs: 0 }), ensureScratchDir: scratchFor,
      broadcast: () => {}, memoryTarget: { dailyDir },
    })
    const replies: ServerMessage[] = []
    await manor.handle({ type: 'get_chat_summary', chatId: dm.id }, (message) => replies.push(message))
    expect(replies.at(-1)).toMatchObject({
      type: 'chat_summary', notes: { path: notesPath, content: '# Sage\n\n- Coach, do not answer.' },
    })
    // Agent settings reads the same notes by agent, so a Session agent without a DM has them too.
    await manor.handle({ type: 'get_agent_notes', agentId: 'sage', requestId: 'notes-1' }, (message) => replies.push(message))
    expect(replies.at(-1)).toEqual({
      type: 'agent_notes', agentId: 'sage', requestId: 'notes-1',
      notes: { path: notesPath, content: '# Sage\n\n- Coach, do not answer.' },
    })
    live = [{ ...sage, memoryScope: false }]
    await manor.handle({ type: 'get_chat_summary', chatId: dm.id }, (message) => replies.push(message))
    expect(replies.at(-1)).toMatchObject({ type: 'chat_summary' })
    expect(replies.at(-1)).not.toHaveProperty('notes')
    await manor.handle({ type: 'get_agent_notes', agentId: 'sage' }, (message) => replies.push(message))
    expect(replies.at(-1)).toEqual({ type: 'agent_notes', agentId: 'sage' })
    await manor.handle({ type: 'get_agent_notes', agentId: 'ghost', requestId: 'notes-2' }, (message) => replies.push(message))
    expect(replies.at(-1)).toMatchObject({ type: 'notice', kind: 'error' })
  })

  it('refuses missing and non-DM chats without exposing their summary', async () => {
    const store = createMemoryStore({ agents: roster })
    const { chatId } = await seededChat(store)
    const event = await store.appendEvent(chatId, { type: 'user_message', text: 'Work context', mentions: [] })
    await store.setChatSummary(chatId, 'Work summary', event.id)
    const { manor, replies, reply } = service(store)
    for (const id of ['missing', chatId]) {
      await manor.handle({ type: 'get_chat_summary', chatId: id, requestId: 'summary-refused' }, reply)
      expect(replies.at(-1)).toMatchObject({ type: 'notice', kind: 'error', requestId: 'summary-refused' })
    }
    expect(replies.some(message => message.type === 'chat_summary')).toBe(false)
  })

  it("reads a project thread's summary like a DM's and still refuses the sessions it starts", async () => {
    const store = createMemoryStore({ agents: roster })
    const { projectId } = await seededChat(store)
    const thread = await store.createChat({ kind: 'project', projectId, mode: 'single' })
    const session = await store.createChat({ kind: 'project', projectId, mode: 'single' })
    await store.setProjectThread(projectId, thread.id)
    const through = await store.appendEvent(thread.id, { type: 'user_message', text: 'Keep replies short.', mentions: [] })
    await store.setChatSummary(thread.id, 'Sam wants short replies.', through.id)
    await store.setChatSummary(session.id, 'Session work.', (await store.appendEvent(session.id, { type: 'user_message', text: 'Work', mentions: [] })).id)
    const { manor, replies, reply } = service(store)
    await manor.handle({ type: 'get_chat_summary', chatId: thread.id, requestId: 'thread-summary' }, reply)
    expect(replies.at(-1)).toMatchObject({
      type: 'chat_summary', chatId: thread.id, requestId: 'thread-summary',
      summary: { text: 'Sam wants short replies.', throughEventId: through.id },
    })
    expect(replies.at(-1)).not.toHaveProperty('notes')
    await manor.handle({ type: 'get_chat_summary', chatId: session.id, requestId: 'session-summary' }, reply)
    expect(replies.at(-1)).toMatchObject({ type: 'notice', kind: 'error', requestId: 'session-summary' })
  })

  it('keeps an orphaned summary readable without inventing its source dates', async () => {
    const store = createMemoryStore({ agents: roster })
    const dm = await store.createChat({ kind: 'dm', memberIds: ['sage'] })
    await store.appendEvent(dm.id, { type: 'user_message', text: 'Unrelated tail', mentions: [] })
    await store.setChatSummary(dm.id, 'Saved historical context', 'evt_999999')
    const { manor, replies, reply } = service(store)
    await manor.handle({ type: 'get_chat_summary', chatId: dm.id }, reply)
    expect(replies.at(-1)).toMatchObject({ type: 'chat_summary', summary: {
      text: 'Saved historical context', fromEventId: null, fromAt: null, throughEventId: 'evt_999999', throughAt: null,
    } })
  })

  it('serves project memory only to the requester and rejects unknown projects', async () => {
    const store = createMemoryStore({ agents: roster })
    const { projectId } = await seededChat(store)
    const { manor, replies, reply, broadcast } = service(store)
    const request = ClientMessageSchema.parse({ type: 'get_project_memory', projectId, requestId: 'memory-1' })
    await manor.handle(request, reply)
    expect(replies).toContainEqual(ServerMessageSchema.parse({
      type: 'project_memory', projectId, requestId: 'memory-1', files: [], truncated: false,
    }))
    expect(broadcast).toEqual([])
    await manor.handle({ type: 'get_project_memory', projectId: 'missing', requestId: 'memory-2' }, reply)
    expect(replies.at(-1)).toMatchObject({ type: 'notice', requestId: 'memory-2' })
  })

  it('refuses client-created pair chats', async () => {
    const store = createMemoryStore({ agents: roster })
    const { manor, replies, reply } = service(store)

    await manor.handle({
      type: 'create_chat',
      kind: 'pair',
      memberIds: ['sage', 'smith'],
      title: 'Not client-owned',
      requestId: 'pair-request',
    }, reply)

    expect(replies.at(-1)).toMatchObject({ type: 'notice', kind: 'error', text: 'Agent pair chats are created by message_agent.' })
    expect((await store.listChats()).some((chat) => chat.kind === 'pair')).toBe(false)
  })

  it('keeps agent pair chats view-only even for an older client that sends anyway', async () => {
    const store = createMemoryStore({ agents: roster })
    const pair = await store.pairChatFor('sage', 'smith')
    const { manor, replies, reply } = service(store)

    await manor.handle({ type: 'send_message', chatId: pair.id, text: 'I should not land.' }, reply)

    expect(replies.at(-1)).toMatchObject({ type: 'notice', kind: 'error', text: 'Agent pair chats are view-only.' })
    expect(await store.loadEvents(pair.id)).toEqual([])
  })

  it('keeps agent pair runtime settings view-only for older clients too', async () => {
    const store = createMemoryStore({ agents: roster })
    const pair = await store.pairChatFor('sage', 'smith')
    const { manor, replies, reply } = service(store)

    await manor.handle({
      type: 'set_chat_override',
      chatId: pair.id,
      agentId: 'sage',
      override: { driver: 'codex', model: 'gpt-5.4', effort: 'low' },
    }, reply)

    expect(replies.at(-1)).toMatchObject({ type: 'notice', kind: 'error', text: 'Agent pair chats are view-only.' })
    expect(await store.loadChatOverrides(pair.id)).toEqual({})
  })

  it('reports and verifies the managed mymind connector', async () => {
    let verifies = 0
    const mymind: MyMindClient = {
      async verify() {
        verifies += 1
      },
      async *list() {},
      async search() {
        return { objects: [], spaces: [], hasMore: false }
      },
      async inspect() {
        return { artifacts: [], spaces: [] }
      },
      async fetchThumbnail() {
        return undefined
      },
    }
    const { manor, broadcast, replies, reply } = service(
      createMemoryStore({ agents: roster }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      mymind,
    )

    expect(manor.mymindStatus()).toMatchObject({
      type: 'mymind_status',
      available: true,
      env: [
        { key: 'MANOR_MYMIND_KEY_ID', present: true },
        { key: 'MANOR_MYMIND_SECRET', present: true },
      ],
      check: null,
    })

    await manor.handle({ type: 'verify_mymind' }, reply)

    expect(verifies).toBe(1)
    expect(broadcast.at(-1)).toMatchObject({ type: 'mymind_status', check: { result: 'verified' } })
    expect(replies.at(-1)).toMatchObject({ kind: 'info', text: expect.stringContaining('read-only Spaces') })
  })

  it('serves a mymind stream one page at a time and reports an expired stream', async () => {
    const artifact = {
      id: 'object_1',
      title: 'First artifact',
      kind: 'article' as const,
      tags: [],
      spaces: [],
      created: '2026-08-20T10:00:00.000Z',
      bumped: '2026-08-20T10:00:00.000Z',
    }
    const mymind: MyMindClient = {
      async verify() {},
      async *list() {
        yield { objects: [artifact], spaces: [], hasMore: true }
        yield { objects: [{ ...artifact, id: 'object_2', title: 'Second artifact' }], spaces: [], hasMore: false }
      },
      async search() {
        return { objects: [artifact], spaces: [], hasMore: false }
      },
      async inspect() {
        return { artifacts: [{ artifact }], spaces: [] }
      },
      async fetchThumbnail() {
        return undefined
      },
    }
    const { manor, replies, reply } = service(
      createMemoryStore({ agents: roster }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      mymind,
    )

    await manor.handle({ type: 'list_mymind_objects', query: '', requestId: 'listing_1' }, reply)
    await manor.handle({ type: 'load_more_mymind_objects', requestId: 'listing_1' }, reply)
    await manor.handle({ type: 'load_more_mymind_objects', requestId: 'listing_1' }, reply)

    expect(replies).toMatchObject([
      { type: 'mymind_objects', requestId: 'listing_1', append: false, result: { status: 'ready', hasMore: true } },
      { type: 'mymind_objects', requestId: 'listing_1', append: true, result: { status: 'ready', hasMore: false } },
      {
        type: 'mymind_objects',
        requestId: 'listing_1',
        append: true,
        result: { status: 'error', message: 'This artifact stream expired. Reload the artifacts to continue.' },
      },
    ])
  })

  it('purges expired archives through the same host cleanup as manual deletion', async () => {
    const store = createMemoryStore({ agents: roster })
    const [chat] = await store.listChats()
    if (chat === undefined) throw new Error('expected seeded chat')
    const side = await store.sideChatFor(chat.id)
    await store.setChatArchived(chat.id, true)
    const archivedAt = (await store.getChat(chat.id))?.archivedAt
    if (archivedAt === null || archivedAt === undefined) throw new Error('expected archive stamp')
    const cleaned: string[][] = []
    const { manor } = service(
      store,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (chatIds) => cleaned.push([...chatIds]),
    )

    expect(await manor.purgeExpiredArchivedChats(archivedAt + ARCHIVE_RETENTION_MS)).toEqual([chat.id, side.id])
    expect(cleaned).toEqual([[chat.id, side.id]])
  })

  it('saves house settings, refuses an invalid one, and purges archives by the saved window', async () => {
    const store = createMemoryStore({ agents: roster })
    const [chat] = await store.listChats()
    if (chat === undefined) throw new Error('expected seeded chat')
    await store.setChatArchived(chat.id, true)
    const archivedAt = (await store.getChat(chat.id))?.archivedAt
    if (archivedAt === null || archivedAt === undefined) throw new Error('expected archive stamp')
    const { manor, broadcast, replies, reply } = service(store)
    await manor.recoverSubagents()
    expect(manor.houseSettings()).toEqual({ type: 'house_settings', settings: DEFAULT_HOUSE_SETTINGS })

    // The archive keeps no "never": the waiting room always empties. The wire lets the bad
    // shape through so the refusal can come back as a notice instead of silence.
    const refused = { type: 'save_house_settings', settings: { ...DEFAULT_HOUSE_SETTINGS, archiveRetentionDays: null } }
    expect(ClientMessageSchema.safeParse(refused).success).toBe(true)
    await manor.handle({ type: 'save_house_settings', settings: refused.settings }, reply)
    expect(replies.at(-1)).toMatchObject({ type: 'notice', kind: 'error' })
    expect(await store.getHouseSettings()).toEqual(DEFAULT_HOUSE_SETTINGS)

    // An app newer than the running server sends a setting the server has never heard of.
    await manor.handle({ type: 'save_house_settings', settings: { ...DEFAULT_HOUSE_SETTINGS, archiveRetentionDays: null, browserSearchEngine: 'kagi', fromNewerApp: true } }, reply)
    expect(replies.at(-1)).toMatchObject({ type: 'notice', kind: 'error', text: expect.stringContaining('Restart Manor') })
    expect(await store.getHouseSettings()).toEqual(DEFAULT_HOUSE_SETTINGS)
    await manor.handle({ type: 'save_house_settings', settings: { ...DEFAULT_HOUSE_SETTINGS, browserSearchEngine: 'kagi' } }, reply)
    expect((await store.getHouseSettings()).browserSearchEngine).toBe('kagi')
    await manor.handle({ type: 'save_house_settings', settings: { ...DEFAULT_HOUSE_SETTINGS, dictationModel: 'nope' } }, reply)
    expect(replies.at(-1)).toMatchObject({ type: 'notice', kind: 'error' })
    expect((await store.getHouseSettings()).dictationModel).toBe('whisper-turbo')
    const dictation = { dictationModel: 'parakeet-tdt-v3', dictationLanguage: 'nl', dictationMicrophone: 'usb-mic-1' } as const
    await manor.handle({ type: 'save_house_settings', settings: { ...DEFAULT_HOUSE_SETTINGS, browserSearchEngine: 'kagi', ...dictation } }, reply)
    expect(await store.getHouseSettings()).toEqual({ ...DEFAULT_HOUSE_SETTINGS, browserSearchEngine: 'kagi', ...dictation })

    const threeDays = 3 * 24 * 60 * 60 * 1000
    expect(await manor.purgeExpiredArchivedChats(archivedAt + threeDays)).toEqual([])
    await manor.handle({ type: 'save_house_settings', settings: { ...DEFAULT_HOUSE_SETTINGS, archiveRetentionDays: 3, autoSettleDays: null } }, reply)
    expect(broadcast.at(-1)).toEqual({ type: 'house_settings', settings: { ...DEFAULT_HOUSE_SETTINGS, archiveRetentionDays: 3, autoSettleDays: null } })
    expect(manor.currentSettings().autoSettleDays).toBeNull()
    expect(await manor.purgeExpiredArchivedChats(archivedAt + threeDays)).toContain(chat.id)
  })

  it('routes an ask-user answer to the blocked turn and refuses a stale card', async () => {
    const store = createMemoryStore({ agents: roster })
    const { chatId } = await seededChat(store)
    const seen: unknown[] = []
    const { manor, replies, reply } = service(
      store,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      async (...args) => {
        seen.push(args)
        return args[1] === 'waiting'
      },
    )

    await manor.handle({
      type: 'answer_user_input',
      chatId,
      requestId: 'waiting',
      answers: { direction: 'A' },
    }, reply)
    await manor.handle({
      type: 'answer_user_input',
      chatId,
      requestId: 'stale',
      answers: { direction: 'B' },
    }, reply)

    expect(seen).toEqual([
      [chatId, 'waiting', { direction: 'A' }],
      [chatId, 'stale', { direction: 'B' }],
    ])
    expect(replies.at(-1)).toMatchObject({ type: 'notice', kind: 'error' })
  })

  it('routes a secret answer to its request and says so when the request is gone', async () => {
    const store = createMemoryStore({ agents: roster })
    const { chatId } = await seededChat(store)
    const seen: unknown[] = []
    const { manor, replies, reply } = service(store, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, (...args) => {
      seen.push(args)
      return args[1] === 'waiting'
    })

    await manor.handle({ type: 'answer_secret_request', chatId, requestId: 'waiting', value: 'value' }, reply)
    expect(replies).toEqual([])
    await manor.handle({ type: 'answer_secret_request', chatId, requestId: 'gone' }, reply)

    expect(seen).toEqual([[chatId, 'waiting', 'value'], [chatId, 'gone', undefined]])
    expect(replies.at(-1)).toMatchObject({ type: 'notice', kind: 'error', text: expect.stringContaining('nothing was kept') })
  })

  it('answers open_chat with that chat: transcript and usage rebuilt from it, and no roster', async () => {
    const store = createMemoryStore({ agents: roster })
    const { chatId, projectId } = await seededChat(store)
    await store.appendEvent(chatId, { type: 'user_message', text: 'hello', mentions: ['sage'] })
    await store.appendEvent(chatId, {
      type: 'agent_message',
      agentId: 'sage',
      turnId: 'turn_0',
      text: 'hi',
      usage: { inputTokens: 80, outputTokens: 12, costUsd: 0.002 },
    })
    await store.appendEvent(chatId, {
      type: 'agent_message',
      agentId: 'sage',
      turnId: 'turn_1',
      text: 'more',
      usage: { inputTokens: 20, outputTokens: 8 },
    })
    const { manor, replies, reply } = service(store)

    await manor.handle({ type: 'open_chat', chatId }, reply)

    const snapshot = replies.at(-1)
    expect(snapshot?.type).toBe('snapshot')
    if (snapshot?.type !== 'snapshot') throw new Error('expected a snapshot')
    expect(snapshot.chatId).toBe(chatId)
    // The household is not in here: it is one list shared by every chat, and it
    // travels as `roster` instead.
    expect('agents' in snapshot).toBe(false)
    expect(snapshot.events).toHaveLength(3)
    expect(snapshot.usage).toEqual({ sage: { inputTokens: 100, outputTokens: 20, costUsd: 0.002 } })
    expect(snapshot.subagent).toBeUndefined()
  })

  it('sends only what follows the events a client holds, and the whole thread when its copy has a gap', async () => {
    const store = createMemoryStore({ agents: roster })
    const { chatId } = await seededChat(store)
    const first = await store.appendEvent(chatId, { type: 'user_message', text: 'hello', mentions: ['sage'] })
    const second = await store.appendEvent(chatId, { type: 'user_message', text: 'again', mentions: ['sage'] })
    const { manor, replies, reply } = service(store)
    const whole = () => {
      const last = replies.at(-1)
      return last?.type === 'snapshot' && last.after === undefined ? last.events.length : -1
    }

    await manor.handle({ type: 'open_chat', chatId, after: first.id, count: 1 }, reply)
    expect(replies.at(-1)).toMatchObject({ type: 'snapshot', after: first.id, events: [{ text: 'again' }] })
    // One event the client never heard of, as a write without a broadcast leaves it.
    await manor.handle({ type: 'open_chat', chatId, after: second.id, count: 1 }, reply)
    expect(whole()).toBe(2)
    await manor.handle({ type: 'open_chat', chatId, after: 'evt_gone', count: 2 }, reply)
    expect(whole()).toBe(2)
  })

  // A client that was away missed the broadcasts. It asks with the rewrite position its
  // last snapshot carried and gets the tail plus the events rewritten under it.
  it('sends a copy from an earlier socket what follows and what was rewritten, or the whole thread when that cannot be told', async () => {
    const store = createMemoryStore({ agents: roster })
    const { chatId } = await seededChat(store)
    const first = await store.appendEvent(chatId, { type: 'user_message', text: 'hello', mentions: ['sage'] })
    const second = await store.appendEvent(chatId, { type: 'user_message', text: 'again', mentions: ['sage'] })
    if (first.type !== 'user_message') throw new Error('expected a user message')
    const { manor, replies, reply } = service(store)
    const last = () => {
      const snapshot = replies.at(-1)
      if (snapshot?.type !== 'snapshot') throw new Error('expected a snapshot')
      return snapshot
    }
    await manor.handle({ type: 'open_chat', chatId }, reply)
    const sync = last().sync
    if (sync === undefined) throw new Error('expected a rewrite position')

    // Nothing happened: an empty tail, and the copy stays as it is.
    expect(ClientMessageSchema.parse({ type: 'open_chat', chatId, after: second.id, count: 2, sync })).toMatchObject({ sync })
    await manor.handle({ type: 'open_chat', chatId, after: second.id, count: 2, sync }, reply)
    expect(last()).toMatchObject({ after: second.id, events: [], sync })
    expect(last().replaced).toBeUndefined()

    await store.replaceEvent(chatId, { ...first, text: 'hello, rewritten' })
    await store.appendEvent(chatId, { type: 'user_message', text: 'third', mentions: ['sage'] })
    await manor.handle({ type: 'open_chat', chatId, after: second.id, count: 2, sync }, reply)
    expect(last()).toMatchObject({ after: second.id, events: [{ text: 'third' }], replaced: [{ id: first.id, text: 'hello, rewritten' }] })
    expect(last().sync).toEqual({ epoch: sync.epoch, rev: sync.rev + 1 })

    // A copy that already holds the rewrite is not sent it again.
    await manor.handle({ type: 'open_chat', chatId, after: second.id, count: 2, sync: last().sync }, reply)
    expect(last().replaced).toBeUndefined()

    // Another server run counted differently, and a position never handed out is no position.
    await manor.handle({ type: 'open_chat', chatId, after: second.id, count: 2, sync: { epoch: 'another-run', rev: 0 } }, reply)
    expect(last().after).toBeUndefined()
    expect(last().events).toHaveLength(3)
    await manor.handle({ type: 'open_chat', chatId, after: second.id, count: 2, sync: { epoch: sync.epoch, rev: sync.rev + 9 } }, reply)
    expect(last().after).toBeUndefined()

    // More rewrites than the log names: the oldest position no longer reaches.
    for (let round = 0; round < 300; round += 1) await store.replaceEvent(chatId, { ...first, text: `round ${round}` })
    await manor.handle({ type: 'open_chat', chatId, after: second.id, count: 2, sync }, reply)
    expect(last().after).toBeUndefined()
    expect(last().events).toHaveLength(3)
  })

  it("carries a child thread's stored row, so an older child keeps why it stopped", async () => {
    const store = createMemoryStore({ agents: roster })
    const { chatId } = await seededChat(store)
    const child = await store.createSubagentChat(chatId, 'Old task', {
      agentId: 'sage', turnId: 'turn_0', toolCallId: 'subagent_old', driver: 'codex', model: 'gpt-6.1-sol', effort: 'low',
      state: 'running', startedAt: 1, depth: 1,
    })
    await store.endSubagent(child.id, { state: 'cancelled', reason: 'Stopped by the user.', endedAt: 2 })
    const { manor, replies, reply } = service(store)

    await manor.handle({ type: 'open_chat', chatId: child.id }, reply)

    expect(replies.at(-1)).toMatchObject({
      type: 'snapshot', chatId: child.id,
      subagent: { id: child.id, parentChatId: chatId, title: 'Old task', state: 'cancelled', reason: 'Stopped by the user.', model: 'gpt-6.1-sol' },
    })
  })

  // The Usage view's whole pipe, end to end through the message handler. The
  // aggregate itself is covered in usageReport.test.ts; what this proves is that the
  // reply reaches the asking socket alone, which is the part a unit test cannot see.
  it('answers get_usage_report to the asking client and never broadcasts it', async () => {
    const store = createMemoryStore({ agents: roster })
    const { chatId, projectId } = await seededChat(store)
    await store.appendEvent(chatId, {
      type: 'turn_result',
      agentId: 'sage',
      turnId: 't1',
      usage: { inputTokens: 900, outputTokens: 30 },
      reportedModel: 'gpt-5.6-sol',
      driver: 'codex',
    })
    const { manor, broadcast, replies, reply } = service(store)

    await manor.handle({ type: 'get_usage_report', windowDays: 7, timeZone: 'Not/AZone' }, reply)

    const answer = replies.at(-1)
    expect(answer?.type).toBe('usage_report')
    if (answer?.type !== 'usage_report') throw new Error('expected a usage report')
    // An unknown zone falls back to the server's own rather than failing the view.
    expect(answer.report.timeZone).not.toBe('Not/AZone')
    // No price source wired: the turn is counted and honestly unpriced.
    expect(answer.report).toMatchObject({ windowDays: 7, sessions: 1, prices: 'unavailable' })
    expect(answer.report.rows).toMatchObject([
      { provider: 'codex', model: 'gpt-5.6-sol', responses: 1, inputTokens: 900, unpricedResponses: 1 },
    ])
    // Nobody else's tab redraws because this one opened a view.
    expect(broadcast).toEqual([])
  })

  it('carries the turn a chat is running in its snapshot, so a reconnect sees it', async () => {
    const store = createMemoryStore({ agents: roster })
    const { chatId, projectId } = await seededChat(store)
    const { driver, forChat } = gated()
    const { manor, broadcast, replies, reply } = service(store, driver)

    const running = manor.handle({ type: 'send_message', chatId, text: '@Sage go' }, reply)
    await until(() => forChat(chatId).length === 1, 'the turn to start')

    // What a client that connected one second ago asks for, and all it gets.
    await manor.handle({ type: 'open_chat', chatId }, reply)
    const snapshot = replies.at(-1)
    if (snapshot?.type !== 'snapshot') throw new Error('expected a snapshot')
    const announced = broadcast.find((message) => message.type === 'turn_state' && message.state === 'running')
    expect(snapshot.activeTurn).toEqual({
      turnId: announced?.type === 'turn_state' ? announced.turnId : '',
      agentId: 'sage',
      startedAt: announced?.type === 'turn_state' ? announced.startedAt : 0,
      messages: [],
    })
    // Contract check: the extra field has to survive the schema the client validates with.
    expect(ServerMessageSchema.safeParse(snapshot).success).toBe(true)

    forChat(chatId)[0]?.finish()
    await running

    // A settled chat announces nothing in flight.
    await manor.handle({ type: 'open_chat', chatId }, reply)
    const settled = replies.at(-1)
    expect(settled?.type === 'snapshot' ? settled.activeTurn : 'missing').toBeUndefined()
  })

  it('lists running Browser-session turns for a reconnecting desktop, open or not', async () => {
    const store = createMemoryStore({ agents: roster })
    const { chatId } = await seededChat(store)
    const { driver, forChat } = gated()
    const { manor, broadcast, replies, reply } = service(store, driver)
    await manor.handle(ClientMessageSchema.parse(createChatMessage({ kind: 'browser' })), reply)
    const created = replies.find((message) => message.type === 'chat_created')
    if (created?.type !== 'chat_created') throw new Error('missing browser chat')
    const browserChat = created.chatId

    const running = [
      manor.handle({ type: 'send_message', chatId, text: '@Sage go' }, reply),
      manor.handle({ type: 'send_message', chatId: browserChat, text: '@Sage read the page' }, reply),
    ]
    await until(() => forChat(chatId).length === 1 && forChat(browserChat).length === 1, 'both turns to start')
    const started = broadcast.find((message) => message.type === 'turn_state' && message.chatId === browserChat)
    expect(ServerMessageSchema.parse(await manor.browserSessionTurns())).toEqual({
      type: 'browser_session_turns',
      turnIds: [started?.type === 'turn_state' ? started.turnId : ''],
    })

    forChat(chatId)[0]?.finish()
    forChat(browserChat)[0]?.finish()
    await Promise.all(running)
    expect(await manor.browserSessionTurns()).toEqual({ type: 'browser_session_turns', turnIds: [] })
  })

  it('omits a turn that finished while the snapshot was still reading', async () => {
    const store = createMemoryStore({ agents: roster })
    const { chatId } = await seededChat(store)
    let hangNext = false
    let releaseOverrides = (): void => {}
    let blocking: Promise<void> | null = null
    const loadChatOverrides = store.loadChatOverrides.bind(store)
    store.loadChatOverrides = async (id) => {
      if (hangNext) {
        blocking ??= new Promise<void>((resolve) => {
          releaseOverrides = resolve
        })
        await blocking
      }
      return loadChatOverrides(id)
    }
    const { driver, forChat } = gated()
    const { manor, replies, reply } = service(store, driver)

    const running = manor.handle({ type: 'send_message', chatId, text: '@Sage go' }, reply)
    await until(() => forChat(chatId).length === 1, 'the turn to start')

    hangNext = true
    const snapshotting = manor.handle({ type: 'open_chat', chatId }, reply)
    await until(() => blocking !== null, 'snapshot to reach overrides')

    forChat(chatId)[0]?.finish()
    await running
    releaseOverrides()
    await snapshotting

    const snapshot = replies.at(-1)
    expect(snapshot?.type === 'snapshot' ? snapshot.activeTurn : 'missing').toBeUndefined()
  })

  it('carries unfinished text in a running snapshot', async () => {
    const store = createMemoryStore({ agents: roster })
    const { chatId } = await seededChat(store)
    const stopped: string[] = []
    const { driver } = partialEndless(stopped)
    const { manor, broadcast, replies, reply } = service(store, driver)

    const running = manor.handle({ type: 'send_message', chatId, text: '@Sage go' }, reply)
    await until(
      () => broadcast.some((message) => message.type === 'delta' && message.text === 'half an answer'),
      'the partial reply',
    )

    await manor.handle({ type: 'open_chat', chatId }, reply)
    const snapshot = replies.at(-1)
    if (snapshot?.type !== 'snapshot') throw new Error('expected a snapshot')
    expect(snapshot.activeTurn?.messages).toEqual([
      { messageId: 'attempt_1:message-1', text: 'half an answer' },
    ])
    expect(ServerMessageSchema.safeParse(snapshot).success).toBe(true)

    await manor.handle({
      type: 'stop',
      turnId: snapshot.activeTurn?.turnId ?? '',
    }, reply)
    await running
  })

  it('speaks a heartbeat the client can validate', () => {
    // Its whole job is to arrive; if it fails the contract the watchdog never resets.
    expect(ServerMessageSchema.safeParse({ type: 'heartbeat' }).success).toBe(true)
  })

  it('advertises and opens website links through the injected host browser', async () => {
    const store = createMemoryStore({ agents: roster })
    const opened: string[] = []
    const { manor, replies, reply } = service(
      store,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        externalBrowser: 'dia',
        openExternalUrl: async (url) => {
          opened.push(url)
        },
      },
    )

    expect(manor.hostCapabilities()).toEqual({ type: 'host_capabilities', externalBrowser: 'dia', repoFileApps: [], reminders: false, auto: false, homeFolders: [] })
    await manor.handle({ type: 'open_external_url', url: 'https://example.com/article' }, reply)

    expect(opened).toEqual(['https://example.com/article'])
    expect(replies).toHaveLength(0)
    expect(ServerMessageSchema.safeParse(manor.hostCapabilities()).success).toBe(true)
  })

  it('keeps non-website protocols outside the external-link contract', () => {
    expect(ClientMessageSchema.safeParse({ type: 'open_external_url', url: 'file:///tmp/private' }).success).toBe(
      false,
    )
  })

  // `file:` parses as a URL and so only exercises the protocol branch. These are the
  // inputs that reach the protocol check without being URLs at all, where a partial
  // refinement throws out of `safeParse` instead of returning a verdict, and one such
  // frame ends the server process.
  it('rejects unparseable external-link URLs without throwing', () => {
    for (const url of ['garbage', 'example.com/article', '//foo', '']) {
      expect(() => ClientMessageSchema.safeParse({ type: 'open_external_url', url })).not.toThrow()
      expect(ClientMessageSchema.safeParse({ type: 'open_external_url', url }).success).toBe(false)
    }
  })

  it('broadcasts a fresh directory after every create', async () => {
    const store = createMemoryStore({ agents: roster })
    const { manor, broadcast, replies, reply } = service(store)

    await manor.handle({ type: 'create_project', name: 'Client work', repoPaths: [] }, reply)
    const projects = lastDirectory(broadcast)
    if (projects?.type !== 'directory') throw new Error('expected a directory')
    const created = projects.projects.find((project) => project.name === 'Client work')
    expect(created).toBeDefined()

    await manor.handle({ type: 'create_chat', projectId: created?.id ?? '', title: 'Kickoff' }, reply)
    const withChat = lastDirectory(broadcast)
    if (withChat?.type !== 'directory') throw new Error('expected a directory')
    expect(withChat.chats.some((chat) => chat.title === 'Kickoff' && chat.projectId === created?.id)).toBe(true)
    expect(broadcast.filter((message) => message.type === 'directory')).toHaveLength(2)
  })

  it('never sends an older directory over a newer one when broadcasts finish out of order', async () => {
    const base = createMemoryStore({ agents: roster })
    // The first read is held after it has read, as git's branch lookup can hold it.
    let hold: Promise<void> | undefined
    let release = () => undefined as void
    const store: Store = {
      ...base,
      listProjects: async () => {
        const projects = await base.listProjects()
        const held = hold
        hold = undefined
        await held
        return projects
      },
    }
    const { manor, broadcast } = service(store)
    hold = new Promise((resolve) => { release = resolve })
    const older = manor.broadcastDirectory()
    await base.createProject('Client work', [])
    await manor.broadcastDirectory()
    release()
    await older
    const sent = broadcast.filter((message) => message.type === 'directory')
    expect(sent).toHaveLength(1)
    expect(lastDirectory(broadcast)).toMatchObject({ projects: expect.arrayContaining([expect.objectContaining({ name: 'Client work' })]) })
  })

  it('lists active turns in the directory for reconnecting clients', async () => {
    const store = createMemoryStore({ agents: roster })
    const dm = await store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })
    const gate = gated()
    const { manor, broadcast, reply } = service(store, gate.driver)
    const running = manor.handle({ type: 'send_message', chatId: dm.id, text: 'Think about this.' }, reply)
    await until(() => gate.forChat(dm.id).length === 1, 'the active DM turn')
    await manor.broadcastDirectory()
    expect(lastDirectory(broadcast)).toMatchObject({
      type: 'directory', runningTurns: { [dm.id]: [expect.any(String)] },
    })

    gate.forChat(dm.id)[0]?.finish()
    await running
    await manor.broadcastDirectory()
    expect(lastDirectory(broadcast)).toMatchObject({ type: 'directory', runningTurns: {} })
  })

  it('creates a chat and stores its opening prompt as one action', async () => {
    const store = createMemoryStore({ agents: roster })
    const project = await store.createProject('Deferred chat')
    const { manor, broadcast, replies, reply } = service(store)

    await manor.handle(
      {
        type: 'create_chat',
        projectId: project.id,
        openingMessage: { text: 'Start with the first real prompt' },
        requestId: 'create-chat-1',
      },
      reply,
    )

    const chat = (await store.listChats()).find((candidate) => candidate.projectId === project.id)
    expect(chat).toBeDefined()
    expect(replies).toEqual([
      { type: 'chat_created', chatId: chat?.id, requestId: 'create-chat-1' },
      { type: 'ack', requestId: 'create-chat-1' },
    ])
    // The prompt, plus the note saying it named nobody: this roster has no chief of
    // staff, so nothing was going to answer it.
    expect(chat === undefined ? [] : await store.loadEvents(chat.id)).toEqual([
      expect.objectContaining({ type: 'user_message', text: 'Start with the first real prompt' }),
      expect.objectContaining({ type: 'system_note', kind: 'info' }),
    ])
    expect(broadcast.at(0)?.type).toBe('directory')
    expect(broadcast.some((message) => message.type === 'event' && message.chatId === chat?.id)).toBe(true)
  })

  it('acknowledges the creator\'s exact chat when another client creates in the same project', async () => {
    const store = createMemoryStore({ agents: roster })
    const project = await store.createProject('Concurrent creates')
    const { manor } = service(store)
    const otherReplies: ServerMessage[] = []
    const ownReplies: ServerMessage[] = []

    await manor.handle(
      { type: 'create_chat', projectId: project.id, openingMessage: { text: 'Created by the other client' } },
      (message) => otherReplies.push(message),
    )
    await manor.handle(
      { type: 'create_chat', projectId: project.id, openingMessage: { text: 'Created by this client' } },
      (message) => ownReplies.push(message),
    )

    const other = otherReplies.find((message) => message.type === 'chat_created')
    const own = ownReplies.find((message) => message.type === 'chat_created')
    expect(other?.type).toBe('chat_created')
    expect(own?.type).toBe('chat_created')
    if (other?.type !== 'chat_created' || own?.type !== 'chat_created') {
      throw new Error('expected exact create acknowledgements')
    }
    expect(own.chatId).not.toBe(other.chatId)
    expect(await store.loadEvents(own.chatId)).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'user_message', text: 'Created by this client' })]),
    )
  })

  it('names New chat from its opening message and broadcasts the sidebar update', async () => {
    const store = createMemoryStore({ agents: roster })
    const { chatId, projectId } = await seededChat(store)
    const openings: string[] = []
    let finishTitle = (_title: string): void => undefined
    const pendingTitle = new Promise<string>((resolve) => {
      finishTitle = resolve
    })
    const generateTitle: GenerateChatTitle = (_id, opening) => {
      openings.push(opening)
      return pendingTitle
    }
    const { manor, broadcast, reply } = service(store, undefined, generateTitle)

    await manor.handle({ type: 'send_message', chatId, text: 'Maak de sidebar projectgericht' }, reply)
    await until(() => openings.length === 1, 'the first title turn to start')
    await manor.handle({ type: 'send_message', chatId, text: 'En maak hem compact' }, reply)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(openings).toEqual(['Maak de sidebar projectgericht'])

    finishTitle('Sidebar project navigation')
    await until(
      () =>
        broadcast.some(
          (message) =>
            message.type === 'directory' &&
            message.chats.find((chat) => chat.id === chatId)?.title === 'Sidebar project navigation',
        ),
      'the generated chat title to be stored',
    )

    const directory = lastDirectory(broadcast)
    expect(directory?.type === 'directory' && directory.chats.find((chat) => chat.id === chatId)?.title).toBe(
      'Sidebar project navigation',
    )
  })

  it('never overwrites a chat that already has a title', async () => {
    const store = createMemoryStore({ agents: roster })
    const { chatId, projectId } = await seededChat(store)
    await store.setChatTitle(chatId, 'Kept title')
    let calls = 0
    const { manor, reply } = service(store, undefined, async () => {
      calls += 1
      return 'Wrong title'
    })

    await manor.handle({ type: 'send_message', chatId, text: 'Another subject' }, reply)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect((await store.listChats()).find((chat) => chat.id === chatId)?.title).toBe('Kept title')
    expect(calls).toBe(0)
  })

  it('deletes a chat, and a project takes its chats with it', async () => {
    const store = createMemoryStore({ agents: roster })
    const { chatId, projectId } = await seededChat(store)
    const kept = await store.createProject('Kept')
    const keptChat = await store.createChat({ projectId: kept.id, title: 'Still here' })
    const doomed = await store.createChat({ projectId, title: 'Doomed' })
    const { manor, broadcast, reply } = service(store)

    await manor.handle({ type: 'delete_chat', chatId: doomed.id }, reply)
    const afterChat = lastDirectory(broadcast)
    if (afterChat?.type !== 'directory') throw new Error('expected a directory')
    expect(afterChat.chats.some((chat) => chat.id === doomed.id)).toBe(false)

    await manor.handle({ type: 'delete_project', projectId }, reply)
    const afterProject = lastDirectory(broadcast)
    if (afterProject?.type !== 'directory') throw new Error('expected a directory')
    expect(afterProject.projects.map((project) => project.id)).toEqual([kept.id])
    expect(afterProject.chats.map((chat) => chat.id)).toEqual([keptChat.id])
  })

  it('keeps a Work target linked when its chat deletion fails', async () => {
    const store = createMemoryStore({ agents: roster })
    const { projectId } = await seededChat(store)
    const source = await store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })
    const target = await store.createChat({ projectId, title: 'Bounded work' })
    const { handoff } = await store.reserveWorkHandoff({
      sourceChatId: source.id,
      sourceTurnId: 'turn_1',
      projectId,
      projectName: 'Manor',
      title: 'Bounded work',
      leadAgentId: 'sage',
      leadAgentName: 'Sage',
      supportingAgentIds: [],
      supportingAgentNames: [],
    })
    await store.finalizeWorkHandoff(handoff.id, target.id, {
      type: 'system_note',
      kind: 'info',
      text: 'Work started.',
      workHandoffId: handoff.id,
      workHandoffPhase: 'created',
    })
    const failing: Store = {
      ...store,
      deleteChat: async (chatId) => {
        if (chatId === target.id) throw new Error('database unavailable')
        await store.deleteChat(chatId)
      },
    }
    const { manor, reply } = service(failing)

    await expect(manor.handle({ type: 'delete_chat', chatId: target.id }, reply)).rejects.toThrow('database unavailable')

    expect(await store.getChat(target.id)).toBeDefined()
    expect((await store.listWorkHandoffs())[0]).toMatchObject({ workChatId: target.id, state: 'active' })
  })

  it('settles a chat and picks it back up, broadcasting both to everyone', async () => {
    const store = createMemoryStore({ agents: roster })
    const { chatId, projectId } = await seededChat(store)
    const { manor, broadcast, reply } = service(store)

    await manor.handle({ type: 'set_chat_settled', chatId, settled: true }, reply)
    const settled = lastDirectory(broadcast)
    if (settled?.type !== 'directory') throw new Error('expected a directory')
    expect(settled.chats.find((chat) => chat.id === chatId)?.settledAt).toBeTypeOf('number')

    await manor.handle({ type: 'set_chat_settled', chatId, settled: false }, reply)
    const picked = lastDirectory(broadcast)
    if (picked?.type !== 'directory') throw new Error('expected a directory')
    expect(picked.chats.find((chat) => chat.id === chatId)?.settledAt).toBeNull()
  })

  it('archives and restores a project chat without deleting its messages', async () => {
    const store = createMemoryStore({ agents: roster })
    const { chatId } = await seededChat(store)
    await store.appendEvent(chatId, { type: 'user_message', text: 'Keep this', mentions: [] })
    const { manor, broadcast, reply } = service(store)

    await manor.handle({ type: 'set_chat_archived', chatId, archived: true }, reply)
    const archived = lastDirectory(broadcast)
    if (archived?.type !== 'directory') throw new Error('expected a directory')
    expect(archived.chats.find((chat) => chat.id === chatId)?.archivedAt).toBeTypeOf('number')
    expect(await store.loadEvents(chatId)).toHaveLength(1)

    await manor.handle({ type: 'set_chat_archived', chatId, archived: false }, reply)
    const restored = lastDirectory(broadcast)
    if (restored?.type !== 'directory') throw new Error('expected a directory')
    expect(restored.chats.find((chat) => chat.id === chatId)?.archivedAt).toBeNull()
    expect(await store.loadEvents(chatId)).toHaveLength(1)
  })

  it('refuses to archive a home chat', async () => {
    const store = createMemoryStore({ agents: roster })
    const dm = await store.createChat({ kind: 'dm', memberIds: ['sage'] })
    const { manor, broadcast, replies, reply } = service(store)

    await manor.handle({ type: 'set_chat_archived', chatId: dm.id, archived: true }, reply)

    expect(replies.at(-1)).toMatchObject({ type: 'notice', kind: 'error' })
    expect(broadcast).toHaveLength(0)
    expect((await store.getChat(dm.id))?.archivedAt).toBeNull()
  })

  // A settled chat is one the user put down, not one Manor archived: an answer landing
  // in it keeps its place in the order and leaves the stamp exactly where it was.
  it('leaves a settled chat settled when a new event lands in it', async () => {
    const store = createMemoryStore({ agents: roster })
    const { chatId, projectId } = await seededChat(store)
    const { manor, reply } = service(store)

    await manor.handle({ type: 'set_chat_settled', chatId, settled: true }, reply)
    const before = (await store.listChats()).find((chat) => chat.id === chatId)?.settledAt
    await store.appendEvent(chatId, { type: 'user_message', text: 'one more thing', mentions: [] })

    expect((await store.listChats()).find((chat) => chat.id === chatId)?.settledAt).toBe(before)
  })

  it('reorders projects, and refuses an order that is not the whole list', async () => {
    const store = createMemoryStore({ agents: roster })
    const seeded = (await store.listProjects()).map((project) => project.id)
    const added = await store.createProject('Life admin')
    const { manor, broadcast, replies, reply } = service(store)

    const moved = [added.id, ...seeded]
    await manor.handle({ type: 'reorder_projects', projectIds: moved }, reply)
    const after = lastDirectory(broadcast)
    if (after?.type !== 'directory') throw new Error('expected a directory')
    expect(after.projects.map((project) => project.id)).toEqual(moved)
    expect(replies).toHaveLength(0)

    // A client that learned the sidebar before `added` existed would otherwise drop
    // it by naming an order that never mentions it.
    await manor.handle({ type: 'reorder_projects', projectIds: seeded }, reply)
    expect(replies[0]).toMatchObject({ type: 'notice', kind: 'error' })
    const refused = replies[1]
    if (refused?.type !== 'directory') throw new Error('expected the order to be re-announced')
    expect(refused.projects.map((project) => project.id)).toEqual(moved)
  })

  it('deleting a chat mid-turn stops the turn and records nothing after it', async () => {
    const { driver, forChat } = gated()
    const store = createMemoryStore({ agents: roster })
    const { chatId, projectId } = await seededChat(store)
    const { manor, broadcast, reply } = service(store, driver)

    const running = manor.handle({ type: 'send_message', chatId, text: '@Sage think about it' }, reply)
    await until(() => forChat(chatId).length === 1, 'the turn to start')

    await manor.handle({ type: 'delete_chat', chatId }, reply)

    const directory = lastDirectory(broadcast)
    if (directory?.type !== 'directory') throw new Error('expected a directory')
    expect(directory.chats.some((chat) => chat.id === chatId)).toBe(false)

    // The driver answering after the chat is gone must not throw its way out of the
    // turn: the rows it would write no longer exist.
    forChat(chatId)[0]?.finish()
    await expect(running).resolves.toBeUndefined()
    await expect(store.appendEvent(chatId, { type: 'user_message', text: 'ghost', mentions: [] })).rejects.toThrow()
    expect(broadcast.some((message) => message.type === 'event')).toBe(true)
    expect(broadcast.some((message) => message.type === 'turn_state' && message.state === 'done')).toBe(false)
  })

  it('runs a turn end to end and broadcasts its events to everyone', async () => {
    const store = createMemoryStore({ agents: roster })
    const { chatId, projectId } = await seededChat(store)
    const { manor, broadcast, replies, reply } = service(store)

    await manor.handle({ type: 'send_message', chatId, text: '@Sage hello' }, reply)

    // user_message, the reasoning row, the reply, and turn_result.
    const eventMessages = broadcast.filter((message) => message.type === 'event')
    expect(new Set(eventMessages.map((message) => message.event.id)).size).toBe(4)
    expect(eventMessages.flatMap((message) => message.event.type === 'user_message' ? [message.event.dispatchState] : []))
      .toEqual(['pending', 'started', 'completed'])
    expect(broadcast.filter((message) => message.type === 'turn_state').at(-1)).toMatchObject({
      chatId,
      state: 'done',
    })
    expect(replies).toHaveLength(0)
  })
})

/** A real folder, because attaching one is the thing being tested. */
let repo: string

beforeAll(() => {
  repo = mkdtempSync(path.join(os.tmpdir(), 'manor-service-repo-'))
})

const projectOf = (messages: ServerMessage[], projectId: string) => {
  const directory = lastDirectory(messages)
  if (directory?.type !== 'directory') throw new Error('expected a directory')
  return directory.projects.find((project) => project.id === projectId)
}

describe('ManorService, editing a project', () => {
  it('returns one bounded repo-file preview through the wire protocol', async () => {
    writeFileSync(path.join(repo, 'README.md'), '# Repo\n', 'utf8')
    const store = createMemoryStore({ agents: roster })
    const project = (await store.listProjects())[0]
    if (project === undefined) throw new Error('expected seeded project')
    await store.updateProject(project.id, project.name, [repo])
    const { manor, replies, reply } = service(store)
    const file = `${path.basename(repo)}/README.md`

    await manor.handle({ type: 'read_repo_file', projectId: project.id, path: file }, reply)

    expect(replies).toEqual([
      {
        type: 'repo_file',
        projectId: project.id,
        path: file,
        result: { status: 'ready', content: '# Repo\n', revision: expect.stringMatching(/^[0-9a-f]{64}$/) },
      },
    ])
    expect(ServerMessageSchema.safeParse(replies[0]).success).toBe(true)
  })

  it('saves a repo file back through the wire protocol, and refuses a stale save', async () => {
    writeFileSync(path.join(repo, 'notes.md'), 'first\n', 'utf8')
    const store = createMemoryStore({ agents: roster })
    const project = (await store.listProjects())[0]
    if (project === undefined) throw new Error('expected seeded project')
    await store.updateProject(project.id, project.name, [repo])
    const { manor, replies, reply } = service(store)
    const file = `${path.basename(repo)}/notes.md`

    await manor.handle({ type: 'read_repo_file', projectId: project.id, path: file }, reply)
    const read = replies[0]
    if (read?.type !== 'repo_file' || read.result.status !== 'ready') throw new Error('expected a readable file')
    const revision = read.result.revision as string

    await manor.handle(
      { type: 'write_repo_file', projectId: project.id, path: file, content: 'mine\n', baseRevision: revision },
      reply,
    )
    // The same precondition a second time is the one case that must not go through,
    // because disk has moved past it.
    await manor.handle(
      { type: 'write_repo_file', projectId: project.id, path: file, content: 'again\n', baseRevision: revision },
      reply,
    )

    expect(replies[1]).toMatchObject({ type: 'repo_write', projectId: project.id, path: file })
    expect((replies[1] as { result: { status: string } }).result.status).toBe('saved')
    expect((replies[2] as { result: { status: string } }).result).toMatchObject({
      status: 'stale',
      content: 'mine\n',
    })
    expect(readFileSync(path.join(repo, 'notes.md'), 'utf8')).toBe('mine\n')
    expect(replies.every((message) => ServerMessageSchema.safeParse(message).success)).toBe(true)
  })

  it('refuses a path that is not a folder and changes nothing', async () => {
    const store = createMemoryStore({ agents: roster })
    const { projectId, chatId } = await seededChat(store)
    await store.setSession(chatId, 'sage', 'session-a')
    const { manor, broadcast, replies, reply } = service(store)

    const paths = [repo, path.join(repo, 'nowhere')]
    await manor.handle({ type: 'update_project', projectId, name: 'Manor', repoPaths: paths }, reply)

    expect(replies).toHaveLength(1)
    expect(replies.at(0)).toEqual({
      type: 'notice',
      kind: 'error',
      text: `There is nothing at ${path.join(repo, 'nowhere')}.`,
    })
    // One bad folder refuses the whole list: nothing changed, so no directory goes
    // out, the good path was not stored either, and the sessions survive.
    expect(broadcast).toHaveLength(0)
    expect((await store.listProjects()).at(0)?.repoPaths).toEqual([])
    expect(await sessionIdIn(store, chatId, 'sage')).toBe('session-a')
  })

  it('refuses a relative path with the reason spelled out', async () => {
    const store = createMemoryStore({ agents: roster })
    const { chatId, projectId } = await seededChat(store)
    const { manor, broadcast, replies, reply } = service(store)

    await manor.handle(
      { type: 'update_project', projectId, name: 'Manor', repoPaths: ['Ontwikkeling/Manor'] },
      reply,
    )

    const notice = replies.at(0)
    expect(notice?.type).toBe('notice')
    expect(notice?.type === 'notice' ? notice.text : '').toContain('is not an absolute path')
    expect(broadcast).toHaveLength(0)
  })

  it('stores the memory scope with the project and keeps it when an older client omits it', async () => {
    const store = createMemoryStore({ agents: roster })
    const { projectId } = await seededChat(store)
    const { manor, reply } = service(store)

    await manor.handle({ type: 'update_project', projectId, name: 'Manor', repoPaths: [], memoryScope: 'knowledge' }, reply)
    expect((await store.getProject(projectId))?.memoryScope).toBe('knowledge')

    await manor.handle({ type: 'update_project', projectId, name: 'Manor', repoPaths: [] }, reply)
    expect((await store.getProject(projectId))?.memoryScope).toBe('knowledge')
  })

  it('refuses to delete or thread the home room, and keeps its Sessions', async () => {
    const store = createMemoryStore({ agents: roster })
    const session = await store.createChat({ projectId: 'home' })
    const { manor, replies, reply } = service(store)

    await manor.handle({ type: 'delete_project', projectId: 'home' }, reply)
    await manor.handle({ type: 'create_project_thread', projectId: 'home', requestId: 'thread-home' }, reply)

    expect(replies.map((entry) => entry.type)).toEqual(['notice', 'notice'])
    expect(await store.getChat(session.id)).toBeDefined()
    expect((await store.listChats()).filter((chat) => chat.projectId === 'home')).toHaveLength(1)
  })

  it('refuses a nameless project rather than storing a blank label', async () => {
    const store = createMemoryStore({ agents: roster })
    const { chatId, projectId } = await seededChat(store)
    const { manor, broadcast, replies, reply } = service(store)

    await manor.handle({ type: 'update_project', projectId, name: '   ', repoPaths: [] }, reply)

    expect(replies.at(0)).toEqual({ type: 'notice', kind: 'error', text: 'A project needs a name.' })
    expect(broadcast).toHaveLength(0)
  })

  it('stores every good path, drops the CLI sessions in the project and broadcasts it', async () => {
    const store = createMemoryStore({ agents: roster })
    const { projectId, chatId } = await seededChat(store)
    const second = await store.createChat({ projectId, title: 'Second' })
    const { manor, broadcast, replies, reply } = service(store)
    const elsewhere = await store.createProject('Elsewhere')
    const untouched = await store.createChat({ projectId: elsewhere.id, title: 'Untouched' })
    const vault = mkdtempSync(path.join(os.tmpdir(), 'manor-service-vault-'))
    await store.setSession(chatId, 'sage', 'session-a')
    await store.setSession(chatId, 'sage', 'session-a-codex', { driver: 'codex' })
    await store.setSession(second.id, 'smith', 'session-b')
    await store.setSession(untouched.id, 'sage', 'session-c')

    await manor.handle(
      // The trailing slash and the repeat are what normalisation and dedupe are for.
      { type: 'update_project', projectId, name: 'Manor', repoPaths: [`${repo}/`, vault, repo] },
      reply,
    )

    expect(replies).toHaveLength(0)
    expect(projectOf(broadcast, projectId)?.repoPaths).toEqual([repo, vault])
    // A persona resuming its old session would still be told the old folders, so
    // both chats of this project start over on every provider; another project's
    // session is untouched.
    expect(await store.getSessions(chatId, 'sage')).toEqual([])
    expect(await sessionIdIn(store, second.id, 'smith')).toBeUndefined()
    expect(await sessionIdIn(store, untouched.id, 'sage')).toBe('session-c')
  })

  it('renames and restyles a project without costing it its CLI sessions', async () => {
    const store = createMemoryStore({ agents: roster })
    const { projectId, chatId } = await seededChat(store)
    await store.updateProject(projectId, 'Manor', [repo])
    await store.setSession(chatId, 'sage', 'session-a')
    const { manor, broadcast, reply } = service(store)

    await manor.handle(
      {
        type: 'update_project',
        projectId,
        name: 'Knowledge work',
        repoPaths: [repo],
        icon: 'analytics',
        color: '#7AA2F7',
      },
      reply,
    )

    expect(projectOf(broadcast, projectId)).toMatchObject({
      id: projectId,
      name: 'Knowledge work',
      icon: 'analytics',
      color: '#7AA2F7',
      repoPaths: [repo],
    })
    // The folders are what a persona was told about; the label is not, so a rename
    // must not throw away a live session.
    expect(await sessionIdIn(store, chatId, 'sage')).toBe('session-a')
  })

  it('unlinks every folder and clears the sessions again', async () => {
    const store = createMemoryStore({ agents: roster })
    const { projectId, chatId } = await seededChat(store)
    await store.updateProject(projectId, 'Manor', [repo])
    await store.setSession(chatId, 'sage', 'session-a')
    const { manor, broadcast, reply } = service(store)

    await manor.handle({ type: 'update_project', projectId, name: 'Manor', repoPaths: [] }, reply)

    expect(projectOf(broadcast, projectId)?.repoPaths).toEqual([])
    expect(await sessionIdIn(store, chatId, 'sage')).toBeUndefined()
  })

  it('refuses an update to a project that is gone', async () => {
    const store = createMemoryStore({ agents: roster })
    const { manor, broadcast, replies, reply } = service(store)

    await manor.handle({ type: 'update_project', projectId: 'ghost', name: 'Ghost', repoPaths: [] }, reply)

    const notice = replies.at(0)
    expect(notice?.type).toBe('notice')
    expect(notice?.type === 'notice' ? notice.text : '').toContain('That project is gone')
    expect(broadcast).toHaveLength(0)
  })
})

describe('ManorService, picking a folder while creating a project', () => {
  it('answers list_dirs to the socket that asked and tells nobody else', async () => {
    const store = createMemoryStore({ agents: roster })
    const { manor, broadcast, replies, reply } = service(store)

    await manor.handle({ type: 'list_dirs', path: repo }, reply)

    expect(replies).toHaveLength(1)
    expect(replies.at(0)).toEqual({ type: 'dir_listing', path: repo, parent: path.dirname(repo), entries: [] })
    // One client browsing the disk is nobody else's business, and nothing changed.
    expect(broadcast).toHaveLength(0)
  })

  it('answers an unusable path with a notice rather than an empty listing', async () => {
    const store = createMemoryStore({ agents: roster })
    const { manor, broadcast, replies, reply } = service(store)

    await manor.handle({ type: 'list_dirs', path: path.join(repo, 'nowhere') }, reply)

    const notice = replies.at(0)
    expect(notice?.type).toBe('notice')
    expect(notice?.type === 'notice' ? notice.text : '').toBe(`There is nothing at ${path.join(repo, 'nowhere')}.`)
    expect(broadcast).toHaveLength(0)
  })

  it('creates the full setup and reconciles it at server startup', async () => {
    const store = createMemoryStore({ agents: roster })
    const root = mkdtempSync(path.join(os.tmpdir(), 'manor-service-setup-'))
    const broadcasts: ServerMessage[] = []
    const options = {
      store, agents: () => roster, setAgents: () => undefined, mcpServers: () => [], setMcpServers: () => undefined, resolveDriver: () => createMockDriver({ deltaDelayMs: 0 }),
      ensureScratchDir: scratchFor, structuredMemoryRoot: root,
      broadcast: (message: ServerMessage) => broadcasts.push(message),
    }
    const manor = new ManorService(options)
    await manor.handle({ type: 'create_project', name: 'New project', repoPaths: [] }, () => undefined)
    const project = (await store.listProjects()).find((row) => row.name === 'New project')!
    expect(project.threadChatId).toBeDefined()
    expect(await store.getChat(project.threadChatId!)).toMatchObject({ mode: 'single', projectId: project.id })
    for (const [file, heading] of [['preferences.md', 'Preferences'], ['notes.md', 'Notes']]) {
      expect(readFileSync(path.join(root, 'new-project', file!), 'utf8')).toBe(`---\nowner: project-thread\n---\n# ${heading} for New project\n\n`)
    }
    expect(readFileSync(path.join(root, 'new-project/MEMORY.md'), 'utf8')).toContain('[Notes](notes.md): ')
    // A project without a thread is hidden: startup never gives it one.
    const legacy = await store.createProject('Legacy')
    const chats = (await store.listChats()).length
    await manor.reconcileProjectSetup()
    await new ManorService(options).reconcileProjectSetup()
    expect((await store.getProject(legacy.id))?.threadChatId).toBeUndefined()
    expect(await store.getProjectSetup(legacy.id)).toBeUndefined()
    expect((await store.listChats()).length).toBe(chats)
    const notes = readFileSync(path.join(root, 'new-project/notes.md'), 'utf8')
    await manor.handle({ type: 'delete_chat', chatId: project.threadChatId! }, () => undefined)
    expect(readFileSync(path.join(root, 'new-project/notes.md'), 'utf8')).toBe(notes)
    await manor.reconcileProjectSetup()
    expect((await store.getProject(project.id))?.threadChatId).toBeUndefined()
    // One listed project's broken setup does not stop the next one's.
    const broken = await store.createProject('Broken')
    const later = await store.createProject('After broken')
    await manor.handle({ type: 'create_project_thread', projectId: broken.id }, () => undefined)
    await manor.handle({ type: 'create_project_thread', projectId: later.id }, () => undefined)
    rmSync(path.join(root, 'broken/notes.md'))
    rmSync(path.join(root, 'after-broken/MEMORY.md'))
    mkdirSync(path.join(root, 'broken/notes.md'), { recursive: true })
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await manor.reconcileProjectSetup()
    expect(errors).toHaveBeenCalledWith('[manor] Project setup failed', 'Broken', expect.stringContaining('EISDIR'))
    expect(readFileSync(path.join(root, 'after-broken/MEMORY.md'), 'utf8')).toContain('[Notes](notes.md): ')
    errors.mockRestore()
    mkdirSync(path.join(root, 'failed-creation/notes.md'), { recursive: true })
    const replies: ServerMessage[] = []
    await manor.handle({ type: 'create_project', name: 'Failed creation', repoPaths: [] }, (message) => replies.push(message))
    expect((await store.listProjects()).find((row) => row.name === 'Failed creation')).toBeDefined()
    expect(replies).toContainEqual(expect.objectContaining({ type: 'notice', kind: 'error', text: expect.stringContaining('setup is incomplete') }))
    const recover = vi.spyOn(manor.subagents(), 'recover').mockResolvedValue(0)
    await manor.recoverSubagents()
    expect(recover).toHaveBeenCalledOnce()
    recover.mockRestore()
  })

  it('starts a new project thread on the chosen model, and has it read the folders and say hello', async () => {
    const store = createMemoryStore({ agents: roster })
    const folder = mkdtempSync(path.join(os.tmpdir(), 'manor-welcome-'))
    const replies: ServerMessage[] = []
    const reply = (message: ServerMessage) => { replies.push(message) }
    const manor = new ManorService({
      store, agents: () => roster, setAgents: () => undefined, mcpServers: () => [], setMcpServers: () => undefined,
      resolveDriver: () => createMockDriver({ deltaDelayMs: 0 }), ensureScratchDir: scratchFor,
      structuredMemoryRoot: mkdtempSync(path.join(os.tmpdir(), 'manor-welcome-memory-')), broadcast: () => undefined,
    })
    const threadRuntime = { driver: 'claude', model: 'claude-opus-5-5', effort: 'medium' } as const

    await manor.handle({ type: 'create_project', name: 'Client work', repoPaths: [folder], threadRuntime }, reply)
    const project = (await store.listProjects()).find((row) => row.name === 'Client work')!
    const threadId = project.threadChatId!
    expect(await store.loadChatOverrides(threadId)).toEqual({ __single__: threadRuntime })
    // The welcome is a turn of its own in the thread, after the project exists.
    await vi.waitFor(async () => {
      expect((await store.loadEvents(threadId)).some((event) => event.type === 'agent_message')).toBe(true)
    })

    // A model that does not belong to its provider makes no project at all.
    await manor.handle({ type: 'create_project', name: 'Refused', repoPaths: [], threadRuntime: { ...threadRuntime, driver: 'codex' } }, reply)
    expect(replies.at(-1)).toMatchObject({ type: 'notice', kind: 'error' })
    expect((await store.listProjects()).some((row) => row.name === 'Refused')).toBe(false)
  })

  it('starts a new project thread and a bare Browser session on a model still on when the default is off', async () => {
    const store = createMemoryStore({ agents: roster })
    const replies: ServerMessage[] = []
    const reply = (message: ServerMessage) => { replies.push(message) }
    const manor = new ManorService({
      store, agents: () => roster, setAgents: () => undefined, mcpServers: () => [], setMcpServers: () => undefined,
      resolveDriver: () => createMockDriver({ deltaDelayMs: 0 }), ensureScratchDir: scratchFor,
      structuredMemoryRoot: mkdtempSync(path.join(os.tmpdir(), 'manor-off-memory-')), broadcast: () => undefined,
    })
    const off = [NEW_SINGLE_CHAT_DEFAULT.model, defaultSingleRuntime(roster).model]
    await manor.handle({ type: 'save_house_settings', settings: { ...DEFAULT_HOUSE_SETTINGS, disabledModels: off } }, reply)

    await manor.handle({ type: 'create_project', name: 'Client work', repoPaths: [] }, reply)
    const project = (await store.listProjects()).find((row) => row.name === 'Client work')!
    const thread = (await store.loadChatOverrides(project.threadChatId!)).__single__
    expect(thread?.model).toBeDefined()
    expect(off).not.toContain(thread?.model)

    await manor.handle(ClientMessageSchema.parse(createChatMessage({ kind: 'browser' })), reply)
    const created = replies.filter((message) => message.type === 'chat_created').at(-1)
    const browser = (await store.loadChatOverrides(created?.type === 'chat_created' ? created.chatId : '')).__single__
    expect(browser?.model).toBeDefined()
    expect(off).not.toContain(browser?.model)
    // Auto, where the host has it, still chooses for the untouched session.
    expect(browser?.auto).toBe(true)
  })

  it('hides a project with its thread kept past the archive retention, and adds it back with the same thread', async () => {
    const store = createMemoryStore({ agents: roster })
    const replies: ServerMessage[] = []
    const reply = (message: ServerMessage) => { replies.push(message) }
    const manor = new ManorService({
      store, agents: () => roster, setAgents: () => undefined, mcpServers: () => [], setMcpServers: () => undefined,
      resolveDriver: () => createMockDriver({ deltaDelayMs: 0 }), ensureScratchDir: scratchFor,
      structuredMemoryRoot: mkdtempSync(path.join(os.tmpdir(), 'manor-hide-memory-')), broadcast: () => undefined,
    })
    await manor.handle({ type: 'create_project', name: 'Client work', repoPaths: [] }, reply)
    const project = (await store.listProjects()).find((row) => row.name === 'Client work')!
    const threadId = project.threadChatId!
    await vi.waitFor(async () => {
      expect((await store.loadEvents(threadId)).some((event) => event.type === 'agent_message')).toBe(true)
    })
    const history = (await store.loadEvents(threadId)).map((event) => event.id)

    await manor.handle({ type: 'remove_project_thread', projectId: project.id }, reply)
    expect((await store.getProject(project.id))?.threadChatId).toBe(threadId)
    expect((await store.getChat(threadId))?.archivedAt).not.toBeNull()
    expect(await manor.purgeExpiredArchivedChats(Date.now() + 2 * ARCHIVE_RETENTION_MS)).toEqual([])

    await manor.handle({ type: 'create_project_thread', projectId: project.id, requestId: 'back' }, reply)
    expect(replies.at(-1)).toMatchObject({ type: 'ack', requestId: 'back', workChatId: threadId })
    expect((await store.getChat(threadId))?.archivedAt).toBeNull()
    expect((await store.loadEvents(threadId)).map((event) => event.id)).toEqual(history)

    // Archiving the thread chat itself is the same hide, and restoring it the same way back.
    await manor.handle({ type: 'set_chat_archived', chatId: threadId, archived: true }, reply)
    expect((await store.getChat(threadId))?.archivedAt).not.toBeNull()
    await manor.handle({ type: 'set_chat_archived', chatId: threadId, archived: false }, reply)
    expect((await store.getChat(threadId))?.archivedAt).toBeNull()
    expect((await store.getProject(project.id))?.threadChatId).toBe(threadId)
    expect(replies.some((message) => message.type === 'notice' && message.kind === 'error')).toBe(false)
  })

  it('adds a folder without a thread, takes it off the picker with its Sessions kept, and promotes it', async () => {
    const store = createMemoryStore({ agents: roster })
    const memory = mkdtempSync(path.join(os.tmpdir(), 'manor-folder-memory-'))
    const folderPath = mkdtempSync(path.join(os.tmpdir(), 'manor-folder-'))
    const replies: ServerMessage[] = []
    const reply = (message: ServerMessage) => { replies.push(message) }
    const manor = new ManorService({
      store, agents: () => roster, setAgents: () => undefined, mcpServers: () => [], setMcpServers: () => undefined,
      resolveDriver: () => createMockDriver({ deltaDelayMs: 0 }), ensureScratchDir: scratchFor,
      structuredMemoryRoot: memory, broadcast: () => undefined,
    })

    await manor.handle({ type: 'add_folder', path: folderPath, requestId: 'add' }, reply)
    const created = replies.find((message) => message.type === 'project_created')
    expect(created).toMatchObject({ requestId: 'add' })
    const folderId = created?.type === 'project_created' ? created.projectId : ''
    const folder = await store.getProject(folderId)
    // A folder is a project row with no thread and no memory files.
    expect(folder).toMatchObject({ name: path.basename(folderPath), repoPaths: [folderPath] })
    expect(folder?.threadChatId).toBeUndefined()
    expect(readdirSync(memory)).toEqual([])
    const session = await store.createChat({ kind: 'project', projectId: folderId, mode: 'single' })

    await manor.handle({ type: 'remove_folder', projectId: folderId, requestId: 'remove' }, reply)
    expect(replies.at(-1)).toMatchObject({ type: 'ack', requestId: 'remove' })
    expect((await store.getProject(folderId))?.unlisted).toBe(true)
    expect(await store.getChat(session.id)).toMatchObject({ projectId: folderId })

    // The same folder again is the folder it was, listed again, not a second row.
    const rows = (await store.listProjects()).length
    await manor.handle({ type: 'add_folder', path: `${folderPath}/`, requestId: 'again' }, reply)
    expect(replies.filter((message) => message.type === 'project_created').at(-1)).toMatchObject({ projectId: folderId, requestId: 'again' })
    expect((await store.listProjects()).length).toBe(rows)
    expect((await store.getProject(folderId))?.unlisted).toBeUndefined()

    // Promotion is the thread: the folder becomes a project and keeps its Session.
    await store.setProjectUnlisted(folderId, true)
    await manor.handle({ type: 'create_project_thread', projectId: folderId, requestId: 'promote' }, reply)
    const promoted = await store.getProject(folderId)
    expect(promoted?.threadChatId).toBeDefined()
    expect(promoted?.unlisted).toBeUndefined()
    expect(replies.at(-1)).toMatchObject({ type: 'ack', requestId: 'promote', workChatId: promoted?.threadChatId })
    expect(await store.getChat(session.id)).toMatchObject({ projectId: folderId })
    // A project is not a folder, so it cannot be removed as one.
    await manor.handle({ type: 'remove_folder', projectId: folderId, requestId: 'not-a-folder' }, reply)
    expect(replies.at(-1)).toMatchObject({ type: 'notice', kind: 'error', requestId: 'not-a-folder' })
    expect((await store.getProject(folderId))?.unlisted).toBeUndefined()

    await manor.handle({ type: 'add_folder', path: path.join(folderPath, 'missing'), requestId: 'missing' }, reply)
    expect(replies.at(-1)).toMatchObject({ type: 'notice', kind: 'error', requestId: 'missing' })
  })

  it('treats a symlinked folder as the folder it points at, and reads no project memory by its name', async () => {
    const store = createMemoryStore({ agents: roster })
    const memory = mkdtempSync(path.join(os.tmpdir(), 'manor-folder-memory-'))
    mkdirSync(path.join(memory, 'client'))
    writeFileSync(path.join(memory, 'client', 'MEMORY.md'), '- [Client](brief.md): the client project\n')
    const parent = mkdtempSync(path.join(os.tmpdir(), 'manor-folder-'))
    const folderPath = path.join(parent, 'Client')
    mkdirSync(folderPath)
    symlinkSync(folderPath, path.join(parent, 'alias'))
    const replies: ServerMessage[] = []
    const reply = (message: ServerMessage) => { replies.push(message) }
    const manor = new ManorService({
      store, agents: () => roster, setAgents: () => undefined, mcpServers: () => [], setMcpServers: () => undefined,
      resolveDriver: () => createMockDriver({ deltaDelayMs: 0 }), ensureScratchDir: scratchFor,
      structuredMemoryRoot: memory, broadcast: () => undefined,
    })
    const created = () => replies.filter((message) => message.type === 'project_created').at(-1)

    await manor.handle({ type: 'add_folder', path: folderPath, requestId: 'add' }, reply)
    const folderId = created()?.type === 'project_created' ? created()!.projectId : ''
    await manor.handle({ type: 'remove_folder', projectId: folderId, requestId: 'remove' }, reply)
    await manor.handle({ type: 'add_folder', path: path.join(parent, 'alias'), requestId: 'alias' }, reply)
    expect(created()).toMatchObject({ projectId: folderId, requestId: 'alias' })
    expect((await store.getProject(folderId))?.unlisted).toBeUndefined()

    // A folder named Client is not the Client project.
    await manor.handle({ type: 'get_project_memory', projectId: folderId, requestId: 'memory' }, reply)
    expect(replies.find((message) => message.type === 'project_memory')).toMatchObject({ files: [] })

    // Two clients adding one new folder at once find one row.
    const shared = path.join(parent, 'Shared')
    mkdirSync(shared)
    const rows = (await store.listProjects()).length
    await Promise.all([
      manor.handle({ type: 'add_folder', path: shared, requestId: 'desktop' }, reply),
      manor.handle({ type: 'add_folder', path: path.join(parent, '.', 'Shared'), requestId: 'phone' }, reply),
    ])
    const ids = replies.filter((message) => message.type === 'project_created' && (message.requestId === 'desktop' || message.requestId === 'phone'))
      .map((message) => message.type === 'project_created' ? message.projectId : '')
    expect(new Set(ids).size).toBe(1)
    expect((await store.listProjects()).length).toBe(rows + 1)
  })

  it('tells the new thread what to read and what the welcome holds', () => {
    const withFolder = welcomePrompt('Client work', ['/work/client'])
    expect(withFolder).toContain('/work/client')
    expect(withFolder).toContain('what you understood this project to be')
    expect(withFolder).toContain('start no work')
    expect(withFolder).toContain('Hi <first name> \u{1F44B}')
    const bare = welcomePrompt('Ideas', [])
    expect(bare).toContain('no folder yet')
    expect(bare).not.toContain('what you understood this project to be')
  })

  it('creates a project with the folders it was given', async () => {
    const store = createMemoryStore({ agents: roster })
    const vault = mkdtempSync(path.join(os.tmpdir(), 'manor-service-vault-'))
    const { manor, broadcast, replies, reply } = service(store)

    await manor.handle(
      {
        type: 'create_project',
        name: 'Client work',
        repoPaths: [`${repo}/`, vault],
        icon: 'briefcase',
        color: '#D08A3E',
      },
      reply,
    )

    const directory = lastDirectory(broadcast)
    if (directory?.type !== 'directory') throw new Error('expected a directory')
    const project = directory.projects.find((candidate) => candidate.name === 'Client work')
    expect(replies[0]).toEqual({ type: 'project_created', projectId: project?.id })
    // The paths are normalised on the way in, so the trailing slash is not stored.
    expect(project).toMatchObject({
      icon: 'briefcase',
      color: '#D08A3E',
      repoPaths: [repo, vault],
    })
  })

  it('creates nothing when a folder is unusable, so the name can be sent again', async () => {
    const store = createMemoryStore({ agents: roster })
    const before = await store.listProjects()
    const { manor, broadcast, replies, reply } = service(store)

    await manor.handle({ type: 'create_project', name: 'Client work', repoPaths: ['Ontwikkeling/Manor'] }, reply)

    const notice = replies.at(0)
    expect(notice?.type).toBe('notice')
    expect(notice?.type === 'notice' ? notice.text : '').toContain('is not an absolute path')
    // No half-made project to clean up before retrying, and no directory to redraw.
    expect(await store.listProjects()).toEqual(before)
    expect(broadcast).toHaveLength(0)
  })

  it('still creates a project without a folder, which is the common case', async () => {
    const store = createMemoryStore({ agents: roster })
    const { manor, broadcast, replies, reply } = service(store)

    await manor.handle({ type: 'create_project', name: 'Life admin', repoPaths: [] }, reply)

    const directory = lastDirectory(broadcast)
    if (directory?.type !== 'directory') throw new Error('expected a directory')
    const project = directory.projects.find((candidate) => candidate.name === 'Life admin')
    expect(replies[0]).toEqual({ type: 'project_created', projectId: project?.id })
    expect(replies[1]).toMatchObject({ type: 'notice', kind: 'error', text: expect.stringContaining('a memory folder') })
    expect(project?.threadChatId).toBeUndefined()
    // No folders means an empty list, which is the one representation of "none".
    expect(project?.repoPaths).toEqual([])
  })

  it('returns each concurrent creator only its own exact project id', async () => {
    const store = createMemoryStore({ agents: roster })
    const { manor, broadcast } = service(store)
    const firstReplies: ServerMessage[] = []
    const secondReplies: ServerMessage[] = []

    await manor.handle(
      { type: 'create_project', name: 'First room', repoPaths: [], requestId: 'create-first' },
      (message) => firstReplies.push(message),
    )
    await manor.handle(
      { type: 'create_project', name: 'Second room', repoPaths: [], requestId: 'create-second' },
      (message) => secondReplies.push(message),
    )

    const projects = await store.listProjects()
    const first = projects.find((project) => project.name === 'First room')
    const second = projects.find((project) => project.name === 'Second room')
    expect(firstReplies.filter((row) => row.type !== 'notice')).toEqual([
      { type: 'project_created', projectId: first?.id, requestId: 'create-first' },
      { type: 'ack', requestId: 'create-first' },
    ])
    expect(secondReplies.filter((row) => row.type !== 'notice')).toEqual([
      { type: 'project_created', projectId: second?.id, requestId: 'create-second' },
      { type: 'ack', requestId: 'create-second' },
    ])
    expect(first?.id).not.toBe(second?.id)
    expect(broadcast).toHaveLength(2)
    expect(broadcast.every((message) => message.type === 'directory')).toBe(true)
  })
})

describe('ManorService, chat overrides', () => {
  it('broadcasts a pin to everyone and hands it back in the snapshot', async () => {
    const store = createMemoryStore({ agents: roster })
    const { chatId, projectId } = await seededChat(store)
    const { manor, broadcast, replies, reply } = service(store)

    await manor.handle(
      { type: 'set_chat_override', chatId, agentId: 'sage', override: { model: 'claude-sonnet-5', effort: 'low' } },
      reply,
    )

    // Chat state goes to every client, exactly like the events it sits beside.
    expect(broadcast.at(-1)).toEqual({
      type: 'chat_overrides',
      chatId,
      perAgent: { sage: { model: 'claude-sonnet-5', effort: 'low' } },
    })

    await manor.handle({ type: 'open_chat', chatId }, reply)
    const snapshot = replies.at(-1)
    if (snapshot?.type !== 'snapshot') throw new Error('expected a snapshot')
    expect(snapshot.overrides).toEqual({ sage: { model: 'claude-sonnet-5', effort: 'low' } })

    // Clearing is the same move with nothing in it, and the snapshot drops the field.
    await manor.handle({ type: 'set_chat_override', chatId, agentId: 'sage', override: {} }, reply)
    expect(broadcast.at(-1)).toEqual({ type: 'chat_overrides', chatId, perAgent: {} })
    await manor.handle({ type: 'open_chat', chatId }, reply)
    const cleared = replies.at(-1)
    if (cleared?.type !== 'snapshot') throw new Error('expected a snapshot')
    expect(cleared.overrides).toBeUndefined()
  })

  it('resumes a session on the provider that minted it, and never on another', async () => {
    const store = createMemoryStore({ agents: roster })
    const { chatId } = await seededChat(store)
    const seen: TurnInput[] = []
    const { manor, reply } = service(store, recording(createMockDriver({ deltaDelayMs: 0 }), seen))

    // One real turn first, so there is a session she actually holds and a cursor to
    // read the thread from. A first turn is a full catch-up whatever the pin says.
    await manor.handle({ type: 'send_message', chatId, text: '@Sage one' }, reply)
    expect(await store.getSessions(chatId, 'sage')).toEqual([{
      sessionId: `mock-${chatId}-sage`,
      driver: 'mock',
      seededThroughEventId: 'evt_000001',
    }])

    // A model pin is answered on the same CLI, so the conversation it holds is resumed
    // and she is handed only what has happened since.
    await manor.handle(
      { type: 'set_chat_override', chatId, agentId: 'sage', override: { model: 'claude-sonnet-5' } },
      reply,
    )
    await manor.handle({ type: 'send_message', chatId, text: '@Sage two' }, reply)
    expect(seen[1]?.sessionId).toBe(`mock-${chatId}-sage`)
    expect(seen[1]?.isFullCatchUp).toBe(false)

    // A provider pin is not. Claude holds no session of hers yet, so it starts one from
    // the whole thread, and the mock's row stays for a switch back.
    await manor.handle({ type: 'set_chat_override', chatId, agentId: 'sage', override: { driver: 'claude' } }, reply)
    await manor.handle({ type: 'send_message', chatId, text: '@Sage three' }, reply)
    expect(seen[2]?.sessionId).toBeUndefined()
    expect(seen[2]?.isFullCatchUp).toBe(true)
    expect((await store.getSessions(chatId, 'sage')).map((held) => held.driver)).toEqual(['claude', 'mock'])
  })

  it('does not resume across a switch made while the previous turn was still running', async () => {
    // The picker stays live during a turn. An invalidating delete in the handler was
    // the first design and lost this race: the turn that finished afterwards wrote its
    // own session id back over the delete, and the next turn resumed the wrong CLI.
    const { driver, gates, forChat } = gated()
    const store = createMemoryStore({ agents: roster })
    const { chatId } = await seededChat(store)
    const { manor, reply } = service(store, driver)

    const running = manor.handle({ type: 'send_message', chatId, text: '@Sage go' }, reply)
    await until(() => forChat(chatId).length === 1, "Sage's turn to start")

    // Switched mid-turn, then the turn lands and stores the session it just used.
    await manor.handle({ type: 'set_chat_override', chatId, agentId: 'sage', override: { driver: 'codex' } }, reply)
    gates[0]?.finish()
    await running
    expect(await sessionIdIn(store, chatId, 'sage')).toBe(`session-${chatId}-sage`)

    // Written by the mock, read by Codex: the ids do not match up, so nothing is resumed.
    const seen: TurnInput[] = []
    const { manor: after } = service(store, recording(createMockDriver({ deltaDelayMs: 0 }), seen))
    await after.handle({ type: 'send_message', chatId, text: '@Sage again' }, reply)
    expect(seen[0]?.sessionId).toBeUndefined()
    expect(seen[0]?.isFullCatchUp).toBe(true)
  })

  it('does not resume after the persona herself is moved to another provider', async () => {
    // The second way the effective provider moves, and the one no pin knows about: an
    // edit to her roster row changes every chat she has at once.
    const store = createMemoryStore({ agents: roster })
    const { chatId } = await seededChat(store)
    const seen: TurnInput[] = []
    const { manor, reply } = service(store, recording(createMockDriver({ deltaDelayMs: 0 }), seen))

    await manor.handle({ type: 'send_message', chatId, text: '@Sage one' }, reply)
    await manor.handle({ type: 'save_agent', agent: { ...sage, driver: 'codex', placement: 'session' } }, reply)
    await manor.handle({ type: 'send_message', chatId, text: '@Sage two' }, reply)

    expect(seen[1]?.agent.driver).toBe('codex')
    expect(seen[1]?.sessionId).toBeUndefined()
    expect(seen[1]?.isFullCatchUp).toBe(true)
  })

  it('does not resume a session whose provider nothing can vouch for', async () => {
    // Unknown provenance is a mismatch, not permission: the id may have been minted by
    // a CLI the pair has since been moved off. The live rows that predated the column
    // were backfilled from the roster driver, so this is the shape of a row that
    // somehow still has none rather than a state anything reaches on purpose.
    const store = createMemoryStore({ agents: roster })
    const { chatId } = await seededChat(store)
    const seen: TurnInput[] = []
    const { manor, reply } = service(store, recording(createMockDriver({ deltaDelayMs: 0 }), seen))
    await manor.handle({ type: 'send_message', chatId, text: '@Sage one' }, reply)
    await store.clearSession(chatId, 'sage')
    await store.setSession(chatId, 'sage', 'session-of-unknown-provenance')

    await manor.handle({ type: 'send_message', chatId, text: '@Sage two' }, reply)
    expect(seen[1]?.sessionId).toBeUndefined()
    expect(seen[1]?.isFullCatchUp).toBe(true)
    // And the turn that follows it is resumable again, so the replay is paid once.
    await manor.handle({ type: 'send_message', chatId, text: '@Sage three' }, reply)
    expect(seen[2]?.sessionId).toBe(`mock-${chatId}-sage`)
  })

  it('leaves a pin naming the provider she has since been given as her default', async () => {
    // Reachable only through a roster edit made after the pin, and nothing
    // re-normalises it on its own: the pin would go on suppressing her roster model
    // while reading, in the menu, as both the selection and the default.
    const store = createMemoryStore({ agents: roster })
    const { chatId } = await seededChat(store)
    const seen: TurnInput[] = []
    const { manor, reply } = service(store, recording(createMockDriver({ deltaDelayMs: 0 }), seen))

    await manor.handle({ type: 'set_chat_override', chatId, agentId: 'sage', override: { driver: 'codex' } }, reply)
    await manor.handle(
      { type: 'save_agent', agent: { ...sage, driver: 'codex', model: 'gpt-5.6-sol', placement: 'session' } },
      reply,
    )
    await manor.handle({ type: 'send_message', chatId, text: '@Sage hello' }, reply)

    // Her own model, not the provider default a pin that no longer differs would force.
    expect(seen[0]?.agent.driver).toBe('codex')
    expect(seen[0]?.agent.model).toBe('gpt-5.6-sol')
  })

  it('runs the turn on the pinned provider default, not the roster model', async () => {
    const store = createMemoryStore({ agents: roster })
    const { chatId } = await seededChat(store)
    const seen: TurnInput[] = []
    const { manor, reply } = service(store, recording(createMockDriver({ deltaDelayMs: 0 }), seen))

    await manor.handle(
      { type: 'set_chat_override', chatId, agentId: 'sage', override: { model: 'claude-sonnet-5' } },
      reply,
    )
    await manor.handle({ type: 'set_chat_override', chatId, agentId: 'sage', override: { driver: 'codex' } }, reply)
    await manor.handle({ type: 'send_message', chatId, text: '@Sage hello' }, reply)

    // The provider is what the driver is resolved from, and the Claude model id that
    // came before it does not travel: Codex has never heard of it.
    expect(seen[0]?.agent.driver).toBe('codex')
    expect(seen[0]?.agent.model).toBeUndefined()
  })

  it('applies pins picked before the chat existed to its very first turn', async () => {
    const store = createMemoryStore({ agents: roster })
    const project = await store.createProject('Pinned from the start')
    const seen: TurnInput[] = []
    const { manor, replies, reply } = service(store, recording(createMockDriver({ deltaDelayMs: 0 }), seen))

    await manor.handle(
      {
        type: 'create_chat',
        projectId: project.id,
        overrides: { sage: { model: 'claude-sonnet-5', effort: 'low' } },
        openingMessage: { text: '@Sage quick one' },
      },
      reply,
    )

    // The opening turn is the one that must not run on the roster default: the
    // composer showed Sonnet before the chat had an id to pin it to.
    expect(seen[0]?.agent.id).toBe('sage')
    expect(seen[0]?.agent.model).toBe('claude-sonnet-5')
    expect(seen[0]?.agent.effort).toBe('low')

    const chat = (await store.listChats()).find((candidate) => candidate.projectId === project.id)
    if (chat === undefined) throw new Error('expected a chat')
    await manor.handle({ type: 'open_chat', chatId: chat.id }, reply)
    const snapshot = replies.at(-1)
    if (snapshot?.type !== 'snapshot') throw new Error('expected a snapshot')
    expect(snapshot.overrides).toEqual({ sage: { model: 'claude-sonnet-5', effort: 'low' } })
  })

  /**
   * A pin is a row now, so unlike the old Map write it can fail — and it fails inside
   * `create_chat`, upstream of both the acknowledgement and the opening message. The
   * chat is what was asked for; a refused pin must not swallow it or the first thing
   * The user typed into it.
   */
  it('a pin the store refuses costs the pin, not the chat or its opening message', async () => {
    const store = createMemoryStore({ agents: roster })
    const project = await store.createProject('Pin refused')
    const seen: TurnInput[] = []
    const refusing: Store = {
      ...store,
      setChatOverride: () => Promise.reject(new Error('the store lost the connection')),
    }
    const { manor, replies, reply } = service(refusing, recording(createMockDriver({ deltaDelayMs: 0 }), seen))

    await manor.handle(
      {
        type: 'create_chat',
        projectId: project.id,
        overrides: { sage: { effort: 'low' } },
        openingMessage: { text: '@Sage quick one' },
        requestId: 'pin-refused',
      },
      reply,
    )

    expect(replies.map((message) => message.type)).toEqual(['notice', 'chat_created', 'ack'])
    expect(replies.at(0)).toEqual({
      type: 'notice',
      kind: 'error',
      text: 'That chat was made, but its model pin was not saved: the store lost the connection.',
    })
    expect(replies.at(1)).toMatchObject({ type: 'chat_created', requestId: 'pin-refused' })
    // The turn ran, on Sage's own settings, and the transcript has the message in it.
    expect(seen[0]?.agent.effort).toBe('high')
    const chat = (await store.listChats()).find((candidate) => candidate.projectId === project.id)
    if (chat === undefined) throw new Error('expected a chat')
    const said = (await store.loadEvents(chat.id)).filter((event) => event.type === 'user_message')
    expect(said).toHaveLength(1)
  })

  it('drops a pin for a persona who left the roster rather than losing the chat', async () => {
    const store = createMemoryStore({ agents: roster })
    const project = await store.createProject('Stale pin')
    const seen: TurnInput[] = []
    const { manor, replies, reply } = service(store, recording(createMockDriver({ deltaDelayMs: 0 }), seen))

    await manor.handle(
      {
        type: 'create_chat',
        projectId: project.id,
        overrides: { ghost: { effort: 'low' }, sage: { effort: 'max' } },
        openingMessage: { text: '@Sage hello' },
      },
      reply,
    )

    expect(replies.at(0)).toMatchObject({ type: 'chat_created' })
    expect(seen[0]?.agent.effort).toBe('max')
    const chat = (await store.listChats()).find((candidate) => candidate.projectId === project.id)
    if (chat === undefined) throw new Error('expected a chat')
    await manor.handle({ type: 'open_chat', chatId: chat.id }, reply)
    const snapshot = replies.at(-1)
    if (snapshot?.type !== 'snapshot') throw new Error('expected a snapshot')
    expect(snapshot.overrides).toEqual({ sage: { effort: 'max' } })
  })

  it('refuses a pin for a persona that is not on the roster', async () => {
    const store = createMemoryStore({ agents: roster })
    const { chatId, projectId } = await seededChat(store)
    const { manor, broadcast, replies, reply } = service(store)

    await manor.handle({ type: 'set_chat_override', chatId, agentId: 'ghost', override: { effort: 'low' } }, reply)

    expect(replies.at(-1)).toMatchObject({ type: 'notice', kind: 'error' })
    expect(broadcast.some((message) => message.type === 'chat_overrides')).toBe(false)
  })
})

describe('ManorService, the MCP registry', () => {
  const draft = {
    name: 'supabase',
    command: '/usr/bin/mcp-supabase',
    args: ['--read-only'],
    envKeys: ['SUPABASE_ACCESS_TOKEN'],
    description: 'Database.',
    writes: true,
    effectPolicy: 'confirm_writes' as const,
  }
  const probed = { tools: ['list_tables', 'execute_sql'], readOnlyTools: [], schemaChars: 17_731 }
  const probeOk = () => Promise.resolve(probed)

  const noticeIn = (messages: ServerMessage[]) =>
    messages.filter((message) => message.type === 'notice').at(-1)

  it('probes before it writes, and keeps what the probe learned', async () => {
    const store = createMemoryStore({ agents: roster })
    const seen: string[] = []
    const { manor, reply, replies, mcpServers } = service(store, undefined, undefined, (input) => {
      seen.push(input.name)
      return Promise.resolve(probed)
    })
    await manor.handle({ type: 'save_mcp_server', server: draft }, reply)
    expect(seen).toEqual(['supabase'])
    expect(noticeIn(replies)).toBeUndefined()
    expect(mcpServers()[0]).toMatchObject({ name: 'supabase', tools: probed.tools, schemaChars: 17_731 })
  })

  it('reports env presence and a real functional verification separately from process startup', async () => {
    const store = createMemoryStore({ agents: roster })
    const { manor } = service(store, undefined, undefined, () =>
      Promise.resolve({ ...probed, verifiedBy: 'get_profile' }),
    )
    await manor.handle({ type: 'save_mcp_server', server: draft }, () => undefined)

    const status = manor.mcpHostStatuses()
    expect(status).toMatchObject({
      type: 'mcp_host_statuses',
      statuses: [
        {
          env: [{ key: 'SUPABASE_ACCESS_TOKEN', present: true }],
          check: { result: 'verified', tool: 'get_profile' },
        },
      ],
    })
    expect(ServerMessageSchema.parse(status)).toBeTruthy()
  })

  it('refreshes the saved read-only boundary when a server tests successfully', async () => {
    const store = createMemoryStore({ agents: roster })
    let probes = 0
    const { manor, replies, reply, mcpServers } = service(store, undefined, undefined, () => {
      probes += 1
      return Promise.resolve({
        ...probed,
        readOnlyTools: probes === 1 ? [] : ['list_tables'],
        verifiedBy: 'get_profile',
      })
    })
    await manor.handle({ type: 'save_mcp_server', server: draft }, reply)
    const saved = mcpServers()[0]
    if (saved === undefined) throw new Error('expected saved MCP server')

    await manor.handle({ type: 'verify_mcp_server', serverId: saved.id }, reply)

    expect(probes).toBe(2)
    expect(noticeIn(replies)).toMatchObject({ kind: 'info', text: 'supabase verified through get_profile.' })
    expect(await store.listMcpServers()).toMatchObject([{ readOnlyTools: ['list_tables'] }])
  })

  it('writes nothing when the server does not start, and says why', async () => {
    const store = createMemoryStore({ agents: roster })
    const { manor, reply, replies, mcpServers } = service(store, undefined, undefined, () =>
      Promise.reject(new Error('no value for SUPABASE_ACCESS_TOKEN')),
    )
    await manor.handle({ type: 'save_mcp_server', server: draft }, reply)
    expect(noticeIn(replies)).toMatchObject({ kind: 'error' })
    expect(noticeIn(replies)?.text).toContain('SUPABASE_ACCESS_TOKEN')
    expect(mcpServers()).toEqual([])
    expect(await store.listMcpServers()).toEqual([])
  })

  it('accepts an HTTP server with a url and no command', async () => {
    const store = createMemoryStore({ agents: roster })
    const { manor, reply, mcpServers } = service(store, undefined, undefined, probeOk)
    await manor.handle(
      { type: 'save_mcp_server', server: { ...draft, command: '', args: [], envKeys: [], url: 'http://127.0.0.1:3845/mcp' } },
      reply,
    )
    expect(mcpServers()[0]).toMatchObject({ name: 'supabase', url: 'http://127.0.0.1:3845/mcp', command: '' })
  })

  it('refuses a server with both a command and a URL', async () => {
    const store = createMemoryStore({ agents: roster })
    const { manor, reply, replies, mcpServers } = service(store, undefined, undefined, probeOk)
    await manor.handle(
      { type: 'save_mcp_server', server: { ...draft, url: 'http://127.0.0.1:3845/mcp' } },
      reply,
    )
    expect(noticeIn(replies)?.text).toContain('not both')
    expect(mcpServers()).toEqual([])
  })

  it('refuses credentials inside an HTTP URL', async () => {
    const store = createMemoryStore({ agents: roster })
    const { manor, reply, replies, mcpServers } = service(store, undefined, undefined, probeOk)
    await manor.handle(
      {
        type: 'save_mcp_server',
        server: { ...draft, command: '', url: 'https://user:secret@mcp.example.com/mcp' },
      },
      reply,
    )
    expect(noticeIn(replies)?.text).toContain('credentials in the URL')
    expect(noticeIn(replies)?.text).not.toContain('secret')
    expect(mcpServers()).toEqual([])
  })

  it('refuses a name that could not survive the mcp__<name>__ prefix', async () => {
    const store = createMemoryStore({ agents: roster })
    const { manor, reply, replies, mcpServers } = service(store, undefined, undefined, probeOk)
    await manor.handle({ type: 'save_mcp_server', server: { ...draft, name: 'Supa Base' } }, reply)
    expect(noticeIn(replies)?.text).toContain('mcp__<name>__')
    expect(mcpServers()).toEqual([])
  })

  it('refuses a pasted credential where a variable name belongs', async () => {
    const store = createMemoryStore({ agents: roster })
    const { manor, reply, replies } = service(store, undefined, undefined, probeOk)
    const server = { ...draft, envKeys: ['SUPABASE_ACCESS_TOKEN=sbp_live_value'] }
    await manor.handle({ type: 'save_mcp_server', server }, reply)
    expect(noticeIn(replies)?.text).toContain('is not a variable name')
    // The message must not echo the thing it just refused to store.
    expect(noticeIn(replies)?.text).not.toContain('sbp_live_value')
  })

  it('refuses a second server with a name already taken', async () => {
    const store = createMemoryStore({ agents: roster })
    const { manor, reply, replies, mcpServers } = service(store, undefined, undefined, probeOk)
    await manor.handle({ type: 'save_mcp_server', server: draft }, reply)
    await manor.handle({ type: 'save_mcp_server', server: draft }, reply)
    expect(noticeIn(replies)?.text).toContain('already a server called supabase')
    expect(mcpServers()).toHaveLength(1)
  })

  it.each(['browser', 'artifacts', 'routines', 'work'])('refuses the Manor built-in name %s', async (name) => {
    const store = createMemoryStore({ agents: roster })
    const { manor, reply, replies, mcpServers } = service(store, undefined, undefined, probeOk)
    // The built-in browser is attached after the registry, so this would not read as
    // a collision: on Claude it silently overwrites the row in `--mcp-config`, and on
    // Codex the two become one duplicate key in an inline table.
    await manor.handle({ type: 'save_mcp_server', server: { ...draft, name } }, reply)
    expect(noticeIn(replies)?.text).toContain('Manor built-in server')
    expect(mcpServers()).toEqual([])
  })

  it('broadcasts the registry after a write so every client sees it', async () => {
    const store = createMemoryStore({ agents: roster })
    const { manor, reply, broadcast } = service(store, undefined, undefined, probeOk)
    await manor.handle({ type: 'save_mcp_server', server: draft }, reply)
    const sent = broadcast.filter((message) => message.type === 'mcp_servers').at(-1)
    expect(sent).toMatchObject({ type: 'mcp_servers' })
    expect(ServerMessageSchema.parse(sent)).toBeTruthy()
  })

  it('detaches a deleted server from the roster and re-sends both lists', async () => {
    const attached: AgentConfig[] = [
      { ...roster[0]!, mcpServers: [{ serverId: 'mcp_1', disabledTools: [] }] },
      ...roster.slice(1),
    ]
    const store = createMemoryStore({ agents: attached })
    const { manor, reply, broadcast, agents } = service(store, undefined, undefined, probeOk)
    await manor.handle({ type: 'save_mcp_server', server: draft }, reply)
    await manor.handle({ type: 'delete_mcp_server', serverId: 'mcp_1' }, reply)
    expect(agents()[0]?.mcpServers).toEqual([])
    expect(broadcast.filter((message) => message.type === 'roster').length).toBeGreaterThan(0)
    expect(broadcast.filter((message) => message.type === 'mcp_servers').length).toBeGreaterThan(1)
  })

  it('refuses to delete a server nobody registered', async () => {
    const store = createMemoryStore({ agents: roster })
    const { manor, reply, replies } = service(store, undefined, undefined, probeOk)
    await manor.handle({ type: 'delete_mcp_server', serverId: 'ghost' }, reply)
    expect(noticeIn(replies)?.text).toContain('not registered')
  })

  it('says so when this Manor cannot start servers at all', async () => {
    const store = createMemoryStore({ agents: roster })
    const { manor, reply, replies, mcpServers } = service(store)
    await manor.handle({ type: 'save_mcp_server', server: draft }, reply)
    expect(noticeIn(replies)?.kind).toBe('error')
    expect(mcpServers()).toEqual([])
  })
})

describe('the vault', () => {
  /** A scratch vault, never the user's real notes: these tests write. */
  const scratchVault = async (): Promise<Vault> => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'manor-knowledge-'))
    writeFileSync(path.join(root, 'today.md'), '# today\n', 'utf8')
    const opened = await openVault(root)
    if (!opened.ok) throw new Error(opened.message)
    return opened.vault
  }

  /**
   * The state on the VPS, and the one nobody exercises by accident on a laptop. Each
   * answer has to be a shaped one: a client that asks anyway must be able to tell
   * "there is no vault here" from "the note failed to load", and silence reads as the
   * second.
   */
  it('answers every request honestly on a machine with no vault', async () => {
    const { manor, replies, reply } = service(createMemoryStore())

    expect(manor.vaultStatus()).toEqual({ type: 'vault_status', available: false, name: null, root: null, trash: null })
    await manor.handle({ type: 'list_vault' }, reply)
    await manor.handle({ type: 'read_vault_file', path: 'today.md' }, reply)
    await manor.handle({ type: 'write_vault_file', path: 'today.md', content: 'x\n', baseRevision: null }, reply)
    await manor.handle({ type: 'create_vault_folder', path: 'Research' }, reply)
    await manor.handle({ type: 'rename_vault_file', requestId: 'rename-1', path: 'today.md', newPath: 'tomorrow.md', baseRevision: 'r1' }, reply)
    await manor.handle({ type: 'delete_vault_entry', requestId: 'delete-1', path: 'today.md' }, reply)

    expect(replies[0]).toEqual({ type: 'vault_files', files: [], truncated: false })
    expect(replies[1]).toMatchObject({ type: 'vault_file', result: { status: 'unavailable' } })
    // Not `unavailable`: a write has no such outcome, and reusing the read's word
    // here would put a message on the wire that fails the client's own schema.
    expect(replies[2]).toMatchObject({ type: 'vault_write', result: { status: 'rejected' } })
    expect(replies[3]).toMatchObject({ type: 'vault_folder_created', result: { status: 'rejected' } })
    expect(replies[4]).toMatchObject({ type: 'vault_renamed', requestId: 'rename-1', result: { status: 'rejected' } })
    expect(replies[5]).toMatchObject({ type: 'vault_deleted', requestId: 'delete-1', result: { status: 'rejected' } })
    for (const message of replies) expect(ServerMessageSchema.safeParse(message).success).toBe(true)
  })

  it('names the vault and round-trips a note through the socket protocol', async () => {
    const vault = await scratchVault()
    const { manor, replies, reply } = service(createMemoryStore(), undefined, undefined, undefined, vault)

    // The root travels too: it is what lets the note header hand out a path somebody
    // can paste into a terminal or an Obsidian link.
    expect(manor.vaultStatus()).toEqual({
      type: 'vault_status',
      available: true,
      name: vault.name,
      root: vault.root,
      trash: expect.stringMatching(/trash\/knowledge$/),
    })

    await manor.handle({ type: 'list_vault' }, reply)
    expect(replies[0]).toMatchObject({ type: 'vault_files', files: ['today.md'], folders: [], truncated: false })

    await manor.handle({ type: 'read_vault_file', path: 'today.md' }, reply)
    const read = replies[1]
    if (read?.type !== 'vault_file' || read.result.status !== 'ready') throw new Error('expected a readable note')

    await manor.handle(
      { type: 'write_vault_file', path: 'today.md', content: '# edited\n', baseRevision: read.result.revision ?? null },
      reply,
    )
    expect(replies[2]).toMatchObject({ type: 'vault_write', result: { status: 'saved' } })
    const saved = replies[2]
    if (saved?.type !== 'vault_write' || saved.result.status !== 'saved') throw new Error('expected saved note')
    await manor.handle({ type: 'rename_vault_file', requestId: 'rename-2', path: 'today.md', newPath: 'tomorrow.md', baseRevision: saved.result.revision }, reply)
    expect(replies[3]).toMatchObject({ type: 'vault_renamed', requestId: 'rename-2', path: 'today.md', newPath: 'tomorrow.md', result: { status: 'renamed' } })


    for (const message of replies) expect(ServerMessageSchema.safeParse(message).success).toBe(true)
  })

  it('tells every client about a new note or folder and a delete, and answers a refused delete to the asker only', async () => {
    const vault = await scratchVault()
    const { manor, broadcast, replies, reply } = service(createMemoryStore(), undefined, undefined, undefined, vault)
    const listed = () => broadcast.filter((message) => message.type === 'vault_files').at(-1)

    await manor.handle({ type: 'create_vault_folder', path: 'Research' }, reply)
    expect(listed()).toMatchObject({ folders: ['Research'] })
    await manor.handle({ type: 'write_vault_file', path: 'Research/idea.md', content: '', baseRevision: null }, reply)
    expect(listed()).toMatchObject({ files: ['Research/idea.md', 'today.md'] })

    await manor.handle({ type: 'delete_vault_entry', requestId: 'delete-2', path: 'Research' }, reply)
    expect(broadcast).toContainEqual(expect.objectContaining({ type: 'vault_deleted', requestId: 'delete-2', path: 'Research', result: expect.objectContaining({ status: 'deleted', kind: 'folder' }) }))
    expect(listed()).toMatchObject({ files: ['today.md'], folders: [] })

    const before = broadcast.length
    await manor.handle({ type: 'delete_vault_entry', requestId: 'delete-3', path: '../outside.md' }, reply)
    expect(broadcast.length).toBe(before)
    expect(replies.at(-1)).toMatchObject({ type: 'vault_deleted', requestId: 'delete-3', result: { status: 'rejected' } })
    for (const message of [...broadcast, ...replies]) expect(ServerMessageSchema.safeParse(message).success).toBe(true)
  })

  it('tells every client about a move, and answers a refused or same-folder move to the asker only', async () => {
    const vault = await scratchVault()
    const { manor, broadcast, replies, reply } = service(createMemoryStore(), undefined, undefined, undefined, vault)
    const listed = () => broadcast.filter((message) => message.type === 'vault_files').at(-1)
    await manor.handle({ type: 'create_vault_folder', path: 'Research' }, reply)

    await manor.handle({ type: 'move_vault_entry', requestId: 'move-1', path: 'today.md', folder: 'Research' }, reply)
    expect(broadcast).toContainEqual({ type: 'vault_moved', requestId: 'move-1', path: 'today.md', result: { status: 'moved', kind: 'note', newPath: 'Research/today.md' } })
    expect(listed()).toMatchObject({ files: ['Research/today.md'] })

    const before = broadcast.length
    await manor.handle({ type: 'move_vault_entry', requestId: 'move-2', path: 'Research/today.md', folder: 'Research' }, reply)
    expect(replies.at(-1)).toEqual({ type: 'vault_moved', requestId: 'move-2', path: 'Research/today.md', result: { status: 'moved', kind: 'note', newPath: 'Research/today.md' } })
    await manor.handle({ type: 'move_vault_entry', requestId: 'move-3', path: 'Research/today.md', folder: '../outside' }, reply)
    expect(replies.at(-1)).toMatchObject({ type: 'vault_moved', requestId: 'move-3', result: { status: 'rejected' } })
    expect(broadcast.length).toBe(before)
    for (const message of [...broadcast, ...replies]) expect(ServerMessageSchema.safeParse(message).success).toBe(true)
  })

  it('names a DM after the persona it is with, and never auto-titles it', async () => {
    // A DM's subject is the person, not the first thing said to them. `nameNewChat`
    // bows out on its own, because the title it guards against replacing is `New chat`.
    const store = createMemoryStore({ agents: roster })
    const named: string[] = []
    const { manor, broadcast, reply } = service(store, undefined, (chatId) => {
      named.push(chatId)
      return Promise.resolve('A title nobody asked for')
    })

    await manor.handle({ type: 'create_chat', kind: 'dm', memberIds: ['sage'] }, reply)
    const created = (await store.listChats()).find((chat) => chat.kind === 'dm')

    expect(created?.title).toBe('Sage')
    expect(created?.projectId).toBeNull()
    expect(lastDirectory(broadcast)?.type).toBe('directory')

    await manor.handle({ type: 'send_message', chatId: created?.id ?? '', text: 'hello there' }, reply)
    expect((await store.getChat(created?.id ?? ''))?.title).toBe('Sage')
    expect(named).toEqual([])
  })

  it('refuses a chat with a persona nobody has, and one the database would refuse', async () => {
    const store = createMemoryStore({ agents: roster })
    const { manor, replies, reply } = service(store)

    await manor.handle({ type: 'create_chat', kind: 'dm', memberIds: ['nobody'] }, reply)
    await manor.handle({ type: 'create_chat', kind: 'group', memberIds: ['sage'] }, reply)

    expect(replies.map((message) => (message.type === 'notice' ? message.text : message.type))).toEqual([
      'No such persona: nobody.',
      'That chat could not be made: a group chat needs at least two members.',
    ])
    expect((await store.listChats()).filter((chat) => chat.kind !== 'project')).toEqual([])
  })

  it('seats every chat persona in new and existing groups, and keeps Session personas out', async () => {
    const store = createMemoryStore({ agents: [...roster, { ...sage, id: 'wren', name: 'Wren', placement: 'session' }] })
    const { manor, replies, reply } = service(store)
    // A stale flag from an older client is dropped, not honoured: every chat agent is shared.
    await manor.handle({
      type: 'save_agent',
      agent: { ...sage, id: undefined, name: 'Watcher', character: 'You are Watcher.', ...{ dmOnly: true } },
    }, reply)

    await manor.handle({ type: 'create_chat', kind: 'group', memberIds: ['sage', 'watcher'] }, reply)
    const group = await store.createChat({ kind: 'group', memberIds: ['sage', 'smith'], title: 'House work' })
    await manor.handle({ type: 'set_chat_members', chatId: group.id, memberIds: ['sage', 'smith', 'watcher'] }, reply)
    await manor.handle({ type: 'set_chat_members', chatId: group.id, memberIds: ['sage', 'smith', 'watcher', 'wren'] }, reply)

    expect(replies.filter((message) => message.type === 'notice').map((message) => message.type === 'notice' ? message.text : '')).toEqual([
      'Only chat personas can join this conversation.',
    ])
    expect((await store.listChats()).some((chat) => chat.kind === 'group' && chat.memberIds.join() === 'sage,watcher')).toBe(true)
    expect((await store.getChat(group.id))?.memberIds).toEqual(['sage', 'smith', 'watcher'])
    expect((await store.loadRoster()).find((agent) => agent.id === 'watcher')).not.toHaveProperty('dmOnly')
  })

  it('edits a group\'s membership and refuses the edits that would break it', async () => {
    const store = createMemoryStore({ agents: roster })
    const { manor, broadcast, replies, reply } = service(store)
    const { chatId, projectId } = await seededChat(store)
    const group = await store.createChat({ kind: 'group', memberIds: ['sage', 'smith'] })

    await manor.handle({ type: 'set_chat_members', chatId: group.id, memberIds: ['sage', 'nobody'] }, reply)
    await manor.handle({ type: 'set_chat_members', chatId: group.id, memberIds: ['sage'] }, reply)
    await manor.handle({ type: 'set_chat_members', chatId, memberIds: ['sage', 'smith'] }, reply)

    expect(replies.map((message) => (message.type === 'notice' ? message.text : message.type))).toEqual([
      'No such persona: nobody.',
      'Those members could not be saved: a group chat needs at least two members.',
      'Those members could not be saved: only a group chat has an editable membership.',
    ])
    // Nothing was written and nothing was announced, so no client shows a group that
    // the next directory would take back.
    expect((await store.getChat(group.id))?.memberIds).toEqual(['sage', 'smith'])
    expect(lastDirectory(broadcast)).toBeUndefined()

    await manor.handle({ type: 'set_chat_members', chatId: group.id, memberIds: ['smith', 'sage'] }, reply)
    expect((await store.getChat(group.id))?.memberIds).toEqual(['smith', 'sage'])
    expect(lastDirectory(broadcast)?.type).toBe('directory')
  })
})

/** The routine draft the tests below send; the id is added when one is updating. */
const routineDraft = (projectId: string) => ({
  projectId,
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

const lastRoutines = (messages: ServerMessage[]) =>
  messages.filter((message) => message.type === 'routines').at(-1)

describe('request acknowledgement contract', () => {
  it('round-trips acknowledgements and notices with and without request ids', () => {
    const messages: ServerMessage[] = [
      { type: 'ack', requestId: 'request_1' },
      { type: 'project_created', projectId: 'project_1', requestId: 'request_1' },
      { type: 'notice', kind: 'error', text: 'No.', requestId: 'request_2' },
      { type: 'notice', kind: 'info', text: 'Still valid without an id.' },
    ]

    for (const message of messages) {
      expect(ServerMessageSchema.parse(JSON.parse(JSON.stringify(message)))).toEqual(message)
    }
    expect(ClientMessageSchema.parse({
      type: 'save_agent',
      agent: sage,
      requestId: 'request_3',
    })).toMatchObject({ requestId: 'request_3' })
  })

  it('acks every covered service mutation and ties a refusal to its request', async () => {
    const store = createMemoryStore({ agents: roster })
    const test = service(store, undefined, undefined, () => Promise.resolve({ tools: [], readOnlyTools: [], schemaChars: 0 }))
    const send = async (message: Parameters<typeof test.manor.handle>[0]) => {
      const before = test.replies.length
      await test.manor.handle(message, test.reply)
      return test.replies.slice(before)
    }
    const expectAck = (messages: ServerMessage[], requestId: string) =>
      expect(messages).toContainEqual({ type: 'ack', requestId })

    expectAck(await send({ type: 'create_project', name: 'Acks', repoPaths: [], requestId: 'project-create' }), 'project-create')
    const project = (await store.listProjects())[0]
    if (project === undefined) throw new Error('expected project')
    expectAck(await send({
      type: 'update_project',
      projectId: project.id,
      name: 'Acks renamed',
      repoPaths: [],
      requestId: 'project-update',
    }), 'project-update')
    expectAck(await send({
      type: 'create_chat',
      kind: 'group',
      memberIds: ['sage', 'smith'],
      requestId: 'group-create',
    }), 'group-create')
    const group = (await store.listChats()).find((chat) => chat.kind === 'group')
    if (group === undefined) throw new Error('expected group')
    expectAck(await send({
      type: 'set_chat_override',
      chatId: group.id,
      agentId: 'sage',
      override: { effort: 'low' },
      requestId: 'override-save',
    }), 'override-save')
    expectAck(await send({
      type: 'save_agent',
      agent: { ...sage, description: 'Changed.' },
      requestId: 'agent-save',
    }), 'agent-save')

    const mcp = {
      name: 'ack-server',
      command: '/usr/bin/true',
      args: [],
      envKeys: [],
      description: 'Test.',
      writes: false,
      effectPolicy: 'confirm_writes' as const,
    }
    expectAck(await send({ type: 'save_mcp_server', server: mcp, requestId: 'mcp-save' }), 'mcp-save')
    const serverId = test.mcpServers()[0]?.id
    if (serverId === undefined) throw new Error('expected MCP server')
    expectAck(await send({ type: 'verify_mcp_server', serverId, requestId: 'mcp-verify' }), 'mcp-verify')
    expectAck(await send({ type: 'delete_mcp_server', serverId, requestId: 'mcp-delete' }), 'mcp-delete')

    expectAck(await send({
      type: 'save_routine',
      routine: routineDraft(project.id),
      requestId: 'routine-save',
    }), 'routine-save')
    const routineId = (await store.listRoutines())[0]?.id
    if (routineId === undefined) throw new Error('expected routine')
    expectAck(await send({ type: 'delete_routine', routineId, requestId: 'routine-delete' }), 'routine-delete')
    expectAck(await send({ type: 'delete_agent', agentId: 'smith', requestId: 'agent-delete' }), 'agent-delete')
    expectAck(await send({ type: 'delete_project', projectId: project.id, requestId: 'project-delete' }), 'project-delete')

    expect(await send({ type: 'create_project', name: '  ', repoPaths: [], requestId: 'project-refused' }))
      .toContainEqual({ type: 'notice', kind: 'error', text: 'A project needs a name.', requestId: 'project-refused' })
  })
})

describe('ManorService, routines', () => {
  it('converts a persona routine to single agent and back through the save command', async () => {
    const store = createMemoryStore({ agents: roster })
    const { projectId } = await seededChat(store)
    const { manor, reply } = service(store)
    const original = await store.saveRoutine(routineDraft(projectId))
    await manor.handle({ type: 'save_routine', routine: {
      ...original, agentId: '__single__', model: 'gpt-5.6-sol', effort: 'high',
    } }, reply)
    expect((await store.listRoutines())[0]).toMatchObject({ id: original.id, agentId: '__single__', model: 'gpt-5.6-sol' })
    const single = (await store.listRoutines())[0]!
    await manor.handle({ type: 'save_routine', routine: { ...single, projectId: null } }, reply)
    // A Single task saved without a project gets the home room.
    expect((await store.listRoutines())[0]).toMatchObject({ projectId: 'home', chatId: null, agentId: '__single__' })
    await manor.handle({ type: 'save_routine', routine: single }, reply)
    expect((await store.listRoutines())[0]).toMatchObject({ projectId })
    await manor.handle({ type: 'save_routine', routine: original }, reply)
    expect((await store.listRoutines())[0]).toMatchObject({ id: original.id, agentId: 'sage', model: null })
    const chatsBefore = await store.listChats()
    await expect(manor.handle({ type: 'save_routine', routine: {
      ...original, agentId: '__single__', projectId: null, chatId: routineDmTarget('__single__'),
    } }, reply)).rejects.toThrow('cannot target a direct message')
    expect(await store.listChats()).toEqual(chatsBefore)
    expect((await store.listRoutines())[0]).toMatchObject({ id: original.id, agentId: 'sage' })
  })

  it('saves a routine and pushes the whole list, the way roster does', async () => {
    const store = createMemoryStore({ agents: roster })
    const { chatId, projectId } = await seededChat(store)
    const { manor, broadcast, reply } = service(store)

    await manor.handle({ type: 'save_routine', routine: routineDraft(projectId) }, reply)

    const pushed = lastRoutines(broadcast)
    expect(pushed?.type === 'routines' && pushed.routines).toHaveLength(1)
    expect(pushed?.type === 'routines' && pushed.routines[0]).toMatchObject({
      name: 'Morning brief',
      agentId: 'sage',
      enabled: true,
    })
    // Armed by the store from the cron and the zone, never by the form.
    expect(pushed?.type === 'routines' && pushed.routines[0]?.nextRunAt).not.toBeNull()
  })

  it('resolves a new agent DM, saves that explicit target, and runs in the continuing chat', async () => {
    const store = createMemoryStore({ agents: roster })
    const { projectId } = await seededChat(store)
    const { manor, broadcast, replies, reply } = service(store)
    await manor.handle({
      type: 'save_agent',
      agent: {
        ...sage,
        id: undefined,
        name: 'Watcher',
        character: 'You are Watcher.',
      },
    }, reply)

    await manor.handle({
      type: 'save_routine',
      routine: {
        ...routineDraft(projectId),
        projectId: null,
        chatId: routineDmTarget('watcher'),
        agentId: 'watcher',
        name: 'Mention watch',
        model: null,
        effort: null,
      },
    }, reply)

    const dm = (await store.listChats()).find((chat) => chat.kind === 'dm' && chat.memberIds[0] === 'watcher')
    const routine = (await store.listRoutines())[0]
    expect(dm).toBeDefined()
    expect(routine).toMatchObject({ projectId: null, chatId: dm?.id, agentId: 'watcher' })
    expect(lastDirectory(broadcast)?.type).toBe('directory')

    await manor.handle({ type: 'run_routine_now', routineId: routine?.id ?? '' }, reply)

    expect(await store.listRuns(routine?.id ?? '')).toEqual([])
    expect((await store.loadEvents(dm?.id ?? ''))[0]).toMatchObject({
      type: 'user_message',
      source: 'routine',
      routineName: 'Mention watch',
    })

    await manor.handle({ type: 'get_routine_runs', routineId: routine?.id ?? '' }, reply)
    expect(replies.at(-1)).toMatchObject({
      type: 'routine_runs',
      routineId: routine?.id,
      chatId: dm?.id,
      runs: [{ chatId: dm?.id, startedAt: expect.any(Number), state: 'done' }],
    })
  })

  it('answers a project routine with its run threads, and refuses a missing one', async () => {
    const store = createMemoryStore({ agents: roster })
    const { projectId } = await seededChat(store)
    const projectRoutine = await store.saveRoutine(routineDraft(projectId))
    const run = await store.createChat({ projectId, kind: 'run', routineId: projectRoutine.id, title: 'Run' })
    const { manor, replies, reply } = service(store)

    await manor.handle({ type: 'get_routine_runs', routineId: projectRoutine.id }, reply)
    await manor.handle({ type: 'get_routine_runs', routineId: 'routine_gone' }, reply)

    expect(replies).toEqual([
      {
        type: 'routine_runs',
        routineId: projectRoutine.id,
        chatId: null,
        runs: [{ id: run.id, chatId: run.id, startedAt: run.createdAt, state: 'failed', result: null }],
      },
      { type: 'notice', kind: 'error', text: 'That routine is gone, so its history is unavailable.' },
    ])
  })

  it('marks runs read one routine at a time or all at once, telling clients only on a change', async () => {
    const store = createMemoryStore({ agents: roster })
    const { projectId } = await seededChat(store)
    const first = await store.saveRoutine(routineDraft(projectId))
    const second = await store.saveRoutine({ ...routineDraft(projectId), name: 'Second' })
    const unread = async (routineId: string, runId: string) => {
      const claimed = await store.claimRoutine(routineId, Date.now())
      await store.recordRoutineRun(routineId, {
        lease: claimed?.lease ?? 0, unreadRunId: runId, consecutiveFailures: 0,
        disabled: false, disabledReason: null, contextTokens: null,
      })
    }
    await unread(first.id, 'run_a')
    await unread(first.id, 'run_b')
    await unread(second.id, 'run_c')
    const { manor, broadcast, reply } = service(store)
    const unreadOf = async () => Object.fromEntries((await store.listRoutines()).map((routine) => [routine.name, routine.unreadRunIds]))

    await manor.handle({ type: 'mark_routine_runs_read', routineId: first.id, runIds: ['run_a'] }, reply)
    expect(await unreadOf()).toMatchObject({ [first.name]: ['run_b'], Second: ['run_c'] })
    const told = broadcast.length
    await manor.handle({ type: 'mark_routine_runs_read', routineId: first.id, runIds: ['run_a'] }, reply)
    expect(broadcast.length).toBe(told)

    await manor.handle({ type: 'mark_all_routine_runs_read' }, reply)
    expect(await unreadOf()).toMatchObject({ [first.name]: [], Second: [] })
    expect(broadcast.at(-1)).toMatchObject({ type: 'routines' })
  })

  it('gives any chat persona a project routine, and refuses runtime pins on DM routines', async () => {
    const store = createMemoryStore({ agents: roster })
    const { projectId } = await seededChat(store)
    const { manor, replies, reply } = service(store)
    await manor.handle({
      type: 'save_agent',
      agent: { ...sage, id: undefined, name: 'Watcher', character: 'You are Watcher.' },
    }, reply)

    await manor.handle({
      type: 'save_routine',
      routine: { ...routineDraft(projectId), agentId: 'watcher' },
    }, reply)
    await manor.handle({
      type: 'save_routine',
      routine: {
        ...routineDraft(projectId),
        projectId: null,
        chatId: routineDmTarget('watcher'),
        agentId: 'watcher',
        model: 'claude-opus-5',
      },
    }, reply)

    expect(replies.filter((message) => message.type === 'notice').map((message) => message.type === 'notice' ? message.text : '')).toEqual([
      'A DM routine uses the runtime already selected for that conversation.',
    ])
    expect((await store.listRoutines()).map((routine) => [routine.agentId, routine.projectId])).toEqual([['watcher', projectId]])
    expect((await store.listChats()).some((chat) => chat.kind === 'dm')).toBe(false)
  })

  it('removes and announces a DM routine when its conversation is deleted', async () => {
    const store = createMemoryStore({ agents: roster })
    const dm = await store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })
    await store.saveRoutine({
      ...routineDraft('unused'),
      projectId: null,
      chatId: dm.id,
    })
    const { manor, broadcast, reply } = service(store)

    await manor.handle({ type: 'delete_chat', chatId: dm.id }, reply)

    expect(await store.listRoutines()).toEqual([])
    expect(lastRoutines(broadcast)).toMatchObject({ type: 'routines', routines: [] })
  })

  it('refuses a routine with no room, no persona or an unreadable schedule, and writes nothing', async () => {
    const store = createMemoryStore({ agents: roster })
    const { chatId, projectId } = await seededChat(store)
    const { manor, broadcast, replies, reply } = service(store)

    await manor.handle(
      { type: 'save_routine', routine: { ...routineDraft(projectId), projectId: 'project_gone' } },
      reply,
    )
    await manor.handle({ type: 'save_routine', routine: { ...routineDraft(projectId), agentId: 'argus' } }, reply)
    await manor.handle({ type: 'save_routine', routine: { ...routineDraft(projectId), name: '  ' } }, reply)
    await manor.handle({ type: 'save_routine', routine: { ...routineDraft(projectId), cron: 'every tuesday' } }, reply)

    expect(replies.map((message) => (message.type === 'notice' ? message.text : message.type))).toEqual([
      'That room is gone, so there is nowhere to put the runs.',
      'There is no persona argus to give a routine to.',
      'A routine needs a name and a prompt.',
      'That schedule could not be read: "every tuesday" is not a cron expression.',
    ])
    expect(await store.listRoutines()).toEqual([])
    // Nothing was written, so nothing is announced: the list everyone else holds is
    // still true.
    expect(lastRoutines(broadcast)).toBeUndefined()
  })

  it('turns a routine off and on, and refuses one that is gone', async () => {
    const store = createMemoryStore({ agents: roster })
    const { chatId, projectId } = await seededChat(store)
    const saved = await store.saveRoutine(routineDraft(projectId))
    const { manor, broadcast, replies, reply } = service(store)

    await manor.handle({ type: 'set_routine_enabled', routineId: saved.id, enabled: false }, reply)

    const off = lastRoutines(broadcast)
    expect(off?.type === 'routines' && off.routines[0]).toMatchObject({ enabled: false, nextRunAt: null })

    await manor.handle({ type: 'set_routine_enabled', routineId: 'routine_gone', enabled: true }, reply)
    expect(replies.at(-1)).toMatchObject({ type: 'notice', text: 'That routine is gone, so there was nothing to change.' })
  })

  it('deletes a routine, stops its live run and announces both shorter indexes', async () => {
    const { driver, forChat } = gated()
    const store = createMemoryStore({ agents: roster })
    const { projectId } = await seededChat(store)
    const saved = await store.saveRoutine(routineDraft(projectId))
    const { manor, broadcast, reply } = service(store, driver)

    const running = manor.handle({ type: 'run_routine_now', routineId: saved.id }, reply)
    await until(
      () =>
        Boolean(
          lastDirectory(broadcast)?.type === 'directory' &&
            lastDirectory(broadcast)?.chats.some((chat) => chat.kind === 'run'),
        ),
      'the run chat to be announced',
    )
    const announced = lastDirectory(broadcast)
    const run = announced?.type === 'directory' ? announced.chats.find((chat) => chat.kind === 'run') : undefined
    if (run === undefined) throw new Error('expected a run')
    await until(() => forChat(run.id).length === 1, 'the routine turn to start')

    await manor.handle({ type: 'delete_routine', routineId: saved.id }, reply)
    forChat(run.id)[0]?.finish()
    await expect(running).resolves.toBeUndefined()

    const pushed = lastRoutines(broadcast)
    expect(pushed?.type === 'routines' && pushed.routines).toEqual([])
    const directory = lastDirectory(broadcast)
    expect(directory?.type === 'directory' && directory.chats.some((chat) => chat.id === run.id)).toBe(false)
    expect(await store.getChat(run.id)).toBeUndefined()
  })

  it('deleting an agent stops its live DM routine without reporting the DM as deleted', async () => {
    const { driver, forChat } = gated()
    const store = createMemoryStore({ agents: roster })
    const dm = await store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })
    const routine = await store.saveRoutine({
      ...routineDraft('unused'),
      projectId: null,
      chatId: dm.id,
    })
    const deleted: string[][] = []
    const { manor, reply } = service(
      store,
      driver,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (chatIds) => deleted.push([...chatIds]),
    )

    const running = manor.handle({ type: 'run_routine_now', routineId: routine.id }, reply)
    await until(() => forChat(dm.id).length === 1, 'the DM routine turn to start')

    await manor.handle({ type: 'delete_agent', agentId: 'sage' }, reply)
    await expect(running).resolves.toBeUndefined()

    expect(await store.getChat(dm.id)).toBeDefined()
    expect(await store.listRoutines()).toEqual([])
    expect(deleted).toEqual([[]])
    expect((await store.loadEvents(dm.id)).some((event) => event.type === 'turn_result')).toBe(false)
  })

  it('runs one by hand through the same seam the scheduler uses', async () => {
    const store = createMemoryStore({ agents: roster })
    const { projectId } = await seededChat(store)
    const saved = await store.saveRoutine(routineDraft(projectId))
    const { manor, broadcast, reply } = service(store)

    await manor.handle({ type: 'run_routine_now', routineId: saved.id }, reply)

    // The run made its own thread, in the routine's room, and nothing else did.
    const [run, ...rest] = await store.listRuns(saved.id)
    expect(rest).toEqual([])
    expect(run).toMatchObject({ kind: 'run', routineId: saved.id, projectId })
    // Born settled: this routine did not ask to be told, so its thread never enters
    // the inbox.
    expect(run?.settledAt).not.toBeNull()
    // An ordinary turn in it, announced as a routine rather than as the user.
    const events = await store.loadEvents(run?.id ?? '')
    expect(events[0]).toMatchObject({ type: 'user_message', source: 'routine', routineName: 'Morning brief' })
    expect(events.some((event) => event.type === 'turn_result' && event.agentId === 'sage')).toBe(true)
    // Counted like a scheduled run, because it went through the same path. The mock
    // declares no outcome, so the run did not claim its whole window and the
    // watermark holds.
    expect((await store.listRoutines())[0]).toMatchObject({ consecutiveFailures: 0, lastRunAt: null })
    expect(lastRoutines(broadcast)?.type).toBe('routines')
  })

  it('refuses a hand run of a routine that is off, or gone', async () => {
    const store = createMemoryStore({ agents: roster })
    const { chatId, projectId } = await seededChat(store)
    const saved = await store.saveRoutine({ ...routineDraft(projectId), enabled: false })
    const { manor, replies, reply } = service(store)

    await manor.handle({ type: 'run_routine_now', routineId: saved.id }, reply)
    await manor.handle({ type: 'run_routine_now', routineId: 'routine_gone', requestId: 'run-gone' }, reply)

    // A disabled routine carries no fire time, and the fire time is what the claim
    // compares on: without one a hand run could double up with a tick.
    expect(replies.map((message) => (message.type === 'notice' ? message.text : message.type))).toEqual([
      '"Morning brief" is off. Turn it on first, then run it.',
      'That routine is gone, so there was nothing to run.',
    ])
    expect(replies.at(-1)).toMatchObject({ type: 'notice', requestId: 'run-gone' })
    expect(await store.loadEvents(chatId)).toEqual([])
  })

  it('lets the active DM persona create and partially update only its own routines', async () => {
    const { driver, forChat } = gated()
    const store = createMemoryStore({ agents: roster })
    const { projectId } = await seededChat(store)
    const dm = await store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })
    const { manor, broadcast, reply } = service(store, driver)

    const turn = manor.handle({ type: 'send_message', chatId: dm.id, text: 'Make that a routine.' }, reply)
    await until(() => forChat(dm.id).length === 1, 'the DM turn to start')
    const started = broadcast.find(
      (message) => message.type === 'turn_state' && message.chatId === dm.id && message.state === 'running',
    )
    if (started?.type !== 'turn_state') throw new Error('expected the active DM turn')
    const context = { chatId: dm.id, agentId: 'sage', turnId: started.turnId }

    expect(await manor.useRoutineTool(context, 'routine_list')).toEqual({ routines: [] })
    const created = await manor.useRoutineTool(context, 'routine_save', {
      name: 'Slack catch-up',
      prompt: 'Check Slack for new mentions and draft replies.',
      cron: '1,31 8-19 * * 1-5',
    })
    expect(created).toMatchObject({ created: true, routine: { name: 'Slack catch-up' } })
    const [routine] = await store.listRoutines()
    if (routine === undefined) throw new Error('expected the DM routine')
    expect(routine).toMatchObject({
      projectId: null,
      chatId: dm.id,
      agentId: 'sage',
      description: '',
      timezone: 'Europe/Amsterdam',
      enabled: true,
      notify: false,
    })

    await manor.useRoutineTool(context, 'routine_save', { routineId: routine.id, cron: '0 * * * *' })
    expect((await store.listRoutines())[0]).toMatchObject({
      name: 'Slack catch-up',
      prompt: 'Check Slack for new mentions and draft replies.',
      cron: '0 * * * *',
    })
    const foreign = await store.saveRoutine(routineDraft(projectId))
    await expect(
      manor.useRoutineTool(context, 'routine_save', { routineId: foreign.id, enabled: false }),
    ).rejects.toThrow('does not belong to this direct message')
    expect(lastRoutines(broadcast)?.type).toBe('routines')

    forChat(dm.id)[0]?.finish()
    await turn
    await expect(manor.useRoutineTool(context, 'routine_list')).rejects.toThrow('no longer active')
  })

  it('opens the same side chat however often the rail item is clicked, and never broadcasts it', async () => {
    const store = createMemoryStore({ agents: cosRoster })
    const { chatId } = await seededChat(store)
    const { manor, broadcast, replies, reply } = service(store)
    const broadcastsBefore = broadcast.length

    await manor.handle({ type: 'open_side_chat', chatId }, reply)
    await manor.handle({ type: 'open_side_chat', chatId }, reply)

    const opened = replies.filter((message) => message.type === 'side_chat')
    expect(opened).toHaveLength(2)
    expect(opened[0]).toEqual({
      type: 'side_chat',
      parentChatId: chatId,
      chatId: opened[0]?.chatId,
      model: SIDE_CHAT_DEFAULTS.model,
      effort: SIDE_CHAT_DEFAULTS.effort,
    })
    expect(opened[1]?.chatId).toBe(opened[0]?.chatId)
    // A side chat is not part of the directory, so no other client has anything to update.
    expect(broadcast.length).toBe(broadcastsBefore)
  })

  it('starts a new side chat on a model still on when the default is turned off in Settings', async () => {
    const store = createMemoryStore({ agents: cosRoster })
    const { chatId } = await seededChat(store)
    const { manor, replies, reply } = service(store)

    await manor.handle({ type: 'save_house_settings', settings: { ...DEFAULT_HOUSE_SETTINGS, disabledModels: [SIDE_CHAT_DEFAULTS.model] } }, reply)
    await manor.handle({ type: 'open_side_chat', chatId }, reply)

    const opened = replies.find((message) => message.type === 'side_chat')
    const model = opened?.type === 'side_chat' ? opened.model : ''
    expect(model).not.toBe(SIDE_CHAT_DEFAULTS.model)
    expect(driverForModel(model)).toBe('claude')
    expect((await store.sideChatOf(chatId))?.sideModel).toBe(model)
  })

  it('leaves a side chat already open on the default when that model is turned off later', async () => {
    const store = createMemoryStore({ agents: cosRoster })
    const { chatId } = await seededChat(store)
    const { manor, replies, reply } = service(store)

    await manor.handle({ type: 'open_side_chat', chatId }, reply)
    await manor.handle({ type: 'save_house_settings', settings: { ...DEFAULT_HOUSE_SETTINGS, disabledModels: [SIDE_CHAT_DEFAULTS.model] } }, reply)
    await manor.handle({ type: 'open_side_chat', chatId }, reply)

    expect(replies.filter((message) => message.type === 'side_chat').at(-1)).toMatchObject({ model: SIDE_CHAT_DEFAULTS.model })
    expect((await store.sideChatOf(chatId))?.sideModel).toBeNull()
  })

  it('clears a side chat into a new thread on the same model, the old one deleted', async () => {
    const store = createMemoryStore({ agents: cosRoster })
    const { chatId } = await seededChat(store)
    const { manor, replies, reply } = service(store)

    await manor.handle({ type: 'open_side_chat', chatId }, reply)
    const first = replies.find((message) => message.type === 'side_chat')
    const oldId = first?.type === 'side_chat' ? first.chatId : ''
    await manor.handle({ type: 'set_side_runtime', chatId: oldId, model: SIDE_CHAT_DEFAULTS.model, effort: 'high' }, reply)
    await manor.handle({ type: 'open_side_chat', chatId, fresh: true }, reply)

    const cleared = replies.filter((message) => message.type === 'side_chat').at(-1)
    expect(cleared).toMatchObject({ type: 'side_chat', parentChatId: chatId, effort: 'high' })
    expect(cleared?.type === 'side_chat' && cleared.chatId).not.toBe(oldId)
    expect(await store.getChat(oldId)).toBeUndefined()
    expect((await store.sideChatOf(chatId))?.id).toBe(cleared?.type === 'side_chat' ? cleared.chatId : '')
  })

  it('refuses a panel on a panel, and one on a chat that is gone', async () => {
    const store = createMemoryStore({ agents: cosRoster })
    const { chatId } = await seededChat(store)
    const { manor, replies, reply } = service(store)

    await manor.handle({ type: 'open_side_chat', chatId }, reply)
    const side = replies.find((message) => message.type === 'side_chat')
    await manor.handle({ type: 'open_side_chat', chatId: side?.type === 'side_chat' ? side.chatId : '' }, reply)
    await manor.handle({ type: 'open_side_chat', chatId: 'chat_gone' }, reply)

    expect(replies.filter((message) => message.type === 'notice').map((message) => message.text)).toEqual([
      'A side chat has no side chat of its own.',
      'That chat no longer exists.',
    ])
  })

  it('refuses a model or provider pin on a side chat', async () => {
    // The panel runs on the subscription the main chat is not spending; a pin is
    // exactly what would move it onto the other one.
    const store = createMemoryStore({ agents: cosRoster })
    const { chatId } = await seededChat(store)
    const { manor, replies, reply } = service(store)
    await manor.handle({ type: 'open_side_chat', chatId }, reply)
    const opened = replies.find((message) => message.type === 'side_chat')
    const sideId = opened?.type === 'side_chat' ? opened.chatId : ''

    // Pinned for a real persona, because that is the only pin the store would even
    // take: the panel's voice is not on the roster at all.
    await manor.handle(
      { type: 'set_chat_override', chatId: sideId, agentId: 'sage', override: { model: 'claude-opus-5' } },
      reply,
    )

    expect(replies.filter((message) => message.type === 'notice').map((message) => message.text)).toEqual([
      'A side chat runs on its own model, so it takes no per-persona pin.',
    ])
    expect(await store.loadChatOverrides(sideId)).toEqual({})
  })

  it('takes the panel with the chat it hangs off, and stops what is running in it', async () => {
    const store = createMemoryStore({ agents: cosRoster })
    const { chatId } = await seededChat(store)
    const stopped: string[] = []
    const { driver, started } = endless(stopped)
    const { manor, replies, reply } = service(store, driver)
    await manor.handle({ type: 'open_side_chat', chatId }, reply)
    const opened = replies.find((message) => message.type === 'side_chat')
    const sideId = opened?.type === 'side_chat' ? opened.chatId : ''
    void manor.handle({ type: 'send_message', chatId: sideId, text: 'what does he mean?' }, reply)
    await until(() => started.length === 1, 'the side turn to start')

    await manor.handle({ type: 'delete_chat', chatId }, reply)

    // Its turn is stopped before the row cascades away under it. `toContain` rather
    // than an exact list: discarding a chat and tearing its runtime down both reach for
    // the handle, and stopping an already-stopped turn is a no-op by design.
    expect(stopped).toContain('aside')
    expect(await store.getChat(sideId)).toBeUndefined()
  })

  it('takes a model and effort for one panel, and refuses one no provider offers', async () => {
    const store = createMemoryStore({ agents: cosRoster })
    const { chatId } = await seededChat(store)
    const { manor, replies, reply } = service(store)
    await manor.handle({ type: 'open_side_chat', chatId }, reply)
    const opened = replies.find((message) => message.type === 'side_chat')
    const sideId = opened?.type === 'side_chat' ? opened.chatId : ''

    await manor.handle({ type: 'set_side_runtime', chatId: sideId, model: 'grok-4.6', effort: 'low' }, reply)
    await manor.handle({ type: 'set_side_runtime', chatId: sideId, model: 'gpt-9', effort: 'low' }, reply)
    // Only a side chat carries one; every other chat pins per persona.
    await manor.handle({ type: 'set_side_runtime', chatId, model: 'grok-4.6', effort: 'low' }, reply)

    expect((await store.getChat(sideId))?.sideModel).toBe('grok-4.6')
    expect((await store.getChat(sideId))?.sideEffort).toBe('low')
    expect(replies.filter((message) => message.type === 'notice').map((message) => message.text)).toEqual([
      'No installed provider offers gpt-9.',
      'Only a side chat carries its own model.',
    ])
  })
})
