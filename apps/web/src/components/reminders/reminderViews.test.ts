import { describe, expect, it } from 'vitest'
import type { Reminder, ReminderList } from '@manor/contracts'
import {
  boardColumns,
  calendarWeeks,
  dateShortcuts,
  inSavedOrder,
  inScope,
  stepDay,
  listGroups,
  liveWrites,
  matchesSearch,
  newReminderTarget,
  reconciledOrder,
  resolveSelection,
  scopeExists,
  type DoorWrite,
} from './reminderViews'

const reminder = (id: string, extra: Partial<Reminder> = {}): Reminder => ({
  id,
  title: id,
  listId: 'todo',
  completed: false,
  flagged: false,
  priority: 'none',
  tags: [],
  ...extra,
})

const lists: ReminderList[] = [
  {
    id: 'todo',
    title: 'To do',
    shared: true,
    open: 3,
    sections: [{ id: 'week', title: 'Prioriteit deze week' }, { id: 'later', title: 'Lange termijn' }],
    sharees: [{ id: 'me', name: 'Sam', me: true }, { id: 'max', name: 'Robin', me: false }],
  },
  { id: 'shop', title: 'Boodschappen', shared: true, open: 1, sections: [], sharees: [] },
]

const now = { day: '2026-09-30', time: '13:00' }

describe('reminder scopes', () => {
  it('puts Today at today and before, and a section scope only on its section', () => {
    expect(inScope(reminder('a', { due: { day: '2026-09-29' } }), { kind: 'tile', tile: 'today' }, now.day)).toBe(true)
    expect(inScope(reminder('b', { due: { day: '2026-10-01' } }), { kind: 'tile', tile: 'today' }, now.day)).toBe(false)
    expect(inScope(reminder('c', { sectionId: 'week' }), { kind: 'list', listId: 'todo', sectionId: 'later' }, now.day)).toBe(false)
  })

  it('drops flagged and assigned tiles and sections when the private API is gone', () => {
    expect(scopeExists({ kind: 'tile', tile: 'flagged' }, lists, true)).toBe(false)
    expect(scopeExists({ kind: 'list', listId: 'todo', sectionId: 'week' }, lists, true)).toBe(false)
    expect(scopeExists({ kind: 'list', listId: 'todo' }, lists, true)).toBe(true)
    expect(scopeExists({ kind: 'list', listId: 'gone' }, lists, false)).toBe(false)
  })

  it('searches every word across title, notes and tags', () => {
    const item = reminder('x', { title: 'Buy paint', notes: 'white, matte', tags: ['home'] })
    expect(matchesSearch(item, 'paint #home')).toBe(true)
    expect(matchesSearch(item, 'paint glossy')).toBe(false)
  })
})

describe('list layout', () => {
  it('shows loose reminders headless first, then every section, and nests subtasks under a present parent', () => {
    const groups = listGroups(
      [reminder('loose'), reminder('p', { sectionId: 'week' }), reminder('child', { sectionId: 'week', parentId: 'p' })],
      { kind: 'list', listId: 'todo' },
      lists,
      now.day,
      { plain: false, searching: false },
    )
    expect(groups.map((group) => group.title)).toEqual([null, 'Prioriteit deze week', 'Lange termijn'])
    expect(groups[1]!.nodes).toHaveLength(1)
    expect(groups[1]!.nodes[0]!.subtasks.map((child) => child.id)).toEqual(['child'])
    expect(groups[2]!.nodes).toEqual([])
  })

  it('flattens a list with sections to one group in plain mode', () => {
    const groups = listGroups([reminder('a', { sectionId: 'week' })], { kind: 'list', listId: 'todo' }, lists, now.day, { plain: true, searching: false })
    expect(groups).toHaveLength(1)
    expect(groups[0]!.title).toBeNull()
  })
})

describe('columns layout', () => {
  it('gives a list one column per section and a No section column only when needed', () => {
    const board = boardColumns([reminder('a', { sectionId: 'week' })], { kind: 'list', listId: 'todo' }, lists, now, false)
    expect(board.columns.map((column) => column.title)).toEqual(['Prioriteit deze week', 'Lange termijn'])
    expect(board.columns[0]!.sectionId).toBe('week')
  })

  it('files a tile by time of day and falls back to its empty state when nothing is dated', () => {
    const dated = boardColumns(
      [reminder('late', { due: { day: '2026-09-30', time: '09:00' } }), reminder('eve', { due: { day: '2026-09-30', time: '19:00' } })],
      { kind: 'tile', tile: 'today' },
      lists,
      now,
      false,
    )
    expect(dated.columns.map((column) => [column.key, column.nodes.map((node) => node.reminder.id)])).toEqual([
      ['overdue', ['late']],
      ['today', []],
      ['afternoon', []],
      ['tonight', ['eve']],
    ])
    const undated = boardColumns([reminder('a')], { kind: 'tile', tile: 'all' }, lists, now, false)
    expect(undated.undated).toBe(true)
    expect(undated.columns.map((column) => column.key)).toEqual(['none'])
  })
})

describe('pending writes', () => {
  const create: DoorWrite = {
    requestId: 'r1',
    action: { kind: 'create', listId: 'todo', title: 'New one' },
    knownIds: new Set(['a']),
  }

  it('drops a create the snapshot already shows, and hands its selection the real id', () => {
    const reminders = [reminder('a'), reminder('real', { title: 'New one' })]
    expect(liveWrites([create], { reminders: [reminder('a')] })).toHaveLength(1)
    expect(liveWrites([create], { reminders })).toHaveLength(0)
    // Two creates with one title: the one new row answers only the first, and stays
    // claimed once the first has gone, across later renders too.
    const twin: DoorWrite = { ...create, requestId: 'r2' }
    const waiting = liveWrites([create, twin], { reminders })
    expect(waiting.map((write) => write.requestId)).toEqual(['r2'])
    expect(liveWrites(waiting, { reminders })).toHaveLength(1)
    expect(resolveSelection('pending:r2', [create, twin], reminders)).toBe('pending:r2')
    // An answered create still hands its selection on before it goes.
    expect(resolveSelection('pending:r1', [{ ...create, answered: true }], reminders)).toBe('real')
    expect(liveWrites([{ ...create, answered: true }], { reminders: [reminder('a')] })).toEqual([])
    expect(resolveSelection('pending:r1', [create], reminders)).toBe('real')
    expect(resolveSelection('pending:r1', [create], [reminder('a')])).toBe('pending:r1')
  })
})

describe('dates', () => {
  it('lays a month out in six Monday-first weeks', () => {
    const weeks = calendarWeeks('2026-10')
    expect(weeks).toHaveLength(6)
    // 1 October 2026 is a Thursday, so the grid opens on Monday 28 September.
    expect(weeks[0]![0]).toBe('2026-09-28')
    expect(weeks[0]![3]).toBe('2026-10-01')
  })

  it('walks the date picker across month edges, holding a long date to a short month', () => {
    expect(stepDay('2026-09-30', 'ArrowRight')).toBe('2026-10-01')
    expect(stepDay('2026-10-01', 'ArrowUp')).toBe('2026-09-24')
    expect(stepDay('2026-01-31', 'PageDown')).toBe('2026-02-28')
    expect(stepDay('2026-03-31', 'PageUp')).toBe('2026-02-28')
    expect(stepDay('2026-09-30', 'Enter')).toBeNull()
  })

  it('reads Next week as the coming Monday', () => {
    expect(dateShortcuts('2026-09-30').map((shortcut) => shortcut.day)).toEqual(['2026-09-30', '2026-10-01', '2026-10-05'])
  })

  it('makes a reminder from Assigned to me on a list the user shares, assigned to them', () => {
    expect(newReminderTarget({ kind: 'tile', tile: 'assigned' }, lists, now.day, false)).toEqual({ listId: 'todo', changes: { assigneeId: 'me' } })
    expect(newReminderTarget({ kind: 'tile', tile: 'today' }, lists, now.day, false)).toEqual({ listId: 'todo', changes: { due: { day: now.day } } })
  })
})

describe('inSavedOrder', () => {
  const columns = (...keys: string[]) => keys.map((key) => ({ key }))
  const keys = (shown: readonly { key: string }[]) => shown.map((column) => column.key)

  it('follows the saved order and keeps Apple order without one', () => {
    expect(keys(inSavedOrder(columns('a', 'b', 'c'), ['c', 'a', 'b']))).toEqual(['c', 'a', 'b'])
    expect(keys(inSavedOrder(columns('a', 'b', 'c'), []))).toEqual(['a', 'b', 'c'])
  })

  it('puts sections new in Apple at the end, in Apple order', () => {
    expect(keys(inSavedOrder(columns('new1', 'a', 'new2', 'b'), ['b', 'a']))).toEqual(['b', 'a', 'new1', 'new2'])
  })

  it('skips a removed section without disturbing the rest', () => {
    expect(keys(inSavedOrder(columns('a', 'c'), ['c', 'gone', 'a']))).toEqual(['c', 'a'])
  })
})

describe('reconciledOrder', () => {
  it('keeps each new section at the end across snapshots and forgets a removed one', () => {
    const first = reconciledOrder(['b', 'a'], ['a', 'b', 'c'])
    expect(first).toEqual(['b', 'a', 'c'])
    // Apple inserts d ahead of c: it still lands after c, which already had its place.
    expect(reconciledOrder(first!, ['a', 'b', 'd', 'c'])).toEqual(['b', 'a', 'c', 'd'])
    expect(reconciledOrder(['b', 'gone', 'a'], ['a', 'b'])).toEqual(['b', 'a'])
  })

  it('answers null when the saved order is already current', () => {
    expect(reconciledOrder(['b', 'a'], ['a', 'b'])).toBeNull()
  })
})
