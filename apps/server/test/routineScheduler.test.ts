import { ROUTINE_LEASE_MS, type Routine } from '@manor/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_ROUTINE_GRACE_MS,
  ROUTINE_FAILURE_LIMIT,
  ROUTINE_TICK_INTERVAL_MS,
  runRoutineNow,
  recoverFinishedRoutines,
  tickRoutines,
} from '../src/routineScheduler.js'
import { nextRunAfter } from '../src/routineSchedule.js'
import type { Store } from '../src/store.js'
import { createMemoryStore } from '../src/stores/memoryStore.js'
import { roster, seededChat } from './helpers.js'

const AT = (iso: string) => new Date(iso).getTime()

/**
 * The scheduler against a real store, with the clock driven rather than waited on.
 * Everything under test here is about *when* — the grace window, the roll-forward,
 * the October change — so a test that slept would be testing the wrong thing.
 */
async function house(now: string, cron = '0 7 * * *', notify = false) {
  vi.useFakeTimers()
  vi.setSystemTime(AT(now))
  const store = createMemoryStore({ agents: roster })
  const { projectId } = await seededChat(store)
  const routine = await store.saveRoutine({
    projectId,
    chatId: null,
    agentId: 'sage',
    name: 'Morning brief',
    prompt: 'What changed overnight?',
    cron,
    timezone: 'Europe/Amsterdam',
    enabled: true,
    notify,
    model: null,
    effort: null,
  })
  return { store, projectId, routine }
}

async function dmHouse(now: string, notify = false) {
  vi.useFakeTimers()
  vi.setSystemTime(AT(now))
  const store = createMemoryStore({ agents: roster })
  const dm = await store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })
  const routine = await store.saveRoutine({
    projectId: null,
    chatId: dm.id,
    agentId: 'sage',
    name: 'Mention watch',
    prompt: 'Check for new mentions.',
    cron: '0 7 * * *',
    timezone: 'Europe/Amsterdam',
    enabled: true,
    notify,
    model: null,
    effort: null,
  })
  return { store, dm, routine }
}

/**
 * A run that lands: the injected message, then the persona's completed turn. Written
 * into the chat the scheduler made for this run, which is what the real seam does too.
 */
const answering = (store: Store, runs: Routine[] = []) => async (routine: Routine, chatId: string) => {
  runs.push(routine)
  await store.appendEvent(chatId, {
    type: 'user_message',
    text: routine.prompt,
    mentions: [],
    source: 'routine',
    routineId: routine.id,
    routineName: routine.name,
  })
  await store.appendEvent(chatId, {
    type: 'agent_message',
    agentId: routine.agentId,
    turnId: 'turn_1',
    text: 'Nothing broke overnight.',
  })
  await store.appendEvent(chatId, { type: 'turn_result', agentId: routine.agentId, turnId: 'turn_1' })
}

/** A run that produced no `turn_result`: the persona never finished. */
const silentFailure = (store: Store) => async (routine: Routine, chatId: string) => {
  await store.appendEvent(chatId, {
    type: 'user_message',
    text: routine.prompt,
    mentions: [],
    source: 'routine',
    routineId: routine.id,
    routineName: routine.name,
  })
}

const routineOf = async (store: Store, id: string) => (await store.listRoutines()).find((entry) => entry.id === id)

/** The transcript of a routine's newest run, which is where its answers now land. */
const lastRunEvents = async (store: Store, routineId: string) => {
  const [newest] = await store.listRuns(routineId)
  return newest === undefined ? [] : store.loadEvents(newest.id)
}

/** A turn held open, so a second caller arrives while the first one is still in it. */
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('tickRoutines, the claim', () => {
  afterEach(() => void vi.useRealTimers())

  it('does nothing while no routine is due', async () => {
    const { store } = await house('2026-08-14T09:00:00Z')

    expect(await tickRoutines({ store, runTurn: answering(store), now: AT('2026-08-14T10:00:00Z') })).toEqual({
      kind: 'idle',
    })
  })

  // The whole reason the claim is a conditional update rather than a read: `pnpm dev`
  // on 8787 and the stable server on 43179 hit the same database, so both tick.
  it('is exclusive: two schedulers over one store run the routine exactly once', async () => {
    const { store, routine } = await house('2026-08-14T09:00:00Z')
    const runs: Routine[] = []
    const now = AT('2026-08-15T05:00:30Z') // 07:00:30 Amsterdam, half a minute late.

    const [first, second] = await Promise.all([
      tickRoutines({ store, runTurn: answering(store, runs), now }),
      tickRoutines({ store, runTurn: answering(store, runs), now }),
    ])

    expect(runs).toHaveLength(1)
    expect([first.kind, second.kind].sort()).toEqual(['idle', 'ran'])
    // And the loser is a loser because the fire time it read is gone, not because
    // anything told it to stand down.
    expect((await routineOf(store, routine.id))?.nextRunAt).toBe(AT('2026-08-16T05:00:00Z'))
  })
})

describe('tickRoutines, the grace window', () => {
  afterEach(() => void vi.useRealTimers())

  it('fires a run that is late but inside the window', async () => {
    const { store, routine } = await house('2026-08-14T09:00:00Z')
    const runs: Routine[] = []
    // 08:30 Amsterdam: an hour and a half after 07:00, inside the two-hour cap.
    const tick = await tickRoutines({
      store,
      runTurn: answering(store, runs),
      now: AT('2026-08-15T06:30:00Z'),
    })

    expect(tick.kind).toBe('ran')
    expect(runs.map((entry) => entry.id)).toEqual([routine.id])
    expect((await routineOf(store, routine.id))?.lastRunAt).toBe(AT('2026-08-15T06:30:00Z'))
    expect((await routineOf(store, routine.id))?.lastSkippedAt).toBeNull()
  })

  it('skips a run past the window, stamps it, and posts nothing in the chat', async () => {
    const { store, routine } = await house('2026-08-14T09:00:00Z')
    const runs: Routine[] = []
    // 12:00 Amsterdam: five hours after 07:00, well past the cap.
    const tick = await tickRoutines({
      store,
      runTurn: answering(store, runs),
      now: AT('2026-08-15T10:00:00Z'),
    })

    expect(tick.kind).toBe('skipped')
    expect(runs).toEqual([])
    const after = await routineOf(store, routine.id)
    expect(after?.lastSkippedAt).toBe(AT('2026-08-15T10:00:00Z'))
    expect(after?.lastRunAt).toBeNull()
    // An invisible skip reads as a run that happened, which is what the stamp is
    // for. What it is not is a thread: nobody wants a run per missed 07:00.
    expect(await store.listRuns(routine.id)).toEqual([])
  })

  // The failure this replaces: a laptop shut for a week, opened on Monday, and a
  // queue of seven catch-up turns arriving at once.
  it('rolls forward once across many missed slots, however long the gap', async () => {
    const { store, routine } = await house('2026-08-14T09:00:00Z')
    const runs: Routine[] = []
    // Eight days later. Eight 07:00s went by and exactly one skip comes out.
    const now = AT('2026-08-23T10:00:00Z')

    expect((await tickRoutines({ store, runTurn: answering(store, runs), now })).kind).toBe('skipped')
    // Nothing left to claim: the one roll went to the next *future* slot, not to
    // the next missed one.
    expect(await tickRoutines({ store, runTurn: answering(store, runs), now })).toEqual({ kind: 'idle' })
    expect(runs).toEqual([])
    expect((await routineOf(store, routine.id))?.nextRunAt).toBe(AT('2026-08-24T05:00:00Z'))
  })

  it('gives a frequent routine half its own interval instead of the two-hour cap', async () => {
    // Every ten minutes: the window is five, so a run four minutes late fires and
    // one six minutes late does not. The cap never enters into it.
    const { store } = await house('2026-08-14T09:00:00Z', '*/10 * * * *')
    const runs: Routine[] = []

    expect((await tickRoutines({ store, runTurn: answering(store, runs), now: AT('2026-08-14T09:14:00Z') })).kind).toBe(
      'ran',
    )
    expect((await tickRoutines({ store, runTurn: answering(store, runs), now: AT('2026-08-14T09:26:00Z') })).kind).toBe(
      'skipped',
    )
    expect(MAX_ROUTINE_GRACE_MS).toBe(2 * 60 * 60 * 1000)
  })
})

describe('the schedule across the October change', () => {
  // A 07:00 routine that quietly becomes 06:00 for half the year is the failure the
  // IANA zone on the row exists to prevent. 2026-10-25 is the Sunday the Netherlands
  // goes back to CET, so 07:00 local is 05:00Z before it and 06:00Z after.
  it('keeps a 07:00 Europe/Amsterdam routine at 07:00 local on both sides', () => {
    const cron = '0 7 * * *'
    const zone = 'Europe/Amsterdam'

    expect(nextRunAfter(cron, zone, AT('2026-10-23T12:00:00Z'))).toBe(AT('2026-10-24T05:00:00Z'))
    // The change itself: the last summer fire, then the first winter one.
    expect(nextRunAfter(cron, zone, AT('2026-10-24T12:00:00Z'))).toBe(AT('2026-10-25T06:00:00Z'))
    expect(nextRunAfter(cron, zone, AT('2026-10-25T12:00:00Z'))).toBe(AT('2026-10-26T06:00:00Z'))

    // Said the other way round, which is the assertion that actually matters: the
    // local wall clock reads 07:00 on every one of those days.
    const local = (at: number) =>
      new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit' }).format(new Date(at))
    for (const from of ['2026-10-23T12:00:00Z', '2026-10-24T12:00:00Z', '2026-10-25T12:00:00Z']) {
      expect(local(nextRunAfter(cron, zone, AT(from)))).toBe('07:00')
    }
  })

  it('carries a routine claimed on the Saturday over to 07:00 CET on the Sunday', async () => {
    const { store, routine } = await house('2026-10-24T02:00:00Z')
    expect(routine.nextRunAt).toBe(AT('2026-10-24T05:00:00Z'))

    const tick = await tickRoutines({ store, runTurn: answering(store), now: AT('2026-10-24T05:00:00Z') })

    expect(tick.kind).toBe('ran')
    expect((await routineOf(store, routine.id))?.nextRunAt).toBe(AT('2026-10-25T06:00:00Z'))
  })
})

describe('tickRoutines, failure bookkeeping', () => {
  afterEach(() => void vi.useRealTimers())

  /** Runs the routine `times` times in a row, one fire per day, with a given turn. */
  async function runDays(
    store: Store,
    runTurn: (routine: Routine, chatId: string) => Promise<void>,
    days: readonly string[],
  ) {
    for (const day of days) {
      await tickRoutines({ store, runTurn, now: AT(`${day}T05:00:00Z`) })
    }
  }

  it('turns the routine off at exactly three, with one note in the chat', async () => {
    const { store, routine } = await house('2026-08-14T09:00:00Z')

    await runDays(store, silentFailure(store), ['2026-08-15', '2026-08-16'])
    const twoDeep = await routineOf(store, routine.id)
    expect(twoDeep?.consecutiveFailures).toBe(2)
    // Two is not three: a CLI that was briefly not logged in must not kill a
    // routine that works.
    expect(twoDeep?.enabled).toBe(true)
    const soFar = await store.listRuns(routine.id)
    expect(soFar.flatMap(() => [])).toEqual([])
    expect(
      (await Promise.all(soFar.map((run) => store.loadEvents(run.id))))
        .flat()
        .some((event) => event.type === 'system_note'),
    ).toBe(false)

    await runDays(store, silentFailure(store), ['2026-08-17'])

    const off = await routineOf(store, routine.id)
    expect(off?.consecutiveFailures).toBe(ROUTINE_FAILURE_LIMIT)
    expect(off?.enabled).toBe(false)
    // The constraint the database holds too: a disabled routine carries no fire
    // time, so there is nothing left for a tick to claim.
    expect(off?.nextRunAt).toBeNull()
    expect(off?.disabledReason).toContain('sage')

    // One note, in the run that turned it off. Searched across the runs rather than
    // taken off the newest, because the clock is frozen here and every thread carries
    // the same `lastMessageAt`.
    const threads = await store.listRuns(routine.id)
    const notes = (await Promise.all(threads.map((run) => store.loadEvents(run.id))))
      .flat()
      .filter((event) => event.type === 'system_note')
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({ kind: 'error' })
    expect(notes[0]?.type === 'system_note' && notes[0].text).toContain('Morning brief')
    expect(await tickRoutines({ store, runTurn: silentFailure(store), now: AT('2026-08-18T05:00:00Z') })).toEqual({
      kind: 'idle',
    })
  })

  it('counts a driver that threw as a failure, and resets on the next success', async () => {
    const { store, routine } = await house('2026-08-14T09:00:00Z')

    await runDays(store, () => Promise.reject(new Error('claude is not logged in')), ['2026-08-15', '2026-08-16'])
    expect((await routineOf(store, routine.id))?.consecutiveFailures).toBe(2)

    await runDays(store, answering(store), ['2026-08-17'])

    const healed = await routineOf(store, routine.id)
    expect(healed?.consecutiveFailures).toBe(0)
    expect(healed?.enabled).toBe(true)
    expect(healed?.disabledReason).toBeNull()
  })

  // Sage's definition, taken whole: a failure is the *absence* of a turn_result.
  // "Nothing to report" is an answer, and a routine that reports it must not be
  // punished for the brevity.
  it('counts a silent but successful turn as a success', async () => {
    const { store, routine } = await house('2026-08-14T09:00:00Z')
    const quiet = async (entry: Routine, chatId: string) => {
      await store.appendEvent(chatId, {
        type: 'user_message',
        text: entry.prompt,
        mentions: [],
        source: 'routine',
        routineId: entry.id,
        routineName: entry.name,
      })
      // A finished turn with no message in it at all.
      await store.appendEvent(chatId, { type: 'turn_result', agentId: entry.agentId, turnId: 'turn_1' })
    }

    const tick = await tickRoutines({ store, runTurn: quiet, now: AT('2026-08-15T05:00:00Z') })

    expect(tick).toMatchObject({ kind: 'ran', ok: true })
    expect((await routineOf(store, routine.id))?.consecutiveFailures).toBe(0)
  })

  it('reads a thread one run old, so nothing earlier can pass for this run', async () => {
    const { store, routine, projectId } = await house('2026-08-14T09:00:00Z')
    // Sage finished a turn yesterday, in the room this routine runs in. Under the old
    // model that turn shared a chat with the routine and had to be cursored past;
    // under this one it is in a different thread entirely, which is the stronger
    // version of the same guarantee.
    const elsewhere = await store.createChat({ projectId, kind: 'project', title: 'By hand' })
    await store.appendEvent(elsewhere.id, { type: 'turn_result', agentId: 'sage', turnId: 'turn_yesterday' })

    const tick = await tickRoutines({ store, runTurn: silentFailure(store), now: AT('2026-08-15T05:00:00Z') })

    expect(tick).toMatchObject({ kind: 'ran', ok: false })
    expect((await routineOf(store, routine.id))?.consecutiveFailures).toBe(1)
  })

  it('counts a turn another persona finished as a failure of this routine', async () => {
    const { store, routine } = await house('2026-08-14T09:00:00Z')
    const wrongVoice = async (_entry: Routine, chatId: string) => {
      await store.appendEvent(chatId, { type: 'turn_result', agentId: 'smith', turnId: 'turn_1' })
    }

    expect(await tickRoutines({ store, runTurn: wrongVoice, now: AT('2026-08-15T05:00:00Z') })).toMatchObject({
      ok: false,
    })
    expect((await routineOf(store, routine.id))?.consecutiveFailures).toBe(1)
  })
})

describe('runRoutineNow', () => {
  afterEach(() => void vi.useRealTimers())

  it('runs a routine that is nowhere near due, and leaves its next fire where it was', async () => {
    const { store, routine } = await house('2026-08-14T09:00:00Z')
    const runs: Routine[] = []

    const tick = await runRoutineNow({
      store,
      runTurn: answering(store, runs),
      routineId: routine.id,
      now: AT('2026-08-14T13:00:00Z'),
    })

    expect(tick).toMatchObject({ kind: 'ran', ok: true })
    expect(runs.map((entry) => entry.id)).toEqual([routine.id])
    // The claim rolls `nextRunAt` to the next slot after now, which for a routine
    // that was not due is the slot it already held: a hand run is not the
    // scheduled run and must not consume it.
    expect((await routineOf(store, routine.id))?.nextRunAt).toBe(routine.nextRunAt)
  })

  // The double-run the claim exists to stop: The user presses Run now in the same
  // second the scheduler decides the routine is due.
  it('cannot double-run against a concurrent tick', async () => {
    const { store, routine } = await house('2026-08-14T09:00:00Z')
    const runs: Routine[] = []
    const now = AT('2026-08-15T05:00:00Z')

    const [hand, scheduled] = await Promise.all([
      runRoutineNow({ store, runTurn: answering(store, runs), routineId: routine.id, now }),
      tickRoutines({ store, runTurn: answering(store, runs), now }),
    ])

    expect(runs).toHaveLength(1)
    expect([hand.kind, scheduled.kind].sort()).toEqual(['idle', 'ran'])
  })

  it('answers with nothing for a routine that is gone or turned off', async () => {
    const { store, routine } = await house('2026-08-14T09:00:00Z')
    await store.setRoutineEnabled(routine.id, false)

    expect(await runRoutineNow({ store, runTurn: answering(store), routineId: routine.id })).toEqual({ kind: 'idle' })
    expect(await runRoutineNow({ store, runTurn: answering(store), routineId: 'nobody' })).toEqual({ kind: 'idle' })
  })

  // The other double-run, and the one a rolled fire time cannot stop: a second click
  // while the first turn is still talking. The claim's lease is the whole guard, so
  // removing it fails here.
  it('refuses a second Run now while the first is still in flight', async () => {
    const { store, routine } = await house('2026-08-14T09:00:00Z')
    const runs: Routine[] = []
    const gate = deferred()
    const slow = async (entry: Routine, chatId: string) => {
      runs.push(entry)
      await gate.promise
      await answering(store)(entry, chatId)
    }

    const first = runRoutineNow({ store, runTurn: slow, routineId: routine.id, now: AT('2026-08-14T13:00:00Z') })
    // A second later, which is what a double click is. The first turn has not
    // finished, so nothing has released the row.
    const second = await runRoutineNow({
      store,
      runTurn: slow,
      routineId: routine.id,
      now: AT('2026-08-14T13:00:01Z'),
    })

    expect(second).toEqual({ kind: 'idle' })
    gate.resolve()
    expect((await first).kind).toBe('ran')
    expect(runs).toHaveLength(1)
    // And the row is free again the moment the run ends, rather than at the lease's
    // expiry: the next hand run is not made to wait 45 minutes.
    expect((await routineOf(store, routine.id))?.runningSince).toBeNull()
  })

  it('says the routine is running from the claim, not from the finish', async () => {
    const { store, routine } = await house('2026-08-14T09:00:00Z')
    const gate = deferred()
    const announced = deferred()
    const seen: (number | null)[] = []

    const run = runRoutineNow({
      store,
      runTurn: async (entry, chatId) => {
        await gate.promise
        await answering(store)(entry, chatId)
      },
      routineId: routine.id,
      now: AT('2026-08-14T13:00:00Z'),
      // What the broadcast reads. A twenty-minute turn whose row only says "running"
      // once it is over is a row that never said it.
      onClaimed: async () => {
        seen.push((await routineOf(store, routine.id))?.runningSince ?? null)
        announced.resolve()
      },
    })

    await announced.promise
    expect(seen).toEqual([AT('2026-08-14T13:00:00Z')])
    gate.resolve()
    await run
  })

  it('runs the turn even when nobody could be told it started', async () => {
    const { store, routine } = await house('2026-08-14T09:00:00Z')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    // The claim already rolled the slot forward and took the lease by the time this
    // throws. A broadcast that took the run down with it would leave the routine owing
    // a turn nobody is going to run until the lease expires, having told nobody why.
    const tick = await runRoutineNow({
      store,
      runTurn: answering(store),
      routineId: routine.id,
      now: AT('2026-08-14T13:00:00Z'),
      onClaimed: () => Promise.reject(new Error('the socket went away')),
    })

    expect(tick).toMatchObject({ kind: 'ran', ok: true })
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('writes nothing when the lease it ran under was taken over', async () => {
    const { store, routine } = await house('2026-08-14T09:00:00Z')
    const now = AT('2026-08-14T13:00:00Z')

    // A run that outlives its own lease: while the turn talks, a second worker finds
    // the lease expired and takes the row. The straggler must not clear that lease.
    const tick = await runRoutineNow({
      store,
      runTurn: async (entry, chatId) => {
        await store.claimRoutine(entry.id, now + ROUTINE_LEASE_MS)
        await answering(store)(entry, chatId)
      },
      routineId: routine.id,
      now,
    })

    expect(tick).toMatchObject({ kind: 'ran', disabled: false })
    expect((await routineOf(store, routine.id))?.runningSince).toBe(now + ROUTINE_LEASE_MS)
  })

  it('leaves a routine switched off mid-run switched off', async () => {
    const { store, routine } = await house('2026-08-14T09:00:00Z')

    const tick = await runRoutineNow({
      store,
      runTurn: async (entry, chatId) => {
        // The user flicks the switch while the persona is still talking.
        await store.setRoutineEnabled(entry.id, false)
        await answering(store)(entry, chatId)
      },
      routineId: routine.id,
      now: AT('2026-08-14T13:00:00Z'),
    })

    expect(tick).toMatchObject({ kind: 'ran', ok: true })
    // On with no fire time is the state to fear here: it reads as armed in the list
    // and never runs again.
    expect(await routineOf(store, routine.id)).toMatchObject({ enabled: false, nextRunAt: null })
  })
})

describe('a direct-message routine', () => {
  afterEach(() => void vi.useRealTimers())

  it('completes when the user queues a message before the routine answer', async () => {
    const { store, routine } = await dmHouse('2026-08-14T09:00:00Z')
    const tick = await runRoutineNow({
      store,
      routineId: routine.id,
      now: AT('2026-08-14T13:00:00Z'),
      runTurn: async (entry, chatId) => {
        await store.appendEvent(chatId, {
          type: 'user_message', text: entry.prompt, mentions: [], source: 'routine', routineId: entry.id,
        })
        await store.appendEvent(chatId, {
          type: 'user_message', text: 'Thanks.', mentions: [], dispatchState: 'pending',
        })
        await store.appendEvent(chatId, { type: 'turn_result', agentId: entry.agentId, turnId: 'routine-turn' })
      },
    })
    expect(tick).toMatchObject({ kind: 'ran', ok: true })
    expect((await routineOf(store, routine.id))?.consecutiveFailures).toBe(0)
  })

  it('appends to the existing DM without creating a run or changing its runtime', async () => {
    const { store, dm, routine } = await dmHouse('2026-08-14T09:00:00Z')
    await store.appendEvent(dm.id, { type: 'user_message', text: 'Keep this context.', mentions: [] })
    await store.setChatOverride(dm.id, 'sage', { model: 'claude-opus-5', effort: 'high' })
    const created: string[] = []

    const tick = await runRoutineNow({
      store,
      runTurn: answering(store),
      routineId: routine.id,
      now: AT('2026-08-14T13:00:00Z'),
      onRunCreated: (chat) => void created.push(chat.id),
    })

    expect(tick).toMatchObject({ kind: 'ran', ok: true })
    expect(created).toEqual([])
    expect(await store.listRuns(routine.id)).toEqual([])
    expect((await store.loadEvents(dm.id)).map((event) => event.type)).toEqual([
      'user_message',
      'user_message',
      'agent_message',
      'turn_result',
    ])
    expect(await store.loadChatOverrides(dm.id)).toEqual({
      sage: { model: 'claude-opus-5', effort: 'high' },
    })
    expect((await routineOf(store, routine.id))?.lastRunAt).toBe(AT('2026-08-14T13:00:00Z'))
  })

  it('does not let an older DM answer pass for this run or advance the watermark on failure', async () => {
    const { store, dm, routine } = await dmHouse('2026-08-14T09:00:00Z')
    await store.appendEvent(dm.id, { type: 'turn_result', agentId: 'sage', turnId: 'turn_old' })

    const tick = await runRoutineNow({
      store,
      runTurn: silentFailure(store),
      routineId: routine.id,
      now: AT('2026-08-14T13:00:00Z'),
    })

    expect(tick).toMatchObject({ kind: 'ran', ok: false })
    expect((await routineOf(store, routine.id))?.lastRunAt).toBeNull()
  })

  it('keeps the watermark when an answered DM run says it did not read its whole window', async () => {
    const { store, dm, routine } = await dmHouse('2026-08-14T09:00:00Z')
    await runRoutineNow({ store, runTurn: answering(store), routineId: routine.id, now: AT('2026-08-14T13:00:00Z') })
    const incomplete = async (entry: Routine, chatId: string) => {
      await store.appendEvent(chatId, {
        type: 'user_message', text: entry.prompt, mentions: [], source: 'routine', routineId: entry.id, routineName: entry.name,
      })
      await store.appendEvent(chatId, { type: 'turn_result', agentId: entry.agentId, turnId: 'turn_2', routineOutcome: 'publish', routineIncomplete: true })
    }

    const tick = await runRoutineNow({ store, runTurn: incomplete, routineId: routine.id, now: AT('2026-08-14T16:00:00Z') })

    expect(tick).toMatchObject({ kind: 'ran', ok: true })
    expect(await routineOf(store, routine.id)).toMatchObject({ lastRunAt: AT('2026-08-14T13:00:00Z'), consecutiveFailures: 0 })
    expect((await store.loadEvents(dm.id)).filter((event) => event.type === 'turn_result')).toHaveLength(2)
  })

  it('does not credit another overlapping routine’s answer to this DM turn', async () => {
    const { store, dm, routine } = await dmHouse('2026-08-14T09:00:00Z')
    const overlapping = async (entry: Routine, chatId: string) => {
      await store.appendEvent(chatId, {
        type: 'user_message',
        text: 'Another scheduled prompt.',
        mentions: [],
        source: 'routine',
        routineId: 'routine_other',
        routineName: 'Other routine',
      })
      await store.appendEvent(chatId, { type: 'turn_result', agentId: entry.agentId, turnId: 'turn_other' })
      await store.appendEvent(chatId, {
        type: 'user_message',
        text: entry.prompt,
        mentions: [],
        source: 'routine',
        routineId: entry.id,
        routineName: entry.name,
      })
    }

    const tick = await runRoutineNow({
      store,
      runTurn: overlapping,
      routineId: routine.id,
      now: AT('2026-08-14T13:00:00Z'),
    })

    expect(tick).toMatchObject({ kind: 'ran', ok: false })
    expect((await routineOf(store, routine.id))?.lastRunAt).toBeNull()
    expect((await store.loadEvents(dm.id)).filter((event) => event.type === 'turn_result')).toHaveLength(1)
  })

  it('asks for completion attention only when notify is on', async () => {
    const quiet = await dmHouse('2026-08-14T09:00:00Z')
    const quietFinishes: string[] = []
    await runRoutineNow({
      store: quiet.store,
      runTurn: answering(quiet.store),
      routineId: quiet.routine.id,
      onRunFinished: (chat) => void quietFinishes.push(chat.id),
    })

    const loud = await dmHouse('2026-08-14T09:00:00Z', true)
    const startedAt = AT('2026-08-14T13:00:00Z')
    const loudFinishes: { chatId: string; startedAt: number }[] = []
    await runRoutineNow({
      store: loud.store,
      runTurn: answering(loud.store),
      routineId: loud.routine.id,
      now: startedAt,
      onRunFinished: (chat, runStartedAt) => void loudFinishes.push({ chatId: chat.id, startedAt: runStartedAt }),
    })

    expect(quietFinishes).toEqual([])
    expect(loudFinishes).toEqual([{ chatId: loud.dm.id, startedAt }])
  })
})

/** A run that lands with a declared outcome, the way a protocol turn records it. */
const declaring = (store: Store, routineOutcome: 'quiet' | 'publish') => async (routine: Routine, chatId: string) => {
  await store.appendEvent(chatId, {
    type: 'user_message',
    text: routine.prompt,
    mentions: [],
    source: 'routine',
    routineId: routine.id,
    routineName: routine.name,
  })
  await store.appendEvent(chatId, {
    type: 'agent_message',
    agentId: routine.agentId,
    turnId: 'turn_1',
    text: routineOutcome === 'quiet' ? 'Checked 12 threads, nothing new.' : 'Two tickets need you.',
  })
  await store.appendEvent(chatId, { type: 'turn_result', agentId: routine.agentId, turnId: 'turn_1', routineOutcome })
}

describe('unread runs', () => {
  afterEach(() => void vi.useRealTimers())

  it('leaves a published run unread when notify is on, and never a quiet one', async () => {
    const { store, routine } = await house('2026-08-14T09:00:00Z', '0 7 * * *', true)

    await runRoutineNow({ store, runTurn: declaring(store, 'quiet'), routineId: routine.id })
    expect((await routineOf(store, routine.id))?.unreadRunIds).toEqual([])

    vi.setSystemTime(AT('2026-08-14T10:00:00Z'))
    await runRoutineNow({ store, runTurn: declaring(store, 'publish'), routineId: routine.id })
    const [published] = await store.listRuns(routine.id)
    expect((await routineOf(store, routine.id))?.unreadRunIds).toEqual([published?.id])
  })

  it('leaves a failed run unread only when the routine asks to be told', async () => {
    const quiet = await house('2026-08-14T09:00:00Z')
    await runRoutineNow({ store: quiet.store, runTurn: silentFailure(quiet.store), routineId: quiet.routine.id })
    expect((await routineOf(quiet.store, quiet.routine.id))?.unreadRunIds).toEqual([])

    const { store, routine } = await house('2026-08-14T09:00:00Z', '0 7 * * *', true)
    await runRoutineNow({ store, runTurn: silentFailure(store), routineId: routine.id })
    const [failed] = await store.listRuns(routine.id)
    expect((await routineOf(store, routine.id))?.unreadRunIds).toEqual([failed?.id])
  })

  it('names a DM fire by its prompt, and reading it clears it', async () => {
    const { store, dm, routine } = await dmHouse('2026-08-14T09:00:00Z', true)

    await runRoutineNow({ store, runTurn: declaring(store, 'publish'), routineId: routine.id })
    const prompt = (await store.loadEvents(dm.id)).find((event) => event.type === 'user_message')
    expect((await routineOf(store, routine.id))?.unreadRunIds).toEqual([prompt?.id])

    expect(await store.markRoutineRunsRead(routine.id, [prompt?.id ?? ''])).toBe(true)
    expect(await store.markRoutineRunsRead(routine.id, [prompt?.id ?? ''])).toBe(false)
    expect((await routineOf(store, routine.id))?.unreadRunIds).toEqual([])
  })
})

describe('the routine pin', () => {
  afterEach(() => void vi.useRealTimers())

  it('writes the routine model and effort onto the run thread, as an ordinary pin', async () => {
    const { store, routine } = await house('2026-08-14T09:00:00Z')
    await store.saveRoutine({
      projectId: routine.projectId,
      chatId: routine.chatId,
      id: routine.id,
      agentId: routine.agentId,
      name: routine.name,
      prompt: routine.prompt,
      cron: routine.cron,
      timezone: routine.timezone,
      enabled: true,
      notify: false,
      model: 'claude-opus-5',
      effort: 'high',
    })

    await runRoutineNow({
      store,
      runTurn: answering(store),
      routineId: routine.id,
      now: AT('2026-08-14T13:00:00Z'),
    })

    // `chat_overrides`, not a second application path: the composer already reads this
    // for a hand-pinned chat and reads exactly the same row here.
    const [run] = await store.listRuns(routine.id)
    expect(await store.loadChatOverrides(run?.id ?? '')).toEqual({
      sage: { model: 'claude-opus-5', effort: 'high' },
    })
  })

  it('leaves an unpinned routine unpinned, so the persona’s own settings stand', async () => {
    const { store, routine } = await house('2026-08-14T09:00:00Z')

    await runRoutineNow({
      store,
      runTurn: answering(store),
      routineId: routine.id,
      now: AT('2026-08-14T13:00:00Z'),
    })

    // No row at all rather than a row of nulls: an empty pin and no pin read the same
    // to the composer, and writing one would make every run look overridden.
    const [run] = await store.listRuns(routine.id)
    expect(await store.loadChatOverrides(run?.id ?? '')).toEqual({})
  })
})

describe('telling the clients about a run', () => {
  afterEach(() => void vi.useRealTimers())

  it('announces the run thread before the turn, not after it', async () => {
    const { store, routine } = await house('2026-08-14T09:00:00Z')
    const told: string[] = []
    const duringTurn: number[] = []

    await runRoutineNow({
      store,
      runTurn: async (entry, chatId) => {
        // What a client can see while the work is happening. The bug this guards
        // against is a turn streaming into a thread nobody has a row for: the run was
        // invisible until something else made the directory be re-read.
        duringTurn.push(told.length)
        await answering(store)(entry, chatId)
      },
      routineId: routine.id,
      now: AT('2026-08-14T13:00:00Z'),
      onRunCreated: (chat) => void told.push(chat.id),
    })

    const [run] = await store.listRuns(routine.id)
    expect(told).toEqual([run?.id])
    expect(duringTurn).toEqual([1])
  })

  it('announces completion only after the run bookkeeping is durable', async () => {
    const { store, routine } = await house('2026-08-14T09:00:00Z', '0 7 * * *', true)
    const seen: { chatId: string; runningSince: number | null }[] = []

    await runRoutineNow({
      store,
      runTurn: answering(store),
      routineId: routine.id,
      now: AT('2026-08-14T13:00:00Z'),
      onRunFinished: async (chat) => {
        seen.push({
          chatId: chat.id,
          runningSince: (await routineOf(store, routine.id))?.runningSince ?? null,
        })
      },
    })

    expect(seen).toHaveLength(1)
    expect(seen[0]?.runningSince).toBeNull()
  })

  it('runs the turn even when the telling throws', async () => {
    const { store, routine } = await house('2026-08-14T09:00:00Z')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    // Same rule as the claim announcement: the thread already exists and the work is
    // owed, so a broadcast that fails may not swallow it.
    const tick = await runRoutineNow({
      store,
      runTurn: answering(store),
      routineId: routine.id,
      now: AT('2026-08-14T13:00:00Z'),
      onRunCreated: () => Promise.reject(new Error('the socket went away')),
    })

    expect(tick).toMatchObject({ kind: 'ran', ok: true })
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('what a run cost', () => {
  afterEach(() => void vi.useRealTimers())

  /** A run that finishes with a context reading, the way a real driver's does. */
  const costing = (store: Store, contextTokens: number) => async (routine: Routine, chatId: string) => {
    await store.appendEvent(chatId, {
      type: 'user_message',
      text: routine.prompt,
      mentions: [],
      source: 'routine',
      routineId: routine.id,
      routineName: routine.name,
    })
    await store.appendEvent(chatId, {
      type: 'turn_result',
      agentId: routine.agentId,
      turnId: 'turn_1',
      contextTokens,
    })
  }

  /** Every note this routine has written, across all of its run threads. */
  const notesIn = async (store: Store, routineId: string) => {
    const runs = await store.listRuns(routineId)
    const events = await Promise.all(runs.map((run) => store.loadEvents(run.id)))
    return events.flat().filter((event) => event.type === 'system_note')
  }

  it('records the last run’s context and says once, on the crossing, that one run is expensive', async () => {
    // Sage runs on the mock driver, whose window is a million tokens; two thirds of
    // that is a shade under 667k.
    const { store, routine } = await house('2026-08-14T09:00:00Z')

    await runRoutineNow({ store, runTurn: costing(store, 400_000), routineId: routine.id, now: AT('2026-08-14T13:00:00Z') })
    expect((await routineOf(store, routine.id))?.lastContextTokens).toBe(400_000)
    // Under the line, so nothing is said. Manor measures, it does not nag.
    expect(await notesIn(store, routine.id)).toHaveLength(0)

    await runRoutineNow({ store, runTurn: costing(store, 700_000), routineId: routine.id, now: AT('2026-08-14T14:00:00Z') })

    const notes = await notesIn(store, routine.id)
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({ kind: 'info' })
    expect(notes[0]?.type === 'system_note' && notes[0].text).toContain('Morning brief')
    expect((await routineOf(store, routine.id))?.lastContextTokens).toBe(700_000)

    // Still above the line on the next run, and silent: a routine that lives up here
    // would otherwise post the same sentence every morning.
    await runRoutineNow({ store, runTurn: costing(store, 720_000), routineId: routine.id, now: AT('2026-08-14T15:00:00Z') })
    expect(await notesIn(store, routine.id)).toHaveLength(1)
  })

  it('forgets the old reading when a run reports none, rather than passing it off as this one', async () => {
    const { store, routine } = await house('2026-08-14T09:00:00Z')
    await runRoutineNow({ store, runTurn: costing(store, 400_000), routineId: routine.id, now: AT('2026-08-14T13:00:00Z') })

    // `answering` finishes without a context reading, which is what a driver with no
    // per-request usage leaves behind.
    await runRoutineNow({ store, runTurn: answering(store), routineId: routine.id, now: AT('2026-08-14T14:00:00Z') })

    expect((await routineOf(store, routine.id))?.lastContextTokens).toBeNull()
  })
})

describe('recovering a lost routine completion', () => {
  afterEach(() => void vi.useRealTimers())

  it('leaves a DM routine running past a queued message, then recovers its own result', async () => {
    const { store, routine, dm } = await dmHouse('2026-09-15T08:00:00Z')
    const now = Date.now()
    await store.claimRoutine(routine.id, now)
    await silentFailure(store)(routine, dm.id)
    await store.appendEvent(dm.id, { type: 'user_message', text: 'Thanks.', mentions: [], dispatchState: 'pending' })
    expect(await recoverFinishedRoutines(store)).toBe(0)
    await store.appendEvent(dm.id, { type: 'turn_result', agentId: routine.agentId, turnId: 'routine-turn' })
    expect(await recoverFinishedRoutines(store)).toBe(1)
    expect(await routineOf(store, routine.id)).toMatchObject({ lastRunAt: now, consecutiveFailures: 0 })
  })

  it.each(['dm', 'run'] as const)('releases an interrupted %s without counting a follow-up as success', async (kind) => {
    const { store, routine } = await (kind === 'dm' ? dmHouse : house)('2026-09-15T08:00:00Z')
    await store.claimRoutine(routine.id, Date.now())
    const chatId = routine.chatId ?? (await store.createChat({
      kind: 'run', projectId: routine.projectId, routineId: routine.id, title: routine.name,
    })).id
    await silentFailure(store)(routine, chatId)
    expect(await recoverFinishedRoutines(store)).toBe(0)
    await store.appendEvent(chatId, { type: 'user_message', text: 'Continue', mentions: [] })
    await store.appendEvent(chatId, { type: 'turn_result', agentId: routine.agentId, turnId: 'follow-up' })
    expect(await recoverFinishedRoutines(store)).toBe(1)
    expect(await routineOf(store, routine.id)).toMatchObject({ runningSince: null, lastRunAt: null, consecutiveFailures: 1 })
    expect((await store.loadEvents(chatId)).at(-1)).toMatchObject(
      kind === 'dm'
        ? { type: 'agent_message', text: "Mention watch didn't finish.", turnId: `turn_routine_fail_${routine.id}` }
        : { type: 'system_note', kind: 'error' },
    )
    expect(await recoverFinishedRoutines(store)).toBe(0)
  })

  it('does not treat a later DM error as the routine already explaining itself', async () => {
    const { store, routine, dm } = await dmHouse('2026-09-15T08:00:00Z')
    await store.claimRoutine(routine.id, Date.now())
    await silentFailure(store)(routine, dm.id)
    await store.appendEvent(dm.id, { type: 'user_message', text: 'What happened?', mentions: [] })
    await store.appendEvent(dm.id, {
      type: 'system_note',
      kind: 'error',
      agentId: routine.agentId,
      turnId: 'later',
      text: 'Sage could not answer: boom',
    })
    expect(await recoverFinishedRoutines(store)).toBe(1)
    expect((await store.loadEvents(dm.id)).filter((event) => event.type === 'agent_message')).toEqual([
      expect.objectContaining({
        text: "Mention watch didn't finish.",
        turnId: `turn_routine_fail_${routine.id}`,
      }),
    ])
  })

  it('recovers a completed original turn as success', async () => {
    const { store, routine, dm } = await dmHouse('2026-09-15T08:00:00Z')
    const now = Date.now()
    await store.claimRoutine(routine.id, now)
    await answering(store)(routine, dm.id)
    expect(await recoverFinishedRoutines(store)).toBe(1)
    expect(await routineOf(store, routine.id)).toMatchObject({ runningSince: null, lastRunAt: now, consecutiveFailures: 0 })
  })
})

describe('the tick interval', () => {
  it('is fine enough that 07:00 means 07:00', () => {
    expect(ROUTINE_TICK_INTERVAL_MS).toBe(30 * 1000)
  })
})
