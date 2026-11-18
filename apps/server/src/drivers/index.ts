import type { AgentConfig, Driver, LiveSessionEvent, LiveSessionInfo, LiveSessionItem, ProviderUsage } from '@manor/contracts'
import { createClaudeDriver } from './claudeDriver.js'
import { createCodexDriver } from './codexDriver.js'
import { createCursorDriver } from './cursorDriver.js'
import { createGrokDriver } from './grokDriver.js'
import { createMockDriver, type MockDriverOptions } from './mockDriver.js'
import type { TurnIdleGate } from './turnTimers.js'
import type { RekeyResult } from '../capabilityRekey.js'

export type DriverResolver = (agent: AgentConfig) => Driver

export interface DriverResolverOptions {
  /** The roster as it stands right now; handed to the drivers, never read here. */
  agents: () => readonly AgentConfig[]
  /** `MANOR_DRIVER=mock` — every persona runs on the mock, whatever its config says. */
  forceMock?: boolean
  /** Shared with the ask-user broker so a blocked CLI is not killed for silence. */
  idleGate?: TurnIdleGate
  /** Spike-only lease card for the mock; see `MockDriverOptions.desktopCard`. */
  mockDesktopCard?: MockDriverOptions['desktopCard']
  /** What every driver's live sessions report between turns; see `LiveSessionEvent`. */
  onLiveSession?: (event: LiveSessionEvent) => void
  /** Moves a turn's capability to the token a live Codex process holds; see `CodexDriverOptions`. */
  rekeyCapability?: (from: string, to: string) => RekeyResult
}

export interface DriverSet {
  /** Per-persona lookup, which is all the orchestrator ever needs. */
  resolve: DriverResolver
  /**
   * The same instances, reachable by provider rather than by persona.
   *
   * House-wide capabilities live here: subscription limits belong to an account,
   * not to a chat, so asking for them through a persona would mean picking an
   * arbitrary one and would go dark the moment the roster has nobody on that
   * provider. Empty under `forceMock`, where there is no subscription to read.
   */
  byProvider: Partial<Record<ProviderUsage['provider'], Driver>>
  /**
   * Live sessions across drivers, by thread and persona. A persona keeps at most one,
   * on whichever driver ran the turn that left it, which need not be the one its
   * roster row or pin names by now.
   */
  liveSessions: {
    info(threadId: string, agentId: string): LiveSessionInfo | undefined
    /** Background work still running in live sessions, by thread, independent of the roster. */
    busyWork(): Map<string, LiveSessionItem[]>
    close(threadId: string, agentId?: string): string[]
  }
}

/**
 * The one place a persona's `driver` field becomes an implementation. Feature code
 * asks for a driver here and then only ever talks to the runtime interface.
 *
 * The five drivers are built once and live as long as the process, which is why the
 * roster reaches them as a getter: they must not close over the household as it
 * looked at startup.
 */
export function createDrivers(options: DriverResolverOptions): DriverSet {
  const mock = createMockDriver({
    agents: options.agents, desktopCard: options.mockDesktopCard,
    ...(options.onLiveSession === undefined ? {} : { onLiveSession: options.onLiveSession }),
  })
  const claude = createClaudeDriver({
    agents: options.agents, idleGate: options.idleGate,
    ...(options.onLiveSession === undefined ? {} : { onLiveSession: options.onLiveSession }),
  })
  const codex = createCodexDriver({
    agents: options.agents, idleGate: options.idleGate,
    ...(options.onLiveSession === undefined ? {} : { onLiveSession: options.onLiveSession }),
    ...(options.rekeyCapability === undefined ? {} : { rekeyCapability: options.rekeyCapability }),
  })
  const grok = createGrokDriver({ agents: options.agents, idleGate: options.idleGate })
  const cursor = createCursorDriver({ agents: options.agents, idleGate: options.idleGate })

  return {
    resolve: (agent) => {
      if (options.forceMock === true) return mock
      switch (agent.driver) {
        case 'mock':
          return mock
        case 'codex':
          return codex
        case 'grok':
          return grok
        case 'cursor':
          return cursor
        default:
          return claude
      }
    },
    // Mock runs are for UI work on a copy of real data at zero cap; reporting a real
    // subscription there would be the one number on screen that is not mocked.
    byProvider: options.forceMock === true ? {} : { claude, codex, grok, cursor },
    liveSessions: {
      info: (threadId, agentId) => {
        for (const driver of [claude, codex, mock]) {
          const info = driver.liveSession?.(threadId, agentId)
          if (info !== undefined) return info
        }
        return undefined
      },
      busyWork: () => {
        const work = new Map<string, LiveSessionItem[]>()
        for (const { threadId, running } of [claude, codex, mock].flatMap((driver) => driver.busyLiveWork?.() ?? [])) {
          work.set(threadId, [...work.get(threadId) ?? [], ...running])
        }
        return work
      },
      close: (threadId, agentId) => [claude, codex, mock].flatMap((driver) => driver.closeLiveSession?.(threadId, agentId) ?? []),
    },
  }
}

/**
 * Disposable Codex runtime for chat naming when Claude cannot, isolated from persona
 * sessions. The short budget is deliberate and stays a hard cap: naming a chat is
 * infrastructure, so it never earns the generous idle allowance a real turn gets.
 */
export function createChatTitleDriver(agents: () => readonly AgentConfig[]): Driver {
  return createCodexDriver({
    agents,
    timeoutMs: 60_000,
    invocation: { reasoningEffort: 'medium', ephemeral: true },
  })
}

/** Disposable independent permission review, with no session persisted. */
export function createEffectReviewDriver(): Driver {
  return createCodexDriver({
    agents: () => [],
    timeoutMs: 60_000,
    invocation: { reasoningEffort: 'medium', ephemeral: true },
  })
}

/** Disposable Codex runtime for the low-effort rolling-summary job. */
export function createChatSummaryDriver(agents: () => readonly AgentConfig[]): Driver {
  return createCodexDriver({
    agents,
    timeoutMs: 60_000,
    invocation: { reasoningEffort: 'low', ephemeral: true },
  })
}

/** Disposable low-effort Codex runtime for the latency-sensitive group router. */
export function createGroupTurnRouterDriver(agents: () => readonly AgentConfig[]): Driver {
  return createCodexDriver({
    agents,
    timeoutMs: 60_000,
    invocation: { reasoningEffort: 'low', ephemeral: true },
  })
}

/**
 * Disposable Claude runtime for the short text jobs: first choice for titles, commit
 * messages and Work outcomes, and the stand-in when Codex cannot answer the others,
 * so one subscription's cap or outage does not stop them. Same hard 60s cap as the
 * Codex runtimes: infrastructure never earns a real turn's allowance.
 */
export function createChatTitleFallbackDriver(agents: () => readonly AgentConfig[]): Driver {
  return createClaudeDriver({ agents, timeoutMs: 60_000 })
}

/**
 * Sonnet for the daily-log writer. Longer cap than the naming stand-in because its
 * prompt carries the whole daily file and it runs after the reply, where waiting
 * costs nobody anything.
 */
export function createMemoryWriterDriver(agents: () => readonly AgentConfig[]): Driver {
  return createClaudeDriver({ agents, timeoutMs: 180_000 })
}
