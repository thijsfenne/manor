import { execFile } from 'node:child_process'
import type { DesktopPermissionId, DesktopPermissionState, DesktopPermissionStatus } from '@manor/contracts'
import { ipcMain, shell, systemPreferences, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'

export const PERMISSIONS_STATUS_CHANNEL = 'manor:permissions:status'
export const PERMISSIONS_OPEN_CHANNEL = 'manor:permissions:open'

/** The exact Privacy & Security pane per permission. */
export const PERMISSION_PANES: Record<DesktopPermissionId, string> = {
  'accessibility': 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  'screen-recording': 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
}

export type Grants = Record<DesktopPermissionId, boolean>

/** Granted wins; otherwise pending once the user was sent to System Settings for it. */
export function permissionState(granted: boolean, opened: boolean): DesktopPermissionState {
  if (granted) return 'granted'
  return opened ? 'pending' : 'not-granted'
}

export function permissionStatus(grants: Grants, opened: ReadonlySet<DesktopPermissionId>): DesktopPermissionStatus {
  return {
    'accessibility': permissionState(grants['accessibility'], opened.has('accessibility')),
    'screen-recording': permissionState(grants['screen-recording'], opened.has('screen-recording')),
  }
}

export function isPermissionId(value: unknown): value is DesktopPermissionId {
  return value === 'accessibility' || value === 'screen-recording'
}

/** The embedded driver's probe output: `{"accessibility":bool,"screen_recording":bool}`. */
export function parseProbe(stdout: string): Grants | null {
  try {
    const parsed: unknown = JSON.parse(stdout)
    if (typeof parsed !== 'object' || parsed === null) return null
    const { accessibility, screen_recording: screen } = parsed as Record<string, unknown>
    return typeof accessibility === 'boolean' && typeof screen === 'boolean'
      ? { 'accessibility': accessibility, 'screen-recording': screen }
      : null
  } catch {
    return null
  }
}

/**
 * Asks a fresh child process. macOS caches a negative Screen Recording answer inside
 * the process that asked, so this app's own answer would stay "no" until a restart;
 * a new child of Manor reads Manor's grant as it is now. The embedded driver ships
 * that probe; without it (a checkout) Electron's own answer is the best there is.
 */
function probeDriver(driver: string): Promise<Grants | null> {
  return new Promise((resolve) => {
    execFile(driver, ['--cua-internal-permission-probe'], { timeout: 5_000 }, (error, stdout) => {
      resolve(error === null ? parseProbe(stdout) : null)
    })
  })
}

function electronGrants(): Grants {
  return {
    'accessibility': systemPreferences.isTrustedAccessibilityClient(false),
    'screen-recording': systemPreferences.getMediaAccessStatus('screen') === 'granted',
  }
}

/**
 * Settings reads the status while its Permissions page is open. A grant that arrived
 * since the previous read also restarts the embedded daemon (`onGranted`).
 */
export function registerPermissionsIpc(options: {
  owner: () => BrowserWindow | null
  driver: string | null
  onGranted?: () => void
}): void {
  const opened = new Set<DesktopPermissionId>()
  let last: Grants | null = null
  const fromManor = (event: IpcMainInvokeEvent) => {
    const window = options.owner()
    if (window === null || window.isDestroyed() || event.sender.id !== window.webContents.id) {
      throw new Error('Permissions IPC came from outside the Manor window.')
    }
  }
  ipcMain.handle(PERMISSIONS_STATUS_CHANNEL, async (event) => {
    fromManor(event)
    const probed = options.driver === null ? null : await probeDriver(options.driver)
    // Only a fresh probe can show a grant arriving; Electron's own answer may be the stale one.
    if (probed !== null) {
      const arrived = last !== null &&
        ((probed['accessibility'] && !last['accessibility']) || (probed['screen-recording'] && !last['screen-recording']))
      last = probed
      if (arrived) options.onGranted?.()
    }
    return permissionStatus(probed ?? electronGrants(), opened)
  })
  ipcMain.handle(PERMISSIONS_OPEN_CHANNEL, async (event, id: unknown) => {
    fromManor(event)
    if (!isPermissionId(id)) throw new Error('Unknown permission.')
    opened.add(id)
    await shell.openExternal(PERMISSION_PANES[id])
  })
}
