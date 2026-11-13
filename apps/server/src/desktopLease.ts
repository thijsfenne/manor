import { randomBytes } from 'node:crypto'

export class ComputerRefusedError extends Error {}

/** What the host needs to arm Escape: the request to answer and the token its stop carries. */
export interface ArmRequest {
  armId: number
  stopToken: string
}

/** How long the desktop host gets to confirm that Escape is registered. */
const ARM_TIMEOUT_MS = 5_000

interface Holder {
  turnId: string
  agentId: string
  /** `arming` until the host confirms Escape; `stopping` after Escape until the turn closes. */
  state: 'arming' | 'active' | 'stopping'
  /** Names this arm request, so a late answer to an older one cannot confirm this one. */
  armId: number
  /** The desktop shell posts this straight to the server when Escape is pressed. */
  stopToken: string
  /** Connectors the human approved on this lease. Each one's scope needs its own consent. */
  scopes: Set<string>
  armed: Promise<void>
  settle: (error?: ComputerRefusedError) => void
}

/**
 * One turn at a time drives the Mac. The first computer write of a turn asks for
 * the lease through the effect broker; once granted, it waits until the desktop
 * host confirms Escape is registered for that exact request, and only then does
 * the action run. Escape stops the turn, but the lease stays held until that turn
 * has closed, so no second turn can start while the first one may still be acting.
 */
export class DesktopLease<Host = unknown> {
  private holder: Holder | undefined
  private nextArmId = 1
  /** The desktop host that registers Escape. Only its answers and presses count. */
  private host: Host | undefined

  constructor(private readonly options: {
    nameOf: (agentId: string) => string
    /** Sent to the current host. `arm` is present when arming; the host echoes its `armId`. */
    onArmed: (host: Host, armed: boolean, arm?: ArmRequest) => void
    armTimeoutMs?: number
  }) {}

  /**
   * A host announced it can arm Escape. The same host again changes nothing; a new
   * one ends any lease armed on the old host. Returns the turn to stop.
   */
  attachHost(host: Host): string | undefined {
    if (this.host === host) return undefined
    const orphaned = this.stop()
    this.host = host
    this.options.onArmed(host, false)
    return orphaned
  }

  /** The host's socket closed: nothing can press Escape for a lease any more. */
  detachHost(host: Host): string | undefined {
    if (this.host !== host) return undefined
    const orphaned = this.stop()
    this.host = undefined
    return orphaned
  }

  isHost(host: Host): boolean {
    return this.host === host
  }

  private arm(armed: boolean, arm?: ArmRequest): void {
    if (this.host !== undefined) this.options.onArmed(this.host, armed, arm)
  }

  /**
   * Escape or a reload, posted by the desktop shell itself. Only the current lease's
   * token counts, so a stop from an earlier lease cannot end a later turn.
   * Returns the turn to stop.
   */
  stopWith(stopToken: string): string | undefined {
    return this.holder?.stopToken === stopToken ? this.stop() : undefined
  }

  /** Throws when this turn may not touch the desktop now; otherwise says whether it holds the lease. */
  admit(turnId: string): 'held' | 'free' {
    const holder = this.holder
    if (holder?.turnId === turnId && holder.state === 'stopping') {
      throw new ComputerRefusedError('The user stopped computer use with Escape. Do not retry in this turn.')
    }
    if (this.host === undefined) {
      throw new ComputerRefusedError('Computer use needs the Manor desktop app open, because its Escape key is the stop.')
    }
    if (holder === undefined) return 'free'
    if (holder.turnId === turnId) return 'held'
    throw new ComputerRefusedError(
      `The Mac is in use by ${this.options.nameOf(holder.agentId)} in another turn. Say so instead of retrying.`,
    )
  }

  /** Whether the human already approved `scope` on this turn's lease. */
  covers(turnId: string, scope: string): boolean {
    return this.holder?.turnId === turnId && this.holder.scopes.has(scope)
  }

  /** Resolves once Escape is armed for this turn; rejects if it never is. */
  ready(turnId: string): Promise<void> {
    const holder = this.holder
    if (holder?.turnId !== turnId) return Promise.reject(new ComputerRefusedError('This turn does not hold the Mac.'))
    return holder.armed
  }

  /**
   * Takes the lease for an approved `scope` and arms Escape, or adds the scope to the
   * lease this turn already holds. The first action waits on the returned promise.
   */
  grant(turnId: string, agentId: string, scope: string): Promise<void> {
    if (this.admit(turnId) === 'held') {
      this.holder?.scopes.add(scope)
      return this.ready(turnId)
    }
    let settle!: Holder['settle']
    const armed = new Promise<void>((resolve, reject) => {
      settle = (error) => (error === undefined ? resolve() : reject(error))
    })
    // Same-turn calls racing the first one share its outcome; nobody reads an unhandled rejection.
    armed.catch(() => undefined)
    const armId = this.nextArmId++
    const stopToken = randomBytes(16).toString('hex')
    const holder: Holder = { turnId, agentId, state: 'arming', armId, stopToken, scopes: new Set([scope]), armed, settle }
    this.holder = holder
    const timer = setTimeout(() => this.confirmArmed(armId, false), this.options.armTimeoutMs ?? ARM_TIMEOUT_MS)
    void armed.finally(() => clearTimeout(timer)).catch(() => undefined)
    this.arm(true, { armId, stopToken })
    return armed
  }

  /** The desktop host's answer to arm request `armId`. Any other answer is stale and ignored. */
  confirmArmed(armId: number, ok: boolean): void {
    const holder = this.holder
    if (holder === undefined || holder.armId !== armId || holder.state !== 'arming') return
    if (ok) {
      holder.state = 'active'
      holder.settle()
      return
    }
    // Nothing ran yet, so the Mac is free again at once.
    this.holder = undefined
    this.arm(false)
    holder.settle(new ComputerRefusedError('The Escape stop could not be armed, so computer use did not start.'))
  }

  /** Terminal turns release in the same fan-out as every other turn capability. */
  closeTurn(turnId: string): void {
    const holder = this.holder
    if (holder?.turnId !== turnId) return
    this.holder = undefined
    if (holder.state !== 'stopping') this.arm(false)
    holder.settle(new ComputerRefusedError('The turn ended before computer use started.'))
  }

  /**
   * Escape, or the desktop host going away mid-lease. Returns the turn to stop.
   * The lease stays held, arming or not, until that turn's `closeTurn`.
   */
  stop(): string | undefined {
    const holder = this.holder
    if (holder === undefined || holder.state === 'stopping') return undefined
    const wasArming = holder.state === 'arming'
    holder.state = 'stopping'
    this.arm(false)
    if (wasArming) holder.settle(new ComputerRefusedError('The user stopped computer use with Escape. Do not retry in this turn.'))
    return holder.turnId
  }
}
