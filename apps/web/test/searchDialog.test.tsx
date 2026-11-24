import type { ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Chat } from '@manor/contracts'
import type { RequestResponse } from '../src/useRequest'

vi.mock('../src/components/ui/Dialog', () => ({ Dialog: ({ children }: { children: ReactNode }) => <div>{children}</div> }))
const { SearchDialog } = await import('../src/components/SearchDialog')

type Props = Parameters<typeof SearchDialog>[0]

let listener: ((response: RequestResponse) => void) | undefined
let tree: ReactTestRenderer | undefined

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('window', { setTimeout, clearTimeout })
})

afterEach(() => {
  act(() => tree?.unmount())
  tree = undefined
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function open(overrides: Partial<Props> = {}) {
  const props = {
    chats: [], inbox: { unsettled: [], settled: [], archived: [], archiveKeepMs: 0 }, searchInbox: { unsettled: [], settled: [], archived: [], archiveKeepMs: 0 }, threadRows: [], runs: {}, agents: [],
    reminders: { available: false, snapshot: null }, connected: true,
    search: () => true,
    requestEvents: { subscribe: (receive: typeof listener) => { listener = receive; return () => {} } },
    onLoadReminders: () => {}, canStartChat: false, canOpenNoteBeside: false,
    onStartChat: () => {}, onOpenChat: () => {}, onOpenMessage: () => {}, onOpenNote: () => {}, onOpenReminder: () => {}, onClose: () => {},
    ...overrides,
  } as Props
  act(() => { tree = create(<SearchDialog {...props} />) })
  const root = tree!.root
  const type = (value: string) => {
    act(() => { root.findByType('input').props.onChange({ target: { value } }) })
    act(() => { vi.advanceTimersByTime(120) })
  }
  const status = () => root.findAllByProps({ role: 'status' }).map((node) => node.children.join(''))
  return { root, type, status }
}

it('stops searching and says so when the host answers with an error', () => {
  let requestId = ''
  const { root, type, status } = open({ search: (_query, id) => { requestId = id; return true } })
  type('budget')
  expect(status()).toEqual(['Searching…'])
  act(() => listener?.({ type: 'notice', kind: 'error', requestId: 'someone-else', text: 'x' }))
  expect(status()).toEqual(['Searching…'])
  act(() => listener?.({ type: 'notice', kind: 'error', requestId, text: 'Search failed' }))
  expect(root.findByProps({ role: 'listbox' }).props['aria-busy']).toBe(false)
  expect(status()).toEqual(['Messages and notes could not be searched. Type again to retry.'])
})

it('stops searching when the query cannot be sent', () => {
  const { type, status } = open({ search: () => false })
  type('budget')
  expect(status()).toEqual(['Messages and notes could not be searched. Type again to retry.'])
})

it('finds an archived chat by title, while the resting list leaves it out', () => {
  const chat = { id: 'c1', title: 'Quarterly offsite', lastMessageAt: 1, archivedAt: 2 } as Chat
  const entry = { chat, projectName: 'Work', projectIcon: '', projectColor: '', selected: false, unread: false, running: false, waiting: false }
  const { root, type } = open({ searchInbox: { unsettled: [], settled: [], archived: [entry] as Props['inbox']['archived'], archiveKeepMs: 0 } })
  expect(root.findAllByProps({ role: 'option' })).toHaveLength(0)
  type('quarterly')
  expect(root.findAllByProps({ role: 'option' })).toHaveLength(1)
})

it('finds a project thread by its project name and a Session its thread started by title', () => {
  const project = { id: 'p1', name: 'Küche' }
  const thread = { id: 'thread', title: 'Thread', lastMessageAt: 3, archivedAt: null } as Chat
  const session = { id: 'session', title: 'Build the PDF', lastMessageAt: 2, archivedAt: null } as Chat
  const entry = { chat: session, projectName: 'Küche', viaThread: true, projectIcon: '', projectColor: '', selected: false, unread: false, running: false, waiting: false }
  const opened: string[] = []
  const { root, type } = open({
    threadRows: [{ project, chat: thread, lastActivityAt: 3 }] as unknown as Props['threadRows'],
    searchInbox: { unsettled: [entry] as Props['searchInbox']['unsettled'], settled: [], archived: [], archiveKeepMs: 0 },
    onOpenChat: (chatId) => opened.push(chatId),
  })
  // The resting list shows neither: the sidebar already carries them.
  expect(root.findAllByProps({ role: 'option' })).toHaveLength(0)
  type('kuche')
  expect(root.findAllByProps({ role: 'option' })).toHaveLength(1)
  act(() => root.findAllByProps({ role: 'option' })[0]!.props.onClick({}))
  expect(opened).toEqual(['thread'])
  type('build the pdf')
  expect(root.findAllByProps({ role: 'option' })).toHaveLength(1)
})
