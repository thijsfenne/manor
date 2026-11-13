import type { ChatSubagent } from '@manor/client-runtime/turn-trace'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SessionAgents } from '../src/components/session/SessionAgents'

const helper = (key: string, status: 'running' | 'done' | 'error'): ChatSubagent => ({
  step: { kind: 'tool', key, toolCallId: key, tool: 'Task', status, startedAt: 0, input: { description: `Task ${key}` } } as unknown as ChatSubagent['step'],
  steps: [],
  turnKey: 't',
  agentId: 'a',
  turnRunning: status === 'running',
})
const render = (subagents: ChatSubagent[]) =>
  renderToStaticMarkup(<SessionAgents subagents={subagents} summary={() => undefined} onOpen={() => {}} onStop={() => true} />)

describe('the Session panel Agents section', () => {
  it('is one folded summary line with counts, rows still in the tree for the unfold', () => {
    const html = render([helper('a', 'running'), helper('b', 'done'), helper('c', 'done')])
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('1 running')
    expect(html).toContain('2 done')
  })
  it('says a failure in the danger colour', () => {
    const html = render([helper('a', 'error')])
    expect(html).toMatch(/class="text-danger">1 failed/)
  })
  it('renders nothing without subagents', () => {
    expect(render([])).toBe('')
  })
})
