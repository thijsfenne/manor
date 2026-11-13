import type { ChatListRow, Inbox } from './state'

/** A chat a Browser tab can be opened in, labelled the way the sidebar names it. */
export interface CrossingTarget {
  chatId: string
  title: string
  /** The room, on project work; absent on a DM or group. */
  detail?: string
}

/** Past this the submenu stops being a glance and becomes a second sidebar. */
export const CROSSING_TARGET_LIMIT = 6

/**
 * The chats most recently active, newest first: DMs and groups from the chat list,
 * unsettled project work from the inbox. Pair threads are view-only, settled and
 * archived work is put away, and a DM nobody has opened has no chat to receive a tab.
 */
export function crossingTargets(rows: readonly ChatListRow[], inbox: Inbox, limit = CROSSING_TARGET_LIMIT): CrossingTarget[] {
  const candidates: (CrossingTarget & { at: number })[] = []
  for (const row of rows) {
    if (row.kind === 'pair' || row.chat === null) continue
    candidates.push({ chatId: row.chat.id, title: row.title, at: row.chat.lastMessageAt })
  }
  for (const entry of inbox.unsettled) {
    candidates.push({ chatId: entry.chat.id, title: entry.chat.title, detail: entry.projectName, at: entry.chat.lastMessageAt })
  }
  return candidates
    .sort((a, b) => b.at - a.at)
    .slice(0, limit)
    .map(({ at: _at, ...target }) => target)
}
