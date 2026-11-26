import { createWorkAcceptance, createWorkspaceCommands, type WorkAcceptanceOptions } from '@manor/client-runtime/commands'
import {
  type AgentConfig,
  type SlackRichText,
  type ChatOverride,
  type ClientMessage,
  type ImageAttachment,
  type InlineQuote,
  type MessageReply,
  type Project,
  type ProjectRepoIcon,
  type SearchMessageHit,
  type SearchNoteHit,
  type ServerMessage,
  type UserInputAnswers,
} from '@manor/contracts'
import { splitStagedFiles, type StagedFile } from '@manor/client-runtime/attachments'
import { createChatMessage, type NewChatTarget } from '@manor/client-runtime/commands'
import {
  createWorkspaceConnection,
  openChatRequest,
  type ConnectionStatus,
  type SocketAdapter,
  type WorkspaceConnection,
} from '@manor/client-runtime/connection'
import { createFrameQueue, type FrameQueue } from '@manor/client-runtime/frame-queue'
import { eventNotices, noticeRoute, unsentPings, type AppNotice } from '@manor/client-runtime/notices'
import { forgetClosedWorkChanges } from '@manor/client-runtime/work-changes'
import {
  askMyMindObjects,
  activityOf,
  chatIsViewed,
  chatOf,
  clearArtifactRequest,
  clearNotice,
  clearRunningTurns,
  createWorkspaceStore,
  emptyWorkspace,
  forgetDirs,
  leaveChat as leaveChatSelection,
  liveThreadOf,
  reduce,
  selectChat,
  sendingUserMessage,
  shouldSettleOpenRun,
  settleChatOverride,
  WORK_RESULT_CONNECTION_LOST,
  type LiveWorkspace,
  type QuietWorkspace,
  type ThreadState,
  type WorkspaceState,
} from '@manor/client-runtime/state'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import { AppState } from 'react-native'
import { noticeStore } from '@/lib/notices'

import { checkDevice } from '@manor/client-runtime/pairing'
import { webSocketUrlFor } from '@manor/contracts'
import {
  onPushTokenChanged,
  registerForPushNotifications,
  unregisterForPushNotifications,
} from '@/lib/notifications'
import { watchForeground } from './appLifecycle'
import { useConnection } from './ConnectionProvider'

const BACKGROUND_RECONNECT_AFTER_MS = 10_000
const PUSH_ACK_WAIT_MS = 2_000
const PUSH_RETRY_DELAYS_MS = [2_000, 10_000, 30_000] as const

/** What opens a chat: the first message, with whatever is attached to it. */
export interface Opening {
  text: string
  images: ImageAttachment[]
  /** Text files and PDF or Word originals together, split into their wire fields on send. */
  files?: StagedFile[]
}

/**
 * The quiet workspace: it keeps its identity while a reply streams and moves on every
 * other change. It holds no streamed text, so a view that draws a reply reads its
 * thread through `useLiveThread`.
 */
export interface WorkspaceData {
  workspace: QuietWorkspace
  createdChat: { chatId: string; requestId?: string } | null
  createdProject: { projectId: string; requestId?: string } | null
}

/**
 * Stable for the provider's lifetime: every command reads live state through refs,
 * so a component that only acts never re-renders on streaming.
 */
/** The Mac's answer to one search, chat titles excluded: the phone matches those itself. */
export interface SearchAnswer {
  messages: SearchMessageHit[]
  notes: SearchNoteHit[]
}

export interface WorkspaceActions {
  clearCreatedChat: () => void
  clearCreatedProject: () => void
  askCheckoutStatus: (chatId: string) => boolean
  askProjectCheckout: (projectId: string) => boolean
  openChat: (chatId: string) => boolean
  /** The chat's screen lost focus; drops the selection while it is still this chat. */
  leaveChat: (chatId: string) => void
  /**
   * Asks for a subagent's own thread to read in its screen. It is held for the chat that
   * started it and never becomes the open chat, so the screen below keeps its place.
   */
  openSubagentThread: (childId: string, parentId: string) => boolean
  /** Settles a chat or picks it back up; the row moves before the server answers. */
  setChatSettled: (chatId: string, settled: boolean) => boolean
  /** Accepts Work and resolves after the server confirms preparation and kickoff. */
  acceptWorkHandoff: (handoffId: string, options: WorkAcceptanceOptions) => Promise<string>
  rejectWorkHandoff: (handoffId: string) => boolean
  /** The user agrees a goal Session's lead reached the goal. */
  confirmWorkGoal: (handoffId: string, mergeInto?: string, version?: number) => boolean
  /** Accepts a reported result; resolves on the server's ack and rejects with its notice. */
  acceptWorkResult: (handoffId: string, mergeInto: string | undefined, version: number) => Promise<void>
  /** Sends feedback on a reported result, with any pasted pictures, back to the same Session. */
  reviseWorkResult: (handoffId: string, version: number, text: string, images: ImageAttachment[]) => Promise<void>
  /** Runs a blocked commit or merge again under the same Confirm; resolves on the server's ack. */
  retryWorkResult: (handoffId: string) => Promise<void>
  /** The user approves the conflict fix Manor holds before it merges a confirmed Session. */
  approveMergeFix: (handoffId: string, tip: string) => Promise<void>
  sendMessage: (chatId: string, text: string, images?: ImageAttachment[], staged?: StagedFile[], replyTo?: MessageReply, quotes?: InlineQuote[]) => boolean
  stopTurn: (turnId: string) => void
  /** Stops the background work a chat waits on after its turns ended, and any pending wake. */
  stopBackground: (chatId: string) => void
  stopSubagent: (chatId: string, toolCallId: string) => boolean
  answerUserInput: (chatId: string, requestId: string, answers: UserInputAnswers) => boolean
  answerSecretRequest: (chatId: string, requestId: string, value?: string) => boolean
  /** Replaces an answer the project thread gave a Session from a preference; his message reaches the Session. */
  changeSessionAnswer: (threadChatId: string, requestId: string, answers: UserInputAnswers) => boolean
  submitOutboundDraft: (chatId: string, draftId: string, body: string, subject?: string, slackRichText?: SlackRichText, cc?: string) => boolean
  discardOutboundDraft: (chatId: string, draftId: string) => boolean
  snoozeOutboundDraft: (chatId: string, draftId: string, until: number) => boolean
  ignoreOutboundDraft: (chatId: string, draftId: string) => boolean
  restoreOutboundDraft: (chatId: string, draftId: string) => boolean
  readOutboundThread: (chatId: string, draftId: string) => boolean
  createChat: (target: NewChatTarget, opening: Opening, overrides: Record<string, ChatOverride>, requestId: string) => boolean
  /** A folder to start Sessions in, without a project thread; answered through `createdProject`. */
  addFolder: (repoPath: string, requestId: string) => boolean
  /** Takes a folder off the new-Session list. Its Sessions keep it. */
  removeFolder: (projectId: string) => Promise<void>
  /** Undo on one line a memory tool wrote; rejects with the server's reason when that line changed since. */
  undoMemoryWrite: (chatId: string, writeId: string) => Promise<void>
  /** Sets or, with `null`, takes off the user's reaction on an agent's message in a DM. */
  setReaction: (chatId: string, eventId: string, emoji: string | null) => Promise<void>
  /** Saves the project form as a whole, as the Mac's Edit project does; resolves on the ack, rejects with the notice. */
  updateProject: (projectId: string, edit: ProjectEdit) => Promise<void>
  /** Deletes the project with its thread, Sessions and chats. */
  deleteProject: (projectId: string) => Promise<void>
  /** Renames an agent or changes her title, over the roster as it stands; resolves on the ack, rejects with the notice. */
  saveAgent: (agentId: string, edit: Partial<AgentEdit>) => Promise<void>
  /** Pins one persona's runtime for this chat; the label moves before the server answers. */
  setChatOverride: (chatId: string, agentId: string, override: ChatOverride) => boolean
  /** Asks for a project's file listing, through the chat's checkout when there is one. */
  listRepoFiles: (projectId: string, chatId?: string) => boolean
  readRepoFile: (projectId: string, path: string, chatId?: string) => boolean
  /** Asks for one DM's file library; it lands in `workspace.dmFiles[chatId]`, newest first. */
  getDmFiles: (chatId: string) => boolean
  /** Asks which icon a project's folders offer; it lands in `workspace.repoIcons[projectId]`. */
  findRepoIcon: (projectId: string) => boolean
  listDirs: (path?: string) => boolean
  closeDirs: () => void
  /** Starts one routine and returns the id that correlates any refusal. */
  runRoutine: (routineId: string) => string | null
  /** Asks the Mac for the memory folder's suggestion ledger; it lands in `workspace.workflowSuggestions`. */
  listWorkflowSuggestions: () => boolean
  /** Takes this phone's push registration off the Mac, then forgets the Mac. */
  forget: () => Promise<void>
  /** Asks for the vault's note listing; nothing until the Knowledge screen wants it. */
  listVault: () => boolean
  readVaultFile: (path: string) => boolean
  /**
   * Searches message content and note bodies on the Mac. Rejects when the Mac refuses,
   * the request cannot be sent, or the connection drops before the answer.
   */
  search: (query: string) => Promise<SearchAnswer>
  /** Asks mymind for objects matching `query`; the id comes back so a stale answer can be told apart. */
  listArtifacts: (query: string) => string | null
  loadMoreArtifacts: () => boolean
}

/** What the phone's agent overview edits. Everything else about an agent stays on the Mac. */
export type AgentEdit = Pick<AgentConfig, 'name' | 'role'>

/** What the project settings sheet writes: the Mac's Edit project form, field for field. */
// Memory scope is set on the Mac only; leaving it out makes the server keep the stored value.
/**
 * `repoIcon` and `letters` absent keep the stored choice, `repoIcon: null` drops either for
 * the glyph, a reference picks the offer, and `letters` picks the name's letters.
 */
export type ProjectEdit = Pick<Project, 'name' | 'icon' | 'color' | 'repoPaths'> & { repoIcon?: ProjectRepoIcon | null; letters?: true }

type WorkspaceContextValue = WorkspaceData & WorkspaceActions & { status: ConnectionStatus }

const WorkspaceDataContext = createContext<WorkspaceData | null>(null)
const WorkspaceLiveContext = createContext<LiveWorkspace | null>(null)
const WorkspaceStatusContext = createContext<ConnectionStatus | null>(null)
const WorkspaceActionsContext = createContext<WorkspaceActions | null>(null)

const SEARCH_CONNECTION_LOST = 'Not connected. Search again when Manor is back.'
const requestId = (prefix: string) => `mobile-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`

/** Steps a batch through the reducer, collecting what each message announces. */
function foldBatch(current: WorkspaceState, batch: readonly ServerMessage[], found: AppNotice[]): WorkspaceState {
  const now = Date.now()
  let next = current
  for (const message of batch) {
    const before = next
    next = reduce(next, message)
    found.push(...eventNotices(before, next, message, now))
  }
  return next
}

/** Notices already announced, so a message the fold sees twice still notifies once. */
const sentNotices = new Set<string>()

/**
 * In front, the stack shows news about a chat that is not on screen; in the background
 * the server's push carries it, so nothing is shown here.
 */
function showNotices(found: readonly AppNotice[], state: WorkspaceState) {
  const view = { focused: AppState.currentState === 'active', onScreen: (chatId: string) => chatIsViewed(state, chatId) }
  for (const notice of unsentPings(found, sentNotices)) {
    if (noticeRoute(notice, view) === 'app') noticeStore.push(notice)
  }
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const device = useConnection()
  const deviceRef = useRef(device)
  useEffect(() => {
    deviceRef.current = device
  }, [device])

  // Outside React: a text frame changes the store, and only its live readers render.
  const [store] = useState(() => createWorkspaceStore(emptyWorkspace))
  const { update: applyWorkspace } = store
  const workspace = useSyncExternalStore(store.subscribe, store.quiet, store.quiet)
  const [status, setStatus] = useState<ConnectionStatus>('connecting')
  const liveRef = useRef(false)
  const [createdChat, setCreatedChat] = useState<{ chatId: string; requestId?: string } | null>(null)
  const [createdProject, setCreatedProject] = useState<{ projectId: string; requestId?: string } | null>(null)
  const connectionRef = useRef<WorkspaceConnection | null>(null)
  /** Kept while the app is closed or reconnecting; a socket opening re-registers it. */
  const pushTokenRef = useRef<string | null>(null)
  const pushRefreshRef = useRef<() => void>(() => {})
  const signingOutRef = useRef(false)
  const ackWaiters = useRef(new Map<string, () => void>())
  /** Result Accept and Request changes in flight, settled by the ack or notice carrying their id. */
  const resultRequests = useRef(new Map<string, { resolve: () => void; reject: (error: Error) => void }>())
  // An answer lost with the socket never arrives; the reconnect snapshot shows whether it landed.
  /** Searches in flight, settled by `search_results` or a notice carrying their id. */
  const searchRequests = useRef(new Map<string, { resolve: (answer: SearchAnswer) => void; reject: (error: Error) => void }>())
  const dropResultRequests = () => {
    for (const waiting of resultRequests.current.values()) waiting.reject(new Error(WORK_RESULT_CONNECTION_LOST))
    resultRequests.current.clear()
    for (const waiting of searchRequests.current.values()) waiting.reject(new Error(SEARCH_CONNECTION_LOST))
    searchRequests.current.clear()
  }
  const workAcceptance = useRef(createWorkAcceptance())
  /** Override requests still in flight, so an ack or a notice can settle the right chat. */
  const overrideRequests = useRef(new Map<string, string>())
  const connected = device.origin !== null
  /** A new pairing, or none, is a different connection from the one before it. */
  const connectionKey = device.credential?.deviceId ?? 'dev'
  const { ready: deviceReady, origin } = device

  const framesRef = useRef<FrameQueue<ServerMessage> | null>(null)
  if (framesRef.current === null) {
    framesRef.current = createFrameQueue<ServerMessage>(
      (batch) => {
        const found: AppNotice[] = []
        applyWorkspace((current) => foldBatch(current, batch, found))
        showNotices(found, store.get())
      },
      {
        request: (run) => requestAnimationFrame(run),
        cancel: (handle) => cancelAnimationFrame(handle),
      },
      (message) => (message.type === 'turn_state' && message.state !== 'running')
        || (message.type === 'event' && message.event.type === 'user_input_request'),
    )
  }

  // Opening a chat clears what it had standing in the notice stack.
  const { openChatId, viewedChatIds } = workspace
  useEffect(() => {
    noticeStore.clearChats((chatId) => chatIsViewed({ openChatId, viewedChatIds }, chatId))
  }, [openChatId, viewedChatIds])

  const setWorkspace = useCallback((change: (state: WorkspaceState) => WorkspaceState) => {
    framesRef.current?.flush()
    applyWorkspace(change)
  }, [applyWorkspace])

  const send = useCallback((message: ClientMessage) => connectionRef.current?.send(message) === true, [])
  // Built per call: the React Compiler refuses a ref-reading `send` handed to a function during render.
  const commands = useCallback(() => createWorkspaceCommands(send, setWorkspace), [send, setWorkspace])
  // One wire shape for both clients; these only forward.
  const stopTurn = useCallback((turnId: string) => void commands().stopTurn(turnId), [commands])
  const stopBackground = useCallback((chatId: string) => void commands().stopBackground(chatId), [commands])
  const stopSubagent = useCallback((chatId: string, toolCallId: string) => commands().stopSubagent(chatId, toolCallId), [commands])
  const openSubagentThread = useCallback(
    (childId: string, parentId: string) =>
      commands().openSubagentThread(childId, parentId, store.get().threads[childId], connectionRef.current?.holds(childId) === true, connectionRef.current?.syncOf(childId)),
    [commands, store],
  )
  const answerUserInput = useCallback(
    (chatId: string, requestId: string, answers: UserInputAnswers) => commands().answerUserInput(chatId, requestId, answers),
    [commands],
  )
  const answerSecretRequest = useCallback(
    (chatId: string, requestId: string, value?: string) => commands().answerSecretRequest(chatId, requestId, value),
    [commands],
  )
  const changeSessionAnswer = useCallback(
    (threadChatId: string, requestId: string, answers: UserInputAnswers) => commands().changeSessionAnswer(threadChatId, requestId, answers),
    [commands],
  )
  const submitOutboundDraft = useCallback(
    (chatId: string, draftId: string, body: string, subject?: string, slackRichText?: SlackRichText, cc?: string) =>
      commands().submitOutboundDraft(chatId, draftId, body, subject, slackRichText, cc),
    [commands],
  )
  const discardOutboundDraft = useCallback((chatId: string, draftId: string) => commands().discardOutboundDraft(chatId, draftId), [commands])
  const snoozeOutboundDraft = useCallback(
    (chatId: string, draftId: string, until: number) => commands().snoozeOutboundDraft(chatId, draftId, until),
    [commands],
  )
  const ignoreOutboundDraft = useCallback((chatId: string, draftId: string) => commands().ignoreOutboundDraft(chatId, draftId), [commands])
  const restoreOutboundDraft = useCallback((chatId: string, draftId: string) => commands().restoreOutboundDraft(chatId, draftId), [commands])
  const readOutboundThread = useCallback(
    (chatId: string, draftId: string) => commands().readOutboundThread(chatId, draftId, requestId('outbound-thread')),
    [commands],
  )

  useEffect(() => {
    if (!deviceReady || !connected) {
      connectionRef.current?.dispose()
      connectionRef.current = null
      // Forgetting the Mac tears the store down with the connection. The previous
      // connection's cleanup has already flushed the frame queue by the time this
      // body runs, so the reset cannot land underneath queued messages.
      /* eslint-disable react-hooks/set-state-in-effect */
      setWorkspace(() => emptyWorkspace)
      // The old house's notices and what was announced from it go too.
      noticeStore.clear()
      sentNotices.clear()
      setCreatedChat(null)
      setCreatedProject(null)
      // The Connect screen covers this state; a connection that becomes ready opens on connecting.
      setStatus('connecting')
      /* eslint-enable react-hooks/set-state-in-effect */
      return
    }

    let connection: WorkspaceConnection
    connection = createWorkspaceConnection({
      url: webSocketUrlFor(origin ?? ''),
      auth: {
        // The device token does not expire; the development override has none.
        getToken: () => deviceRef.current.credential?.token ?? null,
        // A turned-away socket keeps retrying. Only a Mac that says it no longer knows
        // this phone sends it back to the Connect screen; a sleeping Mac does not.
        onRejected: () => {
          const credential = deviceRef.current.credential
          if (credential === null) return
          void checkDevice(credential).then((state) => {
            if (state === 'revoked') void deviceRef.current.revoked(credential.deviceId)
          })
        },
      },
      sockets: {
        openState: WebSocket.OPEN,
        create: (url) => new WebSocket(url) as unknown as SocketAdapter,
      },
      onStatus: (next) => {
        liveRef.current = next === 'live'
        setStatus(next)
      },
      onOpen: () => {
        setWorkspace((current) => clearArtifactRequest(clearRunningTurns(current)))
        const token = pushTokenRef.current
        if (token !== null) connection.send({ type: 'register_push_token', token })
        pushRefreshRef.current()
        const reopen = store.get().pendingChatId ?? store.get().openChatId
        // A new socket holds nothing. A copy that knows its rewrite position still asks only for what it missed.
        if (reopen !== null) connection.send(openChatRequest(reopen, store.get().threads[reopen], false, connection.syncOf(reopen)))
      },
      onInvalidMessage: () => console.warn('manor mobile received a message outside the contract'),
      onClose: () => {
        workAcceptance.current.cancel()
        dropResultRequests()
      },
      onMessage: (message) => {
        workAcceptance.current.receive(message)
        if (
          message.type === 'browser_tool_request' ||
          message.type === 'browser_session_close' ||
          message.type === 'computer_stop_armed'
        ) return
        if (message.type === 'ack' && message.requestId !== undefined) {
          ackWaiters.current.get(message.requestId)?.()
        }
        if ((message.type === 'ack' || message.type === 'notice') && message.requestId !== undefined) {
          const waiting = resultRequests.current.get(message.requestId)
          if (waiting !== undefined) {
            resultRequests.current.delete(message.requestId)
            if (message.type === 'ack') waiting.resolve()
            else waiting.reject(new Error(message.text))
          }
        }
        if ((message.type === 'search_results' || message.type === 'notice') && message.requestId !== undefined) {
          const waiting = searchRequests.current.get(message.requestId)
          if (waiting !== undefined) {
            searchRequests.current.delete(message.requestId)
            if (message.type === 'search_results') waiting.resolve({ messages: message.messages, notes: message.notes })
            else waiting.reject(new Error(message.text))
          }
        }
        if (message.type === 'chat_created') {
          setCreatedChat({
            chatId: message.chatId,
            ...(message.requestId === undefined ? {} : { requestId: message.requestId }),
          })
          return
        }
        if (message.type === 'project_created') {
          framesRef.current?.flush()
          setCreatedProject({
            projectId: message.projectId,
            ...(message.requestId === undefined ? {} : { requestId: message.requestId }),
          })
          return
        }
        // An override request is answered by an ack or a notice; either way the local
        // echo steps aside for whatever the server now says the chat runs on.
        if ((message.type === 'ack' || message.type === 'notice') && message.requestId !== undefined) {
          const chatId = overrideRequests.current.get(message.requestId)
          if (chatId !== undefined) {
            overrideRequests.current.delete(message.requestId)
            const settledRequest = message.requestId
            setWorkspace((current) => settleChatOverride(current, chatId, settledRequest))
          }
        }
        framesRef.current?.push(message)
      },
    })
    connectionRef.current = connection

    const stopWatchingForeground = watchForeground(AppState, {
      reconnectAfterMs: BACKGROUND_RECONNECT_AFTER_MS,
      isLive: () => liveRef.current,
      onReconnect: () => connection.reconnect(),
      onForeground: () => pushRefreshRef.current(),
    })

    return () => {
      stopWatchingForeground()
      framesRef.current?.flush()
      workAcceptance.current.cancel()
      dropResultRequests()
      connection.dispose()
      if (connectionRef.current === connection) connectionRef.current = null
    }
  }, [connected, connectionKey, deviceReady, origin, setWorkspace, store])

  useEffect(() => {
    if (!deviceReady || !connected) return
    // Pairing again re-enables registration after the previous Mac's
    // explicit teardown left this provider mounted.
    signingOutRef.current = false
    let active = true
    let inFlight = false
    let attempt = 0
    let retryTimer: ReturnType<typeof setTimeout> | undefined

    const refresh = async () => {
      if (!active || signingOutRef.current || inFlight) return
      inFlight = true
      const token = await registerForPushNotifications()
      inFlight = false
      if (!active || signingOutRef.current) return
      if (token === null) {
        const delay = PUSH_RETRY_DELAYS_MS[attempt]
        if (delay !== undefined) {
          attempt += 1
          retryTimer = setTimeout(() => void refresh(), delay)
        }
        return
      }
      attempt = 0
      const previous = pushTokenRef.current
      if (previous !== null && previous !== token) {
        connectionRef.current?.send({ type: 'unregister_push_token', token: previous })
      }
      pushTokenRef.current = token
      connectionRef.current?.send({ type: 'register_push_token', token })
    }

    const trigger = () => {
      if (!active || signingOutRef.current) return
      clearTimeout(retryTimer)
      attempt = 0
      void refresh()
    }
    pushRefreshRef.current = trigger
    trigger()
    const removeListener = onPushTokenChanged(trigger)
    return () => {
      active = false
      clearTimeout(retryTimer)
      if (pushRefreshRef.current === trigger) pushRefreshRef.current = () => {}
      removeListener()
    }
  }, [connected, connectionKey, deviceReady])

  const openChat = useCallback((chatId: string) => {
    setWorkspace((current) => selectChat(current, chatId))
    return send(openChatRequest(chatId, store.get().threads[chatId], connectionRef.current?.holds(chatId) === true, connectionRef.current?.syncOf(chatId)))
  }, [send, setWorkspace, store])

  const leaveChat = useCallback((chatId: string) => {
    setWorkspace((current) => leaveChatSelection(current, chatId))
  }, [setWorkspace])

  const setChatSettled = useCallback(
    (chatId: string, settled: boolean) => commands().setChatSettled(chatId, settled),
    [commands],
  )

  const askProjectCheckout = useCallback(
    (projectId: string) => send({ type: 'checkout_status', projectId }),
    [send],
  )

  const askCheckoutStatus = useCallback(
    (chatId: string) => send({ type: 'checkout_status', chatId }),
    [send],
  )

  const rejectWorkHandoff = useCallback(
    (handoffId: string) => send({ type: 'reject_work_handoff', handoffId }),
    [send],
  )

  const confirmWorkGoal = useCallback(
    (handoffId: string, mergeInto?: string, version?: number) => commands().confirmWorkGoal(handoffId, mergeInto, version),
    [commands],
  )
  const answered = useCallback((sent: (id: string) => boolean) => new Promise<void>((resolve, reject) => {
    const id = requestId('work-result')
    resultRequests.current.set(id, { resolve, reject })
    if (sent(id)) return
    resultRequests.current.delete(id)
    reject(new Error('Not connected. Try again when Manor is back.'))
  }), [])
  const acceptWorkResult = useCallback(
    (handoffId: string, mergeInto: string | undefined, version: number) =>
      answered((id) => commands().confirmWorkGoal(handoffId, mergeInto, version, id)),
    [answered, commands],
  )
  const reviseWorkResult = useCallback(
    (handoffId: string, version: number, text: string, images: ImageAttachment[]) =>
      answered((id) => commands().reviseWorkGoal(handoffId, version, text, id, images)),
    [answered, commands],
  )
  const retryWorkResult = useCallback(
    (handoffId: string) => answered((id) => commands().retryWorkCompletion(handoffId, id)),
    [answered, commands],
  )

  const approveMergeFix = useCallback(
    (handoffId: string, tip: string) => answered((id) => commands().approveMergeFix(handoffId, tip, id)),
    [answered, commands],
  )

  const updateProject = useCallback(
    (projectId: string, edit: ProjectEdit) =>
      answered((id) => send({ type: 'update_project', projectId, ...edit, name: edit.name.trim(), requestId: id })),
    [answered, send],
  )
  const deleteProject = useCallback(
    (projectId: string) => answered((id) => send({ type: 'delete_project', projectId, requestId: id })),
    [answered, send],
  )
  // `save_agent` carries the whole agent, so only the edited fields are the phone's: the rest
  // comes from the roster as it is now, never from a copy a screen held while the Mac changed her.
  // Edits ride along until the roster carrying them is applied, so a second save cannot undo the first.
  const unansweredEdits = useRef(new Map<string, Partial<AgentEdit>>())
  const saveAgent = useCallback((agentId: string, edit: Partial<AgentEdit>) => {
    const agent = store.get().agents.find((candidate) => candidate.id === agentId)
    if (agent === undefined) return Promise.reject(new Error('This agent is no longer in Manor.'))
    const { allowedTools: _serverOwned, ...draft } = agent
    const edits = { ...unansweredEdits.current.get(agentId), ...edit }
    unansweredEdits.current.set(agentId, edits)
    const settle = () => {
      const now = unansweredEdits.current.get(agentId)
      if (now === edits) unansweredEdits.current.delete(agentId)
    }
    const saved = answered((id) => send({ type: 'save_agent', agent: { ...draft, ...edits }, requestId: id }))
    // The roster precedes the ack but reaches the store a frame later.
    saved.then(() => {
      const stop = store.subscribe(() => {
        stop()
        settle()
      })
    }, settle)
    return saved
  }, [answered, send, store])

  const acceptWorkHandoff = useCallback(
    (handoffId: string, options: WorkAcceptanceOptions) =>
      workAcceptance.current.accept(send, requestId('work-accept'), handoffId, options),
    [send],
  )

  const openRun = chatOf(workspace, workspace.openChatId)
  const openRunBusy = openRun === null
    ? false
    : activityOf(workspace, openRun.id).runningTurns.length > 0
  useEffect(() => {
    if (openRun === null || !shouldSettleOpenRun(openRun, openRunBusy)) return
    // Reading a finished run is itself the external event this effect persists;
    // the optimistic echo stops the green orb before the server snapshot returns.
    setChatSettled(openRun.id, true)
  }, [openRun, openRunBusy, setChatSettled])

  // Request changes feedback is only kept for a result that can still change.
  useEffect(() => {
    if (status === 'live') forgetClosedWorkChanges(workspace.workHandoffs, workspace.chats)
  }, [status, workspace.workHandoffs, workspace.chats])

  const forget = useCallback(async () => {
    signingOutRef.current = true
    try {
      const token = pushTokenRef.current
      let serverDeleted = false
      if (token !== null) {
        const id = requestId('push-unregister')
        serverDeleted = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), PUSH_ACK_WAIT_MS)
          ackWaiters.current.set(id, () => {
            clearTimeout(timer)
            resolve(true)
          })
          if (!send({ type: 'unregister_push_token', token, requestId: id })) {
            clearTimeout(timer)
            resolve(false)
          }
        })
        ackWaiters.current.delete(id)
      }
      const nativeDeleted = await unregisterForPushNotifications()
      if (!serverDeleted && !nativeDeleted) {
        throw new Error('Push registration could not be removed; the connection stays.')
      }
      pushTokenRef.current = null
      await deviceRef.current.forget()
    } catch (error) {
      signingOutRef.current = false
      pushRefreshRef.current()
      throw error
    }
  }, [send])

  const sendMessage = useCallback((chatId: string, text: string, images: ImageAttachment[] = [], staged: StagedFile[] = [], replyTo?: MessageReply, quotes: InlineQuote[] = []) => {
    const normalized = text.trim()
    if (normalized === '' && images.length === 0 && staged.length === 0) return false
    const { files, documents } = splitStagedFiles(staged)
    const sent = send({
      type: 'send_message',
      chatId,
      text: normalized,
      ...(images.length === 0 ? {} : { images }),
      ...(files.length === 0 ? {} : { files }),
      ...(documents.length === 0 ? {} : { documents }),
      ...(replyTo === undefined ? {} : { replyTo }),
      ...(quotes.length === 0 ? {} : { quotes }),
    })
    if (sent) setWorkspace((current) => sendingUserMessage(current, chatId, normalized, {
      images,
      files,
      documents,
      ...(replyTo === undefined ? {} : { replyTo }),
      ...(quotes.length === 0 ? {} : { quotes }),
    }))
    return sent
  }, [send, setWorkspace])

  const createChat = useCallback(
    (target: NewChatTarget, opening: Opening, overrides: Record<string, ChatOverride>, requestId: string) => {
      setCreatedChat(null)
      const normalized = opening.text.trim()
      return send(
        createChatMessage(
          target,
          normalized === '' && opening.images.length === 0 && (opening.files ?? []).length === 0
            ? undefined
            : { text: normalized, images: opening.images, ...splitStagedFiles(opening.files ?? []) },
          overrides,
          undefined,
          requestId,
        ),
      )
    },
    [send],
  )

  const addFolder = useCallback(
    (repoPath: string, requestId: string) => {
      setCreatedProject(null)
      return send({ type: 'add_folder', path: repoPath, requestId })
    },
    [send],
  )

  const removeFolder = useCallback(
    (projectId: string) => answered((id) => send({ type: 'remove_folder', projectId, requestId: id })),
    [answered, send],
  )
  const undoMemoryWrite = useCallback(
    (chatId: string, writeId: string) => answered((id) => send({ type: 'undo_memory_write', chatId, writeId, requestId: id })),
    [answered, send],
  )
  const setReaction = useCallback(
    (chatId: string, eventId: string, emoji: string | null) => answered((id) => send({ type: 'set_reaction', chatId, eventId, emoji, requestId: id })),
    [answered, send],
  )

  const setChatOverride = useCallback(
    (chatId: string, agentId: string, override: ChatOverride) => {
      const id = requestId('override')
      overrideRequests.current.set(id, chatId)
      if (commands().setChatOverride(chatId, agentId, override, id)) return true
      overrideRequests.current.delete(id)
      return false
    },
    [commands],
  )

  const listRepoFiles = useCallback(
    (projectId: string, chatId?: string) =>
      send(chatId === undefined ? { type: 'list_repo_files', projectId } : { type: 'list_repo_files', projectId, chatId }),
    [send],
  )

  const getDmFiles = useCallback((chatId: string) => commands().getDmFiles(chatId), [commands])
  const findRepoIcon = useCallback((projectId: string) => commands().findRepoIcon(projectId), [commands])

  const readRepoFile = useCallback(
    (projectId: string, path: string, chatId?: string) => commands().readRepoFile(projectId, path, chatId),
    [commands],
  )

  // A new folder request makes the last plain refusal stale. Clearing it gives a repeated
  // refusal a fresh notice, which the folder pickers tell apart by identity. A notice that
  // answers a request stays for the screen waiting on it.
  const listDirs = useCallback((path?: string) => {
    setWorkspace((state) => state.notice?.requestId === undefined ? clearNotice(state) : state)
    return commands().listDirs(path)
  }, [commands, setWorkspace])

  const closeDirs = useCallback(() => setWorkspace(forgetDirs), [setWorkspace])

  const runRoutine = useCallback(
    (routineId: string) => {
      const id = requestId('routine')
      return send({ type: 'run_routine_now', routineId, requestId: id }) ? id : null
    },
    [send],
  )

  const listVault = useCallback(() => send({ type: 'list_vault' }), [send])
  const listWorkflowSuggestions = useCallback(() => send({ type: 'list_workflow_suggestions' }), [send])

  const readVaultFile = useCallback((path: string) => commands().readVaultFile(path), [commands])

  const search = useCallback((query: string) => new Promise<SearchAnswer>((resolve, reject) => {
    const id = requestId('search')
    searchRequests.current.set(id, { resolve, reject })
    if (send({ type: 'search', requestId: id, query })) return
    searchRequests.current.delete(id)
    reject(new Error(SEARCH_CONNECTION_LOST))
  }), [send])

  const listArtifacts = useCallback(
    (query: string) => {
      const id = requestId('artifacts')
      const previous = store.get().artifacts.requestId
      const sent = send(
        previous === null
          ? { type: 'list_mymind_objects', query, requestId: id }
          : { type: 'list_mymind_objects', query, requestId: id, cancelRequestId: previous },
      )
      if (!sent) return null
      setWorkspace((current) => askMyMindObjects(current, query, id))
      return id
    },
    [send, setWorkspace, store],
  )

  const loadMoreArtifacts = useCallback(() => {
    const id = store.get().artifacts.requestId
    if (id === null) return false
    return commands().loadMoreMyMindObjects(id)
  }, [commands, store])

  const clearCreatedChat = useCallback(() => setCreatedChat(null), [])
  const clearCreatedProject = useCallback(() => setCreatedProject(null), [])

  const actions = useMemo<WorkspaceActions>(
    () => ({
      clearCreatedChat,
      clearCreatedProject,
      openChat,
      leaveChat,
      setChatSettled,
      acceptWorkHandoff,
      rejectWorkHandoff,
      confirmWorkGoal,
      acceptWorkResult,
      reviseWorkResult,
      retryWorkResult,
      approveMergeFix,
      askCheckoutStatus,
      askProjectCheckout,
      sendMessage,
      stopTurn,
      stopBackground,
      openSubagentThread,
      stopSubagent,
      answerUserInput,
      answerSecretRequest,
      changeSessionAnswer,
      submitOutboundDraft,
      discardOutboundDraft,
      snoozeOutboundDraft,
      ignoreOutboundDraft,
      restoreOutboundDraft,
      readOutboundThread,
      createChat,
      addFolder,
      removeFolder,
      undoMemoryWrite,
      setReaction,
      updateProject,
      saveAgent,
      deleteProject,
      setChatOverride,
      listRepoFiles,
      getDmFiles,
      findRepoIcon,
      readRepoFile,
      listDirs,
      closeDirs,
      runRoutine,
      listWorkflowSuggestions,
      forget,
      listVault,
      readVaultFile,
      search,
      listArtifacts,
      loadMoreArtifacts,
    }),
    [acceptWorkHandoff, answerSecretRequest, answerUserInput, changeSessionAnswer, askCheckoutStatus, askProjectCheckout, clearCreatedChat, clearCreatedProject, closeDirs, confirmWorkGoal, acceptWorkResult, reviseWorkResult, retryWorkResult, approveMergeFix, createChat, addFolder, removeFolder, undoMemoryWrite, setReaction, deleteProject, discardOutboundDraft, ignoreOutboundDraft, listWorkflowSuggestions, listArtifacts, getDmFiles, findRepoIcon, listDirs, listRepoFiles, listVault, loadMoreArtifacts, openChat, leaveChat, openSubagentThread, readOutboundThread, readRepoFile, readVaultFile, rejectWorkHandoff, search, restoreOutboundDraft, runRoutine, sendMessage, setChatOverride, setChatSettled, forget, snoozeOutboundDraft, stopBackground, stopSubagent, stopTurn, submitOutboundDraft, updateProject, saveAgent],
  )

  const data = useMemo<WorkspaceData>(
    () => ({ workspace, createdChat, createdProject }),
    [createdChat, createdProject, workspace],
  )

  return (
    <WorkspaceActionsContext.Provider value={actions}>
      <WorkspaceStatusContext.Provider value={status}>
        <WorkspaceLiveContext.Provider value={store}>
          <WorkspaceDataContext.Provider value={data}>{children}</WorkspaceDataContext.Provider>
        </WorkspaceLiveContext.Provider>
      </WorkspaceStatusContext.Provider>
    </WorkspaceActionsContext.Provider>
  )
}

function required<T>(value: T | null, hook: string): T {
  if (value === null) throw new Error(`${hook} must be used inside WorkspaceProvider`)
  return value
}

/** Commands only; never re-renders on workspace or connection changes. */
export function useWorkspaceActions(): WorkspaceActions {
  return required(useContext(WorkspaceActionsContext), 'useWorkspaceActions')
}

/** The socket's connection status; changes only when the connection does. */
export function useWorkspaceStatus(): ConnectionStatus {
  return required(useContext(WorkspaceStatusContext), 'useWorkspaceStatus')
}

export function useWorkspaceData(): WorkspaceData {
  return required(useContext(WorkspaceDataContext), 'useWorkspaceData')
}

/**
 * One chat's thread with its streamed text. It renders on every text frame of that chat
 * alone, so only the views that draw the text read it: the transcript and a subagent's
 * conversation. Everything else reads the quiet workspace.
 */
export function useLiveThread(chatId: string | null): ThreadState {
  const live = required(useContext(WorkspaceLiveContext), 'useLiveThread')
  const read = () => liveThreadOf(live, chatId)
  return useSyncExternalStore(live.subscribe, read, read)
}

/** Everything at once; re-renders on every change but streamed text. Prefer a narrower hook where it fits. */
export function useWorkspace(): WorkspaceContextValue {
  const data = useWorkspaceData()
  const status = useWorkspaceStatus()
  const actions = useWorkspaceActions()
  return { ...data, status, ...actions }
}
