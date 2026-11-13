import { USER_INPUT_ANSWER_MAX } from '@manor/contracts'
import { describe, expect, it, vi } from 'vitest'
import { InteractionBroker, askedByModel, preferenceAnswerText, type UserInputRecorder } from '../src/interactionBroker.js'
import { questionAnswerText } from '../src/turnRunner.js'

const context = { chatId: 'chat_1', agentId: 'sage', turnId: 'turn_1' }
const questions = [{
  id: 'direction',
  question: 'Which direction?',
  options: [{ label: 'A' }, { label: 'B' }],
}]

function harness(idle?: { hold(chatId: string, agentId: string): void; release(chatId: string, agentId: string): void }) {
  const requests: string[] = []
  const responses: import('@manor/contracts').UserInputAnswers[] = []
  const recorder: UserInputRecorder = {
    request: async (_context, requestId) => {
      requests.push(requestId)
      return true
    },
    response: async (_context, _requestId, answers) => {
      responses.push(answers)
      return true
    },
  }
  return { broker: new InteractionBroker(recorder, idle), requests, responses }
}

describe('askedByModel', () => {
  // Only a permission card may take the free line off, and only Manor makes those.
  it('leaves the free line on a question the model asked for options-only', () => {
    const asked = askedByModel([{ ...questions[0]!, optionsOnly: true, desktopOnly: true }])

    expect(asked[0]?.optionsOnly).toBeUndefined()
    expect(asked[0]?.desktopOnly).toBeUndefined()
    expect(asked[0]?.options).toEqual(questions[0]!.options)
  })
})

describe('InteractionBroker', () => {
  it('records the question and answer before releasing the blocked MCP call', async () => {
    const { broker, requests, responses } = harness()
    const waiting = broker.request(context, questions)
    await vi.waitFor(() => expect(requests).toHaveLength(1))

    await expect(broker.answer('chat_1', requests[0]!, { direction: 'A' })).resolves.toBe(true)
    expect(responses).toEqual([{ direction: 'A' }])
    await expect(waiting).resolves.toEqual({ direction: 'A' })
  })

  it('refuses incomplete and cross-chat answers without releasing the call', async () => {
    const { broker, requests } = harness()
    const waiting = broker.request(context, questions)
    await vi.waitFor(() => expect(requests).toHaveLength(1))

    await expect(broker.answer('chat_2', requests[0]!, { direction: 'A' })).resolves.toBe(false)
    await expect(broker.answer('chat_1', requests[0]!, {})).resolves.toBe(false)
    broker.closeTurn('turn_1')
    await expect(waiting).rejects.toThrow('turn ended')
  })

  it('refuses an answer that exceeds the shared character cap', async () => {
    const { broker, requests } = harness()
    const waiting = broker.request(context, questions)
    await vi.waitFor(() => expect(requests).toHaveLength(1))

    await expect(
      broker.answer('chat_1', requests[0]!, { direction: 'x'.repeat(USER_INPUT_ANSWER_MAX + 1) }),
    ).resolves.toBe(false)
    await expect(
      broker.answer('chat_1', requests[0]!, { direction: 'x'.repeat(USER_INPUT_ANSWER_MAX) }),
    ).resolves.toBe(true)
    await expect(waiting).resolves.toEqual({ direction: 'x'.repeat(USER_INPUT_ANSWER_MAX) })
  })

  it('accepts several lines for a multi question and refuses them for a single choice', async () => {
    const multi = [{ id: 'picks', question: 'Which?', multi: true as const, options: [{ label: 'A' }, { label: 'B' }] }]
    const { broker, requests } = harness()
    const waiting = broker.request(context, multi)
    await vi.waitFor(() => expect(requests).toHaveLength(1))

    await expect(broker.answer('chat_1', requests[0]!, { picks: 'Skipped. Decide this one yourself.' })).resolves.toBe(
      true,
    )
    await expect(waiting).resolves.toEqual({ picks: 'Skipped. Decide this one yourself.' })

    const listed = harness()
    const listedWait = listed.broker.request(context, multi)
    await vi.waitFor(() => expect(listed.requests).toHaveLength(1))
    await expect(listed.broker.answer('chat_1', listed.requests[0]!, { picks: ['A', 'B'] })).resolves.toBe(true)
    await expect(listedWait).resolves.toEqual({ picks: ['A', 'B'] })

    const single = harness()
    const held = single.broker.request(context, questions)
    await vi.waitFor(() => expect(single.requests).toHaveLength(1))
    await expect(single.broker.answer('chat_1', single.requests[0]!, { direction: ['A'] })).resolves.toBe(false)
    await expect(single.broker.answer('chat_1', single.requests[0]!, { direction: ['A', 'B'] })).resolves.toBe(false)
    single.broker.closeTurn('turn_1')
    await expect(held).rejects.toThrow('turn ended')
  })

  it('refuses duplicate or extra multi answers past the visible rows including Other', async () => {
    const multi = [{ id: 'picks', question: 'Which?', multi: true as const, options: [{ label: 'A' }, { label: 'B' }] }]
    const { broker, requests } = harness()
    const waiting = broker.request(context, multi)
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    await expect(broker.answer('chat_1', requests[0]!, { picks: ['A', 'A'] })).resolves.toBe(false)
    await expect(broker.answer('chat_1', requests[0]!, { picks: ['A', 'B', 'C', 'D'] })).resolves.toBe(false)
    broker.closeTurn('turn_1')
    await expect(waiting).rejects.toThrow('turn ended')
  })

  it('reports live waits by chat for the directory listing', async () => {
    const { broker, requests } = harness()
    const waiting = broker.request(context, questions)
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    expect(broker.pendingAsks()).toEqual({ chat_1: [requests[0]] })
    await broker.answer('chat_1', requests[0]!, { direction: 'A' })
    await waiting
    expect(broker.pendingAsks()).toEqual({})
  })

  it('holds the idle clock only while the question is open', async () => {
    const events: string[] = []
    const { broker, requests } = harness({
      hold: (chatId, agentId) => events.push(`hold ${chatId} ${agentId}`),
      release: (chatId, agentId) => events.push(`release ${chatId} ${agentId}`),
    })
    const waiting = broker.request(context, questions)
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    expect(events).toEqual(['hold chat_1 sage'])

    await broker.answer('chat_1', requests[0]!, { direction: 'A' })
    await waiting
    expect(events).toEqual(['hold chat_1 sage', 'release chat_1 sage'])
  })

  it('does not leave a pending question when the transcript write fails', async () => {
    const events: string[] = []
    const broker = new InteractionBroker({
      request: async () => false,
      response: async () => true,
    }, {
      hold: (chatId, agentId) => events.push(`hold ${chatId} ${agentId}`),
      release: (chatId, agentId) => events.push(`release ${chatId} ${agentId}`),
    })
    await expect(broker.request(context, questions)).rejects.toThrow('no longer waiting')
    expect(events).toEqual(['hold chat_1 sage', 'release chat_1 sage'])
  })

  it('keeps a posted question answerable and hands its answer to the next attempt', async () => {
    const events: string[] = []
    const { broker, requests } = harness({
      hold: () => events.push('hold'),
      release: () => events.push('release'),
    })
    await broker.post(context, questions)
    expect(requests).toHaveLength(1)
    expect(broker.waiting('turn_1')).toBe(true)
    const changed = broker.changed('turn_1')

    await expect(broker.answer('chat_1', requests[0]!, { direction: 'B' })).resolves.toBe(true)
    await changed
    expect(broker.waiting('turn_1')).toBe(false)
    expect(broker.takeAnswered('turn_1')).toEqual([{ requestId: requests[0], questions, answers: { direction: 'B' } }])
    expect(broker.takeAnswered('turn_1')).toEqual([])
    // Nothing waits on the call, so the idle clock was never paused.
    expect(events).toEqual([])
  })

  it('tells the asking agent Manor answered from a preference, in the same words for a held and a posted call', async () => {
    const corners = [{ id: 'corners', question: 'Square or round corners?', options: [{ label: 'Round' }, { label: 'Square' }] }]
    const source = { file: 'preferences.md', quote: 'Corners are always round' }
    const { broker, requests } = harness()
    const held = broker.ask(context, corners)
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    await broker.answer('chat_1', requests[0]!, { corners: 'Round' }, source)
    await expect(held).resolves.toEqual({ answers: { corners: 'Round' }, fromPreference: source })

    await broker.post({ ...context, turnId: 'turn_2' }, corners)
    await broker.answer('chat_1', requests[1]!, { corners: 'Round' }, source)
    const posted = questionAnswerText(broker.takeAnswered('turn_2'))
    const note = preferenceAnswerText(corners, { corners: 'Round' }, source)
    expect(note).toContain('Manor chose Round, from preferences.md: Corners are always round')
    expect(note).toContain('The user did not pick this')
    expect(posted).toContain(note)
    expect(posted).not.toContain('Answer: Round')
  })

  it('carries a held question whose call the provider dropped to the next attempt', async () => {
    const events: string[] = []
    const { broker, requests } = harness({
      hold: () => events.push('hold'),
      release: () => events.push('release'),
    })
    void broker.request(context, questions).catch(() => undefined)
    await vi.waitFor(() => expect(requests).toHaveLength(1))

    broker.detachTurn('turn_1')
    expect(events).toEqual(['hold', 'release'])
    await broker.answer('chat_1', requests[0]!, { direction: 'A' })
    expect(events).toEqual(['hold', 'release'])
    expect(broker.takeAnswered('turn_1').map((answered) => answered.answers)).toEqual([{ direction: 'A' }])
  })

  it('drops unread answers and wakes the waiting turn when the turn closes', async () => {
    const { broker, requests } = harness()
    await broker.post(context, questions)
    const changed = broker.changed('turn_1')
    broker.closeTurn('turn_1')
    await changed
    expect(broker.waiting('turn_1')).toBe(false)
    await expect(broker.answer('chat_1', requests[0]!, { direction: 'A' })).resolves.toBe(false)
    expect(broker.takeAnswered('turn_1')).toEqual([])
  })

  it('throws from post when the turn no longer takes questions', async () => {
    const broker = new InteractionBroker({ request: async () => false, response: async () => true })
    await expect(broker.post(context, questions)).rejects.toThrow('no longer waiting')
    expect(broker.waiting('turn_1')).toBe(false)
  })

  it('keeps a superseded question answerable without holding the turn', async () => {
    const { broker, requests } = harness()
    await broker.post(context, questions)
    expect(broker.pendingAsks()).toEqual({ chat_1: [requests[0]] })
    broker.supersede('turn_1')
    expect(broker.waiting('turn_1')).toBe(false)
    expect(broker.pendingAsks()).toEqual({})

    await expect(broker.answer('chat_1', requests[0]!, { direction: 'A' })).resolves.toBe(true)
    expect(broker.takeAnswered('turn_1').map((answered) => answered.answers)).toEqual([{ direction: 'A' }])
  })

  it('tells the recorder once when a supersede changes what waits', async () => {
    let superseded = 0
    const broker = new InteractionBroker({ request: async () => true, response: async () => true, superseded: () => { superseded += 1 } })
    broker.supersede('turn_1')
    expect(superseded).toBe(0)
    await broker.post(context, questions)
    broker.supersede('turn_1')
    broker.supersede('turn_1')
    expect(superseded).toBe(1)
  })

  it('keeps nothing for a turn that closed while its answer was being written', async () => {
    let written!: () => void
    const writing = new Promise<void>((resolve) => { written = resolve })
    const requests: string[] = []
    const broker = new InteractionBroker({
      request: async (_context, requestId) => { requests.push(requestId); return true },
      response: async () => { await writing; return true },
    })
    await broker.post(context, questions)
    const answering = broker.answer('chat_1', requests[0]!, { direction: 'B' })
    broker.closeTurn('turn_1')
    written()
    await answering
    expect(broker.takeAnswered('turn_1')).toEqual([])
  })

  it('leaves a held call held when superseded, so the idle clock stays paused', async () => {
    const events: string[] = []
    const { broker, requests } = harness({ hold: () => events.push('hold'), release: () => events.push('release') })
    void broker.request(context, questions).catch(() => undefined)
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    broker.supersede('turn_1')
    expect(broker.waiting('turn_1')).toBe(false)
    expect(events).toEqual(['hold'])
    broker.closeTurn('turn_1')
    expect(events).toEqual(['hold', 'release'])
  })
})
