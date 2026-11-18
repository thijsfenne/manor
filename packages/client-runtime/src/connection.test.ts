import type { Chat, ClientMessage, DirectoryMessage, ServerMessage, ThreadEvent } from '@manor/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  OFFLINE_AFTER_MS,
  connectionBackoffMs,
  createWorkspaceConnection,
  openChatRequest,
  parseServerMessage,
  withMediaOrigin,
  type SocketAdapter,
  type SocketFactory,
} from './connection'

class FakeSocket implements SocketAdapter {
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((frame: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  sent: string[] = []

  constructor(readonly url: string) {}

  open() {
    this.readyState = 1
    this.onopen?.()
  }

  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) })
  }

  send(payload: string) {
    this.sent.push(payload)
  }

  close() {
    if (this.readyState === 3) return
    this.readyState = 3
    this.onclose?.()
  }
}

function fakeSockets() {
  const sockets: FakeSocket[] = []
  const factory: SocketFactory = {
    openState: 1,
    create: (url) => {
      const socket = new FakeSocket(url)
      sockets.push(socket)
      return socket
    },
  }
  return { factory, sockets }
}

afterEach(() => vi.useRealTimers())

describe('workspace connection', () => {
  it('sends only while live and forwards validated non-heartbeat messages', () => {
    const { factory, sockets } = fakeSockets()
    const statuses: string[] = []
    const messages: unknown[] = []
    const connection = createWorkspaceConnection({
      url: 'wss://manor.test/ws',
      sockets: factory,
      onStatus: (status) => statuses.push(status),
      onMessage: (message) => messages.push(message),
    })
    const openChat: ClientMessage = { type: 'open_chat', chatId: 'chat-1' }

    expect(connection.send(openChat)).toBe(false)
    sockets[0]?.open()
    expect(connection.send(openChat)).toBe(true)
    sockets[0]?.receive({ type: 'heartbeat' })
    sockets[0]?.receive({ type: 'chat_created', chatId: 'chat-1' })

    expect(statuses).toEqual(['connecting', 'live'])
    expect(sockets[0]?.sent).toEqual([JSON.stringify(openChat)])
    expect(messages).toEqual([{ type: 'chat_created', chatId: 'chat-1' }])
    connection.dispose()
  })

  it('refreshes rejected auth and reconnects with bounded backoff', () => {
    vi.useFakeTimers()
    const { factory, sockets } = fakeSockets()
    const rejected = vi.fn()
    const connection = createWorkspaceConnection({
      url: 'wss://manor.test/ws',
      auth: { getToken: () => 'token', onRejected: rejected },
      sockets: factory,
      onStatus: () => undefined,
      onMessage: () => undefined,
    })

    sockets[0]?.close()
    expect(rejected).toHaveBeenCalledOnce()
    expect(sockets).toHaveLength(1)
    vi.advanceTimersByTime(connectionBackoffMs(0))
    expect(sockets).toHaveLength(2)
    connection.dispose()
  })

  it('tells the caller once when an explicit reconnect drops a live socket', () => {
    const { factory, sockets } = fakeSockets()
    const closed = vi.fn()
    const statuses: string[] = []
    const connection = createWorkspaceConnection({
      url: 'wss://manor.test/ws',
      sockets: factory,
      onStatus: (status) => statuses.push(status),
      onMessage: () => undefined,
      onClose: closed,
    })

    sockets[0]?.open()
    connection.reconnect()
    expect(sockets[0]?.readyState).toBe(3)
    expect(closed).toHaveBeenCalledOnce()
    // Already down: the socket's own close said so, and a reconnect adds nothing.
    sockets[1]?.close()
    connection.reconnect()
    expect(closed).toHaveBeenCalledTimes(2)
    sockets[2]?.open()
    expect(statuses).toEqual(['connecting', 'live', 'connecting', 'live'])
    connection.dispose()
  })

  it('asks only for newer events of a thread this socket was sent whole', () => {
    const { factory, sockets } = fakeSockets()
    const connection = createWorkspaceConnection({ url: 'wss://manor.test/ws', sockets: factory, onStatus: () => undefined, onMessage: () => undefined })
    const thread = { events: [{ id: 'evt_000001' }, { id: 'evt_000002' }] as ThreadEvent[] }

    sockets[0]?.open()
    expect(openChatRequest('chat-1', thread, connection.holds('chat-1'))).toEqual({ type: 'open_chat', chatId: 'chat-1' })
    sockets[0]?.receive({ type: 'snapshot', chatId: 'chat-1', events: [], usage: {} })
    expect(openChatRequest('chat-1', thread, connection.holds('chat-1'))).toEqual({ type: 'open_chat', chatId: 'chat-1', after: 'evt_000002', count: 2 })
    expect(openChatRequest('chat-1', { events: [] }, connection.holds('chat-1'))).toEqual({ type: 'open_chat', chatId: 'chat-1' })
    // A frame this build could not read may have been one of its events.
    sockets[0]?.onmessage?.({ data: '{"type":"event","chatId":"chat-1"}' })
    expect(connection.holds('chat-1')).toBe(false)
    sockets[0]?.receive({ type: 'snapshot', chatId: 'chat-1', events: [], usage: {} })
    // A new socket missed whatever happened while it was down.
    connection.reconnect()
    sockets[1]?.open()
    expect(connection.holds('chat-1')).toBe(false)
    connection.dispose()
  })

  it('keeps the rewrite position of a thread across a reconnect, and drops it with a frame it could not read', () => {
    const { factory, sockets } = fakeSockets()
    const connection = createWorkspaceConnection({ url: 'wss://manor.test/ws', sockets: factory, onStatus: () => undefined, onMessage: () => undefined })
    const thread = { events: [{ id: 'evt_000001' }, { id: 'evt_000002' }] as ThreadEvent[] }
    const sync = { epoch: 'run-1', rev: 3 }
    const request = () => openChatRequest('chat-1', thread, connection.holds('chat-1'), connection.syncOf('chat-1'))

    sockets[0]?.open()
    sockets[0]?.receive({ type: 'snapshot', chatId: 'chat-1', events: [], usage: {}, sync })
    expect(request()).toEqual({ type: 'open_chat', chatId: 'chat-1', after: 'evt_000002', count: 2, sync })
    connection.reconnect()
    sockets[1]?.open()
    expect(connection.holds('chat-1')).toBe(false)
    expect(request()).toEqual({ type: 'open_chat', chatId: 'chat-1', after: 'evt_000002', count: 2, sync })
    // A server that sends no position leaves a copy from before a reconnect unusable, as before.
    sockets[1]?.receive({ type: 'snapshot', chatId: 'chat-1', events: [], usage: {} })
    connection.reconnect()
    sockets[2]?.open()
    expect(request()).toEqual({ type: 'open_chat', chatId: 'chat-1' })
    sockets[2]?.receive({ type: 'snapshot', chatId: 'chat-1', events: [], usage: {}, sync })
    sockets[2]?.onmessage?.({ data: '{"type":"event","chatId":"chat-1"}' })
    expect(connection.syncOf('chat-1')).toBeUndefined()
    connection.dispose()
  })

  // The copy missed events before that broadcast, and the count check alone can match by chance.
  it('drops the position of a thread when a broadcast lands on a copy the new socket was not sent', () => {
    const { factory, sockets } = fakeSockets()
    const connection = createWorkspaceConnection({ url: 'wss://manor.test/ws', sockets: factory, onStatus: () => undefined, onMessage: () => undefined })
    const sync = { epoch: 'run-1', rev: 3 }
    const said = { type: 'event', chatId: 'chat-1', event: { id: 'evt_000005', ts: 5, type: 'user_message', text: 'later', mentions: [] } } as const

    sockets[0]?.open()
    sockets[0]?.receive({ type: 'snapshot', chatId: 'chat-1', events: [], usage: {}, sync })
    sockets[0]?.receive(said)
    expect(connection.syncOf('chat-1')).toEqual(sync)
    connection.reconnect()
    sockets[1]?.open()
    expect(connection.syncOf('chat-1')).toEqual(sync)
    sockets[1]?.receive(said)
    expect(connection.syncOf('chat-1')).toBeUndefined()
    connection.dispose()
  })

  it('rebuilds each directory patch into a whole directory that keeps unchanged chats', () => {
    const { factory, sockets } = fakeSockets()
    const messages: ServerMessage[] = []
    const invalid = vi.fn()
    const connection = createWorkspaceConnection({
      url: 'wss://manor.test/ws',
      auth: { getToken: () => 'token' },
      sockets: factory,
      onStatus: () => undefined,
      onMessage: (message) => messages.push(message),
      onInvalidMessage: invalid,
    })
    const chat = (id: string, title = id): Chat => ({
      id, projectId: null, kind: 'dm', routineId: null, parentChatId: null, sideModel: null, sideEffort: null,
      memberIds: [], agentIds: [], title, createdAt: 1, lastMessageAt: 1, lastMessagePreview: null,
      settledAt: null, archivedAt: null, checkout: { mode: 'current', branch: null },
    })
    const patch = { type: 'directory_patch', projects: { changed: [] }, chats: { changed: [chat('b', 'Renamed')] }, workHandoffs: { changed: [] } }

    expect(new URL(sockets[0]!.url).searchParams.get('directory')).toBe('patch')
    expect(new URL(sockets[0]!.url).searchParams.get('token')).toBe('token')
    sockets[0]?.open()
    sockets[0]?.receive({ type: 'directory', projects: [], chats: [chat('a'), chat('b')], workHandoffs: [] })
    sockets[0]?.receive(patch)
    const [first, second] = messages as DirectoryMessage[]
    expect(second).toEqual({ type: 'directory', projects: [], chats: [chat('a'), chat('b', 'Renamed')], workHandoffs: [] })
    expect(second?.chats[0]).toBe(first?.chats[0])
    expect(second?.projects).toBe(first?.projects)
    // A new socket holds no listing yet, so a patch on it cannot be applied.
    connection.reconnect()
    sockets[1]?.open()
    sockets[1]?.receive(patch)
    expect(messages).toHaveLength(2)
    expect(invalid).toHaveBeenCalledOnce()
    connection.dispose()
  })

  it('lets a silent socket go after forty-five seconds without waiting for its close event', () => {
    vi.useFakeTimers()
    const { factory, sockets } = fakeSockets()
    const closed = vi.fn()
    const statuses: string[] = []
    const connection = createWorkspaceConnection({
      url: 'wss://manor.test/ws',
      sockets: factory,
      onStatus: (status) => statuses.push(status),
      onMessage: () => undefined,
      onClose: closed,
    })

    sockets[0]?.open()
    // A peer that is gone: closing it never reports back, until long after.
    const lateClose = sockets[0]!.close.bind(sockets[0])
    const close = vi.fn()
    sockets[0]!.close = close
    vi.advanceTimersByTime(44_999)
    sockets[0]?.receive({ type: 'heartbeat' })
    vi.advanceTimersByTime(44_999)
    expect(closed).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(closed).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
    expect(connection.send({ type: 'open_chat', chatId: 'chat-1' })).toBe(false)
    vi.advanceTimersByTime(connectionBackoffMs(0))
    expect(sockets).toHaveLength(2)
    sockets[1]?.open()
    lateClose()
    vi.advanceTimersByTime(OFFLINE_AFTER_MS)
    expect(closed).toHaveBeenCalledOnce()
    expect(sockets).toHaveLength(2)
    expect(statuses).toEqual(['connecting', 'live', 'connecting', 'live'])
    connection.dispose()
  })

  it('abandons an attempt that has not opened after ten seconds and tries again, without a refresh', () => {
    vi.useFakeTimers()
    const { factory, sockets } = fakeSockets()
    const rejected = vi.fn()
    const connection = createWorkspaceConnection({ url: 'wss://manor.test/ws', auth: { getToken: () => 'token', onRejected: rejected }, sockets: factory, onStatus: () => undefined, onMessage: () => undefined })

    sockets[0]!.close = () => undefined
    vi.advanceTimersByTime(9_999)
    expect(sockets).toHaveLength(1)
    vi.advanceTimersByTime(1 + connectionBackoffMs(0))
    expect(sockets).toHaveLength(2)
    expect(rejected).not.toHaveBeenCalled()
    // A late open from the abandoned attempt changes nothing.
    sockets[0]?.open()
    expect(connection.send({ type: 'open_chat', chatId: 'chat-1' })).toBe(false)
    connection.dispose()
  })

  it('reads a server restart as connecting, never offline', () => {
    vi.useFakeTimers()
    const { factory, sockets } = fakeSockets()
    const statuses: string[] = []
    const connection = createWorkspaceConnection({ url: 'wss://manor.test/ws', sockets: factory, onStatus: (status) => statuses.push(status), onMessage: () => undefined })

    sockets[0]?.open()
    sockets[0]?.close()
    // Refused while the server starts: 0.5 s, 1 s and 2 s later.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      vi.advanceTimersByTime(connectionBackoffMs(attempt))
      sockets.at(-1)?.close()
    }
    vi.advanceTimersByTime(connectionBackoffMs(3))
    sockets.at(-1)?.open()
    vi.advanceTimersByTime(OFFLINE_AFTER_MS)
    expect(statuses).toEqual(['connecting', 'live', 'connecting', 'live'])
    connection.dispose()
  })

  it('shows a real outage as offline once and keeps retrying at most five seconds apart', () => {
    vi.useFakeTimers()
    const { factory, sockets } = fakeSockets()
    const statuses: string[] = []
    const connection = createWorkspaceConnection({ url: 'wss://manor.test/ws', sockets: factory, onStatus: (status) => statuses.push(status), onMessage: () => undefined })

    sockets[0]?.open()
    sockets[0]?.close()
    for (let attempt = 0; attempt < 4; attempt += 1) {
      vi.advanceTimersByTime(connectionBackoffMs(attempt))
      sockets.at(-1)?.close()
    }
    // 7.5 s down so far.
    vi.advanceTimersByTime(OFFLINE_AFTER_MS - 7_501)
    expect(statuses.at(-1)).toBe('connecting')
    vi.advanceTimersByTime(1)
    expect(statuses.at(-1)).toBe('offline')
    for (let attempt = 4; attempt < 12; attempt += 1) {
      vi.advanceTimersByTime(connectionBackoffMs(attempt))
      sockets.at(-1)?.close()
    }
    expect(connectionBackoffMs(12)).toBe(5_000)
    expect(statuses).toEqual(['connecting', 'live', 'connecting', 'offline'])
    vi.advanceTimersByTime(5_000)
    sockets.at(-1)?.open()
    expect(statuses).toEqual(['connecting', 'live', 'connecting', 'offline', 'live'])
    connection.dispose()
  })

  it('waits for a token that is still being refreshed, and drops one a newer attempt overtook', async () => {
    const { factory, sockets } = fakeSockets()
    const pending: ((token: string) => void)[] = []
    const connection = createWorkspaceConnection({
      url: 'wss://manor.test/ws',
      auth: { getToken: () => new Promise<string>((resolve) => { pending.push(resolve) }) },
      sockets: factory,
      onStatus: () => undefined,
      onMessage: () => undefined,
    })

    expect(sockets).toHaveLength(0)
    connection.reconnect()
    pending[1]?.('fresh')
    pending[0]?.('stale')
    await Promise.resolve()
    expect(sockets.map((socket) => new URL(socket.url).searchParams.get('token'))).toEqual(['fresh'])
    connection.reconnect()
    connection.dispose()
    pending[2]?.('after dispose')
    await Promise.resolve()
    expect(sockets).toHaveLength(1)
  })

  it('tries again when a token never arrives', () => {
    vi.useFakeTimers()
    const { factory, sockets } = fakeSockets()
    const asked = vi.fn(() => new Promise<string>(() => undefined))
    const connection = createWorkspaceConnection({ url: 'wss://manor.test/ws', auth: { getToken: asked }, sockets: factory, onStatus: () => undefined, onMessage: () => undefined })

    vi.advanceTimersByTime(10_000 + connectionBackoffMs(0))
    expect(asked).toHaveBeenCalledTimes(2)
    expect(sockets).toHaveLength(0)
    connection.dispose()
  })
})

describe('withMediaOrigin', () => {
  it('points stored image links at the server behind the socket and leaves data URLs alone', () => {
    const snapshot = withMediaOrigin({
      type: 'snapshot',
      chatId: 'c',
      usage: {},
      events: [
        { id: 'evt_000001', ts: 1, type: 'user_message', text: '', mentions: [], images: [{ name: 'a.png', src: '/media/c/evt_000001/0/sig', width: 2, height: 1 }], documents: [{ id: 'd', name: 'brief.pdf', mime: 'application/pdf', size: 4, extraction: { status: 'complete' }, text: '', src: '/media/c/evt_000001/d0/sig' }] },
        { id: 'evt_000002', ts: 2, type: 'agent_message', agentId: 'a', turnId: 't', text: '', images: [{ name: 'b.png', dataUrl: 'data:image/png;base64,AAAA' }] },
        { id: 'evt_000003', ts: 3, type: 'file_delivery', agentId: 'a', turnId: 't', file: { id: 'f', name: 'q3.xlsx', mime: 'application/zip', size: 4, src: '/media/c/evt_000003/f0/sig' } },
      ],
    }, 'wss://manor.example.ts.net/ws?token=secret')
    if (snapshot.type !== 'snapshot') throw new Error('not a snapshot')
    const [linked, inline, delivered] = snapshot.events
    expect(delivered?.type === 'file_delivery' && delivered.file.src).toBe('https://manor.example.ts.net/media/c/evt_000003/f0/sig')
    expect(linked?.type === 'user_message' && linked.images?.[0]?.src).toBe('https://manor.example.ts.net/media/c/evt_000001/0/sig')
    expect(linked?.type === 'user_message' && linked.documents?.[0]?.src).toBe('https://manor.example.ts.net/media/c/evt_000001/d0/sig')
    expect(inline?.type === 'agent_message' && inline.images?.[0]?.dataUrl).toBe('data:image/png;base64,AAAA')
  })

  it('points a result\'s screenshots in the directory at the same server', () => {
    const report = { result: 'Done.', evidence: [{ id: 'evidence_1', name: 'card.png', src: '/media/w/evidence_1/e/sig' }] }
    // Only the fields the link rewrite reads; the rest of a directory passes through as is.
    const message = { type: 'directory', workHandoffs: [{ id: 'h', goalReport: report }] } as unknown as ServerMessage
    const directory = withMediaOrigin(message, 'ws://127.0.0.1:43180/ws')
    if (directory.type !== 'directory') throw new Error('not a directory')
    expect(directory.workHandoffs[0]?.goalReport?.evidence?.[0]?.src).toBe('http://127.0.0.1:43180/media/w/evidence_1/e/sig')
    const patch = withMediaOrigin({ type: 'directory_patch', workHandoffs: { changed: [{ id: 'h', goalReport: report }] } } as unknown as ServerMessage, 'ws://127.0.0.1:43180/ws')
    if (patch.type !== 'directory_patch') throw new Error('not a directory patch')
    expect(patch.workHandoffs.changed[0]?.goalReport?.evidence?.[0]?.src).toBe('http://127.0.0.1:43180/media/w/evidence_1/e/sig')
  })
})

describe('parseServerMessage', () => {
  // 09-28: an older phone refused one unknown `file_delivery` event and dropped the
  // whole snapshot, so the chat stayed on "Gesprek laden…".
  it('keeps a snapshot whose only fault is an event type this build does not know', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const known = { id: 'evt_000001', ts: 1, type: 'user_message', text: 'hi', mentions: [] }
    const future = { id: 'evt_000002', ts: 2, type: 'event_from_a_newer_server', agentId: 'a' }
    const snapshot = { type: 'snapshot', chatId: 'c', usage: {}, events: [known, future] }
    const parsed = parseServerMessage(JSON.stringify(snapshot))
    expect(parsed?.type === 'snapshot' && parsed.events.map((event) => event.id)).toEqual(['evt_000001'])
    expect(parseServerMessage(JSON.stringify({ ...snapshot, chatId: 7 }))).toBeNull()
  })
})
