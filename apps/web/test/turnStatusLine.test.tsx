import type { AgentConfig } from '@manor/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TurnHeader } from '../src/components/Bubbles'
import { TurnStatus } from '../src/components/TurnStatus'
import { COMPACTING_STATUS, LIVE_COMPACT_DONE, LIVE_COMPACT_NOTE, turnSummary } from '../src/turnTrace'
import type { ToolStep, TurnRow, TurnSegment } from '../src/state'

/**
 * What a turn says about itself beside the name of whoever is running it.
 *
 * The line only pays off if two things hold. It has to say the same kind of thing
 * live and settled, in the same place, or the reader watches it jump rows at the one
 * moment a turn ends. And it has to stay a *status* rather than become a ticker: the
 * tool a turn is on belongs to the row that tool is on, not to the line next to a
 * persona's face.
 */

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

const step = (patch: Partial<ToolStep> = {}): ToolStep => ({
  kind: 'tool',
  key: 'step-0',
  toolCallId: 'step-0',
  tool: 'Read',
  targets: ['Avatar.tsx'],
  status: 'done',
  startedAt: 1,
  ...patch,
})

const turnOf = (patch: Partial<TurnRow> = {}): TurnRow => {
  const steps = patch.activities ?? [step()]
  const segments: TurnSegment[] = patch.segments ?? [{ kind: 'work', key: 'work:step-0', steps }]
  return {
    kind: 'turn',
    key: 'turn:1',
    turnId: 'turn-1',
    agentId: 'smith',
    asks: [],
    drafts: [],
    activities: steps,
    timeline: steps,
    segments,
    answer: [],
    tail: [],
    ...patch,
  } as TurnRow
}

const running = (patch: Partial<TurnRow> = {}) =>
  turnOf({
    live: { turnId: 'turn-1', agentId: 'smith', messages: [], state: 'running', startedAt: 1 },
    ...patch,
  })

const render = (turn: TurnRow, props: { open?: boolean; dm?: boolean; thread?: boolean } = {}) =>
  renderToStaticMarkup(
    <TurnStatus turn={turn} open={false} onToggle={() => undefined} {...props} />,
  )

/** The class that keeps a line hidden until its turn is hovered or holds focus. */
const QUIET = 'group-hover/turn:opacity-100 group-focus-within/turn:opacity-100'

describe('the status line beside a persona’s name', () => {
  it('keeps the generic word while a tool is running, and leaves the tool to its own row', () => {
    const live = running({ activities: [step({ status: 'running' })] })

    // "Read Avatar.tsx" is truer about this half-second and wrong for this line: a
    // status next to a name that rewrites itself every few hundred milliseconds is a
    // ticker, and the reader watches it instead of the work.
    expect(turnSummary(live)).toBe('Working…')
    expect(render(live)).not.toContain('Avatar.tsx')
    // The avatar already shows she is working; the words carry the clock, not a shimmer.
    expect(render(live)).not.toContain('shimmer-text')
    expect(render(live)).toContain('Working for ')
    expect(render(live)).toContain('truncate leading-tight')
  })

  it('says the same word whether she is reasoning or running a tool', () => {
    // The earlier build swapped to "Thinking…" between tool calls, which is truer and
    // still wrong here: reason, call, reason is a normal turn, so the line beside the
    // name flickered on every hand-off. The trace shows the thought on its own row.
    expect(turnSummary(running({ activities: [{ kind: 'reasoning', key: 'r1', text: 'Hmm.', startedAt: 1 }] }))).toBe('Working…')
    expect(turnSummary(running({ activities: [step({ status: 'running' })] }))).toBe('Working…')
  })

  it('moves Compacting onto the Working slot and hides the timer', () => {
    const compacting = running({
      note: { id: 'compact', ts: 1, type: 'system_note', kind: 'info', text: LIVE_COMPACT_NOTE } as TurnRow['note'],
    })
    const after = running({
      note: { id: 'compact', ts: 1, type: 'system_note', kind: 'info', text: LIVE_COMPACT_DONE } as TurnRow['note'],
    })

    expect(turnSummary(compacting)).toBe(COMPACTING_STATUS)
    expect(render(compacting)).toContain('shimmer-text')
    expect(render(compacting)).toContain(`data-text="${COMPACTING_STATUS}"`)
    expect(render(compacting)).not.toContain('for ')
    expect(turnSummary(after)).toBe('Working…')
    expect(render(after)).toContain('for ')
  })

  it('keeps the fold when Compacted is the only row', () => {
    const html = render(turnOf({
      segments: [],
      activities: [],
      startedAt: 1_000,
      endedAt: 5_000,
      note: { id: 'compact', ts: 1, type: 'system_note', kind: 'info', text: LIVE_COMPACT_DONE } as TurnRow['note'],
    }))

    expect(html).toContain('aria-expanded="false"')
  })

  it('makes the one exception for a turn that is holding for an answer', () => {
    const waiting = running({ asks: [{ key: 'a1', requestId: 'a1', questions: [], answers: undefined }] })

    expect(turnSummary(waiting)).toBe('Waiting for you…')
    expect(render(waiting)).not.toContain('shimmer-text')
    expect(render(waiting)).not.toContain('·')
  })

  // 2026-10-07: a manual stop reads as one word on its turn, instead of a line of its own.
  it('says Stopped for a manual stop, quietly and with its trace still behind it', () => {
    const html = render(turnOf({ note: { kind: 'aborted', text: 'Stopped by you' } as TurnRow['note'] }))

    expect(turnSummary(turnOf({ note: { kind: 'aborted', text: 'Stopped by you' } as TurnRow['note'] }))).toBe('Stopped')
    expect(html).toContain('>Stopped</span>')
    expect(html).not.toContain('Stopped by you')
    expect(html).not.toContain('text-danger')
    expect(html).toContain('aria-expanded="false"')
  })

  it('still says Stopped for a turn stopped before it took a single step', () => {
    const html = render(
      turnOf({
        segments: [],
        activities: [],
        note: { kind: 'aborted', text: 'Stopped by you' } as TurnRow['note'],
      }),
    )

    expect(html).toContain('>Stopped</span>')
    expect(html).not.toContain('aria-expanded')
  })

  it('keeps the record of a turn that only spoke', () => {
    // Its reply stands on its own below, so it has no trace and nothing to fold. What
    // it cost is still a fact about the turn, and the line that states it is this one.
    const spoke = turnOf({
      segments: [],
      activities: [],
      startedAt: 1_000,
      endedAt: 5_000,
      reportedModel: 'gpt-5.6-sol',
    } as Partial<TurnRow>)
    const html = render(spoke)

    expect(html).toContain('Worked for 4s')
    expect(html.replace(/ title="[^"]*"/g, '')).not.toContain('gpt-5.6-sol')
    expect(html).not.toContain('·')
    // Nothing to open, so nothing offers to open.
    expect(html).not.toContain('aria-expanded')
  })

  it('leaves an actual failure to the one alert that carries its reason', () => {
    const stopped = turnOf({ note: { kind: 'aborted', text: 'Stopped by you' } as TurnRow['note'] })
    const failed = turnOf({ note: { kind: 'error', text: 'Could not finish: boom' } as TurnRow['note'] })

    expect(turnSummary(stopped)).toBe('Stopped')
    expect(turnSummary(failed)).toBe('')
    expect(render(failed)).not.toContain('text-danger')
    expect(render(failed)).not.toContain('Could not finish')
  })

  it('does not mark a recovered info note as a failed turn', () => {
    const html = render(
      turnOf({
        startedAt: 1_000,
        endedAt: 5_000,
        note: { kind: 'info', text: 'Recovered and continued' } as TurnRow['note'],
      }),
    )

    expect(html).toContain('Worked for 4s')
    expect(html).not.toContain('text-danger')
  })

  it('offers the outer activity fold while bundles own their inner folds', () => {
    const html = render(turnOf())

    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('Smith')
  })

  it('says nothing at all for a turn that neither ran, traced, ended badly, nor named a model', () => {
    expect(render(turnOf({ segments: [], activities: [] }))).toBe('')
  })

  it('never names the model, so a turn that only reported one says nothing', () => {
    expect(render(turnOf({ segments: [], activities: [], reportedModel: 'gpt-5.6-sol' }))).toBe('')
  })

  // 2026-11-11: the record of a finished turn waits for hover or focus on every surface.
  it('rests a finished turn’s line until hover or focus, chevron included', () => {
    const html = render(turnOf({ startedAt: 1_000, endedAt: 5_000 }))

    expect(html).toContain('Worked for 4s')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toMatch(new RegExp(`^<span[^>]*opacity-0[^>]*${QUIET}`))
  })

  it('keeps the line shown while the turn runs and while its trace is open', () => {
    expect(render(running())).not.toContain('opacity-0')
    expect(render(turnOf({ startedAt: 1_000, endedAt: 5_000 }), { open: true })).not.toContain('opacity-0')
  })

  it('keeps Stopped and a background wait shown in a Session, and rests them in a project thread or a DM', () => {
    const stopped = turnOf({ note: { kind: 'aborted', text: 'Stopped by you' } as TurnRow['note'] })
    const waiting = turnOf({ activities: [step({ status: 'running', background: true })], startedAt: 1_000, endedAt: 5_000 })

    expect(render(stopped)).not.toContain('opacity-0')
    expect(render(waiting)).toContain('Waiting on 1 background command')
    expect(render(waiting)).not.toContain('opacity-0')
    expect(render(stopped, { thread: true })).toContain(QUIET)
    expect(render(waiting, { thread: true })).toContain(QUIET)
    expect(render(stopped, { dm: true })).toContain(QUIET)
  })

  it('signs the header with face, name and status', () => {
    const html = renderToStaticMarkup(
      <TurnHeader name="Smith" color={smith.color} working status={<span>Working</span>} />,
    )

    // Face, then name, then status.
    expect(html.indexOf('Smith')).toBeLessThan(html.indexOf('Working'))
    expect(html).toContain('text-text')
    expect(html).not.toContain('text-[var(--accent-fg)]')
    expect(html).toContain('mo-always')
    expect(html).not.toContain('data-sidebar-working')
  })
})
