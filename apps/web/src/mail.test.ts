import { describe, expect, it } from 'vitest'
import type { MailCard } from '@manor/contracts'
import {
  listedMailCards,
  MAIL_TABS,
  mailAttachmentSize,
  mailCardsInTab,
  mailKeyAction,
  mailNeighbour,
  mailTimeLabel,
  searchMailCards,
  steppedMailSelection,
} from './mail'

const card = (threadId: string, over: Partial<MailCard> = {}): MailCard => ({
  threadId,
  subject: `Subject ${threadId}`,
  from: { name: 'Robin Example', address: 'robin@example.com' },
  at: 0,
  unread: false,
  messageCount: 1,
  ...over,
})
const cards = [
  card('a', { label: 'reply', subject: 'Quote for the roof' }),
  card('b', { label: 'wait', from: { name: '', address: 'billing@garden.example' } }),
  card('c'),
]
const ids = (listed: MailCard[]) => listed.map((entry) => entry.threadId)

describe('mail helpers', () => {
  it('filters by tab, and All keeps the unlabelled ones', () => {
    expect(MAIL_TABS.map((tab) => tab.label)).toEqual(['All', 'Needs reply', 'Waiting', 'FYI'])
    expect(ids(mailCardsInTab(cards, 'all'))).toEqual(['a', 'b', 'c'])
    expect(ids(mailCardsInTab(cards, 'wait'))).toEqual(['b'])
    expect(mailCardsInTab(cards, 'fyi')).toEqual([])
  })

  it('searches subject and sender, and combines with the tab', () => {
    expect(ids(searchMailCards(cards, '  ROOF '))).toEqual(['a'])
    expect(ids(searchMailCards(cards, 'garden'))).toEqual(['b'])
    expect(ids(searchMailCards(cards, 'robin ex'))).toEqual(['a', 'c'])
    expect(ids(searchMailCards(cards, ''))).toEqual(['a', 'b', 'c'])
    expect(ids(listedMailCards(cards, 'reply', 'robin'))).toEqual(['a'])
    expect(listedMailCards(cards, 'wait', 'roof')).toEqual([])
  })

  it('selects the next card after an archive, else the previous one', () => {
    expect(mailNeighbour(cards, 'a')).toBe('b')
    expect(mailNeighbour(cards, 'c')).toBe('b')
    expect(mailNeighbour([cards[0]!], 'a')).toBeNull()
    expect(mailNeighbour(cards, 'gone')).toBeNull()
  })

  it('steps through the listed cards and stops at the ends', () => {
    expect(steppedMailSelection(cards, 'a', 1)).toBe('b')
    expect(steppedMailSelection(cards, 'c', 1)).toBe('c')
    expect(steppedMailSelection(cards, 'a', -1)).toBe('a')
    expect(steppedMailSelection(cards, null, 1)).toBe('a')
    expect(steppedMailSelection(cards, 'gone', -1)).toBe('c')
    expect(steppedMailSelection([], 'a', 1)).toBeNull()
  })

  it('reads the keys of the view', () => {
    expect(mailKeyAction('j')).toEqual({ kind: 'step', step: 1 })
    expect(mailKeyAction('ArrowUp')).toEqual({ kind: 'step', step: -1 })
    expect(['1', '2', '3'].map(mailKeyAction)).toEqual([
      { kind: 'label', label: 'reply' }, { kind: 'label', label: 'wait' }, { kind: 'label', label: 'fyi' },
    ])
    expect(['r', 'e', 'a', '/', 'Escape'].map((key) => mailKeyAction(key)?.kind)).toEqual(['reply', 'archive', 'add', 'search', 'close'])
    expect(mailKeyAction('x')).toBeUndefined()
    expect(mailKeyAction('toString')).toBeUndefined()
  })

  it('labels a time by how long ago its day was', () => {
    const at = (month: number, day: number, hour = 9, minute = 5, year = 2026) => new Date(year, month - 1, day, hour, minute).getTime()
    const now = at(11, 26, 18, 0)
    expect(mailTimeLabel(at(11, 26), now)).toBe('09:05')
    expect(mailTimeLabel(at(11, 26, 0, 0), now)).toBe('00:00')
    expect(mailTimeLabel(at(11, 25, 23, 59), now)).toBe('Wed')
    expect(mailTimeLabel(at(11, 20), now)).toBe('Fri')
    expect(mailTimeLabel(at(11, 19), now)).toBe('19 Nov')
    expect(mailTimeLabel(at(12, 31, 12, 0, 2025), now)).toBe('31 Dec 2025')
  })

  it('names an attachment size', () => {
    expect(mailAttachmentSize(0)).toBe('1 KB')
    expect(mailAttachmentSize(240)).toBe('240 KB')
    expect(mailAttachmentSize(1536)).toBe('1.5 MB')
  })
})
