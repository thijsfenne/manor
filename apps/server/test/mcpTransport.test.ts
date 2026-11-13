import { McpServerConfigSchema, McpServerDraftSchema } from '@manor/contracts'
import { describe, expect, it } from 'vitest'

describe('MCP transport xor', () => {
  it('accepts stdio (command, no url) and HTTP (url, no command)', () => {
    expect(McpServerConfigSchema.parse({ id: '1', name: 'files', command: '/bin/files' }).url).toBeUndefined()
    expect(McpServerDraftSchema.parse({ name: 'figma', url: 'http://127.0.0.1:3845/mcp' }).command).toBe('')
  })

  it('rejects a row with both, or with neither', () => {
    expect(
      McpServerDraftSchema.safeParse({
        name: 'x',
        command: 'npx',
        url: 'http://127.0.0.1:3845/mcp',
      }).success,
    ).toBe(false)
    expect(McpServerConfigSchema.safeParse({ id: '1', name: 'x' }).success).toBe(false)
  })
})
