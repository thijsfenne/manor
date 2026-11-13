import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  mcpHttpUrl,
  type AgentConfig,
  type AttachedMcpServer,
  type Driver,
  type RuntimeEvent,
  type TurnHandle,
  type TurnInput,
  type Usage,
} from '@manor/contracts'
import { AsyncQueue } from '../asyncQueue.js'
import { runtimeVersion } from './runtimeVersion.js'
import { parseCursorAccount, runStatusCommand } from './providerAccount.js'
import {
  agentTurnEnv,
  appendChildErrorTail,
  attachedMcpEnvironment,
  childProcessEnv,
  resolveCliCommand,
  redactGrantedEnvValues,
} from '../childEnv.js'
import { catchUpStyle, composeCatchUp } from '../composer.js'
import { mcpBearerEnvKey } from '../mcp/oauth.js'
import { mcpHttpHeaderEnvMap } from '../mcp/httpHeaders.js'
import { RESUME_FAILURE_PREFIX } from './resumeFailure.js'
import { describeCommand } from './commands.js'
import { describeMcpTool, describeTool, errorText, redactToolActivity } from './toolActivity.js'
import { editsFromCursorToolCall, withEditOrigins } from './edits.js'
import { todosFromCursorCall } from './todos.js'
import { collectGeneratedImages } from './generatedImages.js'
import { readCursorProviderUsage } from './cursorUsage.js'
import {
  DEFAULT_BACKGROUND_HOLD_MS,
  backgroundCapNote,
  bindIdleClock,
  resolveTurnTimeouts,
  startTurnTimers,
  watchInFlightTools,
  type TurnIdleGate,
} from './turnTimers.js'
import { isRetryableProviderTransportError } from './retryableTransport.js'
import { createResumedContext } from './resumedContext.js'
import { cliShutdownStarted, terminateCliTree, trackCliChild } from './childTermination.js'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
const asNumber = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined)

export interface CursorSpawnOptions {
  cwd: string
  env: NodeJS.ProcessEnv
}

export interface CursorChildLike {
  readonly pid?: number
  readonly stdout: NodeJS.ReadableStream | null
  readonly stderr: NodeJS.ReadableStream | null
  readonly stdin: NodeJS.WritableStream | null
  kill(signal?: NodeJS.Signals): boolean
  on(event: 'close', listener: (code: number | null) => void): void
  on(event: 'error', listener: (error: Error) => void): void
}

export type CursorSpawnFn = (
  command: string,
  args: readonly string[],
  options: CursorSpawnOptions,
) => CursorChildLike

export interface CursorDriverOptions {
  agents: () => readonly AgentConfig[]
  command?: string
  timeoutMs?: number
  idleTimeoutMs?: number
  /** Time for a finished CLI to exit before its result settles without it. */
  resultGraceMs?: number
  spawnFn?: CursorSpawnFn
  idleGate?: TurnIdleGate
  /** Longest the CLI may wait silently on its own background work; 30 minutes by default. */
  backgroundHoldMs?: number
}

const defaultSpawn: CursorSpawnFn = (command, args, options) =>
  spawn(command, [...args], { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true })

// ---------------------------------------------------------------------------
// Isolation and persona workspace
// ---------------------------------------------------------------------------

/**
 * Cursor keeps login separately from its CLI config on macOS. Pointing
 * CURSOR_CONFIG_DIR at this empty Manor-owned directory therefore preserves the
 * subscription login while excluding ~/.cursor/mcp.json and CLI permissions. A live
 * 2026.08.11 smoke confirmed both sides: authenticated, and no ambient MCP config.
 */
export async function ensureCursorConfigDir(): Promise<string> {
  const dir = process.env.MANOR_CURSOR_CONFIG_DIR ?? path.join(os.homedir(), '.manor', 'cursor-config')
  await mkdir(dir, { recursive: true })
  return dir
}

/** Cursor reads both files from its workspace; only AGENTS.md carries the persona. */
export async function ensureCursorAgentDir(
  cwd: string,
  agent: AgentConfig,
  attached: readonly AttachedMcpServer[],
  singleSession = false,
): Promise<string> {
  const dir = path.join(cwd, agent.id.replace(/[^a-zA-Z0-9_-]/g, '_'))
  const cursorDir = path.join(dir, '.cursor')
  await mkdir(cursorDir, { recursive: true })
  await writeFile(path.join(dir, 'AGENTS.md'), `${agent.character}\n`, 'utf8')
  await writeFile(path.join(cursorDir, 'mcp.json'), buildCursorMcpConfig(attached), 'utf8')
  if (singleSession) {
    const helpersDir = path.join(cursorDir, 'agents')
    await mkdir(helpersDir, { recursive: true })
    await writeFile(path.join(helpersDir, 'manor-helper.md'), [
      '---',
      'name: manor-helper',
      'description: General-purpose helper for a bounded delegated task.',
      'model: inherit',
      '---',
      'Complete the task supplied by the parent and return the result. Do not spawn further helpers.',
      '',
    ].join('\n'), 'utf8')
  }
  return dir
}

/**
 * Cursor has no documented per-tool MCP exclusion. Silently passing a server with
 * excluded write tools would widen access, so that state is refused until Cursor or
 * a Manor filtering proxy can enforce it.
 */
export function buildCursorMcpConfig(attached: readonly AttachedMcpServer[]): string {
  const excluded = attached.find(({ disabledTools }) => disabledTools.length > 0)
  if (excluded !== undefined) {
    throw new Error(
      `Cursor cannot enforce disabled MCP tools for ${excluded.server.name}; attach it without exclusions or use another provider`,
    )
  }

  const mcpServers = Object.fromEntries(attached.map(({ server, runtimeEnv }) => {
    const url = mcpHttpUrl(server)
    if (url !== undefined) {
      const bearerKey = mcpBearerEnvKey(server.name)
      const bearer = runtimeEnv?.[bearerKey]
      const headers = Object.fromEntries(
        Object.entries(mcpHttpHeaderEnvMap(server)).map(([name, envKey]) => [name, `\${env:${envKey}}`]),
      )
      if (bearer !== undefined) headers.Authorization = `Bearer \${env:${bearerKey}}`
      return [
        server.name,
        {
          type: 'http',
          url,
          ...(Object.keys(headers).length === 0 ? {} : { headers }),
        },
      ]
    }
    const envKeys = [...new Set([...server.envKeys, ...Object.keys(runtimeEnv ?? {})])]
    return [
      server.name,
      {
        type: 'stdio',
        command: server.command,
        ...(server.args.length === 0 ? {} : { args: server.args }),
        ...(envKeys.length === 0
          ? {}
          : { env: Object.fromEntries(envKeys.map((key) => [key, `\${env:${key}}`])) }),
      },
    ]
  }))
  return `${JSON.stringify({ mcpServers }, null, 2)}\n`
}

// ---------------------------------------------------------------------------
// Model and argv mapping
// ---------------------------------------------------------------------------

/** Manor's stable model ids to the effort-shaped ids exposed by `agent --list-models`. */
export function cursorCliModel(
  model: string | undefined,
  effort: AgentConfig['effort'],
  speed: TurnInput['speed'] = undefined,
): string | undefined {
  if (model === undefined) return undefined
  const fast = speed === 'fast' ? '-fast' : ''
  switch (model) {
    case 'cursor-grok-4.6':
      return `cursor-grok-4.6-${effort === 'max' ? 'xhigh' : effort}${fast}`
    case 'cursor-grok-4.7':
      return `grok-4.7-${effort === 'max' ? 'xhigh' : effort}${fast}`
    case 'cursor-composer-2.5':
      return `composer-2.5${fast}`
    case 'cursor-muse-spark-1.3':
      return `muse-spark-1.3-${effort}`
    case 'cursor-muse-wonder-1.0':
      return `muse-wonder-1.0-${effort}`
    case 'cursor-claude-opus-5':
      return `claude-opus-5-thinking-${effort}${fast}`
    case 'cursor-claude-opus-5-5':
      return `claude-opus-5-5-${effort}${fast}`
    case 'cursor-claude-sonnet-5-5':
      return `claude-sonnet-5-5-${effort}`
    case 'cursor-gpt-5.6-luna':
      return `gpt-5.6-luna-${effort}${fast}`
    case 'cursor-gpt-5.6-sol':
      return `gpt-5.6-sol-${effort}${fast}`
    case 'cursor-claude-fable-5-1':
      return `claude-fable-5-1-thinking-${effort}`
    case 'cursor-claude-fable-5-2':
      return `claude-fable-5-2-${effort}`
    case 'cursor-gemini-3.8-flash':
      return `gemini-3.8-flash-${effort === 'xhigh' || effort === 'max' ? 'high' : effort}`
    case 'cursor-kimi-k3':
      return `kimi-k3-${effort === 'medium' || effort === 'xhigh' ? 'high' : effort}`
    case 'cursor-glm-5.2':
      return `glm-5.2-${effort === 'max' ? 'max' : 'high'}`
    default:
      return model
  }
}

export function buildCursorArgs(input: TurnInput, workDir: string): string[] {
  const args = [
    '--print',
    '--trust',
    '--output-format',
    'stream-json',
    '--stream-partial-output',
    '--approve-mcps',
    '--workspace',
    workDir,
  ]
  const model = cursorCliModel(input.agent.model, input.agent.effort, input.speed)
  if (model !== undefined) args.push('--model', model)
  for (const repoPath of input.repoPaths) args.push('--add-dir', repoPath)

  // Cursor's non-interactive Ask mode may discover an MCP write and even choose it,
  // but then refuses to call it because nobody can approve the prompt. An attached
  // server marked writable is explicit authority for this turn, the same boundary as
  // a persona tool or linked folder, so it must start in Agent mode too.
  const acts =
    input.manorFollowUp === true ||
    input.repoPaths.length > 0 ||
    input.agent.allowedTools.length > 0 ||
    (input.mcpServers ?? []).some(({ server }) => server.writes)
  if (acts) args.push('--force', '--sandbox', 'disabled')
  else args.push('--mode', 'ask', '--sandbox', 'enabled')
  if (input.sessionId !== undefined) args.push('--resume', input.sessionId)
  return args
}

// ---------------------------------------------------------------------------
// Stream parser
// ---------------------------------------------------------------------------

const textContent = (raw: unknown): string | undefined => {
  if (!isRecord(raw)) return undefined
  const content = raw['content']
  if (!Array.isArray(content)) return undefined
  const pieces = content.flatMap((part) => {
    if (!isRecord(part) || part['type'] !== 'text') return []
    const text = asString(part['text'])
    return text === undefined ? [] : [text]
  })
  return pieces.length === 0 ? undefined : pieces.join('')
}

const cursorUsage = (raw: unknown): Usage | undefined => {
  if (!isRecord(raw)) return undefined
  const inputTokens = asNumber(raw['inputTokens'])
  const cacheReadTokens = asNumber(raw['cacheReadTokens'])
  const cacheWriteTokens = asNumber(raw['cacheWriteTokens'])
  const outputTokens = asNumber(raw['outputTokens'])
  if (
    inputTokens === undefined &&
    cacheReadTokens === undefined &&
    cacheWriteTokens === undefined &&
    outputTokens === undefined
  ) return undefined
  return {
    inputTokens: (inputTokens ?? 0) + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0),
    outputTokens: outputTokens ?? 0,
  }
}

const cursorTool = (raw: unknown) => {
  if (!isRecord(raw)) return { tool: 'Cursor' }
  const entry = Object.entries(raw).find(([key, value]) => key.endsWith('ToolCall') && isRecord(value))
  if (entry === undefined) return { tool: 'Cursor' }
  const [kind, value] = entry as [string, Record<string, unknown>]
  const args = isRecord(value['args']) ? value['args'] : {}
  const description = asString(value['description'])
  const command = asString(args['command'])
  if (kind === 'shellToolCall' && command !== undefined) return describeCommand(command, undefined, description ?? asString(args['description']))

  if (kind === 'mcpToolCall') {
    return describeMcpTool(args['serverIdentifier'] ?? args['providerIdentifier'], args['toolName'] ?? args['name'], args['args'])
  }
  const names: Record<string, string> = {
    readToolCall: 'Read',
    writeToolCall: 'Edit',
    editToolCall: 'Edit',
    applyPatchToolCall: 'Edit',
    grepToolCall: 'Search',
    globToolCall: 'Search',
    webSearchToolCall: 'WebSearch',
    webFetchToolCall: 'WebFetch',
    mcpToolCall: 'MCP',
  }
  const fallback = kind.replace(/ToolCall$/, '').replace(/^./, (letter) => letter.toUpperCase())
  const activity = describeTool(names[kind] ?? fallback, args)
  return activity.detail === undefined && activity.subject === undefined && description !== undefined
    ? { ...activity, detail: description }
    : activity
}

const toolCallBody = (raw: unknown): Record<string, unknown> | undefined => {
  if (!isRecord(raw)) return undefined
  const call = Object.entries(raw).find(([key, value]) => key.endsWith('ToolCall') && isRecord(value))?.[1]
  return isRecord(call) ? call : undefined
}

/** A call its own arguments already send to the background, as a shell's do. */
const launchesBackground = (raw: unknown): boolean => {
  const args = toolCallBody(raw)?.['args']
  return isRecord(args) && args['isBackground'] === true
}

/**
 * The task a tool call moved to the background, keyed by the id its later
 * `task_notification` names: `shellId` for a shell, `agentId` for a helper.
 * Probed on cursor-agent 2026.10.01-14929f9.
 */
const backgroundTask = (raw: unknown): { id: string; name: string; kind: 'agent' | 'command' } | undefined => {
  const call = toolCallBody(raw)
  if (call === undefined || !isRecord(call['result'])) return undefined
  const success = isRecord(call['result']['success']) ? call['result']['success'] : {}
  if (call['result']['isBackground'] !== true && success['isBackground'] !== true) return undefined
  const shell = success['shellId']
  const id = shell ?? success['agentId']
  if (typeof id !== 'string' && typeof id !== 'number') return undefined
  const args = isRecord(call['args']) ? call['args'] : {}
  return {
    id: String(id),
    name: asString(args['command']) ?? asString(args['description']) ?? 'background task',
    kind: shell === undefined ? 'agent' : 'command',
  }
}

/** How a `task_notification` status settles the launch row; an unknown one is no success. */
const notifiedOutcome = (status: unknown, launched: 'success' | 'error'): 'success' | 'error' | 'stopped' => {
  if (status === 'success' || status === 'completed') return launched
  if (status === 'stopped' || status === 'killed' || status === 'cancelled' || status === 'aborted') return 'stopped'
  return 'error'
}

/** A finished call's `result`, at the top level or inside its `*ToolCall` entry. */
const toolResult = (raw: unknown): Record<string, unknown> | undefined => {
  if (!isRecord(raw)) return undefined
  if (isRecord(raw['result'])) return raw['result']
  const entry = Object.values(raw).find((value) => isRecord(value) && isRecord(value['result']))
  return isRecord(entry) && isRecord(entry['result']) ? entry['result'] : undefined
}

const toolSucceeded = (raw: unknown): boolean => {
  const result = toolResult(raw)
  return result === undefined || !('error' in result)
}

/** The failed call's own `result.error`, read from the same result that decided the outcome. */
const toolError = (raw: unknown): string | undefined => {
  const result = toolResult(raw)
  return result === undefined ? undefined : errorText(result['error'])
}

export class CursorStreamParser {
  sessionId: string | undefined
  sawInit = false
  private messageIndex = 0
  private messageId: string | undefined
  private messageText = ''
  private readonly runningTools = new Set<string>()
  private readonly writeExistedBefore = new Map<string, boolean>()
  private sawTool = false
  /**
   * Background shells and helpers the turn started, by task id. The CLI waits for
   * them before its result without printing anything, so the driver must not read
   * that silence as a hang; their `task_notification` ends the wait. Each keeps its
   * launch row's result until then, so the row runs while the work does.
   */
  readonly backgroundTasks = new Map<string, {
    name: string
    kind: 'agent' | 'command'
    result: Extract<RuntimeEvent, { type: 'tool_result' }>
  }>()
  /** Launches announced as background work at their start. */
  private readonly backgroundStarts = new Set<string>()
  /** The last top-level line was a finished answer: the CLI is only waiting now. */
  private answered = false
  private lastTodoSnapshot: string | undefined

  constructor(
    private readonly requestedModel?: string,
    private readonly pathExists?: (target: string) => boolean,
    private readonly observedSpeed?: 'fast',
  ) {}

  errorEvent(
    message: string,
    usage?: Usage,
  ): Extract<RuntimeEvent, { type: 'error' }> {
    if (!isRetryableProviderTransportError(message) || this.sessionId === undefined) {
      return { type: 'error', message }
    }
    return {
      type: 'error',
      message,
      retryable: true,
      sessionId: this.sessionId,
      ...(usage === undefined ? {} : { usage }),
    }
  }

  handle(line: string): RuntimeEvent[] {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      return []
    }
    if (!isRecord(parsed)) return []
    const parentToolCallId = asString(parsed['parent_tool_use_id'])
    if (parentToolCallId !== undefined && parsed['type'] !== 'tool_call') return []
    if (parentToolCallId === undefined) this.sessionId = asString(parsed['session_id']) ?? this.sessionId
    const type = asString(parsed['type'])
    if (parentToolCallId === undefined && type !== 'system') this.answered = false

    switch (type) {
      case 'system': {
        if (parsed['subtype'] === 'init') this.sawInit = true
        if (parsed['subtype'] !== 'task_notification') return []
        const taskId = String(parsed['task_id'])
        const task = this.backgroundTasks.get(taskId)
        if (task === undefined) return []
        this.backgroundTasks.delete(taskId)
        const { error: launchError, ...launched } = task.result
        const outcome = notifiedOutcome(parsed['status'], launched.outcome === 'error' ? 'error' : 'success')
        const error = outcome === 'error' ? errorText(parsed['detail']) ?? launchError : undefined
        return [{ ...launched, outcome, ...(error === undefined ? {} : { error }) }]
      }
      case 'thinking':
        return []
      case 'assistant': {
        const text = textContent(parsed['message'])
        if (text === undefined) return []
        const partial = parsed['timestamp_ms'] !== undefined && parsed['model_call_id'] === undefined
        if (!partial && parentToolCallId === undefined) this.answered = true
        if (partial) {
          const messageId = this.ensureMessageId()
          this.messageText += text
          return [{ type: 'delta', messageId, text }]
        }
        return this.finishMessage(text)
      }
      case 'tool_call': {
        this.sawTool = true
        // The plan is the turn's own card, like Claude's TodoWrite: no tool row beside it.
        // A helper's plan stays inside the helper.
        const plan = isRecord(parsed['tool_call']) ? parsed['tool_call']['updateTodosToolCall'] : undefined
        if (plan !== undefined) return parentToolCallId === undefined ? this.todoUpdate(plan) : []
        const callId = asString(parsed['call_id']) ?? asString(parsed['toolCallId'])
        const activity = cursorTool(parsed['tool_call'])
        if (parsed['subtype'] === 'started') {
          if (callId !== undefined) {
            this.runningTools.add(callId)
            if (
              this.pathExists !== undefined &&
              isRecord(parsed['tool_call']) &&
              isRecord(parsed['tool_call']['writeToolCall'])
            ) {
              const target = activity.targets?.[0]
              if (target !== undefined) this.writeExistedBefore.set(callId, this.pathExists(target))
            }
          }
          const background = parentToolCallId === undefined && callId !== undefined && launchesBackground(parsed['tool_call'])
          if (background) this.backgroundStarts.add(callId)
          return [{
            type: 'tool_use',
            ...(callId === undefined ? {} : { toolCallId: callId }),
            ...(parentToolCallId === undefined ? {} : { parentToolCallId }),
            ...activity,
            ...(background ? { background: true } : {}),
          }]
        }
        if (parsed['subtype'] !== 'completed' || callId === undefined) return []
        const background = parentToolCallId === undefined ? backgroundTask(parsed['tool_call']) : undefined
        const hadStart = this.runningTools.delete(callId)
        const existedBefore = this.writeExistedBefore.get(callId)
        this.writeExistedBefore.delete(callId)
        const result: RuntimeEvent = {
          type: 'tool_result',
          toolCallId: callId,
          ...(parentToolCallId === undefined ? {} : { parentToolCallId }),
          outcome: toolSucceeded(parsed['tool_call']) ? 'success' : 'error',
        }
        if (result.outcome === 'success') {
          const edits = editsFromCursorToolCall(parsed['tool_call'], existedBefore)
          if (edits !== undefined) result.edits = edits
        } else {
          const error = toolError(parsed['tool_call'])
          if (error !== undefined) result.error = error
        }
        if (background !== undefined) {
          // The call returned its receipt; the row settles at the task's notification.
          this.backgroundTasks.set(background.id, { name: background.name, kind: background.kind, result })
          const announced = this.backgroundStarts.delete(callId)
          return hadStart && announced
            ? []
            : [{ type: 'tool_use', toolCallId: callId, ...activity, background: true }]
        }
        return hadStart
          ? [result]
          : [{ type: 'tool_use', toolCallId: callId, ...(parentToolCallId === undefined ? {} : { parentToolCallId }), ...activity }, result]
      }
      case 'result': {
        const leading = this.finishMessage()
        const usage = cursorUsage(parsed['usage'])
        if (parsed['is_error'] === true || parsed['subtype'] === 'error') {
          const message = asString(parsed['result']) ?? 'Cursor reported a failed turn'
          return [...leading, this.errorEvent(message, usage)]
        }
        const result: Extract<RuntimeEvent, { type: 'result' }> = {
          type: 'result',
          text: asString(parsed['result']) ?? '',
        }
        if (usage !== undefined) {
          result.usage = usage
          if (!this.sawTool) result.contextTokens = usage.inputTokens
        }
        const reportedModel = this.requestedModel ?? asString(parsed['model'])
        if (reportedModel !== undefined) result.reportedModel = reportedModel
        // Cursor exposes Fast as a distinct catalogue model rather than a response
        // tier. Reaching a successful result proves the accepted invocation used
        // that advertised `-fast` id; an invalid or unavailable id fails above.
        if (this.observedSpeed !== undefined) result.observedSpeed = this.observedSpeed
        if (this.sessionId !== undefined) result.sessionId = this.sessionId
        return [...leading, result]
      }
      default:
        return []
    }
  }

  /** What the CLI waits on once it answered, or nothing while it still works. */
  backgroundWait(): { agents: number; commands: number } {
    if (!this.answered) return { agents: 0, commands: 0 }
    let agents = 0
    for (const task of this.backgroundTasks.values()) if (task.kind === 'agent') agents += 1
    return { agents, commands: this.backgroundTasks.size - agents }
  }

  /** The turn is going down with its process: every launch row still open settles as stopped. */
  stopOpenBackground(): Extract<RuntimeEvent, { type: 'tool_result' }>[] {
    const open = [...this.backgroundTasks.values()].map(({ result }) => ({ ...result, outcome: 'stopped' as const }))
    this.backgroundTasks.clear()
    return open
  }

  /** The started and completed lines of one replacing call carry the same list; it publishes once. */
  private todoUpdate(call: unknown): RuntimeEvent[] {
    const todos = todosFromCursorCall(call)
    if (todos === undefined) return []
    const snapshot = JSON.stringify(todos)
    if (snapshot === this.lastTodoSnapshot) return []
    this.lastTodoSnapshot = snapshot
    return [{ type: 'todo_update', todos }]
  }

  private ensureMessageId(): string {
    if (this.messageId !== undefined) return this.messageId
    this.messageIndex += 1
    this.messageId = `cursor_message_${this.messageIndex}`
    return this.messageId
  }

  private finishMessage(authoritative?: string): RuntimeEvent[] {
    const text = authoritative ?? this.messageText
    if (text.length === 0) return []
    const messageId = this.ensureMessageId()
    const events: RuntimeEvent[] = []
    if (this.messageText.length === 0) events.push({ type: 'delta', messageId, text })
    events.push({ type: 'message', messageId, text })
    this.messageId = undefined
    this.messageText = ''
    return events
  }

}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

/**
 * Cursor installs its CLI as both `cursor-agent` and `agent`. Grok also ships a
 * binary called `agent`, and whichever directory comes first on PATH wins that name,
 * so the unambiguous one is tried first (seen 2026-11-10: `agent` answered as Grok).
 */
export function resolveCursorCommand(env: NodeJS.ProcessEnv = process.env): string {
  const named = resolveCliCommand('cursor-agent', env)
  return path.isAbsolute(named) ? named : resolveCliCommand('agent', env)
}

/** Subscription-authenticated Cursor Agent CLI, one headless process per turn. */
export function createCursorDriver(options: CursorDriverOptions): Driver {
  const command = options.command ?? resolveCursorCommand()
  const spawnFn = options.spawnFn ?? defaultSpawn
  const timeouts = resolveTurnTimeouts(options)
  // Both keep their startup instructions across a resume, so a changed persona is resent.
  const prepareContext = createResumedContext({ retainsCharacter: true })

  const accountEnv = async () => childProcessEnv(process.env, [], { CURSOR_CONFIG_DIR: await ensureCursorConfigDir() })

  return {
    describeRuntime: () => runtimeVersion(command),
    describeAccount: async () => parseCursorAccount(await runStatusCommand(command, ['status'], await accountEnv())),
    signInCommand: async () => ({ command, args: ['login'], env: await accountEnv() }),
    readProviderUsage: () => readCursorProviderUsage(),
    // No `compactSession`: `/compress` in print mode is a prompt to the model, which
    // writes a summary into the session and shrinks nothing. Manor rolls over instead.

    startTurn(input: TurnInput): TurnHandle {
      const context = prepareContext(input)
      return runTurn(
        input,
        composeCatchUp({
          events: input.catchUp,
          ...(input.catchUpSummary === undefined ? {} : { summary: input.catchUpSummary }),
          agents: options.agents(),
          isFullCatchUp: input.isFullCatchUp,
          ...catchUpStyle(input),
          repoPaths: input.repoPaths,
          ...(input.repoAccess === undefined ? {} : { repoAccess: input.repoAccess }),
          ...(context.contextBlock === undefined ? {} : { contextBlock: context.contextBlock }),
          imagePaths: input.imagePaths ?? [],
        }),
        context,
      )
    },
  }

  function runTurn(
    input: TurnInput,
    prompt: string,
    context: { confirm(sessionId: string | undefined): void },
  ): TurnHandle {
      const queue = new AsyncQueue<RuntimeEvent>()
      let workDir: string | undefined
      const selectedModel = cursorCliModel(input.agent.model, input.agent.effort, input.speed)
      const parser = new CursorStreamParser(
        input.agent.model,
        (target) => existsSync(path.isAbsolute(target) ? target : path.resolve(workDir ?? input.cwd, target)),
        selectedModel?.endsWith('-fast') === true ? 'fast' : undefined,
      )
      const startedAt = Date.now()
      const { sourceEnv, grantedKeys } = attachedMcpEnvironment(input.mcpServers ?? [])
      const redact = (message: string) => redactGrantedEnvValues(message, sourceEnv, grantedKeys)

      let child: CursorChildLike | undefined
      let stopped = false
      let settled = false
      let sawTerminalLine = false
      let sawError = false
      let pendingResult: Extract<RuntimeEvent, { type: 'result' }> | undefined
      let stderr = ''
      let buffer = ''
      let settlingTerminal = false
      let resultGrace: NodeJS.Timeout | undefined
      let termination: Promise<void> | undefined
      let terminationReady = false
      /** The CLI waits silently on its own background work: the idle clock stays paused until it ends. */
      let idleWaitingOnBackground = false
      let backgroundCap: NodeJS.Timeout | undefined
      /** The wait the client was last told about, so each change is sent once. */
      let shownWait = { agents: 0, commands: 0 }
      /** Open launch rows settle as stopped: the turn's end takes their process down. */
      const closeOpenRows = () => {
        for (const event of parser.stopOpenBackground()) queue.push(redactToolActivity(event, redact))
      }
      const killChild = () => {
        termination ??= terminateCliTree(child).then(() => { terminationReady = true })
      }

      const finish = () => {
        if (settled) return
        if (termination !== undefined && !terminationReady) {
          void termination.then(finish)
          return
        }
        settled = true
        if (resultGrace !== undefined) clearTimeout(resultGrace)
        if (backgroundCap !== undefined) clearTimeout(backgroundCap)
        timers.clear()
        queue.close()
      }

      const settleTerminal = async (code?: number | null) => {
        if (settled || stopped || settlingTerminal) return
        settlingTerminal = true
        try {
          closeOpenRows()
          if (pendingResult !== undefined) {
            if (workDir !== undefined) {
              for (const image of await collectGeneratedImages([workDir], startedAt)) {
                queue.push({ type: 'attachment', image })
              }
            }
            if (!stopped && code === 0 && !sawError) context.confirm(pendingResult.sessionId)
            queue.push(pendingResult)
            pendingResult = undefined
          }
        } finally {
          finish()
        }
      }

      const fail = (message: string) => {
        if (settled || stopped) return
        closeOpenRows()
        if (pendingResult !== undefined) queue.push(pendingResult)
        pendingResult = undefined
        queue.push(parser.errorEvent(redact(message)))
        finish()
      }

      const consume = (line: string) => {
        timers.touch()
        const parsedEvents = parser.handle(line)
        if (parser.sessionId !== undefined) input.onStage?.('threadReady')
        for (const event of parsedEvents) {
          toolIdle.see(event)
          const located = event.type === 'tool_result' && event.edits !== undefined && workDir !== undefined
            ? { ...event, edits: withEditOrigins(event.edits, workDir, input.repoPaths) } : event
          const safeEvent =
            located.type === 'error'
              ? { ...located, message: redact(located.message) }
              : located.type === 'tool_use' || located.type === 'tool_result'
                ? redactToolActivity(located, redact)
                : located
          if (safeEvent.type === 'result') {
            sawTerminalLine = true
            pendingResult = safeEvent
          } else {
            if (safeEvent.type === 'error') {
              sawTerminalLine = true
              sawError = true
            }
            queue.push(safeEvent)
          }
          if (sawTerminalLine && resultGrace === undefined) {
            resultGrace = setTimeout(() => {
              killChild()
              void settleTerminal()
            }, options.resultGraceMs ?? 2_000)
            resultGrace.unref?.()
          }
        }
        if (parser.backgroundTasks.size > 0 && !idleWaitingOnBackground) waitOnBackground()
        else if (parser.backgroundTasks.size === 0 && idleWaitingOnBackground) {
          idleWaitingOnBackground = false
          if (backgroundCap !== undefined) clearTimeout(backgroundCap)
          backgroundCap = undefined
          if (!toolIdle.busy() && options.idleGate?.held(input.threadId, input.agent.id) !== true) clock.resume()
        }
        // While the CLI only waits, the client shows what it waits on instead of Working.
        const wait = sawTerminalLine ? { agents: 0, commands: 0 } : parser.backgroundWait()
        if (wait.agents !== shownWait.agents || wait.commands !== shownWait.commands) {
          shownWait = wait
          queue.push({ type: 'background_wait', ...wait })
        }
      }

      /**
       * Cursor holds its own result until its background work ends, so nothing is
       * lost at the result; only Manor's idle clock could kill that wait. It stays
       * paused while the work runs. A room that wakes sets no cap, the way a live
       * session has none; a turn somebody waits on as one answer keeps the hold's cap.
       */
      const waitOnBackground = () => {
        idleWaitingOnBackground = true
        clock.pause()
        if (input.live === true) return
        const holdMs = options.backgroundHoldMs ?? DEFAULT_BACKGROUND_HOLD_MS
        backgroundCap = setTimeout(() => {
          killChild()
          fail(backgroundCapNote(holdMs, [...parser.backgroundTasks.values()].map((task) => task.name), 'Cursor'))
        }, holdMs)
        backgroundCap.unref?.()
      }

      const clock = startTurnTimers(timeouts, (message) => {
        killChild()
        const resumeFailed = input.sessionId !== undefined && !parser.sawInit
        fail(resumeFailed ? `${RESUME_FAILURE_PREFIX}${message}` : message)
      })
      // Neither a closing tool nor an answered ask-user may restart the clock a background wait paused.
      const timers = bindIdleClock(options.idleGate, input.threadId, input.agent.id, {
        ...clock,
        resume: () => { if (!idleWaitingOnBackground) clock.resume() },
      })
      const toolIdle = watchInFlightTools(timers)

      void (async () => {
        let env: NodeJS.ProcessEnv
        try {
          const configDir = await ensureCursorConfigDir()
          workDir = await ensureCursorAgentDir(input.cwd, input.agent, input.mcpServers ?? [], input.singleSession === true)
          env = agentTurnEnv(sourceEnv, grantedKeys, { CURSOR_CONFIG_DIR: configDir })
        } catch (error: unknown) {
          fail(`could not prepare the ${command} workspace: ${(error as Error).message}`)
          return
        }
        if (stopped || settled) return
        if (cliShutdownStarted()) {
          fail('server is shutting down')
          return
        }

        let spawned: CursorChildLike
        try {
          spawned = spawnFn(command, buildCursorArgs(input, workDir), { cwd: workDir, env })
        } catch (error: unknown) {
          fail(`could not start ${command}: ${error instanceof Error ? error.message : String(error)}`)
          return
        }
        child = spawned
        trackCliChild(spawned)
        input.onStage?.('processStarted')

        spawned.stdout?.setEncoding?.('utf8')
        // A slow consumer pauses this stdout instead of buffering without limit.
        queue.throttle(spawned.stdout)
        spawned.stdout?.on('data', (chunk: string | Buffer) => {
          buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            if (line.trim().length > 0) consume(line)
          }
        })

        spawned.stderr?.setEncoding?.('utf8')
        spawned.stderr?.on('data', (chunk: string | Buffer) => {
          stderr = appendChildErrorTail(
            stderr,
            typeof chunk === 'string' ? chunk : chunk.toString('utf8'),
            redact,
          )
        })

        spawned.on('error', (error: Error) => fail(`could not start ${command}: ${error.message}`))
        spawned.stdin?.on('error', (error: Error) => fail(`could not write to ${command} stdin: ${error.message}`))
        spawned.on('close', (code: number | null) => {
          void (async () => {
            if (buffer.trim().length > 0) {
              consume(buffer)
              buffer = ''
            }
            if (stopped || settled) return
            if (sawTerminalLine) {
              await settleTerminal(code)
              return
            }
            const detail = stderr.trim().length > 0 ? stderr.trim() : `exit code ${code ?? 'unknown'}`
            const resumeFailed = input.sessionId !== undefined && !parser.sawInit
            fail(resumeFailed ? `${RESUME_FAILURE_PREFIX}${detail}` : detail)
          })()
        })

        spawned.stdin?.end(prompt)
      })()

      return {
        events: queue,
        stop() {
          if (!settled && !stopped) closeOpenRows()
          stopped = true
          killChild()
          finish()
        },
      }
  }
}
