import { CURRENT_CHECKOUT, ROUTINE_LEASE_MS, type AgentConfig, type Chat, type Routine, type RoutineRun } from '@manor/contracts'
import { describe, expect, it } from 'vitest'
import {
  describeCron,
  describeSchedule,
  draftOfRoutine,
  formatWhen,
  routineOffLabel,
  isRunning,
  latestResultRun,
  routinesNeedAttention,
  reachableAgents,
  readPreset,
  routineDescriptionProblem,
  routineNextRun,
  routineStatus,
  routineTimeline,
  runsByRoutine,
  scheduledSections,
  SCHEDULED_ATTENTION_MS,
  writeCron,
} from './routines'
import { emptyWorkspace, reduce } from './state'

const routine = (patch: Partial<Routine> = {}): Routine => ({
  id: 'rt_1',
  projectId: 'project_1',
  chatId: null,
  agentId: 'smith',
  name: 'Morning brief',
  description: 'Summarises what changed overnight.',
  prompt: 'What changed yesterday?',
  cron: '0 7 * * *',
  timezone: 'Europe/Amsterdam',
  enabled: true,
  notify: false,
  model: null,
  effort: null,
  nextRunAt: null,
  lastRunAt: null,
  lastSkippedAt: null,
  consecutiveFailures: 0,
  disabledReason: null,
  runningSince: null,
  lastContextTokens: null,
  runAt: null,
  lateUntil: null,
  action: 'run',
  endState: null,
  endedAt: null,
  unreadRunIds: [],
  createdAt: 0,
  ...patch,
})

const agent = (id: string, name: string): AgentConfig => ({
  id,
  name,
  role: '',
  description: '',
  character: 'x',
  color: '#8b7ec8',
  driver: 'mock',
  effort: 'medium',
  allowedTools: [],
  mcpServers: [],
  isCos: false,
  memoryScope: false,
})

const chat = (patch: Partial<Chat> = {}): Chat => ({
  id: 'chat_1',
  projectId: 'proj_1',
  kind: 'project',
  routineId: null,
  parentChatId: null,
  sideModel: null,
  sideEffort: null,
  memberIds: [],
  lastMessagePreview: null,
  title: 'Manor',
  createdAt: 0,
  lastMessageAt: 0,
  settledAt: null,
  agentIds: [],
  checkout: CURRENT_CHECKOUT,
  ...patch,
  archivedAt: patch.archivedAt ?? null,
})

/** 2026-08-12, 07:00 and 09:14 in Amsterdam, for the two clock states of a row. */
const AT_0700 = Date.UTC(2026, 7, 12, 5, 0)
const AT_0914 = Date.UTC(2026, 7, 12, 7, 14)

describe('the schedule presets', () => {
  it('writes the cron each preset means', () => {
    expect(writeCron({ kind: 'daily', time: '07:00' })).toBe('0 7 * * *')
    expect(writeCron({ kind: 'weekdays', time: '07:00' })).toBe('0 7 * * 1-5')
    expect(writeCron({ kind: 'weekly', day: 1, time: '08:30' })).toBe('30 8 * * 1')
    expect(writeCron({ kind: 'hourly', hours: 6 })).toBe('0 */6 * * *')
  })

  // The form holds one schedule, the cron string, and the preset row is a reader of
  // it. If a written cron did not read back as the preset that wrote it, opening a
  // saved routine would show a different schedule than the one it runs on.
  it('reads every written cron back as the preset that wrote it', () => {
    for (const preset of [
      { kind: 'daily', time: '07:00' },
      { kind: 'weekdays', time: '23:05' },
      { kind: 'weekly', day: 0, time: '08:30' },
      { kind: 'hourly', hours: 3 },
    ] as const) {
      expect(readPreset(writeCron(preset))).toEqual(preset)
    }
  })

  it('says the schedule in words', () => {
    expect(describeCron('0 7 * * *')).toBe('Every day at 07:00')
    expect(describeCron('0 7 * * 1-5')).toBe('Weekdays at 07:00')
    expect(describeCron('30 8 * * 1')).toBe('Mondays at 08:30')
    expect(describeCron('0 */6 * * *')).toBe('Every 6 hours')
    expect(describeCron('0 */1 * * *')).toBe('Every hour')
  })

  it('keeps raw cron in the editor and gives management surfaces human language', () => {
    expect(readPreset('0 7 1-7 * 1')).toBeNull()
    expect(describeCron('0 9 1 * *')).toBe('Every month on day 1 at 09:00')
    expect(describeCron('0 7 1-7 * 1')).toBe('Custom schedule at 07:00')
    expect(describeCron('*/15 * * * *')).toBe('Custom schedule')
  })
})

describe('routine description validation', () => {
  it('matches the 500-character contract before a save leaves the browser', () => {
    expect(routineDescriptionProblem('x'.repeat(500))).toBeNull()
    expect(routineDescriptionProblem('x'.repeat(501))).toBe(
      'A routine description can be at most 500 characters.',
    )
  })
})

describe('what a routine row says about time', () => {
  it('shows the next fire for a routine that has not run yet, never a dash', () => {
    expect(routineStatus(routine({ nextRunAt: AT_0700 }), AT_0700 - 3_600_000).text).toBe('Next 07:00')
  })

  it('shows the run beside the slot it was meant for when they differ', () => {
    expect(routineStatus(routine({ lastRunAt: AT_0914 }), AT_0914).text).toBe('Ran 09:14 · scheduled 07:00')
    expect(routineStatus(routine({ lastRunAt: AT_0700 }), AT_0700).text).toBe('Ran 07:00')
  })

  it('keeps the next fire available after a run has completed', () => {
    const afterRun = routine({ lastRunAt: AT_0700, nextRunAt: AT_0914 })
    expect(routineStatus(afterRun, AT_0700).text).toBe('Ran 07:00')
    expect(routineNextRun(afterRun, AT_0700)).toBe('today at 09:14')
    expect(routineTimeline(afterRun, AT_0700).text).toBe('Ran 07:00 · Next today at 09:14')
    expect(routineNextRun(routine({ enabled: false }), AT_0700)).toBe('Not scheduled while off')
  })

  // `every 6 hours` fires at six different times, so there is no one slot to compare
  // the run against and inventing one would be a made-up answer.
  it('names no slot for a schedule that has no fixed time', () => {
    expect(routineStatus(routine({ cron: '0 */6 * * *', lastRunAt: AT_0914 }), AT_0914).text).toBe('Ran 09:14')
  })

  it('says a skip the grace window dropped, rather than letting it read as a run', () => {
    const skipped = routine({ lastRunAt: AT_0700 - 86_400_000, lastSkippedAt: AT_0914 })
    expect(routineStatus(skipped, AT_0914).text).toBe('Skipped 07:00')
  })

  it('gives Manor’s own reason for turning a routine off, in error tone', () => {
    const off = routine({ enabled: false, disabledReason: '3 runs in a row ended without an answer' })
    expect(routineStatus(off, AT_0914)).toEqual({
      text: 'Off: 3 runs in a row ended without an answer',
      tone: 'error',
    })
    // Off because the user turned it off needs no explanation, and gets no alarm.
    expect(routineStatus(routine({ enabled: false }), AT_0914)).toEqual({ text: 'Off', tone: 'quiet' })
  })
})

describe('a one-time routine row', () => {
  const runAt = Date.UTC(2026, 8, 28, 8, 0)

  it('says its one moment rather than a repeat', () => {
    expect(describeSchedule(routine({ cron: '', runAt }))).toBe('Once, Mon 28 Sept, 10:00')
  })

  it('shows how it ended, late included, and never an armed Off', () => {
    const done = routine({ cron: '', runAt, enabled: false, endState: 'done', endedAt: runAt + 4 * 3_600_000, lastRunAt: runAt + 4 * 3_600_000 })
    expect(routineStatus(done)).toEqual({ text: 'Done Mon 28 Sept, 14:00, late', tone: 'quiet' })
    expect(routineNextRun(done)).toBe('Not again, it ran once')
    expect(routineOffLabel(done)).toBe('Done')
    expect(routineStatus(routine({ cron: '', runAt, enabled: false, endState: 'expired', endedAt: runAt }))).toEqual({ text: 'Expired, did not run', tone: 'error' })
    expect(routineStatus(routine({ cron: '', runAt, enabled: false, endState: 'failed', endedAt: runAt })).tone).toBe('error')
    expect(routineOffLabel(routine({ enabled: false }))).toBe('Off')
  })

  it('opens an ended one in the form switched on, so a new time schedules it again', () => {
    expect(draftOfRoutine(routine({ cron: '', runAt, enabled: false, endState: 'failed', endedAt: runAt })).enabled).toBe(true)
    expect(draftOfRoutine(routine({ enabled: false })).enabled).toBe(false)
  })
})

describe('routine run order', () => {
  it('stays on execution order when an older run receives a newer reply', () => {
    const older = chat({ id: 'older', kind: 'run', routineId: 'rt_1', createdAt: 100, lastMessageAt: 500 })
    const newer = chat({ id: 'newer', kind: 'run', routineId: 'rt_1', createdAt: 200, lastMessageAt: 200 })

    expect(runsByRoutine([older, newer]).rt_1?.map((run) => run.id)).toEqual(['newer', 'older'])
  })

  it('drops leftover run threads once the routine speaks in a DM', () => {
    const leftover = chat({ id: 'aug-31', kind: 'run', routineId: 'rt_1', createdAt: 100 })
    const hung = routine({ chatId: 'dm-huxley' })

    expect(runsByRoutine([leftover], [hung]).rt_1).toBeUndefined()
    expect(runsByRoutine([leftover], [routine()]).rt_1?.map((run) => run.id)).toEqual(['aug-31'])
  })
})

describe('a routine that is running', () => {
  it('says so over everything else, because it is the only line about right now', () => {
    const running = routine({ runningSince: AT_0914, lastRunAt: AT_0700 })
    expect(routineStatus(running, AT_0914 + 60_000)).toEqual({ text: 'Running since 09:14', tone: 'active' })
    // Even turned off mid-run: a turn that is still talking is still talking, and
    // "Off" over a live answer is the row lying about what is on screen.
    expect(routineStatus({ ...running, enabled: false }, AT_0914 + 60_000).tone).toBe('active')
  })

  it('lets go of a lease no process is coming back for', () => {
    const stuck = routine({ runningSince: AT_0700, lastRunAt: AT_0700 })
    // The store would let the claim take this row again, so the view must not go on
    // saying it cannot be run. Same expiry, read from the same constant.
    expect(isRunning(stuck, AT_0700 + ROUTINE_LEASE_MS - 1)).toBe(true)
    expect(isRunning(stuck, AT_0700 + ROUTINE_LEASE_MS)).toBe(false)
    expect(routineStatus(stuck, AT_0700 + ROUTINE_LEASE_MS).text).toBe('Ran 07:00')
  })
})

describe('the target a routine may name', () => {
  const household = [agent('smith', 'Smith'), agent('sage', 'Sage')]

  // Mirrors the orchestrator's room filter: a target outside a dm's membership is
  // dropped at run time, so a form that offered the household would build routines
  // that can never run.
  it('narrows a dm to the persona whose dm it is', () => {
    const dm = chat({ kind: 'dm', projectId: null, memberIds: ['sage'] })
    expect(reachableAgents(household, dm).map((entry) => entry.id)).toEqual(['sage'])
  })

  it('leaves a project chat open to the whole household', () => {
    expect(reachableAgents(household, chat()).map((entry) => entry.id)).toEqual(['smith', 'sage'])
  })


})

describe('the routines broadcast', () => {
  it('is stored whole, because the server re-sends the whole list after every mutation', () => {
    expect(emptyWorkspace.hasRoutines).toBe(false)
    const first = reduce(emptyWorkspace, { type: 'routines', routines: [routine()] })
    expect(first.hasRoutines).toBe(true)
    expect(first.routines.map((entry) => entry.id)).toEqual(['rt_1'])

    const second = reduce(first, { type: 'routines', routines: [routine({ id: 'rt_2', name: 'Nightly' })] })
    expect(second.routines.map((entry) => entry.name)).toEqual(['Nightly'])
  })
})

describe('scheduledSections', () => {
  const now = Date.UTC(2026, 8, 28, 12)
  const once = (id: string, patch: Partial<Routine>) => routine({ id, cron: '', runAt: now, ...patch })

  it('keeps a failure in Upcoming for a day, then folds it into Earlier', () => {
    const later = once('later', { runAt: now + 2000 })
    const sooner = once('sooner', { runAt: now + 1000 })
    const fresh = once('fresh', { endState: 'expired', endedAt: now - 1000 })
    const stale = once('stale', { endState: 'failed', endedAt: now - SCHEDULED_ATTENTION_MS })
    const done = once('done', { endState: 'done', endedAt: now - 500 })
    const sections = scheduledSections([routine(), later, stale, done, sooner, fresh], now)
    expect(sections.upcoming.map((entry) => entry.id)).toEqual(['fresh', 'sooner', 'later'])
    expect(sections.earlier.map((entry) => entry.id)).toEqual(['done', 'stale'])
    expect(sections.recurring.map((entry) => entry.id)).toEqual(['rt_1'])
  })
})

describe('formatWhen', () => {
  it('counts Tomorrow on the calendar across the spring clock change', () => {
    const lateSaturday = Date.parse('2026-03-28T23:30:00+01:00')
    expect(formatWhen(Date.parse('2026-03-29T10:00:00+02:00'), 'Europe/Amsterdam', lateSaturday)).toBe('Tomorrow 10:00')
    expect(formatWhen(Date.parse('2026-03-30T10:00:00+02:00'), 'Europe/Amsterdam', lateSaturday)).not.toMatch(/^Tomorrow/)
    expect(formatWhen(Date.parse('2026-03-28T23:45:00+01:00'), 'Europe/Amsterdam', lateSaturday)).toBe('Today 23:45')
  })
})

describe('routine attention', () => {
  const run = (id: string, patch: Partial<RoutineRun> = {}): RoutineRun =>
    ({ id, chatId: null, startedAt: 0, state: 'done', outcome: 'publish', result: 'Found one.', ...patch })

  it('shows the newest run with something to read, skipping quiet checks and live runs', () => {
    const runs = [run('live', { state: 'running', result: null }), run('quiet', { outcome: 'quiet' }), run('spoke'), run('older')]
    expect(latestResultRun(runs)?.id).toBe('spoke')
    // A failure is always something to read, even without words.
    expect(latestResultRun([run('broke', { state: 'failed', result: null }), run('spoke')])?.id).toBe('broke')
    expect(latestResultRun([run('quiet', { outcome: 'quiet' })])).toBeUndefined()
    // A published answer with only an image is still a result, so its dot can clear.
    expect(latestResultRun([run('image', { result: null }), run('spoke')])?.id).toBe('image')
    // A run older than the outcome counts only when it said something.
    expect(latestResultRun([run('legacy', { outcome: undefined, result: null }), run('spoke')])?.id).toBe('spoke')
  })

  it('lights the door only for unread runs, switched-off routines included', () => {
    expect(routinesNeedAttention([routine()])).toBe(false)
    expect(routinesNeedAttention([routine({ enabled: false, unreadRunIds: ['broke'] })])).toBe(true)
  })
})
