import { listStructuredProjectMemory } from './structuredProjectFiles.js'
import { HOME_PROJECT_ID, isFolder, isProjectThreadFile, SINGLE_CHAT_VOICE } from '@manor/contracts'
import { realpath } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { singleRuntime, singleRuntimeRequired } from './singleChat.js'
import type { AgentConfig, Chat, ChatOverride, CheckoutRequest, ClientMessage, Project, ProjectFileWrite, ServerMessage } from '@manor/contracts'
import {
  ARCHIVE_RETENTION_MS,
  DEFAULT_PROJECT_COLOR,
  DEFAULT_PROJECT_ICON,
  SIDE_CHAT_DEFAULTS,
  driverForModel,
} from '@manor/contracts'
import type { Orchestrator } from './orchestrator.js'
import { validateRepoPaths } from './repo.js'
import { listRepoFiles, readRepoFile, resolveInRepo, writeRepoFile } from './repoFiles.js'
import type { ExternalFileOpener } from './externalFiles.js'
import type { ChatWorktree, Store } from './store.js'
import { notesRows, shortNoteId } from './noteMarkers.js'
import { projectThreadPaths, readThreadFile, threadFilePath } from './projectFiles.js'
import { subagentDirectory } from './subagents.js'
import {
  attachWorktrees,
  cachedCurrentBranch,
  effectiveRepoPaths,
  gitRoots,
  listLeftovers,
  liveWorktreeBranch,
  pruneWorktreeNodeModules,
  readCheckoutStatus,
  releaseMergedWorktrees,
  removeProjectWorktrees,
  removeWorktree,
  removeWorktrees,
  restoreWorktrees,
  revertSwitches,
  sweepWorktrees,
} from './worktree.js'

const CHECKOUT_BUSY = 'Manor cannot change the checkout while this chat has a turn queued or running.'
const CHECKOUT_FROZEN =
  'This chat already has a checkout. Start a new chat to work in a different worktree, or discard this one.'

const sameFolders = (before: readonly string[], after: readonly string[]): boolean =>
  before.length === after.length && before.every((path, index) => path === after[index])

type ProjectMessage = Extract<
  ClientMessage,
  {
    type:
      | 'get_project_memory'
      | 'list_repo_files'
      | 'read_repo_file'
      | 'write_repo_file'
      | 'open_repo_file'
      | 'create_project'
      | 'add_folder'
      | 'remove_folder'
      | 'create_chat'
      | 'delete_project'
      | 'open_side_chat'
      | 'set_side_runtime'
      | 'delete_chat'
      | 'set_chat_checkout'
      | 'discard_chat_worktree'
      | 'checkout_status'
      | 'set_chat_archived'
      | 'set_chat_members'
      | 'reorder_projects'
      | 'update_project'
  }
>

type ProjectRuntime = Pick<
  Orchestrator,
  'activeTurn' | 'backgroundChatIds' | 'runningTurnId' | 'discard' | 'runExclusive' | 'setOverride' | 'subagents' | 'tryRunExclusive'
>

type OpeningMessage = NonNullable<Extract<ClientMessage, { type: 'create_chat' }>['openingMessage']>

interface ProjectModuleOptions {
  externalFiles?: ExternalFileOpener
  structuredMemoryRoot?: string
  store: Store
  agents: () => readonly AgentConfig[]
  orchestrator: ProjectRuntime
  worktreesRoot?: string
  broadcast: (message: ServerMessage) => void
  sendOpeningMessage: (chatId: string, opening: OpeningMessage) => Promise<void>
  reloadRoster: () => Promise<void>
  broadcastRoutines: () => Promise<void>
  setupProject: (projectId: string, threadRuntime?: ChatOverride) => Promise<void>
  /** The new project's thread reads its folders and says hello. After the directory went out. */
  welcomeProject?: (projectId: string) => void
  removeProjectThread: (projectId: string) => Promise<void>
  onChatsDeleted?: (chatIds: readonly string[]) => void
}

interface ProjectReplyContext {
  requestId?: string
  send: (message: ServerMessage) => void
  reply: (message: ServerMessage) => void
  ack: () => void
}

/**
 * Owns project, chat and checkout lifecycle as one transaction-shaped module.
 * Callers do not coordinate worktree rollback, cascaded cleanup or directory state.
 */
export class ProjectModule {
  private knownChats: Chat[] | undefined
  // Which broadcast began last, and which of them went out last.
  private directoriesStarted = 0
  private directorySent = 0
  private addingFolder: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: ProjectModuleOptions) {}

  async document(): Promise<ServerMessage> {
    return this.loadDirectory('none')
  }

  /**
   * Each directory is read from the store and then waits on git for branch names, so
   * two broadcasts can finish out of order. One that started before the last one sent
   * is older than what clients already hold and is dropped, never sent over it
   * (2026-10-11: a reached goal's card fell back to Done behind an earlier read).
   */
  async broadcast(): Promise<void> {
    const started = ++this.directoriesStarted
    const directory = await this.loadDirectory('merge')
    if (started < this.directorySent) return
    this.directorySent = started
    this.options.broadcast(directory)
  }

  async replaceDocument(): Promise<ServerMessage> {
    return this.loadDirectory('replace')
  }

  async prime(): Promise<void> {
    this.knownChats = await this.options.store.listChats()
  }

  knownChatSnapshot(): readonly Chat[] {
    return this.knownChats ?? []
  }

  /**
   * A chat beside the Browser gets its row on "+", before anyone types, so starting the
   * next one first removes those with no event and no side chat. The recent list then
   * holds at most one empty "New chat". Runs before the create, so two concurrent starts
   * can never delete each other's new chat. The exclusive reserve skips a chat whose
   * first send is already in flight.
   */
  private async dropEmptyBrowserSessions(): Promise<void> {
    const { store, orchestrator } = this.options
    const candidates = (await store.listChats()).filter((chat) =>
      chat.kind === 'browser' && chat.lastMessagePreview === null)
    const gone: string[] = []
    for (const chat of candidates) {
      const outcome = await orchestrator.tryRunExclusive(chat.id, async () => {
        if ((await store.loadEvents(chat.id)).length > 0 || (await store.sideChatOf(chat.id)) !== undefined) return false
        orchestrator.discard(chat.id)
        await store.deleteChat(chat.id)
        return true
      })
      if (!outcome.occupied && outcome.value) gone.push(chat.id)
    }
    if (gone.length > 0) this.options.onChatsDeleted?.(gone)
  }

  async purgeExpiredArchivedChats(now = Date.now(), retentionMs = ARCHIVE_RETENTION_MS): Promise<string[]> {
    const cutoff = now - retentionMs
    // A hidden project's archived thread never expires, as in the store's own sweep.
    const threads = new Set((await this.options.store.listProjects()).map((project) => project.threadChatId))
    const doomed = (await this.options.store.listChats()).filter(
      (chat) => chat.kind === 'project' && chat.archivedAt !== null && chat.archivedAt <= cutoff && !threads.has(chat.id),
    )
    for (const chat of doomed) await this.removeChatWorktrees(chat, false, true)
    const gone = await this.options.store.deleteExpiredArchivedChats(cutoff)
    for (const chatId of gone) this.options.orchestrator.discard(chatId)
    if (gone.length > 0) this.options.onChatsDeleted?.(gone)
    return gone
  }

  /**
   * A settled chat's worktree folders leave disk once every one is clean and its
   * branch is in the branch it was created from. Only settle counts, not archive
   * alone: unarchive restores nothing, while reopen and the next turn do. The mapping
   * stays; a Manor-named branch is deleted and comes back from HEAD on restore. A chat with
   * a turn queued, running or kept alive for background work is skipped; the hourly
   * sweep tries again.
   */
  async releaseMergedWorktrees(chatId: string): Promise<number> {
    const { store, orchestrator, worktreesRoot } = this.options
    if (worktreesRoot === undefined) return 0
    if (orchestrator.backgroundChatIds([chatId]).length > 0) return 0
    const settled = async () => {
      const chat = await store.getChat(chatId)
      return chat !== undefined && chat.projectId !== null && chat.settledAt !== null
    }
    const outcome = await orchestrator.tryRunExclusive(chatId, async () => {
      if (!(await settled())) return 0
      const mapping = await store.loadChatWorktrees(chatId)
      if (mapping.length === 0) return 0
      const released = await releaseMergedWorktrees(mapping, async (live) => {
        if (live.some((row, index) => row.branch !== mapping[index]!.branch)) await store.replaceChatWorktrees(chatId, live)
        // Reopen does not wait on this queue; its own restore is queued behind this
        // release, so a reopen that lands now gets the folder back right after.
        return settled()
      })
      return released.ok ? released.removed : 0
    }).catch(() => ({ occupied: true as const }))
    return outcome.occupied ? 0 : outcome.value
  }

  /** Reopen brings a released folder back before Files or Changes read it. */
  async restoreChatWorktrees(chatId: string): Promise<void> {
    await this.options.orchestrator.runExclusive(chatId, async () => {
      const mapping = await this.options.store.loadChatWorktrees(chatId)
      const restored = await restoreWorktrees(mapping)
      if (!restored.ok) throw new Error(restored.message)
    })
  }

  async sweepChatWorktrees(
    chats: readonly Pick<Chat, 'id' | 'projectId' | 'settledAt' | 'archivedAt'>[],
  ): Promise<{ directoriesRemoved: number; nodeModulesRemoved: number; worktreesReleased: number }> {
    const worktreesRoot = this.options.worktreesRoot
    if (worktreesRoot === undefined) return { directoriesRemoved: 0, nodeModulesRemoved: 0, worktreesReleased: 0 }
    const orphans = await sweepWorktrees({
      worktreesRoot,
      liveChatIds: chats.map((chat) => chat.id),
    })
    let nodeModulesRemoved = 0
    let worktreesReleased = 0
    for (const chat of chats) {
      if (chat.projectId === null) continue
      if (chat.settledAt === null && chat.archivedAt === null) continue
      if (chat.settledAt !== null) worktreesReleased += await this.releaseMergedWorktrees(chat.id)
      const outcome = await this.options.orchestrator.tryRunExclusive(chat.id, async () => {
        const current = await this.options.store.getChat(chat.id)
        if (current === undefined || current.projectId === null) return 0
        if (current.settledAt === null && current.archivedAt === null) return 0
        return pruneWorktreeNodeModules({
          worktreesRoot,
          projectId: current.projectId,
          chatId: current.id,
        })
      })
      if (!outcome.occupied) nodeModulesRemoved += outcome.value
    }
    return { directoriesRemoved: orphans.directoriesRemoved, nodeModulesRemoved, worktreesReleased }
  }

  /** A project thread's notes.md as rows for the memory panel, its Sessions named and its ages from the store. */
  private async noteRows(project: Project): Promise<Pick<Extract<ServerMessage, { type: 'project_memory' }>, 'noteRows'>> {
    const { store, structuredMemoryRoot } = this.options
    if (project.threadChatId === undefined || structuredMemoryRoot === undefined) return {}
    const content = await readThreadFile(projectThreadPaths(structuredMemoryRoot, project.name).notes)
    if (content.trim() === '') return {}
    const sessions = new Map<string, { chatId: string; title: string } | undefined>()
    for (const handoff of await store.listWorkHandoffs()) {
      if (handoff.sourceChatId !== project.threadChatId || handoff.workChatId === null) continue
      const id = shortNoteId(handoff.id)
      // Two Sessions behind one short id name neither.
      sessions.set(id, sessions.has(id) ? undefined : { chatId: handoff.workChatId, title: handoff.title })
    }
    return { noteRows: notesRows(content, await store.loadNoteAges(project.id), sessions, Date.now()) }
  }

  async handle(message: ProjectMessage, context: ProjectReplyContext): Promise<void> {
    const { store } = this.options
    const { reply, send, ack, requestId } = context
    switch (message.type) {
      case 'get_project_memory': {
        const project = await store.getProject(message.projectId)
        if (project === undefined) {
          reply({ type: 'notice', kind: 'error', text: 'Project not found' })
          return
        }
        // The home room and a folder have no project memory folder of their own, so no
        // name looks one up: a folder called Client must not read the Client project's.
        const listing = await listStructuredProjectMemory(this.options.structuredMemoryRoot, project.id === HOME_PROJECT_ID || isFolder(project) ? '' : project.name)
        // The thread's own writes say who changed its two files and when (2026-10-10).
        const writes = new Map<string, { path: string; by: string; at: number; action: ProjectFileWrite['action']; line?: string }>()
        if (project.threadChatId !== undefined && this.options.structuredMemoryRoot !== undefined) {
          const paths = projectThreadPaths(this.options.structuredMemoryRoot, project.name)
          for (const event of await store.loadEvents(project.threadChatId).catch(() => [])) {
            const write = event.type === 'system_note' ? event.projectFileWrite : undefined
            if (write === undefined) continue
            const path = isProjectThreadFile(write.file) ? threadFilePath(paths, write.file) : join(paths.folder, write.file)
            writes.set(path, { path, by: write.by, at: event.ts, action: write.action, ...(write.line === undefined ? {} : { line: write.line }) })
          }
        }
        reply({
          type: 'project_memory', projectId: project.id, ...(requestId === undefined ? {} : { requestId }), ...listing,
          ...(writes.size === 0 ? {} : { writes: [...writes.values()] }),
          ...await this.noteRows(project),
        })
        return
      }
      case 'list_repo_files': {
        const paths = await this.repoPathsFor(message.projectId, message.chatId)
        const listing = await listRepoFiles(paths)
        reply({
          type: 'repo_files',
          projectId: message.projectId,
          ...(message.chatId === undefined ? {} : { chatId: message.chatId }),
          files: listing.files,
          truncated: listing.truncated,
        })
        return
      }
      case 'read_repo_file': {
        const paths = await this.repoPathsFor(message.projectId, message.chatId)
        const result = await readRepoFile(paths, message.path)
        reply({
          type: 'repo_file',
          projectId: message.projectId,
          ...(message.chatId === undefined ? {} : { chatId: message.chatId }),
          path: message.path,
          result,
        })
        return
      }
      case 'write_repo_file': {
        const paths = await this.repoPathsFor(message.projectId, message.chatId)
        const result = await writeRepoFile(paths, message.path, message.content, message.baseRevision)
        reply({
          type: 'repo_write',
          projectId: message.projectId,
          ...(message.chatId === undefined ? {} : { chatId: message.chatId }),
          path: message.path,
          result,
        })
        return
      }
      case 'open_repo_file': {
        const opener = this.options.externalFiles
        if (opener === undefined || !opener.apps.includes(message.app)) {
          reply({ type: 'notice', kind: 'error', text: 'That application is not available on this Manor host.' })
          return
        }
        if (message.chatId !== undefined && (await store.getChat(message.chatId))?.projectId !== message.projectId) {
          reply({ type: 'notice', kind: 'error', text: 'That chat no longer belongs to this project.' })
          return
        }
        const paths = await this.repoPathsFor(message.projectId, message.chatId)
        const target = await resolveInRepo(paths, message.path)
        if (target === null) {
          reply({ type: 'notice', kind: 'error', text: 'That file is no longer available in this project.' })
          return
        }
        try {
          await opener.open(message.app, target)
        } catch {
          reply({ type: 'notice', kind: 'error', text: 'The application could not open that file.' })
        }
        return
      }
      case 'create_project': {
        const name = message.name.trim()
        if (name.length === 0) {
          reply({ type: 'notice', kind: 'error', text: 'A project needs a name.' })
          return
        }
        const checked = await validateRepoPaths(message.repoPaths)
        if (!checked.ok) {
          reply({ type: 'notice', kind: 'error', text: checked.message })
          return
        }
        let threadRuntime: ChatOverride | undefined
        try {
          threadRuntime = message.threadRuntime === undefined ? undefined : singleRuntime(message.threadRuntime)
        } catch (error) {
          reply({ type: 'notice', kind: 'error', text: error instanceof Error ? error.message : 'That model cannot run the project thread.' })
          return
        }
        const project = await store.createProject(
          name,
          checked.paths,
          message.icon ?? DEFAULT_PROJECT_ICON,
          message.color ?? DEFAULT_PROJECT_COLOR,
          message.memoryScope ?? 'project',
        )
        let setupError: string | undefined
        try {
          await this.options.setupProject(project.id, threadRuntime)
        } catch (error) {
          setupError = error instanceof Error ? error.message : String(error)
        }
        await this.broadcast()
        reply({
          type: 'project_created',
          projectId: project.id,
          ...(requestId === undefined ? {} : { requestId }),
        })
        ack()
        if (setupError !== undefined) reply({ type: 'notice', kind: 'error', text: `Project created, but setup is incomplete. ${setupError}` })
        else this.options.welcomeProject?.(project.id)
        return
      }
      case 'add_folder': {
        if (message.path.trim().length === 0) {
          reply({ type: 'notice', kind: 'error', text: 'Choose a folder first.' })
          return
        }
        const checked = await validateRepoPaths([message.path])
        if (!checked.ok) {
          reply({ type: 'notice', kind: 'error', text: checked.message })
          return
        }
        // One add at a time, so the desktop and the phone adding one folder at once
        // find a single row rather than both creating it.
        const adding = this.addingFolder.then(() => this.folderFor(checked.paths[0]!))
        this.addingFolder = adding.catch(() => undefined)
        const folder = await adding
        await this.broadcast()
        reply({ type: 'project_created', projectId: folder.id, ...(requestId === undefined ? {} : { requestId }) })
        ack()
        return
      }
      case 'remove_folder': {
        const project = await store.getProject(message.projectId)
        if (project === undefined || project.id === HOME_PROJECT_ID) {
          reply({ type: 'notice', kind: 'error', text: 'That folder is no longer on the list.' })
          return
        }
        if (!isFolder(project)) {
          reply({ type: 'notice', kind: 'error', text: 'That is a project. Hide or delete it from Projects in the sidebar.' })
          return
        }
        await store.setProjectUnlisted(project.id, true)
        break
      }
      case 'create_chat': {
        const kind = message.kind ?? 'project'
        const single = message.mode === 'single'
        if (single) {
          try {
            if (kind !== 'project' && kind !== 'browser') throw new Error('Single sessions must be project chats or browser sessions.')
            if (Object.keys(message.overrides ?? {}).some((id) => id !== SINGLE_CHAT_VOICE.id)) {
              throw new Error('Single sessions take no persona pins.')
            }
            const pin = message.overrides?.[SINGLE_CHAT_VOICE.id]
            if (singleRuntimeRequired(pin)) singleRuntime(pin)
          } catch (error: unknown) {
            reply({ type: 'notice', kind: 'error', text: `Cannot create single session: ${error instanceof Error ? error.message : 'invalid runtime'}` })
            return
          }
        }
        if (kind === 'pair') {
          reply({ type: 'notice', kind: 'error', text: 'Agent pair chats are created by message_agent.' })
          return
        }
        const memberIds = message.memberIds ?? []
        const unknown = memberIds.filter((agentId) => !this.options.agents().some((agent) => agent.id === agentId))
        if (unknown.length > 0) {
          reply({ type: 'notice', kind: 'error', text: `No such persona: ${unknown.join(', ')}.` })
          return
        }
        if ((kind === 'dm' || kind === 'group') && memberIds.some((id) =>
          this.options.agents().some((agent) => agent.id === id && agent.placement === 'session'))) {
          reply({ type: 'notice', kind: 'error', text: 'Session personas cannot join a DM or group. Their existing conversations remain readable.' })
          return
        }
        const named = kind === 'dm'
          ? this.options.agents().find((agent) => agent.id === memberIds[0])?.name
          : undefined
        const title = message.title ?? named
        if (message.checkout?.mode === 'worktree') {
          const isolated = await this.canIsolate(kind, message.projectId)
          if (!isolated.ok) {
            reply({ type: 'notice', kind: 'error', text: isolated.message })
            return
          }
        }
        if (kind === 'browser') await this.dropEmptyBrowserSessions()
        let chat: Chat
        try {
          chat = await store.createChat({
            ...(message.mode === undefined ? {} : { mode: message.mode }),
            ...(message.projectId === undefined ? {} : { projectId: message.projectId }),
            kind,
            memberIds,
            ...(title === undefined ? {} : { title }),
          })
        } catch (error: unknown) {
          const why = error instanceof Error ? error.message : 'the store refused it'
          reply({ type: 'notice', kind: 'error', text: `That chat could not be made: ${why}.` })
          return
        }
        if (message.checkout?.mode === 'worktree') {
          let attached: { ok: true } | { ok: false; message: string }
          try {
            attached = await this.isolate(chat, message.checkout.branch)
          } catch (error: unknown) {
            await this.removeChatWorktrees(chat, true, true)
            await store.deleteChat(chat.id)
            const why = error instanceof Error ? error.message : 'the worktree could not be created'
            reply({ type: 'notice', kind: 'error', text: why })
            return
          }
          if (!attached.ok) {
            await store.deleteChat(chat.id)
            reply({ type: 'notice', kind: 'error', text: attached.message })
            return
          }
        }
        for (const [agentId, override] of Object.entries(message.overrides ?? {})) {
          if (!single && !this.options.agents().some((agent) => agent.id === agentId)) continue
          try {
            await this.options.orchestrator.setOverride(chat.id, agentId, override)
          } catch (error: unknown) {
            const why = error instanceof Error ? error.message : 'the store refused it'
            if (single) {
              await this.removeChatWorktrees(chat, true, true)
              await store.deleteChat(chat.id)
              reply({ type: 'notice', kind: 'error', text: `Single session was not created: ${why}.` })
              return
            }
            send({
              type: 'notice',
              kind: 'error',
              text: `That chat was made, but its model pin was not saved: ${why}.`,
            })
          }
        }
        await this.broadcast()
        reply({
          type: 'chat_created',
          chatId: chat.id,
          ...(requestId === undefined ? {} : { requestId }),
        })
        ack()
        if (message.openingMessage !== undefined) {
          await this.options.sendOpeningMessage(chat.id, message.openingMessage)
        }
        return
      }
      case 'delete_project': {
        // The home room is built in. Deleting it would take every Session without a project.
        if (message.projectId === HOME_PROJECT_ID) {
          reply({ type: 'notice', kind: 'error', text: 'Sessions without a project have no project to delete.' })
          return
        }
        const chats = await store.chatsForProject(message.projectId)
        const sides = (await Promise.all(chats.map((chat) => store.sideChatOf(chat.id)))).flatMap(
          (side) => (side === undefined ? [] : [side]),
        )
        const gone = [...chats, ...sides].map((chat) => chat.id)
        for (const chatId of gone) this.options.orchestrator.discard(chatId)
        for (const chat of chats) await this.removeChatWorktrees(chat, false, true)
        await this.forgetSessions(message.projectId)
        await store.deleteProject(message.projectId)
        await this.options.reloadRoster()
        if (this.options.worktreesRoot !== undefined) {
          await removeProjectWorktrees(this.options.worktreesRoot, message.projectId)
        }
        this.options.onChatsDeleted?.(gone)
        await this.options.broadcastRoutines()
        break
      }
      case 'open_side_chat': {
        const parent = await store.getChat(message.chatId)
        if (parent === undefined) {
          reply({ type: 'notice', kind: 'error', text: 'That chat no longer exists.' })
          return
        }
        if (parent.kind === 'side') {
          reply({ type: 'notice', kind: 'error', text: 'A side chat has no side chat of its own.' })
          return
        }
        let side: Chat
        try {
          // Clearing is a delete and a new thread, so the old one's events, sessions and
          // any turn still running go with it, exactly as when its parent is deleted.
          const previous = message.fresh === true ? await store.sideChatOf(parent.id) : undefined
          if (previous !== undefined) {
            this.options.orchestrator.discard(previous.id)
            await store.deleteChat(previous.id)
            this.options.onChatsDeleted?.([previous.id])
          }
          side = await store.sideChatFor(parent.id)
          if (previous?.sideModel != null && previous.sideEffort != null) {
            await store.setSideRuntime(side.id, previous.sideModel, previous.sideEffort)
            side = { ...side, sideModel: previous.sideModel, sideEffort: previous.sideEffort }
          }
        } catch (error: unknown) {
          const why = error instanceof Error ? error.message : 'the store refused it'
          reply({ type: 'notice', kind: 'error', text: `That panel could not be opened: ${why}.` })
          return
        }
        reply({
          type: 'side_chat',
          parentChatId: parent.id,
          chatId: side.id,
          model: side.sideModel ?? SIDE_CHAT_DEFAULTS.model,
          effort: side.sideEffort ?? SIDE_CHAT_DEFAULTS.effort,
        })
        return
      }
      case 'set_side_runtime': {
        if (driverForModel(message.model) === undefined) {
          reply({ type: 'notice', kind: 'error', text: `No installed provider offers ${message.model}.` })
          return
        }
        const room = await store.getChat(message.chatId)
        if (room?.kind !== 'side') {
          reply({ type: 'notice', kind: 'error', text: 'Only a side chat carries its own model.' })
          return
        }
        await store.setSideRuntime(message.chatId, message.model, message.effort)
        reply({ type: 'side_runtime', chatId: message.chatId, model: message.model, effort: message.effort })
        return
      }
      case 'delete_chat': {
        const doomed = await store.getChat(message.chatId)
        const project = doomed?.projectId == null ? undefined : await store.getProject(doomed.projectId)
        if (project?.threadChatId === message.chatId) {
          try {
            await this.options.removeProjectThread(project.id)
          } catch (error) {
            reply({ type: 'notice', kind: 'error', text: error instanceof Error ? error.message : String(error) })
            return
          }
        }
        const dropsRoutine = (await store.listRoutines()).some((routine) => routine.chatId === message.chatId)
        const side = await store.sideChatOf(message.chatId)
        const gone = side === undefined ? [message.chatId] : [message.chatId, side.id]
        for (const chatId of gone) this.options.orchestrator.discard(chatId)
        if (doomed !== undefined) {
          const leftover = await this.removeChatWorktrees(doomed, false, true)
          if (!leftover.ok && leftover.message !== undefined && /uncommitted|stays on disk/i.test(leftover.message)) {
            reply({ type: 'notice', kind: 'info', text: leftover.message })
          }
        }
        await store.deleteChat(message.chatId)
        this.options.onChatsDeleted?.(gone)
        if (dropsRoutine) await this.options.broadcastRoutines()
        break
      }
      case 'set_chat_checkout': {
        const outcome = await this.options.orchestrator.tryRunExclusive(message.chatId, async () => {
          const current = await store.getChat(message.chatId)
          if (current === undefined) return { ok: false as const, message: 'That chat no longer exists.' }
          if (current.kind !== 'project') {
            return { ok: false as const, message: 'Only a project chat can isolate onto a worktree.' }
          }
          if (message.checkout.mode === 'current') {
            if (current.checkout.mode === 'current') return { ok: true as const }
            return { ok: false as const, message: CHECKOUT_FROZEN }
          }
          if (current.checkout.mode === 'current') return { ok: false as const, message: CHECKOUT_FROZEN }
          const isolated = await this.canIsolate(current.kind, current.projectId ?? undefined)
          if (!isolated.ok) return isolated
          const attached = await this.isolate(current, message.checkout.branch)
          if (!attached.ok) return attached
          await store.clearSessions([current.id])
          return { ok: true as const }
        })
        if (outcome.occupied) {
          reply({ type: 'notice', kind: 'error', text: CHECKOUT_BUSY })
          return
        }
        if (!outcome.value.ok) {
          reply({ type: 'notice', kind: 'error', text: outcome.value.message })
          return
        }
        break
      }
      case 'discard_chat_worktree': {
        const discarded = await this.options.orchestrator.tryRunExclusive(message.chatId, async () => {
          const current = await store.getChat(message.chatId)
          if (current === undefined) return { ok: false as const, message: 'That chat no longer exists.' }
          const removed = await this.removeChatWorktrees(current, message.force === true)
          if (!removed.ok) return removed
          await store.replaceChatWorktrees(current.id, [])
          await store.clearSessions([current.id])
          return { ok: true as const }
        })
        if (discarded.occupied) {
          reply({ type: 'notice', kind: 'error', text: CHECKOUT_BUSY })
          return
        }
        if (!discarded.value.ok) {
          reply({
            type: 'notice',
            kind: 'error',
            text: discarded.value.message ?? 'There is nothing to discard.',
          })
          return
        }
        break
      }
      case 'checkout_status': {
        const status = message.chatId !== undefined
          ? await this.checkoutStatusFor(message.chatId)
          : message.projectId !== undefined
            ? await this.projectCheckoutStatus(message.projectId)
            : undefined
        if (status === undefined) {
          reply({
            type: 'notice',
            kind: 'error',
            text: message.chatId !== undefined ? 'That chat no longer exists.' : 'That project no longer exists.',
          })
          return
        }
        reply(status)
        return
      }
      case 'set_chat_archived': {
        const chat = await store.getChat(message.chatId)
        if (chat?.kind !== 'project') {
          reply({ type: 'notice', kind: 'error', text: 'Only project chats can be archived.' })
          return
        }
        // Archiving a project's thread is hiding the project, and restoring it is adding
        // the project back; both go through the thread's owner so its guards hold.
        if (chat.projectId !== null && (await store.getProject(chat.projectId))?.threadChatId === chat.id) {
          try {
            if (message.archived) await this.options.removeProjectThread(chat.projectId)
            else await this.options.setupProject(chat.projectId)
          } catch (error) {
            reply({ type: 'notice', kind: 'error', text: error instanceof Error ? error.message : String(error) })
            return
          }
          break
        }
        await store.setChatArchived(message.chatId, message.archived)
        break
      }
      case 'set_chat_members': {
        const current = await store.getChat(message.chatId)
        const unknown = message.memberIds.filter(
          (agentId) =>
            !this.options.agents().some((agent) => agent.id === agentId) &&
            !(current?.memberIds.includes(agentId) ?? false),
        )
        if (unknown.length > 0) {
          reply({ type: 'notice', kind: 'error', text: `No such persona: ${unknown.join(', ')}.` })
          return
        }
        const sessionAdded = message.memberIds.find(
          (agentId) =>
            !(current?.memberIds.includes(agentId) ?? false) &&
            this.options.agents().some((agent) => agent.id === agentId && agent.placement === 'session'),
        )
        if (sessionAdded !== undefined) {
          reply({ type: 'notice', kind: 'error', text: 'Only chat personas can join this conversation.' })
          return
        }
        try {
          await store.setChatMembers(message.chatId, message.memberIds)
        } catch (error: unknown) {
          const why = error instanceof Error ? error.message : 'the store refused it'
          reply({ type: 'notice', kind: 'error', text: `Those members could not be saved: ${why}.` })
          return
        }
        await this.broadcast()
        return
      }
      case 'reorder_projects': {
        const projects = await store.listProjects()
        const currentIds = projects.map((project) => project.id)
        const proposed = new Set(message.projectIds)
        const complete =
          proposed.size === currentIds.length &&
          message.projectIds.length === currentIds.length &&
          currentIds.every((projectId) => proposed.has(projectId))
        if (!complete) {
          reply({ type: 'notice', kind: 'error', text: 'The project list changed before that move landed. Try again.' })
          reply(await this.document())
          return
        }
        try {
          await store.reorderProjects(message.projectIds)
        } catch {
          reply({ type: 'notice', kind: 'error', text: 'That project move could not be saved. The previous order is restored.' })
          reply(await this.document())
          return
        }
        await this.broadcast()
        return
      }
      case 'update_project': {
        const current = (await store.listProjects()).find((project) => project.id === message.projectId)
        if (current === undefined) {
          reply({ type: 'notice', kind: 'error', text: 'That project is gone, so there was nothing to change.' })
          return
        }
        const name = message.name.trim()
        if (name.length === 0) {
          reply({ type: 'notice', kind: 'error', text: 'A project needs a name.' })
          return
        }
        const checked = await validateRepoPaths(message.repoPaths)
        if (!checked.ok) {
          reply({ type: 'notice', kind: 'error', text: checked.message })
          return
        }
        if (!sameFolders(current.repoPaths, checked.paths)) {
          const reconciled = await this.reconcileProjectWorktrees(
            message.projectId,
            current.repoPaths,
            checked.paths,
          )
          if (!reconciled.ok) {
            reply({ type: 'notice', kind: 'error', text: reconciled.message })
            return
          }
        }
        await store.updateProject(
          message.projectId,
          name,
          checked.paths,
          message.icon ?? current.icon,
          message.color ?? current.color,
          message.memoryScope ?? current.memoryScope,
        )
        if (!sameFolders(current.repoPaths, checked.paths)) await this.forgetSessions(message.projectId)
        break
      }
    }
    await this.broadcast()
    ack()
  }

  /** The folder row for `path`, listed: the one already there, or a new one. */
  private async folderFor(path: string): Promise<Project> {
    const { store } = this.options
    // The same folder twice is the folder it already is, listed again if it was removed.
    // Compared on disk, so a symlink or /var against /private/var is one folder.
    const identity = (candidate: string) => realpath(candidate).catch(() => candidate)
    const wanted = await identity(path)
    let folder: Project | undefined
    for (const project of await store.listProjects()) {
      if (!isFolder(project) || project.repoPaths.length !== 1) continue
      if (await identity(project.repoPaths[0]!) === wanted) {
        folder = project
        break
      }
    }
    folder ??= await store.createProject(basename(path) || path, [path])
    if (folder.unlisted === true) await store.setProjectUnlisted(folder.id, false)
    return folder
  }

  private async loadDirectory(remember: 'none' | 'merge' | 'replace'): Promise<ServerMessage> {
    const [projects, chats, workHandoffs] = await Promise.all([
      this.options.store.listProjects(),
      this.options.store.listChats(),
      this.options.store.listWorkHandoffs(),
    ])
    if (remember === 'replace') {
      this.knownChats = chats
    } else if (remember === 'merge') {
      const known = new Map((this.knownChats ?? []).map((chat) => [chat.id, chat]))
      for (const chat of chats) known.set(chat.id, chat)
      this.knownChats = [...known.values()]
    }
    const listed = chats.filter(isDirectoryChat)
    const branchByProject = new Map(await Promise.all(projects
      .filter((project) => project.repoPaths.length > 0)
      .map(async (project) => {
        const roots = await gitRoots(project.repoPaths)
        return [project.id, roots[0] === undefined ? null : await cachedCurrentBranch(roots[0])] as const
      })))
    const runningTurns = Object.fromEntries(chats.flatMap((chat) => {
      const turnId = this.options.orchestrator.runningTurnId(chat.id)
      return turnId === undefined ? [] : [[chat.id, [turnId]]]
    }))
    return {
      type: 'directory',
      projects,
      chats: listed.map((chat) => {
        if (chat.checkout.mode === 'worktree' || chat.projectId === null) return chat
        const branch = branchByProject.get(chat.projectId) ?? null
        return branch === chat.checkout.branch ? chat : { ...chat, checkout: { mode: 'current' as const, branch } }
      }),
      workHandoffs: workHandoffs.filter((handoff) => handoff.version > 0 || handoff.state === 'deleted'),
      runningTurns,
      ...subagentDirectory(chats, runningTurns, this.options.orchestrator.subagents.nativeRunning(), this.options.orchestrator.subagents.openAsks()),
      backgroundChatIds: this.options.orchestrator.backgroundChatIds(listed.map((chat) => chat.id)),
    }
  }

  private async repoPathsFor(projectId: string, chatId?: string): Promise<string[]> {
    const project = await this.options.store.getProject(projectId)
    const paths = project?.repoPaths ?? []
    if (chatId === undefined) return paths
    const chat = await this.options.store.getChat(chatId)
    if (chat?.projectId !== projectId) return paths
    const mapping = await this.options.store.loadChatWorktrees(chatId)
    return effectiveRepoPaths(paths, mapping)
  }

  private async canIsolate(
    kind: Chat['kind'],
    projectId: string | undefined,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    if (kind !== 'project') {
      return { ok: false, message: 'Only a project chat can isolate onto a worktree.' }
    }
    if (this.options.worktreesRoot === undefined) {
      return { ok: false, message: 'Manor has no worktrees directory configured.' }
    }
    if (projectId === undefined) {
      return { ok: false, message: 'Only a project chat can isolate onto a worktree.' }
    }
    const project = await this.options.store.getProject(projectId)
    if (project === undefined) return { ok: false, message: 'That project is gone, so there was nothing to isolate.' }
    const roots = await gitRoots(project.repoPaths)
    if (roots.length === 0) return { ok: false, message: 'This project has no git folder to isolate.' }
    return { ok: true }
  }

  /** A stored Work kickoff is still a draft until Accept commits. */
  async prepareWorkCheckout(chatId: string, checkout: CheckoutRequest, accept: () => Promise<void>): Promise<void> {
    if (checkout.mode !== 'worktree') return accept()
    const outcome = await this.options.orchestrator.tryRunExclusive(chatId, async () => {
      const chat = await this.options.store.getChat(chatId)
      const handoff = await this.options.store.workHandoffForTarget(chatId)
      const events = await this.options.store.loadEvents(chatId)
      if (chat === undefined || handoff === undefined || handoff.acceptedAt !== null ||
          handoff.state !== 'active' || chat.settledAt !== null || chat.archivedAt !== null ||
          events.some((event) => 'turnId' in event && event.turnId !== undefined)) {
        throw new Error('Only a pending session can choose a worktree.')
      }
      const allowed = await this.canIsolate(chat.kind, chat.projectId ?? undefined)
      if (!allowed.ok) throw new Error(allowed.message)
      const attached = await this.isolate(chat, checkout.branch, accept)
      if (!attached.ok) throw new Error(attached.message)
    })
    if (outcome.occupied) throw new Error(CHECKOUT_BUSY)
  }

  private async isolate(
    chat: Chat,
    branch?: string,
    commit?: () => Promise<void>,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    if (this.options.worktreesRoot === undefined || chat.projectId === null) {
      return { ok: false, message: 'Manor has no worktrees directory configured.' }
    }
    const project = await this.options.store.getProject(chat.projectId)
    if (project === undefined) return { ok: false, message: 'That project is gone, so there was nothing to isolate.' }
    const previous = commit === undefined ? undefined : await this.options.store.loadChatWorktrees(chat.id)
    try {
      const attached = await attachWorktrees({
        worktreesRoot: this.options.worktreesRoot,
        projectId: project.id,
        chatId: chat.id,
        repoPaths: project.repoPaths,
        ...(branch === undefined ? {} : { branch }),
      })
      if (!attached.ok) return attached
      let mappingSaved = false
      try {
        await this.options.store.replaceChatWorktrees(chat.id, attached.mapping)
        mappingSaved = true
        await commit?.()
      } catch (error: unknown) {
        // Detach before removing newly created paths; keep any pre-existing checkout.
        if (mappingSaved && previous !== undefined) {
          await this.options.store.replaceChatWorktrees(chat.id, previous)
        }
        for (const row of attached.created) {
          await removeWorktree(row.sourcePath, row.worktreePath, { force: true })
        }
        await revertSwitches(attached.switched)
        const why = error instanceof Error ? error.message : String(error)
        return { ok: false, message: `Manor could not save the worktree setup: ${why}` }
      }
      return { ok: true }
    } catch (error: unknown) {
      const why = error instanceof Error ? error.message : String(error)
      return { ok: false, message: `Manor could not isolate this chat: ${why}` }
    }
  }

  private async removeChatWorktrees(
    chat: Chat,
    force: boolean,
    chatGone = false,
  ): Promise<{ ok: boolean; message?: string }> {
    if (this.options.worktreesRoot === undefined || chat.projectId === null) {
      return { ok: false, message: 'There is nothing to discard.' }
    }
    const project = await this.options.store.getProject(chat.projectId)
    if (project === undefined) return { ok: false, message: 'There is nothing to discard.' }
    const mapping = await this.options.store.loadChatWorktrees(chat.id)
    const leftovers = mapping.length > 0
      ? mapping
      : await listLeftovers({
          worktreesRoot: this.options.worktreesRoot,
          projectId: project.id,
          chatId: chat.id,
          repoPaths: project.repoPaths,
        })
    if (leftovers.length === 0) return { ok: false, message: 'There is nothing to discard.' }
    const removed = await removeWorktrees(leftovers, { force })
    if (!removed.ok) {
      return {
        ok: false,
        message:
          chatGone && force === false && removed.dirty
            ? 'That worktree has uncommitted changes, so it stays on disk. The chat is gone. Discard it with force, or commit the work first.'
            : removed.message,
      }
    }
    return { ok: true }
  }

  private async checkoutStatusFor(chatId: string): Promise<Extract<ServerMessage, { type: 'checkout_status' }> | undefined> {
    const chat = await this.options.store.getChat(chatId)
    if (chat === undefined) return undefined
    if (this.options.worktreesRoot === undefined || chat.projectId === null) {
      return {
        type: 'checkout_status',
        chatId,
        mode: 'current',
        branch: null,
        dirty: false,
        gitRoots: [],
        branches: [],
      }
    }
    const project = await this.options.store.getProject(chat.projectId)
    const mapping = await this.options.store.loadChatWorktrees(chatId)
    const status = await readCheckoutStatus({
      repoPaths: project?.repoPaths ?? [],
      mapping,
      worktreesRoot: this.options.worktreesRoot,
      projectId: project?.id ?? chat.projectId,
      chatId,
    })
    return {
      type: 'checkout_status',
      chatId,
      projectId: chat.projectId,
      mode: status.mode,
      branch: status.branch,
      dirty: status.dirty,
      gitRoots: status.gitRoots,
      branches: status.branches,
      ...(status.leftover === undefined ? {} : { leftover: status.leftover }),
      ...(status.homeBranch === undefined ? {} : { homeBranch: status.homeBranch }),
    }
  }

  private async projectCheckoutStatus(
    projectId: string,
  ): Promise<Extract<ServerMessage, { type: 'checkout_status' }> | undefined> {
    const project = await this.options.store.getProject(projectId)
    if (project === undefined) return undefined
    if (this.options.worktreesRoot === undefined) {
      return {
        type: 'checkout_status',
        projectId,
        mode: 'current',
        branch: null,
        dirty: false,
        gitRoots: [],
        branches: [],
      }
    }
    const status = await readCheckoutStatus({
      repoPaths: project.repoPaths,
      mapping: [],
      worktreesRoot: this.options.worktreesRoot,
      projectId,
    })
    return {
      type: 'checkout_status',
      projectId,
      mode: status.mode,
      branch: status.branch,
      dirty: status.dirty,
      gitRoots: status.gitRoots,
      branches: status.branches,
    }
  }

  private async reconcileProjectWorktrees(
    projectId: string,
    before: readonly string[],
    after: readonly string[],
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const root = this.options.worktreesRoot
    if (root === undefined) return { ok: true }
    const addedRoots = await gitRoots(after.filter((folder) => !before.includes(folder)))
    const dropped = before.filter((folder) => !after.includes(folder))
    const chats = await this.options.store.chatsForProject(projectId)
    const applied: { chatId: string; created: ChatWorktree[] }[] = []

    for (const chat of chats) {
      const outcome = await this.options.orchestrator.runExclusive(chat.id, async () => {
        const mapping = await this.options.store.loadChatWorktrees(chat.id)
        if (mapping.length === 0) return { ok: true as const, skipped: true as const }
        const createdHere: ChatWorktree[] = []
        let switchedHere: { dest: string; previous: string }[] = []
        let next = mapping
        if (addedRoots.length > 0) {
          // A released Session's folder comes back first, so its branch can be read.
          const restored = await restoreWorktrees(mapping)
          if (!restored.ok) return restored
          const branch = await liveWorktreeBranch(mapping)
          if (branch === null) {
            return {
              ok: false as const,
              message: 'This chat\'s worktrees do not share a readable branch, so Manor cannot isolate a new folder onto them.',
            }
          }
          const attached = await attachWorktrees({
            worktreesRoot: root,
            projectId,
            chatId: chat.id,
            repoPaths: addedRoots,
            branch,
          })
          if (!attached.ok) return attached
          createdHere.push(...attached.created)
          switchedHere = [...attached.switched]
          next = [...mapping, ...attached.mapping]
        }
        const kept = next.filter((row) => !dropped.includes(row.sourcePath))
        const gone = next.filter((row) => dropped.includes(row.sourcePath))
        try {
          await this.options.store.replaceChatWorktrees(chat.id, kept)
        } catch (error: unknown) {
          for (const row of createdHere) {
            await removeWorktree(row.sourcePath, row.worktreePath, { force: true })
          }
          await revertSwitches(switchedHere)
          const why = error instanceof Error ? error.message : String(error)
          return { ok: false as const, message: `Manor could not save the worktree mapping: ${why}` }
        }
        for (const row of gone) await removeWorktree(row.sourcePath, row.worktreePath)
        return { ok: true as const, created: createdHere }
      })
      if (!outcome.ok) {
        for (const done of applied.reverse()) {
          await this.options.orchestrator.runExclusive(done.chatId, async () => {
            const current = await this.options.store.loadChatWorktrees(done.chatId)
            if (current.length === 0) {
              for (const row of done.created) {
                await removeWorktree(row.sourcePath, row.worktreePath, { force: true })
              }
              return
            }
            const createdPaths = new Set(done.created.map((row) => row.worktreePath))
            await this.options.store.replaceChatWorktrees(
              done.chatId,
              current.filter((row) => !createdPaths.has(row.worktreePath)),
            )
            for (const row of done.created) {
              await removeWorktree(row.sourcePath, row.worktreePath, { force: true })
            }
          })
        }
        return { ok: false, message: `Those folders could not be added while a chat is isolated: ${outcome.message}` }
      }
      if (outcome.skipped !== true) applied.push({ chatId: chat.id, created: outcome.created })
    }
    return { ok: true }
  }

  private async forgetSessions(projectId: string): Promise<void> {
    const projectChats = await this.options.store.chatsForProject(projectId)
    await this.options.store.clearSessions(projectChats.map((chat) => chat.id))
  }
}

/**
 * Whether a chat gets its own row in the directory. Side chats and child threads are
 * reached through the chat they hang off, so search leaves them out too.
 */
export function isDirectoryChat(chat: Chat): boolean {
  return chat.kind !== 'side' && chat.kind !== 'subagent'
}
