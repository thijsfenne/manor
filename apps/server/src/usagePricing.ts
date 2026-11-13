/**
 * What a turn would have cost at API list prices.
 *
 * The prices come from LiteLLM's public `model_prices_and_context_window.json`: one
 * entry per model name, with a USD price per token for input, output, a cache read
 * and a cache write. This module turns that document into a price list and prices a
 * turn against it. It reads no file and no network; `usageRates.ts` does that.
 *
 * Manor records neither the request speed nor a discount, so every turn is priced at
 * the standard tier.
 */

/** USD per token for one model. */
export interface ModelRate {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

export type RateTable = ReadonlyMap<string, ModelRate>

/** `Provider/Model-Name[1m] ` as the list spells it: lower case, no tier suffix. */
const listName = (model: string): string => model.trim().toLowerCase().replace(/\[[^\]]*\]$/, '')

/** The part after the last slash: `openai/gpt-x` is also asked for as `gpt-x`. */
const shortName = (name: string): string => name.slice(name.lastIndexOf('/') + 1)

const price = (entry: Record<string, unknown>, field: string): number | undefined => {
  const value = entry[field]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

const equalRates = (a: ModelRate, b: ModelRate): boolean =>
  a.input === b.input && a.output === b.output && a.cacheRead === b.cacheRead && a.cacheWrite === b.cacheWrite

/**
 * The price list in LiteLLM's document.
 *
 * An entry needs both an input and an output price: with one of the two missing the
 * model would be priced at half its cost without anybody noticing, so it is left out.
 * A cache price the entry does not state counts as the input price, never as free.
 *
 * Drivers report a model without its vendor prefix, so a short name is added for
 * every prefixed entry, unless the list has that short name itself or two vendors
 * list the model at different prices. Then nobody can say which price was paid.
 */
export function parseRateTable(document: unknown): RateTable {
  const rates = new Map<string, ModelRate>()
  if (typeof document !== 'object' || document === null) return rates
  for (const [name, value] of Object.entries(document)) {
    if (typeof value !== 'object' || value === null) continue
    const entry = value as Record<string, unknown>
    const input = price(entry, 'input_cost_per_token')
    const output = price(entry, 'output_cost_per_token')
    const key = name.trim().toLowerCase()
    if (input === undefined || output === undefined || key === '') continue
    rates.set(key, {
      input,
      output,
      cacheRead: price(entry, 'cache_read_input_token_cost') ?? input,
      cacheWrite: price(entry, 'cache_creation_input_token_cost') ?? input,
    })
  }

  const byShortName = new Map<string, ModelRate[]>()
  for (const [name, rate] of rates) {
    const short = shortName(name)
    if (short === '' || short === name) continue
    byShortName.set(short, [...(byShortName.get(short) ?? []), rate])
  }
  for (const [short, listed] of byShortName) {
    const first = listed[0]
    if (first === undefined || rates.has(short)) continue
    if (listed.every((rate) => equalRates(rate, first))) rates.set(short, first)
  }
  return rates
}

/**
 * Names that stand for no one model. The CLI writes `<synthetic>` on messages that
 * were never billed, and a family name alone could be any generation of that family.
 */
const NOT_A_MODEL = new Set(['<synthetic>', 'synthetic', 'opus', 'sonnet', 'haiku', 'fable'])

/** The price of a model as a driver names it, or null when the list cannot say. */
export function lookupRate(table: RateTable, model: string): ModelRate | null {
  const name = listName(model)
  const short = shortName(name)
  if (short === '' || NOT_A_MODEL.has(short)) return null
  return table.get(name) ?? table.get(short) ?? null
}

/** One persona turn's tokens, as much as its driver reported. */
export interface PricedRun {
  model: string | null
  inputTokens: number
  outputTokens: number
  /** Null when the driver reported one input total and no cache split. */
  split: { uncached: number; cached: number; cacheWrite: number } | null
  /** The provider's own figure for this turn. Only the Claude CLI reports one. */
  reportedCostUsd: number | null
}

export type CostSource = 'providerReported' | 'modelPriced' | 'unpriced'

export interface Priced {
  costUsd: number
  source: CostSource
  cacheSavingsUsd: number
}

/**
 * Prices one turn. A cost the provider reported itself is the cost. Otherwise the
 * turn is priced from the list, and only when the driver said how its input divides
 * into fresh tokens, cache reads and cache writes. An input total that is mostly
 * cache reads would come out several times too high at the fresh price, and a turn
 * that is not priced is better than one that is priced wrong.
 *
 * The saving is what the cached tokens would have cost extra as fresh input.
 */
export function priceRun(table: RateTable, run: PricedRun): Priced {
  const rate = run.model === null ? null : lookupRate(table, run.model)
  const known = rate !== null && run.split !== null ? { rate, split: run.split } : null
  const cacheSavingsUsd = known === null ? 0 : known.split.cached * (known.rate.input - known.rate.cacheRead)

  if (run.reportedCostUsd !== null && Number.isFinite(run.reportedCostUsd)) {
    return { costUsd: run.reportedCostUsd, source: 'providerReported', cacheSavingsUsd }
  }
  if (known === null) return { costUsd: 0, source: 'unpriced', cacheSavingsUsd: 0 }

  const { rate: listed, split } = known
  const costUsd = split.uncached * listed.input
    + split.cached * listed.cacheRead
    + split.cacheWrite * listed.cacheWrite
    + run.outputTokens * listed.output
  return { costUsd, source: 'modelPriced', cacheSavingsUsd }
}
