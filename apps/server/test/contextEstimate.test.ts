import { describe, expect, it } from 'vitest'
import { ContextEstimateSchema, type AgentConfig, type AttachedMcpServer } from '@manor/contracts'
import { estimateContext } from '../src/contextEstimate.js'

const blocks = { driver: 'claude', character: '', memory: '', skillChars: 0, mcpServers: [] } as const

const attached = (name: string, tools: string[], schemaChars = 250_000, disabledTools: string[] = [], id = name): AttachedMcpServer => ({
  server: { id, name, tools, schemaChars } as AttachedMcpServer['server'],
  disabledTools,
})

describe('context estimates', () => {
  it('separates supplied instructions, retrieved memory and selected skills', () => {
    expect(estimateContext({
      ...blocks,
      driver: 'mock',
      character: 'i'.repeat(80) + 'm'.repeat(40) + 's'.repeat(20),
      memory: 'm'.repeat(40), skillChars: 20, mcpServers: [],
    })).toEqual({ instructions: 20, memory: 10, skills: 5, mcpCatalog: 0, unmeasuredMcpServers: 0 })
  })

  // One 74k-character Manor prompt measured 27.7k tokens on Opus 5.5, 20.0k on Grok 4.7
  // and 17.4k on GPT 6.1 Sol, so a single chars/4 rule undercounted Claude by a third.
  it('counts supplied text at the measured rate of the model that read it', () => {
    const prompt = { ...blocks, character: 'x'.repeat(74_149) }
    const instructions = (driver: AgentConfig['driver'], model?: string) =>
      estimateContext({ ...prompt, driver, reported: { model } }).instructions
    expect(instructions('claude', 'claude-opus-5-5')).toBeCloseTo(27_500, -3)
    expect(instructions('grok', 'grok-4.7')).toBeCloseTo(20_000, -3)
    expect(instructions('codex', 'gpt-6.1-sol')).toBeCloseTo(17_400, -3)
    // Cursor reads with whichever model it runs.
    expect(instructions('cursor', 'cursor-claude-opus-5-5')).toBe(instructions('claude', 'claude-opus-5-5'))
    expect(instructions('cursor', 'composer-2.5')).toBe(instructions('codex', 'gpt-6.1-sol'))
    expect(instructions('cursor', 'gemini-3.7-flash-high')).toBeCloseTo(18_500, -3)
    // A Claude turn with no model on record still reads as Claude.
    expect(estimateContext(prompt).instructions).toBe(instructions('claude', 'claude-opus-5-5'))
  })

  it('rejects invalid counts at the wire boundary', () => {
    const estimate = estimateContext(blocks)
    expect(ContextEstimateSchema.safeParse(estimate).success).toBe(true)
    expect(ContextEstimateSchema.safeParse({ ...estimate, memory: -1 }).success).toBe(false)
    expect(ContextEstimateSchema.safeParse({ ...estimate, instructions: Infinity }).success).toBe(false)
  })
})

describe('reported window figures', () => {
  it('marks Codex fill and window as measured, since the CLI names both', () => {
    const estimate = estimateContext({
      ...blocks,
      driver: 'codex',
      reported: { model: 'gpt-5.6-sol', contextTokens: 44_000, contextWindow: 272_000 },
    })
    expect(estimate.used).toEqual({ source: 'measured', tokens: 44_000 })
    expect(estimate.window).toEqual({ source: 'measured', tokens: 272_000 })
    // Codex publishes no compaction threshold, so there is nothing to claim.
    expect(estimate.autoCompactAt).toEqual({ source: 'unknown' })
    expect(ContextEstimateSchema.safeParse(estimate).success).toBe(true)
  })

  it('keeps a Claude window on the catalog estimate while its fill stays measured', () => {
    const estimate = estimateContext({
      ...blocks,
      reported: { model: 'claude-opus-5', contextTokens: 120_000, autoCompactTokens: 300_000 },
    })
    expect(estimate.used).toEqual({ source: 'measured', tokens: 120_000 })
    expect(estimate.window).toEqual({ source: 'estimated', tokens: 1_000_000 })
    expect(estimate.autoCompactAt).toEqual({ source: 'measured', tokens: 300_000 })
  })

  // Cursor reports nothing on any turn that used a tool, and mock reports nothing at all.
  it('reports an unknown fill rather than a zero when a driver measures nothing', () => {
    for (const driver of ['cursor', 'mock'] as const) {
      const estimate = estimateContext({ ...blocks, driver, reported: { model: undefined } })
      expect(estimate.used).toEqual({ source: 'unknown' })
      expect(estimate.autoCompactAt).toEqual({ source: 'unknown' })
      // A denominator is still useful, but it is named as the guess it is.
      expect(estimate.window?.source).toBe('estimated')
      expect(ContextEstimateSchema.safeParse(estimate).success).toBe(true)
    }
  })

  it('leaves the figures off entirely for callers with no turn to report', () => {
    const estimate = estimateContext(blocks)
    expect(estimate.used).toBeUndefined()
    expect(estimate.window).toBeUndefined()
    expect(estimate.autoCompactAt).toBeUndefined()
  })

  it('refuses a measured figure without a number at the wire boundary', () => {
    const estimate = estimateContext(blocks)
    expect(ContextEstimateSchema.safeParse({ ...estimate, used: { source: 'measured' } }).success).toBe(false)
    expect(ContextEstimateSchema.safeParse({ ...estimate, window: { source: 'estimated', tokens: -1 } }).success).toBe(false)
  })
})

describe('MCP tools in the window', () => {
  // Registered connectors with 250k chars of schemas each, which no CLI loads up front.
  const servers = [
    attached('supabase', ['execute_sql', 'list_tables']),
    attached('figma', ['get_design_context']),
    attached('skills', ['read_skill'], 0, []),
  ]
  const manor = attached('manor', ['ask_user', 'goal_reached'], 0, [], 'builtin_manor')
  const mcp = (driver: AgentConfig['driver'], mcpServers: readonly AttachedMcpServer[]) =>
    estimateContext({ ...blocks, driver, mcpServers }).mcpCatalog

  it('counts the listed names, never the registered schemas', () => {
    for (const driver of ['claude', 'cursor'] as const) {
      // Four names of about 30 characters, a few dozen tokens against 750k chars of schemas.
      expect(mcp(driver, servers)).toBeGreaterThan(30)
      expect(mcp(driver, servers)).toBeLessThan(120)
    }
  })

  it("adds Manor's inline schemas on Claude and the search gateway on Grok", () => {
    expect(mcp('claude', [...servers, manor])).toBe(mcp('claude', servers) + 2 * 590)
    expect(mcp('grok', servers)).toBe(mcp('cursor', servers) + 2_100)
    // Elsewhere Manor's own tools are listed like any other.
    expect(mcp('cursor', [...servers, manor])).toBeGreaterThan(mcp('cursor', servers))
    expect(mcp('cursor', [...servers, manor])).toBeLessThan(mcp('cursor', servers) + 100)
  })

  // Codex code mode measured the same to the token with and without a 56-tool server.
  it('gives Codex and mock no MCP figure, and Grok none without a connector', () => {
    expect(mcp('codex', [...servers, manor])).toBe(0)
    expect(mcp('mock', [...servers, manor])).toBe(0)
    expect(mcp('grok', [])).toBe(0)
  })

  it('leaves a disabled tool off the list', () => {
    const all = estimateContext({ ...blocks, mcpServers: [attached('supabase', ['execute_sql', 'list_tables'])] })
    const some = estimateContext({ ...blocks, mcpServers: [attached('supabase', ['execute_sql', 'list_tables'], 250_000, ['list_tables'])] })
    expect(some.mcpCatalog).toBeLessThan(all.mcpCatalog)
  })

  it('flags connections with no tool list', () => {
    expect(estimateContext({ ...blocks, mcpServers: [attached('new', [], 0)] }).unmeasuredMcpServers).toBe(1)
  })
})
