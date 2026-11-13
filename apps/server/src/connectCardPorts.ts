import { mcpHttpUrl, type McpServerConfig } from '@manor/contracts'
import type { ConnectCardDeps } from './connectCards.js'
import { composioApiKeyEnv } from './mcp/composioAttachment.js'
import { composioActiveAccountIds, composioConnectState, type ComposioConnectState } from './mcp/composioRegistration.js'
import { beginMcpOAuth, openLoginBrowser } from './mcp/oauth.js'

type ConnectPorts = Pick<ConnectCardDeps, 'openUrl' | 'beginOAuth' | 'composioState' | 'composioBaseline'>

/** The real sign-in surfaces: the Mac's browser, Composio's account API, MCP OAuth. */
export function liveConnectCardPorts(mcpServers: () => readonly McpServerConfig[], env: NodeJS.ProcessEnv = process.env): ConnectPorts {
  const apiKey = () => {
    const name = composioApiKeyEnv(env)
    const key = name === undefined ? undefined : env[name]
    if (key === undefined || key.length === 0) throw new Error('The Composio API key is missing on this Manor host.')
    return key
  }
  return {
    openUrl: openLoginBrowser,
    composioState: (target) => composioConnectState(apiKey(), target),
    composioBaseline: (toolkit) => composioActiveAccountIds(apiKey(), toolkit),
    beginOAuth: async (serverId, onResult) => {
      const server = mcpServers().find((row) => row.id === serverId)
      const url = server === undefined ? undefined : mcpHttpUrl(server)
      if (url === undefined) throw new Error('That connection is no longer registered.')
      await beginMcpOAuth(url, { open: openLoginBrowser, onResult })
    },
  }
}

/**
 * Spike only: nothing opens and no account is touched. A sign-in lands after
 * `delayMs`; an app whose name contains "fail" fails instead. An account the spike's
 * mock Composio made (a Connectors page connect) answers from that mock instead.
 */
export function mockConnectCardPorts(
  delayMs = 8_000,
  accountState?: (accountId: string) => ComposioConnectState | undefined,
): ConnectPorts {
  const opened = new Map<string, number>()
  const failing = (name: string) => name.toLowerCase().includes('fail')
  return {
    openUrl: async (url) => { opened.set(url, Date.now()) },
    composioBaseline: async () => [],
    composioState: async ({ toolkit, accountId }) => {
      const known = accountId === undefined ? undefined : accountState?.(accountId)
      if (known !== undefined) return known
      const at = Math.max(0, ...[...opened.entries()].filter(([url]) => url.includes(toolkit)).map(([, time]) => time))
      if (at === 0 || Date.now() - at < delayMs) return { status: 'pending' }
      return failing(toolkit) ? { status: 'failed', reason: 'Composio reported the sign-in as failed.' } : { status: 'active' }
    },
    beginOAuth: async (serverId, onResult) => {
      setTimeout(() => onResult(failing(serverId)
        ? { status: 'failed', reason: 'The sign-in was cancelled.' }
        : { status: 'connected' }), delayMs).unref()
    },
  }
}
