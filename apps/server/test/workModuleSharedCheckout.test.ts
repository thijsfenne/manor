import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { type ThreadEvent } from '@manor/contracts'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { prepareWorkCompletion } from '../src/workCompletion.js'
import { captureTurnTree, diffTurnTrees } from '../src/turnFileSnapshots.js'
import { acceptedWork, harness } from './workModuleHarness.js'

describe('WorkModule completion in the shared checkout', () => {
  const roots: string[] = []
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {
    cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' }, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
  // The check runs real git in a temp repo; under a full parallel suite that outlasts waitFor's 1s default.
  const statusOf = (h: Awaited<ReturnType<typeof harness>>, chatId: string, want: string) => vi.waitFor(async () =>
    expect((await h.store.workHandoffForTarget(chatId))?.goalCompletion?.status).toBe(want), { timeout: 15_000 })
  const lines = (marks: Partial<Record<number, string>>) => Array.from({ length: 12 }, (_, at) => marks[at] ?? `line ${at}`).join('\n') + '\n'

  /** A published result in the plain linked checkout; `files` are what its turns measured. */
  async function published(seed: Record<string, string>, edits: Record<string, string>, legacy = false, preexisting: Record<string, string> = {}) {
    const h = await harness()
    const root = mkdtempSync(path.join(os.tmpdir(), 'manor-shared-checkout-'))
    roots.push(root)
    git(root, 'init', '-q', '-b', 'main')
    git(root, 'config', 'user.name', 'Test')
    git(root, 'config', 'user.email', 'test@example.test')
    for (const [file, text] of Object.entries(seed)) writeFileSync(path.join(root, file), text)
    git(root, 'add', '.')
    git(root, 'commit', '-qm', 'Initial')
    for (const [file, text] of Object.entries(preexisting)) writeFileSync(path.join(root, file), text)
    const before = await captureTurnTree(root)
    for (const [file, text] of Object.entries(edits)) writeFileSync(path.join(root, file), text)
    await h.store.updateProject(h.projectId, 'Manor', [root])
    const { workChatId } = await acceptedWork(h)
    // Prose only, so the Multiple review gate stays out of the way.
    const files = Object.keys(edits).map((file) => path.join(root, file))
    await h.store.appendEvent(workChatId, { type: 'turn_result', agentId: 'sage', turnId: 'edit',
      fileChanges: await diffTurnTrees(root, before, await captureTurnTree(root)),
    })
    const handoff = (await h.store.workHandoffForTarget(workChatId))!
    const completion = { ...await prepareWorkCompletion([root], files, []), status: 'ready' as const, completedAt: undefined }
    await h.store.reachWorkGoal(handoff.id, { type: 'system_note', kind: 'info', text: 'Ready.', workGoalHandoffId: handoff.id,
      ...(legacy ? {} : { goalReport: { result: 'Done.' }, goalCompletion: completion }) })
    // The commit turn: whatever `commitTurn` does, then the request reads as dispatched.
    let commitTurn = () => undefined as void
    h.orchestrator.runStoredUserMessage.mockImplementation(async (chatId: string, event: ThreadEvent) => {
      commitTurn()
      if (event.type === 'user_message') await h.store.replaceEvent(chatId, { ...event, dispatchState: 'completed' })
      return undefined
    })
    return { h, root, workChatId, handoffId: handoff.id, onCommit: (run: () => void) => { commitTurn = run } }
  }

  it('completes a confirmed result when its own hunk lands and another Session’s hunk stays dirty', async () => {
    const s = await published({ 'shared.md': lines({}) }, { 'shared.md': lines({ 0: 'mine', 11: 'theirs' }) },
      false, { 'shared.md': lines({ 11: 'theirs' }) })
    s.onCommit(() => {
      writeFileSync(path.join(s.root, 'shared.md'), lines({ 0: 'mine' }))
      git(s.root, 'commit', '-qam', 'This Session, its own hunk only')
      writeFileSync(path.join(s.root, 'shared.md'), lines({ 0: 'mine', 11: 'theirs' }))
    })
    const ready = (await s.h.store.workHandoffForTarget(s.workChatId))!
    await s.h.module.confirmGoal(s.handoffId, undefined, ready.version)
    await statusOf(s.h, s.workChatId, 'complete')
    expect(git(s.root, 'diff', '--name-only')).toBe('shared.md')
    const requestId = (await s.h.store.workHandoffForTarget(s.workChatId))?.goalCompletion?.requestEventId
    expect((await s.h.store.loadEvents(s.workChatId)).find((event) => event.id === requestId))
      .toMatchObject({ type: 'user_message', confirmRequest: { variant: 'checkout', worktrees: [] } })
  })

  it('ticks the commit from Git while the commit turn still runs, so Confirm’s card moves step by step', async () => {
    const s = await published({ 'own.md': 'before\n' }, { 'own.md': 'after\n' })
    let finish = () => undefined as void
    const turnOpen = new Promise<void>((resolve) => { finish = resolve })
    s.h.orchestrator.runStoredUserMessage.mockImplementation(async (chatId: string, event: ThreadEvent) => {
      git(s.root, 'commit', '-qam', 'Accepted result')
      await turnOpen
      if (event.type === 'user_message') await s.h.store.replaceEvent(chatId, { ...event, dispatchState: 'completed' })
      return undefined
    })
    const ready = (await s.h.store.workHandoffForTarget(s.workChatId))!
    await s.h.module.confirmGoal(s.handoffId, undefined, ready.version)
    await vi.waitFor(async () => expect((await s.h.store.workHandoffForTarget(s.workChatId))?.goalCompletion)
      .toMatchObject({ status: 'pending', committed: [expect.any(String)] }), { timeout: 8_000 })
    finish()
    await statusOf(s.h, s.workChatId, 'complete')
  }, 15_000)

  it('stores a legacy result commit request atomically so Confirm does not reopen itself', async () => {
    const s = await published({ 'own.md': 'before\n' }, { 'own.md': 'after\n' }, true)
    s.onCommit(() => { git(s.root, 'commit', '-qam', 'Legacy result') })
    const ready = (await s.h.store.workHandoffForTarget(s.workChatId))!
    expect(ready.goalReport).toBeUndefined()
    await s.h.module.confirmGoal(s.handoffId)
    await statusOf(s.h, s.workChatId, 'complete')
    const confirmed = (await s.h.store.workHandoffForTarget(s.workChatId))!
    expect(confirmed.goalConfirmedAt).toEqual(expect.any(Number))
    expect(confirmed.goalReachedAt).toBe(ready.goalReachedAt)
    expect(confirmed.goalConfirmations).toBeUndefined()
    expect(s.h.orchestrator.runStoredUserMessage).toHaveBeenCalledWith(s.workChatId,
      expect.objectContaining({ id: confirmed.goalCompletion?.requestEventId, type: 'user_message' }))
  })

  it('automatically rechecks an archived blocked commit without confirming the new work', async () => {
    const s = await published({ 'own.md': 'before\n' }, { 'own.md': 'after\n' })
    const ready = (await s.h.store.workHandoffForTarget(s.workChatId))!
    await s.h.module.confirmGoal(s.handoffId, undefined, ready.version)
    await statusOf(s.h, s.workChatId, 'blocked')
    await s.h.store.appendEvent(s.workChatId, { type: 'user_message', text: 'New task.', mentions: [] })
    git(s.root, 'commit', '-qam', 'Previous accepted result')
    await s.h.module.recheckBlocked()
    const current = (await s.h.store.workHandoffForTarget(s.workChatId))!
    expect(current.goalConfirmations?.[0]?.completion?.status).toBe('complete')
    expect(current.goalConfirmedAt).toBeUndefined()
    expect(current.goalReachedAt).toBeUndefined()
  })

  it('confirms a result after another Session committed files it also measured, and commits only its own', async () => {
    const s = await published({ 'own.md': 'a\n', 'other.md': 'a\n' }, { 'own.md': 'mine\n', 'other.md': 'theirs\n' })
    expect((await s.h.store.workHandoffForTarget(s.workChatId))?.goalCompletion?.repos[0]?.files.sort()).toEqual(['other.md', 'own.md'])
    // The other Session's commit lands between publication and Confirm (a slow pre-commit hook on 10-11).
    git(s.root, 'add', 'other.md')
    git(s.root, 'commit', '-qm', 'Another Session')
    s.onCommit(() => { git(s.root, 'add', 'own.md'); git(s.root, 'commit', '-qm', 'This Session') })

    const ready = (await s.h.store.workHandoffForTarget(s.workChatId))!
    await s.h.module.confirmGoal(s.handoffId, undefined, ready.version)

    const confirmed = (await s.h.store.workHandoffForTarget(s.workChatId))!
    expect(confirmed.goalConfirmedAt).toEqual(expect.any(Number))
    expect(confirmed.goalCompletion?.repos[0]?.files).toEqual(['own.md'])
    await statusOf(s.h, s.workChatId, 'complete')
  })

  it('moves a blocked commit to complete once main carries the published contents, also when the commit came from outside Manor', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    onTestFinished(() => { vi.useRealTimers() })
    // Both Sessions edited one shared file: this one line 0, the other line 11.
    const s = await published({ 'shared.md': lines({}) }, { 'shared.md': lines({ 0: 'mine', 11: 'theirs' }) })
    s.onCommit(() => {
      writeFileSync(path.join(s.root, 'shared.md'), lines({ 0: 'mine' }))
      git(s.root, 'commit', '-qam', 'This Session, its own hunk only')
      writeFileSync(path.join(s.root, 'shared.md'), lines({ 0: 'mine', 11: 'theirs' }))
    })
    const ready = (await s.h.store.workHandoffForTarget(s.workChatId))!
    await s.h.module.confirmGoal(s.handoffId, undefined, ready.version)
    await statusOf(s.h, s.workChatId, 'blocked')
    expect((await s.h.store.workHandoffForTarget(s.workChatId))?.goalCompletion?.message).toBe('shared.md is not committed on main.')

    await s.h.module.recheckBlocked()
    expect((await s.h.store.workHandoffForTarget(s.workChatId))?.goalCompletion?.status).toBe('blocked')

    // The other Session's hunk lands from a terminal: no exchange ends and no chat opens.
    git(s.root, 'commit', '-qam', 'Another Session')
    const directories = s.h.directories()
    await vi.advanceTimersByTimeAsync(30_000)
    await statusOf(s.h, s.workChatId, 'complete')
    expect(s.h.directories()).toBeGreaterThan(directories)
  })

  it('names the lead\'s stop on a blocked card, and Retry with unchanged files lands under the same approval and settles', async () => {
    const s = await published({ 'own.md': 'before\n' }, { 'own.md': 'after\n' })
    s.onCommit(() => undefined)
    s.h.orchestrator.runStoredUserMessage.mockImplementationOnce(async (chatId: string, event: ThreadEvent) => {
      await s.h.store.appendEvent(chatId, { type: 'agent_message', agentId: 'sage', turnId: 'commit',
        text: 'I tried.\n\n**Real failure:** the pre-commit hook failed in apps/web tests. Then more detail here.' })
      if (event.type === 'user_message') await s.h.store.replaceEvent(chatId, { ...event, dispatchState: 'completed' })
      return undefined
    })
    const ready = (await s.h.store.workHandoffForTarget(s.workChatId))!
    await s.h.module.confirmGoal(s.handoffId, undefined, ready.version)
    await statusOf(s.h, s.workChatId, 'blocked')
    const blocked = (await s.h.store.workHandoffForTarget(s.workChatId))!
    expect(blocked.goalCompletion).toMatchObject({ message: 'The pre-commit hook failed in apps/web tests.' })
    expect(blocked.goalCompletion?.retryRefused).toBeUndefined()

    s.onCommit(() => { git(s.root, 'commit', '-qam', 'Retried') })
    await s.h.module.retryCompletion(s.handoffId)
    await statusOf(s.h, s.workChatId, 'complete')
    const done = (await s.h.store.workHandoffForTarget(s.workChatId))!
    // The same approval landed: nothing reopened, no new result, no second Confirm.
    expect(done).toMatchObject({ goalConfirmedAt: blocked.goalConfirmedAt, goalReachedAt: blocked.goalReachedAt, goalReport: blocked.goalReport })
    expect(done.goalConfirmations).toBeUndefined()
    expect((await s.h.store.loadEvents(s.h.source.id)).some((event) => event.type === 'system_note' && event.workHandoffPhase === 'reopened')).toBe(false)
    expect(done.goalCompletion?.requestEventId).toBe(blocked.goalCompletion?.requestEventId)
    expect(done.goalCompletion?.retries).toHaveLength(1)
    const retry = (await s.h.store.loadEvents(s.workChatId)).find((event) => event.id === done.goalCompletion?.retries?.[0])
    expect(retry).toMatchObject({ type: 'user_message', confirmRequest: { variant: 'checkout' } })
    expect(retry?.type === 'user_message' ? retry.instruction : '').toContain('- ' + path.basename(s.root) + '/own.md')
    // Landed, so the Session settles; a shared checkout has no branch of its own to touch.
    await vi.waitFor(async () => expect((await s.h.store.workHandoffForTarget(s.workChatId))?.state).toBe('settled'))
    expect((await s.h.store.getChat(s.workChatId))?.settledAt).toEqual(expect.any(Number))
    expect(git(s.root, 'branch', '--format=%(refname:short)')).toBe('main')
  })

  it('refuses Retry once an approved file changed after Confirm, and says why on the card', async () => {
    const s = await published({ 'own.md': 'before\n' }, { 'own.md': 'after\n' })
    const ready = (await s.h.store.workHandoffForTarget(s.workChatId))!
    await s.h.module.confirmGoal(s.handoffId, undefined, ready.version)
    await statusOf(s.h, s.workChatId, 'blocked')
    writeFileSync(path.join(s.root, 'own.md'), 'edited by hand\n')
    await s.h.module.recheckBlocked()
    const refused = 'own.md changed since Confirm. Request a new result in the Session.'
    expect((await s.h.store.workHandoffForTarget(s.workChatId))?.goalCompletion?.retryRefused).toBe(refused)
    const calls = s.h.orchestrator.runStoredUserMessage.mock.calls.length
    // The card says why; the click answers quietly and runs nothing.
    await s.h.module.retryCompletion(s.handoffId)
    expect(s.h.orchestrator.runStoredUserMessage.mock.calls).toHaveLength(calls)
    const after = (await s.h.store.workHandoffForTarget(s.workChatId))!
    expect(after.goalCompletion).toMatchObject({ status: 'blocked', retryRefused: refused })
    expect(after.goalCompletion?.retries).toBeUndefined()
  })

  it('keeps a landed Session open when a message arrived after its attempt', async () => {
    const s = await published({ 'own.md': 'before\n' }, { 'own.md': 'after\n' })
    s.h.orchestrator.runStoredUserMessage.mockImplementationOnce(async (chatId: string, event: ThreadEvent) => {
      git(s.root, 'commit', '-qam', 'This Session')
      if (event.type === 'user_message') await s.h.store.replaceEvent(chatId, { ...event, dispatchState: 'completed' })
      await s.h.store.appendEvent(chatId, { type: 'user_message', text: 'One more thing.', mentions: [] })
      return undefined
    })
    const ready = (await s.h.store.workHandoffForTarget(s.workChatId))!
    await s.h.module.confirmGoal(s.handoffId, undefined, ready.version)
    // The message opened a new round; the landed one is kept as history.
    await vi.waitFor(async () => expect((await s.h.store.workHandoffForTarget(s.workChatId))?.goalConfirmations?.[0]?.completion?.status).toBe('complete'))
    await s.h.module.reconcileCompletion(s.workChatId)
    expect((await s.h.store.workHandoffForTarget(s.workChatId))?.state).toBe('active')
    expect((await s.h.store.getChat(s.workChatId))?.settledAt).toBeNull()
  })

  it('settles a change that landed before a restart cut its settle short', async () => {
    const s = await published({ 'own.md': 'before\n' }, { 'own.md': 'after\n' })
    const ready = (await s.h.store.workHandoffForTarget(s.workChatId))!
    await s.h.module.confirmGoal(s.handoffId, undefined, ready.version)
    await statusOf(s.h, s.workChatId, 'blocked')
    git(s.root, 'commit', '-qam', 'This Session')
    const held = (await s.h.store.workHandoffForTarget(s.workChatId))!.goalCompletion!
    // Stored complete, then the server stopped before it settled.
    await s.h.store.updateWorkCompletion(s.handoffId, { ...held, status: 'complete', completedAt: Date.now(), message: undefined })
    await s.h.module.reconcileCompletion()
    expect((await s.h.store.workHandoffForTarget(s.workChatId))?.state).toBe('settled')
  })

  it('settles on a landed attempt only while it is still the live confirmed one', async () => {
    const s = await published({ 'own.md': 'before\n' }, { 'own.md': 'after\n' })
    const ready = (await s.h.store.workHandoffForTarget(s.workChatId))!
    await s.h.module.confirmGoal(s.handoffId, undefined, ready.version)
    await statusOf(s.h, s.workChatId, 'blocked')
    const held = (await s.h.store.workHandoffForTarget(s.workChatId))!
    const landed = { goalConfirmedAt: held.goalConfirmedAt!, attempt: held.goalCompletion!.requestEventId! }
    await s.h.store.updateWorkCompletion(s.handoffId, { ...held.goalCompletion!, status: 'complete' })
    // A message lands between the module's check and the store's write.
    await s.h.store.appendEvent(s.workChatId, { type: 'user_message', text: 'New work.', mentions: [] })
    const saved = await s.h.store.transitionWorkLifecycle(s.workChatId, s.handoffId, { state: 'settled', result: null, resultAt: Date.now() },
      { type: 'system_note', kind: 'info', text: 'Settled.', workHandoffId: s.handoffId, workHandoffPhase: 'settled' }, landed)
    expect(saved.state).toBe('active')
    expect((await s.h.store.getChat(s.workChatId))?.settledAt).toBeNull()
  })

  it('refuses Retry once the shared checkout switched branches', async () => {
    const s = await published({ 'own.md': 'before\n' }, { 'own.md': 'after\n' })
    const ready = (await s.h.store.workHandoffForTarget(s.workChatId))!
    await s.h.module.confirmGoal(s.handoffId, undefined, ready.version)
    await statusOf(s.h, s.workChatId, 'blocked')
    git(s.root, 'switch', '-qc', 'other-work')
    const calls = s.h.orchestrator.runStoredUserMessage.mock.calls.length
    await s.h.module.retryCompletion(s.handoffId)
    expect(s.h.orchestrator.runStoredUserMessage.mock.calls).toHaveLength(calls)
    expect((await s.h.store.workHandoffForTarget(s.workChatId))?.goalCompletion?.retryRefused)
      .toBe(`Retry waits until ${path.basename(s.root)} is back on main.`)
  })

  it('names the turn\'s own error when the lead never reported a stop', async () => {
    const s = await published({ 'own.md': 'before\n' }, { 'own.md': 'after\n' })
    s.h.orchestrator.runStoredUserMessage.mockImplementationOnce(async (chatId: string, event: ThreadEvent) => {
      await s.h.store.appendEvent(chatId, { type: 'system_note', kind: 'error', agentId: 'sage', turnId: 'commit', text: 'Provider usage limit reached.' })
      if (event.type === 'user_message') await s.h.store.replaceEvent(chatId, { ...event, dispatchState: 'completed' })
      return undefined
    })
    const ready = (await s.h.store.workHandoffForTarget(s.workChatId))!
    await s.h.module.confirmGoal(s.handoffId, undefined, ready.version)
    await statusOf(s.h, s.workChatId, 'blocked')
    expect((await s.h.store.workHandoffForTarget(s.workChatId))?.goalCompletion?.message).toBe('Provider usage limit reached.')
  })

  it('rechecks a settled Session\'s blocked card and confirms it once its commit is on main', async () => {
    const s = await published({ 'own.md': 'a\n' }, { 'own.md': 'mine\n' })
    const ready = (await s.h.store.workHandoffForTarget(s.workChatId))!
    await s.h.module.confirmGoal(s.handoffId, undefined, ready.version)
    await statusOf(s.h, s.workChatId, 'blocked')
    await s.h.module.setSettled(s.workChatId, true)
    expect((await s.h.store.workHandoffForTarget(s.workChatId))).toMatchObject({ state: 'settled', goalCompletion: { status: 'blocked' } })

    git(s.root, 'commit', '-qam', 'This Session, after it settled')
    await s.h.module.recheckBlocked()
    expect((await s.h.store.workHandoffForTarget(s.workChatId))?.goalCompletion?.status).toBe('complete')
  })
})
