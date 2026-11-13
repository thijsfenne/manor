import { describe, expect, it } from 'vitest'
import { relativeTime } from './relativeTime'

describe('relativeTime', () => {
  const now = Date.parse('2026-08-10T12:00:00Z')
  const ago = (ms: number) => relativeTime(now - ms, now)

  it('counts down through one unit at a time', () => {
    expect(ago(29 * 60_000)).toBe('29m')
    expect(ago(3 * 3_600_000)).toBe('3h')
    expect(ago(2 * 86_400_000)).toBe('2d')
    expect(ago(3 * 7 * 86_400_000)).toBe('3w')
  })

  it('rounds down, so a label never claims more time than has passed', () => {
    expect(ago(119_000)).toBe('1m')
    expect(ago(3_599_000)).toBe('59m')
    expect(ago(86_399_000)).toBe('23h')
  })

  it('says now for anything under a minute, and for a stamp from the future', () => {
    expect(ago(0)).toBe('now')
    expect(ago(59_000)).toBe('now')
    expect(relativeTime(now + 5_000, now)).toBe('now')
  })
})
