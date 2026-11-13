import { useCallback, useState, useSyncExternalStore } from 'react'

/**
 * The side surfaces inside a chat that the user can fold away besides the rail's own doors
 * (which `useRightPanel` already remembers per chat): the note tree in Knowledge, the
 * file tree in Files and the Sessions overview beside a project thread.
 */
export type CollapsibleSurface = 'knowledge-tree' | 'files-tree' | 'sessions-overview'

export const COLLAPSED_KEY = 'manor:collapsed-by-chat'

const SURFACES: readonly CollapsibleSurface[] = ['knowledge-tree', 'files-tree', 'sessions-overview']
const isSurface = (value: unknown): value is CollapsibleSurface => SURFACES.includes(value as CollapsibleSurface)

type Collapsed = Readonly<Record<string, readonly CollapsibleSurface[]>>

function read(): Collapsed {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(COLLAPSED_KEY) ?? '{}')
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([chatId, value]) => {
        const surfaces = Array.isArray(value) ? value.filter(isSurface) : []
        return surfaces.length === 0 ? [] : [[chatId, surfaces]]
      }),
    )
  } catch {
    return {}
  }
}

let state: Collapsed = read()
const listeners = new Set<() => void>()

/** Replaces the in-memory map, so a reload (and a test) can start from what storage holds. */
export function reloadCollapsed() {
  state = read()
  listeners.forEach((listener) => listener())
}

export const isCollapsed = (chatId: string, surface: CollapsibleSurface) => state[chatId]?.includes(surface) === true

/**
 * Chrome, not workspace state, so it stays in localStorage and never reaches the server,
 * the same split the rail makes. Entries for deleted chats linger; a few short strings in
 * a single-user localStorage are not worth a pruning pass. A chat nobody has touched has no
 * entry and opens with each surface's own default (shown).
 */
export function setCollapsed(chatId: string, surface: CollapsibleSurface, collapsed: boolean) {
  if (isCollapsed(chatId, surface) === collapsed) return
  const rest = (state[chatId] ?? []).filter((entry) => entry !== surface)
  const surfaces = collapsed ? [...rest, surface] : rest
  const { [chatId]: _previous, ...others } = state
  state = surfaces.length === 0 ? others : { ...others, [chatId]: surfaces }
  try {
    window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify(state))
  } catch {
    // The fold still holds for this session, it just does not survive a reload.
  }
  listeners.forEach((listener) => listener())
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Whether one surface is folded in one chat, kept per chat across chats, screens and
 * reloads. Without a chat (the vault home) it is plain component state, as before.
 */
export function useCollapsed(chatId: string | null | undefined, surface: CollapsibleSurface) {
  const stored = useSyncExternalStore(subscribe, () => chatId != null && isCollapsed(chatId, surface), () => false)
  const [local, setLocal] = useState(false)
  const set = useCallback((collapsed: boolean) => {
    if (chatId == null) setLocal(collapsed)
    else setCollapsed(chatId, surface, collapsed)
  }, [chatId, surface])
  return [chatId == null ? local : stored, set] as const
}
