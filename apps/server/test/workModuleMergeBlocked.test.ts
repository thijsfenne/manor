import { execFileSync } from 'node:child_process'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WorkCompletionSchema } from '@manor/contracts'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { mergeFixture } from './workModuleHarness.js'

describe('WorkModule merges confirmed worktree Sessions itself', () => {
  const { git, completionOf, linkedFolder } = mergeFixture()

  it('withholds the merge when the pre-commit hook rewrites files the commit does not hold', async () => {
    const repo = await linkedFolder({ 'a.md': 'a\n' }, {
      'pre-commit': 'if test -f main-only.md && test -f feature.md; then printf "formatted\\n" > feature.md; git add feature.md; fi',
    })
    const s = await repo.session('Autofix', { 'feature.md': 'feature\n' })
    s.scripted.afterCommit = mainMoves(repo)
    await s.confirm()
    await vi.waitFor(async () => expect((await completionOf(repo.h, s.handoffId))?.status).toBe('blocked'), { timeout: 10_000 })
    const trouble = repo.requests().filter((event) => event.mergeTrouble !== undefined)
    expect(trouble).toHaveLength(1)
    expect(trouble[0]?.instruction).toContain('the worktree holds changes the commit does not')
    expect(git(repo.source, 'log', '--format=%s', 'main')).toBe('Main adds a file\nInitial')
  }, 20_000)

  it('sends a pre-commit hook that fails after the rebase to the lead once, then blocks with its reason', async () => {
    // The two files pass the hook alone and fail it together, like a test that breaks only on the merged code.
    const repo = await linkedFolder({ 'a.md': 'a\n' }, {
      // Thirty long diagnostic lines first: the stored failure still fits the wire schema.
      'pre-commit': 'if git cat-file -e :main-only.md 2>/dev/null && git cat-file -e :feature.md 2>/dev/null; then ' +
        'for i in $(seq 30); do printf "%0200d\\n" "$i" >&2; done; echo "FAIL feature.test.ts clashes with main-only.md" >&2; exit 1; fi',
    })
    const s = await repo.session('Hook', { 'feature.md': 'feature\n' })
    s.scripted.afterCommit = () => {
      writeFileSync(path.join(repo.source, 'main-only.md'), 'main\n')
      git(repo.source, 'add', 'main-only.md')
      git(repo.source, 'commit', '-qm', 'Main adds a file')
    }
    // The lead's turn changes nothing, so the same failure comes back on the same commit.
    await s.confirm()
    await vi.waitFor(async () => expect((await completionOf(repo.h, s.handoffId))?.status).toBe('blocked'), { timeout: 10_000 })
    const trouble = repo.requests().filter((event) => event.mergeTrouble !== undefined)
    expect(trouble).toHaveLength(1)
    expect(trouble[0]?.mergeTrouble?.kind).toBe('hook')
    expect(trouble[0]?.instruction).toContain('FAIL feature.test.ts clashes with main-only.md')
    expect((await completionOf(repo.h, s.handoffId))?.message).toContain('The pre-commit hook failed on manor/hook')
    expect(WorkCompletionSchema.safeParse(await completionOf(repo.h, s.handoffId)).success).toBe(true)
    // A later Git recheck keeps Manor's reason instead of a generic "not on main".
    await repo.h.module.recheckBlocked()
    expect((await completionOf(repo.h, s.handoffId))?.message).toContain('The pre-commit hook failed on manor/hook')
    expect(git(repo.source, 'log', '--format=%s', 'main')).toBe('Main adds a file\nInitial')
    // The check left the worktree on its branch with nothing staged.
    expect(git(s.worktree, 'symbolic-ref', '--short', 'HEAD')).toBe('manor/hook')
    expect(git(s.worktree, 'status', '--porcelain')).toBe('')
  }, 20_000)

  it('keeps Confirm order when the first Session’s commit ends last', async () => {
    const repo = await linkedFolder({ 'a.md': 'a\n', 'b.md': 'b\n' })
    const first = await repo.session('Exportknop', { 'a.md': 'first\n' })
    const second = await repo.session('Kleurkiezer', { 'b.md': 'second\n' })
    let finish!: () => void
    const slow = new Promise<void>((resolve) => { finish = resolve })
    first.scripted.afterCommit = async () => { await slow }
    await first.confirm()
    await second.confirm()
    await vi.waitFor(async () => expect((await completionOf(repo.h, second.handoffId))?.merge).toMatchObject({ stage: 'queued', after: 'Exportknop' }), { timeout: 10_000 })
    expect(git(repo.source, 'log', '--format=%s', 'main')).toBe('Initial')
    finish()
    await vi.waitFor(async () => {
      expect((await completionOf(repo.h, first.handoffId))?.status).toBe('complete')
      expect((await completionOf(repo.h, second.handoffId))?.status).toBe('complete')
    }, { timeout: 15_000 })
    expect(git(repo.source, 'log', '--format=%s', 'main')).toBe('Kleurkiezer change\nExportknop change\nInitial')
  }, 30_000)

  /** A hook that fails, or only pauses, once main's new file meets the Session's: `mark` shows it runs. */
  const slowHook = (mark: string, fail: boolean) => ({
    'pre-commit': `if git cat-file -e :main-only.md 2>/dev/null && git cat-file -e :feature.md 2>/dev/null; then touch '${mark}'; sleep 1; ${fail ? 'echo "FAIL clash" >&2; exit 1' : 'exit 0'}; fi`,
  })
  const mainMoves = (repo: Awaited<ReturnType<typeof linkedFolder>>) => () => {
    writeFileSync(path.join(repo.source, 'main-only.md'), 'main\n')
    git(repo.source, 'add', 'main-only.md')
    git(repo.source, 'commit', '-qm', 'Main adds a file')
  }

  it('stops after three repairs when every amend still fails the hook', async () => {
    const repo = await linkedFolder({ 'a.md': 'a\n' }, {
      'pre-commit': 'if git cat-file -e :main-only.md 2>/dev/null && git cat-file -e :feature.md 2>/dev/null; then echo "FAIL clash" >&2; exit 1; fi',
    })
    const s = await repo.session('Budget', { 'feature.md': 'feature\n' })
    s.scripted.afterCommit = mainMoves(repo)
    let tries = 0
    // Each amend is a new commit that still fails Manor's hook run; the scripted lead skips its own.
    s.scripted.trouble = () => {
      writeFileSync(path.join(s.worktree, 'feature.md'), `try ${++tries}\n`)
      git(s.worktree, 'commit', '-qa', '--amend', '--no-edit', '--no-verify')
    }
    await s.confirm()
    await vi.waitFor(async () => expect((await completionOf(repo.h, s.handoffId))?.status).toBe('blocked'), { timeout: 15_000 })
    expect(repo.requests().filter((event) => event.mergeTrouble !== undefined)).toHaveLength(3)
    expect((await completionOf(repo.h, s.handoffId))?.message).toContain('The lead had 3 tries at this merge')
  }, 30_000)

  it('merges again itself after Retry on a merge it blocked, and settles once it lands', async () => {
    const outage = path.join(os.tmpdir(), `manor-outage-${process.pid}-${Date.now()}`)
    writeFileSync(outage, '')
    onTestFinished(() => rmSync(outage, { force: true }))
    // The merged code's hook fails for a reason outside it, like a service its tests need being down.
    const repo = await linkedFolder({ 'a.md': 'a\n' }, {
      'pre-commit': `if [ -e '${outage}' ] && git cat-file -e :main-only.md 2>/dev/null && git cat-file -e :feature.md 2>/dev/null; then echo "FAIL service down" >&2; exit 1; fi`,
    })
    const s = await repo.session('Retry', { 'feature.md': 'feature\n' })
    s.scripted.afterCommit = mainMoves(repo)
    await s.confirm()
    await vi.waitFor(async () => expect((await completionOf(repo.h, s.handoffId))?.merge?.stage).toBe('blocked'), { timeout: 15_000 })
    // The outage is over; the lead's retry turn finds its commit already on the branch.
    rmSync(outage)
    await repo.h.module.retryCompletion(s.handoffId)
    await vi.waitFor(async () => expect((await completionOf(repo.h, s.handoffId))?.status).toBe('complete'), { timeout: 15_000 })
    expect(git(repo.source, 'log', '--format=%s', 'main')).toBe('Retry change\nMain adds a file\nInitial')
    await vi.waitFor(async () => expect((await repo.h.store.getChat(s.workChatId))?.settledAt).not.toBeNull(), { timeout: 10_000 })
  }, 40_000)

  it('blocks a merge on uncommitted linked-folder changes in the files it touches, names them, and lands after Retry', async () => {
    const repo = await linkedFolder({ 'package.md': 'a\n', 'lock.md': 'a\n', 'other.md': 'a\n' })
    const s = await repo.session('Dirty', { 'package.md': 'session\n', 'lock.md': 'session\n' })
    // The user's own edits: two in the files the Session changes, one it never touches.
    writeFileSync(path.join(repo.source, 'package.md'), 'mine\n')
    writeFileSync(path.join(repo.source, 'lock.md'), 'mine\n')
    writeFileSync(path.join(repo.source, 'other.md'), 'mine\n')
    const head = git(repo.source, 'rev-parse', 'main')
    await s.confirm()
    await vi.waitFor(async () => expect((await completionOf(repo.h, s.handoffId))?.merge?.stage).toBe('blocked'), { timeout: 15_000 })
    // Plain words, no Git output, and only the overlap is named.
    expect((await completionOf(repo.h, s.handoffId))?.message)
      .toBe('Commit or stash your changes to lock.md and package.md in the linked folder, then press Retry. The merge changes those files too.')
    // Manor moved nothing of the user's: no commit, no stash, edits as they left them.
    expect(git(repo.source, 'rev-parse', 'main')).toBe(head)
    expect(git(repo.source, 'stash', 'list')).toBe('')
    expect(git(repo.source, 'status', '--porcelain')).toBe('M lock.md\n M other.md\n M package.md')
    // The user stashes the two files; their unrelated edit stays and does not block the Retry.
    git(repo.source, 'stash', 'push', '-q', '--', 'package.md', 'lock.md')
    await repo.h.module.retryCompletion(s.handoffId)
    await vi.waitFor(async () => expect((await completionOf(repo.h, s.handoffId))?.status).toBe('complete'), { timeout: 15_000 })
    expect(git(repo.source, 'log', '-1', '--format=%s', 'main')).toBe('Dirty change')
    expect(git(repo.source, 'status', '--porcelain')).toBe('M other.md')
  }, 40_000)

  it('catches an untracked folder where the merge adds a file', async () => {
    const repo = await linkedFolder({ 'a.md': 'a\n' })
    const s = await repo.session('Collide', { 'docs.md': 'session\n' })
    execFileSync('mkdir', ['-p', path.join(repo.source, 'docs.md')])
    writeFileSync(path.join(repo.source, 'docs.md', 'mine.md'), 'mine\n')
    await s.confirm()
    await vi.waitFor(async () => expect((await completionOf(repo.h, s.handoffId))?.merge?.stage).toBe('blocked'), { timeout: 15_000 })
    expect((await completionOf(repo.h, s.handoffId))?.message)
      .toBe('Commit or stash your changes to docs.md/mine.md in the linked folder, then press Retry. The merge changes those files too.')
  }, 40_000)

  it('does not wake the lead of a Session settled while its hook ran', async () => {
    const mark = path.join(os.tmpdir(), `manor-hook-${process.pid}-${Date.now()}`)
    onTestFinished(() => rmSync(mark, { force: true }))
    const repo = await linkedFolder({ 'a.md': 'a\n' }, slowHook(mark, true))
    const s = await repo.session('Settled', { 'feature.md': 'feature\n' })
    s.scripted.afterCommit = mainMoves(repo)
    await s.confirm()
    await vi.waitFor(() => expect(existsSync(mark)).toBe(true), { timeout: 10_000 })
    await repo.h.module.setSettled(s.workChatId, true)
    await vi.waitFor(async () => expect((await completionOf(repo.h, s.handoffId))?.status).toBe('blocked'), { timeout: 10_000 })
    expect(repo.requests().filter((event) => event.mergeTrouble !== undefined)).toEqual([])
    expect((await completionOf(repo.h, s.handoffId))?.message).toContain('The Session is settled')
  }, 20_000)

  it('finishes the earlier round when the user reopens the result while its merge runs', async () => {
    const mark = path.join(os.tmpdir(), `manor-hook-${process.pid}-${Date.now()}`)
    onTestFinished(() => rmSync(mark, { force: true }))
    const repo = await linkedFolder({ 'a.md': 'a\n' }, slowHook(mark, false))
    const s = await repo.session('Reopened', { 'feature.md': 'feature\n' })
    s.scripted.afterCommit = mainMoves(repo)
    await s.confirm()
    await vi.waitFor(() => expect(existsSync(mark)).toBe(true), { timeout: 10_000 })
    await repo.h.store.appendEvent(s.workChatId, { type: 'user_message', text: 'One more thing.', mentions: [] })
    const round = async () => (await repo.h.store.listWorkHandoffs()).find((row) => row.id === s.handoffId)?.goalConfirmations?.[0]?.completion
    await vi.waitFor(async () => expect((await round())?.status).toBe('complete'), { timeout: 10_000 })
    expect((await round())?.merge).toBeUndefined()
    expect(git(repo.source, 'log', '--format=%s', 'main')).toBe('Reopened change\nMain adds a file\nInitial')
  }, 20_000)
})
