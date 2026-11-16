import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ThreadEvent } from '@manor/contracts'
import { captureTurnTree, diffTurnTrees } from '../src/turnFileSnapshots.js'
import { assertSameWorkResult, committedRepos, observeWorkCompletion, prepareWorkCompletion, repoSteps, retryRefusal, stopLine, unconfirmedCompletion } from '../src/workCompletion.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {
  cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' }, stdio: ['ignore', 'pipe', 'pipe'],
}).trim()
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'manor-completion-'))
  roots.push(root)
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.name', 'Test')
  git(root, 'config', 'user.email', 'test@example.test')
  writeFileSync(path.join(root, 'result.txt'), 'before\n')
  git(root, 'add', '.')
  git(root, 'commit', '-m', 'Initial')
  return root
}
function commit(root: string) {
  git(root, 'add', '.')
  git(root, 'commit', '-m', 'Reviewed result')
}

describe('observed Work completion', () => {
  it('requires a fresh result after an intervening write and skips ignored or reverted files', async () => {
    const root = fixture()
    writeFileSync(path.join(root, '.gitignore'), 'private.txt\n')
    commit(root)
    writeFileSync(path.join(root, 'result.txt'), 'approved\n')
    writeFileSync(path.join(root, 'private.txt'), 'not for git\n')
    const files = [path.join(root, 'result.txt'), path.join(root, 'private.txt')]
    const ready = await prepareWorkCompletion([root], files, [])
    expect(ready.repos[0]?.files).toEqual(['result.txt'])
    writeFileSync(path.join(root, 'result.txt'), 'changed\n')
    await expect(assertSameWorkResult(ready, await prepareWorkCompletion([root], files, []))).rejects.toThrow('files changed')
    writeFileSync(path.join(root, 'result.txt'), 'before\n')
    expect((await prepareWorkCompletion([root], files, [])).operation).toBe('none')
  })

  it('refuses a file that was clean at publication and changed again before Accept', async () => {
    const root = fixture()
    writeFileSync(path.join(root, 'touched.txt'), 'kept\n')
    commit(root)
    writeFileSync(path.join(root, 'result.txt'), 'approved\n')
    const files = [path.join(root, 'result.txt'), path.join(root, 'touched.txt')]
    const ready = await prepareWorkCompletion([root], files, [])
    expect(ready.repos[0]?.files).toEqual(['result.txt'])
    writeFileSync(path.join(root, 'touched.txt'), 'another writer\n')
    await expect(assertSameWorkResult(ready, await prepareWorkCompletion([root], files, []))).rejects.toThrow('files changed')
  })

  it('approves both sides of a moved file, so the old path leaves with the commit', async () => {
    const root = fixture()
    git(root, 'mv', 'result.txt', 'moved.txt')
    const ready = await prepareWorkCompletion([root], [path.join(root, 'moved.txt'), path.join(root, 'result.txt')], [])
    expect(ready.repos[0]?.files).toEqual(['moved.txt', 'result.txt'])
  })

  it('measures a symlink as its own entry, also when it points outside the repository or nowhere', async () => {
    const root = fixture()
    const outside = mkdtempSync(path.join(os.tmpdir(), 'manor-outside-'))
    roots.push(outside)
    writeFileSync(path.join(outside, 'target.txt'), 'outside\n')
    symlinkSync(path.join(outside, 'target.txt'), path.join(root, 'link'))
    symlinkSync(path.join(root, 'missing.txt'), path.join(root, 'dangling'))
    const held = await prepareWorkCompletion([root], [path.join(root, 'link'), path.join(root, 'dangling')], [])
    expect(held).toMatchObject({ status: 'pending', operation: 'commit' })
    expect(held.repos[0]?.files.sort()).toEqual(['dangling', 'link'])
    expect((await observeWorkCompletion(held)).status).toBe('blocked')
    commit(root)
    expect((await observeWorkCompletion(held)).status).toBe('complete')
  })

  it('can observe the first commit in a new repository', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'manor-first-commit-'))
    roots.push(root)
    git(root, 'init', '-b', 'main')
    git(root, 'config', 'user.name', 'Test')
    git(root, 'config', 'user.email', 'test@example.test')
    writeFileSync(path.join(root, 'result.txt'), 'approved\n')
    const ready = await prepareWorkCompletion([root], [path.join(root, 'result.txt')], [])
    commit(root)
    expect(ready.repos[0]?.files).toEqual(['result.txt'])
    expect((await observeWorkCompletion(ready)).status).toBe('complete')
  })

  it('keeps approval pending until the exact accepted content is committed, preserving the real index', async () => {
    const root = fixture()
    writeFileSync(path.join(root, 'result.txt'), 'approved\n')
    const held = await prepareWorkCompletion([root], [path.join(root, 'result.txt')], [])
    expect(held.status).toBe('pending')
    expect(git(root, 'diff', '--cached', '--name-only')).toBe('')
    expect((await observeWorkCompletion(held)).status).toBe('blocked')
    commit(root)
    expect(await observeWorkCompletion(held)).toMatchObject({ status: 'complete', operation: 'commit',
      commits: [{ path: realpathSync(root), hash: git(root, 'rev-parse', 'HEAD') }] })
  })

  it('counts the confirmed content as landed even when its commit also carries other work, and only then', async () => {
    const root = fixture()
    writeFileSync(path.join(root, 'result.txt'), 'approved\n')
    const held = await prepareWorkCompletion([root], [path.join(root, 'result.txt')], [])
    writeFileSync(path.join(root, 'other.txt'), 'unrelated\n')
    commit(root)
    expect(await observeWorkCompletion(held)).toMatchObject({ status: 'complete', commits: [{ hash: git(root, 'rev-parse', 'HEAD') }] })
  })

  it('accepts a committed later version that still holds the confirmed change, whatever changed around it', async () => {
    const root = fixture()
    writeFileSync(path.join(root, 'result.txt'), 'header\nbefore\nfooter\n')
    commit(root)
    writeFileSync(path.join(root, 'result.txt'), 'header\napproved\nfooter\n')
    const held = await prepareWorkCompletion([root], [path.join(root, 'result.txt')], [])
    // A neighbouring line changed too, and lines were added at both ends.
    writeFileSync(path.join(root, 'result.txt'), 'moved on first\nupdated header\napproved\nfooter\nand after\n')
    expect(await observeWorkCompletion(held)).toMatchObject({ status: 'blocked', message: 'result.txt is not committed on main.' })
    commit(root)
    expect((await observeWorkCompletion(held)).status).toBe('complete')
    // An edit since, still uncommitted, does not take back what the branch holds.
    writeFileSync(path.join(root, 'result.txt'), 'rewritten later\n')
    expect((await observeWorkCompletion(held)).status).toBe('complete')
  })

  it('reports verified absence as blocked and a rewrite of the changed lines as unknown', async () => {
    // The confirmed line never reached the branch, though another line in the file did.
    const elsewhere = fixture()
    writeFileSync(path.join(elsewhere, 'result.txt'), 'a\nb\nc\nd\ne\nf\n')
    commit(elsewhere)
    writeFileSync(path.join(elsewhere, 'result.txt'), 'a\nB\nc\nd\ne\nf\n')
    const skipped = await prepareWorkCompletion([elsewhere], [path.join(elsewhere, 'result.txt')], [])
    writeFileSync(path.join(elsewhere, 'result.txt'), 'a\nb\nc\nd\ne\nF\n')
    commit(elsewhere)
    expect((await observeWorkCompletion(skipped)).status).toBe('blocked')
    // An approved deletion, while the branch kept that line beside other work.
    const kept = fixture()
    writeFileSync(path.join(kept, 'result.txt'), 'keep\nremove this\n')
    commit(kept)
    writeFileSync(path.join(kept, 'result.txt'), 'keep\n')
    const deletion = await prepareWorkCompletion([kept], [path.join(kept, 'result.txt')], [])
    writeFileSync(path.join(kept, 'result.txt'), 'keep\nremove this\nother work\n')
    commit(kept)
    expect((await observeWorkCompletion(deletion)).status).toBe('blocked')
    // Another writer replaced the confirmed content before it was committed: Git cannot
    // tell that from a later version, so nothing is claimed either way.
    const replaced = fixture()
    writeFileSync(path.join(replaced, 'result.txt'), 'approved\n')
    const held = await prepareWorkCompletion([replaced], [path.join(replaced, 'result.txt')], [])
    writeFileSync(path.join(replaced, 'result.txt'), 'an unrelated replacement\n')
    commit(replaced)
    expect(await observeWorkCompletion(held)).toEqual(held)
    // A reason Git no longer backs gives way to saying Manor could not confirm it.
    expect(await observeWorkCompletion({ ...held, status: 'blocked', message: 'result.txt is not committed on main.' }))
      .toMatchObject({ status: 'blocked', message: 'Manor could not confirm result.txt on main.' })
  })

  it('counts a reordering only where the branch keeps the confirmed order', async () => {
    const root = fixture()
    writeFileSync(path.join(root, 'result.txt'), 'save()\nvalidate()\nnotify()\n')
    commit(root)
    writeFileSync(path.join(root, 'result.txt'), 'validate()\nsave()\nnotify()\n')
    const held = await prepareWorkCompletion([root], [path.join(root, 'result.txt')], [])
    // Same lines, but validation still runs after saving.
    writeFileSync(path.join(root, 'result.txt'), 'save()\nnotify()\nvalidate()\n')
    commit(root)
    expect(await observeWorkCompletion(held)).toEqual(held)
    writeFileSync(path.join(root, 'result.txt'), 'validate()\nlog()\nsave()\nnotify()\n')
    commit(root)
    expect((await observeWorkCompletion(held)).status).toBe('complete')
  })

  it('counts the file mode as part of the confirmed change', async () => {
    const root = fixture()
    chmodSync(path.join(root, 'result.txt'), 0o755)
    const executable = await prepareWorkCompletion([root], [path.join(root, 'result.txt')], [])
    chmodSync(path.join(root, 'result.txt'), 0o644)
    writeFileSync(path.join(root, 'result.txt'), 'another edit\n')
    commit(root)
    writeFileSync(path.join(root, 'result.txt'), 'before\n')
    commit(root)
    expect((await observeWorkCompletion(executable)).status).toBe('blocked')
    chmodSync(path.join(root, 'result.txt'), 0o755)
    commit(root)
    expect((await observeWorkCompletion(executable)).status).toBe('complete')
  })

  // 2026-10-07: the confirmed files reached main in two commits, one of them another
  // chat's that also carried unrelated files, and a later commit moved one file on. The
  // old check refused the unrelated files and the card warned the commit was missing.
  it('finds confirmed content spread over several commits in a shared checkout, also after a later edit', async () => {
    const root = fixture()
    writeFileSync(path.join(root, 'shared.txt'), 'kept\n')
    commit(root)
    writeFileSync(path.join(root, 'result.txt'), 'approved\n')
    writeFileSync(path.join(root, 'shared.txt'), 'approved too\n')
    const files = [path.join(root, 'result.txt'), path.join(root, 'shared.txt')]
    const held = { ...await prepareWorkCompletion([root], files, []), status: 'pending' as const }
    writeFileSync(path.join(root, 'bubble.txt'), 'another chat\n')
    git(root, 'add', 'shared.txt', 'bubble.txt')
    git(root, 'commit', '-m', 'Another chat sweeps in shared.txt')
    const swept = git(root, 'rev-parse', 'HEAD')
    git(root, 'add', 'result.txt')
    git(root, 'commit', '-m', 'Session result')
    const own = git(root, 'rev-parse', 'HEAD')
    writeFileSync(path.join(root, 'shared.txt'), 'moved on later\n')
    git(root, 'add', 'shared.txt')
    git(root, 'commit', '-m', 'Later edit')
    expect(await observeWorkCompletion(held)).toMatchObject({ status: 'complete', commits: [{ hash: swept }, { hash: own }] })
  })

  it('claims nothing when Git cannot answer', async () => {
    const root = fixture()
    writeFileSync(path.join(root, 'result.txt'), 'approved\n')
    const held = await prepareWorkCompletion([root], [path.join(root, 'result.txt')], [])
    rmSync(root, { recursive: true, force: true })
    expect(await observeWorkCompletion(held)).toEqual(held)
  })

  it('ignores another chat committing other files in a shared checkout', async () => {
    const root = fixture()
    writeFileSync(path.join(root, 'result.txt'), 'approved\n')
    const files = [path.join(root, 'result.txt')]
    const ready = await prepareWorkCompletion([root], files, [])
    writeFileSync(path.join(root, 'other.txt'), 'another chat\n')
    git(root, 'add', 'other.txt')
    git(root, 'commit', '-m', 'Another chat')
    const held = await prepareWorkCompletion([root], files, [])
    await assertSameWorkResult(ready, held)
    git(root, 'add', 'result.txt')
    git(root, 'commit', '-m', 'Session result')
    const session = git(root, 'rev-parse', 'HEAD')
    writeFileSync(path.join(root, 'third.txt'), 'later\n')
    git(root, 'add', 'third.txt')
    git(root, 'commit', '-m', 'Third chat')
    expect(await observeWorkCompletion(held)).toMatchObject({ status: 'complete', commits: [{ hash: session }] })
  })

  it('credits nothing by authorship in a shared checkout: a rewritten file stays unconfirmed, a dropped change blocked', async () => {
    const approve = async () => {
      const root = fixture()
      writeFileSync(path.join(root, 'result.txt'), 'a\nb\nc\nd\ne\n')
      commit(root)
      writeFileSync(path.join(root, 'result.txt'), 'a\nB\nc\nd\ne\n')
      writeFileSync(path.join(root, 'notes.txt'), 'approved\n')
      return { root, held: await prepareWorkCompletion([root], [path.join(root, 'result.txt'), path.join(root, 'notes.txt')], []) }
    }
    // notes.txt lands exactly, but in a shared tree that does not say who rewrote the changed line.
    const rewrote = await approve()
    writeFileSync(path.join(rewrote.root, 'result.txt'), 'a\nB2\nc\nd\ne\n')
    commit(rewrote.root)
    expect(await observeWorkCompletion(rewrote.held)).toEqual(rewrote.held)
    // The same commit shape with the change dropped and another line edited instead.
    const dropped = await approve()
    writeFileSync(path.join(dropped.root, 'result.txt'), 'a\nb\nc\nd\nE\n')
    commit(dropped.root)
    expect(await observeWorkCompletion(dropped.held)).toMatchObject({ status: 'blocked', message: 'result.txt is not committed on main.' })
  })

  it('measures a result published after another chat committed against the moved branch, so only its own files count', async () => {
    const root = fixture()
    writeFileSync(path.join(root, 'own.txt'), 'mine\n')
    writeFileSync(path.join(root, 'other.txt'), 'theirs\n')
    git(root, 'add', 'other.txt')
    git(root, 'commit', '-m', 'Another chat')
    // The turn measurement saw both files change in the shared tree.
    const files = [path.join(root, 'own.txt'), path.join(root, 'other.txt')]
    const ready = await prepareWorkCompletion([root], files, [])
    expect(ready.repos[0]).toMatchObject({ before: git(root, 'rev-parse', 'HEAD'), files: ['own.txt'] })
    await assertSameWorkResult(ready, await prepareWorkCompletion([root], files, []))
  })

  it('narrows a shared-checkout approval to the files another chat did not land with the published content', async () => {
    const root = fixture()
    writeFileSync(path.join(root, 'own.txt'), 'mine\n')
    writeFileSync(path.join(root, 'other.txt'), 'theirs\n')
    const files = [path.join(root, 'own.txt'), path.join(root, 'other.txt')]
    // Published while the other chat's edit still sat uncommitted in the same tree.
    const ready = await prepareWorkCompletion([root], files, [])
    expect(ready.repos[0]?.files.sort()).toEqual(['other.txt', 'own.txt'])
    git(root, 'add', 'other.txt')
    git(root, 'commit', '-m', 'Another chat')
    const current = await prepareWorkCompletion([root], files, [])
    expect(current.repos[0]?.files).toEqual(['own.txt'])
    await assertSameWorkResult(ready, current)

    // Landed with other content than the result published: the approval changed.
    writeFileSync(path.join(root, 'other.txt'), 'theirs, revised\n')
    git(root, 'commit', '-qam', 'Another chat again')
    await expect(assertSameWorkResult(ready, await prepareWorkCompletion([root], files, []))).rejects.toThrow('files changed')
  })

  it('confirms nothing to commit when another chat landed every published file', async () => {
    const root = fixture()
    writeFileSync(path.join(root, 'result.txt'), 'approved\n')
    const files = [path.join(root, 'result.txt')]
    const ready = await prepareWorkCompletion([root], files, [])
    commit(root)
    const current = await prepareWorkCompletion([root], files, [])
    expect(current).toMatchObject({ status: 'complete', operation: 'none', repos: [] })
    await assertSameWorkResult(ready, current)
    // A later edit still refuses, also once the folder is no longer measured at all.
    writeFileSync(path.join(root, 'result.txt'), 'unreviewed\n')
    await expect(assertSameWorkResult(ready, await prepareWorkCompletion([], files, []))).rejects.toThrow('files changed')
  })

  it('still refuses a worktree result whose files were committed on its branch after publication', async () => {
    const source = fixture()
    const tree = path.join(source, 'tree')
    git(source, 'worktree', 'add', '-b', 'session', tree)
    writeFileSync(path.join(tree, 'result.txt'), 'approved\n')
    const worktrees = [{ sourcePath: source, worktreePath: tree, branch: 'session', createdAt: 0 }]
    const files = [path.join(tree, 'result.txt')]
    const ready = await prepareWorkCompletion([tree], files, worktrees)
    commit(tree)
    await expect(assertSameWorkResult(ready, await prepareWorkCompletion([tree], files, worktrees))).rejects.toThrow('checkout changed')
  })

  it('requires the actual fast-forward into the approved branch', async () => {
    const source = fixture()
    const tree = path.join(source, 'tree')
    git(source, 'worktree', 'add', '-b', 'session', tree)
    writeFileSync(path.join(tree, 'result.txt'), 'approved\n')
    const held = await prepareWorkCompletion([tree], [path.join(tree, 'result.txt')], [
      { sourcePath: source, worktreePath: tree, branch: 'session', createdAt: 0 },
    ], 'main')
    commit(tree)
    expect((await observeWorkCompletion(held)).status).toBe('blocked')
    git(source, 'merge', '--ff-only', 'session')
    expect((await observeWorkCompletion(held)).status).toBe('complete')
    // What counts is the branch it was merged into, not what the linked folder has checked out now.
    git(source, 'switch', '-c', 'elsewhere')
    expect((await observeWorkCompletion(held)).status).toBe('complete')
  })

  it('reads the commit step on the Session branch before the merge, and keeps it when the merge fails', async () => {
    const source = fixture()
    const tree = path.join(source, 'tree')
    git(source, 'worktree', 'add', '-b', 'session', tree)
    writeFileSync(path.join(tree, 'result.txt'), 'approved\n')
    const held = await prepareWorkCompletion([tree], [path.join(tree, 'result.txt')], [
      { sourcePath: source, worktreePath: tree, branch: 'session', createdAt: 0 },
    ], 'main')
    expect(await committedRepos(held)).toEqual([])
    commit(tree)
    const repo = held.repos[0]!.path
    expect(await committedRepos(held)).toEqual([repo])
    // Main is untouched, so the merge failed while the commit stands.
    expect(await observeWorkCompletion(held)).toMatchObject({ status: 'blocked', committed: [repo] })
    expect(await repoSteps(held)).toEqual({ committed: [repo], merged: [] })
    git(source, 'merge', '--ff-only', 'session')
    expect(await repoSteps(held)).toEqual({ committed: [repo], merged: [repo] })
    // A target Git cannot read leaves the merge undecided, never the commit, and keeps a merge an earlier read proved.
    git(source, 'switch', '-q', '-c', 'other')
    git(source, 'branch', '-q', '-D', 'main')
    expect(await observeWorkCompletion(held)).toMatchObject({ status: 'pending', committed: [repo] })
    expect(await observeWorkCompletion({ ...held, merged: [repo] })).toMatchObject({ status: 'pending', committed: [repo], merged: [repo] })
  })

  it('records which repo committed when a commit request fails part way, without a watcher tick', async () => {
    const [a, b] = [fixture(), fixture()]
    for (const root of [a, b]) writeFileSync(path.join(root, 'result.txt'), 'approved\n')
    const held = await prepareWorkCompletion([a, b], [path.join(a, 'result.txt'), path.join(b, 'result.txt')], [])
    commit(a)
    expect(await observeWorkCompletion({ ...held, status: 'blocked' })).toMatchObject({ status: 'blocked', committed: [held.repos[0]!.path] })
  })

  it('confirms a merge by ancestry when the Session rebased its commit over main and resolved a conflict in it', async () => {
    const source = fixture()
    writeFileSync(path.join(source, 'result.txt'), 'a\nb\nc\n')
    commit(source)
    const tree = path.join(source, 'tree')
    git(source, 'worktree', 'add', '-b', 'session', tree)
    writeFileSync(path.join(tree, 'result.txt'), 'a\nB\nc\n')
    writeFileSync(path.join(tree, 'notes.txt'), 'approved\n')
    const held = await prepareWorkCompletion([tree], [path.join(tree, 'result.txt'), path.join(tree, 'notes.txt')], [
      { sourcePath: source, worktreePath: tree, branch: 'session', createdAt: 0 },
    ], 'main')
    commit(tree)
    // Main moved the same line meanwhile; the Session rebases and settles the conflict its own way.
    writeFileSync(path.join(source, 'result.txt'), 'a\nb2\nc\n')
    commit(source)
    expect(() => git(tree, 'rebase', 'main')).toThrow()
    writeFileSync(path.join(tree, 'result.txt'), 'a\nB2\nc\n')
    git(tree, 'add', 'result.txt')
    git(tree, '-c', 'core.editor=true', 'rebase', '--continue')
    // Not merged yet: the branch alone proves nothing about main.
    expect((await observeWorkCompletion(held)).status).not.toBe('complete')
    git(source, 'merge', '--ff-only', 'session')
    expect(await observeWorkCompletion(held)).toMatchObject({ status: 'complete', commits: [{ hash: git(source, 'rev-parse', 'main') }] })
  })

  it('takes authorship from the Session branch reflog, not from reaching a commit after a reset onto main', async () => {
    const source = fixture()
    writeFileSync(path.join(source, 'result.txt'), 'a\nb\nc\n')
    commit(source)
    const tree = path.join(source, 'tree')
    git(source, 'worktree', 'add', '-b', 'session', tree)
    writeFileSync(path.join(tree, 'result.txt'), 'a\nB\nc\n')
    writeFileSync(path.join(tree, 'notes.txt'), 'approved\n')
    const held = await prepareWorkCompletion([tree], [path.join(tree, 'result.txt'), path.join(tree, 'notes.txt')], [
      { sourcePath: source, worktreePath: tree, branch: 'session', createdAt: 0 },
    ], 'main')
    // Another chat lands the same notes.txt and rewrites the changed line; the Session discards its work.
    writeFileSync(path.join(source, 'notes.txt'), 'approved\n')
    writeFileSync(path.join(source, 'result.txt'), 'a\nB2\nc\n')
    commit(source)
    git(tree, 'reset', '--hard', 'main')
    expect(await observeWorkCompletion(held)).toEqual(held)
  })

  it('keeps a merge blocked for a confirmed file the Session never committed, and names it', async () => {
    const source = fixture()
    const tree = path.join(source, 'tree')
    git(source, 'worktree', 'add', '-b', 'session', tree)
    writeFileSync(path.join(tree, 'result.txt'), 'approved\n')
    writeFileSync(path.join(tree, 'notes.txt'), 'also approved\n')
    const held = await prepareWorkCompletion([tree], [path.join(tree, 'result.txt'), path.join(tree, 'notes.txt')], [
      { sourcePath: source, worktreePath: tree, branch: 'session', createdAt: 0 },
    ], 'main')
    git(tree, 'add', 'result.txt')
    git(tree, 'commit', '-m', 'Only part of the result')
    git(source, 'merge', '--ff-only', 'session')
    expect(await observeWorkCompletion(held)).toMatchObject({ status: 'blocked', message: 'notes.txt is not on main.' })
  })

  it('says why a merge is blocked: edits in the linked folder, or the linked folder on another branch', async () => {
    const source = fixture()
    const tree = path.join(source, 'tree')
    git(source, 'worktree', 'add', '-b', 'session', tree)
    writeFileSync(path.join(tree, 'result.txt'), 'approved\n')
    const held = await prepareWorkCompletion([tree], [path.join(tree, 'result.txt')], [
      { sourcePath: source, worktreePath: tree, branch: 'session', createdAt: 0 },
    ], 'main')
    commit(tree)
    // Another chat's uncommitted edit in the same file, which a fast-forward refuses to overwrite.
    writeFileSync(path.join(source, 'result.txt'), 'another chat\n')
    expect(await observeWorkCompletion(held)).toMatchObject({
      status: 'blocked', message: 'Commit or stash your changes to result.txt in the linked folder, then press Retry. The merge changes those files too.',
    })
    git(source, 'checkout', '--', 'result.txt')
    expect(await observeWorkCompletion(held)).toMatchObject({ status: 'blocked', message: 'The change is not on main yet.' })
    git(source, 'switch', '-c', 'elsewhere')
    expect(await observeWorkCompletion(held)).toMatchObject({ status: 'blocked', message: 'The linked folder is on elsewhere, not main.' })
  })

  it('turns a finished commit turn Git cannot confirm into a blocked state that names the branch', async () => {
    const source = fixture()
    const tree = path.join(source, 'tree')
    git(source, 'worktree', 'add', '-b', 'session', tree)
    writeFileSync(path.join(tree, 'result.txt'), 'approved\n')
    const held = await prepareWorkCompletion([tree], [path.join(tree, 'result.txt')], [
      { sourcePath: source, worktreePath: tree, branch: 'session', createdAt: 0 },
    ], 'main')
    expect(unconfirmedCompletion(held)).toMatchObject({ status: 'blocked', message: 'Manor could not confirm the merge into main.' })
  })
})

describe('completion when another Session edits the same file in the shared checkout', () => {
  // Three regions far enough apart that their measured hunks never share context.
  const text = (first: string, second: string, foreign: string) => [first, ...Array.from({ length: 8 }, (_, i) => `a ${i}`), second,
    ...Array.from({ length: 8 }, (_, i) => `b ${i}`), foreign].join('\n') + '\n'

  /**
   * The Session's turn writes `own` and is measured like a real turn; the other Session's
   * `pending` hunk arrives after it, or during it with `foreignDuring`.
   */
  async function approved(own: [string, string], options: { foreignDuring?: boolean; pending?: string } = {}) {
    const pending = options.pending ?? 'foreign pending'
    const root = fixture()
    const file = path.join(root, 'result.txt')
    writeFileSync(file, text('first', 'second', 'foreign'))
    commit(root)
    const start = await captureTurnTree(root)
    writeFileSync(file, text(own[0], own[1], options.foreignDuring === true ? pending : 'foreign'))
    const events: ThreadEvent[] = [
      { id: 'tool', ts: 0, type: 'tool_use', agentId: 'single', turnId: 'own', tool: 'Bash', toolCallId: 'call', command: 'node edit.mjs' },
      { id: 'own', ts: 0, type: 'turn_result', agentId: 'single', turnId: 'own', fileChangeRoots: [root],
        fileChanges: await diffTurnTrees(root, start, await captureTurnTree(root)) },
    ]
    writeFileSync(file, text(own[0], own[1], pending))
    const held = await prepareWorkCompletion([root], [file], [])
    /** Commits `committed` and leaves the other Session's hunk uncommitted again. */
    const land = (committed: [string, string]) => {
      writeFileSync(file, text(committed[0], committed[1], 'foreign'))
      commit(root)
      writeFileSync(file, text(own[0], own[1], pending))
    }
    return { root, file, held, events, land }
  }

  it('completes when the Session commits only its own hunks', async () => {
    const s = await approved(['first own', 'second own'])
    s.land(['first own', 'second own'])
    expect(await observeWorkCompletion(s.held, s.events)).toMatchObject({ status: 'complete' })
    expect(git(s.root, 'diff')).toContain('+foreign pending')
  })

  it('stays blocked and names the file when one of the Session’s own hunks is left uncommitted', async () => {
    const s = await approved(['first own', 'second own'])
    s.land(['first own', 'second'])
    expect(await observeWorkCompletion(s.held, s.events)).toMatchObject({ status: 'blocked', message: 'result.txt is not committed on main.' })
  })

  it.each([
    'a hunk written during the Session’s turn',
    'a hunk the record cannot place once',
    'a tool turn without a measurement',
    'a turn whose measurement failed',
    'a stopped turn that changed the file',
  ])('blocks on %s', async (kind) => {
    // The other Session copies the Session's own hunk, so undoing either copy would be a guess.
    const pending = kind === 'a hunk the record cannot place once' ? 'first own\na 0\na 1' : 'foreign pending'
    const s = await approved(['first own', 'second own'], { foreignDuring: kind === 'a hunk written during the Session’s turn', pending })
    const events = [...s.events]
    if (kind === 'a tool turn without a measurement') events.push({ id: 'later', ts: 0, type: 'tool_use', agentId: 'single',
      turnId: 'later', tool: 'Bash', toolCallId: 'later', command: 'node format.mjs' })
    if (kind === 'a turn whose measurement failed') events.push({ id: 'failed', ts: 0, type: 'turn_result', agentId: 'single',
      turnId: 'failed', fileChangesFailed: true })
    if (kind === 'a stopped turn that changed the file') events.push({ id: 'stopped', ts: 0, type: 'system_note', kind: 'error',
      text: 'Stopped.', changedFiles: [s.file] })
    s.land(['first own', 'second own'])
    expect(await observeWorkCompletion(s.held, events)).toMatchObject({ status: 'blocked', message: 'result.txt is not committed on main.' })
  })

  it('blocks when the own hunk’s text already stood elsewhere in the file and its own site moved on', async () => {
    const root = fixture()
    const file = path.join(root, 'result.txt')
    const block = (middle: string, context = 'gamma') => ['alpha', middle, context, 'delta'].join('\n')
    const filler = Array.from({ length: 8 }, (_, i) => `gap ${i}`).join('\n')
    const whole = (first: string, context?: string) => [block(first, context), filler, block('NEW'), filler, 'tail'].join('\n') + '\n'
    writeFileSync(file, whole('old'))
    commit(root)
    const start = await captureTurnTree(root)
    writeFileSync(file, whole('NEW'))
    const events: ThreadEvent[] = [{ id: 'own', ts: 0, type: 'turn_result', agentId: 'single', turnId: 'own', fileChangeRoots: [root],
      fileChanges: await diffTurnTrees(root, start, await captureTurnTree(root)) }]
    // Another Session edits the own hunk's context, so its text now stands only in the older copy.
    writeFileSync(file, whole('NEW', 'gamma2'))
    const held = await prepareWorkCompletion([root], [file], [])
    expect(await observeWorkCompletion(held, events)).toMatchObject({ status: 'blocked', message: 'result.txt is not committed on main.' })
  })

  it('ignores the commit turn’s own edits after the request', async () => {
    const s = await approved(['first own', 'second own'])
    s.land(['first own', 'second own'])
    const held = { ...s.held, requestEventId: 'request' }
    const events: ThreadEvent[] = [...s.events, { id: 'request', ts: 0, type: 'user_message', text: 'Commit it.', mentions: [] },
      { id: 'commit', ts: 0, type: 'tool_use', agentId: 'single', turnId: 'commit', tool: 'Bash', toolCallId: 'commit', command: 'git commit' }]
    expect(await observeWorkCompletion(held, events)).toMatchObject({ status: 'complete' })
  })

  it('refuses Retry when an approved file was moved after Confirm', async () => {
    const root = fixture()
    writeFileSync(path.join(root, 'result.txt'), 'approved\n')
    const ready = await prepareWorkCompletion([root], [path.join(root, 'result.txt')], [])
    expect(await retryRefusal(ready)).toBeUndefined()
    // Rename detection would only name moved.txt, which the approval does not list.
    git(root, 'mv', 'result.txt', 'moved.txt')
    expect(await retryRefusal(ready)).toBe('result.txt changed since Confirm. Request a new result in the Session.')
  })

  it('refuses Retry when a Session worktree moved to another branch, but not while it is mid-rebase', async () => {
    const root = fixture()
    const tree = path.join(root, '..', `${path.basename(root)}-session`)
    roots.push(tree)
    git(root, 'worktree', 'add', '-qb', 'manor/1234abcd', tree)
    const row = { sourcePath: root, worktreePath: tree, branch: 'manor/1234abcd', createdAt: 1, baseBranch: 'main' }
    writeFileSync(path.join(tree, 'result.txt'), 'approved\n')
    const held = await prepareWorkCompletion([tree], [path.join(tree, 'result.txt')], [row], 'main')
    git(tree, 'commit', '-qam', 'Approved')
    writeFileSync(path.join(root, 'other.txt'), 'main moved\n')
    git(root, 'add', 'other.txt')
    git(root, 'commit', '-qm', 'Other work')
    expect(() => git(tree, 'rebase', '--exec', 'false', 'main')).toThrow()
    expect(await retryRefusal(held)).toBeUndefined()
    git(tree, 'rebase', '--abort')
    git(tree, 'switch', '-qc', 'other-work')
    expect(await retryRefusal(held)).toBe(`Retry waits until ${path.basename(root)} is back on manor/1234abcd.`)
  })

  it('skips an empty stop and reads the one before it', () => {
    const held = { status: 'blocked' as const, operation: 'commit' as const, repos: [], requestEventId: 'request' }
    const events: ThreadEvent[] = [{ id: 'request', ts: 0, type: 'user_message', text: 'Commit it.', mentions: [] },
      { id: 'first', ts: 0, type: 'agent_message', agentId: 'single', turnId: 'commit', text: 'Real failure: the hook failed.' },
      { id: 'empty', ts: 0, type: 'agent_message', agentId: 'single', turnId: 'commit', text: 'Real failure: **' }]
    expect(stopLine(held, events)).toBe('The hook failed.')
  })
})
