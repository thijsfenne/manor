import { describe, expect, it, vi } from 'vitest'
import {
  isPermissionId, parseProbe, PERMISSION_PANES, PERMISSIONS_STATUS_CHANNEL, permissionState, permissionStatus,
  registerPermissionsIpc,
} from './systemPermissions'

const electron = vi.hoisted(() => ({ handlers: new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>() }))
const probe = vi.hoisted(() => ({ replies: [] as (string | null)[] }))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => Promise<unknown>) => electron.handlers.set(channel, handler) },
  shell: {},
  // The cached answer of a long-running process: never granted.
  systemPreferences: { isTrustedAccessibilityClient: () => false, getMediaAccessStatus: () => 'denied' },
}))
vi.mock('node:child_process', () => ({
  execFile: (_file: string, _args: string[], _options: unknown, done: (error: Error | null, stdout: string) => void) => {
    const reply = probe.replies.shift() ?? null
    done(reply === null ? new Error('probe failed') : null, reply ?? '')
  },
}))

describe('permissionState', () => {
  it('maps a grant, a visit to System Settings and neither to the three states', () => {
    expect(permissionState(true, false)).toBe('granted')
    // A grant wins over an earlier visit: the pending label must not outlive the grant.
    expect(permissionState(true, true)).toBe('granted')
    expect(permissionState(false, true)).toBe('pending')
    expect(permissionState(false, false)).toBe('not-granted')
  })

  it('keeps each permission to its own grant and visit', () => {
    expect(permissionStatus({ 'accessibility': true, 'screen-recording': false }, new Set(['screen-recording'])))
      .toEqual({ 'accessibility': 'granted', 'screen-recording': 'pending' })
    expect(permissionStatus({ 'accessibility': false, 'screen-recording': false }, new Set(['screen-recording'])))
      .toEqual({ 'accessibility': 'not-granted', 'screen-recording': 'pending' })
  })
})

describe('parseProbe', () => {
  it('reads the embedded driver probe line', () => {
    expect(parseProbe('{"accessibility":false,"screen_recording":true}\n'))
      .toEqual({ 'accessibility': false, 'screen-recording': true })
  })

  it('refuses anything that is not two booleans, so Electron answers instead', () => {
    for (const out of ['', 'not json', 'null', '{"accessibility":"yes","screen_recording":true}', '{"accessibility":true}']) {
      expect(parseProbe(out)).toBeNull()
    }
  })
})

describe('panes', () => {
  it('opens the exact Privacy & Security pane and accepts only known ids', () => {
    expect(PERMISSION_PANES['accessibility']).toMatch(/Privacy_Accessibility$/)
    expect(PERMISSION_PANES['screen-recording']).toMatch(/Privacy_ScreenCapture$/)
    expect(isPermissionId('accessibility')).toBe(true)
    expect(isPermissionId('camera')).toBe(false)
    expect(isPermissionId(undefined)).toBe(false)
  })
})

describe('registerPermissionsIpc', () => {
  it('restarts the daemon once when a fresh probe shows a grant, never on a failed probe', async () => {
    const window = { isDestroyed: () => false, webContents: { id: 7 } }
    const onGranted = vi.fn()
    registerPermissionsIpc({ owner: () => window as never, driver: '/app/cua-driver', onGranted })
    const status = electron.handlers.get(PERMISSIONS_STATUS_CHANNEL)
    const read = () => status?.({ sender: { id: 7 } })
    probe.replies.push(
      '{"accessibility":true,"screen_recording":false}',
      '{"accessibility":true,"screen_recording":true}',
      null,
      '{"accessibility":true,"screen_recording":true}',
    )
    expect(await read()).toEqual({ 'accessibility': 'granted', 'screen-recording': 'not-granted' })
    expect(await read()).toEqual({ 'accessibility': 'granted', 'screen-recording': 'granted' })
    expect(onGranted).toHaveBeenCalledTimes(1)
    // A failed probe answers from Electron, but must not count as the grants going away and coming back.
    expect(await read()).toEqual({ 'accessibility': 'not-granted', 'screen-recording': 'not-granted' })
    await read()
    expect(onGranted).toHaveBeenCalledTimes(1)
    await expect(status?.({ sender: { id: 8 } })).rejects.toThrow('outside the Manor window')
  })
})

