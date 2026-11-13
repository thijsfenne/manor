import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {
  AgentConfig,
  AttachedMcpServer,
  Driver,
  McpServerConfig,
  ServerMessage,
  SkillConfig,
  TurnInput,
} from '@manor/contracts'
import { SIDE_CHAT_DEFAULTS, SINGLE_CHAT_VOICE } from '@manor/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CHAT_SUMMARY_HEADING,
  MEMORY_HEADING,
  SESSION_CEILING_CHARS,
  SIDE_CONTEXT_HEADING,
  SKILLS_HEADING,
} from '../src/composer.js'
import { createMockDriver } from '../src/drivers/mockDriver.js'
import { interactionMcpAttachment } from '../src/mcp/interactionAttachment.js'
import { skillMcpAttachment } from '../src/mcp/skillAttachment.js'
import { Orchestrator, type OrchestratorOptions } from '../src/orchestrator.js'
import { GLOBAL_MEMORY_HEADING } from '../src/projectMemory.js'
import type { Store } from '../src/store.js'
import { createMemoryStore } from '../src/stores/memoryStore.js'
import { cosRoster, endless, handed, recording, scratchFor, scripted, until } from './helpers.js'

/**
 * The panel beside a chat: one hidden voice, reading the conversation next to it and
 * writing nothing back into it.
 */
const BROWSER: AttachedMcpServer = {
  server: {
    id: 'browser',
    name: 'browser',
    command: 'browser',
    args: [],
    envKeys: [],
    description: 'The shared browser.',
    writes: true,
    effectPolicy: 'confirm_writes' as const,
    tools: [],
    readOnlyTools: [],
    schemaChars: 0,
  },
  disabledTools: [],
}

/** One registered connection, so an attachment on the persona has something to resolve. */
const MAIL: McpServerConfig = {
  id: 'mcp_mail',
  name: 'mail',
  command: 'mail-mcp',
  args: [],
  envKeys: [],
  description: 'The mailbox.',
  writes: true,
  effectPolicy: 'confirm_writes' as const,
  tools: [],
  readOnlyTools: [],
  schemaChars: 0,
}

const REVIEW_SKILL: SkillConfig = {
  id: 'review',
  name: 'review',
  description: 'A procedure.',
  instructions: 'Follow these steps.',
  sources: ['claude'],
}

async function harness(driver: Driver, agents: readonly AgentConfig[] = cosRoster,
  memory: Pick<OrchestratorOptions, 'structuredMemoryRoot' | 'memoryTarget' | 'memoryRoots' | 'rankStructuredMemory' | 'interactionMcp'> = {}) {
  const store: Store = createMemoryStore({ agents })
  const sent: ServerMessage[] = []
  const seen: TurnInput[] = []
  const orchestrator = new Orchestrator({
    ...memory,
    agents: () => agents,
    store,
    mcpServers: () => [MAIL],
    skills: () => [REVIEW_SKILL],
    // Every persona is handed the shared browser by the room. The side voice must not
    // be, which is what the folders-and-connections test below checks.
    builtInMcp: () => BROWSER,
    resolveDriver: () => recording(driver, seen),
    ensureScratchDir: scratchFor,
    emit: (message) => sent.push(message),
  })
  const project = await store.createProject('Manor', ['/Users/sam/Ontwikkeling/Manor'])
  const parent = await store.createChat({ projectId: project.id, title: 'Side chats' })
  return { orchestrator, store, sent, seen, parent }
}

const speakers = async (store: Store, chatId: string) =>
  (await store.loadEvents(chatId))
    .filter((event) => event.type === 'agent_message')
    .map((event) => ('agentId' in event ? event.agentId : ''))

const contextOf = (input: TurnInput | undefined): string => input?.contextBlock ?? ''

describe('single project sessions', () => {
  it.each(['session', 'thread'])('keeps a Single %s prompt and tools the same when a turn selects a skill', async (surface) => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'manor-single-skills-'))
    try {
      const seen: TurnInput[] = []
      const store = createMemoryStore({ agents: [] })
      const project = await store.createProject('Skill fixture', [])
      const chat = await store.createChat({ projectId: project.id, mode: 'single' })
      if (surface === 'thread') await store.setProjectThread(project.id, chat.id)
      await store.setChatOverride(chat.id, SINGLE_CHAT_VOICE.id, { driver: 'codex', model: 'gpt-5.6-sol', effort: 'medium' })
      const orchestrator = new Orchestrator({
        store, agents: () => [], mcpServers: () => [], structuredMemoryRoot: root, skills: () => [REVIEW_SKILL],
        skillMcp: () => ({ attachment: skillMcpAttachment('http://127.0.0.1:1/internal/skill-file', 'capability'), revoke() {} }),
        resolveDriver: () => scripted(() => [{ type: 'result', text: 'Answered.', sessionId: 'skill-session' }], seen),
        ensureScratchDir: scratchFor, emit() {},
      })
      await orchestrator.submitUserMessage(chat.id, 'Help me')
      await orchestrator.submitUserMessage(chat.id, 'Help me $review')
      await orchestrator.submitUserMessage(chat.id, 'Continue')
      const prints = (await store.loadEvents(chat.id)).flatMap((event) => event.type === 'turn_result' && event.promptFingerprint !== undefined ? [event.promptFingerprint] : [])
      expect(prints).toHaveLength(3)
      expect(new Set(prints.map(({ system, tools }) => `${system}/${tools}`)).size).toBe(1)
      expect(seen.map((input) => input.volatileBlocks?.some((block) => block.key === 'selected-skills') ?? false)).toEqual([false, true, false])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  beforeEach(() => vi.stubEnv('MANOR_GLOBAL_CLAUDE_DIR', ''))
  afterEach(() => vi.unstubAllEnvs())

  it('answers without a roster, resumes its own session and loads only explicitly selected skills', async () => {
    const seen: TurnInput[] = []
    const { store, orchestrator } = await harness(scripted(() => [
      { type: 'result', text: 'A direct answer.', sessionId: 'single-provider-session' },
    ], seen), [], { memoryTarget: { dailyDir: '/home/someone/notes/memory/daily' } })
    const project = await store.createProject('Single test', [])
    const chat = await store.createChat({ projectId: project.id, mode: 'single' })
    await store.setChatOverride(chat.id, SINGLE_CHAT_VOICE.id, { driver: 'codex', model: 'gpt-5.6-sol', effort: 'medium' })
    await orchestrator.submitUserMessage(chat.id, 'Help me $review')
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ singleSession: true, agent: {
      id: SINGLE_CHAT_VOICE.id, driver: 'codex', model: 'gpt-5.6-sol', effort: 'medium',
      memoryScope: true, mentionAllowlist: [], skillIds: [],
    } })
    expect(handed(seen[0])).toContain(REVIEW_SKILL.instructions)
    expect(seen[0]!.agent.character).toContain(MEMORY_HEADING)
    expect(seen[0]!.agent.character).toContain('Manor writes the daily log for you')
    expect(seen[0]!.agent.character).not.toContain(GLOBAL_MEMORY_HEADING)
    expect(seen[0]!.agent.character).not.toContain('House style')
    expect(seen[0]!.agent.character).not.toContain('Also in this workspace')
    expect(seen[0]!.agent.character).not.toContain('Skills available to you')
    expect(seen[0]!.mcpServers).toContainEqual(BROWSER)
    await orchestrator.submitUserMessage(chat.id, 'Continue')
    expect(seen[1]).toMatchObject({ sessionId: 'single-provider-session', isFullCatchUp: false })
    expect(seen[1]!.agent.character).not.toContain(REVIEW_SKILL.instructions)
    await store.setChatOverride(chat.id, SINGLE_CHAT_VOICE.id, { driver: 'claude', model: 'claude-opus-5', effort: 'high' })
    await orchestrator.submitUserMessage(chat.id, 'Continue on Claude')
    expect(seen[2]).toMatchObject({ isFullCatchUp: true, agent: { driver: 'claude', model: 'claude-opus-5' } })
    expect(seen[2]!.sessionId).toBeUndefined()
  })

  it('keeps persona mentions and replies from summoning the household', async () => {
    const seen: TurnInput[] = []
    const { store, orchestrator } = await harness(scripted(() => [
      { type: 'result', text: '@Sage please help.', sessionId: 'single-provider-session' },
    ], seen))
    const project = await store.createProject('Single test', ['/tmp/single-linked-folder'])
    const chat = await store.createChat({ projectId: project.id, mode: 'single' })
    await store.setChatOverride(chat.id, SINGLE_CHAT_VOICE.id, { driver: 'codex', model: 'gpt-5.6-sol', effort: 'medium' })
    await orchestrator.submitUserMessage(chat.id, '@Smith help with @Work')
    expect(seen).toHaveLength(1)
    expect(seen[0]!.repoPaths).toEqual(['/tmp/single-linked-folder'])
    expect(seen[0]!.agent.character).not.toContain('Standing instructions')
    expect(seen[0]!.agent.character).not.toContain('Work routing')
    const events = await store.loadEvents(chat.id)
    expect(events).toContainEqual(expect.objectContaining({ type: 'user_message', mentions: [] }))
    expect(events.map((event) => event.type).slice(0, 2)).toEqual(['user_message', 'system_note'])
    expect(events).toContainEqual(expect.objectContaining({ type: 'system_note', text: "Single model. Mentions don't reach other agents." }))
    expect(events.filter((event) => event.type === 'turn_result')).toHaveLength(1)
    expect(events.find((event) => event.type === 'turn_result')).toMatchObject({
      memoryTrace: { reads: [], summary: { status: 'not_read' } },
    })
    expect((await store.listChats()).find((row) => row.id === chat.id)).toMatchObject({ mode: 'single', agentIds: [] })
    // Once per Session: a second mention adds no second line.
    await orchestrator.submitUserMessage(chat.id, '@Sage are you there?')
    expect((await store.loadEvents(chat.id)).filter((event) => event.type === 'system_note')).toHaveLength(1)
  })

  it.each([
    { driver: 'claude', model: 'claude-opus-5' },
    { driver: 'codex', model: 'gpt-5.6-sol' },
    { driver: 'grok', model: 'grok-4.6' },
    { driver: 'cursor', model: 'cursor-composer-2.5' },
  ] as const)('injects and traces memory folder notes without persona notes on $driver', async (runtime) => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'manor-single-memory-'))
    try {
      const structuredMemoryRoot = path.join(root, 'memory/structured')
      const notesDir = path.join(root, 'memory/agents')
      mkdirSync(path.join(structuredMemoryRoot, 'single-test'), { recursive: true })
      mkdirSync(notesDir, { recursive: true })
      writeFileSync(path.join(root, 'CLAUDE.md'), 'Global personal context.')
      writeFileSync(path.join(structuredMemoryRoot, 'MEMORY.md'), 'Root personal memory routing.')
      writeFileSync(path.join(structuredMemoryRoot, 'single-test/MEMORY.md'), '- [Rollover](rollover.md), context rollover decisions.')
      const evidence = path.join(structuredMemoryRoot, 'single-test/rollover.md')
      writeFileSync(evidence, 'Keep the session cursor on the session row.')
      writeFileSync(path.join(notesDir, '__single__.md'), 'Unwanted synthetic persona notes.')
      vi.stubEnv('MANOR_GLOBAL_CLAUDE_DIR', root)
      const rankStructuredMemory = vi.fn<NonNullable<OrchestratorOptions['rankStructuredMemory']>>().mockResolvedValue([0.9])
      const { store, orchestrator, seen } = await harness(createMockDriver({ deltaDelayMs: 0 }), [], {
        structuredMemoryRoot,
        rankStructuredMemory,
        memoryRoots: [root],
        memoryTarget: { dailyDir: path.join(root, 'memory/daily') },
      })
      const project = await store.createProject('Single test', [])
      const chat = await store.createChat({ projectId: project.id, mode: 'single' })
      await store.setChatOverride(chat.id, SINGLE_CHAT_VOICE.id, { ...runtime, effort: 'high' })
      await orchestrator.submitUserMessage(chat.id, 'Explain the rollover decision')
      expect(rankStructuredMemory).toHaveBeenCalledOnce()

      const character = handed(seen[0])
      expect(character).toContain('Global personal context.')
      expect(character).toContain(path.join(structuredMemoryRoot, 'MEMORY.md'))
      expect(character).toContain('Keep the session cursor on the session row.')
      expect(character).toContain(`${root}/memory/daily/YYYY-MM-DD.md`)
      expect(character).not.toContain(notesDir)
      expect(character).not.toContain('Unwanted synthetic persona notes.')
      expect(character).not.toContain('without Manor personas or personal memory')
      expect(character).not.toContain('House style')
      expect(character).not.toContain('Also in this workspace')
      expect((await store.loadEvents(chat.id)).find((event) => event.type === 'turn_result')).toMatchObject({
        memoryTrace: { reads: expect.arrayContaining([
          { source: 'injected', path: path.join(root, 'CLAUDE.md') },
          { source: 'injected', path: evidence },
        ]) },
      })
      await orchestrator.submitUserMessage(chat.id, 'And on the next turn?')
      expect(rankStructuredMemory).toHaveBeenCalledTimes(2)
      // The next turn is handed the retrieved file again; the driver sends it on only if it changed.
      expect(handed(seen.at(-1))).toContain('Keep the session cursor on the session row.')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('side chat routing', () => {
  it('answers as its one voice, and reads a typed mention as text', async () => {
    // The question that reaches a panel is usually pasted or half-quoted from the
    // chat beside it, so an `@Name` in it is the normal case rather than the odd one.
    const { orchestrator, store, parent } = await harness(createMockDriver({ deltaDelayMs: 0 }))
    const side = await store.sideChatFor(parent.id)

    await orchestrator.submitUserMessage(side.id, '@Smith what does he mean by the heart?')

    expect(await speakers(store, side.id)).toEqual(['aside'])
    expect((await store.loadEvents(side.id)).find((event) => event.type === 'user_message')).toMatchObject({
      mentions: [],
    })
    // One way: the panel's answer never lands in the chat it is reading.
    expect(await speakers(store, parent.id)).toEqual([])
  })

  it('is not one of the personas the household block teaches', async () => {
    const { orchestrator, store, seen, parent } = await harness(createMockDriver({ deltaDelayMs: 0 }))

    await orchestrator.submitUserMessage(parent.id, 'who is around?')

    const character = seen.at(0)?.agent.character ?? ''
    expect(character).toContain('Sage')
    expect(character).not.toContain('Aside')
  })

  it('does not take a turn in a real chat when somebody types its name', async () => {
    const { orchestrator, store, parent } = await harness(createMockDriver({ deltaDelayMs: 0 }))

    await orchestrator.submitUserMessage(parent.id, '@Aside can you look at this?')

    // The chief of staff answers, because the mention resolved to nobody at all.
    expect(await speakers(store, parent.id)).toEqual(['marlow'])
  })
})

describe('side chat context', () => {
  it.each(['user_message', 'agent_message'] as const)('carries a selected parent %s into the side turn', async (type) => {
    const { orchestrator, store, seen, sent, parent } = await harness(createMockDriver({ deltaDelayMs: 0 }))
    const source = await store.appendEvent(parent.id, type === 'agent_message'
      ? { type, agentId: 'smith', turnId: 'source_turn', text: 'First. Second.' }
      : { type, text: 'First. Second.', mentions: [] })
    const side = await store.sideChatFor(parent.id)
    const quote = { kind: 'message' as const, eventId: source.id, text: 'Second.', ...(type === 'agent_message' ? { agentId: 'smith' } : {}) }
    const quotes = [quote]

    await orchestrator.submitUserMessage(side.id, 'Explain this', [], undefined, [], [], undefined,
      [{ ...quote, agentId: 'sage' }])

    expect((await store.loadEvents(side.id)).find((event) => event.type === 'user_message')).toMatchObject({ quotes })
    expect(seen[0]?.catchUp).toContainEqual(expect.objectContaining({ type: 'user_message', quotes }))
    expect(sent).toContainEqual(expect.objectContaining({ type: 'event', event: expect.objectContaining({ quotes }) }))
    expect(await store.loadEvents(parent.id)).toEqual([source])
  })

  it('still accepts a quote from the side chat itself', async () => {
    const { orchestrator, store, seen, parent } = await harness(createMockDriver({ deltaDelayMs: 0 }))
    const side = await store.sideChatFor(parent.id)
    const source = await store.appendEvent(side.id, { type: 'user_message', text: 'Earlier question.', mentions: [] })
    const quotes = [{ kind: 'message' as const, eventId: source.id, text: 'Earlier question.' }]

    await orchestrator.submitUserMessage(side.id, 'Explain this', [], undefined, [], [], undefined, quotes)

    expect(seen[0]?.catchUp).toContainEqual(expect.objectContaining({ type: 'user_message', text: 'Explain this', quotes }))
  })

  it('refuses quotes from unrelated chats before storing or running a side turn', async () => {
    const { orchestrator, store, seen, parent } = await harness(createMockDriver({ deltaDelayMs: 0 }))
    const other = await store.createChat({ kind: 'dm', memberIds: ['sage'] })
    const source = await store.appendEvent(other.id, { type: 'user_message', text: 'Unrelated.', mentions: [] })
    const side = await store.sideChatFor(parent.id)

    await expect(orchestrator.submitUserMessage(side.id, 'Explain this', [], undefined, [], [], undefined,
      [{ kind: 'message', eventId: source.id, text: 'Unrelated.' }])).rejects.toThrow('no longer available in this chat')

    expect(await store.loadEvents(side.id)).toEqual([])
    expect(seen).toEqual([])
  })

  it('hands the voice the chat it hangs off, then only what is new', async () => {
    const { orchestrator, store, seen, parent } = await harness(createMockDriver({ deltaDelayMs: 0 }))
    await store.appendEvent(parent.id, { type: 'user_message', text: 'What should we build first?', mentions: [] })
    await store.appendEvent(parent.id, {
      type: 'agent_message',
      agentId: 'sage',
      turnId: 'turn_1',
      text: 'The heart, not the housing.',
    })
    const side = await store.sideChatFor(parent.id)

    await orchestrator.submitUserMessage(side.id, 'what does he mean?')

    const first = contextOf(seen.at(0))
    expect(first).toContain(`${SIDE_CONTEXT_HEADING} Side chats`)
    expect(first).toContain('User: What should we build first?')
    expect(first).toContain('Sage: The heart, not the housing.')

    // The conversation moves on next door while the panel is open.
    await store.appendEvent(parent.id, {
      type: 'agent_message',
      agentId: 'smith',
      turnId: 'turn_2',
      text: 'Persistence comes third.',
    })

    await orchestrator.submitUserMessage(side.id, 'and now?')

    const second = contextOf(seen.at(1))
    expect(second).toContain('Smith: Persistence comes third.')
    // What it has already been read is not read to it twice: the session still holds it.
    expect(second).not.toContain('The heart, not the housing.')
    expect(second).toContain('since you last looked')
  })

  it('starts a fresh panel from the parent summary and its exact tail', async () => {
    const { orchestrator, store, seen, parent } = await harness(createMockDriver({ deltaDelayMs: 0 }))
    const first = await store.appendEvent(parent.id, {
      type: 'user_message',
      text: 'The old parent question.',
      mentions: [],
    })
    await store.appendEvent(parent.id, {
      type: 'agent_message',
      agentId: 'sage',
      turnId: 'turn_1',
      text: 'The parent tail.',
    })
    await store.setChatSummary(parent.id, 'The old parent question was settled.', first.id)
    const side = await store.sideChatFor(parent.id)

    await orchestrator.submitUserMessage(side.id, 'what is the current state?')

    const context = contextOf(seen[0])
    expect(context).toContain(CHAT_SUMMARY_HEADING)
    expect(context).toContain('The old parent question was settled.')
    expect(context).toContain('Sage: The parent tail.')
    expect(context).not.toContain('User: The old parent question.')
  })

  it('rolls an oversized panel once, then resumes past both side and parent seed cursors', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, store, parent } = await harness(
      scripted(() => [{ type: 'result', text: 'Fresh side answer.', sessionId: 'rollover-side-session' }], seen),
    )
    const parentThrough = await store.appendEvent(parent.id, {
      type: 'user_message',
      text: 'p'.repeat(SESSION_CEILING_CHARS),
      mentions: [],
    })
    await store.setChatSummary(parent.id, 'The long parent conversation was settled.', parentThrough.id)
    const side = await store.sideChatFor(parent.id)
    await store.appendEvent(side.id, {
      type: 'user_message',
      text: 's'.repeat(SESSION_CEILING_CHARS),
      mentions: [],
    })
    await store.appendEvent(side.id, {
      type: 'agent_message',
      agentId: 'aside',
      turnId: 'turn_old',
      text: 'Earlier side answer.',
    })
    await store.appendEvent(side.id, {
      type: 'turn_result',
      agentId: 'aside',
      turnId: 'turn_old',
    })
    await store.setSideSession(side.id, 'bloated-side-session', { contextEventId: parentThrough.id })

    await orchestrator.submitUserMessage(side.id, 'answer from shared context')

    expect(seen[0]?.sessionId).toBeUndefined()
    expect(seen[0]?.isFullCatchUp).toBe(true)
    expect(contextOf(seen[0])).toContain(CHAT_SUMMARY_HEADING)
    expect(contextOf(seen[0])).toContain('The long parent conversation was settled.')
    const rolledOver = await store.getSideSession(side.id)
    expect(rolledOver).toMatchObject({
      sessionId: 'rollover-side-session',
      parentSeededThroughEventId: parentThrough.id,
    })
    expect(rolledOver?.seededThroughEventId).toBe(seen[0]?.catchUp.at(-1)?.id)

    await orchestrator.submitUserMessage(side.id, 'keep going')

    expect(seen[1]?.sessionId).toBe('rollover-side-session')
    expect(seen[1]?.isFullCatchUp).toBe(false)
  })

  it('says nothing about the other chat when nothing was said in it', async () => {
    const { orchestrator, store, seen, parent } = await harness(createMockDriver({ deltaDelayMs: 0 }))
    await store.appendEvent(parent.id, { type: 'user_message', text: 'What should we build first?', mentions: [] })
    const side = await store.sideChatFor(parent.id)

    await orchestrator.submitUserMessage(side.id, 'what does he mean?')
    await orchestrator.submitUserMessage(side.id, 'and what would you do?')

    expect(contextOf(seen.at(0))).toContain('User: What should we build first?')
    expect(contextOf(seen.at(1))).toBe('')
  })

  it('reads the parent from the top again when the session is gone', async () => {
    // A resume failure, a restarted CLI, or a new model picked in the panel: the voice
    // holds none of the thread any more, so a delta would be a lie about what it
    // remembers. Picking a model is the one of those a person can do on purpose.
    const { orchestrator, store, seen, parent } = await harness(createMockDriver({ deltaDelayMs: 0 }))
    await store.appendEvent(parent.id, { type: 'user_message', text: 'What should we build first?', mentions: [] })
    const side = await store.sideChatFor(parent.id)

    await orchestrator.submitUserMessage(side.id, 'what does he mean?')
    await store.setSideRuntime(side.id, 'grok-4.6', 'low')
    await orchestrator.submitUserMessage(side.id, 'again, from the top')

    expect(contextOf(seen.at(1))).toContain('User: What should we build first?')
    expect(contextOf(seen.at(1))).not.toContain('since you last looked')
  })

  it('carries no folders and no connections into the panel', async () => {
    // The voice has no tools, so a folder block promising full write access to the user's
    // real working copies would be a lie in the prompt, and the shared browser would be
    // an action it is not allowed to take.
    const { orchestrator, store, seen, parent } = await harness(createMockDriver({ deltaDelayMs: 0 }))
    const side = await store.sideChatFor(parent.id)

    await orchestrator.submitUserMessage(parent.id, 'anything doing?')
    await orchestrator.submitUserMessage(side.id, 'what is he up to?')

    expect(seen.at(0)?.repoPaths).toEqual(['/Users/sam/Ontwikkeling/Manor'])
    expect(seen.at(0)?.mcpServers).toEqual([BROWSER])
    expect(seen.at(1)?.repoPaths).toEqual([])
    expect(seen.at(1)?.mcpServers).toBeUndefined()
  })

  it('cannot hand a file into the thread from the panel', async () => {
    const allowDeliver: boolean[] = []
    const { orchestrator, store, parent } = await harness(createMockDriver({ deltaDelayMs: 0 }), cosRoster, {
      interactionMcp: (_chatId, _agent, _turnId, _allowAsk, permissions) => {
        allowDeliver.push(permissions?.allowDeliver ?? false)
        return interactionMcpAttachment('http://127.0.0.1:8787/internal/user-input', 'capability', { allowAsk: false })
      },
    })
    const side = await store.sideChatFor(parent.id)

    await orchestrator.submitUserMessage(parent.id, 'anything doing?')
    await orchestrator.submitUserMessage(side.id, 'what is he up to?')

    expect(allowDeliver).toEqual([true, false])
  })
})

describe('the side chat row', () => {
  it('is opened rather than created, however often it is asked for', async () => {
    const { store, parent } = await harness(createMockDriver({ deltaDelayMs: 0 }))

    const first = await store.sideChatFor(parent.id)
    const second = await store.sideChatFor(parent.id)

    expect(second.id).toBe(first.id)
    expect(first.kind).toBe('side')
    expect(first.parentChatId).toBe(parent.id)
    // No project, so it inherits no folders, and no member: it holds a model instead.
    expect(first.projectId).toBeNull()
    expect(first.memberIds).toEqual([])
    expect(first.sideModel).toBeNull()
  })

  it('goes with the chat it hangs off', async () => {
    const { store, parent } = await harness(createMockDriver({ deltaDelayMs: 0 }))
    const side = await store.sideChatFor(parent.id)

    await store.deleteChat(parent.id)

    expect(await store.getChat(side.id)).toBeUndefined()
  })

  it('refuses a shape the database would refuse', async () => {
    const { store, parent } = await harness(createMockDriver({ deltaDelayMs: 0 }))

    await expect(store.createChat({ kind: 'side' })).rejects.toThrow('a side chat hangs off exactly one chat')
    await expect(
      store.createChat({ kind: 'side', parentChatId: parent.id, memberIds: ['sage'] }),
    ).rejects.toThrow('a side chat holds a model, not members')
    await expect(
      store.createChat({ kind: 'dm', parentChatId: parent.id, memberIds: ['sage'] }),
    ).rejects.toThrow('a side chat hangs off exactly one chat, and only a side chat does')
  })
})

describe('what a side chat grants', () => {
  const globalRoot = process.env['MANOR_GLOBAL_CLAUDE_DIR']
  afterEach(() => {
    if (globalRoot === undefined) delete process.env['MANOR_GLOBAL_CLAUDE_DIR']
    else process.env['MANOR_GLOBAL_CLAUDE_DIR'] = globalRoot
  })

  it('is built with no tools, no connections, no skills and no memory', async () => {
    // Nothing is stripped here any more, because nothing is put in: the voice is
    // `sideAgentFor`, built from the chat rather than looked up in a roster that could
    // be edited. The registry and the skill in this harness are what a persona would
    // have picked up.
    const { orchestrator, store, seen, parent } = await harness(createMockDriver({ deltaDelayMs: 0 }))
    const side = await store.sideChatFor(parent.id)

    await orchestrator.submitUserMessage(side.id, '$review what does he mean?')

    expect(seen.at(0)?.agent.allowedTools).toEqual([])
    expect(seen.at(0)?.agent.mcpServers).toEqual([])
    expect(seen.at(0)?.mcpServers).toBeUndefined()
    expect(seen.at(0)?.agent.character).not.toContain(SKILLS_HEADING)
    expect(seen.at(0)?.agent.character).not.toContain(MEMORY_HEADING)
    // Not recorded either: a `$` in a pasted question is somebody else's text.
    expect((await store.loadEvents(side.id)).find((event) => event.type === 'user_message')).not.toHaveProperty(
      'skillIds',
    )
  })

  it('runs on the chat\'s own model and effort, defaulting until one is picked', async () => {
    const { orchestrator, store, seen, parent } = await harness(createMockDriver({ deltaDelayMs: 0 }))
    const side = await store.sideChatFor(parent.id)

    await orchestrator.submitUserMessage(side.id, 'what does he mean?')
    await store.setSideRuntime(side.id, 'grok-4.6', 'low')
    await orchestrator.submitUserMessage(side.id, 'and now?')

    expect(seen.at(0)?.agent.model).toBe(SIDE_CHAT_DEFAULTS.model)
    expect(seen.at(0)?.agent.effort).toBe(SIDE_CHAT_DEFAULTS.effort)
    expect(seen.at(1)?.agent.model).toBe('grok-4.6')
    expect(seen.at(1)?.agent.effort).toBe('low')
    // The provider follows the model rather than being picked beside it.
    expect(seen.at(1)?.agent.driver).toBe('grok')
  })

  it('never hands a picture to a voice that cannot open one', async () => {
    // An image reaches a CLI as a path on disk, and the Grok driver puts `read_file`
    // back in the toolset to read it. The client hides the control; this is the half
    // that holds whatever the client does.
    const { orchestrator, store, seen, parent } = await harness(createMockDriver({ deltaDelayMs: 0 }))
    const side = await store.sideChatFor(parent.id)

    await orchestrator.submitUserMessage(side.id, 'what is this?', [
      { name: 'shot.png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' },
    ])

    expect(seen.at(0)?.imagePaths).toBeUndefined()
  })

  it('leaves the global standing instructions out of the panel, and in the room', async () => {
    // `composeProjectMemory([])` still reads the global `~/.claude` layer: no project
    // means no folders, not no instructions. That layer is the user's own context and
    // tens of thousands of characters, in a turn whose promise is that it is cheap.
    const root = mkdtempSync(path.join(os.tmpdir(), 'manor-global-'))
    writeFileSync(path.join(root, 'CLAUDE.md'), '# Global\n\nStanding instructions for every session.')
    process.env['MANOR_GLOBAL_CLAUDE_DIR'] = root
    const { orchestrator, store, seen, parent } = await harness(createMockDriver({ deltaDelayMs: 0 }))
    const side = await store.sideChatFor(parent.id)

    await orchestrator.submitUserMessage(parent.id, 'anything doing?')
    await orchestrator.submitUserMessage(side.id, 'what is he up to?')

    // The room still gets it, which is what makes the absence below a decision.
    expect(seen.at(0)?.agent.character).toContain(GLOBAL_MEMORY_HEADING)
    expect(seen.at(1)?.agent.character).not.toContain(GLOBAL_MEMORY_HEADING)
    expect(seen.at(1)?.agent.character).not.toContain('Standing instructions for every session.')
  })
})

describe('a panel whose chat is deleted', () => {
  it('stops the turn it has running', async () => {
    // The row cascades away with its parent, so a turn still streaming into it would
    // be writing to a chat the database has already taken.
    const stops: string[] = []
    const { driver, started } = endless(stops)
    const store: Store = createMemoryStore({ agents: cosRoster })
    const seen: TurnInput[] = []
    const orchestrator = new Orchestrator({
      agents: () => cosRoster,
      store,
      mcpServers: () => [],
      resolveDriver: () => recording(driver, seen),
      ensureScratchDir: scratchFor,
      emit: () => {},
    })
    const project = await store.createProject('Manor', [])
    const parent = await store.createChat({ projectId: project.id, title: 'Side chats' })
    const side = await store.sideChatFor(parent.id)
    void orchestrator.submitUserMessage(side.id, 'what does he mean?')
    await until(() => started.length === 1, 'the side turn to start')

    // What `delete_chat` does, in the order the service does it.
    const running = await store.sideChatOf(parent.id)
    orchestrator.discard(parent.id)
    if (running !== undefined) orchestrator.discard(running.id)
    await store.deleteChat(parent.id)

    expect(stops).toEqual(['aside'])
    expect(await store.getChat(side.id)).toBeUndefined()
  })
})
