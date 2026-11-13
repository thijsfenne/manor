import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  Reminder,
  ReminderChanges,
  ReminderDue,
  ReminderList,
  ReminderPerson,
  ReminderRepeat,
  ReminderWrite,
  ServerMessage,
} from '@manor/contracts'
import { clock, dateKey, wallTime } from './mcp/calendarCreate.js'

/**
 * Apple Reminders on this Mac, for the Reminders door and Nova's connector alike.
 *
 * The full source is RemCTL (github.com/viticci/remctl). Every call goes through its
 * signed Capability Host, which holds Full Disk Access, Reminders and Automation, so
 * Node itself never needs a grant. Reads are `remctl workspace`, the bounded snapshot
 * RemCTL's own UI reads; section, assignee, flag, tag, link and subtask writes use its
 * `--private` ReminderKit path. When RemCTL is missing or cannot read Apple's store
 * (a macOS update can change it), the plain source takes over through `remindctl`
 * on public EventKit: no sections, assignees, flags, tags, links, repeats or subtasks,
 * but title, notes, list, date and priority stay readable and writable.
 *
 * Ids are Apple's CloudKit identifiers, which both CLIs share. RemCTL's commands take
 * its numeric store ids, so every snapshot refreshes the id map a write resolves by.
 */

export type RemindersState = Extract<ServerMessage, { type: 'reminders_state' }>
export type CompletedPage = Extract<ServerMessage, { type: 'reminders_completed' }>

/** Runs one CLI and resolves its stdout. Injected so tests never touch the real store. */
export type RunCli = (binary: string, args: readonly string[]) => Promise<string>

const TIMEOUT_MS = 30_000
const WORKSPACE_PAGE = 500
const MAX_PAGES = 40
export const COMPLETED_PAGE_SIZE = 100
const LIST_INFO_TTL_MS = 5 * 60_000

const PLAIN_LIMIT = 'Sections, assignees, flags, tags, links, repeats and subtasks are unavailable.'

export interface RemindersBinaries { remctl?: string; remindctl?: string }

/**
 * `homeOnly` is for mock runs: their HOME is a fixture folder, so only `$HOME/bin/remctl`
 * counts and the system-wide CLIs, which read the user's real Reminders, are never found.
 */
export function remindersBinaries(
  home = homedir(),
  exists: (path: string) => boolean = existsSync,
  homeOnly = false,
): RemindersBinaries {
  const system = homeOnly ? [] : ['/opt/homebrew/bin', '/usr/local/bin']
  const remctl = [join(home, 'bin', 'remctl'), ...system.map((dir) => `${dir}/remctl`)].find(exists)
  const remindctl = system.map((dir) => `${dir}/remindctl`).find(exists)
  return { ...(remctl === undefined ? {} : { remctl }), ...(remindctl === undefined ? {} : { remindctl }) }
}

/** The first line a CLI printed about its failure, without its `Error:` prefix. */
export function cliFailure(stdout: string, stderr: string, code: unknown): string {
  const line = [stderr, stdout]
    .flatMap((text) => text.split('\n'))
    .map((text) => text.trim())
    .find((text) => text !== '')
  return (line ?? `exit ${String(code)}`).replace(/^Error:\s*/, '').slice(0, 300)
}

export const runCli: RunCli = (binary, args) =>
  new Promise((resolve, reject) => {
    execFile(binary, [...args], {
      timeout: TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      // TZ pins how remindctl reads and prints wall-clock dates. RemCTL's host runs in
      // the Mac's own zone, which is Amsterdam.
      env: { HOME: process.env.HOME ?? homedir(), PATH: '/usr/bin:/bin', TZ: 'Europe/Amsterdam' },
    }, (error, stdout, stderr) => {
      if (error === null) {
        resolve(String(stdout))
        return
      }
      reject(new Error(error.killed
        ? `no answer within ${TIMEOUT_MS / 1000} seconds`
        : cliFailure(String(stdout), String(stderr), error.code)))
    })
  })

type Json = Record<string, unknown>

const record = (value: unknown): Json | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Json : undefined
const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)
const idText = (value: unknown): string | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? String(value) : text(value)

function parseJson(raw: string, what: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error(`${what} returned no JSON`)
  }
}

/** Today in Europe/Amsterdam. */
export function amsterdamToday(now: number): string {
  return dateKey(wallTime(now))
}

/** RemCTL prints naive local times (`2026-10-01T09:00:00`), already Amsterdam wall time. */
function naiveDue(value: unknown, allDay: boolean): ReminderDue | undefined {
  const raw = text(value)
  const match = raw === undefined ? null : /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/.exec(raw)
  if (match === null) return undefined
  return allDay || match[2] === undefined ? { day: match[1]! } : { day: match[1]!, time: match[2]! }
}

const naiveStamp = (value: unknown): string | undefined => text(value)?.slice(0, 16)

/** remindctl prints instants; an all-day due is that day's Amsterdam midnight. */
function instantDue(value: unknown, allDay: boolean): ReminderDue | undefined {
  const at = typeof value === 'string' ? Date.parse(value) : NaN
  if (Number.isNaN(at)) return undefined
  const day = dateKey(wallTime(at))
  return allDay ? { day } : { day, time: clock(at) }
}

function instantStamp(value: unknown): string | undefined {
  const at = typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isNaN(at) ? undefined : `${dateKey(wallTime(at))}T${clock(at)}`
}

const PRIORITIES = new Set(['none', 'low', 'medium', 'high'])
const priorityOf = (value: unknown): Reminder['priority'] =>
  typeof value === 'string' && PRIORITIES.has(value) ? value as Reminder['priority'] : 'none'

const FREQUENCIES = new Set(['daily', 'weekly', 'monthly', 'yearly'])
const RULE_KEYS = ['daysOfWeek', 'daysOfMonth', 'monthsOfYear', 'daysOfYear', 'weeksOfYear', 'setPositions', 'count', 'endDate']

/** A simple repeat round-trips; anything with days, positions or an end is `custom`. */
export function repeatOf(value: unknown): ReminderRepeat | undefined {
  const rule = record(value)
  const frequency = rule?.frequency
  if (rule === undefined || typeof frequency !== 'string' || !FREQUENCIES.has(frequency)) return undefined
  const interval = typeof rule.interval === 'number' && rule.interval >= 1 ? Math.min(999, Math.floor(rule.interval)) : 1
  const base = { frequency: frequency as ReminderRepeat['frequency'], interval }
  const extra = RULE_KEYS.filter((key) => rule[key] !== undefined && rule[key] !== null)
  if (extra.length === 0) return base
  const every = interval === 1 ? frequency : `every ${interval} ${({ daily: 'days', weekly: 'weeks', monthly: 'months', yearly: 'years' } as const)[base.frequency]}`
  return { ...base, custom: `${every}, custom` }
}

/** RemCTL's `--recurrence` text for a repeat the details panel set. */
export function remctlRepeat(repeat: Pick<ReminderRepeat, 'frequency' | 'interval'>): string {
  return repeat.interval > 1 ? `${repeat.frequency} x${repeat.interval}` : repeat.frequency
}

function dueArgument(due: ReminderDue): string {
  return due.time === undefined ? due.day : `${due.day} ${due.time}`
}

/** What a write needs to know about a reminder that the client-facing shape leaves out. */
export interface RemctlRef {
  pk: string
  listPk: string
  hasAlarms: boolean
  hasRepeat: boolean
  hasUrl: boolean
}

export interface RemctlLists {
  lists: ReminderList[]
  groups: RemindersState['groups']
  /** CloudKit list id to RemCTL's numeric list id. */
  pkByList: Map<string, string>
  /** RemCTL's numeric list id to CloudKit list id. */
  listByPk: Map<string, string>
}

/**
 * Lists and groups from one workspace page plus each list's `list-info` (sections
 * and sharees). A list whose `list-info` failed still shows, unshared.
 */
export function remctlLists(workspace: Json, infos: ReadonlyMap<string, Json | undefined>): RemctlLists {
  const rawLists = Array.isArray(workspace.lists) ? workspace.lists.map(record).filter((item) => item !== undefined) : []
  const rawSections = Array.isArray(workspace.sections) ? workspace.sections.map(record).filter((item) => item !== undefined) : []
  const pkByList = new Map<string, string>()
  const listByPk = new Map<string, string>()
  for (const list of rawLists) {
    const pk = idText(list.id)
    const uuid = text(list.objectUUID)
    if (pk === undefined || uuid === undefined) continue
    pkByList.set(uuid, pk)
    listByPk.set(pk, uuid)
  }
  const groups: RemindersState['groups'] = []
  const lists: ReminderList[] = []
  for (const list of rawLists) {
    const pk = idText(list.id)
    const id = text(list.objectUUID)
    const title = text(list.title)
    if (pk === undefined || id === undefined || title === undefined) continue
    if (list.isGroup === true) {
      groups.push({ id, title })
      continue
    }
    const info = infos.get(pk)
    const color = text(record(list.color)?.hex)
    const groupId = listByPk.get(idText(list.parentListId) ?? '')
    const sharees = Array.isArray(info?.sharees) ? info.sharees.map(record).flatMap((sharee): ReminderPerson[] => {
      const shareeId = idText(sharee?.id)
      const name = text(sharee?.name) ?? text(sharee?.address)?.replace(/^mailto:/, '')
      return shareeId === undefined || name === undefined ? [] : [{ id: shareeId, name, me: sharee?.currentUser === true }]
    }) : []
    lists.push({
      id,
      title,
      ...(color === undefined || !/^#[0-9a-fA-F]{6}$/.test(color) ? {} : { color: color.toUpperCase() }),
      ...(groupId === undefined ? {} : { groupId }),
      shared: info?.shared === true,
      open: typeof list.count === 'number' ? list.count : 0,
      sections: rawSections.flatMap((section) =>
        idText(section.listId) === pk && text(section.objectUUID) !== undefined && text(section.title) !== undefined
          ? [{ id: text(section.objectUUID)!, title: text(section.title)! }]
          : []),
      sharees,
    })
  }
  return { lists, groups, pkByList, listByPk }
}

/**
 * One RemCTL workspace item in Manor's shape, plus the facts a later write needs.
 * `uuidByPk` names a subtask's parent, which RemCTL gives by numeric id.
 */
export function remctlReminder(
  item: Json,
  lists: RemctlLists,
  uuidByPk: ReadonlyMap<string, string>,
): { reminder: Reminder; ref: RemctlRef } | undefined {
  const id = text(item.objectUUID)
  const pk = idText(item.id)
  const listPk = idText(item.listId)
  const listId = text(item.listUUID) ?? (listPk === undefined ? undefined : lists.listByPk.get(listPk))
  if (id === undefined || pk === undefined || listPk === undefined || listId === undefined) return undefined
  const list = lists.lists.find((candidate) => candidate.id === listId)
  const sectionTitle = text(item.section)
  const sectionId = sectionTitle === undefined ? undefined : list?.sections.find((section) => section.title === sectionTitle)?.id
  const assigned = record(record(item.assignment)?.assignee)
  const assigneeId = idText(assigned?.id)
  const assigneeName = text(assigned?.name) ?? text(assigned?.address)?.replace(/^mailto:/, '')
  const due = naiveDue(item.dueDate, item.allDay === true)
  const completedAt = naiveStamp(item.completionDate)
  const createdAt = naiveStamp(item.createdDate)
  const parentId = uuidByPk.get(idText(item.parentID) ?? '')
  const notes = text(item.notes)?.trim()
  const url = text(item.url)
  const repeat = repeatOf(item.recurrence)
  const tags = Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === 'string' && tag !== '') : []
  const reminder: Reminder = {
    id,
    title: text(item.title)?.trim() || '(no title)',
    listId,
    ...(notes === undefined || notes === '' ? {} : { notes }),
    completed: item.completed === true,
    ...(completedAt === undefined ? {} : { completedAt }),
    ...(due === undefined ? {} : { due }),
    flagged: item.flagged === true,
    priority: priorityOf(item.priority),
    ...(url === undefined ? {} : { url }),
    tags,
    ...(repeat === undefined ? {} : { repeat }),
    ...(sectionId === undefined ? {} : { sectionId }),
    ...(assigneeId === undefined || assigneeName === undefined
      ? {}
      : { assignee: { id: assigneeId, name: assigneeName, me: list?.sharees.find((sharee) => sharee.id === assigneeId)?.me === true } }),
    ...(parentId === undefined ? {} : { parentId }),
    ...(createdAt === undefined ? {} : { createdAt }),
  }
  return {
    reminder,
    ref: {
      pk,
      listPk,
      hasAlarms: Array.isArray(item.alarms) && item.alarms.length > 0,
      hasRepeat: repeat !== undefined,
      hasUrl: url !== undefined,
    },
  }
}

/** Reminders from workspace items, parents before subtasks so every parent id resolves. */
export function remctlReminders(items: readonly Json[], lists: RemctlLists): { reminder: Reminder; ref: RemctlRef }[] {
  const uuidByPk = new Map<string, string>()
  for (const item of items) {
    const pk = idText(item.id)
    const uuid = text(item.objectUUID)
    if (pk !== undefined && uuid !== undefined) uuidByPk.set(pk, uuid)
  }
  return items.flatMap((item) => {
    const read = remctlReminder(item, lists, uuidByPk)
    return read === undefined ? [] : [read]
  })
}

/** The plain source's lists: no sections, sharees or groups. */
export function plainLists(raw: unknown): ReminderList[] {
  if (!Array.isArray(raw)) throw new Error('remindctl returned no list of lists')
  return raw.map(record).flatMap((list): ReminderList[] => {
    const id = text(list?.id)
    const title = text(list?.title)
    if (id === undefined || title === undefined) return []
    return [{ id, title, shared: false, open: typeof list?.reminderCount === 'number' ? list.reminderCount : 0, sections: [], sharees: [] }]
  })
}

export function plainReminders(raw: unknown): Reminder[] {
  if (!Array.isArray(raw)) throw new Error('remindctl returned no list of reminders')
  return raw.map(record).flatMap((item): Reminder[] => {
    const id = text(item?.id)
    const listId = text(item?.listID)
    if (item === undefined || id === undefined || listId === undefined) return []
    const due = instantDue(item.dueDate, item.dueDateIsAllDay === true)
    const completedAt = instantStamp(item.completionDate)
    const createdAt = instantStamp(item.creationDate)
    const notes = text(item.notes)?.trim()
    return [{
      id,
      title: text(item.title)?.trim() || '(no title)',
      listId,
      ...(notes === undefined || notes === '' ? {} : { notes }),
      completed: item.isCompleted === true,
      ...(completedAt === undefined ? {} : { completedAt }),
      ...(due === undefined ? {} : { due }),
      flagged: false,
      priority: priorityOf(item.priority),
      tags: [],
      ...(createdAt === undefined ? {} : { createdAt }),
    }]
  })
}

const PRIVATE_FIELDS = ['sectionId', 'flagged', 'url', 'tags', 'assigneeId'] as const
const PLAIN_FIELDS = new Set(['title', 'notes', 'listId', 'due', 'priority'])

function wantsPrivate(changes: ReminderChanges | undefined): boolean {
  return changes !== undefined && PRIVATE_FIELDS.some((key) => changes[key] !== undefined)
}

/** Argument lists for one write through RemCTL. Pure: the caller resolves ids first. */
export function remctlWriteArgs(
  action: ReminderWrite,
  resolve: {
    ref: (id: string) => RemctlRef
    listPk: (listId: string) => string
  },
): string[] {
  switch (action.kind) {
    case 'complete':
      return ['done', resolve.ref(action.id).pk, '--json']
    case 'uncomplete':
      return ['undone', resolve.ref(action.id).pk, '--json']
    case 'delete':
      return ['delete', resolve.ref(action.id).pk, '--force', '--json']
    case 'create': {
      if (action.parentId !== undefined) {
        if (action.changes !== undefined && Object.keys(action.changes).length > 0) {
          throw new Error('A subtask starts with only a title; set its other fields after it exists.')
        }
        const parent = resolve.ref(action.parentId)
        return ['edit', parent.pk, '--private', '--subtask', JSON.stringify({ title: action.title }), '--json']
      }
      const changes = action.changes ?? {}
      const args = ['add', '--list-id', resolve.listPk(action.listId)]
      // Free text rides as `--flag=value`, so a note starting with a dash stays a note.
      if (changes.notes != null) args.push(`--notes=${changes.notes}`)
      if (changes.due != null) {
        args.push('--due', dueArgument(changes.due))
        // EventKit only notifies with an alarm; Reminders.app adds one itself.
        if (changes.due.time !== undefined) args.push('--alarm', `${changes.due.day}T${changes.due.time}`)
      }
      if (changes.priority !== undefined && changes.priority !== 'none') args.push('--priority', changes.priority)
      if (changes.repeat != null) args.push('--recurrence', remctlRepeat(changes.repeat))
      if (wantsPrivate(changes)) args.push('--private')
      if (changes.flagged === true) args.push('--flag')
      if (changes.url !== undefined) args.push(`--url=${changes.url}`)
      if (changes.tags !== undefined && changes.tags.length > 0) args.push(`--tags=${changes.tags.join(',')}`)
      if (changes.sectionId !== undefined) args.push('--section-id', changes.sectionId)
      if (changes.assigneeId != null) args.push('--assign', changes.assigneeId)
      // `--` keeps a title that starts with a dash from reading as an option.
      return [...args, '--json', '--', action.title]
    }
    case 'update': {
      const { changes } = action
      const ref = resolve.ref(action.id)
      const keys = Object.keys(changes).filter((key) => changes[key as keyof ReminderChanges] !== undefined)
      if (keys.length === 0) throw new Error('Nothing to change.')
      if (changes.listId !== undefined && keys.length > 1) {
        throw new Error('Moving a reminder to another list is its own change; send the other fields after it.')
      }
      if (changes.url !== undefined && ref.hasUrl) {
        throw new Error('This reminder already has a link. Change or remove it in Reminders.app.')
      }
      if (changes.repeat != null && changes.due === null) throw new Error('A repeat needs a date.')
      const args = ['edit', ref.pk]
      if (changes.title !== undefined) args.push(`--title=${changes.title}`)
      if (changes.notes !== undefined) args.push(`--notes=${changes.notes ?? ''}`)
      if (changes.listId !== undefined) args.push('--list-id', resolve.listPk(changes.listId))
      if (changes.due === null) {
        args.push('--due', 'clear')
        // Reminders refuses a repeat without a date, so clearing one clears both.
        if (ref.hasRepeat && changes.repeat === undefined) args.push('--recurrence', 'clear')
      } else if (changes.due !== undefined) {
        args.push('--due', dueArgument(changes.due))
        // A reminder without alarms gets one at its new time; RemCTL itself carries an
        // existing alarm that sat on the old due time.
        if (changes.due.time !== undefined && !ref.hasAlarms) args.push('--alarm', `${changes.due.day}T${changes.due.time}`)
      }
      if (changes.priority !== undefined) args.push('--priority', changes.priority)
      if (changes.repeat === null) args.push('--recurrence', 'clear')
      else if (changes.repeat !== undefined) args.push('--recurrence', remctlRepeat(changes.repeat))
      if (wantsPrivate(changes)) args.push('--private')
      if (changes.flagged !== undefined) args.push(changes.flagged ? '--flagged' : '--no-flagged')
      if (changes.url !== undefined) args.push(`--url=${changes.url}`)
      if (changes.tags !== undefined) {
        if (changes.tags.length === 0) args.push('--clear-tags')
        else args.push(`--set-tags=${changes.tags.join(',')}`)
      }
      if (changes.sectionId !== undefined) args.push('--section-id', changes.sectionId)
      if (changes.assigneeId === null) args.push('--unassign')
      else if (changes.assigneeId !== undefined) args.push('--assign', changes.assigneeId)
      return [...args, '--json']
    }
  }
}

/** Argument lists for one write through remindctl, refusing what EventKit cannot hold. */
export function plainWriteArgs(action: ReminderWrite): string[] {
  const tail = ['--json', '--no-input', '--no-color']
  switch (action.kind) {
    case 'complete':
      return ['complete', action.id, ...tail]
    case 'uncomplete':
      return ['edit', action.id, '--incomplete', ...tail]
    case 'delete':
      return ['delete', action.id, '--force', ...tail]
    case 'create': {
      const changes = action.changes ?? {}
      refusePlain(action.parentId === undefined ? Object.keys(changes) : ['subtasks'], changes)
      const args = ['add', '--title', action.title, '--list-id', action.listId]
      if (changes.notes != null) args.push('--notes', changes.notes)
      if (changes.due != null) {
        args.push('--due', dueArgument(changes.due))
        if (changes.due.time !== undefined) args.push('--alarm', dueArgument(changes.due))
      }
      if (changes.priority !== undefined) args.push('--priority', changes.priority)
      return [...args, ...tail]
    }
    case 'update': {
      const { changes } = action
      refusePlain(Object.keys(changes), changes)
      const args = ['edit', action.id]
      if (changes.title !== undefined) args.push('--title', changes.title)
      if (changes.notes !== undefined) args.push('--notes', changes.notes ?? '')
      if (changes.listId !== undefined) args.push('--list-id', changes.listId)
      if (changes.due === null) args.push('--clear-due')
      else if (changes.due !== undefined) args.push('--due', dueArgument(changes.due))
      if (changes.priority !== undefined) args.push('--priority', changes.priority)
      return [...args, ...tail]
    }
  }
}

function refusePlain(keys: readonly string[], changes: ReminderChanges): void {
  const refused = keys.filter((key) => !PLAIN_FIELDS.has(key) && (key === 'subtasks' || changes[key as keyof ReminderChanges] !== undefined))
  if (refused.length > 0) throw new Error(`Only RemCTL can write ${refused.join(', ')}. ${PLAIN_LIMIT}`)
}

function shows(reminder: Reminder, changes: ReminderChanges): boolean {
  const { due, repeat } = changes
  return (changes.title === undefined || reminder.title === changes.title.trim()) &&
    (changes.notes === undefined || (reminder.notes ?? '') === (changes.notes ?? '').trim()) &&
    (changes.listId === undefined || reminder.listId === changes.listId) &&
    (changes.sectionId === undefined || reminder.sectionId === changes.sectionId) &&
    (due === undefined || (due === null
      ? reminder.due === undefined
      : reminder.due?.day === due.day && reminder.due.time === due.time)) &&
    (changes.flagged === undefined || reminder.flagged === changes.flagged) &&
    (changes.priority === undefined || reminder.priority === changes.priority) &&
    (changes.url === undefined || reminder.url !== undefined) &&
    (changes.tags === undefined || [...reminder.tags].sort().join('\n') === [...changes.tags].sort().join('\n')) &&
    (repeat === undefined || (repeat === null
      ? reminder.repeat === undefined
      : reminder.repeat?.frequency === repeat.frequency && reminder.repeat.interval === repeat.interval)) &&
    (changes.assigneeId === undefined || (reminder.assignee?.id ?? null) === changes.assigneeId)
}

/**
 * Whether a snapshot already shows a write. RemCTL's private metadata lands in
 * Apple's store a second or two after the command returns, so the first read after a
 * write can still hold the old tags or section.
 */
export function reflects(reminders: readonly Reminder[], action: ReminderWrite, createdId?: string): boolean {
  const find = (id: string) => reminders.find((reminder) => reminder.id === id)
  switch (action.kind) {
    case 'complete':
    case 'delete':
      return find(action.id) === undefined
    case 'uncomplete':
      return find(action.id) !== undefined
    case 'create': {
      if (action.parentId !== undefined) {
        return reminders.some((reminder) => reminder.parentId === action.parentId && reminder.title === action.title.trim())
      }
      const created = createdId === undefined
        ? reminders.find((reminder) => reminder.listId === action.listId && reminder.title === action.title.trim())
        : find(createdId)
      return created !== undefined && shows(created, action.changes ?? {})
    }
    case 'update': {
      const current = find(action.id)
      // A move across lists can come back under a new id: RemCTL clones and deletes.
      if (action.changes.listId !== undefined) return current === undefined || current.listId === action.changes.listId
      return current !== undefined && shows(current, action.changes)
    }
  }
}

function revisionOf(...parts: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24)
}

/** Both CLIs answer a create with the new reminder's CloudKit id as `id`. */
function createdIdOf(action: ReminderWrite, stdout: string): { createdId?: string } {
  if (action.kind !== 'create' || action.parentId !== undefined) return {}
  try {
    const id = record(JSON.parse(stdout))?.id
    return typeof id === 'string' && id !== '' ? { createdId: id } : {}
  } catch {
    return {}
  }
}

interface RemctlSnapshot {
  state: RemindersState
  lists: RemctlLists
  /** The workspace's own revision, which covers completed reminders too. */
  store: string
}

export interface RemindersSourceOptions {
  run?: RunCli
  binaries?: () => RemindersBinaries
  now?: () => number
  log?: (line: string) => void
}

/**
 * The one reader and writer of Apple Reminders. Keeps the last snapshot's id map and
 * source, because a write must go where the reminder was read from.
 */
export class RemindersSource {
  private readonly run: RunCli
  private readonly binaries: () => RemindersBinaries
  private readonly now: () => number
  private readonly log: (line: string) => void
  private readonly refs = new Map<string, RemctlRef>()
  private remctl: RemctlSnapshot | undefined
  private source: RemindersState['source'] | undefined
  private completed: { store: string; reminders: Reminder[] } | undefined
  /** `list-info` per RemCTL list id. Sharees change rarely; sections come fresh with every read. */
  private readonly infos = new Map<string, { at: number; info: Json }>()

  constructor(options: RemindersSourceOptions = {}) {
    this.run = options.run ?? runCli
    this.binaries = options.binaries ?? (() => remindersBinaries())
    this.now = options.now ?? Date.now
    this.log = options.log ?? ((line) => console.warn(`[manor] ${line}`))
  }

  /** The snapshot, from RemCTL when it can read, else plain. Never throws. */
  async load(): Promise<RemindersState> {
    const { remctl, remindctl } = this.binaries()
    let reason = 'RemCTL is not installed.'
    if (remctl !== undefined) {
      try {
        const snapshot = await this.loadRemctl(remctl)
        this.remctl = snapshot
        this.source = 'remctl'
        return snapshot.state
      } catch (error: unknown) {
        reason = `RemCTL could not read Reminders: ${error instanceof Error ? error.message : 'unknown error'}.`
        this.log(reason)
      }
    }
    this.remctl = undefined
    if (remindctl !== undefined) {
      try {
        const state = await this.loadPlain(remindctl, `${reason} ${PLAIN_LIMIT}`)
        this.source = 'eventkit'
        return state
      } catch (error: unknown) {
        reason = `${reason} remindctl could not read Reminders either: ${error instanceof Error ? error.message : 'unknown error'}.`
        this.log(reason)
      }
    } else if (remctl !== undefined) {
      reason = `${reason} remindctl is not installed as a fallback.`
    }
    this.source = undefined
    return {
      type: 'reminders_state',
      status: 'unavailable',
      source: 'eventkit',
      notice: remctl === undefined && remindctl === undefined
        ? 'Neither RemCTL nor remindctl is installed on this Mac.'
        : reason,
      revision: revisionOf('unavailable', reason),
      today: amsterdamToday(this.now()),
      groups: [],
      lists: [],
      reminders: [],
      completedCount: null,
    }
  }

  private async workspace(binary: string, request: Json): Promise<Json> {
    const raw = record(parseJson(await this.run(binary, ['workspace', '--json', '--request', JSON.stringify(request)]), 'RemCTL'))
    if (raw === undefined) throw new Error('RemCTL returned no workspace')
    return raw
  }

  /** Every page of one workspace query, the later pages fetched side by side. */
  private async workspacePages(binary: string, query: Json): Promise<{ first: Json; items: Json[] }> {
    const first = await this.workspace(binary, { operation: 'query', ...query, limit: WORKSPACE_PAGE, offset: 0 })
    const total = typeof first.total === 'number' ? first.total : 0
    const offsets: number[] = []
    for (let offset = WORKSPACE_PAGE; offset < total && offsets.length < MAX_PAGES; offset += WORKSPACE_PAGE) offsets.push(offset)
    const rest = await Promise.all(offsets.map((offset) =>
      this.workspace(binary, { operation: 'query', ...query, limit: WORKSPACE_PAGE, offset })))
    const items = [first, ...rest].flatMap((page) =>
      Array.isArray(page.items) ? page.items.map(record).filter((item) => item !== undefined) : [])
    return { first, items }
  }

  private async loadRemctl(binary: string): Promise<RemctlSnapshot> {
    const { first, items } = await this.workspacePages(binary, { view: 'all' })
    const pks = (Array.isArray(first.lists) ? first.lists.map(record) : [])
      .filter((list) => list !== undefined && list.isGroup !== true)
      .flatMap((list) => idText(list?.id) ?? [])
    // Sharees and the shared flag are only in list-info, one more process per list, so
    // they are kept a few minutes. A failed one costs that list its assignee picker,
    // not the whole door, and is asked again on the next read.
    const infos = new Map(await Promise.all(pks.map(async (pk): Promise<[string, Json | undefined]> => {
      const kept = this.infos.get(pk)
      if (kept !== undefined && this.now() - kept.at < LIST_INFO_TTL_MS) return [pk, kept.info]
      try {
        const info = record(parseJson(await this.run(binary, ['list-info', '--list-id', pk, '--json']), 'RemCTL'))
        if (info !== undefined) this.infos.set(pk, { at: this.now(), info })
        return [pk, info]
      } catch (error: unknown) {
        this.log(`RemCTL could not read list ${pk}: ${error instanceof Error ? error.message : 'unknown error'}`)
        return [pk, undefined]
      }
    })))
    const lists = remctlLists(first, infos)
    const read = remctlReminders(items, lists)
    for (const { reminder, ref } of read) this.refs.set(reminder.id, ref)
    const counts = record(first.counts)
    const store = text(first.snapshot) ?? revisionOf(items)
    const reminders = read.map(({ reminder }) => reminder).filter((reminder) => !reminder.completed)
    return {
      store,
      lists,
      state: {
        type: 'reminders_state',
        status: 'ready',
        source: 'remctl',
        // RemCTL's own token stays put when only private metadata (a section, a tag, an
        // assignee) changes, so the rows are hashed too; the token still covers Completed.
        revision: revisionOf(store, lists.lists, lists.groups, reminders, amsterdamToday(this.now())),
        today: amsterdamToday(this.now()),
        groups: lists.groups,
        lists: lists.lists,
        reminders,
        completedCount: typeof counts?.completed === 'number' ? counts.completed : null,
      },
    }
  }

  private async loadPlain(binary: string, notice: string): Promise<RemindersState> {
    const flags = ['--json', '--no-input', '--no-color']
    const [rawLists, rawOpen] = await Promise.all([
      this.run(binary, ['list', ...flags]),
      this.run(binary, ['show', 'open', ...flags]),
    ])
    const lists = plainLists(parseJson(rawLists, 'remindctl'))
    const reminders = plainReminders(parseJson(rawOpen, 'remindctl'))
    return {
      type: 'reminders_state',
      status: 'ready',
      source: 'eventkit',
      notice,
      revision: revisionOf('eventkit', lists, reminders, amsterdamToday(this.now())),
      today: amsterdamToday(this.now()),
      groups: [],
      lists,
      reminders,
      completedCount: null,
    }
  }

  /** Completed reminders, newest completion first. Cached until the store changes. */
  async completedPage(offset: number): Promise<CompletedPage> {
    const all = await this.completedReminders()
    const reminders = all.slice(offset, offset + COMPLETED_PAGE_SIZE)
    const next = offset + reminders.length
    return { type: 'reminders_completed', offset, reminders, total: all.length, nextOffset: next < all.length ? next : null }
  }

  private async completedReminders(): Promise<Reminder[]> {
    if (this.source === undefined) await this.load()
    const { remctl, remindctl } = this.binaries()
    const newestFirst = (reminders: Reminder[]) =>
      reminders.sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''))
    if (this.source === 'remctl' && this.remctl !== undefined && remctl !== undefined) {
      const store = this.remctl.store
      if (this.completed?.store === store) return this.completed.reminders
      const { items } = await this.workspacePages(remctl, { view: 'completed' })
      const read = remctlReminders(items, this.remctl.lists)
      for (const { reminder, ref } of read) this.refs.set(reminder.id, ref)
      const reminders = newestFirst(read.map(({ reminder }) => reminder).filter((reminder) => reminder.completed))
      this.completed = { store, reminders }
      return reminders
    }
    if (this.source === 'eventkit' && remindctl !== undefined) {
      const raw = await this.run(remindctl, ['show', 'completed', '--json', '--no-input', '--no-color'])
      return newestFirst(plainReminders(parseJson(raw, 'remindctl')))
    }
    throw new Error('Reminders cannot be read on this Mac right now.')
  }

  /**
   * Every reminder in the one list with this exact title, open and completed, without
   * subtasks. Undefined when no list has that title. Throws when Reminders cannot be
   * read, so a failed read is never taken for an empty list.
   */
  async listContents(title: string): Promise<{ listId: string; reminders: Reminder[] } | undefined> {
    const state = await this.load()
    if (state.status !== 'ready') throw new Error(state.notice ?? 'Reminders cannot be read on this Mac right now.')
    const matches = state.lists.filter((list) => list.title === title)
    if (matches.length > 1) throw new Error(`More than one Reminders list is called ${title}.`)
    const list = matches[0]
    if (list === undefined) return undefined
    const topLevel = (reminders: Reminder[]) =>
      reminders.filter((reminder) => reminder.listId === list.id && reminder.parentId === undefined)
    const { remctl, remindctl } = this.binaries()
    if (this.source === 'remctl' && this.remctl !== undefined && remctl !== undefined) {
      const pk = this.remctl.lists.pkByList.get(list.id)
      if (pk === undefined) throw new Error(`RemCTL has no id for the list ${title}.`)
      const { items } = await this.workspacePages(remctl, { view: 'all', listId: Number(pk), includeCompleted: true })
      const read = remctlReminders(items, this.remctl.lists)
      for (const { reminder, ref } of read) this.refs.set(reminder.id, ref)
      return { listId: list.id, reminders: topLevel(read.map(({ reminder }) => reminder)) }
    }
    if (this.source === 'eventkit' && remindctl !== undefined) {
      const raw = await this.run(remindctl, ['show', 'all', '--list-id', list.id, '--json', '--no-input', '--no-color'])
      return { listId: list.id, reminders: topLevel(plainReminders(parseJson(raw, 'remindctl'))) }
    }
    throw new Error('Reminders cannot be read on this Mac right now.')
  }

  /**
   * One reminder by id, open or completed, as it is now: the last snapshot first,
   * then a direct lookup. Undefined only when Reminders was read and it no longer
   * exists; a read that fails throws, so it is never taken for a deletion.
   */
  async find(id: string): Promise<Reminder | undefined> {
    const state = await this.load()
    if (state.status !== 'ready') throw new Error(state.notice ?? 'Reminders cannot be read on this Mac right now.')
    const open = state.reminders.find((reminder) => reminder.id === id)
    if (open !== undefined) return open
    const { remctl, remindctl } = this.binaries()
    if (this.source === 'remctl' && this.remctl !== undefined && remctl !== undefined) {
      let item: Json
      try {
        item = await this.workspace(remctl, { operation: 'detail', identifier: id })
      } catch (error: unknown) {
        if (error instanceof Error && /no longer exists/i.test(error.message)) return undefined
        throw error
      }
      const read = remctlReminder(item, this.remctl.lists, new Map())
      if (read === undefined) throw new Error('RemCTL returned that reminder in a shape Manor cannot read.')
      this.refs.set(id, read.ref)
      return read.reminder
    }
    if (this.source === 'eventkit' && remindctl !== undefined) {
      const raw = await this.run(remindctl, ['show', 'all', '--json', '--no-input', '--no-color'])
      return plainReminders(parseJson(raw, 'remindctl')).find((reminder) => reminder.id === id)
    }
    throw new Error('Reminders cannot be read on this Mac right now.')
  }

  /** The RemCTL facts for one reminder: from the last read, else looked up by its id. */
  private async remctlRef(binary: string, id: string): Promise<RemctlRef> {
    const known = this.refs.get(id)
    if (known !== undefined) return known
    const item = await this.workspace(binary, { operation: 'detail', identifier: id })
    if (this.remctl === undefined) throw new Error('Reminders must be loaded before a write.')
    const read = remctlReminder(item, this.remctl.lists, new Map())
    if (read === undefined) throw new Error('That reminder no longer exists.')
    this.refs.set(id, read.ref)
    return read.ref
  }

  /**
   * One write, through the source the last snapshot came from. Throws the CLI's
   * reason. Answers the id of a created reminder when the CLI names it.
   */
  async write(action: ReminderWrite): Promise<{ createdId?: string }> {
    if (this.source === undefined) await this.load()
    const { remctl, remindctl } = this.binaries()
    if (this.source === 'remctl' && remctl !== undefined && this.remctl !== undefined) {
      const lists = this.remctl.lists
      const ids = [
        'id' in action ? action.id : undefined,
        action.kind === 'create' ? action.parentId : undefined,
      ].filter((id) => id !== undefined)
      const refs = new Map(await Promise.all(ids.map(async (id) => [id, await this.remctlRef(remctl, id)] as const)))
      const args = remctlWriteArgs(action, {
        ref: (id) => refs.get(id)!,
        listPk: (listId) => {
          const pk = lists.pkByList.get(listId)
          if (pk === undefined) throw new Error('That Reminders list no longer exists.')
          return pk
        },
      })
      return createdIdOf(action, await this.run(remctl, args))
    }
    if (this.source === 'eventkit' && remindctl !== undefined) {
      return createdIdOf(action, await this.run(remindctl, plainWriteArgs(action)))
    }
    throw new Error('Reminders cannot be written on this Mac right now.')
  }
}
