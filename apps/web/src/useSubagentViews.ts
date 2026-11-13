import { useCallback, useEffect, useMemo, useState } from 'react'
import { sidebarSubagentRows, subagentGroups, subagentLineage, type WorkspaceShape } from './state'

/** The open view per chat: launch call ids from that chat's own child down to the one on stage. */
type SubagentViews = Readonly<Record<string, readonly string[]>>

const EMPTY_PATH: readonly string[] = []

const without = (views: SubagentViews, chatId: string): SubagentViews => {
  if (views[chatId] === undefined) return views
  const { [chatId]: _closed, ...rest } = views
  return rest
}

/**
 * A subagent's conversation on the stage of the chat that started it. The chat stays
 * mounted underneath, which is what brings Back to the same scroll position, so a view
 * lives exactly as long as its chat is on stage: leaving the chat closes it.
 */
export function useSubagentViews(
  workspace: WorkspaceShape,
  openChat: (chatId: string) => void,
  closeSidebarOverlay: () => void,
  stageChatIds: ReadonlySet<string>,
) {
  const sidebarSubagents = useMemo(
    () => subagentGroups(workspace),
    [workspace.subagents, workspace.nativeSubagents],
  )
  const [views, setViews] = useState<SubagentViews>({})

  const stageKey = [...stageChatIds].join('\0')
  useEffect(() => {
    const onStage = new Set(stageKey.split('\0'))
    setViews((current) => {
      const closed = Object.keys(current).filter((chatId) => !onStage.has(chatId))
      return closed.length === 0 ? current : closed.reduce(without, current)
    })
  }, [stageKey])

  /** One level further down: a row in the chat, or in a subagent's own conversation. */
  const pushSubagentView = useCallback((chatId: string, toolCallId: string) => {
    setViews((current) => {
      const path = current[chatId] ?? EMPTY_PATH
      return path.at(-1) === toolCallId ? current : { ...current, [chatId]: [...path, toolCallId] }
    })
  }, [])

  /** Back to this chat's own transcript, from any depth. */
  const closeSubagentView = useCallback((chatId: string) => setViews((current) => without(current, chatId)), [])

  /** One level up, which is the parent of the subagent on stage. */
  const popSubagentView = useCallback((chatId: string) => {
    setViews((current) => {
      const path = current[chatId]
      if (path === undefined) return current
      return path.length <= 1 ? without(current, chatId) : { ...current, [chatId]: path.slice(0, -1) }
    })
  }, [])

  /** A sidebar row: the chat that started this child, with the child's whole line opened. */
  const openSubagent = useCallback(
    (parentChatId: string, toolCallId: string | null) => {
      closeSidebarOverlay()
      openChat(parentChatId)
      if (toolCallId === null) return
      const rows = sidebarSubagentRows(workspace)
      const listed = rows.find((child) =>
        child.toolCallId === toolCallId && subagentLineage(rows, child.id)[0]?.parentChatId === parentChatId)
      const path = listed === undefined ? [toolCallId] : subagentLineage(rows, listed.id).map((child) => child.toolCallId)
      setViews((current) => ({ ...current, [parentChatId]: path }))
    },
    [closeSidebarOverlay, openChat, workspace.subagents, workspace.nativeSubagents],
  )

  const subagentPath = useCallback((chatId: string) => views[chatId] ?? EMPTY_PATH, [views])

  return { sidebarSubagents, subagentPath, pushSubagentView, popSubagentView, closeSubagentView, openSubagent }
}
