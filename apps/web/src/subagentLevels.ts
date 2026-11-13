import type { ChatSubagent } from '@manor/client-runtime/turn-trace'

/** One subagent on an open view's path, and the chat whose turn launched it. */
export interface SubagentLevel {
  subagent: ChatSubagent
  chatId: string
}

/**
 * Follows a path of launch call ids down from a chat. It stops where a launch row is
 * not there to find, so a nested path opens one level at a time as each child's own
 * thread arrives, and a child that is gone falls back to the level above it.
 */
export function subagentLevels(
  chatId: string,
  subagents: readonly ChatSubagent[],
  path: readonly string[],
  childSubagents: (childId: string) => readonly ChatSubagent[],
): SubagentLevel[] {
  const levels: SubagentLevel[] = []
  let list = subagents
  let launchedIn = chatId
  for (const callId of path) {
    const subagent = list.find((candidate) => candidate.step.toolCallId === callId)
    if (subagent === undefined) break
    levels.push({ subagent, chatId: launchedIn })
    const childId = subagent.step.subagent?.childChatId
    if (childId === undefined) break
    list = childSubagents(childId)
    launchedIn = childId
  }
  return levels
}

/**
 * The subagents a chat's panel lists: its own while its transcript is on stage, and the
 * helpers of the subagent on stage once a view lies over it. The header's crumb and the
 * view's bar carry the way back, so the list holds only helpers.
 */
export function shownSubagents(
  chatId: string,
  subagents: readonly ChatSubagent[],
  path: readonly string[],
  childSubagents: (childId: string) => readonly ChatSubagent[],
) {
  const levels = subagentLevels(chatId, subagents, path, childSubagents)
  const level = levels.at(-1)
  const levelChildId = level?.subagent.step.subagent?.childChatId
  const shown = level === undefined ? subagents : levelChildId === undefined ? [] : childSubagents(levelChildId)
  return { levels, level, levelChildId, shown }
}
