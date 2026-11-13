import { WebSocket } from 'ws'
import { describe, expect, it, vi } from 'vitest'
import { MAX_SOCKET_BACKLOG_BYTES, sendSocketPayload } from '../src/socketSend.js'
import { BrowserBroker } from '../src/browserBroker.js'

const client = (bufferedAmount = 0) => ({ readyState: WebSocket.OPEN, bufferedAmount, send: vi.fn(), terminate: vi.fn() })

describe('outgoing socket backlog', () => {
  it('keeps two 6 MiB chat snapshots queued on one socket in the same tick', () => {
    const socket = client()
    socket.send.mockImplementation((payload: string) => { socket.bufferedAmount += Buffer.byteLength(payload) })
    const snapshot = JSON.stringify({ type: 'snapshot', events: ['x'.repeat(6 * 1024 * 1024)] })
    sendSocketPayload(socket, snapshot, 'snapshot')
    sendSocketPayload(socket, snapshot, 'snapshot')
    expect(socket.send).toHaveBeenCalledTimes(2)
    expect(socket.terminate).not.toHaveBeenCalled()
  })

  it('bounds browser-host commands and preserves reply identity through the transport wrapper', async () => {
    const broker = new BrowserBroker()
    const socket = client()
    const host = { send: (payload: string) => sendSocketPayload(socket, payload) }
    broker.register(host)
    const request = broker.request('chat', 'browser_snapshot', {}, { id: 'sage', name: 'Sage' })
    const frame = JSON.parse(socket.send.mock.calls[0]![0] as string) as { requestId: string }
    broker.settle(host, { requestId: frame.requestId, ok: true, result: 'snapshot' })
    await expect(request).resolves.toBe('snapshot')
    socket.bufferedAmount = MAX_SOCKET_BACKLOG_BYTES
    socket.terminate.mockImplementation(() => broker.unregister(host))
    const overloaded = broker.request('chat', 'browser_snapshot', {}, { id: 'sage', name: 'Sage' })
    await expect(overloaded).rejects.toThrow('closed before the browser action finished')
    expect(socket.send).toHaveBeenCalledOnce()
    expect(socket.terminate).toHaveBeenCalledOnce()
  })

  it('disconnects only the slow client, including when the next event is terminal', () => {
    const slow = client(MAX_SOCKET_BACKLOG_BYTES)
    const desktop = client()
    const result = JSON.stringify({ type: 'turn_state', state: 'done' })
    for (const socket of [slow, desktop]) sendSocketPayload(socket, result)
    expect(slow.terminate).toHaveBeenCalledOnce()
    expect(slow.send).not.toHaveBeenCalled()
    expect(desktop.send).toHaveBeenCalledWith(result)
    expect(desktop.terminate).not.toHaveBeenCalled()
  })

  it('counts UTF-8 bytes and permits one large recovery snapshot on an empty socket', () => {
    const socket = client(MAX_SOCKET_BACKLOG_BYTES - 2)
    sendSocketPayload(socket, '€')
    expect(socket.terminate).toHaveBeenCalledOnce()
    const fresh = client()
    sendSocketPayload(fresh, 'x'.repeat(MAX_SOCKET_BACKLOG_BYTES + 1))
    expect(fresh.send).toHaveBeenCalledOnce()
    fresh.bufferedAmount = MAX_SOCKET_BACKLOG_BYTES + 1
    sendSocketPayload(fresh, 'next')
    expect(fresh.send).toHaveBeenCalledOnce()
    expect(fresh.terminate).toHaveBeenCalledOnce()
  })
})
