import type { AgentConfig, MemoryTrace, Project, SkillConfig, ThreadEvent } from '@manor/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CARD_WIDTH, MemoryChangesCard, MemoryTraceCard, placeCard } from '../src/components/MessageFooter'
import { Transcript } from '../src/components/Transcript'
import { messageTime, readsLabel } from '../src/messageMeta'
import { emptyThread, emptyWorkspace, reduce, rowsOf, type ThreadState } from '../src/state'

/**
 * The row under a finished answer, and the one thing on it that is new.
 *
 * Manor watches every read go past, so what a turn *opened* is a record. What it
 * *used* is a second cheap model's reading of the answer afterwards, so it is a
 * guess. The whole point of this card is that a reader can tell those two apart at a
 * glance, and the endings where nothing was used are the ones worth protecting: a
 * turn that read three memory files and leaned on none of them is invisible from the
 * outside, and that invisibility is the bug this was built to surface.
 */

const sage: AgentConfig = {
  id: 'sage',
  name: 'Sage',
  color: '#B8E986',
  character: 'You are Sage.',
  driver: 'claude',
  effort: 'high',
  allowedTools: [],
  mcpServers: [],
  memoryScope: true,
  description: 'Advisor.',
  role: 'Advisor',
  isCos: false,
}

const SKILLS: SkillConfig[] = []

const event = (partial: Partial<ThreadEvent> & { type: ThreadEvent['type'] }, at: number): ThreadEvent =>
  ({ id: `evt_${at}`, ts: at, ...partial }) as ThreadEvent

const thread = (events: ThreadEvent[], liveTurns: ThreadState['liveTurns'] = []): ThreadState => ({
  ...emptyThread,
  events,
  usage: {},
  overrides: {},
  liveTurns,
  pending: [],
  hasSnapshot: true,
})

const render = (
  events: ThreadEvent[],
  liveTurns: ThreadState['liveTurns'] = [],
  onReply?: () => void,
  bubbleReplies = false,
  threadProject?: Project,
) =>
  renderToStaticMarkup(
    <Transcript
      rows={rowsOf(thread(events, liveTurns), bubbleReplies ? 'dm' : 'project')}
      agents={[sage]}
      skills={SKILLS}
      hasSnapshot
      bubbleReplies={bubbleReplies}
      {...(threadProject === undefined ? {} : { threadProject })}
      {...(onReply === undefined ? {} : { onReply })}
    />,
  )

/** Late August 2026, so the clock under a turn renders a date a reader would recognise. */
const START = 1_787_400_000_000

const STRUCTURED = '/Users/sam/notes/memory/structured/feedback_kickoff_after_dev_check.md'
const PROJECT = '/Users/sam/notes/memory/projects/atlas.md'

const used: MemoryTrace = {
  reads: [
    { source: 'injected', path: PROJECT },
    { source: 'on_demand', path: STRUCTURED, fromLine: 1, toLine: 40 },
  ],
  summary: {
    status: 'used',
    derivation: 'model',
    items: [{ text: 'kickoff pas na de dev-check plannen', sourcePath: STRUCTURED }],
  },
}

describe('the memory card', () => {
  it('names what the answer used, and where each piece came from', () => {
    const html = renderToStaticMarkup(<MemoryTraceCard trace={used} />)

    expect(html).toContain('kickoff pas na de dev-check plannen')
    // The basename, because a 60-character absolute path in a 13px row is a path
    // nobody reads; the full one stays on the chip's title.
    expect(html).toContain('feedback_kickoff_after_dev_check.md')
    expect(html).toContain(STRUCTURED)
  })

  it('cuts a long claim to three lines with the way back under it', () => {
    // The deriving model writes at whatever length it likes. Five loose paragraphs
    // made the card taller than the answer it was explaining, so each claim is cut
    // to the same clamp the chat bubbles use, at a third of their height.
    const html = renderToStaticMarkup(
      <MemoryTraceCard
        trace={{
          reads: [{ source: 'on_demand', path: STRUCTURED }],
          summary: {
            status: 'used',
            derivation: 'model',
            items: [{ text: 'x'.repeat(400), sourcePath: STRUCTURED }],
          },
        }}
      />,
    )

    expect(html).toContain('class="clamp')
    expect(html).toContain('--clamp-lines:3')
  })

  it('puts the source under its claim, not in a gutter beside it', () => {
    const html = renderToStaticMarkup(<MemoryTraceCard trace={used} />)
    const claim = html.indexOf('kickoff pas na de dev-check plannen')
    const source = html.indexOf('feedback_kickoff_after_dev_check.md')

    expect(claim).toBeGreaterThan(-1)
    expect(source).toBeGreaterThan(claim)
  })

  it('says the use was inferred, never that it was observed', () => {
    expect(renderToStaticMarkup(<MemoryTraceCard trace={used} />)).toContain('Inferred after the turn')
  })

  it('keeps the two sources apart, because only one of them is evidence of routing', () => {
    // Ring 1 and the project file arrive at the start of every chat and say nothing
    // about whether map.md is doing its job. A file opened mid-turn is the signal.
    const html = renderToStaticMarkup(<MemoryTraceCard trace={used} />)
    expect(html).toContain('1 file read on request')
    expect(html).toContain('1 file injected at start')
  })

  it('marks the read-and-unused turn, which is the one the stream cannot show', () => {
    const html = renderToStaticMarkup(
      <MemoryTraceCard
        trace={{
          reads: [{ source: 'on_demand', path: STRUCTURED }, { source: 'injected', path: PROJECT }],
          summary: { status: 'none', derivation: 'model' },
        }}
      />,
    )

    expect(html).toContain('Nothing from memory in the answer')
    expect(html).toContain('bg-danger')
    // And it still names what was opened, because "which files did it ignore" is the
    // next question anyone asks.
    expect(html).toContain('feedback_kickoff_after_dev_check.md')
    expect(html).toContain('atlas.md')
  })

  it('names every read file whole, however many there are', () => {
    // Six of these used to be chips in a wrapping row. Flex shrank them all together
    // and the list rendered as "m… r… I… s… l…", which named nothing at all.
    const reads = [
      'rules.md',
      'style.md',
      'private/INDEX.md',
      'private/life.md',
      'private/roadmap.md',
      'memory/projects/atlas.md',
    ].map((name) => ({ source: 'on_demand' as const, path: `/Users/sam/notes/${name}` }))
    const html = renderToStaticMarkup(
      <MemoryTraceCard trace={{ reads, summary: { status: 'none', derivation: 'model' } }} />,
    )

    for (const name of ['rules.md', 'style.md', 'INDEX.md', 'life.md', 'roadmap.md', 'atlas.md']) {
      expect(html).toContain(`>${name}</span>`)
    }
    // The folder a basename drops is not lost, it is on the title.
    expect(html).toContain('/Users/sam/notes/private/life.md')
  })

  it('states the zero outright rather than showing an empty card', () => {
    const html = renderToStaticMarkup(
      <MemoryTraceCard trace={{ reads: [], summary: { status: 'not_read', derivation: 'none' } }} />,
    )

    expect(html).toContain('No memory was read this turn.')
    // No colour on it: reading nothing is a fact about the turn, not a failure.
    expect(html).not.toContain('bg-danger')
  })

  it('separates "used nothing" from "could not tell", and colours only the first', () => {
    const html = renderToStaticMarkup(
      <MemoryTraceCard
        trace={{ reads: [{ source: 'on_demand', path: STRUCTURED }], summary: { status: 'unavailable', derivation: 'model' } }}
      />,
    )

    expect(html).toContain('Could not establish what the answer used')
    expect(html).not.toContain('bg-danger')
    expect(html).not.toContain('Inferred after the turn')
  })
})

describe('the footer under a turn', () => {
  it('gives every DM beat its own hover-only actions', () => {
    const html = render([
      event({ type: 'agent_message', agentId: 'sage', turnId: 'turn_beats', messageId: 'm1', text: 'I looked.' }, START + 1_000),
      event({ type: 'agent_message', agentId: 'sage', turnId: 'turn_beats', messageId: 'm2', text: 'I found it.' }, START + 2_000),
      event({ type: 'turn_result', agentId: 'sage', turnId: 'turn_beats' }, START + 3_000),
    ], [], undefined, true)

    expect(html.match(/bg-bubble/g)).toHaveLength(2)
    expect(html.match(/group-hover\/beat:opacity-100/g)).toHaveLength(2)
    // Finished bubbles carry no face; the face only works, at the foot of the chat.
    expect(html).not.toContain('data-avatar')
    expect(html).not.toContain('<time')
  })

  it('leaves the Work answer flat with one turn footer', () => {
    const html = render([
      event({ type: 'agent_message', agentId: 'sage', turnId: 'turn_work', messageId: 'm1', text: 'Built it.' }, START + 1_000),
      event({ type: 'turn_result', agentId: 'sage', turnId: 'turn_work' }, START + 2_000),
    ])

    expect(html).not.toContain('rounded-bl-sm')
    expect(html).toContain('Copy the reply')
    // Only the Worked for line waits for hover; the footer stays shown.
    expect(html.match(/group-hover\/turn:opacity-100/g)).toHaveLength(1)
    expect(html).toContain('<time')
  })

  it('stacks consecutive user messages at six pixels in DMs and Work', () => {
    const events = [
      event({ type: 'user_message', text: 'One.', mentions: [] }, START + 1_000),
      event({ type: 'user_message', text: 'Two.', mentions: [] }, START + 2_000),
    ]

    expect(render(events, [], undefined, true)).toContain('-mt-[26px]')
    expect(render(events)).toContain('-mt-[26px]')
    const panel = renderToStaticMarkup(<Transcript rows={rowsOf(thread(events), 'project')} agents={[sage]} skills={[]} hasSnapshot variant="panel" />)
    expect(panel).toContain('-mt-[18px]')
    expect(panel).not.toContain('-mt-[26px]')
  })

  // 2026-10-12: a DM stop shows nothing at all; the trace stays behind Worked for.
  it('says nothing about a stop in a DM and keeps its trace control', () => {
    const html = render([
      event({ type: 'agent_message', agentId: 'sage', turnId: 'turn_stop', messageId: 'm1', text: 'Partial.' }, START + 1_000),
      event({ type: 'tool_use', agentId: 'sage', turnId: 'turn_stop', toolCallId: 'call_1', tool: 'Read' }, START + 2_000),
      event({ type: 'system_note', kind: 'aborted', agentId: 'sage', turnId: 'turn_stop', text: 'Stopped by you' }, START + 3_000),
    ], [], undefined, true)

    expect(html).toContain('Partial.')
    expect(html).not.toContain('Stopped')
    expect(html).toContain('Worked for 2s')
    expect(html).toContain('aria-expanded="false"')
  })

  it('gives an answered stopped DM no Stopped status and no blank status row', () => {
    const html = render([
      event({ type: 'agent_message', agentId: 'sage', turnId: 'turn_stop', messageId: 'm1', text: 'Partial.' }, START + 1_000),
      event({ type: 'system_note', kind: 'aborted', agentId: 'sage', turnId: 'turn_stop', text: 'Stopped by you' }, START + 2_000),
    ], [], undefined, true)

    expect(html).toContain('Partial.')
    expect(html).not.toContain('Stopped')
    expect(html).not.toContain('disabled=""></button>')
  })

  it('keeps a turn stopped after internal activity as Stopped in a Session, and drops it from a DM', () => {
    const events = [
      event({ type: 'reasoning', agentId: 'sage', turnId: 'turn_stop', text: 'Checking the existing state.' }, START + 1_000),
      event({ type: 'tool_use', agentId: 'sage', turnId: 'turn_stop', toolCallId: 'call_1', tool: 'Read' }, START + 2_000),
      event({ type: 'system_note', kind: 'aborted', agentId: 'sage', turnId: 'turn_stop', text: 'Stopped by you' }, START + 3_000),
    ]

    expect(render(events)).toContain('Sage')
    expect(render(events)).toContain('>Stopped</span>')
    expect(render(events, [], undefined, true)).not.toContain('Sage')
  })

  it('keeps the changed-files summary in Work and removes it from DMs and the project thread', () => {
    const events = [
      event({
        type: 'tool_use',
        agentId: 'sage',
        turnId: 'turn_edit',
        toolCallId: 'call_1',
        tool: 'Edit',
        edits: [{ path: 'notes.md', before: 'old', after: 'new' }],
      }, START + 1_000),
      event({ type: 'agent_message', agentId: 'sage', turnId: 'turn_edit', messageId: 'm1', text: 'Done.' }, START + 2_000),
      event({ type: 'turn_result', agentId: 'sage', turnId: 'turn_edit' }, START + 3_000),
    ]

    expect(render(events)).toContain('1 changed file')
    expect(render(events, [], undefined, true)).not.toContain('changed file')
    const thread = { id: 'p', name: 'Manor', color: '#14A8B8', icon: 'folder', repoPaths: [], memoryScope: 'project' } as Project
    expect(render(events, [], undefined, false, thread)).not.toContain('changed file')
  })

  it('hangs the memory mark under a finished answer', () => {
    const html = render([
      event({ type: 'user_message', text: 'Wanneer plan ik de kickoff?', mentions: ['sage'] }, START + 1_000),
      event({ type: 'agent_message', agentId: 'sage', turnId: 'turn_1', messageId: 'm1', text: 'Na de dev-check.' }, START + 2_000),
      event({ type: 'turn_result', agentId: 'sage', turnId: 'turn_1', memoryTrace: used }, START + 3_000),
    ])

    expect(html).toContain('Memory used, 1 note')
    expect(html).toContain('Copy the reply')
    // Closed: the card is a portal that only exists once a pointer asks for it.
    expect(html).not.toContain('kickoff pas na de dev-check plannen')
  })

  it('adds the memory mark when the judgment lands after the turn closed', () => {
    const closed = event({ type: 'turn_result', agentId: 'sage', turnId: 'turn_2' }, START + 3_000)
    const answered = thread([
      event({ type: 'agent_message', agentId: 'sage', turnId: 'turn_2', messageId: 'm1', text: 'Na de dev-check.' }, START + 2_000),
      closed,
    ])
    const state = reduce(
      { ...emptyWorkspace, threads: { chat_1: answered } },
      { type: 'event', chatId: 'chat_1', event: { ...closed, memoryTrace: used } as ThreadEvent },
      START + 9_000,
    )
    const patched = state.threads.chat_1!

    expect(patched.events).toHaveLength(2)
    for (const kind of ['project', 'dm'] as const) {
      const html = renderToStaticMarkup(
        <Transcript rows={rowsOf(patched, kind)} agents={[sage]} skills={SKILLS} hasSnapshot bubbleReplies={kind === 'dm'} />,
      )
      expect(html).toContain('Memory used, 1 note')
    }
  })

  it('adds the memory-changes mark once the writer diff lands, in Work and in DMs', () => {
    const daily = '/Users/sam/notes/memory/daily/2026-09-28.md'
    const events = [
      event({ type: 'agent_message', agentId: 'sage', turnId: 'turn_3', messageId: 'm1', text: 'Klaar.' }, START + 1_000),
      event({
        type: 'turn_result',
        agentId: 'sage',
        turnId: 'turn_3',
        memoryChanges: [{ path: daily, lines: [{ kind: 'added', text: '- [m/sage] Kickoff after dev check.' }] }],
      }, START + 2_000),
    ]

    expect(render(events)).toContain('Memory updated, 1 change')
    expect(render(events, [], undefined, true)).toContain('Memory updated, 1 change')
    expect(render(events.slice(0, 1).concat(event({ type: 'turn_result', agentId: 'sage', turnId: 'turn_3' }, START + 2_000))))
      .not.toContain('Memory updated')
    // A DM turn with no reply anywhere has no bubble for the notepad, and no row of its own.
    expect(render(events.slice(1), [], undefined, true)).not.toContain('Memory updated')
  })

  it('shows a replaced memory line as the old one going and the new one arriving', () => {
    const html = renderToStaticMarkup(
      <MemoryChangesCard
        changes={[{
          path: '/Users/sam/notes/memory/daily/2026-09-28.md',
          lines: [{ kind: 'replaced', before: '- [m/sage] Kickoff open.', after: '- [m/sage] Kickoff 3 Oct.' }],
        }]}
      />,
    )

    expect(html).toContain('2026-09-28.md')
    expect(html.indexOf('Kickoff open.')).toBeLessThan(html.indexOf('Kickoff 3 Oct.'))
    expect(html).toContain('Removed: ')
    expect(html).toContain('Added: ')
  })

  it('leaves the mark off a turn that carries no trace, and keeps the rest of the row', () => {
    const html = render([
      event({ type: 'agent_message', agentId: 'sage', turnId: 'turn_2', messageId: 'm1', text: 'Ja.' }, START + 1_000),
      event({ type: 'turn_result', agentId: 'sage', turnId: 'turn_2' }, START + 2_000),
    ])

    // Memory off, or a transcript written before any of this existed. Either way the
    // absence must read as "nothing to say", never as a turn that used nothing.
    expect(html).not.toContain('Memory')
    expect(html).toContain('Copy the reply')
  })

  it('offers reply beside copy only when the chat enables targeting', () => {
    const events = [
      event({ type: 'agent_message', agentId: 'sage', turnId: 'turn_reply', messageId: 'm1', text: 'Target me.' }, START + 1_000),
      event({ type: 'turn_result', agentId: 'sage', turnId: 'turn_reply' }, START + 2_000),
    ]

    expect(render(events)).not.toContain('Reply to this message')
    expect(render(events, [], () => undefined)).toContain('Reply to this message')
  })

  it('shows the targeted answer on the sent user message', () => {
    const html = render([
      event({
        type: 'user_message',
        text: 'Why?',
        mentions: [],
        replyTo: { turnId: 'turn_reply', agentId: 'sage', text: 'Because the boundary owns it.' },
      }, START + 1_000),
    ])

    expect(html).toContain('Sage')
    expect(html).toContain('Because the boundary owns it.')
    expect(html).toContain('Why?')
  })

  it('keeps a lone clock off a turn that never said anything', () => {
    const html = render([
      event({ type: 'user_message', text: 'Doe iets.', mentions: ['sage'] }, START + 1_000),
      event({ type: 'turn_result', agentId: 'sage', turnId: 'turn_4' }, START + 2_000),
    ])

    // The turn already has a line saying it finished without a reply; a timestamp
    // hanging to the right of that is a footer about nothing.
    expect(html).toContain('finished without a reply')
    expect(html).not.toContain('<time')
  })

  it('says nothing under a turn that is still talking', () => {
    const html = render(
      [
        event({ type: 'user_message', text: 'Doe iets.', mentions: ['sage'] }, START + 1_000),
        event(
          { type: 'agent_message', agentId: 'sage', turnId: 'turn_3', messageId: 'm1', text: 'Bezig' },
          START + 2_000,
        ),
      ],
      [{ turnId: 'turn_3', agentId: 'sage', messages: [], state: 'running', startedAt: START + 1_000 }],
    )

    // Half an answer is not a message: copying it copies a sentence that is about to
    // be longer, and the trace is derived only after the last word.
    expect(html).not.toContain('Copy the reply')
  })
})

describe('where the card lands', () => {
  const WINDOW = { width: 1600, height: 900 }
  const box = (left: number, top: number, width = 28, height = 28): DOMRect =>
    ({ left, top, right: left + width, bottom: top + height }) as DOMRect

  /** The thread at its 375px minimum with the browser rail docked beside it. */
  const NARROW_STAGE = box(72, 0, 375, 900)

  it('stays inside the thread when the browser is docked beside it', () => {
    const card = placeCard(box(90, 500), NARROW_STAGE, WINDOW)

    expect(card.left).toBeGreaterThanOrEqual(NARROW_STAGE.left)
    expect(card.left + card.width).toBeLessThanOrEqual(NARROW_STAGE.right)
  })

  it('gives up width rather than hang out of a narrow side chat', () => {
    const panel = box(1200, 0, 340, 900)
    const card = placeCard(box(1216, 400), panel, WINDOW)

    expect(card.width).toBeLessThan(CARD_WIDTH)
    expect(card.left + card.width).toBeLessThanOrEqual(panel.right)
  })

  it('keeps its full width where the thread has room for it', () => {
    expect(placeCard(box(400, 500), box(72, 0, 1400, 900), WINDOW).width).toBe(CARD_WIDTH)
  })

  it('sits over the answer, and drops below only when there is no room above', () => {
    expect(placeCard(box(400, 700), NARROW_STAGE, WINDOW).upward).toBe(true)
    // A turn at the very top of a freshly scrolled thread: above the mark there is
    // less than a card, so it opens downward instead of off the top of the window.
    const flipped = placeCard(box(400, 40), NARROW_STAGE, WINDOW)
    expect(flipped.upward).toBe(false)
    expect(flipped.top).toBeGreaterThan(40)
  })

  it('falls back to the window when nothing marks a region', () => {
    const card = placeCard(box(400, 500), null, WINDOW)
    expect(card.left).toBe(400)
    expect(card.width).toBe(CARD_WIDTH)
  })
})

describe('when a message was said', () => {
  const at = (iso: string) => new Date(iso).getTime()

  it('drops the day on anything from today', () => {
    expect(messageTime(at('2026-08-27T13:32:00'), at('2026-08-27T18:00:00'))).toBe('13:32')
  })

  it('names the weekday for the last week', () => {
    expect(messageTime(at('2026-08-26T09:05:00'), at('2026-08-27T18:00:00'))).toBe('Yesterday 09:05')
    expect(messageTime(at('2026-08-23T09:05:00'), at('2026-08-27T18:00:00'))).toBe('Sunday 09:05')
  })

  it('stops calling it Wednesday once Wednesday is ambiguous', () => {
    // The failure this exists to prevent: a weekday on a three-week-old turn is a
    // label that lies, under every message in the transcript.
    expect(messageTime(at('2026-08-05T09:05:00'), at('2026-08-27T18:00:00'))).toBe('5 Aug 09:05')
  })

  it('counts calendar days, not elapsed hours', () => {
    // Four hours apart, but "yesterday" is the true word for it.
    expect(messageTime(at('2026-08-26T23:50:00'), at('2026-08-27T03:50:00'))).toBe('Yesterday 23:50')
  })
})

describe('what a turn opened', () => {
  it('drops the half that is zero instead of printing it', () => {
    expect(readsLabel([{ source: 'on_demand', path: STRUCTURED }])).toBe('1 file read on request')
    expect(readsLabel([{ source: 'injected', path: PROJECT }])).toBe('1 file injected at start')
  })

  it('leads with the half that is evidence of routing', () => {
    expect(
      readsLabel([
        { source: 'injected', path: PROJECT },
        { source: 'on_demand', path: STRUCTURED },
        { source: 'on_demand', path: '/Users/sam/notes/memory/daily/2026-08-27.md' },
      ]),
    ).toBe('2 files read on request, 1 file injected at start')
  })
})
