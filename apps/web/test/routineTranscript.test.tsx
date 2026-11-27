import type { AgentConfig, SkillConfig, ThreadEvent } from '@manor/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Transcript } from '../src/components/Transcript'
import { TurnActivity } from '../src/components/TurnActivity'
import { emptyThread, rowsOf, type ThreadState } from '../src/state'

/**
 * A routine turn in the transcript. The rule under test is decision 7 of the
 * routines plan and it is a refusal: the injected prompt is never a user bubble.
 * They wrote it once, in the Routines view, and rendering it on the right in their own
 * colour every morning puts words in their mouth and ruins the thread as a record.
 */

const smith: AgentConfig = {
  id: 'smith',
  name: 'Smith',
  color: '#D08A3E',
  character: 'You are Smith.',
  driver: 'mock',
  effort: 'high',
  allowedTools: [],
  mcpServers: [],
  memoryScope: false,
  description: 'Engineer.',
  role: 'Engineer',
  isCos: false,
}

const SKILLS: SkillConfig[] = []
const AT = Date.parse('2026-08-16T05:12:00Z')

const event = (partial: Partial<ThreadEvent> & { type: ThreadEvent['type'] }, index: number): ThreadEvent =>
  ({ id: `evt_${index}`, ts: AT, ...partial }) as ThreadEvent

const thread = (events: ThreadEvent[]): ThreadState => ({
  ...emptyThread,
  events,
  usage: {},
  overrides: {},
  liveTurns: [],
  pending: [],
  hasSnapshot: true,
})

const render = (events: ThreadEvent[]) =>
  renderToStaticMarkup(
    <Transcript
      rows={rowsOf(thread(events))}
      agents={[smith]}
      skills={SKILLS}
      hasSnapshot
    />,
  )

describe('a routine turn in the transcript', () => {
  it('announces itself as a routine and never as a message the user sent', () => {
    const html = render([
      event(
        {
          type: 'user_message',
          text: 'What changed overnight?',
          mentions: [],
          source: 'routine',
          routineName: 'Morning brief',
        },
        1,
      ),
    ])

    expect(html).toContain('Morning brief')
    // The user bubble's own shape: right-aligned, in their colour. Its absence is the
    // whole assertion.
    expect(html).not.toContain('bg-user-bubble')
    expect(html).not.toContain('justify-end')
    // Folded away until asked for: the prompt is worth exactly one click, on the
    // morning the answer above makes no sense without it.
    expect(html).not.toContain('What changed overnight?')
    expect(html).toContain('aria-expanded="false"')
  })

  it('leaves an ordinary message in the ordinary bubble', () => {
    const html = render([event({ type: 'user_message', text: 'Waar staan we?', mentions: [] }, 1)])

    expect(html).toContain('bg-user-bubble')
    expect(html).toContain('Waar staan we?')
  })

  it('stands for itself when the routine that fired it is gone', () => {
    const html = render([
      event({ type: 'user_message', text: 'What changed overnight?', mentions: [], source: 'routine' }, 1),
    ])

    // No name to give, and the line still says the thing that matters: nobody typed
    // this. A deleted or renamed routine does not rewrite what happened.
    expect(html).toContain('Routine')
    expect(html).not.toContain('bg-user-bubble')
  })

  describe('in a DM', () => {
    const fired = [
      event({ type: 'user_message', text: 'Check mail.', mentions: [], source: 'routine', routineName: 'Mail catch-up' }, 1),
      event({ type: 'tool_use', turnId: 'turn-1', agentId: 'smith', tool: 'gmail_search' }, 2),
      event({ type: 'agent_message', turnId: 'turn-1', agentId: 'smith', text: 'Two mails need you.' }, 3),
      event({ type: 'turn_result', turnId: 'turn-1', agentId: 'smith' }, 4),
    ]

    it('leaves the conversation to the reply and puts the trigger first in the open fold', () => {
      const rows = rowsOf(thread(fired), 'dm')
      const html = renderToStaticMarkup(<Transcript rows={rows} agents={[smith]} skills={SKILLS} hasSnapshot bubbleReplies />)
      expect(html).toContain('Two mails need you.')
      expect(html).not.toContain('Mail catch-up')

      const turn = rows[0]
      if (turn?.kind !== 'turn') throw new Error('expected the routine turn')
      const fold = renderToStaticMarkup(<TurnActivity turn={turn} persona={smith} agents={[smith]} open />)
      // The first row of the fold, ahead of the work it started.
      const first = fold.slice(fold.indexOf('<li'), fold.indexOf('</li>'))
      expect(first).toContain('Routine, Mail catch-up, ')
      expect(fold).not.toContain('Check mail.')
      expect(fold).toContain('aria-expanded="false"')
    })

    it('keeps the line in a group', () => {
      const html = renderToStaticMarkup(
        <Transcript rows={rowsOf(thread(fired), 'group')} agents={[smith]} skills={SKILLS} hasSnapshot />,
      )
      expect(html).toContain('Mail catch-up')
    })
  })
})

describe('a background wake in the transcript', () => {
  const wake = event({
    type: 'user_message', source: 'background_wake', mentions: [],
    text: 'Background work you started has ended. Sam has not sent anything new.\n- “Anti-slop review” (Sol, taskId task_9) finished.\n[Begin its answer.]\nRAW-ANSWER',
    wakeItems: [{ toolCallId: 'tc1', taskId: 'task_9', title: 'Anti-slop review', state: 'done', driver: 'codex', model: 'gpt' }],
  }, 1)

  it('shows one quiet finished line and never the prompt Manor sent the persona', () => {
    const html = render([wake])
    expect(html).toContain('Background task finished: anti-slop review')
    expect(html).not.toContain('<button')
    expect(html).not.toContain('Background work you started')
    expect(html).not.toContain('RAW-ANSWER')
    expect(html).not.toContain('task_9')
  })

  it('draws nothing in a DM, where the answer after it speaks for itself', () => {
    const reply = [
      event({ type: 'agent_message', turnId: 'turn-2', agentId: 'smith', text: 'The review is back.' }, 2),
      event({ type: 'turn_result', turnId: 'turn-2', agentId: 'smith' }, 3),
    ]
    const rows = rowsOf(thread([wake, ...reply]), 'dm')
    const html = renderToStaticMarkup(<Transcript rows={rows} agents={[smith]} skills={SKILLS} hasSnapshot bubbleReplies />)
    const wakeRow = rows.find((row) => row.kind === 'event' && row.event.id === wake.id)
    expect(html).toContain('The review is back.')
    expect(html).not.toContain('Background task finished')
    // No empty slot either: the row is gone, not drawn blank.
    expect(wakeRow).toBeDefined()
    expect(html).not.toContain(`data-transcript-row="${wakeRow?.key}"`)
  })
})
