import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { childProcessEnv } from '../childEnv.js'

/**
 * The app-server fields Manor's driver and usage probe rely on, per generated
 * schema. Read from the binary itself, so no login and no model call is needed.
 */
const REQUIRED_FIELDS: Record<string, string[]> = {
  ThreadStartParams: ['baseInstructions', 'config', 'serviceTier'],
  ThreadResumeParams: ['baseInstructions', 'threadId', 'config', 'serviceTier'],
  TurnStartParams: ['input', 'threadId', 'toolOutput', 'serviceTier'],
  TurnSteerParams: ['input', 'threadId', 'expectedTurnId'],
  TurnSteerResponse: ['turnId'],
  TurnInterruptParams: ['threadId', 'turnId'],
  GetAccountRateLimitsResponse: ['rateLimits'],
}

/**
 * Manor's gate before a Codex binary becomes the active one. Never rejects; a
 * binary that does not answer within the timeout fails like an incompatible one.
 */
export async function checkCodexProtocol(command: string, timeoutMs = 30_000): Promise<{ ok: true; checked: number } | { ok: false; reason: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'manor-codex-protocol-'))
  try {
    const generated = await new Promise<string | null>((resolve) => {
      execFile(command, ['app-server', 'generate-json-schema', '--out', directory], { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 256 * 1024, env: childProcessEnv() }, (error) => {
        resolve(error === null ? null : error.killed ? 'timed out' : 'could not generate its schema')
      })
    })
    if (generated !== null) return { ok: false, reason: `Codex ${generated}` }
    for (const [name, fields] of Object.entries(REQUIRED_FIELDS)) {
      const schema = JSON.parse(await readFile(path.join(directory, 'v2', `${name}.json`), 'utf8')) as {
        properties?: Record<string, unknown>; required?: string[]
      }
      const missing = fields.find((field) => !(field in (schema.properties ?? {})))
      if (missing !== undefined) return { ok: false, reason: `${name}.${missing} is missing` }
      if (name === 'TurnSteerParams' && !schema.required?.includes('expectedTurnId')) {
        return { ok: false, reason: 'steering no longer requires its active-turn precondition' }
      }
    }
    return { ok: true, checked: Object.keys(REQUIRED_FIELDS).length }
  } catch (error: unknown) {
    return { ok: false, reason: error instanceof Error && 'code' in error && error.code === 'ENOENT' ? 'a required schema is gone' : 'its schema could not be read' }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
