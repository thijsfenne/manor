import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ServerMessage } from '@manor/contracts'
import { describe, expect, it } from 'vitest'
import { createAutoRulesFile } from '../src/autoRules.js'
import { createMockDriver } from '../src/drivers/mockDriver.js'
import { ManorService } from '../src/service.js'
import { createMemoryStore } from '../src/stores/memoryStore.js'
import { roster, scratchFor } from './helpers.js'

const valid = {
  routine: { description: 'Small mechanical edits', driver: 'codex', model: 'gpt-6-luna', effort: 'high' },
  exploration: { description: 'Trace how something works', driver: 'cursor', model: 'cursor-grok-4.6', effort: 'xhigh', speed: 'fast' },
} as const

function tempRules(initial: unknown = valid) {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'manor-auto-rules-')), 'auto-runtime.json')
  writeFileSync(file, JSON.stringify(initial))
  return { file, rules: createAutoRulesFile(file), onDisk: () => readFileSync(file, 'utf8') }
}

function service(autoRules: ReturnType<typeof createAutoRulesFile>) {
  const broadcast: ServerMessage[] = []
  const replies: ServerMessage[] = []
  const manor = new ManorService({
    store: createMemoryStore({ agents: roster }),
    agents: () => roster,
    setAgents: () => {},
    mcpServers: () => [],
    setMcpServers: () => {},
    resolveDriver: () => createMockDriver({ deltaDelayMs: 0 }),
    ensureScratchDir: scratchFor,
    broadcast: (message) => broadcast.push(message),
    hostEnv: {},
    autoRules,
  })
  return { manor, broadcast, replies, reply: (message: ServerMessage) => replies.push(message) }
}

describe('Auto rule file', () => {
  it('answers get_auto_rules with the file as the selector reads it', async () => {
    const { rules } = tempRules()
    const { manor, replies, reply } = service(rules)
    await manor.handle({ type: 'get_auto_rules', requestId: 'load' }, reply)
    expect(replies).toEqual([{ type: 'auto_rules', rules: valid, requestId: 'load' }])
  })

  it('saves a valid replacement atomically, acks the asker and broadcasts the new rules', async () => {
    const { rules, onDisk } = tempRules()
    const { manor, broadcast, replies, reply } = service(rules)
    const next = { hardest: { description: 'Difficult architecture', driver: 'claude', model: 'claude-fable-5-2', effort: 'high' } }
    await manor.handle({ type: 'save_auto_rules', rules: next, requestId: 'save' }, reply)
    expect(replies).toEqual([{ type: 'ack', requestId: 'save' }])
    expect(broadcast).toEqual([{ type: 'auto_rules', rules: next }])
    expect(JSON.parse(onDisk())).toEqual(next)
    await expect(rules.read()).resolves.toEqual(next)
  })

  it.each([
    ['a model from another provider', { task: { description: 'Task', driver: 'claude', model: 'gpt-6-luna', effort: 'low' } }, 'task.model'],
    ['fast on a model without it', { task: { description: 'Task', driver: 'grok', model: 'grok-4.6', effort: 'high', speed: 'fast' as const } }, 'task.speed'],
    ['the reserved defer key', { defer: { description: 'Task', driver: 'codex', model: 'gpt-6-luna', effort: 'low' } }, 'defer'],
    ['the mock runtime', { task: { description: 'Task', driver: 'mock', model: 'mock', effort: 'low' } }, 'task.driver'],
    ['no rules at all', {}, ''],
  ])('refuses %s with the reason and leaves the file untouched', async (_name, invalid, where) => {
    const { rules, onDisk } = tempRules()
    const before = onDisk()
    const { manor, broadcast, replies, reply } = service(rules)
    await manor.handle({ type: 'save_auto_rules', rules: invalid, requestId: 'save' }, reply)
    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({ type: 'notice', kind: 'error', requestId: 'save' })
    if (where) expect(replies[0]).toMatchObject({ text: expect.stringContaining(where) })
    expect(broadcast).toEqual([])
    expect(onDisk()).toBe(before)
  })

  it('reports a missing or malformed file instead of answering with nothing', async () => {
    const { rules } = tempRules('{')
    const { manor, replies, reply } = service(rules)
    await manor.handle({ type: 'get_auto_rules', requestId: 'load' }, reply)
    expect(replies[0]).toMatchObject({ type: 'notice', kind: 'error', requestId: 'load' })
  })
})
