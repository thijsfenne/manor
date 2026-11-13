import { ROUTINE_RESULT_MAX_CHARS, type Routine, type ThreadEvent } from '@manor/contracts'
import { describe, expect, it } from 'vitest'
import { dmRoutineHistory, routineRuns, runWantsAttention } from '../src/routineHistory.js'
import { createMemoryStore } from '../src/stores/memoryStore.js'
import { roster, seededChat } from './helpers.js'

const routine = (overrides: Partial<Routine> = {}): Routine => ({
  id: 'routine_1',
  projectId: null,
  chatId: 'dm_1',
  agentId: 'sage',
  name: 'Mention watch',
  description: '',
  prompt: 'Check Slack.',
  cron: '0 * * * *',
  timezone: 'Europe/Amsterdam',
  enabled: true,
  notify: false,
  model: null,
  effort: null,
  nextRunAt: 10_000,
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
  createdAt: 1,
  ...overrides,
})

const prompt = (id: string, ts: number, routineId = 'routine_1'): ThreadEvent => ({
  id,
  ts,
  type: 'user_message',
  text: 'Check Slack.',
  mentions: [],
  source: 'routine',
  routineId,
  routineName: 'Mention watch',
})

const result = (
  id: string,
  ts: number,
  agentId = 'sage',
  routineOutcome?: 'quiet' | 'publish',
): ThreadEvent => ({
  id,
  ts,
  type: 'turn_result',
  agentId,
  turnId: `turn_${id}`,
  routineOutcome,
})

describe('dmRoutineHistory', () => {
  it('keeps a queued user message inside the still-running routine boundary', () => {
    const events: ThreadEvent[] = [
      prompt('routine_prompt', 100),
      { id: 'queued', ts: 110, type: 'user_message', text: 'Thanks.', mentions: [], dispatchState: 'pending' },
      result('routine_result', 120, 'sage', 'publish'),
    ]
    expect(dmRoutineHistory(routine(), events, 200)).toEqual([
      { id: 'routine_prompt', chatId: 'dm_1', startedAt: 100, state: 'done', outcome: 'publish', result: null },
    ])
  })

  it('derives done and failed fires from their own serialised turn segments', () => {
    const events: ThreadEvent[] = [
      prompt('prompt_done', 100),
      result('result_done', 120),
      { id: 'manual', ts: 200, type: 'user_message', text: 'Thanks.', mentions: [] },
      prompt('prompt_failed', 300),
      result('wrong_persona', 320, 'smith'),
      prompt('other_routine', 400, 'routine_2'),
      result('other_result', 420),
    ]

    expect(dmRoutineHistory(routine(), events, 500)).toEqual([
      { id: 'prompt_failed', chatId: 'dm_1', startedAt: 300, state: 'failed', result: null },
      { id: 'prompt_done', chatId: 'dm_1', startedAt: 100, state: 'done', result: null },
    ])
  })

  it('shows the live lease before its prompt exists and then attaches it to that prompt', () => {
    const claimed = routine({ runningSince: 500 })

    expect(dmRoutineHistory(claimed, [], 600)).toEqual([
      { id: 'lease:routine_1:500', chatId: 'dm_1', startedAt: 500, state: 'running', result: null },
    ])
    expect(dmRoutineHistory(claimed, [prompt('live_prompt', 510), result('early_result', 520)], 600)).toEqual([
      { id: 'live_prompt', chatId: 'dm_1', startedAt: 510, state: 'running', result: null },
    ])
  })

  it('carries what a finished fire put in the chat, so silence is still visible here', () => {
    // A quiet run leaves no segment in the transcript, which makes this history the
    // only surface it appears on. Reporting it as a bare "done" would make it
    // indistinguishable from the run that actually said something.
    const events: ThreadEvent[] = [
      prompt('prompt_quiet', 100),
      result('result_quiet', 120, 'sage', 'quiet'),
      prompt('prompt_spoke', 200),
      result('result_spoke', 220, 'sage', 'publish'),
      prompt('prompt_older', 300),
      result('result_older', 320),
    ]

    expect(dmRoutineHistory(routine(), events, 500)).toEqual([
      { id: 'prompt_older', chatId: 'dm_1', startedAt: 300, state: 'done', result: null },
      { id: 'prompt_spoke', chatId: 'dm_1', startedAt: 200, state: 'done', outcome: 'publish', result: null },
      { id: 'prompt_quiet', chatId: 'dm_1', startedAt: 100, state: 'done', outcome: 'quiet', result: null },
    ])
  })

  it('returns only the twenty newest fires', () => {
    const events = Array.from({ length: 25 }, (_, index) => [
      prompt(`prompt_${index}`, index * 10),
      result(`result_${index}`, index * 10 + 1),
    ]).flat()

    const history = dmRoutineHistory(routine(), events, 1_000)

    expect(history).toHaveLength(20)
    expect(history[0]).toEqual({ id: 'prompt_24', chatId: 'dm_1', startedAt: 240, state: 'done', result: null })
    expect(history.at(-1)).toEqual({ id: 'prompt_5', chatId: 'dm_1', startedAt: 50, state: 'done', result: null })
  })

  it('keeps an older unread fire beyond the twenty newest, so its dot has a row', () => {
    const events = Array.from({ length: 25 }, (_, index) => [
      prompt(`prompt_${index}`, index * 10),
      result(`result_${index}`, index * 10 + 1),
    ]).flat()

    const history = dmRoutineHistory(routine({ unreadRunIds: ['prompt_2'] }), events, 1_000)

    expect(history).toHaveLength(21)
    expect(history.at(-1)?.id).toBe('prompt_2')
  })

  it('carries the answer after the last tool call and any error, not the narration', () => {
    const events: ThreadEvent[] = [
      prompt('prompt_1', 100),
      { id: 'pre', ts: 101, type: 'agent_message', agentId: 'sage', turnId: 't', text: 'I will check Slack.' },
      { id: 'tool', ts: 102, type: 'tool_use', agentId: 'sage', turnId: 't', tool: 'Bash' },
      { id: 'answer', ts: 103, type: 'agent_message', agentId: 'sage', turnId: 't', text: 'Two tickets need you.' },
      { id: 'note', ts: 104, type: 'system_note', kind: 'error', text: 'Linear timed out once.' },
      result('result_1', 105, 'sage', 'publish'),
      prompt('prompt_2', 200),
      { id: 'long', ts: 201, type: 'agent_message', agentId: 'sage', turnId: 't2', text: 'x'.repeat(ROUTINE_RESULT_MAX_CHARS + 10) },
      result('result_2', 202, 'sage', 'publish'),
    ]

    const [long, first] = dmRoutineHistory(routine(), events, 500)

    expect(first?.result).toBe('Two tickets need you.\n\nLinear timed out once.')
    expect(first?.truncated).toBeUndefined()
    expect(long?.result).toHaveLength(ROUTINE_RESULT_MAX_CHARS)
    expect(long?.truncated).toBe(true)
  })
})

describe('routineRuns for a project routine', () => {
  it('reads one run per thread, keeps a later reply out, and fails a thread with no prompt', async () => {
    const store = createMemoryStore({ agents: roster })
    const { projectId } = await seededChat(store)
    const saved = await store.saveRoutine({
      projectId, chatId: null, agentId: 'sage', name: 'Triage', prompt: 'Check Slack.',
      cron: '0 7 * * *', timezone: 'Europe/Amsterdam', enabled: true, notify: true, model: null, effort: null,
    })
    const answered = await store.createChat({ projectId, kind: 'run', routineId: saved.id, title: 'Triage' })
    await store.appendEvent(answered.id, { type: 'user_message', text: 'Check Slack.', mentions: [], source: 'routine', routineId: saved.id })
    await store.appendEvent(answered.id, { type: 'agent_message', agentId: 'sage', turnId: 't', text: 'Nothing needed a ticket.' })
    await store.appendEvent(answered.id, { type: 'turn_result', agentId: 'sage', turnId: 't', routineOutcome: 'quiet' })
    await store.appendEvent(answered.id, { type: 'user_message', text: 'Are you sure?', mentions: [] })
    await store.appendEvent(answered.id, { type: 'agent_message', agentId: 'sage', turnId: 't2', text: 'Yes.' })
    const broken = await store.createChat({ projectId, kind: 'run', routineId: saved.id, title: 'Triage' })

    const runs = await routineRuns(store, saved, Date.now())

    expect(runs.map(({ id, chatId, state, outcome, result }) => ({ id, chatId, state, outcome, result }))).toEqual([
      { id: broken.id, chatId: broken.id, state: 'failed', outcome: undefined, result: null },
      { id: answered.id, chatId: answered.id, state: 'done', outcome: 'quiet', result: 'Nothing needed a ticket.' },
    ])
  })
})

describe('runWantsAttention', () => {
  it('asks only when notify is on, then for a failure or a published result', () => {
    expect(runWantsAttention({ notify: true }, { failed: false, outcome: 'quiet' })).toBe(false)
    expect(runWantsAttention({ notify: true }, { failed: false, outcome: 'publish' })).toBe(true)
    expect(runWantsAttention({ notify: false }, { failed: false, outcome: 'publish' })).toBe(false)
    expect(runWantsAttention({ notify: false }, { failed: true, outcome: undefined })).toBe(false)
    expect(runWantsAttention({ notify: true }, { failed: true, outcome: undefined })).toBe(true)
    // No declared outcome (a turn from before the protocol) never waits. An incomplete
    // run is not this case: it carries `publish` beside its flag, so it waits.
    expect(runWantsAttention({ notify: true }, { failed: false, outcome: undefined })).toBe(false)
  })
})
