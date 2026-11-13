import { describe, expect, it } from 'vitest'
import { artifactResultContent } from '../src/mcp/artifactServer.js'

describe('Artifacts MCP image results', () => {
  it('keeps metadata as text and delivers preview pixels as native MCP image blocks', () => {
    const content = artifactResultContent({
      artifacts: [
        {
          id: 'object_1',
          title: 'Calm finance interface',
          preview: { mimeType: 'image/png', data: 'AQID' },
        },
        { id: 'object_2', title: 'Text reference' },
      ],
    })

    expect(content).toEqual([
      {
        type: 'text',
        text: JSON.stringify({
          artifacts: [
            { id: 'object_1', title: 'Calm finance interface' },
            { id: 'object_2', title: 'Text reference' },
          ],
        }),
      },
      { type: 'text', text: 'Preview for artifact "object_1" "Calm finance interface":' },
      { type: 'image', mimeType: 'image/png', data: 'AQID' },
    ])
  })
})
