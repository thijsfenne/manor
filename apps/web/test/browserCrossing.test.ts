import { describe, expect, it } from 'vitest'
import type { Chat } from '@manor/contracts'
import { crossingTargets } from '../src/browserCrossing'
import type { ChatListRow, Inbox, InboxChat } from '../src/state'

const row = (over: Partial<ChatListRow>): ChatListRow => ({
  key: 'k', kind: 'dm', chat: null, agentId: null, title: '', agentIds: [], preview: '',
  lastMessageAt: null, selected: false, unread: false, running: false, waiting: false, ...over,
})
const chat = (id: string, lastMessageAt: number, title = id) => ({ id, title, lastMessageAt }) as Chat

describe('crossing targets', () => {
  it('lists opened DMs, groups and unsettled work newest first, capped', () => {
    const rows = [
      row({ title: 'Iris', chat: chat('dm-iris', 30) }),
      row({ title: 'Smith' }),
      row({ kind: 'pair', title: 'Pair', chat: chat('pair', 99) }),
      row({ kind: 'group', title: 'Team', chat: chat('group', 10) }),
    ]
    const inbox = { unsettled: [{ chat: chat('work', 20, 'Audit'), projectName: 'Manor' } as InboxChat], settled: [], archived: [] } as Inbox
    expect(crossingTargets(rows, inbox)).toEqual([
      { chatId: 'dm-iris', title: 'Iris' },
      { chatId: 'work', title: 'Audit', detail: 'Manor' },
      { chatId: 'group', title: 'Team' },
    ])
    expect(crossingTargets(rows, inbox, 1)).toHaveLength(1)
  })
})
