import type {
  ClientMessage,
  ComposioAlias,
  ComposioApp,
  ComposioConnectedApp,
  ComposioPageConnect,
  McpServerConfig,
  ServerMessage,
} from '@manor/contracts'
import type { ConnectCards, ConnectStatusFields } from './connectCards.js'
import { COMPOSIO_MCP_NAME } from './mcp/composioAttachment.js'

/** Long enough that opening the page is instant all day; Composio adds apps weekly, not hourly. */
export const COMPOSIO_CATALOG_TTL_MS = 6 * 60 * 60_000

/** What the page needs from Composio. Live ones call its API; the spike's are in memory. */
export interface ComposioMarketplacePorts {
  catalog: () => Promise<ComposioApp[]>
  connectedApps: () => Promise<ComposioConnectedApp[]>
  createLink: (toolkit: string, alias: ComposioAlias) => Promise<{ url: string; accountId: string }>
  /** Answers how many accounts went. */
  disconnect: (toolkit: string, alias: ComposioAlias | null) => Promise<number>
}

type MarketplaceMessage = Extract<ClientMessage, { type: 'list_composio_apps' | 'connect_composio_app' | 'disconnect_composio_app' }>

interface ComposioMarketplaceDeps {
  ports: ComposioMarketplacePorts
  openPage: ConnectCards['openPage']
  mcpServers: () => readonly McpServerConfig[]
  setMcpServers: (servers: readonly McpServerConfig[]) => void
  broadcast: (message: ServerMessage) => void
  ttlMs?: number
  now?: () => number
  /** Waits between account re-reads after a change, when Composio does not answer at once. */
  retryDelaysMs?: readonly number[]
}

const errorText = (error: unknown): string => error instanceof Error ? error.message : 'Composio did not answer.'
const key = (toolkit: string, alias: ComposioAlias) => `${toolkit}:${alias}`

/**
 * The Connectors page's Composio marketplace. Owns the catalogue cache and the page's
 * own connects, and keeps the composio row's connected apps (the list every agent's
 * turn reads) in step with Composio after each connect and disconnect.
 */
export class ComposioMarketplace {
  private cached?: { apps: ComposioApp[]; at: number }
  private loading?: Promise<ComposioApp[]>
  private connected: ComposioConnectedApp[] = []
  private unavailable?: string
  private readonly connects = new Map<string, ComposioPageConnect>()
  /** Account reads in start order; one that began before the newest applied one is stale. */
  private reads = 0
  private applied = 0

  constructor(private readonly deps: ComposioMarketplaceDeps) {}

  /** Cached for the TTL; concurrent asks share one fetch, and a failed refresh keeps the last good copy. */
  async catalog(): Promise<ComposioApp[]> {
    const now = this.deps.now ?? Date.now
    if (this.cached !== undefined && now() - this.cached.at < (this.deps.ttlMs ?? COMPOSIO_CATALOG_TTL_MS)) {
      return this.cached.apps
    }
    this.loading ??= this.deps.ports.catalog()
      .then((apps) => {
        this.cached = { apps, at: now() }
        return apps
      })
      .finally(() => { this.loading = undefined })
    try {
      return await this.loading
    } catch (error: unknown) {
      if (this.cached !== undefined) return this.cached.apps
      throw error
    }
  }

  /**
   * After the Composio key changed: forgets what the old key saw. `apps` is the
   * catalogue the new key was checked with, so the next page visit is instant.
   */
  reset(apps?: ComposioApp[]): void {
    const now = this.deps.now ?? Date.now
    this.cached = apps === undefined ? undefined : { apps, at: now() }
    this.loading = undefined
    this.connected = []
    this.unavailable = undefined
    this.connects.clear()
    this.applied = ++this.reads
  }

  /** Re-reads the connected apps, hands them to the agents' registry row and to every open page. */
  async refreshConnected(): Promise<void> {
    const ticket = ++this.reads
    const connected = await this.deps.ports.connectedApps()
    // A read that began before a newer one, say before a disconnect, must not land after it.
    if (ticket < this.applied) return
    this.applied = ticket
    this.publish(connected)
  }

  /**
   * After a sign-in landed or an account went: agents learn of it only through this,
   * so a Composio hiccup is retried rather than left until the next page visit.
   */
  async settleAccounts(): Promise<void> {
    const delays = this.deps.retryDelaysMs ?? [2_000, 10_000, 30_000]
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.refreshConnected()
        return
      } catch (error: unknown) {
        const delay = delays[attempt]
        if (delay === undefined) {
          this.unavailable = errorText(error)
          this.deps.broadcast(this.accounts())
          return
        }
        await new Promise((resolve) => { setTimeout(resolve, delay).unref?.() })
      }
    }
  }

  async handle(message: MarketplaceMessage, reply: (message: ServerMessage) => void, ack: () => void): Promise<void> {
    switch (message.type) {
      case 'list_composio_apps': {
        await Promise.all([
          this.refreshConnected().catch((error: unknown) => {
            this.unavailable = errorText(error)
            reply(this.accounts())
          }),
          this.catalog().then(
            (apps) => reply({ type: 'composio_catalog', apps }),
            (error: unknown) => reply({ type: 'composio_catalog', apps: [], unavailable: errorText(error) }),
          ),
        ])
        return
      }
      case 'connect_composio_app':
        await this.connect(message.toolkit, message.alias, reply, ack)
        return
      case 'disconnect_composio_app': {
        const { toolkit, alias } = message
        try {
          await this.deps.ports.disconnect(toolkit, alias)
        } catch (error: unknown) {
          reply({ type: 'notice', kind: 'error', text: errorText(error) })
          return
        }
        if (alias !== null) this.connects.delete(key(toolkit, alias))
        try {
          await this.refreshConnected()
        } catch {
          // The account is gone; until Composio lists again, drop it here so no agent is offered
          // it, and outrank any read already under way. Named aliases survive a null disconnect.
          this.applied = ++this.reads
          this.publish(this.connected.flatMap((app) => {
            if (app.toolkit !== toolkit) return [app]
            const aliases = alias === null ? app.aliases : app.aliases.filter((name) => name !== alias)
            return aliases.length === 0 ? [] : [{ ...app, aliases }]
          }))
          void this.settleAccounts()
        }
        ack()
        return
      }
    }
  }

  private async connect(toolkit: string, alias: ComposioAlias, reply: (message: ServerMessage) => void, ack: () => void): Promise<void> {
    let app: ComposioApp | undefined
    try {
      app = (await this.catalog()).find((candidate) => candidate.slug === toolkit)
    } catch (error: unknown) {
      reply({ type: 'notice', kind: 'error', text: errorText(error) })
      return
    }
    const refusal = app === undefined
      ? 'Composio does not list that app.'
      : app.connect === 'no_auth'
        ? `${app.name} needs no sign-in; agents can use it as it is.`
        : app.connect === 'own_credentials'
          ? `${app.name} needs its own credentials set up in Composio before it can connect.`
          : this.connected.some((entry) => entry.toolkit === toolkit && entry.aliases.includes(alias))
            ? `${app.name} is already connected as ${alias}.`
            : undefined
    if (refusal !== undefined) {
      reply({ type: 'notice', kind: 'error', text: refusal })
      return
    }
    // Checked and claimed with no await between, so a double click or a second window
    // follows the sign-in already open instead of making a second account.
    if (this.connects.get(key(toolkit, alias))?.status === 'waiting') {
      ack()
      return
    }
    this.setConnect({ toolkit, alias, status: 'waiting' })
    let link: { url: string; accountId: string }
    try {
      link = await this.deps.ports.createLink(toolkit, alias)
    } catch (error: unknown) {
      this.setConnect({ toolkit, alias, status: 'failed', reason: errorText(error).slice(0, 300) })
      reply({ type: 'notice', kind: 'error', text: errorText(error) })
      return
    }
    await this.deps.openPage({ toolkit, alias, ...link }, (fields) => this.follow(toolkit, alias, fields))
    ack()
  }

  /** The card's statuses, as the page shows them. The registry refresh rides on ConnectCards' own hook. */
  private follow(toolkit: string, alias: ComposioAlias, fields: ConnectStatusFields): void {
    this.setConnect({
      toolkit, alias, status: fields.status,
      ...(fields.status === 'failed' && fields.reason !== undefined ? { reason: fields.reason.slice(0, 300) } : {}),
    })
  }

  private setConnect(connect: ComposioPageConnect): void {
    this.connects.set(key(connect.toolkit, connect.alias), connect)
    this.deps.broadcast(this.accounts())
  }

  private publish(connected: ComposioConnectedApp[]): void {
    this.connected = connected
    this.unavailable = undefined
    this.syncRegistry()
    this.deps.broadcast(this.accounts())
  }

  private accounts(): ServerMessage {
    return {
      type: 'composio_accounts',
      connected: this.connected,
      connects: [...this.connects.values()],
      ...(this.unavailable === undefined ? {} : { unavailable: this.unavailable }),
    }
  }

  private syncRegistry(): void {
    const servers = this.deps.mcpServers()
    const row = servers.find((server) => server.name === COMPOSIO_MCP_NAME)
    if (row === undefined || JSON.stringify(row.connectedApps ?? []) === JSON.stringify(this.connected)) return
    const next = servers.map((server) => server === row ? { ...server, connectedApps: this.connected } : server)
    this.deps.setMcpServers(next)
    this.deps.broadcast({ type: 'mcp_servers', servers: [...next] })
  }
}
