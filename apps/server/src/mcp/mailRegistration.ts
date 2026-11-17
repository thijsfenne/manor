import type { McpServerConfig, McpServerDraft } from '@manor/contracts'
import type { Store } from '../store.js'
import { probeMcpServer } from './probe.js'
import { mailMcpDraft } from './mailAttachment.js'

/**
 * Keeps every derived mail row's `command` and `args` matching the runtime that
 * will actually spawn it, at every startup.
 *
 * Registry rows normally hold what a human typed, which is fine for `npx some-mcp`.
 * These are different: their args carry an absolute Node path and an absolute path
 * into a pnpm-hashed `tsx` directory, both derived from the process that registered
 * them. Written once, that row is a landmine. Upgrade tsx and the path it points at
 * no longer exists, and the connector fails at spawn with a message about a missing
 * file rather than anything resembling "your mail server moved".
 *
 * So the rows are derived, not authored. If a catalog account is absent nothing
 * happens here, because registering a connection stays the user's decision; if it is
 * present it is corrected to this runtime and re-probed, so the stored tool list
 * and schema cost describe the code on disk rather than the code that was on disk
 * the day it was registered.
 *
 * A probe failure is a warning, never a startup failure. The mailbox being
 * unreachable is not a reason for the house not to open.
 */
export async function reconcileMailServers(
  store: Store,
  registry: readonly McpServerConfig[],
): Promise<McpServerConfig[]> {
  return reconcileDerivedServer(store, [...registry], mailMcpDraft())
}

/**
 * Only the runtime is re-derived. Anything the user added to the row by hand survives,
 * which for mail means the optional host and port keys a non-Gmail account needs:
 * dropping them would leave the connector quietly talking to Gmail with somebody
 * else's credentials, and the row would look correct while doing it.
 */
export function derivedRowDraft(existing: McpServerConfig, derived: McpServerDraft): McpServerDraft & { id: string } {
  return {
    ...derived,
    id: existing.id,
    envKeys: [...new Set([...derived.envKeys, ...existing.envKeys])],
  }
}

export function derivedRuntimeUnchanged(existing: McpServerConfig, derived: McpServerDraft): boolean {
  return (
    existing.command === derived.command &&
    existing.args.length === derived.args.length &&
    existing.args.every((argument, index) => argument === derived.args[index])
  )
}

/**
 * Whether a stored row still matches what this build derives. The env keys and the
 * description count as much as the runtime: a key a newer build added only reaches the
 * connector's process once the row lists it, and agents read the description as what
 * the connector does.
 */
export function derivedRowCurrent(existing: McpServerConfig, derived: McpServerDraft): boolean {
  return derivedRuntimeUnchanged(existing, derived) &&
    existing.description === derived.description &&
    derived.envKeys.every((key) => existing.envKeys.includes(key))
}

/**
 * Re-points one derived stdio row (mail, the iCloud calendar) at this runtime and
 * re-probes it. An absent row stays absent; a probe failure warns and never blocks
 * startup.
 */
export async function reconcileDerivedServer(
  store: Store,
  registry: readonly McpServerConfig[],
  derived: McpServerDraft,
): Promise<McpServerConfig[]> {
  const existing = registry.find((server) => server.name === derived.name)
  if (existing === undefined) return [...registry]

  const draft = derivedRowDraft(existing, derived)
  if (derivedRowCurrent(existing, derived)) return [...registry]

  try {
    const probed = await probeMcpServer(draft)
    const saved = await store.saveMcpServer(draft, probed)
    console.warn(`[manor] ${derived.name} connector re-pointed at this runtime (${probed.tools.length} tools)`)
    return registry.map((server) => (server.id === saved.id ? saved : server))
  } catch (error: unknown) {
    console.warn(
      `[manor] the ${derived.name} connector could not be re-pointed at this runtime: ${
        error instanceof Error ? error.message : 'probe failed'
      }`,
    )
    return [...registry]
  }
}
