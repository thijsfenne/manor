import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Where the ChatGPT app unpacks Codex's computer-use plugin, one folder per version. */
export const CODEX_COMPUTER_PLUGIN_DIR = '.codex/plugins/cache/openai-bundled/unified-computer-use'

/**
 * The plugin's own env, cut to what the computer surface reads. The browser keys stay
 * behind: Manor has its own browser, and `CUA_REPL_ENABLED_SURFACES` below turns the
 * engine's off. Without `NODE_REPL_TRUSTED_SERVICES` the launcher trusts only the
 * services of the enabled surfaces.
 */
const PLUGIN_ENV_KEYS = [
  'NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS',
  'NODE_REPL_NODE_MODULE_DIRS',
  'NODE_REPL_NODE_PATH',
  'NODE_REPL_TRUSTED_CODE_PATHS',
  'NODE_REPL_INSTRUCTIONS_USE_CASE_COMPUTER_USE',
  'CODEX_HOME',
  'SKY_CUA_SERVICE_PATH',
  'CUA_REPL_NODE_REPL_PATH',
] as const

/** Host values the engine inherits; the effect proxy has already cut its own env to these. */
const HOST_ENV_KEYS = ['HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL'] as const

export interface CodexComputerLaunch {
  version: string
  command: string
  args: string[]
  env: Record<string, string>
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Numeric, so 26.1000.0 sorts after 26.999.0. */
function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

/**
 * Reads the newest installed plugin's `cua_repl` server on every start, so a ChatGPT
 * update needs no re-registration. Throws a message the user can act on when the ChatGPT
 * app, the plugin or the Computer Use helper is missing.
 */
export function resolveCodexComputer(hostEnv: NodeJS.ProcessEnv): CodexComputerLaunch {
  const home = hostEnv.HOME
  if (home === undefined || home === '') throw new Error('HOME is not set, so the Codex plugin cannot be found.')
  const pluginDir = join(home, CODEX_COMPUTER_PLUGIN_DIR)
  const notInstalled = `Codex computer use is not installed: no plugin under ~/${CODEX_COMPUTER_PLUGIN_DIR}. ` +
    'Open the ChatGPT app, turn on Computer Use for Codex once, and retry.'
  if (!existsSync(pluginDir)) throw new Error(notInstalled)
  const version = readdirSync(pluginDir)
    .filter((name) => /^\d+(\.\d+)*$/.test(name) && existsSync(join(pluginDir, name, '.mcp.json')))
    .sort(compareVersions)
    .at(-1)
  if (version === undefined) throw new Error(notInstalled)

  const manifest = join(pluginDir, version, '.mcp.json')
  let server: unknown
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'))
    server = record(parsed) && record(parsed.mcpServers) ? parsed.mcpServers.cua_repl : undefined
  } catch {
    server = undefined
  }
  if (!record(server) || typeof server.command !== 'string' || !Array.isArray(server.args) ||
    !server.args.every((arg) => typeof arg === 'string') || !record(server.env)) {
    throw new Error(`Codex computer use ${version} has no cua_repl server in ${manifest}; update the ChatGPT app.`)
  }
  const pluginEnv = server.env
  const env: Record<string, string> = {}
  for (const key of HOST_ENV_KEYS) {
    const value = hostEnv[key]
    if (value !== undefined && value !== '') env[key] = value
  }
  for (const key of PLUGIN_ENV_KEYS) {
    const value = pluginEnv[key]
    if (typeof value === 'string' && value !== '') env[key] = value
  }
  env.CUA_REPL_ENABLED_SURFACES = 'computer'

  const args = server.args as string[]
  const runtime = [server.command, args[0], env.CUA_REPL_NODE_REPL_PATH].filter((path) => path !== undefined)
  const missing = runtime.find((path) => !existsSync(path))
  if (missing !== undefined || runtime.length < 3) {
    throw new Error(`The ChatGPT app is missing or incomplete: ${missing ?? 'its cua_repl runtime'} does not exist. ` +
      'Install or update ChatGPT for Mac and retry.')
  }
  const helper = env.SKY_CUA_SERVICE_PATH
  if (helper === undefined || !existsSync(helper)) {
    throw new Error(`Codex Computer Use.app is missing${helper === undefined ? '' : ` at ${helper}`}. ` +
      'Open the ChatGPT app, turn on Computer Use for Codex once, and retry.')
  }
  return { version, command: server.command, args, env }
}
