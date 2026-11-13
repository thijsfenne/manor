import type { Chat } from '@manor/contracts'
import { subagentSummaryOf, rowsOf, threadOf, type ThreadShape, type WorkspaceShape } from './state'
import { shownSubagents } from './subagentLevels'
import { chatSubagents, subagentStateOf } from './turnTrace'

/**
 * What the Session panel's door reads about a chat's subagents: whether the list it
 * would show has any (a leaf helper with none leaves the panel nothing to hold) and
 * whether any helper in this chat or the level on stage is working, which dots the door.
 * Booleans, so the rail keeps its identity while a reply streams. A DM lists none:
 * helpers are Session work.
 */
export function chatHelperFlags(workspace: WorkspaceShape, thread: ThreadShape, chat: Chat, path: readonly string[]) {
  if (chat.kind === 'dm') return { hasHelpers: false, helpersRunning: false }
  const own = chatSubagents(rowsOf(thread, chat.kind))
  const { shown } = shownSubagents(chat.id, own, path, (childId) => chatSubagents(rowsOf(threadOf(workspace, childId))))
  const summary = (childId: string) => subagentSummaryOf(workspace, childId)
  const running = (helpers: readonly (typeof own)[number][]) => helpers.some((helper) => subagentStateOf(helper, summary) === 'running')
  return { hasHelpers: shown.length > 0, helpersRunning: running(own) || running(shown) }
}
