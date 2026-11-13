import type { McpServerConfig, McpServerDraft } from '@manor/contracts'
import type { Store } from '../store.js'
import { builtInMcpArgs, nodeRuntimeEnvKeys } from './browserAttachment.js'
import { CALENDAR_ENV_KEYS, ICLOUD_CALENDAR_MCP_NAME } from './calendarCreate.js'
import { reconcileDerivedServer } from './mailRegistration.js'

/**
 * The registry row for the iCloud calendar. A row rather than a built-in for the
 * same reason as mail: it is a credential, and which personas hold it is the user's
 * per-persona call. `confirm_writes` is belt and braces; `create_event` asks a human
 * through the broker's always-ask list whatever the row says.
 */
export function calendarMcpDraft(
  runtime: { execPath?: string; execArgv?: readonly string[]; entryPath?: string } = {},
): McpServerDraft {
  return {
    name: ICLOUD_CALENDAR_MCP_NAME,
    command: runtime.execPath ?? process.execPath,
    args: builtInMcpArgs('calendar', runtime),
    envKeys: [...CALENDAR_ENV_KEYS, ...nodeRuntimeEnvKeys()],
    description: 'Read the user’s iCloud calendars, find free time, and create events after their approval. Cannot edit or delete.',
    writes: true,
    effectPolicy: 'confirm_writes',
  }
}

/** Re-points the derived row at this runtime at startup, exactly like the mail rows. Never fatal. */
export function reconcileCalendarServer(
  store: Store,
  registry: readonly McpServerConfig[],
): Promise<McpServerConfig[]> {
  return reconcileDerivedServer(store, registry, calendarMcpDraft())
}
