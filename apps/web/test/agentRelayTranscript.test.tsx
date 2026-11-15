import type { AgentConfig, ThreadEvent } from '@manor/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { placeConsultedMenu, Transcript } from '../src/components/Transcript'
import { emptyThread, finishedSilent, rowsOf, type ThreadState } from '../src/state'

const persona = (id: string, name: string, color: string): AgentConfig => ({
  id, name, color, character: '', driver: 'mock', effort: 'medium', allowedTools: [],
  mcpServers: [], memoryScope: false, description: '', role: '', isCos: false,
})
const marlow = persona('marlow', 'Jeeves', '#8B7EC8')
const sage = persona('sage', 'Sage', '#6FA8A0')
const smith = persona('smith', 'Smith', '#D08A3E')
const agents = [marlow, sage, smith]

const thread = (events: ThreadEvent[]): ThreadState => ({
  ...emptyThread,
  events, usage: {}, overrides: {}, liveTurns: [], pending: [], hasSnapshot: true,
})

describe('agent relay transcript surfaces', () => {
  it('places a consulted-agent menu above a turn near the transcript floor', () => {
    const placement = placeConsultedMenu(
      { left: 500, right: 700, top: 700, bottom: 730 },
      { left: 100, right: 760, top: 100, bottom: 760 },
      { width: 900, height: 800 },
      3,
    )

    expect(placement).toEqual({ left: 480, width: 220, maxHeight: 594, upward: true, bottom: 106 })
  })

  it('keeps the consulted-agent menu below when the names fit there', () => {
    const placement = placeConsultedMenu(
      { left: 500, right: 700, top: 120, bottom: 150 },
      { left: 100, right: 760, top: 100, bottom: 760 },
      { width: 900, height: 800 },
      2,
    )

    expect(placement).toEqual({ left: 480, width: 220, maxHeight: 604, upward: false, top: 156 })
  })

  it('renders both durable DM marker phases as quiet links to the pair', () => {
    const events: ThreadEvent[] = [
      {
        id: 'sent', ts: 1, type: 'agent_relay', agentId: 'marlow', peerAgentId: 'sage',
        pairChatId: 'pair_1', turnId: 'turn_1', relayId: 'relay_1', phase: 'sent',
      },
      {
        id: 'received', ts: 2, type: 'agent_relay', agentId: 'marlow', peerAgentId: 'sage',
        pairChatId: 'pair_1', turnId: 'turn_1', relayId: 'relay_1', phase: 'received', preview: 'Not now.',
      },
    ]
    const html = renderToStaticMarkup(
      <Transcript
        rows={rowsOf(thread(events))}
        agents={agents}
        skills={[]}
        hasSnapshot
        onOpenAgentRelay={() => undefined}
      />,
    )

    expect(html).toContain('Messaged')
    expect(html).toContain('Message from')
    expect(html).toContain('Sage')
    expect(html).toContain('title="Not now."')
    expect(html).not.toContain('disabled=""')
  })

  it('stacks consecutive outgoing and incoming markers from one DM turn into facepiles', () => {
    const events: ThreadEvent[] = [
      {
        id: 'answer', ts: 1, type: 'agent_message', agentId: 'marlow', turnId: 'turn_1', text: '',
      },
      {
        id: 'sent-sage', ts: 2, type: 'agent_relay', agentId: 'marlow', peerAgentId: 'sage',
        pairChatId: 'pair_sage', turnId: 'turn_1', relayId: 'relay_sage', phase: 'sent',
      },
      {
        id: 'sent-smith', ts: 3, type: 'agent_relay', agentId: 'marlow', peerAgentId: 'smith',
        pairChatId: 'pair_smith', turnId: 'turn_1', relayId: 'relay_smith', phase: 'sent',
      },
      {
        id: 'received-sage', ts: 4, type: 'agent_relay', agentId: 'marlow', peerAgentId: 'sage',
        pairChatId: 'pair_sage', turnId: 'turn_1', relayId: 'relay_sage', phase: 'received',
      },
      {
        id: 'received-smith', ts: 5, type: 'agent_relay', agentId: 'marlow', peerAgentId: 'smith',
        pairChatId: 'pair_smith', turnId: 'turn_1', relayId: 'relay_smith', phase: 'received',
      },
      { id: 'result', ts: 6, type: 'turn_result', agentId: 'marlow', turnId: 'turn_1' },
    ]
    const html = renderToStaticMarkup(
      <Transcript
        rows={rowsOf(thread(events), 'dm')}
        agents={agents}
        skills={[]}
        hasSnapshot
        bubbleReplies
        onOpenAgentRelay={() => undefined}
      />,
    )

    expect(html).toContain('aria-label="Messaged Sage, Smith"')
    expect(html).toContain('aria-label="Message from Sage, Smith"')
    expect(html).toContain('2 agents')
    expect(html).not.toContain('self-end')
    expect(html.match(/>Messaged</g)).toHaveLength(1)
    expect(html.match(/>Message from</g)).toHaveLength(1)
    expect(html).not.toContain('finished without a reply')
    const turn = rowsOf(thread(events), 'dm').find((row) => row.kind === 'turn')
    expect(turn?.kind === 'turn' && finishedSilent(turn)).toBe(false)
    const silent = rowsOf(thread(events.filter((event) => event.type !== 'agent_relay')), 'dm')
      .find((row) => row.kind === 'turn')
    expect(silent?.kind === 'turn' && finishedSilent(silent)).toBe(true)
  })

  it('leaves no face under a finished DM turn that only messaged another agent', () => {
    const events: ThreadEvent[] = [
      { id: 'ask', ts: 1, type: 'user_message', text: 'Stuur maar door naar Sage', mentions: [] },
      {
        id: 'sent', ts: 2, type: 'agent_relay', agentId: 'marlow', peerAgentId: 'sage',
        pairChatId: 'pair_1', turnId: 'turn_1', relayId: 'relay_1', phase: 'sent',
      },
      { id: 'result', ts: 3, type: 'turn_result', agentId: 'marlow', turnId: 'turn_1' },
    ]
    const html = renderToStaticMarkup(
      // Sage has answered: the pair chat no longer runs, so no working indicator either.
      <Transcript rows={rowsOf(thread(events), 'dm')} agents={agents} skills={[]} hasSnapshot bubbleReplies runningChatIds={new Set()} />,
    )

    expect(html).toContain('Messaged')
    expect(html).not.toContain('Jeeves')
  })

  it('lets the marker state the question when the asking turn ended silent, and only then', () => {
    const sent = (turnId: string, relayId: string, ts: number): ThreadEvent => ({
      id: `sent-${turnId}`, ts, type: 'agent_relay', agentId: 'marlow', peerAgentId: 'sage',
      pairChatId: 'pair_1', turnId, relayId, phase: 'sent', preview: 'Which change is smallest?',
    })
    const silent: ThreadEvent[] = [
      { id: 'ask', ts: 1, type: 'user_message', text: 'Vraag het Sage', mentions: [] },
      { id: 'tool', ts: 2, type: 'tool_use', turnId: 'turn_1', agentId: 'marlow', tool: 'message_agent' },
      sent('turn_1', 'relay_1', 3),
      { id: 'result', ts: 4, type: 'turn_result', agentId: 'marlow', turnId: 'turn_1' },
    ]
    const render = (events: ThreadEvent[]) => renderToStaticMarkup(
      <Transcript rows={rowsOf(thread(events), 'dm')} agents={agents} skills={[]} hasSnapshot bubbleReplies onOpenAgentRelay={() => undefined} />,
    )

    const waiting = render(silent)
    expect(waiting).toContain('“Which change is smallest?”')
    expect(waiting).toContain(', reply follows')
    // The silent turn draws nothing, so its row leaves the list instead of leaving a gap.
    expect(waiting).not.toContain('data-transcript-row="turn:')
    expect(waiting).toContain('aria-expanded="false"')

    const replied = render([...silent, {
      id: 'received', ts: 5, type: 'agent_relay', agentId: 'marlow', peerAgentId: 'sage',
      pairChatId: 'pair_1', turnId: 'turn_1', relayId: 'relay_1', phase: 'received', preview: 'The first.',
    }])
    expect(replied).toContain('“Which change is smallest?”')
    expect(replied).not.toContain('reply follows')

    // The sentence comes before the call: an accepted call ends a DM turn.
    const acknowledged = render([
      { id: 'ask', ts: 1, type: 'user_message', text: 'Vraag het Sage', mentions: [] },
      { id: 'ack', ts: 2, type: 'agent_message', agentId: 'marlow', turnId: 'turn_1', text: 'Ik vraag Sage welke wijziging het kleinst is; zijn antwoord volgt.' },
      { id: 'tool', ts: 3, type: 'tool_use', turnId: 'turn_1', agentId: 'marlow', tool: 'message_agent' },
      sent('turn_1', 'relay_1', 4),
      { id: 'result', ts: 5, type: 'turn_result', agentId: 'marlow', turnId: 'turn_1' },
    ])
    expect(acknowledged).toContain('Ik vraag Sage')
    expect(acknowledged).not.toContain('“Which change is smallest?”')
    expect(acknowledged).not.toContain('reply follows')
  })

  it('renders the asker as an agent in the pair and separates calendar days', () => {
    const events: ThreadEvent[] = [
      {
        id: 'ask', ts: Date.parse('2026-09-01T09:00:00Z'), type: 'user_message', source: 'agent_relay',
        text: 'What is your verdict?', mentions: [], authorAgentId: 'marlow', originChatId: 'dm_1',
        originTurnId: 'root_1', relayId: 'relay_1', relayDepth: 1,
      },
      {
        id: 'answer', ts: Date.parse('2026-09-02T09:00:00Z'), type: 'agent_message',
        agentId: 'sage', turnId: 'sage_turn', text: 'Keep the smaller change.',
      },
      {
        id: 'result', ts: Date.parse('2026-09-02T09:00:01Z'), type: 'turn_result',
        agentId: 'sage', turnId: 'sage_turn',
      },
    ]
    const html = renderToStaticMarkup(
      <Transcript rows={rowsOf(thread(events))} agents={agents} skills={[]} hasSnapshot showDates />,
    )

    expect(html).toContain('Jeeves')
    expect(html).toContain('What is your verdict?')
    expect(html).toContain('Sage')
    expect(html).toContain('Keep the smaller change.')
    expect(html).toContain('1 Sept 2026')
    expect(html).toContain('2 Sept 2026')
    expect(html).not.toContain('bg-user-bg')
    expect(html).not.toContain('bg-user-bubble')
    expect(html).not.toContain('bg-bubble')
  })
})
