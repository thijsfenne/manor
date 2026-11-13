import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { AgentConfig } from '@manor/contracts'
import { createClaudeDriver } from '../src/drivers/claudeDriver.js'

/**
 * Real-CLI check for the client label Manor sets, which leans on a Claude CLI variable
 * outside the documented surface. Run after every Claude CLI update:
 * `pnpm check:claude-entrypoint [--model <id>]`.
 *
 * Two Haiku turns with a linked folder go through the real driver, one with the label
 * switched off and one with Manor's default. Each runs a short shell command, so a request the CLI sends
 * on the side has time to land. Both turns must report the same built-in tools, and
 * the labelled turn may not read more tokens over all its requests. A failure means
 * the CLI gates something new on the label.
 */

const modelAt = process.argv.indexOf('--model')
const model = modelAt === -1 ? 'claude-haiku-5-5' : process.argv[modelAt + 1] ?? 'claude-haiku-5-5'

/** A side request weighs over a thousand tokens; two runs of one instruction differ by far less. */
const SLACK_TOKENS = 500

interface Observed {
  tools: string[]
  /** Prompt tokens over every request of the turn, side requests included. */
  promptTokens: number
  label: string | undefined
}

const agent: AgentConfig = {
  id: 'probe', name: 'Probe', color: '#888888', driver: 'claude', model, effort: 'low',
  allowedTools: [], mcpServers: [], memoryScope: false, role: '', description: '', isCos: false,
  character: 'You are a terse assistant in a test harness. Follow the instruction exactly.',
}

const dir = await mkdtemp(path.join(os.tmpdir(), 'manor-entrypoint-'))
const linked = await mkdtemp(path.join(os.tmpdir(), 'manor-entrypoint-folder-'))
try {
  const turn = async (labelled: boolean): Promise<Observed> => {
    if (labelled) delete process.env.MANOR_CLAUDE_ENTRYPOINT
    else process.env.MANOR_CLAUDE_ENTRYPOINT = ''
    const observed: Observed = { tools: [], promptTokens: 0, label: undefined }
    const driver = createClaudeDriver({
      agents: () => [agent],
      timeoutMs: 120_000,
      spawnFn: (command, args, options) => {
        observed.label = options.env?.CLAUDE_CODE_ENTRYPOINT
        const child = spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] })
        let buffer = ''
        child.stdout.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf8')
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            const event = JSON.parse(line) as {
              type?: string; subtype?: string; tools?: string[]
              modelUsage?: Record<string, { inputTokens?: number; cacheCreationInputTokens?: number; cacheReadInputTokens?: number }>
            }
            if (event.type === 'system' && event.subtype === 'init') observed.tools = [...(event.tools ?? [])].sort()
            if (event.type === 'result') {
              observed.promptTokens = Object.values(event.modelUsage ?? {}).reduce((sum, used) =>
                sum + (used.inputTokens ?? 0) + (used.cacheCreationInputTokens ?? 0) + (used.cacheReadInputTokens ?? 0), 0)
            }
          }
        })
        return child
      },
    })
    const handle = driver.startTurn({
      agent, threadId: 'entrypoint-check', cwd: dir, repoPaths: [linked], isFullCatchUp: true, infrastructure: true,
      catchUp: [{ id: 'evt_000001', ts: Date.now(), type: 'user_message', text: 'Run the shell command `sleep 8` with the Bash tool, then reply with only the word ok.', mentions: [] }],
    })
    for await (const event of handle.events) if (event.type === 'error') throw new Error(event.message)
    return observed
  }

  const plain = await turn(false)
  const labelled = await turn(true)
  console.log(JSON.stringify({ model, plain: { tools: plain.tools.length, promptTokens: plain.promptTokens }, labelled: { tools: labelled.tools.length, promptTokens: labelled.promptTokens } }, null, 2))
  assert.equal(plain.label, undefined, 'The plain turn carried a label')
  assert.equal(labelled.label, 'manor', 'The label did not reach the CLI')
  assert.ok(plain.tools.length > 0, 'The CLI reported no tools at init')
  assert.ok(plain.promptTokens > 0 && labelled.promptTokens > 0, 'A turn reported no usage')
  assert.deepEqual(labelled.tools, plain.tools, 'The label changed the toolset')
  assert.ok(labelled.promptTokens <= plain.promptTokens + SLACK_TOKENS, `The label grew the turn from ${plain.promptTokens} to ${labelled.promptTokens} tokens`)
  console.log('The entrypoint label leaves the toolset and the turn size alone on this CLI.')
} finally {
  delete process.env.MANOR_CLAUDE_ENTRYPOINT
  await rm(dir, { recursive: true, force: true })
  await rm(linked, { recursive: true, force: true })
}
