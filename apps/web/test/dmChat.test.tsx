import { lostConnectionNote, type AgentConfig, type ThreadEvent } from '@manor/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Transcript } from '../src/components/Transcript'
import { emptyThread, rowsOf, type LiveTurn, type PendingMessage } from '../src/state'

/**
 * A DM reads as a chat: whole replies only, no face on a finished bubble, one working
 * indicator at the foot, and nothing about a turn that was stopped or broke off.
 */

const smith: AgentConfig = {
  id: 'smith',
  name: 'Smith',
  color: '#D08A3E',
  character: 'You are Smith.',
  driver: 'claude',
  effort: 'high',
  allowedTools: [],
  mcpServers: [],
  memoryScope: false,
  description: 'Engineer.',
  role: 'Engineer',
  isCos: false,
}
const iris: AgentConfig = { ...smith, id: 'iris', name: 'Iris', color: '#8A5EA8' }

let id = 0
const event = (partial: Partial<ThreadEvent> & { type: ThreadEvent['type'] }, at: number): ThreadEvent =>
  ({ id: `evt_${(id += 1)}`, ts: at, ...partial }) as ThreadEvent

const render = (
  events: ThreadEvent[],
  { dm = true, liveTurns = [], pending = [], runningChatIds }: {
    dm?: boolean
    liveTurns?: LiveTurn[]
    pending?: PendingMessage[]
    runningChatIds?: ReadonlySet<string>
  } = {},
) =>
  renderToStaticMarkup(
    <Transcript
      rows={rowsOf({ ...emptyThread, events, liveTurns, pending, hasSnapshot: true }, dm ? 'dm' : 'project')}
      agents={[smith, iris]}
      skills={[]}
      hasSnapshot
      bubbleReplies={dm}
      dmAgentId="smith"
      onOpenAgentRelay={() => undefined}
      {...(runningChatIds === undefined ? {} : { runningChatIds })}
    />,
  )

const NOW = Date.now()
const sent = event({ type: 'user_message', text: 'Look into it', mentions: [] }, NOW - 10_000)

describe('a stopped or broken DM turn', () => {
  it('leaves out the half sentence a stop cut off, which a Session keeps', () => {
    const events = [
      sent,
      event({ type: 'agent_message', agentId: 'smith', turnId: 't1', messageId: 'm1', text: 'First whole message.' }, NOW - 9_000),
      event({ type: 'agent_message', agentId: 'smith', turnId: 't1', messageId: 'm2', text: 'Half a sent', interrupted: true }, NOW - 8_000),
      event({ type: 'system_note', kind: 'aborted', agentId: 'smith', turnId: 't1', text: 'Smith’s turn was stopped.' }, NOW - 8_000),
    ]
    const dm = render(events)
    expect(dm).toContain('First whole message.')
    expect(dm).not.toContain('Half a sent')
    expect(dm).not.toContain('Stopped')
    expect(dm).not.toContain('data-dm-working')
    expect(render(events, { dm: false })).toContain('Half a sent')
  })

  it('shows no failure line, keeping the reason inside the trace', () => {
    const events = [
      sent,
      event({ type: 'agent_message', agentId: 'smith', turnId: 't1', messageId: 'm1', text: 'Let me check.' }, NOW - 9_000),
      event({ type: 'system_note', kind: 'error', agentId: 'smith', turnId: 't1', text: 'Smith could not answer: provider failed' }, NOW - 8_000),
    ]
    const dm = render(events)
    expect(dm).toContain('Let me check.')
    expect(dm).not.toContain('provider failed')
    expect(dm).not.toContain('text-danger')
    // The closed trace control is still there to open it.
    expect(dm).toContain('aria-expanded="false"')
    expect(render(events, { dm: false })).toContain('provider failed')
  })

  it('says nothing after a crash, even about a request that may have half-run', () => {
    const events = [sent, event({ type: 'system_note', kind: 'error', text: lostConnectionNote('The accepted request') }, NOW - 8_000)]
    expect(render(events)).not.toContain('lost its connection')
    expect(render(events, { dm: false })).toContain('lost its connection')
  })

  it('draws nothing for a broken turn that finished no message', () => {
    const dm = render([
      sent,
      event({ type: 'tool_use', agentId: 'smith', turnId: 't1', toolCallId: 'c1', tool: 'Read' }, NOW - 9_000),
      event({ type: 'system_note', kind: 'aborted', agentId: 'smith', turnId: 't1', text: 'Smith lost its connection.' }, NOW - 8_000),
    ])
    expect(dm).not.toContain('lost its connection')
    expect(dm).not.toContain('Worked for')
    // Its row stays empty, and `empty:hidden` takes it out of the column's gap.
    expect(dm).toMatch(/data-transcript-row="turn[^"]*" class="[^"]*empty:hidden[^"]*"><\/div>/)
  })
})

describe('the DM working indicator', () => {
  it('stands under a message no turn has picked up yet, in the DM persona’s face', () => {
    const html = render([], { pending: [{ key: 'p1', text: 'Hoi', images: [], files: [], pageContexts: [] }] })
    expect(html).toContain('data-dm-working')
    expect(html).toContain('Smith is working')
    expect(html).toContain('data-text="Thinking…"')
    expect(html.indexOf('Hoi')).toBeLessThan(html.indexOf('data-dm-working'))
  })

  it('stays under a message sent while she works, and goes once she asks a question', () => {
    const running: LiveTurn[] = [{ turnId: 't1', agentId: 'smith', messages: [], state: 'running', startedAt: NOW - 1_000 }]
    const more = event({ type: 'user_message', text: 'And the logs too', mentions: [] }, NOW - 500)
    const html = render([sent, more], { liveTurns: running })
    expect(html.indexOf('And the logs too')).toBeLessThan(html.indexOf('data-dm-working'))

    const ask = event({
      type: 'user_input_request', agentId: 'smith', turnId: 't1', requestId: 'r1',
      questions: [{ id: 'q', question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }],
    } as Partial<ThreadEvent> & { type: 'user_input_request' }, NOW - 200)
    expect(render([sent, ask], { liveTurns: running })).not.toContain('data-dm-working')
  })

  it('waits for a consulted colleague under the Messaged marker', () => {
    const events = [
      sent,
      event({ type: 'agent_message', agentId: 'smith', turnId: 't1', messageId: 'm1', text: 'I will ask Iris.' }, NOW - 9_000),
      event({ type: 'turn_result', agentId: 'smith', turnId: 't1' }, NOW - 8_500),
      event({ type: 'agent_relay', agentId: 'smith', peerAgentId: 'iris', pairChatId: 'pair', turnId: 't1', relayId: 'r1', phase: 'sent' }, NOW - 8_000),
    ]
    const html = render(events, { runningChatIds: new Set(['pair']) })
    expect(html).toContain('Messaged')
    expect(html).toContain('data-text="Waiting for Iris…"')
    expect(html.indexOf('Messaged')).toBeLessThan(html.indexOf('data-dm-working'))
    expect(render(events, { runningChatIds: new Set() })).not.toContain('data-dm-working')
  })
})

describe('DM time stamps', () => {
  it('stamps the first message and each exchange after an hour’s pause', () => {
    const html = render([
      event({ type: 'user_message', text: 'Morning', mentions: [] }, NOW - 3 * 3_600_000),
      event({ type: 'agent_message', agentId: 'smith', turnId: 't1', messageId: 'm1', text: 'Hi.' }, NOW - 3 * 3_600_000 + 5_000),
      event({ type: 'turn_result', agentId: 'smith', turnId: 't1' }, NOW - 3 * 3_600_000 + 6_000),
      event({ type: 'user_message', text: 'Later', mentions: [] }, NOW - 60_000),
    ])
    const stamps = html.match(/>(Today|Yesterday) \d\d:\d\d</g) ?? []
    // Two exchanges, two stamps; the reply five seconds later gets none.
    expect(stamps).toHaveLength(2)
  })
})
