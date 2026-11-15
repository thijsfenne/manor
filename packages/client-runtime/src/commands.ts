import type {
  ChatOverride,
  ChatMode,
  CheckoutRequest,
  ClientMessage,
  DocumentUpload,
  FileAttachment,
  ImageAttachment,
  InlineQuote,
  PageContextAttachment,
  ServerMessage,
  SingleRuntime,
  SlackRichText,
  ThreadEvent,
  UserInputAnswers,
} from '@manor/contracts'
import { SINGLE_CHAT_VOICE } from '@manor/contracts'
import { openChatRequest } from './connection'
import {
  askChildThread,
  askDirs,
  askMoreMyMindObjects,
  askRepoFile,
  askVaultFile,
  echoChatOverride,
  settleChatOverride,
  withChatSettled,
  withRoutineRunsRead,
} from './workspaceActions'
import type { WorkspaceState } from './workspaceState'

export type NewChatTarget =
  | { kind: 'project'; projectId: string; mode?: ChatMode }
  | { kind: 'dm'; agentId: string }
  | { kind: 'group'; memberIds: string[]; title?: string }
  /** A session beside the Browser surface; its mode is fixed here, at the start. */
  | { kind: 'browser'; mode: ChatMode }

export interface OpeningMessage {
  text: string
  images: ImageAttachment[]
  /** Text files staged with the opening message. Absent and empty mean the same. */
  files?: FileAttachment[]
  /** PDF and Word originals staged with the opening message. */
  documents?: DocumentUpload[]
  pageContexts?: PageContextAttachment[]
  quotes?: InlineQuote[]
}

export interface WorkAcceptanceOptions {
  checkout?: CheckoutRequest
  mode: ChatMode
  runtime?: SingleRuntime
  /** Set only when the user edited the proposed task on the card. */
  task?: string
}

/**
 * Builds the single wire command used by web and native clients to create a chat.
 * Keeping target normalization here prevents either client from inventing a subtly
 * different project, DM, or group shape.
 */
export function createChatMessage(
  target: NewChatTarget,
  openingMessage?: OpeningMessage,
  overrides?: Record<string, ChatOverride>,
  checkout?: CheckoutRequest,
  requestId?: string,
): ClientMessage {
  // A draft may retain both sets while switching modes. Only the selected runtime
  // crosses the wire; persona pins make a single-session create invalid.
  const single = (target.kind === 'project' || target.kind === 'browser') && target.mode === 'single'
  const selectedPins = Object.fromEntries(Object.entries(overrides ?? {}).filter(
    ([id]) => single === (id === SINGLE_CHAT_VOICE.id),
  ))
  const pins = Object.keys(selectedPins).length > 0 ? { overrides: selectedPins } : {}
  const where =
    target.kind === 'project'
      ? { projectId: target.projectId, ...(target.mode === undefined ? {} : { mode: target.mode }) }
      : target.kind === 'browser'
        ? { kind: 'browser' as const, mode: target.mode }
      : target.kind === 'dm'
        ? { kind: 'dm' as const, memberIds: [target.agentId] }
        : {
            kind: 'group' as const,
            memberIds: target.memberIds,
            ...(target.title === undefined || target.title === '' ? {} : { title: target.title }),
          }

  return {
    type: 'create_chat',
    ...(requestId === undefined ? {} : { requestId }),
    ...where,
    ...pins,
    ...(checkout === undefined || checkout.mode === 'current' ? {} : { checkout }),
    ...(openingMessage === undefined
      ? {}
      : {
          openingMessage: {
            text: openingMessage.text,
            ...(openingMessage.images.length === 0 ? {} : { images: openingMessage.images }),
            ...(openingMessage.files === undefined || openingMessage.files.length === 0
              ? {}
              : { files: openingMessage.files }),
            ...(openingMessage.documents === undefined || openingMessage.documents.length === 0
              ? {}
              : { documents: openingMessage.documents }),
            ...(openingMessage.pageContexts === undefined || openingMessage.pageContexts.length === 0
              ? {}
              : { pageContexts: openingMessage.pageContexts }),
            ...(openingMessage.quotes === undefined || openingMessage.quotes.length === 0
              ? {}
              : { quotes: openingMessage.quotes }),
          },
        }),
  }
}

/** Work opens only after its own acknowledgement, including any Git preparation. */
export function createWorkAcceptance() {
  const pending = new Map<string, (error?: string, chatId?: string) => void>()
  const created = new Map<string, string>()
  return {
    accept(send: (message: ClientMessage) => boolean, requestId: string, handoffId: string, options: WorkAcceptanceOptions): Promise<string> {
      return new Promise((resolve, reject) => {
        const finish = (error?: string, chatId?: string) => {
          clearTimeout(timer)
          pending.delete(requestId)
          if (error === undefined && chatId !== undefined) resolve(chatId)
          else reject(new Error(error ?? 'No session confirmed. Try again.'))
        }
        const timer = setTimeout(() => finish('No confirmation received. Try again.'), 60_000)
        pending.set(requestId, finish)
        if (!send({
          type: 'accept_work_handoff',
          handoffId,
          requestId,
          mode: options.mode,
          ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
          ...(options.checkout === undefined ? {} : { checkout: options.checkout }),
          ...(options.task === undefined ? {} : { task: options.task }),
        })) {
          finish('Not connected. Try again when connected.')
        }
      })
    },
    /**
     * Opts a project into its thread, or out again, and resolves on Manor's answer: the
     * thread's chat id on create, an empty string on remove (2026-10-10).
     */
    projectThread(send: (message: ClientMessage) => boolean, requestId: string, projectId: string, action: 'create' | 'remove'): Promise<string> {
      return new Promise((resolve, reject) => {
        const finish = (error?: string, chatId?: string) => {
          clearTimeout(timer)
          pending.delete(requestId)
          if (error === undefined) resolve(chatId ?? '')
          else reject(new Error(error))
        }
        const timer = setTimeout(() => finish('No confirmation received. Try again.'), 30_000)
        pending.set(requestId, finish)
        if (!send({ type: action === 'create' ? 'create_project_thread' : 'remove_project_thread', projectId, requestId })) {
          finish('Not connected. Try again when connected.')
        }
      })
    },
    /**
     * Adds a folder to start Sessions in, or takes one off the picker, and resolves on
     * Manor's answer: the folder's project id on add, an empty string on remove.
     */
    folder(send: (message: ClientMessage) => boolean, requestId: string, change: { add: string } | { remove: string }): Promise<string> {
      return new Promise((resolve, reject) => {
        const finish = (error?: string) => {
          clearTimeout(timer)
          pending.delete(requestId)
          const projectId = created.get(requestId)
          created.delete(requestId)
          if (error !== undefined) reject(new Error(error))
          else if ('add' in change && projectId === undefined) reject(new Error('Manor did not say which folder it added. Try again.'))
          else resolve(projectId ?? '')
        }
        const timer = setTimeout(() => finish('No confirmation received. Try again.'), 30_000)
        pending.set(requestId, finish)
        if (!send('add' in change
          ? { type: 'add_folder', path: change.add, requestId }
          : { type: 'remove_folder', projectId: change.remove, requestId })) {
          finish('Not connected. Try again when connected.')
        }
      })
    },
    receive(message: ServerMessage) {
      // Sent just ahead of the ack, so the folder is known by the time the ack settles it.
      if (message.type === 'project_created' && message.requestId !== undefined && pending.has(message.requestId)) {
        created.set(message.requestId, message.projectId)
      }
      if ((message.type === 'ack' || message.type === 'notice') && message.requestId !== undefined) {
        pending.get(message.requestId)?.(message.type === 'notice' ? message.text : undefined, message.type === 'ack' ? message.workChatId : undefined)
      }
    },
    cancel() {
      for (const finish of pending.values()) finish('Connection closed before confirmation. Try again when connected.')
    },
  }
}

type Send = (message: ClientMessage) => boolean
type Update = (change: (state: WorkspaceState) => WorkspaceState) => void

/**
 * The requests web and native build the same way, each paired with its optimistic
 * state change. A pending mark lands only when the send actually left: marking a
 * wait nobody is serving is the lying spinner in its quietest form. Each client
 * injects its own socket `send` and its store `update`; lifecycle stays with them.
 * Every command returns whether the request left.
 */
export function createWorkspaceCommands(send: Send, update: Update) {
  const ask = (message: ClientMessage, change: (state: WorkspaceState) => WorkspaceState) => {
    const sent = send(message)
    if (sent) update(change)
    return sent
  }
  return {
    readRepoFile: (projectId: string, path: string, chatId?: string) =>
      ask(
        { type: 'read_repo_file', projectId, path, ...(chatId === undefined ? {} : { chatId }) },
        (state) => askRepoFile(state, projectId, path, chatId),
      ),
    readVaultFile: (path: string) =>
      ask({ type: 'read_vault_file', path }, (state) => askVaultFile(state, path)),
    listDirs: (path?: string) =>
      ask(path === undefined ? { type: 'list_dirs' } : { type: 'list_dirs', path }, askDirs),
    loadMoreMyMindObjects: (requestId: string) =>
      ask({ type: 'load_more_mymind_objects', requestId }, (state) => askMoreMyMindObjects(state, requestId)),
    /** A routine's history, answered as `routine_runs`. */
    getRoutineRuns: (routineId: string) => send({ type: 'get_routine_runs', routineId }),
    /** Read means shown: send once a run's result is on screen. The dot goes at once. */
    markRoutineRunsRead: (routineId: string, runIds: readonly string[]) =>
      ask(
        { type: 'mark_routine_runs_read', routineId, runIds: [...runIds] },
        (state) => withRoutineRunsRead(state, routineId, runIds),
      ),
    markAllRoutineRunsRead: () =>
      ask({ type: 'mark_all_routine_runs_read' }, (state) => withRoutineRunsRead(state, null)),
    /** The row moves before the server answers; the directory broadcast settles the truth. */
    setChatSettled: (chatId: string, settled: boolean) =>
      ask({ type: 'set_chat_settled', chatId, settled }, (state) => withChatSettled(state, chatId, settled)),
    /**
     * The user agrees the lead reached the goal. Nothing moves before the server answers:
     * Confirmed shows once the directory carries the stored stamp, and a refused write
     * leaves Confirm in place beside the server's notice.
     */
    confirmWorkGoal: (handoffId: string, mergeInto?: string, version?: number, requestId?: string) =>
      send({ type: 'confirm_work_goal', handoffId, ...(mergeInto === undefined ? {} : { mergeInto }),
        ...(version === undefined ? {} : { version }), ...(requestId === undefined ? {} : { requestId }) }),
    /** Retry on a blocked card: the same approval tries the commit or merge again. */
    retryWorkCompletion: (handoffId: string, requestId?: string) =>
      send({ type: 'retry_work_completion', handoffId, ...(requestId === undefined ? {} : { requestId }) }),
    /** The user approves the conflict fix the card shows; the tip refuses one the lead changed since. */
    approveMergeFix: (handoffId: string, tip: string, requestId?: string) =>
      send({ type: 'approve_merge_fix', handoffId, tip, ...(requestId === undefined ? {} : { requestId }) }),
    /** Sends the user's feedback on a result back to its Session; the version refuses a stale card. */
    reviseWorkGoal: (handoffId: string, version: number, text: string, requestId?: string) =>
      send({ type: 'revise_work_goal', handoffId, version, text, ...(requestId === undefined ? {} : { requestId }) }),
    stopTurn: (turnId: string) => send({ type: 'stop', turnId }),
    /** Stops the background work a chat waits on after its turns ended, and any pending wake. */
    stopBackground: (chatId: string) => send({ type: 'stop_background', chatId }),
    stopSubagent: (chatId: string, toolCallId: string) => send({ type: 'stop_subagent', chatId, toolCallId }),
    /**
     * Asks for a subagent's child thread. `thread` and `held` are the client's own copy
     * and whether its socket still holds it: a held thread asks only for what follows.
     */
    openSubagentThread: (childId: string, parentId: string, thread: { events: readonly ThreadEvent[] } | undefined, held: boolean) => {
      update((state) => askChildThread(state, childId, parentId))
      return send(openChatRequest(childId, thread, held))
    },
    answerUserInput: (chatId: string, requestId: string, answers: UserInputAnswers) =>
      send({ type: 'answer_user_input', chatId, requestId, answers }),
    answerSecretRequest: (chatId: string, requestId: string, value?: string) =>
      send({ type: 'answer_secret_request', chatId, requestId, ...(value === undefined ? {} : { value }) }),
    /** Replaces an answer the project thread gave a Session from a preference. */
    changeSessionAnswer: (threadChatId: string, requestId: string, answers: UserInputAnswers) =>
      send({ type: 'change_session_answer', chatId: threadChatId, requestId, answers }),
    submitOutboundDraft: (chatId: string, draftId: string, body: string, subject?: string, slackRichText?: SlackRichText, cc?: string) =>
      send({ type: 'submit_outbound_draft', chatId, draftId, body, ...(subject === undefined ? {} : { subject }),
        ...(slackRichText === undefined ? {} : { slackRichText }), ...(cc === undefined ? {} : { cc }) }),
    discardOutboundDraft: (chatId: string, draftId: string) => send({ type: 'discard_outbound_draft', chatId, draftId }),
    snoozeOutboundDraft: (chatId: string, draftId: string, until: number) =>
      send({ type: 'snooze_outbound_draft', chatId, draftId, until }),
    ignoreOutboundDraft: (chatId: string, draftId: string) => send({ type: 'ignore_outbound_draft', chatId, draftId }),
    restoreOutboundDraft: (chatId: string, draftId: string) => send({ type: 'restore_outbound_draft', chatId, draftId }),
    /** The caller names the request, because the two clients make ids their own way. */
    readOutboundThread: (chatId: string, draftId: string, requestId: string) =>
      send({ type: 'outbound_thread_read', chatId, draftId, requestId }),
    /**
     * The label moves before the send, and steps back at once when the send did not
     * leave. The caller tracks `requestId` so the ack or notice can settle it.
     */
    setChatOverride: (chatId: string, agentId: string, override: ChatOverride, requestId: string) => {
      update((state) => echoChatOverride(state, chatId, { requestId, agentId, override }))
      if (send({ type: 'set_chat_override', chatId, agentId, override, requestId })) return true
      update((state) => settleChatOverride(state, chatId, requestId))
      return false
    },
  }
}
