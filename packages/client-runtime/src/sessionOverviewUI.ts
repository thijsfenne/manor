import type { SessionOverviewGroup } from './state'

/** Settled and Archived open on one page and grow a page per click. */
export const QUIET_PAGE_SIZE = 20

export type SessionOverviewSection = SessionOverviewGroup | 'archived'

interface SessionOverviewUI {
  open: Record<SessionOverviewSection, boolean>
  visibleSettled: number
  visibleArchived: number
}

const defaults: SessionOverviewUI = {
  open: { waiting: true, working: true, settled: false, archived: false },
  visibleSettled: QUIET_PAGE_SIZE,
  visibleArchived: QUIET_PAGE_SIZE,
}

/**
 * Settled and Archived are the quiet sections, and one of them is open at a time, as in
 * the sidebar: two open together leave neither enough room to read.
 */
export const toggleSessionOverviewSection = (current: SessionOverviewUI, section: SessionOverviewSection): SessionOverviewUI => {
  const quiet = section === 'settled' || section === 'archived'
  const opening = !current.open[section]
  return {
    ...current,
    open: {
      ...current.open,
      ...(quiet && opening ? { settled: false, archived: false } : {}),
      [section]: opening,
    },
  }
}

/** Per project thread, for this app session. A visit to a Session unmounts its overview. */
const views = new Map<string, SessionOverviewUI>()
const listeners = new Set<() => void>()

export function readSessionOverviewUI(threadId: string) {
  return views.get(threadId) ?? defaults
}

export function subscribeSessionOverviewUI(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function updateSessionOverviewUI(threadId: string, update: (current: SessionOverviewUI) => SessionOverviewUI) {
  views.set(threadId, update(readSessionOverviewUI(threadId)))
  listeners.forEach((listener) => listener())
}
