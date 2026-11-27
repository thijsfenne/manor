import { WorkHandoffCard } from '@/components/WorkHandoffCard'
import { Badge } from '@/components/Badge'
import { FoldedBody } from '@/components/FoldedBody'
import { KickoffCard } from '@/components/KickoffCard'
import { FOOTER_GAP, KeyboardFooter, useFooterPadding } from '@/components/KeyboardFooter'
import { WakeNotices } from '@/components/SubagentRow'
import { SubagentDirectory, SubagentLaunchesContext, type SubagentLaunches } from '@/lib/subagentContext'
import { WaitingDock, WorkDecisionDock } from '@/components/WorkDecisionDock'
import { openWorkChanges, useDockedWorkChanges, workChangesDockable } from '@/components/WorkResultBody'
import ArrowDown01Icon from '@hugeicons/core-free-icons/ArrowDown01Icon'
import CellsIcon from '@hugeicons/core-free-icons/CellsIcon'
import GitBranchIcon from '@hugeicons/core-free-icons/GitBranchIcon'
import LockIcon from '@hugeicons/core-free-icons/LockIcon'
import Undo02Icon from '@hugeicons/core-free-icons/Undo02Icon'
import { HugeiconsIcon } from '@hugeicons/react-native'
import { dmReferenceAgents, imageRefSpans, isModelOnlyMessage, originalImageIndexes, isSoloRoom, placeQuotesAfterText, projectThreadOf, withQuoteExcerpts, ROUTINE_LATE_AFTER_MS, SINGLE_CHAT_VOICE, SUBAGENT_VOICE, userInputAnswerText, type AgentConfig, type ChatOverride, type MessageReaction, type EventDocument, type EventImage, type FileAttachment, type ImageAttachment, type InlineQuote, type MessageQuote, type MessageReply, type NoteQuote, type SkillConfig, type ThreadEvent } from '@manor/contracts'
import type { StagedFile } from '@manor/client-runtime/attachments'
import { avatarBubbleTint, projectBubbleTint, type BubbleTint } from '@manor/client-runtime/avatar-bubble'
import { liveSessionContext, singleWorkContext } from '@manor/client-runtime/context-meter'
import { normalizeComposerLists } from '@manor/client-runtime/composer-formatting'
import { chatCommandContext } from '@manor/client-runtime/chat-commands'
import { quoteNamesAuthor } from '@manor/client-runtime/message-quotes'
import { chatSubagents, chatWaitsOnBackground, dmWorking, runningSubagents } from '@manor/client-runtime/turn-trace'
import { chatFallbackTargets, composerRecipients, composerShowsRecipients, replyFallbackTargets, roomAgents } from '@manor/client-runtime/mentions'
import { chatChangedFiles, resolveMarkdownRepoLink } from '@manor/client-runtime/changed-files'
import { defaultSingleRuntime, effectiveDriver, isAutoPending, readSingleRuntime, runtimeLabel, runtimeParts, singleChatOverride, singleRuntimeVoice } from '@manor/client-runtime/runtime-choices'
import type { ChangeableAnswer, OpenAsk, PendingDocument, QuietWorkspace, RelayExchange, Row, SessionLink, ThreadShape, TurnConsultation, TurnRow, WorkHandoffRow } from '@manor/client-runtime/state'
import { activityOf, chatOf, dmMemoryMarks, isHomeRoom, isProjectThread, roomOf, sitsSettled, messageBrief, projectSessionOverview, sessionsDot, openAsk, sessionLiveOf, threadQuestionIn, openSubagentQuestion, subagentSummaryOf, changeableAnswers, personaOf, projectWorkHandoffs, repoListingKey, rowHasQuoteSource, rowsOf, createRowMemory, createValueMemory, feedIndexOf, NO_OPEN_THREAD_BUNDLES, openThreadBundleAt, setThreadBundleOpen, threadBundleOpen, threadBundleOpenItems, threadStretch, onlyConsulted, runtimeStartedAgentIds, sessionReadyRow, sessionThreadOf, stackedConsultationMarkers, relayExchanges, relayMarkerAction, projectThreadFeed, threadQuestionAdvice, threadOf, withSessionTitle, threadSpacing, workDecisionOpen, type ScreenSpan } from '@manor/client-runtime/state'
import { actionNotice } from '@manor/client-runtime/notices'
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router'
import { KeyboardAwareLegendList, useKeyboardScrollToEnd } from '@legendapp/list/keyboard'
import { dateDividers, joinsBubbleAbove } from '@manor/client-runtime/date-dividers'
import { historyStart, olderHistoryKey } from '@manor/client-runtime/history-window'
import { plainDraftText } from '@manor/client-runtime/plain-preview'
import type { LegendListRef } from '@legendapp/list/react-native'
import { memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Platform, Pressable, StyleSheet, View, useWindowDimensions, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native'
import { useKeyboardState } from 'react-native-keyboard-controller'
import Animated, { useReducedMotion, useSharedValue, type SharedValue } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { ARRIVAL_SPENT_MS, ArrivalRow, FIELD_FLIGHT_MS, SendFlightField, armArrival, claimFlight, disarmArrival, requestFlight, useArrivalMotion, type ArrivalMotion, type FieldFlight } from '@/components/ArrivalMotion'
import { AskCard } from '@/components/AskCard'
import { SecretCard } from '@/components/SecretCard'
import { DM_FACE_ROOM, DmWorkingIndicator } from '@/components/DmWorkingIndicator'
import { carryPendingKeys } from '@/lib/listKeys'
import { NO_ARRIVALS, tailArrivals } from '@/lib/arrival'
import type { TextInput } from '@/components/TextInput'
import { cardsShownInThread, workCardOut } from '@/lib/workDock'
import { Attachments, ImageViewer } from '@/components/Attachments'
import { ConnectGate } from '@/components/ConnectGate'
import { Blobatar } from '@/components/Blobatar'
import { ChatHeader, CHAT_HEADER_HEIGHT } from '@/components/ChatHeader'
import { Composer, type ComposerProps } from '@/components/Composer'
import { DiffSheet } from '@/components/DiffSheet'
import { EdgeScrim } from '@/components/EdgeScrim'
import { EditsPill } from '@/components/EditsPill'
import { FilesSheet } from '@/components/FilesSheet'
import { ProjectSettingsSheet } from '@/components/ProjectSettingsSheet'
import { ProjectSessionsPage } from '@/components/ProjectSessionsPage'
import { ThreadPager, ThreadSwipeArea } from '@/components/ThreadPager'
import { GlassIconButton } from '@/components/GlassIconButton'
import { GlassSurface } from '@/components/GlassSurface'
import { SENT_BUBBLE_PAD, useBubbleCorner } from '@/components/bubbleShape'
import { BubbleTintContext } from '@/components/bubbleTint'
import { Markdown, scrollsSideways, type MarkdownLinks, type RepoLinks } from '@/components/Markdown'
import { AgentRuntimeSheet, RuntimeSheet, SingleRuntimeSheet } from '@/components/RuntimeSheet'
import { ReactionBadge } from '@/components/Reactions'
import { noticeStore } from '@/lib/notices'
import { ReplyContextChip } from '@/components/ReplyContextChip'
import { NoteQuoteContextChip, QuoteBlock } from '@/components/QuoteContextChip'
import { LANDING_WASH_MS, LandedMessageContext, LandingWash, type LandedMessage } from '@/components/LandingWash'
import { QuoteRefSheet } from '@/components/QuoteRefSheet'
import { QuoteSelectionSheet, type QuoteSelectionSource } from '@/components/QuoteSelectionSheet'
import type { DraftActions } from '@/components/OutboundDraftBubble'
import { ConsultedAgents, dmTurnDrawsNothing, TranscriptCovered, Turn } from '@/components/Turn'
import { TaskCard } from '@/components/TaskCard'
import { SubagentsSheet } from '@/components/SubagentsSheet'
import { RelayedAgentMessage } from '@/components/RelayedAgentMessage'
import { ProjectFileWriteCard } from '@/components/ProjectFileWriteCard'
import { ThreadBundle } from '@/components/ThreadBundle'
import { AnswerChange, OTHER_ANSWER } from '@/components/bundleTile'
import { takeEventReveal } from '@/lib/threadReveal'
import { isLongMessage } from '@/lib/longMessage'
import { readsLatest, type TranscriptScroll } from '@/lib/readsLatest'
import { EMPTY_DRAFT, readDraft, writeDraft } from '@/lib/drafts'
import { glassRise, glassSink } from '@/lib/glassMotion'
import { useScreenCovered } from '@/lib/useScreenCovered'
import { useLiveThread, useWorkspace, useWorkspaceData } from '@/providers/WorkspaceProvider'
import { Text } from '@/components/Text'
import { bubbleText, colors, fonts, radius, spacing, squircle, transcriptMark } from '@/theme'
import { useHostAuto } from '@/useHostAuto'

export default function ChatScreen() {
  const params = useLocalSearchParams<{ id: string }>()
  const chatId = Array.isArray(params.id) ? params.id[0] : params.id
  // Keyed on the chat, so everything the screen holds about one conversation — its
  // draft, its sheets, where it was scrolled — belongs to that conversation and never
  // carries over to another one the router happens to hand this route.
  return <ConnectGate><ChatContent chatId={chatId} key={chatId} /></ConnectGate>
}

/** The round "Jump to latest" button. */
const JUMP_SIZE = 36

/** A row's height before it is measured; a turn with one reply is about this tall. */
const ESTIMATED_ROW = 120

/** What the footer stands on before its first layout, so the list opens at the right floor. */
const ESTIMATED_FOOTER = 120
/** The feed's own padding under its last row, `styles.feed`. */
const FEED_END_GAP = spacing.xl
/** How much of the feed's width a sent bubble may take. */
const SENT_BUBBLE_SHARE = 0.86
/** One identity, so a chat that offers no skills does not re-render the composer. */
const NO_SKILLS: SkillConfig[] = []

/** A message only the model reads, with nothing Manor says under it: its row would draw nothing. */
const isUnseenUserRow = (row: Extract<Row, { kind: 'event' }>): boolean =>
  row.event.type === 'user_message' && row.event.source === undefined && row.confirmTasks === undefined &&
  isModelOnlyMessage(row.event) && (row.hints?.length ?? 0) === 0
  && (row.forwards?.length ?? 0) === 0 && row.event.forwardedFrom === undefined

/** Consultation markers annotate the conversation, so they sit close to what they annotate. */
const isRelayRow = (row: Row | undefined): boolean => row?.kind === 'event' && row.event.type === 'agent_relay'

/** The top margin that pulls a relay marker toward its neighbours; every other pair keeps the feed gap. */
function relayOffset(row: Row, previous: Row | undefined): number | undefined {
  if (isRelayRow(row)) return isRelayRow(previous) ? -spacing.xl : spacing.sm - spacing.xl
  return isRelayRow(previous) ? spacing.md - spacing.xl : undefined
}

/**
 * The top margin of a project thread row against the 24pt feed gap, on the same scale as
 * the Mac: cards that follow each other sit 8pt apart, and the user's own message sits 16pt lower.
 */
function threadOffset(row: Row, previous: Row | undefined): number | undefined {
  const spacingKind = threadSpacing(row, previous)
  if (spacingKind === 'group') return spacing.sm - spacing.xl
  return spacingKind === 'beat' ? spacing.lg : undefined
}

const NO_CHANGEABLE: ReadonlyMap<string, ChangeableAnswer> = new Map()
const NO_EXCHANGES: ReadonlyMap<string, RelayExchange | null> = new Map()

type SessionLive = ReturnType<typeof sessionLiveOf>

/**
 * The rows a chat shows, from its thread. The screen runs this over the quiet thread, for
 * its docks, its question card and where a row sits in the list. The list runs it over the
 * live thread, which carries the streamed text. Both give the same rows under the same keys.
 */
function useTranscriptRows(thread: ThreadShape, workspace: QuietWorkspace, chatId: string | undefined, projectThread: boolean, sessionLive: SessionLive) {
  const chatKind = chatOf(workspace, chatId ?? null)?.kind
  const baseRows = useMemo(() => rowsOf(thread, chatKind), [thread, chatKind])
  const rows = useMemo(
    () => projectWorkHandoffs(baseRows, workspace.workHandoffs, workspace.chats, workspace.projects, workspace.agents, workspace.checkoutStatus, sessionLive, chatId),
    [baseRows, workspace.workHandoffs, workspace.chats, workspace.projects, workspace.agents, workspace.checkoutStatus, sessionLive, chatId],
  )
  const exchanges = useMemo(
    () => chatKind === 'dm' ? relayExchanges(rows) : NO_EXCHANGES,
    [chatKind, rows],
  )
  const consultationMarkers = useMemo(
    () => chatKind === 'dm' ? stackedConsultationMarkers(rows, exchanges) : new Map(),
    [chatKind, exchanges, rows],
  )
  // A project thread bundles what needs nothing from the user; the docks and the question card read the full rows.
  const feedRows = useMemo(() => projectThread ? projectThreadFeed(rows) : rows, [projectThread, rows])
  // The cards and bundles above are built anew on every pass. A row that says what it said
  // keeps the object it was, so the list redraws only the rows an event changed.
  const [rowMemory] = useState(() => createRowMemory<Row>())
  // A DM turn that draws nothing gets no row: an empty one still takes a slot and its gap,
  // and inserting it as a turn starts pushes the working indicator down, then back. Words
  // to the model alone, such as a reaction's notice, draw nothing either, nor does the wake
  // before an answer after background work.
  const visibleRows = useMemo(
    () => rowMemory.reuse(feedRows.filter((row) => row.kind === 'event'
      ? consultationMarkers.get(row.event.id)?.length !== 0 && exchanges.get(row.event.id) !== null && !isUnseenUserRow(row)
        && !(chatKind === 'dm' && row.event.type === 'user_message' && row.event.source === 'background_wake')
      : !(chatKind === 'dm' && row.kind === 'turn' && (onlyConsulted(row) || dmTurnDrawsNothing(row))))),
    [chatKind, consultationMarkers, exchanges, feedRows, rowMemory],
  )
  return { baseRows, rows, consultationMarkers, exchanges, visibleRows }
}

function ChatContent({ chatId }: { chatId: string | undefined }) {
  const hostAuto = useHostAuto()
  const { workspace, status, askProjectCheckout, askCheckoutStatus, openChat, leaveChat, sendMessage, setReaction, stopTurn, stopBackground, stopSubagent, answerUserInput, answerSecretRequest, changeSessionAnswer, submitOutboundDraft, discardOutboundDraft, snoozeOutboundDraft, ignoreOutboundDraft, restoreOutboundDraft, readOutboundThread, setChatOverride, setChatSettled, rejectWorkHandoff, listRepoFiles, readRepoFile } = useWorkspace()
  const [replyTo, setReplyTo] = useState<MessageReply | undefined>(() => readDraft(chatId).replyTo)
  const [quote, setQuote] = useState<MessageQuote | undefined>(() => readDraft(chatId).quote)
  const [quoteSelection, setQuoteSelection] = useState<QuoteSelectionSource | null>(null)
  const [sheet, setSheet] = useState<'agents' | 'subagents' | 'files' | 'settings' | 'model' | null>(null)
  // Files opens from the settings sheet; iOS presents it only once settings is gone.
  const filesAfterSettings = useRef(false)
  const [footerHeight, setFooterHeight] = useState(ESTIMATED_FOOTER)
  const [jumpForChat, setJumpForChat] = useState<string | null>(null)
  const [allEditsOpen, setAllEditsOpen] = useState(false)
  const [firstKey, setFirstKey] = useState<string>()
  const [fileTarget, setFileTarget] = useState<string | null>(null)
  const showJump = jumpForChat === chatId
  const listRef = useRef<LegendListRef>(null)
  const footerRef = useRef<View>(null)
  // A DM's arrival motion: the chat rises as a message lands, and a sent one leaves the field.
  const arrivalMotion = useArrivalMotion()
  const still = useReducedMotion()
  const screenRef = useRef<View>(null)
  const fieldRef = useRef<TextInput>(null)
  const [fieldFlight, setFieldFlight] = useState<FieldFlight | null>(null)
  const insets = useSafeAreaInsets()
  const covered = useScreenCovered()
  // The overview as the page right of the thread: a swipe to the left or the Sessions button.
  // While it shows, the thread is out of sight as under a pushed screen.
  const [overviewOpen, setOverviewOpen] = useState(false)
  const transcriptCovered = covered || overviewOpen
  // The footer is an overlay that sticks to the keyboard, and its measured height is
  // the list's bottom inset, so the newest message always rests just above the
  // composer: with the keyboard down, up, or mid-flight. The keyboard controller
  // drives both natively along the keyboard's own curve, nothing scrolls from JS.
  const keyboardUp = useKeyboardState((state) => state.isVisible)
  // Read when the keys start to rise, so a card in the composer's place knows its room before they land.
  const keyboardHeight = useKeyboardState((state) => state.height)
  const windowHeight = useWindowDimensions().height
  // The keyboard view adds this to the keyboard's height and reports the sum to the list
  // as its bottom inset. It must be the only one reporting: the footer's height alone, as
  // the list's own composer hook reports it, is a keyboard short while the keys are up,
  // and the list then pins its end that far too high on every footer change.
  const contentInsetEndAdjustment = useSharedValue(ESTIMATED_FOOTER)
  const { freeze, scrollMessageToEnd } = useKeyboardScrollToEnd({ listRef })
  // The tab bar under the composer, which the keyboard covers; the footer sinks by
  // that much when the keys are up, and the list is told the same distance.
  const keyboardSink = insets.bottom

  // On focus, not only on mount: back from a chat pushed over this one makes this the
  // open chat again, so a run finishing in the chat he left is not settled as read.
  // Losing focus gives the selection up, unless the screen above already took it: from
  // the inbox no chat is open, so this one can show unread and a reconnect leaves it be.
  // The project's overview over the thread gives the selection up the same way.
  useFocusEffect(useCallback(() => {
    if (chatId === undefined || overviewOpen) return
    openChat(chatId)
    return () => leaveChat(chatId)
  }, [chatId, overviewOpen, leaveChat, openChat]))

  // The reply and the quote are set from the transcript, so they live here. What is
  // typed and staged lives in `ChatComposer`, and all of it shares one stored draft.
  const chooseReply = useCallback((reply: MessageReply) => {
    setReplyTo(reply)
    writeDraft(chatId, { ...readDraft(chatId), replyTo: reply })
  }, [chatId])
  const react = useCallback((eventId: string, emoji: string | null) => {
    if (chatId === undefined) return
    setReaction(chatId, eventId, emoji).catch((error: unknown) =>
      noticeStore.push(actionNotice('error', error instanceof Error ? error.message : 'Could not react')))
  }, [chatId, setReaction])
  const removeReply = useCallback(() => {
    setReplyTo(undefined)
    const current = readDraft(chatId)
    writeDraft(chatId, { text: current.text, images: current.images, files: current.files, ...(current.quote === undefined ? {} : { quote: current.quote }) })
  }, [chatId])
  const chooseQuote = useCallback((next: MessageQuote) => {
    setQuote(next)
    writeDraft(chatId, { ...readDraft(chatId), quote: next })
  }, [chatId])
  const removeQuote = useCallback(() => {
    setQuote(undefined)
    const current = readDraft(chatId)
    writeDraft(chatId, { text: current.text, images: current.images, files: current.files, ...(current.replyTo === undefined ? {} : { replyTo: current.replyTo }) })
  }, [chatId])
  // Bound to this chat once, so a transcript row that only re-renders on its own turn
  // is not re-rendered by a new closure on every keystroke in the composer. The
  // object changes only when a thread reply lands, which is rare and on request.
  const outboundThreads = workspace.outboundThreads
  const draftActions = useMemo<DraftActions>(
    () => ({
      onSubmit: (draftId, body, subject, slackRichText, cc) => chatId !== undefined && submitOutboundDraft(chatId, draftId, body, subject, slackRichText, cc),
      onDiscard: (draftId) => chatId !== undefined && discardOutboundDraft(chatId, draftId),
      onSnooze: (draftId, until) => chatId !== undefined && snoozeOutboundDraft(chatId, draftId, until),
      onIgnore: (draftId) => chatId !== undefined && ignoreOutboundDraft(chatId, draftId),
      onRestore: (draftId) => chatId !== undefined && restoreOutboundDraft(chatId, draftId),
      onReadThread: (draftId) => chatId !== undefined && readOutboundThread(chatId, draftId),
      threads: outboundThreads,
    }),
    [chatId, discardOutboundDraft, ignoreOutboundDraft, outboundThreads, readOutboundThread, restoreOutboundDraft, snoozeOutboundDraft, submitOutboundDraft],
  )
  const rejectWork = rejectWorkHandoff

  const chat = chatOf(workspace, chatId ?? null)
  // The quiet thread: it holds still while a reply streams, and so does this screen. Only
  // `LiveTranscript` below reads the streamed text.
  const thread = threadOf(workspace, chatId ?? '')
  // What runs in each Session, so its card says what its overview row says.
  // The selectors below get the slices they read, not `workspace`: a memo that hands the
  // whole object over reads more than its dependencies name, and the React Compiler then
  // skips this component altogether (`apps/web/test/phoneCompiledComponents.test.ts`).
  const sessionLive = useMemo(
    () => sessionLiveOf({ activity: workspace.activity, subagents: workspace.subagents, backgroundWork: workspace.backgroundWork }),
    [workspace.activity, workspace.subagents, workspace.backgroundWork],
  )
  // A project thread (2026-10-10) lists its open sessions in the bar and holds their
  // questions; a session it started asks and confirms there.
  const projectThread = chatId !== undefined && isProjectThread(workspace, chatId)
  // Without streamed text: the docks, the question card and Stop read structure only.
  const { baseRows, rows, visibleRows } = useTranscriptRows(thread, workspace, chatId, projectThread, sessionLive)
  // Recheck pending Work when its folders change or this client reconnects.
  const pendingWorkCheckouts = JSON.stringify(rows.flatMap((row) => {
    if (row.kind !== 'work_handoff' || row.acceptedAt !== null || row.status !== 'Working') return []
    const project = workspace.projects.find((project) => project.id === row.projectId)
    return [{ projectId: row.projectId, repoPaths: project?.repoPaths ?? [] }]
  }))
  useEffect(() => {
    if (status !== 'live') return
    const targets: { projectId: string }[] = JSON.parse(pendingWorkCheckouts)
    for (const projectId of new Set(targets.map((target) => target.projectId))) askProjectCheckout(projectId)
  }, [pendingWorkCheckouts, status, askProjectCheckout])

  const isPair = chat?.kind === 'pair'
  const footerPadding = useFooterPadding(keyboardUp && !isPair, keyboardSink)
  // A Session persona's old DM stays readable; it no longer takes messages.
  const sessionDmAgent = chat?.kind === 'dm'
    ? workspace.agents.find((agent) => agent.id === chat.memberIds[0] && agent.placement === 'session')
    : undefined
  const singleChat = chat?.mode === 'single'
  const project = roomOf(workspace, chat?.projectId)
  // Changes only with a new server reading, never with the text streaming beside it.
  const liveContext = liveSessionContext(thread.liveTurns)
  // Single Work's meter only: the project thread rolls over like a DM and, like a DM, has no ring.
  const contextMeter = useMemo(
    () =>
      singleChat && !projectThread
        ? singleWorkContext(thread.events, thread.overrides[SINGLE_CHAT_VOICE.id] ?? {}, workspace.agents, liveContext)
        : undefined,
    [singleChat, projectThread, thread.events, thread.overrides, workspace.agents, liveContext],
  )
  // A Session has no card of its own result, so its Ready row comes from the handoff.
  const sessionReady = useMemo(
    () => chat == null ? undefined : sessionReadyRow(chat, workspace.workHandoffs, workspace.chats, workspace.projects, workspace.agents, workspace.checkoutStatus, sessionLive),
    [chat, workspace.workHandoffs, workspace.chats, workspace.projects, workspace.agents, workspace.checkoutStatus, sessionLive],
  )
  const historyOffset = historyStart(visibleRows, firstKey)
  const pageRows = useMemo(() => visibleRows.slice(historyOffset), [visibleRows, historyOffset])
  // The project thread's open bundles; the user's next message folds them all again.
  const [openBundles, setOpenBundles] = useState(NO_OPEN_THREAD_BUNDLES)
  const stretch = useMemo(() => threadStretch(visibleRows), [visibleRows])
  const stretchRef = useRef(stretch)
  useEffect(() => {
    stretchRef.current = stretch
  }, [stretch])
  // Stable, so the memoized rows do not re-render when the stretch moves.
  const setBundleOpen = useCallback((key: string, open: boolean) =>
    setOpenBundles((current) => setThreadBundleOpen(current, stretchRef.current, key, open)), [])
  useEffect(() => {
    setFirstKey(visibleRows[historyOffset]?.key)
  }, [visibleRows, historyOffset])
  const loadOlder = () => {
    if (historyOffset > 0) setFirstKey(olderHistoryKey(visibleRows, historyOffset))
  }
  const ask = useMemo(() => openAsk(rows), [rows])
  const startedBy = useMemo(
    () => chatId === undefined ? undefined : sessionThreadOf({ projects: workspace.projects, workHandoffs: workspace.workHandoffs, chats: workspace.chats }, chatId),
    [workspace.projects, workspace.workHandoffs, workspace.chats, chatId],
  )
  // A session its thread started stands in its room, so its header names no project (2026-10-11).
  const openStartedBy = useMemo(() => {
    if (startedBy === undefined) return undefined
    const threadChatId = startedBy.threadChatId
    return () => {
      openChat(threadChatId)
      router.push({ pathname: '/chat/[id]', params: { id: threadChatId } })
    }
  }, [startedBy, openChat])
  const sessionOverview = useMemo(
    () => projectThread && chatId !== undefined
      ? projectSessionOverview({
          projects: workspace.projects, chats: workspace.chats, workHandoffs: workspace.workHandoffs, activity: workspace.activity,
          subagents: workspace.subagents, backgroundWork: workspace.backgroundWork, houseSettings: workspace.houseSettings,
        }, chatId)
      : null,
    [projectThread, workspace.projects, workspace.chats, workspace.workHandoffs, workspace.activity, workspace.subagents, workspace.backgroundWork, workspace.houseSettings, chatId],
  )
  // The Sessions button's one dot: the user is needed, a Session finished unseen, or one runs.
  const sessionsMark = useMemo(() => sessionOverview === null ? null : sessionsDot(sessionOverview), [sessionOverview])
  // A thread that stops being a project thread (its project deleted elsewhere) has no overview to show.
  if (overviewOpen && sessionOverview === null) setOverviewOpen(false)
  const threadQuestion = useMemo(
    () => projectThread ? threadQuestionIn(thread.events, { activity: workspace.activity }) : null,
    [projectThread, thread.events, workspace.activity],
  )
  // The card the thread draws for its session's question: the session's title heads every
  // question, so the card says who is asking.
  const threadAsk = useMemo<OpenAsk | null>(
    () => threadQuestion === null ? null : {
      requestId: threadQuestion.requestId,
      agentId: threadQuestion.agentId,
      more: threadQuestion.more,
      questions: threadQuestion.questions.map((question) => ({ ...question, header: `${threadQuestion.title} asks` })),
    },
    [threadQuestion],
  )
  // A subagent's question waits here, at the top of its line: its own screen takes no answers.
  const subagentQuestion = useMemo(
    () => chatId === undefined ? null : openSubagentQuestion({ subagents: workspace.subagents }, chatId),
    [workspace.subagents, chatId],
  )
  const subagentAsk = useMemo<OpenAsk | null>(
    () => subagentQuestion === null ? null : {
      requestId: subagentQuestion.requestId,
      agentId: SUBAGENT_VOICE.id,
      more: subagentQuestion.more,
      questions: subagentQuestion.questions.map((question) => ({ ...question, header: `${subagentQuestion.title} asks` })),
    },
    [subagentQuestion],
  )
  const subagents = useMemo(() => chatSubagents(baseRows), [baseRows])
  const subagentSummary = useCallback(
    (childId: string) => subagentSummaryOf({ subagents: workspace.subagents, threads: workspace.threads }, childId),
    [workspace.subagents, workspace.threads],
  )
  const subagentsRunning = useMemo(() => runningSubagents(subagents, subagentSummary).length, [subagents, subagentSummary])
  const openSubagent = useCallback((callId: string) => {
    if (chatId !== undefined) router.push({ pathname: '/subagent/[callId]', params: { callId, chatId, rootId: chatId } })
  }, [chatId])
  // The rows deep in the list read these from context, so a settled turn learns its
  // helper ended and a wake's notice finds its helper without every row re-rendering.
  const listedSubagents = workspace.subagents
  const directory = useMemo(() => (childId: string) => listedSubagents.find((child) => child.id === childId), [listedSubagents])
  const launches = useMemo<SubagentLaunches>(() => ({
    byCallId: new Map(subagents.flatMap((subagent) => subagent.step.toolCallId === undefined ? [] : [[subagent.step.toolCallId, subagent] as const])),
    open: openSubagent,
  }), [subagents, openSubagent])
  const threadAdvice = useMemo(() => {
    const text = threadQuestion === null ? undefined : threadQuestionAdvice(rows).get(threadQuestion.requestId)
    return text === undefined ? undefined : { by: project?.name ?? 'The project', text }
  }, [threadQuestion, rows, project?.name])
  // An answer the thread gave from a preference, which the user may replace from its line.
  const changeable = useMemo(
    () => projectThread ? changeableAnswers(thread.events) : NO_CHANGEABLE,
    [projectThread, thread.events],
  )
  const [changing, setChanging] = useState<string | null>(null)
  const changingAnswer = changing === null ? undefined : changeable.get(changing)
  const answerChange = useMemo(
    () => changeable.size === 0 ? null : { ids: new Set(changeable.keys()), onChange: setChanging },
    [changeable],
  )
  const changeAsk = useMemo<OpenAsk | null>(
    () => changing === null || changingAnswer === undefined ? null : {
      requestId: `change:${changing}`,
      agentId: changingAnswer.agentId,
      more: 0,
      questions: changingAnswer.questions.map((question) => {
        const given = changingAnswer.answers[question.id]
        return { ...question, header: `${changingAnswer.title}, Manor chose ${given === undefined ? 'nothing' : userInputAnswerText(given)}` }
      }),
    },
    [changing, changingAnswer],
  )
  const activeTurn = thread.liveTurns.find((turn) => turn.state === 'running') ?? null
  // Children outlive the turn that started them, so the chat can wait with no turn running.
  const waiting = useMemo(() => activeTurn === null && chatWaitsOnBackground(rows), [activeTurn, rows])
  const startedAgentIds = useMemo(() => runtimeStartedAgentIds({ events: thread.events, liveTurns: thread.liveTurns }), [thread.events, thread.liveTurns])
  const askTurn = ask === null
    ? null
    : rows.find(
        (row): row is TurnRow =>
          row.kind === 'turn' &&
          row.live?.state === 'running' &&
          row.asks.some((candidate) => candidate.requestId === ask.requestId),
      ) ?? null
  const projectId = chat?.projectId ?? undefined
  const listing = projectId === undefined ? undefined : workspace.repoFiles[repoListingKey(projectId, chatId)]
  const preview = projectId === undefined ? undefined : workspace.repoFilePreviews[repoListingKey(projectId, chatId)]
  const repoFiles = listing?.files
  const replyLinks = useMemo<MarkdownLinks | undefined>(() => {
    if (repoFiles === undefined) return undefined
    return {
      repo: {
        resolve: (href) => resolveMarkdownRepoLink(href, repoFiles) ?? null,
        open: (path) => {
          setFileTarget(path)
          setSheet('files')
        },
      },
    }
  }, [repoFiles])
  // A project chat is open to the household; a dm or group is its members and nobody
  // else, because nobody else can answer there.
  // Placement decides the seats: a Session seats Session personas, a group chat ones.
  const roster = singleChat ? [] : chat?.kind === 'dm' || chat?.kind === 'pair'
    ? workspace.agents.filter((agent) => chat.memberIds.includes(agent.id))
    : roomAgents(workspace.agents, chat)
        .filter((agent) => chat?.kind !== 'group' || chat.memberIds.includes(agent.id))
  // A DM fills his bubbles with her face's colour and a project thread with the
  // project's icon colour; every other room, its Sessions included, keeps the plain cloud.
  // The React Compiler keeps this stable for the memoised transcript rows.
  const tintPersona = chat?.kind === 'dm' ? roster[0] : undefined
  const tintProject = chat === null ? undefined : projectThreadOf(workspace.projects, chat)
  const userBubbleTint = tintPersona !== undefined
    ? avatarBubbleTint(tintPersona)
    : tintProject === undefined ? undefined : projectBubbleTint(tintProject)
  const sessionLeadId = workspace.workHandoffs.find((handoff) => handoff.workChatId === chatId)?.leadAgentId
  // Nothing in a DM's message routes: the server does not parse mentions there at
  // all, so `@Smith` inside Sage's DM is a reference Sage reads, not a summons. The
  // picker offers the other chat personas, and the composer parses against nobody
  // (`roster` below), so the `$` menu keeps reading skills off the DM's own agent.
  const mentionable = chat?.kind === 'dm' && sessionDmAgent === undefined && roster[0] !== undefined
    ? dmReferenceAgents(workspace.agents, roster[0].id)
    : chat !== null && isSoloRoom(chat) ? [] : roster
  /**
   * Who an un-mentioned draft falls back to, which is both what the recipient label
   * restates and who the `$` menu reads skills off. A DM has one addressee and no
   * mentions at all, so it is named here rather than derived from the thread.
   */
  const fallbackTargets = chat === null
    ? undefined
    : isSoloRoom(chat)
      ? roster.slice(0, 1)
      : chatFallbackTargets(chat, thread.events, workspace.agents, sessionLeadId)
  const effectiveFallbackTargets = replyFallbackTargets(
    replyTo,
    workspace.agents,
    fallbackTargets,
    chat?.kind === 'group' ? chat.memberIds : undefined,
  )
  // Who an unmarked draft reaches, as the Mac says next to its plus. Only a thread
  // that has begun earns the label; a running or queued turn makes it unknowable.
  // Read per draft by the composer, which holds the text.
  const recipientsOf = ((): ((draft: string) => AgentConfig[] | 'unknown') | undefined => {
    if (chat === null || singleChat || !composerShowsRecipients(chat.kind, thread.events, thread.pending.length)) return undefined
    const members = chat.kind === 'group' ? chat.memberIds : undefined
    const busy = activeTurn !== null || thread.pending.length > 0
    // Parsed against the whole roster, then filtered to the room, as the server does:
    // an outsider's name in a group, or a chat persona's in a Session, is a mention
    // that reaches nobody, not no mention.
    return (draft) => composerRecipients(draft, workspace.agents, { fallback: effectiveFallbackTargets, memberIds: members, seats: roomAgents(workspace.agents, chat), busy, replying: replyTo !== undefined })
  })()

  /**
   * Everything this chat has written, across every turn in it. A turn's own card
   * scrolls away with the turn; this is the running total the pill above the
   * composer states, and what its sheet opens to.
   */
  const chatChanges = useMemo(
    () =>
      chatChangedFiles(rows.filter((row): row is TurnRow => row.kind === 'turn'), listing?.files),
    [listing?.files, rows],
  )
  // A project thread does no code work of its own, so it states no changed files.
  const showAggregateChanges = chat?.kind !== 'dm' && !projectThread && chatChanges.length > 0

  const jumpToLatest = () => {
    setJumpForChat(null)
    void listRef.current?.scrollToEnd({ animated: true })
  }
  // A send from near the end is followed by the list's own pin to the end. Any scroll of
  // ours would race it: until that scroll settles, the list drops its pin for the new row,
  // the reply and the working indicator. From further up the send jumps once its row is in.
  const followSend = useRef(false)
  useEffect(() => {
    if (!followSend.current) return undefined
    const frame = requestAnimationFrame(() => {
      followSend.current = false
      void listRef.current?.scrollToEnd({ animated: false })
    })
    return () => cancelAnimationFrame(frame)
  }, [pageRows])

  // Scrolls to the row that draws a target. A target folded into a bundle opens it first;
  // the scroll then waits for it to draw and lands on the bundle's top, its items below.
  // `holds` picks the item inside a bundle the jump lands on; its line opens too.
  const scrollToHolder = useCallback((holder: Row, holds: ((item: Row) => boolean) | undefined, position: { viewPosition: number; viewOffset?: number }, animated = true) => {
    const unfold = holder.kind === 'thread_bundle' && holds !== undefined
    if (unfold) setOpenBundles((current) => openThreadBundleAt(current, stretchRef.current, holder, holds))
    const place = unfold ? { viewPosition: 0 } : position
    const scroll = (index: number) => void listRef.current?.scrollToIndex({ animated, index, ...place })
    const later = (index: number) => requestAnimationFrame(() => unfold ? requestAnimationFrame(() => scroll(index)) : scroll(index))
    const visibleAt = pageRows.findIndex((row) => row.key === holder.key)
    if (visibleAt >= 0) {
      if (unfold) later(visibleAt)
      else scroll(visibleAt)
      return
    }
    setFirstKey(holder.key)
    later(0)
  }, [pageRows])

  // The message a jump landed on, washed for a moment so the eye finds it.
  const [landed, setLanded] = useState<{ eventId: string; id: number } | null>(null)
  const landings = useRef(0)
  useEffect(() => {
    if (landed === null) return undefined
    const timer = setTimeout(() => setLanded(null), LANDING_WASH_MS)
    return () => clearTimeout(timer)
  }, [landed])

  const openQuoteSource = useCallback((eventId: string, animated = true) => {
    const holder = visibleRows.find((row) => rowHasQuoteSource(row, eventId))
    if (holder === undefined) return
    scrollToHolder(holder, (item) => rowHasQuoteSource(item, eventId), { viewPosition: 0.5 }, animated)
    landings.current += 1
    setLanded({ eventId, id: landings.current })
  }, [scrollToHolder, visibleRows])

  // The same call for the memoized rows: `visibleRows` is new on every event in the thread.
  const openQuoteSourceRef = useRef(openQuoteSource)
  useEffect(() => {
    openQuoteSourceRef.current = openQuoteSource
  }, [openQuoteSource])
  const openQuoteSourceStable = useCallback((eventId: string) => openQuoteSourceRef.current(eventId), [])

  const revealRow = useCallback((rowKey: string) => {
    const holder = visibleRows[feedIndexOf(visibleRows, rowKey)]
    if (holder !== undefined) scrollToHolder(holder, holder.key === rowKey ? undefined : (item) => item.key === rowKey, { viewPosition: 0.5 })
  }, [scrollToHolder, visibleRows])
  // The same call for the memoized rows, which must not re-render on every new message.
  const revealRowRef = useRef(revealRow)
  useEffect(() => {
    revealRowRef.current = revealRow
  }, [revealRow])
  const revealRowStable = useCallback((rowKey: string) => revealRowRef.current(rowKey), [])

  // Show in chat from a DM's Files, or a message picked in Search, lands on the row
  // holding that event at once, like following a link. A chat that just opened waits
  // until its thread holds the event; leaving the chat first drops the jump.
  const eventReveal = useRef<string | null>(null)
  const revealHeldEvent = useCallback(() => {
    const eventId = eventReveal.current
    if (eventId === null || !visibleRows.some((row) => rowHasQuoteSource(row, eventId))) return
    eventReveal.current = null
    requestAnimationFrame(() => openQuoteSourceRef.current(eventId, false))
  }, [visibleRows])
  const revealHeldEventRef = useRef(revealHeldEvent)
  useEffect(() => {
    revealHeldEventRef.current = revealHeldEvent
    revealHeldEvent()
  }, [revealHeldEvent])
  useFocusEffect(useCallback(() => {
    if (chatId === undefined) return
    const eventId = takeEventReveal(chatId)
    if (eventId !== null) {
      eventReveal.current = eventId
      revealHeldEventRef.current()
    }
    return () => {
      eventReveal.current = null
    }
  }, [chatId]))

  // The open Session cards measured out of view, which the bar lists. Null until this
  // chat has measured, so the bar never shows rows it will drop. Measured against the
  // part of the screen between the header and the bar or composer, both of which float
  // over the list; rows the list has not rendered count as out of view.
  const [cardsOut, setCardsOut] = useState<{ chatId: string | undefined; keys: ReadonlySet<string> } | null>(null)
  const workDockRef = useRef<View>(null)
  const measureRound = useRef(0)
  const workDockHeight = useRef(-1)
  const openCardKeys = useMemo(
    () => pageRows.flatMap((row) => row.kind === 'work_handoff' && workDecisionOpen(row) ? [row.key] : []),
    [pageRows],
  )
  const workCardsInView = useMemo(
    () => cardsOut !== null && cardsOut.chatId === chatId ? cardsShownInThread(openCardKeys, cardsOut.keys) : null,
    [cardsOut, chatId, openCardKeys],
  )
  const headerFloor = insets.top + CHAT_HEADER_HEIGHT
  // The card whose Request changes field is being written stands in the composer's place.
  // Only on the screen in front, which is where the field's keyboard is.
  const dockedId = useDockedWorkChanges()
  const dockedRow = dockedId === null || covered ? undefined
    : rows.find((row): row is WorkHandoffRow => row.kind === 'work_handoff' && row.handoffId === dockedId && workChangesDockable(row))
  // From just under the header down to the footer's floor, a footer gap above the keys.
  const dockedMaxHeight = windowHeight - keyboardHeight - FOOTER_GAP - headerFloor - spacing.sm
  // Settling is the measurement in the frame after the rows changed, before the list has
  // pinned its end; every other measurement takes the cards where they are.
  const measureWorkCards = useCallback((settling = false) => {
    const round = (measureRound.current += 1)
    const report = (keys: ReadonlySet<string>) => {
      if (round !== measureRound.current) return
      setCardsOut((current) => current !== null && current.chatId === chatId && sameKeys(current.keys, keys) ? current : { chatId, keys })
    }
    const state = listRef.current?.getState()
    if (openCardKeys.length === 0 || state === undefined) {
      report(new Set())
      return
    }
    void Promise.all([
      measureInWindow(workDockRef.current),
      ...openCardKeys.map((key) => {
        const index = state.indexByKey(key)
        return measureInWindow(index === undefined ? undefined : state.elementAtIndex(index))
      }),
    ]).then(([floor, ...cards]) => {
      if (floor === undefined) return
      const view = { top: headerFloor, bottom: floor.top }
      // Read when the measurement lands, which is when the cards were placed.
      const settlingAtEnd = settling && listRef.current?.getState().isWithinMaintainScrollAtEndThreshold === true
      report(new Set(openCardKeys.filter((_, index) => workCardOut(cards[index], view, settlingAtEnd))))
    })
  }, [chatId, headerFloor, openCardKeys])
  useEffect(() => {
    // After the list has laid the new rows out.
    const frame = requestAnimationFrame(() => measureWorkCards(true))
    return () => cancelAnimationFrame(frame)
  }, [measureWorkCards])
  // The jump centres the row that holds a landed message; in a turn taller than the
  // screen the message itself can still sit out of view, so its top comes under the header.
  const onLanded = useCallback((view: View) => {
    void Promise.all([measureInWindow(view), measureInWindow(footerRef.current)]).then(([message, footer]) => {
      const state = listRef.current?.getState()
      if (message === undefined || state === undefined) return
      const floor = headerFloor + spacing.lg
      if (message.top >= floor && message.bottom <= (footer?.top ?? Number.POSITIVE_INFINITY)) return
      void listRef.current?.scrollToOffset({ animated: true, offset: Math.max(0, state.scroll + message.top - floor) })
    })
  }, [headerFloor])
  const landedMessage = useMemo<LandedMessage | null>(() => landed === null ? null : { ...landed, onLanded }, [landed, onLanded])

  // Where a DM message leaves from and where its row will rest, read before the field
  // clears. Both sit in the keyboard's footer, so a keyboard shift the layout has not
  // caught up with yet cancels out of the difference.
  const measureFlight = () => {
    const field = measureNow(fieldRef.current)
    const footer = measureNow(footerRef.current)
    const screen = measureNow(screenRef.current)
    if (field === undefined || footer === undefined || screen === undefined) return undefined
    // The face comes in under a DM send, if it is not there already.
    const slotBottom = footer.y - FEED_END_GAP - DM_FACE_ROOM
    return {
      dx: field.x + field.width - (screen.x + screen.width - spacing.lg),
      dy: field.y + field.height - slotBottom,
      field: { x: field.x - screen.x, y: field.y - screen.y, width: field.width, height: field.height },
      // The bubble's widest, from the feed's padding and the bubble's own, as the chat styles them.
      textWidth: (screen.width - spacing.lg * 2) * SENT_BUBBLE_SHARE - SENT_BUBBLE_PAD.x * 2,
    }
  }

  const submit = (text: string, images: ImageAttachment[], textFiles: StagedFile[]) => {
    const placed = placeQuotesAfterText({ text, ...(quote === undefined ? {} : { quote }) })
    // Only from the end of the chat: scrolled up, the send keeps its jump.
    const plain = images.length === 0 && textFiles.length === 0 && replyTo === undefined && quote === undefined
    const flight = chat?.kind === 'dm' && !still && !showJump && plain && text.trim() !== '' ? measureFlight() : undefined
    if (chatId === undefined || !sendMessage(chatId, placed.text, images, textFiles, replyTo, placed.quotes)) return false
    if (flight !== undefined) {
      const id = requestFlight(arrivalMotion, flight.dx, flight.dy)
      setFieldFlight({ id, text, field: flight.field, textWidth: flight.textWidth })
      setTimeout(() => setFieldFlight((current) => current?.id === id ? null : current), FIELD_FLIGHT_MS)
    }
    setReplyTo(undefined)
    setQuote(undefined)
    writeDraft(chatId, EMPTY_DRAFT)
    if (showJump) followSend.current = true
    setJumpForChat(null)
    return true
  }

  const showJumpFor = (scroll: TranscriptScroll) => {
    const nearEnd = readsLatest(scroll)
    setJumpForChat((current) => {
      const away = current === chatId
      if (nearEnd === !away) return current
      return nearEnd ? null : (chatId ?? null)
    })
  }
  // The last scroll, so a change in content height alone (a turn folding its steps) is judged too.
  const lastScroll = useRef<TranscriptScroll | null>(null)
  const trackScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement, contentInset } = event.nativeEvent
    lastScroll.current = { offset: contentOffset.y, viewport: layoutMeasurement.height, content: contentSize.height, insetEnd: contentInset?.bottom ?? 0 }
    showJumpFor(lastScroll.current)
    measureWorkCards()
  }
  // Only ever hides: content that grows at the end is followed by the list, whose scroll
  // event judges it, and showing here first would flash the button on every streamed line.
  const trackContentHeight = (_width: number, height: number) => {
    if (lastScroll.current === null) return
    lastScroll.current = { ...lastScroll.current, content: height }
    if (readsLatest(lastScroll.current)) setJumpForChat(null)
  }

  const list = () => {
    if (projectId !== undefined) listRepoFiles(projectId, chatId)
  }

  // Re-listed on open rather than cached for the session: the listing is one
  // `git ls-files`, and a `@` menu offering files that were renamed an hour ago is
  // worse than the round trip. The folder list is in the key, so unlinking a folder
  // stops offering its files, and so is the checkout, so isolating this chat from
  // the Mac re-lists the worktree instead of leaving the old branch on offer.
  const repoKey = `${project?.repoPaths.join('\0') ?? ''}\0${chat?.checkout.mode ?? ''}\0${chat?.checkout.branch ?? ''}`
  useEffect(() => {
    if (status !== 'live' || projectId === undefined) return
    listRepoFiles(projectId, chatId)
  }, [chatId, listRepoFiles, projectId, repoKey, status])
  // A worktree Session's goal note names the branch its Confirm merges into, which only
  // the checkout status carries. The composer here has no checkout row asking for it.
  const worktreeChatId = chat?.kind === 'project' && chat.checkout.mode === 'worktree' ? chat.id : undefined
  useEffect(() => {
    if (status !== 'live' || worktreeChatId === undefined) return
    askCheckoutStatus(worktreeChatId)
  }, [askCheckoutStatus, repoKey, status, worktreeChatId])
  const read = (path: string) => {
    if (projectId !== undefined) readRepoFile(projectId, path, chatId)
  }

  // Named once, so a row the list redraws for its context alone keeps its props and `memo` holds.
  const openAgentRelay = useCallback((pairChatId: string) => {
    openChat(pairChatId)
    router.push({ pathname: '/chat/[id]', params: { id: pairChatId } })
  }, [openChat])
  const quoteSource = useCallback(
    (source: QuoteSelectionSource) => setQuoteSelection({ ...source, text: plainDraftText(source.text) }),
    [setQuoteSelection],
  )

  if (chatId === undefined) return null

  /**
   * Who the header names. A DM is one persona, so it says her: her face, name and
   * role, which open her overview. A group is its own name with everyone in it under
   * that. Every other chat keeps saying where it lives, because there the project is
   * the identity.
   */
  const dmAgent = chat?.kind === 'dm' ? roster[0] : undefined
  // Auto never claims a DM (the server skips it), so its pin reads as Auto off: the
  // labels and the sheet then name the model the agent runs on.
  const dmOverride = { ...(dmAgent === undefined ? undefined : thread.overrides[dmAgent.id]), auto: false }
  // A Single Session names its runtime instead of its project (2026-11-12), so a model
  // change shows where the eye already is. A Multiple Session has no one runtime.
  const singleDefault = defaultSingleRuntime(workspace.agents)
  const browserChat = chat?.kind === 'browser'
  const singleOverride = singleChatOverride(chat?.kind ?? 'project', thread.overrides[SINGLE_CHAT_VOICE.id] ?? {}, singleDefault)
  const singleVoice = singleRuntimeVoice(readSingleRuntime(singleOverride, singleDefault))
  const sessionRuntime = chat?.kind === 'project' && singleChat && !projectThread ? singleVoice : undefined
  const memberNames = chat?.kind === 'group'
    ? chat.memberIds.map((id) => personaOf(workspace.agents, id).name).join(', ')
    : undefined
  const pairTitle = chat?.kind === 'pair'
    ? chat.memberIds.map((id) => personaOf(workspace.agents, id).name).join(' and ')
    : undefined
  // A DM's header names her instead (see ChatHeader), so no line under it.
  const lead =
    sessionRuntime !== undefined
      ? runtimeLabel(singleVoice, singleOverride, hostAuto)
      : memberNames ?? (project !== undefined && isHomeRoom(project.id) ? 'No project' : project?.name) ?? (chat?.kind === 'side' ? 'Side chat' : 'Chat')
  // The Mac's name lives in the side menu only; a connection that is not live
  // still earns the line.
  const connection = status === 'live' ? null : status === 'connecting' ? 'Connecting…' : 'Offline'
  // The composer's model chip: the one runtime that answers here. A Single Session and a
  // project thread run the anonymous voice, a DM its persona; a room with several has none.
  const composerModelOf = (agent: AgentConfig, override: ChatOverride) => {
    const parts = runtimeParts(agent, override, hostAuto)
    return {
      label: parts.model,
      effort: parts.effort,
      ...(isAutoPending(agent, override, hostAuto) ? {} : { driver: effectiveDriver(agent, override) }),
      onPress: () => setSheet('model'),
    }
  }
  const composerModel = singleChat
    ? composerModelOf(singleVoice, singleOverride)
    : dmAgent !== undefined && sessionDmAgent === undefined
      ? composerModelOf(dmAgent, dmOverride)
      : undefined
  const subtitle = pairTitle === undefined ? (connection === null ? lead : `${lead}, ${connection}`) : (connection ?? 'Between agents')
  const topInset = insets.top + CHAT_HEADER_HEIGHT + spacing.lg

  const connected = status === 'live'

  return (
    <SubagentDirectory.Provider value={directory}>
    <SubagentLaunchesContext.Provider value={launches}>
    <AnswerChange.Provider value={answerChange}>
    <TranscriptCovered.Provider value={transcriptCovered}>
    <ThreadPager
      enabled={sessionOverview !== null}
      onOpenChange={setOverviewOpen}
      open={overviewOpen}
      page={sessionOverview === null || chatId === undefined ? null : (
        <ProjectSessionsPage
          agents={workspace.agents}
          onBack={() => setOverviewOpen(false)}
          onOpen={(id) => {
            openChat(id)
            router.push({ pathname: '/chat/[id]', params: { id } })
          }}
          onRevealProposal={(rowKey) => {
            // A proposal has no chat of its own: its card, with Accept, sits in the thread.
            setOverviewOpen(false)
            revealRow(rowKey)
          }}
          overview={sessionOverview}
          {...(project === undefined ? {} : { projectName: project.name })}
          threadId={chatId}
        />
      )}
    >
    <View ref={screenRef} style={styles.screen}>
      <LandedMessageContext.Provider value={landedMessage}>
      <ThreadSwipeArea>
      <LiveTranscript
        chatId={chatId}
        listRef={listRef}
        sessionLive={sessionLive}
        projectThread={projectThread}
        firstKey={firstKey}
        onLoadOlder={loadOlder}
        openBundles={openBundles}
        onBundleOpen={setBundleOpen}
        connected={connected}
        covered={transcriptCovered}
        links={replyLinks}
        draftActions={draftActions}
        repoFiles={repoFiles}
        userBubbleTint={userBubbleTint}
        topInset={topInset}
        keyboardSink={keyboardSink}
        contentInsetEndAdjustment={contentInsetEndAdjustment}
        freeze={freeze}
        onScroll={trackScroll}
        onContentSizeChange={trackContentHeight}
        onOpenAgentRelay={openAgentRelay}
        onRejectWork={rejectWork}
        onReveal={revealRowStable}
        onOpenSubagent={openSubagent}
        onOpenQuoteSource={openQuoteSourceStable}
        onReply={chooseReply}
        onReact={react}
        onQuoteSource={quoteSource}
        {...(chat?.kind === 'dm' ? { arrival: { motion: arrivalMotion, still, followEnd: !showJump, flightId: fieldFlight?.id ?? 0 } } : {})}
      />
      </ThreadSwipeArea>
      </LandedMessageContext.Provider>

      <ChatHeader
        agentIds={chat?.kind === 'pair' ? chat.memberIds : chat?.agentIds ?? []}
        agents={workspace.agents}
        {...(chat?.kind === 'pair' ? { pair: chat.memberIds.flatMap((id) => workspace.agents.filter((agent) => agent.id === id)) } : {})}
        {...(sessionRuntime !== undefined && !isAutoPending(sessionRuntime, singleOverride, hostAuto) ? { driver: effectiveDriver(sessionRuntime, singleOverride) } : {})}
        {...(isPair || singleChat || chat?.kind === 'side' || chat?.kind === 'dm' ? {} : { onAgents: () => setSheet('agents') })}
        {...(dmAgent === undefined ? {} : { dm: {
          agent: dmAgent,
          onOverview: () => router.push({ pathname: '/agent/[chatId]', params: { chatId } }),
          onFiles: () => router.push({ pathname: '/files/[chatId]', params: { chatId } }),
        } })}
        {...(chat?.kind === 'dm' || projectThread || subagents.length === 0 ? {} : { onSubagents: () => setSheet('subagents'), subagentsRunning })}
        onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))}
        subtitle={subtitle}
        {...(chat?.kind === 'project' && project !== undefined && startedBy === undefined ? { project } : {})}
        projectThread={projectThread}
        {...(sessionOverview === null || chatId === undefined ? {} : { onSessions: () => setOverviewOpen(true), sessionsDot: sessionsMark })}
        {...(projectThread && project !== undefined ? { onProject: () => setSheet('settings') } : {})}
        {...(chat?.kind === 'project' && !projectThread && chat.archivedAt === null && !sitsSettled(workspace, chat) ? { onSettle: () => setChatSettled(chat.id, true) } : {})}
        title={dmAgent?.name ?? pairTitle ?? (chat == null ? 'Chat' : withSessionTitle(chat).title)}
      />

      {/* A settled chat reads as history, so it says so where the transcript starts
          and offers the way back to the inbox's active list. Keyed on the chat's own
          state: settling from the Mac while this screen is open lands here too. */}
      {chat !== null && sitsSettled(workspace, chat) ? (
        <Animated.View
          entering={glassRise}
          exiting={glassSink}
          style={[styles.settledBanner, { top: insets.top + CHAT_HEADER_HEIGHT + spacing.xs }]}
        >
          <GlassSurface fallbackStyle={styles.floatingFallback} radius={22} style={styles.settledPill}>
            <Text style={styles.settledText}>Settled</Text>
            <View style={styles.settledDivider} />
            <Pressable
              accessibilityLabel="Unsettle"
              accessibilityRole="button"
              hitSlop={6}
              onPress={() => setChatSettled(chatId, false)}
              style={({ pressed }) => [styles.settledAction, pressed && styles.pressed]}
            >
              <HugeiconsIcon color={colors.text} icon={Undo02Icon} size={16} strokeWidth={1.8} />
              <Text style={styles.settledActionText}>Unsettle</Text>
            </Pressable>
          </GlassSurface>
        </Animated.View>
      ) : null}

      <KeyboardFooter enabled={keyboardUp && !isPair} padded={false} sink={keyboardSink} style={styles.footer}>
      <View
        onLayout={(event) => {
          // A card in the composer's place overlays its own slot in the thread, so the list
          // keeps the composer's floor and nothing in it moves, there or on the way back.
          if (dockedRow !== undefined) return
          const height = Math.round(event.nativeEvent.layout.height)
          // The keyboard view takes a shrink off the offset without stopping at the top,
          // which sinks a short chat below the composer when a question card closes.
          const closing = height < footerHeight && !showJump && pageRows.length > 0
          if (closing) freeze.set(true)
          setFooterHeight(height)
          contentInsetEndAdjustment.set(height)
          if (closing) void scrollMessageToEnd({ animated: false, closeKeyboard: false })
        }}
        pointerEvents="box-none"
        ref={footerRef}
      >
        <EdgeScrim edge="bottom" height={footerHeight} />
        {/* The padding sits inside the measured view, so the list's bottom inset counts the
            gap above the tab bar, and outside the scrim, which keeps the screen's width. */}
        <Animated.View pointerEvents="box-none" style={footerPadding}>
        {/* One row above the Session bar for the changes pill. The pill stands for as long as
            the chat has written anything, so it belongs in the footer's own height, where the
            list's bottom inset accounts for it. The jump floats centred over that row, because
            it comes and goes with the scroll and nothing should shift under a thumb when it
            does; card actions sit at the right, so the centre keeps it off Accept. */}
        <View pointerEvents="box-none">
          {showAggregateChanges && dockedRow === undefined ? (
            <Animated.View entering={glassRise} exiting={glassSink} style={styles.pill}>
              <EditsPill files={chatChanges} onPress={() => setAllEditsOpen(true)} />
            </Animated.View>
          ) : null}
          {showJump && dockedRow === undefined ? (
            <Animated.View entering={glassRise} exiting={glassSink} pointerEvents="box-none" style={styles.jump}>
              <GlassIconButton
                accessibilityLabel="Jump to latest"
                icon={ArrowDown01Icon}
                onPress={jumpToLatest}
                size={JUMP_SIZE}
              />
            </Animated.View>
          ) : null}
        </View>
        {/* The Session bar stands in the footer (2026-10-12), so the list's bottom
            inset counts it and no message ever sits behind Accept or Confirm. */}
        <View
          ref={workDockRef}
          onLayout={(event) => {
            // Only a new height can change which cards it covers; the side inset animates
            // the width on every keyboard frame and is not worth a measurement each time.
            const height = event.nativeEvent.layout.height
            if (height === workDockHeight.current) return
            workDockHeight.current = height
            measureWorkCards()
          }}
          pointerEvents="box-none"
        >
          {isPair || sessionDmAgent !== undefined || dockedRow !== undefined ? null : (
            <WorkDecisionDock
              rows={sessionReady === undefined ? rows : [sessionReady]}
              inView={workCardsInView}
              agents={workspace.agents}
              onReject={rejectWork}
              onReveal={(rowKey) => {
                // The phone has no diff: a Session's own Ready row leads to its card in the
                // briefing DM, where Request changes writes and the result reads in full.
                const source = sessionReady?.key === rowKey ? workspace.workHandoffs.find((handoff) => handoff.id === sessionReady.handoffId)?.sourceChatId : undefined
                if (source === undefined) revealRow(rowKey)
                else router.push({ pathname: '/chat/[id]', params: { id: source } })
              }}
              onRequestChanges={(row) => {
                // The card comes into the composer's place to take what should change; a
                // Session's own Ready row writes it on the card in the briefing DM.
                openWorkChanges(row.handoffId)
                const source = sessionReady?.key === row.key ? workspace.workHandoffs.find((handoff) => handoff.id === row.handoffId)?.sourceChatId : undefined
                if (source !== undefined) router.push({ pathname: '/chat/[id]', params: { id: source } })
              }}
            />
          )}
        </View>
        <View style={styles.footerInner}>
          {dockedRow !== undefined ? (
            // In the composer's place while its field is written, and before any question:
            // the field was just picked, and its slot in the thread stays empty meanwhile.
            <WorkHandoffCard
              row={dockedRow}
              agents={workspace.agents}
              onReject={rejectWork}
              onReveal={revealRow}
              inThread={projectThread && project !== undefined}
              docked={{ maxHeight: dockedMaxHeight }}
            />
          ) : isPair || sessionDmAgent !== undefined ? (
            <View style={styles.pairFooter}>
              <View style={styles.pairNotice}>
                <HugeiconsIcon color={colors.muted} icon={LockIcon} size={15} strokeWidth={1.8} />
                <Text style={styles.pairNoticeText}>{sessionDmAgent === undefined ? 'This chat is view-only' : `${sessionDmAgent.name} works in Sessions now`}</Text>
              </View>
              {activeTurn === null ? null : (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => stopTurn(activeTurn.turnId)}
                  style={({ pressed }) => [styles.closeChat, pressed && styles.pressed]}
                >
                  <Text style={styles.stopChatText}>Stop</Text>
                </Pressable>
              )}
              <Pressable accessibilityRole="button" onPress={() => router.back()} style={({ pressed }) => [styles.closeChat, pressed && styles.pressed]}>
                <Text style={styles.closeChatText}>Close Chat</Text>
              </Pressable>
            </View>
          ) : ask !== null && openStartedBy !== undefined ? (
            // The question waits in the project thread, so this says where.
            <WaitingDock onOpen={openStartedBy} />
          ) : changeAsk !== null && changingAnswer !== undefined ? (
            // Before any waiting question, because he just asked for it. It leaves once the
            // thread records the change; a refusal comes back as a notice and Cancel closes it.
            <AskCard
              ask={changeAsk}
              onAnswer={(answers) => {
                // Manor's own answer picked again changes nothing, so nothing goes to the Session.
                const changed = Object.fromEntries(Object.entries(answers).filter(([id, value]) => {
                  const given = changingAnswer.answers[id]
                  return given === undefined || userInputAnswerText(value) !== userInputAnswerText(given)
                }))
                if (Object.keys(changed).length > 0) return changeSessionAnswer(chatId, changingAnswer.requestId, changed)
                setChanging(null)
                return false
              }}
              onCancel={() => setChanging(null)}
            />
          ) : ask !== null && askTurn !== null && ask.questions[0]?.secret !== undefined ? (
            <SecretCard
              key={ask.requestId}
              question={ask.questions[0]}
              who={workspace.agents.find((agent) => agent.id === ask.agentId)?.name ?? 'An agent'}
              onAnswer={(value) => answerSecretRequest(chatId, ask.requestId, value)}
              onStop={() => stopTurn(askTurn.turnId)}
            />
          ) : ask !== null && askTurn !== null ? (
            <AskCard
              ask={ask}
              onAnswer={(answers) => answerUserInput(chatId, ask.requestId, answers)}
              onStop={() => stopTurn(askTurn.turnId)}
            />
          ) : ask === null && threadQuestion !== null && threadQuestion.questions[0]?.secret !== undefined ? (
            <SecretCard
              key={threadQuestion.requestId}
              question={threadQuestion.questions[0]}
              who={threadQuestion.title}
              onAnswer={(value) => answerSecretRequest(threadQuestion.sessionChatId, threadQuestion.requestId, value)}
              onStop={() => {
                const turnId = activityOf(workspace, threadQuestion.sessionChatId).runningTurns[0]
                if (turnId !== undefined) stopTurn(turnId)
              }}
            />
          ) : ask === null && threadQuestion !== null && threadAsk !== null ? (
            <AskCard
              ask={threadAsk}
              {...(threadAdvice === undefined ? {} : { advice: threadAdvice })}
              // Answered on the session's own chat, where its turn is held.
              onAnswer={(answers) => answerUserInput(threadQuestion.sessionChatId, threadQuestion.requestId, answers)}
              onStop={() => {
                const turnId = activityOf(workspace, threadQuestion.sessionChatId).runningTurns[0]
                if (turnId !== undefined) stopTurn(turnId)
              }}
            />
          ) : ask === null && subagentQuestion !== null && subagentAsk !== null ? (
            <AskCard
              ask={subagentAsk}
              // Answered on the child's own chat, where its turn is held.
              onAnswer={(answers) => answerUserInput(subagentQuestion.childChatId, subagentQuestion.requestId, answers)}
            />
          ) : (
            <ChatComposer
              chatId={chatId}
              fieldRef={fieldRef}
              {...(chat === null || replyTo !== undefined || quote !== undefined ? {} : { commandContext: () => chatCommandContext(chat, project, thread?.events ?? [], workspace.workHandoffs,
                activeTurn !== null || sessionLive(chat.id).running || waiting || (thread?.pending.length ?? 0) > 0) })}
              busy={activeTurn !== null || waiting}
              disabled={status !== 'live'}
              {...(effectiveFallbackTargets === undefined ? {} : { fallbackTargets: [...effectiveFallbackTargets] })}
              files={listing?.files ?? []}
              filesTruncated={listing?.truncated ?? false}
              {...(chat?.kind === 'group' ? { memberIds: chat.memberIds } : { })}
              mentionable={mentionable}
              allowWorkDestination={!singleChat && chat?.kind === 'dm'}
              allSkillsAvailable={singleChat}
              {...(contextMeter === undefined ? {} : { contextMeter })}
              {...(composerModel === undefined ? {} : { model: composerModel })}
              roster={chat !== null && isSoloRoom(chat) ? [] : workspace.agents}
              {...(recipientsOf === undefined ? {} : { recipientsOf })}
              onSend={submit}
              onStop={() => {
                // A turn's Stop also ends the chat's background work on the server.
                if (activeTurn !== null) stopTurn(activeTurn.turnId)
                else if (waiting) stopBackground(chatId)
              }}
              placeholder={status !== 'live' ? 'Manor is offline' : projectThread ? 'Reply…' : 'Ask anything…'}
              {...(replyTo === undefined
                ? {}
                : {
                    replyTo,
                    replyName: personaOf(workspace.agents, replyTo.agentId).name,
                    onRemoveReply: removeReply,
                  })}
              {...(quote === undefined ? {} : { quote, onRemoveQuote: removeQuote })}
              // A side chat runs no skill: the server does not read `$` there at all,
              // because half of what is pasted into one is somebody else's text. No
              // skills means the trigger stays the character it is.
              skills={chat?.kind === 'side' ? NO_SKILLS : workspace.skills}
            />
          )}
        </View>
        </Animated.View>
      </View>
      </KeyboardFooter>
      {fieldFlight === null || userBubbleTint === undefined ? null : (
        <SendFlightField flight={fieldFlight} key={fieldFlight.id} motion={arrivalMotion} tint={userBubbleTint} />
      )}

      {isPair || singleChat || chat?.kind === 'side' || chat?.kind === 'dm' ? null : <RuntimeSheet
        {...(chat !== null && chat.agentIds.length > 0 ? { activeAgentIds: chat.agentIds } : {})}
        agents={roster}
        startedAgentIds={startedAgentIds}
        disabled={status !== 'live'}
        onChange={(agentId, override) => setChatOverride(chatId, agentId, override)}
        onClose={() => setSheet(null)}
        open={sheet === 'agents'}
        overrides={thread.overrides}
      />}
      <SubagentsSheet
        onClose={() => setSheet(null)}
        onOpen={openSubagent}
        onStop={(toolCallId) => stopSubagent(chatId, toolCallId)}
        open={sheet === 'subagents'}
        subagents={subagents}
        summary={subagentSummary}
      />
      {singleChat ? (
        <SingleRuntimeSheet
          open={sheet === 'model'}
          override={singleOverride}
          fallback={singleDefault}
          allowAuto={!browserChat && !startedAgentIds.includes(SINGLE_CHAT_VOICE.id) && singleOverride.autoResolved !== true}
          disabled={status !== 'live'}
          onChange={(override) => setChatOverride(chatId, SINGLE_CHAT_VOICE.id, override)}
          onClose={() => setSheet(null)}
        />
      ) : dmAgent === undefined ? null : (
        <AgentRuntimeSheet
          open={sheet === 'model'}
          agent={dmAgent}
          override={dmOverride}
          allowAuto={false}
          disabled={status !== 'live'}
          onChange={(override) => setChatOverride(chatId, dmAgent.id, override)}
          onClose={() => setSheet(null)}
        />
      )}
      {chat?.kind === 'dm' ? null : (
        <DiffSheet files={chatChanges} onClose={() => setAllEditsOpen(false)} open={allEditsOpen} />
      )}
      <FilesSheet
        agents={workspace.agents}
        files={listing}
        key={fileTarget ?? 'files'}
        live={status === 'live'}
        onClose={() => {
          setFileTarget(null)
          setSheet(null)
        }}
        onList={list}
        onRead={read}
        open={sheet === 'files'}
        preview={preview}
        projectName={project === undefined ? 'Project' : isHomeRoom(project.id) ? 'Memory' : project.name}
        targetPath={fileTarget}
      />
      {!projectThread || project === undefined ? null : (
        <ProjectSettingsSheet
          onClose={() => setSheet(null)}
          onDeleted={() => (router.canDismiss() ? router.dismissAll() : router.replace('/'))}
          onDismiss={() => {
            if (!filesAfterSettings.current) return
            filesAfterSettings.current = false
            setSheet('files')
          }}
          {...(project.repoPaths.length === 0 ? {} : { onFiles: () => {
            setFileTarget(null)
            if (Platform.OS === 'ios') {
              filesAfterSettings.current = true
              setSheet(null)
            } else setSheet('files')
          } })}
          open={sheet === 'settings'}
          project={project}
        />
      )}
      <QuoteSelectionSheet
        key={quoteSelection?.eventId ?? 'closed'}
        source={quoteSelection}
        onClose={() => setQuoteSelection(null)}
        onQuote={chooseQuote}
      />
    </View>
    </ThreadPager>
    </TranscriptCovered.Provider>
    </AnswerChange.Provider>
    </SubagentLaunchesContext.Provider>
    </SubagentDirectory.Provider>
  )
}

type ChatComposerProps = Omit<ComposerProps, 'draft' | 'onChangeDraft' | 'images' | 'onChangeImages' | 'textFiles' | 'onChangeTextFiles' | 'onSend' | 'recipients'> & {
  chatId: string
  /** Who a draft reaches if sent now. `'unknown'` and absent mean what they mean on `Composer`. */
  recipientsOf?: (draft: string) => AgentConfig[] | 'unknown'
  /** Says whether the message left: a refused send keeps what was typed and staged. */
  onSend: (text: string, images: ImageAttachment[], files: StagedFile[]) => boolean
}

/**
 * The composer of an open chat. It holds what is typed and staged, so a keystroke
 * redraws the composer and not the screen around it.
 *
 * A draft belongs to its conversation, not to this screen: walking back to the list
 * unmounts the transcript, and what was typed has to be there on the way in again.
 * Written through on every change rather than parked on the way out, because the way
 * out is a route disappearing and not an event this screen gets to see. An ask card
 * that takes the composer's place is the same case.
 */
function ChatComposer({ chatId, recipientsOf, onSend, ...composer }: ChatComposerProps) {
  const [draft, setDraft] = useState(() => readDraft(chatId).text)
  const [images, setImages] = useState(() => readDraft(chatId).images)
  const [textFiles, setTextFiles] = useState(() => readDraft(chatId).files)
  const changeDraft = (text: string) => {
    setDraft(text)
    writeDraft(chatId, { ...readDraft(chatId), text })
  }
  const changeImages = (next: ImageAttachment[]) => {
    setImages(next)
    writeDraft(chatId, { ...readDraft(chatId), images: next })
  }
  const changeTextFiles = (next: StagedFile[]) => {
    setTextFiles(next)
    writeDraft(chatId, { ...readDraft(chatId), files: next })
  }
  const send = (text: string) => {
    if (!onSend(text, images, textFiles)) return
    setDraft('')
    setImages([])
    setTextFiles([])
  }
  const recipients = recipientsOf?.(draft)
  return (
    <Composer
      {...composer}
      draft={draft}
      images={images}
      textFiles={textFiles}
      onChangeDraft={changeDraft}
      onChangeImages={changeImages}
      onChangeTextFiles={changeTextFiles}
      onSend={send}
      {...(recipients === undefined ? {} : { recipients })}
    />
  )
}

interface LiveTranscriptProps {
  chatId: string
  listRef: RefObject<LegendListRef | null>
  sessionLive: SessionLive
  projectThread: boolean
  /** The oldest row on the page. The screen holds it, because a reveal moves it. */
  firstKey: string | undefined
  onLoadOlder: () => void
  /** The project thread's open bundles. The screen holds them, because a reveal opens one. */
  openBundles: typeof NO_OPEN_THREAD_BUNDLES
  onBundleOpen: (key: string, open: boolean) => void
  connected: boolean
  /** Under a subagent's screen the list stays where it was left. */
  covered: boolean
  links: MarkdownLinks | undefined
  draftActions: DraftActions
  repoFiles: string[] | undefined
  userBubbleTint: BubbleTint | undefined
  topInset: number
  keyboardSink: number
  contentInsetEndAdjustment: SharedValue<number>
  freeze: ReturnType<typeof useKeyboardScrollToEnd>['freeze']
  onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void
  onContentSizeChange: (width: number, height: number) => void
  onOpenAgentRelay: (chatId: string) => void
  onRejectWork: (chatId: string) => void
  onReveal: (rowKey: string) => void
  onOpenSubagent: (toolCallId: string) => void
  onOpenQuoteSource: (eventId: string) => void
  onReply: (reply: MessageReply) => void
  onReact: (eventId: string, emoji: string | null) => void
  onQuoteSource: (source: QuoteSelectionSource) => void
  /** A DM's arrival motion, see `ArrivalMotion`. Other rooms keep rows that just appear. */
  arrival?: TranscriptArrival
}

interface TranscriptArrival {
  motion: ArrivalMotion
  still: boolean
  /** At the end of the chat; scrolled up, nothing moves when a row lands. */
  followEnd: boolean
  /** Counts the sends the composer asked to fly. */
  flightId: number
}

/**
 * The transcript over the live thread. The screen reads the quiet workspace, so a streamed
 * text frame renders this list and the turn that grew, not the header, the composer or the
 * sheets. Everything a row draws from the thread is worked out here, from rows that carry
 * the text.
 */
function LiveTranscript({
  chatId, listRef, sessionLive, projectThread, firstKey, onLoadOlder, openBundles, onBundleOpen, connected, covered, links, draftActions,
  repoFiles, userBubbleTint, topInset, keyboardSink, contentInsetEndAdjustment, freeze, onScroll, onContentSizeChange, onOpenAgentRelay, onRejectWork, onReveal,
  onOpenSubagent, onOpenQuoteSource, onReply, onReact, onQuoteSource, arrival,
}: LiveTranscriptProps) {
  const { workspace } = useWorkspaceData()
  const thread = useLiveThread(chatId)
  const chat = chatOf(workspace, chatId)
  const chatKind = chat?.kind
  const isPair = chatKind === 'pair'
  const singleChat = chat?.mode === 'single'
  const project = roomOf(workspace, chat?.projectId)
  const agents = workspace.agents
  const { rows, consultationMarkers, exchanges, visibleRows } = useTranscriptRows(thread, workspace, chatId, projectThread, sessionLive)
  // In a DM, memory writes are reached through a reply's long-press actions only.
  const memoryMarks = useMemo(() => chatKind === 'dm' ? dmMemoryMarks(rows) : undefined, [chatKind, rows])
  const historyOffset = historyStart(visibleRows, firstKey)
  const pageRows = useMemo(() => visibleRows.slice(historyOffset), [visibleRows, historyOffset])
  // A sent message keeps its pending row's list key once stored. Updated while rendering,
  // so the list never sees the stored row under a key of its own.
  const [listKeys, setListKeys] = useState<{ rows: readonly Row[]; carried: ReadonlyMap<string, string> }>(() => ({ rows: pageRows, carried: new Map() }))
  if (listKeys.rows !== pageRows) setListKeys({ rows: pageRows, carried: carryPendingKeys(listKeys.rows, pageRows, listKeys.carried) })
  const listKeyOf = useCallback((row: Row) => listKeys.carried.get(row.key) ?? row.key, [listKeys.carried])
  const stretch = useMemo(() => threadStretch(visibleRows), [visibleRows])
  const dateLabels = useMemo(() => dateDividers(pageRows, chatKind === 'dm' ? 'gaps' : isPair ? 'days' : 'off'), [chatKind, isPair, pageRows])
  const waitingOnByTurn = useMemo(() => {
    const waiting = new Map<string, string>()
    for (const row of rows) {
      if (row.kind !== 'event' || row.event.type !== 'agent_relay') continue
      if (row.event.phase === 'sent' && row.event.handoff !== true) waiting.set(row.event.turnId, row.event.peerAgentId)
      else waiting.delete(row.event.turnId)
    }
    return waiting
  }, [rows])
  // The one face that moves: whoever spoke last.
  const latestTurnKey = useMemo(() => {
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index]
      if (row?.kind === 'turn') return row.key
    }
    return undefined
  }, [rows])
  // A DM's indicator waits on a consulted colleague only while her pair chat still runs.
  const runningChatIds = useMemo(
    () => new Set(Object.entries(workspace.activity).filter(([, activity]) => activity.runningTurns.length > 0).map(([id]) => id)),
    [workspace.activity],
  )
  // A project thread's line leaves with its own turn; it never waits on a consult.
  const working = useMemo(() => {
    if (chatKind !== 'dm' && !projectThread) return undefined
    const state = dmWorking(rows, runningChatIds)
    return projectThread && state?.kind === 'consult' ? undefined : state
  }, [chatKind, projectThread, rows, runningChatIds])
  // What came in at the end since the last pass, worked out while rendering like the list
  // keys above, so a new row mounts knowing how it arrives. A message, a reply's first
  // words and the working face each arm the slide once; a reply growing as it streams does not.
  const [arrivals, setArrivals] = useState(() => ({ rows: pageRows, keys: NO_ARRIVALS, flightId: arrival?.flightId ?? 0, working: working !== undefined, armed: 0 }))
  if (arrival !== undefined && listKeys.rows === pageRows && (arrivals.rows !== pageRows || arrivals.working !== (working !== undefined))) {
    const moving = arrival.followEnd && !covered
    const flying = moving && !arrival.still && arrival.flightId > arrivals.flightId
    const keys = !moving || arrivals.rows === pageRows ? NO_ARRIVALS : tailArrivals(arrivals.rows, pageRows, listKeyOf, flying)
    const flew = [...keys.values()].includes('send')
    const faceCame = working !== undefined && !arrivals.working
    setArrivals({
      rows: pageRows,
      keys,
      flightId: flew ? arrival.flightId : arrivals.flightId,
      working: working !== undefined,
      armed: arrivals.armed + (moving && !arrival.still && (keys.size > 0 || faceCame) ? 1 : 0),
    })
  }
  const arrivalMotion = arrival?.motion
  useLayoutEffect(() => {
    if (arrivalMotion === undefined || arrivals.armed === 0) return
    armArrival(arrivalMotion)
  }, [arrivalMotion, arrivals.armed])
  useLayoutEffect(() => {
    if (arrivalMotion === undefined) return
    for (const [key, kind] of arrivals.keys) if (kind === 'send') claimFlight(arrivalMotion, key)
  }, [arrivalMotion, arrivals.keys])
  // Spent once its motion is over, so a row the list unmounts and draws again later just appears.
  useEffect(() => {
    if (arrivals.keys.size === 0) return undefined
    const spent = arrivals.keys
    const timer = setTimeout(() => setArrivals((current) => current.keys === spent ? { ...current, keys: NO_ARRIVALS } : current), ARRIVAL_SPENT_MS)
    return () => clearTimeout(timer)
  }, [arrivals.keys])
  // The scroll offset the slide follows, on the UI thread.
  const sharedValues = useMemo(() => arrivalMotion === undefined ? undefined : { scrollOffset: arrivalMotion.scrollOffset }, [arrivalMotion])
  /**
   * What a row draws from the rows around it and from the thread as a whole. Rows keep
   * their objects across an event that did not change them, so the list would not redraw
   * a row whose neighbour, date label, marker or consulted colleague changed. This is
   * worked out per pass and kept while it says the same, and it rides in `rowContext`.
   */
  const [aroundMemory] = useState(() => createValueMemory<{
    /** By row key, so an equal map means every row keeps its own values, wherever it moved. */
    places: Map<string, { dateLabel: string | undefined; joinsAbove: boolean; relayOffset: number | undefined; threadOffset: number | undefined }>
    waitingOnByTurn: Map<string, string>
    consultationMarkers: ReturnType<typeof stackedConsultationMarkers>
    exchanges: ReturnType<typeof relayExchanges>
    memoryMarks: ReturnType<typeof dmMemoryMarks> | undefined
    stretch: string
  }>())
  const around = useMemo(() => aroundMemory.keep({
    places: new Map(pageRows.map((item, index) => {
      const dateLabel = dateLabels[index]
      const previous = pageRows[index - 1]
      return [item.key, {
        dateLabel,
        joinsAbove: joinsBubbleAbove(item, previous, dateLabel, chatKind === 'dm'),
        relayOffset: dateLabel === undefined ? relayOffset(item, previous) : undefined,
        threadOffset: projectThread && dateLabel === undefined ? threadOffset(item, previous) : undefined,
      }]
    })),
    waitingOnByTurn,
    consultationMarkers,
    exchanges,
    memoryMarks,
    stretch,
  }), [aroundMemory, chatKind, consultationMarkers, dateLabels, exchanges, memoryMarks, pageRows, projectThread, stretch, waitingOnByTurn])
  // An isolated Session names its branch above its opening brief, which a later `/goal` brief is not.
  const isolatedBranch = chat?.kind === 'project' && chat.checkout.mode === 'worktree' ? chat.checkout.branch ?? undefined : undefined
  const opening = isolatedBranch === undefined ? undefined : rows.find((row) => row.kind === 'event' && row.event.type === 'user_message')
  const kickoffKey = opening?.kind === 'event' && opening.event.type === 'user_message' && opening.event.source === 'work_handoff' ? opening.key : undefined
  // A side chat runs no skill, so its bubbles draw `$word` as text, as its composer does.
  const skills = chatKind === 'side' ? NO_SKILLS : workspace.skills
  /**
   * What a row draws besides its own data. The list redraws a mounted row only when its
   * item or this object changes, never because `renderItem` did, so a value a row reads
   * from the screen has to be named here to reach it: a thread reply that lands in an
   * idle chat, the connection dropping, the file listing arriving, the newest turn moving
   * on. Everything in it holds still through a streamed frame.
   */
  const rowContext = useMemo(
    () => ({ openBundles, connected, links, draftActions, repoFiles, latestTurnKey, agents, around, project, userBubbleTint, isolatedBranch, kickoffKey, skills }),
    [openBundles, connected, links, draftActions, repoFiles, latestTurnKey, agents, around, project, userBubbleTint, isolatedBranch, kickoffKey, skills],
  )

  const renderRow = (item: Row) => (
    <TranscriptRow
      agents={agents}
      connected={connected}
      bubbleReplies={chatKind === 'dm'}
      {...(userBubbleTint === undefined ? {} : { userBubbleTint })}
      showSpeaker={!singleChat}
      quoteAuthors={chat !== null && quoteNamesAuthor(chat, projectThread)}
      skills={skills}
      {...(projectThread && project !== undefined ? { threadProject: project } : {})}
      pinPlan={chatKind === 'project' && !projectThread}
      {...(isolatedBranch === undefined || item.key !== kickoffKey ? {} : { isolatedBranch })}
      joinsAbove={around.places.get(item.key)?.joinsAbove === true}
      latest={item.key === latestTurnKey}
      links={links}
      draftActions={draftActions}
      repoFiles={repoFiles}
      row={item}
      {...(item.kind === 'thread_bundle' ? { bundleOpen: threadBundleOpen(openBundles, around.stretch, item.key), bundleOpenItems: threadBundleOpenItems(openBundles, around.stretch, item), onBundleOpen } : {})}
      dateLabel={around.places.get(item.key)?.dateLabel}
      waitingOnAgentId={item.kind === 'turn' ? around.waitingOnByTurn.get(item.turnId) : undefined}
      consultationMarker={item.kind === 'event' ? around.consultationMarkers.get(item.event.id) : undefined}
      exchange={item.kind === 'event' ? around.exchanges.get(item.event.id) ?? undefined : undefined}
      relayOffset={around.places.get(item.key)?.relayOffset}
      {...(around.places.get(item.key)?.threadOffset === undefined ? {} : { threadOffset: around.places.get(item.key)?.threadOffset })}
      onOpenAgentRelay={onOpenAgentRelay}
      {...(project === undefined || project.name === '' ? {} : { forwardSource: project.name })}
      onRejectWork={onRejectWork}
      onReveal={onReveal}
      {...(around.memoryMarks === undefined || item.kind !== 'turn' ? {} : { memoryChanges: around.memoryMarks.get(item.key) })}
      onOpenSubagent={onOpenSubagent}
      onOpenQuoteSource={onOpenQuoteSource}
      {...(chatKind === 'dm' || chatKind === 'group' ? { onReply } : {})}
      {...(chatKind === 'dm' ? { onReact } : {})}
      {...(isPair ? {} : { onQuoteSource })}
    />
  )

  return (
    <KeyboardAwareLegendList
      // Short chats sit at the bottom, except a Session, which reads from its brief down
      // and starts under the header. Long ones open at the end, and the end stays pinned
      // while a reply streams or a message lands, as long as the user is near it: a short
      // Session counts as at its end, so it starts following the moment it overflows.
      // Rows keep their own fold state, so they are not recycled.
      alignItemsAtEnd={chatKind !== 'project' || projectThread}
      contentContainerStyle={[styles.feed, { paddingTop: topInset }]}
      contentInsetEndAdjustment={contentInsetEndAdjustment}
      data={pageRows}
      // A bundle's open state lives in the screen, not in its row, so the list redraws when it changes.
      extraData={rowContext}
      estimatedItemSize={ESTIMATED_ROW}
      freeze={freeze}
      initialScrollAtEnd
      keyboardDismissMode="interactive"
      // A sheet opened from a card sits under this list in the responder tree: without
      // this the first tap on its Close only hides the keyboard and never reaches the button.
      keyboardShouldPersistTaps="handled"
      keyboardLiftBehavior="always"
      keyboardOffset={keyboardSink}
      keyExtractor={listKeyOf}
      maintainScrollAtEnd={covered ? false : { animated: false, on: { dataChange: true, footerLayout: true, itemLayout: true, layout: true } }}
      maintainScrollAtEndThreshold={0.15}
      maintainVisibleContentPosition
      onStartReached={onLoadOlder}
      onStartReachedThreshold={0.3}
      ListHeaderComponent={historyOffset > 0 ? (
        <Pressable accessibilityRole="button" onPress={onLoadOlder} style={{ alignSelf: 'center', padding: spacing.md }}>
          <Text style={{ color: colors.dim }}>Load earlier messages</Text>
        </Pressable>
      ) : null}
      ListFooterComponent={working === undefined ? null : (
        <DmWorkingIndicator
          agents={agents}
          persona={personaOf(agents, working.kind === 'turn' ? working.turn.agentId : working.kind === 'consult' ? working.agentId : projectThread ? SINGLE_CHAT_VOICE.id : chat?.memberIds[0] ?? 'unknown')}
          working={working}
          bare={projectThread}
        />
      )}
      recycleItems={false}
      ListEmptyComponent={
        thread.hasSnapshot
          ? <View style={styles.empty}><Text style={styles.emptyTitle}>An empty conversation</Text></View>
          : <View style={styles.empty}><Text style={styles.emptyCopy}>Loading conversation…</Text></View>
      }
      onScroll={onScroll}
      onContentSizeChange={onContentSizeChange}
      {...(sharedValues === undefined ? {} : { sharedValues })}
      {...(arrivalMotion === undefined ? {} : { onScrollBeginDrag: () => disarmArrival(arrivalMotion) })}
      ref={listRef}
      renderItem={({ item }) => arrivalMotion === undefined ? renderRow(item) : (
        <ArrivalRow arrival={arrivals.keys.get(listKeyOf(item))} motion={arrivalMotion} rowKey={listKeyOf(item)} still={arrival?.still ?? false}>
          {renderRow(item)}
        </ArrivalRow>
      )}
      scrollEventThrottle={80}
      scrollIndicatorInsets={{ top: topInset - spacing.lg }}
    />
  )
}

function sameKeys(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((key) => b.has(key))
}

/** Where a rendered view sits on screen; undefined for a view that is not there. */
function measureInWindow(view: unknown): Promise<ScreenSpan | undefined> {
  if (!isMeasurable(view)) return Promise.resolve(undefined)
  return new Promise((resolve) => view.measureInWindow((_x, y, _width, height) => resolve({ top: y, bottom: y + height })))
}

/**
 * Where a view sits in the window, read at once. The layout is read synchronously from the
 * shadow tree; where the callback would come later, this reads nothing and the caller
 * goes without.
 */
function measureNow(view: unknown): { x: number; y: number; width: number; height: number } | undefined {
  if (!isMeasurable(view)) return undefined
  let rect: { x: number; y: number; width: number; height: number } | undefined
  view.measureInWindow((x, y, width, height) => {
    rect = { x, y, width, height }
  })
  return rect
}

function isMeasurable(view: unknown): view is Pick<View, 'measureInWindow'> {
  return typeof view === 'object' && view !== null && 'measureInWindow' in view && typeof view.measureInWindow === 'function'
}

interface TranscriptRowProps {
  row: Row
  agents: ReturnType<typeof useWorkspace>['workspace']['agents']
  latest: boolean
  links?: MarkdownLinks
  repoFiles?: string[]
  connected: boolean
  bubbleReplies: boolean
  userBubbleTint?: BubbleTint
  showSpeaker: boolean
  quoteAuthors: boolean
  /** The skills a `$slug` he wrote may name, drawn as skill pills in his bubble. */
  skills: readonly SkillConfig[]
  threadProject?: NonNullable<ReturnType<typeof useWorkspace>['workspace']['projects'][number]>
  joinsAbove: boolean
  onReply?: (reply: MessageReply) => void
  onReact?: (eventId: string, emoji: string | null) => void
  onQuoteSource?: (source: QuoteSelectionSource) => void
  onOpenQuoteSource: (eventId: string) => void
  draftActions: DraftActions
  dateLabel?: string
  waitingOnAgentId?: string
  consultationMarker?: readonly TurnConsultation[]
  /** Set when this relay marker stands for the agent's whole exchange: "N messages with". */
  exchange?: RelayExchange | undefined
  relayOffset?: number | undefined
  /** In a project thread: where this row sits against the one above, set by `threadSpacing`. */
  threadOffset?: number | undefined
  onOpenAgentRelay: (chatId: string) => void
  /** In a Session: the project whose thread sent the user's messages on here. */
  forwardSource?: string
  onRejectWork: (chatId: string) => void
  onReveal: (rowKey: string) => void
  onOpenSubagent: (toolCallId: string) => void
  /** In a DM: the memory writes this turn's reply shows. */
  memoryChanges?: Extract<Row, { kind: 'turn' }>['memoryChanges']
  /** In a Session: a turn's plan stands at its end. */
  pinPlan: boolean
  /** In an isolated Session: the branch it works on, named above its brief. */
  isolatedBranch?: string
  /** A project thread bundle: whether it stands open, and how it opens or folds. */
  bundleOpen?: boolean
  bundleOpenItems?: ReadonlySet<string>
  /** Opens or closes a bundle (its own key) or one of its lines (the item's key). */
  onBundleOpen?: (key: string, open: boolean) => void
}

const NO_OPEN_ITEMS: ReadonlySet<string> = new Set()

// The function carries its own name, not the row's: a bundle draws its items as rows, and
// a function that names itself there loses the React Compiler and renders them unmemoized.
const TranscriptRow = memo(function TranscriptRowBody(props: TranscriptRowProps) {
  const {
    row,
    agents,
    latest,
    links,
    repoFiles,
    connected,
    bubbleReplies,
    userBubbleTint,
    showSpeaker,
    quoteAuthors,
    skills,
    threadProject,
    joinsAbove,
    onReply,
    onReact,
    onQuoteSource,
    onOpenQuoteSource,
    draftActions,
    dateLabel,
    waitingOnAgentId,
    consultationMarker,
    exchange,
    relayOffset,
    threadOffset,
    onOpenAgentRelay,
    forwardSource,
    onRejectWork,
    onReveal,
    onOpenSubagent,
    memoryChanges,
    pinPlan,
    isolatedBranch,
    bundleOpen,
    bundleOpenItems,
    onBundleOpen,
  } = props
  // A user message draws the same wherever it sits: a row of its own, or inline in the turn it steered.
  const renderUserEvent = (eventRow: Extract<Row, { kind: 'event' }>) => {
    if (eventRow.event.type !== 'user_message') return null
    // What Manor says about this message stands under it, in his corner.
    const hints = eventRow.hints ?? []
    const brief = eventRow.event.source === 'project_thread' && eventRow.event.threadReason === 'brief' ? messageBrief(eventRow.event) : ''
    const message = eventRow.event.source === 'routine'
      ? <Text style={styles.note}>{eventRow.event.routineName ?? 'Routine'} started{routineLateNote(eventRow.event)}</Text>
      : eventRow.event.source === 'background_wake'
        ? <WakeNotices items={eventRow.event.wakeItems ?? []} ts={eventRow.event.ts} />
      : brief !== ''
        ? <KickoffCard agents={agents} text={brief} images={eventRow.event.images ?? []} files={eventRow.event.files ?? []} />
      : eventRow.event.source === 'project_thread'
        // Manor's wake of the thread: `projectThreadFeed` drops it, and it never reads as his bubble.
        ? null
      : eventRow.event.source === 'work_handoff'
        ? (
          <View style={styles.kickoff}>
            {isolatedBranch === undefined ? null : (
              <View style={styles.kickoffBadge}>
                <Badge mark={<HugeiconsIcon color={colors.worktree} icon={GitBranchIcon} size={12} strokeWidth={1.7} />}>{isolatedBranch}</Badge>
              </View>
            )}
            <KickoffCard agents={agents} text={messageBrief(eventRow.event)} images={eventRow.event.images ?? []} files={eventRow.event.files ?? []} />
          </View>
        )
      : eventRow.event.source === 'agent_relay'
        ? <RelayedAgentMessage agents={agents} event={eventRow.event} />
      : eventRow.confirmTasks !== undefined
        // Confirm's commit request is addressed to the lead; the user reads it as its steps.
        ? <TaskCard foldKey={`confirm:${eventRow.key}`} label="Confirm" tasks={eventRow.confirmTasks} {...(eventRow.confirmTitle === undefined ? {} : { title: eventRow.confirmTitle })} />
      : isModelOnlyMessage(eventRow.event)
        // Manor's words to the model alone, such as its report of a stopped merge: nothing for the user to read.
        ? null
      : <Bubble
          agents={agents}
          quoteAuthors={quoteAuthors}
          skills={skills}
          {...(userBubbleTint === undefined ? {} : { tint: userBubbleTint })}
          dm={bubbleReplies}
          files={eventRow.event.files ?? []}
          documents={eventRow.event.documents ?? []}
          images={eventRow.event.images ?? []}
          text={eventRow.event.text}
          sourceEventId={eventRow.event.id}
          {...(onQuoteSource === undefined ? {} : { onQuoteSource })}
          {...(eventRow.event.replyTo === undefined ? {} : { replyTo: eventRow.event.replyTo })}
          {...(eventRow.event.quote === undefined ? {} : { quote: eventRow.event.quote })}
          {...(eventRow.event.quotes === undefined ? {} : { quotes: eventRow.event.quotes })}
          onOpenQuoteSource={onOpenQuoteSource}
          {...(links?.repo === undefined ? {} : { repo: links.repo })}
          {...(eventRow.event.noteQuote === undefined ? {} : { noteQuote: eventRow.event.noteQuote })}
          {...(bubbleReplies && eventRow.event.reaction?.agentId !== undefined ? {
            reaction: eventRow.event.reaction,
            reactionColor: personaOf(agents, eventRow.event.reaction.agentId).color,
          } : {})}
        />
    // In a project thread: the Session this message went on to. In that Session: who sent it.
    const forwards = eventRow.forwards ?? []
    const forwarded = eventRow.event.forwardedFrom === undefined ? null : (
      <Text style={styles.hint}>{forwardSource === undefined ? 'Sent from the project thread' : `Sent from ${forwardSource}`}</Text>
    )
    return hints.length === 0 && forwards.length === 0 && forwarded === null ? message : (
      <View style={styles.hinted}>
        {forwarded}
        {message}
        {hints.map((hint, index) => <Text key={index} style={styles.hint}>{hint}</Text>)}
        {forwards.map((link) => (
          <View key={link.sessionChatId} style={styles.forward}>
            <Text style={styles.forwardText}>Sent to</Text>
            <SessionChip link={link} onOpen={onOpenAgentRelay} />
          </View>
        ))}
      </View>
    )
  }
  const content = (() => {
  if (row.kind === 'pending') {
    return <Bubble agents={agents} dim dm={bubbleReplies} quoteAuthors={quoteAuthors} skills={skills} files={row.files} {...(row.documents === undefined ? {} : { documents: row.documents })} images={row.images} text={row.text} {...(row.replyTo === undefined ? {} : { replyTo: row.replyTo })} {...(row.quotes === undefined ? {} : { quotes: row.quotes })} onOpenQuoteSource={onOpenQuoteSource} />
  }
  if (row.kind === 'thread_bundle') {
    // Each item draws as it would stand on its own; none of the row's own spacing or stamps.
    return (
      <ThreadBundle
        row={row}
        open={bundleOpen === true}
        openItems={bundleOpenItems ?? NO_OPEN_ITEMS}
        onOpenChange={(key, open) => onBundleOpen?.(key, open)}
        renderItem={(item) => (
          <TranscriptRow
            {...props}
            row={item}
            latest={false}
            joinsAbove={false}
            dateLabel={undefined}
            relayOffset={undefined}
            threadOffset={undefined}
            waitingOnAgentId={undefined}
            consultationMarker={undefined}
            memoryChanges={undefined}
          />
        )}
      />
    )
  }
  if (row.kind === 'work_handoff') {
    return (
      <WorkHandoffCard
        row={row}
        agents={agents}
        onReject={onRejectWork}
        onReveal={onReveal}
        inThread={threadProject !== undefined}
      />
    )
  }
  if (row.kind === 'event') {
    if (row.event.type === 'user_message') return renderUserEvent(row)
    if (row.event.type === 'agent_relay') {
      if (consultationMarker !== undefined && exchange === undefined) {
        return (
          <ConsultedAgents
            action={row.event.phase === 'received' ? 'Message from' : 'Messaged'}
            consultations={consultationMarker}
            agents={agents}
            onOpen={onOpenAgentRelay}
          />
        )
      }
      return <RelayMarker agents={agents} event={row.event} onOpen={onOpenAgentRelay} {...(exchange === undefined ? {} : { exchange })} />
    }
    if (row.event.projectFileWrite !== undefined) return <ProjectFileWriteCard write={row.event.projectFileWrite} projectName={threadProject?.name} />
    return <NoteLine event={row.event} />
  }
  const turn = (
    <Turn
      agents={agents}
      bubbleReplies={bubbleReplies}
      connected={connected}
      latest={latest}
      showSpeaker={showSpeaker}
      {...(threadProject === undefined ? {} : { threadProject })}
      pinPlan={pinPlan}
      draftActions={draftActions}
      links={links}
      repoFiles={repoFiles}
      turn={row}
      renderUser={renderUserEvent}
      onOpenSubagent={onOpenSubagent}
      waitingOnAgentId={waitingOnAgentId}
      {...(memoryChanges === undefined ? {} : { memoryChanges })}
      {...(onReply === undefined ? {} : { onReply })}
      {...(onReact === undefined ? {} : { onReact })}
      {...(onQuoteSource === undefined ? {} : { onQuoteSource })}
    />
  )
  // A project thread turn links each Session it sent the user's message on to, under its reply.
  return row.sessionLinks === undefined ? turn : (
    <View style={styles.hinted}>
      {turn}
      <View style={styles.sessionLinks}>
        {row.sessionLinks.map((link) => <SessionChip key={link.sessionChatId} link={link} onOpen={onOpenAgentRelay} />)}
      </View>
    </View>
  )
  })()
  return (
    <View style={[styles.transcriptItem, joinsAbove ? styles.joinedItem : relayOffset !== undefined ? { marginTop: relayOffset } : threadOffset === undefined ? null : { marginTop: threadOffset }]}>
      {dateLabel === undefined ? null : <Text style={styles.dateSeparator}>{dateLabel}</Text>}
      {content}
    </View>
  )
})

/** A centred note; an answer the thread gave from a preference ends in Other answer. */
function NoteLine({ event }: { event: Extract<ThreadEvent, { type: 'system_note' }> }) {
  const change = useContext(AnswerChange)
  const text = <Text style={[styles.note, event.kind === 'error' && styles.error]}>{event.text}</Text>
  if (change === null || !change.ids.has(event.id)) return text
  return (
    <View style={styles.noteWithAction}>
      {text}
      <Pressable accessibilityRole="button" hitSlop={8} onPress={() => change.onChange(event.id)} style={({ pressed }) => pressed && styles.pressed}>
        <Text style={styles.noteAction}>{OTHER_ANSWER}</Text>
      </Pressable>
    </View>
  )
}

/** A Session by its title, opening it on press: under a forwarded message and under the reply that sent it. */
function SessionChip({ link, onOpen }: { link: SessionLink; onOpen: (chatId: string) => void }) {
  return (
    <Pressable
      accessibilityLabel={`Open Session ${link.title}`}
      accessibilityRole="button"
      hitSlop={6}
      onPress={() => onOpen(link.sessionChatId)}
      style={({ pressed }) => [styles.sessionChip, pressed && styles.pressed]}
    >
      <HugeiconsIcon color={colors.muted} icon={CellsIcon} size={14} strokeWidth={1.8} />
      <Text numberOfLines={1} style={styles.sessionChipText}>{link.title}</Text>
    </Pressable>
  )
}

function RelayMarker({
  event,
  exchange,
  agents,
  onOpen,
}: {
  event: Extract<Extract<Row, { kind: 'event' }>['event'], { type: 'agent_relay' }>
  exchange?: RelayExchange
  agents: AgentConfig[]
  onOpen: (chatId: string) => void
}) {
  const peer = personaOf(agents, event.peerAgentId)
  const action = relayMarkerAction(event.phase, exchange)
  return (
    <View style={styles.relayColumn}>
      <Pressable
        accessibilityLabel={`${action} ${peer.name}`}
        accessibilityRole="button"
        onPress={() => onOpen(event.pairChatId)}
        style={({ pressed }) => [styles.relayMarker, pressed && styles.pressed]}
      >
        <Text style={styles.relayMarkerText}>{action}</Text>
        <Blobatar color={peer.color} name={peer.name} shape={peer.avatarShape} finish={peer.avatarFinish} tone={peer.avatarTone} size={transcriptMark.face} src={peer.avatar} />
        <Text numberOfLines={1} style={[styles.relayMarkerText, styles.relayMarkerName]}>{peer.name}</Text>
      </Pressable>
    </View>
  )
}

const NO_INLINE_QUOTES: readonly InlineQuote[] = []

/** The same ten-line cut as the Mac's bubble. */
const BUBBLE_FOLD_LINES = 10
/** The transcript's reading line, which his bubble keeps outside a DM. */
const READING_LINE = 25

/** A long sent message folded behind Show more; a short one passes through untouched. */
function FoldedMessage({ clamp, lineHeight, children }: { clamp: boolean; lineHeight: number; children: ReactNode }) {
  return clamp ? <FoldedBody lineHeight={lineHeight} lines={BUBBLE_FOLD_LINES}>{children}</FoldedBody> : <>{children}</>
}

/** `tint` fills a DM bubble with the face he is talking to; its chips read the same tint. A dimmed (pending) bubble stays grey so its fade cannot pull the tinted ink below AA. `dm` sets the words at the DM bubble size and lets a taller bubble soften its corner. */
function Bubble({ text, images: sent, agents, files = [], documents = [], replyTo, quote, noteQuote, quotes = NO_INLINE_QUOTES, sourceEventId, onQuoteSource, onOpenQuoteSource, dim = false, tint, dm = false, quoteAuthors = false, skills, repo, reaction, reactionColor }: { text: string; images: readonly EventImage[]; agents: readonly AgentConfig[]; files?: readonly FileAttachment[]; documents?: readonly (EventDocument | PendingDocument)[]; replyTo?: MessageReply; quote?: MessageQuote; noteQuote?: NoteQuote; quotes?: readonly InlineQuote[]; sourceEventId?: string; onQuoteSource?: (source: QuoteSelectionSource) => void; onOpenQuoteSource?: (eventId: string) => void; dim?: boolean; tint?: BubbleTint; dm?: boolean; quoteAuthors?: boolean; skills: readonly SkillConfig[]
  /** The chat's repo listing, so a file path he wrote opens in Files. */
  repo?: RepoLinks
  /** The agent's reaction, a badge in its accent on the bubble's bottom right edge. */
  reaction?: MessageReaction
  reactionColor?: string }) {
  // A marked picture's unmarked original rides at the end for the persona; the bubble shows only the marked one.
  const originals = originalImageIndexes(sent)
  const images = originals.size === 0 ? sent : sent.filter((_, index) => !originals.has(index))
  // A message that refers to its pictures by number shows those numbers; older ones stay as they were.
  const numbered = imageRefSpans(text, images.length).length > 0
  const [openImage, setOpenImage] = useState<number | null>(null)
  const [openQuote, setOpenQuote] = useState<number | null>(null)
  const [corner, measureCorner] = useBubbleCorner()
  const hasBubble = text !== '' || files.length > 0 || documents.length > 0 || replyTo !== undefined || quote !== undefined || noteQuote !== undefined
  const wide = scrollsSideways(text)
  return (
    <BubbleTintContext.Provider value={tint}>
    <View style={[styles.userMessage, wide && styles.userMessageWide, dim && styles.pending]}>
      {/* Sent pictures sit above the bubble, as on desktop; a press opens the gallery. */}
      {hasBubble || reaction === undefined ? <Attachments alignEnd images={images} numbered={numbered} /> : (
        // A message of pictures only wears the agent's reaction on them.
        <View style={styles.userBubbleReacted}>
          <Attachments alignEnd images={images} numbered={numbered} />
          <ReactionBadge reaction={reaction} {...(reactionColor === undefined ? {} : { color: reactionColor })} />
        </View>
      )}
      {hasBubble ? (
        <View onLayout={dm ? measureCorner : undefined} style={[styles.userBubble, { borderRadius: corner }, wide && styles.userBubbleWide, tint && { backgroundColor: tint.fill }, reaction !== undefined && styles.userBubbleReacted]}>
          {sourceEventId === undefined ? null : <LandingWash eventId={sourceEventId} style={[styles.userBubbleWash, { borderRadius: corner }]} />}
          {quote === undefined ? null : <QuoteBlock agents={agents} quote={quote} showAuthor={quoteAuthors} {...(onOpenQuoteSource === undefined ? {} : { onOpen: () => onOpenQuoteSource(quote.eventId) })} />}
          {noteQuote === undefined ? null : <NoteQuoteContextChip quote={noteQuote} />}
          {replyTo === undefined ? null : <ReplyContextChip name={agents.find((agent) => agent.id === replyTo.agentId)?.name ?? replyTo.agentId} reply={replyTo} />}
          <Attachments documents={documents} files={files} images={[]} />
          {text === '' ? null : (
            <FoldedMessage clamp={isLongMessage(text)} lineHeight={dm ? bubbleText.lineHeight : READING_LINE}>
              <Markdown
                agents={agents}
                {...(dm ? { size: 'bubble' as const } : {})}
                {...(repo === undefined ? {} : { links: { repo } })}
                text={normalizeComposerLists(text)}
                sent={{
                  skills,
                  ...(numbered ? { imageCount: images.length, onOpenImage: setOpenImage } : {}),
                  ...(quotes.length === 0 ? {} : { quotes, onOpenQuote: setOpenQuote }),
                  ...(sourceEventId === undefined ? {} : {
                    accessibilityHint: 'Press and hold to quote text',
                    ...(onQuoteSource === undefined ? {} : { onLongPress: () => onQuoteSource({ eventId: sourceEventId, text: withQuoteExcerpts(text, quotes) }) }),
                  }),
                }}
              />
            </FoldedMessage>
          )}
          {reaction === undefined ? null : <ReactionBadge reaction={reaction} {...(reactionColor === undefined ? {} : { color: reactionColor })} />}
        </View>
      ) : null}
      {openImage === null ? null : <ImageViewer images={images} initialIndex={openImage} onClose={() => setOpenImage(null)} />}
      {quotes.length === 0 ? null : (
        <QuoteRefSheet
          agents={agents}
          quote={openQuote === null ? null : quotes[openQuote] ?? null}
          showAuthor={quoteAuthors}
          onClose={() => setOpenQuote(null)}
          {...(onOpenQuoteSource === undefined ? {} : { onOpenSource: onOpenQuoteSource })}
        />
      )}
    </View>
    </BubbleTintContext.Provider>
  )
}

const LATE_DUE = new Intl.DateTimeFormat('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })

/** A one-time routine that fired after a sleeping Mac says it is late, and for when. */
function routineLateNote(event: { ts: number; routineDueAt?: number }): string {
  return event.routineDueAt !== undefined && event.ts - event.routineDueAt > ROUTINE_LATE_AFTER_MS
    ? `, late, due ${LATE_DUE.format(new Date(event.routineDueAt))}`
    : ''
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  // 24pt between messages, tried at 32 and turned down. Only the space under the last
  // one grew, so it rests clear of the composer rather than on it.
  feed: { gap: spacing.xl, paddingHorizontal: spacing.lg, paddingBottom: spacing.xl },
  empty: { flex: 1, minHeight: 360, alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
  emptyTitle: { color: colors.text, fontFamily: fonts.sans, fontSize: 20, fontWeight: '500' },
  emptyCopy: { color: colors.muted, fontFamily: fonts.sans, fontSize: 15 },
  userMessage: { maxWidth: `${SENT_BUBBLE_SHARE * 100}%`, alignSelf: 'flex-end', alignItems: 'flex-end', gap: spacing.xs + 2 },
  // A table or fenced block in a bubble that sizes to its words breaks the layout (`scrollsSideways`).
  userMessageWide: { width: `${SENT_BUBBLE_SHARE * 100}%` },
  userBubbleWide: { alignSelf: 'stretch' },
  userBubble: { maxWidth: '100%', gap: spacing.sm, ...squircle, backgroundColor: colors.userBubble, paddingHorizontal: SENT_BUBBLE_PAD.x, paddingVertical: SENT_BUBBLE_PAD.y },
  userBubbleWash: squircle,
  userBubbleReacted: { marginBottom: spacing.md },
  pending: { opacity: 0.55 },
  note: { color: colors.muted, fontFamily: fonts.sans, fontSize: 13, lineHeight: 19, textAlign: 'center' },
  // The branch chip sits 10 above its brief, the room a helper's chips leave.
  kickoff: { gap: 10 },
  kickoffBadge: { flexDirection: 'row' },
  noteWithAction: { alignItems: 'center', gap: 2 },
  noteAction: { color: colors.text, fontFamily: fonts.sans, fontSize: 13, lineHeight: 19, fontWeight: '500' },
  hinted: { gap: spacing.xs },
  hint: { alignSelf: 'flex-end', maxWidth: '86%', color: colors.dim, fontFamily: fonts.sans, fontSize: 13, lineHeight: 18, textAlign: 'right' },
  forward: { alignSelf: 'flex-end', maxWidth: '86%', flexDirection: 'row', alignItems: 'center', gap: 6 },
  forwardText: { color: colors.dim, fontFamily: fonts.sans, fontSize: 13, lineHeight: 18 },
  sessionLinks: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  sessionChip: { flexShrink: 1, flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: radius.sm, backgroundColor: colors.chip, paddingHorizontal: 6, paddingVertical: 2 },
  sessionChipText: { flexShrink: 1, color: colors.muted, fontFamily: fonts.sans, fontSize: 13, lineHeight: 18 },
  transcriptItem: { gap: spacing.xl },
  joinedItem: { marginTop: 6 - spacing.xl },
  dateSeparator: { color: colors.dim, fontFamily: fonts.sans, fontSize: transcriptMark.fontSize, lineHeight: transcriptMark.lineHeight, textAlign: 'center' },
  relayMarker: { alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: radius.sm, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs },
  relayMarkerText: { color: colors.dim, fontFamily: fonts.sans, fontSize: transcriptMark.fontSize, lineHeight: transcriptMark.lineHeight },
  relayMarkerName: { flexShrink: 1 },
  relayColumn: { alignItems: 'center' },
  error: { color: colors.danger },
  footer: { position: 'absolute', right: 0, bottom: 0, left: 0 },
  // Hangs from the top of the pill row, so it rests above the pill or, without one, just
  // above the Session bar; full width only to centre the button, touches pass through.
  jump: { position: 'absolute', top: -(JUMP_SIZE + spacing.sm), right: 0, left: 0, alignItems: 'center', zIndex: 1 },
  pill: { alignItems: 'center', paddingTop: spacing.sm, paddingBottom: spacing.sm },
  // Above the floating jump: the composer's plus and `@`/`$` menus rise over it.
  footerInner: { zIndex: 2, paddingTop: spacing.md },
  pairFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.md },
  pairNotice: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  pairNoticeText: { color: colors.muted, fontFamily: fonts.sans, fontSize: 14 },
  closeChat: { borderRadius: radius.round, backgroundColor: colors.surface2, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  closeChatText: { color: colors.text, fontFamily: fonts.sans, fontSize: 14, fontWeight: '500' },
  stopChatText: { color: colors.danger, fontFamily: fonts.sans, fontSize: 14, fontWeight: '500' },
  settledBanner: { position: 'absolute', right: 0, left: 0, zIndex: 1, alignItems: 'center' },
  settledPill: {
    height: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  settledText: { color: colors.muted, fontFamily: fonts.sans, fontSize: 14 },
  settledDivider: { width: StyleSheet.hairlineWidth, height: 18, backgroundColor: colors.line },
  settledAction: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  settledActionText: { color: colors.text, fontFamily: fonts.sans, fontSize: 14, fontWeight: '500' },
  floatingFallback: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.2,
    shadowRadius: 16,
    elevation: 6,
  },
  pressed: { opacity: 0.64 },
})
