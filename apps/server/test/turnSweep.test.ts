import type { ThreadEvent } from '@manor/contracts'
import { describe, expect, it } from 'vitest'
import { agents } from '../src/agents.js'
import { createMemoryStore } from '../src/stores/memoryStore.js'
import {
  lostBackgroundNote,
  lostConnectionNote,
  openBackgroundRows,
  SWEEP_CONCURRENCY,
  sweepUnterminatedTurns,
  unterminatedTurns,
} from '../src/turnSweep.js'

let nextId = 0
const event = (patch: Partial<ThreadEvent> & Pick<ThreadEvent, 'type'>): ThreadEvent =>
  ({ id: `evt_${(nextId += 1)}`, ts: nextId, ...patch }) as ThreadEvent

const toolUse = (turnId: string, agentId = 'smith') =>
  event({ type: 'tool_use', turnId, agentId, tool: 'Bash' })

describe('unterminatedTurns', () => {
  it('finds a turn whose events simply stop', () => {
    expect(unterminatedTurns([toolUse('turn_1')])).toEqual([
      { turnId: 'turn_1', agentId: 'smith', lastTs: 1 },
    ])
  })

  it('leaves a turn that produced a result', () => {
    const events = [toolUse('turn_1'), event({ type: 'turn_result', turnId: 'turn_1', agentId: 'smith' })]
    expect(unterminatedTurns(events)).toEqual([])
  })

  it('leaves a turn an error or an abort already explained', () => {
    for (const kind of ['error', 'aborted'] as const) {
      const events = [
        toolUse('turn_1'),
        event({ type: 'system_note', kind, text: 'x', turnId: 'turn_1', agentId: 'smith' }),
      ]
      expect(unterminatedTurns(events)).toEqual([])
    }
  })

  // The point of the note is "you got nothing back". A turn that spoke is accounted
  // for, even without a turn_result, which is how every transcript from before
  // turn_result existed looks. Without this the real store reported 35 hanging turns
  // instead of 5, and 30 old turns that had answered would have been told they had not.
  it('leaves a turn that said something, even with no result event', () => {
    const events = [
      toolUse('turn_1'),
      event({ type: 'agent_message', turnId: 'turn_1', agentId: 'smith', text: 'done' }),
    ]
    expect(unterminatedTurns(events)).toEqual([])
  })

  it('finds a turn that answered while background work it started never reported its end', () => {
    const launch = event({ type: 'tool_use', turnId: 'turn_1', agentId: 'smith', toolCallId: 'bg', tool: 'Agent', background: true })
    const answer = event({ type: 'agent_message', turnId: 'turn_1', agentId: 'smith', text: 'Started it. I will report back.' })
    expect(unterminatedTurns([launch, answer])).toEqual([{ turnId: 'turn_1', agentId: 'smith', lastTs: answer.ts }])
    const ended = event({ type: 'tool_result', turnId: 'turn_1', agentId: 'smith', toolCallId: 'bg', outcome: 'success' })
    expect(unterminatedTurns([launch, answer, ended])).toEqual([])
  })

  it('counts a row Codex announced as background only while it still ran, and a resumed agent again', () => {
    const shell = (extra: Record<string, unknown> = {}) =>
      event({ type: 'tool_use', turnId: 'turn_1', agentId: 'sage', toolCallId: 'shell-1', tool: 'Bash', detail: 'npm test', ...extra })
    const done = (id: string) => event({ type: 'tool_result', turnId: 'turn_1', agentId: 'sage', toolCallId: id, outcome: 'success' })
    // The end reached the store before the announcement at the answer did.
    expect(openBackgroundRows([shell(), done('shell-1'), shell({ background: true })])).toEqual([])
    expect(openBackgroundRows([shell(), shell({ background: true })])).toEqual([expect.objectContaining({ toolCallId: 'shell-1' })])
    const agent = (extra: Record<string, unknown> = {}) =>
      event({ type: 'tool_use', turnId: 'turn_1', agentId: 'smith', toolCallId: 'bg', tool: 'Agent', background: true, ...extra })
    expect(openBackgroundRows([agent(), done('bg'), agent()])).toEqual([expect.objectContaining({ toolCallId: 'bg' })])
  })

  // The mid-turn "hit a problem and carried on" note; the turn kept going past it, so
  // it says nothing about how the turn ended.
  it('does not treat an info note as an ending', () => {
    const events = [
      toolUse('turn_1'),
      event({ type: 'system_note', kind: 'info', text: 'x', turnId: 'turn_1', agentId: 'smith' }),
    ]
    expect(unterminatedTurns(events)).toHaveLength(1)
  })

  it('reports each hanging turn once, per agent, with its last timestamp', () => {
    const first = toolUse('turn_1')
    const other = toolUse('turn_2', 'sage')
    const last = toolUse('turn_1')
    const found = unterminatedTurns([
      first,
      other,
      last,
      event({ type: 'turn_result', turnId: 'turn_2', agentId: 'sage' }),
    ])
    expect(found).toEqual([{ turnId: 'turn_1', agentId: 'smith', lastTs: last.ts }])
  })

  it('ignores events that belong to no turn', () => {
    expect(unterminatedTurns([event({ type: 'user_message', text: 'hi', mentions: [] })])).toEqual([])
  })
})

describe('sweepUnterminatedTurns', () => {
  it('closes a hanging turn with a note naming the agent, and never twice', async () => {
    const store = createMemoryStore()
    const project = await store.createProject('Manor')
    const chat = await store.createChat({ projectId: project.id })
    await store.appendEvent(chat.id, { type: 'tool_use', turnId: 'turn_1', agentId: 'smith', tool: 'Bash' })

    expect(await sweepUnterminatedTurns({ store, agents })).toBe(1)

    const events = await store.loadEvents(chat.id)
    const note = events.at(-1)
    expect(note).toMatchObject({ type: 'system_note', kind: 'aborted', turnId: 'turn_1', agentId: 'smith' })
    expect(note && 'text' in note ? note.text : '').toBe(lostConnectionNote('Smith'))

    // The note it just wrote is itself terminal, so a second boot finds nothing.
    expect(await sweepUnterminatedTurns({ store, agents })).toBe(0)
  })

  it('stops background rows a finished turn left open, with one note per persona, and never twice', async () => {
    const store = createMemoryStore()
    const project = await store.createProject('Manor')
    const chat = await store.createChat({ projectId: project.id })
    await store.appendEvent(chat.id, { type: 'tool_use', turnId: 'turn_1', agentId: 'smith', toolCallId: 'bg1', tool: 'Agent', subject: 'Audit the repo', background: true })
    await store.appendEvent(chat.id, { type: 'tool_use', turnId: 'turn_1', agentId: 'smith', toolCallId: 'bg2', tool: 'Bash', detail: 'sleep 60', background: true })
    await store.appendEvent(chat.id, { type: 'tool_result', turnId: 'turn_1', agentId: 'smith', toolCallId: 'bg2', outcome: 'success' })
    await store.appendEvent(chat.id, { type: 'turn_result', turnId: 'turn_1', agentId: 'smith' })

    expect(await sweepUnterminatedTurns({ store, agents })).toBe(1)
    const events = await store.loadEvents(chat.id)
    expect(events.slice(-2)).toEqual([
      expect.objectContaining({ type: 'tool_result', toolCallId: 'bg1', outcome: 'stopped', turnId: 'turn_1', agentId: 'smith' }),
      expect.objectContaining({ type: 'system_note', kind: 'info', agentId: 'smith', text: lostBackgroundNote('Smith', ['Audit the repo']) }),
    ])
    expect(await sweepUnterminatedTurns({ store, agents })).toBe(0)
  })

  it('says the work may still have landed rather than that it was aborted', () => {
    expect(lostConnectionNote('Smith')).toMatch(/may still have landed/)
    expect(lostConnectionNote('Smith')).not.toMatch(/failed|aborted/i)
  })

  it('sweeps several chats at once, but never more than the cap', async () => {
    // Every boot pays this before the server listens, so it is not serial; it is also
    // not a plain Promise.all, which would burst one read per chat at the worst moment
    // for the database. Both halves are asserted: the concurrency is real, and bounded.
    const store = createMemoryStore()
    const project = await store.createProject('Manor')
    const chats = await Promise.all(
      Array.from({ length: SWEEP_CONCURRENCY * 3 }, () => store.createChat({ projectId: project.id })),
    )
    for (const chat of chats) {
      await store.appendEvent(chat.id, { type: 'tool_use', turnId: 'turn_1', agentId: 'smith', tool: 'Bash' })
    }

    let live = 0
    let peak = 0
    const gated = {
      ...store,
      loadEvents: async (chatId: string) => {
        live += 1
        peak = Math.max(peak, live)
        // A real await, so every worker that can start has started before any finishes.
        await new Promise((resolve) => setTimeout(resolve, 5))
        const events = await store.loadEvents(chatId)
        live -= 1
        return events
      },
    }

    expect(await sweepUnterminatedTurns({ store: gated, agents })).toBe(chats.length)
    expect(peak).toBe(SWEEP_CONCURRENCY)
    // Every chat was swept exactly once, however they were interleaved.
    for (const chat of chats) {
      const notes = (await store.loadEvents(chat.id)).filter((event) => event.type === 'system_note')
      expect(notes).toHaveLength(1)
    }
  })

  it('reports nothing and calls nothing back on a clean transcript', async () => {
    const store = createMemoryStore()
    const project = await store.createProject('Manor')
    const chat = await store.createChat({ projectId: project.id })
    await store.appendEvent(chat.id, { type: 'tool_use', turnId: 'turn_1', agentId: 'smith', tool: 'Bash' })
    await store.appendEvent(chat.id, { type: 'turn_result', turnId: 'turn_1', agentId: 'smith' })

    let reported = 0
    expect(await sweepUnterminatedTurns({ store, agents, onSwept: (n) => (reported = n) })).toBe(0)
    expect(reported).toBe(0)
  })
})
