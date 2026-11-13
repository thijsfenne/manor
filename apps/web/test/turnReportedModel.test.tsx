import type { AgentConfig, ThreadEvent } from '@manor/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { emptyThread, rowsOf, type ThreadState, type TurnRow } from '../src/state'
import { TurnStatus } from '../src/components/TurnStatus'

/**
 * What the CLI says served a turn. A persona cannot be asked: Manor replaces her whole
 * system prompt, so nothing tells her what she is, and asked directly she invents a
 * plausible name (measured 2026-08-12, a turn served by `claude-opus-5` called itself
 * Sonnet 4.5). The turn row therefore carries the provider's own word.
 *
 * The status line no longer names it (2026-11-11): the line is the turn's record of
 * how long it took, and nothing else.
 */

const jeeves: AgentConfig = {
  id: 'marlow',
  name: 'Jeeves',
  color: '#8B7EC8',
  character: 'You are Jeeves.',
  driver: 'claude',
  model: 'claude-fable-5-2',
  effort: 'medium',
  allowedTools: [],
  mcpServers: [],
  memoryScope: false,
  description: 'Chief of staff.',
  role: 'Chief of staff',
  isCos: true,
}

let stamp = 1_786_500_000_000

const event = (partial: Partial<ThreadEvent> & { type: ThreadEvent['type'] }): ThreadEvent =>
  ({ id: `evt_${(stamp += 1)}`, ts: stamp, ...partial }) as ThreadEvent

/** One finished turn: a message and the result that closes it. */
const finishedTurn = (agentId: string, reportedModel?: string): ThreadEvent[] => [
  event({ type: 'agent_message', agentId, turnId: 'turn_1', messageId: 'm1', text: 'Done.' }),
  event({
    type: 'turn_result',
    agentId,
    turnId: 'turn_1',
    ...(reportedModel === undefined ? {} : { reportedModel }),
  }),
]

const threadOf = (events: ThreadEvent[]): ThreadState => ({
  ...emptyThread,
  events,
  usage: {},
  overrides: {},
  liveTurns: [],
  pending: [],
  hasSnapshot: true,
})

const turnOf = (events: ThreadEvent[]): TurnRow => {
  const row = rowsOf(threadOf(events)).find((candidate): candidate is TurnRow => candidate.kind === 'turn')
  if (row === undefined) throw new Error('expected a turn row')
  return row
}

const render = (turn: TurnRow) =>
  renderToStaticMarkup(<TurnStatus turn={turn} open={false} onToggle={() => undefined} />)

describe('the model a turn ran on', () => {
  it('rides on the turn result and reaches the turn row', () => {
    expect(turnOf(finishedTurn('marlow', 'claude-opus-5')).reportedModel).toBe('claude-opus-5')
  })

  it('is not named as visible text on the turn line', () => {
    const markup = render({ ...turnOf(finishedTurn(jeeves.id, 'claude-opus-5')), startedAt: 1_000, endedAt: 5_000 })

    expect(markup).toContain('Worked for 4s')
    expect(markup).not.toContain('Opus 5')
    expect(markup.replace(/ title="[^"]*"/g, '')).not.toContain('claude-opus-5')
  })

  it('names the model in the tooltip of a finished turn only', () => {
    const done = { ...turnOf(finishedTurn(jeeves.id, 'claude-opus-5')), startedAt: 1_000, endedAt: 5_000 }
    expect(render(done)).toContain('title="This turn ran on claude-opus-5"')
    const running = { ...done, live: { state: 'running' as const, startedAt: 1_000 } } as TurnRow
    expect(render(running)).not.toContain('This turn ran on')
  })

  it('leaves no line at all on a turn that reported a model and nothing else', () => {
    expect(render(turnOf(finishedTurn(jeeves.id, 'claude-opus-5')))).toBe('')
    expect(render(turnOf(finishedTurn(jeeves.id)))).toBe('')
  })
})
