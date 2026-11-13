import type { AgentConfig } from '@manor/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AgentStack } from '../src/components/inbox/AgentStack'
import { palette } from '@manor/blobatar'
import { accentHue } from '../src/accent'

/**
 * Who is in a thread, on a chat card. The rule under test is that the overflow count
 * is part of the stack rather than a chip parked beside it.
 */

const agent = (id: string, name: string, color: string): AgentConfig => ({
  id,
  name,
  color,
  character: '',
  driver: 'claude',
  effort: 'medium',
  allowedTools: [],
  mcpServers: [],
  memoryScope: false,
  description: '',
  role: 'Specialist',
  isCos: false,
})

const roster = ['wren', 'iris', 'smith', 'argus', 'mercer'].map((id, index) =>
  agent(id, id[0]!.toUpperCase() + id.slice(1), ['#C77DBB', '#EC4899', '#D08A3E', '#6FA8A0', '#8B7EC8'][index]!),
)

const render = (agentIds: string[], size = 24) =>
  renderToStaticMarkup(<AgentStack agentIds={agentIds} agents={roster} size={size} />)

const renderCompact = (agentIds: string[]) =>
  renderToStaticMarkup(<AgentStack agentIds={agentIds} agents={roster} size={34} footprint={48} />)

describe('the agent stack on a chat card', () => {
  it('keeps each persona\'s tone in both stack layouts', () => {
    const agents = [
      { ...agent('wren', 'Wren', '#C77DBB'), avatarTone: 0.1 },
      { ...agent('iris', 'Iris', '#C77DBB'), avatarTone: 0.97 },
    ]
    for (const footprint of [undefined, 48]) {
      const html = renderToStaticMarkup(<AgentStack agentIds={['wren', 'iris']} agents={agents} size={24} footprint={footprint} />)
      for (const { avatarTone } of agents) {
        const head = palette(accentHue('#C77DBB')!, true, avatarTone).head
        if (!head) throw new Error('Expected a face colour')
        expect(html).toContain(`%23${head.slice(1)}`)
      }
    }
  })

  it('laps the count a quarter of a face over the last one', () => {
    const html = render(['wren', 'iris', 'smith', 'argus', 'mercer'])

    expect(html).toContain('+2')
    // A quarter of 24, and negative: it sits on the stack, not next to it.
    expect(html).toContain('margin-left:-6px')
    expect(html).not.toContain('ml-1')
  })

  it('scales that overlap with the face rather than pinning it to one card', () => {
    expect(render(['wren', 'iris', 'smith', 'argus'], 16)).toContain('margin-left:-4px')
  })

  it('paints the count above the face it laps', () => {
    // Reversed DOM order puts every face after the count, and the faces are positioned
    // in their own right, so without this the silhouette would cut into the digits.
    const html = render(['wren', 'iris', 'smith', 'argus'])

    expect(html).toContain('relative z-10')
    // And that one z-index means nothing outside the cluster.
    expect(html).toContain('isolate')
  })

  it('leaves a stack that fits alone', () => {
    const html = render(['wren', 'iris', 'smith'])

    expect(html).not.toMatch(/>\+\d/)
    expect(html).not.toContain('margin-left:-')
  })
})

describe('the compact group cluster', () => {
  it('puts four faces in the four corners of one portrait footprint', () => {
    const html = renderCompact(['wren', 'iris', 'smith', 'argus'])

    expect(html.match(/data-avatar="blobatar"/g)?.length).toBe(4)
    expect(html).toContain('width:48px;height:48px')
    expect(html).toContain('left:14px;top:14px')
    expect(html).not.toMatch(/>\+\d/)
  })

  it('keeps all four faces and badges the remainder over the last corner', () => {
    const html = renderCompact(['wren', 'iris', 'smith', 'argus', 'mercer'])

    expect(html.match(/data-avatar="blobatar"/g)?.length).toBe(4)
    expect(html).toContain('+1')
    expect(html).toContain('right:0;bottom:0;z-index:5;width:19px;height:19px')
  })
})
