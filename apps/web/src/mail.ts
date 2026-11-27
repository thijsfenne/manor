import { MAIL_DRAFT_BODY_MAX, MAIL_LABEL_NAME, MAIL_LABELS, MAIL_TAB_LABELS, mailAddressLine, type MailAddress, type MailCard, type MailLabel, type MailThread } from '@manor/contracts'

/** What the Mail view shows and what its keys do, kept apart from the components so it can be tested. */

export type MailTab = (typeof MAIL_TAB_LABELS)[number]

export const MAIL_TABS = MAIL_TAB_LABELS.map((label) => ({ value: label, label: MAIL_LABEL_NAME[label] }))

const isMailTab = (label: MailLabel | undefined): label is MailTab => MAIL_TAB_LABELS.some((tab) => tab === label)

export const mailSenderName = (from: MailAddress): string => from.name === '' ? from.address : from.name

/** A tab holds only its own label; Other and unlabelled cards are reached by search. */
export function mailCardsInTab(cards: readonly MailCard[], tab: MailTab): MailCard[] {
  return cards.filter((card) => card.label === tab)
}

/** How many cards each tab holds, for the counts beside the tab labels. */
export const mailTabCounts = (cards: readonly MailCard[]): Record<MailTab, number> =>
  Object.fromEntries(MAIL_TAB_LABELS.map((tab) => [tab, mailCardsInTab(cards, tab).length])) as Record<MailTab, number>

/** A query of only spaces is no search, so the tabs stay. */
export const mailSearching = (query: string): boolean => query.trim() !== ''

/** The cards no labelling run has reached yet, which the triage button and the empty states count. */
export const unlabelledMailCount = (cards: readonly MailCard[]): number =>
  cards.filter((card) => card.label === undefined).length

/** Matches on the subject and on the sender's name or address, ignoring case. */
export function searchMailCards(cards: readonly MailCard[], query: string): MailCard[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return [...cards]
  return cards.filter((card) =>
    [card.subject, card.from.name, card.from.address].some((text) => text.toLowerCase().includes(needle)))
}

/** The cards the sidebar lists, in the order the host sent them: the tab's, or every match of a search. */
export function listedMailCards(cards: readonly MailCard[], tab: MailTab, query: string): MailCard[] {
  return mailSearching(query) ? searchMailCards(cards, query) : mailCardsInTab(cards, tab)
}

/**
 * The view change that lists a card the current tab or search hides: its own tab, or a
 * search for its subject (its sender when it has none) when its label has no tab. Empty
 * when it is listed already.
 */
export function mailViewShowing(card: MailCard, tab: MailTab, query: string): { tab?: MailTab; query?: string } {
  if (listedMailCards([card], tab, query).length > 0) return {}
  if (isMailTab(card.label)) return { tab: card.label, query: '' }
  return { query: [card.subject, card.from.address, card.from.name].find((text) => text.trim() !== '') ?? '' }
}

/**
 * What to open once listed cards are archived: the card after the last archived one, else
 * the nearest card before it that stays. Null when none of them was listed.
 */
export function mailNeighbour(listed: readonly MailCard[], archived: readonly string[]): string | null {
  const last = listed.map((card) => archived.includes(card.threadId)).lastIndexOf(true)
  if (last === -1) return null
  const before = listed.slice(0, last).filter((card) => !archived.includes(card.threadId))
  return (listed[last + 1] ?? before.at(-1))?.threadId ?? null
}

/** A Cmd or Ctrl click: the card joins the selection, or leaves it when it was in. */
export const toggledMailSelection = (selection: readonly string[], threadId: string): string[] =>
  selection.includes(threadId) ? selection.filter((id) => id !== threadId) : [...selection, threadId]

/**
 * A Shift click: the listed cards from the anchor to the clicked card, in list order.
 * Only the clicked card when the anchor is not listed.
 */
export function mailRange(listed: readonly MailCard[], anchorId: string | null, threadId: string): string[] {
  const from = listed.findIndex((card) => card.threadId === anchorId)
  const to = listed.findIndex((card) => card.threadId === threadId)
  if (from === -1 || to === -1) return [threadId]
  return listed.slice(Math.min(from, to), Math.max(from, to) + 1).map((card) => card.threadId)
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
  | { kind: 'reply' | 'forward' | 'archive' | 'add' | 'search' | 'close' }

const MAIL_KEYS: Record<string, MailKeyAction> = {
  j: { kind: 'step', step: 1 },
  ArrowDown: { kind: 'step', step: 1 },
  k: { kind: 'step', step: -1 },
  ArrowUp: { kind: 'step', step: -1 },
  r: { kind: 'reply' },
  f: { kind: 'forward' },
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

const FULL_DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

/** Room a forward always keeps free for the user's own note above the quote. */
const FORWARD_NOTE_ROOM = 2_000

/**
 * The text a forward's pane starts with: an empty line for the user's own note, then the
 * newest message of the thread quoted under a header. A quote, header included, that would
 * leave less than `FORWARD_NOTE_ROOM` of the body cap, or that the host already cut, ends
 * in `[cut]`.
 */
export function mailForwardBody(thread: Pick<MailThread, 'subject' | 'messages'>): string {
  const message = thread.messages.at(-1)
  if (message === undefined) return ''
  const head = [
    '',
    '',
    '---------- Forwarded message ---------',
    `From: ${mailAddressLine(message.from)}`,
    `Date: ${FULL_DATE.format(new Date(message.at))}`,
    `Subject: ${thread.subject}`,
    `To: ${message.to.map(mailAddressLine).join(', ')}`,
    '',
    '',
  ].join('\n')
  const quote = head + message.text
  const cut = '\n[cut]'
  const room = MAIL_DRAFT_BODY_MAX - FORWARD_NOTE_ROOM
  if (quote.length <= room && !message.truncated) return quote
  return quote.slice(0, room - cut.length).trimEnd() + cut
}
