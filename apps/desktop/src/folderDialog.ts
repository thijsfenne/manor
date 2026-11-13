import { dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent, type OpenDialogOptions, type OpenDialogReturnValue } from 'electron'

export const CHOOSE_FOLDER_CHANNEL = 'manor:choose-folder'

/**
 * The Finder folder dialog, attached to the Manor window. Resolves the absolute path
 * The user picked, or null on cancel; the web side feeds it into the same link flow as a
 * pasted path, so the server's validation stays the single judge of a usable folder.
 */
export async function chooseFolder(
  window: BrowserWindow,
  show: (window: BrowserWindow, options: OpenDialogOptions) => Promise<OpenDialogReturnValue>,
): Promise<string | null> {
  const choice = await show(window, { properties: ['openDirectory', 'createDirectory'] })
  if (choice.canceled) return null
  return choice.filePaths[0] ?? null
}

export function registerFolderDialogIpc(owner: () => BrowserWindow | null): void {
  ipcMain.handle(CHOOSE_FOLDER_CHANNEL, (event: IpcMainInvokeEvent) => {
    const window = owner()
    if (window === null || window.isDestroyed() || event.sender.id !== window.webContents.id) {
      throw new Error('Folder dialog IPC came from outside the Manor window.')
    }
    return chooseFolder(window, (parent, options) => dialog.showOpenDialog(parent, options))
  })
}
