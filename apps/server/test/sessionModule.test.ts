import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ChatSchema, ProjectSchema, WorkHandoffSchema, type ServerMessage, type ThreadEvent, type WorkCompletion } from '@manor/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionModule } from '../src/sessionModule.js'
import { liveSessionFiles, readSessionDiff, readSessionStatus, repoRemote } from '../src/sessionGit.js'
import { prepareWorkCompletion } from '../src/workCompletion.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {
  cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' }, stdio: ['ignore', 'pipe', 'pipe'],
}).trim()

function temp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)))
  dirs.push(dir)
  return dir
}

/** A checkout on `main` tracking a bare `origin`, both at one commit. */
function fixture() {
  const remote = temp('manor-session-remote-')
  git(remote, 'init', '--bare', '-b', 'main')
  const root = temp('manor-session-')
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.name', 'Test')
  git(root, 'config', 'user.email', 'test@example.test')
  for (const name of ['a.txt', 'b.txt', 'other.txt']) writeFileSync(path.join(root, name), `${name} before\n`)
  git(root, 'add', '.')
  git(root, 'commit', '-m', 'Initial')
  git(root, 'remote', 'add', 'origin', remote)
  git(root, 'push', '-u', 'origin', 'main')
  return { root, remote }
}

/** A turn that changed these files, the record `sessionChangedFiles` reads. */
const changed = (root: string, ...names: string[]): ThreadEvent => ({
  id: 'evt_1', ts: 1, type: 'turn_result', agentId: 'wren', turnId: 'turn_1',
  fileChanges: names.map((name) => ({ path: path.join(root, name), status: 'edited', added: 1, removed: 1, edits: [] })),
  fileChangeRoots: [root],
})

function harness(root: string, events: ThreadEvent[], completion?: WorkCompletion, opened: string[][] = [], onAck: () => void = () => undefined, onCommitted: () => void = () => undefined) {
  const chat = ChatSchema.parse({ id: 'chat_1', projectId: 'project_1', title: 'Session', createdAt: 1, lastMessageAt: 1, settledAt: null, archivedAt: null })
  const project = ProjectSchema.parse({ id: 'project_1', name: 'Manor', repoPaths: [root] })
  const handoff = completion === undefined ? undefined : WorkHandoffSchema.parse({
    id: 'handoff_1', sourceChatId: 'dm_1', sourceTurnId: 'turn_0', workChatId: 'chat_1', projectId: 'project_1', projectName: 'Manor',
    title: 'Ship it', leadAgentId: 'wren', leadAgentName: 'Wren', supportingAgentIds: [], supportingAgentNames: [], state: 'active',
    result: null, resultAt: null, version: 3, createdAt: 1, acceptedAt: 1, goalReachedAt: 2,
    goalReport: { result: 'Done.' }, goalChangedFiles: completion.repos.flatMap((repo) => repo.files.map((file) => path.join(root, file))),
    goalCompletion: completion,
  })
  const replies: ServerMessage[] = []
  let acks = 0
  // Set from a test to make the store's reads fail from then on.
  const store = { broken: false }
  const module = new SessionModule({
    store: {
      getChat: async () => {
        if (store.broken) throw new Error('store unavailable')
        return chat
      },
      getProject: async () => project,
      loadChatWorktrees: async () => [],
      loadEvents: async () => events,
      workHandoffForTarget: async () => handoff,
    },
    orchestrator: { tryRunExclusive: async (_chatId, fn) => ({ occupied: false as const, value: await fn() }) },
    broadcast: (message) => replies.push(message),
    externalFiles: { apps: ['cursor'], open: async (app, target, kind) => { opened.push([app, target, kind ?? 'file']) } },
    onCommitted,
  })
  const context = { reply: (message: ServerMessage) => replies.push(message), ack: () => { acks += 1; onAck() } }
  const notices = () => replies.flatMap((message) => message.type === 'notice' ? [message.text] : [])
  return { module, context, replies, notices, acks: () => acks, store }
}

describe('Session Commit', () => {
  it('commits only the ticked Session files and leaves everything else where it was', async () => {
    const { root } = fixture()
    writeFileSync(path.join(root, 'a.txt'), 'a.txt after\n')
    writeFileSync(path.join(root, 'b.txt'), 'b.txt after\n')
    writeFileSync(path.join(root, 'new.txt'), 'brand new\n')
    // Another chat's work in the same checkout, staged and all.
    writeFileSync(path.join(root, 'other.txt'), 'another chat\n')
    git(root, 'add', 'other.txt')
    let committed = 0
    const { module, context, notices, acks, replies } = harness(root, [changed(root, 'a.txt', 'b.txt', 'new.txt')], undefined, [], undefined, () => { committed += 1 })

    const before = await module.status('chat_1')
    expect(before.repos[0]?.uncommitted.map((file) => file.path).sort()).toEqual(['a.txt', 'b.txt', 'new.txt'])

    await module.handle({ type: 'commit_session', chatId: 'chat_1', root, files: ['a.txt', 'new.txt'], message: 'Ship a' }, context)
    expect(notices()).toEqual([])
    expect(acks()).toBe(1)
    expect(git(root, 'show', '--name-only', '--format=%s', 'HEAD').split('\n').filter(Boolean)).toEqual(['Ship a', 'a.txt', 'new.txt'])
    // The unticked Session file stays dirty and the other chat's staged change stays staged.
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })
    expect(status.split('\n').filter(Boolean).sort()).toEqual([' M b.txt', 'M  other.txt'])
    expect(replies.find((message) => message.type === 'session_git_result')).toMatchObject({ action: 'commit', ok: true })
    // The branch moved, so blocked Session cards read Git again.
    expect(committed).toBe(1)
  })

  it('lands both sides of a ticked rename, listed as one file', async () => {
    const { root } = fixture()
    renameSync(path.join(root, 'a.txt'), path.join(root, 'renamed.txt'))
    const { module, context, notices } = harness(root, [changed(root, 'a.txt', 'renamed.txt')])

    const before = await module.status('chat_1')
    expect(before.repos[0]?.uncommitted).toMatchObject([{ path: 'renamed.txt', oldPath: 'a.txt' }])
    await module.handle({ type: 'commit_session', chatId: 'chat_1', root, files: ['renamed.txt'], message: 'Rename a' }, context)
    expect(notices()).toEqual([])
    expect(git(root, 'ls-tree', '--name-only', 'HEAD').split('\n')).toEqual(['b.txt', 'other.txt', 'renamed.txt'])
    expect(git(root, 'status', '--porcelain')).toBe('')
  })

  it('refuses a path that is not one of this Session’s uncommitted files', async () => {
    const { root } = fixture()
    writeFileSync(path.join(root, 'a.txt'), 'a.txt after\n')
    writeFileSync(path.join(root, 'other.txt'), 'another chat\n')
    const head = git(root, 'rev-parse', 'HEAD')
    const { module, context, notices } = harness(root, [changed(root, 'a.txt')])
    await module.handle({ type: 'commit_session', chatId: 'chat_1', root, files: ['a.txt', 'other.txt'], message: 'Sneak' }, context)
    expect(notices()[0]).toMatch(/other\.txt is not one of them/)
    expect(git(root, 'rev-parse', 'HEAD')).toBe(head)
  })

  it('is refused, and offers nothing to commit, while a result waits for Confirm', async () => {
    const { root } = fixture()
    writeFileSync(path.join(root, 'a.txt'), 'a.txt after\n')
    const completion = { ...await prepareWorkCompletion([root], [path.join(root, 'a.txt')], []), status: 'ready' as const }
    const head = git(root, 'rev-parse', 'HEAD')
    const { module, context, notices } = harness(root, [changed(root, 'a.txt')], completion)

    const status = await module.status('chat_1')
    expect(status.waiting).toBe(true)
    expect(status.repos[0]?.uncommitted).toEqual([])
    await module.handle({ type: 'commit_session', chatId: 'chat_1', root, files: ['a.txt'], message: '' }, context)
    expect(notices()[0]).toMatch(/waiting for Confirm/)
    expect(git(root, 'rev-parse', 'HEAD')).toBe(head)
  })
})

describe('Session Push', () => {
  it('pushes the current branch and says how many commits went where', async () => {
    const { root, remote } = fixture()
    for (const round of [1, 2]) {
      writeFileSync(path.join(root, 'a.txt'), `round ${round}\n`)
      git(root, 'commit', '-am', `Round ${round}`)
    }
    const { module, context, replies, acks } = harness(root, [])
    expect((await module.status('chat_1')).repos[0]).toMatchObject({ branch: 'main', pushTarget: 'origin/main', ahead: 2 })
    await module.handle({ type: 'push_session', chatId: 'chat_1', root }, context)
    expect(replies.find((message) => message.type === 'session_git_result')).toMatchObject({ ok: true, text: 'Pushed 2 commits to origin/main.' })
    expect(acks()).toBe(1)
    expect(git(remote, 'rev-parse', 'main')).toBe(git(root, 'rev-parse', 'HEAD'))
    expect((await module.status('chat_1')).repos[0]?.ahead).toBe(0)
  })

  it('is refused when nothing is ahead of the remote', async () => {
    const { root } = fixture()
    const { module, context, notices } = harness(root, [])
    expect((await module.status('chat_1')).repos[0]?.ahead).toBe(0)
    await module.handle({ type: 'push_session', chatId: 'chat_1', root }, context)
    expect(notices()[0]).toMatch(/^Nothing to push/)
  })

  it('never forces: a remote that moved on refuses and keeps its own history', async () => {
    const { root, remote } = fixture()
    // Someone else pushed first.
    const other = temp('manor-session-other-')
    git(other, 'clone', remote, '.')
    git(other, 'config', 'user.name', 'Other')
    git(other, 'config', 'user.email', 'other@example.test')
    writeFileSync(path.join(other, 'b.txt'), 'theirs\n')
    git(other, 'commit', '-am', 'Theirs')
    git(other, 'push', 'origin', 'main')
    const theirs = git(remote, 'rev-parse', 'main')
    writeFileSync(path.join(root, 'a.txt'), 'ours\n')
    git(root, 'commit', '-am', 'Ours')

    const { module, context, notices } = harness(root, [])
    await module.handle({ type: 'push_session', chatId: 'chat_1', root }, context)
    expect(notices()[0]).toMatch(/^origin rejected the push \((fetch first|non-fast-forward)\)\.$/)
    expect(git(remote, 'rev-parse', 'main')).toBe(theirs)
  })
})

/** A hook that prints what `pnpm -r test` and `pnpm -r typecheck` print when they fail. */
function refusingHook(root: string, output: string, hook = 'pre-push') {
  const hooks = temp('manor-session-hooks-')
  writeFileSync(path.join(hooks, hook), `#!/bin/sh\ncat >&2 <<'OUT'\n${output}\nOUT\nexit 1\n`, { mode: 0o755 })
  git(root, 'config', 'core.hooksPath', hooks)
}

describe('Session Commit behind a pre-commit check', () => {
  it('names the failing tests and lands nothing, a new file included', async () => {
    const { root } = fixture()
    const head = git(root, 'rev-parse', 'HEAD')
    writeFileSync(path.join(root, 'a.txt'), 'a.txt after\n')
    writeFileSync(path.join(root, 'new.txt'), 'new\n')
    refusingHook(root, 'apps/web test:  FAIL  test/turnFolding.test.tsx > a run of work', 'pre-commit')

    const { module, context, notices, replies, acks } = harness(root, [changed(root, 'a.txt', 'new.txt')])
    await module.handle({ type: 'commit_session', chatId: 'chat_1', root, files: ['a.txt', 'new.txt'], message: 'Ship a', requestId: 'req_1' }, context)
    // The dialog closed on the ack; the failure arrives after it, with what reopens the dialog.
    expect(acks()).toBe(1)
    expect(notices()).toEqual([])
    expect(replies.find((message) => message.type === 'session_git_result')).toEqual({
      type: 'session_git_result', chatId: 'chat_1', root, action: 'commit', ok: false, requestId: 'req_1',
      text: 'The pre-commit check stopped the commit. Failing: apps/web test/turnFolding.test.tsx.',
      files: ['a.txt', 'new.txt'], message: 'Ship a',
    })
    expect(module.commits().commits).toEqual([])
    expect(git(root, 'rev-parse', 'HEAD')).toBe(head)
    expect(git(root, 'status', '--porcelain')).toBe('M a.txt\n?? new.txt')
  })

  it('still ends the commit for every window when the status read after it fails', async () => {
    const { root } = fixture()
    writeFileSync(path.join(root, 'a.txt'), 'a.txt after\n')
    let broken: { broken: boolean } | undefined
    const { module, context, replies, store } = harness(root, [changed(root, 'a.txt')], undefined, [], () => { broken!.broken = true })
    broken = store
    await module.handle({ type: 'commit_session', chatId: 'chat_1', root, files: ['a.txt'], message: 'Ship a' }, context)
    expect(git(root, 'log', '--format=%s', '-1')).toBe('Ship a')
    expect(replies.find((message) => message.type === 'session_git_result')).toMatchObject({ ok: true })
    expect(replies.filter((message) => message.type === 'session_commits').at(-1)).toEqual({ type: 'session_commits', commits: [] })
  })

  it('acks before the hook runs, says it is running, and refuses a second commit meanwhile', async () => {
    const { root } = fixture()
    const head = git(root, 'rev-parse', 'HEAD')
    writeFileSync(path.join(root, 'a.txt'), 'a.txt after\n')
    writeFileSync(path.join(root, 'b.txt'), 'b.txt after\n')
    const during: { head?: string; running?: unknown; second?: Promise<void> } = {}
    const { module, context, notices, replies } = harness(root, [changed(root, 'a.txt', 'b.txt')], undefined, [], () => {
      during.head = git(root, 'rev-parse', 'HEAD')
      during.running = module.commits().commits
      during.second = module.handle({ type: 'commit_session', chatId: 'chat_1', root, files: ['b.txt'], message: 'Again' }, context)
    })
    await module.handle({ type: 'commit_session', chatId: 'chat_1', root, files: ['a.txt'], message: 'Ship a' }, context)
    await during.second

    expect(during.head).toBe(head)
    expect(during.running).toEqual([{ chatId: 'chat_1', root, files: 1 }])
    expect(notices()).toEqual(['A commit is already running in this checkout. Commit again once it ends.'])
    expect(git(root, 'log', '--format=%s', '-1')).toBe('Ship a')
    const commits = replies.flatMap((message) => message.type === 'session_commits' ? [message.commits.length] : [])
    expect(commits).toEqual([1, 0])
    expect(replies.find((message) => message.type === 'session_git_result')).toMatchObject({ ok: true, text: expect.stringMatching(/^Committed 1 file as \w{7}: Ship a$/) })
  })
})

describe('Session Push behind a pre-push check', () => {
  it('names the failing files instead of Git\'s last line, and pushes nothing', async () => {
    const { root, remote } = fixture()
    const before = git(remote, 'rev-parse', 'main')
    writeFileSync(path.join(root, 'a.txt'), 'ours\n')
    git(root, 'commit', '-am', 'Ours')
    refusingHook(root, [
      'apps/web typecheck: src/App.tsx(12,3): error TS2322: Type string is not assignable to type number.',
      'apps/web test:  FAIL  test/runtimeMenu.test.tsx > runtime sections > offers Fast mode',
      'apps/web test:  FAIL  test/runtimeMenu.test.tsx > runtime sections > uses logo tabs',
      'apps/server test:  FAIL  test/cursorDriver.test.ts > background work',
      'apps/server test:  FAIL  test/sessionModule.test.ts > Session Push',
      ' ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @manor/web@0.0.1 test: `vitest run`',
    ].join('\n'))

    const { module, context, notices } = harness(root, [])
    await module.handle({ type: 'push_session', chatId: 'chat_1', root }, context)
    expect(notices()[0]).toBe(
      'The pre-push check stopped the push. Failing: apps/web src/App.tsx, apps/web test/runtimeMenu.test.tsx, apps/server test/cursorDriver.test.ts, and 1 more.',
    )
    expect(git(remote, 'rev-parse', 'main')).toBe(before)
  })

  it('falls back to the hook\'s own last line when it names no failing file', async () => {
    const { root } = fixture()
    writeFileSync(path.join(root, 'a.txt'), 'ours\n')
    git(root, 'commit', '-am', 'Ours')
    refusingHook(root, 'lint found 2 problems')

    const { module, context, notices } = harness(root, [])
    await module.handle({ type: 'push_session', chatId: 'chat_1', root }, context)
    expect(notices()[0]).toBe('Push failed: lint found 2 problems')
  })
})

describe('The repository and Open in', () => {
  it('names the repository without ever carrying credentials, and links only a real host', () => {
    expect(repoRemote('git@github.com:sam/Manor.git')).toEqual({ name: 'sam/Manor', url: 'https://github.com/sam/Manor' })
    expect(repoRemote('https://x-access-token:secret@github.com/sam/Manor.git')).toEqual({ name: 'sam/Manor', url: 'https://github.com/sam/Manor' })
    expect(repoRemote('ssh://git@gitlab.example.com/team/app.git')).toEqual({ name: 'team/app', url: 'https://gitlab.example.com/team/app' })
    expect(repoRemote('/tmp/fixture/remote.git')).toEqual({ name: 'remote' })
    expect(repoRemote('github-work:team/app.git')).toEqual({ name: 'app' })
    expect(repoRemote('https://x-access-token:secret@github.com/team/%bad.git')).toBeUndefined()
    expect(repoRemote('https://user:secret@host with space/team/app.git')).toBeUndefined()
  })

  it('opens only this Session’s own folder, in an app the host has', async () => {
    const { root } = fixture()
    const opened: string[][] = []
    const { module, context, notices } = harness(root, [], undefined, opened)
    await module.handle({ type: 'open_session_folder', chatId: 'chat_1', root, app: 'cursor' }, context)
    await module.handle({ type: 'open_session_folder', chatId: 'chat_1', root: '/etc', app: 'cursor' }, context)
    await module.handle({ type: 'open_session_folder', chatId: 'chat_1', root, app: 'xcode' }, context)
    expect(opened).toEqual([['cursor', root, 'folder']])
    expect(notices()).toEqual(['That folder is not part of this Session’s checkout.', 'That application is not available on this Manor host.'])
  })
})

describe('Whole-Session diff', () => {
  it('is exactly what Confirm lands while a result waits, even after the folder moves on', async () => {
    const { root } = fixture()
    writeFileSync(path.join(root, 'a.txt'), 'published\n')
    writeFileSync(path.join(root, 'other.txt'), 'another chat\n')
    const completion = { ...await prepareWorkCompletion([root], [path.join(root, 'a.txt')], []), status: 'ready' as const }
    writeFileSync(path.join(root, 'a.txt'), 'written after the result\n')

    const diff = await readSessionDiff({ repoPaths: [root], mapping: [], sessionFiles: [], waiting: completion }, false)
    expect(diff.files.map((file) => file.path)).toEqual(completion.repos[0]?.files)
    expect(diff.files[0]?.hunks.flatMap((hunk) => hunk.lines)).toEqual(['-a.txt before', '+published'])
  })

  it('lists the Session’s files a waiting result leaves out under Not included, and counts them', async () => {
    const { root } = fixture()
    writeFileSync(path.join(root, 'a.txt'), 'published\n')
    const completion = { ...await prepareWorkCompletion([root], [path.join(root, 'a.txt')], []), status: 'ready' as const }
    writeFileSync(path.join(root, 'b.txt'), 'written after it was ready\n')
    writeFileSync(path.join(root, 'other.txt'), 'another chat\n')
    const checkout = {
      repoPaths: [root], mapping: [], sessionFiles: [path.join(root, 'a.txt')], waiting: completion,
      liveFiles: [path.join(root, 'a.txt'), path.join(root, 'b.txt')],
    }

    const diff = await readSessionDiff(checkout, false)
    expect(diff.files.map((file) => [file.path, file.excluded === true])).toEqual([['a.txt', false], ['b.txt', true]])
    expect(diff.files[1]?.hunks.flatMap((hunk) => hunk.lines)).toEqual(['-b.txt before', '+written after it was ready'])
    const status = await readSessionStatus(checkout)
    expect(status).toMatchObject({ changes: { files: 1 }, excluded: 1 })
    expect((await readSessionStatus({ ...checkout, liveFiles: [path.join(root, 'a.txt')] })).excluded).toBeUndefined()
  })

  it('takes all of a worktree since its branch left home, commits and edits outside a turn too', async () => {
    const { root } = fixture()
    const worktree = path.join(temp('manor-session-tree-'), 'tree')
    git(root, 'worktree', 'add', '-b', 'manor/session', worktree)
    writeFileSync(path.join(worktree, 'a.txt'), 'committed outside a turn\n')
    git(worktree, 'commit', '-am', 'Earlier work')
    writeFileSync(path.join(worktree, 'manual.txt'), 'made by hand\n')
    const checkout = { repoPaths: [worktree], mapping: [{ sourcePath: root, worktreePath: worktree, branch: 'manor/session', createdAt: 1 }], sessionFiles: [] }

    const diff = await readSessionDiff(checkout, false)
    expect(diff.files.map((file) => file.path).sort()).toEqual(['a.txt', 'manual.txt'])
    const status = await readSessionStatus(checkout)
    expect(status.repos[0]?.uncommitted.map((file) => file.path)).toEqual(['manual.txt'])
  })

  it('keeps of the recorded files only what still differs, yet a committed change undone since', async () => {
    const { root } = fixture()
    const worktree = path.join(temp('manor-session-tree-'), 'tree')
    git(root, 'worktree', 'add', '-b', 'manor/session', worktree)
    writeFileSync(path.join(worktree, 'b.txt'), 'committed by the Session\n')
    git(worktree, 'commit', '-am', 'Earlier work')
    writeFileSync(path.join(worktree, 'b.txt'), 'b.txt before\n')
    writeFileSync(path.join(worktree, 'a.txt'), 'ours\n')
    writeFileSync(path.join(worktree, '.gitignore'), 'out/\n')
    const recorded = ['a.txt', 'b.txt', 'gone.js', 'out/build.js', 'other.txt'].map((name) => path.join(worktree, name))
    const outside = path.join(temp('manor-session-loose-'), 'notes.md')
    const mapping = [{ sourcePath: root, worktreePath: worktree, branch: 'manor/session', createdAt: 1 }]

    expect(await liveSessionFiles({ repoPaths: [worktree], mapping }, [...recorded, outside, 'relative.log']))
      .toEqual([path.join(worktree, 'a.txt'), path.join(worktree, 'b.txt'), outside])
  })

  it('measures a linked subfolder from its repository, and never snapshots a repository holding none of the files', async () => {
    const { root } = fixture()
    mkdirSync(path.join(root, 'sub'))
    expect(await liveSessionFiles({ repoPaths: [path.join(root, 'sub')], mapping: [] }, [path.join(root, 'sub', 'gone.js')])).toEqual([])
    // What Confirm selected stays, however the live read differs.
    const confirmed = [{ path: root, branch: 'main', before: '', tree: '', files: ['sub/gone.js'] }]
    expect(await liveSessionFiles({ repoPaths: [root], mapping: [] }, [path.join(root, 'sub', 'gone.js')], confirmed))
      .toEqual([path.join(root, 'sub', 'gone.js')])
    // An unborn nested repository makes a snapshot of this checkout fail.
    git(path.join(root, 'sub'), 'init', '-q')
    writeFileSync(path.join(root, 'sub', 'x.txt'), 'x\n')
    const outside = path.join(temp('manor-session-loose-'), 'notes.md')
    expect(await liveSessionFiles({ repoPaths: [root], mapping: [] }, [outside])).toEqual([outside])
  })

  it('takes only this Session’s files from a shared checkout', async () => {
    const { root } = fixture()
    writeFileSync(path.join(root, 'a.txt'), 'ours\n')
    writeFileSync(path.join(root, 'other.txt'), 'another chat\n')
    const diff = await readSessionDiff({ repoPaths: [root], mapping: [], sessionFiles: [path.join(root, 'a.txt')] }, false)
    expect(diff.files.map((file) => file.path)).toEqual(['a.txt'])
    expect(diff.files[0]).toMatchObject({ root, panelPath: `${path.basename(root)}/a.txt`, added: 1, removed: 1 })
  })
})
