import type { AttachedMcpServer } from '@manor/contracts'
import { accessSync, constants, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mcpEnvironmentKeys } from './mcp/httpHeaders.js'

/** Resolve optional provider CLIs without executing them or depending on shell startup. */
export function resolveCliCommand(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME ?? os.homedir()
  const dirs = [
    ...(env.PATH ?? '').split(path.delimiter),
    path.join(home, '.local', 'bin'),
    path.join(home, '.bun', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ]
  for (const dir of dirs) {
    if (!path.isAbsolute(dir)) continue
    const candidate = path.join(dir, name)
    try {
      if (!statSync(candidate).isFile()) continue
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Another location may still hold this optional provider.
    }
  }
  // Keep the driver available when this optional provider is not installed.
  return name
}

/**
 * Host values a provider CLI needs to start and reach the network. Application
 * credentials are deliberately absent. A capability that needs another value must
 * declare its key explicitly, so attaching it is the access decision.
 */
const PASS_THROUGH_KEYS = [
  'PATH',
  'HOME',
  // The Claude CLI looks its macOS Keychain credential up by account name, so a child
  // without USER reports "Not logged in" even though the login is valid.
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'TERM',
  'TMPDIR',
  'TMP',
  'TEMP',
  'NO_COLOR',
  'FORCE_COLOR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
] as const

export const CHILD_ERROR_TAIL_CHARS = 64 * 1024

/** Keeps only the useful tail of noisy child output. */
export function appendChildErrorTail(
  current: string,
  chunk: string,
  sanitize: (value: string) => string = (value) => value,
  limit: number = CHILD_ERROR_TAIL_CHARS,
): string {
  const combined = sanitize(current + chunk)
  return combined.length <= limit ? combined : combined.slice(-limit)
}

/** Host values a third-party stdio MCP may inherit. HOME is absent on purpose. */
const UPSTREAM_PASS_THROUGH_KEYS = [
  'PATH',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
] as const

const pickEnv = (
  hostEnv: NodeJS.ProcessEnv,
  keys: readonly string[],
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {}
  for (const key of keys) {
    const value = hostEnv[key]
    if (value !== undefined) env[key] = value
  }
  return { ...env, ...extra }
}

/** A Manor-issued per-turn token, not a connector secret. */
export function isCliGrantedEnvKey(key: string): boolean {
  return key.includes('CAPABILITY')
}

/** A minimal child environment plus explicitly granted capability keys. */
export function childProcessEnv(
  hostEnv: NodeJS.ProcessEnv = process.env,
  grantedKeys: readonly string[] = [],
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return pickEnv(hostEnv, [...PASS_THROUGH_KEYS, ...grantedKeys], extra)
}

/**
 * What an agent's own shell needs on top of the base list. `SSH_AUTH_SOCK` lets ssh
 * use a key the macOS agent holds, the way the user's Terminal and Manor's own push
 * do. It opens nothing new: the agent already reaches the user's keys and git sign
 * in through `HOME`. A Grok turn has a `HOME` of its own, where ssh still finds the
 * user's keys through the account and git finds no settings. Only a provider turn
 * gets it, never a probe or a status call.
 */
const AGENT_TURN_KEYS = ['SSH_AUTH_SOCK'] as const

/** The environment of a provider turn: the base list, the agent's own keys and the granted capability keys. */
export function agentTurnEnv(
  hostEnv: NodeJS.ProcessEnv = process.env,
  grantedKeys: readonly string[] = [],
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return pickEnv(hostEnv, [...PASS_THROUGH_KEYS, ...AGENT_TURN_KEYS, ...grantedKeys], extra)
}

/** Env for an upstream stdio MCP. No HOME, no sibling connector keys. */
export function upstreamProcessEnv(
  hostEnv: NodeJS.ProcessEnv = process.env,
  grantedKeys: readonly string[] = [],
): NodeJS.ProcessEnv {
  return pickEnv(hostEnv, [...UPSTREAM_PASS_THROUGH_KEYS, ...grantedKeys])
}

/** Resolves registry keys and per-turn capabilities into one isolated child env. */
export function attachedMcpEnvironment(
  attached: readonly AttachedMcpServer[],
  hostEnv: NodeJS.ProcessEnv = process.env,
): { sourceEnv: NodeJS.ProcessEnv; grantedKeys: string[] } {
  const runtimeEnv = Object.assign({}, ...attached.map(({ runtimeEnv: values }) => values ?? {}))
  const grantedKeys = [...new Set(attached.flatMap(({ server, runtimeEnv: values }) => [
    ...mcpEnvironmentKeys(server),
    ...Object.keys(values ?? {}),
  ]))].filter(isCliGrantedEnvKey)
  return { sourceEnv: { ...hostEnv, ...runtimeEnv }, grantedKeys }
}

/** Removes explicitly granted capability values before child output leaves Manor. */
export function redactGrantedEnvValues(
  text: string,
  hostEnv: NodeJS.ProcessEnv,
  grantedKeys: readonly string[],
): string {
  const values = [...new Set(grantedKeys)]
    .map((key) => hostEnv[key])
    .filter((value): value is string => value !== undefined && value.length > 0)
    .sort((left, right) => right.length - left.length)
  return values.reduce((redacted, value) => redacted.replaceAll(value, '[redacted]'), text)
}
