import type { ClientMessage, ServerMessage } from '@manor/contracts'
import type { OpenLoopsSync } from './openLoopsSync.js'
import { amsterdamToday, reflects, type RemindersSource, type RemindersState } from './reminders.js'

/** Reads after a write until the snapshot shows it. RemCTL's private writes land up to ~3 s late. */
const SETTLE_READS = 10
const SETTLE_PAUSE_MS = 500

type RemindersMessage = Extract<ClientMessage, { type: 'reminders_load' | 'reminders_load_completed' | 'reminders_write' }>

interface RemindersModuleOptions {
  /** Absent on a host without Apple Reminders; the door is hidden there. */
  source?: RemindersSource
  broadcast: (message: ServerMessage) => void
  /** Injected by tests so settling does not sleep. */
  pause?: (ms: number) => Promise<void>
  /** The memory folder's open-loops ledger kept in step with its Reminders list; runs after every door write. */
  openLoops?: Pick<OpenLoopsSync, 'run'>
}

/**
 * The Reminders door's protocol. Reads and writes run one at a time, so a poll that
 * started before a write can never land after the write's fresh snapshot, and polls
 * that pile up behind a slow read share its answer.
 */
export class RemindersModule {
  private tail: Promise<unknown> = Promise.resolve()
  private pendingLoad: Promise<RemindersState> | undefined
  private pendingSync: Promise<void> | undefined
  private lastSyncFailure: string | undefined

  constructor(private readonly options: RemindersModuleOptions) {}

  available(): boolean {
    return this.options.source !== undefined
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work, work)
    this.tail = run.catch(() => undefined)
    return run
  }

  private load(source: RemindersSource): Promise<RemindersState> {
    if (this.pendingLoad !== undefined) return this.pendingLoad
    const load = this.serial(() => source.load()).finally(() => {
      if (this.pendingLoad === load) this.pendingLoad = undefined
    })
    this.pendingLoad = load
    return load
  }

  /**
   * One open-loops sync in the same queue as the door's reads and writes, so its fresh
   * snapshot can never land behind an older one. Calls that arrive while one waits to
   * start share it. Never throws: a failed sync is logged and tried again on the next.
   */
  syncOpenLoops(): Promise<void> {
    const { openLoops, source } = this.options
    if (openLoops === undefined || source === undefined) return Promise.resolve()
    if (this.pendingSync !== undefined) return this.pendingSync
    const sync = this.serial(async () => {
      this.pendingSync = undefined
      const report = await openLoops.run()
      this.lastSyncFailure = undefined
      if (report !== 'busy' && report.wroteReminders) this.options.broadcast(await source.load())
    }).catch((error: unknown) => {
      // Said once per cause, not on every poll.
      const failure = error instanceof Error ? error.message : 'unknown error'
      if (failure !== this.lastSyncFailure) console.warn(`[manor] open loops sync failed: ${failure}`)
      this.lastSyncFailure = failure
    })
    this.pendingSync = sync
    return sync
  }

  async handle(message: RemindersMessage, reply: (message: ServerMessage) => void, ack: () => void): Promise<void> {
    const { source } = this.options
    if (source === undefined) {
      if (message.type === 'reminders_write') throw new Error('This Manor host has no Apple Reminders.')
      reply({
        type: 'reminders_state',
        status: 'unavailable',
        source: 'eventkit',
        notice: 'This Manor host has no Apple Reminders.',
        revision: 'none',
        today: amsterdamToday(Date.now()),
        groups: [],
        lists: [],
        reminders: [],
        completedCount: null,
      })
      return
    }
    switch (message.type) {
      case 'reminders_load':
        reply(await this.load(source))
        return
      case 'reminders_load_completed':
        reply(await this.serial(() => source.completedPage(message.offset)))
        return
      case 'reminders_write':
        // The fresh snapshot goes out before the answer, whether the write held or
        // not: a failed private step can leave a created reminder behind, and the
        // client drops its optimistic copy on the answer, so the truth must be there.
        // An ack therefore means that snapshot shows the write; one that never shows
        // is answered as a failure, so the client rolls back instead of hiding it.
        await this.serial(async () => {
          let written: { createdId?: string } | undefined
          let failure: unknown
          try {
            written = await source.write(message.action)
          } catch (error: unknown) {
            failure = error
          }
          let state = await source.load()
          const pause = this.options.pause ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
          // An unreadable snapshot is empty, which is not proof a reminder was completed or deleted.
          const shown = () => written !== undefined && state.status === 'ready' && reflects(state.reminders, message.action, written.createdId)
          for (let read = 1; written !== undefined && read < SETTLE_READS && !shown(); read += 1) {
            await pause(SETTLE_PAUSE_MS)
            state = await source.load()
          }
          this.options.broadcast(state)
          if (failure !== undefined) throw failure
          if (!shown()) throw new Error('Apple Reminders has not shown this change yet. It may still land; check again in a moment.')
        })
        ack()
        // A tick in the door reaches the ledger now rather than on the next poll.
        void this.syncOpenLoops()
        return
    }
  }
}
