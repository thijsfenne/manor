import type { McpServerConfig, McpServerDraft } from '@manor/contracts'
import type { Store } from '../store.js'
import {
  COMPOSIO_ACCOUNT_ALIASES,
  COMPOSIO_MCP_NAME,
  COMPOSIO_MCP_DESCRIPTION,
  COMPOSIO_MANAGE_CONNECTIONS_TOOL,
  COMPOSIO_RECOVERY_DESCRIPTION,
  composioApiKeyEnv,
  composioMcpDraft,
  composioRecoveryMcpDraft,
} from './composioAttachment.js'
import { probeMcpServer } from './probe.js'
import { isComposioConnectUrl } from './connectLinks.js'

const COMPOSIO_SESSION_ENDPOINT = 'https://backend.composio.dev/api/v3.1/tool_router/session'
const COMPOSIO_CONNECTED_ACCOUNTS_ENDPOINT = 'https://backend.composio.dev/api/v3.1/connected_accounts'
const COMPOSIO_MCP_URL = /^https:\/\/backend\.composio\.dev\/tool_router\/[^/]+\/mcp$/
const COMPOSIO_REQUEST_TIMEOUT_MS = 15_000
/**
 * The name Composio files this install's connected accounts under. Accounts connected
 * under another name are not found, so somebody who already connected some keeps their
 * name with `MANOR_COMPOSIO_USER_ID`.
 */
export const COMPOSIO_USER_ID = process.env['MANOR_COMPOSIO_USER_ID']?.trim() || 'manor'
export const COMPOSIO_GMAIL_ACCOUNTS_ENV = 'MANOR_COMPOSIO_GMAIL_ACCOUNTS'

/**
 * Gmail accounts that must stay addressable by a fixed alias, as `alias:account id`
 * pairs from `MANOR_COMPOSIO_GMAIL_ACCOUNTS`, comma separated. Somebody who connected
 * Gmail before Manor used aliases names those accounts here. Unset, there are none:
 * nothing is renamed and nothing is required.
 */
export function composioGmailAccounts(
  env: NodeJS.ProcessEnv = process.env,
): { id: string; alias: ComposioAccountAlias }[] {
  const entries = (env[COMPOSIO_GMAIL_ACCOUNTS_ENV] ?? '').split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0)
  return entries.map((entry) => {
    const [alias, id, ...rest] = entry.split(':').map((part) => part.trim())
    const known = COMPOSIO_ACCOUNT_ALIASES.find((candidate) => candidate === alias)
    if (known === undefined || id === undefined || id.length === 0 || rest.length > 0) {
      throw new Error(`${COMPOSIO_GMAIL_ACCOUNTS_ENV} needs entries of the form alias:account id, with alias ${COMPOSIO_ACCOUNT_ALIASES.join(' or ')}`)
    }
    return { id, alias: known }
  })
}

type ComposioAccountAlias = (typeof COMPOSIO_ACCOUNT_ALIASES)[number]

interface ComposioConnectedAccount {
  id: string
  alias: string | null
  status: string
  toolkit: string
  userId: string
}

interface ComposioSession {
  id: string
  url: string
}

const multiAccountConfig = () => ({
  enable: true,
  max_accounts_per_toolkit: COMPOSIO_ACCOUNT_ALIASES.length,
  require_explicit_selection: true,
})

export async function createComposioSession(
  apiKey: string,
  request: typeof fetch = fetch,
): Promise<ComposioSession> {
  const response = await request(COMPOSIO_SESSION_ENDPOINT, {
    method: 'POST',
    signal: AbortSignal.timeout(COMPOSIO_REQUEST_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({
      user_id: COMPOSIO_USER_ID,
      multi_account: multiAccountConfig(),
    }),
  })
  return parseComposioSessionResponse(response)
}

export async function createComposioRecoverySession(
  apiKey: string,
  request: typeof fetch = fetch,
): Promise<ComposioSession> {
  const response = await request(COMPOSIO_SESSION_ENDPOINT, {
    method: 'POST',
    signal: AbortSignal.timeout(COMPOSIO_REQUEST_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({
      user_id: COMPOSIO_USER_ID,
      toolkits: { enable: ['gmail'] },
      manage_connections: {
        enable: true,
        enable_wait_for_connections: false,
        enable_connection_removal: false,
      },
      workbench: { enable: false },
      search: { enable: false },
      execute: { enable_multi_execute: false },
      multi_account: multiAccountConfig(),
    }),
  })
  return parseComposioSessionResponse(response)
}

async function parseComposioSessionResponse(response: Response): Promise<ComposioSession> {
  if (!response.ok) throw new Error(`Composio session creation answered HTTP ${response.status}`)
  const json = await response.json() as unknown
  if (
    typeof json !== 'object' || json === null ||
    typeof (json as Record<string, unknown>)['session_id'] !== 'string' ||
    typeof (json as { mcp?: { url?: unknown } }).mcp?.url !== 'string' ||
    !COMPOSIO_MCP_URL.test((json as { mcp: { url: string } }).mcp.url)
  ) {
    throw new Error('Composio session creation returned no usable MCP endpoint')
  }
  return {
    id: (json as { session_id: string }).session_id,
    url: (json as { mcp: { url: string } }).mcp.url,
  }
}

/**
 * Makes the Gmail connections named in `MANOR_COMPOSIO_GMAIL_ACCOUNTS` addressable by
 * their durable names. With none named it does nothing and asks Composio nothing. The
 * preflight refuses another account that already owns a named alias; only the mapped
 * records may be renamed. A project that holds none of the mapped accounts, in any
 * status, is somebody else's: it is left alone and runs in full mode.
 */
export async function migrateComposioAccountAliases(
  apiKey: string,
  request: typeof fetch = fetch,
  assignments: readonly { id: string; alias: ComposioAccountAlias }[] = composioGmailAccounts(),
): Promise<{ updated: number }> {
  if (assignments.length === 0) return { updated: 0 }
  const ids = new Set<string>(assignments.map(({ id }) => id))
  const aliases = new Set<ComposioAccountAlias>(assignments.map(({ alias }) => alias))
  if (ids.size !== assignments.length || aliases.size !== assignments.length) {
    throw new Error('Composio account migration contains a duplicate account or alias')
  }

  const before = await listComposioGmailAccounts(apiKey, request)
  if (!before.some((account) => ids.has(account.id)) && !await composioHoldsAnyAccount(apiKey, [...ids], request)) {
    return { updated: 0 }
  }
  const byId = new Map(before.map((account) => [account.id, account]))
  for (const assignment of assignments) {
    const aliased = before.filter((account) => account.alias === assignment.alias)
    if (aliased.length > 1) throw new Error(`multiple active Composio Gmail accounts use alias ${assignment.alias}`)
    const account = aliased[0] ?? byId.get(assignment.id)
    if (account === undefined) throw new Error(`Composio ${assignment.alias} Gmail account is missing`)
    if (account.userId !== COMPOSIO_USER_ID || account.toolkit !== 'gmail' || account.status !== 'ACTIVE') {
      throw new Error(`Composio ${assignment.alias} Gmail account is not an active Gmail connection for ${COMPOSIO_USER_ID}`)
    }
  }

  const changed = assignments.filter((assignment) => {
    if (before.some((account) => account.alias === assignment.alias)) return false
    return byId.get(assignment.id)?.alias !== assignment.alias
  })
  // Release a desired alias from the other mapped account before applying a swap.
  for (const assignment of changed) {
    const current = byId.get(assignment.id)?.alias
    if (current !== null && current !== undefined && aliases.has(current as ComposioAccountAlias)) {
      await updateComposioAccountAlias(apiKey, assignment.id, '', request)
    }
  }
  for (const assignment of changed) {
    await updateComposioAccountAlias(apiKey, assignment.id, assignment.alias, request)
  }

  if (changed.length > 0) {
    const after = await listComposioGmailAccounts(apiKey, request)
    for (const assignment of assignments) {
      if (after.filter((account) => account.alias === assignment.alias).length !== 1) {
        throw new Error(`Composio did not persist alias ${assignment.alias}`)
      }
    }
  }
  return { updated: changed.length }
}

/**
 * Whether the key's project holds any of these accounts in any status. Composio refuses
 * an id from another project with a 4xx, which means no; a server error stays an error.
 */
async function composioHoldsAnyAccount(
  apiKey: string,
  ids: readonly string[],
  request: typeof fetch,
): Promise<boolean> {
  for (const id of ids) {
    const response = await request(`${COMPOSIO_CONNECTED_ACCOUNTS_ENDPOINT}/${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(COMPOSIO_REQUEST_TIMEOUT_MS),
      headers: { 'x-api-key': apiKey },
    })
    if (response.status >= 500) throw new Error(`Composio account read answered HTTP ${response.status}`)
    if (!response.ok) continue
    const json = await response.json().catch(() => undefined) as unknown
    if (typeof json === 'object' && json !== null && (json as Record<string, unknown>)['id'] === id) return true
  }
  return false
}

async function listComposioAccounts(
  apiKey: string,
  request: typeof fetch,
  toolkit?: string,
): Promise<ComposioConnectedAccount[]> {
  const accounts: ComposioConnectedAccount[] = []
  let cursor: string | undefined
  do {
    const endpoint = new URL(COMPOSIO_CONNECTED_ACCOUNTS_ENDPOINT)
    endpoint.searchParams.set('user_ids', COMPOSIO_USER_ID)
    if (toolkit !== undefined) endpoint.searchParams.set('toolkit_slugs', toolkit)
    endpoint.searchParams.set('statuses', 'ACTIVE')
    endpoint.searchParams.set('limit', '100')
    if (cursor !== undefined) endpoint.searchParams.set('cursor', cursor)
    const response = await request(endpoint, {
      signal: AbortSignal.timeout(COMPOSIO_REQUEST_TIMEOUT_MS),
      headers: { 'x-api-key': apiKey },
    })
    if (!response.ok) throw new Error(`Composio account listing answered HTTP ${response.status}`)
    const json = await response.json() as unknown
    if (typeof json !== 'object' || json === null || !Array.isArray((json as { items?: unknown }).items)) {
      throw new Error('Composio account listing returned no usable accounts')
    }
    for (const item of (json as { items: unknown[] }).items) accounts.push(parseComposioAccount(item))
    const next = (json as { next_cursor?: unknown }).next_cursor
    if (next !== undefined && next !== null && typeof next !== 'string') {
      throw new Error('Composio account listing returned an invalid cursor')
    }
    cursor = typeof next === 'string' && next.length > 0 ? next : undefined
  } while (cursor !== undefined)
  return accounts
}

/** Ids of the toolkit's active accounts, taken when a connect card appears without an account id. */
export async function composioActiveAccountIds(
  apiKey: string,
  toolkit: string,
  request: typeof fetch = fetch,
): Promise<string[]> {
  return (await listComposioAccounts(apiKey, request, toolkit)).map((account) => account.id)
}

export type ComposioConnectState = { status: 'active' } | { status: 'pending' } | { status: 'failed'; reason: string }

/**
 * Where one connect card's sign-in stands. Read-only: with an account id it reads that
 * account; without one it waits for a new active account of the toolkit under the alias.
 */
export async function composioConnectState(
  apiKey: string,
  target: { toolkit: string; alias?: string; accountId?: string; baseline?: readonly string[] },
  request: typeof fetch = fetch,
): Promise<ComposioConnectState> {
  if (target.accountId !== undefined) {
    const response = await request(`${COMPOSIO_CONNECTED_ACCOUNTS_ENDPOINT}/${encodeURIComponent(target.accountId)}`, {
      signal: AbortSignal.timeout(COMPOSIO_REQUEST_TIMEOUT_MS),
      headers: { 'x-api-key': apiKey },
    })
    if (!response.ok) throw new Error(`Composio account read answered HTTP ${response.status}`)
    const json = await response.json() as unknown
    const status = typeof json === 'object' && json !== null ? (json as Record<string, unknown>)['status'] : undefined
    if (status === 'ACTIVE') return { status: 'active' }
    if (status === 'FAILED') return { status: 'failed', reason: 'Composio reported the sign-in as failed.' }
    if (status === 'EXPIRED') return { status: 'failed', reason: 'The sign-in link expired.' }
    return { status: 'pending' }
  }
  if (target.baseline === undefined) return { status: 'pending' }
  const before = new Set(target.baseline)
  const accounts = await listComposioAccounts(apiKey, request, target.toolkit)
  const joined = accounts.some((account) =>
    !before.has(account.id) && account.userId === COMPOSIO_USER_ID &&
    (target.alias === undefined || account.alias === target.alias))
  return joined ? { status: 'active' } : { status: 'pending' }
}

/**
 * The tool router session behind the registered Composio row, which connect links belong
 * to. A recovery session still serves the Gmail sign-in it exists to restore.
 */
export function composioSessionId(
  server: Pick<McpServerConfig, 'url' | 'unavailable' | 'description'> | undefined,
  toolkit: string,
): string {
  const match = server?.url?.match(/^https:\/\/backend\.composio\.dev\/tool_router\/([^/]+)\/mcp$/)
  if (server === undefined || server.unavailable !== undefined || match?.[1] === undefined) {
    throw new Error('Composio is not connected on this Manor host. Press Test on the composio connector first.')
  }
  if (server.description !== COMPOSIO_MCP_DESCRIPTION && !(server.description === COMPOSIO_RECOVERY_DESCRIPTION && toolkit === 'gmail')) {
    throw new Error('Composio is in recovery mode until the personal Gmail account is reconnected.')
  }
  return match[1]
}

/**
 * A fresh single-use sign-in link for one app under one alias. Never without an alias:
 * an unaliased account is one no agent can address, so Manor refuses before Composio sees it.
 */
export async function createComposioConnectLink(
  apiKey: string,
  sessionId: string,
  toolkit: string,
  alias: string,
  request: typeof fetch = fetch,
): Promise<{ url: string; accountId: string }> {
  if (!(COMPOSIO_ACCOUNT_ALIASES as readonly string[]).includes(alias)) {
    throw new Error(`Manor only connects Composio apps under the ${COMPOSIO_ACCOUNT_ALIASES.join(' or ')} alias.`)
  }
  const response = await request(`${COMPOSIO_SESSION_ENDPOINT}/${encodeURIComponent(sessionId)}/link`, {
    method: 'POST',
    signal: AbortSignal.timeout(COMPOSIO_REQUEST_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({ toolkit, alias }),
  })
  if (!response.ok) throw new Error(await composioErrorText(response, 'Composio did not create a sign-in link'))
  const json = await response.json() as unknown
  const row = typeof json === 'object' && json !== null ? json as Record<string, unknown> : {}
  const url = row['redirect_url']
  const accountId = row['connected_account_id']
  if (typeof url !== 'string' || !isComposioConnectUrl(url) || typeof accountId !== 'string' || accountId.length === 0) {
    throw new Error('Composio returned no usable sign-in link.')
  }
  return { url, accountId }
}

/**
 * Deletes this host's active accounts of one app under one alias (null: its unaliased
 * ones). Answers how many went; zero means nothing matched.
 */
export async function disconnectComposioApp(
  apiKey: string,
  toolkit: string,
  alias: string | null,
  request: typeof fetch = fetch,
): Promise<number> {
  const accounts = (await listComposioAccounts(apiKey, request, toolkit)).filter((account) =>
    account.toolkit === toolkit && account.userId === COMPOSIO_USER_ID && account.alias === alias)
  for (const account of accounts) {
    const response = await request(`${COMPOSIO_CONNECTED_ACCOUNTS_ENDPOINT}/${encodeURIComponent(account.id)}`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(COMPOSIO_REQUEST_TIMEOUT_MS),
      headers: { 'x-api-key': apiKey },
    })
    // Already gone counts as done: the account is no longer there either way.
    if (!response.ok && response.status !== 404) {
      throw new Error(await composioErrorText(response, 'Composio did not remove the account'))
    }
  }
  return accounts.length
}

/** Composio's own message for a refusal, which says what is wrong; the status alone otherwise. */
async function composioErrorText(response: Response, fallback: string): Promise<string> {
  try {
    const json = await response.json() as { error?: { message?: unknown } }
    const message = json.error?.message
    if (typeof message === 'string' && message.length > 0) return `${fallback}: ${message.slice(0, 200)}`
  } catch {
    // Not JSON; the status says enough.
  }
  return `${fallback} (HTTP ${response.status}).`
}

async function listComposioGmailAccounts(
  apiKey: string,
  request: typeof fetch,
): Promise<ComposioConnectedAccount[]> {
  return listComposioAccounts(apiKey, request, 'gmail')
}

/** Active Composio toolkits on this host, grouped for the capability catalog. */
export async function listComposioConnectedApps(
  apiKey: string,
  request: typeof fetch = fetch,
): Promise<NonNullable<McpServerConfig['connectedApps']>> {
  const accounts = await listComposioAccounts(apiKey, request)
  const byToolkit = new Map<string, Set<string>>()
  for (const account of accounts) {
    if (account.userId !== COMPOSIO_USER_ID || account.status !== 'ACTIVE') continue
    const aliases = byToolkit.get(account.toolkit) ?? new Set<string>()
    if (account.alias !== null) aliases.add(account.alias)
    byToolkit.set(account.toolkit, aliases)
  }
  return [...byToolkit.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([toolkit, aliases]) => ({ toolkit, aliases: [...aliases].sort() }))
}

function parseComposioAccount(value: unknown): ComposioConnectedAccount {
  if (typeof value !== 'object' || value === null) throw new Error('Composio returned an invalid connected account')
  const row = value as Record<string, unknown>
  const toolkit = row['toolkit']
  if (
    typeof row['id'] !== 'string' ||
    !(typeof row['alias'] === 'string' || row['alias'] === null || row['alias'] === undefined) ||
    typeof row['status'] !== 'string' ||
    typeof row['user_id'] !== 'string' ||
    typeof toolkit !== 'object' || toolkit === null ||
    typeof (toolkit as Record<string, unknown>)['slug'] !== 'string'
  ) {
    throw new Error('Composio returned an invalid connected account')
  }
  return {
    id: row['id'],
    alias: typeof row['alias'] === 'string' && row['alias'].length > 0 ? row['alias'] : null,
    status: row['status'],
    toolkit: (toolkit as { slug: string }).slug,
    userId: row['user_id'],
  }
}

async function updateComposioAccountAlias(
  apiKey: string,
  accountId: string,
  alias: string,
  request: typeof fetch,
): Promise<void> {
  const response = await request(`${COMPOSIO_CONNECTED_ACCOUNTS_ENDPOINT}/${encodeURIComponent(accountId)}`, {
    method: 'PATCH',
    signal: AbortSignal.timeout(COMPOSIO_REQUEST_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({ alias }),
  })
  if (!response.ok) throw new Error(`Composio alias update answered HTTP ${response.status}`)
  const json = await response.json() as unknown
  if (
    typeof json !== 'object' || json === null ||
    (json as Record<string, unknown>)['success'] !== true ||
    (json as Record<string, unknown>)['id'] !== accountId
  ) {
    throw new Error('Composio alias update returned no confirmation')
  }
}

/**
 * Makes the server-side key sufficient setup: once present, Composio becomes a
 * normal registry connector that can be attached per persona. A bad key never
 * creates a row that would fail silently inside turns.
 */
export async function reconcileComposioServer(
  store: Pick<Store, 'saveMcpServer'>,
  registry: readonly McpServerConfig[],
  options: {
    env?: NodeJS.ProcessEnv
    probe?: typeof probeMcpServer
    createSession?: typeof createComposioSession
    createRecoverySession?: typeof createComposioRecoverySession
    migrateAliases?: typeof migrateComposioAccountAliases
    listConnectedApps?: typeof listComposioConnectedApps
    force?: boolean
  } = {},
): Promise<McpServerConfig[]> {
  const env = options.env ?? process.env
  const probe = options.probe ?? probeMcpServer
  const createSession = options.createSession ?? createComposioSession
  const createRecoverySession = options.createRecoverySession ?? createComposioRecoverySession
  const migrateAliases = options.migrateAliases ?? migrateComposioAccountAliases
  const listConnectedApps = options.listConnectedApps ?? listComposioConnectedApps
  const unavailable = (reason: string) => registry.map((server) =>
    server.name === COMPOSIO_MCP_NAME ? { ...server, unavailable: reason } : server,
  )
  const apiKeyEnv = composioApiKeyEnv(env)
  if (apiKeyEnv === undefined) return unavailable('The Composio API key is missing on this Manor host.')
  const key = env[apiKeyEnv]
  if (key === undefined || key.length === 0) return unavailable('The Composio API key is missing on this Manor host.')

  let migrated: { updated: number }
  try {
    migrated = await migrateAliases(key, undefined, composioGmailAccounts(env))
  } catch (migrationError: unknown) {
    console.warn(`[manor] the composio account contract needs recovery: ${errorMessage(migrationError)}`)
    try {
      const session = await createRecoverySession(key)
      const existing = registry.find((server) => server.name === COMPOSIO_MCP_NAME)
      const draft: McpServerDraft = {
        ...composioRecoveryMcpDraft(session.url, apiKeyEnv),
        ...(existing === undefined ? {} : { id: existing.id }),
      }
      const probed = await probe(draft, { env })
      if (
        probed.tools.length !== 1 ||
        probed.tools[0] !== COMPOSIO_MANAGE_CONNECTIONS_TOOL
      ) {
        throw new Error(`recovery session exposed unexpected tools: ${probed.tools.join(', ') || 'none'}`)
      }
      const saved = await store.saveMcpServer(draft, probed)
      console.warn('[manor] registered composio in connection-recovery mode')
      return existing === undefined
        ? [...registry, saved]
        : registry.map((server) => (server.id === saved.id ? saved : server))
    } catch (recoveryError: unknown) {
      console.warn(`[manor] the composio recovery connector is unavailable: ${errorMessage(recoveryError)}`)
      return unavailable('Composio could not connect or restore account access. Try reconnecting.')
    }
  }

  try {
    if (migrated.updated > 0) console.warn(`[manor] migrated ${migrated.updated} composio account aliases`)
    const existing = registry.find((server) => server.name === COMPOSIO_MCP_NAME)
    let connectedApps: NonNullable<McpServerConfig['connectedApps']> = existing?.connectedApps ?? []
    try {
      connectedApps = await listConnectedApps(key)
    } catch (listError: unknown) {
      console.warn(`[manor] composio connected-app listing failed: ${errorMessage(listError)}`)
    }
    const withApps = (server: McpServerConfig): McpServerConfig => ({ ...server, connectedApps })
    if (!options.force && existing !== undefined && composioRuntimeUnchanged(existing, apiKeyEnv)) {
      return registry.map((server) => (server.name === COMPOSIO_MCP_NAME ? withApps(server) : server))
    }

    const session = await createSession(key)
    const draft: McpServerDraft = {
      ...composioMcpDraft(session.url, apiKeyEnv),
      ...(existing === undefined ? {} : { id: existing.id }),
    }
    const probed = await probe(draft, { env })
    const saved = withApps(await store.saveMcpServer(draft, probed))
    console.warn(`[manor] ${existing === undefined ? 'registered' : 'updated'} composio connector (${probed.tools.length} tools)`)
    return existing === undefined
      ? [...registry, saved]
      : registry.map((server) => (server.id === saved.id ? saved : server))
  } catch (error: unknown) {
    console.warn(
      `[manor] the composio connector could not be reconciled: ${
        errorMessage(error)
      }`,
    )
    // A failed full session must not leave an older, unrestricted session live.
    return unavailable('Composio could not connect. Try reconnecting.')
  }
}

/**
 * A startup reconcile can fail only because the network was not up yet (`fetch
 * failed` right after login), and nothing else retries it, so the connector stayed
 * off until a restart or a manual Test. `check` runs the same path as Test and
 * answers whether Composio is available afterwards. Stops at the first success, or
 * as soon as something else (a Test) has already restored it.
 */
export function retryComposioInBackground(options: {
  isAvailable: () => boolean
  check: () => Promise<boolean>
  onGaveUp: () => void | Promise<void>
  attempts?: number
  delayMs?: number
  schedule?: (run: () => void, delay: number) => void
}): void {
  const attempts = options.attempts ?? 3
  const delayMs = options.delayMs ?? 60_000
  const schedule = options.schedule ?? ((run, delay) => {
    const timer = setTimeout(run, delay)
    timer.unref?.()
  })
  const attempt = (number: number) => schedule(() => {
    void (async () => {
      if (options.isAvailable()) return
      const ok = await options.check().catch(() => false)
      if (ok) {
        console.warn(`[manor] composio connector restored on retry ${number} of ${attempts}`)
        return
      }
      if (number < attempts) {
        attempt(number + 1)
        return
      }
      console.warn(`[manor] composio connector still unavailable after ${attempts} retries`)
      await options.onGaveUp()
    })().catch((error: unknown) => console.warn(`[manor] composio retry failed: ${errorMessage(error)}`))
  }, delayMs)
  attempt(1)
}

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : 'probe failed'

export function composioRuntimeUnchanged(existing: McpServerConfig, apiKeyEnv: string): boolean {
  return (
    existing.unavailable === undefined &&
    existing.command === '' &&
    COMPOSIO_MCP_URL.test(existing.url ?? '') &&
    existing.description === COMPOSIO_MCP_DESCRIPTION &&
    JSON.stringify(existing.envKeys) === JSON.stringify([apiKeyEnv]) &&
    JSON.stringify(existing.httpHeaders ?? []) === JSON.stringify([{ name: 'x-api-key', envKey: apiKeyEnv }])
  )
}
