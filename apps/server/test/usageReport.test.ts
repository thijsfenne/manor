import { describe, expect, it } from 'vitest'
import type { ThreadEvent, Usage } from '@manor/contracts'
import { providerOf, shiftDay, usageReportFromRuns, usageRunsFrom } from '../src/usageReport.js'
import { parseRateTable } from '../src/usagePricing.js'
import type { RateSnapshot } from '../src/usageRates.js'

/**
 * The Usage view's aggregate, tested against the shapes the live transcript actually
 * holds: turn ids shared across personas, legacy usage on `agent_message`, Claude
 * turns that price themselves and Codex turns that do not.
 */

let seq = 0
const stamp = (event: Record<string, unknown>, ts: number) =>
  ({ id: `e${String((seq += 1))}`, ts, ...event }) as unknown as ThreadEvent

const split = (fresh: number, write: number, read: number) => ({
  freshInputTokens: fresh, cacheWrite5mTokens: write, cacheWrite1hTokens: 0, cacheReadTokens: read,
  apiPricedInputEquivalent: 0,
})

const result = (turnId: string, agentId: string, ts: number, usage: Usage, extra: Record<string, unknown> = {}) =>
  stamp({ type: 'turn_result', agentId, turnId, usage, ...extra }, ts)

// 8 October 2026, 14:00 in Amsterdam.
const NOW = Date.UTC(2026, 9, 8, 12, 0)
const ZONE = 'Europe/Amsterdam'
const noPrices: RateSnapshot = { table: new Map(), status: 'unavailable' }
const prices: RateSnapshot = {
  status: 'current',
  table: parseRateTable({
    'gpt-5.6-sol': { input_cost_per_token: 2e-6, output_cost_per_token: 10e-6, cache_read_input_token_cost: 0.2e-6 },
    'claude-opus-5-5': { input_cost_per_token: 5e-6, output_cost_per_token: 25e-6, cache_read_input_token_cost: 0.5e-6 },
  }),
}

const report = (byChat: Record<string, ThreadEvent[]>, rates = noPrices, windowDays: 7 | 30 | 90 = 7) =>
  usageReportFromRuns(usageRunsFrom(new Map(Object.entries(byChat))), { windowDays, timeZone: ZONE, now: NOW, rates })

describe('usage report', () => {
  it('is an empty window with dates in an empty house', () => {
    expect(report({})).toEqual({
      windowDays: 7, timeZone: ZONE, since: '2026-10-02', until: '2026-10-08',
      rows: [], sessions: 0, prices: 'unavailable',
    })
  })

  // A delegated turn carries the id of the turn that delegated it, so on the live
  // database Marlow once gained 4,3M input tokens that were Smith's.
  it('keeps two personas sharing one turn id apart', () => {
    const runs = usageRunsFrom(new Map([['c1', [
      result('turn_3', 'marlow', NOW, { inputTokens: 1_000, outputTokens: 100 }),
      result('turn_3', 'smith', NOW, { inputTokens: 9_000, outputTokens: 400 }),
    ]]]))
    expect(runs.map((run) => [run.agentId, run.inputTokens])).toEqual([['marlow', 1_000], ['smith', 9_000]])
  })

  it('sums legacy usage on an agent_message with the result of the same run', () => {
    const [run] = usageRunsFrom(new Map([['c1', [
      stamp({ type: 'agent_message', agentId: 'sage', turnId: 't1', text: 'a', usage: { inputTokens: 300, outputTokens: 30 } }, NOW),
      result('t1', 'sage', NOW + 1, { inputTokens: 200, outputTokens: 20 }),
    ]]]))
    expect(run).toMatchObject({ inputTokens: 500, outputTokens: 50, reported: true })
  })

  it('leaves out runs that never reported usage and days outside the window', () => {
    const day = 86_400_000
    const { rows } = report({
      c1: [
        stamp({ type: 'turn_result', agentId: 'sage', turnId: 't0', driver: 'claude' }, NOW),
        result('t1', 'sage', NOW - 7 * day, { inputTokens: 1, outputTokens: 1, costUsd: 1 }),
        result('t2', 'sage', NOW - 6 * day, { inputTokens: 2, outputTokens: 2, costUsd: 1 }),
      ],
    })
    expect(rows.map((row) => [row.day, row.inputTokens])).toEqual([['2026-10-02', 2]])
  })

  // 23:30 UTC is already the next day in Amsterdam: days break at the client's midnight.
  it('buckets by day in the asked time zone', () => {
    const lateUtc = Date.UTC(2026, 9, 7, 22, 30)
    const { rows } = report({ c1: [result('t1', 'sage', lateUtc, { inputTokens: 5, outputTokens: 1, costUsd: 0.1 })] })
    expect(rows[0]?.day).toBe('2026-10-08')
  })

  it('credits a run to its driver, else its model, else Claude when it priced itself', () => {
    expect(providerOf({ driver: 'codex', reportedModel: 'claude-opus-5-5', costUsd: null })).toBe('codex')
    expect(providerOf({ reportedModel: 'gpt-5.6-sol', costUsd: null })).toBe('codex')
    expect(providerOf({ reportedModel: 'claude-opus-5-5[1m]', costUsd: null })).toBe('claude')
    expect(providerOf({ reportedModel: undefined, costUsd: 0.4 })).toBe('claude')
    expect(providerOf({ reportedModel: undefined, costUsd: null })).toBe('unknown')
  })

  it('keeps a provider-reported cost and prices a split Codex turn at list rates', () => {
    const { rows } = report({
      c1: [result('t1', 'sage', NOW, { inputTokens: 120, outputTokens: 10, costUsd: 0.5, breakdown: split(20, 0, 100) },
        { driver: 'claude', reportedModel: 'claude-opus-5-5' })],
      c2: [result('t1', 'smith', NOW, { inputTokens: 1_000, outputTokens: 100, breakdown: split(200, 0, 800) },
        { driver: 'codex', reportedModel: 'gpt-5.6-sol' })],
    }, prices)
    const claude = rows.find((row) => row.provider === 'claude')
    const codex = rows.find((row) => row.provider === 'codex')
    expect(claude).toMatchObject({ costUsd: 0.5, providerReportedResponses: 1, cachedInputTokens: 100 })
    // 200 fresh at $2/M, 800 cached at $0.2/M, 100 output at $10/M.
    expect(codex?.costUsd).toBeCloseTo(200 * 2e-6 + 800 * 0.2e-6 + 100 * 10e-6, 12)
    expect(codex).toMatchObject({ modelPricedResponses: 1, unpricedResponses: 0, observedInputTokens: 1_000 })
    expect(codex?.cacheSavingsUsd).toBeCloseTo(800 * (2e-6 - 0.2e-6), 12)
  })

  // An input total that may be mostly cache reads, priced as fresh input, would
  // overstate the cost several times over.
  it('leaves a turn without a cache split unpriced rather than guessing', () => {
    const { rows } = report({
      c1: [result('t1', 'smith', NOW, { inputTokens: 1_000, outputTokens: 100 }, { driver: 'codex', reportedModel: 'gpt-5.6-sol' })],
    }, prices)
    expect(rows[0]).toMatchObject({ costUsd: 0, unpricedResponses: 1, unpricedTokens: 1_100, observedInputTokens: 0 })
  })

  it('drops a run\'s split once one of its usage events lacks it', () => {
    const [run] = usageRunsFrom(new Map([['c1', [
      stamp({ type: 'agent_message', agentId: 'sage', turnId: 't1', text: 'a', usage: { inputTokens: 50, outputTokens: 1 } }, NOW),
      result('t1', 'sage', NOW, { inputTokens: 100, outputTokens: 1, breakdown: split(10, 0, 90) }),
    ]]]))
    expect(run?.split).toBeNull()
  })

  it('counts distinct chats across providers', () => {
    const turn = (turnId: string, driver: string) =>
      result(turnId, 'sage', NOW, { inputTokens: 1, outputTokens: 1 }, { driver })
    const { sessions } = report({
      c1: [turn('t1', 'claude'), turn('t2', 'claude'), turn('t3', 'codex')],
      c2: [turn('t1', 'claude')],
    })
    expect(sessions).toBe(2)
  })

  it('shifts calendar days across a month end', () => {
    expect(shiftDay('2026-10-01', -1)).toBe('2026-09-30')
    expect(shiftDay('2026-10-08', -89)).toBe('2026-07-11')
  })
})
