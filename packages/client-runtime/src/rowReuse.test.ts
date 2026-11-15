import { describe, expect, it } from 'vitest'
import { createRowMemory, createValueMemory, reuseRows, sameStructure } from './rowReuse'

describe('sameStructure', () => {
  it('compares content, and tells a missing key from an undefined one', () => {
    const event = { id: 'e1' }
    expect(sameStructure({ key: 'a', event, steps: [1, 2] }, { key: 'a', event, steps: [1, 2] })).toBe(true)
    expect(sameStructure({ key: 'a', steps: [1, 2] }, { key: 'a', steps: [1, 3] })).toBe(false)
    expect(sameStructure({ key: 'a', note: undefined }, { key: 'a' })).toBe(false)
    expect(sameStructure([1], { 0: 1 })).toBe(false)
    expect(sameStructure(new Map([['a', { n: 1 }]]), new Map([['a', { n: 1 }]]))).toBe(true)
    expect(sameStructure(new Map([['a', { n: 1 }]]), new Map([['a', { n: 2 }]]))).toBe(false)
    expect(sameStructure(new Set(['a']), new Set(['b']))).toBe(false)
    // Not plain data: equal only to itself.
    expect(sameStructure(new Date(1), new Date(1))).toBe(false)
  })

  it('ends on a graph that points back at itself', () => {
    const loop = (name: string) => {
      const turn: { name: string; items: { turn?: unknown }[] } = { name, items: [{}] }
      turn.items[0]!.turn = turn
      return turn
    }
    expect(sameStructure(loop('a'), loop('a'))).toBe(true)
    expect(sameStructure(loop('a'), loop('b'))).toBe(false)
  })
})

describe('reuseRows', () => {
  const row = (key: string, text: string) => ({ key, text, parts: [{ text }] })

  it('keeps the object of every row that says the same, and takes the new one where it differs', () => {
    const previous = [row('a', 'one'), row('b', 'two'), row('c', 'three')]
    const next = [row('a', 'one'), row('b', 'changed'), row('c', 'three'), row('d', 'four')]

    const rows = reuseRows(previous, next)

    expect(rows[0]).toBe(previous[0])
    expect(rows[1]).toBe(next[1])
    expect(rows[2]).toBe(previous[2])
    expect(rows[3]).toBe(next[3])
  })

  it('hands back the previous list when nothing changed, and the new one when nothing could be kept', () => {
    const previous = [row('a', 'one'), row('b', 'two')]
    expect(reuseRows(previous, [row('a', 'one'), row('b', 'two')])).toBe(previous)
    const other = [row('x', 'one')]
    expect(reuseRows(previous, other)).toBe(other)
    expect(reuseRows(undefined, other)).toBe(other)
  })

  it('follows a row that moved, and never puts one object in two places', () => {
    const previous = [row('a', 'one'), row('b', 'two')]
    const moved = reuseRows(previous, [row('b', 'two'), row('a', 'one')])
    expect(moved).toEqual([previous[1], previous[0]])
    expect(moved[0]).toBe(previous[1])
    const twice = reuseRows(previous, [row('a', 'one'), row('a', 'one')])
    expect(twice[0]).toBe(previous[0])
    expect(twice[1]).not.toBe(previous[0])
  })

  it('keeps a derived value while a rebuilt one says the same', () => {
    const memory = createValueMemory<{ labels: (string | undefined)[]; waiting: Map<string, string> }>()
    const first = memory.keep({ labels: ['Today', undefined], waiting: new Map([['turn-1', 'sage']]) })
    expect(memory.keep({ labels: ['Today', undefined], waiting: new Map([['turn-1', 'sage']]) })).toBe(first)
    const next = memory.keep({ labels: ['Today', undefined], waiting: new Map() })
    expect(next).not.toBe(first)
    expect(memory.keep({ labels: ['Today', undefined], waiting: new Map() })).toBe(next)
  })

  it('remembers the last list it was given', () => {
    const memory = createRowMemory<ReturnType<typeof row>>()
    const first = memory.reuse([row('a', 'one')])
    const second = memory.reuse([row('a', 'one'), row('b', 'two')])
    expect(second[0]).toBe(first[0])
    expect(memory.reuse(second)).toBe(second)
  })
})
