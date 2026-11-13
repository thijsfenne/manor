import { execFile } from 'node:child_process'
import type { ProviderVersionCheck } from '@manor/contracts'
import { childProcessEnv } from '../childEnv.js'
import { runtimeVersion } from './runtimeVersion.js'

/**
 * Update probes and updater runs shared by the drivers. Lives beside them because
 * it spawns provider CLIs, which nothing outside a driver may do.
 */

const REGISTRY_TIMEOUT_MS = 4_000
const CHECK_TIMEOUT_MS = 20_000
const UPDATE_TIMEOUT_MS = 2 * 60_000

/** Numeric dotted comparison; prerelease and build suffixes are ignored. */
export function compareVersions(left: string, right: string): number {
  const parts = (version: string) => version.replace(/^v/, '').split(/[-+]/)[0]!.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const a = parts(left)
  const b = parts(right)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

/** A dist-tag from the public npm registry, or null on any failure. */
export async function npmDistTag(packageName: string, tag = 'latest', fetchFn: typeof fetch = fetch): Promise<string | null> {
  try {
    const response = await fetchFn(`https://registry.npmjs.org/-/package/${packageName}/dist-tags`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
    })
    if (!response.ok) return null
    const tags = (await response.json()) as Record<string, unknown>
    const version = tags[tag]
    return typeof version === 'string' && version.trim() !== '' ? version.trim() : null
  } catch {
    return null
  }
}

/** Installed `--version` against an npm dist-tag. Claude publishes there. */
export async function checkAgainstNpm(
  command: string,
  packageName: string,
  canUpdate: boolean,
  fetchFn: typeof fetch = fetch,
): Promise<ProviderVersionCheck | null> {
  const [{ version: currentVersion }, latestVersion] = await Promise.all([runtimeVersion(command), npmDistTag(packageName, 'latest', fetchFn)])
  if (currentVersion === null || latestVersion === null) return null
  return { currentVersion, latestVersion, canUpdate }
}

/** Grok's own `update --check --json`, which knows its channel better than any feed. */
export async function checkGrok(command: string): Promise<ProviderVersionCheck | null> {
  const output = await run(command, ['update', '--check', '--json'], CHECK_TIMEOUT_MS)
  if (!output.ok) return null
  try {
    const parsed = JSON.parse(output.stdout) as { currentVersion?: unknown; latestVersion?: unknown }
    if (typeof parsed.currentVersion !== 'string' || typeof parsed.latestVersion !== 'string') return null
    return { currentVersion: parsed.currentVersion, latestVersion: parsed.latestVersion, canUpdate: true }
  } catch {
    return null
  }
}

/**
 * The provider's own updater. The reason is one line, never the whole log: pnpm's
 * own error line when there is one, since pnpm prints a hint after it ("No
 * authorization header was set" on any public 404) that names no cause.
 */
export async function runUpdater(command: string, args: string[]): Promise<{ ok: true } | { ok: false; reason: string }> {
  const output = await run(command, args, UPDATE_TIMEOUT_MS)
  if (output.ok) return { ok: true }
  return { ok: false, reason: failureLine(output.stdout, output.stderr).slice(0, 200) }
}

export function failureLine(stdout: string, stderr: string): string {
  const lines = (text: string) => text.split('\n').map((line) => line.trim()).filter((line) => line !== '')
  const pnpmError = [...lines(stderr), ...lines(stdout)].find((line) => line.startsWith('ERR_PNPM_'))
  if (pnpmError !== undefined) return pnpmError.replace(/^ERR_PNPM_/, '').replace(/\s+/g, ' ')
  return lines(stderr).at(-1) ?? lines(stdout).at(-1) ?? 'the updater gave no reason'
}

function run(command: string, args: string[], timeout: number): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout, maxBuffer: 256 * 1024, env: childProcessEnv() }, (error, stdout, stderr) => {
      resolve({ ok: error === null, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}
