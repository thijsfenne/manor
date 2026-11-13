import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import type { AgentConfig, LiveSessionEvent, RuntimeEvent, TurnHandle, TurnInput } from '@manor/contracts'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { HOUSE_STYLE_HEADING, REPLY_LANGUAGE_LINE } from '../src/composer.js'
import { RESUME_FAILURE_PREFIX, isResumeFailure } from '../src/drivers/resumeFailure.js'
import { TurnIdleGate } from '../src/drivers/turnTimers.js'
import type { CodexInstallation } from '../src/drivers/codexInstallation.js'
import {
  buildCodexAppServerArgs,
  buildCodexCompactRequest,
  buildCodexThreadRequest,
  buildCodexTurnRequest,
  CODEX_LIVE_INSTRUCTIONS,
  CODEX_REKEY_FAILED,
  CodexStreamParser,
  createCodexDriver,
  discoverPersonalSkillManifests,
  KNOWLEDGE_WORK_BASE,
} from '../src/drivers/codexDriver.js'

const sage: AgentConfig = {
  id: 'sage', name: 'Sage', color: '#6FA8A0', driver: 'codex', effort: 'high',
  allowedTools: [], mcpServers: [], memoryScope: false, role: 'Generalist',
  description: '', isCos: false, character: 'You are Sage.',
}

const smith: AgentConfig = {
  ...sage, id: 'smith', name: 'Smith', model: 'gpt-5.6-sol',
  allowedTools: ['Read', 'Bash'], character: 'You are Smith.',
}

const attachedMcpServers: NonNullable<TurnInput['mcpServers']> = [{
  server: {
    id: 'mcp-test', name: 'test', command: 'test-mcp', args: [],
    envKeys: ['MANOR_TEST_CAPABILITY'], description: '', writes: false,
    effectPolicy: 'confirm_writes', tools: [], readOnlyTools: [], schemaChars: 0,
  },
  disabledTools: [],
}]

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly stdin = new PassThrough()
  readonly signals: NodeJS.Signals[] = []

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal)
    return true
  }
}

let scratch: string
let codexHome: string
const previousCodexHome = process.env.MANOR_CODEX_HOME
const previousSandbox = process.env.MANOR_CODEX_SANDBOX

beforeAll(() => {
  scratch = mkdtempSync(path.join(os.tmpdir(), 'manor-codex-scratch-'))
  codexHome = mkdtempSync(path.join(os.tmpdir(), 'manor-codex-home-'))
  process.env.MANOR_CODEX_HOME = codexHome
  delete process.env.MANOR_CODEX_SANDBOX
})

afterAll(() => {
  if (previousCodexHome === undefined) delete process.env.MANOR_CODEX_HOME
  else process.env.MANOR_CODEX_HOME = previousCodexHome
  if (previousSandbox === undefined) delete process.env.MANOR_CODEX_SANDBOX
  else process.env.MANOR_CODEX_SANDBOX = previousSandbox
})

function turnInput(agent: AgentConfig, overrides: Partial<TurnInput> = {}): TurnInput {
  return {
    agent, threadId: 'main', cwd: scratch,
    catchUp: [{
      id: 'evt_000001', ts: 1, type: 'user_message',
      text: 'What should we build first?', mentions: [agent.id],
    }],
    isFullCatchUp: true, repoPaths: [], ...overrides,
  }
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

async function drain(events: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const collected: RuntimeEvent[] = []
  for await (const event of events) collected.push(event)
  return collected
}

const notification = (method: string, params: unknown): string => JSON.stringify({ method, params })

it('fails the turn when child stdin breaks without crashing the process', async () => {
  const { events } = await run({
    agent: sage,
    onReady: async (_handle, child) => {
      child.stdin.emit('error', Object.assign(new Error('broken pipe'), { code: 'EPIPE' }))
    },
  })
  expect(events).toContainEqual({ type: 'error', message: expect.stringContaining('broken pipe') })
})

function completedTurn(status = 'completed', error: unknown = null): string {
  return notification('turn/completed', {
    threadId: 'thread-1', turn: { id: 'turn-1', status, error, items: [] },
  })
}

function successfulNotifications(text = 'Start with the heart.'): string[] {
  return [
    notification('item/agentMessage/delta', {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'message-1', delta: text,
    }),
    notification('item/completed', {
      threadId: 'thread-1', turnId: 'turn-1',
      item: { type: 'agentMessage', id: 'message-1', text },
    }),
    notification('thread/tokenUsage/updated', {
      threadId: 'thread-1', turnId: 'turn-1',
      tokenUsage: {
        total: { totalTokens: 110 },
        last: { inputTokens: 100, outputTokens: 8, reasoningOutputTokens: 2 },
      },
    }),
    completedTurn(),
  ]
}

interface RunResult {
  events: RuntimeEvent[]
  requests: Array<Record<string, unknown>>
  child: FakeChild
  args: string[]
  env: NodeJS.ProcessEnv
  cwd: string
}

async function run(options: {
  agent: AgentConfig
  input?: Partial<TurnInput>
  notifications?: string[]
  stderr?: string
  exitCode?: number
  threadServiceTier?: string | null
  threadError?: string
  beforeClose?: (spawn: { env: NodeJS.ProcessEnv; cwd: string }) => Promise<void>
  onReady?: (handle: TurnHandle, child: FakeChild) => Promise<void>
}): Promise<RunResult> {
  const child = new FakeChild()
  let stdin = ''
  child.stdin.on('data', (chunk: Buffer) => { stdin += chunk.toString('utf8') })
  let seen: { args: string[]; env: NodeJS.ProcessEnv; cwd: string } | undefined
  let spawnedResolve: () => void = () => undefined
  const spawned = new Promise<void>((resolve) => { spawnedResolve = resolve })
  const driver = createCodexDriver({
    agents: () => [sage, smith], personalSkillManifests: async () => [],
    spawnFn: (_command, args, spawnOptions) => {
      seen = { args: [...args], env: spawnOptions.env, cwd: spawnOptions.cwd }
      spawnedResolve()
      return child
    },
    timeoutMs: 5_000,
  })
  const handle = driver.startTurn(turnInput(options.agent, options.input))
  const collected = drain(handle.events)
  await spawned
  await tick()

  child.stdout.write(`${JSON.stringify({ id: 0, result: { userAgent: 'test' } })}\n`)
  await tick()
  if (options.threadError === undefined) {
    child.stdout.write(`${JSON.stringify({
      id: 1,
      result: {
        thread: { id: options.input?.sessionId ?? 'thread-1' },
        model: options.agent.model ?? 'gpt-5.6-sol',
        serviceTier: options.threadServiceTier ?? null,
      },
    })}\n`)
    await tick()
    child.stdout.write(`${JSON.stringify({ id: 2, result: { turn: { id: 'turn-1' } } })}\n`)
    await tick()
  } else {
    child.stdout.write(`${JSON.stringify({ id: 1, error: { code: -32602, message: options.threadError } })}\n`)
    await tick()
  }

  await options.onReady?.(handle, child)
  for (const line of options.notifications ?? (options.threadError === undefined ? successfulNotifications() : [])) {
    child.stdout.write(`${line}\n`)
  }
  await tick()
  if (options.stderr !== undefined) child.stderr.write(options.stderr)
  if (options.beforeClose !== undefined && seen !== undefined) await options.beforeClose(seen)
  child.stdout.end()
  child.stderr.end()
  child.emit('close', options.exitCode ?? 0)

  if (seen === undefined) throw new Error('the driver never spawned')
  return {
    events: await collected,
    requests: stdin.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>),
    child, args: seen.args, env: seen.env, cwd: seen.cwd,
  }
}

describe('Codex app-server requests', () => {
  it('fails a synchronous E2BIG spawn and clears its idle clock', async () => {
    const driver = createCodexDriver({
      agents: () => [sage], personalSkillManifests: async () => [], timeoutMs: 1_000,
      spawnFn: () => { throw Object.assign(new Error('argument list too long'), { code: 'E2BIG' }) },
    })
    const events = await drain(driver.startTurn(turnInput(sage)).events)
    expect(events).toContainEqual({ type: 'error', message: expect.stringContaining('argument list too long') })
  })

  it('delivers a standalone consultation as tool output and keeps mixed human input explicit', () => {
    const evidence: TurnInput['catchUp'] = [{ type: 'agent_message', id: 'reply', ts: 2, turnId: 'consult', agentId: 'smith', text: 'Research result' }]
    const request = buildCodexTurnRequest(turnInput(sage, { catchUp: evidence, sessionId: 'existing' }), scratch, 'Labelled research', 'existing')
    expect(request.params).toMatchObject({ input: [], toolOutput: { name: 'manor_household', output: 'Labelled research' } })
    const mixed = buildCodexTurnRequest(turnInput(sage, { catchUp: [...turnInput(sage).catchUp, ...evidence] }), scratch, 'Human task and labelled history', 'thread')
    expect(mixed.params).not.toHaveProperty('toolOutput')
    expect(mixed.params).toMatchObject({ input: [{ type: 'text', text: 'Human task and labelled history' }] })
  })

  it('binds concurrent additions to separate acknowledgements without interrupting the turn', async () => {
    await run({ agent: sage, onReady: async (handle, process) => {
      const ids: number[] = []
      process.stdin.on('data', (chunk: Buffer) => {
        const request = JSON.parse(chunk.toString()) as { id: number; method: string }
        if (request.method !== 'turn/steer') return
        ids.push(request.id)
        if (ids.length === 2) for (const id of [...ids].reverse()) process.stdout.write(`${JSON.stringify({ id, result: { turnId: 'turn-1' } })}\n`)
      })
      const additions = ['First', 'Second'].map((text) => handle.steer?.({ type: 'user_message', id: text, ts: 1, mentions: [], text }))
      expect(await Promise.all(additions)).toEqual(['accepted', 'accepted'])
      expect(new Set(ids).size).toBe(2)
      expect(process.signals).toEqual([])
    } })
  })

  it.each(['completion', 'stop'] as const)('does not guess acceptance when %s wins an outstanding steering request', async (ending) => {
    await run({ agent: sage, onReady: async (handle, process) => {
      const delivery = handle.steer?.({ type: 'user_message', id: 'racing', ts: 1, text: 'Correction', mentions: [] })
      await tick()
      if (ending === 'stop') {
        handle.stop()
        process.stdout.write(`${JSON.stringify({ id: 99, result: {} })}\n`)
        process.stdout.write(`${completedTurn('interrupted')}\n`)
      } else process.stdout.write(`${completedTurn()}\n`)
      await tick()
      process.emit('close', 0)
      expect(await delivery).toBe('uncertain')
    } })
  })
  it('overrides the knowledge-work base on fresh and resumed threads without duplicating persona context', () => {
    for (const sessionId of [undefined, 'existing']) {
      const request = buildCodexThreadRequest(turnInput(sage, { sessionId }), scratch)
      expect(request.params).toMatchObject({ baseInstructions: KNOWLEDGE_WORK_BASE })
      expect(JSON.stringify(request.params)).not.toContain(sage.character)
    }
    for (const input of [turnInput(sage, { singleSession: true }), turnInput(sage, { infrastructure: true })]) {
      expect(buildCodexThreadRequest(input, scratch).params).not.toHaveProperty('baseInstructions')
    }
  })

  // 2026-10-29: the base follows the persona's role, not its tools, so research in a
  // linked project with shell and edit tools stays knowledge work.
  it('keeps a non-engineering persona on the knowledge-work base with folders and tools, engineers on the coding base', () => {
    const ellis = { ...sage, id: 'ellis', name: 'Ellis', role: 'Generalist', allowedTools: ['Read', 'Edit', 'Bash'] }
    expect(buildCodexThreadRequest(turnInput(ellis, { repoPaths: ['/project'] }), scratch).params)
      .toMatchObject({ baseInstructions: KNOWLEDGE_WORK_BASE })
    for (const role of ['Engineer', 'Code reviewer']) {
      const engineer = { ...ellis, id: 'wren', name: 'Wren', role }
      expect(buildCodexThreadRequest(turnInput(engineer, { repoPaths: ['/project'] }), scratch).params)
        .not.toHaveProperty('baseInstructions')
    }
  })

  it('tells Codex to end its turn on long background work only in a room that wakes', () => {
    for (const sessionId of [undefined, 'existing']) {
      expect(buildCodexThreadRequest(turnInput(smith, { sessionId, live: true }), scratch).params)
        .toMatchObject({ developerInstructions: CODEX_LIVE_INSTRUCTIONS })
      expect(buildCodexThreadRequest(turnInput(smith, { sessionId }), scratch).params).not.toHaveProperty('developerInstructions')
    }
  })

  it('steers the active turn in order with text, source attachments and materialised images', async () => {
    const { requests, child } = await run({ agent: sage, onReady: async (handle, process) => {
      process.stdin.on('data', (chunk: Buffer) => {
        const request = JSON.parse(chunk.toString()) as { id: number; method: string }
        if (request.method === 'turn/steer') process.stdout.write(`${JSON.stringify({ id: request.id, result: { turnId: 'turn-1' } })}\n`)
      })
      for (const text of ['Include this.', 'And this correction.']) {
        expect(await handle.steer?.({ id: `event-${text}`, ts: 1, type: 'user_message', text, mentions: [],
          images: [{ name: 'test.png', dataUrl: 'data:image/png;base64,aGVsbG8=' }],
          files: [{ name: 'source.txt', mime: 'text/plain', content: 'Exact source' }],
        })).toBe('accepted')
      }
      expect(process.signals).toEqual([])
    } })
    const steering = requests.filter((request) => request.method === 'turn/steer')
    expect(steering).toHaveLength(2)
    expect(steering[0]).toMatchObject({ params: { threadId: 'thread-1', expectedTurnId: 'turn-1', input: [
      { type: 'text', text: expect.stringContaining('Exact source') }, { type: 'localImage' },
    ] } })
    expect(steering[0]?.id).not.toBe(steering[1]?.id)
    expect(child.signals).toEqual(['SIGTERM'])
  })

  it.each([false, true])('pins house style on a steer only outside Single (single: %s)', async (singleSession) => {
    // Single turns always carry a model; its helper config names it.
    const { requests } = await run({ agent: { ...sage, model: 'gpt-5.6-sol' }, input: { singleSession }, onReady: async (handle, process) => {
      process.stdin.on('data', (chunk: Buffer) => {
        const request = JSON.parse(chunk.toString()) as { id: number; method: string }
        if (request.method === 'turn/steer') process.stdout.write(`${JSON.stringify({ id: request.id, result: { turnId: 'turn-1' } })}\n`)
      })
      expect(await handle.steer?.({ id: 'addition', ts: 1, type: 'user_message', text: 'Correction', mentions: [] })).toBe('accepted')
    } })
    const steer = JSON.stringify(requests.find((request) => request.method === 'turn/steer'))
    expect(steer.includes(HOUSE_STYLE_HEADING)).toBe(!singleSession)
  })

  it.each(['refused', 'uncertain'] as const)('keeps %s steering distinct from accepted delivery', async (expected) => {
    await run({ agent: sage, onReady: async (handle, process) => {
      process.stdin.on('data', (chunk: Buffer) => {
        const request = JSON.parse(chunk.toString()) as { id: number; method: string }
        if (request.method !== 'turn/steer') return
        process.stdout.write(`${JSON.stringify({ id: request.id, ...(expected === 'refused'
          ? { error: { code: -32602, message: 'turn already finished' } }
          : { result: { turnId: 'another-turn' } }) })}\n`)
      })
      expect(await handle.steer?.({ id: 'addition', ts: 1, type: 'user_message', text: 'Correction', mentions: [] })).toBe(expected)
    } })
  })

  it('settles an unanswered steering request as uncertain when the process closes', async () => {
    await run({ agent: sage, onReady: async (handle, process) => {
      const delivery = handle.steer?.({ id: 'addition', ts: 1, type: 'user_message', text: 'Correction', mentions: [] })
      await tick()
      process.emit('close', 1)
      expect(await delivery).toBe('uncertain')
      expect(await handle.steer?.({ id: 'late', ts: 2, type: 'user_message', text: 'Late', mentions: [] })).toBe('refused')
    } })
  })
  it('sets native helper defaults and a bounded depth for single sessions', () => {
    const args = buildCodexAppServerArgs(turnInput(smith, { singleSession: true }))
    expect(args).toContain('agents={enabled=true,max_threads=4,max_depth=1,default_subagent_model="gpt-5.6-sol",default_subagent_reasoning_effort="high"}')
    expect(buildCodexAppServerArgs(turnInput(smith)).some((arg) => arg.startsWith('agents='))).toBe(false)
  })
  it('starts app-server with isolated features and enables Fast explicitly', () => {
    const standard = buildCodexAppServerArgs(turnInput(sage))
    const fast = buildCodexAppServerArgs(turnInput(sage, { speed: 'fast' }))
    expect(standard.slice(0, 7)).toEqual([
      'app-server', '--disable', 'plugins', '--disable', 'remote_plugin', '--disable', 'apps',
    ])
    expect(standard).toEqual(expect.arrayContaining(['--disable', 'fast_mode']))
    expect(fast).toEqual(expect.arrayContaining(['--enable', 'fast_mode']))
    expect(standard).toEqual(expect.arrayContaining(['-c', 'tools.update_plan={enabled=true}']))
  })

  it('disables personal Agent Skills outside CODEX_HOME', () => {
    const args = buildCodexAppServerArgs(turnInput(sage), [
      '/Users/test/.agents/skills/zeta/SKILL.md',
      '/Users/test/.agents/skills/alpha/SKILL.md',
      '/Users/test/.agents/skills/alpha/SKILL.md',
    ])
    expect(args.join(' ')).toContain(
      'skills.config=[{path="/Users/test/.agents/skills/alpha/SKILL.md",enabled=false},{path="/Users/test/.agents/skills/zeta/SKILL.md",enabled=false}]',
    )
  })

  it('sends Fast through the protocol and clears it explicitly for Standard', () => {
    const fastThread = buildCodexThreadRequest(turnInput(smith, { speed: 'fast' }), '/work')
    const fastTurn = buildCodexTurnRequest(turnInput(smith, { speed: 'fast' }), '/work', 'Hello', 'thread-1')
    const standard = buildCodexThreadRequest(turnInput(smith), '/work')
    expect(fastThread).toMatchObject({ method: 'thread/start', params: { serviceTier: 'fast' } })
    expect(fastTurn).toMatchObject({ method: 'turn/start', params: { serviceTier: 'fast' } })
    expect(standard).toMatchObject({ params: { serviceTier: null } })
  })

  it.each(['gpt-6-astra', 'future-codex-model', undefined])('sends Fast for %s on fresh and resumed sessions', (model) => {
    const agent: AgentConfig = { ...sage, ...(model === undefined ? {} : { model }) }
    const input = turnInput(agent, { speed: 'fast' })
    expect(buildCodexAppServerArgs(input)).toEqual(
      expect.arrayContaining(['--enable', 'fast_mode']),
    )
    expect(buildCodexThreadRequest(input, '/work')).toMatchObject({
      method: 'thread/start', params: { serviceTier: 'fast' },
    })
    expect(buildCodexThreadRequest({ ...input, sessionId: 'thread-1' }, '/work')).toMatchObject({
      method: 'thread/resume', params: { serviceTier: 'fast' },
    })
    expect(buildCodexTurnRequest(input, '/work', 'Hello', 'thread-1')).toMatchObject({
      params: { serviceTier: 'fast' },
    })
    expect(buildCodexTurnRequest(turnInput(agent), '/work', 'Hello', 'thread-1')).toMatchObject({
      params: { serviceTier: null },
    })
  })

  it('resumes the stored thread and preserves model, effort and infrastructure policy', () => {
    const input = turnInput(smith, { sessionId: 'thread-old' })
    expect(buildCodexThreadRequest(input, '/work', { reasoningEffort: 'medium' })).toMatchObject({
      method: 'thread/resume',
      params: {
        threadId: 'thread-old', model: 'gpt-5.6-sol', approvalPolicy: 'never', sandbox: 'danger-full-access',
      },
    })
    expect(buildCodexTurnRequest(input, '/work', 'Hello', 'thread-old', { reasoningEffort: 'medium' })).toMatchObject({
      params: { model: 'gpt-5.6-sol', effort: 'medium' },
    })
    expect(buildCodexThreadRequest(turnInput(sage), '/work', { ephemeral: true })).toMatchObject({
      params: { ephemeral: true },
    })
  })

  it('maps read-only, workspace-write roots and full access without widening for MCP', () => {
    expect(buildCodexTurnRequest(turnInput(sage), '/work', 'x', 't')).toMatchObject({
      params: { sandboxPolicy: { type: 'readOnly', networkAccess: false } },
    })
    expect(buildCodexTurnRequest(turnInput(sage, { mcpServers: attachedMcpServers }), '/work', 'x', 't')).toMatchObject({
      params: { sandboxPolicy: { type: 'readOnly' } },
    })
    process.env.MANOR_CODEX_SANDBOX = 'workspace-write'
    try {
      expect(buildCodexTurnRequest(
        turnInput(smith, { repoPaths: ['/repos/manor', '/repos/manor'] }), '/work', 'x', 't',
      )).toMatchObject({
        params: {
          sandboxPolicy: {
            type: 'workspaceWrite', writableRoots: ['/work', '/repos/manor'], networkAccess: false,
          },
        },
      })
    } finally {
      delete process.env.MANOR_CODEX_SANDBOX
    }
    expect(buildCodexTurnRequest(turnInput(smith), '/work', 'x', 't')).toMatchObject({
      params: { sandboxPolicy: { type: 'dangerFullAccess' } },
    })
  })

  it('starts native thread compact after resume', () => {
    expect(buildCodexCompactRequest('thread-old')).toEqual({
      id: 2,
      method: 'thread/compact/start',
      params: { threadId: 'thread-old' },
    })
  })

  it('sends local images as structured turn inputs', () => {
    expect(buildCodexTurnRequest(
      turnInput(sage, { imagePaths: ['/tmp/a.png'] }), '/work', 'Look', 'thread-1',
    )).toMatchObject({
      params: { input: [
        { type: 'text', text: 'Look', text_elements: [] },
        { type: 'localImage', path: '/tmp/a.png' },
      ] },
    })
  })
})

describe('personal Codex skill isolation', () => {
  it('finds immediate manifests in stable order and tolerates an absent root', async () => {
    const root = path.join(scratch, 'personal-skills')
    await mkdir(path.join(root, 'zeta'), { recursive: true })
    await mkdir(path.join(root, 'alpha'), { recursive: true })
    await writeFile(path.join(root, 'zeta', 'SKILL.md'), 'zeta')
    await writeFile(path.join(root, 'alpha', 'SKILL.md'), 'alpha')
    expect(await discoverPersonalSkillManifests(root)).toEqual([
      path.join(root, 'alpha', 'SKILL.md'), path.join(root, 'zeta', 'SKILL.md'),
    ])
    expect(await discoverPersonalSkillManifests(path.join(scratch, 'missing'))).toEqual([])
  })
})

describe('createCodexDriver', () => {
  it('spawns the active managed Codex release by absolute path', async () => {
    const child = new FakeChild()
    let command = ''
    let spawnedResolve: () => void = () => undefined
    const spawned = new Promise<void>((resolve) => { spawnedResolve = resolve })
    const active = '/tools/codex/0.164.0/bin/codex'
    // A first install that outlasts the idle window must not end the turn waiting on it.
    const installation = { ensure: () => new Promise((resolve) => setTimeout(() => resolve(active), 120)) } as unknown as CodexInstallation
    vi.stubEnv('MANOR_CODEX_COMMAND', '')
    const driver = createCodexDriver({
      agents: () => [sage], personalSkillManifests: async () => [], timeoutMs: 5_000, idleTimeoutMs: 40, installation,
      spawnFn: (spawnedCommand) => {
        command = spawnedCommand
        spawnedResolve()
        queueMicrotask(() => child.emit('close', 0))
        return child
      },
    })
    // The override is read once, when the driver is made.
    vi.unstubAllEnvs()
    const events = drain(driver.startTurn(turnInput(sage)).events)
    await spawned
    await events
    expect(command).toBe(active)
  })

  it('resumes the thread and starts native compact instead of a turn', async () => {
    const child = new FakeChild()
    let stdin = ''
    child.stdin.on('data', (chunk: Buffer) => { stdin += chunk.toString('utf8') })
    let spawnedResolve: () => void = () => undefined
    const spawned = new Promise<void>((resolve) => { spawnedResolve = resolve })
    const driver = createCodexDriver({
      agents: () => [sage], personalSkillManifests: async () => [], timeoutMs: 5_000,
      spawnFn: () => {
        spawnedResolve()
        return child
      },
    })
    const handle = driver.compactSession!({
      agent: sage,
      sessionId: 'thread-old',
      threadId: 'main',
      cwd: '/tmp/manor-scratch/main',
      repoPaths: [],
    })
    const collected = drain(handle.events)
    await spawned
    await tick()
    child.stdout.write(`${JSON.stringify({ id: 0, result: { userAgent: 'test' } })}\n`)
    await tick()
    child.stdout.write(`${JSON.stringify({
      id: 1,
      result: { thread: { id: 'thread-old' }, model: 'gpt-5.6-sol', serviceTier: null },
    })}\n`)
    await tick()
    child.stdout.write(`${JSON.stringify({ id: 2, result: {} })}\n`)
    await tick()
    child.stdout.write(`${JSON.stringify({ method: 'thread/compacted', params: { threadId: 'thread-old', turnId: 'compact-1' } })}\n`)
    await tick()
    child.stdout.end()
    child.stderr.end()
    child.emit('close', 0)
    expect(await collected).toMatchObject([{ type: 'result', sessionId: 'thread-old' }])
    expect(stdin.split('\n').filter(Boolean).map((line) => JSON.parse(line)['method'])).toEqual([
      'initialize', 'initialized', 'thread/resume', 'thread/compact/start',
    ])
  })

  it('performs the JSON-RPC handshake and streams an answer with exact usage', async () => {
    const socket = process.env.SSH_AUTH_SOCK
    process.env.SSH_AUTH_SOCK = '/tmp/manor-test-agent.sock'
    const { events, requests, env, cwd } = await run({ agent: sage }).finally(() => {
      if (socket === undefined) delete process.env.SSH_AUTH_SOCK
      else process.env.SSH_AUTH_SOCK = socket
    })
    expect(requests.map((request) => request['method'])).toEqual([
      'initialize', 'initialized', 'thread/start', 'turn/start',
    ])
    const turn = requests[3] as { params: { input: Array<{ text?: string }> } }
    expect(turn.params.input[0]?.text).toContain('User: What should we build first?')
    expect(turn.params.input[0]?.text).toContain(HOUSE_STYLE_HEADING)
    expect(turn.params.input[0]?.text).toContain(`${REPLY_LANGUAGE_LINE}\n\nUser: What should we build first?`)
    expect(events).toEqual([
      { type: 'delta', messageId: 'message-1', text: 'Start with the heart.' },
      { type: 'message', messageId: 'message-1', text: 'Start with the heart.' },
      { type: 'context', contextTokens: 100 },
      {
        type: 'result', text: 'Start with the heart.', usage: { inputTokens: 100, outputTokens: 8 },
        contextTokens: 100, reportedModel: 'gpt-5.6-sol', sessionId: 'thread-1',
      },
    ])
    expect(env['CODEX_HOME']).toBe(codexHome)
    // A turn's own git reaches the ssh agent, as it does in the user's Terminal.
    expect(env['SSH_AUTH_SOCK']).toBe('/tmp/manor-test-agent.sock')
    expect(cwd).toBe(path.join(scratch, 'sage'))
  })

  it('reports a native helper’s observed model and effort from its own rollout', async () => {
    const childId = 'child-observed-metadata'
    const { events } = await run({
      agent: sage,
      onReady: async () => {
        const dir = path.join(codexHome, 'sessions', '2026', '09', '25')
        await mkdir(dir, { recursive: true })
        await writeFile(path.join(dir, `rollout-2026-09-25T10-00-00-${childId}.jsonl`), `${JSON.stringify({
          timestamp: new Date().toISOString(), type: 'turn_context',
          payload: { model: 'gpt-6-sol', effort: 'high' },
        })}\n`)
      },
      notifications: [
        notification('item/started', { threadId: 'thread-1', item: {
          type: 'subAgentActivity', id: 'spawn-child', kind: 'started', agentThreadId: childId,
          agentPath: '/root/render_hotspots',
        } }),
        notification('item/completed', { threadId: 'thread-1', item: {
          type: 'subAgentActivity', id: 'spawn-done', kind: 'completed', agentThreadId: childId,
          agentPath: '/root/render_hotspots',
        } }),
        ...successfulNotifications(),
      ],
    })
    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool_result', toolCallId: 'spawn-child', outcome: 'success',
      reportedModel: 'gpt-6-sol', reportedEffort: 'high',
    }))
  })

  it('attaches the rollout window even when the stream already named the fill', async () => {
    const { events } = await run({
      agent: sage,
      beforeClose: async ({ env }) => {
        const home = env['CODEX_HOME']
        if (home === undefined) throw new Error('no CODEX_HOME')
        const dir = path.join(home, 'sessions', '2026', '09', '18')
        await mkdir(dir, { recursive: true })
        await writeFile(
          path.join(dir, 'rollout-2026-09-18T10-00-00-thread-1.jsonl'),
          `${JSON.stringify({
            timestamp: new Date().toISOString(),
            type: 'event_msg',
            payload: {
              type: 'token_count',
              info: {
                last_token_usage: { input_tokens: 40_257 },
                model_context_window: 258_400,
              },
            },
          })}\n`,
        )
      },
    })
    expect(events.at(-1)).toMatchObject({
      type: 'result',
      contextTokens: 100,
      contextWindow: 258_400,
    })
  })

  it('reports Fast only when the thread response proves priority', async () => {
    const proven = await run({ agent: smith, input: { speed: 'fast' }, threadServiceTier: 'priority' })
    const unproven = await run({ agent: smith, input: { speed: 'fast' }, threadServiceTier: 'fast' })
    expect(proven.events.at(-1)).toMatchObject({ type: 'result', observedSpeed: 'fast' })
    expect(unproven.events.at(-1)).not.toHaveProperty('observedSpeed')
  })

  // Reasoning is already inside outputTokens (a rollout's total is input plus output),
  // and cached input is part of inputTokens; both were once counted twice or dropped.
  it('accumulates model requests with their cache split but uses the final request for context', async () => {
    const updates = [
      notification('thread/tokenUsage/updated', {
        tokenUsage: { total: { totalTokens: 108 }, last: { inputTokens: 100, cachedInputTokens: 90, outputTokens: 8, reasoningOutputTokens: 2 } },
      }),
      notification('thread/tokenUsage/updated', {
        tokenUsage: { total: { totalTokens: 108 }, last: { inputTokens: 100, cachedInputTokens: 90, outputTokens: 8, reasoningOutputTokens: 2 } },
      }),
      notification('thread/tokenUsage/updated', {
        tokenUsage: { total: { totalTokens: 172 }, last: { inputTokens: 60, cachedInputTokens: 50, outputTokens: 4, reasoningOutputTokens: 1 } },
      }),
      completedTurn(),
    ]
    const { events } = await run({ agent: smith, notifications: updates })
    expect(events.at(-1)).toMatchObject({
      type: 'result',
      usage: {
        inputTokens: 160,
        outputTokens: 12,
        breakdown: { freshInputTokens: 20, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, cacheReadTokens: 140 },
      },
      contextTokens: 60,
    })
  })

  it('preserves shell, MCP and file-diff activity', async () => {
    const command = { type: 'commandExecution', id: 'cmd-1', command: "zsh -lc 'echo hi'", status: 'inProgress' }
    const mcp = { type: 'mcpToolCall', id: 'mcp-1', server: 'paper', tool: 'read', status: 'inProgress' }
    const change = {
      type: 'fileChange', id: 'edit-1', status: 'completed',
      changes: [{
        path: 'a.txt', kind: { type: 'update', move_path: null },
        diff: '--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new',
      }],
    }
    const { events, cwd } = await run({
      agent: smith,
      notifications: [
        notification('item/started', { item: command }),
        notification('item/completed', { item: { ...command, status: 'completed', exitCode: 0 } }),
        notification('item/started', { item: mcp }),
        notification('item/completed', { item: { ...mcp, status: 'completed', error: null } }),
        notification('item/started', { item: change }),
        notification('item/completed', { item: change }),
        completedTurn(),
      ],
    })
    expect(events.filter((event) => event.type === 'tool_use')).toEqual([
      expect.objectContaining({ type: 'tool_use', toolCallId: 'cmd-1', tool: 'Shell' }),
      { type: 'tool_use', toolCallId: 'mcp-1', tool: 'mcp__paper__read' },
      { type: 'tool_use', toolCallId: 'edit-1', tool: 'Edit', detail: 'a.txt', targets: ['a.txt'] },
    ])
    expect(events.filter((event) => event.type === 'tool_result')).toEqual([
      { type: 'tool_result', toolCallId: 'cmd-1', outcome: 'success' },
      { type: 'tool_result', toolCallId: 'mcp-1', outcome: 'success', tool: 'mcp__paper__read' },
      {
        type: 'tool_result', toolCallId: 'edit-1', outcome: 'success',
        edits: [{ path: 'a.txt', originPath: path.join(cwd, 'a.txt'), before: 'old\n', after: 'new\n', offset: { before: 0, after: 0 }, kind: 'update' }],
      },
    ])
  })

  it('publishes plans and reasoning in provider order', async () => {
    const { events } = await run({
      agent: smith,
      notifications: [
        notification('turn/plan/updated', { plan: [
          { step: 'Inspect', status: 'completed' }, { step: 'Fix', status: 'inProgress' },
        ] }),
        notification('item/completed', {
          item: { type: 'reasoning', id: 'reason-1', summary: ['Need the root cause.'], content: [] },
        }),
        completedTurn(),
      ],
    })
    expect(events.slice(0, 2)).toEqual([
      { type: 'todo_update', todos: [
        { text: 'Inspect', status: 'completed' }, { text: 'Fix', status: 'in_progress' },
      ] },
      { type: 'reasoning', text: 'Need the root cause.' },
    ])
  })

  it('keeps persona instructions and linked working copies separated', async () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), 'manor-codex-repo-'))
    const { requests, cwd } = await run({ agent: smith, input: { repoPaths: [repo] } })
    expect(cwd).toBe(path.join(scratch, 'smith'))
    expect(await readFile(path.join(cwd, 'AGENTS.md'), 'utf8')).toBe('You are Smith.\n')
    expect(requests[3]).toMatchObject({ params: { sandboxPolicy: { type: 'dangerFullAccess' } } })
    expect((requests[3] as { params: { input: Array<{ text?: string }> } }).params.input[0]?.text).toContain(repo)
  })

  it('emits images generated in the session directory before the result', async () => {
    const bytes = Buffer.from('generated diagram')
    const { events } = await run({
      agent: sage,
      beforeClose: async ({ env }) => {
        const dir = path.join(env['CODEX_HOME']!, 'generated_images', 'thread-1')
        await mkdir(dir, { recursive: true })
        await writeFile(path.join(dir, 'diagram.png'), bytes)
      },
    })
    expect(events.find((event) => event.type === 'attachment' && event.image.name === 'diagram.png')).toEqual({
      type: 'attachment',
      image: { name: 'diagram.png', dataUrl: `data:image/png;base64,${bytes.toString('base64')}` },
    })
    expect(events.at(-1)?.type).toBe('result')
  })

  it('emits an app-server image saved outside the session roots', async () => {
    const savedPath = path.join(mkdtempSync(path.join(os.tmpdir(), 'manor-codex-image-')), 'result.png')
    const bytes = Buffer.from('saved image')
    await writeFile(savedPath, bytes)
    const { events } = await run({
      agent: sage,
      notifications: [
        notification('item/completed', {
          item: { type: 'imageGeneration', id: 'image-1', status: 'completed', savedPath },
        }),
        completedTurn(),
      ],
    })
    expect(events.find((event) => event.type === 'attachment' && event.image.name === 'result.png')).toEqual({
      type: 'attachment',
      image: { name: 'result.png', dataUrl: `data:image/png;base64,${bytes.toString('base64')}` },
    })
  })

  it('routes a rejected resume through the existing clear-and-retry path', async () => {
    const { events, requests } = await run({
      agent: sage, input: { sessionId: 'missing-thread' }, threadError: 'thread not found', exitCode: 1,
    })
    expect(requests[2]).toMatchObject({ method: 'thread/resume', params: { threadId: 'missing-thread' } })
    const error = events.at(-1)
    expect(error).toEqual({ type: 'error', message: `${RESUME_FAILURE_PREFIX}thread not found` })
    expect(error?.type === 'error' && isResumeFailure(error.message)).toBe(true)
  })

  it('keeps a post-init thread error as an ordinary turn failure', async () => {
    const { events } = await run({
      agent: sage, input: { sessionId: 'live-thread' }, notifications: [],
      stderr: 'thread tool failed', exitCode: 1,
    })
    expect(events.at(-1)).toEqual({ type: 'error', message: 'thread tool failed' })
  })

  it('redacts attached capabilitys from protocol and stderr failures', async () => {
    process.env.MANOR_TEST_CAPABILITY = 'capability-secret'
    try {
      const protocol = await run({
        agent: sage, input: { mcpServers: attachedMcpServers },
        notifications: [completedTurn('failed', { message: 'provider rejected capability-secret' })],
        exitCode: 1,
      })
      expect(protocol.events).toContainEqual({ type: 'error', message: 'provider rejected [redacted]' })
      const stderr = await run({
        agent: sage, input: { mcpServers: attachedMcpServers },
        notifications: [], stderr: 'provider rejected capability-secret', exitCode: 1,
      })
      expect(stderr.events).toEqual([{ type: 'error', message: 'provider rejected [redacted]' }])
    } finally {
      delete process.env.MANOR_TEST_CAPABILITY
    }
  })

  it('marks a canceled HTTP/2 turn as safe to resume with its thread and usage', async () => {
    const message = 'RetriableError: [canceled] http/2 stream closed with error code CANCEL (0x8)'
    const { events } = await run({
      agent: sage,
      notifications: [
        notification('thread/tokenUsage/updated', {
          threadId: 'thread-1', turnId: 'turn-1',
          tokenUsage: {
            total: { totalTokens: 110 },
            last: { inputTokens: 100, outputTokens: 8, reasoningOutputTokens: 2 },
          },
        }),
        completedTurn('failed', { message }),
      ],
      exitCode: 1,
    })

    expect(events).toContainEqual({
      type: 'error',
      message,
      retryable: true,
      sessionId: 'thread-1',
      usage: { inputTokens: 100, outputTokens: 8 },
    })
  })

  it('settles a message-less failed turn instead of waiting for app-server to exit', async () => {
    const { events, child } = await run({
      agent: sage, notifications: [completedTurn('failed')], exitCode: 1,
    })
    expect(events).toContainEqual({ type: 'error', message: 'the CLI reported a failed turn' })
    expect(child.signals).toContain('SIGTERM')
  })

  it('waits for interrupt acknowledgement and terminal completion before ending Stop', async () => {
    const child = new FakeChild()
    let stdin = ''
    child.stdin.on('data', (chunk: Buffer) => { stdin += chunk.toString('utf8') })
    let spawnedResolve: () => void = () => undefined
    const spawned = new Promise<void>((resolve) => { spawnedResolve = resolve })
    const driver = createCodexDriver({
      agents: () => [sage], personalSkillManifests: async () => [], timeoutMs: 5_000,
      spawnFn: () => { spawnedResolve(); return child },
    })
    const handle = driver.startTurn(turnInput(sage))
    const events = drain(handle.events)
    await spawned
    child.stdout.write(`${JSON.stringify({ id: 0, result: {} })}\n`)
    await tick()
    child.stdout.write(`${JSON.stringify({ id: 1, result: { thread: { id: 'thread-1' }, model: 'gpt-5.6-sol', serviceTier: null } })}\n`)
    await tick()
    child.stdout.write(`${JSON.stringify({ id: 2, result: { turn: { id: 'turn-1' } } })}\n`)
    await tick()
    handle.stop()
    expect(stdin).toContain('"method":"turn/interrupt"')
    expect(child.signals).not.toContain('SIGTERM')
    child.stdout.write(`${JSON.stringify({ id: 99, result: {} })}\n`)
    await tick()
    expect(child.signals).not.toContain('SIGTERM')
    child.stdout.write(`${completedTurn('interrupted').replaceAll('thread-1', 'child')}\n`)
    await tick()
    expect(child.signals).not.toContain('SIGTERM')
    child.stdout.write(`${completedTurn('interrupted')}\n`)
    await tick()
    expect(child.signals).toContain('SIGTERM')
    expect(await events).toEqual([])
  })

  it('kills app-server when interrupt confirmation misses the grace period', async () => {
    const child = Object.assign(new FakeChild(), { pid: 99993 })
    let spawnedResolve: () => void = () => undefined
    const spawned = new Promise<void>((resolve) => { spawnedResolve = resolve })
    const driver = createCodexDriver({
      agents: () => [sage], personalSkillManifests: async () => [], timeoutMs: 5_000,
      interruptTimeoutMs: 10,
      spawnFn: () => { spawnedResolve(); return child },
    })
    const handle = driver.startTurn(turnInput(sage))
    const events = drain(handle.events)
    await spawned
    child.stdout.write(`${JSON.stringify({ id: 0, result: {} })}\n`)
    await tick()
    child.stdout.write(`${JSON.stringify({ id: 1, result: { thread: { id: 'thread-1' }, model: 'gpt-5.6-sol', serviceTier: null } })}\n`)
    await tick()
    child.stdout.write(`${JSON.stringify({ id: 2, result: { turn: { id: 'turn-1' } } })}\n`)
    await tick()
    handle.stop()
    expect(child.signals).not.toContain('SIGTERM')
    expect(await events).toEqual([])
    expect(child.signals).toContain('SIGTERM')
  })

  it('fails a silent app-server on the idle timeout', async () => {
    // The idle clock is armed before the workspace is prepared; on fake time it runs out
    // only after the spawn, however long a loaded machine takes to get there.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const child = new FakeChild()
      let spawnedResolve: () => void = () => undefined
      const spawned = new Promise<void>((resolve) => { spawnedResolve = resolve })
      const driver = createCodexDriver({
        agents: () => [sage], personalSkillManifests: async () => [], timeoutMs: 500, idleTimeoutMs: 20,
        spawnFn: () => { spawnedResolve(); return child },
      })
      const events = drain(driver.startTurn(turnInput(sage)).events)
      await spawned
      await vi.advanceTimersByTimeAsync(20)
      expect(await events).toEqual([{ type: 'error', message: expect.stringContaining('went quiet') }])
      expect(child.signals).toContain('SIGTERM')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('background work outliving the main turn', () => {
  // The idle and hold clocks run on fake time, so a loaded machine cannot fire them
  // between two lines a test writes. setImmediate stays real: it is how lines flow.
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }) })
  afterEach(() => { vi.useRealTimers() })
  const elapse = (ms: number) => vi.advanceTimersByTimeAsync(ms)

  /** A live app-server turn on thread-1/turn-1 the test drives line by line. */
  async function start(
    options: { backgroundHoldMs?: number; idleTimeoutMs?: number; idleGate?: TurnIdleGate } = {},
    input: Partial<TurnInput> = {},
  ) {
    const child = new FakeChild()
    let stdin = ''
    child.stdin.on('data', (chunk: Buffer) => { stdin += chunk.toString('utf8') })
    let spawnedResolve: () => void = () => undefined
    const spawned = new Promise<void>((resolve) => { spawnedResolve = resolve })
    const driver = createCodexDriver({
      agents: () => [sage], personalSkillManifests: async () => [], timeoutMs: 5_000,
      spawnFn: () => { spawnedResolve(); return child }, ...options,
    })
    const handle = driver.startTurn(turnInput(sage, input))
    const events = drain(handle.events)
    await spawned
    await tick()
    const write = async (...lines: string[]) => {
      for (const line of lines) child.stdout.write(`${line}\n`)
      await tick()
      await tick()
    }
    await write(JSON.stringify({ id: 0, result: {} }))
    await write(JSON.stringify({ id: 1, result: { thread: { id: 'thread-1' }, model: 'gpt-5.6-sol', serviceTier: null } }))
    await write(JSON.stringify({ id: 2, result: { turn: { id: 'turn-1' } } }))
    const requests = () => stdin.split('\n').filter(Boolean).map((line) => JSON.parse(line) as { id?: number; method: string; params: Record<string, unknown> })
    const turnStarts = () => requests().filter((request) => request.method === 'turn/start' && request.id !== 2)
    return { child, handle, events, write, requests, turnStarts }
  }

  const helperStarted = notification('item/started', { threadId: 'thread-1', item: {
    type: 'subAgentActivity', id: 'spawn-1', kind: 'started', agentThreadId: 'child-1', agentPath: '/root/render_check',
  } })
  const helperFinished = [
    notification('item/completed', { threadId: 'child-1', item: { type: 'agentMessage', id: 'child-reply', text: 'helper-done' } }),
    notification('turn/completed', { threadId: 'child-1', turn: { id: 'child-turn', status: 'completed' } }),
    notification('item/completed', { threadId: 'thread-1', item: {
      type: 'subAgentActivity', id: 'helper-completed', kind: 'completed', agentThreadId: 'child-1', agentPath: '/root/render_check',
    } }),
  ]
  const said = (turnId: string, id: string, text: string) =>
    notification('item/completed', { threadId: 'thread-1', turnId, item: { type: 'agentMessage', id, text } })
  const usage = (total: number, input: number) => notification('thread/tokenUsage/updated', {
    threadId: 'thread-1', tokenUsage: { total: { totalTokens: total }, last: { inputTokens: input, outputTokens: 5 } },
  })
  const turnDone = (turnId: string, status = 'completed') =>
    notification('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status, error: null, items: [] } })
  /** The prompt's turn starts one helper that keeps running, answers and completes. */
  const launch = [helperStarted, said('turn-1', 'msg-1', 'Started it, I will report back.'), usage(105, 100), turnDone('turn-1')]
  /** Whether the turn ended once `ms` of fake time passed. */
  const settledWithin = async (events: Promise<RuntimeEvent[]>, ms: number) => {
    let settled = false
    void events.then(() => { settled = true })
    await elapse(ms)
    await tick()
    return settled
  }
  /**
   * Line handling awaits rollout reads for helper results, so a fixed tick count is not
   * enough. Polls on real I/O turns without moving fake time, up to a generous wall-clock bound.
   */
  const until = async <T>(read: () => T[]): Promise<T[]> => {
    const deadline = Date.now() + 5_000
    while (read().length === 0 && Date.now() < deadline) await tick()
    return read()
  }

  it('keeps the turn open past its answer and folds the woken turn into one result', async () => {
    const { child, events, write, turnStarts } = await start({ idleTimeoutMs: 20 })
    await write(...launch)
    expect(await settledWithin(events, 60)).toBe(false)
    expect(child.signals).toEqual([])
    expect(turnStarts()).toEqual([])

    await write(...helperFinished)
    const wake = await until(turnStarts)
    expect(wake).toEqual([expect.objectContaining({ params: expect.objectContaining({
      threadId: 'thread-1', input: [expect.objectContaining({ text: expect.stringContaining('Helper "render check" finished.') })],
    }) })])
    await write(JSON.stringify({ id: wake[0]?.id, result: { turn: { id: 'turn-2' } } }),
      notification('turn/started', { threadId: 'thread-1', turn: { id: 'turn-2' } }),
      said('turn-2', 'msg-2', 'The check reported helper-done.'), usage(150, 40), turnDone('turn-2'))
    expect(await until(() => child.signals)).toEqual(['SIGTERM'])
    child.stdout.end()
    child.emit('close', 0)

    const seen = await events
    expect(seen.filter((event) => event.type === 'error')).toEqual([])
    expect(seen).toContainEqual(expect.objectContaining({ type: 'tool_result', toolCallId: 'spawn-1', output: 'helper-done' }))
    expect(seen.filter((event) => event.type === 'result')).toEqual([expect.objectContaining({
      text: 'Started it, I will report back.\n\nThe check reported helper-done.',
      usage: { inputTokens: 140, outputTokens: 10 },
    })])
  })

  it('ends at the cap with a redacted note naming what still runs, then kills the process', async () => {
    process.env.MANOR_TEST_CAPABILITY = 'capability-secret'
    try {
      const { child, events, write } = await start({ backgroundHoldMs: 60, idleTimeoutMs: 20 }, { mcpServers: attachedMcpServers })
      await write(
        notification('item/started', { threadId: 'thread-1', item: {
          type: 'commandExecution', id: 'shell-1', command: 'curl -H capability-secret https://example.test', status: 'inProgress',
        } }),
        said('turn-1', 'msg-1', 'Started it.'), turnDone('turn-1'),
      )
      expect(child.signals).toEqual([])
      await elapse(90)
      expect(child.signals).toEqual(['SIGTERM'])
      child.stdout.end()
      child.emit('close', null)
      const seen = await events
      expect(JSON.stringify(seen)).not.toContain('capability-secret')
      expect(seen.filter((event) => event.type === 'error')).toEqual([{
        type: 'error', message: expect.stringMatching(/^Stopped waiting for background work after 0 minutes\. Still running: curl -H /),
      }])
      expect(seen.filter((event) => event.type === 'result')).toEqual([expect.objectContaining({ text: 'Started it.' })])
    } finally {
      delete process.env.MANOR_TEST_CAPABILITY
    }
  })

  it('keeps the idle clock paused when a helper tool closes or an answered ask-user releases it', async () => {
    const gate = new TurnIdleGate()
    const { child, handle, events, write } = await start({ idleTimeoutMs: 20, idleGate: gate })
    await write(...launch)
    await write(
      notification('item/started', { threadId: 'child-1', item: { type: 'commandExecution', id: 'child-cmd', command: 'pwd', status: 'inProgress' } }),
      notification('item/completed', { threadId: 'child-1', item: { type: 'commandExecution', id: 'child-cmd', command: 'pwd', status: 'completed', exitCode: 0 } }),
    )
    gate.hold('main', sage.id)
    gate.release('main', sage.id)
    expect(await settledWithin(events, 70)).toBe(false)
    expect(child.signals).toEqual([])
    handle.stop()
    await events
  })

  it('puts the idle clock back once a main turn starts again', async () => {
    const { child, events, write, turnStarts } = await start({ idleTimeoutMs: 20 })
    await write(...launch)
    expect(await settledWithin(events, 60)).toBe(false)
    await write(...helperFinished)
    const [wake] = await until(turnStarts)
    expect(await settledWithin(events, 60)).toBe(false)
    await write(JSON.stringify({ id: wake?.id, result: { turn: { id: 'turn-2' } } }),
      notification('turn/started', { threadId: 'thread-1', turn: { id: 'turn-2' } }))
    await elapse(20)
    child.stdout.end()
    const seen = await events
    expect(seen).toContainEqual({ type: 'error', message: 'the turn went quiet: no activity for 0s' })
    expect(seen.filter((event) => event.type === 'result')).toEqual([expect.objectContaining({ text: 'Started it, I will report back.' })])
    expect(child.signals).toEqual(['SIGTERM'])
  })

  it('starts a turn for an addition while the thread waits, and Stop ends the hold without an interrupt', async () => {
    const { child, handle, events, write, requests, turnStarts } = await start({ idleTimeoutMs: 20 })
    await write(...launch)
    const delivery = handle.steer?.({ type: 'user_message', id: 'more', ts: 2, text: 'Also check the footer.', mentions: [] })
    const addition = await until(turnStarts)
    expect(addition).toEqual([expect.objectContaining({ params: expect.objectContaining({
      input: [expect.objectContaining({ text: expect.stringContaining('Also check the footer.') })],
    }) })])
    await write(JSON.stringify({ id: addition[0]?.id, result: { turn: { id: 'turn-2' } } }),
      notification('turn/started', { threadId: 'thread-1', turn: { id: 'turn-2' } }),
      said('turn-2', 'msg-2', 'Footer noted.'), turnDone('turn-2'))
    expect(await delivery).toBe('accepted')
    expect(child.signals).toEqual([])

    handle.stop()
    expect(child.signals).toEqual(['SIGTERM'])
    await events
    expect(requests().map((request) => request.method)).not.toContain('turn/interrupt')
  })

  it('reports a refused wake and keeps the first answer', async () => {
    const { child, events, write, turnStarts } = await start({ idleTimeoutMs: 20 })
    await write(...launch, ...helperFinished)
    const [wake] = await until(turnStarts)
    await write(JSON.stringify({ id: wake?.id, error: { code: -32600, message: 'cannot start wake' } }))
    child.stdout.end()
    child.emit('close', 0)
    const seen = await events
    expect(seen).toContainEqual({ type: 'error', message: 'Codex did not take the wake after its background work ended.' })
    expect(seen.filter((event) => event.type === 'result')).toEqual([expect.objectContaining({ text: 'Started it, I will report back.' })])
  })

  it('holds an addition until no wake is starting, even when one wake starts the next', async () => {
    const { handle, events, write, requests, turnStarts } = await start({ idleTimeoutMs: 200 })
    const second = (line: string) => line.replaceAll('spawn-1', 'spawn-2').replaceAll('child-1', 'child-2').replaceAll('render_check', 'second_check')
    await write(helperStarted, second(helperStarted), said('turn-1', 'msg-1', 'Started both.'), turnDone('turn-1'), ...helperFinished)
    const [firstWake] = await until(turnStarts)
    const delivery = handle.steer?.({ type: 'user_message', id: 'more', ts: 2, text: 'Also check the footer.', mentions: [] })
    await tick()
    // The first wake's turn runs and completes before Codex answers its request, and the second helper ends inside it.
    await write(notification('turn/started', { threadId: 'thread-1', turn: { id: 'turn-2' } }),
      ...helperFinished.map(second), turnDone('turn-2'),
      JSON.stringify({ id: firstWake?.id, result: { turn: { id: 'turn-2' } } }))
    const [secondWake] = await until(() => turnStarts().slice(1))
    const steers = () => requests().filter((request) => request.method === 'turn/steer')
    expect(steers()).toEqual([])
    await write(JSON.stringify({ id: secondWake?.id, result: { turn: { id: 'turn-3' } } }),
      notification('turn/started', { threadId: 'thread-1', turn: { id: 'turn-3' } }))
    const [steer] = await until(steers)
    expect(steer?.params).toEqual(expect.objectContaining({ expectedTurnId: 'turn-3' }))
    await write(JSON.stringify({ id: steer?.id, result: { turnId: 'turn-3' } }), said('turn-3', 'msg-3', 'Both done.'), turnDone('turn-3'))
    expect(await delivery).toBe('accepted')
    handle.stop()
    await events
  })

  it('names work a running wake started when the cap ends the hold', async () => {
    const { child, events, write, turnStarts } = await start({ backgroundHoldMs: 80, idleTimeoutMs: 200 })
    await write(...launch, ...helperFinished)
    const [wake] = await until(turnStarts)
    await write(JSON.stringify({ id: wake?.id, result: { turn: { id: 'turn-2' } } }),
      notification('turn/started', { threadId: 'thread-1', turn: { id: 'turn-2' } }),
      notification('item/started', { threadId: 'thread-1', item: {
        type: 'commandExecution', id: 'shell-2', command: 'sleep 600 && second-job', status: 'inProgress',
      } }))
    expect(child.signals).toEqual([])
    await elapse(80)
    expect(child.signals).toEqual(['SIGTERM'])
    child.stdout.end()
    child.emit('close', null)
    const seen = await events
    expect(seen.filter((event) => event.type === 'error')).toEqual([{
      type: 'error', message: 'Stopped waiting for background work after 0 minutes. Still running: sleep 600 && second-job.',
    }])
  })
})

describe('live sessions', () => {
  const said = (turnId: string, id: string, text: string) =>
    notification('item/completed', { threadId: 'thread-1', turnId, item: { type: 'agentMessage', id, text } })
  const turnDone = (turnId: string) =>
    notification('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed', error: null, items: [] } })
  const shellStarted = (id: string, command: string) =>
    notification('item/started', { threadId: 'thread-1', item: { type: 'commandExecution', id, command, status: 'inProgress' } })
  const shellDone = (id: string, command: string, exitCode = 0, output = 'built in 3s') =>
    notification('item/completed', { threadId: 'thread-1', item: {
      type: 'commandExecution', id, command, status: exitCode === 0 ? 'completed' : 'failed', exitCode, aggregatedOutput: output,
    } })
  const usage = (total: number, input: number) => notification('thread/tokenUsage/updated', {
    threadId: 'thread-1', tokenUsage: { total: { totalTokens: total }, last: { inputTokens: input, outputTokens: 5 } },
  })
  const capabilityServer = (value: string): NonNullable<TurnInput['mcpServers']> => [{
    ...attachedMcpServers[0]!, runtimeEnv: { MANOR_TEST_CAPABILITY: value },
  }]
  const until = async <T>(read: () => T[], count = 1): Promise<T[]> => {
    for (let attempt = 0; attempt < 200 && read().length < count; attempt++) await new Promise((resolve) => setTimeout(resolve, 5))
    return read()
  }

  /**
   * One driver whose first turn, Sage's in thread "main", runs a background build and
   * answers while it still runs. `rekey` answers for the capability registries.
   */
  async function parkedSession(rekey: (from: string, to: string) => 'rekeyed' | 'unknown' | 'conflict' = () => 'rekeyed') {
    const child = new FakeChild()
    let stdin = ''
    child.stdin.on('data', (chunk: Buffer) => { stdin += chunk.toString('utf8') })
    let spawns = 0
    const reported: LiveSessionEvent[] = []
    const rekeys: [string, string][] = []
    const driver = createCodexDriver({
      agents: () => [sage], personalSkillManifests: async () => [], timeoutMs: 5_000, idleTimeoutMs: 1_000,
      spawnFn: () => { spawns += 1; return child },
      onLiveSession: (event) => reported.push(event),
      rekeyCapability: (from, to) => { rekeys.push([from, to]); return rekey(from, to) },
    })
    const write = async (...lines: string[]) => {
      for (const line of lines) child.stdout.write(`${line}\n`)
      for (let index = 0; index < 4; index++) await tick()
    }
    const requests = () => stdin.split('\n').filter(Boolean).map((line) => JSON.parse(line) as { id?: number; method: string; params: Record<string, unknown> })
    const first = driver.startTurn(turnInput(sage, { live: true, mcpServers: capabilityServer('held-secret') }))
    const firstEvents = drain(first.events)
    await until(() => (spawns > 0 ? [spawns] : []))
    await tick()
    await write(JSON.stringify({ id: 0, result: {} }))
    await write(JSON.stringify({ id: 1, result: { thread: { id: 'thread-1' }, model: 'gpt-5.6-sol', serviceTier: null } }))
    await write(JSON.stringify({ id: 2, result: { turn: { id: 'turn-1' } } }))
    await write(
      shellStarted('shell-1', 'npm run build -- --token held-secret'),
      said('turn-1', 'msg-1', 'The build runs in the background.'), usage(105, 100), turnDone('turn-1'),
    )
    return { child, driver, write, requests, reported, rekeys, firstEvents, spawns: () => spawns }
  }

  it('ends a live turn at its answer and keeps the process while its background build runs', async () => {
    const { child, driver, firstEvents } = await parkedSession()
    const seen = await firstEvents
    expect(child.signals).toEqual([])
    expect(seen.filter((event) => event.type === 'tool_use' && event.toolCallId === 'shell-1')).toEqual([
      expect.not.objectContaining({ background: true }),
      expect.objectContaining({ background: true }),
    ])
    expect(seen.at(-1)).toEqual(expect.objectContaining({ type: 'result', text: 'The build runs in the background.' }))
    expect(driver.liveSession?.('main', sage.id)).toEqual({
      driver: 'codex', sessionId: 'thread-1', model: undefined, effort: 'high', wakeHeld: false,
      running: [{ toolCallId: 'shell-1', title: 'npm run build -- --token [redacted]', kind: 'command' }],
    })
    expect(JSON.stringify(seen)).not.toContain('held-secret')
  })

  it('settles the row through the session and asks for a wake when the build ends', async () => {
    const { write, requests, reported, firstEvents } = await parkedSession()
    await firstEvents
    await write(shellDone('shell-1', 'npm run build -- --token held-secret'))
    expect(reported).toEqual([
      { type: 'row', threadId: 'main', agentId: sage.id, event: { type: 'tool_result', toolCallId: 'shell-1', outcome: 'success' } },
      { type: 'wake', threadId: 'main', agentId: sage.id, ended: [{ toolCallId: 'shell-1', title: 'npm run build -- --token [redacted]', state: 'done' }] },
    ])
    // Codex never starts a turn by itself, and neither does the driver.
    expect(requests().filter((request) => request.method === 'turn/start')).toHaveLength(1)
  })

  it('attaches the next turn: re-keys its capabilities and hands Codex the output that ended', async () => {
    const { child, driver, write, requests, rekeys, firstEvents, spawns } = await parkedSession()
    await firstEvents
    await write(shellDone('shell-1', 'npm run build -- --token held-secret'))
    const second = driver.startTurn(turnInput(sage, {
      live: true, sessionId: 'thread-1', mcpServers: capabilityServer('fresh-secret'),
      catchUp: [{ id: 'evt_000009', ts: 9, type: 'user_message', text: 'Background work you started has ended.', mentions: [], source: 'background_wake' }],
      isFullCatchUp: false,
    }))
    const secondEvents = drain(second.events)
    await tick()
    expect(spawns()).toBe(1)
    expect(driver.liveSession?.('main', sage.id)).toBeUndefined()
    expect(rekeys).toEqual([['fresh-secret', 'held-secret']])
    const start = requests().filter((request) => request.method === 'turn/start').at(-1)
    expect(start?.id).toBeGreaterThanOrEqual(100)
    const text = JSON.stringify(start?.params['input'])
    expect(text).toContain('Background work you started has ended.')
    expect(text).toContain('Background command completed (exit 0): npm run build')
    expect(text).toContain('built in 3s')
    await write(JSON.stringify({ id: start?.id, result: { turn: { id: 'turn-2' } } }),
      notification('turn/started', { threadId: 'thread-1', turn: { id: 'turn-2' } }),
      said('turn-2', 'msg-2', 'The build passed.'), usage(150, 40), turnDone('turn-2'))
    expect(await until(() => child.signals)).toEqual(['SIGTERM'])
    child.stdout.end()
    child.emit('close', 0)
    const seen = await secondEvents
    expect(seen.filter((event) => event.type === 'error')).toEqual([])
    expect(seen.filter((event) => event.type === 'result')).toEqual([expect.objectContaining({
      text: 'The build passed.', usage: { inputTokens: 40, outputTokens: 5 }, sessionId: 'thread-1',
    })])
  })

  it('settles an earlier turn\'s row through the session and parks again with the wake still owed', async () => {
    const { driver, write, requests, reported, firstEvents } = await parkedSession()
    await firstEvents
    const second = driver.startTurn(turnInput(sage, { live: true, sessionId: 'thread-1', mcpServers: capabilityServer('fresh-secret') }))
    const secondEvents = drain(second.events)
    await tick()
    const start = requests().filter((request) => request.method === 'turn/start').at(-1)
    await write(JSON.stringify({ id: start?.id, result: { turn: { id: 'turn-2' } } }),
      notification('turn/started', { threadId: 'thread-1', turn: { id: 'turn-2' } }),
      shellDone('shell-1', 'npm run build -- --token held-secret'),
      said('turn-2', 'msg-2', 'Noted.'), turnDone('turn-2'))
    const seen = await secondEvents
    // The build belongs to the first turn: its end is not this turn's row.
    expect(seen.filter((event) => event.type === 'tool_result')).toEqual([])
    expect(reported).toEqual([
      expect.objectContaining({ type: 'row', event: expect.objectContaining({ toolCallId: 'shell-1', outcome: 'success' }) }),
      expect.objectContaining({ type: 'wake', ended: [expect.objectContaining({ toolCallId: 'shell-1', state: 'done' })] }),
    ])
    expect(driver.liveSession?.('main', sage.id)).toEqual(expect.objectContaining({ running: [] }))
  })

  it('ends the attached turn and its process when a held capability is still live', async () => {
    const { child, driver, requests, reported, firstEvents } = await parkedSession(() => 'conflict')
    await firstEvents
    const second = driver.startTurn(turnInput(sage, { live: true, sessionId: 'thread-1', mcpServers: capabilityServer('fresh-secret') }))
    const secondEvents = drain(second.events)
    await tick()
    expect(child.signals).toEqual(['SIGTERM'])
    child.emit('close', null)
    const seen = await secondEvents
    expect(seen.filter((event) => event.type === 'error')).toEqual([{ type: 'error', message: CODEX_REKEY_FAILED }])
    expect(requests().filter((request) => request.method === 'turn/start')).toHaveLength(1)
    expect(reported).toContainEqual(expect.objectContaining({
      type: 'row', event: { type: 'tool_result', toolCallId: 'shell-1', outcome: 'stopped' },
    }))
  })

  it('Stop on an attached turn takes the process down and stops what an earlier turn left running', async () => {
    const { child, driver, write, requests, reported, firstEvents } = await parkedSession()
    await firstEvents
    const second = driver.startTurn(turnInput(sage, { live: true, sessionId: 'thread-1', mcpServers: capabilityServer('fresh-secret') }))
    const secondEvents = drain(second.events)
    await tick()
    const start = requests().filter((request) => request.method === 'turn/start').at(-1)
    await write(JSON.stringify({ id: start?.id, result: { turn: { id: 'turn-2' } } }),
      notification('turn/started', { threadId: 'thread-1', turn: { id: 'turn-2' } }))
    second.stop()
    await write(JSON.stringify({ id: 99, result: {} }),
      notification('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-2', status: 'interrupted', error: null, items: [] } }))
    expect(child.signals).toEqual(['SIGTERM'])
    child.emit('close', null)
    await secondEvents
    expect(reported).toContainEqual(expect.objectContaining({
      type: 'row', event: { type: 'tool_result', toolCallId: 'shell-1', outcome: 'stopped' },
    }))
    expect(driver.liveSession?.('main', sage.id)).toBeUndefined()
  })

  it('closes on request or when the process exits, settling what still ran as stopped', async () => {
    const closing = await parkedSession()
    await closing.firstEvents
    expect(closing.driver.closeLiveSession?.('main')).toEqual(['npm run build -- --token [redacted]'])
    expect(closing.child.signals).toEqual(['SIGTERM'])
    expect(closing.reported).toEqual([
      { type: 'row', threadId: 'main', agentId: sage.id, event: { type: 'tool_result', toolCallId: 'shell-1', outcome: 'stopped' } },
      { type: 'closed', threadId: 'main', agentId: sage.id },
    ])
    expect(closing.driver.liveSession?.('main', sage.id)).toBeUndefined()

    const exiting = await parkedSession()
    await exiting.firstEvents
    exiting.child.emit('close', 1)
    await until(() => exiting.reported, 2)
    expect(exiting.reported).toEqual([
      expect.objectContaining({ type: 'row', event: expect.objectContaining({ toolCallId: 'shell-1', outcome: 'stopped' }) }),
      { type: 'closed', threadId: 'main', agentId: sage.id },
    ])
    expect(exiting.driver.liveSession?.('main', sage.id)).toBeUndefined()
  })

  it('refuses a compaction next to a live session', async () => {
    const { driver, firstEvents } = await parkedSession()
    await firstEvents
    const compact = driver.compactSession?.({
      agent: sage, sessionId: 'thread-1', threadId: 'main', cwd: scratch, repoPaths: [],
    })
    const seen = compact === undefined ? [] : await drain(compact.events)
    expect(seen).toEqual([{ type: 'error', message: 'This session is still running background work; it cannot be compacted now.' }])
  })
})

describe('CodexStreamParser', () => {
  it('reports each request’s prompt size and window mid-turn, never the running total', () => {
    const parser = new CodexStreamParser()
    parser.acceptThreadResponse({ thread: { id: 'thread-1' }, model: 'gpt-5.6-sol' })
    const usage = (last: number, total: number) => notification('thread/tokenUsage/updated', {
      threadId: 'thread-1', turnId: 'turn-1',
      tokenUsage: {
        last: { inputTokens: last, cachedInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0, totalTokens: last + 10 },
        total: { inputTokens: total, cachedInputTokens: 0, outputTokens: 20, reasoningOutputTokens: 0, totalTokens: total + 20 },
        modelContextWindow: 258_000,
      },
    })
    expect(parser.handle(usage(40_000, 40_000))).toEqual([{ type: 'context', contextTokens: 40_000, contextWindow: 258_000 }])
    expect(parser.handle(usage(52_000, 92_000))).toEqual([{ type: 'context', contextTokens: 52_000, contextWindow: 258_000 }])
    // A repeated notification is the same request, not a new reading.
    expect(parser.handle(usage(52_000, 92_000))).toEqual([])
  })

  it('brackets the CLI’s own compaction mid-turn and never ends the turn on it', () => {
    const parser = new CodexStreamParser()
    parser.acceptThreadResponse({ thread: { id: 'thread-1' }, model: 'gpt-5.6-sol' })
    const item = { type: 'contextCompaction', id: 'compact-1' }
    expect(parser.handle(notification('item/started', { threadId: 'thread-1', item }))).toEqual([{ type: 'compaction', phase: 'start' }])
    expect(parser.handle(notification('item/completed', { threadId: 'thread-1', item }))).toEqual([{ type: 'compaction', phase: 'end' }])
    // The deprecated twin after the item is no second end, and above all no result.
    expect(parser.handle(notification('thread/compacted', { threadId: 'thread-1', turnId: 'turn-1' }))).toEqual([])
    // A helper's compaction is its own business.
    expect(parser.handle(notification('item/started', { threadId: 'child', item }))).toEqual([])
  })

  it('still answers Manor’s own compact request with the compacted thread', () => {
    const parser = new CodexStreamParser(true)
    parser.acceptThreadResponse({ thread: { id: 'thread-1' }, model: 'gpt-5.6-sol' })
    expect(parser.handle(notification('thread/compacted', { threadId: 'thread-1', turnId: 'turn-1' }))).toEqual([
      { type: 'result', text: '', sessionId: 'thread-1' },
    ])
  })

  it('hides the expected host skill warning while showing other Codex warnings', () => {
    const parser = new CodexStreamParser()
    for (const method of ['warning', 'configWarning']) {
      expect(parser.handle(notification(method, {
        message: 'Under-development features enabled: skip_host_skill_discovery. This feature may change.',
      }))).toEqual([])
    }
    expect(parser.handle(notification('warning', { message: 'A different warning' }))).toEqual([
      { type: 'tool_use', tool: 'codex', detail: 'A different warning' },
    ])
  })

  it('shows a stream Codex is retrying as working, and fails only on the error it gives up on', () => {
    const parser = new CodexStreamParser()
    expect(parser.handle(notification('error', { willRetry: true, error: { message: 'Reconnecting... 2/5' } }))).toEqual([
      { type: 'tool_use', tool: 'codex', toolCallId: 'codex-retry-1', detail: 'Connection dropped, Codex is retrying (attempt 2 of 5)' },
    ])
    // The next retry replaces the row rather than leaving two running.
    expect(parser.handle(notification('error', { willRetry: true, error: { message: 'stream disconnected' } }))).toEqual([
      { type: 'tool_result', toolCallId: 'codex-retry-1', outcome: 'success' },
      { type: 'tool_use', tool: 'codex', toolCallId: 'codex-retry-2', detail: 'Connection dropped, Codex is retrying' },
    ])
    // Whatever Codex says next closes it, so a recovered answer is not shown as still retrying.
    const recovered = parser.handle(notification('warning', { message: 'Back online' }))
    expect(recovered[0]).toEqual({ type: 'tool_result', toolCallId: 'codex-retry-2', outcome: 'success' })
    expect(parser.handle(notification('error', { willRetry: false, error: { message: 'gave up' } }))).toEqual([])
  })

  it('keeps native helper events out of the parent session and reply', () => {
    const parser = new CodexStreamParser()
    parser.acceptThreadResponse({ thread: { id: 'thread-1' }, model: 'parent-model' })
    parser.acceptTurnResponse({ turn: { id: 'turn-1' } })
    const childEvents = [
      notification('thread/started', { thread: { id: 'child' } }),
      notification('turn/started', { threadId: 'child', turn: { id: 'child-turn' } }),
      ...successfulNotifications('Child answer').map((line) => line.replaceAll('thread-1', 'child')),
      notification('error', { threadId: 'child', error: { message: 'Child failed' } }),
    ]
    for (const event of childEvents) expect(parser.handle(event)).toEqual([])
    expect(parser.sessionId).toBe('thread-1')
    expect(parser.turnId).toBe('turn-1')
    const events = successfulNotifications('Parent answer').flatMap((line) => parser.handle(line))
    expect(events.at(-1)).toMatchObject({
      type: 'result', sessionId: 'thread-1', text: 'Parent answer', reportedModel: 'parent-model',
    })
  })

  it('links child thread activity to the spawning call while keeping its reply separate', () => {
    const parser = new CodexStreamParser()
    parser.acceptThreadResponse({ thread: { id: 'thread-1' }, model: 'parent-model' })
    parser.acceptTurnResponse({ turn: { id: 'turn-1' } })
    expect(parser.handle(notification('item/started', { threadId: 'thread-1', item: {
      type: 'collabAgentToolCall', id: 'spawn-1', tool: 'spawnAgent', prompt: 'Inspect parsing',
      model: 'gpt-6-luna', reasoningEffort: 'high',
    } }))).toEqual([{
      type: 'tool_use', toolCallId: 'spawn-1', tool: 'spawn_subagent', subject: 'Inspect parsing',
      subagent: { title: 'Inspect parsing', prompt: 'Inspect parsing' },
    }])
    expect(parser.handle(notification('item/updated', { threadId: 'thread-1', item: {
      type: 'collabAgentToolCall', id: 'spawn-1', tool: 'spawnAgent', receiverThreadIds: ['child-1'],
    } }))).toEqual([])
    expect(parser.handle(notification('item/completed', { threadId: 'thread-1', item: {
      type: 'collabAgentToolCall', id: 'spawn-1', tool: 'spawnAgent', status: 'completed',
    } }))).toEqual([])
    expect(parser.handle(notification('item/started', { threadId: 'child-1', item: {
      type: 'commandExecution', id: 'child-command', command: 'pwd', status: 'inProgress',
    } }))).toEqual([expect.objectContaining({
      type: 'tool_use', toolCallId: 'child-command', parentToolCallId: 'spawn-1', tool: 'Shell',
    })])
    expect(parser.handle(notification('item/completed', { threadId: 'child-1', item: {
      type: 'commandExecution', id: 'child-command', command: 'pwd', status: 'completed', exitCode: 0,
    } }))).toEqual([{
      type: 'tool_result', toolCallId: 'child-command', parentToolCallId: 'spawn-1', outcome: 'success',
    }])
    expect(parser.handle(notification('item/completed', { threadId: 'child-1', item: {
      type: 'agentMessage', id: 'child-reply', text: 'Child answer',
    } }))).toEqual([])
    expect(parser.handle(notification('turn/completed', {
      threadId: 'child-1', turn: { id: 'child-turn', status: 'completed' },
    }))).toEqual([{ type: 'tool_result', toolCallId: 'spawn-1', outcome: 'success', output: 'Child answer' }])
    expect(parser.handle(notification('item/completed', { threadId: 'thread-1', item: {
      type: 'collabAgentToolCall', id: 'spawn-1', tool: 'spawnAgent', status: 'completed',
    } }))).toEqual([])
    expect(parser.sessionId).toBe('thread-1')
    expect(parser.turnId).toBe('turn-1')
  })

  it('shows Codex subagent activity items and links the child thread', () => {
    const parser = new CodexStreamParser()
    parser.acceptThreadResponse({ thread: { id: 'thread-1' } })
    const started = {
      type: 'subAgentActivity', id: 'spawn-1', kind: 'started',
      agentThreadId: 'child-1', agentPath: '/root/read_manor_files',
    }
    expect(parser.handle(notification('item/started', { threadId: 'thread-1', item: started }))).toEqual([{
      type: 'tool_use', toolCallId: 'spawn-1', tool: 'spawn_subagent', subject: 'read manor files',
      subagent: { title: 'read manor files' },
    }])
    expect(parser.handle(notification('item/completed', { threadId: 'thread-1', item: started }))).toEqual([])
    expect(parser.handle(notification('item/started', { threadId: 'child-1', item: {
      type: 'commandExecution', id: 'child-command', command: 'pwd', status: 'inProgress',
    } }))).toEqual([expect.objectContaining({
      type: 'tool_use', toolCallId: 'child-command', parentToolCallId: 'spawn-1', tool: 'Shell',
    })])
    expect(parser.handle(notification('turn/completed', {
      threadId: 'child-1', turn: { id: 'child-turn', status: 'completed' },
    }))).toEqual([])
    const completed = { ...started, id: 'activity-done', kind: 'completed' }
    expect(parser.handle(notification('item/completed', { threadId: 'thread-1', item: completed }))).toEqual([{
      type: 'tool_result', toolCallId: 'spawn-1', outcome: 'success',
    }])
    expect(parser.handle(notification('item/completed', { threadId: 'thread-1', item: completed }))).toEqual([])

    const interrupted = new CodexStreamParser()
    interrupted.acceptThreadResponse({ thread: { id: 'thread-1' } })
    interrupted.handle(notification('item/completed', { threadId: 'thread-1', item: started }))
    expect(interrupted.handle(notification('item/completed', { threadId: 'thread-1', item: {
      ...started, id: 'activity-stopped', kind: 'interrupted',
    } }))).toEqual([{ type: 'tool_result', toolCallId: 'spawn-1', outcome: 'error' }])
  })

  it('does not report a Codex helper as done before its child turn settles', () => {
    const parser = new CodexStreamParser()
    parser.acceptThreadResponse({ thread: { id: 'thread-1' } })
    const spawn = { type: 'collabAgentToolCall', id: 'spawn-1', tool: 'spawnAgent', receiverThreadIds: ['child-1'] }
    expect(parser.handle(notification('item/started', { threadId: 'thread-1', item: spawn }))).toHaveLength(1)
    expect(parser.handle(notification('item/completed', { threadId: 'thread-1', item: { ...spawn, status: 'completed' } }))).toEqual([])
    expect(parser.handle(notification('turn/completed', {
      threadId: 'child-1', turn: { id: 'child-turn', status: 'failed', error: { message: 'usage limit reached' } },
    }))).toEqual([{ type: 'tool_result', toolCallId: 'spawn-1', outcome: 'error', error: 'usage limit reached' }])
  })

  it('reports a shell command that outlived its turn with its exit code and output tail', () => {
    const parser = new CodexStreamParser()
    parser.acceptThreadResponse({ thread: { id: 'thread-1' } })
    const shell = { type: 'commandExecution', id: 'shell-1', command: '/bin/zsh -lc \'npm run build\'' }
    parser.handle(notification('item/started', { threadId: 'thread-1', item: { ...shell, status: 'inProgress' } }))
    parser.handle(completedTurn())
    expect([...parser.backgroundWork.values()]).toEqual(["/bin/zsh -lc 'npm run build'"])
    parser.handle(notification('item/completed', { threadId: 'thread-1', item: {
      ...shell, status: 'completed', exitCode: 0, aggregatedOutput: `${'x'.repeat(1_200)}built in 4s\n`,
    } }))
    expect(parser.backgroundWork.size).toBe(0)
    const [report] = parser.takeUnreported()
    expect(report).toMatch(/^Background command completed \(exit 0\): \/bin\/zsh -lc 'npm run build'\n\nOutput tail:\n\.\.\.x+built in 4s$/)
    expect(report?.length).toBeLessThan(1_300)
    expect(parser.takeUnreported()).toEqual([])
  })

  it('ignores stdout noise and unknown notifications', () => {
    const parser = new CodexStreamParser()
    expect(parser.handle('not json')).toEqual([])
    expect(parser.handle(notification('future/event', { value: true }))).toEqual([])
  })
})
