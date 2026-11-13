import type { McpServerConfig, McpServerDraft } from '@manor/contracts'
import type { Store } from '../store.js'
import { CODEX_COMPUTER_MCP_NAME } from '../computerPolicy.js'
import { builtInMcpArgs, nodeRuntimeEnvKeys } from './browserAttachment.js'
import { resolveCodexComputer } from './codexComputerLaunch.js'
import { reconcileDerivedServer } from './mailRegistration.js'

/**
 * The registry row for Codex's computer-use engine. A row rather than a built-in, so
 * which personas get it next to Cua stays a per-persona call; Single sessions skip it.
 * The description is the usage note personas read, taken from the engine's own docs.
 */
export function codexComputerMcpDraft(
  runtime: { execPath?: string; execArgv?: readonly string[]; entryPath?: string } = {},
): McpServerDraft {
  return {
    name: CODEX_COMPUTER_MCP_NAME,
    command: runtime.execPath ?? process.execPath,
    args: builtInMcpArgs('codexComputer', runtime),
    // The launcher finds the ChatGPT app's plugin under HOME.
    envKeys: ['HOME', ...nodeRuntimeEnvKeys()],
    description: 'Use Mac apps through Codex\'s computer-use engine by running JavaScript in js. ' +
      'Make the first call of a turn only `let app = await cua.getApp("Calculator")` (name, path or bundle id; it ' +
      'opens the app in the background), or `await cua.getState()` for an inventory, and read the docs and UI state it ' +
      'returns. Then act on element indices from that state (app.click(n), app.setValue(n, text), app.pressKey("super+a"), ' +
      'app.drag([x, y], [x, y])) and end the same call with `await app.getAXState()`. A step is done only when the ' +
      'returned state shows it. The first call asks to borrow the Mac; Escape stops it.',
    writes: true,
    effectPolicy: 'confirm_writes',
  }
}

/**
 * Re-points the row at this runtime like the other derived rows, and keeps it visible
 * but off every turn while the ChatGPT app or its plugin is missing on this Mac.
 */
export async function reconcileCodexComputerServer(
  store: Store,
  registry: readonly McpServerConfig[],
  hostEnv: NodeJS.ProcessEnv = process.env,
): Promise<McpServerConfig[]> {
  const next = await reconcileDerivedServer(store, registry, codexComputerMcpDraft())
  try {
    resolveCodexComputer(hostEnv)
    return next
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : 'Codex computer use is unavailable on this Mac.'
    return next.map((server) => server.name === CODEX_COMPUTER_MCP_NAME ? { ...server, unavailable: reason } : server)
  }
}
