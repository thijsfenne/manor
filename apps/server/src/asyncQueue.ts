/**
 * Unread items at which a throttled producer is paused. A provider can print faster
 * than a turn persists its events; past this mark the CLI's stdout stops being read,
 * the OS pipe fills, and the CLI itself blocks on write until the consumer catches up.
 * Pausing lands between stdout chunks, so the buffer may overshoot by one chunk's lines.
 */
export const QUEUE_HIGH_WATER = 256

/** Unread items at which a paused producer is resumed. */
export const QUEUE_LOW_WATER = 64

/** The part of a readable stream `throttle` drives; a CLI child's stdout fits. */
export interface PausableSource {
  pause(): unknown
  resume(): unknown
}

/**
 * One-producer/one-consumer queue. A driver pushes runtime events in while the
 * orchestrator iterates them out; iteration ends once `close()` has been called
 * and every buffered item has been handed over. Nothing pushed before `close()` is
 * ever dropped: memory is bounded by pausing the producer, not by discarding events.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly buffered: T[] = []
  private readonly waiting: ((result: IteratorResult<T, undefined>) => void)[] = []
  private closed = false
  private full = false
  private reserved = 0
  private pressure: ((full: boolean) => void) | undefined

  constructor(
    private readonly highWater = QUEUE_HIGH_WATER,
    private readonly lowWater = QUEUE_LOW_WATER,
  ) {}

  /**
   * Called with true once `highWater` items wait unread, and with false once they
   * drain to `lowWater`, the queue closes, or its consumer walks away.
   */
  onPressure(listener: (full: boolean) => void): void {
    this.pressure = listener
  }

  /** Pauses `source` while this queue is full. Drivers pass their child's stdout. */
  throttle(source: PausableSource | null | undefined): void {
    if (source == null) return
    this.onPressure((full) => {
      if (full) source.pause()
      else source.resume()
    })
  }

  /**
   * Counts one item the producer has taken in but not pushed yet, until the returned
   * release runs. A driver that parses asynchronously (Codex awaits rollout reads per
   * line) reserves each raw line, so a slow parser pauses stdout the same way a slow
   * consumer does, instead of piling lines up in front of the queue.
   */
  reserve(): () => void {
    this.reserved += 1
    this.updatePressure()
    let released = false
    return () => {
      if (released) return
      released = true
      this.reserved -= 1
      this.updatePressure()
    }
  }

  push(item: T): void {
    if (this.closed) return
    const waiter = this.waiting.shift()
    if (waiter) {
      waiter({ value: item, done: false })
      return
    }
    this.buffered.push(item)
    this.updatePressure()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const waiter of this.waiting.splice(0)) waiter({ value: undefined, done: true })
    // A stopped CLI must be able to drain its pipe and exit.
    if (this.full) this.signal(false)
  }

  private updatePressure(): void {
    if (this.closed) return
    const unread = this.buffered.length + this.reserved
    if (!this.full && unread >= this.highWater) this.signal(true)
    else if (this.full && unread <= this.lowWater) this.signal(false)
  }

  private signal(full: boolean): void {
    this.full = full
    this.pressure?.(full)
  }

  [Symbol.asyncIterator](): AsyncIterator<T, undefined> {
    return {
      next: () => {
        const buffered = this.buffered.shift()
        if (buffered !== undefined) {
          this.updatePressure()
          return Promise.resolve({ value: buffered, done: false })
        }
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => {
          this.waiting.push(resolve)
        })
      },
      // A consumer that leaves early (break, return, throw) reads nothing more, so a
      // paused producer must not stay paused on its behalf.
      return: () => {
        this.buffered.length = 0
        this.close()
        return Promise.resolve({ value: undefined, done: true })
      },
    }
  }
}
