import type { ComponentProps } from 'react'
import {
  AiBrain01Icon,
  BookOpen01Icon,
  ConnectIcon,
  CpuIcon,
  FileEditIcon,
  Globe02Icon,
  HardDriveIcon,
  HierarchySquare02Icon,
  InformationCircleIcon,
  KeyboardIcon,
  MagicWand01Icon,
  Mic01Icon,
  PaintBoardIcon,
  PuzzleIcon,
  SecurityCheckIcon,
  Settings02Icon,
  SmartPhone01Icon,
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
  | 'voice'
  | 'agents'
  | 'context'
  | 'auto'
  | 'subagents'
  | 'models'
  | 'providers'
  | 'memory'
  | 'connections'
  | 'skills'
  | 'panels'
  | 'phone'
  | 'permissions'
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
  /** Lower case words for the nav search: the main row labels of the page. */
  keywords: readonly string[]
}

/** The sidebar, in reading order. Groups are headers only; every row is a page. */
export const SETTINGS_GROUPS: readonly { label: string; sections: readonly SectionEntry[] }[] = [
  {
    label: 'Personal',
    sections: [
      { id: 'general', label: 'General', icon: Settings02Icon, keywords: ['photo', 'name', 'profile', 'keep awake', 'sleep', 'power'] },
      { id: 'appearance', label: 'Appearance', icon: PaintBoardIcon, keywords: ['theme', 'dark', 'light', 'system', 'font', 'code font', 'typeface'] },
      { id: 'keybindings', label: 'Keybindings', icon: KeyboardIcon, keywords: ['shortcuts', 'keys', 'workspace'] },
      { id: 'voice', label: 'Voice', icon: Mic01Icon, keywords: ['dictation', 'microphone', 'speech', 'transcribe', 'whisper', 'parakeet', 'language'] },
    ],
  },
  {
    label: 'Agents',
    sections: [
      { id: 'agents', label: 'Agents', icon: AiBotHeadLookingIcon, keywords: ['default agent', 'chief of staff', 'routing', 'agent settings', 'personas', 'new agent'] },
      { id: 'subagents', label: 'Subagents', icon: HierarchySquare02Icon, keywords: ['allowed', 'maximum concurrent subagents', 'allow subagents to delegate'] },
      { id: 'auto', label: 'Auto mode rules', icon: MagicWand01Icon, keywords: ['rules', 'provider', 'model', 'reasoning', 'fast mode'] },
    ],
  },
  {
    label: 'Knowledge',
    sections: [
      { id: 'memory', label: 'Memory & knowledge', icon: BookOpen01Icon, keywords: ['memory folder', 'knowledge folder', 'note ai model', 'daily log'] },
      { id: 'context', label: 'Context files', icon: FileEditIcon, keywords: ['context file', 'instructions', 'standing files'] },
    ],
  },
  {
    label: 'Models',
    sections: [
      { id: 'models', label: 'Models', icon: AiBrain01Icon, keywords: ['model', 'turn off', 'enabled models', 'model picker'] },
      { id: 'providers', label: 'Providers & keys', icon: CpuIcon, keywords: ['provider clis', 'keys', 'api keys and app passwords', 'sign in', 'subscriptions'] },
    ],
  },
  {
    label: 'Tools',
    sections: [
      { id: 'connections', label: 'Connectors', icon: ConnectIcon, keywords: ['connectors', 'apps', 'mcp', 'servers', 'composio'] },
      { id: 'skills', label: 'Skills', icon: PuzzleIcon, keywords: ['import skill', 'filter skills'] },
      { id: 'panels', label: 'Browser & Simulator', icon: Globe02Icon, keywords: ['browser', 'search engine', 'simulator', 'ios', 'xcode', 'devices'] },
      { id: 'permissions', label: 'Permissions', icon: SecurityCheckIcon, keywords: ['accessibility', 'screen recording', 'system settings', 'privacy', 'computer use'] },
    ],
  },
  {
    label: 'System',
    sections: [
      { id: 'storage', label: 'Storage', icon: HardDriveIcon, keywords: ['settle quiet sessions', 'delete archived chats', 'keep picture copies', 'keep backups', 'retention'] },
      { id: 'phone', label: 'Phone', icon: SmartPhone01Icon, keywords: ['pair phone', 'tailscale https', 'paired devices', 'revoke', 'qr code', 'forget this mac'] },
      { id: 'about', label: 'About', icon: InformationCircleIcon, keywords: ['version', 'logs', 'diagnostics', 'server running since'] },
    ],
  },
]

/** The groups this host has a page for: Auto mode rules only where Auto exists. */
export const settingsGroups = (hostAuto: boolean): typeof SETTINGS_GROUPS =>
  hostAuto
    ? SETTINGS_GROUPS
    : SETTINGS_GROUPS.map((group) => ({ ...group, sections: group.sections.filter((entry) => entry.id !== 'auto') }))

/** The groups whose pages match the nav search; a group with no match is dropped. An empty query keeps all. */
export function filterSettingsGroups(groups: typeof SETTINGS_GROUPS, query: string): typeof SETTINGS_GROUPS {
  const needle = query.trim().toLowerCase()
  if (needle === '') return groups
  return groups
    .map((group) => ({
      ...group,
      sections: group.sections.filter((entry) => entry.label.toLowerCase().includes(needle) || entry.keywords.some((word) => word.includes(needle))),
    }))
    .filter((group) => group.sections.length > 0)
}

/** The page a search moves to: the first match once the open page stops matching, else none. */
export function pageAfterSearch(groups: typeof SETTINGS_GROUPS, query: string, open: SettingsSection): SettingsSection | undefined {
  const matches = filterSettingsGroups(groups, query).flatMap((group) => group.sections)
  return matches.some((entry) => entry.id === open) ? undefined : matches[0]?.id
}

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
