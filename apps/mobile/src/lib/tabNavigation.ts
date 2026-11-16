import { useNavigation } from 'expo-router'
import { StackActions, TabActions } from 'expo-router/react-navigation'
import { useEffect, useEffectEvent } from 'react'

/** The slice of a navigation state this reads; React Navigation's own state fits it. */
export type NavState = {
  key?: string
  type?: string
  index?: number
  routes: readonly { name: string; state?: NavState }[]
}

type TargetedAction = (ReturnType<typeof StackActions.popToTop> | ReturnType<typeof TabActions.jumpTo>) & { target: string }

/**
 * What picking a tab from the house menu dispatches: its stack back to its root list,
 * then the tab itself, so the pick lands on the list the tab is named for. Navigating
 * by path instead would push a second root on top of whatever the tab had open.
 * Empty when the tab bar is not on the focused path.
 */
export function openTabActions(root: NavState | undefined, tab: string): TargetedAction[] {
  const tabs = focusedTabs(root)
  if (tabs?.key === undefined) return []
  const stack = tabs.routes.find((route) => route.name === tab)?.state
  const actions: TargetedAction[] = []
  if (stack?.type === 'stack' && stack.key !== undefined && stack.routes.length > 1) {
    actions.push({ ...StackActions.popToTop(), target: stack.key })
  }
  actions.push({ ...TabActions.jumpTo(tab), target: tabs.key })
  return actions
}

function focusedTabs(state: NavState | undefined): NavState | undefined {
  let current = state
  while (current !== undefined) {
    if (current.type === 'tab') return current
    current = current.routes[current.index ?? current.routes.length - 1]?.state
  }
  return undefined
}

const resets = new Map<string, () => void>()

/**
 * For a tab's root screen that keeps a place of its own, such as an open folder or note:
 * `onReset` runs when its tab is tapped while showing, or picked from the house menu,
 * so both land on the list the way a pushed screen pops.
 */
export function useTabReset(tab: string, onReset: () => void) {
  const navigation = useNavigation()
  const reset = useEffectEvent(onReset)
  useEffect(() => {
    const run = () => reset()
    resets.set(tab, run)
    const tabScreen = navigation.getParent()
    const off = tabScreen?.addListener('tabPress' as never, () => {
      if (tabScreen.isFocused()) run()
    })
    return () => {
      off?.()
      if (resets.get(tab) === run) resets.delete(tab)
    }
  }, [navigation, tab])
}

/** What the house menu calls beside `openTabActions`. */
export function resetTab(tab: string) {
  resets.get(tab)?.()
}
