import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, realpathSync, existsSync, chmodSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Driver, RuntimeEvent, ServerMessage, TurnInput, WorkHandoff } from '@manor/contracts'
import { AsyncQueue } from '../src/asyncQueue.js'
import { createMockDriver } from '../src/drivers/mockDriver.js'
import type { ExternalFileOpener } from '../src/externalFiles.js'
import { ClientMessageSchema, ServerMessageSchema } from '@manor/contracts'

import { ManorService } from '../src/service.js'
import { createMemoryStore } from '../src/stores/memoryStore.js'
import type { Store } from '../src/store.js'
import { worktreeDir } from '../src/worktree.js'
import { recording, roster, scratchFor, sessionIdIn, until } from './helpers.js'

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

function repo(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'manor-svc-wt-'))
  git(root, 'init', '--quiet', '-b', 'main')
  writeFileSync(path.join(root, 'README.md'), 'shared\n')
  writeFileSync(path.join(root, '.gitignore'), '.env\n')
  writeFileSync(path.join(root, '.env'), 'SECRET=nothing-real\n')
  mkdirSync(path.join(root, 'src'))
  writeFileSync(path.join(root, 'src', 'main.ts'), 'export {}\n')
  git(root, 'add', '.')
  git(root, 'commit', '--quiet', '-m', 'init')
  return root
}

/** A commit on the worktree's branch that main lacks, so a settle keeps the folder. */
function commitIn(dir: string, file = 'work.ts'): void {
  writeFileSync(path.join(dir, file), 'export const work = 1\n')
  git(dir, 'add', file)
  git(dir, 'commit', '--quiet', '-m', 'work')
}

function harness(worktreesRoot: string, seen: TurnInput[] = [], externalFiles?: ExternalFileOpener) {
  const store = createMemoryStore({ agents: roster })
  const broadcast: ServerMessage[] = []
  const replies: ServerMessage[] = []
  const manor = new ManorService({
    store,
    agents: () => roster,
    setAgents: () => undefined,
    mcpServers: () => [],
    setMcpServers: () => undefined,
    resolveDriver: () => recording(createMockDriver({ deltaDelayMs: 0 }), seen),
    ensureScratchDir: scratchFor,
    broadcast: (message) => broadcast.push(message),
    worktreesRoot,
    ...(externalFiles === undefined ? {} : { externalFiles }),
  })
  const reply = (message: ServerMessage) => replies.push(message)
  return { store, manor, broadcast, replies, reply, seen }
}

async function createdIsolated(
  manor: ManorService,
  reply: (message: ServerMessage) => void,
  replies: ServerMessage[],
  projectId: string,
  title = 'Isolated',
  branch?: string,
): Promise<string> {
  const before = replies.length
  await manor.handle(
    {
      type: 'create_chat',
      projectId,
      title,
      checkout: branch === undefined ? { mode: 'worktree' } : { mode: 'worktree', branch },
    },
    reply,
  )
  const created = replies.slice(before).find((message) => message.type === 'chat_created')
  if (created?.type !== 'chat_created') throw new Error('expected chat_created')
  return created.chatId
}

describe('ManorService worktrees', () => {
  it('opens the selected file from its current checkout and refuses unavailable targets', async () => {
    const source = repo()
    const open = vi.fn<ExternalFileOpener['open']>(async () => undefined)
    const h = harness(mkdtempSync(path.join(os.tmpdir(), 'manor-open-')), [], { apps: ['cursor'], open })
    const [project] = await h.store.listProjects()
    await h.store.updateProject(project!.id, project!.name, [source])
    const chatId = await createdIsolated(h.manor, h.reply, h.replies, project!.id)
    const [mapping] = await h.store.loadChatWorktrees(chatId)
    const command = {
      type: 'open_repo_file', projectId: project!.id, app: 'cursor',
      path: `${path.basename(source)}/src/main.ts`,
    } as const
    expect(ClientMessageSchema.safeParse(command).success).toBe(true)
    expect(ClientMessageSchema.safeParse({ ...command, app: 'arbitrary-command' }).success).toBe(false)
    expect(h.manor.hostCapabilities()).toMatchObject({ repoFileApps: ['cursor'] })
    expect(ServerMessageSchema.safeParse(h.manor.hostCapabilities()).success).toBe(true)
    h.replies.length = 0
    await h.manor.handle(command, h.reply)
    await h.manor.handle({ ...command, chatId }, h.reply)
    expect(open.mock.calls).toEqual([
      ['cursor', realpathSync(path.join(source, 'src/main.ts'))],
      ['cursor', realpathSync(path.join(mapping!.worktreePath, 'src/main.ts'))],
    ])
    expect(h.replies).toEqual([])

    for (const rejected of [
      { ...command, path: `${path.basename(source)}/.env` },
      { ...command, path: `${path.basename(source)}/../outside.ts` },
      { ...command, app: 'vscode' as const },
      { ...command, projectId: 'missing' },
      { ...command, chatId: 'missing' },
    ]) {
      await h.manor.handle(rejected, h.reply)
      expect(h.replies.at(-1)).toMatchObject({ type: 'notice', kind: 'error' })
    }
    expect(open).toHaveBeenCalledTimes(2)
    open.mockRejectedValueOnce(new Error('launch failed'))
    await h.manor.handle(command, h.reply)
    expect(h.replies.at(-1)).toMatchObject({ type: 'notice', kind: 'error', text: 'The application could not open that file.' })
    await h.store.updateProject(project!.id, project!.name, [])
    await h.manor.handle(command, h.reply)
    expect(h.replies.at(-1)).toMatchObject({ type: 'notice', kind: 'error' })
    expect(open).toHaveBeenCalledTimes(3)

    const unavailable = harness(mkdtempSync(path.join(os.tmpdir(), 'manor-no-open-')))
    expect(unavailable.manor.hostCapabilities()).toMatchObject({ repoFileApps: [] })
    await unavailable.manor.handle(command, unavailable.reply)
    expect(unavailable.replies.at(-1)).toMatchObject({ type: 'notice', kind: 'error' })
  })

  it.each(['current', 'worktree'] as const)('rolls back failed Work acceptance and retries once on %s', async (retryMode) => {
    const source = repo()
    const h = harness(mkdtempSync(path.join(os.tmpdir(), 'manor-work-gate-')))
    const [project] = await h.store.listProjects()
    await h.store.updateProject(project!.id, project!.name, [source])
    const dm = await h.store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })
    const target = await h.store.createChat({ projectId: project!.id, title: 'Pending Work' })
    const { handoff } = await h.store.reserveWorkHandoff({
      sourceChatId: dm.id, sourceTurnId: 'turn_source', projectId: project!.id,
      projectName: project!.name, title: target.title, leadAgentId: 'sage', leadAgentName: 'Sage',
      supportingAgentIds: [], supportingAgentNames: [],
    })
    await h.store.appendEvent(target.id, {
      type: 'user_message', text: 'Complete this bounded task.', mentions: [], source: 'work_handoff',
      workHandoffId: handoff.id, workSourceChatId: dm.id, workAuthorAgentId: 'sage',
      workSupportingAgentIds: [], workTargetLeadId: 'sage',
    })
    await h.store.finalizeWorkHandoff(handoff.id, target.id, {
      type: 'system_note', kind: 'info', text: 'Awaiting acceptance.', workHandoffPhase: 'created',
    })
    await h.manor.handle({ type: 'open_chat', chatId: target.id }, h.reply)
    await expect(h.manor.handle({ type: 'send_message', chatId: target.id, text: '@Sage bypass' }, h.reply))
      .rejects.toThrow('Accept this session')
    expect(h.seen).toHaveLength(0)
    await expect(h.manor.handle({
      type: 'accept_work_handoff', chatId: target.id, checkout: { mode: 'worktree', branch: 'main' },
    }, h.reply)).rejects.toThrow()
    expect((await h.store.workHandoffForTarget(target.id))?.acceptedAt).toBeNull()
    expect(await h.store.loadChatWorktrees(target.id)).toEqual([])
    expect(h.seen).toHaveLength(0)

    let failedTree: string | undefined
    const persist = vi.spyOn(h.store, 'acceptWorkHandoff').mockImplementationOnce(async () => {
      const [mapping] = await h.store.loadChatWorktrees(target.id)
      failedTree = mapping?.worktreePath
      expect(failedTree).toBeDefined()
      expect(existsSync(failedTree!)).toBe(true)
      throw new Error('accept write failed')
    })
    await expect(h.manor.handle({
      type: 'accept_work_handoff', chatId: target.id, checkout: { mode: 'worktree' }, requestId: 'failed-accept',
    }, h.reply)).rejects.toThrow('accept write failed')
    persist.mockRestore()
    expect((await h.store.workHandoffForTarget(target.id))?.acceptedAt).toBeNull()
    expect(await h.store.loadChatWorktrees(target.id)).toEqual([])
    expect((await h.store.getChat(target.id))?.checkout.mode).toBe('current')
    expect(existsSync(failedTree!)).toBe(false)
    expect(git(source, 'worktree', 'list', '--porcelain')).not.toContain(failedTree)
    expect(h.seen).toHaveLength(0)
    expect(h.replies).not.toContainEqual({ type: 'ack', requestId: 'failed-accept' })

    await h.manor.handle({
      type: 'accept_work_handoff', chatId: target.id, checkout: { mode: retryMode }, requestId: 'accept-1',
    }, h.reply)
    await h.manor.handle({ type: 'accept_work_handoff', chatId: target.id }, h.reply)
    await until(() => h.seen.length === 1, 'accepted kickoff')
    const mapping = await h.store.loadChatWorktrees(target.id)
    expect(mapping).toHaveLength(retryMode === 'worktree' ? 1 : 0)
    expect(h.seen[0]?.repoPaths).toEqual([retryMode === 'worktree' ? mapping[0]!.worktreePath : source])
    expect(h.replies).toContainEqual({ type: 'ack', requestId: 'accept-1', workChatId: target.id })
    expect((await h.store.loadEvents(target.id)).filter((event) => event.type === 'user_message')).toHaveLength(1)
  })

  it('accepts a threadless proposal by id with isolation and rejects another without creating Work', async () => {
    const source = repo()
    const h = harness(mkdtempSync(path.join(os.tmpdir(), 'manor-work-proposal-')))
    const project = (await h.store.listProjects())[0]!
    await h.store.updateProject(project.id, project.name, [source])
    const dm = await h.store.createChat({ kind: 'dm', memberIds: ['sage'] })
    const proposals: WorkHandoff[] = []
    for (const title of ['Accept me', 'Reject me']) {
      const { handoff } = await h.store.reserveWorkHandoff({
        sourceChatId: dm.id, sourceTurnId: 'source', projectId: project.id, projectName: project.name,
        assignmentKey: title, title, kickoff: title, authorAgentId: 'sage', leadAgentId: 'sage', leadAgentName: 'Sage',
        supportingAgentIds: [], supportingAgentNames: [],
      })
      proposals.push(await h.store.finalizeWorkHandoff(handoff.id, null, {
        type: 'system_note', kind: 'info', text: title, workHandoffId: handoff.id, workHandoffPhase: 'created',
      }))
    }
    expect(proposals.every((handoff) => handoff.workChatId === null)).toBe(true)
    const directory = await h.manor.directory()
    if (directory.type !== 'directory') throw new Error('missing directory')
    expect(directory.workHandoffs).toEqual(proposals)
    expect(directory.chats.some((chat) => ['Accept me', 'Reject me'].includes(chat.title))).toBe(false)
    expect(h.seen).toEqual([])
    await h.manor.handle({ type: 'reject_work_handoff', handoffId: proposals[1]!.id }, h.reply)
    await h.manor.handle({ type: 'accept_work_handoff', handoffId: proposals[0]!.id, checkout: { mode: 'worktree' }, requestId: 'proposal-accept' }, h.reply)
    const ack = h.replies.find((message) => message.type === 'ack' && message.requestId === 'proposal-accept')
    if (ack?.type !== 'ack' || ack.workChatId === undefined) throw new Error('missing accepted target')
    await h.manor.handle({ type: 'accept_work_handoff', handoffId: proposals[0]!.id, requestId: 'proposal-retry' }, h.reply)
    expect(h.replies).toContainEqual({ type: 'ack', requestId: 'proposal-retry', workChatId: ack.workChatId })
    await until(() => h.seen.length === 1, 'accepted proposal kickoff')
    expect((await h.store.loadChatWorktrees(ack.workChatId))).toHaveLength(1)
    expect((await h.store.listChats()).filter((chat) => ['Accept me', 'Reject me'].includes(chat.title))).toHaveLength(1)
    expect((await h.store.listWorkHandoffs()).find((handoff) => handoff.id === proposals[1]!.id)).toMatchObject({ state: 'settled', workChatId: null })
  })

  it('names a goal merge branch only when every linked folder shares it, and relabels a refused Confirm', async () => {
    const [first, second] = [repo(), repo()]
    git(second, 'switch', '--quiet', '-c', 'develop')
    const h = harness(mkdtempSync(path.join(os.tmpdir(), 'manor-goal-merge-')))
    const [project] = await h.store.listProjects()
    await h.store.updateProject(project!.id, project!.name, [first, second])
    const dm = await h.store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })
    const { handoff } = await h.store.reserveWorkHandoff({
      sourceChatId: dm.id, sourceTurnId: 'turn_source', projectId: project!.id,
      projectName: project!.name, assignmentKey: 'Goal', title: 'Goal', kickoff: 'Reach the goal.', authorAgentId: 'sage',
      leadAgentId: 'sage', leadAgentName: 'Sage', supportingAgentIds: [], supportingAgentNames: [],
    })
    await h.store.finalizeWorkHandoff(handoff.id, null, {
      type: 'system_note', kind: 'info', text: 'Goal', workHandoffId: handoff.id, workHandoffPhase: 'created',
    })
    await h.manor.handle({ type: 'accept_work_handoff', handoffId: handoff.id, checkout: { mode: 'worktree' } }, h.reply)
    await until(() => h.seen.length === 1, 'accepted goal kickoff')
    const chatId = (await h.store.listWorkHandoffs()).find((row) => row.id === handoff.id)!.workChatId!
    await h.store.appendEvent(chatId, {
      type: 'turn_result', agentId: 'sage', turnId: 'edit',
      fileChanges: [{ path: 'src/main.ts', status: 'edited', added: 1, removed: 0, edits: [] }],
    })
    await h.store.reachWorkGoal(handoff.id, { type: 'system_note', kind: 'info', text: 'Sage marked the goal reached.', workGoalHandoffId: handoff.id })
    const status = async () => {
      await h.manor.handle({ type: 'checkout_status', chatId }, h.reply)
      return h.replies.at(-1)
    }

    // One folder on main and one on develop: the one home flag on main must not become a merge offer.
    expect(await status()).toMatchObject({ type: 'checkout_status', mode: 'worktree', branches: expect.arrayContaining([{ name: 'main', available: false, reason: expect.any(String), home: true }]) })
    expect(h.replies.at(-1)).not.toHaveProperty('homeBranch')
    git(second, 'switch', '--quiet', 'main')
    expect(await status()).toMatchObject({ homeBranch: 'main' })

    // Both folders move on after the button showed main: the refusal carries the fresh branch for the retry.
    git(first, 'switch', '--quiet', '-c', 'release')
    git(second, 'switch', '--quiet', '-c', 'release')
    const before = h.replies.length
    await expect(h.manor.handle({ type: 'confirm_work_goal', handoffId: handoff.id, mergeInto: 'main' }, h.reply))
      .rejects.toThrow('is on release now, not main')
    expect(h.replies.slice(before)).toEqual([expect.objectContaining({ type: 'checkout_status', chatId, homeBranch: 'release' })])
    expect((await h.store.listWorkHandoffs()).find((row) => row.id === handoff.id)?.goalConfirmedAt).toBeUndefined()

    await h.manor.handle({ type: 'confirm_work_goal', handoffId: handoff.id, mergeInto: 'release', requestId: 'confirm' }, h.reply)
    expect(h.replies).toContainEqual({ type: 'ack', requestId: 'confirm' })
    expect((await h.store.listWorkHandoffs()).find((row) => row.id === handoff.id)?.goalConfirmedAt).toEqual(expect.any(Number))
  })

  it('retries a blocked merge under the same approval, then settles and removes the worktree and its branch', async () => {
    const source = repo()
    const h = harness(mkdtempSync(path.join(os.tmpdir(), 'manor-goal-retry-')))
    const [project] = await h.store.listProjects()
    await h.store.updateProject(project!.id, project!.name, [source])
    const dm = await h.store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })
    const { handoff } = await h.store.reserveWorkHandoff({
      sourceChatId: dm.id, sourceTurnId: 'turn_source', projectId: project!.id,
      projectName: project!.name, assignmentKey: 'Export', title: 'Export', kickoff: 'Add export.', authorAgentId: 'sage',
      leadAgentId: 'sage', leadAgentName: 'Sage', supportingAgentIds: [], supportingAgentNames: [],
    })
    await h.store.finalizeWorkHandoff(handoff.id, null, {
      type: 'system_note', kind: 'info', text: 'Export', workHandoffId: handoff.id, workHandoffPhase: 'created',
    })
    await h.manor.handle({ type: 'accept_work_handoff', handoffId: handoff.id, checkout: { mode: 'worktree' } }, h.reply)
    await until(() => h.seen.length === 1, 'accepted kickoff')
    const chatId = (await h.store.listWorkHandoffs()).find((row) => row.id === handoff.id)!.workChatId!
    const [row] = await h.store.loadChatWorktrees(chatId)
    expect(row).toMatchObject({ branch: expect.stringMatching(/^manor\/[0-9a-f]{8}$/), baseBranch: 'main' })
    writeFileSync(path.join(row!.worktreePath, 'mock-result.md'), 'export\n')
    await h.store.appendEvent(chatId, {
      type: 'turn_result', agentId: 'sage', turnId: 'edit',
      fileChanges: [{ path: path.join(row!.worktreePath, 'mock-result.md'), status: 'created', added: 1, removed: 0, edits: [] }],
    })
    await h.store.reachWorkGoal(handoff.id, { type: 'system_note', kind: 'info', text: 'Sage marked the goal reached.', workGoalHandoffId: handoff.id })
    const current = async () => (await h.store.listWorkHandoffs()).find((candidate) => candidate.id === handoff.id)!

    // An untracked copy in the linked folder makes the mock lead's fast-forward refuse.
    writeFileSync(path.join(source, 'mock-result.md'), 'by hand\n')
    await h.manor.handle({ type: 'confirm_work_goal', handoffId: handoff.id, mergeInto: 'main' }, h.reply)
    await vi.waitFor(async () => expect((await current()).goalCompletion?.status).toBe('blocked'), { timeout: 5_000 })
    const blocked = await current()
    // Manor merges after the lead's commit and names the files and what to do, not Git's output.
    expect(blocked.goalCompletion?.message).toBe('Commit or stash your changes to mock-result.md in the linked folder, then press Retry. The merge changes those files too.')
    expect(blocked.goalCompletion?.retryRefused).toBeUndefined()
    // The card offers Retry once the Confirm turn is over, not while it still runs.
    await vi.waitFor(async () => {
      const request = (await h.store.loadEvents(chatId)).find((event) => event.id === blocked.goalCompletion?.requestEventId)
      expect(request?.type === 'user_message' && request.dispatchState).toBe('completed')
    }, { timeout: 5_000 })

    // The user clears the linked folder; Retry runs the same request, which now lands.
    rmSync(path.join(source, 'mock-result.md'))
    h.replies.length = 0
    await h.manor.handle({ type: 'retry_work_completion', handoffId: handoff.id, requestId: 'retry' }, h.reply)
    expect(h.replies).toContainEqual({ type: 'ack', requestId: 'retry' })
    await vi.waitFor(async () => {
      expect((await current()).state).toBe('settled')
      expect(existsSync(row!.worktreePath)).toBe(false)
      // The branch goes right after its folder.
      expect(git(source, 'branch', '--list', row!.branch)).toBe('')
    }, { timeout: 5_000 })
    const landed = await current()
    expect(landed.goalCompletion).toMatchObject({ status: 'complete', operation: 'merge', requestEventId: blocked.goalCompletion?.requestEventId })
    expect(landed.goalCompletion?.retries).toHaveLength(1)
    expect(landed.goalConfirmations).toBeUndefined()
    expect(landed.goalConfirmedAt).toBe(blocked.goalConfirmedAt)
    expect((await h.store.getChat(chatId))?.settledAt).toEqual(expect.any(Number))
    expect(git(source, 'worktree', 'list')).not.toContain(row!.worktreePath)
    expect(readFileSync(path.join(source, 'mock-result.md'), 'utf8')).toBe('export\n')
  }, 20_000)

  it('creates a worktree on create_chat and refuses the whole create when git will not', async () => {
    const source = repo()
    const worktreesRoot = mkdtempSync(path.join(os.tmpdir(), 'manor-wt-root-'))
    const { store, manor, replies, reply, broadcast } = harness(worktreesRoot)
    const [project] = await store.listProjects()
    await store.updateProject(project!.id, project!.name, [source])

    await manor.handle(
      { type: 'create_chat', projectId: project!.id, title: 'Isolated', checkout: { mode: 'worktree' } },
      reply,
    )

    const created = replies.find((message) => message.type === 'chat_created')
    expect(created?.type).toBe('chat_created')
    if (created?.type !== 'chat_created') return
    const chat = await store.getChat(created.chatId)
    expect(chat?.checkout.mode).toBe('worktree')
    const mapping = await store.loadChatWorktrees(created.chatId)
    expect(mapping).toHaveLength(1)
    expect(existsSync(path.join(mapping[0]!.worktreePath, 'README.md'))).toBe(true)
    expect(existsSync(path.join(mapping[0]!.worktreePath, '.env'))).toBe(true)

    const before = (await store.listChats()).length
    replies.length = 0
    await manor.handle(
      {
        type: 'create_chat',
        projectId: project!.id,
        title: 'Main',
        checkout: { mode: 'worktree', branch: 'main' },
      },
      reply,
    )
    expect(replies.some((message) => message.type === 'notice')).toBe(true)
    expect(replies.some((message) => message.type === 'chat_created')).toBe(false)
    expect((await store.listChats()).length).toBe(before)
    expect(broadcast.filter((message) => message.type === 'directory').length).toBeGreaterThan(0)
  })

  it('says nothing in the transcript about a dirty source; the client draws the branch pill', async () => {
    const source = repo()
    writeFileSync(path.join(source, 'wip.txt'), 'uncommitted\n')
    const worktreesRoot = mkdtempSync(path.join(os.tmpdir(), 'manor-wt-root-'))
    const { store, manor, replies, reply } = harness(worktreesRoot)
    const [project] = await store.listProjects()
    await store.updateProject(project!.id, project!.name, [source])

    await manor.handle(
      { type: 'create_chat', projectId: project!.id, title: 'Isolated', checkout: { mode: 'worktree' } },
      reply,
    )
    const created = replies.find((message) => message.type === 'chat_created')
    expect(created?.type).toBe('chat_created')
    if (created?.type !== 'chat_created') return
    const events = await store.loadEvents(created.chatId)
    expect(events.some((event) => event.type === 'system_note')).toBe(false)
    expect(replies.some((message) => message.type === 'notice' && /uncommitted/i.test(message.text))).toBe(false)
    expect((await store.getChat(created.chatId))?.checkout).toMatchObject({ mode: 'worktree', branch: expect.stringMatching(/^manor\//) })
  })

  it('lists, reads and writes through the chat remap, and leaves the other chat on the source', async () => {
    const source = repo()
    const worktreesRoot = mkdtempSync(path.join(os.tmpdir(), 'manor-wt-root-'))
    const { store, manor, replies, reply } = harness(worktreesRoot)
    const [project] = await store.listProjects()
    await store.updateProject(project!.id, project!.name, [source])
    const current = (await store.listChats())[0]!
    await manor.handle(
      { type: 'create_chat', projectId: project!.id, title: 'Isolated', checkout: { mode: 'worktree' } },
      reply,
    )
    const created = replies.find((message) => message.type === 'chat_created')
    if (created?.type !== 'chat_created') throw new Error('expected chat_created')
    const isolated = created.chatId
    const label = path.basename(source)

    replies.length = 0
    await manor.handle({ type: 'list_repo_files', projectId: project!.id }, reply)
    const projectList = replies.at(-1)
    if (projectList?.type !== 'repo_files') throw new Error('expected repo_files')
    expect(projectList.chatId).toBeUndefined()

    replies.length = 0
    await manor.handle({ type: 'list_repo_files', projectId: project!.id, chatId: isolated }, reply)
    const isolatedList = replies.at(-1)
    if (isolatedList?.type !== 'repo_files') throw new Error('expected repo_files')
    expect(isolatedList.chatId).toBe(isolated)
    expect(isolatedList.files).toContain(`${label}/src/main.ts`)

    replies.length = 0
    await manor.handle(
      {
        type: 'read_repo_file',
        projectId: project!.id,
        chatId: isolated,
        path: `${label}/src/main.ts`,
      },
      reply,
    )
    const preview = replies.at(-1)
    if (preview?.type !== 'repo_file' || preview.result.status !== 'ready') throw new Error('expected ready file')
    await manor.handle(
      {
        type: 'write_repo_file',
        projectId: project!.id,
        chatId: isolated,
        path: `${label}/src/main.ts`,
        content: 'export const isolated = true\n',
        baseRevision: preview.result.revision ?? '',
      },
      reply,
    )

    expect(readFileSync(path.join(source, 'src', 'main.ts'), 'utf8')).toBe('export {}\n')
    const mapping = await store.loadChatWorktrees(isolated)
    expect(readFileSync(path.join(mapping[0]!.worktreePath, 'src', 'main.ts'), 'utf8')).toBe(
      'export const isolated = true\n',
    )

    replies.length = 0
    await manor.handle(
      { type: 'read_repo_file', projectId: project!.id, chatId: current.id, path: `${label}/src/main.ts` },
      reply,
    )
    const shared = replies.at(-1)
    if (shared?.type !== 'repo_file' || shared.result.status !== 'ready') throw new Error('expected ready file')
    expect(shared.result.content).toBe('export {}\n')
  })

  it('clears only this chat\'s sessions on checkout change, and every chat on a folder-list change', async () => {
    const source = repo()
    const worktreesRoot = mkdtempSync(path.join(os.tmpdir(), 'manor-wt-root-'))
    const { store, manor, replies, reply } = harness(worktreesRoot)
    const [project] = await store.listProjects()
    await store.updateProject(project!.id, project!.name, [source])
    const current = (await store.listChats())[0]!
    git(source, 'checkout', '-b', 'topic')
    git(source, 'checkout', 'main')
    const isolatedId = await createdIsolated(manor, reply, replies, project!.id)
    await store.setSession(current.id, 'sage', 'session-current')
    await store.setSession(isolatedId, 'sage', 'session-isolated')

    await manor.handle(
      { type: 'set_chat_checkout', chatId: isolatedId, checkout: { mode: 'worktree', branch: 'topic' } },
      reply,
    )

    expect(await sessionIdIn(store, isolatedId, 'sage')).toBeUndefined()
    expect(await sessionIdIn(store, current.id, 'sage')).toBe('session-current')
    expect((await store.getChat(isolatedId))?.checkout.mode).toBe('worktree')

    await store.setSession(isolatedId, 'sage', 'session-isolated-2')
    const notes = mkdtempSync(path.join(os.tmpdir(), 'manor-notes-'))
    await manor.handle(
      { type: 'update_project', projectId: project!.id, name: project!.name, repoPaths: [source, notes] },
      reply,
    )
    expect(await sessionIdIn(store, isolatedId, 'sage')).toBeUndefined()
    expect(await sessionIdIn(store, current.id, 'sage')).toBeUndefined()
  })

  it('refuses to return an isolated chat to current checkout', async () => {
    const source = repo()
    const worktreesRoot = mkdtempSync(path.join(os.tmpdir(), 'manor-wt-root-'))
    const { store, manor, replies, reply } = harness(worktreesRoot)
    const [project] = await store.listProjects()
    await store.updateProject(project!.id, project!.name, [source])
    const chatId = await createdIsolated(manor, reply, replies, project!.id)
    const mapping = await store.loadChatWorktrees(chatId)
    expect(mapping).toHaveLength(1)
    const dest = mapping[0]!.worktreePath

    replies.length = 0
    await manor.handle({ type: 'set_chat_checkout', chatId, checkout: { mode: 'current' } }, reply)
    expect((await store.getChat(chatId))?.checkout.mode).toBe('worktree')
    expect(existsSync(dest)).toBe(true)
    expect(replies.some((message) => message.type === 'notice' && /already has a checkout/i.test(message.text))).toBe(
      true,
    )

    await manor.handle({ type: 'discard_chat_worktree', chatId }, reply)
    expect(existsSync(dest)).toBe(false)
    expect((await store.getChat(chatId))?.checkout.mode).toBe('current')
  })

  it('answers checkout_status for a project with no chat, so the new-chat stage can list branches', async () => {
    const source = repo()
    git(source, 'checkout', '-b', 'topic')
    git(source, 'checkout', 'main')
    const worktreesRoot = mkdtempSync(path.join(os.tmpdir(), 'manor-wt-root-'))
    const { store, manor, replies, reply } = harness(worktreesRoot)
    const [project] = await store.listProjects()
    await store.updateProject(project!.id, project!.name, [source])

    await manor.handle({ type: 'checkout_status', projectId: project!.id }, reply)
    const status = replies.at(-1)
    if (status?.type !== 'checkout_status') throw new Error('expected checkout_status')
    expect(status.projectId).toBe(project!.id)
    expect(status.chatId).toBeUndefined()
    expect(status.mode).toBe('current')
    expect(status.branch).toBe('main')
    expect(status.branches.find((row) => row.name === 'main')).toMatchObject({
      available: false,
      home: true,
    })
    expect(status.branches.find((row) => row.name === 'topic')?.available).toBe(true)
  })

  it('isolates onto a named existing branch on create, not mid-session', async () => {
    const source = repo()
    git(source, 'checkout', '-b', 'topic')
    git(source, 'checkout', 'main')
    const worktreesRoot = mkdtempSync(path.join(os.tmpdir(), 'manor-wt-root-'))
    const { store, manor, replies, reply } = harness(worktreesRoot)
    const [project] = await store.listProjects()
    await store.updateProject(project!.id, project!.name, [source])
    const current = (await store.listChats())[0]!

    replies.length = 0
    await manor.handle(
      { type: 'set_chat_checkout', chatId: current.id, checkout: { mode: 'worktree', branch: 'topic' } },
      reply,
    )
    expect((await store.getChat(current.id))?.checkout.mode).toBe('current')
    expect(replies.some((message) => message.type === 'notice' && /already has a checkout/i.test(message.text))).toBe(
      true,
    )

    const chatId = await createdIsolated(manor, reply, replies, project!.id, 'Isolated', 'topic')
    const isolated = await store.getChat(chatId)
    expect(isolated?.checkout).toEqual({ mode: 'worktree', branch: 'topic' })
    expect(git(source, 'branch', '--show-current')).toBe('main')
  })

  it('refuses checkout while a turn is running, instead of waiting to switch', async () => {
    const source = repo()
    const worktreesRoot = mkdtempSync(path.join(os.tmpdir(), 'manor-wt-root-'))
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const seen: TurnInput[] = []
    const store = createMemoryStore({ agents: roster })
    const broadcast: ServerMessage[] = []
    const replies: ServerMessage[] = []
    const blocking: Driver = {
      startTurn(input) {
        seen.push(input)
        const queue = new AsyncQueue<RuntimeEvent>()
        void gate.then(() => {
          queue.push({ type: 'message', messageId: 'm1', text: 'ok' })
          queue.push({
            type: 'result',
            text: 'ok',
            usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
            sessionId: 's1',
          })
          queue.close()
        })
        return {
          events: queue,
          stop() {
            queue.close()
          },
        }
      },
    }
    const manor = new ManorService({
      store,
      agents: () => roster,
      setAgents: () => undefined,
      mcpServers: () => [],
      setMcpServers: () => undefined,
      resolveDriver: () => blocking,
      ensureScratchDir: scratchFor,
      broadcast: (message) => broadcast.push(message),
      worktreesRoot,
    })
    const reply = (message: ServerMessage) => replies.push(message)
    const [project] = await store.listProjects()
    await store.updateProject(project!.id, project!.name, [source])
    const chat = (await store.listChats())[0]!

    const sending = manor.handle({ type: 'send_message', chatId: chat.id, text: '@Sage hi' }, reply)
    await expect.poll(() => seen.length).toBe(1)
    replies.length = 0
    await manor.handle(
      { type: 'set_chat_checkout', chatId: chat.id, checkout: { mode: 'worktree' } },
      reply,
    )
    expect((await store.getChat(chat.id))?.checkout.mode).toBe('current')
    expect(replies.some((message) => message.type === 'notice' && /queued or running/i.test(message.text))).toBe(
      true,
    )
    release()
    await sending
    expect((await store.getChat(chat.id))?.checkout.mode).toBe('current')
  })

  it('reserves a branch switch before a send can start, so the turn sees the worktree', async () => {
    const source = repo()
    git(source, 'checkout', '-b', 'topic')
    git(source, 'checkout', 'main')
    const worktreesRoot = mkdtempSync(path.join(os.tmpdir(), 'manor-wt-root-'))
    const seen: TurnInput[] = []
    const { store, manor, replies, reply } = harness(worktreesRoot, seen)
    const [project] = await store.listProjects()
    await store.updateProject(project!.id, project!.name, [source])
    const chatId = await createdIsolated(manor, reply, replies, project!.id)

    const checking = manor.handle(
      { type: 'set_chat_checkout', chatId, checkout: { mode: 'worktree', branch: 'topic' } },
      reply,
    )
    const sending = manor.handle({ type: 'send_message', chatId, text: '@Sage hi' }, reply)
    await Promise.all([checking, sending])

    const mapping = await store.loadChatWorktrees(chatId)
    expect((await store.getChat(chatId))?.checkout.mode).toBe('worktree')
    expect(mapping).toHaveLength(1)
    expect(seen[0]?.repoPaths).toEqual([mapping[0]!.worktreePath])
  })

  it('does not overwrite a chat that left isolation while another chat is still reconciling', async () => {
    const source = repo()
    const extra = repo()
    const worktreesRoot = mkdtempSync(path.join(os.tmpdir(), 'manor-wt-root-'))
    const inner = createMemoryStore({ agents: roster })
    let bId: string | undefined
    let holdB: Promise<void> = Promise.resolve()
    let releaseB: () => void = () => {}
    let bEntered: () => void = () => {}
    const bStarted = new Promise<void>((resolve) => {
      bEntered = resolve
    })
    const store: Store = {
      ...inner,
      loadChatWorktrees: async (chatId) => {
        if (chatId === bId) {
          bEntered()
          await holdB
        }
        return inner.loadChatWorktrees(chatId)
      },
    }
    const broadcast: ServerMessage[] = []
    const replies: ServerMessage[] = []
    const manor = new ManorService({
      store,
      agents: () => roster,
      setAgents: () => undefined,
      mcpServers: () => [],
      setMcpServers: () => undefined,
      resolveDriver: () => createMockDriver({ deltaDelayMs: 0 }),
      ensureScratchDir: scratchFor,
      broadcast: (message) => broadcast.push(message),
      worktreesRoot,
    })
    const reply = (message: ServerMessage) => replies.push(message)
    const [project] = await store.listProjects()
    await store.updateProject(project!.id, project!.name, [source])
    const chatAId = await createdIsolated(manor, reply, replies, project!.id, 'Isolated A')
    bId = await createdIsolated(manor, reply, replies, project!.id, 'Isolated B')
    holdB = new Promise<void>((resolve) => {
      releaseB = resolve
    })

    const updating = manor.handle(
      { type: 'update_project', projectId: project!.id, name: project!.name, repoPaths: [source, extra] },
      reply,
    )
    await bStarted
    await manor.handle({ type: 'discard_chat_worktree', chatId: chatAId }, reply)
    expect((await store.getChat(chatAId))?.checkout.mode).toBe('current')
    releaseB()
    await updating
    expect((await store.getChat(chatAId))?.checkout.mode).toBe('current')
    expect(await store.loadChatWorktrees(chatAId)).toHaveLength(0)
  })

  it('deletes the chat row when create_chat cannot finish the worktree', async () => {
    const source = repo()
    chmodSync(path.join(source, '.env'), 0)
    const worktreesRoot = mkdtempSync(path.join(os.tmpdir(), 'manor-wt-root-'))
    const { store, manor, replies, reply } = harness(worktreesRoot)
    const [project] = await store.listProjects()
    await store.updateProject(project!.id, project!.name, [source])
    try {
      await manor.handle(
        { type: 'create_chat', projectId: project!.id, title: 'Isolated', checkout: { mode: 'worktree' } },
        reply,
      )
      expect(replies.some((message) => message.type === 'chat_created')).toBe(false)
      expect((await store.listChats()).every((chat) => chat.title !== 'Isolated')).toBe(true)
      expect(git(source, 'worktree', 'list').split('\n')).toHaveLength(1)
    } finally {
      chmodSync(path.join(source, '.env'), 0o644)
    }
  })

  it('creates a worktree for a git folder added while a chat is isolated', async () => {
    const source = repo()
    const extra = repo()
    const worktreesRoot = mkdtempSync(path.join(os.tmpdir(), 'manor-wt-root-'))
    const { store, manor, replies, reply } = harness(worktreesRoot)
    const [project] = await store.listProjects()
    await store.updateProject(project!.id, project!.name, [source])
    const chatId = await createdIsolated(manor, reply, replies, project!.id)
    expect((await store.loadChatWorktrees(chatId)).length).toBe(1)

    await manor.handle(
      { type: 'update_project', projectId: project!.id, name: project!.name, repoPaths: [source, extra] },
      reply,
    )
    const mapping = await store.loadChatWorktrees(chatId)
    expect(mapping).toHaveLength(2)
    expect(mapping.some((row) => row.sourcePath === extra)).toBe(true)
    expect(existsSync(mapping.find((row) => row.sourcePath === extra)!.worktreePath)).toBe(true)
    expect((await store.getProject(project!.id))?.repoPaths).toEqual([source, extra])
  })

  it('refuses a folder-list change that cannot isolate the added git folder', async () => {
    const source = repo()
    const extra = repo()
    const worktreesRoot = mkdtempSync(path.join(os.tmpdir(), 'manor-wt-root-'))
    const { store, manor, replies, reply } = harness(worktreesRoot)
    const [project] = await store.listProjects()
    await store.updateProject(project!.id, project!.name, [source])
    const chatId = await createdIsolated(manor, reply, replies, project!.id)

    const dest = worktreeDir(worktreesRoot, project!.id, chatId, extra)
    mkdirSync(dest, { recursive: true })
    writeFileSync(path.join(dest, 'wip.txt'), 'keep me\n')
    replies.length = 0
    await manor.handle(
      { type: 'update_project', projectId: project!.id, name: project!.name, repoPaths: [source, extra] },
      reply,
    )
    expect(replies.some((message) => message.type === 'notice')).toBe(true)
    expect((await store.getProject(project!.id))?.repoPaths).toEqual([source])
    expect(await store.loadChatWorktrees(chatId)).toHaveLength(1)
    expect(readFileSync(path.join(dest, 'wip.txt'), 'utf8')).toBe('keep me\n')
  })

  it('rolls back only newly created worktrees when the mapping cannot be saved', async () => {
    const source = repo()
    const worktreesRoot = mkdtempSync(path.join(os.tmpdir(), 'manor-wt-root-'))
    const inner = createMemoryStore({ agents: roster })
    const store: Store = {
      ...inner,
      replaceChatWorktrees: () => Promise.reject(new Error('persist failed')),
    }
    const replies: ServerMessage[] = []
    const manor = new ManorService({
      store,
      agents: () => roster,
      setAgents: () => undefined,
      mcpServers: () => [],
      setMcpServers: () => undefined,
      resolveDriver: () => createMockDriver({ deltaDelayMs: 0 }),
      ensureScratchDir: scratchFor,
      broadcast: () => undefined,
      worktreesRoot,
    })
    const reply = (message: ServerMessage) => replies.push(message)
    const [project] = await store.listProjects()
    await store.updateProject(project!.id, project!.name, [source])

    await manor.handle(
      { type: 'create_chat', projectId: project!.id, title: 'Isolated', checkout: { mode: 'worktree' } },
      reply,
    )
    expect(replies.some((message) => message.type === 'chat_created')).toBe(false)
    expect(git(source, 'worktree', 'list').split('\n')).toHaveLength(1)
  })

  it('switches leftovers back when a branch change cannot be saved', async () => {
    const source = repo()
    git(source, 'checkout', '-b', 'topic')
    git(source, 'checkout', 'main')
    const worktreesRoot = mkdtempSync(path.join(os.tmpdir(), 'manor-wt-root-'))
    const inner = createMemoryStore({ agents: roster })
    let failNext = false
    const store: Store = {
      ...inner,
      replaceChatWorktrees: async (chatId, mapping) => {
        if (failNext) throw new Error('persist failed')
        return inner.replaceChatWorktrees(chatId, mapping)
      },
    }
    const replies: ServerMessage[] = []
    const manor = new ManorService({
      store,
      agents: () => roster,
      setAgents: () => undefined,
      mcpServers: () => [],
      setMcpServers: () => undefined,
      resolveDriver: () => createMockDriver({ deltaDelayMs: 0 }),
      ensureScratchDir: scratchFor,
      broadcast: () => undefined,
      worktreesRoot,
    })
    const reply = (message: ServerMessage) => replies.push(message)
    const [project] = await store.listProjects()
    await store.updateProject(project!.id, project!.name, [source])
    const chatId = await createdIsolated(manor, reply, replies, project!.id)
    const mapping = await store.loadChatWorktrees(chatId)
    const dest = mapping[0]!.worktreePath
    const previous = git(dest, 'branch', '--show-current')
    failNext = true
    replies.length = 0
    await manor.handle(
      { type: 'set_chat_checkout', chatId, checkout: { mode: 'worktree', branch: 'topic' } },
      reply,
    )
    expect(replies.some((message) => message.type === 'notice' && /could not save/i.test(message.text))).toBe(true)
    expect(git(dest, 'branch', '--show-current')).toBe(previous)
    expect((await store.loadChatWorktrees(chatId))[0]?.branch).toBe(previous)
    expect(existsSync(dest)).toBe(true)
  })

  it('rolls back earlier chats when mapping persist fails while adding a git folder', async () => {
    const source = repo()
    const extra = repo()
    const worktreesRoot = mkdtempSync(path.join(os.tmpdir(), 'manor-wt-root-'))
    const inner = createMemoryStore({ agents: roster })
    let twoRowReplaces = 0
    const store: Store = {
      ...inner,
      replaceChatWorktrees: async (chatId, mapping) => {
        if (mapping.length > 1) {
          twoRowReplaces += 1
          if (twoRowReplaces > 1) throw new Error('persist failed')
        }
        return inner.replaceChatWorktrees(chatId, mapping)
      },
    }
    const replies: ServerMessage[] = []
    const manor = new ManorService({
      store,
      agents: () => roster,
      setAgents: () => undefined,
      mcpServers: () => [],
      setMcpServers: () => undefined,
      resolveDriver: () => createMockDriver({ deltaDelayMs: 0 }),
      ensureScratchDir: scratchFor,
      broadcast: () => undefined,
      worktreesRoot,
    })
    const reply = (message: ServerMessage) => replies.push(message)
    const [project] = await store.listProjects()
    await store.updateProject(project!.id, project!.name, [source])
    const chatA = await createdIsolated(manor, reply, replies, project!.id, 'Isolated A')
    const chatB = await createdIsolated(manor, reply, replies, project!.id, 'Isolated B')
    const destA = worktreeDir(worktreesRoot, project!.id, chatA, extra)
    const destB = worktreeDir(worktreesRoot, project!.id, chatB, extra)

    replies.length = 0
    await manor.handle(
      { type: 'update_project', projectId: project!.id, name: project!.name, repoPaths: [source, extra] },
      reply,
    )
    expect(replies.some((message) => message.type === 'notice' && /could not save/i.test(message.text))).toBe(true)
    expect((await store.getProject(project!.id))?.repoPaths).toEqual([source])
    expect(await store.loadChatWorktrees(chatA)).toHaveLength(1)
    expect(await store.loadChatWorktrees(chatB)).toHaveLength(1)
    expect(existsSync(destA)).toBe(false)
    expect(existsSync(destB)).toBe(false)
  })

  it('strips node_modules from a settled isolated chat and leaves the checkout', async () => {
    const source = repo()
    const worktreesRoot = mkdtempSync(path.join(os.tmpdir(), 'manor-wt-root-'))
    const { store, manor, replies, reply } = harness(worktreesRoot)
    const [project] = await store.listProjects()
    await store.updateProject(project!.id, project!.name, [source])
    const chatId = await createdIsolated(manor, reply, replies, project!.id)
    const [row] = await store.loadChatWorktrees(chatId)
    commitIn(row!.worktreePath)
    mkdirSync(path.join(row!.worktreePath, 'node_modules'), { recursive: true })
    writeFileSync(path.join(row!.worktreePath, 'node_modules', 'keep.js'), '1\n')
    await store.setChatSettled(chatId, true)

    const swept = await manor.sweepChatWorktrees(await store.listChats())
    expect(swept.nodeModulesRemoved).toBe(1)
    expect(existsSync(row!.worktreePath)).toBe(true)
    expect(existsSync(path.join(row!.worktreePath, 'README.md'))).toBe(true)
    expect(existsSync(path.join(row!.worktreePath, 'node_modules'))).toBe(false)
  })

  it('does not prune node_modules while a turn is queued or running', async () => {
    const source = repo()
    const worktreesRoot = mkdtempSync(path.join(os.tmpdir(), 'manor-wt-root-'))
    let release!: () => void
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    const store = createMemoryStore({ agents: roster })
    const replies: ServerMessage[] = []
    const manor = new ManorService({
      store,
      agents: () => roster,
      setAgents: () => undefined,
      mcpServers: () => [],
      setMcpServers: () => undefined,
      resolveDriver: () => ({
        startTurn() {
          const queue = new AsyncQueue<RuntimeEvent>()
          void released.then(() => queue.close())
          return {
            events: queue,
            stop() {
              queue.close()
            },
          }
        },
      }),
      ensureScratchDir: scratchFor,
      broadcast: () => undefined,
      worktreesRoot,
    })
    const reply = (message: ServerMessage) => replies.push(message)
    const [project] = await store.listProjects()
    await store.updateProject(project!.id, project!.name, [source])
    const chatId = await createdIsolated(manor, reply, replies, project!.id)
    const [row] = await store.loadChatWorktrees(chatId)
    commitIn(row!.worktreePath)
    mkdirSync(path.join(row!.worktreePath, 'node_modules'), { recursive: true })
    writeFileSync(path.join(row!.worktreePath, 'node_modules', 'keep.js'), '1\n')
    await store.setChatSettled(chatId, true)

    const pending = manor.handle({ type: 'send_message', chatId, text: '@Sage hold' }, reply)
    const busy = await manor.sweepChatWorktrees(await store.listChats())
    expect(busy.nodeModulesRemoved).toBe(0)
    expect(existsSync(path.join(row!.worktreePath, 'node_modules', 'keep.js'))).toBe(true)

    release()
    await pending
    const idle = await manor.sweepChatWorktrees(await store.listChats())
    expect(idle.nodeModulesRemoved).toBe(1)
    expect(existsSync(path.join(row!.worktreePath, 'node_modules'))).toBe(false)
  })

  it('does not prune after an unsettle or unarchive that landed on a stale snapshot', async () => {
    const source = repo()
    const worktreesRoot = mkdtempSync(path.join(os.tmpdir(), 'manor-wt-root-'))
    const { store, manor, replies, reply } = harness(worktreesRoot)
    const [project] = await store.listProjects()
    await store.updateProject(project!.id, project!.name, [source])
    const settledId = await createdIsolated(manor, reply, replies, project!.id, 'Settled')
    const archivedId = await createdIsolated(manor, reply, replies, project!.id, 'Archived')
    const settledRow = (await store.loadChatWorktrees(settledId))[0]!
    const archivedRow = (await store.loadChatWorktrees(archivedId))[0]!
    commitIn(settledRow.worktreePath)
    commitIn(archivedRow.worktreePath)
    mkdirSync(path.join(settledRow.worktreePath, 'node_modules'), { recursive: true })
    writeFileSync(path.join(settledRow.worktreePath, 'node_modules', 'keep.js'), '1\n')
    mkdirSync(path.join(archivedRow.worktreePath, 'node_modules'), { recursive: true })
    writeFileSync(path.join(archivedRow.worktreePath, 'node_modules', 'keep.js'), '1\n')
    await store.setChatSettled(settledId, true)
    await store.setChatArchived(archivedId, true)
    const snapshot = await store.listChats()
    await store.setChatSettled(settledId, false)
    await store.setChatArchived(archivedId, false)

    const swept = await manor.sweepChatWorktrees(snapshot)
    expect(swept.nodeModulesRemoved).toBe(0)
    expect(existsSync(path.join(settledRow.worktreePath, 'node_modules', 'keep.js'))).toBe(true)
    expect(existsSync(path.join(archivedRow.worktreePath, 'node_modules', 'keep.js'))).toBe(true)
  })
  it('removes a merged clean worktree and its Manor branch on settle, keeps the mapping, and restores it on reopen', async () => {
    const source = repo()
    writeFileSync(path.join(source, '.gitignore'), '.env\nnode_modules\n')
    git(source, 'add', '.gitignore')
    git(source, 'commit', '--quiet', '-m', 'ignore node_modules')
    const worktreesRoot = mkdtempSync(path.join(os.tmpdir(), 'manor-wt-root-'))
    const { store, manor, replies, reply, seen } = harness(worktreesRoot)
    const [project] = await store.listProjects()
    await store.updateProject(project!.id, project!.name, [source])
    const chatId = await createdIsolated(manor, reply, replies, project!.id)
    const [row] = await store.loadChatWorktrees(chatId)
    commitIn(row!.worktreePath)
    git(source, 'merge', '--quiet', '--ff-only', row!.branch)
    mkdirSync(path.join(row!.worktreePath, 'node_modules'), { recursive: true })
    writeFileSync(path.join(row!.worktreePath, 'node_modules', 'ignored.js'), '1\n')

    await manor.handle({ type: 'set_chat_settled', chatId, settled: true }, reply)
    expect(existsSync(row!.worktreePath)).toBe(false)
    expect(git(source, 'worktree', 'list')).not.toContain(row!.worktreePath)
    expect(git(source, 'branch', '--list', row!.branch)).toBe('')
    expect(await store.loadChatWorktrees(chatId)).toEqual([row])
    replies.length = 0
    await manor.handle({ type: 'session_repo', chatId }, reply)
    expect(replies.at(-1)).toMatchObject({ type: 'session_repo', error: expect.stringMatching(/removed after its work landed/) })

    await manor.handle({ type: 'set_chat_settled', chatId, settled: false }, reply)
    expect(existsSync(path.join(row!.worktreePath, 'work.ts'))).toBe(true)
    expect(git(row!.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(row!.branch)

    // A turn restores it too, for a Session whose folder left disk without a reopen.
    await store.setChatSettled(chatId, true)
    expect((await manor.sweepChatWorktrees(await store.listChats())).worktreesReleased).toBe(1)
    expect(existsSync(row!.worktreePath)).toBe(false)
    await store.setChatSettled(chatId, false)
    await manor.handle({ type: 'send_message', chatId, text: '@Sage go on' }, reply)
    await until(() => seen.length > 0, 'the turn to start')
    expect(seen[0]?.repoPaths).toEqual([row!.worktreePath])
    expect(git(row!.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(row!.branch)
  })

  it('judges a worktree by the branch it was created from, not main', async () => {
    const source = repo()
    git(source, 'switch', '--quiet', '-c', 'develop')
    const { store, manor, replies, reply } = harness(mkdtempSync(path.join(os.tmpdir(), 'manor-wt-root-')))
    const [project] = await store.listProjects()
    await store.updateProject(project!.id, project!.name, [source])
    const chatId = await createdIsolated(manor, reply, replies, project!.id)
    const [row] = await store.loadChatWorktrees(chatId)
    expect(row?.baseBranch).toBe('develop')
    commitIn(row!.worktreePath)
    git(source, 'merge', '--quiet', '--ff-only', row!.branch)

    await manor.handle({ type: 'set_chat_settled', chatId, settled: true }, reply)
    expect(existsSync(row!.worktreePath)).toBe(false)
    expect(git(source, 'branch', '--list', row!.branch)).toBe('')
    expect(git(source, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('develop')

    // Reopen after the linked folder moved to main brings the branch back from develop.
    git(source, 'switch', '--quiet', 'main')
    await manor.handle({ type: 'set_chat_settled', chatId, settled: false }, reply)
    expect(existsSync(path.join(row!.worktreePath, 'work.ts'))).toBe(true)
    expect(git(row!.worktreePath, 'rev-parse', 'HEAD')).toBe(git(source, 'rev-parse', 'develop'))
  })

  it('keeps a settled worktree that is dirty or whose branch is not in main', async () => {
    const source = repo()
    const worktreesRoot = mkdtempSync(path.join(os.tmpdir(), 'manor-wt-root-'))
    const { store, manor, replies, reply } = harness(worktreesRoot)
    const [project] = await store.listProjects()
    await store.updateProject(project!.id, project!.name, [source])
    const dirtyId = await createdIsolated(manor, reply, replies, project!.id, 'Dirty')
    const unmergedId = await createdIsolated(manor, reply, replies, project!.id, 'Unmerged')
    const hiddenId = await createdIsolated(manor, reply, replies, project!.id, 'Hidden edit')
    const dirty = (await store.loadChatWorktrees(dirtyId))[0]!
    const unmerged = (await store.loadChatWorktrees(unmergedId))[0]!
    const hidden = (await store.loadChatWorktrees(hiddenId))[0]!
    // A repo-local setting that hides untracked files must not hide them from release.
    git(source, 'config', 'status.showUntrackedFiles', 'no')
    writeFileSync(path.join(dirty.worktreePath, 'wip.ts'), 'export {}\n')
    commitIn(unmerged.worktreePath)
    // git status and git worktree remove both miss an edit behind skip-worktree.
    git(hidden.worktreePath, 'update-index', '--skip-worktree', 'README.md')
    writeFileSync(path.join(hidden.worktreePath, 'README.md'), 'only copy\n')

    for (const chatId of [dirtyId, unmergedId, hiddenId]) {
      await manor.handle({ type: 'set_chat_settled', chatId, settled: true }, reply)
    }
    const swept = await manor.sweepChatWorktrees(await store.listChats())
    expect(swept.worktreesReleased).toBe(0)
    expect(readFileSync(path.join(dirty.worktreePath, 'wip.ts'), 'utf8')).toBe('export {}\n')
    expect(existsSync(path.join(unmerged.worktreePath, 'work.ts'))).toBe(true)
    expect(readFileSync(path.join(hidden.worktreePath, 'README.md'), 'utf8')).toBe('only copy\n')
  })

  it('says so when reopen cannot restore a released folder', async () => {
    const source = repo()
    const worktreesRoot = mkdtempSync(path.join(os.tmpdir(), 'manor-wt-root-'))
    const { store, manor, replies, reply } = harness(worktreesRoot)
    const [project] = await store.listProjects()
    await store.updateProject(project!.id, project!.name, [source])
    const chatId = await createdIsolated(manor, reply, replies, project!.id)
    const [row] = await store.loadChatWorktrees(chatId)
    await manor.handle({ type: 'set_chat_settled', chatId, settled: true }, reply)
    expect(existsSync(row!.worktreePath)).toBe(false)
    // The released branch is gone; checking a new one out under its name in the linked folder blocks the restore.
    git(source, 'switch', '--quiet', '-c', row!.branch)

    replies.length = 0
    await manor.handle({ type: 'set_chat_settled', chatId, settled: false }, reply)
    expect(replies).toContainEqual(expect.objectContaining({ type: 'notice', kind: 'error', text: expect.stringMatching(/could not restore/) }))
  })
})
