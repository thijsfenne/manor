import { describe, expect, it } from 'vitest'
import {
  InvalidRoutineCapabilityError,
  ROUTINE_TOOL_CALL_LIMIT,
  RoutineCapabilities,
} from '../src/routineCapability.js'

const context = { chatId: 'dm_1', agentId: 'sage', turnId: 'turn_1' }

describe('RoutineCapabilities', () => {
  it('stays usable until its turn closes', () => {
    const capabilities = new RoutineCapabilities()
    const token = capabilities.issue(context, 'long-turn')
    expect(capabilities.take(token, 'routine_list')).toEqual(context)
    capabilities.closeTurn(context.turnId)
    expect(() => capabilities.take(token, 'routine_list')).toThrow(InvalidRoutineCapabilityError)
  })

  it('binds chat, persona and turn outside the model input', () => {
    const capabilities = new RoutineCapabilities()
    const token = capabilities.issue(context, 'turn-token')

    expect(capabilities.take(token, 'routine_save')).toEqual(context)
  })

  it('bounds all routine reads and writes in one turn', () => {
    const capabilities = new RoutineCapabilities()
    const token = capabilities.issue(context, 'turn-token')

    for (let call = 0; call < ROUTINE_TOOL_CALL_LIMIT; call += 1) {
      capabilities.take(token, call % 2 === 0 ? 'routine_list' : 'routine_save')
    }
    expect(() => capabilities.take(token, 'routine_save')).toThrow(
      `exhausted after ${ROUTINE_TOOL_CALL_LIMIT} calls`,
    )
  })

  it('refuses empty and unknown capabilities', () => {
    const capabilities = new RoutineCapabilities()

    expect(() => capabilities.take('somebody-else', 'routine_list')).toThrow(InvalidRoutineCapabilityError)
    expect(() => capabilities.take(undefined, 'routine_list')).toThrow(InvalidRoutineCapabilityError)
    expect(() => capabilities.take('', 'routine_list')).toThrow(InvalidRoutineCapabilityError)
  })
})
