import { WorkHandoffCard } from '@/components/WorkHandoffCard'
import { KickoffCard } from '@/components/KickoffCard'
import { WakeNotices } from '@/components/SubagentRow'
import { SubagentDirectory, SubagentLaunchesContext, type SubagentLaunches } from '@/lib/subagentContext'
import { WorkDecisionDock } from '@/components/WorkDecisionDock'
import type { RevealPlace } from '@/components/WorkResultBody'
import ArrowDown01Icon from '@hugeicons/core-free-icons/ArrowDown01Icon'
import CellsIcon from '@hugeicons/core-free-icons/CellsIcon'
import LockIcon from '@hugeicons/core-free-icons/LockIcon'
import Undo02Icon from '@hugeicons/core-free-icons/Undo02Icon'
import { HugeiconsIcon } from '@hugeicons/react-native'
import { imageRefSpans, isModelOnlyMessage, isSoloRoom, placeQuotesAfterText, projectThreadOf, withQuoteExcerpts, ROUTINE_LATE_AFTER_MS, SINGLE_CHAT_VOICE, SUBAGENT_VOICE, userInputAnswerText, type AgentConfig, type EventDocument, type EventImage, type FileAttachment, type ImageAttachment, type InlineQuote, type MessageQuote, type MessageReply, type NoteQuote, type SkillConfig, type ThreadEvent } from '@manor/contracts'
import type { StagedFile } from '@manor/client-runtime/attachments'
import { avatarBubbleTint, projectBubbleTint, type BubbleTint } from '@manor/client-runtime/avatar-bubble'
import { liveSessionContext, singleWorkContext } from '@manor/client-runtime/context-meter'
import { normalizeComposerLists } from '@manor/client-runtime/composer-formatting'
import { chatCommandContext } from '@manor/client-runtime/chat-commands'
import { quoteNamesAuthor } from '@manor/client-runtime/message-quotes'
import { wakeLine } from '@manor/client-runtime/turn-labels'
import { chatSubagents, chatWaitsOnBackground, dmWorking, runningSubagents } from '@manor/client-runtime/turn-trace'
import { chatFallbackTargets, composerShowsRecipients, draftRecipients, replyFallbackTargets, roomAgents } from '@manor/client-runtime/mentions'
import { chatChangedFiles, resolveMarkdownRepoLink } from '@manor/client-runtime/changed-files'
import { defaultSingleRuntime, effectiveDriver, isAutoPending, readSingleRuntime, runtimeLabel, runtimeParts, singleRuntimeVoice } from '@manor/client-runtime/runtime-choices'
import type { ChangeableAnswer, OpenAsk, PendingDocument, Row, SessionLink, TurnConsultation, TurnRow, UnannouncedConsultation } from '@manor/client-runtime/state'
import { activityOf, chatOf, dmMemoryMarks, isHomeRoom, isProjectThread, roomOf, sitsSettled, messageBrief, projectSessionOverview, sessionsDot, openAsk, sessionLiveOf, openThreadQuestion, openSubagentQuestion, subagentSummaryOf, changeableAnswers, personaOf, projectWorkHandoffs, repoListingKey, rowHasQuoteSource, rowsOf, feedIndexOf, NO_OPEN_THREAD_BUNDLES, openThreadBundleAt, setThreadBundleOpen, threadBundleOpen, threadBundleOpenItems, threadStretch, onlyConsulted, runtimeStartedAgentIds, sessionReadyRow, sessionThreadOf, stackedConsultationMarkers, projectThreadFeed, threadQuestionAdvice, threadOf, withSessionTitle, threadSpacing, unannouncedConsultations, workCardInView, workDecisionOpen, type ScreenSpan } from '@manor/client-runtime/state'
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router'
import { KeyboardAwareLegendList, useKeyboardChatComposerInset, useKeyboardScrollToEnd } from '@legendapp/list/keyboard'
import { historyStart, olderHistoryKey } from '@manor/client-runtime/history-window'
import { plainDraftText } from '@manor/client-runtime/plain-preview'
import type { LegendListRef } from '@legendapp/list/react-native'
import { memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { Platform, Pressable, StyleSheet, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native'
import { KeyboardStickyView, useKeyboardState } from 'react-native-keyboard-controller'
import Animated from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { AskCard } from '@/components/AskCard'
import { SecretCard } from '@/components/SecretCard'
import { DmWorkingIndicator } from '@/components/DmWorkingIndicator'
import { carryPendingKeys } from '@/lib/listKeys'
import { Attachments, ImageViewer } from '@/components/Attachments'
import { AuthGate } from '@/components/AuthGate'
import { Blobatar } from '@/components/Blobatar'
import { ChatHeader, CHAT_HEADER_HEIGHT } from '@/components/ChatHeader'
import { Composer } from '@/components/Composer'
import { DiffSheet } from '@/components/DiffSheet'
import { EdgeScrim } from '@/components/EdgeScrim'
import { EditsPill } from '@/components/EditsPill'
import { FilesSheet } from '@/components/FilesSheet'
import { ProjectSettingsSheet } from '@/components/ProjectSettingsSheet'
import { GlassIconButton } from '@/components/GlassIconButton'
import { GlassSurface } from '@/components/GlassSurface'
import { BubbleTintContext } from '@/components/bubbleTint'
import { Markdown, type MarkdownLinks } from '@/components/Markdown'
import { AgentRuntimeSheet, RuntimeSheet, SingleRuntimeSheet } from '@/components/RuntimeSheet'
import { ReplyContextChip } from '@/components/ReplyContextChip'
import { NoteQuoteContextChip, QuoteBlock } from '@/components/QuoteContextChip'
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
import { takeThreadReveal } from '@/lib/threadReveal'
import { EMPTY_DRAFT, readDraft, writeDraft } from '@/lib/drafts'
import { glassRise, glassSink } from '@/lib/glassMotion'
import { useScreenCovered } from '@/lib/useScreenCovered'
import { useWorkspace } from '@/providers/WorkspaceProvider'
import { Text } from '@/components/Text'
import { colors, fonts, radius, spacing, squircle } from '@/theme'
import { useHostAuto } from '@/useHostAuto'

export default function ChatScreen() {
  const params = useLocalSearchParams<{ id: string }>()
  const chatId = Array.isArray(params.id) ? params.id[0] : params.id
  // Keyed on the chat, so everything the screen holds about one conversation — its
  // draft, its sheets, where it was scrolled — belongs to that conversation and never
  // carries over to another one the router happens to hand this route.
  return <AuthGate><ChatContent chatId={chatId} key={chatId} /></AuthGate>
}

/** Closer to the bottom than this, in points, still counts as reading the latest. */
const NEAR_END = 24

/** A row's height before it is measured; a turn with one reply is about this tall. */
const ESTIMATED_ROW = 120

/** What the footer stands on before its first layout, so the list opens at the right floor. */
const ESTIMATED_FOOTER = 120
/** The jump to the latest message: its height plus the gap it floats above the footer by. */
const JUMP_SPACE = 44

/** One identity, so a chat that offers no skills does not re-render the composer. */
const NO_SKILLS: SkillConfig[] = []
const DAY = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })

function rowTime(row: Row): number | undefined {
  if (row.kind === 'event') return row.event.ts
  if (row.kind === 'turn') return row.startedAt
  return undefined
}

const isUserBubbleRow = (row: Row | undefined): boolean =>
  row?.kind === 'pending' ||
  (row?.kind === 'event' && row.event.type === 'user_message' && row.event.source === undefined && row.confirmTasks === undefined && !isModelOnlyMessage(row.event))

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

function dateLabelsFor(rows: readonly Row[], enabled: boolean): (string | undefined)[] {
  if (!enabled) return rows.map(() => undefined)
  const labels: (string | undefined)[] = []
  let previous = ''
  for (const row of rows) {
    const timestamp = rowTime(row)
    if (timestamp === undefined) {
      labels.push(undefined)
      continue
    }
    const at = new Date(timestamp)
    const key = `${at.getFullYear()}-${at.getMonth()}-${at.getDate()}`
    labels.push(key === previous ? undefined : DAY.format(at))
    previous = key
  }
  return labels
}

const NO_CHANGEABLE: ReadonlyMap<string, ChangeableAnswer> = new Map()

function ChatContent({ chatId }: { chatId: string | undefined }) {
  const hostAuto = useHostAuto()
  const { workspace, status, askProjectCheckout, askCheckoutStatus, openChat, leaveChat, sendMessage, stopTurn, stopBackground, stopSubagent, answerUserInput, answerSecretRequest, changeSessionAnswer, submitOutboundDraft, discardOutboundDraft, snoozeOutboundDraft, ignoreOutboundDraft, restoreOutboundDraft, readOutboundThread, setChatOverride, setChatSettled, rejectWorkHandoff, listRepoFiles, readRepoFile } = useWorkspace()
  const [draft, setDraft] = useState(() => readDraft(chatId).text)
  const [images, setImages] = useState<ImageAttachment[]>(() => readDraft(chatId).images)
  const [textFiles, setTextFiles] = useState<StagedFile[]>(() => readDraft(chatId).files)
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
  const insets = useSafeAreaInsets()
  const covered = useScreenCovered()
  // The footer is an overlay that sticks to the keyboard, and its measured height is
  // the list's bottom inset, so the newest message always rests just above the
  // composer: with the keyboard down, up, or mid-flight. The keyboard controller
  // drives both natively along the keyboard's own curve, nothing scrolls from JS.
  const keyboardUp = useKeyboardState((state) => state.isVisible)
  const { contentInsetEndAdjustment, onComposerLayout } = useKeyboardChatComposerInset(listRef, footerRef, ESTIMATED_FOOTER)
  const { freeze, scrollMessageToEnd } = useKeyboardScrollToEnd({ listRef })
  // What the footer pads below the composer while the keyboard is down. The
  // keyboard covers it, so the footer sinks by that much when up, keeping the
  // composer `spacing.md` above the keys; the list is told the same distance.
  const footerPad = Math.max(insets.bottom, spacing.md)
  const keyboardSink = footerPad - spacing.md

  // On focus, not only on mount: back from a chat pushed over this one makes this the
  // open chat again, so a run finishing in the chat he left is not settled as read.
  // Losing focus gives the selection up, unless the screen above already took it: from
  // the inbox no chat is open, so this one can show unread and a reconnect leaves it be.
  useFocusEffect(useCallback(() => {
    if (chatId === undefined) return
    openChat(chatId)
    return () => leaveChat(chatId)
  }, [chatId, leaveChat, openChat]))

  /**
   * A draft belongs to its conversation, not to this screen: walking back to the list
   * unmounts the transcript, and what was typed has to be there on the way in again.
   * Written through on every change rather than parked on the way out, because the way
   * out is a route disappearing and not an event this screen gets to see.
   */
  const changeDraft = (text: string) => {
    setDraft(text)
    writeDraft(chatId, { text, images, files: textFiles, ...(replyTo === undefined ? {} : { replyTo }), ...(quote === undefined ? {} : { quote }) })
  }
  const changeImages = (next: ImageAttachment[]) => {
    setImages(next)
    writeDraft(chatId, { text: draft, images: next, files: textFiles, ...(replyTo === undefined ? {} : { replyTo }), ...(quote === undefined ? {} : { quote }) })
  }
  const changeTextFiles = (next: StagedFile[]) => {
    setTextFiles(next)
    writeDraft(chatId, { text: draft, images, files: next, ...(replyTo === undefined ? {} : { replyTo }), ...(quote === undefined ? {} : { quote }) })
  }
  const chooseReply = useCallback((reply: MessageReply) => {
    setReplyTo(reply)
    writeDraft(chatId, { ...readDraft(chatId), replyTo: reply })
  }, [chatId])
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
  const thread = threadOf(workspace, chatId ?? '')
  const baseRows = useMemo(() => rowsOf(thread, chat?.kind), [thread, chat?.kind])
  // What runs in each Session, so its card says what its overview row says.
  const sessionLive = useMemo(() => sessionLiveOf(workspace), [workspace.activity, workspace.subagents, workspace.backgroundChatIds])
  const rows = useMemo(
    () => projectWorkHandoffs(baseRows, workspace.workHandoffs, workspace.chats, workspace.projects, workspace.agents, workspace.checkoutStatus, sessionLive, chatId),
    [baseRows, workspace.workHandoffs, workspace.chats, workspace.projects, workspace.agents, workspace.checkoutStatus, sessionLive, chatId],
  )
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
  // A Session persona's old DM stays readable; it no longer takes messages.
  const sessionDmAgent = chat?.kind === 'dm'
    ? workspace.agents.find((agent) => agent.id === chat.memberIds[0] && agent.placement === 'session')
    : undefined
  const singleChat = chat?.mode === 'single'
  // A project thread (2026-10-10) lists its open sessions in the bar and holds their
  // questions; a session it started asks and confirms there.
  const projectThread = chatId !== undefined && isProjectThread(workspace, chatId)
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
  const consultationMarkers = useMemo(
    () => chat?.kind === 'dm' ? stackedConsultationMarkers(rows) : new Map(),
    [chat?.kind, rows],
  )
  // In a DM, memory writes are reached through a reply's long-press actions only.
  const memoryMarks = useMemo(() => chat?.kind === 'dm' ? dmMemoryMarks(rows) : undefined, [chat?.kind, rows])
  // A Session has no card of its own result, so its Ready row comes from the handoff.
  const sessionReady = useMemo(
    () => chat == null ? undefined : sessionReadyRow(chat, workspace.workHandoffs, workspace.chats, workspace.projects, workspace.agents, workspace.checkoutStatus, sessionLive),
    [chat, workspace.workHandoffs, workspace.chats, workspace.projects, workspace.agents, workspace.checkoutStatus, sessionLive],
  )
  // A project thread bundles what needs nothing from the user; the docks and the question card read the full rows.
  const feedRows = useMemo(() => projectThread ? projectThreadFeed(rows) : rows, [projectThread, rows])
  // A DM turn that draws nothing gets no row: an empty one still takes a slot and its gap,
  // and inserting it as a turn starts pushes the working indicator down, then back.
  const visibleRows = useMemo(
    () => feedRows.filter((row) => row.kind === 'event'
      ? consultationMarkers.get(row.event.id)?.length !== 0
      : !(chat?.kind === 'dm' && row.kind === 'turn' && (onlyConsulted(row) || dmTurnDrawsNothing(row)))),
    [chat?.kind, consultationMarkers, feedRows],
  )
  const unannounced = useMemo(() => unannouncedConsultations(rows), [rows])
  const historyOffset = historyStart(visibleRows, firstKey)
  const pageRows = useMemo(() => visibleRows.slice(historyOffset), [visibleRows, historyOffset])
  // A sent message keeps its pending row's list key once stored. Updated while rendering,
  // so the list never sees the stored row under a key of its own.
  const [listKeys, setListKeys] = useState<{ rows: readonly Row[]; carried: ReadonlyMap<string, string> }>(() => ({ rows: pageRows, carried: new Map() }))
  if (listKeys.rows !== pageRows) setListKeys({ rows: pageRows, carried: carryPendingKeys(listKeys.rows, pageRows, listKeys.carried) })
  const listKeyOf = useCallback((row: Row) => listKeys.carried.get(row.key) ?? row.key, [listKeys.carried])
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
  const dateLabels = useMemo(() => dateLabelsFor(pageRows, isPair), [isPair, pageRows])
  useEffect(() => {
    setFirstKey(visibleRows[historyOffset]?.key)
  }, [visibleRows, historyOffset])
  const loadOlder = () => {
    if (historyOffset > 0) setFirstKey(olderHistoryKey(visibleRows, historyOffset))
  }
  const waitingOnByTurn = useMemo(() => {
    const waiting = new Map<string, string>()
    for (const row of rows) {
      if (row.kind !== 'event' || row.event.type !== 'agent_relay') continue
      if (row.event.phase === 'sent') waiting.set(row.event.turnId, row.event.peerAgentId)
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
  const ask = useMemo(() => openAsk(rows), [rows])
  // A DM's indicator waits on a consulted colleague only while her pair chat still runs.
  const runningChatIds = useMemo(
    () => new Set(Object.entries(workspace.activity).filter(([, activity]) => activity.runningTurns.length > 0).map(([id]) => id)),
    [workspace.activity],
  )
  // A project thread's face leaves with its own turn; it never waits on a consult.
  const working = useMemo(() => {
    if (chat?.kind !== 'dm' && !projectThread) return undefined
    const state = dmWorking(rows, runningChatIds)
    return projectThread && state?.kind === 'consult' ? undefined : state
  }, [chat?.kind, projectThread, rows, runningChatIds])
  const startedBy = useMemo(
    () => chatId === undefined ? undefined : sessionThreadOf(workspace, chatId),
    [workspace.projects, workspace.workHandoffs, chatId],
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
    () => projectThread && chatId !== undefined ? projectSessionOverview(workspace, chatId) : null,
    [projectThread, workspace.projects, workspace.chats, workspace.workHandoffs, workspace.activity, workspace.subagents, workspace.backgroundChatIds, chatId],
  )
  // The Sessions button's one dot: the user is needed, a Session finished unseen, or one runs.
  const sessionsMark = useMemo(() => sessionOverview === null ? null : sessionsDot(sessionOverview), [sessionOverview])
  const threadQuestion = useMemo(
    () => projectThread && chatId !== undefined ? openThreadQuestion(workspace, chatId) : null,
    [projectThread, thread.events, workspace.activity, chatId],
  )
  // The card the thread draws for its session's question: the session's title heads every
  // question, so the card says who is asking.
  const threadAsk = useMemo<OpenAsk | null>(
    () => threadQuestion === null ? null : {
      requestId: threadQuestion.requestId,
      agentId: threadQuestion.agentId,
      more: threadQuestion.more,
      questions: threadQuestion.questions.map((question) => ({ ...question, header: `${threadQuestion.title} asks ${project?.name ?? 'the project'}` })),
    },
    [threadQuestion, project?.name],
  )
  // A subagent's question waits here, at the top of its line: its own screen takes no answers.
  const subagentQuestion = useMemo(
    () => chatId === undefined ? null : openSubagentQuestion(workspace, chatId),
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
  const subagentSummary = useCallback((childId: string) => subagentSummaryOf(workspace, childId), [workspace.subagents, workspace.threads])
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
        return { ...question, header: `${changingAnswer.title} · Manor chose ${given === undefined ? 'nothing' : userInputAnswerText(given)}` }
      }),
    },
    [changing, changingAnswer],
  )
  const activeTurn = thread.liveTurns.find((turn) => turn.state === 'running') ?? null
  // Children outlive the turn that started them, so the chat can wait with no turn running.
  const waiting = useMemo(() => activeTurn === null && chatWaitsOnBackground(rows), [activeTurn, rows])
  const startedAgentIds = useMemo(() => runtimeStartedAgentIds(thread), [thread.events, thread.liveTurns])
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
  // all, so `@Smith` inside Sage's DM is text Sage reads, not a summons. That makes
  // the mentionable set empty rather than filtered, and it is also the roster the
  // `$` menu reads skills off, which is why the composer gets no wider one.
  const mentionable = chat !== null && isSoloRoom(chat) ? [] : roster
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
  const recipients = ((): AgentConfig[] | 'unknown' | undefined => {
    if (chat === null || singleChat || !composerShowsRecipients(chat.kind, thread.events, thread.pending.length)) return undefined
    if (replyTo === undefined && (activeTurn !== null || thread.pending.length > 0)) return 'unknown'
    const members = chat.kind === 'group' ? chat.memberIds : undefined
    // Parsed against the whole roster, then filtered to the room, as the server does:
    // an outsider's name in a group, or a chat persona's in a Session, is a mention
    // that reaches nobody, not no mention.
    return draftRecipients(draft, workspace.agents, effectiveFallbackTargets, members, roomAgents(workspace.agents, chat))
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
  const scrollToHolder = useCallback((holder: Row, holds: ((item: Row) => boolean) | undefined, position: { viewPosition: number; viewOffset?: number }) => {
    const unfold = holder.kind === 'thread_bundle' && holds !== undefined
    if (unfold) setOpenBundles((current) => openThreadBundleAt(current, stretchRef.current, holder, holds))
    const place = unfold ? { viewPosition: 0 } : position
    const scroll = (index: number) => void listRef.current?.scrollToIndex({ animated: true, index, ...place })
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

  const openQuoteSource = useCallback((eventId: string) => {
    const holder = visibleRows.find((row) => rowHasQuoteSource(row, eventId))
    if (holder !== undefined) scrollToHolder(holder, (item) => rowHasQuoteSource(item, eventId), { viewPosition: 0.5 })
  }, [scrollToHolder, visibleRows])

  const revealRow = useCallback((rowKey: string, place: RevealPlace = 'center') => {
    // A card at the end rests above the jump to the latest message, which floats there.
    const position = place === 'end' ? { viewPosition: 1, viewOffset: -JUMP_SPACE } : { viewPosition: 0.5 }
    const holder = visibleRows[feedIndexOf(visibleRows, rowKey)]
    if (holder !== undefined) scrollToHolder(holder, holder.key === rowKey ? undefined : (item) => item.key === rowKey, position)
  }, [scrollToHolder, visibleRows])
  // The same call for the memoized rows, which must not re-render on every new message.
  const revealRowRef = useRef(revealRow)
  useEffect(() => {
    revealRowRef.current = revealRow
  }, [revealRow])
  const revealRowStable = useCallback((rowKey: string, place?: RevealPlace) => revealRowRef.current(rowKey, place), [])
  // A proposal picked on the project's Sessions screen lands on its card here.
  useFocusEffect(useCallback(() => {
    if (!projectThread || chatId === undefined) return
    const rowKey = takeThreadReveal(chatId)
    if (rowKey !== null) requestAnimationFrame(() => revealRowRef.current(rowKey))
  }, [projectThread, chatId]))

  // The open Session cards the thread shows right now, which the bar leaves out. Null
  // until this chat has measured, so the bar never shows rows it will drop. Measured
  // against the part of the screen between the header and the bar or composer, both of
  // which float over the list; rows the list has not rendered count as out of view.
  const [cardsInView, setCardsInView] = useState<{ chatId: string | undefined; keys: ReadonlySet<string> } | null>(null)
  const workCardsInView = cardsInView !== null && cardsInView.chatId === chatId ? cardsInView.keys : null
  const workDockRef = useRef<View>(null)
  const measureRound = useRef(0)
  const openCardKeys = useMemo(
    () => pageRows.flatMap((row) => row.kind === 'work_handoff' && workDecisionOpen(row) ? [row.key] : []),
    [pageRows],
  )
  const headerFloor = insets.top + CHAT_HEADER_HEIGHT
  const measureWorkCards = useCallback(() => {
    const round = (measureRound.current += 1)
    const report = (keys: ReadonlySet<string>) => {
      if (round !== measureRound.current) return
      setCardsInView((current) => current !== null && current.chatId === chatId && sameKeys(current.keys, keys) ? current : { chatId, keys })
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
      report(new Set(openCardKeys.filter((_, index) => {
        const card = cards[index]
        return card !== undefined && workCardInView(card, view)
      })))
    })
  }, [chatId, headerFloor, openCardKeys])
  useEffect(() => {
    // After the list has laid the new rows out.
    const frame = requestAnimationFrame(measureWorkCards)
    return () => cancelAnimationFrame(frame)
  }, [measureWorkCards])

  const submit = (text: string) => {
    const placed = placeQuotesAfterText({ text, ...(quote === undefined ? {} : { quote }) })
    if (chatId === undefined || !sendMessage(chatId, placed.text, images, textFiles, replyTo, placed.quotes)) return
    setDraft('')
    setImages([])
    setTextFiles([])
    setReplyTo(undefined)
    setQuote(undefined)
    writeDraft(chatId, EMPTY_DRAFT)
    if (showJump) followSend.current = true
    setJumpForChat(null)
  }

  const trackScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement, contentInset } = event.nativeEvent
    // The keyboard and the footer live in the bottom inset, which the offset runs into.
    const end = contentSize.height + (contentInset?.bottom ?? 0) - layoutMeasurement.height
    // A rubber band past the oldest message in a short chat is not scrolling away.
    const nearEnd = end < NEAR_END || end - contentOffset.y < NEAR_END
    setJumpForChat((current) => {
      const away = current === chatId
      if (nearEnd === !away) return current
      return nearEnd ? null : (chatId ?? null)
    })
    measureWorkCards()
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

  if (chatId === undefined) return null

  /**
   * Who the header names. A DM is one persona, so it says her: her name, her role
   * beside it and what she runs on underneath, the same three facts the agents list
   * shows. A group is its own name with everyone in it under that. Every other chat
   * keeps saying where it lives, because there the project is the identity.
   */
  const dmAgent = chat?.kind === 'dm' ? roster[0] : undefined
  // Auto never claims a DM (the server skips it), so its pin reads as Auto off: the
  // labels and the sheet then name the model the agent runs on.
  const dmOverride = { ...(dmAgent === undefined ? undefined : thread.overrides[dmAgent.id]), auto: false }
  // A Single Session names its runtime instead of its project (2026-11-12), so a model
  // change shows where the eye already is. A Multiple Session has no one runtime.
  const singleDefault = defaultSingleRuntime(workspace.agents)
  const singleOverride = thread.overrides[SINGLE_CHAT_VOICE.id] ?? {}
  const singleVoice = singleRuntimeVoice(readSingleRuntime(singleOverride, singleDefault))
  const sessionRuntime = chat?.kind === 'project' && singleChat && !projectThread ? singleVoice : undefined
  const memberNames = chat?.kind === 'group'
    ? chat.memberIds.map((id) => personaOf(workspace.agents, id).name).join(', ')
    : undefined
  const pairTitle = chat?.kind === 'pair'
    ? chat.memberIds.map((id) => personaOf(workspace.agents, id).name).join(' ⇄ ')
    : undefined
  const lead =
    dmAgent !== undefined
      ? runtimeParts(dmAgent, dmOverride, hostAuto).model
      : sessionRuntime !== undefined
        ? runtimeLabel(singleVoice, singleOverride, hostAuto)
        : memberNames ?? (project !== undefined && isHomeRoom(project.id) ? 'No project' : project?.name) ?? (chat?.kind === 'side' ? 'Side chat' : 'Chat')
  // The Mac's name lives in the side menu only; a connection that is not live
  // still earns the line.
  const connection = status === 'live' ? null : status === 'connecting' ? 'Connecting…' : 'Offline'
  // The composer's model chip: the one runtime that answers here. A Single Session and a
  // project thread run the anonymous voice, a DM its persona; a room with several has none.
  const composerModel = singleChat
    ? { label: runtimeParts(singleVoice, singleOverride, hostAuto).model, onPress: () => setSheet('model') }
    : dmAgent !== undefined && sessionDmAgent === undefined
      ? { label: runtimeParts(dmAgent, dmOverride, hostAuto).model, onPress: () => setSheet('model') }
      : undefined
  const subtitle = pairTitle === undefined ? (connection === null ? lead : `${lead} · ${connection}`) : (connection ?? 'Between agents')
  const topInset = insets.top + CHAT_HEADER_HEIGHT + spacing.lg

  return (
    <SubagentDirectory.Provider value={directory}>
    <SubagentLaunchesContext.Provider value={launches}>
    <AnswerChange.Provider value={answerChange}>
    <TranscriptCovered.Provider value={covered}>
    <View style={styles.screen}>
      <KeyboardAwareLegendList
        // Short threads sit at the bottom, long ones open there, and the end stays
        // pinned while a reply streams or a message lands, as long as the user is near
        // it. Rows keep their own fold state, so they are not recycled.
        alignItemsAtEnd
        contentContainerStyle={[styles.feed, { paddingTop: topInset }]}
        contentInsetEndAdjustment={contentInsetEndAdjustment}
        data={pageRows}
        // A bundle's open state lives here, not in its row, so the list redraws when it changes.
        extraData={openBundles}
        estimatedItemSize={ESTIMATED_ROW}
        freeze={freeze}
        initialScrollAtEnd
        keyboardDismissMode="interactive"
        keyboardLiftBehavior="always"
        keyboardOffset={keyboardSink}
        keyExtractor={listKeyOf}
        // Under a subagent's screen the list stays where it was left.
        maintainScrollAtEnd={covered ? false : { animated: false, on: { dataChange: true, footerLayout: true, itemLayout: true, layout: true } }}
        maintainScrollAtEndThreshold={0.15}
        maintainVisibleContentPosition
        onStartReached={loadOlder}
        onStartReachedThreshold={0.3}
        ListHeaderComponent={historyOffset > 0 ? (
          <Pressable accessibilityRole="button" onPress={loadOlder} style={{ alignSelf: 'center', padding: spacing.md }}>
            <Text style={{ color: colors.dim }}>Load earlier messages</Text>
          </Pressable>
        ) : null}
        ListFooterComponent={working === undefined ? null : (
          <DmWorkingIndicator
            agents={workspace.agents}
            persona={personaOf(workspace.agents, working.kind === 'turn' ? working.turn.agentId : working.kind === 'consult' ? working.agentId : projectThread ? SINGLE_CHAT_VOICE.id : chat?.memberIds[0] ?? 'unknown')}
            working={working}
            bare={projectThread}
          />
        )}
        recycleItems={false}
        ListEmptyComponent={
          thread.hasSnapshot
            ? <View style={styles.empty}><Text style={styles.emptyTitle}>An empty conversation</Text><Text style={styles.emptyCopy}>Say something to get started.</Text></View>
            : <View style={styles.empty}><Text style={styles.emptyCopy}>Loading conversation…</Text></View>
        }
        onScroll={trackScroll}
        ref={listRef}
        renderItem={({ item, index }) => (
          <TranscriptRow
            agents={workspace.agents}
            connected={status === 'live'}
            bubbleReplies={chat?.kind === 'dm'}
            {...(userBubbleTint === undefined ? {} : { userBubbleTint })}
            showSpeaker={!singleChat}
            quoteAuthors={chat !== null && quoteNamesAuthor(chat, projectThread)}
            {...(projectThread && project !== undefined ? { threadProject: project } : {})}
            pinPlan={chat?.kind === 'project' && !projectThread}
            compactUser={dateLabels[index] === undefined && isUserBubbleRow(item) && isUserBubbleRow(pageRows[index - 1])}
            latest={item.key === latestTurnKey}
            links={replyLinks}
            draftActions={draftActions}
            repoFiles={listing?.files}
            row={item}
            {...(item.kind === 'thread_bundle' ? { bundleOpen: threadBundleOpen(openBundles, stretch, item.key), bundleOpenItems: threadBundleOpenItems(openBundles, stretch, item), onBundleOpen: setBundleOpen } : {})}
            dateLabel={dateLabels[index]}
            waitingOnAgentId={item.kind === 'turn' ? waitingOnByTurn.get(item.turnId) : undefined}
            consultationMarker={item.kind === 'event' ? consultationMarkers.get(item.event.id) : undefined}
            unannounced={item.kind === 'event' && item.event.type === 'agent_relay' && item.event.phase === 'sent' ? unannounced.get(item.event.turnId) : undefined}
            relayOffset={dateLabels[index] === undefined ? relayOffset(item, pageRows[index - 1]) : undefined}
            {...(projectThread && dateLabels[index] === undefined ? { threadOffset: threadOffset(item, pageRows[index - 1]) } : {})}
            onOpenAgentRelay={(pairChatId) => {
              openChat(pairChatId)
              router.push({ pathname: '/chat/[id]', params: { id: pairChatId } })
            }}
            {...(project === undefined || project.name === '' ? {} : { forwardSource: project.name })}
            onRejectWork={rejectWork}
            onReveal={revealRowStable}
            {...(memoryMarks === undefined || item.kind !== 'turn' ? {} : { memoryChanges: memoryMarks.get(item.key) })}
            onOpenSubagent={openSubagent}
            onOpenQuoteSource={openQuoteSource}
            {...(chat?.kind === 'dm' || chat?.kind === 'group' ? { onReply: chooseReply } : {})}
            {...(isPair ? {} : { onQuoteSource: (source: QuoteSelectionSource) => setQuoteSelection({ ...source, text: plainDraftText(source.text) }) })}
          />
        )}
        scrollEventThrottle={80}
        scrollIndicatorInsets={{ top: topInset - spacing.lg }}
      />

      <ChatHeader
        agentIds={chat?.kind === 'pair' ? chat.memberIds : chat?.agentIds ?? []}
        agents={workspace.agents}
        {...(dmAgent !== undefined && !isAutoPending(dmAgent, dmOverride, hostAuto) ? { driver: effectiveDriver(dmAgent, dmOverride) } : {})}
        {...(sessionRuntime !== undefined && !isAutoPending(sessionRuntime, singleOverride, hostAuto) ? { driver: effectiveDriver(sessionRuntime, singleOverride) } : {})}
        {...(isPair || singleChat || chat?.kind === 'side' ? {} : { onAgents: () => setSheet('agents') })}
        {...(subagents.length === 0 ? {} : { onSubagents: () => setSheet('subagents'), subagentsRunning })}
        onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))}
        {...(dmAgent === undefined || dmAgent.role === '' ? {} : { role: dmAgent.role })}
        subtitle={subtitle}
        {...(chat?.kind === 'project' && project !== undefined && startedBy === undefined ? { project } : {})}
        projectThread={projectThread}
        {...(sessionOverview === null || chatId === undefined ? {} : { onSessions: () => router.push({ pathname: '/sessions/[threadId]', params: { threadId: chatId } }), sessionsDot: sessionsMark })}
        {...(projectThread && project !== undefined ? { onProject: () => setSheet('settings') } : {})}
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

      <KeyboardStickyView enabled={keyboardUp && !isPair} offset={{ closed: 0, opened: keyboardSink }} style={styles.footer}>
      <View
        onLayout={(event) => {
          const height = Math.round(event.nativeEvent.layout.height)
          // The keyboard view takes a shrink off the offset without stopping at the top,
          // which sinks a short chat below the composer when a question card closes.
          const closing = height < footerHeight && !showJump && pageRows.length > 0
          if (closing) freeze.set(true)
          setFooterHeight(height)
          onComposerLayout(event)
          if (closing) void scrollMessageToEnd({ animated: false, closeKeyboard: false })
        }}
        pointerEvents="box-none"
        ref={footerRef}
      >
        <EdgeScrim edge="bottom" height={footerHeight} />
        {/* The Session bar stands in the footer (2026-10-12), so the list's bottom
            inset counts it and no message ever sits behind Accept or Confirm. */}
        <View
          ref={workDockRef}
          onLayout={measureWorkCards}
          pointerEvents="box-none"
          style={styles.workDock}
        >
          {isPair || sessionDmAgent !== undefined ? null : (
            <WorkDecisionDock
              rows={sessionReady === undefined ? rows : [sessionReady]}
              inView={workCardsInView}
              agents={workspace.agents}
              onReject={rejectWork}
              onReveal={(rowKey, place) => {
                // The phone has no diff: a Session's own Ready row leads to its card in the
                // briefing DM, where Request changes writes and the result reads in full.
                const source = sessionReady?.key === rowKey ? workspace.workHandoffs.find((handoff) => handoff.id === sessionReady.handoffId)?.sourceChatId : undefined
                if (source === undefined) revealRow(rowKey, place)
                else router.push({ pathname: '/chat/[id]', params: { id: source } })
              }}
            />
          )}
        </View>
        {/* The jump floats, because it comes and goes with the scroll and nothing
            should shift under a thumb when it does. The pill below it does not: it
            stands for as long as the chat has written anything, so it belongs in the
            footer's own height, where the list's bottom inset accounts for it and the
            last message rests above it instead of behind it. */}
        {showJump ? (
          <Animated.View entering={glassRise} exiting={glassSink} style={styles.jump}>
            <GlassIconButton
              accessibilityLabel="Jump to latest"
              icon={ArrowDown01Icon}
              onPress={jumpToLatest}
              size={36}
            />
          </Animated.View>
        ) : null}
        {showAggregateChanges ? (
          <Animated.View entering={glassRise} exiting={glassSink} style={styles.pill}>
            <EditsPill files={chatChanges} onPress={() => setAllEditsOpen(true)} />
          </Animated.View>
        ) : null}
        <View style={[styles.footerInner, { paddingBottom: footerPad }]}>
          {isPair || sessionDmAgent !== undefined ? (
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
            <View style={styles.routedAsk}>
              <Text numberOfLines={1} style={styles.routedAskText}>Waiting for a choice in the project thread</Text>
              <Pressable
                accessibilityLabel="Open project thread"
                accessibilityRole="button"
                onPress={openStartedBy}
                style={({ pressed }) => [styles.routedAskAction, pressed && styles.pressed]}
              >
                <Text style={styles.routedAskActionText}>Open project thread</Text>
              </Pressable>
            </View>
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
            <Composer
              {...(chat === null || replyTo !== undefined || quote !== undefined ? {} : { commandContext: () => chatCommandContext(chat, project, thread?.events ?? [], workspace.workHandoffs,
                activeTurn !== null || sessionLive(chat.id).running || waiting || (thread?.pending.length ?? 0) > 0) })}
              busy={activeTurn !== null || waiting}
              disabled={status !== 'live'}
              draft={draft}
              {...(effectiveFallbackTargets === undefined ? {} : { fallbackTargets: [...effectiveFallbackTargets] })}
              files={listing?.files ?? []}
              filesTruncated={listing?.truncated ?? false}
              images={images}
              textFiles={textFiles}
              onChangeTextFiles={changeTextFiles}
              {...(chat?.kind === 'group' ? { memberIds: chat.memberIds } : { })}
              mentionable={mentionable}
              allowWorkDestination={!singleChat && chat?.kind === 'dm'}
              allSkillsAvailable={singleChat}
              {...(contextMeter === undefined ? {} : { contextMeter })}
              {...(composerModel === undefined ? {} : { model: composerModel })}
              {...(chat !== null && isSoloRoom(chat) ? {} : { roster: workspace.agents })}
              {...(recipients === undefined ? {} : { recipients })}
              onChangeDraft={changeDraft}
              onChangeImages={changeImages}
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
      </View>
      </KeyboardStickyView>

      {isPair || singleChat || chat?.kind === 'side' ? null : <RuntimeSheet
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
          allowAuto={!startedAgentIds.includes(SINGLE_CHAT_VOICE.id) && singleOverride.autoResolved !== true}
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
    </TranscriptCovered.Provider>
    </AnswerChange.Provider>
    </SubagentLaunchesContext.Provider>
    </SubagentDirectory.Provider>
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
  threadProject?: NonNullable<ReturnType<typeof useWorkspace>['workspace']['projects'][number]>
  compactUser: boolean
  onReply?: (reply: MessageReply) => void
  onQuoteSource?: (source: QuoteSelectionSource) => void
  onOpenQuoteSource: (eventId: string) => void
  draftActions: DraftActions
  dateLabel?: string
  waitingOnAgentId?: string
  consultationMarker?: readonly TurnConsultation[]
  /** Set when the asking turn said nothing, so the marker states the question. */
  unannounced?: readonly UnannouncedConsultation[] | undefined
  relayOffset?: number | undefined
  /** In a project thread: where this row sits against the one above, set by `threadSpacing`. */
  threadOffset?: number | undefined
  onOpenAgentRelay: (chatId: string) => void
  /** In a Session: the project whose thread sent the user's messages on here. */
  forwardSource?: string
  onRejectWork: (chatId: string) => void
  onReveal: (rowKey: string, place?: RevealPlace) => void
  onOpenSubagent: (toolCallId: string) => void
  /** In a DM: the memory writes this turn's reply shows. */
  memoryChanges?: Extract<Row, { kind: 'turn' }>['memoryChanges']
  /** In a Session: a turn's plan stands at its end. */
  pinPlan: boolean
  /** A project thread bundle: whether it stands open, and how it opens or folds. */
  bundleOpen?: boolean
  bundleOpenItems?: ReadonlySet<string>
  /** Opens or closes a bundle (its own key) or one of its lines (the item's key). */
  onBundleOpen?: (key: string, open: boolean) => void
}

const NO_OPEN_ITEMS: ReadonlySet<string> = new Set()

const TranscriptRow = memo(function TranscriptRow(props: TranscriptRowProps) {
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
    threadProject,
    compactUser,
    onReply,
    onQuoteSource,
    onOpenQuoteSource,
    draftActions,
    dateLabel,
    waitingOnAgentId,
    consultationMarker,
    unannounced,
    relayOffset,
    threadOffset,
    onOpenAgentRelay,
    forwardSource,
    onRejectWork,
    onReveal,
    onOpenSubagent,
    memoryChanges,
    pinPlan,
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
        // A DM keeps the compact line; helper cards are Session work.
        ? bubbleReplies ? <Text style={styles.note}>{wakeLine(eventRow.event.wakeItems ?? [])}</Text> : <WakeNotices items={eventRow.event.wakeItems ?? []} ts={eventRow.event.ts} />
      : brief !== ''
        ? <KickoffCard agents={agents} text={brief} images={eventRow.event.images ?? []} files={eventRow.event.files ?? []} />
      : eventRow.event.source === 'project_thread'
        // Manor's wake of the thread: `projectThreadFeed` drops it, and it never reads as his bubble.
        ? null
      : eventRow.event.source === 'work_handoff'
        ? <KickoffCard agents={agents} text={messageBrief(eventRow.event)} images={eventRow.event.images ?? []} files={eventRow.event.files ?? []} />
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
          {...(userBubbleTint === undefined ? {} : { tint: userBubbleTint })}
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
          {...(eventRow.event.noteQuote === undefined ? {} : { noteQuote: eventRow.event.noteQuote })}
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
    return <Bubble agents={agents} dim quoteAuthors={quoteAuthors} files={row.files} {...(row.documents === undefined ? {} : { documents: row.documents })} images={row.images} text={row.text} {...(row.replyTo === undefined ? {} : { replyTo: row.replyTo })} {...(row.quotes === undefined ? {} : { quotes: row.quotes })} onOpenQuoteSource={onOpenQuoteSource} />
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
            compactUser={false}
            dateLabel={undefined}
            relayOffset={undefined}
            threadOffset={undefined}
            waitingOnAgentId={undefined}
            consultationMarker={undefined}
            unannounced={undefined}
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
      if (consultationMarker !== undefined) {
        return (
          <ConsultedAgents
            action={row.event.phase === 'received' ? 'Message from' : 'Messaged'}
            consultations={consultationMarker}
            agents={agents}
            onOpen={onOpenAgentRelay}
            {...(unannounced === undefined ? {} : { unannounced })}
          />
        )
      }
      return <RelayMarker agents={agents} event={row.event} onOpen={onOpenAgentRelay} {...(unannounced === undefined ? {} : { unannounced })} />
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
    <View style={[styles.transcriptItem, compactUser ? styles.compactUserItem : relayOffset !== undefined ? { marginTop: relayOffset } : threadOffset === undefined ? null : { marginTop: threadOffset }]}>
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
  agents,
  onOpen,
  unannounced,
}: {
  event: Extract<Extract<Row, { kind: 'event' }>['event'], { type: 'agent_relay' }>
  agents: AgentConfig[]
  onOpen: (chatId: string) => void
  unannounced?: readonly UnannouncedConsultation[]
}) {
  const peer = personaOf(agents, event.peerAgentId)
  const action = event.phase === 'sent' ? 'Messaged' : event.phase === 'received' ? 'Message from' : 'Message failed from'
  const consultation = unannounced?.find((entry) => entry.relayId === event.relayId)
  return (
    <View style={styles.relayColumn}>
      <Pressable
        accessibilityLabel={`${action} ${peer.name}`}
        accessibilityRole="button"
        onPress={() => onOpen(event.pairChatId)}
        style={({ pressed }) => [styles.relayMarker, pressed && styles.pressed]}
      >
        <Text style={styles.relayMarkerText}>{action}</Text>
        <Blobatar color={peer.color} name={peer.name} shape={peer.avatarShape} tone={peer.avatarTone} size={16} src={peer.avatar} />
        <Text style={styles.relayMarkerText}>{peer.name}</Text>
      </Pressable>
      {consultation === undefined ? null : <ConsultationExcerpt question={consultation.question} replyPending={consultation.replyPending} />}
    </View>
  )
}

/**
 * The question a silent turn asked, one muted line under its marker. A tap opens the
 * whole first line in place; "reply follows" stays until the reply's marker lands.
 */
function ConsultationExcerpt({ question, replyPending }: { question: string; replyPending: boolean }) {
  const [open, setOpen] = useState(false)
  const follows = replyPending ? ' · reply follows' : ''
  return (
    <Pressable
      accessibilityLabel={`Question: ${question}${follows}`}
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      hitSlop={4}
      onPress={() => setOpen((value) => !value)}
      style={styles.relayExcerpt}
    >
      {open ? (
        <Text style={[styles.relayExcerptText, styles.relayExcerptOpen]}>“{question}”{follows}</Text>
      ) : (
        <>
          <Text numberOfLines={1} style={[styles.relayExcerptText, styles.relayExcerptShrink]}>“{question}”</Text>
          {follows.length === 0 ? null : <Text style={styles.relayExcerptText}>{follows}</Text>}
        </>
      )}
    </Pressable>
  )
}

const NO_INLINE_QUOTES: readonly InlineQuote[] = []

/** `tint` fills a DM bubble with the face he is talking to; its chips read the same tint. A dimmed (pending) bubble stays grey so its fade cannot pull the tinted ink below AA. */
function Bubble({ text, images, agents, files = [], documents = [], replyTo, quote, noteQuote, quotes = NO_INLINE_QUOTES, sourceEventId, onQuoteSource, onOpenQuoteSource, dim = false, tint, quoteAuthors = false }: { text: string; images: readonly EventImage[]; agents: readonly AgentConfig[]; files?: readonly FileAttachment[]; documents?: readonly (EventDocument | PendingDocument)[]; replyTo?: MessageReply; quote?: MessageQuote; noteQuote?: NoteQuote; quotes?: readonly InlineQuote[]; sourceEventId?: string; onQuoteSource?: (source: QuoteSelectionSource) => void; onOpenQuoteSource?: (eventId: string) => void; dim?: boolean; tint?: BubbleTint; quoteAuthors?: boolean }) {
  // A message that refers to its pictures by number shows those numbers; older ones stay as they were.
  const numbered = imageRefSpans(text, images.length).length > 0
  const [openImage, setOpenImage] = useState<number | null>(null)
  const [openQuote, setOpenQuote] = useState<number | null>(null)
  const hasBubble = text !== '' || files.length > 0 || documents.length > 0 || replyTo !== undefined || quote !== undefined || noteQuote !== undefined
  return (
    <BubbleTintContext.Provider value={tint}>
    <View style={[styles.userMessage, dim && styles.pending]}>
      {/* Sent pictures sit above the bubble, as on desktop; a press opens the gallery. */}
      <Attachments alignEnd images={images} numbered={numbered} />
      {hasBubble ? (
        <View style={[styles.userBubble, tint && { backgroundColor: tint.fill }]}>
          {quote === undefined ? null : <QuoteBlock agents={agents} quote={quote} showAuthor={quoteAuthors} {...(onOpenQuoteSource === undefined ? {} : { onOpen: () => onOpenQuoteSource(quote.eventId) })} />}
          {noteQuote === undefined ? null : <NoteQuoteContextChip quote={noteQuote} />}
          {replyTo === undefined ? null : <ReplyContextChip name={agents.find((agent) => agent.id === replyTo.agentId)?.name ?? replyTo.agentId} reply={replyTo} />}
          <Attachments documents={documents} files={files} images={[]} />
          {text === '' ? null : (
            <Markdown
              agents={agents}
              text={normalizeComposerLists(text)}
              sent={{
                ...(numbered ? { imageCount: images.length, onOpenImage: setOpenImage } : {}),
                ...(quotes.length === 0 ? {} : { quotes, onOpenQuote: setOpenQuote }),
                ...(sourceEventId === undefined ? {} : {
                  accessibilityHint: 'Press and hold to quote text',
                  ...(onQuoteSource === undefined ? {} : { onLongPress: () => onQuoteSource({ eventId: sourceEventId, text: withQuoteExcerpts(text, quotes) }) }),
                }),
              }}
            />
          )}
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
    ? ` · late, due ${LATE_DUE.format(new Date(event.routineDueAt))}`
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
  userMessage: { maxWidth: '86%', alignSelf: 'flex-end', alignItems: 'flex-end', gap: spacing.xs + 2 },
  userBubble: { maxWidth: '100%', gap: spacing.sm, borderRadius: radius.composer, ...squircle, backgroundColor: colors.userBubble, paddingHorizontal: spacing.md + 2, paddingVertical: spacing.sm + 1 },
  pending: { opacity: 0.55 },
  note: { color: colors.muted, fontFamily: fonts.sans, fontSize: 13, lineHeight: 19, textAlign: 'center' },
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
  compactUserItem: { marginTop: 6 - spacing.xl },
  dateSeparator: { color: colors.dim, fontFamily: fonts.sans, fontSize: 12, textAlign: 'center' },
  relayMarker: { alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: radius.sm, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs },
  relayMarkerText: { color: colors.dim, fontFamily: fonts.sans, fontSize: 13 },
  relayColumn: { alignItems: 'center' },
  relayExcerpt: { maxWidth: '100%', flexDirection: 'row', paddingHorizontal: spacing.sm, paddingBottom: spacing.xs },
  relayExcerptText: { color: colors.dim, fontFamily: fonts.sans, fontSize: 12, lineHeight: 16 },
  relayExcerptShrink: { flexShrink: 1 },
  relayExcerptOpen: { flexShrink: 1, textAlign: 'center' },
  error: { color: colors.danger },
  footer: { position: 'absolute', right: 0, bottom: 0, left: 0 },
  jump: { position: 'absolute', top: -JUMP_SPACE, right: 0, left: 0, zIndex: 1, alignItems: 'center' },
  workDock: { paddingHorizontal: spacing.md },
  pill: { alignItems: 'center', paddingTop: spacing.md, paddingBottom: spacing.xs },
  // Above the floating jump: the composer's plus and `@`/`$` menus rise over it.
  footerInner: { zIndex: 2, paddingHorizontal: spacing.md, paddingTop: spacing.md },
  pairFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.md },
  pairNotice: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  pairNoticeText: { color: colors.muted, fontFamily: fonts.sans, fontSize: 14 },
  closeChat: { borderRadius: radius.round, backgroundColor: colors.surface2, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  routedAsk: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, borderRadius: radius.composer, ...squircle, backgroundColor: colors.raised, paddingVertical: spacing.sm, paddingLeft: spacing.lg, paddingRight: spacing.sm },
  routedAskText: { flex: 1, color: colors.muted, fontFamily: fonts.sans, fontSize: 14 },
  routedAskAction: { minHeight: 38, justifyContent: 'center', borderRadius: radius.sm, ...squircle, backgroundColor: colors.fill, paddingHorizontal: spacing.md },
  routedAskActionText: { color: colors.text, fontFamily: fonts.sans, fontSize: 13, fontWeight: '500' },
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
