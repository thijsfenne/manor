import { z } from 'zod'
import type { ProviderUsage, UsageWindow } from '@manor/contracts'
import { childProcessEnv } from '../childEnv.js'
import type { ChildLike } from './claudeDriver.js'
import type { CodexSpawnFn } from './codexDriver.js'
import { cliShutdownStarted, terminateCliTree, trackCliChild } from './childTermination.js'

/**
 * Codex's own account limits, read from `codex app-server`.
 *
 * The app-server speaks JSON-RPC and answers `account/rateLimits/read` without
 * running a turn. Verified live 2026-08-13 against Manor's own `CODEX_HOME`: it
 * returned a single week window (10080 minutes) with `secondary: null`, which is
 * the case the implementation has to survive. There is no fixed five-hour-plus-week
 * pair to rely on; render exactly what comes back.
 */

const PROBE_TIMEOUT_MS = 10_000

const WindowSchema = z.object({
  usedPercent: z.number().optional(),
  windowDurationMins: z.number().optional(),
  /** Epoch SECONDS, unlike everything else on the wire in this codebase. */
  resetsAt: z.number().optional(),
})

const RateLimitsSchema = z.object({
  primary: WindowSchema.nullable().optional(),
  secondary: WindowSchema.nullable().optional(),
  planType: z.string().nullable().optional(),
})

const ReplySchema = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  result: z.object({ rateLimits: RateLimitsSchema.nullable().optional() }).optional(),
  error: z.unknown().optional(),
})

const unavailable = (fetchedAt: number): ProviderUsage => ({
  provider: 'codex',
  status: 'unavailable',
  fetchedAt,
  windows: [],
})

/**
 * Codex names its windows only by length, so unlike Claude the label is derived.
 * The two it actually ships get the wording the panel wants; anything else still
 * renders, stated in the largest unit that divides it cleanly.
 */
export function codexWindowLabel(minutes: number | undefined): string {
  if (minutes === undefined) return 'Limit'
  if (minutes === 300) return '5-hour limit'
  if (minutes === 10080) return 'Weekly'
  if (minutes < 60) return `${String(minutes)}-minute limit`
  if (minutes < 1440) return `${String(Math.round(minutes / 60))}-hour limit`
  return `${String(Math.round(minutes / 1440))}-day limit`
}

/** Maps one `account/rateLimits/read` result onto the contract. Exported for tests. */
export function providerUsageFromCodex(payload: unknown, fetchedAt: number): ProviderUsage {
  const parsed = ReplySchema.safeParse(payload)
  if (!parsed.success) return unavailable(fetchedAt)
  const limits = parsed.data.result?.rateLimits
  if (limits == null) return unavailable(fetchedAt)

  const windows = [limits.primary, limits.secondary].flatMap<UsageWindow>((window) => {
    if (window == null || window.usedPercent === undefined) return []
    return [
      {
        label: codexWindowLabel(window.windowDurationMins),
        usedPercent: window.usedPercent,
        // Seconds to milliseconds. The contract is epoch ms everywhere.
        ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt * 1000 }),
        ...(window.windowDurationMins === undefined ? {} : { minutes: window.windowDurationMins }),
      },
    ]
  })

  if (windows.length === 0) return unavailable(fetchedAt)

  const plan = limits.planType
  return {
    provider: 'codex',
    status: 'ok',
    ...(plan == null ? {} : { plan }),
    fetchedAt,
    windows,
  }
}

export interface CodexUsageProbeOptions {
  command: string
  spawnFn: CodexSpawnFn
  cwd: string
  now?: () => number
  timeoutMs?: number
  /**
   * Handed in rather than imported, so this module does not close the import cycle
   * back to the driver. It is also what lets a test run without touching the real
   * Codex home, where the auth symlink lives.
   */
  codexHome: () => Promise<string>
}

const INITIALIZE_ID = 1
const READ_ID = 2

/** One-shot: handshake, ask, kill. No long-lived app-server process to supervise. */
export async function readCodexProviderUsage(options: CodexUsageProbeOptions): Promise<ProviderUsage> {
  const now = options.now ?? Date.now
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS

  let home: string
  try {
    home = await options.codexHome()
  } catch {
    return unavailable(now())
  }

  let child: ChildLike
  try {
    if (cliShutdownStarted()) return unavailable(now())
    child = options.spawnFn(options.command, ['app-server'], {
      cwd: options.cwd,
      env: childProcessEnv(process.env, [], { CODEX_HOME: home }),
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

    const timer = setTimeout(() => finish(unavailable(now())), timeoutMs)
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
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch {
          continue
        }
        const reply = ReplySchema.safeParse(parsed)
        // The app-server also pushes unsolicited notifications; those carry no id.
        if (!reply.success || reply.data.id === undefined) continue
        if (reply.data.id === INITIALIZE_ID) {
          send({ jsonrpc: '2.0', method: 'initialized', params: {} })
          send({ jsonrpc: '2.0', id: READ_ID, method: 'account/rateLimits/read', params: {} })
          continue
        }
        if (reply.data.id === READ_ID) {
          finish(providerUsageFromCodex(parsed, now()))
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
      params: { clientInfo: { name: 'manor', title: 'Manor', version: '0.0.0' } },
    })
  })
}
