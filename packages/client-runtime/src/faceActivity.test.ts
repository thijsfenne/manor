import type { ThreadEvent } from '@manor/contracts'
import { describe, expect, it } from 'vitest'
import { FACE_HOLD_MS, FACE_LOOK, FACE_MOMENT_MS, endFace, eyeAt, scanStops, seesawStops, settleFace, turnFace } from './faceActivity'
import { GESTURES } from './faceGesture'
import type { TurnRow } from './state'
import { emptyThread } from './threadState'
import { rowsOf } from './transcriptState'

const START = 1_786_500_000_000
let id = 0
const event = (partial: Partial<ThreadEvent> & { type: ThreadEvent['type'] }, at = START): ThreadEvent => ({ id: `evt_${(id += 1)}`, ts: at, ...partial }) as ThreadEvent
const live = (extra: object = {}) => [{ turnId: 't1', agentId: 'smith', messages: [], state: 'running' as const, startedAt: START, ...extra }]
const turnOf = (events: ThreadEvent[], liveTurns: ReturnType<typeof live> = []) =>
  rowsOf({ ...emptyThread, events, liveTurns, hasSnapshot: true }, 'dm').find((row): row is TurnRow => row.kind === 'turn')!
const sent = event({ type: 'user_message', text: 'Look into it', mentions: [] })
const call = (tool: string, toolCallId: string) => event({ type: 'tool_use', agentId: 'smith', turnId: 't1', toolCallId, tool })

describe('what a turn asks of its face', () => {
  it('thinks until something else is known, then follows the newest call', () => {
    expect(turnFace(turnOf([sent], live()))).toBe('thinking')
    expect(turnFace(turnOf([sent, call('Read', 'c1')], live()))).toBe('reading')
    // Everything without a look of its own keeps the busy loop.
    expect(turnFace(turnOf([sent, call('Read', 'c1'), call('Bash', 'c2')], live()))).toBe('working')
    // Reasoning after a call is thinking again.
    expect(turnFace(turnOf([sent, call('Bash', 'c1'), event({ type: 'reasoning', agentId: 'smith', turnId: 't1', text: 'So.' })], live()))).toBe('thinking')
  })

  it('types while text streams in, whatever it did before', () => {
    const turn = turnOf([sent, call('Read', 'c1')], live())
    expect(turnFace({ ...turn, live: { ...turn.live!, messages: [{ messageId: 'm1', text: 'Half' }] } })).toBe('typing')
  })

  it('waits on a colleague or on background work, and shows nothing once the turn is over', () => {
    const turn = turnOf([sent, call('Bash', 'c1')], live())
    expect(turnFace(turn, true)).toBe('waiting')
    expect(turnFace({ ...turn, live: { ...turn.live!, background: { agents: 1, commands: 0 } } })).toBe('waiting')
    const over = turnOf([sent, event({ type: 'agent_message', agentId: 'smith', turnId: 't1', messageId: 'm1', text: 'Done.' }), event({ type: 'turn_result', agentId: 'smith', turnId: 't1' })])
    expect(turnFace(over)).toBeUndefined()
  })

  it('needs the user only while the turn still runs', () => {
    const asking = { asks: [{ answers: undefined }] } as unknown as Partial<TurnRow>
    expect(turnFace({ ...turnOf([sent, call('Bash', 'c1')], live()), ...asking })).toBe('needs')
    // A turn that stopped with its question open is history: it would bounce on every scroll past.
    const over = turnOf([sent, event({ type: 'agent_message', agentId: 'smith', turnId: 't1', messageId: 'm1', text: 'Which one?' }), event({ type: 'turn_result', agentId: 'smith', turnId: 't1' })])
    expect(turnFace({ ...over, ...asking })).toBeUndefined()
  })

  it('marks an ended turn once: a nod for done, a shake for an error, nothing for a stop', () => {
    const done = turnOf([sent, event({ type: 'agent_message', agentId: 'smith', turnId: 't1', messageId: 'm1', text: 'Done.' }), event({ type: 'turn_result', agentId: 'smith', turnId: 't1' })])
    expect(endFace(done)).toBe('done')
    expect(endFace({ ...done, note: { kind: 'error' } as TurnRow['note'] })).toBe('failed')
    // The user stopped it. A sad face over their own call would answer back.
    expect(endFace({ ...done, note: { kind: 'aborted' } as TurnRow['note'] })).toBeUndefined()
  })
})

describe('how a face settles on a state', () => {
  const rest = { state: undefined, since: 0 }

  it('takes the first state at once and holds it before giving way to other work', () => {
    const first = settleFace(rest, 'thinking', 1_000)
    expect(first.shown).toEqual({ state: 'thinking', since: 1_000 })
    // A tool call of 200 ms cannot make the face twitch.
    const early = settleFace(first.shown, 'reading', 1_200)
    expect(early.shown.state).toBe('thinking')
    expect(early.again).toBe(FACE_HOLD_MS - 200)
    expect(settleFace(first.shown, 'reading', 1_000 + FACE_HOLD_MS).shown.state).toBe('reading')
  })

  it('lets a moment through at once, and takes the end of a turn off again', () => {
    const working = { state: 'working' as const, since: 1_000 }
    expect(settleFace(working, 'needs', 1_100).shown.state).toBe('needs')
    // The ending says when to look again; nothing else would ever take it off.
    expect(settleFace(working, 'done', 1_100).again).toBe(FACE_MOMENT_MS)
    expect(settleFace(working, 'needs', 1_100).again).toBeUndefined()
    const done = settleFace(working, 'done', 1_100).shown
    expect(done.state).toBe('done')
    expect(settleFace(done, 'done', 1_200).again).toBe(FACE_MOMENT_MS - 100)
    expect(settleFace(done, 'done', 1_100 + FACE_MOMENT_MS).shown.state).toBeUndefined()
    // New work does not wait for a smile to finish.
    expect(settleFace(done, 'thinking', 1_200).shown.state).toBe('thinking')
  })
})

describe('the looks and the added eye moves', () => {
  it('names only gestures that exist', () => {
    for (const look of Object.values(FACE_LOOK)) if (look.gesture) expect(GESTURES[look.gesture]).toBeDefined()
  })

  it('scans three lines evenly about the middle of the face, in step with the follow gesture', () => {
    const stops = scanStops(3)
    expect(stops.map((stop) => stop.x)).toEqual([-2.5, 8.5, -2.5, 8.5, -2.5, 8.5, -2.5])
    expect(new Set(stops.map((stop) => stop.y)).size).toBe(3)
    expect(stops.at(-1)).toMatchObject({ offset: 1, x: stops[0]!.x, y: stops[0]!.y })
    // The body dips where the eyes return: just past the end of each line.
    const dips = GESTURES.follow.fig.filter(([, key]) => 'y' in key).map(([offset]) => offset)
    const returns = stops.filter((stop, index) => index % 2 === 1).map((stop) => stop.offset)
    dips.forEach((dip, index) => expect(dip).toBeGreaterThan(returns[index]!))
  })

  it('trades the heights of the two eyes, and reads back where an eye is', () => {
    expect(seesawStops(-8.4, 1)[1]!.y).toBe(8.4)
    expect(seesawStops(-8.4, -1)[1]!.y).toBe(-8.4)
    expect(eyeAt(seesawStops(-8.4, 1), 0.25)).toEqual({ x: 0, y: 4.2 })
  })
})
