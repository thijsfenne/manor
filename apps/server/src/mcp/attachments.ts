import type { AgentConfig, AttachedMcpServer, McpServerConfig } from '@manor/contracts'
import { mcpHttpUrl } from '@manor/contracts'
import { accessTokenFor, mcpBearerEnvKey } from './oauth.js'

/**
 * A persona's attachments with their registry rows filled in, in registry order.
 *
 * An attachment naming a server the registry no longer has is dropped rather than
 * treated as an error. Deleting a server detaches it everywhere (see `Store`), so a
 * dangling id should not exist; if one ever does, the honest reading is "this persona
 * does not have that server" and a turn that refuses to start would be a worse
 * outcome than a turn that runs with one capability missing.
 *
 * Registry order rather than attachment order so the rendered argv is stable: the
 * Claude driver's `--mcp-config` becomes part of the request, and a config whose key
 * order shuffles between turns would invalidate the cached conversation prefix.
 */
export function resolveAttachments(
  agent: AgentConfig,
  registry: readonly McpServerConfig[],
): AttachedMcpServer[] {
  if (agent.mcpServers.length === 0) return []
  const wanted = new Map(agent.mcpServers.map((attachment) => [attachment.serverId, attachment]))
  const resolved: AttachedMcpServer[] = []
  for (const server of registry) {
    const attachment = wanted.get(server.id)
    if (attachment === undefined || server.unavailable !== undefined) continue
    resolved.push({ server, disabledTools: [...attachment.disabledTools] })
  }
  return resolved
}

/** Adds a live bearer from the on-disk OAuth store, never from the registry row. */
export async function withMcpOAuth(
  attached: readonly AttachedMcpServer[],
): Promise<AttachedMcpServer[]> {
  const next: AttachedMcpServer[] = []
  for (const item of attached) {
    const url = mcpHttpUrl(item.server)
    const token = url === undefined ? undefined : await accessTokenFor(url)
    if (token === undefined) {
      next.push(item)
      continue
    }
    const key = mcpBearerEnvKey(item.server.name)
    next.push({
      ...item,
      runtimeEnv: { ...item.runtimeEnv, [key]: token },
    })
  }
  return next
}
