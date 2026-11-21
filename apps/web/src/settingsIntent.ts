import type { SettingsSection } from './components/settings/sections'

/**
 * A door into Settings for UI deep in the tree that holds no Settings controller: the
 * composer's dictation popover links to Voice. `useSettingsDoors` listens and opens the
 * page through the same guard as every other door.
 */
const listeners = new Set<(section: SettingsSection) => void>()

export function openSettingsAt(section: SettingsSection): void {
  for (const listener of listeners) listener(section)
}

export function subscribeSettingsRequests(listener: (section: SettingsSection) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
