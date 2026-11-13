import type { AttachedMcpServer, McpServerConfig } from '@manor/contracts'
import {
  COMPOSIO_MCP_NAME,
  COMPOSIO_MULTI_EXECUTE_TOOL,
  COMPOSIO_SEARCH_TOOLS,
} from './composioAttachment.js'

/**
 * Common Composio slugs Manor already treats as first-class. SEARCH stays the
 * fallback for anything else; this list is not a complete toolkit inventory.
 */
const COMPOSIO_KNOWN_SLUGS: Readonly<Record<string, readonly string[]>> = {
  gmail: [
    'GMAIL_FETCH_EMAILS',
    'GMAIL_LIST_THREADS',
    'GMAIL_GET_PROFILE',
    'GMAIL_LIST_DRAFTS',
    'GMAIL_GET_DRAFT',
  ],
}

const qualified = (server: string, tool: string): string => `mcp__${server}__${tool}`

function nativeToolList(server: McpServerConfig, disabledTools: readonly string[]): string {
  const excluded = new Set(disabledTools)
  const enabled = server.tools.filter((tool) => !excluded.has(tool))
  if (server.tools.length === 0) return `mcp__${server.name}__*`
  if (enabled.length === 0) return 'none enabled'
  return enabled.map((tool) => qualified(server.name, tool)).join(', ')
}

function composioCatalog(server: McpServerConfig, disabledTools: readonly string[]): string {
  const description = server.description.length === 0 ? '' : ` — ${server.description}`
  const excluded = new Set(disabledTools)
  const enabled = server.tools.filter((tool) => !excluded.has(tool))
  const canExecute = enabled.includes(COMPOSIO_MULTI_EXECUTE_TOOL)
  const header = `- ${server.name}${description} (tools: ${nativeToolList(server, disabledTools)})`
  if (!canExecute) return header

  const apps = server.connectedApps ?? []
  const appLine = apps.length === 0
    ? '  No connected apps listed yet. Use COMPOSIO_SEARCH_TOOLS to find a slug, then COMPOSIO_MULTI_EXECUTE_TOOL.'
    : `  Connected apps: ${apps.map((app) =>
        app.aliases.length === 0 ? app.toolkit : `${app.toolkit} (${app.aliases.join(', ')})`,
      ).join('; ')}`
  const slugLines = apps.flatMap((app) => {
    const slugs = COMPOSIO_KNOWN_SLUGS[app.toolkit]
    return slugs === undefined ? [] : [`  ${app.toolkit} slugs: ${slugs.join(', ')}`]
  })
  return [
    header,
    appLine,
    `  Call ${qualified(COMPOSIO_MCP_NAME, COMPOSIO_MULTI_EXECUTE_TOOL)} with tool_slug and the personal or work alias. Do not call ${COMPOSIO_SEARCH_TOOLS} first when the slug is listed.`,
    ...slugLines,
    `  ${COMPOSIO_SEARCH_TOOLS} only for an app or slug that is not listed.`,
  ].join('\n')
}

/** One connections-block entry. Native servers name probed tools; Composio names connected apps. */
export function connectionCatalogEntry(attachment: AttachedMcpServer): string {
  const { server, disabledTools } = attachment
  if (server.name === COMPOSIO_MCP_NAME) return composioCatalog(server, disabledTools)
  const description = server.description.length === 0 ? '' : ` — ${server.description}`
  return `- ${server.name}${description} (tools: ${nativeToolList(server, disabledTools)})`
}
