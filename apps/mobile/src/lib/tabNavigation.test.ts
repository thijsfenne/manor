import { describe, expect, it, vi } from 'vitest'

vi.mock('expo-router', () => ({ useNavigation: () => undefined }))
vi.mock('expo-router/react-navigation', () => ({
  StackActions: { popToTop: () => ({ type: 'POP_TO_TOP' }) },
  TabActions: { jumpTo: (name: string) => ({ type: 'JUMP_TO', payload: { name } }) },
}))

const { openTabActions } = await import('./tabNavigation')
type NavState = import('./tabNavigation').NavState

/** Expo Router's shape: the root stack, the tab bar inside it, one stack per tab. */
const app = (agents: NavState['routes'] | undefined): NavState => ({
  type: 'stack',
  index: 0,
  routes: [{
    name: '(tabs)',
    state: {
      key: 'tabs',
      type: 'tab',
      index: 1,
      routes: [
        { name: '(agents)', ...(agents === undefined ? {} : { state: { key: 'agents-stack', type: 'stack', index: agents.length - 1, routes: agents } }) },
        { name: '(sessions)', state: { key: 'sessions-stack', type: 'stack', index: 0, routes: [{ name: 'index' }] } },
      ],
    },
  }],
})

describe('openTabActions', () => {
  it('pops the tab back to its list before switching, so no second list lands on an open chat', () => {
    expect(openTabActions(app([{ name: 'agents' }, { name: 'chat/[id]' }]), '(agents)')).toEqual([
      { type: 'POP_TO_TOP', target: 'agents-stack' },
      { type: 'JUMP_TO', payload: { name: '(agents)' }, target: 'tabs' },
    ])
  })

  it('only switches when the tab already shows its list or was never opened', () => {
    const jump = [{ type: 'JUMP_TO', payload: { name: '(agents)' }, target: 'tabs' }]
    expect(openTabActions(app([{ name: 'agents' }]), '(agents)')).toEqual(jump)
    expect(openTabActions(app(undefined), '(agents)')).toEqual(jump)
  })

  it('does nothing before the tab bar is on screen', () => {
    expect(openTabActions(undefined, '(agents)')).toEqual([])
    expect(openTabActions({ type: 'stack', index: 0, routes: [{ name: '(tabs)' }] }, '(agents)')).toEqual([])
  })
})
