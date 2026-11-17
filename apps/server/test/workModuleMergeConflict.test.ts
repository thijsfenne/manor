import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { mergeFixture } from './workModuleHarness.js'

describe('WorkModule merges confirmed worktree Sessions itself', () => {
  const { git, lines, completionOf, linkedFolder } = mergeFixture()

  it('sends a rebase conflict to the lead once, with Git’s words, and lands a fix that kept both sides without asking', async () => {
    const repo = await linkedFolder({ 'shared.md': lines({}) })
    const s = await repo.session('Conflict', { 'shared.md': lines({ 0: 'mine' }) })
    s.scripted.afterCommit = () => {
      writeFileSync(path.join(repo.source, 'shared.md'), lines({ 0: 'theirs' }))
      git(repo.source, 'commit', '-qam', 'Main edits the same line')
    }
    let fixing: unknown
    s.scripted.trouble = () => {
      fixing = undefined
      void completionOf(repo.h, s.handoffId).then((completion) => { fixing = completion?.merge?.stage })
      try { git(s.worktree, 'rebase', 'main') } catch { /* the conflict the lead resolves */ }
      writeFileSync(path.join(s.worktree, 'shared.md'), ['theirs', 'mine', ...lines({}).split('\n').slice(1)].join('\n'))
      git(s.worktree, 'add', 'shared.md')
      git(s.worktree, 'rebase', '--continue')
    }
    await s.confirm()
    await vi.waitFor(async () => expect((await completionOf(repo.h, s.handoffId))?.status).toBe('complete'), { timeout: 10_000 })
    const trouble = repo.requests().filter((event) => event.mergeTrouble !== undefined)
    expect(trouble).toHaveLength(1)
    expect(trouble[0]?.mergeTrouble).toEqual({ handoffId: s.handoffId, kind: 'conflict' })
    expect(trouble[0]?.instruction).toContain('stopped on a conflict in shared.md')
    expect(trouble[0]?.instruction).toContain('CONFLICT')
    expect(trouble[0]?.mentions).toEqual(['sage'])
    expect(fixing).toBe('fixing')
    // Manor's own message never reopened the confirmed result.
    expect((await repo.h.store.listWorkHandoffs()).find((row) => row.id === s.handoffId)?.goalConfirmations).toBeUndefined()
    expect(git(repo.source, 'show', 'main:shared.md').split('\n').slice(0, 2)).toEqual(['theirs', 'mine'])
    // Its message is no new work either: the landed Session settles.
    await vi.waitFor(async () => expect((await repo.h.store.getChat(s.workChatId))?.settledAt).not.toBeNull(), { timeout: 10_000 })
  }, 20_000)

  it('holds a conflict fix that rewrote a line until the user approves the diff on the card', async () => {
    const repo = await linkedFolder({ 'shared.md': lines({}) })
    const s = await repo.session('Rewrite', { 'shared.md': lines({ 0: 'mine' }) })
    s.scripted.afterCommit = () => {
      writeFileSync(path.join(repo.source, 'shared.md'), lines({ 0: 'theirs' }))
      git(repo.source, 'commit', '-qam', 'Main edits the same line')
    }
    s.scripted.trouble = () => {
      try { git(s.worktree, 'rebase', 'main') } catch { /* the conflict the lead resolves */ }
      writeFileSync(path.join(s.worktree, 'shared.md'), lines({ 0: 'mine and theirs' }))
      git(s.worktree, 'add', 'shared.md')
      git(s.worktree, 'rebase', '--continue')
    }
    await s.confirm()
    await vi.waitFor(async () => expect((await completionOf(repo.h, s.handoffId))?.merge?.stage).toBe('approve'), { timeout: 10_000 })
    const waiting = (await completionOf(repo.h, s.handoffId))!
    expect(waiting.status).toBe('pending')
    expect(waiting.merge?.fix?.files).toEqual(['shared.md'])
    expect(waiting.merge?.fix?.diff).toContain('+mine and theirs')
    expect(git(repo.source, 'show', 'main:shared.md').split('\n')[0]).toBe('theirs')
    await expect(repo.h.module.approveMergeFix(s.handoffId, 'not-the-tip')).rejects.toThrow('conflict fix changed')

    await repo.h.module.approveMergeFix(s.handoffId, waiting.merge!.fix!.tip)
    await vi.waitFor(async () => expect((await completionOf(repo.h, s.handoffId))?.status).toBe('complete'), { timeout: 10_000 })
    expect(git(repo.source, 'show', 'main:shared.md').split('\n')[0]).toBe('mine and theirs')
  }, 20_000)

  it('asks the user about a conflict fix the lead left on the old base, once Manor’s rebase dropped its side', async () => {
    const repo = await linkedFolder({ 'shared.md': lines({}) })
    const s = await repo.session('Dropped', { 'shared.md': lines({ 0: 'mine' }) })
    s.scripted.afterCommit = () => {
      writeFileSync(path.join(repo.source, 'shared.md'), lines({ 0: 'theirs' }))
      git(repo.source, 'commit', '-qam', 'Main edits the same line')
    }
    // No rebase: the amend takes main's line, so Manor's own rebase drops the commit cleanly.
    s.scripted.trouble = () => {
      writeFileSync(path.join(s.worktree, 'shared.md'), lines({ 0: 'theirs' }))
      git(s.worktree, 'commit', '-qa', '--amend', '--no-edit')
    }
    await s.confirm()
    await vi.waitFor(async () => expect((await completionOf(repo.h, s.handoffId))?.merge?.stage).toBe('approve'), { timeout: 10_000 })
    expect((await completionOf(repo.h, s.handoffId))?.merge?.fix?.diff).toContain('-mine')
  }, 20_000)

  it('asks the user when the lead skipped its own conflicted commit instead of resolving it', async () => {
    const repo = await linkedFolder({ 'shared.md': lines({}) })
    const s = await repo.session('Skipped', { 'shared.md': lines({ 0: 'mine' }) })
    s.scripted.afterCommit = () => {
      writeFileSync(path.join(repo.source, 'shared.md'), lines({ 0: 'theirs' }))
      git(repo.source, 'commit', '-qam', 'Main edits the same line')
    }
    s.scripted.trouble = () => {
      try { git(s.worktree, 'rebase', 'main') } catch { /* the conflict the lead drops */ }
      git(s.worktree, 'rebase', '--skip')
    }
    await s.confirm()
    await vi.waitFor(async () => expect((await completionOf(repo.h, s.handoffId))?.merge?.stage).toBe('approve'), { timeout: 10_000 })
    expect((await completionOf(repo.h, s.handoffId))?.merge?.fix?.diff).toContain('-mine')
  }, 20_000)

  it('shows a kept file main deleted on the approval card, even beside an unrelated change', async () => {
    const repo = await linkedFolder({ 'shared.md': lines({}) })
    const s = await repo.session('Kept', { 'shared.md': lines({ 0: 'mine' }) })
    s.scripted.afterCommit = () => {
      git(repo.source, 'rm', '-q', 'shared.md')
      git(repo.source, 'commit', '-qm', 'Main deletes the file')
    }
    // Keeping the Session's version leaves the file exactly as Git's conflicted tree has it.
    s.scripted.trouble = () => {
      try { git(s.worktree, 'rebase', 'main') } catch { /* modify/delete */ }
      git(s.worktree, 'add', 'shared.md')
      writeFileSync(path.join(s.worktree, 'notes.md'), 'unrelated\n')
      git(s.worktree, 'add', 'notes.md')
      git(s.worktree, '-c', 'core.editor=true', 'rebase', '--continue')
    }
    await s.confirm()
    await vi.waitFor(async () => expect((await completionOf(repo.h, s.handoffId))?.merge?.stage).toBe('approve'), { timeout: 10_000 })
    const fix = (await completionOf(repo.h, s.handoffId))?.merge?.fix
    expect(fix?.files).toEqual(expect.arrayContaining(['notes.md', 'shared.md']))
    expect(fix?.diff).toContain('--- /dev/null\n+++ fix/shared.md')
  }, 20_000)

  it('never takes marker-shaped text in a modify/delete file as proof of keeping both sides', async () => {
    const repo = await linkedFolder({ 'shared.md': 'plain\n' })
    const markers = 'top\n<<<<<<< ours\nmine\n=======\ntheirs\n>>>>>>> theirs\nend\n'
    const s = await repo.session('Literal', { 'shared.md': markers })
    s.scripted.afterCommit = () => {
      git(repo.source, 'rm', '-q', 'shared.md')
      git(repo.source, 'commit', '-qm', 'Main deletes the file')
    }
    s.scripted.trouble = () => {
      try { git(s.worktree, 'rebase', 'main') } catch { /* modify/delete */ }
      writeFileSync(path.join(s.worktree, 'shared.md'), 'top\nmine\ntheirs\nend\n')
      git(s.worktree, 'add', 'shared.md')
      git(s.worktree, '-c', 'core.editor=true', 'rebase', '--continue')
    }
    await s.confirm()
    await vi.waitFor(async () => expect((await completionOf(repo.h, s.handoffId))?.merge?.stage).toBe('approve'), { timeout: 10_000 })
    expect(git(repo.source, 'log', '--format=%s', 'main')).toBe('Main deletes the file\nInitial')
  }, 20_000)

  it('asks approval when the kept lines match a union merge Git did not make', async () => {
    // Git's conflict is C against B; a Myers union would call the Session's side alone "both".
    const repo = await linkedFolder({ 'shared.md': 'B\nD\nA\nC\nA\n' })
    const s = await repo.session('Union', { 'shared.md': 'A\nB\nA\n' })
    s.scripted.afterCommit = () => {
      writeFileSync(path.join(repo.source, 'shared.md'), 'A\nC\nA\n')
      git(repo.source, 'commit', '-qam', 'Target side')
    }
    s.scripted.trouble = () => {
      try { git(s.worktree, 'rebase', 'main') } catch { /* C against B */ }
      writeFileSync(path.join(s.worktree, 'shared.md'), 'A\nB\nA\n')
      git(s.worktree, 'add', 'shared.md')
      git(s.worktree, '-c', 'core.editor=true', 'rebase', '--continue')
    }
    await s.confirm()
    await vi.waitFor(async () => expect((await completionOf(repo.h, s.handoffId))?.merge?.stage).toBe('approve'), { timeout: 10_000 })
  }, 20_000)

  it('keeps the first conflict as the baseline when the lead amends before rebasing', async () => {
    const repo = await linkedFolder({ 'a.md': 'base A\n', 'b.md': 'base B\n' })
    const s = await repo.session('Baseline', { 'a.md': 'session A\n', 'b.md': 'session B\n' })
    let repairs = 0
    s.scripted.afterCommit = () => {
      writeFileSync(path.join(repo.source, 'a.md'), 'target A\n')
      writeFileSync(path.join(repo.source, 'b.md'), 'target B\n')
      git(repo.source, 'commit', '-qam', 'Target side')
    }
    s.scripted.trouble = () => {
      repairs += 1
      if (repairs === 1) {
        // Drops the Session's A on the old base, so the next rebase only conflicts on B.
        writeFileSync(path.join(s.worktree, 'a.md'), 'target A\n')
        git(s.worktree, 'commit', '--amend', '-qam', 'Drops Session A')
        return
      }
      try { git(s.worktree, 'rebase', 'main') } catch { /* B */ }
      writeFileSync(path.join(s.worktree, 'b.md'), 'target B\nsession B\n')
      git(s.worktree, 'add', '-A')
      git(s.worktree, '-c', 'core.editor=true', 'rebase', '--continue')
    }
    await s.confirm()
    await vi.waitFor(async () => expect((await completionOf(repo.h, s.handoffId))?.merge?.stage).toBe('approve'), { timeout: 10_000 })
    expect((await completionOf(repo.h, s.handoffId))?.merge?.fix?.diff).toContain('-session A')
  }, 20_000)

  it('asks again, with everything that would land, when a conflict follows an approved fix', async () => {
    const repo = await linkedFolder({ 'shared.md': 'base\n' })
    const s = await repo.session('Approved', { 'shared.md': 'session\n' })
    let repairs = 0
    s.scripted.afterCommit = () => {
      writeFileSync(path.join(repo.source, 'shared.md'), 'target\n')
      git(repo.source, 'commit', '-qam', 'Target one')
    }
    s.scripted.trouble = () => {
      repairs += 1
      try { git(s.worktree, 'rebase', 'main') } catch { /* conflict */ }
      writeFileSync(path.join(s.worktree, 'shared.md'), repairs === 1 ? 'approved\n' : 'second\n')
      git(s.worktree, 'add', '-A')
      git(s.worktree, '-c', 'core.editor=true', 'rebase', '--continue')
    }
    await s.confirm()
    await vi.waitFor(async () => expect((await completionOf(repo.h, s.handoffId))?.merge?.stage).toBe('approve'), { timeout: 10_000 })
    const first = (await completionOf(repo.h, s.handoffId))!.merge!.fix!
    // The target moves into the same lines, so the approved fix conflicts once more.
    writeFileSync(path.join(repo.source, 'shared.md'), 'session\n')
    git(repo.source, 'commit', '-qam', 'Target two')
    await repo.h.module.approveMergeFix(s.handoffId, first.tip)
    await vi.waitFor(async () => {
      const merge = (await completionOf(repo.h, s.handoffId))?.merge
      expect(merge?.stage === 'approve' && merge.fix?.tip !== first.tip).toBe(true)
    }, { timeout: 10_000 })
    expect(repairs).toBe(2)
    expect((await completionOf(repo.h, s.handoffId))?.merge?.fix?.diff).toContain('--- main/shared.md\n+++ fix/shared.md\n@@ -1 +1 @@\n-session\n+second')
    expect(git(repo.source, 'show', 'main:shared.md')).toBe('session')
  }, 20_000)

  it('undoes a clean rebase that ends elsewhere than the merge, so a target file never vanishes unseen', async () => {
    const repo = await linkedFolder({ 'a.md': 'a\n' })
    const s = await repo.session('Replay', { 'feature.md': 'feature\n' })
    s.scripted.afterCommit = () => {
      writeFileSync(path.join(s.worktree, 'tmp.md'), 'same\n')
      git(s.worktree, 'add', '-A')
      git(s.worktree, 'commit', '-qm', 'Feature with a scratch file')
      git(s.worktree, 'rm', '-q', 'tmp.md')
      git(s.worktree, 'commit', '-qm', 'Drop the scratch file')
      // The target adds the same file: the rebase skips the add and replays the removal.
      writeFileSync(path.join(repo.source, 'tmp.md'), 'same\n')
      git(repo.source, 'add', 'tmp.md')
      git(repo.source, 'commit', '-qm', 'Main adds tmp')
    }
    await s.confirm()
    await vi.waitFor(async () => expect((await completionOf(repo.h, s.handoffId))?.status).toBe('blocked'), { timeout: 10_000 })
    const trouble = repo.requests().filter((event) => event.mergeTrouble !== undefined)
    expect(trouble[0]?.instruction).toContain('replayed its commits into a different result than merging it would')
    expect(git(repo.source, 'log', '--format=%s', 'main')).toBe('Main adds tmp\nInitial')
    expect(git(repo.source, 'show', 'main:tmp.md')).toBe('same')
  }, 20_000)

  it('blocks, with the branch untouched, when the worktree cannot return to it after that rebase', async () => {
    // A post-rewrite hook edits a file only the target has, so `reset --keep` refuses.
    const repo = await linkedFolder({ 'a.md': 'a\n' }, { 'post-rewrite': 'printf "generated\\n" > main-only.md' })
    const s = await repo.session('Stuck', { 'feature.md': 'feature\n' })
    let before = ''
    s.scripted.afterCommit = () => {
      writeFileSync(path.join(s.worktree, 'tmp.md'), 'same\n')
      git(s.worktree, 'add', '-A')
      git(s.worktree, 'commit', '-qm', 'Feature with a scratch file')
      git(s.worktree, 'rm', '-q', 'tmp.md')
      git(s.worktree, 'commit', '-qm', 'Drop the scratch file')
      before = git(s.worktree, 'rev-parse', 'HEAD')
      writeFileSync(path.join(repo.source, 'tmp.md'), 'same\n')
      writeFileSync(path.join(repo.source, 'main-only.md'), 'main\n')
      git(repo.source, 'add', '-A')
      git(repo.source, 'commit', '-qm', 'Main adds tmp')
    }
    await s.confirm()
    await vi.waitFor(async () => expect((await completionOf(repo.h, s.handoffId))?.status).toBe('blocked'), { timeout: 10_000 })
    expect(repo.requests().filter((event) => event.mergeTrouble !== undefined)).toHaveLength(0)
    // The rebase ran detached: the branch never left the lead's commit.
    expect(git(s.worktree, 'rev-parse', `refs/heads/${s.branch}`)).toBe(before)
    expect(git(repo.source, 'log', '--format=%s', 'main')).toBe('Main adds tmp\nInitial')
  }, 20_000)
})
