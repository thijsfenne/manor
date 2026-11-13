import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react'
import { emptyThread, emptyWorkspace, type LiveWorkspace, type ThreadState } from './state'

const LiveWorkspaceContext = createContext<LiveWorkspace | null>(null)

/** Provided once at the root, so a view that draws streamed text can read it. */
export function LiveWorkspaceProvider({ live, children }: { live: LiveWorkspace; children: ReactNode }) {
  return <LiveWorkspaceContext.Provider value={live}>{children}</LiveWorkspaceContext.Provider>
}

/**
 * One chat's thread with its streamed text, rendering on every text frame of that chat
 * alone. Only the views that draw the text read it; everything else reads the quiet
 * workspace. Outside a provider it is the empty thread.
 */
export function useLiveThread(chatId: string | null): ThreadState {
  const live = useContext(LiveWorkspaceContext)
  const { subscribe, get } = live ?? NO_LIVE
  const read = () => (chatId === null ? undefined : get().threads[chatId]) ?? emptyThread
  return useSyncExternalStore(subscribe, read, read)
}

const NO_LIVE: LiveWorkspace = { get: () => emptyWorkspace, subscribe: () => () => {} }
