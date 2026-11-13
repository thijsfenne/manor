import { z } from 'zod'
import type { ProviderUsage, UsageWindow } from '@manor/contracts'
import { childProcessEnv } from '../childEnv.js'
import type { ChildLike, SpawnFn } from './claudeDriver.js'
import { cliShutdownStarted, terminateCliTree, trackCliChild } from './childTermination.js'

/**
 * Claude Code's own account limits, read over the stream-json control channel.
 *
 * `claude` answers a `get_usage` control request with the structured data behind
 * its `/usage` screen. Measured on 2.1.231 against a Max account: it replies on a
 * session with no user message at all, in ~1.5s, with `total_cost_usd: 0` and
 * `total_api_duration_ms: 0`. So the probe costs nothing against the weekly cap,
 * which is what lets it run on a timer.
 *
 * The route matters as much as the cost. A statusline cannot answer this: its
 * `rate_limits` payload is assembled from exactly two keys, `five_hour` and
 * `seven_day`, so the per-model weekly window is invisible there. This channel is
 * the only one that carries it.
 *
 * The response is explicitly experimental (the SDK spells that out in the method
 * name) and is read accordingly: every field is optional on the way in, and any
 * shape that does not parse lands on `unavailable` rather than on a zero.
 */

const CONTROL_TIMEOUT_MS = 10_000

/** Only the fields Manor reads. Everything else in the reply is deliberately ignored. */
const LimitSchema = z.object({
  kind: z.string().optional(),
  percent: z.number().optional(),
  severity: z.string().optional(),
  resets_at: z.string().nullable().optional(),
  is_active: z.boolean().optional(),
  scope: z
    .object({ model: z.object({ display_name: z.string().nullable().optional() }).nullable().optional() })
    .nullable()
    .optional(),
})

const UsageResponseSchema = z.object({
  subscription_type: z.string().nullable().optional(),
  rate_limits_available: z.boolean().optional(),
  rate_limits: z.object({ limits: z.array(LimitSchema).optional() }).nullable().optional(),
})

const ControlResponseSchema = z.object({
  type: z.literal('control_response'),
  response: z.object({
    subtype: z.string(),
    request_id: z.string().optional(),
    response: z.unknown().optional(),
    error: z.string().optional(),
  }),
})

const unavailable = (fetchedAt: number): ProviderUsage => ({
  provider: 'claude',
  status: 'unavailable',
  fetchedAt,
  windows: [],
})

/**
 * The provider's vocabulary, not ours. `weekly_all` and `weekly_scoped` are both
 * seven-day windows, which is the whole reason a label travels on the wire instead
 * of being derived from a duration on the client.
 *
 * An unrecognised kind keeps its own name rather than being dropped: a window Manor
 * has never heard of is still a window the user is spending against.
 */
export function claudeWindowLabel(kind: string, modelName?: string): string {
  if (kind === 'session') return '5-hour limit'
  if (kind === 'weekly_all') return 'Weekly'
  if (kind === 'weekly_scoped') return modelName === undefined ? 'Weekly scoped' : `Weekly ${modelName}`
  return kind
}

const severityOf = (value: string | undefined): UsageWindow['severity'] =>
  value === 'normal' || value === 'warning' || value === 'critical' ? value : undefined

/**
 * Maps one `get_usage` reply onto the contract. Exported for tests, which is also
 * why it takes the already-parsed value: the shape is experimental, so the thing
 * worth testing is what this does with a payload that shifts under it.
 */
export function providerUsageFromClaude(payload: unknown, fetchedAt: number): ProviderUsage {
  const parsed = UsageResponseSchema.safeParse(payload)
  if (!parsed.success) return unavailable(fetchedAt)

  // Explicitly false on API-key, Bedrock and Vertex sessions, where plan limits do
  // not apply at all. That is not a failure, but it is also not a number.
  if (parsed.data.rate_limits_available === false) return unavailable(fetchedAt)

  const windows = (parsed.data.rate_limits?.limits ?? []).flatMap<UsageWindow>((limit) => {
    if (limit.kind === undefined || limit.percent === undefined) return []
    const resets = limit.resets_at == null ? Number.NaN : Date.parse(limit.resets_at)
    const modelName = limit.scope?.model?.display_name ?? undefined
    const severity = severityOf(limit.severity)
    return [
      {
        label: claudeWindowLabel(limit.kind, modelName),
        usedPercent: limit.percent,
        ...(limit.kind === 'session' ? { minutes: 300 }
          : limit.kind === 'weekly_all' || limit.kind === 'weekly_scoped' ? { minutes: 10080 } : {}),
        ...(Number.isFinite(resets) ? { resetsAt: resets } : {}),
        ...(severity === undefined ? {} : { severity }),
        ...(limit.is_active === undefined ? {} : { binding: limit.is_active }),
      },
    ]
  })

  // A reply that carries no window is not a reading. Saying so beats an empty panel
  // that looks like a healthy account with nothing spent.
  if (windows.length === 0) return unavailable(fetchedAt)

  const plan = parsed.data.subscription_type
  return {
    provider: 'claude',
    status: 'ok',
    ...(plan == null ? {} : { plan }),
    fetchedAt,
    windows,
  }
}

export interface ClaudeUsageProbeOptions {
  command: string
  spawnFn: SpawnFn
  cwd: string
  now?: () => number
  timeoutMs?: number
}

/**
 * Spawns a headless session, asks one question, kills it. No prompt is ever sent,
 * so nothing reaches a model and the child exists only to answer this.
 */
export async function readClaudeProviderUsage(options: ClaudeUsageProbeOptions): Promise<ProviderUsage> {
  const now = options.now ?? Date.now
  const timeoutMs = options.timeoutMs ?? CONTROL_TIMEOUT_MS
  const requestId = `manor-usage-${String(now())}`

  let child: ChildLike
  try {
    if (cliShutdownStarted()) return unavailable(now())
    child = options.spawnFn(
      options.command,
      ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'],
      // The same minimal environment every other child gets. A probe is not a reason
      // to hand a CLI the server's database and memory-folder credentials.
      { cwd: options.cwd, env: childProcessEnv(process.env) },
    )
    trackCliChild(child)
  } catch {
    return unavailable(now())
  }

  return await new Promise<ProviderUsage>((resolve) => {
    let settled = false
    let buffer = ''

    const finish = (usage: ProviderUsage) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void terminateCliTree(child)
      resolve(usage)
    }

    const timer = setTimeout(() => finish(unavailable(now())), timeoutMs)
    timer.unref?.()

    child.stdout?.setEncoding?.('utf8')
    child.stdout?.on('data', (chunk: string | Buffer) => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim().length === 0) continue
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch {
          // The session prints hook and system lines too; only one line is ours.
          continue
        }
        const control = ControlResponseSchema.safeParse(parsed)
        if (!control.success) continue
        if (control.data.response.request_id !== requestId) continue
        if (control.data.response.subtype !== 'success') {
          finish(unavailable(now()))
          return
        }
        finish(providerUsageFromClaude(control.data.response.response, now()))
        return
      }
    })

    // Never read. Draining it keeps the pipe from filling and stalling the child,
    // and its contents are exactly the kind of thing that must not reach a client.
    child.stderr?.resume?.()

    child.on('error', () => finish(unavailable(now())))
    child.stdin?.on('error', () => finish(unavailable(now())))
    child.on('close', () => finish(unavailable(now())))

    try {
      child.stdin?.write(`${JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'get_usage' } })}\n`)
    } catch {
      finish(unavailable(now()))
    }
  })
}
