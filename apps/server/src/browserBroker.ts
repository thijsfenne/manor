import { randomUUID } from 'node:crypto'
import { EFFECT_REVIEW_TIMEOUT_MS } from './effectReviewer.js'
import { browserApprovalSnapshot } from './browserEffectReview.js'
import type { BrowserToolName, ServerMessage } from '@manor/contracts'

const DEFAULT_TIMEOUT_MS = 30_000

/**
 * Cover a complete automatic review plus the action's host-response budget.
 * Human approval releases the lock and does not consume this wait.
 */
const DEFAULT_LOCK_WAIT_MS = EFFECT_REVIEW_TIMEOUT_MS + DEFAULT_TIMEOUT_MS

export interface BrowserHostSocket {
  send(payload: string): void
}

export interface BrowserActor {
  id: string
  name: string
  /** Set for an agent's MCP call, so the desktop can cancel it with exactly that turn. */
  turnId?: string
}

interface PendingRequest {
  host: BrowserHostSocket
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

interface Waiter {
  actor: BrowserActor
  grant(): void
  fail(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

/** One hold of a chat's browser, from `BrowserBroker.session`. */
export interface HeldBrowser {
  dispatch(tool: BrowserToolName, arguments_: Record<string, unknown>): Promise<unknown>
  snapshot(): Promise<unknown>
  /**
   * Releases the browser while the user decides, then takes it back. `samePage` refuses
   * when the page moved on meanwhile; without it the caller re-checks what it needs.
   */
  waitForHuman<T>(wait: () => Promise<T>, options: { samePage: boolean }): Promise<T>
}

interface ChatLock {
  holder: BrowserActor
  waiting: Waiter[]
}

/**
 * Routes a browser tool call to the one connected Electron renderer. The renderer
 * is deliberately the host rather than the server process: it is the only process
 * that can reach Electron's isolated WebContentsView without exposing CDP.
 *
 * It is also the arbiter. One chat's browser session is a single shared surface, so
 * two personas in one room take it in turns: the second call waits for the first to
 * settle and then fails by name rather than interleaving two half-finished actions
 * on the same page.
 */
export class BrowserBroker {
  private host: BrowserHostSocket | null = null
  private readonly pending = new Map<string, PendingRequest>()
  private readonly locks = new Map<string, ChatLock>()
  private readonly sessions = new Map<string, { revision: number }>()

  constructor(
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
    private readonly lockWaitMs = DEFAULT_LOCK_WAIT_MS,
  ) {}

  register(host: BrowserHostSocket): void {
    if (this.host !== null && this.host !== host) this.rejectHost(this.host, 'The desktop browser host was replaced.')
    this.host = host
  }

  isReady(): boolean { return this.host !== null }

  unregister(host: BrowserHostSocket): void {
    if (this.host !== host) return
    this.host = null
    this.rejectHost(host, 'The Manor desktop app closed before the browser action finished.')
  }

  /**
   * Deliberately not `async`: an uncontended call must reach the host in the same
   * tick it was made, so the one queued behind it can never be sent first by the
   * scheduler rather than by the lock.
   */
  request(
    chatId: string,
    tool: BrowserToolName,
    arguments_: Record<string, unknown>,
    actor: BrowserActor,
    authorize?: (
      snapshot: () => Promise<unknown>,
      waitForHuman: <T>(wait: () => Promise<T>) => Promise<T>,
    ) => Promise<void>,
  ): Promise<unknown> {
    return this.session(chatId, actor, async (session) => {
      if (authorize !== undefined) {
        await authorize(session.snapshot, (wait) => session.waitForHuman(wait, { samePage: true }))
      }
      return session.dispatch(tool, arguments_)
    })
  }

  /**
   * Several host calls under one hold of the chat's browser, for an action that needs
   * the host's answer before it knows what to ask the user, such as a saved-login fill.
   * Not `async` for the same reason as `request`.
   */
  session<T>(chatId: string, actor: BrowserActor, work: (session: HeldBrowser) => Promise<T>): Promise<T> {
    // A disconnected host should fail immediately, without joining the queue.
    if (this.host === null) return Promise.reject(new Error('No Manor desktop browser host is connected.'))
    const session = this.sessions.get(chatId) ?? { revision: 0 }
    this.sessions.set(chatId, session)
    const run = async () => {
      let lock = this.locks.get(chatId)
      let held = true
      const host = this.host
      const assertOrigin = () => {
        if (host === null || this.host !== host || this.sessions.get(chatId) !== session) {
          throw new Error('The browser session changed before the action was approved.')
        }
      }
      const assertSession = () => {
        assertOrigin()
        if (!held || this.locks.get(chatId) !== lock) {
          throw new Error('The browser session changed before the action was approved.')
        }
      }
      const dispatch = (tool: BrowserToolName, arguments_: Record<string, unknown>) => {
        assertSession()
        return this.dispatch(chatId, tool, arguments_, actor)
      }
      const snapshot = () => dispatch('browser_snapshot', {})
      const waitForHuman = async <R>(wait: () => Promise<R>, { samePage }: { samePage: boolean }): Promise<R> => {
        const before = samePage ? browserApprovalSnapshot(await snapshot()) : undefined
        assertSession()
        const revision = session.revision
        held = false
        this.release(chatId)
        const result = await wait()
        assertOrigin()
        const queued = this.acquire(chatId, actor)
        if (queued !== null) await queued
        lock = this.locks.get(chatId)
        held = true
        assertSession()
        if (!samePage) return result
        const after = browserApprovalSnapshot(await snapshot())
        if (session.revision !== revision || JSON.stringify(before) !== JSON.stringify(after)) {
          throw new Error('The browser page changed while waiting for approval. Take a fresh browser_snapshot before trying again.')
        }
        return result
      }
      try {
        return await work({ dispatch, snapshot, waitForHuman })
      } finally {
        if (held && this.locks.get(chatId) === lock) this.release(chatId)
      }
    }
    const queued = this.acquire(chatId, actor)
    // A rejected wait never held the lock, so it must not release one either.
    return queued === null ? run() : queued.then(run)
  }

  settle(
    host: BrowserHostSocket,
    result: { requestId: string; ok: boolean; result?: unknown; error?: string },
  ): void {
    const pending = this.pending.get(result.requestId)
    if (pending === undefined || pending.host !== host) return
    this.pending.delete(result.requestId)
    clearTimeout(pending.timer)
    if (result.ok) pending.resolve(result.result)
    else pending.reject(new Error(result.error ?? 'The browser action failed.'))
  }

  /**
   * The reverse state of a live session. Everything waiting for a chat that no
   * longer exists is failed here rather than left to time out against a session the
   * desktop host is about to destroy.
   */
  closeChat(chatId: string): void {
    this.sessions.delete(chatId)
    const lock = this.locks.get(chatId)
    if (lock !== undefined) {
      this.locks.delete(chatId)
      for (const waiter of lock.waiting) {
        clearTimeout(waiter.timer)
        waiter.fail(new Error('This chat and its browser session were closed.'))
      }
    }
    const host = this.host
    if (host === null) return
    const message: ServerMessage = { type: 'browser_session_close', chatId }
    try {
      host.send(JSON.stringify(message))
    } catch {
      this.unregister(host)
    }
  }

  private async dispatch(
    chatId: string,
    tool: BrowserToolName,
    arguments_: Record<string, unknown>,
    actor: BrowserActor,
  ): Promise<unknown> {
    const host = this.host
    if (host === null) throw new Error('No Manor desktop browser host is connected.')
    // Any intervening interaction invalidates an approval even if the DOM looks
    // unchanged (input values need not appear in the text snapshot).
    if (tool !== 'browser_snapshot' && tool !== 'browser_screenshot') {
      const session = this.sessions.get(chatId)
      if (session !== undefined) session.revision += 1
    }
    const requestId = randomUUID()
    const message: ServerMessage = {
      type: 'browser_tool_request',
      requestId,
      chatId,
      actor: { id: actor.id, name: actor.name },
      ...(actor.turnId === undefined ? {} : { turnId: actor.turnId }),
      tool,
      arguments: arguments_,
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error('The Manor desktop browser host did not answer in time.'))
      }, this.timeoutMs)
      timer.unref?.()
      this.pending.set(requestId, { host, resolve, reject, timer })
      try {
        host.send(JSON.stringify(message))
      } catch (error: unknown) {
        clearTimeout(timer)
        this.pending.delete(requestId)
        reject(error instanceof Error ? error : new Error('The browser request could not be sent.'))
      }
    })
  }

  /** Null when the lock was free and is now this actor's; a promise when it was not. */
  private acquire(chatId: string, actor: BrowserActor): Promise<void> | null {
    const held = this.locks.get(chatId)
    if (held === undefined) {
      this.locks.set(chatId, { holder: actor, waiting: [] })
      return null
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        actor,
        grant: resolve,
        fail: reject,
        timer: setTimeout(() => {
          const lock = this.locks.get(chatId)
          if (lock !== undefined) lock.waiting = lock.waiting.filter((candidate) => candidate !== waiter)
          const holder = lock?.holder.name ?? 'Another agent'
          reject(new Error(
            `${holder} is using this chat's browser. Only one agent drives it at a time; say so and try again later.`,
          ))
        }, this.lockWaitMs),
      }
      waiter.timer.unref?.()
      held.waiting.push(waiter)
    })
  }

  private release(chatId: string): void {
    const lock = this.locks.get(chatId)
    if (lock === undefined) return
    const next = lock.waiting.shift()
    if (next === undefined) {
      this.locks.delete(chatId)
      return
    }
    clearTimeout(next.timer)
    lock.holder = next.actor
    next.grant()
  }

  private rejectHost(host: BrowserHostSocket, message: string): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.host !== host) continue
      clearTimeout(pending.timer)
      this.pending.delete(requestId)
      pending.reject(new Error(message))
    }
  }
}
