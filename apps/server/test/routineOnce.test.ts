import { ROUTINE_LEASE_MS, type Routine } from '@manor/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { routineDidNotFinish } from '../src/composer.js'
import { RoutineModule } from '../src/routineModule.js'
import { dmRoutineHistory } from '../src/routineHistory.js'
import { ENDED_ROUTINE_KEEP_MS, purgeEndedRoutines, recoverFinishedRoutines, runRoutineNow, tickRoutines } from '../src/routineScheduler.js'
import { parseMoment } from '../src/routineTool.js'
import type { Store } from '../src/store.js'
import { createMemoryStore } from '../src/stores/memoryStore.js'
import { roster } from './helpers.js'

/**
 * One-time reminders and checks (`.claude/plans/2026-09-27-once-routines.md`): a
 * routine with `runAt` fires at most once, ends in a visible state, and survives a
 * sleeping Mac by firing late or expiring out loud.
 */

const AT = (iso: string) => new Date(iso).getTime()

async function dmHouse(now: string) {
  vi.useFakeTimers()
  vi.setSystemTime(AT(now))
  const store = createMemoryStore({ agents: roster })
  const dm = await store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })
  return { store, dm }
}

const once = (store: Store, chatId: string, runAt: string, extra: Partial<Parameters<Store['saveRoutine']>[0]> = {}) =>
  store.saveRoutine({
    projectId: null,
    chatId,
    agentId: 'sage',
    name: 'Reply check',
    prompt: 'Check whether the landlord replied.',
    cron: '',
    timezone: 'Europe/Amsterdam',
    runAt: AT(runAt),
    enabled: true,
    notify: true,
    model: null,
    effort: null,
    ...extra,
  })

const prompt = (routine: Routine) => ({
  type: 'user_message' as const,
  text: routine.prompt,
  mentions: [],
  source: 'routine' as const,
  routineId: routine.id,
  routineName: routine.name,
})

/** The persona published a result, the way a finished DM routine turn lands. */
const publishing = (store: Store, runs: Routine[] = []) => async (routine: Routine, chatId: string) => {
  runs.push(routine)
  await store.appendEvent(chatId, prompt(routine))
  await store.appendEvent(chatId, { type: 'agent_message', agentId: 'sage', turnId: 't1', text: 'No reply yet.' })
  await store.appendEvent(chatId, { type: 'turn_result', agentId: 'sage', turnId: 't1', routineOutcome: 'publish' })
}

const routineOf = async (store: Store, id: string) => (await store.listRoutines()).find((entry) => entry.id === id)

describe('a one-time routine', () => {
  afterEach(() => void vi.useRealTimers())

  it('is scheduled for its own moment with no cron, and refuses a moment already past', async () => {
    const { store, dm } = await dmHouse('2026-09-27T20:00:00Z')
    const routine = await once(store, dm.id, '2026-09-28T08:00:00Z')

    expect(routine).toMatchObject({ cron: '', runAt: AT('2026-09-28T08:00:00Z'), nextRunAt: AT('2026-09-28T08:00:00Z'), endState: null })
    await expect(once(store, dm.id, '2026-09-27T19:00:00Z')).rejects.toThrow(/already passed/)
    await expect(store.saveRoutine({
      projectId: (await store.listProjects())[0]!.id, chatId: null, agentId: 'sage', name: 'R', prompt: 'P',
      cron: '', timezone: 'Europe/Amsterdam', runAt: AT('2026-09-28T08:00:00Z'), action: 'remind',
      enabled: true, notify: true, model: null, effort: null,
    })).rejects.toThrow(/DM target/)
  })

  it('fires once at its moment, ends done, and cannot be claimed again by a tick or Run now', async () => {
    const { store, dm } = await dmHouse('2026-09-28T07:59:00Z')
    const routine = await once(store, dm.id, '2026-09-28T08:00:00Z')
    const runs: Routine[] = []
    const runTurn = publishing(store, runs)

    expect((await tickRoutines({ store, runTurn, now: AT('2026-09-28T07:59:30Z') })).kind).toBe('idle')
    const fired = await tickRoutines({ store, runTurn, now: AT('2026-09-28T08:00:10Z') })
    expect(fired).toMatchObject({ kind: 'ran', ok: true })
    expect(await routineOf(store, routine.id)).toMatchObject({
      endState: 'done', enabled: false, nextRunAt: null, runningSince: null,
    })

    expect((await tickRoutines({ store, runTurn, now: AT('2026-09-28T09:00:00Z') })).kind).toBe('idle')
    expect((await runRoutineNow({ store, runTurn, routineId: routine.id })).kind).toBe('idle')
    expect(runs).toHaveLength(1)
  })

  it('runs exactly once when two schedulers tick on it together', async () => {
    const { store, dm } = await dmHouse('2026-09-28T08:00:00Z')
    await once(store, dm.id, '2026-09-28T08:00:01Z')
    const runs: Routine[] = []
    const runTurn = publishing(store, runs)
    const now = AT('2026-09-28T08:00:30Z')

    const ticks = await Promise.all([tickRoutines({ store, runTurn, now }), tickRoutines({ store, runTurn, now })])

    expect(ticks.map((tick) => tick.kind).sort()).toEqual(['idle', 'ran'])
    expect(runs).toHaveLength(1)
  })

  it.each([
    ['no answer at all', async (store: Store, routine: Routine, chatId: string) => {
      await store.appendEvent(chatId, prompt(routine))
    }],
    ['a quiet outcome', async (store: Store, routine: Routine, chatId: string) => {
      await store.appendEvent(chatId, prompt(routine))
      await store.appendEvent(chatId, { type: 'turn_result', agentId: 'sage', turnId: 't1', routineOutcome: 'quiet' })
    }],
    ['the one-bubble failure beside a result', async (store: Store, routine: Routine, chatId: string) => {
      await store.appendEvent(chatId, prompt(routine))
      await store.appendEvent(chatId, { type: 'agent_message', agentId: 'sage', turnId: 't1', text: routineDidNotFinish(routine.name) })
      await store.appendEvent(chatId, { type: 'turn_result', agentId: 'sage', turnId: 't1', routineOutcome: 'publish' })
    }],
    ['an incomplete check', async (store: Store, routine: Routine, chatId: string) => {
      await store.appendEvent(chatId, prompt(routine))
      await store.appendEvent(chatId, { type: 'agent_message', agentId: 'sage', turnId: 't1', text: 'Gmail would not load.' })
      await store.appendEvent(chatId, { type: 'turn_result', agentId: 'sage', turnId: 't1', routineOutcome: 'publish', routineIncomplete: true })
    }],
  ])('ends failed, never done, on %s', async (_label, run) => {
    const { store, dm } = await dmHouse('2026-09-28T07:59:00Z')
    const routine = await once(store, dm.id, '2026-09-28T08:00:00Z')

    const tick = await tickRoutines({ store, runTurn: (entry, chatId) => run(store, entry, chatId), now: AT('2026-09-28T08:00:10Z') })

    expect(tick).toMatchObject({ kind: 'ran', ok: false, disabled: false })
    expect(await routineOf(store, routine.id)).toMatchObject({ endState: 'failed', enabled: false, nextRunAt: null, consecutiveFailures: 0 })
  })

  it('announces its end past the notice floor with notify on, and not at all with it off', async () => {
    const { store, dm } = await dmHouse('2026-09-28T07:59:00Z')
    await once(store, dm.id, '2026-09-28T08:00:00Z')
    await once(store, dm.id, '2026-09-28T08:01:00Z', { name: 'Silent check', notify: false })
    const finished: boolean[] = []
    const onRunFinished = (_chat: unknown, _startedAt: number, alert: boolean) => void finished.push(alert)

    await tickRoutines({ store, runTurn: publishing(store), now: AT('2026-09-28T08:00:10Z'), onRunFinished })
    await tickRoutines({ store, runTurn: publishing(store), now: AT('2026-09-28T08:01:10Z'), onRunFinished })

    expect(finished).toEqual([true])
  })

  it('refuses a new moment while it runs, so the finishing run cannot end the new schedule', async () => {
    const { store, dm } = await dmHouse('2026-09-28T07:59:00Z')
    const routine = await once(store, dm.id, '2026-09-28T08:00:00Z')
    const moved = { ...routine, runAt: AT('2026-09-29T08:00:00Z') }
    let refusal: unknown

    await tickRoutines({
      store,
      now: AT('2026-09-28T08:00:10Z'),
      runTurn: async (fired, chatId) => {
        refusal = await store.saveRoutine(moved).catch((error: unknown) => error)
        await publishing(store)(fired, chatId)
      },
    })

    expect(String(refusal)).toMatch(/running right now/)
    expect(await routineOf(store, routine.id)).toMatchObject({ endState: 'done', nextRunAt: null })
    expect(await store.saveRoutine(moved)).toMatchObject({ endState: null, nextRunAt: AT('2026-09-29T08:00:00Z') })
  })

  it('keeps refusing a new moment after the lease expired, until the stalled run or recovery lets go', async () => {
    const { store, dm } = await dmHouse('2026-09-28T07:59:00Z')
    const routine = await once(store, dm.id, '2026-09-28T08:00:00Z')
    const moved = { ...routine, runAt: AT('2026-09-29T08:00:00Z') }
    const refusals: unknown[] = []

    await tickRoutines({
      store,
      now: AT('2026-09-28T08:00:10Z'),
      runTurn: async (fired, chatId) => {
        vi.setSystemTime(AT('2026-09-28T08:00:10Z') + ROUTINE_LEASE_MS + 60_000)
        refusals.push(await store.saveRoutine(moved).catch((error: unknown) => error))
        refusals.push(await store.cancelRoutine(routine.id, Date.now()).catch((error: unknown) => error))
        await publishing(store)(fired, chatId)
      },
    })

    expect(refusals.map(String)).toEqual([expect.stringMatching(/running right now/), expect.stringMatching(/running right now/)])
    expect(await routineOf(store, routine.id)).toMatchObject({ endState: 'done', runningSince: null })
    expect(await store.saveRoutine(moved)).toMatchObject({ endState: null, nextRunAt: AT('2026-09-29T08:00:00Z') })
  })

  it('ends expired, not failed, when its deadline passed while it waited behind another reply', async () => {
    const { store, dm } = await dmHouse('2026-09-28T07:59:00Z')
    const routine = await once(store, dm.id, '2026-09-28T08:00:00Z', { lateUntil: AT('2026-09-28T08:05:00Z') })

    const tick = await tickRoutines({
      store,
      now: AT('2026-09-28T08:00:10Z'),
      runTurn: async (fired, chatId) => {
        await store.appendEvent(chatId, prompt(fired))
        await store.appendEvent(chatId, { type: 'system_note', kind: 'info', agentId: 'sage', text: 'did not run' })
        await store.appendEvent(chatId, { type: 'turn_result', agentId: 'sage', turnId: 't1', routineExpired: true, routineOutcome: 'publish' })
      },
    })

    expect(tick).toMatchObject({ kind: 'ran', ok: false })
    expect(await routineOf(store, routine.id)).toMatchObject({ endState: 'expired', nextRunAt: null })
  })
})

describe('the DM history of a one-time routine', () => {
  afterEach(() => void vi.useRealTimers())

  it('draws a fire as done only by the rule that ended it', async () => {
    const { store, dm } = await dmHouse('2026-09-28T07:59:00Z')
    const routine = await once(store, dm.id, '2026-09-28T08:00:00Z')
    const fire = async (result: Record<string, unknown>, text?: string) => {
      await store.appendEvent(dm.id, prompt(routine))
      if (text !== undefined) await store.appendEvent(dm.id, { type: 'agent_message', agentId: 'sage', turnId: 't', text })
      await store.appendEvent(dm.id, { type: 'turn_result', agentId: 'sage', turnId: 't', ...result })
    }
    await fire({ routineOutcome: 'publish' }, 'No reply yet.')
    await fire({ routineOutcome: 'publish', routineIncomplete: true }, 'Could not read the inbox.')
    await fire({ routineOutcome: 'publish' }, routineDidNotFinish(routine.name))
    await fire({ routineOutcome: 'publish', routineExpired: true })

    const states = dmRoutineHistory(routine, await store.loadEvents(dm.id)).map((run) => run.state)
    expect(states).toEqual(['failed', 'failed', 'failed', 'done'])
  })

  it('keeps a failed fire failed after the routine is renamed', async () => {
    const { store, dm } = await dmHouse('2026-09-28T07:59:00Z')
    const routine = await once(store, dm.id, '2026-09-28T08:00:00Z')
    await store.appendEvent(dm.id, prompt(routine))
    await store.appendEvent(dm.id, { type: 'agent_message', agentId: 'sage', turnId: 't', text: routineDidNotFinish(routine.name) })
    await store.appendEvent(dm.id, { type: 'turn_result', agentId: 'sage', turnId: 't', routineOutcome: 'publish' })

    const renamed = await store.saveRoutine({ ...routine, name: 'Landlord reply check' })

    expect(dmRoutineHistory(renamed, await store.loadEvents(dm.id)).map((run) => run.state)).toEqual(['failed'])
  })
})

describe('a one-time routine and a sleeping Mac', () => {
  afterEach(() => void vi.useRealTimers())

  it('fires once on wake, hours late, when no latest useful time was given', async () => {
    const { store, dm } = await dmHouse('2026-09-28T07:00:00Z')
    const routine = await once(store, dm.id, '2026-09-28T08:00:00Z', { action: 'remind', prompt: 'Call the GP about the results.' })
    const runs: Routine[] = []

    const tick = await tickRoutines({ store, runTurn: publishing(store, runs), now: AT('2026-09-28T12:30:00Z') })

    expect(tick).toMatchObject({ kind: 'ran', ok: true })
    expect(runs[0]).toMatchObject({ action: 'remind', runAt: AT('2026-09-28T08:00:00Z') })
    expect(await routineOf(store, routine.id)).toMatchObject({ endState: 'done' })
  })

  it('expires out loud, without a turn, when it wakes past its latest useful time', async () => {
    const { store, dm } = await dmHouse('2026-09-28T07:00:00Z')
    const routine = await once(store, dm.id, '2026-09-28T08:00:00Z', { lateUntil: AT('2026-09-28T09:00:00Z') })
    const runs: Routine[] = []
    const notes: string[] = []

    const tick = await tickRoutines({
      store,
      runTurn: publishing(store, runs),
      now: AT('2026-09-28T12:30:00Z'),
      postNote: async (_chatId, text) => void notes.push(text),
    })

    expect(tick.kind).toBe('expired')
    expect(runs).toHaveLength(0)
    expect(await routineOf(store, routine.id)).toMatchObject({ endState: 'expired', enabled: false, nextRunAt: null, runningSince: null })
    // Named in the routine's own zone, so the line reads as the clock the user set it by.
    expect(notes).toEqual([
      '"Reply check" did not run. It was due Mon 28 Sept, 10:00 CEST, Manor was not running until Mon 28 Sept, 14:30 CEST, and it was only useful until Mon 28 Sept, 11:00 CEST.',
    ])
  })

  it('still runs a late fire that wakes inside its latest useful time', async () => {
    const { store, dm } = await dmHouse('2026-09-28T07:00:00Z')
    const routine = await once(store, dm.id, '2026-09-28T08:00:00Z', { lateUntil: AT('2026-09-28T09:00:00Z') })

    const tick = await tickRoutines({ store, runTurn: publishing(store), now: AT('2026-09-28T08:40:00Z') })

    expect(tick).toMatchObject({ kind: 'ran', ok: true })
    expect(await routineOf(store, routine.id)).toMatchObject({ endState: 'done' })
  })
})

describe('a one-time routine across a restart', () => {
  afterEach(() => void vi.useRealTimers())

  it('never re-fires after a crash mid-run, and ends failed once its lease is dead', async () => {
    const { store, dm } = await dmHouse('2026-09-28T07:59:00Z')
    const routine = await once(store, dm.id, '2026-09-28T08:00:00Z')
    const claimedAt = AT('2026-09-28T08:00:10Z')
    // The process dies inside the turn: the prompt is written, nothing after it.
    const claimed = await store.claimDueRoutine(claimedAt)
    expect(claimed?.routine.nextRunAt).toBeNull()
    vi.setSystemTime(claimedAt + 1_000)
    await store.appendEvent(dm.id, { ...prompt(routine) })

    // A restarted scheduler has nothing to claim, and recovery waits out a live lease.
    expect((await tickRoutines({ store, runTurn: publishing(store), now: claimedAt + 60_000 })).kind).toBe('idle')
    expect(await recoverFinishedRoutines(store, claimedAt + 60_000)).toBe(0)
    expect(await routineOf(store, routine.id)).toMatchObject({ endState: null, runningSince: claimedAt })

    expect(await recoverFinishedRoutines(store, claimedAt + ROUTINE_LEASE_MS)).toBe(1)
    expect(await routineOf(store, routine.id)).toMatchObject({ endState: 'failed', runningSince: null, nextRunAt: null })
    const events = await store.loadEvents(dm.id)
    expect(events.at(-1)).toMatchObject({ type: 'agent_message', text: routineDidNotFinish('Reply check') })
  })

  it('recovers a result that landed before the crash as done', async () => {
    const { store, dm } = await dmHouse('2026-09-28T07:59:00Z')
    const routine = await once(store, dm.id, '2026-09-28T08:00:00Z')
    await store.claimDueRoutine(AT('2026-09-28T08:00:10Z'))
    vi.setSystemTime(AT('2026-09-28T08:00:20Z'))
    await publishing(store)(routine, dm.id)

    expect(await recoverFinishedRoutines(store, AT('2026-09-28T08:01:00Z'))).toBe(1)
    expect(await routineOf(store, routine.id)).toMatchObject({ endState: 'done' })
  })
})

describe('changing and cancelling a one-time routine', () => {
  afterEach(() => void vi.useRealTimers())

  it('cancels a pending one visibly, and refuses to cancel a running or ended one', async () => {
    const { store, dm } = await dmHouse('2026-09-27T20:00:00Z')
    const pending = await once(store, dm.id, '2026-09-28T08:00:00Z')
    const cancelled = await store.cancelRoutine(pending.id, AT('2026-09-27T20:05:00Z'))
    expect(cancelled).toMatchObject({ endState: 'cancelled', endedAt: AT('2026-09-27T20:05:00Z'), enabled: false, nextRunAt: null })
    await expect(store.cancelRoutine(pending.id, AT('2026-09-27T20:06:00Z'))).rejects.toThrow(/already ended/)
    expect((await tickRoutines({ store, runTurn: publishing(store), now: AT('2026-09-28T08:00:10Z') })).kind).toBe('idle')

    const running = await once(store, dm.id, '2026-09-28T09:00:00Z')
    await store.claimDueRoutine(AT('2026-09-28T09:00:05Z'))
    await expect(store.cancelRoutine(running.id, AT('2026-09-28T09:00:06Z'))).rejects.toThrow(/running/)
  })

  it('re-arms an ended one only when its moment moves, and keeps it ended through other edits', async () => {
    const { store, dm } = await dmHouse('2026-09-28T07:59:00Z')
    const routine = await once(store, dm.id, '2026-09-28T08:00:00Z')
    await tickRoutines({ store, runTurn: publishing(store), now: AT('2026-09-28T08:00:10Z') })
    const done = (await routineOf(store, routine.id))!

    const renamed = await store.saveRoutine({ ...done, name: 'Landlord check' })
    expect(renamed).toMatchObject({ endState: 'done', enabled: false, nextRunAt: null })
    await expect(store.setRoutineEnabled(routine.id, true)).rejects.toThrow(/already ended/)

    const moved = await store.saveRoutine({ ...renamed, enabled: true, runAt: AT('2026-10-02T08:00:00Z') })
    expect(moved).toMatchObject({ endState: null, endedAt: null, enabled: true, nextRunAt: AT('2026-10-02T08:00:00Z') })
  })

  it('is swept a month after it ended, and not before or while pending', async () => {
    const { store, dm } = await dmHouse('2026-09-27T20:00:00Z')
    const ended = await once(store, dm.id, '2026-09-28T08:00:00Z')
    const endedAt = AT('2026-09-27T20:05:00Z')
    await store.cancelRoutine(ended.id, endedAt)
    const pending = await once(store, dm.id, '2026-12-01T08:00:00Z')

    expect(await purgeEndedRoutines(store, endedAt + ENDED_ROUTINE_KEEP_MS - 1)).toBe(0)
    expect(await purgeEndedRoutines(store, endedAt + ENDED_ROUTINE_KEEP_MS)).toBe(1)
    expect((await store.listRoutines()).map((routine) => routine.id)).toEqual([pending.id])
    expect((await store.listChats()).map((chat) => chat.id)).toContain(dm.id)
  })

  it('keeps one that was rescheduled after it ended', async () => {
    const { store, dm } = await dmHouse('2026-09-27T20:00:00Z')
    const task = await once(store, dm.id, '2026-09-28T08:00:00Z')
    const endedAt = AT('2026-09-27T20:05:00Z')
    const cancelled = (await store.cancelRoutine(task.id, endedAt))!
    await store.saveRoutine({ ...cancelled, enabled: true, runAt: AT('2026-12-01T08:00:00Z') })

    expect(await purgeEndedRoutines(store, endedAt + ENDED_ROUTINE_KEEP_MS)).toBe(0)
    expect(await routineOf(store, task.id)).toMatchObject({ endState: null, enabled: true })
  })

  it('keeps one moved from a project to a DM while its run threads exist', async () => {
    const { store, dm } = await dmHouse('2026-09-27T20:00:00Z')
    const projectId = (await store.listProjects())[0]!.id
    const task = await once(store, dm.id, '2026-09-28T08:00:00Z', { projectId, chatId: null })
    const run = await store.createChat({ projectId, kind: 'run', routineId: task.id, title: 'Reply check' })
    const endedAt = AT('2026-09-27T20:05:00Z')
    const cancelled = (await store.cancelRoutine(task.id, endedAt))!
    await store.saveRoutine({ ...cancelled, projectId: null, chatId: dm.id })

    expect(await purgeEndedRoutines(store, endedAt + ENDED_ROUTINE_KEEP_MS)).toBe(0)
    expect((await store.listRuns(task.id)).map((chat) => chat.id)).toEqual([run.id])
  })

  it('pauses and resumes on its own moment', async () => {
    const { store, dm } = await dmHouse('2026-09-27T20:00:00Z')
    const routine = await once(store, dm.id, '2026-09-28T08:00:00Z')

    expect(await store.setRoutineEnabled(routine.id, false)).toMatchObject({ nextRunAt: null, endState: null })
    expect(await store.setRoutineEnabled(routine.id, true)).toMatchObject({ nextRunAt: AT('2026-09-28T08:00:00Z') })
  })
})

describe('parseMoment', () => {
  it('reads wall-clock time in the routine zone on both sides of the October change', () => {
    expect(parseMoment('2026-10-24T10:00', 'Europe/Amsterdam')).toBe(AT('2026-10-24T08:00:00Z'))
    expect(parseMoment('2026-10-25T10:00', 'Europe/Amsterdam')).toBe(AT('2026-10-25T09:00:00Z'))
    expect(parseMoment('2026-09-28T10:00', 'America/New_York')).toBe(AT('2026-09-28T14:00:00Z'))
  })

  it('takes an explicit offset as written and refuses what is not a moment', () => {
    expect(parseMoment('2026-09-28T10:00:00+02:00', 'America/New_York')).toBe(AT('2026-09-28T08:00:00Z'))
    expect(parseMoment('2026-09-28T08:00:00Z', 'Europe/Amsterdam')).toBe(AT('2026-09-28T08:00:00Z'))
    expect(parseMoment('2026-09-28T08:00:00.000Z', 'Europe/Amsterdam')).toBe(AT('2026-09-28T08:00:00Z'))
    expect(() => parseMoment('tomorrow at ten', 'Europe/Amsterdam')).toThrow(/not a date and time/)
    expect(() => parseMoment('2026-02-30T10:00:00Z', 'Europe/Amsterdam')).toThrow(/not a real date/)
  })

  it('refuses a date that does not exist and an hour the clocks skip or pass twice', () => {
    expect(() => parseMoment('2026-02-30T10:00', 'Europe/Amsterdam')).toThrow(/not a real date/)
    expect(() => parseMoment('2026-09-28T24:30', 'Europe/Amsterdam')).toThrow(/not a real date/)
    expect(() => parseMoment('2027-03-28T02:30', 'Europe/Amsterdam')).toThrow(/does not exist in Europe\/Amsterdam/)
    expect(() => parseMoment('2026-10-25T02:30', 'Europe/Amsterdam')).toThrow(/happens twice/)
    // The autumn hour is still reachable, exactly, with its offset.
    expect(parseMoment('2026-10-25T02:30+01:00', 'Europe/Amsterdam')).toBe(AT('2026-10-25T01:30:00Z'))
    expect(parseMoment('2026-10-25T01:30', 'Europe/Amsterdam')).toBe(AT('2026-10-24T23:30:00Z'))
  })
})

describe('the DM routine tools for one-time work', () => {
  afterEach(() => void vi.useRealTimers())

  async function tools(now: string) {
    const { store, dm } = await dmHouse(now)
    const origins: unknown[] = []
    const module = new RoutineModule({
      store,
      agents: () => roster,
      orchestrator: {
        discard: () => undefined,
        isActiveTurn: () => true,
        submitUserMessage: (_chatId: string, _text: string, _images: unknown, origin: unknown) => {
          origins.push(origin)
          return Promise.resolve()
        },
      },
      knownChats: () => [],
      broadcast: () => undefined,
      broadcastDirectory: () => Promise.resolve(),
      replaceDirectory: () => Promise.resolve({ type: 'routines', routines: [] }),
      announceFinished: () => undefined,
    })
    const context = { chatId: dm.id, agentId: 'sage', turnId: 'turn_1' }
    return { store, dm, module, context, origins }
  }

  it('asks for an alert with notify on and for silence with notify off', async () => {
    const { store, dm, module, origins } = await tools('2026-09-27T20:00:00Z')
    const loud = await once(store, dm.id, '2026-09-28T08:00:00Z')
    const quiet = await once(store, dm.id, '2026-09-28T09:00:00Z', { notify: false })

    await module.run(loud, dm.id)
    await module.run(quiet, dm.id)

    expect(origins).toEqual([
      expect.objectContaining({ notice: 'alert' }),
      expect.objectContaining({ notice: 'silent' }),
    ])
  })

  it('schedules a literal reminder from wall-clock time and confirms the zone', async () => {
    const { store, module, context } = await tools('2026-09-27T20:00:00Z')

    const result = await module.useTool(context, 'routine_save', {
      name: 'GP call',
      prompt: 'Bel de huisarts over de uitslag.',
      runAt: '2026-09-28T10:00',
      action: 'remind',
    })

    expect(result).toMatchObject({
      created: true,
      confirm: 'Scheduled "GP call" for Mon 28 Sept, 10:00 CEST (Europe/Amsterdam).',
      routine: { action: 'remind', status: 'scheduled', notify: true },
    })
    expect((await store.listRoutines())[0]).toMatchObject({ runAt: AT('2026-09-28T08:00:00Z'), action: 'remind', cron: '' })
  })

  it('lists, moves and cancels its one-time work from the DM', async () => {
    const { store, module, context } = await tools('2026-09-27T20:00:00Z')
    await module.useTool(context, 'routine_save', { name: 'Reply check', prompt: 'Check for a reply.', runAt: '2026-10-02T09:00' })
    const [saved] = await store.listRoutines()

    const moved = await module.useTool(context, 'routine_save', { routineId: saved!.id, runAt: '2026-10-03T09:00', lateUntil: '2026-10-03T12:00' })
    expect(moved).toMatchObject({ confirm: 'Scheduled "Reply check" for Sat 3 Oct, 09:00 CEST (Europe/Amsterdam).' })
    expect((await store.listRoutines())[0]).toMatchObject({ runAt: AT('2026-10-03T07:00:00Z'), lateUntil: AT('2026-10-03T10:00:00Z') })

    await module.useTool(context, 'routine_cancel', { routineId: saved!.id })
    expect(await module.useTool(context, 'routine_list')).toMatchObject({
      routines: [{ routineId: saved!.id, status: 'cancelled', runAt: 'Sat 3 Oct, 09:00 CEST' }],
    })
  })

  it('brings a cancelled one back on when it gets a new time, unless told to stay off', async () => {
    const { store, module, context } = await tools('2026-09-27T20:00:00Z')
    await module.useTool(context, 'routine_save', { name: 'Tea', prompt: 'Thee zetten.', runAt: '2026-09-28T10:00', action: 'remind' })
    const [saved] = await store.listRoutines()
    await module.useTool(context, 'routine_cancel', { routineId: saved!.id })

    const back = await module.useTool(context, 'routine_save', { routineId: saved!.id, runAt: '2026-09-28T11:00' })
    expect(back).toMatchObject({ routine: { status: 'scheduled' }, confirm: 'Scheduled "Tea" for Mon 28 Sept, 11:00 CEST (Europe/Amsterdam).' })
    expect((await store.listRoutines())[0]).toMatchObject({ enabled: true, endState: null, nextRunAt: AT('2026-09-28T09:00:00Z') })

    await module.useTool(context, 'routine_cancel', { routineId: saved!.id })
    const off = await module.useTool(context, 'routine_save', { routineId: saved!.id, runAt: '2026-09-28T12:00', enabled: false })
    expect(off).not.toHaveProperty('confirm')
    expect((await store.listRoutines())[0]).toMatchObject({ enabled: false, nextRunAt: null })
  })

  it('refuses a request with both a cron and a one-time moment', async () => {
    const { module, context } = await tools('2026-09-27T20:00:00Z')

    await expect(module.useTool(context, 'routine_save', {
      name: 'x', prompt: 'y', cron: '0 9 * * *', runAt: '2026-10-02T09:00',
    })).rejects.toThrow(/either cron/)
  })
})
