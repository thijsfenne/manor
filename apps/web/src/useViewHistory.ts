import { useCallback, useRef, useState } from 'react'
import type { SidebarView } from './useSidebar'

/** Where the stage can stand. Session-only, like a browser tab's history. */
export type WorkspaceLocation =
  | { kind: 'chat'; chatId: string }
  | { kind: 'new-chat'; target: { kind: 'project'; projectId: string } | { kind: 'dm'; agentId: string } }
  | { kind: 'skills' }
  | { kind: 'connectors' }
  | { kind: 'suggestions' }
  | { kind: 'routines'; routineId: string | null }
  | { kind: 'knowledge' }
  | { kind: 'reminders' }
  | { kind: 'artifacts' }
  | { kind: 'browser' }
  | { kind: 'usage' }

const RELOAD_LOCATION_KEY = 'manor:workspace-location'

export interface ReloadLocation {
  location: WorkspaceLocation
  sidebarView: SidebarView
}

function locationFrom(value: unknown): WorkspaceLocation | null {
  if (typeof value !== 'object' || value === null || !('kind' in value)) return null
  switch (value.kind) {
    case 'chat':
      return 'chatId' in value && typeof value.chatId === 'string' && value.chatId !== ''
        ? { kind: 'chat', chatId: value.chatId } : null
    case 'new-chat': {
      if (!('target' in value) || typeof value.target !== 'object' || value.target === null) return null
      const target = value.target
      if (!('kind' in target)) return null
      if (target.kind === 'project' && 'projectId' in target && typeof target.projectId === 'string' && target.projectId !== '') {
        return { kind: 'new-chat', target: { kind: 'project', projectId: target.projectId } }
      }
      if (target.kind === 'dm' && 'agentId' in target && typeof target.agentId === 'string' && target.agentId !== '') {
        return { kind: 'new-chat', target: { kind: 'dm', agentId: target.agentId } }
      }
      return null
    }
    case 'routines':
      return 'routineId' in value && (value.routineId === null || typeof value.routineId === 'string')
        ? { kind: 'routines', routineId: value.routineId } : null
    case 'skills':
    case 'connectors':
    case 'suggestions':
    case 'knowledge':
    case 'reminders':
    case 'artifacts':
    case 'browser':
    case 'usage':
      return { kind: value.kind }
    default:
      return null
  }
}

/** A tab restores its own destination without another window overwriting it. */
export function readReloadLocation(): ReloadLocation | null {
  try {
    const raw = window.sessionStorage.getItem(RELOAD_LOCATION_KEY)
    const stored: unknown = raw === null ? null : JSON.parse(raw)
    if (typeof stored !== 'object' || stored === null || !('location' in stored) || !('sidebarView' in stored)) return null
    const location = locationFrom(stored.location)
    return location !== null && (stored.sidebarView === 'inbox' || stored.sidebarView === 'chats')
      ? { location, sidebarView: stored.sidebarView } : null
  } catch {
    return null
  }
}

export function writeReloadLocation(value: ReloadLocation): void {
  try {
    window.sessionStorage.setItem(RELOAD_LOCATION_KEY, JSON.stringify(value))
  } catch {
    // Storage can be disabled; navigation must still work in the current tab.
  }
}

export interface ViewHistoryState {
  entries: WorkspaceLocation[]
  index: number
}

export const emptyViewHistory: ViewHistoryState = { entries: [], index: -1 }

export function sameLocation(a: WorkspaceLocation, b: WorkspaceLocation): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'chat' && b.kind === 'chat') return a.chatId === b.chatId
  if (a.kind === 'new-chat' && b.kind === 'new-chat') {
    if (a.target.kind !== b.target.kind) return false
    if (a.target.kind === 'project' && b.target.kind === 'project') {
      return a.target.projectId === b.target.projectId
    }
    if (a.target.kind === 'dm' && b.target.kind === 'dm') return a.target.agentId === b.target.agentId
    return false
  }
  if (a.kind === 'routines' && b.kind === 'routines') return a.routineId === b.routineId
  return true
}

/** Push a place, dropping anything ahead of the cursor. Same place is a no-op. */
export function recordLocation(state: ViewHistoryState, location: WorkspaceLocation): ViewHistoryState {
  const existing = state.entries[state.index]
  if (existing !== undefined && sameLocation(existing, location)) return state
  const entries = [...state.entries.slice(0, state.index + 1), location]
  return { entries, index: entries.length - 1 }
}

export function stepBack(state: ViewHistoryState): { state: ViewHistoryState; location: WorkspaceLocation } | null {
  if (state.index <= 0) return null
  const index = state.index - 1
  const location = state.entries[index]
  if (location === undefined) return null
  return { state: { entries: state.entries, index }, location }
}

export function stepForward(
  state: ViewHistoryState,
): { state: ViewHistoryState; location: WorkspaceLocation } | null {
  if (state.index >= state.entries.length - 1) return null
  const index = state.index + 1
  const location = state.entries[index]
  if (location === undefined) return null
  return { state: { entries: state.entries, index }, location }
}

/**
 * In-app back/forward for the stage. Records each distinct place and drops the
 * forward stack on a new navigation, the same way a browser tab does. Nothing is
 * persisted: a reload starts a fresh stack at the destination the tab restores.
 */
export function useViewHistory() {
  const [state, setState] = useState<ViewHistoryState>(emptyViewHistory)
  const stateRef = useRef(state)
  stateRef.current = state

  const record = useCallback((location: WorkspaceLocation) => {
    setState((current) => recordLocation(current, location))
  }, [])

  const back = useCallback((): WorkspaceLocation | null => {
    const stepped = stepBack(stateRef.current)
    if (stepped === null) return null
    setState(stepped.state)
    return stepped.location
  }, [])

  const forward = useCallback((): WorkspaceLocation | null => {
    const stepped = stepForward(stateRef.current)
    if (stepped === null) return null
    setState(stepped.state)
    return stepped.location
  }, [])

  return {
    record,
    back,
    forward,
    canBack: state.index > 0,
    canForward: state.index >= 0 && state.index < state.entries.length - 1,
  }
}
