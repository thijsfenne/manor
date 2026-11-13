import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { chooseFolder } from './folderDialog'

vi.mock('electron', () => ({ dialog: {}, ipcMain: {} }))

const owner = {} as BrowserWindow

describe('native folder dialog', () => {
  it('returns the chosen path and asks for a folder, attached to the window', async () => {
    const show = vi.fn().mockResolvedValue({ canceled: false, filePaths: ['/Users/sam/Work'] })
    await expect(chooseFolder(owner, show)).resolves.toBe('/Users/sam/Work')
    expect(show).toHaveBeenCalledWith(owner, { properties: ['openDirectory', 'createDirectory'] })
  })

  it('returns null on cancel, even if a path is present', async () => {
    const show = vi.fn().mockResolvedValue({ canceled: true, filePaths: ['/Users/sam/Work'] })
    await expect(chooseFolder(owner, show)).resolves.toBeNull()
  })

  it('returns null when the dialog answers with no path', async () => {
    const show = vi.fn().mockResolvedValue({ canceled: false, filePaths: [] })
    await expect(chooseFolder(owner, show)).resolves.toBeNull()
  })
})
