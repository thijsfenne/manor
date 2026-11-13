import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'

export const LOCAL_ACCESS_CHANNEL = 'manor:local-access'

/** Where the local server keeps its key; `apps/server/src/localAccess.ts` writes the same file. */
export function localAccessFile(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  return path.join(env['MANOR_DATA_DIR'] || path.join(home, '.manor'), 'local-access-token')
}

/**
 * The key the server on this Mac wrote for its own desktop shell, or null when there
 * is none (a server with auth off, or one that has not started yet). The web side then
 * falls back to the sign-in form.
 */
export async function readLocalAccess(file: string): Promise<string | null> {
  try {
    const token = (await readFile(file, 'utf8')).trim()
    return token.length > 0 ? token : null
  } catch {
    return null
  }
}

export function registerLocalAccessIpc(owner: () => BrowserWindow | null): void {
  ipcMain.handle(LOCAL_ACCESS_CHANNEL, (event: IpcMainInvokeEvent) => {
    const window = owner()
    if (window === null || window.isDestroyed() || event.sender.id !== window.webContents.id) {
      throw new Error('Local access IPC came from outside the Manor window.')
    }
    return readLocalAccess(localAccessFile())
  })
}
