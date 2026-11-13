import { BROWSER_HOME_SESSION_ID, type DesktopBrowserBridge, type ServerMessage } from '@manor/contracts'

const SETTLED_MEMORY = 500

/**
 * Which browser sessions an agent turn is using, and which pending tool actions may
 * still run. Holding and cancelling are separate: a session stays held while any of
 * its turns runs, and an action is cancelled as soon as its own turn stops.
 */
export class BrowserCursorLifecycle {
  /** Actions without a turn id (the server's own context reads) keep the per-agent owner. */
  private readonly owners = new Map<string, { agentId: string }>()
  /** Running turns per broker session. Several Browser-session chats share the home tabs. */
  private readonly held = new Map<string, Set<string>>()
  /** Recently settled turns, so a late snapshot, reconnect list or tool cannot revive one. */
  private readonly settled = new Set<string>()
  /** Tool actions still running per turn, keyed by their own check, and the session they run on. */
  private readonly inFlight = new Map<string, { session: string; actions: Set<() => boolean> }>()
  /** Bumped on disconnect: a tool from before a reconnect stays cancelled even when its turn is held again. */
  private generation = 0

  constructor(
    private readonly browser: () => DesktopBrowserBridge | undefined,
    private readonly onEnd: (chatId: string) => void = () => {},
    /** The broker session a chat's turn drives: its own id, or the home tabs for a browser session. */
    private readonly sessionOf: (chatId: string) => string = (chatId) => chatId,
  ) {}

  /** Marks a tool action as started; the returned check says whether it may still run. */
  begin(chatId: string, agentId: string, turnId?: string): () => boolean {
    if (turnId !== undefined) {
      if (this.settled.has(turnId)) return () => false
      this.hold(chatId, turnId)
      const generation = this.generation
      const check = () => this.generation === generation && this.held.get(chatId)?.has(turnId) === true
      const running = this.inFlight.get(turnId) ?? { session: chatId, actions: new Set() }
      this.inFlight.set(turnId, running)
      running.actions.add(check)
      return check
    }
    const previous = this.owners.get(chatId)
    const owner = previous?.agentId === agentId ? previous : { agentId }
    this.owners.set(chatId, owner)
    return () => this.owners.get(chatId) === owner
  }

  receive(message: ServerMessage): void {
    if (message.type === 'turn_state') {
      if (message.state === 'running') {
        // A Browser session's whole turn is browser work, so its tabs are held from the start.
        const session = this.sessionOf(message.chatId)
        if (session !== message.chatId) this.hold(session, message.turnId)
        return
      }
      this.settle(message.chatId, message.turnId, message.agentId)
    }
    // Reconnect: `running` is never repeated, so the server lists what is still going.
    if (message.type === 'browser_session_turns') {
      for (const turnId of message.turnIds) {
        if (!this.settled.has(turnId)) this.hold(BROWSER_HOME_SESSION_ID, turnId)
      }
    }
    if (message.type === 'snapshot' && message.activeTurn !== undefined && !this.settled.has(message.activeTurn.turnId)) {
      const session = this.sessionOf(message.chatId)
      if (session !== message.chatId) this.hold(session, message.activeTurn.turnId)
    }
    if (message.type === 'browser_session_close') this.end(message.chatId)
  }

  /** A tool action answered, identified by the check `begin` returned; its turn no longer has input to interrupt. */
  finish(action: () => boolean): void {
    for (const [turnId, running] of this.inFlight) {
      if (running.actions.delete(action) && running.actions.size === 0) this.inFlight.delete(turnId)
    }
  }

  end(chatId: string): void {
    const heldHere = this.held.delete(chatId)
    if (!this.owners.delete(chatId) && !heldHere) return
    this.onEnd(chatId)
    void this.browser()?.endAgentUse?.(chatId).catch(() => {
      // Closing the desktop can destroy the native host before cleanup arrives.
    })
  }

  disconnect(): void {
    this.generation += 1
    this.inFlight.clear()
    for (const chatId of new Set([...this.owners.keys(), ...this.held.keys()])) this.end(chatId)
  }

  private hold(session: string, turnId: string): void {
    const turns = this.held.get(session) ?? new Set<string>()
    this.held.set(session, turns.add(turnId))
    void this.browser()?.beginAgentUse?.(session).catch(() => {})
  }

  /** Turn ids are unique, so the release does not depend on knowing the chat's kind yet. */
  private settle(chatId: string, turnId: string, agentId: string): void {
    this.settled.add(turnId)
    // Insertion order makes the first entry the oldest; a few hundred cover any race.
    const [oldest] = this.settled
    if (this.settled.size > SETTLED_MEMORY && oldest !== undefined) this.settled.delete(oldest)
    for (const [session, turns] of this.held) {
      if (turns.delete(turnId) && turns.size === 0) this.end(session)
    }
    // Still held by another turn, so ending the session would not stop this turn's own action.
    const running = this.inFlight.get(turnId)
    this.inFlight.delete(turnId)
    if (running !== undefined && this.held.has(running.session)) {
      void this.browser()?.interruptAgentInput?.(running.session).catch(() => {})
    }
    const session = this.sessionOf(chatId)
    if (!this.held.has(session) && this.owners.get(session)?.agentId === agentId) this.end(session)
  }
}
