import type { AgentConfig, TurnInput } from '@manor/contracts'
import { describe, expect, it } from 'vitest'
import { buildArgs } from '../src/drivers/claudeDriver.js'
import { buildCodexAppServerArgs, buildCodexTurnRequest } from '../src/drivers/codexDriver.js'
import { buildCursorArgs, buildCursorMcpConfig } from '../src/drivers/cursorDriver.js'
import { buildGrokArgs, buildGrokMcpConfig } from '../src/drivers/grokDriver.js'
import { skillMcpAttachment } from '../src/mcp/skillAttachment.js'

const attachment = skillMcpAttachment(
  'http://127.0.0.1:8787/internal/skill-file',
  'opaque-capability',
)

const agent = (driver: AgentConfig['driver']): AgentConfig => ({
  id: 'sage',
  name: 'Sage',
  color: '#6FA8A0',
  driver,
  effort: 'high',
  allowedTools: [],
  mcpServers: [],
  memoryScope: false,
  role: 'Generalist',
  description: '',
  isCos: false,
  character: 'You are Sage.',
})

const turn = (driver: AgentConfig['driver']): TurnInput => ({
  agent: agent(driver),
  threadId: 'chat',
  cwd: '/tmp/manor/chat',
  catchUp: [],
  isFullCatchUp: true,
  repoPaths: [],
  mcpServers: [attachment],
})

const valueAfter = (args: readonly string[], flag: string): string | undefined => {
  const at = args.indexOf(flag)
  return at === -1 ? undefined : args[at + 1]
}

describe('tool-less personas can use only the scoped skill reader', () => {
  it('keeps Claude built-ins to ToolSearch while attaching the skill MCP', () => {
    // Under lazy MCP the skill reader is deferred; ToolSearch is how it loads.
    const args = buildArgs(turn('claude'))
    expect(valueAfter(args, '--tools')).toBe('ToolSearch')
    expect(valueAfter(args, '--mcp-config')).toContain('"skills"')
    expect(valueAfter(args, '--mcp-config')).toContain('MANOR_SKILL_READER_CAPABILITY')
  })

  it('keeps Codex read-only while attaching the skill MCP', () => {
    const input = turn('codex')
    const args = buildCodexAppServerArgs(input)
    expect(buildCodexTurnRequest(input, '/tmp/manor/chat', 'prompt', 'thread-1')).toMatchObject({
      params: { sandboxPolicy: { type: 'readOnly' } },
    })
    expect(args.join(' ')).toContain('mcp_servers={skills=')
    expect(args.join(' ')).toContain('MANOR_SKILL_READER_CAPABILITY')
    expect(args.join(' ')).toContain('enabled_tools=["read_skill"]')
    expect(args.join(' ')).toContain('tools={read_skill={approval_mode="approve"}}')
  })

  it('keeps Grok file reading blocked while enabling its MCP gateway', () => {
    const args = buildGrokArgs(turn('grok'))
    expect(valueAfter(args, '--disallowed-tools')?.split(',')).toContain('read_file')
    expect(valueAfter(args, '--tools')?.split(',')).toEqual(expect.arrayContaining(['search_tool', 'use_tool']))
    expect(buildGrokMcpConfig([attachment])).toContain('[mcp_servers."skills"]')
  })

  it('keeps Cursor sandboxed while approving the scoped MCP', () => {
    const args = buildCursorArgs(turn('cursor'), '/tmp/manor/chat')
    expect(valueAfter(args, '--mode')).toBe('ask')
    expect(valueAfter(args, '--sandbox')).toBe('enabled')
    expect(args).toContain('--approve-mcps')
    expect(buildCursorMcpConfig([attachment])).toContain('"skills"')
  })
})
