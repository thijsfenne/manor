import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import path from 'node:path'
import type { TailscaleStatus } from '@manor/contracts'
import { childProcessEnv, resolveCliCommand } from './childEnv.js'

/** What one `tailscale` run gave back, or `missing` when there is no CLI to run. */
export type TailscaleRun = { code: number; stdout: string; stderr: string } | 'missing'
export type RunTailscale = (args: readonly string[]) => Promise<TailscaleRun>

/** The app's own copy of the CLI, for a Mac where Tailscale was installed as an app only. */
const MAC_APP_CLI = '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
/** `serve --bg` can wait on an HTTPS consent page when the tailnet lacks it; never wait forever. */
const RUN_TIMEOUT_MS = 20_000

function findCli(env: NodeJS.ProcessEnv): string | undefined {
  const onPath = resolveCliCommand('tailscale', env)
  if (path.isAbsolute(onPath)) return onPath
  try {
    accessSync(MAC_APP_CLI, constants.X_OK)
    return MAC_APP_CLI
  } catch {
    return undefined
  }
}

/**
 * Runs the real CLI with the minimal child environment. Its output names the tailnet
 * and its machines, so nothing here logs it; callers map it to fixed words.
 */
export function createTailscaleRunner(env: NodeJS.ProcessEnv = process.env): RunTailscale {
  return (args) => new Promise((resolve) => {
    const cli = findCli(env)
    if (cli === undefined) {
      resolve('missing')
      return
    }
    execFile(cli, [...args], { env: childProcessEnv(env), timeout: RUN_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        resolve('missing')
        return
      }
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1
      resolve({ code, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

const LOGGED_OUT = /not logged in|logged out|needs? login/i
const NOT_RUNNING = /not running|failed to connect|connection refused|is tailscale running|no such file or directory/i

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function failed(run: Exclude<TailscaleRun, 'missing'>, fallback: string): TailscaleStatus {
  if (LOGGED_OUT.test(run.stderr)) return { state: 'logged_out' }
  if (NOT_RUNNING.test(run.stderr)) return { state: 'stopped' }
  return { state: 'error', message: fallback }
}

/**
 * Manor's one mapping in Tailscale Serve: HTTPS on port 443 of this Mac's tailnet name,
 * proxied to the Manor server on loopback. The state lives in Tailscale itself, which
 * keeps a `--bg` mapping across restarts, so Manor stores no switch of its own and
 * reads the truth every time. Turning it off removes exactly that mapping and leaves
 * any other Serve or Funnel configuration alone. Funnel is never used.
 */
export function createTailscaleServe(options: { run: RunTailscale; port: number }) {
  const target = `http://127.0.0.1:${options.port}`
  const ours = (proxy: unknown) =>
    proxy === target || proxy === `http://localhost:${options.port}` || proxy === `127.0.0.1:${options.port}`

  async function status(): Promise<TailscaleStatus> {
    const run = await options.run(['status', '--json'])
    if (run === 'missing') return { state: 'missing' }
    if (run.code !== 0) return failed(run, 'Tailscale did not answer. Open the Tailscale app on this Mac and try again.')
    const status = record(parse(run.stdout))
    if (status === undefined) return { state: 'error', message: 'Tailscale answered with something Manor cannot read.' }
    const backend = status.BackendState
    if (backend === 'Stopped') return { state: 'stopped' }
    if (backend === 'NeedsLogin' || backend === 'NeedsMachineAuth' || backend === 'NoState') return { state: 'logged_out' }
    if (backend !== undefined && backend !== 'Running') return { state: 'error', message: 'Tailscale is still starting. Try again in a moment.' }
    const self = record(status.Self)
    const dnsName = typeof self?.DNSName === 'string' ? self.DNSName.trim().replace(/\.$/, '') : ''
    // HTTPS certificates come with the `https` capability; an older CLI reports no map at all.
    const capabilities = record(self?.CapMap)
    // A node keeps its DNS name after MagicDNS is turned off, and then no phone can resolve it.
    const magicDns = record(status.CurrentTailnet)?.MagicDNSEnabled
    if (dnsName === '') return { state: 'no_https', serving: false }
    const https = magicDns !== false && (capabilities === undefined || Object.hasOwn(capabilities, 'https'))
    const address = `https://${dnsName}`

    const serve = await options.run(['serve', 'status', '--json'])
    if (serve === 'missing') return { state: 'missing' }
    if (serve.code !== 0) return failed(serve, 'Tailscale could not say what it serves. Try again in a moment.')
    // A node without any Serve configuration prints `null` or `{}`.
    const config = record(parse(serve.stdout)) ?? {}
    const host = `${dnsName}:443`
    const funnel = record(config.AllowFunnel)?.[host] === true
    const handler = record(record(record(record(config.Web)?.[host])?.Handlers)?.['/'])
    const tcp = record(record(config.TCP)?.['443'])
    // Funnel is never Manor's to touch: removing the last mapping would clear it too.
    if (funnel) return { state: 'conflict', address, funnel: true }
    // A mapping from before HTTPS went away stays removable, so the way out never closes.
    if (!https) return { state: 'no_https', serving: handler !== undefined && ours(handler.Proxy) }
    if (handler === undefined) return tcp === undefined ? { state: 'ready', address, serving: false } : { state: 'conflict', address, funnel: false }
    return ours(handler.Proxy) ? { state: 'ready', address, serving: true } : { state: 'conflict', address, funnel: false }
  }

  /** Adds or removes Manor's mapping, then reads the state again. Anything not ready is returned as it is. */
  async function setServing(on: boolean): Promise<TailscaleStatus> {
    const before = await status()
    // Without HTTPS only the way out is open: removing a mapping left from before.
    const allowed = before.state === 'ready' || (before.state === 'no_https' && !on)
    if (!allowed || before.serving === on) return before
    const run = await options.run(on
      ? ['serve', '--bg', '--https=443', target]
      : ['serve', '--https=443', '--set-path=/', 'off'])
    if (run === 'missing') return { state: 'missing' }
    if (run.code !== 0) {
      const after = failed(run, on ? 'Tailscale could not start serving Manor.' : 'Tailscale could not stop serving Manor.')
      return after
    }
    return status()
  }

  return { status, setServing }
}

export type TailscaleServe = ReturnType<typeof createTailscaleServe>
