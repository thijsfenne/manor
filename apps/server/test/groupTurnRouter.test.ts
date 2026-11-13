import type { TurnInput } from '@manor/contracts'
import { describe, expect, it, vi } from 'vitest'
import { AsyncQueue } from '../src/asyncQueue.js'
import {
  GROUP_TURN_ROUTER_CONTEXT_CHARS,
  GROUP_TURN_ROUTER_MODEL,
  createGroupTurnRouter,
  fallbackGroupTurnRoute,
  groupGreetingMemberIds,
  groupTurnTranscript,
  parseGroupTurnRoute,
} from '../src/groupTurnRouter.js'
import { marlow, sage, scratchFor, scripted, smith } from './helpers.js'

const input = {
  chatId: 'group_1',
  message: 'What do you both think?',
  members: [marlow, sage, smith],
  transcript: 'Sam: We need one product and one technical view.',
  fallbackAgentIds: ['marlow'],
}

describe('group turn router', () => {
  it('runs a disposable tool-free judgment and accepts several selected members', async () => {
    const seen: TurnInput[] = []
    const driver = scripted(
      () => [{ type: 'result', text: '{"agentIds":["sage","smith"]}' }],
      seen,
    )
    const route = createGroupTurnRouter({
      attempts: [{ driver, runtime: 'codex', model: GROUP_TURN_ROUTER_MODEL }],
      ensureScratchDir: scratchFor,
    })

    await expect(route(input)).resolves.toEqual(['sage', 'smith'])
    expect(seen[0]).toMatchObject({
      threadId: 'group_route_group_1',
      repoPaths: [],
      isFullCatchUp: true,
      infrastructure: true,
      agent: {
        id: 'manor-group-turn-router',
        model: GROUP_TURN_ROUTER_MODEL,
        effort: 'low',
        allowedTools: [],
        mcpServers: [],
        memoryScope: false,
      },
    })
    expect(seen[0]?.agent.character).toContain('“you guys” or “jullie” makes every member eligible')
    expect(seen[0]?.agent.character).toContain('whatever language the user writes')
    const prompt = seen[0]?.catchUp[0]
    expect(prompt?.type === 'user_message' ? prompt.text : '').toContain('Generalist thinker.')
    expect(prompt?.type === 'user_message' ? prompt.text : '').toContain(input.message)
  })

  it('tries the fallback provider after invalid output', async () => {
    const seen: TurnInput[] = []
    const invalid = scripted(() => [{ type: 'result', text: '{"agentIds":["outsider"]}' }], seen)
    const valid = scripted(() => [{ type: 'result', text: '```json\n{"agentIds":["sage"]}\n```' }], seen)
    const route = createGroupTurnRouter({
      attempts: [
        { driver: invalid, runtime: 'codex', model: GROUP_TURN_ROUTER_MODEL },
        { driver: valid, runtime: 'claude', model: 'haiku' },
      ],
      ensureScratchDir: scratchFor,
    })

    await expect(route(input)).resolves.toEqual(['sage'])
    expect(seen.map((turn) => turn.agent.driver)).toEqual(['codex', 'claude'])
  })

  it('stops a hanging provider and falls back at one short total deadline', async () => {
    const events = new AsyncQueue<never>()
    const stop = vi.fn(() => events.close())
    const secondStart = vi.fn()
    const route = createGroupTurnRouter({
      attempts: [
        { driver: { startTurn: () => ({ events, stop }) }, runtime: 'codex', model: GROUP_TURN_ROUTER_MODEL },
        {
          driver: { startTurn: secondStart },
          runtime: 'claude',
          model: 'haiku',
        },
      ],
      ensureScratchDir: scratchFor,
      timeoutMs: 10,
    })

    await expect(route(input)).resolves.toEqual(['marlow'])
    expect(stop).toHaveBeenCalledOnce()
    expect(secondStart).not.toHaveBeenCalled()
  })

  it('preserves the supplied fallback, then the first member, when no runtime can route', async () => {
    const failing = scripted(() => [{ type: 'error', message: 'unavailable' }], [])
    const route = createGroupTurnRouter({
      attempts: [{ driver: failing, runtime: 'codex', model: GROUP_TURN_ROUTER_MODEL }],
      ensureScratchDir: scratchFor,
    })

    await expect(route(input)).resolves.toEqual(['marlow'])
    expect(fallbackGroupTurnRoute({ ...input, fallbackAgentIds: [] })).toEqual(['marlow'])
  })

  it('deduplicates valid ids, drops outsiders and bounds old conversation context', () => {
    expect(parseGroupTurnRoute('{"agentIds":["smith","ghost","smith"]}', input.members)).toEqual(['smith'])
    const transcript = groupTurnTranscript([{
      id: 'evt_1',
      ts: 1,
      type: 'user_message',
      text: 'x'.repeat(GROUP_TURN_ROUTER_CONTEXT_CHARS + 1_000),
      mentions: [],
    }], input.members)
    expect(transcript).toContain('[Earlier group context omitted]')
    expect(transcript.length).toBeLessThanOrEqual(GROUP_TURN_ROUTER_CONTEXT_CHARS + 32)
  })

  it('recognises room-wide greetings without swallowing substantive collective prompts', () => {
    expect(groupGreetingMemberIds('Hey', input.members)).toEqual(['marlow', 'sage', 'smith'])
    expect(groupGreetingMemberIds('Hey guys!', input.members)).toEqual(['marlow', 'sage', 'smith'])
    expect(groupGreetingMemberIds('Hoi allemaal', input.members)).toEqual(['marlow', 'sage', 'smith'])
    expect(groupGreetingMemberIds('Hoi jongens', input.members)).toEqual(['marlow', 'sage', 'smith'])
    expect(groupGreetingMemberIds('Can you guys evaluate Manor?', input.members)).toBeUndefined()
    expect(groupGreetingMemberIds('Kunnen jullie Manor evalueren?', input.members)).toBeUndefined()
  })
})
