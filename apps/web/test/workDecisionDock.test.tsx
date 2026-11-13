import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { WorkDecisionDock } from '../src/components/WorkDecisionDock'
import type { WorkHandoffRow } from '../src/state'

const ready: WorkHandoffRow = {
  kind: 'work_handoff', key: 'work:h1', handoffId: 'h1', projectId: 'p1', workChatId: 'w1', title: 'Session panel',
  projectName: 'Manor', projectIcon: 'home', projectColor: '#388B83', leadAgentId: 'wren', leadAgentName: 'Wren',
  supportingAgentIds: [], supportingAgentNames: [], status: 'Working', session: 'ready', result: null, acceptedAt: 1,
  report: {
    handoffId: 'h1', workChatId: 'w1', version: 4, result: 'Done.', leadAgentName: 'Wren', files: 12, reviewer: 'Argus',
    operation: 'commit', worktree: false, decision: 'open', evidence: [],
  },
}
const actions = { requestEvents: { subscribe: () => () => undefined }, connected: true, accept: () => true, revise: () => true, retry: () => true, askCheckout: () => undefined }
const dock = (excluded: number | undefined) => renderToStaticMarkup(
  <WorkDecisionDock rows={[ready]} inView={new Set()} agents={[]} onAcceptProposal={() => undefined} onRejectProposal={() => undefined}
    resultActions={actions} readiness={{ excluded: () => excluded, ask: () => undefined, updatedAt: () => 1 }} onReveal={() => undefined} />,
)

describe('the bar above the composer', () => {
  it('names a waiting result Ready, says what Confirm commits, and adds text only when Confirm leaves files out', () => {
    expect(dock(undefined)).toContain('>Ready</span>')
    expect(dock(undefined)).not.toContain('>Result<')
    expect(dock(undefined)).not.toContain('not included')
    expect(dock(0)).not.toContain('not included')
    expect(dock(1)).toContain('>1 file not included</span>')
    expect(dock(2)).toContain('>2 files not included</span>')
    expect(dock(undefined)).toContain('title="Commits the 12 reviewed files."')
  })
})

describe('the bar in a Session', () => {
  const report = { ...ready, session: 'ready' as const, report: { ...ready.report!, files: 0, reviewer: undefined, operation: 'none' as const } }
  it('uses the card’s labels: Follow up and Close for a report, never a pointer to the project thread', () => {
    const markup = renderToStaticMarkup(
      <WorkDecisionDock rows={[report]} inView={new Set()} agents={[]} onAcceptProposal={() => undefined} onRejectProposal={() => undefined}
        resultActions={actions} onReveal={() => undefined} />)
    expect(markup).toContain('>Ready</span>')
    expect(markup).toContain('aria-label="Follow up Session panel"')
    expect(markup).toContain('aria-label="Close Session panel"')
    expect(markup).not.toContain('Confirm in the project thread')
    expect(markup).not.toContain('>Confirm<')
  })
  it('drops a result whose Session works again', () => {
    const markup = renderToStaticMarkup(
      <WorkDecisionDock rows={[{ ...report, session: 'working' }]} inView={new Set()} agents={[]} onAcceptProposal={() => undefined} onRejectProposal={() => undefined}
        resultActions={actions} onReveal={() => undefined} />)
    expect(markup).toBe('')
  })
})
