import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { openSqlite, readTransaction, SqliteRecords, transaction } from './sqliteDatabase.js'
import { CONFIRM_REQUEST_PREFIX, HOME_PROJECT_ID, HOME_PROJECT_NAME, PERSONA_TOOLS, SINGLE_CHAT_VOICE, modelTextOf, planProgress } from '@manor/contracts'
import { completionFor, confirmTasks } from '@manor/client-runtime/confirm-tasks'
import { singleRuntime, singleRuntimeRequired } from '../singleChat.js'
import { SqliteTranscript, SqliteBundles } from './sqliteTranscript.js'
import { DEFAULT_PROJECT_COLOR, DEFAULT_PROJECT_ICON, DriverSchema, DEFAULT_SUBAGENT_POLICY, DEFAULT_USER_PROFILE, DEFAULT_HOUSE_SETTINGS, HouseSettingsSchema, ROUTINE_LEASE_MS, SIDE_CHAT_DEFAULTS, driverForModel, type SubagentPolicy, CURRENT_CHECKOUT, checkoutFromMapping, type AgentConfig, type AgentDraft, type Chat, type ChatOverride, type McpServerConfig, type Project, type ProjectIcon, type ProjectMemoryScope, type Routine, type SkillConfig, type ThreadEvent, type UserProfile, type WorkHandoff, isOpenRoom, } from '@manor/contracts'
import { agents as seedAgents } from '../agents.js'
import { sessionChangedFiles } from '../goalReview.js'
import { attachmentFields } from '../handoffAttachments.js'
import { nextRunAfter } from '../routineSchedule.js'
import type { NoteAges } from '../noteMarkers.js'
import { checkChatDraft, checkGroupMembers, checkRoutineDraft, assertEventId, deriveAgentId, isLaterEventId, SIDE_CHAT_TITLE, stampEvent, scrubPersistedEvent, type ChatDraft, type ChatSummary, type ChatWorktree, type ClaimedRoutine, type DraftEvent, type OutboundThreadDecision, type RoutineRunRecord, type Store, ENDED_ROUTINE, RUNNING_ONE_TIME, SUPERSEDED_PROPOSAL, withRoutineDefaults, withUnreadRun, } from '../store.js'
export interface SqliteStoreOptions {
  filename: string
  seed?: boolean
  /** Roster this store hands out; the seed pair from `agents.ts` by default. */
  agents?: readonly AgentConfig[]
  /** Name of the project seeded at construction, so a fresh store is usable. */
  projectName?: string
  /** False refuses a database that needs a migration instead of applying one. Only the server migrates. */
  migrate?: boolean
}
/** The (chat, persona) key the per-pair maps share: CLI sessions and model pins. */
const pairKey = (chatId: string, agentId: string) => `${chatId}::${agentId}`
/** A CLI session's key: its pair plus the provider that minted it, empty when unknown. */
const sessionKey = (chatId: string, agentId: string, driver: AgentConfig['driver'] | undefined) =>
  `${pairKey(chatId, agentId)}::${driver ?? ''}`

/** Routine records, read with the fields older rows predate filled in. */
class RoutineRecords extends SqliteRecords<Routine> {
  override get(key: string): Routine | undefined {
    const routine = super.get(key)
    return routine === undefined ? undefined : withRoutineDefaults(routine)
  }
  override *entries(): IterableIterator<[string, Routine]> {
    for (const [key, routine] of super.entries()) yield [key, withRoutineDefaults(routine)]
  }
}
/**
* A checked draft as a stored persona. Absent optional avatar settings stay absent
* rather than becoming undefined keys, so an uncustomized persona reads here exactly
* the way null columns read in the database.
*/
const toAgent = (draft: AgentDraft, id: string): AgentConfig => ({
  id,
  name: draft.name,
  color: draft.color,
  character: draft.character,
  driver: draft.driver,
  ...(draft.model === undefined ? {} : { model: draft.model }),
  effort: draft.effort,
  ...(draft.speed === 'fast' ? { speed: 'fast' as const } : {}),
  allowedTools: [...PERSONA_TOOLS],
  mcpServers: draft.mcpServers.map((attachment) => ({ ...attachment, disabledTools: [...attachment.disabledTools] })),
  skillIds: [...(draft.skillIds ?? [])],
  mentionAllowlist: [...(draft.mentionAllowlist ?? [])],
  memoryScope: draft.memoryScope,
  description: draft.description,
  role: draft.role,
  isCos: draft.isCos,
  placement: draft.placement ?? 'chat',
  ...(draft.pinned === true ? { pinned: true } : {}),
  ...(draft.railPinned === true ? { railPinned: true } : {}),
  ...(draft.avatar === undefined ? {} : { avatar: draft.avatar }),
  ...(draft.avatarShape === undefined || draft.avatarShape === '' ? {} : { avatarShape: draft.avatarShape }),
  ...(draft.avatarTone === undefined ? {} : { avatarTone: draft.avatarTone }),
})
/** Store operations run synchronously inside one SQLite transaction, then cross the async runtime seam. */
export function createSqliteStore(options: SqliteStoreOptions): Store & {
  db: DatabaseSync
  close: () => void
} {
  const db = openSqlite(options.filename, options.migrate === undefined ? {} : { migrate: options.migrate })
  const pushTokens = new SqliteRecords<boolean>(db, 'pushTokens')
  const roster = new SqliteRecords<AgentConfig>(db, 'agents')
  const projects = new SqliteRecords<Project>(db, 'projects')
  const chats = new SqliteRecords<Chat>(db, 'chats')
  /**
  * When each chat was last picked back up, mirroring the database's `unsettled_at`.
  * Kept beside the chat rather than on it, because the wire contract has no field
  * for it: only the sweep reads it.
  */
  const unsettledAt = new SqliteRecords<number>(db, 'unsettledAt')
  const events = new SqliteTranscript(db)
  /** One Manor-owned rolling summary per chat. */
  const summaries = new SqliteRecords<ChatSummary>(db, 'summaries')
  /** `chatId::agentId::driver` → the CLI session and the canon through which it was seeded. */
  const sessions = new SqliteRecords<{
    sessionId: string
    driver?: AgentConfig['driver']
    seededThroughEventId?: string
  }>(db, 'sessions')
  /** The side chats' own CLI sessions, mirroring the `side_session_id` column. */
  const sideSessions = new SqliteRecords<{
    sessionId: string
    contextEventId?: string
    seededThroughEventId?: string
    parentSeededThroughEventId?: string
  }>(db, 'sideSessions')
  /** Provider/model/effort pins, `chatId::agentId` → the pin, mirroring `chat_overrides`. */
  const pins = new SqliteRecords<ChatOverride>(db, 'pins')
  /** Per-chat worktree mapping, mirroring `chat_worktrees`. Empty is current checkout. */
  const worktrees = new SqliteRecords<ChatWorktree[]>(db, 'worktrees')
  const mcpServers = new SqliteRecords<McpServerConfig>(db, 'mcpServers')
  const skills = new SqliteRecords<SkillConfig>(db, 'skills')
  const skillBundles = new SqliteBundles(db)
  /** Scheduled turns, keyed by id, mirroring the `routines` table. */
  const routines = new RoutineRecords(db, 'routines')
  const workHandoffs = new SqliteRecords<WorkHandoff>(db, 'workHandoffs')
  const outboundThreadDecisions = new SqliteRecords<OutboundThreadDecision>(db, 'outboundThreadDecisions')
  /** Household settings that are one document each, keyed by name. */
  const subagentPolicy = new SqliteRecords<SubagentPolicy>(db, 'subagentPolicy')
  const profile = new SqliteRecords<UserProfile>(db, 'profile')
  const houseSettings = new SqliteRecords<unknown>(db, 'settings')
  const projectSetup = new SqliteRecords<{ version: number }>(db, 'projectSetup')
  const noteAges = new SqliteRecords<NoteAges>(db, 'noteAges')
  let projectCounter = 0
  let chatCounter = 0
  let mcpCounter = 0
  let routineCounter = 0
  let handoffCounter = 0
  const addProject = (name: string, repoPaths?: readonly string[], icon: ProjectIcon = DEFAULT_PROJECT_ICON, color = DEFAULT_PROJECT_COLOR, memoryScope: ProjectMemoryScope = 'project'): Project => {
    projectCounter += 1
    const project = { id: options.filename === ':memory:' ? `project_${projectCounter}` : randomUUID(), name, icon, color, memoryScope, repoPaths: [...(repoPaths ?? [])] }
    projects.set(project.id, project)
    return project
  }
  /**
   * The home room: the memory system as the place a Session without a project works
   * in. Built here rather than stored, so it cannot be listed, renamed or deleted.
   */
  let homeFolders: readonly string[] = []
  const homeProject = (): Project => ({
    id: HOME_PROJECT_ID, name: HOME_PROJECT_NAME, icon: DEFAULT_PROJECT_ICON, color: DEFAULT_PROJECT_COLOR,
    memoryScope: 'knowledge', repoPaths: [...homeFolders],
  })
  const knownRoom = (projectId: string) => projectId === HOME_PROJECT_ID || projects.has(projectId)
  const addChat = (draft: ChatDraft): Chat => {
    const checked = checkChatDraft(draft)
    if (checked.projectId !== null && !knownRoom(checked.projectId)) throw new Error(`unknown project ${checked.projectId}`)
    if (checked.routineId !== null && !routines.has(checked.routineId)) throw new Error(`unknown routine ${checked.routineId}`)
    // A DM is created lazily on first send, so asking twice is normal and answering
    // with the chat that already exists is what the database's partial unique index
    // does under the same request.
    if (checked.kind === 'dm') {
      const existing = [...chats.values()].find((chat) => chat.kind === 'dm' && chat.memberIds[0] === checked.memberIds[0])
      if (existing !== undefined)
        return existing
    }
    if (checked.kind === 'pair') {
      const existing = [...chats.values()].find((chat) => chat.kind === 'pair' &&
        chat.memberIds[0] === checked.memberIds[0] &&
        chat.memberIds[1] === checked.memberIds[1])
      if (existing !== undefined)
        return existing
    }
    // The same lazy shape one parent up: the rail item opens the panel rather than
    // creating it, and the partial unique index is what makes a second open idempotent
    // rather than a second thread.
    if (checked.kind === 'side') {
      if (!chats.has(checked.parentChatId ?? '')) {
        throw new Error(`unknown chat ${checked.parentChatId}`)
      }
      const existing = [...chats.values()].find((chat) => chat.kind === 'side' && chat.parentChatId === checked.parentChatId)
      if (existing !== undefined)
        return existing
    }
    chatCounter += 1
    const createdAt = Date.now()
    const chat: Chat = {
      id: options.filename === ':memory:' ? `chat_${chatCounter}` : randomUUID(),
      projectId: checked.projectId,
      kind: checked.kind,
      mode: checked.mode,
      routineId: checked.routineId,
      parentChatId: checked.parentChatId,
      // Born without either, which reads as the code defaults until somebody picks.
      sideModel: null,
      sideEffort: null,
      memberIds: [...checked.memberIds],
      lastMessagePreview: null,
      title: checked.title ?? 'New chat',
      createdAt,
      lastMessageAt: createdAt,
      // Born settled when the caller asked for it, which only a quiet run does. The
      // inbox already refuses to list a settled chat, so this is the whole of the
      // "a run that wants nothing stays out of the way" rule.
      settledAt: checked.settled ? createdAt : null,
      archivedAt: null,
      agentIds: [],
      checkout: CURRENT_CHECKOUT,
    }
    chats.set(chat.id, chat)
    events.create(chat.id)
    return chat
  }
  const dropChat = (chatId: string): void => {
    // `chats.parent_chat_id` cascades in the database, and this is that cascade: a side
    // chat is a panel on one conversation and has nothing to hang off once it is gone.
    // Before the delete below, so the child is still findable.
    for (const chat of [...chats.values()]) {
      if (chat.parentChatId === chatId)
        dropChat(chat.id)
    }
    // `routines.chat_id on delete cascade`: a schedule targeting this continuing
    // conversation has nowhere to land once the DM is gone.
    for (const routine of [...routines.values()]) {
      if (routine.chatId === chatId)
        dropRoutine(routine.id)
    }
    for (const [handoffId, handoff] of workHandoffs) {
      if (handoff.sourceChatId === chatId) {
        workHandoffs.delete(handoffId)
      }
      else if (handoff.workChatId === chatId) {
        workHandoffs.set(handoffId, {
          ...handoff,
          workChatId: null,
          state: 'deleted',
        })
      }
    }
    // A deleted thread hides its project, the way Hide project does.
    for (const project of [...projects.values()]) {
      if (project.threadChatId === chatId) {
        const { threadChatId: _thread, ...rest } = project
        projects.set(project.id, rest)
      }
    }
    chats.delete(chatId)
    events.delete(chatId)
    summaries.delete(chatId)
    unsettledAt.delete(chatId)
    sideSessions.delete(chatId)
    worktrees.delete(chatId)
    for (const key of [...sessions.keys()]) {
      if (key.startsWith(`${chatId}::`))
        sessions.delete(key)
    }
    for (const key of [...pins.keys()]) {
      if (key.startsWith(`${chatId}::`))
        pins.delete(key)
    }
    // A run still says nothing about its owning project routine. A continuing DM is
    // different: the loop above removes a routine whose explicit target disappeared.
    // It only stops waiting to be read, since there is no longer a run to show.
    for (const routine of [...routines.values()]) {
      if (routine.unreadRunIds.includes(chatId))
        routines.set(routine.id, { ...routine, unreadRunIds: routine.unreadRunIds.filter((id) => id !== chatId) })
    }
  }
  /**
  * A routine and the runs it owns. `chats.routine_id` cascades in the database and
  * this is that cascade: the run threads exist only under their routine, so nothing
  * would list them once it is gone.
  */
  const dropRoutine = (routineId: string): void => {
    routines.delete(routineId)
    for (const chat of [...chats.values()]) {
      if (chat.routineId === routineId)
        dropChat(chat.id)
    }
  }
  const dropAgentRows = (agentId: string): void => {
    for (const key of [...sessions.keys()]) {
      if (key.split('::')[1] === agentId)
        sessions.delete(key)
    }
    for (const key of [...pins.keys()]) {
      if (key.endsWith(`::${agentId}`))
        pins.delete(key)
    }
    // `routines.agent_id` cascades: a schedule addressed to a voice that no longer
    // exists can never run, and its runs go with it.
    for (const routine of [...routines.values()]) {
      if (routine.agentId === agentId)
        dropRoutine(routine.id)
    }
  }
  /** Takes a deleted server out of every persona holding it; see `Store`. */
  const detachEverywhere = (serverId: string): void => {
    for (const [index, agent] of roster.entries()) {
      const kept = agent.mcpServers.filter((attachment) => attachment.serverId !== serverId)
      if (kept.length !== agent.mcpServers.length)
        roster.set(index, { ...agent, mcpServers: kept })
    }
  }
  const detachSkillEverywhere = (skillId: string): void => {
    for (const [index, agent] of roster.entries()) {
      const held = agent.skillIds ?? []
      const kept = held.filter((id) => id !== skillId)
      if (kept.length !== held.length)
        roster.set(index, { ...agent, skillIds: kept })
    }
  }
  const participantsOf = (chatId: string): string[] => events.participants(chatId)
  const singlePin = (pin: ChatOverride | undefined): Pick<Chat, 'singleDriver' | 'singleOverride'> =>
    pin === undefined ? { singleDriver: undefined } : { singleDriver: pin.driver, singleOverride: pin }
  const withCheckout = (chat: Chat): Chat => ({
    ...chat,
    ...(chat.mode === 'single' ? singlePin(pins.get(`${chat.id}::${SINGLE_CHAT_VOICE.id}`)) : {}),
    checkout: checkoutFromMapping(worktrees.get(chat.id) ?? []),
  })
  /** Reads the handoffs once and groups them by Session, for a listing that asks for many chats. */
  const handoffsByChat = (): ((chatId: string) => WorkHandoff[]) => {
    let grouped: Map<string, WorkHandoff[]> | undefined
    return (chatId) => {
      if (grouped === undefined) {
        grouped = new Map()
        for (const row of workHandoffs.values()) if (row.workChatId !== null) grouped.set(row.workChatId, [...grouped.get(row.workChatId) ?? [], row])
      }
      return grouped.get(chatId) ?? []
    }
  }
  const transcriptLine = (chatId: string, handoffsOf = handoffsByChat()) => {
    const { preview, plan, confirm } = events.summary(chatId)
    // Confirm's card ticks off with Git, not with a plan event, so its count is read now,
    // by the rules the card itself draws by. Manor's own request has no turn to wait on.
    const confirmed = confirm === undefined ? undefined : planProgress(confirmTasks(
      confirm.request,
      'running',
      completionFor(handoffsOf(chatId), confirm.eventId),
    ))
    const progress = confirmed ?? plan
    return { lastMessagePreview: preview, ...(progress === undefined ? {} : { planProgress: progress }) }
  }
  if (options.seed) {
    transaction(db, () => {
      for (const agent of options.agents ?? seedAgents)
        roster.set(agent.id, agent)
      const seeded = addProject(options.projectName ?? 'Manor')
      addChat({ projectId: seeded.id })
    })
  }
  /** A published, unconfirmed result in an open Multiple Session can still be reopened. */
  const awaitingFeedback = (held: WorkHandoff): boolean => {
    const room = held.workChatId === null ? undefined : chats.get(held.workChatId)
    // Single has a goal too since 2026-10-11, so its result takes feedback and reopens the same way.
    return held.state === 'active' && room !== undefined && room.settledAt === null && room.archivedAt === null
  }
  /**
   * The one way a published result reopens, for Request changes and for code changed after
   * it: the result, its files and its completion go, the version moves so the old card
   * goes stale, and the source chat gets the reopened receipt.
   */
  const reopenGoal = (held: WorkHandoff, receipt: string, changed = false): { handoff: WorkHandoff; sourceEvent: ThreadEvent } => {
    const { goalReachedAt: _reached, goalReport: _report, goalChangedFiles: _files, goalCompletion: _completion, ...previous } = held
    const handoff = { ...previous, result: null, resultAt: null, version: held.version + 1 }
    workHandoffs.set(held.id, handoff)
    const sourceEvent = operations.appendEvent(held.sourceChatId, {
      type: 'system_note', kind: 'info', text: receipt,
      workHandoffId: held.id, workHandoffVersion: handoff.version, workHandoffPhase: 'reopened',
      ...(changed ? { workChangedAfterReady: true as const } : {}),
    })
    return { handoff, sourceEvent }
  }
  const reopenConfirmedGoal = (held: WorkHandoff): void => {
    const { goalConfirmedAt, ...previous } = held
    if (goalConfirmedAt === undefined) return
    reopenGoal({ ...previous, goalConfirmations: [...(held.goalConfirmations ?? []), {
      confirmedAt: goalConfirmedAt, version: held.version,
      ...(held.goalCompletion === undefined ? {} : { completion: held.goalCompletion }),
    }] }, `New work in “${held.title}”; the previous confirmation stays in its history.`)
  }
  const operations: SyncStore = {
    subscribeHouseholdChanges: (onChange, onError) => {
   let version = Number(db.prepare('PRAGMA data_version').get()?.data_version)
   const timer = setInterval(() => {
    try {
     const current = Number(db.prepare('PRAGMA data_version').get()?.data_version)
     if (current !== version) {
      version = current
      onChange({ resource: 'agents', event: 'reconnect' })
      onChange({ resource: 'routines', event: 'reconnect' })
     }
    } catch (error) { onError(error instanceof Error ? error : new Error('SQLite change check failed')) }
   }, 2000)
   timer.unref()
   return () => clearInterval(timer)
  },
    listPushTokens: () => [...pushTokens.keys()],
    savePushToken(token) {
      pushTokens.set(token, true)
      return undefined
    },
    deletePushToken(token) {
      pushTokens.delete(token)
      return undefined
    },
    getProjectSetup(projectId) {
      const setup = projectSetup.get(projectId)
      return setup === undefined ? undefined : { version: setup.version }
    },
    setProjectSetupVersion(projectId, version) {
      if (projectSetup.get(projectId)?.version !== version) projectSetup.set(projectId, { version })
      return undefined
    },
    loadNoteAges: (projectId) => noteAges.get(projectId) ?? {},
    saveNoteAges(projectId, ages) {
      if (JSON.stringify(noteAges.get(projectId) ?? {}) !== JSON.stringify(ages)) noteAges.set(projectId, ages)
      return undefined
    },
    listProjects: () => [...projects.values()],
    setHomeFolders(repoPaths) {
      homeFolders = [...repoPaths]
      return undefined
    },
    // Newest activity first, the way the database orders it, each chat carrying who
    // has worked in it — read off the transcript here, off `chat_participants` there.
    listChats: () => {
      const handoffsOf = handoffsByChat()
      return [...chats.values()]
        .sort((a, b) => b.lastMessageAt - a.lastMessageAt)
        // Invited beats spoken: a dm or a group already knows who is in it, so its
        // avatars are complete from the moment it is made.
        .map((chat) => withCheckout({
        ...chat,
        agentIds: isOpenRoom(chat) ? participantsOf(chat.id) : [...chat.memberIds],
        ...transcriptLine(chat.id, handoffsOf),
      }))
    },
    createProject: (name, repoPaths, icon, color, memoryScope) => addProject(name, repoPaths, icon, color, memoryScope),
    createChat: (draft) => addChat(draft),
    pairChatFor: (firstAgentId, secondAgentId) => addChat({ kind: 'pair', memberIds: [firstAgentId, secondAgentId] }),
    sideChatOf: (parentChatId) => [...chats.values()].find((chat) => chat.kind === 'side' && chat.parentChatId === parentChatId),
    sideChatFor: (parentChatId) => addChat({ kind: 'side', parentChatId, title: SIDE_CHAT_TITLE }),
    createSubagentChat(parentChatId, title, subagent) {
      if (!chats.has(parentChatId))
        throw new Error(`unknown chat ${parentChatId}`)
      chatCounter += 1
      const createdAt = Date.now()
      const chat: Chat = {
        id: options.filename === ':memory:' ? `chat_${chatCounter}` : randomUUID(),
        projectId: null,
        kind: 'subagent',
        routineId: null,
        parentChatId,
        subagent: { ...subagent },
        sideModel: null,
        sideEffort: null,
        memberIds: [],
        lastMessagePreview: null,
        title,
        createdAt,
        lastMessageAt: createdAt,
        // Nothing to dismiss: the child is read through its parent, never from the inbox.
        settledAt: createdAt,
        archivedAt: null,
        agentIds: [],
        checkout: CURRENT_CHECKOUT,
      }
      chats.set(chat.id, chat)
      events.create(chat.id)
      return chat
    },
    endSubagent(chatId, ending) {
      const chat = chats.get(chatId)
      if (chat?.subagent === undefined)
        return undefined
      if (chat.subagent.state !== 'running')
        return { ...chat }
      const subagent = {
        ...chat.subagent,
        state: ending.state,
        ...(ending.reason === undefined ? {} : { reason: ending.reason }),
        ...(ending.endedAt === undefined ? {} : { endedAt: ending.endedAt }),
      }
      chats.set(chatId, { ...chat, subagent })
      return { ...chat, subagent }
    },
    getSubagentPolicy: () => subagentPolicy.get('current') ?? DEFAULT_SUBAGENT_POLICY,
    saveSubagentPolicy(policy) {
      subagentPolicy.set('current', policy)
      return policy
    },
    getProfile: () => profile.get('current') ?? DEFAULT_USER_PROFILE,
    getHouseSettings() {
      // Parsed on read, so a key added after the save reads its default. A record that
      // no longer parses is left on disk for repair and the defaults stand in.
      const saved = HouseSettingsSchema.safeParse(houseSettings.get('house') ?? {})
      return saved.success ? saved.data : DEFAULT_HOUSE_SETTINGS
    },
    saveHouseSettings(next) {
      houseSettings.set('house', next)
      return next
    },
    saveProfile(next) {
      profile.set('current', next)
      return next
    },
    setSideRuntime(chatId, model, effort) {
      const chat = chats.get(chatId)
      if (chat === undefined)
        throw new Error(`unknown chat ${chatId}`)
      chats.set(chatId, { ...chat, sideModel: model, sideEffort: effort })
      // The session goes with the pick, the way the column does: an id minted by one
      // CLI means nothing to the next.
      sideSessions.delete(chatId)
      return undefined
    },
    getSideSession(chatId) {
      const held = sideSessions.get(chatId)
      if (held === undefined)
        return undefined
      const chat = chats.get(chatId)
      // Derived rather than stored, and exact because changing the pick drops the
      // session in the same breath.
      const driver = driverForModel(chat?.sideModel ?? SIDE_CHAT_DEFAULTS.model)
      return { ...held, ...(driver === undefined ? {} : { driver }) }
    },
    setSideSession(chatId, sessionId, meta) {
      sideSessions.set(chatId, {
        sessionId,
        ...(meta?.contextEventId === undefined ? {} : { contextEventId: meta.contextEventId }),
        ...(meta?.seededThroughEventId === undefined
          ? {}
          : { seededThroughEventId: meta.seededThroughEventId }),
        ...(meta?.parentSeededThroughEventId === undefined
          ? {}
          : { parentSeededThroughEventId: meta.parentSeededThroughEventId }),
      })
      return undefined
    },
    clearSideSession(chatId) {
      sideSessions.delete(chatId)
      return undefined
    },
    getChat(chatId) {
      const chat = chats.get(chatId)
      return chat === undefined
        ? undefined
        : withCheckout({
          ...chat,
          agentIds: isOpenRoom(chat) ? participantsOf(chat.id) : [...chat.memberIds],
          ...transcriptLine(chat.id),
        })
    },
    setChatMembers(chatId, memberIds) {
      const chat = chats.get(chatId)
      if (chat === undefined)
        throw new Error(`unknown chat ${chatId}`)
      if (chat.kind !== 'group')
        throw new Error('only a group chat has an editable membership')
      chats.set(chatId, { ...chat, memberIds: checkGroupMembers(memberIds) })
      return undefined
    },
    deleteProject(projectId) {
      if (projectId === HOME_PROJECT_ID) throw new Error('the home room is built in and cannot be deleted')
      // Mirrors `routines.project_id on delete cascade`; dropping the routine then
      // drops its run chats through the same ownership path.
      for (const routine of [...routines.values()]) {
        if (routine.projectId === projectId)
          dropRoutine(routine.id)
      }
      for (const chat of [...chats.values()]) {
        if (chat.projectId === projectId)
          dropChat(chat.id)
      }
      for (const [id, handoff] of workHandoffs) {
        if (handoff.projectId === projectId) workHandoffs.set(id, { ...handoff, state: 'deleted' })
      }
      projectSetup.delete(projectId)
      noteAges.delete(projectId)
      projects.delete(projectId)
      return undefined
    },
    reorderProjects(projectIds) {
      // The whole list or nothing. Rebuilding the collection from a partial list would
      // delete the projects it forgot to mention.
      const ordered = projectIds.map((projectId) => projects.get(projectId))
      if (ordered.some((project) => project === undefined) || new Set(projectIds).size !== projects.size) {
        throw new Error('project order must name every project exactly once')
      }
      projects.clear()
      for (const project of ordered) {
        if (project !== undefined)
          projects.set(project.id, project)
      }
      return undefined
    },
    updateProject(projectId, name, repoPaths, icon, color, memoryScope) {
      const project = projects.get(projectId)
      // An update naming a project nobody holds is a no-op here the way it is one
      // row-count in the database; the service refuses it before it gets this far.
      if (project === undefined)
        return undefined
      projects.set(projectId, {
        id: project.id,
        name,
        icon: icon ?? project.icon,
        color: color ?? project.color,
        memoryScope: memoryScope ?? project.memoryScope,
        repoPaths: [...repoPaths],
        ...(project.threadChatId === undefined ? {} : { threadChatId: project.threadChatId }),
        ...(project.unlisted === undefined ? {} : { unlisted: project.unlisted }),
        ...(project.verifySkills === undefined ? {} : { verifySkills: project.verifySkills }),
      })
      return undefined
    },
    setProjectThread(projectId, chatId) {
      const project = projects.get(projectId)
      if (project === undefined) throw new Error(`unknown project ${projectId}`)
      if (chatId !== null && chats.get(chatId)?.projectId !== projectId) throw new Error(`chat ${chatId} is not in project ${projectId}`)
      const { threadChatId: _thread, ...rest } = project
      projects.set(projectId, chatId === null ? rest : { ...rest, threadChatId: chatId })
      return undefined
    },
    setProjectUnlisted(projectId, unlisted) {
      const project = projects.get(projectId)
      if (project === undefined) throw new Error(`unknown project ${projectId}`)
      const { unlisted: _unlisted, ...rest } = project
      projects.set(projectId, unlisted ? { ...rest, unlisted: true } : rest)
      return undefined
    },
    setProjectVerifySkills(projectId, answer) {
      const project = projects.get(projectId)
      if (project === undefined) throw new Error(`unknown project ${projectId}`)
      // A no stays: a yes from another Session that finishes later does not reopen the offer.
      if (project.verifySkills !== 'declined') projects.set(projectId, { ...project, verifySkills: answer })
      return undefined
    },
    getProject(projectId) {
      return projectId === HOME_PROJECT_ID ? homeProject() : projects.get(projectId)
    },
    chatsForProject(projectId) {
      return [...chats.values()].filter((chat) => chat.projectId === projectId)
    },
    setChatTitle(chatId, title) {
      const chat = chats.get(chatId)
      if (chat === undefined)
        throw new Error(`unknown chat ${chatId}`)
      chats.set(chatId, { ...chat, title })
      return undefined
    },
    setChatSettled(chatId, settled) {
      const chat = chats.get(chatId)
      if (chat === undefined)
        throw new Error(`unknown chat ${chatId}`)
      const now = Date.now()
      // Picking a chat back up records when, the way the database column does, so
      // the sweep below can tell a rescue from a chat nobody has touched.
      if (!settled)
        unsettledAt.set(chatId, now)
      chats.set(chatId, { ...chat, settledAt: settled ? now : null,
        ...(settled ? { legacySessionAgentIds: undefined } : {}),
      })
      return undefined
    },
    settleIdleChats(cutoff) {
      const now = Date.now()
      const moved: string[] = []
      const pendingWork = new Set([...workHandoffs.values()]
        .filter((handoff) => handoff.acceptedAt === null && handoff.state === 'active')
        .map((handoff) => handoff.workChatId))
      // A project thread is the project's standing room, never an inbox item to settle.
      for (const project of projects.values()) {
        if (project.threadChatId !== undefined) pendingWork.add(project.threadChatId)
      }
      for (const chat of [...chats.values()]) {
        // A dm and a group are endless threads, never an inbox item, so the sweep
        // never stamps one. Belt to the UI's braces: a stamp written before this
        // rule existed is ignored there rather than corrected here.
        if (chat.kind !== 'project' || pendingWork.has(chat.id))
          continue
        if (chat.settledAt !== null || chat.lastMessageAt >= cutoff)
          continue
        const rescued = unsettledAt.get(chat.id)
        if (rescued !== undefined && rescued >= cutoff)
          continue
        chats.set(chat.id, { ...chat, settledAt: now, legacySessionAgentIds: undefined })
        moved.push(chat.id)
      }
      return moved
    },
    setChatArchived(chatId, archived) {
      const chat = chats.get(chatId)
      if (chat === undefined)
        throw new Error(`unknown chat ${chatId}`)
      chats.set(chatId, { ...chat, archivedAt: archived ? Date.now() : null })
      return undefined
    },
    deleteExpiredArchivedChats(cutoff) {
      const deleted: string[] = []
      // A hidden project keeps its thread archived until the user adds it back; that is not a Session to expire.
      const threads = new Set([...projects.values()].map((project) => project.threadChatId))
      for (const chat of [...chats.values()]) {
        if (chat.kind !== 'project' || chat.archivedAt === null || chat.archivedAt > cutoff || threads.has(chat.id))
          continue
        const side = [...chats.values()].find((candidate) => candidate.parentChatId === chat.id)
        deleted.push(chat.id, ...(side === undefined ? [] : [side.id]))
        dropChat(chat.id)
      }
      return deleted
    },
    deleteChat(chatId) {
      dropChat(chatId)
      return undefined
    },
    listWorkHandoffs: () => [...workHandoffs.values()].map((row) => ({ ...row })),
    workHandoffForSourceTurn(sourceChatId, sourceTurnId) {
      return [...workHandoffs.values()].find((row) => row.sourceChatId === sourceChatId && row.sourceTurnId === sourceTurnId && row.version > 0)
    },
    workHandoffForTarget(workChatId) {
      return [...workHandoffs.values()].find((row) => row.workChatId === workChatId)
    },
    reserveWorkHandoff(draft) {
      const existing = [...workHandoffs.values()].find((row) => row.sourceChatId === draft.sourceChatId && row.sourceTurnId === draft.sourceTurnId && (row.assignmentKey ?? 'default') === (draft.assignmentKey ?? 'default'))
      if (existing !== undefined)
        return { handoff: { ...existing }, created: false }
      const handoff: WorkHandoff = {
        id: options.filename === ':memory:' ? `handoff_${(handoffCounter += 1)}` : randomUUID(),
        sourceChatId: draft.sourceChatId,
        sourceTurnId: draft.sourceTurnId,
        assignmentKey: draft.assignmentKey ?? 'default',
        ...(draft.task === undefined ? {} : { task: draft.task }),
        ...(draft.summary === undefined ? {} : { summary: draft.summary }),
        ...(draft.kickoff === undefined ? {} : { kickoff: draft.kickoff }),
        ...(draft.authorAgentId === undefined ? {} : { authorAgentId: draft.authorAgentId }),
        workChatId: null,
        projectId: draft.projectId,
        projectName: draft.projectName,
        title: draft.title,
        leadAgentId: draft.leadAgentId,
        leadAgentName: draft.leadAgentName,
        ...(draft.firstExecutor === undefined ? {} : { firstExecutor: draft.firstExecutor }),
        supportingAgentIds: [...draft.supportingAgentIds],
        supportingAgentNames: [...draft.supportingAgentNames],
        ...(draft.proposedRuntime === undefined ? {} : { proposedRuntime: draft.proposedRuntime }),
        ...(draft.attachments === undefined || draft.attachments.length === 0 ? {} : { attachments: [...draft.attachments] }),
        state: 'active',
        result: null,
        resultAt: null,
        version: 0,
        ...(draft.revision === undefined || draft.revision <= 1 ? {} : { revision: draft.revision }),
        createdAt: Date.now(),
        acceptedAt: null,
      }
      workHandoffs.set(handoff.id, handoff)
      return { handoff: { ...handoff }, created: true }
    },
    removeWorkGoal(handoffId) {
      const handoff = workHandoffs.get(handoffId)
      if (handoff === undefined) return undefined
      workHandoffs.set(handoffId, { ...handoff, state: 'deleted', workChatId: null, version: handoff.version + 1 })
      return undefined
    },
    finalizeWorkHandoff(handoffId, workChatId, note) {
      const handoff = workHandoffs.get(handoffId)
      if (handoff === undefined)
        throw new Error(`unknown work handoff ${handoffId}`)
      if (handoff.version > 0)
        return { ...handoff }
      if (workChatId !== null && !chats.has(workChatId))
        throw new Error(`unknown chat ${workChatId}`)
      const sourceEvents = chats.has(handoff.sourceChatId) ? events.tail(handoff.sourceChatId) : undefined
      if (sourceEvents === undefined)
        throw new Error(`unknown chat ${handoff.sourceChatId}`)
      const saved = { ...handoff, workChatId, version: 1 }
      workHandoffs.set(handoffId, saved)
      const event = stampEvent({ ...note, workHandoffVersion: saved.version }, sourceEvents)
      events.append(handoff.sourceChatId, event)
      const source = chats.get(handoff.sourceChatId)
      if (source !== undefined)
        chats.set(source.id, { ...source, lastMessageAt: event.ts })
      return { ...saved }
    },
    transitionWorkHandoff(handoffId, transition, note) {
      const handoff = workHandoffs.get(handoffId)
      if (handoff === undefined)
        throw new Error(`unknown work handoff ${handoffId}`)
      if (handoff.state === transition.state)
        return { ...handoff }
      const sourceEvents = chats.has(handoff.sourceChatId) ? events.tail(handoff.sourceChatId) : undefined
      if (sourceEvents === undefined)
        throw new Error(`unknown chat ${handoff.sourceChatId}`)
      const saved: WorkHandoff = { ...handoff, ...transition, version: handoff.version + 1 }
      workHandoffs.set(handoffId, saved)
      const event = stampEvent({ ...note, workHandoffVersion: saved.version }, sourceEvents)
      events.append(handoff.sourceChatId, event)
      const source = chats.get(handoff.sourceChatId)
      if (source !== undefined)
        chats.set(source.id, { ...source, lastMessageAt: event.ts })
      return { ...saved }
    },
    linkWorkHandoff(handoffId, link, note) {
      const handoff = workHandoffs.get(handoffId)
      if (handoff === undefined)
        throw new Error(`unknown work handoff ${handoffId}`)
      const saved: WorkHandoff = { ...handoff, ...link, version: note === undefined ? handoff.version : handoff.version + 1 }
      if (note !== undefined) {
        const sourceEvents = chats.has(handoff.sourceChatId) ? events.tail(handoff.sourceChatId) : undefined
        if (sourceEvents === undefined)
          throw new Error(`unknown chat ${handoff.sourceChatId}`)
        workHandoffs.set(handoffId, saved)
        const event = stampEvent({ ...note, workHandoffVersion: saved.version }, sourceEvents)
        events.append(handoff.sourceChatId, event)
        const source = chats.get(handoff.sourceChatId)
        if (source !== undefined)
          chats.set(source.id, { ...source, lastMessageAt: event.ts })
      } else {
        workHandoffs.set(handoffId, saved)
      }
      return { ...saved }
    },
    transitionWorkLifecycle(chatId, handoffId, transition, note, landed) {
      const chat = chats.get(chatId)
      if (chat === undefined)
        throw new Error(`unknown chat ${chatId}`)
      const handoff = workHandoffs.get(handoffId)
      if (handoff === undefined)
        throw new Error(`unknown work handoff ${handoffId}`)
      if (handoff.workChatId !== chatId)
        throw new Error(`work handoff ${handoffId} does not target ${chatId}`)
      if (chat.archivedAt !== null)
        return { ...handoff }
      const held = handoff.goalCompletion
      if (landed !== undefined && (handoff.goalConfirmedAt !== landed.goalConfirmedAt || handoff.unsettledAt !== undefined ||
        held?.status !== 'complete' || (held.retries?.at(-1) ?? held.requestEventId) !== landed.attempt))
        return { ...handoff }
      const sourceEvents = chats.has(handoff.sourceChatId) ? events.tail(handoff.sourceChatId) : undefined
      if (sourceEvents === undefined)
        throw new Error(`unknown chat ${handoff.sourceChatId}`)
      const now = Date.now()
      const settled = transition.state === 'settled'
      if (!settled)
        unsettledAt.set(chatId, now)
      chats.set(chatId, { ...chat, settledAt: settled ? now : null,
        ...(settled ? { legacySessionAgentIds: undefined } : {}),
      })
      // A confirmed result counts as settled by itself, so taking it out of Settled is
      // recorded on the handoff; settling it again drops the record.
      const { unsettledAt: priorUnsettle, ...settledHandoff } = handoff
      const next: WorkHandoff = settled ? settledHandoff
        : handoff.goalConfirmedAt === undefined ? handoff
        : { ...handoff, unsettledAt: priorUnsettle ?? now }
      if (handoff.state === transition.state) {
        workHandoffs.set(handoffId, next)
        return { ...next }
      }
      const saved: WorkHandoff = { ...next, ...transition, version: handoff.version + 1 }
      workHandoffs.set(handoffId, saved)
      const event = stampEvent({ ...note, workHandoffVersion: saved.version }, sourceEvents)
      events.append(handoff.sourceChatId, event)
      const source = chats.get(handoff.sourceChatId)
      if (source !== undefined)
        chats.set(source.id, { ...source, lastMessageAt: event.ts })
      return { ...saved }
    },
    recordWorkOutcome(handoffId, version, result, text) {
      const handoff = workHandoffs.get(handoffId)
      if (handoff === undefined || handoff.version !== version || handoff.state !== 'settled' || handoff.result !== null)
        return undefined
      const saved: WorkHandoff = { ...handoff, result }
      workHandoffs.set(handoffId, saved)
      const note = chats.has(handoff.sourceChatId)
        ? [...events.get(handoff.sourceChatId)].reverse().find((event) =>
          event.type === 'system_note' && event.workHandoffId === handoffId && event.workHandoffVersion === version)
        : undefined
      if (note?.type === 'system_note') operations.replaceEvent(handoff.sourceChatId, { ...note, text })
      return { ...saved }
    },
    materializeWorkHandoff(handoffId, runtime, edit, attachments) {
      const held = workHandoffs.get(handoffId)
      if (held === undefined) throw new Error(`unknown work handoff ${handoffId}`)
      const handoff = edit === undefined || held.workChatId !== null ? held : { ...held, task: edit }
      if (handoff.supersededById !== undefined) throw new Error(SUPERSEDED_PROPOSAL)
      if (handoff.state !== 'active') throw new Error('This session is no longer awaiting acceptance.')
      if (handoff.workChatId !== null) return handoff
      if (handoff.acceptedAt !== null) throw new Error('The accepted session no longer exists.')
      const task = handoff.task ?? handoff.kickoff
      if (!task) throw new Error('This session has no stored task.')
      if (runtime !== undefined && handoff.task === undefined) {
        throw new Error('This older proposal has a prewritten persona kickoff. Create a new session proposal to choose Single.')
      }
      const pin = runtime === undefined ? undefined : singleRuntime(runtime)
      const target = addChat({ kind: 'project', projectId: handoff.projectId, title: handoff.title,
        ...(pin === undefined ? {} : { mode: 'single' }),
      })
      if (pin !== undefined) operations.setChatOverride(target.id, SINGLE_CHAT_VOICE.id, pin)
      operations.appendEvent(target.id, {
        type: 'user_message', text: task, mentions: [], source: 'work_handoff',
        ...(pin === undefined ? {} : { instruction: `[Manor] Session accepted as Single with ${pin.model}. Complete the task below in this session.\n\n` }),
        ...attachmentFields(attachments),
        workHandoffId: handoff.id, workSourceChatId: handoff.sourceChatId,
        workAuthorAgentId: handoff.authorAgentId ?? handoff.leadAgentId,
        workAuthorAgentName: roster.get(handoff.authorAgentId ?? handoff.leadAgentId)?.name,
        ...(projects.get(handoff.projectId)?.threadChatId === handoff.sourceChatId
          ? { workProjectName: projects.get(handoff.projectId)!.name } : {}),
        ...(pin === undefined ? {
          ...(handoff.firstExecutor === undefined ? {} : { workFirstExecutorAgentId: handoff.firstExecutor.agentId }),
          workSupportingAgentIds: handoff.supportingAgentIds, workTargetLeadId: handoff.leadAgentId,
        } : {}),
      })
      const saved = { ...handoff, workChatId: target.id }
      workHandoffs.set(handoffId, saved)
      return saved
    },
    resetWorkHandoffTarget(handoffId) {
      const handoff = workHandoffs.get(handoffId)
      if (handoff === undefined || handoff.acceptedAt !== null || handoff.workChatId === null || !(handoff.task ?? handoff.kickoff)) return
      const chatId = handoff.workChatId
      const transcript = events.get(chatId)
      if (transcript.length !== 1 || transcript[0]?.type !== 'user_message' || transcript[0].workHandoffId !== handoffId) return
      if ((worktrees.get(chatId)?.length ?? 0) > 0) return
      workHandoffs.set(handoffId, { ...handoff, workChatId: null })
      dropChat(chatId)
    },
    acceptWorkHandoff(workChatId, startBranches) {
      const handoff = [...workHandoffs.values()].find((row) => row.workChatId === workChatId)
      if (handoff === undefined)
        throw new Error(`unknown work handoff for ${workChatId}`)
      if (handoff.acceptedAt !== null)
        return { ...handoff }
      const saved: WorkHandoff = { ...handoff, acceptedAt: Date.now(), ...(startBranches === undefined || startBranches.length === 0 ? {} : { startBranches }) }
      workHandoffs.set(handoff.id, saved)
      return { ...saved }
    },
    reachWorkGoal(handoffId, note, evidence = [], changedFiles) {
      const handoff = workHandoffs.get(handoffId)
      if (handoff === undefined)
        throw new Error(`unknown work handoff ${handoffId}`)
      if (handoff.workChatId === null)
        throw new Error(`work handoff ${handoffId} has no Work chat`)
      if (handoff.goalReachedAt !== undefined)
        return undefined
      const saved: WorkHandoff = { ...handoff, goalReachedAt: Date.now(),
        ...(note.goalCompletion === undefined ? {} : { goalCompletion: note.goalCompletion }),
        ...(note.goalReport === undefined ? {} : {
          goalReport: note.goalReport, goalChangedFiles: changedFiles === undefined ? sessionChangedFiles(events.get(handoff.workChatId)) : [...changedFiles],
          version: handoff.version + 1,
        }),
      }
      workHandoffs.set(handoff.id, saved)
      if (note.goalReport !== undefined) {
        operations.appendEvent(handoff.sourceChatId, {
          type: 'system_note', kind: 'info', text: [note.goalReport.result, note.goalReport.limitations].filter(Boolean).join('\n'),
          workHandoffId: handoff.id, workHandoffVersion: saved.version,
        })
      }
      // The screenshots live in the Session's own store, written with its note.
      return operations.appendEvent(handoff.workChatId, {
        ...note, ...(note.goalReport === undefined ? {} : { workHandoffVersion: saved.version }),
      }, evidence)
    },
    reviseWorkGoal(handoffId, version, text, images = []) {
      const held = workHandoffs.get(handoffId)
      if (held === undefined || held.workChatId === null) throw new Error('This Session is no longer available.')
      if (held.goalConfirmedAt !== undefined) throw new Error('This result has already been confirmed. Start a new assignment for further changes.')
      if (held.version !== version || held.goalReachedAt === undefined) throw new Error('This result has changed. Read the current result before responding.')
      if (!awaitingFeedback(held)) throw new Error('This Session is no longer awaiting feedback.')
      const feedback = text.trim()
      if (!feedback || feedback.length > 40_000) throw new Error('Describe the requested change in at most 40,000 characters.')
      // The feedback lives only in the Session; the DM card reads the reopen note as Working.
      const { handoff, sourceEvent } = reopenGoal(held, `Changes requested for “${held.title}”.`)
      const lead = roster.get(held.leadAgentId)?.name ?? held.leadAgentName
      // A line of prose reads on with the mention. Anything longer, or a single line that
      // is itself a Markdown block, starts below it, or the mention turns its first line into prose.
      const block = feedback.includes('\n') || /^(?:[-*+] |\d+[.)] |#{1,6} |> ?|\|)/.test(feedback)
      const separator = block ? '\n\n' : ' '
      // A Single Session's one voice takes it unaddressed; a persona mention would reach nobody there.
      const single = chats.get(held.workChatId)?.mode === 'single'
      const event = operations.appendEvent(held.workChatId, {
        type: 'user_message', text: single ? feedback : `@${lead}${separator}${feedback}`, mentions: single ? [] : [held.leadAgentId], dispatchState: 'pending',
        ...(images.length > 0 ? { images } : {}),
      })
      if (event.type !== 'user_message') throw new Error('Could not store the feedback.')
      return { handoff, event, sourceEvents: [sourceEvent] }
    },
    reopenWorkGoal(handoffId, version, note) {
      const held = workHandoffs.get(handoffId)
      if (held?.workChatId == null || held.goalConfirmedAt !== undefined || held.goalReachedAt === undefined ||
        held.version !== version || !awaitingFeedback(held)) return undefined
      const { handoff, sourceEvent } = reopenGoal(held, `“${held.title}” reopened because code changed after its result.`, true)
      return { handoff, sourceEvent, event: operations.appendEvent(held.workChatId, { type: 'system_note', kind: 'info', text: note }) }
    },
    confirmWorkGoal(handoffId, version, completion, request, confirmRequest) {
      const handoff = workHandoffs.get(handoffId)
      if (handoff === undefined)
        throw new Error(`unknown work handoff ${handoffId}`)
      if (handoff.goalReport !== undefined && handoff.version !== version)
        throw new Error('This result has changed. Read the current result before confirming it.')
      if (handoff.goalConfirmedAt !== undefined)
        return false
      if (handoff.goalReachedAt === undefined)
        throw new Error('Nobody has marked this goal reached yet.')
      if (request !== undefined && completion !== undefined && handoff.workChatId !== null) {
        // A Single Session's one voice takes it unaddressed; a persona mention would reach nobody there.
        const single = chats.get(handoff.workChatId)?.mode === 'single'
        // A request Manor runs itself is claimed from the start: no turn may pick it up,
        // and a restart mid-commit reads it as interrupted.
        const event = operations.appendEvent(handoff.workChatId, {
          type: 'user_message', text: '', instruction: request, mentions: single ? [] : [handoff.leadAgentId],
          dispatchState: confirmRequest?.manor === true ? 'started' : 'pending',
          ...(confirmRequest === undefined ? {} : { confirmRequest }),
        })
        completion = { ...completion, requestEventId: event.id }
      }
      const { unsettledAt: _unsettled, ...current } = handoff
      workHandoffs.set(handoff.id, { ...current, goalConfirmedAt: Date.now(),
        ...(completion === undefined ? {} : { goalCompletion: completion }),
      })
      if (completion?.status === 'complete' && handoff.workChatId !== null) {
        const room = chats.get(handoff.workChatId)
        if (room !== undefined) chats.set(room.id, { ...room, legacySessionAgentIds: undefined })
      }
      return true
    },
    updateWorkCompletion(handoffId, completion) {
      const handoff = workHandoffs.get(handoffId)
      const past = handoff?.goalConfirmations?.findIndex((round) => round.completion?.requestEventId === completion.requestEventId)
      if (handoff !== undefined && completion.requestEventId !== undefined && past !== undefined && past >= 0) {
        workHandoffs.set(handoffId, { ...handoff, goalConfirmations: handoff.goalConfirmations?.map((round, index) =>
          index === past ? { ...round, completion } : round) })
        return
      }
      if (handoff?.goalConfirmedAt === undefined || handoff.goalCompletion === undefined) throw new Error('No accepted result to finish.')
      if (handoff.goalCompletion.requestEventId !== completion.requestEventId) throw new Error('The accepted result changed.')
      workHandoffs.set(handoffId, { ...handoff, goalCompletion: completion })
      if (completion.status === 'complete' && handoff.workChatId !== null) {
        const room = chats.get(handoff.workChatId)
        if (room !== undefined) chats.set(room.id, { ...room, legacySessionAgentIds: undefined })
      }
    },
    retryWorkCompletion(handoffId, requestEventId, request, confirmRequest, from = 'blocked') {
      const handoff = workHandoffs.get(handoffId)
      const held = handoff?.goalCompletion
      if (handoff === undefined || handoff.goalConfirmedAt === undefined || held === undefined || handoff.workChatId === null ||
        held.requestEventId !== requestEventId || held.status !== from) {
        throw new Error(from === 'blocked' ? 'This merge is no longer blocked.' : 'This commit is no longer Manor\'s to hand over.')
      }
      const single = chats.get(handoff.workChatId)?.mode === 'single'
      const event = operations.appendEvent(handoff.workChatId, {
        type: 'user_message', text: '', instruction: request, mentions: single ? [] : [handoff.leadAgentId], dispatchState: 'pending', confirmRequest,
      })
      if (event.type !== 'user_message') throw new Error('Could not store the retry.')
      // Retry starts the commit afresh, and Manor's own merge after it with a new budget.
      const { retryRefused: _refused, message: _message, merge: _merge, ...rest } = held
      const saved = { ...handoff, goalCompletion: { ...rest, status: 'pending' as const, retries: [...held.retries ?? [], event.id] } }
      workHandoffs.set(handoffId, saved)
      return { handoff: { ...saved }, event }
    },
    // Read through `PERSONA_TOOLS` rather than as stored: a row saved under tool groups
    // may hold a narrower list, and no driver may keep honouring it.
    loadRoster: () => [...roster.values()].map((agent) => ({ ...agent, allowedTools: [...PERSONA_TOOLS] })),
    saveAgent(draft: AgentDraft) {
      const at = draft.id === undefined ? -1 : ([...roster.values()].findIndex((agent) => agent.id === draft.id))
      // An update naming an id nobody holds throws the way the database's own
      // "no row matched" does, rather than quietly creating a second persona.
      if (draft.id !== undefined && at === -1)
        throw new Error(`unknown agent ${draft.id}`)
      const id = draft.id ?? deriveAgentId(draft.name, [...roster.values()].map((agent) => agent.id))
      const saved = toAgent({ ...draft, placement: draft.placement ?? roster.get(id)?.placement }, id)
      // Cleared before the saved persona lands rather than after: a moment with no
      // chief of staff is a state Manor already handles, a moment with two is not.
      if (saved.isCos) {
        for (const [index, agent] of roster.entries()) {
          if (agent.id !== id && agent.isCos)
            roster.set(index, { ...agent, isCos: false })
        }
      }
      roster.set(id, saved)
      return saved
    },
    deleteAgent(agentId) {
      roster.delete(agentId)
      // `agent_sessions.agent_id` cascades in the database, so a deleted persona takes
      // its CLI sessions with it here too; a resurrected name must start fresh.
      dropAgentRows(agentId)
      for (const chat of [...chats.values()]) {
        if (chat.kind === 'pair' && chat.memberIds.includes(agentId))
          dropChat(chat.id)
      }
      return undefined
    },
    listMcpServers: () => [...mcpServers.values()],
    saveMcpServer(draft, probed) {
      if (draft.id !== undefined && !mcpServers.has(draft.id)) throw new Error(`unknown MCP server ${draft.id}`)
      const id = draft.id ?? (options.filename === ':memory:' ? `mcp_${(mcpCounter += 1)}` : randomUUID())
      const server: McpServerConfig = {
        id,
        name: draft.name,
        command: draft.command,
        args: [...draft.args],
        envKeys: [...draft.envKeys],
        ...(draft.httpHeaders === undefined ? {} : { httpHeaders: draft.httpHeaders.map((header) => ({ ...header })) }),
        ...(draft.url !== undefined && draft.url.trim().length > 0 ? { url: draft.url.trim() } : {}),
        description: draft.description,
        writes: draft.writes,
        effectPolicy: draft.effectPolicy,
        tools: [...probed.tools],
        readOnlyTools: [...probed.readOnlyTools],
        schemaChars: probed.schemaChars,
      }
      mcpServers.set(id, server)
      return server
    },
    deleteMcpServer(serverId) {
      mcpServers.delete(serverId)
      detachEverywhere(serverId)
      return undefined
    },
    listSkills: () => [...skills.values()],
    saveSkill(skill, bundle = []) {
      const saved: SkillConfig = { ...skill, sources: [...skill.sources] }
      skills.set(saved.id, saved)
      skillBundles.set(saved.id, bundle.map((file) => ({ ...file, bytes: file.bytes.slice() })))
      return saved
    },
    loadSkillBundle(skillId) {
      return (skillBundles.get(skillId) ?? []).map((file) => ({ ...file, bytes: file.bytes.slice() }))
    },
    deleteSkill(skillId) {
      skills.delete(skillId)
      skillBundles.delete(skillId)
      detachSkillEverywhere(skillId)
      return undefined
    },
    loadEvents: (chatId) => events.get(chatId) ?? [],
    loadThread(chatId, since) {
      // Read first: it is `get` that notices a write from outside and starts a new epoch.
      const thread = events.get(chatId) ?? []
      const rewritten = since === undefined ? undefined : events.rewrittenSince(chatId, since)
      return { events: thread, sync: events.sync(chatId), ...(rewritten === undefined ? {} : { rewritten }) }
    },
    loadDocument: (chatId, documentId) => events.loadDocument(chatId, documentId),
    documentIds: (chatId) => events.documentIds(chatId),
    listUnresolvedOutboundSubmissions() {
      return events.unresolved()
    },
    getOutboundThreadDecision(key) {
      const held = outboundThreadDecisions.get(`${key.channel}\0${key.route}\0${key.threadId}`)
      return held === undefined ? undefined : { ...held }
    },
    saveOutboundThreadDecision(key, decision) {
      outboundThreadDecisions.set(`${key.channel}\0${key.route}\0${key.threadId}`, { ...decision })
      return undefined
    },
    deleteOutboundThreadDecision(key) {
      outboundThreadDecisions.delete(`${key.channel}\0${key.route}\0${key.threadId}`)
      return undefined
    },
    appendEvent(chatId, draft: DraftEvent, originals = []) {
      const existing = chats.has(chatId) ? events.tail(chatId) : undefined
      if (existing === undefined)
        throw new Error(`unknown chat ${chatId}`)
      for (const original of originals) events.saveDocument(chatId, original.id, original.bytes)
      const event = stampEvent(draft, existing)
      events.append(chatId, event)
      const chat = chats.get(chatId)
      // Confirm's and Retry's own commit requests carry `confirmRequest`; they are the approval at work, not new work.
      // Manor's message about its own merge belongs to the confirmation it serves too.
      if (event.type === 'user_message' && event.source === undefined && event.confirmRequest === undefined && event.mergeTrouble === undefined && chat?.settledAt === null && chat.archivedAt === null) {
        const held = operations.workHandoffForTarget(chatId)
        if (held?.state === 'active' && held.goalConfirmedAt !== undefined) reopenConfirmedGoal(held)
      }
      if (chat !== undefined)
        chats.set(chatId, { ...chat, lastMessageAt: event.ts })
      return event
    },
    replaceEvent(chatId, event) {
      if (!chats.has(chatId))
        throw new Error(`unknown chat ${chatId}`)
      events.replace(chatId, scrubPersistedEvent(event))
      return undefined
    },
    getChatSummary(chatId) {
      const held = summaries.get(chatId)
      return held === undefined ? undefined : { ...held }
    },
    setChatSummary(chatId, summary, throughEventId) {
      if (!chats.has(chatId))
        throw new Error(`unknown chat ${chatId}`)
      assertEventId(throughEventId)
      const held = summaries.get(chatId)
      if (held !== undefined && !isLaterEventId(throughEventId, held.throughEventId)) {
        return undefined
      }
      summaries.set(chatId, { summary, throughEventId, updatedAt: Date.now() })
      return undefined
    },
    getSessions(chatId, agentId) {
      // One indexed point read per provider, unknown provenance last, rather than a
      // scan of every session in the house on every turn.
      return [...DriverSchema.options, undefined].flatMap((driver) => {
        const held = sessions.get(sessionKey(chatId, agentId, driver))
        if (held === undefined)
          return []
        return [{
          sessionId: held.sessionId,
          ...(held.driver === undefined ? {} : { driver: held.driver }),
          ...(held.seededThroughEventId === undefined
            ? {}
            : { seededThroughEventId: held.seededThroughEventId }),
        }]
      })
    },
    setSession(chatId, agentId, sessionId, meta) {
      if (!chats.has(chatId)) throw new Error(`unknown chat ${chatId}`)
      const single = chats.get(chatId)?.mode === 'single'
      if (single ? agentId !== SINGLE_CHAT_VOICE.id : !roster.has(agentId)) throw new Error(`unknown agent ${agentId}`)
      // The provider is not carried forward from the last write: an absent one means
      // the caller has none, and inheriting would claim a session belongs to a CLI
      // that never saw it.
      sessions.set(sessionKey(chatId, agentId, meta?.driver), {
        sessionId,
        ...(meta?.driver === undefined ? {} : { driver: meta.driver }),
        ...(meta?.seededThroughEventId === undefined
          ? {}
          : { seededThroughEventId: meta.seededThroughEventId }),
      })
      return undefined
    },
    clearSession(chatId, agentId, driver) {
      if (driver !== undefined) {
        sessions.delete(sessionKey(chatId, agentId, driver))
        return undefined
      }
      for (const key of [...sessions.keys()]) {
        if (key.startsWith(`${pairKey(chatId, agentId)}::`))
          sessions.delete(key)
      }
      return undefined
    },
    clearSessions(chatIds) {
      // Prefixes rather than a split, the same way `deleteChat` drops one chat's
      // sessions twenty lines up. One way to do one thing.
      for (const chatId of chatIds) {
        for (const key of [...sessions.keys()]) {
          if (key.startsWith(`${chatId}::`))
            sessions.delete(key)
        }
      }
      return undefined
    },
    loadChatOverrides(chatId) {
      const forChat: Record<string, ChatOverride> = {}
      for (const [key, pin] of pins) {
        const [inChat, agentId] = key.split('::')
        if (inChat !== chatId || agentId === undefined)
          continue
        forChat[agentId] = { ...pin }
      }
      return forChat
    },
    loadChatWorktrees(chatId) {
      return (worktrees.get(chatId) ?? []).map((row) => ({ ...row }))
    },
    replaceChatWorktrees(chatId, rows) {
      if (!chats.has(chatId))
        throw new Error(`unknown chat ${chatId}`)
      if (rows.length === 0)
        worktrees.delete(chatId)
      else
        worktrees.set(chatId, rows.map((row) => ({ ...row })))
      return undefined
    },
    setChatOverride(chatId, agentId, override) {
      // Both foreign keys: a pin on a chat that is gone, or on a persona who is, is
      // refused rather than stored.
      if (!chats.has(chatId))
        throw new Error(`unknown chat ${chatId}`)
      const single = chats.get(chatId)?.mode === 'single'
      if (override.auto === true && ['side', 'pair', 'run'].includes(chats.get(chatId)!.kind)) {
        throw new Error('Auto mode is available for persona conversations only')
      }
      if (single) {
        if (agentId !== SINGLE_CHAT_VOICE.id) throw new Error('single sessions take no persona pins')
        if (singleRuntimeRequired(override)) singleRuntime(override)
      } else if (agentId === SINGLE_CHAT_VOICE.id || !roster.has(agentId)) {
        throw new Error(`unknown agent ${agentId}`)
      }
      const key = pairKey(chatId, agentId)
      const pin: ChatOverride = {
        ...(override.driver === undefined ? {} : { driver: override.driver }),
        ...(override.model === undefined ? {} : { model: override.model }),
        ...(override.effort === undefined ? {} : { effort: override.effort }),
        ...(override.speed === undefined ? {} : { speed: override.speed }),
        // Both values are stored, because absent now means Auto is on: dropping a
        // `false` would turn one chat's opt-out back into the default on next read.
        ...(override.auto === undefined ? {} : { auto: override.auto }),
        // A DM is the exception: Auto never claims it, and an empty pin there is the
        // user handing the chat back to its agent's own Model, so nothing is kept.
        ...(override.autoResolved === true || (chats.get(chatId)!.kind !== 'dm' && pins.get(key)?.autoResolved === true) ? { autoResolved: true } : {}),
      }
      // Nothing left in it is the delete the `chat_overrides_not_empty` check forces.
      if (pin.driver === undefined &&
        pin.model === undefined &&
        pin.effort === undefined &&
        pin.speed === undefined &&
        pin.auto === undefined &&
        pin.autoResolved === undefined)
        pins.delete(key)
      else
        pins.set(key, pin)
      return undefined
    },
    usageRuns: () => events.usageRuns(),
    searchMessages: (query, options) => events.searchMessages(query, options),
    // Newest first, the way the database orders the list the Routines view draws.
    listRoutines: () => [...routines.values()].sort((a, b) => b.createdAt - a.createdAt).map((routine) => ({ ...routine })),
    saveRoutine(draft) {
      const checked = checkRoutineDraft(draft, Date.now(), draft.id === undefined ? undefined : routines.get(draft.id))
      // Both possible target foreign keys, plus the persona: a schedule pointing
      // into something gone is refused rather than saved to fail later.
      if (checked.projectId !== null && !knownRoom(checked.projectId)) {
        throw new Error(`unknown project ${checked.projectId}`)
      }
      if (checked.chatId !== null && !chats.has(checked.chatId)) {
        throw new Error(`unknown chat ${checked.chatId}`)
      }
      if (checked.agentId !== SINGLE_CHAT_VOICE.id && ![...roster.values()].some((agent) => agent.id === checked.agentId)) {
        throw new Error(`unknown agent ${checked.agentId}`)
      }
      const existing = checked.id === undefined ? undefined : routines.get(checked.id)
      // An update naming an id nobody holds throws the way "no row matched" does,
      // rather than quietly creating a second routine on the same schedule.
      if (checked.id !== undefined && existing === undefined) {
        throw new Error(`unknown routine ${checked.id}`)
      }
      // A one-time fire in flight ends its row when it finishes, so a new moment
      // written under it would be ended by the run it was meant to replace. Held for
      // as long as any lease is on the row, not only a live one: a stalled run can
      // still land its completion until recovery ends it and clears the lease.
      if (existing !== undefined && existing.runAt !== null && checked.runAt !== existing.runAt &&
        existing.runningSince !== null) {
        throw new Error(RUNNING_ONE_TIME)
      }
      const saved: Routine = {
        id: existing?.id ?? (options.filename === ':memory:' ? `routine_${(routineCounter += 1)}` : randomUUID()),
        projectId: checked.projectId,
        chatId: checked.chatId,
        agentId: checked.agentId,
        name: checked.name,
        description: checked.description,
        prompt: checked.prompt,
        cron: checked.cron,
        timezone: checked.timezone,
        enabled: checked.enabled,
        notify: checked.notify,
        model: checked.model,
        effort: checked.effort,
        nextRunAt: checked.nextRunAt,
        runAt: checked.runAt,
        lateUntil: checked.lateUntil,
        action: checked.action,
        endState: checked.endState,
        endedAt: checked.endedAt,
        lastRunAt: existing?.lastRunAt ?? null,
        lastSkippedAt: existing?.lastSkippedAt ?? null,
        // A save is an edit, not a verdict on the runs that came before it: the
        // failure count survives so a routine two failures deep is not reset by a
        // typo fix, and Manor's own reason survives with it.
        consecutiveFailures: existing?.consecutiveFailures ?? 0,
        disabledReason: existing?.disabledReason ?? null,
        // An edit does not end the run that is in flight, so it does not release
        // the lease either; the run that holds it is the only thing that may.
        runningSince: existing?.runningSince ?? null,
        lastContextTokens: existing?.lastContextTokens ?? null,
        // DM fire ids name messages in the DM the routine spoke in; moved elsewhere,
        // that history is no longer shown, so its unread runs could never be read.
        unreadRunIds: existing !== undefined && existing.chatId === checked.chatId ? existing.unreadRunIds : [],
        createdAt: existing?.createdAt ?? Date.now(),
      }
      routines.set(saved.id, saved)
      return { ...saved }
    },
    deleteRoutine(routineId) {
      dropRoutine(routineId)
      return undefined
    },
    purgeEndedRoutines(endedBefore) {
      const withRuns = new Set([...chats.values()].map((chat) => chat.routineId))
      const stale = [...routines.values()].filter((routine) =>
        routine.chatId !== null && routine.endedAt !== null && routine.endedAt <= endedBefore && !withRuns.has(routine.id),
      )
      for (const routine of stale) dropRoutine(routine.id)
      return stale.length
    },
    listRuns(routineId) {
      return [...chats.values()]
        .filter((chat) => chat.routineId === routineId)
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(withCheckout)
    },
    setRoutineEnabled(routineId, enabled) {
      const routine = routines.get(routineId)
      if (routine === undefined)
        return undefined
      if (enabled && routine.endState !== null)
        throw new Error(ENDED_ROUTINE)
      const saved: Routine = {
        ...routine,
        enabled,
        // A paused one-time routine comes back on its own moment, even a passed one:
        // the scheduler then treats it as late, which is the honest reading.
        nextRunAt: !enabled ? null : routine.runAt ?? nextRunAfter(routine.cron, routine.timezone, Date.now()),
        // Off by hand needs no explanation, and Manor's own reason for turning it
        // off stops being true the moment the routine is back on.
        disabledReason: null,
        // Turning a self-disabled routine back on is the user saying the thing that
        // broke it is fixed. Keeping the count would leave it one failure from a
        // limit it can no longer reach, which is a routine that never self-disables
        // again rather than one that starts over.
        consecutiveFailures: enabled ? 0 : routine.consecutiveFailures,
      }
      routines.set(routineId, saved)
      return { ...saved }
    },
    claimDueRoutine(now) {
      const due = [...routines.values()]
        .filter((routine) => routine.enabled &&
        routine.nextRunAt !== null &&
        routine.nextRunAt <= now &&
        // Excluded from the candidates rather than only refused by the claim,
        // the way the database's own select does it: a routine whose run outlives
        // its next slot must not be the one row that starves the others.
        free(routine, now))
        .sort((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0))[0]
      if (due === undefined)
        return undefined
      return claim(due, now)
    },
    claimRoutine(routineId, now) {
      const routine = routines.get(routineId)
      // A disabled routine has no `next_run_at` to compare on, so there is nothing
      // here that could be claimed exclusively; the service refuses the hand run
      // before it gets this far.
      if (routine === undefined || !routine.enabled || routine.nextRunAt === null)
        return undefined
      return claim(routine, now)
    },
    recordRoutineRun(routineId, record: RoutineRunRecord) {
      const routine = routines.get(routineId)
      if (routine === undefined)
        return undefined
      // The fence: this run only gets to write while the row still carries the lease
      // it was claimed under. A worker that stalled past the lease and came back to a
      // row somebody else now holds writes nothing and is told so.
      if (routine.runningSince !== record.lease)
        return undefined
      const saved: Routine = {
        ...routine,
        ...(record.lastRunAt === undefined ? {} : { lastRunAt: record.lastRunAt }),
        consecutiveFailures: record.consecutiveFailures,
        disabledReason: record.disabledReason,
        // The run is over, so it hands the lease back rather than leaving the next
        // caller to wait it out.
        runningSince: null,
        lastContextTokens: record.contextTokens,
        // Only ever downwards, so a routine switched off mid-run stays off. The
        // constraint rides along: a routine Manor just turned off must not keep a
        // fire time the claim could still take.
        ...(record.disabled || record.ended !== undefined ? { enabled: false, nextRunAt: null } : {}),
        ...(record.ended === undefined ? {} : { endState: record.ended.state, endedAt: record.ended.at }),
        unreadRunIds: withUnreadRun(routine.unreadRunIds, record.unreadRunId),
      }
      routines.set(routineId, saved)
      return { ...saved }
    },
    markRoutineRunsRead(routineId, runIds) {
      const routine = routines.get(routineId)
      if (routine === undefined)
        return false
      const read = new Set(runIds)
      const unreadRunIds = routine.unreadRunIds.filter((id) => !read.has(id))
      if (unreadRunIds.length === routine.unreadRunIds.length)
        return false
      routines.set(routineId, { ...routine, unreadRunIds })
      return true
    },
    markAllRoutineRunsRead() {
      let changed = false
      for (const routine of [...routines.values()]) {
        if (routine.unreadRunIds.length === 0)
          continue
        routines.set(routine.id, { ...routine, unreadRunIds: [] })
        changed = true
      }
      return changed
    },
    recordRoutineSkip(routineId, skippedAt, lease) {
      const routine = routines.get(routineId)
      if (routine === undefined)
        return undefined
      if (routine.runningSince !== lease)
        return undefined
      // A skip claimed the row and never ran it, so it releases the lease too.
      const saved: Routine = { ...routine, lastSkippedAt: skippedAt, runningSince: null }
      routines.set(routineId, saved)
      return { ...saved }
    },
    cancelRoutine(routineId, now) {
      const routine = routines.get(routineId)
      if (routine === undefined)
        return undefined
      if (routine.runAt === null)
        throw new Error('Only a one-time routine can be cancelled; turn a recurring one off instead.')
      if (routine.endState !== null)
        throw new Error(ENDED_ROUTINE)
      // The same hold as a reschedule: a stalled run could still end it `done`.
      if (routine.runningSince !== null)
        throw new Error(RUNNING_ONE_TIME)
      const saved: Routine = { ...routine, enabled: false, nextRunAt: null, endState: 'cancelled', endedAt: now }
      routines.set(routineId, saved)
      return { ...saved }
    },
  }
  /**
  * Takes a due row, rolls it forward and marks it running. The caller owns the
  * BEGIN IMMEDIATE transaction the store wrapper opens and this runs synchronously
  * inside it, so the read and the replace happen under one write lock: a second
  * scheduler on another connection waits for the commit and then sees the lease.
  */
  function claim(routine: Routine, now: number): ClaimedRoutine | undefined {
    const dueAt = routine.nextRunAt
    if (dueAt === null)
      return undefined
    // The lease, and the only reason a claim on a routine that is due can fail: a
    // rolled `nextRunAt` is a value the second caller would happily claim in turn.
    if (!free(routine, now))
      return undefined
    const claimed: Routine = {
      ...routine,
      // A one-time routine has no next slot. Clearing it here, in the claim, is what
      // makes its single fire at most once: nothing can claim it again, not a second
      // server, not a restart after a crash mid-run.
      nextRunAt: routine.runAt === null ? nextRunAfter(routine.cron, routine.timezone, now) : null,
      runningSince: now,
    }
    routines.set(routine.id, claimed)
    return { routine: claimed, dueAt, lease: now }
  }
  /** Nothing holds this row: never claimed, or claimed by a process long gone. */
  function free(routine: Routine, now: number): boolean {
    return routine.runningSince === null || now - routine.runningSince >= ROUTINE_LEASE_MS
  }
  // Repair confirmations left current by older servers. A manual Settle remains authoritative.
  transaction(db, () => {
    for (const held of workHandoffs.values()) {
      const room = held.workChatId === null ? undefined : chats.get(held.workChatId)
      const confirmedAt = held.goalConfirmedAt
      if (confirmedAt === undefined || held.state !== 'active' || room?.settledAt !== null || room.archivedAt !== null) continue
      const history = events.get(room.id)
      let reached = -1
      history.forEach((event, index) => { if (event.type === 'system_note' && event.workGoalHandoffId === held.id) reached = index })
      if (history.slice(reached + 1).some((event) => event.type === 'user_message' && event.source === undefined && event.mergeTrouble === undefined &&
        event.id !== held.goalCompletion?.requestEventId && event.confirmRequest === undefined && event.ts >= confirmedAt &&
        // Legacy Confirm wrote no request id; its server-generated prefix is the surviving provenance.
        !(held.goalReport === undefined && held.goalCompletion?.requestEventId === undefined &&
          CONFIRM_REQUEST_PREFIX.test(modelTextOf(event))))) reopenConfirmedGoal(held)
    }
  })
  const store = Object.fromEntries(Object.entries(operations).map(([key, operation]) => [key,
    key === 'subscribeHouseholdChanges' ? operation : (...args: unknown[]) => {
      const run = READS.has(key as keyof SyncStore) ? readTransaction : transaction
      try {
        const result: unknown = run(db, () => Reflect.apply(operation, operations, args))
        return Promise.resolve(result)
      } catch (error) {
        events.clearCache()
        return Promise.reject(error)
      }
    },
  ])) as unknown as Store
  return { ...store, db, close: () => db.close() }
}

type SyncStore = { [K in keyof Store]: (...args: Parameters<Store[K]>) => Awaited<ReturnType<Store[K]>> }

/**
* Operations that only read. They run in a deferred snapshot, so another connection
* holding the write lock cannot stall the event loop on them. Every operation not
* named here, including the routine claims, takes BEGIN IMMEDIATE. A write added to
* one of these fails under `query_only` rather than quietly upgrading the lock.
*/
const READS = new Set<keyof SyncStore>([
  'listPushTokens', 'listProjects', 'listChats', 'sideChatOf', 'getSideSession', 'getChat',
  'getProject', 'chatsForProject', 'listWorkHandoffs', 'workHandoffForSourceTurn',
  'workHandoffForTarget', 'loadRoster', 'listMcpServers', 'listSkills', 'loadSkillBundle', 'loadEvents', 'loadThread', 'loadDocument', 'documentIds',
  'listUnresolvedOutboundSubmissions', 'getOutboundThreadDecision', 'getChatSummary', 'getSessions',
  'loadChatOverrides', 'loadChatWorktrees', 'usageRuns', 'searchMessages', 'listRoutines', 'listRuns', 'getSubagentPolicy',
  'getProfile', 'getHouseSettings', 'getProjectSetup', 'loadNoteAges',
])
