import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProjectIcon } from '@manor/contracts'
import type { Inbox } from './state'

/** One project-chat tile in the Ctrl+Tab switcher, wearing its room's mark and name. */
/**
 * What the chat is doing, in the sidebar row's own precedence: a question
 * waiting on the user outranks a turn in flight, which outranks an unread answer.
 * Null is a quiet chat, and a quiet chat wears no badge.
 */
export type SwitcherStanding = 'waiting' | 'working' | 'done'

export interface SwitcherItem {
  chatId: string
  title: string
  /** The invited set, on a group. Empty on a project chat. */
  agentIds: readonly string[]
  /** The room, on a project chat only. */
  project: { name: string; icon: ProjectIcon; color: string; noProject?: true } | null
  standing: SwitcherStanding | null
}

const standingOf = (row: {
  waiting: boolean
  running: boolean
  unread: boolean
}): SwitcherStanding | null =>
  row.waiting ? 'waiting' : row.running ? 'working' : row.unread ? 'done' : null

/**
 * Everything the switcher can land on, sorted by last activity, newest first.
 * Only unsettled project work gets a tile: DMs are direct lines, groups are rooms
 * rather than work, pair threads are opened from their markers, settled work is
 * done, archived work was put away, and a run already lives under its routine.
 */
export function buildSwitcherItems(inbox: Inbox): SwitcherItem[] {
  const items: (SwitcherItem & { lastMessageAt: number })[] = []
  for (const entry of inbox.unsettled) {
    items.push({
      chatId: entry.chat.id,
      title: entry.chat.title,
      agentIds: [],
      project: { name: entry.projectName, icon: entry.projectIcon, color: entry.projectColor, ...(entry.noProject === true ? { noProject: true as const } : {}) },
      standing: standingOf(entry),
      lastMessageAt: entry.chat.lastMessageAt,
    })
  }
  return items
    .sort((a, b) => b.lastMessageAt - a.lastMessageAt)
    .map((item) => ({
      chatId: item.chatId,
      title: item.title,
      agentIds: item.agentIds,
      project: item.project,
      standing: item.standing,
    }))
}

/** Past ten tiles the strip stops being an overview and starts being a list. */
export const SWITCHER_MAX_ITEMS = 10

/**
 * The strip's order while it is open: the chat on the stage leftmost, then the
 * ones recently looked at, then everything else in activity order, capped so the
 * strip never outgrows a glance. That is the Cmd+Tab contract, an active item on
 * the far left and the last thing you were in one tap away, so a quick flick
 * toggles between two chats.
 */
export function orderSwitcherItems(
  items: readonly SwitcherItem[],
  recentlyViewed: readonly string[],
  activeId: string | null,
): SwitcherItem[] {
  const byId = new Map(items.map((item) => [item.chatId, item]))
  const ordered: SwitcherItem[] = []
  const push = (id: string | null) => {
    if (id === null) return
    const item = byId.get(id)
    if (item === undefined || ordered.includes(item)) return
    ordered.push(item)
  }
  push(activeId)
  for (const id of recentlyViewed) push(id)
  for (const item of items) push(item.chatId)
  return ordered.slice(0, SWITCHER_MAX_ITEMS)
}

/**
 * Where one Tab lands inside the strip, the tile after the highlighted one,
 * wrapping at the end, or one back with Shift. The highlight is always in the
 * strip while it is open, so the unknown-id branch is only a safety net.
 */
export function cycleChatId(
  cycle: readonly string[],
  currentId: string | null,
  step: 1 | -1,
): string | undefined {
  if (cycle.length === 0) return undefined
  const current = currentId === null ? -1 : cycle.indexOf(currentId)
  if (current === -1) return cycle[step === 1 ? 0 : cycle.length - 1]
  return cycle[(current + step + cycle.length) % cycle.length]
}

/** The first held Ctrl+Tab advances only when the stage is itself switchable. */
export function initialSwitcherChatId(
  items: readonly SwitcherItem[],
  activeId: string | null,
  step: 1 | -1,
): string | undefined {
  const first = items[0]
  if (first === undefined) return undefined
  if (activeId === null || !items.some((item) => item.chatId === activeId)) return first.chatId
  return cycleChatId(items.map((item) => item.chatId), activeId, step) ?? first.chatId
}

interface ChatSwitcherInput {
  /** What `buildSwitcherItems` returns, memoised by the caller. */
  items: readonly SwitcherItem[]
  /** The chat on the stage, or null while a draft is. Leftmost tile. */
  activeId: string | null
  openChat: (chatId: string) => void
}

/**
 * The macOS Cmd+Tab gesture, for chats. Ctrl+Tab opens the strip with the next
 * chat lit, further taps walk it, Shift walks it back, and releasing Ctrl opens
 * whatever is lit. Escape or a click outside cancels, so the strip only ever
 * exists while Ctrl is held and never takes focus from what is behind it.
 *
 * The items are frozen the moment the strip opens: a message landing mid-hold
 * re-sorts the activity tail, and a highlight that jumped tiles under a held
 * key would send you somewhere you never aimed at.
 */
export function useChatSwitcher({ items, activeId, openChat }: ChatSwitcherInput) {
  const [session, setSession] = useState<{
    items: readonly SwitcherItem[]
    highlightId: string
  } | null>(null)
  /**
   * Viewing order, most recent first. Tab-lifetime, like the composer's drafts:
   * after a reload the strip simply falls back to activity order until the first
   * switch seeds it.
   */
  const recentlyViewed = useRef<string[]>([])

  useEffect(() => {
    if (activeId === null) return
    recentlyViewed.current = [activeId, ...recentlyViewed.current.filter((id) => id !== activeId)]
  }, [activeId])

  const cancel = useCallback(() => setSession(null), [])

  const highlight = useCallback((chatId: string) => {
    setSession((current) => (current === null ? null : { ...current, highlightId: chatId }))
  }, [])

  const pick = useCallback(
    (chatId: string) => {
      setSession(null)
      openChat(chatId)
    },
    [openChat],
  )

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (session !== null && event.key === 'Escape') {
        event.preventDefault()
        setSession(null)
        return
      }
      if (event.key !== 'Tab' || !event.ctrlKey || event.metaKey || event.altKey) return
      // A control that claimed the key first, the search palette, a mention
      // popup, a dialog's focus trap, wins; the strip stays out of it.
      if (event.defaultPrevented) return
      event.preventDefault()
      const step = event.shiftKey ? -1 : 1
      if (session === null) {
        const ordered = orderSwitcherItems(items, recentlyViewed.current, activeId)
        const highlightId = initialSwitcherChatId(ordered, activeId, step)
        if (highlightId === undefined) return
        setSession({ items: ordered, highlightId })
        return
      }
      const next = cycleChatId(
        session.items.map((item) => item.chatId),
        session.highlightId,
        step,
      )
      if (next !== undefined) setSession({ ...session, highlightId: next })
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [session, items, activeId])

  // Committed on the release of Ctrl, not on the last Tab: the key going up is
  // the choice being made. A window blur cancels instead, because a release that
  // happened outside the window is not a choice at all. Landing back on the chat
  // that was already on the stage is a no-op rather than a redundant re-open.
  useEffect(() => {
    if (session === null) return
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key !== 'Control') return
      const target = session.highlightId
      setSession(null)
      if (target !== activeId) openChat(target)
    }
    const onBlur = () => setSession(null)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [session, activeId, openChat])

  return {
    open: session !== null,
    items: session?.items ?? [],
    highlightId: session?.highlightId ?? null,
    highlight,
    pick,
    cancel,
  }
}
