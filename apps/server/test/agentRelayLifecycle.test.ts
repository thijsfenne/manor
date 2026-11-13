import type { ServerMessage } from '@manor/contracts'
import { describe, expect, it, vi } from 'vitest'
import { closeTerminalTurn } from '../src/agentRelayLifecycle.js'

const turnState = (state: 'running' | 'done' | 'error' | 'aborted'): ServerMessage => ({
  type: 'turn_state',
  chatId: 'dm-1',
  turnId: 'turn-1',
  agentId: 'marlow',
  state,
  ...(state === 'running' ? { startedAt: 1 } : {}),
})

describe('agent relay lifecycle hooks', () => {
  it.each(['done', 'error', 'aborted'] as const)(
    'runs terminal cleanup for a %s turn state',
    (state) => {
      const close = vi.fn()
      expect(closeTerminalTurn(turnState(state), close)).toBe(true)
      expect(close).toHaveBeenCalledOnce()
      expect(close).toHaveBeenCalledWith('turn-1')
    },
  )

  it('leaves a running turn open', () => {
    const close = vi.fn()
    expect(closeTerminalTurn(turnState('running'), close)).toBe(false)
    expect(close).not.toHaveBeenCalled()
  })
})
