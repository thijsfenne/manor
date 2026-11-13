import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SubagentSummary, ThreadEvent } from '@manor/contracts'
import { Transcript } from '../src/components/Transcript'
import { SubagentDirectory } from '../src/subagentContext'
import { emptyThread, rowsOf } from '../src/state'

// A turn that launched a Manor child and then failed without a reply.
const events: ThreadEvent[] = [
  { id: 'launch', ts: 1000, type: 'tool_use', agentId: 'a', turnId: 't', tool: 'spawn_subagent', toolCallId: 's', subagent: { title: 'Review files', childChatId: 'child' } },
  { id: 'fail', ts: 2000, type: 'system_note', kind: 'error', agentId: 'a', turnId: 't', text: 'Parent failed' },
]

const render = (state: SubagentSummary['state'], room: 'dm' | 'project') => renderToStaticMarkup(
  <SubagentDirectory.Provider value={() => ({ state }) as SubagentSummary}>
    <Transcript rows={rowsOf({ ...emptyThread, events, hasSnapshot: true }, room)} agents={[]} skills={[]} hasSnapshot bubbleReplies={room === 'dm'} onOpenSubagents={() => {}} />
  </SubagentDirectory.Provider>,
)

describe('a settled turn’s helper cards', () => {
  it('stay in a Session while the child still works', () => {
    expect(render('running', 'project')).toContain('Open Review files')
  })

  it('fold once the child ended', () => {
    expect(render('done', 'project')).not.toContain('Open Review files')
  })

  it('never show in a DM', () => {
    expect(render('running', 'dm')).not.toContain('Open Review files')
  })
})
