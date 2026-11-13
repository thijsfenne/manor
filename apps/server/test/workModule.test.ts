import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WorkCompletionSchema, type AgentConfig, type CheckoutRequest, type GoalCommit, type ServerMessage, type ThreadEvent, type TurnInput } from '@manor/contracts'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { Orchestrator } from '../src/orchestrator.js'
import { createMemoryStore } from '../src/stores/memoryStore.js'
import { WorkModule, commitRequest, confirmRequestOf, mergeTroubleRequest, retryRequest, type WorkOrigin } from '../src/workModule.js'
import { WorkCapabilities } from '../src/workCapability.js'
import { prepareWorkCompletion } from '../src/workCompletion.js'
import { MergeLanes } from '../src/workMerge.js'
import { captureTurnTree, diffTurnTrees } from '../src/turnFileSnapshots.js'
import { sage, seededChat, smith, until, scripted, scratchFor } from './helpers.js'

const lead: AgentConfig = { ...sage, mentionAllowlist: ['smith'] }
const context = { chatId: '', agentId: 'sage', turnId: 'turn_1' }

async function harness(kind: 'dm' | 'group' = 'dm', options: {
  agents?: readonly AgentConfig[]
  active?: boolean
  outcome?: () => Promise<string | undefined>
  prepareCheckout?: (chatId: string, checkout: CheckoutRequest, accept: () => Promise<void>) => Promise<void>
  startError?: Error
  directoryError?: Error
  /** Runs between reading a directory and delivering it, like the Git lookups do. */
  beforeDelivery?: () => Promise<void>
  writeCommitMessage?: (chatId: string, patch: string) => Promise<string | undefined>
} = {}) {
  const agents = options.agents ?? [lead, smith]
  const store = createMemoryStore({ agents })
  const { projectId } = await seededChat(store)
  const source = await store.createChat({
    kind,
    memberIds: kind === 'dm' ? ['sage'] : ['sage', 'smith'],
    title: kind === 'dm' ? 'Sage' : 'Launch room',
  })
  const started: { chatId: string; text: string; origin: WorkOrigin }[] = []
  const discarded: string[] = []
  const stopped: string[] = []
  const resumed: string[] = []
  const sent: ServerMessage[] = []
  let directories = 0
  /** Each broadcast directory, as the settle stamp of every chat in it. */
  const directoryStates: Map<string, number | null>[] = []
  const orchestrator = {
    isActiveTurn: () => options.active ?? true,
    startStoredWorkHandoff: async (chatId: string, text: string, origin: WorkOrigin) => {
      started.push({ chatId, text, origin })
      if (options.startError !== undefined) throw options.startError
    },
    discard: (chatId: string) => { discarded.push(chatId) },
    stopChat: (chatId: string) => { stopped.push(chatId) },
    resumeChat: (chatId: string) => { resumed.push(chatId) },
    submitUserMessage: async () => undefined,
    runStoredUserMessage: vi.fn(async (_chatId: string, _event: ThreadEvent): Promise<undefined> => undefined),
    runExclusive: <T>(_chatId: string, fn: () => Promise<T>) => fn(),
  }
  const module = new WorkModule({
    store,
    agents: () => agents,
    orchestrator,
    broadcast: (message) => sent.push(message),
    broadcastDirectory: async () => {
      directories += 1
      const rows = new Map((await store.listChats()).map((chat) => [chat.id, chat.settledAt]))
      await options.beforeDelivery?.()
      directoryStates.push(rows)
      if (options.directoryError !== undefined) throw options.directoryError
    },
    ...(options.prepareCheckout === undefined ? {} : { prepareCheckout: options.prepareCheckout }),
    ...(options.outcome === undefined ? {} : { generateOutcome: options.outcome }),
    ...(options.writeCommitMessage === undefined ? {} : { writeCommitMessage: options.writeCommitMessage }),
  })
  return {
    module, store, source, projectId, started, discarded, stopped, resumed, sent, orchestrator,
    directories: () => directories, directoryStates,
  }
}

const input = (project: string) => ({
  assignmentKey: 'ship-handoffs',
  project,
  title: 'Ship handoffs',
  task: 'Implement the bounded Chat to Work handoff. Do not copy the source transcript.',
  summary: 'Hand bounded Chat work to a Work thread.',
  supportingPersonas: ['Smith'],
})

async function propose(h: Awaited<ReturnType<typeof harness>>, overrides = {}) {
  return await h.module.useTool({ ...context, chatId: h.source.id }, { ...input(h.projectId), ...overrides }) as { workHandoffId: string; workChatId: null }
}

async function acceptedWork(h: Awaited<ReturnType<typeof harness>>) {
  const proposal = await propose(h)
  return { workChatId: await h.module.accept(proposal.workHandoffId) }
}

/** An outcome writer the test releases by hand, standing in for a slow model call. */
function held() {
  let release: (value: string) => void = () => undefined
  let started = false
  const result = new Promise<string>((resolve) => { release = resolve })
  return {
    run: () => { started = true; return result },
    started: () => started,
    release: (value: string) => release(value),
  }
}

/** Whether a broadcast note starts with `text`. */
const noteSent = (h: Awaited<ReturnType<typeof harness>>, text: string) => h.sent.some(
  (message) => message.type === 'event' && message.event.type === 'system_note' && message.event.text.startsWith(text),
)

const settledNotes = (events: readonly ThreadEvent[]) => events.filter(
  (event): event is Extract<ThreadEvent, { type: 'system_note' }> => event.type === 'system_note' && event.workHandoffPhase === 'settled',
)

describe('result feedback', () => {
  it('keeps the chat author separate from the Session lead and refuses stale proposals', async () => {
    const author: AgentConfig = { ...lead, placement: 'chat' }
    const executor: AgentConfig = { ...smith, placement: 'session' }
    const agents = [author, executor]
    const h = await harness('dm', { agents })
    const proposal = await propose(h, { firstExecutor: 'Smith' })
    const target = await h.module.accept(proposal.workHandoffId)
    expect((await h.store.workHandoffForTarget(target))).toMatchObject({
      authorAgentId: 'sage', leadAgentId: 'smith', supportingAgentIds: [],
    })
    const pending = await propose(h, { assignmentKey: 'second', firstExecutor: 'Smith' })
    executor.placement = 'chat'
    await expect(h.module.accept(pending.workHandoffId)).rejects.toThrow('stays in chat')
    expect((await h.store.listWorkHandoffs()).find((row) => row.id === pending.workHandoffId)?.workChatId).toBeNull()
  })

  it('queues one durable correction, rejects duplicate feedback and blocks acceptance after an unreviewed edit', async () => {
    const h = await harness()
    const { workChatId } = await acceptedWork(h)
    const handoff = (await h.store.workHandoffForTarget(workChatId))!
    const report = { type: 'system_note', kind: 'info', text: 'Ready.', workGoalHandoffId: handoff.id,
      goalReport: { result: 'Export works.' },
    } as const
    await h.store.reachWorkGoal(handoff.id, report)
    const reached = (await h.store.workHandoffForTarget(workChatId))!
    await Promise.allSettled([
      h.module.reviseGoal(handoff.id, reached.version, 'Use the chat title.'),
      h.module.reviseGoal(handoff.id, reached.version, 'Use the chat title.'),
    ])
    expect(h.orchestrator.runStoredUserMessage).toHaveBeenCalledTimes(1)
    expect(h.orchestrator.runStoredUserMessage).toHaveBeenCalledWith(workChatId,
      expect.objectContaining({ text: '@Sage Use the chat title.', dispatchState: 'pending' }))
    expect((await h.store.loadEvents(workChatId)).filter((e) => e.type === 'user_message' && e.text === '@Sage Use the chat title.')).toHaveLength(1)
    expect((await h.store.loadEvents(h.source.id)).some((e) => e.type === 'user_message' && e.text === 'Use the chat title.')).toBe(false)
    await h.store.reachWorkGoal(handoff.id, report)
    await h.store.appendEvent(workChatId, { type: 'turn_result', agentId: 'smith', turnId: 'changed',
      fileChanges: [{ path: 'export.ts', status: 'edited', added: 1, removed: 0, edits: [] }],
    })
    const current = (await h.store.workHandoffForTarget(workChatId))!
    await expect(h.module.confirmGoal(handoff.id, undefined, current.version)).rejects.toThrow('changed after review')
    expect((await h.store.workHandoffForTarget(workChatId))?.goalConfirmedAt).toBeUndefined()
  })
})

describe('WorkModule creation', () => {
  it('keeps legacy persona kickoffs out of Single while preserving Multiple acceptance', async () => {
    const h = await harness()
    const { handoff } = await h.store.reserveWorkHandoff({
      sourceChatId: h.source.id, sourceTurnId: 'legacy', projectId: h.projectId, projectName: 'Manor',
      title: 'Old proposal', kickoff: 'Start under Sage and confirm Sage started.',
      authorAgentId: 'sage', leadAgentId: 'sage', leadAgentName: 'Sage',
      supportingAgentIds: [], supportingAgentNames: [],
    })
    const before = await h.store.listChats()
    await expect(h.module.accept(handoff.id, { mode: 'single',
      runtime: { driver: 'codex', model: 'gpt-5.6-sol', effort: 'medium' },
    })).rejects.toThrow('Create a new session proposal')
    expect(await h.store.listChats()).toEqual(before)
    expect(h.started).toEqual([])
    const target = await h.module.accept(handoff.id)
    expect(await h.store.getChat(target)).toMatchObject({ mode: 'house' })
    expect(h.started[0]?.text).toBe(handoff.kickoff)
  })

  it('requires a valid Single runtime before materializing a proposal', async () => {
    const h = await harness()
    const proposal = await propose(h)
    await expect(h.module.accept(proposal.workHandoffId, { mode: 'single' })).rejects.toThrow('Choose a provider')
    await expect(h.module.accept(proposal.workHandoffId, {
      mode: 'single', runtime: { driver: 'claude', model: 'gpt-5.6-sol', effort: 'medium' },
    })).rejects.toThrow('does not belong')
    await expect(h.module.accept(proposal.workHandoffId, {
      runtime: { driver: 'codex', model: 'gpt-5.6-sol', effort: 'medium' },
    })).rejects.toThrow('requires Single mode')
    expect((await h.store.listWorkHandoffs())[0]).toMatchObject({ workChatId: null, acceptedAt: null })
    expect(h.started).toEqual([])
  })

  it('rolls back the Single runtime with a refused checkout and permits a Multiple retry', async () => {
    let target = ''
    const runtime = { driver: 'codex', model: 'gpt-5.6-sol', effort: 'medium' } as const
    const h = await harness('dm', { prepareCheckout: async (chatId) => {
      target = chatId
      expect(await h.store.loadChatOverrides(chatId)).toEqual({ __single__: runtime })
      throw new Error('git refused')
    } })
    const proposal = await propose(h)
    await expect(h.module.accept(proposal.workHandoffId, {
      mode: 'single', runtime, checkout: { mode: 'worktree' },
    })).rejects.toThrow('git refused')
    expect(await h.store.getChat(target)).toBeUndefined()
    expect(await h.store.loadChatOverrides(target)).toEqual({})
    const retried = await h.module.accept(proposal.workHandoffId)
    expect(await h.store.getChat(retried)).toMatchObject({ mode: 'house' })
    expect(await h.store.loadChatOverrides(retried)).toEqual({})
    expect(h.started).toHaveLength(1)
  })

  it('refuses to convert an existing legacy target to Single', async () => {
    const h = await harness()
    const proposal = await propose(h)
    const held = await h.store.materializeWorkHandoff(proposal.workHandoffId)
    await expect(h.module.accept(proposal.workHandoffId, {
      mode: 'single', runtime: { driver: 'codex', model: 'gpt-5.6-sol', effort: 'medium' },
    })).rejects.toThrow('cannot switch')
    expect(await h.store.getChat(held.workChatId!)).toMatchObject({ mode: 'house' })
    expect(await h.module.accept(proposal.workHandoffId)).toBe(held.workChatId)
  })

  it.each([false, true])('Accept starts Smith directly from Jeeves’s proposal (memory %s), then runs the chain back to its lead', async (memoryScope) => {
    const agents = [
      { ...sage, id: 'jeeves', name: 'Jeeves', isCos: true, mentionAllowlist: ['smith', 'sage'] },
      { ...smith, memoryScope, mentionAllowlist: ['sage'] }, sage,
    ]
    const store = createMemoryStore({ agents })
    const { projectId } = await seededChat(store)
    const source = await store.createChat({ kind: 'dm', memberIds: ['jeeves'], title: 'Jeeves' })
    await store.appendEvent(source.id, { type: 'user_message', text: 'Unrelated private source history.', mentions: [] })
    const seen: TurnInput[] = []
    const orchestrator = new Orchestrator({
      agents: () => agents, store, mcpServers: () => [], skills: () => [],
      // Jeeves leads both accepted Sessions, so each chain returns to him and ends on his goal_reached.
      resolveDriver: () => scripted((input) => [
        ...(input.agent.id === 'jeeves' ? [
          { type: 'tool_use', toolCallId: 'goal', tool: 'mcp__manor__goal_reached' },
          { type: 'tool_result', toolCallId: 'goal', outcome: 'success' },
        ] as const : []),
        { type: 'result', text: input.agent.id === 'smith' ? '@Sage review this implementation.' : 'Reviewed.', sessionId: 's' },
      ], seen), ensureScratchDir: scratchFor, emit: () => undefined,
    })
    const module = new WorkModule({ store, agents: () => agents,
      orchestrator: {
        isActiveTurn: () => true,
        startStoredWorkHandoff: orchestrator.startStoredWorkHandoff.bind(orchestrator),
        discard: orchestrator.discard.bind(orchestrator),
        stopChat: orchestrator.stopChat.bind(orchestrator),
        resumeChat: orchestrator.resumeChat.bind(orchestrator),
        submitUserMessage: (chatId: string, text: string) => orchestrator.submitUserMessage(chatId, text),
        runStoredUserMessage: (chatId, event) => orchestrator.runStoredUserMessage(chatId, event),
        runExclusive: (chatId, fn) => orchestrator.runExclusive(chatId, fn),
      }, broadcast: () => undefined, broadcastDirectory: async () => undefined,
    })
    const kickoff = 'Implement the agreed behavior with relevant acceptance criteria. @Jeeves is the author.'
    const before = await store.listChats()
    const result = await module.useTool({ chatId: source.id, agentId: 'jeeves', turnId: 'source_turn' }, {
      assignmentKey: 'direct-implementation', project: projectId, title: 'Direct implementation', task: kickoff, firstExecutor: 'Smith', supportingPersonas: ['Sage'],
    }) as { workHandoffId: string; workChatId: null }
    const second = await module.useTool({ chatId: source.id, agentId: 'jeeves', turnId: 'source_turn' }, {
      assignmentKey: 'separate-review', project: projectId, title: 'Separate review',
      task: 'Review the agreed behavior.', firstExecutor: 'Sage',
    }) as { workHandoffId: string; workChatId: null }
    expect(seen).toEqual([])
    expect(result.workChatId).toBeNull()
    expect(second.workChatId).toBeNull()
    expect((await store.listChats()).map((chat) => chat.id).sort()).toEqual(before.map((chat) => chat.id).sort())
    const [firstTarget, secondTarget] = await Promise.all([
      module.accept(result.workHandoffId), module.accept(second.workHandoffId),
    ])
    await Promise.all([module.accept(result.workHandoffId), module.accept(second.workHandoffId)])
    await Promise.all([firstTarget, secondTarget].map((chatId) => orchestrator.runExclusive(chatId, async () => undefined)))
    await until(() => seen.length === 5, 'independent executors, the explicit summon and both leads')
    await Promise.all([firstTarget, secondTarget].map((chatId) => orchestrator.runExclusive(chatId, async () => undefined)))
    const firstTurns = seen.filter((input) => input.threadId === firstTarget)
    expect(firstTurns.map((input) => input.agent.id)).toEqual(['smith', 'sage', 'jeeves'])
    expect(seen.filter((input) => input.threadId === secondTarget).map((input) => input.agent.id)).toEqual(['sage', 'jeeves'])
    expect(firstTurns[0]?.agent.memoryScope).toBe(memoryScope)
    expect(firstTurns[0]?.catchUp).toEqual([expect.objectContaining({
      type: 'user_message', text: kickoff, workAuthorAgentId: 'jeeves', workFirstExecutorAgentId: 'smith',
    })])
    expect(JSON.stringify(seen.map((input) => input.catchUp))).not.toContain('Unrelated private source history')
    const events = await store.loadEvents(firstTarget)
    expect(events.filter((event) => event.type === 'user_message')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'agent_message').map((event) => event.agentId)).toEqual(['smith', 'sage', 'jeeves'])
    expect(events.at(-1)).toMatchObject({ type: 'system_note', agentId: 'jeeves', text: 'Jeeves marked the goal reached.' })
  })

  it('uses an explicit executor before team order for a chat author', async () => {
    const helper = { ...smith, id: 'helper', name: 'Helper' }
    const h = await harness('dm', { agents: [{ ...lead, placement: 'chat' }, { ...smith, mentionAllowlist: ['helper'] }, helper] })
    await h.module.useTool({ ...context, chatId: h.source.id }, {
      ...input(h.projectId), firstExecutor: 'smith', supportingPersonas: ['Helper', 'Smith'],
    })
    expect((await h.store.listWorkHandoffs())[0]).toMatchObject({
      leadAgentId: 'smith', firstExecutor: { agentId: 'smith', agentName: 'Smith' }, supportingAgentIds: ['helper'],
    })
  })

  it('lets a chat author without an allowlist name any Session executor', async () => {
    const h = await harness('dm', { agents: [{ ...lead, placement: 'chat', mentionAllowlist: [] }, smith] })
    const created = await h.module.useTool({ ...context, chatId: h.source.id }, {
      ...input(h.projectId), firstExecutor: 'Smith',
    }) as { workHandoffId: string }
    await h.module.accept(created.workHandoffId)
    expect(h.started[0]?.origin.firstExecutorAgentId).toBe('smith')
  })

  it.each(['Missing', 'Blocked', 'DM', 'Duplicate'])('refuses an invalid explicit executor: %s', async (firstExecutor) => {
    const h = await harness('dm', { agents: [lead, smith,
      { ...smith, id: 'blocked', name: 'Blocked' },
      { ...smith, id: 'dm', name: 'DM', placement: 'chat' },
      { ...smith, id: 'duplicate1', name: 'Duplicate' },
      { ...smith, id: 'duplicate2', name: 'Duplicate' },
    ] })
    await expect(h.module.useTool({ ...context, chatId: h.source.id }, {
      ...input(h.projectId), firstExecutor,
    })).rejects.toThrow()
    expect(await h.store.listWorkHandoffs()).toEqual([])
    expect(h.started).toHaveLength(0)
  })

  it.each(['removed', 'chat', 'allowlist'])('revalidates the executor at Accept: %s', async (change) => {
    const agents = [{ ...lead }, { ...smith }]
    const h = await harness('dm', { agents })
    const created = await h.module.useTool({ ...context, chatId: h.source.id }, {
      ...input(h.projectId), firstExecutor: 'Smith',
    }) as { workHandoffId: string }
    if (change === 'removed') agents.pop()
    if (change === 'chat') agents[1]!.placement = 'chat'
    if (change === 'allowlist') agents[0]!.mentionAllowlist = []
    await expect(h.module.accept(created.workHandoffId)).rejects.toThrow()
    expect((await h.store.listWorkHandoffs())[0]).toMatchObject({ workChatId: null, acceptedAt: null })
    expect(h.started).toHaveLength(0)
    agents.splice(0, agents.length, { ...lead }, { ...smith })
    await h.module.accept(created.workHandoffId)
    expect(h.started).toHaveLength(1)
    expect(h.started[0]?.origin.firstExecutorAgentId).toBe('smith')
  })

  it('reports a queued start failure in Work without replaying it on an Accept retry', async () => {
    const h = await harness('dm', { startError: new Error('Executor unavailable') })
    const created = await h.module.useTool({ ...context, chatId: h.source.id }, {
      ...input(h.projectId), firstExecutor: 'Smith',
    }) as { workHandoffId: string }
    const target = await h.module.accept(created.workHandoffId)
    await until(() => h.sent.some((message) => message.type === 'event' &&
      message.chatId === target && message.event.type === 'system_note' &&
      message.event.text.includes('Could not start the session with Smith: Executor unavailable')), 'visible start failure')
    await h.module.accept(target)
    expect(h.started).toHaveLength(1)
  })

  for (const kind of ['dm', 'group'] as const) {
    it(`publishes one proposal without a thread or kickoff event from a ${kind} turn, including retries`, async () => {
      const h = await harness(kind)
      const before = await h.store.listChats()
      const [first, retry] = await Promise.all([propose(h), propose(h)])
      expect(first.workChatId).toBeNull()
      expect(retry).toMatchObject({ ...first, reused: true })
      expect((await h.store.listChats()).map((chat) => chat.id).sort()).toEqual(before.map((chat) => chat.id).sort())
      expect(h.started).toEqual([])
      expect(await h.store.listWorkHandoffs()).toEqual([expect.objectContaining({
        workChatId: null, acceptedAt: null, version: 1, task: input(h.projectId).task, summary: input(h.projectId).summary,
        authorAgentId: 'sage', leadAgentId: 'sage', supportingAgentIds: ['smith'],
      })])
      expect(await h.store.loadEvents(h.source.id)).toEqual([expect.objectContaining({ workHandoffPhase: 'created' })])
      await h.store.settleIdleChats(Date.now() + 1)
      expect((await h.store.listWorkHandoffs())[0]).toMatchObject({ state: 'active', acceptedAt: null, workChatId: null })
    })
  }

  it('splits three briefs from existing Work and independently accepts each exactly once', async () => {
    const h = await harness()
    const source = await h.store.createChat({ kind: 'project', projectId: h.projectId, title: 'Three separate improvements' })
    const bound = { ...context, chatId: source.id }
    const assignments = ['quote-replies', 'browser-mention', 'subscription-graph'].map((assignmentKey, index) => ({
      ...input(h.projectId), assignmentKey, title: assignmentKey, firstExecutor: index === 1 ? 'Sage' : 'Smith',
      task: `Implement only ${assignmentKey} in Manor. Keep the other two improvements out of scope.`,
    }))
    await Promise.all(assignments.map((assignment) => h.module.useTool(bound, assignment)))
    await Promise.all(assignments.map((assignment) => h.module.useTool(bound, { ...assignment, title: 'Reworded retry', task: 'Reworded briefing on retry.', firstExecutor: 'Sage' })))
    const handoffs = await h.store.listWorkHandoffs()
    expect(handoffs).toHaveLength(3)
    expect(handoffs.every((row) => row.workChatId === null)).toBe(true)
    const targets: string[] = []
    expect(handoffs.map((row) => row.title)).toEqual(assignments.map((row) => row.title))
    expect(h.started).toHaveLength(0)
    for (const [index, handoff] of handoffs.entries()) {
      expect(handoff.sourceChatId).toBe(source.id)
      const target = await h.module.accept(handoff.id)
      targets.push(target)
      expect(await h.store.loadEvents(target)).toEqual([expect.objectContaining({
        type: 'user_message', text: assignments[index]!.task, workSourceChatId: source.id,
      })])
      await Promise.all([h.module.accept(target), h.module.accept(target)])
    }
    expect(new Set(targets).size).toBe(3)
    expect(h.started.map((row) => row.chatId)).toEqual(targets)
    expect(h.started.map((row) => row.text)).toEqual(assignments.map((row) => row.task))
    expect(h.started.map((row) => row.origin.firstExecutorAgentId)).toEqual(['smith', 'sage', 'smith'])
    expect((await h.store.loadEvents(source.id)).filter((event) => event.type === 'system_note')).toHaveLength(3)
  })

  it('keeps successful siblings when another assignment fails and is retried', async () => {
    const h = await harness()
    const bound = { ...context, chatId: h.source.id }
    const capabilities = new WorkCapabilities()
    const token = capabilities.issue(bound)
    const call = (assignment: ReturnType<typeof input>) => h.module.useTool(capabilities.take(token), assignment)
    await call(input(h.projectId))
    const create = vi.spyOn(h.store, 'reserveWorkHandoff').mockRejectedValueOnce(new Error('write failed'))
    const second = { ...input(h.projectId), assignmentKey: 'second' }
    await expect(call(second)).rejects.toThrow('write failed')
    expect(await h.store.listWorkHandoffs()).toHaveLength(1)
    create.mockRestore()
    await call({ ...input(h.projectId), assignmentKey: 'third' })
    await call(second)
    expect(await h.store.listWorkHandoffs()).toHaveLength(3)
    const first = (await h.store.listWorkHandoffs())[0]!
    await h.store.deleteChat(await h.module.accept(first.id))
    expect(await call(input(h.projectId))).toMatchObject({ reused: true, workChatId: null })
    expect(await h.store.listWorkHandoffs()).toHaveLength(3)
  })

  it('creates exactly one thread and starts once for concurrent Accepts and retries', async () => {
    const h = await harness()
    const proposal = await propose(h)
    const ids = await Promise.all([h.module.accept(proposal.workHandoffId), h.module.accept(proposal.workHandoffId)])
    expect(ids[0]).toBe(ids[1])
    expect(await h.module.accept(proposal.workHandoffId)).toBe(ids[0])
    expect((await h.store.listChats()).filter((chat) => chat.title === input(h.projectId).title)).toHaveLength(1)
    expect(h.started).toHaveLength(1)
    expect(h.started[0]?.text).toBe(input(h.projectId).task)
    expect(await h.store.workHandoffForTarget(ids[0]!)).toMatchObject({ acceptedAt: expect.any(Number) })
    expect(await h.store.loadEvents(ids[0]!)).toEqual([expect.objectContaining({ type: 'user_message', workHandoffId: proposal.workHandoffId })])
    await expect(h.module.accept('missing')).rejects.toThrow('unknown work handoff')
  })

  it('keeps separate proposals from one source turn independent', async () => {
    const h = await harness('group')
    const first = await propose(h)
    const second = await propose(h, { assignmentKey: 'another-task', title: 'Another task', task: 'A different brief.', supportingPersonas: [] })
    const third = await propose(h, { assignmentKey: 'third-task', title: 'Third task', task: 'A third brief.' })
    expect(new Set([first.workHandoffId, second.workHandoffId, third.workHandoffId]).size).toBe(3)
    await h.module.reject(second.workHandoffId)
    const ids = await Promise.all([h.module.accept(first.workHandoffId), h.module.accept(third.workHandoffId)])
    expect(new Set(ids).size).toBe(2)
    expect(h.started).toHaveLength(2)
    expect((await h.store.listWorkHandoffs()).find((row) => row.id === second.workHandoffId)).toMatchObject({ state: 'settled', workChatId: null, acceptedAt: null })
  })

  it('rejects without creating a thread or running an outcome, including a racing Accept', async () => {
    const outcome = vi.fn(async () => 'must not run')
    const h = await harness('dm', { outcome })
    const proposal = await propose(h)
    const before = await h.store.listChats()
    const rejecting = h.module.reject(proposal.workHandoffId)
    const accepting = h.module.accept(proposal.workHandoffId)
    await rejecting
    await expect(accepting).rejects.toThrow('no longer awaiting acceptance')
    await h.module.reject(proposal.workHandoffId)
    expect((await h.store.listChats()).length).toBe(before.length)
    expect(h.started).toEqual([])
    expect(outcome).not.toHaveBeenCalled()
    expect((await h.store.listWorkHandoffs())[0]).toMatchObject({ workChatId: null, state: 'settled', result: 'Rejected before work started.' })
  })

  it('does not reject work when a racing Accept already won', async () => {
    const h = await harness()
    const proposal = await propose(h)
    const accepting = h.module.accept(proposal.workHandoffId)
    // Let Accept enter the shared lifecycle queue.
    await Promise.resolve()
    const rejecting = h.module.reject(proposal.workHandoffId)
    await accepting
    await expect(rejecting).rejects.toThrow('already been accepted')
    expect(h.started).toHaveLength(1)
  })

  it('keeps a deleted project proposal as a tombstone and refuses acceptance', async () => {
    const h = await harness()
    const proposal = await propose(h)
    await h.store.deleteProject(h.projectId)
    await expect(h.module.accept(proposal.workHandoffId)).rejects.toThrow('no longer awaiting acceptance')
    expect((await h.store.listWorkHandoffs())[0]).toMatchObject({ workChatId: null, state: 'deleted' })
    expect(h.started).toEqual([])
  })

  it('rolls back an unsuccessful acceptance and retries without orphan threads', async () => {
    const h = await harness()
    const proposal = await propose(h)
    vi.spyOn(h.store, 'acceptWorkHandoff').mockRejectedValueOnce(new Error('write failed'))
    await expect(h.module.accept(proposal.workHandoffId)).rejects.toThrow('write failed')
    expect((await h.store.listWorkHandoffs())[0]).toMatchObject({ workChatId: null, acceptedAt: null })
    expect((await h.store.listChats()).filter((chat) => chat.title === input(h.projectId).title)).toEqual([])
    expect(h.started).toEqual([])
    await h.module.accept(proposal.workHandoffId)
    expect(h.started).toHaveLength(1)
  })

  it('prepares isolation before acceptance and lets Git refusal retry', async () => {
    const prepareCheckout = vi.fn(async (_chatId: string, _checkout: CheckoutRequest, _accept: () => Promise<void>): Promise<void> => { throw new Error('git refused') })
    const h = await harness('dm', { prepareCheckout })
    const proposal = await propose(h)
    await expect(h.module.accept(proposal.workHandoffId, { checkout: { mode: 'worktree' } })).rejects.toThrow('git refused')
    expect((await h.store.listWorkHandoffs())[0]).toMatchObject({ workChatId: null, acceptedAt: null })
    prepareCheckout.mockImplementation(async (chatId, _checkout, accept) => {
      expect((await h.store.workHandoffForTarget(chatId))?.acceptedAt).toBeNull()
      expect(h.started).toEqual([])
      await accept()
    })
    await Promise.all([h.module.accept(proposal.workHandoffId, { checkout: { mode: 'worktree' } }), h.module.accept(proposal.workHandoffId, { checkout: { mode: 'worktree' } })])
    expect(prepareCheckout).toHaveBeenCalledTimes(2)
    expect(h.started).toHaveLength(1)
  })

  it('returns the accepted target when directory delivery fails and does not restart on retry', async () => {
    const h = await harness('dm', { directoryError: new Error('delivery failed') })
    const proposal = await propose(h)
    const target = await h.module.accept(proposal.workHandoffId)
    const saved = (await h.store.listWorkHandoffs())[0]
    expect(saved).toMatchObject({ workChatId: expect.any(String), acceptedAt: expect.any(Number) })
    expect(target).toBe(saved?.workChatId)
    await expect(h.module.accept(proposal.workHandoffId)).resolves.toBe(target)
    expect((await h.store.listWorkHandoffs())[0]?.workChatId).toBe(target)
    expect(h.started).toHaveLength(1)
  })

  it('rejects legacy pending content without deleting it or starting an outcome writer', async () => {
    const outcome = vi.fn(async () => 'must not run')
    const h = await harness('dm', { outcome })
    const proposal = await propose(h)
    const held = await h.store.materializeWorkHandoff(proposal.workHandoffId)
    await h.store.appendEvent(held.workChatId!, { type: 'agent_message', agentId: 'sage', turnId: 'legacy', text: 'Keep this existing work.' })
    const before = await h.store.loadEvents(held.workChatId!)
    await h.module.reject(proposal.workHandoffId)
    expect(await h.store.loadEvents(held.workChatId!)).toEqual(before)
    expect(await h.store.getChat(held.workChatId!)).toMatchObject({ settledAt: expect.any(Number) })
    expect(outcome).not.toHaveBeenCalled()
    expect(h.started).toEqual([])
  })

  it('starts from an edited task and keeps it on the proposal', async () => {
    const h = await harness()
    const proposal = await propose(h)
    const edited = 'Implement the handoff, but keep the source transcript out of Work.'
    const workChatId = await h.module.accept(proposal.workHandoffId, { mode: 'house', task: edited })
    expect(h.started).toEqual([expect.objectContaining({ chatId: workChatId, text: edited })])
    expect((await h.store.loadEvents(workChatId))[0]).toMatchObject({ type: 'user_message', text: edited })
    expect((await h.store.listWorkHandoffs())[0]).toMatchObject({ task: edited, summary: input(h.projectId).summary })
    // A lost-ack retry repeats the same edit and must land on the same session.
    expect(await h.module.accept(proposal.workHandoffId, { mode: 'house', task: edited })).toBe(workChatId)
    expect(h.started).toHaveLength(1)
  })

  it('refuses a prompt edit once the session exists', async () => {
    const h = await harness()
    const proposal = await propose(h)
    const held = await h.store.materializeWorkHandoff(proposal.workHandoffId)
    await h.store.appendEvent(held.workChatId!, { type: 'agent_message', agentId: 'sage', turnId: 'old_turn', text: 'Already working.' })
    await expect(h.module.accept(proposal.workHandoffId, { mode: 'house', task: 'Something else.' })).rejects.toThrow('can no longer be edited')
    expect((await h.store.listWorkHandoffs())[0]?.task).toBe(input(h.projectId).task)
    expect(h.started).toEqual([])
  })

  it('accepts a legacy started handoff without replaying or replacing it', async () => {
    const h = await harness()
    const proposal = await propose(h)
    const held = await h.store.materializeWorkHandoff(proposal.workHandoffId)
    await h.store.appendEvent(held.workChatId!, { type: 'agent_message', agentId: 'sage', turnId: 'old_turn', text: 'Already working.' })
    await expect(h.module.accept(held.workChatId!, { checkout: { mode: 'worktree' } })).rejects.toThrow('already started')
    expect(await h.module.accept(held.workChatId!)).toBe(held.workChatId)
    expect(h.started).toEqual([])
  })

  it('refuses a stale turn and supporting personas outside the current lead allowlist', async () => {
    const stopped = await harness('dm', { active: false })
    await expect(stopped.module.useTool(
      { ...context, chatId: stopped.source.id },
      input(stopped.projectId),
    )).rejects.toThrow('no longer active')

    const blocked = await harness('dm', { agents: [sage, smith] })
    await expect(blocked.module.useTool(
      { ...context, chatId: blocked.source.id },
      input(blocked.projectId),
    )).rejects.toThrow('Sage cannot summon: Smith')
    expect(await blocked.store.listWorkHandoffs()).toEqual([])

    const deleted = await harness()
    await deleted.store.deleteChat(deleted.source.id)
    await expect(deleted.module.useTool(
      { ...context, chatId: deleted.source.id },
      input(deleted.projectId),
    )).rejects.toThrow('Sessions can only be handed off from Agents')
  })

  it('keeps committed Work pending when directory delivery fails', async () => {
    const h = await harness('dm', { directoryError: new Error('broadcast unavailable') })

    const result = await h.module.useTool({ ...context, chatId: h.source.id }, input(h.projectId))
    expect(h.started).toHaveLength(0)

    expect(result).toMatchObject({ workChatId: null })
    expect((await h.store.listWorkHandoffs())[0]).toMatchObject({ workChatId: null, version: 1 })
    expect(h.discarded).toEqual([])
  })

  it('lets a chat persona author a handoff led by a named Session persona', async () => {
    const dmLead = await harness('dm', { agents: [{ ...lead, placement: 'chat' }, smith] })
    const proposal = await propose(dmLead)
    const created = { workChatId: await dmLead.module.accept(proposal.workHandoffId) }

    expect((await dmLead.store.listWorkHandoffs())[0]).toMatchObject({
      leadAgentId: 'smith',
      supportingAgentIds: [],
    })
    expect(await dmLead.store.loadEvents(created.workChatId)).toContainEqual(expect.objectContaining({
      type: 'user_message',
      workAuthorAgentId: 'sage',
      workTargetLeadId: 'smith',
      workSupportingAgentIds: [],
    }))
    await dmLead.module.accept(created.workChatId)
    expect(dmLead.started[0]?.origin).toMatchObject({ authorAgentId: 'sage', targetAgentId: 'smith' })
  })

  it('requires a chat handoff author to name a Session persona', async () => {
    const dmLead = await harness('dm', { agents: [{ ...lead, placement: 'chat' }, smith] })
    await expect(dmLead.module.useTool(
      { ...context, chatId: dmLead.source.id },
      { ...input(dmLead.projectId), supportingPersonas: [] },
    )).rejects.toThrow('Name a Session persona as firstExecutor')

    const dmTarget = await harness('dm', { agents: [{ ...lead, placement: 'chat' }, { ...smith, placement: 'chat' }] })
    await expect(dmTarget.module.useTool(
      { ...context, chatId: dmTarget.source.id },
      input(dmTarget.projectId),
    )).rejects.toThrow('Name a Session persona as firstExecutor')
  })

  it('does not let a chat persona join project work as support', async () => {
    const dmSupport = await harness('dm', { agents: [lead, { ...smith, placement: 'chat' }] })
    await expect(dmSupport.module.useTool(
      { ...context, chatId: dmSupport.source.id },
      input(dmSupport.projectId),
    )).rejects.toThrow('Chat personas cannot join project work: Smith')
  })
})

describe('WorkModule proposal revisions', () => {
  type Proposal = { workHandoffId: string; version: number; supersededHandoffId?: string; reused: boolean }
  const revise = async (h: Awaited<ReturnType<typeof harness>>, turnId: string, overrides = {}) =>
    await h.module.useTool({ ...context, chatId: h.source.id, turnId }, { ...input(h.projectId), ...overrides }) as Proposal
  const handoff = async (h: Awaited<ReturnType<typeof harness>>, id: string) =>
    (await h.store.listWorkHandoffs()).find((row) => row.id === id)

  it('replaces a pending proposal revised in a later turn and counts versions up', async () => {
    const h = await harness()
    const first = await revise(h, 'turn_1')
    expect(first).toMatchObject({ version: 1, reused: false })
    expect(first.supersededHandoffId).toBeUndefined()
    const second = await revise(h, 'turn_2', { title: 'Ship handoffs, revised' })
    expect(second).toMatchObject({ version: 2, supersededHandoffId: first.workHandoffId, reused: false })
    expect(await handoff(h, first.workHandoffId)).toMatchObject({
      state: 'settled', supersededById: second.workHandoffId, result: 'Replaced by v2.', acceptedAt: null, workChatId: null,
    })
    const third = await revise(h, 'turn_3')
    expect(third).toMatchObject({ version: 3, supersededHandoffId: second.workHandoffId })
    expect(await handoff(h, third.workHandoffId)).toMatchObject({ revision: 3, state: 'active', title: 'Ship handoffs' })
    // Another assignment in the same Chat is its own proposal, untouched by the revision.
    const other = await revise(h, 'turn_3', { assignmentKey: 'other' })
    expect(other).toMatchObject({ version: 1 })
    const waiting = (await h.store.listWorkHandoffs()).filter((row) => row.state === 'active')
    expect(waiting.map((row) => row.id)).toEqual([third.workHandoffId, other.workHandoffId])
    expect(h.started).toEqual([])
  })

  it('refuses Accept and Reject on a replaced proposal and still accepts the current one', async () => {
    const h = await harness()
    const first = await revise(h, 'turn_1')
    const second = await revise(h, 'turn_2')
    const chats = (await h.store.listChats()).length
    const directories = h.directories()
    await expect(h.module.accept(first.workHandoffId)).rejects.toThrow('A newer version replaced this proposal')
    await expect(h.module.reject(first.workHandoffId)).rejects.toThrow('A newer version replaced this proposal')
    // Each refusal resends the directory, so a stale client redraws with the current version.
    expect(h.directories()).toBe(directories + 2)
    expect((await h.store.listChats()).length).toBe(chats)
    expect(await handoff(h, first.workHandoffId)).toMatchObject({ state: 'settled', supersededById: second.workHandoffId })
    const target = await h.module.accept(second.workHandoffId)
    expect(h.started.map((row) => row.origin.handoffId)).toEqual([second.workHandoffId])
    expect(await h.store.workHandoffForTarget(target)).toMatchObject({ id: second.workHandoffId, acceptedAt: expect.any(Number) })
  })

  it('starts a fresh v1 when the earlier proposal was already accepted or rejected', async () => {
    const h = await harness()
    const accepted = await revise(h, 'turn_1')
    await h.module.accept(accepted.workHandoffId)
    const afterAccept = await revise(h, 'turn_2')
    expect(afterAccept).toMatchObject({ version: 1, reused: false })
    expect(afterAccept.supersededHandoffId).toBeUndefined()
    expect(await handoff(h, accepted.workHandoffId)).toMatchObject({ state: 'active', acceptedAt: expect.any(Number) })
    expect((await handoff(h, accepted.workHandoffId))?.supersededById).toBeUndefined()

    const rejected = await revise(h, 'turn_1', { assignmentKey: 'rejected' })
    await h.module.reject(rejected.workHandoffId)
    const afterReject = await revise(h, 'turn_2', { assignmentKey: 'rejected' })
    expect(afterReject).toMatchObject({ version: 1 })
    expect(afterReject.supersededHandoffId).toBeUndefined()
    expect(await handoff(h, rejected.workHandoffId)).toMatchObject({ result: 'Rejected before work started.' })
  })

  it('keeps a same-turn retry idempotent, before and after a revision', async () => {
    const h = await harness()
    const first = await revise(h, 'turn_1')
    expect(await revise(h, 'turn_1', { title: 'Reworded retry' })).toMatchObject({ workHandoffId: first.workHandoffId, version: 1, reused: true })
    const second = await revise(h, 'turn_2')
    const retried = await revise(h, 'turn_2', { title: 'Reworded retry' })
    expect(retried).toMatchObject({ workHandoffId: second.workHandoffId, version: 2, supersededHandoffId: first.workHandoffId, reused: true })
    expect(await h.store.listWorkHandoffs()).toHaveLength(2)
    expect((await h.store.loadEvents(h.source.id)).filter((event) => event.type === 'system_note' && event.workHandoffPhase === 'created')).toHaveLength(2)
  })

  it('never starts the old version when Accept races a revision', async () => {
    const h = await harness()
    const first = await revise(h, 'turn_1')
    const [accepting, revising] = await Promise.allSettled([h.module.accept(first.workHandoffId), revise(h, 'turn_2')])
    const old = await handoff(h, first.workHandoffId)
    if (accepting.status === 'fulfilled') {
      expect(old).toMatchObject({ acceptedAt: expect.any(Number) })
      expect(old?.supersededById).toBeUndefined()
      expect(revising).toMatchObject({ status: 'fulfilled', value: { version: 1 } })
    } else {
      expect(old).toMatchObject({ state: 'settled', acceptedAt: null })
      expect(h.started).toEqual([])
    }
    expect((await h.store.listWorkHandoffs()).filter((row) => row.state === 'active' && row.acceptedAt === null)).toHaveLength(1)
  })
})

describe('WorkModule lifecycle', () => {
  it('releases a halt after a failed lifecycle write but retains it after committed delivery fails', async () => {
    const h = await harness('dm', { directoryError: new Error('delivery failed') })
    const proposal = await propose(h)
    const materialized = await h.store.materializeWorkHandoff(proposal.workHandoffId)
    const created = { workChatId: materialized.workChatId! }
    const transition = vi.spyOn(h.store, 'transitionWorkLifecycle').mockRejectedValueOnce(new Error('write failed'))

    await expect(h.module.setSettled(created.workChatId, true)).rejects.toThrow('write failed')
    expect(await h.store.getChat(created.workChatId)).toMatchObject({ settledAt: null })
    expect(h.resumed).toEqual([created.workChatId])

    transition.mockRestore()
    await expect(h.module.setSettled(created.workChatId, true)).rejects.toThrow('delivery failed')
    expect((await h.store.getChat(created.workChatId))?.settledAt).not.toBeNull()
    expect(h.resumed).toEqual([created.workChatId])
    expect(h.stopped.at(-1)).toBe(created.workChatId)
  })

  it('reports one manual outcome, withdraws it on reopen and never duplicates either note', async () => {
    const h = await harness('dm', { outcome: async () => 'The linked handoff shipped; nothing remains open.' })
    const created = await acceptedWork(h)
    await h.module.accept(created.workChatId)

    await h.module.setSettled(created.workChatId, true)
    await h.module.setSettled(created.workChatId, true)
    await until(() => noteSent(h, 'Session “Ship handoffs” settled: '), 'the outcome to land')
    expect(h.stopped).toEqual([created.workChatId, created.workChatId])
    expect((await h.store.listWorkHandoffs())[0]).toMatchObject({
      state: 'settled',
      result: 'The linked handoff shipped; nothing remains open.',
      version: 2,
    })
    expect((await h.store.loadEvents(h.source.id)).filter(
      (event) => event.type === 'system_note' && event.workHandoffPhase === 'settled',
    )).toHaveLength(1)

    await h.module.setSettled(created.workChatId, false)
    await h.module.setSettled(created.workChatId, false)
    expect(h.resumed).toEqual([created.workChatId, created.workChatId, created.workChatId])
    expect((await h.store.listWorkHandoffs())[0]).toMatchObject({ state: 'active', result: null, version: 3 })
    expect((await h.store.loadEvents(h.source.id)).filter(
      (event) => event.type === 'system_note' && event.workHandoffPhase === 'reopened',
    )).toHaveLength(1)
  })

  it('settles before the outcome is written and fills the outcome into the same note', async () => {
    const outcome = held()
    const h = await harness('dm', { outcome: outcome.run })
    const created = await acceptedWork(h)
    await h.module.accept(created.workChatId)

    await h.module.setSettled(created.workChatId, true)

    expect(outcome.started()).toBe(true)
    expect(await h.store.getChat(created.workChatId)).toMatchObject({ settledAt: expect.any(Number) })
    expect((await h.store.listWorkHandoffs())[0]).toMatchObject({ state: 'settled', result: null, version: 2 })
    expect(h.stopped).toEqual([created.workChatId])
    expect(h.directories()).toBeGreaterThan(0)
    const pending = settledNotes(await h.store.loadEvents(h.source.id))
    expect(pending).toMatchObject([{ text: 'Session “Ship handoffs” settled.' }])

    outcome.release('The export button shipped.')
    await until(() => noteSent(h, 'Session “Ship handoffs” settled: The export button shipped.'), 'the late outcome')

    expect((await h.store.listWorkHandoffs())[0]).toMatchObject({ state: 'settled', result: 'The export button shipped.', version: 2 })
    expect(settledNotes(await h.store.loadEvents(h.source.id))).toEqual([
      { ...pending[0], text: 'Session “Ship handoffs” settled: The export button shipped.' },
    ])
  })

  it('keeps a reopen made while the outcome is written, drops the late outcome and fills a later settle', async () => {
    const first = held()
    const second = held()
    const runs = [first, second]
    const h = await harness('dm', { outcome: () => runs.shift()!.run() })
    const created = await acceptedWork(h)
    await h.module.accept(created.workChatId)

    await h.module.setSettled(created.workChatId, true)
    expect(first.started()).toBe(true)
    await h.module.setSettled(created.workChatId, false)
    first.release('This stale result must not land.')
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect((await h.store.listWorkHandoffs())[0]).toMatchObject({ state: 'active', result: null, version: 3 })
    expect(await h.store.getChat(created.workChatId)).toMatchObject({ settledAt: null })
    expect(noteSent(h, 'Session “Ship handoffs” settled: ')).toBe(false)
    expect(settledNotes(await h.store.loadEvents(h.source.id))).toMatchObject([{ text: 'Session “Ship handoffs” settled.' }])
    await h.store.settleIdleChats(Date.now() + 1)
    expect((await h.store.listWorkHandoffs())[0]).toMatchObject({ state: 'active', version: 3 })

    await h.module.setSettled(created.workChatId, true)
    second.release('The second settle carries the outcome.')
    await until(() => noteSent(h, 'Session “Ship handoffs” settled: The second settle carries the outcome.'), 'the second outcome')
    expect((await h.store.listWorkHandoffs())[0]).toMatchObject({ state: 'settled', result: 'The second settle carries the outcome.', version: 4 })
    expect(settledNotes(await h.store.loadEvents(h.source.id)).map((note) => note.text)).toEqual([
      'Session “Ship handoffs” settled.',
      'Session “Ship handoffs” settled: The second settle carries the outcome.',
    ])
  })

  it('lets a reopen queued behind a settle win without writing either outcome', async () => {
    const outcome = held()
    const h = await harness('dm', { outcome: outcome.run })
    const created = await acceptedWork(h)
    await h.module.accept(created.workChatId)

    await Promise.all([h.module.setSettled(created.workChatId, true), h.module.setSettled(created.workChatId, false)])

    expect(outcome.started()).toBe(false)
    expect((await h.store.listWorkHandoffs())[0]).toMatchObject({ state: 'active', result: null, version: 1 })
    expect(await h.store.getChat(created.workChatId)).toMatchObject({ settledAt: null })
    expect(settledNotes(await h.store.loadEvents(h.source.id))).toEqual([])
  })

  it('drops an outcome that arrives while an Unsettle is still on its way', async () => {
    const outcome = held()
    const h = await harness('dm', { outcome: outcome.run })
    const created = await acceptedWork(h)
    await h.module.accept(created.workChatId)
    await h.module.setSettled(created.workChatId, true)
    const write = vi.spyOn(h.store, 'recordWorkOutcome')

    const reopening = h.module.setSettled(created.workChatId, false)
    outcome.release('This stale result must not land.')
    await reopening
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(write).not.toHaveBeenCalled()
    expect(noteSent(h, 'Session “Ship handoffs” settled: ')).toBe(false)
    expect((await h.store.listWorkHandoffs())[0]).toMatchObject({ state: 'active', result: null })
  })

  it('never broadcasts an Unsettle a newer Settle already replaced, and still fills the outcome', async () => {
    const outcome = held()
    const h = await harness('dm', { outcome: outcome.run })
    const created = await acceptedWork(h)
    await h.module.accept(created.workChatId)
    await h.module.setSettled(created.workChatId, true)
    const start = h.directoryStates.length

    await Promise.all([h.module.setSettled(created.workChatId, false), h.module.setSettled(created.workChatId, true)])

    expect(await h.store.getChat(created.workChatId)).toMatchObject({ settledAt: expect.any(Number) })
    expect(h.directoryStates.slice(start).map((rows) => rows.get(created.workChatId))).not.toContain(null)
    outcome.release('The export button shipped.')
    await until(() => noteSent(h, 'Session “Ship handoffs” settled: The export button shipped.'), 'the outcome')
    expect((await h.store.listWorkHandoffs())[0]).toMatchObject({ state: 'settled', result: 'The export button shipped.', version: 2 })
  })

  it('delivers a reopen after the outcome directory that was already on its way', async () => {
    const outcome = held()
    /** Holds the next directory between its read and its delivery, once. */
    let holdNext: (() => Promise<void>) | undefined
    const h = await harness('dm', { outcome: outcome.run, beforeDelivery: async () => {
      const hold = holdNext
      holdNext = undefined
      await hold?.()
    } })
    const created = await acceptedWork(h)
    await h.module.accept(created.workChatId)
    await h.module.setSettled(created.workChatId, true)
    let blocked = false
    let release = () => undefined as void
    holdNext = () => { blocked = true; return new Promise<void>((resolve) => { release = resolve }) }

    outcome.release('Shipped.')
    await until(() => blocked, 'the outcome directory to wait before delivery')
    const reopening = h.module.setSettled(created.workChatId, false)
    await new Promise((resolve) => setTimeout(resolve, 10))
    release()
    await reopening
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(await h.store.getChat(created.workChatId)).toMatchObject({ settledAt: null })
    expect(h.directoryStates.at(-1)?.get(created.workChatId)).toBeNull()
  })

  it('keeps a deleted target and its outcome as a durable tombstone', async () => {
    const h = await harness('dm', { outcome: async () => 'The handoff shipped.' })
    const created = await acceptedWork(h)
    await h.module.accept(created.workChatId)
    await h.module.setSettled(created.workChatId, true)
    await until(() => noteSent(h, 'Session “Ship handoffs” settled: The handoff shipped.'), 'the outcome to land')

    await h.store.deleteChat(created.workChatId)

    expect((await h.store.listWorkHandoffs())[0]).toMatchObject({
      workChatId: null,
      title: 'Ship handoffs',
      projectName: expect.any(String),
      leadAgentName: 'Sage',
      state: 'deleted',
      result: 'The handoff shipped.',
    })
  })

  it('settles honestly when the disposable outcome writer is unavailable', async () => {
    const h = await harness('dm', { outcome: async () => { throw new Error('both providers unavailable') } })
    const created = await acceptedWork(h)
    await h.module.accept(created.workChatId)

    await h.module.setSettled(created.workChatId, true)
    await until(() => noteSent(h, 'Session “Ship handoffs” settled · outcome unavailable.'), 'the unavailable note')

    expect((await h.store.listWorkHandoffs())[0]).toMatchObject({ state: 'settled', result: null, version: 2 })
    expect(await h.store.loadEvents(h.source.id)).toContainEqual(expect.objectContaining({
      type: 'system_note',
      workHandoffPhase: 'settled',
      text: 'Session “Ship handoffs” settled · outcome unavailable.',
    }))
  })
})

describe('WorkModule completion in the shared checkout', () => {
  const roots: string[] = []
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {
    cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' }, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
  // The check runs real git in a temp repo; under a full parallel suite that outlasts waitFor's 1s default.
  const statusOf = (h: Awaited<ReturnType<typeof harness>>, chatId: string, want: string) => vi.waitFor(async () =>
    expect((await h.store.workHandoffForTarget(chatId))?.goalCompletion?.status).toBe(want), { timeout: 15_000 })
  const lines = (marks: Partial<Record<number, string>>) => Array.from({ length: 12 }, (_, at) => marks[at] ?? `line ${at}`).join('\n') + '\n'

  /** A published result in the plain linked checkout; `files` are what its turns measured. */
  async function published(seed: Record<string, string>, edits: Record<string, string>, legacy = false, preexisting: Record<string, string> = {}) {
    const h = await harness()
    const root = mkdtempSync(path.join(os.tmpdir(), 'manor-shared-checkout-'))
    roots.push(root)
    git(root, 'init', '-q', '-b', 'main')
    git(root, 'config', 'user.name', 'Test')
    git(root, 'config', 'user.email', 'test@example.test')
    for (const [file, text] of Object.entries(seed)) writeFileSync(path.join(root, file), text)
    git(root, 'add', '.')
    git(root, 'commit', '-qm', 'Initial')
    for (const [file, text] of Object.entries(preexisting)) writeFileSync(path.join(root, file), text)
    const before = await captureTurnTree(root)
    for (const [file, text] of Object.entries(edits)) writeFileSync(path.join(root, file), text)
    await h.store.updateProject(h.projectId, 'Manor', [root])
    const { workChatId } = await acceptedWork(h)
    // Prose only, so the Multiple review gate stays out of the way.
    const files = Object.keys(edits).map((file) => path.join(root, file))
    await h.store.appendEvent(workChatId, { type: 'turn_result', agentId: 'sage', turnId: 'edit',
      fileChanges: await diffTurnTrees(root, before, await captureTurnTree(root)),
    })
    const handoff = (await h.store.workHandoffForTarget(workChatId))!
    const completion = { ...await prepareWorkCompletion([root], files, []), status: 'ready' as const, completedAt: undefined }
    await h.store.reachWorkGoal(handoff.id, { type: 'system_note', kind: 'info', text: 'Ready.', workGoalHandoffId: handoff.id,
      ...(legacy ? {} : { goalReport: { result: 'Done.' }, goalCompletion: completion }) })
    // The commit turn: whatever `commitTurn` does, then the request reads as dispatched.
    let commitTurn = () => undefined as void
    h.orchestrator.runStoredUserMessage.mockImplementation(async (chatId: string, event: ThreadEvent) => {
      commitTurn()
      if (event.type === 'user_message') await h.store.replaceEvent(chatId, { ...event, dispatchState: 'completed' })
      return undefined
    })
    return { h, root, workChatId, handoffId: handoff.id, onCommit: (run: () => void) => { commitTurn = run } }
  }

  it('completes a confirmed result when its own hunk lands and another Session’s hunk stays dirty', async () => {
    const s = await published({ 'shared.md': lines({}) }, { 'shared.md': lines({ 0: 'mine', 11: 'theirs' }) },
      false, { 'shared.md': lines({ 11: 'theirs' }) })
    s.onCommit(() => {
      writeFileSync(path.join(s.root, 'shared.md'), lines({ 0: 'mine' }))
      git(s.root, 'commit', '-qam', 'This Session, its own hunk only')
      writeFileSync(path.join(s.root, 'shared.md'), lines({ 0: 'mine', 11: 'theirs' }))
    })
    const ready = (await s.h.store.workHandoffForTarget(s.workChatId))!
    await s.h.module.confirmGoal(s.handoffId, undefined, ready.version)
    await statusOf(s.h, s.workChatId, 'complete')
    expect(git(s.root, 'diff', '--name-only')).toBe('shared.md')
    const requestId = (await s.h.store.workHandoffForTarget(s.workChatId))?.goalCompletion?.requestEventId
    expect((await s.h.store.loadEvents(s.workChatId)).find((event) => event.id === requestId))
      .toMatchObject({ type: 'user_message', confirmRequest: { variant: 'checkout', worktrees: [] } })
  })

  it('ticks the commit from Git while the commit turn still runs, so Confirm’s card moves step by step', async () => {
    const s = await published({ 'own.md': 'before\n' }, { 'own.md': 'after\n' })
    let finish = () => undefined as void
    const turnOpen = new Promise<void>((resolve) => { finish = resolve })
    s.h.orchestrator.runStoredUserMessage.mockImplementation(async (chatId: string, event: ThreadEvent) => {
      git(s.root, 'commit', '-qam', 'Accepted result')
      await turnOpen
      if (event.type === 'user_message') await s.h.store.replaceEvent(chatId, { ...event, dispatchState: 'completed' })
      return undefined
    })
    const ready = (await s.h.store.workHandoffForTarget(s.workChatId))!
    await s.h.module.confirmGoal(s.handoffId, undefined, ready.version)
    await vi.waitFor(async () => expect((await s.h.store.workHandoffForTarget(s.workChatId))?.goalCompletion)
      .toMatchObject({ status: 'pending', committed: [expect.any(String)] }), { timeout: 8_000 })
    finish()
    await statusOf(s.h, s.workChatId, 'complete')
  }, 15_000)

  it('stores a legacy result commit request atomically so Confirm does not reopen itself', async () => {
    const s = await published({ 'own.md': 'before\n' }, { 'own.md': 'after\n' }, true)
    s.onCommit(() => { git(s.root, 'commit', '-qam', 'Legacy result') })
    const ready = (await s.h.store.workHandoffForTarget(s.workChatId))!
    expect(ready.goalReport).toBeUndefined()
    await s.h.module.confirmGoal(s.handoffId)
    await statusOf(s.h, s.workChatId, 'complete')
    const confirmed = (await s.h.store.workHandoffForTarget(s.workChatId))!
    expect(confirmed.goalConfirmedAt).toEqual(expect.any(Number))
    expect(confirmed.goalReachedAt).toBe(ready.goalReachedAt)
    expect(confirmed.goalConfirmations).toBeUndefined()
    expect(s.h.orchestrator.runStoredUserMessage).toHaveBeenCalledWith(s.workChatId,
      expect.objectContaining({ id: confirmed.goalCompletion?.requestEventId, type: 'user_message' }))
  })

  it('automatically rechecks an archived blocked commit without confirming the new work', async () => {
    const s = await published({ 'own.md': 'before\n' }, { 'own.md': 'after\n' })
    const ready = (await s.h.store.workHandoffForTarget(s.workChatId))!
    await s.h.module.confirmGoal(s.handoffId, undefined, ready.version)
    await statusOf(s.h, s.workChatId, 'blocked')
    await s.h.store.appendEvent(s.workChatId, { type: 'user_message', text: 'New task.', mentions: [] })
    git(s.root, 'commit', '-qam', 'Previous accepted result')
    await s.h.module.recheckBlocked()
    const current = (await s.h.store.workHandoffForTarget(s.workChatId))!
    expect(current.goalConfirmations?.[0]?.completion?.status).toBe('complete')
    expect(current.goalConfirmedAt).toBeUndefined()
    expect(current.goalReachedAt).toBeUndefined()
  })

  it('confirms a result after another Session committed files it also measured, and commits only its own', async () => {
    const s = await published({ 'own.md': 'a\n', 'other.md': 'a\n' }, { 'own.md': 'mine\n', 'other.md': 'theirs\n' })
    expect((await s.h.store.workHandoffForTarget(s.workChatId))?.goalCompletion?.repos[0]?.files.sort()).toEqual(['other.md', 'own.md'])
    // The other Session's commit lands between publication and Confirm (a slow pre-commit hook on 10-11).
    git(s.root, 'add', 'other.md')
    git(s.root, 'commit', '-qm', 'Another Session')
    s.onCommit(() => { git(s.root, 'add', 'own.md'); git(s.root, 'commit', '-qm', 'This Session') })

    const ready = (await s.h.store.workHandoffForTarget(s.workChatId))!
    await s.h.module.confirmGoal(s.handoffId, undefined, ready.version)

    const confirmed = (await s.h.store.workHandoffForTarget(s.workChatId))!
    expect(confirmed.goalConfirmedAt).toEqual(expect.any(Number))
    expect(confirmed.goalCompletion?.repos[0]?.files).toEqual(['own.md'])
    await statusOf(s.h, s.workChatId, 'complete')
  })

  it('moves a blocked commit to complete once main carries the published contents, also when the commit came from outside Manor', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    onTestFinished(() => { vi.useRealTimers() })
    // Both Sessions edited one shared file: this one line 0, the other line 11.
    const s = await published({ 'shared.md': lines({}) }, { 'shared.md': lines({ 0: 'mine', 11: 'theirs' }) })
    s.onCommit(() => {
      writeFileSync(path.join(s.root, 'shared.md'), lines({ 0: 'mine' }))
      git(s.root, 'commit', '-qam', 'This Session, its own hunk only')
      writeFileSync(path.join(s.root, 'shared.md'), lines({ 0: 'mine', 11: 'theirs' }))
    })
    const ready = (await s.h.store.workHandoffForTarget(s.workChatId))!
    await s.h.module.confirmGoal(s.handoffId, undefined, ready.version)
    await statusOf(s.h, s.workChatId, 'blocked')
    expect((await s.h.store.workHandoffForTarget(s.workChatId))?.goalCompletion?.message).toBe('shared.md is not committed on main.')

    await s.h.module.recheckBlocked()
    expect((await s.h.store.workHandoffForTarget(s.workChatId))?.goalCompletion?.status).toBe('blocked')

    // The other Session's hunk lands from a terminal: no exchange ends and no chat opens.
    git(s.root, 'commit', '-qam', 'Another Session')
    const directories = s.h.directories()
    await vi.advanceTimersByTimeAsync(30_000)
    await statusOf(s.h, s.workChatId, 'complete')
    expect(s.h.directories()).toBeGreaterThan(directories)
  })

  it('names the lead\'s stop on a blocked card, and Retry with unchanged files lands under the same approval and settles', async () => {
    const s = await published({ 'own.md': 'before\n' }, { 'own.md': 'after\n' })
    s.onCommit(() => undefined)
    s.h.orchestrator.runStoredUserMessage.mockImplementationOnce(async (chatId: string, event: ThreadEvent) => {
      await s.h.store.appendEvent(chatId, { type: 'agent_message', agentId: 'sage', turnId: 'commit',
        text: 'I tried.\n\n**Real failure:** the pre-commit hook failed in apps/web tests. Then more detail here.' })
      if (event.type === 'user_message') await s.h.store.replaceEvent(chatId, { ...event, dispatchState: 'completed' })
      return undefined
    })
    const ready = (await s.h.store.workHandoffForTarget(s.workChatId))!
    await s.h.module.confirmGoal(s.handoffId, undefined, ready.version)
    await statusOf(s.h, s.workChatId, 'blocked')
    const blocked = (await s.h.store.workHandoffForTarget(s.workChatId))!
    expect(blocked.goalCompletion).toMatchObject({ message: 'The pre-commit hook failed in apps/web tests.' })
    expect(blocked.goalCompletion?.retryRefused).toBeUndefined()

    s.onCommit(() => { git(s.root, 'commit', '-qam', 'Retried') })
    await s.h.module.retryCompletion(s.handoffId)
    await statusOf(s.h, s.workChatId, 'complete')
    const done = (await s.h.store.workHandoffForTarget(s.workChatId))!
    // The same approval landed: nothing reopened, no new result, no second Confirm.
    expect(done).toMatchObject({ goalConfirmedAt: blocked.goalConfirmedAt, goalReachedAt: blocked.goalReachedAt, goalReport: blocked.goalReport })
    expect(done.goalConfirmations).toBeUndefined()
    expect((await s.h.store.loadEvents(s.h.source.id)).some((event) => event.type === 'system_note' && event.workHandoffPhase === 'reopened')).toBe(false)
    expect(done.goalCompletion?.requestEventId).toBe(blocked.goalCompletion?.requestEventId)
    expect(done.goalCompletion?.retries).toHaveLength(1)
    const retry = (await s.h.store.loadEvents(s.workChatId)).find((event) => event.id === done.goalCompletion?.retries?.[0])
    expect(retry).toMatchObject({ type: 'user_message', confirmRequest: { variant: 'checkout' } })
    expect(retry?.type === 'user_message' ? retry.instruction : '').toContain('- ' + path.basename(s.root) + '/own.md')
    // Landed, so the Session settles; a shared checkout has no branch of its own to touch.
    await vi.waitFor(async () => expect((await s.h.store.workHandoffForTarget(s.workChatId))?.state).toBe('settled'))
    expect((await s.h.store.getChat(s.workChatId))?.settledAt).toEqual(expect.any(Number))
    expect(git(s.root, 'branch', '--format=%(refname:short)')).toBe('main')
  })

  it('refuses Retry once an approved file changed after Confirm, and says why on the card', async () => {
    const s = await published({ 'own.md': 'before\n' }, { 'own.md': 'after\n' })
    const ready = (await s.h.store.workHandoffForTarget(s.workChatId))!
    await s.h.module.confirmGoal(s.handoffId, undefined, ready.version)
    await statusOf(s.h, s.workChatId, 'blocked')
    writeFileSync(path.join(s.root, 'own.md'), 'edited by hand\n')
    await s.h.module.recheckBlocked()
    const refused = 'own.md changed since Confirm. Request a new result in the Session.'
    expect((await s.h.store.workHandoffForTarget(s.workChatId))?.goalCompletion?.retryRefused).toBe(refused)
    const calls = s.h.orchestrator.runStoredUserMessage.mock.calls.length
    // The card says why; the click answers quietly and runs nothing.
    await s.h.module.retryCompletion(s.handoffId)
    expect(s.h.orchestrator.runStoredUserMessage.mock.calls).toHaveLength(calls)
    const after = (await s.h.store.workHandoffForTarget(s.workChatId))!
    expect(after.goalCompletion).toMatchObject({ status: 'blocked', retryRefused: refused })
    expect(after.goalCompletion?.retries).toBeUndefined()
  })

  it('keeps a landed Session open when a message arrived after its attempt', async () => {
    const s = await published({ 'own.md': 'before\n' }, { 'own.md': 'after\n' })
    s.h.orchestrator.runStoredUserMessage.mockImplementationOnce(async (chatId: string, event: ThreadEvent) => {
      git(s.root, 'commit', '-qam', 'This Session')
      if (event.type === 'user_message') await s.h.store.replaceEvent(chatId, { ...event, dispatchState: 'completed' })
      await s.h.store.appendEvent(chatId, { type: 'user_message', text: 'One more thing.', mentions: [] })
      return undefined
    })
    const ready = (await s.h.store.workHandoffForTarget(s.workChatId))!
    await s.h.module.confirmGoal(s.handoffId, undefined, ready.version)
    // The message opened a new round; the landed one is kept as history.
    await vi.waitFor(async () => expect((await s.h.store.workHandoffForTarget(s.workChatId))?.goalConfirmations?.[0]?.completion?.status).toBe('complete'))
    await s.h.module.reconcileCompletion(s.workChatId)
    expect((await s.h.store.workHandoffForTarget(s.workChatId))?.state).toBe('active')
    expect((await s.h.store.getChat(s.workChatId))?.settledAt).toBeNull()
  })

  it('settles a change that landed before a restart cut its settle short', async () => {
    const s = await published({ 'own.md': 'before\n' }, { 'own.md': 'after\n' })
    const ready = (await s.h.store.workHandoffForTarget(s.workChatId))!
    await s.h.module.confirmGoal(s.handoffId, undefined, ready.version)
    await statusOf(s.h, s.workChatId, 'blocked')
    git(s.root, 'commit', '-qam', 'This Session')
    const held = (await s.h.store.workHandoffForTarget(s.workChatId))!.goalCompletion!
    // Stored complete, then the server stopped before it settled.
    await s.h.store.updateWorkCompletion(s.handoffId, { ...held, status: 'complete', completedAt: Date.now(), message: undefined })
    await s.h.module.reconcileCompletion()
    expect((await s.h.store.workHandoffForTarget(s.workChatId))?.state).toBe('settled')
  })

  it('settles on a landed attempt only while it is still the live confirmed one', async () => {
    const s = await published({ 'own.md': 'before\n' }, { 'own.md': 'after\n' })
    const ready = (await s.h.store.workHandoffForTarget(s.workChatId))!
    await s.h.module.confirmGoal(s.handoffId, undefined, ready.version)
    await statusOf(s.h, s.workChatId, 'blocked')
    const held = (await s.h.store.workHandoffForTarget(s.workChatId))!
    const landed = { goalConfirmedAt: held.goalConfirmedAt!, attempt: held.goalCompletion!.requestEventId! }
    await s.h.store.updateWorkCompletion(s.handoffId, { ...held.goalCompletion!, status: 'complete' })
    // A message lands between the module's check and the store's write.
    await s.h.store.appendEvent(s.workChatId, { type: 'user_message', text: 'New work.', mentions: [] })
    const saved = await s.h.store.transitionWorkLifecycle(s.workChatId, s.handoffId, { state: 'settled', result: null, resultAt: Date.now() },
      { type: 'system_note', kind: 'info', text: 'Settled.', workHandoffId: s.handoffId, workHandoffPhase: 'settled' }, landed)
    expect(saved.state).toBe('active')
    expect((await s.h.store.getChat(s.workChatId))?.settledAt).toBeNull()
  })

  it('refuses Retry once the shared checkout switched branches', async () => {
    const s = await published({ 'own.md': 'before\n' }, { 'own.md': 'after\n' })
    const ready = (await s.h.store.workHandoffForTarget(s.workChatId))!
    await s.h.module.confirmGoal(s.handoffId, undefined, ready.version)
    await statusOf(s.h, s.workChatId, 'blocked')
    git(s.root, 'switch', '-qc', 'other-work')
    const calls = s.h.orchestrator.runStoredUserMessage.mock.calls.length
    await s.h.module.retryCompletion(s.handoffId)
    expect(s.h.orchestrator.runStoredUserMessage.mock.calls).toHaveLength(calls)
    expect((await s.h.store.workHandoffForTarget(s.workChatId))?.goalCompletion?.retryRefused)
      .toBe(`Retry waits until ${path.basename(s.root)} is back on main.`)
  })

  it('names the turn\'s own error when the lead never reported a stop', async () => {
    const s = await published({ 'own.md': 'before\n' }, { 'own.md': 'after\n' })
    s.h.orchestrator.runStoredUserMessage.mockImplementationOnce(async (chatId: string, event: ThreadEvent) => {
      await s.h.store.appendEvent(chatId, { type: 'system_note', kind: 'error', agentId: 'sage', turnId: 'commit', text: 'Provider usage limit reached.' })
      if (event.type === 'user_message') await s.h.store.replaceEvent(chatId, { ...event, dispatchState: 'completed' })
      return undefined
    })
    const ready = (await s.h.store.workHandoffForTarget(s.workChatId))!
    await s.h.module.confirmGoal(s.handoffId, undefined, ready.version)
    await statusOf(s.h, s.workChatId, 'blocked')
    expect((await s.h.store.workHandoffForTarget(s.workChatId))?.goalCompletion?.message).toBe('Provider usage limit reached.')
  })

  it('rechecks a settled Session\'s blocked card and confirms it once its commit is on main', async () => {
    const s = await published({ 'own.md': 'a\n' }, { 'own.md': 'mine\n' })
    const ready = (await s.h.store.workHandoffForTarget(s.workChatId))!
    await s.h.module.confirmGoal(s.handoffId, undefined, ready.version)
    await statusOf(s.h, s.workChatId, 'blocked')
    await s.h.module.setSettled(s.workChatId, true)
    expect((await s.h.store.workHandoffForTarget(s.workChatId))).toMatchObject({ state: 'settled', goalCompletion: { status: 'blocked' } })

    git(s.root, 'commit', '-qam', 'This Session, after it settled')
    await s.h.module.recheckBlocked()
    expect((await s.h.store.workHandoffForTarget(s.workChatId))?.goalCompletion?.status).toBe('complete')
  })
})

describe('retryRequest', () => {
  it('names every approved file and asks only for the worktrees that hold them', () => {
    const approved = { sourcePath: '/repo/web', worktreePath: '/wt/web', branch: 'manor/aaaaaaaa', createdAt: 0 }
    const untouched = { sourcePath: '/repo/docs', worktreePath: '/wt/docs', branch: 'manor/bbbbbbbb', createdAt: 0 }
    const files = Array.from({ length: 45 }, (_, index) => `src/file${index}.ts`)
    const request = retryRequest(undefined, [approved, untouched], 'main', {
      status: 'blocked', operation: 'merge', requestEventId: 'request',
      repos: [{ path: '/wt/web', branch: 'manor/aaaaaaaa', before: 'a', tree: 'b', files, sourcePath: '/repo/web', mergeInto: 'main' }],
    })
    expect(files.every((file) => request.includes(`- web/${file}\n`))).toBe(true)
    expect(request).toContain('- worktree /wt/web on branch manor/aaaaaaaa')
    expect(request).not.toContain('/wt/docs')
  })
})

describe('WorkModule merges confirmed worktree Sessions itself', () => {
  const roots: string[] = []
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_EDITOR: 'true' }
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const lines = (marks: Partial<Record<number, string>>) => Array.from({ length: 12 }, (_, at) => marks[at] ?? `line ${at}`).join('\n') + '\n'
  const completionOf = async (h: Awaited<ReturnType<typeof harness>>, handoffId: string) =>
    (await h.store.listWorkHandoffs()).find((row) => row.id === handoffId)?.goalCompletion

  /**
   * A linked folder on main and, per Session, a worktree on its own branch with a published
   * result whose commit message is `<title> change`. Manor commits at Confirm in the chat's
   * turn order: `beforeCommit` runs ahead of it, like a turn queued first, and `afterCommit`
   * right after, before Manor reads Git, like main moving meanwhile. The lead's turns are
   * scripted: `commit` answers a commit Manor handed over or a Retry, `trouble` Manor's
   * message about a stopped merge.
   */
  async function linkedFolder(seed: Record<string, string>, hooks: Record<string, string> = {}, options: Parameters<typeof harness>[1] = {}) {
    const h = await harness('dm', options)
    const root = mkdtempSync(path.join(os.tmpdir(), 'manor-own-merge-'))
    roots.push(root)
    const source = path.join(root, 'linked')
    execFileSync('mkdir', ['-p', source])
    git(source, 'init', '-q', '-b', 'main')
    git(source, 'config', 'user.name', 'Test')
    git(source, 'config', 'user.email', 'test@example.test')
    if (Object.keys(hooks).length > 0) {
      const dir = path.join(root, 'hooks')
      execFileSync('mkdir', ['-p', dir])
      for (const [name, script] of Object.entries(hooks)) writeFileSync(path.join(dir, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 })
      git(source, 'config', 'core.hooksPath', dir)
    }
    for (const [file, text] of Object.entries(seed)) writeFileSync(path.join(source, file), text)
    git(source, 'add', '.')
    git(source, 'commit', '-qm', 'Initial')
    await h.store.updateProject(h.projectId, 'Manor', [source])
    const sessions = new Map<string, { worktree: string; commit: () => void | Promise<void>; trouble: (text: string) => void
      beforeCommit: () => void | Promise<void>; afterCommit: () => void | Promise<void> }>()
    h.orchestrator.runExclusive = async <T>(chatId: string, fn: () => Promise<T>) => {
      await sessions.get(chatId)?.beforeCommit()
      const value = await fn()
      const session = sessions.get(chatId)
      if (session !== undefined) {
        const after = session.afterCommit
        session.afterCommit = () => undefined
        await after()
      }
      return value
    }
    h.orchestrator.runStoredUserMessage.mockImplementation(async (chatId: string, event: ThreadEvent) => {
      const session = sessions.get(chatId)!
      if (event.type === 'user_message') await h.store.replaceEvent(chatId, { ...event, dispatchState: 'started' })
      if (event.type === 'user_message' && event.mergeTrouble !== undefined) session.trouble(event.instruction ?? '')
      else await session.commit()
      // The exchange's own end reads Git while the request still reads started, as the service's onExchangeFinished does.
      await h.module.reconcileCompletion(chatId)
      if (event.type === 'user_message') await h.store.replaceEvent(chatId, { ...event, dispatchState: 'completed' })
      return undefined
    })

    async function session(title: string, edits: Record<string, string>, commit: GoalCommit | null = { subject: `${title} change` }) {
      const proposal = await h.module.useTool({ ...context, chatId: h.source.id },
        { ...input(h.projectId), assignmentKey: title, title }) as { workHandoffId: string }
      const workChatId = await h.module.accept(proposal.workHandoffId)
      const branch = `manor/${title.toLowerCase()}`
      const worktree = path.join(root, title)
      git(source, 'worktree', 'add', '-q', '-b', branch, worktree, 'main')
      const worktrees = [{ sourcePath: source, worktreePath: worktree, branch, createdAt: Date.now() }]
      await h.store.replaceChatWorktrees(workChatId, worktrees)
      const before = await captureTurnTree(worktree)
      for (const [file, text] of Object.entries(edits)) writeFileSync(path.join(worktree, file), text)
      await h.store.appendEvent(workChatId, { type: 'turn_result', agentId: 'sage', turnId: `edit-${title}`,
        fileChanges: await diffTurnTrees(worktree, before, await captureTurnTree(worktree)),
      })
      const files = Object.keys(edits).map((file) => path.join(worktree, file))
      /** Publishes the result again, as a later `goal_reached` does. */
      const reach = async (message: GoalCommit | null) => {
        const completion = { ...await prepareWorkCompletion([worktree], files, worktrees, 'main'), status: 'ready' as const, completedAt: undefined }
        await h.store.reachWorkGoal(proposal.workHandoffId, { type: 'system_note', kind: 'info', text: 'Ready.', workGoalHandoffId: proposal.workHandoffId,
          goalReport: { result: 'Done.', ...(message === null ? {} : { commit: message }) }, goalCompletion: completion })
      }
      await reach(commit)
      const scripted = {
        worktree,
        commit: (): void | Promise<void> => {
          git(worktree, 'add', '-A')
          if (git(worktree, 'status', '--porcelain') !== '') git(worktree, 'commit', '-qm', `${title} change`)
        },
        trouble: (_text: string) => undefined as void,
        beforeCommit: (): void | Promise<void> => undefined,
        afterCommit: (): void | Promise<void> => undefined,
      }
      sessions.set(workChatId, scripted)
      const confirm = async () => {
        const ready = (await h.store.listWorkHandoffs()).find((row) => row.id === proposal.workHandoffId)!
        await h.module.confirmGoal(proposal.workHandoffId, 'main', ready.version)
      }
      return { handoffId: proposal.workHandoffId, workChatId, branch, worktree, scripted, confirm, reach }
    }
    /** The messages the lead got: a commit Manor handed over, a Retry and Manor's merge failures. */
    const requests = () => h.orchestrator.runStoredUserMessage.mock.calls.map(([, event]) => event as Extract<ThreadEvent, { type: 'user_message' }>)
    /** Confirm's request as stored, which no turn answers when Manor commits. */
    const confirmEvent = async (s: { handoffId: string; workChatId: string }) => {
      const id = (await completionOf(h, s.handoffId))?.requestEventId
      return (await h.store.loadEvents(s.workChatId)).find((event) => event.id === id) as Extract<ThreadEvent, { type: 'user_message' }> | undefined
    }
    return { h, source, session, requests, confirmEvent }
  }

  it('commits with the Session’s own message at Confirm and lands a clean rebase without a single model turn', async () => {
    const repo = await linkedFolder({ 'a.md': 'a\n', 'b.md': 'b\n' })
    const s = await repo.session('Clean', { 'a.md': 'mine\n' },
      { subject: 'Clean change', body: 'Why it changed.\n\nCo-Authored-By: Test Lead <lead@example.test>' })
    s.scripted.afterCommit = () => {
      // Main moves while Manor commits; the rebase onto it is clean.
      writeFileSync(path.join(repo.source, 'b.md'), 'main moved\n')
      git(repo.source, 'commit', '-qam', 'Elsewhere on main')
    }
    await s.confirm()
    await vi.waitFor(async () => expect((await completionOf(repo.h, s.handoffId))?.status).toBe('complete'), { timeout: 10_000 })
    expect(repo.requests()).toHaveLength(0)
    expect(await repo.confirmEvent(s)).toMatchObject({ dispatchState: 'completed', confirmRequest: { variant: 'merge', manor: true } })
    expect(git(repo.source, 'log', '--format=%s', 'main')).toBe('Clean change\nElsewhere on main\nInitial')
    expect(git(repo.source, 'log', '-1', '--format=%B', 'main')).toBe('Clean change\n\nWhy it changed.\n\nCo-Authored-By: Test Lead <lead@example.test>')
    // Exactly the approved file, nothing else the worktree held.
    expect(git(repo.source, 'show', '--format=', '--name-only', 'main')).toBe('a.md')
    expect(git(repo.source, 'status', '--porcelain')).toBe('')
    expect((await completionOf(repo.h, s.handoffId))?.merge).toBeUndefined()
  }, 20_000)

  it('lands two Sessions confirmed back to back in order, the second waiting “after” the first', async () => {
    // The fast-forward's post-merge hook holds the first merge long enough for the second to queue.
    const repo = await linkedFolder({ 'a.md': 'a\n', 'b.md': 'b\n' }, { 'post-merge': 'sleep 1' })
    const first = await repo.session('Exportknop', { 'a.md': 'first\n' })
    const second = await repo.session('Kleurkiezer', { 'b.md': 'second\n' })
    const stages: unknown[] = []
    const watch = setInterval(() => {
      void completionOf(repo.h, second.handoffId).then((completion) => { if (completion?.merge !== undefined) stages.push(completion.merge) })
    }, 20)
    onTestFinished(() => clearInterval(watch))
    await first.confirm()
    await second.confirm()
    await vi.waitFor(async () => {
      expect((await completionOf(repo.h, first.handoffId))?.status).toBe('complete')
      expect((await completionOf(repo.h, second.handoffId))?.status).toBe('complete')
    }, { timeout: 15_000 })
    expect(stages).toContainEqual(expect.objectContaining({ stage: 'queued', after: 'Exportknop', ahead: 1 }))
    expect(git(repo.source, 'log', '--format=%s', 'main')).toBe('Kleurkiezer change\nExportknop change\nInitial')
    // Neither commit nor merge needed the lead.
    expect(repo.requests()).toEqual([])
  }, 30_000)

  it('falls back to the commit-message writer, then to a plain message, when the lead handed none in', async () => {
    const written: string[] = []
    const repo = await linkedFolder({ 'a.md': 'a\n', 'b.md': 'b\n' }, {}, {
      writeCommitMessage: async (_chatId, patch) => { written.push(patch); return patch.includes('+mine') ? 'Write the writer subject\n\nWhy, from the patch.' : undefined },
    })
    const first = await repo.session('Written', { 'a.md': 'mine\n' }, null)
    await first.confirm()
    await vi.waitFor(async () => expect((await completionOf(repo.h, first.handoffId))?.status).toBe('complete'), { timeout: 10_000 })
    expect(git(repo.source, 'log', '-1', '--format=%B', 'main')).toBe('Write the writer subject\n\nWhy, from the patch.')
    // The writer had no answer for this patch, so the plain message names the file.
    const second = await repo.session('Plain', { 'b.md': 'other\n' }, null)
    await second.confirm()
    await vi.waitFor(async () => expect((await completionOf(repo.h, second.handoffId))?.status).toBe('complete'), { timeout: 10_000 })
    expect(git(repo.source, 'log', '-1', '--format=%B', 'main')).toBe('Update b.md')
    expect(written).toHaveLength(2)
    expect(repo.requests()).toEqual([])
  }, 20_000)

  it('never commits with a message from before the result was reopened', async () => {
    const repo = await linkedFolder({ 'a.md': 'a\n', 'b.md': 'b\n' }, {}, { writeCommitMessage: async () => 'Write it from the patch' })
    const replaced = await repo.session('Replaced', { 'a.md': 'first\n' }, { subject: 'Describe the first try' })
    const reopen = async (s: { handoffId: string }) => {
      const held = (await repo.h.store.listWorkHandoffs()).find((row) => row.id === s.handoffId)!
      await repo.h.store.reviseWorkGoal(s.handoffId, held.version, 'Tweak it.')
      expect((await repo.h.store.listWorkHandoffs()).find((row) => row.id === s.handoffId)?.goalReport).toBeUndefined()
    }
    await reopen(replaced)
    writeFileSync(path.join(replaced.worktree, 'a.md'), 'tweaked\n')
    await replaced.reach({ subject: 'Describe the tweak' })
    await replaced.confirm()
    await vi.waitFor(async () => expect((await completionOf(repo.h, replaced.handoffId))?.status).toBe('complete'), { timeout: 10_000 })
    expect(git(repo.source, 'log', '-1', '--format=%B', 'main')).toBe('Describe the tweak')
    // A result reached again without a message commits with the writer's, never the old one.
    const unused = await repo.session('Unused', { 'b.md': 'first\n' }, { subject: 'Describe the old code' })
    await reopen(unused)
    await unused.reach(null)
    await unused.confirm()
    await vi.waitFor(async () => expect((await completionOf(repo.h, unused.handoffId))?.status).toBe('complete'), { timeout: 10_000 })
    expect(git(repo.source, 'log', '--format=%s', 'main')).toBe('Write it from the patch\nDescribe the tweak\nInitial')
  }, 20_000)

  it('hands a commit the pre-commit hook refused to the lead as one turn, then merges what it committed', async () => {
    // The hook fails for a reason outside the change, like a service its tests need being down.
    const outage = path.join(os.tmpdir(), `manor-outage-${process.pid}-${Date.now()}`)
    onTestFinished(() => rmSync(outage, { force: true }))
    const repo = await linkedFolder({ 'a.md': 'a\n' }, { 'pre-commit': `if [ -e '${outage}' ]; then echo "FAIL service down" >&2; exit 1; fi` })
    const s = await repo.session('Hooked', { 'feature.md': 'feature\n' }, { subject: 'Add the feature' })
    writeFileSync(outage, '')
    s.scripted.commit = () => {
      rmSync(outage)
      git(s.worktree, 'add', 'feature.md')
      git(s.worktree, 'commit', '-qm', 'Add the feature')
    }
    await s.confirm()
    await vi.waitFor(async () => expect((await completionOf(repo.h, s.handoffId))?.status).toBe('complete'), { timeout: 10_000 })
    expect(repo.requests()).toHaveLength(1)
    const handed = repo.requests()[0]!
    expect(handed.confirmRequest?.manor).toBeUndefined()
    expect(handed.mergeTrouble).toBeUndefined()
    expect(handed.instruction).toContain('Manor tried to commit')
    expect(handed.instruction).toContain('FAIL service down')
    expect(handed.instruction).toContain('Add the feature')
    // The handed-over turn is the next attempt under the same Confirm; Manor's own request is over.
    const completion = (await completionOf(repo.h, s.handoffId))!
    expect(completion.retries).toHaveLength(1)
    expect((await repo.h.store.loadEvents(s.workChatId)).find((event) => event.id === completion.requestEventId))
      .toMatchObject({ dispatchState: 'completed', confirmRequest: { manor: true } })
    expect(git(repo.source, 'log', '--format=%s', 'main')).toBe('Add the feature\nInitial')
  }, 20_000)

  it('commits nothing when the files changed while the commit waited its turn', async () => {
    const repo = await linkedFolder({ 'a.md': 'a\n' })
    const s = await repo.session('Waited', { 'a.md': 'approved\n' }, { subject: 'Describe the approved code' })
    // A turn queued ahead of the commit edits the approved file.
    s.scripted.beforeCommit = () => { writeFileSync(path.join(s.worktree, 'a.md'), 'newer\n') }
    await s.confirm()
    await vi.waitFor(async () => expect((await completionOf(repo.h, s.handoffId))?.status).toBe('blocked'), { timeout: 10_000 })
    expect((await completionOf(repo.h, s.handoffId))?.message).toContain('changed after Confirm, so Manor did not commit them')
    // A later Git read keeps Manor's reason.
    await repo.h.module.recheckBlocked()
    expect((await completionOf(repo.h, s.handoffId))?.message).toContain('changed after Confirm, so Manor did not commit them')
    expect(git(s.worktree, 'log', '--format=%s', s.branch)).toBe('Initial')
    expect(git(repo.source, 'log', '--format=%s', 'main')).toBe('Initial')
    expect(repo.requests()).toEqual([])
  }, 20_000)

  it.each([['extra.md', 'extra.md'], ['a name that starts with a space', ' feature.md']])(
    'takes back a commit a passing hook widened with %s, and merges nothing', async (_case, extra) => {
      const repo = await linkedFolder({ 'a.md': 'a\n' }, {
        'pre-commit': `if git cat-file -e :feature.md 2>/dev/null; then printf "generated\\n" > '${extra}'; git add -- '${extra}'; fi`,
      })
      const s = await repo.session('Widened', { 'feature.md': 'feature\n' }, { subject: 'Add the feature' })
      await s.confirm()
      await vi.waitFor(async () => expect((await completionOf(repo.h, s.handoffId))?.status).toBe('blocked'), { timeout: 10_000 })
      const reason = `The commit holds ${extra} beyond what Confirm approved`
      expect((await completionOf(repo.h, s.handoffId))?.message).toContain(reason)
      expect(git(s.worktree, 'log', '--format=%s', s.branch)).toBe('Initial')
      // A later Git read keeps Manor's reason, from its note in the Session.
      await repo.h.module.recheckBlocked()
      expect((await completionOf(repo.h, s.handoffId))?.message).toContain(reason)
      expect(git(repo.source, 'log', '--format=%s', 'main')).toBe('Initial')
      expect(repo.requests()).toEqual([])
    }, 20_000)

  it('blocks Manor’s commit a restart left unchecked when it holds more than the approval', async () => {
    const repo = await linkedFolder({ 'a.md': 'a\n' })
    const s = await repo.session('Restarted', { 'feature.md': 'feature\n' }, { subject: 'Add the feature' })
    // The server stops mid-commit: the commit, widened by a hook, is on the branch, and its check never ran.
    repo.h.orchestrator.runExclusive = () => new Promise<never>(() => undefined)
    await s.confirm()
    writeFileSync(path.join(s.worktree, 'extra.md'), 'generated\n')
    git(s.worktree, 'add', 'feature.md', 'extra.md')
    git(s.worktree, 'commit', '-qm', 'Add the feature')
    const request = (await repo.confirmEvent(s))!
    expect(request.dispatchState).toBe('started')
    // Boot marks a request that was running uncertain, then reads Git.
    await repo.h.store.replaceEvent(s.workChatId, { ...request, dispatchState: 'uncertain' })
    await repo.h.module.reconcileCompletion(s.workChatId)
    expect((await completionOf(repo.h, s.handoffId))).toMatchObject({ status: 'blocked',
      message: 'The commit holds extra.md beyond what Confirm approved. Request a new result in the Session.' })
    expect(git(repo.source, 'log', '--format=%s', 'main')).toBe('Initial')
  }, 20_000)

  it('sends a rebase conflict to the lead once, with Git’s words, and lands a fix that kept both sides without asking', async () => {
    const repo = await linkedFolder({ 'shared.md': lines({}) })
    const s = await repo.session('Conflict', { 'shared.md': lines({ 0: 'mine' }) })
    s.scripted.afterCommit = () => {
      writeFileSync(path.join(repo.source, 'shared.md'), lines({ 0: 'theirs' }))
      git(repo.source, 'commit', '-qam', 'Main edits the same line')
    }
    let fixing: unknown
    s.scripted.trouble = () => {
      fixing = undefined
      void completionOf(repo.h, s.handoffId).then((completion) => { fixing = completion?.merge?.stage })
      try { git(s.worktree, 'rebase', 'main') } catch { /* the conflict the lead resolves */ }
      writeFileSync(path.join(s.worktree, 'shared.md'), ['theirs', 'mine', ...lines({}).split('\n').slice(1)].join('\n'))
      git(s.worktree, 'add', 'shared.md')
      git(s.worktree, 'rebase', '--continue')
    }
    await s.confirm()
    await vi.waitFor(async () => expect((await completionOf(repo.h, s.handoffId))?.status).toBe('complete'), { timeout: 10_000 })
    const trouble = repo.requests().filter((event) => event.mergeTrouble !== undefined)
    expect(trouble).toHaveLength(1)
    expect(trouble[0]?.mergeTrouble).toEqual({ handoffId: s.handoffId, kind: 'conflict' })
    expect(trouble[0]?.instruction).toContain('stopped on a conflict in shared.md')
    expect(trouble[0]?.instruction).toContain('CONFLICT')
    expect(trouble[0]?.mentions).toEqual(['sage'])
    expect(fixing).toBe('fixing')
    // Manor's own message never reopened the confirmed result.
    expect((await repo.h.store.listWorkHandoffs()).find((row) => row.id === s.handoffId)?.goalConfirmations).toBeUndefined()
    expect(git(repo.source, 'show', 'main:shared.md').split('\n').slice(0, 2)).toEqual(['theirs', 'mine'])
    // Its message is no new work either: the landed Session settles.
    await vi.waitFor(async () => expect((await repo.h.store.getChat(s.workChatId))?.settledAt).not.toBeNull(), { timeout: 10_000 })
  }, 20_000)

  it('holds a conflict fix that rewrote a line until the user approves the diff on the card', async () => {
    const repo = await linkedFolder({ 'shared.md': lines({}) })
    const s = await repo.session('Rewrite', { 'shared.md': lines({ 0: 'mine' }) })
    s.scripted.afterCommit = () => {
      writeFileSync(path.join(repo.source, 'shared.md'), lines({ 0: 'theirs' }))
      git(repo.source, 'commit', '-qam', 'Main edits the same line')
    }
    s.scripted.trouble = () => {
      try { git(s.worktree, 'rebase', 'main') } catch { /* the conflict the lead resolves */ }
      writeFileSync(path.join(s.worktree, 'shared.md'), lines({ 0: 'mine and theirs' }))
      git(s.worktree, 'add', 'shared.md')
      git(s.worktree, 'rebase', '--continue')
    }
    await s.confirm()
    await vi.waitFor(async () => expect((await completionOf(repo.h, s.handoffId))?.merge?.stage).toBe('approve'), { timeout: 10_000 })
    const waiting = (await completionOf(repo.h, s.handoffId))!
    expect(waiting.status).toBe('pending')
    expect(waiting.merge?.fix?.files).toEqual(['shared.md'])
    expect(waiting.merge?.fix?.diff).toContain('+mine and theirs')
    expect(git(repo.source, 'show', 'main:shared.md').split('\n')[0]).toBe('theirs')
    await expect(repo.h.module.approveMergeFix(s.handoffId, 'not-the-tip')).rejects.toThrow('conflict fix changed')

    await repo.h.module.approveMergeFix(s.handoffId, waiting.merge!.fix!.tip)
    await vi.waitFor(async () => expect((await completionOf(repo.h, s.handoffId))?.status).toBe('complete'), { timeout: 10_000 })
    expect(git(repo.source, 'show', 'main:shared.md').split('\n')[0]).toBe('mine and theirs')
  }, 20_000)

  it('asks the user about a conflict fix the lead left on the old base, once Manor’s rebase dropped its side', async () => {
    const repo = await linkedFolder({ 'shared.md': lines({}) })
    const s = await repo.session('Dropped', { 'shared.md': lines({ 0: 'mine' }) })
    s.scripted.afterCommit = () => {
      writeFileSync(path.join(repo.source, 'shared.md'), lines({ 0: 'theirs' }))
      git(repo.source, 'commit', '-qam', 'Main edits the same line')
    }
    // No rebase: the amend takes main's line, so Manor's own rebase drops the commit cleanly.
    s.scripted.trouble = () => {
      writeFileSync(path.join(s.worktree, 'shared.md'), lines({ 0: 'theirs' }))
      git(s.worktree, 'commit', '-qa', '--amend', '--no-edit')
    }
    await s.confirm()
    await vi.waitFor(async () => expect((await completionOf(repo.h, s.handoffId))?.merge?.stage).toBe('approve'), { timeout: 10_000 })
    expect((await completionOf(repo.h, s.handoffId))?.merge?.fix?.diff).toContain('-mine')
  }, 20_000)

  it('asks the user when the lead skipped its own conflicted commit instead of resolving it', async () => {
    const repo = await linkedFolder({ 'shared.md': lines({}) })
    const s = await repo.session('Skipped', { 'shared.md': lines({ 0: 'mine' }) })
    s.scripted.afterCommit = () => {
      writeFileSync(path.join(repo.source, 'shared.md'), lines({ 0: 'theirs' }))
      git(repo.source, 'commit', '-qam', 'Main edits the same line')
    }
    s.scripted.trouble = () => {
      try { git(s.worktree, 'rebase', 'main') } catch { /* the conflict the lead drops */ }
      git(s.worktree, 'rebase', '--skip')
    }
    await s.confirm()
    await vi.waitFor(async () => expect((await completionOf(repo.h, s.handoffId))?.merge?.stage).toBe('approve'), { timeout: 10_000 })
    expect((await completionOf(repo.h, s.handoffId))?.merge?.fix?.diff).toContain('-mine')
  }, 20_000)

  it('shows a kept file main deleted on the approval card, even beside an unrelated change', async () => {
    const repo = await linkedFolder({ 'shared.md': lines({}) })
    const s = await repo.session('Kept', { 'shared.md': lines({ 0: 'mine' }) })
    s.scripted.afterCommit = () => {
      git(repo.source, 'rm', '-q', 'shared.md')
      git(repo.source, 'commit', '-qm', 'Main deletes the file')
    }
    // Keeping the Session's version leaves the file exactly as Git's conflicted tree has it.
    s.scripted.trouble = () => {
      try { git(s.worktree, 'rebase', 'main') } catch { /* modify/delete */ }
      git(s.worktree, 'add', 'shared.md')
      writeFileSync(path.join(s.worktree, 'notes.md'), 'unrelated\n')
      git(s.worktree, 'add', 'notes.md')
      git(s.worktree, '-c', 'core.editor=true', 'rebase', '--continue')
    }
    await s.confirm()
    await vi.waitFor(async () => expect((await completionOf(repo.h, s.handoffId))?.merge?.stage).toBe('approve'), { timeout: 10_000 })
    const fix = (await completionOf(repo.h, s.handoffId))?.merge?.fix
    expect(fix?.files).toEqual(expect.arrayContaining(['notes.md', 'shared.md']))
    expect(fix?.diff).toContain('--- /dev/null\n+++ fix/shared.md')
  }, 20_000)

  it('never takes marker-shaped text in a modify/delete file as proof of keeping both sides', async () => {
    const repo = await linkedFolder({ 'shared.md': 'plain\n' })
    const markers = 'top\n<<<<<<< ours\nmine\n=======\ntheirs\n>>>>>>> theirs\nend\n'
    const s = await repo.session('Literal', { 'shared.md': markers })
    s.scripted.afterCommit = () => {
      git(repo.source, 'rm', '-q', 'shared.md')
      git(repo.source, 'commit', '-qm', 'Main deletes the file')
    }
    s.scripted.trouble = () => {
      try { git(s.worktree, 'rebase', 'main') } catch { /* modify/delete */ }
      writeFileSync(path.join(s.worktree, 'shared.md'), 'top\nmine\ntheirs\nend\n')
      git(s.worktree, 'add', 'shared.md')
      git(s.worktree, '-c', 'core.editor=true', 'rebase', '--continue')
    }
    await s.confirm()
    await vi.waitFor(async () => expect((await completionOf(repo.h, s.handoffId))?.merge?.stage).toBe('approve'), { timeout: 10_000 })
    expect(git(repo.source, 'log', '--format=%s', 'main')).toBe('Main deletes the file\nInitial')
  }, 20_000)

  it('asks approval when the kept lines match a union merge Git did not make', async () => {
    // Git's conflict is C against B; a Myers union would call the Session's side alone "both".
    const repo = await linkedFolder({ 'shared.md': 'B\nD\nA\nC\nA\n' })
    const s = await repo.session('Union', { 'shared.md': 'A\nB\nA\n' })
    s.scripted.afterCommit = () => {
      writeFileSync(path.join(repo.source, 'shared.md'), 'A\nC\nA\n')
      git(repo.source, 'commit', '-qam', 'Target side')
    }
    s.scripted.trouble = () => {
      try { git(s.worktree, 'rebase', 'main') } catch { /* C against B */ }
      writeFileSync(path.join(s.worktree, 'shared.md'), 'A\nB\nA\n')
      git(s.worktree, 'add', 'shared.md')
      git(s.worktree, '-c', 'core.editor=true', 'rebase', '--continue')
    }
    await s.confirm()
    await vi.waitFor(async () => expect((await completionOf(repo.h, s.handoffId))?.merge?.stage).toBe('approve'), { timeout: 10_000 })
  }, 20_000)

  it('keeps the first conflict as the baseline when the lead amends before rebasing', async () => {
    const repo = await linkedFolder({ 'a.md': 'base A\n', 'b.md': 'base B\n' })
    const s = await repo.session('Baseline', { 'a.md': 'session A\n', 'b.md': 'session B\n' })
    let repairs = 0
    s.scripted.afterCommit = () => {
      writeFileSync(path.join(repo.source, 'a.md'), 'target A\n')
      writeFileSync(path.join(repo.source, 'b.md'), 'target B\n')
      git(repo.source, 'commit', '-qam', 'Target side')
    }
    s.scripted.trouble = () => {
      repairs += 1
      if (repairs === 1) {
        // Drops the Session's A on the old base, so the next rebase only conflicts on B.
        writeFileSync(path.join(s.worktree, 'a.md'), 'target A\n')
        git(s.worktree, 'commit', '--amend', '-qam', 'Drops Session A')
        return
      }
      try { git(s.worktree, 'rebase', 'main') } catch { /* B */ }
      writeFileSync(path.join(s.worktree, 'b.md'), 'target B\nsession B\n')
      git(s.worktree, 'add', '-A')
      git(s.worktree, '-c', 'core.editor=true', 'rebase', '--continue')
    }
    await s.confirm()
    await vi.waitFor(async () => expect((await completionOf(repo.h, s.handoffId))?.merge?.stage).toBe('approve'), { timeout: 10_000 })
    expect((await completionOf(repo.h, s.handoffId))?.merge?.fix?.diff).toContain('-session A')
  }, 20_000)

  it('asks again, with everything that would land, when a conflict follows an approved fix', async () => {
    const repo = await linkedFolder({ 'shared.md': 'base\n' })
    const s = await repo.session('Approved', { 'shared.md': 'session\n' })
    let repairs = 0
    s.scripted.afterCommit = () => {
      writeFileSync(path.join(repo.source, 'shared.md'), 'target\n')
      git(repo.source, 'commit', '-qam', 'Target one')
    }
    s.scripted.trouble = () => {
      repairs += 1
      try { git(s.worktree, 'rebase', 'main') } catch { /* conflict */ }
      writeFileSync(path.join(s.worktree, 'shared.md'), repairs === 1 ? 'approved\n' : 'second\n')
      git(s.worktree, 'add', '-A')
      git(s.worktree, '-c', 'core.editor=true', 'rebase', '--continue')
    }
    await s.confirm()
    await vi.waitFor(async () => expect((await completionOf(repo.h, s.handoffId))?.merge?.stage).toBe('approve'), { timeout: 10_000 })
    const first = (await completionOf(repo.h, s.handoffId))!.merge!.fix!
    // The target moves into the same lines, so the approved fix conflicts once more.
    writeFileSync(path.join(repo.source, 'shared.md'), 'session\n')
    git(repo.source, 'commit', '-qam', 'Target two')
    await repo.h.module.approveMergeFix(s.handoffId, first.tip)
    await vi.waitFor(async () => {
      const merge = (await completionOf(repo.h, s.handoffId))?.merge
      expect(merge?.stage === 'approve' && merge.fix?.tip !== first.tip).toBe(true)
    }, { timeout: 10_000 })
    expect(repairs).toBe(2)
    expect((await completionOf(repo.h, s.handoffId))?.merge?.fix?.diff).toContain('--- main/shared.md\n+++ fix/shared.md\n@@ -1 +1 @@\n-session\n+second')
    expect(git(repo.source, 'show', 'main:shared.md')).toBe('session')
  }, 20_000)

  it('undoes a clean rebase that ends elsewhere than the merge, so a target file never vanishes unseen', async () => {
    const repo = await linkedFolder({ 'a.md': 'a\n' })
    const s = await repo.session('Replay', { 'feature.md': 'feature\n' })
    s.scripted.afterCommit = () => {
      writeFileSync(path.join(s.worktree, 'tmp.md'), 'same\n')
      git(s.worktree, 'add', '-A')
      git(s.worktree, 'commit', '-qm', 'Feature with a scratch file')
      git(s.worktree, 'rm', '-q', 'tmp.md')
      git(s.worktree, 'commit', '-qm', 'Drop the scratch file')
      // The target adds the same file: the rebase skips the add and replays the removal.
      writeFileSync(path.join(repo.source, 'tmp.md'), 'same\n')
      git(repo.source, 'add', 'tmp.md')
      git(repo.source, 'commit', '-qm', 'Main adds tmp')
    }
    await s.confirm()
    await vi.waitFor(async () => expect((await completionOf(repo.h, s.handoffId))?.status).toBe('blocked'), { timeout: 10_000 })
    const trouble = repo.requests().filter((event) => event.mergeTrouble !== undefined)
    expect(trouble[0]?.instruction).toContain('replayed its commits into a different result than merging it would')
    expect(git(repo.source, 'log', '--format=%s', 'main')).toBe('Main adds tmp\nInitial')
    expect(git(repo.source, 'show', 'main:tmp.md')).toBe('same')
  }, 20_000)

  it('blocks, with the branch untouched, when the worktree cannot return to it after that rebase', async () => {
    // A post-rewrite hook edits a file only the target has, so `reset --keep` refuses.
    const repo = await linkedFolder({ 'a.md': 'a\n' }, { 'post-rewrite': 'printf "generated\\n" > main-only.md' })
    const s = await repo.session('Stuck', { 'feature.md': 'feature\n' })
    let before = ''
    s.scripted.afterCommit = () => {
      writeFileSync(path.join(s.worktree, 'tmp.md'), 'same\n')
      git(s.worktree, 'add', '-A')
      git(s.worktree, 'commit', '-qm', 'Feature with a scratch file')
      git(s.worktree, 'rm', '-q', 'tmp.md')
      git(s.worktree, 'commit', '-qm', 'Drop the scratch file')
      before = git(s.worktree, 'rev-parse', 'HEAD')
      writeFileSync(path.join(repo.source, 'tmp.md'), 'same\n')
      writeFileSync(path.join(repo.source, 'main-only.md'), 'main\n')
      git(repo.source, 'add', '-A')
      git(repo.source, 'commit', '-qm', 'Main adds tmp')
    }
    await s.confirm()
    await vi.waitFor(async () => expect((await completionOf(repo.h, s.handoffId))?.status).toBe('blocked'), { timeout: 10_000 })
    expect(repo.requests().filter((event) => event.mergeTrouble !== undefined)).toHaveLength(0)
    // The rebase ran detached: the branch never left the lead's commit.
    expect(git(s.worktree, 'rev-parse', `refs/heads/${s.branch}`)).toBe(before)
    expect(git(repo.source, 'log', '--format=%s', 'main')).toBe('Main adds tmp\nInitial')
  }, 20_000)

  it('withholds the merge when the pre-commit hook rewrites files the commit does not hold', async () => {
    const repo = await linkedFolder({ 'a.md': 'a\n' }, {
      'pre-commit': 'if test -f main-only.md && test -f feature.md; then printf "formatted\\n" > feature.md; git add feature.md; fi',
    })
    const s = await repo.session('Autofix', { 'feature.md': 'feature\n' })
    s.scripted.afterCommit = mainMoves(repo)
    await s.confirm()
    await vi.waitFor(async () => expect((await completionOf(repo.h, s.handoffId))?.status).toBe('blocked'), { timeout: 10_000 })
    const trouble = repo.requests().filter((event) => event.mergeTrouble !== undefined)
    expect(trouble).toHaveLength(1)
    expect(trouble[0]?.instruction).toContain('the worktree holds changes the commit does not')
    expect(git(repo.source, 'log', '--format=%s', 'main')).toBe('Main adds a file\nInitial')
  }, 20_000)

  it('sends a pre-commit hook that fails after the rebase to the lead once, then blocks with its reason', async () => {
    // The two files pass the hook alone and fail it together, like a test that breaks only on the merged code.
    const repo = await linkedFolder({ 'a.md': 'a\n' }, {
      // Thirty long diagnostic lines first: the stored failure still fits the wire schema.
      'pre-commit': 'if git cat-file -e :main-only.md 2>/dev/null && git cat-file -e :feature.md 2>/dev/null; then ' +
        'for i in $(seq 30); do printf "%0200d\\n" "$i" >&2; done; echo "FAIL feature.test.ts clashes with main-only.md" >&2; exit 1; fi',
    })
    const s = await repo.session('Hook', { 'feature.md': 'feature\n' })
    s.scripted.afterCommit = () => {
      writeFileSync(path.join(repo.source, 'main-only.md'), 'main\n')
      git(repo.source, 'add', 'main-only.md')
      git(repo.source, 'commit', '-qm', 'Main adds a file')
    }
    // The lead's turn changes nothing, so the same failure comes back on the same commit.
    await s.confirm()
    await vi.waitFor(async () => expect((await completionOf(repo.h, s.handoffId))?.status).toBe('blocked'), { timeout: 10_000 })
    const trouble = repo.requests().filter((event) => event.mergeTrouble !== undefined)
    expect(trouble).toHaveLength(1)
    expect(trouble[0]?.mergeTrouble?.kind).toBe('hook')
    expect(trouble[0]?.instruction).toContain('FAIL feature.test.ts clashes with main-only.md')
    expect((await completionOf(repo.h, s.handoffId))?.message).toContain('The pre-commit hook failed on manor/hook')
    expect(WorkCompletionSchema.safeParse(await completionOf(repo.h, s.handoffId)).success).toBe(true)
    // A later Git recheck keeps Manor's reason instead of a generic "not on main".
    await repo.h.module.recheckBlocked()
    expect((await completionOf(repo.h, s.handoffId))?.message).toContain('The pre-commit hook failed on manor/hook')
    expect(git(repo.source, 'log', '--format=%s', 'main')).toBe('Main adds a file\nInitial')
    // The check left the worktree on its branch with nothing staged.
    expect(git(s.worktree, 'symbolic-ref', '--short', 'HEAD')).toBe('manor/hook')
    expect(git(s.worktree, 'status', '--porcelain')).toBe('')
  }, 20_000)

  it('keeps Confirm order when the first Session’s commit ends last', async () => {
    const repo = await linkedFolder({ 'a.md': 'a\n', 'b.md': 'b\n' })
    const first = await repo.session('Exportknop', { 'a.md': 'first\n' })
    const second = await repo.session('Kleurkiezer', { 'b.md': 'second\n' })
    let finish!: () => void
    const slow = new Promise<void>((resolve) => { finish = resolve })
    first.scripted.afterCommit = async () => { await slow }
    await first.confirm()
    await second.confirm()
    await vi.waitFor(async () => expect((await completionOf(repo.h, second.handoffId))?.merge).toMatchObject({ stage: 'queued', after: 'Exportknop' }), { timeout: 10_000 })
    expect(git(repo.source, 'log', '--format=%s', 'main')).toBe('Initial')
    finish()
    await vi.waitFor(async () => {
      expect((await completionOf(repo.h, first.handoffId))?.status).toBe('complete')
      expect((await completionOf(repo.h, second.handoffId))?.status).toBe('complete')
    }, { timeout: 15_000 })
    expect(git(repo.source, 'log', '--format=%s', 'main')).toBe('Kleurkiezer change\nExportknop change\nInitial')
  }, 30_000)

  /** A hook that fails, or only pauses, once main's new file meets the Session's: `mark` shows it runs. */
  const slowHook = (mark: string, fail: boolean) => ({
    'pre-commit': `if git cat-file -e :main-only.md 2>/dev/null && git cat-file -e :feature.md 2>/dev/null; then touch '${mark}'; sleep 1; ${fail ? 'echo "FAIL clash" >&2; exit 1' : 'exit 0'}; fi`,
  })
  const mainMoves = (repo: Awaited<ReturnType<typeof linkedFolder>>) => () => {
    writeFileSync(path.join(repo.source, 'main-only.md'), 'main\n')
    git(repo.source, 'add', 'main-only.md')
    git(repo.source, 'commit', '-qm', 'Main adds a file')
  }

  it('stops after three repairs when every amend still fails the hook', async () => {
    const repo = await linkedFolder({ 'a.md': 'a\n' }, {
      'pre-commit': 'if git cat-file -e :main-only.md 2>/dev/null && git cat-file -e :feature.md 2>/dev/null; then echo "FAIL clash" >&2; exit 1; fi',
    })
    const s = await repo.session('Budget', { 'feature.md': 'feature\n' })
    s.scripted.afterCommit = mainMoves(repo)
    let tries = 0
    // Each amend is a new commit that still fails Manor's hook run; the scripted lead skips its own.
    s.scripted.trouble = () => {
      writeFileSync(path.join(s.worktree, 'feature.md'), `try ${++tries}\n`)
      git(s.worktree, 'commit', '-qa', '--amend', '--no-edit', '--no-verify')
    }
    await s.confirm()
    await vi.waitFor(async () => expect((await completionOf(repo.h, s.handoffId))?.status).toBe('blocked'), { timeout: 15_000 })
    expect(repo.requests().filter((event) => event.mergeTrouble !== undefined)).toHaveLength(3)
    expect((await completionOf(repo.h, s.handoffId))?.message).toContain('The lead had 3 tries at this merge')
  }, 30_000)

  it('merges again itself after Retry on a merge it blocked, and settles once it lands', async () => {
    const outage = path.join(os.tmpdir(), `manor-outage-${process.pid}-${Date.now()}`)
    writeFileSync(outage, '')
    onTestFinished(() => rmSync(outage, { force: true }))
    // The merged code's hook fails for a reason outside it, like a service its tests need being down.
    const repo = await linkedFolder({ 'a.md': 'a\n' }, {
      'pre-commit': `if [ -e '${outage}' ] && git cat-file -e :main-only.md 2>/dev/null && git cat-file -e :feature.md 2>/dev/null; then echo "FAIL service down" >&2; exit 1; fi`,
    })
    const s = await repo.session('Retry', { 'feature.md': 'feature\n' })
    s.scripted.afterCommit = mainMoves(repo)
    await s.confirm()
    await vi.waitFor(async () => expect((await completionOf(repo.h, s.handoffId))?.merge?.stage).toBe('blocked'), { timeout: 15_000 })
    // The outage is over; the lead's retry turn finds its commit already on the branch.
    rmSync(outage)
    await repo.h.module.retryCompletion(s.handoffId)
    await vi.waitFor(async () => expect((await completionOf(repo.h, s.handoffId))?.status).toBe('complete'), { timeout: 15_000 })
    expect(git(repo.source, 'log', '--format=%s', 'main')).toBe('Retry change\nMain adds a file\nInitial')
    await vi.waitFor(async () => expect((await repo.h.store.getChat(s.workChatId))?.settledAt).not.toBeNull(), { timeout: 10_000 })
  }, 40_000)

  it('blocks a merge on uncommitted linked-folder changes in the files it touches, names them, and lands after Retry', async () => {
    const repo = await linkedFolder({ 'package.md': 'a\n', 'lock.md': 'a\n', 'other.md': 'a\n' })
    const s = await repo.session('Dirty', { 'package.md': 'session\n', 'lock.md': 'session\n' })
    // The user's own edits: two in the files the Session changes, one it never touches.
    writeFileSync(path.join(repo.source, 'package.md'), 'mine\n')
    writeFileSync(path.join(repo.source, 'lock.md'), 'mine\n')
    writeFileSync(path.join(repo.source, 'other.md'), 'mine\n')
    const head = git(repo.source, 'rev-parse', 'main')
    await s.confirm()
    await vi.waitFor(async () => expect((await completionOf(repo.h, s.handoffId))?.merge?.stage).toBe('blocked'), { timeout: 15_000 })
    // Plain words, no Git output, and only the overlap is named.
    expect((await completionOf(repo.h, s.handoffId))?.message)
      .toBe('Commit or stash your changes to lock.md and package.md in the linked folder, then press Retry. The merge changes those files too.')
    // Manor moved nothing of the user's: no commit, no stash, edits as they left them.
    expect(git(repo.source, 'rev-parse', 'main')).toBe(head)
    expect(git(repo.source, 'stash', 'list')).toBe('')
    expect(git(repo.source, 'status', '--porcelain')).toBe('M lock.md\n M other.md\n M package.md')
    // The user stashes the two files; their unrelated edit stays and does not block the Retry.
    git(repo.source, 'stash', 'push', '-q', '--', 'package.md', 'lock.md')
    await repo.h.module.retryCompletion(s.handoffId)
    await vi.waitFor(async () => expect((await completionOf(repo.h, s.handoffId))?.status).toBe('complete'), { timeout: 15_000 })
    expect(git(repo.source, 'log', '-1', '--format=%s', 'main')).toBe('Dirty change')
    expect(git(repo.source, 'status', '--porcelain')).toBe('M other.md')
  }, 40_000)

  it('catches an untracked folder where the merge adds a file', async () => {
    const repo = await linkedFolder({ 'a.md': 'a\n' })
    const s = await repo.session('Collide', { 'docs.md': 'session\n' })
    execFileSync('mkdir', ['-p', path.join(repo.source, 'docs.md')])
    writeFileSync(path.join(repo.source, 'docs.md', 'mine.md'), 'mine\n')
    await s.confirm()
    await vi.waitFor(async () => expect((await completionOf(repo.h, s.handoffId))?.merge?.stage).toBe('blocked'), { timeout: 15_000 })
    expect((await completionOf(repo.h, s.handoffId))?.message)
      .toBe('Commit or stash your changes to docs.md/mine.md in the linked folder, then press Retry. The merge changes those files too.')
  }, 40_000)

  it('does not wake the lead of a Session settled while its hook ran', async () => {
    const mark = path.join(os.tmpdir(), `manor-hook-${process.pid}-${Date.now()}`)
    onTestFinished(() => rmSync(mark, { force: true }))
    const repo = await linkedFolder({ 'a.md': 'a\n' }, slowHook(mark, true))
    const s = await repo.session('Settled', { 'feature.md': 'feature\n' })
    s.scripted.afterCommit = mainMoves(repo)
    await s.confirm()
    await vi.waitFor(() => expect(existsSync(mark)).toBe(true), { timeout: 10_000 })
    await repo.h.module.setSettled(s.workChatId, true)
    await vi.waitFor(async () => expect((await completionOf(repo.h, s.handoffId))?.status).toBe('blocked'), { timeout: 10_000 })
    expect(repo.requests().filter((event) => event.mergeTrouble !== undefined)).toEqual([])
    expect((await completionOf(repo.h, s.handoffId))?.message).toContain('The Session is settled')
  }, 20_000)

  it('finishes the earlier round when the user reopens the result while its merge runs', async () => {
    const mark = path.join(os.tmpdir(), `manor-hook-${process.pid}-${Date.now()}`)
    onTestFinished(() => rmSync(mark, { force: true }))
    const repo = await linkedFolder({ 'a.md': 'a\n' }, slowHook(mark, false))
    const s = await repo.session('Reopened', { 'feature.md': 'feature\n' })
    s.scripted.afterCommit = mainMoves(repo)
    await s.confirm()
    await vi.waitFor(() => expect(existsSync(mark)).toBe(true), { timeout: 10_000 })
    await repo.h.store.appendEvent(s.workChatId, { type: 'user_message', text: 'One more thing.', mentions: [] })
    const round = async () => (await repo.h.store.listWorkHandoffs()).find((row) => row.id === s.handoffId)?.goalConfirmations?.[0]?.completion
    await vi.waitFor(async () => expect((await round())?.status).toBe('complete'), { timeout: 10_000 })
    expect((await round())?.merge).toBeUndefined()
    expect(git(repo.source, 'log', '--format=%s', 'main')).toBe('Reopened change\nMain adds a file\nInitial')
  }, 20_000)
})

describe('MergeLanes', () => {
  it('holds a folder for a reservation until it is released, and runs a Session confirmed again after its running merge', async () => {
    const runs: string[] = []
    let finish!: () => void
    const lanes = new MergeLanes(async (id) => {
      runs.push(id)
      if (runs.length === 1) await new Promise<void>((resolve) => { finish = resolve })
    }, () => undefined)
    lanes.reserve('earlier', ['/repo'])
    lanes.add('later', ['/repo'])
    expect(lanes.positions().get('later')).toEqual({ after: 'earlier', ahead: 1 })
    expect(runs).toEqual([])
    lanes.release('earlier')
    expect(runs).toEqual(['later'])
    expect(lanes.add('later', ['/repo'])).toBe(true)
    finish()
    await vi.waitFor(() => expect(runs).toEqual(['later', 'later']))
  })
})

describe('commitRequest', () => {
  const tree = { sourcePath: '/repo/manor', worktreePath: '/wt/manor', branch: 'manor/session-1', createdAt: 0 }
  const trees = '- worktree /wt/manor on branch manor/session-1, linked folder /repo/manor'
  const hook = 'Let the pre-commit hook run: never pass --no-verify or skip it any other way. If it fails, fix the cause and commit again; if you cannot, stop with a real failure.'
  const stops = 'If you stop, open the report with "Your choice:" when the user has to pick between versions or commits, or "Real failure:" when something is broken, followed by what blocks in at most twelve words, since their card shows that sentence (for example "Real failure: the pre-commit hook failed in apps/web tests."). Then name the one action they need to take.'

  it('keeps the agent-facing Confirm text byte for byte in every variant', () => {
    expect(commitRequest(undefined, [], undefined, [])).toBe(
      `[Manor] The user confirmed the ready result, and that is their approval to commit. Commit this Session's changes now: stage only the files this Session changed, leave other chats' changes out, and do not push. ${hook} ${stops}`)
    expect(commitRequest('Sage', [], undefined, [])).toBe(
      `[Manor] The user confirmed the ready result, and that is their approval to commit. @Sage, commit this Session's reviewed changes now: stage only the files this Session changed, leave other chats' changes out, and do not push. ${hook} ${stops}`)
    expect(commitRequest(undefined, [tree], undefined, [])).toBe(
      `[Manor] The user confirmed the ready result, and that is their approval to commit, not to merge. Commit this Session's changes on each worktree's branch below and leave them unmerged. Do not push. ${hook} ${stops}\n${trees}`)
    expect(commitRequest('Sage', [tree], 'main', ['- manor/session-1: abc123 Earlier work'])).toBe([
      `[Manor] The user confirmed the ready result, and that is their approval to commit. The merge into main is withheld: the branches already carry commits that are not in main, and their approval does not cover them. @Sage, commit this Session's reviewed changes on each worktree's branch below, leave them unmerged, do not push, and tell the user which commits blocked the merge, as their choice. ${hook} ${stops}`,
      '- manor/session-1: abc123 Earlier work',
      trees,
    ].join('\n'))
    expect(commitRequest(undefined, [tree], 'main', [])).toBe([
      `[Manor] The user confirmed the ready result, and that is their approval to commit and to merge into main. Commit this Session's changes on each worktree's branch below. ${hook}`,
      `Do not rebase, merge or push: when your turn ends Manor rebases each branch onto main and merges it, and comes back to you only if that fails. ${stops}`,
      trees,
    ].join('\n'))
  })

  it('leaves the rebase and merge to Manor, and sends the lead a conflict to resolve with both sides tested', () => {
    const request = commitRequest('Sage', [tree], 'main', [])
    expect(request).toContain('Do not rebase, merge or push')
    expect(request).not.toContain('git merge --ff-only')
    const conflict = mergeTroubleRequest('Sage', { kind: 'conflict', text: 'CONFLICT (content): Merge conflict in a.ts', repo: '/wt/manor' }, 'manor/session-1', 'main')
    expect(conflict).toContain('CONFLICT (content): Merge conflict in a.ts')
    expect(conflict).toContain('@Sage, in the worktree /wt/manor, rebase manor/session-1 onto main yourself and resolve the conflict')
    expect(conflict).toContain('the tests covering the files those commits changed')
    expect(conflict).toContain('amend it into your commit')
    expect(conflict).toContain("Manor shows the user how you resolved the conflict, unless you only kept both sides' lines")
    expect(conflict).toContain("Do not merge, push or touch the linked folder")
    const hookFailed = mergeTroubleRequest(undefined, { kind: 'hook', text: 'FAIL a.test.ts', repo: '/wt/manor' }, 'manor/session-1', 'main')
    expect(hookFailed).toContain('the pre-commit hook failed on the result')
    expect(hookFailed).toContain('Fix the cause in the worktree /wt/manor')
  })

  it('bans --no-verify and asks for a categorized stop in every variant', () => {
    const variants = [
      commitRequest(undefined, [], undefined, []),
      commitRequest(undefined, [tree], undefined, []),
      commitRequest('Sage', [tree], 'main', ['- manor/session-1: abc123 Earlier work']),
      commitRequest(undefined, [tree], 'main', []),
      ...(['conflict', 'hook', 'rebase'] as const).map((kind) => mergeTroubleRequest(undefined, { kind, text: 'x', repo: '/wt/manor' }, 'manor/session-1', 'main')),
    ]
    for (const request of variants) {
      expect(request).toContain('never pass --no-verify or skip it any other way')
      expect(request).toContain('if you cannot, stop with a real failure')
      expect(request).toContain('open the report with "Your choice:"')
      expect(request).toContain('or "Real failure:" when something is broken, followed by what blocks in at most twelve words')
    }
  })

  it('describes the same request as data for the tasks card', () => {
    const worktrees = [{ branch: 'manor/session-1', folder: 'manor', source: '/repo/manor' }]
    expect(confirmRequestOf([], undefined, [])).toEqual({ variant: 'checkout', worktrees: [] })
    expect(confirmRequestOf([tree], undefined, [])).toEqual({ variant: 'worktree', worktrees })
    expect(confirmRequestOf([tree], 'main', [])).toEqual({ variant: 'merge', worktrees, mergeInto: 'main' })
    expect(confirmRequestOf([tree], 'main', ['- manor/session-1: abc123'])).toEqual({ variant: 'merge_withheld', worktrees, mergeInto: 'main' })
  })
})
