import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import type { ProviderUsage } from '@manor/contracts'
import { childProcessEnv } from '../childEnv.js'
import type { GrokChildLike, GrokSpawnFn } from './grokDriver.js'
import { cliShutdownStarted, terminateCliTree, trackCliChild } from './childTermination.js'

/** Grok's own ACP billing extension, which backs the Usage limit tab in `/usage`. */

const PROBE_TIMEOUT_MS = 10_000
const INITIALIZE_ID = 1
const BILLING_ID = 2

const BillingReplySchema = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  result: z.object({
    config: z.object({
      creditUsagePercent: z.number().optional(),
      currentPeriod: z.object({
        type: z.string(),
        start: z.string(),
        end: z.string(),
      }).optional(),
    }).optional(),
    subscription_tier: z.string().optional(),
  }).optional(),
  error: z.unknown().optional(),
})

const unavailable = (fetchedAt: number): ProviderUsage => ({
  provider: 'grok',
  status: 'unavailable',
  fetchedAt,
  windows: [],
})

export function grokWindowLabel(type: string): string {
  if (type === 'USAGE_PERIOD_TYPE_WEEKLY') return 'Weekly limit'
  if (type === 'USAGE_PERIOD_TYPE_MONTHLY') return 'Monthly limit'
  return type
}

/** The CLI omits a zero percentage; its own Usage tab renders that omission as 0%. */
export function providerUsageFromGrok(payload: unknown, fetchedAt: number): ProviderUsage {
  const parsed = BillingReplySchema.safeParse(payload)
  const data = parsed.success ? parsed.data : undefined
  const period = data?.result?.config?.currentPeriod
  if (period === undefined) return unavailable(fetchedAt)
  const startsAt = Date.parse(period.start)
  const resetsAt = Date.parse(period.end)
  if (!Number.isFinite(startsAt) || !Number.isFinite(resetsAt) || resetsAt <= startsAt) {
    return unavailable(fetchedAt)
  }
  const usedPercent = data?.result?.config?.creditUsagePercent ?? 0

  return {
    provider: 'grok',
    status: 'ok',
    ...(data?.result?.subscription_tier === undefined
      ? {}
      : { plan: data.result.subscription_tier }),
    fetchedAt,
    windows: [{
      label: grokWindowLabel(period.type),
      usedPercent,
      resetsAt,
      startsAt,
      minutes: Math.round((resetsAt - startsAt) / 60_000),
    }],
  }
}

const defaultSpawn: GrokSpawnFn = (command, args, options) =>
  spawn(command, [...args], { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] })

export interface GrokUsageProbeOptions {
  command: string
  spawnFn?: GrokSpawnFn
  cwd: string
  now?: () => number
  timeoutMs?: number
  usageHome?: string
  grokHome?: string
}

/** Handshake and ask only; creating a chat session would load tools for no reason. */
export async function readGrokProviderUsage(options: GrokUsageProbeOptions): Promise<ProviderUsage> {
  const now = options.now ?? Date.now
  const usageHome = options.usageHome ?? path.join(os.homedir(), '.manor', 'grok-usage-home')
  const grokHome = options.grokHome ?? path.join(os.homedir(), '.grok')
  try {
    await mkdir(usageHome, { recursive: true })
  } catch {
    return unavailable(now())
  }

  let child: GrokChildLike
  try {
    if (cliShutdownStarted()) return unavailable(now())
    child = (options.spawnFn ?? defaultSpawn)(options.command, ['agent', '--no-leader', 'stdio'], {
      cwd: options.cwd,
      // HOME prevents compatibility discovery of the user's other tools. GROK_HOME is
      // the real login home: unlike a copied token, it can be refreshed safely.
      env: childProcessEnv(process.env, [], { HOME: usageHome, GROK_HOME: grokHome }),
    })
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
    const timer = setTimeout(() => finish(unavailable(now())), options.timeoutMs ?? PROBE_TIMEOUT_MS)
    timer.unref?.()
    const send = (message: unknown) => {
      try {
        child.stdin?.write(`${JSON.stringify(message)}\n`)
      } catch {
        finish(unavailable(now()))
      }
    }

    child.stdout?.setEncoding?.('utf8')
    child.stdout?.on('data', (chunk: string | Buffer) => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim().length === 0) continue
        let payload: unknown
        try {
          payload = JSON.parse(line)
        } catch {
          continue
        }
        const reply = BillingReplySchema.safeParse(payload)
        if (!reply.success || reply.data.id === undefined) continue
        if (reply.data.id === INITIALIZE_ID) {
          send({ jsonrpc: '2.0', id: BILLING_ID, method: '_x.ai/billing', params: {} })
          continue
        }
        if (reply.data.id === BILLING_ID) {
          finish(providerUsageFromGrok(payload, now()))
          return
        }
      }
    })

    child.stderr?.resume?.()
    child.on('error', () => finish(unavailable(now())))
    child.stdin?.on('error', () => finish(unavailable(now())))
    child.on('close', () => finish(unavailable(now())))
    send({
      jsonrpc: '2.0',
      id: INITIALIZE_ID,
      method: 'initialize',
      params: {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: 'manor', version: '0.0.0' },
      },
    })
  })
}
