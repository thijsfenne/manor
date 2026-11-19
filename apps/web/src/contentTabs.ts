import { useEffect, useState } from 'react'
import { useStableCallback } from './useStableCallback'

/**
 * The tabs of a content surface (Knowledge's notes, a Files panel's files). A tab is a
 * place that holds one path, or none while a Files tab still asks which file it is for.
 * Only the active tab is mounted, so only it can hold unsaved text: the surface flushes
 * that before it moves to another tab.
 */
export interface ContentTab {
  id: string
  path: string | null
}

export interface ContentTabs {
  tabs: readonly ContentTab[]
  activeId: string | null
}

export const NO_TABS: ContentTabs = { tabs: [], activeId: null }

const newId = () => crypto.randomUUID()

export const activeTab = (state: ContentTabs): ContentTab | undefined =>
  state.tabs.find((tab) => tab.id === state.activeId)

/**
 * A plain open, from the sidebar or from any route outside the strip (a link in a
 * note, the search palette): the active tab takes the path. A path already open in
 * another tab switches there instead, so one file never has two editors that disagree.
 */
export function openInActive(state: ContentTabs, path: string): ContentTabs {
  const existing = state.tabs.find((tab) => tab.path === path)
  if (existing !== undefined) return { ...state, activeId: existing.id }
  const active = activeTab(state)
  if (active === undefined) return openInNew(state, path)
  return { ...state, tabs: state.tabs.map((tab) => tab.id === active.id ? { ...tab, path } : tab) }
}

/**
 * A new tab right after the active one, or at `index` (a drop on the strip). A path
 * already open moves its tab to a dropped spot, or is switched to otherwise.
 */
export function openInNew(state: ContentTabs, path: string | null, index?: number): ContentTabs {
  const existing = path === null ? undefined : state.tabs.find((tab) => tab.path === path)
  if (existing !== undefined) {
    const moved = index === undefined ? state : moveTab(state, existing.id, index > state.tabs.indexOf(existing) ? index - 1 : index)
    return { ...moved, activeId: existing.id }
  }
  const tab = { id: newId(), path }
  const after = state.tabs.findIndex((item) => item.id === state.activeId)
  const at = clampIndex(index ?? (after === -1 ? state.tabs.length : after + 1), state.tabs.length)
  return { tabs: [...state.tabs.slice(0, at), tab, ...state.tabs.slice(at)], activeId: tab.id }
}

/** Closing the active tab hands over to its right neighbour, else its left one. */
export function closeTab(state: ContentTabs, id: string): ContentTabs {
  const at = state.tabs.findIndex((tab) => tab.id === id)
  if (at === -1) return state
  const tabs = state.tabs.filter((tab) => tab.id !== id)
  if (state.activeId !== id) return { ...state, tabs }
  return { tabs, activeId: (tabs[at] ?? tabs[at - 1])?.id ?? null }
}

export function moveTab(state: ContentTabs, id: string, index: number): ContentTabs {
  const tab = state.tabs.find((item) => item.id === id)
  if (tab === undefined) return state
  const rest = state.tabs.filter((item) => item.id !== id)
  const at = clampIndex(index, rest.length)
  return { ...state, tabs: [...rest.slice(0, at), tab, ...rest.slice(at)] }
}

export function selectTab(state: ContentTabs, id: string): ContentTabs {
  return state.tabs.some((tab) => tab.id === id) ? { ...state, activeId: id } : state
}

/** Every tab whose path `rename` maps elsewhere follows it; a folder move carries its notes. */
export function renamePaths(state: ContentTabs, rename: (path: string) => string): ContentTabs {
  let changed = false
  const tabs = state.tabs.map((tab) => {
    if (tab.path === null) return tab
    const next = rename(tab.path)
    if (next === tab.path) return tab
    changed = true
    return { ...tab, path: next }
  })
  return changed ? { ...state, tabs } : state
}

/**
 * Quietly drops the tabs whose file is gone. `keep` names a path the surface still
 * holds although the listing lacks it (a new note not yet saved).
 */
export function pruneTabs(state: ContentTabs, exists: (path: string) => boolean, keep: string | null = null): ContentTabs {
  let next = state
  for (const tab of state.tabs) {
    if (tab.path !== null && tab.path !== keep && !exists(tab.path)) next = closeTab(next, tab.id)
  }
  return next
}

const clampIndex = (index: number, length: number) => Math.max(0, Math.min(length, index))

/** Where a surface keeps its tabs across a restart. One key per surface. */
export function readTabs(key: string): ContentTabs {
  try {
    const raw = window.localStorage.getItem(key)
    if (raw === null) return NO_TABS
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return NO_TABS
    const { tabs, activeId } = parsed as { tabs?: unknown; activeId?: unknown }
    if (!Array.isArray(tabs)) return NO_TABS
    const valid = tabs.filter((tab): tab is ContentTab =>
      typeof tab === 'object' && tab !== null &&
      typeof (tab as ContentTab).id === 'string' &&
      ((tab as ContentTab).path === null || typeof (tab as ContentTab).path === 'string'))
      .map(({ id, path }) => ({ id, path }))
    const active = typeof activeId === 'string' && valid.some((tab) => tab.id === activeId) ? activeId : valid[0]?.id ?? null
    return { tabs: valid, activeId: active }
  } catch {
    return NO_TABS
  }
}

export function writeTabs(key: string, state: ContentTabs): void {
  try {
    if (state.tabs.length === 0) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, JSON.stringify({ tabs: state.tabs, activeId: state.activeId }))
  } catch {
    // Storage full or blocked: the tabs still work for this session.
  }
}

/** A surface's tabs, read once from `key` and written back on every change. Null keeps them off. */
export function useStoredTabs(key: string | null): [ContentTabs, (change: (state: ContentTabs) => ContentTabs) => void] {
  const [state, setState] = useState(() => key === null ? NO_TABS : readTabs(key))
  const [shownKey, setShownKey] = useState(key)
  if (shownKey !== key) {
    setShownKey(key)
    setState(key === null ? NO_TABS : readTabs(key))
  }
  useEffect(() => {
    if (key !== null && shownKey === key) writeTabs(key, state)
  }, [key, shownKey, state])
  return [state, setState]
}

/** How many surfaces hold ⌘W right now; the desktop shell is told only when that crosses zero. */
let closeClaims = 0

/**
 * The element last pressed or focused anywhere. Tracked from the first surface on, so
 * the press that wakes a surface (activating its split pane) already counts for it.
 */
let lastTouched: Element | null = null
let tracking = false
const touch = (event: Event) => { if (event.target instanceof Element) lastTouched = event.target }
const trackTouches = () => {
  if (tracking || typeof document === 'undefined') return
  tracking = true
  document.addEventListener('pointerdown', touch, { capture: true })
  document.addEventListener('focusin', touch)
}

/**
 * ⌘W closes the active tab while the surface holds focus: the last press or focus
 * landed on an element `holds` claims. A press on plain text, or a closed tab taking
 * its focused button along, keeps the hold; a press or focus elsewhere ends it. The key
 * event's own target does not count, because the desktop shell replays ⌘W on the
 * window. Only while held does the shell route ⌘W here instead of closing the window.
 */
export function useCloseTabKey(enabled: boolean, holds: (element: Element) => boolean, onClose: () => void): void {
  const holdsElement = useStableCallback(holds)
  const close = useStableCallback(onClose)
  useEffect(trackTouches, [])
  useEffect(() => {
    if (!enabled) return
    let claimed = false
    const claim = (next: boolean) => {
      if (next === claimed) return
      claimed = next
      if (next ? closeClaims++ === 0 : --closeClaims === 0) window.manorDesktop?.claimCloseTab?.(next)
    }
    const follow = (event: Event) => claim(event.target instanceof Element && holdsElement(event.target))
    const onKeyDown = (event: KeyboardEvent) => {
      if (!claimed || !(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== 'w') return
      event.preventDefault()
      event.stopPropagation()
      close()
    }
    const touched = lastTouched ?? document.activeElement
    claim(touched !== null && holdsElement(touched))
    document.addEventListener('pointerdown', follow, { capture: true })
    document.addEventListener('focusin', follow)
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => {
      document.removeEventListener('pointerdown', follow, { capture: true })
      document.removeEventListener('focusin', follow)
      window.removeEventListener('keydown', onKeyDown, { capture: true })
      claim(false)
    }
  }, [enabled, holdsElement, close])
}
