import { rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { mergeFixture } from './workModuleHarness.js'

describe('WorkModule merges confirmed worktree Sessions itself', () => {
  const { git, completionOf, linkedFolder } = mergeFixture()

  it('commits with the Session’s own message at Confirm and lands a clean rebase without a single model turn', async () => {
    const repo = await linkedFolder({ 'a.md': 'a\n', 'b.md': 'b\n' })
    const s = await repo.session('Clean', { 'a.md': 'mine\n' },
      { subject: 'Clean change', body: 'Why it changed.\n\nCo-Authored-By: Test Lead <lead@example.test>' })
    s.scripted.afterCommit = () => {
      // Main moves while Manor commits; the rebase onto it is clean.
      writeFileSync(path.join(repo.source, 'b.md'), 'main moved\n')
      git(repo.source, 'commit', '-qam', 'Elsewhere on main')
    }
    await s.confirm()
    await vi.waitFor(async () => expect((await completionOf(repo.h, s.handoffId))?.status).toBe('complete'), { timeout: 10_000 })
    expect(repo.requests()).toHaveLength(0)
    expect(await repo.confirmEvent(s)).toMatchObject({ dispatchState: 'completed', confirmRequest: { variant: 'merge', manor: true } })
    expect(git(repo.source, 'log', '--format=%s', 'main')).toBe('Clean change\nElsewhere on main\nInitial')
    expect(git(repo.source, 'log', '-1', '--format=%B', 'main')).toBe('Clean change\n\nWhy it changed.\n\nCo-Authored-By: Test Lead <lead@example.test>')
    // Exactly the approved file, nothing else the worktree held.
    expect(git(repo.source, 'show', '--format=', '--name-only', 'main')).toBe('a.md')
    expect(git(repo.source, 'status', '--porcelain')).toBe('')
    expect((await completionOf(repo.h, s.handoffId))?.merge).toBeUndefined()
  }, 20_000)

  it('lands two Sessions confirmed back to back in order, the second waiting “after” the first', async () => {
    // The fast-forward's post-merge hook holds the first merge long enough for the second to queue.
    const repo = await linkedFolder({ 'a.md': 'a\n', 'b.md': 'b\n' }, { 'post-merge': 'sleep 1' })
    const first = await repo.session('Exportknop', { 'a.md': 'first\n' })
    const second = await repo.session('Kleurkiezer', { 'b.md': 'second\n' })
    const stages: unknown[] = []
    const watch = setInterval(() => {
      void completionOf(repo.h, second.handoffId).then((completion) => { if (completion?.merge !== undefined) stages.push(completion.merge) })
    }, 20)
    onTestFinished(() => clearInterval(watch))
    await first.confirm()
    await second.confirm()
    await vi.waitFor(async () => {
      expect((await completionOf(repo.h, first.handoffId))?.status).toBe('complete')
      expect((await completionOf(repo.h, second.handoffId))?.status).toBe('complete')
    }, { timeout: 15_000 })
    expect(stages).toContainEqual(expect.objectContaining({ stage: 'queued', after: 'Exportknop', ahead: 1 }))
    expect(git(repo.source, 'log', '--format=%s', 'main')).toBe('Kleurkiezer change\nExportknop change\nInitial')
    // Neither commit nor merge needed the lead.
    expect(repo.requests()).toEqual([])
  }, 30_000)

  it('falls back to the commit-message writer, then to a plain message, when the lead handed none in', async () => {
    const written: string[] = []
    const repo = await linkedFolder({ 'a.md': 'a\n', 'b.md': 'b\n' }, {}, {
      writeCommitMessage: async (_chatId, patch) => { written.push(patch); return patch.includes('+mine') ? 'Write the writer subject\n\nWhy, from the patch.' : undefined },
    })
    const first = await repo.session('Written', { 'a.md': 'mine\n' }, null)
    await first.confirm()
    await vi.waitFor(async () => expect((await completionOf(repo.h, first.handoffId))?.status).toBe('complete'), { timeout: 10_000 })
    expect(git(repo.source, 'log', '-1', '--format=%B', 'main')).toBe('Write the writer subject\n\nWhy, from the patch.')
    // The writer had no answer for this patch, so the plain message names the file.
    const second = await repo.session('Plain', { 'b.md': 'other\n' }, null)
    await second.confirm()
    await vi.waitFor(async () => expect((await completionOf(repo.h, second.handoffId))?.status).toBe('complete'), { timeout: 10_000 })
    expect(git(repo.source, 'log', '-1', '--format=%B', 'main')).toBe('Update b.md')
    expect(written).toHaveLength(2)
    expect(repo.requests()).toEqual([])
  }, 20_000)

  it('never commits with a message from before the result was reopened', async () => {
    const repo = await linkedFolder({ 'a.md': 'a\n', 'b.md': 'b\n' }, {}, { writeCommitMessage: async () => 'Write it from the patch' })
    const replaced = await repo.session('Replaced', { 'a.md': 'first\n' }, { subject: 'Describe the first try' })
    const reopen = async (s: { handoffId: string }) => {
      const held = (await repo.h.store.listWorkHandoffs()).find((row) => row.id === s.handoffId)!
      await repo.h.store.reviseWorkGoal(s.handoffId, held.version, 'Tweak it.')
      expect((await repo.h.store.listWorkHandoffs()).find((row) => row.id === s.handoffId)?.goalReport).toBeUndefined()
    }
    await reopen(replaced)
    writeFileSync(path.join(replaced.worktree, 'a.md'), 'tweaked\n')
    await replaced.reach({ subject: 'Describe the tweak' })
    await replaced.confirm()
    await vi.waitFor(async () => expect((await completionOf(repo.h, replaced.handoffId))?.status).toBe('complete'), { timeout: 10_000 })
    expect(git(repo.source, 'log', '-1', '--format=%B', 'main')).toBe('Describe the tweak')
    // A result reached again without a message commits with the writer's, never the old one.
    const unused = await repo.session('Unused', { 'b.md': 'first\n' }, { subject: 'Describe the old code' })
    await reopen(unused)
    await unused.reach(null)
    await unused.confirm()
    await vi.waitFor(async () => expect((await completionOf(repo.h, unused.handoffId))?.status).toBe('complete'), { timeout: 10_000 })
    expect(git(repo.source, 'log', '--format=%s', 'main')).toBe('Write it from the patch\nDescribe the tweak\nInitial')
  }, 20_000)

  it('hands a commit the pre-commit hook refused to the lead as one turn, then merges what it committed', async () => {
    // The hook fails for a reason outside the change, like a service its tests need being down.
    const outage = path.join(os.tmpdir(), `manor-outage-${process.pid}-${Date.now()}`)
    onTestFinished(() => rmSync(outage, { force: true }))
    const repo = await linkedFolder({ 'a.md': 'a\n' }, { 'pre-commit': `if [ -e '${outage}' ]; then echo "FAIL service down" >&2; exit 1; fi` })
    const s = await repo.session('Hooked', { 'feature.md': 'feature\n' }, { subject: 'Add the feature' })
    writeFileSync(outage, '')
    s.scripted.commit = () => {
      rmSync(outage)
      git(s.worktree, 'add', 'feature.md')
      git(s.worktree, 'commit', '-qm', 'Add the feature')
    }
    await s.confirm()
    await vi.waitFor(async () => expect((await completionOf(repo.h, s.handoffId))?.status).toBe('complete'), { timeout: 10_000 })
    expect(repo.requests()).toHaveLength(1)
    const handed = repo.requests()[0]!
    expect(handed.confirmRequest?.manor).toBeUndefined()
    expect(handed.mergeTrouble).toBeUndefined()
    expect(handed.instruction).toContain('Manor tried to commit')
    expect(handed.instruction).toContain('FAIL service down')
    expect(handed.instruction).toContain('Add the feature')
    // The handed-over turn is the next attempt under the same Confirm; Manor's own request is over.
    const completion = (await completionOf(repo.h, s.handoffId))!
    expect(completion.retries).toHaveLength(1)
    expect((await repo.h.store.loadEvents(s.workChatId)).find((event) => event.id === completion.requestEventId))
      .toMatchObject({ dispatchState: 'completed', confirmRequest: { manor: true } })
    expect(git(repo.source, 'log', '--format=%s', 'main')).toBe('Add the feature\nInitial')
  }, 20_000)

  it('commits nothing when the files changed while the commit waited its turn', async () => {
    const repo = await linkedFolder({ 'a.md': 'a\n' })
    const s = await repo.session('Waited', { 'a.md': 'approved\n' }, { subject: 'Describe the approved code' })
    // A turn queued ahead of the commit edits the approved file.
    s.scripted.beforeCommit = () => { writeFileSync(path.join(s.worktree, 'a.md'), 'newer\n') }
    await s.confirm()
    await vi.waitFor(async () => expect((await completionOf(repo.h, s.handoffId))?.status).toBe('blocked'), { timeout: 10_000 })
    expect((await completionOf(repo.h, s.handoffId))?.message).toContain('changed after Confirm, so Manor did not commit them')
    // A later Git read keeps Manor's reason.
    await repo.h.module.recheckBlocked()
    expect((await completionOf(repo.h, s.handoffId))?.message).toContain('changed after Confirm, so Manor did not commit them')
    expect(git(s.worktree, 'log', '--format=%s', s.branch)).toBe('Initial')
    expect(git(repo.source, 'log', '--format=%s', 'main')).toBe('Initial')
    expect(repo.requests()).toEqual([])
  }, 20_000)

  it.each([['extra.md', 'extra.md'], ['a name that starts with a space', ' feature.md']])(
    'takes back a commit a passing hook widened with %s, and merges nothing', async (_case, extra) => {
      const repo = await linkedFolder({ 'a.md': 'a\n' }, {
        'pre-commit': `if git cat-file -e :feature.md 2>/dev/null; then printf "generated\\n" > '${extra}'; git add -- '${extra}'; fi`,
      })
      const s = await repo.session('Widened', { 'feature.md': 'feature\n' }, { subject: 'Add the feature' })
      await s.confirm()
      await vi.waitFor(async () => expect((await completionOf(repo.h, s.handoffId))?.status).toBe('blocked'), { timeout: 10_000 })
      const reason = `The commit holds ${extra} beyond what Confirm approved`
      expect((await completionOf(repo.h, s.handoffId))?.message).toContain(reason)
      expect(git(s.worktree, 'log', '--format=%s', s.branch)).toBe('Initial')
      // A later Git read keeps Manor's reason, from its note in the Session.
      await repo.h.module.recheckBlocked()
      expect((await completionOf(repo.h, s.handoffId))?.message).toContain(reason)
      expect(git(repo.source, 'log', '--format=%s', 'main')).toBe('Initial')
      expect(repo.requests()).toEqual([])
    }, 20_000)

  it('blocks Manor’s commit a restart left unchecked when it holds more than the approval', async () => {
    const repo = await linkedFolder({ 'a.md': 'a\n' })
    const s = await repo.session('Restarted', { 'feature.md': 'feature\n' }, { subject: 'Add the feature' })
    // The server stops mid-commit: the commit, widened by a hook, is on the branch, and its check never ran.
    repo.h.orchestrator.runExclusive = () => new Promise<never>(() => undefined)
    await s.confirm()
    writeFileSync(path.join(s.worktree, 'extra.md'), 'generated\n')
    git(s.worktree, 'add', 'feature.md', 'extra.md')
    git(s.worktree, 'commit', '-qm', 'Add the feature')
    const request = (await repo.confirmEvent(s))!
    expect(request.dispatchState).toBe('started')
    // Boot marks a request that was running uncertain, then reads Git.
    await repo.h.store.replaceEvent(s.workChatId, { ...request, dispatchState: 'uncertain' })
    await repo.h.module.reconcileCompletion(s.workChatId)
    expect((await completionOf(repo.h, s.handoffId))).toMatchObject({ status: 'blocked',
      message: 'The commit holds extra.md beyond what Confirm approved. Request a new result in the Session.' })
    expect(git(repo.source, 'log', '--format=%s', 'main')).toBe('Initial')
  }, 20_000)
})
