import { afterEach, describe, expect, it, vi } from 'vitest'
import { ThreadEventSchema, isSingleUseConnectLink } from '@manor/contracts'
import { ConnectCards, type ConnectCardDeps } from '../src/connectCards.js'
import { composioConnectLinks, connectCardResult, unaliasedComposioAdd } from '../src/mcp/connectLinks.js'
import type { ComposioConnectState } from '../src/mcp/composioRegistration.js'
import type { McpOAuthResult } from '../src/mcp/oauth.js'

const LINK = 'https://connect.composio.dev/link/lk_single_use'
const context = { chatId: 'chat-1', agentId: 'smith', turnId: 'turn-1' }
const addGmail = { toolkits: [{ name: 'gmail', action: 'add', alias: 'personal' }] }
const composioReply = {
  content: [{ type: 'text', text: JSON.stringify({ successful: true, data: { results: { gmail: { status: 'initiated', redirect_url: LINK, connected_account_id: 'ca_new' } } } }) }],
  structuredContent: { redirect_url: LINK },
}

afterEach(() => vi.useRealTimers())

describe('connect links from COMPOSIO_MANAGE_CONNECTIONS', () => {
  it('becomes a card for the toolkit and alias, and the model never sees the link', () => {
    const links = composioConnectLinks(addGmail, composioReply)
    expect(links).toEqual([{ toolkit: 'gmail', alias: 'personal', accountId: 'ca_new', url: LINK }])
    const shown = JSON.stringify(connectCardResult(composioReply, links, [{ status: 'pending' }]))
    expect(shown).not.toContain('composio.dev')
    expect(shown).toContain('connect card for gmail (personal)')
    expect(JSON.stringify(connectCardResult(composioReply, links, [{ status: 'connected' }]))).toContain('work in this turn')
  })

  it('reads a lone link in prose, ignores foreign hosts, and refuses an unaliased add', () => {
    expect(composioConnectLinks(addGmail, { content: [{ type: 'text', text: `Open ${LINK} to finish.` }] })).toHaveLength(1)
    expect(composioConnectLinks(addGmail, { content: [{ type: 'text', text: 'Open https://evil.example/link/x' }] })).toEqual([])
    expect(unaliasedComposioAdd({ toolkits: [{ name: 'slack' }] })).toBe('slack')
    expect(unaliasedComposioAdd({ toolkits: [{ name: 'slack', alias: 'team' }] })).toBe('slack')
    expect(unaliasedComposioAdd(addGmail)).toBeUndefined()
    expect(unaliasedComposioAdd({ toolkits: [{ name: 'gmail', action: 'list' }] })).toBeUndefined()
  })

  it('knows which links are single-use', () => {
    expect(isSingleUseConnectLink(LINK)).toBe(true)
    expect(isSingleUseConnectLink('https://backend.composio.dev/api/v3/s/Ab12')).toBe(true)
    expect(isSingleUseConnectLink('https://composio.dev/docs')).toBe(false)
  })
})

function harness(overrides: Partial<ConnectCardDeps> = {}) {
  const events: unknown[] = []
  let state: ComposioConnectState = { status: 'pending' }
  let oauthResult: ((result: McpOAuthResult) => void) | undefined
  const openUrl = vi.fn(async (_url: string) => undefined)
  const beginOAuth = vi.fn(async (_serverId: string, onResult: (result: McpOAuthResult) => void) => { oauthResult = onResult })
  const deps: ConnectCardDeps = {
    recordRequest: async (_context, event) => { events.push(event); return true },
    appendStatus: async (_chatId, event) => { events.push(event) },
    loadEvents: async () => [],
    openUrl,
    beginOAuth,
    composioState: async () => state,
    composioBaseline: async () => [],
    holdMs: 60_000,
    lifetimeMs: 600_000,
    pollMs: 1_000,
    ...overrides,
  }
  return {
    cards: new ConnectCards(deps),
    events,
    openUrl,
    beginOAuth,
    setState: (next: ComposioConnectState) => { state = next },
    finishOAuth: (result: McpOAuthResult) => oauthResult?.(result),
    statuses: () => events.flatMap((event) =>
      typeof event === 'object' && event !== null && (event as { type?: string }).type === 'connect_status' ? [event] : []),
  }
}

describe('connect cards', () => {
  it('opens nothing before the click, then follows the sign-in to Connected in the same turn', async () => {
    vi.useFakeTimers()
    const run = harness()
    const answer = run.cards.request(context, { kind: 'composio', toolkit: 'gmail', alias: 'personal', accountId: 'ca_new', url: LINK })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(run.openUrl).not.toHaveBeenCalled()
    const request = run.events[0] as { connectId: string }
    expect(JSON.stringify(run.events)).not.toContain('composio.dev')
    // The wire accepts the card exactly as written.
    expect(ThreadEventSchema.safeParse({ id: 'e1', ts: 1, ...request }).success).toBe(true)

    await run.cards.open('chat-1', request.connectId)
    expect(run.openUrl).toHaveBeenCalledExactlyOnceWith(LINK)
    expect(run.statuses()).toMatchObject([{ status: 'waiting' }])

    run.setState({ status: 'active' })
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(answer).resolves.toEqual({ status: 'connected' })
    expect(run.statuses()).toEqual([
      expect.objectContaining({ status: 'waiting' }),
      { type: 'connect_status', agentId: 'smith', turnId: 'turn-1', connectId: request.connectId, status: 'connected' },
    ])
  })

  it('reads Failed for good once Composio spends the link, and Retry only when the browser never opened', async () => {
    vi.useFakeTimers()
    const run = harness({ holdMs: 2_000 })
    const answer = run.cards.request(context, { kind: 'composio', toolkit: 'gmail', alias: 'personal', accountId: 'ca_new', url: LINK })
    await vi.advanceTimersByTimeAsync(0)
    const { connectId } = run.events[0] as { connectId: string }
    await run.cards.open('chat-1', connectId)
    run.setState({ status: 'failed', reason: 'The sign-in link expired.' })
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(answer).resolves.toMatchObject({ status: 'failed' })
    expect(run.statuses().at(-1)).toMatchObject({ status: 'failed', final: true, reason: expect.stringContaining('connect again') })

    // The open command's own error quotes the link; the card must not.
    const failing = harness({ holdMs: 2_000, openUrl: vi.fn().mockRejectedValueOnce(new Error(`Command failed: /usr/bin/open ${LINK}`)).mockResolvedValue(undefined) })
    void failing.cards.request(context, { kind: 'composio', toolkit: 'gmail', alias: 'personal', accountId: 'ca_new', url: LINK })
    await vi.advanceTimersByTimeAsync(0)
    const second = (failing.events[0] as { connectId: string }).connectId
    await failing.cards.open('chat-1', second)
    expect(failing.statuses().at(-1)).toEqual(expect.objectContaining({ status: 'failed', reason: 'The browser did not open.' }))
    expect(JSON.stringify(failing.events)).not.toContain('composio.dev')
    await vi.advanceTimersByTimeAsync(3_000)
    await failing.cards.open('chat-1', second)
    failing.setState({ status: 'active' })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(failing.statuses().at(-1)).toMatchObject({ status: 'connected', nextMessage: true })
  })

  it('never calls an old account new when the baseline could not be read', async () => {
    vi.useFakeTimers()
    const run = harness({ holdMs: 100, lifetimeMs: 5_000, composioBaseline: async () => { throw new Error('HTTP 500') } })
    void run.cards.request(context, { kind: 'composio', toolkit: 'gmail', alias: 'personal', url: LINK })
    await vi.advanceTimersByTimeAsync(0)
    await run.cards.open('chat-1', (run.events[0] as { connectId: string }).connectId)
    run.setState({ status: 'active' })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(run.statuses().at(-1)).toMatchObject({ status: 'failed', final: true, reason: expect.stringContaining('could not check') })
  })

  it('takes the account baseline before the card can be clicked', async () => {
    const order: string[] = []
    const run = harness({
      composioBaseline: async () => { order.push('baseline'); return ['ca_old'] },
      recordRequest: async () => { order.push('card'); return true },
      holdMs: 0,
    })
    await run.cards.request(context, { kind: 'composio', toolkit: 'gmail', alias: 'personal', url: LINK })
    expect(order).toEqual(['baseline', 'card'])
  })

  it('starts an MCP login only on the click, once per row, and follows it to Failed', async () => {
    const run = harness()
    const request = { kind: 'mcp_oauth' as const, serverId: 'srv_figma', app: 'figma' }
    await expect(run.cards.request(context, request)).resolves.toEqual({ status: 'pending' })
    await expect(run.cards.request({ ...context, turnId: 'turn-2' }, request)).resolves.toEqual({ status: 'pending' })
    expect(run.events.filter((event) => (event as { type: string }).type === 'connect_request')).toHaveLength(1)
    expect(run.beginOAuth).not.toHaveBeenCalled()

    const { connectId } = run.events[0] as { connectId: string }
    await run.cards.open('chat-1', connectId)
    expect(run.beginOAuth).toHaveBeenCalledOnce()
    run.finishOAuth({ status: 'failed', reason: 'The sign-in was cancelled.' })
    await vi.waitFor(() => expect(run.statuses().at(-1)).toMatchObject({ status: 'failed', reason: 'The sign-in was cancelled.' }))
    await run.cards.open('chat-1', connectId)
    run.finishOAuth({ status: 'connected' })
    await vi.waitFor(() => expect(run.statuses().at(-1)).toMatchObject({ status: 'connected', nextMessage: true }))
  })

  it('lets a later successful login on the row clear a card an older attempt failed', async () => {
    const run = harness()
    await run.cards.request(context, { kind: 'mcp_oauth', serverId: 'srv_figma', app: 'figma' })
    const { connectId } = run.events[0] as { connectId: string }
    await run.cards.open('chat-1', connectId)
    const older = run.beginOAuth.mock.calls[0]![1]
    older({ status: 'failed', reason: 'The provider did not accept the sign-in.' })
    await vi.waitFor(() => expect(run.statuses().at(-1)).toMatchObject({ status: 'failed' }))
    older({ status: 'connected' })
    await vi.waitFor(() => expect(run.statuses().at(-1)).toMatchObject({ status: 'connected', nextMessage: true }))
  })

  it('settles every waiting card for one row from whichever login landed', async () => {
    const afterLogin = vi.fn(async () => undefined)
    const run = harness({ afterLogin })
    const request = { kind: 'mcp_oauth' as const, serverId: 'srv_figma', app: 'figma' }
    await run.cards.request(context, request)
    await run.cards.request({ ...context, chatId: 'chat-2', agentId: 'sage' }, request)
    const [first, second] = run.events as { connectId: string }[]
    await run.cards.open('chat-1', first!.connectId)
    await run.cards.open('chat-2', second!.connectId)
    run.finishOAuth({ status: 'connected' })
    await vi.waitFor(() => expect(run.statuses().filter((event) => (event as { status: string }).status === 'connected')).toHaveLength(2))
    await vi.waitFor(() => expect(afterLogin).toHaveBeenCalledOnce())

    // A login that fails to start ends every card waiting on that row, not only the clicked one.
    const failing = harness({ beginOAuth: vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('registration failed')) })
    await failing.cards.request(context, request)
    await failing.cards.request({ ...context, chatId: 'chat-2' }, request)
    const [one, two] = failing.events as { connectId: string }[]
    await failing.cards.open('chat-1', one!.connectId)
    await failing.cards.open('chat-2', two!.connectId)
    expect(failing.statuses().filter((event) => (event as { status: string }).status === 'failed')).toHaveLength(2)
  })

  it('refuses a click from another chat and a card the turn could not record', async () => {
    const run = harness({ recordRequest: async () => false })
    await expect(run.cards.request(context, { kind: 'composio', toolkit: 'gmail', url: LINK })).resolves.toMatchObject({ status: 'failed' })
    const live = harness()
    void live.cards.request(context, { kind: 'mcp_oauth', serverId: 's', app: 'figma' })
    await vi.waitFor(() => expect(live.events).toHaveLength(1))
    const { connectId } = live.events[0] as { connectId: string }
    await expect(live.cards.open('chat-2', connectId)).resolves.toBe(false)
  })
})
