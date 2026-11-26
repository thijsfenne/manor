import { MAIL_LABEL_NAME, MAIL_LABELS, type MailAddress, type MailCard, type MailLabel } from '@manor/contracts'

/** What the Mail view shows and what its keys do, kept apart from the components so it can be tested. */

export type MailTab = 'all' | MailLabel

export const MAIL_TABS: readonly { value: MailTab; label: string }[] = [
  { value: 'all', label: 'All' },
  ...MAIL_LABELS.map((label) => ({ value: label, label: MAIL_LABEL_NAME[label] })),
]

export const mailSenderName = (from: MailAddress): string => from.name === '' ? from.address : from.name

export function mailCardsInTab(cards: readonly MailCard[], tab: MailTab): MailCard[] {
  return tab === 'all' ? [...cards] : cards.filter((card) => card.label === tab)
}

/** Matches on the subject and on the sender's name or address, ignoring case. */
export function searchMailCards(cards: readonly MailCard[], query: string): MailCard[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return [...cards]
  return cards.filter((card) =>
    [card.subject, card.from.name, card.from.address].some((text) => text.toLowerCase().includes(needle)))
}

/** The cards the sidebar lists, in the order the host sent them. */
export function listedMailCards(cards: readonly MailCard[], tab: MailTab, query: string): MailCard[] {
  return searchMailCards(mailCardsInTab(cards, tab), query)
}

/** What to select when a listed card is archived: the next one, else the previous one. */
export function mailNeighbour(listed: readonly MailCard[], threadId: string): string | null {
  const index = listed.findIndex((card) => card.threadId === threadId)
  if (index === -1) return null
  return (listed[index + 1] ?? listed[index - 1])?.threadId ?? null
}

/**
 * The selection one step down or up the list, stopping at its ends. From a thread that
 * is not listed, down starts at the first card and up at the last.
 */
export function steppedMailSelection(listed: readonly MailCard[], selectedId: string | null, step: 1 | -1): string | null {
  const index = listed.findIndex((card) => card.threadId === selectedId)
  const next = index === -1
    ? (step === 1 ? 0 : listed.length - 1)
    : Math.min(listed.length - 1, Math.max(0, index + step))
  return listed[next]?.threadId ?? null
}

export type MailKeyAction =
  | { kind: 'step'; step: 1 | -1 }
  | { kind: 'label'; label: MailLabel }
  | { kind: 'reply' | 'archive' | 'add' | 'search' | 'close' }

const MAIL_KEYS: Record<string, MailKeyAction> = {
  j: { kind: 'step', step: 1 },
  ArrowDown: { kind: 'step', step: 1 },
  k: { kind: 'step', step: -1 },
  ArrowUp: { kind: 'step', step: -1 },
  r: { kind: 'reply' },
  e: { kind: 'archive' },
  a: { kind: 'add' },
  '/': { kind: 'search' },
  Escape: { kind: 'close' },
  ...Object.fromEntries(MAIL_LABELS.map((label, index) => [String(index + 1), { kind: 'label', label }])),
}

/** What a plain key press does in the Mail view; the view decides whether keys count at all. */
export const mailKeyAction = (key: string): MailKeyAction | undefined =>
  Object.hasOwn(MAIL_KEYS, key) ? MAIL_KEYS[key] : undefined

const TIME = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const WEEKDAY = new Intl.DateTimeFormat('en-GB', { weekday: 'short' })
const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' })
const DAY_AND_YEAR = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

/** Whole days from the day of `at` to the day of `now`, by the device's calendar. */
function daysBefore(at: Date, now: Date): number {
  const midnight = (date: Date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())
  return Math.round((midnight(now) - midnight(at)) / 86_400_000)
}

/** `HH:mm` today, the short weekday within the past week, otherwise the date. */
export function mailTimeLabel(at: number, now: number): string {
  const then = new Date(at)
  const today = new Date(now)
  const days = daysBefore(then, today)
  if (days === 0) return TIME.format(then)
  if (days > 0 && days < 7) return WEEKDAY.format(then)
  return (then.getFullYear() === today.getFullYear() ? DAY : DAY_AND_YEAR).format(then)
}

export const mailAttachmentSize = (kb: number): string =>
  kb < 1024 ? `${Math.max(1, kb)} KB` : `${(kb / 1024).toFixed(1)} MB`
