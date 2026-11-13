import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AgentConfig, ThreadEvent, UserInputQuestion } from '@manor/contracts'
import { SKIPPED_ANSWER } from '../src/askFlow'
import { AskAnswers, AskCard, AskDock } from '../src/components/AskCard'
import { Transcript } from '../src/components/Transcript'
import { TodoList } from '../src/components/TodoList'
import { emptyThread, openAsk, rowsOf, toggleTaskFolded, type TurnRow } from '../src/state'

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

const questions: UserInputQuestion[] = [
  {
    id: 'dir',
    question: 'Which way?',
    options: [{ label: 'Left' }, { label: 'Right', description: 'The long road' }],
  },
  { id: 'pace', question: 'How fast?', options: [{ label: 'Now' }, { label: 'Later' }] },
  { id: 'who', question: 'Who drives?', options: [{ label: 'You' }, { label: 'Me' }] },
]

const card = (props: Partial<Parameters<typeof AskCard>[0]> = {}) =>
  renderToStaticMarkup(
    <AskCard questions={questions} accent="#D08A3E" onSubmit={() => true} {...props} />,
  )

const turn = (patch: Partial<TurnRow> = {}): TurnRow => ({
  kind: 'turn',
  key: 'turn:1',
  turnId: 'turn-1',
  agentId: 'smith',
  asks: [],
  drafts: [],
  activities: [],
  timeline: [],
  segments: [],
  answer: [],
  tail: [],
  live: { turnId: 'turn-1', agentId: 'smith', messages: [], state: 'running', startedAt: 1 },
  ...patch,
})

describe('AskCard', () => {
  it('asks one question at a time and says which one it is on', () => {
    const html = card()

    expect(html).toContain('1/3')
    expect(html).toContain('Which way?')
    // The next two are not on screen yet: this is a walk, not a stack.
    expect(html).not.toContain('How fast?')
    expect(html).not.toContain('Who drives?')
  })

  it('drops the counter for a single question, which has no steps to count', () => {
    const html = card({ questions: [questions[0]!] })

    expect(html).not.toContain('1/1')
    expect(html).toContain('Which way?')
  })

  it('numbers every row, the free line included, so the keyboard can answer it', () => {
    const html = card()

    expect(html).toContain('>1</span>')
    expect(html).toContain('>2</span>')
    // Two options, so "Other" is the third row and wears the third number.
    expect(html).toContain('>3</span>')
    expect(html).toContain('Other')
  })

  it('keeps the free line folded away until its row is picked', () => {
    expect(card()).not.toContain('Type your own answer here')
  })

  // Allow or deny is the whole decision on a permission card, and the broker reads
  // anything else as a refusal, so a third row inviting a typed answer would offer a
  // way of answering that cannot land.
  it('leaves the free line off a card whose options are the whole answer', () => {
    const html = card({
      questions: [{
        id: 'allow_effect',
        header: 'gmail',
        question: 'gmail.send_message may change external state. Allow this call?',
        options: [{ label: 'Allow once' }, { label: 'Deny' }],
        optionsOnly: true,
      }],
    })

    expect(html).toContain('Allow once')
    expect(html).toContain('Deny')
    expect(html).not.toContain('>Other</span>')
    // Two rows, so no third number and nothing to type into.
    expect(html).not.toContain('>3</span>')
    expect(html).not.toContain('Type your own answer here')
  })

  it('steps forward until the last question, which sends', () => {
    expect(card()).toContain('Next')
    expect(card()).not.toContain('Send<')
    expect(card({ questions: [questions[0]!] })).toContain('Send')
  })

  it('offers no way back from the first step', () => {
    expect(card()).not.toContain('>Back<')
  })

  it('lets one question be passed over and all of them be dismissed', () => {
    const html = card()

    expect(html).toContain('Skip')
    expect(html).toContain('Skip all of it and let the agent decide')
  })

  it('wears the sidebar rows own colours, borderless, with a pointer on them', () => {
    const html = card()

    expect(html).toContain('bg-surface-2')
    expect(html).toContain('hover:bg-user-bg')
    expect(html).toContain('cursor-pointer')
    expect(html).toContain('border-0')
    expect(html).not.toContain('hover:border-dim')
  })

  it('sets the question at the option rows body size, so a long one reads as card text', () => {
    const html = card()

    expect(html).toMatch(/text-\[14px\] leading-5 font-medium text-text/)
    expect(html).not.toContain('text-[16px]')
    expect(html).not.toContain('text-meta">Which way?')
  })

  it('carries the waiting personas colour on the step chip', () => {
    expect(card()).toContain('--accent:#D08A3E')
  })

  it('says nothing about a queue when there is none, and counts it when there is', () => {
    expect(card()).not.toContain('after this')
    expect(card({ more: 1 })).toContain('One more card after this')
    expect(card({ more: 2 })).toContain('2 more cards after this')
  })

  // The right sidebar's surface, hairline included: on the dark stage its fill alone is
  // 1.02:1, so without the line the card and what it leaves behind would vanish.
  it('wears the right sidebar\'s surface, on the card and on what it leaves behind', () => {
    for (const html of [card(), renderToStaticMarkup(<AskAnswers questions={questions} answers={{ dir: 'Left' }} />)]) {
      expect(html).toContain('sidebar-surface')
      expect(html).toContain('bg-sidebar')
      expect(html).toContain('border-line')
    }
  })

  // The composer refuses to send while the socket is down and says so. A card that
  // stayed clickable there would answer every click with "Try again", which is advice
  // that cannot work until the connection is back.
  it('locks itself while the connection is down, and says why', () => {
    const html = card({ connected: false })

    expect(html).toContain('Disconnected, answering is paused')
    expect(html).not.toContain('Could not send')
    expect(html).toContain('cursor-default')
    expect(html).not.toContain('hover:bg-user-bg')
    // Four ways out of this card, all of them a send: three buttons and the cross.
    expect(html.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(4)
  })

  // Whether a click answers the question or merely adds to it changes what the row
  // means, so the card has to say which it is before the first click, not after.
  it('says up front when a question takes more than one row, and draws tickboxes', () => {
    const single = card({ questions: [questions[0]!] })
    const several = card({ questions: [{ ...questions[0]!, multi: true }] })

    expect(single).not.toContain('Pick more than one')
    expect(single).not.toContain('checkbox-box')
    expect(single).toContain('role="radio"')

    expect(several).toContain('Pick more than one')
    expect(several).toContain('role="checkbox"')
    // Every row carries one, the free line included.
    expect(several.match(/checkbox-box/g)).toHaveLength(3)
    // The numbers stay: in a multi they toggle a row rather than answering outright.
    expect(several).toContain('>1</span>')
  })

  // Picking cannot mean "and on to the next one" when picking again means "this one
  // too", so Next is the second act and the only way out of a multi step.
  it('still offers Next on a multi question that is the last one', () => {
    const html = card({ questions: [{ ...questions[0]!, multi: true }] })

    expect(html).toContain('Send')
  })

  // Two questions with different option counts are different heights, and the card
  // swaps between them in place. The body stays mounted in a fold with a box that
  // owns its height, so stepping is a move rather than a jump.
  it('keeps the step body in a fold whose height it can animate', () => {
    const html = card()

    expect(html).toContain('class="fold ')
    expect(html).toContain('data-open="true"')
    expect(html).toContain('overflow-hidden')
  })

  it('names the question the header belongs to, at label size above it', () => {
    const html = card({
      questions: [{ ...questions[0]!, header: 'Acme app password' }],
    })

    expect(html).toContain('Acme app password')
    expect(html).toContain('Which way?')
  })
})

describe('AskDock', () => {
  it('draws nothing while no question is open', () => {
    const html = renderToStaticMarkup(<AskDock rows={[]} agents={[smith]} onAnswer={() => true} />)

    expect(html).toBe('')
  })

  it('draws nothing in a transcript that cannot answer', () => {
    const rows = [turn({ asks: [{ key: 'a', requestId: 'req_1', questions }] })]
    const html = renderToStaticMarkup(<AskDock rows={rows} agents={[smith]} />)

    expect(html).toBe('')
  })

  it('pins the open question, in the waiting personas colour', () => {
    const rows = [turn({ asks: [{ key: 'a', requestId: 'req_1', questions }] })]
    const html = renderToStaticMarkup(
      <AskDock rows={rows} agents={[smith]} onAnswer={() => true} />,
    )

    expect(html).toContain('Which way?')
    expect(html).toContain('--accent:#D08A3E')
  })

  it("pins a subagent's question and sends the answer to the subagent's chat", () => {
    const html = renderToStaticMarkup(
      <AskDock
        rows={[]}
        agents={[smith]}
        subagentQuestion={{ childChatId: 'child', title: 'Check the row', requestId: 'req_1', questions, more: 0 }}
        onAnswerThread={() => true}
      />,
    )

    expect(html).toContain('Check the row asks')
    expect(html).toContain('Which way?')
  })
})

describe('openAsk', () => {
  const ask = { key: 'a', requestId: 'req_1', questions }

  it('finds the unanswered question of a running turn', () => {
    expect(openAsk([turn({ asks: [ask] })])?.requestId).toBe('req_1')
  })

  it('lets an answered question go', () => {
    expect(openAsk([turn({ asks: [{ ...ask, answers: { dir: 'Left' } }] })])).toBeNull()
  })

  // The card can only be answered while the process that asked is still there to
  // read it. A dead turn's question belongs in the transcript, not over the composer.
  it('refuses a question whose turn is over', () => {
    expect(openAsk([turn({ asks: [ask], live: undefined })])).toBeNull()
  })

  it('skips the answered ones and takes the next', () => {
    const rows = [turn({ asks: [{ ...ask, answers: { dir: 'Left' } }, { ...ask, key: 'b', requestId: 'req_2' }] })]

    expect(openAsk(rows)?.requestId).toBe('req_2')
    expect(openAsk(rows)?.more).toBe(0)
  })

  /**
   * A second request arriving while the first is half answered used to take the card
   * over, which threw away every row already picked and read as the card resetting
   * itself under you. They queue, oldest first, and the card says how many follow.
   */
  it('holds the question being answered when another arrives behind it', () => {
    const rows = [
      turn({
        asks: [
          { ...ask, key: 'a', requestId: 'req_1' },
          { ...ask, key: 'b', requestId: 'req_2' },
        ],
      }),
    ]

    expect(openAsk(rows)?.requestId).toBe('req_1')
    expect(openAsk(rows)?.more).toBe(1)
  })
})

describe('questions in the transcript', () => {
  it('stay where the provider emitted them, before later narration and plans', () => {
    let stamp = 0
    const event = (value: Partial<ThreadEvent> & Pick<ThreadEvent, 'type'>): ThreadEvent => ({
      ...value,
      id: `evt_${stamp += 1}`,
      ts: stamp,
    } as ThreadEvent)
    const events = [
      event({
        type: 'user_input_request',
        agentId: 'smith',
        turnId: 'turn-1',
        requestId: 'req_1',
        questions: [questions[0]!],
      }),
      event({
        type: 'user_input_response',
        agentId: 'smith',
        turnId: 'turn-1',
        requestId: 'req_1',
        answers: { dir: 'Left' },
      }),
      event({
        type: 'agent_message',
        agentId: 'smith',
        turnId: 'turn-1',
        messageId: 'message_1',
        text: 'I will start.',
      }),
      event({
        type: 'todo_update',
        agentId: 'smith',
        turnId: 'turn-1',
        todos: [{ text: 'Build it', status: 'in_progress' }],
      }),
      event({ type: 'turn_result', agentId: 'smith', turnId: 'turn-1' }),
    ]
    const html = renderToStaticMarkup(
      <Transcript
        rows={rowsOf({ ...emptyThread, events, hasSnapshot: true })}
        agents={[smith]}
        skills={[]}
        hasSnapshot
      />,
    )

    expect(html.indexOf('Which way?')).toBeLessThan(html.indexOf('I will start.'))
    expect(html.indexOf('I will start.')).toBeLessThan(html.indexOf('Build it'))
  })
})

describe('AskAnswers', () => {
  it('reads back as pairs once the question is over', () => {
    const html = renderToStaticMarkup(
      <AskAnswers questions={questions} answers={{ dir: 'Left', pace: 'Now', who: 'Me' }} />,
    )

    expect(html).toContain('Which way?')
    expect(html).toContain('Left')
    expect(html).not.toContain('Next')
    expect(html).not.toContain('Type your own answer here')
  })

  it('reads a list answer back as one line', () => {
    const html = renderToStaticMarkup(
      <AskAnswers
        questions={[{ ...questions[0]!, multi: true }]}
        answers={{ dir: ['Left', 'Right'] }}
      />,
    )

    expect(html).toContain('Left, Right')
  })

  it('says skipped rather than repeating what the agent was told', () => {
    const html = renderToStaticMarkup(
      <AskAnswers questions={[questions[0]!]} answers={{ dir: SKIPPED_ANSWER }} />,
    )

    expect(html).toContain('Skipped')
    expect(html).not.toContain('Decide this one yourself')
  })

  // The turn died while the question stood. "Could not send. Try again." would be a
  // lie there: there is nothing left to send it to.
  it('says so when the turn ended before an answer did', () => {
    const html = renderToStaticMarkup(<AskAnswers questions={[questions[0]!]} />)

    expect(html).toContain('Never answered. The turn ended first.')
    expect(html).toContain('text-warn')
  })
})

describe('TodoList', () => {
  it('draws nothing for an empty snapshot', () => {
    expect(renderToStaticMarkup(<TodoList todos={[]} />)).toBe('')
  })

  it('is one line per task under a header, each saying its state', () => {
    const html = renderToStaticMarkup(
      <TodoList
        todos={[
          { text: 'Done item', status: 'completed' },
          { text: 'Now', status: 'in_progress' },
          { text: 'Later', status: 'pending' },
          { text: 'Merge into main', status: 'blocked' },
        ]}
      />,
    )
    expect(html.match(/<li /g)).toHaveLength(4)
    expect(html).toContain('Done.')
    expect(html).toContain('In progress.')
    expect(html).toContain('To do.')
    expect(html).toContain('Blocked.')
    expect(html).toContain('motion-safe:animate-spin-calm')
  })

  it('heads the list with the title, a done/total counter and a ring that fills with the done steps', () => {
    const todos = [
      { text: 'Map', status: 'completed' },
      { text: 'Split', status: 'in_progress' },
      { text: 'Rewrite', status: 'pending' },
      { text: 'Diff', status: 'pending' },
    ] as const
    const html = renderToStaticMarkup(<TodoList todos={todos} title="Refactor the token layer" />)
    expect(html).toContain('Refactor the token layer')
    expect(html).toMatch(/1\/4/)
    expect(html).toContain('aria-expanded="true"')
    // The ring never spins; only the current step does.
    expect(html.match(/animate-spin-calm/g)).toHaveLength(1)
    expect(html).toContain('data-plan-ring="1/4"')
    expect(html).not.toContain('data-plan-done')
    // No title (a plan carries none): named by its own steps, never a generic "Tasks".
    const untitled = renderToStaticMarkup(<TodoList todos={todos} />)
    expect(untitled).toContain('>Map and split<')
    expect(untitled).not.toContain('>Tasks<')
  })

  it('swaps the ring for a check and counts every step once nothing is left open', () => {
    const html = renderToStaticMarkup(
      <TodoList todos={[{ text: 'A', status: 'completed' }, { text: 'B', status: 'completed' }]} title="Ship it" />,
    )
    expect(html).toMatch(/2\/2/)
    expect(html).not.toContain('animate-spin-calm')
    expect(html).toContain('data-plan-done')
    expect(html).toContain('aria-label="Done. Ship it. 2 of 2 done"')
  })

  it('never heads a plan that skipped steps with a check', () => {
    const html = renderToStaticMarkup(
      <TodoList todos={[{ text: 'A', status: 'completed' }, { text: 'B', status: 'skipped' }]} title="Half" />,
    )
    expect(html).toContain('aria-label="Stopped. Half. 1 of 2 done"')
  })

  it('folds the steps away from the header and keeps the fold for that card only', () => {
    const todos = [{ text: 'Step one', status: 'pending' }] as const
    const card = (key: string) => renderToStaticMarkup(<TodoList todos={todos} title="T" foldKey={key} />)
    expect(card('fold-a')).toContain('aria-expanded="true"')
    toggleTaskFolded('fold-a')
    const folded = card('fold-a')
    expect(folded).toContain('aria-expanded="false"')
    expect(folded).toContain('visibility:hidden')
    expect(card('fold-b')).toContain('aria-expanded="true"')
    toggleTaskFolded('fold-a')
    expect(card('fold-a')).toContain('aria-expanded="true"')
  })
})
