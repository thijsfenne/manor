import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AgentConfig } from '@manor/contracts'
import { OutboundDraftDock } from '../src/components/OutboundDraftDock'
import { OutboundDraftGroup } from '../src/components/OutboundDraftGroup'
import { OutboundDockProvider } from '../src/components/outboundDockState'
import type { DraftActions } from '../src/components/OutboundDraftBubble'
import type { DraftRecord, Row } from '../src/state'
import { forgetOutboundDraftEdit } from '@manor/client-runtime/outbound-draft-edits'

beforeAll(() => vi.stubGlobal('window', { clearTimeout, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
afterAll(() => vi.unstubAllGlobals())

const agent = { id: 'wren', name: 'Wren', color: 'var(--color-primary)' } as AgentConfig
const draft: DraftRecord = { key: 'd', draftId: 'd', channel: 'slack', slackChannelId: 'C123456789', to: '#test', body: 'Test only' }
const thread = { threadId: 'thread', previous: { from: 'Tester', at: '2026-09-08T10:00:00Z', text: 'Test question' }, earlierCount: 0 }
function Screen({ value = draft, actions = {} }: { value?: DraftRecord; actions?: DraftActions }) {
  const rows = [{ kind: 'turn', key: 't', agentId: agent.id, drafts: [value] }] as Row[]
  return <OutboundDockProvider rows={rows}>
    <main><OutboundDraftGroup drafts={[value]} color={agent.color} actions={actions} /></main>
    <footer><OutboundDraftDock rows={rows} agents={[agent]} connected actions={actions} /></footer>
  </OutboundDockProvider>
}
// Slack drafts use SlackDraftEditor (no "Draft body" textarea); count the card itself.
const dockCards = (tree: ReactTestRenderer) => tree.root.findByType('footer').findAllByProps({ 'data-outbound-card': true })
const transcriptCards = (tree: ReactTestRenderer) => tree.root.findByType('main').findAllByProps({ 'data-outbound-card': true })
const gmailBody = (card: ReactTestInstance) => card.findByProps({ 'aria-label': 'Draft body' })
const click = (tree: ReactTestRenderer, label: string) => act(() => {
  tree.root.findAllByType('button').find((button) => button.props['aria-label'] === label)!.props.onClick()
})

describe('outbound draft dock', () => {
  it('preserves edited body and subject after leaving the screen and returning', () => {
    const value = { ...draft, draftId: 'navigation-edit', channel: 'gmail' as const, subject: 'Original' }
    let tree = create(<Screen value={value} />)
    act(() => {
      gmailBody(dockCards(tree)[0]!).props.onChange({ target: { value: 'My edited reply' } })
    })
    act(() => tree.root.findByProps({ 'aria-label': 'Draft subject' }).props.onChange({ target: { value: 'Edited subject' } }))
    act(() => tree.unmount())
    act(() => { tree = create(<Screen value={value} />) })
    expect(gmailBody(dockCards(tree)[0]!).props.value).toBe('My edited reply')
    expect(tree.root.findByProps({ 'aria-label': 'Draft subject' }).props.value).toBe('Edited subject')
    act(() => tree.unmount())
    forgetOutboundDraftEdit(value.draftId)
  })

  for (const [channel, verb, label] of [
    ['slack', 'onSubmit', 'Submit'],
    ['gmail', 'onDiscard', 'Discard draft'],
    ['slack', 'onSnooze', 'Answer tomorrow'],
    ['gmail', 'onIgnore', 'Ignore this thread'],
  ] as const) {
      it(`${channel} ${verb} immediately removes the dock card before the server replies`, () => {
        const handler = vi.fn(() => true)
        const value = { ...draft, channel, ...(verb === 'onSnooze' || verb === 'onIgnore' ? { thread } : {}) }
        const tree = create(<Screen value={value} actions={{ [verb]: handler }} />)
        expect(dockCards(tree)).toHaveLength(1)
        expect(transcriptCards(tree)).toHaveLength(0)
        click(tree, label)
        expect(handler).toHaveBeenCalledOnce()
        expect(dockCards(tree)).toHaveLength(0)
        expect(transcriptCards(tree)).toHaveLength(0)
        expect(tree.root.findAllByType('button')).toHaveLength(0)
      })
  }
  it('keeps the card when the socket refuses the action', () => {
    const tree = create(<Screen actions={{ onSubmit: () => false }} />)
    click(tree, 'Submit')
    expect(dockCards(tree)).toHaveLength(1)
  })
  it('returns a failed send to the dock with its edited text', () => {
    const actions = { onSubmit: () => true }
    const value = { ...draft, channel: 'gmail' as const, subject: 'Subject' }
    const tree = create(<Screen value={value} actions={actions} />)
    click(tree, 'Submit')
    act(() => tree.update(<Screen actions={actions} value={{ ...value, failure: 'Send failed', body: 'Edited' }} />))
    expect(dockCards(tree)).toHaveLength(1)
    expect(gmailBody(dockCards(tree)[0]!).props.value).toBe('Edited')
  })
  it('allows the same failure to return after a retry started', () => {
    const actions = { onSubmit: () => true }
    const failed = { ...draft, failure: 'Send failed' }
    const tree = create(<Screen value={failed} actions={actions} />)
    click(tree, 'Submit')
    act(() => tree.update(<Screen actions={actions} value={{ ...draft, submission: { status: 'started', body: draft.body } }} />))
    act(() => tree.update(<Screen actions={actions} value={failed} />))
    expect(dockCards(tree)).toHaveLength(1)
  })
  it('stacks drafts from different turns and keeps the remaining draft after an action', () => {
    const other = { ...draft, key: 'd2', draftId: 'd2', channel: 'gmail' as const }
    const rows = [
      { kind: 'turn', key: 't1', agentId: agent.id, drafts: [draft] },
      { kind: 'turn', key: 't2', agentId: 'smith', drafts: [other] },
    ] as Row[]
    const tree = create(<OutboundDockProvider rows={rows}><footer><OutboundDraftDock rows={rows} agents={[agent]} connected actions={{ onSubmit: () => true }} /></footer></OutboundDockProvider>)
    expect(dockCards(tree)).toHaveLength(2)
    click(tree, 'Submit')
    expect(dockCards(tree)).toHaveLength(1)
  })
  for (const outcome of ['ignored', 'snoozed'] as const) {
    it(`pins a restored ${outcome} draft after the server reopens it`, () => {
      const actions = { onRestore: vi.fn(() => true), onSubmit: () => true }
      const tree = create(<Screen value={{ ...draft, failure: 'Old failure', closed: { outcome } }} actions={actions} />)
      expect(dockCards(tree)).toHaveLength(0)
      click(tree, 'Restore this draft')
      expect(actions.onRestore).toHaveBeenCalledOnce()
      expect(dockCards(tree)).toHaveLength(0)
      act(() => tree.update(<Screen actions={actions} />))
      expect(dockCards(tree)).toHaveLength(1)
      expect(transcriptCards(tree)).toHaveLength(0)
      expect(tree.root.findAllByType('button').find((button) => button.props['aria-label'] === 'Submit')?.props.disabled).toBe(false)
    })
  }
})