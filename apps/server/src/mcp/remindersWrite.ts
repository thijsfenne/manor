import { clock, dateKey, dayLabel, exactInstant, parseDate, parseDateTime, wallTime } from './calendarCreate.js'

/**
 * The write half of the Apple Reminders connector, free of any CLI because two
 * processes need the same answer from it: the connector acts on these arguments,
 * and for complete and delete the effect broker renders the approval card from the
 * very same arguments first. Due times are Europe/Amsterdam wall-clock time, like the calendar, so DST
 * stays Manor's problem.
 */

export const APPLE_REMINDERS_MCP_NAME = 'apple-reminders'
export const REMINDER_CREATE_TOOL = 'create_reminder'
export const REMINDER_COMPLETE_TOOL = 'complete_reminder'
export const REMINDER_DELETE_TOOL = 'delete_reminder'

const TITLE_MAX = 500
const NOTES_MAX = 2_000

export type ReminderDue = { allDay: true; day: string } | { allDay: false; at: number }

export interface ReminderCreate {
  title: string
  list: string
  /** A section heading inside that list, by name. */
  section?: string
  /** Someone the list is shared with, by first name, full name, or `me`. */
  assignee?: string
  due?: ReminderDue
  notes?: string
}

/** Throws a message the model can act on. */
export function parseReminderCreate(arguments_: unknown): ReminderCreate {
  if (typeof arguments_ !== 'object' || arguments_ === null || Array.isArray(arguments_)) {
    throw new Error('create_reminder needs an arguments object.')
  }
  const input = arguments_ as Record<string, unknown>
  const title = text(input.title, 'title', TITLE_MAX)
  const list = text(input.list, 'list', TITLE_MAX)
  if (title === undefined) throw new Error('create_reminder needs title.')
  if (list === undefined) throw new Error('create_reminder needs list, an exact name from list_reminder_lists.')
  const notes = text(input.notes, 'notes', NOTES_MAX)
  const section = text(input.section, 'section', TITLE_MAX)
  const assignee = text(input.assignee, 'assignee', TITLE_MAX)
  return {
    title,
    list,
    ...(section === undefined ? {} : { section }),
    ...(assignee === undefined ? {} : { assignee }),
    ...(input.due === undefined ? {} : { due: parseDue(input.due) }),
    ...(notes === undefined ? {} : { notes }),
  }
}

function parseDue(value: unknown): ReminderDue {
  if (typeof value === 'string') {
    if (parseDate(value) !== undefined) return { allDay: true, day: value }
    const time = parseDateTime(value)
    if (time !== undefined) return { allDay: false, at: exactInstant(time, value) }
  }
  throw new Error('due must be Amsterdam wall-clock time as YYYY-MM-DDTHH:MM, or YYYY-MM-DD for a day without a time. No offsets.')
}

function text(value: unknown, name: string, max: number): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`${name} must be text.`)
  const trimmed = value.trim()
  if (trimmed.length > max) throw new Error(`${name} may be at most ${max} characters.`)
  return trimmed === '' ? undefined : trimmed
}

/** `Fri 3 Oct 2026` or `Fri 3 Oct 2026, 14:00`. */
export function dueLabel(due: ReminderDue): string {
  return due.allDay ? dayLabel(due.day) : `${dayLabel(dateKey(wallTime(due.at)))}, ${clock(due.at)}`
}

/** The same moment as Amsterdam wall time, the shape Manor's Reminders module writes. */
export function wallDue(due: ReminderDue): { day: string; time?: string } {
  if (due.allDay) return { day: due.day }
  return { day: dateKey(wallTime(due.at)), time: clock(due.at) }
}

/**
 * Completing and deleting name the reminder by id plus the title and list the agent
 * read. The card shows the title and list; the connector refuses unless the id still
 * carries exactly that title and list, so the user never approves one reminder and loses
 * another.
 */
export interface ReminderTarget { id: string; title: string; list: string }

export function parseReminderTarget(arguments_: unknown, tool: string): ReminderTarget {
  if (typeof arguments_ !== 'object' || arguments_ === null || Array.isArray(arguments_)) {
    throw new Error(`${tool} needs an arguments object.`)
  }
  const input = arguments_ as Record<string, unknown>
  const id = text(input.id, 'id', 100)
  const title = text(input.title, 'title', TITLE_MAX)
  const list = text(input.list, 'list', TITLE_MAX)
  if (id === undefined || title === undefined || list === undefined) {
    throw new Error(`${tool} needs id, title and list exactly as list_reminders returned them.`)
  }
  // The CLIs also take list indexes, prefixes or store numbers; only a full id names one reminder.
  if (!/^[0-9A-Fa-f]{8}-[0-9A-Fa-f-]{27}$/.test(id)) throw new Error('id must be the full id from list_reminders.')
  return { id, title, list }
}

export function reminderCompleteQuestion(target: ReminderTarget): string {
  return `Mark the reminder “${target.title}” in the Reminders list “${target.list}” as done?`
}

export function reminderDeleteQuestion(target: ReminderTarget): string {
  return `Delete the reminder “${target.title}” from the Reminders list “${target.list}”? This cannot be undone.`
}
