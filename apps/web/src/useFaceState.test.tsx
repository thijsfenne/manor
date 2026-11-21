import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import type { ThreadEvent } from '@manor/contracts'
import { FACE_MOMENT_MS } from '@manor/client-runtime/face-activity'
import { emptyThread, rowsOf, type Row } from '@manor/client-runtime/state'
import { dmWorking } from '@manor/client-runtime/turn-trace'
import { useDoneMoment } from './useFaceState'

let id = 0
const event = (partial: Partial<ThreadEvent> & { type: ThreadEvent['type'] }): ThreadEvent => ({ id: `evt_${(id += 1)}`, ts: 1_786_500_000_000, ...partial }) as ThreadEvent
const sent = event({ type: 'user_message', text: 'Look into it', mentions: [] })
const reply = event({ type: 'agent_message', agentId: 'smith', turnId: 't1', messageId: 'm1', text: 'Done.' })
const running = rowsOf({ ...emptyThread, events: [sent], liveTurns: [{ turnId: 't1', agentId: 'smith', messages: [], state: 'running', startedAt: 0 }], hasSnapshot: true }, 'dm')
// A turn that ends well writes its result; one that breaks ends on its error note instead.
const ended = (last: ThreadEvent = event({ type: 'turn_result', agentId: 'smith', turnId: 't1' })) =>
  rowsOf({ ...emptyThread, events: [sent, reply, last], liveTurns: [], hasSnapshot: true }, 'dm')

let seen: ReturnType<typeof useDoneMoment> | undefined
function Probe({ rows }: { rows: readonly Row[] }) {
  seen = useDoneMoment(dmWorking(rows), rows)
  return null
}

afterEach(() => { vi.useRealTimers(); seen = undefined })

it('keeps the indicator a moment past a reply that landed whole, then lets it go', () => {
  vi.useFakeTimers()
  const view = create(createElement(Probe, { rows: running }))
  expect(seen).toMatchObject({ working: { kind: 'turn' }, done: false })
  act(() => view.update(createElement(Probe, { rows: ended() })))
  expect(seen).toMatchObject({ working: { kind: 'turn', turn: { turnId: 't1' } }, done: true })
  act(() => { vi.advanceTimersByTime(FACE_MOMENT_MS) })
  expect(seen).toEqual({ working: undefined, done: false })
})

it('lets a broken turn go at once', () => {
  const view = create(createElement(Probe, { rows: running }))
  act(() => view.update(createElement(Probe, { rows: ended(event({ type: 'system_note', kind: 'error', agentId: 'smith', turnId: 't1', text: 'Broke.' })) })))
  expect(seen).toEqual({ working: undefined, done: false })
})
