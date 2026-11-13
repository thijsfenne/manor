import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { lookupRate, parseRateTable } from '../src/usagePricing.js'
import { createRateLoader } from '../src/usageRates.js'

describe('model rate table', () => {
  it('drops half-priced entries and prices omitted cache rates as plain input', () => {
    const table = parseRateTable({
      'half': { input_cost_per_token: 1e-6 },
      'whole': { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 },
    })
    expect(table.has('half')).toBe(false)
    expect(table.get('whole')).toMatchObject({ cacheRead: 1e-6, cacheWrite: 1e-6 })
  })

  it('aliases a bare name only when every qualified entry agrees on it', () => {
    const table = parseRateTable({
      'openai/gpt-x': { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 },
      'azure/gpt-x': { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 },
      'openai/gpt-y': { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 },
      'azure/gpt-y': { input_cost_per_token: 3e-6, output_cost_per_token: 2e-6 },
    })
    expect(lookupRate(table, 'gpt-x')).not.toBeNull()
    expect(lookupRate(table, 'gpt-y')).toBeNull()
  })

  it('prices a variant at its base tier and never a bare family name', () => {
    const table = parseRateTable({
      'claude-fable-5-1': { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 },
      'opus': { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 },
    })
    expect(lookupRate(table, 'claude-fable-5-1[1m]')).not.toBeNull()
    expect(lookupRate(table, 'opus')).toBeNull()
  })
})

describe('rate loader', () => {
  const document = { 'gpt-x': { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 } }

  it('caches a fetched table and keeps it as stale when a later refresh fails', async () => {
    const cacheFile = path.join(await mkdtemp(path.join(os.tmpdir(), 'manor-rates-')), 'rates.json')
    let clock = 0
    let online = true
    const load = createRateLoader({
      cacheFile,
      now: () => clock,
      fetch: async () => {
        if (!online) throw new Error('offline')
        return new Response(JSON.stringify(document))
      },
    })
    expect((await load()).status).toBe('current')
    expect(JSON.parse(await readFile(cacheFile, 'utf8'))).toMatchObject({ fetchedAt: 0, document })
    online = false
    clock = 25 * 60 * 60 * 1000
    const later = await load()
    expect(later.status).toBe('stale')
    expect(lookupRate(later.table, 'gpt-x')).not.toBeNull()
  })

  it('reports prices unavailable with no cache and no network', async () => {
    const cacheFile = path.join(await mkdtemp(path.join(os.tmpdir(), 'manor-rates-')), 'rates.json')
    const load = createRateLoader({ cacheFile, fetch: async () => { throw new Error('offline') } })
    expect(await load()).toMatchObject({ status: 'unavailable' })
  })
})
