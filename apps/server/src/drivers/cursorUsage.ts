import { execFile } from 'node:child_process'
import { z } from 'zod'
import type { ProviderUsage } from '@manor/contracts'

/** Cursor Agent's own usage RPC, the same account reading its `/usage` view uses. */

const PROBE_TIMEOUT_MS = 10_000
const DEFAULT_ENDPOINT = 'https://api2.cursor.sh'

const CurrentPeriodSchema = z.object({
  billingCycleStart: z.union([z.string(), z.number()]).optional(),
  billingCycleEnd: z.union([z.string(), z.number()]).optional(),
  planUsage: z.object({
    autoPercentUsed: z.number().optional(),
    apiPercentUsed: z.number().optional(),
  }).optional(),
})

const PlanInfoSchema = z.object({
  planInfo: z.object({ planName: z.string().optional() }).optional(),
})

const unavailable = (fetchedAt: number): ProviderUsage => ({
  provider: 'cursor',
  status: 'unavailable',
  fetchedAt,
  windows: [],
})

const epochMillis = (value: string | number | undefined): number | undefined => {
  if (value === undefined) return
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

/** Maps the two dashboard replies onto the provider-neutral wire contract. */
export function providerUsageFromCursor(
  currentPeriodPayload: unknown,
  planInfoPayload: unknown,
  fetchedAt: number,
): ProviderUsage {
  const current = CurrentPeriodSchema.safeParse(currentPeriodPayload)
  if (!current.success || current.data.planUsage === undefined) return unavailable(fetchedAt)

  const planUsage = current.data.planUsage
  const startsAt = epochMillis(current.data.billingCycleStart)
  const resetsAt = epochMillis(current.data.billingCycleEnd)
  const minutes = startsAt !== undefined && resetsAt !== undefined && resetsAt > startsAt
    ? Math.round((resetsAt - startsAt) / 60_000)
    : undefined
  const plan = PlanInfoSchema.safeParse(planInfoPayload)
  const planName = plan.success ? plan.data.planInfo?.planName : undefined
  const reset = {
    ...(minutes === undefined ? {} : { startsAt }),
    ...(resetsAt === undefined ? {} : { resetsAt }),
    ...(minutes === undefined ? {} : { minutes }),
  }
  const windows: ProviderUsage['windows'] = [
    { label: 'Cursor Models', usedPercent: planUsage.autoPercentUsed ?? 0, ...reset },
    { label: 'Other Models', usedPercent: planUsage.apiPercentUsed ?? 0, ...reset },
  ]

  return {
    provider: 'cursor',
    status: 'ok',
    ...(planName === undefined ? {} : { plan: planName }),
    fetchedAt,
    windows,
  }
}

export type CursorUsageFetch = (input: string | URL, init?: RequestInit) => Promise<Response>

export interface CursorUsageProbeOptions {
  now?: () => number
  timeoutMs?: number
  endpoint?: string
  fetchFn?: CursorUsageFetch
  authToken?: () => Promise<string | undefined>
}

/** Reads the keychain entry used by the Cursor Agent CLI without ever logging it. */
export async function readCursorAuthToken(): Promise<string | undefined> {
  if (process.env.CURSOR_AUTH_TOKEN !== undefined) return process.env.CURSOR_AUTH_TOKEN
  return await new Promise((resolve) => {
    execFile(
      'security',
      ['find-generic-password', '-a', 'cursor-user', '-s', 'cursor-access-token', '-w'],
      { timeout: PROBE_TIMEOUT_MS, maxBuffer: 64 * 1024 },
      (error, stdout) => resolve(error === null && stdout.trim().length > 0 ? stdout.trim() : undefined),
    )
  })
}

/** One-shot Connect requests; no Cursor turn and no browser session are involved. */
export async function readCursorProviderUsage(options: CursorUsageProbeOptions = {}): Promise<ProviderUsage> {
  const now = options.now ?? Date.now
  const fetchFn = options.fetchFn ?? fetch
  const endpoint = (options.endpoint ?? process.env.CURSOR_API_ENDPOINT ?? DEFAULT_ENDPOINT).replace(/\/+$/, '')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? PROBE_TIMEOUT_MS)
  timer.unref?.()

  try {
    const token = await (options.authToken ?? readCursorAuthToken)()
    if (token === undefined) return unavailable(now())
    const request = (method: string) => fetchFn(`${endpoint}/aiserver.v1.DashboardService/${method}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Connect-Protocol-Version': '1',
        'Content-Type': 'application/json',
      },
      body: '{}',
      signal: controller.signal,
    })
    const [current, plan] = await Promise.all([
      request('GetCurrentPeriodUsage'),
      request('GetPlanInfo'),
    ])
    if (!current.ok) return unavailable(now())
    const currentPayload: unknown = await current.json()
    const planPayload: unknown = plan.ok ? await plan.json() : undefined
    return providerUsageFromCursor(currentPayload, planPayload, now())
  } catch {
    return unavailable(now())
  } finally {
    clearTimeout(timer)
  }
}
