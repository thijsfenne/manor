import type { AgentConfig, Chat } from '@manor/contracts'
import { describe, expect, it } from 'vitest'
import { chatRoster } from '../src/chatRoster'

const agent = (id: string): AgentConfig => ({ id, name: id, color: '#8b5cf6', allowedTools: [] }) as unknown as AgentConfig

const ROSTER = [agent('jeeves'), agent('sage'), agent('smith'), agent('argus')]

const chat = (kind: Chat['kind'], memberIds: string[] = []) => ({ kind, memberIds })

const ids = (agents: AgentConfig[]) => agents.map((a) => a.id)

describe('chatRoster', () => {
  it('gives a dormant persona a row in a project chat, which is what makes her pin reachable', () => {
    expect(ids(chatRoster(ROSTER, chat('project'), ['smith']))).toEqual(['smith', 'jeeves', 'sage', 'argus'])
  })

  it('keeps roster order when nobody has spoken yet', () => {
    expect(ids(chatRoster(ROSTER, chat('project'), []))).toEqual(['jeeves', 'sage', 'smith', 'argus'])
  })

  it('orders participants by the transcript and leaves the rest in roster order', () => {
    expect(ids(chatRoster(ROSTER, chat('project'), ['argus', 'sage']))).toEqual([
      'argus',
      'sage',
      'jeeves',
      'smith',
    ])
  })

  it('lists only the member in a dm, because a mention of anyone else is dropped', () => {
    expect(ids(chatRoster(ROSTER, chat('dm', ['sage']), ['sage']))).toEqual(['sage'])
  })

  it('lists a group by its membership, not by who has spoken', () => {
    expect(ids(chatRoster(ROSTER, chat('group', ['smith', 'argus']), ['smith']))).toEqual(['smith', 'argus'])
  })

  it('drops a member who is no longer on the roster rather than inventing a row', () => {
    expect(ids(chatRoster(ROSTER, chat('group', ['smith', 'ghost']), []))).toEqual(['smith'])
  })

  it('falls back to the household when no chat is open', () => {
    expect(ids(chatRoster(ROSTER, null, []))).toEqual(['jeeves', 'sage', 'smith', 'argus'])
  })

  it('ignores a speaker who is not on the roster', () => {
    expect(ids(chatRoster(ROSTER, chat('project'), ['ghost', 'sage']))).toEqual([
      'sage',
      'jeeves',
      'smith',
      'argus',
    ])
  })
})
