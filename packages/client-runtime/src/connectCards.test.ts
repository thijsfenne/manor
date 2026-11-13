import type { ThreadEvent } from '@manor/contracts'
import { describe, expect, it } from 'vitest'
import { emptyThread, rowsOf } from './state'

const card = (status?: 'waiting' | 'connected' | 'failed', extra: Record<string, unknown> = {}): ThreadEvent[] => [
  { id: 'c1', ts: 1, type: 'connect_request', agentId: 'smith', turnId: 'turn-1', connectId: 'k1', kind: 'composio', app: 'gmail', alias: 'personal' },
  ...(status === undefined ? [] : [{ id: 'c2', ts: 2, type: 'connect_status', agentId: 'smith', turnId: 'turn-1', connectId: 'k1', status, ...extra } as ThreadEvent]),
]

const connectsOf = (events: ThreadEvent[]) => {
  const turn = rowsOf({ ...emptyThread, events }).find((row) => row.kind === 'turn')
  return turn?.kind === 'turn' ? turn.connects : undefined
}

describe('connect cards on a turn', () => {
  it('starts ready and follows its status to Connected or Failed', () => {
    expect(connectsOf(card())).toEqual([{ key: 'c1', connectId: 'k1', kind: 'composio', app: 'gmail', alias: 'personal', status: 'ready' }])
    expect(connectsOf(card('waiting'))?.[0]?.status).toBe('waiting')
    expect(connectsOf(card('connected', { nextMessage: true }))?.[0]).toMatchObject({ status: 'connected', nextMessage: true })
    expect(connectsOf(card('failed', { reason: 'The sign-in link expired.', final: true }))?.[0])
      .toMatchObject({ status: 'failed', reason: 'The sign-in link expired.', final: true })
  })
})
