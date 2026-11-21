import { createContext, Fragment, memo, useContext, useEffect, useLayoutEffect, useRef, useState, type MutableRefObject, type ReactNode } from 'react'
import { dateDividers } from '@manor/client-runtime/date-dividers'
import { splitDeliveredFiles } from '@manor/client-runtime/dm-files'
import { historyStart, olderHistoryKey } from '@manor/client-runtime/history-window'
import { quoteFromText } from '@manor/client-runtime/message-quotes'
import type { WorkAcceptanceOptions } from '@manor/client-runtime/commands'
import type { BubbleTint } from '@manor/client-runtime/avatar-bubble'
import { createPortal } from 'react-dom'
import { CellsIcon, GitBranchIcon } from '@hugeicons/core-free-icons'
import { isLostConnectionNote, isModelOnlyMessage, type AgentConfig, type CheckoutRequest, type EventImage, type FileAttachment, type MessageQuote, type MessageReply, type Project, type SkillConfig } from '@manor/contracts'
import { turnChangedFiles } from '../changedFiles'
import { useLiveThread } from '../liveThread'
import {
  answerTextOf,
  dmLiveCard,
  finishedSilent,
  goalReportEventId,
  onlyConsulted,
  personaOf,
  rowHasQuoteSource,
  feedIndexOf,
  NO_OPEN_THREAD_BUNDLES,
  openThreadBundleAt,
  setThreadBundleOpen,
  threadBundleOpen,
  threadBundleOpenItems,
  threadStretch,
  stackedConsultationMarkers,
  relayExchanges,
  relayMarkerAction,
  dmMemoryMarks,
  unannouncedConsultations,
  workCardInView,
  type RelayExchange,
  type Row,
  type SessionLink,
  type ThreadState,
  type TurnRow as TurnRowState,
  type TurnConsultation,
  type TurnStanding,
  type UnannouncedConsultation,
  messageBrief,
  threadSpacing,
  streamedMessages,
} from '../state'
import { chatSubagents, dmWorking, hasFold, hasStatus, isCompactNote } from '../turnTrace'
import { endFace, turnFace } from '@manor/client-runtime/face-activity'
import { useDoneMoment, useFaceState } from '../useFaceState'
import { SubagentLaunchesContext, type SubagentLaunches } from '../subagentContext'
import { WakeNotices } from './SubagentRows'
import { Icon } from './Icon'
import { Badge } from './ui/Badge'
import { ThreadBundle } from './ThreadBundle'
import { AnswerChange, OTHER_ANSWER } from './bundleTile'
import { AgentBubble, ClampedMessage, FileWriteFootnote, KickoffAttachments, ProjectFileWriteCard, RoutineLine, SystemLine, TurnHeader, UserBubble, WakeLine } from './Bubbles'
import { SelectionQuoteBar } from './SelectionQuoteBar'
import { QUIET_CHROME, TurnStatus } from './TurnStatus'
import { DmWorkingIndicator } from './DmWorkingIndicator'
import { AskAnswers } from './AskCard'
import type { DraftActions } from './OutboundDraftBubble'
import { OutboundDraftGroup } from './OutboundDraftGroup'
import { ChangedFiles } from './ChangedFiles'
import { DeliveredFiles } from './DeliveredFiles'
import { ConnectCards } from './ConnectCards'
import { BOUNDS_ATTRIBUTE, MessageActions, MessageFooter } from './MessageFooter'
import { TodoList } from './TodoList'
import { PinnedPlan, PlanDockProvider, usePlanDock } from './PinnedPlan'
import { useTopBarSlot } from './TopBar'
import { TurnActivity, type FoldToggle } from './TurnActivity'
import { RowArrivalsContext, type RowArrivals } from './rowArrivals'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { INSTANT, POPOVER_CLOSING_SCALE, POPOVER_IN, POPOVER_OUT, POPOVER_PRE_SCALE } from '../motion'
import { AgentStack } from './inbox/AgentStack'
import { Avatar } from './Avatar'
import { Popover } from './ui/Popover'
import { useDismiss } from './ui/useDismiss'
import type { WorkResultActions } from './WorkResultBody'
import { NotesLine } from './NotesLine'
import { WorkHandoffCard } from './WorkHandoffCard'
import { Markdown } from './Markdown'
import { useAgentMentions } from './mentionMarkdown'
import { useStableCallback } from '../useStableCallback'
import { scrollWithin } from './scrollWithin'

const NO_CONSULTATION_MARKERS: ReadonlyMap<string, readonly TurnConsultation[]> = new Map()
const NO_EXCHANGES: ReadonlyMap<string, RelayExchange | null> = new Map()
const NO_CHANGED_FILES: ReturnType<typeof turnChangedFiles> = []

/** Which consultation each turn still waits on: the peer of its last relay sent and not yet answered. A handoff expects no answer. */
function waitingOnByTurnOf(rows: readonly Row[]): Map<string, string> {
  const waiting = new Map<string, string>()
  for (const row of rows) {
    if (row.kind !== 'event' || row.event.type !== 'agent_relay') continue
    if (row.event.phase === 'sent' && row.event.handoff !== true) waiting.set(row.event.turnId, row.event.peerAgentId)
    else waiting.delete(row.event.turnId)
  }
  return waiting
}

/** How far off the bottom still counts as "reading the latest". */
const BOTTOM_SLACK_PX = 48
const JUMP_DURATION_MS = 200
/** How long a message found from the palette stays marked; matches `search-hit` in styles.css. */
const SEARCH_HIT_MS = 1500
const isUserBubbleRow = (row: Row | undefined): boolean =>
  row?.kind === 'pending' ||
  (row?.kind === 'event' && row.event.type === 'user_message' && row.event.source === undefined && row.confirmTasks === undefined && !isModelOnlyMessage(row.event))

/** Consultation markers annotate the conversation, so they sit close to what they annotate. */
const isRelayRow = (row: Row | undefined): boolean => row?.kind === 'event' && row.event.type === 'agent_relay'

/** Pulls a relay marker toward its neighbours; the column's own gap (32 or 24px) stays for every other pair. */
function relaySpacing(row: Row, previous: Row | undefined, panel: boolean): string {
  if (isRelayRow(row)) {
    if (isRelayRow(previous)) return panel ? ' -mt-[24px]' : ' -mt-[32px]'
    return panel ? ' -mt-[16px]' : ' -mt-[24px]'
  }
  if (isRelayRow(previous)) return panel ? ' -mt-[14px]' : ' -mt-[20px]'
  return ''
}

/**
 * A project thread's rhythm against the feed gap (32px, 24px in a panel): cards that
 * follow each other close to 8px, and the user's own message, like any row under a reply,
 * sits 16px lower. The reply's hung actions need that room; see `threadSpacing`.
 */
function threadRhythm(row: Row, previous: Row | undefined, panel: boolean): string {
  const rhythm = threadSpacing(row, previous)
  if (rhythm === 'group') return panel ? ' -mt-4' : ' -mt-6'
  return rhythm === 'beat' ? ' mt-4' : ''
}

function DateSeparator({ label }: { label: string }) {
  return <div className="text-center text-[12px] text-dim">{label}</div>
}

/** What `revealEvent` points at, a message by event id or a row by its key. */
export type TranscriptReveal = { id: number } & ({ eventId: string } | { rowKey: string } | { report: true })

interface TranscriptProps {
  rows: Row[]
  agents: AgentConfig[]
  /** Full roster for historical attribution when a Single chat hides personas. */
  identityAgents?: AgentConfig[]
  skills: SkillConfig[]
  hasSnapshot: boolean
  /** Every path this chat's project can show, which is what places a changed file. */
  repoFiles?: string[]
  /** Absent where this chat has no files panel; a turn's files are then inert names. */
  onOpenFile?: (panelPath: string) => void
  /** Opens one helper in the Subagents panel from its card in a turn, by launch call id. */
  onOpenSubagents?: (toolCallId: string) => void
  /**
   * A subagent view lies over this transcript. Underneath it the thread keeps its place
   * and its folds, and coming back lands where it was left.
   */
  held?: boolean
  /** Stands above the first row and scrolls with the thread. */
  leading?: ReactNode
  /** The row of an isolated Session's first brief, which names the branch above itself. */
  isolation?: { rowKey: string; branch: string }
  /** The role a helper was given, shown muted at the top of its task card. */
  taskRole?: string
  /**
   * Where this transcript is being read. The stage centres a 780px column inside a
   * scroller that spans the window and leaves room for the composer's fade; a panel
   * is already a narrow card with its own padding, and the stage's measurements read
   * there as one wide margin and a gap at the top nothing fills.
   */
  variant?: 'stage' | 'panel'
  /**
   * Reads at the side chat's 14px instead of the stage's 15px. Sessions set it, so a
   * work room is denser than a conversation; DMs and the project thread keep 15.
   */
  denseText?: boolean
  /** What an empty thread says. The stage's line is about mentioning an agent. */
  emptyNote?: ReactNode
  /** Accepts the proposal. The new Session is listed; Accept never opens it. */
  onAcceptWork?: (handoffId: string, options: WorkAcceptanceOptions) => Promise<unknown> | void
  /** Rejects the proposal without creating a Work thread. */
  onRejectWork?: (handoffId: string) => void
  /** Opens a Session with its diff beside it, from a ready card's file count. */
  onOpenDiff?: (chatId: string) => void
  /** Accept and Request changes on a Session's result card in the briefing DM. */
  resultActions?: WorkResultActions
  /** Absent outside DMs and groups, where message targeting is not offered. */
  onReply?: (reply: MessageReply) => void
  /** Stages selected visible text without changing who the next message reaches. */
  onQuote?: (quote: MessageQuote) => void
  /** Stages selected visible text in the side chat and opens its panel. */
  onAddToSideChat?: (quote: MessageQuote) => void
  connected?: boolean
  draftActions?: DraftActions
  /**
   * A DM, which reads as a chat: replies are bubbles that appear only once whole, and
   * one working indicator at the foot stands in for everything the agent is doing.
   */
  bubbleReplies?: boolean
  /** The DM's persona, whose face the working indicator wears before any turn exists. */
  dmAgentId?: string
  /** Chats with a turn running, so a DM waits on a colleague only while she is still at it. */
  runningChatIds?: ReadonlySet<string>
  /** A DM fills the user's own bubbles with the colour of the face they are talking to. */
  userBubbleTint?: BubbleTint
  /** False for a bare session, whose model is not presented as a named persona. */
  showSpeakers?: boolean
  /** True in a room with several personas, where a sent quote names its author. */
  quoteAuthors?: boolean
  /**
   * Set in a project thread: replies speak as the project, Session cards change shape
   * as their Session moves, and a finished turn's chrome shows on hover or focus.
   */
  threadProject?: Project
  /**
   * Set in a Session: a turn's plan stands at its end instead of inside its trace, and
   * stays in view above the composer while the turn runs.
   */
  pinPlan?: boolean
  /** Opens another chat by id: a relay marker's pair thread, an accepted Work card's thread, or a forward's Session. */
  onOpenAgentRelay?: (chatId: string) => void
  /** Opens a Session at its lead's report, from its result card's Open report. */
  onOpenReport?: (chatId: string) => void
  /** In a Session: the project whose thread sent the user's messages on here, named over them. */
  forwardSource?: string
  /** Standing pair threads span days and make those boundaries explicit. */
  showDates?: boolean
  /**
   * Filled with a function that scrolls a row into view by key, loading older history
   * when it is not shown yet. `focus` is a selector inside the row to focus instead of it.
   */
  revealRef?: MutableRefObject<((rowKey: string, focus?: string) => void) | null>
  /**
   * A message to bring into view once its row exists, flashed for a moment so the eye
   * lands on it. The ⌘K palette picks a message; the sessions overview picks a row by
   * key, such as a proposal card; a result card's Open report picks the Session's
   * report (`goalReportEventId`). Each new `id` reveals once, loading older history
   * first when the target is above the rendered page; `onEventRevealed` hears that it
   * happened, or that the target is not in this thread.
   */
  revealEvent?: TranscriptReveal | null
  onEventRevealed?: (id: number) => void
  /**
   * Hears which open Session cards show in the visible part of the thread, by row key,
   * whenever that changes. The bar above the composer leaves those out.
   */
  onWorkCardsInView?: (keys: ReadonlySet<string>) => void
  /** In a project thread: the answers from preferences the user may replace, and what opens that choice. */
  answerChange?: { ids: ReadonlySet<string>; onChange: (noteId: string) => void }
}

/**
 * The stage's transcript over the live thread. The pane reads the quiet workspace, so
 * a streamed text frame renders this, its rows and the turn that grew, not the pane.
 */
/** Whether a subagent view lies over this transcript, read when a turn settles under it. */
const TranscriptHeld = createContext(false)

export function LiveTranscript({ chatId, liveRows, ...props }: Omit<TranscriptProps, 'rows'> & {
  chatId: string
  /** The pane's row pipeline, run over the live thread. */
  liveRows: (thread: ThreadState) => Row[]
}) {
  const thread = useLiveThread(chatId)
  return <Transcript {...props} rows={liveRows(thread)} />
}

export function Transcript({
  rows,
  agents,
  identityAgents = agents,
  skills,
  hasSnapshot,
  repoFiles,
  onOpenFile,
  onOpenSubagents,
  held = false,
  leading,
  isolation,
  taskRole,
  variant = 'stage',
  denseText = false,
  emptyNote,
  onAcceptWork,
  onRejectWork,
  onOpenDiff,
  resultActions,
  onReply,
  onQuote,
  onAddToSideChat,
  connected = true,
  draftActions,
  bubbleReplies = false,
  dmAgentId,
  runningChatIds,
  userBubbleTint,
  showSpeakers,
  quoteAuthors = false,
  threadProject,
  pinPlan = false,
  onOpenAgentRelay,
  onOpenReport,
  forwardSource,
  showDates = false,
  revealRef,
  revealEvent,
  onEventRevealed,
  onWorkCardsInView,
  answerChange,
}: TranscriptProps) {
  const headerInBar = useTopBarSlot() !== null
  const scrollerRef = useRef<HTMLDivElement>(null)
  const columnRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const planDock = usePlanDock(stageRef)
  const jumpFrameRef = useRef<number | null>(null)
  const [atBottom, setAtBottom] = useState(true)
  // The same fact as the state above, for a callback that must not resubscribe
  // every time it changes.
  const atBottomRef = useRef(true)
  const heldRef = useRef(held)
  useLayoutEffect(() => {
    heldRef.current = held
  }, [held])
  const [firstKey, setFirstKey] = useState<string>()
  const arrivals = useRef<RowArrivals>({ ready: false, known: new Set() })
  useEffect(() => {
    if (!hasSnapshot) return
    arrivals.current = { ready: true, known: new Set(rows.map((row) => row.key)) }
  }, [rows, hasSnapshot])
  const [quoteAction, setQuoteAction] = useState<{ quote: MessageQuote; left: number; top: number } | null>(null)
  const prependAnchor = useRef<{ element: Element; top: number } | null>(null)
  // The memoised rows get handlers that keep one identity while the props behind them change.
  const stableOpenFile = useStableCallback((path: string) => onOpenFile?.(path))
  const stableOpenChat = useStableCallback((chatId: string) => onOpenAgentRelay?.(chatId))
  const stableOpenSubagents = useStableCallback((toolCallId: string) => onOpenSubagents?.(toolCallId))
  const stableReply = useStableCallback((reply: MessageReply) => onReply?.(reply))
  // A wake's notice rows find the helper they report on here.
  const subagentLaunches: SubagentLaunches = {
    byCallId: new Map(chatSubagents(rows).flatMap((subagent) => subagent.step.toolCallId === undefined ? [] : [[subagent.step.toolCallId, subagent] as const])),
    open: onOpenSubagents === undefined ? undefined : stableOpenSubagents,
  }
  const waitingOnByTurn = waitingOnByTurnOf(rows)
  // In a DM, memory writes are reached through the notepad on a reply bubble only.
  const memoryMarks = bubbleReplies ? dmMemoryMarks(rows) : undefined
  const exchanges = bubbleReplies && onOpenAgentRelay !== undefined ? relayExchanges(rows) : NO_EXCHANGES
  const consultationMarkers = bubbleReplies && onOpenAgentRelay !== undefined ? stackedConsultationMarkers(rows, exchanges) : NO_CONSULTATION_MARKERS
  const unannounced = unannouncedConsultations(rows)
  const visibleRows = rows.filter((row) => row.kind === 'event'
    ? consultationMarkers.get(row.event.id)?.length !== 0 && exchanges.get(row.event.id) !== null
    : !(bubbleReplies && row.kind === 'turn' && onlyConsulted(row)))
  // The project thread's open bundles; the user's next message folds them all again.
  const [openBundles, setOpenBundles] = useState(NO_OPEN_THREAD_BUNDLES)
  const stretch = threadStretch(visibleRows)
  const setBundleOpen = (key: string, open: boolean) => setOpenBundles((current) => setThreadBundleOpen(current, stretch, key, open))
  /**
   * Opens the bundle a jump lands in and the line of the item it lands on (`holds`); true
   * when the reveal must wait a frame for them to mount.
   */
  const unfoldAt = (index: number, holds: (item: Row) => boolean): boolean => {
    const row = visibleRows[index]
    if (row?.kind !== 'thread_bundle') return false
    const next = openThreadBundleAt(openBundles, stretch, row, holds)
    if (next === openBundles) return false
    setOpenBundles(next)
    return true
  }
  // A project thread keeps a finished turn's actions quiet until hover or focus.
  const inThread = threadProject !== undefined
  const start = historyStart(visibleRows, firstKey)
  const pageRows = visibleRows.slice(start)
  const dateLabels = dateDividers(pageRows, bubbleReplies ? 'gaps' : showDates ? 'days' : 'off')
  const { working, done: workDone } = useDoneMoment(bubbleReplies ? dmWorking(rows, runningChatIds) : undefined, rows)
  const workingPersona = working === undefined
    ? undefined
    : personaOf(agents, working.kind === 'turn' ? working.turn.agentId : working.kind === 'consult' ? working.agentId : dmAgentId ?? 'unknown')

  useLayoutEffect(() => {
    // Keep the oldest rendered key stable when new replies arrive at the end.
    setFirstKey(visibleRows[start]?.key)
    const anchor = prependAnchor.current
    const scroller = scrollerRef.current
    if (anchor && scroller) {
      scroller.scrollTop += anchor.element.getBoundingClientRect().top - anchor.top
      prependAnchor.current = null
    }
  }, [visibleRows, start])

  const loadOlder = () => {
    if (start === 0 || prependAnchor.current) return
    // Anchor the content itself: a newly preceding user bubble can change its
    // compact margin, and the first date separator may disappear after prepend.
    const element = scrollerRef.current?.querySelector('[data-transcript-row]')?.firstElementChild
    if (element) prependAnchor.current = { element, top: element.getBoundingClientRect().top }
    setPinned(false)
    setFirstKey(olderHistoryKey(visibleRows, start))
  }

  const setPinned = (next: boolean) => {
    atBottomRef.current = next
    setAtBottom(next)
  }

  // Follow new content only while the user is already at the bottom, so reading
  // back through the thread is never yanked away by an incoming delta.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller || !atBottom || held) return
    scroller.scrollTop = scroller.scrollHeight
  }, [rows])

  // Which open Session cards show, measured against the part of the thread the header,
  // the composer and the bar above it leave visible. Rows rendered above the page are
  // not in the DOM and so count as out of view, which is what the bar should say.
  const cardsInViewRef = useRef<ReadonlySet<string> | null>(null)
  const cardsFrameRef = useRef<number | null>(null)
  const measureWorkCards = useStableCallback(() => {
    const scroller = scrollerRef.current
    const report = onWorkCardsInView
    if (!scroller || report === undefined) return
    const box = scroller.getBoundingClientRect()
    const stage = getComputedStyle(scroller)
    const covered = (parseFloat(stage.getPropertyValue('--composer-dock')) || 0) + (parseFloat(stage.getPropertyValue('--work-dock')) || 0)
    const shown = new Set<string>()
    for (const card of scroller.querySelectorAll<HTMLElement>('[data-work-card]')) {
      // The card's top scroll margin is the header floating over the thread.
      const header = parseFloat(getComputedStyle(card).scrollMarginTop) || 0
      if (workCardInView(card.getBoundingClientRect(), { top: box.top + header, bottom: box.bottom - covered })) shown.add(card.dataset.workCard!)
    }
    const previous = cardsInViewRef.current
    if (previous !== null && previous.size === shown.size && [...shown].every((key) => previous.has(key))) return
    cardsInViewRef.current = shown
    report(shown)
  })
  const scheduleWorkCards = () => {
    if (cardsFrameRef.current !== null) return
    cardsFrameRef.current = requestAnimationFrame(() => {
      cardsFrameRef.current = null
      measureWorkCards()
    })
  }
  // Before paint, so a thread opening on a card never flashes its row in the bar.
  useLayoutEffect(measureWorkCards, [pageRows, measureWorkCards])
  useEffect(() => () => {
    if (cardsFrameRef.current !== null) cancelAnimationFrame(cardsFrameRef.current)
  }, [])

  // A shrinking viewport does not move `scrollTop`: it raises the maximum instead,
  // so a composer growing under the thread slides the newest message down behind
  // its own top edge without a single row changing. Re-pin on every height change —
  // a taller draft, an attached image, a resized window — and only for a reader who
  // had not already scrolled up.
  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    const observer = new ResizeObserver(() => {
      scheduleWorkCards()
      planDock.measure()
      if (!atBottomRef.current || heldRef.current) return
      scroller.scrollTop = scroller.scrollHeight
    })
    observer.observe(scroller)
    // The stage pads by the composer floating over it, so a taller draft grows the
    // column instead of shrinking the scroller. Border box, because padding is the
    // part that changes.
    if (columnRef.current) observer.observe(columnRef.current, { box: 'border-box' })
    return () => observer.disconnect()
  }, [])

  useEffect(
    () => () => {
      if (jumpFrameRef.current !== null) cancelAnimationFrame(jumpFrameRef.current)
    },
    [],
  )

  const handleScroll = () => {
    const scroller = scrollerRef.current
    if (!scroller) return
    const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
    setPinned(distance <= BOTTOM_SLACK_PX)
    // A screen ahead of the reader, so a fast scroll up finds the older page already
    // there instead of stopping dead at the top while it mounts.
    if (scroller.scrollTop < Math.max(160, scroller.clientHeight) && !atBottomRef.current) loadOlder()
    setQuoteAction(null)
    scheduleWorkCards()
    planDock.measure()
  }

  // Back from a subagent view the scroll position stands, whichever way it was opened;
  // only whether it is still the bottom is measured afresh.
  const wasHeld = useRef(held)
  useLayoutEffect(() => {
    if (wasHeld.current && !held) handleScroll()
    wasHeld.current = held
  }, [held])

  const stageSelection = () => {
    if (onQuote === undefined && onAddToSideChat === undefined) return
    const selection = window.getSelection()
    if (selection === null || selection.isCollapsed || selection.rangeCount !== 1) {
      setQuoteAction(null)
      return
    }
    const range = selection.getRangeAt(0)
    const sourceOf = (node: Node) => (node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement)
      ?.closest<HTMLElement>('[data-quote-event-id]') ?? null
    const startSource = sourceOf(range.startContainer)
    const endSource = sourceOf(range.endContainer)
    if (startSource === null || endSource !== startSource || !scrollerRef.current?.contains(startSource)) {
      setQuoteAction(null)
      return
    }
    const quote = quoteFromText(
      startSource.dataset.quoteEventId ?? '',
      selection.toString(),
      startSource.dataset.quoteAgentId,
    )
    if (quote === undefined) {
      setQuoteAction(null)
      return
    }
    const box = range.getBoundingClientRect()
    setQuoteAction({
      quote,
      left: Math.max(12, Math.min(box.left + box.width / 2, window.innerWidth - 12)),
      top: Math.max(12, box.top - 8),
    })
  }

  // A target above the rendered page opens with a page of context before it, so it
  // can centre instead of sitting at the top under the header, and the scroll does
  // not fire `loadOlder` mid-flight. Unpinning keeps the bottom follow from undoing it.
  const showThenReveal = (index: number, reveal: () => void) => {
    if (index < 0 || index >= start) {
      reveal()
      return
    }
    setPinned(false)
    setFirstKey(olderHistoryKey(visibleRows, index))
    requestAnimationFrame(() => requestAnimationFrame(reveal))
  }

  /** The running flash, ended by the next pick so its timer cannot cut the new flash short. */
  const flash = useRef<{ target: HTMLElement; timer: number } | null>(null)
  const endFlash = () => {
    if (flash.current === null) return
    window.clearTimeout(flash.current.timer)
    flash.current.target.removeAttribute('data-search-hit')
    flash.current = null
  }
  /** Washes the landed message for SEARCH_HIT_MS, restarting the wash when it is already running. */
  const flashTarget = (target: HTMLElement) => {
    endFlash()
    void target.offsetWidth
    target.setAttribute('data-search-hit', '')
    flash.current = { target, timer: window.setTimeout(endFlash, SEARCH_HIT_MS) }
  }
  useEffect(() => endFlash, [])

  const openQuoteSource = (eventId: string) => {
    const selector = `[data-quote-event-id="${CSS.escape(eventId)}"]`
    const reveal = () => {
      const scroller = scrollerRef.current
      const source = scroller?.querySelector<HTMLElement>(selector)
      if (scroller === null || source === null || source === undefined) return
      scrollWithin(scroller, source, { block: 'center', behavior: 'smooth' })
      source.focus({ preventScroll: true })
      flashTarget(source)
    }
    const index = visibleRows.findIndex((row) => rowHasQuoteSource(row, eventId))
    showThenReveal(index, unfoldAt(index, (item) => rowHasQuoteSource(item, eventId)) ? () => requestAnimationFrame(() => requestAnimationFrame(reveal)) : reveal)
  }
  // Quote navigation closes over the loaded page, so it would otherwise change with every row.
  const stableOpenQuoteSource = useStableCallback((eventId: string) => openQuoteSource(eventId))
  // A steering message inside a running turn draws exactly like a top-level one.
  const renderInlineUser = (row: Extract<Row, { kind: 'event' }>) => (
    <EventRow
      row={row}
      agents={agents}
      skills={skills}
      {...(threadProject === undefined ? {} : { threadProject })}
      {...(userBubbleTint === undefined ? {} : { userBubbleTint })}
      dm={bubbleReplies}
      quoteAuthors={quoteAuthors}
      {...(onOpenAgentRelay === undefined ? {} : { onOpenAgentRelay: stableOpenChat })}
      {...(forwardSource === undefined ? {} : { forwardSource })}
      onOpenQuoteSource={stableOpenQuoteSource}
    />
  )

  const revealRow = (rowKey: string, focus?: string) => {
    const reveal = () => {
      const scroller = scrollerRef.current
      const row = scroller?.querySelector<HTMLElement>(`[data-transcript-row="${CSS.escape(rowKey)}"]`)
      if (scroller === null || row === null || row === undefined) return
      // The target's scroll margins stand for the header and the composer floating over
      // the thread, so it centres in the part that is actually visible.
      const target = row.querySelector<HTMLElement>('[data-reveal-target]') ?? row
      const reduceMotion = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
      // Leaving the bottom on purpose: unpinned, a card that grows as it opens (Request
      // changes from the bar) is not pulled back down by the follow-the-latest observer.
      setPinned(false)
      scrollWithin(scroller, target, { block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' })
      const field = focus === undefined ? null : row.querySelector<HTMLElement>(focus)
      ;(field ?? target).focus({ preventScroll: true })
    }
    const index = feedIndexOf(visibleRows, rowKey)
    showThenReveal(index, unfoldAt(index, (item) => item.key === rowKey) ? () => requestAnimationFrame(() => requestAnimationFrame(reveal)) : reveal)
  }
  useEffect(() => {
    if (revealRef === undefined) return
    revealRef.current = revealRow
    return () => { revealRef.current = null }
  })

  const revealedEvent = useRef<number | null>(null)
  // The turn whose folded work Open report opens, so a report written before the call shows.
  const [openTrace, setOpenTrace] = useState<{ key: string; id: number } | null>(null)
  useEffect(() => {
    if (revealEvent === undefined || revealEvent === null || !hasSnapshot) return
    if (revealedEvent.current === revealEvent.id) return
    revealedEvent.current = revealEvent.id
    const { id } = revealEvent
    const eventId = 'eventId' in revealEvent ? revealEvent.eventId : 'report' in revealEvent ? goalReportEventId(visibleRows) : undefined
    const index = 'rowKey' in revealEvent
      ? feedIndexOf(visibleRows, revealEvent.rowKey)
      : eventId === undefined ? -1 : visibleRows.findIndex((row) => rowHasQuoteSource(row, eventId))
    if (index < 0) {
      onEventRevealed?.(id)
      return
    }
    if ('report' in revealEvent) setOpenTrace({ key: visibleRows[index]!.key, id })
    unfoldAt(index, (item) => 'rowKey' in revealEvent ? item.key === revealEvent.rowKey : eventId !== undefined && rowHasQuoteSource(item, eventId))
    const reveal = () => {
      const scroller = scrollerRef.current
      // A row folded into a bundle carries its own anchor there.
      const rowKey = 'rowKey' in revealEvent ? revealEvent.rowKey : visibleRows[index]?.key ?? ''
      const row = scroller?.querySelector<HTMLElement>(`[data-transcript-row="${CSS.escape(rowKey)}"]`)
      // The message itself when it is drawn; its row when it sits folded inside a turn's work.
      // A row picked by key lands on its card, the way the decision bar's reveal does.
      const target = eventId === undefined
        ? row?.querySelector<HTMLElement>('[data-reveal-target]') ?? row
        : scroller?.querySelector<HTMLElement>(`[data-quote-event-id="${CSS.escape(eventId)}"], [data-message-ids~="${CSS.escape(eventId)}"]`) ?? row
      if (scroller === null || scroller === undefined || target === undefined || target === null) return
      setPinned(false)
      // Landed at once, like following a link: the chat just opened, and a smooth run
      // through a long thread would spend the flash before the message arrives. A
      // message taller than the view, such as a report, lands on its first line.
      scrollWithin(scroller, target, { block: target.offsetHeight > scroller.clientHeight ? 'start' : 'center' })
      flashTarget(target)
    }
    // Two frames: the opening chat pins itself to the bottom first, then this lands.
    const settle = () => requestAnimationFrame(() => requestAnimationFrame(reveal))
    showThenReveal(index, settle)
    onEventRevealed?.(id)
  })

  const jumpToLatest = () => {
    const scroller = scrollerRef.current
    if (!scroller) return
    const reduceMotion =
      typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduceMotion) {
      scroller.scrollTop = scroller.scrollHeight
      setPinned(true)
      return
    }
    if (jumpFrameRef.current !== null) cancelAnimationFrame(jumpFrameRef.current)
    const start = scroller.scrollTop
    const startedAt = performance.now()
    const animate = (now: number) => {
      const progress = Math.min((now - startedAt) / JUMP_DURATION_MS, 1)
      const eased = 1 - (1 - progress) ** 3
      // Aim at the bottom as it is now: the Session bar returning mid-jump pads the end.
      scroller.scrollTop = start + (scroller.scrollHeight - scroller.clientHeight - start) * eased
      if (progress < 1) {
        jumpFrameRef.current = requestAnimationFrame(animate)
      } else {
        jumpFrameRef.current = null
        setPinned(true)
      }
    }
    jumpFrameRef.current = requestAnimationFrame(animate)
  }

  /** One row as it stands in the feed; a bundle draws its items through the same function. */
  const renderRow = (row: Row): ReactNode => {
    const consultationMarker = row.kind === 'event' ? consultationMarkers.get(row.event.id) : undefined
    const unannouncedHere = row.kind === 'event' && row.event.type === 'agent_relay' && row.event.phase === 'sent'
      ? unannounced.get(row.event.turnId)
      : undefined
    const exchange = row.kind === 'event' ? exchanges.get(row.event.id) : undefined
    return row.kind === 'event' && row.event.type === 'agent_relay' && exchange != null ? (
      <RelayMarker
        event={row.event}
        exchange={exchange}
        agents={agents}
        onOpen={onOpenAgentRelay}
        {...(unannouncedHere === undefined ? {} : { unannounced: unannouncedHere })}
      />
    ) : row.kind === 'event' && row.event.type === 'agent_relay' && consultationMarker !== undefined && onOpenAgentRelay !== undefined ? (
      <ConsultedAgents
        action={row.event.phase === 'received' ? 'Message from' : 'Messaged'}
        consultations={consultationMarker}
        agents={agents}
        onOpen={onOpenAgentRelay}
        {...(unannouncedHere === undefined ? {} : { unannounced: unannouncedHere })}
      />
    ) : row.kind === 'event' ? (
      <EventRow
        row={row}
        agents={agents}
        skills={skills}
        {...(threadProject === undefined ? {} : { threadProject })}
        {...(userBubbleTint === undefined ? {} : { userBubbleTint })}
        dm={bubbleReplies}
        quoteAuthors={quoteAuthors}
        onOpenAgentRelay={onOpenAgentRelay}
        {...(forwardSource === undefined ? {} : { forwardSource })}
        onOpenQuoteSource={stableOpenQuoteSource}
        {...(unannouncedHere === undefined ? {} : { unannounced: unannouncedHere })}
        {...(isolation?.rowKey === row.key ? { isolatedBranch: isolation.branch } : {})}
        {...(taskRole === undefined ? {} : { taskRole })}
      />
    ) : row.kind === 'work_handoff' ? (
      <div className={bubbleReplies ? 'min-w-0 max-w-bubble' : 'contents'}>
      <WorkHandoffCard
        row={row}
        agents={agents}
        identityAgents={identityAgents}
        onReveal={revealRow}
        onAccept={onAcceptWork}
        onReject={onRejectWork}
        {...(onOpenDiff === undefined ? {} : { onOpenDiff })}
        onOpenThread={onOpenAgentRelay}
        {...(onOpenReport === undefined ? {} : { onOpenReport })}
        {...(resultActions === undefined ? {} : { resultActions })}
        {...(inThread ? { inThread } : {})}
      />
      </div>
    ) : row.kind === 'pending' ? (
      <UserBubble
        text={row.text}
        agents={agents}
        skills={skills}
        images={row.images}
        files={row.files}
        {...(row.documents === undefined ? {} : { documents: row.documents })}
        pageContexts={row.pageContexts}
        {...(row.replyTo === undefined ? {} : { replyTo: row.replyTo })}
        {...(row.quotes === undefined ? {} : { quotes: row.quotes })}
        onOpenQuoteSource={stableOpenQuoteSource}
        quoteAuthors={quoteAuthors}
        dm={bubbleReplies}
        pending
      />
    ) : row.kind === 'thread_bundle' ? (
      <ThreadBundle
        row={row}
        open={threadBundleOpen(openBundles, stretch, row.key)}
        openItems={threadBundleOpenItems(openBundles, stretch, row)}
        onOpenChange={setBundleOpen}
        renderItem={renderRow}
      />
    ) : (
      <TurnRow
        turn={row}
        agents={agents}
        showSpeaker={showSpeakers ?? variant === 'stage'}
        {...(threadProject === undefined ? {} : { threadProject })}
        pinPlan={pinPlan}
        repoFiles={repoFiles}
        onOpenFile={onOpenFile === undefined ? undefined : stableOpenFile}
        onOpenSubagents={onOpenSubagents === undefined ? undefined : stableOpenSubagents}
        onOpenChat={onOpenAgentRelay === undefined ? undefined : stableOpenChat}
        renderUser={renderInlineUser}
        onReply={onReply === undefined ? undefined : stableReply}
        connected={connected}
        waitingOnAgentId={waitingOnByTurn.get(row.turnId)}
        bubbleReplies={bubbleReplies}
        {...(openTrace?.key === row.key ? { openTrace: openTrace.id } : {})}
        {...(draftActions === undefined ? {} : { draftActions })}
        {...(memoryMarks === undefined ? {} : { memoryChanges: memoryMarks.get(row.key) })}
      />
    )
  }

  return (
    <TranscriptHeld.Provider value={held}>
    <RowArrivalsContext.Provider value={arrivals}>
    <SubagentLaunchesContext.Provider value={subagentLaunches}>
    <AnswerChange.Provider value={answerChange ?? null}>
    <PlanDockProvider value={planDock}>
    <div ref={stageRef} className="relative flex min-h-0 min-w-0 w-full">
      {/* The scroller spans the whole stage, with the readable column centred inside
          it. Its bar is hidden rather than left riding the window's edge all day: the
          thread says where it is with the jump-to-latest button,
          and the column stays put instead of shifting 15px when a short chat grows
          long enough to scroll. `min-w-0` is load-bearing in the panel: a quote or
          a table that sized the column to its content used to push every other
          bubble past the card's overflow, which is how a side chat went blank.
          `overflow-x-hidden` is the same rule on the stage: a 780px column that
          refused to shrink used to paint under the browser. */}
      <div
        className="scrollbar-hidden flex min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto"
        ref={scrollerRef}
        onScroll={handleScroll}
        onPointerUp={stageSelection}
        onKeyUp={stageSelection}
        // The region a message's own popover may use. It is this and not the window
        // because the desktop shell's browser is a native layer over the right of the
        // page, and because the side chat is a card a few hundred pixels wide.
        {...{ [BOUNDS_ATTRIBUTE]: '' }}
      >
        {/* The composer floats over the thread; this padding keeps the last message clear
            while the scroller continues through its transparent rounded corners. */}
        <div
          ref={columnRef}
          // Focus mode narrows the stage column to a reading measure (styles.css).
          {...(variant === 'panel' ? {} : { 'data-reading-column': '' })}
          className={
            variant === 'panel'
              // 768 is a 740 text column plus this column's own inset. The composer runs
              // 20px wider (760) on purpose, so it frames the thread it writes into.
              ? 'mx-auto flex min-w-0 w-full max-w-[768px] flex-1 flex-col gap-6 px-3.5 pt-4 pb-4 [--msg-size:14px]'
              // A header that joined the top bar sits above the pane; one kept in place
              // (the phone, the Browser session column) floats over the first message.
              : `mx-auto flex w-full max-w-[780px] flex-1 flex-col gap-[32px] px-5 ${headerInBar ? 'pt-8' : 'pt-[76px]'} pb-[calc(var(--composer-dock,0px)+var(--work-dock,0px)+3.5rem)] ${denseText ? '[--msg-size:14px]' : '[--msg-size:15px]'}`
          }
        >
          {leading}
          {start > 0 ? (
            <button type="button" className="self-center text-[12px] text-dim hover:text-text" onClick={loadOlder}>
              Load earlier messages
            </button>
          ) : null}
          {visibleRows.length === 0 ? (
            <div className={variant === 'panel' ? 'py-8 text-dim' : 'py-12 text-center text-dim'}>
              {hasSnapshot
                ? (emptyNote ?? 'Empty chat.')
                : 'Loading…'}
            </div>
          ) : (
            pageRows.map((row, pageIndex) => {
              const compactUser = dateLabels[pageIndex] === undefined && isUserBubbleRow(row) && isUserBubbleRow(pageRows[pageIndex - 1])
              const spacing = dateLabels[pageIndex] === undefined
                ? relaySpacing(row, pageRows[pageIndex - 1], variant === 'panel') + (threadProject === undefined ? '' : threadRhythm(row, pageRows[pageIndex - 1], variant === 'panel'))
                : ''
              return (
                <Fragment key={row.key}>
                  {dateLabels[pageIndex] === undefined ? null : <DateSeparator label={dateLabels[pageIndex]} />}
                  {/* `empty:hidden` drops a row with nothing to draw out of the column's gap. */}
                  <div data-transcript-row={row.key} className={`flex min-w-0 flex-col empty:hidden${compactUser ? variant === 'panel' ? ' -mt-[18px]' : ' -mt-[26px]' : spacing}`}>
                    {renderRow(row)}
                  </div>
                </Fragment>
              )
            })
          )}
          {working === undefined || workingPersona === undefined ? null : (
            <DmWorkingIndicator working={working} done={workDone} persona={workingPersona} agents={agents} />
          )}
        </div>
      </div>
      {quoteAction === null ? null : (
        <SelectionQuoteBar
          left={quoteAction.left}
          top={quoteAction.top}
          {...(onQuote === undefined
            ? {}
            : {
                onQuote: () => {
                  onQuote(quoteAction.quote)
                  window.getSelection()?.removeAllRanges()
                  setQuoteAction(null)
                },
              })}
          {...(onAddToSideChat === undefined
            ? {}
            : {
                onAddToSideChat: () => {
                  onAddToSideChat(quoteAction.quote)
                  window.getSelection()?.removeAllRanges()
                  setQuoteAction(null)
                },
              })}
        />
      )}
      <JumpToLatest shown={!atBottom} panel={variant === 'panel'} onJump={jumpToLatest} />
    </div>
    </PlanDockProvider>
    </AnswerChange.Provider>
    </SubagentLaunchesContext.Provider>
    </RowArrivalsContext.Provider>
    </TranscriptHeld.Provider>
  )
}

/**
 * The pill that appears once the reader has scrolled up. It rises out of the edge it
 * sits on and sinks back into it, because it turns up on its own while the eye is on
 * the thread, and a pill that blinks in reads as something that went wrong.
 */
function JumpToLatest({ shown, panel, onJump }: { shown: boolean; panel: boolean; onJump: () => void }) {
  const reduce = useReducedMotion() ?? false
  return (
    <AnimatePresence initial={false}>
      {shown ? (
        <motion.button
          key="jump"
          type="button"
          data-jump-latest=""
          // The stage footer floats over the thread. Clear its measured height and keep
          // the original gap above it; a panel has no footer and keeps its ordinary inset.
          // A Session's pinned tasks card can stand in its way: `--plan-dock` is where that card's
          // top edge is (0 when it is not in the way), and follows it as it folds or grows.
          className={`absolute left-1/2 z-[4] -translate-x-1/2 origin-bottom cursor-pointer rounded-full border border-line bg-raised h-7 px-3 text-[12px] text-text shadow-pill ${
            panel ? 'bottom-8' : 'bottom-[max(calc(var(--composer-dock,0px)+var(--work-dock,0px)+2rem),calc(var(--plan-dock,0px)+1rem))]'
          }`}
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8, scale: POPOVER_PRE_SCALE }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={reduce ? { opacity: 0, transition: INSTANT } : { opacity: 0, y: 4, scale: POPOVER_CLOSING_SCALE, transition: POPOVER_OUT }}
          transition={reduce ? INSTANT : POPOVER_IN}
          onClick={onJump}
        >
          Jump to latest
        </motion.button>
      ) : null}
    </AnimatePresence>
  )
}

/**
 * A Session's brief, or a DM brief handed to the project thread, folded to its opening
 * lines like a long message so the thread starts on the work rather than under a wall of
 * text. An agent wrote it, so it reads as markdown with the personas it names as chips,
 * a step below the messages' size so it does not outweigh them. The breadcrumb already
 * names the project. A helper's task card also carries its role above a divider.
 */
function KickoffCard({ text, agents, images = [], files = [], branch, role }: { text: string; agents: AgentConfig[]; images?: EventImage[]; files?: FileAttachment[]; branch?: string; role?: string }) {
  const { plugins, components } = useAgentMentions(agents)
  const card = (
    <div className="flex min-w-0 flex-col gap-2 rounded-xl border border-line bg-composer-tray px-4 py-3">
      <KickoffAttachments images={images} files={files} />
      {/* The size sits outside the clamp so its line unit is the brief's own. */}
      <div className="min-w-0 text-[length:calc(var(--msg-size,16px)-1px)]">
        <ClampedMessage clamp lines={role === undefined ? KICKOFF_LINES : KICKOFF_LINES + ROLE_LINES}>
          {/* A helper's role leads the task inside the clamp, so a folded card shows both. */}
          {role === undefined ? null : (
            <>
              <p className="m-0 text-muted [overflow-wrap:anywhere]">{role}</p>
              <hr className="my-2 border-0 border-t border-line" />
            </>
          )}
          <Markdown text={text} plugins={plugins} components={components} />
        </ClampedMessage>
      </div>
    </div>
  )
  if (branch === undefined) return card
  // The helper view's pill, 10px over the card like its facts sit.
  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <Badge
        className="self-start"
        mark={<Icon icon={GitBranchIcon} size={13} className="flex-none text-worktree" />}
        title="Isolated in its own worktree. Uncommitted edits in the linked folders did not come along."
      >
        {branch}
      </Badge>
      {card}
    </div>
  )
}

/** How much of a brief shows before Show more: the problem statement, not the whole plan. */
const KICKOFF_LINES = 5
/** Lines a helper's role adds to the fold, so the task keeps its own five under it. */
const ROLE_LINES = 3

/** Memoised like `TurnRow`: a streamed token re-renders the transcript, never a finished message. */
const EventRow = memo(function EventRow({
  row,
  agents,
  skills,
  threadProject,
  userBubbleTint,
  dm,
  quoteAuthors,
  onOpenAgentRelay,
  forwardSource,
  onOpenQuoteSource,
  unannounced,
  isolatedBranch,
  taskRole,
}: {
  row: Extract<Row, { kind: 'event' }>
  agents: AgentConfig[]
  threadProject?: Project
  skills: SkillConfig[]
  userBubbleTint?: BubbleTint
  dm: boolean
  quoteAuthors: boolean
  onOpenAgentRelay?: (chatId: string) => void
  forwardSource?: string
  onOpenQuoteSource?: (eventId: string) => void
  unannounced?: readonly UnannouncedConsultation[]
  /** An isolated Session's first brief: the branch shown above it. */
  isolatedBranch?: string
  /** A helper's role, which its task card carries above the task. */
  taskRole?: string
}) {
  const event = row.event
  const answerChange = useContext(AnswerChange)
  switch (event.type) {
    case 'user_message': {
      // What Manor says about this message stands under it, in the user's corner.
      const hints = row.hints === undefined ? null : row.hints.map((hint, index) => (
        <p key={index} className="m-0 mt-1.5 max-w-[78%] self-end text-right text-[12px] leading-[1.4] text-dim">{hint}</p>
      ))
      // In a project thread: the Session this message went on to, one quiet line each.
      const forwards = row.forwards?.map((link) => (
        <span key={link.sessionChatId} className="mt-1 flex max-w-[78%] items-center gap-1.5 self-end text-[12px] text-dim">
          <span className="shrink-0">Sent to</span>
          <SessionChip link={link} {...(onOpenAgentRelay === undefined ? {} : { onOpen: onOpenAgentRelay })} />
        </span>
      ))
      // In the Session: the same message, saying which thread sent it here.
      const forwarded = event.forwardedFrom === undefined ? null : (
        <p className="m-0 mb-1 max-w-[78%] self-end text-right text-[12px] leading-[1.4] text-dim">
          {forwardSource === undefined ? 'Sent from the project thread' : `Sent from ${forwardSource}`}
        </p>
      )
      // A message the scheduler injected is not a message the user sent, and the
      // transcript is a record before it is a feed: it gets its own line rather
      // than their bubble. Everything else about the turn is unchanged.
      const brief = event.source === 'project_thread' && event.threadReason === 'brief' ? messageBrief(event) : ''
      const message = event.source === 'routine' ? (
        <RoutineLine name={event.routineName} ts={event.ts} prompt={event.text} {...(event.routineDueAt === undefined ? {} : { dueAt: event.routineDueAt })} />
      ) : event.source === 'background_wake' ? (
        // A DM keeps the compact line; helper cards are Session work.
        dm ? <WakeLine items={event.wakeItems ?? []} /> : <WakeNotices items={event.wakeItems ?? []} ts={event.ts} />
      ) : brief !== '' ? (
        <KickoffCard text={brief} agents={agents} images={event.images ?? []} files={event.files ?? []} />
      ) : event.source === 'project_thread' ? (
        // Manor's wake of the thread: `projectThreadFeed` drops it, and it never reads as the user's bubble.
        null
      ) : event.source === 'work_handoff' ? (
        <KickoffCard text={messageBrief(event)} agents={agents} images={event.images ?? []} files={event.files ?? []} {...(isolatedBranch === undefined ? {} : { branch: isolatedBranch })} />
      ) : event.source === 'subagent_task' ? (
        // A helper's view opens on its task as a handoff card, like a Session's brief.
        // The facts above it already say who started it and on what.
        <KickoffCard text={messageBrief(event)} agents={agents} images={event.images ?? []} files={event.files ?? []} {...(taskRole === undefined ? {} : { role: taskRole })} />
      ) : event.source === 'agent_relay' ? (
        <RelayedAgentMessage event={event} agents={agents} />
      ) : row.confirmTasks !== undefined ? (
        // Confirm's commit request is addressed to the lead; the user reads it as its steps.
        <TodoList todos={row.confirmTasks} label="Confirm" {...(row.confirmTitle === undefined ? {} : { title: row.confirmTitle })} foldKey={`confirm:${row.key}`} />
      ) : isModelOnlyMessage(event) ? (
        // Manor's words to the model alone, such as its report of a stopped merge: nothing for the user to read.
        null
      ) : (
        <UserBubble
          text={event.text}
          agents={agents}
          skills={skills}
          images={event.images ?? []}
          files={event.files ?? []}
          documents={event.documents ?? []}
          pageContexts={event.pageContexts ?? []}
          {...(event.replyTo === undefined ? {} : { replyTo: event.replyTo })}
          {...(event.quote === undefined ? {} : { quote: event.quote })}
          {...(event.noteQuote === undefined ? {} : { noteQuote: event.noteQuote })}
          {...(event.quotes === undefined ? {} : { quotes: event.quotes })}
          {...(onOpenQuoteSource === undefined ? {} : { onOpenQuoteSource })}
          {...(userBubbleTint === undefined ? {} : { tint: userBubbleTint })}
          dm={dm}
          quoteAuthors={quoteAuthors}
          sourceEventId={event.id}
        />
      )
      return hints === null && forwards === undefined && forwarded === null ? message : <>{forwarded}{message}{hints}{forwards}</>
    }
    case 'system_note':
      // Inside a turn the fold says it; a `/compact` result stands alone.
      if (isCompactNote(event) && event.turnId !== undefined) return null
      // A DM says nothing about a turn that broke off, even one that may have half-run.
      if (dm && isLostConnectionNote(event.text)) return null
      if (event.projectFileWrite !== undefined) return <ProjectFileWriteCard write={event.projectFileWrite} projectName={threadProject?.name} />
      return <SystemLine kind={event.kind} text={event.text} {...(answerChange?.ids.has(event.id) === true ? { action: { label: OTHER_ANSWER, onClick: () => answerChange.onChange(event.id) } } : {})} />
    case 'agent_relay':
      return (
        <RelayMarker
          event={event}
          agents={agents}
          onOpen={onOpenAgentRelay}
          {...(unannounced === undefined ? {} : { unannounced })}
        />
      )
  }
})

/** A Session by its title, opening it on press: under a forwarded message and under the reply that sent it. */
function SessionChip({ link, onOpen }: { link: SessionLink; onOpen?: (chatId: string) => void }) {
  return (
    <button
      type="button"
      disabled={onOpen === undefined}
      onClick={() => onOpen?.(link.sessionChatId)}
      aria-label={`Open Session ${link.title}`}
      className="flex min-w-0 cursor-pointer items-center gap-1 rounded-md border-0 bg-surface-2 px-1.5 py-0.5 text-[12px] leading-[16px] text-muted [font-family:inherit] hover:text-text disabled:cursor-default disabled:hover:text-muted"
    >
      <Icon icon={CellsIcon} size={13} className="flex-none" />
      <span className="min-w-0 truncate">{link.title}</span>
    </button>
  )
}

function RelayMarker({
  event,
  exchange,
  agents,
  onOpen,
  unannounced,
}: {
  event: Extract<Extract<Row, { kind: 'event' }>['event'], { type: 'agent_relay' }>
  /** Set when this marker stands for the agent's whole exchange: "N messages with". */
  exchange?: RelayExchange
  agents: AgentConfig[]
  onOpen?: (chatId: string, checkout?: CheckoutRequest) => Promise<void> | void
  /** Set when the asking turn said nothing, so this marker states the question. */
  unannounced?: readonly UnannouncedConsultation[]
}) {
  const peer = personaOf(agents, event.peerAgentId)
  const consultation = unannounced?.find((entry) => exchange === undefined ? entry.relayId === event.relayId : exchange.relayIds.includes(entry.relayId))
  const action = relayMarkerAction(event.phase, exchange)
  const label = event.phase === 'failed' && exchange === undefined ? `Message from ${peer.name} failed` : `${action} ${peer.name}`
  return (
    <div className="flex flex-col items-center">
      <button
        type="button"
        disabled={onOpen === undefined}
        onClick={() => onOpen?.(event.pairChatId)}
        title={exchange === undefined ? event.preview : undefined}
        // `font-family`, not `font`: the shorthand would reset the 12px size to the column's.
        className="flex cursor-pointer items-center gap-1 rounded-md border-0 bg-transparent px-2 py-1 text-[12px] leading-[16px] text-dim [font-family:inherit] hover:bg-surface-2 hover:text-muted disabled:cursor-default disabled:hover:bg-transparent"
      >
        <span>{action}</span>
        <Avatar name={peer.name} color={peer.color} src={peer.avatar} shape={peer.avatarShape} tone={peer.avatarTone} size={13} />
        <span>{peer.name}</span>
      </button>
      <span className="sr-only">{label}</span>
      {consultation === undefined ? null : <ConsultationExcerpt question={consultation.question} replyPending={consultation.replyPending} />}
    </div>
  )
}

/**
 * The question a silent turn asked, one muted line under its marker. It opens to the
 * whole first line in place; "reply follows" stays until the reply's marker lands.
 */
function ConsultationExcerpt({ question, replyPending }: { question: string; replyPending: boolean }) {
  const [open, setOpen] = useState(false)
  const follows = replyPending ? ', reply follows' : ''
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-label={`Question: ${question}${follows}`}
      onClick={() => setOpen((value) => !value)}
      className="flex max-w-[min(100%,520px)] cursor-pointer rounded-md border-0 bg-transparent px-2 pb-1 text-[12px] leading-[16px] text-dim [font-family:inherit] hover:text-muted"
    >
      {open ? (
        <span className="text-center">“{question}”{follows}</span>
      ) : (
        <>
          <span className="min-w-0 truncate">“{question}”</span>
          {replyPending ? <span className="shrink-0">, reply follows</span> : null}
        </>
      )}
    </button>
  )
}

function RelayedAgentMessage({
  event,
  agents,
}: {
  event: Extract<Extract<Row, { kind: 'event' }>['event'], { type: 'user_message' }>
  agents: AgentConfig[]
}) {
  const persona = personaOf(agents, event.authorAgentId ?? 'unknown')
  return (
    <div className="group/turn flex flex-col gap-1.5">
      <TurnHeader
        name={persona.name}
        color={persona.color}
        avatar={persona.avatar}
        avatarShape={persona.avatarShape}
        avatarTone={persona.avatarTone}
      />
      <AgentBubble color={persona.color} text={event.text} agents={agents} images={event.images ?? []} />
    </div>
  )
}

interface TurnRowProps {
  turn: TurnRowState
  agents: AgentConfig[]
  /** Opens the turn's folded work each time it changes: Open report's reveal. */
  openTrace?: number
  /** False in the side chat, whose model voice is deliberately anonymous. */
  showSpeaker: boolean
  threadProject?: Project
  repoFiles?: string[]
  onOpenFile?: (panelPath: string) => void
  onOpenSubagents?: ((toolCallId: string) => void) | undefined
  /** Opens a Session this project thread turn sent the user's message on to. */
  onOpenChat?: ((chatId: string) => void) | undefined
  /** Draws a steering message the user sent into this turn while it ran (Sessions and project threads, never a DM). */
  renderUser?: (row: Extract<Row, { kind: 'event' }>) => ReactNode
  onReply?: (reply: MessageReply) => void
  connected?: boolean
  draftActions?: DraftActions
  waitingOnAgentId?: string
  bubbleReplies: boolean
  /** In a DM: the memory writes this turn's last reply bubble shows, its own or carried to it. */
  memoryChanges?: TurnRowState['memoryChanges']
  pinPlan?: boolean
}

/**
 * Where quiet chrome hangs under a turn: in the gap right below it instead of holding
 * room in it, so a quiet chat has no holes and nothing moves when it appears. It stays
 * pressable, and hovering it is hovering its turn. Without hover it is always shown,
 * so it stays in flow.
 */
const HUNG_BELOW = '[@media(hover:hover)]:absolute [@media(hover:hover)]:inset-x-0 [@media(hover:hover)]:top-full'

const TurnRow = memo(function TurnRow({
  turn, agents, showSpeaker, repoFiles, onOpenFile, onOpenSubagents, onOpenChat, renderUser, onReply, connected = true, draftActions, waitingOnAgentId,
  bubbleReplies, memoryChanges: dmMemory, threadProject, openTrace, pinPlan = false,
}: TurnRowProps) {
  const persona = personaOf(agents, turn.agentId)
  // Deltas still arriving have no durable event yet, so they are not a segment;
  // they are always the newest thing the turn has said and go last.
  const streaming = streamedMessages(turn.live)
  // A turn the user steered mid-run already carries its live text as `live` segments, in
  // order beside their messages, so the loose stream below would draw it a second time.
  const inlineUsers = turn.timeline.some((step) => step.kind === 'user')
  // A turn that only spoke has nothing folded away, so there is no list to draw. Its
  // status line still stands: what it cost is a fact about the turn, not about whether
  // the turn happened to use a tool.
  const showActivity = turn.live !== undefined || turn.segments.length > 0 || hasFold(turn)
  const silent = finishedSilent(turn)
  // Only once the turn is over: while it runs, "3 changed files" is a number that
  // is about to be wrong, and the trace above is already saying what is happening.
  const running = turn.live?.state === 'running'
  const face = useFaceState(turnFace(turn, waitingOnAgentId !== undefined), endFace(turn), running)
  // Work keeps the live stream open so the task surface shows what is happening.
  // A DM never shows it live: the bubble is the conversation, the trace is evidence
  // asked for afterwards. Both fold shut again when the turn settles.
  const [open, setOpen] = useState(bubbleReplies ? false : running)
  const [foldToggle, setFoldToggle] = useState<FoldToggle | undefined>(undefined)
  const activityRoot = useRef<HTMLDivElement>(null)
  const held = useContext(TranscriptHeld)
  const wasRunning = useRef(running)
  useEffect(() => {
    if (running && !wasRunning.current && !bubbleReplies) setOpen(true)
    // Under a subagent view the fold stays as it was, so the rows keep their place.
    if (!running && wasRunning.current && !held) setOpen(false)
    wasRunning.current = running
  }, [running, bubbleReplies])
  useEffect(() => {
    if (openTrace !== undefined) setOpen(true)
  }, [openTrace])
  /**
   * A manual stop needs no receipt. A real failure keeps the one notice that says why,
   * except in a DM: there a broken turn just ends and the user carries on by typing, so
   * the reason moves into the turn's trace.
   */
  const note = turn.note?.kind === 'aborted' || (bubbleReplies && turn.note?.kind === 'error') ? undefined : turn.note
  const noted = bubbleReplies && turn.note?.kind === 'error'
    ? { ...turn, traceNotes: [...turn.traceNotes ?? [], { key: `note:${turn.key}`, text: turn.note.text }] }
    : turn
  const traced = pinPlan && turn.todos !== undefined
    ? { ...noted, segments: noted.segments.filter((segment) => segment.kind !== 'todo') }
    : noted
  // A DM shows only whole messages: partial text a stop or failure cut off stays out.
  const standing = bubbleReplies ? turn.tail.filter((segment) => segment.kind !== 'reply' || segment.interrupted !== true)
    : pinPlan ? turn.tail.filter((segment) => segment.kind !== 'todo') : turn.tail
  const changed = running ? NO_CHANGED_FILES : turnChangedFiles(turn, repoFiles)
  const answerText = answerTextOf(turn.answer)
  const status = (
    <TurnStatus
      turn={traced}
      open={open}
      onToggle={() => {
        const from = activityRoot.current?.offsetHeight ?? 0
        setFoldToggle((last) => ({ id: (last?.id ?? 0) + 1, from, opens: !open }))
        setOpen(!open)
      }}
      standalone={!showSpeaker || bubbleReplies || threadProject !== undefined}
      dm={bubbleReplies}
      thread={threadProject !== undefined}
      {...(waitingOnAgentId === undefined
        ? {}
        : { runningLabel: `${persona.name} is waiting on ${personaOf(agents, waitingOnAgentId).name}` })}
    />
  )
  // In a DM nothing would carry the stop or the break; in a Session the header still says Stopped.
  // Nor a turn still at work that has not finished a message or a card yet: the indicator
  // at the foot speaks for it, and an empty row would only open a gap above it.
  const dmBare = bubbleReplies && standing.length === 0 && (turn.files?.length ?? 0) === 0 && (turn.connects?.length ?? 0) === 0
    && turn.sessionLinks === undefined && turn.fileWrites === undefined
  if (dmBare && !running && (turn.note?.kind === 'error' || turn.note?.kind === 'aborted')) return null
  if (dmBare && running && !turn.segments.some(dmLiveCard)) return null
  // The status line rests itself once the turn is over: see `TurnStatus`.
  const header = bubbleReplies ? (
    // A finished DM turn has no face: the face lives only in the working indicator at
    // the foot of the chat. Its Worked for line waits for hover, hung in the gap under
    // the bubbles, and opens the trace above them. Nothing while it runs. Clicks pass
    // through it to a relay line pulled up beneath; the status button takes its own.
    running || !hasStatus(traced) ? null : (
      <div className={`pointer-events-none flex min-h-6 items-center${open ? '' : ` ${HUNG_BELOW}`}`}>{status}</div>
    )
  ) : showSpeaker && threadProject === undefined ? (
    <TurnHeader
      name={persona.name}
      color={persona.color}
      avatar={persona.avatar}
      avatarShape={persona.avatarShape}
      avatarTone={persona.avatarTone}
      working={running}
      face={face}
      status={status}
    />
  ) : threadProject !== undefined || hasStatus(turn) ? (
    // No face and no name, as in a project thread or a Single chat: the line is the
    // whole header, and keeps its slot so the reply stays put when the turn ends. A
    // project thread holds the slot on every reply, for the actions of the one before.
    <div className="flex min-h-8 items-center">{status}</div>
  ) : null
  const lastReply = [...standing].reverse().find((segment) => segment.kind === 'reply')
  // A delivered picture is drawn rather than listed, and only once: most are already in the replies above.
  const delivered = turn.files === undefined ? undefined
    : splitDeliveredFiles(turn.files, standing.flatMap((segment) => (segment.kind === 'reply' ? segment.images : [])))
  const memoryChanges = bubbleReplies ? dmMemory : turn.memoryChanges
  // A finished DM turn that left nothing (a relay marker is its own row) keeps no
  // Worked for line either: it would hover over an empty gap between rows.
  const signsBubble = standing.length > 0 || (turn.files?.length ?? 0) > 0 || (turn.connects?.length ?? 0) > 0
  return (
    <div className={`group/turn flex flex-col gap-1.5${threadProject === undefined && !bubbleReplies ? '' : ' relative'}`}>
      {bubbleReplies ? null : header}
      {/* `data-chrome` marks what focus mode hides: the work around an answer, not the answer. */}
      {showActivity ? (
        <div data-chrome={inlineUsers ? undefined : ''} className="contents">
        <TurnActivity
          turn={traced}
          persona={persona}
          agents={agents}
          open={open}
          {...(foldToggle === undefined ? {} : { foldToggle })}
          rootRef={activityRoot}
          connected={connected}
          {...(draftActions === undefined ? {} : { draftActions })}
          {...(onOpenSubagents === undefined ? {} : { onOpenSubagents })}
          waitingOnAgent={waitingOnAgentId !== undefined}
          bubble={bubbleReplies}
          {...(renderUser === undefined ? {} : { renderUser })}
        />
        </div>
      ) : null}
      {/* A project thread keeps its grey lines out of the feed: the next reply says what happened. */}
      {silent && threadProject === undefined ? (
        <SystemLine kind="info" text={showSpeaker ? `${persona.name} finished without a reply.` : 'Finished without a reply.'} />
      ) : null}
      {standing.map((segment) => (
        <StandingSegment
          key={segment.key}
          segment={segment}
          color={persona.color}
          agentId={turn.agentId}
          agents={agents}
          bubble={bubbleReplies}
          connected={connected}
          renderUser={renderUser}
          trace={turn.memoryTrace}
          // One turn, one memory write: only its last reply beat carries the mark.
          {...(memoryChanges === undefined || segment !== lastReply ? {} : { memoryChanges })}
          {...(onReply === undefined ? {} : {
            onReply: (text: string) => onReply({ turnId: turn.turnId, agentId: turn.agentId, text }),
          })}
          {...(draftActions === undefined ? {} : { draftActions })}
        />
      ))}
      {/* A DM holds a reply back until it is whole; its indicator says she is writing. */}
      {bubbleReplies || inlineUsers ? null : streaming.map((message) =>
        message.text.length === 0 ? null : (
          <AgentBubble
            key={`live:${message.messageId}`}
            color={persona.color}
            text={message.text}
            agents={agents}
            bubble={bubbleReplies}
            // Only while it is actually still arriving. A turn that was stopped or
            // failed keeps its partial here for good, and that one is finished
            // text: it should be wrapped no differently than any other reply.
            live={running}
          />
        ),
      )}
      {delivered === undefined || delivered.pictures.length === 0 ? null : (
        <AgentBubble bubble={bubbleReplies} color={persona.color} text="" agents={agents} images={delivered.pictures} />
      )}
      {delivered === undefined ? null : <DeliveredFiles files={delivered.rows} bubble={bubbleReplies} />}
      {turn.connects === undefined ? null : <ConnectCards cards={turn.connects} bubble={bubbleReplies} />}
      {turn.sessionLinks === undefined ? null : (
        <div className="flex flex-wrap gap-1.5">
          {turn.sessionLinks.map((link) => (
            <SessionChip key={link.sessionChatId} link={link} {...(onOpenChat === undefined ? {} : { onOpen: onOpenChat })} />
          ))}
        </div>
      )}
      {turn.fileWrites === undefined ? null : <FileWriteFootnote writes={turn.fileWrites} />}
      {running ? null : <NotesLine agentId={turn.agentId} update={turn.notesUpdate} offer={turn.instructionsOffer} />}
      {/* Last in the turn, so sticking above the composer while it runs and settling
          when it ends are the same place: nothing moves when the turn finishes. */}
      {pinPlan && turn.todos !== undefined && turn.todos.length > 0 ? (
        <PinnedPlan pinned={running}>
          <TodoList todos={turn.todos} label="Plan" foldKey={`plan:${turn.key}`} />
        </PinnedPlan>
      ) : null}
      {/* The project thread speaks in prose; its files show in the Session that wrote them. */}
      {bubbleReplies || threadProject !== undefined || changed.length === 0 ? null : (
        <div data-chrome="" className="mt-1">
          <ChangedFiles files={changed} turnId={turn.turnId} {...(onOpenFile === undefined ? {} : { onOpenFile })} />
        </div>
      )}
      {bubbleReplies && signsBubble ? header : null}
      {/* Only once the turn is over. Half an answer is not a message yet: a copy
          button on text still arriving copies a sentence that is about to be longer,
          and a memory trace is derived after the last word. */}
      {bubbleReplies || running || turn.live !== undefined ? null : (
        <div className={threadProject === undefined ? 'contents' : `${QUIET_CHROME} ${HUNG_BELOW}`}>
        <MessageFooter
          text={answerText}
          {...(turn.endedAt === undefined ? {} : { endedAt: turn.endedAt })}
          {...(turn.memoryTrace === undefined ? {} : { trace: turn.memoryTrace })}
          {...(turn.memoryChanges === undefined ? {} : { memoryChanges: turn.memoryChanges })}
          {...(onReply === undefined || answerText.length === 0
            ? {}
            : { onReply: () => onReply({ turnId: turn.turnId, agentId: turn.agentId, text: answerText }) })}
        />
        </div>
      )}
      {note === undefined || isCompactNote(note) || (threadProject !== undefined && note.kind === 'info') ? null : <SystemLine kind={note.kind} text={note.text} />}
    </div>
  )
})

/** The compact entrance from a DM into the standing pairs a stacked marker names. */
function ConsultedAgents({
  action,
  consultations,
  agents,
  onOpen,
  unannounced,
}: {
  action: 'Messaged' | 'Message from'
  consultations: readonly TurnConsultation[]
  agents: AgentConfig[]
  onOpen: (chatId: string) => void
  /** Set when the asking turn said nothing: the menu then names each question. */
  unannounced?: readonly UnannouncedConsultation[]
}) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [mounted, setMounted] = useState(false)
  const [placement, setPlacement] = useState<ConsultedMenuPlacement | null>(null)
  const hide = () => setOpen(false)
  useDismiss(open, hide, {
    within: [triggerRef, menuRef],
    layoutMoved: true,
    escape: true,
    windowBlur: true,
  })
  const agentIds = consultations.map((consultation) => consultation.agentId)
  const names = agentIds.map((agentId) => personaOf(agents, agentId).name)
  const count = consultations.length
  const questionOf = (agentId: string) => unannounced?.find((entry) => entry.agentId === agentId)
  const repliesFollow = unannounced?.some((entry) => entry.replyPending) === true

  useLayoutEffect(() => {
    const trigger = triggerRef.current
    if (!open || trigger === null) return
    const region = trigger.closest(`[${BOUNDS_ATTRIBUTE}]`)?.getBoundingClientRect() ?? null
    setPlacement(placeConsultedMenu(trigger.getBoundingClientRect(), region, {
      width: window.innerWidth,
      height: window.innerHeight,
    }, count, unannounced === undefined ? CONSULTED_MENU_ROW_HEIGHT : CONSULTED_MENU_QUESTION_ROW_HEIGHT))
  }, [count, open, unannounced])

  const toggle = () => {
    if (open) {
      hide()
      return
    }
    setMounted(true)
    setOpen(true)
  }

  return (
    <div className="flex justify-center">
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`${action} ${names.join(', ')}${repliesFollow ? ', replies follow' : ''}`}
        className="flex cursor-pointer items-center gap-1 rounded-md border-0 bg-transparent px-2 py-1 text-[12px] leading-[16px] text-dim [font-family:inherit] hover:bg-surface-2 hover:text-muted"
        onClick={toggle}
      >
        <span>{action}</span>
        <AgentStack agentIds={agentIds} agents={agents} size={14} />
        <span>{count} {count === 1 ? 'agent' : 'agents'}{repliesFollow ? ', replies follow' : ''}</span>
      </button>
      {!mounted || typeof document === 'undefined'
        ? null
        : createPortal(
            <Popover
              ref={menuRef}
              open={open && placement !== null}
              origin={placement?.upward === true ? 'bottom-right' : 'top-right'}
              className="fixed z-30 overflow-y-auto rounded-xl border border-line surface-floating p-1.5 shadow-pill"
              style={{
                left: placement?.left ?? 0,
                width: placement?.width ?? CONSULTED_MENU_WIDTH,
                maxHeight: placement?.maxHeight,
                ...(placement?.top === undefined ? {} : { top: placement.top }),
                ...(placement?.bottom === undefined ? {} : { bottom: placement.bottom }),
              }}
              contentClassName="m-0 list-none"
              element="ul"
              role="menu"
              aria-label={action === 'Messaged' ? 'Consulted agents' : 'Messages from'}
            >
              {consultations.map((consultation) => {
                const persona = personaOf(agents, consultation.agentId)
                const question = questionOf(consultation.agentId)?.question
                return (
                  <li key={consultation.agentId}>
                    <button
                      type="button"
                      role="menuitem"
                      className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg border-0 bg-transparent px-2.5 py-2 text-left text-[15px] text-text [font:inherit] hover:bg-user-bg"
                      onClick={() => {
                        hide()
                        onOpen(consultation.pairChatId)
                      }}
                    >
                      <Avatar name={persona.name} color={persona.color} src={persona.avatar} shape={persona.avatarShape} tone={persona.avatarTone} size={24} />
                      {question === undefined ? (
                        <span className="min-w-0 flex-1 truncate">{persona.name}</span>
                      ) : (
                        <span className="flex min-w-0 flex-1 flex-col" title={question}>
                          <span className="truncate">{persona.name}</span>
                          <span className="truncate text-[12px] leading-[16px] text-dim">“{question}”</span>
                        </span>
                      )}
                    </button>
                  </li>
                )
              })}
            </Popover>,
            document.body,
          )}
    </div>
  )
}

const CONSULTED_MENU_WIDTH = 220
const CONSULTED_MENU_GAP = 6
const CONSULTED_MENU_INSET = 8
const CONSULTED_MENU_ROW_HEIGHT = 40
const CONSULTED_MENU_QUESTION_ROW_HEIGHT = 56
const CONSULTED_MENU_PADDING = 12

interface ConsultedMenuBox {
  left: number
  right: number
  top: number
  bottom: number
}

export interface ConsultedMenuPlacement {
  left: number
  width: number
  maxHeight: number
  upward: boolean
  top?: number
  bottom?: number
}

/** Places the portalled menu inside the visible transcript, on whichever side fits. */
export function placeConsultedMenu(
  trigger: ConsultedMenuBox,
  region: ConsultedMenuBox | null,
  viewport: { width: number; height: number },
  count: number,
  rowHeight = CONSULTED_MENU_ROW_HEIGHT,
): ConsultedMenuPlacement {
  const leftEdge = Math.max(CONSULTED_MENU_INSET, region?.left ?? 0)
  const rightEdge = Math.min(viewport.width - CONSULTED_MENU_INSET, region?.right ?? viewport.width)
  const topEdge = Math.max(CONSULTED_MENU_INSET, region?.top ?? 0)
  const bottomEdge = Math.min(viewport.height - CONSULTED_MENU_INSET, region?.bottom ?? viewport.height)
  const width = Math.min(CONSULTED_MENU_WIDTH, rightEdge - leftEdge)
  const desiredHeight = count * rowHeight + CONSULTED_MENU_PADDING
  const above = trigger.top - CONSULTED_MENU_GAP - topEdge
  const below = bottomEdge - trigger.bottom - CONSULTED_MENU_GAP
  const upward = below < desiredHeight && above > below
  const maxHeight = Math.max(0, upward ? above : below)

  return {
    left: Math.max(leftEdge, Math.min(trigger.right - width, rightEdge - width)),
    width,
    maxHeight,
    upward,
    ...(upward
      ? { bottom: viewport.height - trigger.top + CONSULTED_MENU_GAP }
      : { top: trigger.bottom + CONSULTED_MENU_GAP }),
  }
}

function StandingSegment({
  segment,
  color,
  agentId,
  agents,
  bubble,
  connected = true,
  draftActions,
  trace,
  memoryChanges,
  onReply,
  renderUser,
}: {
  segment: TurnStanding
  color: string
  agentId: string
  agents: AgentConfig[]
  bubble: boolean
  connected?: boolean
  draftActions?: DraftActions
  trace?: TurnRowState['memoryTrace']
  memoryChanges?: TurnRowState['memoryChanges']
  onReply?: (text: string) => void
  renderUser?: (row: Extract<Row, { kind: 'event' }>) => ReactNode
}) {
  if (segment.kind === 'user') return renderUser?.(segment.row) ?? null
  if (segment.kind === 'reply') {
    if (!bubble) return <AgentBubble color={color} text={segment.text} agents={agents} images={segment.images} quoteAgentId={agentId} quoteSources={segment.quoteSources} />
    return (
      <div className="group/beat flex min-w-0 items-end gap-1">
        <AgentBubble bubble color={color} text={segment.text} agents={agents} images={segment.images} quoteAgentId={agentId} quoteSources={segment.quoteSources} />
        <MessageActions
          className="mb-0.5 opacity-0 transition-opacity group-hover/beat:opacity-100 focus-within:opacity-100"
          text={segment.text}
          trace={trace}
          memoryChanges={memoryChanges}
          {...(onReply === undefined ? {} : { onReply: () => onReply(segment.text) })}
        />
      </div>
    )
  }
  if (segment.kind === 'todo') return <div className={bubble ? 'min-w-0 max-w-bubble' : 'min-w-0'}><TodoList todos={segment.todos} foldKey={segment.key} /></div>
  if (segment.kind === 'draft') {
    return (
      <OutboundDraftGroup
        bubble={bubble}
        color={color}
        connected={connected}
        drafts={segment.drafts}
        {...(draftActions === undefined ? {} : { actions: draftActions })}
      />
    )
  }
  return (
    <div className={bubble ? 'min-w-0 max-w-bubble' : 'min-w-0'}>
      <AskAnswers
        questions={segment.ask.questions}
        {...(segment.ask.answers === undefined ? {} : { answers: segment.ask.answers })}
      />
    </div>
  )
}
