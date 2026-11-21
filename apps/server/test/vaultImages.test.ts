import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ServerMessage } from '@manor/contracts'
import { HostModule } from '../src/hostModule.js'
import { listVaultFiles, openVault, readAttachmentSetting, saveVaultImage, type Vault } from '../src/vault.js'

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24)])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])

let root: string
let outside: string
let vault: Vault

const put = (relative: string, body: string | Buffer = '') => {
  const target = path.join(root, relative)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, body)
}
const settings = (attachmentFolderPath: string) => put('.obsidian/app.json', JSON.stringify({ attachmentFolderPath }))
const save = async (notePath: string, name: string, bytes: Buffer = PNG) =>
  saveVaultImage(vault, { notePath, name, bytes, existingImages: (await listVaultFiles(vault)).images })

beforeEach(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), 'manor-vaultimg-'))
  outside = mkdtempSync(path.join(os.tmpdir(), 'manor-vaultimg-out-'))
  put('research/plan.md', '# plan\n')
  put('top.md', '# top\n')
  const opened = await openVault(root)
  if (!opened.ok) throw new Error(opened.message)
  vault = opened.vault
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

describe('listing pictures', () => {
  it('lists pictures sorted, outside the note list, and skips dot folders', async () => {
    put('b.png', PNG)
    put('sub/a.JPG', JPEG)
    put('sub/readme.txt', 'x')
    put('.obsidian/hidden.png', PNG)
    put('.trash/gone.webp', PNG)
    const listing = await listVaultFiles(vault)
    expect(listing.images).toEqual(['b.png', 'sub/a.JPG'])
    expect(listing.files).not.toContain('b.png')
  })
})

describe('readAttachmentSetting', () => {
  it('reads the folder, and is undefined for a missing, broken or non-string setting', async () => {
    expect(await readAttachmentSetting(vault)).toBeUndefined()
    put('.obsidian/app.json', '{ nope')
    expect(await readAttachmentSetting(vault)).toBeUndefined()
    put('.obsidian/app.json', JSON.stringify({ attachmentFolderPath: 3 }))
    expect(await readAttachmentSetting(vault)).toBeUndefined()
    settings('+')
    expect(await readAttachmentSetting(vault)).toBe('+')
  })
})

describe('saveVaultImage', () => {
  it('saves into the folder named by the vault setting', async () => {
    settings('+')
    const result = await save('research/plan.md', 'shot.png')
    expect(result).toEqual({ status: 'saved', path: '+/shot.png', name: 'shot.png' })
    expect(readFileSync(path.join(root, '+', 'shot.png')).equals(PNG)).toBe(true)
  })

  it('saves at the vault root when no setting exists', async () => {
    expect(await save('research/plan.md', 'shot.png')).toEqual({ status: 'saved', path: 'shot.png', name: 'shot.png' })
    expect(existsSync(path.join(root, 'shot.png'))).toBe(true)
  })

  it('saves under the note folder for a relative setting', async () => {
    settings('./sub')
    expect(await save('research/plan.md', 'shot.png')).toMatchObject({ status: 'saved', path: 'research/sub/shot.png' })
  })

  it('keeps names unique across every picture in the vault, case-insensitively', async () => {
    put('elsewhere/Shot.PNG', PNG)
    expect(await save('top.md', 'shot.png')).toMatchObject({ name: 'shot 1.png' })
    expect(await save('top.md', 'shot.png')).toMatchObject({ name: 'shot 2.png' })
  })

  it('does not overwrite a file already in the folder', async () => {
    put('shot.png', 'precious')
    // A stale listing would not show it; the exclusive create still must not replace it.
    const result = await saveVaultImage(vault, { notePath: 'top.md', name: 'shot.png', bytes: PNG, existingImages: [] })
    expect(result).toMatchObject({ status: 'saved', name: 'shot 1.png' })
    expect(readFileSync(path.join(root, 'shot.png'), 'utf8')).toBe('precious')
  })

  it('refuses bytes that are not a picture, whatever the name says', async () => {
    const result = await save('top.md', 'fake.png', Buffer.from('<svg></svg>'))
    expect(result).toMatchObject({ status: 'rejected' })
    expect(readdirSync(root)).not.toContain('fake.png')
  })

  it('forces the extension to match the bytes and strips what a link cannot carry', async () => {
    expect(await save('top.md', 'a/b/we[ir]d #na^me|x:y.png', JPEG)).toMatchObject({ name: 'weird namexy.jpg' })
  })

  it('names an unnamed paste the way Obsidian does', async () => {
    const result = await saveVaultImage(vault, { notePath: 'top.md', name: '.png', bytes: PNG, existingImages: [], now: new Date(2026, 0, 2, 3, 4, 5) })
    expect(result).toMatchObject({ name: 'Pasted image 20260102030405.png' })
  })

  it('refuses a missing note, a hidden folder and a folder that climbs out of the vault', async () => {
    expect(await save('missing.md', 'a.png')).toMatchObject({ status: 'rejected' })
    settings('../elsewhere')
    expect(await save('top.md', 'a.png')).toMatchObject({ status: 'rejected' })
    settings('.hidden')
    expect(await save('top.md', 'a.png')).toMatchObject({ status: 'rejected' })
    expect(existsSync(path.join(root, '.hidden'))).toBe(false)
  })

  it('refuses an attachment folder reached through a symlink out of the vault', async () => {
    symlinkSync(outside, path.join(root, 'linked'))
    settings('linked/deeper')
    expect(await save('top.md', 'a.png')).toMatchObject({ status: 'rejected' })
    expect(readdirSync(outside)).toEqual([])
  })
})

describe('host module pictures', () => {
  it('saves a pasted data URL, answers with its link and broadcasts a listing that carries it', async () => {
    settings('assets')
    const sent: ServerMessage[] = []
    const replies: ServerMessage[] = []
    const host = new HostModule({ vault, imageSrc: (image) => `/link/${image}`, broadcast: (message) => sent.push(message) })
    await host.handle({ type: 'save_vault_image', requestId: 'r1', notePath: 'top.md', name: 'shot.png', dataUrl: `data:image/png;base64,${PNG.toString('base64')}` }, (message) => replies.push(message))
    expect(replies).toEqual([{ type: 'vault_image_saved', requestId: 'r1', result: { status: 'saved', path: 'assets/shot.png', name: 'shot.png' } }])
    expect(sent).toEqual([expect.objectContaining({ type: 'vault_files', images: { 'assets/shot.png': '/link/assets/shot.png' }, attachmentFolder: 'assets' })])
  })

  it('rejects a data URL whose bytes are not a picture', async () => {
    const replies: ServerMessage[] = []
    const host = new HostModule({ vault, imageSrc: (image) => image })
    await host.handle({ type: 'save_vault_image', requestId: 'r2', notePath: 'top.md', name: 'x.png', dataUrl: `data:image/png;base64,${Buffer.from('text').toString('base64')}` }, (message) => replies.push(message))
    expect(replies).toEqual([expect.objectContaining({ type: 'vault_image_saved', result: expect.objectContaining({ status: 'rejected' }) })])
  })
})
