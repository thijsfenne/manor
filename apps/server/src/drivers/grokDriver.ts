import { spawn } from 'node:child_process'
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { lstat, mkdir, readlink, realpath, rename, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  mcpHttpUrl,
  WAKE_TITLE_MAX,
  type AgentConfig,
  type AttachedMcpServer,
  type Driver,
  type RuntimeEvent,
  type TurnHandle,
  type TurnInput,
} from '@manor/contracts'
import { AsyncQueue } from '../asyncQueue.js'
import { dataPaths } from '../paths.js'
import { runtimeVersion } from './runtimeVersion.js'
import { checkGrok, runUpdater } from './providerUpdate.js'
import {
  agentTurnEnv,
  appendChildErrorTail,
  attachedMcpEnvironment,
  childProcessEnv,
  resolveCliCommand,
  redactGrantedEnvValues,
} from '../childEnv.js'
import { catchUpStyle, composeCatchUp } from '../composer.js'
import { StreamParser } from './claudeDriver.js'
import { RESUME_FAILURE_PREFIX } from './resumeFailure.js'
import { collectGeneratedImages } from './generatedImages.js'
import { redactToolActivity } from './toolActivity.js'
import { withEditOrigins } from './edits.js'
import { readGrokProviderUsage } from './grokUsage.js'
import { compactTurnInput, GROK_COMPACT_COMMAND } from './sessionCompact.js'
import { bindIdleClock, resolveTurnTimeouts, startTurnTimers, watchInFlightTools, type TurnIdleGate } from './turnTimers.js'
import { mcpHttpHeaderEnvMap } from '../mcp/httpHeaders.js'
import { createResumedContext } from './resumedContext.js'
import { cliShutdownStarted, cliTreeGone, terminateCliTree, trackCliChild } from './childTermination.js'

/** Grok's headless stream uses the Anthropic Messages event envelope. */
export interface GrokChildLike {
  readonly pid?: number
  readonly stdout: NodeJS.ReadableStream | null
  readonly stderr: NodeJS.ReadableStream | null
  readonly stdin: NodeJS.WritableStream | null
  kill(signal?: NodeJS.Signals): boolean
  on(event: 'close', listener: (code: number | null) => void): void
  on(event: 'error', listener: (error: Error) => void): void
}

export interface GrokSpawnOptions {
  cwd: string
  env: NodeJS.ProcessEnv
}

export type GrokSpawnFn = (
  command: string,
  args: readonly string[],
  options: GrokSpawnOptions,
) => GrokChildLike

export interface GrokDriverOptions {
  agents: () => readonly AgentConfig[]
  command?: string
  timeoutMs?: number
  idleTimeoutMs?: number
  spawnFn?: GrokSpawnFn
  idleGate?: TurnIdleGate
}

const defaultSpawn: GrokSpawnFn = (command, args, options) =>
  spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    // Own process group so TERM/KILL can reach background shells after Grok exits.
    detached: true,
  })

// ---------------------------------------------------------------------------
// Isolation
// ---------------------------------------------------------------------------

/**
 * Grok discovers ~/.claude, ~/.agents and ~/.cursor in addition to its own home.
 * Pointing only GROK_HOME elsewhere therefore does not isolate a persona: measured
 * on grok 1.0.4, an empty Grok home still found 129 skills, 15 plugins and 19 MCP
 * servers. HOME and GROK_HOME both point at Manor's directory, with login files
 * linked in from the user's real Grok home. `auth.json` is the Grok account.
 * `mcp_credentials.json` is HTTP MCP OAuth (Figma). Linking only the first left
 * Figma 401 inside Manor after a working terminal login.
 */
const GROK_LOGIN_FILES = ['auth.json', 'mcp_credentials.json'] as const

/**
 * A regular login file below this size holds no login (`{}` after a logout or an
 * empty reset), so replacing it with the link never loses anything.
 */
export const GROK_SIGNED_OUT_MAX_BYTES = 16

export interface GrokLoginLinkReport {
  /** Detached copies newer than the real login, left in place because they may be the fresher login. */
  keptNewerCopies: string[]
  /** Login files that could not be healed, with the reason. */
  failed: { file: string; reason: string }[]
}

/** Points `linkPath` at `source` via a temp link and a rename, so the path is never empty. */
async function placeLink(source: string, linkPath: string): Promise<void> {
  const temp = `${linkPath}.${process.pid}.${Math.random().toString(36).slice(2)}.link`
  await symlink(source, temp)
  try {
    await rename(temp, linkPath)
  } catch (error: unknown) {
    await unlink(temp).catch(() => undefined)
    throw error
  }
}

/**
 * The Grok CLI writes login files with a temp file and a rename. A rename onto a
 * symlink replaces the link with a regular file, so after a token refresh or a logout
 * inside Manor the two homes drift apart. Run before every turn: it repairs a missing,
 * wrong, dangling or detached link and costs a few lstat calls when all is well.
 * It never writes into the real Grok home.
 */
export async function linkGrokLoginFiles(manorHome: string, realGrokHome: string): Promise<GrokLoginLinkReport> {
  const report: GrokLoginLinkReport = { keptNewerCopies: [], failed: [] }
  await mkdir(manorHome, { recursive: true })
  // Same folder (an explicit MANOR_GROK_HOME on the real Grok home, or a link to it): linking would turn the real login into a link to itself.
  const [manorReal, grokReal] = await Promise.all([realpath(manorHome), realpath(realGrokHome).catch(() => undefined)])
  if (grokReal === undefined || grokReal === manorReal) return report
  for (const file of GROK_LOGIN_FILES) {
    const source = path.join(realGrokHome, file)
    const linkPath = path.join(manorHome, file)
    try {
      const sourceStat = await stat(source).catch(() => undefined)
      if (sourceStat === undefined) continue
      if ((await realpath(source)) === (await realpath(linkPath).catch(() => undefined))) continue
      const current = await lstat(linkPath).catch(() => undefined)
      if (current === undefined) {
        await placeLink(source, linkPath)
      } else if (current.isSymbolicLink()) {
        const target = await readlink(linkPath)
        if (path.resolve(manorHome, target) !== path.resolve(source)) await placeLink(source, linkPath)
      } else if (current.isFile()) {
        const signedOut = current.size < GROK_SIGNED_OUT_MAX_BYTES
        if (signedOut || sourceStat.mtimeMs >= current.mtimeMs) await placeLink(source, linkPath)
        else report.keptNewerCopies.push(file)
      } else {
        report.failed.push({ file, reason: 'not a file or a link' })
      }
    } catch (error: unknown) {
      report.failed.push({ file, reason: (error as NodeJS.ErrnoException).code ?? (error as Error).message })
    }
  }
  return report
}

/** `MANOR_GROK_HOME`, else `grok-home` in Manor's data folder (`~/.manor` on a default install). */
export function resolveGrokHome(): string {
  return process.env.MANOR_GROK_HOME ?? dataPaths().grokHome
}

const warnedGrokLogin = new Set<string>()

function warnGrokLoginOnce(key: string, message: string): void {
  if (warnedGrokLogin.has(key)) return
  warnedGrokLogin.add(key)
  console.warn(`[manor] ${message}`)
}

export async function ensureGrokHome(realGrokHome = path.join(os.homedir(), '.grok')): Promise<string> {
  const home = resolveGrokHome()
  const report = await linkGrokLoginFiles(home, realGrokHome)
  for (const file of report.keptNewerCopies) {
    warnGrokLoginOnce(`newer:${file}`, `Grok ${file} in Manor's Grok home is newer than the real one and was left in place. Run grok login in a terminal if Grok stops answering in Manor`)
  }
  for (const { file, reason } of report.failed) {
    warnGrokLoginOnce(`failed:${file}`, `could not link Grok ${file} into Manor's Grok home (${reason})`)
  }
  return home
}

const tomlString = (value: string): string => JSON.stringify(value)

/** A week: in practice no limit, the turn's Stop ends the wait first. */
export const GROK_ASK_TIMEOUT_SEC = 7 * 24 * 60 * 60

/** One project-scoped config, rewritten every turn so detach is as real as attach. */
export function buildGrokMcpConfig(attached: readonly AttachedMcpServer[]): string {
  if (attached.length === 0) return '# Managed by Manor. No MCP servers are attached to this persona.\n'
  const sections = attached.map(({ server, runtimeEnv }) => {
    const url = mcpHttpUrl(server)
    const lines = [`[mcp_servers.${tomlString(server.name)}]`]
    // ask_user and request_secret hold their call until the user answers; Grok's default 6000 s would cut it.
    if (server.id === 'builtin_manor') lines.push(`tool_timeouts = { ask_user = ${GROK_ASK_TIMEOUT_SEC}, request_secret = ${GROK_ASK_TIMEOUT_SEC} }`)
    if (url !== undefined) {
      lines.push('transport = "http"', `url = ${tomlString(url)}`)
      const headers = Object.entries(mcpHttpHeaderEnvMap(server))
      if (headers.length > 0) {
        lines.push(
          '',
          `[mcp_servers.${tomlString(server.name)}.headers]`,
          ...headers.map(([name, envKey]) => `${tomlString(name)} = ${tomlString(`\${${envKey}}`)}`),
        )
      }
    } else {
      lines.push(`command = ${tomlString(server.command)}`)
      if (server.args.length > 0) {
        lines.push(`args = [${server.args.map(tomlString).join(', ')}]`)
      }
      const envKeys = [...new Set([...server.envKeys, ...Object.keys(runtimeEnv ?? {})])]
      if (envKeys.length > 0) {
        const env = envKeys
          .map((key) => `${tomlString(key)} = ${tomlString(`\${${key}}`)}`)
          .join(', ')
        lines.push(`env = { ${env} }`)
      }
    }
    return lines.join('\n')
  })
  return `${sections.join('\n\n')}\n`
}

export async function ensureGrokAgentDir(
  cwd: string,
  agent: AgentConfig,
  attached: readonly AttachedMcpServer[],
): Promise<string> {
  const dir = path.join(cwd, agent.id.replace(/[^a-zA-Z0-9_-]/g, '_'))
  const configDir = path.join(dir, '.grok')
  await mkdir(configDir, { recursive: true })
  await writeFile(path.join(configDir, 'config.toml'), buildGrokMcpConfig(attached), 'utf8')
  // Grok 4.5 ignores the system-prompt override. Other models use that native
  // channel; clear a prior file when switching models to avoid stale duplication.
  await writeFile(path.join(dir, 'AGENTS.md'), agent.model === 'grok-4.5' ? `${agent.character}\n` : '', 'utf8')
  return dir
}

// ---------------------------------------------------------------------------
// Argv
// ---------------------------------------------------------------------------

/** Manor's provider-neutral names to the built-ins Grok 1.0.4 advertises. */
const GROK_TOOLS: Readonly<Record<string, readonly string[]>> = {
  Read: ['read_file'],
  Write: ['write'],
  // Grok rejects search_replace without read_file during initialisation.
  Edit: ['read_file', 'search_replace'],
  Glob: ['list_dir'],
  Grep: ['grep'],
  Bash: ['run_terminal_command', 'get_command_or_subagent_output', 'kill_command_or_subagent'],
  WebSearch: ['web_search'],
  WebFetch: ['web_fetch'],
  Monitor: ['monitor'],
  ToolSearch: ['search_tool', 'use_tool'],
  TaskCreate: ['todo_write'],
  TaskGet: ['todo_write'],
  TaskList: ['todo_write'],
  TaskUpdate: ['todo_write'],
  TaskOutput: ['get_command_or_subagent_output'],
  TaskStop: ['kill_command_or_subagent'],
  Agent: ['spawn_subagent', 'get_command_or_subagent_output', 'kill_command_or_subagent'],
  Task: ['spawn_subagent', 'get_command_or_subagent_output', 'kill_command_or_subagent'],
  CronCreate: ['scheduler_create'],
  CronList: ['scheduler_list'],
  CronDelete: ['scheduler_delete'],
  Workflow: ['workflow'],
}

const grokEffort = (
  effort: AgentConfig['effort'],
  model: AgentConfig['model'],
): 'low' | 'medium' | 'high' | 'xhigh' => {
  if (effort === 'low' || effort === 'medium') return effort
  // The installed CLI's current default is 4.7. Unknown explicit models stay on the
  // conservative path until their catalogue has been checked.
  if (effort === 'xhigh' && (model === undefined || model === 'grok-4.6' || model === 'grok-4.7')) return 'xhigh'
  return 'high'
}

const unique = (values: readonly string[]): string[] => [...new Set(values)]

/**
 * `--tools ""` means the default toolset on Grok, not no tools. An allowlist made
 * only of unknown names also falls back to every built-in. `read_file` is therefore
 * the recognised anchor on every restricted turn and is denied again when the
 * persona did not ask for it. This measured quirk is why the extra-looking pair of
 * flags below is load-bearing.
 */
export function buildGrokArgs(input: TurnInput): string[] {
  const args = [
    '--no-auto-update',
    // The cwd is Manor-owned scratch. Without this, Grok refuses its project-scoped
    // MCP config even under bypassPermissions and silently starts with no servers.
    '--trust',
    '--prompt-file',
    '/dev/stdin',
    '--output-format',
    'streaming-messages-json',
    '--include-partial-messages',
    '--reasoning-effort',
    grokEffort(input.agent.effort, input.agent.model),
    ...(input.singleSession === true ? [] : ['--no-subagents']),
    '--no-memory',
    '--verbatim',
  ]
  if (input.agent.model !== 'grok-4.5') args.push('--system-prompt-override', input.agent.character)
  if (input.agent.model !== undefined) args.push('--model', input.agent.model)
  if (input.sessionId !== undefined) args.push('--resume', input.sessionId)

  const permissionMode = process.env.MANOR_GROK_PERMISSION_MODE ?? 'bypassPermissions'
  if (permissionMode.length > 0) args.push('--permission-mode', permissionMode)

  const hasAttachedMcp = (input.mcpServers?.length ?? 0) > 0
  const selected = unique([
    // Only names with a Grok built-in behind them: a persona holds the whole Claude set,
    // and a name Grok does not know is noise on its argv at best.
    ...input.agent.allowedTools.flatMap((tool) => GROK_TOOLS[tool] ?? []),
    ...((input.imagePaths?.length ?? 0) > 0 ? ['read_file'] : []),
    ...(hasAttachedMcp ? ['search_tool', 'use_tool'] : []),
  ])
  const disallowed = (input.mcpServers ?? []).flatMap(({ server, disabledTools }) =>
    disabledTools.map((tool) => `${server.name}__${tool}`),
  )

  const anchored = unique(['read_file', ...selected])
  args.push('--tools', anchored.join(','))
  if (!selected.includes('read_file')) disallowed.push('read_file')
  // These are the MCP catalogue gateway, not Grok's web_search/web_fetch tools.
  if (!selected.includes('search_tool')) disallowed.push('search_tool', 'use_tool')
  if (!selected.includes('web_search') && !selected.includes('web_fetch')) {
    args.push('--disable-web-search')
  }

  if (disallowed.length > 0) args.push('--disallowed-tools', unique(disallowed).join(','))
  return args
}

// ---------------------------------------------------------------------------
// Turn end
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const GROK_DONE_STOP = new Set(['end_turn', 'stop_sequence', 'max_tokens', 'refusal'])

/**
 * A resumed session that prints nothing is almost always a dead id, not a slow
 * model. Sixty seconds is well above a measured init (under a second) and well
 * under the five-minute idle that used to leave the user staring at a quiet turn.
 */
export const GROK_RESUME_INIT_MS = 60_000
/** How much redacted stderr a failed result line carries along. */
const GROK_ERROR_TAIL_CHARS = 2_000

/** Wait this long after a done-signal for Grok's official `result` line. */
export const GROK_RESULT_GRACE_MS = 150

export function grokSessionEventsPath(home: string, cwd: string, sessionId: string): string {
  return path.join(home, 'sessions', encodeURIComponent(cwd), sessionId, 'events.jsonl')
}

/** Split incoming JSONL, keep the incomplete tail for the next read. */
export function pullGrokEventLines(
  incoming: string,
  remainder: string,
): { lines: string[]; remainder: string } {
  const parts = `${remainder}${incoming}`.split('\n')
  const nextRemainder = parts.pop() ?? ''
  return { lines: parts, remainder: nextRemainder }
}

export function grokEventLineEndedTurn(line: string): boolean {
  const trimmed = line.trim()
  if (trimmed.length === 0) return false
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return isRecord(parsed) && parsed['type'] === 'turn_ended'
  } catch {
    return false
  }
}

/** True when this assistant frame is the model's last word, not another tool loop. */
export function grokAssistantLineFinished(line: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return false
  }
  if (!isRecord(parsed) || parsed['type'] !== 'assistant') return false
  if (typeof parsed['parent_tool_use_id'] === 'string') return false
  const message = parsed['message']
  if (!isRecord(message)) return false
  const stop = typeof message['stop_reason'] === 'string' ? message['stop_reason'] : undefined
  if (stop === undefined || !GROK_DONE_STOP.has(stop)) return false
  const content = message['content']
  if (!Array.isArray(content)) return false
  return !content.some((block) => isRecord(block) && block['type'] === 'tool_use')
}

/**
 * Background work an assistant line starts: a `monitor` script, or a `workflow` run
 * started by name or script (the same tool also pauses and stops runs). Both answer at
 * once while the work goes on. Probed on grok 1.0.46 headless: the stream reports
 * neither's end, and the process exits at its result, so what still runs stops there.
 */
export function grokBackgroundLaunches(line: string): { toolCallId: string; title: string }[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return []
  }
  if (!isRecord(parsed) || parsed['type'] !== 'assistant' || typeof parsed['parent_tool_use_id'] === 'string') return []
  const content = isRecord(parsed['message']) ? parsed['message']['content'] : undefined
  if (!Array.isArray(content)) return []
  return content.flatMap((block) => {
    if (!isRecord(block) || block['type'] !== 'tool_use' || typeof block['id'] !== 'string') return []
    const input = isRecord(block['input']) ? block['input'] : {}
    const text = (value: unknown) => typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
    if (block['name'] === 'monitor') {
      return [{ toolCallId: block['id'], title: text(input['description']) ?? text(input['command']) ?? 'monitor' }]
    }
    const source = input['source']
    if (block['name'] !== 'workflow' || !isRecord(source)) return []
    if (source['type'] === 'name') return [{ toolCallId: block['id'], title: text(source['name']) ?? 'workflow' }]
    if (source['type'] !== 'script') return []
    const named = typeof source['script'] === 'string' ? /\bname\s*:\s*"([^"]+)"/.exec(source['script'])?.[1] : undefined
    return [{ toolCallId: block['id'], title: text(named) ?? 'workflow' }]
  })
}

function readEventsSince(
  file: string,
  byteOffset: number,
): { text: string; byteOffset: number } {
  const size = statSync(file).size
  if (size <= byteOffset) return { text: '', byteOffset }
  const length = size - byteOffset
  const buf = Buffer.alloc(length)
  const fd = openSync(file, 'r')
  try {
    const n = readSync(fd, buf, 0, length, byteOffset)
    return { text: buf.subarray(0, n).toString('utf8'), byteOffset: byteOffset + n }
  } finally {
    closeSync(fd)
  }
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

export function createGrokDriver(options: GrokDriverOptions): Driver {
  const command = options.command ?? resolveCliCommand('grok')
  const timeouts = resolveTurnTimeouts(options)
  const spawnFn = options.spawnFn ?? defaultSpawn
  // Both keep their startup instructions across a resume, so a changed persona is resent.
  const prepareContext = createResumedContext({ retainsCharacter: true })

  return {
    describeRuntime: () => runtimeVersion(command),
    // Grok has no status command. Its login is the `auth.json` in the real Grok home,
    // the same file `ensureGrokHome` links into Manor's, so its presence is the answer.
    describeAccount: () => stat(path.join(os.homedir(), '.grok', 'auth.json')).then(
      (file) => ({ signedIn: file.isFile() }),
      () => ({ signedIn: false }),
    ),
    signInCommand: () => Promise.resolve({ command, args: ['login'], env: childProcessEnv() }),
    checkForUpdate: () => checkGrok(command),
    installUpdate: () => runUpdater(command, ['update']),
    readProviderUsage: () => readGrokProviderUsage({ command, spawnFn, cwd: os.tmpdir() }),

    compactSession: (input) => {
      const turn = compactTurnInput(input)
      prepareContext.forget(turn.sessionId)
      return runTurn(turn, GROK_COMPACT_COMMAND, { confirm() {} })
    },

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
      // The CLI reports API-equivalent dollars even on a grok.com OAuth session.
      // They are not a charge to the user, so this subscription driver drops that field.
      const parser = new StreamParser(false)
      const startedAt = Date.now()
      const { sourceEnv, grantedKeys } = attachedMcpEnvironment(input.mcpServers ?? [])
      const redact = (message: string) => redactGrantedEnvValues(message, sourceEnv, grantedKeys)

      let child: GrokChildLike | undefined
      let workDir: string | undefined
      let grokHome: string | undefined
      let lastText = ''
      let stopped = false
      let sawTerminalLine = false
      let sawError = false
      let settling = false
      let stderr = ''
      let buffer = ''
      let settled = false
      /**
       * A failed result line arrives on stdout, and the stderr that explains it on another
       * pipe that can lag behind. The error waits here until the child closes, then ships once.
       */
      let heldError: Extract<RuntimeEvent, { type: 'error' }> | undefined
      let childClosed = false
      let finishOnClose = false
      let eventsByteOffset = 0
      let eventsRemainder = ''
      let eventsPoll: NodeJS.Timeout | undefined
      let resumeWatch: NodeJS.Timeout | undefined
      let resultGrace: NodeJS.Timeout | undefined
      let termination: Promise<void> | undefined
      let terminationReady = false
      /** Background work this turn started, by launch call, until its turn ends. */
      const launches = new Map<string, string>()
      let launchesGone = false
      // Background work outlives Grok's exit inside the CLI's own process group, so a
      // turn that started some waits until that group is gone before saying so.
      const killChild = () => {
        const stopping = launches.size > 0 && !stopped
          ? cliTreeGone(child).then((gone) => { launchesGone = gone })
          : terminateCliTree(child)
        termination ??= stopping.then(() => { terminationReady = true })
      }
      /** Grok cannot keep background work past its turn: name it once, after it is gone. */
      const reportStoppedWork = () => {
        if (launches.size === 0) return
        queue.push({
          type: 'background_stopped',
          titles: [...launches.values()].map((title) => redact(title).slice(0, WAKE_TITLE_MAX)),
          ...(launchesGone ? {} : { unconfirmed: true }),
        })
        launches.clear()
      }

      const stopWatches = () => {
        if (eventsPoll !== undefined) clearInterval(eventsPoll)
        eventsPoll = undefined
        if (resumeWatch !== undefined) clearTimeout(resumeWatch)
        resumeWatch = undefined
        if (resultGrace !== undefined) clearTimeout(resultGrace)
        resultGrace = undefined
      }

      const finish = () => {
        if (settled) return
        if (launches.size > 0 && !stopped) killChild()
        if (termination !== undefined && !terminationReady) {
          void termination.then(finish)
          return
        }
        if (heldError !== undefined) {
          if (!childClosed && !stopped && child !== undefined) {
            finishOnClose = true
            return
          }
          releaseHeldError()
        }
        settled = true
        if (!stopped) reportStoppedWork()
        stopWatches()
        timers.clear()
        queue.close()
      }

      // A result line that says the turn failed hides the reason the CLI wrote to stderr.
      // The stderr buffer is redacted as it grows, so the tail only needs its length cap.
      function releaseHeldError() {
        if (heldError === undefined || settled) return
        const event = heldError
        heldError = undefined
        const tail = appendChildErrorTail(stderr.trim(), '', undefined, GROK_ERROR_TAIL_CHARS)
        queue.push(tail.length === 0 ? event : { ...event, message: `${event.message}\n${tail}` })
      }

      const fail = (message: string) => {
        if (settled || stopped) return
        if (heldError !== undefined) releaseHeldError()
        else queue.push({ type: 'error', message: redact(message) })
        killChild()
        finish()
      }

      const settleChild = async () => {
        if (settled || stopped || settling) return
        settling = true
        timers.clear()
        try {
          if (workDir !== undefined) {
            for (const image of await collectGeneratedImages([workDir], startedAt)) {
              if (stopped) return
              queue.push({ type: 'attachment', image })
            }
          }
          if (!settled && !stopped && !sawError) context.confirm(parser.sessionId)
        } finally {
          killChild()
          if (!settled) finish()
        }
      }

      const pushSyntheticResult = () => {
        if (sawTerminalLine) return
        sawTerminalLine = true
        queue.push({
          type: 'result',
          text: lastText,
          ...(parser.sessionId === undefined ? {} : { sessionId: parser.sessionId }),
        })
      }

      // An assistant end_turn frame (or a session turn_ended) is how Grok often
      // narrates while a tool is still open. Settling that while ask-user is
      // holding the idle gate kills the CLI and closes the question.
      const waitingOnUser = () => options.idleGate?.held(input.threadId, input.agent.id) === true

      const armResultGrace = () => {
        if (resultGrace !== undefined || settling || settled || stopped || sawTerminalLine || waitingOnUser()) {
          return
        }
        resultGrace = setTimeout(() => {
          resultGrace = undefined
          if (settled || stopped || settling || sawTerminalLine || waitingOnUser()) return
          pushSyntheticResult()
          void settleChild()
        }, GROK_RESULT_GRACE_MS)
        resultGrace.unref?.()
      }

      const armEventsPoll = () => {
        if (
          eventsPoll !== undefined ||
          grokHome === undefined ||
          workDir === undefined ||
          parser.sessionId === undefined
        ) {
          return
        }
        const file = grokSessionEventsPath(grokHome, workDir, parser.sessionId)
        eventsPoll = setInterval(() => {
          if (settled || stopped || settling) return
          try {
            const read = readEventsSince(file, eventsByteOffset)
            eventsByteOffset = read.byteOffset
            if (read.text.length === 0) return
            const pulled = pullGrokEventLines(read.text, eventsRemainder)
            eventsRemainder = pulled.remainder
            if (!pulled.lines.some(grokEventLineEndedTurn)) return
            armResultGrace()
          } catch {
            // The session file appears after init. The next tick retries.
          }
        }, 250)
        eventsPoll.unref?.()
      }

      const consume = (line: string) => {
        if (settled || stopped || settling) return
        timers.touch()
        let gotTerminal = false
        const parsedEvents = parser.handle(line)
        if (parser.sessionId !== undefined) input.onStage?.('threadReady')
        for (const launch of grokBackgroundLaunches(line)) launches.set(launch.toolCallId, launch.title)
        for (const event of parsedEvents) {
          toolIdle.see(event)
          if (event.type === 'tool_result' && event.outcome === 'error') launches.delete(event.toolCallId)
          // Grok's thinking is planning narration ("Let me look at ChatListView"),
          // not a trace that explains the answer. The Read row names the file.
          if (event.type === 'reasoning') continue
          if (event.type === 'message') lastText = event.text
          const located = event.type === 'tool_use' && event.command === undefined && event.edits !== undefined
            ? { ...event, edits: withEditOrigins(event.edits, workDir ?? input.cwd, input.repoPaths) } : event
          const safeEvent =
            located.type === 'error'
              ? { ...located, message: redact(located.message) }
              : located.type === 'tool_use' || located.type === 'tool_result'
                ? redactToolActivity(located, redact)
                : located
          if (safeEvent.type === 'result' || safeEvent.type === 'error') {
            sawTerminalLine = true
            gotTerminal = true
            if (safeEvent.type === 'error') {
              sawError = true
              heldError ??= safeEvent
              continue
            }
          }
          queue.push(safeEvent)
        }
        if (parser.sawInit) {
          if (
            eventsPoll === undefined &&
            input.sessionId !== undefined &&
            parser.sessionId !== input.sessionId
          ) {
            eventsByteOffset = 0
            eventsRemainder = ''
          }
          armEventsPoll()
        }
        if (gotTerminal) {
          if (resultGrace !== undefined) {
            clearTimeout(resultGrace)
            resultGrace = undefined
          }
          void settleChild()
          return
        }
        if (grokAssistantLineFinished(line)) armResultGrace()
      }

      const expire = (message: string) => {
        const resumeFailed = input.sessionId !== undefined && !parser.sawInit
        fail(resumeFailed ? `${RESUME_FAILURE_PREFIX}${message}` : message)
      }

      const timers = bindIdleClock(
        options.idleGate,
        input.threadId,
        input.agent.id,
        startTurnTimers(timeouts, expire),
      )
      const toolIdle = watchInFlightTools(timers)

      void (async () => {
        let env: NodeJS.ProcessEnv
        try {
          grokHome = await ensureGrokHome()
          workDir = await ensureGrokAgentDir(input.cwd, input.agent, input.mcpServers ?? [])
          env = agentTurnEnv(sourceEnv, grantedKeys, { HOME: grokHome, GROK_HOME: grokHome })
        } catch (error: unknown) {
          fail(`could not prepare the ${command} workspace: ${(error as Error).message}`)
          return
        }
        if (stopped || settled) return

        if (input.sessionId !== undefined) {
          try {
            eventsByteOffset = statSync(grokSessionEventsPath(grokHome, workDir, input.sessionId)).size
          } catch {
            eventsByteOffset = 0
          }
        }

        if (cliShutdownStarted()) {
          fail('server is shutting down')
          return
        }
        let spawned: GrokChildLike
        try {
          spawned = spawnFn(command, buildGrokArgs(input), { cwd: workDir, env })
        } catch (error: unknown) {
          fail(`could not start ${command}: ${error instanceof Error ? error.message : String(error)}`)
          return
        }
        child = spawned
        trackCliChild(spawned)
        input.onStage?.('processStarted')

        if (input.sessionId !== undefined) {
          resumeWatch = setTimeout(() => {
            if (parser.sawInit || settled || stopped) return
            expire('session did not start')
          }, GROK_RESUME_INIT_MS)
          resumeWatch.unref?.()
        }

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
            childClosed = true
            releaseHeldError()
            if (finishOnClose) {
              finishOnClose = false
              finish()
              return
            }
            if (settled || settling) return
            if (stopped || sawTerminalLine) {
              if (!stopped && workDir !== undefined) {
                for (const image of await collectGeneratedImages([workDir], startedAt)) {
                  queue.push({ type: 'attachment', image })
                }
              }
              finish()
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
          stopped = true
          killChild()
          finish()
        },
      }
  }
}
