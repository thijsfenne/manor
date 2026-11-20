import type { Row } from '@manor/client-runtime/state'
import { describe, expect, it } from 'vitest'

import { tailArrivals } from './arrival'

const pending = (key: string, text: string): Row => ({ kind: 'pending', key, text, images: [], files: [], pageContexts: [] })
const stored = (id: string, text: string): Row => ({ kind: 'event', key: id, event: { id, ts: 1, type: 'user_message', text, mentions: [] } })
const card = (key: string): Row => ({ kind: 'work_handoff', key } as Row)
const turn = (key: string): Row => ({ kind: 'turn', key } as Row)
const keyOf = (row: Row) => row.key

describe('tailArrivals', () => {
  it('flies the newest message he sent and fades the rest that came in at the end', () => {
    const before = [stored('u0', 'eerder'), turn('t0')]
    expect([...tailArrivals(before, [...before, pending('p1', 'hoi')], keyOf, true)]).toEqual([['p1', 'send']])
    expect([...tailArrivals(before, [...before, turn('t1')], keyOf, true)]).toEqual([['t1', 'fade']])
    expect([...tailArrivals(before, [...before, pending('p1', 'a'), pending('p2', 'b')], keyOf, true)]).toEqual([['p2', 'send'], ['p1', 'fade']])
  })

  it('fades a message sent from another device, and lets other rows just appear', () => {
    const before = [stored('u0', 'eerder')]
    expect([...tailArrivals(before, [...before, stored('u1', 'elders')], keyOf, false)]).toEqual([['u1', 'fade']])
    expect(tailArrivals(before, [...before, card('w1')], keyOf, true).size).toBe(0)
  })

  it('brings nothing when history loads or pages in above, but flies a first send', () => {
    const rows = [stored('u0', 'eerder'), turn('t0')]
    expect(tailArrivals([], rows, keyOf, false).size).toBe(0)
    expect([...tailArrivals([], [pending('p1', 'hoi')], keyOf, true)]).toEqual([['p1', 'send']])
    expect(tailArrivals(rows, [stored('old', 'oud'), ...rows], keyOf, true).size).toBe(0)
  })
})
