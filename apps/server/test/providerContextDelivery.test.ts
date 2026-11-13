import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { driverForModel, KNOWN_MODELS, type AgentConfig, type TurnInput } from '@manor/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildArgs } from '../src/drivers/claudeDriver.js'
import { buildCodexAppServerArgs, buildCodexThreadRequest, ensureAgentDir } from '../src/drivers/codexDriver.js'
import { buildCursorArgs, ensureCursorAgentDir } from '../src/drivers/cursorDriver.js'
import { buildGrokArgs, ensureGrokAgentDir } from '../src/drivers/grokDriver.js'

// The old Codex byte limit cuts this inside the body, before the memory facts.
const longContext = `Persona instructions.\n${'Knowledge work, café, 日本語.\n'.repeat(2_500)}\nStanding memory: the launch is Thursday.\nFINAL_CONTEXT_MARKER`
const updatedContext = 'Persona instructions. Memory is off.\nCURRENT_CONTEXT_MARKER'
let scratch: string

beforeAll(async () => { scratch = await mkdtemp(path.join(os.tmpdir(), 'manor-context-delivery-')) })
afterAll(async () => { await rm(scratch, { recursive: true, force: true }) })

const providers = ['claude', 'codex', 'grok', 'cursor'] as const

describe.each(providers)('%s context delivery', (driver) => {
  const models = [undefined, ...KNOWN_MODELS.filter((model) => driverForModel(model) === driver), 'future-model']

  it.each(models)('preserves long context and its replacement for model %s', async (model) => {
    const agent: AgentConfig = {
      id: `${driver}-${model ?? 'default'}`, name: 'Context probe', driver, model,
      character: longContext, color: '#000000', effort: 'high', allowedTools: [],
      mcpServers: [], memoryScope: true, role: 'Generalist', description: '', isCos: false,
    }
    const original: TurnInput = {
      agent, threadId: 'probe', cwd: scratch, repoPaths: [], isFullCatchUp: true,
      catchUp: [{ id: 'question', ts: 1, type: 'user_message', text: 'What is the launch day?', mentions: [] }],
    }
    const resumed: TurnInput = {
      ...original, agent: { ...agent, character: updatedContext, memoryScope: false },
      sessionId: 'existing-session', isFullCatchUp: false,
    }
    for (const input of [original, resumed]) {
      let delivered: string
      let args: string[]
      if (driver === 'codex') {
        const dir = await ensureAgentDir(input.cwd, input.agent)
        const file = await readFile(path.join(dir, 'AGENTS.md'))
        args = buildCodexAppServerArgs(input)
        const configured = args.find((arg) => arg.startsWith('project_doc_max_bytes='))
        const budget = configured === undefined ? 32_768 : Number(configured.split('=')[1])
        expect(budget).toBeGreaterThanOrEqual(file.byteLength)
        delivered = file.subarray(0, budget).toString('utf8')
        expect(buildCodexThreadRequest(input, dir).method).toBe(input.sessionId ? 'thread/resume' : 'thread/start')
      } else if (driver === 'cursor') {
        const dir = await ensureCursorAgentDir(input.cwd, input.agent, [])
        delivered = await readFile(path.join(dir, 'AGENTS.md'), 'utf8')
        args = buildCursorArgs(input, dir)
      } else if (driver === 'grok' && model === 'grok-4.5') {
        const dir = await ensureGrokAgentDir(input.cwd, input.agent, [])
        delivered = await readFile(path.join(dir, 'AGENTS.md'), 'utf8')
        args = buildGrokArgs(input)
        expect(args).not.toContain('--system-prompt-override')
      } else {
        args = driver === 'claude' ? buildArgs(input) : buildGrokArgs(input)
        const flag = driver === 'claude' ? '--system-prompt' : '--system-prompt-override'
        delivered = args[args.indexOf(flag) + 1] ?? ''
        if (driver === 'claude') expect(args[args.indexOf('--system-prompt-snapshot') + 1]).toBe('off')
      }
      expect(delivered.trimEnd()).toBe(input.agent.character)
      if (input.sessionId !== undefined) {
        expect(delivered).not.toContain('FINAL_CONTEXT_MARKER')
        expect(delivered).not.toContain('Standing memory:')
        if (driver !== 'codex') expect(args[args.indexOf('--resume') + 1]).toBe(input.sessionId)
      }
    }
  })
})

it('keeps two personas in one room isolated when their context is replaced', async () => {
  const agent: AgentConfig = {
    id: 'first', name: 'First', character: longContext, driver: 'codex', effort: 'high',
    color: '#000000', allowedTools: [], mcpServers: [], memoryScope: true,
    role: 'Generalist', description: '', isCos: false,
  }
  for (const prepare of [
    ensureAgentDir,
    (cwd: string, persona: AgentConfig) => ensureCursorAgentDir(cwd, persona, []),
    (cwd: string, persona: AgentConfig) => ensureGrokAgentDir(cwd, { ...persona, model: 'grok-4.5' }, []),
  ]) {
    const first = await prepare(scratch, agent)
    const second = await prepare(scratch, { ...agent, id: 'second', character: 'Second persona only.' })
    await prepare(scratch, { ...agent, character: updatedContext, memoryScope: false })
    expect(await readFile(path.join(first, 'AGENTS.md'), 'utf8')).toBe(`${updatedContext}\n`)
    expect(await readFile(path.join(second, 'AGENTS.md'), 'utf8')).toBe('Second persona only.\n')
  }
})
