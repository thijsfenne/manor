import { describe, expect, it } from 'vitest'
import { AsyncQueue } from '../src/asyncQueue.js'

describe('AsyncQueue pressure', () => {
  it('signals full at the high-water mark, clear at the low-water mark, and keeps every item', async () => {
    const queue = new AsyncQueue<number>(4, 1)
    const signals: boolean[] = []
    queue.onPressure((full) => signals.push(full))

    for (let item = 0; item < 6; item += 1) queue.push(item)
    expect(signals).toEqual([true])

    const iterator = queue[Symbol.asyncIterator]()
    const read: number[] = []
    for (let step = 0; step < 4; step += 1) read.push((await iterator.next()).value!)
    expect(signals).toEqual([true])
    read.push((await iterator.next()).value!)
    expect(signals).toEqual([true, false])

    queue.push(6)
    queue.close()
    for (let next = await iterator.next(); !next.done; next = await iterator.next()) read.push(next.value)
    expect(read).toEqual([0, 1, 2, 3, 4, 5, 6])
  })

  it('releases a paused producer when the queue closes or its consumer leaves', async () => {
    const closing = new AsyncQueue<number>(2, 0)
    const closed: boolean[] = []
    closing.onPressure((full) => closed.push(full))
    closing.push(1)
    closing.push(2)
    closing.close()
    expect(closed).toEqual([true, false])

    const leaving = new AsyncQueue<number>(2, 0)
    const left: boolean[] = []
    leaving.onPressure((full) => left.push(full))
    leaving.push(1)
    leaving.push(2)
    for await (const item of leaving) if (item === 1) break
    expect(left).toEqual([true, false])
  })

  it('counts reserved lines a slow parser has not pushed yet, so the producer pauses before the queue fills', async () => {
    const queue = new AsyncQueue<number>(4, 1)
    const signals: boolean[] = []
    queue.onPressure((full) => signals.push(full))

    const releases = Array.from({ length: 4 }, () => queue.reserve())
    expect(signals).toEqual([true])

    releases[0]!()
    releases[0]!()
    releases[1]!()
    expect(signals).toEqual([true])
    releases[2]!()
    expect(signals).toEqual([true, false])

    queue.push(1)
    releases[3]!()
    queue.close()
    const read: number[] = []
    for await (const item of queue) read.push(item)
    expect(read).toEqual([1])
  })
})
