import { z } from 'zod'

/**
 * Connect cards: an agent needed an account that is not connected, and Manor shows a
 * card instead of a sign-in link in the text. `composio` is an app behind
 * COMPOSIO_MANAGE_CONNECTIONS; `mcp_oauth` is a remote HTTP MCP row that answered 401.
 * The sign-in link itself never enters the transcript; the server holds it and opens
 * it on the Mac when the user clicks.
 */
export const CONNECT_CARD_KINDS = ['composio', 'mcp_oauth'] as const
export type ConnectCardKind = (typeof CONNECT_CARD_KINDS)[number]

export const ConnectRequestEventSchema = z.object({
  id: z.string(),
  ts: z.number(),
  type: z.literal('connect_request'),
  agentId: z.string(),
  turnId: z.string(),
  connectId: z.string().min(1).max(120),
  kind: z.enum(CONNECT_CARD_KINDS),
  /** Composio toolkit slug or the MCP row's name. */
  app: z.string().min(1).max(80),
  alias: z.string().min(1).max(40).optional(),
  /** The MCP row a `mcp_oauth` card signs in, so a click after a restart still works. */
  serverId: z.string().min(1).max(120).optional(),
})

/** Latest one wins. No status yet means the card waits for its first click. */
export const ConnectStatusEventSchema = z.object({
  id: z.string(),
  ts: z.number(),
  type: z.literal('connect_status'),
  agentId: z.string(),
  turnId: z.string(),
  connectId: z.string().min(1).max(120),
  status: z.enum(['waiting', 'connected', 'failed']),
  reason: z.string().max(300).optional(),
  /** Connected after the agent stopped waiting: the tools arrive on the next message. */
  nextMessage: z.literal(true).optional(),
  /** Failed for good: the link is gone, so Retry would only fail again. */
  final: z.literal(true).optional(),
})

export const OpenConnectCardMessageSchema = z.object({
  type: z.literal('open_connect_card'),
  chatId: z.string(),
  connectId: z.string().min(1).max(120),
})

/**
 * A Composio sign-in link, which is single-use: fetching it (a preview, an image load,
 * a prefetch) consumes it. Only the user's own click may open one.
 */
export function isSingleUseConnectLink(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.hostname === 'connect.composio.dev') return url.pathname.startsWith('/link/')
    return url.hostname === 'backend.composio.dev' && url.pathname.startsWith('/api/v3/s/')
  } catch {
    return false
  }
}
