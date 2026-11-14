import { createWorkAcceptance, createWorkspaceCommands, type WorkAcceptanceOptions } from '@manor/client-runtime/commands'
import {
  type SlackRichText,
  type ChatOverride,
  type ClientMessage,
  type ImageAttachment,
  type InlineQuote,
  type MessageReply,
  type Project,
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
import {
  askMyMindObjects,
  activityOf,
  askChildThread,
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

import { mobileConfig } from '@/lib/config'
import {
  onPushTokenChanged,
  registerForPushNotifications,
  unregisterForPushNotifications,
} from '@/lib/notifications'
import { authClient } from '@/lib/authClient'
import { watchForeground } from './appLifecycle'
import { useAuth } from './AuthProvider'

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
  /** Sends feedback on a reported result back to the same Session. */
  reviseWorkResult: (handoffId: string, version: number, text: string) => Promise<void>
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
  /** Saves the project form as a whole, as the Mac's Edit project does; resolves on the ack, rejects with the notice. */
  updateProject: (projectId: string, edit: ProjectEdit) => Promise<void>
  /** Deletes the project with its thread, Sessions and chats. */
  deleteProject: (projectId: string) => Promise<void>
  /** Pins one persona's runtime for this chat; the label moves before the server answers. */
  setChatOverride: (chatId: string, agentId: string, override: ChatOverride) => boolean
  /** Asks for a project's file listing, through the chat's checkout when there is one. */
  listRepoFiles: (projectId: string, chatId?: string) => boolean
  readRepoFile: (projectId: string, path: string, chatId?: string) => boolean
  listDirs: (path?: string) => boolean
  closeDirs: () => void
  /** Starts one routine and returns the id that correlates any refusal. */
  runRoutine: (routineId: string) => string | null
  /** Asks the Mac for the memory folder's suggestion ledger; it lands in `workspace.workflowSuggestions`. */
  listWorkflowSuggestions: () => boolean
  /** Forgets this install before ending the authenticated session. */
  signOut: () => Promise<void>
  /** Asks for the vault's note listing; nothing until the Knowledge screen wants it. */
  listVault: () => boolean
  readVaultFile: (path: string) => boolean
  /** Asks mymind for objects matching `query`; the id comes back so a stale answer can be told apart. */
  listArtifacts: (query: string) => string | null
  loadMoreArtifacts: () => boolean
}

/** What the project settings sheet writes: the Mac's Edit project form, field for field. */
export type ProjectEdit = Pick<Project, 'name' | 'icon' | 'color' | 'repoPaths' | 'memoryScope'>

type WorkspaceContextValue = WorkspaceData & WorkspaceActions & { status: ConnectionStatus }

const WorkspaceDataContext = createContext<WorkspaceData | null>(null)
const WorkspaceLiveContext = createContext<LiveWorkspace | null>(null)
const WorkspaceStatusContext = createContext<ConnectionStatus | null>(null)
const WorkspaceActionsContext = createContext<WorkspaceActions | null>(null)

const requestId = (prefix: string) => `mobile-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const auth = useAuth()
  const authRef = useRef(auth)
  useEffect(() => {
    authRef.current = auth
  }, [auth])

  // Outside React: a text frame changes the store, and only its live readers render.
  const [store] = useState(() => createWorkspaceStore(emptyWorkspace))
  const { update: applyWorkspace } = store
  const workspace = useSyncExternalStore(store.subscribe, store.quiet, store.quiet)
  const [status, setStatus] = useState<ConnectionStatus>('offline')
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
  const dropResultRequests = () => {
    for (const waiting of resultRequests.current.values()) waiting.reject(new Error(WORK_RESULT_CONNECTION_LOST))
    resultRequests.current.clear()
  }
  const workAcceptance = useRef(createWorkAcceptance())
  /** Override requests still in flight, so an ack or a notice can settle the right chat. */
  const overrideRequests = useRef(new Map<string, string>())
  const signedIn = auth.session !== null

  const framesRef = useRef<FrameQueue<ServerMessage> | null>(null)
  if (framesRef.current === null) {
    framesRef.current = createFrameQueue<ServerMessage>(
      (batch) => {
        applyWorkspace((current) => {
          let next = current
          for (const message of batch) next = reduce(next, message)
          return next
        })
      },
      {
        request: (run) => requestAnimationFrame(run),
        cancel: (handle) => cancelAnimationFrame(handle),
      },
      (message) => message.type === 'turn_state' && message.state !== 'running',
    )
  }

  const setWorkspace = useCallback((change: (state: WorkspaceState) => WorkspaceState) => {
    framesRef.current?.flush()
    applyWorkspace(change)
  }, [applyWorkspace])

  const send = useCallback((message: ClientMessage) => connectionRef.current?.send(message) === true, [])
  // Built per call: the React Compiler refuses a ref-reading `send` handed to a function during render.
  const commands = useCallback(() => createWorkspaceCommands(send, setWorkspace), [send, setWorkspace])

  useEffect(() => {
    if (!auth.ready || (auth.enabled && !signedIn)) {
      connectionRef.current?.dispose()
      connectionRef.current = null
      // Signing out tears the store down with the connection. The previous
      // connection's cleanup has already flushed the frame queue by the time this
      // body runs, so the reset cannot land underneath queued messages.
      /* eslint-disable react-hooks/set-state-in-effect */
      setWorkspace(() => emptyWorkspace)
      setCreatedChat(null)
      setCreatedProject(null)
      setStatus('offline')
      /* eslint-enable react-hooks/set-state-in-effect */
      return
    }

    let connection: WorkspaceConnection
    connection = createWorkspaceConnection({
      url: mobileConfig.webSocketUrl,
      auth: {
        getToken: () => authRef.current.getToken(),
        onRejected: () => void authClient?.refresh(),
      },
      sockets: {
        openState: WebSocket.OPEN,
        create: (url) => new WebSocket(url) as unknown as SocketAdapter,
      },
      onStatus: setStatus,
      onOpen: () => {
        setWorkspace((current) => clearArtifactRequest(clearRunningTurns(current)))
        const token = pushTokenRef.current
        if (token !== null) connection.send({ type: 'register_push_token', token })
        pushRefreshRef.current()
        const reopen = store.get().pendingChatId ?? store.get().openChatId
        if (reopen !== null) connection.send({ type: 'open_chat', chatId: reopen })
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
  }, [auth.enabled, auth.ready, auth.sessionKey, setWorkspace, signedIn, store])

  useEffect(() => {
    if (!auth.ready || (auth.enabled && !signedIn)) return
    // A successful sign-in re-enables registration after the previous account's
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
  }, [auth.enabled, auth.ready, signedIn])

  const openChat = useCallback((chatId: string) => {
    setWorkspace((current) => selectChat(current, chatId))
    return send(openChatRequest(chatId, store.get().threads[chatId], connectionRef.current?.holds(chatId) === true))
  }, [send, setWorkspace, store])

  const leaveChat = useCallback((chatId: string) => {
    setWorkspace((current) => leaveChatSelection(current, chatId))
  }, [setWorkspace])

  const openSubagentThread = useCallback((childId: string, parentId: string) => {
    setWorkspace((current) => askChildThread(current, childId, parentId))
    return send(openChatRequest(childId, store.get().threads[childId], connectionRef.current?.holds(childId) === true))
  }, [send, setWorkspace, store])

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
    (handoffId: string, version: number, text: string) =>
      answered((id) => commands().reviseWorkGoal(handoffId, version, text, id)),
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

  const signOut = useCallback(async () => {
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
        throw new Error('Push registration could not be removed; the session remains active.')
      }
      pushTokenRef.current = null
      await authRef.current.signOut()
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

  const stopTurn = useCallback((turnId: string) => {
    send({ type: 'stop', turnId })
  }, [send])

  const stopBackground = useCallback((chatId: string) => {
    send({ type: 'stop_background', chatId })
  }, [send])

  const stopSubagent = useCallback(
    (chatId: string, toolCallId: string) => send({ type: 'stop_subagent', chatId, toolCallId }),
    [send],
  )

  const answerSecretRequest = useCallback(
    (chatId: string, requestId: string, value?: string) =>
      send({ type: 'answer_secret_request', chatId, requestId, ...(value === undefined ? {} : { value }) }),
    [send],
  )

  const answerUserInput = useCallback(
    (chatId: string, requestId: string, answers: UserInputAnswers) =>
      send({ type: 'answer_user_input', chatId, requestId, answers }),
    [send],
  )

  const changeSessionAnswer = useCallback(
    (threadChatId: string, requestId: string, answers: UserInputAnswers) =>
      send({ type: 'change_session_answer', chatId: threadChatId, requestId, answers }),
    [send],
  )

  const submitOutboundDraft = useCallback(
    (chatId: string, draftId: string, body: string, subject?: string, slackRichText?: SlackRichText, cc?: string) =>
      send({ type: 'submit_outbound_draft', chatId, draftId, body, ...(subject === undefined ? {} : { subject }), ...(slackRichText === undefined ? {} : { slackRichText }), ...(cc === undefined ? {} : { cc }) }),
    [send],
  )

  const discardOutboundDraft = useCallback(
    (chatId: string, draftId: string) => send({ type: 'discard_outbound_draft', chatId, draftId }),
    [send],
  )

  const snoozeOutboundDraft = useCallback(
    (chatId: string, draftId: string, until: number) =>
      send({ type: 'snooze_outbound_draft', chatId, draftId, until }),
    [send],
  )

  const ignoreOutboundDraft = useCallback(
    (chatId: string, draftId: string) => send({ type: 'ignore_outbound_draft', chatId, draftId }),
    [send],
  )

  const restoreOutboundDraft = useCallback(
    (chatId: string, draftId: string) => send({ type: 'restore_outbound_draft', chatId, draftId }),
    [send],
  )

  const readOutboundThread = useCallback(
    (chatId: string, draftId: string) => send({
      type: 'outbound_thread_read',
      chatId,
      draftId,
      requestId: requestId('outbound-thread'),
    }),
    [send],
  )

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
      updateProject,
      deleteProject,
      setChatOverride,
      listRepoFiles,
      readRepoFile,
      listDirs,
      closeDirs,
      runRoutine,
      listWorkflowSuggestions,
      signOut,
      listVault,
      readVaultFile,
      listArtifacts,
      loadMoreArtifacts,
    }),
    [acceptWorkHandoff, answerSecretRequest, answerUserInput, changeSessionAnswer, askCheckoutStatus, askProjectCheckout, clearCreatedChat, clearCreatedProject, closeDirs, confirmWorkGoal, acceptWorkResult, reviseWorkResult, retryWorkResult, approveMergeFix, createChat, addFolder, removeFolder, deleteProject, discardOutboundDraft, ignoreOutboundDraft, listWorkflowSuggestions, listArtifacts, listDirs, listRepoFiles, listVault, loadMoreArtifacts, openChat, leaveChat, openSubagentThread, readOutboundThread, readRepoFile, readVaultFile, rejectWorkHandoff, restoreOutboundDraft, runRoutine, sendMessage, setChatOverride, setChatSettled, signOut, snoozeOutboundDraft, stopBackground, stopSubagent, stopTurn, submitOutboundDraft, updateProject],
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
