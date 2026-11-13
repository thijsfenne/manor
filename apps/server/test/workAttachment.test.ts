import type { TurnInput } from '@manor/contracts'
import { describe, expect, it } from 'vitest'
import { buildArgs, buildMcpArgs } from '../src/drivers/claudeDriver.js'
import { buildCodexMcpArgs } from '../src/drivers/codexDriver.js'
import { buildCursorArgs } from '../src/drivers/cursorDriver.js'
import { buildGrokArgs } from '../src/drivers/grokDriver.js'
import { workMcpAttachment } from '../src/mcp/workAttachment.js'
import { sage } from './helpers.js'

describe('the built-in Work MCP attachment', () => {
  it('keeps the turn capability out of provider argv and approves only start_work', () => {
    const attachment = workMcpAttachment(
      'http://127.0.0.1:8787/internal/work-tool',
      'secret-turn-capability',
    )

    expect(attachment.server).toMatchObject({
      id: 'builtin_work',
      name: 'work',
      writes: true,
      effectPolicy: 'trusted' as const,
      tools: ['start_work'],
    })
    expect(attachment.runtimeEnv).toEqual({ MANOR_WORK_BROKER_CAPABILITY: 'secret-turn-capability' })
    expect(buildMcpArgs([attachment]).join(' ')).not.toContain('secret-turn-capability')
    const codex = buildCodexMcpArgs([attachment]).join(' ')
    expect(codex).not.toContain('secret-turn-capability')
    expect(codex).toContain('enabled_tools=["start_work"]')
    expect(codex).toContain('approval_mode="approve"')
  })

  it('grants the attached write tool through every provider adapter', () => {
    const attached = workMcpAttachment(
      'http://127.0.0.1:8787/internal/work-tool',
      'secret-turn-capability',
    )
    const input: TurnInput = {
      agent: sage,
      threadId: 'chat_1',
      cwd: '/tmp/manor-test/chat_1',
      repoPaths: [],
      catchUp: [],
      isFullCatchUp: true,
      mcpServers: [attached],
    }

    expect(buildArgs(input)).toContain('--mcp-config')
    expect(buildCodexMcpArgs([attached]).join(' ')).toContain('enabled_tools=["start_work"]')
    expect(buildGrokArgs(input).join(' ')).toContain('search_tool,use_tool')
    expect(buildCursorArgs(input, input.cwd)).toEqual(expect.arrayContaining([
      '--force', '--sandbox', 'disabled',
    ]))
  })
})
