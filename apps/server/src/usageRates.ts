import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseRateTable, type RateTable } from './usagePricing.js'

/**
 * LiteLLM's public price table, fetched at most once a day and kept on disk so the
 * Usage view still prices offline. The same source `ccusage` prices
 * against. It is a public JSON document: nothing personal is sent to fetch it.
 */
export const LITELLM_RATES_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'

/** Rates move rarely; a day-old table keeps the page working offline. */
const TTL_MS = 24 * 60 * 60 * 1000
/** A first fetch that hangs must not hold the Usage view hostage. */
const FETCH_TIMEOUT_MS = 8_000

export interface RateSnapshot {
  table: RateTable
  status: 'current' | 'stale' | 'unavailable'
}

interface Options {
  cacheFile: string
  fetch?: typeof fetch
  now?: () => number
}

/**
 * One loader per process. Concurrent first readers share the same fetch, and a
 * failed refresh keeps the last good table (as `stale`) rather than dropping prices.
 */
export function createRateLoader({ cacheFile, fetch: fetchImpl = fetch, now = Date.now }: Options) {
  let held: { table: RateTable; fetchedAt: number } | undefined
  let loadedFromDisk = false
  let inFlight: Promise<RateSnapshot> | undefined

  const readDisk = async () => {
    if (loadedFromDisk) return
    loadedFromDisk = true
    try {
      const parsed = JSON.parse(await readFile(cacheFile, 'utf8')) as { fetchedAt?: unknown; document?: unknown }
      const table = parseRateTable(parsed.document)
      if (typeof parsed.fetchedAt === 'number' && table.size > 0) held = { table, fetchedAt: parsed.fetchedAt }
    } catch {
      // No cache yet, or an unreadable one: the network fetch below decides.
    }
  }

  const refresh = async (): Promise<RateSnapshot> => {
    try {
      const response = await fetchImpl(LITELLM_RATES_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
      const document: unknown = await response.json()
      const table = parseRateTable(document)
      if (table.size === 0) throw new Error('empty rate table')
      held = { table, fetchedAt: now() }
      await mkdir(path.dirname(cacheFile), { recursive: true })
      const temporary = `${cacheFile}.tmp`
      await writeFile(temporary, JSON.stringify({ fetchedAt: held.fetchedAt, document }))
      await rename(temporary, cacheFile)
      return { table, status: 'current' }
    } catch (error) {
      console.warn('[manor] model prices could not be refreshed', error instanceof Error ? error.message : error)
      return held === undefined ? { table: new Map(), status: 'unavailable' } : { table: held.table, status: 'stale' }
    }
  }

  return async (): Promise<RateSnapshot> => {
    await readDisk()
    if (held !== undefined && now() - held.fetchedAt < TTL_MS) return { table: held.table, status: 'current' }
    inFlight ??= refresh().finally(() => {
      inFlight = undefined
    })
    return inFlight
  }
}
