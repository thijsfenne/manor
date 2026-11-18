import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync, utimesSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  attachWorktrees,
  autoBranchName,
  cachedCurrentBranch,
  copyIncludes,
  effectiveRepoPaths,
  gitRoots,
  isGitRoot,
  liveWorktreeBranch,
  readCheckoutStatus,
  releaseMergedWorktrees,
  removeWorktree,
  removeWorktrees,
  sourceKey,
  sweepWorktrees,
  treeStatus,
  pruneWorktreeNodeModules,
  worktreeDir,
} from '../src/worktree.js'

const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Manor',
  GIT_AUTHOR_EMAIL: 'manor@local',
  GIT_COMMITTER_NAME: 'Manor',
  GIT_COMMITTER_EMAIL: 'manor@local',
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, stdio: 'pipe', env: gitEnv }).toString('utf8').trim()

const tempDirs: string[] = []
afterEach(() => {
  tempDirs.length = 0
})

function temp(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function repo(prefix: string, files: Record<string, string> = { 'README.md': 'hi\n' }): string {
  const root = temp(prefix)
  git(root, 'init', '--quiet', '-b', 'main')
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, content, 'utf8')
  }
  git(root, 'add', '.')
  git(root, 'commit', '--quiet', '-m', 'init')
  return root
}

describe('effectiveRepoPaths', () => {
  it('passes the project list through when the mapping is empty', () => {
    expect(effectiveRepoPaths(['/repos/manor', '/notes'], [])).toEqual(['/repos/manor', '/notes'])
  })

  it('remaps git folders and leaves the rest, so labels stay basename-stable', () => {
    const mapping = [
      {
        sourcePath: '/repos/manor',
        worktreePath: '/.manor/worktrees/p/c/manor',
        branch: 'manor/abcd1234',
        createdAt: 1,
      },
    ]
    expect(effectiveRepoPaths(['/repos/manor', '/notes'], mapping)).toEqual([
      '/.manor/worktrees/p/c/manor',
      '/notes',
    ])
    expect(path.basename(mapping[0]!.worktreePath)).toBe(path.basename(mapping[0]!.sourcePath))
  })
})

describe('autoBranchName', () => {
  it('takes eight hex characters of a uuid, and hashes a non-hex id', () => {
    expect(autoBranchName('14a6f048-43e5-419f-91f0-a5bcc3d3e370')).toBe('manor/14a6f048')
    expect(autoBranchName('chat_1')).toMatch(/^manor\/[0-9a-f]{8}$/)
  })
})

it('refreshes the directory branch when the checkout HEAD changes', async () => {
  const source = repo('manor-branch-cache-')
  expect(await cachedCurrentBranch(source)).toBe('main')
  expect(await cachedCurrentBranch(source)).toBe('main')
  git(source, 'switch', '--quiet', '-c', 'topic')
  const changed = new Date(Date.now() + 2000)
  utimesSync(path.join(source, '.git', 'HEAD'), changed, changed)
  expect(await cachedCurrentBranch(source)).toBe('topic')
})

it('reads a linked worktree HEAD through its .git pointer', async () => {
  const source = repo('manor-branch-source-')
  const destination = temp('manor-branch-linked-')
  git(source, 'worktree', 'add', '--quiet', '-b', 'topic', destination)
  expect(await cachedCurrentBranch(destination)).toBe('topic')
})

describe('attachWorktrees', () => {
  it('creates from HEAD, copies include files, and leaves a dirty source behind', async () => {
    const source = repo('manor-wt-src-', {
      'README.md': 'hi\n',
      '.gitignore': '.env\nnode_modules\n',
      '.env': 'SECRET=nothing-real\n',
    })
    writeFileSync(path.join(source, 'dirty.txt'), 'uncommitted\n')
    const worktreesRoot = temp('manor-wt-root-')
    const result = await attachWorktrees({
      worktreesRoot,
      projectId: 'project_1',
      chatId: 'chat_1',
      repoPaths: [source],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.mapping).toHaveLength(1)
    expect(result.mapping[0]?.branch).toBe(autoBranchName('chat_1'))
    expect(readFileSync(path.join(result.mapping[0]!.worktreePath, 'README.md'), 'utf8')).toBe('hi\n')
    expect(existsSync(path.join(result.mapping[0]!.worktreePath, 'dirty.txt'))).toBe(false)
    expect(readFileSync(path.join(result.mapping[0]!.worktreePath, '.env'), 'utf8')).toBe('SECRET=nothing-real\n')
    expect(path.basename(result.mapping[0]!.worktreePath)).toBe(path.basename(source))
  })

  it('isolates every git folder and leaves a notes folder on the shared path', async () => {
    const code = repo('manor-wt-code-')
    const notes = temp('manor-wt-notes-')
    writeFileSync(path.join(notes, 'today.md'), 'hi\n')
    const worktreesRoot = temp('manor-wt-root-')

    const result = await attachWorktrees({
      worktreesRoot,
      projectId: 'project_1',
      chatId: 'chat_1',
      repoPaths: [code, notes],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.mapping.map((row) => row.sourcePath)).toEqual([code])
    expect(await gitRoots([code, notes])).toEqual([code])
    expect(await isGitRoot(notes)).toBe(false)
    expect(effectiveRepoPaths([code, notes], result.mapping)[1]).toBe(notes)
  })

  it('refuses a branch that is already checked out, and a folder that is not a git root', async () => {
    const source = repo('manor-wt-busy-')
    const worktreesRoot = temp('manor-wt-root-')
    const notes = temp('manor-wt-plain-')

    const busy = await attachWorktrees({
      worktreesRoot,
      projectId: 'project_1',
      chatId: 'chat_1',
      repoPaths: [source],
      branch: 'main',
    })
    expect(busy.ok).toBe(false)
    if (busy.ok) return
    expect(busy.message).toMatch(/already checked out|already used/i)

    const none = await attachWorktrees({
      worktreesRoot,
      projectId: 'project_1',
      chatId: 'chat_2',
      repoPaths: [notes],
    })
    expect(none.ok).toBe(false)
    if (none.ok) return
    expect(none.message).toMatch(/no git folder/i)
  })

  it('reuses a leftover after the rows were deleted, on the leftover\'s own branch', async () => {
    const source = repo('manor-wt-reuse-')
    const worktreesRoot = temp('manor-wt-root-')
    const created = await attachWorktrees({
      worktreesRoot,
      projectId: 'project_1',
      chatId: 'chat_1',
      repoPaths: [source],
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    writeFileSync(path.join(created.mapping[0]!.worktreePath, 'kept.ts'), 'export {}\n')

    const reused = await attachWorktrees({
      worktreesRoot,
      projectId: 'project_1',
      chatId: 'chat_1',
      repoPaths: [source],
    })
    expect(reused.ok).toBe(true)
    if (!reused.ok) return
    expect(reused.mapping[0]?.worktreePath).toBe(created.mapping[0]?.worktreePath)
    expect(reused.mapping[0]?.branch).toBe(created.mapping[0]?.branch)
    expect(readFileSync(path.join(reused.mapping[0]!.worktreePath, 'kept.ts'), 'utf8')).toBe('export {}\n')
    // A resumed leftover records the branch it merges back into, like a new one.
    expect(reused.mapping[0]?.baseBranch).toBe('main')
  })

  it('deletes a released Session branch on a later release when Git refused it the first time', async () => {
    const source = repo('manor-wt-lock-')
    const worktreesRoot = temp('manor-wt-root-')
    const created = await attachWorktrees({ worktreesRoot, projectId: 'project_1', chatId: 'chat_1', repoPaths: [source] })
    if (!created.ok) throw new Error(created.message)
    const row = created.mapping[0]!
    writeFileSync(path.join(row.worktreePath, 'work.ts'), 'export {}\n')
    git(row.worktreePath, 'add', 'work.ts')
    git(row.worktreePath, 'commit', '-qm', 'work')
    git(source, 'merge', '--quiet', '--ff-only', row.branch)
    const lock = path.join(source, '.git', 'refs', 'heads', `${row.branch}.lock`)
    writeFileSync(lock, '')
    await releaseMergedWorktrees([row], async () => true)
    expect(existsSync(row.worktreePath)).toBe(false)
    expect(git(source, 'branch', '--list', row.branch)).not.toBe('')
    rmSync(lock)
    expect(await releaseMergedWorktrees([row], async () => true)).toEqual({ ok: true, removed: 0 })
    expect(git(source, 'branch', '--list', row.branch)).toBe('')
  })

  it('refuses to reuse a leftover when a different branch was asked, rather than keeping the old one', async () => {
    const source = repo('manor-wt-honor-')
    git(source, 'branch', 'feature/other')
    const worktreesRoot = temp('manor-wt-root-')
    const created = await attachWorktrees({
      worktreesRoot,
      projectId: 'project_1',
      chatId: 'chat_1',
      repoPaths: [source],
      branch: 'feature/other',
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.mapping[0]?.branch).toBe('feature/other')

    const refused = await attachWorktrees({
      worktreesRoot,
      projectId: 'project_1',
      chatId: 'chat_1',
      repoPaths: [source],
      branch: 'does-not-exist',
    })
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.message).toMatch(/does not exist|leftover/i)

    const switched = await attachWorktrees({
      worktreesRoot,
      projectId: 'project_1',
      chatId: 'chat_1',
      repoPaths: [source],
      branch: autoBranchName('chat_1'),
    })
    // Auto name was never created here; leftover is on feature/other. Switch to a
    // missing name refuses rather than silently reporting feature/other.
    expect(switched.ok).toBe(false)
  })

  it('switches a leftover onto an existing requested branch', async () => {
    const source = repo('manor-wt-switch-')
    git(source, 'branch', 'topic-a')
    git(source, 'branch', 'topic-b')
    const worktreesRoot = temp('manor-wt-root-')
    const created = await attachWorktrees({
      worktreesRoot,
      projectId: 'project_1',
      chatId: 'chat_1',
      repoPaths: [source],
      branch: 'topic-a',
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return

    const switched = await attachWorktrees({
      worktreesRoot,
      projectId: 'project_1',
      chatId: 'chat_1',
      repoPaths: [source],
      branch: 'topic-b',
    })
    expect(switched.ok).toBe(true)
    if (!switched.ok) return
    expect(switched.mapping[0]?.branch).toBe('topic-b')
    expect(git(switched.mapping[0]!.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('topic-b')
  })

  it('isolates two repos that share a basename onto distinct dests', async () => {
    const leftParent = temp('manor-wt-left-')
    const rightParent = temp('manor-wt-right-')
    const left = path.join(leftParent, 'src')
    const right = path.join(rightParent, 'src')
    mkdirSync(left)
    mkdirSync(right)
    git(left, 'init', '--quiet', '-b', 'main')
    git(right, 'init', '--quiet', '-b', 'main')
    writeFileSync(path.join(left, 'README.md'), 'left\n')
    writeFileSync(path.join(right, 'README.md'), 'right\n')
    git(left, 'add', '.')
    git(left, 'commit', '--quiet', '-m', 'init')
    git(right, 'add', '.')
    git(right, 'commit', '--quiet', '-m', 'init')
    const worktreesRoot = temp('manor-wt-root-')

    const result = await attachWorktrees({
      worktreesRoot,
      projectId: 'project_1',
      chatId: 'chat_1',
      repoPaths: [left, right],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.mapping).toHaveLength(2)
    expect(result.mapping[0]?.worktreePath).not.toBe(result.mapping[1]?.worktreePath)
    expect(path.basename(result.mapping[0]!.worktreePath)).toBe('src')
    expect(path.basename(result.mapping[1]!.worktreePath)).toBe('src')
    expect(readFileSync(path.join(result.mapping[0]!.worktreePath, 'README.md'), 'utf8')).toBe('left\n')
    expect(readFileSync(path.join(result.mapping[1]!.worktreePath, 'README.md'), 'utf8')).toBe('right\n')
  })

  it('preflights leftover switches so a refusal leaves every leftover on its old branch', async () => {
    const first = repo('manor-wt-sw1-')
    const second = repo('manor-wt-sw2-')
    git(first, 'branch', 'topic-b')
    const worktreesRoot = temp('manor-wt-root-')
    const created = await attachWorktrees({
      worktreesRoot,
      projectId: 'project_1',
      chatId: 'chat_1',
      repoPaths: [first, second],
      branch: autoBranchName('chat_1'),
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const before = created.mapping.map((row) => git(row.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'))

    const refused = await attachWorktrees({
      worktreesRoot,
      projectId: 'project_1',
      chatId: 'chat_1',
      repoPaths: [first, second],
      branch: 'topic-b',
    })
    expect(refused.ok).toBe(false)
    expect(git(created.mapping[0]!.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(before[0])
    expect(git(created.mapping[1]!.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(before[1])
  })

  it('rolls back a registered worktree when copying includes fails', async () => {
    const source = repo('manor-wt-copyfail-', {
      'README.md': 'hi\n',
      '.gitignore': '.env\n',
      '.env': 'SECRET=nothing-real\n',
    })
    const envPath = path.join(source, '.env')
    chmodSync(envPath, 0)
    const worktreesRoot = temp('manor-wt-root-')
    try {
      const result = await attachWorktrees({
        worktreesRoot,
        projectId: 'project_1',
        chatId: 'chat_1',
        repoPaths: [source],
      })
      expect(result.ok).toBe(false)
      const dest = worktreeDir(worktreesRoot, 'project_1', 'chat_1', source)
      expect(existsSync(dest)).toBe(false)
      expect(git(source, 'worktree', 'list')).not.toContain(dest)
    } finally {
      chmodSync(envPath, 0o644)
    }
  })
})

describe('copyIncludes', () => {
  it('honours .worktreeinclude when present, and skips credentials', async () => {
    const source = repo('manor-wt-inc-', {
      'README.md': 'hi\n',
      '.gitignore': '.env\n.env.local\n.npmrc\nsecret.env\n',
      '.env': 'A=1\n',
      '.env.local': 'B=2\n',
      '.npmrc': 'token=nothing-real\n',
      'secret.env': 'C=3\n',
      '.worktreeinclude': 'secret.env\n.npmrc\n',
    })
    const dest = temp('manor-wt-inc-dest-')
    await copyIncludes(source, dest)

    expect(existsSync(path.join(dest, 'secret.env'))).toBe(true)
    expect(existsSync(path.join(dest, '.npmrc'))).toBe(false)
    expect(existsSync(path.join(dest, '.env'))).toBe(false)
  })

  it('expands gitignore patterns in .worktreeinclude', async () => {
    const source = repo('manor-wt-glob-', {
      'README.md': 'hi\n',
      '.gitignore': 'config/\n',
      'config/app.local.json': '{"ok":true}\n',
      'config/skip.json': '{"no":true}\n',
      '.worktreeinclude': 'config/*.local.json\n',
    })
    const dest = temp('manor-wt-glob-dest-')
    await copyIncludes(source, dest)

    expect(existsSync(path.join(dest, 'config/app.local.json'))).toBe(true)
    expect(existsSync(path.join(dest, 'config/skip.json'))).toBe(false)
  })
})

describe('removeWorktree and leftover discard', () => {
  it('refuses a dirty tree without force, and removes a clean one', async () => {
    const source = repo('manor-wt-rm-')
    const worktreesRoot = temp('manor-wt-root-')
    const created = await attachWorktrees({
      worktreesRoot,
      projectId: 'project_1',
      chatId: 'chat_1',
      repoPaths: [source],
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const dest = created.mapping[0]!.worktreePath
    writeFileSync(path.join(dest, 'wip.ts'), 'export {}\n')

    const dirty = await removeWorktree(source, dest)
    expect(dirty.ok).toBe(false)
    if (dirty.ok) return
    expect(dirty.dirty).toBe(true)
    expect(existsSync(dest)).toBe(true)

    const forced = await removeWorktree(source, dest, { force: true })
    expect(forced.ok).toBe(true)
    expect(existsSync(dest)).toBe(false)
  })

  it('can discard after the mapping is empty, which is the leftover path', async () => {
    const source = repo('manor-wt-left-')
    const worktreesRoot = temp('manor-wt-root-')
    const created = await attachWorktrees({
      worktreesRoot,
      projectId: 'project_1',
      chatId: 'chat_1',
      repoPaths: [source],
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const dest = created.mapping[0]!.worktreePath
    const status = await readCheckoutStatus({
      repoPaths: [source],
      mapping: [],
      worktreesRoot,
      projectId: 'project_1',
      chatId: 'chat_1',
    })
    expect(status.mode).toBe('current')
    expect(status.leftover?.branch).toBe(created.mapping[0]?.branch)

    const removed = await removeWorktree(source, dest)
    expect(removed.ok).toBe(true)
    const gone = await readCheckoutStatus({
      repoPaths: [source],
      mapping: [],
      worktreesRoot,
      projectId: 'project_1',
      chatId: 'chat_1',
    })
    expect(gone.leftover).toBeUndefined()
  })

  it('refuses to delete an unregistered directory when git status cannot run', async () => {
    const source = repo('manor-wt-unknown-')
    const dest = path.join(temp('manor-wt-junk-'), 'not-a-git')
    mkdirSync(dest, { recursive: true })
    writeFileSync(path.join(dest, 'wip.txt'), 'keep me\n')
    expect(await treeStatus(dest)).toBe('unknown')

    const removed = await removeWorktree(source, dest)
    expect(removed.ok).toBe(false)
    if (removed.ok) return
    expect(removed.dirty).toBe(false)
    expect(readFileSync(path.join(dest, 'wip.txt'), 'utf8')).toBe('keep me\n')
  })

  it('preflights a multi-repo discard so a dirty second tree does not remove the first', async () => {
    const first = repo('manor-wt-pre1-')
    const second = repo('manor-wt-pre2-')
    const worktreesRoot = temp('manor-wt-root-')
    const created = await attachWorktrees({
      worktreesRoot,
      projectId: 'project_1',
      chatId: 'chat_1',
      repoPaths: [first, second],
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    writeFileSync(path.join(created.mapping[1]!.worktreePath, 'wip.ts'), 'export {}\n')

    const removed = await removeWorktrees(created.mapping)
    expect(removed.ok).toBe(false)
    expect(existsSync(created.mapping[0]!.worktreePath)).toBe(true)
    expect(existsSync(created.mapping[1]!.worktreePath)).toBe(true)
  })

  it('reports dirty when a later mapped worktree is dirty', async () => {
    const first = repo('manor-wt-dirty-a-')
    const second = repo('manor-wt-dirty-b-')
    const worktreesRoot = temp('manor-wt-root-')
    const created = await attachWorktrees({
      worktreesRoot,
      projectId: 'project_1',
      chatId: 'chat_1',
      repoPaths: [first, second],
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    writeFileSync(path.join(created.mapping[1]!.worktreePath, 'wip.ts'), 'export {}\n')
    const isolated = await readCheckoutStatus({
      repoPaths: [first, second],
      mapping: created.mapping,
      worktreesRoot,
      projectId: 'project_1',
      chatId: 'chat_1',
    })
    expect(isolated.dirty).toBe(true)

    const leftover = await readCheckoutStatus({
      repoPaths: [first, second],
      mapping: [],
      worktreesRoot,
      projectId: 'project_1',
      chatId: 'chat_1',
    })
    expect(leftover.leftover?.dirty).toBe(true)
  })

  it('marks a branch occupied in the source as unavailable, and this chat’s branch as available', async () => {
    const source = repo('manor-wt-br-')
    git(source, 'checkout', '-b', 'topic')
    git(source, 'checkout', 'main')
    const worktreesRoot = temp('manor-wt-root-')
    const created = await attachWorktrees({
      worktreesRoot,
      projectId: 'project_1',
      chatId: 'chat_1',
      repoPaths: [source],
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const isolated = await readCheckoutStatus({
      repoPaths: [source],
      mapping: created.mapping,
      worktreesRoot,
      projectId: 'project_1',
      chatId: 'chat_1',
    })
    expect(isolated.branches.find((row) => row.name === 'main')).toMatchObject({
      available: false,
      home: true,
      reason: expect.stringMatching(/already checked out/),
    })
    expect(isolated.branches.find((row) => row.name === created.mapping[0]!.branch)?.available).toBe(true)
    expect(isolated.branches.find((row) => row.name === 'topic')?.available).toBe(true)
  })

  it('marks a foreign worktree occupied, not home', async () => {
    const source = repo('manor-wt-foreign-')
    git(source, 'checkout', '-b', 'topic')
    git(source, 'checkout', 'main')
    const worktreesRoot = temp('manor-wt-root-')
    const first = await attachWorktrees({
      worktreesRoot,
      projectId: 'project_1',
      chatId: 'chat_1',
      repoPaths: [source],
      branch: 'topic',
    })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const other = await readCheckoutStatus({
      repoPaths: [source],
      mapping: [],
      worktreesRoot,
      projectId: 'project_1',
      chatId: 'chat_2',
    })
    expect(other.branches.find((row) => row.name === 'topic')).toMatchObject({
      available: false,
      reason: expect.stringMatching(/already checked out/),
    })
    expect(other.branches.find((row) => row.name === 'topic')?.home).toBeUndefined()
    expect(other.branches.find((row) => row.name === 'main')).toMatchObject({ home: true })
  })

  it('reads the live HEAD, not the stored mapping, after a switch in the worktree', async () => {
    const source = repo('manor-wt-head-')
    git(source, 'checkout', '-b', 'topic')
    git(source, 'checkout', 'main')
    const worktreesRoot = temp('manor-wt-root-')
    const created = await attachWorktrees({
      worktreesRoot,
      projectId: 'project_1',
      chatId: 'chat_1',
      repoPaths: [source],
      branch: 'topic',
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const dest = created.mapping[0]!.worktreePath
    git(dest, 'checkout', '-b', 'other')
    const stored = created.mapping.map((row) => ({ ...row, branch: 'topic' }))
    expect(await liveWorktreeBranch(stored)).toBe('other')
    const status = await readCheckoutStatus({
      repoPaths: [source],
      mapping: stored,
      worktreesRoot,
      projectId: 'project_1',
      chatId: 'chat_1',
    })
    expect(status.branch).toBe('other')
  })

  it('returns no shared branch when two live worktrees disagree', async () => {
    const first = repo('manor-wt-split-a-')
    const second = repo('manor-wt-split-b-')
    git(first, 'checkout', '-b', 'topic')
    git(first, 'checkout', 'main')
    git(second, 'checkout', '-b', 'topic')
    git(second, 'checkout', 'main')
    const worktreesRoot = temp('manor-wt-root-')
    const created = await attachWorktrees({
      worktreesRoot,
      projectId: 'project_1',
      chatId: 'chat_1',
      repoPaths: [first, second],
      branch: 'topic',
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    git(created.mapping[0]!.worktreePath, 'checkout', '-b', 'other')
    expect(await liveWorktreeBranch(created.mapping)).toBeNull()
  })

  it('does not fall back to the stored name when HEAD is unreadable', async () => {
    expect(
      await liveWorktreeBranch([
        {
          sourcePath: '/missing-source',
          worktreePath: '/missing-worktree',
          branch: 'topic',
          createdAt: 1,
        },
      ]),
    ).toBeNull()
  })

  it('refuses a branch missing from a second live worktree, and allows it when creating', async () => {
    const first = repo('manor-wt-br-a-')
    const second = repo('manor-wt-br-b-')
    git(first, 'checkout', '-b', 'only-a')
    git(first, 'checkout', 'main')
    const worktreesRoot = temp('manor-wt-root-')
    const created = await attachWorktrees({
      worktreesRoot,
      projectId: 'project_1',
      chatId: 'chat_1',
      repoPaths: [first, second],
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const isolated = await readCheckoutStatus({
      repoPaths: [first, second],
      mapping: created.mapping,
      worktreesRoot,
      projectId: 'project_1',
      chatId: 'chat_1',
    })
    expect(isolated.branches.find((row) => row.name === 'only-a')).toMatchObject({
      available: false,
      reason: expect.stringMatching(/does not exist/),
    })

    const creating = await readCheckoutStatus({
      repoPaths: [first, second],
      mapping: [],
      worktreesRoot,
      projectId: 'project_1',
      chatId: 'chat_new',
    })
    expect(creating.branches.find((row) => row.name === 'only-a')?.available).toBe(true)
  })
})


describe('sweepWorktrees', () => {
  it('removes a clean orphan and leaves a living leftover and a dirty orphan', async () => {
    const source = repo('manor-wt-sweep-')
    const worktreesRoot = temp('manor-wt-root-')
    const living = await attachWorktrees({
      worktreesRoot,
      projectId: 'project_1',
      chatId: 'live',
      repoPaths: [source],
    })
    const orphan = await attachWorktrees({
      worktreesRoot,
      projectId: 'project_1',
      chatId: 'dead',
      repoPaths: [source],
    })
    const dirty = await attachWorktrees({
      worktreesRoot,
      projectId: 'project_1',
      chatId: 'dirty-dead',
      repoPaths: [source],
    })
    expect(living.ok && orphan.ok && dirty.ok).toBe(true)
    if (!living.ok || !orphan.ok || !dirty.ok) return
    writeFileSync(path.join(dirty.mapping[0]!.worktreePath, 'wip.ts'), 'export {}\n')

    const swept = await sweepWorktrees({ worktreesRoot, liveChatIds: ['live'] })
    expect(swept.directoriesRemoved).toBeGreaterThanOrEqual(1)
    expect(existsSync(living.mapping[0]!.worktreePath)).toBe(true)
    expect(existsSync(orphan.mapping[0]!.worktreePath)).toBe(false)
    expect(existsSync(dirty.mapping[0]!.worktreePath)).toBe(true)
  })

  it('leaves an unreadable orphan in place', async () => {
    const worktreesRoot = temp('manor-wt-root-')
    const junk = path.join(worktreesRoot, 'project_1', 'dead', sourceKey('/tmp/not-a-repo'), 'not-a-repo')
    mkdirSync(junk, { recursive: true })
    writeFileSync(path.join(junk, 'wip.txt'), 'keep\n')

    const swept = await sweepWorktrees({ worktreesRoot, liveChatIds: [] })
    expect(swept.directoriesRemoved).toBe(0)
    expect(existsSync(path.join(junk, 'wip.txt'))).toBe(true)
  })
})

describe('pruneWorktreeNodeModules', () => {
  it('strips nested node_modules and leaves the checkout', async () => {
    const source = repo('manor-wt-idle-nm-')
    const worktreesRoot = temp('manor-wt-root-')
    const living = await attachWorktrees({
      worktreesRoot,
      projectId: 'project_1',
      chatId: 'live',
      repoPaths: [source],
    })
    expect(living.ok).toBe(true)
    if (!living.ok) return
    const dest = living.mapping[0]!.worktreePath
    mkdirSync(path.join(dest, 'node_modules', 'left-pad'), { recursive: true })
    writeFileSync(path.join(dest, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1\n')
    mkdirSync(path.join(dest, 'apps', 'web', 'node_modules'), { recursive: true })
    writeFileSync(path.join(dest, 'apps', 'web', 'node_modules', 'keep.js'), '1\n')
    writeFileSync(path.join(dest, 'apps', 'web', 'index.ts'), 'export {}\n')

    expect(
      await pruneWorktreeNodeModules({ worktreesRoot, projectId: 'project_1', chatId: 'live' }),
    ).toBe(2)
    expect(existsSync(dest)).toBe(true)
    expect(existsSync(path.join(dest, 'README.md'))).toBe(true)
    expect(existsSync(path.join(dest, 'apps', 'web', 'index.ts'))).toBe(true)
    expect(existsSync(path.join(dest, 'node_modules'))).toBe(false)
    expect(existsSync(path.join(dest, 'apps', 'web', 'node_modules'))).toBe(false)
  })
})

describe('worktreeDir', () => {
  it('keeps the source basename so mention labels do not change spelling, under a source-key parent', () => {
    const source = '/Users/sam/Ontwikkeling/Manor'
    expect(worktreeDir('/.manor/worktrees', 'p1', 'c1', source)).toBe(
      `/.manor/worktrees/p1/c1/${sourceKey(source)}/Manor`,
    )
  })
})
