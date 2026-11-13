/** `requestAnimationFrame` and its cancel, injected so tests can drive the clock. */
export interface FrameScheduler {
  request: (run: () => void) => number
  cancel: (handle: number) => void
}

export type Urgent<T> = (item: T) => boolean

const MAX_WAITING = 512

export interface FrameQueue<T> {
  push: (item: T) => void
  flush: () => void
}

/**
 * Applies incoming transport messages at most once per visible frame while
 * preserving their exact arrival order. A capped backlog and urgent escape hatch
 * keep the queue safe when a platform suspends its animation clock.
 */
export function createFrameQueue<T>(
  apply: (items: T[]) => void,
  scheduler: FrameScheduler,
  urgent: Urgent<T> = () => false,
): FrameQueue<T> {
  let waiting: T[] = []
  let frame: number | null = null

  const flush = () => {
    if (frame !== null) {
      scheduler.cancel(frame)
      frame = null
    }
    if (waiting.length === 0) return
    const batch = waiting
    waiting = []
    apply(batch)
  }

  return {
    push: (item) => {
      waiting.push(item)
      if (waiting.length >= MAX_WAITING || urgent(item)) {
        flush()
        return
      }
      if (frame === null) frame = scheduler.request(flush)
    },
    flush,
  }
}

export const animationFrames: FrameScheduler = {
  request: (run) => requestAnimationFrame(run),
  cancel: (handle) => cancelAnimationFrame(handle),
}
