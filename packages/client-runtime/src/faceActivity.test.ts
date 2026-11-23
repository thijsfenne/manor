import type { ThreadEvent } from '@manor/contracts'
import { describe, expect, it } from 'vitest'
import { FACE_HOLD_MS, FACE_LOOK, FACE_MOMENT_MS, endFace, endedWell, eyeAt, settleFace, towardStops, turnFace, type FaceState } from './faceActivity'
import { GESTURES, type Gesture } from './faceGesture'
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
    expect(turnFace(turnOf([sent, call('Read', 'c1'), call('Bash', 'c2')], live()))).toBe('running')
    expect(turnFace(turnOf([sent, call('WebSearch', 'c1')], live()))).toBe('searching')
    expect(turnFace(turnOf([sent, call('Edit', 'c1')], live()))).toBe('editing')
    // A call of no known kind is plain work.
    expect(turnFace(turnOf([sent, call('mcp__mail__mail_draft', 'c1')], live()))).toBe('working')
    // Reasoning after a call is thinking again.
    expect(turnFace(turnOf([sent, call('Bash', 'c1'), event({ type: 'reasoning', agentId: 'smith', turnId: 't1', text: 'So.' })], live()))).toBe('thinking')
  })

  it('starts when the newest call failed, and carries on with the next', () => {
    const failed = event({ type: 'tool_result', agentId: 'smith', turnId: 't1', toolCallId: 'c1', outcome: 'error' })
    expect(turnFace(turnOf([sent, call('Bash', 'c1'), failed], live()))).toBe('snagged')
    expect(turnFace(turnOf([sent, call('Bash', 'c1'), failed, call('Read', 'c2')], live()))).toBe('reading')
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

  it('finds a DM turn that ended well, and nothing for one that broke or still runs', () => {
    const reply = event({ type: 'agent_message', agentId: 'smith', turnId: 't1', messageId: 'm1', text: 'Done.' })
    const result = event({ type: 'turn_result', agentId: 'smith', turnId: 't1' })
    const rows = rowsOf({ ...emptyThread, events: [sent, reply, result], liveTurns: [], hasSnapshot: true }, 'dm')
    expect(endedWell(rows, 't1')?.turnId).toBe('t1')
    expect(endedWell(rows, 't2')).toBeUndefined()
    const broke = rows.map((row) => (row.kind === 'turn' ? { ...row, note: { kind: 'error' } as TurnRow['note'] } : row))
    expect(endedWell(broke, 't1')).toBeUndefined()
    const running = rowsOf({ ...emptyThread, events: [sent, reply], liveTurns: live(), hasSnapshot: true }, 'dm')
    expect(endedWell(running, 't1')).toBeUndefined()
    // A reconnect that no longer finds the turn running drops it without a result: no nod over that.
    const vanished = rowsOf({ ...emptyThread, events: [sent, reply], liveTurns: [], hasSnapshot: true }, 'dm')
    expect(endedWell(vanished, 't1')).toBeUndefined()
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

describe('the looks and the added eye move', () => {
  it('names only gestures that exist, and plays every one of them somewhere', () => {
    for (const look of Object.values(FACE_LOOK)) if (look.gesture) expect(GESTURES[look.gesture]).toBeDefined()
    expect(new Set(Object.values(FACE_LOOK).flatMap((look) => look.gesture ?? []))).toEqual(new Set(Object.keys(GESTURES)))
  })

  it('counts only gestures that start and end at home, which the phone plays without a walk', () => {
    for (const look of Object.values(FACE_LOOK)) {
      if (look.gesture === undefined || look.passes === undefined) continue
      const gesture: Gesture = GESTURES[look.gesture]
      const ends = gesture.fig === undefined ? [] : [gesture.fig[0]!, gesture.fig.at(-1)!]
      for (const [, key] of ends) {
        expect(key.x ?? 0, look.gesture).toBe(0)
        expect(key.y ?? 0, look.gesture).toBe(0)
        expect(key.sx ?? 1, look.gesture).toBe(1)
        expect(key.sy ?? 1, look.gesture).toBe(1)
      }
      expect(gesture.rot?.[0]?.[1] ?? 0, look.gesture).toBe(0)
      expect((gesture.rot?.at(-1)?.[1] ?? 0) % 360, look.gesture).toBe(0)
    }
  })

  it('plays the working loop for every kind of work, the dots only while she writes', () => {
    const work: FaceState[] = ['working', 'thinking', 'reading', 'searching', 'editing', 'running', 'snagged', 'compacting']
    for (const state of work) expect(FACE_LOOK[state], state).toEqual({ eyes: 'loop' })
    expect(FACE_LOOK.typing).toEqual({ eyes: 'dots' })
    const others = (Object.keys(FACE_LOOK) as FaceState[]).filter((state) => !work.includes(state) && state !== 'typing')
    for (const state of others) expect(FACE_LOOK[state].eyes, state).not.toBe('loop')
  })

  it('turns the pair to the reader and holds it there, and reads back where an eye is', () => {
    expect(towardStops(3).map((stop) => [stop.x, stop.y])).toEqual([[3, 0], [3, 0]])
    expect(eyeAt([{ offset: 0, x: 0, y: 0, ease: 'linear' }, { offset: 1, x: 4, y: -8, ease: 'linear' }], 0.25)).toEqual({ x: 1, y: -2 })
  })
})
