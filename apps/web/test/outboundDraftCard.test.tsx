import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { OutboundDraftGroup } from '../src/components/OutboundDraftGroup'
import type { DraftActions } from '../src/components/OutboundDraftBubble'
import type { DraftRecord } from '../src/state'
import { forgetOutboundDraftEdit } from '@manor/client-runtime/outbound-draft-edits'

beforeAll(() => vi.stubGlobal('window', { clearTimeout, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
afterAll(() => vi.unstubAllGlobals())

const draft: DraftRecord = {
  key: 'd', draftId: 'd', channel: 'gmail', to: 'info@example.com', from: 'me@example.com', subject: 'Portfolio', body: 'Hello',
}
const card = (value: DraftRecord, actions: DraftActions = {}) =>
  <OutboundDraftGroup drafts={[value]} color="var(--color-primary)" actions={actions} />
const button = (tree: ReactTestRenderer, label: string) =>
  tree.root.findAllByType('button').find((node) => node.props['aria-label'] === label)
const text = (tree: ReactTestRenderer) => JSON.stringify(tree.toJSON())

describe('outbound draft card', () => {
  it('keeps edited body, subject and Cc after leaving the screen and sends them', () => {
    const value = { ...draft, draftId: 'navigation-edit' }
    const onSubmit = vi.fn(() => true)
    let tree = create(card(value))
    act(() => tree.root.findByProps({ 'aria-label': 'Draft body' }).props.onChange({ target: { value: 'Edited body' } }))
    act(() => tree.root.findByProps({ 'aria-label': 'Draft subject' }).props.onChange({ target: { value: 'Edited subject' } }))
    act(() => tree.root.findByProps({ 'aria-label': 'Draft Cc' }).props.onChange({ target: { value: 'sam@example.com' } }))
    act(() => tree.unmount())
    act(() => { tree = create(card(value, { onSubmit })) })
    act(() => button(tree, 'Send')!.props.onClick())
    expect(onSubmit).toHaveBeenCalledWith('navigation-edit', 'Edited body', 'Edited subject', undefined, 'sam@example.com')
    act(() => tree.unmount())
    forgetOutboundDraftEdit(value.draftId)
  })

  it('offers Later and Ignore instead of Discard on a threaded draft, and no Copy', () => {
    const thread = { threadId: 't', previous: { from: 'Sam', at: '2026-11-12T10:00:00Z', text: 'Question' }, earlierCount: 0 }
    const tree = create(card({ ...draft, thread }, { onDiscard: () => true, onSnooze: () => true, onIgnore: () => true }))
    expect(button(tree, 'Answer tomorrow')).toBeDefined()
    expect(button(tree, 'Ignore this thread')).toBeDefined()
    expect(button(tree, 'Discard draft')).toBeUndefined()
    expect(button(tree, 'Copy')).toBeUndefined()
    expect(tree.root.findAllByProps({ 'aria-label': 'Draft subject' })).toHaveLength(0)
    expect(text(tree)).toContain('Portfolio')
  })

  it('offers no Show more for a thread this Manor cannot read', () => {
    const thread = { threadId: 't', previous: { from: 'Sam', at: '2026-11-12T10:00:00Z', text: 'Question' }, earlierCount: 2 }
    const actions = { onReadThread: () => true, onSnooze: () => true }
    expect(text(create(card({ ...draft, thread }, actions)))).toContain('Show more')
    expect(text(create(card({ ...draft, thread, fullThread: false }, actions)))).not.toContain('Show more')
  })

  const folded: [NonNullable<DraftRecord['closed']>, string][] = [
    [{ outcome: 'discarded' }, 'Discarded, info@example.com'],
    [{ outcome: 'submitted', delivery: 'delivered', body: 'Hello' }, 'Sent, info@example.com'],
  ]
  for (const [closed, line] of folded) {
    it(`folds to "${line}" and reopens read-only`, () => {
      const tree = create(card({ ...draft, closed }, { onSubmit: () => true, onDiscard: () => true }))
      expect(text(tree)).toContain(line)
      const fold = tree.root.findByProps({ 'data-open': false })
      expect(fold).toBeDefined()
      act(() => button(tree, 'Open mail card')!.props.onClick())
      expect(tree.root.findAllByProps({ 'data-open': true })).toHaveLength(1)
      expect(button(tree, 'Send')).toBeUndefined()
      expect(button(tree, 'Discard draft')).toBeUndefined()
      expect(tree.root.findAllByProps({ 'aria-label': 'Draft body' })).toHaveLength(0)
    })
  }

  it('shows a cleared Cc as gone once the mail is sent', () => {
    const tree = create(card({ ...draft, cc: 'sam@example.com', closed: { outcome: 'submitted', delivery: 'delivered', body: 'Hello', subject: 'Portfolio' } }))
    act(() => button(tree, 'Open mail card')!.props.onClick())
    expect(text(tree)).not.toContain('sam@example.com')
  })
})
