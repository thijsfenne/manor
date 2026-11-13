import type { AgentConfig, ThreadEvent } from '@manor/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { EditGroup } from '../src/components/EditGroup'
import { Transcript } from '../src/components/Transcript'
import { TurnActivity } from '../src/components/TurnActivity'
import { UserBubble } from '../src/components/Bubbles'
import { MessageFooter } from '../src/components/MessageFooter'
import {
  emptyThread,
  rowsOf,
  type ThreadState,
  type ToolStep,
  type TurnActivity as TurnStep,
  type TurnRow,
  type TurnSegment,
} from '../src/state'
import { LIVE_COMPACT_DONE, LIVE_COMPACT_NOTE } from '../src/turnTrace'

/**
 * What a turn costs in height, and what it may never cost in evidence.
 *
 * Every uninterrupted run is one closed summary with its complete evidence in its
 * own accordion. Recoverable tool trouble stays neutral and inside that evidence.
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

const read = (index: number, patch: Partial<ToolStep> = {}): ToolStep => ({
  kind: 'tool',
  key: `step-${index}`,
  toolCallId: `step-${index}`,
  tool: 'Read',
  targets: [`file-${index}.ts`],
  status: 'done',
  startedAt: index,
  ...patch,
})

const runTurn = (steps: TurnStep[], live = false, messages: Array<{ messageId: string; text: string }> = []): TurnRow => {
  const segments: TurnSegment[] = [{ kind: 'work', key: 'work:step-0', steps }]
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
    ...(live
      ? { live: { turnId: 'turn-1', agentId: 'smith', messages, state: 'running' as const, startedAt: 1 } }
      : {}),
  }
}

const renderRun = (steps: TurnStep[], live = false, messages: Array<{ messageId: string; text: string }> = []) => {
  const turn = runTurn(steps, live, messages)
  return renderToStaticMarkup(
    <TurnActivity turn={turn} persona={{ name: smith.name, color: smith.color }} agents={[smith]} open />,
  )
}

describe('a run of work', () => {
  it.each([
    [false, false, false, 'Hello world'],
    [true, false, false, 'Earlier\n\nHello world'],
    [false, true, false, 'Hello world\n\nDone'],
    [false, true, true, 'Hello world\n\nDone'],
    [false, false, true, 'Hello world'],
  ] as const)('preserves copied and quoted text across a steer (earlier: %s, later: %s, image at end: %s)', (earlier, later, imageAtEnd, expected) => {
    const message = (id: string, ts: number, text: string): ThreadEvent => ({
      id, ts, type: 'agent_message', turnId: 'turn-1', agentId: smith.id, messageId: id, text,
      ...(id === 'm1' && imageAtEnd ? { images: [{ name: 'example.png', src: '/example.png' }] } : {}),
    })
    const events: ThreadEvent[] = [
      ...(earlier ? [message('m0', 2, 'Earlier')] : []),
      { id: 'steer', ts: 3, type: 'user_message', text: 'Wait', mentions: [], steersTurnId: 'turn-1',
        steerAfter: { messageId: 'm1', textOffset: imageAtEnd ? 'Hello world'.length : 5 } },
      message('m1', 4, 'Hello world'),
      ...(later ? [message('m2', 5, 'Done')] : []),
      { id: 'result', ts: 6, type: 'turn_result', turnId: 'turn-1', agentId: smith.id },
    ]
    const onReply = vi.fn()
    let view!: ReactTestRenderer
    act(() => { view = create(<Transcript rows={rowsOf({ ...emptyThread, events }, 'project')} agents={[smith]} skills={[]} hasSnapshot onReply={onReply} />) })
    const footer = view.root.findByType(MessageFooter)
    expect(footer.props.text).toBe(expected)
    act(() => { footer.props.onReply() })
    expect(onReply).toHaveBeenCalledWith({ turnId: 'turn-1', agentId: smith.id, text: expected })
    act(() => { view.unmount() })
  })

  it('keeps an inline user bubble visible with the trace closed and in focus mode', () => {
    const events: ThreadEvent[] = [
      { id: 'prompt', ts: 1, type: 'user_message', text: 'Inspect the files.', mentions: [] },
      { id: 'thought', ts: 2, type: 'reasoning', turnId: 'turn-1', agentId: smith.id, text: 'Planning the inspection.' },
      { id: 'steer', ts: 3, type: 'user_message', text: 'Check the order too.', mentions: [], steersTurnId: 'turn-1',
        steerAfter: { messageId: 'message', textOffset: 7 }, files: [{ name: 'order.txt', mime: 'text/plain', content: 'test' }] },
      { id: 'narration', ts: 4, type: 'agent_message', turnId: 'turn-1', agentId: smith.id, messageId: 'message', text: 'Before After' },
      { id: 'read', ts: 5, type: 'tool_use', turnId: 'turn-1', agentId: smith.id, tool: 'Read', toolCallId: 'read' },
      { id: 'answer', ts: 6, type: 'agent_message', turnId: 'turn-1', agentId: smith.id, text: 'The order is correct.' },
      { id: 'result', ts: 7, type: 'turn_result', turnId: 'turn-1', agentId: smith.id },
    ]
    const rows = rowsOf({ ...emptyThread, events }, 'project')
    let view!: ReactTestRenderer
    act(() => { view = create(<Transcript rows={rows} agents={[smith]} skills={[]} hasSnapshot />) })
    const user = view.root.findAllByType(UserBubble).find((bubble) => bubble.props.text === 'Check the order too.')!
    expect(user).toBeDefined()
    expect(user.props.files).toMatchObject([{ name: 'order.txt' }])
    for (let parent = user.parent; parent !== null; parent = parent.parent) expect(parent.props['data-chrome']).toBeUndefined()
    const html = renderToStaticMarkup(<Transcript rows={rows} agents={[smith]} skills={[]} hasSnapshot />)
    expect(html.match(/Check the order too\./g)).toHaveLength(1)
    expect(html).toContain('order.txt')
    expect(html).toContain('The order is correct.')
    expect(html).not.toContain('Planning the inspection.')
    act(() => { view.unmount() })
  })

  it('renders both parts of a live message around an inline addition once', () => {
    const rows = rowsOf({
      ...emptyThread,
      events: [
        { id: 'prompt', ts: 1, type: 'user_message', text: 'Inspect.', mentions: [] },
        { id: 'steer', ts: 3, type: 'user_message', text: 'Change direction.', mentions: [], steersTurnId: 'turn-1',
          steerAfter: { messageId: 'message', textOffset: 7 } },
      ],
      liveTurns: [{ turnId: 'turn-1', agentId: smith.id, state: 'running', startedAt: 2,
        messages: [{ messageId: 'message', text: 'Before After' }] }],
    }, 'project')
    const html = renderToStaticMarkup(<Transcript rows={rows} agents={[smith]} skills={[]} hasSnapshot />)
    expect(html.match(/Before/g)).toHaveLength(1)
    expect(html.match(/After/g)).toHaveLength(1)
    expect(html.match(/Change direction\./g)).toHaveLength(1)
    expect(html.indexOf('Before')).toBeLessThan(html.indexOf('Change direction.'))
    expect(html.indexOf('Change direction.')).toBeLessThan(html.indexOf('After'))
  })

  it('lets a settled turn open and close its whole stream', () => {
    const steps = [read(0)]
    const turn: TurnRow = {
      kind: 'turn',
      key: 'turn:1',
      turnId: 'turn-1',
      agentId: 'smith',
      asks: [],
      drafts: [],
      activities: steps,
      timeline: steps,
      segments: [{ kind: 'work', key: 'work:step-0', steps }],
      answer: [],
      tail: [],
    }
    let view!: ReactTestRenderer
    const disclosures = () =>
      view.root.findAllByType('button').filter((button) => button.props['aria-expanded'] !== undefined)

    act(() => {
      view = create(<Transcript rows={[turn]} agents={[smith]} skills={[]} hasSnapshot />)
    })
    expect(disclosures().map((button) => button.props['aria-expanded'])).toEqual([false])

    act(() => { disclosures()[0]!.props.onClick() })
    expect(disclosures().map((button) => button.props['aria-expanded'])).toEqual([true, false])

    act(() => { disclosures()[0]!.props.onClick() })
    expect(disclosures().map((button) => button.props['aria-expanded'])).toEqual([false])
  })

  it('summarises a short run on one closed line', () => {
    const html = renderRun([0, 1, 2, 3, 4, 5, 6].map((index) => read(index)))

    expect(html).toContain('Read files')
    expect(html).not.toContain('Read file-0.ts')
    expect(html).toContain('aria-expanded="false"')
  })

  it('keeps a long run to the same one-line summary', () => {
    const html = renderRun([0, 1, 2, 3, 4, 5, 6, 7].map((index) => read(index)))

    expect(html).toContain('Read files')
    expect(html).not.toContain('Read file-0.ts')
    expect(html).toContain('aria-expanded="false"')
  })

  it('shows only the current call while a run is live', () => {
    const html = renderRun([
      read(0),
      read(1, { tool: 'Search', targets: ['Turn.tsx'], status: 'running' }),
    ], true)

    expect(html).toContain('Searching Turn.tsx')
    expect(html).not.toContain('Read file-0.ts')
    expect(html).toContain('shimmer-text')
    expect(html).toContain('data-text="Searching Turn.tsx"')
    expect(html).toContain('opacity-0')
  })

  it('keeps a settled compact line in the open fold, not while it is still compacting', () => {
    const steps = [read(0)]
    const compacting = runTurn(steps, true)
    compacting.note = { id: 'compact', ts: 1, type: 'system_note', kind: 'info', text: LIVE_COMPACT_NOTE }
    const settled = runTurn(steps)
    settled.note = { id: 'compact', ts: 1, type: 'system_note', kind: 'info', text: LIVE_COMPACT_DONE }
    const open = renderToStaticMarkup(
      <TurnActivity turn={settled} persona={{ name: smith.name, color: smith.color }} agents={[smith]} open />,
    )
    const closed = renderToStaticMarkup(
      <TurnActivity turn={settled} persona={{ name: smith.name, color: smith.color }} agents={[smith]} open={false} />,
    )

    expect(renderToStaticMarkup(
      <TurnActivity turn={compacting} persona={{ name: smith.name, color: smith.color }} agents={[smith]} open />,
    )).not.toContain(LIVE_COMPACT_NOTE)
    expect(open).toContain(LIVE_COMPACT_DONE)
    expect(closed).not.toContain(LIVE_COMPACT_DONE)
  })

  it('still shows Compacted when the turn only replied', () => {
    const turn = runTurn([])
    turn.segments = []
    turn.note = { id: 'compact', ts: 1, type: 'system_note', kind: 'info', text: LIVE_COMPACT_DONE }
    expect(renderToStaticMarkup(
      <TurnActivity turn={turn} persona={{ name: smith.name, color: smith.color }} agents={[smith]} open />,
    )).toContain(LIVE_COMPACT_DONE)
  })

  it('keeps the latest completed call live until the agent speaks', () => {
    const active = renderRun([
      read(0),
      read(1, { tool: 'Search', targets: ['Turn.tsx'] }),
    ], true)
    const spoken = renderRun(
      [read(0), read(1, { tool: 'Search', targets: ['Turn.tsx'] })],
      true,
      [{ messageId: 'message-1', text: 'De zoekresultaten zijn binnen.' }],
    )
    const durableTurn = runTurn([read(0), read(1, { tool: 'Search', targets: ['Turn.tsx'] })], true)
    durableTurn.segments = [
      ...durableTurn.segments,
      { kind: 'reply', key: 'message-1', text: 'De zoekresultaten zijn binnen.', images: [], quoteSources: [] },
    ]
    const durable = renderToStaticMarkup(
      <TurnActivity turn={durableTurn} persona={{ name: smith.name, color: smith.color }} agents={[smith]} open />,
    )

    expect(active).toContain('Searching Turn.tsx')
    expect(active).toContain('shimmer-text')
    expect(active).not.toContain('activity-current-label')
    // The closed line is words only: no kind icon before them, just the chevron after.
    expect(active.match(/<svg/g)).toHaveLength(1)
    expect(active).toContain('mt-[5px]')
    expect(active).not.toContain('Read files, searched')
    expect(spoken).toContain('Read files, searched')
    expect(spoken).not.toContain('shimmer-text')
    expect(durable).toContain('Read files, searched')
    expect(durable).not.toContain('data-text="Read files')
    // Narration with no next step yet: the turn is thinking, and only that line shimmers.
    expect(durable).toContain('data-text="Thinking"')
    const waiting = renderToStaticMarkup(
      <TurnActivity turn={durableTurn} persona={{ name: smith.name, color: smith.color }} agents={[smith]} open waitingOnAgent />,
    )
    // Waiting on another agent's reply is not thinking; the status line already says so.
    expect(waiting).not.toContain('Thinking')
  })

  it('opens an active bundle at the bottom with only its label shimmering', () => {
    const turn = runTurn([
      read(0),
      read(1, { tool: 'Search', targets: ['Turn.tsx'] }),
    ], true)
    const scroller = { scrollTop: 0, scrollHeight: 720, clientHeight: 264, firstElementChild: null }
    let view!: ReactTestRenderer
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    })

    try {
      act(() => {
        view = create(
          <TurnActivity turn={turn} persona={{ name: smith.name, color: smith.color }} agents={[smith]} open />,
          {
            createNodeMock: (element) => element.props['data-activity-scroller'] ? scroller : null,
          },
        )
      })
      const bundle = view.root.findAllByType('button').find((button) => button.props['aria-expanded'] === false)!
      act(() => { bundle.props.onClick() })

      expect(scroller.scrollTop).toBe(scroller.scrollHeight)
      const activityScroller = view.root.find((node) => node.props['data-activity-scroller'])
      expect(activityScroller.props.className).toContain('gap-1 ')
      expect(activityScroller.props.className).not.toContain('overscroll-contain')
      expect(
        view.root.findAll(
          (node) => typeof node.props.className === 'string' && node.props.className.includes('mt-[2px] shrink-0'),
        ),
      ).toHaveLength(0)
      expect(
        view.root.findAll((node) => typeof node.props.className === 'string' && node.props.className.includes('shimmer-text')),
      ).toHaveLength(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('puts landed edits and tool calls from one narration block in one accordion', () => {
    const steps = [read(0)]
    const turn: TurnRow = {
      kind: 'turn',
      key: 'turn:1',
      turnId: 'turn-1',
      agentId: 'smith',
      asks: [],
      drafts: [],
      activities: steps,
      timeline: steps,
      segments: [
        { kind: 'work', key: 'work:step-0', steps },
        { kind: 'edits', key: 'edit-0', edits: [{ path: 'Turn.tsx', before: 'a', after: 'b' }] },
      ],
      answer: [],
      tail: [],
    }
    const html = renderToStaticMarkup(
      <TurnActivity turn={turn} persona={{ name: smith.name, color: smith.color }} agents={[smith]} open />,
    )

    expect(html).toContain('Edited files, read files')
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(1)
  })

  /**
   * The summary names every kind of work the accordion contains. Shell calls stay in
   * that complete record without exposing their command text on the closed line.
   */
  it('names the kinds of work it opens to', () => {
    const steps = [
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((index) => read(index)),
      ...[8, 9, 10].map((index) => read(index, { tool: 'Bash', targets: undefined, command: 'pnpm -r typecheck' })),
    ]

    expect(renderRun(steps)).toContain('Read files, ran commands')
  })

  it('keeps a failed step inside the fold', () => {
    const steps = [0, 1, 2, 3, 4, 5, 6, 7].map((index) =>
      index === 3 ? read(index, { status: 'error', targets: ['README.md'] }) : read(index),
    )
    const html = renderRun(steps)

    expect(html).toContain('Read files')
    expect(html).not.toContain('README.md')
    expect(html).not.toContain('failed')
    expect(html).not.toContain('text-danger')
  })

  it('describes one failed step without a warning treatment', () => {
    const html = renderRun([read(0, { status: 'error', targets: ['README.md'] })])

    expect(html).toContain('Tool had an issue')
    expect(html).not.toContain('README.md')
    expect(html).not.toContain('text-danger')
  })

  it('does not count recoverable failures on the closed line', () => {
    const steps = [0, 1, 2, 3, 4, 5, 6, 7].map((index) =>
      index < 2 ? read(index, { status: 'error' }) : read(index),
    )

    const html = renderRun(steps)
    expect(html).toContain('Read files')
    expect(html).not.toContain('failed')
  })

  /**
   * The rule that spares the reader ninety quiet commands cannot be the rule that
   * swallows the one that came back red. A Codex turn is nearly all shell, so this is
   * the common shape of a failure, not an exotic one.
   */
  it('keeps a failed command in the folded evidence', () => {
    const bash = (index: number, status: ToolStep['status']) =>
      read(index, { tool: 'Bash', targets: undefined, detail: 'pnpm -r typecheck', status })
    const html = renderRun([...[0, 1, 2].map((index) => bash(index, 'done')), bash(3, 'error')])

    expect(html).toContain('Ran commands')
    expect(html).not.toContain('pnpm -r typecheck')
  })

  it('does not lift a failed command onto the closed line of a long run', () => {
    const steps = [
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((index) => read(index)),
      read(8, { tool: 'Bash', targets: undefined, detail: 'pnpm -r typecheck', status: 'error' }),
    ]
    const html = renderRun(steps)

    expect(html).toContain('Read files, tried to run a command')
    expect(html).not.toContain('pnpm -r typecheck')
    expect(html).not.toContain('text-danger')
  })

  /**
   * Reasoning remains evidence inside the accordion, but the closed line names the
   * concrete work instead of adding a second count beside the turn status.
   */
  it('does not add a competing thought count to a mixed run', () => {
    const steps: TurnStep[] = [
      ...[0, 1, 2, 3, 4, 5, 6].map((index) => read(index)),
      { kind: 'reasoning', key: 'thought-1', text: 'Let me check the store.', startedAt: 8 },
    ]
    const html = renderRun(steps)

    expect(html).toContain('Read files')
    expect(html).not.toContain('thought')
    expect(html).not.toContain('steps')
  })
})

describe('the DM outer fold', () => {
  const reply = { kind: 'reply' as const, key: 'reply-1', text: 'Klaar.', images: [], quoteSources: [] }
  // Ten seconds in: past Thinking, before the long-turn line.
  const live = (messages: Array<{ messageId: string; text: string }> = []) => {
    const turn = runTurn([read(0, { status: 'running' })], true, messages)
    return { ...turn, live: { ...turn.live!, startedAt: Date.now() - 10_000 } }
  }

  it('shows no work stream live, only the face and a label at the foot of the chat', () => {
    const html = renderToStaticMarkup(
      <Transcript rows={[live()]} agents={[smith]} skills={[]} hasSnapshot bubbleReplies />,
    )

    expect(html).not.toContain('file-0.ts')
    expect(html).not.toContain('aria-expanded')
    expect(html).not.toContain('Working for')
    expect(html).toContain('data-dm-working=""')
    expect(html).toContain('Smith is working')
    expect(html).toContain('class="shimmer-text" data-text="Reading…"')
  })

  it('still opens a live Work stream without being asked', () => {
    const html = renderToStaticMarkup(
      <Transcript rows={[live()]} agents={[smith]} skills={[]} hasSnapshot />,
    )

    expect(html).toContain('file-0.ts')
    expect(html).toContain('aria-expanded="true"')
    expect(html).not.toContain('data-dm-working')
  })

  it('holds a reply back until it is whole and says she is writing', () => {
    const html = renderToStaticMarkup(
      <Transcript rows={[live([{ messageId: 'm1', text: 'Half a sentence' }])]} agents={[smith]} skills={[]} hasSnapshot bubbleReplies />,
    )

    expect(html).not.toContain('Half a sentence')
    expect(html).toContain('data-text="Writing…"')
  })

  it('leaves a finished bubble without a face and opens its trace from the Worked for line', () => {
    const turn: TurnRow = { ...runTurn([read(0)]), answer: [reply], tail: [reply], startedAt: 1_000, endedAt: 5_000 }
    let view!: ReactTestRenderer
    act(() => {
      view = create(<Transcript rows={[turn]} agents={[smith]} skills={[]} hasSnapshot bubbleReplies />)
    })
    const html = () => JSON.stringify(view.toJSON())
    expect(view.root.findAll((node) => node.props['data-avatar'] !== undefined)).toHaveLength(0)
    expect(html()).not.toContain('data-dm-working')
    expect(html()).toContain('Worked for 4s')
    expect(html()).not.toContain('file-0.ts')
    const toggle = () => view.root.find((node) => node.type === 'button' && node.props['aria-expanded'] !== undefined && String(node.props.className).includes('rounded-md py-1'))

    act(() => { toggle().props.onClick() })
    expect(html()).toContain('file-0.ts')

    act(() => { toggle().props.onClick() })
    expect(html()).not.toContain('file-0.ts')
  })

  it('keeps the Worked for line of a finished turn for hover, hung below the bubbles', () => {
    const turn: TurnRow = { ...runTurn([]), segments: [], answer: [reply], tail: [reply], startedAt: 1_000, endedAt: 5_000 }
    const html = renderToStaticMarkup(<Transcript rows={[turn]} agents={[smith]} skills={[]} hasSnapshot bubbleReplies />)

    expect(html).toContain('Worked for 4s')
    expect(html).toContain('group-hover/turn:opacity-100')
    expect(html).toContain('[@media(hover:hover)]:top-full')
    expect(html).not.toContain('data-avatar')
  })
})

let stamp = 1_786_500_000_000

const event = (partial: Partial<ThreadEvent> & { type: ThreadEvent['type'] }): ThreadEvent =>
  ({ id: `evt_${(stamp += 1)}`, ts: stamp, ...partial }) as ThreadEvent

const threadOf = (events: ThreadEvent[]): ThreadState => ({
  ...emptyThread,
  events,
  usage: {},
  overrides: {},
  liveTurns: [],
  pending: [],
  hasSnapshot: true,
})

const liveThreadOf = (events: ThreadEvent[]): ThreadState => ({
  ...threadOf(events),
  liveTurns: [
    {
      turnId: 'turn-1',
      agentId: 'smith',
      messages: [],
      state: 'running',
      startedAt: stamp,
    },
  ],
})

const segmentsOf = (events: ThreadEvent[]): TurnSegment[] => {
  const turn = rowsOf(threadOf(events)).find((row): row is TurnRow => row.kind === 'turn')
  return turn?.segments ?? []
}

const liveTurnOf = (events: ThreadEvent[]): TurnRow =>
  rowsOf(liveThreadOf(events)).find((row): row is TurnRow => row.kind === 'turn')!

describe('the sentence as the only boundary', () => {
  it('keeps a running edit as the current tool call until it lands', () => {
    const turn = liveTurnOf([
      event({
        type: 'tool_use',
        agentId: 'smith',
        turnId: 'turn-1',
        toolCallId: 'call_1',
        tool: 'Edit',
        edits: [{ path: 'one.ts', before: 'a', after: 'b' }],
      }),
    ])

    expect(turn.segments.map((segment) => segment.kind)).toEqual(['work'])
    const html = renderToStaticMarkup(
      <TurnActivity turn={turn} persona={{ name: smith.name, color: smith.color }} agents={[smith]} open />,
    )
    expect(html).toContain('Editing one.ts')
    expect(html).not.toContain('Edited files')
  })

  it('keeps an open live-edit bundle open when the edit lands', () => {
    const toolUse = event({
      type: 'tool_use',
      agentId: 'smith',
      turnId: 'turn-1',
      toolCallId: 'call_1',
      tool: 'Edit',
      edits: [{ path: 'one.ts', before: 'a', after: 'b' }],
    })
    const live = liveTurnOf([toolUse])
    const settled = liveTurnOf([
      toolUse,
      event({
        type: 'tool_result',
        agentId: 'smith',
        turnId: 'turn-1',
        toolCallId: 'call_1',
        outcome: 'success',
      }),
    ])
    const activity = (turn: TurnRow) => (
      <TurnActivity turn={turn} persona={{ name: smith.name, color: smith.color }} agents={[smith]} open />
    )
    const bundleButton = (view: ReactTestRenderer) =>
      view.root.findAllByType('button').find((button) => button.props['aria-expanded'] !== undefined)!
    let view!: ReactTestRenderer

    act(() => { view = create(activity(live)) })
    act(() => { bundleButton(view).props.onClick() })
    expect(bundleButton(view).props['aria-expanded']).toBe(true)

    act(() => { view.update(activity(settled)) })
    expect(bundleButton(view).props['aria-expanded']).toBe(true)
    const settledMarkup = renderToStaticMarkup(activity(settled))
    expect(settledMarkup).toContain('Editing one.ts')
    expect(settledMarkup).toContain('shimmer-text')
    expect(settledMarkup).not.toContain('Edited files')
  })

  /**
   * The Argus turn that read as three acts. One sentence, one move of code, and the
   * reads it took to make it — split into three edit groups purely because a read
   * landed between two writes.
   */
  it('keeps one sentence of writing as one group of files', () => {
    const wrote = (path: string) =>
      event({
        type: 'tool_use',
        agentId: 'smith',
        turnId: 'turn-1',
        tool: 'Edit',
        edits: [{ path, before: 'a', after: 'b' }],
      })
    const segments = segmentsOf([
      event({ type: 'agent_message', agentId: 'smith', turnId: 'turn-1', text: "I'll move that." }),
      wrote('one.ts'),
      event({ type: 'tool_use', agentId: 'smith', turnId: 'turn-1', tool: 'Read', targets: ['two.ts'] }),
      wrote('two.ts'),
      event({ type: 'tool_use', agentId: 'smith', turnId: 'turn-1', tool: 'Read', targets: ['three.ts'] }),
      wrote('three.ts'),
      event({ type: 'agent_message', agentId: 'smith', turnId: 'turn-1', text: 'Done.' }),
    ])

    const edits = segments.filter((segment) => segment.kind === 'edits')
    expect(edits).toHaveLength(1)
    expect(edits[0]?.kind === 'edits' ? edits[0].edits.map((edit) => edit.path) : []).toEqual([
      'one.ts',
      'two.ts',
      'three.ts',
    ])
    // And the reads between them are still one run, not one per write.
    expect(segments.filter((segment) => segment.kind === 'work')).toHaveLength(1)
  })

  /**
   * Claude attaches the edits from the tool's *input*, before the call has run, so a
   * write that failed still carries the change it meant to make. Rendering that as a
   * file change ends the turn claiming lines that are not on disk, and hides the
   * failure at the same time, since the file group has no red.
   */
  it('does not show a failed write as a change that landed', () => {
    const segments = segmentsOf([
      event({
        type: 'tool_use',
        agentId: 'smith',
        turnId: 'turn-1',
        toolCallId: 'call_1',
        tool: 'Edit',
        edits: [{ path: 'one.ts', before: 'a', after: 'b' }],
      }),
      event({
        type: 'tool_result',
        agentId: 'smith',
        turnId: 'turn-1',
        toolCallId: 'call_1',
        outcome: 'error',
      }),
    ])

    expect(segments.filter((segment) => segment.kind === 'edits')).toHaveLength(0)
    expect(segments.map((segment) => segment.kind)).toEqual(['work'])
  })

  /**
   * Stop is the other way a result never arrives, and the sweep that settles a killed
   * turn writes `done` because the step is no longer going anywhere. That word is not
   * evidence: the write was sent and the process was killed, so nothing knows whether
   * it reached the disk. Claiming it did is the worse of the two guesses.
   */
  it('does not show an interrupted write as a change that landed', () => {
    const segments = segmentsOf([
      event({
        type: 'tool_use',
        agentId: 'smith',
        turnId: 'turn-1',
        toolCallId: 'call_1',
        tool: 'Edit',
        edits: [{ path: 'one.ts', before: 'a', after: 'b' }],
      }),
      event({ type: 'system_note', agentId: 'smith', turnId: 'turn-1', kind: 'aborted', text: 'Stopped.' }),
    ])

    expect(segments.filter((segment) => segment.kind === 'edits')).toHaveLength(0)
    expect(segments.map((segment) => segment.kind)).toEqual(['work'])
  })

  /**
   * The same sweep settles every unresolved step of every finished turn, and plenty of
   * ordinary turns never echo a result for their last call. So the rule above has to
   * tell "the turn was cut off mid-call" from "the turn finished and the echo is
   * missing"; the note is that difference. Without this the fix blanks the changed
   * files of normal turns, which is the same lie pointing the other way.
   */
  it('still trusts a write on a turn that ended normally', () => {
    const segments = segmentsOf([
      event({
        type: 'tool_use',
        agentId: 'smith',
        turnId: 'turn-1',
        tool: 'Edit',
        edits: [{ path: 'one.ts', before: 'a', after: 'b' }],
      }),
      event({ type: 'turn_result', agentId: 'smith', turnId: 'turn-1' }),
    ])

    expect(segments.filter((segment) => segment.kind === 'edits')).toHaveLength(1)
  })

  it('still starts a new group at the next thing the agent says', () => {
    const wrote = (path: string) =>
      event({
        type: 'tool_use',
        agentId: 'smith',
        turnId: 'turn-1',
        tool: 'Edit',
        edits: [{ path, before: 'a', after: 'b' }],
      })
    const segments = segmentsOf([
      event({ type: 'agent_message', agentId: 'smith', turnId: 'turn-1', text: 'First the schema.' }),
      wrote('one.ts'),
      event({ type: 'agent_message', agentId: 'smith', turnId: 'turn-1', text: 'Now the store.' }),
      wrote('two.ts'),
      event({ type: 'agent_message', agentId: 'smith', turnId: 'turn-1', text: 'Done.' }),
    ])

    expect(segments.filter((segment) => segment.kind === 'edits')).toHaveLength(2)
  })
})

describe('a group of file changes', () => {
  const hunk = (path: string, added: number) => ({
    path,
    before: 'x\n',
    after: `x\n${Array.from({ length: added }, (_, line) => `line ${line}`).join('\n')}\n`,
  })

  it('states one file once, with its counts summed over every call', () => {
    const html = renderToStaticMarkup(
      <EditGroup edits={[hunk('src/index.ts', 3), hunk('src/index.ts', 2), hunk('src/index.ts', 1)]} />,
    )

    expect(html).toContain('index.ts')
    expect(html).toContain('3 changes')
    // Six lines added across the three calls, not three rows each claiming their own.
    expect(html).toContain('+6')
    expect(html.match(/index\.ts/g)).toHaveLength(1)
  })

  it('counts files on the group line, because files are what it opens to', () => {
    const html = renderToStaticMarkup(
      <EditGroup edits={[hunk('src/index.ts', 3), hunk('src/store.ts', 2), hunk('src/store.ts', 2)]} />,
    )

    expect(html).toContain('Changed 2 files')
    expect(html).not.toContain('Edited files')
  })

  it('leaves a single change as the change itself', () => {
    const html = renderToStaticMarkup(<EditGroup edits={[hunk('src/index.ts', 3)]} />)

    expect(html).toContain('index.ts')
    expect(html).not.toContain('changes')
    expect(html).not.toContain('Changed 1 file')
  })
})

describe('a Session plan', () => {
  const planned = (running: boolean) => rowsOf({
    ...emptyThread,
    events: [
      { id: 'prompt', ts: 1, type: 'user_message', text: 'Ship it.', mentions: [] },
      { id: 'plan', ts: 2, type: 'todo_update', turnId: 'turn-1', agentId: smith.id,
        todos: [{ text: 'Reproduce the shift', status: 'completed' }, { text: 'Reserve the space', status: 'in_progress' }] },
      { id: 'read', ts: 3, type: 'tool_use', turnId: 'turn-1', agentId: smith.id, tool: 'Read', toolCallId: 'read' },
      ...running ? [] : [
        { id: 'answer', ts: 4, type: 'agent_message' as const, turnId: 'turn-1', agentId: smith.id, text: 'Space reserved.' },
        { id: 'result', ts: 5, type: 'turn_result' as const, turnId: 'turn-1', agentId: smith.id },
      ],
    ],
    liveTurns: running ? [{ turnId: 'turn-1', agentId: smith.id, state: 'running', startedAt: 2, messages: [] }] : [],
  }, 'project')

  it('stands once at the end of the turn, pinned only while it runs', () => {
    const live = renderToStaticMarkup(<Transcript rows={planned(true)} agents={[smith]} skills={[]} hasSnapshot pinPlan />)
    expect(live.match(/Reserve the space/g)).toHaveLength(1)
    expect(live).toMatch(/class="mt-2\.5 sticky[^"]*"><section aria-label="Plan"/)
    const done = renderToStaticMarkup(<Transcript rows={planned(false)} agents={[smith]} skills={[]} hasSnapshot pinPlan />)
    expect(done.match(/Reserve the space/g)).toHaveLength(1)
    expect(done).not.toContain('sticky')
    expect(done.indexOf('Space reserved.')).toBeLessThan(done.indexOf('Reserve the space'))
  })

  it('draws Confirm’s commit request as its steps, never its text', () => {
    const text = '[Manor] Sam confirmed the ready result, and that is his approval to commit. Commit …'
    const rows = rowsOf({ ...emptyThread, events: [{ id: 'confirm', ts: 1, type: 'user_message', text, mentions: [] }] }, 'project')
      .map((row) => row.kind === 'event' ? { ...row, confirmTasks: [{ text: 'Commit this Session’s changes', status: 'in_progress' as const }] } : row)
    const html = renderToStaticMarkup(<Transcript rows={rows} agents={[smith]} skills={[]} hasSnapshot />)
    expect(html).toContain('aria-label="Confirm"')
    expect(html).toContain('Commit this Session’s changes')
    expect(html).not.toContain('approval to commit')
  })
})
