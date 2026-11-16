import { createContext, useContext, type ReactNode } from 'react'
import { useSafeAreaInsets, type EdgeInsets } from 'react-native-safe-area-context'

const WindowInsetsContext = createContext<EdgeInsets | null>(null)

/** Hands the window's own safe area down past the tab stacks, whose provider adds the tab bar. */
export function WindowInsetsProvider({ children }: { children: ReactNode }) {
  return <WindowInsetsContext.Provider value={useSafeAreaInsets()}>{children}</WindowInsetsContext.Provider>
}

/**
 * The window's safe area, for what a `Modal` draws: a modal covers the tab bar, so it
 * pads by the home indicator, not by the bar that `useSafeAreaInsets` counts in a tab.
 */
export function useWindowInsets(): EdgeInsets {
  const insets = useContext(WindowInsetsContext)
  if (insets === null) throw new Error('useWindowInsets must be used inside WindowInsetsProvider')
  return insets
}
