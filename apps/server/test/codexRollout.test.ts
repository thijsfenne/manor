import { mkdtempSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { readRolloutPatches, readRolloutTurn } from '../src/drivers/codexRollout.js'

let home: string

const tokenCount = (tokens: number, timestamp: string): string =>
  JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: tokens * 3 },
        last_token_usage: { input_tokens: tokens, cached_input_tokens: 16_128 },
        model_context_window: 258_400,
      },
    },
  })

const turnContext = (model: string, timestamp: string): string =>
  JSON.stringify({
    timestamp,
    type: 'turn_context',
    payload: { turn_id: 'turn-1', cwd: '/tmp', model, effort: 'medium', summary: 'auto' },
  })

const responseItem = (text: string): string =>
  JSON.stringify({ timestamp: '2026-08-11T08:59:31.000Z', type: 'response_item', payload: { text } })

async function writeRollout(day: string, threadId: string, lines: readonly string[]): Promise<void> {
  const dir = path.join(home, 'sessions', '2026', '08', day)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, `rollout-2026-08-${day}T10-58-08-${threadId}.jsonl`), `${lines.join('\n')}\n`)
}

beforeAll(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'manor-rollout-home-'))
})

describe('readRolloutTurn', () => {
  it('reads the last reading of a thread that spans several days of rollouts', async () => {
    // An older thread in an earlier directory must not shadow the one asked for.
    await writeRollout('09', 'other-thread', [tokenCount(99_000, '2026-08-09T08:00:00.000Z')])
    await writeRollout('11', 'thread-a', [
      tokenCount(17_315, '2026-08-11T08:58:00.000Z'),
      responseItem('a later turn'),
      tokenCount(40_257, '2026-08-11T08:59:30.000Z'),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }),
    ])

    expect(await readRolloutTurn(home, 'thread-a', Date.parse('2026-08-11T08:59:00.000Z'))).toEqual({
      contextTokens: 40_257,
      contextWindow: 258_400,
    })
  })

  it('reuses the known rollout path instead of rescanning newer history', async () => {
    const threadId = 'thread-cached'
    await writeRollout('09', threadId, [tokenCount(17_315, '2026-08-09T08:00:00.000Z')])
    expect((await readRolloutTurn(home, threadId, 0)).contextTokens).toBe(17_315)

    // A duplicate cannot exist in a real Codex home. It makes a rescan observable:
    // newest-first discovery would choose this path, while the cache keeps the
    // original resumed thread pinned to the file Codex is still appending to.
    await writeRollout('12', threadId, [tokenCount(99_000, '2026-08-12T08:00:00.000Z')])
    expect((await readRolloutTurn(home, threadId, 0)).contextTokens).toBe(17_315)
  })

  it('discards a reading written before the turn started', async () => {
    await writeRollout('11', 'thread-stale', [tokenCount(17_315, '2026-08-11T08:58:00.000Z')])

    expect((await readRolloutTurn(home, 'thread-stale', Date.parse('2026-08-11T09:30:00.000Z'))).contextTokens).toBeUndefined()
  })

  it('discards a reading it cannot date, rather than trusting it', async () => {
    const undated = JSON.stringify({
      type: 'event_msg',
      payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 17_315 } } },
    })
    await writeRollout('11', 'thread-undated', [undated])

    expect((await readRolloutTurn(home, 'thread-undated', 0)).contextTokens).toBeUndefined()
  })

  it('gives up rather than reading a whole session history for a buried reading', async () => {
    await writeRollout('11', 'thread-buried', [
      tokenCount(40_257, '2026-08-11T08:59:30.000Z'),
      // One item larger than the tail the scan is willing to read.
      responseItem('x'.repeat(1_100_000)),
    ])

    expect((await readRolloutTurn(home, 'thread-buried', Date.parse('2026-08-11T08:59:00.000Z'))).contextTokens).toBeUndefined()
  })

  /**
   * `codex exec --json` never names the model, so this file is the only place the
   * driver can learn what actually answered — the question a persona cannot be asked,
   * because Manor replaces its whole system prompt and it will guess instead.
   */
  it('reads the model of the turn, alongside its context, from one pass', async () => {
    await writeRollout('11', 'thread-model', [
      turnContext('gpt-5.6-sol', '2026-08-11T08:59:10.000Z'),
      responseItem('the answer'),
      tokenCount(40_257, '2026-08-11T08:59:30.000Z'),
    ])

    expect(await readRolloutTurn(home, 'thread-model', Date.parse('2026-08-11T08:59:00.000Z'))).toEqual({
      contextTokens: 40_257,
      contextWindow: 258_400,
      model: 'gpt-5.6-sol',
      effort: 'medium',
    })
  })

  it('finds a child’s model and effort before more than a megabyte of tool output', async () => {
    await writeRollout('11', 'thread-long-helper', [
      turnContext('gpt-6-sol', '2026-08-11T08:59:10.000Z'),
      responseItem('x'.repeat(1_100_000)),
      tokenCount(40_257, '2026-08-11T08:59:30.000Z'),
    ])

    expect(await readRolloutTurn(home, 'thread-long-helper', Date.parse('2026-08-11T08:59:00.000Z'))).toEqual({
      contextTokens: 40_257,
      contextWindow: 258_400,
      model: 'gpt-6-sol',
      effort: 'medium',
    })
  })

  it('uses the newest model in a long resumed session', async () => {
    await writeRollout('11', 'thread-resumed-helper', [
      turnContext('gpt-5.6-sol', '2026-08-11T08:00:00.000Z'),
      responseItem('old output'.repeat(150_000)),
      turnContext('gpt-6-sol', '2026-08-11T08:59:10.000Z'),
      responseItem('new output'.repeat(150_000)),
      tokenCount(40_257, '2026-08-11T08:59:30.000Z'),
    ])

    expect(await readRolloutTurn(home, 'thread-resumed-helper', Date.parse('2026-08-11T08:59:00.000Z'))).toEqual({
      contextTokens: 40_257,
      contextWindow: 258_400,
      model: 'gpt-6-sol',
      effort: 'medium',
    })
  })

  it('does not borrow a previous turn’s model when a long current turn has none', async () => {
    await writeRollout('11', 'thread-resumed-no-model', [
      turnContext('gpt-5.6-sol', '2026-08-11T08:00:00.000Z'),
      responseItem('new output'.repeat(150_000)),
      tokenCount(40_257, '2026-08-11T08:59:30.000Z'),
    ])

    expect(await readRolloutTurn(home, 'thread-resumed-no-model', Date.parse('2026-08-11T08:59:00.000Z'))).toEqual({
      contextTokens: 40_257,
      contextWindow: 258_400,
    })
  })

  // The two records are written at different points in a turn, so neither may depend
  // on the other being there: a turn that died after starting has only the first.
  it('reports a model with no context reading, and a context reading with no model', async () => {
    await writeRollout('11', 'thread-model-only', [turnContext('gpt-5.6-sol', '2026-08-11T08:59:10.000Z')])
    await writeRollout('11', 'thread-tokens-only', [tokenCount(40_257, '2026-08-11T08:59:30.000Z')])
    const since = Date.parse('2026-08-11T08:59:00.000Z')

    expect(await readRolloutTurn(home, 'thread-model-only', since)).toEqual({ model: 'gpt-5.6-sol', effort: 'medium' })
    expect(await readRolloutTurn(home, 'thread-tokens-only', since)).toEqual({
      contextTokens: 40_257,
      contextWindow: 258_400,
    })
  })

  it('reports tokens without a window when the rollout omitted model_context_window', async () => {
    const line = JSON.stringify({
      timestamp: '2026-08-11T08:59:30.000Z',
      type: 'event_msg',
      payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 40_257 } } },
    })
    await writeRollout('11', 'thread-no-window', [line])

    expect(await readRolloutTurn(home, 'thread-no-window', Date.parse('2026-08-11T08:59:00.000Z'))).toEqual({
      contextTokens: 40_257,
    })
  })

  it('reads the alternate reasoning_effort field when effort is absent', async () => {
    await writeRollout('11', 'thread-effort', [JSON.stringify({
      timestamp: '2026-08-11T08:59:10.000Z', type: 'turn_context',
      payload: { model: 'gpt-6-sol', reasoning_effort: 'high' },
    })])
    expect(await readRolloutTurn(home, 'thread-effort', Date.parse('2026-08-11T08:59:00.000Z'))).toEqual({
      model: 'gpt-6-sol', effort: 'high',
    })
  })

  // A resumed thread keeps every turn it ever ran in one file, so the model of an
  // earlier turn is exactly what a missing freshness check would report as this one's.
  it('discards a model recorded before this turn started', async () => {
    await writeRollout('11', 'thread-old-model', [
      turnContext('gpt-5.6-sol', '2026-08-11T08:00:00.000Z'),
      tokenCount(40_257, '2026-08-11T09:31:00.000Z'),
    ])

    expect(await readRolloutTurn(home, 'thread-old-model', Date.parse('2026-08-11T09:30:00.000Z'))).toEqual({
      contextTokens: 40_257,
      contextWindow: 258_400,
    })
  })

  it('returns nothing for a thread with no rollout, and for a home with no sessions', async () => {
    expect((await readRolloutTurn(home, 'thread-missing', 0)).contextTokens).toBeUndefined()
    expect((await readRolloutTurn(path.join(home, 'nowhere'), 'thread-a', 0)).contextTokens).toBeUndefined()
  })
})

describe('readRolloutPatches', () => {
  it('reads only fresh apply_patch calls and keeps their call identity', async () => {
    const threadId = 'thread-patches'
    const patch = (id: string, timestamp: string, oldLine: string, newLine: string) =>
      JSON.stringify({
        timestamp,
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          call_id: id,
          name: 'exec',
          input: JSON.stringify({
            cmd: `*** Begin Patch\n*** Update File: /tmp/notes.md\n-${oldLine}\n+${newLine}\n*** End Patch`,
          }),
        },
      })
    await writeRollout('12', threadId, [
      patch('old-call', '2026-08-12T08:00:00.000Z', 'old', 'stale'),
      patch('fresh-call', '2026-08-12T09:30:10.000Z', 'before', 'after'),
    ])

    expect(await readRolloutPatches(home, threadId, Date.parse('2026-08-12T09:30:00.000Z'))).toEqual([
      {
        id: 'fresh-call',
        edits: [{ path: '/tmp/notes.md', before: 'before\n', after: 'after\n' }],
      },
    ])
  })
})
