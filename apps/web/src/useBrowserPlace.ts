import { useCallback, useEffect, useMemo, useState } from 'react'
import { recentBrowserSessions } from './components/BrowserSessionMenu'
import type { WorkspaceView } from './components/Sidebar'
import { chatOf, type WorkspaceShape } from './state'
import type { Manor } from './useWorkspace'

/** Whether the chat beside Browser is folded away. */
const BROWSER_SESSION_HIDDEN_KEY = 'manor:browser-session-hidden'

/**
 * The Browser place's session column. It holds its own session id, apart from the
 * stage's open chat, so visiting Browser never replaces the chat the user was in. The
 * thread is loaded like a split's second pane: snapshot and resume, no selection.
 */
export function useBrowserPlace({ activeView, workspace, manor }: {
  activeView: WorkspaceView
  workspace: WorkspaceShape
  manor: Pick<Manor, 'loadChat' | 'createdBrowserSession'>
}) {
  const { loadChat, createdBrowserSession } = manor
  const sessions = useMemo(() => recentBrowserSessions(workspace.chats), [workspace.chats])
  const [sessionId, setSessionId] = useState<string | null>(null)
  // Followed during render, not in an effect. The create's reply lands with a directory
  // that already dropped the empty session it replaced, and an effect would paint one
  // frame of the empty column in between.
  const [followedCreate, setFollowedCreate] = useState<string | null>(null)
  if (createdBrowserSession !== followedCreate) {
    setFollowedCreate(createdBrowserSession)
    if (createdBrowserSession !== null) setSessionId(createdBrowserSession)
  }
  const sessionChat = sessionId === null ? null : chatOf(workspace, sessionId) ?? null
  const showSession = useCallback((chatId: string) => {
    setSessionId(chatId)
    if (workspace.threads[chatId]?.hasSnapshot !== true) loadChat(chatId)
  }, [workspace.threads, loadChat])
  const latestSession = sessions[0]?.id
  useEffect(() => {
    if (activeView !== 'browser' || sessionChat?.kind === 'browser' || latestSession === undefined) return
    showSession(latestSession)
  }, [activeView, sessionChat?.kind, latestSession, showSession])
  /** Hides the session column the way the sidebar toggle hides the sidebar; remembered. */
  const [hidden, setHidden] = useState(() => {
    try { return window.localStorage.getItem(BROWSER_SESSION_HIDDEN_KEY) === '1' } catch { return false }
  })
  const toggleHidden = useCallback(() => setHidden((current) => {
    try { window.localStorage.setItem(BROWSER_SESSION_HIDDEN_KEY, current ? '0' : '1') } catch { /* remembered for this window only */ }
    return !current
  }), [])
  // Resumed while Browser is on stage, so a hidden column still catches up after a
  // reconnect; counted as viewed only while it shows, so unread keeps working.
  const paneId = activeView === 'browser' ? sessionChat?.id ?? null : null
  const viewedId = hidden ? null : paneId

  return { sessions, sessionChat, showSession, hidden, toggleHidden, paneId, viewedId }
}

/**
 * The browser preview floated over a chat whose browser panel is closed. At most one
 * chat floats at a time; a dismissed chat stays dismissed until it is floated again.
 */
export function useFloatingBrowser({ browserShown, drafting, openChatId }: {
  browserShown: boolean
  drafting: boolean
  openChatId: string | undefined
}) {
  const [floatingChatId, setFloatingChatId] = useState<string | null>(null)
  const [dismissedChats, setDismissedChats] = useState(() => new Set<string>())
  useEffect(() => {
    if (browserShown || drafting || floatingChatId !== openChatId) setFloatingChatId(null)
  }, [browserShown, drafting, openChatId, floatingChatId])
  const float = useCallback((chatId: string) => {
    setDismissedChats((chats) => {
      const next = new Set(chats)
      next.delete(chatId)
      return next
    })
    setFloatingChatId(chatId)
  }, [])
  const dismiss = useCallback((chatId: string) => {
    setFloatingChatId(null)
    setDismissedChats((chats) => new Set(chats).add(chatId))
  }, [])
  const land = useCallback(() => setFloatingChatId(null), [])

  return { floatingChatId, isDismissed: (chatId: string) => dismissedChats.has(chatId), float, dismiss, land }
}
