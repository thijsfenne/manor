import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_TURN_TIMEOUT_MS,
  TurnIdleGate,
  bindIdleClock,
  resolveTurnTimeouts,
  startTurnTimers,
  watchInFlightTools,
} from '../src/drivers/turnTimers.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('resolveTurnTimeouts', () => {
  it('defaults to a five minute silence and no overall cap', () => {
    expect(resolveTurnTimeouts({}, {})).toEqual({
      idleMs: DEFAULT_IDLE_TIMEOUT_MS,
      overallMs: DEFAULT_TURN_TIMEOUT_MS,
    })
    expect(DEFAULT_TURN_TIMEOUT_MS).toBe(0)
  })

  it('reads both clocks from the environment', () => {
    expect(
      resolveTurnTimeouts({}, { MANOR_TURN_IDLE_TIMEOUT_MS: '1000', MANOR_TURN_TIMEOUT_MS: '9000' }),
    ).toEqual({ idleMs: 1_000, overallMs: 9_000 })
  })

  it('treats an overall of zero as no cap, and still arms the idle clock', () => {
    expect(resolveTurnTimeouts({}, { MANOR_TURN_TIMEOUT_MS: '0' })).toEqual({
      idleMs: DEFAULT_IDLE_TIMEOUT_MS,
      overallMs: 0,
    })
  })

  it('ignores an unusable idle environment value rather than starting a turn with no clock', () => {
    expect(resolveTurnTimeouts({}, { MANOR_TURN_IDLE_TIMEOUT_MS: 'soon', MANOR_TURN_TIMEOUT_MS: 'nope' })).toEqual({
      idleMs: DEFAULT_IDLE_TIMEOUT_MS,
      overallMs: DEFAULT_TURN_TIMEOUT_MS,
    })
  })

  it('never lets the idle clock outlive a caller-pinned budget', () => {
    // Chat naming asks for 60s and means it, however generous the idle default is.
    expect(resolveTurnTimeouts({ timeoutMs: 60_000 }, {})).toEqual({ idleMs: 60_000, overallMs: 60_000 })
  })

  it('lets an explicit option outrank the environment', () => {
    expect(
      resolveTurnTimeouts({ idleTimeoutMs: 500, timeoutMs: 2_000 }, { MANOR_TURN_IDLE_TIMEOUT_MS: '99' }),
    ).toEqual({ idleMs: 500, overallMs: 2_000 })
  })
})

describe('startTurnTimers', () => {
  it('starts the idle clock over on every event, and blames the silence when it runs out', () => {
    vi.useFakeTimers()
    const expired: string[] = []
    const timers = startTurnTimers({ idleMs: 1_000, overallMs: 60_000 }, (message) => expired.push(message))

    // Ten minutes of work in one-second-shy beats: the old wall-clock cap would
    // have killed this turn, the idle clock never even fires.
    for (let beat = 0; beat < 12; beat += 1) {
      vi.advanceTimersByTime(900)
      timers.touch()
    }
    expect(expired).toEqual([])

    vi.advanceTimersByTime(1_000)
    expect(expired).toEqual(['the turn went quiet: no activity for 1s'])

    // One expiry per turn, whatever the other clock does afterwards.
    vi.advanceTimersByTime(120_000)
    expect(expired).toHaveLength(1)
  })

  it('never ends a busy turn when the overall clock is off', () => {
    vi.useFakeTimers()
    const expired: string[] = []
    const timers = startTurnTimers({ idleMs: 1_000, overallMs: 0 }, (message) => expired.push(message))

    for (let beat = 0; beat < 40; beat += 1) {
      vi.advanceTimersByTime(900)
      timers.touch()
    }
    expect(expired).toEqual([])
  })

  it('ends a turn that is busy forever, and says which clock ran out', () => {
    vi.useFakeTimers()
    const expired: string[] = []
    const timers = startTurnTimers({ idleMs: 1_000, overallMs: 5_000 }, (message) => expired.push(message))

    for (let beat = 0; beat < 10; beat += 1) {
      vi.advanceTimersByTime(600)
      timers.touch()
    }

    expect(expired).toEqual(['the turn did not finish within 5s'])
  })

  it('says nothing once the turn has been cleared', () => {
    vi.useFakeTimers()
    const expired: string[] = []
    const timers = startTurnTimers({ idleMs: 1_000, overallMs: 5_000 }, (message) => expired.push(message))

    timers.clear()
    vi.advanceTimersByTime(60_000)

    expect(expired).toEqual([])
  })

  it('arms nothing when a late event touches a cleared turn', () => {
    // A stdout chunk can land after the process closed, and the turn is over: the
    // dangling idle timer this used to arm fired a kill at nothing minutes later.
    vi.useFakeTimers()
    const expired: string[] = []
    const timers = startTurnTimers({ idleMs: 1_000, overallMs: 5_000 }, (message) => expired.push(message))

    timers.clear()
    timers.touch()
    vi.advanceTimersByTime(60_000)

    expect(expired).toEqual([])
  })

  it('does not expire while paused, then starts a fresh idle window on resume', () => {
    vi.useFakeTimers()
    const expired: string[] = []
    const timers = startTurnTimers({ idleMs: 1_000, overallMs: 0 }, (message) => expired.push(message))

    vi.advanceTimersByTime(400)
    timers.pause()
    vi.advanceTimersByTime(5_000)
    expect(expired).toEqual([])

    timers.resume()
    vi.advanceTimersByTime(999)
    expect(expired).toEqual([])
    vi.advanceTimersByTime(1)
    expect(expired).toEqual(['the turn went quiet: no activity for 1s'])
  })
})

describe('watchInFlightTools', () => {
  it('pauses idle while a named tool is open, then arms a fresh window when it closes', () => {
    vi.useFakeTimers()
    const expired: string[] = []
    const timers = startTurnTimers({ idleMs: 1_000, overallMs: 0 }, (message) => expired.push(message))
    const tools = watchInFlightTools(timers)

    tools.see({ type: 'tool_use', toolCallId: 'jira-1' })
    tools.see({ type: 'tool_use', toolCallId: 'vault-1' })
    vi.advanceTimersByTime(5_000)
    expect(expired).toEqual([])

    tools.see({ type: 'tool_result', toolCallId: 'jira-1' })
    vi.advanceTimersByTime(5_000)
    expect(expired).toEqual([])

    tools.see({ type: 'tool_result', toolCallId: 'vault-1' })
    vi.advanceTimersByTime(999)
    expect(expired).toEqual([])
    vi.advanceTimersByTime(1)
    expect(expired).toEqual(['the turn went quiet: no activity for 1s'])
  })

  it('ignores a tool_use without an id, because nothing can close it', () => {
    vi.useFakeTimers()
    const expired: string[] = []
    const timers = startTurnTimers({ idleMs: 1_000, overallMs: 0 }, (message) => expired.push(message))
    const tools = watchInFlightTools(timers)

    tools.see({ type: 'tool_use' })
    vi.advanceTimersByTime(1_000)
    expect(expired).toEqual(['the turn went quiet: no activity for 1s'])
  })
})

describe('TurnIdleGate', () => {
  it('pauses an attached clock while the matching turn is held', () => {
    vi.useFakeTimers()
    const expired: string[] = []
    const gate = new TurnIdleGate()
    const timers = startTurnTimers({ idleMs: 1_000, overallMs: 0 }, (message) => expired.push(message))
    const detach = gate.attach('chat_1', 'sage', timers)

    gate.hold('chat_1', 'sage')
    expect(gate.held('chat_1', 'sage')).toBe(true)
    expect(gate.held('chat_1', 'smith')).toBe(false)
    vi.advanceTimersByTime(5_000)
    expect(expired).toEqual([])

    gate.release('chat_1', 'sage')
    expect(gate.held('chat_1', 'sage')).toBe(false)
    vi.advanceTimersByTime(1_000)
    expect(expired).toEqual(['the turn went quiet: no activity for 1s'])
    detach()
  })

  it('pauses a clock that attaches after the hold already started', () => {
    vi.useFakeTimers()
    const expired: string[] = []
    const gate = new TurnIdleGate()
    gate.hold('chat_1', 'sage')
    const timers = startTurnTimers({ idleMs: 1_000, overallMs: 0 }, (message) => expired.push(message))
    gate.attach('chat_1', 'sage', timers)

    vi.advanceTimersByTime(5_000)
    expect(expired).toEqual([])
  })

  it('isolates two clocks and detaches on clear so a later release cannot resume a spent turn', () => {
    vi.useFakeTimers()
    const expired: string[] = []
    const gate = new TurnIdleGate()
    const sage = bindIdleClock(
      gate,
      'chat_1',
      'sage',
      startTurnTimers({ idleMs: 1_000, overallMs: 0 }, (message) => expired.push(`sage:${message}`)),
    )
    const smith = bindIdleClock(
      gate,
      'chat_1',
      'smith',
      startTurnTimers({ idleMs: 1_000, overallMs: 0 }, (message) => expired.push(`smith:${message}`)),
    )

    gate.hold('chat_1', 'sage')
    vi.advanceTimersByTime(1_000)
    expect(expired).toEqual(['smith:the turn went quiet: no activity for 1s'])

    sage.clear()
    gate.release('chat_1', 'sage')
    vi.advanceTimersByTime(5_000)
    expect(expired).toEqual(['smith:the turn went quiet: no activity for 1s'])

    const next = bindIdleClock(
      gate,
      'chat_1',
      'sage',
      startTurnTimers({ idleMs: 1_000, overallMs: 0 }, (message) => expired.push(`next:${message}`)),
    )
    vi.advanceTimersByTime(1_000)
    expect(expired).toEqual([
      'smith:the turn went quiet: no activity for 1s',
      'next:the turn went quiet: no activity for 1s',
    ])
    next.clear()
  })
})
