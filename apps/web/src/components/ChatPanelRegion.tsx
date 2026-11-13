import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ComponentPropsWithoutRef, type CSSProperties, type Dispatch, type RefObject, type SetStateAction } from 'react'
import { isOpenRoom, NOTE_AI_DEFAULTS, type Chat, type NoteQuote, type PageContextAttachment, type RepoFileApp } from '@manor/contracts'
import type { useWorkspace } from '../useWorkspace'
import { chatRoster } from '../chatRoster'
import { lastTurnSelectedMemoryPaths, messageTime } from '../messageMeta'
import { isProjectThread, participantIds, repoListingKey, roomOf, rowsOf, runtimeStartedAgentIds, sessionLiveOf, sessionReadyRow, subagentSummaryOf, threadOf, wholeRoster, workConfirmTitle, type TurnRow } from '../state'
import { runsByRoutine as groupRunsByRoutine } from '../routines'
import { desktopBrowser } from '../desktopBrowser'
import { useChatSide } from '../useChatSide'
import { BROWSER_EXPANDED_KEY, FILES_MIN_WIDTH, FILES_TREE_WIDTH, FILES_PREVIEW_MIN_WIDTH, rightPanelDefaultWidth, usePanelExpanded, useRightPanelSize } from '../useFilesPanel'
import { AGENTS_PANEL_WIDTH, CHAT_STAGE_MIN_WIDTH, DOCK_PANEL_GAP, LIST_PANEL_WIDTH, NO_PANELS, RIGHT_PANEL_MOTION_MS, TILE_MIN_WIDTH, clampedSplit, columnSizingPanel, keepPanels, layoutCount, layoutFromKey, layoutFull, layoutHas, layoutKey, rightPanelOverlays, rightRegionWidth, tileCardBox, tileRowSpan, tiledColumnWidths, useLingeringPanel, useRegionSettling, useTileSizes, type PanelDrop, type PanelLayout, type RightPanelId } from '../useRightPanel'
import { turnChangedFiles } from '../changedFiles'
import { turnDiffView } from '../diffView'
import { insertIntoDraft } from '../composerDrafts'
import { SessionSections } from './session/SessionSections'
import { SessionAgents } from './session/SessionAgents'
import { shownSubagents } from '../subagentLevels'
import { chatSubagents } from '../turnTrace'
import { DiffPanel, type DiffScope } from './session/DiffPanel'
import { chatHasRepo, sessionHandoffKey, waitingGoal } from '../sessionRepo'
import type { WorkResultActions } from './WorkResultBody'
import { BrowserPanel } from './BrowserPanel'
import { SideChatPanel } from './SideChatPanel'
import { AgentMemoryPanel } from './AgentMemoryPanel'
import { ProjectMemoryPanel } from './ProjectMemoryPanel'
import { ChatAgentsPanel } from './agents/ChatAgentsPanel'
import { DOCK_FLOAT, DOCK_FLOAT_TOP } from './ui/dockPanel'
import { TileHandle } from './TileHandle'
import { TileDropPreview, useTileDrag } from './TileDrag'

const FILES_COMPACT_ACTIONS_WIDTH = 360
const RepoFilesPanel = lazy(() => import('./RepoFilesPanel').then((module) => ({ default: module.RepoFilesPanel })))
const KnowledgePanel = lazy(() => import('./knowledge/KnowledgePanel').then((module) => ({ default: module.KnowledgePanel })))
const ChatRoutinesPanel = lazy(() => import('./routines/ChatRoutinesPanel').then((module) => ({ default: module.ChatRoutinesPanel })))
const RoutineRunsPanel = lazy(() => import('./routines/RoutineRunsPanel').then((module) => ({ default: module.RoutineRunsPanel })))

interface ChatPanelRegionProps {
  chat: Chat
  manor: ReturnType<typeof useWorkspace>
  /** The panels this chat has open, already narrowed to the ones it offers. */
  layout: PanelLayout
  availableWidth: number
  overlayResizable: boolean
  /** One panel floats over the transcript even where it could dock: a room session's Session panel (2026-10-11). */
  floating?: boolean
  phone: boolean
  focused: boolean
  ownsBrowserView: boolean
  instant: boolean
  browserBridge: ReturnType<typeof desktopBrowser>
  selectedFile: string | null
  setSelectedFiles: Dispatch<SetStateAction<Record<string, string | null>>>
  selectedNote: string | null
  setSelectedNotes: Dispatch<SetStateAction<Record<string, string | null>>>
  /** A note the ⌘K palette asked the docked Knowledge panel to open, see `KnowledgePanel`. */
  noteRequest?: { path: string; id: number } | null
  onNoteRequestHandled?: (id: number) => void
  pageContextCount: number
  onAddPageContext: (context: PageContextAttachment) => void
  onQuoteNote: (quote: NoteQuote) => void
  onAddNoteToSideChat?: (quote: NoteQuote) => void
  /** One panel's close. `shown` is the layout on screen, so the right one closes. */
  onClose: (id: RightPanelId, shown: PanelLayout) => void
  /** A tile dragged onto another, against the layout on screen. Absent where tiles stay put. */
  onMove?: (id: RightPanelId, target: RightPanelId, drop: PanelDrop, shown: PanelLayout) => void
  onFloat: (chatId: string) => void
  /** Copies a chat page into the Browser tab set. Absent without the desktop host. */
  onSendToBrowser?: (url: string) => Promise<void>
  onOpenBrowser?: () => void
  onOpenChat: (chatId: string) => void
  onOpenRoutine: (routineId: string) => void
  onOpenRoutines: () => void
  onDialogChange: (open: boolean) => void
  onEditGroup: () => void
  /** What the diff pane shows: the whole Session, or one turn. */
  diffScope: DiffScope
  onDiffScope: (scope: DiffScope) => void
  /** Opens or closes the diff beside the Session panel, against the layout on screen. */
  onToggleDiff: (shown: PanelLayout) => void
  /** Opens a file in this chat's Files panel. */
  onOpenFile: (path: string) => void
  /** The launch call ids of the subagent view open over this chat, down to the one on stage. */
  subagentPath: readonly string[]
  onOpenSubagent: (toolCallId: string) => void
}

/** Panel lifecycle and data belong to the thread, never to workspace focus. */
export function ChatPanelRegion({
  chat: open, manor, layout, availableWidth, overlayResizable, floating: floatAlways = false, phone, focused, ownsBrowserView, instant, browserBridge,
  selectedFile, setSelectedFiles, selectedNote, setSelectedNotes, pageContextCount, onAddPageContext,
  onQuoteNote, onAddNoteToSideChat, onClose, onMove, onFloat, onSendToBrowser, onOpenBrowser, onOpenChat, onOpenRoutine, onOpenRoutines,
  onDialogChange, onEditGroup, diffScope, onDiffScope, onToggleDiff, onOpenFile, subagentPath, onOpenSubagent,
  noteRequest, onNoteRequestHandled,
}: ChatPanelRegionProps) {
  const { workspace, status } = manor
  const thread = threadOf(workspace, open.id)
  const openProject = roomOf(workspace, open.projectId)
  const dmAgent = open.kind === 'dm' ? workspace.agents.find((agent) => agent.id === open.memberIds[0]) : undefined
  const activeAgentIds = useMemo(() => isOpenRoom(open) ? participantIds(thread) : open.memberIds, [open, thread])
  const startedAgentIds = useMemo(() => runtimeStartedAgentIds(thread), [thread.events, thread.liveTurns])
  const rosterAgents = useMemo(() => chatRoster(workspace.agents, open, activeAgentIds), [workspace.agents, open, activeAgentIds])
  const namedRoster = useMemo(() => wholeRoster(workspace), [workspace.agents])
  const chatRoutines = useMemo(() => workspace.routines.filter((routine) => routine.id === open.routineId), [workspace.routines, open.routineId])
  const routinesHere = useMemo(() => workspace.routines.filter((routine) => routine.chatId === open.id), [workspace.routines, open.id])
  const runsByRoutine = useMemo(() => groupRunsByRoutine(workspace.chats, workspace.routines), [workspace.chats, workspace.routines])
  const rows = useMemo(() => rowsOf(thread, open.kind), [thread, open.kind])
  const usedMemoryPaths = useMemo(() => new Set(lastTurnSelectedMemoryPaths(rows)), [rows])
  const hasRepo = chatHasRepo(workspace, open)
  const helpers = shownSubagents(
    open.id,
    chatSubagents(rows),
    subagentPath,
    (childId) => chatSubagents(rowsOf(threadOf(workspace, childId))),
  )
  // A DM lists none: helpers are Session work.
  const helperCount = open.kind === 'dm' ? 0 : helpers.shown.length
  const sessionRepo = workspace.sessionRepos[open.id]
  const running = thread.liveTurns.length > 0
  const waiting = waitingGoal(workspace, open)
  // Confirm in the diff says what it commits the way the card's Confirm does.
  const sessionLive = useMemo(() => sessionLiveOf(workspace), [workspace.activity, workspace.subagents, workspace.backgroundChatIds])
  // Gone while the Session works again, like its bar above the composer.
  const ready = useMemo(
    () => waiting === undefined ? undefined : sessionReadyRow(open, workspace.workHandoffs, workspace.chats, workspace.projects, workspace.agents, workspace.checkoutStatus, sessionLive),
    [waiting, open, workspace.workHandoffs, workspace.chats, workspace.projects, workspace.agents, workspace.checkoutStatus, sessionLive],
  )
  const confirmTitle = ready?.report === undefined ? undefined : workConfirmTitle(ready.report)
  const operation = ready?.report?.operation
  const goal = waiting === undefined || ready === undefined ? undefined : {
    ...waiting,
    ...(confirmTitle === undefined ? {} : { confirmTitle }),
    ...(operation === undefined ? {} : { operation }),
  }
  const filesProjectId = openProject?.id
  const filesChatId = open.id
  const filesListingKey = filesProjectId === undefined ? undefined : repoListingKey(filesProjectId, filesChatId)
  const fileListing = filesListingKey === undefined ? undefined : workspace.repoFiles[filesListingKey]
  const filePreview = filesListingKey === undefined ? undefined : workspace.repoFilePreviews[filesListingKey]
  const fileWrite = filesListingKey === undefined ? undefined : workspace.repoFileWrites[filesListingKey]
  const setSelectedFile = useCallback((path: string | null) => {
    setSelectedFiles((current) => ({ ...current, [filesChatId]: path }))
  }, [filesChatId, setSelectedFiles])
  const fileContext = `${filesProjectId}\0${openProject?.repoPaths.join('\0')}\0${status}`
  const previousFileContext = useRef(fileContext)
  useEffect(() => {
    if (previousFileContext.current !== fileContext) setSelectedFile(null)
    previousFileContext.current = fileContext
  }, [fileContext, setSelectedFile])
  const selectFile = useCallback((path: string) => {
    if (filesProjectId !== undefined && manor.readRepoFile(filesProjectId, path, filesChatId)) setSelectedFile(path)
  }, [filesProjectId, filesChatId, manor.readRepoFile, setSelectedFile])
  const saveFile = useCallback((path: string, content: string, baseRevision: string) => (
    filesProjectId !== undefined && manor.writeRepoFile(filesProjectId, path, content, baseRevision, filesChatId)
  ), [filesProjectId, filesChatId, manor.writeRepoFile])
  const openFileInApp = useCallback((path: string, app: RepoFileApp) => (
    filesProjectId !== undefined && manor.openRepoFile(filesProjectId, path, app, filesChatId)
  ), [filesProjectId, filesChatId, manor.openRepoFile])
  const clearFileWrite = useCallback(() => {
    if (filesProjectId !== undefined) manor.clearRepoWrite(filesProjectId, filesChatId)
  }, [filesProjectId, filesChatId, manor.clearRepoWrite])

  const setSelectedNote = useCallback((path: string | null) => {
    setSelectedNotes((current) => ({ ...current, [filesChatId]: path }))
  }, [filesChatId, setSelectedNotes])
  // A panel with nothing to show yet stays out of the layout rather than holding an
  // empty card in its slot.
  const shown = useMemo(() => keepPanels(layout, (id) => !(
    (id === 'agents' && rosterAgents.length === 0 && !hasRepo && helperCount === 0)
    || (id === 'runs' && chatRoutines.length === 0)
    || (id === 'routines' && dmAgent === undefined)
  )), [layout, rosterAgents.length, hasRepo, helperCount, chatRoutines.length, dmAgent])
  const shownKey = shown.length === 0 ? null : layoutKey(shown)

  // The Session's Changes and Branch are read while its panel or its diff is on screen:
  // on opening, after every finished turn, and whenever its result or checkout moves.
  const sessionShown = hasRepo && !phone && (layoutHas(shown, 'agents') || layoutHas(shown, 'diff'))
  const finishedTurns = useMemo(() => thread.events.reduce((count, event) =>
    count + (event.type === 'turn_result' || (event.type === 'system_note' && event.turnId !== undefined) ? 1 : 0), 0), [thread.events])
  const handoffKey = sessionHandoffKey(workspace, open)
  const live = status === 'live'
  const { askSessionRepo, askSessionDiff, askCheckoutStatus } = manor
  useEffect(() => {
    if (sessionShown && live) askSessionRepo(open.id)
  }, [sessionShown, live, open.id, finishedTurns, handoffKey, open.checkout.mode, open.checkout.branch, askSessionRepo])
  // A new status means the diff may have moved too, so the reader changes with it and
  // the pane reads again.
  const readDiff = useCallback((ignoreWhitespace: boolean) => {
    askSessionDiff(open.id, ignoreWhitespace)
  }, [askSessionDiff, open.id, sessionRepo])
  // A worktree Session merges into its linked folder's branch; Confirm needs it named.
  const needsMergeTarget = goal !== undefined && goal.mergeInto === undefined && open.checkout.mode === 'worktree'
  useEffect(() => {
    if (needsMergeTarget && live) askCheckoutStatus(open.id)
  }, [needsMergeTarget, live, open.id, askCheckoutStatus])
  const resultActions = useMemo<WorkResultActions>(() => ({
    requestEvents: manor.requestEvents,
    connected: live,
    accept: (handoffId, mergeInto, version, requestId) => manor.confirmWorkGoal(handoffId, mergeInto, version, requestId),
    revise: (handoffId, version, text, requestId) => manor.reviseWorkGoal(handoffId, version, text, requestId),
    retry: (handoffId, requestId) => manor.retryWorkCompletion(handoffId, requestId),
    approveFix: (handoffId, tip, requestId) => manor.approveMergeFix(handoffId, tip, requestId),
    askCheckout: askCheckoutStatus,
  }), [manor.requestEvents, live, manor.confirmWorkGoal, manor.reviseWorkGoal, manor.retryWorkCompletion, manor.approveMergeFix, askCheckoutStatus])
  // The turns the diff's Turns menu offers, newest first, named the way the transcript
  // names them: who answered, and when. A Single Session's voice is a model, not a
  // persona, so there it is the turn and its time.
  const diffTurns = useMemo(() => rows.flatMap((row) => {
    if (row.kind !== 'turn' || (row.fileChanges?.length ?? 0) === 0) return []
    const agent = workspace.agents.find((candidate) => candidate.id === row.agentId)
    const at = row.endedAt ?? row.startedAt
    return [{ turnId: row.turnId, ...(agent === undefined ? {} : { who: agent.name }), ...(at === undefined ? {} : { at: messageTime(at, Date.now()) }) }]
  }).reverse(), [rows, workspace.agents])
  // One turn's files, from the record that turn left in the transcript.
  const diffTurnId = diffScope.kind === 'turn' ? diffScope.turnId : undefined
  const diffTurnFiles = useMemo(() => {
    if (diffTurnId === undefined) return undefined
    const row = rows.find((candidate): candidate is TurnRow => candidate.kind === 'turn' && candidate.turnId === diffTurnId)
    if (row === undefined) return undefined
    const panelPaths = new Map((row.fileChanges ?? []).flatMap((change) => change.panelPath === undefined ? [] : [[change.path, change.panelPath] as const]))
    return turnDiffView(turnChangedFiles(row, fileListing?.files), panelPaths)
  }, [diffTurnId, rows, fileListing?.files])
  const browserShown = layoutHas(shown, 'browser')
  const { sideChatId, sideRuntime, setSideRuntime, sendSideMessage, clearSideChat } = useChatSide({
    parentChatId: open.id,
    shown: layoutHas(shown, 'side'),
    live: status === 'live',
    workspace,
    openSideChat: manor.openSideChat,
    setSideRuntimeOnServer: manor.setSideRuntime,
    sendSideMessageOnServer: manor.sendSideMessage,
  })
  const filesExpand = usePanelExpanded('manor:files-expanded')
  const knowledgeExpand = usePanelExpanded('manor:knowledge-expanded')
  const browserExpand = usePanelExpanded(BROWSER_EXPANDED_KEY, open.id)
  const renderedKey = useLingeringPanel(shownKey, RIGHT_PANEL_MOTION_MS, instant)
  const rendered = useMemo(() => (renderedKey === null ? NO_PANELS : layoutFromKey(renderedKey)), [renderedKey])
  // A change from some panels to other panels is not a movement, and neither is a
  // panel going full screen or back: only opening and closing the region animates.
  // Tracked during render so the change's own frame has no transition.
  const [lastKey, setLastKey] = useState(shownKey)
  const [swapped, setSwapped] = useState(false)
  if (shownKey !== lastKey) {
    setSwapped(lastKey !== null && shownKey !== null)
    setLastKey(shownKey)
  }
  const expandKey = `${filesExpand.expanded}|${knowledgeExpand.expanded}|${browserExpand.expanded}`
  const [lastExpandKey, setLastExpandKey] = useState(expandKey)
  if (expandKey !== lastExpandKey) {
    setSwapped(true)
    setLastExpandKey(expandKey)
  }
  const regionSettling = useRegionSettling(shownKey, swapped ? 0 : RIGHT_PANEL_MOTION_MS)
  const tiled = layoutCount(rendered) > 1
  const revealed = shownKey !== null && shownKey === renderedKey

  // One panel keeps its own sizing: a drag handle, an expand that asks for no room,
  // an overlay of its own when the chat is too narrow to dock it.
  const openPanel = !tiled && shown.length > 0 ? shown[0]![0]! : null
  const renderedPanel = !tiled && rendered.length > 0 ? rendered[0]![0]! : null
  // Each panel keeps its own width in this chat. Tiled, the first column wears the
  // width of the panel it is there to read.
  const sizingPanel = tiled ? columnSizingPanel(rendered[0]!) : openPanel ?? renderedPanel ?? 'files'
  const panelSize = useRightPanelSize(open.id, sizingPanel, availableWidth, overlayResizable)
  const expandedPanels = { files: filesExpand.expanded, knowledge: knowledgeExpand.expanded, browser: browserExpand.expanded }
  const renderedPanelWidth = rightRegionWidth(renderedPanel, panelSize.width, expandedPanels)
  const openPanelWidth = rightRegionWidth(openPanel, panelSize.width, expandedPanels)

  // Several panels share the room as columns. Each column is a track, so a panel
  // keeps its place in the grid, and its mounted state, when a neighbour comes or goes.
  // The first column is its panel's own width, so closing down to that panel keeps the
  // edge put; the second is its own, until dragged a start from what it holds.
  const tileSizes = useTileSizes(open.id)
  const [tileResizing, setTileResizing] = useState(false)
  // A split is kept as a share, so a window made shorter could leave a stacked panel
  // below its floor. What is drawn and dragged is the share clamped to the height the
  // column has now; the stored one comes back once there is room for it again.
  const tilesBox = useRef<HTMLDivElement>(null)
  const tilesHeight = useBoxHeight(tilesBox)
  const splits = tileSizes.sizes.splits.map((share) => (tilesHeight > 0 ? clampedSplit(share, tilesHeight) : share))
  const firstColumn = Math.max(TILE_MIN_WIDTH, panelSize.chosenWidth)
  const askedWidths = (layout: PanelLayout) => layout.map((column, index) => (
    index === 0 ? firstColumn : tileSizes.sizes.second ?? rightPanelDefaultWidth(columnSizingPanel(column))
  ))
  const tiles = tiledColumnWidths(askedWidths(rendered), availableWidth)
  const shownTiles = tiledColumnWidths(askedWidths(shown), availableWidth)
  const tilesWidth = tiles.widths.reduce((sum, width) => sum + width, 0)

  const panelOverlay = tiled ? tiles.overlay : floatAlways || rightPanelOverlays(availableWidth, 0, renderedPanelWidth)
  // A floating panel may overlap the transcript, but pinning navigation may never
  // collapse the transcript's own layout below its 375px floor.
  // A panel that always floats takes no width from the transcript at all.
  const regionWidth = shownKey === null || (floatAlways && !tiled)
    ? 0
    : panelOverlay
      ? Math.max(0, availableWidth - CHAT_STAGE_MIN_WIDTH)
      : layoutCount(shown) > 1 ? shownTiles.widths.reduce((sum, width) => sum + width, 0) : openPanelWidth
  const singleContentWidth = Math.min(
    panelSize.width - DOCK_PANEL_GAP,
    panelOverlay
      ? Math.max(FILES_MIN_WIDTH - DOCK_PANEL_GAP, availableWidth - CHAT_STAGE_MIN_WIDTH)
      : availableWidth - 2 * DOCK_PANEL_GAP,
  )

  const cells = rendered.flatMap((column, columnIndex) => column.map((id, slot) => ({
    id,
    column: columnIndex,
    // A column holding one panel gives it the full height.
    slot: column.length === 1 ? 'whole' as const : slot === 0 ? 'top' as const : 'bottom' as const,
    width: tiles.widths[columnIndex] ?? 0,
  })))

  /**
   * Every resize starts from what is on screen, so a squeezed column is dragged from
   * where it is drawn rather than from a width it never got. The first column's edge
   * is the region's own, next to the chat, and may not take the chat below its floor.
   */
  const grabEdge = () => {
    const start = tiles.widths
    const others = start.slice(1).reduce((sum, width) => sum + width, 0)
    const room = tiles.overlay ? availableWidth - DOCK_PANEL_GAP : availableWidth - CHAT_STAGE_MIN_WIDTH
    return (delta: number) => {
      // The edge is on the left, so dragging left widens.
      panelSize.setChosenWidth(Math.round(Math.min(Math.max(TILE_MIN_WIDTH, room - others), Math.max(TILE_MIN_WIDTH, start[0]! - delta))))
      if (start.length > 1) tileSizes.setSecond(start[1]!)
    }
  }
  const grabDivider = () => {
    const [first = 0, second = 0] = tiles.widths
    return (delta: number) => {
      const next = Math.round(Math.min(first + second - TILE_MIN_WIDTH, Math.max(TILE_MIN_WIDTH, first + delta)))
      panelSize.setChosenWidth(next)
      tileSizes.setSecond(first + second - next)
    }
  }
  const grabSplit = (column: number) => (handle: HTMLElement) => {
    const height = handle.parentElement?.getBoundingClientRect().height ?? 0
    const start = splits[column] ?? 0.5
    return (delta: number) => tileSizes.setSplit(column, clampedSplit(start + (height > 0 ? delta / height : 0), height))
  }

  // The tile an expand has put over the whole stage. Expanded panels share one layer,
  // so with two expanded at once (the choice is remembered per panel, not per chat)
  // the later one in the tree is the one on top.
  const expandedTile = tiled
    ? [...cells].reverse().find((cell) => (cell.id === 'files' || cell.id === 'knowledge' || cell.id === 'browser') && expandedPanels[cell.id])?.id ?? null
    : null
  // The desktop page sits above every DOM layer, so under another tile's expand it
  // steps out rather than taking the clicks meant for the document. Its tabs stay.
  const browserPageVisible = ownsBrowserView && (expandedTile === null || expandedTile === 'browser')
  const floating = panelOverlay && expandedTile === null
  // Tiles rearrange only when there are tiles and all of them are in view: an
  // expanded one covers the others, and the phone never has more than one.
  const tileDrag = useTileDrag({
    layout: shown,
    enabled: onMove !== undefined && !phone && tiled && layoutCount(shown) > 1 && expandedTile === null,
    onMove: (id, target, drop) => onMove?.(id, target, drop, shown),
    // Where the grid will be once the move lands, from the same sizing the render uses.
    // It keeps the region's right edge; a move that makes the row float or dock again
    // also moves its top, since a floating row hangs below the chat header.
    place: (next, id) => {
      const grid = tilesBox.current
      const region = grid?.parentElement
      if (!grid || !region) return null
      const { widths, overlay } = tiledColumnWidths(askedWidths(next), availableWidth)
      const { right, top: regionTop, bottom } = region.getBoundingClientRect()
      const top = regionTop + (overlay ? DOCK_FLOAT_TOP : 0)
      const height = bottom - top
      const nextSplits = tileSizes.sizes.splits.map((share) => clampedSplit(share, height))
      const card = tileCardBox(next, id, widths, nextSplits, height, DOCK_PANEL_GAP)
      if (card === null) return null
      // A card in the part of a floating row scrolled out of view shows only its visible part.
      const row = tileRowSpan(widths, overlay, availableWidth, grid.scrollLeft, DOCK_PANEL_GAP)
      const left = Math.max(right - row.start + card.left, right - row.box)
      const width = Math.min(right - row.start + card.left + card.width, right) - left
      return width > 0 ? { ...card, left, width, top: top + card.top } : null
    },
  })

  // ⌘S and Knowledge's `/` listen on the window, so with Files and Knowledge both open
  // only one holds them: an expanded editor, else the one last clicked or focused, else
  // Files. An expanded Browser covers both, so neither does.
  const [workingEditor, setWorkingEditor] = useState<'files' | 'knowledge' | null>(null)
  const editors = (['files', 'knowledge'] as const).filter((id) => layoutHas(shown, id))
  const keysOwner = expandedTile === 'files' || expandedTile === 'knowledge' ? expandedTile
    : expandedTile !== null ? null
    : workingEditor !== null && editors.includes(workingEditor) ? workingEditor : editors[0] ?? null
  const markWorking = (id: RightPanelId) => {
    if (id === 'files' || id === 'knowledge') setWorkingEditor(id)
  }

  /**
   * What one panel gets from the layout. A tile has its column's width and no handle
   * of its own: the columns share the room between them, so dragging one edge would
   * move every other. The row reveals as one when it floats, so no tile does.
   */
  const dockFor = (width: number) => tiled ? {
    width,
    contentWidth: width - DOCK_PANEL_GAP,
    overlay: false,
    revealed: true,
    resizing: false,
    resizeProps: TILE_NO_RESIZE,
  } : {
    width: panelSize.width,
    contentWidth: singleContentWidth,
    overlay: panelOverlay,
    revealed,
    resizing: panelSize.resizing,
    resizeProps: panelSize.resizeProps,
  }

  const renderPanel = (id: RightPanelId, width: number) => {
    const dock = dockFor(width)
    const close = () => onClose(id, shown)
    if (id === 'files') return (
      <RepoFilesPanel
        memoryKey={open.id}
        files={fileListing?.files}
        truncated={fileListing?.truncated}
        selectedPath={selectedFile}
        preview={filePreview}
        write={fileWrite}
        apps={manor.repoFileApps}
        canEdit={status === 'live'}
        shortcutsActive={focused && keysOwner === 'files'}
        width={dock.width}
        compact={dock.contentWidth < FILES_TREE_WIDTH + FILES_PREVIEW_MIN_WIDTH}
        compactActions={dock.contentWidth < FILES_COMPACT_ACTIONS_WIDTH}
        expanded={filesExpand.expanded}
        overlay={dock.overlay}
        revealed={dock.revealed}
        resizing={dock.resizing}
        resizeProps={dock.resizeProps}
        onToggleExpanded={filesExpand.toggleExpanded}
        onSelect={selectFile}
        onClearSelection={() => setSelectedFile(null)}
        onSave={saveFile}
        onOpenInApp={openFileInApp}
        onClearWrite={clearFileWrite}
        onClose={() => {
          close()
          setSelectedFile(null)
        }}
      />
    )
    if (id === 'knowledge') return (
      <KnowledgePanel
        vault={workspace.vault}
        status={status}
        memoryKey={open.id}
        selectedPath={selectedNote}
        onRememberPath={setSelectedNote}
        {...(noteRequest === undefined ? {} : { openRequest: noteRequest })}
        {...(onNoteRequestHandled === undefined ? {} : { onOpenRequestHandled: onNoteRequestHandled })}
        dock={{
          width: dock.width,
          compact: dock.contentWidth < FILES_TREE_WIDTH + FILES_PREVIEW_MIN_WIDTH,
          expanded: knowledgeExpand.expanded,
          overlay: dock.overlay,
          revealed: dock.revealed,
          resizing: dock.resizing,
          resizeProps: dock.resizeProps,
          onToggleExpanded: knowledgeExpand.toggleExpanded,
          shortcutsActive: focused && keysOwner === 'knowledge',
          onClosePanel: () => {
            close()
            setSelectedNote(null)
          },
        }}
        onList={manor.listVault}
          onCreateFolder={manor.createVaultFolder}
          onDelete={manor.deleteVaultEntry}
          onRename={manor.renameVaultFile}
          onMove={manor.moveVaultEntry}
        onOpen={manor.readVaultFile}
        onSave={manor.writeVaultFile}
        onClearWrite={manor.clearVaultWrite}
        onEditNote={manor.editVaultNote}
        onForgetNoteEdit={manor.forgetVaultNoteEdit}
        noteAiModel={workspace.houseSettings?.noteAiModel ?? NOTE_AI_DEFAULTS.model}
        onClose={manor.closeVaultNote}
        onQuote={onQuoteNote}
        onAddToSideChat={onAddNoteToSideChat}
      />
    )
    if (id === 'browser') return (
      <BrowserPanel
        chatId={open.id}
        bridge={browserBridge}
        activity={manor.browserActivity[open.id]}
        pageContextCount={pageContextCount}
        onAddPageContext={(context) => onAddPageContext(context)}
        shown={browserShown}
        pageVisible={browserPageVisible}
        settling={regionSettling}
        placeKey={shownKey ?? ''}
        {...(manor.externalBrowser === null ? {} : { onOpenExternal: manor.openExternalUrl })}
        width={dock.width}
        expanded={browserExpand.expanded}
        overlay={dock.overlay}
        revealed={dock.revealed}
        resizing={dock.resizing}
        resizeProps={dock.resizeProps}
        onFloat={() => {
          onFloat(open.id)
          close()
        }}
        onToggleExpanded={browserExpand.toggleExpanded}
        onClose={close}
        {...(onSendToBrowser === undefined ? {} : { onSendToBrowser })}
        {...(onOpenBrowser === undefined ? {} : { onOpenBrowser })}
      />
    )
    if (id === 'side') return (
      <SideChatPanel
        agents={namedRoster}
        runtime={sideRuntime}
        onRuntimeChange={setSideRuntime}
        parentChatId={open.id}
        chatId={sideChatId}
        onClear={clearSideChat}
        connected={status === 'live'}
        width={dock.width}
        overlay={dock.overlay}
        revealed={dock.revealed}
        resizing={dock.resizing}
        resizeProps={dock.resizeProps}
        onSend={sendSideMessage}
        onStop={manor.stopTurn}
        onAnswer={
          sideChatId === null
            ? undefined
            : (requestId, answers) => manor.answerUserInput(sideChatId, requestId, answers)
        }
        onRetry={() => manor.openSideChat(open.id)}
        onClose={close}
      />
    )
    if (id === 'memory' && open.kind === 'dm') return (
      <AgentMemoryPanel
        chatId={open.id}
        status={status}
        requestEvents={manor.requestEvents}
        onLoad={manor.getChatSummary}
        overlay={dock.overlay}
        revealed={dock.revealed}
        phone={phone}
        width={dock.width}
        resizing={dock.resizing}
        resizeProps={dock.resizeProps}
        onClose={close}
      />
    )
    if (id === 'memory' && openProject !== undefined) return (
      <ProjectMemoryPanel
        key={openProject.id}
        projectId={openProject.id}
        status={status}
        requestEvents={manor.requestEvents}
        onLoad={manor.getProjectMemory}
        overlay={dock.overlay}
        revealed={dock.revealed}
        phone={phone}
        width={dock.width}
        resizing={dock.resizing}
        resizeProps={dock.resizeProps}
        usedPaths={usedMemoryPaths}
        {...(workspace.contextFiles === null ? {} : { userFiles: workspace.contextFiles.files })}
        onLoadUserFiles={manor.requestContextFiles}
        memoryScope={openProject.memoryScope === 'knowledge' ? 'knowledge' : 'project'}
        {...(isProjectThread(workspace, open.id) ? { summaryChatId: open.id, onLoadSummary: manor.getChatSummary } : {})}
        onClose={close}
      />
    )
    if (id === 'routines' && dmAgent !== undefined) return (
      <ChatRoutinesPanel
        chatId={open.id}
        agentId={dmAgent.id}
        routines={routinesHere}
        loaded={workspace.hasRoutines}
        histories={workspace.routineHistories}
        projects={workspace.projects}
        chats={workspace.chats}
        // The real roster, not `namedRoster`: that one carries the side chat's
        // synthetic voice for naming a transcript, and offering it as a routine's
        // persona would build a routine the server refuses to save.
        agents={workspace.agents}
        // Never blanked while a dialog is open, the way the agents card's is: the
        // dialog is the surface a refused save has to be readable on.
        notice={workspace.notice}
        requestEvents={manor.requestEvents}
        width={tiled ? dock.width : LIST_PANEL_WIDTH}
        overlay={dock.overlay}
        revealed={dock.revealed}
        onRequestHistory={manor.getRoutineRuns}
        onSave={manor.saveRoutine}
        onDelete={manor.deleteRoutine}
        onSetEnabled={manor.setRoutineEnabled}
        onRunNow={manor.runRoutineNow}
        onDismissNotice={manor.dismissNotice}
        onDialogChange={onDialogChange}
        onClose={close}
      />
    )
    if (id === 'runs' && chatRoutines[0] !== undefined) return (
      <RoutineRunsPanel
        routine={chatRoutines[0]}
        runs={runsByRoutine[chatRoutines[0].id] ?? []}
        selectedRunId={open.id}
        width={tiled ? dock.width : LIST_PANEL_WIDTH}
        overlay={dock.overlay}
        revealed={dock.revealed}
        onOpenRun={onOpenChat}
        onOpenRoutine={onOpenRoutine}
        onClose={close}
      />
    )
    if (id === 'diff') return (
      <DiffPanel
        hasSession={hasRepo}
        {...(sessionRepo === undefined || sessionRepo.error !== undefined ? {} : { sessionChanges: sessionRepo.changes })}
        scope={diffScope}
        turns={diffTurns}
        onScope={onDiffScope}
        sessionDiff={workspace.sessionDiffs[open.id]}
        onRead={readDiff}
        turnFiles={diffTurnFiles}
        {...(goal === undefined ? {} : { goal })}
        actions={resultActions}
        width={dock.width}
        overlay={dock.overlay}
        revealed={dock.revealed}
        resizing={dock.resizing}
        resizeProps={dock.resizeProps}
        onClose={close}
        {...(filesProjectId === undefined ? {} : { onOpenFile })}
        onReference={(panelPath) => insertIntoDraft(open.id, `@${panelPath} `)}
      />
    )
    if (id === 'agents') return (
      <div
        className={phone
          ? 'absolute inset-0 z-[8] min-h-0 min-w-0 bg-bg p-3 pt-[max(12px,env(safe-area-inset-top))] pb-[max(12px,env(safe-area-inset-bottom))]'
          : `${dock.overlay ? `dock-panel-reveal ${DOCK_FLOAT} max-w-full` : ''} ${tiled ? 'grid' : ''} min-h-0 min-w-0 py-2 pr-2`}
        style={{ width: phone ? '100%' : tiled ? dock.width : AGENTS_PANEL_WIDTH }}
        data-open={dock.overlay ? dock.revealed : undefined}
      >
        <ChatAgentsPanel
          agents={rosterAgents}
          activeAgentIds={activeAgentIds}
          startedAgentIds={startedAgentIds}
          overrides={thread.overrides}
          canEdit={status === 'live'}
          // Alone it is a card the height of its roster; beside other panels it is a
          // column like theirs.
          fill={tiled}
          onChange={(agentId, override) => manor.setChatOverride(agentId, override, open.id)}
          // What posts into this chat without anybody sending it. Read-only
          // here: the row is a door to the house-wide view, never a second
          // editor of a schedule that outlives this chat.
          routines={chatRoutines}
          onOpenRoutines={onOpenRoutines}
          onClose={close}
          {...(!hasRepo || phone ? {} : {
            sessionSections: (
              <SessionSections
                repo={sessionRepo}
                diffOpen={layoutHas(shown, 'diff')}
                diffBlocked={layoutFull(shown)}
                running={running}
                connected={live}
                commits={workspace.sessionCommits}
                commitFailures={workspace.sessionCommitFailures[open.id]}
                pushedLinks={workspace.sessionPushedLinks[open.id]}
                requestEvents={manor.requestEvents}
                onToggleDiff={() => {
                  // Changes always opens on the whole Session; a turn is opened from its card.
                  if (!layoutHas(shown, 'diff')) onDiffScope({ kind: 'session' })
                  onToggleDiff(shown)
                }}
                onRetry={() => askSessionRepo(open.id)}
                openApps={manor.repoFileApps}
                onOpenFolder={(root, app) => manor.openSessionFolder(open.id, root, app)}
                onCommit={(root, files, message, requestId) => manor.commitSession(open.id, root, files, message, requestId)}
                onPush={(root, requestId) => manor.pushSession(open.id, root, requestId)}
              />
            ),
          })}
          {...(open.kind === 'group'
            ? { onEditMembers: onEditGroup }
            : {})}
          {...(helperCount === 0 ? {} : {
            agentsSection: (
              <SessionAgents
                subagents={helpers.shown}
                summary={(childId) => subagentSummaryOf(workspace, childId)}
                onOpen={onOpenSubagent}
                onStop={(toolCallId) => manor.stopSubagent(helpers.levelChildId ?? open.id, toolCallId)}
              />
            ),
          })}
          phone={phone}
        />
      </div>
    )
    return null
  }

  return (
    <div
      data-chat-panel-region=""
      className={`grid min-h-0 min-w-0 w-[var(--region-width)] grid-rows-[minmax(0,1fr)] ease-out ${
        // A drag has to keep up with the pointer, so the width follows it directly,
        // and a chat switch is not a movement at all: no class on that render means
        // the new width is simply the width it opens at.
        panelSize.resizing || tileResizing || instant || swapped
          ? ''
          : 'duration-200 motion-safe:transition-[width]'
      }`}
      style={{ '--region-width': `${regionWidth}px` } as CSSProperties}
    >
      {/* One tree for one panel and for several: alone, the grid and its cells step
          out of the box model and the panel sits in the region as it always has, so
          the panel that was open is the same mounted panel once a second one joins. */}
      <div
        ref={tilesBox}
        data-panel-tiles={tiled ? '' : undefined}
        className={tiled
          ? `grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)] ${
              // Floating, the row is one sheet with a gutter of its own, so the chat
              // does not show through between its cards. An expanded tile takes the
              // row out of floating: positioned, the row would be the box its expand
              // fills, so the document would stay a row wide under the header.
              floating ? `dock-panel-reveal ${DOCK_FLOAT} max-w-full overflow-x-auto bg-bg pl-2` : ''
            }`
          : 'contents'}
        style={tiled ? {
          gridTemplateColumns: tiles.widths.map((width) => `${width}px`).join(' '),
          ...(floating ? { width: Math.min(tilesWidth + DOCK_PANEL_GAP, availableWidth) } : {}),
        } : undefined}
        data-open={tiled && floating ? revealed : undefined}
      >
        {cells.map((cell) => (
          <div
            // By id, never by slot: a panel that moves up when the one above it closes
            // is the same panel, with its file, its page and its draft still in it.
            key={cell.id}
            // Under an expand the other tiles step out of sight: a row too wide for the
            // room would otherwise show an edge in the expanded panel's gutter.
            className={tiled
              ? `grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)] transition-opacity duration-200 ${
                  expandedTile !== null && cell.id !== expandedTile ? 'invisible' : ''
                } ${tileDrag.dragging === cell.id ? 'opacity-40' : ''}`
              : 'contents'}
            style={tiled ? { gridColumn: cell.column + 1, gridRow: 1, ...slotStyle(cell.slot, splits[cell.column] ?? 0.5) } : undefined}
            ref={tileDrag.cellRef(cell.id)}
            onPointerDownCapture={(event) => {
              markWorking(cell.id)
              tileDrag.grab(cell.id, event)
            }}
            onFocusCapture={() => markWorking(cell.id)}
          >
            <Suspense fallback={<div className="min-h-0 min-w-0 p-5 text-dim">Loading panel…</div>}>
              {renderPanel(cell.id, cell.width)}
            </Suspense>
          </div>
        ))}
        {/* The handles ride over each column in a layer of their own, never inside a
            cell: a positioned cell would be the box an expanded panel fills. */}
        {!tiled || expandedTile !== null ? null : rendered.map((column, index) => (
          <div key={`handles:${index}`} className="pointer-events-none relative z-[1] min-h-0 min-w-0"
            style={{ gridColumn: index + 1, gridRow: 1 }}>
            <TileHandle
              axis="x"
              label={index === 0 ? 'Resize panels' : 'Resize panel columns'}
              // Centred on the gutter it sits in: the chat's edge for the first column,
              // the 8px between two cards for the second.
              className={`inset-y-2 ${index === 0 ? '-left-1' : '-left-2'}`}
              grab={index === 0 ? grabEdge : grabDivider}
              onReset={() => {
                if (index === 0) panelSize.setChosenWidth(panelSize.defaultWidth)
                else tileSizes.setSecond(null)
              }}
              onResizing={setTileResizing}
            />
            {column.length < 2 ? null : (
              <TileHandle
                axis="y"
                label="Resize stacked panels"
                className="right-2 left-0"
                style={{ top: `calc(${(splits[index] ?? 0.5) * 100}% - 4px)` }}
                grab={grabSplit(index)}
                onReset={() => tileSizes.setSplit(index, 0.5)}
                onResizing={setTileResizing}
              />
            )}
          </div>
        ))}
      </div>
      <TileDropPreview dragging={tileDrag.dragging} landing={tileDrag.landing} />
    </div>
  )
}

/**
 * Where a stacked panel sits in its column. Both share the one grid row and hang from
 * its top or bottom edge, at the column's split rather than on shared row lines, so
 * each column divides its height on its own. Every card keeps its own 8px margin,
 * which stacked would put 16px between two cards; each cell reaches 4px past the
 * split, so the gap matches the one between columns.
 */
function slotStyle(slot: 'whole' | 'top' | 'bottom', split: number): CSSProperties {
  if (slot === 'whole') return {}
  const share = slot === 'top' ? split : 1 - split
  return { alignSelf: slot === 'top' ? 'start' : 'end', height: `calc(${share * 100}% + 4px)` }
}

/** The content height of a box, `0` until it has one (a `contents` box never does). */
function useBoxHeight(box: RefObject<HTMLElement>) {
  const [height, setHeight] = useState(0)
  useEffect(() => {
    const element = box.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => setHeight(entry?.contentRect.height ?? 0))
    observer.observe(element)
    return () => observer.disconnect()
  }, [box])
  return height
}

/** A tile has no drag handle. `hidden` takes the handle out without each panel knowing. */
const TILE_NO_RESIZE: ComponentPropsWithoutRef<'div'> = { hidden: true }
