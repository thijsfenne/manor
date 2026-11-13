import type { Chat, ProjectIcon } from '@manor/contracts'
import { describe, expect, it } from 'vitest'
import type { Inbox, InboxChat } from '../src/state'
import {
  buildSwitcherItems,
  cycleChatId,
  initialSwitcherChatId,
  orderSwitcherItems,
  SWITCHER_MAX_ITEMS,
  type SwitcherItem,
} from '../src/useChatSwitcher'

const chat = (id: string, lastMessageAt: number, title = id): Chat =>
  ({ id, title, lastMessageAt }) as unknown as Chat

const inboxRow = (
  id: string,
  lastMessageAt: number,
  projectName = 'Room',
  standing: { waiting?: boolean; running?: boolean; unread?: boolean } = {},
): InboxChat =>
  ({
    chat: chat(id, lastMessageAt),
    projectName,
    projectIcon: 'folder' as ProjectIcon,
    projectColor: '#7AA2F7',
    ...standing,
  }) as unknown as InboxChat

const inboxOf = (unsettled: InboxChat[], settled: InboxChat[], archived: InboxChat[] = []): Inbox => ({
  unsettled,
  settled,
  archived,
})

const item = (id: string): SwitcherItem => ({
  chatId: id,
  title: id,
  agentIds: [],
  project: null,
  standing: null,
})

describe('buildSwitcherItems', () => {
  it('takes only the work inbox and returns its unsettled project chats', () => {
    const inbox = inboxOf([inboxRow('project-a', 4)], [])
    expect(buildSwitcherItems(inbox).map((entry) => entry.chatId)).toEqual(['project-a'])
  })

  it('keeps settled and archived work out and dresses a project chat in its room', () => {
    const inbox = inboxOf(
      [inboxRow('project-a', 1, 'Manor')],
      [inboxRow('project-done', 5)],
      [inboxRow('project-old', 9)],
    )
    const items = buildSwitcherItems(inbox)
    expect(items.map((entry) => entry.chatId)).toEqual(['project-a'])
    expect(items[0]?.project).toEqual({ name: 'Manor', icon: 'folder', color: '#7AA2F7' })
    expect(items[0]?.agentIds).toEqual([])
  })

  it('carries the chat’s standing in the sidebar’s precedence: waiting, working, done', () => {
    const inbox = inboxOf([
      inboxRow('project-waiting', 5, 'Room', { waiting: true, running: true }),
      inboxRow('project-working', 4, 'Room', { running: true }),
      inboxRow('project-done', 3, 'Room', { unread: true }),
      inboxRow('project-quiet', 2),
    ], [])
    expect(buildSwitcherItems(inbox).map((entry) => [entry.chatId, entry.standing])).toEqual([
      ['project-waiting', 'waiting'],
      ['project-working', 'working'],
      ['project-done', 'done'],
      ['project-quiet', null],
    ])
  })
})

describe('orderSwitcherItems', () => {
  const items = [item('a'), item('b'), item('c'), item('d')]

  it('puts the stage chat first, the recently viewed behind it, then the rest', () => {
    expect(orderSwitcherItems(items, ['c', 'a'], 'b').map((entry) => entry.chatId)).toEqual([
      'b',
      'c',
      'a',
      'd',
    ])
  })

  it('dedupes and skips ids that have no tile', () => {
    expect(orderSwitcherItems(items, ['b', 'gone', 'b'], 'b').map((entry) => entry.chatId)).toEqual([
      'b',
      'a',
      'c',
      'd',
    ])
  })

  it('lets the recent list lead while a draft is on the stage', () => {
    expect(orderSwitcherItems(items, ['d', 'a'], null).map((entry) => entry.chatId)).toEqual([
      'd',
      'a',
      'b',
      'c',
    ])
  })

  it('caps the strip at ten tiles, with the stage chat always among them', () => {
    const many = Array.from({ length: 14 }, (_, index) => item(`c${index}`))
    const ordered = orderSwitcherItems(many, [], 'c13')
    expect(ordered).toHaveLength(SWITCHER_MAX_ITEMS)
    expect(ordered[0]?.chatId).toBe('c13')
  })
})

describe('cycleChatId', () => {
  const cycle = ['a', 'b', 'c']

  it('steps to the next chat and back again with Shift', () => {
    expect(cycleChatId(cycle, 'a', 1)).toBe('b')
    expect(cycleChatId(cycle, 'b', -1)).toBe('a')
  })

  it('wraps at both ends', () => {
    expect(cycleChatId(cycle, 'c', 1)).toBe('a')
    expect(cycleChatId(cycle, 'a', -1)).toBe('c')
  })

  it('starts at the edge when the highlight is not in the strip', () => {
    expect(cycleChatId(cycle, null, 1)).toBe('a')
    expect(cycleChatId(cycle, 'gone', -1)).toBe('c')
  })

  it('stays put on a one-chat strip and goes nowhere on an empty one', () => {
    expect(cycleChatId(['a'], 'a', 1)).toBe('a')
    expect(cycleChatId([], null, 1)).toBeUndefined()
  })
})

describe('initialSwitcherChatId', () => {
  it('starts on the first work chat when the active DM, group or pair is excluded', () => {
    const items = [item('work-a'), item('work-b')]
    expect(initialSwitcherChatId(items, 'excluded-chat', 1)).toBe('work-a')
    expect(initialSwitcherChatId(items, 'excluded-chat', -1)).toBe('work-a')
  })

  it('advances when the active work chat is part of the strip', () => {
    const items = [item('work-a'), item('work-b')]
    expect(initialSwitcherChatId(items, 'work-a', 1)).toBe('work-b')
  })
})
