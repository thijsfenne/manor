import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SimulatorState } from '@manor/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSimulatorHost, parseSimctlDevices, type SimulatorDeps } from '../src/simulator.js'

const BOOTED = '47EBE75E-A16D-4500-9F6E-D2DDB3213A09'
const OFF = '451619AF-23F7-42D6-BF2D-8633D5912F8D'

const simctlJson = (bootedState = 'Booted') => JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-26-1': [{ udid: OFF, name: 'iPhone 17', state: 'Shutdown', isAvailable: true }],
    'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [{ udid: BOOTED, name: 'iPhone 18 Pro', state: bootedState, isAvailable: true }],
    'com.apple.CoreSimulator.SimRuntime.watchOS-12-0': [{ udid: 'F0000000-0000-0000-0000-000000000000', name: 'Watch', state: 'Booted', isAvailable: true }],
  },
})

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function setup(overrides: Partial<SimulatorDeps> = {}) {
  const toolsDir = mkdtempSync(path.join(os.tmpdir(), 'manor-sim-'))
  dirs.push(toolsDir)
  const states: SimulatorState[] = []
  const commands: string[] = []
  const stopHub = vi.fn()
  const deps: SimulatorDeps = {
    platform: 'darwin',
    arch: 'arm64',
    toolsDir,
    run: async (command, args) => {
      commands.push([command, ...args].join(' '))
      return args.includes('list') ? simctlJson() : ''
    },
    download: async () => Buffer.from('not the pinned package'),
    startHub: vi.fn(async () => ({ port: 4100, stop: stopHub })),
    attach: vi.fn(async () => undefined),
    ...overrides,
  }
  const host = createSimulatorHost({ deps, broadcast: (state) => states.push(state), streamBase: () => '/simulator/t.sig' })
  return { host, deps, states, commands, stopHub, last: () => states.at(-1) }
}

describe('parseSimctlDevices', () => {
  it('keeps iOS simulators only, booted first, with a short runtime name', () => {
    expect(parseSimctlDevices(simctlJson())).toEqual([
      { udid: BOOTED, name: 'iPhone 18 Pro', runtime: 'iOS 27.0', booted: true },
      { udid: OFF, name: 'iPhone 17', runtime: 'iOS 26.1', booted: false },
    ])
  })
})

describe('simulator host', () => {
  it('runs nothing while the Settings toggle is off', async () => {
    const { host, commands, last } = setup()
    await host.handle('list')
    expect(last()).toEqual({ status: 'off', devices: [] })
    expect(commands).toEqual([])
  })

  it('lists devices once on, without starting the screen helper', async () => {
    const { host, deps, last } = setup()
    host.setEnabled(true)
    await host.handle('list')
    expect(last()?.status).toBe('ready')
    expect(last()?.devices.map((device) => device.udid)).toEqual([BOOTED, OFF])
    expect(deps.startHub).not.toHaveBeenCalled()
  })

  it('says what is missing when Xcode does not answer', async () => {
    const { host, last } = setup({ run: async () => { throw new Error('xcrun: error: unable to find utility "simctl"') } })
    host.setEnabled(true)
    await host.handle('list')
    expect(last()?.status).toBe('unavailable')
    expect(last()?.detail).toContain('Install Xcode')
  })

  it('refuses a helper download that does not match its pinned hash, and starts nothing', async () => {
    const { host, deps, last } = setup()
    host.setEnabled(true)
    await host.handle('watch', BOOTED)
    expect(last()?.error).toContain('did not match its pinned hash')
    expect(last()?.stream).toBeUndefined()
    expect(deps.startHub).not.toHaveBeenCalled()
  })

  it('watches an installed device through a signed base, and turning off stops the helper', async () => {
    const { host, deps, stopHub, last } = setup()
    const dist = path.join(deps.toolsDir, 'serve-sim', '0.1.49', 'node_modules', 'serve-sim', 'dist')
    mkdirSync(dist, { recursive: true })
    writeFileSync(path.join(dist, 'serve-sim.js'), '')
    host.setEnabled(true)

    await host.handle('watch', BOOTED)
    expect(last()?.stream).toEqual({ udid: BOOTED, base: '/simulator/t.sig' })
    expect(deps.attach).toHaveBeenCalledWith(4100, BOOTED)
    expect(host.hubPort()).toBe(4100)

    host.setEnabled(false)
    expect(stopHub).toHaveBeenCalled()
    expect(host.hubPort()).toBeUndefined()
    expect(last()).toEqual({ status: 'off', devices: [] })
  })

  it('refuses to watch a device that is not booted', async () => {
    const { host, deps, last } = setup()
    host.setEnabled(true)
    await host.handle('watch', OFF)
    expect(last()?.error).toBe('Start this simulator first.')
    expect(deps.startHub).not.toHaveBeenCalled()
  })

  it('boots a listed device with simctl, then waits for the boot to finish', async () => {
    const { host, commands } = setup()
    host.setEnabled(true)
    await host.handle('list')
    await host.handle('boot', OFF)
    expect(commands.slice(1, 3)).toEqual([`/usr/bin/xcrun simctl boot ${OFF}`, `/usr/bin/xcrun simctl bootstatus ${OFF}`])
  })

  it('puts a failed boot on the device row with the boot\'s own reason', async () => {
    const { host, last } = setup({
      run: async (_command, args) => {
        if (args.includes('list')) return simctlJson()
        if (args.includes('boot')) throw new Error('An error was encountered processing the command (code=405):\nUnable to boot: runtime is not available')
        throw new Error('bootstatus gave up')
      },
    })
    host.setEnabled(true)
    await host.handle('list')
    await host.handle('boot', OFF)
    expect(last()).toMatchObject({ status: 'ready', error: 'The simulator did not start: An error was encountered processing the command (code=405): Unable to boot: runtime is not available', errorUdid: OFF })
    expect(last()?.pending).toBeUndefined()
  })

  it('clears the boot step when the device stopped again before its screen opened', async () => {
    let listings = 0
    const { host, last } = setup({
      // The first listing sees the device off, the one after the boot sees it off again.
      run: async (_command, args) => { if (args.includes('list')) listings += 1; return args.includes('list') ? simctlJson('Shutdown') : '' },
    })
    host.setEnabled(true)
    await host.handle('list')
    await host.handle('boot', OFF)
    expect(listings).toBe(2)
    expect(last()).toMatchObject({ error: 'Start this simulator first.', errorUdid: OFF })
    expect(last()?.pending).toBeUndefined()
  })

  it('puts a helper exit on the device it was showing last, not the one it started with', async () => {
    const second = '5F3A1B2C-0000-4000-8000-000000000001'
    let exit = () => {}
    const { host, deps, last } = setup({
      run: async (_command, args) => args.includes('list')
        ? JSON.stringify({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [
          { udid: BOOTED, name: 'iPhone 18 Pro', state: 'Booted', isAvailable: true },
          { udid: second, name: 'iPhone 18', state: 'Booted', isAvailable: true },
        ] } })
        : '',
      startHub: vi.fn(async (_entry: string, _udid: string, onExit: () => void) => { exit = onExit; return { port: 4100, stop: () => {} } }),
    })
    const dist = path.join(deps.toolsDir, 'serve-sim', '0.1.49', 'node_modules', 'serve-sim', 'dist')
    mkdirSync(dist, { recursive: true })
    writeFileSync(path.join(dist, 'serve-sim.js'), '')
    host.setEnabled(true)
    await host.handle('watch', BOOTED)
    await host.handle('watch', second)
    exit()
    expect(last()).toMatchObject({ errorUdid: second })
    expect(last()?.stream).toBeUndefined()
  })

  it('refuses to boot or turn off a device the iOS listing does not hold', async () => {
    const { host, commands, last } = setup()
    host.setEnabled(true)
    await host.handle('list')
    await host.handle('shutdown', 'F0000000-0000-0000-0000-000000000000')
    expect(last()?.error).toBe('Choose a simulator from the list.')
    expect(commands.filter((command) => command.includes('shutdown'))).toEqual([])
  })

  it('keeps the state off when a listing finishes after the toggle went off', async () => {
    let answer: (json: string) => void = () => {}
    let started: () => void = () => {}
    const listingStarted = new Promise<void>((resolve) => { started = resolve })
    const { host, last } = setup({ run: () => new Promise((resolve) => { answer = resolve; started() }) })
    host.setEnabled(true)
    const listing = host.handle('list')
    // The listing is under way, past the toggle check, when the toggle goes off.
    await listingStarted
    host.setEnabled(false)
    answer(simctlJson())
    await listing
    expect(last()).toEqual({ status: 'off', devices: [] })
  })
})
