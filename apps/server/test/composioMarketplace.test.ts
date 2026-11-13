import { describe, expect, it, vi } from 'vitest'
import { ClientMessageSchema, type ComposioApp, type McpServerConfig, type ServerMessage } from '@manor/contracts'
import { ComposioMarketplace, type ComposioMarketplacePorts } from '../src/composioMarketplace.js'
import { mockComposio } from '../src/composioMarketplacePorts.js'
import { ConnectCards } from '../src/connectCards.js'
import { mockConnectCardPorts } from '../src/connectCardPorts.js'
import { COMPOSIO_MCP_DESCRIPTION, COMPOSIO_MCP_NAME, COMPOSIO_RECOVERY_DESCRIPTION } from '../src/mcp/composioAttachment.js'
import { fetchComposioCatalog } from '../src/mcp/composioCatalog.js'
import { composioSessionId, createComposioConnectLink, disconnectComposioApp } from '../src/mcp/composioRegistration.js'
import { connectionCatalogEntry } from '../src/mcp/capabilityCatalog.js'

const app = (slug: string, connect: ComposioApp['connect'] = 'one_click'): ComposioApp =>
  ({ slug, name: slug, description: '', categories: [], connect })

const composioRow: McpServerConfig = {
  id: 'row-composio', name: COMPOSIO_MCP_NAME, command: '', args: [], envKeys: ['COMPOSIO_API_KEY'],
  url: 'https://backend.composio.dev/tool_router/trs_abc/mcp', description: COMPOSIO_MCP_DESCRIPTION,
  writes: true, effectPolicy: 'confirm_writes', tools: ['COMPOSIO_MULTI_EXECUTE_TOOL'], readOnlyTools: [], schemaChars: 0,
  connectedApps: [{ toolkit: 'gmail', aliases: ['personal'] }],
}

function marketplace(ports: Partial<ComposioMarketplacePorts> = {}, options: { now?: () => number; openPage?: ConnectCards['openPage'] } = {}) {
  let registry: McpServerConfig[] = [composioRow]
  const sent: ServerMessage[] = []
  const all: ComposioMarketplacePorts = {
    catalog: async () => [app('gmail'), app('github'), app('stripe', 'own_credentials')],
    connectedApps: async () => [{ toolkit: 'gmail', aliases: ['personal'] }],
    createLink: async () => ({ url: 'https://connect.composio.dev/link/lk_1', accountId: 'ca_1' }),
    disconnect: async () => 1,
    ...ports,
  }
  const market = new ComposioMarketplace({
    ports: all,
    openPage: options.openPage ?? (async () => undefined),
    mcpServers: () => registry,
    setMcpServers: (next) => { registry = [...next] },
    broadcast: (message) => { sent.push(message) },
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  return { market, sent, registry: () => registry }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('the Composio catalogue', () => {
  it('forgets the old key\'s catalogue on a key change, and starts from the one the new key was checked with', async () => {
    const catalog = vi.fn(async () => [app('gmail')])
    const { market } = marketplace({ catalog })
    await market.catalog()
    market.reset([app('github')])
    expect(await market.catalog()).toEqual([app('github')])
    expect(catalog).toHaveBeenCalledTimes(1)
    market.reset()
    expect(await market.catalog()).toEqual([app('gmail')])
    expect(catalog).toHaveBeenCalledTimes(2)
  })

  it('fetches once per TTL, shares a concurrent fetch, and keeps the last good copy when a refresh fails', async () => {
    let clock = 0
    const catalog = vi.fn(async () => [app('gmail')])
    const { market } = marketplace({ catalog }, { now: () => clock })
    await Promise.all([market.catalog(), market.catalog()])
    clock = 60 * 60_000
    await market.catalog()
    expect(catalog).toHaveBeenCalledTimes(1)

    clock = 7 * 60 * 60_000
    catalog.mockRejectedValueOnce(new Error('offline'))
    expect(await market.catalog()).toEqual([app('gmail')])
    expect(catalog).toHaveBeenCalledTimes(2)
  })

  it('reads every page and marks which apps connect in one click', async () => {
    const toolkit = (slug: string, extra: Record<string, unknown>) => ({
      slug, name: slug.toUpperCase(), meta: { description: `${slug} tools`, categories: [{ id: 'x', name: 'productivity' }] },
      composio_managed_auth_schemes: [], auth_schemes: ['OAUTH2'], no_auth: false, ...extra,
    })
    const request = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/auth_configs')) return json({ items: [{ toolkit: { slug: 'twitter' }, status: 'ENABLED' }], next_cursor: null })
      if (url.searchParams.get('cursor') === null) {
        return json({ items: [toolkit('gmail', { composio_managed_auth_schemes: ['OAUTH2'] }), toolkit('granola', { auth_schemes: ['DCR_OAUTH'] })], next_cursor: 'p2' })
      }
      return json({ items: [toolkit('twitter', {}), toolkit('weather', { no_auth: true }), toolkit('stripe', {})], next_cursor: null })
    })
    const apps = await fetchComposioCatalog('key', request as typeof fetch)
    expect(Object.fromEntries(apps.map((item) => [item.slug, item.connect]))).toEqual({
      gmail: 'one_click', granola: 'one_click', twitter: 'one_click', weather: 'no_auth', stripe: 'own_credentials',
    })
    expect(apps[0]).toMatchObject({ name: 'GMAIL', description: 'gmail tools', categories: ['productivity'] })
    expect(request).toHaveBeenCalledTimes(3)
  })
})

describe('connecting from the page', () => {
  it('asks Composio for a link under the chosen alias on the registered session', async () => {
    const request = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      json({ redirect_url: 'https://connect.composio.dev/link/lk_9', connected_account_id: 'ca_9', link_token: 't' }, 201))
    const link = await createComposioConnectLink('key', composioSessionId(composioRow, 'github'), 'github', 'work', request as typeof fetch)
    expect(link).toEqual({ url: 'https://connect.composio.dev/link/lk_9', accountId: 'ca_9' })
    const [url, init] = request.mock.calls[0]!
    expect(String(url)).toBe('https://backend.composio.dev/api/v3.1/tool_router/session/trs_abc/link')
    expect(JSON.parse(String(init?.body))).toEqual({ toolkit: 'github', alias: 'work' })
  })

  it('refuses an unaliased connect before Composio sees it, on the wire and at the API edge', async () => {
    expect(ClientMessageSchema.safeParse({ type: 'connect_composio_app', toolkit: 'github' }).success).toBe(false)
    expect(ClientMessageSchema.safeParse({ type: 'connect_composio_app', toolkit: 'github', alias: 'team' }).success).toBe(false)
    const request = vi.fn()
    await expect(createComposioConnectLink('key', 'trs_abc', 'github', '', request as typeof fetch)).rejects.toThrow(/personal or work/)
    expect(request).not.toHaveBeenCalled()
  })

  it('lets a recovery session restore only Gmail, and refuses a link on a foreign host', async () => {
    const recovery = { ...composioRow, description: COMPOSIO_RECOVERY_DESCRIPTION }
    expect(() => composioSessionId(recovery, 'github')).toThrow(/recovery/)
    expect(composioSessionId(recovery, 'gmail')).toBe('trs_abc')
    const request = async () => json({ redirect_url: 'https://evil.example/link', connected_account_id: 'ca_1' })
    await expect(createComposioConnectLink('key', 'trs_abc', 'github', 'personal', request as typeof fetch)).rejects.toThrow(/no usable/)
  })

  it('follows the sign-in from waiting to Connected, and agents see the app without a restart', async () => {
    const mock = mockComposio(0)
    let market: ComposioMarketplace | undefined
    const cards = new ConnectCards({
      ...mockConnectCardPorts(0, mock.accountState),
      recordRequest: async () => true,
      appendStatus: async () => undefined,
      loadEvents: async () => [],
      afterComposioConnect: async () => market?.refreshConnected(),
      pollMs: 5,
    })
    const harness = marketplace(mock.ports, { openPage: (link, report) => cards.openPage(link, report) })
    market = harness.market
    const ack = vi.fn()

    await market.handle({ type: 'connect_composio_app', toolkit: 'linear', alias: 'work' }, () => undefined, ack)
    expect(ack).toHaveBeenCalled()
    await vi.waitFor(() => {
      const row = harness.registry().find((server) => server.name === COMPOSIO_MCP_NAME)
      expect(row?.connectedApps).toContainEqual({ toolkit: 'linear', aliases: ['work'] })
    })
    const statuses = harness.sent.flatMap((message) => message.type === 'composio_accounts'
      ? message.connects.filter((connect) => connect.toolkit === 'linear').map((connect) => connect.status)
      : [])
    expect(statuses[0]).toBe('waiting')
    expect(statuses.at(-1)).toBe('connected')
    expect(harness.sent.some((message) => message.type === 'mcp_servers')).toBe(true)

    const row = harness.registry().find((server) => server.name === COMPOSIO_MCP_NAME)!
    expect(connectionCatalogEntry({ server: row, disabledTools: [] })).toContain('linear (work)')
  })

  it('makes one link when Connect is pressed twice at once', async () => {
    const createLink = vi.fn(async () => ({ url: 'https://connect.composio.dev/link/lk_1', accountId: 'ca_1' }))
    const { market } = marketplace({ createLink })
    await market.catalog()
    const press = () => market.handle({ type: 'connect_composio_app', toolkit: 'github', alias: 'work' }, () => undefined, () => undefined)
    await Promise.all([press(), press()])
    expect(createLink).toHaveBeenCalledTimes(1)
  })

  it('refuses apps without a one-click sign-in and an alias that is already connected', async () => {
    const { market } = marketplace()
    await market.handle({ type: 'list_composio_apps' }, () => undefined, () => undefined)
    const replies: ServerMessage[] = []
    await market.handle({ type: 'connect_composio_app', toolkit: 'stripe', alias: 'personal' }, (message) => replies.push(message), () => undefined)
    await market.handle({ type: 'connect_composio_app', toolkit: 'gmail', alias: 'personal' }, (message) => replies.push(message), () => undefined)
    expect(replies.map((message) => message.type === 'notice' ? message.text : '')).toEqual([
      'stripe needs its own credentials set up in Composio before it can connect.',
      'gmail is already connected as personal.',
    ])
  })
})

describe('disconnecting', () => {
  it('never lets a read that began before the disconnect bring the app back', async () => {
    let releaseOld: (() => void) | undefined
    let calls = 0
    const before = [{ toolkit: 'github', aliases: ['personal'] }]
    const connectedApps = vi.fn(async () => {
      calls += 1
      if (calls === 1) {
        await new Promise<void>((resolve) => { releaseOld = resolve })
        return before
      }
      return []
    })
    const { market, registry } = marketplace({ connectedApps })
    const old = market.refreshConnected()
    await market.handle({ type: 'disconnect_composio_app', toolkit: 'github', alias: 'personal' }, () => undefined, () => undefined)
    releaseOld?.()
    await old
    expect(registry()[0]?.connectedApps).toEqual([])
  })


  it('deletes only the accounts of that app under that alias', async () => {
    const accounts = [
      { id: 'ca_p', alias: 'personal', status: 'ACTIVE', user_id: 'manor', toolkit: { slug: 'github' } },
      { id: 'ca_w', alias: 'work', status: 'ACTIVE', user_id: 'manor', toolkit: { slug: 'github' } },
    ]
    const request = vi.fn(async (_input: string | URL | Request, init?: RequestInit) =>
      init?.method === 'DELETE' ? json({ success: true }) : json({ items: accounts, next_cursor: null }))
    expect(await disconnectComposioApp('key', 'github', 'work', request as typeof fetch)).toBe(1)
    const deletes = request.mock.calls.filter(([, init]) => init?.method === 'DELETE').map(([url]) => String(url))
    expect(deletes).toEqual(['https://backend.composio.dev/api/v3.1/connected_accounts/ca_w'])
  })

  it('takes the app away from agents and every open page', async () => {
    let connected = [{ toolkit: 'gmail', aliases: ['personal'] }, { toolkit: 'github', aliases: ['personal'] }]
    const disconnect = vi.fn(async () => {
      connected = connected.filter((entry) => entry.toolkit !== 'github')
      return 1
    })
    const { market, sent, registry } = marketplace({ disconnect, connectedApps: async () => connected })
    const ack = vi.fn()
    await market.handle({ type: 'disconnect_composio_app', toolkit: 'github', alias: 'personal' }, () => undefined, ack)
    expect(disconnect).toHaveBeenCalledWith('github', 'personal')
    expect(ack).toHaveBeenCalled()
    expect(registry()[0]?.connectedApps).toEqual([{ toolkit: 'gmail', aliases: ['personal'] }])
    expect(sent.at(-1)).toMatchObject({ type: 'composio_accounts', connected: [{ toolkit: 'gmail', aliases: ['personal'] }] })
  })
})
