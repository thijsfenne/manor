import { execFile } from 'node:child_process'
import type { ProviderAccount } from '@manor/contracts'
import { childProcessEnv } from '../childEnv.js'

/** What a status command answered; null when it could not be started or timed out. */
export interface StatusOutput { code: number; text: string }

/**
 * Asks a provider CLI about its own login. Read-only, short, and never a turn. The
 * text is parsed by the driver and dropped: only the parsed fields leave this file.
 */
export function runStatusCommand(command: string, args: readonly string[], env: NodeJS.ProcessEnv = childProcessEnv()): Promise<StatusOutput | null> {
  return new Promise((resolve) => {
    execFile(command, [...args], { timeout: 8_000, maxBuffer: 64 * 1024, env }, (error, stdout, stderr) => {
      const text = `${stdout}\n${stderr}`
      if (error === null) return resolve({ code: 0, text })
      // A numeric code is the CLI's own answer; anything else (ENOENT, a timeout) is no answer.
      resolve(typeof error.code === 'number' ? { code: error.code, text } : null)
    })
  })
}

const UNKNOWN: ProviderAccount = { signedIn: null }
const optional = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0 ? value : undefined)

/** `claude auth status --json`. */
export function parseClaudeAccount(output: StatusOutput | null): ProviderAccount {
  if (output === null) return UNKNOWN
  try {
    const status = JSON.parse(output.text.slice(output.text.indexOf('{'), output.text.lastIndexOf('}') + 1)) as Record<string, unknown>
    if (typeof status['loggedIn'] !== 'boolean') return UNKNOWN
    const account = optional(status['email'])
    const plan = optional(status['subscriptionType'])
    return { signedIn: status['loggedIn'], ...(account === undefined ? {} : { account }), ...(plan === undefined ? {} : { plan }) }
  } catch {
    return UNKNOWN
  }
}

/** `codex login status`: says "Logged in using ChatGPT" and exits 0, or "Not logged in" and exits 1. */
export function parseCodexAccount(output: StatusOutput | null): ProviderAccount {
  if (output === null) return UNKNOWN
  if (/not logged in/i.test(output.text)) return { signedIn: false }
  const method = /logged in using ([^\n\r]+)/i.exec(output.text)?.[1]?.trim()
  if (output.code === 0 && method !== undefined) return { signedIn: true, plan: method }
  return UNKNOWN
}

/** `agent status`: "Logged in as <email>" behind terminal colour codes, or "Not logged in". */
export function parseCursorAccount(output: StatusOutput | null): ProviderAccount {
  if (output === null) return UNKNOWN
  // eslint-disable-next-line no-control-regex
  const text = output.text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
  if (/not logged in/i.test(text)) return { signedIn: false }
  const account = /logged in as (\S+)/i.exec(text)?.[1]
  return account === undefined ? UNKNOWN : { signedIn: true, account }
}
