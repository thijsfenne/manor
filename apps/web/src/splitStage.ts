import type { Chat } from '@manor/contracts'
import { sidebarViewForChat, type SidebarView } from './useSidebar'

/**
 * Two conversations side by side. Focus is which pane is live; each pane owns a rail.
 * `view` is the sidebar list the split was made in, and the only one it shows under:
 * two sessions stay in Sessions, two DMs stay in Agents (decided 2026-10-11). A project
 * room is the one other pair: its thread on the left and a session it started on the
 * right, see `roomSplit`.
 */
export interface SplitStage {
  leftChatId: string | null
  rightChatId: string | null
  focus: 'left' | 'right'
  view: SidebarView
}

/**
 * What a split act does to the stored panes, and which threads the socket should
 * touch. `focusId` moves the stage; `loadId` asks for a snapshot without moving it.
 */
export interface SplitChange {
  split: SplitStage | null
  focusId: string | null
  loadId: string | null
}

export const SPLIT_MIN_PANE = 375
export const SPLIT_MIN_STAGE = SPLIT_MIN_PANE * 2
export const SPLIT_DEFAULT_RATIO = 0.5

/** Space a pane can share between its transcript and its panels. */
export function splitPaneContentWidth(stageWidth: number, ratio: number, side: 'left' | 'right') {
  return Math.max(0, stageWidth * (side === 'left' ? ratio : 1 - ratio))
}

/** Work inbox threads only. DMs, groups, pair and side chats stay one-up. */
export function isWorkChat(kind: Chat['kind']): boolean {
  return kind === 'project' || kind === 'run'
}

/**
 * What may share the stage with what (decided 2026-10-11): two sessions, or two DMs.
 * A project thread and the sessions it started belong to their room and pair with
 * nothing else, so `inRoom` takes them out; groups, pair and side chats stay one-up.
 */
export type SplitLane = 'work' | 'dm'

export function splitLane(kind: Chat['kind'], inRoom: boolean): SplitLane | null {
  if (inRoom) return null
  return isWorkChat(kind) ? 'work' : kind === 'dm' ? 'dm' : null
}

/** The lane a split made under this sidebar list holds. */
export const laneOfView = (view: SidebarView): SplitLane => (view === 'chats' ? 'dm' : 'work')

/** A project room: the thread on the left, the session it started on the right and live. */
export function roomSplit(threadChatId: string, sessionChatId: string): SplitStage {
  return { leftChatId: threadChatId, rightChatId: sessionChatId, focus: 'right', view: 'inbox' }
}

export function splitSideOf(split: SplitStage, chatId: string): 'left' | 'right' | null {
  return split.leftChatId === chatId ? 'left' : split.rightChatId === chatId ? 'right' : null
}

/**
 * The side a New session or dropped DM draft holds, after the draft or the split
 * changed. A DM draft keeps its pane while the Agents split it was dropped into exists
 * under this list, however narrow the window gets, so its first send can take that pane.
 * A project draft falls into the pane it was parked in when Sessions was left on it,
 * else into the focused pane of a Sessions split. `split` is never a project room:
 * a draft leaves the room for the whole stage.
 */
export function nextSplitDraftSide(
  current: 'left' | 'right' | null,
  draft: 'project' | 'dm' | null,
  split: SplitStage | null,
  sidebarView: SidebarView,
  parked: 'left' | 'right' | null = null,
): 'left' | 'right' | null {
  if (draft === null) return null
  if (draft === 'dm') return split !== null && split.view === sidebarView ? current : null
  return current ?? (split?.view === 'inbox' ? parked ?? split.focus : null)
}

/**
 * The pane a New session draft is remembered in while it is offstage. A draft that
 * ends on the Sessions stage itself (a row clicked, its first send) is done with its
 * pane; one left for another destination keeps it for the way back.
 */
export function parkDraftSide(
  parked: 'left' | 'right' | null,
  split: SplitStage | null,
  draft: 'project' | 'dm' | null,
  draftSide: 'left' | 'right' | null,
  onSessionsStage: boolean,
): 'left' | 'right' | null {
  if (split === null) return null
  if (draft === 'project') return draftSide ?? parked
  return draft === null && onSessionsStage ? null : parked
}

/**
 * Whether the stage may show `chat` under this sidebar list. A split only ever holds
 * chats of its own list, so the list alone decides.
 */
export function chatOnStage(chat: Pick<Chat, 'kind'>, sidebarView: SidebarView): boolean {
  return sidebarViewForChat(chat.kind) === sidebarView
}

export function splitAvailable(phone: boolean, stageWidth: number): boolean {
  return !phone && stageWidth >= SPLIT_MIN_STAGE
}

export function clampSplitRatio(ratio: number, stageWidth: number, minPane = SPLIT_MIN_PANE): number {
  if (!Number.isFinite(ratio)) return SPLIT_DEFAULT_RATIO
  if (stageWidth < minPane * 2) return SPLIT_DEFAULT_RATIO
  const min = minPane / stageWidth
  return Math.min(1 - min, Math.max(min, ratio))
}

export function focusedSplitChatId(split: SplitStage): string | null {
  return split.focus === 'left' ? split.leftChatId : split.rightChatId
}

/** Rows the sidebar paints as on stage. A new-session draft occupies its side, so that thread drops out. */
export function occupiedSplitIds(
  split: SplitStage,
  draftSide: 'left' | 'right' | null,
): readonly string[] {
  return [draftSide === 'left' ? null : split.leftChatId, draftSide === 'right' ? null : split.rightChatId]
    .filter((id): id is string => id !== null)
}

/** Settling a visible thread leaves its slot empty and focused. */
export function settleSplitChat(split: SplitStage, chatId: string, draftSide: 'left' | 'right' | null): SplitStage | null {
  if (split.leftChatId === chatId && draftSide !== 'left') return { ...split, leftChatId: null, focus: 'left' }
  if (split.rightChatId === chatId && draftSide !== 'right') return { ...split, rightChatId: null, focus: 'right' }
  return null
}

/** The new chat that grew out of a pane's draft takes that pane and its focus. */
export function replaceSplitPane(
  split: SplitStage,
  side: 'left' | 'right',
  chatId: string,
): SplitStage {
  return side === 'left'
    ? { ...split, leftChatId: chatId, focus: 'left' }
    : { ...split, rightChatId: chatId, focus: 'right' }
}

/**
 * The chat a New session draft becomes. Pending is set before the directory lists
 * it, so this stays null until that id is live. Open stands in when a snapshot
 * clears pending in the same frame the row arrives.
 */
export function bornSplitChatId(
  pendingChatId: string | null,
  openChatId: string | null,
  liveIds: ReadonlySet<string>,
): string | null {
  const bornId = pendingChatId ?? openChatId
  if (bornId === null || !liveIds.has(bornId)) return null
  return bornId
}

/**
 * Chat ids the socket should snapshot again after a reconnect. The focused
 * (pending or open) thread first, then the other pane if a split is up.
 */
export function splitResumeIds(
  openChatId: string | null,
  pendingChatId: string | null,
  split: SplitStage | null,
): string[] {
  const reopen = pendingChatId ?? openChatId
  const ids: string[] = []
  if (reopen !== null) ids.push(reopen)
  if (split === null) return ids
  for (const id of [split.leftChatId, split.rightChatId]) {
    if (id !== null && !ids.includes(id)) ids.push(id)
  }
  return ids
}

/**
 * The panes on screen whose thread nobody has asked for yet. Opening a chat asks only
 * for that chat, so a split that forms around it (a project room restored on its
 * session, a session row that opens its room) would leave the other pane on
 * "Loading…" until clicked. The stage's own chat is left to the open that set it, and
 * a thread already asked for in the background is waiting on its snapshot.
 */
export function unloadedSplitPanes(
  split: SplitStage | null,
  stageChatId: string | null,
  loaded: (chatId: string) => boolean,
  asked: ReadonlySet<string>,
): string[] {
  if (split === null) return []
  return [split.leftChatId, split.rightChatId].filter((id): id is string =>
    id !== null && id !== stageChatId && !loaded(id) && !asked.has(id))
}

/**
 * Puts `targetId` on the right of the open session or DM, or refuses into a plain open.
 * `split` is the free split on screen (never a project room); a new split belongs to
 * the sidebar list it was made in. Only a chat of the same lane may join: a session
 * beside a session, a DM beside a DM.
 */
export function openOnRight(
  split: SplitStage | null,
  openChatId: string | null,
  targetId: string,
  openLane: SplitLane | null,
  targetLane: SplitLane | null,
  view: SidebarView,
): SplitChange {
  const fits = targetLane !== null && (split !== null ? targetLane === laneOfView(split.view) : openChatId !== null && openLane === targetLane)
  if (!fits) {
    return { split: null, focusId: targetId, loadId: null }
  }
  if (openChatId === targetId) {
    return { split, focusId: targetId, loadId: null }
  }
  if (split !== null && split.leftChatId === targetId) {
    return { split: { ...split, focus: 'left' }, focusId: targetId, loadId: null }
  }
  if (split !== null && split.rightChatId === targetId) {
    return { split: { ...split, focus: 'right' }, focusId: targetId, loadId: null }
  }
  if (split !== null) {
    return {
      split: { ...split, rightChatId: targetId, focus: split.focus },
      focusId: null,
      loadId: targetId,
    }
  }
  return {
    split: { leftChatId: openChatId, rightChatId: targetId, focus: 'left', view },
    focusId: null,
    loadId: targetId,
  }
}

/**
 * A draft dropped beside the stage opens in the right pane: New session beside a
 * session, or a DM for an agent nobody has written to yet beside a DM. A split already
 * up keeps its panes, an empty right one included; otherwise the open chat goes left,
 * and with no chat on stage there is nothing to split.
 */
export function newSessionOnRight(
  split: SplitStage | null,
  openChatId: string | null,
  view: SidebarView = 'inbox',
): SplitStage | null {
  if (split !== null) return { ...split, focus: 'right' }
  return openChatId === null ? null : { leftChatId: openChatId, rightChatId: null, focus: 'right', view }
}

export function closeSplitPane(split: SplitStage, side: 'left' | 'right'): SplitChange {
  return {
    split: null,
    focusId: side === 'left' ? split.rightChatId : split.leftChatId,
    loadId: null,
  }
}

export function focusSplitPane(split: SplitStage, side: 'left' | 'right'): SplitChange {
  return {
    split: { ...split, focus: side },
    focusId: side === 'left' ? split.leftChatId : split.rightChatId,
    loadId: null,
  }
}

/**
 * Opening a chat from the sidebar, search or switcher while two free panes are up.
 * A chat already on stage is focused. A chat of the split's lane replaces the
 * focused pane: a session in a Sessions split, a DM in an Agents split. A chat from
 * the other list takes the whole stage and leaves the split parked for the next
 * visit to its list. Anything else from the split's own list (a group, a project
 * thread or a session of a room) would show under it, so that one drops the split.
 */
export function navigateSplit(split: SplitStage, chatId: string, lane: SplitLane | null, kind: Chat['kind']): SplitChange {
  if (chatId === split.leftChatId) {
    return { split: { ...split, focus: 'left' }, focusId: chatId, loadId: null }
  }
  if (chatId === split.rightChatId) {
    return { split: { ...split, focus: 'right' }, focusId: chatId, loadId: null }
  }
  if (sidebarViewForChat(kind) !== split.view) {
    return { split, focusId: chatId, loadId: null }
  }
  if (lane !== laneOfView(split.view)) {
    return { split: null, focusId: chatId, loadId: null }
  }
  if (split.focus === 'left') {
    return { split: { ...split, leftChatId: chatId }, focusId: chatId, loadId: null }
  }
  return { split: { ...split, rightChatId: chatId }, focusId: chatId, loadId: null }
}

/**
 * A deleted pane collapses the split onto whichever thread is still in the
 * directory. `arrivingId` is a chat the socket has named but the directory has
 * not listed yet, so a New session birth is not a missing pane.
 */
export function dropMissingSplit(
  split: SplitStage,
  liveIds: ReadonlySet<string>,
  arrivingId: string | null = null,
): SplitChange | null {
  const left = split.leftChatId === null || liveIds.has(split.leftChatId) || split.leftChatId === arrivingId
  const right = split.rightChatId === null || liveIds.has(split.rightChatId) || split.rightChatId === arrivingId
  if (left && right) return null
  if (left) return { split: null, focusId: split.leftChatId, loadId: null }
  if (right) return { split: null, focusId: split.rightChatId, loadId: null }
  return { split: null, focusId: null, loadId: null }
}
