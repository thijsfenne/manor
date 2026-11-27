import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute } from 'node:path'
import {
  REASONING_LIMIT,
  SUBAGENT_TEXT_MAX,
  WAKE_TITLE_MAX,
  apiPricedInputEquivalent,
  mcpHttpUrl,
  type AgentConfig,
  type AttachedMcpServer,
  type Driver,
  type LiveSessionEvent,
  type RuntimeEvent,
  type TurnHandle,
  type ThreadEvent,
  type TurnInput,
  type Usage,
  type UsageBreakdown,
} from '@manor/contracts'
import { AsyncQueue } from '../asyncQueue.js'
import { runtimeVersion } from './runtimeVersion.js'
import { parseClaudeAccount, runStatusCommand } from './providerAccount.js'
import { checkAgainstNpm, runUpdater } from './providerUpdate.js'
import {
  agentTurnEnv,
  appendChildErrorTail,
  attachedMcpEnvironment,
  childProcessEnv,
  resolveCliCommand,
  redactGrantedEnvValues,
} from '../childEnv.js'
import { catchUpStyle, composeCatchUp } from '../composer.js'
import { scrubCredentialText } from '../store.js'
import { readClaudeProviderUsage } from './claudeUsage.js'
import { describeCommand } from './commands.js'
import { describeTool, errorText, redactToolActivity, subagentLaunch, subagentOutput } from './toolActivity.js'
import { editsFromToolInput, withEditOrigins } from './edits.js'
import { collectGeneratedImages } from './generatedImages.js'
import { CLAUDE_COMPACT_COMMAND, compactTurnInput } from './sessionCompact.js'
import { createResumedContext, type PreparedContext } from './resumedContext.js'
import {
  DEFAULT_BACKGROUND_HOLD_MS,
  backgroundCapNote,
  bindIdleClock,
  resolveTurnTimeouts,
  startTurnTimers,
  watchInFlightTools,
  type TurnIdleGate,
} from './turnTimers.js'
import { BUILT_IN_INTERACTION_MCP_NAME } from '../mcp/interactionAttachment.js'
import { mcpBearerEnvKey } from '../mcp/oauth.js'
import { mcpHttpHeaderEnvMap } from '../mcp/httpHeaders.js'
import { todosFromToolInput } from './todos.js'
import { cliShutdownStarted, isSignallableGroupPid, terminateCliTree, trackCliChild } from './childTermination.js'
import { RESUME_FAILURE_PREFIX } from './resumeFailure.js'

/** The bits of a spawned process this driver touches; narrow so tests can fake it. */
export interface ChildLike {
  readonly pid?: number
  readonly stdout: NodeJS.ReadableStream | null
  readonly stderr: NodeJS.ReadableStream | null
  readonly stdin: NodeJS.WritableStream | null
  kill(signal?: NodeJS.Signals): boolean
  on(event: 'close', listener: (code: number | null) => void): void
  on(event: 'error', listener: (error: Error) => void): void
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => ChildLike

export interface ClaudeDriverOptions {
  /**
   * The roster as it stands right now, needed to label other personas in the
   * catch-up block. A function rather than a list because personas are edited while
   * the server runs, and a driver built once at startup would keep labelling the
   * thread with names that changed hours ago.
   */
  agents: () => readonly AgentConfig[]
  command?: string
  /** Overall cap for one turn; see `resolveTurnTimeouts` for the two clocks. */
  timeoutMs?: number
  /** Longest silence tolerated between two runtime events. */
  idleTimeoutMs?: number
  /** Time for a finished CLI to exit before its result settles without it. */
  resultGraceMs?: number
  spawnFn?: SpawnFn
  /** Pauses this turn's idle clock while ask-user is waiting. */
  idleGate?: TurnIdleGate
  /** How long a steering message may wait for the CLI to report it queued. */
  steeringTimeoutMs?: number
  /** Longest a finished turn waits for its own background tasks; 30 minutes by default. */
  backgroundHoldMs?: number
  /** What a live session reports while no turn of its persona runs; see `LiveSessionEvent`. */
  onLiveSession?: (event: LiveSessionEvent) => void
  signalGroup?: SignalGroupFn
}

type ResultEvent = Extract<RuntimeEvent, { type: 'result' }>

/**
 * One result for runs the CLI split. Tokens and parsed cost deltas add up per run.
 * A breakdown survives only when both runs priced theirs.
 */
function mergeResults(earlier: ResultEvent, later: ResultEvent): ResultEvent {
  const [a, b] = [earlier.usage, later.usage]
  if (a === undefined) return later
  if (b === undefined) return { ...later, usage: a }
  const usage: Usage = { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens }
  // Only a fully priced pair: one unknown run (a resume after a restart) would otherwise
  // pass a partial figure as the whole turn's cost, so the tokens price it instead.
  const costUsd = a.costUsd === undefined || b.costUsd === undefined ? undefined : a.costUsd + b.costUsd
  if (costUsd !== undefined) usage.costUsd = costUsd
  if (a.breakdown !== undefined && b.breakdown !== undefined) {
    usage.breakdown = {
      freshInputTokens: a.breakdown.freshInputTokens + b.breakdown.freshInputTokens,
      cacheWrite5mTokens: a.breakdown.cacheWrite5mTokens + b.breakdown.cacheWrite5mTokens,
      cacheWrite1hTokens: a.breakdown.cacheWrite1hTokens + b.breakdown.cacheWrite1hTokens,
      cacheReadTokens: a.breakdown.cacheReadTokens + b.breakdown.cacheReadTokens,
      apiPricedInputEquivalent: a.breakdown.apiPricedInputEquivalent + b.breakdown.apiPricedInputEquivalent,
    }
  }
  return { ...later, usage }
}

/** A steering message as stream-json content: the addition's text, its raster images inline. */
function steeringContent(event: Extract<ThreadEvent, { type: 'user_message' }>, agents: readonly AgentConfig[], input: TurnInput) {
  const text = composeCatchUp({ events: [event], agents, isFullCatchUp: false, ...catchUpStyle(input) })
  const images = (event.images ?? []).flatMap((image) => {
    // Raster only, as in `materialiseImages`: the CLI rejects SVG.
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(image.dataUrl ?? '')
    return match === null ? [] : [{ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } }]
  })
  return images.length === 0 ? text : [...images, { type: 'text', text }]
}

const defaultSpawn: SpawnFn = (command, args, options) =>
  spawn(command, [...args], { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true })

/** A shell call: Claude's Bash, and Grok's `run_terminal_command` through this shared parser. */
const SHELL_TOOL = /^(bash|shell|run_terminal_command)$/i

const ASK_USER_TOOLS = new Set([
  'ask_user',
  `${BUILT_IN_INTERACTION_MCP_NAME}__ask_user`,
  `mcp__${BUILT_IN_INTERACTION_MCP_NAME}__ask_user`,
  'request_secret',
  `${BUILT_IN_INTERACTION_MCP_NAME}__request_secret`,
  `mcp__${BUILT_IN_INTERACTION_MCP_NAME}__request_secret`,
])

/** Manor's own ask-user and secret calls; their card is the row. A third-party tool that happens to end the same way stays visible. */
export function isAskUserTool(tool: string): boolean {
  return ASK_USER_TOOLS.has(tool.toLowerCase())
}

const isCodexSubagentTool = (tool: string): boolean =>
  [`${BUILT_IN_INTERACTION_MCP_NAME}__codex_subagent`, `mcp__${BUILT_IN_INTERACTION_MCP_NAME}__codex_subagent`]
    .includes(tool.toLowerCase())

/**
 * Lazy connectors on every Claude spawn. The first request goes out without waiting
 * for MCP servers to start, every MCP tool is deferred, and ToolSearch waits for the
 * one server a turn needs. `alwaysLoad` servers still connect first, which keeps
 * Manor's own tools inline. The first two ship together or not at all: no-wait alone
 * drops a pending server's inline tools from the first request. Both are CLI switches
 * outside the documented surface, so run `pnpm check:claude-lazy-mcp` after a CLI
 * update. Rejected options are in the memory folder's project_manor_performance.md decision card.
 */
export const LAZY_MCP_ENV = {
  CLAUDE_CODE_MCP_STARTUP_WAIT_MS: '0',
  ENABLE_TOOL_SEARCH: 'true',
  MCP_SERVER_CONNECTION_BATCH_SIZE: '16',
} as const

/**
 * Keeps TodoWrite, the full-list plan tool `todo_update` is read from. Measured on
 * claude 2.1.302: print mode on current models ships no plan tool at all unless
 * todo tools are opted in, and the opt-in alone brings the per-task TaskCreate and
 * TaskUpdate family instead, whose snapshots live in the CLI, not on the wire.
 */
export const TODO_TOOL_ENV = {
  CLAUDE_CODE_ENABLE_TODO_TOOLS: '1',
  CLAUDE_CODE_ENABLE_TASKS: '0',
} as const

/**
 * The client label on every Claude spawn. Print mode labels itself `sdk-cli`; Manor
 * names itself. Measured 2026-11-12 on claude 2.1.322 against a Max account, in two
 * runs of the same weighted tokens: `sdk-cli` moved the 5-hour limit 12 points and a
 * label of Manor's own 5. Set `MANOR_CLAUDE_ENTRYPOINT` to another name, or to an
 * empty string for the CLI default.
 *
 * The label is more than a name. It is the client the CLI reports on every request,
 * and the CLI then drops its print-mode defaults: three Artifact tools arrive (they
 * publish outside the effect broker), so does the `claude-code-guide` agent, and a
 * fresh session sends one extra request to name itself. All three are switched back
 * off here, which leaves a turn the size it has without the label. Run
 * `pnpm check:claude-entrypoint` after a CLI update, since a new CLI can gate
 * something else on the same label.
 */
const DEFAULT_ENTRYPOINT = 'manor'

const ENTRYPOINT_LABEL = /^[a-z][a-z0-9_-]{0,31}$/

/**
 * Names the CLI gives its own hosts. One of these as a label switches on that host's
 * behaviour, far beyond what is switched back off below, so it counts as no label.
 */
const RESERVED_ENTRYPOINT = /^(sdk|claude|remote|local|ssh)|^(cli|mcp|bench)$/

const claudeEntrypoint = (): string | undefined => {
  const label = (process.env.MANOR_CLAUDE_ENTRYPOINT ?? DEFAULT_ENTRYPOINT).trim()
  return ENTRYPOINT_LABEL.test(label) && !RESERVED_ENTRYPOINT.test(label) ? label : undefined
}

export const entrypointEnv = (): Record<string, string> => {
  const label = claudeEntrypoint()
  return label === undefined ? {} : {
    CLAUDE_CODE_ENTRYPOINT: label,
    CLAUDE_CODE_DISABLE_ARTIFACT: '1',
    CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1',
  }
}

const entrypointDisallowedTools = (): string[] => claudeEntrypoint() === undefined ? [] : ['Agent(claude-code-guide)']

/**
 * The `--mcp-config` payload for one turn, plus the tools to strip from it.
 *
 * Only attached servers appear. That is the whole access decision: measured on
 * claude 2.1.224, `--tools ""` does not gate MCP (a persona with an empty toolset
 * executed `mcp__filesystem__write_file`) and `--disallowed-tools mcp__<server>`
 * still pays for the server's `instructions` block, 419 input tokens for Supabase.
 * Absence from this object is the only state that costs nothing and grants nothing.
 *
 * Secrets stay `${KEY}` placeholders. The CLI expands them from the environment this
 * process passes down, so the resolved value never reaches the argv, where `ps` on
 * the VPS would show it to anything that asks.
 */
export function buildMcpArgs(attached: readonly AttachedMcpServer[], alsoDisallowed: readonly string[] = []): string[] {
  if (attached.length === 0) return alsoDisallowed.length === 0 ? [] : ['--disallowed-tools', ...alsoDisallowed]
  const { servers, disallowed: disabled } = mcpServerConfigs(attached)
  // One flag for every stripped tool: whether a repeated variadic flag adds up is not
  // something to lean on.
  const disallowed = [...disabled, ...alsoDisallowed]
  const args = ['--mcp-config', JSON.stringify({ mcpServers: servers })]
  // Variadic, like --tools and --add-dir, so it is placed before them out of the same
  // discipline. Verified that a flag after either still parses (the variadic stops at
  // the next `--` token), so this is defence against a parser change, not a fix.
  if (disallowed.length > 0) args.push('--disallowed-tools', ...disallowed)
  return args
}

/**
 * The servers an attached turn hands a live session through `mcp_set_servers`, with
 * every `${KEY}` placeholder filled in. The process env was fixed by the turn that
 * spawned it, so a placeholder would expand to that turn's revoked capability. The
 * values travel over stdin, never argv. Disabled tools cannot change mid-session.
 */
export function liveMcpServers(attached: readonly AttachedMcpServer[], env: NodeJS.ProcessEnv): Record<string, unknown> {
  const fill = (value: unknown): unknown =>
    typeof value === 'string'
      ? value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, key: string) => env[key] ?? whole)
      : Array.isArray(value) ? value.map(fill)
        : isRecord(value) ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, fill(entry)]))
          : value
  const filled = fill(mcpServerConfigs(attached).servers)
  return isRecord(filled) ? filled : {}
}

function mcpServerConfigs(attached: readonly AttachedMcpServer[]): { servers: Record<string, Record<string, unknown>>; disallowed: string[] } {
  const servers: Record<string, Record<string, unknown>> = {}
  const disallowed: string[] = []
  for (const { server, disabledTools, runtimeEnv } of attached) {
    const url = mcpHttpUrl(server)
    if (url !== undefined) {
      const bearerKey = mcpBearerEnvKey(server.name)
      const headers = Object.fromEntries(
        Object.entries(mcpHttpHeaderEnvMap(server)).map(([name, envKey]) => [name, `\${${envKey}}`]),
      )
      if (runtimeEnv?.[bearerKey] !== undefined) headers.Authorization = `Bearer \${${bearerKey}}`
      servers[server.name] = {
        type: 'http',
        url,
        ...(Object.keys(headers).length === 0 ? {} : { headers }),
      }
    } else {
      const envKeys = [...new Set([...server.envKeys, ...Object.keys(runtimeEnv ?? {})])]
      const env = Object.fromEntries(envKeys.map((key) => [key, `\${${key}}`]))
      servers[server.name] = {
        command: server.command,
        args: [...server.args],
        ...(envKeys.length === 0 ? {} : { env }),
      }
    }
    // Manor's small, turn-scoped toolset (ask_user, delegate_task, goal_reached,
    // review_passed, ...) loads upfront in every room; registered connectors stay
    // deferred. Under `LAZY_MCP_ENV` it is also the one server the CLI still connects
    // before the first request, so those tools never need a ToolSearch hop.
    if (server.id === 'builtin_manor') {
      const config = servers[server.name]
      if (config !== undefined) config.alwaysLoad = true
    }
    for (const tool of disabledTools) disallowed.push(`mcp__${server.name}__${tool}`)
  }
  return { servers, disallowed }
}

/**
 * The context size the CLI compacts a turn at, in tokens. It accepts `auto` or
 * 100k-1M, and 300k is the first step: it is the bucket boundary above which 147
 * measured turns carried 52% of all cache reads, so it leaves the normal working
 * range alone and bites only on the runaway tail. Set
 * `MANOR_CLAUDE_AUTOCOMPACT` to tune it, or to an empty string for the CLI default.
 *
 * The three ceilings in order: rollover rooms reseed at `SESSION_CONTEXT_TOKEN_CAP`
 * (200k), the CLI compacts here (300k), and `LIVE_COMPACT_CONTEXT_FRACTION` (0.9 of
 * a 1M window) now sits above both, so on Claude it never fires. Move this and that
 * ordering changes.
 */
const AUTOCOMPACT_TOKENS = '300000'

const autocompactArg = () => process.env.MANOR_CLAUDE_AUTOCOMPACT ?? AUTOCOMPACT_TOKENS

/**
 * The threshold the CLI will actually compact this session at, in tokens, or
 * undefined when the flag is off and the CLI uses a default Manor cannot see.
 *
 * Unlike every other context figure this one is known rather than reported: Manor
 * puts it on the argv itself, so reading it back is reading Manor's own decision.
 */
export function claudeAutocompactTokens(): number | undefined {
  const raw = autocompactArg()
  if (raw.length === 0) return undefined
  const tokens = Number(raw)
  return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : undefined
}

/**
 * Builds the CLI argv for one turn.
 *
 * Tool restriction uses `--tools`, not `--allowedTools`. `--allowedTools` is a
 * permission allowlist: an empty one leaves every built-in tool present and merely
 * unapproved, which is not "this persona has no tools". `--tools` selects from the
 * built-in set and documents `""` as "disable all tools", which is exactly the
 * semantic an empty `allowedTools` array must have.
 *
 * A project with linked folders replaces that toolset with the CLI's own default,
 * the full built-in set: they are the user's real working copies and a persona that may
 * work in them needs the tools to do so. Both `--tools` and `--add-dir` are
 * variadic, so whichever of the two is used ends the argv; a flag after either would
 * be eaten as another value.
 *
 * Permissions default to bypassPermissions (full access), overridable via
 * `MANOR_CLAUDE_PERMISSION_MODE` (set it to an empty string to fall back to the
 * CLI default).
 */
export function buildArgs(input: TurnInput): string[] {
  const args = [
    '--print',
    // Streaming input keeps stdin open for the turn, so `steer` can hand the CLI a
    // message while it works. The driver closes stdin once the turn's result is in.
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    // stream-json in print mode has historically required --verbose; unknown extra
    // line types are ignored by the parser, so passing it is the safe default.
    '--verbose',
    '--include-partial-messages',
    // Full system-prompt replace: the persona IS the prompt, harness prompt gone.
    '--system-prompt',
    input.agent.character,
    // Resume otherwise reuses the first prompt snapshot, ignoring current memory.
    '--system-prompt-snapshot',
    'off',
    // The persona gets nothing from the machine it happens to run on. Without these
    // two, every globally configured MCP server ships its tool schemas into the
    // request (measured: ~84k input tokens on an otherwise empty first turn) and
    // user-level settings (hooks, plugins) leak in. A persona's own MCP servers come
    // in through the explicit --mcp-config below, never from ambient machine config.
    //
    // Switching off setting sources also switches off the CLI's memory loading, so a
    // linked folder's CLAUDE.md would go unread. That is restored deliberately and
    // narrowly in `projectMemory.ts`, which reads the memory files of the linked
    // folders only and puts them in the persona's prompt. Do not re-enable a setting
    // source to get memory back; it brings the ~84k tokens with it.
    '--strict-mcp-config',
    '--setting-sources',
    '',
  ]
  if (input.agent.model !== undefined) args.push('--model', input.agent.model)
  // The CLI takes the same five levels Codex does, so the persona's one effort
  // field reaches both drivers unchanged.
  args.push('--effort', input.agent.effort)
  // Where the CLI compacts the turn's own context. Without it the CLI measures against
  // the model's full window, 1M for every Claude model in `MODEL_CONTEXT_WINDOWS`, so
  // nothing bounds one long tool loop. Manor's own ceilings cannot: both
  // `SESSION_CONTEXT_FRACTION` and `LIVE_COMPACT_CONTEXT_FRACTION` are checked between
  // turns, and the growth happens inside one. Measured over 14 days, 42 turns of 100+
  // tool calls ran to 300k-756k and carried half of all Claude cache reads, and a tool
  // call inside such a turn cost 345k read tokens against 137k in a 26-50 call turn.
  const autocompact = autocompactArg()
  if (autocompact.length > 0) args.push('--autocompact', autocompact)
  if (input.sessionId !== undefined) args.push('--resume', input.sessionId)
  // Full access, decided 2026-08-06: tool calls run unprompted. What a
  // persona can touch is governed by its toolset (--tools below), not by
  // per-call approval; print mode has nobody to approve anyway.
  const permissionMode = process.env.MANOR_CLAUDE_PERMISSION_MODE ?? 'bypassPermissions'
  if (permissionMode.length > 0) args.push('--permission-mode', permissionMode)
  // Before the variadic terminators below, by discipline rather than by necessity.
  // Note this does NOT interact with --tools: an attached server's tools arrive
  // whatever the toolset says, which is why attachment is the access decision and
  // `allowedTools` governs built-ins only.
  args.push(...buildMcpArgs(input.mcpServers ?? [], entrypointDisallowedTools()))
  // The folders are ADDITIONAL directories, never the cwd: the turn still runs in
  // the thread's scratch dir. Omitting --tools is what grants the full toolset.
  // `--add-dir` is variadic, so every path rides on the one flag and it ends the
  // argv; a flag after it would be eaten as another directory.
  if (input.repoPaths.length === 0) {
    // An attachment is delivered as a file path, so a persona holding no Read cannot
    // see what was sent to her. The grant is exactly as wide as the attachment: one
    // tool, only on turns that carry one. The linked-folder branch below passes no
    // `--tools` at all and therefore already has it.
    // `LAZY_MCP_ENV` defers every attached tool outside `alwaysLoad`, and ToolSearch
    // is the only way to load one, so attached servers bring it along. It grants
    // nothing: the attachment already decided access.
    args.push('--tools', claudeBuiltInTools(input).join(','))
  } else args.push('--add-dir', ...input.repoPaths)
  return args
}

/** The built-in tools a turn without linked folders gets; with folders it is the CLI's full set. */
export const claudeBuiltInTools = (input: Pick<TurnInput, 'agent' | 'imagePaths' | 'mcpServers'>): string[] => [...new Set([
  ...input.agent.allowedTools,
  ...(input.imagePaths?.length ? ['Read'] : []),
  ...(input.mcpServers?.length ? ['ToolSearch'] : []),
])]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
const asNumber = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined)

/**
 * A call that starts work the persona does not wait for: Agent or Bash asked to run in
 * the background, or a Monitor, which always watches in the background.
 */
const startsBackground = (tool: string, input: unknown): boolean =>
  tool === 'Monitor' || (/^(Agent|Task|Bash)$/.test(tool) && isRecord(input) && input['run_in_background'] === true)

/**
 * Does this path exist right now? Asked while the tool_use line is being parsed,
 * which is before the CLI has finished carrying the write out — that ordering is
 * the whole reason the answer is worth anything. A relative path would resolve
 * against the server's cwd rather than the turn's, so an unanchored path is
 * answered with "can't say" instead of a guess.
 */
const fileExists = (path: string): boolean => (isAbsolute(path) ? existsSync(path) : true)

/**
 * Everything the model read for one request: fresh input plus both halves of the
 * cache. Every one of those tokens occupied the context window, so this is the
 * right sum for the gauge. It is the wrong sum for API pricing, which is what
 * `promptBreakdown` below exists to estimate.
 */
function promptTokens(raw: Record<string, unknown>): number {
  return (
    (asNumber(raw['input_tokens']) ?? 0) +
    (asNumber(raw['cache_creation_input_tokens']) ?? 0) +
    (asNumber(raw['cache_read_input_tokens']) ?? 0)
  )
}

/**
 * The same tokens split by what they cost, or nothing at all.
 *
 * The split hinges on `usage.cache_creation`, which names each write's duration.
 * Without it a write cannot be priced (5-minute is 1.25x fresh input, 1-hour is
 * 2x) and the honest answer is no breakdown rather than a guessed one — the same
 * call `contextTokens` makes when a driver cannot report it. The flat
 * `cache_creation_input_tokens` is deliberately not used as a fallback: it is the
 * sum of the two durations and says nothing about which.
 */
function promptBreakdown(raw: Record<string, unknown>): UsageBreakdown | undefined {
  const creation = raw['cache_creation']
  if (!isRecord(creation)) return undefined
  const freshInputTokens = asNumber(raw['input_tokens'])
  const flatCacheWriteTokens = asNumber(raw['cache_creation_input_tokens'])
  const cacheWrite5mTokens = asNumber(creation['ephemeral_5m_input_tokens'])
  const cacheWrite1hTokens = asNumber(creation['ephemeral_1h_input_tokens'])
  const cacheReadTokens = asNumber(raw['cache_read_input_tokens'])
  if (
    freshInputTokens === undefined ||
    flatCacheWriteTokens === undefined ||
    cacheWrite5mTokens === undefined ||
    cacheWrite1hTokens === undefined ||
    cacheReadTokens === undefined ||
    cacheWrite5mTokens + cacheWrite1hTokens !== flatCacheWriteTokens
  ) return undefined
  const parts = {
    freshInputTokens,
    cacheWrite5mTokens,
    cacheWrite1hTokens,
    cacheReadTokens,
  }
  return { ...parts, apiPricedInputEquivalent: apiPricedInputEquivalent(parts) }
}

/**
 * Turn totals, off the `result` line. The CLI sums that line over every request it
 * made, so this is processed volume, never point-in-time context or subscription use.
 */
function toUsage(raw: unknown, costUsd: number | undefined): Usage | undefined {
  if (!isRecord(raw)) return costUsd === undefined ? undefined : { inputTokens: 0, outputTokens: 0, costUsd }
  const inputTokens = promptTokens(raw)
  const outputTokens = asNumber(raw['output_tokens']) ?? 0
  const breakdown = promptBreakdown(raw)
  const usage: Usage = { inputTokens, outputTokens }
  if (costUsd !== undefined) usage.costUsd = costUsd
  if (breakdown !== undefined) usage.breakdown = breakdown
  return usage
}

const FAILED_TURN_DETAIL_MAX = 300

/** What Claude Code says when `--resume` names a transcript it no longer has. */
const MISSING_CONVERSATION = /No conversation found with session ID/

/** What a failed result line says when its `result` text is empty: the subtype and the first error. */
const failedTurnMessage = (line: Record<string, unknown>): string => {
  const subtype = asString(line['subtype'])
  const first = Array.isArray(line['errors']) ? line['errors'][0] : undefined
  const detail = typeof first === 'string' ? first : isRecord(first) ? asString(first['message']) : undefined
  const base = subtype !== undefined && subtype !== 'success'
    ? `the CLI reported a failed turn (${subtype})`
    : 'the CLI reported a failed turn'
  const trimmed = detail?.trim()
  return trimmed === undefined || trimmed.length === 0 ? base : `${base}: ${trimmed.slice(0, FAILED_TURN_DETAIL_MAX)}`
}

/**
 * Turns Claude Code's `stream-json` lines into RuntimeEvents. The shapes handled are
 * the documented ones: a `system`/`init` line carrying `session_id`, `assistant`
 * message lines carrying the authoritative message boundary and any tool calls,
 * `user` lines carrying tool results, partial `stream_event` lines, and a final
 * `result` line with usage and `total_cost_usd`. Anything else is ignored rather
 * than treated as an error.
 */
export class StreamParser {
  /**
   * `followsBackground` is Claude's task lifecycle: a background launch keeps its row
   * open until its own notification. Grok shares this parser but not that lifecycle,
   * so it never holds a result back.
   */
  constructor(
    private readonly includeCostUsd = true,
    private readonly followsBackground = false,
    /** The driver's last known CLI cost total per session, shared by its processes. */
    private readonly costTotals?: Map<string, number>,
    /**
     * The compaction threshold this CLI was handed on its argv, when the driver knows
     * it. Only the Claude driver passes one: Grok shares this parser but not that flag,
     * and a Grok result must not carry Claude's number.
     */
    private readonly autoCompactTokens?: number,
  ) {}

  sessionId: string | undefined
  /**
   * True once the CLI reported an initialised session; a resume that never inits failed.
   * Grok answers a missing session with an init whose `session_id` is empty, so only an
   * init that names its session counts.
   */
  sawInit = false
  /**
   * The last result came from a run no user message started: a background task the
   * CLI woke for. On resume the CLI replays such a wake first, as an empty result.
   */
  lastResultWasWake = false
  /**
   * Background tasks the persona itself started (`run_in_background` on Agent or
   * Bash, or a Monitor), by task id, with the CLI's description and what kind of work
   * it is. A `task_started` line marked `is_backgrounded` opens one and its
   * `task_notification` closes it. Foreground tasks and tasks a helper started for
   * itself (owned by it, or spawned below the first level) are not the turn's to wait on.
   */
  readonly backgroundTasks = new Map<string, { title: string; kind: 'agent' | 'command' }>()
  /**
   * A background task finished and no main request has read its notification yet.
   * The CLI answers it in the running request's next call or, between runs, in a
   * wake run; either starts with a `requesting` status line.
   */
  unansweredNotification = false
  /** A main-thread request starts; helpers report none. */
  onMainRequest: (() => void) | undefined
  /**
   * A background launch returned its receipt. The call is no longer in flight for the
   * idle clock, even though its row stays open until the work itself ends.
   */
  onBackgroundAck: ((toolCallId: string) => void) | undefined
  /** Streaming input reports each user message it takes as queued, started, completed or cancelled. */
  onCommand: ((uuid: string, state: string) => void) | undefined
  /** A foreground Bash command or helper the persona itself started began running, by its call. */
  onForegroundTask: ((toolCallId: string) => void) | undefined
  /** A background task the persona started ended, with the row it settles. */
  onBackgroundEnded: ((item: { toolCallId: string; title: string; state: 'done' | 'failed' | 'stopped' }) => void) | undefined
  /**
   * Prompt size of the most recent request, taken off each `assistant` line as it
   * arrives. The last one standing when the turn ends is how full the window was
   * when the persona last spoke, which is the only honest context gauge here: the
   * `result` line's own usage is a turn total across every request.
   *
   * It understates by the final message's own output, a few hundred tokens against
   * a window of a million. Not worth reconstructing — the per-message
   * `output_tokens` on a streamed `assistant` line is partial anyway.
   */
  private lastPromptTokens: number | undefined
  /** Between the CLI's `compacting` status and its compact boundary. */
  private compacting = false
  /**
   * The CLI's session cost total this process has already reported, including turns
   * that reattach to it. Undefined while unknown, see `resumeCostFrom`.
   */
  private cumulativeCostUsd: number | undefined = 0

  /**
   * `--resume` restores the session's cost total, so a new process's first result
   * includes every earlier turn. Without a known total (a server restart) that first
   * figure goes unreported and the turn is priced from its tokens instead.
   */
  resumeCostFrom(sessionId: string): void {
    this.cumulativeCostUsd = this.costTotals?.get(sessionId)
  }
  /** What the CLI said served this turn; see `TurnResultEventSchema.reportedModel`. */
  private reportedModel: string | undefined
  private messageCounter = 0
  private currentMessageId: string | undefined
  private currentText = ''
  private readonly todoToolCalls = new Set<string>()
  private readonly hiddenToolCalls = new Set<string>()
  /** Launches whose result is the helper's answer, which the transcript keeps. */
  private readonly subagentToolCalls = new Set<string>()
  /**
   * Background launches by call id. The CLI answers such a call at once with a
   * receipt; its row settles from the task's `task_notification` instead.
   */
  private readonly backgroundCalls = new Set<string>()
  /** The one-line description a background shell launch gave, until its task starts and takes it as its title. */
  private readonly launchDescriptions = new Map<string, string>()
  /**
   * SendMessage calls held back until the CLI says what they did. A `task_started`
   * carrying the call's id means it resumed a finished agent, which then shows as that
   * agent running again; a plain result means it only messaged one.
   */
  private readonly heldMessages = new Map<string, Extract<RuntimeEvent, { type: 'tool_use' }>>()
  /**
   * Foreground tasks the persona started, by task id: the call blocks until the task
   * ends, unless the CLI moves it to the background, which a steer asks for.
   */
  private readonly foregroundTasks = new Map<string, { toolCallId: string; title: string; agent: boolean }>()
  /** Top-level calls still waiting for their result, so a moved task's row can be marked background. */
  private readonly openCalls = new Map<string, Extract<RuntimeEvent, { type: 'tool_use' }>>()
  /** Each background task this turn started, by task id, with the call its row lives under. */
  private readonly taskRows = new Map<string, string>()
  /**
   * SendMessage calls that resumed an agent this turn launched, with that launch's call.
   * The CLI reports the resumed run under the message's id; the row is the launch's.
   */
  private readonly resumedRows = new Map<string, string>()
  /** Background launches the current turn made; a live session's next turn starts empty. */
  private readonly turnRows = new Set<string>()
  /**
   * Background tasks a `background_tasks_changed` snapshot stopped listing before any
   * `task_notification` closed them. The notification follows within a line or two, so
   * one still missing at the next run boundary is not coming: the task settles there
   * from its last `task_updated` status, or as stopped when it reported none.
   */
  private readonly vanishedTasks = new Set<string>()
  /** The last status a `task_updated` patch reported for each running background task. */
  private readonly taskStatus = new Map<string, string>()
  /**
   * Rows of resumes whose launch this process never saw, a restart in between. The
   * CLI reports such an agent's steps under its original launch id, which this
   * process cannot place, so a lone one of these takes them.
   */
  private readonly orphanResumes = new Set<string>()

  /** The row a call id reports into: a resume's lines go to the launch it resumed. */
  private rowOf(toolCallId: string): string {
    return this.resumedRows.get(toolCallId) ?? toolCallId
  }

  /** A turn attaches to this process; rows launched before it belong to earlier turns. */
  beginTurn(): void {
    this.turnRows.clear()
  }

  /** Background work still running, by the row each one settles. */
  runningBackground(): { toolCallId: string; title: string; kind: 'agent' | 'command' }[] {
    return [...this.backgroundTasks].flatMap(([taskId, task]) => {
      const toolCallId = this.taskRows.get(taskId)
      return toolCallId === undefined ? [] : [{ toolCallId: this.rowOf(toolCallId), title: task.title, kind: task.kind }]
    })
  }

  /** Running background work by kind, for the wait a turn shows once it answered. */
  backgroundCounts(): { agents: number; commands: number } {
    let agents = 0
    for (const task of this.backgroundTasks.values()) if (task.kind === 'agent') agents += 1
    return { agents, commands: this.backgroundTasks.size - agents }
  }

  /** A foreground Bash command or helper is running, so a steer waits for it unless it moves. */
  runsForegroundTask(): boolean {
    return this.foregroundTasks.size > 0
  }

  /**
   * The CLI moved a foreground task to the background (a steer asked for it). From here
   * it is background work like any `run_in_background` launch: the call's result is a
   * receipt, the row stays open and settles from the task's notification, and the turn
   * waits for it. The row goes out again marked background, as the client promotes it.
   */
  private foregroundMoved(taskId: string): RuntimeEvent[] {
    const task = this.foregroundTasks.get(taskId)
    if (task === undefined) return []
    this.foregroundTasks.delete(taskId)
    this.backgroundTasks.set(taskId, { title: task.title, kind: task.agent ? 'agent' : 'command' })
    this.backgroundCalls.add(task.toolCallId)
    this.turnRows.add(task.toolCallId)
    this.taskRows.set(taskId, task.toolCallId)
    const launch = this.openCalls.get(task.toolCallId)
    return launch === undefined ? [] : [{ ...launch, background: true }]
  }

  /**
   * Background launches whose work has not reported its end, closed as stopped. The
   * turn's end takes the process down, and that work with it.
   */
  stopOpenBackground(): RuntimeEvent[] {
    const open = [...this.backgroundCalls]
    this.backgroundCalls.clear()
    this.launchDescriptions.clear()
    for (const toolCallId of open) this.subagentToolCalls.delete(toolCallId)
    return open.map((toolCallId) => ({ type: 'tool_result', toolCallId, outcome: 'stopped' }))
  }

  /** The held SendMessage calls nothing answered, as the plain calls they were. */
  flushHeldMessages(): Extract<RuntimeEvent, { type: 'tool_use' }>[] {
    const held = [...this.heldMessages.values()]
    this.heldMessages.clear()
    return held
  }

  private beginMessage(preferredId?: string): string {
    if (this.currentMessageId !== undefined) return this.currentMessageId
    this.messageCounter += 1
    this.currentMessageId = preferredId ?? `message_${this.messageCounter}`
    return this.currentMessageId
  }

  private finishMessage(text: string): Extract<RuntimeEvent, { type: 'message' }> | undefined {
    if (text.length === 0) {
      this.currentMessageId = undefined
      this.currentText = ''
      return undefined
    }
    const messageId = this.beginMessage()
    this.currentMessageId = undefined
    this.currentText = ''
    return { type: 'message', messageId, text }
  }

  /**
   * A background task started. A fresh launch only records which row is the task's. A
   * SendMessage that resumed a finished agent restarts the same task under the
   * message's call id: when this turn launched that agent, its own row reopens and keeps
   * its steps; an agent from an earlier turn shows here as that agent running again.
   * Either row settles from the task's next notification like a first launch.
   */
  private backgroundStarted(parsed: Record<string, unknown>, taskId: string, title: string, agent: boolean): RuntimeEvent[] {
    const callId = asString(parsed['tool_use_id'])
    if (callId === undefined) return []
    if (!agent || !this.heldMessages.delete(callId)) {
      if (this.backgroundCalls.has(callId)) this.taskRows.set(taskId, callId)
      return []
    }
    const earlier = this.taskRows.get(taskId)
    // Only this turn's own launch row reopens. An agent launched by an earlier turn of
    // a live session runs again under the message's row here, and its steps, which the
    // CLI reports under the old launch id, follow it.
    const launch = earlier !== undefined && this.turnRows.has(earlier) ? earlier : undefined
    if (launch === undefined) {
      this.taskRows.set(taskId, callId)
      if (earlier !== undefined) this.resumedRows.set(earlier, callId)
      else this.orphanResumes.add(callId)
    } else this.resumedRows.set(callId, launch)
    const toolCallId = launch ?? callId
    this.turnRows.add(toolCallId)
    this.backgroundCalls.add(toolCallId)
    this.subagentToolCalls.add(toolCallId)
    const agentType = asString(parsed['subagent_type'])
    const subagent = subagentLaunch({ description: title, prompt: parsed['prompt'] })
    return [{
      type: 'tool_use',
      toolCallId,
      tool: 'Agent',
      subject: title,
      ...(agentType === undefined ? {} : { agentType }),
      ...(subagent === undefined ? {} : { subagent }),
      background: true,
    }]
  }

  /**
   * A background task ended: it leaves the roster, and its launch row settles with how
   * it ended and a helper's answer. Unknown status reads as an error, except where the
   * caller passes `stopped` for an end nobody reported.
   */
  private backgroundEnded(taskId: string, reported: string | undefined, status: string | undefined, summary?: string): RuntimeEvent[] {
    const task = this.backgroundTasks.get(taskId)
    this.backgroundTasks.delete(taskId)
    this.vanishedTasks.delete(taskId)
    this.taskStatus.delete(taskId)
    if (!this.followsBackground) return []
    const toolCallId = reported === undefined ? undefined : this.rowOf(reported)
    if (toolCallId === undefined || !this.backgroundCalls.delete(toolCallId)) return []
    this.orphanResumes.delete(toolCallId)
    const outcome = status === 'completed' ? 'success' : status === 'stopped' || status === 'killed' ? 'stopped' : 'error'
    const output = this.subagentToolCalls.delete(toolCallId) && outcome === 'success' && summary !== undefined
      ? summary.slice(0, SUBAGENT_TEXT_MAX)
      : undefined
    if (task !== undefined) {
      this.onBackgroundEnded?.({
        toolCallId, title: task.title,
        state: outcome === 'success' ? 'done' : outcome === 'stopped' ? 'stopped' : 'failed',
      })
    }
    const error = outcome === 'error' ? errorText(summary) : undefined
    return [{ type: 'tool_result', toolCallId, outcome, ...(output === undefined ? {} : { output }), ...(error === undefined ? {} : { error }) }]
  }

  /**
   * Tasks a snapshot dropped and no notification closed, settled at a run boundary. A
   * `completed` status from `task_updated` is evidence of success; without any status
   * the end is unknown and reads as stopped, never as done.
   */
  reconcileVanished(): RuntimeEvent[] {
    const vanished = [...this.vanishedTasks].filter((taskId) => this.backgroundTasks.has(taskId))
    this.vanishedTasks.clear()
    return vanished.flatMap((taskId) => {
      return this.backgroundEnded(taskId, this.taskRows.get(taskId), this.taskStatus.get(taskId) ?? 'stopped')
    })
  }

  private childEvents(parsed: Record<string, unknown>, parentToolCallId: string): RuntimeEvent[] {
    const message = parsed['message']
    if (!isRecord(message) || !Array.isArray(message['content'])) return []
    if (parsed['type'] === 'user') {
      return message['content'].flatMap((block): RuntimeEvent[] => {
        if (!isRecord(block) || block['type'] !== 'tool_result') return []
        const toolCallId = asString(block['tool_use_id'])
        const error = block['is_error'] === true ? errorText(block['content']) : undefined
        return toolCallId === undefined ? [] : [{
          type: 'tool_result', toolCallId, parentToolCallId,
          outcome: block['is_error'] === true ? 'error' : 'success',
          ...(error === undefined ? {} : { error }),
        }]
      })
    }
    if (parsed['type'] !== 'assistant') return []
    return message['content'].flatMap((block): RuntimeEvent[] => {
      if (!isRecord(block)) return []
      if (block['type'] === 'thinking') {
        const text = asString(block['thinking'])?.trim()
        return text === undefined ? [] : [{ type: 'reasoning', text: text.slice(0, REASONING_LIMIT), parentToolCallId }]
      }
      if (block['type'] !== 'tool_use') return []
      const tool = asString(block['name'])
      if (tool === undefined) return []
      const toolCallId = asString(block['id'])
      if (SHELL_TOOL.test(tool) && isRecord(block['input'])) {
        const command = asString(block['input']['command'])
        if (command !== undefined && command.trim().length > 0) return [{
          type: 'tool_use', parentToolCallId,
          ...(toolCallId === undefined ? {} : { toolCallId }),
          ...describeCommand(command, fileExists, asString(block['input']['description'])),
        }]
      }
      const edits = editsFromToolInput(tool, block['input'], fileExists)
      return [{
        type: 'tool_use', parentToolCallId,
        ...(toolCallId === undefined ? {} : { toolCallId }),
        ...describeTool(tool, block['input']),
        ...(edits === undefined ? {} : { edits }),
      }]
    })
  }

  handle(line: string): RuntimeEvent[] {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      return []
    }
    if (!isRecord(parsed)) return []

    // Child work belongs to the Agent call, not the parent's reply or session.
    const parentToolCallId = asString(parsed['parent_tool_use_id'])
    if (parentToolCallId !== undefined) {
      const known = this.resumedRows.has(parentToolCallId) || this.backgroundCalls.has(parentToolCallId) ||
        this.subagentToolCalls.has(parentToolCallId)
      const [orphan] = this.orphanResumes
      if (!known && orphan !== undefined && this.orphanResumes.size === 1) this.resumedRows.set(parentToolCallId, orphan)
      return this.childEvents(parsed, this.rowOf(parentToolCallId))
    }

    switch (asString(parsed['type'])) {
      case 'command_lifecycle': {
        const uuid = asString(parsed['command_uuid'])
        const state = asString(parsed['state'])
        if (uuid !== undefined && state !== undefined) this.onCommand?.(uuid, state)
        return []
      }
      case 'system': {
        const subtype = asString(parsed['subtype'])
        const taskId = asString(parsed['task_id'])
        /** The persona's own task, not one a helper started for itself. */
        const ownTask = taskId !== undefined && parsed['owned_by_subagent'] !== true && (asNumber(parsed['spawn_depth']) ?? 1) <= 1
        if (subtype === 'task_started' && ownTask && parsed['is_backgrounded'] === true) {
          const launch = asString(parsed['tool_use_id'])
          const described = launch === undefined ? undefined : this.launchDescriptions.get(launch)
          if (launch !== undefined) this.launchDescriptions.delete(launch)
          // A shell task's own description is its command; the launch's description is the readable name.
          const title = described ?? asString(parsed['description']) ?? taskId
          const agent = asString(parsed['task_type']) === 'local_agent'
          this.backgroundTasks.set(taskId, { title, kind: agent ? 'agent' : 'command' })
          this.vanishedTasks.delete(taskId)
          this.taskStatus.delete(taskId)
          if (this.followsBackground) return this.backgroundStarted(parsed, taskId, title, agent)
        }
        if (this.followsBackground && subtype === 'task_started' && ownTask && parsed['is_backgrounded'] === false) {
          const toolCallId = asString(parsed['tool_use_id'])
          if (toolCallId !== undefined) {
            const agent = asString(parsed['task_type']) === 'local_agent'
            this.foregroundTasks.set(taskId, { toolCallId, title: asString(parsed['description']) ?? taskId, agent })
            this.onForegroundTask?.(toolCallId)
          }
          return []
        }
        if (subtype === 'task_notification' && taskId !== undefined) {
          this.foregroundTasks.delete(taskId)
          if (this.backgroundTasks.has(taskId)) this.unansweredNotification = true
          return this.backgroundEnded(taskId, asString(parsed['tool_use_id']), asString(parsed['status']), asString(parsed['summary']))
        }
        if (subtype === 'task_updated' && taskId !== undefined) {
          const patch = isRecord(parsed['patch']) ? parsed['patch'] : {}
          const moved = patch['is_backgrounded'] === true ? this.foregroundMoved(taskId) : []
          const status = asString(patch['status'])
          if (status !== undefined && this.backgroundTasks.has(taskId)) this.taskStatus.set(taskId, status)
          return moved
        }
        // The roster as the CLI sees it. A task it no longer lists has ended; its
        // notification normally follows, and `reconcileVanished` covers one that does not.
        if (subtype === 'background_tasks_changed' && Array.isArray(parsed['tasks'])) {
          const listed = new Set(parsed['tasks'].flatMap((task) => (isRecord(task) ? [asString(task['task_id'])] : [])))
          for (const id of this.backgroundTasks.keys()) {
            if (listed.has(id)) this.vanishedTasks.delete(id)
            else this.vanishedTasks.add(id)
          }
          return []
        }
        if (subtype === 'status' && asString(parsed['status']) === 'requesting') {
          this.unansweredNotification = false
          this.onMainRequest?.()
        }
        // The CLI's own compaction: a `compacting` status opens it, the boundary closes
        // it with the compacted size when the CLI names one, a failed result ends it as is.
        if (subtype === 'status') {
          const status = asString(parsed['status'])
          if (status === 'compacting' && !this.compacting) {
            this.compacting = true
            return [{ type: 'compaction', phase: 'start' }]
          }
          if (this.compacting && asString(parsed['compact_result']) === 'failed') {
            this.compacting = false
            return [{ type: 'compaction', phase: 'failed' }]
          }
          return []
        }
        if (subtype === 'compact_boundary') {
          this.compacting = false
          const metadata = isRecord(parsed['compact_metadata']) ? parsed['compact_metadata'] : undefined
          const after = metadata === undefined ? undefined : asNumber(metadata['post_tokens'])
          // Until the next request reports, the size from before the boundary is stale.
          this.lastPromptTokens = after
          return [{ type: 'compaction', phase: 'end', ...(after === undefined ? {} : { contextTokens: after }) }]
        }
        if (subtype !== 'init') return []
        const initSession = asString(parsed['session_id'])
        if (initSession !== undefined && initSession.length > 0) {
          this.sessionId = initSession
          this.sawInit = true
        }
        // MCP startup is eager CLI plumbing, not work the persona chose to do. A
        // failed attachment therefore stays out of the turn trace. The shared
        // connection inventory in the persona prompt makes a missing capability
        // explicit only when the request actually needs it; real calls keep using
        // the ordinary tool_result lifecycle below.
        return this.reconcileVanished()
      }
      case 'stream_event': {
        const event = parsed['event']
        if (!isRecord(event)) return []
        if (asString(event['type']) === 'message_start') {
          const message = event['message']
          this.beginMessage(isRecord(message) ? asString(message['id']) : undefined)
          return []
        }
        if (asString(event['type']) !== 'content_block_delta') return []
        const delta = event['delta']
        if (!isRecord(delta) || asString(delta['type']) !== 'text_delta') return []
        const text = asString(delta['text'])
        if (text === undefined || text.length === 0) return []
        const messageId = this.beginMessage()
        this.currentText += text
        return [{ type: 'delta', messageId, text }]
      }
      case 'assistant': {
        const message = parsed['message']
        if (!isRecord(message) || !Array.isArray(message['content'])) return []
        const events: RuntimeEvent[] = []
        const usage = message['usage']
        if (isRecord(usage)) {
          // The CLI writes one line per content block, each with the same usage, so
          // only a changed size is a new request's reading.
          const tokens = promptTokens(usage)
          if (this.compacting) {
            this.compacting = false
            events.push({ type: 'compaction', phase: 'end' })
          }
          if (tokens > 0 && tokens !== this.lastPromptTokens) {
            events.push({
              type: 'context',
              contextTokens: tokens,
              ...(this.autoCompactTokens === undefined ? {} : { autoCompactTokens: this.autoCompactTokens }),
            })
          }
          this.lastPromptTokens = tokens
        }
        // Every assistant line names the model that produced it. Taken from the last
        // one rather than the first, so a turn the CLI moved to another model reports
        // where it ended up.
        this.reportedModel = asString(message['model']) ?? this.reportedModel
        const fullText = message['content']
          .filter((block): block is Record<string, unknown> => isRecord(block) && asString(block['type']) === 'text')
          .map((block) => asString(block['text']) ?? '')
          .join('')
        const messageId = this.beginMessage(asString(message['id']))
        if (this.currentText.length === 0 && fullText.length > 0) {
          events.push({ type: 'delta', messageId, text: fullText })
        }
        // Thinking before the words. Emitting the message first left a reasoning
        // row after the reply, which the transcript read as more work and hid the
        // answer as "finished without a reply".
        for (const block of message['content']) {
          if (!isRecord(block) || asString(block['type']) !== 'thinking') continue
          const text = asString(block['thinking'])?.trim()
          if (text !== undefined && text.length > 0) {
            events.push({ type: 'reasoning', text: text.slice(0, REASONING_LIMIT) })
          }
        }
        const completed = this.finishMessage(fullText.length > 0 ? fullText : this.currentText)
        if (completed !== undefined) events.push(completed)
        for (const block of message['content']) {
          if (!isRecord(block) || asString(block['type']) !== 'tool_use') continue
          const tool = asString(block['name'])
          if (tool === undefined) continue
          const toolCallId = asString(block['id'])
          if (/^(TodoWrite|todo_write)$/i.test(tool)) {
            const todos = todosFromToolInput(block['input'])
            if (todos !== undefined) {
              if (toolCallId !== undefined) this.todoToolCalls.add(toolCallId)
              events.push({ type: 'todo_update', todos })
              continue
            }
          }
          // The card is the transcript event. Emitting the MCP call as tool_use
          // would put a second chrome row next to it, against the ask-user decision.
          if (isAskUserTool(tool) || isCodexSubagentTool(tool)) {
            if (toolCallId !== undefined) this.hiddenToolCalls.add(toolCallId)
            continue
          }
          const background = this.followsBackground && toolCallId !== undefined && startsBackground(tool, block['input'])
          if (background) {
            this.backgroundCalls.add(toolCallId)
            this.turnRows.add(toolCallId)
            // Kept as written: the wake redacts it by exact match.
            const description = SHELL_TOOL.test(tool) && isRecord(block['input']) ? asString(block['input']['description']) : undefined
            if (description !== undefined && description.trim() !== '') this.launchDescriptions.set(toolCallId, description)
          }
          if (this.followsBackground && toolCallId !== undefined && tool === 'SendMessage') {
            this.heldMessages.set(toolCallId, { type: 'tool_use', toolCallId, ...describeTool(tool, block['input']) })
            continue
          }
          // bypassPermissions rewrites Read/Edit through Bash. Translate the
          // command the same way Codex already did, or the activity list hides it.
          if (SHELL_TOOL.test(tool) && isRecord(block['input'])) {
            const command = asString(block['input']['command'])
            if (command !== undefined && command.trim().length > 0) {
              events.push({
                type: 'tool_use',
                ...(toolCallId === undefined ? {} : { toolCallId }),
                ...describeCommand(command, fileExists, asString(block['input']['description'])),
                ...(background ? { background: true } : {}),
              })
              continue
            }
          }
          const edits = editsFromToolInput(tool, block['input'], fileExists)
          const launch = /^(Agent|Task|spawn_subagent)$/i.test(tool)
          if (launch && toolCallId !== undefined) this.subagentToolCalls.add(toolCallId)
          const agentType = launch && isRecord(block['input'])
            ? asString(block['input']['subagent_type']) ?? asString(block['input']['agent_type'])
            : undefined
          events.push({
            type: 'tool_use',
            ...describeTool(tool, block['input']),
            ...(toolCallId === undefined ? {} : { toolCallId }),
            ...(agentType === undefined ? {} : { agentType }),
            ...(edits === undefined ? {} : { edits }),
            ...(background ? { background: true } : {}),
          })
        }
        if (this.followsBackground) {
          for (const event of events) {
            if (event.type === 'tool_use' && event.toolCallId !== undefined && event.background !== true) this.openCalls.set(event.toolCallId, event)
          }
        }
        return events
      }
      case 'user': {
        const message = parsed['message']
        if (!isRecord(message) || !Array.isArray(message['content'])) return []
        const events: RuntimeEvent[] = []
        for (const block of message['content']) {
          if (!isRecord(block) || asString(block['type']) !== 'tool_result') continue
          const reported = asString(block['tool_use_id'])
          if (reported === undefined) continue
          const toolCallId = this.rowOf(reported)
          this.openCalls.delete(toolCallId)
          for (const [taskId, task] of this.foregroundTasks) if (task.toolCallId === toolCallId) this.foregroundTasks.delete(taskId)
          if (this.todoToolCalls.delete(toolCallId) || this.hiddenToolCalls.delete(toolCallId)) continue
          // The receipt of a background launch, not its outcome: the row waits for the task.
          // A launch the CLI refused started nothing, so its error settles the row now.
          if (this.backgroundCalls.has(toolCallId)) {
            this.onBackgroundAck?.(toolCallId)
            if (block['is_error'] !== true) continue
            this.backgroundCalls.delete(toolCallId)
            this.launchDescriptions.delete(toolCallId)
          }
          const held = this.heldMessages.get(toolCallId)
          if (held !== undefined) {
            this.heldMessages.delete(toolCallId)
            events.push(held)
          }
          const output = this.subagentToolCalls.delete(toolCallId) ? subagentOutput(block['content']) : undefined
          const error = block['is_error'] === true ? errorText(block['content']) : undefined
          events.push({
            type: 'tool_result',
            toolCallId,
            outcome: block['is_error'] === true ? 'error' : 'success',
            ...(output === undefined ? {} : { output }),
            ...(error === undefined ? {} : { error }),
          })
        }
        return events
      }
      case 'result': {
        const cumulativeCost = this.includeCostUsd ? asNumber(parsed['total_cost_usd']) : undefined
        const baseline = this.cumulativeCostUsd
        const costUsd = cumulativeCost === undefined || baseline === undefined ? undefined
          // A total below the baseline was not restored, so it is this process's own.
          : cumulativeCost >= baseline ? cumulativeCost - baseline : cumulativeCost
        // Failed runs cost money too; do not charge them again on the next success.
        if (cumulativeCost !== undefined) this.cumulativeCostUsd = cumulativeCost
        this.sessionId = asString(parsed['session_id']) ?? this.sessionId
        if (cumulativeCost !== undefined && this.sessionId !== undefined) this.costTotals?.set(this.sessionId, cumulativeCost)
        const origin = isRecord(parsed['origin']) ? asString(parsed['origin']['kind']) : undefined
        const answered = parsed['user_message_uuids']
        this.lastResultWasWake = origin !== undefined && origin !== 'human' && !(Array.isArray(answered) && answered.length > 0)
        const text = asString(parsed['result']) ?? ''
        const failed = parsed['is_error'] === true || asString(parsed['subtype']) !== 'success'
        // Settled before the result, so whether the turn still waits counts only work that runs.
        const events = this.reconcileVanished()
        if (failed) {
          return [...events, { type: 'error', message: text.length > 0 ? text : failedTurnMessage(parsed) }]
        }
        const completed = this.finishMessage(this.currentText)
        if (completed !== undefined) events.push(completed)
        const usage = toUsage(
          parsed['usage'],
          costUsd,
        )
        const result: Extract<RuntimeEvent, { type: 'result' }> = { type: 'result', text }
        if (usage !== undefined) result.usage = usage
        if (this.lastPromptTokens !== undefined) {
          result.contextTokens = this.lastPromptTokens
          // Only alongside a fill. A threshold with nothing to measure against is
          // noise, and a result that reported no context must stay empty of it.
          if (this.autoCompactTokens !== undefined) result.autoCompactTokens = this.autoCompactTokens
        }
        if (this.reportedModel !== undefined) result.reportedModel = this.reportedModel
        if (this.sessionId !== undefined) result.sessionId = this.sessionId
        events.push(result)
        return events
      }
      default:
        return []
    }
  }
}

/** Stands in for process-group signals in tests. */
export type SignalGroupFn = (child: ChildLike, signal: 'SIGSTOP' | 'SIGCONT') => void

/** The CLI and every process it started share one group, so one signal pauses them all. */
const defaultSignalGroup: SignalGroupFn = (child, signal) => {
  if (!isSignallableGroupPid(child.pid)) return
  try {
    process.kill(-child.pid, signal)
  } catch {
    try { child.kill(signal) } catch { /* Already gone. */ }
  }
}

/**
 * A line that opens a run of the main thread: the CLI is about to spend tokens. Each
 * run starts with `init`; a top-level message or result means one is already under
 * way. Helper lines carry a parent id and never count.
 */
function startsRun(line: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return false
  }
  if (!isRecord(parsed) || parsed['parent_tool_use_id'] != null) return false
  const type = asString(parsed['type'])
  if (type === 'system') return parsed['subtype'] === 'init'
  return type === 'assistant' || type === 'result'
}

type EndedItem = Extract<LiveSessionEvent, { type: 'wake' }>['ended'][number]

/**
 * One CLI process and what outlives a single turn of it: the parser's view of the
 * session, stdin, the error tail and where its stdout lines go next. A turn that ends
 * while background work it started still runs hands it to a live session instead of
 * ending it, and the persona's next turn in that thread picks it up again.
 */
interface ClaudeProcess {
  readonly child: ChildLike
  readonly parser: StreamParser
  readonly threadId: string
  readonly agentId: string
  readonly model: string | undefined
  readonly effort: AgentConfig['effort']
  stderr: string
  inputOpen: boolean
  reportsCommands: boolean
  /** Paused with SIGSTOP while a wake it asked for waits to be admitted. */
  frozen: boolean
  termination: Promise<void> | undefined
  terminationReady: boolean
  /** Every value a turn granted this process, so its output is redacted against all of them. */
  readonly granted: { env: NodeJS.ProcessEnv; keys: readonly string[] }[]
  /** Background ends not yet named by a wake. */
  readonly ended: EndedItem[]
  /** Control requests waiting for their response, by request id. */
  readonly controls: Map<string, (ok: boolean) => void>
  onLine: (line: string) => void
  onClose: (code: number | null) => void
  onFail: (message: string) => void
}

/** A process no turn reads: its persona's turn ended while background work it started runs. */
interface Parked {
  readonly proc: ClaudeProcess
  /** The CLI asked to run. Its lines wait here unparsed, and the process is paused, until the wake turn attaches. */
  wake: boolean
  readonly held: string[]
}

/**
 * How long an attached turn waits for the CLI to take its MCP servers. The CLI answers
 * `mcp_set_servers` only once every changed server has connected or hit its own connect
 * limit (27s measured on 2.1.296, then success with a per-server error), and the
 * per-turn capability changes every connector's config, so the answer waits for the
 * slowest remote connector. Those took 8 to 14s on 2026-10-12, and the old 10s limit
 * killed healthy sessions and their background work. This limit sits above the CLI's
 * own, so it only catches a CLI that stopped answering.
 */
export const MCP_SWAP_TIMEOUT_MS = 45_000
/** The error an attached turn ends with when the CLI would not take its MCP servers. */
export const MCP_SWAP_FAILED = 'Claude did not take this turn’s connectors, so Manor ended its live session and the background work still running in it.'

/** The installer Anthropic documents for macOS, Linux and WSL (code.claude.com/docs/en/setup). */
export const CLAUDE_INSTALLER_URL = 'https://claude.ai/install.sh'

/**
 * Wraps the subscription-authenticated `claude` CLI in print mode. One process per
 * turn, prompt on stdin, `stream-json` on stdout, except where background work keeps
 * it alive as a live session past its turn. Nothing outside this file may touch the CLI.
 */
export function createClaudeDriver(options: ClaudeDriverOptions): Driver {
  // Not a constant: the CLI can be installed while the server is up, and a bare name
  // that failed once would keep failing where PATH does not hold `~/.local/bin`.
  let command = options.command ?? resolveCliCommand('claude')
  const timeouts = resolveTurnTimeouts(options)
  const spawnFn = options.spawnFn ?? defaultSpawn
  const signalGroup = options.signalGroup ?? defaultSignalGroup
  /** Parked live sessions by thread and persona. A session a turn reads is not in here. */
  const live = new Map<string, Parked>()
  // The persona is the system prompt every turn; only the turn's changing blocks need bookkeeping.
  const prepareContext = createResumedContext({ retainsCharacter: false })
  const liveKey = (threadId: string, agentId: string) => `${threadId}\u0000${agentId}`
  const costTotals = new Map<string, number>()

  const report = (event: LiveSessionEvent) => {
    try {
      options.onLiveSession?.(event)
    } catch {
      // A listener that throws must not take the session down with it.
    }
  }
  const redactWith = (proc: ClaudeProcess) => (message: string) =>
    proc.granted.reduce((text, { env, keys }) => redactGrantedEnvValues(text, env, keys), message)
  /** A task title as it may leave the driver: no granted value in it, within the wake row's limit. */
  // Credential shapes go before the cut, which could leave too little of one to recognise.
  const safeTitle = (proc: ClaudeProcess, title: string) => scrubCredentialText(title, redactWith(proc)).slice(0, WAKE_TITLE_MAX)
  const freeze = (proc: ClaudeProcess) => {
    if (proc.frozen) return
    proc.frozen = true
    signalGroup(proc.child, 'SIGSTOP')
  }
  const thaw = (proc: ClaudeProcess) => {
    if (!proc.frozen) return
    proc.frozen = false
    signalGroup(proc.child, 'SIGCONT')
  }
  /** A paused process cannot act on SIGTERM, so it is resumed first. */
  const terminate = (proc: ClaudeProcess) => {
    thaw(proc)
    proc.termination ??= terminateCliTree(proc.child).then(() => { proc.terminationReady = true })
  }
  /** A row an earlier turn launched settled; that turn is over, so the session reports it. */
  const reportRow = (proc: ClaudeProcess, event: RuntimeEvent) => {
    if (event.type !== 'tool_result') return
    report({ type: 'row', threadId: proc.threadId, agentId: proc.agentId, event: redactToolActivity(event, redactWith(proc)) })
  }
  /** Settles the session's open background rows as stopped, through the session. */
  const stopSessionRows = (proc: ClaudeProcess) => {
    for (const event of proc.parser.stopOpenBackground()) reportRow(proc, event)
  }

  /**
   * Hands a process whose turn just ended to a live session. Background ends settle
   * their rows through the session; the first sign that the CLI will run on its own,
   * a finished task or a run starting, pauses the whole process group and asks Manor
   * for a wake, so no token is spent and nothing runs beside another turn until the
   * wake is admitted.
   */
  const park = (proc: ClaudeProcess): void => {
    const key = liveKey(proc.threadId, proc.agentId)
    const parked: Parked = { proc, wake: false, held: [] }
    live.set(key, parked)
    const requestWake = () => {
      if (parked.wake) return
      parked.wake = true
      freeze(proc)
      report({
        type: 'wake', threadId: proc.threadId, agentId: proc.agentId,
        ended: proc.ended.splice(0).map((item) => ({ ...item, title: safeTitle(proc, item.title) })),
      })
    }
    proc.onLine = (line) => {
      if (parked.wake) {
        parked.held.push(line)
        return
      }
      if (startsRun(line)) {
        // Work that ended without its notification settles first, so the wake names it.
        for (const event of proc.parser.reconcileVanished()) reportRow(proc, event)
        parked.held.push(line)
        requestWake()
        return
      }
      // Helper steps after the turn stay out of the transcript; only a row's end is kept.
      for (const event of proc.parser.handle(line)) {
        if (event.type === 'tool_result' && event.parentToolCallId === undefined) reportRow(proc, event)
      }
      if (proc.parser.unansweredNotification) requestWake()
    }
    proc.onClose = () => {
      if (live.get(key) === parked) live.delete(key)
      stopSessionRows(proc)
      report({ type: 'closed', threadId: proc.threadId, agentId: proc.agentId })
    }
    proc.onFail = () => terminate(proc)
  }

  /** Sends one control request and waits for its answer, bounded; false on error or timeout. */
  const control = (proc: ClaudeProcess, request: Record<string, unknown>): Promise<boolean> => {
    const id = randomUUID()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        proc.controls.delete(id)
        resolve(false)
      }, MCP_SWAP_TIMEOUT_MS)
      timer.unref?.()
      proc.controls.set(id, (ok) => {
        clearTimeout(timer)
        resolve(ok)
      })
      try {
        proc.child.stdin?.write(`${JSON.stringify({ type: 'control_request', request_id: id, request })}\n`)
      } catch {
        proc.controls.delete(id)
        clearTimeout(timer)
        resolve(false)
      }
    })
  }

  /** Answers a control response line; true when the line was one. */
  const controlResponse = (proc: ClaudeProcess, line: string): boolean => {
    if (!line.includes('"control_response"')) return false
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      return false
    }
    if (!isRecord(parsed) || parsed['type'] !== 'control_response') return false
    const response = isRecord(parsed['response']) ? parsed['response'] : {}
    const id = asString(response['request_id'])
    const done = id === undefined ? undefined : proc.controls.get(id)
    if (id !== undefined) proc.controls.delete(id)
    done?.(response['subtype'] === 'success')
    return true
  }

  return {
    describeRuntime: () => {
      command = options.command ?? resolveCliCommand('claude')
      return runtimeVersion(command)
    },
    // Anthropic's documented native installer. It needs no Node, puts the CLI in
    // `~/.local/bin` and leaves the shell profile alone.
    installCommand: () => Promise.resolve({
      command: '/bin/bash',
      args: ['-c', `curl -fsSL ${CLAUDE_INSTALLER_URL} | bash`],
      env: childProcessEnv(),
    }),
    describeAccount: async () => parseClaudeAccount(await runStatusCommand(command, ['auth', 'status', '--json'])),
    signInCommand: () => Promise.resolve({ command, args: ['auth', 'login', '--claudeai'], env: childProcessEnv() }),
    // Claude's default `latest` channel is the npm `latest` tag, native install or not.
    checkForUpdate: () => checkAgainstNpm(command, '@anthropic-ai/claude-code', true),
    installUpdate: () => runUpdater(command, ['update']),
    readProviderUsage: () =>
      readClaudeProviderUsage({
        command,
        spawnFn,
        // The probe sends no prompt and writes nothing, so it needs a directory that
        // exists rather than a workspace of its own.
        cwd: tmpdir(),
      }),

    compactSession: (input) => {
      // A compacted history may no longer hold the blocks it was given.
      prepareContext.forget(input.sessionId)
      return runTurn(compactTurnInput(input), CLAUDE_COMPACT_COMMAND, false)
    },

    startTurn(input: TurnInput): TurnHandle {
      const context = prepareContext(input)
      return context.track(runTurn(
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
        true,
        context,
      ), input.sessionId)
    },

    liveSession(threadId, agentId) {
      const parked = live.get(liveKey(threadId, agentId))
      if (parked === undefined) return undefined
      const { proc } = parked
      return {
        driver: 'claude',
        sessionId: proc.parser.sessionId,
        model: proc.model,
        effort: proc.effort,
        running: proc.parser.runningBackground().map((item) => ({ ...item, title: safeTitle(proc, item.title) })),
        wakeHeld: parked.wake,
      }
    },

    busyLiveWork: () => [...live.values()].flatMap(({ proc }) => {
      const running = proc.parser.runningBackground()
      return running.length === 0 ? [] : [{ threadId: proc.threadId, running: running.map((item) => ({ ...item, title: safeTitle(proc, item.title) })) }]
    }),

    closeLiveSession(threadId, agentId) {
      const stopped: string[] = []
      for (const [key, parked] of [...live]) {
        const { proc } = parked
        if (proc.threadId !== threadId || (agentId !== undefined && proc.agentId !== agentId)) continue
        live.delete(key)
        stopped.push(...[...proc.parser.backgroundTasks.values()].map((task) => safeTitle(proc, task.title)))
        proc.onLine = () => {}
        proc.onClose = () => {}
        proc.onFail = () => {}
        stopSessionRows(proc)
        terminate(proc)
        report({ type: 'closed', threadId, agentId: proc.agentId })
      }
      return stopped
    },
  }

  function runTurn(input: TurnInput, prompt: string, steerable: boolean, delivery?: PreparedContext): TurnHandle {
      const queue = new AsyncQueue<RuntimeEvent>()
      if (cliShutdownStarted()) {
        queue.push({ type: 'error', message: 'server is shutting down' })
        queue.close()
        return { events: queue, stop() {} }
      }
      const key = liveKey(input.threadId, input.agent.id)
      const parked = live.get(key)
      // The persona's next turn on the same CLI session takes over its live session.
      // Anything else on that session (a compaction) would be a second process on it.
      const attaching = parked !== undefined && steerable && input.sessionId === parked.proc.parser.sessionId
      if (parked !== undefined && !attaching && input.sessionId !== undefined && input.sessionId === parked.proc.parser.sessionId) {
        queue.push({ type: 'error', message: 'This session is still running background work; it cannot be compacted now.' })
        queue.close()
        return { events: queue, stop() {} }
      }
      if (attaching) live.delete(key)
      /** This turn carries the run the CLI started on its own, so it writes no prompt. */
      const wakeRun = attaching && input.wakeRun === true && parked.wake
      if (wakeRun) delivery?.skip()
      const parser = attaching
        ? parked.proc.parser
        : new StreamParser(true, true, costTotals, claudeAutocompactTokens())
      if (!attaching && input.sessionId !== undefined) parser.resumeCostFrom(input.sessionId)
      const startedAt = Date.now()
      const { sourceEnv, grantedKeys } = attachedMcpEnvironment(input.mcpServers ?? [])
      let proc: ClaudeProcess | undefined = attaching ? parked.proc : undefined
      const redact = (message: string) => proc === undefined
        ? redactGrantedEnvValues(message, sourceEnv, grantedKeys)
        : redactWith(proc)(message)

      let stopped = false
      /** True once the CLI has spoken for itself, with a result or a failed result. */
      let sawTerminalLine = false
      let settled = false
      let settlingTerminal = false
      /** The process went on as a live session; this turn no longer owns it. */
      let parkedAway = false
      /** An attached turn writes its prompt only once the CLI has its MCP servers. */
      let promptWritten = !attaching
      let resultGrace: NodeJS.Timeout | undefined
      /** A process this turn handed to a live session is the session's to end, not this turn's. */
      const killChild = () => {
        if (proc !== undefined && !parkedAway) terminate(proc)
      }

      /** Steering written but not yet started. A result while one waits is not the turn's last. */
      const queuedSteers = new Set<string>()
      /** Unsettled steers. `received` ends the receipt clock; only a start settles as accepted. */
      const steerAcks = new Map<string, { received: () => void; settle: (delivery: 'accepted' | 'uncertain') => void }>()
      /** Results of runs that ended while an addition still waited, folded into the last one. */
      let heldResult: ResultEvent | undefined
      /** The CLI compacted at least once in this turn; see `consume`. */
      let compactedHistory = false
      /** A run the prompt or an addition started has ended; a wake replayed on resume does not count. */
      let answeredPrompt = false
      /**
       * The turn answered but its background tasks still run, and no main request is
       * working. Ending now would kill them with the process, so the turn stays open
       * and busy, folds each wake run into its result and ends when nothing is
       * outstanding, or at the cap. The next main request ends the idle exemption.
       * Only turns somebody waits on as one answer hold; the rest go live.
       */
      let idleWaitingOnBackground = false
      let backgroundCap: NodeJS.Timeout | undefined
      const waitingOnBackground = () => parser.backgroundTasks.size > 0 || parser.unansweredNotification
      /** The wait the client was last told about, so each change is sent once. */
      let shownWait = { agents: 0, commands: 0 }
      /** While the turn only waits, the client shows what it waits on instead of Thinking. */
      const showWait = () => {
        if (sawTerminalLine) return
        const next = idleWaitingOnBackground ? parser.backgroundCounts() : { agents: 0, commands: 0 }
        if (next.agents === shownWait.agents && next.commands === shownWait.commands) return
        shownWait = next
        queue.push({ type: 'background_wait', ...next })
      }
      const writeInput = (content: unknown, uuid: string, priority?: 'next') => {
        proc?.child.stdin?.write(`${JSON.stringify({
          type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: '', uuid,
          ...(priority === undefined ? {} : { priority }),
        })}\n`)
      }
      const closeInput = () => {
        if (proc === undefined || !proc.inputOpen) return
        proc.inputOpen = false
        proc.child.stdin?.end()
      }

      /**
       * Rows this turn shows. In a live session the process also reports work an
       * earlier turn launched: its end settles that turn's row through the session, and
       * its helper steps are not this turn's to show.
       */
      const ownRows = new Set<string>()
      const deliver = (event: RuntimeEvent) => {
        const parent = 'parentToolCallId' in event ? event.parentToolCallId : undefined
        if (parent === undefined && event.type === 'tool_use' && event.toolCallId !== undefined) ownRows.add(event.toolCallId)
        if (attaching && proc !== undefined) {
          if (parent === undefined && event.type === 'tool_result' && !ownRows.has(event.toolCallId)) {
            reportRow(proc, event)
            return
          }
          if (parent !== undefined && !ownRows.has(parent)) return
        }
        queue.push(event)
      }
      /** The process is going down: every background row it still holds settles as stopped. */
      const closeOpenRows = () => {
        for (const event of parser.stopOpenBackground()) deliver(event)
      }

      const finish = () => {
        if (settled) return
        if (!parkedAway && proc?.termination !== undefined && !proc.terminationReady) {
          void proc.termination.then(finish)
          return
        }
        settled = true
        if (resultGrace !== undefined) clearTimeout(resultGrace)
        if (backgroundCap !== undefined) clearTimeout(backgroundCap)
        timers.clear()
        for (const ack of [...steerAcks.values()]) ack.settle('uncertain')
        releaseHeldMessages()
        queue.close()
      }

      /** A SendMessage nothing answered still happened; it shows as the plain call it was. */
      const releaseHeldMessages = () => {
        for (const held of parser.flushHeldMessages()) deliver(redactToolActivity(held, redact))
      }

      const settleTerminal = async () => {
        if (settled || settlingTerminal) return
        settlingTerminal = true
        try {
          if (!stopped) {
            for (const image of await collectGeneratedImages([input.cwd], startedAt)) {
              queue.push({ type: 'attachment', image })
            }
          }
        } finally {
          finish()
        }
      }

      const fail = (message: string) => {
        if (settled || stopped || parkedAway) return
        closeOpenRows()
        queue.push({ type: 'error', message: redact(message) })
        finish()
      }

      // Armed before the spawn, so a CLI that never starts is still on a clock.
      const clock = startTurnTimers(timeouts, (message) => {
        killChild()
        fail(message)
      })
      // Neither a closing helper tool nor an answered ask-user may restart the clock a background wait paused.
      const timers = bindIdleClock(options.idleGate, input.threadId, input.agent.id, {
        ...clock,
        resume: () => { if (!idleWaitingOnBackground) clock.resume() },
      })
      const toolIdle = watchInFlightTools(timers)
      parser.onMainRequest = () => {
        if (!idleWaitingOnBackground) return
        idleWaitingOnBackground = false
        showWait()
        if (!toolIdle.busy() && options.idleGate?.held(input.threadId, input.agent.id) !== true) clock.resume()
      }
      parser.onBackgroundAck = (toolCallId) => toolIdle.see({ type: 'tool_result', toolCallId })

      const endWith = (event: RuntimeEvent) => {
        releaseHeldMessages()
        closeOpenRows()
        sawTerminalLine = true
        if (backgroundCap !== undefined) clearTimeout(backgroundCap)
        closeInput()
        if (resultGrace === undefined) {
          resultGrace = setTimeout(() => {
            killChild()
            void settleTerminal()
          }, options.resultGraceMs ?? 2_000)
          resultGrace.unref?.()
        }
        queue.push(event)
      }

      /**
       * The answer is in and background work this persona started still runs, in a
       * room that wakes: the turn ends now and the process lives on as a live session.
       */
      const parkTurn = (result: ResultEvent) => {
        if (proc === undefined) return
        releaseHeldMessages()
        sawTerminalLine = true
        parkedAway = true
        queue.push(result)
        park(proc)
        // Images the turn made still come with its answer, as at any other end.
        void settleTerminal()
      }

      /**
       * Waiting on a task is the work, so the idle clock stays paused until a main
       * request runs again; the cap bounds the whole hold. At the cap the error event
       * becomes a visible note beside the answer, and ending kills the tree as any
       * finished turn does.
       */
      const holdForBackground = () => {
        idleWaitingOnBackground = true
        showWait()
        clock.pause()
        if (backgroundCap !== undefined) return
        const holdMs = options.backgroundHoldMs ?? DEFAULT_BACKGROUND_HOLD_MS
        backgroundCap = setTimeout(() => {
          if (settled || sawTerminalLine || heldResult === undefined) return
          const running = [...parser.backgroundTasks.values()].map((task) => task.title)
          queue.push({ type: 'error', message: redact(backgroundCapNote(holdMs, running, 'Claude')) })
          endWith(heldResult)
        }, holdMs)
        backgroundCap.unref?.()
      }

      /**
       * The CLI reads a steer only at its next model request, so a running foreground
       * Bash command or helper would hold it until it ends, often minutes. Moving that
       * work to the background (the CLI's Ctrl+B) lets the steer in now; the work goes
       * on and reports like any background launch. Best effort: a refusal or a timeout
       * only means the steer waits for the work, as it did before.
       */
      const moveToBackground = (toolCallId?: string) => {
        if (proc === undefined || settled || stopped) return
        void control(proc, { subtype: 'background_tasks', ...(toolCallId === undefined ? {} : { tool_use_id: toolCallId }) })
      }
      // Work that starts before the CLI read a steer would hold it the same way.
      // Work started after the steer was read is the answer to it and stays in front.
      parser.onForegroundTask = (toolCallId) => {
        if (queuedSteers.size > 0) moveToBackground(toolCallId)
      }

      // `next` waits for a tool boundary in the running run. Without one the CLI ends
      // that run first and answers the addition in another; both stay this turn.
      // Queued is receipt, not consumption: a queued addition can still be cancelled or
      // die with the process, so only started or completed counts as delivered.
      parser.onCommand = (uuid, state) => {
        if (proc !== undefined) proc.reportsCommands = true
        const ack = steerAcks.get(uuid)
        if (state === 'queued') {
          ack?.received()
          return
        }
        ack?.settle(state === 'started' || state === 'completed' ? 'accepted' : 'uncertain')
        queuedSteers.delete(uuid)
      }

      /**
       * The idle clock is reset by the line, not by what the parser made of it: the
       * parser returns nothing for line types it does not model, and a CLI printing
       * only those for five minutes is demonstrably alive. A truly hung CLI writes
       * no bytes at all, which is still caught. An open tool pauses that clock,
       * because the wait is the work.
       */
      const consume = (line: string) => {
        timers.touch()
        // The CLI compacted its own history mid-turn; what it was given earlier may be gone.
        // The blocks go out again from here, and the turn's result carries the fact on to
        // the runner, which holds the rest of the per-session state a compaction invalidates.
        if (line.includes('"compact_boundary"')) {
          compactedHistory = true
          delivery?.invalidate()
        }
        const parsedEvents = parser.handle(line)
        if (parser.sessionId !== undefined) input.onStage?.('threadReady')
        for (const event of parsedEvents) {
          // After Stop the turn shows nothing more: the rows it closed stay stopped while the process goes down.
          if (parkedAway || stopped) break
          toolIdle.see(event)
          const located = event.type === 'tool_use' && event.command === undefined && event.edits !== undefined
            ? { ...event, edits: withEditOrigins(event.edits, input.cwd, input.repoPaths) } : event
          const safeEvent =
            located.type === 'error'
              ? { ...located, message: redact(located.message) }
              : located.type === 'tool_use' || located.type === 'tool_result'
                ? redactToolActivity(located, redact)
                : located
          if (safeEvent.type === 'result') {
            // A wake after the turn's own result is not this turn's outcome.
            if (sawTerminalLine) continue
            // A wake turn's own run is its answer; any other wake run folds into the next.
            if (wakeRun || !parser.lastResultWasWake) answeredPrompt = true
            const merged = heldResult === undefined ? safeEvent : mergeResults(heldResult, safeEvent)
            const result: ResultEvent = compactedHistory ? { ...merged, compacted: true } : merged
            const background = answeredPrompt && waitingOnBackground()
            if (input.live === true && background && queuedSteers.size === 0 && !stopped) {
              heldResult = undefined
              parkTurn(result)
              continue
            }
            heldResult = queuedSteers.size > 0 || !answeredPrompt || background ? result : undefined
            if (heldResult === undefined) endWith(result)
            else if (background) holdForBackground()
          } else if (safeEvent.type === 'error') {
            // A deleted transcript ends in a failed result line before any init.
            const resumeFailed = input.sessionId !== undefined && !parser.sawInit
              && MISSING_CONVERSATION.test(safeEvent.message)
            endWith(resumeFailed ? { ...safeEvent, message: `${RESUME_FAILURE_PREFIX}${safeEvent.message}` } : safeEvent)
          } else deliver(safeEvent)
        }
        // A notification shrinks what the turn waits on without starting a request.
        if (idleWaitingOnBackground) showWait()
      }

      /** The process ended under this turn. */
      const closed = async (code: number | null) => {
        if (stopped || settled) {
          finish()
          return
        }
        // A held result waits for more work, so closing before that work answers is a failure.
        if (sawTerminalLine) {
          await settleTerminal()
          return
        }
        const stderr = proc?.stderr ?? ''
        const detail = stderr.trim().length > 0 ? stderr.trim()
          : queuedSteers.size > 0 ? 'Claude exited before it took your addition.'
            : heldResult !== undefined && waitingOnBackground() ? 'Claude exited before its background work reported back.' : `exit code ${code ?? 'unknown'}`
        // Once init arrived, later failures belong to the running turn.
        const resumeFailed = input.sessionId !== undefined && !parser.sawInit
        fail(resumeFailed ? `${RESUME_FAILURE_PREFIX}${detail}` : detail)
      }

      if (attaching) {
        const taken = parked.proc
        proc = taken
        taken.granted.push({ env: sourceEnv, keys: grantedKeys })
        taken.onLine = consume
        taken.onClose = (code) => void closed(code)
        taken.onFail = fail
        parser.beginTurn()
        queue.throttle(taken.child.stdout)
        input.onStage?.('processStarted')
        // What the CLI already said in the run it started on its own. A line may hand the
        // process to a session again, so each goes wherever the process now listens.
        for (const line of parked.held) taken.onLine(line)
        if (!settled) {
          thaw(taken)
          void (async () => {
            // The CLI applies the servers before its next run when it is idle (measured on
            // 2.1.289); a run it already started may still miss them.
            const swapped = await control(taken, {
              subtype: 'mcp_set_servers',
              servers: liveMcpServers(input.mcpServers ?? [], childProcessEnv(sourceEnv, grantedKeys)),
            })
            // A turn that already answered is past needing them; its process may simply have exited.
            if (stopped || settled || parkedAway || sawTerminalLine) return
            // A refused or unanswered swap leaves the CLI on an earlier turn's connectors and
            // revoked capabilities. Nothing of this turn may run on them, so the session ends.
            if (!swapped) {
              killChild()
              fail(MCP_SWAP_FAILED)
              return
            }
            if (wakeRun) return
            writeInput(prompt, randomUUID())
            promptWritten = true
          })()
        }
      } else {
        let spawned: ChildLike
        try {
          spawned = spawnFn(command, buildArgs(input), {
            cwd: input.cwd,
            env: {
              ...agentTurnEnv(sourceEnv, grantedKeys),
              ...entrypointEnv(),
              ...LAZY_MCP_ENV,
              ...TODO_TOOL_ENV,
              ...(input.promptCaching === 'off' ? { DISABLE_PROMPT_CACHING: '1' } : {}),
              ...(input.singleSession === true ? { CLAUDE_CODE_SUBAGENT_MODEL: input.agent.model } : {}),
            },
          })
        } catch (error: unknown) {
          fail(`could not start ${command}: ${error instanceof Error ? error.message : String(error)}`)
          return { events: queue, stop() {} }
        }
        const fresh: ClaudeProcess = {
          child: spawned,
          parser,
          threadId: input.threadId,
          agentId: input.agent.id,
          model: input.agent.model,
          effort: input.agent.effort,
          stderr: '',
          inputOpen: spawned.stdin != null,
          reportsCommands: false,
          frozen: false,
          termination: undefined,
          terminationReady: false,
          granted: [{ env: sourceEnv, keys: grantedKeys }],
          ended: [],
          controls: new Map(),
          onLine: consume,
          onClose: (code) => void closed(code),
          onFail: fail,
        }
        proc = fresh
        parser.onBackgroundEnded = (item) => fresh.ended.push(item)
        trackCliChild(spawned)

        input.onStage?.('processStarted')
        spawned.stdout?.setEncoding?.('utf8')
        // A slow consumer pauses this stdout instead of buffering without limit.
        queue.throttle(spawned.stdout)
        let buffer = ''
        spawned.stdout?.on('data', (chunk: string | Buffer) => {
          buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            if (line.trim().length === 0 || controlResponse(fresh, line)) continue
            fresh.onLine(line)
          }
        })

        spawned.stderr?.setEncoding?.('utf8')
        spawned.stderr?.on('data', (chunk: string | Buffer) => {
          fresh.stderr = appendChildErrorTail(
            fresh.stderr,
            typeof chunk === 'string' ? chunk : chunk.toString('utf8'),
            redactWith(fresh),
          )
        })

        spawned.on('error', (error: Error) => fresh.onFail(`could not start ${command}: ${error.message}`))
        spawned.stdin?.on('error', (error: Error) => fresh.onFail(`could not write to ${command} stdin: ${error.message}`))

        spawned.on('close', (code: number | null) => {
          if (buffer.trim().length > 0) {
            const rest = buffer
            buffer = ''
            if (!controlResponse(fresh, rest)) fresh.onLine(rest)
          }
          for (const done of [...fresh.controls.values()]) done(false)
          fresh.controls.clear()
          fresh.onClose(code)
        })

        writeInput(prompt, randomUUID())
      }

      return {
        events: queue,
        async steer(event) {
          if (!steerable || proc === undefined || !proc.reportsCommands || !proc.inputOpen || !promptWritten ||
            stopped || settled || sawTerminalLine) return 'refused'
          const uuid = randomUUID()
          return new Promise((resolve) => {
            // The receipt clock only. Once queued, the addition waits for its tool
            // boundary however long the running tool takes; the turn's own clocks bound it.
            const timer = setTimeout(() => settle('uncertain'), options.steeringTimeoutMs ?? 10_000)
            const settle = (delivery: 'accepted' | 'uncertain') => {
              clearTimeout(timer)
              steerAcks.delete(uuid)
              resolve(delivery)
            }
            steerAcks.set(uuid, { received: () => clearTimeout(timer), settle })
            queuedSteers.add(uuid)
            try {
              writeInput(steeringContent(event, options.agents(), input), uuid, 'next')
            } catch {
              queuedSteers.delete(uuid)
              settle('uncertain')
              return
            }
            if (parser.runsForegroundTask()) moveToBackground()
          })
        },
        stop() {
          // A turn that handed its process to a live session is over; Stop on the
          // chat closes that session through `closeLiveSession`.
          if (parkedAway || stopped) return
          stopped = true
          if (!settled) closeOpenRows()
          killChild()
          finish()
        },
      }
  }
}
