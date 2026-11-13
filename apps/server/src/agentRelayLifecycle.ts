import type { ServerMessage } from '@manor/contracts'

type TerminalTurnState = Extract<ServerMessage, { type: 'turn_state' }> & {
  state: Exclude<Extract<ServerMessage, { type: 'turn_state' }>['state'], 'running'>
}

/** Runs terminal cleanup from the one broadcast boundary shared by every turn outcome. */
export function closeTerminalTurn(
  message: ServerMessage,
  close: (turnId: string) => void,
): message is TerminalTurnState {
  if (message.type !== 'turn_state' || message.state === 'running') return false
  close(message.turnId)
  return true
}
