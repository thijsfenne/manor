import { useCallback, useEffect, useRef, useState } from 'react'
import type { ServerMessage } from '@manor/contracts'

export type RequestResponse =
  | Extract<ServerMessage, { type: 'ack' }>
  | (Extract<ServerMessage, { type: 'project_memory' }> & { requestId: string })
  | (Extract<ServerMessage, { type: 'chat_summary' }> & { requestId: string })
  | (Extract<ServerMessage, { type: 'notice' }> & { requestId: string })
  | Extract<ServerMessage, { type: 'search_results' }>
  | (Extract<ServerMessage, { type: 'project_created' }> & { requestId: string })

export interface RequestEvents {
  subscribe: (listener: (response: RequestResponse) => void) => () => void
}

interface RequestCallbacks {
  onAck?: () => void
  onNotice?: (notice: Extract<ServerMessage, { type: 'notice' }>) => void
}

interface PendingRequest extends RequestCallbacks {
  requestId: string
}

export const requestOutcome = (
  requestId: string,
  response: RequestResponse,
): 'ack' | 'notice' | null =>
  response.requestId === requestId && (response.type === 'ack' || response.type === 'notice')
    ? response.type
    : null

/**
 * Owns one UI request from send through its explicit server answer. Broadcast state
 * still updates the view, but it no longer doubles as the completion signal.
 */
export function useRequest(events: RequestEvents) {
  const current = useRef<PendingRequest | null>(null)
  const [pending, setPending] = useState(false)

  useEffect(
    () => events.subscribe((response) => {
      const request = current.current
      if (request === null || requestOutcome(request.requestId, response) === null) return
      current.current = null
      setPending(false)
      if (response.type === 'ack') request.onAck?.()
      else if (response.type === 'notice') request.onNotice?.(response)
    }),
    [events],
  )

  const cancel = useCallback(() => {
    current.current = null
    setPending(false)
  }, [])

  const start = useCallback(
    (send: (requestId: string) => boolean, callbacks: RequestCallbacks = {}) => {
      if (current.current !== null) return false
      const requestId = crypto.randomUUID()
      current.current = { requestId, ...callbacks }
      setPending(true)
      if (send(requestId)) return true
      current.current = null
      setPending(false)
      return false
    },
    [],
  )

  return { pending, start, cancel }
}
