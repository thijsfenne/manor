import type { AgentConfig } from '@manor/contracts'
import { describe, expect, it } from 'vitest'
import { pinMenuItems, type AgentPins } from '../src/components/chats/ChatListView'

const agent = (id: string, pins: { pinned?: boolean; railPinned?: boolean } = {}): AgentConfig =>
  ({ id, name: id, color: '#888888', ...pins }) as unknown as AgentConfig

const pick = (subject: AgentConfig, roster: AgentConfig[]) => {
  const calls: [string, AgentPins][] = []
  const items = pinMenuItems(subject, roster, (id, pins) => calls.push([id, pins]))
  return { items, calls }
}

describe('the pin items on an agent row menu', () => {
  it('offers both pins when neither is on, and each turns its own pin on', () => {
    const iris = agent('iris')
    const { items, calls } = pick(iris, [iris])
    expect(items.map((item) => item.label)).toEqual(['Pin to top', 'Add to rail'])
    items.forEach((item) => item.onSelect())
    expect(calls).toEqual([['iris', { pinned: true }], ['iris', { railPinned: true }]])
  })

  it('reads the current state and turns it off again', () => {
    const iris = agent('iris', { pinned: true, railPinned: true })
    const { items, calls } = pick(iris, [iris])
    expect(items.map((item) => item.label)).toEqual(['Unpin', 'Remove from rail'])
    items.forEach((item) => item.onSelect())
    expect(calls).toEqual([['iris', { pinned: false }], ['iris', { railPinned: false }]])
  })

  it('refuses a third at the top with the reason, and still lets a pinned one leave', () => {
    const a = agent('a', { pinned: true })
    const b = agent('b', { pinned: true })
    const c = agent('c')
    const [top, rail] = pick(c, [a, b, c]).items
    expect(top).toMatchObject({ label: 'Pin to top', disabled: true, hint: 'Already 2 pinned there; unpin one first.' })
    expect(rail?.label).toBe('Add to rail')
    expect(rail?.disabled).not.toBe(true)
    expect(pick(a, [a, b, c]).items[0]).toMatchObject({ label: 'Unpin', disabled: false })
  })
})
