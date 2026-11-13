import { randomUUID } from 'node:crypto'
import type { ThreadEvent } from '@manor/contracts'
import type { DraftEvent } from './store.js'
import type { UserInputContext } from './interactionCapability.js'
import type { ComposioConnectLink, ConnectOutcome } from './mcp/connectLinks.js'
import type { ComposioConnectState } from './mcp/composioRegistration.js'
import type { McpOAuthResult } from './mcp/oauth.js'

/**
 * How long a Composio connect call waits on its card before the agent hears "not yet".
 * Under Codex's default 60s MCP tool timeout, so every driver gets the same answer.
 */
export const CONNECT_HOLD_MS = 45_000
/** How long one click's sign-in may stay open before the card reads Failed. */
export const CONNECT_LIFETIME_MS = 10 * 60_000
const POLL_MS = 2_000
const again = (card: Pick<Card, 'report'>, reason: string) =>
  `${reason} ${card.report === undefined ? 'Ask the agent to connect again' : 'Press Connect again'} for a fresh link.`

export type ConnectRequest =
  | ({ kind: 'composio' } & ComposioConnectLink)
  | { kind: 'mcp_oauth'; serverId: string; app: string }

export type ConnectStatusFields = Omit<Extract<DraftEvent, { type: 'connect_status' }>, 'type' | 'agentId' | 'turnId' | 'connectId'>

/** Page cards belong to no chat; a chat's Open in browser can never reach one. */
const PAGE = ''

interface Card {
  connectId: string
  chatId: string
  agentId: string
  turnId: string
  request: ConnectRequest
  state: 'ready' | 'waiting' | 'connected' | 'failed'
  /** Active accounts before the sign-in; absent when an account id identifies it or the read failed. */
  baseline?: string[]
  /** Answers the agent's connect call while it still waits on this card. */
  answer?: (outcome: ConnectOutcome) => void
  poll?: ReturnType<typeof setInterval>
  deadline?: ReturnType<typeof setTimeout>
  forget?: ReturnType<typeof setTimeout>
  /** A Connectors page card reports here instead of to a chat transcript. */
  report?: (fields: ConnectStatusFields) => void
}

export interface ConnectCardDeps {
  /** Writes the card into its own live turn; false when that turn is over. */
  recordRequest: (context: UserInputContext, event: Extract<DraftEvent, { type: 'connect_request' }>) => Promise<boolean>
  /** Writes a status line for a card, during or after its turn. */
  appendStatus: (chatId: string, event: Extract<DraftEvent, { type: 'connect_status' }>) => Promise<void>
  loadEvents: (chatId: string) => Promise<readonly ThreadEvent[]>
  openUrl: (url: string) => Promise<void>
  beginOAuth: (serverId: string, onResult: (result: McpOAuthResult) => void) => Promise<void>
  composioState: (target: { toolkit: string; alias?: string; accountId?: string; baseline?: readonly string[] }) => Promise<ComposioConnectState>
  composioBaseline: (toolkit: string) => Promise<string[]>
  /** Keeps the turn's idle clocks still while the agent's call waits on a card. */
  hold?: (chatId: string, agentId: string) => void
  release?: (chatId: string, agentId: string) => void
  /** Refreshes a row's tools after its login landed. Best effort. */
  afterLogin?: (serverId: string) => Promise<void>
  /** Refreshes the connected-app list agents see after any Composio sign-in landed. Best effort. */
  afterComposioConnect?: () => Promise<void>
  holdMs?: number
  lifetimeMs?: number
  pollMs?: number
}

/**
 * Owns every connect card: records it, opens the sign-in only on the user's click, and
 * follows it to Connected or Failed. Links live here in memory, never in the transcript.
 */
export class ConnectCards {
  private readonly cards = new Map<string, Card>()

  constructor(private readonly deps: ConnectCardDeps) {}

  async request(context: UserInputContext, request: ConnectRequest): Promise<ConnectOutcome> {
    if (request.kind === 'mcp_oauth') {
      // One open login card per row and chat; each later turn would otherwise add one.
      const open = [...this.cards.values()].find((card) => card.chatId === context.chatId &&
        card.request.kind === 'mcp_oauth' && card.request.serverId === request.serverId &&
        (card.state === 'ready' || card.state === 'waiting'))
      if (open !== undefined) return { status: 'pending' }
    }
    // Taken before the card can be clicked, so a quick sign-in is never counted as old, and
    // inside the hold budget, so the agent's call still answers before Codex's 60s timeout.
    const started = Date.now()
    const holdMs = this.deps.holdMs ?? CONNECT_HOLD_MS
    const baseline = request.kind === 'composio' && request.accountId === undefined
      ? await Promise.race([
          this.deps.composioBaseline(request.toolkit).catch(() => undefined),
          new Promise<undefined>((resolve) => { setTimeout(() => resolve(undefined), holdMs).unref?.() }),
        ])
      : undefined
    const connectId = randomUUID()
    const app = request.kind === 'composio' ? request.toolkit : request.app
    const alias = request.kind === 'composio' ? request.alias : undefined
    const recorded = await this.deps.recordRequest(context, {
      type: 'connect_request',
      agentId: context.agentId,
      turnId: context.turnId,
      connectId,
      kind: request.kind,
      app,
      ...(alias === undefined ? {} : { alias }),
      ...(request.kind === 'mcp_oauth' ? { serverId: request.serverId } : {}),
    })
    if (!recorded) return { status: 'failed', reason: 'This turn has already ended.' }
    const card: Card = {
      connectId, chatId: context.chatId, agentId: context.agentId, turnId: context.turnId,
      request, state: 'ready',
      ...(baseline === undefined ? {} : { baseline }),
    }
    this.cards.set(connectId, card)
    if (request.kind === 'mcp_oauth') return { status: 'pending' }
    return this.holdFor(card, Math.max(0, holdMs - (Date.now() - started)))
  }

  /**
   * The user clicked Connect on the Connectors page. That click is the open click, so the
   * fresh link opens at once and the card follows it exactly as a chat card would.
   */
  async openPage(link: ComposioConnectLink & { accountId: string }, report: (fields: ConnectStatusFields) => void): Promise<void> {
    const connectId = randomUUID()
    this.cards.set(connectId, {
      connectId, chatId: PAGE, agentId: '', turnId: '', request: { kind: 'composio', ...link }, state: 'ready', report,
    })
    await this.open(PAGE, connectId)
  }

  /** The user clicked Open in browser, Reopen or Retry. False when this chat has no such card. */
  async open(chatId: string, connectId: string): Promise<boolean> {
    const card = this.cards.get(connectId) ?? (chatId === PAGE ? undefined : await this.restore(chatId, connectId))
    if (card === undefined || card.chatId !== chatId) return false
    // A Composio link is spent once opened, so only an MCP login may reopen.
    if (card.state === 'connected' || (card.state === 'waiting' && card.request.kind === 'composio')) return true
    if (card.request.kind === 'composio' && card.request.url.length === 0) {
      this.cards.delete(card.connectId)
      await this.status(card, { status: 'failed', reason: again(card, 'Manor restarted, so this sign-in link is gone.'), final: true })
      return true
    }
    this.stopTimers(card)
    if (card.state !== 'waiting') {
      card.state = 'waiting'
      await this.status(card, { status: 'waiting' })
    }
    if (card.request.kind === 'mcp_oauth') {
      // The login owns its own expiry and reports it through onResult.
      const { serverId } = card.request
      try {
        await this.deps.beginOAuth(serverId, (result) => void this.settleLogin(serverId, result))
      } catch (error: unknown) {
        await this.settleLogin(serverId, { status: 'failed', reason: error instanceof Error ? error.message : 'The sign-in did not start.' })
      }
      return true
    }
    // Without an account id or a baseline nothing can tell a new account from an old one.
    const checkable = card.request.accountId !== undefined || card.baseline !== undefined
    card.deadline = setTimeout(() => {
      void this.settle(card, { status: 'failed', reason: checkable
        ? again(card, 'The sign-in was not finished in time.')
        : 'Manor could not check this sign-in. If you finished it, tell the agent to continue.' }, true)
    }, this.deps.lifetimeMs ?? CONNECT_LIFETIME_MS)
    card.deadline.unref?.()
    try {
      await this.deps.openUrl(card.request.url)
    } catch {
      // Never the command's own error: it quotes the single-use link. The link was not used, so Retry may reopen it.
      await this.settle(card, { status: 'failed', reason: 'The browser did not open.' })
      return true
    }
    if (checkable) this.poll(card)
    return true
  }

  /**
   * One login per row: whichever card or Test started it, every card waiting on that row
   * follows it, and a success also clears that row's failed and unclicked cards, since the
   * row now holds a token whatever an older attempt reported.
   */
  private async settleLogin(serverId: string, result: McpOAuthResult): Promise<void> {
    const waiting = [...this.cards.values()].filter((card) =>
      card.request.kind === 'mcp_oauth' && card.request.serverId === serverId &&
      (card.state === 'waiting' || (result.status === 'connected' && card.state !== 'connected')))
    // Inherited listeners all fire for one login; only the first finds cards left to settle.
    if (waiting.length === 0) return
    await Promise.all(waiting.map((card) => this.settle(card, result)))
    if (result.status === 'connected') await this.deps.afterLogin?.(serverId).catch(() => undefined)
  }

  private async holdFor(card: Card, holdMs: number): Promise<ConnectOutcome> {
    this.deps.hold?.(card.chatId, card.agentId)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await new Promise<ConnectOutcome>((resolve) => {
        card.answer = resolve
        timer = setTimeout(() => resolve({ status: 'pending' }), holdMs)
      })
    } finally {
      clearTimeout(timer)
      delete card.answer
      this.deps.release?.(card.chatId, card.agentId)
    }
  }

  private poll(card: Card): void {
    if (card.request.kind !== 'composio') return
    const { toolkit, alias, accountId } = card.request
    let checking = false
    card.poll = setInterval(() => {
      if (checking || card.state !== 'waiting') return
      checking = true
      void this.deps.composioState({
        toolkit,
        ...(alias === undefined ? {} : { alias }),
        ...(accountId === undefined ? {} : { accountId }),
        ...(card.baseline === undefined ? {} : { baseline: card.baseline }),
      }).then(async (state) => {
        if (state.status === 'active') await this.settle(card, { status: 'connected' })
        else if (state.status === 'failed') await this.settle(card, { status: 'failed', reason: again(card, state.reason) }, true)
      }).catch(() => undefined).finally(() => { checking = false })
    }, this.deps.pollMs ?? POLL_MS)
    card.poll.unref?.()
  }

  /** `final` when the link is spent: Composio links are single-use, so only a new card can retry. */
  private async settle(card: Card, outcome: ConnectOutcome, final = false): Promise<void> {
    if (outcome.status === 'pending' || card.state === 'connected') return
    if (card.state !== 'waiting' && !(card.request.kind === 'mcp_oauth' && outcome.status === 'connected')) return
    this.stopTimers(card)
    card.state = outcome.status
    const nextMessage = card.request.kind === 'mcp_oauth' || card.answer === undefined
    await this.status(card, outcome.status === 'connected'
      ? { status: 'connected', ...(nextMessage ? { nextMessage: true as const } : {}) }
      : { status: 'failed', reason: outcome.reason, ...(final ? { final: true as const } : {}) })
    card.answer?.(outcome)
    if (outcome.status === 'connected' && card.request.kind === 'composio') {
      void this.deps.afterComposioConnect?.().catch(() => undefined)
    }
    if (outcome.status === 'connected' || final) {
      this.cards.delete(card.connectId)
      return
    }
    // A failed card stays for Retry a while, then a click restores it from the transcript.
    card.forget = setTimeout(() => this.cards.delete(card.connectId), this.deps.lifetimeMs ?? CONNECT_LIFETIME_MS)
    card.forget.unref?.()
  }

  private stopTimers(card: Card): void {
    clearInterval(card.poll)
    clearTimeout(card.deadline)
    clearTimeout(card.forget)
  }

  private status(card: Card, fields: ConnectStatusFields): Promise<void> {
    if (card.report !== undefined) {
      card.report(fields)
      return Promise.resolve()
    }
    return this.deps.appendStatus(card.chatId, {
      type: 'connect_status', agentId: card.agentId, turnId: card.turnId, connectId: card.connectId, ...fields,
    }).catch((error: unknown) => console.warn('[manor] could not record a connect card status', error))
  }

  /** A card the server no longer holds: an MCP login can start again, a Composio link cannot. */
  private async restore(chatId: string, connectId: string): Promise<Card | undefined> {
    const events = await this.deps.loadEvents(chatId)
    const event = events.find((item): item is Extract<ThreadEvent, { type: 'connect_request' }> =>
      item.type === 'connect_request' && item.connectId === connectId)
    if (event === undefined) return undefined
    const latest = [...events].reverse().find((item) => item.type === 'connect_status' && item.connectId === connectId)
    const request: ConnectRequest = event.kind === 'mcp_oauth' && event.serverId !== undefined
      ? { kind: 'mcp_oauth', serverId: event.serverId, app: event.app }
      : { kind: 'composio', toolkit: event.app, url: '', ...(event.alias === undefined ? {} : { alias: event.alias }) }
    const card: Card = {
      connectId, chatId, agentId: event.agentId, turnId: event.turnId, request,
      state: latest?.type === 'connect_status' && latest.status === 'connected' ? 'connected' : 'ready',
    }
    if (card.state !== 'connected') this.cards.set(connectId, card)
    return card
  }
}
