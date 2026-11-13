import { describe, expect, it } from 'vitest'
import { HISTORY_PAGE_SIZE, historyStart, olderHistoryKey } from './historyWindow'

const rows = Array.from({ length: 100 }, (_, index) => ({ key: `row-${index}` }))

describe('transcript history pages', () => {
  it('opens at the latest page and exposes all older rows in order', () => {
    let start = historyStart(rows, undefined)
    expect(rows.slice(start)).toHaveLength(HISTORY_PAGE_SIZE)
    expect(rows[start]?.key).toBe('row-70')
    start = historyStart(rows, olderHistoryKey(rows, start))
    expect(start).toBe(40)
    start = historyStart(rows, olderHistoryKey(rows, start))
    expect(start).toBe(10)
    start = historyStart(rows, olderHistoryKey(rows, start))
    expect(start).toBe(0)
  })

  it('does not evict the reading anchor when replies arrive or rows are inserted', () => {
    const first = rows[historyStart(rows, undefined)]!.key
    const updated = [{ key: 'earlier-marker' }, ...rows, { key: 'new-reply' }]
    expect(updated[historyStart(updated, first)]?.key).toBe(first)
    expect(updated.slice(historyStart(updated, first))).toHaveLength(31)
  })

  it('handles an empty snapshot, short chats, and an anchor removed by a replacement snapshot', () => {
    expect(historyStart([], undefined)).toBe(0)
    expect(olderHistoryKey([], 0)).toBeUndefined()
    expect(historyStart(rows.slice(0, 4), undefined)).toBe(0)
    expect(historyStart(rows, 'removed')).toBe(70)
  })
})
