import { describe, expect, it } from 'vitest'
import { digitKeys } from './digitKeys'

/** Which digits of `next` get a key `previous` did not have, so they remount and move. */
const moved = (previous: number, next: number) => {
  const before = new Set(digitKeys(previous))
  return digitKeys(next).map((key) => !before.has(key))
}

describe('digitKeys', () => {
  it('moves only the digits that changed, counted from the right', () => {
    expect(moved(128, 131)).toEqual([false, true, true])
  })

  it('moves every digit when the count gains a place', () => {
    expect(moved(99, 100)).toEqual([true, true, true])
  })

  it('keeps the unchanged tail when the count loses a place', () => {
    expect(moved(105, 95)).toEqual([true, false])
  })

  it('moves nothing when the count is the same', () => {
    expect(moved(42, 42)).toEqual([false, false])
  })
})
