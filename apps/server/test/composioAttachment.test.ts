import { afterEach, describe, expect, it, vi } from 'vitest'
import { McpServerDraftSchema, ServerMessageSchema, type McpServerConfig, type ServerMessage } from '@manor/contracts'
import { ConnectionModule } from '../src/connectionModule.js'
import {
  COMPOSIO_ACCOUNT_ALIASES,
  COMPOSIO_API_KEY_ENV,
  COMPOSIO_MCP_DESCRIPTION,
  COMPOSIO_MCP_NAME,
  COMPOSIO_MANAGE_CONNECTIONS_TOOL,
  COMPOSIO_RECOVERY_DESCRIPTION,
  LEGACY_COMPOSIO_API_KEY_ENV,
  composioApiKeyEnv,
  composioMcpDraft,
  composioRecoveryMcpDraft,
} from '../src/mcp/composioAttachment.js'
import {
  COMPOSIO_GMAIL_ACCOUNTS_ENV,
  composioGmailAccounts,
  createComposioRecoverySession,
  createComposioSession,
  listComposioConnectedApps,
  migrateComposioAccountAliases,
  reconcileComposioServer,
  retryComposioInBackground,
} from '../src/mcp/composioRegistration.js'
import { createMemoryStore } from '../src/stores/memoryStore.js'

const TWO_ACCOUNTS = [
  { id: 'ca_personal', alias: 'personal' },
  { id: 'ca_work', alias: 'work' },
] as const

const PERSONAL = [{ id: 'ca_personal', alias: 'personal' }] as const
const NAMED = { [COMPOSIO_GMAIL_ACCOUNTS_ENV]: 'personal:ca_personal' }

const connectedAccount = (id: string, alias: string | null) => ({
  id,
  alias,
  status: 'ACTIVE',
  user_id: 'manor',
  toolkit: { slug: 'gmail' },
})

const accountList = (items: unknown[]) => new Response(JSON.stringify({ items, next_cursor: null }), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
})

const aliasUpdated = (id: string) => new Response(JSON.stringify({ success: true, id, status: 'ACTIVE' }), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
})

describe('composio connector', () => {
  afterEach(() => vi.restoreAllMocks())
  it('describes a write-capable HTTP connector whose key stays in the host env', () => {
    expect(composioMcpDraft('https://backend.composio.dev/tool_router/trs_test/mcp', COMPOSIO_API_KEY_ENV)).toMatchObject({
      name: 'composio',
      command: '',
      url: 'https://backend.composio.dev/tool_router/trs_test/mcp',
      envKeys: [COMPOSIO_API_KEY_ENV],
      httpHeaders: [{ name: 'x-api-key', envKey: COMPOSIO_API_KEY_ENV }],
      description: COMPOSIO_MCP_DESCRIPTION,
      writes: true,
      effectPolicy: 'confirm_writes' as const,
    })
    expect(COMPOSIO_ACCOUNT_ALIASES).toEqual(['personal', 'work'])
    expect(COMPOSIO_MCP_DESCRIPTION).toContain('pass the requested personal or work alias to COMPOSIO_MANAGE_CONNECTIONS')
    expect(COMPOSIO_MCP_DESCRIPTION).toContain('never create an unaliased connection')
    expect(composioRecoveryMcpDraft(
      'https://backend.composio.dev/tool_router/trs_test/mcp',
      COMPOSIO_API_KEY_ENV,
    )).toMatchObject({ description: COMPOSIO_RECOVERY_DESCRIPTION })
    expect(composioApiKeyEnv({ [LEGACY_COMPOSIO_API_KEY_ENV]: 'ak_test' })).toBe(LEGACY_COMPOSIO_API_KEY_ENV)
  })

  it('creates a Gmail-only recovery session without execution tools', async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      session_id: 'trs_recovery',
      mcp: { type: 'http', url: 'https://backend.composio.dev/tool_router/trs_recovery/mcp' },
    }), { status: 201, headers: { 'Content-Type': 'application/json' } }))
    expect(await createComposioRecoverySession('ak_secret', request)).toEqual({
      id: 'trs_recovery',
      url: 'https://backend.composio.dev/tool_router/trs_recovery/mcp',
    })
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({
      user_id: 'manor',
      toolkits: { enable: ['gmail'] },
      manage_connections: {
        enable: true,
        enable_wait_for_connections: false,
        enable_connection_removal: false,
      },
      workbench: { enable: false },
      search: { enable: false },
      execute: { enable_multi_execute: false },
      multi_account: {
        enable: true,
        max_accounts_per_toolkit: 2,
        require_explicit_selection: true,
      },
    })
  })

  it('creates a two-account session that requires an alias on every ambiguous call', async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      session_id: 'trs_test',
      mcp: { type: 'http', url: 'https://backend.composio.dev/tool_router/trs_test/mcp' },
    }), { status: 201, headers: { 'Content-Type': 'application/json' } }))
    expect(await createComposioSession('ak_secret', request)).toEqual({
      id: 'trs_test',
      url: 'https://backend.composio.dev/tool_router/trs_test/mcp',
    })
    expect(request.mock.calls[0]?.[1]?.headers).toMatchObject({ 'x-api-key': 'ak_secret' })
    expect(request.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
    const body = String(request.mock.calls[0]?.[1]?.body)
    expect(JSON.parse(body)).toEqual({
      user_id: 'manor',
      multi_account: {
        enable: true,
        max_accounts_per_toolkit: 2,
        require_explicit_selection: true,
      },
    })
    expect(body).not.toContain('ak_secret')
  })

  it('migrates both existing Gmail aliases and verifies that Composio persisted them', async () => {
    const [personal, work] = TWO_ACCOUNTS
    const request = vi.fn()
      .mockResolvedValueOnce(accountList([
        connectedAccount(personal.id, null),
        connectedAccount(work.id, null),
      ]))
      .mockResolvedValueOnce(aliasUpdated(personal.id))
      .mockResolvedValueOnce(aliasUpdated(work.id))
      .mockResolvedValueOnce(accountList([
        connectedAccount(personal.id, 'personal'),
        connectedAccount(work.id, 'work'),
      ]))

    await expect(migrateComposioAccountAliases('ak_secret', request, TWO_ACCOUNTS)).resolves.toEqual({ updated: 2 })
    expect(request).toHaveBeenCalledTimes(4)
    expect(request.mock.calls.every((call) => call[1]?.signal instanceof AbortSignal)).toBe(true)
    expect(String(request.mock.calls[0]?.[0])).toContain('user_ids=manor')
    expect(request.mock.calls[1]?.[0]).toBe(`https://backend.composio.dev/api/v3.1/connected_accounts/${personal.id}`)
    expect(JSON.parse(String(request.mock.calls[1]?.[1]?.body))).toEqual({ alias: 'personal' })
    expect(request.mock.calls[2]?.[0]).toBe(`https://backend.composio.dev/api/v3.1/connected_accounts/${work.id}`)
    expect(JSON.parse(String(request.mock.calls[2]?.[1]?.body))).toEqual({ alias: 'work' })
    expect(String(request.mock.calls[1]?.[1]?.body)).not.toContain('ak_secret')
  })

  it('rejects an alias update that Composio did not persist', async () => {
    const [personal, work] = TWO_ACCOUNTS
    const request = vi.fn()
      .mockResolvedValueOnce(accountList([
        connectedAccount(personal.id, null),
        connectedAccount(work.id, null),
      ]))
      .mockResolvedValueOnce(aliasUpdated(personal.id))
      .mockResolvedValueOnce(aliasUpdated(work.id))
      .mockResolvedValueOnce(accountList([
        connectedAccount(personal.id, 'personal'),
        connectedAccount(work.id, null),
      ]))

    await expect(migrateComposioAccountAliases('ak_secret', request, TWO_ACCOUNTS)).rejects.toThrow(/did not persist alias work/)
  })

  it('accepts a reconnected account by its durable alias instead of its old id', async () => {
    const [, work] = TWO_ACCOUNTS
    const request = vi.fn()
      .mockResolvedValueOnce(accountList([
        connectedAccount(work.id, null),
        connectedAccount('ca_reconnected', 'personal'),
      ]))
      .mockResolvedValueOnce(aliasUpdated(work.id))
      .mockResolvedValueOnce(accountList([
        connectedAccount('ca_reconnected', 'personal'),
        connectedAccount(work.id, 'work'),
      ]))

    await expect(migrateComposioAccountAliases('ak_secret', request, TWO_ACCOUNTS)).resolves.toEqual({ updated: 1 })
    expect(request).toHaveBeenCalledTimes(3)
    expect(request.mock.calls[1]?.[0]).toBe(`https://backend.composio.dev/api/v3.1/connected_accounts/${work.id}`)
  })

  it('refuses an ambiguous alias before changing accounts', async () => {
    const [, work] = TWO_ACCOUNTS
    const request = vi.fn().mockResolvedValue(accountList([
      connectedAccount('ca_first', 'personal'),
      connectedAccount('ca_second', 'personal'),
      connectedAccount(work.id, 'work'),
    ]))

    await expect(migrateComposioAccountAliases('ak_secret', request, TWO_ACCOUNTS)).rejects.toThrow(/multiple active .* alias personal/)
    expect(request).toHaveBeenCalledOnce()
  })

  it('keeps an already-migrated account mapping without issuing duplicate updates', async () => {
    const [personal, work] = TWO_ACCOUNTS
    const request = vi.fn().mockResolvedValue(accountList([
      connectedAccount(personal.id, 'personal'),
      connectedAccount(work.id, 'work'),
    ]))

    await expect(migrateComposioAccountAliases('ak_secret', request, TWO_ACCOUNTS)).resolves.toEqual({ updated: 0 })
    expect(request).toHaveBeenCalledOnce()
  })

  it('names no account unless the setting does, and then asks Composio nothing', async () => {
    expect(composioGmailAccounts({})).toEqual([])
    expect(composioGmailAccounts({ [COMPOSIO_GMAIL_ACCOUNTS_ENV]: ' personal:ca_one , work:ca_two ' })).toEqual([
      { id: 'ca_one', alias: 'personal' },
      { id: 'ca_two', alias: 'work' },
    ])
    for (const wrong of ['ca_one', 'boss:ca_one', 'personal:', 'personal:ca_one:extra']) {
      expect(() => composioGmailAccounts({ [COMPOSIO_GMAIL_ACCOUNTS_ENV]: wrong })).toThrow(/alias:account id/)
    }
    const request = vi.fn()
    await expect(migrateComposioAccountAliases('ak_secret', request, [])).resolves.toEqual({ updated: 0 })
    expect(request).not.toHaveBeenCalled()
  })

  it('runs in full mode without the setting, with one listing and no account read', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(accountList([connectedAccount('ca_other', null)]))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        session_id: 'trs_own', mcp: { type: 'http', url: 'https://backend.composio.dev/tool_router/trs_own/mcp' },
      }), { status: 200 }))
    const probe = vi.fn().mockResolvedValue({ tools: ['COMPOSIO_SEARCH_TOOLS'], readOnlyTools: [], schemaChars: 200 })
    const registry = await reconcileComposioServer(createMemoryStore(), [], { env: { [COMPOSIO_API_KEY_ENV]: 'ak_own' }, probe })
    expect(registry.find((server) => server.name === COMPOSIO_MCP_NAME)).toMatchObject({ description: COMPOSIO_MCP_DESCRIPTION })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls.some((call) => call[1]?.method === 'PATCH')).toBe(false)
  })

  it('requires only the named Gmail account', async () => {
    const request = vi.fn().mockResolvedValue(accountList([connectedAccount('ca_personal', 'personal')]))
    await expect(migrateComposioAccountAliases('ak_secret', request, PERSONAL)).resolves.toEqual({ updated: 0 })
  })

  describe('on a project that holds none of the named accounts', () => {
    const notHere = () => new Response(JSON.stringify({ error: { message: 'Connected account not found' } }), { status: 404 })
    const session = () => new Response(JSON.stringify({
      session_id: 'trs_own', mcp: { type: 'http', url: 'https://backend.composio.dev/tool_router/trs_own/mcp' },
    }), { status: 200 })
    const reconcileWith = async (gmail: unknown[]) => {
      const fetch = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(accountList(gmail))
        .mockResolvedValueOnce(notHere())
        .mockResolvedValueOnce(accountList(gmail))
        .mockResolvedValueOnce(session())
      const probe = vi.fn().mockResolvedValue({ tools: ['COMPOSIO_SEARCH_TOOLS'], readOnlyTools: [], schemaChars: 200 })
      const registry = await reconcileComposioServer(createMemoryStore(), [], { env: { [COMPOSIO_API_KEY_ENV]: 'ak_own', ...NAMED }, probe })
      const patched = fetch.mock.calls.some((call) => call[1]?.method === 'PATCH')
      const recovery = fetch.mock.calls.some((call) => String(call[1]?.body ?? '').includes('manage_connections'))
      return { row: registry.find((server) => server.name === COMPOSIO_MCP_NAME), patched, recovery }
    }

    it('runs in full mode with no Gmail account at all', async () => {
      const { row, patched, recovery } = await reconcileWith([])
      expect(row).toMatchObject({ description: COMPOSIO_MCP_DESCRIPTION, connectedApps: [] })
      expect(row?.unavailable).toBeUndefined()
      expect(patched || recovery).toBe(false)
    })

    it('runs in full mode with Gmail connected as work', async () => {
      const { row, patched, recovery } = await reconcileWith([connectedAccount('ca_own_mail', 'work')])
      expect(row).toMatchObject({ description: COMPOSIO_MCP_DESCRIPTION, connectedApps: [{ toolkit: 'gmail', aliases: ['work'] }] })
      expect(patched || recovery).toBe(false)
    })

    it('runs in full mode with an unaliased Gmail account, which it neither renames nor addresses', async () => {
      const { row, patched, recovery } = await reconcileWith([connectedAccount('ca_own_mail', null)])
      expect(row).toMatchObject({ description: COMPOSIO_MCP_DESCRIPTION, connectedApps: [{ toolkit: 'gmail', aliases: [] }] })
      expect(patched || recovery).toBe(false)
    })
  })

  it('still needs recovery when the named account is on the project but no longer active', async () => {
    const [personal] = PERSONAL
    const request = vi.fn()
      .mockResolvedValueOnce(accountList([]))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: personal.id, status: 'EXPIRED' }), { status: 200 }))
    await expect(migrateComposioAccountAliases('ak_secret', request, PERSONAL)).rejects.toThrow(/personal Gmail account is missing/)
    expect(request.mock.calls[1]?.[0]).toBe(`https://backend.composio.dev/api/v3.1/connected_accounts/${personal.id}`)
  })

  it('retries a failed startup three times, then gives up once', async () => {
    const timers: (() => void)[] = []
    const check = vi.fn().mockResolvedValue(false)
    const onGaveUp = vi.fn()
    retryComposioInBackground({ isAvailable: () => false, check, onGaveUp, schedule: (run) => timers.push(run) })
    for (let turn = 0; turn < 5 && timers.length > 0; turn += 1) {
      timers.shift()!()
      await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(turn + 1))
      await Promise.resolve()
    }
    await vi.waitFor(() => expect(onGaveUp).toHaveBeenCalledOnce())
    expect(check).toHaveBeenCalledTimes(3)
    expect(timers).toHaveLength(0)
  })

  it('stops retrying after a success or when a manual Test already restored it', async () => {
    const timers: (() => void)[] = []
    const check = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const onGaveUp = vi.fn()
    retryComposioInBackground({ isAvailable: () => false, check, onGaveUp, schedule: (run) => timers.push(run) })
    timers.shift()!()
    await vi.waitFor(() => expect(timers).toHaveLength(1))
    timers.shift()!()
    await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(2))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(timers).toHaveLength(0)
    expect(onGaveUp).not.toHaveBeenCalled()

    const restored = vi.fn()
    retryComposioInBackground({ isAvailable: () => true, check: restored, onGaveUp, schedule: (run) => timers.push(run) })
    timers.shift()!()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(restored).not.toHaveBeenCalled()
    expect(onGaveUp).not.toHaveBeenCalled()
  })

  it('groups active connected accounts by toolkit and alias', async () => {
    const [personal] = TWO_ACCOUNTS
    const request = vi.fn().mockResolvedValue(accountList([
      connectedAccount(personal.id, 'personal'),
      { ...connectedAccount('ca_linear', 'work'), toolkit: { slug: 'linear' } },
      { ...connectedAccount('ca_other', null), toolkit: { slug: 'linear' } },
    ]))
    expect(await listComposioConnectedApps('ak_secret', request)).toEqual([
      { toolkit: 'gmail', aliases: ['personal'] },
      { toolkit: 'linear', aliases: ['work'] },
    ])
    expect(String(request.mock.calls[0]?.[0])).toContain('user_ids=manor')
    expect(String(request.mock.calls[0]?.[0])).not.toContain('toolkit_slugs')
  })

  it('registers once when the consumer key exists', async () => {
    const store = createMemoryStore()
    const probe = vi.fn().mockResolvedValue({ tools: ['COMPOSIO_SEARCH_TOOLS'], readOnlyTools: [], schemaChars: 400 })
    const createSession = vi.fn().mockResolvedValue({
      id: 'trs_test',
      url: 'https://backend.composio.dev/tool_router/trs_test/mcp',
    })
    const migrateAliases = vi.fn().mockResolvedValue({ updated: 0 })
    const listConnectedApps = vi.fn().mockResolvedValue([])
    const registered = await reconcileComposioServer(store, [], {
      env: { [COMPOSIO_API_KEY_ENV]: 'ak_test' },
      probe,
      createSession,
      migrateAliases,
      listConnectedApps,
    })
    expect(probe).toHaveBeenCalledOnce()
    expect(registered[0]).toMatchObject({
      name: 'composio',
      tools: ['COMPOSIO_SEARCH_TOOLS'],
      httpHeaders: [{ name: 'x-api-key', envKey: COMPOSIO_API_KEY_ENV }],
    })

    const unchanged = await reconcileComposioServer(store, registered, {
      env: { [COMPOSIO_API_KEY_ENV]: 'ak_test' },
      probe,
      createSession,
      migrateAliases,
      listConnectedApps,
    })
    expect(unchanged).toEqual(registered)
    expect(probe).toHaveBeenCalledOnce()

    const upgraded = await reconcileComposioServer(store, [{
      ...registered[0]!,
      description: 'Search, connect and run tools across apps through Composio. Can change external data.',
    }], {
      env: { [COMPOSIO_API_KEY_ENV]: 'ak_test' },
      probe,
      createSession,
      migrateAliases,
      listConnectedApps,
    })
    expect(upgraded[0]?.description).toBe(COMPOSIO_MCP_DESCRIPTION)
    expect(createSession).toHaveBeenCalledTimes(2)
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('refreshes connected Composio apps when the session itself is unchanged', async () => {
    const store = createMemoryStore()
    const probe = vi.fn().mockResolvedValue({ tools: ['COMPOSIO_SEARCH_TOOLS'], readOnlyTools: [], schemaChars: 400 })
    const createSession = vi.fn().mockResolvedValue({
      id: 'trs_test',
      url: 'https://backend.composio.dev/tool_router/trs_test/mcp',
    })
    const migrateAliases = vi.fn().mockResolvedValue({ updated: 0 })
    const listConnectedApps = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ toolkit: 'gmail', aliases: ['personal', 'work'] }])
    const registered = await reconcileComposioServer(store, [], {
      env: { [COMPOSIO_API_KEY_ENV]: 'ak_test' },
      probe,
      createSession,
      migrateAliases,
      listConnectedApps,
    })
    expect(registered[0]?.connectedApps).toEqual([])
    const refreshed = await reconcileComposioServer(store, registered, {
      env: { [COMPOSIO_API_KEY_ENV]: 'ak_test' },
      probe,
      createSession,
      migrateAliases,
      listConnectedApps,
    })
    expect(createSession).toHaveBeenCalledOnce()
    expect(refreshed[0]?.connectedApps).toEqual([{ toolkit: 'gmail', aliases: ['personal', 'work'] }])
  })

  it('does nothing when the key is absent or the authenticated probe fails', async () => {
    const store = createMemoryStore()
    const probe = vi.fn().mockRejectedValue(new Error('HTTP 401'))
    const createSession = vi.fn().mockResolvedValue({
      id: 'trs_test',
      url: 'https://backend.composio.dev/tool_router/trs_test/mcp',
    })
    const migrateAliases = vi.fn().mockResolvedValue({ updated: 0 })
    expect(await reconcileComposioServer(store, [], { env: {}, probe, createSession })).toEqual([])
    expect(probe).not.toHaveBeenCalled()
    expect(await reconcileComposioServer(store, [], {
      env: { [COMPOSIO_API_KEY_ENV]: 'ak_bad' },
      probe,
      createSession,
      migrateAliases,
      listConnectedApps: vi.fn().mockResolvedValue([]),
    })).toEqual([])
    expect(await store.listMcpServers()).toEqual([])
  })

  it('retains only connection management while account aliases need recovery', async () => {
    const store = createMemoryStore()
    const existing = await store.saveMcpServer(
      composioMcpDraft('https://backend.composio.dev/tool_router/trs_old/mcp', COMPOSIO_API_KEY_ENV),
      { tools: ['COMPOSIO_MULTI_EXECUTE_TOOL'], readOnlyTools: [], schemaChars: 400 },
    )
    const createSession = vi.fn()
    const createRecoverySession = vi.fn().mockResolvedValue({
      id: 'trs_recovery',
      url: 'https://backend.composio.dev/tool_router/trs_recovery/mcp',
    })
    const probe = vi.fn().mockResolvedValue({ tools: [COMPOSIO_MANAGE_CONNECTIONS_TOOL], readOnlyTools: [], schemaChars: 200 })
    const result = await reconcileComposioServer(store, [existing], {
      env: { [COMPOSIO_API_KEY_ENV]: 'ak_test' },
      createSession,
      createRecoverySession,
      probe,
      migrateAliases: vi.fn().mockRejectedValue(new Error('duplicate alias')),
    })

    expect(result[0]).toMatchObject({
      id: existing.id,
      description: COMPOSIO_RECOVERY_DESCRIPTION,
      tools: [COMPOSIO_MANAGE_CONNECTIONS_TOOL],
    })
    expect(createSession).not.toHaveBeenCalled()
    expect(createRecoverySession).toHaveBeenCalledOnce()
  })

  it('fails closed when a recovery session exposes any account tool', async () => {
    const store = createMemoryStore()
    const existing = await store.saveMcpServer(
      composioMcpDraft('https://backend.composio.dev/tool_router/trs_old/mcp', COMPOSIO_API_KEY_ENV),
      { tools: ['COMPOSIO_MULTI_EXECUTE_TOOL'], readOnlyTools: [], schemaChars: 400 },
    )
    const result = await reconcileComposioServer(store, [existing], {
      env: { [COMPOSIO_API_KEY_ENV]: 'ak_test' },
      createRecoverySession: vi.fn().mockResolvedValue({
        id: 'trs_recovery',
        url: 'https://backend.composio.dev/tool_router/trs_recovery/mcp',
      }),
      probe: vi.fn().mockResolvedValue({
        tools: [COMPOSIO_MANAGE_CONNECTIONS_TOOL, 'COMPOSIO_MULTI_EXECUTE_TOOL'],
        readOnlyTools: [],
        schemaChars: 300,
      }),
      migrateAliases: vi.fn().mockRejectedValue(new Error('missing account')),
    })

    expect(result).toEqual([{ ...existing, unavailable: expect.any(String) }])
    expect(await store.listMcpServers()).toEqual([existing])
  })

  it('keeps a saved connector unavailable without a host key', async () => {
    const store = createMemoryStore()
    const existing = await store.saveMcpServer(
      composioMcpDraft('https://backend.composio.dev/tool_router/trs_old/mcp', COMPOSIO_API_KEY_ENV),
      { tools: ['COMPOSIO_MULTI_EXECUTE_TOOL'], readOnlyTools: [], schemaChars: 400 },
    )
    const result = await reconcileComposioServer(store, [existing], { env: {} })
    expect(result).toEqual([{ ...existing, unavailable: expect.stringContaining('API key is missing') }])
  })

  it('keeps a failed full session visible and creates a fresh session on retry', async () => {
    const store = createMemoryStore()
    const existing = await store.saveMcpServer(
      composioMcpDraft('https://backend.composio.dev/tool_router/trs_old/mcp', COMPOSIO_API_KEY_ENV),
      { tools: ['COMPOSIO_MULTI_EXECUTE_TOOL'], readOnlyTools: [], schemaChars: 400 },
    )
    const probe = vi.fn().mockRejectedValueOnce(new Error('HTTP 401'))
      .mockResolvedValue({ tools: ['COMPOSIO_SEARCH_TOOLS'], readOnlyTools: [], schemaChars: 200 })
    const options = {
      env: { [COMPOSIO_API_KEY_ENV]: 'ak_test' },
      migrateAliases: vi.fn().mockResolvedValue({ updated: 0 }),
      listConnectedApps: vi.fn().mockResolvedValue([]),
      createSession: vi.fn().mockResolvedValue({ id: 'trs_new', url: 'https://backend.composio.dev/tool_router/trs_new/mcp' }),
      probe,
    }
    const failed = await reconcileComposioServer(store, [existing], { ...options, force: true })
    expect(failed).toEqual([{ ...existing, unavailable: expect.any(String) }])
    const retried = await reconcileComposioServer(store, failed, options)
    expect(retried[0]).toMatchObject({ id: existing.id, url: 'https://backend.composio.dev/tool_router/trs_new/mcp' })
    expect(retried[0]?.unavailable).toBeUndefined()
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('registers composio live once a key arrives, and marks it unavailable once the key goes', async () => {
    const store = createMemoryStore()
    const other = await store.saveMcpServer(
      { name: 'other', command: '/bin/true', args: [], envKeys: [], description: '', writes: false, effectPolicy: 'confirm_writes' },
      { tools: [], readOnlyTools: [], schemaChars: 0 },
    )
    const env: NodeJS.ProcessEnv = { ...NAMED }
    let registry: readonly McpServerConfig[] = [other]
    const broadcast = vi.fn<(message: ServerMessage) => void>()
    const probe = vi.fn().mockResolvedValue({ tools: ['COMPOSIO_SEARCH_TOOLS'], readOnlyTools: [], schemaChars: 200 })
    const module = new ConnectionModule({
      store, hostEnv: env, agents: () => [], mcpServers: () => registry,
      setMcpServers: (servers) => { registry = servers },
      probeMcpServer: probe, broadcast, reloadRoster: async () => {},
    })
    await module.reconcileComposio()
    expect(registry).toEqual([other])

    env[COMPOSIO_API_KEY_ENV] = 'ak_live_start'
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(accountList(PERSONAL.map(({ id, alias }) => connectedAccount(id, alias))))
      .mockResolvedValueOnce(accountList(PERSONAL.map(({ id, alias }) => connectedAccount(id, alias))))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        session_id: 'trs_live', mcp: { type: 'http', url: 'https://backend.composio.dev/tool_router/trs_live/mcp' },
      }), { status: 200 }))
    await module.reconcileComposio()
    const row = registry.find((server) => server.name === COMPOSIO_MCP_NAME)
    expect(row).toMatchObject({ url: 'https://backend.composio.dev/tool_router/trs_live/mcp', connectedApps: [{ toolkit: 'gmail', aliases: ['personal'] }] })
    expect(row?.unavailable).toBeUndefined()
    expect(registry.some((server) => server.id === other.id)).toBe(true)
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'mcp_servers', servers: registry }))

    delete env[COMPOSIO_API_KEY_ENV]
    await module.reconcileComposio()
    expect(registry.find((server) => server.name === COMPOSIO_MCP_NAME)?.unavailable).toBe('The Composio API key is missing on this Manor host.')
    expect(JSON.stringify(broadcast.mock.calls)).not.toContain('ak_live_start')
  })

  it('reconnects through the existing request and preserves refusals across unrelated saves', async () => {
    const store = createMemoryStore()
    const existing = await store.saveMcpServer(
      composioMcpDraft('https://backend.composio.dev/tool_router/trs_old/mcp', COMPOSIO_API_KEY_ENV),
      { tools: ['COMPOSIO_MULTI_EXECUTE_TOOL'], readOnlyTools: [], schemaChars: 400 },
    )
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Request timed out'))
    const env = { [COMPOSIO_API_KEY_ENV]: 'ak_test', ...NAMED }
    let registry: readonly McpServerConfig[] = await reconcileComposioServer(store, [existing], { env })
    const probe = vi.fn().mockResolvedValue({ tools: ['COMPOSIO_SEARCH_TOOLS'], readOnlyTools: [], schemaChars: 200 })
    const broadcast = vi.fn<(message: ServerMessage) => void>()
    const reply = vi.fn()
    const ack = vi.fn()
    const module = new ConnectionModule({
      store, hostEnv: env, agents: () => [], mcpServers: () => registry,
      setMcpServers: (servers) => { registry = servers },
      probeMcpServer: probe, broadcast, reloadRoster: async () => {},
    })
    expect(ServerMessageSchema.parse(module.registry())).toMatchObject({
      servers: [{ id: existing.id, unavailable: expect.any(String) }],
    })
    // Neither a client-supplied flag nor an ordinary settings save owns availability.
    expect(McpServerDraftSchema.parse(registry[0])).not.toHaveProperty('unavailable')
    await module.handle({ type: 'save_mcp_server', server: { ...existing, name: 'renamed' } }, reply, ack)
    expect(reply).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'error' }))
    expect(probe).not.toHaveBeenCalled()
    await module.handle({ type: 'save_mcp_server', server: {
      name: 'other', command: '/bin/true', args: [], envKeys: [], description: '', writes: false, effectPolicy: 'confirm_writes',
    } }, reply, ack)
    expect(registry.find((server) => server.id === existing.id)?.unavailable).toBeDefined()

    ack.mockClear()
    await module.handle({ type: 'verify_mcp_server', serverId: existing.id }, reply, ack)
    expect(ack).not.toHaveBeenCalled()
    expect(registry.find((server) => server.id === existing.id)?.unavailable).toBeDefined()
    expect(module.hostStatuses()).toMatchObject({ statuses: expect.arrayContaining([
      expect.objectContaining({ serverId: existing.id, check: expect.objectContaining({ result: 'failed' }) }),
    ]) })

    fetch.mockResolvedValueOnce(accountList(PERSONAL.map(({ id, alias }) => connectedAccount(id, alias))))
      .mockResolvedValueOnce(accountList(PERSONAL.map(({ id, alias }) => connectedAccount(id, alias))))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        session_id: 'trs_new', mcp: { type: 'http', url: 'https://backend.composio.dev/tool_router/trs_new/mcp' },
      }), { status: 200 }))
    await module.handle({ type: 'verify_mcp_server', serverId: existing.id }, reply, ack)
    expect(ack).toHaveBeenCalledOnce()
    expect(registry.find((server) => server.id === existing.id)?.unavailable).toBeUndefined()
    expect(registry.find((server) => server.id === existing.id)?.url).toContain('/trs_new/')
    expect(registry.find((server) => server.id === existing.id)?.connectedApps).toEqual([
      { toolkit: 'gmail', aliases: ['personal'] },
    ])
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'mcp_servers', servers: registry }))
    expect(registry.find((server) => server.name === 'other')).toBeDefined()

    await module.handle({ type: 'save_mcp_server', server: {
      name: 'docs', command: '/bin/true', args: [], envKeys: [], description: '', writes: false, effectPolicy: 'confirm_writes',
    } }, reply, ack)
    expect(registry.find((server) => server.id === existing.id)?.connectedApps).toEqual([
      { toolkit: 'gmail', aliases: ['personal'] },
    ])

    await module.handle({ type: 'delete_mcp_server', serverId: existing.id }, reply, ack)
    expect(registry.some((server) => server.id === existing.id)).toBe(false)
  })
})
