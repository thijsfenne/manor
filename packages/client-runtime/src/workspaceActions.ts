import type {
  DocumentUpload,
  FileAttachment,
  ImageAttachment,
  MessageReply,
  InlineQuote,
  PageContextAttachment,
  WorkHandoff,
} from '@manor/contracts'
import { chatCommandOf } from '@manor/contracts'
import { IDLE, withActivity } from './activityState'
import {
  withOptimisticOverrides,
  type OptimisticChatOverride,
} from './optimisticOverrides'
import type { PendingMessage } from './threadState'
import type { WorkspaceState } from './workspaceState'

/** Ids for optimistic bubbles. Local and short-lived; nothing durable keys on them. */
let pendingCounter = 0

/**
 * Cache key for a files listing. With a chat id the listing follows that chat's
 * checkout; without one it is the project's own paths (new-chat draft).
 */
export function repoListingKey(projectId: string, chatId?: string): string {
  return chatId === undefined || chatId.length === 0 ? projectId : `${projectId}::${chatId}`
}

/**
 * Settles a chat, or picks it back up, before the server has answered: the row has
 * to leave the list under the cursor that clicked it. The directory broadcast that
 * follows the write remains authoritative, which is also how a refused write rolls
 * itself back. A chat already in the asked-for state comes back untouched, so no
 * render is spent on a click that changes nothing.
 */
export function withChatSettled(
  state: WorkspaceState,
  chatId: string,
  settled: boolean,
  now: number = Date.now(),
): WorkspaceState {
  const target = state.chats.find((chat) => chat.id === chatId)
  if (target === undefined) return state
  const session = state.workHandoffs.find((handoff) => handoff.workChatId === chatId)
  // A confirmed result sits under Settled without a stamp. Unsettling it records that
  // on the handoff, the way the server does, so the row stays out on the next snapshot.
  const leavesConfirmed = !settled && session?.goalConfirmedAt !== undefined && session.unsettledAt === undefined
  if ((target.settledAt !== null) === settled && !leavesConfirmed) return state
  const settledAt = settled ? now : null
  // Unsettle reopens the Session's handoff on the server too, and its status reads
  // both, so the overview and the card move back together instead of on the directory.
  const rewrite = (handoff: WorkHandoff): WorkHandoff => {
    if (handoff.workChatId !== chatId) return handoff
    const { unsettledAt: _cleared, ...cleared } = handoff
    const next = settled ? cleared : handoff.goalConfirmedAt === undefined ? handoff : { ...handoff, unsettledAt: handoff.unsettledAt ?? now }
    return !settled && handoff.state === 'settled' ? { ...next, state: 'active', result: null, resultAt: null } : next
  }
  return {
    ...state,
    chats: state.chats.map((chat) => (chat.id === chatId ? { ...chat, settledAt } : chat)),
    ...(session === undefined ? {} : { workHandoffs: state.workHandoffs.map(rewrite) }),
  }
}

/**
 * Drops runs from a routine's unread list before the server answers, so a dot goes
 * the moment its result is on screen. The `routines` broadcast stays authoritative.
 * `routineId` null reads every routine. Unchanged state comes back untouched.
 */
export function withRoutineRunsRead(
  state: WorkspaceState,
  routineId: string | null,
  runIds?: readonly string[],
): WorkspaceState {
  const read = runIds === undefined ? undefined : new Set(runIds)
  let changed = false
  const routines = state.routines.map((routine) => {
    if (routineId !== null && routine.id !== routineId) return routine
    const unreadRunIds = read === undefined ? [] : routine.unreadRunIds.filter((id) => !read.has(id))
    if (unreadRunIds.length === routine.unreadRunIds.length) return routine
    changed = true
    return { ...routine, unreadRunIds }
  })
  return changed ? { ...state, routines } : state
}

/** Optimistically moves a project chat into or out of its archive. */
export function withChatArchived(
  state: WorkspaceState,
  chatId: string,
  archived: boolean,
  now: number = Date.now(),
): WorkspaceState {
  const target = state.chats.find((chat) => chat.id === chatId)
  if (target === undefined || target.kind !== 'project' || (target.archivedAt !== null) === archived) return state
  const archivedAt = archived ? now : null
  return {
    ...state,
    chats: state.chats.map((chat) => (chat.id === chatId ? { ...chat, archivedAt } : chat)),
  }
}

/**
 * Marks exactly the note request that left; its echoed reply fills the result. The
 * previous save's answer goes with it: a conflict reported for the note being left
 * has nothing to do with the one being opened.
 */
export function askVaultFile(state: WorkspaceState, path: string): WorkspaceState {
  return { ...state, vault: { ...state.vault, note: { path, result: null }, write: null } }
}

/** Marks the save that left. Until its answer lands the editor says "Saving…". */
export function askVaultWrite(state: WorkspaceState, path: string): WorkspaceState {
  return { ...state, vault: { ...state.vault, write: { path, result: null } } }
}

/** Drops an AI edit's answer once its editor has it, or has stopped waiting for it. */
export function forgetVaultNoteEdit(state: WorkspaceState, requestId: string): WorkspaceState {
  if (state.vault.noteEdits?.[requestId] === undefined) return state
  const { [requestId]: _taken, ...noteEdits } = state.vault.noteEdits
  return { ...state, vault: { ...state.vault, noteEdits } }
}

/** Drops a picture save's answer once its editor has it, or has stopped waiting for it. */
export function forgetVaultImageSave(state: WorkspaceState, requestId: string): WorkspaceState {
  if (state.vault.imageSaves?.[requestId] === undefined) return state
  const { [requestId]: _taken, ...imageSaves } = state.vault.imageSaves
  return { ...state, vault: { ...state.vault, imageSaves } }
}

export function askMyMindObjects(state: WorkspaceState, query: string, requestId: string): WorkspaceState {
  return {
    ...state,
    artifacts: {
      ...state.artifacts,
      requestId,
      askingQuery: query,
      loadingMore: false,
      hasMore: false,
      error: null,
    },
  }
}

export function askMoreMyMindObjects(state: WorkspaceState, requestId: string): WorkspaceState {
  if (state.artifacts.requestId !== requestId || state.artifacts.loadingMore || !state.artifacts.hasMore) return state
  return {
    ...state,
    artifacts: { ...state.artifacts, loadingMore: true, error: null },
  }
}

/**
 * A reply-only mymind request belongs to the socket that sent it. Drop its identity
 * when a new socket opens, while keeping the last useful page visible until the
 * Artifacts screen reissues its current query.
 */
export function clearArtifactRequest(state: WorkspaceState): WorkspaceState {
  if (
    state.artifacts.requestId === null &&
    state.artifacts.askingQuery === null &&
    !state.artifacts.loadingMore
  ) return state
  return {
    ...state,
    artifacts: {
      ...state.artifacts,
      requestId: null,
      askingQuery: null,
      loadingMore: false,
    },
  }
}

/** Drops the last save's answer, for an editor that has moved past what it said. */
export function clearVaultWrite(state: WorkspaceState): WorkspaceState {
  if (state.vault.write === null) return state
  return { ...state, vault: { ...state.vault, write: null } }
}

/** Closes the open note, back to the panel's empty stage. */
export function closeVaultNote(state: WorkspaceState): WorkspaceState {
  if (state.vault.note === null && state.vault.write === null) return state
  return { ...state, vault: { ...state.vault, note: null, write: null } }
}

/**
 * Marks exactly the preview request that left; its echoed reply fills the result.
 * The previous save's answer goes with it: a conflict reported for the file being
 * left has nothing to do with the one being opened.
 */
export function askRepoFile(
  state: WorkspaceState,
  projectId: string,
  path: string,
  chatId?: string,
): WorkspaceState {
  const key = repoListingKey(projectId, chatId)
  return {
    ...state,
    repoFilePreviews: {
      ...state.repoFilePreviews,
      [key]: { path, result: null },
    },
    repoFileWrites: withoutKey(state.repoFileWrites, key),
  }
}

/** Marks the save that left. Until its answer lands the panel says "Saving…". */
export function askRepoWrite(
  state: WorkspaceState,
  projectId: string,
  path: string,
  chatId?: string,
): WorkspaceState {
  const key = repoListingKey(projectId, chatId)
  return {
    ...state,
    repoFileWrites: {
      ...state.repoFileWrites,
      [key]: { path, result: null },
    },
  }
}

/** Drops the last save's answer, for a panel that has moved past what it said. */
export function clearRepoWrite(state: WorkspaceState, projectId: string, chatId?: string): WorkspaceState {
  const key = repoListingKey(projectId, chatId)
  if (state.repoFileWrites[key] === undefined) return state
  return { ...state, repoFileWrites: withoutKey(state.repoFileWrites, key) }
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (record[key] === undefined) return record
  const { [key]: _dropped, ...rest } = record
  return rest
}

/**
 * Every running dot goes dark, for one socket that just came up. A turn that ended
 * while the client was offline was announced to nobody, and only the open chat asks
 * for a snapshot on reconnect, so a background chat's dot would spin forever until
 * someone clicked it. Clearing converges the other way instead: a turn genuinely
 * still in flight re-lights its own dot on its next delta or turn_state, and the
 * open chat's comes back with the snapshot's activeTurn, and the reconnect directory
 * lights every turn the server still runs (`relightRunning`).
 */
export function clearRunningTurns(state: WorkspaceState): WorkspaceState {
  const entries = Object.entries(state.activity)
  const relight = { ended: [] }
  if (entries.every(([, activity]) => activity.runningTurns.length === 0)) return { ...state, relight }
  return {
    ...state,
    relight,
    activity: Object.fromEntries(
      entries.map(([chatId, activity]) =>
        activity.runningTurns.length === 0
          ? [chatId, activity]
          : // The run this client was watching is over as far as this client knows,
            // so what it saw of it goes with it. A turn still genuinely in flight
            // re-lights its dot on its next message and is watched from there.
            [chatId, { ...activity, runningTurns: [], runStartedAt: null, sawStart: false, awaitingInput: [] }],
      ),
    ),
  }
}

/**
 * Local selection. The sidebar answers the click immediately; what renders only
 * changes when the snapshot for that chat lands.
 */
export function selectChat(state: WorkspaceState, chatId: string): WorkspaceState {
  const activity = withActivity(state.activity, chatId, {
    ...(state.activity[chatId] ?? IDLE),
    unread: false,
  })
  const pendingChatId = chatId === state.openChatId ? null : chatId
  if (pendingChatId === state.pendingChatId && activity === state.activity && !state.selectionCleared) return state
  return { ...state, pendingChatId, activity, selectionCleared: false }
}

export function clearChatSelection(state: WorkspaceState): WorkspaceState {
  return { ...state, openChatId: null, pendingChatId: null, selectionCleared: true }
}

/**
 * The phone left this chat's screen for one that shows no chat. Only while the chat is
 * still the selection: a chat pushed over it has already taken the selection and keeps
 * it. Without this the chat stays "viewed" from the inbox, so it never shows unread,
 * a run ending in it is settled as read, and every reconnect asks for it whole.
 */
export function leaveChat(state: WorkspaceState, chatId: string): WorkspaceState {
  return (state.pendingChatId ?? state.openChatId) === chatId ? clearChatSelection(state) : state
}

/**
 * Threads currently on screen. Unread goes out for each of them, without a second
 * server-side open: a split's other pane is being read even while focus stays put.
 */
export function setViewedChats(state: WorkspaceState, chatIds: readonly string[]): WorkspaceState {
  const viewedChatIds = new Set(chatIds)
  let activity = state.activity
  for (const chatId of viewedChatIds) {
    const current = activity[chatId]
    if (current === undefined || !current.unread) continue
    activity = withActivity(activity, chatId, { ...current, unread: false })
  }
  if (activity === state.activity && sameChatIds(state.viewedChatIds, viewedChatIds)) return state
  return { ...state, viewedChatIds, activity }
}

function sameChatIds(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false
  for (const id of right) {
    if (!left.has(id)) return false
  }
  return true
}

/**
 * A message just left for a chat. It shows immediately and stays until the durable
 * event for it arrives, because the server only writes a user message down when its
 * turn runs: sent into a busy chat, it would otherwise be invisible for as long as
 * the turn ahead of it takes. Chats never opened have no transcript to add to, and
 * their sidebar dot already tells that story.
 */
export function sendingUserMessage(
  state: WorkspaceState,
  chatId: string,
  text: string,
  attachments: { images?: ImageAttachment[]; files?: FileAttachment[]; documents?: DocumentUpload[]; pageContexts?: PageContextAttachment[]; replyTo?: MessageReply; quotes?: InlineQuote[] } = {},
): WorkspaceState {
  const thread = state.threads[chatId]
  if (thread === undefined) return state
  // A command never becomes a message, so it never gets a bubble.
  if (chatCommandOf({ text, ...attachments }) !== undefined) return state
  pendingCounter += 1
  const pending: PendingMessage = {
    key: `pending:${pendingCounter}`,
    text,
    images: attachments.images ?? [],
    files: attachments.files ?? [],
    // Name and type only: the base64 has left with the send and is not kept twice.
    ...(attachments.documents?.length ? { documents: attachments.documents.map(({ name, mime }) => ({ name, mime })) } : {}),
    pageContexts: attachments.pageContexts ?? [],
    ...(attachments.replyTo === undefined ? {} : { replyTo: attachments.replyTo }),
    ...(attachments.quotes?.length ? { quotes: attachments.quotes } : {}),
  }
  return {
    ...state,
    threads: { ...state.threads, [chatId]: { ...thread, pending: [...thread.pending, pending] } },
  }
}

/**
 * Drops the server's last answer. Called whenever the user changes the request
 * it was about, so a stale error never sits next to a field that has moved on.
 * Idempotent, so a keystroke handler can call it on every keystroke for free.
 */
export function clearNotice(state: WorkspaceState): WorkspaceState {
  return state.notice === null ? state : { ...state, notice: null }
}

/**
 * A list_dirs went out. The directory already on screen stays exactly where it
 * is until the answer lands, so descending never blanks the list that was
 * clicked in and nothing jumps under the cursor.
 */
export function askDirs(state: WorkspaceState): WorkspaceState {
  return state.dirs.asking ? state : { ...state, dirs: { ...state.dirs, asking: true } }
}

/**
 * Closing the picker forgets where it stood, so the next one opens at home
 * rather than showing the last walk for a frame before home arrives.
 */
export function forgetDirs(state: WorkspaceState): WorkspaceState {
  const { listing, asking } = state.dirs
  return listing === null && !asking ? state : { ...state, dirs: { listing: null, asking: false } }
}

/**
 * Marks the snapshot request that just left for a thread already on screen. A thread
 * nobody holds yet needs no mark: it has no bubble to lose and already reads as
 * loading, and inventing one here would put an empty transcript in the map for a chat
 * that may never answer.
 */
export function askThread(state: WorkspaceState, chatId: string): WorkspaceState {
  const thread = state.threads[chatId]
  if (thread === undefined || thread.refreshing) return state
  return { ...state, threads: { ...state.threads, [chatId]: { ...thread, refreshing: true } } }
}

/** Asks for a thread nothing will show on the stage; its snapshot must not open it. */
export function askThreadInBackground(state: WorkspaceState, chatId: string): WorkspaceState {
  const asked = askThread(state, chatId)
  if (asked.backgroundThreads.has(chatId)) return asked
  return { ...asked, backgroundThreads: new Set(asked.backgroundThreads).add(chatId) }
}

/**
 * Asks for a subagent's child thread for the Subagents panel. A panel thread, so its
 * snapshot never takes the stage, and held while its parent exists even after the
 * directory stops listing the child.
 */
export function askChildThread(state: WorkspaceState, childId: string, parentId: string): WorkspaceState {
  const asked = askThread(state, childId)
  const held = asked.childThreads[childId] === parentId
  const panel = asked.panelThreads.has(childId)
  if (held && panel) return asked
  return {
    ...asked,
    childThreads: held ? asked.childThreads : { ...asked.childThreads, [childId]: parentId },
    panelThreads: panel ? asked.panelThreads : new Set(asked.panelThreads).add(childId),
  }
}

export function echoChatOverride(
  state: WorkspaceState,
  chatId: string,
  change: OptimisticChatOverride,
): WorkspaceState {
  const thread = state.threads[chatId]
  if (thread === undefined) return state
  const optimisticOverrides = [...thread.optimisticOverrides, change]
  return {
    ...state,
    threads: {
      ...state.threads,
      [chatId]: {
        ...thread,
        optimisticOverrides,
        overrides: withOptimisticOverrides(thread.overrideBase, optimisticOverrides),
      },
    },
  }
}

/** Ack keeps the server echo; a notice falls back to server truth plus later picks. */
export function settleChatOverride(
  state: WorkspaceState,
  chatId: string,
  requestId: string,
): WorkspaceState {
  const thread = state.threads[chatId]
  if (thread === undefined) return state
  const optimisticOverrides = thread.optimisticOverrides.filter(
    (change) => change.requestId !== requestId,
  )
  if (optimisticOverrides.length === thread.optimisticOverrides.length) return state
  return {
    ...state,
    threads: {
      ...state.threads,
      [chatId]: {
        ...thread,
        optimisticOverrides,
        overrides: withOptimisticOverrides(thread.overrideBase, optimisticOverrides),
      },
    },
  }
}
