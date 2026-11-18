import { BROWSER_HOME_SESSION_ID, LIVE_COMPACT_CONTEXT_FRACTION, REASONING_LIMIT, SINGLE_CHAT_VOICE, modelTextOf, SUBAGENT_VOICE, ThreadEventSchema, contextWindowFor, defaultModel, type AgentConfig, type AttachedMcpServer, type Driver, type McpServerConfig, type RuntimeEvent, type LiveSessionEvent, type LiveSessionInfo, type LiveSessionItem, type ServerMessage, type SkillConfig, type ThreadEvent, type TurnInput } from '@manor/contracts'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { chmod, mkdir, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AsyncQueue } from '../src/asyncQueue.js'
import { CHANGED_AFTER_RESULT_NOTE, isProse, sessionChangedFiles } from '../src/goalReview.js'
import { observeWorkCompletion, prepareWorkCompletion } from '../src/workCompletion.js'
import {
  HOUSEHOLD_HEADING,
  HOUSE_STYLE_HEADING,
  HOUSE_STYLE_BLOCK,
  DM_HOUSE_STYLE_BLOCK,
  WRONG_AGENT_RULE,
  DM_ROUTINE_OUTCOME_HEADING,
  composeCatchUp,
  DM_ROUTINE_INCOMPLETE_MARKER,
  DM_ROUTINE_PUBLISH_MARKER,
  DM_ROUTINE_QUIET_MARKER,
  ROUTINE_OUTCOME_HEADING,
  SESSION_CEILING_CHARS,
  SESSION_CONTEXT_FRACTION,
  SESSION_CONTEXT_TOKEN_CAP,
  SUBAGENT_RULE,
  SINGLE_SUBAGENT_RULE,
  SESSION_PLAN_RULE,
} from '../src/composer.js'
import { RESUME_FAILURE_PREFIX } from '../src/drivers/resumeFailure.js'
import {
  LIVE_COMPACT_DONE,
  LIVE_COMPACT_FAILED,
  LIVE_COMPACT_NOTE,
  LIVE_COMPACT_STOPPED,
} from '../src/drivers/sessionCompact.js'
import { createClaudeDriver } from '../src/drivers/claudeDriver.js'
import { createMockDriver } from '../src/drivers/mockDriver.js'
import type { GenerateMemoryTrace } from '../src/memoryTrace.js'
import type { MemoryTarget } from '../src/memoryTarget.js'
import type { WriteDailyLog } from '../src/memoryWriter.js'
import { browserMcpAttachment } from '../src/mcp/browserAttachment.js'
import { BrowserBroker } from '../src/browserBroker.js'
import { browserTargetContext } from '../src/browserTarget.js'
import { CUA_DRIVER_PATH } from '../src/mcp/computerAttachment.js'
import { artifactMcpAttachment } from '../src/mcp/artifactAttachment.js'
import { interactionMcpAttachment } from '../src/mcp/interactionAttachment.js'
import { skillMcpAttachment } from '../src/mcp/skillAttachment.js'
import {
  Orchestrator,
  PROVIDER_RECOVERY_NUDGE,
  REPORT_BACK_NUDGE,
  type OrchestratorOptions,
  type RevocableSkillMcp,
} from '../src/orchestrator.js'
import type { Store } from '../src/store.js'
import { sweepUnterminatedTurns } from '../src/turnSweep.js'
import { WorkModule } from '../src/workModule.js'
import { createMemoryStore } from '../src/stores/memoryStore.js'
import { GOAL_CONTINUE_NUDGE } from '../src/turnRunner.js'
import { pdfFixture } from './documentFixtures.js'
import * as snapshots from '../src/turnFileSnapshots.js'
import {
  appendFailsOn,
  appendFailsTimes,
  cosRoster,
  marlow,
  endless,
  gated,
  handed,
  partialEndless,
  recording,
  roster,
  sage,
  scratchFor,
  scripted,
  seededChat,
  sessionIdIn,
  smith,
  until,
} from './helpers.js'
import { InteractionBroker } from '../src/interactionBroker.js'

interface Harness {
  orchestrator: Orchestrator
  store: Store
  chatId: string
  projectId: string
  sent: ServerMessage[]
}

interface HarnessOptions {
  onStoredMessageSettled?: OrchestratorOptions['onStoredMessageSettled']
  selectAutoRuntime?: OrchestratorOptions['selectAutoRuntime']
  builtInMcp?: OrchestratorOptions['builtInMcp']
  browserTargetContext?: OrchestratorOptions['browserTargetContext']
  computerTargetReady?: OrchestratorOptions['computerTargetReady']
  guardMcp?: OrchestratorOptions['guardMcp']
  browserTabsNote?: OrchestratorOptions['browserTabsNote']
  agents?: readonly AgentConfig[]
  delegationCap?: number
  reviewHops?: number
  wakeCap?: number
  wakeHoldMs?: number
  liveSessions?: OrchestratorOptions['liveSessions']
  browserRecoveryWaitMs?: number
  mcpServers?: readonly McpServerConfig[]
  skills?: readonly SkillConfig[]
  skillMcp?: (
    skillIds: readonly string[],
    onSkillRead: (skillId: string) => void,
  ) => RevocableSkillMcp
  artifactMcp?: (chatId: string, agent: AgentConfig, turnId: string) => AttachedMcpServer
  interactionMcp?: OrchestratorOptions['interactionMcp']
  skillCacheDir?: string
  scratchDir?: string
  onSkillsUsed?: (skillIds: readonly string[], driver: AgentConfig['driver']) => void
  advanceChatSummary?: (chatId: string) => Promise<boolean>
  generateMemoryTrace?: GenerateMemoryTrace
  memoryRoots?: readonly string[]
  structuredMemoryRoot?: string
  rankStructuredMemory?: OrchestratorOptions['rankStructuredMemory']
  memoryTarget?: MemoryTarget
  userName?: () => string | undefined
  writeDailyLog?: WriteDailyLog
  projectThreadTurns?: OrchestratorOptions['projectThreadTurns']
  openQuestions?: OrchestratorOptions['openQuestions']
}

function liveCompactDriver(
  seen: TurnInput[],
  compact: () => boolean,
  contextTokens?: number,
  hold?: Promise<void>,
): Driver {
  return {
    startTurn(input) {
      seen.push(input)
      const queue = new AsyncQueue<RuntimeEvent>()
      queue.push({
        type: 'result',
        text: 'Continued.',
        sessionId: input.sessionId ?? 'fresh-session',
        ...(contextTokens === undefined ? {} : { contextTokens }),
      })
      queue.close()
      return {
        events: queue,
        stop() {
          queue.close()
        },
      }
    },
    compactSession() {
      const queue = new AsyncQueue<RuntimeEvent>()
      const finish = () => {
        queue.push(
          compact()
            ? { type: 'result', text: '' }
            : { type: 'error', message: 'compact failed' },
        )
        queue.close()
      }
      if (hold === undefined) finish()
      else void hold.then(finish, finish)
      return {
        events: queue,
        stop() {
          queue.close()
        },
      }
    },
  }
}

/** The seeded room as a project, not a folder (2026-11-13): a hidden thread, so no thread files load. */
async function asProject(store: Store, chatId: string) {
  const projectId = (await store.getChat(chatId))!.projectId!
  const thread = await store.createChat({ kind: 'project', projectId })
  await store.setChatArchived(thread.id, true)
  await store.setProjectThread(projectId, thread.id)
}

async function harness(driver: Driver, options: HarnessOptions = {}): Promise<Harness> {
  const agents = options.agents ?? roster
  const store = createMemoryStore({ agents })
  const { chatId, projectId } = await seededChat(store)
  const sent: ServerMessage[] = []
  const scratchDir = options.scratchDir
  const orchestrator = new Orchestrator({
    agents: () => agents,
    store,
    mcpServers: () => options.mcpServers ?? [],
    skills: () => options.skills ?? [],
    ...(options.builtInMcp === undefined ? {} : { builtInMcp: options.builtInMcp }),
    ...(options.browserTargetContext === undefined ? {} : { browserTargetContext: options.browserTargetContext }),
    ...(options.computerTargetReady === undefined ? {} : { computerTargetReady: options.computerTargetReady }),
    ...(options.guardMcp === undefined ? {} : { guardMcp: options.guardMcp }),
    ...(options.browserTabsNote === undefined ? {} : { browserTabsNote: options.browserTabsNote }),
    ...(options.skillMcp === undefined ? {} : { skillMcp: options.skillMcp }),
    ...(options.artifactMcp === undefined ? {} : { artifactMcp: options.artifactMcp }),
    ...(options.interactionMcp === undefined ? {} : { interactionMcp: options.interactionMcp }),
    ...(options.skillCacheDir === undefined ? {} : { skillCacheDir: options.skillCacheDir }),
    ...(options.onSkillsUsed === undefined ? {} : { onSkillsUsed: options.onSkillsUsed }),
    ...(options.advanceChatSummary === undefined ? {} : { advanceChatSummary: options.advanceChatSummary }),
    ...(options.generateMemoryTrace === undefined ? {} : { generateMemoryTrace: options.generateMemoryTrace }),
    ...(options.selectAutoRuntime === undefined ? {} : { selectAutoRuntime: options.selectAutoRuntime }),
    ...(options.memoryRoots === undefined ? {} : { memoryRoots: options.memoryRoots }),
    ...(options.structuredMemoryRoot === undefined ? {} : { structuredMemoryRoot: options.structuredMemoryRoot }),
    ...(options.rankStructuredMemory === undefined ? {} : { rankStructuredMemory: options.rankStructuredMemory }),
    ...(options.memoryTarget === undefined ? {} : { memoryTarget: options.memoryTarget }),
    ...(options.userName === undefined ? {} : { userName: options.userName }),
    ...(options.writeDailyLog === undefined ? {} : { writeDailyLog: options.writeDailyLog }),
    ...(options.projectThreadTurns === undefined ? {} : { projectThreadTurns: options.projectThreadTurns }),
    ...(options.openQuestions === undefined ? {} : { openQuestions: options.openQuestions }),
    ...(options.onStoredMessageSettled === undefined ? {} : { onStoredMessageSettled: options.onStoredMessageSettled }),
    resolveDriver: () => driver,
    ensureScratchDir: scratchDir === undefined ? scratchFor : () => Promise.resolve(scratchDir),
    emit: (message) => sent.push(message),
    ...(options.delegationCap === undefined ? {} : { delegationCap: options.delegationCap }),
    ...(options.reviewHops === undefined ? {} : { reviewHops: options.reviewHops }),
    ...(options.wakeCap === undefined ? {} : { wakeCap: options.wakeCap }),
    ...(options.wakeHoldMs === undefined ? {} : { wakeHoldMs: options.wakeHoldMs }),
    ...(options.liveSessions === undefined ? {} : { liveSessions: options.liveSessions }),
    ...(options.browserRecoveryWaitMs === undefined ? {} : { browserRecoveryWaitMs: options.browserRecoveryWaitMs }),
  })
  return { orchestrator, store, chatId, projectId, sent }
}

/**
 * Who spoke, in order: the shape most delegation assertions are about. Reasoning is
 * trace rather than speech, so it is filtered out the same way turn_result is; the
 * durable reasoning row has its own test below.
 */
const speakers = (events: readonly { type: string }[]) =>
  events
    .filter((event) => event.type !== 'turn_result' && event.type !== 'reasoning')
    .map((event) => [event.type, 'agentId' in event ? event.agentId : 'user'])

const types = (events: readonly { type: string }[]) => events.map((event) => event.type)

/** The id of the turn a chat has announced as running; how the client addresses a stop. */
async function waitForRunning(sent: readonly ServerMessage[], chatId: string): Promise<string> {
  const announced = () =>
    sent.find((message) => message.type === 'turn_state' && message.chatId === chatId && message.state === 'running')
  await until(() => announced() !== undefined, `a running turn in ${chatId}`)
  const message = announced()
  return message?.type === 'turn_state' ? message.turnId : ''
}

describe('Orchestrator', () => {
  it('enforces placement for typed mentions and keeps only a captured legacy team eligible', async () => {
    const seen: TurnInput[] = []
    const agents: AgentConfig[] = [
      { ...sage, placement: 'chat' },
      { ...smith, id: 'wren', name: 'Wren', placement: 'session' },
      { ...smith, id: 'ellis', name: 'Ellis', placement: 'session' },
    ]
    const h = await harness(scripted(() => [{ type: 'message', messageId: 'answer', text: 'Done.' }], seen), { agents })
    await h.orchestrator.submitUserMessage(h.chatId, '@Sage cannot execute here')
    expect(seen).toHaveLength(0)
    await h.orchestrator.submitUserMessage(h.chatId, '@Wren can execute here')
    expect(seen.map((turn) => turn.agent.id)).toEqual(['wren'])
    const dm = await h.store.createChat({ kind: 'dm', memberIds: ['wren'] })
    await h.orchestrator.submitUserMessage(dm.id, 'Old history is readable, but cannot execute.')
    expect(seen).toHaveLength(1)
    const load = h.store.getChat.bind(h.store)
    h.store.getChat = async (id) => {
      const room = await load(id)
      return id === h.chatId && room !== undefined ? { ...room, legacySessionAgentIds: ['sage', 'wren'] } : room
    }
    await h.orchestrator.submitUserMessage(h.chatId, '@Sage finish the existing assignment')
    await h.orchestrator.submitUserMessage(h.chatId, '@Ellis cannot join the captured team')
    expect(seen.map((turn) => turn.agent.id)).toEqual(['wren', 'sage'])
    expect(seen.at(-1)?.agent.character).not.toContain('@Ellis')
  })

  it('gives an un-mentioned message in a Session with no lead to the first Session persona it seats', async () => {
    const answerer = async (agents: AgentConfig[], legacySessionAgentIds?: string[]) => {
      const seen: TurnInput[] = []
      const h = await harness(scripted(() => [{ type: 'message', messageId: 'answer', text: 'Done.' }], seen), { agents })
      if (legacySessionAgentIds !== undefined) {
        const load = h.store.getChat.bind(h.store)
        h.store.getChat = async (id) => {
          const room = await load(id)
          return id === h.chatId && room !== undefined ? { ...room, legacySessionAgentIds } : room
        }
      }
      await h.orchestrator.submitUserMessage(h.chatId, 'Who takes this?')
      return seen.map((turn) => turn.agent.id)
    }
    const cos = { ...marlow, placement: 'chat' } as const
    const ellis = { ...smith, id: 'ellis', name: 'Ellis', placement: 'session' } as const
    const argus = { ...smith, id: 'argus', name: 'Argus', placement: 'session' } as const
    // An install without the author's personas: roster order decides, and nobody is no throw.
    expect(await answerer([cos, ellis, argus])).toEqual(['ellis'])
    expect(await answerer([cos, { ...sage, placement: 'chat' }])).toEqual([])
    // A captured team seats only its own, so the persona left out of it is skipped.
    expect(await answerer([cos, ellis, argus], ['argus'])).toEqual(['argus'])
    // The author's roster order is argus, wren, ellis, and the default Session persona still answers.
    expect(await answerer([cos, argus, { ...ellis, id: 'wren', name: 'Wren' }, ellis])).toEqual(['wren'])
  })

  it('reuses the boot sweep input without loading each transcript again', async () => {
    const { orchestrator, store, chatId } = await harness(createMockDriver({ deltaDelayMs: 0 }))
    const started = await store.appendEvent(chatId, { type: 'user_message', text: '@Sage started', mentions: ['sage'], dispatchState: 'started' })
    const loaded = store.loadEvents.bind(store)
    let reads = 0
    store.loadEvents = async (id) => { reads += 1; return loaded(id) }
    const waiting = new Map()
    await sweepUnterminatedTurns({ store, agents: roster, onRecoveryInputs: (id, events) => waiting.set(id, events) })
    await orchestrator.recoverWaitingMessages(undefined, waiting)
    expect(reads).toBe(1)
    expect(waiting.get(chatId)).toEqual([started])
    expect((await loaded(chatId)).find((event) => event.id === started.id)).toMatchObject({ dispatchState: 'uncertain' })
  })

  it('reports recovered stored requests once their dispatch settled, so Confirm’s merge resumes after a restart', async () => {
    const seen: Record<string, string | undefined>[] = []
    let read: (id: string) => Promise<readonly ThreadEvent[]> = async () => []
    const { orchestrator, store, chatId } = await harness(createMockDriver({ deltaDelayMs: 0 }), {
      onStoredMessageSettled: async (id) => {
        seen.push(Object.fromEntries((await read(id)).flatMap((row) => row.type === 'user_message' ? [[row.text, row.dispatchState]] : [])))
      },
    })
    read = (id) => store.loadEvents(id)
    await store.appendEvent(chatId, { type: 'user_message', text: '@Sage interrupted', mentions: ['sage'], dispatchState: 'started' })
    await store.appendEvent(chatId, { type: 'user_message', text: '@Sage replayed', mentions: ['sage'], dispatchState: 'pending' })
    await orchestrator.recoverWaitingMessages()
    await orchestrator.runExclusive(chatId, async () => {})
    await vi.waitFor(() => expect(seen).toHaveLength(2))
    expect(seen[0]?.['@Sage interrupted']).toBe('uncertain')
    expect(seen[1]).toEqual({ '@Sage interrupted': 'uncertain', '@Sage replayed': 'completed' })
  })

  it('stops every active persona turn for shutdown', async () => {
    const gate = gated()
    const { orchestrator, store, chatId } = await harness(gate.driver)
    const second = await store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })
    const firstRun = orchestrator.submitUserMessage(chatId, '@Sage first')
    const secondRun = orchestrator.submitUserMessage(second.id, 'second')
    await until(() => gate.gates.length === 2, 'both turns to start')
    orchestrator.stopActiveTurns()
    await Promise.all([firstRun, secondRun])
    expect(orchestrator.activeChatIds()).toEqual([])
    expect((await store.loadEvents(chatId)).some((event) => event.type === 'turn_result')).toBe(false)
    expect((await store.loadEvents(second.id)).some((event) => event.type === 'turn_result')).toBe(false)
  })

  it('keeps arrival order when the first acceptance awaits a slow store read', async () => {
    const { orchestrator, store, chatId } = await harness(createMockDriver({ deltaDelayMs: 0 }))
    const getChat = store.getChat.bind(store)
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    let reads = 0
    store.getChat = async (id) => { if (++reads === 1) await gate; return getChat(id) }
    const first = orchestrator.submitUserMessage(chatId, '@Sage FIRST')
    const second = orchestrator.submitUserMessage(chatId, '@Sage SECOND')
    await until(() => reads > 0, 'the first acceptance read')
    expect((await store.loadEvents(chatId)).filter((row) => row.type === 'user_message')).toEqual([])
    release()
    await Promise.all([first, second])
    expect((await store.loadEvents(chatId)).filter((row) => row.type === 'user_message').map((row) => row.text))
      .toEqual(['@Sage FIRST', '@Sage SECOND'])
  })

  it('keeps recovered browser work pending until its host is ready and recovers only once', async () => {
    const seen: TurnInput[] = []
    const target = vi.fn(async () => 'Prepared browser target')
    const { orchestrator, store, chatId } = await harness(recording(createMockDriver({ deltaDelayMs: 0 }), seen), {
      browserTargetContext: target,
      builtInMcp: () => browserMcpAttachment('http://browser.test', 'fixture'),
    })
    const saved = await store.appendEvent(chatId, { type: 'user_message', text: '@Sage inspect @browser', mentions: ['sage'], dispatchState: 'pending' })
    let ready: () => void = () => {}
    const host = new Promise<void>((resolve) => { ready = resolve })
    await orchestrator.recoverWaitingMessages(host)
    await orchestrator.recoverWaitingMessages(host)
    expect(seen).toEqual([])
    expect(target).not.toHaveBeenCalled()
    expect((await store.loadEvents(chatId)).find((row) => row.id === saved.id)).toMatchObject({ dispatchState: 'pending' })
    ready()
    await orchestrator.runExclusive(chatId, async () => {})
    expect(target).toHaveBeenCalledOnce()
    expect(seen).toHaveLength(1)
    expect((await store.loadEvents(chatId)).find((row) => row.id === saved.id)).toMatchObject({ dispatchState: 'completed' })
  })

  it('ends recovered browser work visibly when no desktop host arrives, without blocking the chat', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, store, chatId } = await harness(recording(createMockDriver({ deltaDelayMs: 0 }), seen), {
      browserTargetContext: async () => 'Prepared browser target',
      builtInMcp: () => browserMcpAttachment('http://browser.test', 'fixture'),
      browserRecoveryWaitMs: 10,
    })
    const saved = await store.appendEvent(chatId, { type: 'user_message', text: '@Sage inspect @browser', mentions: ['sage'], dispatchState: 'pending' })
    await orchestrator.recoverWaitingMessages(new Promise<void>(() => {}))
    await orchestrator.submitUserMessage(chatId, '@Sage LATER')
    await orchestrator.runExclusive(chatId, async () => {})
    const events = await store.loadEvents(chatId)
    expect(events.find((row) => row.id === saved.id)).toMatchObject({ dispatchState: 'uncertain' })
    expect(events.some((row) => row.type === 'system_note' && row.kind === 'error' && row.text.includes('browser was not available'))).toBe(true)
    expect(seen).toHaveLength(1)
    expect(JSON.stringify(seen[0])).toContain('LATER')
  })

  it('binds a browser session to the home tabs with a plain tab note, and @browser to the explicit target', async () => {
    const seen: TurnInput[] = []
    const target = vi.fn(async (session: string) => `Explicit target on ${session}`)
    const note = vi.fn(async (session: string) => `Tabs of ${session}`)
    const builtInMcp = vi.fn((..._args: Parameters<NonNullable<OrchestratorOptions['builtInMcp']>>) =>
      browserMcpAttachment('http://browser.test', 'fixture'))
    const { orchestrator, store } = await harness(recording(createMockDriver({ deltaDelayMs: 0 }), seen), {
      browserTargetContext: target, browserTabsNote: note, builtInMcp,
    })
    const session = await store.createChat({ kind: 'browser', title: 'Browser' })
    await orchestrator.submitUserMessage(session.id, '@Sage what is on my calendar tomorrow?')
    await orchestrator.runExclusive(session.id, async () => {})
    expect(builtInMcp.mock.calls[0]?.[0]).toBe(session.id)
    expect(builtInMcp.mock.calls[0]?.[4]).toBe(BROWSER_HOME_SESSION_ID)
    expect(note.mock.calls[0]?.[0]).toBe(BROWSER_HOME_SESSION_ID)
    expect(target).not.toHaveBeenCalled()
    expect(JSON.stringify(seen[0])).toContain(`Tabs of ${BROWSER_HOME_SESSION_ID}`)

    await orchestrator.submitUserMessage(session.id, '@Sage read this in @browser')
    await orchestrator.runExclusive(session.id, async () => {})
    expect(target.mock.calls[0]?.[0]).toBe(BROWSER_HOME_SESSION_ID)
    expect(JSON.stringify(seen[1])).toContain(`Explicit target on ${BROWSER_HOME_SESSION_ID}`)
  })

  it('lets a turn the user started ask for a saved-login fill, but not a background wake', async () => {
    const builtInMcp = vi.fn((..._args: Parameters<NonNullable<OrchestratorOptions['builtInMcp']>>) =>
      browserMcpAttachment('http://browser.test', 'fixture'))
    const { orchestrator, chatId } = await harness(createMockDriver({ deltaDelayMs: 0 }), { builtInMcp })
    await orchestrator.submitUserMessage(chatId, '@Sage sign me in')
    await orchestrator.runExclusive(chatId, async () => {})
    await orchestrator.submitUserMessage(chatId, 'Background work ended.', [], { source: 'background_wake', agentId: 'sage' })
    await orchestrator.runExclusive(chatId, async () => {})
    expect(builtInMcp.mock.calls.map((call) => [call[3], call[5]])).toEqual([[true, true], [true, false]])
  })

  it('uses the preparation fallback when native steering requests a new browser target', async () => {
    const gate = gated()
    const steer = vi.fn(async () => 'accepted' as const)
    const target = vi.fn(async () => 'Prepared browser target')
    const { orchestrator, store } = await harness({ startTurn(input) { return { ...gate.driver.startTurn(input), steer } } }, {
      browserTargetContext: target, builtInMcp: () => browserMcpAttachment('http://localhost/browser', 'test-capability'),
    })
    const dm = await store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })
    const first = orchestrator.submitUserMessage(dm.id, 'Question')
    await until(() => gate.forChat(dm.id).length === 1, 'first native attempt')
    const addition = orchestrator.submitUserMessage(dm.id, 'Inspect @browser')
    await until(() => gate.forChat(dm.id).length === 2, 'browser context restart')
    expect(steer).not.toHaveBeenCalled()
    expect(target).toHaveBeenCalled()
    expect(gate.forChat(dm.id)[1]?.input.contextBlock).toContain('Prepared browser target')
    gate.forChat(dm.id)[1]?.finish()
    await Promise.all([first, addition])
  })

  it('serialises rapid native additions and drains their decisions before a terminal cursor', async () => {
    const gate = gated()
    let release: (value: 'accepted') => void = () => {}
    const delivered: string[] = []
    const steer = vi.fn(async (event) => {
      delivered.push(event.text)
      if (delivered.length === 1) await new Promise<'accepted'>((resolve) => { release = resolve })
      return 'accepted' as const
    })
    const { orchestrator, store } = await harness({ startTurn(input) { return { ...gate.driver.startTurn(input), steer } } })
    const dm = await store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })
    const first = orchestrator.submitUserMessage(dm.id, 'Question')
    await until(() => gate.forChat(dm.id).length === 1, 'native attempt')
    const a = orchestrator.submitUserMessage(dm.id, 'First addition')
    const b = orchestrator.submitUserMessage(dm.id, 'Second addition')
    await until(() => delivered.length === 1, 'first native addition')
    gate.forChat(dm.id)[0]?.finish()
    release('accepted')
    await Promise.all([first, a, b])
    expect(delivered).toEqual(['First addition', 'Second addition'])
    expect(gate.forChat(dm.id)).toHaveLength(1)
    const events = await store.loadEvents(dm.id)
    const result = events.findIndex((event) => event.type === 'turn_result')
    expect(events.findIndex((event) => event.type === 'user_message' && event.text === 'Second addition')).toBeLessThan(result)
  })
  it.each([
    ['single', false], ['single', true], ['house', false], ['house', true],
  ] as const)('always steers a %s Session addition (in project: %s)', async (mode, inProject) => {
    const gate = gated()
    const steer = vi.fn(async (_event: ThreadEvent) => 'accepted' as const)
    const { orchestrator, store, sent, projectId } = await harness({
      startTurn(input) { return { ...gate.driver.startTurn(input), steer } },
    })
    const sessionProject = inProject ? projectId : (await store.createProject('Standalone Session')).id
    const room = await store.createChat({ kind: 'project', mode, projectId: sessionProject })
    const agentId = mode === 'single' ? SINGLE_CHAT_VOICE.id : 'sage'
    await store.setChatOverride(room.id, agentId, { driver: 'codex', model: 'gpt-6.1-sol', effort: 'high', auto: false })
    const request = mode === 'single' ? 'Inspect the files.' : '@Sage Inspect the files.'
    const first = orchestrator.submitUserMessage(room.id, request)
    await until(() => gate.forChat(room.id).length === 1, 'the Session turn')
    expect(gate.forChat(room.id)[0]?.input.agent.driver).toBe('codex')
    const turnId = orchestrator.activeTurn(room.id)?.turnId
    const addition = orchestrator.submitUserMessage(room.id, 'Waar kijk je allemaal naar?')
    await until(() => steer.mock.calls.length === 1, 'native Session steering')
    expect(steer.mock.calls[0]?.[0]).toMatchObject({ type: 'user_message', steersTurnId: turnId })
    expect((await store.loadEvents(room.id)).find((event) => event.id === steer.mock.calls[0]?.[0].id))
      .toMatchObject({ steersTurnId: turnId })
    expect(gate.forChat(room.id)).toHaveLength(1)
    expect(sent.some((message) => message.type === 'turn_state' && message.reset)).toBe(false)
    gate.forChat(room.id)[0]?.finish()
    await Promise.all([first, addition])
    expect((await store.loadEvents(room.id)).filter((event) => event.type === 'turn_result')).toHaveLength(1)
  })

  it.each([
    ['project', 'native'], ['project', 'restart'], ['dm', 'native'], ['dm', 'restart'],
  ] as const)('keeps the stream position for a %s addition using %s', async (kind, delivery) => {
    const queues: AsyncQueue<RuntimeEvent>[] = []
    const { orchestrator, store, projectId, sent } = await harness({
      startTurn() {
        const queue = new AsyncQueue<RuntimeEvent>()
        queues.push(queue)
        queue.push({ type: 'delta', messageId: 'stream', text: queues.length === 1 ? 'Before ' : 'After' })
        return {
          events: queue,
          stop() { queue.close() },
          ...(delivery === 'native' ? { steer: async () => 'accepted' as const } : {}),
        }
      },
    })
    const room = await store.createChat(kind === 'dm' ? { kind, memberIds: ['sage'] } : { kind, mode: 'single', projectId })
    const first = orchestrator.submitUserMessage(room.id, 'Inspect the files.')
    await until(() => sent.some((message) => message.type === 'delta' && message.chatId === room.id), 'the first partial text')
    const addition = orchestrator.submitUserMessage(room.id, 'Change direction.')
    await until(() => delivery === 'restart' ? queues.length === 2
      : sent.some((message) => message.type === 'event' && message.chatId === room.id &&
        message.event.type === 'user_message' && message.event.steersTurnId !== undefined), 'the saved addition')
    const current = queues.at(-1)!
    current.push({ type: 'message', messageId: 'stream', text: delivery === 'native' ? 'Before After' : 'After' })
    current.push({ type: 'result', text: delivery === 'native' ? 'Before After' : 'After' })
    current.close()
    await Promise.all([first, addition])
    const events = (await store.loadEvents(room.id)).map((event) => ThreadEventSchema.parse(event))
    const steer = events.find((event) => event.type === 'user_message' && event.steersTurnId !== undefined)
    expect(steer).toMatchObject(kind === 'dm' ? { text: 'Change direction.' }
      : { steerAfter: { messageId: 'attempt_1:stream', textOffset: 'Before '.length } })
    if (steer?.type === 'user_message' && kind === 'dm') expect('steerAfter' in steer).toBe(false)
    if (delivery === 'restart') {
      const partial = events.find((event) => event.type === 'agent_message' && event.text === 'Before ')
      if (kind === 'dm') expect(partial).toBeUndefined()
      else expect(partial).toMatchObject({ messageId: 'attempt_1:stream', interrupted: true })
    }
    expect(events.filter((event) => event.type === 'turn_result')).toHaveLength(1)
  })

  it.each(['dm', 'group', 'browser', 'side'] as const)('steers an addition after a visible reply in %s', async (kind) => {
    const gate = gated()
    const steer = vi.fn(async (_event: ThreadEvent) => 'accepted' as const)
    const { orchestrator, store, chatId, sent } = await harness({
      startTurn(input) { return { ...gate.driver.startTurn(input), steer } },
    })
    const room = await store.createChat(kind === 'side' ? { kind, parentChatId: chatId }
      : kind === 'dm' ? { kind, memberIds: ['sage'] }
        : kind === 'group' ? { kind, memberIds: ['sage', 'smith'] } : { kind })
    const first = orchestrator.submitUserMessage(room.id, kind === 'side' ? 'Inspect the files.' : '@Sage Inspect the files.')
    await until(() => gate.forChat(room.id).length === 1, 'the running turn')
    const turnId = orchestrator.activeTurn(room.id)?.turnId
    gate.forChat(room.id)[0]?.say('I am inspecting the files.')
    await until(() => sent.some((message) => message.type === 'event' && message.chatId === room.id &&
      message.event.type === 'agent_message'), 'the visible reply')
    const addition = orchestrator.submitUserMessage(room.id, 'Also tell me what happens afterwards.')
    await until(() => steer.mock.calls.length === 1, 'the late addition to steer')
    expect(steer.mock.calls[0]?.[0]).toMatchObject({ steersTurnId: turnId })
    expect(gate.forChat(room.id)).toHaveLength(1)
    gate.forChat(room.id)[0]?.finish()
    await Promise.all([first, addition])
  })

  it.each(['native', 'restart'] as const)('keeps tool names in side-chat additions literal (%s)', async (delivery) => {
    const gate = gated()
    const steer = vi.fn(async () => 'accepted' as const)
    const { orchestrator, store, chatId } = await harness({
      startTurn(input) { return { ...gate.driver.startTurn(input), ...(delivery === 'native' ? { steer } : {}) } },
    }, { skills: [brainstormSkill] })
    const side = await store.createChat({ kind: 'side', parentChatId: chatId })
    const first = orchestrator.submitUserMessage(side.id, 'Explain this conversation.')
    await until(() => gate.forChat(side.id).length === 1, 'the side turn')
    const addition = orchestrator.submitUserMessage(side.id, 'What do @browser, @computer and $brainstorm mean?')
    await until(() => delivery === 'native' ? steer.mock.calls.length === 1 : gate.forChat(side.id).length === 2, 'literal side steering')
    const current = gate.forChat(side.id).at(-1)!
    expect(current.input.mcpServers).toBeUndefined()
    expect(current.input.volatileBlocks?.some((block) => block.key === 'selected-skills') ?? false).toBe(false)
    current.finish()
    await Promise.all([first, addition])
    expect((await store.loadEvents(side.id)).filter((event) => event.type === 'turn_result')).toHaveLength(1)
  })

  it('prepares a newly selected skill when a Single addition restarts the provider', async () => {
    const gate = gated()
    const steer = vi.fn(async () => 'accepted' as const)
    const grants: string[][] = []
    const revoked: number[] = []
    const { orchestrator, store, projectId } = await harness({
      startTurn(input) { return { ...gate.driver.startTurn(input), steer } },
    }, {
      skills: [brainstormSkill],
      skillMcp: (ids) => {
        const index = grants.push([...ids])
        return { attachment: skillMcpAttachment('http://skills.test', `cap-${index}`), revoke: () => { revoked.push(index) } }
      },
    })
    const room = await store.createChat({ projectId, mode: 'single' })
    const first = orchestrator.submitUserMessage(room.id, 'Inspect the files.')
    await until(() => gate.forChat(room.id).length === 1, 'the initial attempt')
    const addition = orchestrator.submitUserMessage(room.id, '$brainstorm Find alternatives.')
    await until(() => gate.forChat(room.id).length === 2, 'the skill preparation restart')
    expect(steer).not.toHaveBeenCalled()
    expect(gate.forChat(room.id)[1]?.input.volatileBlocks?.find((block) => block.key === 'selected-skills')?.text)
      .toContain(brainstormSkill.instructions)
    expect(grants).toEqual([[], ['brainstorm']])
    expect(revoked).toEqual([1])
    gate.forChat(room.id)[1]?.finish()
    await Promise.all([first, addition])
    expect(revoked).toEqual([1, 2])
  })

  it.each(['unheld', 'selected'] as const)('natively steers a skill token without changing capabilities when %s', async (selection) => {
    const gate = gated()
    const steer = vi.fn(async (_event: ThreadEvent) => 'accepted' as const)
    const grants: string[][] = []
    const { orchestrator, store, projectId } = await harness({
      startTurn(input) { return { ...gate.driver.startTurn(input), steer } },
    }, {
      skills: [brainstormSkill],
      skillMcp: (ids) => { grants.push([...ids]); return { attachment: skillMcpAttachment('http://skills.test', 'cap'), revoke() {} } },
    })
    const room = selection === 'selected' ? await store.createChat({ projectId, mode: 'single' })
      : await store.createChat({ kind: 'dm', memberIds: ['sage'] })
    const first = orchestrator.submitUserMessage(room.id, selection === 'selected' ? '$brainstorm Inspect the files.' : 'Inspect the files.')
    await until(() => gate.forChat(room.id).length === 1, 'the initial turn')
    const addition = orchestrator.submitUserMessage(room.id, '$brainstorm Also consider this.')
    await until(() => steer.mock.calls.length === 1, 'the native addition')
    expect(gate.forChat(room.id)).toHaveLength(1)
    expect(grants).toEqual(selection === 'selected' ? [['brainstorm']] : [])
    if (selection === 'unheld') expect(steer.mock.calls[0]?.[0]).not.toHaveProperty('skillIds')
    gate.forChat(room.id)[0]?.finish()
    await Promise.all([first, addition])
  })

  it('marks a saved addition undelivered when Stop wins its storage race', async () => {
    const gate = gated()
    const steer = vi.fn(async () => 'accepted' as const)
    const { orchestrator, store, chatId } = await harness({
      startTurn(input) { return { ...gate.driver.startTurn(input), steer } },
    })
    const first = orchestrator.submitUserMessage(chatId, '@Sage Inspect the files.')
    await until(() => gate.forChat(chatId).length === 1, 'the running turn')
    const append = store.appendEvent.bind(store)
    let saving = false
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    store.appendEvent = async (...args) => {
      if (args[1].type === 'user_message' && args[1].text === 'Also this.') { saving = true; await held }
      return append(...args)
    }
    const addition = orchestrator.submitUserMessage(chatId, 'Also this.')
    await until(() => saving, 'the addition write')
    orchestrator.stop(orchestrator.activeTurn(chatId)!.turnId)
    release()
    await Promise.all([first, addition])
    expect(steer).not.toHaveBeenCalled()
    const events = await store.loadEvents(chatId)
    const saved = events.find((event) => event.type === 'user_message' && event.text === 'Also this.')
    expect(saved).toMatchObject({ dispatchState: 'uncertain' })
    expect(events).toContainEqual(expect.objectContaining({ type: 'system_note', hintFor: saved?.id }))
  })

  it('keeps a DM Work destination out of the running answer', async () => {
    const gate = gated()
    const steer = vi.fn(async () => 'accepted' as const)
    const { orchestrator, store, sent } = await harness({
      startTurn(input) { return { ...gate.driver.startTurn(input), steer } },
    })
    const dm = await store.createChat({ kind: 'dm', memberIds: ['sage'] })
    const first = orchestrator.submitUserMessage(dm.id, 'Inspect the files.')
    await until(() => gate.forChat(dm.id).length === 1, 'the DM turn')
    const work = orchestrator.submitUserMessage(dm.id, '@work Build an export button.')
    await until(() => sent.some((message) => message.type === 'event' &&
      message.event.type === 'user_message' && message.event.text.startsWith('@work')), 'the Work request')
    const saved = (await store.loadEvents(dm.id)).find((event) => event.type === 'user_message' && event.text.startsWith('@work'))
    expect(saved).toMatchObject({ dispatchState: 'pending' })
    expect(saved).not.toHaveProperty('steersTurnId')
    expect(steer).not.toHaveBeenCalled()
    orchestrator.stopChat(dm.id)
    await Promise.all([first, work])
  })

  it('starts an addition arriving after Stop as a fresh request', async () => {
    const gate = gated()
    const steer = vi.fn(async () => 'accepted' as const)
    const { orchestrator, store, chatId, sent } = await harness({
      startTurn(input) { return { ...gate.driver.startTurn(input), steer, stop() {} } },
    })
    const first = orchestrator.submitUserMessage(chatId, '@Sage Inspect the files.')
    await until(() => gate.forChat(chatId).length === 1, 'the running turn')
    const stopped = orchestrator.activeTurn(chatId)!.turnId
    orchestrator.stop(stopped)
    const addition = orchestrator.submitUserMessage(chatId, '@Sage Start again.')
    await until(() => sent.some((message) => message.type === 'event' &&
      message.event.type === 'user_message' && message.event.text === '@Sage Start again.'), 'the later request')
    const saved = (await store.loadEvents(chatId)).find((event) => event.type === 'user_message' && event.text === '@Sage Start again.')
    expect(saved).toMatchObject({ dispatchState: 'pending' })
    expect(saved).not.toHaveProperty('steersTurnId')
    gate.forChat(chatId)[0]?.finish()
    await until(() => gate.forChat(chatId).length === 2, 'the new turn')
    expect(orchestrator.activeTurn(chatId)?.turnId).not.toBe(stopped)
    gate.forChat(chatId)[1]?.finish()
    await Promise.all([first, addition])
    expect(steer).not.toHaveBeenCalled()
  })

  it('uses restart steering for a Cursor Session addition', async () => {
    const gate = gated()
    const { orchestrator, store, projectId } = await harness(gate.driver)
    const room = await store.createChat({ projectId, mode: 'single' })
    await store.setChatOverride(room.id, SINGLE_CHAT_VOICE.id, {
      driver: 'cursor', model: 'cursor-composer-2.5', effort: 'high', auto: false,
    })
    const first = orchestrator.submitUserMessage(room.id, 'Inspect the files.')
    await until(() => gate.forChat(room.id).length === 1, 'the Cursor Session turn')
    expect(gate.forChat(room.id)[0]?.input.agent.driver).toBe('cursor')
    const turnId = orchestrator.activeTurn(room.id)?.turnId
    const addition = orchestrator.submitUserMessage(room.id, 'Waar kijk je allemaal naar?')
    await until(() => gate.forChat(room.id).length === 2, 'the Cursor steering restart')
    expect(orchestrator.activeTurn(room.id)?.turnId).toBe(turnId)
    expect(gate.forChat(room.id)[1]?.input.catchUp).toContainEqual(expect.objectContaining({
      type: 'user_message', text: 'Waar kijk je allemaal naar?', steersTurnId: turnId,
    }))
    gate.forChat(room.id)[1]?.finish()
    await Promise.all([first, addition])
  })

  it.each(['dm', 'project'] as const)('saves native steering in %s and replays only a refusal', async (kind) => {
    for (const delivery of ['accepted', 'refused', 'uncertain'] as const) {
      const gate = gated()
      const stop = vi.fn()
      let store: Store
      const steer = vi.fn(async (event) => {
        expect((await store.loadEvents(event.chatId ?? dm.id)).some((row) => row.id === event.id)).toBe(true)
        return delivery
      })
      const setup = await harness({ startTurn(input) {
        const handle = gate.driver.startTurn(input)
        return { ...handle, steer, stop() { stop(); handle.stop() } }
      } })
      store = setup.store
      const { orchestrator, sent } = setup
      const dm = kind === 'dm' ? await store.createChat({ kind, memberIds: ['sage'], title: 'Sage' }) : (await store.getChat(setup.chatId))!
      const first = orchestrator.submitUserMessage(dm.id, '@Sage Question')
      await until(() => gate.forChat(dm.id).length === 1, 'native turn')
      const addition = orchestrator.submitUserMessage(dm.id, 'Correction')
      await until(() => steer.mock.calls.length === 1, 'native steering')
      if (delivery === 'refused') {
        await until(() => gate.forChat(dm.id).length === 2, 'refused fallback')
        gate.forChat(dm.id)[1]?.finish()
      } else if (delivery === 'accepted') gate.forChat(dm.id)[0]?.finish()
      await Promise.all([first, addition])
      expect(gate.forChat(dm.id)).toHaveLength(delivery === 'refused' ? 2 : 1)
      expect(stop).toHaveBeenCalledTimes(delivery === 'accepted' ? 0 : 1)
      expect(sent.some((row) => row.type === 'turn_state' && row.reset)).toBe(delivery === 'refused')
      if (delivery === 'uncertain') {
        // Said under the addition itself; the turn reads as stopped.
        const events = await store.loadEvents(dm.id)
        const addition = events.find((event) => event.type === 'user_message' && event.text === 'Correction')
        expect(events).toContainEqual(expect.objectContaining({
          type: 'system_note', kind: 'info', hintFor: addition?.id, text: "Saved, but Sage may not have seen it. Resend if there's no reply.",
        }))
        expect(events).toContainEqual(expect.objectContaining({ type: 'system_note', kind: 'aborted', agentId: 'sage' }))
      }

    }
  })

  it.each(['dm', 'project', 'single'] as const)('folds a message sent during a %s turn into the same answer', async (kind) => {
    const gate = gated((input) => input.catchUp
      .filter((event) => event.type === 'user_message')
      .map((event) => event.text)
      .join(' + '))
    const { orchestrator, store, sent, chatId, projectId } = await harness(gate.driver)
    const dm = kind === 'dm' ? await store.createChat({ kind, memberIds: ['sage'], title: 'Sage' })
      : kind === 'single' ? await store.createChat({ projectId, mode: 'single' }) : (await store.getChat(chatId))!
    const question = kind === 'project' ? '@Sage First question.' : 'First question.'

    const first = orchestrator.submitUserMessage(dm.id, question)
    await until(() => gate.forChat(dm.id).length === 1, 'the first attempt')
    const turnId = orchestrator.activeTurn(dm.id)?.turnId
    const steering = orchestrator.submitUserMessage(dm.id, 'Actually, include this too.')
    await until(() => gate.forChat(dm.id).length === 2, 'the steered attempt')

    expect(orchestrator.activeTurn(dm.id)?.turnId).toBe(turnId)
    expect(gate.forChat(dm.id)[1]?.input.catchUp
      .filter((event) => event.type === 'user_message')
      .map((event) => event.text)).toEqual([question, 'Actually, include this too.'])
    expect((await store.loadEvents(dm.id)).filter((event) => event.type === 'user_message').map((event) => event.text))
      .toEqual([question, 'Actually, include this too.'])
    expect(sent).toContainEqual(expect.objectContaining({
      type: 'turn_state',
      chatId: dm.id,
      turnId,
      state: 'running',
      reset: true,
    }))

    gate.forChat(dm.id)[1]?.finish()
    await Promise.all([first, steering])
    expect((await store.loadEvents(dm.id)).filter((event) => event.type === 'agent_message')).toEqual([
      expect.objectContaining({ text: `${question} + Actually, include this too.` }),
    ])
  })

  it.each(['dm', 'project'] as const)('resumes an existing %s session with only the new steering message', async (kind) => {
    const gate = gated()
    const { orchestrator, store, chatId } = await harness(gate.driver)
    const dm = kind === 'dm' ? await store.createChat({ kind, memberIds: ['sage'], title: 'Sage' }) : (await store.getChat(chatId))!

    const opening = orchestrator.submitUserMessage(dm.id, '@Sage Opening message.')
    await until(() => gate.forChat(dm.id).length === 1, 'the opening DM turn')
    gate.forChat(dm.id)[0]?.finish()
    await opening

    const first = orchestrator.submitUserMessage(dm.id, 'Start with this.')
    await until(() => gate.forChat(dm.id).length === 2, 'the resumed DM attempt')
    const steering = orchestrator.submitUserMessage(dm.id, 'Use this correction too.')
    await until(() => gate.forChat(dm.id).length === 3, 'the replacement resumed attempt')

    const replacement = gate.forChat(dm.id)[2]?.input
    expect(replacement?.sessionId).toBe(`session-${dm.id}-sage`)
    expect(replacement?.catchUp.filter((event) => event.type === 'user_message').map((event) => event.text))
      .toEqual(['Use this correction too.'])
    expect(replacement?.catchUp.some(
      (event) => event.type === 'system_note' && event.text.includes('steering for the same answer'),
    )).toBe(true)

    gate.forChat(dm.id)[2]?.finish()
    await Promise.all([first, steering])
  })

  it('stacks every DM message into the running turn, including after the first reply', async () => {
    const gate = gated((input) => input.catchUp
      .filter((event) => event.type === 'user_message')
      .map((event) => event.text)
      .join(' + '))
    const { orchestrator, store, sent } = await harness(gate.driver)
    const dm = await store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })

    const sends = [orchestrator.submitUserMessage(dm.id, 'jawel')]
    await until(() => gate.forChat(dm.id).length === 1, 'the first attempt')
    const turnId = orchestrator.activeTurn(dm.id)?.turnId
    sends.push(orchestrator.submitUserMessage(dm.id, 'rentman?'))
    await until(() => gate.forChat(dm.id).length === 2, 'the second message to steer')
    sends.push(orchestrator.submitUserMessage(dm.id, 'die meld zich net ziek'))
    await until(() => gate.forChat(dm.id).length === 3, 'the third message to steer')
    expect(orchestrator.activeTurn(dm.id)?.turnId).toBe(turnId)

    gate.forChat(dm.id)[2]?.say('Answered all three.')
    await until(() => sent.some((message) => message.type === 'event' && message.event.type === 'agent_message'), 'the reply')
    sends.push(orchestrator.submitUserMessage(dm.id, 'dus we moeten daarop reageren'))
    await until(() => gate.forChat(dm.id).length === 4, 'the late addition to steer')
    expect(orchestrator.activeTurn(dm.id)?.turnId).toBe(turnId)
    gate.forChat(dm.id)[3]?.finish()
    await Promise.all(sends)
    const events = await store.loadEvents(dm.id)
    expect(events.filter((event) => event.type === 'user_message').map((event) => [event.text, event.steersTurnId]))
      .toEqual([
        ['jawel', undefined],
        ['rentman?', turnId],
        ['die meld zich net ziek', turnId],
        ['dus we moeten daarop reageren', turnId],
      ])
    expect(gate.forChat(dm.id)[3]?.input.catchUp.filter((event) => event.type === 'user_message').map((event) => event.text))
      .toEqual(['jawel', 'rentman?', 'die meld zich net ziek', 'dus we moeten daarop reageren'])
    expect(events.filter((event) => event.type === 'agent_message' && event.turnId === turnId).map((event) => event.type === 'agent_message' && event.text))
      .toEqual(['Answered all three.', 'jawel + rentman? + die meld zich net ziek + dus we moeten daarop reageren'])
  })

  it.each([
    ['dm', 'say'], ['dm', 'finish'], ['project', 'finish'], ['single', 'finish'],
    ['group', 'finish'], ['browser', 'finish'], ['side', 'finish'],
  ] as const)('steers a %s message while the first reply (%s) is being stored', async (kind, reply) => {
    const gate = gated()
    const { orchestrator, store, projectId, chatId } = await harness(gate.driver)
    const dm = await store.createChat(kind === 'single' ? { projectId, mode: 'single' }
      : kind === 'project' ? { projectId } : kind === 'side' ? { kind, parentChatId: chatId }
        : kind === 'dm' ? { kind, memberIds: ['sage'] } : kind === 'group' ? { kind, memberIds: ['sage', 'smith'] } : { kind })
    let holding = false
    let release: () => void = () => {}
    const hold = new Promise<void>((resolve) => { release = resolve })
    const appendEvent = store.appendEvent.bind(store)
    store.appendEvent = async (...args) => {
      if (args[1].type === 'agent_message' && !holding) {
        holding = true
        await hold
      }
      return appendEvent(...args)
    }

    const question = kind === 'project' || kind === 'group' || kind === 'browser' ? '@Sage Question' : 'Question'
    const first = orchestrator.submitUserMessage(dm.id, question)
    await until(() => gate.forChat(dm.id).length === 1, 'the first attempt')
    const turnId = orchestrator.activeTurn(dm.id)?.turnId
    if (reply === 'say') gate.forChat(dm.id)[0]?.say('Early answer')
    else gate.forChat(dm.id)[0]?.finish()
    await until(() => holding, 'the reply write to be pending')
    const addition = orchestrator.submitUserMessage(dm.id, 'Also this')
    // The addition's own write queues behind the held reply; give its routing the moment it needs.
    await new Promise((resolve) => setTimeout(resolve, 20))
    release()
    await until(() => gate.forChat(dm.id).length === 2, 'the addition to steer')
    expect(orchestrator.activeTurn(dm.id)?.turnId).toBe(turnId)
    expect(gate.forChat(dm.id)[1]?.input.catchUp.filter((event) => event.type === 'user_message').map((event) => event.text))
      .toEqual([question, 'Also this'])
    gate.forChat(dm.id)[1]?.finish()
    await Promise.all([first, addition])

    expect((await store.loadEvents(dm.id)).find((event) => event.type === 'user_message' && event.text === 'Also this'))
      .toMatchObject({ steersTurnId: turnId })
  })

  it('steers a separate question during a project turn into the same answer', async () => {
    const gate = gated()
    const { orchestrator, store, chatId } = await harness(gate.driver)
    const dm = (await store.getChat(chatId))!
    const question = '@Sage Fix the checkout.'

    const first = orchestrator.submitUserMessage(dm.id, question)
    await until(() => gate.forChat(dm.id).length === 1, 'the first attempt')
    const turnId = orchestrator.activeTurn(dm.id)?.turnId
    const steer = orchestrator.submitUserMessage(dm.id, 'Only change the validation helper.')
    await until(() => gate.forChat(dm.id).length === 2, 'the steered attempt')
    const later = orchestrator.submitUserMessage(dm.id, 'After this, summarize the release notes.')
    await until(() => gate.forChat(dm.id).length === 3, 'the separate question to steer')
    expect(orchestrator.activeTurn(dm.id)?.turnId).toBe(turnId)
    expect(gate.forChat(dm.id)[2]?.input.catchUp.filter((event) => event.type === 'user_message').map((event) => event.text))
      .toContain('After this, summarize the release notes.')
    gate.forChat(dm.id)[2]?.finish()
    await Promise.all([first, steer, later])
    const events = await store.loadEvents(dm.id)
    const users = events.filter((event) => event.type === 'user_message')
    expect(users.map((event) => [event.text, event.steersTurnId !== undefined, event.dispatchState])).toEqual([
      [question, false, 'completed'],
      ['Only change the validation helper.', true, undefined],
      ['After this, summarize the release notes.', true, undefined],
    ])
    expect(users[2]).not.toHaveProperty('queuedAfter')
    expect(events.filter((event) => event.type === 'turn_result')).toHaveLength(1)
  })

  it('keeps an explicit Work request to another persona separate from the active answer', async () => {
    const gate = gated()
    const { orchestrator, store, chatId, sent } = await harness(gate.driver)
    const first = orchestrator.submitUserMessage(chatId, '@Sage First request.')
    await until(() => gate.forChat(chatId).length === 1, 'Sage to start')
    const other = orchestrator.submitUserMessage(chatId, '@Smith Different request.')
    await until(() => sent.some((message) => message.type === 'event' &&
      message.event.type === 'user_message' && message.event.text === '@Smith Different request.'), 'the separate request to be saved')
    expect(gate.forChat(chatId)).toHaveLength(1)
    expect(orchestrator.activeTurn(chatId)?.agentId).toBe('sage')
    gate.forChat(chatId)[0]?.finish()
    await until(() => gate.forChat(chatId).length === 2, 'Smith to start after Sage')
    expect(gate.forChat(chatId)[1]?.input.agent.id).toBe('smith')
    gate.forChat(chatId)[1]?.finish()
    await Promise.all([first, other])
    expect((await store.loadEvents(chatId)).filter((event) => event.type === 'agent_message').map((event) => event.agentId))
      .toEqual(['sage', 'smith'])
  })

  it('closes a tool call interrupted by DM steering before the replacement starts', async () => {
    const attempts: AsyncQueue<RuntimeEvent>[] = []
    const driver: Driver = {
      startTurn() {
        const queue = new AsyncQueue<RuntimeEvent>()
        attempts.push(queue)
        if (attempts.length === 1) {
          queue.push({ type: 'tool_use', toolCallId: 'read-1', tool: 'Read' })
        }
        return {
          events: queue,
          stop() {
            queue.close()
          },
        }
      },
    }
    const { orchestrator, store, sent } = await harness(driver)
    const dm = await store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })

    const first = orchestrator.submitUserMessage(dm.id, 'Read this.')
    await until(() => sent.some(
      (message) => message.type === 'event' && message.event.type === 'tool_use',
    ), 'the first tool call')
    const steering = orchestrator.submitUserMessage(dm.id, 'Stop reading and answer directly.')
    await until(() => attempts.length === 2, 'the replacement attempt')

    expect((await store.loadEvents(dm.id)).find(
      (event) => event.type === 'tool_result' && event.toolCallId === 'read-1',
    )).toMatchObject({ outcome: 'error' })

    attempts[1]?.push({ type: 'result', text: 'Combined answer.' })
    attempts[1]?.close()
    await Promise.all([first, steering])
  })

  it('gives the project thread guard only the writes of calls that succeeded', async () => {
    const ended = vi.fn<NonNullable<OrchestratorOptions['projectThreadTurns']>['ended']>(async () => undefined)
    const { orchestrator, chatId } = await harness(scripted(() => [
      { type: 'tool_use', toolCallId: 'ok', tool: 'Bash', command: 'echo x >> /notes/ok.md' },
      { type: 'tool_result', toolCallId: 'ok', outcome: 'success' },
      { type: 'tool_use', toolCallId: 'failed', tool: 'Bash', command: 'echo y >> /notes/failed.md' },
      { type: 'tool_result', toolCallId: 'failed', outcome: 'error' },
      // A shell call's own edits are a guess from its text; only the reader's answer counts.
      { type: 'tool_use', toolCallId: 'guess', tool: 'Edit', command: 'test -f /notes/g.md || echo z >> /notes/g.md', edits: [{ path: '/notes/g.md' }] },
      { type: 'tool_result', toolCallId: 'guess', outcome: 'success' },
      { type: 'tool_use', toolCallId: 'edit', tool: 'Edit', edits: [{ path: '/notes/edited.md' }] },
      { type: 'tool_result', toolCallId: 'edit', outcome: 'success' },
      { type: 'tool_use', toolCallId: 'stale', tool: 'Edit', edits: [{ path: '/notes/stale.md' }] },
      { type: 'tool_result', toolCallId: 'stale', outcome: 'error' },
      // Behind a symlink `..` climbs out of the link's target, so the text names no file.
      { type: 'tool_use', toolCallId: 'climb', tool: 'Edit', edits: [{ path: '/notes/link/../climb.md', originPath: '/notes/climb.md' }] },
      { type: 'tool_result', toolCallId: 'climb', outcome: 'success' },
      { type: 'result', text: 'Done.' },
    ], []), { projectThreadTurns: { started: async () => undefined, ended } })

    await orchestrator.submitUserMessage(chatId, '@Sage note it')

    await until(() => ended.mock.calls.length === 1, 'the guard to see the turn end')
    expect(ended.mock.calls[0]?.[0]).toMatchObject({ shellWrites: ['/notes/ok.md'], editedPaths: ['/notes/edited.md'] })
  })

  it('stores observed memory reads and the separate model judgment on turn_result', async () => {
    const sourcePath = '/memory/structured/manor/runtime.md'
    const remembering = { ...sage, memoryScope: true, allowedTools: ['Read'] }
    const generateMemoryTrace = vi.fn<GenerateMemoryTrace>(async () => ({
      status: 'used',
      derivation: 'model',
      items: [{ text: 'Kept runtime work behind the driver seam.', sourcePath }],
    }))
    const { orchestrator, store, chatId, sent } = await harness(scripted(
      () => [
        { type: 'tool_use', toolCallId: 'read-1', tool: 'Read', targets: [sourcePath] },
        { type: 'tool_result', toolCallId: 'read-1', outcome: 'success' },
        { type: 'result', text: 'The driver seam stays provider-neutral.' },
      ],
      [],
    ), {
      agents: [remembering],
      memoryRoots: ['/memory'],
      generateMemoryTrace,
    })

    await orchestrator.submitUserMessage(chatId, '@Sage answer now')

    expect(generateMemoryTrace).toHaveBeenCalledWith({
      chatId,
      answer: 'The driver seam stays provider-neutral.',
      reads: [{ source: 'on_demand', path: sourcePath }],
    })
    await until(() => sent.some((message) => message.type === 'event' && message.event.type === 'turn_result'
      && message.event.memoryTrace !== undefined), 'the memory judgment')
    expect((await store.loadEvents(chatId)).find((event) => event.type === 'turn_result')).toMatchObject({
      memoryTrace: {
        reads: [{ source: 'on_demand', path: sourcePath }],
        summary: { status: 'used' },
      },
    })
  })

  it('bounds observed memory reads so a tool-heavy turn can still finish', async () => {
    const remembering = { ...sage, memoryScope: true, allowedTools: ['Read'] }
    const generateMemoryTrace = vi.fn<GenerateMemoryTrace>(async () => ({
      status: 'none',
      derivation: 'model',
    }))
    const reads = Array.from({ length: 101 }, (_, index): RuntimeEvent[] => [
      {
        type: 'tool_use',
        toolCallId: `read-${index}`,
        tool: 'Read',
        targets: [`/memory/${index}.md`],
      },
      { type: 'tool_result', toolCallId: `read-${index}`, outcome: 'success' },
    ]).flat()
    const { orchestrator, store, chatId, sent } = await harness(scripted(
      () => [...reads, { type: 'result', text: 'Finished the long pass.' }],
      [],
    ), { agents: [remembering], memoryRoots: ['/memory'], generateMemoryTrace })

    await orchestrator.submitUserMessage(chatId, '@Sage answer now')
    await until(() => sent.some((message) => message.type === 'event' && message.event.type === 'turn_result'
      && message.event.memoryTrace !== undefined), 'the memory judgment')

    const trace = (await store.loadEvents(chatId)).find((event) => event.type === 'turn_result')?.memoryTrace
    expect(trace?.reads).toHaveLength(100)
    expect(trace?.reads.at(-1)?.path).toBe('/memory/99.md')
    expect(generateMemoryTrace.mock.calls[0]?.[0].reads).toHaveLength(100)
  })

  it('closes the turn before the memory judgment returns, then attaches it to the result', async () => {
    const sourcePath = '/memory/structured/manor/runtime.md'
    const remembering = { ...sage, memoryScope: true, allowedTools: ['Read'] }
    let judge: (summary: Awaited<ReturnType<GenerateMemoryTrace>>) => void = () => undefined
    const generateMemoryTrace = vi.fn<GenerateMemoryTrace>(() => new Promise((resolve) => { judge = resolve }))
    const { orchestrator, store, chatId, sent } = await harness(scripted(
      () => [
        { type: 'tool_use', toolCallId: 'read-1', tool: 'Read', targets: [sourcePath] },
        { type: 'tool_result', toolCallId: 'read-1', outcome: 'success' },
        { type: 'result', text: 'Answered, with a question back?' },
      ],
      [],
    ), { agents: [remembering], memoryRoots: ['/memory'], generateMemoryTrace })

    await orchestrator.submitUserMessage(chatId, '@Sage answer now')

    // The judgment is still out, and the reply already reads as finished.
    expect(generateMemoryTrace).toHaveBeenCalledTimes(1)
    expect(sent.some((message) => message.type === 'turn_state' && message.state === 'done')).toBe(true)
    const closed = (await store.loadEvents(chatId)).find((event) => event.type === 'turn_result')
    expect(closed).toBeDefined()
    expect(closed?.type === 'turn_result' ? closed.memoryTrace : 'missing').toBeUndefined()

    judge({ status: 'used', derivation: 'model', items: [{ text: 'Kept the driver seam.', sourcePath }] })
    await until(() => sent.some((message) => message.type === 'event' && message.event.type === 'turn_result'
      && message.event.memoryTrace !== undefined), 'the memory judgment')
    const results = (await store.loadEvents(chatId)).filter((event) => event.type === 'turn_result')
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      id: closed?.id,
      memoryTrace: { reads: [{ source: 'on_demand', path: sourcePath }], summary: { status: 'used' } },
    })
  })

  it('keeps the late memory judgment and daily-log lines when both land on the same result', async () => {
    const remembering = { ...sage, memoryScope: true, allowedTools: ['Read'] }
    let judge: (summary: Awaited<ReturnType<GenerateMemoryTrace>>) => void = () => undefined
    let log: (change: Awaited<ReturnType<WriteDailyLog>>) => void = () => undefined
    const generateMemoryTrace = vi.fn<GenerateMemoryTrace>(() => new Promise((resolve) => { judge = resolve }))
    const writeDailyLog = vi.fn<WriteDailyLog>(() => new Promise((resolve) => { log = resolve }))
    const { orchestrator, store, chatId, sent } = await harness(scripted(
      () => [
        { type: 'tool_use', toolCallId: 'read-1', tool: 'Read', targets: ['/memory/note.md'] },
        { type: 'tool_result', toolCallId: 'read-1', outcome: 'success' },
        { type: 'result', text: 'Finished.' },
      ],
      [],
    ), { agents: [remembering], memoryRoots: ['/memory'], generateMemoryTrace, writeDailyLog })

    await orchestrator.submitUserMessage(chatId, '@Sage read the note')
    await until(() => writeDailyLog.mock.calls.length === 1, 'the daily-log writer')
    // Past the transcript cache, every load is a fresh copy that can go stale.
    await store.appendEvent(chatId, { type: 'user_message', text: 'x'.repeat(9 * 1024 * 1024), mentions: [] })
    judge({ status: 'used', derivation: 'model', items: [{ text: 'Used the note.', sourcePath: '/memory/note.md' }] })
    await Promise.resolve()
    log({ path: '/memory/daily.md', lines: [{ kind: 'added', text: '- [m/sage] Read the note.' }] })
    const patched = (field: 'memoryTrace' | 'memoryChanges') => sent.some((message) =>
      message.type === 'event' && message.event.type === 'turn_result' && message.event[field] !== undefined)
    await until(() => patched('memoryTrace') && patched('memoryChanges'), 'both late patches')

    const result = (await store.loadEvents(chatId)).find((event) => event.type === 'turn_result')
    expect(result).toHaveProperty('memoryTrace.summary.status', 'used')
    expect(result).toHaveProperty('memoryChanges')
  })

  it('records not_read without a model call when Memory is on but no source was opened', async () => {
    const remembering = { ...sage, memoryScope: true }
    const generateMemoryTrace = vi.fn<GenerateMemoryTrace>()
    const { orchestrator, store, chatId } = await harness(
      scripted(() => [{ type: 'result', text: 'No memory needed.' }], []),
      { agents: [remembering], memoryRoots: ['/memory'], generateMemoryTrace },
    )

    await orchestrator.submitUserMessage(chatId, '@Sage answer now')

    expect(generateMemoryTrace).not.toHaveBeenCalled()
    expect((await store.loadEvents(chatId)).find((event) => event.type === 'turn_result')).toMatchObject({
      memoryTrace: { reads: [], summary: { status: 'not_read', derivation: 'none' } },
    })
  })

  it('runs a Session without a project in the home room: the memory folder, and no project memory of its own', async () => {
    const structuredMemoryRoot = mkdtempSync(path.join(os.tmpdir(), 'manor-home-indexes-'))
    // A folder that the room's label would slug to. It belongs to nobody, so it must never load.
    await mkdir(path.join(structuredMemoryRoot, 'no-project'), { recursive: true })
    await writeFile(path.join(structuredMemoryRoot, 'MEMORY.md'), 'Route calendar questions.', 'utf8')
    await writeFile(path.join(structuredMemoryRoot, 'no-project/MEMORY.md'), 'Nobody owns this index.', 'utf8')
    const seen: TurnInput[] = []
    const { orchestrator, store } = await harness(scripted(() => [{ type: 'result', text: 'Done.' }], seen), {
      agents: [{ ...sage, memoryScope: false }],
      structuredMemoryRoot,
      memoryRoots: [structuredMemoryRoot],
    })
    await store.setHomeFolders(['/memory'])
    const session = await store.createChat({ projectId: 'home' })

    await orchestrator.submitUserMessage(session.id, '@Sage answer now')

    expect(seen[0]?.repoPaths).toEqual(['/memory'])
    // Memory is off for her, and the room has no project index: nothing is injected.
    expect(seen[0]?.agent.character).not.toContain('Nobody owns this index.')
    expect(seen[0]?.agent.character).not.toContain('Route calendar questions.')
  })

  it('injects and traces only the project index, leaving the root as a pointer', async () => {
    const structuredMemoryRoot = mkdtempSync(path.join(os.tmpdir(), 'manor-routing-indexes-'))
    await mkdir(path.join(structuredMemoryRoot, 'manor'), { recursive: true })
    await writeFile(path.join(structuredMemoryRoot, 'MEMORY.md'), 'Route calendar questions.', 'utf8')
    await writeFile(path.join(structuredMemoryRoot, 'manor/MEMORY.md'), 'Route Manor questions.', 'utf8')
    const remembering = { ...sage, memoryScope: true }
    const seen: TurnInput[] = []
    const generateMemoryTrace = vi.fn<GenerateMemoryTrace>(async () => ({
      status: 'none',
      derivation: 'model',
    }))
    const { orchestrator, store, chatId } = await harness(scripted(
      () => [{ type: 'result', text: 'Done.' }],
      seen,
    ), {
      agents: [remembering],
      structuredMemoryRoot,
      memoryRoots: [structuredMemoryRoot],
      generateMemoryTrace,
    })

    await asProject(store, chatId)
    await orchestrator.submitUserMessage(chatId, '@Sage answer now')

    expect(seen[0]?.agent.character).not.toContain('Route calendar questions.')
    expect(seen[0]?.agent.character).toContain(path.join(structuredMemoryRoot, 'MEMORY.md'))
    expect(seen[0]?.agent.character).toContain('Route Manor questions.')
    expect(generateMemoryTrace).toHaveBeenCalledWith({
      chatId,
      answer: 'Done.',
      reads: [
        { source: 'injected', path: path.join(structuredMemoryRoot, 'manor/MEMORY.md') },
      ],
      nonCitablePaths: [
        path.join(structuredMemoryRoot, 'manor/MEMORY.md'),
      ],
    })
    expect((await store.loadEvents(chatId)).find((event) => event.type === 'turn_result')).toMatchObject({
      memoryTrace: {
        reads: [
          { source: 'injected', path: path.join(structuredMemoryRoot, 'manor/MEMORY.md') },
        ],
      },
    })
  })

  it('reads memory in a folder the way No project does, whatever the folder is called', async () => {
    const structuredMemoryRoot = mkdtempSync(path.join(os.tmpdir(), 'manor-folder-room-'))
    await mkdir(path.join(structuredMemoryRoot, 'manor'), { recursive: true })
    await writeFile(path.join(structuredMemoryRoot, 'MEMORY.md'), 'Route calendar questions.', 'utf8')
    await writeFile(path.join(structuredMemoryRoot, 'manor/MEMORY.md'), 'Route Manor questions.', 'utf8')
    const seen: TurnInput[] = []
    // The seeded room is named Manor and has no thread: a folder.
    const { orchestrator, chatId } = await harness(scripted(() => [{ type: 'result', text: 'Done.' }], seen), {
      agents: [{ ...sage, memoryScope: true }],
      structuredMemoryRoot,
      memoryRoots: [structuredMemoryRoot],
    })

    await orchestrator.submitUserMessage(chatId, '@Sage answer now')

    expect(seen[0]?.agent.character).toContain('Route calendar questions.')
    expect(seen[0]?.agent.character).not.toContain('Route Manor questions.')
  })

  it('injects the root index in full once the room is set to knowledge work', async () => {
    const structuredMemoryRoot = mkdtempSync(path.join(os.tmpdir(), 'manor-knowledge-room-'))
    await mkdir(path.join(structuredMemoryRoot, 'manor'), { recursive: true })
    await writeFile(path.join(structuredMemoryRoot, 'MEMORY.md'), 'Route calendar questions.', 'utf8')
    await writeFile(path.join(structuredMemoryRoot, 'manor/MEMORY.md'), 'Route Manor questions.', 'utf8')
    const remembering = { ...sage, memoryScope: true }
    const seen: TurnInput[] = []
    const { orchestrator, store, chatId, projectId } = await harness(scripted(
      () => [{ type: 'result', text: 'Done.' }],
      seen,
    ), {
      agents: [remembering],
      structuredMemoryRoot,
      memoryRoots: [structuredMemoryRoot],
    })
    await asProject(store, chatId)
    await store.updateProject(projectId, 'Manor', [], undefined, undefined, 'knowledge')

    await orchestrator.submitUserMessage(chatId, '@Sage answer now')

    // The same fixture as the project-room test above, where the root stayed a pointer.
    expect(seen[0]?.agent.character).toContain('Route calendar questions.')
    expect(seen[0]?.agent.character).toContain('Route Manor questions.')
  })

  it.each([true, false])('retrieves from recent user messages and keeps evidence citable with personal memory %s', async (memoryScope) => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'manor-retrieval-context-'))
    await mkdir(path.join(root, 'manor'))
    await writeFile(path.join(root, 'MEMORY.md'), 'Root routing')
    await writeFile(path.join(root, 'manor/MEMORY.md'), ['cloud', 'ancient', 'poison'].map((term) => `- [${term}](${term}.md)`).join('\n'))
    for (const term of ['cloud', 'ancient', 'poison']) await writeFile(path.join(root, 'manor', `${term}.md`), `EVIDENCE_${term}`)
    const seen: TurnInput[] = []
    const generateMemoryTrace = vi.fn<GenerateMemoryTrace>(async () => ({ status: 'none', derivation: 'model' }))
    const { orchestrator, store, chatId } = await harness(scripted(() => [{ type: 'result', text: 'Done.' }], seen), {
      agents: [{ ...sage, memoryScope }, smith], structuredMemoryRoot: root, memoryRoots: [root], generateMemoryTrace,
    })
    await store.appendEvent(chatId, { type: 'user_message', text: 'ancient', mentions: [] })
    for (let index = 0; index < 6; index++) await store.appendEvent(chatId, { type: 'agent_message', agentId: 'smith', turnId: `old-${index}`, text: 'poison' })
    await store.appendEvent(chatId, { type: 'user_message', text: 'cloud', mentions: [] })
    await asProject(store, chatId)
    await orchestrator.submitUserMessage(chatId, '@Sage continue')
    expect(handed(seen[0])).toContain('EVIDENCE_cloud')
    expect(handed(seen[0])).not.toContain('EVIDENCE_ancient')
    expect(handed(seen[0])).not.toContain('EVIDENCE_poison')
    expect(generateMemoryTrace).toHaveBeenCalledWith(expect.objectContaining({
      reads: expect.arrayContaining([{ source: 'injected', path: path.join(root, 'manor/cloud.md') }]),
      nonCitablePaths: [path.join(root, 'manor/MEMORY.md')],
    }))
    await writeFile(path.join(root, 'manor/cloud.md'), 'UPDATED PROJECT EVIDENCE')
    await orchestrator.submitUserMessage(chatId, '@Smith cloud')
    expect(seen.at(-1)?.agent.id).toBe('smith')
    expect(handed(seen.at(-1))).toContain('UPDATED PROJECT EVIDENCE')
    expect(seen.at(-1)?.agent.character).not.toContain(path.join(root, 'MEMORY.md'))
    const dm = await store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })
    await orchestrator.submitUserMessage(dm.id, 'cloud')
    expect(seen.at(-1)?.agent.character).not.toContain('EVIDENCE_cloud')
    expect(seen.at(-1)?.agent.character.includes('Root routing')).toBe(memoryScope)
  })

  it('shares one rank for personas on the same message, refreshes later messages, and leaves DMs unranked', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'manor-jev-turns-'))
    await mkdir(path.join(root, 'manor'))
    await writeFile(path.join(root, 'MEMORY.md'), 'Personal root index')
    await writeFile(path.join(root, 'manor/MEMORY.md'), '- [Cloud](cloud.md)\n- [Mail](mail.md)')
    await writeFile(path.join(root, 'manor/cloud.md'), 'CLOUD_EVIDENCE')
    await writeFile(path.join(root, 'manor/mail.md'), 'MAIL_EVIDENCE')
    const rankStructuredMemory = vi.fn<NonNullable<OrchestratorOptions['rankStructuredMemory']>>()
      .mockResolvedValueOnce([0.9, 0]).mockResolvedValueOnce([0, 0])
      .mockRejectedValueOnce(new Error('offline'))
    const seen: TurnInput[] = []
    const { orchestrator, store, chatId } = await harness(scripted(() => [{ type: 'result', text: 'Done.' }], seen), {
      agents: [{ ...sage, memoryScope: true }, { ...smith, memoryScope: false }],
      structuredMemoryRoot: root, rankStructuredMemory,
    })
    await asProject(store, chatId)
    await orchestrator.submitUserMessage(chatId, '@Sage @Smith cloud')
    expect(rankStructuredMemory).toHaveBeenCalledTimes(1)
    expect(handed(seen[0])).toContain('CLOUD_EVIDENCE')
    expect(handed(seen[1])).toContain('CLOUD_EVIDENCE')
    expect(handed(seen[1])).not.toContain('Personal root index')
    await orchestrator.submitUserMessage(chatId, '@Sage ja')
    expect(rankStructuredMemory).toHaveBeenCalledTimes(2)
    expect(rankStructuredMemory.mock.calls[1]?.[0]).toBe('@Sage @Smith cloud\n@Sage ja')
    expect(seen.at(-1)?.agent.character).not.toContain('CLOUD_EVIDENCE')
    expect(seen.at(-1)?.agent.character).not.toContain('MAIL_EVIDENCE')
    await orchestrator.submitUserMessage(chatId, '@Smith cloud')
    expect(rankStructuredMemory).toHaveBeenCalledTimes(3)
    // A refused ranking leaves the index empty-handed rather than handing the turn
    // whatever word overlap liked; the persona can still open the file itself.
    expect(seen.at(-1)?.agent.character).not.toContain('CLOUD_EVIDENCE')
    expect(seen.at(-1)?.agent.character).not.toContain('MAIL_EVIDENCE')
    for (const id of ['sage', 'smith']) {
      const dm = await store.createChat({ kind: 'dm', memberIds: [id], title: id })
      await orchestrator.submitUserMessage(dm.id, 'cloud')
    }
    const side = await store.sideChatFor(chatId)
    await orchestrator.submitUserMessage(side.id, 'cloud')
    expect(rankStructuredMemory).toHaveBeenCalledTimes(3)
  })

  it('keeps the same memory question for two personas after six user messages', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'manor-jev-shared-question-'))
    await mkdir(path.join(root, 'manor'))
    await writeFile(path.join(root, 'manor/MEMORY.md'), '- [Cloud](cloud.md)\n- [Mail](mail.md)')
    await writeFile(path.join(root, 'manor/cloud.md'), 'CLOUD_EVIDENCE')
    await writeFile(path.join(root, 'manor/mail.md'), 'MAIL_EVIDENCE')
    const rankStructuredMemory = vi.fn<NonNullable<OrchestratorOptions['rankStructuredMemory']>>()
      .mockImplementation(async (request) => request.includes('cloud') ? [0.9, 0] : [0, 0.9])
    const seen: TurnInput[] = []
    const { orchestrator, store, chatId } = await harness(scripted(() => [{ type: 'result', text: 'Done.' }], seen), {
      agents: [{ ...sage, memoryScope: true }, { ...smith, memoryScope: true }],
      structuredMemoryRoot: root, rankStructuredMemory,
    })
    for (const text of ['cloud', 'first', 'second', 'third', 'fourth']) {
      await store.appendEvent(chatId, { type: 'user_message', text, mentions: [] })
    }

    await orchestrator.submitUserMessage(chatId, '@Sage @Smith continue')

    expect(seen.map((turn) => turn.agent.id)).toEqual(['sage', 'smith'])
    expect(handed(seen[0])).toContain('CLOUD_EVIDENCE')
    expect(handed(seen[1])).toContain('CLOUD_EVIDENCE')
    expect(rankStructuredMemory).toHaveBeenCalledTimes(1)
  })

  it('starts memory ranking while Auto is still selecting the runtime', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'manor-parallel-prep-'))
    await mkdir(path.join(root, 'manor'))
    await writeFile(path.join(root, 'manor/MEMORY.md'), '- [Cloud](cloud.md)')
    await writeFile(path.join(root, 'manor/cloud.md'), 'CLOUD_EVIDENCE')
    let selectedAt = 0
    let rankedAt = 0
    const selectAutoRuntime: NonNullable<OrchestratorOptions['selectAutoRuntime']> = async () => {
      await new Promise((resolve) => setTimeout(resolve, 200))
      selectedAt = performance.now()
      return { reason: 'defer' }
    }
    const rankStructuredMemory: NonNullable<OrchestratorOptions['rankStructuredMemory']> = async () => {
      rankedAt = performance.now()
      await new Promise((resolve) => setTimeout(resolve, 200))
      return [0.9]
    }
    const { orchestrator, chatId } = await harness(scripted(() => [{ type: 'result', text: 'Done.' }], []), {
      agents: [{ ...sage, driver: 'claude', memoryScope: true }], structuredMemoryRoot: root,
      selectAutoRuntime, rankStructuredMemory,
    })
    await orchestrator.submitUserMessage(chatId, '@Sage cloud')
    expect(rankedAt).toBeGreaterThan(0)
    expect(rankedAt).toBeLessThan(selectedAt)
  })

  it('keeps queued later input out of the current memory question', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'manor-jev-pending-'))
    await mkdir(path.join(root, 'manor'))
    await writeFile(path.join(root, 'manor/MEMORY.md'), '- [Cloud](cloud.md)\n- [Mail](mail.md)')
    await writeFile(path.join(root, 'manor/cloud.md'), 'CLOUD_EVIDENCE')
    await writeFile(path.join(root, 'manor/mail.md'), 'MAIL_EVIDENCE')
    const rankStructuredMemory = vi.fn<NonNullable<OrchestratorOptions['rankStructuredMemory']>>()
      .mockResolvedValue([0.9, 0])
    const { orchestrator, store, chatId } = await harness(scripted(() => [{ type: 'result', text: 'Done.' }], []), {
      agents: [{ ...sage, memoryScope: true }], structuredMemoryRoot: root, rankStructuredMemory,
    })
    await store.appendEvent(chatId, { type: 'user_message', text: 'later queued question', mentions: [], dispatchState: 'pending' })
    await orchestrator.submitUserMessage(chatId, '@Sage current question')
    expect(rankStructuredMemory.mock.calls[0]?.[0]).toBe('@Sage current question')
    expect(rankStructuredMemory.mock.calls[0]?.[3]).toBe('@Sage current question')
  })

  it('drops a failed read before deciding that nothing was read', async () => {
    const remembering = { ...sage, memoryScope: true, allowedTools: ['Read'] }
    const generateMemoryTrace = vi.fn<GenerateMemoryTrace>()
    const { orchestrator, store, chatId } = await harness(scripted(
      () => [
        { type: 'tool_use', toolCallId: 'read-1', tool: 'Read', targets: ['/memory/a.md'] },
        { type: 'tool_result', toolCallId: 'read-1', outcome: 'error' },
        { type: 'result', text: 'Could not read it.' },
      ],
      [],
    ), { agents: [remembering], memoryRoots: ['/memory'], generateMemoryTrace })

    await orchestrator.submitUserMessage(chatId, '@Sage answer now')

    expect(generateMemoryTrace).not.toHaveBeenCalled()
    expect((await store.loadEvents(chatId)).find((event) => event.type === 'turn_result')).toMatchObject({
      memoryTrace: { reads: [], summary: { status: 'not_read' } },
    })
  })

  it('injects standing notes for a Memory-on persona and traces them as a start read', async () => {
    const memoryDir = mkdtempSync(path.join(os.tmpdir(), 'manor-agent-notes-'))
    const notesPath = path.join(memoryDir, 'memory/agents/sage.md')
    await mkdir(path.dirname(notesPath), { recursive: true })
    await writeFile(notesPath, 'Coach on career questions, do not answer them.\n', 'utf8')
    const remembering = { ...sage, memoryScope: true }
    const seen: TurnInput[] = []
    const generateMemoryTrace = vi.fn<GenerateMemoryTrace>(async () => ({
      status: 'none',
      derivation: 'model',
    }))
    const { orchestrator, store, chatId } = await harness(scripted(
      () => [{ type: 'result', text: 'Done.' }],
      seen,
    ), {
      agents: [remembering],
      memoryTarget: { dailyDir: path.join(memoryDir, 'memory/daily') },
      memoryRoots: [memoryDir],
      generateMemoryTrace,
    })

    await orchestrator.submitUserMessage(chatId, '@Sage answer now')

    expect(seen[0]?.agent.character).toContain('Coach on career questions, do not answer them.')
    expect(seen[0]?.agent.character).toContain(notesPath)
    expect(generateMemoryTrace).toHaveBeenCalledWith({
      chatId,
      answer: 'Done.',
      reads: [{ source: 'injected', path: notesPath }],
    })
    expect((await store.loadEvents(chatId)).find((event) => event.type === 'turn_result')).toMatchObject({
      memoryTrace: { reads: [{ source: 'injected', path: notesPath }] },
      contextEstimate: { memory: expect.any(Number) },
    })
    const reading = (await store.loadEvents(chatId)).find((event) => event.type === 'turn_result')
    expect(reading?.type === 'turn_result' ? reading.contextEstimate?.memory : undefined).toBeGreaterThan(0)
  })

  it('tells every persona the name on the profile, and says nothing when there is none', async () => {
    const seen: TurnInput[] = []
    const named = await harness(scripted(() => [{ type: 'result', text: 'Done.' }], seen), { userName: () => ' Robin ' })
    await named.orchestrator.submitUserMessage(named.chatId, '@Sage answer now')
    expect(seen[0]?.agent.character).toContain("[Manor] The user's name is Robin.")

    const unnamed = await harness(scripted(() => [{ type: 'result', text: 'Done.' }], seen), { userName: () => undefined })
    await unnamed.orchestrator.submitUserMessage(unnamed.chatId, '@Sage answer now')
    expect(seen[1]?.agent.character).not.toContain("The user's name is")
  })

  it('gives a Memory-on persona the standing files from the memory folder', async () => {
    const folder = mkdtempSync(path.join(os.tmpdir(), 'manor-standing-'))
    await writeFile(path.join(folder, 'soul.md'), 'Lead with the answer.\n', 'utf8')
    const seen: TurnInput[] = []
    const { orchestrator, chatId } = await harness(scripted(() => [{ type: 'result', text: 'Done.' }], seen), {
      agents: [{ ...sage, memoryScope: true }],
      memoryTarget: { dailyDir: path.join(folder, 'memory/daily') },
      memoryRoots: [folder],
    })

    await orchestrator.submitUserMessage(chatId, '@Sage answer now')

    expect(seen[0]?.agent.character).toContain('Standing context from the memory folder')
    expect(seen[0]?.agent.character).toContain('Lead with the answer.')
  })

  it('emits no trace or model call in a DM when Memory is off', async () => {
    const structuredMemoryRoot = mkdtempSync(path.join(os.tmpdir(), 'manor-routing-indexes-off-'))
    await writeFile(path.join(structuredMemoryRoot, 'MEMORY.md'), 'MUST NOT REACH THE PROMPT', 'utf8')
    const memoryDir = mkdtempSync(path.join(os.tmpdir(), 'manor-notes-off-'))
    const notesPath = path.join(memoryDir, 'memory/agents/sage.md')
    await mkdir(path.dirname(notesPath), { recursive: true })
    await writeFile(notesPath, 'MUST NOT REACH NOTES', 'utf8')
    await writeFile(path.join(memoryDir, 'soul.md'), 'MUST NOT REACH STANDING', 'utf8')
    const generateMemoryTrace = vi.fn<GenerateMemoryTrace>()
    const seen: TurnInput[] = []
    const { orchestrator, store } = await harness(scripted(
      () => [
        { type: 'tool_use', toolCallId: 'read-1', tool: 'Read', targets: ['/memory/a.md'] },
        { type: 'tool_result', toolCallId: 'read-1', outcome: 'success' },
        { type: 'result', text: 'Read it.' },
      ],
      seen,
    ), {
      memoryRoots: ['/memory', memoryDir],
      structuredMemoryRoot,
      memoryTarget: { dailyDir: path.join(memoryDir, 'memory/daily') },
      generateMemoryTrace,
    })

    const { id: chatId } = await store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })
    await orchestrator.submitUserMessage(chatId, '@Sage answer now')

    expect(generateMemoryTrace).not.toHaveBeenCalled()
    expect(seen[0]?.agent.character).not.toContain('MUST NOT REACH THE PROMPT')
    expect(seen[0]?.agent.character).not.toContain('MUST NOT REACH NOTES')
    expect(seen[0]?.agent.character).not.toContain('MUST NOT REACH STANDING')
    expect((await store.loadEvents(chatId)).find((event) => event.type === 'turn_result')).not.toHaveProperty('memoryTrace')
    expect((await store.loadEvents(chatId)).find((event) => event.type === 'turn_result')).toMatchObject({
      contextEstimate: { memory: 0 },
    })
  })

  it('logs the chain once afterwards and keeps memory edits out of the file changes', async () => {
    const memoryDir = mkdtempSync(path.join(os.tmpdir(), 'manor-writer-'))
    const dailyDir = path.join(memoryDir, 'memory/daily')
    const notes = path.join(memoryDir, 'memory/agents/sage.md')
    const daily = path.join(dailyDir, '2026-09-28.md')
    const writeDailyLog = vi.fn<WriteDailyLog>(async () => ({
      path: daily,
      lines: [{ kind: 'added', text: '- [m/sage] Chose medium effort for chat.' }],
    }))
    const { orchestrator, store, sent } = await harness(scripted(
      () => [
        {
          type: 'tool_use', toolCallId: 'edit-1', tool: 'Edit', targets: [notes],
          edits: [{ path: notes, originPath: notes, before: '- old note', after: '- new note' }],
        },
        { type: 'tool_result', toolCallId: 'edit-1', outcome: 'success' },
        { type: 'result', text: 'Medium it is.' },
      ],
      [],
    ), {
      agents: [{ ...sage, memoryScope: true }],
      memoryTarget: { dailyDir },
      writeDailyLog,
    })
    const { id: chatId } = await store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })

    await orchestrator.submitUserMessage(chatId, 'Which effort for chat?')
    await until(() => sent.some((message) => message.type === 'event' &&
      message.event.type === 'turn_result' && message.event.memoryChanges?.length === 2), 'the writer lines to land on the turn')

    expect(writeDailyLog).toHaveBeenCalledTimes(1)
    expect(writeDailyLog).toHaveBeenCalledWith({
      key: expect.any(String),
      chatId,
      userText: 'Which effort for chat?',
      turns: [{ prefix: 'm/sage', name: 'Sage', answer: 'Medium it is.', tools: [`- Edit ${notes}`] }],
    })
    const result = (await store.loadEvents(chatId)).find((event) => event.type === 'turn_result')
    expect(result).toMatchObject({
      memoryChanges: [
        { path: notes, lines: [{ kind: 'replaced', before: '- old note', after: '- new note' }] },
        { path: daily, lines: [{ kind: 'added', text: '- [m/sage] Chose medium effort for chat.' }] },
      ],
    })
  })

  it('runs no daily-log writer for a persona with Memory off', async () => {
    const memoryDir = mkdtempSync(path.join(os.tmpdir(), 'manor-writer-off-'))
    const writeDailyLog = vi.fn<WriteDailyLog>()
    const advanceChatSummary = vi.fn(async () => true)
    const { orchestrator, store } = await harness(scripted(() => [{ type: 'result', text: 'Done.' }], []), {
      memoryTarget: { dailyDir: path.join(memoryDir, 'memory/daily') },
      writeDailyLog,
      advanceChatSummary,
    })
    const { id: chatId } = await store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })

    await orchestrator.submitUserMessage(chatId, 'Anything')
    await until(() => advanceChatSummary.mock.calls.length > 0, 'the turn to settle')

    expect(writeDailyLog).not.toHaveBeenCalled()
  })

  it('never waits for a hanging summary advance after the visible turn settles', async () => {
    const advanceChatSummary = vi.fn(() => new Promise<boolean>(() => undefined))
    const { orchestrator, chatId } = await harness(
      createMockDriver({ deltaDelayMs: 0 }),
      { advanceChatSummary },
    )

    await expect(orchestrator.submitUserMessage(chatId, '@Sage answer now')).resolves.toBeUndefined()
    await until(() => advanceChatSummary.mock.calls.length === 1, 'the summary job to start')
  })

  it('starts a fresh persona from the shared summary and its exact verbatim tail', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, store, chatId } = await harness(
      recording(createMockDriver({ deltaDelayMs: 0 }), seen),
    )
    const first = await store.appendEvent(chatId, {
      type: 'user_message',
      text: 'The old question.',
      mentions: [],
    })
    await store.appendEvent(chatId, {
      type: 'agent_message',
      agentId: 'smith',
      turnId: 'turn_old',
      text: 'The still-verbatim answer.',
    })
    await store.setChatSummary(chatId, 'The old question was settled.', first.id)

    await orchestrator.submitUserMessage(chatId, '@Sage what changed?')

    expect(seen[0]?.catchUpSummary).toEqual({
      text: 'The old question was settled.',
      throughEventId: first.id,
      retainedEvidence: expect.stringContaining('The old question.'),
    })
    expect(seen[0]?.catchUp.map((event) => event.id)).not.toContain(first.id)
    expect(seen[0]?.catchUp.some(
      (event) => event.type === 'agent_message' && event.text === 'The still-verbatim answer.',
    )).toBe(true)
    expect(seen[0]?.catchUp.at(-1)).toMatchObject({ type: 'user_message', text: '@Sage what changed?' })
  })

  it('rolls an oversized legacy session once, then resumes from its persisted seed cursor', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, store, chatId } = await harness(
      scripted(() => [{ type: 'result', text: 'Fresh answer.', sessionId: 'rollover-session' }], seen),
    )
    await store.appendEvent(chatId, {
      type: 'user_message',
      text: 'x'.repeat(SESSION_CEILING_CHARS),
      mentions: ['sage'],
    })
    await store.appendEvent(chatId, {
      type: 'agent_message',
      agentId: 'sage',
      turnId: 'turn_old',
      text: 'Old answer.',
    })
    const through = await store.appendEvent(chatId, {
      type: 'turn_result',
      agentId: 'sage',
      turnId: 'turn_old',
    })
    await store.setChatSummary(chatId, 'The oversized old turn was settled.', through.id)
    await store.setSession(chatId, 'sage', 'bloated-session', { driver: 'mock' })

    await orchestrator.submitUserMessage(chatId, '@Sage answer from shared context')

    expect(seen[0]?.sessionId).toBeUndefined()
    expect(seen[0]?.isFullCatchUp).toBe(true)
    expect(seen[0]?.catchUpSummary).toEqual({
      text: 'The oversized old turn was settled.',
      throughEventId: through.id,
    })
    expect(seen[0]?.catchUp).toHaveLength(1)
    const rolledOver = (await store.getSessions(chatId, 'sage')).find((held) => held.driver === 'mock')
    expect(rolledOver).toMatchObject({
      sessionId: 'rollover-session',
      driver: 'mock',
    })
    expect(rolledOver?.seededThroughEventId).toBe(seen[0]?.catchUp.at(-1)?.id)

    await orchestrator.submitUserMessage(chatId, '@Sage keep going')

    expect(seen[1]?.sessionId).toBe('rollover-session')
    expect(seen[1]?.isFullCatchUp).toBe(false)

    await orchestrator.submitUserMessage(chatId, `@Sage ${'n'.repeat(SESSION_CEILING_CHARS)}`)

    expect(seen[2]?.sessionId).toBeUndefined()
    expect(seen[2]?.isFullCatchUp).toBe(true)
  })

  it('moves the seed to now when the provider compacted its own history during the turn', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, store, chatId } = await harness(
      scripted(() => [{ type: 'result', text: 'Compacted.', sessionId: 'kept-session', compacted: true }], seen),
    )
    const seeded = await store.appendEvent(chatId, { type: 'user_message', text: '@Sage read the repo', mentions: ['sage'] })
    await store.setSession(chatId, 'sage', 'kept-session', { driver: 'mock', seededThroughEventId: seeded.id })

    await orchestrator.submitUserMessage(chatId, '@Sage and now?')

    const events = await store.loadEvents(chatId)
    const held = (await store.getSessions(chatId, 'sage')).find((row) => row.sessionId === 'kept-session')
    expect(held?.seededThroughEventId).not.toBe(seeded.id)
    // The cursor moves while the turn is being finished, so the turn's own result lands
    // after it and the session still reports how full it is. A seed that swallowed that
    // result would blind the rollover check in `turnContext`.
    const after = events.slice(events.findIndex((event) => event.id === held?.seededThroughEventId) + 1)
    expect(after.map((event) => event.type)).toContain('turn_result')
  })

  it('rolls a session whose last turn reported a nearly full context, however small the canon', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, store, chatId } = await harness(
      scripted(() => [{ type: 'result', text: 'Fresh answer.', sessionId: 'rollover-session' }], seen),
    )
    const window = contextWindowFor('mock', sage.model)
    const seeded = await store.appendEvent(chatId, { type: 'user_message', text: '@Sage read the repo', mentions: ['sage'] })
    await store.setSession(chatId, 'sage', 'bloated-session', { driver: 'mock', seededThroughEventId: seeded.id })
    await store.appendEvent(chatId, { type: 'agent_message', agentId: 'sage', turnId: 'turn_old', text: 'Read it.' })
    await store.appendEvent(chatId, {
      type: 'turn_result',
      agentId: 'sage',
      turnId: 'turn_old',
      contextTokens: Math.ceil(window * SESSION_CONTEXT_FRACTION),
    })

    await orchestrator.submitUserMessage(chatId, '@Sage and now?')

    expect(seen[0]?.sessionId).toBeUndefined()
    expect(seen[0]?.isFullCatchUp).toBe(true)
    expect((await store.getSessions(chatId, 'sage')).map((held) => held.sessionId)).toEqual(['rollover-session'])
  })

  it.each([
    { name: 'a 1m window at the token cap', window: 1_000_000, tokens: SESSION_CONTEXT_TOKEN_CAP, rolls: true },
    { name: 'a 1m window just under the token cap', window: 1_000_000, tokens: SESSION_CONTEXT_TOKEN_CAP - 1, rolls: false },
    { name: 'a 258k window at the fraction, under the cap', window: 258_000, tokens: Math.ceil(258_000 * SESSION_CONTEXT_FRACTION), rolls: true },
    { name: 'a 258k window just under the fraction', window: 258_000, tokens: Math.floor(258_000 * SESSION_CONTEXT_FRACTION) - 1, rolls: false },
  ])('rolls a rollover room on the earlier of fraction and token cap: $name', async ({ window, tokens, rolls }) => {
    const seen: TurnInput[] = []
    const { orchestrator, store, chatId } = await harness(
      scripted(() => [{ type: 'result', text: 'Answer.', sessionId: 'next-session' }], seen),
    )
    const seeded = await store.appendEvent(chatId, { type: 'user_message', text: '@Sage read the repo', mentions: ['sage'] })
    await store.setSession(chatId, 'sage', 'kept-session', { driver: 'mock', seededThroughEventId: seeded.id })
    await store.appendEvent(chatId, { type: 'agent_message', agentId: 'sage', turnId: 'turn_old', text: 'Read it.' })
    await store.appendEvent(chatId, {
      type: 'turn_result',
      agentId: 'sage',
      turnId: 'turn_old',
      contextTokens: tokens,
      contextWindow: window,
    })

    await orchestrator.submitUserMessage(chatId, '@Sage and now?')

    expect(seen[0]?.sessionId).toBe(rolls ? undefined : 'kept-session')
    expect(seen[0]?.isFullCatchUp).toBe(rolls)
  })

  it('compacts a Single Work session in place at the window fraction', async () => {
    const seen: TurnInput[] = []
    let compacted = 0
    const { orchestrator, store, projectId } = await harness(liveCompactDriver(seen, () => {
      compacted += 1
      return true
    }))
    const chat = await store.createChat({ projectId, mode: 'single' })
    const window = contextWindowFor('claude', defaultModel('claude'))
    const seeded = await store.appendEvent(chat.id, { type: 'user_message', text: 'read the repo', mentions: [] })
    await store.setSession(chat.id, SINGLE_CHAT_VOICE.id, 'live-session', {
      driver: 'claude',
      seededThroughEventId: seeded.id,
    })
    await store.appendEvent(chat.id, { type: 'agent_message', agentId: SINGLE_CHAT_VOICE.id, turnId: 'turn_old', text: 'Read it.' })
    await store.appendEvent(chat.id, {
      type: 'turn_result',
      agentId: SINGLE_CHAT_VOICE.id,
      turnId: 'turn_old',
      contextTokens: Math.ceil(window * LIVE_COMPACT_CONTEXT_FRACTION),
    })

    await orchestrator.submitUserMessage(chat.id, 'and now?')

    expect(compacted).toBe(1)
    expect(seen[0]?.sessionId).toBe('live-session')
    expect(seen[0]?.isFullCatchUp).toBe(false)
    expect((await store.getSessions(chat.id, SINGLE_CHAT_VOICE.id)).map((held) => held.sessionId)).toEqual(['live-session'])
    expect((await store.loadEvents(chat.id)).filter((event) => event.type === 'system_note')).toEqual([
      expect.objectContaining({ type: 'system_note', kind: 'info', text: LIVE_COMPACT_DONE }),
    ])
  })

  it('compacts Single Work against the CLI-reported window, not the catalog', async () => {
    const seen: TurnInput[] = []
    let compacted = 0
    const { orchestrator, store, projectId } = await harness(liveCompactDriver(seen, () => {
      compacted += 1
      return true
    }))
    const chat = await store.createChat({ projectId, mode: 'single' })
    const reportedWindow = 100_000
    const seeded = await store.appendEvent(chat.id, { type: 'user_message', text: 'read the repo', mentions: [] })
    await store.setSession(chat.id, SINGLE_CHAT_VOICE.id, 'live-session', {
      driver: 'claude',
      seededThroughEventId: seeded.id,
    })
    await store.appendEvent(chat.id, { type: 'agent_message', agentId: SINGLE_CHAT_VOICE.id, turnId: 'turn_old', text: 'Read it.' })
    await store.appendEvent(chat.id, {
      type: 'turn_result',
      agentId: SINGLE_CHAT_VOICE.id,
      turnId: 'turn_old',
      contextTokens: Math.ceil(reportedWindow * LIVE_COMPACT_CONTEXT_FRACTION),
      contextWindow: reportedWindow,
    })

    await orchestrator.submitUserMessage(chat.id, 'and now?')

    expect(compacted).toBe(1)
    expect(seen[0]?.sessionId).toBe('live-session')
  })

  it.each([
    { name: 'at the window fraction', window: undefined, fraction: SESSION_CONTEXT_FRACTION },
    { name: 'at the token cap on a 1m window', window: 1_000_000, fraction: SESSION_CONTEXT_TOKEN_CAP / 1_000_000 },
  ])('rolls the project thread over like a DM $name, seeded from the summary, never compacting', async ({ window: reported, fraction }) => {
    const seen: TurnInput[] = []
    let compacted = 0
    const { orchestrator, store, projectId } = await harness(liveCompactDriver(seen, () => {
      compacted += 1
      return true
    }))
    const thread = await store.createChat({ kind: 'project', projectId, mode: 'single' })
    await store.setProjectThread(projectId, thread.id)
    const window = reported ?? contextWindowFor('claude', defaultModel('claude'))
    const seeded = await store.appendEvent(thread.id, { type: 'user_message', text: 'remember the corners', mentions: [] })
    await store.setSession(thread.id, SINGLE_CHAT_VOICE.id, 'thread-session', {
      driver: 'claude',
      seededThroughEventId: seeded.id,
    })
    await store.appendEvent(thread.id, { type: 'agent_message', agentId: SINGLE_CHAT_VOICE.id, turnId: 'turn_old', text: 'Noted.' })
    const through = await store.appendEvent(thread.id, {
      type: 'turn_result',
      agentId: SINGLE_CHAT_VOICE.id,
      turnId: 'turn_old',
      contextTokens: Math.ceil(window * fraction),
      ...(reported === undefined ? {} : { contextWindow: reported }),
    })
    await store.setChatSummary(thread.id, 'Corners are always round.', through.id)

    await orchestrator.submitUserMessage(thread.id, 'and now?')

    expect(compacted).toBe(0)
    expect(seen[0]?.sessionId).toBeUndefined()
    expect(seen[0]?.isFullCatchUp).toBe(true)
    expect(seen[0]?.catchUpSummary).toMatchObject({ text: 'Corners are always round.', throughEventId: through.id })
    expect((await store.getSessions(thread.id, SINGLE_CHAT_VOICE.id)).map((held) => held.sessionId)).toEqual(['fresh-session'])
    expect((await store.loadEvents(thread.id)).some((event) => event.type === 'system_note')).toBe(false)
  })

  it('still live-compacts a Single session in a project that has a thread', async () => {
    const seen: TurnInput[] = []
    let compacted = 0
    const { orchestrator, store, projectId } = await harness(liveCompactDriver(seen, () => {
      compacted += 1
      return true
    }))
    const thread = await store.createChat({ kind: 'project', projectId, mode: 'single' })
    await store.setProjectThread(projectId, thread.id)
    const session = await store.createChat({ kind: 'project', projectId, mode: 'single' })
    const window = contextWindowFor('claude', defaultModel('claude'))
    const seeded = await store.appendEvent(session.id, { type: 'user_message', text: 'read the repo', mentions: [] })
    await store.setSession(session.id, SINGLE_CHAT_VOICE.id, 'live-session', {
      driver: 'claude',
      seededThroughEventId: seeded.id,
    })
    await store.appendEvent(session.id, { type: 'agent_message', agentId: SINGLE_CHAT_VOICE.id, turnId: 'turn_old', text: 'Read it.' })
    await store.appendEvent(session.id, {
      type: 'turn_result',
      agentId: SINGLE_CHAT_VOICE.id,
      turnId: 'turn_old',
      contextTokens: Math.ceil(window * LIVE_COMPACT_CONTEXT_FRACTION),
    })

    await orchestrator.submitUserMessage(session.id, 'and now?')

    expect(compacted).toBe(1)
    expect(seen[0]?.sessionId).toBe('live-session')
  })

  it('does not live-compact Single Work at the rollover fraction', async () => {
    const seen: TurnInput[] = []
    let compacted = 0
    const { orchestrator, store, projectId } = await harness(liveCompactDriver(seen, () => {
      compacted += 1
      return true
    }))
    const chat = await store.createChat({ projectId, mode: 'single' })
    const window = contextWindowFor('claude', defaultModel('claude'))
    const seeded = await store.appendEvent(chat.id, { type: 'user_message', text: 'read the repo', mentions: [] })
    await store.setSession(chat.id, SINGLE_CHAT_VOICE.id, 'live-session', {
      driver: 'claude',
      seededThroughEventId: seeded.id,
    })
    await store.appendEvent(chat.id, { type: 'agent_message', agentId: SINGLE_CHAT_VOICE.id, turnId: 'turn_old', text: 'Read it.' })
    await store.appendEvent(chat.id, {
      type: 'turn_result',
      agentId: SINGLE_CHAT_VOICE.id,
      turnId: 'turn_old',
      contextTokens: Math.ceil(window * SESSION_CONTEXT_FRACTION),
    })

    await orchestrator.submitUserMessage(chat.id, 'and now?')

    expect(compacted).toBe(0)
    expect(seen[0]?.sessionId).toBe('live-session')
    expect(seen[0]?.isFullCatchUp).toBe(false)
  })

  it('rolls Single Work over when live compact fails', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, store, projectId } = await harness(liveCompactDriver(seen, () => false))
    const chat = await store.createChat({ projectId, mode: 'single' })
    const window = contextWindowFor('claude', defaultModel('claude'))
    const seeded = await store.appendEvent(chat.id, { type: 'user_message', text: 'read the repo', mentions: [] })
    await store.setSession(chat.id, SINGLE_CHAT_VOICE.id, 'live-session', {
      driver: 'claude',
      seededThroughEventId: seeded.id,
    })
    await store.appendEvent(chat.id, { type: 'agent_message', agentId: SINGLE_CHAT_VOICE.id, turnId: 'turn_old', text: 'Read it.' })
    await store.appendEvent(chat.id, {
      type: 'turn_result',
      agentId: SINGLE_CHAT_VOICE.id,
      turnId: 'turn_old',
      contextTokens: Math.ceil(window * LIVE_COMPACT_CONTEXT_FRACTION),
    })

    await orchestrator.submitUserMessage(chat.id, 'and now?')

    expect(seen[0]?.sessionId).toBeUndefined()
    expect(seen[0]?.isFullCatchUp).toBe(true)
    expect((await store.getSessions(chat.id, SINGLE_CHAT_VOICE.id)).map((held) => held.sessionId)).toEqual(['fresh-session'])
    expect((await store.loadEvents(chat.id)).filter((event) => event.type === 'system_note')).toEqual([
      expect.objectContaining({ type: 'system_note', kind: 'info', text: LIVE_COMPACT_FAILED }),
    ])
  })

  it('shows a live compact note that settles when the hook finishes', async () => {
    const seen: TurnInput[] = []
    let release = () => {}
    const held = new Promise<void>((resolve) => { release = resolve })
    const { orchestrator, store, projectId, sent } = await harness(
      liveCompactDriver(seen, () => true, undefined, held),
    )
    const chat = await store.createChat({ projectId, mode: 'single' })
    const window = contextWindowFor('claude', defaultModel('claude'))
    const seeded = await store.appendEvent(chat.id, { type: 'user_message', text: 'read the repo', mentions: [] })
    await store.setSession(chat.id, SINGLE_CHAT_VOICE.id, 'live-session', {
      driver: 'claude',
      seededThroughEventId: seeded.id,
    })
    await store.appendEvent(chat.id, { type: 'agent_message', agentId: SINGLE_CHAT_VOICE.id, turnId: 'turn_old', text: 'Read it.' })
    await store.appendEvent(chat.id, {
      type: 'turn_result',
      agentId: SINGLE_CHAT_VOICE.id,
      turnId: 'turn_old',
      contextTokens: Math.ceil(window * LIVE_COMPACT_CONTEXT_FRACTION),
    })

    const running = orchestrator.submitUserMessage(chat.id, 'and now?')
    await until(
      () => sent.some((message) =>
        message.type === 'event' &&
        message.event.type === 'system_note' &&
        message.event.text === LIVE_COMPACT_NOTE),
      'the live compact note',
    )
    const live = sent.find((message) =>
      message.type === 'event' &&
      message.event.type === 'system_note' &&
      message.event.text === LIVE_COMPACT_NOTE)
    release()
    await running

    expect(live?.type === 'event' ? live.event : undefined).toMatchObject({
      type: 'system_note',
      kind: 'info',
      text: LIVE_COMPACT_NOTE,
    })
    expect((await store.loadEvents(chat.id)).filter((event) => event.type === 'system_note')).toEqual([
      expect.objectContaining({
        id: live?.type === 'event' ? live.event.id : undefined,
        kind: 'info',
        text: LIVE_COMPACT_DONE,
      }),
    ])
  })

  it('settles the compact note as aborted when Stop lands during compact', async () => {
    const seen: TurnInput[] = []
    const held = new Promise<void>(() => {})
    const { orchestrator, store, projectId, sent } = await harness(
      liveCompactDriver(seen, () => true, undefined, held),
    )
    const chat = await store.createChat({ projectId, mode: 'single' })
    const window = contextWindowFor('claude', defaultModel('claude'))
    const seeded = await store.appendEvent(chat.id, { type: 'user_message', text: 'read the repo', mentions: [] })
    await store.setSession(chat.id, SINGLE_CHAT_VOICE.id, 'live-session', {
      driver: 'claude',
      seededThroughEventId: seeded.id,
    })
    await store.appendEvent(chat.id, { type: 'agent_message', agentId: SINGLE_CHAT_VOICE.id, turnId: 'turn_old', text: 'Read it.' })
    await store.appendEvent(chat.id, {
      type: 'turn_result',
      agentId: SINGLE_CHAT_VOICE.id,
      turnId: 'turn_old',
      contextTokens: Math.ceil(window * LIVE_COMPACT_CONTEXT_FRACTION),
    })

    const running = orchestrator.submitUserMessage(chat.id, 'and now?')
    await until(
      () => sent.some((message) =>
        message.type === 'event' &&
        message.event.type === 'system_note' &&
        message.event.text === LIVE_COMPACT_NOTE),
      'the live compact note',
    )
    const turnId = await waitForRunning(sent, chat.id)
    orchestrator.stop(turnId)
    await running

    expect((await store.loadEvents(chat.id)).some((event) =>
      event.type === 'system_note' && event.kind === 'aborted' && event.text === LIVE_COMPACT_STOPPED,
    )).toBe(true)
  })

  it('starts no compact and no provider when Stop lands while the compact note is written', async () => {
    const seen: TurnInput[] = []
    const compact = vi.fn(() => true)
    const { orchestrator, store, projectId, sent } = await harness(liveCompactDriver(seen, compact))
    const chat = await store.createChat({ projectId, mode: 'single' })
    const window = contextWindowFor('claude', defaultModel('claude'))
    const seeded = await store.appendEvent(chat.id, { type: 'user_message', text: 'read the repo', mentions: [] })
    await store.setSession(chat.id, SINGLE_CHAT_VOICE.id, 'live-session', { driver: 'claude', seededThroughEventId: seeded.id })
    await store.appendEvent(chat.id, { type: 'agent_message', agentId: SINGLE_CHAT_VOICE.id, turnId: 'turn_old', text: 'Read it.' })
    await store.appendEvent(chat.id, {
      type: 'turn_result', agentId: SINGLE_CHAT_VOICE.id, turnId: 'turn_old',
      contextTokens: Math.ceil(window * LIVE_COMPACT_CONTEXT_FRACTION),
    })
    const appendEvent = store.appendEvent.bind(store)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let writing = false
    store.appendEvent = async (chatId, draft) => {
      if (draft.type === 'system_note' && draft.text === LIVE_COMPACT_NOTE) {
        writing = true
        await gate
      }
      return appendEvent(chatId, draft)
    }

    const running = orchestrator.submitUserMessage(chat.id, 'and now?')
    await until(() => writing, 'the compact note write')
    orchestrator.stop(await waitForRunning(sent, chat.id))
    release()
    await running

    expect(compact).not.toHaveBeenCalled()
    expect(seen).toEqual([])
    expect((await store.loadEvents(chat.id)).some((event) =>
      event.type === 'system_note' && event.kind === 'aborted' && event.text === LIVE_COMPACT_STOPPED,
    )).toBe(true)
  })

  it('keeps a live compact session when another message arrives during compact', async () => {
    const seen: TurnInput[] = []
    let release = () => {}
    const held = new Promise<void>((resolve) => { release = resolve })
    const { orchestrator, store, projectId, sent } = await harness(
      liveCompactDriver(seen, () => true, undefined, held),
    )
    const chat = await store.createChat({ projectId, mode: 'single' })
    const window = contextWindowFor('claude', defaultModel('claude'))
    const seeded = await store.appendEvent(chat.id, { type: 'user_message', text: 'read the repo', mentions: [] })
    await store.setSession(chat.id, SINGLE_CHAT_VOICE.id, 'live-session', {
      driver: 'claude', seededThroughEventId: seeded.id,
    })
    await store.appendEvent(chat.id, { type: 'agent_message', agentId: SINGLE_CHAT_VOICE.id, turnId: 'turn_old', text: 'Read it.' })
    await store.appendEvent(chat.id, {
      type: 'turn_result', agentId: SINGLE_CHAT_VOICE.id, turnId: 'turn_old',
      contextTokens: Math.ceil(window * LIVE_COMPACT_CONTEXT_FRACTION),
    })

    const first = orchestrator.submitUserMessage(chat.id, 'and now?')
    await until(() => sent.some((message) => message.type === 'event' &&
      message.event.type === 'system_note' && message.event.text === LIVE_COMPACT_NOTE), 'live compact')
    const next = orchestrator.submitUserMessage(chat.id, 'also explain the tests')
    await until(() => sent.some((message) => message.type === 'event' &&
      message.event.type === 'user_message' && message.event.text === 'also explain the tests'), 'the queued message')
    expect((await store.loadEvents(chat.id)).find((event) =>
      event.type === 'user_message' && event.text === 'also explain the tests')).toMatchObject({ dispatchState: 'pending' })
    release()
    await Promise.all([first, next])

    expect(seen.map((input) => input.sessionId)).toEqual(['live-session', 'live-session'])
    expect((await store.getSessions(chat.id, SINGLE_CHAT_VOICE.id)).map((held) => held.sessionId)).toEqual(['live-session'])
    expect((await store.loadEvents(chat.id)).some((event) =>
      event.type === 'system_note' && event.text === LIVE_COMPACT_FAILED)).toBe(false)
  })

  it('does not live-compact Multiple Work even when the hook exists', async () => {
    const seen: TurnInput[] = []
    let compacted = 0
    const { orchestrator, store, chatId } = await harness(liveCompactDriver(seen, () => {
      compacted += 1
      return true
    }))
    const window = contextWindowFor('mock', sage.model)
    const seeded = await store.appendEvent(chatId, { type: 'user_message', text: '@Sage read the repo', mentions: ['sage'] })
    await store.setSession(chatId, 'sage', 'bloated-session', { driver: 'mock', seededThroughEventId: seeded.id })
    await store.appendEvent(chatId, { type: 'agent_message', agentId: 'sage', turnId: 'turn_old', text: 'Read it.' })
    await store.appendEvent(chatId, {
      type: 'turn_result',
      agentId: 'sage',
      turnId: 'turn_old',
      contextTokens: Math.ceil(window * SESSION_CONTEXT_FRACTION),
    })

    await orchestrator.submitUserMessage(chatId, '@Sage and now?')

    expect(compacted).toBe(0)
    expect(seen[0]?.sessionId).toBeUndefined()
    expect(seen[0]?.isFullCatchUp).toBe(true)
    expect((await store.loadEvents(chatId)).some((event) =>
      event.type === 'system_note' && event.text === LIVE_COMPACT_DONE,
    )).toBe(false)
  })

  it('rolls a Single Work session on the second window crossing after a live compact', async () => {
    const seen: TurnInput[] = []
    let compacted = 0
    const window = contextWindowFor('claude', defaultModel('claude'))
    const { orchestrator, store, projectId } = await harness(liveCompactDriver(seen, () => {
      compacted += 1
      return true
    }, window))
    const chat = await store.createChat({ projectId, mode: 'single' })
    const seeded = await store.appendEvent(chat.id, { type: 'user_message', text: 'read the repo', mentions: [] })
    await store.setSession(chat.id, SINGLE_CHAT_VOICE.id, 'live-session', {
      driver: 'claude',
      seededThroughEventId: seeded.id,
    })
    await store.appendEvent(chat.id, { type: 'agent_message', agentId: SINGLE_CHAT_VOICE.id, turnId: 'turn_old', text: 'Read it.' })
    await store.appendEvent(chat.id, {
      type: 'turn_result',
      agentId: SINGLE_CHAT_VOICE.id,
      turnId: 'turn_old',
      contextTokens: Math.ceil(window * LIVE_COMPACT_CONTEXT_FRACTION),
    })

    await orchestrator.submitUserMessage(chat.id, 'keep going')
    await orchestrator.submitUserMessage(chat.id, 'again')

    expect(compacted).toBe(1)
    expect(seen[0]?.sessionId).toBe('live-session')
    expect(seen[1]?.sessionId).toBeUndefined()
    expect(seen[1]?.isFullCatchUp).toBe(true)

    await store.setSession(chat.id, SINGLE_CHAT_VOICE.id, 'live-session', { driver: 'claude' })
    await orchestrator.submitUserMessage(chat.id, 'reuse this session id')
    expect(compacted).toBe(2)
  })

  it('keeps Claude’s compact-once guard when a Codex session in the same chat fails to resume', async () => {
    const seen: TurnInput[] = []
    let compacted = 0
    const window = contextWindowFor('claude', defaultModel('claude'))
    const handle = (event: RuntimeEvent) => {
      const events = new AsyncQueue<RuntimeEvent>()
      events.push(event)
      events.close()
      return { events, stop() { events.close() } }
    }
    const { orchestrator, store, projectId } = await harness({
      startTurn(input) {
        seen.push(input)
        if (input.sessionId === 'codex-expired') {
          return handle({ type: 'error', message: `${RESUME_FAILURE_PREFIX} gone` })
        }
        return handle({
          type: 'result',
          text: 'Continued.',
          sessionId: input.sessionId ?? `fresh-${input.agent.driver}`,
          contextTokens: input.agent.driver === 'claude' ? window : 100,
        })
      },
      compactSession() {
        compacted += 1
        return handle({ type: 'result', text: '' })
      },
    })
    const chat = await store.createChat({ projectId, mode: 'single' })
    const seeded = await store.appendEvent(chat.id, { type: 'user_message', text: 'read it', mentions: [] })
    await store.setSession(chat.id, SINGLE_CHAT_VOICE.id, 'claude-held', { driver: 'claude', seededThroughEventId: seeded.id })
    await store.appendEvent(chat.id, {
      type: 'turn_result', agentId: SINGLE_CHAT_VOICE.id, turnId: 'turn_old', driver: 'claude',
      contextTokens: Math.ceil(window * LIVE_COMPACT_CONTEXT_FRACTION),
    })
    await orchestrator.submitUserMessage(chat.id, 'Continue on Claude')
    expect(compacted).toBe(1)

    const latest = (await store.loadEvents(chat.id)).at(-1)
    await store.setSession(chat.id, SINGLE_CHAT_VOICE.id, 'codex-expired', {
      driver: 'codex', ...(latest === undefined ? {} : { seededThroughEventId: latest.id }),
    })
    await orchestrator.setOverride(chat.id, SINGLE_CHAT_VOICE.id, { driver: 'codex', model: defaultModel('codex'), effort: 'high', auto: false })
    await orchestrator.submitUserMessage(chat.id, 'One turn on Codex')
    expect(seen.slice(1).map((input) => input.sessionId)).toEqual(['codex-expired', undefined])

    // The second crossing of Claude's already compacted session rolls it over.
    await orchestrator.setOverride(chat.id, SINGLE_CHAT_VOICE.id, { driver: 'claude', model: defaultModel('claude'), effort: 'high', auto: false })
    await orchestrator.submitUserMessage(chat.id, 'Back to Claude')
    expect(compacted).toBe(1)
    expect(seen.at(-1)?.sessionId).toBeUndefined()
    expect(seen.at(-1)?.isFullCatchUp).toBe(true)
  })

  it('gives an ordinary persona the same turn-scoped Artifacts tools through the runtime seam', async () => {
    const seen: TurnInput[] = []
    const issued: Array<{ chatId: string; agentId: string; turnId: string }> = []
    const { orchestrator, chatId } = await harness(
      recording(createMockDriver({ deltaDelayMs: 0 }), seen),
      {
        artifactMcp: (issuedChatId, agent, turnId) => {
          issued.push({ chatId: issuedChatId, agentId: agent.id, turnId })
          return artifactMcpAttachment(
            'http://127.0.0.1:8787/internal/artifact-tool',
            'turn-capability',
          )
        },
      },
    )

    await orchestrator.submitUserMessage(chatId, '@Sage look in Artifacts for inspiration')

    expect(issued).toMatchObject([{ chatId, agentId: 'sage' }])
    expect(issued[0]?.turnId).toMatch(/^turn_/)
    expect(seen[0]?.mcpServers?.map(({ server }) => server.name)).toContain('artifacts')
  })

  it('runs both mentioned personas in mention order, each seeing the earlier reply', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, store, chatId, sent } = await harness(
      recording(createMockDriver({ deltaDelayMs: 0 }), seen),
    )

    await orchestrator.submitUserMessage(chatId, '@Sage @Smith what first?')

    const events = await store.loadEvents(chatId)
    expect(events.map((event) => [event.type, 'agentId' in event ? event.agentId : 'user'])).toEqual([
      ['user_message', 'user'],
      ['reasoning', 'sage'],
      ['agent_message', 'sage'],
      ['turn_result', 'sage'],
      ['reasoning', 'smith'],
      ['tool_use', 'smith'],
      ['tool_result', 'smith'],
      // The mock's edit, which is what gives the UI a diff to render without a
      // real CLI run. Only personas that hold tools reach it.
      ['tool_use', 'smith'],
      ['tool_result', 'smith'],
      ['agent_message', 'smith'],
      ['turn_result', 'smith'],
    ])

    // Smith's catch-up carries Sage's reply, so the second persona answers into the first.
    const smithTurn = seen[1]
    expect(smithTurn?.agent.id).toBe('smith')
    expect(smithTurn?.catchUp.some((event) => event.type === 'agent_message' && event.agentId === 'sage')).toBe(true)

    // Both personas started without a session, so both got the whole chat.
    expect(seen.map((input) => input.isFullCatchUp)).toEqual([true, true])
    expect(seen.every((input) => input.threadId === chatId)).toBe(true)
    expect(await sessionIdIn(store, chatId, 'sage')).toBe(`mock-${chatId}-sage`)
    expect(await sessionIdIn(store, chatId, 'smith')).toBe(`mock-${chatId}-smith`)

    const states = sent.filter((message) => message.type === 'turn_state')
    expect(states.map((message) => [message.agentId, message.state])).toEqual([
      ['sage', 'running'],
      ['sage', 'done'],
      ['smith', 'running'],
      ['smith', 'done'],
    ])
    // Every chat-scoped message names its chat; the client filters on it.
    expect(sent.every((message) => 'chatId' in message && message.chatId === chatId)).toBe(true)
    expect(sent.some((message) => message.type === 'delta' && message.agentId === 'sage')).toBe(true)
  })

  it('persists provider message boundaries around tool work in their original order', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, store, chatId, sent } = await harness(
      scripted(
        () => [
          { type: 'delta', messageId: 'before', text: 'I will check.' },
          { type: 'message', messageId: 'before', text: 'I will check.' },
          { type: 'tool_use', toolCallId: 'read-1', tool: 'Read', detail: 'memory.md' },
          { type: 'tool_result', toolCallId: 'read-1', outcome: 'success' },
          { type: 'delta', messageId: 'after', text: 'Read it.' },
          { type: 'message', messageId: 'after', text: 'Read it.' },
          {
            type: 'result',
            text: 'I will check. Read it.',
            usage: { inputTokens: 20, outputTokens: 8 },
            sessionId: 'session-1',
          },
        ],
        seen,
      ),
    )

    await orchestrator.submitUserMessage(chatId, '@Sage inspect this')

    const events = await store.loadEvents(chatId)
    expect(types(events)).toEqual([
      'user_message',
      'agent_message',
      'tool_use',
      'tool_result',
      'agent_message',
      'turn_result',
    ])
    expect(events.filter((event) => event.type === 'agent_message').map((event) => event.text)).toEqual([
      'I will check.',
      'Read it.',
    ])
    expect(
      sent.filter((message) => message.type === 'delta').map((message) => message.messageId),
    ).toEqual(['attempt_1:before', 'attempt_1:after'])
    expect(await orchestrator.usage(chatId)).toEqual({ sage: { inputTokens: 20, outputTokens: 8 } })
  })

  it('persists todo snapshots without treating planning as completed tool work', async () => {
    const { orchestrator, store, chatId } = await harness(scripted(
      () => [
        { type: 'todo_update', todos: [
          { text: 'Inspect', status: 'completed' },
          { text: 'Fix', status: 'in_progress' },
        ] },
        { type: 'result', text: 'Working on it.', sessionId: 'session-1' },
      ],
      [],
    ))

    await orchestrator.submitUserMessage(chatId, '@Sage do it')
    const events = await store.loadEvents(chatId)
    expect(events.find((event) => event.type === 'todo_update')).toMatchObject({
      agentId: 'sage',
      todos: [
        { text: 'Inspect', status: 'completed' },
        { text: 'Fix', status: 'in_progress' },
      ],
    })
    expect(events.some((event) => event.type === 'tool_use')).toBe(false)
  })

  it('keeps ask-user request and response inside the active turn', async () => {
    const { driver, forChat } = gated()
    const { orchestrator, store, chatId, sent } = await harness(driver)
    const running = orchestrator.submitUserMessage(chatId, '@Sage choose')
    await until(() => forChat(chatId).length === 1, 'the question turn to start')
    const turnId = await waitForRunning(sent, chatId)
    const questions = [{
      id: 'direction',
      question: 'Which direction?',
      options: [{ label: 'A' }, { label: 'B' }],
    }]

    await expect(orchestrator.recordUserInputRequest(
      chatId,
      'sage',
      turnId,
      'request-1',
      questions,
    )).resolves.toBe(true)
    await expect(orchestrator.recordUserInputResponse(
      chatId,
      'sage',
      turnId,
      'request-1',
      { direction: 'A' },
    )).resolves.toBe(true)
    forChat(chatId)[0]?.finish()
    await running

    expect(types(await store.loadEvents(chatId))).toEqual([
      'user_message',
      'user_input_request',
      'user_input_response',
      'agent_message',
      'turn_result',
    ])
  })

  it('stores a delivered file with its original inside the running turn only', async () => {
    const { driver, forChat } = gated()
    const { orchestrator, store, chatId, sent } = await harness(driver)
    const running = orchestrator.submitUserMessage(chatId, '@Sage make the report')
    await until(() => forChat(chatId).length === 1, 'the turn to start')
    const turnId = await waitForRunning(sent, chatId)
    const file = { id: 'file_1', name: 'report.pdf', mime: 'application/pdf', size: 4 }

    await expect(orchestrator.recordFileDelivery({ chatId, agentId: 'sage', turnId }, file, Buffer.from('%PDF'))).resolves.toBe(true)
    await expect(orchestrator.recordFileDelivery({ chatId, agentId: 'smith', turnId }, file, Buffer.from('%PDF'))).resolves.toBe(false)
    forChat(chatId)[0]?.finish()
    await running
    await expect(orchestrator.recordFileDelivery({ chatId, agentId: 'sage', turnId }, file, Buffer.from('%PDF'))).resolves.toBe(false)

    const events = await store.loadEvents(chatId)
    expect(events.filter((event) => event.type === 'file_delivery')).toEqual([
      expect.objectContaining({ agentId: 'sage', turnId, file }),
    ])
    expect(Buffer.from((await store.loadDocument(chatId, 'file_1'))!).toString()).toBe('%PDF')
  })

  it('counts a delivered file as the report, so a file-only turn is not nudged or noted', async () => {
    const queues: AsyncQueue<RuntimeEvent>[] = []
    const driver: Driver = {
      startTurn() {
        const queue = new AsyncQueue<RuntimeEvent>()
        queues.push(queue)
        return { events: queue, stop: () => queue.close() }
      },
    }
    const { orchestrator, store, chatId, sent } = await harness(driver)
    const running = orchestrator.submitUserMessage(chatId, '@Sage make the report')
    await until(() => queues.length === 1, 'the turn to start')
    const turnId = await waitForRunning(sent, chatId)
    const file = { id: 'file_1', name: 'report.pdf', mime: 'application/pdf', size: 4 }

    queues[0]!.push({ type: 'tool_use', toolCallId: 'deliver-1', tool: 'deliver_file', detail: 'report.pdf' })
    await expect(orchestrator.recordFileDelivery({ chatId, agentId: 'sage', turnId }, file, Buffer.from('%PDF'))).resolves.toBe(true)
    queues[0]!.push({ type: 'result', text: '', sessionId: 'session-1' })
    queues[0]!.close()
    await running

    expect(queues).toHaveLength(1)
    expect((await store.loadEvents(chatId)).some((event) => event.type === 'system_note')).toBe(false)
  })

  it('persists generated images as an image-only agent message', async () => {
    const image = { name: 'diagram.png', dataUrl: 'data:image/png;base64,aW1hZ2U=' }
    const { orchestrator, store, chatId } = await harness(
      scripted(
        () => [
          { type: 'message', messageId: 'answer', text: 'Here it is.' },
          { type: 'result', text: 'Here it is.', sessionId: 'session-1' },
          { type: 'attachment', image },
        ],
        [],
      ),
    )

    await orchestrator.submitUserMessage(chatId, '@Sage make a diagram')

    const replies = (await store.loadEvents(chatId)).filter((event) => event.type === 'agent_message')
    expect(replies).toHaveLength(2)
    expect(replies[1]).toMatchObject({ text: '', images: [image] })
  })

  it('persists attached text files and carries them into the addressed turn', async () => {
    const seen: TurnInput[] = []
    const attached = { name: 'notes.md', mime: 'text/markdown', content: '# Notes\nThe answer is 42.' }
    const { orchestrator, store, chatId } = await harness(
      recording(createMockDriver({ deltaDelayMs: 0 }), seen),
    )

    await orchestrator.submitUserMessage(chatId, '@Sage read this', [], undefined, [], [attached])

    expect((await store.loadEvents(chatId))[0]).toMatchObject({
      type: 'user_message',
      files: [attached],
    })
    expect(seen[0]?.catchUp[0]).toMatchObject({ type: 'user_message', files: [attached] })
  })

  it('keeps an attached PDF’s original, stores its extraction and hands it to every addressed persona', async () => {
    const seen: TurnInput[] = []
    const pdf = pdfFixture(['The client wants a new onboarding flow', null])
    const upload = { name: 'brief.pdf', mime: 'application/pdf' as const, data: Buffer.from(pdf).toString('base64') }
    const { orchestrator, store, chatId } = await harness(recording(createMockDriver({ deltaDelayMs: 0 }), seen))

    await orchestrator.submitUserMessage(chatId, '@Sage @Smith read this', [], undefined, [], [], undefined, [], [upload])

    const message = (await store.loadEvents(chatId))[0]
    const document = message?.type === 'user_message' ? message.documents?.[0] : undefined
    expect(document).toMatchObject({
      name: 'brief.pdf', size: pdf.byteLength,
      extraction: { status: 'partial', pageCount: 2, unreadablePages: [2] },
    })
    expect(document?.text).toContain('[Page 1]\nThe client wants a new onboarding flow')
    expect(JSON.stringify(message)).not.toContain(upload.data)
    expect(await store.loadDocument(chatId, document!.id)).toEqual(pdf)
    expect(seen.map((input) => input.agent.id)).toEqual(['sage', 'smith'])
    for (const input of seen) expect(input.catchUp[0]).toMatchObject({ type: 'user_message', documents: [{ id: document!.id }] })

    await store.deleteChat(chatId)
    expect(await store.loadDocument(chatId, document!.id)).toBeUndefined()
  })

  describe('a document message that is not kept', () => {
    const upload = { name: 'brief.pdf', mime: 'application/pdf' as const, data: Buffer.from(pdfFixture(['Readable page of the brief'])).toString('base64') }
    const send = (orchestrator: Orchestrator, chatId: string) =>
      orchestrator.submitUserMessage(chatId, 'read this', [], undefined, [], [], undefined, [], [upload])

    it('keeps no original when the chat no longer exists', async () => {
      const { orchestrator, store } = await harness(createMockDriver({ deltaDelayMs: 0 }))
      const appended = vi.spyOn(store, 'appendEvent')
      await expect(send(orchestrator, 'chat_gone')).rejects.toThrow('This chat no longer exists.')
      expect(appended).not.toHaveBeenCalled()
    })

    it('keeps no original when unaccepted Work refuses the message', async () => {
      const { orchestrator, store, chatId } = await harness(createMockDriver({ deltaDelayMs: 0 }))
      vi.spyOn(store, 'workHandoffForTarget').mockResolvedValue({ acceptedAt: null } as never)
      const appended = vi.spyOn(store, 'appendEvent')
      await expect(send(orchestrator, chatId)).rejects.toThrow('Accept this session')
      expect(appended).not.toHaveBeenCalled()
    })

    it('keeps no original when the chat is deleted while the message is written', async () => {
      const { orchestrator, store, chatId } = await harness(createMockDriver({ deltaDelayMs: 0 }))
      const append = store.appendEvent.bind(store)
      const ids: string[] = []
      vi.spyOn(store, 'appendEvent').mockImplementation(async (target, draft, originals = []) => {
        ids.push(...originals.map((original) => original.id))
        orchestrator.discard(target)
        await store.deleteChat(target)
        return append(target, draft, originals)
      })
      await send(orchestrator, chatId)
      expect(ids).toHaveLength(1)
      expect(await store.loadDocument(chatId, ids[0]!)).toBeUndefined()
      expect(await store.loadEvents(chatId)).toEqual([])
    })
  })

  it('stores a selected quote for every addressed persona without routing its mentions', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, store, chatId } = await harness(recording(createMockDriver({ deltaDelayMs: 0 }), seen))
    const source = await store.appendEvent(chatId, {
      type: 'agent_message', turnId: 'turn_source', agentId: 'smith', text: 'Before. @Argus inspect this. After.',
    })
    const quote = { eventId: source.id, text: '@Argus inspect this.', agentId: 'smith' }
    await orchestrator.submitUserMessage(chatId, '@Sage @Smith explain [Quote #1]', [], undefined, [], [], undefined,
      [{ kind: 'message', ...quote, agentId: 'argus' }])
    const message = (await store.loadEvents(chatId)).find((event) => event.type === 'user_message')
    const quotes = [{ kind: 'message', ...quote }]
    expect(message).toMatchObject({ quotes, mentions: ['sage', 'smith'] })
    expect(seen.map((input) => input.agent.id)).toEqual(['sage', 'smith'])
    for (const input of seen) expect(input.catchUp).toContainEqual(expect.objectContaining({ type: 'user_message', quotes }))
  })

  it('stores a knowledge note quote without looking it up as a chat event', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, store, chatId } = await harness(recording(createMockDriver({ deltaDelayMs: 0 }), seen))
    const quotes = [{ kind: 'note' as const, path: 'inbox/untitled.md', text: 'Keep this slice' }]
    await orchestrator.submitUserMessage(chatId, '@Sage explain [Quote #1]', [], undefined, [], [], undefined, quotes)
    const message = (await store.loadEvents(chatId)).find((event) => event.type === 'user_message')
    expect(message).toMatchObject({ quotes, mentions: ['sage'] })
    expect(seen[0]?.catchUp).toContainEqual(expect.objectContaining({ type: 'user_message', quotes }))
  })

  it.each([true, false])('stores two quotes of different sources in their reading order with personal memory %s', async (memoryScope) => {
    const seen: TurnInput[] = []
    const { orchestrator, store, chatId } = await harness(recording(createMockDriver({ deltaDelayMs: 0 }), seen), { agents: [{ ...sage, memoryScope }, smith] })
    const source = await store.appendEvent(chatId, { type: 'agent_message', turnId: 'turn_source', agentId: 'smith', text: 'Keep it.' })
    const quotes = [
      { kind: 'message' as const, eventId: source.id, text: 'Keep it.' },
      { kind: 'note' as const, path: 'inbox/untitled.md', text: 'Drop it.' },
    ]
    await orchestrator.submitUserMessage(chatId, '@Sage is [Quote #1] better than [Quote #2]?', [], undefined, [], [], undefined, quotes)
    const message = (await store.loadEvents(chatId)).find((event) => event.type === 'user_message')
    expect(message).toMatchObject({
      text: '@Sage is [Quote #1] better than [Quote #2]?',
      quotes: [{ kind: 'message', eventId: source.id, text: 'Keep it.', agentId: 'smith' }, quotes[1]],
    })
    expect(seen[0]?.catchUp).toContainEqual(expect.objectContaining({ type: 'user_message', text: '@Sage is [Quote #1] better than [Quote #2]?', quotes: expect.any(Array) }))
  })

  it('refuses a quote from another chat before writing or starting a turn', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, store, chatId } = await harness(recording(createMockDriver({ deltaDelayMs: 0 }), seen))
    const kept = await store.appendEvent(chatId, { type: 'user_message', text: 'Kept.', mentions: [] })
    const before = await store.loadEvents(chatId)
    await expect(orchestrator.submitUserMessage(chatId, '@Sage [Quote #1] and [Quote #2]', [], undefined, [], [], undefined, [
      { kind: 'message', eventId: kept.id, text: 'Kept.' },
      { kind: 'message', eventId: 'other_chat_event', text: 'Selection' },
    ])).rejects.toThrow('no longer available in this chat')
    expect(await store.loadEvents(chatId)).toEqual(before)
    expect(seen).toEqual([])
  })

  it('carries a quote of a user message through DM steering', async () => {
    const gate = gated(() => 'Done')
    const { orchestrator, store } = await harness(gate.driver)
    const dm = await store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })
    const first = orchestrator.submitUserMessage(dm.id, 'First question.')
    await until(() => gate.forChat(dm.id).length === 1, 'the first DM attempt')
    const source = (await store.loadEvents(dm.id)).find((event) => event.type === 'user_message')!
    const quotes = [{ kind: 'message' as const, eventId: source.id, text: 'First question.' }]
    const steering = orchestrator.submitUserMessage(dm.id, 'Explain that part.', [], undefined, [], [], undefined,
      [{ ...quotes[0]!, agentId: 'smith' }])
    await until(() => gate.forChat(dm.id).length === 2, 'the quoted steering attempt')
    expect(gate.forChat(dm.id)[1]?.input.catchUp).toContainEqual(expect.objectContaining({ type: 'user_message', quotes }))
    const stored = (await store.loadEvents(dm.id)).find((event) => event.type === 'user_message' && event.text === 'Explain that part.')
    expect(stored?.type === 'user_message' && stored.quotes).toEqual(quotes)
    gate.forChat(dm.id)[1]?.finish()
    await Promise.all([first, steering])
  })

  it('persists the one answer a user message replies to', async () => {
    const seen: TurnInput[] = []
    const replyTo = {
      turnId: 'turn_source',
      agentId: 'smith',
      text: 'Keep the wire small.',
    }
    const { orchestrator, store, chatId } = await harness(
      recording(createMockDriver({ deltaDelayMs: 0 }), seen),
    )

    await orchestrator.submitUserMessage(chatId, '@Sage explain why', [], undefined, [], [], replyTo)

    expect((await store.loadEvents(chatId))[0]).toMatchObject({
      type: 'user_message',
      text: '@Sage explain why',
      replyTo,
    })
    expect(seen[0]?.catchUp).toHaveLength(1)
    expect(seen[0]?.catchUp[0]).toMatchObject({ type: 'user_message', replyTo })
  })

  it('reuses a materialised input instead of rewriting it on a full catch-up', async () => {
    const scratchDir = mkdtempSync(path.join(os.tmpdir(), 'manor-image-input-'))
    const seen: TurnInput[] = []
    const { orchestrator, chatId } = await harness(
      scripted(
        () => [
          { type: 'message', messageId: 'answer', text: 'Seen.' },
          // No session id, so the next turn deliberately replays the whole thread.
          { type: 'result', text: 'Seen.' },
        ],
        seen,
      ),
      { scratchDir },
    )

    await orchestrator.submitUserMessage(chatId, '@Sage inspect this', [
      { name: 'input.png', dataUrl: 'data:image/png;base64,aW1hZ2U=' },
    ])
    const materialised = seen[0]?.imagePaths?.[0]
    if (materialised === undefined) throw new Error('expected a materialised image')
    await writeFile(materialised, 'sentinel')

    await orchestrator.submitUserMessage(chatId, '@Sage look again')

    expect(await readFile(materialised, 'utf8')).toBe('sentinel')
    expect(seen[1]?.imagePaths).toContain(materialised)
  })

  it('advances the per-agent cursor and accumulates usage across turns', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, chatId, sent } = await harness(recording(createMockDriver({ deltaDelayMs: 0 }), seen))

    await orchestrator.submitUserMessage(chatId, '@Sage first question')
    await orchestrator.submitUserMessage(chatId, '@Sage second question')

    const second = seen[1]
    expect(second?.isFullCatchUp).toBe(false)
    expect(second?.sessionId).toBe(`mock-${chatId}-sage`)
    // Only what happened since Sage last spoke: the new user message.
    expect(types(second?.catchUp ?? [])).toEqual(['user_message'])
    expect(second?.catchUp.some((event) => event.type === 'user_message' && event.text.includes('first'))).toBe(false)

    // The mock also reports a cache split, which sums the same way.
    const summed = {
      inputTokens: 240, outputTokens: 90, costUsd: 0.0024,
      breakdown: { freshInputTokens: 36, cacheWrite5mTokens: 12, cacheWrite1hTokens: 0, cacheReadTokens: 192, apiPricedInputEquivalent: 70 },
    }
    expect(await orchestrator.usage(chatId)).toEqual({ sage: summed })
    expect(sent.filter((message) => message.type === 'usage').at(-1)).toEqual({ type: 'usage', chatId, perAgent: { sage: summed } })
  })

  // Turn ids outlive the process that hands them out: they are written into the
  // transcript and are the client's grouping key. A counter that restarts at one made
  // every turn after a restart collide with an old turn of the same chat, which the
  // client reads as a turn that has already finished — no timer, no Stop, and its
  // replies folded into an old block under whichever persona owned that id first.
  it('never reuses a turn id a previous process already spent in the chat', async () => {
    const { orchestrator, store, chatId } = await harness(createMockDriver({ deltaDelayMs: 0 }))
    await orchestrator.submitUserMessage(chatId, '@Sage before the restart')

    const restarted = new Orchestrator({
      agents: () => roster,
      store,
      mcpServers: () => [],
      resolveDriver: () => createMockDriver({ deltaDelayMs: 0 }),
      ensureScratchDir: scratchFor,
      emit: () => undefined,
    })
    await restarted.submitUserMessage(chatId, '@Sage after the restart')

    const events = await store.loadEvents(chatId)
    const turnIds = events.flatMap((event) => ('turnId' in event ? [event.turnId] : []))
    expect(turnIds.length).toBeGreaterThan(0)
    expect(new Set(turnIds).size).toBe(2)
  })

  it('rebuilds cumulative usage from the stored transcript', async () => {
    const { orchestrator, store, chatId } = await harness(createMockDriver({ deltaDelayMs: 0 }))
    await store.appendEvent(chatId, {
      type: 'agent_message',
      agentId: 'sage',
      turnId: 'turn_0',
      text: 'earlier',
      usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.001 },
    })
    await store.appendEvent(chatId, {
      type: 'agent_message',
      agentId: 'sage',
      turnId: 'turn_1',
      text: 'later',
      usage: { inputTokens: 50, outputTokens: 10, costUsd: 0.0005 },
    })

    expect(await orchestrator.usage(chatId)).toEqual({ sage: { inputTokens: 150, outputTokens: 30, costUsd: 0.0015 } })
  })

  it('adds up the cost breakdown across turns', async () => {
    const { orchestrator, store, chatId } = await harness(createMockDriver({ deltaDelayMs: 0 }))
    const breakdown = {
      freshInputTokens: 10,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 100,
      cacheReadTokens: 1005,
      apiPricedInputEquivalent: 311,
    }
    for (const turnId of ['turn_0', 'turn_1']) {
      await store.appendEvent(chatId, {
        type: 'agent_message',
        agentId: 'sage',
        turnId,
        text: turnId,
        usage: { inputTokens: 1115, outputTokens: 5, breakdown },
      })
    }

    expect((await orchestrator.usage(chatId))['sage']?.breakdown).toEqual({
      freshInputTokens: 20,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 200,
      cacheReadTokens: 2010,
      // Recomputed from the summed parts. Summing two rounded 310.5 values would be 622.
      apiPricedInputEquivalent: 621,
    })
  })

  /**
   * A total that silently omits one turn's tokens still looks like a total. Absent
   * beats an understated API pricing proxy.
   */
  it('drops the breakdown entirely when one of the turns did not report one', async () => {
    const { orchestrator, store, chatId } = await harness(createMockDriver({ deltaDelayMs: 0 }))
    await store.appendEvent(chatId, {
      type: 'agent_message',
      agentId: 'sage',
      turnId: 'turn_0',
      text: 'with',
      usage: {
        inputTokens: 1110,
        outputTokens: 5,
        breakdown: {
          freshInputTokens: 10,
          cacheWrite5mTokens: 0,
          cacheWrite1hTokens: 100,
          cacheReadTokens: 1000,
          apiPricedInputEquivalent: 310,
        },
      },
    })
    await store.appendEvent(chatId, {
      type: 'agent_message',
      agentId: 'sage',
      turnId: 'turn_1',
      text: 'without',
      usage: { inputTokens: 40, outputTokens: 5 },
    })

    const total = (await orchestrator.usage(chatId))['sage']
    expect(total?.inputTokens).toBe(1150)
    expect(total?.breakdown).toBeUndefined()
  })

  // The reverse state of configuring a chief of staff: this roster has none, so an
  // un-mentioned message runs no turn and rides along as context. It says so, because
  // a send that produces no reply, no timer and no error is indistinguishable from a
  // send that failed.
  it('says nobody was addressed when a message reaches no persona and no chief of staff', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, store, chatId, sent } = await harness(recording(createMockDriver({ deltaDelayMs: 0 }), seen))

    await orchestrator.submitUserMessage(chatId, 'thinking out loud, nobody in particular')

    expect(seen).toHaveLength(0)
    const events = await store.loadEvents(chatId)
    expect(types(events)).toEqual(['user_message', 'system_note'])
    expect(events.at(-1)).toMatchObject({
      type: 'system_note',
      kind: 'info',
      text: 'Nobody was addressed and no chief of staff is configured, so this message stays in the chat as context.',
    })
    // No turn ran, so nothing about a turn was announced.
    expect(sent.some((message) => message.type === 'turn_state')).toBe(false)
  })

  it('runs two chats at once while keeping turns inside one chat sequential', async () => {
    const { driver, gates, forChat } = gated()
    const store = createMemoryStore({ agents: roster })
    const { chatId: first, projectId } = await seededChat(store)
    const second = (await store.createChat({ projectId, title: 'Second' })).id
    const sent: ServerMessage[] = []
    const orchestrator = new Orchestrator({
      agents: () => roster,
      store,
      mcpServers: () => [],
      resolveDriver: () => driver,
      ensureScratchDir: scratchFor,
      emit: (message) => sent.push(message),
    })

    const runFirst = orchestrator.submitUserMessage(first, '@Sage @Smith go')
    const runSecond = orchestrator.submitUserMessage(second, '@Sage hello')

    // Both chats are mid-turn at the same time: one chat's open turn does not
    // hold the other one up.
    await until(() => forChat(first).length === 1 && forChat(second).length === 1, 'both chats to start a turn')
    expect(gates.map((gate) => gate.input.agent.id)).toEqual(['sage', 'sage'])

    forChat(second)[0]?.finish()
    await runSecond

    // The first chat's second persona has still not started: Sage is not done.
    expect(forChat(first)).toHaveLength(1)

    forChat(first)[0]?.finish()
    await until(() => forChat(first).length === 2, "the first chat's second persona to start")
    expect(forChat(first)[1]?.input.agent.id).toBe('smith')
    forChat(first)[1]?.finish()
    await runFirst

    expect(types(await store.loadEvents(first))).toEqual([
      'user_message',
      'agent_message',
      'turn_result',
      'agent_message',
      'turn_result',
    ])
    expect(types(await store.loadEvents(second))).toEqual(['user_message', 'agent_message', 'turn_result'])
    // Usage and sessions stay per chat.
    expect(await orchestrator.usage(second)).toEqual({ sage: { inputTokens: 10, outputTokens: 4 } })
    expect(await sessionIdIn(store, second, 'sage')).toBe(`session-${second}-sage`)
    expect(await sessionIdIn(store, first, 'smith')).toBe(`session-${first}-smith`)
  })

  it("hands the driver the folders of the chat's project, and none when there are none", async () => {
    const seen: TurnInput[] = []
    const { orchestrator, store, chatId, projectId } = await harness(
      recording(createMockDriver({ deltaDelayMs: 0 }), seen),
    )

    await orchestrator.submitUserMessage(chatId, '@Sage before')
    await store.updateProject(projectId, 'Manor', ['/repos/manor', '/home/sam/notes'])
    await orchestrator.submitUserMessage(chatId, '@Sage after')

    expect(seen.map((input) => input.repoPaths)).toEqual([[], ['/repos/manor', '/home/sam/notes']])
    // The scratch cwd is untouched by the link: the folders are extra directories.
    expect(new Set(seen.map((input) => input.cwd))).toEqual(new Set([await scratchFor(chatId)]))
  })

  it('hands an isolated chat the remapped paths and a current chat the shared ones', async () => {
    const seen: TurnInput[] = []
    const store = createMemoryStore({ agents: roster })
    const { chatId: current, projectId } = await seededChat(store)
    const isolated = (await store.createChat({ projectId, title: 'Isolated' })).id
    await store.updateProject(projectId, 'Manor', ['/repos/manor'])
    await store.replaceChatWorktrees(isolated, [
      {
        sourcePath: '/repos/manor',
        worktreePath: '/tmp/worktrees/p/c/manor',
        branch: 'manor/abcd1234',
        createdAt: 1,
      },
    ])
    const orchestrator = new Orchestrator({
      agents: () => roster,
      store,
      mcpServers: () => [],
      resolveDriver: () => recording(createMockDriver({ deltaDelayMs: 0 }), seen),
      ensureScratchDir: scratchFor,
      emit: () => undefined,
    })

    await orchestrator.submitUserMessage(current, '@Sage shared')
    await orchestrator.submitUserMessage(isolated, '@Sage isolated')

    expect(seen.map((input) => input.repoPaths)).toEqual([['/repos/manor'], ['/tmp/worktrees/p/c/manor']])
    expect(seen[0]?.repoAccess).toBeUndefined()
    expect(seen[1]?.repoAccess).toEqual({
      mode: 'worktree',
      // The dest is not a git dir in this test, so live HEAD is unreadable: null,
      // never the stored mapping name.
      branch: null,
      sources: [{ sourcePath: '/repos/manor', worktreePath: '/tmp/worktrees/p/c/manor' }],
    })
  })

  it('records a real isolated worktree delta on the finished turn', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'manor-turn-checkout-'))
    try {
      execFileSync('git', ['init', '-q'], { cwd: root })
      const { driver, forChat } = gated()
      const store = createMemoryStore({ agents: roster })
      const { chatId, projectId } = await seededChat(store)
      await store.updateProject(projectId, 'Manor', [root])
      await store.replaceChatWorktrees(chatId, [{
        sourcePath: root, worktreePath: root, branch: 'main', createdAt: 1,
      }])
      const orchestrator = new Orchestrator({
        agents: () => roster,
        store,
        mcpServers: () => [],
        resolveDriver: () => driver,
        ensureScratchDir: scratchFor,
        emit: () => undefined,
      })

      const turn = orchestrator.submitUserMessage(chatId, '@Sage change a file')
      await until(() => forChat(chatId).length === 1, 'turn to start')
      await writeFile(path.join(root, 'from-shell.txt'), 'landed\n')
      forChat(chatId)[0]?.finish()
      await turn

      const result = (await store.loadEvents(chatId)).find((event) => event.type === 'turn_result')
      expect(result?.fileChanges).toMatchObject([{
        path: path.join(root, 'from-shell.txt'), panelPath: `${path.basename(root)}/from-shell.txt`,
        status: 'created', added: 1, removed: 0,
      }])
      expect(result?.fileChangeRoots).toEqual([root])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('records what a failed turn changed on its terminal note', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'manor-turn-failed-'))
    try {
      execFileSync('git', ['init', '-q'], { cwd: root })
      const driver: Driver = {
        startTurn() {
          const queue = new AsyncQueue<RuntimeEvent>()
          void (async () => {
            await writeFile(path.join(root, 'half.ts'), 'half done\n')
            queue.push({ type: 'error', message: 'provider fell over' })
            queue.close()
          })()
          return { events: queue, stop: () => queue.close() }
        },
      }
      const store = createMemoryStore({ agents: roster })
      const { chatId, projectId } = await seededChat(store)
      await store.updateProject(projectId, 'Manor', [root])
      await store.replaceChatWorktrees(chatId, [{ sourcePath: root, worktreePath: root, branch: 'main', createdAt: 1 }])
      const orchestrator = new Orchestrator({
        agents: () => roster,
        store,
        mcpServers: () => [],
        resolveDriver: () => driver,
        ensureScratchDir: scratchFor,
        emit: () => undefined,
      })

      await orchestrator.submitUserMessage(chatId, '@Sage change a file')

      const events = await store.loadEvents(chatId)
      expect(events.some((event) => event.type === 'turn_result')).toBe(false)
      expect(events.find((event) => event.type === 'system_note' && event.kind === 'error'))
        .toMatchObject({ changedFiles: [path.join(root, 'half.ts')] })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('records an unmeasurable checkout as failed, not as unchanged', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'manor-turn-unmeasured-'))
    try {
      execFileSync('git', ['init', '-q'], { cwd: root })
      const driver: Driver = {
        startTurn() {
          const queue = new AsyncQueue<RuntimeEvent>()
          void (async () => {
            await writeFile(path.join(root, 'edit.ts'), 'changed\n')
            // Git can no longer read the checkout when the turn ends.
            await rm(path.join(root, '.git'), { recursive: true, force: true })
            queue.push({ type: 'result', text: 'Done.', sessionId: 's' })
            queue.close()
          })()
          return { events: queue, stop: () => queue.close() }
        },
      }
      const store = createMemoryStore({ agents: roster })
      const { chatId, projectId } = await seededChat(store)
      await store.updateProject(projectId, 'Manor', [root])
      await store.replaceChatWorktrees(chatId, [{ sourcePath: root, worktreePath: root, branch: 'main', createdAt: 1 }])
      const orchestrator = new Orchestrator({
        agents: () => roster,
        store,
        mcpServers: () => [],
        resolveDriver: () => driver,
        ensureScratchDir: scratchFor,
        emit: () => undefined,
      })

      await orchestrator.submitUserMessage(chatId, '@Sage change a file')

      const result = (await store.loadEvents(chatId)).find((event) => event.type === 'turn_result')
      expect(result).toMatchObject({ fileChangesFailed: true })
      expect(result).not.toHaveProperty('fileChanges')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    ['a code edit in a folder that is not a git checkout', 1, 'Sage', 'edit', 'src/a.ts', true],
    ['a prose edit in a folder that is not a git checkout', 1, 'Sage', 'edit', 'notes/report.md', false],
    ['a shell write to prose in a folder that is not a git checkout', 1, 'Sage', 'redirect', 'report.md', false],
    ['a read-only shell command in a folder that is not a git checkout', 1, 'Sage', 'read', 'report.md', false],
    ['a shell write to code past the 20-folder cap', 21, 'Sage', 'redirect', 'src/a.ts', true],
    ['a check that writes nothing', 1, 'Sage', 'check', 'report.md', false],
    ['the reviewer running his checks', 1, 'Argus', 'check', 'report.md', false],
    ['the reviewer editing code through a script', 1, 'Argus', 'script', 'src/a.ts', true],
    ['a code write hidden in a heredoc substitution', 1, 'Sage', 'heredoc', 'src/a.ts', true],
    ['a code write hidden in a quoted substitution', 1, 'Sage', 'substitution', 'src/a.ts', true],
    ['a writing shell command in a folder Manor cannot walk', 1, 'Sage', 'blind-write', 'src/a.ts', true],
    ['a read in a folder Manor cannot walk', 1, 'Sage', 'blind-read', 'report.md', false],
    ['a substitution in a cd in a folder Manor cannot walk', 1, 'Sage', 'blind-cd', 'src/a.ts', true],
    ['a redirect on a cd in a folder Manor cannot walk', 1, 'Sage', 'blind-cd-redirect', 'src/a.ts', true],
    ['a redirect on a cd in a shared folder', 1, 'Sage', 'cd-redirect', 'a.ts', true],
  ] as const)('counts %s as changed code only when it changed code', async (_case, folders, speaker, via, file, gated) => {
    const roots = Array.from({ length: folders }, () => mkdtempSync(path.join(os.tmpdir(), 'manor-turn-blind-')))
    const root = roots[0] as string
    const target = path.join(root, file)
    const command = {
      edit: '',
      redirect: `cd ${root} && printf x > ${file}`,
      read: `cd ${root} && cat ${file}`,
      check: 'pnpm exec vitest run',
      script: `cd ${root} && python3 fix.py ${file}`,
      heredoc: `cd ${root} && cat > report.md <<EOF\n$(printf x > ${file})\nEOF`,
      substitution: `cd ${root} && echo "$(printf x > ${file})"`,
      'blind-write': `cd ${root} && printf x > ${file}`,
      'blind-read': `cd ${root} && cat ${file}`,
      'blind-cd': `cd "$(printf x > ${file}; printf .)"`,
      'blind-cd-redirect': `cd ${root} && cd . > ${file}`,
      'cd-redirect': `cd ${root} && cd . > ${file}`,
    }[via]
    const writes = via === 'edit' || via === 'redirect' || via === 'script' || via === 'heredoc' || via === 'substitution' || via === 'cd-redirect'
    try {
      // Unreadable, so neither git nor a walk can measure it.
      if (via.startsWith('blind')) await chmod(root, 0o000)
      const driver: Driver = {
        startTurn() {
          const queue = new AsyncQueue<RuntimeEvent>()
          void (async () => {
            queue.push(via === 'edit'
              ? { type: 'tool_use', toolCallId: 'w', tool: 'Edit', detail: target, edits: [{ path: target, before: '', after: 'x' }] }
              : { type: 'tool_use', toolCallId: 'w', tool: 'Shell', detail: command, command })
            if (writes) {
              await mkdir(path.dirname(target), { recursive: true })
              await writeFile(target, 'x')
            }
            queue.push({ type: 'tool_result', toolCallId: 'w', outcome: 'success' })
            queue.push({ type: 'result', text: 'Done.', sessionId: 's' })
            queue.close()
          })()
          return { events: queue, stop: () => queue.close() }
        },
      }
      const agents = [...roster, { ...sage, id: 'argus', name: 'Argus' }]
      const store = createMemoryStore({ agents })
      const { chatId, projectId } = await seededChat(store)
      await store.updateProject(projectId, 'Manor', roots)
      const orchestrator = new Orchestrator({
        agents: () => agents,
        store,
        mcpServers: () => [],
        resolveDriver: () => driver,
        ensureScratchDir: scratchFor,
        emit: () => undefined,
      })

      await orchestrator.submitUserMessage(chatId, `@${speaker} work in the folder`)

      const result = (await store.loadEvents(chatId)).find((event) => event.type === 'turn_result')
      expect(result?.agentId).toBe(speaker.toLowerCase())
      const changedCode = result?.type === 'turn_result' &&
        (result.fileChangesFailed === true || (result.fileChangeUnmeasured ?? []).some((changed) => !isProse(changed)))
      expect(changedCode).toBe(gated)
    } finally {
      await chmod(root, 0o700)
      await Promise.all(roots.map((folder) => rm(folder, { recursive: true, force: true })))
    }
  })

  it('records a shared working copy delta only for files the turn named', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'manor-turn-shared-'))
    try {
      execFileSync('git', ['init', '-q'], { cwd: root })
      await writeFile(path.join(root, '.gitignore'), 'local-*.md\n')
      const command = "python3 - <<'EOF'\npathlib.Path('src/named.ts').write_text('landed')\nEOF"
      const ignored = path.join(root, 'local-notes.md')
      const driver: Driver = {
        startTurn() {
          const queue = new AsyncQueue<RuntimeEvent>()
          void (async () => {
            queue.push({ type: 'tool_use', toolCallId: 'edit', tool: 'Edit', detail: ignored,
              edits: [{ path: ignored, before: '', after: 'mine' }] })
            await writeFile(ignored, 'mine\n')
            queue.push({ type: 'tool_result', toolCallId: 'edit', outcome: 'success' })
            queue.push({ type: 'tool_use', toolCallId: 'shell', tool: 'Shell', detail: command, command })
            await mkdir(path.join(root, 'src'), { recursive: true })
            await writeFile(path.join(root, 'src', 'named.ts'), 'landed\n')
            // Another chat or editor writing into the same checkout meanwhile.
            await writeFile(path.join(root, 'src', 'elsewhere.ts'), 'not this turn\n')
            queue.push({ type: 'tool_result', toolCallId: 'shell', outcome: 'success' })
            queue.push({ type: 'result', text: 'Done.', sessionId: 'shared-session' })
            queue.close()
          })()
          return { events: queue, stop: () => queue.close() }
        },
      }
      const store = createMemoryStore({ agents: roster })
      const { chatId, projectId } = await seededChat(store)
      await store.updateProject(projectId, 'Manor', [root])
      const orchestrator = new Orchestrator({
        agents: () => roster,
        store,
        mcpServers: () => [],
        resolveDriver: () => driver,
        ensureScratchDir: scratchFor,
        emit: () => undefined,
      })

      await orchestrator.submitUserMessage(chatId, '@Sage change a file')

      const result = (await store.loadEvents(chatId)).find((event) => event.type === 'turn_result')
      expect(result?.fileChanges?.map((change) => change.path)).toEqual([path.join(root, 'src', 'named.ts')])
      expect(result?.fileChangeRoots).toEqual([root])
      expect(result?.fileChangeUnmeasured).toEqual([ignored])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('leaves out a file another Session changed that this one only ran, so it neither joins the result nor blocks the commit', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'manor-turn-ran-'))
    try {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).trim()
      const script = path.join(root, '.cursor', 'skills', 'verify-manor', 'control-manor.mjs')
      const own = path.join(root, 'src', 'own.ts')
      git('init', '-q', '-b', 'main')
      git('config', 'user.name', 'Test')
      git('config', 'user.email', 'test@example.test')
      await mkdir(path.dirname(script), { recursive: true })
      await mkdir(path.dirname(own), { recursive: true })
      await writeFile(script, 'launch\n')
      await writeFile(own, 'before\n')
      git('add', '.')
      git('commit', '-qm', 'Initial')
      // The command Codex ran on 2026-10-11, from the repo root.
      const command = "/bin/zsh -lc 'MANOR_VERIFY_PORT=43181 node .cursor/skills/verify-manor/control-manor.mjs launch'"
      const driver: Driver = {
        startTurn() {
          const queue = new AsyncQueue<RuntimeEvent>()
          void (async () => {
            queue.push({ type: 'tool_use', toolCallId: 'edit', tool: 'Edit', detail: own, edits: [{ path: own, before: 'before\n', after: 'mine\n' }] })
            await writeFile(own, 'mine\n')
            queue.push({ type: 'tool_result', toolCallId: 'edit', outcome: 'success' })
            queue.push({ type: 'tool_use', toolCallId: 'run', tool: 'Shell', detail: command, command })
            // Another Session edits the script in the same checkout meanwhile.
            await writeFile(script, 'launch\nwith a sqlite store\n')
            queue.push({ type: 'tool_result', toolCallId: 'run', outcome: 'success' })
            queue.push({ type: 'result', text: 'Done.', sessionId: 'ran-session' })
            queue.close()
          })()
          return { events: queue, stop: () => queue.close() }
        },
      }
      const store = createMemoryStore({ agents: roster })
      const { chatId, projectId } = await seededChat(store)
      await store.updateProject(projectId, 'Manor', [root])
      const orchestrator = new Orchestrator({
        agents: () => roster, store, mcpServers: () => [], resolveDriver: () => driver, ensureScratchDir: scratchFor, emit: () => undefined,
      })

      await orchestrator.submitUserMessage(chatId, '@Sage change your file and run the verify script')

      const files = sessionChangedFiles(await store.loadEvents(chatId))
      expect(files).toEqual([own])
      const held = await prepareWorkCompletion([root], files, [])
      expect(held.repos[0]?.files).toEqual(['src/own.ts'])
      git('commit', '-qm', 'This Session', '--', 'src/own.ts')
      expect(await observeWorkCompletion(held)).toMatchObject({ status: 'complete' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('runs chats at once when their project shares linked folders', async () => {
    const { driver, gates, forChat } = gated()
    const store = createMemoryStore({ agents: roster })
    const { chatId: first, projectId } = await seededChat(store)
    const second = (await store.createChat({ projectId, title: 'Second' })).id
    await store.updateProject(projectId, 'Manor', ['/repos/manor'])
    const orchestrator = new Orchestrator({
      agents: () => roster,
      store,
      mcpServers: () => [],
      resolveDriver: () => driver,
      ensureScratchDir: scratchFor,
      emit: () => undefined,
    })

    const runFirst = orchestrator.submitUserMessage(first, '@Sage go')
    const runSecond = orchestrator.submitUserMessage(second, '@Sage hello')

    await until(() => forChat(first).length === 1 && forChat(second).length === 1, 'both linked chats to start')
    expect(gates.map((gate) => gate.input.repoPaths)).toEqual([['/repos/manor'], ['/repos/manor']])

    forChat(first)[0]?.finish()
    forChat(second)[0]?.finish()
    await Promise.all([runFirst, runSecond])

    expect(types(await store.loadEvents(first))).toEqual(['user_message', 'agent_message', 'turn_result'])
    expect(types(await store.loadEvents(second))).toEqual(['user_message', 'agent_message', 'turn_result'])
  })

  it('clears a dead session and retries once with the full chat', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, store, chatId, sent } = await harness(
      scripted((_input, attempt) => {
        if (attempt === 1) return [{ type: 'error', message: `${RESUME_FAILURE_PREFIX}session file is gone` }]
        return [
          { type: 'delta', messageId: 'message-1', text: 'recovered' },
          {
            type: 'result',
            text: 'recovered',
            usage: { inputTokens: 10, outputTokens: 5 },
            sessionId: 'fresh-session',
          },
        ]
      }, seen),
    )

    // A persona mid-conversation: it has spoken before and holds a session id.
    await store.appendEvent(chatId, { type: 'user_message', text: 'earlier', mentions: ['sage'] })
    await store.appendEvent(chatId, {
      type: 'agent_message',
      agentId: 'sage',
      turnId: 'turn_0',
      text: 'earlier reply',
    })
    await store.setSession(chatId, 'sage', 'stale-session', { driver: 'mock' })

    await orchestrator.submitUserMessage(chatId, '@Sage are you still there?')

    expect(seen).toHaveLength(2)
    expect(seen[0]?.sessionId).toBe('stale-session')
    expect(seen[0]?.isFullCatchUp).toBe(false)
    expect(seen[1]?.sessionId).toBeUndefined()
    expect(seen[1]?.isFullCatchUp).toBe(true)
    expect(seen[1]?.catchUp).toHaveLength(3)

    const events = await store.loadEvents(chatId)
    expect(await sessionIdIn(store, chatId, 'sage')).toBe('fresh-session')
    expect(events.filter((event) => event.type === 'agent_message').at(-1)).toMatchObject({
      type: 'agent_message',
      text: 'recovered',
    })
    expect(events.some((event) => event.type === 'system_note')).toBe(false)
    expect(sent.filter((message) => message.type === 'turn_state').at(-1)).toMatchObject({ state: 'done' })
  })

  it('keeps the session and does not retry fresh on an ordinary failure', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, store, chatId } = await harness(
      scripted(() => [{ type: 'error', message: 'the CLI reported a failed turn (error_during_execution)' }], seen),
    )

    await store.appendEvent(chatId, { type: 'agent_message', agentId: 'sage', turnId: 'turn_0', text: 'earlier' })
    await store.setSession(chatId, 'sage', 'live-session', { driver: 'mock' })

    await orchestrator.submitUserMessage(chatId, '@Sage hello?')

    expect(seen).toHaveLength(1)
    expect(await sessionIdIn(store, chatId, 'sage')).toBe('live-session')
  })

  it('gives up with a system note when the fresh retry fails too', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, store, chatId, sent } = await harness(
      scripted(() => [{ type: 'error', message: `${RESUME_FAILURE_PREFIX}still gone` }], seen),
    )

    await store.appendEvent(chatId, { type: 'agent_message', agentId: 'sage', turnId: 'turn_0', text: 'earlier' })
    await store.setSession(chatId, 'sage', 'stale-session', { driver: 'mock' })

    await orchestrator.submitUserMessage(chatId, '@Sage hello?')

    expect(seen).toHaveLength(2)
    expect((await store.loadEvents(chatId)).at(-1)).toMatchObject({
      type: 'system_note',
      kind: 'error',
      agentId: 'sage',
    })
    expect(sent.filter((message) => message.type === 'turn_state').at(-1)).toMatchObject({ state: 'error' })
  })

  describe('a session per provider', () => {
    /** Each provider mints its own ids, so a resumed session is told apart from a seeded one. */
    const perProvider = (seen: TurnInput[], expired: ReadonlySet<string> = new Set()) => scripted((input, attempt) => {
      if (input.sessionId !== undefined && expired.has(input.sessionId)) {
        return [{ type: 'error', message: `${RESUME_FAILURE_PREFIX}no conversation found` }]
      }
      const text = `Answer ${attempt} on ${input.agent.driver}.`
      return [
        { type: 'delta', messageId: `message-${attempt}`, text },
        { type: 'result', text, sessionId: input.sessionId ?? `${input.agent.driver}-session-${attempt}` },
      ]
    }, seen)
    /** What a provider was told, in the words the user and the persona used. */
    const told = (input: TurnInput | undefined) => input?.catchUp.flatMap((event) =>
      event.type === 'user_message' || event.type === 'agent_message' ? [event.text] : [])
    const sessionsOf = async (store: Store, chatId: string) =>
      (await store.getSessions(chatId, 'sage')).map(({ driver, sessionId }) => [driver, sessionId])

    it('resumes the session a provider left, caught up on only what happened since its own turn', async () => {
      const seen: TurnInput[] = []
      const { orchestrator, store, chatId } = await harness(perProvider(seen))

      await orchestrator.setOverride(chatId, 'sage', { driver: 'claude' })
      await orchestrator.submitUserMessage(chatId, '@Sage read the brief')
      await orchestrator.setOverride(chatId, 'sage', { driver: 'codex' })
      await orchestrator.submitUserMessage(chatId, '@Sage one turn on Codex')
      await orchestrator.setOverride(chatId, 'sage', { driver: 'claude' })
      await orchestrator.submitUserMessage(chatId, '@Sage back on Claude')

      // A first visit to each provider starts its own session from the whole thread.
      expect(seen.slice(0, 2).map((input) => [input.agent.driver, input.sessionId, input.isFullCatchUp]))
        .toEqual([['claude', undefined, true], ['codex', undefined, true]])
      expect(told(seen[1])).toEqual(['@Sage read the brief', 'Answer 1 on claude.', '@Sage one turn on Codex'])
      // Back on Claude, the session that read the brief resumes, and hears only what
      // came after its own turn: Codex's turn included, nothing it already holds.
      expect(seen[2]).toMatchObject({ sessionId: 'claude-session-1', isFullCatchUp: false })
      expect(told(seen[2])).toEqual(['@Sage one turn on Codex', 'Answer 2 on codex.', '@Sage back on Claude'])
      expect(seen[2]?.catchUp.flatMap((event) => event.type === 'turn_result' ? [event.driver] : [])).toEqual(['codex'])
      // Codex's session survived the switch back, and resumes the same way.
      expect(await sessionsOf(store, chatId)).toEqual([['claude', 'claude-session-1'], ['codex', 'codex-session-2']])
      await orchestrator.setOverride(chatId, 'sage', { driver: 'codex' })
      await orchestrator.submitUserMessage(chatId, '@Sage Codex again')
      expect(seen[3]).toMatchObject({ sessionId: 'codex-session-2', isFullCatchUp: false })
      expect(told(seen[3])).toEqual(['@Sage back on Claude', 'Answer 3 on claude.', '@Sage Codex again'])
    })

    it('reseeds only the provider whose old session can no longer be resumed', async () => {
      const seen: TurnInput[] = []
      const expired = new Set<string>()
      const { orchestrator, store, chatId } = await harness(perProvider(seen, expired))

      await orchestrator.setOverride(chatId, 'sage', { driver: 'claude' })
      await orchestrator.submitUserMessage(chatId, '@Sage read the brief')
      await orchestrator.setOverride(chatId, 'sage', { driver: 'codex' })
      await orchestrator.submitUserMessage(chatId, '@Sage one turn on Codex')
      // Left long enough for the CLI to forget it.
      expired.add('claude-session-1')
      await orchestrator.setOverride(chatId, 'sage', { driver: 'claude' })
      await orchestrator.submitUserMessage(chatId, '@Sage back on Claude')

      expect(seen.slice(2).map((input) => [input.sessionId, input.isFullCatchUp]))
        .toEqual([['claude-session-1', false], [undefined, true]])
      expect(told(seen[3])).toEqual([
        '@Sage read the brief', 'Answer 1 on claude.', '@Sage one turn on Codex', 'Answer 2 on codex.', '@Sage back on Claude',
      ])
      expect(await sessionsOf(store, chatId)).toEqual([['claude', 'claude-session-4'], ['codex', 'codex-session-2']])
      // Recovered without a word to the user.
      expect((await store.loadEvents(chatId)).some((event) => event.type === 'system_note')).toBe(false)
    })

    it('rolls over a provider session whose canon passed the ceiling while another provider talked', async () => {
      const seen: TurnInput[] = []
      const { orchestrator, store, chatId } = await harness(perProvider(seen))

      await orchestrator.setOverride(chatId, 'sage', { driver: 'claude' })
      await orchestrator.submitUserMessage(chatId, '@Sage read the brief')
      await orchestrator.setOverride(chatId, 'sage', { driver: 'codex' })
      await orchestrator.submitUserMessage(chatId, `@Sage ${'n'.repeat(SESSION_CEILING_CHARS)}`)
      await orchestrator.setOverride(chatId, 'sage', { driver: 'claude' })
      await orchestrator.submitUserMessage(chatId, '@Sage back on Claude')

      expect(seen[2]?.sessionId).toBeUndefined()
      expect(seen[2]?.isFullCatchUp).toBe(true)
      expect(await sessionsOf(store, chatId)).toEqual([['claude', 'claude-session-3'], ['codex', 'codex-session-2']])
    })
  })

  it('silently resumes one provider-proven transport interruption', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, store, chatId, sent } = await harness(
      scripted((_input, attempt) => attempt === 1
        ? [{
            type: 'error',
            message: 'temporary transport reset',
            retryable: true,
            sessionId: 'thread-recoverable',
            usage: { inputTokens: 7, outputTokens: 2 },
          }]
        : [{
            type: 'result',
            text: 'Recovered cleanly.',
            sessionId: 'thread-recoverable',
            usage: { inputTokens: 5, outputTokens: 3 },
          }],
      seen),
    )

    await orchestrator.submitUserMessage(chatId, '@Sage go')

    expect(seen).toHaveLength(2)
    expect(seen[1]).toMatchObject({
      sessionId: 'thread-recoverable',
      isFullCatchUp: false,
    })
    expect(seen[1]?.catchUp).toEqual([
      expect.objectContaining({ type: 'system_note', text: PROVIDER_RECOVERY_NUDGE }),
    ])
    const events = await store.loadEvents(chatId)
    expect(events.some((event) => event.type === 'system_note')).toBe(false)
    expect(events.find((event) => event.type === 'turn_result')).toMatchObject({
      usage: { inputTokens: 12, outputTokens: 5 },
    })
    expect(sent.filter((message) => message.type === 'turn_state').at(-1)).toMatchObject({ state: 'done' })
  })

  it('reports a retryable transport interruption after its one recovery also fails', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, store, chatId, sent } = await harness(
      scripted(() => [{
        type: 'error',
        message: 'temporary transport reset',
        retryable: true,
        sessionId: 'thread-recoverable',
      }], seen),
    )

    await orchestrator.submitUserMessage(chatId, '@Sage go')

    expect(seen).toHaveLength(2)
    expect((await store.loadEvents(chatId)).at(-1)).toMatchObject({
      type: 'system_note',
      kind: 'error',
      text: 'Sage could not answer: temporary transport reset',
    })
    expect(sent.filter((message) => message.type === 'turn_state').at(-1)).toMatchObject({ state: 'error' })
  })

  // Everything below this point is about the two ways a turn used to disappear:
  // dying without saying so, and running without anyone being told.
  it('ends a turn that dies on an internal failure, and stops its process', async () => {
    const stops: string[] = []
    const { driver } = endless(stops)
    const store = appendFailsOn(createMemoryStore({ agents: roster }), (draft) => draft.type === 'agent_message')
    const { chatId } = await seededChat(store)
    const sent: ServerMessage[] = []
    const orchestrator = new Orchestrator({
      agents: () => roster,
      store,
      mcpServers: () => [],
      resolveDriver: () => driver,
      ensureScratchDir: scratchFor,
      emit: (message) => sent.push(message),
    })

    // Resolves rather than rejecting: the failure is reported in the chat, not
    // thrown past the queue into a console nobody reads.
    await orchestrator.submitUserMessage(chatId, '@Sage go')

    const states = sent.filter((message) => message.type === 'turn_state')
    expect(states.map((message) => message.state)).toEqual(['running', 'error'])
    expect((await store.loadEvents(chatId)).at(-1)).toMatchObject({
      type: 'system_note',
      kind: 'error',
      agentId: 'sage',
      text: "Sage's turn ended on an internal failure: the store lost the connection",
    })
    // The stream was never going to end by itself; without the stop the CLI would
    // still be running with nobody reading it.
    expect(stops).toEqual(['sage'])
    expect(orchestrator.activeTurn(chatId)).toBeUndefined()
  })

  it('rides out a store that blinks, and finishes the turn with a whole transcript', async () => {
    // The case the retry exists for. Before it, one failed append 35 tools into a
    // 40-tool turn ended the turn and killed the CLI child; the store was fine again
    // 50 ms later.
    const failing = appendFailsTimes(createMemoryStore({ agents: roster }), 2)
    const { chatId } = await seededChat(failing.store)
    const sent: ServerMessage[] = []
    const orchestrator = new Orchestrator({
      agents: () => roster,
      store: failing.store,
      mcpServers: () => [],
      resolveDriver: () => createMockDriver({ deltaDelayMs: 0 }),
      ensureScratchDir: scratchFor,
      emit: (message) => sent.push(message),
    })

    await orchestrator.submitUserMessage(chatId, '@Sage go')

    // The user message itself was the write that failed twice, so the whole turn
    // hangs off an append that only landed on its third attempt.
    expect(types(await failing.store.loadEvents(chatId))).toEqual([
      'user_message',
      'reasoning',
      'agent_message',
      'turn_result',
    ])
    expect(sent.filter((message) => message.type === 'turn_state').map((message) => message.state)).toEqual([
      'running',
      'done',
    ])
    // Three tries for the first event, then one each for the rest.
    expect(failing.attempts()).toBe(6)
  })

  it('gives up loudly when the store never comes back, and appends nothing after the gap', async () => {
    // The other half of the same rule. A transcript with a hole in it is worse than a
    // failed turn, because `composeCatchUp` reads it back into the model as if it
    // were complete, so the turn stops rather than streaming on past the loss.
    const stops: string[] = []
    const { driver } = endless(stops)
    const store = appendFailsOn(createMemoryStore({ agents: roster }), (draft) => draft.type === 'agent_message')
    const { chatId } = await seededChat(store)
    const sent: ServerMessage[] = []
    const orchestrator = new Orchestrator({
      agents: () => roster,
      store,
      mcpServers: () => [],
      resolveDriver: () => driver,
      ensureScratchDir: scratchFor,
      emit: (message) => sent.push(message),
    })

    await orchestrator.submitUserMessage(chatId, '@Sage go')

    // Nothing of the turn's own work is in the transcript: the message that could not
    // be written is not there, and no later event was written over the gap.
    const events = await store.loadEvents(chatId)
    expect(types(events)).toEqual(['user_message', 'system_note'])
    // The failure reached the client over the socket, which is the part that may not
    // depend on the store: the note above is best-effort, this is not.
    expect(sent.filter((message) => message.type === 'turn_state').map((message) => message.state)).toEqual([
      'running',
      'error',
    ])
    expect(stops).toEqual(['sage'])
    expect(orchestrator.activeTurn(chatId)).toBeUndefined()
  })

  it('keeps a mid-turn error that the turn recovered from as a note', async () => {
    const { orchestrator, store, chatId, sent } = await harness(
      scripted(
        () => [
          { type: 'error', message: 'a tool crashed' },
          { type: 'message', messageId: 'answer', text: 'Recovered.' },
          { type: 'result', text: 'Recovered.', sessionId: 'session-1' },
        ],
        [],
      ),
    )

    await orchestrator.submitUserMessage(chatId, '@Sage go')

    const events = await store.loadEvents(chatId)
    expect(types(events)).toEqual(['user_message', 'agent_message', 'system_note', 'turn_result'])
    expect(events.find((event) => event.type === 'system_note')).toMatchObject({
      kind: 'info',
      agentId: 'sage',
      turnId: expect.any(String),
      trace: true,
      text: 'Problem mid-turn, carried on: a tool crashed',
    })
    // The answer still arrived, so the turn is done and not failed.
    expect(sent.filter((message) => message.type === 'turn_state').at(-1)).toMatchObject({ state: 'done' })
  })

  it('names the turn a chat is running, with the clock the client counts from', async () => {
    const { driver, gates } = gated()
    const { orchestrator, chatId, sent } = await harness(driver)
    const before = Date.now()

    const running = orchestrator.submitUserMessage(chatId, '@Sage go')
    await until(() => gates.length === 1, 'the turn to start')

    const announced = sent.find((message) => message.type === 'turn_state' && message.state === 'running')
    const active = orchestrator.activeTurn(chatId)
    expect(orchestrator.activeChatIds()).toEqual([chatId])
    expect(active?.agentId).toBe('sage')
    expect(active?.turnId).toBe(announced?.type === 'turn_state' ? announced.turnId : '')
    // The same clock in both places: a reconnect must not restart the timer.
    expect(active?.startedAt).toBe(announced?.type === 'turn_state' ? announced.startedAt : undefined)
    expect(active?.startedAt).toBeGreaterThanOrEqual(before)

    gates[0]?.finish()
    await running
    expect(orchestrator.activeTurn(chatId)).toBeUndefined()
    expect(orchestrator.activeChatIds()).toEqual([])
  })

  it('starts no provider when Stop lands during the turn\'s file snapshot', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'stop-snapshot-'))
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let capturing = false
    const capture = vi.spyOn(snapshots, 'captureTurnTree').mockImplementation(async () => {
      capturing = true
      await gate
      return 'tree'
    })
    const startTurn = vi.fn(() => {
      const queue = new AsyncQueue<RuntimeEvent>()
      queue.push({ type: 'result', text: 'Done.' })
      queue.close()
      return { events: queue, stop() {} }
    })
    const { orchestrator, store, chatId, projectId, sent } = await harness({ startTurn })
    try {
      await store.updateProject(projectId, 'Manor', [root])
      const running = orchestrator.submitUserMessage(chatId, '@Sage go')
      await until(() => capturing, 'the file snapshot')
      orchestrator.stop(await waitForRunning(sent, chatId))
      release()
      await running
      expect(startTurn).not.toHaveBeenCalled()
      expect((await store.loadEvents(chatId)).some((event) =>
        event.type === 'system_note' && event.kind === 'aborted' && event.text === "Sage's turn was stopped.")).toBe(true)
    } finally {
      release()
      capture.mockRestore()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps unfinished provider text through Stop and marks it as interrupted', async () => {
    const stops: string[] = []
    const { driver } = partialEndless(stops)
    const { orchestrator, store, chatId, sent } = await harness(driver)

    const running = orchestrator.submitUserMessage(chatId, '@Sage go')
    await until(
      () => (orchestrator.activeTurn(chatId)?.messages[0]?.text ?? '') === 'half an answer',
      'the partial reply to reach the active turn',
    )
    const turnId = await waitForRunning(sent, chatId)
    orchestrator.stop(turnId)
    await running

    const events = await store.loadEvents(chatId)
    expect(events.filter((event) => event.type === 'agent_message')).toEqual([
      expect.objectContaining({
        type: 'agent_message',
        messageId: 'attempt_1:message-1',
        text: 'half an answer',
        interrupted: true,
      }),
    ])
    expect(events.at(-1)).toMatchObject({ type: 'system_note', kind: 'aborted' })
    expect(stops).toContain('sage')
  })

  it('settles a Stop on a CLI that ignores SIGTERM, KILLs it and takes the next message', async () => {
    const pids: number[] = []
    const cli = `process.on('SIGTERM', () => {}); process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }) + '\\n'); setInterval(() => {}, 1000)`
    const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
    const { orchestrator, store, chatId, sent } = await harness(createClaudeDriver({ agents: () => roster, command: 'fake', spawnFn: () => {
      const child = spawn(process.execPath, ['-e', cli], { stdio: ['pipe', 'pipe', 'pipe'], detached: true })
      pids.push(child.pid!)
      return child
    } }))
    const runningTurns = () => sent.flatMap((message) => message.type === 'turn_state' && message.state === 'running' ? [message.turnId] : [])
    try {
      for (const [index, text] of ['@Sage go', '@Sage again'].entries()) {
        const turn = orchestrator.submitUserMessage(chatId, text)
        await vi.waitFor(() => expect(runningTurns()[index] !== undefined && pids[index] !== undefined).toBe(true), { timeout: 5_000 })
        orchestrator.stop(runningTurns()[index]!)
        await turn
        expect(orchestrator.activeTurn(chatId)).toBeUndefined()
        expect(sent).toContainEqual(expect.objectContaining({ type: 'turn_state', turnId: runningTurns()[index], state: 'aborted' }))
        await vi.waitFor(() => expect(alive(pids[index]!)).toBe(false), { timeout: 4_000, interval: 50 })
      }
      expect((await store.loadEvents(chatId)).map((event) => event.type === 'system_note' ? `note:${event.kind}` : event.type))
        .toEqual(['user_message', 'note:aborted', 'user_message', 'note:aborted'])
    } finally {
      for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL')
    }
  }, 20_000)

  it('keeps unfinished provider text when the driver fails', async () => {
    const { orchestrator, store, chatId } = await harness(
      scripted(
        () => [
          { type: 'delta', messageId: 'answer', text: 'I got as far as this' },
          { type: 'error', message: 'stream disconnected' },
        ],
        [],
      ),
    )

    await orchestrator.submitUserMessage(chatId, '@Sage go')

    expect(types(await store.loadEvents(chatId))).toEqual([
      'user_message',
      'agent_message',
      'system_note',
    ])
    expect((await store.loadEvents(chatId))[1]).toMatchObject({
      type: 'agent_message',
      text: 'I got as far as this',
      interrupted: true,
    })
  })

  it('does not retry an error that is not a lost session', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, store, chatId } = await harness(
      scripted(() => [{ type: 'error', message: 'API Error: 529 overloaded_error' }], seen),
    )

    await orchestrator.submitUserMessage(chatId, '@Smith ping')

    expect(seen).toHaveLength(1)
    expect((await store.loadEvents(chatId)).at(-1)).toMatchObject({
      type: 'system_note',
      kind: 'error',
      text: 'Smith could not answer: API Error: 529 overloaded_error',
    })
  })

  it('lets a former DM-only agent be mentioned in a group, alone or with others, and keeps its own DM', async () => {
    const watcher = { ...sage, id: 'watcher', name: 'Watcher', placement: 'chat' as const }
    const chatSage = { ...sage, placement: 'chat' as const }
    const seen: TurnInput[] = []
    const { orchestrator, store } = await harness(
      recording(createMockDriver({ deltaDelayMs: 0 }), seen),
      { agents: [chatSage, watcher] },
    )

    const group = await store.createChat({ kind: 'group', memberIds: [chatSage.id, watcher.id], title: 'House' })
    await orchestrator.submitUserMessage(group.id, '@Watcher inspect this')
    await until(() => seen.length === 1, 'the mentioned turn')
    await orchestrator.submitUserMessage(group.id, '@Watcher @Sage both look')
    await until(() => seen.length === 3, 'both mentioned turns')
    expect(seen.map((input) => input.agent.id)).toEqual(['watcher', 'watcher', 'sage'])

    const dm = await store.createChat({ kind: 'dm', memberIds: [watcher.id], title: watcher.name })
    await orchestrator.submitUserMessage(dm.id, 'Inspect this')
    await until(() => seen.length === 4, 'the DM turn')
    expect(seen.at(-1)?.agent.id).toBe('watcher')
  })
})

const brainstormSkill: SkillConfig = {
  id: 'brainstorm',
  name: 'Brainstorm',
  description: 'Explore alternatives.',
  instructions: 'Generate three distinct approaches before choosing one.',
  sources: ['claude', 'codex'],
}

describe('Orchestrator, turn-scoped skills', () => {
  it.each(['claude', 'codex', 'grok', 'cursor'] as const)(
    'offers attached skills for implicit activation and counts a successful read on %s',
    async (driverName) => {
      const seen: TurnInput[] = []
      const used: Array<{ skillIds: readonly string[]; driver: AgentConfig['driver'] }> = []
      const cache = path.join(mkdtempSync(path.join(os.tmpdir(), 'manor-auto-skill-')), 'not-a-directory')
      await writeFile(cache, 'The automatic catalog must not touch this path.')
      let readSkill: ((skillId: string) => void) | undefined
      let revoked = 0
      const skilled = roster.map((agent) => agent.id === 'sage'
        ? { ...agent, driver: driverName, skillIds: ['brainstorm'] }
        : agent)
      const { orchestrator, store, chatId } = await harness(
        scripted(() => {
          readSkill?.('brainstorm')
          return [{ type: 'result', text: 'Done.', sessionId: 'session' }]
        }, seen),
        {
          agents: skilled,
          skills: [brainstormSkill],
          skillCacheDir: cache,
          skillMcp: (skillIds, onSkillRead) => {
            expect(skillIds).toEqual(['brainstorm'])
            readSkill = onSkillRead
            return {
              attachment: skillMcpAttachment('http://127.0.0.1/internal/skill-file', 'capability'),
              revoke: () => { revoked += 1 },
            }
          },
          onSkillsUsed: (skillIds, driver) => used.push({ skillIds, driver }),
        },
      )

      await orchestrator.submitUserMessage(chatId, '@Sage shape this feature')

      expect(seen[0]?.agent.character).toContain(brainstormSkill.description)
      expect(seen[0]?.agent.character).toContain('mcp__skills__read_skill')
      expect(seen[0]?.agent.character).not.toContain(brainstormSkill.instructions)
      expect(seen[0]?.mcpServers?.map(({ server }) => server.name)).toContain('skills')
      expect(used).toEqual([{ skillIds: ['brainstorm'], driver: driverName }])
      expect(revoked).toBe(1)
      expect((await store.loadEvents(chatId))[0]).not.toHaveProperty('skillIds')
    },
  )

  it.each(['claude', 'codex', 'grok', 'cursor'] as const)(
    'refreshes new, removed and reattached skills between turns on %s',
    async (driver) => {
      const seen: TurnInput[] = []
      const agents = [{ ...sage, driver, skillIds: ['brainstorm'] }, smith]
      const skills = [brainstormSkill]
      const { orchestrator, chatId } = await harness(
        scripted(() => [{ type: 'result', text: 'Done.', sessionId: 'existing' }], seen),
        { agents, skills },
      )
      await orchestrator.submitUserMessage(chatId, '@Sage answer')
      expect(seen.at(-1)?.agent.character).toContain('$brainstorm')
      skills.push({ ...brainstormSkill, id: 'new-skill', name: 'New skill', description: 'Newly created capability.' })
      agents[0] = { ...sage, driver, skillIds: ['new-skill'] }
      await orchestrator.submitUserMessage(chatId, '@Sage answer again')
      expect(seen.at(-1)?.agent.character).toContain('$new-skill')
      expect(seen.at(-1)?.agent.character).not.toContain('$brainstorm')
      agents[0] = { ...sage, driver, skillIds: [] }
      await orchestrator.submitUserMessage(chatId, '@Sage answer again')
      expect(seen.at(-1)?.agent.character).not.toContain('[Manor] Skills available to you:')
      agents[0] = { ...sage, driver, skillIds: ['brainstorm', 'new-skill'] }
      await orchestrator.submitUserMessage(chatId, '@Sage answer again')
      expect(seen.at(-1)?.agent.character).toContain('$brainstorm')
      expect(seen.at(-1)?.agent.character).toContain('$new-skill')
      await orchestrator.submitUserMessage(chatId, '@Smith answer')
      expect(seen.at(-1)?.agent.character).not.toContain('$new-skill')
    },
  )

  it('does not count an implicit activation whose SKILL.md read fails', async () => {
    const used: string[] = []
    let revoked = 0
    const skilled = roster.map((agent) => agent.id === 'sage'
      ? { ...agent, driver: 'claude' as const, skillIds: ['brainstorm'] }
      : agent)
    const { orchestrator, store, chatId } = await harness(
      scripted(() => [
        { type: 'result', text: 'Could not load it.', sessionId: 'session' },
      ], []),
      {
        agents: skilled,
        skills: [brainstormSkill],
        skillMcp: () => ({
          attachment: skillMcpAttachment(
            'http://127.0.0.1/internal/skill-file',
            'capability',
          ),
          revoke: () => { revoked += 1 },
        }),
        onSkillsUsed: (skillIds) => used.push(...skillIds),
      },
    )

    await orchestrator.submitUserMessage(chatId, '@Sage shape this feature')

    expect(used).toEqual([])
    expect(revoked).toBe(1)
  })

  it('injects a selected attached skill and persists the selection on the user message', async () => {
    const seen: TurnInput[] = []
    const skilled = roster.map((agent) => agent.id === 'sage' ? { ...agent, skillIds: ['brainstorm'] } : agent)
    const { orchestrator, store, chatId } = await harness(recording(createMockDriver({ deltaDelayMs: 0 }), seen), {
      agents: skilled,
      skills: [brainstormSkill],
    })

    await orchestrator.submitUserMessage(chatId, '@Sage $brainstorm shape this feature')

    expect(handed(seen[0])).toContain(brainstormSkill.instructions)
    expect((await store.loadEvents(chatId))[0]).toMatchObject({
      type: 'user_message',
      skillIds: ['brainstorm'],
    })
  })

  it('keeps the prompt the same whether or not a turn selects an attached skill', async () => {
    const seen: TurnInput[] = []
    const skilled = roster.map((agent) => agent.id === 'sage' ? { ...agent, skillIds: ['brainstorm'] } : agent)
    const { orchestrator, chatId } = await harness(recording(createMockDriver({ deltaDelayMs: 0 }), seen), {
      agents: skilled,
      skills: [brainstormSkill],
    })
    await orchestrator.submitUserMessage(chatId, '@Sage shape this feature')
    await orchestrator.submitUserMessage(chatId, '@Sage $brainstorm shape this feature')
    await orchestrator.submitUserMessage(chatId, '@Sage shape this feature')
    expect(new Set(seen.map((input) => input.agent.character)).size).toBe(1)
    expect(seen.map((input) => input.volatileBlocks?.some((block) => block.key === 'selected-skills') ?? false)).toEqual([false, true, false])
  })

  it('applies a manually typed skill only when every addressed agent holds it', async () => {
    const seen: TurnInput[] = []
    const mixed = roster.map((agent) => agent.id === 'sage' ? { ...agent, skillIds: ['brainstorm'] } : agent)
    const { orchestrator, chatId } = await harness(recording(createMockDriver({ deltaDelayMs: 0 }), seen), {
      agents: mixed,
      skills: [brainstormSkill],
    })

    await orchestrator.submitUserMessage(chatId, '@Sage @Smith $brainstorm compare this')

    expect(handed(seen.find((turn) => turn.agent.id === 'sage'))).not.toContain(brainstormSkill.instructions)
    expect(handed(seen.find((turn) => turn.agent.id === 'smith'))).not.toContain(brainstormSkill.instructions)
  })

  it('does not carry an originating skill into a summoned turn', async () => {
    const seen: TurnInput[] = []
    const skilled = roster.map((agent) => ({
      ...agent,
      skillIds: ['brainstorm'],
      ...(agent.id === 'smith' ? { mentionAllowlist: ['sage'] } : {}),
    }))
    const { orchestrator, chatId } = await harness(
      scripted((input) => [{
        type: 'result',
        text: input.agent.id === 'smith' ? '@Sage take this' : 'Sage answered',
        sessionId: 's',
      }], seen),
      { agents: skilled, skills: [brainstormSkill] },
    )

    await orchestrator.submitUserMessage(chatId, '@Smith $brainstorm explore this')

    expect(seen.map((turn) => turn.agent.id)).toEqual(['smith', 'sage'])
    expect(handed(seen[0])).toContain(brainstormSkill.instructions)
    expect(handed(seen[1])).not.toContain(brainstormSkill.instructions)
  })

  it('counts a selected skill once on the provider that actually starts, including across a retry', async () => {
    const seen: TurnInput[] = []
    const used: Array<{ skillIds: readonly string[]; driver: AgentConfig['driver'] }> = []
    const skilled = roster.map((agent) => agent.id === 'sage'
      ? { ...agent, driver: 'codex' as const, skillIds: ['brainstorm'] }
      : agent)
    const { orchestrator, store, chatId } = await harness(
      scripted((_input, attempt) => attempt === 1
        ? [{ type: 'error', message: `${RESUME_FAILURE_PREFIX}session file is gone` }]
        : [{ type: 'result', text: 'Recovered.', sessionId: 'fresh-session' }], seen),
      {
        agents: skilled,
        skills: [brainstormSkill],
        onSkillsUsed: (skillIds, driver) => used.push({ skillIds, driver }),
      },
    )
    await store.setSession(chatId, 'sage', 'stale-session', { driver: 'codex' })

    await orchestrator.submitUserMessage(chatId, '@Sage $brainstorm shape this')

    expect(seen).toHaveLength(2)
    expect(used).toEqual([{ skillIds: ['brainstorm'], driver: 'codex' }])
  })

  it('does not count mock runs as real skill usage', async () => {
    const used: string[] = []
    const skilled = roster.map((agent) => agent.id === 'sage' ? { ...agent, skillIds: ['brainstorm'] } : agent)
    const { orchestrator, chatId } = await harness(createMockDriver({ deltaDelayMs: 0 }), {
      agents: skilled,
      skills: [brainstormSkill],
      onSkillsUsed: (skillIds) => used.push(...skillIds),
    })

    await orchestrator.submitUserMessage(chatId, '@Sage $brainstorm shape this')

    expect(used).toEqual([])
  })

  it('does not count a provider failure that produced no activity', async () => {
    const used: string[] = []
    const skilled = roster.map((agent) => agent.id === 'sage'
      ? { ...agent, driver: 'cursor' as const, skillIds: ['brainstorm'] }
      : agent)
    const { orchestrator, chatId } = await harness(
      scripted(() => [{ type: 'error', message: 'could not start agent' }], []),
      {
        agents: skilled,
        skills: [brainstormSkill],
        onSkillsUsed: (skillIds) => used.push(...skillIds),
      },
    )

    await orchestrator.submitUserMessage(chatId, '@Sage $brainstorm shape this')

    expect(used).toEqual([])
  })
})

describe('Orchestrator, prompt apply order', () => {
  it('puts house style last in the prompt, after project memory, with selected skills in their own block', async () => {
    const seen: TurnInput[] = []
    const folder = mkdtempSync(path.join(os.tmpdir(), 'manor-style-'))
    await writeFile(path.join(folder, 'CLAUDE.md'), 'Project memory marker.', 'utf8')
    const skilled = roster.map((agent) => (agent.id === 'sage' ? { ...agent, skillIds: ['brainstorm'] } : agent))
    const { orchestrator, store, chatId, projectId } = await harness(
      recording(createMockDriver({ deltaDelayMs: 0 }), seen),
      { agents: skilled, skills: [brainstormSkill] },
    )
    await store.updateProject(projectId, 'Manor', [folder])

    await orchestrator.submitUserMessage(chatId, '@Sage $brainstorm shape this')

    const character = seen[0]?.agent.character ?? ''
    const memoryAt = character.indexOf('Project memory marker.')
    const styleAt = character.lastIndexOf(HOUSE_STYLE_HEADING)
    expect(memoryAt).toBeGreaterThan(-1)
    expect(styleAt).toBeGreaterThan(memoryAt)
    // A turn's selected skill changes per turn, so it rides in the message, not the prompt.
    expect(character).not.toContain(brainstormSkill.instructions)
    expect(seen[0]?.volatileBlocks?.find((block) => block.key === 'selected-skills')?.text).toContain(brainstormSkill.instructions)
    // Last-instruction-wins: house style is the suffix of the composed character.
    expect(character.slice(styleAt + HOUSE_STYLE_HEADING.length)).not.toContain('[Manor]')
    expect(character.endsWith(HOUSE_STYLE_BLOCK)).toBe(true)
  })

  it('gives a DM turn the chat wrong-agent rule, the DM house style and the DM pin', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, store } = await harness(recording(createMockDriver({ deltaDelayMs: 0 }), seen))
    const dm = await store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })

    await orchestrator.submitUserMessage(dm.id, 'Question')

    const character = seen[0]?.agent.character ?? ''
    expect(character).toContain(WRONG_AGENT_RULE)
    expect(character.endsWith(DM_HOUSE_STYLE_BLOCK)).toBe(true)
    expect(seen[0]?.dm).toBe(true)
  })

  it('sits the routine block just before house style on a run thread', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, store, projectId } = await harness(
      recording(createMockDriver({ deltaDelayMs: 0 }), seen),
    )
    const routine = await store.saveRoutine({
      projectId,
      chatId: null,
      agentId: 'sage',
      name: 'Morning brief',
      prompt: 'Sweep',
      cron: '0 7 * * *',
      timezone: 'Europe/Amsterdam',
      enabled: true,
      notify: false,
      model: null,
      effort: null,
    })
    const run = await store.createChat({
      projectId,
      kind: 'run',
      routineId: routine.id,
      title: 'Morning brief',
    })

    await orchestrator.submitUserMessage(run.id, '@Sage check')

    const character = seen[0]?.agent.character ?? ''
    const routineAt = character.indexOf(ROUTINE_OUTCOME_HEADING)
    const styleAt = character.lastIndexOf(HOUSE_STYLE_HEADING)
    expect(routineAt).toBeGreaterThan(-1)
    expect(styleAt).toBeGreaterThan(routineAt)
    expect(character.slice(styleAt + HOUSE_STYLE_HEADING.length)).not.toContain('[Manor]')
  })
})

describe('Orchestrator, MCP connection context', () => {
  const gmail: McpServerConfig = {
    id: 'gmail',
    name: 'gmail',
    command: 'gmail-mcp',
    args: [],
    envKeys: ['GMAIL_TOKEN'],
    description: 'Read and draft email.',
    writes: true,
    effectPolicy: 'confirm_writes' as const,
    tools: ['get_profile', 'list_messages'],
    readOnlyTools: [],
    schemaChars: 1200,
  }

  it('persists numeric context estimates per persona without exposing supplied text or credentials', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, store, chatId } = await harness(scripted(() => [
      { type: 'result', text: 'Done.', contextTokens: 30_000 },
    ], seen), {
      agents: [
        { ...sage, driver: 'claude', character: 'PRIVATE PERSONA CONTEXT', mcpServers: [{ serverId: gmail.id, disabledTools: [] }] },
        smith,
      ],
      mcpServers: [gmail],
    })
    await orchestrator.submitUserMessage(chatId, '@Sage @Smith check this')
    const results = (await store.loadEvents(chatId)).filter((event) => event.type === 'turn_result')
    expect(results).toHaveLength(2)
    expect(results[0]).toMatchObject({ agentId: 'sage', contextTokens: 30_000, // Two listed names, not the 1200 chars of schemas a deferring driver never loads.
      contextEstimate: { mcpCatalog: 17 } })
    expect(results[1]).toMatchObject({ agentId: 'smith', contextEstimate: { mcpCatalog: 0 } })
    for (const event of results) {
      expect(ThreadEventSchema.safeParse(event).success).toBe(true)
      // Counts stay counts and figures stay {source, tokens}: nothing in the estimate
      // is a place a persona's own text could ride out to a client.
      const { used, window, autoCompactAt, ...counts } = event.contextEstimate ?? {}
      expect(Object.values(counts).every((value) => typeof value === 'number')).toBe(true)
      for (const figure of [used, window, autoCompactAt]) {
        if (figure === undefined) continue
        expect(Object.keys(figure).every((key) => key === 'source' || key === 'tokens')).toBe(true)
      }
    }
    expect(JSON.stringify(results)).not.toContain('PRIVATE PERSONA CONTEXT')
    expect(JSON.stringify(results)).not.toContain('GMAIL_TOKEN')
  })

  // Cursor picks the model itself when none is pinned, and a Claude model reads the
  // same text as about half again as many tokens as chars/4 would say.
  it('sizes supplied text at the rate of the model that answered, not only the pinned one', async () => {
    const instructionsFor = async (reportedModel: string | undefined) => {
      const { orchestrator, store, chatId } = await harness(scripted(() => [
        { type: 'result', text: 'Done.', ...(reportedModel === undefined ? {} : { reportedModel }) },
      ], []), { agents: [{ ...sage, driver: 'cursor', model: undefined, character: 'x'.repeat(27_000) }] })
      await orchestrator.submitUserMessage(chatId, '@Sage check this')
      const result = (await store.loadEvents(chatId)).find((event) => event.type === 'turn_result')
      return result?.type === 'turn_result' ? result.contextEstimate?.instructions ?? 0 : 0
    }
    const unknown = await instructionsFor(undefined)
    expect(await instructionsFor('cursor-claude-opus-5-5')).toBeGreaterThan(unknown * 1.4)
  })

  it('hands an attached connection to the driver and names it in the persona prompt', async () => {
    const seen: TurnInput[] = []
    const connected = roster.map((agent) =>
      agent.id === 'sage'
        ? { ...agent, mcpServers: [{ serverId: gmail.id, disabledTools: [] }] }
        : agent,
    )
    const { orchestrator, chatId } = await harness(
      recording(createMockDriver({ deltaDelayMs: 0 }), seen),
      { agents: connected, mcpServers: [gmail] },
    )

    await orchestrator.submitUserMessage(chatId, '@Sage check my mail')

    expect(seen[0]?.mcpServers?.map(({ server }) => server.id)).toEqual(['gmail'])
    expect(seen[0]?.agent.character).toContain('- gmail — Read and draft email. (tools: mcp__gmail__get_profile, mcp__gmail__list_messages)')
    expect(seen[0]?.agent.character).toContain('Do not answer the lookup from memory')
  })
})

describe('Orchestrator, allowlisted specialist summons', () => {
  /** Smith may summon Sage: the Smith→Argus review shape, on the test roster. */
  const summonRoster = roster.map((agent) =>
    agent.id === 'smith' ? { ...agent, mentionAllowlist: ['sage'] } : agent,
  )

  it('runs the allowlisted persona a specialist mentions, as a delegated turn', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, store, chatId } = await harness(
      scripted((input) => [{
        type: 'result',
        text: input.agent.id === 'smith' ? '@Sage review this change' : 'Sage answered',
        sessionId: 's',
      }], seen),
      { agents: summonRoster },
    )

    await orchestrator.submitUserMessage(chatId, '@Smith build it')

    expect(seen.map((input) => input.agent.id)).toEqual(['smith', 'sage'])
    expect(speakers(await store.loadEvents(chatId))).toEqual([
      ['user_message', 'user'],
      ['agent_message', 'smith'],
      ['agent_message', 'sage'],
    ])
    // The summoned turn sees Smith's request through the ordinary catch-up.
    expect(
      seen[1]?.catchUp.some((event) => event.type === 'agent_message' && event.text.includes('@Sage review')),
    ).toBe(true)
  })

  it('never summons a mention outside the allowlist', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, store, chatId } = await harness(
      scripted(() => [{ type: 'result', text: '@Sage and @Smith should both see this', sessionId: 's' }], seen),
      // Sage holds no allowlist, so her mentions stay inert exactly as before.
      { agents: summonRoster },
    )

    await orchestrator.submitUserMessage(chatId, '@Sage your thoughts')

    expect(seen.map((input) => input.agent.id)).toEqual(['sage'])
    expect((await store.loadEvents(chatId)).filter((event) => event.type === 'agent_message')).toHaveLength(1)
  })

  it('summons only the listed names out of a reply that mentions more', async () => {
    const seen: TurnInput[] = []
    // Smith's allowlist names Sage and nobody else; Marlow exists and is mentioned.
    const partial = cosRoster.map((agent) =>
      agent.id === 'smith' ? { ...agent, mentionAllowlist: ['sage'] } : agent,
    )
    const { orchestrator, chatId } = await harness(
      scripted((input) => [{
        type: 'result',
        text: input.agent.id === 'smith' ? '@Sage and @Marlow, thoughts?' : `${input.agent.name} answered`,
        sessionId: 's',
      }], seen),
      { agents: partial },
    )

    await orchestrator.submitUserMessage(chatId, '@Smith your call')

    // Sage is summoned, the unlisted Marlow mention stays silent by design.
    expect(seen.map((input) => input.agent.id)).toEqual(['smith', 'sage'])
  })

  it('lets a summoned persona run review, fix, recheck, last fix, then stops', async () => {
    const seen: TurnInput[] = []
    const turns: Record<string, number> = { smith: 0, sage: 0 }
    const mutual = roster.map((agent) => ({
      ...agent,
      mentionAllowlist: [agent.id === 'smith' ? 'sage' : 'smith'],
    }))
    const { orchestrator, store, chatId } = await harness(
      scripted((input) => {
        const n = (turns[input.agent.id] ?? 0) + 1
        turns[input.agent.id] = n
        const text =
          input.agent.id === 'smith'
            ? n === 1
              ? '@Sage take a look'
              : n === 2
                ? '@Sage look again'
                : '@Sage still?'
            : n === 1
              ? '@Smith findings'
              : n === 2
                ? '@Smith still issues'
                : '@Smith again'
        return [{ type: 'result', text, sessionId: 's' }]
      }, seen),
      { agents: mutual },
    )

    await orchestrator.submitUserMessage(chatId, '@Smith go')

    // Review, fix, recheck, last fix. The leftover @Sage after that dies on the hop cap.
    expect(seen.map((input) => input.agent.id)).toEqual(['smith', 'sage', 'smith', 'sage', 'smith'])
    expect((await store.loadEvents(chatId)).at(-1)).toMatchObject({
      type: 'system_note',
      kind: 'info',
      agentId: 'smith',
      text: 'Smith stopped after 3 review rounds. Reply to continue.',
    })
  })

  it('does not re-summon someone already in the errand who is not on the review edge', async () => {
    const seen: TurnInput[] = []
    const smithTurns = { n: 0 }
    const generous = cosRoster.map((agent) => ({
      ...agent,
      mentionAllowlist:
        agent.id === 'smith' ? ['sage'] : agent.id === 'sage' ? ['smith', 'marlow'] : [],
    }))
    const { orchestrator, store, chatId } = await harness(
      scripted((input) => {
        if (input.agent.id === 'smith') smithTurns.n += 1
        return [{
          type: 'result',
          text:
            input.agent.id === 'smith'
              ? smithTurns.n === 1
                ? '@Sage review this'
                : 'working on it'
              : input.agent.id === 'sage'
                ? '@Marlow and @Smith both of you'
                : `${input.agent.name} answered`,
          sessionId: 's',
        }]
      }, seen),
      { agents: generous },
    )

    await orchestrator.submitUserMessage(chatId, '@Smith @Marlow both of you')

    // Marlow was addressed by the user, so Sage@Marlow has no edge and stays silent.
    // Sage@Smith is the review callback and runs. Smith's second turn does not
    // mention Sage, so the loop does not continue and hide the silent drop.
    expect(seen.map((input) => input.agent.id)).toEqual(['smith', 'marlow', 'sage', 'smith'])
    expect((await store.loadEvents(chatId)).some((event) => event.type === 'system_note')).toBe(false)
  })

  it('keeps review hops off the first-summon budget', async () => {
    const seen: TurnInput[] = []
    const mutual = roster.map((agent) => ({
      ...agent,
      mentionAllowlist: [agent.id === 'smith' ? 'sage' : 'smith'],
    }))
    const { orchestrator, chatId } = await harness(
      scripted((input) => [{
        type: 'result',
        text: input.agent.id === 'smith' ? '@Sage take a look' : '@Smith findings',
        sessionId: 's',
      }], seen),
      { agents: mutual, delegationCap: 1, reviewHops: 1 },
    )

    await orchestrator.submitUserMessage(chatId, '@Smith go')

    // The one first-summon slot bought Sage; the callback still runs on the review budget.
    expect(seen.map((input) => input.agent.id)).toEqual(['smith', 'sage', 'smith'])
  })

  it('puts the review last when a persona returns to the same errand', async () => {
    const seen: TurnInput[] = []
    const mutual = roster.map((agent) => ({
      ...agent,
      mentionAllowlist: [agent.id === 'smith' ? 'sage' : 'smith'],
    }))
    const { orchestrator, chatId } = await harness(
      scripted((input) => [{
        type: 'result',
        text: input.agent.id === 'smith' ? '@Sage review this' : '@Smith fix this point',
        sessionId: 's',
      }], seen),
      { agents: mutual, reviewHops: 1 },
    )
    await orchestrator.submitUserMessage(chatId, '@Smith build this')
    expect(seen[2]?.catchUp.filter((event) => event.type === 'user_message' || event.type === 'agent_message').at(-1))
      .toMatchObject({ type: 'agent_message', agentId: 'sage', text: '@Smith fix this point' })
    expect(seen[2]?.catchUp.some((event) => event.type === 'user_message' && event.text === '@Smith build this')).toBe(false)
  })

  it('stops the review loop at one hop when that is the cap', async () => {
    const seen: TurnInput[] = []
    const mutual = roster.map((agent) => ({
      ...agent,
      mentionAllowlist: [agent.id === 'smith' ? 'sage' : 'smith'],
    }))
    const { orchestrator, store, chatId } = await harness(
      scripted((input) => [{
        type: 'result',
        text: input.agent.id === 'smith' ? '@Sage take a look' : '@Smith findings',
        sessionId: 's',
      }], seen),
      { agents: mutual, reviewHops: 1 },
    )

    await orchestrator.submitUserMessage(chatId, '@Smith go')

    // Callback spends the only hop; Smith's second @Sage is the skipped review.
    expect(seen.map((input) => input.agent.id)).toEqual(['smith', 'sage', 'smith'])
    expect((await store.loadEvents(chatId)).at(-1)).toMatchObject({
      type: 'system_note',
      kind: 'info',
      agentId: 'smith',
      text: 'Smith stopped after 1 review round. Reply to continue.',
    })
  })

  it('runs the cheap path when the reviewer never writes the @ back', async () => {
    const seen: TurnInput[] = []
    const mutual = roster.map((agent) => ({
      ...agent,
      mentionAllowlist: [agent.id === 'smith' ? 'sage' : 'smith'],
    }))
    const { orchestrator, chatId } = await harness(
      scripted((input) => [{
        type: 'result',
        text: input.agent.id === 'smith' ? '@Sage take a look' : 'looks fine',
        sessionId: 's',
      }], seen),
      { agents: mutual },
    )

    await orchestrator.submitUserMessage(chatId, '@Smith go')

    expect(seen.map((input) => input.agent.id)).toEqual(['smith', 'sage'])
  })

  it('lets a chief of staff hand-off run the same three-round review loop', async () => {
    const seen: TurnInput[] = []
    const turns: Record<string, number> = { marlow: 0, smith: 0, sage: 0 }
    const household = cosRoster.map((agent) => ({
      ...agent,
      mentionAllowlist:
        agent.isCos ? ['smith'] : agent.id === 'smith' ? ['sage'] : agent.id === 'sage' ? ['smith'] : [],
    }))
    const { orchestrator, chatId } = await harness(
      scripted((input) => {
        const n = (turns[input.agent.id] ?? 0) + 1
        turns[input.agent.id] = n
        const text =
          input.agent.id === 'marlow'
            ? '@Smith build this'
            : input.agent.id === 'smith'
              ? n === 1
                ? '@Sage review this'
                : '@Sage look again'
              : '@Smith findings'
        return [{ type: 'result', text, sessionId: 's' }]
      }, seen),
      { agents: household },
    )

    await orchestrator.submitUserMessage(chatId, 'please take this one')

    // CoS → builder → reviewer → builder → reviewer → builder. The last @Sage is the hop cap.
    expect(seen.map((input) => input.agent.id)).toEqual(['marlow', 'smith', 'sage', 'smith', 'sage', 'smith'])
  })

  it('does not start a fresh summon once the review loop has begun', async () => {
    const seen: TurnInput[] = []
    const turns: Record<string, number> = { marlow: 0, smith: 0, sage: 0 }
    const wren: AgentConfig = {
      ...smith,
      id: 'wren',
      name: 'Wren',
      role: 'Front-end',
      description: 'Front-end builder.',
      character: 'You are Wren.',
      mentionAllowlist: [],
    }
    const household = [...cosRoster, wren].map((agent) => ({
      ...agent,
      mentionAllowlist:
        agent.id === 'marlow'
          ? ['smith']
          : agent.id === 'smith'
            ? ['sage', 'wren']
            : agent.id === 'sage'
              ? ['smith', 'wren']
              : [],
    }))
    const { orchestrator, store, chatId } = await harness(
      scripted((input) => {
        const n = (turns[input.agent.id] ?? 0) + 1
        turns[input.agent.id] = n
        const text =
          input.agent.id === 'marlow'
            ? '@Smith build this'
            : input.agent.id === 'smith'
              ? n === 1
                ? '@Sage review this'
                : '@Sage look again @Wren too'
              : n === 1
                ? '@Smith findings'
                : '@Wren check this @Smith still issues'
        return [{ type: 'result', text, sessionId: 's' }]
      }, seen),
      { agents: household },
    )

    await orchestrator.submitUserMessage(chatId, 'please take this one')

    // Hop one locks smith↔sage. Wren in later replies stays silent, even
    // with a leftover first-summon slot and Wren on both allowlists.
    expect(seen.map((input) => input.agent.id)).toEqual(['marlow', 'smith', 'sage', 'smith', 'sage', 'smith'])
    const notes = (await store.loadEvents(chatId)).filter((event) => event.type === 'system_note')
    expect(notes.some((note) => note.type === 'system_note' && note.text.includes('Wren'))).toBe(false)
  })

  it('drops a sibling first-summon still queued when the review loop starts', async () => {
    const seen: TurnInput[] = []
    const smithTurns = { n: 0 }
    const wren: AgentConfig = {
      ...smith,
      id: 'wren',
      name: 'Wren',
      role: 'Front-end',
      description: 'Front-end builder.',
      character: 'You are Wren.',
      mentionAllowlist: [],
    }
    const household = [...cosRoster, wren].map((agent) => ({
      ...agent,
      mentionAllowlist:
        agent.id === 'smith' ? ['sage', 'wren'] : agent.id === 'sage' ? ['smith'] : [],
    }))
    const { orchestrator, chatId } = await harness(
      scripted((input) => {
        if (input.agent.id === 'smith') smithTurns.n += 1
        return [{
          type: 'result',
          text:
            input.agent.id === 'smith'
              ? smithTurns.n === 1
                ? '@Sage @Wren both of you'
                : 'working on it'
              : input.agent.id === 'sage'
                ? '@Smith findings'
                : 'Wren should not have run',
          sessionId: 's',
        }]
      }, seen),
      { agents: household },
    )

    await orchestrator.submitUserMessage(chatId, '@Smith go')

    // Wren was queued next to Sage. Sage's callback locks the pair and must
    // cancel that pending turn, or Wren walks into the review loop.
    expect(seen.map((input) => input.agent.id)).toEqual(['smith', 'sage', 'smith'])
  })

  it('lets a locked pair still bring in Argus, who walks only the edge back to his summoner', async () => {
    const seen: TurnInput[] = []
    const turns: Record<string, number> = {}
    const roster: AgentConfig[] = [
      { ...smith, mentionAllowlist: ['wren', 'argus'] },
      { ...smith, id: 'wren', name: 'Wren', character: 'You are Wren.', mentionAllowlist: ['smith', 'argus'] },
      { ...smith, id: 'argus', name: 'Argus', character: 'You are Argus.', mentionAllowlist: ['smith', 'wren'] },
    ]
    const { orchestrator, chatId } = await harness(
      scripted((input) => {
        const n = (turns[input.agent.id] ?? 0) + 1
        turns[input.agent.id] = n
        const text =
          input.agent.id === 'smith'
            ? n === 1 ? '@Wren build it' : n === 2 ? '@Argus review it' : 'committing'
            : input.agent.id === 'wren'
              ? '@Smith built it'
              : '@Wren @Smith clean'
        return [{ type: 'result', text, sessionId: 's' }]
      }, seen),
      { agents: roster },
    )

    await orchestrator.submitUserMessage(chatId, '@Smith go')

    // Wren's callback locks smith↔wren; Smith may still hand the work to Argus, and
    // Argus's reply reaches Smith but not Wren, whom he has no edge with.
    expect(seen.map((input) => input.agent.id)).toEqual(['smith', 'wren', 'smith', 'argus', 'smith'])
  })

  it('keeps Argus off a persona he summoned before the pair locked', async () => {
    const seen: TurnInput[] = []
    const turns: Record<string, number> = {}
    const roster: AgentConfig[] = [
      { ...smith, mentionAllowlist: ['wren', 'argus'] },
      { ...smith, id: 'wren', name: 'Wren', character: 'You are Wren.', mentionAllowlist: ['smith'] },
      { ...smith, id: 'argus', name: 'Argus', character: 'You are Argus.', mentionAllowlist: ['smith', 'sage'] },
      { ...smith, id: 'sage', name: 'Sage', character: 'You are Sage.', mentionAllowlist: [] },
    ]
    const { orchestrator, chatId } = await harness(
      scripted((input) => {
        const n = (turns[input.agent.id] ?? 0) + 1
        turns[input.agent.id] = n
        const text =
          input.agent.id === 'smith'
            ? n === 1 ? '@Argus @Wren both of you' : n === 2 ? '@Argus look again' : 'committing'
            : input.agent.id === 'wren'
              ? '@Smith built it'
              : input.agent.id === 'argus'
                ? n === 1 ? '@Sage second opinion' : '@Sage @Smith clean'
                : 'Sage should not have run'
        return [{ type: 'result', text, sessionId: 's' }]
      }, seen),
      { agents: roster },
    )

    await orchestrator.submitUserMessage(chatId, '@Smith go')

    // Wren's callback locks smith↔wren and drops Sage's queued turn; Smith's recall of
    // Argus is allowed, but Argus's older edge to Sage must not reopen through him.
    expect(seen.map((input) => input.agent.id)).toEqual(['smith', 'argus', 'wren', 'smith', 'argus', 'smith'])
  })

  it('a lone persona with a stale allowlist still only answers once', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, store, chatId } = await harness(
      scripted(() => [{ type: 'result', text: '@Smith @Ghost should both be inert', sessionId: 's' }], seen),
      { agents: [{ ...smith, mentionAllowlist: ['smith', 'ghost'] }] },
    )

    await orchestrator.submitUserMessage(chatId, '@Smith go')

    expect(seen.map((input) => input.agent.id)).toEqual(['smith'])
    expect((await store.loadEvents(chatId)).some((event) => event.type === 'system_note')).toBe(false)
  })

  it('never re-summons someone the user already addressed', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, chatId } = await harness(
      scripted((input) => [{
        type: 'result',
        text: input.agent.id === 'smith' ? '@Sage what do you think' : 'Sage answered',
        sessionId: 's',
      }], seen),
      { agents: summonRoster },
    )

    await orchestrator.submitUserMessage(chatId, '@Sage @Smith both of you')

    expect(seen.map((input) => input.agent.id)).toEqual(['sage', 'smith'])
  })

  it('spends the shared delegation budget and says who it skipped', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, store, chatId } = await harness(
      scripted((input) => [{
        type: 'result',
        text: input.agent.id === 'smith' ? '@Sage over to you' : 'Sage answered',
        sessionId: 's',
      }], seen),
      { agents: summonRoster, delegationCap: 0 },
    )

    await orchestrator.submitUserMessage(chatId, '@Smith your call')

    expect(seen.map((input) => input.agent.id)).toEqual(['smith'])
    expect((await store.loadEvents(chatId)).at(-1)).toMatchObject({
      type: 'system_note',
      kind: 'info',
      agentId: 'smith',
      turnId: expect.any(String),
      trace: true,
      text: 'Sage was not asked: delegated turn limit (0) reached',
    })
  })

  it('summons in mention order up to the cap and says who it skipped', async () => {
    const seen: TurnInput[] = []
    const generous = cosRoster.map((agent) =>
      agent.id === 'smith' ? { ...agent, mentionAllowlist: ['sage', 'marlow'] } : agent,
    )
    const { orchestrator, store, chatId } = await harness(
      scripted((input) => [{
        type: 'result',
        text: input.agent.id === 'smith' ? '@Sage @Marlow both of you' : `${input.agent.name} answered`,
        sessionId: 's',
      }], seen),
      { agents: generous, delegationCap: 1 },
    )

    await orchestrator.submitUserMessage(chatId, '@Smith your call')

    expect(seen.map((input) => input.agent.id)).toEqual(['smith', 'sage'])
    const note = (await store.loadEvents(chatId)).find((event) => event.type === 'system_note')
    expect(note).toMatchObject({ type: 'system_note', kind: 'info', agentId: 'smith', trace: true })
    expect(note?.type === 'system_note' ? note.text : '').toBe('Marlow was not asked: delegated turn limit (1) reached')
  })

  it('ignores a persona mentioning itself, even from its own allowlist', async () => {
    const seen: TurnInput[] = []
    const selfish = roster.map((agent) =>
      agent.id === 'smith' ? { ...agent, mentionAllowlist: ['smith', 'sage'] } : agent,
    )
    const { orchestrator, chatId } = await harness(
      scripted((input) => [{
        type: 'result',
        text: input.agent.id === 'smith' ? '@Smith @Sage on it' : 'Sage answered',
        sessionId: 's',
      }], seen),
      { agents: selfish },
    )

    await orchestrator.submitUserMessage(chatId, 'unaddressed @Smith')

    expect(seen.map((input) => input.agent.id)).toEqual(['smith', 'sage'])
  })

  it('cancels the summoned turns that have not started when one is stopped', async () => {
    const generous = cosRoster.map((agent) =>
      agent.id === 'smith' ? { ...agent, mentionAllowlist: ['sage', 'marlow'] } : agent,
    )
    const { driver, gates } = gated((input) =>
      input.agent.id === 'smith' ? '@Sage @Marlow both of you' : `${input.agent.name} answered`,
    )
    const { orchestrator, store, chatId, sent } = await harness(driver, { agents: generous })

    const running = orchestrator.submitUserMessage(chatId, '@Smith go')
    await until(() => gates.length === 1, "Smith's turn to start")
    gates[0]?.finish()

    await until(() => gates.length === 2, 'the first summoned turn to start')
    const turnId = sent.filter((message) => message.type === 'turn_state' && message.state === 'running').at(-1)
    orchestrator.stop(turnId?.type === 'turn_state' ? turnId.turnId : '')
    await running

    // Marlow's errand died with Sage's: an errand nobody is waiting for is not
    // worth a turn of the weekly cap.
    expect(gates.map((gate) => gate.input.agent.id)).toEqual(['smith', 'sage'])
    const notes = (await store.loadEvents(chatId)).filter((event) => event.type === 'system_note')
    expect(notes.map((note) => (note.type === 'system_note' ? [note.kind, note.text] : []))).toEqual([
      ['aborted', "Sage's turn was stopped."],
      ['info', 'Marlow did not run because this turn was stopped.'],
    ])
    expect(notes.at(-1)).toMatchObject({ agentId: 'sage', turnId: notes[0]?.type === 'system_note' ? notes[0].turnId : '', trace: true })
  })

  it('cancels the personas the user mentioned when the first of them is stopped', async () => {
    const { driver, gates } = gated((input) => `${input.agent.name} answered`)
    const { orchestrator, store, chatId, sent } = await harness(driver, { agents: cosRoster })

    const running = orchestrator.submitUserMessage(chatId, '@Sage @Marlow go')
    await until(() => gates.length === 1, "Sage's turn to start")
    const turnId = sent.filter((message) => message.type === 'turn_state' && message.state === 'running').at(-1)
    orchestrator.stop(turnId?.type === 'turn_state' ? turnId.turnId : '')
    await running

    expect(gates.map((gate) => gate.input.agent.id)).toEqual(['sage'])
    const notes = (await store.loadEvents(chatId)).filter((event) => event.type === 'system_note')
    expect(notes.map((note) => (note.type === 'system_note' ? note.text : ''))).toEqual([
      "Sage's turn was stopped.",
      'Marlow did not run because this turn was stopped.',
    ])
  })

  it('tells the summoner in its household block that this one mention works', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, chatId } = await harness(
      recording(createMockDriver({ deltaDelayMs: 0 }), seen),
      { agents: summonRoster },
    )

    await orchestrator.submitUserMessage(chatId, '@Smith @Sage prompts please')

    const smithPrompt = seen.find((input) => input.agent.id === 'smith')?.agent.character ?? ''
    expect(smithPrompt).toContain('@Sage — Generalist thinker.')
    expect(smithPrompt).toContain('you may bring in')
    // Sage's own block is untouched: no allowlist, no @ and no summon rule.
    const sagePrompt = seen.find((input) => input.agent.id === 'sage')?.agent.character ?? ''
    expect(sagePrompt).not.toContain('@Smith')
    expect(sagePrompt).toContain('does nothing, silently')
  })
})

describe('Orchestrator, goal Sessions', () => {
  /** Everyone may summon everyone: the household as the user configured it for Sessions. */
  const house = cosRoster.map((agent) => ({
    ...agent,
    mentionAllowlist: cosRoster.filter((other) => other.id !== agent.id).map((other) => other.id),
  }))

  /** An accepted Multiple Session, the way Accept leaves it; `lead` owns its goal. */
  async function acceptedSession(store: Store, projectId: string, lead: AgentConfig): Promise<string> {
    const source = await store.createChat({ kind: 'dm', memberIds: [lead.id], title: lead.name })
    const { handoff } = await store.reserveWorkHandoff({
      sourceChatId: source.id, sourceTurnId: 'proposal', projectId, projectName: 'Manor',
      title: 'Fix the bug', task: 'Fix the bug. Done when the regression test passes.', authorAgentId: lead.id,
      leadAgentId: lead.id, leadAgentName: lead.name, supportingAgentIds: [], supportingAgentNames: [],
    })
    const target = (await store.materializeWorkHandoff(handoff.id)).workChatId
    if (target === null) throw new Error('the handoff should materialise a Session')
    await store.acceptWorkHandoff(target)
    return target
  }

  const reached = (text: string): RuntimeEvent[] => [
    { type: 'tool_use', toolCallId: 'goal', tool: 'mcp__manor__goal_reached' },
    { type: 'tool_result', toolCallId: 'goal', outcome: 'success' },
    { type: 'result', text, sessionId: 's' },
  ]
  const says = (text: string): RuntimeEvent[] => [{ type: 'result', text, sessionId: 's' }]
  const notes = (events: readonly { type: string }[]) =>
    events.flatMap((event) => (event.type === 'system_note' && 'text' in event ? [event.text] : []))

  it('runs past both caps with several specialists until the lead marks the goal reached', async () => {
    const seen: TurnInput[] = []
    const turns: Record<string, number> = {}
    const script = ['@Smith build it', '@Sage review', '@Smith fix A', '@Sage recheck', '@Smith fix B', '@Sage recheck', '@Smith fix C', '@Sage recheck', 'Clean.']
    let step = 0
    const goalGrants: [string, boolean][] = []
    const { orchestrator, store, projectId, sent } = await harness(
      scripted((input) => {
        turns[input.agent.id] = (turns[input.agent.id] ?? 0) + 1
        if (input.agent.id === 'marlow' && turns.marlow === 2) return reached('Verified: the regression test passes.')
        return says(script[step++] ?? 'Out of script.')
      }, seen),
      {
        agents: house,
        interactionMcp: (_chatId, agent, _turnId, allowAsk, permissions) => {
          goalGrants.push([agent.id, permissions?.allowGoal === true])
          return interactionMcpAttachment('http://127.0.0.1:8787/internal/user-input', 'capability', { allowAsk, allowGoal: permissions?.allowGoal === true })
        },
      },
    )
    const chatId = await acceptedSession(store, projectId, marlow)

    await orchestrator.submitUserMessage(chatId, 'Fix the bug.')

    // Nine delegated turns and seven review rounds, far past the caps of five and three.
    expect(seen.map((input) => input.agent.id)).toEqual(
      ['marlow', 'smith', 'sage', 'smith', 'sage', 'smith', 'sage', 'smith', 'sage', 'marlow'],
    )
    const events = await store.loadEvents(chatId)
    expect(notes(events)).toEqual(['Marlow marked the goal reached.'])
    const handoff = await store.workHandoffForTarget(chatId)
    expect(handoff?.goalReachedAt).toEqual(expect.any(Number))
    expect(handoff?.goalConfirmedAt).toBeUndefined()
    expect(events.at(-1)).toMatchObject({ type: 'system_note', workGoalHandoffId: handoff?.id })
    expect(sent).toContainEqual({ type: 'event', chatId, event: events.at(-1) })
    expect(goalGrants.filter(([, granted]) => granted).map(([id]) => id)).toEqual(['marlow', 'marlow'])
    expect(seen[0]?.mcpServers?.find((server) => server.server.name === 'manor')?.server.tools).toContain('goal_reached')
    expect(seen[1]?.mcpServers?.find((server) => server.server.name === 'manor')?.server.tools).not.toContain('goal_reached')
    expect(seen[0]?.agent.character).toContain("You own this Session's goal")
    expect(seen[0]?.agent.character).toContain(SESSION_PLAN_RULE)
    expect(seen[0]?.agent.character).not.toContain('Three rounds along that pair')
    expect(seen[1]?.agent.character).toContain('This Session works toward a goal owned by Marlow.')
    expect(seen[1]?.agent.character).not.toContain('three-hop review-pair limit still apply')
    // The returning reviewer sees the fix it asked for as the last thing, not the kickoff again.
    expect(seen[4]?.catchUp.filter((event) => event.type === 'user_message' || event.type === 'agent_message').at(-1))
      .toMatchObject({ type: 'agent_message', agentId: 'smith', text: '@Sage recheck' })
  })

  it('keeps claims in the Session and publishes its report without a DM model turn', async () => {
    const seen: TurnInput[] = []
    const claims = [
      { claim: 'The regression test passes.', level: 'ran', ref: 'pnpm test orchestrator: 1 passed' },
      { claim: 'Nothing else reads the old flag.', level: 'stated' },
    ] as const
    let ownerTurn: { chatId: string; agentId: string; turnId: string } | undefined
    let record: ((context: { chatId: string; agentId: string; turnId: string }) => ReturnType<Orchestrator['recordGoalClaims']>) | undefined
    const recorded: ReturnType<Orchestrator['recordGoalClaims']>[] = []
    const { orchestrator, store, projectId } = await harness(
      scripted(() => {
        // The broker call lands while the turn is live, before its tool result.
        recorded.push(record!(ownerTurn!))
        return reached('Done, see the claims.')
      }, seen),
      {
        agents: house,
        interactionMcp: (chatId, agent, turnId, allowAsk, permissions) => {
          ownerTurn = { chatId, agentId: agent.id, turnId }
          return interactionMcpAttachment('http://127.0.0.1:8787/internal/user-input', 'capability', { allowAsk, allowGoal: permissions?.allowGoal === true })
        },
      },
    )
    const report = { result: 'Export is available.', limitations: 'Attachments remain links.' }
    record = (context) => orchestrator.recordGoalClaims(context, [...claims], report)
    const chatId = await acceptedSession(store, projectId, marlow)

    await orchestrator.submitUserMessage(chatId, 'Fix the bug.')

    const note = (await store.loadEvents(chatId)).at(-1)
    expect(note).toMatchObject({ type: 'system_note', text: 'Marlow marked the goal reached.', goalClaims: claims })
    const handoff = (await store.workHandoffForTarget(chatId))!
    expect(handoff.goalReport).toEqual(report)
    const source = await store.loadEvents(handoff.sourceChatId)
    expect(source.at(-1)).toMatchObject({ type: 'system_note', text: 'Export is available.\nAttachments remain links.', workHandoffId: handoff.id })
    expect(source.at(-1)).not.toHaveProperty('goalClaims')
    expect(seen).toHaveLength(1)
    expect(await Promise.all(recorded)).toEqual([{ note: expect.stringContaining('Recorded.') }])
    expect(await record(ownerTurn!)).toEqual({ error: 'This turn has already ended, so the goal was not marked reached.' })
    const revision = await store.reviseWorkGoal(handoff.id, handoff.version, 'Use the chat title as filename.')
    await Promise.all([
      orchestrator.runStoredUserMessage(chatId, revision.event),
      orchestrator.runStoredUserMessage(chatId, revision.event),
    ])
    expect(seen).toHaveLength(2)
    expect(seen[1]?.catchUp).toContainEqual(expect.objectContaining({ type: 'user_message', text: '@Marlow Use the chat title as filename.' }))
    expect((await store.workHandoffForTarget(chatId))?.goalReachedAt).toEqual(expect.any(Number))
    expect(await store.listWorkHandoffs()).toHaveLength(1)
  })

  it('hands an empty handoff back to the lead, nudges it once, then stops the chain unreached', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, store, projectId } = await harness(
      scripted((input) => says(input.agent.id === 'smith' ? 'I looked at it.' : 'I will check this later.'), seen),
      { agents: house },
    )
    const chatId = await acceptedSession(store, projectId, marlow)

    await orchestrator.submitUserMessage(chatId, '@Smith take a look')

    expect(seen.map((input) => input.agent.id)).toEqual(['smith', 'marlow', 'marlow'])
    expect(seen[1]?.catchUp.some((event) => event.type === 'system_note' && event.text === GOAL_CONTINUE_NUDGE)).toBe(false)
    expect(seen[2]?.catchUp.at(-1)).toMatchObject({ type: 'system_note', text: GOAL_CONTINUE_NUDGE })
    const events = await store.loadEvents(chatId)
    expect(notes(events)).toEqual(['Marlow stopped before finishing. Reply to continue.'])
  })

  it('holds the chain on a question to the user and resumes after their answer', async () => {
    const counts: Record<string, number> = {}
    const { driver, gates } = gated((input) => {
      counts[input.agent.id] = (counts[input.agent.id] ?? 0) + 1
      return input.agent.id === 'smith' && counts.smith === 1 ? '@Sage check the fix' : `${input.agent.name} is done.`
    })
    const { orchestrator, store, projectId, sent } = await harness(driver, { agents: house })
    const chatId = await acceptedSession(store, projectId, smith)

    const running = orchestrator.submitUserMessage(chatId, '@Smith fix the bug.')
    await until(() => gates.length === 1, "the owner's turn to start")
    expect(gates[0]?.input.agent.id).toBe('smith')
    const turnId = await waitForRunning(sent, chatId)
    await orchestrator.recordUserInputRequest(chatId, 'smith', turnId, 'scope', [
      { id: 'scope', question: 'Which bug?', options: [{ label: 'Login' }, { label: 'Search' }] },
    ])
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(gates).toHaveLength(1)

    await orchestrator.recordUserInputResponse(chatId, 'smith', turnId, 'scope', { scope: 'Login' })
    gates[0]?.finish()
    await until(() => gates.length === 2, 'the summoned reviewer')
    expect(gates[1]?.input.agent.id).toBe('sage')
    gates[1]?.finish()
    await until(() => gates.length === 3, 'the owner to get the turn back')
    expect(gates[2]?.input.agent.id).toBe('smith')
    gates[2]?.finish()
    await until(() => gates.length === 4, "the owner's nudge")
    gates[3]?.finish()
    await running

    expect(types(await store.loadEvents(chatId))).toContain('user_input_response')
    expect(notes(await store.loadEvents(chatId)).at(-1)).toBe('Smith stopped before finishing. Reply to continue.')
  })

  it('ends the chain on a failed turn, dropping the turns still queued', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, store, projectId } = await harness(
      scripted((input) => (input.agent.id === 'smith' ? [{ type: 'error', message: 'provider fell over' }] : reached('Verified.')), seen),
      { agents: house },
    )
    const chatId = await acceptedSession(store, projectId, marlow)

    await orchestrator.submitUserMessage(chatId, '@Smith @Sage both of you')

    expect(seen.map((input) => input.agent.id)).toEqual(['smith'])
    const stopped = notes(await store.loadEvents(chatId))
    expect(stopped.slice(-2)).toEqual(['Sage did not run because this turn failed.', 'Smith stopped before finishing. Reply to continue.'])
    expect(stopped.join('\n')).not.toContain('marked the goal reached')
  })

  it.each([
    ['restart', 'the first turn'],
    ['live', 'the first turn'],
    ['live', 'the nudge'],
  ] as const)('voids a goal_reached that the user adds to (%s steering on %s) until the lead marks it again', async (steering, on) => {
    const seen: TurnInput[] = []
    const goalTurn = on === 'the nudge' ? 2 : 1
    const driver: Driver = {
      startTurn(input) {
        seen.push(input)
        const queue = new AsyncQueue<RuntimeEvent>()
        const finish = (events: RuntimeEvent[]) => {
          for (const event of events) queue.push(event)
          queue.close()
        }
        const last = input.catchUp.at(-1)
        const nudged = last?.type === 'system_note' && last.text === GOAL_CONTINUE_NUDGE
        if (seen.length < goalTurn) finish(says('Starting.'))
        else if (seen.length === goalTurn) {
          // Marked reached, then still running when the addition arrives.
          queue.push({ type: 'tool_use', toolCallId: 'goal', tool: 'mcp__manor__goal_reached' })
          queue.push({ type: 'tool_result', toolCallId: 'goal', outcome: 'success' })
        } else if (nudged) finish(reached('Both criteria verified.'))
        else finish(says('The new criterion is not done yet.'))
        return {
          events: queue,
          stop() {
            queue.close()
          },
          ...(steering === 'live'
            ? { steer: async () => {
                finish(says('The new criterion is not done yet.'))
                return 'accepted' as const
              } }
            : {}),
        }
      },
    }
    const { orchestrator, store, projectId, sent } = await harness(driver, { agents: house })
    const chatId = await acceptedSession(store, projectId, marlow)

    const running = orchestrator.submitUserMessage(chatId, 'Fix the bug.')
    await until(() => sent.some((message) => message.type === 'event' && message.chatId === chatId &&
      message.event.type === 'tool_result'), 'the goal call')
    await orchestrator.submitUserMessage(chatId, 'Also fix the second regression before finishing.')
    await running

    // A steered nudge is no empty ending either: the lead gets a fresh nudge, not the stall stop.
    expect(seen).toHaveLength(steering === 'restart' ? 3 : goalTurn + 1)
    const events = await store.loadEvents(chatId)
    const said = events.flatMap((event) =>
      event.type === 'agent_message' || event.type === 'system_note' ? [event.text] : [])
    expect(said).toEqual([
      ...(on === 'the nudge' ? ['Starting.'] : []),
      'The new criterion is not done yet.',
      'Both criteria verified.',
      'Marlow marked the goal reached.',
    ])
    expect(seen.every((input) => input.agent.id === 'marlow')).toBe(true)
  })

  it('cancels every later turn on Stop, the ones the user addressed and the lead return included', async () => {
    const { driver, gates } = gated((input) => (input.agent.id === 'smith' ? '@Marlow over to you' : `${input.agent.name} answered`))
    const { orchestrator, store, projectId, sent } = await harness(driver, { agents: house })
    const chatId = await acceptedSession(store, projectId, marlow)

    const running = orchestrator.submitUserMessage(chatId, '@Smith @Sage both of you')
    await until(() => gates.length === 1, "Smith's turn to start")
    orchestrator.stop(await waitForRunning(sent, chatId))
    await running
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(gates.map((gate) => gate.input.agent.id)).toEqual(['smith'])
    expect(notes(await store.loadEvents(chatId))).toEqual([
      "Smith's turn was stopped.",
      'Sage did not run because this turn was stopped.',
    ])
  })

  it('hands the chain over to a message the user queued while it ran', async () => {
    const { driver, gates } = gated((input) => (input.agent.id === 'smith' ? '@Marlow over to you' : `${input.agent.name} checked.`))
    const { orchestrator, store, projectId, sent } = await harness(driver, { agents: house })
    const chatId = await acceptedSession(store, projectId, marlow)

    const first = orchestrator.submitUserMessage(chatId, '@Smith build it')
    await until(() => gates.length === 1, "Smith's turn to start")
    // Addressed to someone else, so it queues rather than steering Smith's answer.
    const second = orchestrator.submitUserMessage(chatId, '@Sage check the docs too')
    await until(() => sent.some((message) => message.type === 'event' && message.chatId === chatId &&
      message.event.type === 'user_message' && message.event.text === '@Sage check the docs too'), 'the queued message')
    gates[0]?.finish()
    await first
    await until(() => gates.length === 2, 'the queued message to start')
    // Smith's handoff to Marlow yielded to the user; the new chain still returns to the lead.
    expect(gates[1]?.input.agent.id).toBe('sage')
    gates[1]?.finish()
    await until(() => gates.length === 3, 'the lead to get the turn back')
    expect(gates[2]?.input.agent.id).toBe('marlow')
    orchestrator.stop(await waitForRunning(sent.filter((message) => message.type !== 'turn_state' || message.agentId === 'marlow'), chatId))
    await second
  })

  it('answers follow-ups as an ordinary room once the lead marks the goal reached', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, store, projectId } = await harness(
      scripted((input) => (seen.length === 1 ? reached('Verified.') : says(`${input.agent.name} wrote it.`)), seen),
      {
        agents: house,
        interactionMcp: (_chatId, _agent, _turnId, allowAsk, permissions) =>
          interactionMcpAttachment('http://127.0.0.1:8787/internal/user-input', 'capability', { allowAsk, allowGoal: permissions?.allowGoal === true }),
      },
    )
    const chatId = await acceptedSession(store, projectId, marlow)
    await orchestrator.submitUserMessage(chatId, 'Fix the bug.')

    // A specialist ending on nothing no longer hands back to the lead.
    await orchestrator.submitUserMessage(chatId, '@Smith write a prompt for this')
    await orchestrator.submitUserMessage(chatId, '@Marlow anything else?')

    expect(seen.map((input) => input.agent.id)).toEqual(['marlow', 'smith', 'marlow'])
    expect(seen[1]?.agent.character).toContain('three-hop review-pair limit still apply')
    expect(seen[2]?.agent.character).not.toContain("You own this Session's goal")
    expect(seen[0]?.mcpServers?.find((server) => server.server.name === 'manor')?.server.tools).toContain('goal_reached')
    expect(seen[2]?.mcpServers?.find((server) => server.server.name === 'manor')?.server.tools).not.toContain('goal_reached')
    expect(notes(await store.loadEvents(chatId))).toEqual(['Marlow marked the goal reached.'])
  })

  it('keeps the goal open when the reached note cannot be stored, so the next message resumes the chain', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, store, projectId } = await harness(
      scripted((input) => (input.agent.id === 'marlow' ? reached('Verified.') : says('Done.')), seen),
      { agents: house },
    )
    const chatId = await acceptedSession(store, projectId, marlow)
    const refused = vi.spyOn(store, 'reachWorkGoal').mockRejectedValue(new Error('write refused'))

    await expect(orchestrator.submitUserMessage(chatId, 'Fix the bug.')).rejects.toThrow('write refused')
    expect((await store.workHandoffForTarget(chatId))?.goalReachedAt).toBeUndefined()
    expect(notes(await store.loadEvents(chatId))).not.toContain('Marlow marked the goal reached.')

    refused.mockRestore()
    await orchestrator.submitUserMessage(chatId, 'Try again.')
    expect(seen.map((input) => input.agent.id)).toEqual(['marlow', 'marlow'])
    expect((await store.workHandoffForTarget(chatId))?.goalReachedAt).toEqual(expect.any(Number))
    expect(notes(await store.loadEvents(chatId)).at(-1)).toBe('Marlow marked the goal reached.')
  })

  it('returns to the ordinary caps once the user settles the Session', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, store, projectId } = await harness(
      scripted(() => says('Done.'), seen),
      { agents: house },
    )
    const chatId = await acceptedSession(store, projectId, marlow)
    const handoff = await store.workHandoffForTarget(chatId)
    if (handoff === undefined) throw new Error('the Session should have its handoff')
    await store.transitionWorkLifecycle(chatId, handoff.id, { state: 'settled', result: 'Done.', resultAt: Date.now() }, {
      type: 'system_note', kind: 'info', text: 'Settled.', workHandoffId: handoff.id, workHandoffPhase: 'settled',
    })

    await orchestrator.submitUserMessage(chatId, '@Smith one more thing')

    expect(seen.map((input) => input.agent.id)).toEqual(['smith'])
    expect(seen[0]?.agent.character).toContain('three-hop review-pair limit still apply')
  })

  it('refuses goal_reached on changed files until Argus passes the current diff', async () => {
    const argus: AgentConfig = { ...sage, id: 'argus', name: 'Argus' }
    const reviewed = [...cosRoster, argus].map((agent, _index, all) => ({
      ...agent,
      mentionAllowlist: all.filter((other) => other.id !== agent.id).map((other) => other.id),
    }))
    const seen: TurnInput[] = []
    const turns: Record<string, number> = {}
    const { orchestrator, store, projectId } = await harness(
      scripted((input) => {
        turns[input.agent.id] = (turns[input.agent.id] ?? 0) + 1
        if (input.agent.id === 'argus') {
          return [
            { type: 'tool_use', toolCallId: 'review', tool: 'mcp__manor__review_passed' },
            { type: 'tool_result', toolCallId: 'review', outcome: 'success' },
            { type: 'result', text: 'No findings, ready to commit.', sessionId: 's' },
          ]
        }
        return reached(turns.marlow === 1 ? 'Done. @Argus please review.' : 'Verified and reviewed.')
      }, seen),
      {
        agents: reviewed,
        interactionMcp: (_chatId, _agent, _turnId, allowAsk, permissions) =>
          interactionMcpAttachment('http://127.0.0.1:8787/internal/user-input', 'capability', {
            allowAsk, allowGoal: permissions?.allowGoal === true, allowReview: permissions?.allowReview === true,
          }),
      },
    )
    const chatId = await acceptedSession(store, projectId, marlow)
    // An earlier turn of this Session changed a file (committed or not, the snapshot records it).
    await store.appendEvent(chatId, {
      type: 'turn_result', agentId: 'smith', turnId: 'turn_edit',
      fileChanges: [{ path: '/repo/src/a.ts', status: 'edited', added: 1, removed: 0, edits: [] }],
    })

    await orchestrator.submitUserMessage(chatId, 'Finish it.')

    expect(seen.map((input) => input.agent.id)).toEqual(['marlow', 'argus', 'marlow'])
    const tools = (index: number) => seen[index]?.mcpServers?.find((server) => server.server.name === 'manor')?.server.tools
    expect(tools(0)).not.toContain('review_passed')
    expect(tools(1)).toEqual(expect.arrayContaining(['review_passed']))
    expect(tools(1)).not.toContain('goal_reached')
    expect(seen[0]?.agent.character).toContain('Manor refuses goal_reached until then')
    expect(seen[1]?.agent.character).toContain('call review_passed in that turn')
    expect(notes(await store.loadEvents(chatId))).toEqual([
      "The goal is not marked reached: this Session changed code and Argus's latest review has not passed the current diff. " +
        'Process any open findings, then summon @Argus to review again; only a review they end with review_passed unlocks it. Do not commit before that.',
      'Marlow marked the goal reached.',
    ])
    expect((await store.workHandoffForTarget(chatId))?.goalReachedAt).toEqual(expect.any(Number))
  })

  it('reopens a reached goal when code changes after its result, so Argus and the lead can republish it', async () => {
    const argus: AgentConfig = { ...sage, id: 'argus', name: 'Argus' }
    const reviewed = [...cosRoster, argus].map((agent, _index, all) => ({
      ...agent,
      mentionAllowlist: all.filter((other) => other.id !== agent.id).map((other) => other.id),
    }))
    const seen: TurnInput[] = []
    const lines = ['@Argus please review.', 'Added the empty case. @Argus please review.']
    let ownerTurn: { chatId: string; agentId: string; turnId: string } | undefined
    let record: ((context: { chatId: string; agentId: string; turnId: string }, report: { result: string }) => unknown) | undefined
    // Like a real CLI, a persona can only call the Manor tools its turn was given.
    const granted = (input: TurnInput, tool: string) =>
      input.mcpServers?.find((server) => server.server.name === 'manor')?.server.tools?.includes(tool) === true
    const { orchestrator, store, projectId } = await harness(
      scripted(async (input) => {
        if (input.agent.id === 'argus') {
          return granted(input, 'review_passed')
            ? [
                { type: 'tool_use', toolCallId: 'review', tool: 'mcp__manor__review_passed' },
                { type: 'tool_result', toolCallId: 'review', outcome: 'success' },
                { type: 'result', text: 'No findings.', sessionId: 's' },
              ]
            : says('No findings, but I cannot pass it here.')
        }
        const reviews = seen.filter((turn) => turn.agent.id === 'argus').length
        if (granted(input, 'goal_reached') && reviews > 0 && seen.at(-2)?.agent.id === 'argus') {
          await record?.(ownerTurn!, { result: `Fixed, ${reviews === 1 ? 'first' : 'second'} result.` })
          return reached('Reviewed and done.')
        }
        return says(lines.shift() ?? 'Nothing more.')
      }, seen),
      {
        agents: reviewed,
        interactionMcp: (chatId, agent, turnId, allowAsk, permissions) => {
          if (agent.id === 'marlow') ownerTurn = { chatId, agentId: agent.id, turnId }
          return interactionMcpAttachment('http://127.0.0.1:8787/internal/user-input', 'capability', {
            allowAsk, allowGoal: permissions?.allowGoal === true, allowReview: permissions?.allowReview === true,
          })
        },
      },
    )
    record = (context, report) => orchestrator.recordGoalClaims(context, [], report)
    const module = new WorkModule({
      store, agents: () => reviewed, orchestrator, broadcast: () => undefined, broadcastDirectory: async () => undefined,
    })
    const chatId = await acceptedSession(store, projectId, marlow)
    const edit = (turnId: string) => store.appendEvent(chatId, {
      type: 'turn_result', agentId: 'marlow', turnId,
      fileChanges: [{ path: '/repo/src/a.ts', status: 'edited', added: 1, removed: 0, edits: [] }],
    })
    await edit('turn_fix')
    await orchestrator.submitUserMessage(chatId, 'Fix the bug.')
    const first = (await store.workHandoffForTarget(chatId))!
    expect(first.goalReport).toEqual({ result: 'Fixed, first result.' })

    // The incident: after the result, a follow-up turn commits more code.
    await edit('turn_after')
    await orchestrator.submitUserMessage(chatId, 'Also handle the empty case.')

    const events = await store.loadEvents(chatId)
    expect(notes(events)).toEqual([
      'Marlow marked the goal reached.',
      'Changed after it was ready. Marlow is preparing a new version.',
      'Marlow marked the goal reached.',
    ])
    expect(seen.map((input) => input.agent.id)).toEqual(['marlow', 'argus', 'marlow', 'marlow', 'argus', 'marlow'])
    const source = await store.loadEvents(first.sourceChatId)
    expect(source).toContainEqual(expect.objectContaining({
      type: 'system_note', workHandoffPhase: 'reopened', workHandoffVersion: first.version + 1, workChangedAfterReady: true,
      text: '“Fix the bug” reopened because code changed after its result.',
    }))
    const second = (await store.workHandoffForTarget(chatId))!
    expect(second.goalReport).toEqual({ result: 'Fixed, second result.' })
    await expect(module.confirmGoal(first.id, undefined, first.version)).rejects.toThrow('result has changed')
    await module.confirmGoal(second.id, undefined, second.version)
    expect((await store.workHandoffForTarget(chatId))?.goalConfirmedAt).toEqual(expect.any(Number))
  })

  it('says once when prose changes after the published result', async () => {
    let turn = 0
    const { orchestrator, store, projectId } = await harness(
      scripted(() => (turn++ === 0 ? reached('Done.') : says('Tweaked the label.')), []),
      {
        agents: house,
        interactionMcp: (_chatId, _agent, _turnId, allowAsk, permissions) =>
          interactionMcpAttachment('http://127.0.0.1:8787/internal/user-input', 'capability', { allowAsk, allowGoal: permissions?.allowGoal === true }),
      },
    )
    const chatId = await acceptedSession(store, projectId, marlow)
    await orchestrator.submitUserMessage(chatId, 'Fix the bug.')
    // The user's plain follow-up in the Session: the goal stays reached while a turn edits prose.
    await store.appendEvent(chatId, {
      type: 'turn_result', agentId: 'marlow', turnId: 'turn_tweak',
      fileChanges: [{ path: '/repo/docs/notes.md', status: 'edited', added: 1, removed: 0, edits: [] }],
    })
    await orchestrator.submitUserMessage(chatId, 'Also tweak the label.')
    await orchestrator.submitUserMessage(chatId, 'And the hint.')

    expect(notes(await store.loadEvents(chatId))).toEqual(['Marlow marked the goal reached.', CHANGED_AFTER_RESULT_NOTE])
    // The user reads it as Not included in the diff and on the bar; the line itself stays in the turn's trace.
    expect((await store.loadEvents(chatId)).find((event) => event.type === 'system_note' && event.text === CHANGED_AFTER_RESULT_NOTE))
      .toMatchObject({ agentId: 'marlow', turnId: expect.any(String), trace: true })
  })
})

describe('Orchestrator, chief of staff routing', () => {
  it('routes an un-mentioned message to the chief of staff, as one ordinary turn', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, store, chatId, sent } = await harness(recording(createMockDriver({ deltaDelayMs: 0 }), seen), {
      agents: cosRoster,
    })

    await orchestrator.submitUserMessage(chatId, 'thinking out loud, nobody in particular')

    expect(seen.map((input) => input.agent.id)).toEqual(['marlow'])
    expect(speakers(await store.loadEvents(chatId))).toEqual([
      ['user_message', 'user'],
      ['agent_message', 'marlow'],
    ])
    // The message reaches it through the normal catch-up, not a special channel.
    expect(seen[0]?.catchUp.some((event) => event.type === 'user_message')).toBe(true)
    expect(sent.filter((message) => message.type === 'turn_state').at(-1)).toMatchObject({
      agentId: 'marlow',
      state: 'done',
    })
  })

  it('routes an un-mentioned follow-up to the persona that just answered', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, store, chatId } = await harness(recording(createMockDriver({ deltaDelayMs: 0 }), seen), {
      agents: cosRoster,
    })

    await orchestrator.submitUserMessage(chatId, '@Sage what do you make of this?')
    await orchestrator.submitUserMessage(chatId, 'and the counterargument?')

    // The reply continues the exchange with Sage instead of restarting with Marlow.
    expect(seen.map((input) => input.agent.id)).toEqual(['sage', 'sage'])
    expect(speakers(await store.loadEvents(chatId))).toEqual([
      ['user_message', 'user'],
      ['agent_message', 'sage'],
      ['user_message', 'user'],
      ['agent_message', 'sage'],
    ])
  })

  it('routes a group reply to the targeted persona even after somebody else spoke', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, store } = await harness(recording(createMockDriver({ deltaDelayMs: 0 }), seen), {
      agents: cosRoster,
    })
    const group = await store.createChat({ kind: 'group', memberIds: ['sage', 'smith'], title: 'Pair' })

    await orchestrator.submitUserMessage(
      group.id,
      'Follow up on this.',
      [],
      undefined,
      [],
      [],
      { turnId: 'turn_smith', agentId: 'smith', text: 'The targeted answer.' },
    )

    expect(seen.map((input) => input.agent.id)).toEqual(['smith'])
  })

  it('falls back to the chief of staff when two personas answered last', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, chatId } = await harness(recording(createMockDriver({ deltaDelayMs: 0 }), seen), {
      agents: cosRoster,
    })

    await orchestrator.submitUserMessage(chatId, '@Sage @Smith both of you, please')
    await orchestrator.submitUserMessage(chatId, 'thanks — who is right?')

    // "you" is ambiguous after two answers, so the follow-up is Marlow's to route.
    expect(seen.map((input) => input.agent.id)).toEqual(['sage', 'smith', 'marlow'])
  })

  it('leaves the chief of staff out of an explicitly mentioned message', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, store, chatId } = await harness(recording(createMockDriver({ deltaDelayMs: 0 }), seen), {
      agents: cosRoster,
    })

    await orchestrator.submitUserMessage(chatId, '@Sage just you')

    expect(seen.map((input) => input.agent.id)).toEqual(['sage'])
    expect(speakers(await store.loadEvents(chatId))).toEqual([
      ['user_message', 'user'],
      ['agent_message', 'sage'],
    ])
  })

  it('gives chief of staff and specialist the same household block, without the @ syntax', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, chatId } = await harness(recording(createMockDriver({ deltaDelayMs: 0 }), seen), {
      agents: cosRoster,
    })

    await orchestrator.submitUserMessage(chatId, 'who handles this?')
    await orchestrator.submitUserMessage(chatId, '@Sage and you?')

    // The chief of staff knows the household but holds no summon authority:
    // since 2026-08-13 only the user brings personas in, so no roster block and
    // no working @ anywhere in the prompt.
    const cosPrompt = seen[0]?.agent.character ?? ''
    expect(cosPrompt.startsWith('You are Marlow.')).toBe(true)
    expect(cosPrompt).toContain(HOUSEHOLD_HEADING)
    expect(cosPrompt).toContain('Sage — Generalist thinker.')
    expect(cosPrompt).toContain('Smith — Engineer.')
    expect(cosPrompt).toContain('does nothing, silently')
    expect(cosPrompt).not.toContain('@Sage')
    expect(cosPrompt).not.toContain('@Smith')
    // Never itself, and never as a peer: the household block hosts the others.
    expect(cosPrompt).not.toContain('Marlow —')

    const sagePrompt = seen[1]?.agent.character ?? ''
    expect(sagePrompt.startsWith('You are Sage.')).toBe(true)
    expect(sagePrompt).toContain(HOUSEHOLD_HEADING)
    expect(sagePrompt).toContain('Smith — Engineer.')
    expect(sagePrompt).toContain('Marlow — Chief of staff.')
    expect(sagePrompt).not.toContain('@Smith')
  })

  it('never acts on mentions in a chief of staff reply', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, store, chatId } = await harness(
      scripted((input) => [{
        type: 'result',
        text: input.agent.isCos ? '@Sage this is yours' : 'Sage answered',
        sessionId: 's',
      }], seen),
      { agents: cosRoster },
    )

    await orchestrator.submitUserMessage(chatId, 'please hand this one off')

    // Free chief-of-staff delegation went out on 2026-08-13: without an
    // allowlist its mention is as inert as anyone's, and silently so.
    expect(seen.map((input) => input.agent.id)).toEqual(['marlow'])
    expect(speakers(await store.loadEvents(chatId))).toEqual([
      ['user_message', 'user'],
      ['agent_message', 'marlow'],
    ])
    expect((await store.loadEvents(chatId)).some((event) => event.type === 'system_note')).toBe(false)
  })

  it('summons through the chief of staff allowlist like anyone else', async () => {
    const seen: TurnInput[] = []
    const summoning = cosRoster.map((agent) =>
      agent.isCos ? { ...agent, mentionAllowlist: ['sage'] } : agent,
    )
    const { orchestrator, store, chatId } = await harness(
      scripted((input) => [{
        type: 'result',
        text: input.agent.isCos ? '@Sage please take this' : 'Sage answered',
        sessionId: 's',
      }], seen),
      { agents: summoning },
    )

    await orchestrator.submitUserMessage(chatId, 'please hand this one off')

    expect(seen.map((input) => input.agent.id)).toEqual(['marlow', 'sage'])
    expect(speakers(await store.loadEvents(chatId))).toEqual([
      ['user_message', 'user'],
      ['agent_message', 'marlow'],
      ['agent_message', 'sage'],
    ])
    // The summoned turn sees the request through the ordinary catch-up.
    expect(
      seen[1]?.catchUp.some((event) => event.type === 'agent_message' && event.text.includes('@Sage please take')),
    ).toBe(true)
  })

  it('never acts on mentions in a specialist reply', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, store, chatId } = await harness(
      scripted((input) => [{ type: 'result', text: `@Sage take this over, ${input.agent.name} out`, sessionId: 's' }], seen),
      { agents: cosRoster },
    )

    await orchestrator.submitUserMessage(chatId, '@Smith your call')

    // One hop is one hop, and the ignored mention is silent: no note about it.
    expect(seen.map((input) => input.agent.id)).toEqual(['smith'])
    expect(speakers(await store.loadEvents(chatId))).toEqual([
      ['user_message', 'user'],
      ['agent_message', 'smith'],
    ])
  })

})

describe('Orchestrator, chat overrides', () => {
  type AutoSelection = Awaited<ReturnType<NonNullable<OrchestratorOptions['selectAutoRuntime']>>>
  beforeEach(() => { vi.spyOn(console, 'info').mockImplementation(() => {}) })
  afterEach(() => { vi.restoreAllMocks() })

  it('leaves the pin alone on a host with no selector, even when a switch asked for Auto', async () => {
    const { orchestrator, store, chatId } = await harness(createMockDriver({ deltaDelayMs: 0 }))
    await orchestrator.setOverride(chatId, 'sage', { auto: true })
    await orchestrator.submitUserMessage(chatId, '@Sage hello')
    // Claiming the turn would freeze her current model into the chat for good.
    expect((await store.loadChatOverrides(chatId))['sage']).toEqual({ auto: true })
  })

  it('keeps queued later input out of the current Auto selection', async () => {
    const select = vi.fn<NonNullable<OrchestratorOptions['selectAutoRuntime']>>()
      .mockResolvedValue({ runtime: { driver: 'claude', model: 'claude-fable-5-2', effort: 'high' }, category: 'hardest', confidence: 0.9 })
    const { orchestrator, store, chatId } = await harness(createMockDriver({ deltaDelayMs: 0 }), { selectAutoRuntime: select })
    await orchestrator.setOverride(chatId, 'sage', { driver: 'codex', auto: true })
    await store.appendEvent(chatId, { type: 'user_message', text: 'later queued question', mentions: [], dispatchState: 'pending' })
    await orchestrator.submitUserMessage(chatId, '@Sage current question')
    expect(select.mock.calls[0]?.[1]).toContain('current question')
    expect(select.mock.calls[0]?.[1]).not.toContain('later queued question')
  })

  it('leaves a DM to its agent: Auto neither selects nor pins there', async () => {
    const select = vi.fn<NonNullable<OrchestratorOptions['selectAutoRuntime']>>()
      .mockResolvedValue({ runtime: { driver: 'claude', model: 'claude-fable-5-2', effort: 'high' }, category: 'hardest', confidence: 0.9 })
    const seen: TurnInput[] = []
    const { orchestrator, store } = await harness(recording(createMockDriver({ deltaDelayMs: 0 }), seen), { selectAutoRuntime: select })
    const dm = await store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })
    await orchestrator.setOverride(dm.id, 'sage', { auto: true })
    await orchestrator.submitUserMessage(dm.id, 'design the backend')
    expect(seen).toHaveLength(1)
    expect(select).not.toHaveBeenCalled()
    expect((await orchestrator.overrides(dm.id)).sage).toEqual({ auto: true })
  })

  it('switches provider once with Auto, removes unsupported speed and reuses the pin after restart', async () => {
    const select = vi.fn<NonNullable<OrchestratorOptions['selectAutoRuntime']>>()
      .mockResolvedValue({ runtime: { driver: 'claude', model: 'claude-fable-5-2', effort: 'high' }, category: 'hardest', confidence: 0.9 })
    const seen: TurnInput[] = []
    const driver = recording(createMockDriver({ deltaDelayMs: 0 }), seen)
    const { orchestrator, store, chatId, projectId, sent } = await harness(driver, { selectAutoRuntime: select })
    await orchestrator.setOverride(chatId, 'sage', { driver: 'codex', model: 'gpt-5.6-luna', speed: 'fast', auto: true })
    await orchestrator.submitUserMessage(chatId, '@Sage design the backend')
    expect(select).toHaveBeenCalledOnce()
    expect(select.mock.calls[0]?.[1]).toContain('design the backend')
    expect(seen[0]?.agent).toMatchObject({ driver: 'claude', model: 'claude-fable-5-2', effort: 'high' })
    expect((await orchestrator.overrides(chatId)).sage).toEqual({
      auto: true, autoResolved: true, driver: 'claude', model: 'claude-fable-5-2', effort: 'high',
    })
    expect(seen[0]?.speed).toBeUndefined()
    expect(console.info).toHaveBeenCalledOnce()
    expect(JSON.parse(vi.mocked(console.info).mock.calls[0]![1])).toEqual({
      chatId, agentId: 'sage', turnId: expect.any(String), outcome: 'selected',
      category: 'hardest', confidence: 0.9, elapsedMs: expect.any(Number),
    })
    expect(sent.some((message) => message.type === 'chat_overrides' && message.perAgent.sage?.autoResolved)).toBe(true)
    const restarted = new Orchestrator({ agents: () => roster, store, mcpServers: () => [],
      resolveDriver: () => driver, ensureScratchDir: scratchFor, emit: () => {}, selectAutoRuntime: select })
    await restarted.submitUserMessage(chatId, '@Sage now just format a date')
    expect(select).toHaveBeenCalledOnce()
    expect(console.info).toHaveBeenCalledOnce()
    expect(seen.at(-1)?.agent).toMatchObject({ driver: 'claude', model: 'claude-fable-5-2' })
    const other = await store.createChat({ projectId })
    await restarted.setOverride(other.id, 'sage', { driver: 'codex', auto: true })
    await restarted.submitUserMessage(other.id, '@Sage a fresh task')
    expect(select).toHaveBeenCalledTimes(2)
  })

  /** The shipped personas run a real provider; the test roster is mock by default. */
  const liveRoster = [{ ...sage, driver: 'claude' as const, model: 'claude-fable-5-2' }, smith]

  it('runs Auto on a Single chat nobody touched', async () => {
    const select = vi.fn<NonNullable<OrchestratorOptions['selectAutoRuntime']>>()
      .mockResolvedValue({ runtime: { driver: 'codex', model: 'gpt-5.6-sol', effort: 'high' }, category: 'bug-fix-performance', confidence: 0.9 })
    const seen: TurnInput[] = []
    const { orchestrator, store, projectId } = await harness(recording(createMockDriver({ deltaDelayMs: 0 }), seen),
      { selectAutoRuntime: select })
    const chat = await store.createChat({ projectId, mode: 'single' })
    await orchestrator.submitUserMessage(chat.id, 'fix the failing test')
    expect(select).toHaveBeenCalledOnce()
    expect(seen[0]?.agent).toMatchObject({ driver: 'codex', model: 'gpt-5.6-sol', effort: 'high' })
    expect((await orchestrator.overrides(chat.id)).__single__).toEqual({
      driver: 'codex', model: 'gpt-5.6-sol', effort: 'high', auto: true, autoResolved: true,
    })
  })

  it('keeps the house Single default when Auto cannot classify', async () => {
    const house = [
      { ...marlow, driver: 'cursor' as const, model: 'cursor-grok-4.6', effort: 'high' as const },
      { ...sage, driver: 'claude' as const, model: 'claude-fable-5-2' },
    ]
    const select = vi.fn<NonNullable<OrchestratorOptions['selectAutoRuntime']>>()
      .mockResolvedValue({ reason: 'low_confidence', confidence: 0.51 })
    const seen: TurnInput[] = []
    const { orchestrator, store, projectId } = await harness(recording(createMockDriver({ deltaDelayMs: 0 }), seen),
      { selectAutoRuntime: select, agents: house })
    const chat = await store.createChat({ projectId, mode: 'single' })
    await orchestrator.submitUserMessage(chat.id, 'add luna to cursor')
    expect(select).toHaveBeenCalledOnce()
    expect(seen[0]?.agent).toMatchObject({ driver: 'cursor', model: 'cursor-grok-4.6', effort: 'high' })
    expect((await orchestrator.overrides(chat.id)).__single__).toEqual({
      driver: 'cursor', model: 'cursor-grok-4.6', effort: 'high', auto: true, autoResolved: true,
    })
  })

  it('runs Auto on a chat nobody touched, because absent means on', async () => {
    const select = vi.fn<NonNullable<OrchestratorOptions['selectAutoRuntime']>>()
      .mockResolvedValue({ runtime: { driver: 'codex', model: 'gpt-5.6-sol', effort: 'high' }, category: 'bug-fix-performance', confidence: 0.9 })
    const seen: TurnInput[] = []
    const { orchestrator, chatId } = await harness(recording(createMockDriver({ deltaDelayMs: 0 }), seen),
      { selectAutoRuntime: select, agents: liveRoster })
    await orchestrator.submitUserMessage(chatId, '@Sage fix the failing test')
    expect(select).toHaveBeenCalledOnce()
    expect(seen[0]?.agent).toMatchObject({ driver: 'codex', model: 'gpt-5.6-sol', effort: 'high' })
    // Written out, so the switch the user never touched still reads as on afterwards.
    expect((await orchestrator.overrides(chatId)).sage).toEqual({
      driver: 'codex', model: 'gpt-5.6-sol', effort: 'high', auto: true, autoResolved: true,
    })
  })

  it('stores an off switch as a pin of its own and asks nothing on that chat', async () => {
    const select = vi.fn<NonNullable<OrchestratorOptions['selectAutoRuntime']>>()
    const seen: TurnInput[] = []
    const { orchestrator, store, chatId } = await harness(recording(createMockDriver({ deltaDelayMs: 0 }), seen),
      { selectAutoRuntime: select, agents: liveRoster })
    await orchestrator.setOverride(chatId, 'sage', { auto: false })
    // The one field it carries is false, which the empty-pin delete must not read as nothing.
    expect((await orchestrator.overrides(chatId)).sage).toEqual({ auto: false })
    await orchestrator.submitUserMessage(chatId, '@Sage fix the failing test')
    expect(select).not.toHaveBeenCalled()
    expect(seen[0]?.agent).toMatchObject({ driver: 'claude', model: 'claude-fable-5-2' })
    expect((await orchestrator.overrides(chatId)).sage).toEqual({ auto: false })
    const restarted = new Orchestrator({ agents: () => liveRoster, store, mcpServers: () => [],
      resolveDriver: () => createMockDriver({ deltaDelayMs: 0 }), ensureScratchDir: scratchFor, emit: () => {}, selectAutoRuntime: select })
    await restarted.submitUserMessage(chatId, '@Sage and again')
    expect(select).not.toHaveBeenCalled()
  })

  it('leaves a runtime pinned by hand before Auto had a default alone', async () => {
    const select = vi.fn<NonNullable<OrchestratorOptions['selectAutoRuntime']>>()
    const seen: TurnInput[] = []
    const { orchestrator, chatId } = await harness(recording(createMockDriver({ deltaDelayMs: 0 }), seen),
      { selectAutoRuntime: select, agents: liveRoster })
    // The shape every pin had before `auto` could be stored: a pick, and no Auto key.
    await orchestrator.setOverride(chatId, 'sage', { driver: 'codex', model: 'gpt-5.6-sol', effort: 'medium' })
    await orchestrator.submitUserMessage(chatId, '@Sage fix the failing test')
    expect(select).not.toHaveBeenCalled()
    expect(seen[0]?.agent).toMatchObject({ driver: 'codex', model: 'gpt-5.6-sol', effort: 'medium' })
    expect((await orchestrator.overrides(chatId)).sage).toEqual({ driver: 'codex', model: 'gpt-5.6-sol', effort: 'medium' })
  })

  it.each([
    ['a host with no selector', undefined, liveRoster],
    ['a persona configured as mock', vi.fn<NonNullable<OrchestratorOptions['selectAutoRuntime']>>(), roster],
  ] as const)('leaves %s alone instead of stamping every first turn', async (_name, select, agents) => {
    const { orchestrator, chatId } = await harness(createMockDriver({ deltaDelayMs: 0 }),
      { ...(select === undefined ? {} : { selectAutoRuntime: select }), agents })
    await orchestrator.submitUserMessage(chatId, '@Sage fix the failing test')
    if (select !== undefined) expect(select).not.toHaveBeenCalled()
    expect((await orchestrator.overrides(chatId)).sage).toBeUndefined()
    expect(console.info).not.toHaveBeenCalled()
  })

  it('keeps a manual pick made while Jev is waiting and never rearms Auto', async () => {
    let resolve!: (value: AutoSelection) => void
    const select = vi.fn(() => new Promise<AutoSelection>((done) => { resolve = done }))
    const seen: TurnInput[] = []
    const { orchestrator, chatId } = await harness(recording(createMockDriver({ deltaDelayMs: 0 }), seen), { selectAutoRuntime: select })
    await orchestrator.setOverride(chatId, 'sage', { driver: 'codex', auto: true })
    const turn = orchestrator.submitUserMessage(chatId, '@Sage think about this')
    await until(() => select.mock.calls.length === 1, 'Auto selection started')
    await orchestrator.setOverride(chatId, 'sage', { driver: 'codex', model: 'gpt-5.6-sol', effort: 'medium' })
    resolve({ runtime: { driver: 'claude', model: 'claude-fable-5-2', effort: 'high' }, category: 'hardest', confidence: 0.9 })
    await turn
    expect(seen[0]?.agent).toMatchObject({ driver: 'codex', model: 'gpt-5.6-sol', effort: 'medium' })
    expect((await orchestrator.overrides(chatId)).sage).toMatchObject({ autoResolved: true })
    expect((await orchestrator.overrides(chatId)).sage?.auto).toBeUndefined()
    expect(console.info).toHaveBeenCalledWith('[auto-runtime]', expect.stringContaining('"reason":"manual_override"'))
    await expect(orchestrator.setOverride(chatId, 'sage', { driver: 'codex', model: 'gpt-5.6-sol', effort: 'medium', auto: true }))
      .rejects.toThrow(/before this agent’s first turn/)
    await orchestrator.submitUserMessage(chatId, '@Sage continue')
    expect(select).toHaveBeenCalledOnce()
    expect(seen.at(-1)?.agent.model).toBe('gpt-5.6-sol')
  })

  it('pins the current configuration on failure and does not choose again on the next turn', async () => {
    const select = vi.fn().mockRejectedValue(new Error('private provider text test-key'))
    const seen: TurnInput[] = []
    const { orchestrator, chatId } = await harness(recording(createMockDriver({ deltaDelayMs: 0 }), seen), { selectAutoRuntime: select })
    await orchestrator.setOverride(chatId, 'sage', { driver: 'grok', model: 'grok-4.5', effort: 'max', auto: true })
    await orchestrator.submitUserMessage(chatId, '@Sage hello there')
    await orchestrator.submitUserMessage(chatId, '@Sage continue')
    expect(select).toHaveBeenCalledOnce()
    expect(seen[0]?.agent).toMatchObject({ driver: 'grok', model: 'grok-4.5', effort: 'high' })
    expect((await orchestrator.overrides(chatId)).sage).toMatchObject({ model: 'grok-4.5', effort: 'high', autoResolved: true })
    expect(console.info).toHaveBeenCalledOnce()
    expect(JSON.parse(vi.mocked(console.info).mock.calls[0]![1])).toEqual({
      chatId, agentId: 'sage', turnId: expect.any(String), outcome: 'fallback',
      reason: 'selector_error', elapsedMs: expect.any(Number),
    })
  })

  it.each([
    { reason: 'low_confidence', confidence: 0.69 },
    { reason: 'timeout' },
    { reason: 'http_error', httpStatus: 429 },
  ] as const)('logs $reason once with its safe details and retains the fallback pin', async (result) => {
    const select = vi.fn<NonNullable<OrchestratorOptions['selectAutoRuntime']>>().mockResolvedValue(result)
    const { orchestrator, chatId } = await harness(createMockDriver({ deltaDelayMs: 0 }), { selectAutoRuntime: select })
    await orchestrator.setOverride(chatId, 'sage', { driver: 'codex', model: 'gpt-5.6-sol', effort: 'medium', auto: true })
    await orchestrator.submitUserMessage(chatId, '@Sage private task text')
    expect((await orchestrator.overrides(chatId)).sage).toMatchObject({ driver: 'codex', model: 'gpt-5.6-sol', effort: 'medium', autoResolved: true })
    expect(console.info).toHaveBeenCalledOnce()
    expect(JSON.parse(vi.mocked(console.info).mock.calls[0]![1])).toEqual({
      chatId, agentId: 'sage', turnId: expect.any(String), outcome: 'fallback',
      ...result, elapsedMs: expect.any(Number),
    })
  })

  it('refuses Auto after a manual turn, including after restart, but allows an unused persona', async () => {
    const select = vi.fn()
    const driver = createMockDriver({ deltaDelayMs: 0 })
    const { orchestrator, store, chatId } = await harness(driver, { selectAutoRuntime: select })
    await orchestrator.setOverride(chatId, 'sage', { driver: 'codex', model: 'gpt-5.6-sol', effort: 'medium' })
    await orchestrator.submitUserMessage(chatId, '@Sage start manually')
    const restarted = new Orchestrator({ agents: () => roster, store, mcpServers: () => [],
      resolveDriver: () => driver, ensureScratchDir: scratchFor, emit: () => {}, selectAutoRuntime: select })
    for (const runtime of [orchestrator, restarted]) {
      await expect(runtime.setOverride(chatId, 'sage', { auto: true })).rejects.toThrow(/before this agent’s first turn/)
      expect((await runtime.overrides(chatId)).sage).toEqual({ driver: 'codex', model: 'gpt-5.6-sol', effort: 'medium' })
    }
    expect(select).not.toHaveBeenCalled()
    await restarted.setOverride(chatId, 'smith', { auto: true })
    expect((await restarted.overrides(chatId)).smith).toEqual({ auto: true })
    await restarted.submitUserMessage(chatId, '@Smith your first task')
    expect(select).toHaveBeenCalledOnce()
  })

  it('refuses Auto during a manual turn and after stopping it before an answer', async () => {
    const gate = gated()
    const { orchestrator, store, chatId, sent } = await harness(gate.driver)
    const turn = orchestrator.submitUserMessage(chatId, '@Sage start manually')
    const turnId = await waitForRunning(sent, chatId)
    await until(() => gate.gates.length === 1, 'the manual driver to start')
    await expect(orchestrator.setOverride(chatId, 'sage', { auto: true })).rejects.toThrow(/before this agent’s first turn/)
    orchestrator.stop(turnId)
    await turn
    const restarted = new Orchestrator({ agents: () => roster, store, mcpServers: () => [],
      resolveDriver: () => gate.driver, ensureScratchDir: scratchFor, emit: () => {} })
    await expect(restarted.setOverride(chatId, 'sage', { auto: true })).rejects.toThrow(/before this agent’s first turn/)
    expect((await restarted.overrides(chatId)).sage).toBeUndefined()
  })

  it('keeps a stopped Auto selection locked without applying its late answer', async () => {
    let resolve!: (value: AutoSelection) => void
    const select = vi.fn(() => new Promise<AutoSelection>((done) => { resolve = done }))
    const seen: TurnInput[] = []
    const { orchestrator, chatId, sent } = await harness(recording(createMockDriver({ deltaDelayMs: 0 }), seen), { selectAutoRuntime: select })
    await orchestrator.setOverride(chatId, 'sage', { driver: 'codex', model: 'gpt-5.6-sol', auto: true })
    const turn = orchestrator.submitUserMessage(chatId, '@Sage start')
    await until(() => select.mock.calls.length === 1, 'Auto selection started')
    const running = sent.find((message) => message.type === 'turn_state' && message.state === 'running')
    if (running?.type !== 'turn_state') throw new Error('turn did not start')
    orchestrator.stop(running.turnId)
    resolve({ runtime: { driver: 'claude', model: 'claude-fable-5-2', effort: 'high' }, category: 'hardest', confidence: 0.9 })
    await turn
    expect(seen).toHaveLength(0)
    expect((await orchestrator.overrides(chatId)).sage).toMatchObject({ driver: 'codex', model: 'gpt-5.6-sol', autoResolved: true })
    expect(console.info).toHaveBeenCalledWith('[auto-runtime]', expect.stringContaining('"reason":"stopped"'))
    await orchestrator.submitUserMessage(chatId, '@Sage try again')
    expect(select).toHaveBeenCalledOnce()
    expect(seen[0]?.agent.model).toBe('gpt-5.6-sol')
  })

  it('selects independently for several personas and keeps both pins on subsequent turns', async () => {
    const select = vi.fn<NonNullable<OrchestratorOptions['selectAutoRuntime']>>()
      .mockResolvedValueOnce({ runtime: { driver: 'claude', model: 'claude-fable-5-2', effort: 'high' }, category: 'hardest', confidence: 0.9 })
      .mockResolvedValueOnce({ runtime: { driver: 'cursor', model: 'cursor-grok-4.6', effort: 'xhigh', speed: 'fast' }, category: 'feature-refactoring', confidence: 0.9 })
    const seen: TurnInput[] = []
    const { orchestrator, chatId } = await harness(recording(createMockDriver({ deltaDelayMs: 0 }), seen), { selectAutoRuntime: select })
    await orchestrator.setOverride(chatId, 'sage', { driver: 'codex', auto: true })
    await orchestrator.setOverride(chatId, 'smith', { driver: 'codex', auto: true })
    await orchestrator.submitUserMessage(chatId, '@Sage @Smith assess this')
    expect(select.mock.calls.map(([agent]) => agent.id)).toEqual(['sage', 'smith'])
    await orchestrator.submitUserMessage(chatId, '@Sage @Smith continue')
    expect(select).toHaveBeenCalledTimes(2)
    expect(await orchestrator.overrides(chatId)).toMatchObject({
      sage: { driver: 'claude', model: 'claude-fable-5-2', autoResolved: true },
      smith: { driver: 'cursor', model: 'cursor-grok-4.6', speed: 'fast', autoResolved: true },
    })
    const smithTurns = seen.filter((input) => input.agent.id === 'smith')
    expect(smithTurns).toHaveLength(2)
    expect(smithTurns.every((input) => input.speed === 'fast')).toBe(true)
  })

  it('hands a fast pin to the driver without adding it to the roster persona', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, chatId } = await harness(recording(createMockDriver({ deltaDelayMs: 0 }), seen), {
      agents: [{ ...sage, driver: 'codex', model: 'gpt-6.1-sol' }],
    })

    await orchestrator.setOverride(chatId, 'sage', { speed: 'fast' })
    await orchestrator.submitUserMessage(chatId, '@Sage quick one')

    expect(seen[0]?.speed).toBe('fast')
    expect(await orchestrator.overrides(chatId)).toEqual({ sage: { speed: 'fast' } })
    expect('speed' in sage).toBe(false)
  })

  it('passes each persona Fast default to the driver and lets a chat switch it off and on', async () => {
    const fast = { ...sage, driver: 'codex' as const, model: 'gpt-6.1-sol', speed: 'fast' as const }
    const seen: TurnInput[] = []
    const { orchestrator, store, chatId } = await harness(recording(createMockDriver({ deltaDelayMs: 0 }), seen), {
      agents: [fast, smith],
    })
    await orchestrator.submitUserMessage(chatId, '@Sage @Smith hello')
    expect(seen.find((turn) => turn.agent.id === sage.id)?.speed).toBe('fast')
    expect(seen.find((turn) => turn.agent.id === smith.id)?.speed).toBeUndefined()
    await orchestrator.setOverride(chatId, sage.id, { speed: 'standard' })
    await orchestrator.submitUserMessage(chatId, '@Sage continue')
    expect(seen.at(-1)?.speed).toBeUndefined()
    await orchestrator.setOverride(chatId, sage.id, { speed: 'fast' })
    await orchestrator.submitUserMessage(chatId, '@Sage quick again')
    expect(seen.at(-1)?.speed).toBe('fast')
    expect((await store.loadRoster()).find((agent) => agent.id === sage.id)?.speed).toBe('fast')
  })

  it.each(['fast', 'standard'] as const)('snapshots the %s default when Auto falls back, so a later roster edit does not change the pin', async (speed) => {
    const original = speed === 'fast' ? 'fast' : undefined
    const agents: AgentConfig[] = [{ ...sage, driver: 'codex', model: 'gpt-6.1-sol', speed: original }]
    const seen: TurnInput[] = []
    const select = vi.fn<NonNullable<OrchestratorOptions['selectAutoRuntime']>>().mockResolvedValue({ reason: 'timeout' })
    const { orchestrator, chatId } = await harness(recording(createMockDriver({ deltaDelayMs: 0 }), seen), {
      agents, selectAutoRuntime: select,
    })
    await orchestrator.submitUserMessage(chatId, '@Sage hello')
    expect((await orchestrator.overrides(chatId)).sage?.speed).toBe(original)
    agents[0] = { ...agents[0]!, speed: original === 'fast' ? undefined : 'fast' }
    await orchestrator.submitUserMessage(chatId, '@Sage continue')
    expect(seen).toHaveLength(2)
    expect(seen.every((turn) => turn.speed === original)).toBe(true)
    expect(select).toHaveBeenCalledOnce()
  })

  it('runs a pinned turn on the pinned model and effort, and the roster stays untouched', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, chatId } = await harness(recording(createMockDriver({ deltaDelayMs: 0 }), seen))

    await orchestrator.setOverride(chatId, 'sage', { model: 'claude-sonnet-5', effort: 'low' })
    await orchestrator.submitUserMessage(chatId, '@Sage quick one')

    expect(seen[0]?.agent.model).toBe('claude-sonnet-5')
    expect(seen[0]?.agent.effort).toBe('low')
    // The pin is chat state, not roster state.
    expect(roster.find((agent) => agent.id === 'sage')?.effort).toBe('high')
    expect(await orchestrator.overrides(chatId)).toEqual({ sage: { model: 'claude-sonnet-5', effort: 'low' } })
  })

  it('half a pin overrides only that half, and only for the pinned agent', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, chatId } = await harness(recording(createMockDriver({ deltaDelayMs: 0 }), seen))

    await orchestrator.setOverride(chatId, 'sage', { effort: 'max' })
    await orchestrator.submitUserMessage(chatId, '@Sage @Smith both')

    expect(seen.map((input) => [input.agent.id, input.agent.effort, input.agent.model])).toEqual([
      ['sage', 'max', undefined],
      ['smith', 'high', undefined],
    ])
  })

  it('an empty override is the way out', async () => {
    const { orchestrator, chatId } = await harness(createMockDriver({ deltaDelayMs: 0 }))

    await orchestrator.setOverride(chatId, 'sage', { effort: 'low' })
    await orchestrator.setOverride(chatId, 'sage', {})
    expect(await orchestrator.overrides(chatId)).toEqual({})
  })

  /**
   * The bug this whole feature was reported for: pins used to live in one Map here, so
   * restarting the process put every chat back on the roster defaults without saying
   * so. A second Orchestrator over the same store stands in for that restart.
   */
  it('a pin survives the process it was set in, and its turn still runs on it', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, store, chatId } = await harness(createMockDriver({ deltaDelayMs: 0 }))
    await orchestrator.setOverride(chatId, 'sage', { model: 'claude-sonnet-5', effort: 'low' })

    const restarted = new Orchestrator({
      agents: () => roster,
      store,
      mcpServers: () => [],
      skills: () => [],
      resolveDriver: () => recording(createMockDriver({ deltaDelayMs: 0 }), seen),
      ensureScratchDir: scratchFor,
      emit: () => undefined,
    })

    expect(await restarted.overrides(chatId)).toEqual({ sage: { model: 'claude-sonnet-5', effort: 'low' } })
    await restarted.submitUserMessage(chatId, '@Sage still pinned?')
    expect(seen[0]?.agent.model).toBe('claude-sonnet-5')
    expect(seen[0]?.agent.effort).toBe('low')
  })

  it('a deleted chat takes its pins with it, so a reused id starts clean', async () => {
    const { orchestrator, store, chatId } = await harness(createMockDriver({ deltaDelayMs: 0 }))

    await orchestrator.setOverride(chatId, 'sage', { effort: 'low' })
    orchestrator.discard(chatId)
    await store.deleteChat(chatId)

    expect(await store.loadChatOverrides(chatId)).toEqual({})
  })

  it('ends an active turn when its chat is discarded', async () => {
    const gate = gated()
    const { orchestrator, store, chatId, sent } = await harness(gate.driver)
    const running = orchestrator.submitUserMessage(chatId, '@Sage read this')
    await until(() => gate.forChat(chatId).length === 1, 'the active turn')
    const turnId = orchestrator.activeTurn(chatId)?.turnId
    if (turnId === undefined) throw new Error('the turn should be active')

    orchestrator.discard(chatId)
    await store.deleteChat(chatId)
    await running

    expect(sent.filter((message) => message.type === 'turn_state' && message.turnId === turnId &&
      message.state !== 'running')).toEqual([
      expect.objectContaining({ type: 'turn_state', turnId, state: 'aborted' }),
    ])
  })

  it('a deleted persona takes her pins with her, the way her CLI sessions go', async () => {
    const { orchestrator, store, chatId } = await harness(createMockDriver({ deltaDelayMs: 0 }))

    await orchestrator.setOverride(chatId, 'sage', { effort: 'low' })
    await orchestrator.setOverride(chatId, 'smith', { effort: 'max' })
    await store.deleteAgent('sage')

    expect(await store.loadChatOverrides(chatId)).toEqual({ smith: { effort: 'max' } })
  })

  it('refuses a pin on a chat that is gone, rather than holding one nobody reads', async () => {
    const { orchestrator, store, chatId } = await harness(createMockDriver({ deltaDelayMs: 0 }))

    orchestrator.discard(chatId)
    await store.deleteChat(chatId)

    await expect(orchestrator.setOverride(chatId, 'sage', { effort: 'low' })).rejects.toThrow(/unknown chat/)
  })
})

describe('Orchestrator, reasoning and edits in the transcript', () => {
  it('writes reasoning as its own durable row attributed to the agent', async () => {
    const { orchestrator, store, chatId } = await harness(createMockDriver({ deltaDelayMs: 0 }))

    await orchestrator.submitUserMessage(chatId, '@Sage what first?')

    const reasoning = (await store.loadEvents(chatId)).filter((event) => event.type === 'reasoning')
    expect(reasoning).toHaveLength(1)
    expect(reasoning[0]).toMatchObject({ agentId: 'sage', type: 'reasoning' })
    expect(reasoning[0]).toHaveProperty('turnId')
    expect((reasoning[0] as { text: string }).text.length).toBeGreaterThan(0)
  })

  it('keeps reasoning ahead of the reply it explains, so the trace reads in order', async () => {
    const { orchestrator, store, chatId } = await harness(createMockDriver({ deltaDelayMs: 0 }))

    await orchestrator.submitUserMessage(chatId, '@Sage what first?')

    const types = (await store.loadEvents(chatId)).map((event) => event.type)
    expect(types.indexOf('reasoning')).toBeLessThan(types.indexOf('agent_message'))
  })

  it('carries a tool call edits through to the transcript, so a diff survives reload', async () => {
    const { orchestrator, store, chatId } = await harness(createMockDriver({ deltaDelayMs: 0 }))

    // Smith is the roster's persona with tools; a persona without them never edits.
    await orchestrator.submitUserMessage(chatId, '@Smith change the notes')

    const edited = (await store.loadEvents(chatId)).find(
      (event) => event.type === 'tool_use' && event.edits !== undefined,
    )
    expect(edited).toMatchObject({
      tool: 'Edit',
      edits: [{ path: 'notes.md' }],
    })
  })

  it('persists edits a provider establishes only when the tool result succeeds', async () => {
    const { orchestrator, store, chatId } = await harness(
      scripted(
        () => [
          { type: 'tool_use', toolCallId: 'edit-1', tool: 'Edit', targets: ['notes.md'] },
          {
            type: 'tool_result',
            toolCallId: 'edit-1',
            outcome: 'success',
            edits: [{ path: 'notes.md', kind: 'update' }],
          },
          { type: 'message', messageId: 'answer', text: 'Done.' },
          { type: 'result', text: 'Done.', sessionId: 'session-1' },
        ],
        [],
      ),
    )

    await orchestrator.submitUserMessage(chatId, '@Smith change the notes')

    const result = (await store.loadEvents(chatId)).find((event) => event.type === 'tool_result')
    expect(result).toMatchObject({
      outcome: 'success',
      edits: [{ path: 'notes.md', kind: 'update' }],
    })
    expect(ThreadEventSchema.safeParse(result).success).toBe(true)
  })

  it('persists provider-observed Fast evidence on the turn result', async () => {
    const { orchestrator, store, chatId } = await harness(
      scripted(
        () => [
          { type: 'message', messageId: 'answer', text: 'Done.' },
          { type: 'result', text: 'Done.', observedSpeed: 'fast', sessionId: 'session-1' },
        ],
        [],
      ),
    )

    await orchestrator.submitUserMessage(chatId, '@Sage go')

    const result = (await store.loadEvents(chatId)).find((event) => event.type === 'turn_result')
    expect(result).toMatchObject({ observedSpeed: 'fast' })
    expect(ThreadEventSchema.safeParse(result).success).toBe(true)
  })
})

describe('Orchestrator, oversized reasoning cannot poison a thread', () => {
  /**
   * Nothing validates on the way into the store, and `snapshot.events` is parsed as
   * one array on reload: a single over-cap row fails the whole parse, so the client
   * drops the snapshot and the chat never opens again. The clamp is what stops one
   * careless driver from costing a transcript.
   */
  it('clamps a driver that emits reasoning over the cap, keeping the row valid', async () => {
    const { orchestrator, store, chatId } = await harness(
      scripted(
        () => [
          { type: 'reasoning', text: 'y'.repeat(REASONING_LIMIT * 2) },
          { type: 'message', messageId: 'answer', text: 'Done.' },
          { type: 'result', text: 'Done.', sessionId: 'session-1' },
        ],
        [],
      ),
    )

    await orchestrator.submitUserMessage(chatId, '@Sage go')

    const events = await store.loadEvents(chatId)
    const reasoning = events.find((event) => event.type === 'reasoning')
    expect((reasoning as { text: string }).text).toHaveLength(REASONING_LIMIT)
    // The durable row, and therefore the snapshot built from it, still validate.
    expect(ThreadEventSchema.safeParse(reasoning).success).toBe(true)
    expect(events.every((event) => ThreadEventSchema.safeParse(event).success)).toBe(true)
  })

  it('keeps the mock driver inside the cap even when the user pastes a document', async () => {
    const { orchestrator, store, chatId } = await harness(createMockDriver({ deltaDelayMs: 0 }))

    await orchestrator.submitUserMessage(chatId, `@Sage ${'x'.repeat(REASONING_LIMIT + 2_000)}`)

    const events = await store.loadEvents(chatId)
    expect(events.every((event) => ThreadEventSchema.safeParse(event).success)).toBe(true)
  })
})

describe('a turn that used tools and said nothing', () => {
  it('keeps outbound drafts available to a DM routine without allowing ask_user', async () => {
    const allowAskValues: boolean[] = []
    const seen: TurnInput[] = []
    const { orchestrator, store } = await harness(
      scripted(() => [{ type: 'result', text: 'Draft prepared.', sessionId: 'session-1' }], seen),
      {
        interactionMcp: (_chatId, _agent, _turnId, allowAsk) => {
          allowAskValues.push(allowAsk)
          return interactionMcpAttachment('http://127.0.0.1:8787/internal/user-input', 'routine-capability', { allowAsk })
        },
      },
    )
    const dm = await store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })

    await orchestrator.submitUserMessage(dm.id, 'Prepare the mail reply.', [], {
      source: 'routine',
      routineId: 'routine-mail',
      routineName: 'Mail catch-up',
      targetAgentId: 'sage',
      previousRunAt: null,
    })

    expect(allowAskValues).toEqual([false])
    expect(seen[0]?.mcpServers?.find((attachment) => attachment.server.name === 'manor')).toMatchObject({
      disabledTools: [],
      server: { tools: ['prepare_outbound_draft'] },
    })
  })

  it('fails open after one retry when a DM routine still returns no status or message', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, store } = await harness(
      scripted(
        () => [
          { type: 'tool_use', toolCallId: 'mail-1', tool: 'gmail_search', detail: 'new mail' },
          { type: 'tool_result', toolCallId: 'mail-1', outcome: 'success' },
          { type: 'result', text: '', sessionId: 'session-1' },
        ],
        seen,
      ),
    )
    const dm = await store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })

    await orchestrator.submitUserMessage(dm.id, 'Check for new mail.', [], {
      source: 'routine',
      routineId: 'routine-mail',
      routineName: 'Mail catch-up',
      targetAgentId: 'sage',
      previousRunAt: null,
    })
    const events = await store.loadEvents(dm.id)

    expect(seen).toHaveLength(2)
    expect(events[0]).toMatchObject({
      type: 'user_message',
      source: 'routine',
    })
    expect(events.find((event) => event.type === 'agent_message')).toMatchObject({
      text: "Mail catch-up didn't finish.",
    })
    expect(events.some((event) =>
      event.type === 'system_note' && event.text.includes('required a visible result'),
    )).toBe(false)
    expect(events.filter((event) => event.type === 'turn_result')).toEqual([
      expect.objectContaining({ routineOutcome: 'publish' }),
    ])
    expect(seen[0]?.agent.character).toContain(DM_ROUTINE_OUTCOME_HEADING)
    expect(seen[0]?.contextBlock).toContain(DM_ROUTINE_OUTCOME_HEADING)
  })

  it.each(['quiet', 'publish', 'error'] as const)('recovers a preamble-only DM routine with a %s outcome', async (outcome) => {
    const seen: TurnInput[] = []
    const preamble = 'Ik check Slack sinds 11:00 UTC, read-only.'
    const text = outcome === 'quiet'
      ? DM_ROUTINE_QUIET_MARKER
      : `Een nieuwe mention vraagt om antwoord.\n${DM_ROUTINE_PUBLISH_MARKER}`
    const { orchestrator, store, sent } = await harness(
      scripted((_input, attempt) => attempt === 1 ? [
        { type: 'delta', messageId: 'preamble', text: preamble },
        { type: 'tool_use', toolCallId: 'slack-1', tool: 'slack_search' },
        { type: 'tool_result', toolCallId: 'slack-1', outcome: 'success' },
        { type: 'message', messageId: 'preamble', text: preamble },
        { type: 'result', text: preamble, sessionId: 'session-1', usage: { inputTokens: 100, outputTokens: 10 } },
      ] : outcome === 'error' ? [
        { type: 'error', message: 'Connection dropped' },
      ] : [
        { type: 'message', messageId: 'report', text },
        { type: 'result', text, sessionId: 'session-1', usage: { inputTokens: 20, outputTokens: 5 } },
      ], seen),
    )
    const dm = await store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })

    await orchestrator.submitUserMessage(dm.id, 'Check Slack.', [], {
      source: 'routine', routineId: 'routine-slack', routineName: 'Slack triage',
      targetAgentId: 'sage', previousRunAt: null,
    })
    const events = await store.loadEvents(dm.id)

    expect(seen).toHaveLength(2)
    expect(seen[1]?.sessionId).toBe('session-1')
    expect(seen[1]?.contextBlock).toContain(DM_ROUTINE_OUTCOME_HEADING)
    expect(seen[1]?.catchUp).toEqual([expect.objectContaining({
      text: expect.stringContaining(`return only ${DM_ROUTINE_QUIET_MARKER}, with no announcement or chat message`),
    })])
    expect(seen[1]?.catchUp[0]).toMatchObject({
      text: expect.stringContaining(DM_ROUTINE_PUBLISH_MARKER),
    })
    expect(seen[1]?.catchUp[0]).not.toMatchObject({ text: REPORT_BACK_NUDGE })
    expect(events.filter((event) => event.type === 'tool_use')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'agent_message')).toEqual(
      outcome === 'publish' ? [expect.objectContaining({ text: 'Een nieuwe mention vraagt om antwoord.' })]
        : outcome === 'error' ? [expect.objectContaining({ text: "Slack triage didn't finish." })]
        : [],
    )
    expect(sent.some((message) => message.type === 'delta')).toBe(false)
    if (outcome === 'error') {
      expect(events.some((event) =>
        event.type === 'system_note' && event.text.includes('Connection dropped'),
      )).toBe(false)
    } else {
      expect(events.find((event) => event.type === 'turn_result')).toMatchObject({
        routineOutcome: outcome, usage: { inputTokens: 120, outputTokens: 15 },
      })
    }
  })

  it('discards a DM routine reply that explicitly declares a quiet success', async () => {
    const text = `Geen nieuwe DM of mention die om een reactie vraagt.\n${DM_ROUTINE_QUIET_MARKER}`
    const { orchestrator, store, sent } = await harness(
      scripted(() => [
        { type: 'delta', messageId: 'quiet', text },
        { type: 'message', messageId: 'quiet', text },
        { type: 'result', text, sessionId: 'session-1' },
      ], []),
    )
    const dm = await store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })

    await orchestrator.submitUserMessage(dm.id, 'Check Slack.', [], {
      source: 'routine',
      routineId: 'routine-slack',
      routineName: 'Slack triage',
      targetAgentId: 'sage',
      previousRunAt: null,
    })
    const events = await store.loadEvents(dm.id)

    expect(events.some((event) => event.type === 'agent_message')).toBe(false)
    expect(events.find((event) => event.type === 'turn_result')).toMatchObject({ routineOutcome: 'quiet' })
    expect(sent.some((message) => message.type === 'delta')).toBe(false)
    expect(sent.find((message) => message.type === 'turn_state' && message.state === 'done')).toMatchObject({
      routineOutcome: 'quiet',
    })
  })

  it('publishes a DM routine reply without exposing its outcome marker', async () => {
    const text = `Nieuwe DM van Sam vraagt om antwoord.\n${DM_ROUTINE_PUBLISH_MARKER}`
    const { orchestrator, store } = await harness(
      scripted(() => [
        { type: 'message', messageId: 'attention', text },
        { type: 'result', text, sessionId: 'session-1' },
      ], []),
    )
    const dm = await store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })

    await orchestrator.submitUserMessage(dm.id, 'Check Slack.', [], {
      source: 'routine',
      routineId: 'routine-slack',
      routineName: 'Slack triage',
      targetAgentId: 'sage',
      previousRunAt: null,
    })
    const events = await store.loadEvents(dm.id)

    expect(events.find((event) => event.type === 'agent_message')).toMatchObject({
      text: 'Nieuwe DM van Sam vraagt om antwoord.',
    })
    expect(events.find((event) => event.type === 'turn_result')).toMatchObject({ routineOutcome: 'publish' })
    expect(events.find((event) => event.type === 'turn_result')).not.toHaveProperty('routineIncomplete')
    expect(events.some((event) => 'text' in event && event.text.includes('MANOR_ROUTINE_OUTCOME'))).toBe(false)
  })

  it('publishes an incomplete DM routine run and flags it so the watermark holds', async () => {
    const text = `Gmail-resultaat te groot, 13:12 tot 16:00 niet gecontroleerd.\n${DM_ROUTINE_INCOMPLETE_MARKER}`
    const { orchestrator, store } = await harness(
      scripted(() => [
        { type: 'message', messageId: 'partial', text },
        { type: 'result', text, sessionId: 'session-1' },
      ], []),
    )
    const dm = await store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })

    await orchestrator.submitUserMessage(dm.id, 'Check mail.', [], {
      source: 'routine',
      routineId: 'routine-mail',
      routineName: 'Mail catch-up',
      targetAgentId: 'sage',
      previousRunAt: null,
    })
    const events = await store.loadEvents(dm.id)

    expect(events.find((event) => event.type === 'agent_message')).toMatchObject({
      text: 'Gmail-resultaat te groot, 13:12 tot 16:00 niet gecontroleerd.',
    })
    expect(events.find((event) => event.type === 'turn_result')).toMatchObject({ routineOutcome: 'publish', routineIncomplete: true })
    expect(events.some((event) => 'text' in event && event.text.includes('MANOR_ROUTINE_OUTCOME'))).toBe(false)
  })

  it('strips an echoed outcome marker from an ordinary DM reply', async () => {
    const text = `Ja, Thijmen mailde terug.\n\n${DM_ROUTINE_PUBLISH_MARKER}`
    const { orchestrator, store } = await harness(
      scripted(() => [
        { type: 'message', messageId: 'reply', text },
        { type: 'result', text, sessionId: 'session-1' },
      ], []),
    )
    const dm = await store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })

    await orchestrator.submitUserMessage(dm.id, 'nog iets?')
    const events = await store.loadEvents(dm.id)

    expect(events.find((event) => event.type === 'agent_message')).toMatchObject({
      text: 'Ja, Thijmen mailde terug.',
    })
    expect(events.some((event) => 'text' in event && event.text.includes('MANOR_ROUTINE_OUTCOME'))).toBe(false)
  })

  it('runs a DM routine in its own empty session and lets the conversation catch up on it', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, store } = await harness(
      scripted((input) => input.catchUp.some((event) => event.type === 'user_message' && event.source === 'routine' && event.text === 'Check mail.') && seen.length === 1
        ? [{ type: 'result', text: `Sam vraagt om een reactie.\n${DM_ROUTINE_PUBLISH_MARKER}`, sessionId: 'routine-session' }]
        : [{ type: 'result', text: 'Prima.', sessionId: 'conversation-session' }], seen),
    )
    const dm = await store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })
    await store.appendEvent(dm.id, { type: 'user_message', text: 'Private context from earlier.', mentions: [] })
    await store.appendEvent(dm.id, { type: 'turn_result', agentId: 'sage', turnId: 'turn_old' })
    await store.setSession(dm.id, 'sage', 'conversation-session', { driver: 'mock' })

    await orchestrator.submitUserMessage(dm.id, 'Check mail.', [], {
      source: 'routine', routineId: 'routine-mail', routineName: 'Mail catch-up', targetAgentId: 'sage', previousRunAt: null,
    })

    expect(seen[0]?.sessionId).toBeUndefined()
    expect(seen[0]?.catchUp.map((event) => event.type)).toEqual(['user_message'])
    expect(JSON.stringify(seen[0]?.catchUp)).not.toContain('Private context from earlier.')
    expect(await store.getSessions(dm.id, 'sage')).toMatchObject([{ sessionId: 'conversation-session' }])

    await orchestrator.submitUserMessage(dm.id, 'Maak daar een concept van.')

    expect(seen[1]?.sessionId).toBe('conversation-session')
    expect(seen[1]?.catchUp.map((event) => 'text' in event ? event.text : event.type)).toEqual(expect.arrayContaining([
      'Check mail.', 'Sam vraagt om een reactie.', 'Maak daar een concept van.',
    ]))
    expect(JSON.stringify(seen[1]?.catchUp)).not.toContain('Private context from earlier.')
  })

  it.each([true, false])('publishes an unmarked DM routine reply with a resumable session %s', async (resumable) => {
    const seen: TurnInput[] = []
    const { orchestrator, store } = await harness(
      scripted(() => [{
        type: 'result', text: 'I found something unusual.',
        ...(resumable ? { sessionId: 'session-1' } : {}),
      }], seen),
    )
    const dm = await store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })

    await orchestrator.submitUserMessage(dm.id, 'Check Slack.', [], {
      source: 'routine',
      routineId: 'routine-slack',
      routineName: 'Slack triage',
      targetAgentId: 'sage',
      previousRunAt: null,
    })
    const events = await store.loadEvents(dm.id)

    expect(events.find((event) => event.type === 'agent_message')).toMatchObject({
      text: 'I found something unusual.',
    })
    expect(seen).toHaveLength(resumable ? 2 : 1)
    expect(events.filter((event) => event.type === 'agent_message')).toHaveLength(1)
    expect(events.find((event) => event.type === 'turn_result')).toMatchObject({ routineOutcome: 'publish' })
  })

  it('publishes buffered delta-only text when the terminal result text is empty', async () => {
    const text = `Nieuwe mention vraagt om antwoord.\n${DM_ROUTINE_PUBLISH_MARKER}`
    const { orchestrator, store } = await harness(
      scripted(() => [
        { type: 'delta', messageId: 'attention', text },
        { type: 'result', text: '', sessionId: 'session-1' },
      ], []),
    )
    const dm = await store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })

    await orchestrator.submitUserMessage(dm.id, 'Check Slack.', [], {
      source: 'routine',
      routineId: 'routine-slack',
      routineName: 'Slack triage',
      targetAgentId: 'sage',
      previousRunAt: null,
    })
    const events = await store.loadEvents(dm.id)

    expect(events.find((event) => event.type === 'agent_message')).toMatchObject({
      text: 'Nieuwe mention vraagt om antwoord.',
    })
    expect(events.find((event) => event.type === 'turn_result')).toMatchObject({ routineOutcome: 'publish' })
  })

  it('keeps a DM routine provider failure visible', async () => {
    const { orchestrator, store } = await harness(
      scripted(() => [{ type: 'error', message: 'Slack unavailable' }], []),
    )
    const dm = await store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })

    await orchestrator.submitUserMessage(dm.id, 'Check Slack.', [], {
      source: 'routine',
      routineId: 'routine-slack',
      routineName: 'Slack triage',
      targetAgentId: 'sage',
      previousRunAt: null,
    })

    expect((await store.loadEvents(dm.id)).find((event) => event.type === 'agent_message')).toMatchObject({
      text: "Slack triage didn't finish.",
    })
    expect((await store.loadEvents(dm.id)).some((event) =>
      event.type === 'system_note' && event.text.includes('Slack unavailable'),
    )).toBe(false)
  })

  it('does not accept quiet when a tool reported an error', async () => {
    const text = `Slack could not be checked.\n${DM_ROUTINE_QUIET_MARKER}`
    const { orchestrator, store } = await harness(
      scripted(() => [
        { type: 'tool_use', toolCallId: 'slack-1', tool: 'slack_search' },
        { type: 'tool_result', toolCallId: 'slack-1', outcome: 'error' },
        { type: 'message', messageId: 'failure', text },
        { type: 'result', text, sessionId: 'session-1' },
      ], []),
    )
    const dm = await store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })

    await orchestrator.submitUserMessage(dm.id, 'Check Slack.', [], {
      source: 'routine',
      routineId: 'routine-slack',
      routineName: 'Slack triage',
      targetAgentId: 'sage',
      previousRunAt: null,
    })
    const events = await store.loadEvents(dm.id)

    expect(events.find((event) => event.type === 'agent_message')).toMatchObject({
      text: 'Slack could not be checked.',
    })
    expect(events.find((event) => event.type === 'turn_result')).toMatchObject({ routineOutcome: 'publish' })
  })

  it('does not accept quiet when an error arrives after the result event', async () => {
    const text = `Nothing needs attention.\n${DM_ROUTINE_QUIET_MARKER}`
    const { orchestrator, store } = await harness(
      scripted(() => [
        { type: 'message', messageId: 'quiet', text },
        { type: 'result', text, sessionId: 'session-1' },
        { type: 'error', message: 'late provider failure' },
      ], []),
    )
    const dm = await store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })

    await orchestrator.submitUserMessage(dm.id, 'Check Slack.', [], {
      source: 'routine',
      routineId: 'routine-slack',
      routineName: 'Slack triage',
      targetAgentId: 'sage',
      previousRunAt: null,
    })
    const events = await store.loadEvents(dm.id)

    expect(events.find((event) => event.type === 'agent_message')).toMatchObject({
      text: 'Nothing needs attention.',
    })
    expect(events.find((event) => event.type === 'turn_result')).toMatchObject({ routineOutcome: 'publish' })
    expect(events.find((event) => event.type === 'system_note')).toMatchObject({
      text: expect.stringContaining('late provider failure'),
    })
  })

  it('publishes an attachment even when the model declares quiet', async () => {
    const image = { name: 'slack.png', dataUrl: 'data:image/png;base64,aW1hZ2U=' }
    const { orchestrator, store } = await harness(
      scripted(() => [
        { type: 'result', text: DM_ROUTINE_QUIET_MARKER, sessionId: 'session-1' },
        { type: 'attachment', image },
      ], []),
    )
    const dm = await store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })

    await orchestrator.submitUserMessage(dm.id, 'Check Slack.', [], {
      source: 'routine',
      routineId: 'routine-slack',
      routineName: 'Slack triage',
      targetAgentId: 'sage',
      previousRunAt: null,
    })
    const events = await store.loadEvents(dm.id)

    expect(events.find((event) => event.type === 'agent_message')).toMatchObject({
      text: '',
      images: [image],
    })
    expect(events.find((event) => event.type === 'turn_result')).toMatchObject({ routineOutcome: 'publish' })
  })

  it('gets one report-back attempt, resumed and carrying only the nudge', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, store, chatId } = await harness(
      scripted(
        (_input, attempt) =>
          attempt === 1
            ? [
                { type: 'tool_use', toolCallId: 'edit-1', tool: 'Edit', detail: 'projectMemory.ts' },
                { type: 'tool_result', toolCallId: 'edit-1', outcome: 'success' },
                { type: 'result', text: '', usage: { inputTokens: 20, outputTokens: 4 }, sessionId: 'session-1' },
              ]
            : [
                { type: 'message', messageId: 'report', text: 'Added the fallback.' },
                { type: 'result', text: 'Added the fallback.', usage: { inputTokens: 5, outputTokens: 3 }, sessionId: 'session-1' },
              ],
        seen,
      ),
    )

    await orchestrator.submitUserMessage(chatId, '@Sage do the thing')
    const events = await store.loadEvents(chatId)

    expect(seen).toHaveLength(2)
    // Resumed, so the persona still has the work it just did in its own context.
    expect(seen[1]?.sessionId).toBe('session-1')
    expect(seen[1]?.catchUp.map((event) => event.type)).toEqual(['system_note'])
    expect(seen[1]?.catchUp[0]).toMatchObject({ text: REPORT_BACK_NUDGE })

    expect(events.filter((event) => event.type === 'agent_message').map((event) => event.text)).toEqual([
      'Added the fallback.',
    ])
    // Recovered, so nothing about the prod is left in the thread.
    expect(events.some((event) => event.type === 'system_note')).toBe(false)
    // One turn_result for the turn, carrying both attempts' tokens.
    const results = events.filter((event) => event.type === 'turn_result')
    expect(results).toHaveLength(1)
    expect(results[0]?.usage).toEqual({ inputTokens: 25, outputTokens: 7 })
  })

  it('says so in the thread when the second attempt is silent too, and never tries a third', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, store, chatId, sent } = await harness(
      scripted(
        () => [
          { type: 'tool_use', toolCallId: 'edit-1', tool: 'Edit', detail: 'projectMemory.ts' },
          { type: 'result', text: '', sessionId: 'session-1' },
        ],
        seen,
      ),
    )

    await orchestrator.submitUserMessage(chatId, '@Sage do the thing')
    const events = await store.loadEvents(chatId)

    expect(seen).toHaveLength(2)
    const note = events.find((event) => event.type === 'system_note')
    expect(note?.text).toContain('without reporting back, twice')
    // Still a finished turn, not an error: the work happened, only the report did not.
    expect(events.filter((event) => event.type === 'turn_result')).toHaveLength(1)
    expect(
      sent.some((message) => message.type === 'turn_state' && message.state === 'done'),
    ).toBe(true)
  })

  it('leaves a silent turn that used no tools alone, with one note', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, store, chatId } = await harness(
      scripted(() => [{ type: 'result', text: '', sessionId: 'session-1' }], seen),
    )

    await orchestrator.submitUserMessage(chatId, '@Sage do the thing')
    const events = await store.loadEvents(chatId)

    expect(seen).toHaveLength(1)
    expect(events.find((event) => event.type === 'system_note')?.text).toContain(
      'ended the turn without reporting back.',
    )
  })

  // The case a "did it speak at all" check let through, and the one that reached
  // The user: a preamble before the work reads as an answer to the server and as nothing
  // at all to the reader, so the turn was never retried and the thread ended on tool
  // calls (market scan, 2026-08-16).
  it('retries a turn whose only words came before the work', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, store, chatId } = await harness(
      scripted(
        (_input, attempt) =>
          attempt === 1
            ? [
                { type: 'delta', messageId: 'message_1', text: 'I will run the scan, then follow the file.' },
                { type: 'message', messageId: 'message_1', text: 'I will run the scan, then follow the file.' },
                { type: 'tool_use', toolCallId: 'run-1', tool: 'Bash', detail: 'uv run scan.py' },
                { type: 'tool_result', toolCallId: 'run-1', outcome: 'success' },
                { type: 'result', text: 'I will run the scan, then follow the file.', sessionId: 'session-1' },
              ]
            : [
                { type: 'delta', messageId: 'message_2', text: 'Scanned 91 boards, nothing new.' },
                { type: 'message', messageId: 'message_2', text: 'Scanned 91 boards, nothing new.' },
                { type: 'result', text: 'Scanned 91 boards, nothing new.', sessionId: 'session-1' },
              ],
        seen,
      ),
    )

    await orchestrator.submitUserMessage(chatId, '@Sage do the thing')
    const events = await store.loadEvents(chatId)

    expect(seen).toHaveLength(2)
    // And once it reports, no complaint: the thread ends on the answer.
    expect(events.some((event) => event.type === 'system_note' && event.text.includes('reporting back'))).toBe(false)
    expect(events.filter((event) => event.type === 'agent_message').at(-1)).toMatchObject({
      text: 'Scanned 91 boards, nothing new.',
    })
  })

  it('still retries when delta-only text came before the last tool call', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, store, chatId } = await harness(
      scripted(
        (_input, attempt) =>
          attempt === 1
            ? [
                { type: 'delta', messageId: 'preamble', text: 'I will check now.' },
                { type: 'tool_use', toolCallId: 'scan-1', tool: 'slack_search' },
                { type: 'tool_result', toolCallId: 'scan-1', outcome: 'success' },
                { type: 'result', text: '', sessionId: 'session-1' },
              ]
            : [
                { type: 'result', text: 'Checked Slack; nothing needs attention.', sessionId: 'session-1' },
              ],
        seen,
      ),
    )

    await orchestrator.submitUserMessage(chatId, '@Sage check Slack')

    expect(seen).toHaveLength(2)
    expect(seen[1]?.catchUp).toEqual([
      expect.objectContaining({ type: 'system_note', text: REPORT_BACK_NUDGE }),
    ])
    expect((await store.loadEvents(chatId)).filter((event) => event.type === 'turn_result')).toHaveLength(1)
  })

  it('accepts delta-only text streamed after the last tool as the report', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, store, chatId } = await harness(
      scripted(
        () => [
          { type: 'tool_use', toolCallId: 'scan-1', tool: 'slack_search' },
          { type: 'tool_result', toolCallId: 'scan-1', outcome: 'success' },
          { type: 'delta', messageId: 'report', text: 'Checked Slack; nothing needs attention.' },
          { type: 'result', text: '', sessionId: 'session-1' },
        ],
        seen,
      ),
    )

    await orchestrator.submitUserMessage(chatId, '@Sage check Slack')
    const events = await store.loadEvents(chatId)

    expect(seen).toHaveLength(1)
    expect(events.filter((event) => event.type === 'agent_message')).toEqual([
      expect.objectContaining({ text: 'Checked Slack; nothing needs attention.' }),
    ])
    expect(events.some((event) => event.type === 'system_note')).toBe(false)
  })

  it('leaves a turn that reported after its tools alone', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, store, chatId } = await harness(
      scripted(
        () => [
          { type: 'tool_use', toolCallId: 'run-1', tool: 'Bash', detail: 'uv run scan.py' },
          { type: 'tool_result', toolCallId: 'run-1', outcome: 'success' },
          { type: 'delta', messageId: 'message_1', text: 'Scanned 91 boards, nothing new.' },
          { type: 'message', messageId: 'message_1', text: 'Scanned 91 boards, nothing new.' },
          { type: 'result', text: 'Scanned 91 boards, nothing new.', sessionId: 'session-1' },
        ],
        seen,
      ),
    )

    await orchestrator.submitUserMessage(chatId, '@Sage do the thing')

    expect(seen).toHaveLength(1)
    expect(
      (await store.loadEvents(chatId)).some(
        (event) => event.type === 'system_note' && event.text.includes('reporting back'),
      ),
    ).toBe(false)
  })

  it('does not retry when there is no session to resume', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, chatId } = await harness(
      scripted(() => [{ type: 'tool_use', toolCallId: 't', tool: 'Bash' }, { type: 'result', text: '' }], seen),
    )

    await orchestrator.submitUserMessage(chatId, '@Sage do the thing')

    // A blank retry would make the persona invent a summary of work it cannot see.
    expect(seen).toHaveLength(1)
  })
})

describe('explicit browser targeting', () => {
  const builtInMcp = () => browserMcpAttachment('http://localhost/browser', 'test-capability')
  const context = '[Manor] Explicit browser target: @browser; use mcp__browser__* only.'

  it('reaches every addressed persona with memory off and clears on the next untargeted request', async () => {
    const seen: TurnInput[] = []
    const target = vi.fn(async () => context)
    const { orchestrator, chatId } = await harness(scripted(() => [
      { type: 'message', messageId: 'answer', text: 'Done.' }, { type: 'result', text: 'Done.', sessionId: 'session-browser' },
    ], seen), { builtInMcp, browserTargetContext: target })
    await orchestrator.submitUserMessage(chatId, '@Sage @Smith inspect @browser')
    expect(seen.map((input) => input.agent.id)).toEqual(['sage', 'smith'])
    for (const input of seen) {
      expect(input.agent.memoryScope).toBe(false)
      expect(input.contextBlock).toContain(context)
      expect(input.mcpServers?.some((item) => item.server.name === 'browser')).toBe(true)
    }
    expect(target).toHaveBeenNthCalledWith(1, chatId, expect.objectContaining({ id: 'sage' }), true)
    expect(target).toHaveBeenNthCalledWith(2, chatId, expect.objectContaining({ id: 'smith' }), false)
    await orchestrator.submitUserMessage(chatId, '@Sage thanks')
    expect(seen.at(-1)?.contextBlock).toBeUndefined()
    expect(target).toHaveBeenCalledTimes(2)
    await orchestrator.submitUserMessage(chatId, '@Sage inspect @browser')
    await orchestrator.submitUserMessage(chatId, '@Sage inspect @browser')
    expect(target).toHaveBeenNthCalledWith(3, chatId, expect.objectContaining({ id: 'sage' }), true)
    expect(target).toHaveBeenNthCalledWith(4, chatId, expect.objectContaining({ id: 'sage' }), true)
  })

  it('keeps the target on report-back attempts that contain no user message', async () => {
    const seen: TurnInput[] = []
    const target = vi.fn(async () => context)
    const { orchestrator, chatId } = await harness(scripted((_input, attempt) => attempt === 1
      ? [{ type: 'tool_use', toolCallId: 'snapshot-1', tool: 'browser_snapshot', detail: '' },
          { type: 'tool_result', toolCallId: 'snapshot-1', outcome: 'success' },
          { type: 'result', text: '', sessionId: 'session-browser' }]
      : [{ type: 'message', messageId: 'answer', text: 'Done.' }, { type: 'result', text: 'Done.', sessionId: 'session-browser' }], seen), {
      builtInMcp, browserTargetContext: target,
    })
    await orchestrator.submitUserMessage(chatId, '@Sage inspect @browser')
    expect(seen).toHaveLength(2)
    expect(seen[1]?.catchUp.every((event) => event.type !== 'user_message')).toBe(true)
    expect(seen[1]?.contextBlock).toContain(context)
    expect(target).toHaveBeenNthCalledWith(1, chatId, expect.anything(), true)
    expect(target).toHaveBeenNthCalledWith(2, chatId, expect.anything(), false)
  })

  it('preserves targeting through DM steering and checks availability again', async () => {
    const gate = gated()
    const target = vi.fn(async () => context)
    const { orchestrator, store } = await harness(gate.driver, { builtInMcp, browserTargetContext: target })
    const dm = await store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })
    const first = orchestrator.submitUserMessage(dm.id, 'Inspect @browser')
    await until(() => gate.forChat(dm.id).length === 1, 'the browser attempt')
    const steering = orchestrator.submitUserMessage(dm.id, 'Scroll down')
    await until(() => gate.forChat(dm.id).length === 2, 'the steered browser attempt')
    expect(gate.forChat(dm.id)[1]?.input.contextBlock).toContain(context)
    expect(target).toHaveBeenNthCalledWith(1, dm.id, expect.anything(), true)
    expect(target).toHaveBeenNthCalledWith(2, dm.id, expect.anything(), false)
    const explicitSteering = orchestrator.submitUserMessage(dm.id, 'Now inspect @browser again')
    await until(() => gate.forChat(dm.id).length === 3, 'a fresh explicit browser attempt')
    expect(target).toHaveBeenNthCalledWith(3, dm.id, expect.anything(), true)
    target.mockRejectedValueOnce(new Error('@browser is unavailable: desktop disconnected'))
    const nextSteering = orchestrator.submitUserMessage(dm.id, 'Scroll further')
    await Promise.all([first, steering, explicitSteering, nextSteering])
    expect(target).toHaveBeenNthCalledWith(4, dm.id, expect.anything(), false)
    expect(gate.forChat(dm.id)).toHaveLength(3)
    expect(await store.loadEvents(dm.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'system_note', kind: 'error', text: expect.stringContaining('@browser is unavailable') }),
    ]))
  })

  it('reports an unavailable desktop without starting any provider or alternative browser', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, chatId, store } = await harness(scripted(() => [], seen), {
      builtInMcp,
      browserTargetContext: (id, agent) => browserTargetContext(new BrowserBroker(), id, agent),
    })
    await orchestrator.submitUserMessage(chatId, '@Sage inspect @browser')
    expect(seen).toEqual([])
    expect(await store.loadEvents(chatId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'system_note', kind: 'error', text: expect.stringContaining('@browser is unavailable') }),
    ]))
  })

  it('refuses explicit targeting if this room has no browser attachment', async () => {
    const seen: TurnInput[] = []
    const target = vi.fn(async () => context)
    const { orchestrator, chatId, store } = await harness(scripted(() => [], seen), { browserTargetContext: target })
    await orchestrator.submitUserMessage(chatId, '@Sage inspect @browser')
    expect(target).not.toHaveBeenCalled()
    expect(seen).toEqual([])
    expect(await store.loadEvents(chatId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'system_note', kind: 'error', text: expect.stringContaining('unavailable in this chat') }),
    ]))
  })
})

describe('Single review prompt composition', () => {
  const models = [{ model: 'gpt-6.1-sol', label: 'Sol', provider: 'codex', efforts: ['high'] }]
  const interaction: NonNullable<HarnessOptions['interactionMcp']> = (_chat, _agent, _turn, allowAsk, permissions) =>
    interactionMcpAttachment('http://127.0.0.1:8787/internal/user-input', 'test-capability', {
      allowAsk,
      ...(permissions?.allowSubagents ? { subagents: { models, maxConcurrent: 3 } } : {}),
    })

  it.each([
    { driver: 'claude', model: 'claude-opus-5', effort: 'high' },
    { driver: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
    { driver: 'grok', model: 'grok-4.6', effort: 'high' },
  ] as const)('gives manual Single and accepted Single Work on $driver the same significant-change review rule', async (runtime) => {
    const seen: TurnInput[] = []
    const { orchestrator, store, projectId } = await harness(recording(createMockDriver({ deltaDelayMs: 0 }), seen), {
      interactionMcp: interaction,
    })
    const manual = await store.createChat({ projectId, mode: 'single' })
    await store.setChatOverride(manual.id, '__single__', { ...runtime, auto: false })
    await orchestrator.submitUserMessage(manual.id, 'Inspect the change.')

    const source = await store.createChat({ kind: 'dm', memberIds: ['sage'] })
    const { handoff } = await store.reserveWorkHandoff({
      sourceChatId: source.id, sourceTurnId: 'proposal', projectId, projectName: 'Manor',
      title: 'Review the change', task: 'Inspect the change.', authorAgentId: 'sage',
      leadAgentId: 'smith', leadAgentName: 'Smith', supportingAgentIds: [], supportingAgentNames: [],
    })
    const work = await store.materializeWorkHandoff(handoff.id, runtime)
    if (work.workChatId === null) throw new Error('Missing Single Work')
    await store.acceptWorkHandoff(work.workChatId)
    await orchestrator.submitUserMessage(work.workChatId, 'Inspect the change.')

    expect(seen).toHaveLength(2)
    for (const input of seen) {
      expect(input.singleSession).toBe(true)
      expect(input.agent.character).toContain(SINGLE_SUBAGENT_RULE)
      expect(input.agent.character).not.toContain('Manor refuses goal_reached until a review subagent')
      expect(input.agent.character).not.toContain('do a handful of tool calls yourself')
      expect(input.mcpServers?.find(({ server }) => server.id === 'builtin_manor')?.server.tools)
        .toContain('delegate_task')
    }
  })

  it('leaves Multiple guidance unchanged and withholds the Single rule from Cursor and empty Settings', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, store, chatId, projectId } = await harness(recording(createMockDriver({ deltaDelayMs: 0 }), seen), {
      interactionMcp: interaction,
    })
    await orchestrator.submitUserMessage(chatId, '@Sage inspect the change.')
    expect(seen[0]?.agent.character).toContain(SUBAGENT_RULE)
    expect(seen[0]?.agent.character).not.toContain('Review always in Single Sessions')

    const cursor = await store.createChat({ projectId, mode: 'single' })
    await store.setChatOverride(cursor.id, '__single__', {
      driver: 'cursor', model: 'cursor-composer-2.5', effort: 'high', auto: false,
    })
    await orchestrator.submitUserMessage(cursor.id, 'Inspect the change.')
    expect(seen[1]?.agent.character).not.toContain(SINGLE_SUBAGENT_RULE)
    expect(seen[1]?.mcpServers?.find(({ server }) => server.id === 'builtin_manor')?.server.tools)
      .not.toContain('delegate_task')

    const bare: TurnInput[] = []
    const empty = await harness(recording(createMockDriver({ deltaDelayMs: 0 }), bare), {
      interactionMcp: (_chat, _agent, _turn, allowAsk) =>
        interactionMcpAttachment('http://127.0.0.1:8787/internal/user-input', 'test-capability', {
          allowAsk, subagents: { models: [], maxConcurrent: 3 },
        }),
    })
    const single = await empty.store.createChat({ projectId: empty.projectId, mode: 'single' })
    await empty.orchestrator.submitUserMessage(single.id, 'Inspect the change.')
    expect(bare[0]?.agent.character).not.toContain(SINGLE_SUBAGENT_RULE)
    expect(bare[0]?.mcpServers?.find(({ server }) => server.id === 'builtin_manor')?.server.tools)
      .toContain('task_result')
  })
})

describe('Orchestrator, Single goal Sessions', () => {
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
  const models = [{ model: 'gpt-6.1-sol', label: 'Sol', provider: 'codex', efforts: ['high'] }]
  const reached = (text: string): RuntimeEvent[] => [
    { type: 'tool_use', toolCallId: 'goal', tool: 'mcp__manor__goal_reached' },
    { type: 'tool_result', toolCallId: 'goal', outcome: 'success' },
    { type: 'result', text, sessionId: 's' },
  ]
  const granted = (input: TurnInput, tool: string) =>
    input.mcpServers?.find(({ server }) => server.id === 'builtin_manor')?.server.tools.includes(tool) === true

  /** An accepted Single Session from a DM brief, the way Accept leaves it. */
  async function acceptedSingle(store: Store, projectId: string): Promise<{ chatId: string; sourceChatId: string }> {
    const source = await store.createChat({ kind: 'dm', memberIds: ['sage'] })
    const { handoff } = await store.reserveWorkHandoff({
      sourceChatId: source.id, sourceTurnId: 'proposal', projectId, projectName: 'Manor',
      title: 'Fix the bug', task: 'Fix the bug. Done when the regression test passes.', authorAgentId: 'sage',
      leadAgentId: 'smith', leadAgentName: 'Smith', supportingAgentIds: [], supportingAgentNames: [],
    })
    const work = await store.materializeWorkHandoff(handoff.id, { driver: 'claude', model: 'claude-opus-5', effort: 'high' })
    if (work.workChatId === null) throw new Error('Missing Single Work')
    await store.acceptWorkHandoff(work.workChatId)
    return { chatId: work.workChatId, sourceChatId: source.id }
  }

  async function singleHarness(script: (input: TurnInput) => RuntimeEvent[] | Promise<RuntimeEvent[]>) {
    const seen: TurnInput[] = []
    let turn: { chatId: string; agentId: string; turnId: string } | undefined
    const built = await harness(scripted((input) => script(input), seen), {
      interactionMcp: (chatId, agent, turnId, allowAsk, permissions) => {
        turn = { chatId, agentId: agent.id, turnId }
        return interactionMcpAttachment('http://127.0.0.1:8787/internal/user-input', 'capability', {
          allowAsk, allowGoal: permissions?.allowGoal === true,
          ...(permissions?.allowSubagents ? { subagents: { models, maxConcurrent: 3 } } : {}),
        })
      },
    })
    return { ...built, seen, turn: () => turn! }
  }

  /** A successful test run in the live turn, as a CLI's shell call lands before its next tool call. */
  const checkRan = async (store: Store, turn: { chatId: string; agentId: string; turnId: string }) => {
    await store.appendEvent(turn.chatId, { type: 'tool_use', agentId: turn.agentId, turnId: turn.turnId, toolCallId: 'check', tool: 'Shell', command: 'pnpm test' })
    await store.appendEvent(turn.chatId, { type: 'tool_result', agentId: turn.agentId, turnId: turn.turnId, toolCallId: 'check', outcome: 'success' })
  }
  const codeChange = (store: Store, chatId: string) => store.appendEvent(chatId, {
    type: 'turn_result', agentId: SINGLE_CHAT_VOICE.id, turnId: 'turn_edit',
    fileChanges: [{ path: '/repo/src/a.ts', status: 'edited', added: 1, removed: 0, edits: [] }],
  })
  it('holds goal_reached and publishes the result card in the briefing chat, screenshots included', async () => {
    const recorded: ReturnType<Orchestrator['recordGoalClaims']>[] = []
    const h = await singleHarness((input) => {
      if (!granted(input, 'goal_reached')) return [{ type: 'result', text: 'No goal here.', sessionId: 's' }]
      recorded.push(h.orchestrator.recordGoalClaims(h.turn(), [{ claim: 'It works.', level: 'stated' }],
        { result: 'The bug is fixed.' }, [{ name: 'after.png', bytes: PNG, width: 1, height: 1, takenAt: Date.now() }]))
      return reached('Done.')
    })
    const { chatId, sourceChatId } = await acceptedSingle(h.store, h.projectId)

    await h.orchestrator.submitUserMessage(chatId, 'Fix the bug.')

    expect(await Promise.all(recorded)).toEqual([{ note: expect.stringContaining('result card') }])
    expect(h.seen[0]?.agent.id).toBe(SINGLE_CHAT_VOICE.id)
    expect(h.seen[0]?.agent.character).toContain('[Manor] Goal of this Session:')
    expect(h.seen[0]?.agent.character).toContain(SESSION_PLAN_RULE)
    expect(h.seen[0]?.agent.character).toContain('review set to true')
    const handoff = (await h.store.workHandoffForTarget(chatId))!
    expect(handoff.goalReachedAt).toEqual(expect.any(Number))
    expect(handoff.goalReport).toMatchObject({ result: 'The bug is fixed.', evidence: [{ name: 'after.png', width: 1, height: 1 }] })
    const evidence = handoff.goalReport!.evidence![0]!
    expect(Buffer.from((await h.store.loadDocument(chatId, evidence.id))!)).toEqual(PNG)
    expect((await h.store.loadEvents(sourceChatId)).at(-1)).toMatchObject({ type: 'system_note', text: 'The bug is fixed.', workHandoffId: handoff.id })
    // No chain: no nudge and no lead return after the one turn.
    expect(h.seen).toHaveLength(1)
  })

  it('allows a small code diff to report Done without a review, in the call and at turn end', async () => {
    const recorded: ReturnType<Orchestrator['recordGoalClaims']>[] = []
    const h = await singleHarness(async () => {
      const call = h.orchestrator.recordGoalClaims(h.turn(), [{ claim: 'Fixed.', level: 'stated' }], { result: 'Fixed.' })
      recorded.push(call)
      await call
      return reached('Done.')
    })
    const { chatId } = await acceptedSingle(h.store, h.projectId)
    await codeChange(h.store, chatId)

    await h.orchestrator.submitUserMessage(chatId, 'Fix the bug.')

    expect(await Promise.all(recorded)).toEqual([{ note: expect.stringContaining('Recorded.') }])
    expect((await h.store.workHandoffForTarget(chatId))?.goalReachedAt).toEqual(expect.any(Number))
    expect((await h.store.loadEvents(chatId)).some((event) => event.type === 'tool_use' && event.subagent?.review === true)).toBe(false)
  })

  it('refuses Done on a real code change until a check ran after it, then records it', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'manor-unproven-'))
    const file = path.join(root, 'a.ts')
    await writeFile(file, 'export const a = 1\n')
    await utimes(file, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
    const answers: Awaited<ReturnType<Orchestrator['recordGoalClaims']>>[] = []
    const h = await singleHarness(async () => {
      const claim = () => h.orchestrator.recordGoalClaims(h.turn(), [{ claim: 'Fixed.', level: 'stated' }], { result: 'Fixed.' })
      answers.push(await claim())
      await checkRan(h.store, h.turn())
      answers.push(await claim())
      return reached('Done.')
    })
    const { chatId } = await acceptedSingle(h.store, h.projectId)
    await h.store.appendEvent(chatId, {
      type: 'turn_result', agentId: SINGLE_CHAT_VOICE.id, turnId: 'turn_edit',
      fileChanges: [{ path: file, status: 'edited', added: 1, removed: 0, edits: [] }],
    })

    await h.orchestrator.submitUserMessage(chatId, 'Fix the bug.')

    expect(answers).toEqual([
      { error: expect.stringContaining('a.ts changed after the last successful test') },
      { note: expect.stringContaining('Recorded.') },
    ])
    expect((await h.store.workHandoffForTarget(chatId))?.goalReachedAt).toEqual(expect.any(Number))
  })

  it('counts a turn whose checkout Manor could not measure as changed code', async () => {
    const answers: Awaited<ReturnType<Orchestrator['recordGoalClaims']>>[] = []
    const h = await singleHarness(async () => {
      const claim = () => h.orchestrator.recordGoalClaims(h.turn(), [{ claim: 'Fixed.', level: 'stated' }], { result: 'Fixed.' })
      answers.push(await claim())
      await checkRan(h.store, h.turn())
      answers.push(await claim())
      return reached('Done.')
    })
    const { chatId } = await acceptedSingle(h.store, h.projectId)
    await h.store.appendEvent(chatId, { type: 'tool_use', agentId: SINGLE_CHAT_VOICE.id, turnId: 'turn_lost', toolCallId: 'edit', tool: 'Edit' })
    await h.store.appendEvent(chatId, { type: 'turn_result', agentId: SINGLE_CHAT_VOICE.id, turnId: 'turn_lost', fileChangesFailed: true })

    await h.orchestrator.submitUserMessage(chatId, 'Fix the bug.')

    expect(answers).toEqual([
      { error: expect.stringContaining('files Manor could not measure changed after the last successful test') },
      { note: expect.stringContaining('Recorded.') },
    ])
  })

  it('counts a check that a subagent ran in its own chat', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'manor-child-check-'))
    const file = path.join(root, 'a.ts')
    await writeFile(file, 'export const a = 1\n')
    await utimes(file, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
    const answers: Awaited<ReturnType<Orchestrator['recordGoalClaims']>>[] = []
    const h = await singleHarness(async () => {
      const turn = h.turn()
      const child = await h.store.createChat({ projectId: h.projectId, mode: 'single' })
      await h.store.appendEvent(turn.chatId, {
        type: 'tool_use', agentId: turn.agentId, turnId: turn.turnId, toolCallId: 'child', tool: 'mcp__manor__delegate_task', subagent: { childChatId: child.id },
      })
      await checkRan(h.store, { ...turn, chatId: child.id })
      answers.push(await h.orchestrator.recordGoalClaims(turn, [{ claim: 'Fixed.', level: 'stated' }], { result: 'Fixed.' }))
      return reached('Done.')
    })
    const { chatId } = await acceptedSingle(h.store, h.projectId)
    await h.store.appendEvent(chatId, {
      type: 'turn_result', agentId: SINGLE_CHAT_VOICE.id, turnId: 'turn_edit',
      fileChanges: [{ path: file, status: 'edited', added: 1, removed: 0, edits: [] }],
    })

    await h.orchestrator.submitUserMessage(chatId, 'Fix the bug.')

    expect(answers).toEqual([{ note: expect.stringContaining('Recorded.') }])
  })

  it('does not reach the goal when code changed after goal_reached in the same turn', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'manor-late-edit-'))
    const file = path.join(root, 'a.ts')
    const h = await singleHarness(async () => {
      await checkRan(h.store, h.turn())
      expect(await h.orchestrator.recordGoalClaims(h.turn(), [{ claim: 'Fixed.', level: 'stated' }], { result: 'Fixed.' }))
        .toEqual({ note: expect.stringContaining('Recorded.') })
      // One more edit after the call, which Manor's measurement records before the turn ends.
      await new Promise((resolve) => setTimeout(resolve, 5))
      await writeFile(file, 'export const a = 2\n')
      await h.store.appendEvent(h.turn().chatId, {
        type: 'turn_result', agentId: SINGLE_CHAT_VOICE.id, turnId: 'turn_late',
        fileChanges: [{ path: file, status: 'edited', added: 1, removed: 1, edits: [] }],
      })
      return reached('Done.')
    })
    const { chatId } = await acceptedSingle(h.store, h.projectId)

    await h.orchestrator.submitUserMessage(chatId, 'Fix the bug.')

    expect((await h.store.workHandoffForTarget(chatId))?.goalReachedAt).toBeUndefined()
    expect((await h.store.loadEvents(chatId)).some((event) =>
      event.type === 'system_note' && event.text.includes('a.ts changed after the last successful test'))).toBe(true)
  })

  it('reopens a Single result without naming a persona when code changes after it', async () => {
    const h = await singleHarness((input) => {
      if (granted(input, 'goal_reached')) {
        void h.orchestrator.recordGoalClaims(h.turn(), [{ claim: 'Fixed.', level: 'stated' }], { result: 'Fixed.' })
        return reached('Done.')
      }
      return [{ type: 'result', text: 'Looked again.', sessionId: 's' }]
    })
    const { chatId, sourceChatId } = await acceptedSingle(h.store, h.projectId)
    await h.orchestrator.submitUserMessage(chatId, 'Fix the bug.')
    expect((await h.store.workHandoffForTarget(chatId))?.goalReachedAt).toEqual(expect.any(Number))

    await codeChange(h.store, chatId)
    await h.orchestrator.submitUserMessage(chatId, 'Also the empty case.')

    const notes = (await h.store.loadEvents(chatId)).flatMap((event) => event.type === 'system_note' ? [event.text] : [])
    expect(notes).toContain('Changed after it was ready. A new version is being prepared.')
    expect(notes.join('\n')).not.toContain('Smith')
    expect((await h.store.loadEvents(sourceChatId)).at(-1)).toMatchObject({ workHandoffPhase: 'reopened', workChangedAfterReady: true })
  })

  it('does not gate a Single runtime that cannot start a review child', async () => {
    const h = await singleHarness(() => reached('Done.'))
    const { chatId } = await acceptedSingle(h.store, h.projectId)
    await h.store.setChatOverride(chatId, SINGLE_CHAT_VOICE.id, { driver: 'cursor', model: 'cursor-composer-2.5', effort: 'high', auto: false })
    await codeChange(h.store, chatId)

    await h.orchestrator.submitUserMessage(chatId, 'Fix the bug.')

    expect(h.seen[0]?.agent.character).toContain('[Manor] Goal of this Session:')
    expect(h.seen[0]?.agent.character).not.toContain('review set to true')
    expect((await h.store.workHandoffForTarget(chatId))?.goalReachedAt).toEqual(expect.any(Number))
  })

  it('confirms a Single result through the same commit path, addressed to its one voice, and takes Request changes', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'manor-single-confirm-'))
    try {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).trim()
      git('init', '-q', '-b', 'main')
      git('config', 'user.name', 'Test')
      git('config', 'user.email', 'test@example.test')
      await writeFile(path.join(root, 'a.ts'), 'before\n')
      git('add', '.')
      git('commit', '-qm', 'Initial')
      const lines: string[] = []
      const h = await singleHarness(async (input) => {
        const last = [...input.catchUp].reverse().find((event) => event.type === 'user_message')
        const text = last?.type === 'user_message' ? modelTextOf(last) : ''
        lines.push(text)
        if (text.startsWith('[Manor] The user confirmed')) {
          git('commit', '-qam', 'Single result')
          return [{ type: 'result', text: 'Committed.', sessionId: 's' }]
        }
        if (text === 'Report it.' || text === 'Name the file.') {
          await checkRan(h.store, h.turn())
          await h.orchestrator.recordGoalClaims(h.turn(), [{ claim: 'Fixed.', level: 'ran', ref: 'pnpm test' }], { result: 'Fixed.' })
          return reached('Done.')
        }
        execFileSync('sh', ['-c', 'printf after > a.ts'], { cwd: root })
        return [
          { type: 'tool_use', toolCallId: 'edit', tool: 'Edit', edits: [{ path: path.join(root, 'a.ts'), before: 'before\n', after: 'after' }] },
          { type: 'tool_result', toolCallId: 'edit', outcome: 'success' },
          { type: 'result', text: 'Edited.', sessionId: 's' },
        ]
      })
      await h.store.updateProject(h.projectId, 'Manor', [root])
      const { chatId } = await acceptedSingle(h.store, h.projectId)
      await h.orchestrator.submitUserMessage(chatId, 'Fix it.')
      await h.orchestrator.submitUserMessage(chatId, 'Report it.')
      const module = new WorkModule({
        store: h.store, agents: () => roster, orchestrator: h.orchestrator, broadcast: () => undefined, broadcastDirectory: async () => undefined,
      })

      // Request changes reaches the Single voice unaddressed, and the result comes back.
      const first = (await h.store.workHandoffForTarget(chatId))!
      await module.reviseGoal(first.id, first.version, 'Name the file.')
      await until(() => lines.includes('Name the file.'), 'the feedback to reach the Single voice')
      let ready = (await h.store.workHandoffForTarget(chatId))!
      for (let attempt = 0; ready.goalReachedAt === undefined && attempt < 200; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5))
        ready = (await h.store.workHandoffForTarget(chatId))!
      }
      expect(ready.goalReachedAt).toEqual(expect.any(Number))

      await module.confirmGoal(ready.id, undefined, ready.version)
      await until(() => lines.some((line) => line.startsWith('[Manor] The user confirmed')), 'the commit request')
      const request = (await h.store.loadEvents(chatId)).find((event) => event.type === 'user_message' && event.instruction?.startsWith('[Manor] The user confirmed'))
      expect(request).toMatchObject({ mentions: [], text: '' })
      expect(request?.type === 'user_message' && request.instruction).toContain("approval to commit. Commit this Session's changes now")
      expect((await h.store.loadEvents(chatId)).some((event) => event.type === 'system_note' && event.text.includes("isn't in this chat"))).toBe(false)
      let done = (await h.store.workHandoffForTarget(chatId))!
      for (let attempt = 0; done.goalCompletion?.status !== 'complete' && attempt < 400; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5))
        done = (await h.store.workHandoffForTarget(chatId))!
      }
      expect(done.goalCompletion).toMatchObject({ status: 'complete', operation: 'commit' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses a shared-checkout result and its Confirm once the checkout left the branch the Session started on', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'manor-single-branch-'))
    try {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).trim()
      git('init', '-q', '-b', 'main')
      git('config', 'user.name', 'Test')
      git('config', 'user.email', 'test@example.test')
      await writeFile(path.join(root, 'a.ts'), 'before\n')
      git('add', '.')
      git('commit', '-qm', 'Initial')
      let edited = false
      const h = await singleHarness(async (input) => {
        const last = [...input.catchUp].reverse().find((event) => event.type === 'user_message')
        if (last?.type === 'user_message' && last.text === 'Report it.') {
          await checkRan(h.store, h.turn())
          await h.orchestrator.recordGoalClaims(h.turn(), [{ claim: 'Fixed.', level: 'ran', ref: 'pnpm test' }], { result: 'Fixed.' })
          return reached('Done.')
        }
        if (last?.type === 'user_message' && modelTextOf(last).startsWith('[Manor] The user confirmed')) {
          // The switch lands inside the commit turn, and the commit follows it.
          git('checkout', '-q', 'feature')
          git('commit', '-qam', 'Single result')
          return [{ type: 'result', text: 'Committed.', sessionId: 's' }]
        }
        if (edited) return [{ type: 'result', text: 'Still on it.', sessionId: 's' }]
        edited = true
        // Something else switches the shared checkout while the turn runs.
        git('checkout', '-qb', 'feature')
        execFileSync('sh', ['-c', 'printf after > a.ts'], { cwd: root })
        return [
          { type: 'tool_use', toolCallId: 'edit', tool: 'Edit', edits: [{ path: path.join(root, 'a.ts'), before: 'before\n', after: 'after' }] },
          { type: 'tool_result', toolCallId: 'edit', outcome: 'success' },
          { type: 'result', text: 'Edited.', sessionId: 's' },
        ]
      })
      await h.store.updateProject(h.projectId, 'Manor', [root])
      const module = new WorkModule({
        store: h.store, agents: () => roster, orchestrator: h.orchestrator, broadcast: () => undefined, broadcastDirectory: async () => undefined,
      })
      const source = await h.store.createChat({ kind: 'dm', memberIds: ['sage'] })
      const { handoff } = await h.store.reserveWorkHandoff({
        sourceChatId: source.id, sourceTurnId: 'proposal', projectId: h.projectId, projectName: 'Manor',
        title: 'Fix the bug', task: 'Fix the bug. Done when the regression test passes.', authorAgentId: 'sage',
        leadAgentId: 'smith', leadAgentName: 'Smith', supportingAgentIds: [], supportingAgentNames: [],
      })
      const chatId = await module.accept(handoff.id, { mode: 'single', runtime: { driver: 'claude', model: 'claude-opus-5', effort: 'high' } })
      expect((await h.store.workHandoffForTarget(chatId))?.startBranches).toEqual([{ path: await realpath(root), branch: 'main' }])
      await vi.waitFor(() => expect(edited && h.orchestrator.activeTurn(chatId) === undefined).toBe(true), { timeout: 5_000 })

      await h.orchestrator.submitUserMessage(chatId, 'Report it.')
      expect((await h.store.workHandoffForTarget(chatId))?.goalReachedAt).toBeUndefined()
      const refusal = [...await h.store.loadEvents(chatId)].reverse().find((event) => event.type === 'system_note')
      expect(refusal).toMatchObject({ kind: 'error', text: expect.stringContaining('started on main, but Manor found') })
      expect(refusal?.type === 'system_note' && refusal.text).toContain('on feature')

      // Back on main the result publishes; a switch before Confirm refuses the commit itself.
      git('checkout', '-q', 'main')
      await h.orchestrator.submitUserMessage(chatId, 'Report it.')
      const ready = (await h.store.workHandoffForTarget(chatId))!
      expect(ready.goalReachedAt).toEqual(expect.any(Number))
      git('checkout', '-q', 'feature')
      await expect(module.confirmGoal(ready.id, undefined, ready.version)).rejects.toThrow(/started on main, but Manor found .* on feature/)
      expect((await h.store.workHandoffForTarget(chatId))?.goalConfirmedAt).toBeUndefined()
      expect(git('rev-list', '--count', 'feature')).toBe('1')
      // Committed there too, the approved files leave the measurement; Confirm still names both branches.
      git('commit', '-qam', 'Elsewhere')
      await expect(module.confirmGoal(ready.id, undefined, ready.version)).rejects.toThrow(/started on main, but Manor found .* on feature/)
      git('reset', '-q', '--soft', 'HEAD~1')

      // Confirmed on main, the commit request names main; a commit that went elsewhere blocks with both branches.
      git('checkout', '-q', 'main')
      await module.confirmGoal(ready.id, undefined, ready.version)
      const request = (await h.store.loadEvents(chatId)).find((event) => event.type === 'user_message' && modelTextOf(event).startsWith('[Manor] The user confirmed'))
      expect(request?.type === 'user_message' && modelTextOf(request)).toContain(`only on main: check the current branch first`)
      await vi.waitFor(async () => expect((await h.store.workHandoffForTarget(chatId))?.goalCompletion).toMatchObject({
        status: 'blocked', message: `${path.basename(root)} is on feature, not main.`,
      }), { timeout: 5_000 })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('counts only what still differs at the result: emitted output removed again, or ignored, is not part of it', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'manor-single-net-'))
    const tree = mkdtempSync(path.join(os.tmpdir(), 'manor-single-net-tree-'))
    try {
      const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).trim()
      git(root, 'init', '-q', '-b', 'main')
      git(root, 'config', 'user.name', 'Test')
      git(root, 'config', 'user.email', 'test@example.test')
      await writeFile(path.join(root, 'app.ts'), 'before\n')
      await writeFile(path.join(root, '.gitignore'), 'dist/\n')
      git(root, 'add', '.')
      git(root, 'commit', '-qm', 'Initial')
      const worktree = path.join(tree, 'Manor')
      git(root, 'worktree', 'add', '-q', '-b', 'manor/net', worktree)
      const h = await singleHarness(async (input) => {
        const last = [...input.catchUp].reverse().find((event) => event.type === 'user_message')
        if (last?.type === 'user_message' && last.text === 'Report it.') {
          const turn = h.turn()
          await h.store.appendEvent(turn.chatId, { type: 'tool_use', agentId: turn.agentId, turnId: turn.turnId, toolCallId: 'rm', tool: 'Shell', command: `rm ${path.join(worktree, 'app.js')}` })
          await rm(path.join(worktree, 'app.js'), { force: true })
          await checkRan(h.store, turn)
          await h.orchestrator.recordGoalClaims(h.turn(), [{ claim: 'Fixed.', level: 'ran', ref: 'pnpm test' }], { result: 'Fixed.' })
          return reached('Done.')
        }
        // A typecheck without noEmit: compiled output beside the source, and a build into an ignored folder.
        await writeFile(path.join(worktree, 'app.ts'), 'after\n')
        await writeFile(path.join(worktree, 'app.js'), 'emitted\n')
        await mkdir(path.join(worktree, 'dist'), { recursive: true })
        await writeFile(path.join(worktree, 'dist', 'out.js'), 'built\n')
        return [{ type: 'result', text: 'Edited.', sessionId: 's' }]
      })
      await h.store.updateProject(h.projectId, 'Manor', [root])
      const { chatId } = await acceptedSingle(h.store, h.projectId)
      await h.store.replaceChatWorktrees(chatId, [{ sourcePath: root, worktreePath: worktree, branch: 'manor/net', createdAt: 1 }])

      await h.orchestrator.submitUserMessage(chatId, 'Fix it.')
      const first = (await h.store.loadEvents(chatId)).find((event) => event.type === 'turn_result')
      expect(first?.type === 'turn_result' && first.fileChanges?.map((change) => [path.basename(change.path), change.status]).sort())
        .toEqual([['app.js', 'created'], ['app.ts', 'edited']])

      await h.orchestrator.submitUserMessage(chatId, 'Report it.')
      const ready = (await h.store.workHandoffForTarget(chatId))!
      expect(ready.goalReachedAt).toEqual(expect.any(Number))
      expect(ready.goalChangedFiles).toEqual([path.join(worktree, 'app.ts')])
      expect(ready.goalCompletion?.repos.flatMap((repo) => repo.files)).toEqual(['app.ts'])
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(tree, { recursive: true, force: true })
    }
  })

  it('leaves a Single Session opened without a handoff ungoaled, with the plan rule all the same', async () => {
    const h = await singleHarness(() => [{ type: 'result', text: 'Answered.', sessionId: 's' }])
    const chat = await h.store.createChat({ projectId: h.projectId, mode: 'single' })
    await h.orchestrator.submitUserMessage(chat.id, 'Fix the bug.')
    expect(granted(h.seen[0]!, 'goal_reached')).toBe(false)
    expect(h.seen[0]?.agent.character).not.toContain('[Manor] Goal of this Session:')
    // Its tasks card is read the same way, so the agent is asked to tick it the same way.
    expect(h.seen[0]?.agent.character).toContain(SESSION_PLAN_RULE)
    // An insight mid-work revises the card through the same tool, never a second plan.
    expect(SESSION_PLAN_RULE).toContain('call the tool again with the full revised list')
    expect(SESSION_PLAN_RULE).toContain('keep completed steps completed')
    expect(SESSION_PLAN_RULE).toContain('keep exactly one step in progress')
  })

  it('bounds a Single edit continuation when the second turn also omits its result', async () => {
    const h = await singleHarness(() => {
      const turn = h.turn()
      void h.store.appendEvent(turn.chatId, { type: 'turn_result', agentId: turn.agentId, turnId: turn.turnId,
        fileChanges: [{ path: '/repo/a.ts', status: 'edited', added: 1, removed: 0, edits: [] }] })
      return [{ type: 'result', text: 'Edited, still no result.', sessionId: 's' }]
    })
    const { chatId } = await acceptedSingle(h.store, h.projectId)
    await h.orchestrator.submitUserMessage(chatId, 'Fix it.')
    expect(h.seen).toHaveLength(2)
    expect(h.seen[1]?.catchUp.at(-1)).toMatchObject({ type: 'system_note', text: GOAL_CONTINUE_NUDGE })
    expect((await h.store.workHandoffForTarget(chatId))?.goalReachedAt).toBeUndefined()
    expect((await h.store.loadEvents(chatId)).some((event) => event.type === 'system_note' && event.trace === true &&
      event.text.includes('stopped before finishing'))).toBe(true)
  })

  it('does not start a Single edit continuation from a background wake', async () => {
    const h = await singleHarness(() => {
      const turn = h.turn()
      void h.store.appendEvent(turn.chatId, { type: 'turn_result', agentId: turn.agentId, turnId: turn.turnId,
        fileChanges: [{ path: '/repo/a.ts', status: 'edited', added: 1, removed: 0, edits: [] }] })
      return [{ type: 'result', text: 'Background work finished.', sessionId: 's' }]
    })
    const { chatId } = await acceptedSingle(h.store, h.projectId)
    await h.orchestrator.submitUserMessage(chatId, 'Background work ended.', [], { source: 'background_wake', agentId: SINGLE_CHAT_VOICE.id })
    expect(h.seen).toHaveLength(1)
    expect((await h.store.workHandoffForTarget(chatId))?.goalReachedAt).toBeUndefined()
  })

  it('gives confirmed Single follow-ups a new goal and recovers an edit ending without a result card', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'manor-reopened-single-'))
    try {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).trim()
      git('init', '-q', '-b', 'main')
      git('config', 'user.name', 'Test')
      git('config', 'user.email', 'test@example.test')
      await writeFile(path.join(root, 'a.ts'), 'before\n')
      git('add', '.')
      git('commit', '-qm', 'Initial')
      let edits = 0
      const lateClaims: Promise<{ note: string } | { error: string }>[] = []
      const h = await singleHarness(async (input) => {
        const last = [...input.catchUp].reverse().find((event) => event.type === 'user_message')
        const text = last?.type === 'user_message' ? modelTextOf(last) : ''
        if (text.startsWith('[Manor] The user confirmed')) {
          // The goal is reached, yet the tool and its rule stay, so the prompt prefix
          // holds; the broker refuses the call instead.
          expect(granted(input, 'goal_reached')).toBe(true)
          expect(input.agent.character).toContain('[Manor] Goal of this Session:')
          lateClaims.push(h.orchestrator.recordGoalClaims(h.turn(), [{ claim: 'Committed.', level: 'stated' }], { result: 'Committed.' }))
          git('commit', '-qam', 'Follow up')
          return [{ type: 'result', text: 'Committed.', sessionId: 's' }]
        }
        expect(granted(input, 'goal_reached')).toBe(true)
        if (text === 'Initial result.' || input.catchUp.some((event) => event.type === 'system_note' && event.text === GOAL_CONTINUE_NUDGE)) {
          // The edit is real, so goal_reached needs a check that ran after it.
          await checkRan(h.store, h.turn())
          await h.orchestrator.recordGoalClaims(h.turn(), [{ claim: 'Fixed.', level: 'ran', ref: 'pnpm test' }], { result: `Fixed round ${edits}.` })
          return reached('Done.')
        }
        edits += 1
        const next = `export const round = ${edits}\n`
        execFileSync('node', ['-e', 'require("fs").writeFileSync("a.ts", process.argv[1])', next], { cwd: root })
        return [
          { type: 'tool_use', toolCallId: 'edit', tool: 'Edit', edits: [{ path: path.join(root, 'a.ts'), after: next }] },
          { type: 'tool_result', toolCallId: 'edit', outcome: 'success' },
          { type: 'result', text: 'Edited, forgot the result card.', sessionId: 's' },
        ]
      })
      await h.store.updateProject(h.projectId, 'Manor', [root])
      const { chatId } = await acceptedSingle(h.store, h.projectId)
      const module = new WorkModule({ store: h.store, agents: () => roster, orchestrator: h.orchestrator,
        broadcast: () => undefined, broadcastDirectory: async () => undefined })
      await h.orchestrator.submitUserMessage(chatId, 'Initial result.')
      let current = (await h.store.workHandoffForTarget(chatId))!
      await module.confirmGoal(current.id, undefined, current.version)
      for (const forwarded of [true, false]) {
        const previous = (await h.store.workHandoffForTarget(chatId))!
        if (forwarded) await (await h.orchestrator.forwardUserMessage(chatId, {
          text: 'Follow up.', forwardedFrom: { threadChatId: previous.sourceChatId, eventId: 'source_message' },
        })).finished
        else await h.orchestrator.submitUserMessage(chatId, 'Another follow up.')
        current = (await h.store.workHandoffForTarget(chatId))!
        expect(current.goalConfirmedAt).toBeUndefined()
        expect(current.goalReport).toEqual({ result: `Fixed round ${edits}.` })
        expect(current.goalConfirmations?.at(-1)).toMatchObject({ confirmedAt: previous.goalConfirmedAt, completion: previous.goalCompletion })
        expect(git('status', '--porcelain')).not.toBe('')
        await module.confirmGoal(current.id, undefined, current.version)
        await until(() => git('status', '--porcelain') === '', 'the new commit to land')
        await module.reconcileCompletion(chatId)
        expect((await h.store.workHandoffForTarget(chatId))?.goalCompletion?.status).toBe('complete')
        expect(git('status', '--porcelain')).toBe('')
      }
      expect(edits).toBe(2)
      expect(h.seen.filter((input) => input.catchUp.some((event) => event.type === 'system_note' && event.text === GOAL_CONTINUE_NUDGE))).toHaveLength(2)
      expect(lateClaims.length).toBeGreaterThan(0)
      for (const claim of await Promise.all(lateClaims)) expect(claim).toEqual({ error: expect.stringContaining('already reached') })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 20_000)
})

describe('explicit computer targeting', () => {
  const computer = {
    id: 'mcp_computer', name: 'computer', command: CUA_DRIVER_PATH, args: ['mcp'], envKeys: ['HOME'],
    description: '', writes: true, effectPolicy: 'confirm_writes', tools: ['list_apps', 'click'],
    readOnlyTools: ['list_apps'], schemaChars: 0,
  } as McpServerConfig
  const connected = roster.map((agent) => ({
    ...agent, mcpServers: [{ serverId: computer.id, disabledTools: [] }],
  }))

  it('gives a Single session every available registered connector', async () => {
    const seen: TurnInput[] = []
    const server = (id: string, extra: Partial<McpServerConfig> = {}) => ({
      ...computer, id, name: id, command: 'npx', tools: ['read'], readOnlyTools: ['read'], ...extra,
    }) as McpServerConfig
    const { orchestrator, store, projectId } = await harness(scripted(() => [
      { type: 'result', text: 'Done.' },
    ], seen), {
      mcpServers: [
        computer, server('notion'), server('down', { unavailable: 'auth' }),
        server('computer', { id: 'fake_computer' }), server('codex-computer'),
      ],
    })
    const chat = await store.createChat({ projectId, mode: 'single' })
    await orchestrator.submitUserMessage(chat.id, 'Hello')
    expect(seen[0]?.mcpServers?.map((item) => item.server.id)).toEqual(expect.arrayContaining(['mcp_computer', 'notion']))
    expect(seen[0]?.mcpServers?.map((item) => item.server.id)).not.toContain('down')
    expect(seen[0]?.mcpServers?.map((item) => item.server.id)).not.toContain('fake_computer')
    // Codex's engine is persona-only until the user picks a default for Single.
    expect(seen[0]?.mcpServers?.map((item) => item.server.id)).not.toContain('codex-computer')
  })

  it('provides guarded Cua computer use throughout a Single Work chat without a persona', async () => {
    const seen: TurnInput[] = []
    const ready = vi.fn()
    const { orchestrator, store, projectId } = await harness(scripted(() => [
      { type: 'result', text: 'Done.' },
    ], seen), {
      mcpServers: [computer], computerTargetReady: ready,
      guardMcp: (attached) => attached.map((item) => ({ ...item, server: { ...item.server, command: '/guarded/proxy' } })),
    })
    const chat = await store.createChat({ projectId, mode: 'single' })
    await orchestrator.submitUserMessage(chat.id, 'Use @computer')
    expect(seen[0]?.agent.id).toBe(SINGLE_CHAT_VOICE.id)
    expect(seen[0]?.contextBlock).toContain('Explicit computer target: @computer')
    expect(seen[0]?.mcpServers?.some((item) => item.server.name === 'computer' && item.server.command === '/guarded/proxy')).toBe(true)
    expect(ready).toHaveBeenCalledTimes(1)

    await orchestrator.submitUserMessage(chat.id, 'Continue using the computer')
    expect(seen[1]?.contextBlock ?? '').not.toContain('Explicit computer target: @computer')
    expect(seen[1]?.mcpServers?.some((item) => item.server.name === 'computer' && item.server.command === '/guarded/proxy')).toBe(true)
    expect(ready).toHaveBeenCalledTimes(1)
  })

  it('refuses a Single Work computer target when Cua is not registered', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, store, projectId } = await harness(scripted(() => [], seen), {
      computerTargetReady: vi.fn(),
    })
    const chat = await store.createChat({ projectId, mode: 'single' })
    await orchestrator.submitUserMessage(chat.id, 'Use @computer')
    expect(seen).toEqual([])
    expect(await store.loadEvents(chat.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'system_note', kind: 'error', text: expect.stringContaining('Register the Cua computer connector') }),
    ]))
  })

  it('carries the Cua request to every addressed persona and clears it on the next message', async () => {
    const seen: TurnInput[] = []
    const ready = vi.fn()
    const { orchestrator, chatId } = await harness(scripted(() => [
      { type: 'message', messageId: 'answer', text: 'Done.' }, { type: 'result', text: 'Done.' },
    ], seen), {
      agents: connected, mcpServers: [computer], computerTargetReady: ready,
      guardMcp: (attached) => attached.map((item) => ({ ...item, server: { ...item.server, command: '/guarded/proxy' } })),
    })
    await orchestrator.submitUserMessage(chatId, '@Sage @Smith use @computer')
    expect(seen.map((input) => input.agent.id)).toEqual(['sage', 'smith'])
    for (const input of seen) {
      expect(input.contextBlock).toContain('Explicit computer target: @computer')
      expect(input.contextBlock).toContain('mcp__computer__*')
      expect(input.mcpServers?.some((item) => item.server.name === 'computer' && item.server.command === '/guarded/proxy')).toBe(true)
    }
    expect(ready).toHaveBeenCalledTimes(2)
    await orchestrator.submitUserMessage(chatId, '@Sage thanks')
    expect(seen.at(-1)?.contextBlock).toBeUndefined()
    expect(ready).toHaveBeenCalledTimes(2)
  })

  it('does not pass the computer target to a summoned reviewer or a side chat', async () => {
    const seen: TurnInput[] = []
    const agents = [
      { ...sage, mentionAllowlist: ['smith'], mcpServers: [{ serverId: computer.id, disabledTools: [] }] },
      smith,
    ]
    const { orchestrator, chatId, store } = await harness(scripted((input) => [
      { type: 'result', text: input.agent.id === 'sage' ? '@Smith review this' : 'Reviewed.' },
    ], seen), { agents, mcpServers: [computer], computerTargetReady: vi.fn() })
    await orchestrator.submitUserMessage(chatId, '@Sage use @computer')
    expect(seen.map((input) => input.agent.id)).toEqual(['sage', 'smith'])
    expect(seen[0]?.contextBlock).toContain('Explicit computer target: @computer')
    expect(seen[1]?.contextBlock).toBeUndefined()

    const side = await store.sideChatFor(chatId)
    await orchestrator.submitUserMessage(side.id, 'What does @computer mean?')
    expect(seen).toHaveLength(3)
    expect(seen.at(-1)?.contextBlock ?? '').not.toContain('Explicit computer target: @computer')
    expect((await store.loadEvents(side.id)).some((event) =>
      event.type === 'system_note' && event.kind === 'error' && event.text.includes('@computer is unavailable'))).toBe(false)
  })

  it('refuses a detached connector or missing desktop before starting a provider', async () => {
    for (const options of [
      { agents: roster, mcpServers: [computer], computerTargetReady: vi.fn() },
      { agents: connected, mcpServers: [computer], computerTargetReady: vi.fn(() => { throw new Error('Desktop closed.') }) },
    ]) {
      const seen: TurnInput[] = []
      const { orchestrator, chatId, store } = await harness(scripted(() => [], seen), options)
      await orchestrator.submitUserMessage(chatId, '@Sage use @computer')
      expect(seen).toEqual([])
      expect(await store.loadEvents(chatId)).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'system_note', kind: 'error', text: expect.stringContaining('@computer is unavailable') }),
      ]))
    }
  })

  it('waits for the desktop before resuming a saved computer request', async () => {
    const seen: TurnInput[] = []
    const ready = vi.fn()
    const { orchestrator, chatId, store } = await harness(scripted(() => [
      { type: 'message', messageId: 'answer', text: 'Done.' }, { type: 'result', text: 'Done.' },
    ], seen), { agents: connected, mcpServers: [computer], computerTargetReady: ready })
    const saved = await store.appendEvent(chatId, {
      type: 'user_message', text: '@Sage use @computer', mentions: ['sage'], dispatchState: 'pending',
    })
    let connect: () => void = () => {}
    const host = new Promise<void>((resolve) => { connect = resolve })
    await orchestrator.recoverWaitingMessages(host)
    expect(seen).toEqual([])
    expect(ready).not.toHaveBeenCalled()
    connect()
    await orchestrator.runExclusive(chatId, async () => {})
    expect(seen).toHaveLength(1)
    expect((await store.loadEvents(chatId)).find((row) => row.id === saved.id)).toMatchObject({ dispatchState: 'completed' })
  })

  it('resumes a saved side chat question about @computer without a desktop', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, chatId, store } = await harness(scripted(() => [
      { type: 'message', messageId: 'answer', text: 'It is a tool target.' },
      { type: 'result', text: 'It is a tool target.' },
    ], seen), { browserRecoveryWaitMs: 10 })
    const side = await store.sideChatFor(chatId)
    const saved = await store.appendEvent(side.id, {
      type: 'user_message', text: 'What does @computer mean?', mentions: [], dispatchState: 'pending',
    })
    await orchestrator.recoverWaitingMessages(new Promise<void>(() => {}))
    await orchestrator.runExclusive(side.id, async () => {})
    expect(seen).toHaveLength(1)
    expect(seen[0]?.contextBlock ?? '').not.toContain('Explicit computer target: @computer')
    expect((await store.loadEvents(side.id)).find((row) => row.id === saved.id)).toMatchObject({ dispatchState: 'completed' })
  })

  it('restarts a native DM turn when steering adds computer use', async () => {
    const gate = gated()
    const steer = vi.fn(async () => 'accepted' as const)
    const { orchestrator, store } = await harness({ startTurn(input) { return { ...gate.driver.startTurn(input), steer } } }, {
      agents: connected, mcpServers: [computer], computerTargetReady: vi.fn(),
    })
    const dm = await store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })
    const first = orchestrator.submitUserMessage(dm.id, 'Question')
    await until(() => gate.forChat(dm.id).length === 1, 'first native attempt')
    const addition = orchestrator.submitUserMessage(dm.id, 'Now use @computer')
    await until(() => gate.forChat(dm.id).length === 2, 'computer context restart')
    expect(steer).not.toHaveBeenCalled()
    expect(gate.forChat(dm.id)[1]?.input.contextBlock).toContain('Explicit computer target: @computer')
    gate.forChat(dm.id)[1]?.finish()
    await Promise.all([first, addition])
  })
})

describe('a one-time routine turn', () => {
  it('posts a literal reminder as the persona without starting the driver, and alerts', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, store, sent } = await harness(scripted(() => [{ type: 'result', text: 'never' }], seen))
    const dm = await store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })

    await orchestrator.submitUserMessage(dm.id, 'Bel de huisarts over de uitslag.', [], {
      source: 'routine',
      routineId: 'routine-gp',
      routineName: 'GP call',
      targetAgentId: 'sage',
      previousRunAt: null,
      dueAt: 1_000,
      literal: 'Bel de huisarts over de uitslag.',
      notice: 'alert',
    })

    expect(seen).toHaveLength(0)
    const events = await store.loadEvents(dm.id)
    expect(events.map((event) => event.type)).toEqual(['user_message', 'agent_message', 'turn_result'])
    expect(events[0]).toMatchObject({ source: 'routine', routineDueAt: 1_000 })
    expect(events[1]).toMatchObject({ agentId: 'sage', text: 'Bel de huisarts over de uitslag.' })
    expect(events[2]).toMatchObject({ routineOutcome: 'publish' })
    expect(sent.filter((message) => message.type === 'turn_state' && message.state === 'done')).toEqual([
      expect.objectContaining({ routineOutcome: 'publish', notice: 'alert' }),
    ])
  })

  it('posts the expiry instead of running when the deadline passed while the turn queued', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, store, sent } = await harness(scripted(() => [{ type: 'result', text: 'never' }], seen))
    const dm = await store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })

    await orchestrator.submitUserMessage(dm.id, 'Check whether the landlord replied.', [], {
      source: 'routine',
      routineId: 'routine-reply',
      routineName: 'Reply check',
      targetAgentId: 'sage',
      previousRunAt: null,
      dueAt: Date.now() - 60_000,
      expiry: { at: Date.now() - 1, note: '"Reply check" did not run.' },
    })

    expect(seen).toHaveLength(0)
    const events = await store.loadEvents(dm.id)
    expect(events.map((event) => event.type)).toEqual(['user_message', 'system_note', 'turn_result'])
    expect(events[1]).toMatchObject({ kind: 'info', text: '"Reply check" did not run.' })
    expect(events[2]).toMatchObject({ routineExpired: true, routineOutcome: 'publish' })
    // No notice asked for: the end carries none.
    expect(sent.find((message) => message.type === 'turn_state' && message.state === 'done')).not.toHaveProperty('notice')
  })

  it('publishes a one-time check that declared itself quiet, and tells it so up front', async () => {
    const seen: TurnInput[] = []
    const { orchestrator, store } = await harness(scripted(
      () => [{ type: 'result', text: `Geen antwoord van de verhuurder.\n${DM_ROUTINE_QUIET_MARKER}`, sessionId: 's1' }],
      seen,
    ))
    const dm = await store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })

    await orchestrator.submitUserMessage(dm.id, 'Check whether the landlord replied.', [], {
      source: 'routine',
      routineId: 'routine-reply',
      routineName: 'Reply check',
      targetAgentId: 'sage',
      previousRunAt: null,
      dueAt: Date.now() - 3 * 60 * 60 * 1000,
    })

    const events = await store.loadEvents(dm.id)
    expect(events.find((event) => event.type === 'agent_message')).toMatchObject({ text: 'Geen antwoord van de verhuurder.' })
    expect(events.find((event) => event.type === 'turn_result')).toMatchObject({ routineOutcome: 'publish' })
    const composed = composeCatchUp({ events: seen[0]?.catchUp ?? [], agents: roster, isFullCatchUp: true })
    expect(composed).toContain('one-time task')
    expect(composed).toContain('running late')
    expect(composed).toContain('grants no permission to send messages')
  })
})

describe('Orchestrator, background wakes', () => {
  /** Every turn, persona or child, runs until the test ends it. */
  function held() {
    const turns: { input: TurnInput; queue: AsyncQueue<RuntimeEvent>; stop: ReturnType<typeof vi.fn> }[] = []
    const driver: Driver = {
      startTurn(input) {
        const queue = new AsyncQueue<RuntimeEvent>()
        const stop = vi.fn(() => queue.close())
        turns.push({ input, queue, stop })
        return { events: queue, stop }
      },
    }
    const end = (index: number, text: string, before: RuntimeEvent[] = []) => {
      const turn = turns[index]!
      for (const event of before) turn.queue.push(event)
      turn.queue.push({ type: 'result', text, usage: { inputTokens: 10, outputTokens: 4 }, sessionId: `s-${turn.input.threadId}-${turn.input.agent.id}` })
      turn.queue.close()
    }
    const of = (agentId: string) => turns.filter((turn) => turn.input.agent.id === agentId)
    return { driver, turns, end, of }
  }

  /** Delegates from the persona's running turn in `chatId`, without waiting. */
  async function delegateFrom(orchestrator: Orchestrator, chatId: string, agentId: string, task: string): Promise<string> {
    const turnId = orchestrator.activeTurn(chatId)?.turnId
    if (turnId === undefined) throw new Error('no running turn to delegate from')
    const report = await orchestrator.subagents.delegate({ chatId, agentId, turnId }, { task, model: 'gpt-6.1-sol', effort: 'high', wait: false })
    return report.taskId
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 20))
  async function eventually(check: () => Promise<boolean>, what: string): Promise<void> {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      if (await check()) return
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
    throw new Error(`timed out waiting for ${what}`)
  }

  const wakeRows = (events: readonly ThreadEvent[]) =>
    events.filter((event) => event.type === 'user_message' && event.source === 'background_wake')
  const noteTexts = (events: readonly ThreadEvent[]) =>
    events.flatMap((event) => (event.type === 'system_note' ? [event.text] : []))

  it('queues an addition behind a turn that only waits on its background work instead of restarting it', async () => {
    const { driver, turns, end } = held()
    const { orchestrator, store } = await harness(driver)
    const dm = await store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })
    const first = orchestrator.submitUserMessage(dm.id, 'Build it in the background.')
    await until(() => turns.length === 1, "Sage's turn")
    // Cursor's shape: the CLI answered and holds its result until the work ends.
    turns[0]!.queue.push({ type: 'message', messageId: 'started', text: 'Building.' })
    turns[0]!.queue.push({ type: 'background_wait', agents: 0, commands: 1 })
    await eventually(async () => (await store.loadEvents(dm.id)).some((event) => event.type === 'agent_message'), 'the answer')
    await settle()

    const addition = orchestrator.submitUserMessage(dm.id, 'Also run the tests.')
    await eventually(async () => (await store.loadEvents(dm.id)).some((event) =>
      event.type === 'user_message' && event.text === 'Also run the tests.'), 'the addition')
    await settle()
    expect(turns[0]!.stop).not.toHaveBeenCalled()
    expect(turns).toHaveLength(1)
    const saved = (await store.loadEvents(dm.id)).find((event) => event.type === 'user_message' && event.text === 'Also run the tests.')
    expect(saved).toMatchObject({ dispatchState: 'pending' })
    expect(saved?.type === 'user_message' && saved.steersTurnId).toBeUndefined()

    end(0, 'Built.', [{ type: 'background_wait', agents: 0, commands: 0 }])
    await until(() => turns.length === 2, 'the queued turn')
    expect(turns[1]!.input.catchUp.filter((event) => event.type === 'user_message').map((event) => event.text))
      .toContain('Also run the tests.')
    end(1, 'The tests pass.')
    await Promise.all([first, addition])
  })

  it('queues an addition whose turn starts waiting on background work while it is saved', async () => {
    const { driver, turns, end } = held()
    const { orchestrator, store } = await harness(driver)
    const dm = await store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })
    const first = orchestrator.submitUserMessage(dm.id, 'Build it in the background.')
    await until(() => turns.length === 1, "Sage's turn")
    turns[0]!.queue.push({ type: 'message', messageId: 'started', text: 'Building.' })
    await eventually(async () => (await store.loadEvents(dm.id)).some((event) => event.type === 'agent_message'), 'the answer')

    const append = store.appendEvent.bind(store)
    let release = () => {}
    const saved = new Promise<void>((resolve) => { release = resolve })
    let saving = false
    store.appendEvent = async (chatId, event) => {
      if (event.type === 'user_message' && event.text === 'Also run the tests.') {
        saving = true
        await saved
      }
      return append(chatId, event)
    }
    const addition = orchestrator.submitUserMessage(dm.id, 'Also run the tests.', [{ name: 'trace.png', dataUrl: 'data:image/png;base64,aW1hZ2U=' }])
    await until(() => saving, 'the addition being saved')
    turns[0]!.queue.push({ type: 'background_wait', agents: 0, commands: 1 })
    await until(() => orchestrator.activeTurn(dm.id)?.background?.commands === 1, 'the background wait')
    release()
    const stored = async () => (await store.loadEvents(dm.id)).flatMap((event) =>
      event.type === 'user_message' && event.text === 'Also run the tests.' ? [event] : [])[0]
    await eventually(async () => (await stored())?.dispatchState === 'pending', 'the queued addition')
    await settle()
    expect(turns[0]!.stop).not.toHaveBeenCalled()
    const queued = await stored()
    expect(queued).toMatchObject({ dispatchState: 'pending', images: [{ name: 'trace.png' }] })
    expect(queued?.steersTurnId).toBeUndefined()

    end(0, 'Built.', [{ type: 'background_wait', agents: 0, commands: 0 }])
    await until(() => turns.length === 2, 'the queued turn')
    expect(turns[1]!.input.catchUp.filter((event) => event.type === 'user_message').map((event) => event.id))
      .toContain(queued?.id)
    end(1, 'The tests pass.')
    await Promise.all([first, addition])
  })

  it('lets a Grok parent start delegate_task children, with the subagent rule only where it may', async () => {
    const grants: [string, boolean][] = []
    const seen: TurnInput[] = []
    const { orchestrator, chatId } = await harness(scripted(() => [{ type: 'result', text: 'Done.' }], seen), {
      agents: roster.map((agent) => agent.id === 'sage' ? { ...agent, driver: 'grok', model: 'grok-4.5', effort: 'high' } : agent),
      interactionMcp: (_chatId, agent, _turnId, allowAsk, permissions) => {
        grants.push([agent.driver, permissions?.allowSubagents === true])
        return interactionMcpAttachment('http://127.0.0.1:8787/internal/user-input', 'capability', { allowAsk })
      },
    })
    await orchestrator.submitUserMessage(chatId, '@Sage hello there')
    expect(grants).toEqual([['grok', true]])
    expect(seen[0]?.agent.character).toContain(SUBAGENT_RULE)

    const bare: TurnInput[] = []
    const plain = await harness(scripted(() => [{ type: 'result', text: 'Done.' }], bare))
    await plain.orchestrator.submitUserMessage(plain.chatId, '@Sage hello there')
    expect(bare[0]?.agent.character).not.toContain('[Manor] Subagents:')
  })

  it('wakes the persona whose child ended after its turn, with the answer in a wake row', async () => {
    const { driver, turns, end, of } = held()
    const { orchestrator, store, chatId } = await harness(driver)

    const running = orchestrator.submitUserMessage(chatId, '@Smith count the files in the background')
    await until(() => turns.length === 1, "Smith's turn")
    await delegateFrom(orchestrator, chatId, 'smith', 'Count the files.')
    await until(() => turns.length === 2, 'the child')
    end(0, 'Started it in the background.')
    await running
    expect(of('smith')).toHaveLength(1)

    end(1, 'There are 4 files.')
    await until(() => of('smith').length === 2, 'the wake')
    const wake = of('smith')[1]!
    const row = wake.input.catchUp.at(-1)
    expect(row).toMatchObject({
      type: 'user_message', source: 'background_wake', mentions: [],
      wakeItems: [{ title: 'Count the files', state: 'done', driver: 'codex', model: 'gpt-6.1-sol' }],
    })
    expect(row?.type === 'user_message' ? row.text : '').toContain('There are 4 files.')
    end(turns.indexOf(wake), 'The child counted 4 files.')
    await eventually(async () => (await store.loadEvents(chatId)).filter((event) => event.type === 'agent_message').length === 2, 'the wake reply')
    const events = await store.loadEvents(chatId)
    expect(events.filter((event) => event.type === 'agent_message').map((event) => event.type === 'agent_message' && event.text))
      .toEqual(['Started it in the background.', 'The child counted 4 files.'])
    expect(wakeRows(events)).toHaveLength(1)
  })

  it('lets a turn absorb a result it read, and wakes only for the one it left unread', async () => {
    const { driver, turns, end, of } = held()
    const { orchestrator, store, chatId } = await harness(driver)

    const running = orchestrator.submitUserMessage(chatId, '@Smith split it in two')
    await until(() => turns.length === 1, "Smith's turn")
    const read = await delegateFrom(orchestrator, chatId, 'smith', 'Read the logs.')
    await delegateFrom(orchestrator, chatId, 'smith', 'Check the build.')
    await until(() => turns.length === 3, 'both children')
    end(1, 'Logs are clean.')
    await expect(orchestrator.subagents.result({ chatId, agentId: 'smith', turnId: orchestrator.activeTurn(chatId)!.turnId }, read))
      .resolves.toMatchObject({ status: 'done', result: 'Logs are clean.' })
    end(2, 'The build is red.')
    await until(() => orchestrator.subagents.unreadFor(chatId, 'smith').length === 1, 'the unread build result')
    end(0, 'Both are back.')
    await running

    await until(() => of('smith').length === 2, 'the wake for the unread child')
    expect(of('smith')[1]!.input.catchUp.at(-1)).toMatchObject({
      source: 'background_wake', wakeItems: [{ title: 'Check the build', state: 'done' }],
    })
    end(turns.indexOf(of('smith')[1]!), 'The build is red, fixing.')
    await settle()
    expect(wakeRows(await store.loadEvents(chatId))).toHaveLength(1)
  })

  /** Smith starts one child per task in his turn, which then ends; returns the child's turn index by task. */
  async function startChildren(orchestrator: Orchestrator, chatId: string, h: ReturnType<typeof held>, tasks: string[]) {
    const running = orchestrator.submitUserMessage(chatId, '@Smith review it three ways')
    await until(() => h.turns.length === 1, "Smith's turn")
    for (const task of tasks) await delegateFrom(orchestrator, chatId, 'smith', task)
    await until(() => h.turns.length === 1 + tasks.length, 'the children')
    h.end(0, 'Reviews started.')
    await running
    return (task: string) => h.turns.findIndex((turn) => turn.input.agent.id === SUBAGENT_VOICE.id &&
      turn.input.catchUp[0]?.type === 'user_message' && turn.input.catchUp[0].text === task)
  }
  const fail = (h: ReturnType<typeof held>, index: number) => {
    h.turns[index]!.queue.push({ type: 'error', message: 'provider fell over' })
    h.turns[index]!.queue.close()
  }

  it('holds the wake while siblings run and wakes once with every answer when the last ends', async () => {
    const h = held()
    const { orchestrator, store, chatId } = await harness(h.driver)
    const child = await startChildren(orchestrator, chatId, h, ['Simplicity.', 'Standards.', 'Spec.'])

    h.end(child('Simplicity.'), 'Simplicity is fine.')
    await until(() => orchestrator.subagents.unreadFor(chatId, 'smith').length === 1, 'the first answer')
    h.end(child('Standards.'), 'Standards: one finding.')
    await until(() => orchestrator.subagents.unreadFor(chatId, 'smith').length === 2, 'the second answer')
    await settle()
    expect(h.of('smith')).toHaveLength(1)

    h.end(child('Spec.'), 'Spec is met.')
    await until(() => h.of('smith').length === 2, 'the one wake')
    const row = h.of('smith')[1]!.input.catchUp.at(-1)
    expect(row).toMatchObject({
      source: 'background_wake',
      wakeItems: [{ title: 'Simplicity', state: 'done' }, { title: 'Standards', state: 'done' }, { title: 'Spec', state: 'done' }],
    })
    const text = row?.type === 'user_message' ? row.text : ''
    for (const answer of ['Simplicity is fine.', 'Standards: one finding.', 'Spec is met.']) expect(text).toContain(answer)
    h.end(h.turns.indexOf(h.of('smith')[1]!), 'All three are in.')
    await settle()
    expect(h.of('smith')).toHaveLength(2)
    expect(wakeRows(await store.loadEvents(chatId))).toHaveLength(1)
  })

  it('wakes at once for a failed child while its siblings still run', async () => {
    const h = held()
    const { orchestrator, chatId } = await harness(h.driver)
    const child = await startChildren(orchestrator, chatId, h, ['Standards.', 'Spec.'])

    fail(h, child('Standards.'))
    await until(() => h.of('smith').length === 2, 'the wake for the failure')
    expect(h.of('smith')[1]!.input.catchUp.at(-1)).toMatchObject({
      source: 'background_wake', wakeItems: [{ title: 'Standards', state: 'failed' }],
    })
    expect(h.turns[child('Spec.')]!.stop).not.toHaveBeenCalled()
    h.end(h.turns.indexOf(h.of('smith')[1]!), 'Standards failed, Spec still runs.')
    h.end(child('Spec.'), 'Spec is met.')
    await until(() => h.of('smith').length === 3, 'the wake for the last child')
    expect(h.of('smith')[2]!.input.catchUp.at(-1)).toMatchObject({ wakeItems: [{ title: 'Spec', state: 'done' }] })
    h.end(h.turns.indexOf(h.of('smith')[2]!), 'Done.')
  })

  it('wakes with what has ended once the wait runs out, and the rest wake as they end', async () => {
    const h = held()
    const { orchestrator, chatId } = await harness(h.driver, { wakeHoldMs: 60 })
    const child = await startChildren(orchestrator, chatId, h, ['Simplicity.', 'Standards.', 'Spec.'])

    h.end(child('Simplicity.'), 'Simplicity is fine.')
    await until(() => h.of('smith').length === 2, 'the wake at the end of the wait')
    expect(h.of('smith')[1]!.input.catchUp.at(-1)).toMatchObject({ wakeItems: [{ title: 'Simplicity', state: 'done' }] })
    h.end(h.turns.indexOf(h.of('smith')[1]!), 'One is back, two still run.')

    h.end(child('Standards.'), 'Standards: one finding.')
    await until(() => h.of('smith').length === 3, 'the wake for the second child')
    expect(h.of('smith')[2]!.input.catchUp.at(-1)).toMatchObject({ wakeItems: [{ title: 'Standards' }] })
    h.end(h.turns.indexOf(h.of('smith')[2]!), 'Two are back.')
    h.end(child('Spec.'), 'Spec is met.')
    await until(() => h.of('smith').length === 4, 'the wake for the last child')
    h.end(h.turns.indexOf(h.of('smith')[3]!), 'All three are in.')
  })

  it('counts the wait from a child that ended during its persona\'s turn, not from that turn\'s end', async () => {
    const h = held()
    const { orchestrator, chatId } = await harness(h.driver, { wakeHoldMs: 300 })
    const running = orchestrator.submitUserMessage(chatId, '@Smith review it two ways')
    await until(() => h.turns.length === 1, "Smith's turn")
    await delegateFrom(orchestrator, chatId, 'smith', 'Standards.')
    await delegateFrom(orchestrator, chatId, 'smith', 'Spec.')
    await until(() => h.turns.length === 3, 'the children')
    h.end(1, 'Standards: one finding.')
    await until(() => orchestrator.subagents.unreadFor(chatId, 'smith').length === 1, 'the unread answer')
    await new Promise((resolve) => setTimeout(resolve, 350))
    h.end(0, 'Spec still runs.')
    await running
    // The wait already ran out during the turn, so the wake comes now, not 300 ms later.
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(h.of('smith')).toHaveLength(2)
    expect(h.of('smith')[1]!.input.catchUp.at(-1)).toMatchObject({ wakeItems: [{ title: 'Standards' }] })
    h.end(h.turns.indexOf(h.of('smith')[1]!), 'Standards had one finding.')
  })

  it('drops a wake queued for a result the user\'s turn already read, so a newer one keeps waiting for its sibling', async () => {
    const h = held()
    const { orchestrator, chatId } = await harness(h.driver)
    const child = await startChildren(orchestrator, chatId, h, ['Old.'])
    const sage = orchestrator.submitUserMessage(chatId, '@Sage think')
    await until(() => h.of('sage').length === 1, "Sage's turn")
    const status = orchestrator.submitUserMessage(chatId, '@Smith start two more')
    await settle()
    // Its wake queues behind Sage; Smith's turn for the user then reads the answer first.
    h.end(child('Old.'), 'Old answer.')
    await until(() => orchestrator.subagents.unreadFor(chatId, 'smith').length === 1, 'the old answer')
    h.end(h.turns.indexOf(h.of('sage')[0]!), 'Thought.')
    await sage
    await until(() => h.of('smith').length === 2, "Smith's turn for the user")
    expect(h.of('smith')[1]!.input.catchUp.at(-1)).toMatchObject({ wakeItems: [{ title: 'Old' }] })
    await delegateFrom(orchestrator, chatId, 'smith', 'New first.')
    await delegateFrom(orchestrator, chatId, 'smith', 'New second.')
    await until(() => child('New second.') !== -1, 'the new children')
    h.end(child('New first.'), 'New first answer.')
    await until(() => orchestrator.subagents.unreadFor(chatId, 'smith').length === 1, 'the new answer')
    h.end(h.turns.indexOf(h.of('smith')[1]!), 'Waiting on the second.')
    await status
    await settle()
    expect(h.of('smith')).toHaveLength(2)
    h.end(child('New second.'), 'New second answer.')
    await until(() => h.of('smith').length === 3, 'the one wake for both new children')
    expect(h.of('smith')[2]!.input.catchUp.at(-1)).toMatchObject({ wakeItems: [{ title: 'New first' }, { title: 'New second' }] })
    h.end(h.turns.indexOf(h.of('smith')[2]!), 'Both are in.')
  })

  it('Stop during a hold stops the siblings and leaves no wake; what came back reaches the next message', async () => {
    const h = held()
    const { orchestrator, store, chatId } = await harness(h.driver, { wakeHoldMs: 40 })
    const child = await startChildren(orchestrator, chatId, h, ['Standards.', 'Spec.'])

    h.end(child('Standards.'), 'Standards: one finding.')
    await until(() => orchestrator.subagents.unreadFor(chatId, 'smith').length === 1, 'the held answer')
    expect(await orchestrator.stopBackgroundWork(chatId)).toBe(true)
    expect(h.turns[child('Spec.')]!.stop).toHaveBeenCalled()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(h.of('smith')).toHaveLength(1)
    expect(wakeRows(await store.loadEvents(chatId))).toHaveLength(0)

    const next = orchestrator.submitUserMessage(chatId, '@Smith what came back?')
    await until(() => h.of('smith').length === 2, "Smith's turn for the user")
    expect(h.of('smith')[1]!.input.catchUp.at(-1)).toMatchObject({ source: 'background_wake', wakeItems: [{ title: 'Standards' }] })
    h.end(h.turns.indexOf(h.of('smith')[1]!), 'Standards had one finding.')
    await next
  })

  it('folds a held result into the user\'s turn, and a sibling the user stops releases the hold', async () => {
    const h = held()
    const { orchestrator, store, chatId } = await harness(h.driver)
    const child = await startChildren(orchestrator, chatId, h, ['Simplicity.', 'Standards.', 'Spec.'])

    h.end(child('Simplicity.'), 'Simplicity is fine.')
    await until(() => orchestrator.subagents.unreadFor(chatId, 'smith').length === 1, 'the held answer')
    const status = orchestrator.submitUserMessage(chatId, '@Smith status?')
    await until(() => h.of('smith').length === 2, "Smith's turn for the user")
    expect(h.of('smith')[1]!.input.catchUp.at(-1)).toMatchObject({ source: 'background_wake', wakeItems: [{ title: 'Simplicity' }] })
    h.end(h.turns.indexOf(h.of('smith')[1]!), 'One of three is back.')
    await status

    h.end(child('Standards.'), 'Standards: one finding.')
    await until(() => orchestrator.subagents.unreadFor(chatId, 'smith').length === 1, 'the next held answer')
    await settle()
    expect(h.of('smith')).toHaveLength(2)
    const launch = (await store.loadEvents(chatId)).find((event) => event.type === 'tool_use' && event.subagent?.title === 'Spec')
    expect(orchestrator.subagents.stop(chatId, launch?.type === 'tool_use' ? launch.toolCallId! : '')).toBe(true)
    await until(() => h.of('smith').length === 3, 'the wake once the last sibling stopped')
    expect(h.of('smith')[2]!.input.catchUp.at(-1)).toMatchObject({ wakeItems: [{ title: 'Standards', state: 'done' }] })
    h.end(h.turns.indexOf(h.of('smith')[2]!), 'Standards had one finding; Spec was stopped.')
  })

  it('folds a pending wake into the persona turn the user queued first, keeping their request and its browser target', async () => {
    const { driver, turns, end, of } = held()
    const target = vi.fn(async () => '[Manor] Explicit browser target: @browser')
    const { orchestrator, store, chatId } = await harness(driver, {
      builtInMcp: () => browserMcpAttachment('http://localhost/browser', 'test-capability'),
      browserTargetContext: target,
    })

    const first = orchestrator.submitUserMessage(chatId, '@Smith start the count')
    await until(() => turns.length === 1, "Smith's turn")
    await delegateFrom(orchestrator, chatId, 'smith', 'Count the files.')
    end(0, 'Counting in the background.')
    await first
    const sageTurn = orchestrator.submitUserMessage(chatId, '@Sage think about it')
    await until(() => of('sage').length === 1, "Sage's turn")
    const status = orchestrator.submitUserMessage(chatId, '@Smith what did it find? Check @browser too.')
    await settle()
    end(turns.findIndex((turn) => turn.input.agent.id === SUBAGENT_VOICE.id), 'There are 4 files.')
    await until(() => orchestrator.subagents.unreadFor(chatId, 'smith').length === 1, 'the unread result')
    end(turns.indexOf(of('sage')[0]!), 'Thought about it.')
    await sageTurn

    await until(() => of('smith').length === 2, "Smith's turn for the user")
    const catchUp = of('smith')[1]!.input.catchUp
    const tail = catchUp.filter((event) => event.type === 'user_message').slice(-2)
    expect(tail.map((event) => event.type === 'user_message' && [event.source ?? 'user', event.text.split('\n')[0]])).toEqual([
      ['user', '@Smith what did it find? Check @browser too.'],
      ['background_wake', 'Background work you started has ended while this chat moved on.'],
    ])
    // The wake row comes last, but the user's message is still the request it targets.
    expect(target).toHaveBeenCalledOnce()
    expect(of('smith')[1]!.input.contextBlock).toContain('Explicit browser target: @browser')
    end(turns.indexOf(of('smith')[1]!), 'It found 4 files.')
    await status
    await settle()
    expect(of('smith')).toHaveLength(2)
    expect(wakeRows(await store.loadEvents(chatId))).toHaveLength(1)
  })

  it('runs at most the wake cap per message, stops what still runs and hands the rest to the next message', async () => {
    const { driver, turns, end, of } = held()
    // At the cap nothing waits for siblings: the second child's end stops the third.
    const { orchestrator, store, chatId } = await harness(driver, { wakeCap: 1 })
    const child = (title: string) => turns.findIndex((turn) => turn.input.agent.id === SUBAGENT_VOICE.id && turn.input.catchUp[0]?.type === 'user_message' && turn.input.catchUp[0].text === title)

    const first = orchestrator.submitUserMessage(chatId, '@Smith go')
    await until(() => turns.length === 1, "Smith's turn")
    await delegateFrom(orchestrator, chatId, 'smith', 'First.')
    end(0, 'Started one.')
    await first
    end(child('First.'), 'First is done.')
    await until(() => of('smith').length === 2, 'the first wake')
    await delegateFrom(orchestrator, chatId, 'smith', 'Second.')
    await delegateFrom(orchestrator, chatId, 'smith', 'Third.')
    end(turns.indexOf(of('smith')[1]!), 'Started two more.')
    await eventually(async () => (await store.loadEvents(chatId)).some((event) => event.type === 'agent_message' && event.text === 'Started two more.'), 'the first wake to end')
    end(child('Second.'), 'Second is done.')

    await until(() => turns[child('Third.')]!.stop.mock.calls.length > 0, 'the cap to stop the third child')
    await eventually(async () => noteTexts(await store.loadEvents(chatId)).some((text) => text.startsWith('Smith was not woken')), 'the cap note')
    const events = await store.loadEvents(chatId)
    expect(of('smith')).toHaveLength(2)
    expect(noteTexts(events)).toContain('Smith was not woken: Manor runs at most 1 wake per message. Stopped “Third”. What came back reaches Smith with your next message.')

    const next = orchestrator.submitUserMessage(chatId, '@Smith and?')
    await until(() => of('smith').length === 3, "Smith's turn for the user")
    expect(of('smith')[2]!.input.catchUp.at(-1)).toMatchObject({ source: 'background_wake', wakeItems: [{ title: 'Second', state: 'done' }] })
    end(turns.indexOf(of('smith')[2]!), 'Second came back done.')
    await next
  })

  it('releases a held result once another persona takes the last allowed wake, so the cap stops its sibling', async () => {
    const h = held()
    const { orchestrator, chatId } = await harness(h.driver, { wakeCap: 1 })
    const child = (task: string) => h.turns.findIndex((turn) => turn.input.agent.id === SUBAGENT_VOICE.id &&
      turn.input.catchUp[0]?.type === 'user_message' && turn.input.catchUp[0].text === task)
    const both = orchestrator.submitUserMessage(chatId, '@Smith @Sage start reviews')
    await until(() => h.of('smith').length === 1, "Smith's turn")
    await delegateFrom(orchestrator, chatId, 'smith', 'Smith first.')
    await delegateFrom(orchestrator, chatId, 'smith', 'Smith second.')
    h.end(h.turns.indexOf(h.of('smith')[0]!), 'Started two.')
    await until(() => h.of('sage').length === 1, "Sage's turn")
    await delegateFrom(orchestrator, chatId, 'sage', 'Sage child.')
    h.end(child('Smith first.'), 'Smith first answer.')
    await until(() => orchestrator.subagents.unreadFor(chatId, 'smith').length === 1, "Smith's held answer")
    h.end(h.turns.indexOf(h.of('sage')[0]!), 'Started one.')
    await both

    h.end(child('Sage child.'), 'Sage answer.')
    await until(() => h.of('sage').length === 2, "Sage's wake, the last one allowed")
    h.end(h.turns.indexOf(h.of('sage')[1]!), 'Sage is done.')
    await until(() => h.turns[child('Smith second.')]!.stop.mock.calls.length > 0, "the cap to stop Smith's sibling")
    expect(h.of('smith')).toHaveLength(1)
  })

  it('Stop while waiting stops the children, and a stopped turn drops the pending wake until the user speaks', async () => {
    const { driver, turns, end, of } = held()
    const { orchestrator, store, chatId } = await harness(driver)

    const first = orchestrator.submitUserMessage(chatId, '@Smith start two')
    await until(() => turns.length === 1, "Smith's turn")
    await delegateFrom(orchestrator, chatId, 'smith', 'Count the files.')
    await delegateFrom(orchestrator, chatId, 'smith', 'Read the logs.')
    end(0, 'Both started.')
    await first

    // One child is back while Sage's turn holds the queue, so its wake waits behind it.
    const sageTurn = orchestrator.submitUserMessage(chatId, '@Sage think')
    await until(() => of('sage').length === 1, "Sage's turn")
    end(turns.findIndex((turn) => turn.input.agent.id === SUBAGENT_VOICE.id), 'There are 4 files.')
    await until(() => orchestrator.subagents.unreadFor(chatId, 'smith').length === 1, 'the unread result')
    orchestrator.stop(orchestrator.activeTurn(chatId)!.turnId)
    await sageTurn
    // The stop reached the child that still ran; the one that had answered was done.
    await until(() => of(SUBAGENT_VOICE.id)[1]!.stop.mock.calls.length > 0, 'the running child to stop')
    await settle()
    expect(of('smith')).toHaveLength(1)

    const next = orchestrator.submitUserMessage(chatId, '@Smith anything?')
    await until(() => of('smith').length === 2, "Smith's next turn")
    expect(of('smith')[1]!.input.catchUp.at(-1)).toMatchObject({ source: 'background_wake', wakeItems: [{ title: 'Count the files' }] })
    await delegateFrom(orchestrator, chatId, 'smith', 'Count again.')
    end(turns.indexOf(of('smith')[1]!), 'Counting again.')
    await next

    expect(await orchestrator.stopBackgroundWork(chatId)).toBe(true)
    const events = await store.loadEvents(chatId)
    // Each stopped helper reads Stopped in its own turn; the Stop leaves no line of its own.
    expect(noteTexts(events).some((text) => text.startsWith('Stopped'))).toBe(false)
    await settle()
    expect(of('smith')).toHaveLength(2)
  })

  it('a background Stop reaches a wake still preparing, and one whose turn has started', async () => {
    const { driver, turns, end, of } = held()
    const { orchestrator, store, chatId } = await harness(driver)

    const first = orchestrator.submitUserMessage(chatId, '@Smith go')
    await until(() => turns.length === 1, "Smith's turn")
    await delegateFrom(orchestrator, chatId, 'smith', 'Count the files.')
    end(0, 'Started.')
    await first

    // The wake holds at its first read, before any turn exists, when Stop lands.
    const getChat = store.getChat.bind(store)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let preparing = false
    store.getChat = async (id) => {
      if (id === chatId && !preparing) {
        preparing = true
        await gate
      }
      return getChat(id)
    }
    end(1, 'There are 4 files.')
    await until(() => preparing, 'the wake to prepare')
    await orchestrator.stopBackgroundWork(chatId)
    release()
    await settle()
    expect(of('smith')).toHaveLength(1)

    // The user's next message gets the result, and a later wake's turn is stopped too.
    const next = orchestrator.submitUserMessage(chatId, '@Smith and?')
    await until(() => of('smith').length === 2, "Smith's turn for the user")
    expect(of('smith')[1]!.input.catchUp.at(-1)).toMatchObject({ source: 'background_wake', wakeItems: [{ title: 'Count the files' }] })
    await delegateFrom(orchestrator, chatId, 'smith', 'Count again.')
    end(turns.indexOf(of('smith')[1]!), 'Counting again.')
    await next
    end(turns.length - 1, 'Still 4 files.')
    await until(() => of('smith').length === 3, 'the second wake')
    expect(await orchestrator.stopBackgroundWork(chatId)).toBe(true)
    await until(() => of('smith')[2]!.stop.mock.calls.length > 0, 'the wake turn to stop')
    await eventually(async () => noteTexts(await store.loadEvents(chatId)).includes("Smith's turn was stopped."), 'the stopped note')
  })

  it('acts on no mention a wake writes outside a goal Session', async () => {
    const { driver, turns, end, of } = held()
    const agents = [sage, { ...smith, mentionAllowlist: ['sage'] }]
    const { orchestrator, store, chatId } = await harness(driver, { agents })

    const first = orchestrator.submitUserMessage(chatId, '@Smith go')
    await until(() => turns.length === 1, "Smith's turn")
    await delegateFrom(orchestrator, chatId, 'smith', 'Count the files.')
    end(0, 'Started.')
    await first
    end(1, 'There are 4 files.')
    await until(() => of('smith').length === 2, 'the wake')
    end(turns.indexOf(of('smith')[1]!), '@Sage please double-check the count.')
    await eventually(async () => noteTexts(await store.loadEvents(chatId)).length > 0, 'the note')
    await settle()
    expect(of('sage')).toHaveLength(0)
    expect(noteTexts(await store.loadEvents(chatId))).toContain('Sage was not asked: a turn after background work ends brings nobody in')
  })

  it('in a goal Session, waits instead of nudging while the lead’s child runs, and stops leftovers at goal_reached', async () => {
    const { driver, turns, end, of } = held()
    const house = cosRoster.map((agent) => ({ ...agent, mentionAllowlist: cosRoster.filter((other) => other.id !== agent.id).map((other) => other.id) }))
    // No wait for siblings: the lead wakes for the cause while the report still runs.
    const { orchestrator, store, projectId } = await harness(driver, { agents: house, wakeCap: 0, wakeHoldMs: 0 })
    const source = await store.createChat({ kind: 'dm', memberIds: ['marlow'], title: 'Marlow' })
    const { handoff } = await store.reserveWorkHandoff({
      sourceChatId: source.id, sourceTurnId: 'proposal', projectId, projectName: 'Manor',
      title: 'Fix the bug', task: 'Fix the bug.', authorAgentId: 'marlow',
      leadAgentId: 'marlow', leadAgentName: 'Marlow', supportingAgentIds: [], supportingAgentNames: [],
    })
    const chatId = (await store.materializeWorkHandoff(handoff.id)).workChatId!
    await store.acceptWorkHandoff(chatId)

    const first = orchestrator.submitUserMessage(chatId, 'Fix the bug.')
    await until(() => turns.length === 1, "Marlow's turn")
    await delegateFrom(orchestrator, chatId, 'marlow', 'Find the cause.')
    await delegateFrom(orchestrator, chatId, 'marlow', 'Write the long report.')
    end(0, 'Two helpers are on it.')
    await first
    expect(of('marlow')).toHaveLength(1)
    expect(noteTexts(await store.loadEvents(chatId))).toEqual([])

    end(turns.findIndex((turn) => turn.input.agent.id === SUBAGENT_VOICE.id), 'The cause is a stale cache.')
    // The wake cap is zero here, and a goal Session does not count wakes.
    await until(() => of('marlow').length === 2, "the lead's wake")
    end(turns.indexOf(of('marlow')[1]!), 'Fixed and verified.', [
      { type: 'tool_use', toolCallId: 'goal', tool: 'mcp__manor__goal_reached' },
      { type: 'tool_result', toolCallId: 'goal', outcome: 'success' },
    ])
    await eventually(async () => noteTexts(await store.loadEvents(chatId)).includes('Marlow marked the goal reached.'), 'the goal note')
    expect(noteTexts(await store.loadEvents(chatId))).toContain('Background work stopped: “Write the long report”')
  })

  it('in a goal Session, a failed turn stops the background work, and what came back waits for the user', async () => {
    const { driver, turns, end, of } = held()
    const house = cosRoster.map((agent) => ({ ...agent, mentionAllowlist: cosRoster.filter((other) => other.id !== agent.id).map((other) => other.id) }))
    const { orchestrator, store, projectId } = await harness(driver, { agents: house })
    const source = await store.createChat({ kind: 'dm', memberIds: ['marlow'], title: 'Marlow' })
    const { handoff } = await store.reserveWorkHandoff({
      sourceChatId: source.id, sourceTurnId: 'proposal', projectId, projectName: 'Manor',
      title: 'Fix the bug', task: 'Fix the bug.', authorAgentId: 'marlow',
      leadAgentId: 'marlow', leadAgentName: 'Marlow', supportingAgentIds: [], supportingAgentNames: [],
    })
    const chatId = (await store.materializeWorkHandoff(handoff.id)).workChatId!
    await store.acceptWorkHandoff(chatId)

    const first = orchestrator.submitUserMessage(chatId, 'Fix the bug.')
    await until(() => turns.length === 1, "Marlow's turn")
    await delegateFrom(orchestrator, chatId, 'marlow', 'Find the cause.')
    await delegateFrom(orchestrator, chatId, 'marlow', 'Write the long report.')
    end(1, 'The cause is a stale cache.')
    await until(() => orchestrator.subagents.unreadFor(chatId, 'marlow').length === 1, 'the first result')
    turns[0]!.queue.push({ type: 'error', message: 'provider error' })
    turns[0]!.queue.close()
    await first

    await until(() => turns[2]!.stop.mock.calls.length > 0, 'the running child to stop')
    await settle()
    expect(of('marlow')).toHaveLength(1)
    expect(noteTexts(await store.loadEvents(chatId))).toContain('Background work stopped: “Write the long report”')

    const next = orchestrator.submitUserMessage(chatId, 'Try again.')
    await until(() => of('marlow').length === 2, "Marlow's turn for the user")
    expect(of('marlow')[1]!.input.catchUp.at(-1)).toMatchObject({ source: 'background_wake', wakeItems: [{ title: 'Find the cause', state: 'done' }] })
    orchestrator.stopActiveTurns()
    await next
  })
})

describe('Orchestrator, live sessions', () => {
  /**
   * A driver whose turns can leave a live session behind, as the Claude driver does:
   * `park` ends a turn with its answer while background work keeps the session, and the
   * persona's next live turn attaches to it.
   */
  function liveDriver() {
    const turns: { input: TurnInput; queue: AsyncQueue<RuntimeEvent>; stop: ReturnType<typeof vi.fn> }[] = []
    const sessions = new Map<string, LiveSessionInfo>()
    const closed: { threadId: string; agentId: string | undefined }[] = []
    let sink: (event: LiveSessionEvent) => void = () => {}
    const key = (threadId: string, agentId: string) => `${threadId}/${agentId}`
    const driver: Driver = {
      startTurn(input) {
        if (input.live === true) sessions.delete(key(input.threadId, input.agent.id))
        const queue = new AsyncQueue<RuntimeEvent>()
        const stop = vi.fn(() => queue.close())
        turns.push({ input, queue, stop })
        return { events: queue, stop }
      },
      liveSession: (threadId, agentId) => sessions.get(key(threadId, agentId)),
      closeLiveSession(threadId, agentId) {
        closed.push({ threadId, agentId })
        const titles: string[] = []
        for (const [name, info] of [...sessions]) {
          if (!name.startsWith(`${threadId}/`) || (agentId !== undefined && name !== key(threadId, agentId))) continue
          titles.push(...info.running.map((item) => item.title))
          sessions.delete(name)
        }
        return titles
      },
    }
    const of = (agentId: string) => turns.filter((turn) => turn.input.agent.id === agentId)
    const end = (turn: (typeof turns)[number], text: string, before: RuntimeEvent[] = []) => {
      for (const event of before) turn.queue.push(event)
      turn.queue.push({ type: 'result', text, usage: { inputTokens: 10, outputTokens: 4 }, sessionId: 'live-session' })
      turn.queue.close()
    }
    /** Ends a turn while `running` still runs: the session outlives it. */
    const park = (turn: (typeof turns)[number], text: string, running: LiveSessionItem[], provider: 'claude' | 'codex' = 'claude') => {
      sessions.set(key(turn.input.threadId, turn.input.agent.id), {
        driver: provider, sessionId: 'live-session', model: defaultModel(provider), effort: 'high', running, wakeHeld: false,
      })
      if (provider === 'claude') {
        end(turn, text, running.map((item) => ({ type: 'tool_use', toolCallId: item.toolCallId, tool: 'Agent', subject: item.title, background: true })))
        return
      }
      // Codex announces its rows as background only at the answer, after the report.
      const launches = running.map((item): RuntimeEvent => ({ type: 'tool_use', toolCallId: item.toolCallId, tool: 'Bash', command: item.title, detail: item.title }))
      end(turn, text, [
        ...launches,
        { type: 'message', messageId: 'm-live', text },
        ...launches.map((launch) => ({ ...launch, background: true as const })),
      ])
    }
    /** `ended` finished; a Claude session's CLI then holds a run of its own, a Codex one never does. */
    const wake = (threadId: string, agentId: string, ended: Extract<LiveSessionEvent, { type: 'wake' }>['ended'], held = true) => {
      const info = sessions.get(key(threadId, agentId))
      if (info !== undefined && held) info.wakeHeld = true
      for (const item of ended) {
        sink({ type: 'row', threadId, agentId, event: { type: 'tool_result', toolCallId: item.toolCallId, outcome: item.state === 'done' ? 'success' : 'stopped' } })
      }
      sink({ type: 'wake', threadId, agentId, ended })
    }
    return {
      driver, turns, of, end, park, wake, closed,
      liveSessions: {
        info: (chatId: string, agentId: string) => sessions.get(key(chatId, agentId)),
        busyWork: () => new Map([...sessions].flatMap(([name, info]) => info.running.length === 0 ? [] : [[name.split('/')[0]!, info.running] as const])),
        close: driver.closeLiveSession!,
      },
      connect: (orchestrator: Orchestrator) => { sink = (event) => orchestrator.onLiveSession(event) },
    }
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20))
  const noteTexts = (events: readonly ThreadEvent[]) => events.flatMap((event) => (event.type === 'system_note' ? [event.text] : []))
  const counting = [{ toolCallId: 'bg-count', title: 'Count the files', kind: 'agent' as const }]

  it('settles a row on the turn that launched it, and runs the wake as the CLI\'s own run under a row naming what ended', async () => {
    const live = liveDriver()
    const { orchestrator, store, chatId } = await harness(live.driver, { liveSessions: live.liveSessions })
    live.connect(orchestrator)

    const first = orchestrator.submitUserMessage(chatId, '@Smith count in the background')
    await until(() => live.turns.length === 1, "Smith's turn")
    expect(live.turns[0]!.input.live).toBe(true)
    live.park(live.turns[0]!, 'Counting in the background.', counting)
    await first
    const launchTurn = (await store.loadEvents(chatId)).find((event) => event.type === 'tool_use' && event.toolCallId === 'bg-count')

    live.wake(chatId, 'smith', [{ toolCallId: 'bg-count', title: 'Count the files', state: 'done' }])
    await until(() => live.of('smith').length === 2, 'the wake turn')
    const wake = live.of('smith')[1]!
    expect(wake.input).toMatchObject({ wakeRun: true, live: true, sessionId: 'live-session', agent: { driver: 'claude' } })
    expect(wake.input.catchUp.at(-1)).toMatchObject({
      type: 'user_message', source: 'background_wake',
      wakeItems: [{ toolCallId: 'bg-count', title: 'Count the files', state: 'done', driver: 'claude', model: defaultModel('claude') }],
    })
    const row = wake.input.catchUp.at(-1)
    expect(row?.type === 'user_message' ? row.text : '').toContain('“Count the files” finished.')
    const settledRow = (await store.loadEvents(chatId)).find((event) => event.type === 'tool_result' && event.toolCallId === 'bg-count')
    expect(settledRow).toMatchObject({ outcome: 'success', agentId: 'smith', turnId: launchTurn?.type === 'tool_use' ? launchTurn.turnId : 'missing' })
    live.end(wake, 'It counted 4 files.')
    await settle()
  })

  it('lists a chat as in the background while its live session still runs a shell, and not once that ended', async () => {
    const live = liveDriver()
    const { orchestrator, chatId } = await harness(live.driver, { liveSessions: live.liveSessions })
    live.connect(orchestrator)
    const first = orchestrator.submitUserMessage(chatId, '@Smith build in the background')
    await until(() => live.turns.length === 1, "Smith's turn")
    const build = [{ toolCallId: 'shell-build', title: 'npm run build', kind: 'command' as const }]
    live.park(live.turns[0]!, 'Building.', build, 'codex')
    await first
    expect(orchestrator.backgroundChatIds([chatId, 'elsewhere'])).toEqual([chatId])
    expect(orchestrator.backgroundWork([chatId, 'elsewhere'])).toEqual({ [chatId]: [{ title: 'npm run build', kind: 'command' }] })
    build.length = 0
    expect(orchestrator.backgroundChatIds([chatId])).toEqual([])
    live.liveSessions.close(chatId)
    expect(orchestrator.backgroundChatIds([chatId])).toEqual([])
  })

  it('keeps listing a background shell after its persona left the roster', async () => {
    const live = liveDriver()
    const house = [...roster]
    const { orchestrator, chatId } = await harness(live.driver, { liveSessions: live.liveSessions, agents: house })
    live.connect(orchestrator)
    const first = orchestrator.submitUserMessage(chatId, '@Smith build in the background')
    await until(() => live.turns.length === 1, "Smith's turn")
    live.park(live.turns[0]!, 'Building.', [{ toolCallId: 'shell-build', title: 'npm run build', kind: 'command' }], 'codex')
    await first
    house.splice(house.findIndex((agent) => agent.id === 'smith'), 1)
    expect(orchestrator.backgroundChatIds([chatId])).toEqual([chatId])
  })

  it('wakes a Codex session through Manor\'s prompt, one wake for everything that ended before it ran', async () => {
    const live = liveDriver()
    const { orchestrator, store, chatId } = await harness(live.driver, { liveSessions: live.liveSessions })
    live.connect(orchestrator)
    const first = orchestrator.submitUserMessage(chatId, '@Smith build and test in the background')
    await until(() => live.turns.length === 1, "Smith's turn")
    live.park(live.turns[0]!, 'Both are running.', [
      { toolCallId: 'shell-build', title: 'npm run build', kind: 'command' },
      { toolCallId: 'shell-test', title: 'npm test', kind: 'command' },
    ], 'codex')
    await first
    // The rows announced again after the report are no unreported work to nudge about.
    expect(live.of('smith')).toHaveLength(1)
    expect((await store.loadEvents(chatId)).filter((event) => event.type === 'tool_use' && event.background === true)).toHaveLength(2)

    const sageTurn = orchestrator.submitUserMessage(chatId, '@Sage think')
    await until(() => live.of('sage').length === 1, "Sage's turn")
    live.wake(chatId, 'smith', [{ toolCallId: 'shell-build', title: 'npm run build', state: 'done' }], false)
    live.wake(chatId, 'smith', [{ toolCallId: 'shell-test', title: 'npm test', state: 'failed' }], false)
    live.end(live.of('sage')[0]!, 'Thought.')
    await sageTurn
    await until(() => live.of('smith').length === 2, 'the wake turn')
    const wake = live.of('smith')[1]!
    expect(wake.input.wakeRun).toBeUndefined()
    expect(wake.input).toMatchObject({ live: true, sessionId: 'live-session', agent: { driver: 'codex' } })
    const row = wake.input.catchUp.at(-1)
    expect(row).toMatchObject({ type: 'user_message', source: 'background_wake', wakeItems: [
      { toolCallId: 'shell-build', state: 'done', driver: 'codex' },
      { toolCallId: 'shell-test', state: 'failed', driver: 'codex' },
    ] })
    expect(row?.type === 'user_message' ? row.text : '').toContain('“npm test” failed.')
    live.end(wake, 'The build passed and one test failed.')
    await settle()
    expect(live.of('smith')).toHaveLength(2)
    expect((await store.loadEvents(chatId)).filter((event) => event.type === 'user_message' && event.source === 'background_wake')).toHaveLength(1)
  })

  it('folds a held wake into the persona\'s turn the user queued first, as a prompt turn rather than the CLI\'s run', async () => {
    const live = liveDriver()
    const { orchestrator, store, chatId } = await harness(live.driver, { liveSessions: live.liveSessions })
    live.connect(orchestrator)
    const first = orchestrator.submitUserMessage(chatId, '@Smith count in the background')
    await until(() => live.turns.length === 1, "Smith's turn")
    live.park(live.turns[0]!, 'Counting.', counting)
    await first

    const sageTurn = orchestrator.submitUserMessage(chatId, '@Sage think')
    await until(() => live.of('sage').length === 1, "Sage's turn")
    const status = orchestrator.submitUserMessage(chatId, '@Smith where is it?')
    await settle()
    live.wake(chatId, 'smith', [{ toolCallId: 'bg-count', title: 'Count the files', state: 'done' }])
    live.end(live.of('sage')[0]!, 'Thought.')
    await sageTurn
    await until(() => live.of('smith').length === 2, "Smith's turn for the user")
    const turn = live.of('smith')[1]!
    expect(turn.input.wakeRun).toBeUndefined()
    expect(turn.input.catchUp.filter((event) => event.type === 'user_message').slice(-2).map((event) =>
      event.type === 'user_message' ? event.source ?? 'user' : '')).toEqual(['user', 'background_wake'])
    live.end(turn, 'Done: 4 files.')
    await status
    await settle()
    expect(live.of('smith')).toHaveLength(2)
    expect((await store.loadEvents(chatId)).filter((event) => event.type === 'user_message' && event.source === 'background_wake')).toHaveLength(1)
  })

  it('keeps a persona, and a Single session, with a live session on that session\'s runtime and id, whatever its pin says now', async () => {
    for (const single of [false, true]) {
      const live = liveDriver()
      const { orchestrator, store, projectId, chatId: projectChat } = await harness(live.driver, { liveSessions: live.liveSessions })
      const chatId = single ? (await store.createChat({ projectId, mode: 'single' })).id : projectChat
      const voice = single ? SINGLE_CHAT_VOICE.id : 'smith'
      if (single) await store.setChatOverride(chatId, voice, { driver: 'claude', model: defaultModel('claude'), effort: 'high', auto: false })
      live.connect(orchestrator)
      const first = orchestrator.submitUserMessage(chatId, '@Smith count in the background')
      await until(() => live.of(voice).length === 1, 'the first turn')
      live.park(live.of(voice)[0]!, 'Counting.', counting)
      await first
      await store.setChatOverride(chatId, voice, { driver: 'codex', model: 'gpt-6.1-sol', effort: 'low', auto: false })

      const next = orchestrator.submitUserMessage(chatId, '@Smith and?')
      await until(() => live.of(voice).length === 2, 'the next turn')
      expect(live.of(voice)[1]!.input).toMatchObject({
        sessionId: 'live-session', agent: { driver: 'claude', model: defaultModel('claude'), effort: 'high' },
      })
      live.end(live.of(voice)[1]!, 'Still counting.')
      await next
    }
  })

  it('closes live sessions on Stop, and closes a session whose wake arrives while wakes are held', async () => {
    const live = liveDriver()
    const { orchestrator, store, chatId } = await harness(live.driver, { liveSessions: live.liveSessions })
    live.connect(orchestrator)
    const first = orchestrator.submitUserMessage(chatId, '@Smith count in the background')
    await until(() => live.turns.length === 1, "Smith's turn")
    live.park(live.turns[0]!, 'Counting.', counting)
    await first

    expect(await orchestrator.stopBackgroundWork(chatId)).toBe(true)
    expect(noteTexts(await store.loadEvents(chatId)).some((text) => text.startsWith('Stopped'))).toBe(false)
    expect(live.liveSessions.info(chatId, 'smith')).toBeUndefined()

    // A session that outlived the Stop asks to wake: Manor holds wakes, so it ends.
    live.park(live.turns[0]!, 'Counting.', counting)
    live.wake(chatId, 'smith', [])
    await settle()
    expect(live.closed.at(-1)).toEqual({ threadId: chatId, agentId: 'smith' })
    expect(live.of('smith')).toHaveLength(1)
  })

  it('in a goal Session, counts a lead whose live session still runs as waiting rather than ending empty', async () => {
    const live = liveDriver()
    const house = cosRoster.map((agent) => ({ ...agent, mentionAllowlist: cosRoster.filter((other) => other.id !== agent.id).map((other) => other.id) }))
    const { orchestrator, store, projectId } = await harness(live.driver, { agents: house, liveSessions: live.liveSessions })
    live.connect(orchestrator)
    const source = await store.createChat({ kind: 'dm', memberIds: ['marlow'], title: 'Marlow' })
    const { handoff } = await store.reserveWorkHandoff({
      sourceChatId: source.id, sourceTurnId: 'proposal', projectId, projectName: 'Manor',
      title: 'Fix the bug', task: 'Fix the bug.', authorAgentId: 'marlow',
      leadAgentId: 'marlow', leadAgentName: 'Marlow', supportingAgentIds: [], supportingAgentNames: [],
    })
    const chatId = (await store.materializeWorkHandoff(handoff.id)).workChatId!
    await store.acceptWorkHandoff(chatId)

    const first = orchestrator.submitUserMessage(chatId, 'Fix the bug.')
    await until(() => live.turns.length === 1, "Marlow's turn")
    live.park(live.turns[0]!, 'A helper is on it.', counting)
    await first
    expect(live.of('marlow')).toHaveLength(1)
    expect(noteTexts(await store.loadEvents(chatId))).toEqual([])
    orchestrator.stopActiveTurns()
  })
})

describe('questions that outlive a provider attempt', () => {
  const questions = [{ id: 'direction', question: 'Which direction?', options: [{ label: 'A' }, { label: 'B' }] }]

  afterEach(() => { vi.useRealTimers() })

  /** A broker recording into the orchestrator, as main.ts wires them. */
  async function asking(steer?: ReturnType<Driver['startTurn']>['steer']) {
    const gate = gated()
    let orchestrator!: Orchestrator
    const requests: string[] = []
    const broker = new InteractionBroker({
      request: async (context, requestId, asked) => {
        requests.push(requestId)
        return orchestrator.recordUserInputRequest(context.chatId, context.agentId, context.turnId, requestId, asked)
      },
      response: (context, requestId, answers) =>
        orchestrator.recordUserInputResponse(context.chatId, context.agentId, context.turnId, requestId, answers),
    })
    const driver: Driver = steer === undefined
      ? gate.driver
      : { startTurn: (input) => ({ ...gate.driver.startTurn(input), steer }) }
    const built = await harness(driver, { openQuestions: broker })
    orchestrator = built.orchestrator
    const running = orchestrator.submitUserMessage(built.chatId, '@Sage choose')
    await until(() => gate.forChat(built.chatId).length === 1, 'the question turn to start')
    const turnId = await waitForRunning(built.sent, built.chatId)
    return { ...built, gate, broker, requests, running, context: { chatId: built.chatId, agentId: 'sage', turnId } }
  }

  /** Six minutes on the fake clock: past the old 300 s transport death, nothing may fire. */
  async function sixMinutesPass() {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    for (let second = 0; second < 6 * 60; second += 1) await vi.advanceTimersByTimeAsync(1000)
    vi.useRealTimers()
  }

  // Codex and Cursor post and end their attempt; Claude or Grok may also end one while
  // a held question is still open. Either way the answer starts the next attempt.
  it.each(['post', 'request'] as const)('resumes the session with an answer given after six minutes (%s)', async (mode) => {
    const { orchestrator, store, chatId, gate, broker, requests, running, context } = await asking()
    if (mode === 'post') await broker.post(context, questions)
    else void broker.request(context, questions).catch(() => undefined)
    await until(() => requests.length === 1, 'the question card')
    gate.forChat(chatId)[0]!.finish()

    await sixMinutesPass()
    expect(gate.forChat(chatId)).toHaveLength(1)
    expect(orchestrator.activeTurn(chatId)?.turnId).toBe(context.turnId)

    await expect(broker.answer(chatId, requests[0]!, { direction: 'B' })).resolves.toBe(true)
    await until(() => gate.forChat(chatId).length === 2, 'the attempt carrying the answer')
    const resumed = gate.forChat(chatId)[1]!.input
    expect(resumed.sessionId).toBe(`session-${chatId}-sage`)
    expect(resumed.catchUp).toEqual([expect.objectContaining({
      type: 'system_note',
      text: expect.stringContaining('Which direction?\nAnswer: B'),
    })])
    gate.forChat(chatId)[1]!.finish()
    await running

    expect(types(await store.loadEvents(chatId))).toEqual([
      'user_message', 'user_input_request', 'agent_message', 'user_input_response', 'agent_message', 'turn_result',
    ])
  })

  // A Claude persona pinned to Codex must post, or its question dies with the cell.
  it('tells the Manor tools which provider the turn really runs on', async () => {
    const drivers: string[] = []
    const { orchestrator, chatId } = await harness(scripted(() => [{ type: 'result', text: 'Done.' }], []), {
      interactionMcp: (_chatId, agent, _turnId, allowAsk, permissions) => {
        drivers.push(permissions?.driver ?? agent.driver)
        return interactionMcpAttachment('http://127.0.0.1:8787/internal/user-input', 'capability', { allowAsk })
      },
    })
    await orchestrator.setOverride(chatId, 'sage', { driver: 'codex' })
    await orchestrator.submitUserMessage(chatId, '@Sage go')
    expect(drivers).toEqual(['codex'])
  })

  it('lets an addition the provider takes natively release the card too', async () => {
    const steer = vi.fn(async () => 'accepted' as const)
    const { orchestrator, chatId, gate, broker, running, context } = await asking(steer)
    await broker.post(context, questions)
    const addition = orchestrator.submitUserMessage(chatId, 'Pick A yourself.')
    await until(() => steer.mock.calls.length === 1, 'the native steer')
    gate.forChat(chatId)[0]!.finish()
    await Promise.all([running, addition])
    expect(gate.forChat(chatId)).toHaveLength(1)
  })

  it('ends the wait on Stop without another attempt', async () => {
    const { orchestrator, chatId, gate, broker, requests, running, context, sent } = await asking()
    await broker.post(context, questions)
    gate.forChat(chatId)[0]!.finish()
    await sixMinutesPass()

    orchestrator.stop(context.turnId)
    await running
    expect(gate.forChat(chatId)).toHaveLength(1)
    expect(sent.filter((message) => message.type === 'turn_state').at(-1)).not.toMatchObject({ state: 'running' })
    expect(requests).toHaveLength(1)
  })

  // The card stays answerable while the steered attempt runs, but no longer holds
  // the turn: a Session that has its answer in words must not read Working forever.
  it('lets an addition steer the waiting turn and end it', async () => {
    const { orchestrator, chatId, gate, broker, running, context } = await asking()
    await broker.post(context, questions)
    gate.forChat(chatId)[0]!.finish()
    await sixMinutesPass()

    const addition = orchestrator.submitUserMessage(chatId, 'Pick A yourself.')
    await until(() => gate.forChat(chatId).length === 2, 'the steered attempt')
    expect(gate.forChat(chatId)[1]!.input.catchUp).toContainEqual(
      expect.objectContaining({ type: 'user_message', text: 'Pick A yourself.' }),
    )
    expect(broker.waiting(context.turnId)).toBe(false)
    gate.forChat(chatId)[1]!.finish()
    await Promise.all([running, addition])
    expect(gate.forChat(chatId)).toHaveLength(2)
  })
})
