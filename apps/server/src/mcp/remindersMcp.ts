import type { Reminder, ReminderList, ReminderPerson } from '@manor/contracts'
import { serveMcp, type JsonRecord } from './stdio.js'
import { clock, dateKey, wallTime } from './calendarCreate.js'
import { RemindersSource, type RemindersState } from '../reminders.js'
import {
  REMINDER_COMPLETE_TOOL,
  REMINDER_CREATE_TOOL,
  REMINDER_DELETE_TOOL,
  dueLabel,
  parseReminderCreate,
  parseReminderTarget,
  wallDue,
  type ReminderTarget,
} from './remindersWrite.js'

/**
 * Manor's Apple Reminders connector, spoken over stdio MCP. It reads and writes
 * through `../reminders.ts`, the same module behind the Reminders door: RemCTL on
 * this Mac, or plain EventKit through `remindctl` when RemCTL cannot read. Tools:
 * list the lists, read reminders, and create, complete or delete one. No editing,
 * deliberately.
 *
 * Complete and delete are gated outside this process. The effect broker always asks
 * the user and renders the card from the same arguments with the same parser
 * (`remindersWrite.ts`), so what they approve is what happens. Create runs without a
 * card, the user's call, and the agent names what it added in its reply.
 */

const LIST_MAX = 300
const NOTES_SHOWN_MAX = 1_000

function tools(): JsonRecord[] {
  return [
    {
      name: 'list_reminder_lists',
      description:
        'List the user’s Apple Reminders lists with their open and overdue counts, their section headings, and the ' +
        'people a shared list can be assigned to. List names are case-sensitive; use them exactly in the other tools.',
      annotations: { readOnlyHint: true },
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'list_reminders',
      description:
        'Reminders from the user’s Apple Reminders. status open (default) sorts by due date with undated ones last; ' +
        'completed sorts most recently completed first. Due dates are Europe/Amsterdam: YYYY-MM-DD for a day, ' +
        'YYYY-MM-DDTHH:MM for a time. overdue:true marks an open reminder past its due date. ' +
        'id, title and list are what complete_reminder and delete_reminder take. assignee is the person a reminder ' +
        'on a shared list is assigned to, section the heading it sits under inside its list, parent the reminder a ' +
        'subtask belongs to. When Manor cannot read those, metadataUnavailable says why.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['open', 'completed', 'all'], description: 'Default open.' },
          list: { type: 'string', description: 'Only this list, by name from list_reminder_lists. Default: all lists.' },
          limit: { type: 'number', description: `At most this many, default 100, max ${LIST_MAX}.` },
          assignee: { type: 'string', description: 'Only reminders assigned to this person, by first name, e.g. Sam.' },
          section: { type: 'string', description: 'Only reminders under this section heading, e.g. Prioriteit deze week.' },
        },
        additionalProperties: false,
      },
    },
    {
      name: REMINDER_CREATE_TOOL,
      description:
        'Create one reminder in one of the user’s Apple Reminders lists. It runs straight away, without an approval card. ' +
        'Create only what the conversation or your task asks for, and in your reply name what you created: title, list, ' +
        'and any section, assignee or due date. due is Europe/Amsterdam ' +
        'wall-clock time without an offset: YYYY-MM-DDTHH:MM notifies at that time, YYYY-MM-DD is a day without a ' +
        'time. Omit due for no date. section and assignee must come from list_reminder_lists for that list.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          list: { type: 'string', description: 'Exact list name from list_reminder_lists.' },
          section: { type: 'string', description: 'A section heading of that list. Omit for no section.' },
          assignee: { type: 'string', description: 'A person that list is shared with, by first name, or "me". Omit for nobody.' },
          due: { type: 'string', description: 'YYYY-MM-DDTHH:MM, or YYYY-MM-DD for a day without a time.' },
          notes: { type: 'string' },
        },
        required: ['title', 'list'],
        additionalProperties: false,
      },
    },
    {
      name: REMINDER_COMPLETE_TOOL,
      description:
        'Mark one open reminder as done. Only after the user explicitly said yes to ticking off this reminder. Pass id, ' +
        'title and list from a fresh list_reminders; Manor shows them an approval card, and refuses when the id no ' +
        'longer carries that title and list. A denial means do not retry.',
      annotations: { readOnlyHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The full id from list_reminders.' },
          title: { type: 'string', description: 'The title exactly as list_reminders returned it.' },
          list: { type: 'string', description: 'The list exactly as list_reminders returned it.' },
        },
        required: ['id', 'title', 'list'],
        additionalProperties: false,
      },
    },
    {
      name: REMINDER_DELETE_TOOL,
      description:
        'Delete one reminder, open or completed, from a list that is not shared. Only after the user explicitly said yes to ' +
        'deleting this reminder. Shared lists are refused: offer to complete it instead, or leave ' +
        'the delete to the user. Pass id, title and list from a fresh list_reminders; Manor shows them an approval card, and ' +
        'refuses when the id no longer carries that title and list. A denial means do not retry.',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The full id from list_reminders.' },
          title: { type: 'string', description: 'The title exactly as list_reminders returned it.' },
          list: { type: 'string', description: 'The list exactly as list_reminders returned it.' },
        },
        required: ['id', 'title', 'list'],
        additionalProperties: false,
      },
    },
  ]
}

/** Exact name first; a case-insensitive match only when it is unambiguous. */
export function resolveList(lists: readonly ReminderList[], name: string): ReminderList {
  const exact = lists.filter((list) => list.title === name)
  if (exact.length === 1) return exact[0]!
  const loose = lists.filter((list) => list.title.toLowerCase() === name.trim().toLowerCase())
  if (exact.length === 0 && loose.length === 1) return loose[0]!
  const known = lists.map((list) => `"${list.title}"`).join(', ')
  if (exact.length > 1) throw new Error(`Several Reminders lists are called "${name}". Nothing was done; ask the user to rename one.`)
  throw new Error(loose.length > 1
    ? `"${name}" matches several lists that differ only in case; use the exact name. Lists: ${known}.`
    : `No Reminders list is called "${name}". Lists: ${known}.`)
}

/** A section of one list by heading, exact first, then an unambiguous case-insensitive match. */
export function resolveSection(list: ReminderList, heading: string): { id: string; title: string } {
  const exact = list.sections.filter((section) => section.title === heading)
  const loose = list.sections.filter((section) => section.title.toLowerCase() === heading.trim().toLowerCase())
  const found = exact.length === 1 ? exact[0] : exact.length === 0 && loose.length === 1 ? loose[0] : undefined
  if (found !== undefined) return found
  const known = list.sections.map((section) => `"${section.title}"`).join(', ') || 'none'
  throw new Error(`"${list.title}" has no single section called "${heading}". Nothing was done. Sections: ${known}.`)
}

const firstName = (person: ReminderPerson) => person.name.split(/\s+/)[0] ?? person.name

/** Someone the list is shared with, by `me`, first name or full name. */
export function resolveAssignee(list: ReminderList, name: string): ReminderPerson {
  const wanted = name.trim().toLowerCase()
  const matches = list.sharees.filter((person) =>
    (wanted === 'me' && person.me) || person.name.toLowerCase() === wanted || firstName(person).toLowerCase() === wanted)
  if (matches.length === 1) return matches[0]!
  const known = list.sharees.map((person) => firstName(person)).join(', ')
  throw new Error(list.sharees.length === 0
    ? `"${list.title}" is not shared with anyone, so nobody can be assigned. Nothing was done.`
    : `Nobody unique called "${name}" shares "${list.title}". Nothing was done. People: ${known}.`)
}

function dueText(reminder: Reminder): string | undefined {
  const { due } = reminder
  return due === undefined ? undefined : due.time === undefined ? due.day : `${due.day}T${due.time}`
}

/** Open reminders by due date, undated last, then oldest first. */
export function sortOpen(reminders: readonly Reminder[]): Reminder[] {
  const key = (reminder: Reminder) => dueText(reminder) ?? '~'
  return [...reminders].sort((a, b) => key(a).localeCompare(key(b)) || (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))
}

/** Overdue: past the due time, or before today for a day. */
export function isOverdue(reminder: Reminder, now: number): boolean {
  const { due } = reminder
  if (reminder.completed || due === undefined) return false
  const today = dateKey(wallTime(now))
  return due.day < today || (due.day === today && due.time !== undefined && due.time < clock(now))
}

export function reminderLine(reminder: Reminder, state: Pick<RemindersState, 'lists'>, now: number, titles: ReadonlyMap<string, string>): JsonRecord {
  const list = state.lists.find((candidate) => candidate.id === reminder.listId)
  const section = list?.sections.find((candidate) => candidate.id === reminder.sectionId)?.title
  const due = dueText(reminder)
  const notes = reminder.notes
  const parent = reminder.parentId === undefined ? undefined : titles.get(reminder.parentId)
  return {
    id: reminder.id,
    title: reminder.title,
    list: list?.title ?? '',
    ...(due === undefined ? {} : { due }),
    completed: reminder.completed,
    ...(reminder.completedAt === undefined ? {} : { completedAt: reminder.completedAt }),
    ...(isOverdue(reminder, now) ? { overdue: true } : {}),
    ...(section === undefined ? {} : { section }),
    ...(reminder.assignee === undefined ? {} : { assignee: firstName(reminder.assignee) }),
    ...(parent === undefined ? {} : { parent }),
    ...(reminder.flagged ? { flagged: true } : {}),
    ...(reminder.priority === 'none' ? {} : { priority: reminder.priority }),
    ...(reminder.tags.length === 0 ? {} : { tags: reminder.tags }),
    ...(reminder.url === undefined ? {} : { url: reminder.url }),
    ...(notes === undefined ? {} : { notes: notes.length > NOTES_SHOWN_MAX ? `${notes.slice(0, NOTES_SHOWN_MAX)}…` : notes }),
  }
}

/**
 * The reminder the approval card named, or a refusal. The card shows title and list,
 * so the id must still carry both; otherwise the agent re-reads and asks again.
 */
export function approvedReminder(found: Reminder | undefined, lists: readonly ReminderList[], target: ReminderTarget): Reminder {
  if (found === undefined) throw new Error('No reminder has that id any more. Nothing was changed; read list_reminders again.')
  const list = lists.find((candidate) => candidate.id === found.listId)?.title ?? ''
  if (found.title !== target.title || list !== target.list) {
    throw new Error(
      `That id is now “${found.title}” in “${list}”, not what was approved. Nothing was changed; ` +
        'read list_reminders again and ask the user about the right one.',
    )
  }
  return found
}

/**
 * Lists the user says are shared, by title, from `MANOR_REMINDERS_SHARED_LISTS` (comma
 * separated). Reminders flags a shared list itself, but a failed `list-info` or the
 * EventKit fallback reads every list as unshared, and then only a name can say so.
 */
const sharedLists = (env: NodeJS.ProcessEnv = process.env): string[] =>
  (env['MANOR_REMINDERS_SHARED_LISTS'] ?? '').split(',').map((title) => title.trim().toLowerCase()).filter((title) => title !== '')

/**
 * Agents never delete from a shared list, approved or not: the reminder would vanish
 * for the other person too. The user deletes those themselves, in Reminders or the Manor door.
 */
export function refuseSharedDelete(list: ReminderList | undefined): void {
  if (list === undefined) throw new Error('That reminder’s list is unknown. Nothing was deleted; read list_reminders again.')
  if (list.shared || sharedLists().includes(list.title.trim().toLowerCase())) {
    throw new Error(`“${list.title}” is shared, and agents do not delete from shared lists. Nothing was deleted; the user can delete it themselves.`)
  }
}

function ready(state: RemindersState): RemindersState {
  if (state.status !== 'ready') throw new Error(`Apple Reminders cannot be read: ${state.notice ?? 'no reason given'}`)
  return state
}

/** Every completed reminder, newest first. The source caches them until the store changes. */
async function completed(source: RemindersSource): Promise<Reminder[]> {
  const reminders: Reminder[] = []
  let offset: number | null = 0
  while (offset !== null) {
    const page = await source.completedPage(offset)
    reminders.push(...page.reminders)
    offset = page.nextOffset
  }
  return reminders
}

export async function callReminders(source: RemindersSource, name: unknown, arguments_: JsonRecord): Promise<unknown> {
  if (name === 'list_reminder_lists') {
    const state = ready(await source.load())
    const now = Date.now()
    return {
      ...(state.notice === undefined ? {} : { metadataUnavailable: state.notice }),
      lists: state.lists.map((list) => ({
        name: list.title,
        open: list.open,
        overdue: state.reminders.filter((reminder) => reminder.listId === list.id && isOverdue(reminder, now)).length,
        ...(list.shared ? { shared: true } : {}),
        ...(list.sections.length === 0 ? {} : { sections: list.sections.map((section) => section.title) }),
        ...(list.sharees.length === 0 ? {} : { people: list.sharees.map(firstName) }),
      })),
    }
  }
  if (name === 'list_reminders') {
    const status = arguments_.status ?? 'open'
    if (status !== 'open' && status !== 'completed' && status !== 'all') throw new Error('status must be open, completed or all.')
    const limit = arguments_.limit ?? 100
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > LIST_MAX) {
      throw new Error(`limit must be a whole number from 1 to ${LIST_MAX}.`)
    }
    const person = arguments_.assignee
    if (person !== undefined && (typeof person !== 'string' || person.trim() === '')) throw new Error('assignee must be a first name.')
    const heading = arguments_.section
    if (heading !== undefined && (typeof heading !== 'string' || heading.trim() === '')) throw new Error('section must be a section heading.')
    if (arguments_.list !== undefined && typeof arguments_.list !== 'string') throw new Error('list must be a list name.')
    const state = ready(await source.load())
    if ((person !== undefined || heading !== undefined) && state.source !== 'remctl') {
      throw new Error(`Assignees and sections cannot be read right now: ${state.notice ?? 'RemCTL is unavailable'}`)
    }
    const listId = arguments_.list === undefined ? undefined : resolveList(state.lists, arguments_.list).id
    const done = status === 'open' ? [] : await completed(source)
    const pool = [...(status === 'completed' ? [] : sortOpen(state.reminders)), ...done]
    const titles = new Map(pool.map((reminder) => [reminder.id, reminder.title]))
    const sectionTitle = (reminder: Reminder) =>
      state.lists.find((list) => list.id === reminder.listId)?.sections.find((section) => section.id === reminder.sectionId)?.title
    const chosen = pool.filter((reminder) =>
      (listId === undefined || reminder.listId === listId) &&
      (person === undefined || (reminder.assignee !== undefined &&
        [firstName(reminder.assignee), reminder.assignee.name].some((known) => known.toLowerCase() === person.trim().toLowerCase()))) &&
      (heading === undefined || sectionTitle(reminder)?.toLowerCase() === heading.trim().toLowerCase()))
    const now = Date.now()
    return {
      timeZone: 'Europe/Amsterdam',
      today: state.today,
      count: chosen.length,
      ...(chosen.length > limit ? { truncated: `first ${limit} shown` } : {}),
      ...(state.notice === undefined ? {} : { metadataUnavailable: state.notice }),
      reminders: chosen.slice(0, limit).map((reminder) => reminderLine(reminder, state, now, titles)),
    }
  }
  if (name === REMINDER_CREATE_TOOL) {
    const reminder = parseReminderCreate(arguments_)
    const state = ready(await source.load())
    const list = resolveList(state.lists, reminder.list)
    const section = reminder.section === undefined ? undefined : resolveSection(list, reminder.section)
    const assignee = reminder.assignee === undefined ? undefined : resolveAssignee(list, reminder.assignee)
    await source.write({
      kind: 'create',
      listId: list.id,
      title: reminder.title,
      changes: {
        ...(reminder.notes === undefined ? {} : { notes: reminder.notes }),
        ...(reminder.due === undefined ? {} : { due: wallDue(reminder.due) }),
        ...(section === undefined ? {} : { sectionId: section.id }),
        ...(assignee === undefined ? {} : { assigneeId: assignee.id }),
      },
    })
    return {
      created: true,
      title: reminder.title,
      list: list.title,
      ...(section === undefined ? {} : { section: section.title }),
      ...(assignee === undefined ? {} : { assignee: firstName(assignee) }),
      ...(reminder.due === undefined ? {} : { due: dueLabel(reminder.due) }),
    }
  }
  if (name === REMINDER_COMPLETE_TOOL || name === REMINDER_DELETE_TOOL) {
    const target = parseReminderTarget(arguments_, name)
    const found = await source.find(target.id)
    const state = ready(await source.load())
    const reminder = approvedReminder(found, state.lists, target)
    if (name === REMINDER_COMPLETE_TOOL) {
      if (reminder.completed) return { completed: true, alreadyDone: true, title: reminder.title, list: target.list }
      await source.write({ kind: 'complete', id: reminder.id })
      return { completed: true, title: reminder.title, list: target.list }
    }
    refuseSharedDelete(state.lists.find((list) => list.id === reminder.listId))
    await source.write({ kind: 'delete', id: reminder.id })
    return { deleted: true, title: reminder.title, list: target.list }
  }
  throw new Error(`Unknown reminders tool ${String(name)}.`)
}

// Importable for tests without starting a server on their stdin.
if (process.argv[1] !== undefined && /remindersMcp\.(?:ts|mjs)$/.test(process.argv[1])) {
  const source = new RemindersSource({ log: (line) => process.stderr.write(`[manor-reminders] ${line}\n`) })
  void serveMcp({
    name: 'manor-apple-reminders',
    tools: tools(),
    failureMessage: 'The reminders action failed.',
    callTool: async (name, arguments_) => [{ type: 'text', text: JSON.stringify(await callReminders(source, name, arguments_)) }],
  }, '').catch((error: unknown) => {
    process.stderr.write(`[manor-reminders] ${error instanceof Error ? error.message : 'startup failed'}\n`)
    process.exitCode = 1
  })
}
