import { LIVE_COMPACT_CONTEXT_FRACTION, SINGLE_CHAT_VOICE, type AgentConfig, type ChatOverride, type ContextEstimate, type ContextFigure, type LiveContext, type ThreadEvent } from '@manor/contracts'
import { contextWindow, defaultSingleRuntime, readSingleRuntime, singleRuntimeVoice } from './runtimeChoices'
import type { LiveTurnShape } from './quietState'
import { LIVE_COMPACT_DONE } from './turnTrace'
import { ROLLOVER_COMPACT_DONE } from './compacting'

export interface ContextMeter {
  used?: number
  window: number
  estimate?: ContextEstimate
}

/**
 * Last reported window fill for one session. Single Work has one voice, so the
 * latest `turn_result` for that id is the ring, not a sum across personas.
 * A successful live compact empties the snapshot until the next real reading.
 */
export function latestSessionContext(
  events: readonly ThreadEvent[],
  agentId = SINGLE_CHAT_VOICE.id,
): Partial<ContextMeter> {
  let used: number | undefined
  let window: number | undefined
  let estimate: ContextEstimate | undefined
  for (const event of events) {
    if (event.type === 'system_note' && (event.text === LIVE_COMPACT_DONE || event.text === ROLLOVER_COMPACT_DONE || event.contextBoundary !== undefined)) {
      if (event.agentId !== undefined && event.agentId !== agentId) continue
      used = undefined
      window = undefined
      estimate = undefined
      continue
    }
    if (event.type !== 'turn_result' || event.agentId !== agentId) continue
    if (event.contextTokens === undefined && event.contextEstimate === undefined) continue
    used = event.contextTokens
    window = event.contextWindow
    estimate = event.contextEstimate
  }
  return {
    ...(used === undefined ? {} : { used }),
    ...(window === undefined ? {} : { window }),
    ...(estimate === undefined ? {} : { estimate }),
  }
}

export function latestSessionContextTokens(
  events: readonly ThreadEvent[],
  agentId = SINGLE_CHAT_VOICE.id,
): number | undefined {
  return latestSessionContext(events, agentId).used
}

/** Synara-style short token count: 44k, 258k, 1m. */
export function compactContextTokens(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0'
  if (value < 1_000) return `${Math.round(value)}`
  if (value < 10_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, '')}k`
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`
}

/**
 * The figure the dial divides by: where this session actually ends, not the model's
 * catalog size. On Claude that is the `--autocompact` threshold Manor itself puts on
 * the argv (measured, 300k against a 1m window), so the ring fills toward the event
 * the reader will really see instead of topping out near a third and resetting.
 * A driver with no measured threshold keeps its window, and a threshold at or above
 * the window is no limit at all.
 */
export function contextLimit(window: number, estimate: ContextEstimate | undefined): number {
  const at = estimate?.autoCompactAt
  if (at === undefined || at.source !== 'measured') return window
  return at.tokens > 0 && at.tokens < window ? at.tokens : window
}

export function readContextMeter(used: number | undefined, window: number, estimate?: ContextEstimate) {
  const limit = contextLimit(window, estimate)
  const fraction = used === undefined || limit <= 0 ? 0 : Math.min(1, used / limit)
  return {
    fraction,
    percent: Math.round(fraction * 100),
    usedLabel: used === undefined ? null : compactContextTokens(used),
    /** The denominator of `fraction` in tokens. */
    limit,
    /** The same, as a label: the compaction threshold when one is measured. */
    limitLabel: compactContextTokens(limit),
    /** The model window itself, for the surface line that names it. Never the denominator. */
    windowLabel: compactContextTokens(window),
    /** Whether `limit` is a compaction threshold rather than the window, so copy can say so. */
    limitIsCompact: limit !== window,
    warns: fraction >= LIVE_COMPACT_CONTEXT_FRACTION,
    /**
     * Whether a provider named the fill at all. A `fraction` of 0 is what an empty
     * dial and an unreported one both compute to, so the dial alone cannot say which,
     * and only this distinguishes them.
     */
    reported: used !== undefined,
  }
}

/** One context figure as a surface shows it. `tokens` is null exactly when unknown. */
export interface ContextFigureRead {
  source: ContextFigure['source']
  tokens: string | null
}

const readFigure = (figure: ContextFigure | undefined): ContextFigureRead | undefined =>
  figure === undefined ? undefined
    : figure.source === 'unknown' ? { source: 'unknown', tokens: null }
      : { source: figure.source, tokens: compactContextTokens(figure.tokens) }

/**
 * Provenance for the window figures of the last reported turn, so a surface can show
 * measured, estimated and unknown as three different things. Every field is absent on
 * turns written before provenance existed, which is not the same as unknown: absent
 * means Manor never asked, unknown means the driver had no answer.
 */
export function contextProvenance(estimate: ContextEstimate | undefined) {
  return {
    used: readFigure(estimate?.used),
    window: readFigure(estimate?.window),
    autoCompactAt: readFigure(estimate?.autoCompactAt),
  }
}

/**
 * The running turn's own reading for one session, when its CLI reported one between
 * requests. The object is the server's, so its identity only changes with a new
 * reading, which is what lets a surface memoise on it while text streams around it.
 */
export function liveSessionContext(
  liveTurns: readonly LiveTurnShape[],
  agentId = SINGLE_CHAT_VOICE.id,
): LiveContext | undefined {
  for (let index = liveTurns.length - 1; index >= 0; index -= 1) {
    const turn = liveTurns[index]!
    if (turn.agentId === agentId && turn.state === 'running' && turn.context !== undefined) return turn.context
  }
  return undefined
}

/** Figures only, no sized blocks: `contextBreakdown` draws no split for it. */
const UNSIZED_ESTIMATE: ContextEstimate = { instructions: 0, memory: 0, skills: 0, mcpCatalog: 0, unmeasuredMcpServers: 0 }

/**
 * The durable reading with a running turn's live one laid over it. A live size wins
 * and is measured; a compaction that named no new size empties the dial rather than
 * keep the size from before it; a live state without either changes nothing.
 */
function withLiveContext(latest: Partial<ContextMeter>, live: LiveContext | undefined): Partial<ContextMeter> {
  if (live === undefined || (live.contextTokens === undefined && live.compacted !== true)) return latest
  // Before a session's first settled turn there is no estimate, but a known threshold
  // still has to scale the dial, or 250k reads 25% live and 83% once the turn settles.
  const base = latest.estimate ?? (live.autoCompactTokens === undefined ? undefined : UNSIZED_ESTIMATE)
  const estimate = base === undefined ? undefined : {
    ...base,
    used: live.contextTokens === undefined
      ? { source: 'unknown' as const }
      : { source: 'measured' as const, tokens: live.contextTokens },
    ...(live.contextWindow === undefined ? {} : { window: { source: 'measured' as const, tokens: live.contextWindow } }),
    ...(live.autoCompactTokens === undefined ? {} : { autoCompactAt: { source: 'measured' as const, tokens: live.autoCompactTokens } }),
  }
  return {
    ...(live.contextTokens === undefined ? {} : { used: live.contextTokens }),
    ...(live.contextWindow !== undefined ? { window: live.contextWindow } : latest.window === undefined ? {} : { window: latest.window }),
    ...(estimate === undefined ? {} : { estimate }),
  }
}

/**
 * Window and fill for the Single Work composer ring: the running turn's live reading
 * when its CLI gives one, else the last turn's. Absent used is an empty dial.
 */
export function singleWorkContext(
  events: readonly ThreadEvent[],
  override: ChatOverride,
  agents: readonly AgentConfig[],
  live?: LiveContext,
): ContextMeter {
  const voice = singleRuntimeVoice(readSingleRuntime(override, defaultSingleRuntime(agents)))
  const catalog = contextWindow(voice, override)
  const latest = withLiveContext(latestSessionContext(events), live)
  const window = latest.window !== undefined && latest.window > 0 ? latest.window : catalog
  return { ...latest, window }
}

/** Rows in the order a reader scans them: the big movers first, the standing blocks after. */
export type ContextRowKey = 'messages' | 'mcp' | 'memory' | 'instructions' | 'skills'

export interface ContextRowRead {
  key: ContextRowKey
  tokens: string
  /** One decimal, e.g. `12.9%`, of the dial's limit so the rows add up to the header. Null without a measured total. */
  percent: string | null
  /** Width of the bar segment as a fraction of the track, 0 without a measured total. */
  share: number
}

/**
 * Scales whole-token counts by `scale` (at most 1) so they still add up to the total
 * they were shrunk to: floors first, then the leftover tokens go to the largest
 * fractional parts. Independent rounding could otherwise add a token or two.
 */
function shrinkToTotal<K extends string>(sized: readonly (readonly [K, number])[], scale: number): (readonly [K, number])[] {
  if (scale >= 1) return [...sized]
  const exact = sized.map(([key, tokens]) => [key, tokens * scale] as const)
  const floored = exact.map(([key, tokens]) => [key, Math.floor(tokens)] as const)
  let leftover = Math.round(exact.reduce((sum, [, tokens]) => sum + tokens, 0)) - floored.reduce((sum, [, tokens]) => sum + tokens, 0)
  const byRemainder = exact.map(([, tokens], index) => ({ index, rest: tokens - Math.floor(tokens) })).sort((a, b) => b.rest - a.rest)
  for (const { index } of byRemainder) {
    if (leftover <= 0) break
    floored[index] = [floored[index]![0], floored[index]![1] + 1]
    leftover -= 1
  }
  return floored
}

/**
 * The split under the context readout, built only from what Manor itself supplied
 * (instructions, memory, skills, the attached MCP catalog) plus the provider's measured
 * total. Whatever those do not explain is Messages, so the rows add up to `used`.
 * Categories Manor cannot size on a driver (tool schemas, system tools) are absent
 * rather than shown as "not exposed". The supplied sizes are chars/4 guesses: if they
 * exceed the measured total (a lazily loaded MCP catalog, say) they shrink together to
 * fit, and Messages disappears. Without a measured total there is no bar and no
 * Messages row, only the sized rows.
 */
export function contextBreakdown(used: number | undefined, estimate: ContextEstimate | undefined, limit?: number) {
  if (estimate === undefined) return undefined
  const sized = ([
    ['mcp', estimate.mcpCatalog],
    ['memory', estimate.memory],
    ['instructions', estimate.instructions],
    ['skills', estimate.skills],
  ] as const).filter(([, tokens]) => tokens > 0)
  // Manor sized nothing, which only a live reading before the first settled turn does
  // (a real turn always carries instructions); a split would call all of it Messages.
  if (sized.length === 0 && estimate.unmeasuredMcpServers === 0) return undefined
  const known = sized.reduce((sum, [, tokens]) => sum + tokens, 0)
  const total = used !== undefined && Number.isFinite(used) && used >= 0 ? used : null
  const scale = total === null || known <= total ? 1 : total / known
  // Percent is of the dial's limit, so the rows add up to the header's own figure; the
  // bar alone is drawn against the larger of the two so an overfull window still fits it.
  const track = Math.max(limit ?? 0, total ?? 0)
  const read = (key: ContextRowKey, tokens: number): ContextRowRead => ({
    key,
    tokens: compactContextTokens(tokens),
    percent: total === null || !limit || limit <= 0 ? null : `${(tokens / limit * 100).toFixed(1)}%`,
    share: total === null || track <= 0 ? 0 : tokens / track,
  })
  const scaled = shrinkToTotal(sized, scale)
  const messages = total === null ? 0 : total - scaled.reduce((sum, [, tokens]) => sum + tokens, 0)
  const rows = [
    ...(messages > 0 ? [read('messages', messages)] : []),
    ...scaled.filter(([, tokens]) => tokens > 0).map(([key, tokens]) => read(key, tokens)),
  ]
  return {
    rows,
    /** Connections whose schema size is unknown, so the MCP row is a floor, not a total. */
    unmeasuredMcpServers: estimate.unmeasuredMcpServers,
  }
}
