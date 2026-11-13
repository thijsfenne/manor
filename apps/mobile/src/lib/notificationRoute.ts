/** The slice of a navigation state this reads; React Navigation's own state fits it. */
export type StackState = {
  type?: string
  index?: number
  routes: readonly { name: string; params?: object; state?: StackState }[]
}

/**
 * What a tapped notification does to the stack. The chat it names lands directly on
 * the room the user was in, so back leads out of the app's notification path rather than
 * into whatever Session was left open hours ago: `push` when the room is all there is,
 * `reset` (dismiss to the room, then push) when screens sit on it, and `stay` when that
 * chat is already the one on screen.
 */
export function notificationOpen(root: StackState | undefined, chatId: string): 'stay' | 'push' | 'reset' {
  const stack = focusedStack(root)
  if (stack === undefined) return 'push'
  const top = stack.routes[stack.index ?? stack.routes.length - 1]
  if (top?.name === 'chat/[id]' && paramId(top.params) === chatId) return 'stay'
  return stack.routes.length > 1 ? 'reset' : 'push'
}

/** The deepest stack on the focused path; Expo Router wraps the app's stack in a root route. */
function focusedStack(state: StackState | undefined): StackState | undefined {
  let stack: StackState | undefined
  let current = state
  while (current !== undefined) {
    if (current.type === 'stack') stack = current
    current = current.routes[current.index ?? current.routes.length - 1]?.state
  }
  return stack
}

function paramId(params: object | undefined): string | undefined {
  const id = params !== undefined && 'id' in params ? params.id : undefined
  return typeof id === 'string' ? id : undefined
}
