import { describe, expect, it } from 'vitest'
import type { Reminder, ReminderList, ServerMessage } from '@manor/contracts'
import {
  NO_REMINDERS_YET,
  pendingReminderId,
  reduceReminders,
  reminderCounts,
  timeSlot,
  withPendingWrites,
  type RemindersSnapshot,
} from './reminders'

const list: ReminderList = {
  id: 'todo',
  title: 'To do',
  shared: true,
  open: 2,
  sections: [{ id: 's1', title: 'Prioriteit deze week' }],
  sharees: [{ id: '46', name: 'Robin Example', me: false }, { id: '47', name: 'Sam Example', me: true }],
}
const base = { listId: 'todo', completed: false, flagged: false, priority: 'none' as const, tags: [] }
const parent: Reminder = { ...base, id: 'p', title: 'Rekening', due: { day: '2026-10-01', time: '09:30' }, repeat: { frequency: 'weekly', interval: 1 } }
const child: Reminder = { ...base, id: 'c', title: 'Nummer', parentId: 'p' }

describe('Reminders state', () => {
  it('keeps the same state for an unchanged poll and appends completed pages', () => {
    const snapshot = { type: 'reminders_state', revision: 'r1' } as RemindersSnapshot
    const first = reduceReminders(NO_REMINDERS_YET, snapshot)
    expect(reduceReminders(first, { ...snapshot })).toBe(first)
    const page = reduceReminders(first, { type: 'reminders_completed', offset: 0, reminders: [parent], total: 2, nextOffset: 1 })
    const more = reduceReminders(page, { type: 'reminders_completed', offset: 1, reminders: [parent, child], total: 2, nextOffset: null })
    expect(more.completed?.reminders.map((reminder) => reminder.id)).toEqual(['p', 'c'])
    // Polling page one keeps what is scrolled in below it until page one changes.
    const firstPage: Extract<ServerMessage, { type: 'reminders_completed' }> = { type: 'reminders_completed', offset: 0, reminders: [parent], total: 2, nextOffset: 1 }
    expect(reduceReminders(more, firstPage)).toBe(more)
    expect(reduceReminders(more, { ...firstPage, total: 1, nextOffset: null }).completed?.reminders).toEqual([parent])
  })

  it('lays pending writes over the snapshot in the order they were sent', () => {
    const shown = withPendingWrites([parent, child], [list], [
      { requestId: 'a', action: { kind: 'update', id: 'p', changes: { due: null, assigneeId: '47', sectionId: 's1' } } },
      { requestId: 'b', action: { kind: 'create', listId: 'todo', title: 'Melk', changes: { flagged: true } } },
    ])
    expect(shown[0]).toMatchObject({ id: 'p', sectionId: 's1', assignee: { id: '47', me: true } })
    expect(shown[0]).not.toHaveProperty('due')
    expect(shown[0]).not.toHaveProperty('repeat')
    expect(shown[2]).toMatchObject({ id: pendingReminderId('b'), title: 'Melk', flagged: true })

    // Completing takes the subtasks along; undoing brings the parent back.
    expect(withPendingWrites([parent, child], [list], [{ requestId: 'c', action: { kind: 'complete', id: 'p' } }])).toEqual([])
    const restored = withPendingWrites([], [list], [{ requestId: 'd', action: { kind: 'uncomplete', id: 'p' }, before: { ...parent, completed: true, completedAt: '2026-10-01T10:00' } }])
    expect(restored).toEqual([parent])
  })

  it('sorts dated reminders into time slots from Amsterdam wall time', () => {
    const now = { day: '2026-10-01', time: '11:00' }
    const at = (day: string, time?: string) => timeSlot({ due: time === undefined ? { day } : { day, time } }, now)
    expect([at('2026-09-30'), at('2026-10-01', '09:30'), at('2026-10-01'), at('2026-10-01', '11:30'), at('2026-10-01', '12:00'),
      at('2026-10-01', '18:00'), at('2026-10-02'), at('2026-10-09'), timeSlot({}, now)])
      .toEqual(['overdue', 'overdue', 'today', 'today', 'afternoon', 'tonight', 'tomorrow', 'later', 'none'])
    expect(reminderCounts([parent, child, { ...base, id: 'f', title: 'F', flagged: true, assignee: list.sharees[1]! }], '2026-10-01'))
      .toEqual({ today: 1, scheduled: 1, flagged: 1, assigned: 1, all: 3 })
  })
})
