import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import type { Chat } from '@manor/contracts'
import { useStableCallback } from './useStableCallback'
import {
  SPLIT_DEFAULT_RATIO,
  SPLIT_MIN_PANE,
  bornSplitChatId,
  clampSplitRatio,
  closeSplitPane,
  dropMissingSplit,
  focusSplitPane,
  laneOfView,
  navigateSplit,
  newSessionOnRight,
  nextSplitDraftSide,
  openOnRight,
  parkDraftSide,
  replaceSplitPane,
  roomSplit,
  settleSplitChat,
  splitAvailable,
  splitLane,
  splitResumeIds,
  splitSideOf,
  unloadedSplitPanes,
  type SplitLane,
  type SplitStage,
} from './splitStage'
import { setCollapsed, useCollapsed } from './chatCollapsed'
import type { WorkspaceView } from './components/Sidebar'
import { useSplitDrag, type SplitDragItem } from './components/SplitDrag'
import { chatOf, isProjectThread, projectSessionOverview, sessionThreadOf } from './state'
import { DOCK_PANEL_GAP } from './useRightPanel'
import type { NewChatDraft } from './useChatDialogs'
import { sidebarViewForChat, type SidebarView } from './useSidebar'
import type { Manor } from './useWorkspace'

type Side = 'left' | 'right'

const RATIO_KEY = 'manor:split-ratio'
const RESIZE_STEP = 0.04

function readRatio(): number {
  try {
    const stored = window.localStorage.getItem(RATIO_KEY)
    if (stored === null) return SPLIT_DEFAULT_RATIO
    const value = Number(stored)
    return Number.isFinite(value) ? value : SPLIT_DEFAULT_RATIO
  } catch {
    return SPLIT_DEFAULT_RATIO
  }
}

/**
 * How far the left work pane reaches across the stage. Remembered in this browser,
 * the same way the sidebar width is, and derived against the room that is left
 * after the sidebar and the rail have taken theirs.
 */
export function useSplitRatio(stageWidth: number) {
  const [asked, setAsked] = useState(readRatio)
  const [resizing, setResizing] = useState(false)
  const resizingRef = useRef(false)
  const resizeStart = useRef({ x: 0, ratio: SPLIT_DEFAULT_RATIO })
  const ratio = clampSplitRatio(asked, stageWidth)

  useEffect(() => {
    try {
      window.localStorage.setItem(RATIO_KEY, String(asked))
    } catch {
      // The current split still works when storage is unavailable, it just forgets.
    }
  }, [asked])

  useEffect(() => {
    if (!resizing) return
    const cursor = document.body.style.cursor
    const userSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    return () => {
      document.body.style.cursor = cursor
      document.body.style.userSelect = userSelect
    }
  }, [resizing])

  const resize = useCallback(
    (next: number) => {
      setAsked(clampSplitRatio(next, stageWidth))
    },
    [stageWidth],
  )

  const finishResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    resizingRef.current = false
    setResizing(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }, [])

  const onResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      resizeStart.current = { x: event.clientX, ratio }
      resizingRef.current = true
      setResizing(true)
    },
    [ratio],
  )

  const onResizePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!resizingRef.current || stageWidth <= 0) return
      resize(resizeStart.current.ratio + (event.clientX - resizeStart.current.x) / stageWidth)
    },
    [resize, stageWidth],
  )

  const onResizeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault()
        resize(ratio + (event.key === 'ArrowRight' ? RESIZE_STEP : -RESIZE_STEP))
        return
      }
      if (event.key !== 'Home' && event.key !== 'End') return
      event.preventDefault()
      resize(event.key === 'Home' ? SPLIT_MIN_PANE / Math.max(stageWidth, 1) : 1 - SPLIT_MIN_PANE / Math.max(stageWidth, 1))
    },
    [ratio, resize, stageWidth],
  )

  return {
    ratio,
    resizing,
    resizeProps: {
      role: 'separator' as const,
      'aria-label': 'Resize split threads',
      'aria-orientation': 'vertical' as const,
      'aria-valuemin': 0,
      'aria-valuemax': 100,
      'aria-valuenow': Math.round(ratio * 100),
      tabIndex: 0,
      title: 'Drag to resize. Double-click to reset.',
      onPointerDown: onResizePointerDown,
      onPointerMove: onResizePointerMove,
      onPointerUp: finishResize,
      onPointerCancel: finishResize,
      onLostPointerCapture: finishResize,
      onDoubleClick: () => resize(SPLIT_DEFAULT_RATIO),
      onKeyDown: onResizeKeyDown,
    },
  }
}

/**
 * The stage's split as stored and as shown. Two chats side by side under the list they
 * were made in, or a project room (decided 2026-10-11): the thread with a session it
 * started on the right. Called above the navigation, because which chat is open depends
 * on the split; `useSplitActions` below it holds what needs the navigation.
 */
export function useSplitStage(manor: Manor, phone: boolean, stageWidth: number, sidebarView: SidebarView) {
  const { workspace } = manor
  const [split, setSplit] = useState<SplitStage | null>(null)
  const [splitDraftSide, setSplitDraftSide] = useState<Side | null>(null)
  const canSplit = splitAvailable(phone, stageWidth)
  // A split shows under the list it was made in: Sessions, or Agents for two DMs.
  const visibleSplit = canSplit && split !== null && split.view === sidebarView ? split : null
  const ratio = useSplitRatio(stageWidth)

  /** A session the thread started opens only in its room, on the right; neither pairs with anything else. */
  const roomThreadOf = (chatId: string): string | undefined => sessionThreadOf(workspace, chatId)?.threadChatId
  const isRoomSplit = (stage: SplitStage | null): boolean =>
    stage !== null && stage.leftChatId !== null && isProjectThread(workspace, stage.leftChatId)
  const laneOf = (chat: Chat): SplitLane | null =>
    splitLane(chat.kind, isProjectThread(workspace, chat.id) || roomThreadOf(chat.id) !== undefined)
  // The split a draft may take a pane of: never the room, which a draft leaves.
  const freeSplit = isRoomSplit(split) ? null : split
  const roomUp = isRoomSplit(visibleSplit)

  /** Whether the stage showed chats on the last render; `useSplitActions` sets it once the view is known. */
  const chatStageShown = useRef(true)
  const openChatOnServer = useCallback(
    (chatId: string) => {
      setSplit((current) => {
        const chat = chatOf(workspace, chatId)
        if (chat === null) return current
        // A session the thread started opens in its room, on the right beside the thread.
        // Stored below the split floor too, so widening brings the room back around it.
        const thread = phone ? undefined : sessionThreadOf(workspace, chatId)?.threadChatId
        if (thread !== undefined) return roomSplit(thread, chatId)
        if (current === null) return current
        // A project thread opens on the left beside its overview, never into a pane of
        // another split. One already on the left is only focused there, unless its split
        // stood offstage: coming back is a new visit, which lands on the overview again.
        if (isProjectThread(workspace, chatId) && current.view === sidebarViewForChat(chat.kind) &&
          (current.leftChatId !== chatId || current.view !== sidebarView || !chatStageShown.current)) return null
        // Anything else from the room's own list leaves the room; another list parks it.
        if (current.leftChatId !== null && isProjectThread(workspace, current.leftChatId)) {
          if (current.leftChatId === chatId) return { ...current, focus: 'left' }
          return current.view === sidebarViewForChat(chat.kind) ? null : current
        }
        const lane = splitLane(chat.kind, isProjectThread(workspace, chatId))
        return navigateSplit(current, chatId, lane, chat.kind).split
      })
      manor.openChat(chatId)
    },
    [workspace.chats, workspace.projects, workspace.workHandoffs, sidebarView, phone, manor.openChat],
  )
  const inboxReturnId = split?.view === 'inbox' && split.leftChatId !== null && isProjectThread(workspace, split.leftChatId)
    ? split.leftChatId : null

  // Narrowed below the floor, a thread's split stays stored for widening but the thread
  // itself takes the stage, even when its session had the focus. A split parked offstage
  // is left as it was, so Back still returns to the focused session.
  const couldSplit = useRef(canSplit)
  useEffect(() => {
    const narrowed = couldSplit.current && !canSplit
    couldSplit.current = canSplit
    if (!narrowed || !chatStageShown.current || split === null || split.view !== sidebarView || split.focus !== 'right') return
    if (split.leftChatId !== null && isProjectThread(workspace, split.leftChatId)) openChatOnServer(split.leftChatId)
  }, [canSplit, split, sidebarView, workspace, openChatOnServer])

  /**
   * A chat settled while in a pane. Answers the thread's id when a session settled in its
   * room hands the sessions side back to the overview, true when the split closed the
   * pane itself, false when the caller should move on as usual.
   */
  // Stable across renders: navigation's settle handler closes over it, and a fresh one
  // per streamed token would redraw the sidebar and every chat pane that takes it.
  const settle = useStableCallback((chatId: string, drafting: boolean): string | boolean => {
    // Below the split floor, where the session stood alone, the thread takes the stage again.
    if (split !== null && split.rightChatId === chatId && split.leftChatId !== null && isProjectThread(workspace, split.leftChatId) &&
      (visibleSplit !== null || (workspace.pendingChatId ?? workspace.openChatId) === chatId)) {
      setSplit(null)
      setCollapsed(split.leftChatId, 'sessions-overview', false)
      return split.leftChatId
    }
    if (visibleSplit === null) return false
    const next = settleSplitChat(visibleSplit, chatId, drafting ? splitDraftSide : null)
    if (next === null) return false
    setSplit(next)
    manor.clearChat()
    return true
  })

  return {
    split, setSplit, splitDraftSide, setSplitDraftSide, canSplit, visibleSplit, freeSplit, roomUp, ratio,
    roomThreadOf, isRoomSplit, laneOf, chatStageShown, openChatOnServer, inboxReturnId, settle,
  }
}

/**
 * Everything that moves the split once the navigation exists: keeping it in step with
 * drafts and the chat list, focusing and closing panes, opening a chat or agent on the
 * right by click or drop, and the project room's sessions side.
 */
export function useSplitActions(
  stage: ReturnType<typeof useSplitStage>,
  {
    manor,
    sidebarView,
    activeView,
    open,
    newChatDraft,
    bornChatId,
    listedChatIds,
    browserPaneId,
    openChat,
    showChat,
    showEmptyChat,
    startChat,
    openDm,
    clearDraft,
    closeSidebarOverlay,
  }: {
    manor: Manor
    sidebarView: SidebarView
    activeView: WorkspaceView
    open: Chat | null
    newChatDraft: NewChatDraft | null
    bornChatId: string | null
    listedChatIds: ReadonlySet<string>
    /** The Browser place's session, kept resumable beside the split's chats. */
    browserPaneId: string | null
    openChat: (chatId: string) => void
    showChat: () => void
    showEmptyChat: () => void
    startChat: () => void
    openDm: (agentId: string, beside?: boolean) => void
    clearDraft: () => void
    closeSidebarOverlay: () => void
  },
) {
  const { workspace } = manor
  const {
    split, setSplit, splitDraftSide, setSplitDraftSide, canSplit, visibleSplit, freeSplit, roomUp,
    roomThreadOf, isRoomSplit, laneOf,
  } = stage
  const onChatStage = activeView === 'chat' || activeView === 'new-chat' || activeView === 'empty-chat'
  stage.chatStageShown.current = onChatStage

  /**
   * A project thread opens beside its session overview (decided 2026-10-10). Not a
   * split of two chats: the thread is the stage's one chat and the overview stands in
   * the right pane until a session it started takes it as the room split. Closing the
   * sessions side is remembered per thread, like the rail's panels (2026-10-15).
   */
  const threadOpen = open !== null && isProjectThread(workspace, open.id) ? open : null
  // The thread that owns the stage: alone, or as the left pane whichever side has focus.
  const stageThreadId = visibleSplit === null ? threadOpen?.id ?? null : roomUp ? visibleSplit.leftChatId : null
  const [overviewClosed] = useCollapsed(threadOpen?.id, 'sessions-overview')
  const overviewShown = canSplit && threadOpen !== null && visibleSplit === null && newChatDraft === null &&
    activeView === 'chat' && !overviewClosed
  const sessionOverview = useMemo(
    () => stageThreadId === null ? null : projectSessionOverview(workspace, stageThreadId),
    [stageThreadId, workspace.projects, workspace.chats, workspace.workHandoffs, workspace.activity, workspace.subagents, workspace.backgroundChatIds, workspace.houseSettings],
  )
  /** The stage holds two panes: two chats, or the thread beside its overview. */
  const paneSplit = visibleSplit !== null || overviewShown

  useEffect(() => {
    if (split === null) return
    const change = dropMissingSplit(split, listedChatIds, workspace.pendingChatId)
    if (change === null) return
    setSplit(change.split)
    if (sidebarView !== split.view) return
    if (change.focusId !== null) openChat(change.focusId)
    else {
      manor.clearChat()
      showEmptyChat()
    }
  }, [listedChatIds, split, openChat, sidebarView, workspace.pendingChatId, manor.clearChat, showEmptyChat])

  useEffect(() => {
    const resume = splitResumeIds(workspace.openChatId, workspace.pendingChatId, split)
    manor.setResumeChats(browserPaneId === null ? resume : [...resume, browserPaneId])
  }, [manor.setResumeChats, split, workspace.openChatId, workspace.pendingChatId, browserPaneId])

  // A joined string, so an effect keyed on it runs once per pane that turns up unasked.
  const unloadedPanes = unloadedSplitPanes(
    visibleSplit,
    workspace.pendingChatId ?? workspace.openChatId,
    (chatId) => workspace.threads[chatId]?.hasSnapshot === true,
    workspace.backgroundThreads,
  ).join(' ')
  useEffect(() => {
    for (const chatId of unloadedPanes.split(' ')) if (chatId !== '') manor.loadChat(chatId)
  }, [unloadedPanes, manor.loadChat])

  // The pane a New session draft held, kept while it is offstage so Sessions brings it
  // back there rather than into whichever pane was focused last.
  const parkedDraftSide = useRef<Side | null>(null)
  useEffect(() => {
    parkedDraftSide.current = parkDraftSide(
      parkedDraftSide.current,
      freeSplit,
      newChatDraft?.target.kind ?? null,
      splitDraftSide,
      sidebarView === 'inbox' && (activeView === 'chat' || activeView === 'empty-chat'),
    )
  }, [freeSplit, newChatDraft, splitDraftSide, sidebarView, activeView])

  useEffect(() => {
    setSplitDraftSide((current) =>
      nextSplitDraftSide(current, newChatDraft?.target.kind ?? null, freeSplit, sidebarView, parkedDraftSide.current))
  }, [newChatDraft, freeSplit, sidebarView])

  // A DM draft started from the Agents list has no pane in an Agents split, so it closes
  // it; any draft leaves a project room for the whole stage.
  const roomStored = isRoomSplit(split)
  useLayoutEffect(() => {
    if (newChatDraft === null) return
    if (roomStored || (newChatDraft.target.kind !== 'project' && split?.view === 'chats' && splitDraftSide === null)) {
      setSplit(null)
    }
  }, [newChatDraft, roomStored, split?.view, splitDraftSide])

  useEffect(() => {
    if (split === null || splitDraftSide === null) return
    const bornId = newChatDraft?.submitting
      ? bornSplitChatId(workspace.pendingChatId, workspace.openChatId, listedChatIds)
      : newChatDraft === null ? bornChatId : null
    if (bornId === null || !listedChatIds.has(bornId) || bornId === newChatDraft?.previousChatId) return
    setSplit((current) => {
      if (current === null) return current
      if (current.leftChatId === bornId || current.rightChatId === bornId) return current
      return replaceSplitPane(current, splitDraftSide, bornId)
    })
  }, [listedChatIds, split, splitDraftSide, workspace.openChatId, workspace.pendingChatId, newChatDraft, bornChatId])

  const focusSplitSide = useCallback(
    (side: Side) => {
      if (split === null) return
      const change = focusSplitPane(split, side)
      setSplit(change.split)
      if (splitDraftSide === side) return
      if (change.focusId === null) {
        manor.clearChat()
        showEmptyChat()
        return
      }
      showChat()
      if (change.focusId !== null && change.focusId !== open?.id) manor.openChat(change.focusId)
    },
    [manor.openChat, manor.clearChat, showChat, showEmptyChat, open?.id, split, splitDraftSide],
  )

  const openRight = useCallback(
    (chatId: string) => {
      const target = chatOf(workspace, chatId)
      // A session its thread started opens in its room, which `openChat` arranges.
      if (!canSplit || target === null || roomThreadOf(chatId) !== undefined) {
        openChat(chatId)
        return
      }
      const free = roomUp ? null : visibleSplit
      const change = openOnRight(
        free,
        roomUp ? null : open?.id ?? null,
        chatId,
        open === null ? null : laneOf(open),
        laneOf(target),
        sidebarView,
      )
      // A chat already in a pane is focused where it stands.
      const side = free === null || change.focusId === null ? null : splitSideOf(free, change.focusId)
      if (side !== null) {
        focusSplitSide(side)
        return
      }
      if (change.split === null) {
        openChat(chatId)
        return
      }
      setSplit(change.split)
      if (change.focusId !== null) openChat(change.focusId)
      else if (change.loadId !== null && workspace.threads[change.loadId]?.hasSnapshot !== true) {
        manor.loadChat(change.loadId)
      }
    },
    [canSplit, focusSplitSide, manor.loadChat, open, openChat, sidebarView, visibleSplit, workspace, roomUp],
  )
  // A pinned face whose DM is already in a pane focuses that pane, as its row would.
  const openPinnedDm = useCallback(
    (agentId: string) => {
      closeSidebarOverlay()
      const dm = workspace.chats.find((chat) => chat.kind === 'dm' && chat.memberIds[0] === agentId)
      const side = dm === undefined || visibleSplit === null ? null : splitSideOf(visibleSplit, dm.id)
      if (side !== null) focusSplitSide(side)
      else openDm(agentId)
    },
    [closeSidebarOverlay, focusSplitSide, openDm, visibleSplit, workspace.chats],
  )
  /**
   * What the stage takes a drop of (decided 2026-10-11): a session beside a session, a
   * DM beside a DM. A project room takes none, its right side belongs to its sessions.
   */
  const dropLane: SplitLane | null = !canSplit || newChatDraft !== null ? null
    : visibleSplit !== null ? (roomUp ? null : laneOfView(visibleSplit.view))
    : activeView !== 'empty-chat' && open !== null ? laneOf(open) : null
  // New session dropped beside the open session: its draft takes the right pane.
  const openNewSessionRight = () => {
    const next = newSessionOnRight(visibleSplit, open?.id ?? null)
    if (next === null) return
    setSplit(next)
    setSplitDraftSide('right')
    startChat()
  }
  // An agent dropped beside a DM: her DM, or a draft to her in the right pane.
  const openAgentRight = (agentId: string) => {
    const dm = workspace.chats.find((chat) => chat.kind === 'dm' && chat.memberIds[0] === agentId)
    if (dm !== undefined) {
      openRight(dm.id)
      return
    }
    const next = newSessionOnRight(visibleSplit, open?.id ?? null, sidebarView)
    if (next === null) {
      openDm(agentId)
      return
    }
    setSplit(next)
    setSplitDraftSide('right')
    openDm(agentId, true)
  }
  // Rows, pinned faces and New session drag onto the stage while a pane of their lane
  // could open beside it: a session or DM on stage, or a split with no draft in it yet.
  const splitDrag = useSplitDrag()
  /** The stage area a drop lands in, and the right pane it would open, for the drop preview. */
  const splitStage = useRef<HTMLDivElement>(null)
  const splitRightPane = useRef<HTMLDivElement>(null)
  const dragLane = (item: SplitDragItem): SplitLane | null => {
    if (item.kind === 'agent') return 'dm'
    if (item.kind === 'new') return 'work'
    const chat = chatOf(workspace, item.chatId)
    return chat === null ? null : laneOf(chat)
  }
  splitDrag.onDrop = (item) => {
    if (dragLane(item) !== dropLane) return
    if (item.kind === 'chat') openRight(item.chatId)
    else if (item.kind === 'agent') openAgentRight(item.agentId)
    else openNewSessionRight()
  }
  splitDrag.target = dropLane === null ? null : () => {
    const area = splitStage.current?.getBoundingClientRect()
    if (area === undefined) return null
    const pane = paneSplit ? splitRightPane.current?.getBoundingClientRect() : null
    const left = pane?.left ?? area.left + area.width / 2
    return {
      area,
      box: { left: left + DOCK_PANEL_GAP, top: area.top + DOCK_PANEL_GAP, width: area.right - left - 2 * DOCK_PANEL_GAP, height: area.height - 2 * DOCK_PANEL_GAP },
    }
  }
  // Only the sources of that lane can be picked up: the Sessions list for sessions,
  // the Agents list and the rail's faces for DMs.
  const sidebarGrab = dropLane !== null && dropLane === laneOfView(sidebarView) ? splitDrag.grab : null
  const railGrab = dropLane === 'dm' ? splitDrag.grab : null

  const closeSplitSide = useCallback(
    (side: Side) => {
      if (split === null) return
      if (splitDraftSide !== null && side === splitDraftSide) {
        const other = side === 'left' ? split.rightChatId : split.leftChatId
        clearDraft()
        setSplitDraftSide(null)
        setSplit(null)
        if (other !== null) openChat(other)
        else {
          manor.clearChat()
          showEmptyChat()
        }
        return
      }
      if (splitDraftSide !== null && side !== splitDraftSide) {
        // The draft stays alone on the stage. A split only holds its own list's chats,
        // so the list it stands under is already the one its chat will belong to.
        setSplit(null)
        return
      }
      const change = closeSplitPane(split, side)
      setSplit(change.split)
      if (change.focusId !== null) openChat(change.focusId)
      else {
        manor.clearChat()
        showEmptyChat()
      }
    },
    [clearDraft, openChat, split, splitDraftSide, manor.clearChat, showEmptyChat],
  )

  // Back to the thread's overview: whatever stands beside the thread leaves the right pane.
  const showOverview = () => {
    if (stageThreadId !== null) setCollapsed(stageThreadId, 'sessions-overview', false)
    if (roomUp) closeSplitSide('right')
  }
  // The sessions side's x: the overview, or a session on it, leaves and the thread stands alone.
  const closeSessionsSide = (threadChatId: string) => {
    setCollapsed(threadChatId, 'sessions-overview', true)
    if (roomUp) closeSplitSide('right')
  }

  return {
    onChatStage, stageThreadId, overviewShown, sessionOverview, paneSplit,
    focusSplitSide, openRight, openPinnedDm, closeSplitSide, showOverview, closeSessionsSide,
    dropLane, splitDrag, splitStage, splitRightPane, sidebarGrab, railGrab,
  }
}
