import { EventEmitter, once } from 'node:events'
import { mkdtempSync, readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { UsageSchema, WAKE_TITLE_MAX, type AgentConfig, type LiveSessionEvent, type RuntimeEvent, type TurnHandle, type TurnInput } from '@manor/contracts'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { QUEUE_HIGH_WATER, QUEUE_LOW_WATER } from '../src/asyncQueue.js'
import { HOUSE_STYLE_HEADING, REPLY_LANGUAGE_LINE } from '../src/composer.js'
import { offeredPrefix, prefixChanges } from '../src/promptFingerprint.js'

const promptFingerprint = (input: TurnInput) => offeredPrefix(input).fingerprint
const prefixParts = (input: TurnInput) => offeredPrefix(input).parts
import {
  MCP_SWAP_FAILED,
  MCP_SWAP_TIMEOUT_MS,
  StreamParser,
  buildArgs,
  createClaudeDriver,
  isAskUserTool,
} from '../src/drivers/claudeDriver.js'
import { RESUME_FAILURE_PREFIX, isResumeFailure } from '../src/drivers/resumeFailure.js'
import { TurnIdleGate } from '../src/drivers/turnTimers.js'

const sage: AgentConfig = {
  id: 'sage',
  name: 'Sage',
  color: '#6FA8A0',
  driver: 'claude',
  effort: 'high',
  allowedTools: [],
  mcpServers: [],
  memoryScope: false,
  role: 'Generalist',
  description: '',
  isCos: false,
  character: 'You are Sage.',
}

const smith: AgentConfig = {
  id: 'smith',
  name: 'Smith',
  color: '#D08A3E',
  driver: 'claude',
  effort: 'high',
  model: 'claude-opus-4-8',
  allowedTools: ['Read', 'Bash'],
  mcpServers: [],
  memoryScope: false,
  role: 'Engineer',
  description: '',
  isCos: false,
  character: 'You are Smith.',
}

const attachedMcpServers: NonNullable<TurnInput['mcpServers']> = [
  {
    server: {
      id: 'mcp-test',
      name: 'test',
      command: 'test-mcp',
      args: [],
      envKeys: ['MANOR_TEST_CAPABILITY'],
      description: '',
      writes: false,
      effectPolicy: 'confirm_writes' as const,
      tools: [],
      readOnlyTools: [],
      schemaChars: 0,
    },
    disabledTools: [],
  },
]

/** Stand-in for the spawned CLI process: streams we drive, plus a close event. */
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

const fixture = (name: string): string[] =>
  readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)

function turnInput(agent: AgentConfig, overrides: Partial<TurnInput> = {}): TurnInput {
  return {
    agent,
    threadId: 'main',
    cwd: '/tmp/manor-scratch/main',
    catchUp: [
      { id: 'evt_000001', ts: 1, type: 'user_message', text: 'What should we build first?', mentions: [agent.id] },
    ],
    isFullCatchUp: true,
    repoPaths: [],
    ...overrides,
  }
}

async function drain(events: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const collected: RuntimeEvent[] = []
  for await (const event of events) collected.push(event)
  return collected
}

/** The user messages a turn wrote to the CLI's streaming input. */
const stdinMessages = (raw: string): { uuid: string; priority?: string; message: { content: unknown } }[] =>
  raw.split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line))

/** The text of those messages, as the CLI reads it. */
const stdinText = (raw: string): string => stdinMessages(raw).map(({ message: { content } }) =>
  typeof content === 'string' ? content : (content as { type: string; text?: string }[]).map((block) => block.text ?? '').join('')).join('\n')

interface RunResult {
  events: RuntimeEvent[]
  stdin: string
  child: FakeChild
  cwd: string
  env: NodeJS.ProcessEnv
}

it('fingerprints the built-in tools buildArgs renders, not the inputs behind them', () => {
  const plain = turnInput({ ...sage, allowedTools: ['Read'] })
  const withImage = { ...plain, imagePaths: ['/tmp/manor-scratch/main/image.png'] }
  // Read is granted already, so an image changes nothing the CLI is offered.
  expect(buildArgs(withImage)).toEqual(buildArgs(plain))
  expect(promptFingerprint(withImage).tools).toBe(promptFingerprint(plain).tools)
  const bare = turnInput({ ...sage, allowedTools: [] })
  expect(promptFingerprint({ ...bare, imagePaths: ['/tmp/image.png'] }).tools).not.toBe(promptFingerprint(bare).tools)
})

it('names the prompt block, server or model that moved between two turns of a session', () => {
  const base = turnInput({ ...sage, character: 'You are Sage.\n\n[Manor] Project preferences for Manor, from /tmp/p.md:\n- Round\n\n[Manor] House style.' })
  expect(prefixChanges(prefixParts(base), prefixParts(base))).toEqual([])
  const edited = { ...base, agent: { ...base.agent, model: 'claude-opus-5-5', character: base.agent.character.replace('- Round', '- Square') } }
  expect(prefixChanges(prefixParts(base), prefixParts(edited))).toEqual(['model', 'system:Project preferences for Manor'])
  const [persona, preferences, style] = base.agent.character.split('\n\n[Manor]')
  const moved = { ...base, agent: { ...base.agent, character: `${persona}\n\n[Manor]${style}\n\n[Manor]${preferences}` } }
  expect(prefixChanges(prefixParts(base), prefixParts(moved))).toEqual(['system:order'])
})

it('sends each changing block once per session, after a compaction again, and never in the system prompt', async () => {
  const spawned: { child: FakeChild; args: readonly string[] }[] = []
  const driver = createClaudeDriver({
    agents: () => [sage],
    spawnFn: (_command, args) => {
      const child = new FakeChild()
      spawned.push({ child, args })
      return child
    },
    timeoutMs: 5_000,
  })
  const blocks = (notes: string): TurnInput['volatileBlocks'] => [
    { key: 'notes', text: `[Manor] Current notes.md:\n${notes}` },
    { key: 'preferences', text: '[Manor] Project preferences:\n- Corners are round' },
  ]
  /** One CLI run on this driver, answered in the same provider session. */
  const answer = async (handle: TurnHandle) => {
    const { child, args } = spawned.at(-1)!
    let raw = ''
    child.stdin.on('data', (chunk: Buffer) => { raw += chunk.toString('utf8') })
    const collected = drain(handle.events)
    child.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', result: 'Done', session_id: 'blocks-session' })}\n`)
    child.stdout.end()
    child.stderr.end()
    await Promise.all([once(child.stdout, 'end'), once(child.stderr, 'end')])
    child.emit('close', 0)
    await collected
    return { stdin: stdinText(raw), system: args[args.indexOf('--system-prompt') + 1] }
  }
  const turn = (notes: string, sessionId?: string) =>
    answer(driver.startTurn(turnInput(sage, { volatileBlocks: blocks(notes), ...(sessionId === undefined ? {} : { sessionId, isFullCatchUp: false }) })))

  const fresh = await turn('- Export ships next')
  expect(fresh.stdin).toContain('[Manor context: notes]')
  expect(fresh.stdin).toContain('- Corners are round')
  expect(fresh.system).toBe(sage.character)
  const resumed = await turn('- Export ships next', 'blocks-session')
  expect(resumed.stdin).not.toContain('[Manor context:')
  const changed = await turn('- Export shipped', 'blocks-session')
  expect(changed.stdin).toContain('- Export shipped')
  expect(changed.stdin).not.toContain('- Corners are round')
  expect(changed.system).toBe(sage.character)
  await answer(driver.compactSession!({ agent: sage, sessionId: 'blocks-session', threadId: 'main', cwd: '/tmp/manor-scratch/main', repoPaths: [] }))
  const afterCompact = await turn('- Export shipped', 'blocks-session')
  expect(afterCompact.stdin).toContain('- Export shipped')
  expect(afterCompact.stdin).toContain('- Corners are round')
})

it('reports a mid-turn compaction on the result, so the runner can drop what it froze', async () => {
  const result = (lines: string[]) => run({ agent: sage, stdoutLines: lines })
  const done = JSON.stringify({ type: 'result', subtype: 'success', result: 'Done', session_id: 'compacted-session' })

  const plain = await result([done])
  expect(plain.events.find((event) => event.type === 'result')).not.toHaveProperty('compacted')

  const boundary = JSON.stringify({ type: 'system', subtype: 'compact_boundary', session_id: 'compacted-session' })
  const compacted = await result([boundary, done])
  expect(compacted.events.find((event) => event.type === 'result')).toMatchObject({ compacted: true })
})

it('pins native helpers to the single session model and omits the house-style prompt', async () => {
  const result = await run({
    agent: { ...smith, model: 'claude-opus-5-5' },
    input: { singleSession: true },
    stdoutLines: [JSON.stringify({ type: 'result', subtype: 'success', result: 'Done', session_id: 'single-test' })],
  })
  expect(result.env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('claude-opus-5-5')
  expect(result.stdin).not.toContain(HOUSE_STYLE_HEADING)
  // A Single turn skips the style but still gets the language pin.
  expect(result.stdin).toContain(REPLY_LANGUAGE_LINE)
})

it('spawns every room with lazy connectors, the no-wait switch never without forced tool search', async () => {
  const success = JSON.stringify({ type: 'result', subtype: 'success', result: 'Done', session_id: 'lazy-test' })
  for (const input of [{}, { singleSession: true }, { infrastructure: true }]) {
    const { env } = await run({ agent: sage, input, stdoutLines: [success] })
    expect(env).toMatchObject({
      CLAUDE_CODE_MCP_STARTUP_WAIT_MS: '0',
      ENABLE_TOOL_SEARCH: 'true',
      MCP_SERVER_CONNECTION_BATCH_SIZE: '16',
    })
  }
})

it('keeps the TodoWrite plan tool the CLI otherwise withholds in print mode', async () => {
  const success = JSON.stringify({ type: 'result', subtype: 'success', result: 'Done', session_id: 'todo-test' })
  const { env } = await run({ agent: sage, input: { singleSession: true }, stdoutLines: [success] })
  expect(env).toMatchObject({ CLAUDE_CODE_ENABLE_TODO_TOOLS: '1', CLAUDE_CODE_ENABLE_TASKS: '0' })
})

it('names Manor as the client and keeps the print-mode toolset, unless the label is switched off', async () => {
  const success = JSON.stringify({ type: 'result', subtype: 'success', result: 'Done', session_id: 'entry-test' })
  try {
    // Empty is the CLI default. A name the CLI gives one of its own hosts, or one it would refuse, is no label.
    for (const off of ['', '  ', 'cli', 'sdk-cli', 'claude-desktop', 'local-agent', 'remote_cowork', 'Manor', 'my label']) {
      vi.stubEnv('MANOR_CLAUDE_ENTRYPOINT', off)
      const plain = await run({ agent: sage, stdoutLines: [success] })
      expect(plain.env.CLAUDE_CODE_ENTRYPOINT, off).toBeUndefined()
      expect(buildArgs(turnInput(sage)), off).not.toContain('--disallowed-tools')
    }

    for (const [set, label] of [[undefined, 'manor'], ['house', 'house']] as const) {
      vi.stubEnv('MANOR_CLAUDE_ENTRYPOINT', set)
      const labelled = await run({ agent: sage, stdoutLines: [success] })
      expect(labelled.env).toMatchObject({
        CLAUDE_CODE_ENTRYPOINT: label,
        CLAUDE_CODE_DISABLE_ARTIFACT: '1',
        CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1',
      })
      const args = buildArgs(turnInput(sage))
      expect(args[args.indexOf('--disallowed-tools') + 1]).toBe('Agent(claude-code-guide)')
      expect(args.filter((arg) => arg === '--disallowed-tools')).toHaveLength(1)
    }
  } finally {
    vi.unstubAllEnvs()
  }
})

it('disables prompt caching only when the job opts out, leaving other infrastructure unchanged', async () => {
  const success = JSON.stringify({ type: 'result', subtype: 'success', result: 'Done', session_id: 'cache-test' })
  for (const input of [{}, { infrastructure: true }, { infrastructure: true, promptCaching: 'off' as const }]) {
    const { env } = await run({ agent: sage, input, stdoutLines: [success] })
    expect(env.DISABLE_PROMPT_CACHING).toBe('promptCaching' in input ? '1' : undefined)
  }
})

async function run(options: {
  agent: AgentConfig
  stdoutLines?: string[]
  stderr?: string
  exitCode?: number
  input?: Partial<TurnInput>
  beforeClose?: (cwd: string) => Promise<void>
  stdinError?: Error
}): Promise<RunResult> {
  const child = new FakeChild()
  let stdin = ''
  child.stdin.on('data', (chunk: Buffer) => {
    stdin += chunk.toString('utf8')
  })

  let cwd = ''
  let env: NodeJS.ProcessEnv = {}
  const driver = createClaudeDriver({
    agents: () => [sage, smith],
    spawnFn: (_command, _args, spawnOptions) => {
      cwd = spawnOptions.cwd
      env = spawnOptions.env
      return child
    },
    timeoutMs: 5_000,
  })
  const handle = driver.startTurn(turnInput(options.agent, options.input))
  const collected = drain(handle.events)
  if (options.stdinError !== undefined) child.stdin.emit('error', options.stdinError)

  for (const line of options.stdoutLines ?? []) child.stdout.write(`${line}\n`)
  child.stdout.end()
  if (options.stderr !== undefined) child.stderr.write(options.stderr)
  child.stderr.end()
  await Promise.all([once(child.stdout, 'end'), once(child.stderr, 'end')])
  if (options.beforeClose !== undefined) await options.beforeClose(cwd)
  child.emit('close', options.exitCode ?? 0)

  return { events: await collected, stdin: stdinText(stdin), child, cwd, env }
}

it('fails the turn when child stdin breaks without crashing the process', async () => {
  const { events } = await run({ agent: sage, stdinError: Object.assign(new Error('broken pipe'), { code: 'EPIPE' }) })
  expect(events).toContainEqual({ type: 'error', message: expect.stringContaining('broken pipe') })
})

it('fails a synchronous E2BIG spawn and clears its idle clock', async () => {
  const driver = createClaudeDriver({
    agents: () => [sage], timeoutMs: 1_000,
    spawnFn: () => { throw Object.assign(new Error('argument list too long'), { code: 'E2BIG' }) },
  })
  const events = await drain(driver.startTurn(turnInput(sage)).events)
  expect(events).toContainEqual({ type: 'error', message: expect.stringContaining('argument list too long') })
})

describe('buildArgs', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('runs print mode with partial stream-json and a full system-prompt replace', () => {
    const args = buildArgs(turnInput(sage))
    expect(args).toContain('--print')
    expect(args.slice(args.indexOf('--output-format'), args.indexOf('--output-format') + 2)).toEqual([
      '--output-format',
      'stream-json',
    ])
    expect(args).toContain('--include-partial-messages')
    expect(args.slice(args.indexOf('--system-prompt'), args.indexOf('--system-prompt') + 2)).toEqual([
      '--system-prompt',
      'You are Sage.',
    ])
  })

  it('disables every tool for a persona with an empty allowedTools, and passes --tools last', () => {
    const args = buildArgs(turnInput(sage))
    expect(args.slice(-2)).toEqual(['--tools', ''])
    expect(args).not.toContain('--allowedTools')
  })

  // Every infrastructure job (titles, summaries, commit messages) rides on this argv.
  it('starts no machine MCP servers, settings, plugins or skills for a turn with none attached', () => {
    const args = buildArgs(turnInput(sage))
    expect(args).toContain('--strict-mcp-config')
    expect(args).not.toContain('--mcp-config')
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('')
  })

  it('passes the named tools and the model for a persona that has them', () => {
    const args = buildArgs(turnInput(smith))
    expect(args.slice(-2)).toEqual(['--tools', 'Read,Bash'])
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual([
      '--model',
      'claude-opus-4-8',
    ])
  })

  it.each(['claude-fable-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'])('passes the curated %s id to Claude Code unchanged', (model) => {
    const args = buildArgs(turnInput({ ...sage, model }))
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual([
      '--model',
      model,
    ])
  })

  it('passes the persona effort as --effort, whatever else the turn carries', () => {
    expect(buildArgs(turnInput(sage)).slice(-2)).toEqual(['--tools', ''])
    for (const agent of [sage, smith]) {
      const args = buildArgs(turnInput(agent))
      expect(args.slice(args.indexOf('--effort'), args.indexOf('--effort') + 2)).toEqual(['--effort', 'high'])
    }
    const patient = { ...sage, effort: 'max' as const }
    const args = buildArgs(turnInput(patient))
    expect(args.slice(args.indexOf('--effort'), args.indexOf('--effort') + 2)).toEqual(['--effort', 'max'])
  })

  it('bounds the turn with --autocompact, which the CLI measures inside one turn', () => {
    const args = buildArgs(turnInput(sage))
    expect(args.slice(args.indexOf('--autocompact'), args.indexOf('--autocompact') + 2)).toEqual([
      '--autocompact',
      '300000',
    ])
  })

  it('takes the autocompact size from the environment, and drops the flag when it is empty', () => {
    vi.stubEnv('MANOR_CLAUDE_AUTOCOMPACT', '150000')
    const tuned = buildArgs(turnInput(sage))
    expect(tuned.slice(tuned.indexOf('--autocompact'), tuned.indexOf('--autocompact') + 2)).toEqual([
      '--autocompact',
      '150000',
    ])

    vi.stubEnv('MANOR_CLAUDE_AUTOCOMPACT', '')
    expect(buildArgs(turnInput(sage))).not.toContain('--autocompact')
  })

  it('adds the project folders as extra directories and hands over the full toolset', () => {
    const args = buildArgs(turnInput(sage, { repoPaths: ['/repos/manor'] }))

    // No --tools at all: the CLI default is every built-in tool, which is what full
    // access to a real working copy needs.
    expect(args).not.toContain('--tools')
    expect(args.slice(-2)).toEqual(['--add-dir', '/repos/manor'])
  })

  it('hands every linked folder to the one variadic --add-dir, last in the argv', () => {
    const args = buildArgs(turnInput(sage, { repoPaths: ['/repos/manor', '/home/sam/notes'] }))

    // One flag, not one per folder: a second `--add-dir` would be read as a value of
    // the first. Being last is what keeps a later flag from being eaten as a path.
    expect(args.filter((argument) => argument === '--add-dir')).toHaveLength(1)
    expect(args.slice(-3)).toEqual(['--add-dir', '/repos/manor', '/home/sam/notes'])
  })

  it('leaves the argv exactly as it was for a project without a repo', () => {
    const args = buildArgs(turnInput(smith))

    expect(args).not.toContain('--add-dir')
    expect(args.slice(-2)).toEqual(['--tools', 'Read,Bash'])
  })

  it('resumes the persona session when there is one', () => {
    const args = buildArgs(turnInput(sage, { sessionId: 'abc-123' }))
    expect(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2)).toEqual(['--resume', 'abc-123'])
    expect(buildArgs(turnInput(sage))).not.toContain('--resume')
  })

  it('lends Read to a toolless persona only for the turn that carries an attachment', () => {
    const withImage = buildArgs(turnInput(sage, { imagePaths: ['/scratch/attachments/evt_1-0.png'] }))
    expect(withImage.slice(-2)).toEqual(['--tools', 'Read'])
    expect(buildArgs(turnInput(sage)).slice(-2)).toEqual(['--tools', ''])
  })

  it('never lists Read twice for a persona who already holds it', () => {
    const args = buildArgs(turnInput(smith, { imagePaths: ['/scratch/attachments/evt_1-0.png'] }))
    expect(args.slice(-2)).toEqual(['--tools', 'Read,Bash'])
  })
})
describe('createClaudeDriver', () => {
  it('keeps server secrets out of the CLI and grants only attached capability keys', async () => {
    process.env.SUPABASE_SECRET_KEY = 'database-secret'
    process.env.MANOR_GITHUB_TOKEN = 'repository-secret'
    process.env.MANOR_TEST_CAPABILITY = 'capability-secret'
    try {
      const { env } = await run({
        agent: sage,
        stdoutLines: fixture('claude-success.jsonl'),
        input: { mcpServers: attachedMcpServers },
      })

      expect(env['MANOR_TEST_CAPABILITY']).toBe('capability-secret')
      expect(env['SUPABASE_SECRET_KEY']).toBeUndefined()
      expect(env['MANOR_GITHUB_TOKEN']).toBeUndefined()
    } finally {
      delete process.env.SUPABASE_SECRET_KEY
      delete process.env.MANOR_GITHUB_TOKEN
      delete process.env.MANOR_TEST_CAPABILITY
    }
  })

  it('hands a turn the ssh agent socket, so git over ssh works as it does in the Terminal', async () => {
    const before = process.env.SSH_AUTH_SOCK
    process.env.SSH_AUTH_SOCK = '/tmp/manor-test-agent.sock'
    try {
      const { env } = await run({ agent: sage, stdoutLines: fixture('claude-success.jsonl') })

      expect(env['SSH_AUTH_SOCK']).toBe('/tmp/manor-test-agent.sock')
    } finally {
      if (before === undefined) delete process.env.SSH_AUTH_SOCK
      else process.env.SSH_AUTH_SOCK = before
    }
  })

  it('redacts an attached capability when the CLI echoes it to stderr', async () => {
    process.env.MANOR_TEST_CAPABILITY = 'capability-secret'
    try {
      const { events } = await run({
        agent: sage,
        stderr: 'provider rejected capability-secret\n',
        exitCode: 1,
        input: { mcpServers: attachedMcpServers },
      })

      expect(events).toEqual([{ type: 'error', message: 'provider rejected [redacted]' }])
      expect(JSON.stringify(events)).not.toContain('capability-secret')
    } finally {
      delete process.env.MANOR_TEST_CAPABILITY
    }
  })

  it('redacts an attached capability from a structured failed result', async () => {
    process.env.MANOR_TEST_CAPABILITY = 'capability-secret'
    try {
      const { events } = await run({
        agent: sage,
        stdoutLines: [
          '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"provider rejected capability-secret"}',
        ],
        exitCode: 1,
        input: { mcpServers: attachedMcpServers },
      })

      expect(events).toEqual([{ type: 'error', message: 'provider rejected [redacted]' }])
      expect(JSON.stringify(events)).not.toContain('capability-secret')
    } finally {
      delete process.env.MANOR_TEST_CAPABILITY
    }
  })

  it('parses a successful stream into deltas and a final result', async () => {
    const { events, stdin } = await run({ agent: sage, stdoutLines: fixture('claude-success.jsonl') })

    expect(events.filter((event) => event.type === 'delta')).toEqual([
      { type: 'delta', messageId: 'msg_01ABCDEF', text: 'Start with ' },
      { type: 'delta', messageId: 'msg_01ABCDEF', text: 'the heart.' },
    ])
    expect(events.filter((event) => event.type === 'message')).toEqual([
      { type: 'message', messageId: 'msg_01ABCDEF', text: 'Start with the heart.' },
    ])

    const result = events.at(-1)
    expect(result).toEqual({
      type: 'result',
      text: 'Start with the heart.',
      // input_tokens + cache_creation + cache_read, all of it subscription spend
      usage: { inputTokens: 2152, outputTokens: 57, costUsd: 0.0123 },
      // The one request's own prompt, off the assistant line, not the result line.
      contextTokens: 812,
      // Known, not reported: Manor itself puts this threshold on the argv.
      autoCompactTokens: 300_000,
      // Off the assistant line too: what the CLI says answered, not what was asked for.
      reportedModel: 'claude-opus-4-8',
      sessionId: '9f2a4c6e-3b1d-4a7f-8c25-0d6e5b1a9f30',
    })

    // The catch-up block goes in on stdin, never on the command line.
    expect(stdin).toContain('User: What should we build first?')
    expect(stdin).toContain(HOUSE_STYLE_HEADING)
    expect(stdin.indexOf(HOUSE_STYLE_HEADING)).toBeLessThan(stdin.lastIndexOf('User: What should we build first?'))
    expect(stdin).toContain(`${REPLY_LANGUAGE_LINE}\n\nUser: What should we build first?`)
  })

  it('keeps image paths on stdin before house style and the question', async () => {
    const { stdin } = await run({
      agent: sage,
      stdoutLines: fixture('claude-success.jsonl'),
      input: { imagePaths: ['/scratch/attachments/evt_9-0.webp'] },
    })

    expect(stdin.indexOf('/scratch/attachments/evt_9-0.webp')).toBeLessThan(stdin.indexOf(HOUSE_STYLE_HEADING))
    expect(stdin.indexOf(HOUSE_STYLE_HEADING)).toBeLessThan(stdin.lastIndexOf('User: What should we build first?'))
    expect(stdin.trimEnd().endsWith('User: What should we build first?')).toBe(true)
  })

  it('keeps image paths before house style when the question quotes the heading', async () => {
    const quoted = `Look at ${HOUSE_STYLE_HEADING} please`
    const { stdin } = await run({
      agent: sage,
      stdoutLines: fixture('claude-success.jsonl'),
      input: {
        catchUp: [
          { id: 'evt_000001', ts: 1, type: 'user_message', text: quoted, mentions: [sage.id] },
        ],
        isFullCatchUp: false,
        imagePaths: ['/scratch/attachments/evt_9-0.webp'],
      },
    })

    expect(stdin.indexOf('/scratch/attachments/evt_9-0.webp')).toBeLessThan(stdin.indexOf(HOUSE_STYLE_HEADING))
    expect(stdin.trimEnd().endsWith(`User: ${quoted}`)).toBe(true)
  })

  /**
   * The point of the field: it must be what answered, not what was asked for. A
   * persona cannot be asked this (Manor replaces her whole system prompt, so she
   * guesses), and the configured value is the wrong answer whenever the CLI served
   * something else — a pin the provider aliased, or a fall back under load.
   */
  it('reports the model the stream names, not the one the persona was configured with', async () => {
    const pinned = { ...sage, model: 'claude-opus-5' as const }
    const { events } = await run({
      agent: pinned,
      stdoutLines: [
        '{"type":"system","subtype":"init","session_id":"s-1"}',
        '{"type":"assistant","message":{"id":"m1","model":"claude-sonnet-5","content":[{"type":"text","text":"first"}]}}',
        // A second request in the same turn, served by something else: the row sits
        // under the last answer, so the last model is the one it must name.
        '{"type":"assistant","message":{"id":"m2","model":"claude-opus-5","content":[{"type":"text","text":" and second"}]}}',
        '{"type":"result","subtype":"success","result":"first and second","session_id":"s-1"}',
      ],
    })

    expect(events.at(-1)).toMatchObject({ type: 'result', reportedModel: 'claude-opus-5' })
  })

  /**
   * The numbers are the live shape recorded from the CLI on 2026-08-13, where the
   * same turn read 38_046 tokens and cost the equivalent of 41_690 fresh ones. The
   * gauge number and the spend number diverge here, which is the whole point.
   */
  it('splits the prompt by what it cost when the CLI reports the cache durations', async () => {
    const usage =
      '{"input_tokens":10,"cache_creation_input_tokens":19935,"cache_read_input_tokens":18101,"output_tokens":64,' +
      '"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":19935}}'
    const { events } = await run({
      agent: sage,
      stdoutLines: [
        '{"type":"system","subtype":"init","session_id":"s-3"}',
        '{"type":"assistant","message":{"id":"m1","model":"claude-haiku-4-5","content":[{"type":"text","text":"ok"}]}}',
        `{"type":"result","subtype":"success","result":"ok","session_id":"s-3","total_cost_usd":0.0420101,"usage":${usage}}`,
      ],
    })

    expect(events.at(-1)).toMatchObject({
      type: 'result',
      usage: {
        // Unchanged: still every token the model read, cached or not.
        inputTokens: 38_046,
        outputTokens: 64,
        breakdown: {
          freshInputTokens: 10,
          cacheWrite5mTokens: 0,
          cacheWrite1hTokens: 19_935,
          cacheReadTokens: 18_101,
          // 10 + 2 * 19_935 + 0.1 * 18_101
          apiPricedInputEquivalent: 41_690,
        },
      },
    })
  })

  /**
   * A write's price depends on its duration and the flat `cache_creation_input_tokens`
   * does not carry one, so there is nothing honest to derive. Same call the context
   * gauge makes: report nothing rather than a number the user would act on.
   */
  it('reports no breakdown at all when the cache durations are missing', async () => {
    const { events } = await run({ agent: sage, stdoutLines: fixture('claude-success.jsonl') })
    const result = events.at(-1) as { usage?: { breakdown?: unknown; inputTokens: number } }

    expect(result.usage?.inputTokens).toBe(2152)
    expect(result.usage?.breakdown).toBeUndefined()
  })

  it('reports no breakdown when the duration split does not equal the flat cache write total', async () => {
    const usage =
      '{"input_tokens":10,"cache_creation_input_tokens":100,"cache_read_input_tokens":20,"output_tokens":5,' +
      '"cache_creation":{"ephemeral_5m_input_tokens":40,"ephemeral_1h_input_tokens":50}}'
    const { events } = await run({
      agent: sage,
      stdoutLines: [
        '{"type":"system","subtype":"init","session_id":"s-mismatch"}',
        '{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"ok"}]}}',
        `{"type":"result","subtype":"success","result":"ok","session_id":"s-mismatch","usage":${usage}}`,
      ],
    })

    expect(events.at(-1)).toMatchObject({ type: 'result', usage: { inputTokens: 130 } })
    expect((events.at(-1) as { usage?: { breakdown?: unknown } }).usage?.breakdown).toBeUndefined()
  })

  it('reads the briefly persisted weighted field as the honestly named API proxy', () => {
    const usage = UsageSchema.parse({
      inputTokens: 130,
      outputTokens: 5,
      breakdown: {
        freshInputTokens: 10,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 50,
        cacheReadTokens: 20,
        weightedInputTokens: 112,
      },
    })

    expect(usage.breakdown?.apiPricedInputEquivalent).toBe(112)
    expect(usage.breakdown).not.toHaveProperty('weightedInputTokens')
  })

  it('leaves the model out when the stream never names one', async () => {
    const { events } = await run({
      agent: sage,
      stdoutLines: [
        '{"type":"system","subtype":"init","session_id":"s-2"}',
        '{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"bare"}]}}',
        '{"type":"result","subtype":"success","result":"bare","session_id":"s-2"}',
      ],
    })

    const result = events.at(-1)
    expect(result).toMatchObject({ type: 'result' })
    expect(result && 'reportedModel' in result).toBe(false)
  })

  it('emits images created in the scratch directory as attachments', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'manor-claude-image-'))
    const bytes = Buffer.from('generated diagram')
    const { events } = await run({
      agent: sage,
      input: { cwd },
      stdoutLines: fixture('claude-success.jsonl'),
      beforeClose: async (turnCwd) => writeFile(path.join(turnCwd, 'diagram.webp'), bytes),
    })

    expect(events.at(-1)).toEqual({
      type: 'attachment',
      image: {
        name: 'diagram.webp',
        dataUrl: `data:image/webp;base64,${bytes.toString('base64')}`,
      },
    })
  })

  it('tells the persona about the folders on stdin and still runs in the scratch dir', async () => {
    const { stdin, cwd } = await run({
      agent: sage,
      input: { repoPaths: ['/repos/manor', '/home/sam/notes'] },
      stdoutLines: fixture('claude-success.jsonl'),
    })

    expect(stdin).toContain('[Manor] Project folders:\n- /repos/manor\n- /home/sam/notes')
    expect(stdin).toContain('full read and write access')
    expect(cwd).toBe('/tmp/manor-scratch/main')
  })

  it('reports tool use with a short detail as it happens', async () => {
    const { events } = await run({ agent: smith, stdoutLines: fixture('claude-tool-use.jsonl') })

    expect(events.filter((event) => event.type === 'tool_use')).toEqual([
      {
        type: 'tool_use',
        toolCallId: 'toolu_01XYZ',
        tool: 'Read',
        detail: '/tmp/manor/scratch/main/notes.md',
        targets: ['/tmp/manor/scratch/main/notes.md'],
      },
    ])
    expect(events.filter((event) => event.type === 'tool_result')).toEqual([
      { type: 'tool_result', toolCallId: 'toolu_01XYZ', outcome: 'success' },
    ])
    expect(events.filter((event) => event.type === 'message')).toEqual([
      { type: 'message', messageId: 'message_1', text: 'Let me look. ' },
      { type: 'message', messageId: 'message_2', text: 'The scratch dir is empty.' },
    ])
    expect(events.at(-1)).toMatchObject({ type: 'result', text: 'Let me look. The scratch dir is empty.' })
  })

  /**
   * The two numbers a tool-using turn produces, and the reason they are separate
   * fields. The CLI's `result` line sums its usage over every request it made to
   * serve the turn (measured against claude 2.1.226: the sums match request for
   * request), so it grows with tool calls while the context window does not. Here
   * two requests of 900 and 1800 report 2700 of spend against a context of 1800.
   */
  it('separates turn spend from context size on a multi-request turn', async () => {
    const { events } = await run({ agent: smith, stdoutLines: fixture('claude-tool-use.jsonl') })

    expect(events.at(-1)).toMatchObject({
      type: 'result',
      usage: { inputTokens: 2700, outputTokens: 112 },
      contextTokens: 1800,
      // Manor passes the threshold on the argv, so the driver can report it exactly.
      autoCompactTokens: 300_000,
    })
  })

  it('omits contextTokens when no assistant line carried usage', async () => {
    const { events } = await run({
      agent: sage,
      stdoutLines: [
        '{"type":"system","subtype":"init","session_id":"s1"}',
        '{"type":"result","subtype":"success","is_error":false,"result":"done","session_id":"s1","usage":{"input_tokens":10,"output_tokens":4}}',
      ],
    })

    expect(events.at(-1)).not.toHaveProperty('contextTokens')
    expect(events.at(-1)).not.toHaveProperty('contextWindow')
  })

  it('marks a failed tool result without failing the whole turn', async () => {
    const { events } = await run({
      agent: smith,
      stdoutLines: [
        '{"type":"system","subtype":"init","session_id":"session-1"}',
        '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tool-1","name":"Read","input":{"file_path":"missing.md"}}]}}',
        '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tool-1","is_error":true,"content":"not found"}]}}',
        '{"type":"result","subtype":"success","is_error":false,"result":"I could not read it.","session_id":"session-1","usage":{"input_tokens":10,"output_tokens":4}}',
      ],
    })

    expect(events.filter((event) => event.type === 'tool_result')).toEqual([
      { type: 'tool_result', toolCallId: 'tool-1', outcome: 'error', error: 'not found' },
    ])
    expect(events.at(-1)).toMatchObject({ type: 'result', text: 'I could not read it.' })
  })

  it('turns a failed result line into an error event', async () => {
    const { events } = await run({ agent: sage, stdoutLines: fixture('claude-error-result.jsonl') })

    expect(events).toEqual([{ type: 'error', message: 'API Error: 529 overloaded_error' }])
  })

  it('settles a result when the CLI leaves its process open', async () => {
    // The result grace runs on fake time and moves only once the driver read the result line.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const child = new FakeChild()
      const driver = createClaudeDriver({
        agents: () => [sage], spawnFn: () => child, timeoutMs: 5_000, resultGraceMs: 20,
      })
      const handle = driver.startTurn(turnInput(sage))
      let settled = false
      const done = drain(handle.events).then((events) => { settled = true; return events })
      child.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', result: 'Done.', session_id: 'session-1' })}\n`)
      const deadline = Date.now() + 5_000
      while ((child.stdout.listenerCount('data') + child.stdout.listenerCount('readable') === 0 || child.stdout.readableLength > 0) && Date.now() < deadline) {
        await new Promise((resolve) => setImmediate(resolve))
      }
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(20)
      // Settling reads the workspace for generated images, which is real I/O.
      while (!settled && Date.now() < deadline) await new Promise((resolve) => setImmediate(resolve))
      expect(settled).toBe(true)
      expect(child.killed).toBe(true)
      handle.stop()
      await done
    } finally {
      vi.useRealTimers()
    }
  })

  it('turns a nonzero exit without a result into an error event', async () => {
    const { events } = await run({ agent: sage, stderr: 'command not permitted here\n', exitCode: 2 })

    expect(events).toEqual([{ type: 'error', message: 'command not permitted here' }])
    expect(isResumeFailure((events[0] as { message: string }).message)).toBe(false)
  })

  it('flags a resume that never opened its session as a distinct resume failure', async () => {
    const { events } = await run({
      agent: sage,
      input: { sessionId: 'dead-session' },
      stderr: 'No conversation found with session ID: dead-session\n',
      exitCode: 1,
    })

    expect(events).toHaveLength(1)
    const [error] = events
    expect(error?.type).toBe('error')
    const message = (error as { message: string }).message
    expect(isResumeFailure(message)).toBe(true)
    expect(message).toBe(`${RESUME_FAILURE_PREFIX}No conversation found with session ID: dead-session`)
  })

  it('flags a failed result line before init as a resume failure', async () => {
    // Claude Code 2.1.325 answers `--resume` of a deleted transcript this way, then exits 1.
    const missing = 'No conversation found with session ID: dead-session'
    const { events } = await run({
      agent: sage,
      input: { sessionId: 'dead-session' },
      stdoutLines: [JSON.stringify({
        type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 0,
        session_id: 'dead-session', total_cost_usd: 0, errors: [missing],
      })],
      stderr: `${missing}\n`,
      exitCode: 1,
    })
    expect(events).toEqual([{
      type: 'error',
      message: `${RESUME_FAILURE_PREFIX}the CLI reported a failed turn (error_during_execution): ${missing}`,
    }])
  })

  it('keeps an unrelated failed result line before init as an ordinary turn failure', async () => {
    const { events } = await run({
      agent: sage,
      input: { sessionId: 'live-session' },
      stdoutLines: [JSON.stringify({
        type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['invalid model'],
      })],
      exitCode: 1,
    })
    expect(events).toEqual([{ type: 'error', message: 'the CLI reported a failed turn (error_during_execution): invalid model' }])
  })

  it('keeps a failed result line after init as an ordinary turn failure', async () => {
    const { events } = await run({
      agent: sage,
      input: { sessionId: 'live-session' },
      stdoutLines: [
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 'live-session' }),
        JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 'live-session' }),
      ],
      exitCode: 1,
    })
    expect(events.at(-1)).toEqual({ type: 'error', message: 'the CLI reported a failed turn (error_during_execution)' })
  })

  it('keeps a post-init session error as an ordinary turn failure', async () => {
    const { events } = await run({
      agent: sage, input: { sessionId: 'live-session' },
      stdoutLines: [JSON.stringify({ type: 'system', subtype: 'init', session_id: 'live-session' })],
      stderr: 'session tool failed', exitCode: 1,
    })
    expect(events.at(-1)).toEqual({ type: 'error', message: 'session tool failed' })
  })

  it('does not blame the session when there was no session to resume', async () => {
    const { events } = await run({ agent: sage, stderr: 'some other failure', exitCode: 1 })
    expect(isResumeFailure((events[0] as { message: string }).message)).toBe(false)
  })

  it('kills a turn that goes quiet, and names the silence', async () => {
    const child = new FakeChild()
    const driver = createClaudeDriver({
      agents: () => [sage],
      spawnFn: () => child,
      idleTimeoutMs: 20,
      timeoutMs: 10_000,
    })
    const handle = driver.startTurn(turnInput(sage))

    expect(await drain(handle.events)).toEqual([
      { type: 'error', message: 'the turn went quiet: no activity for 0s' },
    ])
    expect(child.killed).toBe(true)
  })

  it('does not kill a turn that is waiting on an open tool', async () => {
    const child = new FakeChild()
    const driver = createClaudeDriver({
      agents: () => [sage],
      spawnFn: () => child,
      idleTimeoutMs: 200,
      timeoutMs: 10_000,
    })
    const handle = driver.startTurn(turnInput(sage))
    const seen: RuntimeEvent[] = []
    const collected = (async () => {
      for await (const event of handle.events) seen.push(event)
      return seen
    })()

    child.stdout.write(
      `${JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg_1',
          model: 'claude-opus-5',
          content: [{ type: 'tool_use', id: 'tool_1', name: 'mcp__jira__search', input: { jql: 'x' } }],
        },
      })}\n`,
    )
    await new Promise<void>((resolve, reject) => {
      const started = Date.now()
      const tick = () => {
        if (seen.some((event) => event.type === 'tool_use')) {
          resolve()
          return
        }
        if (Date.now() - started > 1_000) {
          reject(new Error('tool_use never arrived'))
          return
        }
        setTimeout(tick, 10)
      }
      tick()
    })
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(child.killed).toBe(false)

    // Result in the same chunk as the tool close, so the fresh idle window
    // after resume cannot fire between the two lines under suite load.
    child.stdout.write(
      `${JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: 'ok' }] },
      })}\n{"type":"result","subtype":"success","result":"done","session_id":"s1"}\n`,
    )
    child.stdout.end()
    await once(child.stdout, 'end')
    child.emit('close', 0)

    const events = await collected
    expect(events.some((event) => event.type === 'error' && event.message.includes('went quiet'))).toBe(false)
    expect(events.at(-1)).toMatchObject({ type: 'result', text: 'done' })
  })

  it('lets a turn that keeps streaming outlive the idle window', async () => {
    const child = new FakeChild()
    const driver = createClaudeDriver({
      agents: () => [sage],
      spawnFn: () => child,
      // Generous next to the 60ms beat below on purpose: each beat must land well
      // inside the window even under full-suite load, and a tight margin only buys
      // a flaky test.
      idleTimeoutMs: 200,
      timeoutMs: 10_000,
    })
    const handle = driver.startTurn(turnInput(sage))
    const collected = drain(handle.events)

    // Beats that together outlast the idle window, each one resetting the clock.
    // The single wall-clock cap this replaced would have killed a turn like this
    // one mid-answer, and so would an idle clock that stops being reset.
    for (let beat = 0; beat < 4; beat += 1) {
      await new Promise((resolve) => setTimeout(resolve, 60))
      child.stdout.write(
        `{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"tick "}}}\n`,
      )
    }
    child.stdout.write('{"type":"result","subtype":"success","result":"done","session_id":"s1"}\n')
    child.stdout.end()
    await once(child.stdout, 'end')
    child.emit('close', 0)

    const events = await collected
    expect(events.filter((event) => event.type === 'error')).toEqual([])
    expect(events.at(-1)).toMatchObject({ type: 'result', text: 'done' })
    expect(child.killed).toBe(false)
  })

  it('counts output the parser models nothing for as proof of life', async () => {
    const child = new FakeChild()
    const driver = createClaudeDriver({
      agents: () => [sage],
      spawnFn: () => child,
      // Generous next to the 60ms beat below on purpose: the point is that four
      // beats outlast the window, and a tight margin only buys a flaky test.
      idleTimeoutMs: 200,
      timeoutMs: 10_000,
    })
    const handle = driver.startTurn(turnInput(sage))
    const collected = drain(handle.events)

    // Past the idle window, in line types the parser returns nothing for. The CLI
    // is demonstrably alive; resetting the clock on parsed events alone killed it.
    for (let beat = 0; beat < 4; beat += 1) {
      await new Promise((resolve) => setTimeout(resolve, 60))
      child.stdout.write('{"type":"stream_event","event":{"type":"ping"}}\n')
      child.stdout.write('not json at all\n')
    }
    child.stdout.write('{"type":"result","subtype":"success","result":"done","session_id":"s1"}\n')
    child.stdout.end()
    await once(child.stdout, 'end')
    child.emit('close', 0)

    const events = await collected
    expect(events.filter((event) => event.type === 'error')).toEqual([])
    expect(events.at(-1)).toMatchObject({ type: 'result', text: 'done' })
    expect(child.killed).toBe(false)
  })

  it('sends /compact on the live session without composing catch-up', async () => {
    const child = new FakeChild()
    let stdin = ''
    let args: string[] = []
    child.stdin.on('data', (chunk: Buffer) => {
      stdin += chunk.toString('utf8')
    })
    const driver = createClaudeDriver({
      agents: () => [sage],
      spawnFn: (_command, spawnArgs) => {
        args = [...spawnArgs]
        return child
      },
      timeoutMs: 5_000,
    })
    const handle = driver.compactSession!({
      agent: sage,
      sessionId: 'abc-123',
      threadId: 'main',
      cwd: '/tmp/manor-scratch/main',
      repoPaths: [],
    })
    const collected = drain(handle.events)
    child.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', result: '', session_id: 'abc-123' })}\n`)
    child.stdout.end()
    child.stderr.end()
    child.emit('close', 0)
    expect(await collected).toMatchObject([{ type: 'result', sessionId: 'abc-123' }])
    expect(stdinText(stdin)).toBe('/compact')
    expect(args).toContain('--resume')
    expect(args).toContain('abc-123')
  })

  it('kills the process and ends the stream on stop()', async () => {
    const child = Object.assign(new FakeChild(), { pid: 99990 })
    const driver = createClaudeDriver({ agents: () => [sage], spawnFn: () => child, timeoutMs: 5_000 })
    const handle = driver.startTurn(turnInput(sage))
    const collected = drain(handle.events)

    handle.stop()

    expect(child.killed).toBe(false)
    expect(await collected).toEqual([])
    expect(child.killed).toBe(true)
  })

  it('pauses stdout while its events wait unread and resumes once they drain, dropping none', async () => {
    const child = new FakeChild()
    const driver = createClaudeDriver({ agents: () => [sage], spawnFn: () => child, timeoutMs: 10_000 })
    const handle = driver.startTurn(turnInput(sage))
    const delta = '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"x"}}}\n'
    const burst = QUEUE_HIGH_WATER + 10

    // One chunk past the high-water mark while nobody is reading yet.
    child.stdout.write(delta.repeat(burst))
    await new Promise((resolve) => setImmediate(resolve))
    expect(child.stdout.isPaused()).toBe(true)

    const events: RuntimeEvent[] = []
    const iterator = handle.events[Symbol.asyncIterator]()
    while (events.length < burst - QUEUE_LOW_WATER) {
      const next = await iterator.next()
      if (next.done) break
      events.push(next.value)
    }
    expect(child.stdout.isPaused()).toBe(false)

    child.stdout.write('{"type":"result","subtype":"success","result":"done","session_id":"s1"}\n')
    child.stdout.end()
    await once(child.stdout, 'end')
    child.emit('close', 0)
    for (;;) {
      const next = await iterator.next()
      if (next.done) break
      events.push(next.value)
    }
    expect(events.filter((event) => event.type === 'delta')).toHaveLength(burst)
    expect(events.at(-1)).toMatchObject({ type: 'result', text: 'done' })
  })
})

describe('reasoning and edits', () => {
  it('emits a thinking block as reasoning, before the tool call it preceded', async () => {
    const { events } = await run({ agent: sage, stdoutLines: fixture('claude-thinking-edit.jsonl') })

    const reasoning = events.filter((event) => event.type === 'reasoning')
    expect(reasoning).toEqual([
      {
        type: 'reasoning',
        text: 'The open questions list is missing the pilot date.\nI should add it rather than rewrite the file.',
      },
    ])

    // Provider order is the whole point: reasoning that arrived before a tool call
    // must not be reordered behind it, or the trace stops explaining anything.
    const reasoningAt = events.findIndex((event) => event.type === 'reasoning')
    const toolAt = events.findIndex((event) => event.type === 'tool_use')
    expect(reasoningAt).toBeGreaterThanOrEqual(0)
    expect(reasoningAt).toBeLessThan(toolAt)
  })

  it('emits thinking before the words of the same assistant line', async () => {
    const { events } = await run({
      agent: sage,
      stdoutLines: [
        '{"type":"system","subtype":"init","session_id":"s1"}',
        JSON.stringify({
          type: 'assistant',
          message: {
            id: 'msg_think',
            model: 'claude-opus-4-8',
            content: [
              { type: 'thinking', thinking: 'Let me look at ChatListView.' },
              { type: 'text', text: 'The real answer.' },
            ],
          },
        }),
        '{"type":"result","subtype":"success","is_error":false,"result":"The real answer.","session_id":"s1"}',
      ],
    })

    const types = events.map((event) => event.type)
    expect(types.indexOf('reasoning')).toBeLessThan(types.indexOf('message'))
    expect(events.filter((event) => event.type === 'message')).toEqual([
      { type: 'message', messageId: 'msg_think', text: 'The real answer.' },
    ])
  })

  it('carries the two sides of an Edit so the UI can render a diff', async () => {
    const { events } = await run({ agent: sage, stdoutLines: fixture('claude-thinking-edit.jsonl') })

    const tool = events.find((event) => event.type === 'tool_use')
    expect(tool).toMatchObject({
      tool: 'Edit',
      toolCallId: 'toolu_01EDIT',
      edits: [
        {
          path: '/tmp/manor/scratch/main/notes.md',
          before: '- who owns the intake form\n',
          after: '- who owns the intake form\n- when does the pilot start\n',
        },
      ],
    })
  })

  it('leaves a read-only call without edits, so no diff is offered for it', async () => {
    const { events } = await run({ agent: sage, stdoutLines: fixture('claude-tool-use.jsonl') })

    const tool = events.find((event) => event.type === 'tool_use')
    expect(tool).toMatchObject({ tool: 'Read' })
    expect(tool).not.toHaveProperty('edits')
  })

  it('describes a Bash read as Read with targets, not a hidden shell step', () => {
    const parser = new StreamParser()
    const events = parser.handle(JSON.stringify({
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: 'toolu_bash',
          name: 'Bash',
          input: { command: "sed -n '1,40p' apps/web/src/state.ts" },
        }],
      },
    }))
    expect(events).toEqual([{
      type: 'tool_use',
      toolCallId: 'toolu_bash',
      tool: 'Read',
      detail: 'apps/web/src/state.ts',
      targets: ['apps/web/src/state.ts'],
      command: "sed -n '1,40p' apps/web/src/state.ts",
    }])
  })

  it('describes a Bash grep as Search', () => {
    const parser = new StreamParser()
    const events = parser.handle(JSON.stringify({
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: 'toolu_grep',
          name: 'Bash',
          input: { command: 'grep -n "stageComposer" apps/web/src/App.tsx' },
        }],
      },
    }))
    expect(events.filter((event) => event.type === 'tool_use')).toEqual([{
      type: 'tool_use',
      toolCallId: 'toolu_grep',
      tool: 'Search',
      subject: '“stageComposer” in apps/web/src/App.tsx',
      detail: 'apps/web/src/App.tsx',
      targets: ['apps/web/src/App.tsx'],
      command: 'grep -n "stageComposer" apps/web/src/App.tsx',
    }])
  })

  it('describes a python heredoc write as Edit with both sides', () => {
    const command = [
      "python3 - <<'PYEOF'",
      "p = 'apps/web/src/motion.ts'",
      's = open(p).read()',
      'old = """one"""',
      'new = """two"""',
      "open(p, 'w').write(s.replace(old, new, 1))",
      'PYEOF',
    ].join('\n')
    const parser = new StreamParser()
    const events = parser.handle(JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'toolu_py', name: 'Bash', input: { command } }],
      },
    }))
    expect(events.filter((event) => event.type === 'tool_use')).toEqual([{
      type: 'tool_use',
      toolCallId: 'toolu_py',
      tool: 'Edit',
      detail: 'apps/web/src/motion.ts',
      targets: ['apps/web/src/motion.ts'],
      command,
      edits: [{ path: 'apps/web/src/motion.ts', before: 'one', after: 'two' }],
    }])
  })

  it("reads Grok's run_terminal_command as a shell call, so its command is recorded", () => {
    const parser = new StreamParser()
    const events = parser.handle(JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'grok_1', name: 'run_terminal_command', input: { command: 'pnpm test' } }] },
    }))
    expect(events.filter((event) => event.type === 'tool_use')).toEqual([{
      type: 'tool_use', toolCallId: 'grok_1', tool: 'Shell', detail: 'pnpm test', command: 'pnpm test',
    }])
  })

  it('keeps nested helper output out of an in-progress parent message', () => {
    const parser = new StreamParser()
    const handle = (value: unknown) => parser.handle(JSON.stringify(value))
    handle({ type: 'system', subtype: 'init', session_id: 'parent' })
    handle({ type: 'stream_event', event: { type: 'message_start', message: { id: 'parent-message' } } })
    handle({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Parent answer' } } })
    for (const child of [
      { type: 'system', subtype: 'init', session_id: 'child' },
      { type: 'stream_event', event: { type: 'message_start', message: { id: 'child-message' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Child answer' } } },
      { type: 'assistant', message: { id: 'child-message', model: 'child-model', content: [{ type: 'text', text: 'Child answer' }] } },
      { type: 'result', subtype: 'success', session_id: 'child', result: 'Child answer' },
    ]) expect(handle({ ...child, parent_tool_use_id: 'helper-tool' })).toEqual([])
    expect(parser.sessionId).toBe('parent')
    expect(handle({ type: 'assistant', parent_tool_use_id: null, message: { id: 'parent-message', model: 'parent-model', content: [{ type: 'text', text: 'Parent answer' }] } }))
      .toEqual([{ type: 'message', messageId: 'parent-message', text: 'Parent answer' }])
    expect(handle({ type: 'result', subtype: 'success', result: 'Parent answer' }))
      .toEqual([{ type: 'result', sessionId: 'parent', reportedModel: 'parent-model', text: 'Parent answer' }])
  })

  it('attributes helper tools and reasoning to their Agent call without publishing the child reply', () => {
    const parser = new StreamParser()
    const handle = (value: unknown) => parser.handle(JSON.stringify(value))
    expect(handle({ type: 'assistant', message: { content: [{
      type: 'tool_use', id: 'helper-tool', name: 'Agent',
      input: { description: 'Inspect the parser', subagent_type: 'Explore' },
    }] } })).toContainEqual(expect.objectContaining({
      type: 'tool_use', toolCallId: 'helper-tool', tool: 'Agent', agentType: 'Explore',
    }))
    expect(handle({ type: 'assistant', parent_tool_use_id: 'helper-tool', message: { content: [
      { type: 'thinking', thinking: 'Check the event shape.' },
      { type: 'text', text: 'Child answer' },
      { type: 'tool_use', id: 'child-read', name: 'Read', input: { file_path: 'parser.ts' } },
    ] } })).toEqual([
      { type: 'reasoning', text: 'Check the event shape.', parentToolCallId: 'helper-tool' },
      expect.objectContaining({
        type: 'tool_use', toolCallId: 'child-read', parentToolCallId: 'helper-tool', tool: 'Read',
      }),
    ])
    expect(handle({ type: 'user', parent_tool_use_id: 'helper-tool', message: { content: [
      { type: 'tool_result', tool_use_id: 'child-read', content: 'done' },
    ] } })).toEqual([{
      type: 'tool_result', toolCallId: 'child-read', parentToolCallId: 'helper-tool', outcome: 'success',
    }])
    expect(handle({ type: 'user', message: { content: [{
      type: 'tool_result', tool_use_id: 'helper-tool',
      content: [{ type: 'text', text: 'The parser is fine.' }, { type: 'text', text: 'agentId: a1b2 (for resuming)' }],
    }] } })).toEqual([{ type: 'tool_result', toolCallId: 'helper-tool', outcome: 'success', output: 'The parser is fine.' }])
    expect(parser.sessionId).toBeUndefined()
  })

  it('leaves a native Read call on the existing path', () => {
    const parser = new StreamParser()
    const events = parser.handle(JSON.stringify({
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: 'toolu_read',
          name: 'Read',
          input: { file_path: '/tmp/notes.md' },
        }],
      },
    }))
    expect(events).toEqual([{
      type: 'tool_use',
      toolCallId: 'toolu_read',
      tool: 'Read',
      detail: '/tmp/notes.md',
      targets: ['/tmp/notes.md'],
    }])
  })

  it('publishes TodoWrite as a replacement list instead of a generic tool row', async () => {
    const { events } = await run({
      agent: sage,
      stdoutLines: [
        '{"type":"system","subtype":"init","session_id":"s1"}',
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [{
              type: 'tool_use',
              id: 'todo-1',
              name: 'TodoWrite',
              input: {
                todos: [
                  { content: 'Trace the event', status: 'in_progress' },
                  { content: 'Add the card', status: 'pending' },
                  // Grok's todo_write drops a revised-away step by cancelling it.
                  { content: 'Old step', status: 'cancelled' },
                ],
              },
            }],
          },
        }),
        '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"todo-1","content":"ok"}]}}',
        '{"type":"result","subtype":"success","is_error":false,"result":"Done.","session_id":"s1"}',
      ],
    })

    expect(events.filter((event) => event.type === 'todo_update')).toEqual([{
      type: 'todo_update',
      todos: [
        { text: 'Trace the event', status: 'in_progress' },
        { text: 'Add the card', status: 'pending' },
      ],
    }])
    expect(events.some((event) => event.type === 'tool_use' || event.type === 'tool_result')).toBe(false)
  })

  it('hides Manor-owned interaction cards and leaves third-party tools visible', async () => {
    expect(isAskUserTool('mcp__manor__ask_user')).toBe(true)
    expect(isAskUserTool('manor__ask_user')).toBe(true)
    expect(isAskUserTool('ask_user')).toBe(true)
    expect(isAskUserTool('mcp__research__ask_user')).toBe(false)

    const { events } = await run({
      agent: sage,
      stdoutLines: [
        '{"type":"system","subtype":"init","session_id":"s1"}',
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'ask-1',
                name: 'mcp__manor__ask_user',
                input: { questions: [{ id: 'direction', question: 'Which way?', options: [{ label: 'A' }, { label: 'B' }] }] },
              },
              {
                type: 'tool_use',
                id: 'ask-2',
                name: 'mcp__research__ask_user',
                input: {},
              },
              { type: 'tool_use', id: 'codex-1', name: 'mcp__manor__codex_subagent', input: { task: 'Inspect parsing' } },
            ],
          },
        }),
        JSON.stringify({
          type: 'user',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 'ask-1', content: 'ok' },
              { type: 'tool_result', tool_use_id: 'ask-2', content: 'ok' },
              { type: 'tool_result', tool_use_id: 'codex-1', content: 'ok' },
            ],
          },
        }),
        '{"type":"result","subtype":"success","is_error":false,"result":"Done.","session_id":"s1"}',
      ],
    })

    expect(events.filter((event) => event.type === 'tool_use')).toEqual([
      { type: 'tool_use', tool: 'mcp__research__ask_user', toolCallId: 'ask-2' },
    ])
    expect(events.filter((event) => event.type === 'tool_result')).toEqual([
      { type: 'tool_result', toolCallId: 'ask-2', outcome: 'success' },
    ])
  })
})

// Line shapes from the installed CLI's own stream-json schema (2.1.302): `system`/`status`
// with `compacting`, then `compact_boundary` whose `compact_metadata` may name `post_tokens`.
describe('live context', () => {
  const assistant = (id: string, input: number, cached: number, content: unknown[], parent: string | null = null) => JSON.stringify({
    type: 'assistant', parent_tool_use_id: parent,
    message: { id, model: 'claude-opus-5', content, usage: { input_tokens: input, cache_creation_input_tokens: 0, cache_read_input_tokens: cached, output_tokens: 12 } },
  })
  const status = (value: string | null, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ type: 'system', subtype: 'status', status: value, session_id: 's', ...extra })
  const live = (events: RuntimeEvent[]) => events.filter((event) => event.type === 'context' || event.type === 'compaction')

  it('reports each request’s prompt size once, and only the main thread’s', () => {
    const parser = new StreamParser(true, true, undefined, 300_000)
    // One request, two content-block lines with the same usage: one reading.
    expect(live(parser.handle(assistant('msg_1', 4, 120_000, [{ type: 'text', text: 'Reading.' }])))).toEqual([{ type: 'context', contextTokens: 120_004, autoCompactTokens: 300_000 }])
    expect(live(parser.handle(assistant('msg_1', 4, 120_000, [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'a.ts' } }])))).toEqual([])
    // A helper's request is its own window.
    expect(live(parser.handle(assistant('msg_child', 900, 0, [{ type: 'text', text: 'child' }], 'toolu_agent')))).toEqual([])
    expect(live(parser.handle(assistant('msg_2', 6, 131_000, [{ type: 'text', text: 'Next.' }])))).toEqual([{ type: 'context', contextTokens: 131_006, autoCompactTokens: 300_000 }])
  })

  it('names a failed turn from the subtype and first error when the result text is empty', () => {
    const fail = (extra: Record<string, unknown>) => new StreamParser(true, true).handle(
      JSON.stringify({ type: 'result', is_error: true, session_id: 's', ...extra }),
    ).find((event) => event.type === 'error')
    expect(fail({ subtype: 'error_during_execution', result: '', errors: ['model overloaded'] }))
      .toMatchObject({ message: 'the CLI reported a failed turn (error_during_execution): model overloaded' })
    expect(fail({ subtype: 'error_max_turns', errors: [{ message: 'too many turns' }] }))
      .toMatchObject({ message: 'the CLI reported a failed turn (error_max_turns): too many turns' })
    expect(fail({})).toMatchObject({ message: 'the CLI reported a failed turn' })
    expect(fail({ subtype: 'error_during_execution', result: 'provider said no', errors: ['x'] }))
      .toMatchObject({ message: 'provider said no' })
  })

  it('brackets the CLI’s own compaction and carries the compacted size into the result', () => {
    const parser = new StreamParser(true, true, undefined, 300_000)
    parser.handle(assistant('msg_1', 4, 290_000, [{ type: 'text', text: 'Big.' }]))
    expect(live(parser.handle(status('compacting')))).toEqual([{ type: 'compaction', phase: 'start' }])
    expect(live(parser.handle(status('requesting')))).toEqual([])
    expect(live(parser.handle(JSON.stringify({
      type: 'system', subtype: 'compact_boundary', session_id: 's',
      compact_metadata: { trigger: 'auto', pre_tokens: 290_004, post_tokens: 41_000 },
    })))).toEqual([{ type: 'compaction', phase: 'end', contextTokens: 41_000 }])
    expect(live(parser.handle(assistant('msg_2', 5, 44_000, [{ type: 'text', text: 'Small.' }])))).toEqual([{ type: 'context', contextTokens: 44_005, autoCompactTokens: 300_000 }])
    const result = parser.handle(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Small.', session_id: 's', usage: { input_tokens: 9, output_tokens: 24 } }))
    expect(result.find((event) => event.type === 'result')).toMatchObject({ contextTokens: 44_005 })
  })

  it('ends a failed compaction without dropping the size, and closes one the boundary never named', () => {
    const parser = new StreamParser(true, true, undefined, 300_000)
    parser.handle(status('compacting'))
    expect(live(parser.handle(status(null, { compact_result: 'failed', compact_error: 'too large' })))).toEqual([{ type: 'compaction', phase: 'failed' }])
    parser.handle(status('compacting'))
    // No boundary arrived, but the next request answered: the compaction is over.
    expect(live(parser.handle(assistant('msg_3', 3, 50_000, [{ type: 'text', text: 'On.' }])))).toEqual([
      { type: 'compaction', phase: 'end' },
      { type: 'context', contextTokens: 50_003, autoCompactTokens: 300_000 },
    ])
  })
})

describe('steering', () => {
  const line = (value: unknown) => `${JSON.stringify(value)}\n`
  const lifecycle = (uuid: string | undefined, state: string) => line({ type: 'command_lifecycle', command_uuid: uuid, state })
  const result = (text: string, usage: { input_tokens: number; output_tokens: number }, cost: number) =>
    line({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: 'session-1', usage, total_cost_usd: cost })
  const addition = (text: string, images?: { name: string; dataUrl: string }[]) =>
    ({ type: 'user_message' as const, id: `evt_${text}`, ts: 2, text, mentions: [], ...(images === undefined ? {} : { images }) })
  const tick = () => new Promise((resolve) => setImmediate(resolve))

  function start(
    options: { steeringTimeoutMs?: number; backgroundHoldMs?: number; idleTimeoutMs?: number; idleGate?: TurnIdleGate } = {},
    input: Partial<TurnInput> = {},
  ) {
    const child = new FakeChild()
    let raw = ''
    let inputEnded = false
    child.stdin.on('data', (chunk: Buffer) => { raw += chunk.toString('utf8') })
    child.stdin.on('finish', () => { inputEnded = true })
    const driver = createClaudeDriver({
      agents: () => [sage], spawnFn: () => child, timeoutMs: 5_000, resultGraceMs: 20, ...options,
    })
    const handle = driver.startTurn(turnInput(sage, input))
    const events = drain(handle.events)
    const sent = () => stdinMessages(raw)
    /** The CLI takes the prompt, which tells the driver it reports commands. */
    const boot = async () => {
      await tick()
      child.stdout.write(lifecycle(sent()[0]?.uuid, 'queued'))
      child.stdout.write(lifecycle(sent()[0]?.uuid, 'started'))
      await tick()
    }
    return { child, driver, handle, events, sent, boot, inputEnded: () => inputEnded }
  }

  it.each(['typed', 'forwarded'] as const)('delivers a %s addition into the running turn and folds a split run into one result', async (source) => {
    // The receipt clock runs on fake time, so a loaded machine cannot run it out before the queued line is read.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    onTestFinished(() => { vi.useRealTimers() })
    const { child, handle, events, sent, boot, inputEnded } = start({ steeringTimeoutMs: 20 })
    await boot()
    const delivery = handle.steer?.({ ...addition('Make it shorter', [
      { name: 'a.png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' },
      { name: 'b.svg', dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' },
    ]), ...(source === 'forwarded' ? { forwardedFrom: { threadChatId: 'thread-1', eventId: 'evt_source' } } : {}) })
    await tick()
    const steer = sent()[1]
    expect(steer).toMatchObject({ priority: 'next', message: { content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
      { type: 'text', text: expect.stringContaining('Make it shorter') },
    ] } })
    expect(steer?.message.content).toHaveLength(2)
    expect(JSON.stringify(steer?.message.content)).toContain(HOUSE_STYLE_HEADING)
    if (source === 'forwarded') {
      expect(JSON.stringify(steer?.message.content)).toContain('sent on from the project thread')
      expect(JSON.stringify(steer?.message.content)).toContain('review before Done')
    }
    let settled: string | undefined
    void delivery?.then((value) => { settled = value })
    // Queued is receipt only: it outlives the receipt clock without settling.
    child.stdout.write(lifecycle(steer?.uuid, 'queued'))
    while (child.stdout.readableLength > 0) await tick()
    await vi.advanceTimersByTimeAsync(50)
    expect(settled).toBeUndefined()

    // The first run ends before it reached a tool boundary: not the turn's end.
    child.stdout.write(line({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'Long answer.' }] } }))
    child.stdout.write(result('Long answer.', { input_tokens: 100, output_tokens: 10 }, 0.01))
    await tick()
    expect(inputEnded()).toBe(false)
    child.stdout.write(lifecycle(steer?.uuid, 'started'))
    expect(await delivery).toBe('accepted')
    child.stdout.write(line({ type: 'assistant', message: { id: 'msg_2', content: [{ type: 'text', text: 'Short.' }] } }))
    child.stdout.write(result('Short.', { input_tokens: 40, output_tokens: 5 }, 0.015))
    await tick()
    expect(inputEnded()).toBe(true)
    child.stdout.end()
    child.emit('close', 0)

    const seen = await events
    expect(seen.filter((event) => event.type === 'result')).toEqual([
      expect.objectContaining({ text: 'Short.', usage: { inputTokens: 140, outputTokens: 15, costUsd: 0.015 } }),
    ])
    expect(seen.filter((event) => event.type === 'message').map((event) => event.text)).toEqual(['Long answer.', 'Short.'])
  })

  it('leaves a split run unpriced when a resume after a restart could not price its first part', async () => {
    // No short receipt clock: the addition is confirmed by its started line, and a loaded machine must not beat it.
    const { child, handle, events, sent, boot } = start({}, { sessionId: 'restarted-session' })
    await boot()
    const delivery = handle.steer?.(addition('Make it shorter'))
    await tick()
    child.stdout.write(result('Long answer.', { input_tokens: 100, output_tokens: 10 }, 4))
    await tick()
    child.stdout.write(lifecycle(sent()[1]?.uuid, 'started'))
    await delivery
    child.stdout.write(result('Short.', { input_tokens: 40, output_tokens: 5 }, 4.5))
    await tick()
    child.stdout.end()
    child.emit('close', 0)
    const merged = (await events).filter((event) => event.type === 'result')
    expect(merged).toEqual([expect.objectContaining({ usage: { inputTokens: 140, outputTokens: 15 } })])
  })

  it.each(['silence', 'close'] as const)('reports uncertain delivery when the CLI never confirms it (%s)', async (ending) => {
    const { child, handle, events, boot } = start({ steeringTimeoutMs: 20 })
    await boot()
    const delivery = handle.steer?.(addition('Correction'))
    if (ending === 'close') {
      child.stdout.end()
      child.emit('close', 1)
    }
    expect(await delivery).toBe('uncertain')
    handle.stop()
    await events
  })

  it.each(['cancelled', 'exit'] as const)('never publishes the held answer when a queued addition is then %s', async (ending) => {
    const { child, handle, events, sent, boot } = start()
    await boot()
    const delivery = handle.steer?.(addition('Correction'))
    await tick()
    child.stdout.write(lifecycle(sent()[1]?.uuid, 'queued'))
    child.stdout.write(line({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'Original.' }] } }))
    child.stdout.write(result('Original.', { input_tokens: 10, output_tokens: 2 }, 0.01))
    if (ending === 'cancelled') child.stdout.write(lifecycle(sent()[1]?.uuid, 'cancelled'))
    else {
      child.stdout.end()
      child.emit('close', 0)
    }
    expect(await delivery).toBe('uncertain')
    handle.stop()
    const seen = await events
    expect(seen.filter((event) => event.type === 'result')).toEqual([])
  })

  it('does not end the turn on a background-task wake the resumed CLI replays first', async () => {
    const { child, events, inputEnded } = start()
    child.stdout.write(line({ type: 'result', subtype: 'success', is_error: false, result: '', session_id: 'session-1',
      origin: { kind: 'task-notification' }, total_cost_usd: 0, usage: { input_tokens: 3, output_tokens: 0 } }))
    await tick()
    expect(inputEnded()).toBe(false)
    child.stdout.write(line({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'It printed two.' }] } }))
    child.stdout.write(result('It printed two.', { input_tokens: 10, output_tokens: 4 }, 0.01))
    child.stdout.write(line({ type: 'result', subtype: 'success', is_error: false, result: 'Background task done.', session_id: 'session-1',
      origin: { kind: 'task-notification' } }))
    child.stdout.end()
    child.emit('close', 0)
    expect((await events).filter((event) => event.type === 'result')).toEqual([
      expect.objectContaining({ text: 'It printed two.', usage: { inputTokens: 13, outputTokens: 4, costUsd: 0.01 } }),
    ])
  })

  describe('background tasks', () => {
    const system = (subtype: string, fields: Record<string, unknown>) => line({ type: 'system', subtype, session_id: 'session-1', ...fields })
    const said = (id: string, text: string) => line({ type: 'assistant', message: { id, content: [{ type: 'text', text }] } })
    /** The prompt's run: one Bash in the background and one helper in the foreground, then the answer. */
    const launch = (child: FakeChild) => {
      child.stdout.write(system('task_started', { task_id: 'bash1', description: 'sleep 600', is_backgrounded: true, task_type: 'local_bash' }))
      child.stdout.write(system('task_started', { task_id: 'fg1', description: 'Reply beta', is_backgrounded: false, task_type: 'local_agent' }))
      child.stdout.write(system('task_notification', { task_id: 'fg1', status: 'completed' }))
      child.stdout.write(said('msg_1', 'Started it, I will report back.'))
      child.stdout.write(result('Started it, I will report back.', { input_tokens: 100, output_tokens: 10 }, 0.01))
    }
    // The idle and hold clocks run on fake time, so a loaded machine cannot fire them
    // between two lines a test writes. setImmediate stays real: it is how lines flow.
    beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }) })
    afterEach(() => { vi.useRealTimers() })
    /** Lets the driver read every line written so far, then moves fake time on by `ms`. */
    const elapse = async (child: FakeChild, ms: number) => {
      const reading = () => child.stdout.listenerCount('data') + child.stdout.listenerCount('readable') > 0
      const deadline = Date.now() + 5_000
      while ((!reading() || child.stdout.readableLength > 0) && Date.now() < deadline) await tick()
      await tick()
      await vi.advanceTimersByTimeAsync(ms)
    }
    /** Whether the turn ended once `ms` of fake time passed. */
    const settledWithin = async (child: FakeChild, events: Promise<RuntimeEvent[]>, ms: number) => {
      let settled = false
      void events.then(() => { settled = true })
      await elapse(child, ms)
      await tick()
      return settled
    }

    it('keeps the turn open past its answer and ends it with the wake run folded in', async () => {
      const { child, events, inputEnded } = start({ idleTimeoutMs: 20 })
      launch(child)
      expect(await settledWithin(child, events, 60)).toBe(false)
      expect(inputEnded()).toBe(false)
      expect(child.killed).toBe(false)

      child.stdout.write(system('task_notification', { task_id: 'bash1', status: 'completed' }))
      child.stdout.write(system('init', {}))
      child.stdout.write(system('status', { status: 'requesting' }))
      child.stdout.write(said('msg_2', 'The task finished: done.'))
      child.stdout.write(line({ type: 'result', subtype: 'success', is_error: false, result: 'The task finished: done.', session_id: 'session-1',
        origin: { kind: 'task-notification' }, usage: { input_tokens: 40, output_tokens: 5 }, total_cost_usd: 0.015 }))
      await tick()
      expect(inputEnded()).toBe(true)
      child.stdout.end()
      child.emit('close', 0)

      const seen = await events
      expect(seen.filter((event) => event.type === 'error')).toEqual([])
      expect(seen.filter((event) => event.type === 'message').map((event) => event.text))
        .toEqual(['Started it, I will report back.', 'The task finished: done.'])
      expect(seen.filter((event) => event.type === 'result')).toEqual([
        expect.objectContaining({ text: 'The task finished: done.', usage: { inputTokens: 140, outputTokens: 15, costUsd: 0.015 } }),
      ])
    })

    it('ends at the cap with a note naming the tasks still running, then kills the process', async () => {
      const { child, events, inputEnded } = start({ backgroundHoldMs: 80, idleTimeoutMs: 20 })
      launch(child)
      expect(await settledWithin(child, events, 40)).toBe(false)
      await elapse(child, 100)
      expect(inputEnded()).toBe(true)
      await elapse(child, 40)
      expect(child.killed).toBe(true)
      child.stdout.end()
      child.emit('close', null)

      const seen = await events
      expect(seen.filter((event) => event.type === 'error')).toEqual([
        { type: 'error', message: 'Stopped waiting for background work after 0 minutes. Still running: sleep 600.' },
      ])
      expect(seen.filter((event) => event.type === 'result')).toEqual([
        expect.objectContaining({ text: 'Started it, I will report back.' }),
      ])
    })

    it('redacts attached credentials from the task names in the cap note', async () => {
      process.env.MANOR_TEST_CAPABILITY = 'capability-secret'
      try {
        const { child, events } = start({ backgroundHoldMs: 20 }, { mcpServers: attachedMcpServers })
        child.stdout.write(system('task_started', { task_id: 'bash1', description: 'curl -H capability-secret', is_backgrounded: true }))
        child.stdout.write(result('Started it.', { input_tokens: 1, output_tokens: 1 }, 0.001))
        await elapse(child, 60)
        child.stdout.end()
        child.emit('close', null)
        const seen = await events
        expect(JSON.stringify(seen)).not.toContain('capability-secret')
        expect(seen).toContainEqual(expect.objectContaining({ type: 'error', message: expect.stringContaining('Still running: curl -H') }))
      } finally {
        delete process.env.MANOR_TEST_CAPABILITY
      }
    })

    it('keeps the idle clock paused when an answered ask-user releases it during the wait', async () => {
      const gate = new TurnIdleGate()
      const { child, handle, events } = start({ idleTimeoutMs: 20, idleGate: gate })
      launch(child)
      await tick()
      gate.hold('main', sage.id)
      gate.release('main', sage.id)
      expect(await settledWithin(child, events, 70)).toBe(false)
      expect(child.killed).toBe(false)
      handle.stop()
      await events
    })

    it('puts the idle clock back on once a main request runs again', async () => {
      const { child, events } = start({ idleTimeoutMs: 20 })
      launch(child)
      child.stdout.write(system('task_notification', { task_id: 'bash1', status: 'completed' }))
      child.stdout.write(system('status', { status: 'requesting' }))
      await elapse(child, 20)
      child.stdout.end()
      const seen = await events
      expect(seen).toContainEqual({ type: 'error', message: 'the turn went quiet: no activity for 0s' })
      expect(child.killed).toBe(true)
      child.emit('close', null)
    })

    describe('rows and the wait', () => {
      const call = (id: string, name: string, input: Record<string, unknown>) =>
        line({ type: 'assistant', message: { id: `msg_${id}`, content: [{ type: 'tool_use', id, name, input }] } })
      const receipt = (id: string) =>
        line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'Async agent launched successfully.' }] } })

      it('shows what the answered turn waits on, by kind, until each piece reports back', async () => {
        const { child, events } = start({ idleTimeoutMs: 20 })
        child.stdout.write(call('call-a', 'Agent', { description: 'Draft the figure', prompt: 'Draw it.', run_in_background: true }))
        child.stdout.write(system('task_started', { task_id: 'a1', tool_use_id: 'call-a', description: 'Draft the figure', is_backgrounded: true, task_type: 'local_agent', spawn_depth: 1 }))
        child.stdout.write(receipt('call-a'))
        child.stdout.write(call('call-b', 'Bash', { command: 'sleep 600', run_in_background: true }))
        child.stdout.write(system('task_started', { task_id: 'b1', tool_use_id: 'call-b', description: 'sleep 600', is_backgrounded: true, task_type: 'local_bash' }))
        child.stdout.write(receipt('call-b'))
        child.stdout.write(said('msg_1', 'Started both.'))
        child.stdout.write(result('Started both.', { input_tokens: 10, output_tokens: 2 }, 0.01))
        await tick()
        child.stdout.write(system('task_notification', { task_id: 'a1', tool_use_id: 'call-a', status: 'completed', summary: 'The figure is drawn.' }))
        child.stdout.write(system('status', { status: 'requesting' }))
        child.stdout.write(said('msg_2', 'The figure is in.'))
        child.stdout.write(line({ type: 'result', subtype: 'success', is_error: false, result: 'The figure is in.', session_id: 'session-1', origin: { kind: 'task-notification' } }))
        await tick()
        child.stdout.write(system('task_notification', { task_id: 'b1', tool_use_id: 'call-b', status: 'killed' }))
        child.stdout.write(system('status', { status: 'requesting' }))
        child.stdout.write(line({ type: 'result', subtype: 'success', is_error: false, result: 'Done.', session_id: 'session-1', origin: { kind: 'task-notification' } }))
        child.stdout.end()
        child.emit('close', 0)

        const seen = await events
        expect(seen.filter((event) => event.type === 'background_wait')).toEqual([
          { type: 'background_wait', agents: 1, commands: 1 },
          { type: 'background_wait', agents: 0, commands: 1 },
          { type: 'background_wait', agents: 0, commands: 0 },
          { type: 'background_wait', agents: 0, commands: 1 },
          { type: 'background_wait', agents: 0, commands: 0 },
        ])
        // The receipts settle nothing; each row settles from its own notification.
        expect(seen.filter((event) => event.type === 'tool_result')).toEqual([
          { type: 'tool_result', toolCallId: 'call-a', outcome: 'success', output: 'The figure is drawn.' },
          { type: 'tool_result', toolCallId: 'call-b', outcome: 'stopped' },
        ])
        expect(seen.filter((event) => event.type === 'tool_use').map((event) => event.type === 'tool_use' && event.background))
          .toEqual([true, true])
        expect(seen.findIndex((event) => event.type === 'tool_result'))
          .toBeGreaterThan(seen.findIndex((event) => event.type === 'background_wait'))
      })

      it('settles a refused launch at once, and closes what still runs at the cap as stopped', async () => {
        const { child, events } = start({ backgroundHoldMs: 20 })
        child.stdout.write(call('call-x', 'Bash', { command: 'nope', run_in_background: true }))
        child.stdout.write(line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call-x', is_error: true, content: 'Refused.' }] } }))
        child.stdout.write(call('call-a', 'Agent', { description: 'Draft the figure', prompt: 'Draw it.', run_in_background: true }))
        child.stdout.write(system('task_started', { task_id: 'a1', tool_use_id: 'call-a', description: 'Draft the figure', is_backgrounded: true, task_type: 'local_agent', spawn_depth: 1 }))
        child.stdout.write(receipt('call-a'))
        child.stdout.write(result('Started it.', { input_tokens: 1, output_tokens: 1 }, 0.001))
        await elapse(child, 60)
        child.stdout.end()
        child.emit('close', null)
        const seen = await events
        expect(seen.filter((event) => event.type === 'tool_result')).toEqual([
          { type: 'tool_result', toolCallId: 'call-x', outcome: 'error', error: 'Refused.' },
          { type: 'tool_result', toolCallId: 'call-a', outcome: 'stopped' },
        ])
      })

      it('lets a background end release only its own call, never a foreground one still running', async () => {
        const { child, events, handle } = start({ idleTimeoutMs: 30 })
        child.stdout.write(call('call-b', 'Bash', { command: 'sleep 1', run_in_background: true }))
        child.stdout.write(system('task_started', { task_id: 'b1', tool_use_id: 'call-b', description: 'sleep 1', is_backgrounded: true, task_type: 'local_bash' }))
        child.stdout.write(receipt('call-b'))
        child.stdout.write(call('call-f', 'Bash', { command: 'sleep 600' }))
        child.stdout.write(system('task_notification', { task_id: 'b1', tool_use_id: 'call-b', status: 'completed' }))
        await elapse(child, 90)
        handle.stop()
        child.emit('close', null)
        expect((await events).filter((event) => event.type === 'error')).toEqual([])
      })

      it('keeps a held SendMessage visible when Stop comes before its receipt', async () => {
        const { child, events, handle } = start()
        child.stdout.write(call('call-s', 'SendMessage', { to: 'a1', message: 'Continue.', summary: 'Continue work' }))
        await tick()
        handle.stop()
        child.emit('close', null)
        expect(await events).toContainEqual(expect.objectContaining({ type: 'tool_use', toolCallId: 'call-s', tool: 'SendMessage' }))
      })

      it('keeps the idle clock on the main request once a background launch returned its receipt', async () => {
        const { child, events } = start({ idleTimeoutMs: 20 })
        child.stdout.write(call('call-a', 'Agent', { description: 'Look around', prompt: 'Look.', run_in_background: true }))
        child.stdout.write(system('task_started', { task_id: 'a1', tool_use_id: 'call-a', description: 'Look around', is_backgrounded: true, task_type: 'local_agent', spawn_depth: 1 }))
        child.stdout.write(receipt('call-a'))
        await elapse(child, 20)
        const seen = await events
        expect(seen).toContainEqual({ type: 'error', message: 'the turn went quiet: no activity for 0s' })
        child.emit('close', null)
      })
    })
  })

  it('fails when the CLI exits after a replayed wake, before it answers the prompt', async () => {
    const { child, events } = start()
    child.stdout.write(line({ type: 'result', subtype: 'success', is_error: false, result: '', session_id: 'session-1',
      origin: { kind: 'task-notification' }, usage: { input_tokens: 3, output_tokens: 0 } }))
    child.stdout.end()
    child.emit('close', 1)
    const seen = await events
    expect(seen.filter((event) => event.type === 'result')).toEqual([])
    expect(seen).toContainEqual(expect.objectContaining({ type: 'error', message: 'exit code 1' }))
  })

  it('fails when the CLI exits after it started an addition but before it answered it', async () => {
    const { child, handle, events, sent, boot } = start()
    await boot()
    const delivery = handle.steer?.(addition('Correction'))
    await tick()
    child.stdout.write(lifecycle(sent()[1]?.uuid, 'queued'))
    child.stdout.write(result('Original.', { input_tokens: 10, output_tokens: 2 }, 0.01))
    child.stdout.write(lifecycle(sent()[1]?.uuid, 'started'))
    expect(await delivery).toBe('accepted')
    child.stdout.end()
    child.emit('close', 1)
    const seen = await events
    expect(seen.filter((event) => event.type === 'result')).toEqual([])
    expect(seen).toContainEqual(expect.objectContaining({ type: 'error', message: 'exit code 1' }))
  })

  it('refuses before the CLI reports commands, after the result and on a compaction', async () => {
    const { child, handle, events, sent, boot } = start()
    expect(await handle.steer?.(addition('Too early'))).toBe('refused')
    await boot()
    child.stdout.write(result('Done.', { input_tokens: 1, output_tokens: 1 }, 0.001))
    await tick()
    expect(await handle.steer?.(addition('Too late'))).toBe('refused')
    expect(sent()).toHaveLength(1)
    child.stdout.end()
    child.emit('close', 0)
    await events

    const compactChild = new FakeChild()
    const compact = createClaudeDriver({ agents: () => [sage], spawnFn: () => compactChild, timeoutMs: 5_000 }).compactSession!({
      agent: sage, sessionId: 'abc-123', threadId: 'main', cwd: '/tmp/manor-scratch/main', repoPaths: [],
    })
    compactChild.stdout.write(lifecycle('any', 'started'))
    await tick()
    expect(await compact.steer?.(addition('Not now'))).toBe('refused')
    compact.stop()
  })
})
