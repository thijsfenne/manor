import { emptyThread, type LiveMessage, type LiveTurn, type ThreadState } from './threadState'
import { emptyWorkspace, type WorkspaceState } from './workspaceState'

/**
 * The quiet view is the workspace as everything except the streamed text sees it. A
 * delta only grows the `text` of a live message, so a reader of the quiet view keeps
 * its value, and its render, through a whole reply. It moves only on a structural
 * change: a message starting or first writing, a turn starting, ending or waiting, a
 * context reading, an event, any other workspace slice.
 *
 * The text is stripped, not ignored, so a quiet reader cannot show a stale reply. The
 * transcript, the side chat and the subagent panel read the live thread instead.
 */
export interface QuietLiveMessage extends Omit<LiveMessage, 'text'> {
  /** The message has text: the turn reads "Writing" rather than "Thinking" from it. */
  written: boolean
}
export interface QuietLiveTurn extends Omit<LiveTurn, 'messages'> {
  messages: readonly QuietLiveMessage[]
}
export interface QuietThread extends Omit<ThreadState, 'liveTurns'> {
  liveTurns: readonly QuietLiveTurn[]
}
export interface QuietWorkspace extends Omit<WorkspaceState, 'threads'> {
  threads: Readonly<Record<string, QuietThread>>
}

/** Either view. Selectors and row builders that never read streamed text take these. */
export type LiveTurnShape = LiveTurn | QuietLiveTurn
export interface ThreadShape extends Omit<ThreadState, 'liveTurns'> {
  liveTurns: readonly LiveTurnShape[]
}
export interface WorkspaceShape extends Omit<WorkspaceState, 'threads'> {
  threads: Readonly<Record<string, ThreadShape>>
}

export function messageWritten(message: LiveMessage | QuietLiveMessage): boolean {
  return 'text' in message ? message.text.length > 0 : message.written
}

/** Whether a live turn has started writing its reply. */
export function liveWritten(turn: LiveTurnShape | undefined): boolean {
  return turn?.messages.some(messageWritten) === true
}

const NO_MESSAGES: readonly LiveMessage[] = Object.freeze([])

/** A live turn's messages with their text, in order. A quiet turn has none to show. */
export function streamedMessages(turn: LiveTurnShape | undefined): readonly LiveMessage[] {
  if (turn === undefined || turn.messages.length === 0) return NO_MESSAGES
  const messages: readonly (LiveMessage | QuietLiveMessage)[] = turn.messages
  return messages.every((message) => 'text' in message) ? messages as readonly LiveMessage[] : NO_MESSAGES
}

/** How many own keys an object has, counted without building the key array. */
function keyCount(value: object): number {
  let count = 0
  for (const _key in value) count += 1
  return count
}

/** Same keys, every value identical except `skip`. Runs on every text frame, so it allocates nothing. */
function sameExcept<T extends object>(previous: T, next: T, skip: keyof T): boolean {
  if (previous === next) return true
  let count = 0
  for (const key in next) {
    count += 1
    if (key !== skip && previous[key] !== next[key]) return false
  }
  return count === keyCount(previous)
}

function sameMessage(previous: LiveMessage, next: LiveMessage): boolean {
  return sameExcept(previous, next, 'text') && messageWritten(previous) === messageWritten(next)
}

function sameTurn(previous: LiveTurn, next: LiveTurn): boolean {
  if (previous === next) return true
  if (!sameExcept(previous, next, 'messages') || previous.messages.length !== next.messages.length) return false
  return next.messages.every((message, index) => sameMessage(previous.messages[index]!, message))
}

/**
 * Whether two live threads differ only by text streamed into messages that already
 * had some. Compared through the same fields `quietThread` strips, so the two cannot
 * drift apart.
 */
export function sameThreadStructure(previous: ThreadState, next: ThreadState): boolean {
  if (previous === next) return true
  if (!sameExcept(previous, next, 'liveTurns')) return false
  if (previous.liveTurns === next.liveTurns) return true
  if (previous.liveTurns.length !== next.liveTurns.length) return false
  return next.liveTurns.every((turn, index) => sameTurn(previous.liveTurns[index]!, turn))
}

// Stripped once each, so a live turn nothing touched keeps its quiet identity too.
const quietTurns = new WeakMap<LiveTurn, QuietLiveTurn>()
const NO_QUIET_TURNS: readonly QuietLiveTurn[] = Object.freeze([])

function quietTurn(turn: LiveTurn): QuietLiveTurn {
  let quiet = quietTurns.get(turn)
  if (quiet === undefined) {
    const { messages, ...rest } = turn
    quiet = { ...rest, messages: messages.map(({ text, ...message }) => ({ ...message, written: text.length > 0 })) }
    quietTurns.set(turn, quiet)
  }
  return quiet
}

export function quietThread(thread: ThreadState): QuietThread {
  return { ...thread, liveTurns: thread.liveTurns.length === 0 ? NO_QUIET_TURNS : thread.liveTurns.map(quietTurn) }
}

/**
 * A selector that holds its previous quiet workspace while only streamed text moved,
 * in any thread. It compares before it builds, so a text frame allocates nothing.
 */
export function createQuietWorkspace(): (live: WorkspaceState) => QuietWorkspace {
  let lastLive: WorkspaceState | null = null
  let lastQuiet: QuietWorkspace | null = null
  return (live) => {
    const before = lastLive
    const beforeQuiet = lastQuiet
    if (before === live && beforeQuiet !== null) return beforeQuiet
    const threads = before === null || beforeQuiet === null
      ? quietThreads(live.threads)
      : live.threads === before.threads || !threadsMoved(before.threads, live.threads)
        ? beforeQuiet.threads
        : quietThreads(live.threads, before.threads, beforeQuiet.threads)
    const quiet = before !== null && beforeQuiet !== null && threads === beforeQuiet.threads && sameExcept(before, live, 'threads')
      ? beforeQuiet
      : { ...live, threads }
    lastLive = live
    lastQuiet = quiet
    return quiet
  }
}

/** Whether any thread was added, dropped or changed beyond its streamed text. */
function threadsMoved(before: WorkspaceState['threads'], after: WorkspaceState['threads']): boolean {
  let count = 0
  for (const id in after) {
    count += 1
    const old = before[id]
    if (old === undefined || !sameThreadStructure(old, after[id]!)) return true
  }
  return count !== keyCount(before)
}

/** Every thread's quiet view, reusing the previous one where only its text moved. */
function quietThreads(
  live: WorkspaceState['threads'],
  before?: WorkspaceState['threads'],
  beforeQuiet?: QuietWorkspace['threads'],
): Record<string, QuietThread> {
  const threads: Record<string, QuietThread> = {}
  for (const id in live) {
    const thread = live[id]!
    const old = before?.[id]
    const oldQuiet = beforeQuiet?.[id]
    threads[id] = old !== undefined && oldQuiet !== undefined && sameThreadStructure(old, thread) ? oldQuiet : quietThread(thread)
  }
  return threads
}

/**
 * The workspace outside React. `update` applies a change at once; React reads the
 * quiet view, which keeps its identity through text frames, and only the components
 * that draw streamed text read `get()`.
 */
export interface WorkspaceStore {
  get(): WorkspaceState
  quiet(): QuietWorkspace
  update(change: (state: WorkspaceState) => WorkspaceState): void
  subscribe(listener: () => void): () => void
}

/** What a live reader needs: the state as it is, and a call when it moves. */
export type LiveWorkspace = Pick<WorkspaceStore, 'get' | 'subscribe'>

/** A live reader with no store behind it: the empty workspace, which never moves. */
export const NO_LIVE_WORKSPACE: LiveWorkspace = { get: () => emptyWorkspace, subscribe: () => () => {} }

/**
 * One chat's thread with its streamed text, as a store snapshot. It keeps its identity
 * until that chat moves, so a reader renders on the text frames of its own chat alone.
 */
export function liveThreadOf(live: LiveWorkspace, chatId: string | null): ThreadState {
  return (chatId === null ? undefined : live.get().threads[chatId]) ?? emptyThread
}

export function createWorkspaceStore(initial: WorkspaceState): WorkspaceStore {
  const toQuiet = createQuietWorkspace()
  let state = initial
  let quiet = toQuiet(initial)
  const listeners = new Set<() => void>()
  return {
    get: () => state,
    quiet: () => quiet,
    update(change) {
      const next = change(state)
      if (next === state) return
      state = next
      quiet = toQuiet(next)
      for (const listener of [...listeners]) listener()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
