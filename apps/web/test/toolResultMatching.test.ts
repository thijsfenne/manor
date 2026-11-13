import type { ThreadEvent } from '@manor/contracts'
import { describe, expect, it } from 'vitest'
import { emptyThread, isToolStep, rowsOf, type LiveTurn, type ThreadState, type ToolStep, type TurnRow } from '../src/state'

/**
 * Which tool step a `tool_result` lands on. `rowsOf` used to answer this by filtering
 * the turn's whole activity list per result, which is quadratic inside one turn and
 * ran again on every streaming delta; it now walks a per-turn map of call ids. The
 * map has to answer exactly what the filter did, including the parts nobody would
 * design on purpose: results are scoped to their own turn, and a driver that sends no
 * call id has all of its steps share one key, first one wins.
 *
 * Read the statuses like this. A step that never got a result is closed for it by the
 * legacy rule at the end of `rowsOf`, which reads `done`, so `done` is exactly what a
 * miss looks like and proves nothing on its own. `error` can only come from a result
 * that found this step, and the last step of a running turn is the one the same rule
 * leaves alone. So the cases below fail results on purpose and keep the interesting
 * step away from the end.
 */

let stamp = 1_786_500_000_000

const event = (partial: Partial<ThreadEvent> & { type: ThreadEvent['type'] }): ThreadEvent =>
  ({ id: `evt_${(stamp += 1)}`, ts: stamp, ...partial }) as ThreadEvent

const live = (turnId: string, agentId: string): LiveTurn => ({
  turnId,
  agentId,
  messages: [],
  state: 'running',
  startedAt: stamp,
})

const threadOf = (events: ThreadEvent[], liveTurns: LiveTurn[]): ThreadState => ({
  ...emptyThread,
  events,
  usage: {},
  overrides: {},
  liveTurns,
  pending: [],
  hasSnapshot: true,
})

/** Every tool step of every turn, in transcript order, with the turn it belongs to. */
const toolsOf = (events: ThreadEvent[], liveTurns: LiveTurn[]): { turnId: string; step: ToolStep }[] =>
  rowsOf(threadOf(events, liveTurns))
    .filter((row): row is TurnRow => row.kind === 'turn')
    .flatMap((turn) => turn.activities.filter(isToolStep).map((step) => ({ turnId: turn.turnId, step })))

const use = (turnId: string, agentId: string, toolCallId?: string, tool = 'Read'): ThreadEvent =>
  event({ type: 'tool_use', agentId, turnId, tool, ...(toolCallId === undefined ? {} : { toolCallId }) })

const failed = (turnId: string, agentId: string, toolCallId?: string): ThreadEvent =>
  event({
    type: 'tool_result',
    agentId,
    turnId,
    outcome: 'error',
    ...(toolCallId === undefined ? {} : { toolCallId }),
  })

describe('tool results find their step', () => {
  it('marks the step with the matching call id and nothing else', () => {
    const tools = toolsOf(
      [
        use('turn_1', 'smith', 'call_a'),
        use('turn_1', 'smith', 'call_b'),
        use('turn_1', 'smith', 'call_c'),
        failed('turn_1', 'smith', 'call_b'),
      ],
      [live('turn_1', 'smith')],
    )

    expect(tools.map(({ step }) => step.status)).toEqual(['done', 'error', 'running'])
  })

  it('closes the step a successful result names, which is the running one', () => {
    const tools = toolsOf(
      [
        use('turn_1', 'smith', 'call_a'),
        use('turn_1', 'smith', 'call_b'),
        event({ type: 'tool_result', agentId: 'smith', turnId: 'turn_1', toolCallId: 'call_b', outcome: 'success' }),
      ],
      [live('turn_1', 'smith')],
    )

    expect(tools.map(({ step }) => step.status)).toEqual(['done', 'done'])
  })

  it('adds edits only when the successful result establishes them', () => {
    const edits = [{ path: 'notes.md', kind: 'update' as const }]
    const tools = toolsOf(
      [
        use('turn_1', 'smith', 'call_a', 'Edit'),
        event({ type: 'tool_result', agentId: 'smith', turnId: 'turn_1', toolCallId: 'call_a', outcome: 'success', edits }),
      ],
      [live('turn_1', 'smith')],
    )

    expect(tools[0]?.step.edits).toEqual(edits)
  })

  it('does not reach across turns that reuse a call id', () => {
    const tools = toolsOf(
      [
        use('turn_1', 'smith', 'call_a'),
        use('turn_2', 'iris', 'call_a'),
        use('turn_2', 'iris', 'call_b'),
        failed('turn_2', 'iris', 'call_a'),
      ],
      [live('turn_1', 'smith'), live('turn_2', 'iris')],
    )

    expect(tools.map(({ turnId, step }) => [turnId, step.status])).toEqual([
      ['turn_1', 'running'],
      ['turn_2', 'error'],
      ['turn_2', 'running'],
    ])
  })

  it('settles a duplicate call id on the first step, as the old scan did', () => {
    const tools = toolsOf(
      [
        use('turn_1', 'smith', 'call_a', 'Read'),
        use('turn_1', 'smith', 'call_a', 'Write'),
        use('turn_1', 'smith', 'call_b', 'Grep'),
        failed('turn_1', 'smith', 'call_a'),
      ],
      [live('turn_1', 'smith')],
    )

    expect(tools.map(({ step }) => [step.tool, step.status])).toEqual([
      ['Read', 'error'],
      ['Write', 'done'],
      ['Grep', 'running'],
    ])
  })

  it('matches a result with no call id to the first step that has none', () => {
    const tools = toolsOf(
      [
        use('turn_1', 'smith', 'call_a'),
        use('turn_1', 'smith', undefined, 'Bash'),
        use('turn_1', 'smith', undefined, 'Grep'),
        failed('turn_1', 'smith', undefined),
      ],
      [live('turn_1', 'smith')],
    )

    expect(tools.map(({ step }) => [step.tool, step.status])).toEqual([
      ['Read', 'done'],
      ['Bash', 'error'],
      ['Grep', 'running'],
    ])
  })

  it('ignores a result whose call id was never opened', () => {
    const tools = toolsOf(
      [use('turn_1', 'smith', 'call_a'), use('turn_1', 'smith', 'call_b'), failed('turn_1', 'smith', 'call_z')],
      [live('turn_1', 'smith')],
    )

    expect(tools.map(({ step }) => step.status)).toEqual(['done', 'running'])
  })
})
