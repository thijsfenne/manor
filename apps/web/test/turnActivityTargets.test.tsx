import type { AgentConfig } from '@manor/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TurnActivity } from '../src/components/TurnActivity'
import type { ToolStep, TurnRow } from '../src/state'

const smith: AgentConfig = {
  id: 'smith',
  name: 'Smith',
  color: '#D08A3E',
  character: 'You are Smith.',
  driver: 'codex',
  effort: 'high',
  allowedTools: [],
  mcpServers: [],
  memoryScope: false,
  description: 'Engineer.',
  role: 'Engineer',
  isCos: false,
}

const renderRead = (targets: string[]) => {
  const step: ToolStep = {
    kind: 'tool',
    key: 'read-1',
    toolCallId: 'read-1',
    tool: 'Read',
    targets,
    status: 'running',
    startedAt: 1,
  }
  const turn: TurnRow = {
    kind: 'turn',
    key: 'turn:1',
    turnId: 'turn-1',
    agentId: 'smith',
    asks: [],
    drafts: [],
    activities: [step],
    timeline: [step],
    segments: [{ kind: 'work', key: 'work:read-1', steps: [step] }],
    answer: [],
    tail: [],
    live: { turnId: 'turn-1', agentId: 'smith', messages: [], state: 'running', startedAt: 1 },
  }
  return renderToStaticMarkup(
    <TurnActivity turn={turn} persona={{ name: smith.name, color: smith.color }} agents={[smith]} open />,
  )
}

describe('multi-file activity targets', () => {
  it('keeps a multi-file read inside its activity accordion', () => {
    const html = renderRead(['one.md', 'two.md', 'three.md'])

    expect(html).toContain('Reading 3 files')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('one.md')
    expect(html).not.toContain('group/targets')
  })

  it('leaves a single target as one plain line', () => {
    const html = renderRead(['one.md'])

    expect(html).toContain('Reading one.md')
    expect(html).not.toContain('group/targets')
  })

  it('names the skill directory instead of showing the generic SKILL.md basename', () => {
    const html = renderRead(['/Users/sam/.agents/skills/code-review/SKILL.md'])

    expect(html).toContain('Reading code-review/SKILL.md')
    expect(html).toContain('text-[14px]')
  })
})
