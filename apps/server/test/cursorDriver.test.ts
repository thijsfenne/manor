import { EventEmitter, once } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import type { AgentConfig, AttachedMcpServer, RuntimeEvent, TurnInput } from '@manor/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HOUSE_STYLE_HEADING, REPLY_LANGUAGE_LINE } from '../src/composer.js'
import { singleAgentFor } from '../src/singleChat.js'
import { RESUME_FAILURE_PREFIX } from '../src/drivers/resumeFailure.js'
import { interactionMcpAttachment } from '../src/mcp/interactionAttachment.js'
import {
  buildCursorArgs,
  buildCursorMcpConfig,
  createCursorDriver,
  cursorCliModel,
  CursorStreamParser,
  type CursorSpawnFn,
} from '../src/drivers/cursorDriver.js'

const sage: AgentConfig = {
  id: 'sage',
  name: 'Sage',
  color: '#6FA8A0',
  character: 'You are Sage.',
  driver: 'cursor',
  model: 'cursor-composer-2.5',
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
  model: 'cursor-claude-opus-5',
  effort: 'max',
  allowedTools: ['Read', 'Bash'],
}

const stdioAttachment: AttachedMcpServer = {
  server: {
    id: 'mail',
    name: 'mail',
    command: 'mail-mcp',
    args: ['--stdio'],
    envKeys: ['MAIL_TOKEN'],
    description: '',
    writes: false,
    effectPolicy: 'confirm_writes' as const,
    tools: ['search'],
    readOnlyTools: [],
    schemaChars: 10,
  },
  disabledTools: [],
}

const turnInput = (agent: AgentConfig, overrides: Partial<TurnInput> = {}): TurnInput => ({
  agent,
  threadId: 'main',
  cwd: scratch,
  repoPaths: [],
  catchUp: [{ id: 'evt_1', ts: 1, type: 'user_message', text: 'Say hello.', mentions: [agent.id] }],
  isFullCatchUp: true,
  ...overrides,
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

const drain = async (events: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> => {
  const collected: RuntimeEvent[] = []
  for await (const event of events) collected.push(event)
  return collected
}

let scratch: string
let cursorConfig: string
const previousConfig = process.env.MANOR_CURSOR_CONFIG_DIR

beforeAll(() => {
  scratch = mkdtempSync(path.join(os.tmpdir(), 'manor-cursor-scratch-'))
  cursorConfig = mkdtempSync(path.join(os.tmpdir(), 'manor-cursor-config-'))
  process.env.MANOR_CURSOR_CONFIG_DIR = cursorConfig
})

afterAll(() => {
  if (previousConfig === undefined) delete process.env.MANOR_CURSOR_CONFIG_DIR
  else process.env.MANOR_CURSOR_CONFIG_DIR = previousConfig
})

async function run(options: {
  driverFactory?: typeof createCursorDriver
  agent?: AgentConfig
  input?: Partial<TurnInput>
  stdout?: Record<string, unknown>[]
  stderr?: string
  exitCode?: number
  stdinError?: Error
}) {
  const child = new FakeChild()
  let stdin = ''
  child.stdin.on('data', (chunk: Buffer) => {
    stdin += chunk.toString('utf8')
  })
  let seen: { args: string[]; env: NodeJS.ProcessEnv; cwd: string } | undefined
  let spawnedResolve: () => void = () => undefined
  const spawned = new Promise<void>((resolve) => {
    spawnedResolve = resolve
  })
  const driver = (options.driverFactory ?? createCursorDriver)({
    agents: () => [sage, smith],
    timeoutMs: 5_000,
    spawnFn: (_command, args, spawnOptions) => {
      seen = { args: [...args], env: spawnOptions.env, cwd: spawnOptions.cwd }
      spawnedResolve()
      return child
    },
  })
  const agent = options.agent ?? sage
  const handle = driver.startTurn(turnInput(agent, options.input))
  const collected = drain(handle.events)
  await spawned
  if (options.stdinError !== undefined) child.stdin.emit('error', options.stdinError)
  if (seen === undefined) throw new Error('Cursor did not spawn')
  for (const event of options.stdout ?? []) child.stdout.write(`${JSON.stringify(event)}\n`)
  child.stdout.end()
  if (options.stderr !== undefined) child.stderr.write(options.stderr)
  child.stderr.end()
  await Promise.all([once(child.stdout, 'end'), once(child.stderr, 'end')])
  child.emit('close', options.exitCode ?? 0)
  return { events: await collected, stdin, child, ...seen }
}

it('fails the turn when child stdin breaks without crashing the process', async () => {
  const { events } = await run({ stdinError: Object.assign(new Error('broken pipe'), { code: 'EPIPE' }) })
  expect(events).toContainEqual({ type: 'error', message: expect.stringContaining('broken pipe') })
})

describe('background work Cursor waits on silently', () => {
  async function start(options: { backgroundHoldMs?: number; resultGraceMs?: number } = {}, input: Partial<TurnInput> = {}) {
    const child = new FakeChild()
    let spawnedResolve: () => void = () => undefined
    const spawned = new Promise<void>((resolve) => { spawnedResolve = resolve })
    // The idle clock already runs while the driver prepares its workspace on disk.
    // 20ms lost that race under a full parallel suite, so the turn died before spawning.
    const driver = createCursorDriver({
      agents: () => [sage], timeoutMs: 5_000, idleTimeoutMs: 400, ...options,
      spawnFn: () => { spawnedResolve(); return child },
    })
    const handle = driver.startTurn(turnInput(sage, input))
    const events = drain(handle.events)
    await spawned
    const write = async (...lines: Record<string, unknown>[]) => {
      for (const line of lines) child.stdout.write(`${JSON.stringify(line)}\n`)
      await new Promise((resolve) => setImmediate(resolve))
    }
    return { child, events, write, handle }
  }
  /** The shapes cursor-agent 2026.10.01 printed for a backgrounded shell. */
  const backgroundShell = (command: string) => [
    { type: 'system', subtype: 'init', session_id: 'session-1' },
    { type: 'tool_call', subtype: 'started', call_id: 'call-1', tool_call: { shellToolCall: { args: { command, isBackground: true } } } },
    { type: 'tool_call', subtype: 'completed', call_id: 'call-1', tool_call: { shellToolCall: {
      args: { command, isBackground: true }, result: { success: { shellId: 213178, exitCode: 0 }, isBackground: true },
    } } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'started' }] }, session_id: 'session-1' },
  ]
  const settledWithin = (events: Promise<RuntimeEvent[]>, ms: number) =>
    Promise.race([events.then(() => true), new Promise<false>((resolve) => setTimeout(() => resolve(false), ms))])

  it('keeps the idle clock paused until the task notification, then restores it', async () => {
    const { child, events, write } = await start()
    await write(...backgroundShell('sleep 330 && echo done'))
    expect(await settledWithin(events, 70)).toBe(false)
    expect(child.killed).toBe(false)
    await write({ type: 'system', subtype: 'task_notification', task_id: '213178', status: 'success', session_id: 'session-1' })
    const seen = await events
    expect(seen).toContainEqual({ type: 'error', message: 'the turn went quiet: no activity for 0s' })
    expect(child.killed).toBe(true)
  })

  const rows = (events: RuntimeEvent[]) =>
    events.filter((event) => event.type === 'tool_use' || event.type === 'tool_result' || event.type === 'background_wait')

  it('shows what it waits on once it answered, and the launch row runs until the notification', async () => {
    const { events, write } = await start({ resultGraceMs: 20 })
    await write(...backgroundShell('pnpm build'))
    await write({ type: 'system', subtype: 'task_notification', task_id: '213178', status: 'success', session_id: 'session-1' })
    await write(
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Built.' }] }, session_id: 'session-1' },
      { type: 'result', subtype: 'success', result: 'Built.', session_id: 'session-1' },
    )
    expect(rows(await events)).toMatchObject([
      { type: 'tool_use', toolCallId: 'call-1', command: 'pnpm build', background: true },
      { type: 'background_wait', agents: 0, commands: 1 },
      { type: 'tool_result', toolCallId: 'call-1', outcome: 'success' },
      { type: 'background_wait', agents: 0, commands: 0 },
    ])
  })

  it('sets no cap where the room wakes, and Stop settles the open launch row as stopped', async () => {
    const { child, events, write, handle } = await start({ backgroundHoldMs: 30 }, { live: true })
    await write(...backgroundShell('pnpm dev'))
    expect(await settledWithin(events, 120)).toBe(false)
    expect(child.killed).toBe(false)
    handle.stop()
    const seen = await events
    expect(seen.filter((event) => event.type === 'error')).toEqual([])
    expect(rows(seen).at(-1)).toMatchObject({ type: 'tool_result', toolCallId: 'call-1', outcome: 'stopped' })
  })

  it('ends the wait at the cap with a redacted note naming the task', async () => {
    process.env.MANOR_TEST_CAPABILITY = 'capability-secret'
    const granted = { ...stdioAttachment, server: { ...stdioAttachment.server, envKeys: ['MANOR_TEST_CAPABILITY'] } }
    try {
      const { child, events, write } = await start({ backgroundHoldMs: 60 }, { mcpServers: [granted] })
      await write(...backgroundShell('curl -H capability-secret https://example.test'))
      const seen = await events
      expect(child.killed).toBe(true)
      expect(JSON.stringify(seen)).not.toContain('capability-secret')
      expect(seen.filter((event) => event.type === 'error')).toEqual([{
        type: 'error', message: expect.stringMatching(/^Stopped waiting for background work after 0 minutes\. Still running: curl -H /),
      }])
    } finally {
      delete process.env.MANOR_TEST_CAPABILITY
    }
  })
})

it('fails a synchronous E2BIG spawn and clears its idle clock', async () => {
  const driver = createCursorDriver({
    agents: () => [sage], timeoutMs: 1_000,
    spawnFn: () => { throw Object.assign(new Error('argument list too long'), { code: 'E2BIG' }) },
  })
  const events = await drain(driver.startTurn(turnInput(sage)).events)
  expect(events).toContainEqual({ type: 'error', message: expect.stringContaining('argument list too long') })
})

describe('cursorCliModel', () => {
  it.each(['low', 'medium', 'high', 'xhigh', 'max'] as const)('maps Grok 4.7 %s to its unprefixed CLI id at either speed', (effort) => {
    const suffix = effort === 'max' ? 'xhigh' : effort
    expect(cursorCliModel('cursor-grok-4.7', effort)).toBe(`grok-4.7-${suffix}`)
    expect(cursorCliModel('cursor-grok-4.7', effort, 'fast')).toBe(`grok-4.7-${suffix}-fast`)
  })

  it('maps every curated family and effort to an installed Cursor model id', () => {
    expect(cursorCliModel('cursor-grok-4.6', 'xhigh')).toBe('cursor-grok-4.6-xhigh')
    expect(cursorCliModel('cursor-composer-2.5', 'max')).toBe('composer-2.5')
    expect(cursorCliModel('cursor-claude-opus-5', 'max')).toBe('claude-opus-5-thinking-max')
    expect(cursorCliModel('cursor-claude-sonnet-5-5', 'max')).toBe('claude-sonnet-5-5-max')
    expect(cursorCliModel('cursor-gpt-5.6-luna', 'high')).toBe('gpt-5.6-luna-high')
    expect(cursorCliModel('cursor-gpt-5.6-sol', 'medium')).toBe('gpt-5.6-sol-medium')
    expect(cursorCliModel('cursor-claude-fable-5-1', 'low')).toBe('claude-fable-5-1-thinking-low')
    expect(cursorCliModel('cursor-claude-fable-5-2', 'max')).toBe('claude-fable-5-2-max')
    expect(cursorCliModel('cursor-gemini-3.8-flash', 'medium')).toBe('gemini-3.8-flash-medium')
    expect(cursorCliModel('cursor-gemini-3.8-flash', 'max')).toBe('gemini-3.8-flash-high')
    expect(cursorCliModel('cursor-kimi-k3', 'max')).toBe('kimi-k3-max')
    expect(cursorCliModel('cursor-glm-5.2', 'high')).toBe('glm-5.2-high')
    expect(cursorCliModel('cursor-muse-spark-1.3', 'high')).toBe('muse-spark-1.3-high')
    expect(cursorCliModel('cursor-muse-spark-1.3', 'max')).toBe('muse-spark-1.3-max')
    expect(cursorCliModel('cursor-muse-wonder-1.0', 'xhigh')).toBe('muse-wonder-1.0-xhigh')
  })

  it('selects only fast variants the installed Cursor catalogue actually exposes', () => {
    expect(cursorCliModel('cursor-grok-4.6', 'xhigh', 'fast')).toBe('cursor-grok-4.6-xhigh-fast')
    expect(cursorCliModel('cursor-composer-2.5', 'high', 'fast')).toBe('composer-2.5-fast')
    expect(cursorCliModel('cursor-claude-opus-5', 'max', 'fast')).toBe('claude-opus-5-thinking-max-fast')
    expect(cursorCliModel('cursor-claude-opus-5-5', 'xhigh', 'fast')).toBe('claude-opus-5-5-xhigh-fast')
    expect(cursorCliModel('cursor-gpt-5.6-luna', 'high', 'fast')).toBe('gpt-5.6-luna-high-fast')
    expect(cursorCliModel('cursor-gpt-5.6-sol', 'medium', 'fast')).toBe('gpt-5.6-sol-medium-fast')
    expect(cursorCliModel('cursor-claude-fable-5-1', 'low', 'fast')).toBe('claude-fable-5-1-thinking-low')
    expect(cursorCliModel('cursor-claude-fable-5-2', 'low', 'fast')).toBe('claude-fable-5-2-low')
    expect(cursorCliModel('cursor-claude-sonnet-5-5', 'high', 'fast')).toBe('claude-sonnet-5-5-high')
    expect(cursorCliModel('cursor-gemini-3.8-flash', 'high', 'fast')).toBe('gemini-3.8-flash-high')
    expect(cursorCliModel('cursor-muse-spark-1.3', 'high', 'fast')).toBe('muse-spark-1.3-high')
    expect(cursorCliModel('cursor-muse-wonder-1.0', 'high', 'fast')).toBe('muse-wonder-1.0-high')
  })
})

describe('buildCursorArgs', () => {
  it('uses headless partial streaming and read-only ask mode for a tool-less persona', () => {
    const args = buildCursorArgs(turnInput(sage), '/tmp/sage')
    expect(args).toContain('--print')
    expect(args).toContain('--stream-partial-output')
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual([
      '--model',
      'composer-2.5',
    ])
    expect(args.slice(args.indexOf('--mode'), args.indexOf('--mode') + 2)).toEqual(['--mode', 'ask'])
    expect(args).not.toContain('--force')
  })

  it('gives a tool-holding persona full access, adds folders and resumes', () => {
    const args = buildCursorArgs(turnInput(smith, {
      repoPaths: ['/repos/manor', '/vault'],
      sessionId: 'cursor-session',
    }), '/tmp/smith')
    expect(args).toContain('--force')
    expect(args.slice(args.indexOf('--sandbox'), args.indexOf('--sandbox') + 2)).toEqual([
      '--sandbox',
      'disabled',
    ])
    expect(args.flatMap((arg, index) => arg === '--add-dir' ? [args[index + 1]] : [])).toEqual([
      '/repos/manor',
      '/vault',
    ])
    expect(args.slice(-2)).toEqual(['--resume', 'cursor-session'])
  })

  it('uses Agent mode when an attached MCP can write', () => {
    const writable = { ...stdioAttachment, server: { ...stdioAttachment.server, writes: true } }
    const args = buildCursorArgs(turnInput(sage, { mcpServers: [writable] }), '/tmp/sage')

    expect(args).toContain('--force')
    expect(args.slice(args.indexOf('--sandbox'), args.indexOf('--sandbox') + 2)).toEqual([
      '--sandbox',
      'disabled',
    ])
    expect(args).not.toContain('--mode')
  })

  it('keeps a Manor-owned tool-less follow-up in Agent mode', () => {
    const args = buildCursorArgs(turnInput(sage, { manorFollowUp: true }), '/tmp/sage')

    expect(args).toContain('--force')
    expect(args.slice(args.indexOf('--sandbox'), args.indexOf('--sandbox') + 2)).toEqual([
      '--sandbox',
      'disabled',
    ])
    expect(args).not.toContain('--mode')
  })

  it('passes Fast through the model id and leaves Standard unchanged', () => {
    const fast = buildCursorArgs(turnInput(sage, { speed: 'fast' }), '/tmp/sage')
    expect(fast.slice(fast.indexOf('--model'), fast.indexOf('--model') + 2)).toEqual([
      '--model',
      'composer-2.5-fast',
    ])
    expect(buildCursorArgs(turnInput(sage), '/tmp/sage')).not.toContain('composer-2.5-fast')
  })
})

describe('buildCursorMcpConfig', () => {
  it('writes only environment placeholders, never their values', () => {
    const config = buildCursorMcpConfig([{ ...stdioAttachment, runtimeEnv: { TURN_TOKEN: 'secret' } }])
    expect(config).toContain('"MAIL_TOKEN": "${env:MAIL_TOKEN}"')
    expect(config).toContain('"TURN_TOKEN": "${env:TURN_TOKEN}"')
    expect(config).not.toContain('secret')
  })

  it('renders HTTP header values as Cursor environment placeholders', () => {
    const config = buildCursorMcpConfig([{
      server: {
        ...stdioAttachment.server,
        command: '',
        args: [],
        envKeys: ['COMPOSIO_CONSUMER_API_KEY'],
        httpHeaders: [{ name: 'x-consumer-api-key', envKey: 'COMPOSIO_CONSUMER_API_KEY' }],
        url: 'https://connect.composio.dev/mcp',
      },
      disabledTools: [],
    }])
    expect(config).toContain('"x-consumer-api-key": "${env:COMPOSIO_CONSUMER_API_KEY}"')
  })

  it('refuses an exclusion Cursor cannot enforce', () => {
    expect(() => buildCursorMcpConfig([{ ...stdioAttachment, disabledTools: ['send'] }]))
      .toThrow('cannot enforce disabled MCP tools')
  })

  it('accepts the intrinsically narrowed Manor tools used by unattended routines', () => {
    const attachment = interactionMcpAttachment(
      'http://127.0.0.1:8787/internal/user-input',
      'routine-capability',
      { allowAsk: false, allowRelay: false },
    )

    expect(attachment.server.tools).toEqual(['prepare_outbound_draft'])
    expect(() => buildCursorMcpConfig([attachment])).not.toThrow()
  })
})

describe('CursorStreamParser', () => {
  it('normalises partial text, tools, usage and the session while dropping raw thinking', () => {
    const parser = new CursorStreamParser('cursor-composer-2.5')
    const lines = [
      { type: 'system', subtype: 'init', session_id: 'cursor-session', model: 'Composer 2.5' },
      { type: 'thinking', subtype: 'delta', text: 'Checking ', session_id: 'cursor-session' },
      { type: 'thinking', subtype: 'delta', text: 'the cwd.', session_id: 'cursor-session' },
      { type: 'thinking', subtype: 'completed', session_id: 'cursor-session' },
      {
        type: 'tool_call', subtype: 'started', call_id: 'tool-1', session_id: 'cursor-session',
        tool_call: { shellToolCall: { args: { command: 'pwd' }, description: 'Print cwd' } },
      },
      {
        type: 'tool_call', subtype: 'completed', call_id: 'tool-1', session_id: 'cursor-session',
        tool_call: { shellToolCall: { args: { command: 'pwd' }, result: { success: { exitCode: 0 } } } },
      },
      {
        type: 'assistant', timestamp_ms: 1, session_id: 'cursor-session',
        message: { content: [{ type: 'text', text: 'CUR' }] },
      },
      {
        type: 'assistant', timestamp_ms: 2, session_id: 'cursor-session',
        message: { content: [{ type: 'text', text: 'SOR_OK' }] },
      },
      {
        type: 'assistant', session_id: 'cursor-session',
        message: { content: [{ type: 'text', text: 'CURSOR_OK' }] },
      },
      {
        type: 'result', subtype: 'success', result: 'CURSOR_OK', session_id: 'cursor-session',
        usage: { inputTokens: 16055, outputTokens: 33 },
      },
    ]
    const events = lines.flatMap((line) => parser.handle(JSON.stringify(line)))

    expect(events).toEqual([
      { type: 'tool_use', toolCallId: 'tool-1', tool: 'Shell', detail: 'pwd', command: 'pwd', subject: 'Print cwd' },
      { type: 'tool_result', toolCallId: 'tool-1', outcome: 'success' },
      { type: 'delta', messageId: 'cursor_message_1', text: 'CUR' },
      { type: 'delta', messageId: 'cursor_message_1', text: 'SOR_OK' },
      { type: 'message', messageId: 'cursor_message_1', text: 'CURSOR_OK' },
      {
        type: 'result', text: 'CURSOR_OK', usage: { inputTokens: 16055, outputTokens: 33 },
        reportedModel: 'cursor-composer-2.5', sessionId: 'cursor-session',
      },
    ])
  })

  // cursor-agent's stream-json writer prints usage only on the terminal `result` and no
  // summarising event at all (bundle 2026.10.16), so Cursor keeps the after-turn reading.
  it('reports no live context or compaction mid-turn: the CLI emits neither', () => {
    const parser = new CursorStreamParser('cursor-composer-2.5')
    const events = [
      { type: 'system', subtype: 'init', session_id: 'cursor-session', model: 'Composer 2.5' },
      { type: 'tool_call', subtype: 'started', call_id: 't1', session_id: 'cursor-session', tool_call: { shellToolCall: { args: { command: 'ls' } } } },
      { type: 'tool_call', subtype: 'completed', call_id: 't1', session_id: 'cursor-session', tool_call: { shellToolCall: { args: { command: 'ls' }, result: { success: { exitCode: 0 } } } } },
      { type: 'assistant', session_id: 'cursor-session', message: { content: [{ type: 'text', text: 'Listed.' }] } },
    ].flatMap((line) => parser.handle(JSON.stringify(line)))
    expect(events.filter((event) => event.type === 'context' || event.type === 'compaction')).toEqual([])
  })

  it('turns Cursor’s todo tool into plan snapshots, merges included, without a tool row', () => {
    const parser = new CursorStreamParser('cursor-composer-2.5')
    const todo = (id: string, content: string, status: string) => ({ id, content, status, createdAt: '1', updatedAt: '1', dependencies: [] })
    const call = (subtype: string, callId: string, args: unknown, result?: unknown) => ({
      type: 'tool_call', subtype, call_id: callId, session_id: 'cursor-session',
      tool_call: { updateTodosToolCall: { args, ...(result === undefined ? {} : { result: { success: result } }) } },
    })
    const first = [todo('a', 'Alpha', 'TODO_STATUS_IN_PROGRESS'), todo('b', 'Beta', 'TODO_STATUS_PENDING')]
    const merged = [todo('a', 'Alpha', 'TODO_STATUS_COMPLETED'), todo('b', 'Beta', 'TODO_STATUS_IN_PROGRESS'), todo('c', 'Gamma', 'TODO_STATUS_CANCELLED')]
    const lines = [
      call('started', 't1', { todos: first, merge: false }),
      call('completed', 't1', { todos: first, merge: false }, { todos: first, totalCount: 2, wasMerge: false }),
      call('started', 't2', { todos: [merged[0]], merge: true }),
      call('completed', 't2', { todos: [merged[0]], merge: true }, { todos: merged, totalCount: 3, wasMerge: true }),
    ]
    expect(lines.flatMap((line) => parser.handle(JSON.stringify(line)))).toEqual([
      { type: 'todo_update', todos: [{ text: 'Alpha', status: 'in_progress' }, { text: 'Beta', status: 'pending' }] },
      { type: 'todo_update', todos: [{ text: 'Alpha', status: 'completed' }, { text: 'Beta', status: 'in_progress' }] },
    ])
  })

  it('counts cache reads and writes in usage and the context estimate', () => {
    const parser = new CursorStreamParser('cursor-composer-2.5')
    const events = parser.handle(JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'Done.',
      session_id: 'cursor-session',
      usage: {
        inputTokens: 14_802,
        cacheReadTokens: 25_457,
        cacheWriteTokens: 321,
        outputTokens: 12,
      },
    }))

    expect(events).toEqual([{
      type: 'result',
      text: 'Done.',
      usage: { inputTokens: 40_580, outputTokens: 12 },
      contextTokens: 40_580,
      reportedModel: 'cursor-composer-2.5',
      sessionId: 'cursor-session',
    }])
  })

  it('marks a canceled HTTP/2 result as safe to resume with its Cursor session', () => {
    const parser = new CursorStreamParser('cursor-grok-4.6')
    const message = 'RetriableError: [canceled] http/2 stream closed with error code CANCEL (0x8)'

    const events = parser.handle(JSON.stringify({
      type: 'result',
      subtype: 'error',
      is_error: true,
      result: message,
      session_id: 'cursor-session',
      usage: { inputTokens: 120, outputTokens: 7 },
    }))

    expect(events).toEqual([{
      type: 'error',
      message,
      retryable: true,
      sessionId: 'cursor-session',
      usage: { inputTokens: 120, outputTokens: 7 },
    }])
  })

  it('observes Fast only after a successful advertised Fast-model turn', () => {
    const parser = new CursorStreamParser('cursor-composer-2.5', undefined, 'fast')
    const events = parser.handle(JSON.stringify({
      type: 'result', subtype: 'success', result: 'Done.', session_id: 'cursor-session',
    }))

    expect(events).toEqual([{
      type: 'result', text: 'Done.', reportedModel: 'cursor-composer-2.5',
      observedSpeed: 'fast', sessionId: 'cursor-session',
    }])
  })

  it('attaches a successful native file write to the completed tool result', () => {
    const parser = new CursorStreamParser('cursor-composer-2.5')
    const started = {
      type: 'tool_call', subtype: 'started', call_id: 'edit-1', session_id: 'cursor-session',
      tool_call: {
        editToolCall: { args: { path: '/tmp/probe.txt', streamContent: 'alpha\nbeta\n' } },
        toolCallId: 'edit-1',
      },
    }
    const completed = {
      type: 'tool_call', subtype: 'completed', call_id: 'edit-1', session_id: 'cursor-session',
      tool_call: {
        editToolCall: {
          args: { path: '/tmp/probe.txt', streamContent: 'alpha\nbeta\n' },
          result: {
            success: {
              path: '/tmp/probe.txt',
              linesAdded: 2,
              linesRemoved: 0,
              diffString: '--- /dev/null\n+++ b//tmp/probe.txt\n@@ -1,0 +1,2 @@\n+alpha\n+beta',
              afterFullFileContent: 'alpha\nbeta\n',
            },
          },
        },
        toolCallId: 'edit-1',
      },
    }

    expect(parser.handle(JSON.stringify(started))).toEqual([{
      type: 'tool_use',
      toolCallId: 'edit-1',
      tool: 'Edit',
      detail: '/tmp/probe.txt',
      targets: ['/tmp/probe.txt'],
    }])
    expect(parser.handle(JSON.stringify(completed))).toEqual([{
      type: 'tool_result',
      toolCallId: 'edit-1',
      outcome: 'success',
      edits: [{ path: '/tmp/probe.txt', after: 'alpha\nbeta\n', created: true, offset: { before: 1, after: 0 } }],
    }])
  })

  it('tracks whole-file creation at start and attaches successful writes and deletes', () => {
    const parser = new CursorStreamParser('cursor-composer-2.5', () => false)
    const writeStarted = {
      type: 'tool_call', subtype: 'started', call_id: 'write-1',
      tool_call: { writeToolCall: { args: { path: 'summary.txt', fileText: 'Fresh\n' } } },
    }
    const writeCompleted = {
      type: 'tool_call', subtype: 'completed', call_id: 'write-1',
      tool_call: {
        writeToolCall: {
          args: { path: 'summary.txt', fileText: 'Fresh\n' },
          result: { success: { path: '/tmp/summary.txt', linesCreated: 1, fileSize: 6 } },
        },
      },
    }
    const deleteStarted = {
      type: 'tool_call', subtype: 'started', call_id: 'delete-1',
      tool_call: { deleteToolCall: { args: { path: 'old.txt' } } },
    }
    const deleteCompleted = {
      type: 'tool_call', subtype: 'completed', call_id: 'delete-1',
      tool_call: {
        deleteToolCall: {
          args: { path: 'old.txt' },
          result: { success: { path: '/tmp/old.txt', prevContent: 'Old\n' } },
        },
      },
    }

    parser.handle(JSON.stringify(writeStarted))
    expect(parser.handle(JSON.stringify(writeCompleted))).toEqual([{
      type: 'tool_result',
      toolCallId: 'write-1',
      outcome: 'success',
      edits: [{ path: '/tmp/summary.txt', after: 'Fresh\n', created: true, offset: { before: 0, after: 0 } }],
    }])
    parser.handle(JSON.stringify(deleteStarted))
    expect(parser.handle(JSON.stringify(deleteCompleted))).toEqual([{
      type: 'tool_result',
      toolCallId: 'delete-1',
      outcome: 'success',
      edits: [{ path: '/tmp/old.txt', before: 'Old\n' }],
    }])
  })
})

describe('createCursorDriver', () => {
  // `/compress` in print mode reaches the model as a prompt and shrinks nothing (real
  // CLI run, 2026-11-06), so Cursor has no live compact and Manor rolls over instead.
  it('offers no live compact', () => {
    expect(createCursorDriver({ agents: () => [] }).compactSession).toBeUndefined()
  })

  it('refreshes changed context on resume and avoids repeating acknowledged context', async () => {
    let nextSpawn: CursorSpawnFn | undefined
    const sharedDriver = createCursorDriver({
      agents: () => [sage],
      timeoutMs: 5_000,
      spawnFn: (...args) => {
        if (nextSpawn === undefined) throw new Error('Missing test spawn')
        return nextSpawn(...args)
      },
    })
    const driverFactory: typeof createCursorDriver = (options) => {
      nextSpawn = options.spawnFn
      return sharedDriver
    }
    const stdout = [
      { type: 'system', subtype: 'init', session_id: 'context-session' },
      { type: 'result', subtype: 'success', result: 'Done.', session_id: 'context-session' },
    ]
    const original = { ...sage, character: 'Standing personal memory.\n'.repeat(2_000) }
    const updated = { ...sage, character: 'Current persona, memory disabled.' }
    const input = { sessionId: 'context-session', isFullCatchUp: false, contextBlock: 'Current browser tab.' }

    const fresh = await run({ driverFactory, agent: original, stdout })
    expect(fresh.stdin).not.toContain(original.character)

    const resumed = await run({ driverFactory, agent: updated, input, stdout })
    expect(resumed.stdin).toContain(updated.character)
    expect(resumed.stdin).toContain('Current browser tab.')
    expect(resumed.stdin).not.toContain('Standing personal memory.')
    expect(resumed.args).toContain('--resume')

    const unchanged = await run({ driverFactory, agent: updated, input, stdout })
    expect(unchanged.stdin).not.toContain(updated.character)
    expect(unchanged.stdin).toContain('Current browser tab.')

    const changedAgain = { ...sage, character: 'A later corrected project decision.' }
    await run({ driverFactory, agent: changedAgain, input, stdout, exitCode: 1 })
    const retried = await run({ driverFactory, agent: changedAgain, input, stdout })
    expect(retried.stdin).toContain(changedAgain.character)

    await run({ driverFactory, agent: updated, input, stdout, exitCode: 1 })
    const restored = await run({ driverFactory, agent: changedAgain, input, stdout })
    expect(restored.stdin).toContain(changedAgain.character)
  })

  it('refreshes an unknown resumed session after a driver restart', async () => {
    const { stdin } = await run({ input: { sessionId: 'existing-session', isFullCatchUp: false } })
    expect(stdin).toContain(sage.character)
    expect(stdin).toContain('replaces the previous persona instructions')
  })

  it('seeds a neutral inherited-model helper for single sessions without house style', async () => {
    const agent = singleAgentFor({ driver: 'cursor', model: 'cursor-composer-2.5', effort: 'high' })
    const { stdin, cwd, events } = await run({ agent, input: { singleSession: true }, stdout: [
      { type: 'system', subtype: 'init', session_id: 'single-cursor' },
      { type: 'result', subtype: 'success', result: 'Done.', session_id: 'single-cursor' },
    ] })
    expect(stdin).not.toContain(HOUSE_STYLE_HEADING)
    expect(await readFile(path.join(cwd, '.cursor/agents/manor-helper.md'), 'utf8')).toContain('model: inherit')
    expect(events.at(-1)?.type).toBe('result')
    const parser = new CursorStreamParser()
    parser.handle(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'parent' }))
    expect(parser.handle(JSON.stringify({ type: 'result', subtype: 'success', result: 'Child answer', session_id: 'child', parent_tool_use_id: 'helper' }))).toEqual([])
    expect(parser.sessionId).toBe('parent')
  })

  it('keeps nested Cursor tool activity under its Task call', () => {
    const parser = new CursorStreamParser()
    parser.handle(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'parent' }))
    const childCall = {
      type: 'tool_call', parent_tool_use_id: 'task-parent', session_id: 'child', call_id: 'read-child',
      tool_call: { readToolCall: { args: { path: 'parser.ts' } } },
    }
    expect(parser.handle(JSON.stringify({ ...childCall, subtype: 'started' }))).toEqual([
      expect.objectContaining({
        type: 'tool_use', toolCallId: 'read-child', parentToolCallId: 'task-parent', tool: 'Read',
      }),
    ])
    expect(parser.handle(JSON.stringify({ ...childCall, subtype: 'completed' }))).toEqual([{
      type: 'tool_result', toolCallId: 'read-child', parentToolCallId: 'task-parent', outcome: 'success',
    }])
    expect(parser.sessionId).toBe('parent')
  })

  it('isolates config, writes the persona, and keeps the prompt off argv', async () => {
    process.env.SUPABASE_SECRET_KEY = 'database-secret'
    try {
      const { args, cwd, env, stdin, events } = await run({
        agent: smith,
        stdout: [
          { type: 'system', subtype: 'init', session_id: 'cursor-session' },
          {
            type: 'assistant', session_id: 'cursor-session',
            message: { content: [{ type: 'text', text: 'Done.' }] },
          },
          {
            type: 'result', subtype: 'success', result: 'Done.', session_id: 'cursor-session',
            usage: { inputTokens: 10, outputTokens: 2 },
          },
        ],
      })

      expect(args.join(' ')).not.toContain('Say hello')
      expect(stdin).toContain('User: Say hello.')
      expect(stdin).toContain(HOUSE_STYLE_HEADING)
      expect(stdin).toContain(`${REPLY_LANGUAGE_LINE}\n\nUser: Say hello.`)
      expect(env['CURSOR_CONFIG_DIR']).toBe(cursorConfig)
      expect(env['SUPABASE_SECRET_KEY']).toBeUndefined()
      expect(await readFile(path.join(cwd, 'AGENTS.md'), 'utf8')).toBe('You are Smith.\n')
      expect(events.at(-1)).toMatchObject({ type: 'result', sessionId: 'cursor-session' })
    } finally {
      delete process.env.SUPABASE_SECRET_KEY
    }
  })

  it('routes a dead resume through the shared clear-and-replay recovery', async () => {
    const { events } = await run({
      input: { sessionId: 'gone' },
      stderr: 'Session not found',
      exitCode: 1,
    })
    expect(events).toEqual([{ type: 'error', message: `${RESUME_FAILURE_PREFIX}Session not found` }])
  })

  it('settles a result when the CLI leaves its process open', async () => {
    const child = Object.assign(new FakeChild(), { pid: 99992 })
    let spawned: () => void = () => undefined
    const ready = new Promise<void>((resolve) => { spawned = resolve })
    const driver = createCursorDriver({
      agents: () => [sage], spawnFn: () => { spawned(); return child }, timeoutMs: 5_000, resultGraceMs: 20,
    })
    const handle = driver.startTurn(turnInput(sage))
    const done = drain(handle.events)
    await ready
    child.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', result: 'Done.', session_id: 'session-1' })}\n`)
    const outcome = await Promise.race([done, new Promise<'still running'>((resolve) => setTimeout(() => resolve('still running'), 2_000))])
    handle.stop()
    expect(outcome).not.toBe('still running')
    expect(child.killed).toBe(true)
  })

  it('keeps a post-init session error as an ordinary turn failure', async () => {
    const { events } = await run({
      input: { sessionId: 'live-session' },
      stdout: [{ type: 'system', subtype: 'init', session_id: 'live-session' }],
      stderr: 'session tool failed', exitCode: 1,
    })
    expect(events.at(-1)).toEqual({ type: 'error', message: 'session tool failed' })
  })
})
