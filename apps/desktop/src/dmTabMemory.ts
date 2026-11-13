import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** Same ceiling as a live host. A remembered list cannot grow a browser past it. */
const MAX_SAVED_TABS = 50

/** One DM's tab strip, remembered without keeping WebContentsViews alive. */
export interface DmTabSnapshot {
  urls: string[]
  activeIndex: number
  /** Pinned tabs occupy the first positions in the saved strip. */
  pinnedCount?: number
}

export interface DmTabMemory {
  load(): Map<string, DmTabSnapshot>
  save(tabs: Map<string, DmTabSnapshot>): void
}

export function parseDmTabMemory(raw: unknown): Map<string, DmTabSnapshot> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return new Map()
  const remembered = new Map<string, DmTabSnapshot>()
  for (const [chatId, value] of Object.entries(raw)) {
    if (chatId === '' || typeof value !== 'object' || value === null) continue
    const record = value as Record<string, unknown>
    const urls = Array.isArray(record.urls)
      ? record.urls.filter((url): url is string => typeof url === 'string').slice(0, MAX_SAVED_TABS)
      : []
    if (urls.length === 0) continue
    const activeIndex = Number.isInteger(record.activeIndex)
      ? Math.min(Math.max(0, record.activeIndex as number), urls.length - 1)
      : 0
    const pinnedCount = Number.isInteger(record.pinnedCount)
      ? Math.min(Math.max(0, record.pinnedCount as number), urls.length)
      : 0
    remembered.set(chatId, { urls, activeIndex, ...(pinnedCount > 0 ? { pinnedCount } : {}) })
  }
  return remembered
}

export function serializeDmTabMemory(tabs: Map<string, DmTabSnapshot>): Record<string, DmTabSnapshot> {
  return Object.fromEntries(tabs)
}

export function createFileDmTabMemory(filePath: string): DmTabMemory {
  return {
    load() {
      try {
        return parseDmTabMemory(JSON.parse(readFileSync(filePath, 'utf8')) as unknown)
      } catch {
        return new Map()
      }
    },
    save(tabs) {
      mkdirSync(path.dirname(filePath), { recursive: true })
      const temporary = `${filePath}.${process.pid}.tmp`
      writeFileSync(temporary, `${JSON.stringify(serializeDmTabMemory(tabs))}\n`)
      renameSync(temporary, filePath)
    },
  }
}
