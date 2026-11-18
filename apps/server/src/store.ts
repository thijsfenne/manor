import type { NoteAges } from './noteMarkers.js'
import type {
  AgentConfig,
  AgentDraft,
  Chat,
  ChatKind,
  ChatMode,
  ChatOverride,
  ConfirmRequest,
  Effort,
  EventSync,
  ImageAttachment,
  ProjectIcon,
  ProjectMemoryScope,
  McpServerConfig,
  McpServerDraft,
  Project,
  Routine,
  RoutineAction,
  RoutineDraft,
  RoutineEndState,
  SkillConfig,
  SingleRuntime,
  SubagentChild,
  SubagentPolicy,
  ThreadEvent,
  UserProfile,
  HouseSettings,
  WorkHandoff,
  WorkCompletion,
  SearchMessageHit,
} from '@manor/contracts'
import { checkCron, checkTimezone, nextRunAfter } from './routineSchedule.js'
import { HOME_PROJECT_ID, ROUTINE_UNREAD_LIMIT, SINGLE_CHAT_VOICE } from '@manor/contracts'
import { singleRoutineRuntime } from './singleChat.js'
import type { HandoffAttachmentContent } from './handoffAttachments.js'
import type { UsageRun } from './usageReport.js'

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never

/** A thread event before the store stamps it with an id and a timestamp. */
export type DraftEvent = DistributiveOmit<ThreadEvent, 'id' | 'ts'>

/** The kept bytes of one document a user message names, keyed like its `EventDocument.id`. */
export interface DocumentOriginal {
  id: string
  bytes: Uint8Array
}

const CREDENTIAL_SHAPES = [
  /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[oprsu]_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|sb_secret_[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
]

export function scrubCredentialText(text: string, redact: (value: string) => string = (value) => value): string {
  let safe = text
  for (const shape of CREDENTIAL_SHAPES) safe = safe.replace(shape, '[redacted]')
  return redact(safe.replace(/\bBearer\s+[A-Za-z0-9._~+/-]{16,}\b/gi, 'Bearer [redacted]'))
}

/** One scrubber for every event store, before append or replacement reaches disk. */
export function scrubPersistedEvent<T extends DraftEvent | ThreadEvent>(event: T, redact: (text: string, key: string) => string = (text) => text): T {
  const scrub = (value: unknown, key = ''): unknown => {
    if (typeof value === 'string') return key === 'dataUrl' ? value : scrubCredentialText(value, (text) => redact(text, key))
    if (Array.isArray(value)) return value.map((item) => scrub(item, key))
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([field, item]) => [field, scrub(item, field)]))
    }
    return value
  }
  return scrub(event) as T
}
export type WorkHandoffNote = Extract<DraftEvent, { type: 'system_note' }>
export interface UnresolvedOutboundSubmission {
  chatId: string
  event: Extract<ThreadEvent, { type: 'outbound_draft_submission' }>
}

export interface OutboundThreadKey {
  channel: 'gmail' | 'slack'
  route: string
  threadId: string
}

export type OutboundThreadDecision =
  | { kind: 'ignored' }
  | { kind: 'snoozed'; until: number }

/**
 * One CLI conversation a persona holds in one chat, and which provider it lives in.
 * The provider is what makes the id safe to resume: the same pair can be moved to
 * another CLI by a chat pin or by a roster edit, and neither knows about this row.
 * A pair holds one per provider, so moving back finds the conversation it left.
 */
export interface AgentSession {
  sessionId: string
  driver?: AgentConfig['driver']
  /** Last canonical event included when this provider session was first seeded. */
  seededThroughEventId?: string
  /** Side chats also seed from their parent transcript through this event. */
  parentSeededThroughEventId?: string
}

/** Manor-owned compressed context through one durable event in a chat. */
export interface ChatSummary {
  summary: string
  throughEventId: string
  updatedAt: number
}

/** Household rows whose out-of-process writes must invalidate server state. */
export type HouseholdResource = 'agents' | 'routines'

export interface HouseholdChange {
  resource: HouseholdResource
  event: 'insert' | 'update' | 'delete' | 'reconnect'
  /** Primary key from a row event; reconnect reconciles the complete resource. */
  id?: string
}

/** One validated file in an owned skill bundle. Paths are POSIX and relative. */
export interface SkillBundleFile {
  path: string
  bytes: Uint8Array
  sha256: string
  mode: number
}

/**
 * Everything Manor persists, behind one interface so the orchestrator only knows
 * the contract, not the engine. SQLite is the only implementation;
 * `createMemoryStore` runs it on `:memory:` for tests and `MANOR_STORE=memory`.
 * Deletes cascade the way the database does — a project takes its chats, a chat
 * takes its events, sessions and pins, a persona takes hers.
 *
 * `loadEvents` returns the chat's whole transcript oldest first and is expected to
 * be cached by the implementation: it is called once per turn.
 */
export interface Store {
  /**
   * Watches writes made outside this server process. The memory store has no such
   * writer and returns a no-op; SQLite polls its data version.
   */
  subscribeHouseholdChanges(
    onChange: (change: HouseholdChange) => void,
    onError: (error: Error) => void,
  ): () => void
  /** Native-device addresses that may receive one-user Manor completion notices. */
  listPushTokens(): Promise<string[]>
  /** Idempotent registration; seeing a token again refreshes its last-seen stamp. */
  savePushToken(token: string): Promise<void>
  /** Stops sending to a signed-out, rotated or provider-rejected device. */
  deletePushToken(token: string): Promise<void>
  getProjectSetup(projectId: string): Promise<{ version: number } | undefined>
  setProjectSetupVersion(projectId: string, version: number): Promise<void>
  /**
   * When each task row of a project's notes.md last changed (`noteMarkers.ts`). A cache:
   * an empty answer only resets the age shown beside an open row.
   */
  loadNoteAges(projectId: string): Promise<NoteAges>
  /** Replaces the project's whole set, so rows that left the file leave here too. */
  saveNoteAges(projectId: string, ages: NoteAges): Promise<void>
  /** The projects the user made. The home room is never one of them. */
  listProjects(): Promise<Project[]>
  /**
   * The folders of the home room (`HOME_PROJECT_ID`), which is the memory folder.
   * Set after the store opens, because the store holds the setting that names it.
   */
  setHomeFolders(repoPaths: readonly string[]): Promise<void>
  listChats(): Promise<Chat[]>
  /** `repoPaths` are folders already checked by `validateRepoPaths`; empty means none. */
  createProject(name: string, repoPaths?: readonly string[], icon?: ProjectIcon, color?: string, memoryScope?: ProjectMemoryScope): Promise<Project>
  deleteProject(projectId: string): Promise<void>
  /** Replaces the whole sidebar order. The service has already checked the id set. */
  reorderProjects(projectIds: readonly string[]): Promise<void>
  /**
   * The project as it should now read: its name, appearance and whole folder list,
   * already checked. One write because the dialog above it is one form and a project
   * half-updated is a state nobody asked for.
   */
  updateProject(
    projectId: string,
    name: string,
    repoPaths: readonly string[],
    icon?: ProjectIcon,
    color?: string,
    memoryScope?: ProjectMemoryScope,
  ): Promise<void>
  /**
   * Names the project's curated thread, or clears it with null (2026-10-10). The chat
   * is a Single project chat the caller already created; nothing else changes.
   */
  setProjectThread(projectId: string, chatId: string | null): Promise<void>
  /** Takes a folder off the new-Session picker, or lists it again (`Project.unlisted`). */
  setProjectUnlisted(projectId: string, unlisted: boolean): Promise<void>
  /** One project by id. One select, and what a turn uses to find its folders. */
  getProject(projectId: string): Promise<Project | undefined>
  /** One chat by id, or nothing. How routing learns a chat's kind and membership. */
  getChat(chatId: string): Promise<Chat | undefined>
  /**
   * The chats of one project, without the participants the sidebar draws its avatars
   * from. `listChats()` reads the whole participants table to fill those in, and the
   * callers here want ids and folders rather than rows to render.
   */
  chatsForProject(projectId: string): Promise<Chat[]>
  /**
   * Creates a project chat, a DM or a group. The draft is checked against the same
   * rules the database's own constraints hold (`checkChatDraft`), so the memory store
   * and SQLite refuse the same drafts. Creating a DM for a persona that already has
   * one answers with the existing chat rather than throwing: the sidebar creates a DM
   * lazily on first send, and that has to be safe to do twice.
   */
  createChat(draft: ChatDraft): Promise<Chat>
  /** The one standing channel for an unordered pair, created lazily and race-safe. */
  pairChatFor(firstAgentId: string, secondAgentId: string): Promise<Chat>
  /**
   * The side chat hanging off this one, created on first ask. Get-or-create rather
   * than create, and for the same reason a DM is: the rail item opens it lazily, and
   * two windows on the same chat both open it. The database holds that rule as a
   * unique index, so a race loses rather than doubles.
   *
   * It is born with no model and no effort, which reads as the defaults: moving those
   * then moves every panel that never chose, instead of freezing each one at whatever
   * the default was on the day it was opened.
   */
  sideChatFor(parentChatId: string): Promise<Chat>
  /**
   * What this side chat answers with from now on. Both fields together, because the
   * selector is one control and an effort belongs to the model it was picked for.
   *
   * Clears the stored session in the same breath: a session id belongs to the CLI that
   * minted it, so a pick that changes provider must not be handed to the next one, and
   * the turn after this takes the path a fresh panel takes, with the parent read in
   * from the top.
   */
  setSideRuntime(chatId: string, model: string, effort: Effort): Promise<void>
  /**
   * The CLI session answering in a side chat, with how far it has read the parent.
   *
   * Carries its provider the way a persona's session does, derived from the chat's own
   * model. It is exact rather than remembered: `setSideRuntime` drops the session in
   * the same write that changes the pick, so a stored session always belongs to the
   * provider the current model runs on.
   */
  getSideSession(chatId: string): Promise<(AgentSession & { contextEventId?: string }) | undefined>
  /**
   * Stores that session and its moving parent cursor plus fixed seed cursors together.
   * A cursor without its session is a claim about a conversation nothing holds.
   */
  setSideSession(
    chatId: string,
    sessionId: string,
    meta?: {
      contextEventId?: string
      seededThroughEventId?: string
      parentSeededThroughEventId?: string
    },
  ): Promise<void>
  /** Drops a panel's provider session and all cursors that belong to it. */
  clearSideSession(chatId: string): Promise<void>
  /**
   * The side chat hanging off this one, or nothing when its panel has never been
   * opened. Read-only, and what the delete paths use: a panel cascades with its parent
   * in the database, so whatever is running in it has to be stopped before the row goes.
   */
  sideChatOf(parentChatId: string): Promise<Chat | undefined>
  /**
   * A delegated task's read-only child thread under an existing chat. Never part of a
   * project and never routed to: only the subagent runner writes into it, and it is
   * deleted with its parent the way a side chat is.
   */
  createSubagentChat(parentChatId: string, title: string, subagent: SubagentChild): Promise<Chat>
  /**
   * Ends a running child. A child that already ended keeps its first ending, so a late
   * result can never turn a cancelled child into a finished one.
   */
  endSubagent(chatId: string, ending: Pick<SubagentChild, 'state' | 'reason' | 'endedAt'>): Promise<Chat | undefined>
  /** What `delegate_task` may start; the default policy until Settings saves one. */
  getSubagentPolicy(): Promise<SubagentPolicy>
  saveSubagentPolicy(policy: SubagentPolicy): Promise<SubagentPolicy>
  /** How the app shows the user; the default profile until Settings saves one. */
  getProfile(): Promise<UserProfile>
  saveProfile(profile: UserProfile): Promise<UserProfile>
  /** Household settings; every key reads its default until Settings saves one. */
  getHouseSettings(): Promise<HouseSettings>
  saveHouseSettings(settings: HouseSettings): Promise<HouseSettings>
  /** Replaces the sidebar label after the first message gives the chat a subject. */
  setChatTitle(chatId: string, title: string): Promise<void>
  /**
   * The whole desired membership of a group, not a diff. Groups only; a DM's single
   * member is what the DM is, and a project chat derives its participants instead.
   */
  setChatMembers(chatId: string, memberIds: readonly string[]): Promise<void>
  /**
   * Settles a chat, or picks it back up. New events bump `lastMessageAt` and leave
   * the settled stamp exactly where the user left it. Picking one back up also
   * records when, which is the grace period `settleIdleChats` honours.
   */
  setChatSettled(chatId: string, settled: boolean): Promise<void>
  /**
   * Settles every unsettled *project* chat that has been quiet since `cutoff` and was
   * not picked back up after it, and answers with the ids it moved. The second half is
   * what keeps the sweep from overruling the user: a chat rescued inside the window
   * stays where it was put until it goes quiet again on its own terms. A dm and a
   * group are never touched: they are endless threads with no inbox to leave.
   */
  settleIdleChats(cutoff: number): Promise<string[]>
  /** Moves a project chat into or out of its project's archive. */
  setChatArchived(chatId: string, archived: boolean): Promise<void>
  /**
   * Hard-deletes project chats still archived at or before `cutoff`, including their
   * side chats, and returns every deleted id. A project's thread is skipped: archived,
   * it is a hidden project waiting to be added back. The age predicate belongs in this
   * write, not in a preceding service read: restoring a chat while the sweep is in
   * flight must win the race.
   */
  deleteExpiredArchivedChats(cutoff: number): Promise<string[]>
  deleteChat(chatId: string): Promise<void>
  /** Published proposals, accepted handoffs and unfinished reservations. */
  listWorkHandoffs(): Promise<WorkHandoff[]>
  workHandoffForSourceTurn(sourceChatId: string, sourceTurnId: string): Promise<WorkHandoff | undefined>
  workHandoffForTarget(workChatId: string): Promise<WorkHandoff | undefined>
  /** Idempotently reserves one assignment within its source turn. */
  reserveWorkHandoff(draft: WorkHandoffDraft): Promise<{ handoff: WorkHandoff; created: boolean }>
  /** `/goal clear`: the Session stays and may set another goal; this handoff is gone. */
  removeWorkGoal(handoffId: string): Promise<void>
  /** Publishes the proposal receipt; a target is supplied only by legacy callers. */
  finalizeWorkHandoff(handoffId: string, workChatId: string | null, note: WorkHandoffNote): Promise<WorkHandoff>
  /** Atomically changes lifecycle state and appends its versioned source receipt. */
  transitionWorkHandoff(
    handoffId: string,
    transition: WorkHandoffSupersession,
    note: WorkHandoffNote,
  ): Promise<WorkHandoff>
  /**
   * Records how a DM brief and a project thread's session card point at each other
   * (2026-10-10). With `note`, the version moves and the note lands in the source chat.
   */
  linkWorkHandoff(handoffId: string, link: WorkHandoffLink, note?: WorkHandoffNote): Promise<WorkHandoff>
  /**
   * Atomically settles/reopens the target and updates its source receipt. With `landed`,
   * it writes nothing and answers the handoff unchanged unless that confirmed attempt is
   * still the live, complete one and the user has not taken the Session out of Settled.
   */
  transitionWorkLifecycle(
    chatId: string,
    handoffId: string,
    transition: WorkHandoffTransition,
    note: WorkHandoffNote,
    landed?: LandedAttempt,
  ): Promise<WorkHandoff>
  /**
   * Fills in the outcome of a settle that went out without one and rewrites that
   * settle's note in place. Writes nothing and answers undefined once the handoff
   * moved on from `version`: reopened, settled again or already holding a result.
   */
  recordWorkOutcome(handoffId: string, version: number, result: string | null, text: string): Promise<WorkHandoff | undefined>
  /**
   * Creates the target and kickoff together after an explicit Accept request. An
   * edited `task` replaces the proposed one on the handoff before the kickoff is built;
   * `attachments` are the handoff's images and files, read from their source chat.
   */
  materializeWorkHandoff(handoffId: string, runtime?: SingleRuntime, task?: string, attachments?: HandoffAttachmentContent): Promise<WorkHandoff>
  /** Removes only the unused target created by a failed acceptance. */
  resetWorkHandoffTarget(handoffId: string): Promise<void>
  /** Stamps Accept on the handoff that targets this Work chat, with its shared checkout's branches. Idempotent. */
  acceptWorkHandoff(workChatId: string, startBranches?: WorkHandoff['startBranches']): Promise<WorkHandoff>
  /**
   * Stamps the lead's goal as reached and appends `note` to the handoff's Work chat in
   * one write, including the compact report receipt in its source chat when supplied.
   * Returns the appended note, or undefined when the goal was already stamped.
   * `changedFiles` is what the result counts, as `liveSessionFiles` measured it; without
   * it, every path the Session's turns recorded.
   */
  reachWorkGoal(
    handoffId: string, note: WorkHandoffNote, evidence?: readonly DocumentOriginal[], changedFiles?: readonly string[],
  ): Promise<ThreadEvent | undefined>
  /** Reopens an unconfirmed result and durably queues the user's feedback in the same Session. */
  reviseWorkGoal(handoffId: string, version: number, text: string, images?: ImageAttachment[]): Promise<{ handoff: WorkHandoff; event: Extract<ThreadEvent, { type: 'user_message' }>; sourceEvents: ThreadEvent[] }>
  /**
   * Reopens an unconfirmed result the way Request changes does, without queuing a message,
   * because a turn changed code after it was published. Appends `note` to the Work chat and
   * returns it with the source chat's reopened receipt, or undefined when that `version` is
   * no longer an open result (confirmed, changed, reopened or the Session closed).
   */
  reopenWorkGoal(handoffId: string, version: number, note: string): Promise<{ handoff: WorkHandoff; event: ThreadEvent; sourceEvent: ThreadEvent } | undefined>
  /**
   * Stamps the user's confirmation. True only for the call that stamped it; a repeat keeps
   * the first time. New reports require their displayed version. Unreached goals throw.
   * `confirmRequest` rides on the stored `request` message for clients to draw.
   */
  confirmWorkGoal(handoffId: string, version?: number, completion?: WorkCompletion, request?: string, confirmRequest?: ConfirmRequest): Promise<boolean>
  updateWorkCompletion(handoffId: string, completion: WorkCompletion): Promise<void>
  /**
   * Retry on a blocked Confirm: posts `request` as the next attempt under the same
   * approval and moves the completion back to pending. Refuses unless the current
   * completion is the blocked one Confirm's `requestEventId` names. Reopens nothing.
   * With `from: 'pending'` it hands a commit Manor could not make itself to the lead
   * as that next attempt, while the completion is still pending.
   */
  retryWorkCompletion(handoffId: string, requestEventId: string, request: string, confirmRequest: ConfirmRequest, from?: 'blocked' | 'pending'): Promise<{ handoff: WorkHandoff; event: Extract<ThreadEvent, { type: 'user_message' }> }>
  /** The configured personas. Manor has one roster, shared by every chat. */
  loadRoster(): Promise<AgentConfig[]>
  /**
   * Inserts a persona when the draft has no id, updates the named one when it has.
   * The draft is expected to be checked already (`ManorService` does that): the store
   * writes it. A draft with `isCos` clears the flag on every other persona in the
   * same write, because at most one chief of staff is an invariant, not a convention.
   */
  saveAgent(draft: AgentDraft): Promise<AgentConfig>
  /** Removes a persona and, the way the database cascades, its CLI sessions with it. */
  deleteAgent(agentId: string): Promise<void>
  /** The MCP registry. One list for the household; personas attach from it. */
  listMcpServers(): Promise<McpServerConfig[]>
  /**
   * Inserts a server when the draft has no id, updates the named one when it has.
   * `probed` is what `probeMcpServer` learned; the caller probes, because a store
   * must not spawn processes. Passing it here rather than storing it separately keeps
   * the row and its measurements from ever disagreeing.
   */
  saveMcpServer(
    draft: McpServerDraft,
    probed: { tools: string[]; readOnlyTools: string[]; schemaChars: number },
  ): Promise<McpServerConfig>
  /**
   * Removes a server and detaches it from every persona holding it. The attachment
   * list is a jsonb column, not a foreign key, so nothing in the database does this;
   * without it a deleted server would linger as an id no registry can resolve.
   */
  deleteMcpServer(serverId: string): Promise<void>
  /** Imported provider-neutral skills. Attachment to a persona is held on that persona. */
  listSkills(): Promise<SkillConfig[]>
  /** Copies one discovered skill folder into Manor's registry and private bundle store. */
  saveSkill(skill: SkillConfig, bundle?: readonly SkillBundleFile[]): Promise<SkillConfig>
  /** Downloads the files for a selected skill. Empty means a legacy text-only row. */
  loadSkillBundle(skillId: string): Promise<SkillBundleFile[]>
  /** Removes a skill and detaches its id from every persona holding it. */
  deleteSkill(skillId: string): Promise<void>
  loadEvents(chatId: string): Promise<readonly ThreadEvent[]>
  /**
   * The thread with where its rewrites stand, read in one go so the two agree.
   * `rewritten` names the events rewritten in place after `since`; it is absent when
   * no `since` was given or when that cannot be told, and the caller then sends the
   * whole thread.
   */
  loadThread(chatId: string, since?: EventSync): Promise<{ events: readonly ThreadEvent[]; sync: EventSync; rewritten?: readonly string[] }>
  /** Original bytes of a PDF or Word attachment, deleted with the chat. */
  loadDocument(chatId: string, documentId: string): Promise<Uint8Array | undefined>
  /** The ids of every original this chat still holds, read without their bytes. */
  documentIds(chatId: string): Promise<ReadonlySet<string>>
  /**
   * `originals` are the bytes of the documents the event names, written in the same
   * transaction so a refused or discarded message never leaves one behind.
   */
  appendEvent(chatId: string, draft: DraftEvent, originals?: readonly DocumentOriginal[]): Promise<ThreadEvent>
  /** Overwrites one existing event, same id. Used to settle a live compact note. */
  replaceEvent(chatId: string, event: ThreadEvent): Promise<void>
  /** Latest submission claims still at `started`, used once during server startup. */
  listUnresolvedOutboundSubmissions(): Promise<UnresolvedOutboundSubmission[]>
  /** Durable routine filter for one provider thread on one exact outbound route. */
  getOutboundThreadDecision(key: OutboundThreadKey): Promise<OutboundThreadDecision | undefined>
  saveOutboundThreadDecision(key: OutboundThreadKey, decision: OutboundThreadDecision): Promise<void>
  deleteOutboundThreadDecision(key: OutboundThreadKey): Promise<void>
  /** The one shared rolling summary for this chat, absent before its first advance. */
  getChatSummary(chatId: string): Promise<ChatSummary | undefined>
  /**
   * Advances the shared summary atomically. A cursor older than or equal to the row
   * already stored is ignored, so a slow disposable turn cannot overwrite newer
   * context after it finishes.
   */
  setChatSummary(chatId: string, summary: string, throughEventId: string): Promise<void>
  /**
   * This pair's CLI sessions, at most one per provider, each with the provider that
   * minted it. A turn resumes only the one whose provider it is about to run on — a
   * session id is a handle inside one CLI's own store and means nothing to another —
   * so a pair moved from Claude to Codex and back finds its Claude conversation again.
   *
   * An absent `driver` is unknown provenance, and the caller treats that as a mismatch
   * rather than as permission. Nothing in the live database carries one: the rows that
   * predated the column were backfilled from the roster driver, which was exact for the
   * world before a chat could pin a provider at all.
   *
   */
  getSessions(chatId: string, agentId: string): Promise<AgentSession[]>
  /**
   * Stores the CLI session under the provider that minted it, with the event through
   * which its initial canonical context was seeded, replacing only that provider's
   * session. Rows without that cursor are legacy sessions and keep the
   * lifetime-transcript ceiling until they roll over. Every production caller states
   * both facts; omitted metadata is stored as unknown.
   */
  setSession(
    chatId: string,
    agentId: string,
    sessionId: string,
    meta?: { driver?: AgentConfig['driver']; seededThroughEventId?: string },
  ): Promise<void>
  /**
   * Drops one provider's session for this pair, or every provider's when `driver` is
   * omitted. A dead or rolled-over session names its provider; a change that makes
   * everything the pair was told stale (its folders moved) omits it.
   */
  clearSession(chatId: string, agentId: string, driver?: AgentConfig['driver']): Promise<void>
  /**
   * Drops every persona's session in each of these chats, in one write. The
   * per-pair loop it replaces was up to 360 round trips over a table of 84 rows.
   * An empty list is a no-op rather than a delete with no filter.
   */
  clearSessions(chatIds: readonly string[]): Promise<void>
  /**
   * This chat's provider/model/effort pins, keyed by agent id. An absent key, and an absent
   * field within one, means the persona's own configured value; the result is the
   * whole set, which is also the shape the wire and the snapshot carry.
   */
  loadChatOverrides(chatId: string): Promise<Record<string, ChatOverride>>
  /**
   * Replaces one persona's pin in one chat. Replace, not merge: an override with
   * nothing in it removes the pin, which is how picking the roster values back is
   * the way out. Throws for a chat or a persona that does not exist, the way the
   * foreign keys do.
   */
  setChatOverride(chatId: string, agentId: string, override: ChatOverride): Promise<void>
  /**
   * This chat's worktree mapping. Empty is current checkout. Rows mean the chat is
   * isolated; `Chat.checkout` is derived from this, never stored on the chat row.
   */
  loadChatWorktrees(chatId: string): Promise<ChatWorktree[]>
  /**
   * Replaces the mapping for one chat. Empty deletes every row, which is switch
   * to current. Throws for a chat that does not exist, the way the foreign key does.
   */
  replaceChatWorktrees(chatId: string, rows: readonly ChatWorktree[]): Promise<void>
  /**
   * Every persona run that reported usage, for the Usage view to window and price.
   *
   * A store method rather than something assembled from `loadEvents`: house-wide means
   * every chat, and reading every transcript to add up a few numbers is the shape of
   * read `chat_participants()` had before it was materialised away. The SQLite store
   * keeps these rows beside the transcript, in the same transaction as each append.
   */
  usageRuns(): Promise<UsageRun[]>
  /**
   * Messages in `chatIds` whose text holds every word of `query` as a word prefix, at
   * most `perChat` from one chat and `limit` in all, phrase hits first and then newest.
   * The user's messages and persona replies only; tool output and wake rows are not
   * searched. The SQLite store reads a full-text index its triggers keep in step.
   */
  searchMessages(query: string, options: { chatIds: readonly string[]; perChat: number; limit: number }): Promise<SearchMessageHit[]>
  /** Every routine in the house, newest first. One short list for one user. */
  listRoutines(): Promise<Routine[]>
  /**
   * Inserts a routine when the draft has no id, updates the named one when it has.
   * `nextRunAt` is computed here from the cron and the zone rather than taken from
   * the caller, because it is the value the claim compares on: a form that could
   * assert it could arm a routine for a moment that never comes round.
   */
  saveRoutine(draft: RoutineDraft): Promise<Routine>
  deleteRoutine(routineId: string): Promise<void>
  /**
   * Deletes the one-time DM tasks that ended at or before `endedBefore`, and answers
   * how many went. Checked and deleted in one write, so a task rescheduled meanwhile
   * is no longer ended and stays. A routine with run threads stays too, even once it
   * points at a DM: those threads are a record the delete would take with it.
   */
  purgeEndedRoutines(endedBefore: number): Promise<number>
  /**
   * The threads one routine has produced, newest first. This is the only way runs are
   * read: they are deliberately absent from the sidebar tree, so the routine is their
   * whole index.
   */
  listRuns(routineId: string): Promise<Chat[]>
  /**
   * Turns a routine on or off and settles its `nextRunAt` in the same write:
   * recomputed from the cron when it goes on, cleared when it goes off, which is
   * what the `routines_disabled_has_no_next_run` constraint holds either way.
   * Enabling also clears `disabledReason`, since the reason Manor gave for turning
   * it off stops being true the moment it is back on.
   */
  setRoutineEnabled(routineId: string, enabled: boolean): Promise<Routine | undefined>
  /**
   * Takes one routine that is due at `now`, or answers with nothing.
   *
   * The claim is a conditional update on the exact `next_run_at` that was read, on a
   * row nothing else holds, and it rolls that value forward and takes the lease in
   * the same statement. Three halves, all load-bearing: the compare-and-set is what
   * makes the claim exclusive when a dev server and the stable one tick against the
   * same database; the lease (`runningSince`, expiring after `ROUTINE_LEASE_MS`) is
   * what makes it exclusive against a *second call on the same slot*, since the
   * loser of a compare-and-set is handed a rolled value it would claim just as
   * happily; and rolling forward from `now` rather than from the missed slot is what
   * collapses a weekend of missed fires into one instead of a queue of catch-up turns.
   */
  claimDueRoutine(now: number): Promise<ClaimedRoutine | undefined>
  /**
   * The same claim, for one named routine, whatever its schedule says. What
   * `run_routine_now` goes through: a hand run bypasses the timetable but not the
   * claim, so a tick that fires on the same routine in the same second — or a second
   * click on Run now, from this client or another one — loses the race and the
   * routine still runs exactly once.
   */
  claimRoutine(routineId: string, now: number): Promise<ClaimedRoutine | undefined>
  /**
   * What one finished run leaves behind; see `RoutineRunRecord`. Applied only while
   * `record.lease` is still the lease on the row, so a worker that comes back after
   * its lease expired and was taken over writes nothing. Answers `undefined` when it
   * lost, which is indistinguishable from the routine having been deleted, and the
   * caller treats both the same way: this run's bookkeeping is not wanted.
   */
  recordRoutineRun(routineId: string, record: RoutineRunRecord): Promise<Routine | undefined>
  /**
   * Stamps a run the grace window dropped. `nextRunAt` was already rolled by the
   * claim, and `lease` fences this the same way it fences a finished run.
   */
  recordRoutineSkip(routineId: string, skippedAt: number, lease: number): Promise<Routine | undefined>
  /**
   * Ends a pending one-time routine as `cancelled`: off, no fire time, and still
   * listed so the cancel is visible. Throws for a recurring routine, for one that
   * already ended, and for one whose run is in flight, which a cancel cannot stop.
   * `undefined` when the routine is gone.
   */
  cancelRoutine(routineId: string, now: number): Promise<Routine | undefined>
  /**
   * Drops runs from `unreadRunIds`, because the user has now seen them. Answers whether
   * anything changed: false for ids already read, unknown ones, or a routine gone.
   */
  markRoutineRunsRead(routineId: string, runIds: readonly string[]): Promise<boolean>
  /** Clears every routine's unread runs; answers whether anything changed. */
  markAllRoutineRunsRead(): Promise<boolean>
}

/**
 * A routine the caller now owns for this tick, the fire time it took, and the lease
 * it holds it by.
 *
 * `routine` is the row as it stands after the claim, so its `nextRunAt` is already
 * the *next* one; `dueAt` is the slot that was claimed, which is the only thing the
 * grace window can be measured against.
 *
 * `lease` is `runningSince` as this claim set it, and it doubles as the fencing
 * token: every write that ends this run is conditional on the row still carrying it.
 * Without that, a worker stalled past `ROUTINE_LEASE_MS` would come back and clear a
 * lease a *second* worker had since taken, handing a third caller a routine that is
 * still being run. The timestamp is enough of a token on its own, because a second
 * claim on the same row can only happen a whole lease later and so can never carry
 * the same value.
 */
export interface ClaimedRoutine {
  routine: Routine
  dueAt: number
  lease: number
}

/**
 * The bookkeeping one finished run writes. Every field is decided by the scheduler
 * rather than derived here, so the rule that three failures in a row disable a
 * routine lives in one place that a test can drive, and both stores stay dumb.
 */
export interface RoutineRunRecord {
  /** Written only after a successful turn; failures keep the source watermark put. */
  lastRunAt?: number
  /**
   * How a one-time routine's single fire ended. Set, the row also goes off with no
   * fire time; recurring routines never set it.
   */
  ended?: { state: Exclude<RoutineEndState, 'cancelled'>; at: number }
  consecutiveFailures: number
  /**
   * Whether this run was the one that put the routine over the failure limit.
   *
   * Deliberately not an `enabled` flag. A run holds the row for as long as it takes,
   * and the user may well flick the routine off while it is in flight; a completion that
   * wrote `enabled` from what it read before the turn would turn it back on behind
   * them, and leave it on with no fire time — visibly armed and permanently silent.
   * The completion may only ever take a routine *off*, so the user's own switch is
   * the only thing that can turn one on.
   */
  disabled: boolean
  disabledReason: string | null
  /** The lease this run holds the row by; the write is conditional on it. */
  lease: number
  /**
   * This run's `RoutineRun.id` when it waits for the user (see `runWantsAttention`),
   * added to the front of `unreadRunIds` under the same fence as the rest.
   */
  unreadRunId?: string
  /**
   * How full the persona's context window was at the end of this run, or null when
   * it reported none. Written either way rather than only when there is a number:
   * the row says what the *last* run cost, and keeping an older reading alive under
   * that label would be the one lie this field can tell.
   */
  contextTokens: number | null
}

/**
 * One remapped git folder for one chat. The pair `(chatId, sourcePath)` is the
 * primary key in the database; callers already know the chat.
 */
export interface ChatWorktree {
  sourcePath: string
  worktreePath: string
  branch: string
  createdAt: number
  /** The linked folder's branch when Manor created the worktree; absent for older and resumed rows. */
  baseBranch?: string
}

/** What a caller may ask for; everything absent falls back to a project chat. */
export interface ChatDraft {
  mode?: ChatMode
  projectId?: string | null
  title?: string
  kind?: ChatKind
  memberIds?: readonly string[]
  /** Set only by the scheduler, and only together with `kind: 'run'`. */
  routineId?: string | null
  /** The chat this one hangs off, and only together with `kind: 'side'`. */
  parentChatId?: string | null
  /**
   * Born settled, which only a run asks for. A routine that does not want to be told
   * makes a chat nobody has to dismiss: it exists and is readable under its routine
   * and never enters the inbox, by exactly the rule that keeps a settled chat quiet.
   */
  settled?: boolean
}

export interface WorkHandoffDraft {
  task?: string
  summary?: string
  kickoff?: string
  authorAgentId?: string
  sourceChatId: string
  sourceTurnId: string
  assignmentKey?: string
  projectId: string
  projectName: string
  title: string
  leadAgentId: string
  leadAgentName: string
  firstExecutor?: { agentId: string; agentName: string }
  supportingAgentIds: readonly string[]
  supportingAgentNames: readonly string[]
  /** The proposal's number when it replaces a pending one with the same key; absent is 1. */
  revision?: number
  proposedRuntime?: WorkHandoff['proposedRuntime']
  attachments?: WorkHandoff['attachments']
}

export interface WorkHandoffTransition {
  state: 'active' | 'settled'
  result: string | null
  resultAt: number | null
}

/** The confirmed attempt whose landing an automatic settle stands on. */
export interface LandedAttempt {
  goalConfirmedAt: number
  attempt: string
}

/** The fields `linkWorkHandoff` sets on a DM brief and the thread card it became. */
export type WorkHandoffLink = Partial<Pick<WorkHandoff, 'acceptedAt' | 'forwardedAt' | 'forwardAccept' | 'task' | 'threadHandoffId'>>

/** A proposal settling because a newer revision replaced it. */
export interface WorkHandoffSupersession extends WorkHandoffTransition {
  supersededById?: string
}

/** Said when Accept or Reject reaches a proposal a newer revision replaced. */
export const SUPERSEDED_PROPOSAL = 'A newer version replaced this proposal. Use the current card.'

/** The same draft with every field decided, which is what a store writes. */
export interface CheckedChatDraft {
  mode: ChatMode
  projectId: string | null
  kind: ChatKind
  memberIds: string[]
  title?: string
  routineId: string | null
  parentChatId: string | null
  settled: boolean
}

/**
 * Longest one-line preview the sidebar shows. Its twin lives in SQL, in the
 * `chat_events` insert trigger that fills `chats.last_message_preview`
 * (`20260812224500_chat_metadata_materialised.sql`), so the number now exists in two
 * languages and both have to move together.
 */
export const MAX_PREVIEW_CHARS = 120

/**
 * One message as a single sidebar line: whitespace collapsed so a Markdown reply
 * cannot smuggle newlines into a one-line row, cut to `MAX_PREVIEW_CHARS`. Empty is
 * returned as empty and turned into `null` by the caller, because "nothing said yet"
 * and "said something blank" look the same in a sidebar and only one of them is worth
 * a row of its own.
 */
export function previewOf(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_PREVIEW_CHARS)
}

/**
 * What a side chat is called. Never shown in the sidebar, which does not list them at
 * all; it is what the panel header and any listing that stumbles on one reads.
 */
export const SIDE_CHAT_TITLE = 'Aside'

/**
 * A chat draft as it will be written, or a throw naming the rule it broke. Every rule
 * here has a matching check constraint in `20260811210454_chats_dm_and_groups.sql`
 * (the historical Postgres schema): the stores run this check in code so the memory
 * store is not laxer than the schema was (`reference_dev_double_hides_contract_bugs`).
 */
export function checkChatDraft(draft: ChatDraft): CheckedChatDraft {
  const kind = draft.kind ?? 'project'
  const mode = draft.mode ?? 'house'
  if (mode === 'single' && kind !== 'project' && kind !== 'run' && kind !== 'browser') {
    throw new Error('single sessions must be project chats, browser sessions or routine runs')
  }
  const projectId = draft.projectId ?? null
  // Duplicates are dropped rather than refused: two clicks on the same avatar in a
  // group picker is a slip, not an instruction, and the array is a set in spirit.
  const memberIds = [...new Set(draft.memberIds ?? [])].filter((id) => id.length > 0)
  if (kind === 'pair') memberIds.sort()
  const title = draft.title
  const routineId = draft.routineId ?? null
  const parentChatId = draft.parentChatId ?? null

  // A run is a project chat in shape: it lives in a room and derives who is in it from
  // the transcript. What separates it is who owns it, so that is the rule stated here.
  if (kind === 'project' || kind === 'run') {
    if (projectId === null && !(kind === 'run' && mode === 'single')) throw new Error(`a ${kind} chat needs a project`)
    if (memberIds.length > 0) throw new Error(`a ${kind} chat derives its participants and takes no members`)
  } else {
    if (projectId !== null) throw new Error(`a ${kind} chat belongs to no project`)
    if (kind === 'dm' && memberIds.length !== 1) throw new Error('a direct chat has exactly one member')
    if (kind === 'group' && memberIds.length < 2) throw new Error('a group chat needs at least two members')
    if (kind === 'pair' && memberIds.length !== 2) throw new Error('an agent pair has exactly two distinct members')
    if (kind === 'side' && memberIds.length > 0) throw new Error('a side chat holds a model, not members')
    if (kind === 'browser' && memberIds.length > 0) throw new Error('a browser session derives its participants and takes no members')
  }
  // Both directions, the way the `chats_run_shape` constraint holds it: an orphan run
  // is a chat nothing lists, and a routine id on any other kind is a chat claiming to
  // be a run while being filed as something else.
  if ((kind === 'run') !== (routineId !== null)) {
    throw new Error('a run chat belongs to exactly one routine, and only a run chat does')
  }
  // The same shape for `chats_side_shape`: a side chat with no parent is a panel
  // attached to nothing, and a parent on any other kind claims a relationship that
  // nothing reads.
  if ((kind === 'side') !== (parentChatId !== null)) {
    throw new Error('a side chat hangs off exactly one chat, and only a side chat does')
  }
  return {
    projectId,
    kind,
    mode,
    memberIds,
    routineId,
    parentChatId,
    settled: draft.settled ?? false,
    ...(title === undefined ? {} : { title }),
  }
}

/** The same routine with every field decided, which is what a store writes. */
export interface CheckedRoutineDraft {
  id?: string
  projectId: string | null
  chatId: string | null
  agentId: string
  name: string
  description: string
  prompt: string
  cron: string
  timezone: string
  enabled: boolean
  notify: boolean
  /** The pin the scheduler writes onto each run thread; null for the persona's own. */
  model: string | null
  effort: Effort | null
  /** Null exactly when the routine is off, which is the one rule the database holds. */
  nextRunAt: number | null
  runAt: number | null
  lateUntil: number | null
  action: RoutineAction
  /** Kept from the stored row unless the save moved `runAt`, which re-arms it. */
  endState: RoutineEndState | null
  endedAt: number | null
}

/**
 * A routine draft as it will be written, or a throw naming the rule it broke. Every
 * rule here except the cron has a matching check constraint in
 * `20260815090000_routines.sql`, for the same reason `checkChatDraft` exists: the
 * stores must not be laxer than that historical schema was.
 */
export function checkRoutineDraft(
  draft: RoutineDraft,
  now: number,
  existing?: Pick<Routine, 'runAt' | 'endState' | 'endedAt'>,
): CheckedRoutineDraft {
  if (draft.agentId === SINGLE_CHAT_VOICE.id) singleRoutineRuntime(draft)
  const name = draft.name.trim()
  const description = (draft.description ?? '').trim()
  const prompt = draft.prompt.trim()
  if (name.length === 0) throw new Error('a routine needs a name')
  if (description.length > 500) throw new Error('a routine description can be at most 500 characters')
  if (prompt.length === 0) throw new Error('a routine needs a prompt')
  if (draft.agentId !== SINGLE_CHAT_VOICE.id && (draft.projectId === null) === (draft.chatId === null)) {
    throw new Error('a routine needs exactly one target: a project or a direct message')
  }
  const runAt = draft.runAt ?? null
  const lateUntil = runAt === null ? null : (draft.lateUntil ?? null)
  const action = draft.action ?? 'run'
  if (action === 'remind' && (draft.chatId === null || draft.agentId === SINGLE_CHAT_VOICE.id)) {
    throw new Error('a reminder is posted in a direct message, so it needs a DM target')
  }
  const timezone = checkTimezone(draft.timezone)
  // A one-time routine keeps no cron: two schedules on one row would be two things to
  // keep in agreement. Moving `runAt` re-arms an ended one; any other edit leaves how
  // it ended standing, so renaming a finished reminder does not fire it again.
  const rearmed = runAt !== null && (existing === undefined || existing.runAt !== runAt)
  if (rearmed && runAt <= now) throw new Error('that moment has already passed; pick a time in the future')
  if (lateUntil !== null && runAt !== null && lateUntil < runAt) {
    throw new Error('the latest useful run time cannot be before the scheduled time')
  }
  const endState = runAt === null || rearmed ? null : (existing?.endState ?? null)
  const endedAt = endState === null ? null : (existing?.endedAt ?? null)
  const enabled = endState === null && draft.enabled
  const cron = runAt === null ? checkCron(draft.cron) : ''
  return {
    ...(draft.id === undefined ? {} : { id: draft.id }),
    // A Single task always has a room. Without a project that is the home room, so
    // "No project" means the memory system for a task as it does for a Session.
    projectId: draft.projectId ?? (draft.agentId === SINGLE_CHAT_VOICE.id ? HOME_PROJECT_ID : null),
    chatId: draft.chatId,
    agentId: draft.agentId,
    name,
    description,
    prompt,
    cron,
    timezone,
    enabled,
    notify: draft.notify,
    // Empty reads as "no pin", so clearing the box in the form is the way back to the
    // persona's own model rather than a second control that means the same thing.
    model: draft.model === null || draft.model.trim() === '' ? null : draft.model.trim(),
    effort: draft.effort,
    // Recomputed on every save rather than carried over, because a save is also how
    // the cron itself changes: a routine moved from 07:00 to 09:00 that kept its old
    // fire time would run once more at the hour it was moved off.
    nextRunAt: !enabled ? null : runAt ?? nextRunAfter(cron, timezone, now),
    runAt,
    lateUntil,
    action,
    endState,
    endedAt,
  }
}

/** The refusal both stores give for turning an ended one-time routine back on. */
export const ENDED_ROUTINE = 'That one-time routine already ended. Give it a new time to schedule it again.'

/** Refused while a one-time fire holds the lease: it would end whatever it finds. */
export const RUNNING_ONE_TIME = 'That routine is running right now. Change or cancel it once this run has finished.'

/**
 * A stored routine with the one-time fields filled in. Rows written before one-time
 * routines existed carry none of them, and `undefined` would read as "set" to every
 * `!== null` test the scheduler makes.
 */
export function withRoutineDefaults(routine: Routine): Routine {
  return {
    ...routine,
    runAt: routine.runAt ?? null,
    lateUntil: routine.lateUntil ?? null,
    action: routine.action ?? 'run',
    endState: routine.endState ?? null,
    endedAt: routine.endedAt ?? null,
    // Rows from before unread runs existed start read, so the old dots go.
    unreadRunIds: routine.unreadRunIds ?? [],
  }
}

/** `unreadRunIds` with one more run in front, deduplicated and capped. */
export function withUnreadRun(unread: readonly string[], runId: string | undefined): string[] {
  if (runId === undefined) return [...unread]
  return [runId, ...unread.filter((id) => id !== runId)].slice(0, ROUTINE_UNREAD_LIMIT)
}

/** The membership one `set_chat_members` asks for, or a throw. Groups only. */
export function checkGroupMembers(memberIds: readonly string[]): string[] {
  const unique = [...new Set(memberIds)].filter((id) => id.length > 0)
  if (unique.length < 2) throw new Error('a group chat needs at least two members')
  return unique
}

const EVENT_ID = /^evt_(\d+)$/

/** Refuses cursors the database's `chat_summaries` check constraint would refuse. */
export function assertEventId(value: string): void {
  if (!EVENT_ID.test(value)) throw new Error('event cursors must have the form evt_<number>')
}

/** Whether `candidate` is strictly later in one chat's append-only event sequence. */
export function isLaterEventId(candidate: string, current: string): boolean {
  assertEventId(candidate)
  assertEventId(current)
  const candidateMatch = EVENT_ID.exec(candidate)
  const currentMatch = EVENT_ID.exec(current)
  return BigInt(candidateMatch?.[1] ?? '0') > BigInt(currentMatch?.[1] ?? '0')
}

/** What a name slugs down to when nothing alphanumeric survives it. */
const ID_FALLBACK = 'agent'

/**
 * The id a new persona gets: its name, lowercased, with runs of anything else turned
 * into a single dash, uniquified against the ids already taken. Shared by both stores
 * so an id derived on the memory store reads the same as one derived on SQLite.
 *
 * Only ever called for a persona being created. An id is permanent once assigned,
 * because `agent_sessions` keys on it: renaming a persona must not orphan its CLI
 * sessions, so a rename never comes back through here.
 */
export function deriveAgentId(name: string, taken: readonly string[]): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const base = slug.length === 0 ? ID_FALLBACK : slug
  if (!taken.includes(base)) return base
  // Terminates: `taken` is finite, so some suffix is always free.
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`
    if (!taken.includes(candidate)) return candidate
  }
}

/**
 * Stamps a draft with an id and the wall clock. Ids only have to be unique and
 * increasing *within* one chat: the orchestrator uses them as a per-persona cursor
 * into that chat's event list, and the database orders by its own `seq` column.
 * The next number comes from the last event because appends are serialised per
 * chat, so the newest id is always the highest one.
 */
export function stampEvent(draft: DraftEvent, existing: readonly ThreadEvent[]): ThreadEvent {
  const previous = existing.at(-1)?.id
  const sequence = Number((previous === undefined ? undefined : EVENT_ID.exec(previous)?.[1]) ?? 0) + 1
  // Safe by construction: DraftEvent is ThreadEvent minus exactly the two fields
  // stamped here, so widening back to the union restores the original shape.
  return scrubPersistedEvent({ ...draft, id: `evt_${String(sequence).padStart(6, '0')}`, ts: Date.now() } as ThreadEvent)
}
