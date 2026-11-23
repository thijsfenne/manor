import type { SimulatorDevice } from '@manor/contracts'
import { describe, expect, it } from 'vitest'
import { compareRuntimes, groupByRuntime, panelGroups, withDevices } from './simulatorDevices'

let next = 0
const device = (name: string, runtime: string, booted = false): SimulatorDevice => {
  next += 1
  return { udid: `00000000-0000-0000-0000-${String(next).padStart(12, '0')}`, name, runtime, booted }
}

const air = device('iPad Air', 'iOS 27.0')
const pro = device('iPhone 18 Pro', 'iOS 27.0')
const base = device('iPhone 18', 'iOS 27.0')
const old = device('iPhone 17', 'iOS 26.4')
const oldRunning = device('iPhone 16e', 'iOS 26.4', true)

const names = (groups: ReturnType<typeof panelGroups>) => groups.map((group) => [group.runtime, group.devices.map((d) => d.name)])

describe('simulator device list', () => {
  it('orders runtimes by version, not by text', () => {
    expect(compareRuntimes('iOS 9.0', 'iOS 10.0')).toBeLessThan(0)
    expect(compareRuntimes('iOS 27.0', 'iOS 26.4')).toBeGreaterThan(0)
  })

  it('shows only the newest runtime by default, by name', () => {
    expect(names(panelGroups([old, pro, air, base], null))).toEqual([['iOS 27.0', ['iPad Air', 'iPhone 18', 'iPhone 18 Pro']]])
  })

  it('always shows a running device, its group first and the device first in it', () => {
    const running = { ...pro, booted: true }
    expect(names(panelGroups([old, running, air, oldRunning], null))).toEqual([
      ['iOS 27.0', ['iPhone 18 Pro', 'iPad Air']],
      ['iOS 26.4', ['iPhone 16e']],
    ])
  })

  it('keeps a running device that the user unticked', () => {
    const selection = withDevices([oldRunning, pro], null, [oldRunning.udid], false)
    expect(names(panelGroups([oldRunning, pro], selection))).toEqual([['iOS 26.4', ['iPhone 16e']], ['iOS 27.0', ['iPhone 18 Pro']]])
  })

  it('leaves nothing when every stopped device is unticked', () => {
    let selection = withDevices([pro, base], null, [pro.udid], false)
    selection = withDevices([pro, base], selection, [base.udid], false)
    expect(panelGroups([pro, base], selection)).toEqual([])
  })

  it('remembers picks, turns on devices of a newer runtime, and keeps an older new runtime off', () => {
    const selection = withDevices([old, pro, base], null, [old.udid], true)
    expect(selection).toEqual({ shown: [old.udid, pro.udid, base.udid], hidden: [], runtime: 'iOS 27.0' })
    const unticked = withDevices([old, pro, base], selection, [base.udid], false)
    const newer = device('iPhone 19', 'iOS 28.0')
    const sameRuntime = device('iPhone Air', 'iOS 27.0')
    const older = device('iPhone 15', 'iOS 18.6')
    expect(names(panelGroups([old, pro, base, newer, sameRuntime, older], unticked))).toEqual([
      ['iOS 28.0', ['iPhone 19']],
      ['iOS 27.0', ['iPhone 18 Pro', 'iPhone Air']],
      ['iOS 26.4', ['iPhone 17']],
    ])
  })

  it('turns a whole runtime off at once', () => {
    const selection = withDevices([old, pro, base], null, [pro.udid, base.udid], false)
    expect(panelGroups([old, pro, base], selection)).toEqual([])
  })

  it('groups the Settings checklist newest runtime first', () => {
    expect(groupByRuntime([old, pro]).map((group) => group.runtime)).toEqual(['iOS 27.0', 'iOS 26.4'])
  })
})
