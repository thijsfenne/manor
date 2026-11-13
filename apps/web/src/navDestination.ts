import type { Chat } from '@manor/contracts'
import type { WorkspaceView } from './components/Sidebar'
import type { SidebarView } from './useSidebar'

/** The places the left rail leads to, in the order it lists them. */
export type NavDestination = 'chats' | 'work' | 'browser' | 'knowledge' | 'reminders' | 'artifacts' | 'routines' | 'plugins'

/** The destinations that bring a list of their own into the sidebar. */
export type SidebarPanel = 'work' | 'chats' | 'knowledge' | 'reminders'

/**
 * Which rail item the stage is in, so exactly one reads as current. A thread belongs
 * to the list it is reached from: a run to Routines, a project chat to Work, a DM or a
 * group to Agents. A routine that talks in its agent's DM writes into that DM, so it
 * lights Agents like any DM; only a run thread belongs to Routines. Usage is not a
 * destination, it is reached from its own reading at the foot of the rail, so no item
 * lights while it is open.
 *
 * `stageKind` is the open thread's kind on `chat`, and the draft target's kind on
 * `new-chat`; never the thread a draft was started from.
 */
export function navDestinationOf(
  view: WorkspaceView,
  stageKind: Chat['kind'] | null,
  sidebarView: SidebarView,
): NavDestination | null {
  switch (view) {
    case 'knowledge':
    case 'reminders':
    case 'artifacts':
    case 'browser':
    case 'routines':
      return view
    case 'skills':
    case 'connectors':
    case 'suggestions':
      return 'plugins'
    case 'usage':
      return null
    case 'chat':
      if (stageKind === 'run') return 'routines'
      return sidebarView === 'inbox' ? 'work' : 'chats'
    case 'new-chat':
      // A draft is not the thread it was started from, so its own target decides.
      if (stageKind === 'project') return 'work'
      if (stageKind === 'dm') return 'chats'
      return sidebarView === 'inbox' ? 'work' : 'chats'
    case 'empty-chat':
      return sidebarView === 'inbox' ? 'work' : 'chats'
  }
}

/**
 * The list the sidebar shows beside the stage. Knowledge's note tree and Reminders'
 * tiles and lists live there like the Work inbox does. Artifacts, Browser, Plugins and Scheduled tasks carry their own
 * navigation inside the stage, so they get no sidebar at all rather than a panel
 * holding some other destination's list.
 */
export function sidebarPanelOf(destination: NavDestination | null): SidebarPanel | null {
  return destination === 'work' || destination === 'chats' || destination === 'knowledge' || destination === 'reminders'
    ? destination
    : null
}
