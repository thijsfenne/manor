import type { Row } from '@manor/client-runtime/state'
import { describe, expect, it } from 'vitest'

import { carryPendingKeys } from './listKeys'

const pending = (key: string, text: string): Row => ({ kind: 'pending', key, text, images: [], files: [], pageContexts: [] })
const stored = (id: string, text: string): Row => ({ kind: 'event', key: id, event: { id, ts: 1, type: 'user_message', text, mentions: [] } })
const empty: ReadonlyMap<string, string> = new Map()

describe('carryPendingKeys', () => {
  it('gives a stored message the key of the pending copy it replaced', () => {
    const keys = carryPendingKeys([stored('u0', 'eerder'), pending('pending:1', 'hoi')], [stored('u0', 'eerder'), stored('u1', 'hoi')], empty)
    expect([...keys]).toEqual([['u1', 'pending:1']])
  })

  it('matches equal texts oldest first, and leaves a message nobody sent from here alone', () => {
    const keys = carryPendingKeys(
      [pending('pending:1', 'ja'), pending('pending:2', 'ja')],
      [stored('u1', 'ja'), stored('u2', 'ja'), stored('u3', 'van de Mac')],
      empty,
    )
    expect([...keys]).toEqual([['u1', 'pending:1'], ['u2', 'pending:2']])
  })

  it('keeps what it carried, and returns the same map when nothing landed', () => {
    const carried = carryPendingKeys([pending('pending:1', 'hoi')], [stored('u1', 'hoi')], empty)
    expect(carryPendingKeys([stored('u1', 'hoi')], [stored('u1', 'hoi'), stored('u2', 'later')], carried)).toBe(carried)
  })
})
