import { COMPOSIO_ALIASES, type McpServerDraft } from '@manor/contracts'

export const COMPOSIO_MCP_NAME = 'composio'
export const COMPOSIO_API_KEY_ENV = 'COMPOSIO_API_KEY'
export const LEGACY_COMPOSIO_API_KEY_ENV = 'COMPOSIO_CONSUMER_API_KEY'
export const COMPOSIO_ACCOUNT_ALIASES = COMPOSIO_ALIASES
export const COMPOSIO_MANAGE_CONNECTIONS_TOOL = 'COMPOSIO_MANAGE_CONNECTIONS'
export const COMPOSIO_SEARCH_TOOLS = 'COMPOSIO_SEARCH_TOOLS'
export const COMPOSIO_MULTI_EXECUTE_TOOL = 'COMPOSIO_MULTI_EXECUTE_TOOL'
export const COMPOSIO_MCP_DESCRIPTION =
  `Search, connect and run tools across apps through Composio. When adding a connection, pass the requested ${COMPOSIO_ACCOUNT_ALIASES.join(' or ')} alias to COMPOSIO_MANAGE_CONNECTIONS; never create an unaliased connection. Pass that alias explicitly on every account-backed call. Can change external data.`
export const COMPOSIO_RECOVERY_DESCRIPTION =
  'Reconnect the missing personal Gmail account through Composio. Only connection management is available until it is active. Pass the personal alias to COMPOSIO_MANAGE_CONNECTIONS; never create an unaliased connection.'

export function composioApiKeyEnv(env: NodeJS.ProcessEnv): string | undefined {
  if (env[COMPOSIO_API_KEY_ENV]) return COMPOSIO_API_KEY_ENV
  if (env[LEGACY_COMPOSIO_API_KEY_ENV]) return LEGACY_COMPOSIO_API_KEY_ENV
  return undefined
}

/** One hosted tool router; individual app accounts stay inside Composio. */
export function composioMcpDraft(url: string, apiKeyEnv: string): McpServerDraft {
  return {
    name: COMPOSIO_MCP_NAME,
    command: '',
    args: [],
    envKeys: [apiKeyEnv],
    httpHeaders: [{ name: 'x-api-key', envKey: apiKeyEnv }],
    url,
    description: COMPOSIO_MCP_DESCRIPTION,
    writes: true,
    effectPolicy: 'confirm_writes',
  }
}

/** A fail-closed session that can only restore the account contract. */
export function composioRecoveryMcpDraft(url: string, apiKeyEnv: string): McpServerDraft {
  return {
    ...composioMcpDraft(url, apiKeyEnv),
    description: COMPOSIO_RECOVERY_DESCRIPTION,
  }
}
