import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { MAX_REPO_FILE_BYTES } from '@manor/contracts'
import { folderLabels, listRepoFiles, MAX_REPO_FILES, readRepoFile, resolveInRepo, writeRepoFile } from '../src/repoFiles.js'

/**
 * Two folders built here rather than anywhere real: one a git checkout with a
 * .gitignore, one a plain folder. Those are the only two shapes the listing knows,
 * and which one it took decides whether `node_modules` shows up in the `@` menu.
 */
let checkout: string
let plain: string

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } })

beforeAll(() => {
  checkout = mkdtempSync(path.join(os.tmpdir(), 'manor-files-git-'))
  mkdirSync(path.join(checkout, 'src'))
  mkdirSync(path.join(checkout, 'node_modules'))
  writeFileSync(path.join(checkout, 'src', 'main.ts'), 'export {}\n', 'utf8')
  writeFileSync(path.join(checkout, 'README.md'), '# hi\n', 'utf8')
  writeFileSync(path.join(checkout, '.gitignore'), 'node_modules\nsecrets.txt\n', 'utf8')
  writeFileSync(path.join(checkout, 'secrets.txt'), 'nothing-real\n', 'utf8')
  writeFileSync(path.join(checkout, 'node_modules', 'dep.js'), 'module.exports={}\n', 'utf8')
  git(checkout, 'init', '--quiet')

  plain = mkdtempSync(path.join(os.tmpdir(), 'manor-files-plain-'))
  mkdirSync(path.join(plain, 'notes'))
  mkdirSync(path.join(plain, 'node_modules'))
  mkdirSync(path.join(plain, '.git'))
  writeFileSync(path.join(plain, 'notes', 'today.md'), 'hi\n', 'utf8')
  writeFileSync(path.join(plain, '.env'), 'SECRET=nothing-real\n', 'utf8')
  writeFileSync(path.join(plain, 'node_modules', 'dep.js'), 'x\n', 'utf8')
})

describe('listRepoFiles', () => {
  it('prefixes every path with the folder name, which is what the composer inserts', async () => {
    const { files } = await listRepoFiles([checkout])
    const label = path.basename(checkout)
    expect(files).toContain(`${label}/src/main.ts`)
    expect(files.every((file) => file.startsWith(`${label}/`))).toBe(true)
  })

  // The whole reason git is the primary source: no walk of ours would agree with the
  // .gitignore the user maintains, and disagreeing means offering to mention a secret.
  it('honours .gitignore in a checkout', async () => {
    const { files } = await listRepoFiles([checkout])
    expect(files.some((file) => file.endsWith('/README.md'))).toBe(true)
    expect(files.some((file) => file.includes('node_modules'))).toBe(false)
    expect(files.some((file) => file.endsWith('secrets.txt'))).toBe(false)
  })

  it('never lists credential files even when git would offer them', async () => {
    writeFileSync(path.join(checkout, '.env.local'), 'SECRET=nothing-real\n', 'utf8')
    writeFileSync(path.join(checkout, '.npmrc'), 'token=nothing-real\n', 'utf8')

    const { files } = await listRepoFiles([checkout])

    expect(files.some((file) => file.endsWith('/.env.local'))).toBe(false)
    expect(files.some((file) => file.endsWith('/.npmrc'))).toBe(false)
  })

  it('lists an untracked file, because a file written this minute is mentionable', async () => {
    writeFileSync(path.join(checkout, 'src', 'fresh.ts'), 'export {}\n', 'utf8')
    const { files } = await listRepoFiles([checkout])
    expect(files.some((file) => file.endsWith('/src/fresh.ts'))).toBe(true)
  })

  // Plans and ideas are session scratch, so gitignore keeps them off the tree, but
  // they are exactly the files the user opens from the Files panel. Everything else
  // gitignore hides stays hidden, including credentials dropped in those folders.
  it('lists gitignored working files under .claude/ideas and .claude/plans', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'manor-files-claude-'))
    mkdirSync(path.join(root, '.claude', 'ideas', 'nested'), { recursive: true })
    mkdirSync(path.join(root, '.claude', 'plans'), { recursive: true })
    writeFileSync(
      path.join(root, '.gitignore'),
      [
        '.claude/plans/*',
        '!.claude/plans/.gitkeep',
        '.claude/ideas/*',
        '!.claude/ideas/.gitkeep',
        '.claude/launch.json',
        'node_modules',
        'secrets.txt',
      ].join('\n') + '\n',
    )
    writeFileSync(path.join(root, '.claude', 'ideas', '.gitkeep'), '')
    writeFileSync(path.join(root, '.claude', 'plans', '.gitkeep'), '')
    writeFileSync(path.join(root, '.claude', 'ideas', 'note.md'), 'an idea\n')
    writeFileSync(path.join(root, '.claude', 'ideas', 'nested', 'deeper.md'), 'nested\n')
    writeFileSync(path.join(root, '.claude', 'plans', 'do-it.md'), 'a plan\n')
    writeFileSync(path.join(root, '.claude', 'launch.json'), '{}\n')
    writeFileSync(path.join(root, '.claude', 'ideas', '.env'), 'SECRET=nothing-real\n')
    writeFileSync(path.join(root, 'secrets.txt'), 'nothing-real\n')
    git(root, 'init', '--quiet')

    const label = path.basename(root)
    const { files } = await listRepoFiles([root])

    expect(files).toContain(`${label}/.claude/ideas/note.md`)
    expect(files).toContain(`${label}/.claude/ideas/nested/deeper.md`)
    expect(files).toContain(`${label}/.claude/plans/do-it.md`)
    expect(files).toContain(`${label}/.claude/ideas/.gitkeep`)
    expect(files.some((file) => file.endsWith('/.claude/launch.json'))).toBe(false)
    expect(files.some((file) => file.endsWith('secrets.txt'))).toBe(false)
    expect(files.some((file) => file.endsWith('/.env'))).toBe(false)

    await expect(readRepoFile([root], `${label}/.claude/ideas/note.md`)).resolves.toMatchObject({
      status: 'ready',
      content: 'an idea\n',
    })
    await expect(readRepoFile([root], `${label}/.claude/launch.json`)).resolves.toMatchObject({
      status: 'unavailable',
    })
  })

  // Verification screenshots stay out of git but are what the user checks a UI claim
  // against, so both evidence folders are listed while other ignored paths are not.
  it('lists gitignored verification evidence and nothing else gitignore hides', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'manor-files-evidence-'))
    const web = path.join(root, '.cursor', 'skills', 'verify-manor', 'evidence', 'run')
    const mobile = path.join(root, '.cursor', 'skills', 'verify-manor-mobile', 'evidence', 'run')
    mkdirSync(web, { recursive: true })
    mkdirSync(mobile, { recursive: true })
    mkdirSync(path.join(root, 'node_modules'))
    writeFileSync(
      path.join(root, '.gitignore'),
      [
        '.cursor/skills/verify-manor/evidence/**',
        '.cursor/skills/verify-manor-mobile/evidence/**',
        'node_modules',
      ].join('\n') + '\n',
    )
    writeFileSync(path.join(web, 'shot.png'), 'png\n')
    writeFileSync(path.join(mobile, 'shot.png'), 'png\n')
    writeFileSync(path.join(root, 'node_modules', 'dep.js'), 'x\n')
    git(root, 'init', '--quiet')

    const label = path.basename(root)
    const { files } = await listRepoFiles([root])

    expect(files).toContain(`${label}/.cursor/skills/verify-manor/evidence/run/shot.png`)
    expect(files).toContain(`${label}/.cursor/skills/verify-manor-mobile/evidence/run/shot.png`)
    expect(files.some((file) => file.includes('node_modules'))).toBe(false)
    await expect(resolveInRepo([root], `${label}/.cursor/skills/verify-manor-mobile/evidence/run/shot.png`)).resolves.toBe(
      path.join(realpathSync(root), '.cursor/skills/verify-manor-mobile/evidence/run/shot.png'),
    )
  })

  it('lets regular files win the cap over listed gitignored files', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'manor-files-evidence-cap-'))
    const evidence = path.join(root, '.cursor', 'skills', 'verify-manor', 'evidence')
    mkdirSync(evidence, { recursive: true })
    writeFileSync(path.join(root, '.gitignore'), '.cursor/skills/verify-manor/evidence/**\n')
    writeFileSync(path.join(evidence, 'shot.png'), 'png\n')
    for (let index = 1; index < MAX_REPO_FILES; index += 1) {
      writeFileSync(path.join(root, `file-${index}.txt`), 'x\n', 'utf8')
    }
    git(root, 'init', '--quiet')

    const listing = await listRepoFiles([root])

    expect(listing.truncated).toBe(true)
    expect(listing.files).toHaveLength(MAX_REPO_FILES)
    expect(listing.files.some((file) => file.endsWith('/shot.png'))).toBe(false)
  })

  it('lets a later folder\'s regular files win the cap over an earlier folder\'s ignored files', async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'manor-files-evidence-roots-'))
    const first = path.join(base, 'first')
    const second = path.join(base, 'second')
    const evidence = path.join(first, '.cursor', 'skills', 'verify-manor', 'evidence')
    mkdirSync(evidence, { recursive: true })
    mkdirSync(second)
    writeFileSync(path.join(first, '.gitignore'), '.cursor/skills/verify-manor/evidence/**\n')
    writeFileSync(path.join(second, 'main.ts'), 'export {}\n')
    for (let index = 0; index < MAX_REPO_FILES; index += 1) writeFileSync(path.join(evidence, `shot-${index}.png`), '')
    git(first, 'init', '--quiet')
    git(second, 'init', '--quiet')

    const listing = await listRepoFiles([first, second])

    expect(listing.truncated).toBe(true)
    expect(listing.files).toHaveLength(MAX_REPO_FILES)
    expect(listing.files).toContain('second/main.ts')
    expect(listing.files).toContain('first/.gitignore')
  })

  it('falls back to a walk for a plain folder, skipping dotfiles and vendor dirs', async () => {
    const { files } = await listRepoFiles([plain])
    const label = path.basename(plain)
    expect(files).toEqual([`${label}/notes/today.md`])
  })

  it('keeps folders apart by name when a project links more than one', async () => {
    const { files } = await listRepoFiles([checkout, plain])
    expect(files.some((file) => file.startsWith(`${path.basename(checkout)}/`))).toBe(true)
    expect(files.some((file) => file.startsWith(`${path.basename(plain)}/`))).toBe(true)
  })

  it('disambiguates equal basenames and resolves each label back to its own folder', async () => {
    const leftParent = mkdtempSync(path.join(os.tmpdir(), 'manor-left-'))
    const rightParent = mkdtempSync(path.join(os.tmpdir(), 'manor-right-'))
    const left = path.join(leftParent, 'src')
    const right = path.join(rightParent, 'src')
    mkdirSync(left)
    mkdirSync(right)
    writeFileSync(path.join(left, 'same.md'), 'left\n', 'utf8')
    writeFileSync(path.join(right, 'same.md'), 'right\n', 'utf8')

    const labels = folderLabels([left, right])
    expect(labels).toEqual([`${path.basename(leftParent)}/src`, `${path.basename(rightParent)}/src`])
    const listing = await listRepoFiles([left, right])
    expect(listing.files).toEqual(labels.map((label) => `${label}/same.md`))
    await expect(readRepoFile([left, right], `${labels[0]}/same.md`)).resolves.toMatchObject({ content: 'left\n' })
    await expect(readRepoFile([left, right], `${labels[1]}/same.md`)).resolves.toMatchObject({ content: 'right\n' })
    await expect(resolveInRepo([left, right], `${labels[1]}/same.md`)).resolves.toBe(realpathSync(path.join(right, 'same.md')))
  })

  it('answers a project with no folders with an empty list, not a failure', async () => {
    expect(await listRepoFiles([])).toEqual({ files: [], truncated: false })
  })

  it('reports a folder it cannot read as empty rather than throwing', async () => {
    const gone = path.join(os.tmpdir(), 'manor-files-does-not-exist')
    expect((await listRepoFiles([gone])).files).toEqual([])
  })

  it('says so when the cap cut the list', async () => {
    const big = mkdtempSync(path.join(os.tmpdir(), 'manor-files-big-'))
    for (let index = 0; index <= MAX_REPO_FILES; index += 1) {
      writeFileSync(path.join(big, `file-${index}.txt`), 'x\n', 'utf8')
    }
    const listing = await listRepoFiles([big])
    expect(listing.files).toHaveLength(MAX_REPO_FILES)
    expect(listing.truncated).toBe(true)
  })
})

describe('resolveInRepo', () => {
  it('refuses invented, ignored, credential and traversal paths', async () => {
    const label = path.basename(checkout)
    for (const file of ['missing.ts', 'secrets.txt', '.env.local', '../README.md']) {
      await expect(resolveInRepo([checkout], `${label}/${file}`)).resolves.toBeNull()
    }
    await expect(resolveInRepo([checkout], path.join(checkout, 'README.md'))).resolves.toBeNull()
    await expect(resolveInRepo([], `${label}/README.md`)).resolves.toBeNull()
  })

  it('refuses tracked deleted files and symlinks, including redirected ancestor folders', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'manor-resolve-'))
    const outside = mkdtempSync(path.join(os.tmpdir(), 'manor-outside-'))
    try {
      git(root, 'init', '--quiet')
      mkdirSync(path.join(root, 'src'))
      writeFileSync(path.join(root, 'src/file.ts'), 'safe')
      writeFileSync(path.join(root, 'gone.ts'), 'safe')
      writeFileSync(path.join(outside, 'file.ts'), 'outside')
      symlinkSync(path.join(outside, 'file.ts'), path.join(root, 'link.ts'))
      git(root, 'add', '.')
      rmSync(path.join(root, 'gone.ts'))
      rmSync(path.join(root, 'src'), { recursive: true })
      symlinkSync(outside, path.join(root, 'src'))
      for (const file of ['gone.ts', 'link.ts', 'src/file.ts']) {
        const pointer = `${path.basename(root)}/${file}`
        expect((await listRepoFiles([root])).files).toContain(pointer)
        await expect(resolveInRepo([root], pointer)).resolves.toBeNull()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('readRepoFile', () => {
  it('reads a UTF-8 file offered by the listing, with the revision a save needs', async () => {
    const label = path.basename(checkout)
    expect(await readRepoFile([checkout], `${label}/README.md`)).toEqual({
      status: 'ready',
      content: '# hi\n',
      revision: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
  })

  it('refuses a hand-crafted credential path', async () => {
    const label = path.basename(checkout)
    expect(await readRepoFile([checkout], `${label}/.env.local`)).toMatchObject({ status: 'unavailable' })
  })

  it('reports a file over the preview cap without returning its contents', async () => {
    const file = path.join(checkout, 'large.txt')
    writeFileSync(file, Buffer.alloc(MAX_REPO_FILE_BYTES + 1, 97))
    const label = path.basename(checkout)

    expect(await readRepoFile([checkout], `${label}/large.txt`)).toEqual({
      status: 'too_large',
      size: MAX_REPO_FILE_BYTES + 1,
      maxSize: MAX_REPO_FILE_BYTES,
    })
  })

  it('identifies binary data instead of decoding it into the socket payload', async () => {
    writeFileSync(path.join(checkout, 'image.bin'), Buffer.from([0, 1, 2, 3]))
    const label = path.basename(checkout)
    expect(await readRepoFile([checkout], `${label}/image.bin`)).toEqual({ status: 'binary', size: 4 })
  })
})

describe('writeRepoFile', () => {
  /** The revision a save has to carry, taken the way the editor takes it: from the read. */
  const revisionOf = async (file: string) => {
    const result = await readRepoFile([checkout], file)
    if (result.status !== 'ready') throw new Error(`expected ${file} to be readable`)
    return result.revision as string
  }

  it('saves a file the listing offered and hands back its new revision', async () => {
    const label = path.basename(checkout)
    const file = `${label}/src/main.ts`
    const base = await revisionOf(file)

    const result = await writeRepoFile([checkout], file, 'export const x = 1\n', base)

    expect(result).toEqual({ status: 'saved', revision: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(readFileSync(path.join(checkout, 'src', 'main.ts'), 'utf8')).toBe('export const x = 1\n')
    // The revision it reported is the one a second save must send, or the editor
    // would have to re-read the file after every save to stay able to write.
    if (result.status !== 'saved') throw new Error('expected a saved result')
    expect(await revisionOf(file)).toBe(result.revision)
  })

  it('refuses a stale save and hands back what is on disk, so neither side is lost', async () => {
    const label = path.basename(checkout)
    const file = `${label}/stale.md`
    writeFileSync(path.join(checkout, 'stale.md'), 'first\n', 'utf8')
    const base = await revisionOf(file)
    writeFileSync(path.join(checkout, 'stale.md'), 'somebody else\n', 'utf8')

    const result = await writeRepoFile([checkout], file, 'mine\n', base)

    expect(result).toMatchObject({ status: 'stale', content: 'somebody else\n' })
    expect(readFileSync(path.join(checkout, 'stale.md'), 'utf8')).toBe('somebody else\n')
  })

  it('refuses a path the listing never offered, which is also how creating is refused', async () => {
    const label = path.basename(checkout)
    const gitignored = await writeRepoFile([checkout], `${label}/secrets.txt`, 'x\n', 'whatever')
    const invented = await writeRepoFile([checkout], `${label}/new-file.md`, 'x\n', 'whatever')

    expect(gitignored).toMatchObject({ status: 'rejected' })
    expect(invented).toMatchObject({ status: 'rejected' })
    expect(readFileSync(path.join(checkout, 'secrets.txt'), 'utf8')).toBe('nothing-real\n')
    expect(existsSync(path.join(checkout, 'new-file.md'))).toBe(false)
  })

  it('refuses a save over the size cap without touching the file', async () => {
    const label = path.basename(checkout)
    const file = `${label}/README.md`
    const base = await revisionOf(file)

    const result = await writeRepoFile([checkout], file, 'a'.repeat(MAX_REPO_FILE_BYTES + 1), base)

    expect(result).toMatchObject({ status: 'rejected' })
    expect(readFileSync(path.join(checkout, 'README.md'), 'utf8')).toBe('# hi\n')
  })

  it('leaves no temporary file behind', async () => {
    const label = path.basename(checkout)
    const file = `${label}/README.md`
    await writeRepoFile([checkout], file, '# hi again\n', await revisionOf(file))

    expect(readdirSync(checkout).filter((name) => name.endsWith('.manor-tmp'))).toEqual([])
  })
})
