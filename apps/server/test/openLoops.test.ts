import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

/** Lets one test land a concurrent ledger write while editLedger stages its own. */
const race = vi.hoisted(() => ({ during: undefined as (() => Promise<void>) | undefined }))
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return {
    ...fs,
    writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
      const during = race.during
      if (during !== undefined && String(args[0]).includes('.manor-')) {
        race.during = undefined
        await during()
      }
      return fs.writeFile(...args)
    },
  }
})
import type { Reminder, ReminderWrite } from '@manor/contracts'
import { closeItem, editLedger, noteId, parseLedger, reminderTitle, reopenItem } from '../src/openLoops.js'
import { OpenLoopsSync, planSync, type SyncState } from '../src/openLoopsSync.js'

const NOW = Date.parse('2026-10-02T10:00:00Z')

/** Shaped like the memory folder's memory/open-loops.md on 2026-10-02, trimmed. */
const LEDGER = `# Open loops

## Maintenance rules

- An active item requires a concrete next action.

## Actions awaiting source verification

- [clinic-booking] Owner: the user; Next: Book the diagnosis at Example Clinic (due 20 Oct); the user 2026-09-30: not booked yet; Source: 29 Sep daily; History: none; Checked: 2026-09-30; Status: open; Deadline: 2026-11-03; Reminder: none; Deadline notice: none.
- [application-status] Owner: Huxley; Next: Verify the status check; Source: pipeline; History: legacy lines 7; Checked: 2026-09-14 (historical only); Status: needs-check; Deadline: unconfirmed; Reminder: unknown; Deadline notice: unknown.
- [old-done] Owner: none; Next: Already finished; Source: x; Checked: 2026-09-28; Status: done; Deadline: unconfirmed; Reminder: none; Deadline notice: none.
- [broken] Owner: the user; Next: Has two statuses; Status: open; Source: x; Status: open.

## Suppressed

Keep these compact identities.

- [guest-invite] Owner: none; Next: none. Was: send the invite; Checked: 2026-09-30; Status: closed.

## Migration provenance

The original paragraphs are preserved.
`

function reminder(id: string, notes: string | undefined, extra: Partial<Reminder> = {}): Reminder {
  return {
    id,
    title: `title ${id}`,
    listId: 'OPEN-LOOPS',
    ...(notes === undefined ? {} : { notes }),
    completed: false,
    flagged: false,
    priority: 'none',
    tags: [],
    createdAt: '2026-09-30T23:35',
    ...extra,
  }
}

/** Seen open while the line said `Checked: 2026-09-30`, clinic-booking's own value in LEDGER. */
const tracked = (reminderId: string, next: string, deadline: string | null, checked = '2026-09-30') => ({ reminderId, next, deadline, checked })

describe('the open-loops ledger', () => {
  const ledger = parseLedger(LEDGER)

  it('reads fields at known keys only, so values keep their own semicolons', () => {
    const stam = ledger.items.find((item) => item.id === 'clinic-booking')!
    expect(stam).toMatchObject({
      active: true,
      next: 'Book the diagnosis at Example Clinic (due 20 Oct); the user 2026-09-30: not booked yet',
      deadline: '2026-11-03',
    })
    expect(ledger.items.find((item) => item.id === 'application-status')).toMatchObject({ active: true, deadline: undefined })
    expect(ledger.items.find((item) => item.id === 'old-done')?.active).toBe(false)
    expect(ledger.suppressed).toEqual(new Set(['guest-invite']))
  })

  it('skips a line it cannot read instead of guessing', () => {
    expect(ledger.skipped).toEqual([{ id: 'broken', index: 11, reason: 'the line has Status twice' }])
    expect(ledger.items.some((item) => item.id === 'broken')).toBe(false)
  })

  it('skips a mistyped line or a missing or unclear status instead of reading the loop as gone', () => {
    const stam = LEDGER.split('\n').find((line) => line.startsWith('- [clinic-booking]'))!
    for (const typo of [
      stam.replace('] Owner:', ']Owner:'),
      stam.replace('- [clinic-booking]', '* [clinic-booking]'),
      stam.replace('Status: open;', 'Status: ;'),
      stam.replace('Status: open;', 'Status: open (waiting on Stam);'),
    ]) {
      const read = parseLedger(LEDGER.replace(stam, typo))
      expect(read.items.some((item) => item.id === 'clinic-booking')).toBe(false)
      expect(read.skipped.map((entry) => entry.id)).toContain('clinic-booking')
      const plan = planSync(read, [reminder('R1', 'clinic-booking')], {
        tracked: { 'clinic-booking': tracked('R1', 'Book the diagnosis', '2026-11-03') },
        closed: {},
      }, NOW)
      expect(plan.steps.filter((step) => step.id === 'clinic-booking')).toEqual([])
    }
  })

  it('refuses a torn or emptied read rather than reading every loop as closed', () => {
    expect(() => parseLedger(LEDGER.slice(0, LEDGER.indexOf('## Suppressed')))).toThrow(/no active section/)
    expect(() => parseLedger('')).toThrow(/no active section/)
  })

  it('makes a short title from the Next action', () => {
    expect(reminderTitle('Book the diagnosis at Example Clinic (due 20 Oct); the user 2026-09-30: not booked yet'))
      .toBe('Book the diagnosis at Example Clinic')
    expect(reminderTitle('Wait for Jordan Example (Acme) to reschedule the intro call they cancelled on 1 Oct 09:15 because they are unwell'))
      .toBe('Wait for Jordan Example to reschedule the intro call they cancelled on 1 Oct…')
  })

  it('reads the ledger id from the first line of the notes only', () => {
    expect(noteId('clinic-booking')).toBe('clinic-booking')
    expect(noteId(' [clinic-booking] \nbelde ze maandag')).toBe('clinic-booking')
    expect(noteId('bel eerst')).toBeUndefined()
    expect(noteId(undefined)).toBeUndefined()
  })

  it('moves a completed line to the end of Suppressed, keeping its identity and markers', () => {
    const edit = closeItem(LEDGER, 'clinic-booking', { how: 'completed', at: '2026-10-02T11:45' })
    if (edit.outcome !== 'edited') throw new Error(edit.outcome)
    expect(edit.line).toBe(
      '- [clinic-booking] Owner: the user; Next: none. Was: Book the diagnosis at Example Clinic (due 20 Oct); the user 2026-09-30: not booked yet; ' +
      'Source: Reminders list Open loops, completed 2026-10-02 11:45; 29 Sep daily; History: none; ' +
      'Checked: 2026-10-02 (Reminders, completed by the user); Status: closed; Deadline: 2026-11-03; Reminder: none; Deadline notice: none.')
    const lines = edit.content.split('\n')
    expect(lines.filter((line) => line.startsWith('- [clinic-booking]'))).toEqual([edit.line])
    expect(lines.indexOf(edit.line)).toBe(lines.findIndex((line) => line.startsWith('- [guest-invite]')) + 1)
    expect(edit.content.replace(`${edit.line}\n`, '')).toBe(LEDGER.replace(`${edit.previous}\n`, ''))
  })

  it('says a deleted reminder was deleted, not completed', () => {
    const edit = closeItem(LEDGER, 'application-status', { how: 'deleted', at: '2026-10-02T12:00' })
    expect(edit.outcome === 'edited' && edit.line).toContain('Checked: 2026-10-02 (Reminders, deleted by the user); Status: closed')
  })

  it('leaves a line alone that it cannot read or that already moved', () => {
    expect(closeItem(LEDGER, 'broken', { how: 'completed', at: '2026-10-02T11:45' }).outcome).toBe('skipped')
    expect(closeItem(LEDGER, 'guest-invite', { how: 'completed', at: '2026-10-02T11:45' }).outcome).toBe('gone')
  })

  it('brings a closed line back only while its Suppressed line is untouched', () => {
    const closed = closeItem(LEDGER, 'clinic-booking', { how: 'completed', at: '2026-10-02T11:45' })
    if (closed.outcome !== 'edited') throw new Error(closed.outcome)
    const reopened = reopenItem(closed.content, 'clinic-booking', closed.line, closed.previous)
    expect(reopened.outcome === 'edited' && parseLedger(reopened.content).items.find((item) => item.id === 'clinic-booking')?.active).toBe(true)
    const touched = closed.content.replace(closed.line, `${closed.line} Dream compacted this.`)
    expect(reopenItem(touched, 'clinic-booking', closed.line, closed.previous).outcome).toBe('skipped')
  })
})

describe('the concurrent-edit guard', () => {
  it('redoes the edit on the fresh file when another writer lands in between', async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), 'open-loops-')), 'open-loops.md')
    await writeFile(file, LEDGER)
    const concurrent = '- [new-loop] Owner: the user; Next: Added by dream meanwhile; Source: x; Checked: 2026-10-02; Status: open; Deadline: unconfirmed.'
    let calls = 0
    const result = await editLedger(file, (content) => {
      calls += 1
      // The first pass is overtaken: dream adds a line before this write lands.
      if (calls === 1) void writeFile(file, LEDGER.replace('- [old-done]', `${concurrent}\n- [old-done]`))
      const edit = closeItem(content, 'clinic-booking', { how: 'completed', at: '2026-10-02T11:45' })
      return edit.outcome === 'edited' ? edit.content : content
    })
    expect(result).toBe('written')
    expect(calls).toBe(2)
    const written = parseLedger(await readFile(file, 'utf8'))
    expect(written.items.map((item) => item.id)).toEqual(['application-status', 'new-loop', 'old-done'])
    expect(written.suppressed).toEqual(new Set(['guest-invite', 'clinic-booking']))
  })

  it('keeps a write that lands while its own result is being staged', async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), 'open-loops-')), 'open-loops.md')
    await writeFile(file, LEDGER)
    const concurrent = LEDGER.replace('Next: Verify the status check', 'Next: Verify it with Huxley')
    race.during = () => writeFile(file, concurrent)
    const result = await editLedger(file, (content) => {
      const edit = closeItem(content, 'clinic-booking', { how: 'completed', at: '2026-10-02T11:45' })
      return edit.outcome === 'edited' ? edit.content : content
    })
    expect(result).toBe('written')
    const written = await readFile(file, 'utf8')
    expect(written).toContain('Next: Verify it with Huxley')
    expect(parseLedger(written).suppressed.has('clinic-booking')).toBe(true)
    expect((await readdir(path.dirname(file))).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })
})

describe('planning a sync', () => {
  const ledger = parseLedger(LEDGER)
  const state = (tracked: SyncState['tracked'] = {}): SyncState => ({ tracked, closed: {} })

  it('creates a reminder for each active line without one, due on a confirmed deadline', () => {
    const plan = planSync(ledger, [], state(), NOW)
    expect(plan.steps).toEqual([
      { kind: 'create', id: 'clinic-booking', title: 'Book the diagnosis at Example Clinic', next: ledger.items[0]!.next, deadline: '2026-11-03', checked: '2026-09-30' },
      {
        kind: 'create', id: 'application-status', title: 'Verify the status check', next: 'Verify the status check', deadline: null,
        checked: '2026-09-14 (historical only)',
      },
    ])
  })

  it('matches by the id in the notes only, keeps the oldest and completes the extras', () => {
    const plan = planSync(ledger, [
      reminder('R2', 'clinic-booking', { createdAt: '2026-10-01T09:00' }),
      reminder('R1', 'clinic-booking', { title: 'Diagnose boeken bij Example Clinic', due: { day: '2026-11-03' } }),
      reminder('R3', undefined, { title: 'Verify the status check' }),
    ], state(), NOW)
    expect(plan.state.tracked['clinic-booking']).toEqual(tracked('R1', ledger.items[0]!.next, '2026-11-03'))
    expect(plan.steps).toEqual([
      { kind: 'complete', id: 'clinic-booking', reminderId: 'R2', title: 'title R2', why: 'duplicate' },
      {
        kind: 'create', id: 'application-status', title: 'Verify the status check', next: 'Verify the status check', deadline: null,
        checked: '2026-09-14 (historical only)',
      },
    ])
    expect(plan.notes).toEqual([
      '[broken] left alone: the line has Status twice (line 12)',
      '"Verify the status check" has no ledger id in its notes; left alone',
    ])
  })

  it('follows the id in the notes when the stored reminder id is gone, keeping what was last written', () => {
    const plan = planSync(ledger, [
      reminder('R7', 'clinic-booking', { title: 'Book the diagnosis', due: { day: '2026-10-20' } }),
      reminder('R2', 'application-status'),
    ], state({
      'clinic-booking': tracked('R1', 'Book the diagnosis', '2026-10-20'),
      'application-status': tracked('R2', 'Verify the status check', null),
    }), NOW)
    expect(plan.steps).toEqual([
      { kind: 'retitle', id: 'clinic-booking', reminderId: 'R7', title: 'Book the diagnosis at Example Clinic', next: ledger.items[0]!.next },
      { kind: 'redue', id: 'clinic-booking', reminderId: 'R7', deadline: '2026-11-03' },
    ])
    expect(plan.state.tracked['clinic-booking']).toEqual(tracked('R7', 'Book the diagnosis', '2026-10-20'))
  })

  it('closes on a tick after the reminder was seen open, unless the line was checked again on that day or later', () => {
    const done = (completedAt: string) => [reminder('R1', 'clinic-booking', { completed: true, completedAt })]
    // Seen open with the line as it is: the tick is newer, even on the day of the check.
    expect(planSync(ledger, done('2026-09-30T08:36'), state({ 'clinic-booking': tracked('R1', ledger.items[0]!.next, '2026-11-03') }), NOW).steps)
      .toContainEqual({
        kind: 'close', id: 'clinic-booking', reminderId: 'R1', closure: { how: 'completed', at: '2026-09-30T08:36' },
        checked: '2026-09-30', completedAt: '2026-09-30T08:36',
      })
    // Checked again since it was seen open: only a tick on a later day still stands.
    const reopened = state({ 'clinic-booking': tracked('R1', ledger.items[0]!.next, '2026-11-03', '2026-09-20') })
    expect(planSync(ledger, done('2026-10-01T09:00'), reopened, NOW).steps.map((step) => step.kind)).toContain('close')
    for (const completedAt of ['2026-09-28T12:00', '2026-09-30T23:00']) {
      const plan = planSync(ledger, done(completedAt), reopened, NOW)
      expect(plan.steps.filter((step) => step.id === 'clinic-booking').map((step) => step.kind)).toEqual(['create'])
      expect(plan.state.tracked['clinic-booking']).toBeUndefined()
      expect(plan.notes).toContain(
        `"title R1" was completed ${completedAt.replace('T', ' ')}, not after [clinic-booking] was last checked (2026-09-30); left alone, the line gets a fresh reminder`)
    }
  })

  it('hands a superseded reminder\'s place to an open one carrying the id, keeping what was last written', () => {
    const plan = planSync(ledger, [
      reminder('R1', 'clinic-booking', { completed: true, completedAt: '2026-09-28T12:00' }),
      reminder('R7', 'clinic-booking', { title: 'Book the diagnosis', due: { day: '2026-11-03' } }),
      reminder('R2', 'application-status'),
    ], state({
      'clinic-booking': tracked('R1', 'Book the diagnosis', '2026-11-03', '2026-09-20'),
      'application-status': tracked('R2', 'Verify the status check', null, '2026-09-14 (historical only)'),
    }), NOW)
    expect(plan.steps).toEqual([
      { kind: 'retitle', id: 'clinic-booking', reminderId: 'R7', title: 'Book the diagnosis at Example Clinic', next: ledger.items[0]!.next },
    ])
    expect(plan.state.tracked['clinic-booking']).toEqual(tracked('R7', 'Book the diagnosis', '2026-11-03'))
  })

  it('remembers the Checked it last saw the reminder open with', () => {
    const plan = planSync(ledger, [reminder('R1', 'clinic-booking', { due: { day: '2026-11-03' } })],
      state({ 'clinic-booking': tracked('R1', ledger.items[0]!.next, '2026-11-03', '2026-09-20') }), NOW)
    expect(plan.state.tracked['clinic-booking']?.checked).toBe('2026-09-30')
  })

  it('stops trusting a stored reminder id once its notes lose the ledger id', () => {
    const plan = planSync(ledger, [
      reminder('R1', 'bel eerst', { completed: true, completedAt: '2026-10-02T11:45' }),
      reminder('R2', undefined),
    ], state({
      'clinic-booking': tracked('R1', ledger.items[0]!.next, '2026-11-03'),
      'application-status': tracked('R2', 'Verify the status check', null),
    }), NOW)
    expect(plan.steps.map((step) => step.kind)).toEqual(['create', 'create'])
    expect(plan.notes).toContain('"title R1" no longer has [clinic-booking] in its notes, so it no longer shows that line; left alone')
    expect(plan.state.tracked).toEqual({})
  })

  it('closes the line of a completed reminder, and checks a missing one before closing it', () => {
    const plan = planSync(ledger, [
      reminder('R1', 'clinic-booking', { completed: true, completedAt: '2026-10-02T08:36' }),
    ], state({
      'clinic-booking': tracked('R1', ledger.items[0]!.next, '2026-11-03'),
      'application-status': tracked('R9', 'Verify the status check', null),
    }), NOW)
    expect(plan.steps).toEqual([
      {
        kind: 'close', id: 'clinic-booking', reminderId: 'R1', closure: { how: 'completed', at: '2026-10-02T08:36' },
        checked: '2026-09-30', completedAt: '2026-10-02T08:36',
      },
      { kind: 'missing', id: 'application-status', reminderId: 'R9' },
    ])
  })

  it('retitles on a changed Next and moves the due date with the deadline, not with the title', () => {
    const plan = planSync(ledger, [
      reminder('R1', 'clinic-booking', { title: 'Renamed by the user' }),
      reminder('R2', 'application-status'),
    ], state({
      'clinic-booking': tracked('R1', 'Book the diagnosis', '2026-10-20'),
      'application-status': tracked('R2', 'Verify the status check', null),
    }), NOW)
    expect(plan.steps).toEqual([
      { kind: 'retitle', id: 'clinic-booking', reminderId: 'R1', title: 'Book the diagnosis at Example Clinic', next: ledger.items[0]!.next },
      { kind: 'redue', id: 'clinic-booking', reminderId: 'R1', deadline: '2026-11-03' },
    ])
  })

  it('completes the reminder of a line that left, and leaves an unreadable line alone', () => {
    const plan = planSync(ledger, [
      reminder('R1', 'clinic-booking'),
      reminder('R2', 'application-status'),
      reminder('R5', 'old-done'),
      reminder('R6', 'broken'),
    ], state({
      'clinic-booking': tracked('R1', ledger.items[0]!.next, '2026-11-03'),
      'application-status': tracked('R2', 'Verify the status check', null),
      'old-done': tracked('R5', 'Already finished', null),
      broken: tracked('R6', 'Has two statuses', null),
    }), NOW)
    expect(plan.steps).toEqual([{ kind: 'complete', id: 'old-done', reminderId: 'R5', title: 'title R5', why: 'left' }])
    expect(plan.state.tracked.broken).toEqual(tracked('R6', 'Has two statuses', null))
  })

  it('on the first run adopts a completed reminder; later a reopened line gets a fresh one', () => {
    const done = reminder('R1', 'clinic-booking', { completed: true, completedAt: '2026-10-01T08:36' })
    expect(planSync(ledger, [done], undefined, NOW).steps[0]).toEqual(
      {
        kind: 'close', id: 'clinic-booking', reminderId: 'R1', closure: { how: 'completed', at: '2026-10-01T08:36' },
        checked: '2026-09-30', completedAt: '2026-10-01T08:36',
      })
    expect(planSync(ledger, [done], state(), NOW).steps[0]).toMatchObject({ kind: 'create', id: 'clinic-booking' })
  })

  it('on the first run leaves a completion alone that is not newer than the last check', () => {
    // clinic-booking was last checked 2026-09-30: a tick that day or before may predate a reopen.
    for (const completedAt of ['2026-09-20T10:00', '2026-09-30T23:00']) {
      const plan = planSync(ledger, [reminder('R1', 'clinic-booking', { completed: true, completedAt })], undefined, NOW)
      expect(plan.steps.filter((step) => step.id === 'clinic-booking').map((step) => step.kind)).toEqual(['create'])
      expect(plan.notes).toContain(
        `"title R1" was completed ${completedAt.replace('T', ' ')}, not after [clinic-booking] was last checked (2026-09-30); left alone, the line gets a fresh reminder`)
    }
  })
})

/** A RemindersSource stand-in over one in-memory list. */
function fakeSource(reminders: Reminder[]) {
  const writes: ReminderWrite[] = []
  return {
    writes,
    reminders,
    listContents: async () => ({ listId: 'OPEN-LOOPS', reminders: reminders.map((item) => ({ ...item })) }),
    find: async (id: string): Promise<Reminder | undefined> => reminders.find((item) => item.id === id),
    write: async (action: ReminderWrite) => {
      writes.push(action)
      if (action.kind === 'create') {
        const id = `NEW-${writes.length}`
        reminders.push(reminder(id, action.changes?.notes ?? undefined, { title: action.title }))
        return { createdId: id }
      }
      return {}
    },
  }
}

describe('a sync run', () => {
  async function setup(reminders: Reminder[]) {
    const dir = await mkdtemp(path.join(tmpdir(), 'open-loops-sync-'))
    const ledgerPath = path.join(dir, 'open-loops.md')
    const statePath = path.join(dir, 'state.json')
    await writeFile(ledgerPath, LEDGER)
    const source = fakeSource(reminders)
    const sync = new OpenLoopsSync({ source, ledgerPath, statePath, now: () => NOW, log: () => undefined })
    return { source, sync, ledgerPath, statePath }
  }

  it('reports in a dry run and writes nothing', async () => {
    const { source, sync, ledgerPath, statePath } = await setup([
      reminder('R1', 'clinic-booking', { completed: true, completedAt: '2026-10-01T08:36' }),
    ])
    const report = await sync.run({ dryRun: true })
    expect(report).toMatchObject({
      steps: [
        'move [clinic-booking] to Suppressed: its reminder was completed 2026-10-01 08:36',
        'create "Verify the status check" for [application-status]',
      ],
      wroteReminders: false,
    })
    expect(source.writes).toEqual([])
    expect(await readFile(ledgerPath, 'utf8')).toBe(LEDGER)
    await expect(readFile(statePath, 'utf8')).rejects.toThrow()
  })

  it('closes a ticked line, creates what is missing once, and brings the line back on un-tick', async () => {
    const { source, sync, ledgerPath } = await setup([reminder('R1', 'clinic-booking')])
    await sync.run()
    expect(source.writes).toEqual([
      { kind: 'update', id: 'R1', changes: { due: { day: '2026-11-03' } } },
      { kind: 'create', listId: 'OPEN-LOOPS', title: 'Verify the status check', changes: { notes: 'application-status' } },
    ])

    // A second run with nothing changed writes nothing: no duplicates.
    await sync.run()
    expect(source.writes).toHaveLength(2)

    // The user ticks it on their phone.
    Object.assign(source.reminders[0]!, { completed: true, completedAt: '2026-10-02T11:45' })
    await sync.run()
    const closed = parseLedger(await readFile(ledgerPath, 'utf8'))
    expect(closed.items.some((item) => item.id === 'clinic-booking')).toBe(false)
    expect(closed.suppressed.has('clinic-booking')).toBe(true)
    expect(source.writes).toHaveLength(2)

    // And un-ticks it again.
    Object.assign(source.reminders[0]!, { completed: false, completedAt: undefined })
    await sync.run()
    const reopened = await readFile(ledgerPath, 'utf8')
    const original = LEDGER.split('\n').find((line) => line.startsWith('- [clinic-booking]'))!
    expect(reopened.split('\n').filter((line) => line.startsWith('- [clinic-booking]'))).toEqual([original])
    expect(parseLedger(reopened).items.find((item) => item.id === 'clinic-booking')?.active).toBe(true)
    await sync.run()
    expect(source.writes).toHaveLength(2)
  })

  it('closes the line of a deleted reminder as deleted', async () => {
    const { source, sync, ledgerPath } = await setup([reminder('R1', 'clinic-booking'), reminder('R2', 'application-status')])
    await sync.run()
    source.reminders.splice(1, 1)
    await sync.run()
    expect(await readFile(ledgerPath, 'utf8')).toContain('Checked: 2026-10-02 (Reminders, deleted by the user)')
  })

  it('never takes a failed lookup, or a reminder that lost its id, for a deletion', async () => {
    const { source, sync, ledgerPath } = await setup([reminder('R1', 'clinic-booking'), reminder('R2', 'application-status')])
    await sync.run()
    const [moved] = source.reminders.splice(1, 1)

    source.find = async () => { throw new Error('Reminders cannot be read on this Mac right now.') }
    const unreadable = await sync.run()
    expect(unreadable).toMatchObject({ failures: [expect.stringContaining('Reminders cannot be read')] })
    expect(await readFile(ledgerPath, 'utf8')).toBe(LEDGER)

    source.find = async () => ({ ...moved!, notes: 'bel eerst', completed: true, completedAt: '2026-10-02T11:45' })
    await sync.run()
    expect(await readFile(ledgerPath, 'utf8')).toBe(LEDGER)
  })

  it('judges a tick again when the line is checked while Reminders is being read', async () => {
    const { source, sync, ledgerPath } = await setup([reminder('R1', 'clinic-booking'), reminder('R2', 'application-status')])
    await sync.run()
    Object.assign(source.reminders[0]!, { completed: true, completedAt: '2026-10-01T09:00' })
    const recheck = LEDGER.replace('Checked: 2026-09-30; Status: open', 'Checked: 2026-10-02 (The user asked to reopen); Status: open')
    const read = source.listContents
    source.listContents = async () => {
      await writeFile(ledgerPath, recheck)
      return read()
    }
    const report = await sync.run()
    expect(report).toMatchObject({ failures: [expect.stringContaining('checked again meanwhile')] })
    expect(await readFile(ledgerPath, 'utf8')).toBe(recheck)

    source.listContents = read
    expect(await sync.run()).toMatchObject({ steps: [expect.stringMatching(/^create .* for \[clinic-booking\]/)] })
    expect(await readFile(ledgerPath, 'utf8')).toBe(recheck)
  })

  it('does not let a looked-up completion or delete close a line checked again since it was seen', async () => {
    const recheck = LEDGER.replace('Checked: 2026-09-30; Status: open', 'Checked: 2026-10-02 (The user asked to reopen); Status: open')
    for (const lookup of ['completed 1 Oct', 'deleted'] as const) {
      const { source, sync, ledgerPath } = await setup([reminder('R1', 'clinic-booking'), reminder('R2', 'application-status')])
      await sync.run()
      const [gone] = source.reminders.splice(0, 1)
      await writeFile(ledgerPath, recheck)
      source.find = async () => lookup === 'deleted' ? undefined : { ...gone!, completed: true, completedAt: '2026-10-01T09:00' }
      const report = await sync.run()
      expect(report).toMatchObject({ steps: [expect.stringMatching(/^create .* for \[clinic-booking\]/)] })
      expect(await readFile(ledgerPath, 'utf8')).toBe(recheck)
    }
  })

  it('completes a duplicate once and keeps tracking the line\'s own reminder', async () => {
    const { source, sync } = await setup([
      reminder('R1', 'clinic-booking', { due: { day: '2026-11-03' } }),
      reminder('R2', 'clinic-booking', { createdAt: '2026-10-01T09:00' }),
      reminder('R3', 'application-status'),
    ])
    await sync.run()
    expect(source.writes).toEqual([{ kind: 'complete', id: 'R2' }])
    Object.assign(source.reminders[1]!, { completed: true, completedAt: '2026-10-02T12:00' })
    await sync.run()
    expect(source.writes).toHaveLength(1)
  })
})
