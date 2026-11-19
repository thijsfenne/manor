import { useEffect } from 'react'
import { DEFAULT_HOUSE_SETTINGS, type HouseSettings, type KeepAwakeMode, type SystemInfo } from '@manor/contracts'
import { Select, type SelectOption } from '../ui/Select'
import { SettingsGroup, SettingsRow } from './SettingsLayout'

const KEEP_AWAKE_OPTIONS: readonly SelectOption<KeepAwakeMode>[] = [
  { value: 'off', label: 'Never' },
  { value: 'working', label: 'While agents work' },
  { value: 'always', label: 'Always' },
]

/**
 * General's Power group. Only a server on macOS can hold the Mac awake, so the group
 * is absent until system info says so, and while the settings are still unread.
 */
export function PowerGroup({ settings, info, onSaveSettings, onRequestInfo }: {
  settings: HouseSettings | null
  info: SystemInfo | null
  onSaveSettings: (settings: HouseSettings) => void
  onRequestInfo: () => void
}) {
  const missing = info === null
  // Settings arrive on every connect, so a request lost while offline is asked again then.
  // Braces on purpose: an effect that returns the request's answer hands React a bad cleanup.
  useEffect(() => { if (missing) onRequestInfo() }, [missing, settings, onRequestInfo])
  if (settings === null || info?.canKeepAwake !== true) return null
  const save = (keepAwake: KeepAwakeMode) => { onSaveSettings({ ...settings, keepAwake }) }
  return (
    <SettingsGroup
      title="Power"
      onRestore={() => save(DEFAULT_HOUSE_SETTINGS.keepAwake)}
      restoreDisabled={settings.keepAwake === DEFAULT_HOUSE_SETTINGS.keepAwake}
    >
      <SettingsRow
        label="Keep this Mac awake"
        description="Stops the Mac from going to sleep on its own. The display can still sleep, and closing the lid still sleeps the Mac."
      >
        <div className="w-[200px]">
          <Select label="Keep this Mac awake" value={settings.keepAwake} options={KEEP_AWAKE_OPTIONS} onChange={save} />
        </div>
      </SettingsRow>
    </SettingsGroup>
  )
}
