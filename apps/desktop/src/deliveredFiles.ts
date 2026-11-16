import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { app, dialog, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import type { DesktopFileResult } from '@manor/contracts'

/**
 * Only a signed link to a file a chat holds on a Manor server,
 * `/media/<chat>/<event>/<slot>/<signature>`: a delivered file (`f0`), a picture (its
 * index), a document (`d` and its index) or a text file (`t` and its index).
 */
const FILE_SLOT = /^(?:f0|[dt]?\d+)$/

export function checkedFileUrl(value: unknown): URL {
  if (typeof value !== 'string') throw new Error('A delivered file needs its link.')
  const url = new URL(value)
  const parts = url.pathname.split('/')
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || parts[1] !== 'media' || parts.length !== 6 || !FILE_SLOT.test(parts[4] ?? '')) {
    throw new Error('That is not a Manor file link.')
  }
  return url
}

/** A name that is safe as the last path segment on disk. */
export function safeFileName(value: unknown): string {
  const name = typeof value === 'string' ? path.basename(value).replace(/[/\\:\u0000-\u001f]/g, '-').trim() : ''
  return name === '' || name === '.' || name === '..' ? 'file' : name.slice(0, 160)
}

/** The sentence the user reads when the server cannot hand the file over. */
export function fetchFailure(status: number): string {
  return status === 404 ? 'This file is no longer available in Manor.' : `Manor could not fetch the file (HTTP ${status}).`
}

async function download(url: URL): Promise<Uint8Array | DesktopFileResult> {
  let response: Response
  try {
    response = await fetch(url, { cache: 'no-store' })
  } catch {
    return { ok: false, error: 'Manor could not reach its server to fetch the file.' }
  }
  if (!response.ok) return { ok: false, error: fetchFailure(response.status) }
  return new Uint8Array(await response.arrayBuffer())
}

/**
 * Open and Save for files a chat holds: what a persona delivered and what its library lists. Open writes a copy under the app's
 * temp folder, one folder per link so two files with one name never collide, and
 * lets macOS pick the app; the stored original in Manor stays the source.
 */
export function registerFileIpc(owner: () => BrowserWindow | null): void {
  const ownedWindow = (event: IpcMainInvokeEvent): BrowserWindow => {
    const window = owner()
    if (window === null || window.isDestroyed() || event.sender.id !== window.webContents.id) {
      throw new Error('File IPC came from outside the Manor window.')
    }
    return window
  }

  ipcMain.handle('manor:files:open', async (event, src: unknown, name: unknown): Promise<DesktopFileResult> => {
    ownedWindow(event)
    const url = checkedFileUrl(src)
    const bytes = await download(url)
    if (!(bytes instanceof Uint8Array)) return bytes
    const folder = path.join(app.getPath('temp'), 'manor-files', createHash('sha256').update(url.pathname).digest('hex').slice(0, 16))
    const target = path.join(folder, safeFileName(name))
    try {
      await mkdir(folder, { recursive: true })
      await writeFile(target, bytes)
    } catch {
      return { ok: false, error: 'Manor could not write a copy of the file to open.' }
    }
    const failure = await shell.openPath(target)
    return failure === '' ? { ok: true } : { ok: false, error: `macOS could not open ${path.basename(target)}: ${failure}` }
  })

  ipcMain.handle('manor:files:save', async (event, src: unknown, name: unknown): Promise<DesktopFileResult> => {
    const window = ownedWindow(event)
    const url = checkedFileUrl(src)
    const choice = await dialog.showSaveDialog(window, { defaultPath: path.join(app.getPath('downloads'), safeFileName(name)) })
    if (choice.canceled || choice.filePath === undefined) return { ok: true, canceled: true }
    const bytes = await download(url)
    if (!(bytes instanceof Uint8Array)) return bytes
    try {
      await writeFile(choice.filePath, bytes)
    } catch {
      return { ok: false, error: `Manor could not save to ${choice.filePath}.` }
    }
    return { ok: true }
  })
}
