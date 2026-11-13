import type { AgentConfig, ThreadEvent } from '@manor/contracts'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { Transcript } from '../src/components/Transcript'
import { emptyThread, rowsOf } from '../src/state'

const counter = vi.hoisted(() => ({ renders: 0 }))
vi.mock('../src/components/TurnStatus', () => ({
  TurnStatus: () => { counter.renders += 1; return null },
}))

const agent = {
  id: 'smith', name: 'Smith', color: '#c77dbb', driver: 'mock',
  allowedTools: [], mcpServers: [], memoryScope: false, character: '', effort: 'medium',
  description: '', role: '', isCos: false,
} satisfies AgentConfig
const agents = [agent]
const skills: [] = []

describe('finished transcript rows', () => {
  it('skip rendering when only parent callbacks change', () => {
    const events: ThreadEvent[] = Array.from({ length: 50 }, (_, index) => ({
      id: `event_${index}`, ts: index, type: 'turn_result',
      agentId: 'smith', turnId: `turn_${index}`,
    }))
    const rows = rowsOf({ ...emptyThread, events }, 'project')
    const actions = { threads: {} }
    const render = (draftActions = actions, roster = agents) => (
      <Transcript rows={rows} agents={roster} skills={skills} hasSnapshot
        draftActions={draftActions} onOpenFile={() => {}} onReply={() => {}} />
    )
    let tree: ReturnType<typeof create>
    act(() => { tree = create(render()) })
    const mounted = counter.renders
    // A new roster reaches every status line, which shows the counter counts.
    act(() => { tree.update(render(actions, [...agents])) })
    const withNewRoster = counter.renders - mounted
    act(() => { tree.update(render(actions)) })
    // The status line does not read the draft actions, so the compiled row keeps it.
    const beforeNewActions = counter.renders
    act(() => { tree.update(render({ threads: {} })) })
    const withNewActions = counter.renders - beforeNewActions
    act(() => { tree.update(render(actions)) })
    const beforeStable = counter.renders
    act(() => { tree.update(render(actions)) })
    const withStableActions = counter.renders - beforeStable
    expect(mounted).toBe(30)
    expect(withNewRoster).toBe(mounted)
    expect(withNewActions).toBe(0)
    expect(withStableActions).toBe(0)
    act(() => tree.unmount())
  })
})
