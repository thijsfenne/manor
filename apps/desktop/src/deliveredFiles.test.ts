import { describe, expect, it, vi } from 'vitest'
import { checkedFileUrl, fetchFailure, safeFileName } from './deliveredFiles'

// Hoisted above the import: the helpers under test never touch Electron.
vi.mock('electron', () => ({ app: {}, dialog: {}, ipcMain: {}, shell: {} }))

describe('delivered files on the Mac', () => {
  it('accepts only a signed link to a file a chat holds', () => {
    for (const slot of ['f0', '0', '3', 'd1', 't0']) {
      expect(checkedFileUrl(`http://127.0.0.1:8787/media/chat/evt/${slot}/sig`).pathname).toBe(`/media/chat/evt/${slot}/sig`)
    }
    for (const bad of ['file:///etc/passwd', 'http://127.0.0.1:8787/media/chat/evt/e/sig', 'http://127.0.0.1:8787/media/chat/evt/f1/sig', 'http://127.0.0.1:8787/internal/deliver-file', 42]) {
      expect(() => checkedFileUrl(bad)).toThrow()
    }
  })

  it('keeps a name to one safe segment and explains a missing file', () => {
    expect(safeFileName('../../Q3: cijfers.xlsx')).toBe('Q3- cijfers.xlsx')
    expect(safeFileName('..')).toBe('file')
    expect(fetchFailure(404)).toBe('This file is no longer available in Manor.')
    expect(fetchFailure(500)).toContain('HTTP 500')
  })
})
