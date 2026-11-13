import { WebSocket } from 'ws'

export const MAX_SOCKET_BACKLOG_BYTES = 8 * 1024 * 1024

/** Snapshots can be large; live frames still disconnect a client that cannot drain. */
export function sendSocketPayload(
  socket: Pick<WebSocket, 'readyState' | 'bufferedAmount' | 'send' | 'terminate'>,
  payload: string,
  kind: 'frame' | 'snapshot' = 'frame',
): void {
  if (socket.readyState !== WebSocket.OPEN) return
  if (kind !== 'snapshot' && socket.bufferedAmount > 0 && socket.bufferedAmount + Buffer.byteLength(payload) > MAX_SOCKET_BACKLOG_BYTES) {
    // terminate frees the queued bytes immediately. The normal reconnect requests
    // a snapshot; it does not replay user actions or hold up other clients.
    socket.terminate()
    return
  }
  socket.send(payload)
}
