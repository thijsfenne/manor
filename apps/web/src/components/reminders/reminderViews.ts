import type { Reminder, ReminderChanges, ReminderDue, ReminderList } from '@manor/contracts'
import {
  addDays,
  pendingReminderId,
  timeSlot,
  type PendingReminderWrite,
  type ReminderTimeSlot,
  type RemindersSnapshot,
} from '@manor/client-runtime/reminders'

/**
 * What the Reminders door shows, as pure functions over the snapshot: which reminders a
 * tile or list holds, how the list, columns and calendar group them, and which of the
 * client's own writes still need laying over the server's truth.
 */

export type ReminderTile = 'today' | 'scheduled' | 'flagged' | 'assigned' | 'all' | 'completed'

/** A tile, a list, or one section of a list. */
export type ReminderScope =
  | { kind: 'tile'; tile: ReminderTile }
  | { kind: 'list'; listId: string; sectionId?: string }

export type ReminderLayout = 'list' | 'columns' | 'calendar'

export const TILE_LABEL: Record<ReminderTile, string> = {
  today: 'Today',
  scheduled: 'Scheduled',
  flagged: 'Flagged',
  assigned: 'Assigned to me',
  all: 'All',
  completed: 'Completed',
}

/** The tiles that need the private API: in plain mode nobody is flagged or assigned. */
export const PRIVATE_TILES: ReadonlySet<ReminderTile> = new Set(['flagged', 'assigned'])

export const scopeKey = (scope: ReminderScope): string =>
  scope.kind === 'tile' ? `tile:${scope.tile}` : `list:${scope.listId}${scope.sectionId === undefined ? '' : `:${scope.sectionId}`}`

export const sameScope = (a: ReminderScope, b: ReminderScope): boolean => scopeKey(a) === scopeKey(b)

/** The scope's own name; a section reads as its list's name followed by its own. */
export function scopeTitle(scope: ReminderScope, lists: readonly ReminderList[]): string {
  if (scope.kind === 'tile') return TILE_LABEL[scope.tile]
  const list = lists.find((candidate) => candidate.id === scope.listId)
  if (list === undefined) return 'Reminders'
  const section = scope.sectionId === undefined ? undefined : list.sections.find((candidate) => candidate.id === scope.sectionId)
  return section === undefined ? list.title : `${list.title} / ${section.title}`
}

/**
 * A remembered scope can outlive what it points at: a list deleted in Reminders.app,
 * a section merged away, or a private tile after a macOS update broke the private API.
 */
export function scopeExists(scope: ReminderScope, lists: readonly ReminderList[], plain: boolean): boolean {
  if (scope.kind === 'tile') return !(plain && PRIVATE_TILES.has(scope.tile))
  const list = lists.find((candidate) => candidate.id === scope.listId)
  if (list === undefined) return false
  return scope.sectionId === undefined || (!plain && list.sections.some((section) => section.id === scope.sectionId))
}

/** Completed has its own paged list; every other scope reads the open reminders. */
export function inScope(reminder: Reminder, scope: ReminderScope, today: string): boolean {
  if (scope.kind === 'list') {
    return reminder.listId === scope.listId && (scope.sectionId === undefined || reminder.sectionId === scope.sectionId)
  }
  switch (scope.tile) {
    case 'today':
      return reminder.due !== undefined && reminder.due.day <= today
    case 'scheduled':
      return reminder.due !== undefined
    case 'flagged':
      return reminder.flagged
    case 'assigned':
      return reminder.assignee?.me === true
    case 'all':
    case 'completed':
      return true
  }
}

/** Title, notes and tags, case-insensitive; every word has to appear somewhere. */
export function matchesSearch(reminder: Reminder, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter((word) => word !== '')
  if (words.length === 0) return true
  const haystack = [reminder.title, reminder.notes ?? '', ...reminder.tags.map((tag) => `#${tag}`)].join('\n').toLowerCase()
  return words.every((word) => haystack.includes(word))
}

/** Dated before undated, earlier day first, and within a day all-day before timed. */
export function compareDue(a: Reminder, b: Reminder): number {
  if (a.due === undefined || b.due === undefined) return a.due === undefined ? (b.due === undefined ? 0 : 1) : -1
  if (a.due.day !== b.due.day) return a.due.day < b.due.day ? -1 : 1
  const at = a.due.time ?? ''
  const bt = b.due.time ?? ''
  return at === bt ? 0 : at < bt ? -1 : 1
}

/** A top-level row and the subtasks that hang under it on screen. */
export interface ReminderNode {
  reminder: Reminder
  subtasks: Reminder[]
}

/**
 * A subtask whose parent is in the same set nests under it. One whose parent is not
 * (a dated subtask in Today, a search that only matched the child) stands on its own,
 * because hiding a match behind a parent that is not there hides the match.
 */
export function nestSubtasks(reminders: readonly Reminder[]): ReminderNode[] {
  const present = new Set(reminders.map((reminder) => reminder.id))
  const children = new Map<string, Reminder[]>()
  for (const reminder of reminders) {
    if (reminder.parentId === undefined || !present.has(reminder.parentId)) continue
    const siblings = children.get(reminder.parentId) ?? []
    siblings.push(reminder)
    children.set(reminder.parentId, siblings)
  }
  return reminders
    .filter((reminder) => reminder.parentId === undefined || !present.has(reminder.parentId))
    .map((reminder) => ({ reminder, subtasks: children.get(reminder.id) ?? [] }))
}

export interface ReminderGroup {
  key: string
  /** Null for the reminders of a list that sit in no section, which Reminders.app shows headless. */
  title: string | null
  /** A list's own colour, for groups that stand for a list. Runtime data, not a token. */
  color?: string
  /** A day group before today. */
  overdue?: boolean
  nodes: ReminderNode[]
}

/**
 * The list view's sections. A list shows its own sections, including empty ones so
 * its shape stays readable (except while searching, where an empty section is noise).
 * Scheduled groups by day; the other tiles group by list.
 */
export function listGroups(
  reminders: readonly Reminder[],
  scope: ReminderScope,
  lists: readonly ReminderList[],
  today: string,
  options: { plain: boolean; searching: boolean },
): ReminderGroup[] {
  if (scope.kind === 'list') {
    const list = lists.find((candidate) => candidate.id === scope.listId)
    if (scope.sectionId !== undefined || list === undefined || options.plain || list.sections.length === 0) {
      return [{ key: 'all', title: null, nodes: nestSubtasks(reminders) }]
    }
    const known = new Set(list.sections.map((section) => section.id))
    const loose = reminders.filter((reminder) => reminder.sectionId === undefined || !known.has(reminder.sectionId))
    const groups: ReminderGroup[] = loose.length === 0 ? [] : [{ key: 'none', title: null, nodes: nestSubtasks(loose) }]
    for (const section of list.sections) {
      const nodes = nestSubtasks(reminders.filter((reminder) => reminder.sectionId === section.id))
      if (nodes.length === 0 && options.searching) continue
      groups.push({ key: section.id, title: section.title, nodes })
    }
    return groups
  }
  if (scope.tile === 'scheduled') {
    const sorted = [...reminders].sort(compareDue)
    const groups: ReminderGroup[] = []
    for (const reminder of sorted) {
      if (reminder.due === undefined) continue
      const overdue = reminder.due.day < today
      const key = overdue ? 'overdue' : reminder.due.day
      let group = groups.find((candidate) => candidate.key === key)
      if (group === undefined) {
        group = { key, title: overdue ? 'Overdue' : dayHeading(reminder.due.day, today), ...(overdue ? { overdue } : {}), nodes: [] }
        groups.push(group)
      }
      group.nodes.push({ reminder, subtasks: [] })
    }
    return groups.map((group) => ({ ...group, nodes: nestSubtasks(group.nodes.map((node) => node.reminder)) }))
  }
  const sorted = scope.tile === 'today' ? [...reminders].sort(compareDue) : [...reminders]
  return lists.flatMap((list) => {
    const nodes = nestSubtasks(sorted.filter((reminder) => reminder.listId === list.id))
    return nodes.length === 0 ? [] : [{ key: list.id, title: list.title, ...(list.color === undefined ? {} : { color: list.color }), nodes }]
  })
}

export interface ReminderColumn {
  key: string
  title: string
  /** A section column takes a dropped card and moves it into this section. */
  sectionId?: string
  nodes: ReminderNode[]
}

/**
 * Section columns in the order saved in Manor, which Apple never hears about. A section
 * the saved order does not name keeps Apple's order after the ones it does, and a saved
 * section that is gone has no column to place, so it simply stops counting.
 */
export function inSavedOrder<T extends { key: string }>(columns: readonly T[], saved: readonly string[]): T[] {
  const rank = new Map(saved.map((key, index) => [key, index]))
  const place = (column: T) => rank.get(column.key) ?? saved.length
  return [...columns].sort((a, b) => place(a) - place(b))
}

/**
 * The saved order brought up to date with a list's sections, the first time each change
 * is seen. Writing it down is what keeps a section at the end: the next new one lands
 * after it, wherever Apple puts either. Null when nothing changed.
 */
export function reconciledOrder(saved: readonly string[], sectionIds: readonly string[]): string[] | null {
  const order = inSavedOrder(sectionIds.map((key) => ({ key })), saved).map((column) => column.key)
  return order.length === saved.length && order.every((key, index) => key === saved[index]) ? null : order
}

const SLOT_TITLE: Record<ReminderTimeSlot, string> = {
  overdue: 'Overdue',
  today: 'Today',
  afternoon: 'Afternoon',
  tonight: 'Tonight',
  tomorrow: 'Tomorrow',
  later: 'Later',
  none: 'No date',
}

const DAY_SLOTS: readonly ReminderTimeSlot[] = ['overdue', 'today', 'afternoon', 'tonight']

/**
 * Today holds only today and before. Scheduled cannot hold an undated reminder. The
 * other tiles hold undated ones too, and a column board that dropped them would say
 * those reminders do not exist.
 */
function slotsFor(tile: ReminderTile): readonly ReminderTimeSlot[] {
  if (tile === 'today') return DAY_SLOTS
  if (tile === 'scheduled') return [...DAY_SLOTS, 'tomorrow', 'later']
  return [...DAY_SLOTS, 'tomorrow', 'later', 'none']
}

export interface ReminderBoard {
  columns: ReminderColumn[]
  /**
   * Time columns with nothing dated in them. The board then shows its empty state
   * in their place rather than a row of blank columns, keeping any No date column.
   */
  undated: boolean
}

/** Section columns for a list, time columns for a tile. Plain mode has no sections to split by. */
export function boardColumns(
  reminders: readonly Reminder[],
  scope: ReminderScope,
  lists: readonly ReminderList[],
  now: { day: string; time: string },
  plain: boolean,
): ReminderBoard {
  if (scope.kind === 'list') {
    const list = lists.find((candidate) => candidate.id === scope.listId)
    if (scope.sectionId !== undefined || list === undefined || plain || list.sections.length === 0) {
      return { columns: [{ key: 'all', title: scopeTitle(scope, lists), nodes: nestSubtasks(reminders) }], undated: false }
    }
    const known = new Set(list.sections.map((section) => section.id))
    const loose = reminders.filter((reminder) => reminder.sectionId === undefined || !known.has(reminder.sectionId))
    const columns: ReminderColumn[] = loose.length === 0 ? [] : [{ key: 'none', title: 'No section', nodes: nestSubtasks(loose) }]
    for (const section of list.sections) {
      columns.push({
        key: section.id,
        title: section.title,
        sectionId: section.id,
        nodes: nestSubtasks(reminders.filter((reminder) => reminder.sectionId === section.id)),
      })
    }
    return { columns, undated: false }
  }
  const slots = slotsFor(scope.tile)
  const sorted = [...reminders].sort(compareDue)
  const columns = slots.map((slot) => ({
    key: slot,
    title: SLOT_TITLE[slot],
    nodes: nestSubtasks(sorted.filter((reminder) => timeSlot(reminder, now) === slot)),
  }))
  const undated = !reminders.some((reminder) => reminder.due !== undefined)
  return { columns: undated ? columns.filter((column) => column.key === 'none' && column.nodes.length > 0) : columns, undated }
}

/** Six Monday-first weeks covering `month` (`YYYY-MM`), as `YYYY-MM-DD` days. */
export function calendarWeeks(month: string): string[][] {
  const first = `${month}-01`
  const [year, monthIndex] = month.split('-').map(Number)
  // getUTCDay: 0 is Sunday. Monday-first puts Sunday at the end of the row.
  const weekday = (new Date(Date.UTC(year!, monthIndex! - 1, 1)).getUTCDay() + 6) % 7
  const start = addDays(first, -weekday)
  return Array.from({ length: 6 }, (_, week) => Array.from({ length: 7 }, (_, day) => addDays(start, week * 7 + day)))
}

export const monthOf = (day: string): string => day.slice(0, 7)

export function shiftMonth(month: string, delta: number): string {
  const [year, monthIndex] = month.split('-').map(Number)
  const next = new Date(Date.UTC(year!, monthIndex! - 1 + delta, 1))
  return next.toISOString().slice(0, 7)
}

/** The same date in another month, held to its length: 31 January a month on is 28 February. */
export function dayInMonth(month: string, date: number): string {
  const [year, monthIndex] = month.split('-').map(Number)
  const last = new Date(Date.UTC(year!, monthIndex!, 0)).getUTCDate()
  return `${month}-${String(Math.min(date, last)).padStart(2, '0')}`
}

/** Where a key moves the date picker's focused day: arrows by day and week, Page keys by month. Null for any other key. */
export function stepDay(day: string, key: string): string | null {
  switch (key) {
    case 'ArrowLeft':
      return addDays(day, -1)
    case 'ArrowRight':
      return addDays(day, 1)
    case 'ArrowUp':
      return addDays(day, -7)
    case 'ArrowDown':
      return addDays(day, 7)
    case 'PageUp':
      return dayInMonth(shiftMonth(monthOf(day), -1), Number(day.slice(8)))
    case 'PageDown':
      return dayInMonth(shiftMonth(monthOf(day), 1), Number(day.slice(8)))
    default:
      return null
  }
}

/** Dated reminders by day, each day in due order. */
export function remindersByDay(reminders: readonly Reminder[]): Map<string, Reminder[]> {
  const days = new Map<string, Reminder[]>()
  for (const reminder of [...reminders].sort(compareDue)) {
    if (reminder.due === undefined) continue
    const day = days.get(reminder.due.day) ?? []
    day.push(reminder)
    days.set(reminder.due.day, day)
  }
  return days
}

const dateOf = (day: string) => {
  const [year, month, date] = day.split('-').map(Number)
  return new Date(Date.UTC(year!, month! - 1, date!))
}

const daysBetween = (from: string, to: string) => Math.round((dateOf(to).getTime() - dateOf(from).getTime()) / 86_400_000)

export function monthLabel(month: string): string {
  return new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(dateOf(`${month}-01`))
}

/** A day as a person says it: Today, Tomorrow, a weekday this week, else the date. */
export function dayLabel(day: string, today: string): string {
  const offset = daysBetween(today, day)
  if (offset === 0) return 'Today'
  if (offset === 1) return 'Tomorrow'
  if (offset === -1) return 'Yesterday'
  const date = dateOf(day)
  if (offset > 1 && offset < 7) return new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: 'UTC' }).format(date)
  const sameYear = day.slice(0, 4) === today.slice(0, 4)
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
    timeZone: 'UTC',
  }).format(date)
}

/** A Scheduled heading also names the weekday past this week, so a date is never bare. */
function dayHeading(day: string, today: string): string {
  const label = dayLabel(day, today)
  const offset = daysBetween(today, day)
  if (offset >= 0 && offset < 7) return label
  const weekday = new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: 'UTC' }).format(dateOf(day))
  return `${weekday} ${label}`
}

/** A row's due label and whether it has passed, against Amsterdam wall time. */
export function dueLabel(due: ReminderDue, now: { day: string; time: string }): { text: string; overdue: boolean } {
  const day = dayLabel(due.day, now.day)
  const overdue = due.day < now.day || (due.day === now.day && due.time !== undefined && due.time < now.time)
  return { text: due.time === undefined ? day : `${day}, ${due.time}`, overdue }
}

/**
 * Where a reminder made from this scope lands, and what the scope already says about
 * it: a list or section, today's date from Today and Scheduled, the flag from Flagged,
 * The user from Assigned to me. Null when there is no list to put it in.
 */
export function newReminderTarget(
  scope: ReminderScope,
  lists: readonly ReminderList[],
  today: string,
  plain: boolean,
): { listId: string; changes: Omit<ReminderChanges, 'title' | 'listId'> } | null {
  if (scope.kind === 'list') {
    if (!lists.some((list) => list.id === scope.listId)) return null
    return { listId: scope.listId, changes: scope.sectionId === undefined || plain ? {} : { sectionId: scope.sectionId } }
  }
  const first = lists[0]
  if (first === undefined) return null
  switch (scope.tile) {
    case 'today':
    case 'scheduled':
      return { listId: first.id, changes: { due: { day: today } } }
    case 'flagged':
      return { listId: first.id, changes: plain ? {} : { flagged: true } }
    case 'assigned': {
      const shared = lists.find((list) => list.sharees.some((person) => person.me))
      const me = shared?.sharees.find((person) => person.me)
      return shared === undefined || me === undefined || plain
        ? { listId: first.id, changes: {} }
        : { listId: shared.id, changes: { assigneeId: me.id } }
    }
    case 'all':
    case 'completed':
      return { listId: first.id, changes: {} }
  }
}

/** A write the door sent, until the snapshot after its answer has taken over. */
export interface DoorWrite extends PendingReminderWrite {
  /** For a create: the reminder ids that already existed, so the new one can be told apart. */
  knownIds?: ReadonlySet<string>
  /** The server acked it, so the snapshot rendered with the answer shows it. */
  answered?: true
}

/** The reminder a create turned into, once the snapshot holds it; `taken` rows belong to an earlier create. */
export function createdReminderId(write: DoorWrite, reminders: readonly Reminder[], taken?: ReadonlySet<string>): string | undefined {
  const { action, knownIds } = write
  if (action.kind !== 'create' || knownIds === undefined) return undefined
  return reminders.find(
    (reminder) => !knownIds.has(reminder.id) && !taken?.has(reminder.id) &&
      reminder.title === action.title.trim() && reminder.listId === action.listId,
  )?.id
}

/** The row each create became, by request id, matched in send order so two creates with one title never share a row. */
export function createdIds(writes: readonly DoorWrite[], reminders: readonly Reminder[]): Map<string, string> {
  const created = new Map<string, string>()
  const taken = new Set<string>()
  for (const write of writes) {
    const id = createdReminderId(write, reminders, taken)
    if (id === undefined) continue
    created.set(write.requestId, id)
    taken.add(id)
  }
  return created
}

/**
 * The writes still worth laying over the snapshot. An answered write goes: the socket
 * layer renders its answer together with the snapshot the server settled it in. A
 * create goes as soon as the snapshot shows its row, even unanswered, so it never
 * shows twice, and that row stays in the known ids of every write still waiting, so a
 * twin create cannot take it once the first has gone.
 */
export function liveWrites(writes: readonly DoorWrite[], snapshot: Pick<RemindersSnapshot, 'reminders'>): DoorWrite[] {
  const created = createdIds(writes, snapshot.reminders)
  const taken = [...created.values()]
  return writes.flatMap((write) => {
    if (write.answered === true || created.has(write.requestId)) return []
    return taken.length === 0 || write.knownIds === undefined ? [write] : [{ ...write, knownIds: new Set([...write.knownIds, ...taken]) }]
  })
}

/** The id a pending create shows under, or the real one once the snapshot has it. */
export function resolveSelection(selectedId: string, writes: readonly DoorWrite[], reminders: readonly Reminder[]): string {
  const write = writes.find((candidate) => pendingReminderId(candidate.requestId) === selectedId)
  return write === undefined ? selectedId : (createdIds(writes, reminders).get(write.requestId) ?? selectedId)
}

export const isPendingId = (id: string): boolean => id.startsWith('pending:')

/** The date shortcuts in the details panel, from Amsterdam's today. */
export function dateShortcuts(today: string): { label: string; day: string }[] {
  const weekday = (dateOf(today).getUTCDay() + 6) % 7
  return [
    { label: 'Today', day: today },
    { label: 'Tomorrow', day: addDays(today, 1) },
    // Next Monday, as Reminders.app means it; on a Monday that is a week out.
    { label: 'Next week', day: addDays(today, 7 - weekday) },
  ]
}
