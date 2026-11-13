import { describe, expect, it } from 'vitest'
import { buildMcpArgs } from '../src/drivers/claudeDriver.js'
import { buildCodexMcpArgs } from '../src/drivers/codexDriver.js'
import { routineMcpAttachment } from '../src/mcp/routineAttachment.js'

describe('the built-in Routines MCP attachment', () => {
  it('keeps the bound DM capability out of every provider argv', () => {
    const attachment = routineMcpAttachment(
      'http://127.0.0.1:8787/internal/routine-tool',
      'secret-turn-capability',
    )

    expect(attachment.server.name).toBe('routines')
    expect(attachment.server.writes).toBe(true)
    expect(attachment.server.tools).toEqual(['routine_list', 'routine_save', 'routine_cancel'])
    expect(attachment.server).toMatchObject({
      command: '',
      args: ['--broker-url', 'http://127.0.0.1:8787/internal/routine-tool'],
    })
    expect(attachment.runtimeEnv).toEqual({ MANOR_ROUTINE_BROKER_CAPABILITY: 'secret-turn-capability' })
    expect(buildMcpArgs([attachment]).join(' ')).not.toContain('secret-turn-capability')
    expect(buildCodexMcpArgs([attachment]).join(' ')).not.toContain('secret-turn-capability')
  })
})
