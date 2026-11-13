import { chatCommandContext } from '@manor/client-runtime/chat-commands'
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Cancel01Icon, LockIcon } from '@hugeicons/core-free-icons'
import {
  SINGLE_CHAT_VOICE,
  isSoloRoom,
  type AgentConfig,
  type Chat,
  type ChatOverride,
  type CheckoutRequest,
  type InlineQuote,
  type MessageQuote,
  type MessageReply,
  type PageContextAttachment,
  type UserInputAnswers,
} from '@manor/contracts'
import type { ComposerAttachments } from '@manor/client-runtime/attachments'
import type { WorkAcceptanceOptions } from '@manor/client-runtime/commands'
import { liveSessionContext, singleWorkContext } from '@manor/client-runtime/context-meter'
import { avatarBubbleTint, projectBubbleTint } from '@manor/client-runtime/avatar-bubble'
import { quoteNamesAuthor } from '@manor/client-runtime/message-quotes'
import { chatSubagents, chatWaitsOnBackground, subagentStateOf, subagentTask } from '../turnTrace'
import { subagentLevels } from '../subagentLevels'
import { chatFallbackTargets, composerShowsRecipients, roomAgents } from '../mentions'
import {
  canUnsettle,
  withSessionTitle,
  isProjectThread,
  sitsSettled,
  openThreadQuestion,
  openSubagentQuestion,
  subagentSummaryOf,
  changeableAnswers,
  type ChangeableAnswer,
  projectWorkHandoffs,
  projectThreadFeed,
  threadQuestionAdvice,
  sessionLiveOf,
  sessionThreadOf,
  sessionReadyRow,
  repoListingKey,
  roomOf,
  rowsOf,
  runtimeStartedAgentIds,
  threadOf,
  type QuietWorkspace,
  type ThreadShape,
  type ThreadState,
} from '../state'
import type { ConnectionStatus } from '../useWorkspace'
import { isAutoOn, withAuto } from '../runtimeChoices'
import { AskDock } from './AskCard'
import { Composer } from './Composer'
import { SubagentView } from './SubagentView'
import { SubagentDirectory } from '../subagentContext'
import { Icon } from './Icon'
import { IconButton } from './ui/IconButton'
import { OutboundDraftDock } from './OutboundDraftDock'
import type { DraftActions } from './OutboundDraftBubble'
import { OutboundDockProvider } from './outboundDockState'
import { RepoFileLinkProvider } from './RepoFileLink'
import { ComposerAutoRow } from './NewChatModeControl'
import { RuntimeControls } from './RuntimeControls'
import { chatRoster } from '../chatRoster'
import type { RequestEvents } from '../useRequest'
import type { WorkResultActions } from './WorkResultBody'
import { SingleRuntimeControl, defaultSingleRuntime } from './SingleRuntimeControl'
import { LiveTranscript, type TranscriptReveal } from './Transcript'
import { WorkDecisionDock, type SessionReadiness } from './WorkDecisionDock'
import { RightRail, type RailItem } from './RightRail'
import type { PanelLayout, RightPanelId } from '../useRightPanel'
import { WorkspaceHeader } from './WorkspaceHeader'
import { useHostAuto } from '../useHostAuto'

const NO_AGENTS: AgentConfig[] = []
const NO_IDS: string[] = []
/** What covers a chat's own transcript and composer while a subagent lies over them. */
const COVERED = { inert: '' } as const
const NO_OVERRIDE: ChatOverride = {}

/**
 * The composer height last measured in any pane. A newly opened chat starts its padding
 * from it: the transcript pins to the bottom before this pane's own composer is measured,
 * and a padding that grows afterwards would leave the newest message under the composer.
 */
let lastComposerDock = 0

export interface ChatPaneSend {
  (
    text: string,
    attachments: ComposerAttachments,
    pageContexts: PageContextAttachment[],
    replyTo?: MessageReply,
    quotes?: InlineQuote[],
  ): boolean
}

interface ChatPaneProps {
  chat: Chat
  workspace: QuietWorkspace
  status: ConnectionStatus
  phone: boolean
  focused: boolean
  split: boolean
  /** Left pane keeps the sidebar toggle when the panel is away. */
  side: 'left' | 'right'
  sidebarCollapsed: boolean
  /** Absent where the destination has no sidebar to show. */
  onToggleSidebar?: () => void
  onClose?: () => void
  onFocus: () => void
  onEditProject?: () => void
  onEditPersona?: (agentId: string) => void
  onAcceptWork: (handoffId: string, options: WorkAcceptanceOptions) => Promise<unknown> | void
  onRejectWork: (handoffId: string) => boolean
  onConfirmGoal: (handoffId: string, mergeInto?: string, version?: number, requestId?: string) => boolean
  onReviseGoal: (handoffId: string, version: number, text: string, requestId?: string) => boolean
  onRetryCompletion: (handoffId: string, requestId?: string) => boolean
  onApproveMergeFix: (handoffId: string, tip: string, requestId?: string) => boolean
  /** Opens a Session with its diff beside it: a ready card's file count, a Session's own Ready row. */
  onOpenDiff?: (chatId: string) => void
  /** Reads a Session's Changes, which says what Confirm would leave out of its Ready result. */
  askSessionRepo?: (chatId: string) => void
  requestEvents: RequestEvents
  onOpenAgentRelay: (chatId: string) => void
  /** Opens a Session at its lead's report, from a result card in this chat. */
  onOpenReport?: (chatId: string) => void
  /** Opens a chat on the stage: a session's project thread, from its waiting line. */
  onOpenProjectThread?: (chatId: string) => void
  onOpenFile?: (path: string) => void
  /** This chat's subagent views, stacked over its transcript. */
  subagentStage?: SubagentStage
  onAddToSideChat?: (quote: MessageQuote) => void
  onOpenRoutines?: () => void
  onGoBack?: () => void
  /** The crumb before the title that leads back: a session beside its project thread returns to the overview. */
  parent?: { label: string; onClick: () => void; back?: boolean }
  /** A session its project thread started: it stands in its room, so the header names no project. */
  inRoom?: boolean
  sendToChat: (
    chatId: string,
    text: string,
    attachments: ComposerAttachments,
    pageContexts?: PageContextAttachment[],
    replyTo?: MessageReply,
    quotes?: InlineQuote[],
  ) => boolean
  stopTurn: (turnId: string) => void
  /** The chat-wide Stop while it only waits on background work its turns started. */
  stopBackground?: (chatId: string) => void
  answerUserInput: (chatId: string, requestId: string, answers: UserInputAnswers) => boolean
  answerSecretRequest: (chatId: string, requestId: string, value?: string) => boolean
  changeSessionAnswer?: (threadChatId: string, requestId: string, answers: UserInputAnswers) => boolean
  setChatOverride: (agentId: string, override: ChatOverride, chatId?: string) => boolean
  setChatCheckout: (chatId: string, checkout: CheckoutRequest) => boolean
  askCheckoutStatus: (chatId: string) => boolean
  listRepoFiles: (projectId: string, chatId?: string) => void
  setChatSettled: (chatId: string, settled: boolean) => boolean
  pageContexts: PageContextAttachment[]
  onRemovePageContext: (contextId: string) => void
  reply?: MessageReply
  onRemoveReply?: () => void
  onReply?: (reply: MessageReply) => void
  onQuote?: (quote: MessageQuote) => void
  outboundActions: DraftActions
  trailing?: ReactNode
  /** The header's last control, after a hairline: a project thread's Sessions toggle. */
  endControl?: ReactNode
  panel?: ReactNode
  birthPending?: ComposerAttachments & { text: string; pageContexts: PageContextAttachment[]; quotes?: InlineQuote[] }
  /** The panel doors in this pane's header, one set per thread. */
  rail?: {
    items: RailItem[]
    layout: PanelLayout
    onSelect: (id: RightPanelId) => void
  }
  /** ⌘. reading mode, see `Composer`'s `focusMode`. */
  focusMode?: boolean
  /** A message to scroll to and flash, see `Transcript`'s `revealEvent`. */
  revealEvent?: TranscriptReveal | null
  onEventRevealed?: (id: number) => void
}

function blockedNote(status: string, hasSnapshot: boolean, title: string | undefined) {
  if (status !== 'live') return 'Disconnected, sending is paused'
  if (!hasSnapshot) return title === undefined ? 'Opening a chat…' : `Opening ${title}…`
  return ''
}

/**
 * One work thread's header, transcript and composer. Split puts two of these
 * beside each other; drafts and sends stay keyed to this chat.
 */
const NO_CHANGEABLE: ReadonlyMap<string, ChangeableAnswer> = new Map()

export type SubagentStage = {
  /** Open views from the chat outwards, by launch call id. */
  path: readonly string[]
  open: (toolCallId: string) => void
  back: () => void
  load: (childId: string) => void
  stop: (chatId: string, toolCallId: string) => boolean
}

export function ChatPane({
  chat,
  workspace,
  status,
  phone,
  focused,
  split,
  side,
  sidebarCollapsed,
  onToggleSidebar,
  onClose,
  onFocus,
  onEditProject,
  onEditPersona,
  onAcceptWork,
  onRejectWork,
  onConfirmGoal,
  onReviseGoal,
  onRetryCompletion,
  onApproveMergeFix,
  onOpenDiff,
  askSessionRepo,
  requestEvents,
  onOpenAgentRelay,
  onOpenReport,
  onOpenProjectThread,
  onOpenFile,
  subagentStage,
  onAddToSideChat,
  onOpenRoutines,
  onGoBack,
  sendToChat,
  stopTurn,
  stopBackground,
  answerUserInput,
  answerSecretRequest,
  changeSessionAnswer,
  setChatOverride,
  askCheckoutStatus,
  listRepoFiles,
  setChatSettled,
  pageContexts,
  onRemovePageContext,
  reply,
  onRemoveReply,
  onReply,
  onQuote,
  outboundActions,
  trailing,
  endControl,
  parent,
  inRoom = false,
  panel,
  birthPending,
  focusMode = false,
  rail,
  revealEvent,
  onEventRevealed,
}: ChatPaneProps) {
  const hostAuto = useHostAuto()
  // Every hook comes first. A value the compiler sees made before a hook and used after
  // it loses its memo, and the rows below must keep theirs while a reply streams.
  const stageRef = useRef<HTMLDivElement>(null)
  const revealRowRef = useRef<((rowKey: string, focus?: string) => void) | null>(null)
  const revealRow = (rowKey: string, focus?: string) => revealRowRef.current?.(rowKey, focus)
  // The open Session cards the thread shows right now, which the bar leaves out. Null
  // until this chat's transcript has measured, so the bar never flashes rows it will drop.
  const [cardsInView, setCardsInView] = useState<{ chatId: string; keys: ReadonlySet<string> } | null>(null)
  const chatId = chat.id
  const onWorkCardsInView = (keys: ReadonlySet<string>) => setCardsInView({ chatId, keys })
  const workCardsInView = cardsInView?.chatId === chatId ? cardsInView.keys : null
  const footerRef = useRef<HTMLElement>(null)
  const workDockRef = useRef<HTMLDivElement>(null)
  // The thread runs under the composer so the card's frost has something to show.
  // The footer's height goes out as `--composer-dock`, which the transcript pads by;
  // written straight to the style so a growing draft does not re-render the pane.
  const [initialDock] = useState(() => lastComposerDock)
  useLayoutEffect(() => {
    const stage = stageRef.current
    const footer = footerRef.current
    if (stage === null || footer === null) return
    // The Session bar floats above the footer rather than in it, so its rows coming and
    // going never move the thread; it goes out as `--work-dock` for what sits above it.
    const workDock = workDockRef.current
    const write = () => {
      lastComposerDock = footer.offsetHeight
      stage.style.setProperty('--composer-dock', `${footer.offsetHeight}px`)
      stage.style.setProperty('--work-dock', `${workDock?.offsetHeight ?? 0}px`)
    }
    write()
    const observer = new ResizeObserver(write)
    observer.observe(footer)
    if (workDock !== null) observer.observe(workDock)
    return () => observer.disconnect()
  }, [])
  const [changing, setChanging] = useState<string | null>(null)
  // The quiet thread: it holds still while a reply streams, and so does this pane. Only
  // the transcript reads the streamed text, through `liveRows` below.
  const thread = threadOf(workspace, chat.id)
  // What runs in each Session, so its card says what its overview row says.
  const { activity, subagents, backgroundChatIds } = workspace
  const sessionLive = sessionLiveOf({ activity, subagents, backgroundChatIds })
  // A DM's indicator waits on a consulted colleague only while her pair chat still runs.
  const runningChatIds = new Set(Object.entries(activity).filter(([, entry]) => entry.runningTurns.length > 0).map(([id]) => id))
  const projectRows = (source: ThreadShape) => {
    const baseRows = rowsOf(source, chat.kind)
    const rawRows = birthPending !== undefined && baseRows.length === 0
      ? rowsOf({ ...source, pending: [{ key: 'pending:new-chat', ...birthPending }] })
      : baseRows
    return projectWorkHandoffs(rawRows, workspace.workHandoffs, workspace.chats, workspace.projects, workspace.agents, workspace.checkoutStatus, sessionLive, chat.id)
  }
  // Without streamed text: the docks, the question card and Stop read structure only.
  const rows = projectRows(thread)
  // Through a string, so the composer keeps its Stop while the running rows change per token.
  const runningKey = rows.flatMap((row) => row.kind === 'turn' && row.live?.state === 'running' ? [row.turnId] : []).join('\0')
  const runningTurnIds = runningKey === '' ? NO_IDS : runningKey.split('\0')
  // A Session has no card of its own result, so its Ready row comes from the handoff.
  const sessionReady = sessionReadyRow(chat, workspace.workHandoffs, workspace.chats, workspace.projects, workspace.agents, workspace.checkoutStatus, sessionLive)
  // A project thread (2026-10-10) holds its sessions' questions; a session it started
  // confirms there and asks there. Its sessions themselves stand in the room's overview.
  const projectThread = isProjectThread(workspace, chat.id)
  // The thread bundles what needs nothing from the user; the docks and the question card read the full rows.
  const liveRows = (live: ThreadState) => {
    const projected = projectRows(live)
    return projectThread ? projectThreadFeed(projected) : projected
  }
  // The id alone, which keeps its identity while the whole workspace moves under it.
  const startedByThreadId = sessionThreadOf(workspace, chat.id)?.threadChatId
  // Only a Session its project thread started reads and writes at the side chat's
  // density (Single or Multiple). A standalone Session, a DM and the thread keep the
  // conversation size, and the phone keeps its touch sizes.
  const sessionDensity = !phone && startedByThreadId !== undefined
  const threadQuestion = projectThread ? openThreadQuestion(workspace, chat.id) : null
  const threadAdvice = projectThread ? threadQuestionAdvice(rows) : undefined
  // An answer the thread gave from a preference, which the user may replace from its line.
  const changeable = projectThread && changeSessionAnswer !== undefined ? changeableAnswers(thread.events) : NO_CHANGEABLE
  const changingAnswer = changing === null ? undefined : changeable.get(changing)
  const answerChange = changeable.size === 0 ? undefined : { ids: new Set(changeable.keys()), onChange: setChanging }
  const openStartedBy = startedByThreadId === undefined || onOpenProjectThread === undefined
    ? undefined
    : () => onOpenProjectThread(startedByThreadId)
  // A Session's bar carries its result's own two actions, wherever the card sits (2026-10-14).
  const dockRows = sessionReady === undefined ? rows : [sessionReady]
  const { sessionRepos, chats } = workspace
  const readiness: SessionReadiness | undefined = askSessionRepo === undefined ? undefined : {
    excluded: (sessionId) => sessionRepos[sessionId]?.excluded,
    ask: askSessionRepo,
    updatedAt: (sessionId) => chats.find((candidate) => candidate.id === sessionId)?.lastMessageAt,
  }
  // In a Session its own row opens the diff, where Request changes and Confirm also live.
  const revealDecision = (rowKey: string, focus?: string) => {
    if (sessionReady !== undefined && rowKey === sessionReady.key) onOpenDiff?.(chatId)
    else revealRow(rowKey, focus)
  }
  // Children outlive the turn that started them, so a chat can wait with no turn running.
  const waiting = runningTurnIds.length === 0 && chatWaitsOnBackground(rows)
  const stopAll = () => {
    for (const turnId of runningTurnIds) stopTurn(turnId)
    // A turn's Stop already ends the chat's background work on the server.
    if (runningTurnIds.length === 0 && waiting) stopBackground?.(chat.id)
  }

  const project = roomOf(workspace, chat.projectId)
  // Next to `project`: a method call on it further down would hold the whole body in one cache block.
  const repoKey = `${project?.repoPaths.join('\0') ?? ''}\0${chat.checkout.mode}\0${chat.checkout.branch}`
  const singleChat = chat.mode === 'single'
  // The word for this room in its own notes: a Session is a piece of work, the thread is the project's standing chat.
  const chatNoun = projectThread ? 'project thread' : chat.kind === 'project' ? 'Session' : 'chat'
  const singleDefault = defaultSingleRuntime(workspace.agents)
  const openSingleOverride = thread.overrides[SINGLE_CHAT_VOICE.id] ?? NO_OVERRIDE
  // Changes only with a new server reading, never with the text streaming beside it.
  const liveContext = liveSessionContext(thread.liveTurns)
  // Single Work's meter only: the project thread rolls over like a DM and, like a DM, has no ring.
  const contextMeter = singleChat && !projectThread ? singleWorkContext(thread.events, openSingleOverride, workspace.agents, liveContext) : undefined
  const dmAgent = chat.kind === 'dm' ? workspace.agents.find((agent) => agent.id === chat.memberIds[0]) : undefined
  // A Session persona's old DM stays readable; it no longer takes messages.
  const sessionDm = dmAgent?.placement === 'session'
  // A DM fills the user's bubbles with her face's colour and a project thread with the
  // project's icon colour; every other room, its Sessions included, keeps the plain cloud.
  const projectColor = projectThread ? project?.color : undefined
  const userBubbleTint = dmAgent !== undefined ? avatarBubbleTint(dmAgent) : projectColor === undefined ? undefined : projectBubbleTint({ color: projectColor })
  const pairAgents = chat.kind === 'pair'
    ? chat.memberIds.flatMap((id) => {
        const agent = workspace.agents.find((candidate) => candidate.id === id)
        return agent === undefined ? [] : [agent]
      })
    : []
  const pairTitle = pairAgents.map((agent) => agent.name).join(' ⇄ ')
  // Through a string, so the list keeps its identity while the live turn grows token
  // by token and the runtime pickers that take it are left alone.
  const started = runtimeStartedAgentIds(thread)
  const startedKey = started.join('\0')
  const startedAgentIds = startedKey === '' ? NO_IDS : startedKey.split('\0')
  // No switch on a host without Auto: the picker stays open and names the model.
  const singleCanAuto =
    hostAuto && !started.includes(SINGLE_CHAT_VOICE.id) && openSingleOverride.autoResolved !== true
  const dmOverride = dmAgent === undefined ? undefined : thread.overrides[dmAgent.id] ?? {}
  const dmCanAuto =
    hostAuto &&
    dmAgent !== undefined &&
    dmOverride !== undefined &&
    dmAgent.driver !== 'mock' &&
    !started.includes(dmAgent.id) &&
    dmOverride.autoResolved !== true
  // A Browser session has no rail to hold the Agents roster, so its household's
  // models are picked where the draft house chat picks them, in the composer.
  const browserHouse = chat.kind === 'browser' && !singleChat
  const houseAgents = browserHouse ? chatRoster(workspace.agents, chat, []) : NO_AGENTS
  // Mentions offer only who can sit in this room: Session personas in a Session.
  const composerAgents = singleChat ? NO_AGENTS : roomAgents(workspace.agents, chat)
  const resultActions: WorkResultActions = {
    requestEvents,
    connected: status === 'live',
    accept: (handoffId, mergeInto, version, requestId) => onConfirmGoal(handoffId, mergeInto, version, requestId),
    revise: onReviseGoal,
    retry: onRetryCompletion,
    approveFix: onApproveMergeFix,
    askCheckout: (chatId) => { askCheckoutStatus(chatId) },
  }
  const sessionLeadId = workspace.workHandoffs.find((handoff) => handoff.workChatId === chat.id)?.leadAgentId
  const composerFallback = chat.kind === 'dm'
    ? (dmAgent !== undefined ? [dmAgent] : NO_AGENTS)
    : chatFallbackTargets(chat, thread.events, workspace.agents, sessionLeadId)

  const composerFilesKey = project === undefined ? undefined : repoListingKey(project.id, chat.id)
  const composerFiles = composerFilesKey === undefined ? undefined : workspace.repoFiles[composerFilesKey]

  const canBrowseFiles = project !== undefined && (project.repoPaths.length ?? 0) > 0 && status === 'live'
  const opening = !thread.hasSnapshot

  const send: ChatPaneSend = (text, attachments, pageContexts, replyTo, quotes) =>
    sendToChat(chat.id, text, attachments, pageContexts, replyTo, quotes)

  // A subagent lies over the chat that started it, which stays mounted underneath: the
  // scroll position, the fold of each turn and an unsent draft all survive the visit.
  const subagentSummary = (childId: string) => subagentSummaryOf(workspace, childId)
  // The memoised transcript rows read the directory from context, so a settled turn
  // learns its helper ended without every row re-rendering on each streamed token.
  const listedSubagents = workspace.subagents
  const directory = (childId: string) => listedSubagents.find((child) => child.id === childId)
  const helpersOf = (childId: string) => chatSubagents(rowsOf(threadOf(workspace, childId)))
  const levels = subagentLevels(chat.id, chatSubagents(rows), subagentStage?.path ?? NO_IDS, helpersOf)
  const level = levels.at(-1)
  const covered = level !== undefined
  const coveredAttrs = covered ? COVERED : undefined
  const sessionTitle = chat.kind === 'pair' ? pairTitle : withSessionTitle(chat).title
  const parentTitle = levels.length > 1 ? subagentTask(levels.at(-2)!.subagent.step) : (dmAgent?.name ?? sessionTitle)
  const footerPadding = phone ? 'px-3 pb-[max(12px,env(safe-area-inset-bottom))]' : split ? 'px-3 pb-3' : 'px-5 pb-3'

  const doors = rail === undefined || rail.items.length === 0 ? null : (
    <RightRail items={rail.items} layout={rail.layout} onSelect={rail.onSelect} />
  )
  const closeControl = onClose === undefined ? null : (
    <IconButton icon={Cancel01Icon} label="Close pane" onClick={onClose} />
  )

  const projectId = project?.id
  // Last, after everything it could cost a memo (see the top of this component).
  useEffect(() => {
    if (projectId === undefined || status !== 'live') return
    listRepoFiles(projectId, chatId)
  }, [projectId, chatId, repoKey, status, listRepoFiles])

  // The runtime row under the box, and the box itself, outside the footer's ternary: there
  // they would share one cache block with the ask dock, which takes the rows a token changes.
  const composerControls = singleChat ? (
    <ComposerAutoRow
      {...(singleCanAuto
        ? {
            auto: {
              checked: isAutoOn(openSingleOverride, hostAuto),
              disabled: status !== 'live',
              onChange: (checked: boolean) =>
                setChatOverride(
                  SINGLE_CHAT_VOICE.id,
                  checked ? withAuto(openSingleOverride, true) : singleDefault,
                  chat.id,
                ),
            },
          }
        : {})}
      pickerOpen={!singleCanAuto || !isAutoOn(openSingleOverride, hostAuto)}
      pickerCollapsible={singleCanAuto}
      picker={
        <SingleRuntimeControl
          override={openSingleOverride}
          fallback={singleDefault}
          allowAuto={false}
          disabled={status !== 'live'}
          onChange={(override) => setChatOverride(SINGLE_CHAT_VOICE.id, override, chat.id)}
        />
      }
    />
  ) : dmAgent !== undefined ? (
    <ComposerAutoRow
      {...(dmCanAuto && dmOverride !== undefined
        ? {
            auto: {
              checked: isAutoOn(dmOverride, hostAuto),
              disabled: status !== 'live',
              onChange: (checked: boolean) =>
                setChatOverride(dmAgent.id, withAuto(dmOverride, checked), chat.id),
            },
          }
        : {})}
      pickerOpen={!dmCanAuto || dmOverride === undefined || !isAutoOn(dmOverride, hostAuto)}
      pickerCollapsible={dmCanAuto}
      picker={
        <RuntimeControls
          agents={[dmAgent]}
          overrides={thread.overrides}
          disabled={status !== 'live'}
          startedAgentIds={startedAgentIds}
          allowAuto={false}
          directLayout="split"
          onChange={(agentId, override) => setChatOverride(agentId, override, chat.id)}
        />
      }
    />
  ) : browserHouse ? (
    <ComposerAutoRow
      pickerOpen
      pickerCollapsible={false}
      picker={
        <RuntimeControls
          agents={houseAgents}
          overrides={thread.overrides}
          disabled={status !== 'live'}
          startedAgentIds={startedAgentIds}
          onChange={(agentId, override) => setChatOverride(agentId, override, chat.id)}
        />
      }
    />
  ) : undefined
  const composer = (
    <Composer
      agents={composerAgents}
      commandContext={() => chatCommandContext(chat, project, thread.events, workspace.workHandoffs,
        runningTurnIds.length > 0 || sessionLive(chat.id).running || waiting || thread.pending.length > 0)}
      household={workspace.agents}
      allowAgentMentions={!singleChat && chat.kind !== 'dm'}
      allowWorkDestination={!singleChat && (chat.kind === 'dm' || chat.kind === 'browser')}
      allSkillsAvailable={singleChat}
      showRecipients={!singleChat && composerShowsRecipients(chat.kind, thread.events, thread.pending.length)}
      {...(chat.kind === 'group' ? { memberIds: chat.memberIds } : {})}
      recipientsUnknown={runningTurnIds.length > 0 || thread.pending.length > 0}
      placeholder={projectThread ? 'Reply…' : 'Ask anything…'}
      touchMode={phone}
      compact={sessionDensity}
      {...(phone ? {} : { heights: 'session' as const })}
      overrides={thread.overrides}
      files={composerFiles?.files}
      filesTruncated={composerFiles?.truncated}
      skills={workspace.skills}
      {...(!singleChat && composerFallback !== undefined ? { fallbackTargets: composerFallback } : {})}
      draftKey={chat.id}
      onSend={send}
      pageContexts={pageContexts}
      {...(reply === undefined || onRemoveReply === undefined ? {} : { replyTo: reply, onRemoveReply })}
      onRemovePageContext={onRemovePageContext}
      canSend={status === 'live' && thread.hasSnapshot}
      blockedNote={blockedNote(status, thread.hasSnapshot, opening ? chat.title : undefined)}
      running={runningTurnIds.length > 0 || (waiting && stopBackground !== undefined)}
      onStop={stopAll}
      autoFocus={focused && !split && !focusMode}
      {...(contextMeter === undefined ? {} : { contextMeter })}
      {...(composerControls === undefined ? {} : { controls: composerControls })}
      // Only the pane on screen: a split shows the focused one alone.
      focusMode={focusMode && focused}
    />
  )

  return (
    <SubagentDirectory.Provider value={directory}>
    <OutboundDockProvider rows={rows} enabled={chat.kind !== 'pair'}>
      <RepoFileLinkProvider
        {...(canBrowseFiles && composerFiles !== undefined ? { files: composerFiles.files } : {})}
        open={onOpenFile ?? (() => {})}
      >
      <div
        className="grid h-full min-h-0 min-w-0 grid-cols-[minmax(0,1fr)_auto]"
        onPointerDown={onFocus}
        onFocusCapture={onFocus}
        data-focused={focused ? 'true' : 'false'}
      >
      <div className={`relative isolate grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)_auto] ${split ? 'overflow-clip' : ''}`}>
      <div
        ref={stageRef}
        className="relative grid h-full min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_auto] bg-bg"
        style={{ '--composer-dock': `${initialDock}px` } as CSSProperties}
      >
        <WorkspaceHeader
          title={level === undefined ? sessionTitle : subagentTask(level.subagent.step)}
          persona={covered ? undefined : dmAgent}
          {...(pairAgents.length === 0 || covered ? {} : { pairPersonas: pairAgents })}
          project={covered || inRoom || (singleChat && chat.routineId != null) ? undefined : project}
          {...(covered && subagentStage !== undefined
            ? { parent: { label: parentTitle, onClick: subagentStage.back, shrinks: true } }
            : singleChat && chat.routineId != null && onOpenRoutines !== undefined
              ? { section: 'routines' as const, parent: { label: 'Scheduled tasks', onClick: onOpenRoutines } }
              : parent === undefined ? {} : { parent })}
          projectThread={projectThread && !covered}
          status={status}
          overlay
          sidebarCollapsed={side === 'left' ? sidebarCollapsed : false}
          phoneBack={side === 'left' && phone}
          {...(onToggleSidebar === undefined ? {} : { onToggleSidebar })}
          trailing={
            closeControl === null && trailing === undefined && doors === null && endControl === undefined ? undefined : (
              <span className="pointer-events-auto flex items-center gap-0.5">
                {trailing}
                {doors}
                {closeControl}
                {endControl === undefined ? null : (
                  <>
                    {closeControl === null && trailing === undefined && doors === null ? null : (
                      <span aria-hidden="true" className="mx-1.5 h-4 w-px flex-none bg-line" />
                    )}
                    {endControl}
                  </>
                )}
              </span>
            )
          }
          {...(onEditProject === undefined || project === undefined ? {} : { onEditProject })}
          {...(dmAgent === undefined || onEditPersona === undefined
            ? {}
            : { onEditPersona: () => onEditPersona(dmAgent.id) })}
        />

        {!covered && sitsSettled(workspace, chat) && canUnsettle(workspace, chat) ? (
          // Under the pane's top edge; the phone's header still floats above it there.
          <div className="pointer-events-none absolute inset-x-0 top-3 z-[5] flex justify-center px-5 [@media(max-width:600px)]:top-[54px]">
            <div className="pointer-events-auto flex items-center gap-2.5 rounded-lg border border-line bg-surface-2 py-1 pr-1 pl-3 text-[12px] text-muted shadow-pill">
              <span>This {chatNoun} is settled</span>
              <button
                type="button"
                className="cursor-pointer rounded-button-sm border-0 bg-transparent px-2 py-px text-[12px] text-text [font:inherit] hover:bg-user-bg"
                onClick={() => setChatSettled(chat.id, false)}
              >
                Unsettle
              </button>
            </div>
          </div>
        ) : null}

        {split && !focused ? <div aria-hidden="true" className="split-focus-overlay" /> : null}
        <main className={`col-start-1 row-span-2 row-start-1 flex min-h-0 min-w-0 justify-center bg-bg ${covered ? 'invisible' : ''}`} {...coveredAttrs}>
          <LiveTranscript
            key={chat.id}
            chatId={chat.id}
            liveRows={liveRows}
            agents={singleChat ? NO_AGENTS : workspace.agents}
            identityAgents={workspace.agents}
            skills={workspace.skills}
            hasSnapshot={thread.hasSnapshot}
            denseText={sessionDensity}
            showSpeakers={!singleChat}
            quoteAuthors={quoteNamesAuthor(chat, projectThread)}
            {...(projectThread && project !== undefined ? { threadProject: project } : {})}
            pinPlan={chat.kind === 'project' && !projectThread}
            emptyNote={`Empty ${chatNoun}.${isSoloRoom(chat) ? '' : ' Mention an agent with @ to start.'}`}
            onAcceptWork={onAcceptWork}
            onRejectWork={onRejectWork}
            {...(onOpenDiff === undefined ? {} : { onOpenDiff })}
            resultActions={resultActions}
            onOpenAgentRelay={onOpenAgentRelay}
            {...(onOpenReport === undefined ? {} : { onOpenReport })}
            {...(project === undefined || project.name === '' ? {} : { forwardSource: project.name })}
            showDates={chat.kind === 'pair'}
            bubbleReplies={chat.kind === 'dm'}
            {...(dmAgent === undefined ? {} : { dmAgentId: dmAgent.id, runningChatIds })}
            {...(userBubbleTint === undefined ? {} : { userBubbleTint })}
            {...(onReply === undefined || (chat.kind !== 'dm' && chat.kind !== 'group') ? {} : { onReply })}
            {...(onQuote === undefined || chat.kind === 'pair' ? {} : { onQuote })}
            {...(onAddToSideChat === undefined || chat.kind === 'pair' ? {} : { onAddToSideChat })}
            {...(canBrowseFiles && composerFiles !== undefined ? { repoFiles: composerFiles.files, onOpenFile } : {})}
            {...(subagentStage === undefined ? {} : { onOpenSubagents: subagentStage.open })}
            held={levels.length > 0}
            connected={status === 'live'}
            draftActions={outboundActions}
            revealRef={revealRowRef}
            {...(revealEvent === undefined ? {} : { revealEvent })}
            {...(onEventRevealed === undefined ? {} : { onEventRevealed })}
            {...(answerChange === undefined ? {} : { answerChange })}
            onWorkCardsInView={onWorkCardsInView}
          />
        </main>

        <footer ref={footerRef} className={`pointer-events-none relative col-start-1 row-start-2 z-[4] flex min-w-0 flex-col items-center bg-transparent ${footerPadding} ${covered ? 'invisible' : ''}`} {...coveredAttrs}>
          {/* The thread scrolls behind the frosted card; the bottom inset fades to the canvas. */}
          <div aria-hidden="true" data-composer-fade="" className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-16 bg-gradient-to-t from-bg from-50% to-transparent" />
          <div className="pointer-events-auto relative flex min-w-0 w-full flex-col items-center">
            {/* Rendered for every chat, so the footer's observer always has it to measure. */}
            <div ref={workDockRef} className="pointer-events-none absolute inset-x-0 bottom-full flex flex-col items-center">
              {/* Focus mode reads without it (2026-10-09); leaving the mode brings it back. */}
              {chat.kind === 'pair' || sessionDm || focusMode ? null : (
                <WorkDecisionDock
                  rows={dockRows}
                  inView={workCardsInView}
                  agents={workspace.agents}
                  onAcceptProposal={onAcceptWork}
                  onRejectProposal={onRejectWork}
                  resultActions={resultActions}
                  {...(readiness === undefined ? {} : { readiness })}
                  onReveal={revealDecision}
                />
              )}
            </div>
            {chat.kind === 'pair' || sessionDm ? (
              <div className="flex items-center gap-2.5 rounded-lg border border-line bg-surface-2 py-1 pr-1 pl-3 text-[12px] text-muted shadow-pill">
                <Icon icon={LockIcon} size={14} />
                <span>{sessionDm ? `${dmAgent?.name ?? chat.title} works in Sessions now` : 'This chat is view-only'}</span>
                {runningTurnIds.length === 0 ? null : (
                  <button
                    type="button"
                    className="cursor-pointer rounded-button-sm border-0 bg-raised px-2.5 py-1 text-[12px] text-danger [font:inherit] hover:bg-user-bg"
                    onClick={stopAll}
                  >
                    Stop
                  </button>
                )}
                {onGoBack === undefined ? null : (
                  <button
                    type="button"
                    className="cursor-pointer rounded-button-sm border-0 bg-raised px-2.5 py-1 text-[12px] text-text [font:inherit] hover:bg-user-bg"
                    onClick={onGoBack}
                  >
                    Close Chat
                  </button>
                )}
              </div>
            ) : (
              <>
                <OutboundDraftDock rows={rows} agents={workspace.agents} connected={status === 'live'} actions={outboundActions} />
                <AskDock
                  rows={rows}
                  agents={workspace.agents}
                  connected={status === 'live'}
                  chatId={chat.id}
                  onAnswer={(requestId, answers) => answerUserInput(chat.id, requestId, answers)}
                  onAnswerSecret={answerSecretRequest}
                  threadQuestion={threadQuestion}
                  subagentQuestion={openSubagentQuestion(workspace, chat.id)}
                  {...(threadAdvice === undefined ? {} : { threadAdvice })}
                  {...(projectThread && project !== undefined ? { projectName: project.name } : {})}
                  onAnswerThread={answerUserInput}
                  {...(openStartedBy === undefined ? {} : { routedToThread: { onOpen: openStartedBy } })}
                  changeAnswer={changing === null || changingAnswer === undefined || changeSessionAnswer === undefined ? null : {
                    noteId: changing,
                    answer: changingAnswer,
                    // The card leaves once the thread records the change; a refusal comes back as a notice.
                    onSubmit: (answers) => changeSessionAnswer(chat.id, changingAnswer.requestId, answers),
                    onCancel: () => setChanging(null),
                  }}
                />
                {composer}
              </>
            )}
          </div>
        </footer>
        {subagentStage === undefined ? null : levels.map((open, index) => {
          const childId = open.subagent.step.subagent?.childChatId
          return (
            <SubagentView
              key={open.subagent.step.key}
              subagent={open.subagent}
              state={subagentStateOf(open.subagent, subagentSummary)}
              summary={childId === undefined ? undefined : subagentSummary(childId)}
              agents={workspace.agents}
              starter={singleChat ? undefined : workspace.agents.find((agent) => agent.id === open.subagent.agentId)}
              connected={status === 'live'}
              denseText={sessionDensity}
              footerPadding={footerPadding}
              covered={index < levels.length - 1}
              load={subagentStage.load}
              onOpenChild={subagentStage.open}
              onOpenParent={subagentStage.back}
            />
          )
        })}
      </div>
      {panel}
      </div>
      </div>
      </RepoFileLinkProvider>
    </OutboundDockProvider>
    </SubagentDirectory.Provider>
  )
}
