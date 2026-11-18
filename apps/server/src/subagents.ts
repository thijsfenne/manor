import { randomUUID } from 'node:crypto'
import {
  SUBAGENT_MAX_DEPTH,
  SUBAGENT_TEXT_MAX,
  SUBAGENT_VOICE,
  checkSubagentChoice,
  modelLabel,
  subagentChoices,
  type AgentConfig,
  type AttachedMcpServer,
  type Chat,
  type DriverName,
  type NativeSubagent,
  type PreferenceSource,
  type ServerMessage,
  type SubagentChild,
  type SubagentPolicy,
  type SubagentState,
  type SubagentSummary,
  type ThreadEvent,
  type TurnHandle,
  type TurnInput,
  type UserInputAnswers,
  type UserInputQuestion,
} from '@manor/contracts'
import { attachedMcpEnvironment, redactGrantedEnvValues } from './childEnv.js'
import { SUBAGENT_REVIEW_RULE } from './composer.js'
import type { UserInputContext } from './interactionCapability.js'
import { mcpEnvironmentKeys } from './mcp/httpHeaders.js'
import { askModeFor } from './mcp/interactionAttachment.js'
import type { ActiveTurnSummary } from './orchestrator.js'
import { scrubCredentialText, scrubPersistedEvent, type DraftEvent, type Store } from './store.js'
import { createTurnStream } from './turnStream.js'

export const SUBAGENT_TASK_MAX = 8_000
export const SUBAGENT_TITLE_MAX = 200
export const SUBAGENT_ROLE_MAX = 2_000
/**
 * How long one waiting call holds the parent's tool call before it answers "still
 * running". Below the 300 s header timeout of the MCP process's `fetch` and Codex's
 * tool timeout for this server, so a long child never turns into a transport error.
 */
export const SUBAGENT_WAIT_MS = 240_000
/** Earlier finished children the directory keeps per parent; older ones open from the parent's own rows. */
export const RECENT_FINISHED_PER_PARENT = 3
/** A provider's own helper launch, by the tool names the turn cards read as one. */
const NATIVE_LAUNCH = /^(task|agent|spawn_subagent)$/i
const nativeKey = (chatId: string, toolCallId: string) => `${chatId}\n${toolCallId}`

const NON_SECRET_ENV_KEYS = new Set(['HOME', 'PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TERM', 'USER', 'LOGNAME', 'NO_COLOR', 'FORCE_COLOR', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS'])
const HUMAN_TEXT_FIELDS = new Set(['title', 'prompt', 'role', 'detail', 'subject', 'targets', 'command', 'path', 'originPath', 'panelPath', 'before', 'after', 'text', 'output'])

/** The delegating turn's workspace, which a child works in without its transcript. */
export interface ParentWorkspace {
  agent: AgentConfig
  cwd: string
  repoPaths: string[]
  repoAccess?: TurnInput['repoAccess']
  mcpServers?: TurnInput['mcpServers']
  /** The delegating turn is one whose children wake their persona when they end. */
  wakes?: true
}

/** A child that ended with a result its persona has not read yet; a wake carries it. */
export interface EndedChild {
  taskId: string
  parentChatId: string
  agentId: string
  toolCallId: string
  title: string
  driver: DriverName
  model: string
  state: 'done' | 'failed'
  result?: string
  reason?: string
}

export interface DelegateRequest {
  task: string
  model: string
  effort: string
  role?: string
  title?: string
  /** False starts the child and returns at once; collect it later with `result`. */
  wait?: boolean
  /** Marks a child as a code reviewer in the Session trace. */
  review?: boolean
}

/** What every subagent tool answers with, as JSON the calling model reads. */
export interface TaskReport {
  taskId: string
  title: string
  model: string
  effort: string
  status: SubagentState
  result?: string
  reason?: string
  /** A wait ended on the clock, not on the child: it is still running, call again to keep waiting. */
  waitTimedOut?: true
}

export class SubagentRefusal extends Error {}

interface Live {
  chatId: string
  parentChatId: string
  /** The top-level chat. Concurrency is counted here, so nested children share the cap. */
  rootChatId: string
  title: string
  task: string
  child: SubagentChild
  turnId: string
  startedAt: number
  workspace: ParentWorkspace
  liveMessages: Map<string, string>
  redact: (text: string) => string
  handle?: TurnHandle
  cancelReason?: string
  done: Promise<TaskReport>
  /** Its end wakes the persona that delegated it; see `ParentWorkspace.wakes`. */
  wakes: boolean
  /** Questions waiting for the user, oldest first. They end with the child's turn. */
  asks: Map<string, UserInputQuestion[]>
}

export type SubagentAsk = NonNullable<SubagentSummary['ask']>

export interface SubagentsOptions {
  store: Store
  /** The saved policy, read at every check so a save applies to the next call. */
  policy: () => SubagentPolicy
  /** Models turned off in Settings, Models, read at every check like the policy. */
  offModels?: () => readonly string[]
  /** The delegating persona's live turn, or nothing once that turn is over. */
  parent: (context: UserInputContext) => ParentWorkspace | undefined
  agentName: (agentId: string) => string
  startTurn: (input: TurnInput) => TurnHandle
  /** Writes into a chat in its append order and tells every client. */
  append: (chatId: string, draft: DraftEvent) => Promise<void>
  emit: (message: ServerMessage) => void
  /** The sidebar's summaries moved. */
  changed: () => void
  /**
   * The Manor tools a child gets, scoped to its own turn: `ask_user` where its provider
   * holds the call, and the subagent tools, listing the models the persona the whole
   * tree works for may use, where it may delegate.
   */
  nestedMcp?: (chatId: string, agent: AgentConfig, turnId: string, personaId: string, tools: { ask: boolean; delegate: boolean }) => AttachedMcpServer
  waitMs?: number
  /** A waking child ended; a done or failed one's result waits in `unreadFor` until read. */
  ended?: (parentChatId: string, agentId: string) => void
}

/**
 * Manor-run children on any provider the house runs, started by a persona's
 * `delegate_task`. Each child gets its own read-only thread under the parent chat, the
 * task and an optional role but none of the parent's transcript, and the parent's own
 * tools only where its provider can hold them to that. A child outlives the turn that
 * started it so a later turn can still collect it; a Stop on that turn, its own Stop,
 * deleting the parent or a restart end it.
 */
export class Subagents {
  private readonly live = new Map<string, Live>()
  /** Slots claimed between the cap check and registration, so two calls cannot both take the last one. */
  private readonly reserved = new Map<string, number>()
  /** Provider-run helpers in flight, by chat and launch call; see `noteNative`. */
  private readonly native = new Map<string, NativeSubagent>()
  /** Waking children that ended with a result their persona has not read, by task id. */
  private readonly unread = new Map<string, EndedChild>()
  /**
   * Children told to stop whose end is not on record yet: still shutting down, or their
   * end failed to save. The directory lists them as cancelled, so a Stop shows at once.
   */
  private readonly stopping = new Set<string>()

  constructor(private readonly options: SubagentsOptions) {}

  async delegate(context: UserInputContext, request: DelegateRequest): Promise<TaskReport> {
    const task = request.task.trim()
    if (task.length === 0 || request.task.length > SUBAGENT_TASK_MAX) {
      throw new SubagentRefusal(`The task must be between 1 and ${SUBAGENT_TASK_MAX} characters.`)
    }
    const role = request.role?.trim()
    if (role !== undefined && role.length > SUBAGENT_ROLE_MAX) throw new SubagentRefusal(`The role is longer than ${SUBAGENT_ROLE_MAX} characters.`)
    const nestedIn = this.liveFor(context)
    const workspace = nestedIn?.workspace ?? this.options.parent(context)
    if (workspace === undefined) throw new SubagentRefusal('This turn can no longer start a subagent.')
    const policy = this.options.policy()
    const depth = (nestedIn?.child.depth ?? 0) + 1
    if (depth > 1 && (!policy.allowNested || depth > SUBAGENT_MAX_DEPTH)) {
      throw new SubagentRefusal(policy.allowNested
        ? 'A subagent of a subagent may not delegate further.'
        : 'Subagents may not start their own subagents; Settings has delegation by subagents off.')
    }
    // Narrowing follows the persona the whole tree works for.
    const personaId = nestedIn === undefined ? context.agentId : this.personaOf(nestedIn)
    const off = this.options.offModels?.() ?? []
    const choice = checkSubagentChoice(policy, personaId, request.model, request.effort, off)
    if (!choice.ok) throw new SubagentRefusal(`${choice.reason} ${allowedLine(policy, personaId, off)}`)
    const rootChatId = nestedIn?.rootChatId ?? context.chatId
    const running = this.runningIn(rootChatId) + (this.reserved.get(rootChatId) ?? 0)
    if (running >= policy.maxConcurrent) {
      throw new SubagentRefusal(`${running} subagents are already running in this chat and the limit is ${policy.maxConcurrent}. Collect or cancel one with task_result or task_cancel first.`)
    }
    this.reserved.set(rootChatId, (this.reserved.get(rootChatId) ?? 0) + 1)
    let live: Live
    try {
      live = await this.start(context, workspace, rootChatId, task, role, request.title, choice.driver, request.model, choice.effort, depth, request.review === true)
    } finally {
      const left = (this.reserved.get(rootChatId) ?? 1) - 1
      if (left === 0) this.reserved.delete(rootChatId)
      else this.reserved.set(rootChatId, left)
    }
    return request.wait === false ? this.report(live) : this.waitFor(live)
  }

  /** The current state of one child, waiting for it unless `wait` is false. */
  async result(context: UserInputContext, taskId: string, wait = true): Promise<TaskReport> {
    const live = this.live.get(taskId)
    if (live !== undefined) {
      this.authorize(context, live.parentChatId, live.child.agentId)
      return wait ? this.waitFor(live) : this.report(live)
    }
    const chat = await this.ownedChild(context, taskId)
    this.unread.delete(taskId)
    return this.settledReport(chat)
  }

  async cancel(context: UserInputContext, taskId: string): Promise<TaskReport> {
    const live = this.live.get(taskId)
    if (live === undefined) return this.settledReport(await this.ownedChild(context, taskId))
    this.authorize(context, live.parentChatId, live.child.agentId)
    this.end(live, `Cancelled by ${this.options.agentName(context.agentId)}.`)
    return live.done
  }

  /** What this caller may start right now, and the children it can collect here. */
  async capabilities(context: UserInputContext): Promise<Record<string, unknown>> {
    const nestedIn = this.liveFor(context)
    const policy = this.options.policy()
    const personaId = nestedIn === undefined ? context.agentId : this.personaOf(nestedIn)
    const depth = (nestedIn?.child.depth ?? 0) + 1
    const rootChatId = nestedIn?.rootChatId ?? context.chatId
    const children = (await this.options.store.listChats())
      .filter((chat) => chat.kind === 'subagent' && chat.parentChatId === context.chatId && chat.subagent?.agentId === context.agentId)
      .slice(0, 10)
    return {
      models: subagentChoices(policy, personaId, this.options.offModels?.() ?? []).map(({ driver, model, label, efforts }) => ({ model, label, provider: driver, efforts })),
      maxConcurrent: policy.maxConcurrent,
      runningInThisChat: this.runningIn(rootChatId),
      mayDelegate: depth === 1 || (policy.allowNested && depth <= SUBAGENT_MAX_DEPTH),
      tasks: children.map((chat) => ({
        taskId: chat.id,
        title: chat.title,
        model: chat.subagent?.model,
        effort: chat.subagent?.effort,
        status: this.live.has(chat.id) ? 'running' : chat.subagent?.state,
      })),
    }
  }

  /** The Stop beside a running child, from the sidebar or the panel. */
  stop(parentChatId: string, toolCallId: string): boolean {
    for (const live of this.live.values()) {
      if (live.parentChatId !== parentChatId || live.child.toolCallId !== toolCallId) continue
      this.end(live, 'Stopped by the user.')
      return true
    }
    return false
  }

  /** The Stop in a child thread's own status line. */
  stopChildTurn(turnId: string): void {
    for (const live of this.live.values()) {
      if (live.turnId === turnId) this.end(live, 'Stopped by the user.')
    }
  }

  /** Stop on the delegating turn takes the children it started with it. */
  stopFromTurn(turnId: string): void {
    for (const live of [...this.live.values()]) {
      if (live.child.turnId === turnId) this.end(live, `Stopped with ${this.options.agentName(live.child.agentId)}'s turn.`)
    }
  }

  /** Shutdown: nothing may keep a provider process running past the server. */
  stopAll(reason: string): void {
    for (const live of [...this.live.values()]) this.end(live, reason)
  }

  /** Stop on a chat or its Settle: every child its turns started, by title. */
  stopInChat(chatId: string, reason: string): string[] {
    const stopped: string[] = []
    for (const live of [...this.live.values()]) {
      if (live.parentChatId !== chatId || live.cancelReason !== undefined) continue
      stopped.push(live.title)
      this.end(live, reason)
    }
    return stopped
  }

  /** Results a persona has not read yet in this chat, oldest end first. */
  unreadFor(chatId: string, agentId: string): EndedChild[] {
    return [...this.unread.values()].filter((child) => child.parentChatId === chatId && child.agentId === agentId)
  }

  /** A wake row now carries these results. */
  markRead(taskIds: readonly string[]): void {
    for (const taskId of taskIds) this.unread.delete(taskId)
  }

  /** Whether a wake is still coming for this persona: a waking child runs or ended unread. */
  wakePending(chatId: string, agentId: string): boolean {
    return this.wakingRunning(chatId, agentId) || this.unreadFor(chatId, agentId).length > 0
  }

  /** Whether a waking child of this persona still runs in this chat. */
  wakingRunning(chatId: string, agentId: string): boolean {
    for (const live of this.live.values()) {
      if (live.wakes && live.parentChatId === chatId && live.child.agentId === agentId && live.cancelReason === undefined) return true
    }
    return false
  }

  /** Whether any child started under this chat still runs, nested ones included. */
  runsUnder(chatId: string): boolean {
    for (const live of this.live.values()) if (live.parentChatId === chatId || live.rootChatId === chatId) return true
    return false
  }

  /** A deleted parent takes every child under it, nested ones included. */
  discardChat(chatId: string): void {
    for (const live of [...this.live.values()]) {
      if (live.parentChatId === chatId || live.rootChatId === chatId || live.chatId === chatId) this.end(live, 'Its chat was deleted.')
    }
    for (const [taskId, child] of this.unread) if (child.parentChatId === chatId) this.unread.delete(taskId)
  }

  /**
   * Every event a chat writes passes here first. A provider's own helper launch is
   * stamped with the provider it runs on, which is always the launching turn's, and
   * stays listed for the sidebar until its result or the end of that turn. Manor's own
   * children carry a thread and are listed from the store instead.
   */
  noteNative(chatId: string, draft: DraftEvent, turnDriver: DriverName | undefined): DraftEvent {
    if (draft.type === 'tool_result') {
      if (this.native.delete(nativeKey(chatId, draft.toolCallId))) this.options.changed()
      return draft
    }
    if (draft.type !== 'tool_use' || !NATIVE_LAUNCH.test(draft.tool) || draft.toolCallId === undefined ||
      draft.parentToolCallId !== undefined || draft.subagent?.childChatId !== undefined) return draft
    const driver = this.live.get(chatId)?.child.driver ?? turnDriver
    if (driver === undefined) return draft
    this.native.set(nativeKey(chatId, draft.toolCallId), {
      parentChatId: chatId, agentId: draft.agentId, turnId: draft.turnId, toolCallId: draft.toolCallId, driver,
      title: scrubCredentialText(draft.subagent?.title ?? draft.subject ?? draft.detail ?? 'Subagent').slice(0, SUBAGENT_TITLE_MAX),
      startedAt: Date.now(),
    })
    this.options.changed()
    return { ...draft, subagent: { ...draft.subagent, driver } }
  }

  /** A turn's end takes the helpers it ran with it, whether or not their results came. */
  closeTurn(turnId: string): void {
    let closed = false
    for (const [key, helper] of this.native) {
      if (helper.turnId === turnId) closed = this.native.delete(key) || closed
    }
    if (closed) this.options.changed()
  }

  /** Children a stop reached before their end was recorded, for the directory. */
  stoppingIds(): ReadonlySet<string> {
    return this.stopping
  }

  /** Provider-run helpers running now, for the directory. */
  nativeRunning(): NativeSubagent[] {
    return [...this.native.values()]
  }

  /** Whether this chat is a child that runs right now. */
  runs(chatId: string): boolean {
    return this.live.has(chatId)
  }

  /** Each running child's oldest open question, for the directory. A stopped child takes no answer. */
  openAsks(): Record<string, SubagentAsk> {
    const open: Record<string, SubagentAsk> = {}
    for (const live of this.live.values()) {
      if (live.cancelReason !== undefined) continue
      const oldest = live.asks.entries().next().value
      if (oldest !== undefined) open[live.chatId] = { requestId: oldest[0], questions: oldest[1] }
    }
    return open
  }

  /** Records a child's question in its own thread; the parent shows it from the directory. */
  async recordAsk(chatId: string, agentId: string, turnId: string, requestId: string, questions: UserInputQuestion[]): Promise<boolean> {
    const live = this.live.get(chatId)
    if (live?.turnId !== turnId || agentId !== SUBAGENT_VOICE.id || live.cancelReason !== undefined) return false
    const draft = scrubPersistedEvent({ type: 'user_input_request', agentId, turnId, requestId, questions }, (text) => live.redact(text))
    await this.options.append(chatId, draft)
    live.asks.set(requestId, draft.questions)
    this.options.changed()
    return true
  }

  /** Persists the answer before the blocked child is released. */
  async recordAnswer(chatId: string, agentId: string, turnId: string, requestId: string, answers: UserInputAnswers, fromPreference?: PreferenceSource): Promise<boolean> {
    const live = this.live.get(chatId)
    if (live?.turnId !== turnId || agentId !== SUBAGENT_VOICE.id || live.cancelReason !== undefined) return false
    await this.appendScrubbed(live, chatId, {
      type: 'user_input_response', agentId, turnId, requestId, answers,
      ...(fromPreference === undefined ? {} : { fromPreference }),
    })
    live.asks.delete(requestId)
    this.options.changed()
    return true
  }

  /** A child thread's running turn, for the snapshot a client gets when it opens one. */
  activeTurn(chatId: string): ActiveTurnSummary | undefined {
    const live = this.live.get(chatId)
    if (live === undefined) return undefined
    return {
      turnId: live.turnId,
      agentId: SUBAGENT_VOICE.id,
      startedAt: live.startedAt,
      messages: [...live.liveMessages].map(([messageId, text]) => ({ messageId, text })),
    }
  }

  /**
   * Nothing runs at boot, so a child the last process left `running` was cut off. It
   * says so in its own state and closes its launch row in the parent, which a client
   * would otherwise draw as working forever when the parent's turn had already ended.
   */
  async recover(): Promise<number> {
    const { store } = this.options
    let recovered = 0
    for (const chat of await store.listChats()) {
      if (chat.kind !== 'subagent' || chat.subagent?.state !== 'running' || this.live.has(chat.id)) continue
      const reason = 'Manor restarted while it was running.'
      await store.endSubagent(chat.id, { state: 'cancelled', reason, endedAt: Date.now() })
      if (chat.parentChatId !== null && await store.getChat(chat.parentChatId) !== undefined) {
        const events = await store.loadEvents(chat.parentChatId)
        const closed = events.some((event) => event.type === 'tool_result' && event.toolCallId === chat.subagent?.toolCallId)
        if (!closed) {
          await store.appendEvent(chat.parentChatId, {
            type: 'tool_result', agentId: chat.subagent.agentId, turnId: chat.subagent.turnId,
            toolCallId: chat.subagent.toolCallId, outcome: 'stopped',
          })
        }
      }
      recovered += 1
    }
    return recovered
  }

  private async start(
    context: UserInputContext,
    workspace: ParentWorkspace,
    rootChatId: string,
    task: string,
    role: string | undefined,
    requestedTitle: string | undefined,
    driver: DriverName,
    model: string,
    effort: SubagentChild['effort'],
    depth: number,
    review: boolean,
  ): Promise<Live> {
    const { store } = this.options
    const toolCallId = `subagent_${randomUUID()}`
    const redact = redactorFor(workspace)
    const title = redact(titleOf(requestedTitle ?? task))
    const startedAt = Date.now()
    const child: SubagentChild = {
      agentId: context.agentId, turnId: context.turnId, toolCallId, driver, model, effort,
      ...(role === undefined || role.length === 0 ? {} : { role: redact(role) }),
      ...(review ? { review: true as const } : {}),
      state: 'running', startedAt, depth,
    }
    const chat = await store.createSubagentChat(context.chatId, title, child)
    let finish: (report: TaskReport) => void = () => undefined
    const live: Live = {
      chatId: chat.id, parentChatId: context.chatId, rootChatId, title, task, child,
      turnId: `turn_${randomUUID()}`, startedAt, workspace, liveMessages: new Map(), redact, asks: new Map(),
      done: new Promise((resolve) => { finish = resolve }),
      // A child's own children answer the child, which waits for them as one answer.
      wakes: depth === 1 && workspace.wakes === true,
    }
    this.live.set(chat.id, live)
    try {
      await this.appendScrubbed(live, context.chatId, {
        type: 'tool_use', agentId: context.agentId, turnId: context.turnId, toolCallId,
        tool: 'spawn_subagent', agentType: modelLabel(driver, model), subject: title,
        subagent: { title, prompt: task, model, effort, driver, childChatId: chat.id, ...(child.role === undefined ? {} : { role: child.role }), ...(review ? { review: true as const } : {}) },
      })
    } catch (error: unknown) {
      this.live.delete(chat.id)
      await store.endSubagent(chat.id, { state: 'failed', reason: 'Manor could not record its launch.', endedAt: Date.now() })
      throw error
    }
    this.options.changed()
    void this.run(live).then(finish, (error: unknown) => {
      this.live.delete(live.chatId)
      finish({ ...this.report(live), status: 'failed', reason: error instanceof Error ? error.message : 'The subagent failed.' })
    })
    return live
  }

  private async run(live: Live): Promise<TaskReport> {
    const { child } = live
    const agent = this.childAgent(live)
    const draftAppend = (draft: DraftEvent) => this.appendScrubbed(live, live.chatId, draft)
    let state: Exclude<SubagentState, 'running'> = 'failed'
    let reason: string | undefined
    let result: string | undefined
    let usage: Extract<DraftEvent, { type: 'tool_result' }>['usage']
    let reportedModel: string | undefined
    const stream = createTurnStream({
      chatId: live.chatId, turnId: live.turnId, agent, liveMessages: live.liveMessages,
      append: draftAppend, emit: this.options.emit,
    })
    try {
      await draftAppend({
        type: 'user_message', text: live.task, mentions: [], source: 'subagent_task', authorAgentId: child.agentId,
      })
      this.options.emit({ type: 'turn_state', chatId: live.chatId, turnId: live.turnId, agentId: agent.id, state: 'running', startedAt: live.startedAt })
      if (live.cancelReason !== undefined) throw new Error(live.cancelReason)
      const tools = { ask: this.mayAsk(child), delegate: this.mayDelegate(child) }
      const nestedMcp = tools.ask || tools.delegate ? this.options.nestedMcp?.(live.chatId, agent, live.turnId, this.personaOf(live), tools) : undefined
      const catchUp: ThreadEvent = {
        id: `${live.turnId}:task`, ts: live.startedAt, type: 'user_message', text: live.task, mentions: [], source: 'subagent_task', authorAgentId: child.agentId,
      }
      live.handle = this.options.startTurn({
        agent, threadId: live.chatId, cwd: live.workspace.cwd, repoPaths: live.workspace.repoPaths,
        ...(live.workspace.repoAccess === undefined ? {} : { repoAccess: live.workspace.repoAccess }),
        ...(nestedMcp === undefined ? {} : { mcpServers: [nestedMcp] }),
        catchUp: [catchUp], isFullCatchUp: true, infrastructure: true,
      })
      if (live.cancelReason !== undefined) live.handle.stop()
      const outcome = await stream.consume(live.handle, live.turnId)
      if (live.cancelReason !== undefined) {
        state = 'cancelled'
        reason = live.cancelReason
      } else if (outcome.kind === 'result') {
        state = 'done'
        result = scrubCredentialText(outcome.text.slice(0, SUBAGENT_TEXT_MAX), live.redact)
        usage = outcome.usage
        reportedModel = outcome.reportedModel
        await draftAppend({
          type: 'turn_result', agentId: agent.id, turnId: live.turnId,
          ...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
          ...(outcome.contextTokens === undefined ? {} : { contextTokens: outcome.contextTokens }),
          ...(outcome.contextWindow === undefined ? {} : { contextWindow: outcome.contextWindow }),
          ...(outcome.reportedModel === undefined ? {} : { reportedModel: outcome.reportedModel }),
        })
      } else {
        reason = outcome.message.slice(0, 400)
      }
    } catch (error: unknown) {
      if (live.cancelReason !== undefined) {
        state = 'cancelled'
        reason = live.cancelReason
      } else {
        reason = error instanceof Error ? error.message.slice(0, 400) : 'The subagent failed.'
      }
      live.handle?.stop()
    }
    if (state !== 'done') {
      await stream.persistInterrupted().catch(() => undefined)
      await draftAppend({
        type: 'system_note', kind: state === 'cancelled' ? 'aborted' : 'error', agentId: agent.id, turnId: live.turnId,
        text: state === 'cancelled' ? `Cancelled. ${reason ?? ''}`.trim() : `The subagent failed: ${reason ?? 'no reason given'}`,
      }).catch(() => undefined)
    }
    this.options.emit({
      type: 'turn_state', chatId: live.chatId, turnId: live.turnId, agentId: agent.id,
      state: state === 'done' ? 'done' : state === 'cancelled' ? 'aborted' : 'error', driver: child.driver,
    })
    // Its own children cannot be collected once it has stopped working.
    this.stopFromTurn(live.turnId)
    await this.options.store.endSubagent(live.chatId, {
      state, endedAt: Date.now(), ...(reason === undefined ? {} : { reason: live.redact(reason) }),
    }).then(() => this.stopping.delete(live.chatId), () => undefined)
    await this.appendScrubbed(live, live.parentChatId, {
      type: 'tool_result', agentId: child.agentId, turnId: child.turnId, toolCallId: child.toolCallId,
      outcome: state === 'done' ? 'success' : state === 'cancelled' ? 'stopped' : 'error',
      ...(result === undefined ? {} : { output: result }),
      ...(usage === undefined ? {} : { usage }),
      ...(reportedModel === undefined ? {} : { reportedModel }),
    }).catch(() => undefined)
    this.live.delete(live.chatId)
    if (live.wakes && state !== 'cancelled') {
      this.unread.set(live.chatId, {
        taskId: live.chatId, parentChatId: live.parentChatId, agentId: child.agentId, toolCallId: child.toolCallId,
        title: live.title, driver: child.driver, model: child.model, state,
        ...(result === undefined ? {} : { result }),
        ...(reason === undefined ? {} : { reason: live.redact(reason) }),
      })
    }
    this.options.changed()
    // A cancelled child brings nothing back, but a wake held for it may now go.
    if (live.wakes) this.options.ended?.(live.parentChatId, child.agentId)
    return {
      taskId: live.chatId, title: live.title, model: child.model, effort: child.effort, status: state,
      ...(result === undefined ? {} : { result }),
      ...(reason === undefined ? {} : { reason: live.redact(reason) }),
    }
  }

  private childAgent(live: Live): AgentConfig {
    const { child, workspace } = live
    const parentName = child.agentId === SUBAGENT_VOICE.id ? 'another subagent' : this.options.agentName(child.agentId)
    const delegates = this.mayDelegate(child)
    return {
      id: SUBAGENT_VOICE.id, name: SUBAGENT_VOICE.name, color: SUBAGENT_VOICE.color,
      driver: child.driver, model: child.model, effort: child.effort,
      allowedTools: childTools(workspace.agent.allowedTools, child.driver),
      mcpServers: [], skillIds: [], mentionAllowlist: [], memoryScope: false,
      description: '', role: '', isCos: false,
      character: [
        `You are a subagent working for ${parentName} in Manor.`,
        `You see only the task you were given, not ${parentName === 'another subagent' ? 'its' : 'their'} conversation.`,
        'Complete exactly that task. Your final message is handed back as the result, so make it complete and self-contained.',
        this.mayAsk(child)
          ? 'Make reasonable assumptions and state them in the result. Use ask_user only when you cannot go on without the user: it holds you until they answer in the chat that started you.'
          : 'Nobody can answer questions while you work: make reasonable assumptions and state them in the result.',
        ...(child.role === undefined ? [] : [`Your role: ${child.role}`]),
        delegates
          ? 'You may split off a separable part with delegate_task, within the limits it reports. Prefer the newest allowed Haiku for purely mechanical parts (renames, formatting, finding every occurrence).'
          : 'Do not delegate or start other agents.',
        ...(delegates ? [SUBAGENT_REVIEW_RULE] : []),
      ].join(' '),
    }
  }

  private mayDelegate(child: SubagentChild): boolean {
    return this.options.policy().allowNested && child.depth < SUBAGENT_MAX_DEPTH &&
      waitsOnToolCalls(child.driver) && this.options.nestedMcp !== undefined
  }

  /** A child has no next attempt, so it asks only where its provider holds the call. */
  private mayAsk(child: SubagentChild): boolean {
    return askModeFor(child.driver) === 'blocking' && this.options.nestedMcp !== undefined
  }

  private async appendScrubbed(live: Live, chatId: string, draft: DraftEvent): Promise<void> {
    await this.options.append(chatId, scrubPersistedEvent(draft, (text, key) => HUMAN_TEXT_FIELDS.has(key) ? live.redact(text) : text))
  }

  private end(live: Live, reason: string): void {
    if (live.cancelReason !== undefined) return
    live.cancelReason = reason
    this.stopping.add(live.chatId)
    live.handle?.stop()
    // The directory lists it as stopped from here, without waiting for it to shut down.
    this.options.changed()
  }

  private async waitFor(live: Live): Promise<TaskReport> {
    let timer: NodeJS.Timeout | undefined
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.options.waitMs ?? SUBAGENT_WAIT_MS)
      timer.unref?.()
    })
    const outcome = await Promise.race([live.done, timedOut])
    clearTimeout(timer)
    if (outcome === 'timeout') return { ...this.report(live), waitTimedOut: true }
    this.unread.delete(live.chatId)
    return outcome
  }

  private report(live: Live): TaskReport {
    return { taskId: live.chatId, title: live.title, model: live.child.model, effort: live.child.effort, status: 'running' }
  }

  private async settledReport(chat: Chat): Promise<TaskReport> {
    const child = chat.subagent!
    const base = { taskId: chat.id, title: chat.title, model: child.model, effort: child.effort }
    // Not live means not running, whatever an interrupted write left on the row.
    const status = child.state === 'running' ? 'cancelled' : child.state
    if (status !== 'done') return { ...base, status, ...(child.reason === undefined ? {} : { reason: child.reason }) }
    const answer = [...await this.options.store.loadEvents(chat.id)].reverse()
      .find((event) => event.type === 'agent_message' && event.agentId === SUBAGENT_VOICE.id)
    return { ...base, status, result: answer?.type === 'agent_message' ? answer.text.slice(0, SUBAGENT_TEXT_MAX) : '' }
  }

  private async ownedChild(context: UserInputContext, taskId: string): Promise<Chat> {
    const chat = await this.options.store.getChat(taskId)
    if (chat?.kind !== 'subagent' || chat.subagent === undefined) throw new SubagentRefusal(`There is no subagent task ${taskId} in this chat.`)
    this.authorize(context, chat.parentChatId, chat.subagent.agentId)
    return chat
  }

  private authorize(context: UserInputContext, parentChatId: string | null, agentId: string): void {
    if (parentChatId !== context.chatId || agentId !== context.agentId) {
      throw new SubagentRefusal('That task was started by another agent or in another chat.')
    }
  }

  private liveFor(context: UserInputContext): Live | undefined {
    const live = this.live.get(context.chatId)
    return live !== undefined && live.turnId === context.turnId && live.cancelReason === undefined ? live : undefined
  }

  private personaOf(live: Live): string {
    let current: Live | undefined = live
    while (current !== undefined && current.child.agentId === SUBAGENT_VOICE.id) current = this.live.get(current.parentChatId)
    return current?.child.agentId ?? live.child.agentId
  }

  private runningIn(rootChatId: string): number {
    let count = 0
    for (const live of this.live.values()) if (live.rootChatId === rootChatId) count += 1
    return count
  }
}

/**
 * Providers known to hold a long MCP call open, which a waiting delegate_task needs:
 * Claude, and Codex with the tool timeout its MCP config sets. These also delegate as
 * children. Cursor runs as a subagent but starts none until a live Cursor MCP call has
 * been measured.
 */
export const waitsOnToolCalls = (driver: DriverName): boolean =>
  driver === 'claude' || driver === 'codex' || driver === 'mock'

/**
 * Personas that may start delegate_task children. Grok joins as a parent: its own
 * background work stops with its turn, its MCP calls wait up to 6000 s by default
 * (well past the 240 s delegate wait), and a finished child wakes it like any parent.
 */
export const startsDelegates = (driver: DriverName): boolean => waitsOnToolCalls(driver) || driver === 'grok'

/**
 * A child keeps the parent's built-ins only where its provider can hold it to them.
 * Claude and Grok gate per tool; Codex and Cursor only know "acts or not", so there
 * a shell is the one built-in that maps without granting more. Native helper tools go,
 * so a child's own delegation only ever runs through Manor's cap.
 */
export function childTools(parentTools: readonly string[], driver: DriverName): string[] {
  if (driver === 'claude' || driver === 'grok' || driver === 'mock') {
    return parentTools.filter((tool) => tool !== 'Task' && tool !== 'Agent')
  }
  return parentTools.includes('Bash') ? ['Bash'] : []
}

type ChildChat = Chat & { subagent: SubagentChild; parentChatId: string }

const isChildChat = (chat: Chat): chat is ChildChat =>
  chat.kind === 'subagent' && chat.subagent !== undefined && chat.parentChatId !== null

/** One child thread as the sidebar and the Agents control describe it. */
export function subagentSummary(chat: Chat, ask?: SubagentAsk): SubagentSummary | undefined {
  return isChildChat(chat)
    ? { ...chat.subagent, id: chat.id, parentChatId: chat.parentChatId, title: chat.title, ...(ask === undefined ? {} : { ask }) }
    : undefined
}

/**
 * The directory's view of every child: all running ones, every finished one a still
 * running parent turn started, and the newest earlier finished ones per parent. The
 * sidebar draws only the running ones; the Agents control reads the rest for its live
 * state. A listed child's ancestors are always listed too, so a running grandchild's
 * line reaches the row it hangs off however old its parent is.
 */
export function subagentDirectory(
  chats: readonly Chat[],
  runningTurns: Readonly<Record<string, readonly string[]>> = {},
  native: readonly NativeSubagent[] = [],
  asks: Readonly<Record<string, SubagentAsk>> = {},
  stopping: ReadonlySet<string> = new Set(),
): { subagents: SubagentSummary[]; nativeSubagents: NativeSubagent[] } {
  const earlier: Record<string, number> = {}
  const listed = new Set<string>()
  const children = chats.filter(isChildChat)
    .map((chat) => chat.subagent.state === 'running' && stopping.has(chat.id) ? { ...chat, subagent: { ...chat.subagent, state: 'cancelled' as const } } : chat)
    .sort((a, b) => b.subagent.startedAt - a.subagent.startedAt)
  for (const chat of children) {
    if (chat.subagent.state === 'running') {
      listed.add(chat.id)
      continue
    }
    if (runningTurns[chat.parentChatId]?.includes(chat.subagent.turnId) === true) {
      listed.add(chat.id)
      continue
    }
    const seen = earlier[chat.parentChatId] ?? 0
    earlier[chat.parentChatId] = seen + 1
    if (seen < RECENT_FINISHED_PER_PARENT) listed.add(chat.id)
  }
  const byId = new Map(children.map((chat) => [chat.id, chat]))
  for (const id of [...listed]) {
    for (let parent = byId.get(byId.get(id)!.parentChatId); parent !== undefined && !listed.has(parent.id); parent = byId.get(parent.parentChatId)) {
      listed.add(parent.id)
    }
  }
  return {
    subagents: children.filter((chat) => listed.has(chat.id)).map((chat) => subagentSummary(chat, asks[chat.id])!),
    nativeSubagents: [...native],
  }
}

function titleOf(text: string): string {
  return text.trim().split(/\r?\n|[.!?](?=\s|$)/, 1)[0]?.trim().slice(0, SUBAGENT_TITLE_MAX) || 'Subagent task'
}

function allowedLine(policy: SubagentPolicy, agentId: string, off: readonly string[]): string {
  const choices = subagentChoices(policy, agentId, off)
  if (choices.length === 0) return 'Settings allow no subagent models for this agent.'
  return `Allowed: ${choices.map((choice) => `${choice.model} (${choice.efforts.join(', ')})`).join('; ')}.`
}

/** Values of the parent's attached MCP secrets, kept out of everything a child stores. */
function redactorFor(workspace: ParentWorkspace): (text: string) => string {
  const attached = workspace.mcpServers ?? []
  const { sourceEnv } = attachedMcpEnvironment(attached)
  const secretKeys = attached.flatMap(({ server, runtimeEnv }) => [
    ...mcpEnvironmentKeys(server), ...Object.keys(runtimeEnv ?? {}),
  ]).filter((key) => !NON_SECRET_ENV_KEYS.has(key))
  return (text) => redactGrantedEnvValues(text, sourceEnv, secretKeys)
}
