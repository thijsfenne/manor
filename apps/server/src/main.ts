// First, on purpose: it reads the settings files before any other module looks at the environment.
import { DATA_ENV_FILE, envOrigin } from './envFiles.js'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { appendFile, mkdir } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import {
  BrowserToolNameSchema,
  ClientMessageSchema,
  DELIVERED_VIEWPORTS,
  GOAL_COMMIT_BODY_MAX,
  GOAL_COMMIT_SUBJECT_MAX,
  GOAL_LIMITATIONS_MAX,
  GOAL_RESULT_MAX,
  GoalClaimsSchema,
  GoalReportSchema,
  MAX_GOAL_CHOICES,
  MAX_GOAL_POINTS,
  GOAL_POINT_MAX,
  MAX_GOAL_EVIDENCE,
  PROJECT_CARD_FILE,
  ProjectThreadFileSchema,
  UserInputAnswersSchema,
  OutboundDraftContentSchema,
  type OutboundChannel,
  UserInputQuestionsSchema,
  daysToMs,
  defaultModel,
  type AgentConfig,
  type ServerMessage,
  type ThreadEvent,
} from '@manor/contracts'
import { WebSocket, WebSocketServer } from 'ws'
import { sendSocketPayload } from './socketSend.js'
import { gitBinary } from './gitBinary.js'
import { createDirectoryChannel } from './directoryChannel.js'
import { stopAllCliChildren } from './drivers/childTermination.js'
import { RuntimeDiagnostics, handleDiagnostics } from './runtimeDiagnostics.js'
import { LocalAuth } from './localAuth.js'
import { ensureLocalAccessToken, isLocalAccessToken } from './localAccess.js'
import { createGate, createUpgradeGuard, rejectUpgrade } from './auth.js'
import { ArtifactBroker, ARTIFACT_TOOL_NAMES, type ArtifactToolName } from './artifactBroker.js'
import { ArtifactCapabilities, InvalidArtifactCapabilityError } from './artifactCapability.js'
import { BrowserBroker } from './browserBroker.js'
import { browserTabsNote, browserTargetContext } from './browserTarget.js'
import { browserReviewArguments } from './browserEffectReview.js'
import { BrowserCapabilities, InvalidBrowserCapabilityError } from './browserCapability.js'
import { InteractionBroker, askedByModel, preferenceAnswerText } from './interactionBroker.js'
import { OutboundDrafts } from './outboundDrafts.js'
import { readMailThread } from './mcp/mailMcp.js'
import { createMockOutboundSendPort, createOutboundSendPort } from './outboundSend.js'
import { InvalidUserInputCapabilityError, UserInputCapabilities } from './interactionCapability.js'
import { closeTerminalTurn } from './agentRelayLifecycle.js'
import { EffectBroker } from './effectBroker.js'
import { createEffectReviewer, EFFECT_REVIEW_RUNTIMES } from './effectReviewer.js'
import { EffectCapabilities, InvalidEffectCapabilityError } from './effectCapability.js'
import { ConnectCards, type ConnectRequest } from './connectCards.js'
import { liveConnectCardPorts, mockConnectCardPorts } from './connectCardPorts.js'
import { ComposioMarketplace } from './composioMarketplace.js'
import { liveComposioMarketplacePorts, liveComposioOutbound, mockComposio } from './composioMarketplacePorts.js'
import { isComposioConnectUrl } from './mcp/connectLinks.js'
import type { McpServerConfig } from '@manor/contracts'
import { DesktopLease } from './desktopLease.js'
import { BROWSER_FILL_LOGIN_TOOL, browserEffect } from './effectPolicy.js'
import { fillSavedLogin, secretPasswordPage } from './browserLoginFill.js'
import { SecretRequestInputSchema, SecretRequests } from './secretRequests.js'
import { InvalidRoutineCapabilityError, RoutineCapabilities } from './routineCapability.js'
import { InvalidWorkCapabilityError, WorkCapabilities } from './workCapability.js'
import {
  ROUTINE_TOOL_NAMES,
  RoutineToolCancelInputSchema,
  RoutineToolSaveInputSchema,
  type RoutineToolName,
} from './routineTool.js'
import {
  InvalidSkillCapabilityError,
  readableSkillBundleLoader,
  SkillCapabilities,
} from './skillCapability.js'
import {
  CHAT_TITLE_FALLBACK_MODEL,
  CHAT_TITLE_MODEL,
  createChatTitleGenerator,
  generateFallbackChatTitle,
} from './chatTitle.js'
import {
  CHAT_SUMMARY_FALLBACK_MODEL,
  CHAT_SUMMARY_MODEL,
  ChatSummaryTooLong,
  createChatSummaryGenerator,
  createChatSummaryUpdater,
  generateFallbackChatSummary,
} from './chatSummary.js'
import {
  resolveEffectMode,
  resolveAllowedOrigins,
  resolveAuthConfig,
  resolveDelegationCap,
  resolveWakeCap,
  resolveListenHost,
  resolveMyMindConfig,
  resolveRelayLimits,
  resolveRoutinesMode,
  resolveStoreConfig,
  resolveUnauthenticatedBind,
  resolveRemindersMode,
  resolveVaultDir,
  vaultDirPinned,
} from './config.js'
import { ROUTINE_TICK_INTERVAL_MS, tickRoutines, recoverFinishedRoutines, purgeEndedRoutines } from './routineScheduler.js'
import { createNoteEditor } from './noteEdit.js'
import { ScratchLifecycle } from './scratch.js'
import {
  createEffectReviewDriver,
  createChatSummaryDriver,
  createChatTitleDriver,
  createChatTitleFallbackDriver,
  createMemoryWriterDriver,
  createDrivers,
  createGroupTurnRouterDriver,
} from './drivers/index.js'
import { rekeyAcross } from './capabilityRekey.js'
import { TurnIdleGate } from './drivers/turnTimers.js'
import { createTypesafeRuntimeSelector } from './drivers/typesafeRuntime.js'
import { createAutoRulesFile } from './autoRules.js'
import { createTypesafeMemoryRanker } from './drivers/typesafeMemory.js'
import { createExternalLinkOpener } from './externalLinks.js'
import { createExternalFileOpener } from './externalFiles.js'
import { ARTIFACT_BROKER_CAPABILITY_ENV, artifactMcpAttachment } from './mcp/artifactAttachment.js'
import { artifactMcpServer } from './mcp/artifactServer.js'
import { reconcileComposioServer, retryComposioInBackground } from './mcp/composioRegistration.js'
import { COMPOSIO_API_KEY_ENV, COMPOSIO_MCP_NAME, COMPOSIO_RECOVERY_DESCRIPTION, composioApiKeyEnv } from './mcp/composioAttachment.js'
import { fetchComposioCatalog } from './mcp/composioCatalog.js'
import { ComposioKey } from './composioKey.js'
import { probeMcpServer } from './mcp/probe.js'
import { BROWSER_BROKER_CAPABILITY_ENV, browserMcpAttachment } from './mcp/browserAttachment.js'
import { browserMcpServer } from './mcp/browserServer.js'
import { effectCapabilityEnvKey, effectProxyAttachment, effectProxyUpstream, forwardsOverHttp, proxySecretEnv } from './mcp/effectProxyAttachment.js'
import { StdioPool, sharesStdioProcess, stdioConnectorEndpoint } from './mcp/stdioPool.js'
import { HttpConnector } from './mcp/httpConnector.js'
import { McpHttpHost, connectorEndpoint } from './mcp/httpHost.js'
import { USER_INPUT_CAPABILITY_ENV, askModeFor, interactionMcpAttachment } from './mcp/interactionAttachment.js'
import { interactionMcpServer } from './mcp/interactionServer.js'
import { answerInstructionsCall } from './agentInterview.js'
import { FileDeliveryError } from './fileDelivery.js'
import { ROUTINE_BROKER_CAPABILITY_ENV, routineMcpAttachment } from './mcp/routineAttachment.js'
import { routineMcpServer } from './mcp/routineServer.js'
import { WORK_BROKER_CAPABILITY_ENV, workMcpAttachment } from './mcp/workAttachment.js'
import { workMcpServer } from './mcp/workServer.js'
import { SKILL_READER_CAPABILITY_ENV, skillMcpAttachment } from './mcp/skillAttachment.js'
import { skillMcpServer } from './mcp/skillServer.js'
import { reconcileFigmaServer } from './mcp/figmaRegistration.js'
import { reconcileMailServers } from './mcp/mailRegistration.js'
import { reconcileCalendarServer } from './mcp/calendarRegistration.js'
import { reconcileRemindersServer } from './mcp/remindersRegistration.js'
import { reconcileCodexComputerServer } from './mcp/codexComputerRegistration.js'
import { CODEX_COMPUTER_MCP_NAME } from './computerPolicy.js'
import { PAPER_MCP_NAME } from './mcp/paperAttachment.js'
import { probePaperRow, reconcilePaperServer } from './mcp/paperRegistration.js'
import { memoryRoot, memoryDirPinned, memoryTargetNotice, resolveMemoryTarget } from './memoryTarget.js'
import { ensureMemoryFolder } from './memoryScaffold.js'
import { validateRepoPath } from './repo.js'
import { createMemoryWriter, MEMORY_WRITER_FALLBACK_MODEL, MEMORY_WRITER_MODEL } from './memoryWriter.js'
import { liveAttempts, type SideAttempt } from './sideAttempts.js'
import { readBuildInfo, SERVER_ROOT, serverFile } from './serverRoot.js'
import { createMemoryCompressor, MEMORY_COMPRESS_INTERVAL_MS } from './memoryCompress.js'
import {
  MEMORY_TRACE_FALLBACK_MODEL,
  MEMORY_TRACE_MODEL,
  createMemoryTraceGenerator,
  generateFallbackMemoryTrace,
} from './memoryTrace.js'
import {
  GROUP_TURN_ROUTER_FALLBACK_MODEL,
  GROUP_TURN_ROUTER_MODEL,
  createGroupTurnRouter,
  fallbackGroupTurnRoute,
  type RouteGroupTurn,
} from './groupTurnRouter.js'
import { readWorkflowSuggestions } from './workflowSuggestions.js'
import { createMyMindClient, MYMIND_THUMBNAIL_PREFIX, type MyMindClient } from './mymind.js'
import { dataPaths } from './paths.js'
import { ProviderUsageService } from './providerUsage.js'
import { createRateLoader } from './usageRates.js'
import { mockProviderUsage } from './drivers/mockDriver.js'
import { ProviderUpdateService } from './providerUpdates.js'
import { ProviderConnectionService } from './providerConnections.js'
import { ProviderUsageHistory } from './providerUsageHistory.js'
import { createDesktopPresence } from './desktopPresence.js'
import { createPushNotifier } from './pushNotifications.js'
import { ManorService } from './service.js'
import { SETTLE_SWEEP_INTERVAL_MS, sweepIdleChats } from './settleSweep.js'
import { SPIKE_SWEEP_INTERVAL_MS, stopUnregisteredSpikes, sweepSpikes } from './spikeSweep.js'
import { defaultSkillRoots, discoverSkills } from './skills/discovery.js'
import { defaultSkillUsagePath, readSkillUsage, recordSkillUsage } from './skills/usage.js'
import { createChatMedia } from './chatMedia.js'
import { createRemoteImages } from './remoteImages.js'
import { createStaticHandler } from './static.js'
import { createStore } from './stores/index.js'
import { claimDatabaseOwner } from './stores/sqliteDatabase.js'
import { sweepUnterminatedTurns } from './turnSweep.js'
import { SubagentRefusal } from './subagents.js'
import { openVault, type Vault } from './vault.js'
import { createSystemInfo } from './systemInfo.js'
import { RemindersSource, remindersBinaries } from './reminders.js'
import { OPEN_LOOPS_LIST, OPEN_LOOPS_POLL_MS, OpenLoopsSync } from './openLoopsSync.js'
import { WorkToolInputSchema } from './workTool.js'
import {
  createWorkOutcomeGenerator,
  generateFallbackWorkOutcome,
  WORK_OUTCOME_FALLBACK_MODEL,
  WORK_OUTCOME_MODEL,
} from './workOutcome.js'
import { COMMIT_MESSAGE_FALLBACK_MODEL, COMMIT_MESSAGE_MODEL, createCommitMessageWriter } from './commitMessage.js'

const PORT = Number(process.env.MANOR_PORT ?? 8787)
const WS_PATH = '/ws'
/** Protocol ping. A connection that misses one whole round is hung up on. */
const PING_INTERVAL_MS = 30_000
/** App-level proof of life, so the client can measure silence rather than trust TCP. */
const HEARTBEAT_INTERVAL_MS = 20_000

let databaseOwner: ReturnType<typeof claimDatabaseOwner> | undefined

async function main(): Promise<void> {
  // Until startup finishes, retain immediate termination after recording the signal.
  let shutdown: (signal: 'SIGTERM' | 'SIGINT') => void | Promise<void> = (signal) => {
    process.exit(signal === 'SIGINT' ? 130 : 143)
  }
  let shuttingDown = false
  const stop = (signal: 'SIGTERM' | 'SIGINT') => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[manor] ${new Date().toISOString()} stopping pid=${process.pid} signal=${signal} uptime=${process.uptime().toFixed(3)}s`)
    void shutdown(signal)
  }
  process.once('SIGTERM', () => { stop('SIGTERM') })
  process.once('SIGINT', () => { stop('SIGINT') })
  let commit = readBuildInfo()?.commit ?? 'unknown'
  if (commit === 'unknown') try {
    commit = execFileSync(gitBinary(), ['rev-parse', 'HEAD'], {
      cwd: path.resolve(SERVER_ROOT, '..', '..'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1_000,
    }).trim()
  } catch {
    // A packaged server may have no git checkout or git executable.
  }
  console.log(`[manor] ${new Date().toISOString()} starting pid=${process.pid} ppid=${process.ppid} commit=${commit}`)
  const resolved = resolveStoreConfig(process.env)
  if (!resolved.ok) {
    console.error(`[manor] ${resolved.message}`)
    process.exit(1)
  }

  const auth = resolveAuthConfig(process.env, resolved.config)
  if (!auth.ok) {
    console.error(`[manor] ${auth.message}`)
    process.exit(1)
  }

  const host = resolveListenHost(process.env)
  const bind = resolveUnauthenticatedBind(process.env, auth.config, host)
  if (!bind.ok) {
    console.error(`[manor] ${bind.message}`)
    process.exit(1)
  }

  const delegation = resolveDelegationCap(process.env)
  if (!delegation.ok) {
    console.error(`[manor] ${delegation.message}`)
    process.exit(1)
  }

  const wakes = resolveWakeCap(process.env)
  if (!wakes.ok) {
    console.error(`[manor] ${wakes.message}`)
    process.exit(1)
  }

  const relayLimits = resolveRelayLimits(process.env)
  if (!relayLimits.ok) {
    console.error(`[manor] ${relayLimits.message}`)
    process.exit(1)
  }

  const routines = resolveRoutinesMode(process.env)
  if (!routines.ok) {
    console.error(`[manor] ${routines.message}`)
    process.exit(1)
  }

  const origins = resolveAllowedOrigins(process.env)
  if (!origins.ok) {
    console.error(`[manor] ${origins.message}`)
    process.exit(1)
  }

  const mymindConfig = resolveMyMindConfig(process.env)
  if (!mymindConfig.ok) {
    console.warn(`[manor] ${mymindConfig.message} Artifacts will stay unavailable.`)
  }
  const mymind = !mymindConfig.ok || mymindConfig.config === undefined
    ? undefined
    : createMyMindClient(mymindConfig.config)

  const paths = dataPaths(undefined, { ephemeral: resolved.config.kind === 'memory' })
  const scratch = new ScratchLifecycle(paths.scratch)
  // Module-held, so the claim lives exactly as long as this process.
  if (resolved.config.kind === 'sqlite') databaseOwner = claimDatabaseOwner(resolved.config.filename)
  const store = createStore(resolved.config)
  const localAuth = auth.config.mode === 'on' && 'filename' in auth.config && store.db !== undefined
    ? new LocalAuth(store.db, auth.config.ownerUserId)
    : undefined
  // The desktop shell on this Mac reads this key from the data directory; other devices sign in.
  const localAccessToken = localAuth === undefined ? undefined : ensureLocalAccessToken(paths.localAccessToken)
  // One cell for the household, read through `agents` by the service, the orchestrator
  // and all three drivers. Nothing captures the list itself, so a persona saved from
  // the UI is live on the next turn instead of after the next restart.
  let roster = await store.loadRoster()
  const agents = () => roster
  // Fed by the desktop shell's socket; a plain browser or the phone never reports, so
  // without a shell every push goes out as before.
  const presence = createDesktopPresence()
  const push = createPushNotifier({ store, agents, presence })
  if (roster.length === 0) console.warn('[manor] the roster is empty: no persona can be mentioned')

  // Same live-cell shape as the roster, for the same reason: a server registered from
  // the UI applies to the next turn instead of after the next restart.
  let registry = await store.listMcpServers()
  const mcpServers = () => registry
  registry = await reconcileMailServers(store, registry)
  registry = await reconcileCalendarServer(store, registry)
  registry = await reconcileRemindersServer(store, registry)
  registry = await reconcileCodexComputerServer(store, registry)
  registry = await reconcileFigmaServer(store, registry)
  registry = await reconcilePaperServer(store, registry)
  registry = await reconcileComposioServer(store, registry)

  // Imported skills are owned database copies. Discovery remains a fresh local scan
  // only when the Skills screen asks for candidates, so a missing provider folder is
  // an empty import list rather than startup failure.
  let skillRegistry = await store.listSkills()
  const skills = () => skillRegistry
  const skillRoots = defaultSkillRoots(homedir())
  const skillUsagePath = defaultSkillUsagePath(homedir())

  // Rows imported before bundles existed have their owned SKILL.md but no supporting
  // files. Upgrade those once from the same source folder. A later local edit does
  // not silently mutate Manor's copy; re-import remains an explicit action.
  const textOnly = skillRegistry.filter((skill) => skill.bundleRevision === undefined)
  if (textOnly.length > 0) {
    try {
      const discovered = await discoverSkills(skillRoots)
      let upgraded = 0
      let failed = 0
      for (const existing of textOnly) {
        const found = discovered.find(({ skill }) => skill.id === existing.id)
        if (found === undefined) continue
        const sources = [...new Set([...existing.sources, ...found.skill.sources])]
        try {
          await store.saveSkill({ ...found.skill, sources }, found.files)
          upgraded += 1
        } catch {
          failed += 1
        }
      }
      if (upgraded > 0) {
        skillRegistry = await store.listSkills()
        console.log(`[manor] upgraded ${upgraded} imported ${upgraded === 1 ? 'skill' : 'skills'} to owned bundles`)
      }
      if (failed > 0) console.warn(`[manor] ${failed} imported skill ${failed === 1 ? 'bundle' : 'bundles'} could not be upgraded`)
    } catch (error) {
      // Text-only imports remain usable. Their support files are unavailable until a
      // later restart succeeds, which is safer than taking all of Manor down.
      console.warn('[manor] imported skill bundles could not be upgraded', error)
    }
  }

  const forceMock = process.env.MANOR_DRIVER === 'mock'
  const autoRules = createAutoRulesFile()
  // Side jobs (titles, summaries, the daily log) keep the providers they prefer, as
  // long as those can answer, and fall through to any other signed-in provider. Claude
  // and Codex have their own capped side runtimes; Grok and Cursor answer through the
  // main driver on their default model. Read at job time, long after startup wired
  // the drivers and the connection service below.
  const side = (preferred: readonly SideAttempt[]): Iterable<SideAttempt> => liveAttempts(
    preferred,
    () => providerConnections.usable(),
    (provider) => {
      if (provider !== 'grok' && provider !== 'cursor') return undefined
      const driver = drivers.byProvider[provider]
      const model = defaultModel(provider)
      return driver === undefined || model === undefined ? undefined : { driver, runtime: provider, model }
    },
  )
  const generateTitle = forceMock
    ? generateFallbackChatTitle
    : createChatTitleGenerator({
        attempts: side([
          { driver: createChatTitleFallbackDriver(agents), runtime: 'claude', model: CHAT_TITLE_MODEL },
          { driver: createChatTitleDriver(agents), runtime: 'codex', model: CHAT_TITLE_FALLBACK_MODEL },
        ]),
        ensureScratchDir: (chatId) => scratch.ensure(chatId),
        onError: (_error, attempt) =>
          console.warn(`[manor] chat title generation failed on ${attempt.model}`),
      })
  const generateSummary = forceMock
    ? generateFallbackChatSummary
    : createChatSummaryGenerator({
        attempts: side([
          { driver: createChatSummaryDriver(agents), runtime: 'codex', model: CHAT_SUMMARY_MODEL },
          {
            driver: createChatTitleFallbackDriver(agents),
            runtime: 'claude',
            model: CHAT_SUMMARY_FALLBACK_MODEL,
          },
        ]),
        ensureScratchDir: (chatId) => scratch.ensure(chatId),
        onError: (error, attempt) =>
          console.warn(`[manor] chat summary generation failed on ${attempt.model}${
            error instanceof ChatSummaryTooLong ? ': still over the limit after one retry, so no other provider is tried' : ''
          }`),
      })
  const advanceChatSummary = createChatSummaryUpdater({
    store,
    agents,
    generate: generateSummary,
    onError: () => console.warn('[manor] could not advance a chat summary'),
  })
  const routeGroupTurn: RouteGroupTurn = forceMock
    ? (input) => Promise.resolve(fallbackGroupTurnRoute(input))
    : createGroupTurnRouter({
        attempts: side([
          { driver: createGroupTurnRouterDriver(agents), runtime: 'codex', model: GROUP_TURN_ROUTER_MODEL },
          {
            driver: createChatTitleFallbackDriver(agents),
            runtime: 'claude',
            model: GROUP_TURN_ROUTER_FALLBACK_MODEL,
          },
        ]),
        ensureScratchDir: (chatId) => scratch.ensure(chatId),
        onError: (_error, attempt) =>
          console.warn(`[manor] group turn routing failed on ${attempt.model}`),
      })
  const rankStructuredMemory = forceMock ? undefined : createTypesafeMemoryRanker(process.env.TYPESAFE_API_KEY)
  const generateMemoryTrace = forceMock
    ? generateFallbackMemoryTrace
    : createMemoryTraceGenerator({
        attempts: side([
          { driver: createChatSummaryDriver(agents), runtime: 'codex', model: MEMORY_TRACE_MODEL },
          {
            driver: createChatTitleFallbackDriver(agents),
            runtime: 'claude',
            model: MEMORY_TRACE_FALLBACK_MODEL,
          },
        ]),
        ensureScratchDir: (chatId) => scratch.ensure(chatId),
        onError: (_error, attempt) =>
          console.warn(`[manor] memory trace generation failed on ${attempt.model}`),
      })
  const generateWorkOutcome = forceMock
    ? generateFallbackWorkOutcome
    : createWorkOutcomeGenerator({
        attempts: side([
          { driver: createChatTitleFallbackDriver(agents), runtime: 'claude', model: WORK_OUTCOME_MODEL },
          { driver: createChatSummaryDriver(agents), runtime: 'codex', model: WORK_OUTCOME_FALLBACK_MODEL },
        ]),
        ensureScratchDir: (chatId) => scratch.ensure(chatId),
        onError: (_error, model) => console.warn(`[manor] Work outcome generation failed on ${model}`),
      })
  const writeCommitMessage = forceMock
    ? undefined
    : createCommitMessageWriter({
        attempts: side([
          { driver: createChatTitleFallbackDriver(agents), runtime: 'claude', model: COMMIT_MESSAGE_MODEL },
          { driver: createChatSummaryDriver(agents), runtime: 'codex', model: COMMIT_MESSAGE_FALLBACK_MODEL },
        ]),
        ensureScratchDir: (chatId) => scratch.ensure(chatId),
        onError: (_error, model) => console.warn(`[manor] Commit message generation failed on ${model}`),
      })
  // Which branch of the user's daily-log rule the personas follow, said out loud so it
  // is a setting the user can read rather than behaviour they have to infer from a chat.
  // Folders picked in Settings apply at the next start; an environment variable wins.
  const savedFolders = await store.getHouseSettings()
  const memoryTarget = resolveMemoryTarget(process.env, homedir(), savedFolders.memoryDir)
  console.log(memoryTargetNotice(memoryTarget))
  // A new install gets starter files; a folder that already holds anything is left alone.
  const memoryFolder = memoryRoot(memoryTarget)
  if (memoryFolder !== undefined) {
    const created = await ensureMemoryFolder(memoryFolder).catch((error: unknown) => {
      console.warn(`[manor] could not prepare the memory folder ${memoryFolder}`, error)
      return false
    })
    if (created) console.log(`[manor] started a new memory folder at ${memoryFolder}`)
  }
  // A session without a project works in the memory system: the home room's folder is
  // the memory folder. Nothing is stored for it, so a moved memory folder is followed.
  const homeFolder = memoryFolder === undefined ? undefined : await validateRepoPath(memoryFolder)
  const homeFolders = homeFolder?.ok === true ? [homeFolder.path] : []
  if (homeFolder?.ok === false) console.warn(`[manor] sessions without a project have no folder this run: ${homeFolder.message}`)
  await store.setHomeFolders(homeFolders)
  const memoryAttempts = side([
    { driver: createMemoryWriterDriver(agents), runtime: 'claude', model: MEMORY_WRITER_MODEL },
    { driver: createChatSummaryDriver(agents), runtime: 'codex', model: MEMORY_WRITER_FALLBACK_MODEL },
  ])
  const writeDailyLog = forceMock
    ? undefined
    : createMemoryWriter({
        attempts: memoryAttempts,
        dailyDir: memoryTarget.dailyDir,
        ensureScratchDir: (chatId) => scratch.ensure(chatId),
        onError: (_error, attempt) => console.warn(`[manor] daily log writer failed on ${attempt.model}`),
      })
  // Old days of the daily log become long-term memory, in a folder that has the file.
  const compressMemory = forceMock || memoryFolder === undefined
    ? undefined
    : createMemoryCompressor({
        root: memoryFolder,
        // Asked fresh: at startup no client has connected yet, so nothing was probed.
        attempts: async () => {
          await providerConnections.check()
          return memoryAttempts
        },
        ensureScratchDir: (threadId) => scratch.ensure(threadId),
        onError: (_error, attempt) => console.warn(`[manor] memory compression failed on ${attempt.model}`),
      })
  const suggestionsPath = path.resolve(memoryTarget.dailyDir, '..', 'skill-candidates.md')

  // The current Chrome app is only a local shell. Advertise Dia only when it is
  // installed on this Mac; the VPS and every other host keep normal web links.
  const externalLinks = createExternalLinkOpener()
  const externalFiles = createExternalFileOpener()

  // The vault is Mac-local by nature, so "there is no vault here" is an ordinary
  // state rather than a misconfiguration: on the VPS the variable is simply unset and
  // the Knowledge tab does not exist.
  //
  // An unusable path is loud but never fatal, and that is the one place this setting
  // deliberately breaks the house rule that a bad setting kills the process. The
  // store and the delegation cap are fatal because a server that runs without them
  // looks exactly like one that has them; a missing vault announces itself twice
  // over, in this line and in the tab that is not on screen.
  // Apple Reminders lives on this Mac. The CLIs are looked up again on every read, so
  // RemCTL installed beside remindctl needs no restart; with neither there is no door.
  // A mock run only sees a CLI in its own HOME, so it can never read the real list.
  const findReminderClis = () => remindersBinaries(undefined, undefined, forceMock)
  const foundReminderClis = findReminderClis()
  const remindersMode = resolveRemindersMode(process.env, forceMock)
  if (!remindersMode.ok) {
    console.error(`[manor] ${remindersMode.message}`)
    process.exit(1)
  }
  const remindersSource = remindersMode.on && process.platform === 'darwin' &&
    (foundReminderClis.remctl !== undefined || foundReminderClis.remindctl !== undefined)
    ? new RemindersSource({ binaries: findReminderClis })
    : undefined
  // The open-loops ledger and its Reminders list, kept in step both ways. Only where
  // the folder has a ledger, and never on a mock run, which must not touch a real list.
  const openLoopsLedger = memoryFolder === undefined ? undefined : path.join(memoryFolder, 'memory', 'open-loops.md')
  const openLoops = remindersSource !== undefined && !forceMock && openLoopsLedger !== undefined && existsSync(openLoopsLedger)
    ? new OpenLoopsSync({
      source: remindersSource,
      ledgerPath: openLoopsLedger,
      statePath: path.join(homedir(), '.manor', 'open-loops-sync.json'),
    })
    : undefined
  const vaultDir = resolveVaultDir(process.env, homedir(), savedFolders.knowledgeDir)
  let vault: Vault | undefined
  if (!vaultDir.ok) {
    console.warn(`[manor] ${vaultDir.message}`)
  } else {
    // Only the default folder is created. One the user named and that is not there
    // is a mistake to hear about, not a folder to invent.
    if (vaultDir.source === 'default') await mkdir(vaultDir.dir, { recursive: true }).catch(() => undefined)
    const opened = await openVault(vaultDir.dir)
    if (opened.ok) {
      vault = opened.vault
      console.log(`[manor] vault "${vault.name}" is open for reading and writing`)
    } else {
      // Loud, because a vault that was configured and did not load is a mistake to
      // fix, not a state to discover by finding a tab that is missing.
      console.warn(`[manor] ${opened.message} Running without the Knowledge tab.`)
    }
  }

  // Before anything can connect. The previous process may have been killed mid-turn,
  // and a turn that ends without a terminal event is one the transcript otherwise
  // renders as quietly finished. Failing here must not keep the server down: a chat
  // missing an explanation is worse than the chat, but not worse than no Manor.
  const bootInputs = new Map<string, Extract<ThreadEvent, { type: 'user_message' }>[]>()
  await sweepUnterminatedTurns({
    store,
    agents: roster,
    onRecoveryInputs: (chatId, events) => bootInputs.set(chatId, [...events]),
    onSwept: (count) =>
      console.warn(`[manor] closed ${count} ${count === 1 ? 'turn' : 'turns'} left hanging by a previous run`),
  }).catch((error: unknown) => {
    bootInputs.clear()
    console.error('[manor] could not close hanging turns', error)
  })

  const clients = new Set<WebSocket>()
  const browser = new BrowserBroker()
  const browserCapabilities = new BrowserCapabilities()
  const browserBrokerUrl = `http://127.0.0.1:${PORT}/internal/browser-tool`
  const artifactBrokerUrl = `http://127.0.0.1:${PORT}/internal/artifact-tool`
  const userInputBrokerUrl = `http://127.0.0.1:${PORT}/internal/user-input`
  const agentRelayBrokerUrl = `http://127.0.0.1:${PORT}/internal/agent-relay`
  const subagentBrokerUrl = `http://127.0.0.1:${PORT}/internal/subagent`
  const effectBrokerUrl = `http://127.0.0.1:${PORT}/internal/effect-approval`
  const computerStopUrl = `http://127.0.0.1:${PORT}/internal/computer-stop`
  const routineBrokerUrl = `http://127.0.0.1:${PORT}/internal/routine-tool`
  const workBrokerUrl = `http://127.0.0.1:${PORT}/internal/work-tool`
  const skillBrokerUrl = `http://127.0.0.1:${PORT}/internal/skill-file`
  // Manor's own MCP servers and its HTTP connectors answer here, so a turn spawns none of them.
  const mcpHost = new McpHttpHost(`http://127.0.0.1:${PORT}`)
  // The mock driver speaks no MCP: it reads each built-in's broker flags and posts to the
  // broker itself, so under it the built-ins stay flag carriers with no command.
  const serveBuiltIn: McpHttpHost['serveBuiltIn'] = forceMock
    ? (attached) => attached
    : (attached, capabilityEnv, create, turnId) => mcpHost.serveBuiltIn(attached, capabilityEnv, create, turnId)
  // One process per stdio connector for every turn; mounts come and go with turns.
  const stdioPool = new StdioPool()
  const artifactCapabilities = new ArtifactCapabilities()
  const artifactBroker = mymind === undefined ? undefined : new ArtifactBroker(mymind)
  const userInputCapabilities = new UserInputCapabilities()
  // Computer use needs the desktop host socket that registered the Escape stop.
  const desktopLease = new DesktopLease<{ send(payload: string): void }>({
    nameOf: (agentId) => roster.find((agent) => agent.id === agentId)?.name ?? 'another agent',
    onArmed: (host, armed, arm) => host.send(JSON.stringify({
      type: 'computer_stop_armed', armed,
      ...(arm === undefined ? {} : { armId: arm.armId, stopToken: arm.stopToken, stopUrl: computerStopUrl }),
    } satisfies ServerMessage)),
  })
  const effectCapabilities = new EffectCapabilities(desktopLease)
  const routineCapabilities = new RoutineCapabilities()
  const workCapabilities = new WorkCapabilities()
  const skillCapabilities = new SkillCapabilities(readableSkillBundleLoader(
    (skillId) => store.loadSkillBundle(skillId),
    (skillId) => skills().find((skill) => skill.id === skillId && skill.bundleRevision === undefined),
  ))
  const idleGate = new TurnIdleGate()
  let service: ManorService
  // Created before the drafts and the cards: drafts send through it and wait on its cards.
  const composio = forceMock ? mockComposio() : undefined
  let composioMarketplace: ComposioMarketplace | undefined
  const composioPorts = composio?.ports ?? liveComposioMarketplacePorts(() => mcpServers())
  const composioOutbound = composio?.outbound ?? liveComposioOutbound()
  // The spike sends only through its mock Composio: no host mailbox or Slack session is read.
  const outboundSend = forceMock ? createMockOutboundSendPort(composioOutbound) : createOutboundSendPort(composioOutbound)
  const outboundDrafts = new OutboundDrafts({
    store,
    send: outboundSend,
    emit: (message) => send(message),
    connect: async (context, channel, inTime) => {
      if (!composioOutbound.available()) return undefined
      // Same alias rule as every Composio connect: a send account is always the personal one.
      const link = await composioPorts.createLink(channel, 'personal')
      // A link that came back after the agent's call gave up puts no card in the chat.
      if (!inTime()) return { status: 'failed', reason: 'connecting took too long' }
      return connectCards.request(context, { kind: 'composio', toolkit: channel, alias: 'personal', ...link })
    },
    threadReader: {
      read: (draft) => {
        if (draft.channel !== 'gmail') throw new Error('Full Slack thread context is not available yet.')
        return readMailThread(draft.thread?.threadId ?? '')
      },
    },
  })
  const interactions = new InteractionBroker({
    request: async (context, requestId, questions) => {
      const recorded = await service.recordUserInputRequest(
        context.chatId,
        context.agentId,
        context.turnId,
        requestId,
        questions,
      )
      // The phone hears about a blocked turn now, not when it ends: it cannot end without them.
      if (recorded) void push.notifyAwaitingInput(context.chatId, context.agentId, questions)
        .catch((error: unknown) => console.warn('[manor] could not push a waiting question', error))
      return recorded
    },
    response: (context, requestId, answers, fromPreference) => service.recordUserInputResponse(
      context.chatId,
      context.agentId,
      context.turnId,
      requestId,
      answers,
      fromPreference,
    ),
    // Clients read Waiting from the directory, and a superseded card emits no event.
    superseded: () => void service.broadcastDirectory().catch(() => undefined),
  }, idleGate)
  const secretRequests = new SecretRequests({
    interactions,
    passwordPage: (context) => secretPasswordPage(browser, browserCapabilities.forTurn(context.turnId)),
  })
  const connectCards = new ConnectCards({
    ...(composio !== undefined ? mockConnectCardPorts(undefined, composio.accountState) : liveConnectCardPorts(() => mcpServers())),
    recordRequest: (context, event) => service.recordConnectRequest(context, event),
    appendStatus: (chatId, event) => service.recordConnectStatus(chatId, event),
    loadEvents: (chatId) => store.loadEvents(chatId),
    hold: (chatId, agentId) => idleGate.hold(chatId, agentId),
    release: (chatId, agentId) => idleGate.release(chatId, agentId),
    // The same refresh Test runs, so a row registered before its login learns its tools.
    afterLogin: (serverId) => service.handle({ type: 'verify_mcp_server', serverId }, () => undefined),
    afterComposioConnect: async () => {
      await composioMarketplace?.settleAccounts()
      // A recovery session exists only until personal Gmail is back; the Test path restores the full one.
      const row = registry.find((server) => server.name === COMPOSIO_MCP_NAME)
      if (row?.description === COMPOSIO_RECOVERY_DESCRIPTION) {
        await service.handle({ type: 'verify_mcp_server', serverId: row.id }, () => undefined)
        // That Test read the accounts before its session probe; a disconnect in between would
        // come back with it, so the marketplace reads once more and lands last.
        await composioMarketplace?.settleAccounts()
      }
    },
  })
  const effectMode = resolveEffectMode(process.env)
  const effects = new EffectBroker(interactions, effectMode === 'auto' && !forceMock
    ? createEffectReviewer({
        // Codex first, as before; Claude when Codex cannot answer. No stand-ins.
        attempts: liveAttempts(
          [
            { driver: createEffectReviewDriver(), ...EFFECT_REVIEW_RUNTIMES.codex },
            { driver: createChatTitleFallbackDriver(agents), ...EFFECT_REVIEW_RUNTIMES.claude },
          ],
          () => providerConnections.usable(),
          () => undefined,
        ),
        loadEvents: (chatId) => store.loadEvents(chatId),
        ensureScratchDir: (chatId) => scratch.ensure(chatId),
      })
    : undefined, effectMode === 'full-access')

  const chatMedia = createChatMedia({
    loadEvents: (chatId) => store.loadEvents(chatId),
    loadDocument: (chatId, documentId) => store.loadDocument(chatId, documentId),
  })
  // The mock driver's spike serves its test pictures from loopback; no real agent runs there.
  const remoteImages = createRemoteImages({ allowPrivateHosts: forceMock })
  const forClient = (message: ServerMessage) => {
    remoteImages.observe(message)
    return chatMedia.forClient(message)
  }
  const directories = createDirectoryChannel()
  // A directory's waits are read as it goes out, not when its rows were loaded: a question
  // opened meanwhile may already be on the socket, and clients take an older list as the
  // question no longer holding its turn.
  const withLiveWaits = (directory: Extract<ServerMessage, { type: 'directory' }>) =>
    ({ ...directory, awaitingInput: interactions.pendingAsks() })
  const send = (message: ServerMessage) => {
    const outgoing = forClient(message)
    if (outgoing.type === 'directory') {
      const live = withLiveWaits(outgoing)
      for (const client of clients) sendSocketPayload(client, directories.payload(client, live))
      return
    }
    const payload = JSON.stringify(outgoing)
    for (const client of clients) {
      sendSocketPayload(client, payload, message.type === 'snapshot' ? 'snapshot' : 'frame')
    }
  }

  await outboundDrafts.reconcileStarted()

  /**
   * Everything the house says, plus one listener.
   *
   * A turn ending is the moment a subscription reading goes stale, and every turn
   * ends by announcing a terminal `turn_state` through here. Watching the outgoing
   * stream catches all three terminal paths by construction, where hooking the
   * orchestrator would mean finding them one at a time and missing the two that
   * are not the happy one.
   */
  const broadcast = (message: ServerMessage) => {
    send(message)
    if (!closeTerminalTurn(message, (turnId) => {
      interactions.closeTurn(turnId)
      secretRequests.closeTurn(turnId)
      userInputCapabilities.closeTurn(turnId)
      service.closeAgentRelayTurn(turnId)
      service.subagents().closeTurn(turnId)
      effects.closeTurn(turnId)
      effectCapabilities.closeTurn(turnId)
      desktopLease.closeTurn(turnId)
      browserCapabilities.closeTurn(turnId)
      artifactCapabilities.closeTurn(turnId)
      routineCapabilities.closeTurn(turnId)
      workCapabilities.closeTurn(turnId)
      mcpHost.closeTurn(turnId)
    })) return
    // A turn that ended into a live session still runs its background work; lists say so.
    if ((drivers.liveSessions.info(message.chatId, message.agentId)?.running.length ?? 0) > 0) {
      void service.broadcastDirectory().catch(() => undefined)
    }
    // The turn says which provider it was actually spent on, because a chat can pin
    // one: reading the roster here would credit a subscription that never ran the
    // turn, and leave the one that did reading stale. No driver means the turn died
    // before it reached a CLI, so no reading went anywhere and there is nothing to
    // refresh — a roster fallback there would be a guess dressed as a measurement.
    const ran = message.driver
    if (ran === 'claude' || ran === 'codex' || ran === 'grok' || ran === 'cursor') usage.noteTurnEnded(ran)
  }

  const drivers = createDrivers({
    agents,
    forceMock,
    idleGate,
    // Assigned below before any turn can start a live session.
    onLiveSession: (event) => service.onLiveSession(event),
    // A Codex turn attached to a live process takes over the capability tokens that
    // process was spawned with; Codex cannot swap a loaded thread's MCP servers.
    rekeyCapability: (from, to) => {
      const result = rekeyAcross([
        userInputCapabilities, browserCapabilities, artifactCapabilities, effectCapabilities,
        routineCapabilities, workCapabilities, skillCapabilities,
      ], from, to)
      // The endpoint follows its capability, so the live process's header reaches this turn.
      if (result === 'rekeyed') mcpHost.rekey(from, to)
      return result
    },
    // The mock raises the real lease card through the production broker and stops at consent.
    ...(forceMock ? {
      mockDesktopCard: (capability: string, connector: string) => {
        const context = userInputCapabilities.take(capability)
        return effects.authorize({
          ...context,
          canApprove: context.canApprove === true,
          connector: { id: `mock_${connector}`, name: connector },
          tool: connector === CODEX_COMPUTER_MCP_NAME ? 'js' : 'click',
          effect: 'confirm_write',
          desktopLease: true,
        })
      },
    } : {}),
  })
  const diagnostics = new RuntimeDiagnostics(forceMock || resolved.config.kind === 'memory' ? undefined : (line) => {
    // Best effort: a full disk or a missing folder must never touch a turn.
    void mkdir(path.dirname(paths.turnStages), { recursive: true })
      .then(() => appendFile(paths.turnStages, `${line}\n`, { mode: 0o600 }))
      .catch(() => undefined)
  })
  const usage = new ProviderUsageService({
    // The mock has no subscription, so the spike gets a made-up reading for the
    // Limits view; diagnostics and updates above still see no provider at all.
    drivers: forceMock
      ? {
          claude: { readProviderUsage: async () => mockProviderUsage('claude', Date.now()) },
          codex: { readProviderUsage: async () => mockProviderUsage('codex', Date.now()) },
        }
      : drivers.byProvider,
    broadcast: send,
    history: new ProviderUsageHistory(store.db),
  })
  const providerUpdates = new ProviderUpdateService({ drivers: drivers.byProvider, broadcast: send })
  const providerConnections = new ProviderConnectionService({ drivers: drivers.byProvider, broadcast: send })
  const artifactMcp = artifactBroker === undefined
    ? undefined
    : (chatId: string, agent: AgentConfig, turnId: string) => serveBuiltIn(artifactMcpAttachment(
        artifactBrokerUrl,
        artifactCapabilities.issue({ chatId, agentId: agent.id, turnId }),
      ), ARTIFACT_BROKER_CAPABILITY_ENV, artifactMcpServer, turnId)

  composioMarketplace = new ComposioMarketplace({
    ports: composioPorts,
    openPage: (link, report) => connectCards.openPage(link, report),
    mcpServers,
    setMcpServers: (next) => {
      registry = [...next]
    },
    broadcast,
  })
  // The spike's key lives in memory beside its mock Composio, so a browser check can
  // remove it and enter another without a file or a real request.
  const mockKeyEnv: NodeJS.ProcessEnv = { [COMPOSIO_API_KEY_ENV]: 'ak_mock_spike_key' }
  const composioKey = new ComposioKey({
    env: composio === undefined ? process.env : mockKeyEnv,
    origin: composio === undefined ? envOrigin : () => undefined,
    ...(composio === undefined ? { file: DATA_ENV_FILE } : {}),
    validate: composio === undefined
      ? (key) => fetchComposioCatalog(key)
      : async (key) => {
          if (key.toLowerCase().includes('invalid')) throw new Error('Composio toolkit listing answered HTTP 401')
          return composio.ports.catalog()
        },
    started: async (apps) => {
      composioMarketplace?.reset(apps)
      if (composio === undefined) await service.reconcileComposio()
      // The reconcile never throws; a row it left unavailable is Composio not starting.
      const row = registry.find((server) => server.name === COMPOSIO_MCP_NAME)
      if (composio === undefined && row?.unavailable !== undefined) throw new Error(row.unavailable)
    },
    stopped: async () => {
      composioMarketplace?.reset()
      if (composio === undefined) await service.reconcileComposio()
    },
    broadcast,
  })
  // Warm, so the first Connectors visit after a restart does not wait on Composio's 1.4s catalogue.
  if (composio !== undefined || composioApiKeyEnv(process.env) !== undefined) {
    void composioMarketplace.catalog().catch((error: unknown) =>
      console.warn(`[manor] could not prefetch the Composio catalogue: ${error instanceof Error ? error.message : 'unknown error'}`))
  }

  service = new ManorService({
    diagnostics,
    store,
    agents,
    setAgents: (next) => {
      roster = [...next]
    },
    mcpServers,
    browserTargetContext: (chatId, agent, freshRequest) => browserTargetContext(browser, chatId, { id: agent.id, name: agent.name }, freshRequest),
    computerTargetReady: (turnId) => { desktopLease.admit(turnId) },
    browserTabsNote: (sessionId, agent) => browserTabsNote(browser, sessionId, { id: agent.id, name: agent.name }),
    providerUsage: () => usage.message().perProvider,
    builtInMcp: (chatId, agent, turnId, canApprove, browserSession, canFillLogin) => serveBuiltIn(browserMcpAttachment(
      browserBrokerUrl,
      browserCapabilities.issue(
        chatId,
        { id: agent.id, name: agent.name },
        undefined,
        { turnId, canApprove, canFillLogin, sessionId: browserSession },
      ),
    ), BROWSER_BROKER_CAPABILITY_ENV, browserMcpServer, turnId),
    // Stdio upstreams keep a proxy process; HTTP upstreams are forwarded from here
    // through the same broker route, with the same capability on the same env key.
    guardMcp: (attached, context) => attached.map((item) => {
      const secrets = proxySecretEnv(item)
      const inProcess = forwardsOverHttp(item) || sharesStdioProcess(item)
      // A capability served here carries no secrets: the CLI holds the token and must not redeem them.
      const proxied = effectProxyAttachment(
        item,
        effectBrokerUrl,
        effectCapabilities.issue(context, item.server, undefined, inProcess ? {} : secrets),
      )
      if (!inProcess) return proxied
      const capabilityEnv = effectCapabilityEnvKey(item.server.id)
      const endpoint = forwardsOverHttp(item)
        ? connectorEndpoint(new HttpConnector(effectProxyUpstream(item), effectBrokerUrl, () => undefined, secrets))
        : stdioConnectorEndpoint(stdioPool.lease(item.server.id, effectProxyUpstream(item), secrets), effectBrokerUrl)
      return mcpHost.serve(proxied, capabilityEnv, endpoint, context.turnId)
    }),
    interactionMcp: (chatId, agent, turnId, allowAsk, permissions) => serveBuiltIn(interactionMcpAttachment(
      userInputBrokerUrl,
      userInputCapabilities.issue({
        chatId,
        agentId: agent.id,
        turnId,
        canApprove: permissions?.canApprove ?? true,
        ...(permissions?.commandCwd === undefined ? {} : { commandCwd: permissions.commandCwd }),
        ...(permissions?.mayForward === true ? { mayForward: true as const } : {}),
        ...(permissions?.mayAnswer === true ? { mayAnswer: true as const } : {}),
        ...(permissions?.allowInstructions === true ? { mayWriteInstructions: true as const } : {}),
        ...(permissions?.allowRelay === true && permissions.relay !== undefined
          ? { relay: permissions.relay }
          : {}),
      }),
      {
        allowAsk,
        allowSecret: permissions?.allowSecret ?? false,
        askMode: askModeFor(permissions?.driver ?? agent.driver),
        allowDraft: permissions?.allowDraft ?? true,
        allowRelay: permissions?.allowRelay ?? false,
        ...(permissions?.allowSubagents === true ? { subagents: service.subagentCatalog(agent.id) } : {}),
        allowDeliver: permissions?.allowDeliver ?? false,
        allowGoal: permissions?.allowGoal ?? false,
        allowReview: permissions?.allowReview ?? false,
        allowProjectFiles: permissions?.allowProjectFiles ?? false,
        allowSessionAnswer: permissions?.allowSessionAnswer ?? false,
        allowSessionForward: permissions?.allowSessionForward ?? false,
        allowProjectReport: permissions?.allowProjectReport ?? false,
        allowSessionStatus: permissions?.allowSessionStatus ?? false,
        allowInstructions: permissions?.allowInstructions ?? false,
        relayMode: permissions?.relay?.depth === 0 ? 'async' : 'sync',
        relayBrokerUrl: agentRelayBrokerUrl,
        subagentBrokerUrl,
      },
    ), USER_INPUT_CAPABILITY_ENV, interactionMcpServer, turnId),
    // A child reaches the user only with a question, which the parent shows and they answer
    // there. Delegating is a separate grant: the subagent tools ride along where allowed.
    subagentMcp: (chatId, agent, turnId, personaId, tools) => serveBuiltIn(interactionMcpAttachment(
      userInputBrokerUrl,
      userInputCapabilities.issue({ chatId, agentId: agent.id, turnId, canApprove: false }),
      {
        allowAsk: tools.ask,
        allowDraft: false,
        ...(tools.delegate ? { subagents: service.subagentCatalog(personaId), subagentBrokerUrl } : {}),
      },
    ), USER_INPUT_CAPABILITY_ENV, interactionMcpServer, turnId),
    routineMcp: (chatId, agent, turnId) => serveBuiltIn(routineMcpAttachment(
      routineBrokerUrl,
      routineCapabilities.issue({ chatId, agentId: agent.id, turnId }),
    ), ROUTINE_BROKER_CAPABILITY_ENV, routineMcpServer, turnId),
    workMcp: (chatId, agent, turnId, mayPropose = true) => serveBuiltIn(workMcpAttachment(
      workBrokerUrl,
      workCapabilities.issue({ chatId, agentId: agent.id, turnId, ...(mayPropose ? {} : { noProposal: true as const }) }),
    ), WORK_BROKER_CAPABILITY_ENV, workMcpServer, turnId),
    generateWorkOutcome,
    ...(writeCommitMessage === undefined ? {} : { writeCommitMessage }),
    relayCap: relayLimits.cap,
    relayDepth: relayLimits.depth,
    ...(artifactMcp === undefined ? {} : { artifactMcp }),
    ...(!mymindConfig.ok ? { mymindProblem: mymindConfig.message } : {}),
    skillMcp: (skillIds, onSkillRead) => {
      const capability = skillCapabilities.issue(skillIds, onSkillRead)
      return {
        attachment: serveBuiltIn(skillMcpAttachment(skillBrokerUrl, capability), SKILL_READER_CAPABILITY_ENV, skillMcpServer),
        revoke: () => {
          skillCapabilities.revoke(capability)
          mcpHost.unmount(capability)
        },
      }
    },
    answerUserInput: (chatId, requestId, answers, fromPreference) => interactions.answer(chatId, requestId, answers, fromPreference),
    answerSecretRequest: (chatId, requestId, value) => secretRequests.answer(chatId, requestId, value),
    openQuestions: interactions,
    outboundDrafts,
    awaitingInput: () => interactions.pendingAsks(),
    setMcpServers: (next) => {
      registry = [...next]
    },
    skills,
    setSkills: (next) => {
      skillRegistry = [...next]
    },
    skillUsage: () => readSkillUsage(skillUsagePath),
    onSkillsUsed: (skillIds, driver) => {
      void recordSkillUsage(skillUsagePath, skillIds, driver)
        .then(async () => broadcast(await service.skillRegistry()))
        .catch(() => undefined)
    },
    discoverSkills: () => discoverSkills(skillRoots),
    workflowSuggestions: () => readWorkflowSuggestions(suggestionsPath),
    skillCacheDir: paths.skills,
    worktreesRoot: paths.worktrees,
    // The probe spawns a process, so the service takes it as an option rather than
    // importing it: a test can register a server without anything running.
    probeMcpServer: (draft) =>
      draft.name === PAPER_MCP_NAME ? probePaperRow(draft) : probeMcpServer(draft),
    resolveDriver: drivers.resolve,
    liveSessions: drivers.liveSessions,
    ensureScratchDir: (chatId) => scratch.ensure(chatId),
    broadcast,
    onChatFinished: (chatId, startedAt, notice) => push.notifyChatFinished(chatId, startedAt, notice),
    generateTitle,
    editNote: createNoteEditor({ resolve: drivers.resolve, ensureScratchDir: (threadId) => scratch.ensure(threadId) }),
    onTitleError: () => console.warn('[manor] could not save a generated chat title'),
    advanceChatSummary,
    generateMemoryTrace,
    ...(writeDailyLog === undefined ? {} : { writeDailyLog }),
    routeGroupTurn,
    ...(rankStructuredMemory === undefined ? {} : { rankStructuredMemory }),
    // The live database only: a memory-store run (the spike, the agent test server) never
    // spends on the Auto classifier. And only with its key: without one there is no Auto
    // on this host, which the clients are told so they draw no switch for it.
    ...(forceMock || resolved.config.kind !== 'sqlite' || !process.env.TYPESAFE_API_KEY?.trim()
      ? {}
      : { selectAutoRuntime: createTypesafeRuntimeSelector(process.env.TYPESAFE_API_KEY, autoRules) }),
    autoRules,
    homeFolders,
    memoryRoots: [
      // The memory system is the memory folder, not only `memory/`: root rules and
      // `private/` are routed knowledge too. `dailyDir` is `<memory dir>/memory/daily`.
      ...[memoryRoot(memoryTarget)].filter((root) => root !== undefined),
      ...(vault === undefined ? [] : [vault.root]),
    ],
    structuredMemoryRoot: path.resolve(memoryTarget.dailyDir, '..', 'structured'),
    delegationCap: delegation.cap,
    wakeCap: wakes.cap,
    memoryTarget,
    mymind,
    onChatsDeleted: (chatIds) => {
      for (const chatId of chatIds) {
        browser.closeChat(chatId)
        interactions.closeChat(chatId)
      }
    },
    ...(externalLinks === undefined
      ? {}
      : { externalBrowser: externalLinks.browser, openExternalUrl: externalLinks.open }),
    ...(vault === undefined ? {} : { vault, vaultTrash: path.join(paths.trash, 'knowledge') }),
    ...(externalFiles === undefined ? {} : { externalFiles }),
    connectCards,
    composioMarketplace,
    composioKey,
    ...(remindersSource === undefined ? {} : { reminders: remindersSource }),
    ...(openLoops === undefined ? {} : { openLoops }),
    systemInfo: createSystemInfo({
      memoryDir: memoryFolder ?? null,
      vaultDir: vaultDir.ok ? vaultDir.dir : null,
      drivers: drivers.byProvider,
      home: homedir(),
      folders: async () => {
        const saved = await store.getHouseSettings()
        const nextMemory = memoryRoot(resolveMemoryTarget(process.env, homedir(), saved.memoryDir)) ?? null
        const nextVault = resolveVaultDir(process.env, homedir(), saved.knowledgeDir)
        const nextVaultDir = nextVault.ok ? nextVault.dir : null
        return {
          memory: { pinned: memoryDirPinned(process.env), pending: nextMemory === (memoryFolder ?? null) ? null : nextMemory },
          knowledge: {
            pinned: vaultDirPinned(process.env),
            pending: nextVaultDir === (vaultDir.ok ? vaultDir.dir : null) ? null : nextVaultDir,
          },
        }
      },
    }),
    usageRates: createRateLoader({ cacheFile: paths.usageRates }),
  })

  // The database is also written by maintenance tools and, deliberately, by an agent's
  // own routine capability. Bring those rows through the same live cells and wire
  // messages as an in-app edit, without asking the process to restart.
  // Serialize invalidations: two writes can emit back-to-back, and an older slow
  // select must never land after a newer fast one and put stale data back in memory.
  await service.reconcileProjectSetup()
    .catch((error: unknown) => console.error('[manor] could not reconcile project setup', error))
  await service.primeHouseholdState()
  // This pass reads Git for every work handoff the house ever recorded, so it grows
  // with history and already costs a restart more than ten seconds. It broadcasts the
  // cards it changes, the way the brief and open-loops recoveries do, so it runs beside
  // the server rather than holding the port shut until it is done.
  void service.recoverWorkCompletions()
    .catch((error: unknown) => console.error('[manor] could not recover work completions', error))
  await service.recoverSubagents()
    .then((count) => { if (count > 0) console.warn(`[manor] ended ${count} subagent${count === 1 ? '' : 's'} left running by a previous run`) })
    .catch((error: unknown) => console.error('[manor] could not recover subagents', error))

  if (openLoops !== undefined) {
    console.log(`[manor] open loops: ${openLoopsLedger} is kept in step with the Reminders list ${OPEN_LOOPS_LIST}`)
    // A tick in Manor syncs at once; the poll catches the phone and Reminders.app.
    void service.syncOpenLoops()
    setInterval(() => void service.syncOpenLoops(), OPEN_LOOPS_POLL_MS).unref()
  }

  // A boot before the network is up leaves Composio off for the whole day. Retry
  // through the Test path (so the registry and every client update the same way),
  // and tell the user on their phone when it still fails.
  const composioRow = () => registry.find((server) => server.name === COMPOSIO_MCP_NAME)
  if (composioApiKeyEnv(process.env) !== undefined && composioRow()?.unavailable !== undefined) {
    retryComposioInBackground({
      isAvailable: () => composioRow()?.unavailable === undefined,
      check: async () => {
        const row = composioRow()
        if (row === undefined) return false
        await service.handle({ type: 'verify_mcp_server', serverId: row.id }, () => undefined)
        return composioRow()?.unavailable === undefined
      },
      onGaveUp: () => push.notifyHost(
        'Composio is offline',
        'Manor could not connect to Composio after 3 attempts. Gmail and the other Composio tools are off until you press Test in Connections.',
      ),
    })
  }

  let householdRefresh = Promise.resolve()
  const stopHouseholdChanges = store.subscribeHouseholdChanges(
    (change) => {
      householdRefresh = householdRefresh
        .then(() => service.refreshHousehold(change))
        .catch((error: unknown) =>
          console.error(`[manor] could not refresh externally changed ${change.resource}`, error),
        )
    },
    (error) => console.error('[manor] workspace change subscription failed', error),
  )

  /**
   * Keeps chat navigation honest: puts down quiet work, expires old archives, then
   * reclaims their scratch files. Broadcast only when the directory actually moved;
   * an unchanged one is a repaint of every sidebar in the house.
   */
  const sweepChatLifecycle = async () => {
    // Read per pass, so a window changed in Settings applies from the next hour.
    const { autoSettleDays, attachmentRetentionDays } = service.currentSettings()
    const deleted = await service.purgeExpiredArchivedChats()
    const settled = autoSettleDays === null ? [] : await sweepIdleChats({ store, idleMs: daysToMs(autoSettleDays) })
    const chats = await store.listChats()
    const swept = await scratch.sweep(() => ({
      liveChatIds: chats.map((chat) => chat.id),
      protectedThreadIds: service.activeScratchThreadIds(),
      retentionMs: attachmentRetentionDays === null ? null : daysToMs(attachmentRetentionDays),
    }))
    const worktrees = await service.sweepChatWorktrees(chats)
    const purged = await purgeEndedRoutines(store)
    if (purged > 0) await service.broadcastRoutines()
    if (worktrees.directoriesRemoved > 0 || worktrees.nodeModulesRemoved > 0 || worktrees.worktreesReleased > 0) {
      console.log(
        `[manor] worktree sweep removed ${worktrees.directoriesRemoved} stale ` +
          `${worktrees.directoriesRemoved === 1 ? 'directory' : 'directories'}, ` +
          `${worktrees.worktreesReleased} merged ${worktrees.worktreesReleased === 1 ? 'worktree' : 'worktrees'} and ` +
          `${worktrees.nodeModulesRemoved} idle node_modules`,
      )
    }
    if (swept.directoriesRemoved > 0 || swept.attachmentsRemoved > 0) {
      console.log(
        `[manor] scratch sweep removed ${swept.directoriesRemoved} stale ` +
          `${swept.directoriesRemoved === 1 ? 'directory' : 'directories'} and ` +
          `${swept.attachmentsRemoved} old ${swept.attachmentsRemoved === 1 ? 'attachment' : 'attachments'}`,
      )
    }
    if (settled.length > 0) {
      console.log(`[manor] settled ${settled.length} idle ${settled.length === 1 ? 'chat' : 'chats'}`)
    }
    if (deleted.length > 0) {
      console.log(
        `[manor] cleaned up ${deleted.length} ${deleted.length === 1 ? 'chat record' : 'chat records'} ` +
          'from expired archives',
      )
    }
    if (settled.length > 0 || deleted.length > 0) {
      await service.broadcastDirectory()
    }
  }

  void sweepChatLifecycle().catch((error: unknown) => console.error('[manor] chat lifecycle sweep failed', error))

  const settling = setInterval(() => {
    void sweepChatLifecycle().catch((error: unknown) => console.error('[manor] chat lifecycle sweep failed', error))
  }, SETTLE_SWEEP_INTERVAL_MS)
  settling.unref?.()

  // verify-manor spikes register under `<data>/spikes`. A spike stops when its Session
  // settles or is archived, or sits idle while no turn runs; never during a turn. Only
  // the server that runs routines sweeps: it alone knows which turns run, so a dev
  // server beside it, or a memory-store server that is itself a spike, leaves this alone.
  if (routines.on && resolved.config.kind !== 'memory') {
    const bootedAt = Date.now()
    const spikes = {
      dir: path.join(path.dirname(paths.scratch), 'spikes'),
      turnRunning: (chatId: string) => service.turnRunning(chatId),
      chatState: async (chatId: string) => {
        const chat = await store.getChat(chatId)
        return chat !== undefined && (chat.settledAt !== null || chat.archivedAt !== null) ? 'closed' as const : 'open' as const
      },
    }
    let sweeping = false
    const sweepVerifySpikes = async () => {
      if (sweeping) return
      sweeping = true
      try {
        const [stopped, leftovers] = await Promise.all([sweepSpikes(spikes), stopUnregisteredSpikes({ startedBefore: bootedAt })])
        for (const spike of stopped) {
          console.log(`[manor] stopped the verify spike on ${spike.port} (${spike.reason === 'idle' ? 'idle' : 'its Session closed'})`)
        }
        if (leftovers > 0) console.log(`[manor] stopped ${leftovers} unregistered verify spike ${leftovers === 1 ? 'group' : 'groups'}`)
      } finally {
        sweeping = false
      }
    }
    const sweep = () => void sweepVerifySpikes().catch((error: unknown) => console.error('[manor] spike sweep failed', error))
    sweep()
    const spiking = setInterval(sweep, SPIKE_SWEEP_INTERVAL_MS)
    spiking.unref?.()
  }

  /**
   * One pass of the routine scheduler, on the server that declared itself the one
   * that runs them. The claim in the database is the other half of that guard: this
   * flag keeps a dev server out, and the claim keeps two eligible servers from both
   * firing the same row. Broadcast only when something moved, since the routine list
   * is household state every open client redraws.
   */
  const runRoutines = async () => {
    if (await recoverFinishedRoutines(store) > 0) await service.broadcastRoutines()
    const tick = await tickRoutines({
      store,
      runTurn: (routine, chatId) => service.runRoutineTurn(routine, chatId),
      // A scheduled turn can run for twenty minutes. The row says it is running from
      // the claim rather than from the finish, so an open Routines view shows the run
      // while it happens instead of after it.
      onClaimed: async () => service.broadcastRoutines(),
      // The run's thread, the moment it exists. Without this the turn streams into a
      // chat no client has a row for, so the work is invisible until something else
      // makes the directory be re-read — which in practice meant the user pressing ⌘R.
      onRunCreated: async () => service.broadcastDirectory(),
      onRunFinished: (run, startedAt, alert) => push.notifyChatFinished(run.id, startedAt, { alert }),
      postNote: (chatId, text) => service.postRoutineNote(chatId, text),
    })
    if (tick.kind === 'idle') return
    if (tick.kind === 'skipped') {
      console.log(`[manor] skipped routine "${tick.routine.name}": too far past ${new Date(tick.dueAt).toISOString()}`)
    } else if (tick.kind === 'expired') {
      console.log(`[manor] expired one-time routine "${tick.routine.name}": due ${new Date(tick.dueAt).toISOString()}`)
    } else if (tick.disabled) {
      console.warn(`[manor] disabled routine "${tick.routine.name}" after three runs with no answer`)
    }
    await service.broadcastRoutines()
  }

  let routineTicking: NodeJS.Timeout | undefined
  if (routines.on) {
    console.log('[manor] this server runs routines (MANOR_ROUTINES=on)')
    routineTicking = setInterval(() => {
      void runRoutines().catch((error: unknown) => console.error('[manor] a routine tick failed', error))
    }, ROUTINE_TICK_INTERVAL_MS)
    routineTicking.unref?.()
  }

  let compressing: NodeJS.Timeout | undefined
  if (compressMemory !== undefined) {
    const compress = () => void compressMemory()
      .then((report) => {
        if (report.archived.length > 0) console.log(`[manor] distilled ${report.archived.length} day(s) of the daily log into long-term memory`)
      })
      .catch((error: unknown) => console.warn('[manor] memory compression failed', error))
    compress()
    compressing = setInterval(compress, MEMORY_COMPRESS_INTERVAL_MS)
    compressing.unref?.()
  }

  const serveStatic = createStaticHandler(process.env.MANOR_WEB_DIST)
  const tokenGate = createGate(auth.config, localAuth === undefined || localAccessToken === undefined
    ? {}
    : { verify: (token) => Promise.resolve(isLocalAccessToken(token, localAccessToken) || localAuth.verify(token)) })
  const http = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/diagnostics') {
      void handleDiagnostics(request, response, tokenGate, () => diagnostics.report(drivers.byProvider, mcpServers(), browser.isReady()))
      return
    }
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, store: resolved.config.kind }))
      return
    }
    if (localAuth !== undefined && request.url?.startsWith('/auth/')) {
      void localAuth.handle(request, response, origins.origins)
      return
    }
    if (mcpHost.handles(request.url)) {
      void mcpHost.handle(request, response)
      return
    }
    if (request.url === '/internal/browser-tool') {
      void handleBrowserToolRequest(request, response, browser, browserCapabilities, effects)
      return
    }
    if (request.url === '/internal/artifact-tool') {
      void handleArtifactToolRequest(request, response, artifactBroker, artifactCapabilities)
      return
    }
    if (request.url === '/internal/user-input') {
      void handleUserInputRequest(request, response, interactions, userInputCapabilities)
      return
    }
    if (request.url === '/internal/secret-request') {
      void handleSecretRequest(request, response, secretRequests, userInputCapabilities)
      return
    }
    if (request.url === '/internal/outbound-draft') {
      void handleOutboundDraftRequest(request, response, outboundDrafts, userInputCapabilities)
      return
    }
    if (request.url === '/internal/agent-relay') {
      void handleAgentRelayRequest(request, response, service, userInputCapabilities, effects, idleGate)
      return
    }
    if (request.url === '/internal/deliver-file') {
      void handleFileDeliveryRequest(request, response, service, userInputCapabilities)
      return
    }
    if (request.url === '/internal/goal-claims') {
      void handleGoalClaimsRequest(request, response, service, userInputCapabilities)
      return
    }
    if (request.url === '/internal/project-thread') {
      void handleProjectThreadRequest(request, response, service, userInputCapabilities)
      return
    }
    if (request.url === '/internal/agent-instructions') {
      void handleInstructionsRequest(request, response, service, userInputCapabilities)
      return
    }
    if (request.url === '/internal/subagent') {
      void handleSubagentRequest(request, response, service, userInputCapabilities)
      return
    }
    if (request.url === '/internal/computer-stop') {
      // Escape and window reloads, posted by the Electron main process itself. The
      // answer comes after the turn was told to stop, so the shell can then let go of Escape.
      void (async () => {
        if (request.method !== 'POST' || !isLoopback(request.socket.remoteAddress)) {
          json(response, 404, { error: 'Not found.' })
          return
        }
        try {
          const body = await readJsonBody(request)
          if (!isRecord(body) || typeof body.token !== 'string') throw new Error('Invalid stop request.')
          const turnId = desktopLease.stopWith(body.token)
          if (turnId !== undefined) await service.handle({ type: 'stop', turnId }, () => undefined)
          json(response, 200, { stopped: turnId !== undefined })
        } catch (error: unknown) {
          json(response, 400, { error: error instanceof Error ? error.message : 'Invalid stop request.' })
        }
      })()
      return
    }
    if (request.url === '/internal/effect-approval') {
      void handleEffectApprovalRequest(request, response, effects, effectCapabilities, connectCards)
      return
    }
    if (forceMock && request.url === '/internal/mock-connect') {
      void handleMockConnectRequest(request, response, connectCards, userInputCapabilities)
      return
    }
    if (request.url === '/internal/routine-tool') {
      void handleRoutineToolRequest(request, response, service, routineCapabilities)
      return
    }
    if (request.url === '/internal/work-tool') {
      void handleWorkToolRequest(request, response, service, workCapabilities)
      return
    }
    if (request.url === '/internal/skill-file') {
      void handleSkillReadRequest(request, response, skillCapabilities)
      return
    }
    if (remoteImages.handle(request, response)) return
    if (chatMedia.handle(request, response)) return
    if (request.url?.startsWith(MYMIND_THUMBNAIL_PREFIX) === true) {
      void handleMyMindThumbnailRequest(request, response, mymind)
      return
    }
    if (serveStatic !== undefined) {
      serveStatic(request, response)
      return
    }
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('manor server\n')
  })

  // The handshake is the only place a caller is checked, so `ws` is not allowed to
  // accept anything on its own: every upgrade passes the guard first, and a refused
  // one is hung up before it becomes a socket.
  const guard = createUpgradeGuard({
    path: WS_PATH,
    gate: tokenGate,
    allowedOrigins: origins.origins,
  })
  const wss = new WebSocketServer({ noServer: true })

  http.on('upgrade', (request, socket, head) => {
    void guard({ url: request.url, headers: { origin: request.headers.origin, host: request.headers.host } })
      .then((verdict) => {
        if (!verdict.ok) {
          rejectUpgrade(socket, verdict.status)
          return
        }
        wss.handleUpgrade(request, socket, head, (client) => wss.emit('connection', client, request))
      })
      .catch((error: unknown) => {
        // Never echo the request target: it carries the token.
        console.error('[manor] could not verify a connection', error)
        rejectUpgrade(socket, 401)
      })
  })

  // A half-open socket stays readyState OPEN forever: it never errors, never closes,
  // and every send into it is swallowed. These two timers are what turn that into an
  // observable state, on the server by hanging up and on the client by going quiet.
  const alive = new WeakSet<WebSocket>()
  const ping = setInterval(() => {
    for (const client of clients) {
      if (!alive.has(client)) {
        client.terminate()
        clients.delete(client)
        continue
      }
      alive.delete(client)
      client.ping()
    }
  }, PING_INTERVAL_MS)
  ping.unref?.()

  let notesTicking = false
  const pulse = setInterval(() => {
    broadcast({ type: 'heartbeat' })
    if (notesTicking) return
    notesTicking = true
    void service.projectThreads.idleTick()
      .catch((error: unknown) => console.warn('[manor] Notes idle tick failed', error))
      .finally(() => { notesTicking = false })
  }, HEARTBEAT_INTERVAL_MS)
  pulse.unref?.()

  usage.start()
  providerUpdates.start()

  wss.on('close', () => {
    clearInterval(ping)
    clearInterval(pulse)
    clearInterval(settling)
    if (routineTicking !== undefined) clearInterval(routineTicking)
    if (compressing !== undefined) clearInterval(compressing)
    usage.stop()
    providerUpdates.stop()
    providerConnections.stop()
    stopHouseholdChanges()
  })

  let markBrowserReady: () => void = () => {}
  const browserReady = new Promise<void>((resolve) => { markBrowserReady = resolve })

  wss.on('connection', (socket, request) => {
    directories.connect(socket, request.url)
    clients.add(socket)
    usage.setClientCount(clients.size)
    providerUpdates.setClientCount(clients.size)
    providerConnections.setClientCount(clients.size)
    alive.add(socket)
    socket.on('pong', () => alive.add(socket))
    const browserHost = { send: (payload: string) => sendSocketPayload(socket, payload) }
    const reply = (message: ServerMessage) => {
      const outgoing = forClient(message)
      const payload = outgoing.type === 'directory' ? directories.payload(socket, withLiveWaits(outgoing)) : JSON.stringify(outgoing)
      sendSocketPayload(socket, payload, message.type === 'snapshot' ? 'snapshot' : 'frame')
    }

    // First, ahead of the directory: what a client draws for a chat depends on it.
    reply(service.hostCapabilities())
    // The client picks a chat from this and asks for its snapshot.
    void service
      .directory()
      .then(reply)
      .catch((error: unknown) => console.error('[manor] could not send the directory', error))

    // The household goes out beside it, not inside the snapshot: one roster is shared
    // by every chat, and every later change arrives as another one of these.
    reply(service.roster())
    // The rail's face of the user; household state like the roster, changed only by a save.
    reply(service.profile())
    // Household settings, sent and changed the same way as the profile.
    reply(service.houseSettings())
    // Beside the roster and for the same reason: routines are household state, and a
    // routine outlives whichever chat happens to be open.
    void service
      .routines()
      .then(reply)
      .catch((error: unknown) => console.error('[manor] could not send the routines', error))
    reply(service.registry())
    reply(service.mcpHostStatuses())
    void service
      .skillRegistry()
      .then(reply)
      .catch((error: unknown) => console.error('[manor] could not send the skill registry', error))
    // Last known, possibly stale and stamped as such. The zero-to-one client edge
    // has already asked for a fresh one; this is what fills the panel meanwhile.
    reply(usage.message())
    reply(providerUpdates.message())
    reply(providerConnections.message())
    // A capability, not content: the client needs it to decide whether the Knowledge
    // tab exists at all, and asks for the note list only once that tab is opened.
    reply(service.vaultStatus())
    reply(service.mymindStatus())
    // Where the Composio key comes from, never the key: the Connectors page offers the form on none.
    reply(composioKey.status())
    reply(service.sessionCommits())

    socket.on('message', (raw) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(raw.toString())
      } catch {
        return
      }
      // Guarded like the JSON.parse above it, and for the same reason: a schema is
      // not allowed to be the thing that kills the server. A refinement that throws
      // escapes `safeParse`, and an always-on VPS loses every in-flight turn to one
      // bad frame.
      let message
      try {
        message = ClientMessageSchema.safeParse(parsed)
      } catch (error: unknown) {
        console.error('[manor] a client frame could not be validated', error)
        return
      }
      if (!message.success) return
      if (message.data.type === 'browser_host_ready') {
        browser.register(browserHost)
        markBrowserReady()
        void service.browserSessionTurns().then(reply)
          .catch((error: unknown) => console.error('[manor] could not send the running browser turns', error))
        if (message.data.computerStop === true) {
          const orphaned = desktopLease.attachHost(browserHost)
          if (orphaned !== undefined) void service.handle({ type: 'stop', turnId: orphaned }, () => undefined)
        }
        return
      }
      if (message.data.type === 'desktop_presence') {
        presence.report(socket, message.data.active)
        return
      }
      if (message.data.type === 'update_providers') {
        void providerUpdates.install(message.data.provider)
        return
      }
      if (message.data.type === 'check_providers') {
        void providerConnections.check()
        return
      }
      if (message.data.type === 'sign_in_provider') {
        void providerConnections.signIn(message.data.provider)
        return
      }
      if (message.data.type === 'install_provider') {
        void providerConnections.install(message.data.provider)
        return
      }
      if (message.data.type === 'cancel_provider_sign_in') {
        providerConnections.cancel(message.data.provider)
        return
      }
      if (message.data.type === 'refresh_provider_usage') {
        usage.refreshNow()
        return
      }
      if (message.data.type === 'computer_stop_ack') {
        if (desktopLease.isHost(browserHost)) desktopLease.confirmArmed(message.data.armId, message.data.ok)
        return
      }
      if (message.data.type === 'browser_tool_result') {
        browser.settle(browserHost, message.data)
        return
      }
      void service.handle(message.data, reply).catch((error: unknown) => {
        console.error(`[manor] ${message.data.type} failed`, error)
        // A request can never end in silence, the same rule turns already live under.
        // Every dialog in the app waits for the change it asked for to come back, so a
        // handler that throws and only logs leaves a button reading "Saving…" forever,
        // with the reason visible to nobody but whoever thinks to open a log file. The
        // notice both frees the dialog and says what went wrong.
        reply({
          type: 'notice',
          kind: 'error',
          text: `That request (${message.data.type}) failed: ${
            error instanceof Error ? error.message : 'the server gave no reason'
          }`,
          ...('requestId' in message.data && message.data.requestId !== undefined
            ? { requestId: message.data.requestId }
            : {}),
        })
      })
    })

    const drop = () => {
      clients.delete(socket)
      presence.drop(socket)
      browser.unregister(browserHost)
      const orphaned = desktopLease.detachHost(browserHost)
      if (orphaned !== undefined) void service.handle({ type: 'stop', turnId: orphaned }, () => undefined)
      usage.setClientCount(clients.size)
      providerUpdates.setClientCount(clients.size)
      providerConnections.setClientCount(clients.size)
    }
    socket.on('close', drop)
    socket.on('error', drop)
  })

  shutdown = async (signal) => {
    http.close()
    stdioPool.close()
    for (const client of clients) client.terminate()
    const stopped = service.stopActiveTurns()
    const children = await stopAllCliChildren()
    // Every CLI gets TERM now, including Codex and invisible infrastructure turns.
    if (stopped + children > 0) await new Promise((resolve) => setTimeout(resolve, 1_600))
    wss.close()
    // Leave rather than wait for the event loop to drain. Everything this process owns
    // has been closed or given its grace period by now, but an MCP child and the odd
    // socket keep it alive for half a minute more, and a restart is offline for every
    // second of that. The same immediate exit the pre-startup path already takes.
    process.exit(signal === 'SIGINT' ? 130 : 143)
  }
  http.listen(PORT, host, () => {
    void service.recoverWaitingMessages(browserReady, bootInputs).catch((error: unknown) => console.error('[manor] waiting-input recovery failed', error))
    const storeNote = resolved.config.kind === 'memory' ? 'in-memory store' : `${resolved.config.kind} store`
    const driverNote = forceMock ? 'mock driver (MANOR_DRIVER=mock)' : 'configured drivers'
    const webNote = serveStatic === undefined ? '' : ', serving the web build'
    console.log(`[manor] listening on ws://${host}:${PORT}${WS_PATH} using ${storeNote} and ${driverNote}${webNote}`)
    // Said plainly, every start: an unguarded port is a thing to know about, not
    // something to discover by finding someone else's chats.
    console.log(
      auth.config.mode === 'on'
        ? '[manor] auth is ON: every connection must carry a token for the Manor owner'
        : '[manor] auth is OFF: anything that can reach this port can use it',
    )
  })
}

async function handleMyMindThumbnailRequest(
  request: IncomingMessage,
  response: ServerResponse,
  mymind: MyMindClient | undefined,
): Promise<void> {
  if (request.method !== 'GET' || mymind === undefined || request.url === undefined) {
    response.writeHead(404, { 'cache-control': 'no-store' })
    response.end()
    return
  }
  try {
    const thumbnail = await mymind.fetchThumbnail(request.url)
    if (thumbnail === undefined) {
      response.writeHead(404, { 'cache-control': 'no-store' })
      response.end()
      return
    }
    response.writeHead(200, {
      'content-type': thumbnail.contentType,
      'content-length': String(thumbnail.bytes.byteLength),
      'cache-control': 'private, max-age=300',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    })
    response.end(thumbnail.bytes)
  } catch {
    response.writeHead(502, { 'cache-control': 'no-store' })
    response.end()
  }
}

const isLoopback = (address: string | undefined): boolean =>
  address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const raw of request) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
    size += chunk.length
    if (size > 64 * 1024) throw new Error('Broker request is too large.')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function json(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(payload))
}

async function handleBrowserToolRequest(
  request: IncomingMessage,
  response: ServerResponse,
  broker: BrowserBroker,
  capabilities: BrowserCapabilities,
  effects: EffectBroker,
): Promise<void> {
  if (request.method !== 'POST' || !isLoopback(request.socket.remoteAddress)) {
    json(response, 404, { error: 'Not found.' })
    return
  }

  try {
    const body = await readJsonBody(request)
    if (typeof body !== 'object' || body === null) throw new Error('Invalid browser broker request.')
    const input = body as Record<string, unknown>
    const parsedTool = BrowserToolNameSchema.safeParse(input.tool)
    const arguments_ = input.arguments
    if (
      !parsedTool.success ||
      typeof arguments_ !== 'object' ||
      arguments_ === null ||
      Array.isArray(arguments_)
    ) throw new Error('Invalid browser broker request.')
    const provided = Array.isArray(request.headers['x-manor-browser-capability'])
      ? request.headers['x-manor-browser-capability'][0]
      : request.headers['x-manor-browser-capability']
    const { chatId, sessionId, actor, turnId, canApprove, canFillLogin } = capabilities.take(provided)
    const tool = parsedTool.data
    const action = arguments_ as Record<string, unknown>
    if (tool === BROWSER_FILL_LOGIN_TOOL) {
      // Only the username is the agent's to choose; the server builds every host call.
      const username = typeof action.username === 'string' && action.username !== '' ? action.username : undefined
      const result = await fillSavedLogin(
        { broker, effects }, { chatId, sessionId, actor, turnId, canApprove: canApprove && canFillLogin }, username,
      )
      json(response, 200, { result })
      return
    }
    const result = await broker.request(sessionId, tool, action, { ...actor, turnId }, async (snapshot, waitForHuman) => {
      capabilities.assertActive(provided)
      await effects.authorize({
        chatId,
        agentId: actor.id,
        turnId,
        canApprove,
        connector: { id: 'builtin_browser', name: 'browser' },
        tool,
        effect: browserEffect(tool),
        loadReviewArguments: async () => browserReviewArguments(tool, action, await snapshot()),
      }, { waitForHuman })
      capabilities.assertActive(provided)
    })
    json(response, 200, { result })
  } catch (error: unknown) {
    if (error instanceof InvalidBrowserCapabilityError) {
      json(response, 404, { error: 'Not found.' })
      return
    }
    json(response, 503, { error: error instanceof Error ? error.message : 'The browser action failed.' })
  }
}

async function handleEffectApprovalRequest(
  request: IncomingMessage,
  response: ServerResponse,
  broker: EffectBroker,
  capabilities: EffectCapabilities,
  connectCards: ConnectCards,
): Promise<void> {
  if (request.method !== 'POST' || !isLoopback(request.socket.remoteAddress)) {
    json(response, 404, { error: 'Not found.' })
    return
  }

  try {
    const body = await readJsonBody(request)
    const provided = Array.isArray(request.headers['x-manor-effect-capability'])
      ? request.headers['x-manor-effect-capability'][0]
      : request.headers['x-manor-effect-capability']
    if (isRecord(body) && body.env === true) {
      json(response, 200, { env: capabilities.takeEnv(provided) })
      return
    }
    if (isRecord(body) && isRecord(body.connect)) {
      // The row and turn come from the capability; the proxy only supplies the link.
      const { context, server } = capabilities.holder(provided)
      const connect = connectRequestOf(body.connect, server)
      if (connect === undefined) throw new Error('Invalid connect request.')
      json(response, 200, { outcome: await connectCards.request(context, connect) })
      return
    }
    if (!isRecord(body) || typeof body.tool !== 'string') throw new Error('Invalid effect request.')
    const continuation = await capabilities.authorize(provided, {
      tool: body.tool, arguments: body.arguments, reviewArguments: body.reviewArguments,
      continuation: body.continuation,
    }, broker)
    json(response, 200, { approved: true, ...(continuation === undefined ? {} : { continuation }) })
  } catch (error: unknown) {
    if (error instanceof InvalidEffectCapabilityError) {
      json(response, 404, { error: 'Not found.' })
      return
    }
    json(response, 403, { error: error instanceof Error ? error.message : 'Connector call denied.' })
  }
}

function connectRequestOf(value: Record<string, unknown>, server: McpServerConfig): ConnectRequest | undefined {
  if (value.kind === 'mcp_oauth') return { kind: 'mcp_oauth', serverId: server.id, app: server.name }
  if (value.kind !== 'composio' || server.name !== COMPOSIO_MCP_NAME) return undefined
  const text = (key: string, max: number) => {
    const field = value[key]
    return typeof field === 'string' && field.length > 0 && field.length <= max ? field : undefined
  }
  const toolkit = text('toolkit', 80)
  const url = text('url', 2_000)
  if (toolkit === undefined || url === undefined || !isComposioConnectUrl(url)) return undefined
  const alias = text('alias', 40)
  const accountId = text('accountId', 120)
  return {
    kind: 'composio', toolkit, url,
    ...(alias === undefined ? {} : { alias }),
    ...(accountId === undefined ? {} : { accountId }),
  }
}

/** Spike only: the mock driver's "mock connect" and "mock login" reach the real card here. */
async function handleMockConnectRequest(
  request: IncomingMessage,
  response: ServerResponse,
  connectCards: ConnectCards,
  capabilities: UserInputCapabilities,
): Promise<void> {
  try {
    const body = await readJsonBody(request)
    const provided = request.headers['x-manor-user-input-capability']
    const context = capabilities.take(Array.isArray(provided) ? provided[0] : provided)
    if (!isRecord(body) || typeof body.app !== 'string') throw new Error('Invalid mock connect request.')
    const alias = typeof body.alias === 'string' ? body.alias : undefined
    const connect: ConnectRequest = body.kind === 'mcp_oauth'
      ? { kind: 'mcp_oauth', serverId: body.app, app: body.app }
      : { kind: 'composio', toolkit: body.app, url: `https://connect.composio.dev/link/lk_mock_${body.app}`, ...(alias === undefined ? {} : { alias }) }
    json(response, 200, { outcome: await connectCards.request(context, connect) })
  } catch (error: unknown) {
    json(response, 503, { error: error instanceof Error ? error.message : 'Mock connect failed.' })
  }
}

const artifactToolNames = new Set<string>(ARTIFACT_TOOL_NAMES)

async function handleArtifactToolRequest(
  request: IncomingMessage,
  response: ServerResponse,
  broker: ArtifactBroker | undefined,
  capabilities: ArtifactCapabilities,
): Promise<void> {
  if (request.method !== 'POST' || !isLoopback(request.socket.remoteAddress) || broker === undefined) {
    json(response, 404, { error: 'Not found.' })
    return
  }

  try {
    const body = await readJsonBody(request)
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new Error('Invalid artifact broker request.')
    }
    const input = body as Record<string, unknown>
    const tool = input.tool
    const arguments_ = input.arguments
    if (
      typeof tool !== 'string' ||
      !artifactToolNames.has(tool) ||
      typeof arguments_ !== 'object' ||
      arguments_ === null ||
      Array.isArray(arguments_)
    ) throw new Error('Invalid artifact broker request.')
    const provided = Array.isArray(request.headers['x-manor-artifact-capability'])
      ? request.headers['x-manor-artifact-capability'][0]
      : request.headers['x-manor-artifact-capability']
    capabilities.take(provided, tool as ArtifactToolName)
    const result = await broker.request(tool as ArtifactToolName, arguments_)
    json(response, 200, { result })
  } catch (error: unknown) {
    if (error instanceof InvalidArtifactCapabilityError) {
      json(response, 404, { error: 'Not found.' })
      return
    }
    json(response, 503, { error: error instanceof Error ? error.message : 'The artifact action failed.' })
  }
}

async function handleUserInputRequest(
  request: IncomingMessage,
  response: ServerResponse,
  broker: InteractionBroker,
  capabilities: UserInputCapabilities,
): Promise<void> {
  if (request.method !== 'POST' || !isLoopback(request.socket.remoteAddress)) {
    json(response, 404, { error: 'Not found.' })
    return
  }

  try {
    const body = await readJsonBody(request)
    if (typeof body !== 'object' || body === null) throw new Error('Invalid ask-user request.')
    const input = body as Record<string, unknown>
    const questions = UserInputQuestionsSchema.safeParse(input.questions)
    if (!questions.success) throw new Error('Invalid ask-user request.')
    const provided = Array.isArray(request.headers['x-manor-user-input-capability'])
      ? request.headers['x-manor-user-input-capability'][0]
      : request.headers['x-manor-user-input-capability']
    const context = capabilities.take(provided)
    if (input.deferred === true) {
      await broker.post(context, askedByModel(questions.data))
      json(response, 200, { posted: true })
      return
    }
    const asked = askedByModel(questions.data)
    const { answers, fromPreference } = await broker.ask(context, asked)
    json(response, 200, { answers, ...(fromPreference === undefined ? {} : { note: preferenceAnswerText(asked, answers, fromPreference) }) })
  } catch (error: unknown) {
    if (error instanceof InvalidUserInputCapabilityError) {
      json(response, 404, { error: 'Not found.' })
      return
    }
    json(response, 503, { error: error instanceof Error ? error.message : 'The question failed.' })
  }
}

async function handleSecretRequest(
  request: IncomingMessage,
  response: ServerResponse,
  secrets: SecretRequests,
  capabilities: UserInputCapabilities,
): Promise<void> {
  if (request.method !== 'POST' || !isLoopback(request.socket.remoteAddress)) {
    json(response, 404, { error: 'Not found.' })
    return
  }

  try {
    const body = await readJsonBody(request)
    const input = SecretRequestInputSchema.safeParse(body)
    if (!input.success) throw new Error('request_secret needs a label, a reason and a target.')
    const provided = Array.isArray(request.headers['x-manor-user-input-capability'])
      ? request.headers['x-manor-user-input-capability'][0]
      : request.headers['x-manor-user-input-capability']
    const context = capabilities.take(provided)
    const deferred = (body as { deferred?: unknown }).deferred === true
    json(response, 200, { result: await secrets.request(context, input.data, deferred) })
  } catch (error: unknown) {
    if (error instanceof InvalidUserInputCapabilityError) {
      json(response, 404, { error: 'Not found.' })
      return
    }
    json(response, 503, { error: error instanceof Error ? error.message : 'The secret request failed.' })
  }
}

/** What the agent hears when a draft could not land because nothing can send it yet. */
function notConnectedNote(channel: OutboundChannel, result: { notConnected: 'unavailable' | 'pending' | 'failed'; reason?: string }): string {
  const app = channel === 'gmail' ? 'Gmail' : 'Slack'
  switch (result.notConnected) {
    case 'pending':
      return `No draft was added: ${app} is not connected. A connect card for ${app} is in the chat. Tell the user to connect it there, then prepare the draft again.`
    case 'failed':
      return `No draft was added: the ${app} sign-in failed${result.reason === undefined ? '' : ` (${result.reason})`}. Tell the user, and prepare the draft again after they connect ${app}.`
    case 'unavailable':
      return `No draft was added: ${app} is not connected on this Manor, and no connect card can be offered here. Tell the user to connect ${app} in Settings first.`
  }
}

async function handleOutboundDraftRequest(
  request: IncomingMessage,
  response: ServerResponse,
  drafts: OutboundDrafts,
  capabilities: UserInputCapabilities,
): Promise<void> {
  if (request.method !== 'POST' || !isLoopback(request.socket.remoteAddress)) {
    json(response, 404, { error: 'Not found.' })
    return
  }

  try {
    const body = await readJsonBody(request)
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new Error('Invalid outbound draft.')
    }
    const parsed = OutboundDraftContentSchema.safeParse(body)
    if (!parsed.success) {
      throw new Error('Invalid outbound draft.')
    }
    const provided = Array.isArray(request.headers['x-manor-user-input-capability'])
      ? request.headers['x-manor-user-input-capability'][0]
      : request.headers['x-manor-user-input-capability']
    const context = capabilities.take(provided, 'draft')
    const recorded = await drafts.prepare(context, parsed.data)
    json(response, 200, 'draftId' in recorded
      ? { draftId: recorded.draftId, note: 'Draft added to the chat. Nothing has been sent.' }
      : 'suppressed' in recorded
        ? {
            suppressed: recorded.suppressed,
            until: recorded.until,
            note: 'This thread is postponed, so no draft was added yet.',
          }
        : { notConnected: recorded.notConnected, note: notConnectedNote(parsed.data.channel, recorded) })
  } catch (error: unknown) {
    if (error instanceof InvalidUserInputCapabilityError) {
      json(response, 404, { error: 'Not found.' })
      return
    }
    json(response, 503, { error: error instanceof Error ? error.message : 'The draft could not be prepared.' })
  }
}

async function handleAgentRelayRequest(
  request: IncomingMessage,
  response: ServerResponse,
  service: ManorService,
  capabilities: UserInputCapabilities,
  effects: EffectBroker,
  idleGate: Pick<TurnIdleGate, 'hold' | 'release'>,
): Promise<void> {
  if (request.method !== 'POST' || !isLoopback(request.socket.remoteAddress)) {
    json(response, 404, { error: 'Not found.' })
    return
  }

  try {
    const body = await readJsonBody(request)
    if (!isRecord(body) || typeof body.to !== 'string' || typeof body.text !== 'string') {
      throw new Error('Invalid agent message.')
    }
    const provided = Array.isArray(request.headers['x-manor-user-input-capability'])
      ? request.headers['x-manor-user-input-capability'][0]
      : request.headers['x-manor-user-input-capability']
    const context = capabilities.take(provided, 'relay')
    await effects.authorize({
      chatId: context.chatId,
      agentId: context.agentId,
      turnId: context.turnId,
      canApprove: context.canApprove === true,
      connector: { id: 'builtin_agent_relay', name: 'manor' },
      tool: 'message_agent',
      effect: 'agent_message',
    })
    const reply = await service.messageAgent(context, body.to, body.text)
    if (!response.destroyed) json(response, 200, { reply })
  } catch (error: unknown) {
    if (response.destroyed) return
    if (error instanceof InvalidUserInputCapabilityError) {
      json(response, 404, { error: 'Not found.' })
      return
    }
    json(response, 503, { error: error instanceof Error ? error.message : 'The agent message failed.' })
  }
}

async function handleSubagentRequest(
  request: IncomingMessage,
  response: ServerResponse,
  service: ManorService,
  capabilities: UserInputCapabilities,
): Promise<void> {
  if (request.method !== 'POST' || !isLoopback(request.socket.remoteAddress)) {
    json(response, 404, { error: 'Not found.' })
    return
  }
  try {
    const body = await readJsonBody(request)
    if (!isRecord(body) || typeof body.action !== 'string') throw new SubagentRefusal('Invalid subagent request.')
    const provided = Array.isArray(request.headers['x-manor-user-input-capability'])
      ? request.headers['x-manor-user-input-capability'][0]
      : request.headers['x-manor-user-input-capability']
    const context = capabilities.take(provided, 'subagent')
    const subagents = service.subagents()
    const text = (key: string) => typeof body[key] === 'string' ? body[key] : undefined
    const flag = (key: string) => typeof body[key] === 'boolean' ? body[key] : undefined
    const taskId = text('taskId')
    const report = await (async () => {
      switch (body.action) {
        case 'delegate_task': {
          const [task, model, effort, role, title, wait] = [text('task'), text('model'), text('effort'), text('role'), text('title'), flag('wait')]
          if (task === undefined || model === undefined || effort === undefined) throw new SubagentRefusal('delegate_task needs a task, a model and an effort.')
          return subagents.delegate(context, {
            task, model, effort,
            ...(role === undefined ? {} : { role }),
            ...(title === undefined ? {} : { title }),
            ...(wait === undefined ? {} : { wait }),
            ...(flag('review') === true ? { review: true } : {}),
          })
        }
        case 'task_result':
          if (taskId === undefined) throw new SubagentRefusal('task_result needs a taskId.')
          return subagents.result(context, taskId, flag('wait') ?? true)
        case 'task_cancel':
          if (taskId === undefined) throw new SubagentRefusal('task_cancel needs a taskId.')
          return subagents.cancel(context, taskId)
        case 'subagent_capabilities':
          return subagents.capabilities(context)
        default:
          throw new SubagentRefusal(`Unknown subagent action ${String(body.action)}.`)
      }
    })()
    if (!response.destroyed) json(response, 200, { report })
  } catch (error: unknown) {
    if (response.destroyed) return
    if (error instanceof InvalidUserInputCapabilityError) {
      json(response, 404, { error: 'Not found.' })
      return
    }
    // A refusal is an answer the calling model acts on, not a broker failure.
    json(response, error instanceof SubagentRefusal ? 400 : 503, { error: error instanceof Error ? error.message : 'The subagent failed.' })
  }
}

async function handleFileDeliveryRequest(
  request: IncomingMessage,
  response: ServerResponse,
  service: ManorService,
  capabilities: UserInputCapabilities,
): Promise<void> {
  if (request.method !== 'POST' || !isLoopback(request.socket.remoteAddress)) {
    json(response, 404, { error: 'Not found.' })
    return
  }
  try {
    const body = await readJsonBody(request)
    if (!isRecord(body) || typeof body.path !== 'string' || (body.name !== undefined && typeof body.name !== 'string')) {
      throw new FileDeliveryError('deliver_file needs the absolute path to a file.')
    }
    const viewport = body.viewport === undefined ? undefined : DELIVERED_VIEWPORTS.find((candidate) => candidate === body.viewport)
    if (body.viewport !== undefined && viewport === undefined) throw new FileDeliveryError('viewport is either "desktop" or "phone".')
    const provided = Array.isArray(request.headers['x-manor-user-input-capability'])
      ? request.headers['x-manor-user-input-capability'][0]
      : request.headers['x-manor-user-input-capability']
    const context = capabilities.take(provided, 'deliver')
    const note = await service.deliverFile(context, body.path, typeof body.name === 'string' ? body.name : undefined, viewport)
    json(response, 200, { note })
  } catch (error: unknown) {
    if (error instanceof InvalidUserInputCapabilityError) {
      json(response, 404, { error: 'Not found.' })
      return
    }
    if (error instanceof FileDeliveryError) {
      json(response, 422, { error: error.message })
      return
    }
    json(response, 503, { error: `Manor could not store the file: ${error instanceof Error ? error.message : 'unknown error'}` })
  }
}

/** `goal_reached` posts its claims here before it answers; a refusal fails that call. */
async function handleGoalClaimsRequest(
  request: IncomingMessage,
  response: ServerResponse,
  service: ManorService,
  capabilities: UserInputCapabilities,
): Promise<void> {
  if (request.method !== 'POST' || !isLoopback(request.socket.remoteAddress)) {
    json(response, 404, { error: 'Not found.' })
    return
  }
  try {
    const body = await readJsonBody(request)
    const provided = Array.isArray(request.headers['x-manor-user-input-capability'])
      ? request.headers['x-manor-user-input-capability'][0]
      : request.headers['x-manor-user-input-capability']
    const context = capabilities.take(provided, 'goal')
    const claims = GoalClaimsSchema.safeParse(isRecord(body) ? body.claims : undefined)
    if (!claims.success) {
      json(response, 422, { error: `goal_reached needs claims: one to twenty of { claim, level, ref }, with a ref on every level above stated. ${claims.error.issues[0]?.message ?? ''}`.trim() })
      return
    }
    const report = GoalReportInputSchema.optional().safeParse(isRecord(body) ? body.report : undefined)
    if (!report.success) {
      const choices = report.error.issues.some((issue) => issue.path[0] === 'choices')
      const commit = report.error.issues.some((issue) => issue.path[0] === 'commit')
      const points = report.error.issues.some((issue) => issue.path[0] === 'points')
      json(response, 422, { error: choices
        ? `choices takes at most ${MAX_GOAL_CHOICES} of { title, options, recommended }: a short title, two to four short options and an optional recommendation.`
        : points
          ? `points takes one to ${MAX_GOAL_POINTS} short lines of at most ${GOAL_POINT_MAX} characters each.`
          : commit
            ? `commit takes { subject, body }: a one-line subject of at most ${GOAL_COMMIT_SUBJECT_MAX} characters and an optional body of at most ${GOAL_COMMIT_BODY_MAX}.`
            : `Keep the result to one or two short sentences (at most ${GOAL_RESULT_MAX} characters) and a limitation, only when one matters, to one line (at most ${GOAL_LIMITATIONS_MAX}).` })
      return
    }
    const paths = z.array(z.string().min(1).max(4_096)).max(MAX_GOAL_EVIDENCE).optional()
      .safeParse(isRecord(body) ? body.screenshots : undefined)
    if (!paths.success) {
      json(response, 422, { error: `screenshots takes at most ${MAX_GOAL_EVIDENCE} absolute paths.` })
      return
    }
    const recorded = await service.recordGoalClaims(context, claims.data, report.data, paths.data)
    if ('error' in recorded) {
      json(response, 422, { error: recorded.error })
      return
    }
    json(response, 200, { ok: true, note: recorded.note })
  } catch (error: unknown) {
    if (error instanceof InvalidUserInputCapabilityError) {
      json(response, 404, { error: 'Not found.' })
      return
    }
    if (error instanceof FileDeliveryError) {
      json(response, 422, { error: error.message })
      return
    }
    json(response, 400, { error: 'Invalid goal claims request.' })
  }
}

/** A new report is short; the lead never sets its evidence, which Manor fills from screenshots. */
const GoalReportInputSchema = GoalReportSchema.omit({ evidence: true }).extend({
  result: z.string().trim().min(1).max(GOAL_RESULT_MAX),
  limitations: z.string().trim().min(1).max(GOAL_LIMITATIONS_MAX).optional(),
})

/** The project thread's tools and the report tool, one endpoint keyed by `action` (2026-10-10). */
const ProjectThreadRequestSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('write'),
    file: z.union([ProjectThreadFileSchema, z.string().max(200).regex(PROJECT_CARD_FILE)]),
    lineAction: z.enum(['add', 'replace', 'remove', 'create']),
    line: z.string().trim().min(1).max(500).optional(),
    old: z.string().trim().min(1).max(500).optional(),
    title: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().min(1).max(300).optional(),
    when: z.string().trim().min(1).max(500).optional(),
  }),
  z.object({
    action: z.literal('answer'),
    requestId: z.string().min(1),
    answers: UserInputAnswersSchema,
    preference: z.string().trim().min(8).max(500),
  }),
  z.object({
    action: z.literal('report'),
    project: z.string().trim().min(1).max(200),
    kind: z.enum(['preference', 'note']),
    text: z.string().trim().min(1).max(500),
    quote: z.string().trim().min(1).max(500).optional(),
  }),
  z.object({
    action: z.literal('forward'),
    session: z.string().trim().min(1).max(200),
    message: z.string().trim().min(1).max(40_000),
  }),
  z.object({
    action: z.literal('status'),
    status: z.string().trim().min(1).max(300),
  }),
])

/** A new agent's `write_instructions`, the interview's one write. */
async function handleInstructionsRequest(
  request: IncomingMessage,
  response: ServerResponse,
  service: ManorService,
  capabilities: UserInputCapabilities,
): Promise<void> {
  if (request.method !== 'POST' || !isLoopback(request.socket.remoteAddress)) {
    json(response, 404, { error: 'Not found.' })
    return
  }
  try {
    const body = await readJsonBody(request)
    const header = request.headers['x-manor-user-input-capability']
    const answer = await answerInstructionsCall(capabilities, (context, instructions) => service.writeInstructions(context, instructions),
      Array.isArray(header) ? header[0] : header, body)
    json(response, answer.status, answer.payload)
  } catch {
    json(response, 400, { error: 'Invalid instructions call.' })
  }
}

async function handleProjectThreadRequest(
  request: IncomingMessage,
  response: ServerResponse,
  service: ManorService,
  capabilities: UserInputCapabilities,
): Promise<void> {
  if (request.method !== 'POST' || !isLoopback(request.socket.remoteAddress)) {
    json(response, 404, { error: 'Not found.' })
    return
  }
  try {
    const body = await readJsonBody(request)
    const provided = Array.isArray(request.headers['x-manor-user-input-capability'])
      ? request.headers['x-manor-user-input-capability'][0]
      : request.headers['x-manor-user-input-capability']
    const context = capabilities.take(provided, 'project')
    const parsed = ProjectThreadRequestSchema.safeParse(body)
    if (!parsed.success) {
      json(response, 422, { error: `Invalid project thread call: ${parsed.error.issues[0]?.message ?? 'check the arguments'}.` })
      return
    }
    const input = parsed.data
    const note = input.action === 'write'
      ? await service.projectThreads.writeFile(context, {
        file: input.file, action: input.lineAction,
        ...(input.line === undefined ? {} : { line: input.line }),
        ...(input.old === undefined ? {} : { old: input.old }),
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.when === undefined ? {} : { when: input.when }),
      })
      : input.action === 'answer'
        ? await service.projectThreads.answerFromThread(context, { requestId: input.requestId, answers: input.answers, preference: input.preference })
        : input.action === 'forward'
          ? await service.projectThreads.forwardToSession(context, { session: input.session, message: input.message })
          : input.action === 'status'
            ? await service.projectThreads.writeSessionStatus(context, input.status)
            : await service.projectThreads.report(context, {
              project: input.project, kind: input.kind, text: input.text,
              ...(input.quote === undefined ? {} : { quote: input.quote }),
            })
    json(response, 200, { note })
  } catch (error: unknown) {
    if (error instanceof InvalidUserInputCapabilityError) {
      json(response, 404, { error: 'Not found.' })
      return
    }
    json(response, 422, { error: error instanceof Error ? error.message : 'The project thread call failed.' })
  }
}

const routineToolNames = new Set<string>(ROUTINE_TOOL_NAMES)

async function handleRoutineToolRequest(
  request: IncomingMessage,
  response: ServerResponse,
  service: ManorService,
  capabilities: RoutineCapabilities,
): Promise<void> {
  if (request.method !== 'POST' || !isLoopback(request.socket.remoteAddress)) {
    json(response, 404, { error: 'Not found.' })
    return
  }

  try {
    const body = await readJsonBody(request)
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new Error('Invalid routine tool request.')
    }
    const raw = body as Record<string, unknown>
    const tool = raw.tool
    const arguments_ = raw.arguments
    if (
      typeof tool !== 'string' ||
      !routineToolNames.has(tool) ||
      typeof arguments_ !== 'object' ||
      arguments_ === null ||
      Array.isArray(arguments_)
    ) throw new Error('Invalid routine tool request.')

    const parsed = tool === 'routine_save'
      ? RoutineToolSaveInputSchema.safeParse(arguments_)
      : tool === 'routine_cancel'
        ? RoutineToolCancelInputSchema.safeParse(arguments_)
        : Object.keys(arguments_).length === 0
        ? { success: true as const, data: undefined }
        : { success: false as const }
    if (!parsed.success) throw new Error(`Invalid ${tool} fields.`)
    const provided = Array.isArray(request.headers['x-manor-routine-capability'])
      ? request.headers['x-manor-routine-capability'][0]
      : request.headers['x-manor-routine-capability']
    const context = capabilities.take(provided, tool as RoutineToolName)
    const result = await service.useRoutineTool(context, tool as RoutineToolName, parsed.data)
    json(response, 200, { result })
  } catch (error: unknown) {
    if (error instanceof InvalidRoutineCapabilityError) {
      json(response, 404, { error: 'Not found.' })
      return
    }
    json(response, 503, { error: error instanceof Error ? error.message : 'The routine action failed.' })
  }
}

async function handleWorkToolRequest(
  request: IncomingMessage,
  response: ServerResponse,
  service: ManorService,
  capabilities: WorkCapabilities,
): Promise<void> {
  if (request.method !== 'POST' || !isLoopback(request.socket.remoteAddress)) {
    json(response, 404, { error: 'Not found.' })
    return
  }
  try {
    const parsed = WorkToolInputSchema.safeParse(await readJsonBody(request))
    if (!parsed.success) throw new Error('Invalid session handoff fields.')
    const provided = Array.isArray(request.headers['x-manor-work-capability'])
      ? request.headers['x-manor-work-capability'][0]
      : request.headers['x-manor-work-capability']
    const result = await service.useWorkTool(capabilities.take(provided), parsed.data)
    json(response, 200, { result })
  } catch (error: unknown) {
    if (error instanceof InvalidWorkCapabilityError) {
      json(response, 404, { error: 'Not found.' })
      return
    }
    json(response, 503, { error: error instanceof Error ? error.message : 'The session handoff failed.' })
  }
}

async function handleSkillReadRequest(
  request: IncomingMessage,
  response: ServerResponse,
  capabilities: SkillCapabilities,
): Promise<void> {
  if (request.method !== 'POST' || !isLoopback(request.socket.remoteAddress)) {
    json(response, 404, { error: 'Not found.' })
    return
  }

  try {
    const body = await readJsonBody(request)
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new Error('Invalid skill read request.')
    }
    const input = body as Record<string, unknown>
    const skillId = input.skillId
    const relativePath = input.path
    const offset = input.offset
    if (
      typeof skillId !== 'string' ||
      typeof relativePath !== 'string' ||
      (offset !== undefined && (!Number.isSafeInteger(offset) || Number(offset) < 0))
    ) throw new Error('Invalid skill read request.')
    const provided = Array.isArray(request.headers['x-manor-skill-capability'])
      ? request.headers['x-manor-skill-capability'][0]
      : request.headers['x-manor-skill-capability']
    const result = await capabilities.read(
      provided,
      skillId,
      relativePath,
      offset === undefined ? 0 : Number(offset),
    )
    json(response, 200, { result })
  } catch (error: unknown) {
    if (error instanceof InvalidSkillCapabilityError) {
      json(response, 404, { error: 'Not found.' })
      return
    }
    json(response, 503, { error: error instanceof Error ? error.message : 'The skill read failed.' })
  }
}

void main().catch((error: unknown) => {
  console.error('[manor] failed to start', error)
  process.exitCode = 1
})
