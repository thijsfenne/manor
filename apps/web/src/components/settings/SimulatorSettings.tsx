import { DEFAULT_HOUSE_SETTINGS, type HouseSettings } from '@manor/contracts'
import { Switch } from '../ui/Switch'
import { SettingsGroup, SettingsRow } from './SettingsLayout'

/**
 * General's Simulator group: the one switch behind the Simulator door. Off, Manor runs
 * no simulator tool and downloads nothing; the door is gone from every Session.
 */
export function SimulatorGroup({ settings, onSave }: {
  settings: HouseSettings | null
  onSave: (settings: HouseSettings) => void
}) {
  if (settings === null) return null
  const save = (simulator: boolean) => {
    if (simulator !== settings.simulator) onSave({ ...settings, simulator })
  }
  return (
    <SettingsGroup
      title="Simulator"
      onRestore={() => save(DEFAULT_HOUSE_SETTINGS.simulator)}
      restoreDisabled={settings.simulator === DEFAULT_HOUSE_SETTINGS.simulator}
    >
      <SettingsRow
        label="iOS Simulator"
        description="Adds a Simulator door to Sessions, to watch and tap an iOS simulator on this Mac. Needs Xcode. The first screen you open downloads a small helper."
      >
        <Switch label="iOS Simulator" checked={settings.simulator} onChange={save} />
      </SettingsRow>
    </SettingsGroup>
  )
}
