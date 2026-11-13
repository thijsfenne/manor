import { afterEach, describe, expect, it, vi } from 'vitest'
import { ROUTINE_LEASE_MS } from '@manor/contracts'
import { checkRoutineDraft } from '../src/store.js'
import { createMemoryStore } from '../src/stores/memoryStore.js'
import { roster, seededChat } from './helpers.js'

const AT = (iso: string) => new Date(iso).getTime()

/**
 * The routine half of the store, against the memory implementation.
 *
 * The rules asserted here are the ones `20260815090000_routines.sql` holds as check
 * constraints and foreign keys. They live in a test because the memory store has to
 * be a fair stand-in for Postgres rather than a laxer one: a rule only the database
 * enforces is a rule the whole suite runs without.
 */
async function house(now = '2026-08-14T09:00:00Z') {
  vi.useFakeTimers()
  vi.setSystemTime(AT(now))
  const store = createMemoryStore({ agents: roster })
  const { projectId } = await seededChat(store)
  return { store, projectId }
}

/**
 * Claims a routine and writes one finished run, which is the only sequence that
 * exists in production: `recordRoutineRun` is fenced on the lease the claim took, so
 * a test that recorded a run on an unclaimed row would be exercising a path the
 * scheduler cannot reach.
 */
async function ran(
  store: Awaited<ReturnType<typeof house>>['store'],
  routineId: string,
  at: number,
  record: { consecutiveFailures: number; disabled: boolean; disabledReason: string | null; contextTokens?: number | null },
) {
  const claimed = await store.claimRoutine(routineId, at)
  if (claimed === undefined) throw new Error('the test could not claim the routine')
  return store.recordRoutineRun(routineId, {
    lastRunAt: at,
    contextTokens: null,
    ...record,
    lease: claimed.lease,
  })
}

const draft = (projectId: string) => ({
  projectId,
  chatId: null,
  agentId: 'sage',
  name: 'Morning brief',
  description: 'Summarises what changed overnight.',
  prompt: 'What changed overnight?',
  cron: '0 7 * * *',
  timezone: 'Europe/Amsterdam',
  enabled: true,
  notify: false,
  model: null,
  effort: null,
})

describe('checkRoutineDraft', () => {
  it('names the rule it broke, one rule at a time', () => {
    const base = draft('project_1')
    expect(() => checkRoutineDraft({ ...base, name: '   ' }, 0)).toThrow('a routine needs a name')
    expect(() => checkRoutineDraft({ ...base, description: 'x'.repeat(501) }, 0)).toThrow(
      'description can be at most 500 characters',
    )
    expect(() => checkRoutineDraft({ ...base, prompt: '' }, 0)).toThrow('a routine needs a prompt')
    expect(() => checkRoutineDraft({ ...base, cron: 'every tuesday' }, 0)).toThrow('not a cron expression')
  })

  it('arms an enabled routine and leaves a disabled one with no fire time', () => {
    const base = draft('project_1')
    const at = AT('2026-08-14T09:00:00Z')
    expect(checkRoutineDraft(base, at).nextRunAt).toBe(AT('2026-08-15T05:00:00Z'))
    // The `routines_disabled_has_no_next_run` constraint: a disabled row carrying a
    // fire time is a row the claim could still take.
    expect(checkRoutineDraft({ ...base, enabled: false }, at).nextRunAt).toBeNull()
  })
})

describe('memoryStore, routines', () => {
  afterEach(() => void vi.useRealTimers())

  it('creates without an id, updates with one, and never doubles a routine', async () => {
    const { store, projectId } = await house()

    const created = await store.saveRoutine(draft(projectId))
    expect(created).toMatchObject({
      projectId,
      agentId: 'sage',
      name: 'Morning brief',
      description: 'Summarises what changed overnight.',
      enabled: true,
      nextRunAt: AT('2026-08-15T05:00:00Z'),
      lastRunAt: null,
      lastSkippedAt: null,
      consecutiveFailures: 0,
      disabledReason: null,
      // Nothing holds a routine that has never run, and nothing is known about what
      // it costs. Both are what the claim and the row read.
      runningSince: null,
      lastContextTokens: null,
    })

    const updated = await store.saveRoutine({ ...draft(projectId), id: created.id, name: 'Morning briefing' })

    expect(updated.id).toBe(created.id)
    expect(updated.createdAt).toBe(created.createdAt)
    expect((await store.listRoutines()).map((routine) => routine.name)).toEqual(['Morning briefing'])
  })

  it('recomputes the fire time when the cron moves, so the old hour never runs once more', async () => {
    const { store, projectId } = await house()
    const created = await store.saveRoutine(draft(projectId))

    const moved = await store.saveRoutine({ ...draft(projectId), id: created.id, cron: '0 9 * * *' })

    expect(moved.nextRunAt).toBe(AT('2026-08-15T07:00:00Z'))
  })

  it('keeps the run history across an edit, because a save is not a verdict on it', async () => {
    const { store, projectId } = await house()
    const created = await store.saveRoutine(draft(projectId))
    const at = AT('2026-08-15T05:00:00Z')
    await ran(store, created.id, at, { consecutiveFailures: 2, disabled: false, disabledReason: null })

    const edited = await store.saveRoutine({ ...draft(projectId), id: created.id, prompt: 'What broke overnight?' })

    expect(edited).toMatchObject({ consecutiveFailures: 2, lastRunAt: at })
  })

  it('refuses what the database refuses: both keys, both non-empty rules, the cron', async () => {
    const { store, projectId } = await house()

    await expect(store.saveRoutine({ ...draft(projectId), projectId: 'project_gone' })).rejects.toThrow(
      'unknown project',
    )
    await expect(store.saveRoutine({ ...draft(projectId), agentId: 'nobody' })).rejects.toThrow('unknown agent')
    await expect(store.saveRoutine({ ...draft(projectId), name: ' ' })).rejects.toThrow('needs a name')
    await expect(store.saveRoutine({ ...draft(projectId), prompt: '' })).rejects.toThrow('needs a prompt')
    await expect(store.saveRoutine({ ...draft(projectId), cron: 'hourly-ish' })).rejects.toThrow('not a cron expression')
    // An update naming an id nobody holds is a throw, not a second routine.
    await expect(store.saveRoutine({ ...draft(projectId), id: 'routine_gone' })).rejects.toThrow('unknown routine')
    expect(await store.listRoutines()).toEqual([])
  })

  it('owns its runs: deleting a routine takes their threads, and deleting one takes nothing', async () => {
    const { store, projectId } = await house()
    const created = await store.saveRoutine(draft(projectId))
    const first = await store.createChat({ projectId, kind: 'run', routineId: created.id, title: 'Morning brief' })
    const second = await store.createChat({ projectId, kind: 'run', routineId: created.id, title: 'Morning brief' })

    // The direction that does *not* cascade, and the reason the foreign key was
    // turned around: tidying one thread away must not destroy the routine.
    await store.deleteChat(first.id)
    expect((await store.listRoutines()).map((routine) => routine.id)).toEqual([created.id])
    expect((await store.listRuns(created.id)).map((run) => run.id)).toEqual([second.id])

    await store.deleteRoutine(created.id)
    expect(await store.listRuns(created.id)).toEqual([])
    expect(await store.getChat(second.id)).toBeUndefined()
  })

  it('keeps run execution order when an older thread gets a newer reply', async () => {
    const { store, projectId } = await house('2026-08-15T05:00:00Z')
    const created = await store.saveRoutine(draft(projectId))
    const older = await store.createChat({ projectId, kind: 'run', routineId: created.id })
    vi.setSystemTime(AT('2026-08-16T05:00:00Z'))
    const newer = await store.createChat({ projectId, kind: 'run', routineId: created.id })
    vi.setSystemTime(AT('2026-08-17T05:00:00Z'))
    await store.appendEvent(older.id, { type: 'user_message', text: 'Follow-up', mentions: [] })

    expect((await store.listRuns(created.id)).map((run) => run.id)).toEqual([newer.id, older.id])
  })

  it('cascades from a deleted persona, taking the routine and its runs', async () => {
    const { store, projectId } = await house()
    const created = await store.saveRoutine({ ...draft(projectId), agentId: 'smith', name: 'Nightly sweep' })
    const run = await store.createChat({ projectId, kind: 'run', routineId: created.id, title: 'Nightly sweep' })

    await store.deleteAgent('smith')

    expect(await store.listRoutines()).toEqual([])
    expect(await store.getChat(run.id)).toBeUndefined()
  })

  it('clears the fire time when a routine goes off and recomputes it when it comes back', async () => {
    const { store, projectId } = await house()
    const created = await store.saveRoutine(draft(projectId))

    const off = await store.setRoutineEnabled(created.id, false)
    expect(off).toMatchObject({ enabled: false, nextRunAt: null })

    vi.setSystemTime(AT('2026-08-20T12:00:00Z'))
    const on = await store.setRoutineEnabled(created.id, true)
    expect(on).toMatchObject({ enabled: true, nextRunAt: AT('2026-08-21T05:00:00Z') })
  })

  it('starts a self-disabled routine over when it is turned back on', async () => {
    const { store, projectId } = await house()
    const created = await store.saveRoutine(draft(projectId))
    await ran(store, created.id, AT('2026-08-15T05:00:00Z'), {
      consecutiveFailures: 3,
      disabled: true,
      disabledReason: 'three runs in a row ended without an answer',
    })

    const back = await store.setRoutineEnabled(created.id, true)

    // Kept, the count would leave the routine one failure past a limit it can no
    // longer reach, which is a routine that never self-disables again.
    expect(back).toMatchObject({ consecutiveFailures: 0, disabledReason: null, enabled: true })
  })

  it('answers with nothing for a routine that is gone, rather than throwing', async () => {
    const { store } = await house()

    expect(await store.setRoutineEnabled('routine_gone', true)).toBeUndefined()
    expect(await store.recordRoutineSkip('routine_gone', Date.now(), Date.now())).toBeUndefined()
    expect(await store.claimRoutine('routine_gone', Date.now())).toBeUndefined()
    await expect(store.deleteRoutine('routine_gone')).resolves.toBeUndefined()
  })

  it('claims a due row exactly once and hands back the slot it took', async () => {
    const { store, projectId } = await house()
    const created = await store.saveRoutine(draft(projectId))
    const now = AT('2026-08-15T05:30:00Z')

    const claimed = await store.claimDueRoutine(now)

    expect(claimed?.dueAt).toBe(AT('2026-08-15T05:00:00Z'))
    // The row that comes back is the one after the claim: its fire time is the next
    // one, which is what makes a second claim find nothing.
    expect(claimed?.routine.nextRunAt).toBe(AT('2026-08-16T05:00:00Z'))
    expect(await store.claimDueRoutine(now)).toBeUndefined()
    expect((await store.listRoutines())[0]?.id).toBe(created.id)
  })

  it('refuses a second claim while the first run is still in flight', async () => {
    const { store, projectId } = await house()
    // Hourly, so the next slot arrives while the first run's lease is still live and
    // a tick gets the chance to double up that a daily routine would not.
    const created = await store.saveRoutine({ ...draft(projectId), cron: '0 * * * *' })
    const now = AT('2026-08-14T09:30:00Z')

    const first = await store.claimRoutine(created.id, now)

    expect(first?.routine.runningSince).toBe(now)
    expect(first?.routine.nextRunAt).toBe(AT('2026-08-14T10:00:00Z'))
    // The rolled fire time is not the guard: a second hand run reads that fresh
    // value and would claim it just as happily. The lease is what refuses it, which
    // is the whole of "two clicks on Run now buy one turn".
    expect(await store.claimRoutine(created.id, now + 1_000)).toBeUndefined()
    // And the tick that comes round on the next slot loses to the same lease, rather
    // than starting a second turn beside the one still talking.
    expect(await store.claimDueRoutine(AT('2026-08-14T10:00:00Z'))).toBeUndefined()
  })

  it('lets go of a lease its process never will, and releases one at the end of a run', async () => {
    const { store, projectId } = await house()
    const created = await store.saveRoutine(draft(projectId))
    const now = AT('2026-08-15T05:30:00Z')
    await store.claimRoutine(created.id, now)

    // A server killed mid-turn cannot clear its own lease. Without the expiry this
    // routine would be locked out of every future run by a turn that is not happening.
    expect(await store.claimRoutine(created.id, now + ROUTINE_LEASE_MS - 1)).toBeUndefined()
    const stale = await store.claimRoutine(created.id, now + ROUTINE_LEASE_MS)
    expect(stale?.routine.runningSince).toBe(now + ROUTINE_LEASE_MS)

    const done = await store.recordRoutineRun(created.id, {
      lastRunAt: now,
      consecutiveFailures: 0,
      disabled: false,
      disabledReason: null,
      contextTokens: 180_000,
      lease: stale!.lease,
    })
    expect(done).toMatchObject({ runningSince: null, lastContextTokens: 180_000 })

    // A skip claimed the row too, so it hands the lease back the same way.
    const skipping = await store.claimRoutine(created.id, now)
    expect(await store.recordRoutineSkip(created.id, now, skipping!.lease)).toMatchObject({
      runningSince: null,
    })
  })

  it('refuses a run whose lease was taken over, so a straggler cannot free the new one', async () => {
    const { store, projectId } = await house()
    const created = await store.saveRoutine(draft(projectId))
    const now = AT('2026-08-15T05:30:00Z')
    const first = await store.claimRoutine(created.id, now)
    // The first worker stalls past its lease; a second takes the row over.
    const second = await store.claimRoutine(created.id, now + ROUTINE_LEASE_MS)

    // The straggler comes back. It writes nothing at all — not its own bookkeeping,
    // and above all not the `runningSince: null` that would hand a third caller a
    // routine the second worker is still running.
    const late = await store.recordRoutineRun(created.id, {
      lastRunAt: now,
      consecutiveFailures: 2,
      disabled: false,
      disabledReason: null,
      contextTokens: null,
      lease: first!.lease,
    })

    expect(late).toBeUndefined()
    expect(await store.recordRoutineSkip(created.id, now, first!.lease)).toBeUndefined()
    const held = (await store.listRoutines()).find((routine) => routine.id === created.id)
    expect(held).toMatchObject({ runningSince: second!.lease, consecutiveFailures: 0 })
  })

  it('leaves a routine switched off mid-run switched off when the run lands', async () => {
    const { store, projectId } = await house()
    const created = await store.saveRoutine(draft(projectId))
    const now = AT('2026-08-15T05:30:00Z')
    const claimed = await store.claimRoutine(created.id, now)
    // The user flicks it off while the turn is still talking.
    await store.setRoutineEnabled(created.id, false)

    const done = await store.recordRoutineRun(created.id, {
      lastRunAt: now,
      consecutiveFailures: 0,
      disabled: false,
      disabledReason: null,
      contextTokens: null,
      lease: claimed!.lease,
    })

    // Writing `enabled` from what the run read before the turn would turn it back on
    // behind the user, and with no fire time to run by: on in the list, silent forever.
    expect(done).toMatchObject({ enabled: false, nextRunAt: null })
  })

  it('never claims a disabled routine, by either door', async () => {
    const { store, projectId } = await house()
    const created = await store.saveRoutine(draft(projectId))
    await store.setRoutineEnabled(created.id, false)
    const now = AT('2026-08-16T05:30:00Z')

    expect(await store.claimDueRoutine(now)).toBeUndefined()
    expect(await store.claimRoutine(created.id, now)).toBeUndefined()
  })

  it('takes the oldest due routine first when several are waiting', async () => {
    const { store, projectId } = await house()
    await store.saveRoutine({ ...draft(projectId), name: 'Nine', cron: '0 9 * * *' })
    await store.saveRoutine({ ...draft(projectId), name: 'Seven', cron: '0 7 * * *' })

    const claimed = await store.claimDueRoutine(AT('2026-08-15T08:00:00Z'))

    expect(claimed?.routine.name).toBe('Seven')
  })

  it('holds the disabled-has-no-fire-time rule when a run turns a routine off', async () => {
    const { store, projectId } = await house()
    const created = await store.saveRoutine(draft(projectId))

    const off = await ran(store, created.id, AT('2026-08-15T05:00:00Z'), {
      consecutiveFailures: 3,
      disabled: true,
      disabledReason: 'three runs in a row ended without an answer',
    })

    expect(off).toMatchObject({ enabled: false, nextRunAt: null })
  })

  it('lists newest first, which is the order the Routines view draws', async () => {
    const { store, projectId } = await house()
    const first = await store.saveRoutine({ ...draft(projectId), name: 'First' })
    vi.setSystemTime(AT('2026-08-14T10:00:00Z'))
    const second = await store.saveRoutine({ ...draft(projectId), name: 'Second' })

    expect((await store.listRoutines()).map((routine) => routine.id)).toEqual([second.id, first.id])
  })
})
