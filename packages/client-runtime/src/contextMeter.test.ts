import { SINGLE_CHAT_VOICE, type AgentConfig, type ThreadEvent } from '@manor/contracts'
import { describe, expect, it } from 'vitest'
import {
  compactContextTokens,
  contextBreakdown,
  contextProvenance,
  latestSessionContext,
  latestSessionContextTokens,
  liveSessionContext,
  readContextMeter,
  singleWorkContext,
} from './contextMeter'
import { LIVE_COMPACT_DONE } from './turnTrace'

const estimate = { instructions: 4_000, memory: 1_000, skills: 500, mcpCatalog: 8_000, unmeasuredMcpServers: 1 }

const result = (
  agentId: string,
  contextTokens?: number,
  id = 'r1',
  contextWindow?: number,
): Extract<ThreadEvent, { type: 'turn_result' }> => ({
  id,
  ts: 1,
  type: 'turn_result',
  agentId,
  turnId: id,
  ...(contextTokens === undefined ? {} : { contextTokens }),
  ...(contextWindow === undefined ? {} : { contextWindow }),
})

const compacted = (id = 'c1'): ThreadEvent => ({
  id,
  ts: 1,
  type: 'system_note',
  kind: 'info',
  text: LIVE_COMPACT_DONE,
  agentId: SINGLE_CHAT_VOICE.id,
})

const agent = (id: string, driver: AgentConfig['driver'], model: string): AgentConfig =>
  ({
    id,
    name: id,
    color: '#8b5cf6',
    character: '',
    driver,
    model,
    effort: 'high',
    allowedTools: [],
    mcpServers: [],
    memoryScope: false,
    description: '',
    role: '',
    isCos: true,
  }) as AgentConfig

describe('compactContextTokens', () => {
  it('uses short counts', () => {
    expect(compactContextTokens(440)).toBe('440')
    expect(compactContextTokens(4_400)).toBe('4.4k')
    expect(compactContextTokens(44_000)).toBe('44k')
    expect(compactContextTokens(258_000)).toBe('258k')
    expect(compactContextTokens(1_000_000)).toBe('1m')
  })
})

describe('latestSessionContextTokens', () => {
  it('keeps the last Single Work report and ignores other personas', () => {
    expect(
      latestSessionContextTokens([
        result('sage', 12_000),
        result(SINGLE_CHAT_VOICE.id, 40_000, 'a'),
        result(SINGLE_CHAT_VOICE.id, undefined, 'b'),
        result(SINGLE_CHAT_VOICE.id, 44_000, 'c'),
      ]),
    ).toBe(44_000)
  })

  it('is empty before any turn reports a window fill', () => {
    expect(latestSessionContextTokens([])).toBeUndefined()
    expect(latestSessionContextTokens([result(SINGLE_CHAT_VOICE.id)])).toBeUndefined()
  })

  it('forgets the fill after a successful live compact until the next reading', () => {
    expect(
      latestSessionContextTokens([
        result(SINGLE_CHAT_VOICE.id, 232_200, 'a'),
        compacted(),
      ]),
    ).toBeUndefined()
    expect(
      latestSessionContextTokens([
        result(SINGLE_CHAT_VOICE.id, 232_200, 'a'),
        compacted(),
        result(SINGLE_CHAT_VOICE.id, 12_000, 'b'),
      ]),
    ).toBe(12_000)
  })
})

describe('readContextMeter', () => {
  it('stays empty and calm before the first report', () => {
    const meter = readContextMeter(undefined, 258_000)
    expect(meter.fraction).toBe(0)
    expect(meter.percent).toBe(0)
    expect(meter.usedLabel).toBeNull()
    expect(meter.windowLabel).toBe('258k')
    expect(meter.warns).toBe(false)
    // An empty dial and an unreported one both compute to 0; only this separates them.
    expect(meter.reported).toBe(false)
    expect(readContextMeter(0, 258_000).reported).toBe(true)
  })

  it('warns at the live compact line, not earlier', () => {
    expect(readContextMeter(232_199, 258_000).warns).toBe(false)
    expect(readContextMeter(232_200, 258_000).warns).toBe(true)
  })

  it('measures a Claude session against its compaction threshold, not its catalog window', () => {
    const claude = { ...estimate, autoCompactAt: { source: 'measured', tokens: 300_000 } } as const
    const meter = readContextMeter(150_000, 1_000_000, claude)
    // 15% of the 1m window, half of the 300k the CLI actually compacts at.
    expect(meter.percent).toBe(50)
    expect(meter.limitLabel).toBe('300k')
    expect(meter.limitIsCompact).toBe(true)
    // The window line still has its own number; only the denominator moved.
    expect(meter.windowLabel).toBe('1m')
    expect(meter.warns).toBe(false)
    expect(readContextMeter(270_000, 1_000_000, claude).warns).toBe(true)
    // A fill past the threshold fills the dial rather than overflowing it.
    expect(readContextMeter(400_000, 1_000_000, claude).fraction).toBe(1)
  })

  it('keeps the window wherever no threshold was measured', () => {
    const unknown = readContextMeter(129_000, 258_000, { ...estimate, autoCompactAt: { source: 'unknown' } })
    expect(unknown.percent).toBe(50)
    expect(unknown.limitLabel).toBe('258k')
    expect(unknown.limitIsCompact).toBe(false)
    // A threshold at or above the window is no limit, and an absent estimate changes nothing.
    expect(readContextMeter(129_000, 258_000, { ...estimate, autoCompactAt: { source: 'measured', tokens: 258_000 } }).limitIsCompact).toBe(false)
    expect(readContextMeter(129_000, 258_000).percent).toBe(50)
  })
})

describe('contextProvenance', () => {
  it('tells a provider reading apart from a catalog window and from nothing at all', () => {
    const read = contextProvenance({
      ...estimate,
      used: { source: 'measured', tokens: 120_000 },
      window: { source: 'estimated', tokens: 1_000_000 },
      autoCompactAt: { source: 'unknown' },
    })
    expect(read.used).toEqual({ source: 'measured', tokens: '120k' })
    expect(read.window).toEqual({ source: 'estimated', tokens: '1m' })
    // Unknown carries no number, so no surface can print one by accident.
    expect(read.autoCompactAt).toEqual({ source: 'unknown', tokens: null })
  })

  it('leaves every figure absent when a turn carried no provenance', () => {
    expect(contextProvenance(estimate)).toEqual({ used: undefined, window: undefined, autoCompactAt: undefined })
    expect(contextProvenance(undefined).used).toBeUndefined()
  })
})

describe('singleWorkContext', () => {
  it('lets a running turn’s live reading win, and empties the dial after a compaction that named no size', () => {
    const before: ThreadEvent = { ...result(SINGLE_CHAT_VOICE.id, 120_000), contextEstimate: estimate }
    const override = { driver: 'codex' as const, model: 'gpt-5.6-sol' }
    const agents = [agent('sage', 'claude', 'claude-opus-5')]
    const live = singleWorkContext([before], override, agents, { contextTokens: 180_000, contextWindow: 258_400, compacting: false })
    expect(live).toMatchObject({ used: 180_000, window: 258_400 })
    expect(contextProvenance(live.estimate).used).toEqual({ source: 'measured', tokens: '180k' })
    expect(singleWorkContext([before], override, agents, { contextTokens: 38_000, compacting: false, compacted: true }).used).toBe(38_000)
    const emptied = singleWorkContext([before], override, agents, { compacting: false, compacted: true })
    expect(emptied.used).toBeUndefined()
    expect(readContextMeter(emptied.used, emptied.window, emptied.estimate).reported).toBe(false)
    // Compacting before the turn's first reading changes nothing yet.
    expect(singleWorkContext([before], override, agents, { compacting: true }).used).toBe(120_000)
  })

  it('scales a fresh Claude session’s first live reading by its threshold, as the settled turn will', () => {
    const override = { driver: 'claude' as const, model: 'claude-opus-5' }
    const agents = [agent('sage', 'claude', 'claude-opus-5')]
    const live = singleWorkContext([], override, agents, { contextTokens: 250_000, autoCompactTokens: 300_000, compacting: false })
    const meter = readContextMeter(live.used, live.window, live.estimate)
    expect(meter).toMatchObject({ percent: 83, limitLabel: '300k', limitIsCompact: true })
    expect(contextProvenance(live.estimate).autoCompactAt).toEqual({ source: 'measured', tokens: '300k' })
    // Nothing Manor sized yet, so no split that would call all of it Messages.
    expect(contextBreakdown(live.used, live.estimate, meter.limit)).toBeUndefined()
  })

  it('reads the live state of the Single voice’s running turn only', () => {
    const running = { turnId: 't', messages: [], state: 'running' as const, startedAt: 1, context: { contextTokens: 9, compacting: false } }
    expect(liveSessionContext([{ ...running, agentId: SINGLE_CHAT_VOICE.id }])).toEqual(running.context)
    expect(liveSessionContext([{ ...running, agentId: 'sage' }])).toBeUndefined()
    expect(liveSessionContext([{ ...running, agentId: SINGLE_CHAT_VOICE.id, state: 'done' }])).toBeUndefined()
  })

  it('carries only the selected persona’s latest estimate and clears it on compact', () => {
    const measured: ThreadEvent = { ...result(SINGLE_CHAT_VOICE.id, 10_000), contextEstimate: estimate }
    expect(latestSessionContext([measured, result('sage', 90_000)]).estimate).toEqual(estimate)
    expect(latestSessionContext([measured, compacted()])).toEqual({})
    expect(latestSessionContext([measured, result(SINGLE_CHAT_VOICE.id, 1_000)]).estimate).toBeUndefined()
  })

  it('never combines a new estimate with an older provider total', () => {
    const unreported: ThreadEvent = { ...result(SINGLE_CHAT_VOICE.id), contextEstimate: estimate }
    expect(latestSessionContext([result(SINGLE_CHAT_VOICE.id, 99_000), unreported])).toEqual({ estimate })
  })
  it('reads the pinned model window and the last Single Work fill', () => {
    const meter = singleWorkContext(
      [result(SINGLE_CHAT_VOICE.id, 44_000)],
      { driver: 'codex', model: 'gpt-5.6-sol' },
      [agent('sage', 'claude', 'claude-opus-5')],
    )
    expect(meter.used).toBe(44_000)
    expect(meter.window).toBe(258_000)
  })

  it('prefers the CLI-reported window over the catalog', () => {
    const meter = singleWorkContext(
      [result(SINGLE_CHAT_VOICE.id, 44_000, 'r1', 258_400)],
      { driver: 'codex', model: 'gpt-5.6-sol' },
      [agent('sage', 'claude', 'claude-opus-5')],
    )
    expect(meter.used).toBe(44_000)
    expect(meter.window).toBe(258_400)
  })
})

describe('contextBreakdown', () => {
  it('adds up to the measured total with the remainder as Messages and hides empty rows', () => {
    const breakdown = contextBreakdown(30_000, { ...estimate, skills: 0 }, 60_000)
    expect(breakdown?.rows).toEqual([
      { key: 'messages', tokens: '17k', percent: '28.3%', share: 17_000 / 60_000 },
      { key: 'mcp', tokens: '8k', percent: '13.3%', share: 8_000 / 60_000 },
      { key: 'memory', tokens: '1k', percent: '1.7%', share: 1_000 / 60_000 },
      { key: 'instructions', tokens: '4k', percent: '6.7%', share: 4_000 / 60_000 },
    ])
    expect(breakdown?.unmeasuredMcpServers).toBe(1)
  })

  it('shrinks oversized estimates to the measured total instead of inventing negative Messages', () => {
    const rows = contextBreakdown(10_000, estimate, 100_000)?.rows ?? []
    expect(rows.map((row) => row.key)).toEqual(['mcp', 'memory', 'instructions', 'skills'])
    expect(rows.reduce((sum, row) => sum + row.share, 0)).toBeCloseTo(0.1, 2)
  })

  it('shows sized rows without percentages or Messages when no total was measured', () => {
    const rows = contextBreakdown(undefined, estimate)?.rows ?? []
    expect(rows.map((row) => row.key)).toEqual(['mcp', 'memory', 'instructions', 'skills'])
    expect(rows.every((row) => row.percent === null && row.share === 0)).toBe(true)
    expect(contextBreakdown(10_000, undefined)).toBeUndefined()
  })

  it('treats a measured zero as an empty window, not as a missing reading', () => {
    expect(contextBreakdown(0, estimate, 100_000)?.rows).toEqual([])
  })

  it('keeps whole tokens adding up to the total after shrinking, and percents on the dial limit', () => {
    const tiny = { instructions: 1, memory: 1, skills: 1, mcpCatalog: 0, unmeasuredMcpServers: 0 }
    const rows = contextBreakdown(2, tiny, 100)?.rows ?? []
    expect(rows.map((row) => row.tokens)).toEqual(['1', '1'])

    // 150k in a 100k dial: a 50k category is half the dial's limit, and the bar still fits.
    const over = contextBreakdown(150_000, { ...estimate, mcpCatalog: 50_000 }, 100_000)?.rows ?? []
    const mcp = over.find((row) => row.key === 'mcp')
    expect(mcp?.percent).toBe('50.0%')
    expect(over.reduce((sum, row) => sum + row.share, 0)).toBeCloseTo(1, 5)
  })
})
