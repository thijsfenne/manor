import type { AgentConfig, Project, SkillConfig, ThreadEvent } from '@manor/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Transcript } from '../src/components/Transcript'
import { COMPACTING_STATUS, LIVE_COMPACT_DONE, LIVE_COMPACT_NOTE } from '../src/turnTrace'
import { emptyThread, rowsOf, type LiveTurn, type ThreadState } from '../src/state'

/**
 * The status line through the whole transcript, not through the component alone.
 *
 * `TurnStatus` decides for itself whether it has anything to say, but only the row
 * around it decides whether it is ever asked. Both cases below are turns with no trace
 * at all — the shape that used to be gated away — and both are turns whose record is
 * the only thing on screen about them. A component test cannot see that gate, which is
 * how the zero-step stop went silent in the first place.
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

const wren: AgentConfig = {
  ...smith,
  id: 'wren',
  name: 'Wren',
  color: '#14A8B8',
}

const SKILLS: SkillConfig[] = []
let stamp = 1_786_500_000_000

const event = (partial: Partial<ThreadEvent> & { type: ThreadEvent['type'] }, at = (stamp += 1_000)): ThreadEvent =>
  ({ id: `evt_${at}`, ts: at, ...partial }) as ThreadEvent

const thread = (events: ThreadEvent[]): ThreadState => ({
  ...emptyThread,
  events,
  usage: {},
  overrides: {},
  liveTurns: [],
  pending: [],
  hasSnapshot: true,
})

const render = (
  events: ThreadEvent[],
  bubbleReplies = false,
  agents: AgentConfig[] = [smith],
  liveTurns: LiveTurn[] = [],
  threadProject?: Project,
) =>
  renderToStaticMarkup(
    <Transcript
      rows={rowsOf({ ...thread(events), liveTurns }, bubbleReplies ? 'dm' : 'project')}
      agents={agents}
      skills={SKILLS}
      hasSnapshot
      bubbleReplies={bubbleReplies}
      {...(threadProject === undefined ? {} : { threadProject })}
    />,
  )

/** A Worked for line whose own element waits for hover or focus on its turn. */
const QUIET_WORKED = /class="[^"]*opacity-0[^"]*group-hover\/turn:opacity-100[^"]*group-focus-within\/turn:opacity-100[^"]*"><button[^>]*>(<span[^>]*>){2}Worked for 4s/

describe('a turn with no trace at all', () => {
  // The first turn of a thread used to count as a model change, which kept its model
  // and Worked for line shown: a new install saw the line on every first reply.
  it('rests the Worked for line of a project thread’s first reply, without the model or the project name', () => {
    const html = render([
      event({ type: 'agent_message', agentId: 'smith', turnId: 'turn_1', messageId: 'm1', text: 'Saved.' }, 1_000),
      event({ type: 'turn_result', agentId: 'smith', turnId: 'turn_1', reportedModel: 'gpt-6.1-sol' }, 5_000),
    ], false, [smith], [], {
      id: 'manor', name: 'Manor', color: '#14A8B8', icon: 'folder', repoPaths: [], memoryScope: 'project',
    })

    expect(html).not.toContain('Manor')
    expect(html).not.toContain('GPT-6.1 Sol')
    expect(html.replace(/ title="[^"]*"/g, '')).not.toContain('gpt-6.1-sol')
    expect(html).toMatch(QUIET_WORKED)
    expect(html).toContain('Saved.')
  })

  it('rests what a direct answer cost beside the name, and never names the model', () => {
    const html = render([
      event({ type: 'agent_message', agentId: 'smith', turnId: 'turn_1', messageId: 'm1', text: 'Ja.' }, 1_000),
      event({ type: 'turn_result', agentId: 'smith', turnId: 'turn_1', reportedModel: 'claude-opus-5' }, 5_000),
    ])

    // The reply stands on its own below; the line beside the name is the only place
    // this turn says how long it took, and it says so on hover or focus.
    expect(html).toContain('Smith')
    expect(html).toMatch(QUIET_WORKED)
    expect(html).not.toContain('Opus 5')
    expect(html).toContain('Ja.')
  })

  it('keeps the wait on a finished DM answer and drops the model name', () => {
    const html = render([
      event({ type: 'agent_message', agentId: 'smith', turnId: 'turn_1', messageId: 'm1', text: 'Ja.' }, 1_000),
      event({ type: 'turn_result', agentId: 'smith', turnId: 'turn_1', reportedModel: 'claude-opus-5' }, 5_000),
    ], true)

    expect(html).toMatch(QUIET_WORKED)
    expect(html).toContain('Ja.')
    expect(html).not.toContain('Opus 5')
  })

  it('keeps a turn stopped before it produced anything as its name and Stopped, without the note', () => {
    const html = render([
      event({ type: 'user_message', text: 'Doe iets groots.', mentions: ['smith'] }, 1_000),
      event({ type: 'system_note', kind: 'aborted', agentId: 'smith', turnId: 'turn_2', text: 'Stopped by you' }, 2_000),
    ])

    expect(html).toContain('Smith')
    expect(html).toContain('>Stopped</span>')
    // A Session's Stopped is a state, not a record: it stays shown.
    expect(html).not.toContain('opacity-0')
    expect(html).not.toContain('Stopped by you')
  })

  it('keeps the reason a failed turn gives, which the status line cannot carry', () => {
    const html = render([
      event({ type: 'user_message', text: 'Doe iets groots.', mentions: ['smith'] }, 1_000),
      event(
        {
          type: 'system_note',
          kind: 'error',
          agentId: 'smith',
          turnId: 'turn_3',
          text: 'Could not finish: the driver died',
        },
        2_000,
      ),
    ])

    expect(html).toContain('Could not finish: the driver died')
    expect(html.match(/text-danger/g)).toHaveLength(1)
  })

  it('says Stopped on the stopped turn only, never as a line of its own', () => {
    const html = render([
      event({ type: 'agent_message', agentId: 'wren', turnId: 'turn_wren', messageId: 'm1', text: 'Partial work.' }, 1_000),
      event({ type: 'system_note', kind: 'aborted', agentId: 'wren', turnId: 'turn_wren', text: 'Stopped by you' }, 2_000),
      event({ type: 'agent_message', agentId: 'smith', turnId: 'turn_smith', messageId: 'm2', text: 'Finished work.' }, 3_000),
      event({ type: 'turn_result', agentId: 'smith', turnId: 'turn_smith' }, 4_000),
    ], false, [smith, wren])

    expect(html).toContain('Wren')
    expect(html).toContain('Partial work.')
    expect(html).toContain('Smith')
    expect(html).toContain('Finished work.')
    expect(html.match(/>Stopped<\/span>/g)).toHaveLength(1)
    expect(html).not.toContain('Stopped by you')
  })

  it('shows live compact as one Compacting row in the open trace and keeps Compacted out of the footer', () => {
    const live: LiveTurn = {
      turnId: 'turn_compact',
      agentId: 'smith',
      messages: [],
      state: 'running',
      startedAt: 1_000,
    }
    const compacting = render(
      [event({ type: 'system_note', kind: 'info', agentId: 'smith', turnId: 'turn_compact', text: LIVE_COMPACT_NOTE }, 1_000)],
      false,
      [smith],
      [live],
    )
    const settled = render([
      event({ type: 'agent_message', agentId: 'smith', turnId: 'turn_compact', messageId: 'm1', text: 'Klaar.' }, 1_000),
      event({ type: 'system_note', kind: 'info', agentId: 'smith', turnId: 'turn_compact', text: LIVE_COMPACT_DONE }, 2_000),
      event({ type: 'turn_result', agentId: 'smith', turnId: 'turn_compact' }, 3_000),
    ])

    // One line per compaction: the row says Compacting, the status keeps working.
    expect(compacting).toContain('data-text="Compacting"')
    expect(compacting).not.toContain(COMPACTING_STATUS)
    expect(compacting).toContain('Working')
    expect(compacting).not.toContain(LIVE_COMPACT_NOTE)
    expect(settled).toContain('Klaar.')
    expect(settled).not.toContain(LIVE_COMPACT_DONE)
    expect(settled).toContain('aria-expanded="false"')
  })
})

describe('what Manor says about a message or a turn', () => {
  it('puts a hint under the user’s own message instead of a line of its own', () => {
    const html = render([
      event({ id: 'ask', type: 'user_message', text: '@Huxley can you look?', mentions: [] }, 1_000),
      event({ type: 'system_note', kind: 'info', hintFor: 'ask', text: "Huxley isn't in this chat." }, 2_000),
    ])
    expect(html).toMatch(/can you look\?[\s\S]*self-end[^>]*>Huxley isn&#x27;t in this chat\.<\/p>/)
    expect(html).not.toContain('justify-center"><div class="px-3 py-0.5 text-center text-[12px] text-dim">Huxley')
  })

  it('keeps bookkeeping inside the turn’s closed trace, with a control to open it', () => {
    const html = render([
      event({ type: 'agent_message', agentId: 'smith', turnId: 'turn_cap', messageId: 'm1', text: 'Asked Argus.' }, 1_000),
      event({ type: 'turn_result', agentId: 'smith', turnId: 'turn_cap' }, 2_000),
      event({ type: 'system_note', kind: 'info', agentId: 'smith', turnId: 'turn_cap', trace: true, text: 'Argus was not asked: delegated turn limit (6) reached' }, 3_000),
    ])
    expect(html).toContain('Asked Argus.')
    expect(html).not.toContain('delegated turn limit')
    expect(html).toContain('aria-expanded="false"')
  })
})
