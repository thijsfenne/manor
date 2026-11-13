import type { McpServerConfig, McpServerDraft } from '@manor/contracts'
import type { Store } from '../store.js'
import { builtInMcpArgs, nodeRuntimeEnvKeys } from './browserAttachment.js'
import { reconcileDerivedServer } from './mailRegistration.js'
import { APPLE_REMINDERS_MCP_NAME } from './remindersWrite.js'

/**
 * The registry row for Apple Reminders. A row rather than a built-in so which
 * personas hold the user's reminders stays their per-persona call. Creating runs without a
 * card; completing and deleting ask a human through the broker's always-ask list
 * whatever the row says.
 */
export function remindersMcpDraft(
  runtime: { execPath?: string; execArgv?: readonly string[]; entryPath?: string } = {},
): McpServerDraft {
  return {
    name: APPLE_REMINDERS_MCP_NAME,
    command: runtime.execPath ?? process.execPath,
    args: builtInMcpArgs('reminders', runtime),
    // RemCTL lives under ~/bin and both CLIs resolve their state under HOME.
    // The shared list names reach the connector's own process, where deletes are refused.
    envKeys: ['HOME', 'MANOR_REMINDERS_SHARED_LISTS', ...nodeRuntimeEnvKeys()],
    description: 'Read and create the user’s Apple Reminders, and complete or delete one after their approval. Cannot edit.',
    writes: true,
    effectPolicy: 'confirm_writes',
  }
}

/** Re-points the derived row at this runtime at startup, exactly like the mail rows. Never fatal. */
export function reconcileRemindersServer(
  store: Store,
  registry: readonly McpServerConfig[],
): Promise<McpServerConfig[]> {
  return reconcileDerivedServer(store, registry, remindersMcpDraft())
}
