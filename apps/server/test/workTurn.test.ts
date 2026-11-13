import type { AttachedMcpServer, Driver, RuntimeEvent, ServerMessage, TurnInput } from '@manor/contracts'
import { describe, expect, it } from 'vitest'
import { AsyncQueue } from '../src/asyncQueue.js'
import { WRONG_AGENT_RULE } from '../src/composer.js'
import { createMockDriver } from '../src/drivers/mockDriver.js'
import { Orchestrator } from '../src/orchestrator.js'
import { WORK_HANDOFF_ANSWERED_NUDGE } from '../src/turnRunner.js'
import type { Store } from '../src/store.js'
import { createMemoryStore } from '../src/stores/memoryStore.js'
import type { WorkOrigin } from '../src/workModule.js'
import { marlow, recording, roster, scratchFor, scripted, seededChat, until } from './helpers.js'

const attachment: AttachedMcpServer = {
  server: {
    id: 'builtin_work', name: 'work', command: '', args: [], envKeys: [],
    description: 'Start explicitly requested Work.', writes: true,
    effectPolicy: 'trusted', tools: ['start_work'], readOnlyTools: [], schemaChars: 0,
  },
  disabledTools: [],
}

/** The kickoff the store writes at Accept, so the turn under test finds it already durable. */
function storeKickoff(store: Store, chatId: string, text: string, origin: WorkOrigin) {
  return store.appendEvent(chatId, {
    type: 'user_message',
    text,
    mentions: [],
    source: origin.source,
    workHandoffId: origin.handoffId,
    workSourceChatId: origin.sourceChatId,
    workAuthorAgentId: origin.authorAgentId,
    workSupportingAgentIds: origin.supportingAgentIds,
    workTargetLeadId: origin.targetAgentId,
  })
}

async function harness() {
  const store = createMemoryStore({ agents: roster })
  const { projectId, chatId } = await seededChat(store)
  const seen: TurnInput[] = []
  const sent: ServerMessage[] = []
  const orchestrator = new Orchestrator({
    agents: () => roster,
    store,
    mcpServers: () => [],
    skills: () => [],
    workMcp: () => attachment,
    resolveDriver: () => recording(createMockDriver({ deltaDelayMs: 0 }), seen),
    ensureScratchDir: scratchFor,
    emit: (message) => sent.push(message),
  })
  return { store, orchestrator, projectId, chatId, seen }
}

describe('Work handoff routing', () => {
  it('answers a new user message after settle while retaining the manual settled marker', async () => {
    const h = await harness()
    const dm = await h.store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })
    for (const chatId of [dm.id, h.chatId]) {
      await h.store.setChatSettled(chatId, true)
      h.orchestrator.stopChat(chatId)
      await h.orchestrator.submitUserMessage(chatId, '@Sage one more question.')
      expect(h.seen.at(-1)?.threadId).toBe(chatId)
      expect((await h.store.getChat(chatId))?.settledAt).not.toBeNull()
    }
    expect(h.seen).toHaveLength(2)
    h.orchestrator.stopChat(dm.id)
    await h.orchestrator.submitUserMessage(dm.id, 'Run the next scheduled check.', [], {
      source: 'routine', routineId: 'routine_1', routineName: 'Daily check',
      targetAgentId: 'sage', previousRunAt: null,
    })
    // DM routines nudge once when the mock reply omits the outcome marker.
    expect(h.seen).toHaveLength(4)
    expect(h.seen.at(-1)?.threadId).toBe(dm.id)
    expect((await h.store.getChat(dm.id))?.settledAt).not.toBeNull()
  })

  it('offers the bounded tool only to a direct ordinary Chat turn', async () => {
    const h = await harness()
    const dm = await h.store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })
    const group = await h.store.createChat({ kind: 'group', memberIds: ['sage', 'smith'], title: 'Team' })

    await h.orchestrator.submitUserMessage(dm.id, 'Make this Work.')
    await h.orchestrator.submitUserMessage(group.id, '@Sage make this Work.')
    await h.orchestrator.submitUserMessage(group.id, 'Could somebody make this Work?')
    await h.orchestrator.submitUserMessage(group.id, '@Sage @Smith both look at this.')
    await h.orchestrator.submitUserMessage(h.chatId, '@Sage continue the existing Work.')
    const side = await h.store.sideChatFor(dm.id)
    await h.orchestrator.submitUserMessage(side.id, 'Why does this break?')

    expect(h.seen.filter((input) => input.threadId !== h.chatId).every((input) =>
      !input.agent.character.includes('[Manor] Routing in this Work thread:'),
    )).toBe(true)
    expect(h.seen.map((input) => [
      input.threadId,
      input.agent.id,
      (input.mcpServers ?? []).some((server) => server.server.id === 'builtin_work'),
    ])).toEqual([
      [dm.id, 'sage', true],
      [group.id, 'sage', true],
      // An open group message has one root preparer, so a surfaced fix can be proposed.
      [group.id, 'sage', true],
      [group.id, 'sage', false],
      [group.id, 'smith', false],
      [h.chatId, 'sage', false],
      [side.id, 'aside', false],
    ])
    // Every Chat turn forbids code edits; a turn without start_work says how to get the
    // proposal. Work threads are where edits belong, and a side chat has its own rules.
    expect(h.seen.map((input) => [
      input.agent.character.includes('Code changes never happen in a Chat.'),
      input.agent.character.includes('`start_work` is not available on this turn.'),
    ])).toEqual([[true, false], [true, false], [true, false], [true, true], [true, true], [false, false], [false, false]])
  })

  it('routes @work through one preparer in DM, group and existing Work', async () => {
    const h = await harness()
    const dm = await h.store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })
    const group = await h.store.createChat({ kind: 'group', memberIds: ['sage', 'smith'], title: 'Team' })
    for (const chatId of [dm.id, group.id, h.chatId]) {
      await h.orchestrator.submitUserMessage(chatId, '@work stuur de drie besproken opdrachten los door')
      const input = h.seen.at(-1)!
      expect(input.threadId).toBe(chatId)
      expect(input.mcpServers).toContainEqual(attachment)
      expect(input.agent.character).toContain('assignmentKey')
      expect(input.agent.character).toContain('Available Work projects:')
      expect(input.agent.character).toContain(h.projectId)
    }
    // The mock produces no Work, so each enforced handoff gets one bounded retry.
    expect(h.seen).toHaveLength(6)
    expect(new Set(h.seen.map((input) => input.agent.id))).toEqual(new Set(['sage']))
  })

  it('keeps the last Work speaker ahead of the open-room fallback', async () => {
    const h = await harness()
    await h.store.appendEvent(h.chatId, { type: 'agent_message', agentId: 'smith', turnId: 'prior', text: 'Three briefs are ready.' })
    await h.orchestrator.submitUserMessage(h.chatId, '@work forward these separately')
    expect(h.seen).toHaveLength(2)
    expect(h.seen.every((input) => input.agent.id === 'smith' && input.threadId === h.chatId)).toBe(true)
  })

  it('leaves room to clarify @work when the project is ambiguous', async () => {
    const h = await harness()
    await h.store.createProject('Another project')
    const dm = await h.store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })
    await h.orchestrator.submitUserMessage(dm.id, '@work build this')
    expect(h.seen).toHaveLength(1)
    expect(h.seen[0]?.mcpServers).toContainEqual(attachment)
    expect(h.seen[0]?.agent.character).toContain('ask which project only when genuinely ambiguous')
  })

  it('makes an explicit named-project request outrank ordinary persona delegation', async () => {
    const h = await harness()
    const dm = await h.store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })

    await h.orchestrator.submitUserMessage(dm.id, 'Laat Smith dit uitwerken in project Manor.')

    const input = h.seen.at(-1)
    expect(h.seen).toHaveLength(2)
    expect(input?.mcpServers?.some((server) => server.server.tools.includes('start_work'))).toBe(true)
    expect(input?.agent.character).toContain('you MUST call `start_work` in this turn')
    expect(input?.agent.character).toContain('Never satisfy that request with an @mention or delegation in the source Chat')
    expect(input?.agent.character).toContain('Chat personas remain the contacts and authors, never the executors.')
    expect(input?.agent.character.lastIndexOf('[Manor] Explicit project handoffs:')).toBeGreaterThan(
      input?.agent.character.lastIndexOf('[Manor] Also in this workspace:') ?? -1,
    )
    const events = await h.store.loadEvents(dm.id)
    expect(events.some((event) => event.type === 'agent_message')).toBe(false)
    expect(events).toContainEqual(expect.objectContaining({
      type: 'system_note', kind: 'error', text: 'Sage could not create the explicitly requested session handoff.',
    }))
  })

  it.each([
    { answer: 'Klopt', failed: true },
    { answer: 'Nee, laat maar.', failed: false },
  ])('retries a restatement answered $answer by the user’s answer, failing only after a confirmation', async ({ answer, failed }) => {
    const store = createMemoryStore({ agents: roster })
    await seededChat(store)
    const seen: TurnInput[] = []
    const sent: ServerMessage[] = []
    const turns: AsyncQueue<RuntimeEvent>[] = []
    const driver: Driver = {
      startTurn(input) {
        seen.push(input)
        const events = new AsyncQueue<RuntimeEvent>()
        turns.push(events)
        return { events, stop: () => events.close() }
      },
    }
    const orchestrator = new Orchestrator({
      agents: () => roster, store, mcpServers: () => [], skills: () => [], workMcp: () => attachment,
      resolveDriver: () => driver, ensureScratchDir: scratchFor, emit: (message) => sent.push(message),
    })
    const dm = await store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })
    const running = orchestrator.submitUserMessage(dm.id, 'Laat Smith dit uitwerken in project Manor.')
    await until(() => turns.length === 1 && sent.some((message) => message.type === 'turn_state' && message.state === 'running'), 'the handoff turn')
    const announced = sent.find((message) => message.type === 'turn_state' && message.state === 'running')
    const turnId = announced?.type === 'turn_state' ? announced.turnId : ''
    expect(seen[0]?.agent.character).toContain('call `ask_user` before `start_work`')
    await orchestrator.recordUserInputRequest(dm.id, 'sage', turnId, 'restate', [{
      id: 'restate', question: 'You want X because Y. Right?', options: [{ label: 'Klopt' }, { label: 'Niet helemaal' }],
    }])
    await orchestrator.recordUserInputResponse(dm.id, 'sage', turnId, 'restate', { restate: answer })
    // The agent forgets `start_work` on both attempts.
    turns[0]!.push({ type: 'result', text: 'Oké.', sessionId: 's' })
    turns[0]!.close()
    await until(() => turns.length === 2, 'the handoff retry')
    expect(seen[1]?.catchUp[0]).toMatchObject({ text: WORK_HANDOFF_ANSWERED_NUDGE })
    turns[1]!.push({ type: 'result', text: 'Begrepen, ik stel niets voor.', sessionId: 's' })
    turns[1]!.close()
    await running

    expect(seen).toHaveLength(2)
    const events = await store.loadEvents(dm.id)
    expect(events.some((event) => event.type === 'system_note' && event.text === 'Sage could not create the explicitly requested session handoff.')).toBe(failed)
    expect(events.some((event) => event.type === 'agent_message' && event.text === 'Begrepen, ik stel niets voor.')).toBe(!failed)
  })

  it('publishes a successful handoff response without also summoning in the source Chat', async () => {
    const store = createMemoryStore({ agents: roster })
    const { projectId } = await seededChat(store)
    const dm = await store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })
    const seen: TurnInput[] = []
    let sourceTurnId: string | undefined
    const driver: Driver = {
      startTurn(input) {
        seen.push(input)
        const events = new AsyncQueue<RuntimeEvent>()
        void (async () => {
          if (sourceTurnId === undefined) throw new Error('turn id was not announced')
          const { handoff } = await store.reserveWorkHandoff({
            sourceChatId: dm.id,
            sourceTurnId,
            kickoff: 'Implement reply support.',
            authorAgentId: 'sage',
            projectId,
            projectName: 'Manor',
            title: 'Reply support',
            leadAgentId: 'sage',
            leadAgentName: 'Sage',
            supportingAgentIds: ['smith'],
            supportingAgentNames: ['Smith'],
          })
          await store.finalizeWorkHandoff(handoff.id, null, {
            type: 'system_note',
            kind: 'info',
            text: 'Work started.',
            workHandoffId: handoff.id,
            workHandoffPhase: 'created',
          })
          events.push({
            type: 'result',
            text: 'Work started. @Smith will take it from here.',
            sessionId: 'session_1',
          })
        })().catch((error: unknown) => {
          events.push({ type: 'error', message: error instanceof Error ? error.message : String(error) })
        }).finally(() => events.close())
        return { events, stop: () => events.close() }
      },
    }
    const orchestrator = new Orchestrator({
      agents: () => roster,
      store,
      mcpServers: () => [],
      skills: () => [],
      workMcp: () => attachment,
      resolveDriver: () => driver,
      ensureScratchDir: scratchFor,
      emit: (message) => {
        if (message.type === 'turn_state' && message.state === 'running') sourceTurnId = message.turnId
      },
    })

    await orchestrator.submitUserMessage(dm.id, 'Laat Smith dit uitwerken in project Manor.')

    expect(seen).toHaveLength(1)
    expect(await store.workHandoffForSourceTurn(dm.id, sourceTurnId ?? '')).toBeDefined()
    expect(await store.loadEvents(dm.id)).toContainEqual(expect.objectContaining({
      type: 'agent_message',
      text: 'Work started. @Smith will take it from here.',
    }))
  })

  it('stores an attributed kickoff, routes only the lead and crosses no source transcript', async () => {
    const h = await harness()
    const source = await h.store.createChat({ kind: 'group', memberIds: ['sage', 'smith'], title: 'Team' })
    await h.store.appendEvent(source.id, { type: 'user_message', text: 'Secret irrelevant history.', mentions: [] })
    const target = await h.store.createChat({ kind: 'project', projectId: h.projectId, title: 'Bounded work' })
    const origin: WorkOrigin = {
      source: 'work_handoff',
      handoffId: 'handoff_1',
      sourceChatId: source.id,
      authorAgentId: 'sage',
      supportingAgentIds: ['smith'],
      targetAgentId: 'sage',
    }

    await storeKickoff(h.store, target.id, 'Complete kickoff only.', origin)
    await h.orchestrator.startStoredWorkHandoff(target.id, 'Complete kickoff only.', origin)

    const input = h.seen.at(-1)
    expect(input?.agent.id).toBe('sage')
    expect(input?.catchUp).toEqual([
      expect.objectContaining({
        type: 'user_message',
        source: 'work_handoff',
        text: 'Complete kickoff only.',
        workAuthorAgentId: 'sage',
        workSupportingAgentIds: ['smith'],
        workTargetLeadId: 'sage',
      }),
    ])
    expect(JSON.stringify(input?.catchUp)).not.toContain('Secret irrelevant history')
    expect(h.seen.filter((seen) => seen.threadId === target.id)).toHaveLength(1)
  })

  it('does not start a stored kickoff after the Work chat was stopped', async () => {
    const h = await harness()
    const source = await h.store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })
    const target = await h.store.createChat({ kind: 'project', projectId: h.projectId, title: 'Bounded work' })
    const origin: WorkOrigin = {
      source: 'work_handoff',
      handoffId: 'handoff_1',
      sourceChatId: source.id,
      authorAgentId: 'sage',
      supportingAgentIds: [],
      targetAgentId: 'sage',
    }

    await storeKickoff(h.store, target.id, 'Complete kickoff only.', origin)
    h.orchestrator.stopChat(target.id)
    await h.orchestrator.startStoredWorkHandoff(target.id, 'Complete kickoff only.', origin)

    expect(h.seen.filter((seen) => seen.threadId === target.id)).toHaveLength(0)
  })

  it('starts a supporting turn the lead summons from the kickoff', async () => {
    const agents = roster.map((agent) =>
      agent.id === 'sage' ? { ...agent, mentionAllowlist: ['smith'] } : agent,
    )
    const store = createMemoryStore({ agents })
    const { projectId } = await seededChat(store)
    const source = await store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })
    const target = await store.createChat({ kind: 'project', projectId, title: 'Bounded work' })
    const seen: TurnInput[] = []
    const origin: WorkOrigin = {
      source: 'work_handoff',
      handoffId: 'handoff_1',
      sourceChatId: source.id,
      authorAgentId: 'sage',
      supportingAgentIds: ['smith'],
      targetAgentId: 'sage',
    }
    const orchestrator = new Orchestrator({
      agents: () => agents,
      store,
      mcpServers: () => [],
      skills: () => [],
      workMcp: () => attachment,
      resolveDriver: () => scripted((input) => [{
        type: 'result',
        text: input.agent.id === 'sage' ? '@Smith take the implementation.' : 'Smith started.',
        sessionId: 's',
      }], seen),
      ensureScratchDir: scratchFor,
      emit: () => undefined,
    })

    await storeKickoff(store, target.id, 'Complete kickoff only.', origin)
    await orchestrator.startStoredWorkHandoff(target.id, 'Complete kickoff only.', origin)

    expect(seen.map((input) => input.agent.id)).toEqual(['sage', 'smith'])
  })

  it.each(['available', 'not-allowlisted', 'chat-placed', 'removed'] as const)(
    'gives Jeeves the Work route and enforces a specialist that is %s',
    async (availability) => {
      const jeeves = { ...marlow, name: 'Jeeves', character: 'You are Jeeves. Historical memory: name the specialist and never summon.', mentionAllowlist: availability === 'not-allowlisted' ? [] : ['smith'] }
      const agents = [jeeves, ...roster.filter((agent) => availability !== 'removed' || agent.id !== 'smith')
        .map((agent) => agent.id === 'smith' && availability === 'chat-placed' ? { ...agent, placement: 'chat' as const } : agent)]
      const store = createMemoryStore({ agents })
      const { projectId } = await seededChat(store)
      const target = await store.createChat({ kind: 'project', projectId, title: 'Work delegation' })
      const seen: TurnInput[] = []
      const origin: WorkOrigin = {
        source: 'work_handoff', handoffId: 'handoff_1', sourceChatId: 'source',
        authorAgentId: 'marlow', supportingAgentIds: ['smith'], targetAgentId: 'marlow',
      }
      const assignment = '@Smith investigate the agent invocation bug; leave the Accept lifecycle alone.'
      const orchestrator = new Orchestrator({
        agents: () => agents, store, mcpServers: () => [], skills: () => [],
        workMcp: () => attachment,
        resolveDriver: () => scripted((input) => [{
          type: 'result', sessionId: 's',
          // Even an invalid model mention must not override room eligibility.
          text: input.agent.id === 'marlow' ? assignment : 'Assignment received.',
        }], seen),
        ensureScratchDir: scratchFor, emit: () => undefined,
      })
      await storeKickoff(store, target.id, 'Investigate agent invocation with Smith.', origin)
      await orchestrator.startStoredWorkHandoff(target.id, 'Investigate agent invocation with Smith.', origin)

      const input = seen[0]!
      const rule = input.agent.character.split('[Manor] Routing in this Work thread:')[1]!
      expect(rule).toContain('No tool call, tool discovery, message_agent, or start_work is needed')
      expect(rule).toContain('Available and inactive are different')
      // The routing block is the Work turn's one delegation rule: no chat wrong-agent
      // rule beside it, no DM bubble rule, and no DM pin in the catch-up.
      expect(input.agent.character).not.toContain(WRONG_AGENT_RULE)
      expect(input.agent.character).not.toContain('write no user-facing text before your last tool call')
      expect(input.dm).toBeUndefined()
      expect((input.mcpServers ?? []).some((server) => server.server.tools.includes('start_work'))).toBe(false)
      expect(input.agent.character.lastIndexOf('[Manor] Routing in this Work thread:')).toBeGreaterThan(
        input.agent.character.lastIndexOf('[Manor] Also in this workspace:'),
      )
      if (availability === 'available') {
        expect(rule).toContain('You may summon these specialists here: @Smith.')
        expect(seen.map((turn) => turn.agent.id)).toEqual(['marlow', 'smith'])
        expect(seen[1]?.catchUp).toContainEqual(expect.objectContaining({
          type: 'agent_message', agentId: 'marlow', text: assignment,
        }))
        expect(await store.loadEvents(target.id)).toContainEqual(expect.objectContaining({
          type: 'agent_message', agentId: 'smith', text: 'Assignment received.',
        }))
      } else {
        expect(rule).toContain('You cannot summon another persona from this Work turn')
        expect(rule).not.toContain('@Smith')
        expect(seen.map((turn) => turn.agent.id)).toEqual(['marlow'])
      }
    },
  )

  it('does not start a summoned supporting turn after the Work chat was stopped', async () => {
    const agents = roster.map((agent) =>
      agent.id === 'sage' ? { ...agent, mentionAllowlist: ['smith'] } : agent,
    )
    const store = createMemoryStore({ agents })
    const { projectId } = await seededChat(store)
    const source = await store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })
    const target = await store.createChat({ kind: 'project', projectId, title: 'Bounded work' })
    const seen: TurnInput[] = []
    const origin: WorkOrigin = {
      source: 'work_handoff',
      handoffId: 'handoff_1',
      sourceChatId: source.id,
      authorAgentId: 'sage',
      supportingAgentIds: ['smith'],
      targetAgentId: 'sage',
    }
    let orchestrator: Orchestrator
    orchestrator = new Orchestrator({
      agents: () => agents,
      store,
      mcpServers: () => [],
      skills: () => [],
      workMcp: () => attachment,
      resolveDriver: () => scripted((input) => [{
        type: 'result',
        text: input.agent.id === 'sage' ? '@Smith take the implementation.' : 'Smith started.',
        sessionId: 's',
      }], seen),
      ensureScratchDir: scratchFor,
      emit: (message) => {
        // After the lead's answer, before the supporting turn's run(). Halt here is
        // the Reject gap where active is still the lead and Smith is about to queue.
        if (message.type === 'turn_state' && message.state === 'done' && message.agentId === 'sage') {
          orchestrator.stopChat(target.id)
        }
      },
    })

    await storeKickoff(store, target.id, 'Complete kickoff only.', origin)
    await orchestrator.startStoredWorkHandoff(target.id, 'Complete kickoff only.', origin)

    expect(seen.map((input) => input.agent.id)).toEqual(['sage'])
  })
})
