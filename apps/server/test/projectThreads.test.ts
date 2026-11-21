import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { modelTextOf, type AgentConfig, type PreferenceSource, type ServerMessage, type UserInputAnswers, type WorkHandoff } from '@manor/contracts'
import { describe, expect, it, vi } from 'vitest'
import { applyThreadLineOp, archiveCompletedNotes, ensureProjectThreadFiles, newCard, PREFERENCES_BUDGET, preferencesBlock, projectThreadPaths } from '../src/projectFiles.js'
import * as projectFiles from '../src/projectFiles.js'
import * as completion from '../src/workCompletion.js'
import { localDate } from '../src/memoryWriter.js'
import { noteHandoff, noteText, sourceNote } from '../src/projectNotes.js'
import { autoBranchName } from '../src/worktree.js'

const visibleNotes = (content: string) => content.split('\n').map(noteText).join('\n')
import { shellWriteDestinations } from '../src/drivers/shellWrites.js'
import { SESSION_PLAN_RULE } from '../src/composer.js'
import { ProjectThreads, quotesPreference, SELF_ANSWER_STREAK_MAX, type ForwardedMessage, type ProjectThreadOrigin, type ThreadWakeMessage } from '../src/projectThreads.js'
import { createMemoryStore } from '../src/stores/memoryStore.js'
import { WorkModule, type WorkOrigin } from '../src/workModule.js'
import { handed, sage, seededChat, smith, until } from './helpers.js'

const wren: AgentConfig = { ...smith, id: 'wren', name: 'Wren', placement: 'session' }
const PNG = 'data:image/png;base64,iVBORw0KGgo='
const chatSage: AgentConfig = { ...sage, placement: 'chat' }
const agents = [chatSage, smith, wren]

async function harness(roster: readonly AgentConfig[] = agents) {
  const root = await mkdtemp(path.join(tmpdir(), 'manor-thread-'))
  const store = createMemoryStore({ agents: roster })
  const { projectId, chatId: looseChatId } = await seededChat(store)
  /** Wakes as requested; `compose` is what the thread's queue would run when it gets there. */
  const wakes: { chatId: string; origin: ProjectThreadOrigin; compose: () => Promise<ThreadWakeMessage | undefined> }[] = []
  const answered: { chatId: string; requestId: string; answers: UserInputAnswers; fromPreference?: PreferenceSource }[] = []
  const awaiting: Record<string, string[]> = {}
  const sent: ServerMessage[] = []
  const started: { chatId: string; origin: WorkOrigin }[] = []
  const endedTurns = new Set<string>()
  const queued: { chatId: string; message: ForwardedMessage }[] = []
  /** What the work module sent clients, in order: directory snapshots and transcript events. */
  const timeline: ({ directory: WorkHandoff[] } | { message: ServerMessage })[] = []
  let threads!: ProjectThreads
  const work = new WorkModule({
    store,
    agents: () => roster,
    orchestrator: {
      isActiveTurn: () => true,
      startStoredWorkHandoff: async (chatId, _text, origin) => { started.push({ chatId, origin }) },
      discard: () => undefined,
      stopChat: () => undefined,
      resumeChat: () => undefined,
      submitUserMessage: async () => undefined,
      runStoredUserMessage: async () => undefined,
      runExclusive: <T>(_chatId: string, fn: () => Promise<T>) => fn(),
    },
    broadcast: (message) => { sent.push(message); timeline.push({ message }) },
    // Like the real directory, which leaves out a card held while it starts.
    broadcastDirectory: async () => { timeline.push({ directory: (await store.listWorkHandoffs()).filter((row) => !work.isStarting(row.id)) }) },
    projectThreads: {
      forwardBrief: (handoff, options, task) => threads.forwardBrief(handoff, options, task),
      proposed: (handoff) => threads.proposed(handoff),
      noteProposal: (handoff) => threads.noteProposal(handoff),
      completeSessionStatus: (chatId) => threads.completeSessionStatus(chatId),
      assertSessionStatusWritable: (chatId) => threads.assertSessionStatusWritable(chatId),
    },
  })
  const threadOptions: ConstructorParameters<typeof ProjectThreads>[0] = {
    store,
    structuredRoot: root,
    agentName: (id) => roster.find((agent) => agent.id === id)?.name ?? id,
    emit: (message) => sent.push(message),
    broadcastDirectory: async () => undefined,
    wake: (chatId, origin, compose) => { wakes.push({ chatId, origin, compose }) },
    questionSettleMs: 0,
    answerQuestion: async (chatId, requestId, answers, fromPreference) => {
      if (!(awaiting[chatId] ?? []).includes(requestId)) return false
      answered.push({ chatId, requestId, answers, fromPreference })
      awaiting[chatId] = (awaiting[chatId] ?? []).filter((id) => id !== requestId)
      // The broker records the response, which is where the answer note is written.
      await threads.recordAnswer(chatId, requestId, answers, fromPreference)
      return true
    },
    awaitingInput: () => awaiting,
    isActiveTurn: (_chatId, _agentId, turnId) => !endedTurns.has(turnId),
    acceptHandoff: (id, options) => work.accept(id, options),
    reopenSession: (chatId) => work.setSettled(chatId, false),
    acceptInSession: async (chatId, message) => {
      queued.push({ chatId, message })
      await store.appendEvent(chatId, { type: 'user_message', text: message.text, mentions: [], forwardedFrom: message.forwardedFrom })
    },
  }
  threads = new ProjectThreads(threadOptions)
  const threadChatId = await threads.create(projectId)
  const project = (await store.getProject(projectId))!
  const paths = projectThreadPaths(root, project.name)
  /** A DM brief by Sage that the user accepts, handed to the thread. */
  const acceptBrief = async (key: string, accept: Parameters<WorkModule['accept']>[1] = { mode: 'house' }) => {
    const dm = await store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })
    await work.useTool({ chatId: dm.id, agentId: 'sage', turnId: `dm_${key}` }, {
      assignmentKey: key, project: projectId, title: 'Export button', task: 'Add an export button.', firstExecutor: 'Wren',
    })
    const brief = (await store.listWorkHandoffs()).find((row) => row.sourceChatId === dm.id)!
    expect(await work.accept(brief.id, accept)).toBe(threadChatId)
    return brief
  }
  /** The thread's own proposal, as its turn would make it. */
  const propose = async (assignmentKey: string, task = 'Add an export button.') => {
    await work.useTool({ chatId: threadChatId, agentId: '__single__', turnId: `thread_${assignmentKey}` }, {
      assignmentKey, project: projectId, title: 'Export button', task, firstExecutor: 'Wren',
    })
    return (await store.listWorkHandoffs()).find((row) => row.sourceChatId === threadChatId && row.assignmentKey === assignmentKey)!
  }
  return { root, store, projectId, looseChatId, threads, work, wakes, answered, awaiting, sent, started, queued, timeline, threadChatId, paths, endedTurns, acceptBrief, propose, threadOptions }
}

/** A session the thread proposed and the user accepted. */
async function threadSession(h: Awaited<ReturnType<typeof harness>>, mode: 'single' | 'house' = 'house'): Promise<string> {
  await h.work.useTool({ chatId: h.threadChatId, agentId: '__single__', turnId: 'thread_turn' }, {
    assignmentKey: 'export', project: h.projectId, title: 'Export button', task: 'Add an export button.',
  })
  const [handoff] = (await h.store.listWorkHandoffs()).filter((row) => row.sourceChatId === h.threadChatId)
  return h.work.accept(handoff!.id, { mode })
}

/** The message a wake would run on, read when the thread's queue reaches it. */
const wakeText = async (wake: { compose: () => Promise<ThreadWakeMessage | undefined> } | undefined) => {
  const message = await wake?.compose()
  return message === undefined ? undefined : `${message.instruction}${message.text ?? ''}`
}

const notes = async (h: Awaited<ReturnType<typeof harness>>, chatId: string) =>
  (await h.store.loadEvents(chatId)).flatMap((event) => event.type === 'system_note' ? [event] : [])

describe('project thread files', () => {
  it('changes one bullet at a time and refuses a stale quote', () => {
    const start = '---\nowner: project-thread\n---\n# Preferences\n\n'
    const added = applyThreadLineOp(start, { action: 'add', line: 'Never use the word fade' })
    expect('content' in added && added.content).toBe(`${start}- Never use the word fade\n`)
    if (!('content' in added)) throw new Error('add failed')
    expect(applyThreadLineOp(added.content, { action: 'add', line: '- Never use the word fade' })).toEqual({ error: 'That line is already in the file.' })
    const replaced = applyThreadLineOp(added.content, { action: 'replace', old: 'Never use the word fade', line: 'Say dissolve instead of fade' })
    expect('content' in replaced && replaced.content).toContain('- Say dissolve instead of fade')
    expect('content' in replaced && replaced.content).not.toContain('Never use')
    expect('error' in applyThreadLineOp(added.content, { action: 'remove', old: 'something else' })).toBe(true)
  })

  it('marks existing files without rewriting them', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'manor-files-'))
    const paths = projectThreadPaths(root, 'Example App')
    await ensureProjectThreadFiles(paths, 'Example App')
    await writeFile(paths.notes, '# Notes\n\n- Launch is live\n')
    await ensureProjectThreadFiles(paths, 'Example App')
    expect(await readFile(paths.notes, 'utf8')).toBe('---\nowner: project-thread\n---\n# Notes\n\n- Launch is live\n')
    expect(await readFile(paths.index, 'utf8')).toContain('[Preferences](preferences.md)')
  })

  it('converts old index separators without changing descriptions and is then a no-op', async () => {
    const paths = projectThreadPaths(await mkdtemp(path.join(tmpdir(), 'manor-setup-')), 'Client')
    await ensureProjectThreadFiles(paths, 'Client')
    const old = '# Client memory index\n\n- [Preferences](preferences.md), Keep commas, spacing  and — text.\n- [Notes](notes.md) — Keep: everything.\n- [Other](other.md), Description, unchanged.\n'
    await writeFile(paths.index, old)
    await writeFile(paths.notes, '---\nowner: project-thread\n---\n# Notes for Client\n\n- [ ] Existing task\n- Ordinary context\n')
    const notes = await readFile(paths.notes, 'utf8')
    const planned = await ensureProjectThreadFiles(paths, 'Client', { dryRun: true })
    expect(planned).toEqual([{ path: paths.index, kinds: ['index-row'] }])
    expect(await readFile(paths.index, 'utf8')).toBe(old)
    expect(await ensureProjectThreadFiles(paths, 'Client')).toEqual(planned)
    expect(await readFile(paths.index, 'utf8')).toBe(old.replace('), ', '): ').replace(') — ', '): ').replace('other.md), ', 'other.md): '))
    expect(await readFile(paths.notes, 'utf8')).toBe(notes)
    const before = await stat(paths.index)
    expect(await ensureProjectThreadFiles(paths, 'Client')).toEqual([])
    expect((await stat(paths.index)).mtimeMs).toBe(before.mtimeMs)
    await writeFile(paths.index, '# Index\n- [Preferences](preferences.md), Description stays.\n')
    expect(await ensureProjectThreadFiles(paths, 'Client', { dryRun: true })).toEqual([{ path: paths.index, kinds: ['index-row', 'index-row-added'] }])
  })

  it('leaves pinned setup files and archives untouched and surfaces unreadable files', async () => {
    const paths = projectThreadPaths(await mkdtemp(path.join(tmpdir(), 'manor-setup-')), 'Pinned')
    await mkdir(paths.folder, { recursive: true })
    const pinned = '---\npinned: true\n---\n# Pinned\n- [x] Keep here\n'
    for (const file of [paths.notes, paths.preferences, paths.index]) await writeFile(file, pinned)
    expect(await ensureProjectThreadFiles(paths, 'Pinned')).toEqual([])
    expect(await archiveCompletedNotes(paths, pinned)).toBe(pinned)
    for (const file of [paths.notes, paths.preferences, paths.index]) expect(await readFile(file, 'utf8')).toBe(pinned)
    const broken = projectThreadPaths(await mkdtemp(path.join(tmpdir(), 'manor-setup-')), 'Broken')
    await mkdir(broken.notes, { recursive: true })
    await expect(ensureProjectThreadFiles(broken, 'Broken')).rejects.toMatchObject({ code: 'EISDIR' })
  })

  describe('archiving completed notes', () => {
    const open = '---\nowner: project-thread\ntitle: Notes\n---\n# Notes\n\n- [ ] Open task\n  - [x] Nested done under open\n- A plain bullet\n- [ ] Another open\n```md\n- [x] A code example\n```\n'
    const source = `${open}- [x] Ship export\n  Verified on staging\n    - [x] Nested under done\n\n  Tail after blank\n- [X] Fix login\n`

    it('moves checked rows with their continuation and keeps everything else', async () => {
      const paths = projectThreadPaths(await mkdtemp(path.join(tmpdir(), 'manor-archive-')), 'Example App')
      expect(await archiveCompletedNotes(paths, source)).toBe(open)
      const archive = await readFile(path.join(paths.folder, '_archive', 'notes.md'), 'utf8')
      expect(archive).toBe('---\nowner: project-thread\n---\n# Archived notes\n\n- [x] Ship export\n  Verified on staging\n    - [x] Nested under done\n\n  Tail after blank\n- [X] Fix login\n')
    })

    it('leaves content alone and creates no archive when nothing is checked', async () => {
      const paths = projectThreadPaths(await mkdtemp(path.join(tmpdir(), 'manor-archive-')), 'Example App')
      expect(await archiveCompletedNotes(paths, open)).toBe(open)
      await expect(readFile(path.join(paths.folder, '_archive', 'notes.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('appends to an existing archive and does not repeat a block on retry', async () => {
      const paths = projectThreadPaths(await mkdtemp(path.join(tmpdir(), 'manor-archive-')), 'Example App')
      const file = path.join(paths.folder, '_archive', 'notes.md')
      await mkdir(path.dirname(file), { recursive: true })
      const prior = '---\nowner: project-thread\n---\n# Archived notes\n\n- [x] Older row\n'
      await writeFile(file, prior)
      await archiveCompletedNotes(paths, source)
      const once = await readFile(file, 'utf8')
      expect(once.startsWith(prior)).toBe(true)
      expect(once).toContain('- [X] Fix login')
      // The caller's notes write failed, so the same source comes back, now with one more row.
      expect(await archiveCompletedNotes(paths, `${source}- [x] Newest row\n`)).toBe(open)
      const twice = await readFile(file, 'utf8')
      expect(twice).toBe(`${once}- [x] Newest row\n`)
      expect(await archiveCompletedNotes(paths, source)).toBe(open)
      expect(await readFile(file, 'utf8')).toBe(twice)
      await writeFile(file, twice.slice(0, -1))
      expect(await archiveCompletedNotes(paths, source)).toBe(open)
      expect(await readFile(file, 'utf8')).toBe(twice.slice(0, -1))
    })

    it('archives a shorter completed block even when an older block starts with the same text', async () => {
      const paths = projectThreadPaths(await mkdtemp(path.join(tmpdir(), 'manor-archive-')), 'Example App')
      const file = path.join(paths.folder, '_archive', 'notes.md')
      await archiveCompletedNotes(paths, '# Notes\n- [x] Ship export\n  Verified on staging\n')
      await archiveCompletedNotes(paths, '# Notes\n- [x] Ship export\n')
      const archived = await readFile(file, 'utf8')
      expect(archived).toContain('- [x] Ship export\n  Verified on staging\n- [x] Ship export\n')
      await archiveCompletedNotes(paths, '# Notes\n- [x] Ship export\n')
      expect(await readFile(file, 'utf8')).toBe(archived)
    })

    it('errors without overwriting the archive when its path is a directory', async () => {
      const paths = projectThreadPaths(await mkdtemp(path.join(tmpdir(), 'manor-archive-')), 'Example App')
      const file = path.join(paths.folder, '_archive', 'notes.md')
      await mkdir(file, { recursive: true })
      await expect(archiveCompletedNotes(paths, source)).rejects.toMatchObject({ code: 'EISDIR' })

    })
  })

  it('accepts a quote only when it is a recognisable piece of a line', () => {
    const lines = ['Never re-propose the word fade']
    expect(quotesPreference(lines, '- never re-propose the word fade')).toBe(true)
    expect(quotesPreference(lines, 'fade')).toBe(false)
    expect(quotesPreference(lines, 'Always use fade')).toBe(false)
  })
})

describe('project thread lifecycle', () => {
  it('creates one Single thread, exempts it from the idle sweep and seeds it once', async () => {
    const h = await harness()
    const thread = await h.store.getChat(h.threadChatId)
    expect(thread?.mode).toBe('single')
    expect(await h.threads.create(h.projectId)).toBe(h.threadChatId)
    expect(h.wakes.filter((wake) => wake.origin.reason === 'seed')).toHaveLength(1)
    expect(await h.store.settleIdleChats(Date.now() + 1)).not.toContain(h.threadChatId)
    expect(await readFile(h.paths.preferences, 'utf8')).toContain('owner: project-thread')
    // An ordinary project edit keeps the thread.
    const project = (await h.store.getProject(h.projectId))!
    await h.store.updateProject(h.projectId, project.name, project.repoPaths)
    expect((await h.store.getProject(h.projectId))?.threadChatId).toBe(h.threadChatId)
  })

  it('keeps listed projects current at startup and skips hidden ones without creating a thread', async () => {
    const h = await harness()
    const hidden = await h.store.createProject('Eurotrip')
    const hiddenPaths = projectThreadPaths(h.root, hidden.name)
    await mkdir(hiddenPaths.folder, { recursive: true })
    await writeFile(hiddenPaths.notes, '# Eurotrip\n- Old, separator — kept\n')
    await writeFile(hiddenPaths.index, '- [Notes](notes.md) — Old separator\n')
    await writeFile(h.paths.index, '- [Preferences](preferences.md) — Prefs\n- [Notes](notes.md) — Old separator\n')
    const before = await h.store.listChats()
    const plan = await h.threads.reconcileSetup(true)
    expect(plan.find((row) => row.project === hidden.name)).toEqual({ project: hidden.name, thread: 'hidden', files: [] })
    expect(plan.find((row) => row.project !== hidden.name)).toMatchObject({ thread: 'keep', files: [{ path: h.paths.index, kinds: ['index-row'] }] })
    expect(await h.threads.reconcileSetup()).toEqual(plan)
    expect(await h.store.listChats()).toEqual(before)
    expect((await h.store.getProject(hidden.id))?.threadChatId).toBeUndefined()
    expect(await h.store.getProjectSetup(hidden.id)).toBeUndefined()
    expect(await readFile(hiddenPaths.notes, 'utf8')).toBe('# Eurotrip\n- Old, separator — kept\n')
    expect(await readFile(hiddenPaths.index, 'utf8')).toBe('- [Notes](notes.md) — Old separator\n')
    expect(await readFile(h.paths.index, 'utf8')).toContain('[Notes](notes.md): Old separator')
    // A second start writes nothing and still creates no thread.
    const watched = [h.paths.preferences, h.paths.notes, h.paths.index, hiddenPaths.notes, hiddenPaths.index]
    const stamps = await Promise.all(watched.map(async (file) => (await stat(file)).mtimeMs))
    expect((await new ProjectThreads(h.threadOptions).reconcileSetup()).every((row) => row.files.length === 0)).toBe(true)
    expect(await Promise.all(watched.map(async (file) => (await stat(file)).mtimeMs))).toEqual(stamps)
    expect(await h.store.listChats()).toEqual(before)
    expect(h.wakes.filter((wake) => wake.chatId !== h.threadChatId)).toEqual([])
  })

  it('hides a project with its thread kept and re-adds it with the same conversation', async () => {
    const h = await harness()
    const project = (await h.store.getProject(h.projectId))!
    const files = [h.paths.preferences, h.paths.notes, h.paths.index]
    const saved = await Promise.all(files.map((file) => readFile(file, 'utf8')))
    const said = await h.store.appendEvent(h.threadChatId, { type: 'user_message', text: 'Launch is on Friday.', mentions: [] })
    await h.threads.remove(h.projectId)
    expect((await h.store.getProject(h.projectId))?.threadChatId).toBe(h.threadChatId)
    expect((await h.store.getChat(h.threadChatId))?.archivedAt).not.toBeNull()
    expect((await h.threads.reconcileSetup()).find((row) => row.project === project.name)?.thread).toBe('hidden')
    expect(await Promise.all(files.map((file) => readFile(file, 'utf8')))).toEqual(saved)
    // Hidden, its files are nobody's: a Session's write stays, and a report finds no thread.
    await h.threads.turnStarted('while_hidden')
    await writeFile(h.paths.notes, `${saved[1]}- Written while hidden\n`)
    await h.threads.turnEnded({ chatId: h.looseChatId, agentId: 'wren', turnId: 'while_hidden', editedPaths: [h.paths.notes] })
    expect(await readFile(h.paths.notes, 'utf8')).toContain('- Written while hidden')
    await expect(h.threads.report({ chatId: h.looseChatId, agentId: 'sage', turnId: 'dm_turn' }, { project: project.name, kind: 'note', text: 'Anyone there?' }))
      .rejects.toThrow('No project thread matches')
    // A hidden project waits as long as it takes; its thread is not a Session that expires.
    expect(await h.store.deleteExpiredArchivedChats(Date.now() + 1)).toEqual([])

    const projects = await h.store.listProjects()
    const seeds = h.wakes.length
    expect(await h.threads.create(h.projectId)).toBe(h.threadChatId)
    expect(await h.store.listProjects()).toEqual(projects)
    expect((await h.store.getChat(h.threadChatId))?.archivedAt).toBeNull()
    expect((await h.store.loadEvents(h.threadChatId)).map((event) => event.id)).toContain(said.id)
    expect(h.wakes).toHaveLength(seeds)
    expect((await h.threads.reconcileSetup()).find((row) => row.project === project.name)).toEqual({ project: project.name, thread: 'keep', files: [] })
    // Back in the sidebar, the thread owns its files again.
    const known = await readFile(h.paths.notes, 'utf8')
    await h.threads.turnStarted('after_readd')
    await writeFile(h.paths.notes, `${known}- Written past the thread\n`)
    await h.threads.turnEnded({ chatId: h.looseChatId, agentId: 'wren', turnId: 'after_readd', editedPaths: [h.paths.notes] })
    expect(await readFile(h.paths.notes, 'utf8')).toBe(known)

    // Deleting the thread chat is the one way to lose it: the project is hidden and a re-add starts fresh.
    await h.store.deleteChat(h.threadChatId)
    expect((await h.threads.reconcileSetup()).find((row) => row.project === project.name)?.thread).toBe('hidden')
    expect((await h.store.getProject(h.projectId))?.threadChatId).toBeUndefined()
    const fresh = await h.threads.create(h.projectId)
    expect(fresh).not.toBe(h.threadChatId)
    expect((await h.store.getProject(h.projectId))?.threadChatId).toBe(fresh)
  })

  it('refuses hiding while a session it started is open, then archives the thread and keeps the files', async () => {
    const h = await harness()
    const session = await threadSession(h)
    await expect(h.threads.remove(h.projectId)).rejects.toThrow('Settle the sessions')
    await h.store.setChatSettled(session, true)
    await h.threads.remove(h.projectId)
    expect((await h.store.getProject(h.projectId))?.threadChatId).toBe(h.threadChatId)
    expect((await h.store.getChat(h.threadChatId))?.archivedAt).not.toBeNull()
    // The Session of a hidden project stands alone until the project is back.
    expect(await h.threads.sessionThread(session)).toBeUndefined()
    expect(await readFile(h.paths.preferences, 'utf8')).toContain('owner: project-thread')
    expect(await readFile(h.paths.notes, 'utf8')).toContain('owner: project-thread')
    await h.threads.create(h.projectId)
    expect((await h.threads.sessionThread(session))?.threadChatId).toBe(h.threadChatId)
  })
})

describe('a forwarded brief and a hidden project', () => {
  it('starts nothing while the project is hidden and picks the brief up when it is back', async () => {
    const h = await harness()
    const brief = await h.acceptBrief('export')
    const wake = h.wakes.at(-1)
    expect(wake?.origin.reason).toBe('brief')
    await h.threads.remove(h.projectId)
    // The wake that was already queued runs into a hidden project and delivers nothing.
    expect(await wake?.compose()).toBeUndefined()
    // A thread turn that was already running can no longer publish a card either.
    await expect(h.propose(`brief-${brief.id}`)).rejects.toThrow('The handoff author no longer exists.')
    await expect(h.work.accept(brief.id, { mode: 'house' })).rejects.toThrow('is hidden')
    expect((await h.store.listWorkHandoffs()).filter((row) => row.sourceChatId === h.threadChatId)).toEqual([])

    // Back in the sidebar, the thread is woken for the brief again and its card starts the Session.
    const before = h.wakes.length
    await h.threads.create(h.projectId)
    expect(h.wakes.slice(before).map((queued) => queued.origin.reason)).toEqual(['brief'])
    expect(await h.wakes.at(-1)?.compose()).toMatchObject({ text: expect.stringContaining('Add an export button.') })
    const card = await h.propose(`brief-${brief.id}`)
    await vi.waitFor(async () => {
      expect((await h.store.listWorkHandoffs()).find((row) => row.id === card.id)?.workChatId).not.toBeNull()
    })
    expect(await h.work.accept(brief.id, { mode: 'house' })).toBe(h.threadChatId)
  })
})

describe('runtime proposals on thread cards', () => {
  const card = (h: Awaited<ReturnType<typeof harness>>, key: string, runtime: Record<string, string> = {}) =>
    h.work.useTool({ chatId: h.threadChatId, agentId: '__single__', turnId: `thread_${key}` }, {
      assignmentKey: key, project: h.projectId, title: 'Label tweak', task: 'Rename the label.', ...runtime,
    })
  const sessionRuntime = async (h: Awaited<ReturnType<typeof harness>>, chatId: string) => {
    const chat = await h.store.getChat(chatId)
    return { mode: chat?.mode, model: chat?.singleOverride?.model, effort: chat?.singleOverride?.effort }
  }
  const sonnet = { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high', runtimeReason: 'small UI change' }

  it('opens a card on the proposed runtime, Single by default, and lets Accept override it', async () => {
    const h = await harness()
    const result = await card(h, 'label', sonnet) as { proposedRuntime?: unknown }
    expect(result.proposedRuntime).toEqual({ runtime: { driver: 'claude', model: 'claude-sonnet-5-5', effort: 'high' }, reason: 'small UI change' })
    const [proposed] = (await h.store.listWorkHandoffs()).filter((row) => row.sourceChatId === h.threadChatId)
    expect(proposed?.proposedRuntime?.reason).toBe('small UI change')
    // No mode and no runtime at Accept: Single on the thread's choice.
    const session = await h.work.accept(proposed!.id)
    expect(await sessionRuntime(h, session)).toEqual({ mode: 'single', model: 'claude-sonnet-5-5', effort: 'high' })

    await card(h, 'other', sonnet)
    const other = (await h.store.listWorkHandoffs()).find((row) => row.assignmentKey === 'other')!
    const overridden = await h.work.accept(other.id, { mode: 'single', runtime: { driver: 'claude', model: 'claude-opus-5-5', effort: 'xhigh' } })
    expect(await sessionRuntime(h, overridden)).toEqual({ mode: 'single', model: 'claude-opus-5-5', effort: 'xhigh' })
  })

  it('keeps the house default for a card without a runtime, still in Single', async () => {
    const h = await harness()
    await card(h, 'plain')
    const [proposed] = (await h.store.listWorkHandoffs()).filter((row) => row.sourceChatId === h.threadChatId)
    expect(proposed?.proposedRuntime).toBeUndefined()
    const session = await h.work.accept(proposed!.id)
    expect(await sessionRuntime(h, session)).toEqual({ mode: 'single', model: 'claude-opus-5-5', effort: 'high' })
  })

  it('refuses an unknown model with the valid list, a partial runtime, and a runtime from a persona', async () => {
    const h = await harness()
    await expect(card(h, 'bad', { ...sonnet, model: 'claude-sonnet-9' }))
      .rejects.toThrow(/Unknown claude model "claude-sonnet-9"\. Valid claude models: .*claude-sonnet-5-5/)
    await expect(card(h, 'bad-effort', { ...sonnet, provider: 'grok', model: 'grok-4.7', effort: 'max' })).rejects.toThrow(/Valid efforts: low, medium, high, xhigh\./)
    await expect(card(h, 'partial', { model: 'claude-sonnet-5-5' })).rejects.toThrow(/together, or none/)
    const dm = await h.store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })
    await expect(h.work.useTool({ chatId: dm.id, agentId: 'sage', turnId: 'dm_runtime' }, {
      assignmentKey: 'persona', project: h.projectId, title: 'Label', task: 'Rename it.', firstExecutor: 'Wren', ...sonnet,
    })).rejects.toThrow(/Only a project thread proposes a runtime/)
    expect((await h.store.listWorkHandoffs()).filter((row) => row.version > 0)).toEqual([])
  })
})

describe('project thread sessions', () => {
  it('lets the thread author a card that Wren leads by default', async () => {
    const h = await harness()
    const session = await threadSession(h)
    const handoff = await h.store.workHandoffForTarget(session)
    expect(handoff?.leadAgentId).toBe('wren')
    expect(handoff?.authorAgentId).toBe('__single__')
    expect(h.started[0]?.chatId).toBe(session)
    const kickoff = (await h.store.loadEvents(session)).find((event) => event.type === 'user_message')
    expect(kickoff?.type === 'user_message' && kickoff.workProjectName).toBe('Manor')
  })

  describe('on an install without Session personas', () => {
    // The user's own agent stays in chat; nobody here can lead Multiple, and there is no Wren.
    const fresh = () => harness([chatSage])
    const proposeUnnamed = (h: Awaited<ReturnType<typeof harness>>) =>
      h.work.useTool({ chatId: h.threadChatId, agentId: '__single__', turnId: 'thread_fresh' }, {
        assignmentKey: 'export', project: h.projectId, title: 'Export button', task: 'Add an export button.',
      }) as Promise<{ workHandoffId: string; lead: string | null }>

    it('lets the thread propose a card that names nobody, with no lead and nothing started', async () => {
      const h = await fresh()
      const result = await proposeUnnamed(h)
      expect(result.lead).toBeNull()
      const handoff = (await h.store.listWorkHandoffs()).find((row) => row.id === result.workHandoffId)!
      expect(handoff).toMatchObject({ leadAgentId: '', leadAgentName: '', supportingAgentIds: [], workChatId: null, acceptedAt: null, version: 1 })
      expect(handoff.firstExecutor).toBeUndefined()
      expect(h.started).toEqual([])
      const created = (await notes(h, h.threadChatId)).find((note) => note.workHandoffId === handoff.id)
      expect(created?.text).toBe('Session “Export button” awaits acceptance in Manor.')
    })

    it('runs that card as Single on Accept', async () => {
      const h = await fresh()
      const { workHandoffId } = await proposeUnnamed(h)
      const session = await h.work.accept(workHandoffId, { mode: 'single' })
      expect((await h.store.getChat(session))?.mode).toBe('single')
      expect(h.started.map((start) => start.chatId)).toEqual([session])
    })

    it('refuses Multiple on that card with the reason, and leaves it waiting', async () => {
      const h = await fresh()
      const { workHandoffId } = await proposeUnnamed(h)
      await expect(h.work.accept(workHandoffId, { mode: 'house' })).rejects.toThrow('Add a session agent to run Multiple.')
      const handoff = (await h.store.listWorkHandoffs()).find((row) => row.id === workHandoffId)!
      expect(handoff).toMatchObject({ state: 'active', acceptedAt: null, workChatId: null })
      expect(h.started).toEqual([])
      // Single still works after the refusal.
      expect((await h.store.getChat(await h.work.accept(workHandoffId, { mode: 'single' })))?.mode).toBe('single')
    })

    it('words the refusal differently once a Session persona exists on the install', async () => {
      const roster: AgentConfig[] = [chatSage]
      const h = await harness(roster)
      const { workHandoffId } = await proposeUnnamed(h)
      roster.push(wren)
      await expect(h.work.accept(workHandoffId, { mode: 'house' })).rejects.toThrow('No Session persona leads this proposal, so it runs as Single.')
      expect(h.started).toEqual([])
    })

    it('still refuses a chat persona the thread names as lead', async () => {
      const h = await fresh()
      await expect(h.work.useTool({ chatId: h.threadChatId, agentId: '__single__', turnId: 'thread_named' }, {
        assignmentKey: 'export', project: h.projectId, title: 'Export button', task: 'Add an export button.', firstExecutor: 'Sage',
      })).rejects.toThrow('Sage stays in chat')
    })

    it('treats a default persona that stays in chat as no lead', async () => {
      const h = await harness([chatSage, { ...wren, placement: 'chat' }])
      const result = await proposeUnnamed(h)
      expect(result.lead).toBeNull()
    })
  })

  it('keeps the thread voice and chat personas out of a project card it authors', async () => {
    const h = await harness()
    const thread = { chatId: h.threadChatId, agentId: '__single__', turnId: 'thread_team' }
    const base = { project: h.projectId, title: 'Export button', task: 'Add an export button.' }
    await expect(h.work.useTool(thread, { ...base, assignmentKey: 'chat_lead', firstExecutor: 'Sage' }))
      .rejects.toThrow('Sage stays in chat')
    await expect(h.work.useTool(thread, { ...base, assignmentKey: 'chat_support', supportingPersonas: ['Wren', 'Sage'] }))
      .rejects.toThrow('Chat personas cannot join project work: Sage')
    // Not on the roster, so a persona naming the thread voice gets no member out of it.
    const dm = await h.store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })
    for (const reference of ['__single__', 'Project thread']) {
      await expect(h.work.useTool({ chatId: dm.id, agentId: 'sage', turnId: `dm_${reference}` }, {
        ...base, assignmentKey: `voice_${reference.length}`, firstExecutor: 'Wren', supportingPersonas: [reference],
      })).rejects.toThrow('No persona matches')
    }
    expect((await h.store.listWorkHandoffs()).filter((row) => row.version > 0)).toEqual([])
  })

  it('forwards a session question to the thread and answers it only from a quoted preference', async () => {
    const h = await harness()
    const session = await threadSession(h)
    const questions = [{ id: 'corners', question: 'Square or round corners?', options: [{ label: 'Round' }, { label: 'Square' }] }]
    h.awaiting[session] = ['request_1']
    expect(await h.threads.forwardQuestion(session, 'wren', 'request_1', questions)).toBe(true)
    expect(await h.threads.forwardQuestion(h.looseChatId, 'smith', 'request_x', questions)).toBe(false)
    const card = (await notes(h, h.threadChatId)).find((note) => note.sessionQuestion !== undefined)
    expect(card?.text).toContain('asks Manor:')
    expect(card?.sessionQuestion).toMatchObject({ sessionChatId: session, requestId: 'request_1' })
    expect(h.wakes.at(-1)).toMatchObject({ chatId: h.threadChatId, origin: { reason: 'question' } })
    // A second question before that wake reads the queue joins it instead of asking for another.
    h.awaiting[session] = ['request_1', 'request_2']
    await h.threads.forwardQuestion(session, 'wren', 'request_2', [{ ...questions[0]!, question: 'Shadow or flat?' }])
    expect(h.wakes.filter((wake) => wake.origin.reason === 'question')).toHaveLength(1)
    const both = await wakeText(h.wakes.at(-1))
    expect(both).toContain('requestId request_1')
    expect(both).toContain('requestId request_2')
    h.awaiting[session] = ['request_1']
    const turn = { chatId: h.threadChatId, agentId: '__single__', turnId: 'thread_turn_2', mayAnswer: true as const }
    // A report or result wake sees the tool too, and its capability lets no answer through.
    const { mayAnswer: _mayAnswer, ...reportWake } = turn
    await expect(h.threads.answerFromThread(reportWake, { requestId: 'request_1', answers: { corners: 'Round' }, preference: 'Corners are always round' }))
      .rejects.toThrow('Only a thread turn that the user')
    await expect(h.threads.answerFromThread(turn, { requestId: 'request_1', answers: { corners: 'Round' }, preference: 'Corners are always round' }))
      .rejects.toThrow('must quote a line')
    const today = localDate(new Date())
    await h.threads.writeFile(turn, { file: 'preferences.md', action: 'add', line: 'Corners are always round, never square' })
    await h.threads.answerFromThread(turn, { requestId: 'request_1', answers: { corners: 'Round' }, preference: 'Corners are always round' })
    // The Session hears it came from Manor, with the line and its file.
    expect(h.answered).toEqual([{ chatId: session, requestId: 'request_1', answers: { corners: 'Round' }, fromPreference: { file: 'preferences.md', quote: 'Corners are always round' } }])
    const answer = (await notes(h, h.threadChatId)).find((note) => note.sessionAnswer !== undefined)
    expect(answer?.sessionAnswer).toMatchObject({ by: 'thread', preference: 'Corners are always round' })
    const write = (await notes(h, h.threadChatId)).find((note) => note.projectFileWrite !== undefined)
    expect(write?.text).toBe(`Manor saved 1 line to preferences.md: Corners are always round, never square (${today})`)
    expect(write?.projectFileWrite?.by).toBe('Project thread')
    // Names the turn that wrote it, so clients fold it under that reply.
    expect(write?.projectFileWrite?.turnId).toBe('thread_turn_2')
    await h.threads.writeFile(turn, { file: 'preferences.md', action: 'replace', old: `Corners are always round, never square (${today})`, line: 'Corners are round (2026-01-02)' })
    await h.threads.writeFile(turn, { file: 'preferences.md', action: 'remove', old: 'Corners are round (2026-01-02)' })
    const texts = (await notes(h, h.threadChatId)).filter((note) => note.projectFileWrite !== undefined).map((note) => note.text)
    // A line that already ends in a date keeps it.
    expect(texts.slice(-2)).toEqual(['Manor updated 1 line in preferences.md: Corners are round (2026-01-02)', 'Manor removed 1 line from preferences.md: Corners are round (2026-01-02)'])
  })

  it('lets the user replace a self-answer, which reaches the Session as their message after it moved on', async () => {
    const h = await harness()
    const session = await threadSession(h)
    const turn = { chatId: h.threadChatId, agentId: '__single__', turnId: 'thread_change', mayAnswer: true as const }
    await h.threads.writeFile(turn, { file: 'preferences.md', action: 'add', line: 'Corners are always round' })
    const questions = [{ id: 'corners', question: 'Square or round corners?', options: [{ label: 'Round' }, { label: 'Square' }] }]
    h.awaiting[session] = ['request_1', 'request_2']
    await h.threads.forwardQuestion(session, 'wren', 'request_1', questions)
    await h.threads.forwardQuestion(session, 'wren', 'request_2', questions)
    await h.threads.answerFromThread(turn, { requestId: 'request_1', answers: { corners: 'Round' }, preference: 'Corners are always round' })
    // Only a question in this thread that the thread answered can change, and only with an answer that fits it.
    await expect(h.threads.changeAnswer(h.threadChatId, 'request_2', { corners: 'Square' })).rejects.toThrow('not an answer Manor gave')
    await expect(h.threads.changeAnswer(h.threadChatId, 'request_1', { other: 'Square' })).rejects.toThrow('does not fit')
    expect(h.queued).toEqual([])

    // A double click: both frames run at once, and the Session hears it once.
    const results = await Promise.allSettled([
      h.threads.changeAnswer(h.threadChatId, 'request_1', { corners: 'Square' }),
      h.threads.changeAnswer(h.threadChatId, 'request_1', { corners: 'Square' }),
    ])
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected'])
    const self = (await notes(h, h.threadChatId)).find((note) => note.sessionAnswer?.by === 'thread')!
    expect(h.queued).toEqual([{ chatId: session, message: {
      text: 'I am changing the answer Manor gave you from my preferences. Go with mine, and redo what rested on Manor\'s.\n"Square or round corners?": Square, not Round',
      forwardedFrom: { threadChatId: h.threadChatId, eventId: self.id },
    } }])
    const changed = (await notes(h, h.threadChatId)).find((note) => note.sessionAnswer?.by === 'user')
    expect(changed?.text).toBe('Changed to: Square')
    // The thread hears the user overruled its line, so it can retire it.
    expect(changed?.threadPending).toContain('The user overruled the answer this thread gave the session “Export button” from the line "Corners are always round"')
    // Once per answer: the Session never gets it twice.
    await expect(h.threads.changeAnswer(h.threadChatId, 'request_1', { corners: 'Round' })).rejects.toThrow('already changed')
    expect(h.queued).toHaveLength(1)
  })

  it('stops self-answering after three in a row until the user answers one', async () => {
    const h = await harness()
    const session = await threadSession(h)
    const turn = { chatId: h.threadChatId, agentId: '__single__', turnId: 'thread_turn_3', mayAnswer: true as const }
    await h.threads.writeFile(turn, { file: 'preferences.md', action: 'add', line: 'Corners are always round' })
    const questions = [{ id: 'corners', question: 'Corners?', options: [{ label: 'Round' }, { label: 'Square' }] }]
    for (let index = 0; index < SELF_ANSWER_STREAK_MAX; index += 1) {
      h.awaiting[session] = [`request_${index}`]
      await h.threads.forwardQuestion(session, 'wren', `request_${index}`, questions)
      await h.threads.answerFromThread(turn, { requestId: `request_${index}`, answers: { corners: 'Round' }, preference: 'Corners are always round' })
    }
    const wakesBefore = h.wakes.length
    h.awaiting[session] = ['request_next']
    await h.threads.forwardQuestion(session, 'wren', 'request_next', questions)
    expect(h.wakes).toHaveLength(wakesBefore)
    await expect(h.threads.answerFromThread(turn, { requestId: 'request_next', answers: { corners: 'Round' }, preference: 'Corners are always round' }))
      .rejects.toThrow('Leave this one for the user')
    // The user answers on the card; the next question wakes the thread again.
    await h.threads.recordAnswer(session, 'request_next', { corners: 'Square' })
    h.awaiting[session] = ['request_after']
    await h.threads.forwardQuestion(session, 'wren', 'request_after', questions)
    expect(h.wakes.at(-1)?.origin.reason).toBe('question')
  })

  it('refuses the file tool and the answer tool outside the thread', async () => {
    const h = await harness()
    const outside = { chatId: h.looseChatId, agentId: 'smith', turnId: 'turn_x' }
    await expect(h.threads.writeFile(outside, { file: 'notes.md', action: 'add', line: 'Shipped' })).rejects.toThrow('Only a running project thread turn')
    await expect(h.threads.answerFromThread(outside, { requestId: 'r', answers: {}, preference: 'anything at all' })).rejects.toThrow('Only a running project thread turn')
  })

  it('holds a thread-written preference to 160 characters with its date, and leaves a long hand line alone', async () => {
    const h = await harness()
    const turn = { chatId: h.threadChatId, agentId: '__single__', turnId: 'thread_limit' }
    const dated = ` (${localDate(new Date())})`
    await h.threads.writeFile(turn, { file: 'preferences.md', action: 'add', line: 'a'.repeat(160 - dated.length) })
    await expect(h.threads.writeFile(turn, { file: 'preferences.md', action: 'add', line: 'b'.repeat(161 - dated.length) }))
      .rejects.toThrow('at most 160 characters, its date included; this one has 161')
    // The user's own edit is never blocked; the thread still writes around it.
    const hand = `- ${'The user wrote this themselves, long on purpose. '.repeat(5).trim()}`
    await writeFile(h.paths.preferences, `${await readFile(h.paths.preferences, 'utf8')}${hand}\n`)
    await h.threads.writeFile(turn, { file: 'preferences.md', action: 'add', line: 'Short rule' })
    expect(await readFile(h.paths.preferences, 'utf8')).toContain(hand)
    // Notes keep their own, larger limit, and a longer line typed by hand stays.
    await h.threads.writeFile(turn, { file: 'notes.md', action: 'add', line: 'n'.repeat(200) })
    const notesBefore = await readFile(h.paths.notes, 'utf8')
    await expect(h.threads.writeFile(turn, { file: 'notes.md', action: 'add', line: 'm'.repeat(201) })).rejects.toThrow('at most 200 characters; this one has 201')
    expect(await readFile(h.paths.notes, 'utf8')).toBe(notesBefore)
    await writeFile(h.paths.notes, `${notesBefore}- ${'h'.repeat(300)}\n`)
    await h.threads.writeFile(turn, { file: 'notes.md', action: 'add', line: 'Short note' })
    expect(await readFile(h.paths.notes, 'utf8')).toContain('h'.repeat(300))
    // A preference quoted without its appended date still matches its line.
    await h.threads.writeFile(turn, { file: 'preferences.md', action: 'replace', old: 'Short rule', line: 'Shorter rule' })
    await h.threads.writeFile(turn, { file: 'preferences.md', action: 'remove', old: 'Shorter rule' })
    expect(await readFile(h.paths.preferences, 'utf8')).not.toContain('Short')
  })

  it('puts one dated line on a listed card, and refuses unlisted cards, rewrites and a full card', async () => {
    const h = await harness()
    const turn = { chatId: h.threadChatId, agentId: '__single__', turnId: 'thread_card' }
    const card = path.join(h.paths.folder, 'project_client_corners.md')
    await writeFile(card, '---\nname: project_client_corners\n---\n\n**When:** Styling corners.\n\n**Decision:**\n- Corners are round.\n\n**Rejected:**\n- Square corners.\n')
    await writeFile(h.paths.index, `${await readFile(h.paths.index, 'utf8')}- [Corners](project_client_corners.md): Corner radius.\n`)
    expect(await h.threads.writeFile(turn, { file: 'project_client_corners.md', action: 'add', line: 'Print exports keep square corners' }))
      .toBe('Saved one dated line on project_client_corners.md.')
    const today = localDate(new Date())
    expect(await readFile(card, 'utf8')).toContain(`- Corners are round.\n- Print exports keep square corners (${today})\n\n**Rejected:**`)
    const write = (await notes(h, h.threadChatId)).find((note) => note.projectFileWrite?.file === 'project_client_corners.md')
    expect(write?.text).toBe(`Manor saved 1 line to project_client_corners.md: Print exports keep square corners (${today})`)
    await writeFile(path.join(h.paths.folder, 'project_client_loose.md'), '**Decision:**\n')
    await expect(h.threads.writeFile(turn, { file: 'project_client_loose.md', action: 'add', line: 'Anything' })).rejects.toThrow('not a card in this project\'s MEMORY.md')
    await expect(h.threads.writeFile(turn, { file: 'project_client_corners.md', action: 'replace', old: 'Corners are round.', line: 'Corners are square' })).rejects.toThrow('A card takes add')
    await expect(h.threads.writeFile(turn, { file: '../other/project_x.md', action: 'add', line: 'Anything' })).rejects.toThrow('lowercase .md filename')
    await expect(h.threads.writeFile(turn, { file: 'MEMORY.md', action: 'add', line: 'Anything' })).rejects.toThrow('lowercase .md filename')
    await writeFile(card, `${await readFile(card, 'utf8')}${'word '.repeat(600)}\n`)
    await expect(h.threads.writeFile(turn, { file: 'project_client_corners.md', action: 'add', line: 'One more' })).rejects.toThrow('600-word cap')
  })

  it('keeps a line another writer added to a card meanwhile, and retries its own append', async () => {
    const h = await harness()
    const turn = { chatId: h.threadChatId, agentId: '__single__', turnId: 'thread_race' }
    const card = path.join(h.paths.folder, 'project_client_corners.md')
    await writeFile(card, '**Decision:**\n- Corners are round.\n\n**Stop:** Ask the user.\n')
    await writeFile(h.paths.index, `${await readFile(h.paths.index, 'utf8')}- [Corners](project_client_corners.md): Corner radius.\n`)
    const original = projectFiles.writeThreadFile
    let raced = false
    const spy = vi.spyOn(projectFiles, 'writeThreadFile').mockImplementation(async (file, content, expected) => {
      if (file === card && !raced) {
        raced = true
        // The dream appends between the thread's read and its rename.
        await writeFile(card, (await readFile(card, 'utf8')).replace('- Corners are round.', '- Corners are round.\n- Dream line (2026-10-18)'))
      }
      return original(file, content, expected)
    })
    try {
      await h.threads.writeFile(turn, { file: 'project_client_corners.md', action: 'add', line: 'Thread line' })
    } finally {
      spy.mockRestore()
    }
    const text = await readFile(card, 'utf8')
    expect(text).toContain('- Dream line (2026-10-18)')
    expect(text).toContain(`- Thread line (${localDate(new Date())})`)
  })

  it('creates a card only after the user confirms it in the same turn, and lists it in MEMORY.md', async () => {
    const h = await harness()
    const turn = { chatId: h.threadChatId, agentId: '__single__', turnId: 'thread_create' }
    const input = { file: 'project_client_print.md', action: 'create' as const, title: 'Print exports', description: 'How print exports differ from screen.', when: 'Exporting for print.', line: 'Print exports keep square corners' }
    await expect(h.threads.writeFile(turn, input)).rejects.toThrow('Ask the user first')
    const ask = async (turnId: string, requestId: string, answer: string) => {
      const questions = [{ id: 'card', question: 'Create project_client_print.md for print rules?', options: [{ label: 'Create it' }, { label: 'No' }] }]
      await h.store.appendEvent(h.threadChatId, { type: 'user_input_request', agentId: '__single__', turnId, requestId, questions })
      await h.store.appendEvent(h.threadChatId, { type: 'user_input_response', agentId: '__single__', turnId, requestId, answers: { card: answer } })
    }
    await ask('thread_create', 'declined', 'No')
    await ask('another_turn', 'elsewhere', 'Create it')
    await expect(h.threads.writeFile(turn, input)).rejects.toThrow('Ask the user first')
    await ask('thread_create', 'confirmed', 'Create it')
    expect(await h.threads.writeFile(turn, input)).toBe('Created project_client_print.md and listed it in MEMORY.md.')
    const card = await readFile(path.join(h.paths.folder, 'project_client_print.md'), 'utf8')
    expect(card).toContain('name: project_client_print')
    expect(card).toContain('**When:** Exporting for print.')
    expect(card).toContain(`**Decision:**\n- Print exports keep square corners (${localDate(new Date())})`)
    expect(card).toContain('**Rejected:**')
    expect(card).toContain('**Stop:**')
    expect(await readFile(h.paths.index, 'utf8')).toContain('- [Print exports](project_client_print.md): How print exports differ from screen.\n')
    const write = (await notes(h, h.threadChatId)).find((note) => note.projectFileWrite?.action === 'create')
    expect(write?.text).toContain('Manor created project_client_print.md')
    await expect(h.threads.writeFile(turn, input)).rejects.toThrow('already exists')
    // A card another writer put on disk without a catalogue row is never overwritten.
    const theirs = path.join(h.paths.folder, 'project_client_theirs.md')
    await writeFile(theirs, 'Written by the dream.\n')
    const questions = [{ id: 'card', question: 'Create project_client_theirs.md?', options: [{ label: 'Create it' }, { label: 'No' }] }]
    await h.store.appendEvent(h.threadChatId, { type: 'user_input_request', agentId: '__single__', turnId: 'thread_create', requestId: 'theirs_q', questions })
    await h.store.appendEvent(h.threadChatId, { type: 'user_input_response', agentId: '__single__', turnId: 'thread_create', requestId: 'theirs_q', answers: { card: 'Create it' } })
    await expect(h.threads.writeFile(turn, { ...input, file: 'project_client_theirs.md' })).rejects.toThrow('already exists')
    expect(await readFile(theirs, 'utf8')).toBe('Written by the dream.\n')
    // A new card keeps the 600-word cap too.
    expect(newCard({ ...input, description: 'word '.repeat(300).trim(), when: 'word '.repeat(300).trim() })).toMatchObject({ error: expect.stringContaining('600-word cap') })
    // The new card takes dated lines like any listed card.
    await h.threads.writeFile(turn, { file: 'project_client_print.md', action: 'add', line: 'Bleed is 3 mm' })
  })

  it('answers a session question from a card a preferences line links to, never from an unlinked one', async () => {
    const h = await harness()
    const session = await threadSession(h)
    await writeFile(path.join(h.paths.folder, 'project_client_corners.md'), '**Decision:**\n- Print exports keep square corners.\n\n**Rejected:**\n- Rounded print corners everywhere.\n')
    await writeFile(path.join(h.paths.folder, 'project_client_other.md'), '**Decision:**\n- Shadows stay flat everywhere.\n')
    await writeFile(path.join(h.paths.folder, 'project_client_unlisted.md'), '**Decision:**\n- Borders are always dashed.\n')
    await writeFile(h.paths.index, `${await readFile(h.paths.index, 'utf8')}- [Corners](project_client_corners.md): Corner radius.\n- [Other](project_client_other.md): Shadows.\n`)
    await writeFile(h.paths.preferences, `${await readFile(h.paths.preferences, 'utf8')}- [Corners are round](project_client_corners.md): when styling corners\n- [Borders](project_client_unlisted.md): when drawing borders\n`)
    const questions = [{ id: 'corners', question: 'Square or round on print?', options: [{ label: 'Round' }, { label: 'Square' }] }]
    h.awaiting[session] = ['request_1']
    await h.threads.forwardQuestion(session, 'wren', 'request_1', questions)
    const turn = { chatId: h.threadChatId, agentId: '__single__', turnId: 'thread_quote', mayAnswer: true as const }
    // Only Decision lines of listed cards a preference links to count: not an unlinked card,
    // an unlisted one, a Rejected line or the section heading.
    for (const preference of ['Shadows stay flat everywhere', 'Borders are always dashed', 'Rounded print corners everywhere', '**Decision:**']) {
      await expect(h.threads.answerFromThread(turn, { requestId: 'request_1', answers: { corners: 'Square' }, preference }))
        .rejects.toThrow('must quote a line of preferences.md or of a card')
    }
    await h.threads.answerFromThread(turn, { requestId: 'request_1', answers: { corners: 'Square' }, preference: 'Print exports keep square corners' })
    expect(h.answered).toEqual([{ chatId: session, requestId: 'request_1', answers: { corners: 'Square' }, fromPreference: { file: 'project_client_corners.md', quote: 'Print exports keep square corners' } }])
  })

  it('queues a session’s learnings for the thread’s next turn instead of waking it', async () => {
    const h = await harness()
    const session = await threadSession(h)
    const handoff = (await h.store.workHandoffForTarget(session))!
    await h.store.reachWorkGoal(handoff.id, {
      type: 'system_note', kind: 'info', text: 'Wren marked the goal reached.', workGoalHandoffId: handoff.id,
      goalReport: { result: 'Export works.', learnings: [{ kind: 'preference', text: 'Buttons stay text-only', quote: 'geen iconen op knoppen' }] },
    })
    const wakes = h.wakes.length
    await h.threads.goalReached(handoff.id)
    expect(h.wakes).toHaveLength(wakes)
    const queued = await h.threads.takeQueued(h.threadChatId, { questions: false, alongside: true })
    expect(queued?.instruction).toContain('[Manor] Queued for this thread since its last turn.')
    expect(queued?.instruction).toContain('The session “Export button” reached its goal')
    expect(queued?.instruction).toContain('Buttons stay text-only')
  })

  it('lets a thread-started Session keep only its own notes.md line, without waking the thread', async () => {
    const h = await harness()
    const session = await threadSession(h)
    await h.threads.prime()
    await writeFile(h.paths.notes, `${await readFile(h.paths.notes, 'utf8')}- Export button: the thread wrote this first\n- Release is Friday\n`)
    const preferences = await readFile(h.paths.preferences, 'utf8')
    const turn = { chatId: session, agentId: 'wren', turnId: 'session_turn' }
    const wakes = h.wakes.length
    await h.threads.turnStarted(turn.turnId)
    expect(await h.threads.writeSessionStatus(turn, 'CSV export ships; PDF stays open')).toContain('Saved your status line')
    expect(await h.threads.writeSessionStatus(turn, '  CSV and PDF export ship\n')).toContain('Saved your status line')
    await expect(h.threads.writeSessionStatus(turn, 's'.repeat(201))).rejects.toThrow('at most 200 characters')
    const written = await readFile(h.paths.notes, 'utf8')
    expect(visibleNotes(written)).toContain('- [ ] Export button: CSV and PDF export ship\n')
    expect(written).toContain('the thread wrote this first')
    expect(written).not.toContain('CSV export ships; PDF stays open')
    expect(written).toContain('- Release is Friday')
    expect(await readFile(h.paths.preferences, 'utf8')).toBe(preferences)
    // The owner guard keeps the tool's write, and the thread is not woken for it.
    await h.threads.turnEnded({ ...turn, editedPaths: [] })
    expect(await readFile(h.paths.notes, 'utf8')).toBe(written)
    expect(h.wakes).toHaveLength(wakes)
    const write = (await notes(h, h.threadChatId)).filter((note) => note.projectFileWrite?.by === 'Export button').at(-1)
    expect(write?.projectFileWrite).toMatchObject({ file: 'notes.md', action: 'replace', line: '[ ] Export button: CSV and PDF export ship' })
    expect(write?.projectFileWrite?.old).not.toContain('<!--')
    // A direct edit of another line is still undone, also when a status write follows it.
    await h.threads.turnStarted('session_turn_2')
    await writeFile(h.paths.notes, written.replace('Release is Friday', 'Release is Monday'))
    await h.threads.writeSessionStatus({ ...turn, turnId: 'session_turn_2' }, 'Both exports ship')
    await h.threads.turnEnded({ chatId: session, agentId: 'wren', turnId: 'session_turn_2', editedPaths: [h.paths.notes] })
    expect(visibleNotes(await readFile(h.paths.notes, 'utf8'))).toBe(visibleNotes(written).replace('CSV and PDF export ship', 'Both exports ship'))
    // A sibling Session whose title extends this one keeps its own line.
    const sibling = 'Export button: PDF'
    await h.work.useTool({ chatId: h.threadChatId, agentId: '__single__', turnId: 'thread_turn_pdf' }, {
      assignmentKey: 'export-pdf', project: h.projectId, title: sibling, task: 'Add PDF export.',
    })
    const pdf = await h.work.accept((await h.store.listWorkHandoffs()).find((row) => row.assignmentKey === 'export-pdf')!.id, { mode: 'house' })
    await h.threads.writeSessionStatus({ chatId: pdf, agentId: 'wren', turnId: 'pdf_turn' }, 'PDF is open')
    await h.store.setChatArchived(pdf, true)
    // The user moves the sibling's line to the top by hand, so it is the first title match.
    const moved = await readFile(h.paths.notes, 'utf8')
    const siblingRow = moved.split('\n').find((line) => line.startsWith('- [ ] Export button: PDF: PDF is open'))!
    await writeFile(h.paths.notes, moved.replace(`${siblingRow}\n`, '').replace('- [ ] Export button: Both', `${siblingRow}\n- [ ] Export button: Both`))
    await h.threads.writeSessionStatus(turn, 'CSV ships')
    const both = await readFile(h.paths.notes, 'utf8')
    expect(visibleNotes(both)).toContain('- [ ] Export button: PDF: PDF is open\n')
    expect(visibleNotes(both)).toContain('- [ ] Export button: CSV ships\n')
    // IDs allow a status to resemble the sibling's title without editing its row.
    await h.threads.writeSessionStatus(turn, 'PDF: still open')
    expect(await readFile(h.paths.notes, 'utf8')).toContain(siblingRow)
    // Not even its owner marker goes back into a preferences.md the user edited by hand.
    const unmarked = preferences.replace(/^---\n[\s\S]*?\n---\n/, '')
    await writeFile(h.paths.preferences, unmarked)
    await h.threads.writeSessionStatus(turn, 'CSV ships today')
    expect(await readFile(h.paths.preferences, 'utf8')).toBe(unmarked)
    // Their own line edited directly and then confirmed through the tool is kept.
    await h.threads.turnStarted('session_turn_3')
    await writeFile(h.paths.notes, both.replace('CSV ships', 'CSV and PDF ship'))
    expect(await h.threads.writeSessionStatus({ ...turn, turnId: 'session_turn_3' }, 'CSV and PDF ship')).toContain('already reads that')
    await h.threads.turnEnded({ chatId: session, agentId: 'wren', turnId: 'session_turn_3', editedPaths: [h.paths.notes] })
    expect(visibleNotes(await readFile(h.paths.notes, 'utf8'))).toContain('- [ ] Export button: CSV and PDF ship\n')
    // Only a Session this thread started has a line; the thread and a loose chat do not.
    await expect(h.threads.writeSessionStatus({ chatId: h.looseChatId, agentId: 'smith', turnId: 'loose' }, 'Done')).rejects.toThrow('Only a Session its project thread started')
    await expect(h.threads.writeSessionStatus({ chatId: h.threadChatId, agentId: '__single__', turnId: 'thread' }, 'Done')).rejects.toThrow('Only a Session its project thread started')
    h.endedTurns.add('late')
    await expect(h.threads.writeSessionStatus({ ...turn, turnId: 'late' }, 'Done')).rejects.toThrow('Only a running Session turn')
  })

  it('archives a trusted checked status while another guarded turn is still running', async () => {
    const h = await harness()
    const session = await threadSession(h)
    const turn = { chatId: session, agentId: 'wren', turnId: 'session_turn' }
    await h.threads.turnStarted(turn.turnId)
    await h.threads.turnStarted('long_running')
    await h.threads.writeSessionStatus(turn, 'Ready')
    const handoff = (await h.store.workHandoffForTarget(session))!
    await h.store.reachWorkGoal(handoff.id, { type: 'system_note', kind: 'info', text: 'Ready.', workGoalHandoffId: handoff.id })
    await h.work.confirmGoal(handoff.id)
    await h.threads.turnEnded({ ...turn, editedPaths: [] })
    expect(await readFile(h.paths.notes, 'utf8')).not.toMatch(/^- \[x\]/m)
    expect(await readFile(path.join(h.paths.folder, '_archive', 'notes.md'), 'utf8')).toContain('- [x] Export button: Ready [Confirmed ')
  })

  it('lets the owner replace and remove visible bullet quotes without losing Session identity', async () => {
    const h = await harness()
    const session = await threadSession(h)
    const handoff = (await h.store.workHandoffForTarget(session))!
    await h.threads.writeSessionStatus({ chatId: session, agentId: 'wren', turnId: 'status' }, 'Working')
    const owner = { chatId: h.threadChatId, agentId: '__single__', turnId: 'owner' }
    await h.threads.writeFile(owner, { file: 'notes.md', action: 'replace', old: '- [ ] Export button: Working', line: '- [ ] Export button: Ready' })
    const content = await readFile(h.paths.notes, 'utf8')
    expect(content).toContain('- [ ] Export button: Ready <!--')
    expect(noteHandoff(content.split('\n').find((line) => line.startsWith('- [ ]'))!)).toBe(handoff.id)
    await h.threads.writeFile(owner, { file: 'notes.md', action: 'remove', old: '- [ ] Export button: Ready' })
    expect(await readFile(h.paths.notes, 'utf8')).not.toContain('Export button:')
  })

  it('never assigns a source Session to a negated branch report', async () => {
    const h = await harness()
    const session = await threadSession(h)
    const handoff = (await h.store.workHandoffForTarget(session))!
    await h.store.reachWorkGoal(handoff.id, { type: 'system_note', kind: 'info', text: 'Ready.', workGoalHandoffId: handoff.id })
    await h.work.confirmGoal(handoff.id)
    const line = `[ ] Unrelated task: Not reported Done on ${autoBranchName(session)}; implementation missing`
    await h.threads.writeFile({ chatId: h.threadChatId, agentId: '__single__', turnId: 'owner' }, { file: 'notes.md', action: 'add', line })
    await h.threads.idleTick()
    const row = (await readFile(h.paths.notes, 'utf8')).split('\n').find((row) => row.startsWith('- [ ]'))!
    expect(noteText(row)).toBe(`- ${line}`)
    expect(noteHandoff(row)).toBeUndefined()
  })

  it('archives trusted continuation details before a guard restores a foreign edit to that block', async () => {
    const h = await harness()
    const session = await threadSession(h)
    const turn = { chatId: session, agentId: 'wren', turnId: 'detail_writer' }
    await h.threads.writeSessionStatus(turn, 'Ready')
    await writeFile(h.paths.notes, `${await readFile(h.paths.notes, 'utf8')}  Trusted detail\n`)
    await h.threads.prime()
    await h.threads.turnStarted(turn.turnId)
    await writeFile(h.paths.notes, (await readFile(h.paths.notes, 'utf8')).replace('Trusted detail', 'Unauthorized detail'))
    const handoff = (await h.store.workHandoffForTarget(session))!
    await h.store.reachWorkGoal(handoff.id, { type: 'system_note', kind: 'info', text: 'Ready.', workGoalHandoffId: handoff.id })
    await h.work.confirmGoal(handoff.id)
    const archive = path.join(h.paths.folder, '_archive', 'notes.md')
    expect(await readFile(archive, 'utf8')).toContain('Trusted detail')
    expect(await readFile(archive, 'utf8')).not.toContain('Unauthorized detail')
    await h.threads.turnEnded({ ...turn, editedPaths: [h.paths.notes] })
    expect(await readFile(h.paths.notes, 'utf8')).not.toContain('Export button:')
    expect(await readFile(archive, 'utf8')).toContain('- [x] Export button: Ready')
  })

  it.each([
    'Blocked by upstream regression 1234567; implementation still missing',
    'Upstream fix committed as 1234567; own implementation still missing',
    'Not committed as 1234567.',
  ])('does not complete a settled Session from an unrelated or negated commit claim, %s', async (status) => {
    const h = await harness()
    await h.store.updateProject(h.projectId, 'Manor', ['/fixture'])
    const session = await threadSession(h)
    const proof = vi.spyOn(completion, 'landedNoteCommit').mockResolvedValue('1234567890abcdef1234567890abcdef12345678')
    try {
      await h.threads.writeSessionStatus({ chatId: session, agentId: 'wren', turnId: 'blocked' }, status)
      await h.work.setSettled(session, true)
      await h.threads.idleTick()
      expect(await readFile(h.paths.notes, 'utf8')).toContain(`- [ ] Export button: ${status}`)
      expect(proof).not.toHaveBeenCalled()
    } finally { proof.mockRestore() }
  })

  it.each([true, false])('requires the full captured report to land before settling without Confirm, complete=%s', async (complete) => {
    const h = await harness()
    const repo = path.join(h.root, 'manual-commit')
    await mkdir(repo)
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).trim()
    git('init', '-q', '-b', 'main')
    git('config', 'user.name', 'Test')
    git('config', 'user.email', 'test@example.test')
    const file = path.join(repo, 'app.ts')
    const other = path.join(repo, 'other.ts')
    await writeFile(file, 'before\n')
    await writeFile(other, 'before\n')
    git('add', '.')
    git('commit', '-qm', 'Baseline')
    await h.store.updateProject(h.projectId, 'Manor', [repo])
    const session = await threadSession(h, 'single')
    await h.threads.writeSessionStatus({ chatId: session, agentId: '__single__', turnId: 'report' }, 'Done, uncommitted, awaiting Confirm')
    await writeFile(file, 'after\n')
    await writeFile(other, 'after\n')
    const captured = await completion.prepareWorkCompletion([repo], [file, other], [])
    const handoff = (await h.store.workHandoffForTarget(session))!
    await h.store.reachWorkGoal(handoff.id, { type: 'system_note', kind: 'info', text: 'Ready.',
      workGoalHandoffId: handoff.id, goalReport: { result: 'Ready.' }, goalCompletion: captured,
    })
    git('add', ...(complete ? ['.'] : ['app.ts']))
    git('commit', '-qm', 'Committed by the user')
    const hash = git('rev-parse', 'HEAD')
    if (!complete) await h.threads.writeSessionStatus({ chatId: session, agentId: '__single__', turnId: 'partial' }, `Committed as ${hash}. Second file still missing.`)
    await h.work.setSettled(session, true)
    await h.threads.idleTick()
    expect((await h.store.workHandoffForTarget(session))?.goalConfirmedAt).toBeUndefined()
    if (!complete) {
      expect(await readFile(h.paths.notes, 'utf8')).toContain('- [ ] Export button:')
      await expect(readFile(path.join(h.paths.folder, '_archive', 'notes.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      return
    }
    expect(await readFile(h.paths.notes, 'utf8')).not.toContain('Export button:')
    const archived = await readFile(path.join(h.paths.folder, '_archive', 'notes.md'), 'utf8')
    expect(archived).toContain(`[Landed ${hash.slice(0, 12)}]`)
    expect(archived).not.toMatch(/uncommitted|awaiting Confirm/)
  })

  it('Confirm archives only its own status with evidence, even during overlapping turns', async () => {
    const h = await harness()
    const repo = path.join(h.root, 'repo')
    await mkdir(repo)
    const git = (...args: string[]) => execFileSync('git', args, {
      cwd: repo, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' }, stdio: 'ignore',
    })
    git('init', '-q')
    git('config', 'user.name', 'Test')
    git('config', 'user.email', 'test@example.test')
    await writeFile(path.join(repo, 'README.md'), 'Before\n')
    git('add', 'README.md')
    git('commit', '-qm', 'Initial')
    await writeFile(path.join(repo, 'README.md'), 'After\n')
    await h.store.updateProject(h.projectId, 'Manor', [repo])
    const session = await threadSession(h)
    await h.work.useTool({ chatId: h.threadChatId, agentId: '__single__', turnId: 'pdf_proposal' }, {
      assignmentKey: 'pdf', project: h.projectId, title: 'Export button: PDF', task: 'Add PDF export.',
    })
    const others = '- [ ] Export button: PDF: Still working\n- [ ] Hand-written task\n- Release is Friday\n'
    await writeFile(h.paths.notes, `${await readFile(h.paths.notes, 'utf8')}${others}`)
    const turn = { chatId: session, agentId: 'wren', turnId: 'confirm_turn' }
    await h.threads.turnStarted(turn.turnId)
    await h.threads.turnStarted('overlapping_turn')
    await h.threads.writeSessionStatus(turn, 'Ready. CSV export ships.')
    await h.store.appendEvent(session, { type: 'turn_result', agentId: 'wren', turnId: 'edit',
      fileChanges: [{ path: path.join(repo, 'README.md'), status: 'edited', added: 1, removed: 1, edits: [] }],
    })
    const handoff = (await h.store.workHandoffForTarget(session))!
    await h.store.reachWorkGoal(handoff.id, { type: 'system_note', kind: 'info', text: 'Ready.',
      workGoalHandoffId: handoff.id, goalReport: { result: 'CSV export ships.' },
    })
    const ready = (await h.store.workHandoffForTarget(session))!
    const before = await readFile(h.paths.notes, 'utf8')
    await h.work.confirmGoal(ready.id, undefined, ready.version)
    expect((await h.store.workHandoffForTarget(session))?.goalCompletion?.operation).toBe('commit')
    // Confirm alone does not check the row: the commit has not landed yet.
    expect(await readFile(h.paths.notes, 'utf8')).toMatch(/^- \[ \] Export button: Ready\. CSV export ships\./m)
    const confirmed = (await h.store.workHandoffForTarget(session))!
    await h.store.updateWorkCompletion(confirmed.id, { ...confirmed.goalCompletion!, status: 'complete', completedAt: Date.now() })
    await h.threads.completeSessionStatus(session)
    expect(await readFile(h.paths.notes, 'utf8')).not.toContain('Export button: Ready.')
    expect(await readFile(path.join(h.paths.folder, '_archive', 'notes.md'), 'utf8')).toContain('CSV export ships. [Confirmed ')
    // A confirmed commit turn's next status stays checked, even when its text changes.
    await h.threads.writeSessionStatus(turn, 'Confirmed. Committed as abc123.')
    await h.threads.turnEnded({ ...turn, editedPaths: [h.paths.notes] })
    expect(await readFile(h.paths.notes, 'utf8')).not.toMatch(/^- \[x\]/m)
    await h.threads.turnEnded({ chatId: h.looseChatId, agentId: 'smith', turnId: 'overlapping_turn', editedPaths: [] })
    expect(visibleNotes(await readFile(h.paths.notes, 'utf8'))).toContain(others)
    expect(await readFile(h.paths.notes, 'utf8')).not.toContain('Export button: Confirmed.')
    expect(await readFile(path.join(h.paths.folder, '_archive', 'notes.md'), 'utf8')).toContain('- [x] Export button: Confirmed. Committed as abc123. [Confirmed ')
  })

  it('archives an explicit no-code report at report time without waiting for Close', async () => {
    const h = await harness()
    const session = await threadSession(h, 'single')
    const turn = { chatId: session, agentId: '__single__', turnId: 'report_turn' }
    await h.threads.turnStarted(turn.turnId)
    await h.threads.writeSessionStatus(turn, 'Investigation complete, no code change')
    const handoff = (await h.store.workHandoffForTarget(session))!
    await h.store.reachWorkGoal(handoff.id, { type: 'system_note', kind: 'info', text: 'Done.',
      workGoalHandoffId: handoff.id, goalReport: { result: 'Investigation complete. No code change.' },
    })
    await h.threads.goalReached(handoff.id)
    expect((await h.store.workHandoffForTarget(session))?.goalConfirmedAt).toBeUndefined()
    expect(await readFile(h.paths.notes, 'utf8')).not.toContain('Export button:')
    expect(await readFile(path.join(h.paths.folder, '_archive', 'notes.md'), 'utf8')).toContain('[No code change, reported ')
  })

  it('Close archives a no-change report with confirmation evidence', async () => {
    const h = await harness()
    const session = await threadSession(h, 'single')
    const turn = { chatId: session, agentId: '__single__', turnId: 'close_turn' }
    await h.threads.turnStarted(turn.turnId)
    await h.threads.writeSessionStatus(turn, 'Done. No changes needed.')
    const handoff = (await h.store.workHandoffForTarget(session))!
    await h.store.reachWorkGoal(handoff.id, { type: 'system_note', kind: 'info', text: 'Done.',
      workGoalHandoffId: handoff.id, goalReport: { result: 'No changes needed.' },
    })
    const ready = (await h.store.workHandoffForTarget(session))!
    const before = await readFile(h.paths.notes, 'utf8')
    await h.work.confirmGoal(ready.id, undefined, ready.version)
    expect((await h.store.workHandoffForTarget(session))?.goalCompletion?.operation).toBe('none')
    expect(await readFile(h.paths.notes, 'utf8')).not.toContain('Export button:')
    await h.threads.turnEnded({ ...turn, editedPaths: [h.paths.notes] })
    expect(await readFile(h.paths.notes, 'utf8')).not.toContain('Export button:')
    expect(await readFile(path.join(h.paths.folder, '_archive', 'notes.md'), 'utf8')).toContain('- [x] Export button: Done. No changes needed. [Confirmed ')
  })

  it('unchecks a confirmed Session on its next status write after reopening', async () => {
    const h = await harness()
    const session = await threadSession(h)
    const turn = { chatId: session, agentId: 'wren', turnId: 'reopen_turn' }
    await h.threads.turnStarted(turn.turnId)
    await h.threads.writeSessionStatus(turn, 'Ready')
    const handoff = (await h.store.workHandoffForTarget(session))!
    await h.store.reachWorkGoal(handoff.id, { type: 'system_note', kind: 'info', text: 'Ready.', workGoalHandoffId: handoff.id })
    await h.work.confirmGoal(handoff.id)
    expect(await readFile(path.join(h.paths.folder, '_archive', 'notes.md'), 'utf8')).toContain('- [x] Export button: Ready [Confirmed ')
    await h.work.setSettled(session, false)
    await h.threads.writeSessionStatus(turn, 'Working again')
    expect(await readFile(h.paths.notes, 'utf8')).toContain('- [ ] Export button: Working again')
    await h.store.appendEvent(session, { type: 'user_message', text: 'Also add PDF.', mentions: [] })
    expect((await h.store.workHandoffForTarget(session))?.goalConfirmedAt).toBeUndefined()
    await h.threads.writeSessionStatus(turn, 'PDF is open')
    expect(await readFile(h.paths.notes, 'utf8')).toContain('- [ ] Export button: PDF is open')
    await h.threads.turnEnded({ ...turn, editedPaths: [] })
    expect(await readFile(path.join(h.paths.folder, '_archive', 'notes.md'), 'utf8')).not.toContain('PDF is open')
    // Once archived, a fresh status creates an open row without altering its history.
    const reopened = (await h.store.workHandoffForTarget(session))!
    await h.store.reachWorkGoal(reopened.id, { type: 'system_note', kind: 'info', text: 'Ready.', workGoalHandoffId: reopened.id })
    await h.work.confirmGoal(reopened.id)
    const archived = await readFile(path.join(h.paths.folder, '_archive', 'notes.md'), 'utf8')
    await h.store.appendEvent(session, { type: 'user_message', text: 'One more change.', mentions: [] })
    await h.threads.writeSessionStatus(turn, 'One more change is open')
    expect(await readFile(h.paths.notes, 'utf8')).toContain('- [ ] Export button: One more change is open')
    expect(await readFile(path.join(h.paths.folder, '_archive', 'notes.md'), 'utf8')).toBe(archived)
  })

  it.each(['pinned', 'missing-checkout'] as const)('refuses %s Notes before storing confirmation and permits a retry', async (blocked) => {
    const h = await harness()
    const session = await threadSession(h, 'single')
    await h.threads.writeSessionStatus({ chatId: session, agentId: '__single__', turnId: 'ready' }, 'Ready')
    const handoff = (await h.store.workHandoffForTarget(session))!
    await h.store.reachWorkGoal(handoff.id, { type: 'system_note', kind: 'info', text: 'Ready.',
      workGoalHandoffId: handoff.id, goalReport: { result: 'No changes needed.' },
    })
    const ready = (await h.store.workHandoffForTarget(session))!
    const before = await readFile(h.paths.notes, 'utf8')
    if (blocked === 'pinned') await writeFile(h.paths.notes, before.replace('owner: project-thread', 'owner: project-thread\npinned: true'))
    else h.threadOptions.structuredRoot = undefined
    await expect(h.work.confirmGoal(ready.id, undefined, ready.version)).rejects.toThrow(blocked === 'pinned' ? 'pinned' : 'a memory folder')
    expect((await h.store.workHandoffForTarget(session))?.goalConfirmedAt).toBeUndefined()
    expect(await readFile(h.paths.notes, 'utf8')).toContain('- [ ] Export button: Ready')
    if (blocked === 'pinned') await writeFile(h.paths.notes, before)
    else h.threadOptions.structuredRoot = h.root
    await h.work.confirmGoal(ready.id, undefined, ready.version)
    expect((await h.store.workHandoffForTarget(session))?.goalConfirmedAt).toBeDefined()
    expect(await readFile(path.join(h.paths.folder, '_archive', 'notes.md'), 'utf8')).toContain('- [x] Export button: Ready')
  })

  it('keeps a Session settled without Confirm open in Notes', async () => {
    const h = await harness()
    const session = await threadSession(h)
    const turn = { chatId: session, agentId: 'wren', turnId: 'settle_turn' }
    await h.threads.turnStarted(turn.turnId)
    await h.threads.writeSessionStatus(turn, 'Working')
    await h.work.setSettled(session, true)
    await h.threads.turnEnded({ ...turn, editedPaths: [] })
    expect(await readFile(h.paths.notes, 'utf8')).toContain('- [ ] Export button: Working')
    await expect(readFile(path.join(h.paths.folder, '_archive', 'notes.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('archives a completed thread note immediately and keeps preferences and open notes', async () => {
    const h = await harness()
    const owner = { chatId: h.threadChatId, agentId: '__single__', turnId: 'owner_turn' }
    await h.threads.writeFile(owner, { file: 'preferences.md', action: 'add', line: '[x] A standing preference' })
    await h.threads.writeFile(owner, { file: 'notes.md', action: 'add', line: '[ ] Open task' })
    await h.threads.writeFile(owner, { file: 'notes.md', action: 'add', line: '[ ] Export task' })
    const result = await h.threads.writeFile(owner, { file: 'notes.md', action: 'replace', old: '[ ] Export task', line: '[x] Export task' })
    expect(result).toContain('Completed notes moved')
    expect(await readFile(h.paths.notes, 'utf8')).toContain('- [ ] Open task')
    // Only preferences carry a written date; notes rows keep their own markers.
    expect(await readFile(h.paths.notes, 'utf8')).not.toMatch(/\(\d{4}-\d{2}-\d{2}\)/)
    expect(await readFile(h.paths.notes, 'utf8')).not.toContain('Export task')
    const archived = await readFile(path.join(h.paths.folder, '_archive', 'notes.md'), 'utf8')
    expect(archived).toContain('- [x] Export task')
    expect(archived).not.toContain('A standing preference')
    expect(await readFile(h.paths.preferences, 'utf8')).toContain('- [x] A standing preference')
  })

  it('archives accepted hand edits on startup and before the next Session turn', async () => {
    const h = await harness()
    await writeFile(h.paths.notes, '# Notes\n\n- [ ] Open task\n- [x] Finished before boot\n')
    await h.threads.prime()
    expect(await readFile(h.paths.notes, 'utf8')).not.toContain('Finished before boot')
    await writeFile(h.paths.notes, `${await readFile(h.paths.notes, 'utf8')}- [x] Finished by hand\n`)
    await h.threads.turnStarted('next_turn')
    expect(visibleNotes(await readFile(h.paths.notes, 'utf8'))).toBe('# Notes\n\n- [ ] Open task\n')
    const archive = path.join(h.paths.folder, '_archive', 'notes.md')
    const completed = await readFile(archive, 'utf8')
    expect(completed).toContain('- [x] Finished before boot')
    expect(completed).toContain('- [x] Finished by hand')
    await h.threads.turnEnded({ chatId: h.looseChatId, agentId: 'smith', turnId: 'next_turn', editedPaths: [] })
    expect(await readFile(archive, 'utf8')).toBe(completed)
  })

  it('restores unauthorized checked rows before archiving even with overlapping turns', async () => {
    const h = await harness()
    const session = await threadSession(h)
    await writeFile(h.paths.notes, '# Notes\n\n- [ ] Keep task\n')
    await h.threads.prime()
    const writer = { chatId: session, agentId: 'wren', turnId: 'writer' }
    await h.threads.turnStarted('writer')
    await h.threads.turnStarted('reader')
    await writeFile(h.paths.notes, '# Notes\n\n- [x] Keep task\n')
    await h.threads.writeSessionStatus(writer, 'Working')
    await h.threads.turnEnded({ chatId: h.looseChatId, agentId: 'smith', turnId: 'reader', editedPaths: [] })
    const archive = path.join(h.paths.folder, '_archive', 'notes.md')
    await expect(readFile(archive, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await h.threads.turnEnded({ ...writer, editedPaths: [h.paths.notes] })
    const active = await readFile(h.paths.notes, 'utf8')
    expect(active).toContain('- [ ] Keep task')
    expect(active).toContain('- [ ] Export button: Working')
    await expect(readFile(archive, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('archives owner writes during a Session and refuses to adopt its unauthorized edits', async () => {
    const h = await harness()
    const owner = { chatId: h.threadChatId, agentId: '__single__', turnId: 'owner_turn' }
    const writer = { chatId: h.looseChatId, agentId: 'smith', turnId: 'writer' }
    await h.threads.writeFile(owner, { file: 'notes.md', action: 'add', line: '[ ] Keep task' })
    await h.threads.turnStarted(writer.turnId)
    const before = await readFile(h.paths.notes, 'utf8')
    await writeFile(h.paths.notes, before.replace('[ ] Keep task', '[x] Keep task'))
    await expect(h.threads.writeFile(owner, { file: 'notes.md', action: 'add', line: '[x] Owner task' })).rejects.toThrow('pending Session edits')
    const archive = path.join(h.paths.folder, '_archive', 'notes.md')
    await expect(readFile(archive, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await writeFile(h.paths.notes, before)
    const archiver = vi.spyOn(projectFiles, 'archiveCompletedNotes')
    try {
      await h.threads.writeFile(owner, { file: 'notes.md', action: 'add', line: '[x] Owner task' })
      expect(archiver).toHaveBeenCalled()
    } finally { archiver.mockRestore() }
    const trusted = await readFile(h.paths.notes, 'utf8')
    await writeFile(h.paths.notes, trusted.replace('[ ] Keep task', '[x] Keep task'))
    await h.threads.turnEnded({ ...writer, editedPaths: [h.paths.notes] })
    expect(await readFile(h.paths.notes, 'utf8')).toContain('- [ ] Keep task')
    expect(await readFile(archive, 'utf8')).toContain('- [x] Owner task')
    expect(await readFile(archive, 'utf8')).not.toContain('Keep task')
  })

  it('deduplicates completed text across retry timestamps while retaining different Session provenance', async () => {
    const h = await harness()
    const status = '- [x] Export button: Ready [Confirmed 2026-10-17]'
    await archiveCompletedNotes(h.paths, `# Notes\n${sourceNote(status, 'session-one', 1)}\n  Trusted detail\n`)
    await archiveCompletedNotes(h.paths, `# Notes\n${sourceNote(status, 'session-one', 2)}\n  Trusted detail\n`)
    const archive = path.join(h.paths.folder, '_archive', 'notes.md')
    expect((await readFile(archive, 'utf8')).match(/Export button: Ready/g)).toHaveLength(1)
    await archiveCompletedNotes(h.paths, `# Notes\n${sourceNote(status, 'session-two', 3)}\n  Trusted detail\n`)
    expect((await readFile(archive, 'utf8')).match(/Export button: Ready/g)).toHaveLength(2)
  })

  it('keeps active Notes intact on an archive error and does not prevent startup', async () => {
    const h = await harness()
    const owner = { chatId: h.threadChatId, agentId: '__single__', turnId: 'owner_turn' }
    await h.threads.writeFile(owner, { file: 'notes.md', action: 'add', line: '[ ] Keep task' })
    const before = await readFile(h.paths.notes, 'utf8')
    await mkdir(path.join(h.paths.folder, '_archive', 'notes.md'), { recursive: true })
    await expect(h.threads.writeFile(owner, { file: 'notes.md', action: 'replace', old: '[ ] Keep task', line: '[x] Keep task' })).rejects.toMatchObject({ code: 'EISDIR' })
    expect(await readFile(h.paths.notes, 'utf8')).toBe(before)
    const checked = before.replace('[ ] Keep task', '[x] Keep task')
    await writeFile(h.paths.notes, checked)
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      await h.threads.prime()
      expect(warning).toHaveBeenCalled()
      expect(await readFile(h.paths.notes, 'utf8')).toBe(checked)
    } finally { warning.mockRestore() }
  })

  it('redoes the write on a hand edit made while the completed text is being archived', async () => {
    const h = await harness()
    const owner = { chatId: h.threadChatId, agentId: '__single__', turnId: 'owner_turn' }
    await h.threads.writeFile(owner, { file: 'notes.md', action: 'add', line: '[ ] Keep task' })
    const before = await readFile(h.paths.notes, 'utf8')
    const original = projectFiles.archiveCompletedNotes
    const archive = vi.spyOn(projectFiles, 'archiveCompletedNotes').mockImplementationOnce(async (paths, content) => {
      const cleaned = await original(paths, content)
      await writeFile(paths.notes, `${before}- A hand edit\n`)
      return cleaned
    })
    try {
      await h.threads.writeFile(owner, { file: 'notes.md', action: 'replace', old: '[ ] Keep task', line: '[x] Keep task' })
      const notes = await readFile(h.paths.notes, 'utf8')
      expect(notes).toContain('- A hand edit')
      expect(notes).not.toContain('Keep task')
      expect((await readFile(path.join(h.paths.folder, '_archive', 'notes.md'), 'utf8')).match(/- \[x\] Keep task/g)).toHaveLength(1)
    } finally { archive.mockRestore() }
  })
})

describe('sending a follow-up on to a Session', () => {
  /** The user's own message in the thread, and the context of the thread turn it started. */
  const userSays = async (h: Awaited<ReturnType<typeof harness>>, text: string, turnId = 'thread_followup') => {
    const message = await h.store.appendEvent(h.threadChatId, { type: 'user_message', text, mentions: [], images: [{ name: 'clip.png', dataUrl: 'data:image/png;base64,aW1hZ2U=' }] })
    return { message, context: { chatId: h.threadChatId, agentId: '__single__', turnId, mayForward: true as const } }
  }

  it('holds no thread tools once its project is hidden, so a turn still running reopens nothing', async () => {
    const h = await harness()
    const session = await threadSession(h)
    await h.store.setChatSettled(session, true)
    const { context } = await userSays(h, 'The checkmark is still clipped')
    await h.threads.remove(h.projectId)
    await expect(h.threads.forwardToSession(context, { session: 'Export button', message: 'The checkmark is still clipped' }))
      .rejects.toThrow('Only a running project thread turn')
    expect((await h.store.getChat(session))?.settledAt).not.toBeNull()
    expect(h.queued).toEqual([])
    await h.threads.create(h.projectId)
    expect(await h.threads.forwardToSession(context, { session: 'Export button', message: 'The checkmark is still clipped' })).toContain('Sent to “Export button”')
  })

  it('puts the user\'s words in an open Session as their message, with no card, and marks their bubble', async () => {
    const h = await harness()
    const session = await threadSession(h)
    const handoffsBefore = (await h.store.listWorkHandoffs()).length
    const { message, context } = await userSays(h, 'The checkmark is still clipped')
    const note = await h.threads.forwardToSession(context, { session: 'Export button', message: 'The checkmark is still clipped' })
    expect(note).toContain('Sent to “Export button”')
    expect(h.queued).toEqual([{ chatId: session, message: {
      text: 'The checkmark is still clipped',
      forwardedFrom: { threadChatId: h.threadChatId, eventId: message.id },
      images: [{ name: 'clip.png', dataUrl: 'data:image/png;base64,aW1hZ2U=' }],
    } }])
    expect((await h.store.listWorkHandoffs()).length).toBe(handoffsBefore)
    expect((await notes(h, h.threadChatId)).at(-1)).toMatchObject({
      text: 'Sent to “Export button”.', hintFor: message.id,
      sessionForward: { sessionChatId: session, title: 'Export button', turnId: 'thread_followup', agentId: '__single__' },
    })
    // Once per Session for each of their messages, also by id.
    await expect(h.threads.forwardToSession(context, { session, message: 'Again' })).rejects.toThrow('already went to “Export button”')
    expect(h.queued).toHaveLength(1)
  })

  it('reopens a settled Session through Unsettle before the message lands', async () => {
    const h = await harness()
    const session = await threadSession(h)
    await h.work.setSettled(session, true)
    expect((await h.store.getChat(session))?.settledAt).not.toBeNull()
    const { context } = await userSays(h, 'One more thing: the label wraps')
    const note = await h.threads.forwardToSession(context, { session, message: 'One more thing: the label wraps' })
    expect(note).toContain('it was settled and is open again')
    expect((await h.store.getChat(session))?.settledAt).toBeNull()
    expect((await h.store.workHandoffForTarget(session))?.state).toBe('active')
    expect((await notes(h, h.threadChatId)).some((event) => event.workHandoffPhase === 'reopened')).toBe(true)
    expect(h.queued.map((entry) => entry.chatId)).toEqual([session])
  })

  it('refuses a Session that does not exist or belongs to another project', async () => {
    const h = await harness()
    await threadSession(h)
    const { context } = await userSays(h, 'Fix it')
    await expect(h.threads.forwardToSession(context, { session: 'chat_missing', message: 'Fix it' }))
      .rejects.toThrow('No Session this thread started matches "chat_missing". Its Sessions: "Export button"')
    const other = await h.store.createProject('Example App', [])
    const foreign = await h.store.createChat({ kind: 'project', projectId: other.id, title: 'Export button' })
    await expect(h.threads.forwardToSession(context, { session: foreign.id, message: 'Fix it' }))
      .rejects.toThrow('That Session belongs to another project')
    // A Session of this project that the thread did not start is not one of its Sessions either.
    await expect(h.threads.forwardToSession(context, { session: h.looseChatId, message: 'Fix it' }))
      .rejects.toThrow('No Session this thread started matches')
    expect(h.queued).toEqual([])
  })

  it('sends the message the turn runs on, not a newer one still queued behind it', async () => {
    const h = await harness()
    const session = await threadSession(h)
    const running = await h.store.appendEvent(h.threadChatId, { type: 'user_message', text: 'The checkmark is still clipped', mentions: [], dispatchState: 'started' })
    await h.store.appendEvent(h.threadChatId, { type: 'user_message', text: 'And plan the export', mentions: [], dispatchState: 'pending', images: [{ name: 'later.png', dataUrl: 'data:image/png;base64,aW1hZ2U=' }] })
    await h.threads.forwardToSession({ chatId: h.threadChatId, agentId: '__single__', turnId: 'thread_a', mayForward: true }, { session, message: 'The checkmark is still clipped' })
    expect(h.queued[0]?.message).toEqual({ text: 'The checkmark is still clipped', forwardedFrom: { threadChatId: h.threadChatId, eventId: running.id } })
    expect((await notes(h, h.threadChatId)).at(-1)).toMatchObject({ hintFor: running.id })
  })

  it('does not send twice when the receipt failed to save, and writes the receipt on the retry', async () => {
    const h = await harness()
    const session = await threadSession(h)
    const { message, context } = await userSays(h, 'The checkmark is still clipped')
    const append = h.store.appendEvent.bind(h.store)
    let failed = false
    h.store.appendEvent = async (chatId, event) => {
      if (!failed && event.type === 'system_note' && event.sessionForward !== undefined) {
        failed = true
        throw new Error('store blinked')
      }
      return append(chatId, event)
    }
    await expect(h.threads.forwardToSession(context, { session, message: 'The checkmark is still clipped' })).rejects.toThrow('store blinked')
    await h.threads.forwardToSession(context, { session, message: 'The checkmark is still clipped' })
    expect(h.queued).toHaveLength(1)
    expect((await notes(h, h.threadChatId)).filter((event) => event.hintFor === message.id && event.sessionForward !== undefined)).toHaveLength(1)
  })

  it('never forwards from a turn the user did not start, nor from outside the thread', async () => {
    const h = await harness()
    const session = await threadSession(h)
    const { context } = await userSays(h, 'Fix it')
    // A wake for a Session's report or result holds no mayForward on its capability.
    const { mayForward: _mayForward, ...woken } = context
    await expect(h.threads.forwardToSession(woken, { session, message: 'Fix it' })).rejects.toThrow('Only a thread turn that the user')
    await expect(h.threads.forwardToSession({ chatId: session, agentId: 'wren', turnId: 'session_turn', mayForward: true }, { session, message: 'Fix it' }))
      .rejects.toThrow('Only a running project thread turn')
    h.endedTurns.add(context.turnId)
    await expect(h.threads.forwardToSession(context, { session, message: 'Fix it' })).rejects.toThrow('Only a running project thread turn')
    expect(h.queued).toEqual([])
  })

  it('refuses start_work from a thread wake, with no proposal card', async () => {
    const h = await harness()
    const handoffs = (await h.store.listWorkHandoffs()).length
    const sent = h.sent.length
    const events = (await h.store.loadEvents(h.threadChatId)).length
    await expect(h.work.useTool({ chatId: h.threadChatId, agentId: '__single__', turnId: 'thread_wake', noProposal: true }, {
      assignmentKey: 'export', project: h.projectId, title: 'Export button', task: 'Add an export button.',
    })).rejects.toThrow('cannot propose work')
    expect(await h.store.listWorkHandoffs()).toHaveLength(handoffs)
    expect(h.sent.slice(sent)).toEqual([])
    expect(await h.store.loadEvents(h.threadChatId)).toHaveLength(events)
    // The user's own turn still proposes.
    await h.propose('export')
    expect(await h.store.listWorkHandoffs()).toHaveLength(handoffs + 1)
  })
})

describe('DM briefs and reports', () => {
  it('hands an accepted DM brief to the thread, which starts it without a second Accept', async () => {
    const h = await harness()
    const brief = await h.acceptBrief('export')
    const forwarded = (await h.store.listWorkHandoffs()).find((row) => row.id === brief.id)!
    expect(forwarded.forwardedAt).toBeDefined()
    expect(forwarded.forwardAccept).toEqual({ mode: 'house' })
    expect(forwarded.workChatId).toBeNull()
    const wake = h.wakes.at(-1)!
    expect(wake.origin.reason).toBe('brief')
    expect(await wakeText(wake)).toContain(`assignmentKey brief-${brief.id}`)
    // The brief's task is the message's text; everything Manor says around it is the instruction, which ends where the task begins.
    const composed = (await wake.compose())!
    expect(composed.text).toBe(brief.task)
    expect(composed.instruction).toMatch(/^\[Manor\] .*\nTask:\n$/s)
    expect(composed.instruction).not.toContain(brief.task!)
    // The thread's brief turn calls start_work with that key; Manor accepts it at once.
    const card = await h.propose(`brief-${brief.id}`)
    // A second wake for the same brief, queued before the card existed, now has nothing to do.
    expect(await wake.compose()).toBeUndefined()
    await until(() => h.started.length === 1, 'the brief session to start')
    const saved = (await h.store.listWorkHandoffs()).find((row) => row.id === card.id)!
    expect((await h.store.listWorkHandoffs()).find((row) => row.id === brief.id)?.threadHandoffId).toBe(card.id)
    expect(saved.acceptedAt).not.toBeNull()
    // A retry of the DM Accept answers with the thread and starts nothing new.
    expect(await h.work.accept(brief.id, { mode: 'house' })).toBe(h.threadChatId)
    expect(h.started).toHaveLength(1)
  })

  it('never sends the brief card as pending, and starts it on the DM runtime whatever the thread passes', async () => {
    const h = await harness()
    const opus = { driver: 'claude', model: 'claude-opus-5-5', effort: 'xhigh' } as const
    const brief = await h.acceptBrief('export', { mode: 'single', runtime: opus })
    expect(await wakeText(h.wakes.at(-1))).toContain('Pass no provider, model, effort or runtimeReason')
    const from = h.timeline.length
    const result = await h.work.useTool({ chatId: h.threadChatId, agentId: '__single__', turnId: 'thread_brief' }, {
      assignmentKey: `brief-${brief.id}`, project: h.projectId, title: 'Export button', task: 'Add an export button.',
      provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high', runtimeReason: 'small UI change',
    }) as { workChatId: string | null; proposedRuntime?: unknown }
    // The thread reads a started Session, not a proposal of its own runtime.
    expect(result.workChatId).not.toBeNull()
    expect(result.proposedRuntime).toBeUndefined()
    const card = (await h.store.listWorkHandoffs()).find((row) => row.assignmentKey === `brief-${brief.id}`)!
    const sent = h.timeline.slice(from)
    const rows = sent.flatMap((entry) => 'directory' in entry ? entry.directory.filter((row) => row.id === card.id && row.version > 0) : [])
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((row) => row.acceptedAt !== null)).toBe(true)
    // Its receipt draws no card until the row arrives, and the row arrives started.
    expect(sent.some((entry) => 'message' in entry && entry.message.type === 'event' &&
      entry.message.event.type === 'system_note' && entry.message.event.workHandoffId === card.id)).toBe(true)
    const chat = await h.store.getChat(card.workChatId!)
    expect({ mode: chat?.mode, model: chat?.singleOverride?.model, effort: chat?.singleOverride?.effort }).toEqual({ mode: 'single', model: 'claude-opus-5-5', effort: 'xhigh' })
    // With no runtime picked in the DM, the house default wins over the thread's proposal.
    const k = await harness()
    const plain = await k.acceptBrief('plain', { mode: 'single' })
    const started = await k.work.useTool({ chatId: k.threadChatId, agentId: '__single__', turnId: 'thread_plain' }, {
      assignmentKey: `brief-${plain.id}`, project: k.projectId, title: 'Export button', task: 'Add an export button.',
      provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high', runtimeReason: 'small UI change',
    }) as { workChatId: string }
    const house = await k.store.getChat(started.workChatId)
    expect({ model: house?.singleOverride?.model, effort: house?.singleOverride?.effort }).toEqual({ model: 'claude-opus-5-5', effort: 'high' })
  })

  it('sends a brief card that cannot start as pending, with the error after it', async () => {
    const h = await harness()
    const brief = await h.acceptBrief('export')
    // The thread's card cannot start.
    let heldWhileStarting = false
    const accept = vi.spyOn(h.work, 'accept').mockImplementationOnce(async (id) => {
      heldWhileStarting = h.work.isStarting(id)
      throw new Error('Wren is busy.')
    })
    const from = h.timeline.length
    await h.propose(`brief-${brief.id}`)
    accept.mockRestore()
    const card = (await h.store.listWorkHandoffs()).find((row) => row.assignmentKey === `brief-${brief.id}`)!
    expect(card.acceptedAt).toBeNull()
    // Held out of the directory while it tried to start, then sent to clients pending.
    expect(heldWhileStarting).toBe(true)
    expect(h.work.isStarting(card.id)).toBe(false)
    const sent = h.timeline.slice(from)
    expect(sent.some((entry) => 'directory' in entry && entry.directory.some((row) => row.id === card.id && row.acceptedAt === null))).toBe(true)
    const receipt = sent.findIndex((entry) => 'message' in entry && entry.message.type === 'event' &&
      entry.message.event.type === 'system_note' && entry.message.event.workHandoffId === card.id)
    const error = sent.findIndex((entry) => 'message' in entry && entry.message.type === 'event' &&
      entry.message.event.type === 'system_note' && entry.message.event.kind === 'error' && entry.message.event.text.includes('Wren is busy.'))
    expect(receipt).toBeGreaterThanOrEqual(0)
    expect(error).toBeGreaterThan(receipt)
  })

  it('accepts only the card made for the brief, and runs the prompt the user edited', async () => {
    const h = await harness()
    const brief = await h.acceptBrief('export', { mode: 'house', task: 'Add an export button to the toolbar.' })
    expect(await wakeText(h.wakes.at(-1))).toContain('Add an export button to the toolbar.')
    // Another proposal while the brief waits stays a card for the user.
    const other = await h.propose('unrelated', 'Rewrite the settings page.')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect((await h.store.listWorkHandoffs()).find((row) => row.id === other.id)?.acceptedAt).toBeNull()
    // A card that dropped the approved prompt starts with that prompt instead.
    const card = await h.propose(`brief-${brief.id}`, 'Something else entirely.')
    await until(() => h.started.length === 1, 'the brief session to start')
    expect((await h.store.listWorkHandoffs()).find((row) => row.id === card.id)?.task).toBe('Add an export button to the toolbar.')
  })

  it('keeps the approved prompt exact, with thread context only after a blank line', async () => {
    const h = await harness()
    const first = await h.acceptBrief('exact', { mode: 'house', task: 'Create file Report.md' })
    const changed = await h.propose(`brief-${first.id}`, 'Create file Report.md.bak')
    await until(() => h.started.length === 1, 'the first brief session to start')
    expect((await h.store.listWorkHandoffs()).find((row) => row.id === changed.id)?.task).toBe('Create file Report.md')
    const k = await harness()
    const second = await k.acceptBrief('context', { mode: 'house', task: 'Create file Report.md' })
    const withContext = await k.propose(`brief-${second.id}`, 'Create file Report.md\n\nNotes say the report lives in docs/.')
    await until(() => k.started.length === 1, 'the second brief session to start')
    expect((await k.store.listWorkHandoffs()).find((row) => row.id === withContext.id)?.task).toContain('Notes say the report lives in docs/.')
  })

  it('recovers a forwarded brief after a restart', async () => {
    const h = await harness()
    const brief = await h.acceptBrief('export')
    const rebooted = new ProjectThreads(h.threadOptions)
    const wakes = h.wakes.length
    // No card yet: the thread is woken for the brief again, once per missing card.
    await rebooted.recoverBriefs()
    expect(h.wakes).toHaveLength(wakes + 1)
    expect(h.wakes.at(-1)?.origin.reason).toBe('brief')
    // The card exists but was never accepted: recovery accepts it with the stored choices.
    await h.store.reserveWorkHandoff({
      sourceChatId: h.threadChatId, sourceTurnId: 'crashed', assignmentKey: `brief-${brief.id}`, task: 'Add an export button.',
      projectId: h.projectId, projectName: 'Manor', title: 'Export button', leadAgentId: 'wren', leadAgentName: 'Wren',
      supportingAgentIds: [], supportingAgentNames: [],
    })
    await rebooted.recoverBriefs()
    await until(() => h.started.length === 1, 'the recovered session to start')
    expect((await h.store.listWorkHandoffs()).find((row) => row.id === brief.id)?.threadHandoffId).toBeDefined()
    await rebooted.recoverBriefs()
    expect(h.started).toHaveLength(1)
  })

  it('retries a card linked to its brief whose acceptance failed before the restart', async () => {
    const h = await harness()
    const brief = await h.acceptBrief('export')
    const card = await h.store.reserveWorkHandoff({
      sourceChatId: h.threadChatId, sourceTurnId: 'crashed', assignmentKey: `brief-${brief.id}`, task: 'Add an export button.',
      projectId: h.projectId, projectName: 'Manor', title: 'Export button', leadAgentId: 'wren', leadAgentName: 'Wren',
      supportingAgentIds: [], supportingAgentNames: [],
    })
    const failing = new ProjectThreads({ ...h.threadOptions, acceptHandoff: async () => { throw new Error('checkout failed') } })
    await expect(failing.proposed(card.handoff)).rejects.toThrow('checkout failed')
    expect((await h.store.listWorkHandoffs()).find((row) => row.id === brief.id)?.threadHandoffId).toBe(card.handoff.id)
    await new ProjectThreads(h.threadOptions).recoverBriefs()
    await until(() => h.started.length === 1, 'the linked card to start')
  })

  it('carries the DM screenshot and delivered mockup onto the brief, the thread card and the Session kickoff', async () => {
    const h = await harness()
    const dm = await h.store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })
    const screenshot = await h.store.appendEvent(dm.id, { type: 'user_message', text: 'Zo moet het eruit zien.', mentions: [], images: [{ name: 'screen.png', dataUrl: PNG }] })
    const html = '<!doctype html><title>Mockup</title><button>Export</button>'
    const bytes = new TextEncoder().encode(html)
    await h.store.appendEvent(dm.id, { type: 'file_delivery', agentId: 'sage', turnId: 'dm_mock', file: { id: 'file_mock', name: 'mockup.html', mime: 'text/html', size: bytes.byteLength } }, [{ id: 'file_mock', bytes }])
    const result = await h.work.useTool({ chatId: dm.id, agentId: 'sage', turnId: 'dm_attach' }, {
      assignmentKey: 'export', project: h.projectId, title: 'Export button', task: 'Build the export button as in the mockup.', firstExecutor: 'Wren',
      attachments: [`/tmp/scratch/attachments/${screenshot.id}-0.png`, 'mockup.html'],
    })
    expect(result).toMatchObject({ attachments: ['screen.png', 'mockup.html'] })
    const brief = (await h.store.listWorkHandoffs()).find((row) => row.sourceChatId === dm.id)!
    expect(brief.attachments?.map((attachment) => [attachment.name, attachment.kind])).toEqual([['screen.png', 'image'], ['mockup.html', 'file']])
    expect(await h.work.accept(brief.id, { mode: 'house' })).toBe(h.threadChatId)
    // The thread's brief message holds both, and its prompt says they go along by themselves.
    const wake = (await h.wakes.at(-1)!.compose())!
    expect(wake.instruction).toContain('Attachments: screen.png, mockup.html.')
    expect(wake.images).toEqual([{ name: 'screen.png', dataUrl: PNG }])
    expect(wake.files).toEqual([{ name: 'mockup.html', mime: 'text/html', content: html }])
    // The thread's card names none itself and still carries them into the Session.
    const card = await h.propose(`brief-${brief.id}`, 'Build the export button as in the mockup.')
    expect(card.attachments?.map((attachment) => attachment.name)).toEqual(['screen.png', 'mockup.html'])
    await until(() => h.started.length === 1, 'the brief session to start')
    const kickoff = (await h.store.loadEvents(h.started[0]!.chatId)).find((event) => event.type === 'user_message')
    expect(kickoff).toMatchObject({ source: 'work_handoff', images: [{ name: 'screen.png', dataUrl: PNG }], files: [{ name: 'mockup.html', mime: 'text/html', content: html }] })
  })

  it('refuses an attachment the conversation does not hold or no longer has, and a handoff without any stays as it was', async () => {
    const h = await harness()
    const dm = await h.store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })
    await expect(h.work.useTool({ chatId: dm.id, agentId: 'sage', turnId: 'dm_missing' }, {
      assignmentKey: 'export', project: h.projectId, title: 'Export button', task: 'Add an export button.', firstExecutor: 'Wren', attachments: ['nowhere.html'],
    })).rejects.toThrow('Nothing in this conversation matches "nowhere.html"')
    expect(await h.store.listWorkHandoffs()).toHaveLength(0)
    const brief = await h.acceptBrief('plain')
    expect(brief.attachments).toBeUndefined()
    const wake = (await h.wakes.at(-1)!.compose())!
    expect(wake.instruction).not.toContain('Attachments:')
    expect(wake.images).toBeUndefined()
    expect(wake.files).toBeUndefined()
    await h.propose(`brief-${brief.id}`)
    await until(() => h.started.length === 1, 'the brief session to start')
    const kickoff = (await h.store.loadEvents(h.started[0]!.chatId)).find((event) => event.type === 'user_message')
    expect(kickoff).toMatchObject({ source: 'work_handoff' })
    expect(kickoff).not.toHaveProperty('images')
    expect(kickoff).not.toHaveProperty('files')
    // A file gone from its chat before Accept refuses the click, and nothing reaches the thread.
    const elsewhere = await h.store.createChat({ kind: 'project', projectId: h.projectId, title: 'Elsewhere' })
    const shot = await h.store.appendEvent(elsewhere.id, { type: 'user_message', text: 'Zo.', mentions: [], images: [{ name: 'screen.png', dataUrl: PNG }] })
    const { handoff: stranded } = await h.store.reserveWorkHandoff({
      sourceChatId: dm.id, sourceTurnId: 'dm_attached', assignmentKey: 'export', task: 'Add an export button.', authorAgentId: 'sage',
      projectId: h.projectId, projectName: 'Manor', title: 'Export button', leadAgentId: 'wren', leadAgentName: 'Wren',
      supportingAgentIds: [], supportingAgentNames: [],
      attachments: [{ name: 'screen.png', kind: 'image', chatId: elsewhere.id, eventId: shot.id, index: 0 }],
    })
    await h.store.finalizeWorkHandoff(stranded.id, null, { type: 'system_note', kind: 'info', text: 'Proposed' })
    const wakes = h.wakes.length
    await h.store.deleteChat(elsewhere.id)
    await expect(h.work.accept(stranded.id, { mode: 'house' })).rejects.toThrow('"screen.png" is no longer in the conversation it came from.')
    expect((await h.store.listWorkHandoffs()).find((row) => row.id === stranded.id)).toMatchObject({ acceptedAt: null, workChatId: null })
    expect(h.wakes).toHaveLength(wakes)
  })

  it('queues reports for the thread’s next turn and starts none', async () => {
    const h = await harness()
    const dm = await h.store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })
    const context = { chatId: dm.id, agentId: 'sage', turnId: 'dm_turn' }
    const project = (await h.store.getProject(h.projectId))!
    const before = h.wakes.length
    await h.threads.report(context, { project: project.name, kind: 'preference', text: 'No emoji in copy', quote: 'geen emoji' })
    await h.threads.report(context, { project: project.id, kind: 'note', text: 'Export is next' })
    h.endedTurns.add('dm_turn')
    await h.threads.turnEnded({ ...context, editedPaths: [] })
    expect(h.wakes).toHaveLength(before)
    // One report prompt with both lines, in the wording a report wake used.
    const queued = (await h.threads.takeQueued(h.threadChatId, { questions: true, alongside: true }))!
    expect(queued.instruction.match(/Reports for this project/g)).toHaveLength(1)
    expect(queued.instruction).toContain('- Sage (preference): "No emoji in copy", the user said "geen emoji"')
    expect(queued.instruction).toContain('- Sage (note): "Export is next"')
    expect(queued.delivered).toHaveLength(2)
    await expect(h.threads.report(context, { project: project.id, kind: 'note', text: 'Late' })).rejects.toThrow('Only a running turn')
    await expect(h.threads.report({ ...context, turnId: 'other' }, { project: 'Nope', kind: 'note', text: 'x' })).rejects.toThrow('No project thread matches')
  })
})

describe('single owner guard', () => {
  it('undoes only a write the turn demonstrably made to that file', async () => {
    const h = await harness()
    await h.threads.prime()
    const before = await readFile(h.paths.preferences, 'utf8')
    const turn = (turnId: string, shell: string[] = [], editedPaths: string[] = []) =>
      ({ turnId, chatId: h.looseChatId, agentId: 'smith', editedPaths, shellWrites: shell.flatMap((command) => shellWriteDestinations(command, '/home/t')) })
    await writeFile(h.paths.preferences, `${before}- Smith wrote this\n`)
    await h.threads.turnEnded(turn('t1', [], [h.paths.preferences]))
    expect(await readFile(h.paths.preferences, 'utf8')).toBe(before)
    const restored = (await notes(h, h.threadChatId)).find((note) => note.projectFileWrite?.action === 'restore')
    expect(restored?.projectFileWrite?.by).toBe('Smith')
    expect(restored?.text).toBe('Manor restored preferences.md: Smith wrote to it outside the thread.')
    expect((await notes(h, h.threadChatId)).some((note) => note.projectReport?.text === 'Smith wrote this')).toBe(true)
    // The restore waits for the thread's next turn; it starts none.
    expect(h.wakes.filter((wake) => wake.origin.reason !== 'seed')).toHaveLength(0)
    expect((await h.threads.takeQueued(h.threadChatId, { questions: false, alongside: false }))?.instruction).toContain('- Smith (preference): "Smith wrote this"')
    // The user edits by hand; a turn that only ran its tests keeps the edit.
    await writeFile(h.paths.preferences, `${before}- the user wrote this\n`)
    await h.threads.turnEnded(turn('t2', ['pnpm test']))
    expect(await readFile(h.paths.preferences, 'utf8')).toContain('the user wrote this')
    // A shell append that names the file is undone.
    const kept = await readFile(h.paths.preferences, 'utf8')
    await writeFile(h.paths.preferences, `${kept}- Echoed in\n`)
    await h.threads.turnEnded(turn('t3', [`echo "- Echoed in" >> ${h.paths.preferences}`]))
    expect(await readFile(h.paths.preferences, 'utf8')).toBe(kept)
    // The same name in another folder is not this file, the name in its own folder is.
    await writeFile(h.paths.preferences, `${kept}- the user again\n`)
    await h.threads.turnEnded(turn('t4', [
      'cd /tmp/unrelated && echo changed >> preferences.md',
      'echo changed >> ../unrelated/preferences.md',
      `cp ${h.paths.preferences} /tmp/backup.md`,
    ]))
    expect(await readFile(h.paths.preferences, 'utf8')).toContain('the user again')
    const edited = await readFile(h.paths.preferences, 'utf8')
    await writeFile(h.paths.preferences, `${edited}- Smith via cd\n`)
    await h.threads.turnEnded(turn('t5', [`cd ${path.dirname(h.paths.preferences)} && echo "- Smith via cd" >> preferences.md`]))
    expect(await readFile(h.paths.preferences, 'utf8')).toBe(edited)
  })

  it('keeps the baseline while an overlapping turn that wrote the file has not checked yet', async () => {
    const h = await harness()
    await h.threads.prime()
    const before = await readFile(h.paths.preferences, 'utf8')
    await h.threads.turnStarted('writer')
    await h.threads.turnStarted('reader')
    await writeFile(h.paths.preferences, `${before}- Smith wrote this\n`)
    await h.threads.turnEnded({ turnId: 'reader', chatId: h.looseChatId, agentId: 'smith', editedPaths: [] })
    await h.threads.turnEnded({ turnId: 'writer', chatId: h.looseChatId, agentId: 'smith', editedPaths: [h.paths.preferences] })
    expect(await readFile(h.paths.preferences, 'utf8')).toBe(before)
  })

  it('keeps a hand edit made before a turn that then writes the file', async () => {
    const h = await harness()
    await h.threads.prime()
    const before = await readFile(h.paths.preferences, 'utf8')
    await writeFile(h.paths.preferences, `${before}- the user wrote this\n`)
    await h.threads.turnStarted('t1')
    await writeFile(h.paths.preferences, `${before}- the user wrote this\n- Smith wrote this\n`)
    await h.threads.turnEnded({ turnId: 't1', chatId: h.looseChatId, agentId: 'smith', editedPaths: [h.paths.preferences] })
    expect(await readFile(h.paths.preferences, 'utf8')).toBe(`${before}- the user wrote this\n`)
  })
})

describe('permission cards and answers by the user', () => {
  it('leaves a permission card to the user and never lets the thread answer it', async () => {
    const h = await harness()
    const session = await threadSession(h)
    const turn = { chatId: h.threadChatId, agentId: '__single__', turnId: 'thread_turn', mayAnswer: true as const }
    await h.threads.writeFile(turn, { file: 'preferences.md', action: 'add', line: 'Allow once for computer use' })
    h.awaiting[session] = ['permission']
    const wakes = h.wakes.length
    await h.threads.forwardQuestion(session, 'wren', 'permission', [{
      id: 'approval', question: 'Let this agent use your Mac?', optionsOnly: true, options: [{ label: 'Allow once' }, { label: 'Deny' }],
    }])
    expect(h.wakes).toHaveLength(wakes)
    await expect(h.threads.answerFromThread(turn, { requestId: 'permission', answers: { approval: 'Allow once' }, preference: 'Allow once for computer use' }))
      .rejects.toThrow('Only the user answers a permission card')
    await h.threads.recordAnswer(session, 'permission', { approval: 'Allow once' })
    expect(h.wakes).toHaveLength(wakes)
  })

  it('queues the question and their answer when the user answers a session themselves, and drops the question wake', async () => {
    const h = await harness()
    const session = await threadSession(h)
    h.awaiting[session] = ['shape']
    await h.threads.forwardQuestion(session, 'wren', 'shape', [{ id: 'q', question: 'Which shape should buttons use?', options: [{ label: 'Round' }, { label: 'Square' }] }])
    const wakes = h.wakes.length
    h.awaiting[session] = []
    await h.threads.recordAnswer(session, 'shape', { q: 'Always round, in every session' })
    expect(h.wakes).toHaveLength(wakes)
    // The question no longer waits, so its wake has nothing to say and is dropped.
    expect(await h.wakes.at(-1)?.compose()).toBeUndefined()
    const queued = await h.threads.takeQueued(h.threadChatId, { questions: true, alongside: false })
    expect(queued?.instruction).toContain('The user answered a question from the session “Export button” themselves')
    expect(queued?.instruction).toContain('Always round, in every session')
    expect(queued?.instruction).not.toContain('is waiting on a question')
    expect(queued?.questions).toBe(0)
  })
})

describe('preferences budget', () => {
  it('loads the whole file and asks only the thread to consolidate past one screen', () => {
    const long = `# Preferences\n${Array.from({ length: 30 }, (_, index) => `- ${index} ${'A standing requirement. '.repeat(6)}`).join('\n')}\n- Never re-propose fade\n`
    expect(long.length).toBeGreaterThan(PREFERENCES_BUDGET)
    const session = preferencesBlock('Manor', '/tmp/preferences.md', long)
    expect(session).toContain('Never re-propose fade')
    expect(session).not.toContain('one-screen budget')
    expect(preferencesBlock('Manor', '/tmp/preferences.md', long, true)).toContain('one-screen budget')
  })
})

describe('project thread turns', () => {
  async function turns(driver?: import('@manor/contracts').Driver, providerUsage?: () => import('@manor/contracts').ProviderUsage[], workArgs: string[] = []) {
    const { Orchestrator } = await import('../src/orchestrator.js')
    const { interactionMcpAttachment } = await import('../src/mcp/interactionAttachment.js')
    const { createMockDriver } = await import('../src/drivers/mockDriver.js')
    const { recording, scratchFor } = await import('./helpers.js')
    const root = await mkdtemp(path.join(tmpdir(), 'manor-thread-turns-'))
    const store = createMemoryStore({ agents })
    const { projectId, chatId: looseChatId } = await seededChat(store)
    const project = (await store.getProject(projectId))!
    const paths = projectThreadPaths(root, project.name)
    await ensureProjectThreadFiles(paths, project.name)
    await writeFile(paths.preferences, `${await readFile(paths.preferences, 'utf8')}- Corners are always round\n`)
    await writeFile(paths.notes, `${await readFile(paths.notes, 'utf8')}- Export ships next\n`)
    const thread = await store.createChat({ kind: 'project', projectId, mode: 'single', title: project.name })
    await store.setChatOverride(thread.id, '__single__', { driver: 'claude', model: 'claude-opus-5-5', effort: 'high' })
    await store.setProjectThread(projectId, thread.id)
    const seen: import('@manor/contracts').TurnInput[] = []
    // What each turn's capability lets through, in turn order, next to what it sees.
    const grants: { mayAnswer: boolean; mayForward: boolean; mayPropose: boolean | undefined }[] = []
    const work = { server: { id: 'builtin_work', name: 'work', command: '/node', args: workArgs, envKeys: [], description: '', writes: true, effectPolicy: 'trusted' as const, tools: ['start_work'], readOnlyTools: [], schemaChars: 0 }, disabledTools: [] }
    const orchestrator = new Orchestrator({
      agents: () => agents,
      store,
      mcpServers: () => [],
      skills: () => [],
      structuredMemoryRoot: root,
      workMcp: (_chatId, _agent, _turnId, mayPropose = true) => {
        const grant = grants.at(-1)
        if (grant !== undefined) grant.mayPropose = mayPropose
        return work
      },
      ...(providerUsage === undefined ? {} : { providerUsage }),
      interactionMcp: (_chatId, _agent, _turnId, allowAsk, permissions) => {
        grants.push({ mayAnswer: permissions?.mayAnswer === true, mayForward: permissions?.mayForward === true, mayPropose: undefined })
        return interactionMcpAttachment('http://127.0.0.1:1/internal/user-input', 'capability', { allowAsk, ...(permissions ?? {}) })
      },
      resolveDriver: () => recording(driver ?? createMockDriver({ deltaDelayMs: 0 }), seen),
      ensureScratchDir: scratchFor,
      emit: () => undefined,
    })
    const tools = (index: number) => (seen[index]?.mcpServers ?? []).flatMap((attached) => attached.server.tools)
    const fingerprints = async () => (await store.loadEvents(thread.id))
      .flatMap((event) => event.type === 'turn_result' && event.promptFingerprint !== undefined ? [event.promptFingerprint] : [])
    return { orchestrator, seen, store, thread, looseChatId, tools, paths, fingerprints, grants, root }
  }

  it('fingerprints the offered prefix: stable across identical turns and a notes write, new after a tool description change', async () => {
    const entry = path.join(await mkdtemp(path.join(tmpdir(), 'manor-work-entry-')), 'registeredMcp.ts')
    await writeFile(entry, "const tool = { name: 'start_work', description: 'Propose one Work assignment.' }\n")
    const t = await turns(undefined, undefined, [entry, '--broker-url', 'http://127.0.0.1:1/internal/work-tool'])
    await t.orchestrator.submitUserMessage(t.thread.id, 'What is next?')
    await t.orchestrator.submitUserMessage(t.thread.id, 'What is next?')
    await writeFile(t.paths.notes, `${await readFile(t.paths.notes, 'utf8')}- Fingerprint landed\n`)
    await t.orchestrator.submitUserMessage(t.thread.id, 'What is next?')
    await writeFile(entry, "const tool = { name: 'start_work', description: 'Propose one project Work assignment.' }\n")
    await t.orchestrator.submitUserMessage(t.thread.id, 'What is next?')
    const [first, second, afterNotes, afterTool] = await t.fingerprints()
    console.info('[prompt-fingerprint]', JSON.stringify({ first, second, afterNotes, afterTool }, null, 1))
    expect(first?.sessionId).toBeDefined()
    expect(second).toEqual(first)
    // The note travels in the turn's notes block; the prompt itself does not move.
    expect(afterNotes).toEqual(second)
    expect(second?.changed).toBeUndefined()
    expect(t.seen[2]?.volatileBlocks?.find((block) => block.key === 'notes')?.text).toContain('- Fingerprint landed')
    expect(afterTool?.system).toBe(afterNotes?.system)
    expect(afterTool?.tools).not.toBe(afterNotes?.tools)
    expect(afterTool?.changed).toEqual(['tools:work'])
    expect(afterTool?.sessionId).toBe(first?.sessionId)
  })

  it('keeps preferences in the prompt as the session began, and sends a changed file as a replacing block', async () => {
    const t = await turns()
    const original = await readFile(t.paths.preferences, 'utf8')
    const block = (index: number) => t.seen[index]?.volatileBlocks?.find((entry) => entry.key === 'preferences')?.text
    await t.orchestrator.submitUserMessage(t.thread.id, 'What is next?')
    expect(t.seen[0]?.agent.character).toContain('- Corners are always round')
    expect(block(0)).toBeUndefined()
    await writeFile(t.paths.preferences, `${original}- Labels stay one word\n`)
    await t.orchestrator.submitUserMessage(t.thread.id, 'And now?')
    expect(t.seen[1]?.agent.character).toBe(t.seen[0]?.agent.character)
    expect(block(1)).toContain('This version replaces the preferences in your instructions')
    expect(block(1)).toContain('- Labels stay one word')
    await t.orchestrator.submitUserMessage(t.looseChatId, '@Smith look at the labels.')
    expect(t.seen[2]?.agent.character).toContain('- Labels stay one word')
    expect(t.seen[2]?.volatileBlocks?.some((entry) => entry.key === 'preferences') ?? false).toBe(false)
    await writeFile(t.paths.preferences, original)
    await t.orchestrator.submitUserMessage(t.thread.id, 'And after that?')
    expect(t.seen[3]?.agent.character).toBe(t.seen[0]?.agent.character)
    expect(block(3)).toBeUndefined()
  })

  it('freezes project and root feedback indexes, sending only the current replacement on change', async () => {
    const t = await turns()
    const projectIndex = path.join(path.dirname(t.paths.preferences), 'MEMORY.md')
    const rootIndex = path.join(t.root, 'MEMORY.md')
    await writeFile(projectIndex, '- [Original index](original.md): Initial routing\n')
    await writeFile(rootIndex, '- [Original feedback](feedback_original.md): Initial feedback\n')
    const block = (index: number) => t.seen[index]?.volatileBlocks?.find((entry) => entry.key === 'structured-indexes')?.text
    await t.orchestrator.submitUserMessage(t.thread.id, 'What is next?')
    await t.orchestrator.submitUserMessage(t.thread.id, 'And now?')
    const original = t.seen[0]?.agent.character
    expect(original).toContain('Original index')
    expect(original).toContain('Original feedback')
    expect(t.seen[1]?.agent.character).toBe(original)
    expect(block(0)).toBeUndefined()
    expect(block(1)).toBeUndefined()
    await writeFile(projectIndex, '- [Second index](second.md): Changed routing\n')
    await writeFile(rootIndex, '- [Second feedback](feedback_second.md): Changed feedback\n')
    await t.orchestrator.submitUserMessage(t.thread.id, 'Keep going.')
    expect(t.seen[2]?.agent.character).toBe(original)
    expect(block(2)).toContain('replaces all memory routing indexes in your instructions')
    expect(block(2)).toContain('Second index')
    expect(block(2)).toContain('Second feedback')
    await writeFile(projectIndex, '- [Newest index](newest.md): Current routing\n')
    await t.orchestrator.submitUserMessage(t.thread.id, 'Continue.')
    expect(t.seen[3]?.agent.character).toBe(original)
    expect(block(3)).toContain('Newest index')
    expect(block(3)).not.toContain('Second index')
    // A new chat starts from today's copy, even on the same runtime.
    const fresh = await t.store.createChat({ projectId: t.thread.projectId, mode: 'single' })
    await t.orchestrator.submitUserMessage(fresh.id, 'Start here.')
    expect(t.seen[4]?.agent.character).toContain('Newest index')
    expect(block(4)).toBeUndefined()
  })

  it('does not freeze or send index updates with personal memory off, preserving room-owned project context', async () => {
    const t = await turns()
    const index = path.join(path.dirname(t.paths.preferences), 'MEMORY.md')
    await writeFile(index, '- [Original index](original.md): Routing\n')
    await t.orchestrator.submitUserMessage(t.looseChatId, '@Smith read the project.')
    await writeFile(index, '- [Current index](current.md): Routing\n')
    await t.orchestrator.submitUserMessage(t.looseChatId, '@Smith keep going.')
    expect(t.seen[0]?.agent.memoryScope).toBe(false)
    expect(t.seen[1]?.agent.character).toContain('Current index')
    expect(t.seen[1]?.agent.character).not.toContain('Original index')
    expect(t.seen.every((turn) => !turn.volatileBlocks?.some((block) => block.key === 'structured-indexes'))).toBe(true)
  })

  it('starts a replacement for a failed resume with the current routing indexes', async () => {
    const { scripted } = await import('./helpers.js')
    const { RESUME_FAILURE_PREFIX } = await import('../src/drivers/resumeFailure.js')
    let fresh = 0
    const t = await turns(scripted((input) => input.sessionId === undefined
      ? [{ type: 'result', text: 'Answered.', sessionId: `s${++fresh}` }]
      : [{ type: 'error', message: `${RESUME_FAILURE_PREFIX}gone` }], []))
    const index = path.join(path.dirname(t.paths.preferences), 'MEMORY.md')
    await writeFile(index, '- [Original index](original.md): Routing\n')
    await t.orchestrator.submitUserMessage(t.thread.id, 'What is next?')
    await writeFile(index, '- [Current index](current.md): Routing\n')
    await t.orchestrator.submitUserMessage(t.thread.id, 'And now?')
    expect(t.seen[1]?.agent.character).toBe(t.seen[0]?.agent.character)
    const retry = t.seen.at(-1)
    expect(retry?.sessionId).toBeUndefined()
    expect(retry?.agent.character).toContain('Current index')
    expect(retry?.volatileBlocks?.some((block) => block.key === 'structured-indexes')).toBe(false)
  })

  it('restarts the system prompt on the current indexes after live compaction', async () => {
    const { scripted } = await import('./helpers.js')
    const driver = scripted(() => [{ type: 'result', text: 'Answered.', sessionId: 'compact-session', contextTokens: 1_000_000 }], [])
    const compactSession = vi.fn(() => ({
      events: (async function* () { yield { type: 'result' as const, text: '' } })(),
      stop() {},
    }))
    const t = await turns({ ...driver, compactSession })
    const chat = await t.store.createChat({ projectId: t.thread.projectId, mode: 'single' })
    await t.store.setChatOverride(chat.id, '__single__', { driver: 'claude', model: 'claude-opus-5-5', effort: 'high' })
    const index = path.join(path.dirname(t.paths.preferences), 'MEMORY.md')
    await writeFile(index, '- [Original index](original.md): Routing\n')
    await t.orchestrator.submitUserMessage(chat.id, 'What is next?')
    await writeFile(index, '- [Current index](current.md): Routing\n')
    await t.orchestrator.submitUserMessage(chat.id, 'And now?')
    expect(compactSession).toHaveBeenCalledOnce()
    expect(t.seen[1]?.sessionId).toBe('compact-session')
    expect(t.seen[1]?.agent.character).toContain('Current index')
    expect(t.seen[1]?.agent.character).not.toContain('Original index')
    expect(t.seen[1]?.volatileBlocks?.some((block) => block.key === 'structured-indexes') ?? false).toBe(false)
  })

  it('starts a session that replaces a dead one on the current preferences', async () => {
    const { scripted } = await import('./helpers.js')
    const { RESUME_FAILURE_PREFIX } = await import('../src/drivers/resumeFailure.js')
    let fresh = 0
    const driver = scripted((input) => input.sessionId === undefined
      ? [{ type: 'result', text: 'Answered.', sessionId: `s${++fresh}` }]
      : [{ type: 'error', message: `${RESUME_FAILURE_PREFIX}gone` }], [])
    const entry = path.join(await mkdtemp(path.join(tmpdir(), 'manor-work-entry-')), 'registeredMcp.ts')
    await writeFile(entry, "const tool = { description: 'Propose one Work assignment.' }\n")
    const t = await turns(driver, undefined, [entry, '--broker-url', 'http://127.0.0.1:1/internal/work-tool'])
    await t.orchestrator.submitUserMessage(t.thread.id, 'What is next?')
    await writeFile(t.paths.preferences, `${await readFile(t.paths.preferences, 'utf8')}- Labels stay one word\n`)
    await writeFile(entry, "const tool = { description: 'Propose one project Work assignment.' }\n")
    await t.orchestrator.submitUserMessage(t.thread.id, 'And now?')
    const retry = t.seen.at(-1)
    expect(retry?.sessionId).toBeUndefined()
    expect(retry?.agent.character).toContain('- Labels stay one word')
    expect(retry?.volatileBlocks?.some((block) => block.key === 'preferences') ?? false).toBe(false)
    // The dead session's change is not the fresh one's.
    expect((await t.fingerprints()).at(-1)?.changed).toBeUndefined()
  })

  it('keeps the reason a report-back retry resumed on', async () => {
    const { scripted } = await import('./helpers.js')
    const entry = path.join(await mkdtemp(path.join(tmpdir(), 'manor-work-entry-')), 'registeredMcp.ts')
    await writeFile(entry, "const tool = { description: 'Propose one Work assignment.' }\n")
    let calls = 0
    const driver = scripted(() => ++calls === 2
      ? [{ type: 'tool_use', toolCallId: 'read', tool: 'Read' }, { type: 'tool_result', toolCallId: 'read', outcome: 'success' }, { type: 'result', text: '', sessionId: 's1' }]
      : [{ type: 'result', text: 'Answered.', sessionId: 's1' }], [])
    const t = await turns(driver, undefined, [entry, '--broker-url', 'http://127.0.0.1:1/internal/work-tool'])
    await t.orchestrator.submitUserMessage(t.thread.id, 'What is next?')
    await writeFile(entry, "const tool = { description: 'Propose one project Work assignment.' }\n")
    await t.orchestrator.submitUserMessage(t.thread.id, 'Look it up.')
    expect(calls).toBe(3)
    expect((await t.fingerprints()).at(-1)?.changed).toEqual(['tools:work'])
  })

  it('keeps the offered prefix identical across the user turns and wakes of every reason', async () => {
    const t = await turns()
    await t.orchestrator.submitUserMessage(t.thread.id, 'What is next?')
    // A brief wake must leave a card, which the mock does not, so it ends in an error without a result.
    for (const reason of ['report', 'question', 'result'] as const) {
      await t.orchestrator.submitUserMessage(t.thread.id, `[Manor] A ${reason} wake.`, [], { source: 'project_thread', reason })
    }
    await t.orchestrator.submitUserMessage(t.thread.id, 'And after that?')
    const prints = await t.fingerprints()
    console.info('[prompt-fingerprint:wakes]', JSON.stringify(prints.map(({ system, tools }) => ({ system, tools }))))
    expect(prints).toHaveLength(5)
    expect(new Set(prints.map((print) => `${print.system}/${print.tools}`)).size).toBe(1)
  })

  it('gives thread turns their rule, notes and file tool, and every project turn the preferences', async () => {
    const t = await turns()
    await t.orchestrator.submitUserMessage(t.thread.id, 'What is next?')
    expect(t.seen[0]?.agent.name).toBe('Manor')
    expect(t.seen[0]?.agent.character).toContain('[Manor] You are the project thread for')
    expect(t.seen[0]?.agent.character).not.toContain(SESSION_PLAN_RULE)
    expect(t.seen[0]?.agent.character).toContain('Use [ ] for open tasks and replace their row with [x] when completed')
    expect(t.seen[0]?.agent.character).toContain('Manor moves trusted checked rows to _archive/notes.md on idle ticks')
    expect(t.seen[0]?.agent.character).not.toContain('rewritten in place; git keeps the history')
    // Briefs point to cards and notes rows instead of copying what a Session already has.
    expect(t.seen[0]?.agent.character).toContain('by absolute path with a one-line gist')
    expect(t.seen[0]?.agent.character).toContain('never copy preferences into the brief')
    expect(t.seen[0]?.agent.character).not.toContain('carries the relevant preferences and notes')
    expect(handed(t.seen[0])).toContain('- Export ships next')
    expect(handed(t.seen[0])).toContain('- Corners are always round')
    expect(t.tools(0)).toEqual(expect.arrayContaining(['update_project_file', 'answer_session_question', 'start_work', 'send_to_session']))
    expect(t.seen[0]?.agent.character).toContain('call send_to_session')
    expect(handed(t.seen[0])).toContain('[Manor] This thread has started no Sessions yet')
    // A loose session in the same project: preferences whole, with memory off, and no thread tools.
    await t.orchestrator.submitUserMessage(t.looseChatId, '@Smith look at the corners.')
    expect(t.seen[1]?.agent.memoryScope).toBe(false)
    expect(t.seen[1]?.agent.character).toContain('report_to_project, goal_reached learnings or set_session_status is not a memory write')
    expect(handed(t.seen[1])).toContain('[Manor] Project preferences for')
    expect(handed(t.seen[1])).toContain('- Corners are always round')
    expect(handed(t.seen[1])).not.toContain('Export ships next')
    expect(t.tools(1)).not.toContain('update_project_file')
    expect(t.tools(1)).not.toContain('answer_session_question')
    expect(t.tools(1)).not.toContain('send_to_session')
  })

  it('shows the thread the remaining limits when it may propose work, and nobody else', async () => {
    const { mockProviderUsage } = await import('../src/drivers/mockDriver.js')
    const t = await turns(undefined, () => [mockProviderUsage('claude', Date.now()), { provider: 'grok', status: 'unavailable', fetchedAt: Date.now(), windows: [] }])
    await t.orchestrator.submitUserMessage(t.thread.id, 'Tweak the label.')
    expect(t.seen[0]?.contextBlock).toContain('[Manor] Remaining subscription limits now')
    expect(t.seen[0]?.contextBlock).toMatch(/- Claude: 5-hour limit 38% left, resets in 2h 13m; Weekly 69% left, resets in 3d 4h/)
    expect(t.seen[0]?.contextBlock).toContain('- Grok: unavailable')
    expect(t.seen[0]?.agent.character).toContain('Claude is the default provider.')
    // A question wake holds no start_work, so it gets no limits either.
    await t.orchestrator.submitUserMessage(t.thread.id, '[Manor] A question.', [], { source: 'project_thread', reason: 'question' })
    expect(t.seen[1]?.contextBlock ?? '').not.toContain('Remaining subscription limits')
    await t.orchestrator.submitUserMessage(t.looseChatId, '@Smith look at the corners.')
    expect(t.seen[2]?.contextBlock ?? '').not.toContain('Remaining subscription limits')
  })

  it('offers every thread turn the same tools and lets only the right turns use them', async () => {
    const t = await turns()
    const threadTools = ['update_project_file', 'answer_session_question', 'send_to_session', 'start_work']
    await t.orchestrator.submitUserMessage(t.thread.id, 'Tweak the label.')
    for (const reason of ['question', 'report', 'result', 'brief', 'seed'] as const) {
      await t.orchestrator.submitUserMessage(t.thread.id, `[Manor] A ${reason} wake.`, [], { source: 'project_thread', reason })
    }
    // Background work the thread started ending is not the user's message either.
    await t.orchestrator.submitUserMessage(t.thread.id, 'A helper finished.', [], { source: 'background_wake', agentId: '__single__' })
    // A brief wake that leaves no card is retried once, which is a brief turn too.
    expect(t.seen.length).toBeGreaterThanOrEqual(7)
    t.seen.forEach((input, index) => {
      expect(t.tools(index)).toEqual(expect.arrayContaining(threadTools))
      expect(input.agent.character).toContain('call send_to_session')
      expect(input.agent.character).toContain('start_work')
    })
    const [owner, question, report, result, ...rest] = t.grants
    expect(owner).toEqual({ mayAnswer: true, mayForward: true, mayPropose: true })
    expect(question).toEqual({ mayAnswer: true, mayForward: false, mayPropose: false })
    expect(report).toEqual({ mayAnswer: false, mayForward: false, mayPropose: false })
    expect(result).toEqual({ mayAnswer: false, mayForward: false, mayPropose: false })
    // The brief wake (and its retry) proposes; nothing after the user's turn forwards.
    expect(rest.some((grant) => grant.mayPropose)).toBe(true)
    expect(t.grants.slice(1).every((grant) => !grant.mayForward)).toBe(true)
    expect(rest.at(-1)).toEqual({ mayAnswer: false, mayForward: false, mayPropose: false })
  })

  it.each(['native', 'restart'] as const)('routes a forwarded correction into the running Session turn (%s)', async (steering) => {
    const { gated } = await import('./helpers.js')
    const gate = gated()
    const steer = vi.fn(async () => 'accepted' as const)
    const driver: import('@manor/contracts').Driver = {
      startTurn(input) {
        return { ...gate.driver.startTurn(input), ...(steering === 'native' ? { steer } : {}) }
      },
    }
    const t = await turns(driver)
    const session = await t.store.createChat({ kind: 'project', projectId: (await t.store.getChat(t.thread.id))!.projectId!, mode: 'single', title: 'Export button' })
    const first = t.orchestrator.submitUserMessage(session.id, 'Add an export button.')
    await until(() => gate.forChat(session.id).length === 1, 'the running Session turn')
    const turnId = t.orchestrator.activeTurn(session.id)!.turnId
    const forwardedFrom = { threadChatId: t.thread.id, eventId: 'evt_thread_message' }
    const images = [{ name: 'clipped.png', dataUrl: 'data:image/png;base64,aGVsbG8=' }]
    const { finished } = await t.orchestrator.forwardUserMessage(session.id, { text: 'The checkmark is still clipped', forwardedFrom, images })
    const stored = (await t.store.loadEvents(session.id)).find((event) => event.type === 'user_message' && event.text === 'The checkmark is still clipped')
    expect(stored).toMatchObject({ steersTurnId: turnId, forwardedFrom, images })
    expect(stored).not.toHaveProperty('dispatchState')
    expect(stored).not.toHaveProperty('source')
    if (steering === 'native') {
      expect(steer).toHaveBeenCalledExactlyOnceWith(stored)
      expect(gate.forChat(session.id)).toHaveLength(1)
      gate.forChat(session.id)[0]!.finish()
    } else {
      await until(() => gate.forChat(session.id).length === 2, 'the restarted attempt')
      expect(t.orchestrator.activeTurn(session.id)?.turnId).toBe(turnId)
      expect(gate.forChat(session.id)[1]!.input.catchUp).toContainEqual(stored)
      gate.forChat(session.id)[1]!.finish()
    }
    await Promise.all([first, finished])
    expect((await t.store.loadEvents(session.id)).filter((event) => event.type === 'turn_result')).toHaveLength(1)
  })

  it('starts a forwarded message as a new turn after the previous turn finishes', async () => {
    const { gated } = await import('./helpers.js')
    const gate = gated()
    const t = await turns(gate.driver)
    const session = await t.store.createChat({ kind: 'project', projectId: (await t.store.getChat(t.thread.id))!.projectId!, mode: 'single', title: 'Export button' })
    const first = t.orchestrator.submitUserMessage(session.id, 'Add an export button.')
    await until(() => gate.forChat(session.id).length === 1, 'the running Session turn')
    gate.forChat(session.id)[0]!.finish()
    await first
    const forwardedFrom = { threadChatId: t.thread.id, eventId: 'evt_thread_message' }
    const forwarding = t.orchestrator.forwardUserMessage(session.id, { text: 'The checkmark is still clipped', forwardedFrom })
    const { finished } = await forwarding
    const stored = (await t.store.loadEvents(session.id)).find((event) => event.type === 'user_message' && event.text === 'The checkmark is still clipped')
    expect(stored).toMatchObject({ dispatchState: 'started', forwardedFrom })
    expect(stored?.type === 'user_message' && stored.steersTurnId).toBeUndefined()
    await until(() => gate.forChat(session.id).length === 2, 'the forwarded turn')
    const prompt = gate.forChat(session.id)[1]!.input
    expect(prompt.catchUp.at(-1)).toMatchObject({ type: 'user_message', forwardedFrom })
    gate.forChat(session.id)[1]!.finish()
    await Promise.all([first, finished])
  })

  it.each(['saved', 'failed', 'discarded'] as const)('acknowledges a steered forward only after storage, without waiting for driver consumption (%s)', async (storage) => {
    const { gated } = await import('./helpers.js')
    const gate = gated()
    let save!: () => void
    const saving = new Promise<void>((resolve) => { save = resolve })
    let consume!: (delivery: 'accepted') => void
    const steer = vi.fn(() => new Promise<'accepted'>((resolve) => { consume = resolve }))
    const t = await turns({ startTurn(input) { return { ...gate.driver.startTurn(input), steer } } })
    const first = t.orchestrator.submitUserMessage(t.looseChatId, '@Wren Add an export button.')
    await until(() => gate.forChat(t.looseChatId).length === 1, 'the running Session turn')
    const append = t.store.appendEvent.bind(t.store)
    const appendSpy = vi.spyOn(t.store, 'appendEvent').mockImplementation(async (chatId, draft, originals) => {
      if (draft.type === 'user_message' && draft.forwardedFrom !== undefined) {
        await saving
        if (storage !== 'saved') throw new Error('forward storage failed')
      }
      return append(chatId, draft, originals)
    })
    let acknowledged = false
    const forwarding = t.orchestrator.forwardUserMessage(t.looseChatId, {
      text: 'Only change the validation helper.', forwardedFrom: { threadChatId: t.thread.id, eventId: 'evt_source' },
    }).then((receipt) => { acknowledged = true; return receipt })
    await until(() => appendSpy.mock.calls.some(([, draft]) => draft.type === 'user_message' && draft.forwardedFrom !== undefined), 'the forwarded storage write')
    expect(acknowledged).toBe(false)
    expect(steer).not.toHaveBeenCalled()
    if (storage === 'discarded') t.orchestrator.discard(t.looseChatId)
    save()
    if (storage !== 'saved') {
      await expect(forwarding).rejects.toThrow(storage === 'failed' ? 'forward storage failed' : 'The Session did not take the message.')
      expect(acknowledged).toBe(false)
      expect(steer).not.toHaveBeenCalled()
      gate.forChat(t.looseChatId)[0]!.finish()
      await first
      appendSpy.mockRestore()
      return
    }
    const { finished } = await forwarding
    expect((await t.store.loadEvents(t.looseChatId)).some((event) => event.type === 'user_message' && event.forwardedFrom !== undefined)).toBe(true)
    await until(() => steer.mock.calls.length === 1, 'driver delivery')
    expect(acknowledged).toBe(true)
    consume('accepted')
    gate.forChat(t.looseChatId)[0]!.finish()
    await Promise.all([first, finished])
    appendSpy.mockRestore()
  })
})

describe('waiting thread wakes', () => {
  /** A thread on the real orchestrator queue, wired as the service wires it, on held turns. */
  async function wired() {
    const { Orchestrator } = await import('../src/orchestrator.js')
    const { interactionMcpAttachment } = await import('../src/mcp/interactionAttachment.js')
    const { gated, scratchFor } = await import('./helpers.js')
    const gate = gated()
    const root = await mkdtemp(path.join(tmpdir(), 'manor-thread-queue-'))
    const store = createMemoryStore({ agents })
    const { projectId } = await seededChat(store)
    const awaiting: Record<string, string[]> = {}
    /** `mayAnswer` of every turn's capability, in turn order. */
    const mayAnswer: boolean[] = []
    let threads!: ProjectThreads
    const orchestrator = new Orchestrator({
      agents: () => agents,
      store,
      mcpServers: () => [],
      skills: () => [],
      structuredMemoryRoot: root,
      interactionMcp: (_chatId, _agent, _turnId, allowAsk, permissions) => {
        mayAnswer.push(permissions?.mayAnswer === true)
        return interactionMcpAttachment('http://127.0.0.1:1/internal/user-input', 'capability', { allowAsk, ...(permissions ?? {}) })
      },
      resolveDriver: () => gate.driver,
      ensureScratchDir: scratchFor,
      emit: () => undefined,
      projectThreadTurns: {
        started: async () => undefined,
        ended: async () => undefined,
        queued: (chatId, questions) => threads.takeQueued(chatId, { questions, alongside: true }),
      },
    })
    const work = new WorkModule({
      store,
      agents: () => agents,
      orchestrator: {
        isActiveTurn: () => true,
        startStoredWorkHandoff: async () => undefined,
        discard: () => undefined,
        stopChat: () => undefined,
        resumeChat: () => undefined,
        submitUserMessage: async () => undefined,
        runStoredUserMessage: async () => undefined,
        runExclusive: <T>(_chatId: string, fn: () => Promise<T>) => fn(),
      },
      broadcast: () => undefined,
      broadcastDirectory: async () => undefined,
    })
    const boot = () => new ProjectThreads({
      store,
      structuredRoot: root,
      agentName: (id) => agents.find((agent) => agent.id === id)?.name ?? id,
      emit: () => undefined,
      broadcastDirectory: async () => undefined,
      wake: (chatId, origin, compose) => { void orchestrator.wakeProjectThread(chatId, origin, compose) },
      questionSettleMs: 0,
      answerQuestion: async () => false,
      awaitingInput: () => awaiting,
      isActiveTurn: () => true,
      acceptHandoff: (id, options) => work.accept(id, options),
      reopenSession: async () => undefined,
      acceptInSession: async () => undefined,
    })
    threads = boot()
    const thread = await threads.create(projectId)
    const turns = () => gate.forChat(thread)
    // The seed turn runs first; every count below starts after it.
    await until(() => turns().length === 1, 'the seed turn')
    turns()[0]!.finish()
    await orchestrator.runExclusive(thread, async () => undefined)
    await work.useTool({ chatId: thread, agentId: '__single__', turnId: 'thread_card' }, {
      assignmentKey: 'export', project: projectId, title: 'Export button', task: 'Add an export button.',
    })
    const card = (await store.listWorkHandoffs()).find((row) => row.sourceChatId === thread)!
    const session = await work.accept(card.id, { mode: 'house' })
    const dm = await store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })
    let reports = 0
    return {
      orchestrator, store, gate, thread, session, awaiting, mayAnswer, turns,
      threads: () => threads,
      /** A process restart: a new owner over the same store, nothing carried in memory. */
      restart: () => { threads = boot() },
      report: (text: string) => threads.report({ chatId: dm.id, agentId: 'sage', turnId: `dm_${++reports}` }, { project: projectId, kind: 'note', text }),
      ask: (requestId: string, question: string) => {
        awaiting[session] = [...awaiting[session] ?? [], requestId]
        return threads.forwardQuestion(session, 'wren', requestId, [{ id: 'q', question, options: [{ label: 'Yes' }, { label: 'No' }] }])
      },
      /** Waits for the next held thread turn and returns it. */
      next: async (count: number) => {
        await until(() => turns().length === count, `thread turn ${count}`)
        return turns()[count - 1]!
      },
      idle: () => orchestrator.runExclusive(thread, async () => undefined),
    }
  }

  const said = (input: import('@manor/contracts').TurnInput) =>
    input.catchUp.flatMap((event) => event.type === 'user_message' ? [modelTextOf(event)] : []).join('\n')

  it('stores a forwarded brief\'s attachments on the thread message its turn runs on', async () => {
    const w = await wired()
    const dm = await w.store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })
    const shot = await w.store.appendEvent(dm.id, { type: 'user_message', text: 'Zo.', mentions: [], images: [{ name: 'screen.png', dataUrl: PNG }] })
    const bytes = new TextEncoder().encode('<p>mockup</p>')
    await w.store.appendEvent(dm.id, { type: 'file_delivery', agentId: 'sage', turnId: 'dm_mock', file: { id: 'file_mock', name: 'mockup.html', mime: 'text/html', size: bytes.byteLength } }, [{ id: 'file_mock', bytes }])
    const project = (await w.store.getChat(w.thread))!.projectId!
    const { handoff } = await w.store.reserveWorkHandoff({
      sourceChatId: dm.id, sourceTurnId: 'dm_brief', assignmentKey: 'export', task: 'Build it.', authorAgentId: 'sage',
      projectId: project, projectName: 'Project', title: 'Export button', leadAgentId: 'wren', leadAgentName: 'Wren',
      supportingAgentIds: [], supportingAgentNames: [],
      attachments: [
        { name: 'screen.png', kind: 'image', chatId: dm.id, eventId: shot.id, index: 0 },
        { name: 'mockup.html', kind: 'file', chatId: dm.id, eventId: (await w.store.loadEvents(dm.id)).at(-1)!.id },
      ],
    })
    expect(await w.threads().forwardBrief(handoff, { mode: 'house' })).toBe(true)
    const turn = await w.next(2)
    const brief = turn.input.catchUp.at(-1)
    expect(brief).toMatchObject({ source: 'project_thread', threadReason: 'brief', images: [{ name: 'screen.png', dataUrl: PNG }], files: [{ name: 'mockup.html', content: '<p>mockup</p>' }] })
    // The thread's model reads the picture from disk like any attached image.
    expect(turn.input.imagePaths).toHaveLength(1)
    turn.finish()
  })

  it('lets a report wait for the user\'s next message, which carries it once', async () => {
    const w = await wired()
    await w.report('Export is next')
    await w.idle()
    expect(w.turns()).toHaveLength(1)
    const sent = w.orchestrator.submitUserMessage(w.thread, 'What is next?')
    const turn = await w.next(2)
    expect(said(turn.input)).toContain('What is next?')
    expect(said(turn.input)).toContain('- Sage (note): "Export is next"')
    expect(turn.input.catchUp.at(-1)).toMatchObject({ source: 'project_thread', threadDelivered: [expect.any(String)] })
    turn.finish()
    await sent
    const again = w.orchestrator.submitUserMessage(w.thread, 'And then?')
    const later = await w.next(3)
    expect(said(later.input)).not.toContain('Export is next')
    later.finish()
    await again
  })

  it('keeps the user\'s message the request when a waiting row rides after it', async () => {
    const w = await wired()
    await w.report('Export is next')
    // No desktop browser here, so a targeted @browser refuses the turn instead of running it.
    const sent = w.orchestrator.submitUserMessage(w.thread, '@browser Check the export page.').catch(() => undefined)
    const refused = async () => (await w.store.loadEvents(w.thread)).some((event) => event.type === 'system_note' && event.text.includes('@browser is unavailable'))
    let done = false
    void sent.then(() => { done = true })
    await until(() => done || w.turns().length === 2, 'the turn to run or be refused')
    w.turns()[1]?.finish()
    await sent
    expect(await refused()).toBe(true)
    expect(w.turns()).toHaveLength(1)
  })

  it('wakes at once for a Session question, carrying what waited, and adds no turn for reports while it runs', async () => {
    const w = await wired()
    await w.report('Export is next')
    await w.report('Import comes after')
    await w.idle()
    expect(w.turns()).toHaveLength(1)
    await w.ask('request_1', 'CSV or PDF?')
    const turn = await w.next(2)
    expect(said(turn.input)).toContain('Export is next')
    expect(said(turn.input)).toContain('Import comes after')
    expect(said(turn.input)).toContain('is waiting on a question from Wren (requestId request_1)')
    // The question grants the answer, as before; nothing that waited adds to it.
    expect(w.mayAnswer.at(-1)).toBe(true)
    await w.report('Arrived while the thread ran')
    await w.report('This one too')
    turn.finish()
    await w.idle()
    expect(w.turns()).toHaveLength(2)
    const queued = await w.threads().takeQueued(w.thread, { questions: true, alongside: true })
    expect(queued?.delivered).toHaveLength(2)
  })

  it('folds live questions into one wake and preserves later questions across manual steering', async () => {
    const w = await wired()
    const first = w.orchestrator.submitUserMessage(w.thread, 'Plan the week.')
    const running = await w.next(2)
    await w.ask('request_1', 'CSV or PDF?')
    await w.ask('request_2', 'One button or two?')
    running.finish()
    await first
    const wake = await w.next(3)
    expect(said(wake.input)).toContain('request_1')
    expect(said(wake.input)).toContain('request_2')
    wake.finish()
    await w.idle()
    expect(w.turns()).toHaveLength(3)
    // A manual addition steers; a later Session question still gets its own wake.
    const busy = w.orchestrator.submitUserMessage(w.thread, 'Check the export.')
    await w.next(4)
    const turnId = w.orchestrator.activeTurn(w.thread)?.turnId
    const steering = w.orchestrator.submitUserMessage(w.thread, 'Also the import.')
    const owner = await w.next(5)
    expect(w.orchestrator.activeTurn(w.thread)?.turnId).toBe(turnId)
    expect(said(owner.input)).toContain('Also the import.')
    await w.ask('request_3', 'Keep the old export?')
    owner.finish()
    await Promise.all([busy, steering])
    const laterQuestion = await w.next(6)
    expect(said(laterQuestion.input)).toContain('request_3')
    await w.report('Arrived during that turn')
    laterQuestion.finish()
    await w.idle()
    expect(w.turns()).toHaveLength(6)
  })

  it('delivers what waited exactly once after a restart', async () => {
    const w = await wired()
    await w.report('Export is next')
    await w.report('Import comes after')
    w.restart()
    const sent = w.orchestrator.submitUserMessage(w.thread, 'Where are we?')
    const turn = await w.next(2)
    expect(said(turn.input)).toContain('Export is next')
    expect(said(turn.input)).toContain('Import comes after')
    turn.finish()
    await sent
    w.restart()
    expect(await w.threads().takeQueued(w.thread, { questions: true, alongside: true })).toBeUndefined()
    const again = w.orchestrator.submitUserMessage(w.thread, 'And now?')
    const later = await w.next(3)
    expect(said(later.input)).not.toContain('Export is next')
    later.finish()
    await again
  })
})

describe('the thread\'s file writes and their Undo', () => {
  const turn = (h: Awaited<ReturnType<typeof harness>>) => ({ chatId: h.threadChatId, agentId: '__single__', turnId: 'thread_write' })
  const listCard = async (h: Awaited<ReturnType<typeof harness>>, file: string) => {
    await writeFile(path.join(h.paths.folder, file), '**Decision:**\n- Corners are round.\n\n**Stop:** Ask the user.\n')
    await writeFile(h.paths.index, `${await readFile(h.paths.index, 'utf8')}- [Corners](${file}): Corner radius.\n`)
    return path.join(h.paths.folder, file)
  }
  /** The newest write the thread recorded, which carries what Undo needs. */
  const lastWrite = async (h: Awaited<ReturnType<typeof harness>>) => {
    const write = (await notes(h, h.threadChatId)).flatMap((note) => note.projectFileWrite ?? []).at(-1)
    if (write === undefined) throw new Error('no write recorded')
    return write
  }

  it('routes each write by its file, plain notes included', async () => {
    const h = await harness()
    const card = await listCard(h, 'project_client_corners.md')
    await h.threads.writeFile(turn(h), { file: 'preferences.md', action: 'add', line: 'Corners are round' })
    await h.threads.writeFile(turn(h), { file: 'notes.md', action: 'add', line: 'Launch is Friday' })
    await h.threads.writeFile(turn(h), { file: 'project_client_corners.md', action: 'add', line: 'Print keeps square corners' })
    expect(await readFile(h.paths.preferences, 'utf8')).toContain('- Corners are round')
    expect(await readFile(h.paths.notes, 'utf8')).toContain('- Launch is Friday')
    expect(await readFile(card, 'utf8')).toContain('- Print keeps square corners')
    expect((await notes(h, h.threadChatId)).flatMap((note) => note.projectFileWrite?.file ?? []))
      .toEqual(['preferences.md', 'notes.md', 'project_client_corners.md'])
  })

  it('takes back an add, a replace and a remove', async () => {
    const h = await harness()
    await h.threads.writeFile(turn(h), { file: 'preferences.md', action: 'add', line: 'Corners are round' })
    expect(await h.threads.undoWrite(h.threadChatId, await lastWrite(h))).toBeUndefined()
    expect(await readFile(h.paths.preferences, 'utf8')).not.toContain('Corners are round')

    await h.threads.writeFile(turn(h), { file: 'notes.md', action: 'add', line: '[ ] Round the buttons' })
    await h.threads.writeFile(turn(h), { file: 'notes.md', action: 'replace', old: '[ ] Round the buttons', line: '[ ] Round the cards' })
    expect(await h.threads.undoWrite(h.threadChatId, await lastWrite(h))).toBeUndefined()
    expect(await readFile(h.paths.notes, 'utf8')).toContain('- [ ] Round the buttons')
    expect(await readFile(h.paths.notes, 'utf8')).not.toContain('Round the cards')

    await h.threads.writeFile(turn(h), { file: 'notes.md', action: 'remove', old: '[ ] Round the buttons' })
    expect(await h.threads.undoWrite(h.threadChatId, await lastWrite(h))).toBeUndefined()
    expect(await readFile(h.paths.notes, 'utf8')).toContain('- [ ] Round the buttons')
  })

  it('takes back a dated line on a card', async () => {
    const h = await harness()
    const card = await listCard(h, 'project_client_corners.md')
    await h.threads.writeFile(turn(h), { file: 'project_client_corners.md', action: 'add', line: 'Print keeps square corners' })
    expect((await lastWrite(h)).writeId).toBeDefined()
    expect(await h.threads.undoWrite(h.threadChatId, await lastWrite(h))).toBeUndefined()
    expect(await readFile(card, 'utf8')).not.toContain('Print keeps square corners')
  })

  it('puts a removed Session row back with its marker', async () => {
    const h = await harness()
    const row = '- [ ] Round the buttons <!-- manor-note abc12345 -->'
    await writeFile(h.paths.notes, `${await readFile(h.paths.notes, 'utf8')}${row}\n`)
    await h.threads.writeFile(turn(h), { file: 'notes.md', action: 'remove', old: '[ ] Round the buttons' })
    expect(await lastWrite(h)).toMatchObject({ old: '[ ] Round the buttons', noteId: 'abc12345' })
    expect(await h.threads.undoWrite(h.threadChatId, await lastWrite(h))).toBeUndefined()
    expect(await readFile(h.paths.notes, 'utf8')).toContain(row)
  })

  it('offers no Undo for a checked row that left for the archive', async () => {
    const h = await harness()
    await h.threads.writeFile(turn(h), { file: 'notes.md', action: 'add', line: '[ ] Round the buttons' })
    await h.threads.writeFile(turn(h), { file: 'notes.md', action: 'replace', old: '[ ] Round the buttons', line: '[x] Round the buttons' })
    expect((await lastWrite(h)).writeId).toBeUndefined()
  })

  it('refuses after a hand edit of the line, and matches a preference only with its own date', async () => {
    const h = await harness()
    await h.threads.writeFile(turn(h), { file: 'preferences.md', action: 'add', line: 'Corners are round' })
    const edited = await lastWrite(h)
    await writeFile(h.paths.preferences, (await readFile(h.paths.preferences, 'utf8')).replace('Corners are round', 'Corners are square'))
    expect(await h.threads.undoWrite(h.threadChatId, edited)).toContain('Nothing was undone')
    expect(await readFile(h.paths.preferences, 'utf8')).toContain('Corners are square')

    await h.threads.writeFile(turn(h), { file: 'preferences.md', action: 'add', line: 'Buttons are blue' })
    const dated = await lastWrite(h)
    await writeFile(h.paths.preferences, (await readFile(h.paths.preferences, 'utf8')).replace(`Buttons are blue (${localDate(new Date())})`, 'Buttons are blue (2020-01-01)'))
    expect(await h.threads.undoWrite(h.threadChatId, dated)).toContain('Nothing was undone')
    expect(await readFile(h.paths.preferences, 'utf8')).toContain('- Buttons are blue (2020-01-01)')
  })

  it('redoes a write on the file as a hand edit left it', async () => {
    const h = await harness()
    await h.threads.writeFile(turn(h), { file: 'preferences.md', action: 'add', line: 'First rule' })
    const original = projectFiles.writeThreadFile
    let raced = false
    const spy = vi.spyOn(projectFiles, 'writeThreadFile').mockImplementation(async (file, content, expected) => {
      if (file === h.paths.preferences && !raced) {
        raced = true
        // The user types a line between the thread's read and its rename.
        await writeFile(file, `${await readFile(file, 'utf8')}- Typed by hand\n`)
      }
      return original(file, content, expected)
    })
    try {
      await h.threads.writeFile(turn(h), { file: 'preferences.md', action: 'add', line: 'Second rule' })
    } finally {
      spy.mockRestore()
    }
    const content = await readFile(h.paths.preferences, 'utf8')
    expect(content).toContain('- Typed by hand')
    expect(content).toContain('- Second rule')
  })
})

describe('one Notes row per thread proposal', () => {
  const owner = (h: Awaited<ReturnType<typeof harness>>) => ({ chatId: h.threadChatId, agentId: '__single__', turnId: 'owner' })
  const taskRows = async (h: Awaited<ReturnType<typeof harness>>) =>
    (await readFile(h.paths.notes, 'utf8')).split('\n').filter((row) => /^- \[[ xX]\] /.test(row))
  const archive = (h: Awaited<ReturnType<typeof harness>>) => readFile(path.join(h.paths.folder, '_archive', 'notes.md'), 'utf8')

  it('writes one marked row at start_work and keeps it through a revision, Accept and the Session status', async () => {
    const h = await harness()
    const first = await h.propose('export')
    expect(await taskRows(h)).toEqual([`- [ ] Export button: proposed <!-- manor-note ${first.id} -->`])
    // A newer version takes the row over instead of adding a second one.
    await h.work.useTool({ chatId: h.threadChatId, agentId: '__single__', turnId: 'thread_export_v2' }, {
      assignmentKey: 'export', project: h.projectId, title: 'Export button', task: 'Add an export button, v2.', firstExecutor: 'Wren',
    })
    const second = (await h.store.listWorkHandoffs()).find((row) => row.supersededById === undefined && row.assignmentKey === 'export')!
    expect(second.id).not.toBe(first.id)
    expect((await taskRows(h)).map((row) => [noteText(row), noteHandoff(row)])).toEqual([['- [ ] Export button: proposed', second.id]])
    const session = await h.work.accept(second.id, { mode: 'house' })
    await h.threads.idleTick()
    expect((await taskRows(h)).map(noteText)).toEqual(['- [ ] Export button: accepted'])
    await h.threads.writeSessionStatus({ chatId: session, agentId: 'wren', turnId: 'status' }, 'CSV export ships')
    const rows = await taskRows(h)
    expect(rows.map(noteText)).toEqual(['- [ ] Export button: CSV export ships'])
    expect(noteHandoff(rows[0]!)).toBe(second.id)
  })

  it('checks the row off with the reason on Reject, and archives it', async () => {
    const h = await harness()
    const handoff = await h.propose('export')
    await h.work.reject(handoff.id)
    await h.threads.idleTick()
    expect(await taskRows(h)).toEqual([])
    expect(await archive(h)).toContain(`- [x] Export button: proposed [Rejected before work started, ${new Date().toISOString().slice(0, 10)}]`)
  })

  it('closes the row of a settled Session whose commit landed on main', async () => {
    const h = await harness()
    const repo = path.join(h.root, 'repo')
    await mkdir(repo)
    const git = (...args: string[]) => execFileSync('git', args, {
      cwd: repo, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' }, encoding: 'utf8',
    }).trim()
    git('init', '-q', '-b', 'main')
    git('config', 'user.name', 'Test')
    git('config', 'user.email', 'test@example.test')
    await writeFile(path.join(repo, 'app.txt'), 'Before\n')
    git('add', 'app.txt')
    git('commit', '-qm', 'Initial')
    await writeFile(path.join(repo, 'app.txt'), 'After\n')
    git('commit', '-qam', 'Export button')
    const commit = git('rev-parse', 'HEAD')
    await h.store.updateProject(h.projectId, 'Manor', [repo])
    const handoff = await h.propose('export')
    const session = await h.work.accept(handoff.id, { mode: 'house' })
    await h.threads.writeSessionStatus({ chatId: session, agentId: 'wren', turnId: 'status' }, `Committed ${commit.slice(0, 12)}.`)
    await h.threads.idleTick()
    expect(await taskRows(h)).toHaveLength(1)
    await h.work.setSettled(session, true)
    await h.threads.idleTick()
    expect(await taskRows(h)).toEqual([])
    expect(await archive(h)).toContain(`[Landed ${commit.slice(0, 12)}]`)
  })

  it('refuses a thread row for an open Session by its title, and allows it once that Session is closed', async () => {
    const h = await harness()
    const handoff = await h.propose('export')
    await expect(h.threads.writeFile(owner(h), { file: 'notes.md', action: 'add', line: '[ ] Export button: proposed, awaiting Accept' }))
      .rejects.toThrow('Manor already keeps the notes.md row for the Session “Export button”')
    // Another subject that only shares the first word is not that Session's row.
    await h.threads.writeFile(owner(h), { file: 'notes.md', action: 'add', line: '[ ] Export buttons need icons' })
    await h.work.reject(handoff.id)
    await h.threads.writeFile(owner(h), { file: 'notes.md', action: 'add', line: 'Export button: dropped for now' })
    expect(await readFile(h.paths.notes, 'utf8')).toContain('- Export button: dropped for now')
    expect(await archive(h)).toContain('- [x] Export button: proposed [Rejected before work started')
  })
})
