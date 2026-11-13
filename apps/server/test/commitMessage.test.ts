import type { TurnInput } from '@manor/contracts'
import { describe, expect, it } from 'vitest'
import { COMMIT_MESSAGE_FALLBACK_MODEL, COMMIT_MESSAGE_MODEL, createCommitMessageWriter } from '../src/commitMessage.js'
import { scratchFor, scripted } from './helpers.js'

describe('commit message writer', () => {
  it('runs on Haiku 5.5 with no tools and no MCP, and reads the diff it is handed', async () => {
    const seen: TurnInput[] = []
    const write = createCommitMessageWriter({
      attempts: [{ driver: scripted(() => [{ type: 'result', text: '"Hide empty projects."' }], seen), runtime: 'claude', model: COMMIT_MESSAGE_MODEL }],
      ensureScratchDir: scratchFor,
    })

    await expect(write('chat_1', 'diff --git a/x b/x')).resolves.toBe('Hide empty projects')
    expect(seen[0]?.agent).toMatchObject({ driver: 'claude', model: 'claude-haiku-5-5', allowedTools: [], mcpServers: [], memoryScope: false })
    expect(seen[0]?.repoPaths).toEqual([])
  })

  it('hands the message to Luna when Claude cannot answer', async () => {
    const seen: TurnInput[] = []
    const claude = scripted(() => [{ type: 'error', message: 'provider unavailable' }], seen)
    const write = createCommitMessageWriter({
      attempts: [
        { driver: claude, runtime: 'claude', model: COMMIT_MESSAGE_MODEL },
        { driver: scripted(() => [{ type: 'result', text: 'Add a thing' }], seen), runtime: 'codex', model: COMMIT_MESSAGE_FALLBACK_MODEL },
      ],
      ensureScratchDir: scratchFor,
    })

    await expect(write('chat_1', 'diff')).resolves.toBe('Add a thing')
    expect(seen.map((input) => input.agent.model)).toEqual(['claude-haiku-5-5', 'gpt-6-luna'])
  })
})
