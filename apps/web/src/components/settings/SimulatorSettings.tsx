import { useEffect, useRef, useState } from 'react'
import { DEFAULT_HOUSE_SETTINGS, type HouseSettings, type SimulatorAction, type SimulatorState } from '@manor/contracts'
import { groupByRuntime, isSelected, newestRuntime, withDevices, type SimulatorSelection } from '../../simulatorDevices'
import { Pill, PillGroup } from '../ui/Pill'
import { Switch } from '../ui/Switch'
import { SettingsGroup, SettingsRow } from './SettingsLayout'

/**
 * General's Simulator group: the one switch behind the Simulator door, and under it the
 * devices the panel's list shows. Off, Manor runs no simulator tool and downloads
 * nothing; the door is gone from every Session.
 */
export function SimulatorGroup({ settings, simulator, connected, onSave, onAction }: {
  settings: HouseSettings | null
  simulator: SimulatorState | null
  connected: boolean
  onSave: (settings: HouseSettings) => boolean
  onAction: (action: SimulatorAction, udid?: string) => boolean
}) {
  const on = settings?.simulator === true
  // The device list comes from the server once the toggle is on there.
  useEffect(() => {
    if (on && connected) onAction('list')
  }, [on, connected, onAction])
  if (settings === null) return null
  const save = (simulator: boolean) => {
    if (simulator !== settings.simulator) onSave({ ...settings, simulator })
  }
  const atDefaults = settings.simulator === DEFAULT_HOUSE_SETTINGS.simulator && settings.simulatorDevices === null
  return (
    <SettingsGroup
      title="Simulator"
      onRestore={() => onSave({ ...settings, simulator: DEFAULT_HOUSE_SETTINGS.simulator, simulatorDevices: null })}
      restoreDisabled={atDefaults}
    >
      <SettingsRow
        label="iOS Simulator"
        description="Adds a Simulator door to Sessions, to watch and tap an iOS simulator on this Mac. Needs Xcode. The first screen you open downloads a small helper."
      >
        <Switch label="iOS Simulator" checked={settings.simulator} onChange={save} />
      </SettingsRow>
      {on && simulator?.status === 'ready' && simulator.devices.length > 0 ? (
        <DeviceChoice settings={settings} devices={simulator.devices} onSave={onSave} />
      ) : null}
    </SettingsGroup>
  )
}

const keyOf = (selection: SimulatorSelection) => JSON.stringify(selection)

/** One pill per simulator, by runtime: picked puts it in the panel's list. */
function DeviceChoice({ settings, devices, onSave }: {
  settings: HouseSettings
  devices: SimulatorState['devices']
  onSave: (settings: HouseSettings) => boolean
}) {
  const [draft, setDraft] = useState(settings.simulatorDevices)
  // Saves still on their way back: their echoes must not flip a later switch back.
  const inFlight = useRef<string[]>([])
  useEffect(() => {
    const key = keyOf(settings.simulatorDevices)
    const at = inFlight.current.indexOf(key)
    if (at !== -1) {
      inFlight.current = inFlight.current.slice(at + 1)
      return
    }
    setDraft(settings.simulatorDevices)
  }, [settings.simulatorDevices])

  const newest = newestRuntime(devices)
  const toggle = (udids: readonly string[], on: boolean) => {
    const next = withDevices(devices, draft, udids, on)
    inFlight.current = [...inFlight.current, keyOf(next)]
    if (onSave({ ...settings, simulatorDevices: next })) setDraft(next)
    else inFlight.current = inFlight.current.slice(0, -1)
  }

  return (
    <div className="flex flex-col gap-3 py-3">
      <div className="flex flex-col gap-0.5">
        <span className="text-[14px] font-medium text-text">Devices in the panel</span>
        <span className="text-label text-muted">A running simulator always shows. A newer iOS adds its devices; an older one stays off.</span>
      </div>
      {groupByRuntime(devices).map((group) => {
        const allOn = group.devices.every((device) => isSelected(device, draft, newest))
        const udids = group.devices.map((device) => device.udid)
        return (
          <PillGroup key={group.runtime} label={group.runtime} action={{ label: allOn ? 'All off' : 'All on', onSelect: () => toggle(udids, !allOn) }}>
            {group.devices.map((device) => {
              const on = isSelected(device, draft, newest)
              return <Pill key={device.udid} label={device.name} on={on} onToggle={() => toggle([device.udid], !on)} />
            })}
          </PillGroup>
        )
      })}
    </div>
  )
}
