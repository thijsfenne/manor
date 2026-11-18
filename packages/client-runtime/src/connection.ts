import { observeOutboundDraftEdits } from './outboundDraftEdits'
import { setHostAuto } from './runtimeChoices'
import {
  ServerMessageSchema,
  ThreadEventSchema,
  applyDirectoryPatch,
  type ClientMessage,
  type DirectoryMessage,
  type EventSync,
  type ServerMessage,
  type ThreadEvent,
  type WorkHandoff,
} from '@manor/contracts'

export type ConnectionStatus = 'connecting' | 'live' | 'offline'

export interface ConnectionAuth {
  /**
   * Read before every attempt. The phone answers with a promise that refreshes an
   * expired token first, so a return after the token's hour does not open with a
   * token the server is bound to refuse.
   */
  getToken: () => string | null | Promise<string | null>
  onRejected?: () => void
}

export interface SocketFrame {
  data: unknown
}

export interface SocketAdapter {
  readonly readyState: number
  onopen: (() => void) | null
  onmessage: ((frame: SocketFrame) => void) | null
  onclose: (() => void) | null
  send(payload: string): void
  close(): void
}

export interface SocketFactory {
  readonly openState: number
  create(url: string): SocketAdapter
}

export interface WorkspaceConnection {
  send(message: ClientMessage): boolean
  /**
   * Whether this socket was sent the chat whole and every frame since. The server
   * broadcasts every chat's events to every client, so such a copy is current and a
   * reopen asks only for what follows it (`openChatRequest`).
   */
  holds(chatId: string): boolean
  /**
   * The rewrite position of the last snapshot this connection was sent for the chat.
   * It outlives a reconnect: with it a copy that missed frames can still ask for what
   * follows, because the server then also names what was rewritten meanwhile.
   */
  syncOf(chatId: string): EventSync | undefined
  reconnect(): void
  dispose(): void
}

export interface WorkspaceConnectionOptions {
  url: string
  auth?: ConnectionAuth
  sockets: SocketFactory
  onStatus(status: ConnectionStatus): void
  onMessage(message: ServerMessage): void
  onOpen?(): void
  onClose?(): void
  onInvalidMessage?(raw: string): void
}

const FIRST_RETRY_MS = 500
/** Low enough that a Mac server back from a restart is found within seconds. */
const MAX_RETRY_MS = 5_000
const SILENCE_MS = 45_000
/** An attempt that has not opened by now is abandoned rather than left to the OS's connect timeout. */
const OPEN_TIMEOUT_MS = 10_000
/**
 * How long a lost connection reads as connecting before it reads as offline. A server
 * restart or a phone back from the background reconnects well inside it; an outage
 * outlasts it and still shows.
 */
export const OFFLINE_AFTER_MS = 10_000

export const connectionBackoffMs = (attempt: number): number =>
  Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** attempt)

/**
 * Asks the server for each directory after the first as a patch. Web and the phone
 * both open their socket here, so they opt in together; a build from before this
 * keeps getting whole listings.
 */
function socketUrl(url: string, token: string | null): string {
  const target = new URL(url)
  if (token !== null && token !== '') target.searchParams.set('token', token)
  target.searchParams.set('directory', 'patch')
  return target.toString()
}

/**
 * A phone build lags the server, so a snapshot can carry an event type it does not
 * know yet. Refusing the whole snapshot left a chat stuck on loading with no error
 * (08-27 produce side, 09-28 phone). A snapshot that fails only on some events keeps
 * every event that parses and drops the rest; anything else still fails whole.
 */
export function parseServerMessage(raw: string): ServerMessage | null {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return null
  }
  const parsed = ServerMessageSchema.safeParse(json)
  if (parsed.success) {
    // Here, because web and phone both read every frame through this one function.
    if (parsed.data.type === 'host_capabilities') setHostAuto(parsed.data.auto !== false)
    return parsed.data
  }
  if (!isRecord(json) || json.type !== 'snapshot' || !Array.isArray(json.events)) return null
  const readable = (event: unknown) => ThreadEventSchema.safeParse(event).success
  const events = json.events.filter(readable)
  const replaced = Array.isArray(json.replaced) ? json.replaced.filter(readable) : undefined
  const dropped = json.events.length - events.length + (Array.isArray(json.replaced) ? json.replaced.length - (replaced?.length ?? 0) : 0)
  if (dropped === 0) return null
  console.warn(`[manor] dropped ${dropped} unreadable events from a snapshot`)
  const retry = ServerMessageSchema.safeParse({ ...json, events, ...(replaced === undefined ? {} : { replaced }) })
  return retry.success ? retry.data : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The server links stored images by path on its own origin. Web in Electron loads
 * from a file URL and the phone from anywhere, so the link is made absolute against
 * the socket's server before any surface sees it.
 */
export function withMediaOrigin(message: ServerMessage, socketUrl: string): ServerMessage {
  const handoffs = message.type === 'directory' ? message.workHandoffs : message.type === 'directory_patch' ? message.workHandoffs.changed : []
  const linked = handoffs.some((handoff) => handoff.goalReport?.evidence !== undefined)
  if (message.type !== 'snapshot' && message.type !== 'event' && !linked) return message
  const origin = new URL(socketUrl)
  origin.protocol = origin.protocol === 'wss:' ? 'https:' : origin.protocol === 'ws:' ? 'http:' : origin.protocol
  const absolute = <T extends { src?: string }>(media: T): T =>
    media.src?.startsWith('/') === true ? { ...media, src: new URL(media.src, origin).toString() } : media
  // A result's screenshots ride on its handoff in the directory, not on an event.
  const linkHandoff = (handoff: WorkHandoff): WorkHandoff => handoff.goalReport?.evidence === undefined ? handoff : {
    ...handoff, goalReport: { ...handoff.goalReport, evidence: handoff.goalReport.evidence.map(absolute) },
  }
  if (message.type === 'directory') return { ...message, workHandoffs: message.workHandoffs.map(linkHandoff) }
  if (message.type === 'directory_patch') {
    return { ...message, workHandoffs: { ...message.workHandoffs, changed: message.workHandoffs.changed.map(linkHandoff) } }
  }
  if (message.type !== 'snapshot' && message.type !== 'event') return message
  const resolve = (event: ThreadEvent): ThreadEvent => {
    if (event.type === 'file_delivery') return { ...event, file: absolute(event.file) }
    if (event.type !== 'user_message' && event.type !== 'agent_message') return event
    const images = event.images?.some((image) => image.src !== undefined) === true ? event.images.map(absolute) : event.images
    const documents = event.type === 'user_message' && event.documents?.some((document) => document.src !== undefined) === true
      ? event.documents.map(absolute)
      : undefined
    if (images === event.images && documents === undefined) return event
    return { ...event, ...(images === undefined ? {} : { images }), ...(documents === undefined ? {} : { documents }) }
  }
  return message.type === 'snapshot'
    ? { ...message, events: message.events.map(resolve) }
    : { ...message, event: resolve(message.event) }
}

/**
 * Opens a chat. A thread the socket already holds asks only for the events after its
 * last. So does a copy from before a reconnect, when it knows its rewrite position
 * (`sync`); without one such a copy cannot be trusted and the whole thread is asked for.
 */
export function openChatRequest(chatId: string, thread: { events: readonly ThreadEvent[] } | undefined, held: boolean, sync?: EventSync): ClientMessage {
  const after = held || sync !== undefined ? thread?.events[thread.events.length - 1]?.id : undefined
  if (after === undefined || thread === undefined) return { type: 'open_chat', chatId }
  return { type: 'open_chat', chatId, after, count: thread.events.length, ...(sync === undefined ? {} : { sync }) }
}

/**
 * Owns one resilient Manor WebSocket connection. UI adapters receive validated
 * messages and status changes while retry, auth, silence detection and stale socket
 * races stay private to this Module.
 */
export function createWorkspaceConnection(options: WorkspaceConnectionOptions): WorkspaceConnection {
  let disposed = false
  let attempt = 0
  // Bumped by every attempt, so a token that arrives after a newer attempt or a
  // dispose opens nothing.
  let generation = 0
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let watchdog: ReturnType<typeof setTimeout> | undefined
  let offlineTimer: ReturnType<typeof setTimeout> | undefined
  let shown: ConnectionStatus | undefined
  let activeSocket: SocketAdapter | null = null
  const held = new Set<string>()
  // Not cleared with the socket: a position is what makes a copy from before a reconnect usable.
  const synced = new Map<string, EventSync>()

  const show = (status: ConnectionStatus) => {
    if (status === shown) return
    shown = status
    options.onStatus(status)
  }
  // Not live: connecting for a grace period, then offline until a socket opens. Once
  // offline, a retry does not flip back to connecting, so an outage reads steadily.
  const notLive = () => {
    if (shown === 'offline' || offlineTimer !== undefined) return
    show('connecting')
    offlineTimer = setTimeout(() => {
      offlineTimer = undefined
      show('offline')
    }, OFFLINE_AFTER_MS)
  }
  const retryLater = () => {
    clearTimeout(retryTimer)
    retryTimer = setTimeout(open, connectionBackoffMs(attempt))
    attempt += 1
  }

  const open = () => {
    if (disposed) return
    const run = ++generation
    notLive()
    let token: string | null | Promise<string | null> = null
    try {
      token = options.auth?.getToken() ?? null
    } catch { /* No token is still an attempt; the server's refusal asks for a refresh. */ }
    if (!(token instanceof Promise)) {
      connect(token)
      return
    }
    // A token that never comes would leave no attempt and no retry; it counts toward the open timeout.
    const late = setTimeout(() => {
      if (run !== generation || disposed) return
      generation += 1
      retryLater()
    }, OPEN_TIMEOUT_MS)
    const settle = (value: string | null) => {
      clearTimeout(late)
      if (run === generation && !disposed) connect(value)
    }
    token.then(settle, () => settle(null))
  }

  const connect = (token: string | null) => {
    let opened = false
    let socket: SocketAdapter
    try {
      socket = options.sockets.create(socketUrl(options.url, token))
    } catch {
      retryLater()
      return
    }
    activeSocket = socket

    // The last whole listing this socket delivered. The server patches against it, and
    // the listing a patch rebuilds goes on as an ordinary `directory`. A patch with no
    // listing under it cannot be read, like any other frame outside the contract.
    let directory: DirectoryMessage | undefined
    const wholeDirectory = (message: ServerMessage): ServerMessage | null => {
      if (message.type === 'directory_patch') {
        if (directory === undefined) return null
        directory = applyDirectoryPatch(directory, message)
        return directory
      }
      if (message.type === 'directory') directory = message
      return message
    }

    // The retry is set before callers hear of the loss, so a reconnect or dispose they
    // run in `onClose` cancels it.
    const lost = (refused: boolean) => {
      activeSocket = null
      clearTimeout(watchdog)
      watchdog = undefined
      retryLater()
      notLive()
      // A socket closed before it opened may be a refused handshake. One that timed out is not.
      if (refused && !opened) options.auth?.onRejected?.()
      options.onClose?.()
    }

    // A socket that has gone quiet is let go at once rather than on its close event:
    // closing a connection whose peer is gone can wait on the network's own timeout,
    // and meanwhile the connection would still claim to be live.
    const giveUp = () => {
      if (disposed || activeSocket !== socket) return
      lost(false)
      socket.close()
    }
    const heard = () => {
      clearTimeout(watchdog)
      if (disposed || activeSocket !== socket) return
      watchdog = setTimeout(giveUp, SILENCE_MS)
    }
    watchdog = setTimeout(giveUp, OPEN_TIMEOUT_MS)

    socket.onopen = () => {
      if (disposed || activeSocket !== socket) return
      opened = true
      attempt = 0
      held.clear()
      heard()
      clearTimeout(offlineTimer)
      offlineTimer = undefined
      show('live')
      options.onOpen?.()
    }

    socket.onmessage = (frame) => {
      if (disposed || activeSocket !== socket || typeof frame.data !== 'string') return
      heard()
      const parsed = parseServerMessage(frame.data)
      const message = parsed === null ? null : wholeDirectory(withMediaOrigin(parsed, options.url))
      if (message === null) {
        // It may have been some chat's event, so no copy can be trusted to be whole.
        held.clear()
        synced.clear()
        options.onInvalidMessage?.(frame.data)
        return
      }
      if (message.type === 'snapshot') {
        held.add(message.chatId)
        if (message.sync === undefined) synced.delete(message.chatId)
        else synced.set(message.chatId, message.sync)
      }
      // A broadcast for a chat this socket did not send whole lands on a copy that may
      // have missed events before it. Its position no longer describes that copy.
      if (message.type === 'event' && !held.has(message.chatId)) synced.delete(message.chatId)
      observeOutboundDraftEdits(message)
      if (message.type !== 'heartbeat') options.onMessage(message)
    }

    socket.onclose = () => {
      if (disposed || activeSocket !== socket) return
      lost(true)
    }
  }

  const connection: WorkspaceConnection = {
    send(message) {
      const socket = activeSocket
      if (socket === null || socket.readyState !== options.sockets.openState) return false
      socket.send(JSON.stringify(message))
      return true
    },
    holds: (chatId) => activeSocket !== null && held.has(chatId),
    syncOf: (chatId) => synced.get(chatId),
    reconnect() {
      if (disposed) return
      clearTimeout(retryTimer)
      clearTimeout(watchdog)
      watchdog = undefined
      const socket = activeSocket
      activeSocket = null
      socket?.close()
      // The guarded onclose above stays silent for a socket dropped here, yet every
      // answer it still owed is just as lost, so callers hear about it the same way.
      if (socket !== null) options.onClose?.()
      open()
    },
    dispose() {
      if (disposed) return
      disposed = true
      clearTimeout(retryTimer)
      clearTimeout(watchdog)
      clearTimeout(offlineTimer)
      const socket = activeSocket
      activeSocket = null
      socket?.close()
    },
  }

  open()
  return connection
}
