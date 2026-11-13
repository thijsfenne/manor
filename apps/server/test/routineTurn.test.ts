import type {
  AgentConfig,
  AttachedMcpServer,
  Driver,
  ServerMessage,
  SkillConfig,
  TurnInput,
} from '@manor/contracts'
import { describe, expect, it } from 'vitest'
import { DM_ROUTINE_OUTCOME_HEADING, DM_ROUTINE_QUIET_MARKER, RUN_ROUTINE_OUTCOME_HEADING } from '../src/composer.js'
import { createMockDriver } from '../src/drivers/mockDriver.js'
import { Orchestrator, type RoutineOrigin } from '../src/orchestrator.js'
import { createMemoryStore } from '../src/stores/memoryStore.js'
import { runRoutineNow } from '../src/routineScheduler.js'
import { cosRoster, recording, roster, scratchFor, scripted, seededChat } from './helpers.js'

/**
 * The routine seam in the orchestrator (step 3 of the routines plan). What is under
 * test is one optional argument: with it set the message is addressed rather than
 * routed, the turn it starts brings nobody in, and the transcript says which routine
 * sent it.
 */
interface Options {
  agents?: readonly AgentConfig[]
  skills?: readonly SkillConfig[]
  routineMcp?: (chatId: string, agent: AgentConfig, turnId: string) => AttachedMcpServer
}

async function harness(driver: Driver, options: Options = {}) {
  const agents = options.agents ?? roster
  const store = createMemoryStore({ agents })
  const { chatId } = await seededChat(store)
  const sent: ServerMessage[] = []
  const orchestrator = new Orchestrator({
    agents: () => agents,
    store,
    mcpServers: () => [],
    skills: () => options.skills ?? [],
    ...(options.routineMcp === undefined ? {} : { routineMcp: options.routineMcp }),
    resolveDriver: () => driver,
    ensureScratchDir: scratchFor,
    emit: (message) => sent.push(message),
  })
  return { orchestrator, store, chatId, sent }
}

const origin = (overrides: Partial<RoutineOrigin> = {}): RoutineOrigin => ({
  source: 'routine',
  routineId: 'routine_1',
  routineName: 'Morning brief',
  targetAgentId: 'sage',
  previousRunAt: null,
  ...overrides,
})

const speakers = (events: readonly { type: string }[]) =>
  events
    .filter((event) => event.type !== 'turn_result' && event.type !== 'reasoning')
    .map((event) => [event.type, 'agentId' in event ? event.agentId : 'user'])

describe('a routine turn', () => {
  it.each([
    { driver: 'claude', model: 'claude-opus-5', effort: 'medium' },
    { driver: 'codex', model: 'gpt-5.6-sol', effort: 'medium' },
    { driver: 'grok', model: 'grok-4.6', effort: 'medium' },
    { driver: 'cursor', model: 'cursor-composer-2.5', effort: 'medium' },
  ] as const)('runs a single $driver routine without a persona roster', async (runtime) => {
    const seen: TurnInput[] = []
    const { store, orchestrator } = await harness(recording(createMockDriver({ deltaDelayMs: 0 }), seen), { agents: [] })
    const routine = await store.saveRoutine({
      projectId: null, chatId: null, agentId: '__single__',
      name: 'Inbox sorter', prompt: 'Sort the inbox. @Sage is quoted text.',
      cron: '0 7 * * *', timezone: 'Europe/Amsterdam', enabled: true, notify: false,
      model: runtime.model, effort: runtime.effort,
    })
    const result = await runRoutineNow({
      store, routineId: routine.id,
      runTurn: (entry, chatId) => orchestrator.submitUserMessage(chatId, entry.prompt, [], origin({
        routineId: entry.id, targetAgentId: entry.agentId,
      })),
    })
    expect(result).toMatchObject({ kind: 'ran', ok: true })
    const [run] = await store.listRuns(routine.id)
    // No project named: the task and its run work in the home room, the memory system.
    expect(run).toMatchObject({ mode: 'single', kind: 'run', projectId: 'home', singleDriver: runtime.driver })
    expect(await store.loadChatOverrides(run!.id)).toEqual({ __single__: runtime })
    // A run thread takes the outcome protocol; the mock never declares one, so the
    // run gets its one outcome nudge.
    expect(seen).toHaveLength(2)
    expect(seen[0]!.contextBlock).toContain(RUN_ROUTINE_OUTCOME_HEADING)
    expect(seen[0]!.agent).toMatchObject({ id: '__single__', ...runtime, mentionAllowlist: [] })
    await expect(store.saveRoutine({ ...routine, model: null })).rejects.toThrow('provider, model and effort')
    await expect(store.saveRoutine({ ...routine, projectId: null, chatId: run!.id })).rejects.toThrow('cannot target a direct message')
  })

  it('is addressed to the named persona and says so in the transcript', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, store, chatId } = await harness(recording(createMockDriver({ deltaDelayMs: 0 }), seen))

    await orchestrator.submitUserMessage(chatId, 'What changed overnight?', [], origin())

    expect(seen.map((input) => input.agent.id)).toEqual(['sage'])
    const [first] = await store.loadEvents(chatId)
    expect(first).toMatchObject({
      type: 'user_message',
      text: 'What changed overnight?',
      // Never a the user bubble: the transcript renders this as a centred routine line,
      // because a prompt the user did not type must not appear as words they said.
      source: 'routine',
      routineId: 'routine_1',
      routineName: 'Morning brief',
      mentions: [],
    })
  })

  // Without the target, an un-mentioned message goes to the chief of staff. A
  // routine addressed to Sage that Marlow answered would be the whole feature going
  // to the wrong voice, silently.
  it('skips the chief-of-staff fallback and every other one', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, chatId } = await harness(recording(createMockDriver({ deltaDelayMs: 0 }), seen), {
      agents: cosRoster,
    })

    await orchestrator.submitUserMessage(chatId, 'What changed overnight?', [], origin())

    expect(seen.map((input) => input.agent.id)).toEqual(['sage'])
  })

  it('does not read its own prompt for routing: an @name in it is text, not an instruction', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, store, chatId } = await harness(recording(createMockDriver({ deltaDelayMs: 0 }), seen))

    await orchestrator.submitUserMessage(chatId, 'Ask @Smith about the deploy', [], origin())

    expect(seen.map((input) => input.agent.id)).toEqual(['sage'])
    expect((await store.loadEvents(chatId))[0]).toMatchObject({ mentions: [] })
  })

  it('never invokes a skill, because nobody chose one for this run', async () => {
    const seen: TurnInput[] = []
    const brainstorm: SkillConfig = {
      id: 'brainstorm',
      name: 'Brainstorm',
      description: 'Explore alternatives.',
      instructions: 'Generate three distinct approaches before choosing one.',
      sources: ['claude', 'codex'],
    }
    const skilled = roster.map((agent) => (agent.id === 'sage' ? { ...agent, skillIds: ['brainstorm'] } : agent))
    const { orchestrator, store, chatId } = await harness(recording(createMockDriver({ deltaDelayMs: 0 }), seen), {
      agents: skilled,
      skills: [brainstorm],
    })

    await orchestrator.submitUserMessage(chatId, '$brainstorm what changed overnight?', [], origin())

    expect(seen[0]?.agent.character).not.toContain(brainstorm.instructions)
    expect((await store.loadEvents(chatId))[0]).not.toHaveProperty('skillIds')
  })

  it('keeps a quiet line in its own run thread, marker stripped, and records it as quiet', async () => {
    const seen: TurnInput[] = []
    const text = `Checked 12 threads, nothing new.\n${DM_ROUTINE_QUIET_MARKER}`
    const { orchestrator, store } = await harness(
      scripted(() => [
        { type: 'message', messageId: 'quiet', text },
        { type: 'result', text, sessionId: 'session-1' },
      ], seen),
    )
    const [project] = await store.listProjects()
    const routine = await store.saveRoutine({
      projectId: project!.id, chatId: null, agentId: 'sage', name: 'Triage', prompt: 'Check Slack.',
      cron: '0 7 * * *', timezone: 'Europe/Amsterdam', enabled: true, notify: true, model: null, effort: null,
    })
    const run = await store.createChat({ projectId: project!.id, kind: 'run', routineId: routine.id, title: 'Triage' })

    await orchestrator.submitUserMessage(run.id, 'Check Slack.', [], origin({ routineId: routine.id }))

    expect(seen).toHaveLength(1)
    expect(seen[0]?.contextBlock).toContain(RUN_ROUTINE_OUTCOME_HEADING)
    const events = await store.loadEvents(run.id)
    expect(events.flatMap((event) => event.type === 'agent_message' ? [event.text] : [])).toEqual([
      'Checked 12 threads, nothing new.',
    ])
    expect(events.find((event) => event.type === 'turn_result')).toMatchObject({ routineOutcome: 'quiet' })
  })

  it('still runs inside a dm, where the target is the member', async () => {
    const seen: TurnInput[] = []
    const text = `Nothing new.\n${DM_ROUTINE_QUIET_MARKER}`
    const { orchestrator, store } = await harness(
      scripted(() => [
        { type: 'message', messageId: 'quiet', text },
        { type: 'result', text, sessionId: 'session-1' },
      ], seen),
    )
    const dm = await store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })

    await orchestrator.submitUserMessage(dm.id, 'What changed overnight?', [], origin())

    expect(seen.map((input) => input.agent.id)).toEqual(['sage'])
  })

  it('offers routine management only in a manual turn in that persona’s DM', async () => {
    const seen: TurnInput[] = []
    const issued: { chatId: string; agentId: string; turnId: string }[] = []
    const attachment: AttachedMcpServer = {
      server: {
        id: 'builtin_routines',
        name: 'routines',
        command: '',
        args: [],
        envKeys: [],
        description: 'Manage this DM’s routines.',
        writes: true,
        effectPolicy: 'confirm_writes' as const,
        tools: ['routine_list', 'routine_save'],
        readOnlyTools: [],
        schemaChars: 0,
      },
      disabledTools: [],
    }
    const quiet = `Nothing new.\n${DM_ROUTINE_QUIET_MARKER}`
    const { orchestrator, store, chatId } = await harness(
      scripted((input) => {
        const text = input.catchUp.some((event) => event.type === 'user_message' && event.source === 'routine')
          ? quiet
          : 'Done.'
        return [
          { type: 'message', messageId: 'reply', text },
          { type: 'result', text, sessionId: 'session-1' },
        ]
      }, seen),
      {
        routineMcp: (issuedChatId, agent, turnId) => {
          issued.push({ chatId: issuedChatId, agentId: agent.id, turnId })
          return attachment
        },
      },
    )
    const dm = await store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })

    await orchestrator.submitUserMessage(dm.id, 'Make that a routine.')
    await orchestrator.submitUserMessage(dm.id, 'Check Slack.', [], origin())
    await orchestrator.submitUserMessage(chatId, '@Sage make that a routine.')

    expect(seen).toHaveLength(3)
    expect((seen[0]?.mcpServers ?? []).map((server) => server.server.id)).toContain('builtin_routines')
    expect((seen[1]?.mcpServers ?? []).map((server) => server.server.id)).not.toContain('builtin_routines')
    expect((seen[2]?.mcpServers ?? []).map((server) => server.server.id)).not.toContain('builtin_routines')
    expect(issued).toEqual([
      { chatId: dm.id, agentId: 'sage', turnId: expect.stringMatching(/^turn_/) },
    ])
  })

  // Decided 2026-09-25 (Mail catch-up carried ~75k of DM history per call): a DM fire
  // no longer resumes the conversation, so a correction typed in the DM belongs in the
  // routine's own prompt to reach the next run.
  it('starts a DM routine fire fresh with only its message and the previous successful watermark', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, store } = await harness(
      scripted(() => [{ type: 'result', text: 'Done.', sessionId: `session-${seen.length}` }], seen),
    )
    const dm = await store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })
    await orchestrator.submitUserMessage(dm.id, 'Start watching Slack.')
    await store.appendEvent(dm.id, {
      type: 'user_message',
      text: 'Do not report the old launch mention again.',
      mentions: [],
    })
    const previousRunAt = new Date('2026-08-28T07:00:00Z').getTime()

    await orchestrator.submitUserMessage(
      dm.id,
      'Check new mentions.',
      [],
      origin({ previousRunAt }),
    )

    const second = seen[1]
    expect(second?.sessionId).toBeUndefined()
    expect(second?.isFullCatchUp).toBe(false)
    expect(second?.contextBlock).toContain(DM_ROUTINE_OUTCOME_HEADING)
    expect(second?.catchUp).toEqual([
      expect.objectContaining({
        type: 'user_message',
        source: 'routine',
        text: 'Check new mentions.',
        routineLastRunAt: previousRunAt,
      }),
    ])
    expect(await store.getSessions(dm.id, 'sage')).toMatchObject([{ sessionId: 'session-1' }])
  })
})

describe('a routine turn delegates nothing', () => {
  /** Smith may summon Sage: the Smith→Argus review shape, on the test roster. */
  const summonRoster = roster.map((agent) =>
    agent.id === 'smith' ? { ...agent, mentionAllowlist: ['sage'] } : agent,
  )

  /**
   * The mutation test decision 5 asks for. Delete the `if (origin !== undefined)
   * continue` guard in `runUserMessage`'s delegation loop and this fails: Smith's
   * reply mentions somebody on his own allowlist, in the room, not yet summoned and
   * inside the budget, which is every condition the summon path checks.
   */
  it('summons nobody off its reply, even a persona on the actor’s own allowlist', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, store, chatId } = await harness(
      scripted(
        (input) => [
          {
            type: 'result',
            text: input.agent.id === 'smith' ? '@Sage review this change' : 'Sage answered',
            sessionId: 's',
          },
        ],
        seen,
      ),
      { agents: summonRoster },
    )

    await orchestrator.submitUserMessage(chatId, 'What changed overnight?', [], origin({ targetAgentId: 'smith' }))

    // One turn, one voice. The same message without the origin runs two.
    expect(seen.map((input) => input.agent.id)).toEqual(['smith'])
    expect(speakers(await store.loadEvents(chatId))).toEqual([
      ['user_message', 'user'],
      ['agent_message', 'smith'],
    ])
  })

  // The control: the identical roster, driver and reply, sent by the user. Without it
  // the test above would pass against a roster whose allowlist simply did not work.
  it('is the only difference: the same reply from the same persona does summon for the user', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, chatId } = await harness(
      scripted(
        (input) => [
          {
            type: 'result',
            text: input.agent.id === 'smith' ? '@Sage review this change' : 'Sage answered',
            sessionId: 's',
          },
        ],
        seen,
      ),
      { agents: summonRoster },
    )

    await orchestrator.submitUserMessage(chatId, '@Smith build it')

    expect(seen.map((input) => input.agent.id)).toEqual(['smith', 'sage'])
  })

  it('summons nobody from a chief of staff either, whose reach is the widest there is', async () => {
    const seen: TurnInput[] = []
    const summoningCos = cosRoster.map((agent) =>
      agent.id === 'marlow' ? { ...agent, mentionAllowlist: ['sage', 'smith'] } : agent,
    )
    const { orchestrator, chatId } = await harness(
      scripted(() => [{ type: 'result', text: '@Sage and @Smith, over to you', sessionId: 's' }], seen),
      { agents: summoningCos },
    )

    await orchestrator.submitUserMessage(chatId, 'What changed overnight?', [], origin({ targetAgentId: 'marlow' }))

    expect(seen.map((input) => input.agent.id)).toEqual(['marlow'])
  })
})

describe('a routine whose target is unreachable', () => {
  it('ends the errand with a note naming the routine, not with a turn', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, store } = await harness(recording(createMockDriver({ deltaDelayMs: 0 }), seen))
    // Sage's routine, pointed at a group she was never invited to.
    const group = await store.createChat({ kind: 'group', memberIds: ['smith', 'marlow'], title: 'The two of them' })

    await orchestrator.submitUserMessage(group.id, 'What changed overnight?', [], origin())

    expect(seen).toEqual([])
    const events = await store.loadEvents(group.id)
    expect(events.at(-1)).toMatchObject({ type: 'system_note', kind: 'error' })
    const note = events.at(-1)
    expect(note?.type === 'system_note' && note.text).toContain('Morning brief')
  })

  it('says the same for a persona who has left the roster entirely', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, store, chatId } = await harness(recording(createMockDriver({ deltaDelayMs: 0 }), seen))

    await orchestrator.submitUserMessage(chatId, 'What changed overnight?', [], origin({ targetAgentId: 'argus' }))

    expect(seen).toEqual([])
    expect((await store.loadEvents(chatId)).at(-1)).toMatchObject({ type: 'system_note', kind: 'error' })
  })
})
