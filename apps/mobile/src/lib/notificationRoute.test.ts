import { describe, expect, it } from 'vitest'

import { notificationOpen, type StackState } from './notificationRoute'

const chat = (id: string) => ({ name: 'chat/[id]', params: { id } })
/** Expo Router's shape: one root route holding the app's stack. */
const app = (...routes: StackState['routes']): StackState => ({
  type: 'stack',
  index: 0,
  routes: [{ name: '__root', state: { type: 'stack', index: routes.length - 1, routes } }],
})

describe('notificationOpen', () => {
  it('pushes the chat straight onto the room', () => {
    expect(notificationOpen(app({ name: 'index' }), 'b')).toBe('push')
  })

  it('clears a Session left open underneath, so back never lands in it', () => {
    expect(notificationOpen(app({ name: 'index' }, chat('a')), 'b')).toBe('reset')
    expect(notificationOpen(app({ name: 'agents' }, chat('a'), { name: 'subagent/[callId]', params: { callId: 'c' } }), 'b')).toBe('reset')
  })

  it('stays on the chat when it is already on screen', () => {
    expect(notificationOpen(app({ name: 'index' }, chat('b')), 'b')).toBe('stay')
  })

  it('reads the focused tab\'s own stack under the tab bar', () => {
    const tabs = (focused: number, ...stacks: StackState['routes'][]): StackState => ({
      type: 'stack',
      index: 0,
      routes: [{ name: '(tabs)', state: {
        type: 'tab',
        index: focused,
        routes: stacks.map((routes, index) => ({ name: `tab${index}`, state: { type: 'stack', index: routes.length - 1, routes } })),
      } }],
    })
    expect(notificationOpen(tabs(1, [{ name: 'agents' }, chat('b')], [{ name: 'index' }]), 'b')).toBe('push')
    expect(notificationOpen(tabs(0, [{ name: 'agents' }, chat('b')], [{ name: 'index' }]), 'b')).toBe('stay')
    expect(notificationOpen(tabs(1, [{ name: 'agents' }], [{ name: 'index' }, chat('a')]), 'b')).toBe('reset')
  })

  it('pushes before the navigator has a state', () => {
    expect(notificationOpen(undefined, 'b')).toBe('push')
  })
})
