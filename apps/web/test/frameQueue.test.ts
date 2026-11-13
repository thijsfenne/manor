import type { ServerMessage } from '@manor/contracts'
import { describe, expect, it } from 'vitest'
import { createFrameQueue, type FrameScheduler } from '@manor/client-runtime/frame-queue'
import {
  emptyWorkspace,
  openThread,
  reduce,
  selectChat,
  sendingUserMessage,
  threadOf,
  type WorkspaceState,
} from '../src/state'

/**
 * Delta coalescing. One `setWorkspace` per animation frame instead of one per socket
 * message, which is the difference between rendering the whole tree 40 to 80 times a
 * second per streaming persona and rendering it once per frame.
 *
 * The queue is only allowed to change *when* messages are applied. What ends up in
 * the transcript has to be identical to applying each one on arrival, so every case
 * below is about order, delivery and scope rather than speed.
 */

/** A hand-driven `requestAnimationFrame`: nothing runs until `runFrame` is called. */
const fakeFrames = () => {
  let next = 1
  const pending = new Map<number, () => void>()
  const scheduler: FrameScheduler = {
    request: (run) => {
      const handle = next++
      pending.set(handle, run)
      return handle
    },
    cancel: (handle) => void pending.delete(handle),
  }
  return {
    scheduler,
    scheduled: () => pending.size,
    runFrame: () => {
      const due = [...pending.values()]
      pending.clear()
      for (const run of due) run()
    },
  }
}

const delta = (chatId: string, text: string, messageId = 'm1'): ServerMessage => ({
  type: 'delta',
  chatId,
  turnId: 'turn_1',
  agentId: 'smith',
  messageId,
  text,
})

const snapshot = (chatId: string): ServerMessage => ({
  type: 'snapshot',
  chatId,
  events: [],
  usage: {},
})

const turnRunning = (chatId: string): ServerMessage => ({
  type: 'turn_state',
  chatId,
  turnId: 'turn_1',
  agentId: 'smith',
  state: 'running',
  startedAt: 1_786_500_000_000,
})

const turnDone = (chatId: string): ServerMessage => ({
  type: 'turn_state',
  chatId,
  turnId: 'turn_1',
  agentId: 'smith',
  state: 'done',
})

/**
 * The wiring `useWorkspace` has, without React: server messages go through the queue,
 * everything else flushes it first and then changes state itself.
 */
const wireUp = () => {
  const frames = fakeFrames()
  let state: WorkspaceState = { ...emptyWorkspace, hasDirectory: true }
  let renders = 0
  const queue = createFrameQueue<ServerMessage>(
    (batch) => {
      renders += 1
      state = batch.reduce((current, msg) => reduce(current, msg), state)
    },
    frames.scheduler,
    // The same rule `useWorkspace` passes.
    (msg) => msg.type === 'turn_state' && msg.state !== 'running',
  )
  return {
    frames,
    queue,
    renders: () => renders,
    state: () => state,
    /** A user action: anything that is not a server message. */
    act: (change: (current: WorkspaceState) => WorkspaceState) => {
      queue.flush()
      state = change(state)
    },
  }
}

/** The streaming text of the open chat's only live message. */
const liveText = (state: WorkspaceState): string =>
  openThread(state).liveTurns[0]?.messages.map((message) => message.text).join('') ?? ''

describe('delta coalescing', () => {
  it('applies a frame of deltas in arrival order, in one update', () => {
    const app = wireUp()
    app.queue.push(snapshot('chat_a'))
    app.frames.runFrame()

    app.queue.push(turnRunning('chat_a'))
    for (const text of ['Ik ', 'kijk ', 'even.']) app.queue.push(delta('chat_a', text))
    expect(app.renders()).toBe(1)

    app.frames.runFrame()

    expect(liveText(app.state())).toBe('Ik kijk even.')
    expect(app.renders()).toBe(2)
  })

  it('keeps a terminal state behind the deltas of its own frame, and never drops it', () => {
    const ended = wireUp()
    ended.queue.push(snapshot('chat_a'))
    ended.frames.runFrame()

    ended.queue.push(turnRunning('chat_a'))
    ended.queue.push(delta('chat_a', 'Klaar.'))
    ended.queue.push(turnDone('chat_a'))
    ended.frames.runFrame()

    // Both halves matter. The turn is over, and the words it ended with are still
    // in it: a terminal state that overtook the last delta would drop them.
    const finished = threadOf(ended.state(), 'chat_a').liveTurns[0]
    expect(finished?.state).toBe('done')
    expect(finished?.messages.map((message) => message.text)).toEqual(['Klaar.'])
    expect(ended.state().activity['chat_a']?.runningTurns).toEqual([])

    // The same batch, with the socket going away before the frame runs.
    const unmounted = wireUp()
    unmounted.queue.push(snapshot('chat_a'))
    unmounted.frames.runFrame()

    unmounted.queue.push(turnRunning('chat_a'))
    unmounted.queue.push(delta('chat_a', 'Klaar.'))
    unmounted.queue.push(turnDone('chat_a'))
    unmounted.queue.flush()

    const closed = threadOf(unmounted.state(), 'chat_a').liveTurns[0]
    expect(closed?.state).toBe('done')
    expect(closed?.messages.map((message) => message.text)).toEqual(['Klaar.'])
    expect(unmounted.state().activity['chat_a']?.runningTurns).toEqual([])
    expect(unmounted.frames.scheduled()).toBe(0)
  })

  it('does not let a queued snapshot wipe the message you just sent', () => {
    // The ordering case with teeth, and the reason the flush exists rather than plain
    // coalescing: a snapshot is the whole truth for one chat and clears `pending`, so
    // one that lands after an optimistic send takes the user's own bubble with it.
    const app = wireUp()
    app.queue.push(snapshot('chat_a'))
    app.frames.runFrame()

    // The snapshot is already waiting when the send happens.
    app.queue.push(snapshot('chat_a'))
    app.act((current) => sendingUserMessage(current, 'chat_a', 'Nog een vraag.'))
    app.frames.runFrame()

    expect(threadOf(app.state(), 'chat_a').pending.map((message) => message.text)).toEqual([
      'Nog een vraag.',
    ])
  })

  it('keeps a buffered chat in its own thread across a switch', () => {
    const app = wireUp()
    app.queue.push(snapshot('chat_a'))
    app.frames.runFrame()
    expect(app.state().openChatId).toBe('chat_a')

    // Chat B is picked while B's snapshot and A's last deltas are both in flight.
    app.queue.push(turnRunning('chat_a'))
    app.queue.push(delta('chat_a', 'Nog bezig in A.'))
    app.act((current) => selectChat(current, 'chat_b'))
    app.queue.push(snapshot('chat_b'))
    app.frames.runFrame()

    // Scope, not ordering: A's text went to A's thread and nothing of it is on the
    // stage. The ordering that the flush actually decides is the test above.
    expect(app.state().openChatId).toBe('chat_b')
    expect(app.state().pendingChatId).toBeNull()
    expect(threadOf(app.state(), 'chat_a').liveTurns[0]?.messages.map((m) => m.text)).toEqual([
      'Nog bezig in A.',
    ])
    expect(liveText(app.state())).toBe('')
  })

  it('goes on working after a flush, because React runs that cleanup at mount', () => {
    // StrictMode invokes an effect's cleanup once at mount and then re-runs the setup
    // without re-rendering, so anything held in a ref survives it. A queue that could
    // be shut for good would be shut right there and swallow every server message for
    // the rest of the session; the dev app would simply never load.
    const app = wireUp()
    app.queue.push(snapshot('chat_a'))
    app.queue.flush()

    app.queue.push(turnRunning('chat_a'))
    app.queue.push(delta('chat_a', 'Nog steeds hier.'))
    app.frames.runFrame()

    expect(liveText(app.state())).toBe('Nog steeds hier.')
  })

  it('stops waiting for a clock that is not running, so a hidden tab cannot pile up', () => {
    // `requestAnimationFrame` does not fire in a hidden tab. Without a cap the buffer
    // grows for as long as the tab is away, where the old code folded every delta into
    // a string on arrival.
    const app = wireUp()
    app.queue.push(snapshot('chat_a'))
    app.frames.runFrame()
    app.queue.push(turnRunning('chat_a'))

    // No frame ever runs from here on: the only thing that can apply these is the cap.
    for (let index = 0; index < 600; index += 1) app.queue.push(delta('chat_a', 'x'))

    expect(app.renders()).toBeGreaterThan(1)
    expect(liveText(app.state())).toContain('xxx')
  })

  it('applies the end of a run without waiting for a frame that may never come', () => {
    // The bug this exists for. Chromium suspends `requestAnimationFrame` for an
    // occluded window, which is precisely the situation a done notice is for: Manor
    // behind a full-screen editor while a persona works. The 512-message cap cannot
    // save this — it needs five hundred *more* messages to trip and the terminal
    // state is the last one there is — so a quiet routine finishing in the background
    // sat in this array until something else happened to arrive, by which time the user
    // was looking at the window and the host dropped the banner as redundant.
    const app = wireUp()
    app.queue.push(snapshot('chat_a'))
    app.frames.runFrame()
    app.queue.push(turnRunning('chat_a'))
    app.queue.push(delta('chat_a', 'Klaar.'))
    const before = app.renders()

    // No frame runs from here on, and no cap is anywhere near.
    app.queue.push(turnDone('chat_a'))

    expect(app.renders()).toBe(before + 1)
    expect(app.state().activity['chat_a']?.runningTurns).toEqual([])
    // The deltas ahead of it went in the same flush, in order: urgency moves the
    // whole queue forward, it does not let one message overtake.
    expect(threadOf(app.state(), 'chat_a').liveTurns[0]?.messages.map((m) => m.text)).toEqual([
      'Klaar.',
    ])
    expect(app.frames.scheduled()).toBe(0)
  })

  it('still batches the deltas themselves, which is the whole reason for the queue', () => {
    const app = wireUp()
    app.queue.push(snapshot('chat_a'))
    app.frames.runFrame()
    const before = app.renders()

    app.queue.push(turnRunning('chat_a'))
    for (const text of ['Ik ', 'kijk ', 'even.']) app.queue.push(delta('chat_a', text))

    // A start is not urgent: nothing is waiting on it, and making it so would cost a
    // render per turn for no one's benefit.
    expect(app.renders()).toBe(before)
  })

  it('flushes what the socket said before an action, so the action lands after it', () => {
    const app = wireUp()
    app.queue.push(snapshot('chat_a'))
    app.frames.runFrame()

    // Without the flush inside `act`, this snapshot would be reduced *after* the
    // selection and would reopen chat A over the top of it.
    app.queue.push(snapshot('chat_a'))
    app.act((current) => selectChat(current, 'chat_b'))

    expect(app.renders()).toBe(2)
    expect(app.state().pendingChatId).toBe('chat_b')
    expect(app.frames.scheduled()).toBe(0)
  })
})
