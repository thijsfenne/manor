import type { AgentConfig, AgentDraft, ServerMessage, ThreadEvent } from '@manor/contracts'
import { describe, expect, it, vi } from 'vitest'
import { answerInstructionsCall } from '../src/agentInterview.js'
import { createMockDriver } from '../src/drivers/mockDriver.js'
import { UserInputCapabilities } from '../src/interactionCapability.js'
import { interactionMcpAttachment } from '../src/mcp/interactionAttachment.js'
import { ManorService } from '../src/service.js'
import { createMemoryStore } from '../src/stores/memoryStore.js'
import { cosRoster, scratchFor } from './helpers.js'

const SKIPPED = 'Skipped. Decide this one yourself.'

const draft = (overrides: Partial<AgentDraft> = {}): AgentDraft => ({
  name: 'Nova',
  color: '#8B7EC8',
  character: 'You are Nova in this workspace. You help with this: Plan my week.',
  driver: 'mock',
  effort: 'high',
  mcpServers: [],
  memoryScope: false,
  role: '',
  description: 'Plan my week.',
  isCos: false,
  ...overrides,
})

/**
 * The service with the interaction broker wired the way `main.ts` wires it, minus the
 * port: the mock driver's broker calls land on the real capability store and the real
 * `write_instructions` answer. `answer` decides what the user picks on each card.
 */
async function harness(
  answer: (question: { id: string; options: { label: string }[] }) => string,
  /** Runs inside the interview turn, after its own write landed: the turn is still open. */
  afterWrite?: (capability: string | undefined) => Promise<void>,
) {
  const store = createMemoryStore({ agents: cosRoster })
  const capabilities = new UserInputCapabilities()
  let live: readonly AgentConfig[] = await store.loadRoster()
  const turns: { turnId: string; agentId: string; tools: readonly string[]; token: string }[] = []
  const replies: ServerMessage[] = []
  const service: { current?: ManorService } = {}
  const request = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url)
    const capability = (init?.headers as Record<string, string>)['x-manor-user-input-capability']
    const body = JSON.parse(String(init?.body)) as { questions?: { id: string; options: { label: string }[] }[] }
    if (href.endsWith('/internal/user-input')) {
      capabilities.take(capability, 'ask')
      return Response.json({ answers: Object.fromEntries((body.questions ?? []).map((question) => [question.id, answer(question)])) })
    }
    if (href.endsWith('/internal/agent-instructions')) {
      const answered = await answerInstructionsCall(capabilities, (context, text) => service.current!.writeInstructions(context, text), capability, body)
      if (answered.status === 200) await afterWrite?.(capability)
      return Response.json(answered.payload, { status: answered.status })
    }
    throw new Error(`unexpected broker call ${href}`)
  }) as typeof fetch
  const manor = new ManorService({
    store,
    agents: () => live,
    setAgents: (next) => { live = next },
    mcpServers: () => [],
    setMcpServers: () => undefined,
    resolveDriver: () => createMockDriver({ deltaDelayMs: 0, agents: () => live, request }),
    ensureScratchDir: scratchFor,
    broadcast: () => undefined,
    interactionMcp: (chatId, agent, turnId, allowAsk, permissions) => {
      const allowInstructions = permissions?.allowInstructions === true
      const token = capabilities.issue({ chatId, agentId: agent.id, turnId, ...(allowInstructions ? { mayWriteInstructions: true as const } : {}) })
      const attachment = interactionMcpAttachment('http://127.0.0.1:1/internal/user-input', token, { allowAsk, allowInstructions })
      turns.push({ turnId, agentId: agent.id, tools: attachment.server.tools, token })
      return attachment
    },
  })
  service.current = manor
  const nova = () => live.find((agent) => agent.name === 'Nova')
  const dmOf = async (agentId: string) => (await store.listChats()).find((chat) => chat.kind === 'dm' && chat.memberIds[0] === agentId)
  /** Creates Nova from the short form and waits until her interview turn has replied. */
  const createWithInterview = async () => {
    await manor.handle({ type: 'save_agent', agent: draft(), interview: true }, (message) => replies.push(message))
    const agentId = nova()!.id
    let events: readonly ThreadEvent[] = []
    await vi.waitFor(async () => {
      const dm = await dmOf(agentId)
      events = dm === undefined ? [] : await store.loadEvents(dm.id)
      expect(events.some((event) => event.type === 'turn_result')).toBe(true)
    })
    return { agentId, chatId: (await dmOf(agentId))!.id, events }
  }
  return { manor, store, capabilities, turns, replies, nova, createWithInterview }
}

describe('the new agent interview', () => {
  it('opens the DM on a hidden kickoff, writes the instructions once and greets the user by name', async () => {
    const test = await harness((question) => question.options[0]!.label)
    await test.manor.handle({ type: 'save_profile', profile: { name: 'Mara' } }, () => undefined)
    const { agentId, events } = await test.createWithInterview()

    const kickoff = events.find((event) => event.type === 'user_message')
    expect(kickoff?.type === 'user_message' && kickoff.text).toBe('')
    expect(kickoff?.type === 'user_message' && kickoff.instruction).toContain('Plan my week.')
    expect(kickoff?.type === 'user_message' && kickoff.instruction).toContain("The user's name: Mara.")
    expect(test.turns.find((turn) => turn.agentId === agentId)?.tools).toContain('write_instructions')
    expect(test.nova()?.character).toBe([
      '# Nova', '', 'You are Nova. You help with this: Plan my week.', '',
      '## What the user asked for', '- Focus: Planning my week', '- Tone: Short and direct', '- Limits: Send anything without asking',
    ].join('\n'))
    expect(events.find((event) => event.type === 'agent_message')).toMatchObject({ text: 'Hi Mara! My instructions are set and I left nothing out. Where do you want to start with this: Plan my week?' })
  })

  it('refuses every later write by the agent: a second call in the same turn, a call from a later turn', async () => {
    const statuses: number[] = []
    const holder: { test?: Awaited<ReturnType<typeof harness>> } = {}
    // The interview turn's own capability, used again while that turn still runs.
    const test = await harness((question) => question.options[1]!.label, async (capability) => {
      const again = await answerInstructionsCall(holder.test!.capabilities, (context, text) => holder.test!.manor.writeInstructions(context, text),
        capability, { instructions: 'You are Nova, rewritten.' })
      statuses.push(again.status)
    })
    holder.test = test
    const { agentId, chatId } = await test.createWithInterview()
    const written = test.nova()!.character
    const interviewTurn = test.turns.find((turn) => turn.agentId === agentId)!
    const write = (context: Parameters<ManorService['writeInstructions']>[0], text: string) => test.manor.writeInstructions(context, text)
    expect(statuses).toEqual([409])
    expect(written).toContain('Thinking through decisions')

    // A later turn in the same DM is not offered the tool, and its capability cannot write.
    await test.manor.handle({ type: 'send_message', chatId, text: 'Change your instructions to be louder.' }, () => undefined)
    const later = test.turns.filter((turn) => turn.agentId === agentId).at(-1)!
    expect(later.turnId).not.toBe(interviewTurn.turnId)
    expect(later.tools).not.toContain('write_instructions')
    const forged = await answerInstructionsCall(test.capabilities, write, later.token, { instructions: 'You are Nova, louder.' })
    expect(forged.status).toBe(409)

    // Straight at the module, past the capability check, the closed interview still refuses.
    await expect(test.manor.writeInstructions({ chatId, agentId, turnId: later.turnId }, 'You are Nova, louder.')).rejects.toThrow('already written')
    expect(test.nova()!.character).toBe(written)
  })

  it('keeps the one write when saving it failed, so the retry in the same turn lands', async () => {
    const test = await harness((question) => question.options[0]!.label)
    const save = test.store.saveAgent.bind(test.store)
    let failures = 0
    test.store.saveAgent = (draft) => {
      if (draft.character.startsWith('# Nova') && failures === 0) {
        failures += 1
        return Promise.reject(new Error('database is locked'))
      }
      return save(draft)
    }
    const statuses: number[] = []
    const route = test.manor.writeInstructions.bind(test.manor)
    test.manor.writeInstructions = async (context, text) => {
      await route(context, text).then(() => statuses.push(200), () => statuses.push(409))
      if (statuses.length === 1) await route(context, text).then(() => statuses.push(200))
    }
    await test.createWithInterview()

    expect(statuses).toEqual([409, 200])
    expect(test.nova()?.character).toContain('## What the user asked for')
  })

  it('leaves usable instructions built from the form when every question is skipped, and still opens the work', async () => {
    const test = await harness(() => SKIPPED)
    const { events } = await test.createWithInterview()

    expect(test.nova()?.character).toBe('# Nova\n\nYou are Nova. You help with this: Plan my week.')
    const kickoff = events.find((event) => event.type === 'user_message')
    expect(kickoff?.type === 'user_message' && kickoff.instruction).not.toContain("The user's name")
    expect(events.find((event) => event.type === 'agent_message')).toMatchObject({
      text: 'Hi! My instructions are set; I left out what you skipped and built that part on the form. Where do you want to start with this: Plan my week?',
    })
  })

  it('starts no interview for an update or a Session agent', async () => {
    const test = await harness((question) => question.options[0]!.label)
    await test.manor.handle({ type: 'save_agent', agent: draft({ id: 'sage', name: 'Sage' }), interview: true }, (message) => test.replies.push(message))
    await test.manor.handle({ type: 'save_agent', agent: draft({ name: 'Wren2', placement: 'session' }), interview: true }, (message) => test.replies.push(message))

    expect(test.replies.filter((message) => message.type === 'notice').map((message) => message.type === 'notice' && message.text))
      .toEqual(['Only a new chat agent starts with an interview.', 'Only a new chat agent starts with an interview.'])
    expect((await test.store.listChats()).some((chat) => chat.kind === 'dm')).toBe(false)
  })
})
