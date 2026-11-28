import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { type AgentConfig, type CheckoutRequest, type GoalCommit, type ServerMessage, type ThreadEvent } from '@manor/contracts'
import { afterEach, vi } from 'vitest'
import { createMemoryStore } from '../src/stores/memoryStore.js'
import { WorkModule, type WorkOrigin } from '../src/workModule.js'
import { prepareWorkCompletion } from '../src/workCompletion.js'
import { captureTurnTree, diffTurnTrees } from '../src/turnFileSnapshots.js'
import { sage, seededChat, smith } from './helpers.js'

export const lead: AgentConfig = { ...sage, mentionAllowlist: ['smith'] }
export const context = { chatId: '', agentId: 'sage', turnId: 'turn_1' }

export async function harness(kind: 'dm' | 'group' = 'dm', options: {
  agents?: readonly AgentConfig[]
  active?: boolean
  outcome?: () => Promise<string | undefined>
  prepareCheckout?: (chatId: string, checkout: CheckoutRequest, accept: () => Promise<void>) => Promise<void>
  startError?: Error
  directoryError?: Error
  /** Runs between reading a directory and delivering it, like the Git lookups do. */
  beforeDelivery?: () => Promise<void>
  writeCommitMessage?: (chatId: string, patch: string) => Promise<string | undefined>
  awaitingInput?: () => Record<string, string[]>
} = {}) {
  const agents = options.agents ?? [lead, smith]
  const store = createMemoryStore({ agents })
  const { projectId } = await seededChat(store)
  const source = await store.createChat({
    kind,
    memberIds: kind === 'dm' ? ['sage'] : ['sage', 'smith'],
    title: kind === 'dm' ? 'Sage' : 'Launch room',
  })
  const started: { chatId: string; text: string; origin: WorkOrigin }[] = []
  const discarded: string[] = []
  const stopped: string[] = []
  const resumed: string[] = []
  const sent: ServerMessage[] = []
  let directories = 0
  /** Each broadcast directory, as the settle stamp of every chat in it. */
  const directoryStates: Map<string, number | null>[] = []
  /** Chats a test marks as still running something, so a quiet re-settle must wait. */
  const busy = new Set<string>()
  const orchestrator = {
    isActiveTurn: () => options.active ?? true,
    isIdle: (chatId: string) => !busy.has(chatId),
    startStoredWorkHandoff: async (chatId: string, text: string, origin: WorkOrigin) => {
      started.push({ chatId, text, origin })
      if (options.startError !== undefined) throw options.startError
    },
    discard: (chatId: string) => { discarded.push(chatId) },
    stopChat: (chatId: string) => { stopped.push(chatId) },
    resumeChat: (chatId: string) => { resumed.push(chatId) },
    submitUserMessage: async () => undefined,
    runStoredUserMessage: vi.fn(async (_chatId: string, _event: ThreadEvent): Promise<undefined> => undefined),
    runExclusive: <T>(_chatId: string, fn: () => Promise<T>) => fn(),
  }
  const module = new WorkModule({
    store,
    agents: () => agents,
    orchestrator,
    broadcast: (message) => sent.push(message),
    broadcastDirectory: async () => {
      directories += 1
      const rows = new Map((await store.listChats()).map((chat) => [chat.id, chat.settledAt]))
      await options.beforeDelivery?.()
      directoryStates.push(rows)
      if (options.directoryError !== undefined) throw options.directoryError
    },
    ...(options.prepareCheckout === undefined ? {} : { prepareCheckout: options.prepareCheckout }),
    ...(options.outcome === undefined ? {} : { generateOutcome: options.outcome }),
    ...(options.writeCommitMessage === undefined ? {} : { writeCommitMessage: options.writeCommitMessage }),
    ...(options.awaitingInput === undefined ? {} : { awaitingInput: options.awaitingInput }),
  })
  return {
    module, store, source, projectId, started, discarded, stopped, resumed, sent, orchestrator, busy,
    directories: () => directories, directoryStates,
  }
}

export const input = (project: string) => ({
  assignmentKey: 'ship-handoffs',
  project,
  title: 'Ship handoffs',
  task: 'Implement the bounded Chat to Work handoff. Do not copy the source transcript.',
  summary: 'Hand bounded Chat work to a Work thread.',
  supportingPersonas: ['Smith'],
})

export async function propose(h: Awaited<ReturnType<typeof harness>>, overrides = {}) {
  return await h.module.useTool({ ...context, chatId: h.source.id }, { ...input(h.projectId), ...overrides }) as { workHandoffId: string; workChatId: null }
}

export async function acceptedWork(h: Awaited<ReturnType<typeof harness>>) {
  const proposal = await propose(h)
  return { workChatId: await h.module.accept(proposal.workHandoffId) }
}

/** An outcome writer the test releases by hand, standing in for a slow model call. */
export function held() {
  let release: (value: string) => void = () => undefined
  let started = false
  const result = new Promise<string>((resolve) => { release = resolve })
  return {
    run: () => { started = true; return result },
    started: () => started,
    release: (value: string) => release(value),
  }
}

/** Whether a broadcast note starts with `text`. */
export const noteSent = (h: Awaited<ReturnType<typeof harness>>, text: string) => h.sent.some(
  (message) => message.type === 'event' && message.event.type === 'system_note' && message.event.text.startsWith(text),
)

export const settledNotes = (events: readonly ThreadEvent[]) => events.filter(
  (event): event is Extract<ThreadEvent, { type: 'system_note' }> => event.type === 'system_note' && event.workHandoffPhase === 'settled',
)

/**
 * Real Git for the suites where Manor commits and merges a worktree Session itself. Call
 * it inside a describe: the temp folders it makes are removed after each test there.
 */
export function mergeFixture() {
  const roots: string[] = []
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_EDITOR: 'true' }
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const lines = (marks: Partial<Record<number, string>>) => Array.from({ length: 12 }, (_, at) => marks[at] ?? `line ${at}`).join('\n') + '\n'
  const completionOf = async (h: Awaited<ReturnType<typeof harness>>, handoffId: string) =>
    (await h.store.listWorkHandoffs()).find((row) => row.id === handoffId)?.goalCompletion

  /**
   * A linked folder on main and, per Session, a worktree on its own branch with a published
   * result whose commit message is `<title> change`. Manor commits at Confirm in the chat's
   * turn order: `beforeCommit` runs ahead of it, like a turn queued first, and `afterCommit`
   * right after, before Manor reads Git, like main moving meanwhile. The lead's turns are
   * scripted: `commit` answers a commit Manor handed over or a Retry, `trouble` Manor's
   * message about a stopped merge.
   */
  async function linkedFolder(seed: Record<string, string>, hooks: Record<string, string> = {}, options: Parameters<typeof harness>[1] = {}) {
    const h = await harness('dm', options)
    const root = mkdtempSync(path.join(os.tmpdir(), 'manor-own-merge-'))
    roots.push(root)
    const source = path.join(root, 'linked')
    execFileSync('mkdir', ['-p', source])
    git(source, 'init', '-q', '-b', 'main')
    git(source, 'config', 'user.name', 'Test')
    git(source, 'config', 'user.email', 'test@example.test')
    if (Object.keys(hooks).length > 0) {
      const dir = path.join(root, 'hooks')
      execFileSync('mkdir', ['-p', dir])
      for (const [name, script] of Object.entries(hooks)) writeFileSync(path.join(dir, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 })
      git(source, 'config', 'core.hooksPath', dir)
    }
    for (const [file, text] of Object.entries(seed)) writeFileSync(path.join(source, file), text)
    git(source, 'add', '.')
    git(source, 'commit', '-qm', 'Initial')
    await h.store.updateProject(h.projectId, 'Manor', [source])
    const sessions = new Map<string, { worktree: string; commit: () => void | Promise<void>; trouble: (text: string) => void
      beforeCommit: () => void | Promise<void>; afterCommit: () => void | Promise<void> }>()
    h.orchestrator.runExclusive = async <T>(chatId: string, fn: () => Promise<T>) => {
      await sessions.get(chatId)?.beforeCommit()
      const value = await fn()
      const session = sessions.get(chatId)
      if (session !== undefined) {
        const after = session.afterCommit
        session.afterCommit = () => undefined
        await after()
      }
      return value
    }
    h.orchestrator.runStoredUserMessage.mockImplementation(async (chatId: string, event: ThreadEvent) => {
      const session = sessions.get(chatId)!
      if (event.type === 'user_message') await h.store.replaceEvent(chatId, { ...event, dispatchState: 'started' })
      if (event.type === 'user_message' && event.mergeTrouble !== undefined) session.trouble(event.instruction ?? '')
      else await session.commit()
      // The exchange's own end reads Git while the request still reads started, as the service's onExchangeFinished does.
      await h.module.reconcileCompletion(chatId)
      if (event.type === 'user_message') await h.store.replaceEvent(chatId, { ...event, dispatchState: 'completed' })
      return undefined
    })

    async function session(title: string, edits: Record<string, string>, commit: GoalCommit | null = { subject: `${title} change` }) {
      const proposal = await h.module.useTool({ ...context, chatId: h.source.id },
        { ...input(h.projectId), assignmentKey: title, title }) as { workHandoffId: string }
      const workChatId = await h.module.accept(proposal.workHandoffId)
      const branch = `manor/${title.toLowerCase()}`
      const worktree = path.join(root, title)
      git(source, 'worktree', 'add', '-q', '-b', branch, worktree, 'main')
      const worktrees = [{ sourcePath: source, worktreePath: worktree, branch, createdAt: Date.now() }]
      await h.store.replaceChatWorktrees(workChatId, worktrees)
      const before = await captureTurnTree(worktree)
      for (const [file, text] of Object.entries(edits)) writeFileSync(path.join(worktree, file), text)
      await h.store.appendEvent(workChatId, { type: 'turn_result', agentId: 'sage', turnId: `edit-${title}`,
        fileChanges: await diffTurnTrees(worktree, before, await captureTurnTree(worktree)),
      })
      const files = Object.keys(edits).map((file) => path.join(worktree, file))
      /** Publishes the result again, as a later `goal_reached` does. */
      const reach = async (message: GoalCommit | null) => {
        const completion = { ...await prepareWorkCompletion([worktree], files, worktrees, 'main'), status: 'ready' as const, completedAt: undefined }
        await h.store.reachWorkGoal(proposal.workHandoffId, { type: 'system_note', kind: 'info', text: 'Ready.', workGoalHandoffId: proposal.workHandoffId,
          goalReport: { result: 'Done.', ...(message === null ? {} : { commit: message }) }, goalCompletion: completion })
      }
      await reach(commit)
      const scripted = {
        worktree,
        commit: (): void | Promise<void> => {
          git(worktree, 'add', '-A')
          if (git(worktree, 'status', '--porcelain') !== '') git(worktree, 'commit', '-qm', `${title} change`)
        },
        trouble: (_text: string) => undefined as void,
        beforeCommit: (): void | Promise<void> => undefined,
        afterCommit: (): void | Promise<void> => undefined,
      }
      sessions.set(workChatId, scripted)
      const confirm = async () => {
        const ready = (await h.store.listWorkHandoffs()).find((row) => row.id === proposal.workHandoffId)!
        await h.module.confirmGoal(proposal.workHandoffId, 'main', ready.version)
      }
      return { handoffId: proposal.workHandoffId, workChatId, branch, worktree, scripted, confirm, reach }
    }
    /** The messages the lead got: a commit Manor handed over, a Retry and Manor's merge failures. */
    const requests = () => h.orchestrator.runStoredUserMessage.mock.calls.map(([, event]) => event as Extract<ThreadEvent, { type: 'user_message' }>)
    /** Confirm's request as stored, which no turn answers when Manor commits. */
    const confirmEvent = async (s: { handoffId: string; workChatId: string }) => {
      const id = (await completionOf(h, s.handoffId))?.requestEventId
      return (await h.store.loadEvents(s.workChatId)).find((event) => event.id === id) as Extract<ThreadEvent, { type: 'user_message' }> | undefined
    }
    return { h, source, session, requests, confirmEvent }
  }
  return { git, lines, completionOf, linkedFolder }
}
