import { spawn } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { appendFile, lstat, mkdir, readFile, readlink, symlink, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import type { AgentConfig, AttachedMcpServer, RuntimeEvent, TurnInput } from '@manor/contracts'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { HOUSE_STYLE_HEADING, REPLY_LANGUAGE_LINE } from '../src/composer.js'
import { singleAgentFor } from '../src/singleChat.js'
import { RESUME_FAILURE_PREFIX, isResumeFailure } from '../src/drivers/resumeFailure.js'
import { TurnIdleGate } from '../src/drivers/turnTimers.js'
import {
  buildGrokArgs,
  buildGrokMcpConfig,
  GROK_ASK_TIMEOUT_SEC,
  createGrokDriver,
  linkGrokLoginFiles,
  GROK_RESULT_GRACE_MS,
  grokAssistantLineFinished,
  grokEventLineEndedTurn,
  grokSessionEventsPath,
  pullGrokEventLines,
  resolveGrokHome,
  type GrokSpawnFn,
} from '../src/drivers/grokDriver.js'

const sage: AgentConfig = {
  id: 'sage',
  name: 'Sage',
  color: '#6FA8A0',
  character: 'You are Sage.',
  driver: 'grok',
  model: 'grok-4.6',
  effort: 'high',
  allowedTools: [],
  mcpServers: [],
  memoryScope: false,
  description: '',
  role: 'Generalist',
  isCos: false,
}

const smith: AgentConfig = {
  ...sage,
  id: 'smith',
  name: 'Smith',
  character: 'You are Smith.',
  effort: 'max',
  allowedTools: ['Read', 'Bash'],
}

const attachment: AttachedMcpServer = {
  server: {
    id: 'browser',
    name: 'manor-browser',
    command: '/usr/bin/node',
    args: ['/opt/manor/browserMcp.js'],
    envKeys: ['MANOR_BROWSER_BROKER_CAPABILITY'],
    description: '',
    writes: true,
    effectPolicy: 'confirm_writes' as const,
    tools: ['browser_snapshot', 'browser_click'],
    readOnlyTools: [],
    schemaChars: 10,
  },
  disabledTools: ['browser_click'],
  runtimeEnv: { MANOR_BROWSER_URL: 'http://127.0.0.1/internal' },
}

let scratch: string
let grokHome: string
const previousHome = process.env.MANOR_GROK_HOME

beforeAll(() => {
  scratch = mkdtempSync(path.join(os.tmpdir(), 'manor-grok-scratch-'))
  grokHome = mkdtempSync(path.join(os.tmpdir(), 'manor-grok-home-'))
  process.env.MANOR_GROK_HOME = grokHome
})

afterAll(() => {
  if (previousHome === undefined) delete process.env.MANOR_GROK_HOME
  else process.env.MANOR_GROK_HOME = previousHome
})

// A test that changes a home folder variable gets it back afterwards, so it cannot unset it for the next test.
afterEach(() => vi.unstubAllEnvs())

const turnInput = (agent: AgentConfig, overrides: Partial<TurnInput> = {}): TurnInput => ({
  agent,
  threadId: 'main',
  cwd: scratch,
  repoPaths: [],
  catchUp: [
    { id: 'evt_1', ts: 1, type: 'user_message', text: 'Say hello.', mentions: [agent.id] },
  ],
  isFullCatchUp: true,
  ...overrides,
})

const valueAfter = (args: readonly string[], flag: string): string | undefined => {
  const at = args.indexOf(flag)
  return at === -1 ? undefined : args[at + 1]
}

describe('buildGrokArgs', () => {
  it('enables native helpers only for single sessions and maps their tool names', () => {
    const agent = singleAgentFor({ driver: 'grok', model: 'grok-4.6', effort: 'high' })
    const args = buildGrokArgs(turnInput(agent, { singleSession: true }))
    expect(args).not.toContain('--no-subagents')
    expect(args).toContain('--no-memory')
    expect(valueAfter(args, '--tools')?.split(',')).toContain('spawn_subagent')
    expect(valueAfter(args, '--tools')?.split(',')).not.toContain('Agent')
    expect(buildGrokArgs(turnInput(agent))).toContain('--no-subagents')
  })

  it('uses stdin, the persona override and the subscription-safe headless stream', () => {
    const args = buildGrokArgs(turnInput(sage))

    expect(valueAfter(args, '--prompt-file')).toBe('/dev/stdin')
    expect(valueAfter(args, '--output-format')).toBe('streaming-messages-json')
    expect(valueAfter(args, '--system-prompt-override')).toBe('You are Sage.')
    expect(valueAfter(args, '--model')).toBe('grok-4.6')
    expect(args).toContain('--no-auto-update')
    expect(args).toContain('--trust')
    expect(args).toContain('--no-subagents')
    expect(args).toContain('--no-memory')
  })

  it('turns an empty shared toolset into no Grok built-ins', () => {
    const args = buildGrokArgs(turnInput(sage))

    // A recognised allowlist anchor prevents Grok's unknown/empty fallback to all.
    expect(valueAfter(args, '--tools')).toBe('read_file')
    expect(valueAfter(args, '--disallowed-tools')?.split(',')).toEqual([
      'read_file',
      'search_tool',
      'use_tool',
    ])
    expect(args).toContain('--disable-web-search')
  })

  it('maps Manor tool names, and caps Max at high', () => {
    const args = buildGrokArgs(turnInput(smith))

    expect(valueAfter(args, '--tools')?.split(',')).toEqual([
      'read_file',
      'run_terminal_command',
      'get_command_or_subagent_output',
      'kill_command_or_subagent',
    ])
    expect(valueAfter(args, '--reasoning-effort')).toBe('high')
    expect(valueAfter(args, '--disallowed-tools')?.split(',')).toEqual(['search_tool', 'use_tool'])
  })

  it.each(['grok-4.6', 'grok-4.7'])('passes Extra to %s but caps it for 4.5', (model) => {
    const extraHigh = { ...sage, model, effort: 'xhigh' as const }

    const args = buildGrokArgs(turnInput(extraHigh))
    expect(valueAfter(args, '--model')).toBe(model)
    expect(valueAfter(args, '--reasoning-effort')).toBe('xhigh')
    expect(valueAfter(args, '--system-prompt-override')).toBe(sage.character)
    expect(
      valueAfter(buildGrokArgs(turnInput({ ...extraHigh, model: 'grok-4.5' })), '--reasoning-effort'),
    ).toBe('high')
  })

  it('keeps an empty toolset restricted when a linked folder is present, and resumes', () => {
    const args = buildGrokArgs(turnInput(sage, { repoPaths: ['/repos/manor'], sessionId: 'session-1' }))

    expect(valueAfter(args, '--tools')).toBe('read_file')
    expect(valueAfter(args, '--disallowed-tools')?.split(',')).toEqual([
      'read_file',
      'search_tool',
      'use_tool',
    ])
    expect(args).toContain('--disable-web-search')
    expect(valueAfter(args, '--resume')).toBe('session-1')
  })

  it('maps web capabilities to Grok web tools rather than the MCP gateway', () => {
    const webAgent = { ...sage, allowedTools: ['WebSearch', 'WebFetch'] }
    const args = buildGrokArgs(turnInput(webAgent))

    expect(valueAfter(args, '--tools')?.split(',')).toEqual([
      'read_file',
      'web_search',
      'web_fetch',
    ])
    expect(valueAfter(args, '--disallowed-tools')?.split(',')).toEqual([
      'read_file',
      'search_tool',
      'use_tool',
    ])
    expect(args).not.toContain('--disable-web-search')
  })

  it('adds Read when Edit is selected because Grok requires the pair', () => {
    const editAgent = { ...sage, allowedTools: ['Edit'] }
    const args = buildGrokArgs(turnInput(editAgent))

    expect(valueAfter(args, '--tools')?.split(',')).toEqual(['read_file', 'search_replace'])
    expect(valueAfter(args, '--disallowed-tools')?.split(',')).toEqual(['search_tool', 'use_tool'])
  })

  it('keeps the MCP gateway available and removes excluded tools by Grok namespace', () => {
    const args = buildGrokArgs(turnInput(sage, { mcpServers: [attachment] }))

    expect(valueAfter(args, '--tools')?.split(',')).toEqual(['read_file', 'search_tool', 'use_tool'])
    expect(valueAfter(args, '--disallowed-tools')?.split(',')).toEqual([
      'manor-browser__browser_click',
      'read_file',
    ])
    expect(args).toContain('--disable-web-search')
  })
})

describe('buildGrokMcpConfig', () => {
  it('writes only variable placeholders, never capability values', () => {
    const config = buildGrokMcpConfig([attachment])

    expect(config).toContain('[mcp_servers."manor-browser"]')
    expect(config).toContain('command = "/usr/bin/node"')
    expect(config).toContain('"MANOR_BROWSER_BROKER_CAPABILITY" = "${MANOR_BROWSER_BROKER_CAPABILITY}"')
    expect(config).toContain('"MANOR_BROWSER_URL" = "${MANOR_BROWSER_URL}"')
    expect(config).not.toContain('http://127.0.0.1/internal')
  })

  // Grok's default 6000 s tool timeout would cut a question the user answers later.
  it('lets only the Manor server hold ask_user and request_secret for as long as the user takes', () => {
    const manor = { ...attachment, server: { ...attachment.server, id: 'builtin_manor', name: 'manor' } }
    const config = buildGrokMcpConfig([attachment, manor])

    expect(config).toContain(`[mcp_servers."manor"]\ntool_timeouts = { ask_user = ${GROK_ASK_TIMEOUT_SEC}, request_secret = ${GROK_ASK_TIMEOUT_SEC} }`)
    expect(config.match(/tool_timeouts/g)).toHaveLength(1)
  })

  it('has an explicit empty state so detaching overwrites the old config', () => {
    expect(buildGrokMcpConfig([])).toContain('No MCP servers are attached')
    expect(buildGrokMcpConfig([])).not.toContain('[mcp_servers.')
  })

  it('renders an HTTP server as url plus transport, never as a command', () => {
    const config = buildGrokMcpConfig([
      {
        server: {
          ...attachment.server,
          command: '',
          args: [],
          envKeys: [],
          url: 'http://127.0.0.1:3845/mcp',
        },
        disabledTools: [],
      },
    ])
    expect(config).toContain('transport = "http"')
    expect(config).toContain('url = "http://127.0.0.1:3845/mcp"')
    expect(config).not.toContain('command =')
  })

  it('renders HTTP header values as environment placeholders', () => {
    const config = buildGrokMcpConfig([{
      server: {
        ...attachment.server,
        command: '',
        args: [],
        envKeys: ['COMPOSIO_CONSUMER_API_KEY'],
        httpHeaders: [{ name: 'x-consumer-api-key', envKey: 'COMPOSIO_CONSUMER_API_KEY' }],
        url: 'https://connect.composio.dev/mcp',
      },
      disabledTools: [],
    }])
    expect(config).toContain('[mcp_servers."manor-browser".headers]')
    expect(config).toContain('"x-consumer-api-key" = "${COMPOSIO_CONSUMER_API_KEY}"')
  })

  it('does not put a Manor-minted Figma bearer in Grok config, Grok reads mcp_credentials.json', () => {
    const config = buildGrokMcpConfig([
      {
        server: {
          ...attachment.server,
          name: 'figma',
          command: '',
          args: [],
          envKeys: [],
          url: 'https://mcp.figma.com/mcp',
        },
        disabledTools: [],
        runtimeEnv: { MANOR_MCP_BEARER_FIGMA: 'secret-token' },
      },
    ])
    expect(config).not.toContain('secret-token')
    expect(config).not.toContain('Authorization')
  })
})

describe('linkGrokLoginFiles', () => {
  it('links auth.json and mcp_credentials.json, and still links the second when the first already exists', async () => {
    const real = mkdtempSync(path.join(os.tmpdir(), 'manor-grok-real-'))
    const manor = mkdtempSync(path.join(os.tmpdir(), 'manor-grok-home-'))
    await writeFile(path.join(real, 'auth.json'), '{}', 'utf8')
    await writeFile(path.join(real, 'mcp_credentials.json'), '{}', 'utf8')
    await linkGrokLoginFiles(manor, real)
    await linkGrokLoginFiles(manor, real)
    expect(await lstat(path.join(manor, 'auth.json')).then((s) => s.isSymbolicLink())).toBe(true)
    expect(await lstat(path.join(manor, 'mcp_credentials.json')).then((s) => s.isSymbolicLink())).toBe(true)
  })

  const homes = async () => {
    const real = mkdtempSync(path.join(os.tmpdir(), 'manor-grok-real-'))
    const manor = mkdtempSync(path.join(os.tmpdir(), 'manor-grok-home-'))
    const source = path.join(real, 'auth.json')
    const linkPath = path.join(manor, 'auth.json')
    return { real, manor, source, linkPath }
  }
  const linkTarget = (p: string) => lstat(p).then((s) => (s.isSymbolicLink() ? readlink(p) : undefined))
  const login = '{"token":"a-real-looking-login-token"}'

  it('leaves a correct link alone', async () => {
    const { real, manor, source, linkPath } = await homes()
    await writeFile(source, login, 'utf8')
    await symlink(source, linkPath)
    const before = await lstat(linkPath)
    expect(await linkGrokLoginFiles(manor, real)).toEqual({ keptNewerCopies: [], failed: [] })
    expect((await lstat(linkPath)).ino).toBe(before.ino)
  })

  it('replaces a detached 2-byte signed-out file with the link, even when it is newer', async () => {
    const { real, manor, source, linkPath } = await homes()
    await writeFile(source, login, 'utf8')
    await utimes(source, new Date(2020, 0, 1), new Date(2020, 0, 1))
    await writeFile(linkPath, '{}', 'utf8')
    await linkGrokLoginFiles(manor, real)
    expect(await linkTarget(linkPath)).toBe(source)
  })

  it('replaces a detached copy older than the real login', async () => {
    const { real, manor, source, linkPath } = await homes()
    await writeFile(linkPath, login, 'utf8')
    await utimes(linkPath, new Date(2020, 0, 1), new Date(2020, 0, 1))
    await writeFile(source, login, 'utf8')
    await linkGrokLoginFiles(manor, real)
    expect(await linkTarget(linkPath)).toBe(source)
  })

  it('keeps and reports a detached copy newer than the real login', async () => {
    const { real, manor, source, linkPath } = await homes()
    await writeFile(source, login, 'utf8')
    await utimes(source, new Date(2020, 0, 1), new Date(2020, 0, 1))
    await writeFile(linkPath, login, 'utf8')
    expect((await linkGrokLoginFiles(manor, real)).keptNewerCopies).toEqual(['auth.json'])
    expect((await lstat(linkPath)).isFile()).toBe(true)
    expect(await readFile(linkPath, 'utf8')).toBe(login)
  })

  it('replaces a link to somewhere else and a dangling link', async () => {
    const { real, manor, source, linkPath } = await homes()
    await writeFile(source, login, 'utf8')
    await writeFile(path.join(real, 'mcp_credentials.json'), login, 'utf8')
    const elsewhere = path.join(manor, 'other.json')
    await writeFile(elsewhere, login, 'utf8')
    await symlink(elsewhere, linkPath)
    await symlink(path.join(manor, 'gone.json'), path.join(manor, 'mcp_credentials.json'))
    await linkGrokLoginFiles(manor, real)
    expect(await linkTarget(linkPath)).toBe(source)
    expect(await linkTarget(path.join(manor, 'mcp_credentials.json'))).toBe(path.join(real, 'mcp_credentials.json'))
  })

  it('does nothing when both folders are the same one', async () => {
    const { real, source } = await homes()
    await writeFile(source, login, 'utf8')
    expect(await linkGrokLoginFiles(real, real)).toEqual({ keptNewerCopies: [], failed: [] })
    expect((await lstat(source)).isFile()).toBe(true)
    expect(await readFile(source, 'utf8')).toBe(login)
  })

  it('does nothing when the Manor home is a link to the real home', async () => {
    const { real, manor, source } = await homes()
    await writeFile(source, login, 'utf8')
    const alias = path.join(manor, 'alias')
    await symlink(real, alias)
    expect(await linkGrokLoginFiles(alias, real)).toEqual({ keptNewerCopies: [], failed: [] })
    expect((await lstat(source)).isFile()).toBe(true)
    expect(await readFile(source, 'utf8')).toBe(login)
  })

  it('changes nothing when the real login file does not exist', async () => {
    const { real, manor, linkPath } = await homes()
    await writeFile(linkPath, '{}', 'utf8')
    expect(await linkGrokLoginFiles(manor, real)).toEqual({ keptNewerCopies: [], failed: [] })
    expect((await lstat(linkPath)).isFile()).toBe(true)
    expect(await lstat(path.join(manor, 'mcp_credentials.json')).catch(() => undefined)).toBeUndefined()
  })
})

describe('resolveGrokHome', () => {
  it('prefers MANOR_GROK_HOME, then the data folder, then ~/.manor', () => {
    vi.stubEnv('MANOR_GROK_HOME', '/tmp/manor-explicit-grok')
    vi.stubEnv('MANOR_DATA_DIR', '/tmp/manor-second-install')
    expect(resolveGrokHome()).toBe('/tmp/manor-explicit-grok')
    vi.stubEnv('MANOR_GROK_HOME', undefined)
    expect(resolveGrokHome()).toBe(path.join('/tmp/manor-second-install', 'grok-home'))
    vi.stubEnv('MANOR_DATA_DIR', undefined)
    expect(resolveGrokHome()).toBe(path.join(os.homedir(), '.manor', 'grok-home'))
  })
})

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly stdin = new PassThrough()
  killed = false

  kill(): boolean {
    this.killed = true
    return true
  }
}

async function drain(events: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const collected: RuntimeEvent[] = []
  for await (const event of events) collected.push(event)
  return collected
}

async function run(options: {
  driverFactory?: typeof createGrokDriver
  stdoutLines?: string[]
  stderr?: string
  /** Let stdout be consumed before stderr arrives, as separate pipes allow. */
  stderrLate?: boolean
  exitCode?: number
  input?: Partial<TurnInput>
  stdinError?: Error
}) {
  const child = new FakeChild()
  let stdin = ''
  child.stdin.on('data', (chunk: Buffer) => {
    stdin += chunk.toString('utf8')
  })
  let seen: { args: string[]; cwd: string; env: NodeJS.ProcessEnv } | undefined
  let markSpawned: () => void = () => undefined
  const spawned = new Promise<void>((resolve) => {
    markSpawned = resolve
  })
  const driver = (options.driverFactory ?? createGrokDriver)({
    agents: () => [sage, smith],
    timeoutMs: 5_000,
    spawnFn: (_command, args, spawnOptions) => {
      seen = { args: [...args], cwd: spawnOptions.cwd, env: spawnOptions.env }
      markSpawned()
      return child
    },
  })
  const handle = driver.startTurn(turnInput(sage, options.input))
  const collected = drain(handle.events)
  await spawned
  if (options.stdinError !== undefined) child.stdin.emit('error', options.stdinError)

  const ended = Promise.all([once(child.stdout, 'end'), once(child.stderr, 'end')])
  for (const line of options.stdoutLines ?? []) child.stdout.write(`${line}\n`)
  child.stdout.end()
  if (options.stderrLate === true) await new Promise((resolve) => setImmediate(resolve))
  if (options.stderr !== undefined) child.stderr.write(options.stderr)
  child.stderr.end()
  await ended
  child.emit('close', options.exitCode ?? 0)

  if (seen === undefined) throw new Error('the driver never spawned')
  return { events: await collected, stdin, ...seen }
}

it('adds stderr that arrives after a failed result line to its error, once, and leaves a success alone', async () => {
  const failed = await run({
    stderr: 'quota exceeded for this plan\n', stderrLate: true,
    stdoutLines: [JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: '' })],
  })
  expect(failed.events).toContainEqual({
    type: 'error',
    message: 'the CLI reported a failed turn (error_during_execution)\nquota exceeded for this plan',
  })
  expect(failed.events.filter((event) => event.type === 'error')).toHaveLength(1)
  const ok = await run({
    stderr: 'noisy warning\n', stderrLate: true,
    stdoutLines: [JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Done.', session_id: 's1' })],
  })
  expect(ok.events.some((event) => event.type === 'error')).toBe(false)
  expect(JSON.stringify(ok.events)).not.toContain('noisy warning')
})

it('fails the turn when child stdin breaks without crashing the process', async () => {
  const { events } = await run({ stdinError: Object.assign(new Error('broken pipe'), { code: 'EPIPE' }) })
  expect(events).toContainEqual({ type: 'error', message: expect.stringContaining('broken pipe') })
})

it('fails a synchronous E2BIG spawn and clears its idle clock', async () => {
  const driver = createGrokDriver({
    agents: () => [sage], timeoutMs: 1_000,
    spawnFn: () => { throw Object.assign(new Error('argument list too long'), { code: 'E2BIG' }) },
  })
  const events = await drain(driver.startTurn(turnInput(sage)).events)
  expect(events).toContainEqual({ type: 'error', message: expect.stringContaining('argument list too long') })
})

const success = [
  JSON.stringify({ type: 'system', subtype: 'init', session_id: 'grok-session' }),
  JSON.stringify({
    type: 'stream_event',
    event: { type: 'message_start', message: { id: 'msg_0' } },
  }),
  JSON.stringify({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } },
  }),
  JSON.stringify({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: ' the user.' } },
  }),
  JSON.stringify({
    type: 'assistant',
    message: {
      id: 'msg_0',
      model: 'grok-4.6',
      content: [
        { type: 'thinking', thinking: 'Be concise.' },
        { type: 'text', text: 'Hello the user.' },
      ],
      usage: {
        input_tokens: 10,
        output_tokens: 3,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 0,
      },
    },
  }),
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Hello the user.',
    total_cost_usd: 0.42,
    session_id: 'grok-session',
    usage: {
      input_tokens: 10,
      output_tokens: 3,
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 0,
    },
  }),
]

// Shapes from Grok's own headless docs (streaming-messages-json): per-response usage on
// each `assistant` line, and a `system`/`compact_boundary` after an auto compaction.
it('reports each response’s prompt size mid-turn and the drop after an auto compaction', async () => {
  const usage = (input: number, cached: number) => ({ input_tokens: input, output_tokens: 40, cache_read_input_tokens: cached, cache_creation_input_tokens: 0 })
  const { events } = await run({
    stdoutLines: [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'grok-session' }),
      JSON.stringify({ type: 'assistant', parent_tool_use_id: null, message: {
        id: 'msg_0', model: 'grok-4.6', usage: usage(2_000, 80_000),
        content: [{ type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'notes.md' } }],
      } }),
      JSON.stringify({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'x' }] } }),
      JSON.stringify({ type: 'system', subtype: 'compact_boundary', session_id: 'grok-session', compact_metadata: { trigger: 'auto', pre_tokens: 82_000 } }),
      JSON.stringify({ type: 'assistant', parent_tool_use_id: null, message: {
        id: 'msg_1', model: 'grok-4.6', usage: usage(9_000, 0), content: [{ type: 'text', text: 'Done.' }],
      } }),
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Done.', session_id: 'grok-session', usage: usage(11_000, 80_000) }),
    ],
  })
  const context = events.filter((event) => event.type === 'context' || event.type === 'compaction')
  // Grok names no start, only the boundary, so there is no Compacting line to show: only the drop.
  expect(context).toEqual([
    { type: 'context', contextTokens: 82_000 },
    { type: 'compaction', phase: 'end' },
    { type: 'context', contextTokens: 9_000 },
  ])
  expect(events.find((event) => event.type === 'result')).toMatchObject({ contextTokens: 9_000 })
})

describe('createGrokDriver', () => {
  it('delivers 4.5 context through its file and refreshes only changed resumes', async () => {
    let nextSpawn: GrokSpawnFn | undefined
    const sharedDriver = createGrokDriver({
      agents: () => [sage],
      timeoutMs: 5_000,
      spawnFn: (...args) => {
        if (nextSpawn === undefined) throw new Error('Missing test spawn')
        return nextSpawn(...args)
      },
    })
    const driverFactory: typeof createGrokDriver = (options) => {
      nextSpawn = options.spawnFn
      return sharedDriver
    }
    const original = { ...sage, model: 'grok-4.5', character: 'Original project memory.' }
    const updated = { ...original, character: 'Current persona, personal memory disabled.' }
    const resume = { sessionId: 'grok-session', isFullCatchUp: false }
    const stdoutLines = success

    const fresh = await run({ driverFactory, input: { agent: original }, stdoutLines })
    expect(await readFile(path.join(fresh.cwd, 'AGENTS.md'), 'utf8')).toBe(`${original.character}\n`)
    expect(fresh.stdin).not.toContain(original.character)
    expect(fresh.args).not.toContain('--system-prompt-override')

    const changed = await run({ driverFactory, input: { ...resume, agent: updated, contextBlock: 'Side chat context.' }, stdoutLines })
    expect(changed.stdin).toContain(updated.character)
    expect(changed.stdin).toContain('Side chat context.')
    expect(changed.stdin).not.toContain(original.character)
    const unchanged = await run({ driverFactory, input: { ...resume, agent: updated }, stdoutLines })
    expect(unchanged.stdin).not.toContain(updated.character)

    await run({
      driverFactory, input: { ...resume, agent: original },
      stdoutLines: [success[0] ?? '', JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'Failed' })],
    })
    const restored = await run({ driverFactory, input: { ...resume, agent: updated }, stdoutLines })
    expect(restored.stdin).toContain(updated.character)

    const native = await run({ driverFactory, input: { ...resume, agent: { ...updated, model: 'grok-4.6' } }, stdoutLines })
    expect(await readFile(path.join(native.cwd, 'AGENTS.md'), 'utf8')).toBe('')
    expect(native.stdin).toContain(updated.character)
    expect(valueAfter(native.args, '--system-prompt-override')).toBe(updated.character)
    const nativeUnchanged = await run({ driverFactory, input: { ...resume, agent: { ...updated, model: 'grok-4.6' } }, stdoutLines })
    expect(nativeUnchanged.stdin).not.toContain(updated.character)
    const switchedBack = await run({ driverFactory, input: { ...resume, agent: updated }, stdoutLines })
    expect(switchedBack.stdin).toContain(updated.character)
  })

  it('parses the live Grok envelope and keeps subscription turns free of dollar claims', async () => {
    const socket = process.env.SSH_AUTH_SOCK
    process.env.SSH_AUTH_SOCK = '/tmp/manor-test-agent.sock'
    const { events, stdin, cwd, env } = await run({ stdoutLines: success }).finally(() => {
      if (socket === undefined) delete process.env.SSH_AUTH_SOCK
      else process.env.SSH_AUTH_SOCK = socket
    })

    expect(events.filter((event) => event.type === 'delta')).toEqual([
      { type: 'delta', messageId: 'msg_0', text: 'Hello' },
      { type: 'delta', messageId: 'msg_0', text: ' the user.' },
    ])
    expect(events.filter((event) => event.type === 'message')).toEqual([
      { type: 'message', messageId: 'msg_0', text: 'Hello the user.' },
    ])
    expect(events.filter((event) => event.type === 'reasoning')).toEqual([])
    expect(events.at(-1)).toEqual({
      type: 'result',
      text: 'Hello the user.',
      usage: { inputTokens: 12, outputTokens: 3 },
      contextTokens: 12,
      reportedModel: 'grok-4.6',
      sessionId: 'grok-session',
    })
    expect(stdin).toContain('User: Say hello.')
    expect(stdin).toContain(HOUSE_STYLE_HEADING)
    expect(stdin.indexOf(HOUSE_STYLE_HEADING)).toBeLessThan(stdin.lastIndexOf('User: Say hello.'))
    expect(stdin).toContain(`${REPLY_LANGUAGE_LINE}\n\nUser: Say hello.`)
    expect(cwd).toBe(path.join(scratch, 'sage'))
    expect(env['HOME']).toBe(grokHome)
    expect(env['GROK_HOME']).toBe(grokHome)
    // A turn's own git reaches the ssh agent, as it does in the user's Terminal.
    expect(env['SSH_AUTH_SOCK']).toBe('/tmp/manor-test-agent.sock')
  })

  it('keeps image paths on stdin before house style and the question', async () => {
    const { stdin } = await run({
      stdoutLines: success,
      input: { imagePaths: ['/scratch/attachments/evt_9-0.webp'] },
    })

    expect(stdin.indexOf('/scratch/attachments/evt_9-0.webp')).toBeLessThan(stdin.indexOf(HOUSE_STYLE_HEADING))
    expect(stdin.indexOf(HOUSE_STYLE_HEADING)).toBeLessThan(stdin.lastIndexOf('User: Say hello.'))
    expect(stdin.trimEnd().endsWith('User: Say hello.')).toBe(true)
  })

  it('omits house style from a single turn and ignores helper completion', async () => {
    const child = JSON.stringify({ type: 'assistant', parent_tool_use_id: 'helper', message: {
      stop_reason: 'end_turn', content: [{ type: 'text', text: 'Child answer' }],
    } })
    expect(grokAssistantLineFinished(child)).toBe(false)
    const { stdin, events } = await run({
      input: { singleSession: true, agent: singleAgentFor({ driver: 'grok', model: 'grok-4.6', effort: 'high' }) },
      stdoutLines: [child, ...success],
    })
    expect(stdin).not.toContain(HOUSE_STYLE_HEADING)
    expect(events).not.toContainEqual(expect.objectContaining({ text: 'Child answer' }))
    expect(events.at(-1)?.type).toBe('result')
  })

  it('passes nested Grok tool activity without treating the child as the speaker', async () => {
    const childTool = JSON.stringify({ type: 'assistant', parent_tool_use_id: 'helper', message: {
      content: [{ type: 'tool_use', id: 'child-read', name: 'read_file', input: { path: 'parser.ts' } }],
    } })
    const { events } = await run({
      input: { singleSession: true, agent: singleAgentFor({ driver: 'grok', model: 'grok-4.6', effort: 'high' }) },
      stdoutLines: [childTool, ...success],
    })
    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool_use', toolCallId: 'child-read', parentToolCallId: 'helper', tool: 'read_file',
    }))
    expect(events.filter((event) => event.type === 'message')).toEqual([
      { type: 'message', messageId: 'msg_0', text: 'Hello the user.' },
    ])
  })

  it('keeps image paths before house style when the question quotes the heading', async () => {
    const quoted = `Look at ${HOUSE_STYLE_HEADING} please`
    const { stdin } = await run({
      stdoutLines: success,
      input: {
        catchUp: [
          { id: 'evt_1', ts: 1, type: 'user_message', text: quoted, mentions: [sage.id] },
        ],
        isFullCatchUp: false,
        imagePaths: ['/scratch/attachments/evt_9-0.webp'],
      },
    })

    expect(stdin.indexOf('/scratch/attachments/evt_9-0.webp')).toBeLessThan(stdin.indexOf(HOUSE_STYLE_HEADING))
    expect(stdin.trimEnd().endsWith(`User: ${quoted}`)).toBe(true)
  })

  it('normalises Grok search_replace input into the shared diff shape', async () => {
    const { events } = await run({
      stdoutLines: [
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 'grok-edit-session' }),
        JSON.stringify({
          type: 'assistant',
          message: {
            id: 'msg-edit',
            model: 'grok-4.6',
            content: [{
              type: 'tool_use',
              id: 'edit-1',
              name: 'search_replace',
              input: { file_path: '/tmp/notes.md', old_string: 'before', new_string: 'after' },
            }],
            usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          },
        }),
        JSON.stringify({
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: 'edit-1', content: 'updated' }] },
        }),
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: '',
          session_id: 'grok-edit-session',
          usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        }),
      ],
    })

    expect(events.filter((event) => event.type === 'tool_use')).toEqual([
      {
        type: 'tool_use',
        toolCallId: 'edit-1',
        tool: 'search_replace',
        detail: '/tmp/notes.md',
        edits: [{ path: '/tmp/notes.md', originPath: '/tmp/notes.md', before: 'before', after: 'after' }],
      },
    ])
  })

  it('names the file on read_file and drops the thinking that only restated it', async () => {
    const { events } = await run({
      stdoutLines: [
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 'grok-read-session' }),
        JSON.stringify({
          type: 'assistant',
          message: {
            id: 'msg-read',
            model: 'grok-4.6',
            content: [
              { type: 'thinking', thinking: 'Let me look at ChatListView for existing search.' },
              {
                type: 'tool_use',
                id: 'read-1',
                name: 'read_file',
                input: { target_file: '/Users/sam/Ontwikkeling/Manor/apps/web/src/components/chats/ChatListView.tsx' },
              },
              {
                type: 'tool_use',
                id: 'list-1',
                name: 'list_dir',
                input: { target_directory: '/Users/sam/Ontwikkeling/Manor/apps/web/src' },
              },
            ],
            usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          },
        }),
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: '',
          session_id: 'grok-read-session',
          usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        }),
      ],
    })

    expect(events.filter((event) => event.type === 'reasoning')).toEqual([])
    expect(events.filter((event) => event.type === 'tool_use')).toEqual([
      {
        type: 'tool_use',
        toolCallId: 'read-1',
        tool: 'read_file',
        detail: '/Users/sam/Ontwikkeling/Manor/apps/web/src/components/chats/ChatListView.tsx',
        targets: ['/Users/sam/Ontwikkeling/Manor/apps/web/src/components/chats/ChatListView.tsx'],
      },
      {
        type: 'tool_use',
        toolCallId: 'list-1',
        tool: 'list_dir',
        detail: '/Users/sam/Ontwikkeling/Manor/apps/web/src',
      },
    ])
  })

  it('materialises only the attached MCP config in the persona directory', async () => {
    process.env.MANOR_BROWSER_BROKER_CAPABILITY = 'host-secret'
    try {
      const { cwd, env } = await run({ stdoutLines: success, input: { mcpServers: [attachment] } })
      const config = await readFile(path.join(cwd, '.grok', 'config.toml'), 'utf8')

      expect(config).toBe(buildGrokMcpConfig([attachment]))
      expect(config).not.toContain('host-secret')
      expect(env['MANOR_BROWSER_BROKER_CAPABILITY']).toBe('host-secret')
      expect(env['MANOR_BROWSER_URL']).toBeUndefined()
    } finally {
      delete process.env.MANOR_BROWSER_BROKER_CAPABILITY
    }
  })

  it('classifies a failed resume for the orchestrator retry path', async () => {
    const { events } = await run({
      input: { sessionId: 'missing' },
      stderr: 'session not found',
      exitCode: 1,
    })

    expect(events).toEqual([{ type: 'error', message: `${RESUME_FAILURE_PREFIX}session not found` }])
  })

  it('classifies a session missing remotely, announced by an unnamed init, as a failed resume', async () => {
    // Shape from the grok CLI for `--resume` of an id it no longer has.
    const missing = 'No saved copy of session missing was found remotely.'
    const { events } = await run({
      input: { sessionId: 'missing' },
      stdoutLines: [
        JSON.stringify({ type: 'system', subtype: 'init', session_id: '' }),
        JSON.stringify({
          type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 0,
          session_id: '', errors: [missing],
        }),
      ],
      stderr: `Error: ${missing}`,
      exitCode: 1,
    })
    const error = events.at(-1)
    expect(error?.type === 'error' && isResumeFailure(error.message)).toBe(true)
    expect(error).toMatchObject({ message: expect.stringContaining(missing) })
  })

  it('keeps an unrelated failed result after an unnamed init as an ordinary turn failure', async () => {
    const { events } = await run({
      input: { sessionId: 'grok-session' },
      stdoutLines: [
        JSON.stringify({ type: 'system', subtype: 'init', session_id: '' }),
        JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['invalid model'] }),
      ],
      exitCode: 1,
    })
    const error = events.at(-1)
    expect(error).toMatchObject({ type: 'error', message: expect.stringContaining('invalid model') })
    expect(error?.type === 'error' && isResumeFailure(error.message)).toBe(false)
  })

  it('keeps a post-init session error as an ordinary turn failure', async () => {
    const { events } = await run({
      input: { sessionId: 'grok-session' },
      stdoutLines: [JSON.stringify({ type: 'system', subtype: 'init', session_id: 'grok-session' })],
      stderr: 'session tool failed', exitCode: 1,
    })
    expect(events.at(-1)).toEqual({ type: 'error', message: 'session tool failed' })
  })

  it('names background work its turn started as stopped at the end, since the stream never reports it', async () => {
    // Shapes from grok 1.0.46 headless: a monitor and a workflow answer at once.
    const launch = (id: string, name: string, input: object) => JSON.stringify({
      type: 'assistant', message: { id: `msg-${id}`, model: 'grok-4.6', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] },
    })
    const receipt = (id: string, content: string, isError = false) => JSON.stringify({
      type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] },
    })
    const { events } = await run({ stdoutLines: [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'grok-session' }),
      launch('call-monitor', 'monitor', { command: 'tail -f build.log', description: 'Watch the build log' }),
      receipt('call-monitor', '{"type":"Monitor","taskId":"task-1","timeoutMs":36000000,"persistent":false}'),
      launch('call-flow', 'workflow', { source: { type: 'script', script: 'let meta = #{ name: "review-changes" };' } }),
      receipt('call-flow', "Workflow 'review-changes' could not start", true),
      launch('call-pause', 'workflow', { source: { type: 'pause', run: 'review-changes' } }),
      receipt('call-pause', 'Paused'),
      JSON.stringify({ type: 'assistant', message: { id: 'msg-done', model: 'grok-4.6', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Watching it.' }] } }),
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Watching it.', session_id: 'grok-session' }),
    ] })
    const end = events.findIndex((event) => event.type === 'result')
    expect(events.slice(end + 1).filter((event) => event.type === 'background_stopped')).toEqual([
      { type: 'background_stopped', titles: ['Watch the build log'] },
    ])
  })

  it('ends the turn when the assistant frame says the model is done, without waiting for exit', async () => {
    const child = new FakeChild()
    let onSpawn: () => void = () => undefined
    const spawned = new Promise<void>((resolve) => {
      onSpawn = resolve
    })
    const driver = createGrokDriver({
      agents: () => [sage, smith],
      spawnFn: () => {
        onSpawn()
        return child
      },
    })
    const handle = driver.startTurn(turnInput(sage))
    const collected = drain(handle.events)
    await spawned

    child.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'grok-done' })}\n`)
    child.stdout.write(
      `${JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg-done',
          model: 'grok-4.6',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'Staat in Handover/index.html.' }],
        },
      })}\n`,
    )

    const events = await collected
    expect(events.filter((event) => event.type === 'message')).toEqual([
      { type: 'message', messageId: 'msg-done', text: 'Staat in Handover/index.html.' },
    ])
    expect(events.at(-1)).toEqual({
      type: 'result',
      text: 'Staat in Handover/index.html.',
      sessionId: 'grok-done',
    })
    expect(child.killed).toBe(true)
    expect(events.filter((event) => event.type === 'error')).toEqual([])
  })

  it('treats a resumed session that never inits as a dead id, not a quiet turn', async () => {
    const child = new FakeChild()
    let spawned = false
    const driver = createGrokDriver({
      agents: () => [sage, smith],
      spawnFn: () => {
        spawned = true
        return child
      },
      idleTimeoutMs: 20,
      timeoutMs: 10_000,
    })
    // Drain first: under load the idle clock can settle during workspace prepare,
    // before spawn, so awaiting spawn would hang until the vitest timeout.
    const events = await drain(driver.startTurn(turnInput(sage, { sessionId: 'wedged' })).events)
    expect(events).toEqual([
      { type: 'error', message: `${RESUME_FAILURE_PREFIX}the turn went quiet: no activity for 0s` },
    ])
    if (spawned) expect(child.killed).toBe(true)
  })

  it('closes a finished turn when Grok writes turn_ended to its session file', async () => {
    const child = new FakeChild()
    let onSpawn: () => void = () => undefined
    const spawned = new Promise<void>((resolve) => {
      onSpawn = resolve
    })
    const eventsFile = grokSessionEventsPath(grokHome, path.join(scratch, 'sage'), 'file-end')
    await mkdir(path.dirname(eventsFile), { recursive: true })
    await writeFile(eventsFile, '')
    const driver = createGrokDriver({
      agents: () => [sage, smith],
      spawnFn: () => {
        onSpawn()
        return child
      },
    })
    const handle = driver.startTurn(turnInput(sage))
    const collected = drain(handle.events)
    await spawned

    child.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'file-end' })}\n`)
    child.stdout.write(
      `${JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg-file',
          model: 'grok-4.6',
          content: [{ type: 'text', text: 'Done via the session file.' }],
        },
      })}\n`,
    )
    await new Promise((resolve) => setTimeout(resolve, 30))
    await writeFile(
      eventsFile,
      '{"ts":"2026-08-19T09:29:47.906Z","type":"turn_ended","outcome":"completed"}\n',
    )

    const events = await collected
    expect(events.at(-1)).toEqual({
      type: 'result',
      text: 'Done via the session file.',
      sessionId: 'file-end',
    })
    expect(child.killed).toBe(true)
  })

  it('prefers the official result when it arrives with the end_turn frame', async () => {
    const child = new FakeChild()
    let onSpawn: () => void = () => undefined
    const spawned = new Promise<void>((resolve) => {
      onSpawn = resolve
    })
    const driver = createGrokDriver({
      agents: () => [sage, smith],
      spawnFn: () => {
        onSpawn()
        return child
      },
    })
    const handle = driver.startTurn(turnInput(sage))
    const collected = drain(handle.events)
    await spawned

    child.stdout.write(
      [
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 'both' }),
        JSON.stringify({
          type: 'assistant',
          message: {
            id: 'msg-both',
            model: 'grok-4.6',
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: 'Done.' }],
            usage: {
              input_tokens: 10,
              output_tokens: 3,
              cache_read_input_tokens: 2,
              cache_creation_input_tokens: 0,
            },
          },
        }),
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'Done.',
          session_id: 'both',
          usage: {
            input_tokens: 10,
            output_tokens: 3,
            cache_read_input_tokens: 2,
            cache_creation_input_tokens: 0,
          },
        }),
      ].join('\n') + '\n',
    )

    const events = await collected
    const results = events.filter((event) => event.type === 'result')
    expect(results).toEqual([
      {
        type: 'result',
        text: 'Done.',
        usage: { inputTokens: 12, outputTokens: 3 },
        contextTokens: 12,
        reportedModel: 'grok-4.6',
        sessionId: 'both',
      },
    ])
  })

  it('drops an official result that arrives after the grace has already settled', async () => {
    const child = new FakeChild()
    let onSpawn: () => void = () => undefined
    const spawned = new Promise<void>((resolve) => {
      onSpawn = resolve
    })
    const driver = createGrokDriver({
      agents: () => [sage, smith],
      spawnFn: () => {
        onSpawn()
        return child
      },
    })
    const handle = driver.startTurn(turnInput(sage))
    const collected = drain(handle.events)
    await spawned

    child.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'late' })}\n`)
    child.stdout.write(
      `${JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg-late',
          model: 'grok-4.6',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'Synthetic first.' }],
        },
      })}\n`,
    )
    await new Promise((resolve) => setTimeout(resolve, GROK_RESULT_GRACE_MS + 20))
    child.stdout.write(
      `${JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'Too late.',
        session_id: 'late',
        usage: {
          input_tokens: 10,
          output_tokens: 3,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      })}\n`,
    )

    const events = await collected
    expect(events.filter((event) => event.type === 'result')).toEqual([
      { type: 'result', text: 'Synthetic first.', sessionId: 'late' },
    ])
  })

  it('does not synthetic-settle an end_turn while ask-user holds this turn', async () => {
    const child = Object.assign(new FakeChild(), { pid: 99991 })
    const gate = new TurnIdleGate()
    let onSpawn: () => void = () => undefined
    const spawned = new Promise<void>((resolve) => {
      onSpawn = resolve
    })
    const driver = createGrokDriver({
      agents: () => [sage, smith],
      spawnFn: () => {
        onSpawn()
        return child
      },
      idleGate: gate,
    })
    const handle = driver.startTurn(turnInput(sage))
    const collected = drain(handle.events)
    await spawned

    gate.hold('main', 'sage')
    child.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'held' })}\n`)
    child.stdout.write(
      `${JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg-held',
          model: 'grok-4.6',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'Waiting on you.' }],
        },
      })}\n`,
    )
    await new Promise((resolve) => setTimeout(resolve, GROK_RESULT_GRACE_MS + 20))
    expect(child.killed).toBe(false)

    handle.stop()
    expect(child.killed).toBe(false)
    const events = await collected
    expect(child.killed).toBe(true)
    expect(events.filter((event) => event.type === 'result')).toEqual([])
  })

  it('does not fire an already-armed grace if ask-user holds before it elapses', async () => {
    const child = new FakeChild()
    const gate = new TurnIdleGate()
    let onSpawn: () => void = () => undefined
    const spawned = new Promise<void>((resolve) => {
      onSpawn = resolve
    })
    const driver = createGrokDriver({
      agents: () => [sage, smith],
      spawnFn: () => {
        onSpawn()
        return child
      },
      idleGate: gate,
    })
    const handle = driver.startTurn(turnInput(sage))
    const collected = drain(handle.events)
    await spawned

    child.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'late-hold' })}\n`)
    child.stdout.write(
      `${JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg-late-hold',
          model: 'grok-4.6',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'Question is up.' }],
        },
      })}\n`,
    )
    gate.hold('main', 'sage')
    await new Promise((resolve) => setTimeout(resolve, GROK_RESULT_GRACE_MS + 20))
    expect(child.killed).toBe(false)

    handle.stop()
    const events = await collected
    expect(events.filter((event) => event.type === 'result')).toEqual([])
  })

  it('ignores a previous turn_ended and only settles on a new complete record', async () => {
    const child = new FakeChild()
    let onSpawn: () => void = () => undefined
    const spawned = new Promise<void>((resolve) => {
      onSpawn = resolve
    })
    const eventsFile = grokSessionEventsPath(grokHome, path.join(scratch, 'sage'), 'resume-end')
    await mkdir(path.dirname(eventsFile), { recursive: true })
    await writeFile(eventsFile, '{"ts":"2026-08-19T08:00:00.000Z","type":"turn_ended","outcome":"completed"}\n')
    const driver = createGrokDriver({
      agents: () => [sage, smith],
      spawnFn: () => {
        onSpawn()
        return child
      },
    })
    const handle = driver.startTurn(turnInput(sage, { sessionId: 'resume-end' }))
    const collected = drain(handle.events)
    await spawned

    child.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'resume-end' })}\n`)
    child.stdout.write(
      `${JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg-resume',
          model: 'grok-4.6',
          content: [{ type: 'text', text: 'Still working.' }],
        },
      })}\n`,
    )
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(child.killed).toBe(false)

    await appendFile(eventsFile, '{"type":"turn_en')
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(child.killed).toBe(false)
    await appendFile(eventsFile, 'ded","outcome":"completed"}\n')

    const events = await collected
    expect(events.at(-1)).toEqual({
      type: 'result',
      text: 'Still working.',
      sessionId: 'resume-end',
    })
    expect(child.killed).toBe(true)
  })

  it('settles when turn_ended is already in the session file before stdout inits', async () => {
    const child = new FakeChild()
    let onSpawn: () => void = () => undefined
    const spawned = new Promise<void>((resolve) => {
      onSpawn = resolve
    })
    const eventsFile = grokSessionEventsPath(grokHome, path.join(scratch, 'sage'), 'fast-end')
    await mkdir(path.dirname(eventsFile), { recursive: true })
    await writeFile(eventsFile, '{"ts":"2026-08-19T09:29:47.906Z","type":"turn_ended","outcome":"completed"}\n')
    const driver = createGrokDriver({
      agents: () => [sage, smith],
      spawnFn: () => {
        onSpawn()
        return child
      },
    })
    const handle = driver.startTurn(turnInput(sage))
    const collected = drain(handle.events)
    await spawned

    child.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fast-end' })}\n`)
    child.stdout.write(
      `${JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg-fast',
          model: 'grok-4.6',
          content: [{ type: 'text', text: 'Already done.' }],
        },
      })}\n`,
    )

    const events = await collected
    expect(events.at(-1)).toEqual({
      type: 'result',
      text: 'Already done.',
      sessionId: 'fast-end',
    })
    expect(child.killed).toBe(true)
  })

  it('kills a descendant that leaves the CLI process', async () => {
    const marker = path.join(scratch, 'descendant.pid')
    const stdoutFile = path.join(scratch, 'descendant-stdout.jsonl')
    await writeFile(
      stdoutFile,
      [
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 'desc' }),
        JSON.stringify({
          type: 'assistant',
          message: {
            id: 'msg-desc',
            model: 'grok-4.6',
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: 'Done.' }],
          },
        }),
      ].join('\n') + '\n',
    )
    const driver = createGrokDriver({
      agents: () => [sage, smith],
      spawnFn: () =>
        spawn(
          'bash',
          [
            '-c',
            `sleep 60 & echo $! > ${JSON.stringify(marker)}; cat ${JSON.stringify(stdoutFile)}; while true; do sleep 0.2; done`,
          ],
          { stdio: ['pipe', 'pipe', 'pipe'], detached: true },
        ),
    })
    const handle = driver.startTurn(turnInput(sage))
    const collected = drain(handle.events)

    const started = Date.now()
    let descendant = 0
    while (Date.now() - started < 2000) {
      try {
        descendant = Number((await readFile(marker, 'utf8')).trim())
        if (descendant > 0) break
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    }
    expect(descendant).toBeGreaterThan(0)

    await collected

    // Escalation waits 1.5s, then takes a process snapshot. Leave room for ps
    // to complete while the full workspace suite is competing for CPU.
    const deadline = Date.now() + 5_000
    let alive = true
    while (Date.now() < deadline) {
      try {
        process.kill(descendant, 0)
        await new Promise((resolve) => setTimeout(resolve, 50))
      } catch {
        alive = false
        break
      }
    }
    expect(alive).toBe(false)
  })

  it('SIGKILLs a descendant that ignores SIGTERM', async () => {
    const marker = path.join(scratch, 'stubborn.pid')
    const holder = path.join(scratch, 'hold-term.cjs')
    const stdoutFile = path.join(scratch, 'stubborn-stdout.jsonl')
    await writeFile(
      holder,
      [
        "process.on('SIGTERM', () => undefined)",
        "process.on('SIGHUP', () => undefined)",
        `require('fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid))`,
        'setInterval(() => undefined, 10_000)',
        '',
      ].join('\n'),
    )
    await writeFile(
      stdoutFile,
      [
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 'stubborn' }),
        JSON.stringify({
          type: 'assistant',
          message: {
            id: 'msg-stubborn',
            model: 'grok-4.6',
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: 'Done.' }],
          },
        }),
      ].join('\n') + '\n',
    )
    const driver = createGrokDriver({
      agents: () => [sage, smith],
      spawnFn: () =>
        spawn(
          'bash',
          [
            '-c',
            // The reply waits for the holder's pid: under a loaded suite node can start
            // after the turn ends, and SIGTERM would then kill it before its handler exists.
            `node ${JSON.stringify(holder)} & while [ ! -s ${JSON.stringify(marker)} ]; do sleep 0.05; done; cat ${JSON.stringify(stdoutFile)}; while true; do sleep 0.2; done`,
          ],
          { stdio: ['pipe', 'pipe', 'pipe'], detached: true },
        ),
    })
    const handle = driver.startTurn(turnInput(sage))
    const collected = drain(handle.events)

    const started = Date.now()
    let descendant = 0
    while (Date.now() - started < 8000) {
      try {
        descendant = Number((await readFile(marker, 'utf8')).trim())
        if (descendant > 0) break
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    }
    expect(descendant).toBeGreaterThan(0)

    await collected
    try {
      process.kill(descendant, 0)
    } catch {
      throw new Error('the descendant died on SIGTERM, so SIGKILL was never exercised')
    }

    // The KILL follows a 1.5s grace and two `ps` snapshots, which a loaded suite slows down.
    const deadline = Date.now() + 6000
    let alive = true
    while (Date.now() < deadline) {
      try {
        process.kill(descendant, 0)
        await new Promise((resolve) => setTimeout(resolve, 50))
      } catch {
        alive = false
        break
      }
    }
    expect(alive).toBe(false)
  }, 20_000)

  it('redacts attached capability values from CLI errors', async () => {
    process.env.MANOR_BROWSER_BROKER_CAPABILITY = 'host-secret'
    try {
      const { events } = await run({
        input: { mcpServers: [attachment] },
        stderr: 'provider rejected host-secret',
        exitCode: 1,
      })

      expect(events).toEqual([{ type: 'error', message: 'provider rejected [redacted]' }])
    } finally {
      delete process.env.MANOR_BROWSER_BROKER_CAPABILITY
    }
  })
})

describe('grok turn-end signals', () => {
  it('recognises an assistant frame that finished without another tool call', () => {
    expect(
      grokAssistantLineFinished(
        JSON.stringify({
          type: 'assistant',
          message: {
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: 'Done.' }],
          },
        }),
      ),
    ).toBe(true)
    expect(
      grokAssistantLineFinished(
        JSON.stringify({
          type: 'assistant',
          message: {
            stop_reason: 'tool_use',
            content: [{ type: 'tool_use', name: 'read_file', id: '1', input: {} }],
          },
        }),
      ),
    ).toBe(false)
    expect(grokAssistantLineFinished('not json')).toBe(false)
  })

  it('names the session events file the way Grok encodes cwd', () => {
    expect(grokSessionEventsPath('/home/grok', '/scratch/sage', 'abc')).toBe(
      path.join('/home/grok', 'sessions', encodeURIComponent('/scratch/sage'), 'abc', 'events.jsonl'),
    )
    expect(grokEventLineEndedTurn('{"type":"turn_ended","outcome":"completed"}')).toBe(true)
    expect(grokEventLineEndedTurn('{"type":"phase_changed"}')).toBe(false)
  })

  it('holds a split turn_ended record until the line is complete', () => {
    const first = pullGrokEventLines('{"type":"turn_en', '')
    expect(first.lines).toEqual([])
    expect(first.remainder).toBe('{"type":"turn_en')
    expect(first.lines.some(grokEventLineEndedTurn)).toBe(false)

    const second = pullGrokEventLines('ded","outcome":"completed"}\n', first.remainder)
    expect(second.lines).toEqual(['{"type":"turn_ended","outcome":"completed"}'])
    expect(second.remainder).toBe('')
    expect(second.lines.some(grokEventLineEndedTurn)).toBe(true)
  })
})
