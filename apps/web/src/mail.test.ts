import { describe, expect, it } from 'vitest'
import { MAIL_DRAFT_BODY_MAX, type MailCard, type MailMessage } from '@manor/contracts'
import {
  listedMailCards,
  MAIL_TABS,
  mailAttachmentSize,
  mailCardsInTab,
  mailForwardBody,
  mailKeyAction,
  mailNeighbour,
  mailRange,
  mailTimeLabel,
  mailViewShowing,
  searchMailCards,
  steppedMailSelection,
  toggledMailSelection,
  unlabelledMailCount,
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
  card('d', { label: 'other', subject: 'Robin weekly digest' }),
]
const three = cards.slice(0, 3)
const ids = (listed: MailCard[]) => listed.map((entry) => entry.threadId)

describe('mail helpers', () => {
  it('has three tabs, Needs attention first, and lists neither Other nor unlabelled cards in any', () => {
    expect(MAIL_TABS.map((tab) => tab.label)).toEqual(['Needs attention', 'Waiting', 'FYI'])
    expect(ids(mailCardsInTab(cards, 'reply'))).toEqual(['a'])
    expect(ids(mailCardsInTab(cards, 'wait'))).toEqual(['b'])
    expect(mailCardsInTab(cards, 'fyi')).toEqual([])
    expect(MAIL_TABS.flatMap((tab) => ids(listedMailCards(cards, tab.value, ' ')))).toEqual(['a', 'b'])
    expect(unlabelledMailCount(cards)).toBe(1)
  })

  it('searches subject and sender across every label, whatever the tab', () => {
    expect(ids(searchMailCards(cards, '  ROOF '))).toEqual(['a'])
    expect(ids(searchMailCards(cards, 'garden'))).toEqual(['b'])
    expect(ids(searchMailCards(cards, 'robin ex'))).toEqual(['a', 'c', 'd'])
    expect(ids(listedMailCards(cards, 'wait', 'robin'))).toEqual(['a', 'c', 'd'])
    expect(listedMailCards(cards, 'wait', 'nothing like it')).toEqual([])
  })

  it('finds the tab or search that lists a hidden card', () => {
    expect(mailViewShowing(cards[0]!, 'reply', '')).toEqual({})
    expect(mailViewShowing(cards[0]!, 'wait', '')).toEqual({ tab: 'reply', query: '' })
    expect(mailViewShowing(cards[3]!, 'reply', '')).toEqual({ query: 'Robin weekly digest' })
    expect(mailViewShowing({ ...cards[3]!, subject: ' ' }, 'reply', '')).toEqual({ query: cards[3]!.from.address })
    expect(mailViewShowing(cards[2]!, 'reply', 'robin')).toEqual({})
  })

  it('opens the card after the last archived one, else the nearest before it that stays', () => {
    expect(mailNeighbour(three, ['a'])).toBe('b')
    expect(mailNeighbour(three, ['c'])).toBe('b')
    expect(mailNeighbour(cards, ['b', 'a'])).toBe('c')
    expect(mailNeighbour(cards, ['c', 'd'])).toBe('b')
    expect(mailNeighbour(three, ['a', 'c'])).toBe('b')
    expect(mailNeighbour(cards, ['b', 'gone'])).toBe('c')
    expect(mailNeighbour([cards[0]!], ['a'])).toBeNull()
    expect(mailNeighbour(three, ['gone'])).toBeNull()
    expect(mailNeighbour(three, [])).toBeNull()
  })

  it('toggles a card in the selection and picks a range in list order', () => {
    expect(toggledMailSelection(['a'], 'c')).toEqual(['a', 'c'])
    expect(toggledMailSelection(['a', 'c'], 'a')).toEqual(['c'])
    expect(toggledMailSelection([], 'b')).toEqual(['b'])
    expect(mailRange(cards, 'a', 'c')).toEqual(['a', 'b', 'c'])
    expect(mailRange(cards, 'd', 'b')).toEqual(['b', 'c', 'd'])
    expect(mailRange(cards, 'b', 'b')).toEqual(['b'])
    expect(mailRange(cards, null, 'c')).toEqual(['c'])
    expect(mailRange(cards, 'gone', 'c')).toEqual(['c'])
  })

  it('steps through the listed cards and stops at the ends', () => {
    expect(steppedMailSelection(three, 'a', 1)).toBe('b')
    expect(steppedMailSelection(three, 'c', 1)).toBe('c')
    expect(steppedMailSelection(three, 'a', -1)).toBe('a')
    expect(steppedMailSelection(three, null, 1)).toBe('a')
    expect(steppedMailSelection(three, 'gone', -1)).toBe('c')
    expect(steppedMailSelection([], 'a', 1)).toBeNull()
  })

  it('reads the keys of the view', () => {
    expect(mailKeyAction('j')).toEqual({ kind: 'step', step: 1 })
    expect(mailKeyAction('ArrowUp')).toEqual({ kind: 'step', step: -1 })
    expect(['1', '2', '3', '4'].map(mailKeyAction)).toEqual([
      { kind: 'label', label: 'reply' }, { kind: 'label', label: 'wait' }, { kind: 'label', label: 'fyi' }, { kind: 'label', label: 'other' },
    ])
    expect(mailKeyAction('5')).toBeUndefined()
    expect(['r', 'f', 'e', 'a', '/', 'Escape'].map((key) => mailKeyAction(key)?.kind)).toEqual(['reply', 'forward', 'archive', 'add', 'search', 'close'])
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

  it('quotes the newest message under a header for a forward, and cuts a long one to leave room for a note', () => {
    const message = (id: string, text: string, over: Partial<MailMessage> = {}): MailMessage => ({
      id, from: { name: 'Robin Example', address: 'robin@example.com' }, to: [{ name: '', address: 'me@example.com' }, { name: 'Sam Example', address: 'sam@example.com' }],
      cc: [], at: new Date(2026, 10, 26, 12, 0).getTime(), text, truncated: false, attachments: [], mine: false, ...over,
    })
    const thread = { subject: 'Quote for the roof', messages: [message('m1', 'Older.'), message('m2', 'The quote is attached.')] }
    expect(mailForwardBody(thread)).toBe([
      '',
      '',
      '---------- Forwarded message ---------',
      'From: Robin Example <robin@example.com>',
      'Date: 26 Nov 2026, 12:00',
      'Subject: Quote for the roof',
      'To: me@example.com, Sam Example <sam@example.com>',
      '',
      'The quote is attached.',
    ].join('\n'))

    const long = mailForwardBody({ ...thread, messages: [message('m3', 'word '.repeat(4_000))] })
    expect(long.endsWith('word\n[cut]')).toBe(true)
    expect(long.length).toBeLessThanOrEqual(MAIL_DRAFT_BODY_MAX - 2_000)
    expect(long.length).toBeGreaterThan(MAIL_DRAFT_BODY_MAX - 2_100)
    // The cap covers the header too, however many people the mail went to.
    const crowd = Array.from({ length: 900 }, (_, index) => ({ name: '', address: `guest${index}@example.com` }))
    expect(mailForwardBody({ ...thread, messages: [message('m5', 'Short.', { to: crowd })] }).length).toBeLessThanOrEqual(MAIL_DRAFT_BODY_MAX - 2_000)
    // Text the host already cut says so too.
    expect(mailForwardBody({ ...thread, messages: [message('m4', 'Short.', { truncated: true })] }).endsWith('Short.\n[cut]')).toBe(true)
  })

  it('names an attachment size', () => {
    expect(mailAttachmentSize(0)).toBe('1 KB')
    expect(mailAttachmentSize(240)).toBe('240 KB')
    expect(mailAttachmentSize(1536)).toBe('1.5 MB')
  })
})
