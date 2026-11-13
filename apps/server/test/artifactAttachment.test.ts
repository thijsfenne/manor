import { describe, expect, it } from 'vitest'
import { buildMcpArgs } from '../src/drivers/claudeDriver.js'
import { buildCodexMcpArgs } from '../src/drivers/codexDriver.js'
import { artifactMcpAttachment } from '../src/mcp/artifactAttachment.js'

describe('the built-in Artifacts MCP attachment', () => {
  it('passes only an opaque capability to the child and works through both driver configs', () => {
    const attachment = artifactMcpAttachment(
      'http://127.0.0.1:8787/internal/artifact-tool',
      'secret-turn-capability',
    )

    expect(attachment.server.name).toBe('artifacts')
    expect(attachment.server.tools).toEqual(['artifact_search', 'artifact_view'])
    expect(attachment.runtimeEnv).toEqual({ MANOR_ARTIFACT_BROKER_CAPABILITY: 'secret-turn-capability' })
    expect(attachment.server).toMatchObject({
      command: '',
      args: ['--broker-url', 'http://127.0.0.1:8787/internal/artifact-tool'],
    })
    expect(buildMcpArgs([attachment]).join(' ')).not.toContain('secret-turn-capability')
    expect(buildCodexMcpArgs([attachment]).join(' ')).not.toContain('secret-turn-capability')
  })
})
