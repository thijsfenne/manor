import {
  ClientMessageSchema,
  RoutineDraftSchema,
  RoutineSchema,
  ServerMessageSchema,
  ThreadEventSchema,
} from '@manor/contracts'
import { describe, expect, it } from 'vitest'

/**
 * The routine contracts (step 1 of `.claude/plans/2026-08-12-routines.md`).
 *
 * These live here rather than in `packages/contracts` because that package has no
 * test runner of its own, and the server is the only place a schema is parsed at a
 * real boundary anyway.
 */

const routine = {
  id: 'r1',
  projectId: 'p1',
  chatId: null,
  agentId: 'smith',
  name: 'Morning brief',
  description: 'Summarises what changed overnight.',
  prompt: 'What changed overnight?',
  cron: '0 7 * * 1-5',
  timezone: 'Europe/Amsterdam',
  enabled: true,
  notify: false,
  model: 'claude-opus-5',
  effort: 'high',
  nextRunAt: 1_760_000_000_000,
  lastRunAt: null,
  lastSkippedAt: null,
  consecutiveFailures: 0,
  disabledReason: null,
  // The lease the claim takes, and what the last run cost. Both null on a routine
  // that is not running and has never reported a context reading.
  runningSince: null,
  lastContextTokens: null,
  runAt: null,
  lateUntil: null,
  action: 'run',
  endState: null,
  endedAt: null,
  unreadRunIds: ['run_1'],
  createdAt: 1_750_000_000_000,
}

describe('UserMessageEventSchema', () => {
  it('still parses a row written before routines existed', () => {
    const parsed = ThreadEventSchema.parse({
      id: 'e1',
      ts: 1,
      type: 'user_message',
      text: 'morning',
      mentions: [],
    })
    expect(parsed).toMatchObject({ type: 'user_message' })
    expect('source' in parsed).toBe(false)
  })

  it('carries the routine that injected it', () => {
    const parsed = ThreadEventSchema.parse({
      id: 'e2',
      ts: 2,
      type: 'user_message',
      text: 'What changed overnight?',
      mentions: [],
      source: 'routine',
      routineId: 'routine_1',
      routineName: 'Morning brief',
    })
    expect(parsed).toMatchObject({ source: 'routine', routineId: 'routine_1', routineName: 'Morning brief' })
  })

  it('knows only one source, so a made-up one is refused rather than rendered', () => {
    const result = ThreadEventSchema.safeParse({
      id: 'e3',
      ts: 3,
      type: 'user_message',
      text: 'hi',
      mentions: [],
      source: 'cron',
    })
    expect(result.success).toBe(false)
  })
})

describe('TurnResultEventSchema', () => {
  it('persists a DM routine publication outcome while keeping older results valid', () => {
    const base = { id: 'result_1', ts: 3, type: 'turn_result', agentId: 'sage', turnId: 'turn_1' }

    expect(ThreadEventSchema.parse({ ...base, routineOutcome: 'quiet' })).toMatchObject({
      routineOutcome: 'quiet',
    })
    expect(ThreadEventSchema.parse(base)).not.toHaveProperty('routineOutcome')
    expect(ThreadEventSchema.safeParse({ ...base, routineOutcome: 'hidden' }).success).toBe(false)
  })
})

describe('RoutineSchema', () => {
  it('round-trips a full row', () => {
    expect(RoutineSchema.parse(routine)).toEqual(routine)
  })

  it('defaults the zone and the enabled flag, so a routine is never scheduled nowhere', () => {
    const { timezone: _timezone, enabled: _enabled, ...rest } = routine
    expect(RoutineSchema.parse(rest)).toMatchObject({ timezone: 'Europe/Amsterdam', enabled: true })
  })

  it('reads a row written before one-time routines as recurring and pending', () => {
    const { runAt: _runAt, lateUntil: _lateUntil, action: _action, endState: _endState, endedAt: _endedAt, ...older } = routine
    expect(RoutineSchema.parse(older)).toEqual(routine)
  })

  it('takes the null timestamps a routine that has never run carries', () => {
    const parsed = RoutineSchema.parse({ ...routine, enabled: false, nextRunAt: null })
    expect(parsed.nextRunAt).toBeNull()
  })

  /**
   * Non-empty name and prompt are SQL constraints only, the way every other chat-keyed
   * rule in Manor is (`chats_dm_shape`, `chat_overrides_not_empty`). Asserted here so
   * the split is a decision on record rather than something a later reader repairs.
   */
  it('leaves the non-empty rules to the database', () => {
    expect(RoutineSchema.safeParse({ ...routine, name: '', prompt: '' }).success).toBe(true)
  })

  it('requires exactly one project or direct-message target', () => {
    expect(RoutineSchema.safeParse({ ...routine, projectId: null, chatId: 'dm_1' }).success).toBe(true)
    expect(RoutineSchema.safeParse({ ...routine, projectId: null, chatId: null }).success).toBe(false)
    expect(RoutineSchema.safeParse({ ...routine, chatId: 'dm_1' }).success).toBe(false)
  })
})

describe('RoutineDraftSchema', () => {
  it('creates without an id and updates with one', () => {
    const draft = {
      projectId: 'p1',
      agentId: 'smith',
      name: 'Morning brief',
      description: '',
      prompt: 'What changed overnight?',
      cron: '0 7 * * 1-5',
      timezone: 'Europe/Amsterdam',
      enabled: true,
    }
    expect(RoutineDraftSchema.parse(draft).id).toBeUndefined()
    expect(RoutineDraftSchema.parse({ ...draft, id: 'r1' }).id).toBe('r1')
  })

  it('carries none of the fields the scheduler owns', () => {
    const parsed = RoutineDraftSchema.parse({
      projectId: 'p1',
      agentId: 'smith',
      name: 'Morning brief',
      prompt: 'What changed overnight?',
      cron: '0 7 * * 1-5',
      nextRunAt: 1,
      lastRunAt: 2,
      lastSkippedAt: 3,
      consecutiveFailures: 9,
      disabledReason: 'made up',
      // A form asserting the lease could claim a routine is running, or free one
      // that is; both are the scheduler's to say and neither survives the parse.
      runningSince: 5,
      lastContextTokens: 999,
      // How a one-time routine ended is the scheduler's record, never a form's claim.
      endState: 'done',
      endedAt: 6,
      createdAt: 4,
    })
    expect(parsed).toEqual({
      projectId: 'p1',
      chatId: null,
      agentId: 'smith',
      name: 'Morning brief',
      description: '',
      prompt: 'What changed overnight?',
      cron: '0 7 * * 1-5',
      timezone: 'Europe/Amsterdam',
      enabled: true,
      // The pin, defaulted to no pin: a routine nobody has told otherwise runs on
      // whatever its persona runs on.
      model: null,
      effort: null,
      // Defaulted rather than dropped: it is the form's to set, and off is the answer
      // for a routine that has not said otherwise.
      notify: false,
    })
  })
})

describe('the routine messages', () => {
  it('round-trips every client message', () => {
    const messages = [
      {
        type: 'save_routine',
        routine: {
          projectId: 'p1',
          chatId: null,
          agentId: 'smith',
          name: 'Morning brief',
          description: '',
          prompt: 'What changed overnight?',
          cron: '0 7 * * 1-5',
          timezone: 'Europe/Amsterdam',
          notify: false,
          model: null,
          effort: null,
          enabled: true,
        },
      },
      { type: 'delete_routine', routineId: 'r1' },
      { type: 'set_routine_enabled', routineId: 'r1', enabled: false },
      { type: 'get_routine_runs', routineId: 'r1' },
      { type: 'mark_routine_runs_read', routineId: 'r1', runIds: ['run_1'] },
      { type: 'mark_all_routine_runs_read' },
      { type: 'run_routine_now', routineId: 'r1', requestId: 'run-r1' },
    ]
    for (const message of messages) {
      const result = ClientMessageSchema.safeParse(message)
      expect(result.success, message.type).toBe(true)
      expect(result.success && result.data).toEqual(message)
    }
  })

  it('refuses a toggle with no state, because the whole state is what travels', () => {
    expect(ClientMessageSchema.safeParse({ type: 'set_routine_enabled', routineId: 'r1' }).success).toBe(
      false,
    )
  })

  it('pushes the whole list, the way roster does', () => {
    const result = ServerMessageSchema.safeParse({ type: 'routines', routines: [routine] })
    expect(result.success).toBe(true)
    expect(ServerMessageSchema.safeParse({ type: 'routines', routines: [] }).success).toBe(true)
  })

  it('carries a bounded run history, with a project routine as a null target', () => {
    const result = ServerMessageSchema.safeParse({
      type: 'routine_runs',
      routineId: 'r1',
      chatId: null,
      runs: [
        { id: 'lease:r1:200', chatId: null, startedAt: 200, state: 'running', result: null },
        { id: 'run_1', chatId: 'run_1', startedAt: 100, state: 'done', outcome: 'publish', result: 'Two tickets.' },
      ],
    })
    expect(result.success).toBe(true)
    expect(ServerMessageSchema.safeParse({
      type: 'routine_runs',
      routineId: 'r1',
      chatId: 'dm_1',
      runs: Array.from({ length: 71 }, (_, index) => ({ id: String(index), chatId: 'dm_1', startedAt: index, state: 'done', result: null })),
    }).success).toBe(false)
  })

  it('reads a routine stored before unread runs existed as having none', () => {
    const { unreadRunIds: _unreadRunIds, ...older } = routine
    expect(RoutineSchema.parse(older).unreadRunIds).toEqual([])
  })
})

describe('single-agent routine destinations', () => {
  it('allows no project only for single runs, on both request and response', () => {
    const single = { ...routine, agentId: '__single__', projectId: null }
    expect(RoutineDraftSchema.safeParse(single).success).toBe(true)
    expect(RoutineSchema.safeParse(single).success).toBe(true)
    expect(RoutineDraftSchema.safeParse({ ...single, agentId: 'smith' }).success).toBe(false)
    expect(RoutineDraftSchema.safeParse({ ...single, chatId: 'dm-1' }).success).toBe(false)
  })
})
