import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { localAccessFile, readLocalAccess } from './localAccess'

vi.mock('electron', () => ({ ipcMain: {} }))

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('local access for the desktop shell', () => {
  it('looks in the data directory the server uses', () => {
    expect(localAccessFile({}, '/Users/someone')).toBe('/Users/someone/.manor/local-access-token')
    expect(localAccessFile({ MANOR_DATA_DIR: '/tmp/spike' }, '/Users/someone')).toBe('/tmp/spike/local-access-token')
  })

  it('returns the key, and null when the server wrote none', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'manor-access-'))
    dirs.push(dir)
    const file = path.join(dir, 'local-access-token')

    await expect(readLocalAccess(file)).resolves.toBeNull()
    writeFileSync(file, 'the-key\n')
    await expect(readLocalAccess(file)).resolves.toBe('the-key')
    writeFileSync(file, '\n')
    await expect(readLocalAccess(file)).resolves.toBeNull()
  })
})
