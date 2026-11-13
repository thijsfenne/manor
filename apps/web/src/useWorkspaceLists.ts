import { useMemo } from 'react'
import { runsByRoutine as groupRunsByRoutine } from './routines'
import { chatList, inbox, projectThreads, type WorkspaceShape } from './state'
import { buildSwitcherItems } from './useChatSwitcher'

/**
 * The lists the sidebar, rail, palette and switcher draw from. Each is memoised on the
 * fields it actually reads, not on `workspace`, which is a new object on every streaming
 * delta and so memoised nothing. Everything named here keeps its identity through a
 * delta; only `threads` changes, and no list reads it. Rebuilding them meant ~30 sidebar
 * rows and ~120 icons re-rendering forty times a second for a list that had not moved.
 */
export function useWorkspaceLists(workspace: WorkspaceShape, phone: boolean) {
  const chatRows = useMemo(
    () => chatList(workspace),
    [workspace.chats, workspace.agents, workspace.activity, workspace.openChatId, workspace.pendingChatId],
  )
  // `projects` belongs in this one and not in the list above: an inbox row draws its
  // room's name, icon and colour, so a renamed project has to reach the row.
  // Sessions a project thread started stay out of the Mac's list; the phone keeps one
  // list with every session in it (decided 2026-10-10).
  const chatInbox = useMemo(
    () => inbox(workspace, { hideThreadSessions: !phone }),
    [workspace.chats, workspace.projects, workspace.workHandoffs, workspace.activity, workspace.subagents, workspace.backgroundChatIds, workspace.openChatId, workspace.pendingChatId, phone],
  )
  const threadRows = useMemo(
    () => projectThreads(workspace),
    [workspace.chats, workspace.projects, workspace.workHandoffs, workspace.activity, workspace.subagents, workspace.backgroundChatIds, workspace.openChatId, workspace.pendingChatId],
  )
  const threadlessProjects = useMemo(
    () => workspace.projects.filter((project) => !threadRows.some((row) => row.project.id === project.id)),
    [workspace.projects, threadRows],
  )
  // Every tile the Ctrl+Tab switcher can show. Only the work inbox feeds it; direct,
  // group and pair chats stay in their own navigation surfaces.
  const switcherItems = useMemo(
    () => buildSwitcherItems(chatInbox),
    [chatInbox],
  )
  /**
   * Every routine's runs, newest first. Grouped from the directory rather than fetched:
   * a run is an ordinary chat that already arrives in `workspace.chats`, and a second
   * listing would be a second answer to the same question.
   */
  const runsByRoutine = useMemo(() => {
    return groupRunsByRoutine(workspace.chats, workspace.routines)
  }, [workspace.chats, workspace.routines])
  return { chatRows, chatInbox, threadRows, threadlessProjects, switcherItems, runsByRoutine }
}
