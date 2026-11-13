import { randomUUID } from 'node:crypto'
import type { Driver, RuntimeEvent, ServerMessage, ThreadEvent, TurnInput, UserInputQuestion } from '@manor/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InteractionBroker } from '../src/interactionBroker.js'
import { Orchestrator } from '../src/orchestrator.js'
import { awaitingInputNotice } from '../src/pushNotifications.js'
import { SecretRequests } from '../src/secretRequests.js'
import { AsyncQueue } from '../src/asyncQueue.js'
import { createMemoryStore } from '../src/stores/memoryStore.js'
import { roster, scratchFor, seededChat, until } from './helpers.js'

/** A value no fixture could produce by chance. */
const SENTINEL = `MANOR-SENTINEL-${randomUUID()}`
const encoded = [SENTINEL, Buffer.from(SENTINEL).toString('base64')]

afterEach(() => vi.restoreAllMocks())

/** The whole path with a real orchestrator: only the provider is scripted. Its second prompt is what a later turn reads. */
async function run(mode: 'held' | 'posted', memory: boolean) {
  const agents = roster.map((agent) => ({ ...agent, memoryScope: memory }))
  const store = createMemoryStore({ agents })
  const { chatId } = await seededChat(store)
  const sent: ServerMessage[] = []
  const prompts: TurnInput[] = []
  const writeDailyLog = vi.fn(async () => undefined)
  const generateMemoryTrace = vi.fn(async () => ({ used: [], note: '' }) as never)
  const advanceChatSummary = vi.fn(async () => false)
  const notices: unknown[] = []
  let orchestrator!: Orchestrator
  const interactions = new InteractionBroker({
    request: async (context, requestId, questions) => {
      const recorded = await orchestrator.recordUserInputRequest(context.chatId, context.agentId, context.turnId, requestId, questions)
      notices.push(await awaitingInputNotice(store, agents, context.chatId, context.agentId, questions))
      return recorded
    },
    response: (context, requestId, answers) =>
      orchestrator.recordUserInputResponse(context.chatId, context.agentId, context.turnId, requestId, answers),
  })
  const secrets = new SecretRequests({ interactions, passwordPage: async () => { throw new Error('No page.') } })
  const driver: Driver = {
    startTurn(input) {
      prompts.push(input)
      const queue = new AsyncQueue<RuntimeEvent>()
      const finish = (text: string) => {
        queue.push({ type: 'message', messageId: randomUUID(), text })
        queue.push({ type: 'result', text, sessionId: 'session' })
        queue.close()
      }
      if (prompts.length === 1) {
        // A command that does its worst: it prints the value plainly and encoded, to both streams.
        void secrets.request(
          { chatId: input.threadId, agentId: input.agent.id, turnId: orchestrator.activeTurn(input.threadId)!.turnId, commandCwd: process.cwd() },
          {
            label: 'API token',
            reason: 'To call the API.',
            target: 'command',
            command: 'echo "$API_TOKEN"; printf %s "$API_TOKEN" | base64; echo "$API_TOKEN" >&2',
            env: 'API_TOKEN',
          },
          mode === 'posted',
        ).then(finish, (error: Error) => finish(error.message))
      } else finish('Thanks.')
      return { events: queue, stop: () => queue.close() }
    },
  }
  orchestrator = new Orchestrator({
    agents: () => agents,
    store,
    mcpServers: () => [],
    skills: () => [],
    resolveDriver: () => driver,
    ensureScratchDir: scratchFor,
    emit: (message) => sent.push(message),
    openQuestions: interactions,
    writeDailyLog,
    generateMemoryTrace,
    advanceChatSummary,
  })
  const logged = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => undefined))
  const written = [vi.spyOn(process.stdout, 'write'), vi.spyOn(process.stderr, 'write')]

  const finished = orchestrator.submitUserMessage(chatId, '@Sage Call the API.')
  const card = (): Extract<ThreadEvent, { type: 'user_input_request' }> | undefined => {
    for (const message of sent) {
      if (message.type === 'event' && message.event.type === 'user_input_request') return message.event
    }
    return undefined
  }
  await until(() => card() !== undefined, 'the secret card')
  expect(secrets.answer(chatId, card()!.requestId, SENTINEL)).toBe(true)
  await finished
  await until(() => sent.some((message) => message.type === 'event' && message.event.type === 'user_input_response'), 'the outcome')
  await orchestrator.submitUserMessage(chatId, '@Sage What did the API say?')

  return {
    surfaces: {
      broadcast: sent,
      events: await store.loadEvents(chatId),
      prompts: prompts.map(({ agent: _agent, ...prompt }) => prompt),
      dailyLog: writeDailyLog.mock.calls,
      memoryTrace: generateMemoryTrace.mock.calls,
      summary: advanceChatSummary.mock.calls,
      push: notices,
      logs: [...logged, ...written].map((spy) => spy.mock.calls),
    },
    prompts,
  }
}

describe('a secret value', () => {
  it.each([
    ['held', false],
    ['held', true],
    ['posted', false],
    ['posted', true],
  ] as const)('leaves no trace on any surface, %s with memory %s', async (mode, memory) => {
    const { surfaces, prompts } = await run(mode, memory)
    for (const [surface, content] of Object.entries(surfaces)) {
      const text = JSON.stringify(content)
      for (const form of encoded) expect(text.includes(form), `${surface} holds the value`).toBe(false)
    }
    // Both runs reached use, so the absence above is about a value that really went through.
    expect(JSON.stringify([surfaces.events, surfaces.prompts])).toContain('[secret hidden]')
    expect(prompts.length).toBeGreaterThanOrEqual(2)
  })

  it('shows a push only that a request waits, not its label or reason', async () => {
    const store = createMemoryStore({ agents: roster })
    const { chatId } = await seededChat(store)
    const questions: UserInputQuestion[] = [{
      id: 'secret',
      header: 'Bank password',
      question: 'To sign in at my bank.',
      options: [{ label: 'Enter it' }, { label: 'Decline' }],
      optionsOnly: true,
      desktopOnly: true,
      secret: { target: 'browser', site: 'bank.example' },
    }]
    const notice = await awaitingInputNotice(store, roster, chatId, 'sage', questions)
    expect(notice?.body).toBe('A secret request is waiting')
    expect(JSON.stringify(notice)).not.toMatch(/bank/i)
  })
})
