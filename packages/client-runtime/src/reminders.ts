import type { Reminder, ReminderList, ReminderWrite, ServerMessage } from '@manor/contracts'

/**
 * Apple Reminders as the client holds it. The server's snapshot is the truth; writes
 * still in flight are laid over it by `withPendingWrites`, so a click shows at once
 * and disappears again if the server refuses it.
 */

export type RemindersSnapshot = Extract<ServerMessage, { type: 'reminders_state' }>

export interface RemindersState {
  /** Whether this host can reach Apple Reminders at all, from `host_capabilities`. */
  available: boolean
  /** The last snapshot; null until the door first asks. */
  snapshot: RemindersSnapshot | null
  /** Completed reminders, newest first, loaded page by page while Completed is open. */
  completed: { reminders: Reminder[]; total: number; nextOffset: number | null } | null
}

export const NO_REMINDERS_YET: RemindersState = { available: false, snapshot: null, completed: null }

export function reduceReminders(
  state: RemindersState,
  msg: Extract<ServerMessage, { type: 'host_capabilities' | 'reminders_state' | 'reminders_completed' }>,
): RemindersState {
  switch (msg.type) {
    case 'host_capabilities': {
      const available = msg.reminders === true
      return state.available === available ? state : { ...state, available }
    }
    // A poll that changed nothing keeps every row's identity, so nothing repaints.
    case 'reminders_state':
      return state.snapshot?.revision === msg.revision ? state : { ...state, snapshot: msg }
    case 'reminders_completed': {
      // A refresh of page one that changed nothing keeps the pages loaded below it.
      if (msg.offset === 0 && state.completed !== null && msg.total === state.completed.total &&
        JSON.stringify(msg.reminders) === JSON.stringify(state.completed.reminders.slice(0, msg.reminders.length))) return state
      const earlier = msg.offset === 0 || state.completed === null ? [] : state.completed.reminders
      const seen = new Set(earlier.map((reminder) => reminder.id))
      return {
        ...state,
        completed: {
          reminders: [...earlier, ...msg.reminders.filter((reminder) => !seen.has(reminder.id))],
          total: msg.total,
          nextOffset: msg.nextOffset,
        },
      }
    }
  }
}

/** A write the client sent and the server has not yet answered. */
export interface PendingReminderWrite {
  requestId: string
  action: ReminderWrite
  /** The reminder as it was, for an uncomplete of one that is no longer in the open list. */
  before?: Reminder
}

/** The id a created reminder shows under until the server's snapshot has the real one. */
export const pendingReminderId = (requestId: string) => `pending:${requestId}`

function patched(reminder: Reminder, action: Extract<ReminderWrite, { kind: 'update' }>, lists: readonly ReminderList[]): Reminder {
  const { changes } = action
  const next: Reminder = { ...reminder }
  if (changes.title !== undefined) next.title = changes.title
  if (changes.notes === null || changes.notes === '') delete next.notes
  else if (changes.notes !== undefined) next.notes = changes.notes
  if (changes.listId !== undefined && changes.listId !== reminder.listId) {
    next.listId = changes.listId
    // Sections and assignees belong to a list and do not travel with the reminder.
    delete next.sectionId
    delete next.assignee
  }
  if (changes.sectionId !== undefined) next.sectionId = changes.sectionId
  if (changes.due === null) {
    delete next.due
    delete next.repeat
  } else if (changes.due !== undefined) next.due = changes.due
  if (changes.flagged !== undefined) next.flagged = changes.flagged
  if (changes.priority !== undefined) next.priority = changes.priority
  if (changes.url !== undefined) next.url = changes.url
  if (changes.tags !== undefined) next.tags = changes.tags
  if (changes.repeat === null) delete next.repeat
  else if (changes.repeat !== undefined) next.repeat = changes.repeat
  if (changes.assigneeId === null) delete next.assignee
  else if (changes.assigneeId !== undefined) {
    const person = lists.find((list) => list.id === next.listId)?.sharees.find((sharee) => sharee.id === changes.assigneeId)
    if (person !== undefined) next.assignee = person
  }
  return next
}

/** The open reminders with every pending write applied, in the order they were sent. */
export function withPendingWrites(
  reminders: readonly Reminder[],
  lists: readonly ReminderList[],
  pending: readonly PendingReminderWrite[],
): Reminder[] {
  let current = [...reminders]
  for (const { requestId, action, before } of pending) {
    switch (action.kind) {
      case 'create': {
        const { changes = {} } = action
        const person = changes.assigneeId == null
          ? undefined
          : lists.find((list) => list.id === action.listId)?.sharees.find((sharee) => sharee.id === changes.assigneeId)
        current.push({
          id: pendingReminderId(requestId),
          title: action.title,
          listId: action.listId,
          completed: false,
          flagged: changes.flagged === true,
          priority: changes.priority ?? 'none',
          tags: changes.tags ?? [],
          ...(changes.notes == null ? {} : { notes: changes.notes }),
          ...(changes.due == null ? {} : { due: changes.due }),
          ...(changes.url === undefined ? {} : { url: changes.url }),
          ...(changes.repeat == null ? {} : { repeat: changes.repeat }),
          ...(changes.sectionId === undefined ? {} : { sectionId: changes.sectionId }),
          ...(person === undefined ? {} : { assignee: person }),
          ...(action.parentId === undefined ? {} : { parentId: action.parentId }),
        })
        break
      }
      case 'update':
        current = current.map((reminder) => (reminder.id === action.id ? patched(reminder, action, lists) : reminder))
        break
      case 'complete':
      case 'delete':
        // A subtask goes with its parent, as it does in Reminders.app.
        current = current.filter((reminder) => reminder.id !== action.id && reminder.parentId !== action.id)
        break
      case 'uncomplete':
        if (before !== undefined && !current.some((reminder) => reminder.id === action.id)) {
          const { completedAt: _completedAt, ...rest } = before
          current.push({ ...rest, completed: false })
        }
        break
    }
  }
  return current
}

/** Where a dated reminder sits in the time columns, measured in Amsterdam wall time. */
export type ReminderTimeSlot = 'overdue' | 'today' | 'afternoon' | 'tonight' | 'tomorrow' | 'later' | 'none'

export function addDays(day: string, days: number): string {
  const [year, month, date] = day.split('-').map(Number)
  const next = new Date(Date.UTC(year!, month! - 1, date! + days))
  return next.toISOString().slice(0, 10)
}

/**
 * `now` is Amsterdam wall time. A timed reminder earlier today is overdue, as in
 * Reminders.app; an all-day one stays in Today until the day ends.
 */
export function timeSlot(reminder: Pick<Reminder, 'due'>, now: { day: string; time: string }): ReminderTimeSlot {
  const { due } = reminder
  if (due === undefined) return 'none'
  if (due.day < now.day) return 'overdue'
  if (due.day === now.day) {
    if (due.time === undefined) return 'today'
    if (due.time < now.time) return 'overdue'
    if (due.time < '12:00') return 'today'
    return due.time < '18:00' ? 'afternoon' : 'tonight'
  }
  return due.day === addDays(now.day, 1) ? 'tomorrow' : 'later'
}

/** Amsterdam wall time for `timeSlot`, from the device clock. */
export function amsterdamNow(at: Date = new Date()): { day: string; time: string } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Amsterdam',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at).map((part) => [part.type, part.value]))
  return { day: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` }
}

/** The sidebar tiles. Counts include subtasks, as RemCTL's and Apple's do. */
export interface ReminderCounts {
  today: number
  scheduled: number
  flagged: number
  assigned: number
  all: number
}

export function reminderCounts(reminders: readonly Reminder[], today: string): ReminderCounts {
  const counts: ReminderCounts = { today: 0, scheduled: 0, flagged: 0, assigned: 0, all: 0 }
  for (const reminder of reminders) {
    if (reminder.completed) continue
    counts.all += 1
    if (reminder.due !== undefined) {
      counts.scheduled += 1
      if (reminder.due.day <= today) counts.today += 1
    }
    if (reminder.flagged) counts.flagged += 1
    if (reminder.assignee?.me === true) counts.assigned += 1
  }
  return counts
}
