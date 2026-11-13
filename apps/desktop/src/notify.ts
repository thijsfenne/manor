import { app, BrowserWindow, ipcMain, Notification, type IpcMainInvokeEvent } from 'electron'
import type { DesktopDoneNotice } from '@manor/contracts'
import { NOTIFY_ACTIVATE_CHANNEL } from './notifyChannels'

/**
 * Done notices and the dock badge.
 *
 * The host owns exactly one rule here, and owns it because the renderer cannot:
 * a notice is dropped while the Manor window has focus. With the window in front
 * the row already says Done and the badge already counts it, so a system banner on
 * top of that is a second copy of news the user is looking at. Everything else —
 * which chat is done, how it should read — is decided in the renderer and arrives
 * finished.
 */
export function registerNotifyIpc(owner: () => BrowserWindow | null): void {
  ipcMain.handle('manor:notify:show', (event, notice: unknown) => {
    const window = ownedWindow(event, owner)
    const { chatId, title, body } = checkedNotice(notice)
    if (window.isFocused()) return
    if (!Notification.isSupported()) return
    const banner = new Notification({ title, body, groupId: chatId })
    banner.on('click', () => raise(owner(), chatId))
    banner.show()
  })

  ipcMain.handle('manor:notify:badge', (event, count: unknown) => {
    ownedWindow(event, owner)
    if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) {
      throw new Error('The dock badge needs a count.')
    }
    app.setBadgeCount(Math.floor(count))
  })
}

/**
 * A clicked notice has to land on the chat it was about, so this both raises the
 * window and tells the renderer where to go. `app.focus` is not redundant next to
 * `window.focus` on macOS: a window focused from a background app comes forward
 * without the app itself doing so, which is a click that half works.
 */
function raise(window: BrowserWindow | null, chatId: string): void {
  if (window === null || window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  window.show()
  if (process.platform === 'darwin') app.focus({ steal: true })
  window.focus()
  window.webContents.send(NOTIFY_ACTIVATE_CHANNEL, chatId)
}

function ownedWindow(event: IpcMainInvokeEvent, owner: () => BrowserWindow | null): BrowserWindow {
  const window = owner()
  if (window === null || window.isDestroyed() || event.sender.id !== window.webContents.id) {
    throw new Error('Notification IPC came from outside the Manor window.')
  }
  return window
}

function checkedNotice(value: unknown): DesktopDoneNotice {
  if (typeof value !== 'object' || value === null) throw new Error('A notice has to be an object.')
  const { chatId, title, body } = value as Record<string, unknown>
  if (typeof chatId !== 'string' || chatId === '') throw new Error('A notice needs a chat id.')
  if (typeof title !== 'string' || typeof body !== 'string') throw new Error('A notice needs a title and a body.')
  return { chatId, title, body }
}
