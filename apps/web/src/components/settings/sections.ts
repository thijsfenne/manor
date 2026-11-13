import type { ComponentProps } from 'react'
import {
  BookOpen01Icon,
  ConnectIcon,
  CpuIcon,
  DashboardSpeed02Icon,
  FileEditIcon,
  HardDriveIcon,
  HierarchySquare02Icon,
  InformationCircleIcon,
  KeyboardIcon,
  MagicWand01Icon,
  PaintBoardIcon,
  PuzzleIcon,
  Settings02Icon,
} from '@hugeicons/core-free-icons'
import { workspaceShortcut } from '../../useWorkspaceNav'
import { rightPanelShortcut } from '../../useRightPanel'
import { AiBotHeadLookingIcon } from '../customIcons'
import type { Icon } from '../Icon'
import { doorShortcut } from '../NavRail'

/** One page of Settings. The ids are stable; labels may change. */
export type SettingsSection =
  | 'general'
  | 'appearance'
  | 'keybindings'
  | 'usage'
  | 'agents'
  | 'context'
  | 'auto'
  | 'subagents'
  | 'providers'
  | 'memory'
  | 'connections'
  | 'skills'
  | 'storage'
  | 'about'

/** Where Settings is open: a page, and on Agents the persona in the detail (`new` for a blank form). */
export interface SettingsLocation {
  section: SettingsSection
  agentId?: string
}

interface SectionEntry {
  id: SettingsSection
  label: string
  icon: ComponentProps<typeof Icon>['icon']
}

/** The sidebar, in reading order. Groups are headers only; every row is a page. */
export const SETTINGS_GROUPS: readonly { label: string; sections: readonly SectionEntry[] }[] = [
  {
    label: 'Personal',
    sections: [
      { id: 'general', label: 'General', icon: Settings02Icon },
      { id: 'appearance', label: 'Appearance', icon: PaintBoardIcon },
      { id: 'keybindings', label: 'Keybindings', icon: KeyboardIcon },
      { id: 'usage', label: 'Usage & limits', icon: DashboardSpeed02Icon },
    ],
  },
  {
    label: 'Agents',
    sections: [
      { id: 'agents', label: 'Agents', icon: AiBotHeadLookingIcon },
      { id: 'context', label: 'Context files', icon: FileEditIcon },
      { id: 'auto', label: 'Auto mode rules', icon: MagicWand01Icon },
      { id: 'subagents', label: 'Subagents', icon: HierarchySquare02Icon },
    ],
  },
  { label: 'Models', sections: [{ id: 'providers', label: 'Providers & keys', icon: CpuIcon }] },
  { label: 'Knowledge', sections: [{ id: 'memory', label: 'Memory & knowledge', icon: BookOpen01Icon }] },
  {
    label: 'Integrations',
    sections: [
      { id: 'connections', label: 'Connectors', icon: ConnectIcon },
      { id: 'skills', label: 'Skills', icon: PuzzleIcon },
    ],
  },
  {
    label: 'System',
    sections: [
      { id: 'storage', label: 'Storage', icon: HardDriveIcon },
      { id: 'about', label: 'About', icon: InformationCircleIcon },
    ],
  },
]

/** The groups this host has a page for: Auto mode rules only where Auto exists. */
export const settingsGroups = (hostAuto: boolean): typeof SETTINGS_GROUPS =>
  hostAuto
    ? SETTINGS_GROUPS
    : SETTINGS_GROUPS.map((group) => ({ ...group, sections: group.sections.filter((entry) => entry.id !== 'auto') }))

/** ⌘, opens Settings, as on every Mac app. Ctrl answers the same for the web client. */
export const isSettingsShortcut = (event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>): boolean =>
  (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key === ','

type ShortcutEvent = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'repeat'>

/**
 * The workspace's own keys, which would act on the thread hidden under Settings and
 * break Back to app. ⌘S is among them; a page that saves on it claims it first.
 */
export function isWorkspaceShortcut(event: ShortcutEvent): boolean {
  if (doorShortcut(event) !== null || workspaceShortcut(event) !== null || rightPanelShortcut(event) !== null) return true
  if (event.ctrlKey && !event.metaKey && event.key === 'Tab') return true
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return false
  const key = event.key.toLowerCase()
  return key === 'k' || key === 's'
}
