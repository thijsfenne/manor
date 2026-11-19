import {
  DEFAULT_SUBAGENT_POLICY,
  SUBAGENT_VOICE,
  checkSubagentChoice,
  subagentChoices,
  type RuntimeEvent,
  type ServerMessage,
  type SubagentPolicy,
  type TurnInput,
} from '@manor/contracts'
import { describe, expect, it, vi } from 'vitest'
import { AsyncQueue } from '../src/asyncQueue.js'
import { SUBAGENT_REVIEW_RULE } from '../src/composer.js'
import { createMemoryStore } from '../src/stores/memoryStore.js'
import { Subagents, SubagentRefusal, childTools, subagentDirectory, type ParentWorkspace } from '../src/subagents.js'
import { smith } from './helpers.js'

const policy: SubagentPolicy = {
  models: ['gpt-6.1-sol', 'claude-sonnet-5-5', 'cursor-grok-4.6'],
  efforts: ['low', 'medium', 'high'],
  maxConcurrent: 2,
  allowNested: false,
  personas: { sage: { models: ['claude-sonnet-5-5'], efforts: ['low'] } },
}

describe('the subagent policy check', () => {
  it('allows a model and effort inside the global lists and names its provider', () => {
    expect(checkSubagentChoice(policy, 'smith', 'gpt-6.1-sol', 'high')).toEqual({ ok: true, driver: 'codex', effort: 'high' })
  })

  it('refuses per model, per effort, per model capability and per persona, each with a reason', () => {
    expect(checkSubagentChoice(policy, 'smith', 'claude-opus-5-5', 'high')).toEqual({ ok: false, reason: 'claude-opus-5-5 is not allowed for subagents in Settings.' })
    expect(checkSubagentChoice(policy, 'smith', 'gpt-9', 'high')).toEqual({ ok: false, reason: 'gpt-9 is not a model Manor runs.' })
    expect(checkSubagentChoice(policy, 'smith', 'gpt-6.1-sol', 'max')).toEqual({ ok: false, reason: 'max effort is not allowed for subagents in Settings.' })
    // Cursor Grok stops at Extra: a level the model would quietly lower is refused, not clamped.
    expect(checkSubagentChoice(policy, 'smith', 'cursor-grok-4.6', 'max')).toEqual({ ok: false, reason: 'cursor-grok-4.6 does not support max effort; it takes low, medium, high, xhigh.' })
    expect(checkSubagentChoice(policy, 'sage', 'gpt-6.1-sol', 'low')).toEqual({ ok: false, reason: "gpt-6.1-sol is not allowed for this agent's subagents." })
    expect(checkSubagentChoice(policy, 'sage', 'claude-sonnet-5-5', 'high')).toEqual({ ok: false, reason: "high effort is not allowed for this agent's subagents." })
    expect(checkSubagentChoice(policy, 'sage', 'claude-sonnet-5-5', 'low')).toMatchObject({ ok: true })
  })

  it('lists only combinations that survive every narrowing', () => {
    expect(subagentChoices(policy, 'smith').map(({ model, efforts }) => [model, efforts])).toEqual([
      ['claude-sonnet-5-5', ['low', 'medium', 'high']],
      ['gpt-6.1-sol', ['low', 'medium', 'high']],
      ['cursor-grok-4.6', ['low', 'medium', 'high']],
    ])
    expect(subagentChoices(policy, 'sage')).toEqual([{ driver: 'claude', model: 'claude-sonnet-5-5', label: 'Sonnet 5.5', efforts: ['low'] }])
    expect(subagentChoices({ ...policy, efforts: ['max'] }, 'smith').map((choice) => choice.model)).not.toContain('cursor-grok-4.6')
  })

  it('keeps a child within what its provider can hold it to', () => {
    expect(childTools(['Read', 'Edit', 'Task', 'Agent'], 'claude')).toEqual(['Read', 'Edit'])
    expect(childTools(['Read', 'Write'], 'codex')).toEqual([])
    expect(childTools(['Read', 'Bash'], 'cursor')).toEqual(['Bash'])
  })
})

/** A driver whose turns finish only when the test says so. */
function controllableDriver() {
  const turns: { input: TurnInput; queue: AsyncQueue<RuntimeEvent>; stop: ReturnType<typeof vi.fn> }[] = []
  return {
    turns,
    startTurn: (input: TurnInput) => {
      const queue = new AsyncQueue<RuntimeEvent>()
      const stop = vi.fn(() => queue.close())
      turns.push({ input, queue, stop })
      return { events: queue, stop }
    },
    answer(index: number, text: string) {
      const turn = turns[index]!
      turn.queue.push({ type: 'message', messageId: 'm1', text })
      turn.queue.push({ type: 'result', text, usage: { inputTokens: 100, outputTokens: 10 }, reportedModel: turn.input.agent.model ?? '' })
      turn.queue.close()
    },
  }
}

async function setup(options: {
  policy?: SubagentPolicy
  waitMs?: number
  parentEnded?: () => boolean
  nestedMcp?: ConstructorParameters<typeof Subagents>[0]['nestedMcp']
} = {}) {
  const store = createMemoryStore({ agents: [smith] })
  const parentChat = (await store.listChats())[0]!
  const driver = controllableDriver()
  const emitted: ServerMessage[] = []
  const changed = vi.fn()
  const workspace: ParentWorkspace = { agent: smith, cwd: '/scratch', repoPaths: ['/repo'] }
  const subagents = new Subagents({
    store,
    policy: () => options.policy ?? policy,
    parent: (context) => context.turnId === 'turn_1' && options.parentEnded?.() !== true ? workspace : undefined,
    agentName: (agentId) => (agentId === 'smith' ? 'Smith' : agentId),
    startTurn: driver.startTurn,
    append: async (chatId, draft) => { await store.appendEvent(chatId, draft) },
    emit: (message) => emitted.push(message),
    changed,
    ...(options.waitMs === undefined ? {} : { waitMs: options.waitMs }),
    ...(options.nestedMcp === undefined ? {} : { nestedMcp: options.nestedMcp }),
  })
  const context = { chatId: parentChat.id, agentId: 'smith', turnId: 'turn_1' }
  return { store, parentChat, driver, emitted, changed, subagents, context }
}

describe('a delegated child', () => {
  it('runs in its own thread on the chosen model with only the task, and reports back to the parent', async () => {
    const { store, parentChat, driver, subagents, context, emitted } = await setup()
    const pending = subagents.delegate(context, { task: 'Count the files. Report the number.', model: 'gpt-6.1-sol', effort: 'high', role: 'You are terse.' })
    await vi.waitFor(() => expect(driver.turns).toHaveLength(1))
    const { input } = driver.turns[0]!
    expect(input.agent).toMatchObject({ id: SUBAGENT_VOICE.id, driver: 'codex', model: 'gpt-6.1-sol', effort: 'high', memoryScope: false, allowedTools: ['Bash'] })
    expect(input.agent.character).toContain('Your role: You are terse.')
    expect(input.catchUp).toHaveLength(1)
    expect(input.catchUp[0]).toMatchObject({ text: 'Count the files. Report the number.' })
    expect(input).toMatchObject({ cwd: '/scratch', repoPaths: ['/repo'], infrastructure: true })
    expect(input.mcpServers).toBeUndefined()
    driver.answer(0, 'There are 4 files.')

    const report = await pending
    expect(report).toMatchObject({ status: 'done', result: 'There are 4 files.', model: 'gpt-6.1-sol', effort: 'high', title: 'Count the files' })
    const child = await store.getChat(report.taskId)
    expect(child).toMatchObject({
      kind: 'subagent', parentChatId: parentChat.id, title: 'Count the files',
      subagent: { agentId: 'smith', turnId: 'turn_1', driver: 'codex', model: 'gpt-6.1-sol', effort: 'high', role: 'You are terse.', state: 'done', depth: 1 },
    })
    const childEvents = await store.loadEvents(report.taskId)
    expect(childEvents.map((event) => event.type)).toEqual(['user_message', 'agent_message', 'turn_result'])
    expect(childEvents[0]).toMatchObject({ source: 'subagent_task', authorAgentId: 'smith' })
    const parentEvents = await store.loadEvents(parentChat.id)
    expect(parentEvents[0]).toMatchObject({
      type: 'tool_use', tool: 'spawn_subagent', turnId: 'turn_1',
      subagent: { model: 'gpt-6.1-sol', effort: 'high', childChatId: report.taskId, role: 'You are terse.' },
    })
    expect(parentEvents.at(-1)).toMatchObject({ type: 'tool_result', outcome: 'success', output: 'There are 4 files.', usage: { inputTokens: 100 } })
    expect(emitted.filter((message) => message.type === 'turn_state').map((message) => message.type === 'turn_state' && message.state)).toEqual(['running', 'done'])
  })

  it('starts without waiting, outlives the turn that started it, and is collected from a later turn', async () => {
    let ended = false
    const { driver, subagents, context, store } = await setup({ parentEnded: () => ended })
    const started = await subagents.delegate(context, { task: 'Summarise the plan.', model: 'claude-sonnet-5-5', effort: 'low', wait: false })
    expect(started).toMatchObject({ status: 'running' })
    ended = true
    const later = { ...context, turnId: 'turn_2' }
    await expect(subagents.result(later, started.taskId, false)).resolves.toMatchObject({ status: 'running' })
    driver.answer(0, 'Plan in one line.')
    await expect(subagents.result(later, started.taskId)).resolves.toMatchObject({ status: 'done', result: 'Plan in one line.' })
    // Settled and no longer live: read back from the store.
    await expect(subagents.result(later, started.taskId)).resolves.toMatchObject({ status: 'done', result: 'Plan in one line.' })
    await expect(subagents.result({ ...later, agentId: 'sage' }, started.taskId)).rejects.toThrow('another agent')
    expect((await store.getChat(started.taskId))?.subagent?.state).toBe('done')
    // The ended turn cannot start a new child.
    await expect(subagents.delegate(context, { task: 'x', model: 'gpt-6.1-sol', effort: 'low' })).rejects.toThrow('can no longer start')
  })

  it('names its top-level chat as running work until it ends or is told to stop', async () => {
    const { driver, subagents, context, parentChat } = await setup({ policy: { ...policy, maxConcurrent: 2 } })
    const brief = { task: 'Work.', model: 'gpt-6.1-sol', effort: 'low', wait: false } as const
    const first = await subagents.delegate(context, brief)
    await subagents.delegate(context, brief)
    await vi.waitFor(() => expect(driver.turns).toHaveLength(2))
    expect(subagents.runningRootChatIds()).toEqual([parentChat.id, parentChat.id])
    await subagents.cancel(context, first.taskId)
    expect(subagents.runningRootChatIds()).toEqual([parentChat.id])
    driver.answer(1, 'Done.')
    await vi.waitFor(() => expect(subagents.runningRootChatIds()).toEqual([]))
  })

  it('reports a wait that ran out as still running', async () => {
    const { subagents, context } = await setup({ waitMs: 10 })
    await expect(subagents.delegate(context, { task: 'Slow work.', model: 'gpt-6.1-sol', effort: 'low' }))
      .resolves.toMatchObject({ status: 'running', waitTimedOut: true })
  })

  it('refuses a request outside the policy before anything starts', async () => {
    const { subagents, context, driver, store, parentChat } = await setup()
    await expect(subagents.delegate(context, { task: 'x', model: 'claude-opus-5-5', effort: 'high' }))
      .rejects.toThrow(/not allowed for subagents in Settings\. Allowed: claude-sonnet-5-5 \(low, medium, high\)/)
    await expect(subagents.delegate(context, { task: 'x', model: 'gpt-6.1-sol', effort: 'xhigh' })).rejects.toBeInstanceOf(SubagentRefusal)
    expect(driver.turns).toHaveLength(0)
    expect(await store.loadEvents(parentChat.id)).toHaveLength(0)
  })

  it('holds the concurrency cap per chat, counting children that outlived their turn', async () => {
    const { driver, subagents, context } = await setup()
    const brief = { task: 'Work.', model: 'gpt-6.1-sol', effort: 'low', wait: false } as const
    // Three calls race for two slots before any child is registered.
    const raced = await Promise.allSettled([subagents.delegate(context, brief), subagents.delegate(context, brief), subagents.delegate(context, brief)])
    expect(raced.map((outcome) => outcome.status)).toEqual(['fulfilled', 'fulfilled', 'rejected'])
    await expect(subagents.delegate(context, brief)).rejects.toThrow('2 subagents are already running in this chat and the limit is 2')
    driver.answer(0, 'Done.')
    await vi.waitFor(async () => expect(await subagents.delegate(context, brief)).toMatchObject({ status: 'running' }))
  })

  it('refuses a child that tries to delegate while Settings keep that off', async () => {
    const { driver, subagents, context } = await setup()
    const started = await subagents.delegate(context, { task: 'Work.', model: 'gpt-6.1-sol', effort: 'low', wait: false })
    await vi.waitFor(() => expect(driver.turns).toHaveLength(1))
    expect(driver.turns[0]!.input.mcpServers).toBeUndefined()
    const asChild = { chatId: started.taskId, agentId: SUBAGENT_VOICE.id, turnId: subagents.activeTurn(started.taskId)!.turnId }
    await expect(subagents.delegate(asChild, { task: 'More.', model: 'gpt-6.1-sol', effort: 'low' })).rejects.toThrow('delegation by subagents off')
  })

  it('lets a nested child delegate only on a provider that holds the wait, listing its persona\'s models', async () => {
    const nestedMcp = vi.fn((_chatId: string, _agent: unknown, _turnId: string, personaId: string) => ({
      server: { id: 'builtin_manor', name: 'manor', command: 'node', args: [personaId], envKeys: [], description: '', writes: false, effectPolicy: 'trusted' as const, tools: [], readOnlyTools: [], schemaChars: 0 },
      disabledTools: [],
    }))
    const { driver, subagents, context } = await setup({ policy: { ...policy, allowNested: true }, nestedMcp })
    await subagents.delegate(context, { task: 'Codex work.', model: 'gpt-6.1-sol', effort: 'low', wait: false })
    await subagents.delegate(context, { task: 'Cursor work.', model: 'cursor-grok-4.6', effort: 'high', wait: false })
    await vi.waitFor(() => expect(driver.turns).toHaveLength(2))
    expect(nestedMcp).toHaveBeenCalledTimes(1)
    expect(nestedMcp.mock.calls[0]![3]).toBe('smith')
    expect(driver.turns[0]!.input.mcpServers).toHaveLength(1)
    expect(driver.turns[0]!.input.agent.character).toContain('delegate_task')
    expect(driver.turns[0]!.input.agent.character).toContain(SUBAGENT_REVIEW_RULE)
    expect(driver.turns[1]!.input.mcpServers).toBeUndefined()
    expect(driver.turns[1]!.input.agent.character).toContain('Do not delegate')
    expect(driver.turns[1]!.input.agent.character).not.toContain(SUBAGENT_REVIEW_RULE)
  })
})

describe('a child that needs the user', () => {
  const manorTools = (_chatId: string, _agent: unknown, _turnId: string, personaId: string, tools: { ask: boolean; delegate: boolean }) => ({
    server: { id: 'builtin_manor', name: 'manor', command: 'node', args: [personaId], envKeys: [], description: '', writes: false, effectPolicy: 'trusted' as const, tools: tools.ask ? ['ask_user'] : [], readOnlyTools: [], schemaChars: 0 },
    disabledTools: [],
  })
  const question = [{ id: 'choice', question: 'Which palette?', options: [{ label: 'Warm' }, { label: 'Cool' }] }]

  it('asks only on a provider that holds the call, and keeps delegating a separate grant', async () => {
    const nestedMcp = vi.fn(manorTools)
    const { driver, subagents, context } = await setup({ nestedMcp })
    await subagents.delegate(context, { task: 'Claude work.', model: 'claude-sonnet-5-5', effort: 'low', wait: false })
    await subagents.delegate(context, { task: 'Cursor work.', model: 'cursor-grok-4.6', effort: 'high', wait: false })
    await vi.waitFor(() => expect(driver.turns).toHaveLength(2))
    expect(nestedMcp).toHaveBeenCalledTimes(1)
    expect(nestedMcp.mock.calls[0]![4]).toEqual({ ask: true, delegate: false })
    expect(driver.turns[0]!.input.agent.character).toContain('ask_user')
    expect(driver.turns[1]!.input.mcpServers).toBeUndefined()
    expect(driver.turns[1]!.input.agent.character).toContain('Nobody can answer questions')
  })

  it('records the question in its own thread, lists it for the parent, and clears it on the answer', async () => {
    const { driver, store, subagents, context, changed } = await setup({ nestedMcp: manorTools })
    const { taskId } = await subagents.delegate(context, { task: 'Pick one.', model: 'claude-sonnet-5-5', effort: 'low', wait: false })
    await vi.waitFor(() => expect(driver.turns).toHaveLength(1))
    const turnId = subagents.activeTurn(taskId)!.turnId
    changed.mockClear()

    expect(await subagents.recordAsk(taskId, SUBAGENT_VOICE.id, turnId, 'req_1', question)).toBe(true)
    expect(changed).toHaveBeenCalledTimes(1)
    const listed = subagentDirectory(await store.listChats(), {}, [], subagents.openAsks()).subagents
    expect(listed.find((child) => child.id === taskId)?.ask).toEqual({ requestId: 'req_1', questions: question })

    expect(await subagents.recordAnswer(taskId, SUBAGENT_VOICE.id, turnId, 'req_1', { choice: 'Warm' })).toBe(true)
    expect(subagents.openAsks()).toEqual({})
    const events = await store.loadEvents(taskId)
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(['user_input_request', 'user_input_response']))
  })

  it('refuses a question from a stale turn, and drops an open one when the child ends', async () => {
    const { driver, subagents, context } = await setup({ nestedMcp: manorTools })
    const { taskId } = await subagents.delegate(context, { task: 'Pick one.', model: 'claude-sonnet-5-5', effort: 'low', wait: false })
    await vi.waitFor(() => expect(driver.turns).toHaveLength(1))
    expect(await subagents.recordAsk(taskId, SUBAGENT_VOICE.id, 'turn_old', 'req_1', question)).toBe(false)
    await subagents.recordAsk(taskId, SUBAGENT_VOICE.id, subagents.activeTurn(taskId)!.turnId, 'req_2', question)
    driver.answer(0, 'Done.')
    await vi.waitFor(() => expect(subagents.runs(taskId)).toBe(false))
    expect(subagents.openAsks()).toEqual({})
  })

  it('stops offering a question once its child is told to stop, before it has shut down', async () => {
    const { driver, store, subagents, context, parentChat, changed } = await setup({ nestedMcp: manorTools })
    const { taskId } = await subagents.delegate(context, { task: 'Pick one.', model: 'claude-sonnet-5-5', effort: 'low', wait: false })
    await vi.waitFor(() => expect(driver.turns).toHaveLength(1))
    await subagents.recordAsk(taskId, SUBAGENT_VOICE.id, subagents.activeTurn(taskId)!.turnId, 'req_1', question)
    driver.turns[0]!.stop.mockImplementation(() => undefined)
    changed.mockClear()
    expect(subagents.stop(parentChat.id, (await store.getChat(taskId))!.subagent!.toolCallId)).toBe(true)
    expect(changed).toHaveBeenCalledTimes(1)
    expect(subagents.runs(taskId)).toBe(true)
    expect(subagents.openAsks()).toEqual({})
  })
})

describe('ending a child early', () => {
  it('cancels through task_cancel, stops the provider and records why in both threads', async () => {
    const { driver, subagents, context, store, parentChat } = await setup()
    const started = await subagents.delegate(context, { task: 'Long job.', model: 'gpt-6.1-sol', effort: 'low', wait: false })
    await vi.waitFor(() => expect(driver.turns).toHaveLength(1))
    await expect(subagents.cancel(context, started.taskId)).resolves.toMatchObject({ status: 'cancelled', reason: 'Cancelled by Smith.' })
    expect(driver.turns[0]!.stop).toHaveBeenCalled()
    expect((await store.getChat(started.taskId))?.subagent).toMatchObject({ state: 'cancelled', reason: 'Cancelled by Smith.' })
    expect((await store.loadEvents(started.taskId)).at(-1)).toMatchObject({ type: 'system_note', kind: 'aborted' })
    expect((await store.loadEvents(parentChat.id)).at(-1)).toMatchObject({ type: 'tool_result', outcome: 'stopped' })
    // Idempotent once it has ended.
    await expect(subagents.cancel(context, started.taskId)).resolves.toMatchObject({ status: 'cancelled' })
  })

  it('stops with the parent turn, from its sidebar Stop, and with a deleted parent', async () => {
    const { driver, subagents, context, store, parentChat } = await setup({ policy: { ...policy, maxConcurrent: 3 } })
    const brief = { task: 'Work.', model: 'gpt-6.1-sol', effort: 'low', wait: false } as const
    const [a, b, c] = [await subagents.delegate(context, brief), await subagents.delegate(context, brief), await subagents.delegate(context, brief)]
    await vi.waitFor(() => expect(driver.turns).toHaveLength(3))
    const toolCallOf = async (taskId: string) => (await store.getChat(taskId))!.subagent!.toolCallId
    expect(subagents.stop(parentChat.id, await toolCallOf(a.taskId))).toBe(true)
    await expect(subagents.result(context, a.taskId)).resolves.toMatchObject({ status: 'cancelled', reason: 'Stopped by the user.' })
    subagents.stopFromTurn('turn_1')
    await expect(subagents.result(context, b.taskId)).resolves.toMatchObject({ status: 'cancelled', reason: "Stopped with Smith's turn." })
    await expect(subagents.result(context, c.taskId)).resolves.toMatchObject({ status: 'cancelled' })
    expect(subagents.stop(parentChat.id, await toolCallOf(a.taskId))).toBe(false)
  })

  it('lists a stopped child as cancelled at once, while it shuts down and when its end fails to save', async () => {
    const { driver, subagents, context, store, parentChat } = await setup({ policy: { ...policy, maxConcurrent: 2 } })
    const brief = { task: 'Work.', model: 'gpt-6.1-sol', effort: 'low', wait: false } as const
    const [slow, unsaved] = [await subagents.delegate(context, brief), await subagents.delegate(context, brief)]
    await vi.waitFor(() => expect(driver.turns).toHaveLength(2))
    for (const turn of driver.turns) turn.stop.mockImplementation(() => undefined)
    const stateOf = async (taskId: string) =>
      subagentDirectory(await store.listChats(), {}, [], {}, subagents.stoppingIds()).subagents.find((child) => child.id === taskId)?.state
    expect(subagents.stopInChat(parentChat.id, 'Stopped by the user.')).toHaveLength(2)
    expect((await store.getChat(slow.taskId))?.subagent?.state).toBe('running')
    expect(await stateOf(slow.taskId)).toBe('cancelled')
    driver.turns[0]!.queue.close()
    await expect(subagents.result(context, slow.taskId)).resolves.toMatchObject({ status: 'cancelled' })
    expect(subagents.stoppingIds().has(slow.taskId)).toBe(false)
    vi.spyOn(store, 'endSubagent').mockRejectedValueOnce(new Error('disk full'))
    driver.turns[1]!.queue.close()
    await expect(subagents.result(context, unsaved.taskId)).resolves.toMatchObject({ status: 'cancelled' })
    expect((await store.getChat(unsaved.taskId))?.subagent?.state).toBe('running')
    expect(await stateOf(unsaved.taskId)).toBe('cancelled')
  })

  it('ends children a restart cut off and closes their launch rows', async () => {
    const { store, parentChat } = await setup()
    const child = await store.createSubagentChat(parentChat.id, 'Orphan', {
      agentId: 'smith', turnId: 'turn_old', toolCallId: 'subagent_old', driver: 'codex', model: 'gpt-6.1-sol', effort: 'low',
      state: 'running', startedAt: 1, depth: 1,
    })
    const fresh = new Subagents({
      store, policy: () => DEFAULT_SUBAGENT_POLICY, parent: () => undefined, agentName: (id) => id,
      startTurn: () => { throw new Error('nothing runs at boot') }, append: async () => undefined, emit: () => undefined, changed: () => undefined,
    })
    await expect(fresh.recover()).resolves.toBe(1)
    expect((await store.getChat(child.id))?.subagent).toMatchObject({ state: 'cancelled', reason: 'Manor restarted while it was running.' })
    expect((await store.loadEvents(parentChat.id)).at(-1)).toMatchObject({ type: 'tool_result', toolCallId: 'subagent_old', outcome: 'stopped' })
    await expect(fresh.recover()).resolves.toBe(0)
  })
})

describe("a provider's own helper", () => {
  it("is stamped with the turn's provider and listed until its result or its turn's end", async () => {
    const { subagents, changed, parentChat } = await setup()
    const chatId = parentChat.id
    const launch = { type: 'tool_use', agentId: 'argus', turnId: 'turn_a', toolCallId: 'call_1', tool: 'spawn_subagent', subagent: { title: 'full standards' } } as const
    expect(subagents.noteNative(chatId, launch, 'codex')).toMatchObject({ subagent: { title: 'full standards', driver: 'codex' } })
    // A Claude Task that named no brief still gets its row and its mark.
    expect(subagents.noteNative(chatId, { type: 'tool_use', agentId: 'argus', turnId: 'turn_a', toolCallId: 'call_2', tool: 'Task' }, 'claude'))
      .toMatchObject({ subagent: { driver: 'claude' } })
    expect(subagents.nativeRunning()).toMatchObject([
      { parentChatId: chatId, turnId: 'turn_a', toolCallId: 'call_1', driver: 'codex', title: 'full standards' },
      { toolCallId: 'call_2', driver: 'claude', title: 'Subagent' },
    ])
    expect(subagentDirectory([], {}, subagents.nativeRunning()).nativeSubagents).toHaveLength(2)

    // Manor's own launch, a helper's inner step and any other tool pass through untouched.
    const untouched = [
      { ...launch, toolCallId: 'subagent_x', subagent: { title: 'Manor run', childChatId: 'child_1' } },
      { ...launch, toolCallId: 'call_inner', parentToolCallId: 'call_1' },
      { ...launch, toolCallId: 'call_read', tool: 'Read' },
    ]
    for (const draft of untouched) expect(subagents.noteNative(chatId, draft, 'codex')).toBe(draft)
    expect(changed).toHaveBeenCalledTimes(2)

    // Its result takes it off the list; the turn's end takes whatever is left.
    subagents.noteNative(chatId, { type: 'tool_result', agentId: 'argus', turnId: 'turn_a', toolCallId: 'call_1', outcome: 'success' }, 'codex')
    expect(subagents.nativeRunning().map((helper) => helper.toolCallId)).toEqual(['call_2'])
    subagents.closeTurn('turn_a')
    expect(subagents.nativeRunning()).toEqual([])
    expect(changed).toHaveBeenCalledTimes(4)
  })

  it('lists its title with credentials redacted, as the transcript stores it', async () => {
    const { subagents, parentChat } = await setup()
    subagents.noteNative(parentChat.id, { type: 'tool_use', agentId: 'argus', turnId: 'turn_a', toolCallId: 'call_1', tool: 'spawn_subagent', subagent: { title: 'use ghp_abcdefghijklmnopqrstuvwxyz0123 here' } }, 'codex')
    expect(subagents.nativeRunning()[0]?.title).toBe('use [redacted] here')
  })
})

describe('the sidebar listing', () => {
  it('keeps every running child and the three newest finished ones per parent', async () => {
    const store = createMemoryStore({ agents: [smith] })
    const parent = (await store.listChats())[0]!
    const base = { agentId: 'smith', turnId: 't', driver: 'codex', model: 'gpt-6.1-sol', effort: 'low', depth: 1 } as const
    for (let index = 0; index < 5; index += 1) {
      const chat = await store.createSubagentChat(parent.id, `Done ${index}`, { ...base, toolCallId: `s${index}`, state: 'running', startedAt: index + 1 })
      await store.endSubagent(chat.id, { state: 'done', endedAt: index + 2 })
    }
    await store.createSubagentChat(parent.id, 'Running', { ...base, toolCallId: 'r', state: 'running', startedAt: 0 })
    const listed = subagentDirectory(await store.listChats())
    expect(listed.subagents.map((child) => child.title)).toEqual(['Done 4', 'Done 3', 'Done 2', 'Running'])
    // While that turn still runs, every child it started stays listed past the three.
    const inTurn = subagentDirectory(await store.listChats(), { [parent.id]: ['t'] })
    expect(inTurn.subagents.map((child) => child.title)).toEqual(['Done 4', 'Done 3', 'Done 2', 'Done 1', 'Done 0', 'Running'])
    expect(subagentDirectory(await store.listChats(), { [parent.id]: ['other'] }).subagents).toHaveLength(4)
    // An old child whose own child is still listed comes along, so that line reaches the row.
    const old = await store.createSubagentChat(parent.id, 'Old', { ...base, toolCallId: 'o', state: 'running', startedAt: -2 })
    await store.endSubagent(old.id, { state: 'done', endedAt: 10 })
    const nested = await store.createSubagentChat(old.id, 'Nested', { ...base, toolCallId: 'n', state: 'running', startedAt: -1, depth: 2 })
    await store.endSubagent(nested.id, { state: 'done', endedAt: 9 })
    const withLine = subagentDirectory(await store.listChats())
    expect(withLine.subagents.map((child) => child.title)).toEqual(['Done 4', 'Done 3', 'Done 2', 'Running', 'Nested', 'Old'])
    // A finished child keeps its first ending.
    const first = listed.subagents[0]!
    await store.endSubagent(first.id, { state: 'failed', reason: 'late' })
    expect((await store.getChat(first.id))?.subagent?.state).toBe('done')
  })
})
