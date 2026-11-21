import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { MAX_REPO_FILE_BYTES } from '@manor/contracts'
import { realMoveFs, type MoveFs } from '../src/fileIo.js'
import { MAX_VAULT_FILES, createVaultFolder, deleteVaultEntry, moveEntry, moveVaultEntry, notePreview, renameVaultFile, listVaultFiles, openVault, readVaultFile, writeVaultFile, type Vault } from '../src/vault.js'

/**
 * A scratch vault, never the real one. Every write test here would otherwise be a
 * write into the user's actual notes, and the whole point of the revision check is that
 * something else on the machine is allowed to be editing them.
 */
let vault: Vault
let root: string
/** A folder outside the vault, so "escapes the vault" can be a real escape. */
let outside: string

const note = (relative: string, body: string) => {
  const target = path.join(root, relative)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, body, 'utf8')
  return target
}

const open = async (dir: string): Promise<Vault> => {
  const opened = await openVault(dir)
  if (!opened.ok) throw new Error(opened.message)
  return opened.vault
}

beforeEach(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), 'manor-vault-'))
  outside = mkdtempSync(path.join(os.tmpdir(), 'manor-outside-'))
  writeFileSync(path.join(outside, 'secrets.md'), 'nothing-real\n', 'utf8')

  note('inbox/today.md', '# today\n')
  note('research/wiki/rag.md', '---\ntags: [ai]\n---\n\nbody\n')
  note('.obsidian/workspace.md', 'not a note\n')
  note('.trash/deleted.md', 'gone\n')
  writeFileSync(path.join(root, 'cover.png'), Buffer.from([137, 80, 78, 71]))

  vault = await open(root)
})

describe('openVault', () => {
  it('resolves the root through symlinks and names the tab after the folder', async () => {
    // The real vault sits under iCloud Drive, which is symlinks most of the way
    // down. If the root were kept unresolved, every containment check below would
    // compare a resolved path against an unresolved prefix and refuse everything.
    const link = path.join(outside, 'link-to-vault')
    symlinkSync(root, link)

    const opened = await open(link)

    expect(opened.root).toBe(await open(root).then((it) => it.root))
    expect(opened.name).toBe(path.basename(root))
  })

  it('says a missing folder is not a vault instead of throwing', async () => {
    const result = await openVault(path.join(os.tmpdir(), 'manor-vault-does-not-exist'))
    expect(result).toMatchObject({ ok: false })
  })

  it('refuses a file, because a vault is a folder', async () => {
    const result = await openVault(path.join(root, 'inbox', 'today.md'))
    expect(result).toMatchObject({ ok: false })
  })
})

describe('listVaultFiles', () => {
  it('lists notes as root-relative paths, sorted', async () => {
    const { files } = await listVaultFiles(vault)
    expect(files).toEqual(['inbox/today.md', 'research/wiki/rag.md'])
  })

  // One rule, not a list of Obsidian's special folders to keep in sync: .obsidian is
  // config and .trash is notes Obsidian has already deleted. Neither is a note.
  it('skips dot-folders, so .obsidian and .trash never reach the tree', async () => {
    const { files } = await listVaultFiles(vault)
    expect(files.some((file) => file.startsWith('.'))).toBe(false)
  })

  it('skips attachments, because only markdown is in scope', async () => {
    const { files } = await listVaultFiles(vault)
    expect(files.some((file) => file.endsWith('.png'))).toBe(false)
  })

  it('says so when the cap cut the list rather than implying it saw everything', async () => {
    for (let index = 0; index <= MAX_VAULT_FILES; index += 1) {
      writeFileSync(path.join(root, `note-${index}.md`), 'x\n', 'utf8')
    }
    const listing = await listVaultFiles(vault)
    expect(listing.files.length).toBeLessThanOrEqual(MAX_VAULT_FILES)
    expect(listing.truncated).toBe(true)
  })
})

describe('readVaultFile guard', () => {
  it('reads a note and hands back the hash of its bytes', async () => {
    const result = await readVaultFile(vault, 'inbox/today.md')
    expect(result).toEqual({
      status: 'ready',
      content: '# today\n',
      revision: createHash('sha256').update(Buffer.from('# today\n', 'utf8')).digest('hex'),
    })
  })

  it('refuses a traversal out of the vault', async () => {
    const escape = `..${path.sep}${path.basename(outside)}/secrets.md`.split(path.sep).join('/')
    expect(await readVaultFile(vault, escape)).toMatchObject({ status: 'unavailable' })
  })

  it('refuses an absolute path', async () => {
    expect(await readVaultFile(vault, path.join(outside, 'secrets.md'))).toMatchObject({ status: 'unavailable' })
  })

  it('refuses a note that is a symlink pointing out of the vault', async () => {
    symlinkSync(path.join(outside, 'secrets.md'), path.join(root, 'leak.md'))
    expect(await readVaultFile(vault, 'leak.md')).toMatchObject({ status: 'unavailable' })
  })

  // The reason the guard resolves the PARENT rather than trusting O_NOFOLLOW alone:
  // the final component is an ordinary file, so nothing about opening it looks wrong.
  it('refuses a note reached through a symlinked folder pointing out of the vault', async () => {
    symlinkSync(outside, path.join(root, 'elsewhere'))
    expect(await readVaultFile(vault, 'elsewhere/secrets.md')).toMatchObject({ status: 'unavailable' })
  })

  it('refuses a hand-crafted path into .obsidian that the tree never offered', async () => {
    expect(await readVaultFile(vault, '.obsidian/workspace.md')).toMatchObject({ status: 'unavailable' })
  })

  it('refuses anything that is not markdown', async () => {
    expect(await readVaultFile(vault, 'cover.png')).toMatchObject({ status: 'unavailable' })
  })

  it('reports a note over the cap without putting it on the wire', async () => {
    writeFileSync(path.join(root, 'huge.md'), Buffer.alloc(MAX_REPO_FILE_BYTES + 1, 97))
    expect(await readVaultFile(vault, 'huge.md')).toEqual({
      status: 'too_large',
      size: MAX_REPO_FILE_BYTES + 1,
      maxSize: MAX_REPO_FILE_BYTES,
    })
  })
})

const revisionOf = async (relative: string) => {
  const result = await readVaultFile(vault, relative)
  if (result.status !== 'ready') throw new Error(`expected ${relative} to be readable`)
  return result.revision as string
}

describe('writeVaultFile', () => {

  it('saves a note and reports the revision the next save must match', async () => {
    const before = await revisionOf('inbox/today.md')

    const result = await writeVaultFile(vault, 'inbox/today.md', '# rewritten\n', before)

    expect(result).toMatchObject({ status: 'saved' })
    expect(readFileSync(path.join(root, 'inbox/today.md'), 'utf8')).toBe('# rewritten\n')
    expect(await revisionOf('inbox/today.md')).toBe(result.status === 'saved' ? result.revision : '')
  })

  /**
   * The reason this module exists. Obsidian is open on the same machine, personas
   * have write access to the same folders, and iCloud syncs underneath both. Without
   * the check, this save silently destroys the edit that landed in between.
   */
  it('refuses a save whose base revision no longer matches the disk, keeping both sides', async () => {
    const stale = await revisionOf('inbox/today.md')
    writeFileSync(path.join(root, 'inbox/today.md'), '# obsidian got here first\n', 'utf8')

    const result = await writeVaultFile(vault, 'inbox/today.md', '# my edit\n', stale)

    expect(result).toMatchObject({ status: 'stale', content: '# obsidian got here first\n' })
    // The other side's work is still on disk: a refused save must not be a half-save.
    expect(readFileSync(path.join(root, 'inbox/today.md'), 'utf8')).toBe('# obsidian got here first\n')
    // And the revision handed back is the one that would let a retry through.
    if (result.status !== 'stale') throw new Error('expected a stale result')
    expect(await writeVaultFile(vault, 'inbox/today.md', '# my edit\n', result.revision)).toMatchObject({
      status: 'saved',
    })
  })

  it('creates a note when there is no base revision', async () => {
    const result = await writeVaultFile(vault, 'inbox/fresh.md', '# fresh\n', null)

    expect(result).toMatchObject({ status: 'saved' })
    expect(readFileSync(path.join(root, 'inbox/fresh.md'), 'utf8')).toBe('# fresh\n')
    expect(statSync(path.join(root, 'inbox/fresh.md')).mode & 0o777).toBe(0o600)
  })

  it('creates the inbox for the first note in an empty vault', async () => {
    const emptyRoot = mkdtempSync(path.join(os.tmpdir(), 'manor-empty-vault-'))
    const emptyVault = await open(emptyRoot)
    expect(await writeVaultFile(emptyVault, 'inbox/untitled.md', '# First note\n', null))
      .toMatchObject({ status: 'saved' })
    expect(readFileSync(path.join(emptyRoot, 'inbox/untitled.md'), 'utf8')).toBe('# First note\n')
    expect(await writeVaultFile(emptyVault, 'missing/untitled.md', '# Wrong folder\n', null))
      .toMatchObject({ status: 'rejected' })
  })

  it('does not create a note through an inbox symlink outside the vault', async () => {
    const emptyRoot = mkdtempSync(path.join(os.tmpdir(), 'manor-empty-vault-'))
    symlinkSync(outside, path.join(emptyRoot, 'inbox'))
    expect(await writeVaultFile(await open(emptyRoot), 'inbox/untitled.md', '# Escaped\n', null))
      .toMatchObject({ status: 'rejected' })
    expect(readdirSync(outside)).not.toContain('untitled.md')
  })

  it('treats a create over an existing note as the same conflict, not an overwrite', async () => {
    const result = await writeVaultFile(vault, 'inbox/today.md', '# clobber\n', null)

    expect(result).toMatchObject({ status: 'stale', content: '# today\n' })
    expect(readFileSync(path.join(root, 'inbox/today.md'), 'utf8')).toBe('# today\n')
  })

  // Quietly re-creating it would hide that something deleted the note, and the
  // client keeps the text either way, so nothing is lost by saying so.
  it('refuses to resurrect a note that was deleted while it was open', async () => {
    const revision = await revisionOf('inbox/today.md')
    rmSync(path.join(root, 'inbox/today.md'))

    expect(await writeVaultFile(vault, 'inbox/today.md', '# back\n', revision)).toMatchObject({
      status: 'rejected',
    })
  })

  it('refuses to write outside the vault', async () => {
    const escape = `../${path.basename(outside)}/secrets.md`
    expect(await writeVaultFile(vault, escape, 'owned\n', null)).toMatchObject({ status: 'rejected' })
    expect(readFileSync(path.join(outside, 'secrets.md'), 'utf8')).toBe('nothing-real\n')
  })

  it('refuses to write anything that is not markdown', async () => {
    expect(await writeVaultFile(vault, 'cover.png', 'x\n', null)).toMatchObject({ status: 'rejected' })
  })

  it('leaves no temporary file behind for Obsidian to index', async () => {
    await writeVaultFile(vault, 'inbox/today.md', '# rewritten\n', await revisionOf('inbox/today.md'))
    expect(readdirSync(path.join(root, 'inbox'))).toEqual(['today.md'])
  })
})


describe('vault folders and note previews', () => {
  it('creates and lists an empty child folder without placeholder files', async () => {
    expect(await createVaultFolder(vault, 'research/Interviews')).toEqual({ status: 'created' })
    expect((await listVaultFiles(vault)).folders).toContain('research/Interviews')
    expect(readdirSync(path.join(root, 'research/Interviews'))).toEqual([])
    expect(await createVaultFolder(vault, 'research/Interviews')).toMatchObject({ status: 'rejected' })
    expect(await writeVaultFile(vault, 'research/Interviews/First.md', '', null)).toMatchObject({ status: 'saved' })
  })

  it('refuses hidden, missing, traversing and symlink-escaped folder parents', async () => {
    symlinkSync(outside, path.join(root, 'escape'))
    for (const target of ['../outside', '.obsidian/new', 'research/../new', '/absolute', 'missing/new', 'escape/new']) {
      expect(await createVaultFolder(vault, target)).toMatchObject({ status: 'rejected' })
    }
  })

  it('uses body text rather than title or metadata for the one-line preview', async () => {
    note('preview.md', '---\ntags: [private]\n---\n# A heading\n\nRead **this** and [[Plan|the plan]].\nMore text.')
    expect((await listVaultFiles(vault)).previews['preview.md']).toBe('Read this and the plan.')
    expect(notePreview('# Heading only')).toBe('')
    expect(notePreview('# Trip\n![[hero.png|420]]\n![alt|300](a b.png)\nPack light ![[icon.png]] today')).toBe('Pack light  today')
    expect(notePreview('x'.repeat(400))).toHaveLength(180)
  })

  it('strips block and inline marks from the preview', () => {
    expect(notePreview('- [ ] hello')).toBe('hello')
    expect(notePreview('  1. [x] done ~~old~~')).toBe('done old')
    expect(notePreview('> [!note] Heads up')).toBe('Heads up')
    expect(notePreview('> > quoted `code`')).toBe('quoted code')
    expect(notePreview('---\n\n| a | b |\n|---|---|\n\nSee <https://example.com>')).toBe('See https://example.com')
  })
})


describe('renameVaultFile', () => {
  it('can still save after renaming to the maximum UTF-8 filename length', async () => {
    const destination = `inbox/${'é'.repeat(126)}.md`
    const revision = await revisionOf('inbox/today.md')
    expect(await renameVaultFile(vault, 'inbox/today.md', destination, revision)).toMatchObject({ status: 'renamed' })
    expect(await writeVaultFile(vault, destination, '# Edited after rename\n', revision)).toMatchObject({ status: 'saved' })
    expect(readFileSync(path.join(root, destination), 'utf8')).toBe('# Edited after rename\n')
  })

  it('renames the real file, preserves its content, and recovers a lost reply', async () => {
    const revision = await revisionOf('inbox/today.md')
    const result = await renameVaultFile(vault, 'inbox/today.md', 'inbox/Tomorrow.md', revision)
    expect(result).toEqual({ status: 'renamed', revision })
    expect(readdirSync(path.join(root, 'inbox'))).toEqual(['Tomorrow.md'])
    expect(readFileSync(path.join(root, 'inbox/Tomorrow.md'), 'utf8')).toBe('# today\n')
    expect(await renameVaultFile(vault, 'inbox/today.md', 'inbox/Tomorrow.md', revision)).toEqual(result)
    expect(await writeVaultFile(vault, 'inbox/Tomorrow.md', '# next\n', revision)).toMatchObject({ status: 'saved' })
  })

  it('never overwrites an existing destination or moves a stale source', async () => {
    const revision = await revisionOf('inbox/today.md')
    note('inbox/other.md', 'Keep me')
    expect(await renameVaultFile(vault, 'inbox/today.md', 'inbox/other.md', revision)).toMatchObject({ status: 'rejected' })
    expect(readFileSync(path.join(root, 'inbox/other.md'), 'utf8')).toBe('Keep me')
    note('inbox/today.md', 'External edit')
    expect(await renameVaultFile(vault, 'inbox/today.md', 'inbox/new.md', revision)).toMatchObject({ status: 'rejected' })
    expect(readFileSync(path.join(root, 'inbox/today.md'), 'utf8')).toBe('External edit')
    expect(readdirSync(path.join(root, 'inbox'))).not.toContain('new.md')
  })

  it('supports a case-only filename change', async () => {
    expect(await renameVaultFile(vault, 'inbox/today.md', 'inbox/Today.md', await revisionOf('inbox/today.md'))).toMatchObject({ status: 'renamed' })
    expect(readdirSync(path.join(root, 'inbox'))).toEqual(['Today.md'])
  })

  it('refuses moves, hidden names, non-Markdown names and symlink sources', async () => {
    const revision = await revisionOf('inbox/today.md')
    for (const target of ['research/today.md', 'inbox/.hidden.md', 'inbox/file.txt', '../escape.md']) {
      expect(await renameVaultFile(vault, 'inbox/today.md', target, revision)).toMatchObject({ status: 'rejected' })
    }
    symlinkSync(path.join(outside, 'secrets.md'), path.join(root, 'inbox/link.md'))
    expect(await renameVaultFile(vault, 'inbox/link.md', 'inbox/moved.md', revision)).toMatchObject({ status: 'rejected' })
    expect(readFileSync(path.join(outside, 'secrets.md'), 'utf8')).toBe('nothing-real\n')
  })
})

describe('moveVaultEntry', () => {
  const read = (relative: string) => readFileSync(path.join(root, relative), 'utf8')

  it('moves a note into another folder and to the top level as one rename, keeping its bytes', async () => {
    const before = statSync(path.join(root, 'inbox/today.md')).ino
    expect(await moveVaultEntry(vault, 'inbox/today.md', 'research/wiki')).toEqual({ status: 'moved', kind: 'note', newPath: 'research/wiki/today.md' })
    expect(read('research/wiki/today.md')).toBe('# today\n')
    expect(statSync(path.join(root, 'research/wiki/today.md')).ino).toBe(before)
    expect(existsSync(path.join(root, 'inbox/today.md'))).toBe(false)
    expect(await moveVaultEntry(vault, 'research/wiki/today.md', '')).toEqual({ status: 'moved', kind: 'note', newPath: 'today.md' })
    expect(read('today.md')).toBe('# today\n')
  })

  it('answers a move onto its own folder without touching anything', async () => {
    expect(await moveVaultEntry(vault, 'inbox/today.md', 'inbox')).toEqual({ status: 'moved', kind: 'note', newPath: 'inbox/today.md' })
    expect(read('inbox/today.md')).toBe('# today\n')
  })

  it('refuses a name clash and changes nothing on either side', async () => {
    note('research/today.md', 'the other one\n')
    expect(await moveVaultEntry(vault, 'inbox/today.md', 'research')).toEqual({ status: 'rejected', message: '“research” already has a note or folder named “today.md”. Rename one of them first.' })
    expect(read('inbox/today.md')).toBe('# today\n')
    expect(read('research/today.md')).toBe('the other one\n')
  })

  it('refuses a missing folder, traversal, hidden paths, symlinks and non-notes', async () => {
    symlinkSync(outside, path.join(root, 'escape'))
    symlinkSync(path.join(outside, 'secrets.md'), path.join(root, 'inbox/link.md'))
    const refused = [
      ['inbox/today.md', 'nowhere'],
      ['inbox/today.md', '..'],
      ['inbox/today.md', `../${path.basename(outside)}`],
      ['inbox/today.md', 'escape'],
      ['inbox/today.md', '.obsidian'],
      ['inbox/today.md', '/tmp'],
      ['../outside.md', 'research'],
      ['.trash/deleted.md', 'research'],
      ['inbox/link.md', 'research'],
      ['cover.png', 'research'],
      ['', 'research'],
    ]
    for (const [entry, folder] of refused) {
      expect(await moveVaultEntry(vault, entry!, folder!), `${entry} into ${folder}`).toMatchObject({ status: 'rejected' })
    }
    expect(read('inbox/today.md')).toBe('# today\n')
    expect(readdirSync(outside)).toEqual(['secrets.md'])
  })

  it('moves a folder with everything in it, but never into itself or its own folders', async () => {
    mkdirSync(path.join(root, 'archive'))
    expect(await moveVaultEntry(vault, 'research', 'research')).toMatchObject({ status: 'rejected', message: 'A folder cannot move into itself or into one of its own folders.' })
    expect(await moveVaultEntry(vault, 'research', 'research/wiki')).toMatchObject({ status: 'rejected', message: 'A folder cannot move into itself or into one of its own folders.' })
    expect(await moveVaultEntry(vault, 'research', 'archive')).toEqual({ status: 'moved', kind: 'folder', newPath: 'archive/research' })
    expect(read('archive/research/wiki/rag.md')).toContain('body')
    expect(existsSync(path.join(root, 'research'))).toBe(false)
  })

  it('refuses a folder whose name is taken, even by an empty folder', async () => {
    mkdirSync(path.join(root, 'archive/research'), { recursive: true })
    expect(await moveVaultEntry(vault, 'research', 'archive')).toMatchObject({ status: 'rejected' })
    expect(read('research/wiki/rag.md')).toContain('body')
    expect(readdirSync(path.join(root, 'archive/research'))).toEqual([])
  })

  it('serializes a save racing the move: it lands in the moved note or is refused, never recreating the old path', async () => {
    const revision = await revisionOf('inbox/today.md')
    const [saved, moved] = await Promise.all([
      writeVaultFile(vault, 'inbox/today.md', '# saved first\n', revision),
      moveVaultEntry(vault, 'inbox/today.md', 'research'),
    ])
    expect(moved).toMatchObject({ status: 'moved' })
    expect(read('research/today.md')).toBe(saved.status === 'saved' ? '# saved first\n' : '# today\n')
    expect(existsSync(path.join(root, 'inbox/today.md'))).toBe(false)
    expect(await writeVaultFile(vault, 'inbox/today.md', '# too late\n', revision)).toMatchObject({ status: 'rejected' })
    expect(existsSync(path.join(root, 'inbox/today.md'))).toBe(false)
  })

  const failing = (call: 'unlink' | 'rename'): MoveFs => ({
    ...realMoveFs,
    [call]: async () => { throw Object.assign(new Error(`injected ${call} failure`), { code: 'EIO' }) },
  })

  it('takes the destination link back when removing the source fails, and says nothing changed', async () => {
    const before = statSync(path.join(root, 'inbox/today.md')).ino
    expect(await moveVaultEntry(vault, 'inbox/today.md', 'research', { fs: failing('unlink') })).toEqual({ status: 'rejected', message: 'That note could not be moved. Nothing changed.' })
    expect(read('inbox/today.md')).toBe('# today\n')
    expect(statSync(path.join(root, 'inbox/today.md')).nlink).toBe(1)
    expect(statSync(path.join(root, 'inbox/today.md')).ino).toBe(before)
    expect(existsSync(path.join(root, 'research/today.md'))).toBe(false)
  })

  it('removes the claimed folder when the folder rename fails, leaving the source intact', async () => {
    mkdirSync(path.join(root, 'archive'))
    expect(await moveVaultEntry(vault, 'research', 'archive', { fs: failing('rename') })).toEqual({ status: 'rejected', message: 'That folder could not be moved. Nothing changed.' })
    expect(readdirSync(path.join(root, 'archive'))).toEqual([])
    expect(read('research/wiki/rag.md')).toContain('body')
  })

  it('refuses a note whose name differs only in case from one already in the folder', async (context) => {
    const probe = note('case-probe.md', '')
    const caseInsensitive = existsSync(probe.replace('case-probe', 'CASE-PROBE'))
    rmSync(probe)
    if (!caseInsensitive) context.skip('this filesystem is case-sensitive, so Note.md and NOTE.md are two different names here')
    note('inbox/Note.md', 'mine\n')
    note('research/NOTE.md', 'theirs\n')
    expect(await moveVaultEntry(vault, 'inbox/Note.md', 'research')).toMatchObject({ status: 'rejected', message: expect.stringContaining('already has a note or folder') })
    expect(read('inbox/Note.md')).toBe('mine\n')
    expect(read('research/NOTE.md')).toBe('theirs\n')
  })

  it('waits for a save inside a folder before moving the folder, so no hidden temporary copy is left behind', async () => {
    const body = `# saved\n${'x'.repeat(256 * 1024)}\n`
    const revision = await revisionOf('research/wiki/rag.md')
    mkdirSync(path.join(root, 'archive'))
    const saving = writeVaultFile(vault, 'research/wiki/rag.md', body, revision)
    // Wait until the save has its temporary file on disk, so the move really starts mid-save.
    let inFlight = false
    for (let tick = 0; tick < 100_000 && !inFlight; tick++) {
      inFlight = readdirSync(path.join(root, 'research/wiki')).some((name) => name.startsWith('.manor-'))
      if (!inFlight) await new Promise((resolve) => setImmediate(resolve))
    }
    expect(inFlight).toBe(true)
    const [saved, moved] = await Promise.all([saving, moveVaultEntry(vault, 'research', 'archive')])
    expect(moved).toEqual({ status: 'moved', kind: 'folder', newPath: 'archive/research' })
    if (saved.status !== 'saved') {
      expect(await writeVaultFile(vault, 'archive/research/wiki/rag.md', body, revision)).toMatchObject({ status: 'saved' })
    }
    expect(read('archive/research/wiki/rag.md')).toBe(body)
    const leftovers = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((entry) => path.basename(entry).startsWith('.manor-'))
    expect(leftovers).toEqual([])
  })
})

describe('creating notes and folders', () => {
  it('creates a note at the top level and inside a folder, and refuses a taken folder name', async () => {
    expect(await writeVaultFile(vault, 'top.md', '', null)).toMatchObject({ status: 'saved' })
    expect(await writeVaultFile(vault, 'research/wiki/new.md', '', null)).toMatchObject({ status: 'saved' })
    expect(await createVaultFolder(vault, 'Projects')).toEqual({ status: 'created' })
    expect(await createVaultFolder(vault, 'Projects')).toMatchObject({ status: 'rejected', message: 'A file or folder with that name already exists.' })
    expect((await listVaultFiles(vault)).files).toEqual(expect.arrayContaining(['top.md', 'research/wiki/new.md']))
  })
})

describe('deleteVaultEntry', () => {
  let trash: string
  const at = new Date('2026-11-11T09:30:00.000Z')
  beforeEach(() => {
    trash = path.join(mkdtempSync(path.join(os.tmpdir(), 'manor-data-')), 'trash', 'knowledge')
  })

  it('moves a note into a dated trash folder, keeping its path', async () => {
    const result = await deleteVaultEntry(vault, 'inbox/today.md', trash, { now: at })
    const moved = path.join(trash, '2026-11-11T09-30-00.000Z', 'inbox', 'today.md')
    expect(result).toEqual({ status: 'deleted', kind: 'note', trashPath: moved })
    expect(readFileSync(moved, 'utf8')).toBe('# today\n')
    expect(readdirSync(path.join(root, 'inbox'))).toEqual([])
  })

  it('moves a whole folder with everything in it and leaves nothing behind', async () => {
    note('research/wiki/deep/more.md', 'more\n')
    writeFileSync(path.join(root, 'research/wiki/image.png'), 'png')
    expect(await deleteVaultEntry(vault, 'research', trash, { now: at })).toMatchObject({ status: 'deleted', kind: 'folder' })
    const bucket = path.join(trash, '2026-11-11T09-30-00.000Z', 'research', 'wiki')
    expect(readdirSync(bucket).sort()).toEqual(['deep', 'image.png', 'rag.md'])
    expect(readFileSync(path.join(bucket, 'deep/more.md'), 'utf8')).toBe('more\n')
    expect(readdirSync(root)).not.toContain('research')
  })

  it('never overwrites an earlier delete of the same name', async () => {
    await deleteVaultEntry(vault, 'inbox/today.md', trash, { now: at })
    note('inbox/today.md', 'second\n')
    const second = await deleteVaultEntry(vault, 'inbox/today.md', trash, { now: at })
    expect(second).toMatchObject({ status: 'deleted', trashPath: path.join(trash, '2026-11-11T09-30-00.000Z-2', 'inbox', 'today.md') })
    expect(readFileSync(path.join(trash, '2026-11-11T09-30-00.000Z', 'inbox', 'today.md'), 'utf8')).toBe('# today\n')
  })

  it('refuses the root, traversal, hidden paths, symlinks and non-notes', async () => {
    symlinkSync(outside, path.join(root, 'linked'))
    symlinkSync(path.join(outside, 'secrets.md'), path.join(root, 'inbox/link.md'))
    writeFileSync(path.join(root, 'inbox/file.txt'), 'x')
    const escape = `../${path.basename(outside)}/secrets.md`
    for (const target of ['.', '', '/', escape, '.obsidian', '.trash/deleted.md', 'inbox/../research', 'linked', 'linked/secrets.md', 'inbox/link.md', 'inbox/file.txt', 'missing.md']) {
      expect(await deleteVaultEntry(vault, target, trash, { now: at })).toMatchObject({ status: 'rejected' })
    }
    expect(readFileSync(path.join(outside, 'secrets.md'), 'utf8')).toBe('nothing-real\n')
    expect(readdirSync(root).sort()).toEqual(['.obsidian', '.trash', 'cover.png', 'inbox', 'linked', 'research'])
  })

  it('refuses a folder that holds the trash itself', async () => {
    const inside = path.join(root, 'research', 'trash', 'knowledge')
    expect(await deleteVaultEntry(vault, 'research', inside, { now: at })).toMatchObject({ status: 'rejected' })
    expect(readdirSync(root)).toContain('research')
  })

  it('copies across volumes, checks the copy, then removes the original', async () => {
    note('research/wiki/two.md', 'two\n')
    const crossDevice = async () => { throw Object.assign(new Error('cross-device'), { code: 'EXDEV' }) }
    const move = (source: string, destination: string) => moveEntry(source, destination, { rename: crossDevice })
    expect(await deleteVaultEntry(vault, 'research', trash, { now: at, move })).toMatchObject({ status: 'deleted' })
    expect(readdirSync(path.join(trash, '2026-11-11T09-30-00.000Z', 'research', 'wiki')).sort()).toEqual(['rag.md', 'two.md'])
    expect(readdirSync(root)).not.toContain('research')
  })

  const crossDevice = async () => { throw Object.assign(new Error('cross-device'), { code: 'EXDEV' }) }
  const copied = path.join('2026-11-11T09-30-00.000Z', 'research')

  it('says the truth when removing the original fails partway, and asks for a relist', async () => {
    note('research/wiki/two.md', 'two\n')
    const halfRemove = (async (target: string, options?: Parameters<typeof rmSync>[1]) => {
      if (target.startsWith(vault.root)) {
        rmSync(path.join(target, 'wiki', 'two.md'))
        throw Object.assign(new Error('busy'), { code: 'EBUSY' })
      }
      rmSync(target, options)
    }) as never
    const move = (source: string, destination: string) => moveEntry(source, destination, { rename: crossDevice, rm: halfRemove })
    const result = await deleteVaultEntry(vault, 'research', trash, { now: at, move })
    expect(result).toEqual({
      status: 'rejected',
      message: `That folder was copied to the trash at ${path.join(trash, copied)}, but removing the original failed partway. Part of it may still be in the Knowledge folder.`,
      listingChanged: true,
    })
    expect(readdirSync(path.join(trash, copied, 'wiki')).sort()).toEqual(['rag.md', 'two.md'])
  })

  it('leaves the original alone when a file is written into it during the copy', async () => {
    const copyThenWrite = (async (...args: Parameters<typeof import('node:fs/promises').cp>) => {
      const { cp } = await import('node:fs/promises')
      await cp(...args)
      note('research/wiki/late.md', 'written during the delete\n')
    }) as never
    const move = (source: string, destination: string) => moveEntry(source, destination, { rename: crossDevice, cp: copyThenWrite })
    expect(await deleteVaultEntry(vault, 'research', trash, { now: at, move })).toEqual({
      status: 'rejected',
      message: `That folder changed while it was being deleted, so nothing was removed. The copy in the trash at ${path.join(trash, copied)} can be discarded.`,
    })
    expect(readFileSync(path.join(root, 'research/wiki/late.md'), 'utf8')).toBe('written during the delete\n')
    expect(readFileSync(path.join(root, 'research/wiki/rag.md'), 'utf8')).toContain('body')
  })

  it('refuses a folder that holds an iCloud placeholder at any depth and moves nothing', async () => {
    writeFileSync(path.join(root, 'research/wiki/.offline.md.icloud'), 'stub')
    expect(await deleteVaultEntry(vault, 'research', trash, { now: at })).toEqual({
      status: 'rejected',
      message: 'Some notes in this folder are only in iCloud and not on this Mac. Download them first (open the folder in Finder and choose Download Now), then delete.',
    })
    expect(readdirSync(path.join(root, 'research/wiki')).sort()).toEqual(['.offline.md.icloud', 'rag.md'])
    expect(() => readdirSync(trash)).toThrow()
  })
})
