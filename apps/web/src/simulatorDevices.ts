import type { HouseSettings, SimulatorDevice } from '@manor/contracts'

/** What Settings → Simulator stored; null until the user ticked a device. */
export type SimulatorSelection = HouseSettings['simulatorDevices']

/** One runtime's devices, as the panel list and the Settings checklist draw them. */
export interface RuntimeGroup {
  runtime: string
  devices: SimulatorDevice[]
}

const versionOf = (runtime: string) => (/(\d+)\.(\d+)/.exec(runtime) ?? []).slice(1).map(Number)

/** Orders "iOS 26.4" before "iOS 27.0"; a name without a version sorts first. */
export function compareRuntimes(a: string, b: string): number {
  const [aMajor = -1, aMinor = -1] = versionOf(a)
  const [bMajor = -1, bMinor = -1] = versionOf(b)
  return aMajor - bMajor || aMinor - bMinor
}

export function newestRuntime(devices: readonly SimulatorDevice[]): string | undefined {
  return devices.reduce<string | undefined>((newest, device) =>
    newest === undefined || compareRuntimes(device.runtime, newest) > 0 ? device.runtime : newest, undefined)
}

/**
 * Whether the user's selection ticks this device. Untouched, only the newest installed
 * runtime is on. A device the selection does not name arrived after the save: on when
 * its runtime is at least the newest the user had seen, off when it is older.
 */
export function isSelected(device: SimulatorDevice, selection: SimulatorSelection, newest: string | undefined): boolean {
  if (selection === null) return device.runtime === newest
  if (selection.shown.includes(device.udid)) return true
  if (selection.hidden.includes(device.udid)) return false
  return compareRuntimes(device.runtime, selection.runtime) >= 0
}

const byName = (a: SimulatorDevice, b: SimulatorDevice) => a.name.localeCompare(b.name)
const byRunning = (a: SimulatorDevice, b: SimulatorDevice) => Number(b.booted) - Number(a.booted) || byName(a, b)

/** Devices by runtime, newest runtime first; inside a runtime, in `order` (by name unless given). */
export function groupByRuntime(devices: readonly SimulatorDevice[], order = byName): RuntimeGroup[] {
  const groups = new Map<string, SimulatorDevice[]>()
  for (const device of devices) {
    const members = groups.get(device.runtime)
    if (members === undefined) groups.set(device.runtime, [device])
    else members.push(device)
  }
  return [...groups].map(([runtime, members]) => ({ runtime, devices: members.sort(order) }))
    .sort((a, b) => compareRuntimes(b.runtime, a.runtime))
}

/**
 * The panel's list: the ticked devices plus any running one, running first, then by
 * name. Grouped by runtime only when more than one shows; a group with a running
 * device leads, then newest runtime first.
 */
export function panelGroups(devices: readonly SimulatorDevice[], selection: SimulatorSelection): RuntimeGroup[] {
  const newest = newestRuntime(devices)
  const listed = devices.filter((device) => device.booted || isSelected(device, selection, newest))
  return groupByRuntime(listed, byRunning)
    .sort((a, b) => Number(b.devices.some((d) => d.booted)) - Number(a.devices.some((d) => d.booted)))
}

/** The stored selection after devices are turned on or off in Settings: one pill, or a runtime's All on. */
export function withDevices(devices: readonly SimulatorDevice[], selection: SimulatorSelection, udids: readonly string[], on: boolean): NonNullable<SimulatorSelection> {
  const newest = newestRuntime(devices)
  const shown: string[] = []
  const hidden: string[] = []
  for (const device of devices) {
    const ticked = udids.includes(device.udid) ? on : isSelected(device, selection, newest)
    ;(ticked ? shown : hidden).push(device.udid)
  }
  // Only listed devices are stored, so deleted simulators do not pile up; one that comes
  // back is judged as new.
  const seen = [selection?.runtime, newest].filter((runtime): runtime is string => runtime !== undefined)
  return { shown, hidden, runtime: seen.sort(compareRuntimes).at(-1) ?? '' }
}
