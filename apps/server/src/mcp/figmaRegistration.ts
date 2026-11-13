import type { McpServerConfig, McpServerDraft } from '@manor/contracts'
import type { Store } from '../store.js'
import { FIGMA_REMOTE_TOOLS, figmaMcpDraft } from './figmaAttachment.js'
import { probeMcpServer } from './probe.js'

export async function probeFigmaRow(
  draft: McpServerDraft,
): Promise<{ tools: string[]; readOnlyTools: string[]; schemaChars: number; oauthPending: boolean }> {
  try {
    const probed = await probeMcpServer(draft)
    return { tools: probed.tools, readOnlyTools: probed.readOnlyTools, schemaChars: probed.schemaChars, oauthPending: false }
  } catch (error: unknown) {
    if (!isOauthRequired(error)) throw error
    return { tools: [...FIGMA_REMOTE_TOOLS], readOnlyTools: [], schemaChars: 0, oauthPending: true }
  }
}

function isOauthRequired(error: unknown): boolean {
  return error instanceof Error && error.message.includes('requires OAuth (HTTP 401)')
}

/**
 * Keeps the derived Figma row pointing at the remote MCP URL, at every startup.
 *
 * A 401 is not a failure here. OAuth is the CLI's. Any other probe error is a
 * warning and is never a startup failure.
 */
export async function reconcileFigmaServer(
  store: Store,
  registry: readonly McpServerConfig[],
): Promise<McpServerConfig[]> {
  const existing = registry.find((server) => server.name === figmaMcpDraft().name)
  if (existing === undefined) return [...registry]

  const derived = figmaMcpDraft()
  const draft = figmaRowDraft(existing, derived)
  if (figmaRuntimeUnchanged(existing, draft)) return [...registry]

  try {
    const probed = await probeFigmaRow(draft)
    const saved = await store.saveMcpServer(draft, probed)
    console.warn(`[manor] figma connector re-pointed at ${derived.url} (${probed.tools.length} tools)`)
    return registry.map((server) => (server.id === saved.id ? saved : server))
  } catch (error: unknown) {
    console.warn(
      `[manor] the figma connector could not be re-pointed: ${
        error instanceof Error ? error.message : 'probe failed'
      }`,
    )
    return [...registry]
  }
}

export function figmaRowDraft(
  existing: McpServerConfig,
  derived: McpServerDraft,
): McpServerDraft & { id: string } {
  return {
    ...derived,
    id: existing.id,
    envKeys: [...new Set([...derived.envKeys, ...existing.envKeys])],
  }
}

export function figmaRuntimeUnchanged(existing: McpServerConfig, derived: McpServerDraft): boolean {
  return (existing.url ?? '') === (derived.url ?? '') && existing.command === derived.command
}
