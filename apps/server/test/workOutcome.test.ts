import type { TurnInput } from '@manor/contracts'
import { describe, expect, it } from 'vitest'
import { WORK_OUTCOME_FALLBACK_MODEL, WORK_OUTCOME_MODEL, createWorkOutcomeGenerator } from '../src/workOutcome.js'
import { scratchFor, scripted } from './helpers.js'

describe('Work outcome writer', () => {
  it('asks for the conclusion alone on the first line and returns the reply as written', async () => {
    const seen: TurnInput[] = []
    const reply = 'Kept per-agent memory beside the shared layer.\nA pause switch is still open.'
    const generate = createWorkOutcomeGenerator({
      attempts: [{ driver: scripted(() => [{ type: 'result', text: reply }], seen), runtime: 'claude', model: WORK_OUTCOME_MODEL }],
      ensureScratchDir: scratchFor,
    })

    await expect(generate({ chatId: 'work_1', title: 'Memory', context: 'transcript' })).resolves.toBe(reply)
    // The cards bold the first line; this is the instruction that makes it the conclusion.
    expect(seen[0]?.agent.character).toContain('conclusion alone on the first line')
  })

  it('runs on Haiku 5.5 with no tools and no MCP, and falls back to Luna', async () => {
    const seen: TurnInput[] = []
    const generate = createWorkOutcomeGenerator({
      attempts: [
        { driver: scripted(() => [{ type: 'error', message: 'provider unavailable' }], seen), runtime: 'claude', model: WORK_OUTCOME_MODEL },
        { driver: scripted(() => [{ type: 'result', text: 'Done.' }], seen), runtime: 'codex', model: WORK_OUTCOME_FALLBACK_MODEL },
      ],
      ensureScratchDir: scratchFor,
    })

    await expect(generate({ chatId: 'work_1', title: 'Memory', context: 'transcript' })).resolves.toBe('Done.')
    expect(seen.map((input) => input.agent.model)).toEqual(['claude-haiku-5-5', 'gpt-6-luna'])
  })
})
