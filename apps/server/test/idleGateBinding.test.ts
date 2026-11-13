import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import type { AgentConfig, Driver, RuntimeEvent, TurnInput } from '@manor/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClaudeDriver } from '../src/drivers/claudeDriver.js'
import { createCodexDriver } from '../src/drivers/codexDriver.js'
import { createGrokDriver } from '../src/drivers/grokDriver.js'
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

let scratch: string
const previousGrokHome = process.env.MANOR_GROK_HOME
const previousCodexHome = process.env.MANOR_CODEX_HOME

beforeAll(() => {
  scratch = mkdtempSync(path.join(os.tmpdir(), 'manor-idle-gate-'))
  process.env.MANOR_GROK_HOME = mkdtempSync(path.join(os.tmpdir(), 'manor-idle-grok-'))
  process.env.MANOR_CODEX_HOME = mkdtempSync(path.join(os.tmpdir(), 'manor-idle-codex-'))
})

afterAll(() => {
  if (previousGrokHome === undefined) delete process.env.MANOR_GROK_HOME
  else process.env.MANOR_GROK_HOME = previousGrokHome
  if (previousCodexHome === undefined) delete process.env.MANOR_CODEX_HOME
  else process.env.MANOR_CODEX_HOME = previousCodexHome
})

const turnInput = (): TurnInput => ({
  agent: sage,
  threadId: 'chat_1',
  cwd: scratch,
  catchUp: [{ id: 'evt_1', ts: 1, type: 'user_message', text: 'hi', mentions: ['sage'] }],
  isFullCatchUp: true,
  repoPaths: [],
})

async function drain(events: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const collected: RuntimeEvent[] = []
  for await (const event of events) collected.push(event)
  return collected
}

const factories: [string, (idleGate: TurnIdleGate, spawnFn: () => FakeChild) => Driver][] = [
  [
    'claude',
    (idleGate, spawnFn) =>
      createClaudeDriver({ agents: () => [sage], spawnFn, idleGate, idleTimeoutMs: 40, timeoutMs: 10_000 }),
  ],
  [
    'grok',
    (idleGate, spawnFn) =>
      createGrokDriver({ agents: () => [sage], spawnFn, idleGate, idleTimeoutMs: 40, timeoutMs: 10_000 }),
  ],
  [
    'codex',
    (idleGate, spawnFn) =>
      createCodexDriver({ agents: () => [sage], spawnFn, idleGate, idleTimeoutMs: 40, timeoutMs: 10_000 }),
  ],
]

describe('driver idle-gate binding', () => {
  it.each(factories)('%s pauses its idle clock when the gate holds this turn', async (_name, create) => {
    const child = new FakeChild()
    const gate = new TurnIdleGate()
    gate.hold('chat_1', 'sage')
    const handle = create(gate, () => child).startTurn(turnInput())
    const collected = drain(handle.events)

    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(child.killed).toBe(false)
    handle.stop()

    const quiet = (await collected).filter(
      (event) => event.type === 'error' && event.message.includes('went quiet'),
    )
    expect(quiet).toEqual([])
  })
})
