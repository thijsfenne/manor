import type { AgentConfig, Routine } from '@manor/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ChatAgentsPanel } from '../src/components/agents/ChatAgentsPanel'

const routine: Routine = {
  id: 'rt_1',
  chatId: 'chat_1',
  projectId: null,
  agentId: 'smith',
  name: 'Morning brief',
  description: '',
  model: null,
  effort: null,
  notify: false,
  prompt: 'What changed overnight?',
  cron: '0 7 * * *',
  timezone: 'Europe/Amsterdam',
  enabled: true,
  nextRunAt: null,
  lastRunAt: null,
  lastSkippedAt: null,
  consecutiveFailures: 0,
  disabledReason: null,
  runningSince: null,
  lastContextTokens: null,
  runAt: null,
  lateUntil: null,
  action: 'run',
  endState: null,
  endedAt: null,
  unreadRunIds: [],
  createdAt: 0,
}

const agent = (id: string, name: string, color: string): AgentConfig => ({
  id,
  name,
  color,
  character: '',
  driver: 'mock',
  effort: 'medium',
  allowedTools: [],
  mcpServers: [],
  memoryScope: false,
  description: '',
  role: 'Specialist',
  isCos: false,
})

describe('the chat agents panel', () => {
  it('marks participants without hiding dormant agents', () => {
    const agents = [
      agent('jeeves', 'Jeeves', '#8b5cf6'),
      agent('iris', 'Iris', '#ec4899'),
      agent('smith', 'Smith', '#f59e0b'),
    ]
    const html = renderToStaticMarkup(
      <ChatAgentsPanel
        agents={agents}
        activeAgentIds={['iris', 'smith']}
        startedAgentIds={[]}
        overrides={{}}
        canEdit
        onChange={() => {}}
      />,
    )

    // The runs panel's surface and radius; the two dock in the same track.
    expect(html).toContain('rounded-dock')
    expect(html).toContain('bg-surface')
    expect(html).toContain('px-1.5 py-1.5')
    expect(html).toContain('2</span>/3 active')
    expect(html.match(/>Active in this chat</g)).toHaveLength(2)
    // The dormant persona is dimmed, not dropped: identity and runtime both carry the muted class.
    expect(html.match(/opacity-40/g)).toHaveLength(2)
    expect(html).toContain('Jeeves')
    expect(html).not.toContain('This chat only')
  })

  it('says nothing about routines in a chat that has none', () => {
    const html = renderToStaticMarkup(
      <ChatAgentsPanel
        agents={[agent('smith', 'Smith', '#f59e0b')]}
        activeAgentIds={['smith']}
        startedAgentIds={[]}
        overrides={{}}
        canEdit
        onChange={() => {}}
        onOpenRoutines={() => {}}
      />,
    )

    // A permanent empty heading in a panel about the household is chrome that says
    // nothing, so the section is absent rather than empty.
    expect(html).not.toContain('Runs on a schedule')
  })

  it('shows active Fast mode as an icon in the roster', () => {
    const smith = {
      ...agent('smith', 'Smith', '#f59e0b'),
      driver: 'cursor' as const,
      model: 'cursor-gpt-5.6-sol',
    }
    const html = renderToStaticMarkup(
      <ChatAgentsPanel
        agents={[smith]}
        activeAgentIds={['smith']}
        startedAgentIds={[]}
        overrides={{ smith: { speed: 'fast' } }}
        canEdit
        onChange={() => {}}
      />,
    )

    expect(html).toContain('title="Fast mode"')
    expect(html).toContain('class="sr-only">Fast mode</span>')
    expect(html).not.toContain('>Fast<')
  })

  it('discloses what posts here on a schedule, read-only, as a door to the view', () => {
    const html = renderToStaticMarkup(
      <ChatAgentsPanel
        agents={[agent('smith', 'Smith', '#f59e0b')]}
        activeAgentIds={['smith']}
        startedAgentIds={[]}
        overrides={{}}
        canEdit
        onChange={() => {}}
        routines={[routine]}
        onOpenRoutines={() => {}}
      />,
    )

    expect(html).toContain('Runs on a schedule')
    expect(html).toContain('Morning brief')
    expect(html).toContain('Every day at 07:00')
    // A door, not a second editor: a routine outlives the chat it posts into and is
    // managed house-wide, so two writers of one schedule is the drift this avoids.
    expect(html).toContain('Open in Scheduled tasks')
    expect(html).not.toContain('<input')
  })
})
