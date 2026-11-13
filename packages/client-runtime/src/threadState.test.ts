import { describe, expect, it } from 'vitest'
import type { ThreadEvent } from '@manor/contracts'
import { rowHasQuoteSource, rowsOf } from './transcriptState'
import { emptyThread, reduceThread } from './threadState'

describe('live turn replacement', () => {
  it('keeps a running turn’s live context, and ignores one for a turn already settled', () => {
    let state = reduceThread(emptyThread, {
      type: 'turn_state', chatId: 'work', turnId: 'turn_a', agentId: 'single', state: 'running', startedAt: 10,
    }, 10)
    const context = { contextTokens: 120_000, compacting: true }
    state = reduceThread(state, { type: 'turn_context', chatId: 'work', turnId: 'turn_a', agentId: 'single', context }, 11)
    expect(state.liveTurns[0]?.context).toEqual(context)
    const unknown = reduceThread(state, { type: 'turn_context', chatId: 'work', turnId: 'turn_b', agentId: 'single', context }, 12)
    expect(unknown).toBe(state)
    state = reduceThread(state, { type: 'event', chatId: 'work', event: { id: 'r', ts: 13, type: 'turn_result', turnId: 'turn_a', agentId: 'single' } }, 13)
    expect(state.liveTurns).toEqual([])
  })

  it('suffixes only a reused legacy turn id for the same persona', () => {
    const events: ThreadEvent[] = [
      { id: 'a1', ts: 1, type: 'turn_result', turnId: 'reused', agentId: 'sage' },
      { id: 'b1', ts: 2, type: 'turn_result', turnId: 'reused', agentId: 'smith' },
      { id: 'a2', ts: 3, type: 'turn_result', turnId: 'reused', agentId: 'sage' },
    ]
    expect(rowsOf({ ...emptyThread, events }).filter((row) => row.kind === 'turn').map((row) => row.key)).toEqual([
      'turn:reused:sage', 'turn:reused:smith', 'turn:reused:sage:2',
    ])
  })

  it('keeps concurrent persona keys and start order when the later turn records a tool call', () => {
    let state = reduceThread(emptyThread, {
      type: 'turn_state', chatId: 'work', turnId: 'turn_a', agentId: 'sage', state: 'running', startedAt: 10,
    }, 10)
    state = reduceThread(state, {
      type: 'delta', chatId: 'work', turnId: 'turn_a', agentId: 'sage', messageId: 'a1', text: 'Working',
    }, 11)
    state = reduceThread(state, {
      type: 'turn_state', chatId: 'work', turnId: 'turn_b', agentId: 'smith', state: 'running', startedAt: 20,
    }, 20)
    const before = rowsOf(state).filter((row) => row.kind === 'turn')
    state = reduceThread(state, {
      type: 'event', chatId: 'work', event: {
        id: 'tool_b', ts: 21, type: 'tool_use', turnId: 'turn_b', agentId: 'smith', toolCallId: 'call_b', tool: 'Bash',
      },
    }, 21)
    const after = rowsOf(state).filter((row) => row.kind === 'turn')
    expect(after.map((row) => [row.agentId, row.key])).toEqual(before.map((row) => [row.agentId, row.key]))
    expect(after.map((row) => row.agentId)).toEqual(['sage', 'smith'])
  })

  it('reconciles durable waiting-message status without adding a second bubble', () => {
    const event: ThreadEvent = { type: 'user_message', id: 'accepted', ts: 1, text: 'Do this next', mentions: [], dispatchState: 'pending' }
    let state = reduceThread(emptyThread, { type: 'event', chatId: 'chat', event }, 1)
    state = reduceThread(state, { type: 'event', chatId: 'chat', event: { ...event, dispatchState: 'started' } }, 2)
    state = reduceThread(state, { type: 'event', chatId: 'chat', event: { ...event, dispatchState: 'completed' } }, 3)
    expect(state.events).toEqual([{ ...event, dispatchState: 'completed' }])
  })
  it('takes the daily-log writer lines on a turn that already finished', () => {
    const result: ThreadEvent = { type: 'turn_result', id: 'result', ts: 1, turnId: 'turn_1', agentId: 'smith' }
    const memoryChanges = [{ path: '/Notes/memory/daily/2026-09-28.md', lines: [{ kind: 'added' as const, text: '- [m/smith] Line.' }] }]
    let state = reduceThread(emptyThread, { type: 'event', chatId: 'chat', event: result }, 1)
    state = reduceThread(state, { type: 'event', chatId: 'chat', event: { ...result, memoryChanges } }, 2)
    expect(state.events).toEqual([{ ...result, memoryChanges }])
  })
  it('drops unfinished provider text while keeping the same running turn', () => {
    const running = reduceThread(emptyThread, {
      type: 'turn_state',
      chatId: 'dm_1',
      turnId: 'turn_1',
      agentId: 'sage',
      state: 'running',
      startedAt: 10,
    }, 10)
    const streaming = reduceThread(running, {
      type: 'delta',
      chatId: 'dm_1',
      turnId: 'turn_1',
      agentId: 'sage',
      messageId: 'attempt_1:message_1',
      text: 'Old partial answer',
    }, 20)

    const replaced = reduceThread(streaming, {
      type: 'turn_state',
      chatId: 'dm_1',
      turnId: 'turn_1',
      agentId: 'sage',
      state: 'running',
      startedAt: 10,
      reset: true,
    }, 30)

    expect(replaced.liveTurns).toEqual([
      expect.objectContaining({ turnId: 'turn_1', state: 'running', startedAt: 10, messages: [] }),
    ])
  })

  it('keeps steering messages together above the work they redirected in a DM', () => {
    const events: ThreadEvent[] = [
      { id: 'user_1', ts: 1, type: 'user_message', text: 'First', mentions: [] },
      { id: 'reasoning_1', ts: 2, type: 'reasoning', turnId: 'turn_1', agentId: 'sage', text: 'Old plan' },
      {
        id: 'user_2',
        ts: 3,
        type: 'user_message',
        text: 'Second',
        mentions: [],
        steersTurnId: 'turn_1',
      },
    ]
    const rows = rowsOf({
      ...emptyThread,
      events,
      liveTurns: [{
        turnId: 'turn_1',
        agentId: 'sage',
        messages: [],
        state: 'running',
        startedAt: 2,
      }],
    }, 'dm')

    expect(rows.map((row) =>
      row.kind === 'event' && row.event.type === 'user_message' ? row.event.text : row.kind,
    )).toEqual([
      'First',
      'Second',
      'turn',
    ])
  })

  it('keeps an optimistic DM send under Working until the server decides whether it steers', () => {
    const rows = rowsOf({
      ...emptyThread,
      events: [
        { id: 'user_1', ts: 1, type: 'user_message', text: 'First', mentions: [] },
        { id: 'reasoning_1', ts: 2, type: 'reasoning', turnId: 'turn_1', agentId: 'sage', text: 'Old plan' },
      ],
      liveTurns: [{
        turnId: 'turn_1',
        agentId: 'sage',
        messages: [],
        state: 'running',
        startedAt: 2,
      }],
      pending: [{
        key: 'pending_1',
        text: 'Second',
        images: [],
        files: [],
        pageContexts: [],
      }],
    }, 'dm')

    expect(rows.map((row) => {
      if (row.kind === 'event' && row.event.type === 'user_message') return row.event.text
      if (row.kind === 'pending') return row.text
      return row.kind
    })).toEqual(['First', 'turn', 'Second'])
  })

  it('draws a message saved during an answer under that answer, while waiting and after it runs', () => {
    const labels = (rows: ReturnType<typeof rowsOf>) => rows.map((row) =>
      row.kind === 'event' && row.event.type === 'user_message' ? row.event.text
        : row.kind === 'turn' ? row.turnId : row.kind)
    const first: ThreadEvent = { id: 'user_1', ts: 1, type: 'user_message', text: 'First', mentions: [], dispatchState: 'started' }
    const later: ThreadEvent = { id: 'user_2', ts: 2, type: 'user_message', text: 'Later', mentions: [], dispatchState: 'pending' }
    const answered: ThreadEvent[] = [
      first,
      later,
      { id: 'answer_1', ts: 3, type: 'agent_message', turnId: 'turn_1', agentId: 'sage', text: 'First answer' },
    ]
    const live = { turnId: 'turn_1', agentId: 'sage', messages: [], state: 'running' as const, startedAt: 1 }
    expect(labels(rowsOf({ ...emptyThread, events: [first, later], liveTurns: [live] }, 'dm')))
      .toEqual(['First', 'turn_1', 'Later'])
    expect(labels(rowsOf({ ...emptyThread, events: answered, liveTurns: [live] }, 'dm')))
      .toEqual(['First', 'turn_1', 'Later'])

    const claimed = { ...later, dispatchState: 'started' as const, queuedAfter: 'result_1' }
    let state = reduceThread({ ...emptyThread, events: answered }, {
      type: 'event', chatId: 'dm', event: { id: 'result_1', ts: 4, type: 'turn_result', turnId: 'turn_1', agentId: 'sage' },
    }, 4)
    state = reduceThread(state, { type: 'event', chatId: 'dm', event: claimed }, 5)
    state = reduceThread(state, {
      type: 'event', chatId: 'dm', event: { id: 'answer_2', ts: 6, type: 'agent_message', turnId: 'turn_2', agentId: 'sage', text: 'Later answer' },
    }, 6)
    expect(state.events.map((event) => event.id)).toEqual(['user_1', 'user_2', 'answer_1', 'result_1', 'answer_2'])
    expect(labels(rowsOf(state, 'dm'))).toEqual(['First', 'turn_1', 'Later', 'turn_2'])
  })
})

describe('durable history during streaming', () => {
  const delta = { type: 'delta', chatId: 'dm', turnId: 'turn', agentId: 'sage', messageId: 'm1', text: 'late' } as const
  const base = { id: 'event', ts: 1, turnId: 'turn', agentId: 'sage' }

  it.each<ThreadEvent>([
    { ...base, type: 'turn_result' },
    { ...base, type: 'system_note', kind: 'aborted', text: 'Stopped' },
    { ...base, type: 'system_note', kind: 'error', text: 'Failed' },
    { ...base, type: 'agent_message', text: 'Legacy reply' },
  ])('does not revive a completed turn after $type', (event) => {
    const thread = { ...emptyThread, events: [event] }
    expect(reduceThread(thread, delta, 2)).toBe(thread)
  })

  it('blocks only the landed message and refreshes its index when history changes', () => {
    const event: ThreadEvent = { ...base, type: 'agent_message', messageId: 'm1', text: 'Landed' }
    const thread = { ...emptyThread, events: [event] }
    expect(reduceThread(thread, delta, 2)).toBe(thread)
    const streaming = reduceThread(thread, { ...delta, messageId: 'm2' }, 3)
    expect(streaming.liveTurns[0]?.messages).toEqual([{ messageId: 'm2', text: 'late' }])
    const landed = reduceThread(streaming, { type: 'event', chatId: 'dm', event: { ...event, id: 'second', messageId: 'm2' } }, 4)
    expect(reduceThread(landed, { ...delta, messageId: 'm2' }, 5)).toBe(landed)
    const snapshot = { ...landed, events: [] }
    expect(reduceThread(snapshot, delta, 6).liveTurns[0]?.messages).toContainEqual({ messageId: 'm1', text: 'late' })
  })

  it('settles a live system note in place when the same id arrives again', () => {
    const note: ThreadEvent = { id: 'compact', ts: 1, type: 'system_note', kind: 'info', text: 'Compacting the live session…' }
    const started = reduceThread(emptyThread, { type: 'event', chatId: 'work', event: note }, 1)
    const settled = reduceThread(started, {
      type: 'event',
      chatId: 'work',
      event: { ...note, text: 'Compacted the live session.' },
    }, 2)
    expect(settled.events).toEqual([{ ...note, text: 'Compacted the live session.' }])
  })

  it('keeps informational notes and other turns from blocking a live message', () => {
    const events: ThreadEvent[] = [
      { ...base, type: 'system_note', kind: 'info', text: 'Context renewed' },
      { ...base, type: 'agent_message', turnId: 'other', messageId: 'm1', text: 'Other reply' },
    ]
    expect(reduceThread({ ...emptyThread, events }, delta, 2).liveTurns[0]?.messages).toEqual([{ messageId: 'm1', text: 'late' }])
  })
})

type Turn = Extract<ReturnType<typeof rowsOf>[number], { kind: 'turn' }>
const turnOf = (rows: ReturnType<typeof rowsOf>): Turn => rows.find((row): row is Turn => row.kind === 'turn')!
const outerUsers = (rows: ReturnType<typeof rowsOf>) =>
  rows.flatMap((row) => row.kind === 'event' && row.event.type === 'user_message' ? [row.event.text] : [])
const shape = (turn: Turn) => turn.segments.map((segment) =>
  segment.kind === 'reply' ? `reply:${segment.text}`
    : segment.kind === 'user' ? `user:${segment.row.event.type === 'user_message' ? segment.row.event.text : ''}`
      : segment.kind === 'work' ? `work:${segment.steps.map((step) => step.kind).join('+')}`
        : segment.kind)
const first: ThreadEvent = { id: 'user_1', ts: 1, type: 'user_message', text: 'First', mentions: [] }
const steer = (id: string, ts: number, text: string, after?: { messageId: string; textOffset: number }): ThreadEvent =>
  ({ id, ts, type: 'user_message', text, mentions: [], steersTurnId: 'turn_1', ...(after === undefined ? {} : { steerAfter: after }) }) as ThreadEvent
const agent = { turnId: 'turn_1', agentId: 'sage' }
const say = (id: string, ts: number, text: string): ThreadEvent =>
  ({ id, ts, type: 'agent_message', ...agent, messageId: id, text })
const tool = (id: string, ts: number): ThreadEvent => ({ id, ts, type: 'tool_use', ...agent, toolCallId: id, tool: 'Bash' })
const result: ThreadEvent = { id: 'result', ts: 20, type: 'turn_result', ...agent }
const running = (messages: { messageId: string; text: string }[] = []) =>
  [{ ...agent, messages, state: 'running' as const, startedAt: 2 }]

describe('steers inside a Work turn', () => {
  it('reads reasoning, steer, tool, second steer and result as one chronological turn', () => {
    const events: ThreadEvent[] = [
      first,
      { id: 'reasoning_1', ts: 2, type: 'reasoning', ...agent, text: 'Plan' },
      steer('user_2', 3, 'Actually A'),
      tool('tool_1', 4),
      steer('user_3', 5, 'And B'),
      say('m1', 6, 'Done'),
      result,
    ]
    const rows = rowsOf({ ...emptyThread, events })
    const turn = turnOf(rows)
    expect(rows.map((row) => row.kind)).toEqual(['event', 'turn'])
    expect(outerUsers(rows)).toEqual(['First'])
    expect(turn.timeline.map((item) => item.kind)).toEqual(['reasoning', 'user', 'tool', 'user', 'say'])
    expect(shape(turn)).toEqual(['work:reasoning', 'user:Actually A', 'work:tool'])
    expect(turn.tail.map((segment) => segment.kind)).toEqual(['user', 'reply'])
    expect(turn.answer.map((reply) => reply.text)).toEqual(['Done'])
    expect(turn.startedAt).toBe(2)
    expect(turn.endedAt).toBe(20)
  })

  it('keeps an inline steer between two edits and between two replies instead of merging them', () => {
    const edit = (id: string, ts: number): ThreadEvent => ({
      id, ts, type: 'tool_use', ...agent, toolCallId: id, tool: 'Edit',
      edits: [{ path: `${id}.ts`, kind: 'update' }],
    } as ThreadEvent)
    const events: ThreadEvent[] = [
      first, say('m1', 2, 'One'), steer('user_2', 3, 'Wait'), say('m2', 4, 'Two'),
      edit('e1', 5), steer('user_3', 6, 'Hold on'), edit('e2', 7),
    ]
    const turn = turnOf(rowsOf({ ...emptyThread, events }))
    expect(shape(turn)).toEqual(['reply:One', 'user:Wait', 'reply:Two', 'edits', 'user:Hold on', 'edits'])
  })

  it('opens the turn at a steer sent before any activity, and the live turn takes it over', () => {
    const rows = rowsOf({ ...emptyThread, events: [first, steer('user_2', 3, 'Early')], liveTurns: running() })
    expect(outerUsers(rows)).toEqual(['First'])
    expect(rows.map((row) => row.kind)).toEqual(['event', 'turn'])
    expect(shape(turnOf(rows))).toEqual(['user:Early'])
    expect(turnOf(rows).startedAt).toBe(2)

    const later = rowsOf({
      ...emptyThread, events: [first, steer('user_2', 3, 'Early'), { id: 'r', ts: 4, type: 'reasoning', ...agent, text: 'Hm' }],
      liveTurns: running(),
    })
    expect(later.map((row) => row.kind)).toEqual(['event', 'turn'])
    expect(shape(turnOf(later))).toEqual(['user:Early', 'work:reasoning'])
    expect(turnOf(later).startedAt).toBe(3)
  })

  it('leaves a steer for a turn that never appears where it was saved', () => {
    const rows = rowsOf({ ...emptyThread, events: [first, steer('user_2', 3, 'Lost')] })
    expect(outerUsers(rows)).toEqual(['First', 'Lost'])
  })

  it('splits a streaming partial around a steer as the text grows', () => {
    const events: ThreadEvent[] = [first, steer('user_2', 3, 'Wait', { messageId: 'm1', textOffset: 5 })]
    const at = (text: string) => shape(turnOf(rowsOf({ ...emptyThread, events, liveTurns: running([{ messageId: 'm1', text }]) })))
    expect(at('Hello')).toEqual(['reply:Hello', 'user:Wait'])
    expect(at('Hello world')).toEqual(['reply:Hello', 'user:Wait', 'reply: world'])
    const turn = turnOf(rowsOf({ ...emptyThread, events, liveTurns: running([{ messageId: 'm1', text: 'Hello world' }]) }))
    expect(turn.segments.filter((segment) => segment.kind === 'reply').every((segment) => segment.live === true)).toBe(true)
  })

  it('does not project streamed text for a turn without a steer, or anywhere in a DM', () => {
    const live = running([{ messageId: 'm1', text: 'Streaming' }])
    expect(turnOf(rowsOf({ ...emptyThread, events: [first, tool('t', 3)], liveTurns: live })).segments.map((s) => s.kind)).toEqual(['work'])
    const dm = rowsOf({ ...emptyThread, events: [first, steer('user_2', 3, 'Wait', { messageId: 'm1', textOffset: 3 })], liveTurns: live }, 'dm')
    expect(turnOf(dm).segments).toEqual([])
    expect(outerUsers(dm)).toEqual(['First', 'Wait'])
  })

  it('places a steer at its exact offset once the message is durable, with no text lost or repeated', () => {
    const events: ThreadEvent[] = [
      first,
      steer('user_2', 3, 'Wait', { messageId: 'm1', textOffset: 5 }),
      { id: 'm1', ts: 4, type: 'agent_message', ...agent, messageId: 'm1', text: 'Hello world', images: [{ name: 'a.png', src: '/a.png' }] } as ThreadEvent,
    ]
    const turn = turnOf(rowsOf({ ...emptyThread, events, liveTurns: running() }))
    expect(shape(turn)).toEqual(['reply:Hello', 'user:Wait', 'reply: world'])
    const replies = turn.segments.filter((segment) => segment.kind === 'reply')
    expect(replies.map((reply) => reply.text).join('')).toBe('Hello world')
    expect(replies.map((reply) => reply.images.length)).toEqual([0, 1])
    expect(replies.every((reply) => reply.live !== true)).toBe(true)
    expect(replies.map((reply) => reply.quoteSources)).toEqual([
      [{ eventId: 'm1', text: 'Hello' }], [{ eventId: 'm1', text: ' world' }],
    ])
  })

  it('keeps later tool activity after the addition while its interrupted message finishes', () => {
    const events: ThreadEvent[] = [first,
      steer('user_2', 3, 'Wait', { messageId: 'm1', textOffset: 5 }),
      tool('t1', 4), say('m1', 5, 'Hello world'), result,
    ]
    const turn = turnOf(rowsOf({ ...emptyThread, events }))
    expect(shape(turn)).toEqual(['reply:Hello', 'user:Wait', 'work:tool'])
    expect(turn.answer.map((reply) => reply.text)).toEqual([' world'])
  })

  it('moves a steer saved after later activity back into the earlier message it was sent into', () => {
    const events: ThreadEvent[] = [
      first, say('m1', 2, 'Alpha beta'), tool('t1', 3),
      steer('user_2', 4, 'Hey', { messageId: 'm1', textOffset: 5 }),
      result,
    ]
    const turn = turnOf(rowsOf({ ...emptyThread, events }))
    expect(shape(turn)).toEqual(['reply:Alpha', 'user:Hey', 'reply: beta', 'work:tool'])
  })

  it('keeps steers sharing an offset in the order they were saved', () => {
    const events: ThreadEvent[] = [
      first,
      steer('user_2', 3, 'a', { messageId: 'm1', textOffset: 5 }),
      steer('user_3', 4, 'b', { messageId: 'm1', textOffset: 5 }),
      steer('user_4', 5, 'c', { messageId: 'm1', textOffset: 0 }),
      steer('user_5', 6, 'd', { messageId: 'm1', textOffset: 11 }),
      steer('user_6', 7, 'e', { messageId: 'm1', textOffset: 99 }),
      say('m1', 8, 'Hello world'),
    ]
    const turn = turnOf(rowsOf({ ...emptyThread, events, liveTurns: running() }))
    expect(shape(turn)).toEqual(['reply:Hello', 'user:a', 'user:b', 'user:c', 'reply: world', 'user:d', 'user:e'])
  })

  it('keeps a trailing steer after the answer with both standing outside the fold', () => {
    const events: ThreadEvent[] = [first, say('m1', 2, 'Hello'), steer('user_2', 3, 'Late', { messageId: 'm1', textOffset: 5 }), result]
    const turn = turnOf(rowsOf({ ...emptyThread, events }))
    expect(turn.answer.map((reply) => reply.text)).toEqual(['Hello'])
    expect(shape(turn)).toEqual([])
    expect(turn.tail.map((segment) => segment.kind)).toEqual(['reply', 'user'])
  })

  it('keeps hints and forwards on the wrapped steer row through a live projection', () => {
    const events: ThreadEvent[] = [
      first, tool('t1', 3), steer('user_2', 4, 'Wait'),
      { id: 'hint', ts: 5, type: 'system_note', kind: 'info', text: 'Noted', hintFor: 'user_2' },
    ]
    const turn = turnOf(rowsOf({ ...emptyThread, events, liveTurns: running([{ messageId: 'm1', text: 'x' }]) }))
    const user = turn.segments.find((segment) => segment.kind === 'user')!
    expect(user.kind === 'user' && user.row.hints).toEqual(['Noted'])
    expect(user.kind === 'user' && user.row.event).toBe(events[2])
    expect(rowHasQuoteSource(turn, 'user_2')).toBe(true)
  })

  it('leaves pending and queued messages out of the turn', () => {
    const queued: ThreadEvent = { ...steer('user_q', 5, 'Queued'), queuedAfter: 'result' } as ThreadEvent
    const waiting: ThreadEvent = { ...steer('user_w', 6, 'Waiting'), dispatchState: 'pending' } as ThreadEvent
    const rows = rowsOf({
      ...emptyThread,
      events: [first, tool('t1', 3), queued, waiting],
      liveTurns: running(),
      pending: [{ key: 'p', text: 'Typing', images: [], files: [], pageContexts: [] }],
    })
    expect(turnOf(rows).timeline.map((item) => item.kind)).toEqual(['tool'])
    expect(rows.map((row) => row.kind === 'event' && row.event.type === 'user_message' ? row.event.text : row.kind === 'pending' ? row.text : row.kind))
      .toEqual(['First', 'turn', 'Queued', 'Waiting', 'Typing'])
  })
})
