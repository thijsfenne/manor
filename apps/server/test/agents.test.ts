import { PERSONA_TOOLS, type AgentConfig, type AgentDraft, type ServerMessage } from '@manor/contracts'
import { describe, expect, it } from 'vitest'
import { createMockDriver } from '../src/drivers/mockDriver.js'
import { ManorService } from '../src/service.js'
import type { Store } from '../src/store.js'
import { createMemoryStore } from '../src/stores/memoryStore.js'
import { cosRoster, marlow, sage, scratchFor, seededChat, sessionIdIn } from './helpers.js'

/**
 * The service over one live roster cell, wired the way `main.ts` wires it: the getter
 * is what the orchestrator and the drivers read, and an agent write replaces what it
 * returns. Nothing here is rebuilt between messages, so a persona that reaches a
 * later turn reached it without a restart.
 */
async function harness(agents: readonly AgentConfig[]) {
  const store: Store = createMemoryStore({ agents })
  const { chatId } = await seededChat(store)
  const broadcast: ServerMessage[] = []
  const replies: ServerMessage[] = []
  let live: readonly AgentConfig[] = await store.loadRoster()
  const manor = new ManorService({
    store,
    agents: () => live,
    setAgents: (next) => {
      live = next
    },
    mcpServers: () => [],
    setMcpServers: () => undefined,
    resolveDriver: () => createMockDriver({ deltaDelayMs: 0, agents: () => live }),
    ensureScratchDir: scratchFor,
    broadcast: (message) => broadcast.push(message),
  })
  const reply = (message: ServerMessage) => replies.push(message)
  return { manor, store, chatId, broadcast, replies, reply, agents: () => live }
}

type Harness = Awaited<ReturnType<typeof harness>>

const draft = (overrides: Partial<AgentDraft> = {}): AgentDraft => ({
  name: 'Nova',
  color: '#8B7EC8',
  character: 'You are Nova.',
  driver: 'mock',
  effort: 'high',
  mcpServers: [],
  memoryScope: false,
  role: '',
  description: 'New hire.',
  isCos: false,
  ...overrides,
})

const lastRoster = (messages: readonly ServerMessage[]) => {
  const message = messages.filter((entry) => entry.type === 'roster').at(-1)
  if (message?.type !== 'roster') throw new Error('expected a roster')
  return message.agents
}

// Reasoning is trace rather than speech, so it stays out of the speaker list the
// same way turn_result does.
const speakers = (events: readonly { type: string }[]) =>
  events
    .filter((event) => event.type !== 'turn_result' && event.type !== 'reasoning')
    .map((event) => [event.type, 'agentId' in event ? event.agentId : 'user'])

/**
 * Sends a draft that must be refused, and proves the refusal cost nothing: the stored
 * household is byte-identical and nobody else was told anything. Returns the sentence
 * The user is shown, so the caller only has to assert what makes this rule different.
 */
async function refused(test: Harness, agent: AgentDraft): Promise<string> {
  const before = await test.store.loadRoster()

  await test.manor.handle({ type: 'save_agent', agent }, test.reply)

  const notice = test.replies.at(-1)
  expect(notice?.type).toBe('notice')
  expect(notice?.type === 'notice' ? notice.kind : '').toBe('error')
  expect(await test.store.loadRoster()).toEqual(before)
  expect(test.agents()).toEqual(before)
  expect(test.broadcast).toHaveLength(0)
  return notice?.type === 'notice' ? notice.text : ''
}

describe('ManorService, saving a persona', () => {
  it('saves and clears a Fast default through the agent command', async () => {
    const test = await harness([sage])
    const agent = draft({ driver: 'codex', model: 'gpt-6.1-sol', speed: 'fast' })
    await test.manor.handle({ type: 'save_agent', agent }, test.reply)
    expect(lastRoster(test.broadcast).at(-1)?.speed).toBe('fast')
    await test.manor.handle({ type: 'save_agent', agent: { ...agent, id: 'nova', speed: undefined } }, test.reply)
    expect(lastRoster(test.broadcast).at(-1)).not.toHaveProperty('speed')
    expect(test.replies).toEqual([])
  })
  it('creates one, derives its id from its name, and sends the household to everyone', async () => {
    const test = await harness([sage])

    await test.manor.handle({ type: 'save_agent', agent: draft({ avatar: 'data:image/png;base64,iVBORw0KGgo=' }) }, test.reply)

    expect(test.replies).toHaveLength(0)
    const roster = lastRoster(test.broadcast)
    expect(roster.map((agent) => agent.id)).toEqual(['sage', 'nova'])
    expect(roster.at(-1)).toEqual({
      id: 'nova',
      name: 'Nova',
      color: '#8B7EC8',
      character: 'You are Nova.',
      driver: 'mock',
      effort: 'high',
      allowedTools: [...PERSONA_TOOLS],
      mcpServers: [],
      skillIds: [],
      // A new hire summons nobody: her mentions are inert until the user picks names.
      mentionAllowlist: [],
      memoryScope: false,
      role: '',
      description: 'New hire.',
      isCos: false,
      placement: 'chat',
      avatar: 'data:image/png;base64,iVBORw0KGgo=',
    })
    // The cell every consumer reads was replaced, not only the broadcast.
    expect(test.agents().map((agent) => agent.id)).toEqual(['sage', 'nova'])
  })

  it('slugs a name with punctuation in it and uniquifies an id already taken', async () => {
    const test = await harness([sage])

    await test.manor.handle({ type: 'save_agent', agent: draft({ name: "Doctor O'Brien (nights)" }) }, test.reply)
    await test.manor.handle({ type: 'save_agent', agent: draft({ name: 'Sage!' }) }, test.reply)
    await test.manor.handle({ type: 'save_agent', agent: draft({ name: '???' }) }, test.reply)

    expect(test.replies).toHaveLength(0)
    expect(lastRoster(test.broadcast).map((agent) => agent.id)).toEqual([
      'sage',
      'doctor-o-brien-nights',
      // "Sage!" slugs to the id Sage already holds, so it gets the next one; a name
      // with nothing alphanumeric in it falls back rather than becoming empty.
      'sage-2',
      'agent',
    ])
  })

  it('keeps the id when a persona is renamed, because agent_sessions keys on it', async () => {
    const test = await harness([sage])
    await test.store.setSession(test.chatId, 'sage', 'session-a')

    await test.manor.handle(
      { type: 'save_agent', agent: draft({ id: 'sage', name: 'Sage the Elder', character: 'You are older now.' }) },
      test.reply,
    )

    expect(test.replies).toHaveLength(0)
    const roster = lastRoster(test.broadcast)
    expect(roster.map((agent) => [agent.id, agent.name])).toEqual([['sage', 'Sage the Elder']])
    expect(roster.at(0)?.character).toBe('You are older now.')
    // The rename did not orphan the CLI session the old name was talking through.
    expect(await sessionIdIn(test.store, test.chatId, 'sage')).toBe('session-a')
  })

  it('trims the name and the character before storing them', async () => {
    const test = await harness([sage])

    await test.manor.handle(
      { type: 'save_agent', agent: draft({ name: '  Nova  ', character: '\n You are Nova. \n' }) },
      test.reply,
    )

    expect(lastRoster(test.broadcast).at(-1)).toMatchObject({ id: 'nova', name: 'Nova', character: 'You are Nova.' })
  })

  it('moves the chief of staff rather than ending up with two', async () => {
    const test = await harness(cosRoster)

    await test.manor.handle({ type: 'save_agent', agent: draft({ id: 'sage', isCos: true }) }, test.reply)

    const roster = lastRoster(test.broadcast)
    expect(roster.filter((agent) => agent.isCos).map((agent) => agent.id)).toEqual(['sage'])
    // The old chief of staff is still on the roster, just no longer running the house.
    expect(roster.find((agent) => agent.id === marlow.id)?.isCos).toBe(false)
  })

  it('gives a newly created chief of staff the flag and takes it off the old one', async () => {
    const test = await harness(cosRoster)

    await test.manor.handle({ type: 'save_agent', agent: draft({ isCos: true }) }, test.reply)

    expect(lastRoster(test.broadcast).filter((agent) => agent.isCos).map((agent) => agent.id)).toEqual(['nova'])
  })

  it('reaches the very next turn without a restart, which is the point of the whole change', async () => {
    const test = await harness([sage])

    // Nobody by this name exists yet, so the mention resolves to nothing and the
    // message lands in the thread with a note saying it reached no one.
    await test.manor.handle({ type: 'send_message', chatId: test.chatId, text: '@Nova are you there?' }, test.reply)
    expect(speakers(await test.store.loadEvents(test.chatId))).toEqual([
      ['user_message', 'user'],
      ['system_note', 'user'],
    ])

    await test.manor.handle({ type: 'save_agent', agent: draft({ placement: 'session' }) }, test.reply)
    await test.manor.handle({ type: 'send_message', chatId: test.chatId, text: '@Nova now?' }, test.reply)

    // Same process, same orchestrator, same drivers: the roster was read at use. The
    // mock's read and edit are the proof she holds every built-in tool on that turn.
    expect(speakers(await test.store.loadEvents(test.chatId))).toEqual([
      ['user_message', 'user'],
      ['system_note', 'user'],
      ['user_message', 'user'],
      ['tool_use', 'nova'],
      ['tool_result', 'nova'],
      ['tool_use', 'nova'],
      ['tool_result', 'nova'],
      ['agent_message', 'nova'],
    ])
  })

  it('lets an edited character reach the next turn too', async () => {
    const test = await harness([sage])

    await test.manor.handle(
      { type: 'save_agent', agent: draft({ id: 'sage', name: 'Sage', character: 'You are brand new.' }) },
      test.reply,
    )
    await test.manor.handle({ type: 'send_message', chatId: test.chatId, text: '@Sage hello' }, test.reply)

    expect(test.agents().at(0)?.character).toBe('You are brand new.')
  })

  it('makes an edited effort live for the next turn without a restart', async () => {
    const test = await harness([sage])

    await test.manor.handle(
      { type: 'save_agent', agent: draft({ id: 'sage', name: 'Sage', effort: 'max' }) },
      test.reply,
    )
    await test.manor.handle({ type: 'send_message', chatId: test.chatId, text: '@Sage think carefully' }, test.reply)

    expect(test.agents().at(0)).toMatchObject({ id: 'sage', effort: 'max' })
  })

  it('stores chosen avatar settings and treats an empty silhouette as none', async () => {
    const test = await harness([sage])

    await test.manor.handle({ type: 'save_agent', agent: draft({ avatarShape: 'sun', avatarTone: 0.9 }) }, test.reply)

    expect(lastRoster(test.broadcast).at(-1)?.avatarShape).toBe('sun')
    expect(lastRoster(test.broadcast).at(-1)?.avatarTone).toBe(0.9)

    await test.manor.handle(
      { type: 'save_agent', agent: draft({ id: 'nova', name: 'Nova', avatarShape: '' }) },
      test.reply,
    )

    expect('avatarShape' in (lastRoster(test.broadcast).find((agent) => agent.id === 'nova') ?? {})).toBe(false)
  })

  it('saves a chat agent as shared, dropping a retired DM-only flag or folder link', async () => {
    const test = await harness([sage])

    await test.manor.handle({
      type: 'save_agent',
      agent: draft({ isCos: true, ...{ dmOnly: true, projectId: 'project-gone' } }),
    }, test.reply)

    const saved = lastRoster(test.broadcast).find((agent) => agent.id === 'nova')
    expect(saved).toMatchObject({ isCos: true, placement: 'chat' })
    expect(saved).not.toHaveProperty('dmOnly')
    expect(saved).not.toHaveProperty('projectId')
  })
})

describe('ManorService, refusing a persona', () => {
  it('refuses a Fast default on an unsupported runtime', async () => {
    expect(await refused(await harness([sage]), draft({ driver: 'claude', speed: 'fast' })))
      .toContain('Fast mode is not available')
    expect(await refused(await harness([sage]), draft({ driver: 'cursor', model: 'cursor-muse-spark-1.3', speed: 'fast' })))
      .toContain('Fast mode is not available')
  })
  it('refuses a nameless one', async () => {
    expect(await refused(await harness([sage]), draft({ name: '   ' }))).toBe('A persona needs a name.')
  })

  it('refuses a name another persona already answers to, whatever the casing', async () => {
    const message = await refused(await harness([sage]), draft({ name: 'sAgE' }))
    expect(message).toContain('There is already a persona called sAgE')
    expect(message).toContain('@mentions resolve by name')
  })

  it('lets a persona keep its own name while something else is edited', async () => {
    const test = await harness([sage])

    await test.manor.handle({ type: 'save_agent', agent: draft({ id: 'sage', name: 'Sage', color: '#111111' }) }, test.reply)

    expect(test.replies).toHaveLength(0)
    expect(lastRoster(test.broadcast).at(0)?.color).toBe('#111111')
  })

  it('refuses an empty character, which would be the bare harness wearing a name', async () => {
    expect(await refused(await harness([sage]), draft({ character: '  \n ' }))).toContain('needs a character')
  })

  it('refuses a colour that is not six hex digits', async () => {
    const test = await harness([sage])
    expect(await refused(test, draft({ color: 'rebeccapurple' }))).toContain('is not a colour Manor can use')
    expect(await refused(test, draft({ color: '#ABC' }))).toContain('#ABC')
  })

  it('refuses a picture that is not a PNG, JPEG or WebP data URI', async () => {
    const test = await harness([sage])
    expect(await refused(test, draft({ avatar: 'https://example.com/nova.png' }))).toContain('data URI')
    expect(await refused(test, draft({ avatar: 'data:image/svg+xml;base64,PHN2Zy8+' }))).toContain('data URI')
  })

  it('refuses a picture that would put megabytes on the wire, and says why', async () => {
    const oversized = `data:image/png;base64,${'A'.repeat(96_000)}`

    const message = await refused(await harness([sage]), draft({ avatar: oversized }))

    expect(message).toContain('96000')
    expect(message).toContain('The roster goes to every client on every change')
  })

  it('accepts a picture right at the cap', async () => {
    const test = await harness([sage])
    const prefix = 'data:image/png;base64,'
    const atCap = `${prefix}${'A'.repeat(96_000 - prefix.length)}`

    await test.manor.handle({ type: 'save_agent', agent: draft({ avatar: atCap }) }, test.reply)

    expect(test.replies).toHaveLength(0)
    expect(lastRoster(test.broadcast).at(-1)?.avatar).toBe(atCap)
  })

  it('treats an empty picture as no picture rather than a broken one', async () => {
    const test = await harness([sage])

    await test.manor.handle({ type: 'save_agent', agent: draft({ avatar: '' }) }, test.reply)

    expect(test.replies).toHaveLength(0)
    const saved = lastRoster(test.broadcast).at(-1)
    expect(saved?.avatar).toBeUndefined()
  })

  it('refuses an update to a persona nobody holds', async () => {
    expect(await refused(await harness([sage]), draft({ id: 'ghost' }))).toContain('ghost is not on the roster')
  })
})

describe('ManorService, deleting a persona', () => {
  it('removes it, drops its sessions, and sends the household to everyone', async () => {
    const test = await harness(cosRoster)
    await test.store.setSession(test.chatId, 'sage', 'session-a')
    await test.store.setSession(test.chatId, 'smith', 'session-b')

    await test.manor.handle({ type: 'delete_agent', agentId: 'sage' }, test.reply)

    expect(test.replies).toHaveLength(0)
    expect(lastRoster(test.broadcast).map((agent) => agent.id)).toEqual(['marlow', 'smith'])
    expect(test.agents().map((agent) => agent.id)).toEqual(['marlow', 'smith'])
    expect(await sessionIdIn(test.store, test.chatId, 'sage')).toBeUndefined()
    expect(await sessionIdIn(test.store, test.chatId, 'smith')).toBe('session-b')
  })

  it('lets the chief of staff go, leaving un-mentioned messages in the thread', async () => {
    const test = await harness(cosRoster)

    await test.manor.handle({ type: 'delete_agent', agentId: 'marlow' }, test.reply)
    await test.manor.handle({ type: 'send_message', chatId: test.chatId, text: 'nobody in particular' }, test.reply)

    expect(test.replies).toHaveLength(0)
    expect(lastRoster(test.broadcast).some((agent) => agent.isCos)).toBe(false)
    // The reverse state of configuring one, which the orchestrator already implements.
    // It is a state the user is told about rather than one they have to infer from silence.
    const events = await test.store.loadEvents(test.chatId)
    expect(speakers(events)).toEqual([
      ['user_message', 'user'],
      ['system_note', 'user'],
    ])
    expect(events.at(-1)).toMatchObject({
      type: 'system_note',
      kind: 'info',
      text: 'Nobody was addressed and no default agent is set, so this message stays in the chat as context.',
    })
  })

  it('lets the last persona go, and takes mentions of it with them', async () => {
    const test = await harness([sage])

    await test.manor.handle({ type: 'delete_agent', agentId: 'sage' }, test.reply)
    await test.manor.handle({ type: 'send_message', chatId: test.chatId, text: '@Sage still there?' }, test.reply)

    expect(lastRoster(test.broadcast)).toEqual([])
    expect(speakers(await test.store.loadEvents(test.chatId))).toEqual([
      ['user_message', 'user'],
      ['system_note', 'user'],
    ])
  })

  it('refuses an id nobody holds and changes nothing', async () => {
    const test = await harness([sage])

    await test.manor.handle({ type: 'delete_agent', agentId: 'ghost' }, test.reply)

    const notice = test.replies.at(-1)
    expect(notice?.type === 'notice' ? notice.text : '').toContain('ghost is not on the roster')
    expect(test.broadcast).toHaveLength(0)
    expect((await test.store.loadRoster()).map((agent) => agent.id)).toEqual(['sage'])
  })
})

describe('ManorService, the household on the wire', () => {
  it('answers with the roster as it stands, for the socket that just connected', async () => {
    const test = await harness(cosRoster)
    // A stored list from the tool-group days never reaches the wire.
    const read = (agent: AgentConfig) => ({ ...agent, allowedTools: [...PERSONA_TOOLS] })

    expect(test.manor.roster()).toEqual({ type: 'roster', agents: cosRoster.map(read) })

    await test.manor.handle({ type: 'delete_agent', agentId: 'smith' }, test.reply)

    expect(test.manor.roster()).toEqual({ type: 'roster', agents: [marlow, sage].map(read) })
  })

  it('says nothing about the household when something else changes', async () => {
    const test = await harness([sage])

    await test.manor.handle({ type: 'create_project', name: 'Client work', repoPaths: [] }, test.reply)

    expect(test.broadcast.every((message) => message.type === 'directory')).toBe(true)
  })
})
