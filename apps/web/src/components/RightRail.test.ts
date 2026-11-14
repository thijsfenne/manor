import { describe, expect, it } from 'vitest'
import { Files01Icon, Folder01Icon } from '@hugeicons/core-free-icons'
import type { Chat } from '@manor/contracts'
import { chatRailItems, offersSideChat } from './RightRail'

const options = { phone: false, singleChat: true, hasProject: true, canBrowseFiles: true, hasVault: true, hasBrowser: true, hasRoster: true, hasRepo: true }
const chat = { kind: 'group' } as Chat
const ids = (projectThread: boolean) => chatRailItems(chat, { ...options, projectThread }).map((item) => item.id)

describe('chatRailItems', () => {
  it('keeps only Files, Browser and Context in a project thread', () => {
    expect(ids(true)).toEqual(['files', 'browser', 'memory'])
  })
  it('keeps every door in a plain Single chat', () => {
    expect(ids(false)).toEqual(['agents', 'side', 'files', 'knowledge', 'browser'])
  })
  it('draws Files as a folder and Context as pages', () => {
    const icon = (kind: Chat['kind'], id: string) => chatRailItems({ kind } as Chat, { ...options, projectThread: true }).find((item) => item.id === id)?.icon
    expect(icon('group', 'files')).toBe(Folder01Icon)
    expect(icon('group', 'memory')).toBe(Files01Icon)
  })
  describe('the Session panel door for subagents', () => {
    const bare = { ...options, hasProject: false, canBrowseFiles: false, hasVault: false, hasBrowser: false, hasRoster: false, hasRepo: false }
    const doors = (extra: Partial<Parameters<typeof chatRailItems>[1]>) => chatRailItems(chat, { ...bare, ...extra })
    it('is absent from a No project Single Session without subagents', () => {
      expect(doors({}).map((item) => item.id)).not.toContain('agents')
    })
    it('opens a panel of only Agents for a No project Single Session with subagents', () => {
      const agents = doors({ hasHelpers: true }).filter((item) => item.id === 'agents')
      expect(agents).toHaveLength(1)
      expect(agents[0]?.busy).toBeUndefined()
    })
    it('dots the door while a subagent runs', () => {
      expect(doors({ hasHelpers: true, helpersRunning: true }).find((item) => item.id === 'agents')?.busy).toBe(true)
    })
    it('keeps the one Session door in a room Session with a repo, dotted while one runs', () => {
      const items = doors({ roomSession: true, hasRepo: true, hasHelpers: true, helpersRunning: true })
      expect(items).toEqual([expect.objectContaining({ id: 'agents', label: 'Session', busy: true })])
    })
  })
  describe('offersSideChat', () => {
    const offers = (kind: Chat['kind'], extra: Partial<Parameters<typeof chatRailItems>[1]> = {}) =>
      offersSideChat(chatRailItems({ kind } as Chat, { ...options, ...extra }))
    it('is true for a group and a No project Session', () => {
      expect(offers('group')).toBe(true)
      expect(offers('group', { hasProject: false, canBrowseFiles: false, hasRepo: false })).toBe(true)
    })
    it('is false in a DM, whatever else its rail offers', () => {
      expect(offers('dm')).toBe(false)
      expect(offers('dm', { hasProject: false, hasVault: false, hasBrowser: false })).toBe(false)
      expect(chatRailItems({ kind: 'dm' } as Chat, options).map((item) => item.id)).toEqual(['files', 'knowledge', 'browser', 'agent'])
    })
    it('gives a DM one door for its agent: memory and scheduled tasks are pages of Agent settings', () => {
      const dm = chatRailItems({ kind: 'dm' } as Chat, options).map((item) => item.label)
      expect(dm).toContain('Agent settings')
      expect(dm).not.toContain('Agent memory')
      expect(dm).not.toContain('Scheduled tasks')
      expect(chatRailItems({ kind: 'dm' } as Chat, { ...options, phone: true }).map((item) => item.id)).toEqual(['agent'])
    })
    it('is false in a project thread, a project Session, a pair chat and on the phone', () => {
      expect(offers('group', { projectThread: true })).toBe(false)
      expect(offers('group', { roomSession: true })).toBe(false)
      expect(offers('pair')).toBe(false)
      expect(offers('dm', { phone: true })).toBe(false)
    })
  })
})
