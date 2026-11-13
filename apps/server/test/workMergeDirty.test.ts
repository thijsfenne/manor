import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { dirtyOverlap } from '../src/workMerge.js'

describe('dirtyOverlap', () => {
  const roots: string[] = []
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' }
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env }).trim()

  /** A linked folder on main and a branch that changes `edits` from there. */
  function fixture(edits: Record<string, string>, removed: string[] = []) {
    const root = mkdtempSync(path.join(os.tmpdir(), 'manor-dirty-'))
    roots.push(root)
    git(root, 'init', '-q', '-b', 'main')
    git(root, 'config', 'user.name', 'Test')
    git(root, 'config', 'user.email', 'test@example.test')
    writeFileSync(path.join(root, 'kept.md'), 'kept\n')
    writeFileSync(path.join(root, 'old.md'), 'old\n')
    writeFileSync(path.join(root, 'tracked'), 'tracked\n')
    writeFileSync(path.join(root, '.gitignore'), 'ignored.md\nbuild/\n')
    git(root, 'add', '.')
    git(root, 'commit', '-qm', 'Initial')
    git(root, 'switch', '-qc', 'session')
    for (const file of removed) rmSync(path.join(root, file))
    for (const [file, text] of Object.entries(edits)) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
      writeFileSync(path.join(root, file), text)
    }
    git(root, 'add', '-Af')
    git(root, 'commit', '-qm', 'Session')
    git(root, 'switch', '-q', 'main')
    return root
  }

  it('names a dirty file the branch changes, a leading space included, and ignores the rest', async () => {
    const root = fixture({ 'kept.md': 'session\n', ' lead.md': 'session\n' })
    writeFileSync(path.join(root, ' lead.md'), 'mine\n')
    writeFileSync(path.join(root, 'kept.md'), 'mine\n')
    writeFileSync(path.join(root, 'old.md'), 'mine\n')
    expect(await dirtyOverlap(root, 'main', 'refs/heads/session')).toEqual([' lead.md', 'kept.md'])
  })

  it('catches a file against a folder of the same name, either way round', async () => {
    const root = fixture({ 'docs.md': 'session\n', 'deep/inner.md': 'session\n' })
    mkdirSync(path.join(root, 'docs.md'))
    writeFileSync(path.join(root, 'docs.md', 'mine.md'), 'mine\n')
    writeFileSync(path.join(root, 'deep'), 'mine\n')
    expect(await dirtyOverlap(root, 'main', 'refs/heads/session')).toEqual(['deep', 'docs.md/mine.md'])
  })

  it('counts an ignored local file the merge would overwrite', async () => {
    const root = fixture({ 'ignored.md': 'session\n' })
    writeFileSync(path.join(root, 'ignored.md'), 'mine\n')
    expect(await dirtyOverlap(root, 'main', 'refs/heads/session')).toEqual(['ignored.md'])
  })

  it('lets the branch replace a clean tracked file with a folder', async () => {
    const root = fixture({ 'tracked/inner.md': 'session\n' }, ['tracked'])
    expect(await dirtyOverlap(root, 'main', 'refs/heads/session')).toEqual([])
  })

  it('leaves an unrelated file inside an ignored folder alone', async () => {
    const root = fixture({ 'build/new.txt': 'session\n' })
    mkdirSync(path.join(root, 'build'))
    writeFileSync(path.join(root, 'build', 'cache.txt'), 'mine\n')
    expect(await dirtyOverlap(root, 'main', 'refs/heads/session')).toEqual([])
    writeFileSync(path.join(root, 'build', 'new.txt'), 'mine\n')
    expect(await dirtyOverlap(root, 'main', 'refs/heads/session')).toEqual(['build/new.txt'])
  })

  it('counts both sides of a staged rename', async () => {
    const root = fixture({ 'old.md': 'session\n' })
    git(root, 'mv', 'old.md', 'moved.md')
    expect(await dirtyOverlap(root, 'main', 'refs/heads/session')).toEqual(['old.md'])
  })

  it('finds nothing in a clean folder', async () => {
    expect(await dirtyOverlap(fixture({ 'kept.md': 'session\n' }), 'main', 'refs/heads/session')).toEqual([])
  })
})
