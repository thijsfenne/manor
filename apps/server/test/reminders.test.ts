import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => { vi.unstubAllEnvs() })
import type { ReminderWrite, ServerMessage } from '@manor/contracts'
import {
  approvedReminder,
  callReminders,
  isOverdue,
  reminderLine,
  resolveAssignee,
  resolveList,
  resolveSection,
  sortOpen,
} from '../src/mcp/remindersMcp.js'
import {
  parseReminderCreate,
  parseReminderTarget,
  reminderDeleteQuestion,
  wallDue,
} from '../src/mcp/remindersWrite.js'
import {
  RemindersSource,
  remindersBinaries,
  plainReminders,
  reflects,
  plainWriteArgs,
  remctlLists,
  remctlReminders,
  remctlWriteArgs,
  type RemctlRef,
  type RunCli,
} from '../src/reminders.js'
import { RemindersModule } from '../src/remindersModule.js'

const TODO = '83DF8A60-9915-4609-834D-6C43CB4AB586'
const PRIORITY = 'BF12219A-D33F-4B5F-A238-22601CF10856'
const PARENT = 'E6EC5707-413A-454E-8375-44157FDC3BCF'
const CHILD = '3697F959-2222-4ACF-A6D6-3FDDE3A01860'

/** Trimmed from `remctl workspace` and `remctl list-info` on the user's store, 2026-09-30. */
const workspace = {
  lists: [
    { id: 4, title: 'To do', objectUUID: TODO, isGroup: false, count: 2, color: { name: 'red', hex: '#ff2968' } },
    { id: 9, title: 'Thuis', objectUUID: 'GROUP-UUID', isGroup: true },
  ],
  sections: [{ id: 5, title: 'Prioriteit deze week', listId: 4, objectUUID: PRIORITY }],
  items: [
    {
      id: 963, objectUUID: PARENT, listId: 4, listUUID: TODO, title: 'Rekening doorgeven', completed: false,
      flagged: true, priority: 'high', section: 'Prioriteit deze week', allDay: true, dueDate: '2026-10-02T00:00:00',
      createdDate: '2025-09-25T08:05:31.832983', subtaskCount: 1, tags: ['geld'],
      recurrence: { frequency: 'weekly', interval: 2 },
      assignment: { assignee: { id: 46, name: 'Alex Example', address: 'mailto:alex@example.invalid' } },
    },
    {
      id: 1913, objectUUID: CHILD, listId: 4, listUUID: TODO, title: 'Nummer opzoeken', completed: false, flagged: false,
      priority: 'none', allDay: false, dueDate: '2026-10-01T09:30:00', parentID: 963, alarms: [{ date: 'x' }],
      recurrence: { frequency: 'monthly', interval: 1, daysOfMonth: [1, 15] }, notes: '  bel eerst  ',
      assignment: { assignee: { id: 47, name: 'Sam Example' } },
    },
  ],
  counts: { completed: 1263 },
  snapshot: 'store-rev-1',
  total: 2,
}
const todoInfo = {
  shared: true,
  sharees: [
    { id: 46, name: 'Alex Example', accessLevel: 2 },
    { id: 47, name: 'Sam Example', accessLevel: 2, currentUser: true },
  ],
}

describe('Reminders from RemCTL', () => {
  const lists = remctlLists(workspace, new Map([['4', todoInfo]]))

  it('reads lists with sections, sharees, colour and groups', () => {
    expect(lists.groups).toEqual([{ id: 'GROUP-UUID', title: 'Thuis' }])
    expect(lists.lists).toEqual([{
      id: TODO,
      title: 'To do',
      color: '#FF2968',
      shared: true,
      open: 2,
      sections: [{ id: PRIORITY, title: 'Prioriteit deze week' }],
      sharees: [
        { id: '46', name: 'Alex Example', me: false },
        { id: '47', name: 'Sam Example', me: true },
      ],
    }])
  })

  it('reads a reminder with its section, assignee, parent, wall-time due and repeat', () => {
    const [parent, child] = remctlReminders(workspace.items, lists)
    expect(parent?.reminder).toMatchObject({
      id: PARENT,
      listId: TODO,
      due: { day: '2026-10-02' },
      flagged: true,
      priority: 'high',
      tags: ['geld'],
      repeat: { frequency: 'weekly', interval: 2 },
      sectionId: PRIORITY,
      assignee: { id: '46', name: 'Alex Example', me: false },
    })
    expect(parent?.ref).toEqual({ pk: '963', listPk: '4', hasAlarms: false, hasRepeat: true, hasUrl: false })
    expect(child?.reminder).toMatchObject({
      due: { day: '2026-10-01', time: '09:30' },
      notes: 'bel eerst',
      parentId: PARENT,
      repeat: { frequency: 'monthly', interval: 1, custom: 'monthly, custom' },
      assignee: { id: '47', me: true },
    })
  })
})

describe('RemCTL write arguments', () => {
  const refs: Record<string, RemctlRef> = {
    [PARENT]: { pk: '963', listPk: '4', hasAlarms: false, hasRepeat: true, hasUrl: false },
    [CHILD]: { pk: '1913', listPk: '4', hasAlarms: true, hasRepeat: false, hasUrl: true },
  }
  const resolve = { ref: (id: string) => refs[id]!, listPk: (id: string) => (id === TODO ? '4' : '3') }

  it('creates with private fields, an alarm on a timed due, and a title that starts with a dash', () => {
    expect(remctlWriteArgs({
      kind: 'create',
      listId: TODO,
      title: '-bellen',
      changes: { due: { day: '2026-10-01', time: '09:00' }, sectionId: PRIORITY, assigneeId: '46', flagged: true, tags: ['geld'], notes: '- lijst' },
    }, resolve)).toEqual([
      'add', '--list-id', '4', '--notes=- lijst', '--due', '2026-10-01 09:00', '--alarm', '2026-10-01T09:00',
      '--private', '--flag', '--tags=geld', '--section-id', PRIORITY, '--assign', '46', '--json', '--', '-bellen',
    ])
    expect(remctlWriteArgs({ kind: 'create', listId: TODO, title: 'Melk' }, resolve))
      .toEqual(['add', '--list-id', '4', '--json', '--', 'Melk'])
    expect(remctlWriteArgs({ kind: 'create', listId: TODO, title: 'Stap 1', parentId: PARENT }, resolve))
      .toEqual(['edit', '963', '--private', '--subtask', '{"title":"Stap 1"}', '--json'])
  })

  it('clears a date together with its repeat, and a note to empty', () => {
    expect(remctlWriteArgs({ kind: 'update', id: PARENT, changes: { due: null, notes: null } }, resolve))
      .toEqual(['edit', '963', '--notes=', '--due', 'clear', '--recurrence', 'clear', '--json'])
    expect(remctlWriteArgs({ kind: 'update', id: PARENT, changes: { due: { day: '2026-10-05', time: '14:00' }, tags: [], assigneeId: null } }, resolve))
      .toEqual(['edit', '963', '--due', '2026-10-05 14:00', '--alarm', '2026-10-05T14:00', '--private', '--clear-tags', '--unassign', '--json'])
    // An existing alarm on the old time is RemCTL's to carry.
    expect(remctlWriteArgs({ kind: 'update', id: CHILD, changes: { due: { day: '2026-10-05', time: '14:00' } } }, resolve))
      .toEqual(['edit', '1913', '--due', '2026-10-05 14:00', '--json'])
  })

  it('refuses what RemCTL would do wrong', () => {
    expect(() => remctlWriteArgs({ kind: 'update', id: PARENT, changes: { listId: TODO, title: 'x' } }, resolve)).toThrow(/its own change/)
    expect(() => remctlWriteArgs({ kind: 'update', id: CHILD, changes: { url: 'https://example.com' } }, resolve)).toThrow(/already has a link/)
    expect(() => remctlWriteArgs({ kind: 'update', id: PARENT, changes: {} }, resolve)).toThrow(/Nothing/)
    expect(() => remctlWriteArgs({ kind: 'create', listId: TODO, title: 'x', parentId: PARENT, changes: { flagged: true } }, resolve))
      .toThrow(/only a title/)
  })

  it('completes, reopens and deletes by store id', () => {
    expect(remctlWriteArgs({ kind: 'complete', id: PARENT }, resolve)).toEqual(['done', '963', '--json'])
    expect(remctlWriteArgs({ kind: 'uncomplete', id: PARENT }, resolve)).toEqual(['undone', '963', '--json'])
    expect(remctlWriteArgs({ kind: 'delete', id: PARENT }, resolve)).toEqual(['delete', '963', '--force', '--json'])
  })
})

describe('finding the Reminders CLIs', () => {
  it('finds only the HOME binary on a mock run, never the system ones that read the real list', () => {
    const everywhere = () => true
    expect(remindersBinaries('/fixture', everywhere, true)).toEqual({ remctl: '/fixture/bin/remctl' })
    expect(remindersBinaries('/fixture', (path) => path.startsWith('/opt/'), true)).toEqual({})
    expect(remindersBinaries('/fixture', (path) => path.startsWith('/opt/')))
      .toEqual({ remctl: '/opt/homebrew/bin/remctl', remindctl: '/opt/homebrew/bin/remindctl' })
  })
})

describe('the plain fallback', () => {
  it('writes what EventKit holds and refuses the rest', () => {
    expect(plainWriteArgs({ kind: 'uncomplete', id: PARENT })).toEqual(['edit', PARENT, '--incomplete', '--json', '--no-input', '--no-color'])
    expect(plainWriteArgs({ kind: 'update', id: PARENT, changes: { due: null, priority: 'low' } }))
      .toEqual(['edit', PARENT, '--clear-due', '--priority', 'low', '--json', '--no-input', '--no-color'])
    expect(() => plainWriteArgs({ kind: 'update', id: PARENT, changes: { sectionId: PRIORITY } })).toThrow(/Only RemCTL can write sectionId/)
    expect(() => plainWriteArgs({ kind: 'create', listId: TODO, title: 'x', parentId: PARENT })).toThrow(/subtasks/)
  })

  it('reads an all-day due as its Amsterdam day', () => {
    const [reminder] = plainReminders([{ id: PARENT, title: 'Water', listID: TODO, isCompleted: false, dueDate: '2026-01-29T23:00:00Z', dueDateIsAllDay: true }])
    expect(reminder).toMatchObject({ id: PARENT, due: { day: '2026-01-30' }, flagged: false, tags: [] })
  })

  it('falls back to remindctl when RemCTL cannot read, and writes there too', async () => {
    const calls: string[][] = []
    const run: RunCli = async (binary, args) => {
      calls.push([binary, ...args])
      if (binary === 'remctl') throw new Error('database schema changed')
      if (args[0] === 'list') return JSON.stringify([{ id: TODO, title: 'To do', reminderCount: 1 }])
      if (args[0] === 'show') return JSON.stringify([{ id: PARENT, title: 'Water', listID: TODO, isCompleted: false }])
      return '{}'
    }
    const source = new RemindersSource({ run, binaries: () => ({ remctl: 'remctl', remindctl: 'remindctl' }), log: () => undefined })
    const state = await source.load()
    expect(state).toMatchObject({ status: 'ready', source: 'eventkit', reminders: [{ id: PARENT }] })
    expect(state.notice).toMatch(/database schema changed.*Sections, assignees/)
    await source.write({ kind: 'complete', id: PARENT })
    expect(calls.at(-1)).toEqual(['remindctl', 'complete', PARENT, '--json', '--no-input', '--no-color'])

    const nothing = new RemindersSource({ run, binaries: () => ({}), log: () => undefined })
    expect(await nothing.load()).toMatchObject({ status: 'unavailable', notice: expect.stringMatching(/Neither/) })
    await expect(nothing.find(PARENT)).rejects.toThrow(/Neither/)
  })

  it('finds a reminder gone only when RemCTL says so, and throws on any other failed lookup', async () => {
    let detail = 'Reminder no longer exists.'
    const run: RunCli = async (_binary, args) => {
      if (args[0] === 'list-info') return JSON.stringify(todoInfo)
      if (args[0] === 'workspace' && args[3]?.includes('"detail"')) throw new Error(detail)
      return JSON.stringify(workspace)
    }
    const source = new RemindersSource({ run, binaries: () => ({ remctl: 'remctl' }), log: () => undefined })
    expect(await source.find('GONE')).toBeUndefined()
    detail = 'database is locked'
    await expect(source.find('GONE')).rejects.toThrow(/locked/)
  })

  it('maps an id to the RemCTL store id before a write', async () => {
    const calls: string[][] = []
    const run: RunCli = async (_binary, args) => {
      calls.push([...args])
      if (args[0] === 'workspace') return JSON.stringify(workspace)
      if (args[0] === 'list-info') return JSON.stringify(todoInfo)
      return '{}'
    }
    const source = new RemindersSource({ run, binaries: () => ({ remctl: 'remctl' }), log: () => undefined })
    expect(await source.load()).toMatchObject({ source: 'remctl', completedCount: 1263, reminders: [{ id: PARENT }, { id: CHILD }] })
    await source.write({ kind: 'update', id: CHILD, changes: { flagged: true } })
    expect(calls.at(-1)).toEqual(['edit', '1913', '--private', '--flagged', '--json'])
  })
})

describe('the snapshot revision', () => {
  it('moves when only private metadata changed under the same RemCTL token', async () => {
    let current: object = workspace
    const run: RunCli = async (_binary, args) => JSON.stringify(args[0] === 'list-info' ? todoInfo : current)
    const source = new RemindersSource({ run, binaries: () => ({ remctl: 'remctl' }), log: () => undefined })
    const before = await source.load()
    // A section move in Apple's store: the reminder's section changes, RemCTL's token does not.
    current = { ...workspace, items: [workspace.items[0]!, { ...workspace.items[1]!, section: 'Prioriteit deze week' }] }
    const after = await source.load()
    expect(after.reminders.find((reminder) => reminder.id === CHILD)?.sectionId).toBe(PRIORITY)
    expect(after.revision).not.toBe(before.revision)
  })
})

describe('the Reminders door protocol', () => {
  it('reads again until a slow private write shows, then answers', async () => {
    const lists = remctlLists(workspace, new Map([['4', todoInfo]]))
    const [parent] = remctlReminders(workspace.items, lists).map(({ reminder }) => reminder)
    const action: ReminderWrite = { kind: 'update', id: PARENT, changes: { tags: ['geld', 'huis'] } }
    expect(reflects([parent!], action)).toBe(false)
    const stale = { type: 'reminders_state', status: 'ready', revision: 'r1', reminders: [parent] }
    const fresh = { type: 'reminders_state', status: 'ready', revision: 'r2', reminders: [{ ...parent, tags: ['huis', 'geld'] }] }
    const loads = [stale, fresh]
    const sent: unknown[] = []
    const source = { write: async () => ({}), load: async () => loads.shift() ?? fresh } as unknown as RemindersSource
    const module = new RemindersModule({ source, broadcast: (message) => sent.push(message), pause: async () => undefined })
    await module.handle({ type: 'reminders_write', requestId: 'q', action }, () => undefined, () => sent.push('ack'))
    expect(sent).toEqual([fresh, 'ack'])
    expect(reflects([], { kind: 'complete', id: PARENT })).toBe(true)
    expect(reflects([parent!], { kind: 'create', listId: TODO, title: 'Melk' }, 'NEW')).toBe(false)
  })

  it('runs the open-loops sync after a door write, and once for a burst', async () => {
    const order: string[] = []
    const fresh = { type: 'reminders_state', status: 'ready', revision: 'r2', reminders: [] }
    const source = { write: async () => ({}), load: async () => fresh } as unknown as RemindersSource
    const openLoops = {
      run: async () => {
        order.push('sync')
        return { steps: ['close'], notes: [], failures: [], wroteReminders: false }
      },
    }
    const module = new RemindersModule({ source, openLoops, broadcast: (message) => order.push(message.type) })
    await module.handle({ type: 'reminders_write', requestId: 'q', action: { kind: 'complete', id: PARENT } }, () => undefined, () => order.push('ack'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(order).toEqual(['reminders_state', 'ack', 'sync'])
    await Promise.all([module.syncOpenLoops(), module.syncOpenLoops()])
    expect(order).toEqual(['reminders_state', 'ack', 'sync', 'sync'])
  })

  it('broadcasts the fresh snapshot before a failed write answers', async () => {
    const order: string[] = []
    const source = {
      write: async () => { order.push('write'); throw new Error('ReminderKit refused') },
      load: async () => { order.push('load'); return { type: 'reminders_state', revision: 'r2' } },
    } as unknown as RemindersSource
    const module = new RemindersModule({ source, broadcast: (message: ServerMessage) => order.push(`broadcast ${message.type}`) })
    await expect(module.handle({ type: 'reminders_write', requestId: 'q', action: { kind: 'complete', id: PARENT } }, () => undefined, () => order.push('ack')))
      .rejects.toThrow(/ReminderKit refused/)
    expect(order).toEqual(['write', 'load', 'broadcast reminders_state'])
  })

  it('answers a write that never shows as a failure, after broadcasting what is there', async () => {
    const lists = remctlLists(workspace, new Map([['4', todoInfo]]))
    const [parent] = remctlReminders(workspace.items, lists).map(({ reminder }) => reminder)
    const stale = { type: 'reminders_state', status: 'ready', revision: 'r1', reminders: [parent] }
    const sent: unknown[] = []
    let loads = 0
    const source = { write: async () => ({}), load: async () => { loads += 1; return stale } } as unknown as RemindersSource
    const module = new RemindersModule({ source, broadcast: (message) => sent.push(message), pause: async () => undefined })
    const action: ReminderWrite = { kind: 'update', id: PARENT, changes: { tags: ['nooit'] } }
    await expect(module.handle({ type: 'reminders_write', requestId: 'q', action }, () => undefined, () => sent.push('ack')))
      .rejects.toThrow(/not shown this change/)
    expect(sent).toEqual([stale])
    expect(loads).toBe(10)
  })

  it('never takes an unreadable snapshot as proof of a complete or delete', async () => {
    const unreadable = { type: 'reminders_state', status: 'unavailable', revision: 'x', reminders: [] }
    for (const kind of ['complete', 'delete'] as const) {
      const sent: unknown[] = []
      const source = { write: async () => ({}), load: async () => unreadable } as unknown as RemindersSource
      const module = new RemindersModule({ source, broadcast: (message) => sent.push(message), pause: async () => undefined })
      await expect(module.handle({ type: 'reminders_write', requestId: 'q', action: { kind, id: PARENT } }, () => undefined, () => sent.push('ack')))
        .rejects.toThrow(/not shown this change/)
      expect(sent).toEqual([unreadable])
    }
  })
})

describe('Nova’s Reminders connector', () => {
  const lists = remctlLists(workspace, new Map([['4', todoInfo]]))
  const [parent, child] = remctlReminders(workspace.items, lists).map(({ reminder }) => reminder)
  const todo = lists.lists[0]!

  it('writes due dates as Amsterdam wall time', () => {
    const timed = parseReminderCreate({ title: 'Bel de huisarts', list: 'To do', due: '2026-10-26T09:00', notes: 'voor 10:00' })
    expect(wallDue(timed.due!)).toEqual({ day: '2026-10-26', time: '09:00' })
    const placed = parseReminderCreate({ title: 'Vluchtkoffer', list: 'To do', section: 'Prioriteit deze week', assignee: 'Alex', due: '2026-10-03' })
    expect(wallDue(placed.due!)).toEqual({ day: '2026-10-03' })
  })

  it('refuses a create it could not write exactly', () => {
    expect(() => parseReminderCreate({ title: 'x', list: 'To do', due: '2026-10-03T14:00+02:00' })).toThrow(/wall-clock/)
    expect(() => parseReminderCreate({ title: 'x', list: 'To do', due: '2026-10-25T02:30' })).toThrow(/twice/)
    expect(() => parseReminderCreate({ title: ' ', list: 'To do' })).toThrow(/title/)
    expect(() => parseReminderCreate({ title: 'x' })).toThrow(/list/)
  })

  it('resolves lists, sections and people by name, refusing ambiguity', () => {
    const cased = [todo, { ...todo, id: 'B', title: 'To Do' }, { ...todo, id: 'C', title: 'Groceries' }]
    expect(resolveList(cased, 'To Do').id).toBe('B')
    expect(resolveList(cased, 'groceries').id).toBe('C')
    expect(() => resolveList(cased, 'to do')).toThrow(/differ only in case/)
    expect(resolveSection(todo, 'prioriteit deze week').id).toBe(PRIORITY)
    expect(() => resolveSection(todo, 'Wishlist')).toThrow(/no single section/)
    expect(resolveAssignee(todo, 'alex').id).toBe('46')
    expect(resolveAssignee(todo, 'me').id).toBe('47')
    expect(() => resolveAssignee(todo, 'Robin')).toThrow(/Nobody unique/)
  })

  it('reads a line with section, first-name assignee, parent and overdue', () => {
    const now = Date.parse('2026-10-01T09:00:00Z') // 11:00 in Amsterdam
    expect(sortOpen([parent!, child!]).map((reminder) => reminder.id)).toEqual([CHILD, PARENT])
    expect(isOverdue(child!, now)).toBe(true)
    expect(reminderLine(child!, lists, now, new Map([[PARENT, 'Rekening doorgeven']]))).toEqual({
      id: CHILD,
      title: 'Nummer opzoeken',
      list: 'To do',
      due: '2026-10-01T09:30',
      completed: false,
      overdue: true,
      assignee: 'Sam',
      parent: 'Rekening doorgeven',
      notes: 'bel eerst',
    })
  })

  it('acts on complete or delete only when the id still carries the approved title and list', () => {
    const target = parseReminderTarget({ id: PARENT, title: 'Rekening doorgeven', list: 'To do' }, 'delete_reminder')
    expect(reminderDeleteQuestion(target))
      .toBe('Delete the reminder “Rekening doorgeven” from the Reminders list “To do”? This cannot be undone.')
    expect(() => parseReminderTarget({ id: '963', title: 'x', list: 'To do' }, 'delete_reminder')).toThrow(/full id/)
    expect(approvedReminder(parent, lists.lists, target).id).toBe(PARENT)
    expect(() => approvedReminder({ ...parent!, title: 'Iets anders' }, lists.lists, target)).toThrow(/not what was approved/)
    expect(() => approvedReminder(undefined, lists.lists, target)).toThrow(/No reminder has that id/)
  })

  it('never deletes from a shared list, even one that reads as unshared', async () => {
    // The user named these two as shared; the third list is theirs alone.
    vi.stubEnv('MANOR_REMINDERS_SHARED_LISTS', 'To do, Groceries')
    const writes: ReminderWrite[] = []
    const shoppingId = 'C0FFEE00-0000-4000-8000-000000000001'
    const choresId = 'C0FFEE00-0000-4000-8000-000000000002'
    // As the EventKit fallback reads them: nothing is flagged shared.
    const plainLists = [
      { ...todo, shared: false },
      { ...todo, id: shoppingId, title: 'Groceries', shared: false },
      { ...todo, id: choresId, title: 'Chores', shared: false },
    ]
    const rows = [parent!, { ...parent!, id: shoppingId, listId: shoppingId }, { ...parent!, id: choresId, listId: choresId }]
    const source = {
      find: async (id: string) => rows.find((row) => row.id === id),
      load: async () => ({ type: 'reminders_state', status: 'ready', lists: plainLists, reminders: rows }),
      write: async (action: ReminderWrite) => { writes.push(action); return {} },
    } as unknown as RemindersSource
    const remove = (id: string, list: string) => callReminders(source, 'delete_reminder', { id, title: 'Rekening doorgeven', list })
    await expect(remove(PARENT, 'To do')).rejects.toThrow(/shared/)
    await expect(remove(shoppingId, 'Groceries')).rejects.toThrow(/shared/)
    expect(writes).toEqual([])
    await expect(remove(choresId, 'Chores')).resolves.toMatchObject({ deleted: true })
    expect(writes).toEqual([{ kind: 'delete', id: choresId }])
  })
})
