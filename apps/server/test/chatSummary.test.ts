import type { TurnInput } from '@manor/contracts'
import { describe, expect, it, vi } from 'vitest'
import {
  CHAT_SUMMARY_LIMIT,
  CHAT_SUMMARY_MODEL,
  CHAT_SUMMARY_TARGET,
  cleanChatSummary,
  createChatSummaryGenerator,
  createChatSummaryUpdater,
} from '../src/chatSummary.js'
import { createMemoryStore } from '../src/stores/memoryStore.js'
import { roster, scratchFor, scripted, seededChat } from './helpers.js'

describe('chat summaries', () => {
  it('sends the old summary and newly settled events through a disposable runtime turn', async () => {
    const seen: TurnInput[] = []
    const driver = scripted(
      () => [{ type: 'result', text: 'Current decision: build the heart first.' }],
      seen,
    )
    const generate = createChatSummaryGenerator({
      attempts: [{ driver, runtime: 'codex', model: CHAT_SUMMARY_MODEL }],
      ensureScratchDir: scratchFor,
    })

    await expect(generate({
      chatId: 'chat_1',
      previousSummary: 'The project is Manor.',
      transcript: 'Sam: Build the heart before the housing.',
    })).resolves.toBe('Current decision: build the heart first.')

    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      threadId: 'summary_chat_1',
      repoPaths: [],
      isFullCatchUp: true,
      agent: {
        driver: 'codex',
        model: CHAT_SUMMARY_MODEL,
        effort: 'high',
        allowedTools: [],
        mcpServers: [],
      },
    })
    expect(seen[0]?.infrastructure).toBe(true)
    expect(seen[0]?.promptCaching).toBe('off')
    const prompt = seen[0]?.catchUp[0]
    expect(prompt?.type).toBe('user_message')
    expect(prompt?.type === 'user_message' ? prompt.text : '').toContain('The project is Manor.')
    expect(prompt?.type === 'user_message' ? prompt.text : '').toContain(
      'Sam: Build the heart before the housing.',
    )
  })

  it('tries the fallback after an empty run and keeps no partial output', async () => {
    const seen: TurnInput[] = []
    const empty = scripted(() => [], seen)
    const fallback = scripted(() => [{ type: 'result', text: 'Fallback summary.' }], seen)
    const generate = createChatSummaryGenerator({
      attempts: [
        { driver: empty, runtime: 'codex', model: CHAT_SUMMARY_MODEL },
        { driver: fallback, runtime: 'claude', model: 'haiku' },
      ],
      ensureScratchDir: scratchFor,
    })

    await expect(generate({
      chatId: 'chat_1',
      previousSummary: '',
      transcript: 'Sam: Hello',
    })).resolves.toBe('Fallback summary.')
    expect(seen.map((input) => input.agent.driver)).toEqual(['codex', 'claude'])
    for (const input of seen) {
      expect(input.agent.character).toContain('Preserve uncertainty wording verbatim')
      expect(input.agent.character).toContain('never invent links or missing provenance')
      expect(input.agent.character).toContain('an intention is not an instruction or authorization')
      expect(input.agent.character).toContain('an agent’s first-person statement is not the user’s')
    }
  })

  it('includes source references for user corrections and keeps conditional wording in the input', async () => {
    const store = createMemoryStore({ agents: roster })
    const { chatId } = await seededChat(store)
    const correction = await store.appendEvent(chatId, {
      type: 'user_message', text: 'Correctie: indien mogelijk 20 september. Waarschijnlijk plan ik het zelf; plan niets namens mij.', mentions: [],
    })
    const generate = vi.fn().mockResolvedValue('A conditional proposal, not a confirmed deadline.')
    await createChatSummaryUpdater({ store, agents: () => roster, generate, thresholdChars: 1 })(chatId)
    const input = generate.mock.calls[0]?.[0].transcript
    expect(input).toContain(`[Source event ${correction.id} at ${new Date(correction.ts).toISOString()}]`)
    expect(input).toContain('indien mogelijk 20 september')
    expect(input).toContain('plan niets namens mij')
  })

  it('discards streamed output when that runtime attempt ends in an error', async () => {
    const seen: TurnInput[] = []
    const errors: unknown[] = []
    const partial = scripted(
      () => [
        { type: 'delta', messageId: 'partial', text: 'Plausible but incomplete.' },
        { type: 'error', message: 'provider lost the turn' },
      ],
      seen,
    )
    const fallback = scripted(() => [{ type: 'result', text: 'Complete fallback summary.' }], seen)
    const generate = createChatSummaryGenerator({
      attempts: [
        { driver: partial, runtime: 'codex', model: CHAT_SUMMARY_MODEL },
        { driver: fallback, runtime: 'claude', model: 'haiku' },
      ],
      ensureScratchDir: scratchFor,
      onError: (error) => errors.push(error),
    })

    await expect(generate({
      chatId: 'chat_1',
      previousSummary: '',
      transcript: 'Sam: Keep every decision.',
    })).resolves.toBe('Complete fallback summary.')
    expect(seen.map((input) => input.agent.driver)).toEqual(['codex', 'claude'])
    expect(errors).toHaveLength(1)
  })

  it('does nothing below the threshold and advances from the prior cursor above it', async () => {
    const store = createMemoryStore({ agents: roster })
    const { chatId } = await seededChat(store)
    const generate = vi.fn().mockResolvedValue('Shared current state.')
    const advance = createChatSummaryUpdater({
      store,
      agents: () => roster,
      generate,
      thresholdChars: 50,
    })

    await store.appendEvent(chatId, { type: 'user_message', text: 'short', mentions: [] })
    await advance(chatId)
    expect(generate).not.toHaveBeenCalled()
    expect(await store.getChatSummary(chatId)).toBeUndefined()

    await store.appendEvent(chatId, { type: 'user_message', text: 'x'.repeat(60), mentions: [] })
    await advance(chatId)
    expect(generate).toHaveBeenCalledTimes(1)
    expect(await store.getChatSummary(chatId)).toMatchObject({
      summary: 'Shared current state.',
      throughEventId: 'evt_000002',
    })
  })

  it('keeps the previous row after missing, empty or oversized output and retries the same region later', async () => {
    const store = createMemoryStore({ agents: roster })
    const { chatId } = await seededChat(store)
    await store.appendEvent(chatId, { type: 'user_message', text: 'old', mentions: [] })
    await store.setChatSummary(chatId, 'Old summary.', 'evt_000001')
    await store.appendEvent(chatId, { type: 'user_message', text: 'new', mentions: [] })
    const outputs = [undefined, '', 'x'.repeat(CHAT_SUMMARY_LIMIT + 1)]
    const generate = vi.fn().mockImplementation(async () => outputs.shift())
    const advance = createChatSummaryUpdater({
      store,
      agents: () => roster,
      generate,
      thresholdChars: 0,
    })

    await advance(chatId)
    await advance(chatId)
    await advance(chatId)
    expect(await store.getChatSummary(chatId)).toMatchObject({
      summary: 'Old summary.',
      throughEventId: 'evt_000001',
    })

    generate.mockResolvedValueOnce('New summary.')
    await advance(chatId)
    expect(await store.getChatSummary(chatId)).toMatchObject({
      summary: 'New summary.',
      throughEventId: 'evt_000002',
    })
  })

  it('stores each bounded event prefix before attempting the next one', async () => {
    const store = createMemoryStore({ agents: roster })
    const { chatId } = await seededChat(store)
    for (const text of ['a'.repeat(20), 'b'.repeat(20), 'c'.repeat(20)]) {
      await store.appendEvent(chatId, { type: 'user_message', text, mentions: [] })
    }
    let attempt = 0
    const generate = vi.fn().mockImplementation(async () => {
      attempt += 1
      return attempt === 2 ? undefined : `Summary ${attempt}.`
    })
    const advance = createChatSummaryUpdater({
      store,
      agents: () => roster,
      generate,
      thresholdChars: 1,
      batchChars: 100,
    })

    await advance(chatId)
    expect(await store.getChatSummary(chatId)).toMatchObject({
      summary: 'Summary 1.',
      throughEventId: 'evt_000001',
    })
    expect(generate.mock.calls.every(([input]) => input.transcript.length <= 100)).toBe(true)

    generate.mockImplementation(async () => `Summary ${attempt += 1}.`)
    await advance(chatId)
    expect(await store.getChatSummary(chatId)).toMatchObject({ throughEventId: 'evt_000003' })
  })

  it('folds one oversized event through bounded fragments before advancing its cursor', async () => {
    const store = createMemoryStore({ agents: roster })
    const { chatId } = await seededChat(store)
    await store.appendEvent(chatId, { type: 'user_message', text: 'x'.repeat(100), mentions: [] })
    let pass = 0
    const generate = vi.fn().mockImplementation(async () => `Summary pass ${pass += 1}.`)
    const advance = createChatSummaryUpdater({
      store,
      agents: () => roster,
      generate,
      thresholdChars: 1,
      batchChars: 25,
    })

    await advance(chatId)

    expect(generate.mock.calls.length).toBeGreaterThan(1)
    expect(generate.mock.calls.every(([input]) => input.transcript.length <= 25)).toBe(true)
    expect(await store.getChatSummary(chatId)).toMatchObject({ throughEventId: 'evt_000001' })
  })

  it('includes outbound delivery state in the summary source', async () => {
    const store = createMemoryStore({ agents: roster })
    const { chatId } = await seededChat(store)
    await store.appendEvent(chatId, {
      type: 'outbound_draft_submission',
      agentId: 'smith',
      turnId: 'turn_send',
      draftId: 'draft_1',
      submissionId: '11111111-1111-4111-8111-111111111111',
      status: 'uncertain',
      message: 'The server restarted before delivery could be confirmed.',
      channel: 'gmail',
      to: 'ada@example.com',
      body: 'Edited body',
    })
    const generate = vi.fn().mockResolvedValue('Delivery remains uncertain.')
    const advance = createChatSummaryUpdater({
      store,
      agents: () => roster,
      generate,
      thresholdChars: 1,
    })

    await advance(chatId)

    expect(generate.mock.calls[0]?.[0].transcript).toContain('is uncertain; it remains locked against retry')
  })

  it('accepts complete output at the limit but refuses to slice an overshoot', () => {
    expect(cleanChatSummary(`  ${'x'.repeat(CHAT_SUMMARY_LIMIT)}  `)).toHaveLength(CHAT_SUMMARY_LIMIT)
    expect(() => cleanChatSummary('x'.repeat(CHAT_SUMMARY_LIMIT + 1))).toThrow('exceeds')
  })

  it.each(['gmail', 'slack'] as const)('passes the edited delivered %s message to the summarizer as dated source material', async (channel) => {
    const store = createMemoryStore({ agents: roster })
    const { chatId } = await seededChat(store)
    await store.appendEvent(chatId, {
      type: 'agent_message', agentId: 'smith', turnId: 'turn_draft', text: 'I will not submit the assignment.',
    })
    const body = 'If possible, I could submit the assignment on 20 September.'
    const sent = await store.appendEvent(chatId, {
      type: 'outbound_draft_submission', status: 'delivered', agentId: 'smith', turnId: 'turn_send',
      draftId: 'draft_1', submissionId: '11111111-1111-4111-8111-111111111111',
      channel, to: 'ada@example.com', subject: 'Assignment', body,
    })
    const generate = vi.fn().mockResolvedValue('A conditional extension was proposed.')
    await createChatSummaryUpdater({ store, agents: () => roster, generate, thresholdChars: 1 })(chatId)
    const transcript = generate.mock.calls[0]?.[0].transcript
    expect(transcript).toContain('I will not submit the assignment.')
    expect(transcript).toContain(JSON.stringify({ subject: 'Assignment', body }))
    expect(transcript).toContain('may differ from the earlier agent draft')
    expect(transcript).toContain(`Source event: ${JSON.stringify(sent.id)}`)
    expect(transcript).toContain(`Delivered at: ${new Date(sent.ts).toISOString()}`)
  })

  it('asks the same model once more when the first draft overshoots', async () => {
    const seen: TurnInput[] = []
    const driver = scripted((_input, attempt) => [{
      type: 'result',
      text: attempt === 1 ? 'x'.repeat(CHAT_SUMMARY_LIMIT + 50) : 'Short enough summary.',
    }], seen)
    const generate = createChatSummaryGenerator({
      attempts: [{ driver, runtime: 'codex', model: CHAT_SUMMARY_MODEL }],
      ensureScratchDir: scratchFor,
    })

    await expect(generate({
      chatId: 'chat_1',
      previousSummary: 'Old.',
      transcript: 'Sam: Keep going.',
    })).resolves.toBe('Short enough summary.')
    expect(seen).toHaveLength(2)
    expect(seen[1]?.threadId).toBe('summary_chat_1_trim')
    expect(seen[1]?.agent.character).toBe(seen[0]?.agent.character)
    expect(seen[1]?.agent.character).toContain('a proposed or conditional date never becomes a confirmed deadline')
    const shrink = seen[1]?.catchUp[0]
    const shrinkText = shrink?.type === 'user_message' ? shrink.text : ''
    // A model cannot count characters, so the retry names the size and the share to cut.
    expect(shrinkText).toContain(`The draft below is ${CHAT_SUMMARY_LIMIT + 50} characters.`)
    expect(shrinkText).toContain(`about ${CHAT_SUMMARY_TARGET} characters`)
    expect(shrinkText).toContain('roughly 26 percent')
  })

  it('tells the writer how long the summary it replaces is, and to shrink one that is near the limit', async () => {
    const seen: TurnInput[] = []
    const driver = scripted(() => [{ type: 'result', text: 'Rewritten.' }], seen)
    const generate = createChatSummaryGenerator({
      attempts: [{ driver, runtime: 'codex', model: CHAT_SUMMARY_MODEL }],
      ensureScratchDir: scratchFor,
    })
    const promptOf = (index: number) => {
      const prompt = seen[index]?.catchUp[0]
      return prompt?.type === 'user_message' ? prompt.text : ''
    }

    await generate({ chatId: 'chat_1', previousSummary: '', transcript: 'Sam: Hello' })
    expect(promptOf(0)).not.toContain('The previous summary is')

    await generate({ chatId: 'chat_1', previousSummary: 'x'.repeat(2_000), transcript: 'Sam: Hello' })
    expect(promptOf(1)).toContain(`The previous summary is 2000 characters. The replacement stays at about ${CHAT_SUMMARY_TARGET} characters or under`)

    // The state three live chats were stuck in: no room left, so every rewrite landed over the limit.
    await generate({ chatId: 'chat_1', previousSummary: 'x'.repeat(7_794), transcript: 'Sam: Hello' })
    expect(promptOf(2)).toContain('The previous summary is 7794 characters')
    expect(promptOf(2)).toContain('has to end up shorter than the previous one')
    expect(seen[2]?.agent.character).toContain(`Aim for about ${CHAT_SUMMARY_TARGET} characters and never pass ${CHAT_SUMMARY_LIMIT}`)
  })

  it('stops at a summary that stays too long, and still tries the next provider after a provider failure', async () => {
    const seen: TurnInput[] = []
    const long = scripted(() => [{ type: 'result', text: 'x'.repeat(CHAT_SUMMARY_LIMIT + 50) }], seen)
    const broken = scripted(() => [{ type: 'error', message: 'provider is down' }], seen)
    const fallback = scripted(() => [{ type: 'result', text: 'Fallback summary.' }], seen)
    const failed: string[] = []
    const input = { chatId: 'chat_1', previousSummary: 'Old.', transcript: 'Sam: Keep going.' }

    // The same source and the same limit go to every model, so a second provider would only spend more.
    const tooLong = createChatSummaryGenerator({
      attempts: [
        { driver: long, runtime: 'codex', model: CHAT_SUMMARY_MODEL },
        { driver: fallback, runtime: 'claude', model: 'haiku' },
      ],
      ensureScratchDir: scratchFor,
      onError: (error, attempt) => failed.push(`${attempt.model}: ${error instanceof Error ? error.name : 'unknown'}`),
    })
    await expect(tooLong(input)).resolves.toBeUndefined()
    expect(seen.map((turn) => turn.agent.driver)).toEqual(['codex', 'codex'])
    expect(failed).toEqual([`${CHAT_SUMMARY_MODEL}: ChatSummaryTooLong`])

    seen.length = 0
    const down = createChatSummaryGenerator({
      attempts: [
        { driver: broken, runtime: 'codex', model: CHAT_SUMMARY_MODEL },
        { driver: fallback, runtime: 'claude', model: 'haiku' },
      ],
      ensureScratchDir: scratchFor,
    })
    await expect(down(input)).resolves.toBe('Fallback summary.')
    expect(seen.map((turn) => turn.agent.driver)).toEqual(['codex', 'claude'])
  })

  it.each(['failed shrink', 'second overshoot'])('keeps the previous summary and cursor after %s, then retries', async (failure) => {
    const store = createMemoryStore({ agents: roster })
    const { chatId } = await seededChat(store)
    const old = await store.appendEvent(chatId, { type: 'user_message', text: 'Old state.', mentions: [] })
    await store.setChatSummary(chatId, 'Previous complete summary.', old.id)
    const next = await store.appendEvent(chatId, { type: 'user_message', text: 'The extension is only a proposal.', mentions: [] })
    const seen: TurnInput[] = []
    const driver = scripted((_input, attempt) => (
      attempt > 2
        ? [{ type: 'result', text: 'The extension is only a proposal.' }]
        : attempt === 2 && failure === 'failed shrink'
          ? [{ type: 'error', message: 'provider lost the shrink' }]
          : [{ type: 'result', text: `${'x'.repeat(CHAT_SUMMARY_LIMIT)}\nThe extension is only a proposal.` }]
    ), seen)
    const generate = createChatSummaryGenerator({
      attempts: [{ driver, runtime: 'codex', model: CHAT_SUMMARY_MODEL }],
      ensureScratchDir: scratchFor,
    })

    const advance = createChatSummaryUpdater({ store, agents: () => roster, generate, thresholdChars: 1 })
    await advance(chatId)
    expect(seen).toHaveLength(2)
    expect(await store.getChatSummary(chatId)).toMatchObject({ summary: 'Previous complete summary.', throughEventId: old.id })

    await advance(chatId)
    expect(seen).toHaveLength(3)
    expect(seen[2]?.catchUp[0]).toMatchObject({ text: seen[0]?.catchUp[0]?.type === 'user_message' ? seen[0].catchUp[0].text : '' })
    expect(await store.getChatSummary(chatId)).toMatchObject({ summary: 'The extension is only a proposal.', throughEventId: next.id })
  })
})
