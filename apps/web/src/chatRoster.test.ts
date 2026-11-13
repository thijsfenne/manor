import { CURRENT_CHECKOUT, type AgentConfig, type Chat } from '@manor/contracts'
import { describe, expect, it } from 'vitest'
import { chatRoster } from './chatRoster'

const agent = (id: string): AgentConfig => ({
  id,
  name: id,
  color: '#8B7EC8',
  character: id,
  driver: 'mock',
  effort: 'medium',
  allowedTools: [],
  mcpServers: [],
  memoryScope: false,
  role: '',
  description: '',
  isCos: false,
  placement: 'chat',
})

const chat = (kind: Chat['kind'], memberIds: string[]): Chat => ({
  id: 'chat_1',
  projectId: kind === 'project' ? 'project_1' : null,
  kind,
  routineId: null,
  parentChatId: null,
  sideModel: null,
  sideEffort: null,
  memberIds,
  lastMessagePreview: null,
  title: 'Chat',
  createdAt: 0,
  lastMessageAt: 0,
  settledAt: null,
  archivedAt: null,
  agentIds: [],
  checkout: CURRENT_CHECKOUT,
})

describe('chatRoster', () => {
  it('lists every chat agent a group seats, a former DM-only one included', () => {
    expect(chatRoster([agent('sage'), agent('watcher')], chat('group', ['sage', 'watcher']), []).map(({ id }) => id)).toEqual([
      'sage',
      'watcher',
    ])
  })

  it('lists only the addressee in a direct message', () => {
    expect(chatRoster([agent('sage'), agent('watcher')], chat('dm', ['watcher']), []).map(({ id }) => id)).toEqual(['watcher'])
  })
})
