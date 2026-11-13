import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { listDirectories } from '../src/browse.js'

/**
 * A folder built here rather than anywhere real: the picker has to behave the same
 * on the laptop and on the VPS, so nothing may depend on what the user's home happens
 * to contain. The names are deliberately mixed-case, because an ASCII sort orders
 * them Beta, Zulu, alpha, mirror and a case-insensitive one does not.
 */
let folder: string
let file: string
let locked: string

const names = (result: Awaited<ReturnType<typeof listDirectories>>) =>
  result.ok ? result.entries.map((entry) => entry.name) : []

beforeAll(() => {
  folder = mkdtempSync(path.join(os.tmpdir(), 'manor-browse-'))
  for (const name of ['Zulu', 'alpha', 'Beta', '.hidden']) mkdirSync(path.join(folder, name))
  file = path.join(folder, 'notes.md')
  writeFileSync(file, 'not a folder\n', 'utf8')
  writeFileSync(path.join(folder, '.env'), 'SECRET=nothing-real\n', 'utf8')
  symlinkSync(path.join(folder, 'Beta'), path.join(folder, 'mirror'))
  symlinkSync(file, path.join(folder, 'note-link'))
  symlinkSync(path.join(folder, 'gone'), path.join(folder, 'dangling'))

  locked = mkdtempSync(path.join(os.tmpdir(), 'manor-browse-locked-'))
  chmodSync(locked, 0o000)
})

afterAll(() => {
  // Left readable, or the temp cleanup that runs later cannot get in.
  chmodSync(locked, 0o700)
})

describe('listDirectories', () => {
  it('starts in the server user home when no path is given', async () => {
    const result = await listDirectories()

    expect(result.ok).toBe(true)
    expect(result.ok ? result.path : '').toBe(os.homedir())
    expect(result.ok ? result.parent : '').toBe(path.dirname(os.homedir()))
  })

  it('treats a blank path as no path at all', async () => {
    const result = await listDirectories('   ')

    expect(result.ok ? result.path : '').toBe(os.homedir())
  })

  it('lists subdirectories only, skips dotfiles, and sorts case-insensitively', async () => {
    const result = await listDirectories(folder)

    // `mirror` is a symlink to a folder and counts; the file, the link to it, the
    // dangling link and everything starting with a dot do not.
    expect(names(result)).toEqual(['alpha', 'Beta', 'mirror', 'Zulu'])
    expect(result.ok ? result.entries.map((entry) => entry.path) : []).toEqual([
      path.join(folder, 'alpha'),
      path.join(folder, 'Beta'),
      path.join(folder, 'mirror'),
      path.join(folder, 'Zulu'),
    ])
  })

  it('normalises what it was handed and reports the folder above it', async () => {
    const result = await listDirectories(`${folder}/alpha/../`)

    expect(result.ok ? result.path : '').toBe(folder)
    expect(result.ok ? result.parent : '').toBe(path.dirname(folder))
  })

  it('has no parent at the filesystem root, which is where the up control stops', async () => {
    const root = path.parse(folder).root

    const result = await listDirectories(root)

    expect(result.ok).toBe(true)
    expect(result.ok ? result.parent : 'not null').toBeNull()
  })

  it('refuses a relative path, because the server has no folder to read it against', async () => {
    const result = await listDirectories('Ontwikkeling/Manor')

    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.message).toContain('Ontwikkeling/Manor is not an absolute path')
  })

  it('says so when there is nothing at the path', async () => {
    const missing = path.join(folder, 'no-such-folder')

    expect(await listDirectories(missing)).toEqual({ ok: false, message: `There is nothing at ${missing}.` })
  })

  it('refuses a file, which has nothing to list', async () => {
    expect(await listDirectories(file)).toEqual({ ok: false, message: `${file} is a file, not a folder.` })
  })

  // Running as root defeats the mode bits, so the case cannot be staged there.
  it.skipIf(process.getuid?.() === 0)('answers an unreadable folder instead of throwing', async () => {
    const result = await listDirectories(locked)

    expect(result).toEqual({ ok: false, message: `Manor is not allowed to read ${locked}.` })
  })
})
