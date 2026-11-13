/** Page whole transcript rows so a turn's messages, tools and actions stay together. */
export const HISTORY_PAGE_SIZE = 30

export function historyStart(rows: readonly { key: string }[], firstKey: string | undefined): number {
  const index = firstKey === undefined ? -1 : rows.findIndex((row) => row.key === firstKey)
  return index < 0 ? Math.max(0, rows.length - HISTORY_PAGE_SIZE) : index
}

export function olderHistoryKey(rows: readonly { key: string }[], start: number): string | undefined {
  return rows[Math.max(0, start - HISTORY_PAGE_SIZE)]?.key
}
