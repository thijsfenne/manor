import { describe, expect, it } from 'vitest'
import type { SubagentSummary } from '@manor/contracts'
import type { ChatSubagent } from '@manor/client-runtime/turn-trace'
import { subagentBarStatus } from '@manor/client-runtime/turn-trace'
import { emptyThread, openSubagentQuestion, subagentSummaryOf } from '../src/state'
import { subagentLevels } from '../src/subagentLevels'

const child = (id: string, parentChatId: string, extra: Partial<SubagentSummary> = {}): SubagentSummary => ({
  id,
  parentChatId,
  title: id,
  driver: 'claude',
  model: 'claude-sonnet-5-5',
  effort: 'high',
  agentId: 'marlow',
  turnId: `turn_${id}`,
  toolCallId: `subagent_${id}`,
  state: 'running',
  role: 'worker',
  startedAt: 1,
  ...extra,
} as SubagentSummary)

const ask = (requestId: string) => ({
  requestId,
  questions: [{ id: 'q', question: 'Which way?', options: [{ label: 'Left' }, { label: 'Right' }] }],
})

const launch = (callId: string, childChatId?: string): ChatSubagent => ({
  step: {
    key: callId,
    toolCallId: callId,
    tool: 'subagent',
    ...(childChatId === undefined ? {} : { subagent: { childChatId } }),
  },
  steps: [],
  turnKey: 'turn',
  agentId: 'marlow',
} as unknown as ChatSubagent)

describe('openSubagentQuestion', () => {
  it('reaches the chat at the top of the line, oldest child first, and counts the rest', () => {
    const subagents = [
      child('late', 'chat', { startedAt: 9, ask: ask('req_late') }),
      child('middle', 'chat', { startedAt: 2 }),
      child('nested', 'middle', { startedAt: 3, ask: ask('req_nested') }),
    ]

    expect(openSubagentQuestion({ subagents }, 'chat')).toMatchObject({
      childChatId: 'nested',
      requestId: 'req_nested',
      more: 1,
    })
    expect(openSubagentQuestion({ subagents }, 'middle')).toBeNull()
  })
})

describe('subagentSummaryOf', () => {
  it('keeps a finished child that left the directory, not a snapshot from while it ran', () => {
    const finished = child('gone', 'chat', { state: 'failed', reason: 'It broke.' })
    const threads = {
      gone: { ...emptyThread, subagent: finished },
      stale: { ...emptyThread, subagent: child('stale', 'chat') },
    }

    expect(subagentSummaryOf({ subagents: [], threads }, 'gone')).toBe(finished)
    expect(subagentSummaryOf({ subagents: [], threads }, 'stale')).toBeUndefined()
  })
})

describe('subagentBarStatus', () => {
  const started = 1_000

  it('says Waiting over the running clock while a question is open', () => {
    expect(subagentBarStatus('running', { startedAt: started, asking: true }, started + 62_000)).toBe('Waiting')
    expect(subagentBarStatus('running', { startedAt: started, asking: false }, started + 62_000)).toBe('Working 1m 2s')
  })

  it('closes on how long it took, and on the plain word without an end', () => {
    expect(subagentBarStatus('done', { startedAt: started, endedAt: started + 34_000, asking: false }, started + 90_000)).toBe('Done in 34s')
    expect(subagentBarStatus('failed', { startedAt: started, asking: false }, started)).toBe('Failed')
  })
})

describe('subagentLevels', () => {
  it('follows a path through a child into its own helpers', () => {
    const top = launch('call_top', 'child')
    const nested = launch('call_nested', 'grandchild')

    const levels = subagentLevels('chat', [top], ['call_top', 'call_nested'], (id) => id === 'child' ? [nested] : [])

    expect(levels).toEqual([{ subagent: top, chatId: 'chat' }, { subagent: nested, chatId: 'child' }])
  })

  it('stops at the deepest level it can still find', () => {
    const top = launch('call_top', 'child')

    expect(subagentLevels('chat', [top], ['call_top', 'call_nested'], () => [])).toHaveLength(1)
    expect(subagentLevels('chat', [], ['call_top'], () => [])).toEqual([])
  })

  it('has nothing below a provider-run helper, which has no thread of its own', () => {
    const native = launch('call_native')

    expect(subagentLevels('chat', [native], ['call_native', 'call_more'], () => [launch('call_more')])).toHaveLength(1)
  })
})
