/**
 * Where a chat line asks Agent settings to open: View on "Updated its notes" opens the
 * Notes page, "Add to instructions" opens Instructions with the line ready to add. The
 * chat opens the panel through the usual door; the editor, wherever it is hosted, takes
 * the page the next time it mounts or hears this.
 */
export interface AgentPageIntent {
  agentId: string
  page: 'notes' | 'instructions'
  /** Only with Instructions: the rule a memory-off agent offered. */
  line?: string
}

let pending: AgentPageIntent | null = null
const listeners = new Set<() => void>()

export function openAgentPage(intent: AgentPageIntent): void {
  pending = intent
  for (const listener of listeners) listener()
}

/** The page asked for this agent, once: taking it clears it. */
export function takeAgentPage(agentId: string): AgentPageIntent | null {
  if (pending?.agentId !== agentId) return null
  const taken = pending
  pending = null
  return taken
}

export function subscribeAgentPage(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
