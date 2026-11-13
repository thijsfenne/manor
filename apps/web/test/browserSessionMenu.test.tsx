import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Chat } from '@manor/contracts'
import { BrowserSessionEmpty, BrowserSessionMenu, recentBrowserSessions } from '../src/components/BrowserSessionMenu'

vi.mock('react-dom', async (original) => ({ ...await original<typeof import('react-dom')>(), createPortal: (child: unknown) => child }))

const chat = (id: string, kind: Chat['kind'], lastMessageAt: number, archivedAt: number | null = null) =>
  ({ id, kind, title: id, lastMessageAt, archivedAt }) as Chat

let tree: ReactTestRenderer | undefined
beforeEach(() => {
  vi.stubGlobal('document', { body: {}, addEventListener: vi.fn(), removeEventListener: vi.fn() })
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
})
afterEach(() => { act(() => tree?.unmount()); tree = undefined; vi.unstubAllGlobals() })
const button = (name: string) => tree!.root.findAllByType('button').find((node) =>
  node.props['aria-label'] === name || node.findAll((child) => child.children.includes(name)).length > 0)!
const click = (name: string) => act(() => button(name).props.onClick())

describe('browser sessions', () => {
  it('lists only live Browser sessions, newest first, capped', () => {
    const chats = [chat('old', 'browser', 1), chat('dm', 'dm', 9), chat('new', 'browser', 5), chat('gone', 'browser', 7, 3)]
    expect(recentBrowserSessions(chats).map((session) => session.id)).toEqual(['new', 'old'])
    expect(recentBrowserSessions(chats, 1)).toHaveLength(1)
  })

  it('starts a session in the mode picked, and reopens a past one', () => {
    const onNew = vi.fn()
    const onOpen = vi.fn()
    const sessions = [chat('current', 'browser', 5), chat('earlier', 'browser', 1)]
    act(() => { tree = create(<BrowserSessionMenu sessions={sessions} currentId="current" disabled={false} onNew={onNew} onOpen={onOpen} />) })
    click('New session'); click('Multiple')
    expect(onNew).toHaveBeenCalledWith('house')
    click('Recent sessions'); click('current')
    expect(onOpen).not.toHaveBeenCalled()
    click('Recent sessions'); click('earlier')
    expect(onOpen).toHaveBeenCalledWith('earlier')
  })

  it('offers only New session before any exists, Single first', () => {
    const onNew = vi.fn()
    act(() => { tree = create(<BrowserSessionEmpty disabled={false} onNew={onNew} />) })
    click('New session')
    const items = tree!.root.findAllByProps({ role: 'menuitem' })
    expect(items[0]!.findAll((node) => node.children.includes('Single')).length).toBeGreaterThan(0)
    click('Single')
    expect(onNew).toHaveBeenCalledWith('single')
  })
})
