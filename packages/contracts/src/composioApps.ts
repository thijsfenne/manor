import { z } from 'zod'

/**
 * The Connectors page's Composio marketplace: the app catalogue, which apps are
 * connected under which alias, and the connects the user started from the page. Every
 * account carries one of these aliases; Manor never creates an unaliased connection.
 */
export const COMPOSIO_ALIASES = ['personal', 'work'] as const
export type ComposioAlias = (typeof COMPOSIO_ALIASES)[number]
export const ComposioAliasSchema = z.enum(COMPOSIO_ALIASES)

/**
 * How an app connects from the page. `one_click` has a sign-in Composio or this
 * project already holds; `no_auth` needs no account at all; `own_credentials` needs
 * an auth config set up in Composio first, so the page offers no Connect for it.
 */
export const COMPOSIO_CONNECT_KINDS = ['one_click', 'no_auth', 'own_credentials'] as const

/**
 * The app's brand mark. Composio's logo host answers every slug, with a generic mark
 * for an app it has none for, so clients hotlink it (CSP allows this one image host)
 * instead of the 50-odd hosts the catalogue's own logo field points at.
 */
export const COMPOSIO_LOGO_ORIGIN = 'https://logos.composio.dev'
export const composioLogoUrl = (slug: string): string => `${COMPOSIO_LOGO_ORIGIN}/api/${encodeURIComponent(slug)}`

export const ComposioAppSchema = z.object({
  slug: z.string().min(1).max(120),
  name: z.string().min(1).max(200),
  description: z.string().max(400),
  categories: z.array(z.string().max(80)).max(12),
  connect: z.enum(COMPOSIO_CONNECT_KINDS),
})
export type ComposioApp = z.infer<typeof ComposioAppSchema>

export const ComposioConnectedAppSchema = z.object({
  toolkit: z.string(),
  aliases: z.array(z.string()),
})
export type ComposioConnectedApp = z.infer<typeof ComposioConnectedAppSchema>

/** A connect started from the page, followed like a chat connect card. Latest per app and alias wins. */
export const ComposioPageConnectSchema = z.object({
  toolkit: z.string().min(1).max(120),
  alias: ComposioAliasSchema,
  status: z.enum(['waiting', 'connected', 'failed']),
  reason: z.string().max(300).optional(),
})
export type ComposioPageConnect = z.infer<typeof ComposioPageConnectSchema>

const toolkit = z.string().min(1).max(120)

export const ListComposioAppsMessageSchema = z.object({ type: z.literal('list_composio_apps') })

/** The user's click on Connect: the server makes a fresh single-use link and opens it on the Mac. */
export const ConnectComposioAppMessageSchema = z.object({
  type: z.literal('connect_composio_app'),
  toolkit,
  alias: ComposioAliasSchema,
  requestId: z.string().min(1).max(120).optional(),
})

/** Removes the app's accounts under that alias for every agent; null removes its unaliased ones. */
export const DisconnectComposioAppMessageSchema = z.object({
  type: z.literal('disconnect_composio_app'),
  toolkit,
  alias: ComposioAliasSchema.nullable(),
  requestId: z.string().min(1).max(120).optional(),
})

/** Reply-only: the catalogue is large and only the page that opens asks for it. */
export const ComposioCatalogMessageSchema = z.object({
  type: z.literal('composio_catalog'),
  apps: z.array(ComposioAppSchema).max(10_000),
  unavailable: z.string().max(300).optional(),
})

/** Small and broadcast after every change, so each open page follows the same accounts. */
export const ComposioAccountsMessageSchema = z.object({
  type: z.literal('composio_accounts'),
  connected: z.array(ComposioConnectedAppSchema),
  connects: z.array(ComposioPageConnectSchema),
  unavailable: z.string().max(300).optional(),
})

/**
 * Where this host's Composio API key comes from. `manor` is the data folder's `.env`,
 * written from the Connectors page, so only that one can be replaced or removed there.
 * `environment` is the server's own environment and `checkout` is `apps/server/.env`.
 * The key itself never leaves the server.
 */
export const COMPOSIO_KEY_SOURCES = ['none', 'manor', 'environment', 'checkout'] as const
export type ComposioKeySource = (typeof COMPOSIO_KEY_SOURCES)[number]

/** Sent once from the Connectors page. The server checks it with Composio before it keeps it. */
export const SetComposioKeyMessageSchema = z.object({
  type: z.literal('set_composio_key'),
  key: z.string().max(4096),
  requestId: z.string().min(1).max(120).optional(),
})

/** Removes the key Manor keeps; accounts on Composio's side stay as they are. */
export const RemoveComposioKeyMessageSchema = z.object({
  type: z.literal('remove_composio_key'),
  requestId: z.string().min(1).max(120).optional(),
})

/** Sent on connect and broadcast after every change. Never carries the key. */
export const ComposioKeyMessageSchema = z.object({
  type: z.literal('composio_key'),
  source: z.enum(COMPOSIO_KEY_SOURCES),
})
