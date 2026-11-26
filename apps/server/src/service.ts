import { stat } from 'node:fs/promises'
import {
  type DeliveredViewport,
  type GoalClaim,
  type GoalReport,
  type LiveSessionEvent,
  AutoRulesSchema,
  DEFAULT_SUBAGENT_POLICY,
  DEFAULT_USER_PROFILE,
  DEFAULT_HOUSE_SETTINGS,
  HouseSettingsSchema,
  everyModelOff,
  daysToMs,
  type HouseSettings,
  SubagentPolicySchema,
  UserProfileSchema,
  SINGLE_CHAT_VOICE,
  subagentChoices,
  type SubagentPolicy,
  type SystemInfo,
  type UserProfile,
  type AgentConfig,
  type WorkflowSuggestion,
  type AttachedMcpServer,
  type Chat,
  type ClientMessage,
  type McpServerConfig,
  type McpServerDraft,
  type ProviderUsage,
  type Routine,
  type ServerMessage,
  type SkillConfig,
  type UserInputAnswers,
  type UserInputQuestion,
  type PreferenceSource,
  type ProjectRepoIcon,
} from '@manor/contracts'
import { AgentModule } from './agentModule.js'
import { AgentNotesWriter, type AgentNotesInput } from './agentNotes.js'
import { interviewInstruction } from './agentInterview.js'
import { ChatModule } from './chatModule.js'
import type { GenerateChatTitle } from './chatTitle.js'
import type { AdvanceChatSummary } from './chatSummary.js'
import { ConnectionModule } from './connectionModule.js'
import { createContextFile, readContextFiles, saveContextFile } from './contextFiles.js'
import type { ExternalFileOpener } from './externalFiles.js'
import type { ConnectCards } from './connectCards.js'
import type { ComposioMarketplace } from './composioMarketplace.js'
import type { ComposioKey } from './composioKey.js'
import type { DriverResolver, DriverSet } from './drivers/index.js'
import { memoryRoot, type MemoryTarget } from './memoryTarget.js'
import type { GenerateMemoryTrace } from './memoryTrace.js'
import type { WriteDailyLog } from './memoryWriter.js'
import type { MemoryRowRanker } from './structuredMemory.js'
import type { RouteGroupTurn } from './groupTurnRouter.js'
import type { SelectAutoRuntime } from './drivers/typesafeRuntime.js'
import { createAutoRulesFile, type AutoRulesFile } from './autoRules.js'
import { HostModule } from './hostModule.js'
import type { EditNote } from './noteEdit.js'
import { Orchestrator, type RevocableSkillMcp } from './orchestrator.js'
import { ReactionRefusal } from './reactions.js'
import type { OutboundDraftPort } from './outboundDrafts.js'
import { ProjectModule } from './projectModule.js'
import { RoutineModule } from './routineModule.js'
import type {
  RoutineToolContext,
  RoutineToolName,
  RoutineToolInput,
} from './routineTool.js'
import type { HouseholdChange, Store } from './store.js'
import type { RecoveryInputs } from './turnSweep.js'
import type { DiscoveredSkill } from './skills/discovery.js'
import type { SkillUsage } from './skills/usage.js'
import type { Vault } from './vault.js'
import { SearchModule } from './searchModule.js'
import type { MyMindClient } from './mymind.js'
import { MyMindModule } from './mymindModule.js'
import type { RemindersSource } from './reminders.js'
import type { OpenLoopsSync } from './openLoopsSync.js'
import { RemindersModule } from './remindersModule.js'
import { MergeTargetMoved, WorkModule } from './workModule.js'
import { ProjectThreads, type FileWriteInput } from './projectThreads.js'
import { PROJECT_THREAD_WRITER } from './projectFiles.js'
import type { GenerateWorkOutcome } from './workOutcome.js'
import { SessionModule } from './sessionModule.js'
import type { WriteCommitMessage } from './commitMessage.js'
import type { WorkToolContext, WorkToolInput } from './workTool.js'
import type { RelayTurnContext } from './agentRelay.js'
import type { Subagents } from './subagents.js'
import type { SubagentToolCatalog } from './mcp/interactionServer.js'
import type { UserInputContext } from './interactionCapability.js'
import type { OpenQuestions } from './interactionBroker.js'
import { FileDeliveryError, readDeliverable, readEvidenceImage } from './fileDelivery.js'
import { usableTimeZone, usageReportFromRuns } from './usageReport.js'
import type { RateSnapshot } from './usageRates.js'

export interface ManorServiceOptions {
  diagnostics?: import('./runtimeDiagnostics.js').RuntimeDiagnostics
  store: Store
  /**
   * The household as it stands right now. A function rather than a list because
   * personas are edited while the server runs: the orchestrator and the drivers
   * read this same cell, so a saved persona is live on the next turn.
   */
  agents: () => readonly AgentConfig[]
  /** Installs a reloaded roster into that cell. Called after every agent write. */
  setAgents: (agents: readonly AgentConfig[]) => void
  /** The MCP registry as it stands right now; same live-cell pattern as the roster. */
  mcpServers: () => readonly McpServerConfig[]
  /** Server-owned MCP capability attached per chat, outside the editable registry. */
  builtInMcp?: (
    chatId: string,
    agent: AgentConfig,
    turnId: string,
    canApprove: boolean,
    /** The broker session the tools drive; the chat id except in a browser session. */
    browserSession: string,
    /** Whether the turn may ask the user to fill a saved login: attended and not a background wake. */
    canFillLogin: boolean,
  ) => AttachedMcpServer
  /** Live context for an explicit @browser target, through the existing desktop broker. */
  browserTargetContext?: (chatId: string, agent: AgentConfig, freshRequest: boolean) => Promise<string>
  computerTargetReady?: (turnId: string) => void
  /** Tab titles and URLs for an ordinary browser session turn; never throws. */
  browserTabsNote?: (sessionId: string, agent: AgentConfig) => Promise<string>
  /** The Ledger's latest limit readings, for a project thread's turn. */
  providerUsage?: () => readonly ProviderUsage[]
  /** Wraps registry connectors in the server-owned pre-effect gate for this turn. */
  guardMcp?: (
    attached: readonly AttachedMcpServer[],
    context: { chatId: string; agentId: string; turnId: string; canApprove: boolean; readOnly: boolean },
  ) => AttachedMcpServer[]
  /** Server-owned ask-user tool, scoped to the active turn. */
  interactionMcp?: (
    chatId: string,
    agent: AgentConfig,
    turnId: string,
    allowAsk: boolean,
    permissions?: {
      /** The provider this turn runs on; a chat pin can set it apart from `agent.driver`. */
      driver: AgentConfig['driver']
      allowDraft: boolean
      allowRelay: boolean
      allowSubagents: boolean
      allowDeliver: boolean
      /** A DM turn: `react`, which only the turn the user's own message started may use. */
      allowReact?: boolean
      /** A turn with the user present; absent means off. */
      allowSecret?: boolean
      /** Where a secret command runs; absent where this turn has no shell. */
      commandCwd?: string
      /** The goal owner's turn in a goal Session; absent means off. */
      allowGoal?: boolean
      /** Argus's turn in a goal Session: `review_passed`; absent means off. */
      allowReview?: boolean
      allowProjectFiles?: boolean
      allowNotes?: boolean
      allowSessionAnswer?: boolean
      allowSessionForward?: boolean
      mayAnswer?: boolean
      mayForward?: boolean
      allowProjectReport?: boolean
      allowSessionStatus?: boolean
      /** A new agent's interview turn: `write_instructions`. */
      allowInstructions?: boolean
      /** A memory-off persona's attended turn: `offer_instructions_line`. */
      allowInstructionsOffer?: boolean
      canApprove: boolean
      relay?: RelayTurnContext
    },
  ) => AttachedMcpServer
  /** Manor's subagent tools for a child that may delegate further, scoped to its turn. */
  subagentMcp?: (chatId: string, agent: AgentConfig, turnId: string, personaId: string, tools: { ask: boolean; delegate: boolean }) => AttachedMcpServer
  /** Server-owned routine writer, scoped to an ordinary turn in that persona's DM. */
  routineMcp?: (chatId: string, agent: AgentConfig, turnId: string) => AttachedMcpServer
  /** Server-owned Chat → Work handoff, scoped to one directly addressed turn. */
  workMcp?: (chatId: string, agent: AgentConfig, turnId: string, mayPropose?: boolean) => AttachedMcpServer
  /** Server-owned read-only mymind tools, scoped to the active turn. */
  artifactMcp?: (chatId: string, agent: AgentConfig, turnId: string) => AttachedMcpServer
  /** See `OrchestratorOptions.openQuestions`. */
  openQuestions?: OpenQuestions
  /** Resolves one blocked ask-user MCP call after its answer is durable. */
  answerUserInput?: (
    chatId: string,
    requestId: string,
    answers: UserInputAnswers,
    fromPreference?: PreferenceSource,
  ) => Promise<boolean>
  /** Takes a secret card's one answer; no value declines. False when the card is gone. */
  answerSecretRequest?: (chatId: string, requestId: string, value?: string) => boolean
  outboundDrafts?: OutboundDraftPort
  /** Live ask-user waits, keyed by chat id: the questions a project thread may still take up. */
  awaitingInput?: () => Record<string, string[]>
  /** Installs a reloaded registry into that cell. Called after every registry write. */
  setMcpServers: (servers: readonly McpServerConfig[]) => void
  /** The imported skill registry as it stands right now. */
  skills?: () => readonly SkillConfig[]
  /** Server-owned reader scoped to the stored skill bundles attached to one turn. */
  skillMcp?: (
    skillIds: readonly string[],
    onSkillRead: (skillId: string) => void,
  ) => RevocableSkillMcp
  /** Installs a reloaded skill registry into that cell. */
  setSkills?: (skills: readonly SkillConfig[]) => void
  /** Host-local Manor telemetry. Null means this host has no readable sidecar. */
  skillUsage?: () => Promise<ReadonlyMap<string, SkillUsage> | null>
  /** Re-scans provider-owned skill folders. Injected so tests never read a real home. */
  discoverSkills?: () => Promise<DiscoveredSkill[]>
  /** Reads the memory folder's proposal ledger on demand. Null means this host has no checkout. */
  workflowSuggestions?: () => Promise<WorkflowSuggestion[] | null>
  /** Manor-owned local cache for complete skill bundles. */
  skillCacheDir?: string
  /** Best-effort host telemetry after a provider turn with selected skills starts. */
  onSkillsUsed?: (skillIds: readonly string[], driver: AgentConfig['driver']) => void
  /**
   * Starts a server once and reports its tools, so a registry row can never describe
   * something that does not run here. Injected rather than imported so tests do not
   * spawn processes.
   */
  probeMcpServer?: (draft: McpServerDraft) => Promise<{
    tools: string[]
    readOnlyTools: string[]
    schemaChars: number
    verifiedBy?: string
  }>
  /** Host-specific capability state; injected in tests so no real process env leaks in. */
  hostEnv?: NodeJS.ProcessEnv
  resolveDriver: DriverResolver
  /** Provider processes personas keep past a turn while background work runs. */
  liveSessions?: DriverSet['liveSessions']
  ensureScratchDir: (chatId: string) => Promise<string>
  /** Goes to every connected client. Chats run whether or not anyone is looking. */
  broadcast: (message: ServerMessage) => void
  /** Announces one whole exchange after every directly addressed persona is done. */
  onChatFinished?: (chatId: string, startedAt: number, notice?: { alert?: boolean }) => void | Promise<void>
  /** Names a default chat once its first user message has made the subject clear. */
  generateTitle?: GenerateChatTitle
  /** Title generation is auxiliary and reports errors here instead of breaking chat. */
  onTitleError?: (error: unknown) => void
  /** Manor-owned summary advance, scheduled after settled turns. */
  advanceChatSummary?: AdvanceChatSummary
  /** Disposable low-effort report written back when linked Work is manually settled. */
  generateWorkOutcome?: GenerateWorkOutcome
  /** Writes a Commit's message from its diff when the user leaves the field empty. */
  writeCommitMessage?: WriteCommitMessage
  /** Cheap post-turn interpretation of the mechanically observed memory reads. */
  generateMemoryTrace?: GenerateMemoryTrace
  writeDailyLog?: WriteDailyLog
  /** Invisible responder selection for un-mentioned group messages only. */
  routeGroupTurn?: RouteGroupTurn
  selectAutoRuntime?: SelectAutoRuntime
  /** The home room's folders, told to clients; the store answers for the room itself. */
  homeFolders?: readonly string[]
  /** The Auto mode rule file; defaults to the real one, tests point it at a temp copy. */
  autoRules?: AutoRulesFile
  /** Absolute host paths that define the memory folder and the vault. */
  memoryRoots?: readonly string[]
  /** Local `<memory dir>/memory/structured`, absent on a host without the checkout. */
  structuredMemoryRoot?: string
  rankStructuredMemory?: MemoryRowRanker
  /** Delegated turns one user message may cost; the orchestrator default when unset. */
  delegationCap?: number
  /** Wakes per chat since the user last spoke; the orchestrator default when unset. */
  wakeCap?: number
  relayCap?: number
  relayDepth?: number
  /** Which branch of the user's daily-log rule the personas are told to follow. */
  memoryTarget?: MemoryTarget
  /**
   * Root for per-chat git worktrees. Absent means isolation is unavailable, which
   * tests that do not care about checkout can skip.
   */
  worktreesRoot?: string
  /** The browser this host can open for a user-clicked website link. */
  externalBrowser?: 'dia'
  externalFiles?: ExternalFileOpener
  /** Connect cards: Open in browser and Retry land here. */
  connectCards?: Pick<ConnectCards, 'open'>
  /** The Connectors page's Composio catalogue, connects and disconnects. */
  composioMarketplace?: Pick<ComposioMarketplace, 'handle'>
  /** The Composio key the Connectors page saves and removes. Only a client socket reaches it. */
  composioKey?: Pick<ComposioKey, 'handle'>
  /** Opens that link on this host. Absent on the VPS and every non-Mac runtime. */
  openExternalUrl?: (url: string) => Promise<void>
  /** Tears down ephemeral browser sessions when their durable chat disappears. */
  onChatsDeleted?: (chatIds: readonly string[]) => void
  /**
   * The user's Obsidian vault, when this machine has one. Absent is the ordinary state
   * anywhere else, and the client answers it by hiding the Knowledge tab rather than
   * showing one that cannot work.
   */
  vault?: Vault
  /** Where Knowledge deletes go, `trash/knowledge` in the data folder. */
  vaultTrash?: string
  /** The signed link of one vault picture, so the Knowledge listing can carry them. */
  imageSrc?: (path: string) => string
  /** The signed link of one project's repo icon, for the icon picker's offer. */
  repoIconSrc?: (projectId: string, icon: ProjectRepoIcon) => string
  /** The one-shot helper job behind a note's AI comments and composer. */
  editNote?: EditNote
  /** Read-only mymind library. Absent means no Artifacts row on this host. */
  mymind?: MyMindClient
  /** Safe configuration error for the managed connector row, never a credential value. */
  mymindProblem?: string
  /** Apple Reminders on this Mac. Absent anywhere else, and the door is hidden there. */
  reminders?: RemindersSource
  /** The memory folder's open-loops ledger and its Reminders list kept in step, where both are local. */
  openLoops?: OpenLoopsSync
  /** What Settings shows about this Mac, and the log files `reveal_log` may open. */
  systemInfo?: () => Promise<SystemInfo>
  /** Model list prices for the Usage view. Absent, only provider-reported cost is counted. */
  usageRates?: () => Promise<RateSnapshot>
}

/**
 * The protocol, minus the socket. Every client message is handled here, which is
 * what makes create/delete and turn-taking testable without standing up a server;
 * `main.ts` only does transport.
 */
export class ManorService {
  private readonly orchestrator: Orchestrator
  /** Read at boot and replaced on save; every delegate call checks against it. */
  private subagentPolicy: SubagentPolicy = DEFAULT_SUBAGENT_POLICY
  /** Read at boot and replaced on save, like the policy. */
  private userProfile: UserProfile = DEFAULT_USER_PROFILE
  /** Turn id to the line its memory-off persona offered for its instructions; taken by the turn's result. */
  private readonly instructionsOffers = new Map<string, string>()
  /** Read at boot and replaced on save; the lifecycle sweeps read it on every pass. */
  private settings: HouseSettings = DEFAULT_HOUSE_SETTINGS
  private readonly routineModule: RoutineModule
  private readonly myMindModule: MyMindModule
  private readonly remindersModule: RemindersModule
  private readonly connectionModule: ConnectionModule
  private readonly projectModule: ProjectModule
  private readonly agentModule: AgentModule
  private readonly hostModule: HostModule
  private readonly searchModule: SearchModule
  private readonly chatModule: ChatModule
  private readonly workModule: WorkModule
  private readonly sessionModule: SessionModule
  /** The project thread: its files, its sessions' questions and the briefs it turns into sessions. */
  readonly projectThreads: ProjectThreads
  /** `update_notes`: an agent's own notes, one line at a time. */
  readonly agentNotes: AgentNotesWriter
  /** Undo requests in flight by write id, so a second click cannot apply the same reverse twice. */
  private readonly undoingWrites = new Set<string>()

  stopActiveTurns(): number {
    return this.orchestrator.stopActiveTurns()
  }

  /** How many chats have work running now; keep awake and the desktop's quit question read it. */
  activeWork(): number {
    return this.orchestrator.activeWork()
  }

  /**
   * True while this chat has a turn in flight, or a subagent it started still runs: a
   * child works in its parent's folder and may outlive the turn that delegated it.
   */
  turnRunning(chatId: string): boolean {
    return this.orchestrator.activeTurn(chatId) !== undefined || this.orchestrator.subagents.runsUnder(chatId)
  }

  /** The desktop host's (re)connect answer: running Browser-session turns, whether or not their chat is open. */
  async browserSessionTurns(): Promise<ServerMessage> {
    const running = this.orchestrator.activeChatIds().flatMap((chatId) => {
      const turnId = this.orchestrator.activeTurn(chatId)?.turnId
      return turnId === undefined ? [] : [{ chatId, turnId }]
    })
    const kinds = await Promise.all(running.map(async (turn) => (await this.options.store.getChat(turn.chatId))?.kind))
    return { type: 'browser_session_turns', turnIds: running.flatMap((turn, index) => kinds[index] === 'browser' ? [turn.turnId] : []) }
  }

  constructor(private readonly options: ManorServiceOptions) {
    this.orchestrator = new Orchestrator({
      // The placeholder profile of an install nobody has named yet is not a name.
      userName: () => this.knownUserName(),
      ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
      ...(options.openQuestions === undefined ? {} : { openQuestions: options.openQuestions }),
      agents: options.agents,
      mcpServers: options.mcpServers,
      ...(options.builtInMcp === undefined ? {} : { builtInMcp: options.builtInMcp }),
      ...(options.browserTargetContext === undefined ? {} : { browserTargetContext: options.browserTargetContext }),
      ...(options.computerTargetReady === undefined ? {} : { computerTargetReady: options.computerTargetReady }),
      ...(options.browserTabsNote === undefined ? {} : { browserTabsNote: options.browserTabsNote }),
      ...(options.providerUsage === undefined ? {} : { providerUsage: options.providerUsage }),
      ...(options.guardMcp === undefined ? {} : { guardMcp: options.guardMcp }),
      ...(options.interactionMcp === undefined ? {} : { interactionMcp: options.interactionMcp }),
      interviewKickoff: (agentId, messageId) => this.agentModule.interviews.isKickoff(agentId, messageId),
      takeNotesWrites: (turnId) => this.agentNotes.takeTurnWrites(turnId),
      takeInstructionsOffer: (turnId) => {
        const line = this.instructionsOffers.get(turnId)
        this.instructionsOffers.delete(turnId)
        return line
      },
      subagentPolicy: () => this.subagentPolicy,
      offModels: () => this.settings.disabledModels,
      ...(options.subagentMcp === undefined ? {} : { subagentMcp: options.subagentMcp }),
      ...(options.routineMcp === undefined ? {} : { routineMcp: options.routineMcp }),
      ...(options.workMcp === undefined ? {} : { workMcp: options.workMcp }),
      ...(options.artifactMcp === undefined ? {} : { artifactMcp: options.artifactMcp }),
      skills: () => options.skills?.() ?? [],
      ...(options.skillMcp === undefined ? {} : { skillMcp: options.skillMcp }),
      ...(options.skillCacheDir === undefined ? {} : { skillCacheDir: options.skillCacheDir }),
      ...(options.onSkillsUsed === undefined ? {} : { onSkillsUsed: options.onSkillsUsed }),
      store: options.store,
      resolveDriver: options.resolveDriver,
      ...(options.liveSessions === undefined ? {} : { liveSessions: options.liveSessions }),
      ensureScratchDir: options.ensureScratchDir,
      emit: options.broadcast,
      broadcastDirectory: () => this.projectModule.broadcast(),
      onUserMessageStored: (chatId, text) => this.chatModule.onUserMessageStored(chatId, text),
      onExchangeFinished: async (chatId) => {
        await this.workModule.reconcileCompletion(chatId)
        // Any exchange may have moved main under another Session's blocked card.
        void this.workModule.recheckBlocked().catch(() => undefined)
      },
      // A commit or merge-trouble turn that ended counts only once its dispatch settled.
      onStoredMessageSettled: (chatId) => this.workModule.reconcileCompletion(chatId),
      ...(options.advanceChatSummary === undefined
        ? {}
        : { advanceChatSummary: (chatId: string) => this.chatModule.startSummary(chatId) }),
      ...(options.generateMemoryTrace === undefined ? {} : { generateMemoryTrace: options.generateMemoryTrace }),
      ...(options.writeDailyLog === undefined ? {} : { writeDailyLog: options.writeDailyLog }),
      ...(options.routeGroupTurn === undefined ? {} : { routeGroupTurn: options.routeGroupTurn }),
      ...(options.selectAutoRuntime === undefined ? {} : { selectAutoRuntime: options.selectAutoRuntime }),
      ...(options.memoryRoots === undefined ? {} : { memoryRoots: options.memoryRoots }),
      ...(options.structuredMemoryRoot === undefined ? {} : { structuredMemoryRoot: options.structuredMemoryRoot }),
      ...(options.rankStructuredMemory === undefined ? {} : { rankStructuredMemory: options.rankStructuredMemory }),
      ...(options.delegationCap === undefined ? {} : { delegationCap: options.delegationCap }),
      ...(options.wakeCap === undefined ? {} : { wakeCap: options.wakeCap }),
      ...(options.relayCap === undefined ? {} : { relayCap: options.relayCap }),
      ...(options.relayDepth === undefined ? {} : { relayDepth: options.relayDepth }),
      ...(options.memoryTarget === undefined ? {} : { memoryTarget: options.memoryTarget }),
      onGoalReached: (handoffId) => {
        void this.projectThreads.goalReached(handoffId).catch((error: unknown) => console.warn('[manor] project thread could not take the learnings', error))
      },
      projectThreadTurns: {
        started: (turnId) => this.projectThreads.turnStarted(turnId),
        ended: (turn) => this.projectThreads.turnEnded(turn),
        queued: (threadChatId, questions) => this.projectThreads.takeQueued(threadChatId, { questions, alongside: true }),
      },
    })
    this.chatModule = new ChatModule({
      store: options.store,
      agents: options.agents,
      orchestrator: this.orchestrator,
      broadcast: options.broadcast,
      broadcastDirectory: () => this.projectModule.broadcast(),
      ...(options.answerUserInput === undefined ? {} : { answerUserInput: options.answerUserInput }),
      ...(options.answerSecretRequest === undefined ? {} : { answerSecretRequest: options.answerSecretRequest }),
      ...(options.outboundDrafts === undefined ? {} : { outboundDrafts: options.outboundDrafts }),
      ...(options.onChatFinished === undefined ? {} : { onChatFinished: options.onChatFinished }),
      ...(options.generateTitle === undefined ? {} : { generateTitle: options.generateTitle }),
      ...(options.onTitleError === undefined ? {} : { onTitleError: options.onTitleError }),
      ...(options.advanceChatSummary === undefined ? {} : { advanceChatSummary: options.advanceChatSummary }),
      ...(options.memoryTarget === undefined ? {} : { memoryTarget: options.memoryTarget }),
    })
    this.workModule = new WorkModule({
      store: options.store,
      agents: options.agents,
      orchestrator: this.orchestrator,
      broadcast: options.broadcast,
      prepareCheckout: (chatId, checkout, accept) => this.projectModule.prepareWorkCheckout(chatId, checkout, accept),
      releaseWorktrees: (chatId) => this.projectModule.releaseMergedWorktrees(chatId),
      broadcastDirectory: () => this.projectModule.broadcast(),
      offModels: () => this.settings.disabledModels,
      ...(options.writeCommitMessage === undefined ? {} : { writeCommitMessage: options.writeCommitMessage }),
      ...(options.generateWorkOutcome === undefined ? {} : { generateOutcome: options.generateWorkOutcome }),
      projectThreads: {
        forwardBrief: (handoff, accept, task) => this.projectThreads.forwardBrief(handoff, accept, task),
        proposed: (handoff) => this.projectThreads.proposed(handoff),
        noteProposal: (handoff) => this.projectThreads.noteProposal(handoff),
        completeSessionStatus: (chatId) => this.projectThreads.completeSessionStatus(chatId),
        assertSessionStatusWritable: (chatId) => this.projectThreads.assertSessionStatusWritable(chatId),
      },
    })
    this.projectThreads = new ProjectThreads({
      store: options.store,
      offModels: () => this.settings.disabledModels,
      structuredRoot: options.structuredMemoryRoot,
      agentName: (agentId) => agentId === SINGLE_CHAT_VOICE.id
        ? PROJECT_THREAD_WRITER
        : options.agents().find((agent) => agent.id === agentId)?.name ?? agentId,
      emit: options.broadcast,
      broadcastDirectory: () => this.projectModule.broadcast(),
      wake: (chatId, origin, compose) => {
        void this.orchestrator.wakeProjectThread(chatId, origin, compose).catch(async (error: unknown) => {
          const event = await options.store.appendEvent(chatId, {
            type: 'system_note', kind: 'error',
            text: `The project thread could not take this up: ${error instanceof Error ? error.message : String(error)}`,
          }).catch(() => undefined)
          if (event !== undefined) options.broadcast({ type: 'event', chatId, event })
        })
      },
      answerQuestion: (chatId, requestId, answers, fromPreference) => options.answerUserInput?.(chatId, requestId, answers, fromPreference) ?? Promise.resolve(false),
      awaitingInput: () => options.awaitingInput?.() ?? {},
      isActiveTurn: (chatId, agentId, turnId) => this.orchestrator.isActiveTurn(chatId, agentId, turnId),
      acceptHandoff: (handoffId, accept) => this.workModule.accept(handoffId, accept),
      reopenSession: (sessionChatId) => this.workModule.setSettled(sessionChatId, false),
      acceptInSession: async (sessionChatId, message) => {
        const startedAt = Date.now()
        const { finished } = await this.orchestrator.forwardUserMessage(sessionChatId, message)
        // The done notice a message typed there gets, once its errand ends.
        void finished.then(() => this.chatModule.announceFinished(sessionChatId, startedAt), () => undefined)
      },
    })
    this.agentNotes = new AgentNotesWriter({
      store: options.store,
      memoryTarget: options.memoryTarget,
      agents: options.agents,
      emit: options.broadcast,
      isActiveTurn: (chatId, agentId, turnId) => this.orchestrator.isActiveTurn(chatId, agentId, turnId),
    })
    this.sessionModule = new SessionModule({
      store: options.store,
      orchestrator: this.orchestrator,
      broadcast: options.broadcast,
      ...(options.writeCommitMessage === undefined ? {} : { writeCommitMessage: options.writeCommitMessage }),
      ...(options.externalFiles === undefined ? {} : { externalFiles: options.externalFiles }),
      onCommitted: () => void this.workModule.recheckBlocked().catch(() => undefined),
    })
    this.projectModule = new ProjectModule({
      offModels: () => this.settings.disabledModels,
      ...(options.externalFiles === undefined ? {} : { externalFiles: options.externalFiles }),
      ...(options.structuredMemoryRoot === undefined ? {} : { structuredMemoryRoot: options.structuredMemoryRoot }),
      store: options.store,
      agents: options.agents,
      orchestrator: this.orchestrator,
      ...(options.worktreesRoot === undefined ? {} : { worktreesRoot: options.worktreesRoot }),
      broadcast: options.broadcast,
      isStartingHandoff: (handoffId) => this.workModule.isStarting(handoffId),
      ...(options.repoIconSrc === undefined ? {} : { repoIconSrc: options.repoIconSrc }),
      // Creating a project in the sidebar is what gives it a thread and its setup.
      setupProject: async (projectId, threadRuntime) => {
        await this.projectThreads.create(projectId, { seed: false, broadcast: false, ...(threadRuntime === undefined ? {} : { runtime: threadRuntime }) })
      },
      welcomeProject: (projectId) => { void this.projectThreads.welcome(projectId) },
      removeProjectThread: (projectId) => this.projectThreads.remove(projectId),
      sendOpeningMessage: (chatId, opening) => this.chatModule.sendOpeningMessage(chatId, opening),
      reloadRoster: () => this.reloadRoster(),
      broadcastRoutines: () => this.broadcastRoutines(),
      ...(options.onChatsDeleted === undefined ? {} : { onChatsDeleted: options.onChatsDeleted }),
    })
    this.routineModule = new RoutineModule({
      store: options.store,
      agents: options.agents,
      orchestrator: this.orchestrator,
      knownChats: () => this.projectModule.knownChatSnapshot(),
      broadcast: options.broadcast,
      broadcastDirectory: () => this.projectModule.broadcast(),
      replaceDirectory: () => this.projectModule.replaceDocument(),
      announceFinished: (chatId, startedAt, alert) => this.chatModule.announceFinished(chatId, startedAt, alert),
      ...(options.onChatsDeleted === undefined ? {} : { onChatsDeleted: options.onChatsDeleted }),
    })
    this.myMindModule = new MyMindModule({
      ...(options.mymind === undefined ? {} : { client: options.mymind }),
      ...(options.mymindProblem === undefined ? {} : { problem: options.mymindProblem }),
      ...(options.hostEnv === undefined ? {} : { hostEnv: options.hostEnv }),
      broadcast: options.broadcast,
    })
    this.remindersModule = new RemindersModule({
      ...(options.reminders === undefined ? {} : { source: options.reminders }),
      ...(options.openLoops === undefined ? {} : { openLoops: options.openLoops }),
      broadcast: options.broadcast,
    })
    this.hostModule = new HostModule({
      reminders: options.reminders !== undefined,
      auto: options.selectAutoRuntime !== undefined,
      ...(options.homeFolders === undefined ? {} : { homeFolders: options.homeFolders }),
      ...(options.externalFiles === undefined ? {} : { externalFiles: options.externalFiles }),
      ...(options.externalBrowser === undefined ? {} : { externalBrowser: options.externalBrowser }),
      ...(options.openExternalUrl === undefined ? {} : { openExternalUrl: options.openExternalUrl }),
      ...(options.vault === undefined ? {} : { vault: options.vault }),
      ...(options.vaultTrash === undefined ? {} : { vaultTrash: options.vaultTrash }),
      ...(options.imageSrc === undefined ? {} : { imageSrc: options.imageSrc }),
      ...(options.editNote === undefined ? {} : { editNote: options.editNote }),
      noteAi: () => ({ model: this.settings.noteAiModel, effort: this.settings.noteAiEffort }),
      broadcast: options.broadcast,
    })
    this.searchModule = new SearchModule({
      store: options.store,
      ...(options.vault === undefined ? {} : { vault: options.vault }),
    })
    this.agentModule = new AgentModule({
      store: options.store,
      agents: options.agents,
      setAgents: options.setAgents,
      ...(options.skills === undefined ? {} : { skills: options.skills }),
      broadcast: options.broadcast,
      discardRoutineWork: (agentId) => this.routineModule.discardAgentWork(agentId),
      broadcastRoutines: () => this.routineModule.broadcast(),
      broadcastDirectory: () => this.projectModule.broadcast(),
      startInterview: (agent) => this.startInterview(agent),
      ...(options.onChatsDeleted === undefined ? {} : { onChatsDeleted: options.onChatsDeleted }),
    })
    this.connectionModule = new ConnectionModule({
      store: options.store,
      agents: options.agents,
      mcpServers: options.mcpServers,
      setMcpServers: options.setMcpServers,
      ...(options.skills === undefined ? {} : { skills: options.skills }),
      ...(options.setSkills === undefined ? {} : { setSkills: options.setSkills }),
      ...(options.probeMcpServer === undefined ? {} : { probeMcpServer: options.probeMcpServer }),
      ...(options.hostEnv === undefined ? {} : { hostEnv: options.hostEnv }),
      ...(options.skillUsage === undefined ? {} : { skillUsage: options.skillUsage }),
      ...(options.discoverSkills === undefined ? {} : { discoverSkills: options.discoverSkills }),
      ...(options.workflowSuggestions === undefined ? {} : { workflowSuggestions: options.workflowSuggestions }),
      broadcast: options.broadcast,
      reloadRoster: () => this.reloadRoster(),
    })
  }

  /** The sidebar: sent on connect and re-sent after every create or delete. */
  async directory(): Promise<ServerMessage> {
    return this.projectModule.document()
  }

  /** Broadcasts current rows, adding them to the cleanup snapshot without pruning it. */
  async broadcastDirectory(): Promise<void> {
    await this.projectModule.broadcast()
  }

  async recoverWaitingMessages(browserReady?: Promise<void>, bootInputs?: RecoveryInputs): Promise<void> {
    await this.orchestrator.recoverWaitingMessages(browserReady, bootInputs)
  }

  /**
   * Permanently removes project chats whose restore window, set in Settings, has
   * elapsed. The store performs the age check in the delete itself so a concurrent
   * restore wins; only ids the store actually removed reach runtime and host cleanup.
   */
  async purgeExpiredArchivedChats(now = Date.now()): Promise<string[]> {
    return this.projectModule.purgeExpiredArchivedChats(now, daysToMs(this.settings.archiveRetentionDays))
  }

  /** Hourly clean-orphan sweep, next to `sweepScratch`. */
  async sweepChatWorktrees(
    chats: readonly Pick<Chat, 'id' | 'projectId' | 'settledAt' | 'archivedAt'>[],
  ): Promise<{ directoriesRemoved: number; nodeModulesRemoved: number; worktreesReleased: number }> {
    return this.projectModule.sweepChatWorktrees(chats)
  }

  /** Scratch resources the hourly lifecycle sweep must leave alone. */
  activeScratchThreadIds(): string[] {
    return [...this.chatModule.activeScratchThreadIds(), ...this.hostModule.activeScratchThreadIds()]
  }

  recordUserInputRequest(
    chatId: string,
    agentId: string,
    turnId: string,
    requestId: string,
    questions: UserInputQuestion[],
  ): Promise<boolean> {
    return this.orchestrator.recordUserInputRequest(chatId, agentId, turnId, requestId, questions).then((recorded) => {
      // A session the project thread started asks there instead (2026-10-10).
      if (recorded) void this.projectThreads.forwardQuestion(chatId, agentId, requestId, questions).catch(() => undefined)
      return recorded
    })
  }

  recordUserInputResponse(
    chatId: string,
    agentId: string,
    turnId: string,
    requestId: string,
    answers: UserInputAnswers,
    fromPreference?: PreferenceSource,
  ): Promise<boolean> {
    return this.orchestrator.recordUserInputResponse(chatId, agentId, turnId, requestId, answers, fromPreference).then((recorded) => {
      if (recorded) void this.projectThreads.recordAnswer(chatId, requestId, answers, fromPreference).catch(() => undefined)
      return recorded
    })
  }

  /** Turn-scoped interaction tool entry; identity and origin come from its capability. */
  messageAgent(context: UserInputContext, to: string, text: string): Promise<string> {
    return this.orchestrator.messageAgent(context, to, text)
  }

  recordConnectRequest(...args: Parameters<Orchestrator['recordConnectRequest']>): Promise<boolean> {
    return this.orchestrator.recordConnectRequest(...args)
  }

  recordConnectStatus(...args: Parameters<Orchestrator['recordConnectStatus']>): Promise<void> {
    return this.orchestrator.recordConnectStatus(...args)
  }

  /**
   * One memory line from a running turn, the internal endpoint's `write`: a project thread
   * writes a file of its project (`update_project_file`), any other turn its own notes (`update_notes`).
   */
  async writeMemory(context: UserInputContext, input: Omit<FileWriteInput, 'file'> & { file?: string }): Promise<string> {
    if (await this.projectThreads.threadProject(context.chatId) !== undefined) {
      if (input.file === undefined) throw new Error('update_project_file needs `file`: preferences.md, notes.md or a card.')
      return this.projectThreads.writeFile(context, { ...input, file: input.file })
    }
    if (input.action === 'create') throw new Error('Your notes take add, replace or remove.')
    const notes: AgentNotesInput = { action: input.action, ...(input.line === undefined ? {} : { line: input.line }), ...(input.old === undefined ? {} : { old: input.old }) }
    return this.agentNotes.write(context, notes)
  }

  /**
   * Undo on one memory tool write, from its footnote line. The reverse change lands only
   * while the line still reads as written; the event is then marked undone for every client.
   */
  private async undoMemoryWrite(message: Extract<ClientMessage, { type: 'undo_memory_write' }>, reply: (message: ServerMessage) => void, ack: () => void): Promise<void> {
    if (this.undoingWrites.has(message.writeId)) return
    this.undoingWrites.add(message.writeId)
    try {
      const event = (await this.options.store.loadEvents(message.chatId)).find((candidate) =>
        candidate.type === 'system_note' && candidate.projectFileWrite?.writeId === message.writeId)
      const write = event?.type === 'system_note' ? event.projectFileWrite : undefined
      if (event?.type !== 'system_note' || write === undefined || write.undone === true) {
        reply({ type: 'notice', kind: 'error', text: 'There is no memory write to undo here.' })
        return
      }
      const refusal = write.agentId === undefined
        ? await this.projectThreads.undoWrite(message.chatId, write)
        : await this.agentNotes.undoWrite(write)
      if (refusal !== undefined) {
        reply({ type: 'notice', kind: 'info', text: refusal })
        return
      }
      const undone = { ...event, projectFileWrite: { ...write, undone: true as const } }
      await this.options.store.replaceEvent(message.chatId, undone)
      this.options.broadcast({ type: 'event', chatId: message.chatId, event: undone })
      ack()
    } finally {
      this.undoingWrites.delete(message.writeId)
    }
  }

  /** The `react` tool's broker call; a `ReactionRefusal` goes back to the model. */
  react(context: UserInputContext, emoji: string): Promise<void> {
    return this.orchestrator.recordAgentReaction(context, emoji)
  }

  /** Checks and stores a file from `deliver_file`; the returned note goes back to the persona. */
  async deliverFile(context: UserInputContext, filePath: string, name?: string, viewport?: DeliveredViewport): Promise<string> {
    const { file, bytes } = await readDeliverable(filePath, name, undefined, viewport)
    if (!await this.orchestrator.recordFileDelivery(context, file, bytes)) {
      throw new FileDeliveryError('This turn has already ended, so the file was not added.')
    }
    const shown = file.mime === 'text/html' ? 'drawn live in the chat' : 'with Open and Save'
    return `Delivered ${file.name}. It appears under your reply ${shown}; do not repeat its path.`
  }

  /**
   * Reads the screenshots first, from the Session's own worktrees too, so a missing or
   * private one fails the call before anything is held; a refusal throws `FileDeliveryError`.
   */
  async recordGoalClaims(context: UserInputContext, claims: GoalClaim[], report?: GoalReport, screenshotPaths: readonly string[] = []): Promise<{ note: string } | { error: string }> {
    const worktrees = screenshotPaths.length === 0 ? [] : (await this.options.store.loadChatWorktrees(context.chatId)).map((mapping) => mapping.worktreePath)
    const screenshots = []
    for (const screenshot of screenshotPaths) {
      screenshots.push({ ...await readEvidenceImage(screenshot, worktrees), takenAt: (await stat(screenshot)).mtimeMs })
    }
    return this.orchestrator.recordGoalClaims(context, claims, report, screenshots)
  }

  /**
   * Opens a new agent's DM on its interview: a model-only kickoff, run on the ordinary
   * stored-message queue. The write path stays open until that turn ends.
   */
  private async startInterview(agent: AgentConfig): Promise<void> {
    const { store } = this.options
    const chat = await store.createChat({ kind: 'dm', memberIds: [agent.id] })
    const event = await store.appendEvent(chat.id, {
      type: 'user_message', text: '', instruction: interviewInstruction(agent, this.knownUserName()), mentions: [], dispatchState: 'pending',
    })
    if (event.type !== 'user_message') throw new Error('Could not store the interview kickoff.')
    const { interviews } = this.agentModule
    interviews.begin(agent.id, event.id)
    await this.projectModule.broadcast()
    void this.orchestrator.runStoredUserMessage(chat.id, event)
      .catch((error: unknown) => console.warn('[manor] the interview turn failed', error))
      .finally(() => interviews.end(agent.id, event.id))
  }

  /** The name from the user's profile, undefined while it is still the placeholder. */
  private knownUserName(): string | undefined {
    return this.userProfile.name === DEFAULT_USER_PROFILE.name ? undefined : this.userProfile.name
  }

  /** A memory-off persona's `offer_instructions_line`; its turn's result shows the latest one. Writes nothing. */
  offerInstructionsLine(context: UserInputContext, line: string): void {
    this.instructionsOffers.set(context.turnId, line)
  }

  /** The interview's `write_instructions`; refused once written or outside that turn. */
  writeInstructions(context: UserInputContext, instructions: string): Promise<void> {
    return this.agentModule.writeInstructions(context.agentId, instructions)
  }

  /** A persona's live session reported something between its turns. */
  onLiveSession(event: LiveSessionEvent): void {
    this.orchestrator.onLiveSession(event)
  }

  /** The delegate tools' broker: one entry for start, collect, cancel and capabilities. */
  subagents(): Subagents {
    return this.orchestrator.subagents
  }

  /** What one persona may delegate to right now, as the tool schema states it. */
  subagentCatalog(agentId: string): SubagentToolCatalog {
    const policy = this.subagentPolicy
    return {
      models: subagentChoices(policy, agentId, this.settings.disabledModels).map(({ driver, model, label, efforts }) => ({ model, label, provider: driver, efforts })),
      maxConcurrent: policy.maxConcurrent,
    }
  }

  /** Boot: read the saved settings and end children the last process left running. */
  async recoverSubagents(): Promise<number> {
    this.subagentPolicy = await this.options.store.getSubagentPolicy()
    this.userProfile = await this.options.store.getProfile()
    this.settings = await this.options.store.getHouseSettings()
    await this.projectThreads.prime().catch(() => undefined)
    void this.projectThreads.recoverBriefs().catch((error: unknown) => console.warn('[manor] could not recover forwarded briefs', error))
    return this.orchestrator.subagents.recover()
  }

  /** Project setup errors must not skip unrelated startup recovery. */
  async reconcileProjectSetup(): Promise<void> {
    const setup = await this.projectThreads.reconcileSetup()
    for (const project of setup) {
      if (project.error !== undefined) console.error('[manor] Project setup failed', project.project, project.error)
      else if (project.files.length > 0) console.info('[manor] Project setup', JSON.stringify(project))
    }
  }

  async recoverWorkCompletions(): Promise<void> {
    await this.workModule.reconcileCompletion()
  }

  closeAgentRelayTurn(turnId: string): void {
    this.orchestrator.closeAgentRelayTurn(turnId)
  }

  /**
   * The household: sent on connect beside the directory, and re-sent after every
   * agent change. Deliberately not part of `snapshot`, because Manor has one roster
   * shared by every chat and two copies of one list is how a stale label reaches the
   * screen.
   */
  roster(): ServerMessage {
    return this.agentModule.document()
  }

  /** How the app shows the user: sent on connect beside the roster and broadcast after a save. */
  profile(): ServerMessage {
    return { type: 'profile', profile: this.userProfile }
  }

  /** The household settings: sent on connect beside the profile and broadcast after a save. */
  houseSettings(): ServerMessage {
    return { type: 'house_settings', settings: this.settings }
  }

  /** What the lifecycle sweeps in `main.ts` act on, as last saved. */
  currentSettings(): HouseSettings {
    return this.settings
  }

  /**
   * The MCP registry: sent on connect beside the roster, and re-sent after every
   * registry change. One list for the household, for the same reason the roster is.
   */
  registry(): ServerMessage {
    return this.connectionModule.registry()
  }

  /** Registers, renews or marks unavailable the composio row after its key changed. */
  reconcileComposio(): Promise<void> {
    return this.connectionModule.reconcileComposio()
  }

  /** Machine-local MCP facts. Kept out of the shared registry because two hosts can disagree. */
  mcpHostStatuses(): ServerMessage {
    return this.connectionModule.hostStatuses()
  }

  /** The imported, provider-neutral skill registry shared by the household. */
  async skillRegistry(skills = this.options.skills?.() ?? []): Promise<ServerMessage> {
    return this.connectionModule.skillRegistry(skills)
  }

  /**
   * Whether this machine has a vault, sent on connect beside the roster. A capability
   * rather than content: the listing is asked for when the tab is opened, so a client
   * that never goes near Knowledge pays nothing for it.
   */
  vaultStatus(): ServerMessage {
    return this.hostModule.vaultStatus()
  }

  /** The Session commits still running, sent on connect so a reconnected window never shows a stale spinner. */
  sessionCommits(): ServerMessage {
    return this.sessionModule.commits()
  }

  /** Capability only. Content is fetched on demand when Artifacts opens. */
  mymindStatus(): ServerMessage {
    return this.myMindModule.status()
  }

  /**
   * Every routine in the house: sent on connect beside the roster, and re-sent after
   * every mutation. Household state rather than chat state, so it deliberately does
   * not ride along in `snapshot` — a routine outlives the chat that happens to be
   * open, and two copies of one list is how a stale row reaches the screen.
   */
  async routines(): Promise<ServerMessage> {
    return this.routineModule.document()
  }

  /** One open-loops sync, for the poll that catches ticks made outside Manor. */
  syncOpenLoops(): Promise<void> {
    return this.remindersModule.syncOpenLoops()
  }

  /** Baseline the change watch's refreshes compare against to find rows deleted outside Manor. */
  async primeHouseholdState(): Promise<void> {
    await Promise.all([
      this.routineModule.prime(),
      this.projectModule.prime(),
    ])
  }

  /**
   * Reconciles a row changed outside Manor's own request path. Internal writes have
   * already refreshed these documents, so an unchanged snapshot is a no-op.
   */
  async refreshHousehold(change: HouseholdChange): Promise<void> {
    if (change.resource === 'agents') {
      await this.agentModule.refresh()
      return
    }
    await this.routineModule.refresh(change)
  }

  /**
   * The one write seam behind the DM's built-in routine tools.
   *
   * Destination and persona are capability facts, never model input. Updating is
   * partial so "make it hourly" preserves the instruction the agent wrote one turn
   * earlier; creating still requires the three fields that make a routine concrete.
   */
  async useRoutineTool(
    context: RoutineToolContext,
    tool: RoutineToolName,
    input?: RoutineToolInput,
  ): Promise<unknown> {
    return this.routineModule.useTool(context, tool, input)
  }

  /** The only broker seam for a Chat persona's bounded Work write. */
  useWorkTool(context: WorkToolContext, input: WorkToolInput): Promise<unknown> {
    return this.workModule.useTool(context, input)
  }

  /**
   * Injects one routine's prompt as an ordinary user message addressed to its
   * persona. The single seam a routine runs through, shared by the scheduler in
   * `main.ts` and by `run_routine_now`: a second execution path would drift from
   * this one and every guard in `driveTurn` would have to be built twice.
   */
  runRoutineTurn(routine: Routine, chatId: string): Promise<void> {
    return this.routineModule.run(routine, chatId)
  }

  /** A routine's standing line with no turn behind it, e.g. a one-time routine that expired. */
  postRoutineNote(chatId: string, text: string): Promise<void> {
    return this.orchestrator.appendNote(chatId, text)
  }

  /** Host-only ergonomics, announced so another machine never sends a dead action. */
  hostCapabilities(): ServerMessage {
    return this.hostModule.capabilities()
  }

  /**
   * Handles one validated client message. `reply` answers the socket that asked (its
   * snapshot, its directory listing, or the notice saying its request went nowhere);
   * everything durable goes out to all of them.
   */
  async handle(message: ClientMessage, sendReply: (message: ServerMessage) => void): Promise<void> {
    const { store, autoRules = createAutoRulesFile() } = this.options
    const requestId = 'requestId' in message ? message.requestId : undefined
    const reply = (response: ServerMessage) => {
      sendReply(
        response.type === 'notice' && requestId !== undefined && response.requestId === undefined
          ? { ...response, requestId }
          : response,
      )
    }
    const ack = () => {
      if (requestId !== undefined) sendReply({ type: 'ack', requestId })
    }
    switch (message.type) {
      case 'register_push_token':
        await store.savePushToken(message.token)
        ack()
        return
      case 'unregister_push_token':
        await store.deletePushToken(message.token)
        ack()
        return
      case 'stop_subagent':
        if (!this.orchestrator.subagents.stop(message.chatId, message.toolCallId)) {
          reply({ type: 'notice', kind: 'error', text: 'That subagent is no longer running.' })
        }
        return
      case 'get_subagent_policy':
        reply({ type: 'subagent_policy', policy: this.subagentPolicy, ...(requestId === undefined ? {} : { requestId }) })
        return
      case 'save_subagent_policy': {
        const checked = SubagentPolicySchema.safeParse(message.policy)
        if (!checked.success) {
          const issue = checked.error.issues[0]
          reply({ type: 'notice', kind: 'error', text: issue?.message ?? 'invalid subagent settings' })
          return
        }
        this.subagentPolicy = await store.saveSubagentPolicy(checked.data)
        this.options.broadcast({ type: 'subagent_policy', policy: this.subagentPolicy })
        ack()
        return
      }
      case 'save_profile': {
        const checked = UserProfileSchema.safeParse(message.profile)
        if (!checked.success) {
          reply({ type: 'notice', kind: 'error', text: checked.error.issues[0]?.message ?? 'invalid profile' })
          return
        }
        this.userProfile = await store.saveProfile(checked.data)
        this.options.broadcast(this.profile())
        ack()
        return
      }
      case 'save_house_settings': {
        // Strict, so an app built after this server gets refused rather than told it saved a
        // setting the server dropped. That happens while a running server outlives an update.
        const checked = HouseSettingsSchema.strict().safeParse(message.settings)
        if (!checked.success) {
          const text = checked.error.issues.some((issue) => issue.code === 'unrecognized_keys')
            ? 'Restart Manor to save this setting. The running server does not know it yet.'
            : checked.error.issues[0]?.message ?? 'invalid settings'
          reply({ type: 'notice', kind: 'error', text })
          return
        }
        if (everyModelOff(checked.data.disabledModels)) {
          reply({ type: 'notice', kind: 'error', text: 'At least one model stays on.' })
          return
        }
        this.settings = await store.saveHouseSettings(checked.data)
        this.options.broadcast(this.houseSettings())
        ack()
        return
      }
      case 'get_context_files':
        reply({ type: 'context_files', ...await readContextFiles(this.memoryDir()), ...(requestId === undefined ? {} : { requestId }) })
        return
      case 'save_context_file': {
        // Reply-only: the editor polls while open, so other tabs catch up on their own.
        const root = this.memoryDir()
        const saved = await saveContextFile(root, message.name, message.content, message.baseHash)
        if (saved.ok) {
          reply({ type: 'context_files', ...await readContextFiles(root) })
          ack()
          return
        }
        if (saved.reason === 'stale') {
          // The new hash first, so the refusal lands on an editor that can already load it.
          reply({ type: 'context_files', ...await readContextFiles(root) })
        }
        reply({
          type: 'notice',
          kind: 'error',
          text: saved.reason === 'unavailable'
            ? 'This server has no memory folder to keep context files in.'
            : saved.reason === 'missing'
              ? `${message.name} is not on disk.`
              : `${message.name} changed on disk since you opened it. Your text is still here; load the new version or overwrite it.`,
        })
        return
      }
      case 'create_context_file': {
        const root = this.memoryDir()
        const created = await createContextFile(root, message.name)
        if (created.ok) {
          reply({ type: 'context_files', ...await readContextFiles(root) })
          ack()
          return
        }
        reply({
          type: 'notice',
          kind: 'error',
          text: created.reason === 'unavailable'
            ? 'This server has no memory folder to keep context files in.'
            : created.reason === 'exists'
              ? `${message.name} is already on disk.`
              : 'Manor does not keep that file.',
        })
        return
      }
      case 'get_system_info': {
        if (this.options.systemInfo === undefined) {
          reply({ type: 'notice', kind: 'error', text: 'This server does not report what it runs.' })
          return
        }
        reply({ type: 'system_info', info: await this.options.systemInfo(), ...(requestId === undefined ? {} : { requestId }) })
        return
      }
      case 'reveal_log': {
        const logs = (await this.options.systemInfo?.())?.logs ?? []
        const finder = this.options.externalFiles
        if (finder === undefined || !logs.some((log) => log.path === message.path)) {
          reply({ type: 'notice', kind: 'error', text: 'That log is not one Manor lists.' })
          return
        }
        await finder.open('finder', message.path)
        ack()
        return
      }
      case 'reveal_folder': {
        const info = await this.options.systemInfo?.()
        const target = message.folder === 'memory' ? info?.memory.path : info?.vault.path
        const finder = this.options.externalFiles
        if (finder === undefined || target == null) {
          reply({ type: 'notice', kind: 'error', text: 'That folder cannot be shown from here.' })
          return
        }
        await finder.open('finder', target)
        ack()
        return
      }
      case 'open_chat':
        // Opening a chat shows its Session cards; a blocked one reads Git again first.
        void this.workModule.recheckBlocked().catch(() => undefined)
        await this.chatModule.handle(message, reply, ack)
        return
      case 'change_session_answer':
        try {
          await this.projectThreads.changeAnswer(message.chatId, message.requestId, message.answers)
          ack()
        } catch (error: unknown) {
          reply({ type: 'notice', kind: 'error', text: error instanceof Error ? error.message : 'That answer could not be changed.' })
        }
        return
      case 'get_chat_summary':
      case 'get_agent_notes':
      case 'get_dm_files':
      case 'send_message':
      case 'stop':
      case 'stop_background':
      case 'answer_user_input':
      case 'answer_secret_request':
      case 'submit_outbound_draft':
      case 'discard_outbound_draft':
      case 'snooze_outbound_draft':
      case 'ignore_outbound_draft':
      case 'restore_outbound_draft':
      case 'outbound_thread_read':
      case 'set_chat_override':
        await this.chatModule.handle(message, reply, ack)
        return
      case 'list_composio_apps':
      case 'connect_composio_app':
      case 'disconnect_composio_app':
        if (this.options.composioMarketplace === undefined) {
          reply({ type: 'notice', kind: 'error', text: 'This Manor has no Composio marketplace.' })
          return
        }
        await this.options.composioMarketplace.handle(message, reply, ack)
        return
      case 'set_composio_key':
      case 'remove_composio_key':
        if (this.options.composioKey === undefined) {
          reply({ type: 'notice', kind: 'error', text: 'This Manor cannot keep a Composio key.' })
          return
        }
        await this.options.composioKey.handle(message, reply, ack)
        return
      case 'open_connect_card':
        if (this.options.connectCards === undefined || !(await this.options.connectCards.open(message.chatId, message.connectId))) {
          reply({ type: 'notice', kind: 'error', text: 'That connect card is no longer available.' })
          return
        }
        ack()
        return
      case 'get_routine_runs':
      case 'mark_routine_runs_read':
      case 'mark_all_routine_runs_read':
        await this.routineModule.handle(message, reply, ack)
        return
      case 'open_external_url':
      case 'list_dirs':
      case 'rename_vault_file':
      case 'create_vault_folder':
      case 'list_vault':
      case 'read_vault_file':
      case 'write_vault_file':
      case 'save_vault_image':
      case 'edit_vault_note':
      case 'cancel_vault_note_edit':
      case 'delete_vault_entry':
      case 'move_vault_entry':
        await this.hostModule.handle(message, reply)
        return
      case 'get_usage_report': {
        // Reply-only, and never pushed. It is the whole house's history in one
        // document, so broadcasting it after every turn would send a report to tabs
        // that are looking at a chat, and the view that wants it asks when it opens.
        const rates = await this.options.usageRates?.() ?? { table: new Map(), status: 'unavailable' as const }
        reply({
          type: 'usage_report',
          report: usageReportFromRuns(await store.usageRuns(), {
            windowDays: message.windowDays,
            timeZone: usableTimeZone(message.timeZone),
            now: Date.now(),
            rates,
          }),
        })
        return
      }
      case 'get_auto_rules': {
        const rules = await autoRules.read()
        if (rules === undefined) {
          reply({ type: 'notice', kind: 'error', text: 'The Auto rule file is missing or invalid on disk.' })
          return
        }
        reply({ type: 'auto_rules', rules, ...(requestId === undefined ? {} : { requestId }) })
        return
      }
      case 'save_auto_rules': {
        // Semantic check here, not at the wire: a dropped frame tells the dialog nothing.
        const checked = AutoRulesSchema.safeParse(message.rules)
        if (!checked.success) {
          const issue = checked.error.issues[0]
          const where = issue?.path.length ? `${issue.path.join('.')}: ` : ''
          reply({ type: 'notice', kind: 'error', text: `${where}${issue?.message ?? 'invalid rules'}` })
          return
        }
        const saved = await autoRules.write(checked.data)
        this.options.broadcast({ type: 'auto_rules', rules: saved })
        ack()
        return
      }
      case 'undo_memory_write':
        await this.undoMemoryWrite(message, reply, ack)
        return
      case 'set_reaction':
        try {
          await this.orchestrator.reactions.setUserReaction(message.chatId, message.eventId, message.emoji)
        } catch (error) {
          if (!(error instanceof ReactionRefusal)) throw error
          reply({ type: 'notice', kind: 'info', text: error.message })
          return
        }
        ack()
        return
      case 'get_project_memory':
      case 'list_repo_files':
      case 'read_repo_file':
      case 'write_repo_file':
      case 'open_repo_file':
        await this.projectModule.handle(message, {
          ...(requestId === undefined ? {} : { requestId }),
          send: sendReply,
          reply,
          ack,
        })
        return
      case 'list_mymind_objects':
      case 'load_more_mymind_objects':
        await this.myMindModule.handle(message, reply)
        return
      case 'create_project':
      case 'add_folder':
      case 'remove_folder':
      case 'create_chat':
      case 'delete_project':
      case 'open_side_chat':
      case 'set_side_runtime':
      case 'delete_chat':
      case 'set_chat_checkout':
      case 'discard_chat_worktree':
      case 'checkout_status':
      case 'set_chat_archived':
      case 'set_chat_members':
      case 'reorder_projects':
      case 'update_project':
      case 'find_repo_icon':
        await this.projectModule.handle(message, {
          ...(requestId === undefined ? {} : { requestId }),
          send: sendReply,
          reply,
          ack,
        })
        return
      case 'session_repo':
      case 'session_diff':
      case 'commit_session':
      case 'push_session':
      case 'open_session_folder':
        await this.sessionModule.handle(message, { reply, ack })
        return
      case 'set_chat_settled':
        await this.workModule.setSettled(message.chatId, message.settled)
        // A merged Session's folder leaves disk on settle and comes back on reopen.
        if (message.settled) {
          await this.projectModule.releaseMergedWorktrees(message.chatId)
        } else {
          await this.projectModule.restoreChatWorktrees(message.chatId).catch((error: unknown) => {
            reply({ type: 'notice', kind: 'error', text: error instanceof Error ? error.message : String(error) })
          })
        }
        return
      case 'create_project_thread':
      case 'remove_project_thread':
        try {
          if (message.type === 'create_project_thread') {
            const workChatId = await this.projectThreads.create(message.projectId)
            if (requestId !== undefined) sendReply({ type: 'ack', requestId, workChatId })
          } else {
            await this.projectThreads.remove(message.projectId)
            if (requestId !== undefined) sendReply({ type: 'ack', requestId })
          }
        } catch (error: unknown) {
          reply({ type: 'notice', kind: 'error', text: error instanceof Error ? error.message : 'The project thread could not be changed.' })
        }
        return
      case 'accept_work_handoff': {
        const reference = message.handoffId ?? message.chatId
        if (reference === undefined) throw new Error('A session proposal id is required.')
        const workChatId = await this.workModule.accept(reference, message)
        if (requestId !== undefined) sendReply({ type: 'ack', requestId, workChatId })
        return
      }
      case 'reject_work_handoff':
        await this.workModule.reject(message.handoffId)
        ack()
        return
      case 'confirm_work_goal':
        try {
          await this.workModule.confirmGoal(message.handoffId, message.mergeInto, message.version)
        } catch (error) {
          // The button named a branch the linked folders left; the fresh status relabels it before the retry.
          if (error instanceof MergeTargetMoved) {
            await this.projectModule.handle({ type: 'checkout_status', chatId: error.chatId }, { send: sendReply, reply, ack: () => undefined })
          }
          throw error
        }
        ack()
        return
      case 'retry_work_completion':
        await this.workModule.retryCompletion(message.handoffId)
        ack()
        return
      case 'approve_merge_fix':
        await this.workModule.approveMergeFix(message.handoffId, message.tip)
        ack()
        return
      case 'revise_work_goal':
        await this.workModule.reviseGoal(message.handoffId, message.version, message.text, message.images ?? [])
        ack()
        return
      case 'save_agent':
        await this.agentModule.handle(message, reply, ack)
        return
      case 'verify_mymind':
        await this.myMindModule.handle(message, reply)
        return
      case 'search':
        await this.searchModule.handle(message, reply)
        return
      case 'reminders_load':
      case 'reminders_load_completed':
      case 'reminders_write':
        await this.remindersModule.handle(message, reply, ack)
        return
      case 'save_mcp_server':
      case 'verify_mcp_server':
      case 'delete_mcp_server':
      case 'list_skill_candidates':
      case 'list_workflow_suggestions':
      case 'import_skill':
      case 'delete_skill':
        await this.connectionModule.handle(message, reply, ack)
        return
      case 'delete_agent':
        await this.agentModule.handle(message, reply, ack)
        return
      case 'save_routine':
      case 'delete_routine':
      case 'set_routine_enabled':
      case 'run_routine_now':
        await this.routineModule.handle(message, reply, ack)
        return
    }
    await this.broadcastDirectory()
    ack()
  }

  /**
   * Re-reads the household after an agent write and pushes it to every client. The
   * store is the source rather than the draft that was just saved: it is what settles
   * a derived id, and the chief-of-staff flag the same write cleared on somebody else.
   */
  private async reloadRoster(): Promise<void> {
    await this.agentModule.reload()
  }

  /** The memory folder the context files live in; null where the service was given none. */
  private memoryDir(): string | null {
    const target = this.options.memoryTarget
    return target === undefined ? null : memoryRoot(target) ?? null
  }

  /** Re-reads the routines after a write and pushes the whole list to every client. */
  async broadcastRoutines(): Promise<void> {
    await this.routineModule.broadcast()
  }

}
