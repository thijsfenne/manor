import { type AgentConfig, type CheckoutRequest, type TurnInput } from '@manor/contracts'
import { describe, expect, it, vi } from 'vitest'
import { Orchestrator } from '../src/orchestrator.js'
import { createMemoryStore } from '../src/stores/memoryStore.js'
import { WorkModule, commitRequest, confirmRequestOf, mergeTroubleRequest, retryRequest } from '../src/workModule.js'
import { WorkCapabilities } from '../src/workCapability.js'
import { MergeLanes } from '../src/workMerge.js'
import { sage, seededChat, smith, until, scripted, scratchFor } from './helpers.js'
import { acceptedWork, context, harness, held, input, lead, noteSent, propose, settledNotes } from './workModuleHarness.js'

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
        isIdle: () => true,
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
    await until(() => noteSent(h, 'Session “Ship handoffs” settled, outcome unavailable.'), 'the unavailable note')

    expect((await h.store.listWorkHandoffs())[0]).toMatchObject({ state: 'settled', result: null, version: 2 })
    expect(await h.store.loadEvents(h.source.id)).toContainEqual(expect.objectContaining({
      type: 'system_note',
      workHandoffPhase: 'settled',
      text: 'Session “Ship handoffs” settled, outcome unavailable.',
    }))
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
