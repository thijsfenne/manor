import os from 'node:os'
import path from 'node:path'
import { CodexInstallation } from './codexInstallation.js'

/**
 * Where Manor keeps the Codex releases it installs. Deliberately under the home
 * folder, not `MANOR_DATA_DIR`: the live app, spikes and worktree checkouts all run
 * the one active release. `MANOR_TOOLS_DIR` moves it for a one-off experiment.
 */
export function codexToolsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env['MANOR_TOOLS_DIR']?.trim() || path.join(os.homedir(), '.manor', 'tools'), 'codex')
}

/**
 * `MANOR_CODEX_COMMAND` is the escape hatch for a one-off binary, which Manor then
 * neither installs nor updates. The global `codex` on PATH is never used.
 */
export function codexCommandOverride(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env['MANOR_CODEX_COMMAND']?.trim() || undefined
}

let shared: CodexInstallation | undefined

/** One per process, so every Codex driver waits on the same install. */
export function sharedCodexInstallation(): CodexInstallation {
  shared ??= new CodexInstallation({ root: codexToolsRoot() })
  return shared
}
