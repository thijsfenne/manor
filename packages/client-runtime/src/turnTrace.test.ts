import { describe, expect, it } from 'vitest'
import type { SubagentSummary, ThreadEvent } from '@manor/contracts'
import { emptyThread, reduceThread } from './threadState'
import { currentActivity, settledLabel, workSummary } from './turnLabels'
import { rowsOf, type ToolStep } from './transcriptState'
import {
  activeCall,
  stepImages,
  thumbnailStrip,
  groupLabel,
  stepDetail,
  traceRows,
  activityBlocks,
  backgroundWaitLabel,
  chatSubagents,
  chatWaitsOnBackground,
  providerHelperThread,
  dmWorking,
  dmWorkingLabel,
  isPaused,
  runningSubagents,
  subagentStateOf,
  subagentElapsed,
  subagentRowModel,
  subagentNow,
  subagentState,
  COMPACTING_STATUS,
  hasFold,
  isCompacting,
  LIVE_COMPACT_DONE,
  LIVE_COMPACT_NOTE,
  turnSummary,
} from './turnTrace'
import type { TurnRow, TurnSegment } from './state'

describe('activity bundles shared by desktop and mobile', () => {
  it('combines adjacent calls and edits, but keeps narration between bundles', () => {
    const segments: TurnSegment[] = [
      { kind: 'work', key: 'work:call', steps: [{ kind: 'tool', key: 'call', tool: 'Read', status: 'done', startedAt: 1 }] },
      { kind: 'edits', key: 'edit', edits: [] },
      { kind: 'reply', key: 'message', text: 'Next step', images: [], quoteSources: [{ eventId: 'message', text: 'Next step' }] },
      { kind: 'work', key: 'work:next', steps: [] },
    ]
    expect(activityBlocks(segments)).toEqual([
      { kind: 'bundle', key: 'bundle:call', steps: [{ kind: 'tool', key: 'call', tool: 'Read', status: 'done', startedAt: 1 }], edits: [], breaks: new Set() },
      segments[2],
      { kind: 'bundle', key: 'bundle:work:next', steps: [], edits: [], breaks: new Set() },
    ])
    expect(activityBlocks([{ kind: 'edits', key: 'call', edits: [] }])[0]?.key).toBe('bundle:call')
  })

  it('never groups an opened run across a landed edit', () => {
    const call = (id: string, ts: number, tool: string, extra: object = {}): ThreadEvent[] => [
      { id: `${id}-use`, ts, type: 'tool_use', turnId: 't', agentId: 'smith', toolCallId: id, tool, ...extra } as ThreadEvent,
      { id: `${id}-done`, ts: ts + 0.5, type: 'tool_result', turnId: 't', agentId: 'smith', toolCallId: id, outcome: 'success' },
    ]
    const events: ThreadEvent[] = [
      ...call('a', 1, 'Read', { subject: 'a.ts', targets: ['/r/a.ts'] }),
      ...call('e', 2, 'Edit', { targets: ['/r/a.ts'], edits: [{ path: '/r/a.ts', before: 'x', after: 'y' }] }),
      ...call('b', 3, 'Read', { subject: 'b.ts', targets: ['/r/b.ts'] }),
      ...call('c', 4, 'Read', { subject: 'c.ts', targets: ['/r/c.ts'] }),
    ]
    const turn = rowsOf({ ...emptyThread, events }).find((row): row is TurnRow => row.kind === 'turn')!
    const bundle = activityBlocks(turn.segments).find((block) => block.kind === 'bundle')
    if (bundle?.kind !== 'bundle') throw new Error('missing bundle')
    expect(bundle.edits).toHaveLength(1)
    expect(traceRows(bundle.steps, bundle.breaks).map((row) => row.kind === 'group' ? `group:${row.steps.length}` : row.key)).toEqual(['a', 'group:2'])
  })

  it('groups calls whose rows read the same, and the opened group keeps each command', () => {
    const run = (key: string, command: string): ToolStep => ({ kind: 'tool', key, tool: 'Bash', command, detail: command, status: 'done', startedAt: 1 })
    const rows = traceRows([run('a', 'pnpm test a.test.ts'), run('b', 'pnpm test b.test.ts')])
    expect(rows.map((row) => row.kind)).toEqual(['group'])
    expect(rows[0]?.kind === 'group' && rows[0].steps.map((s) => stepDetail(s)?.command)).toEqual(['pnpm test a.test.ts', 'pnpm test b.test.ts'])
    expect(traceRows([run('a', 'pnpm test'), run('b', 'git status')]).map((row) => row.kind)).toEqual(['tool', 'tool'])
  })

  it('opens a search onto its exact pattern', () => {
    const search: ToolStep = { kind: 'tool', key: 's', tool: 'Grep', subject: '“a|b” in src', status: 'done', startedAt: 1 }
    expect(stepDetail(search)?.query).toBe('a|b')
  })

  it('stands subagent calls beside their run, and drops a run that held only them', () => {
    const read = { kind: 'tool', key: 'read', tool: 'Read', status: 'done', startedAt: 1 } as const
    const agent = { kind: 'tool', key: 'agent', tool: 'Agent', subject: 'Audit the rail', status: 'running', startedAt: 2 } as const
    expect(activityBlocks([{ kind: 'work', key: 'work:read', steps: [read, agent] }])).toEqual([
      { kind: 'bundle', key: 'bundle:read', steps: [read], edits: [], breaks: new Set() },
      { kind: 'subagents', key: 'agents:bundle:read', agents: [agent] },
    ])
    expect(activityBlocks([{ kind: 'work', key: 'work:agent', steps: [agent] }])).toEqual([
      { kind: 'subagents', key: 'agents:bundle:agent', agents: [agent] },
    ])
  })
})

describe('live compact status', () => {
  const live = {
    kind: 'turn',
    key: 'turn:1',
    turnId: 'turn-1',
    agentId: 'smith',
    asks: [],
    drafts: [],
    activities: [],
    timeline: [],
    segments: [],
    answer: [],
    tail: [],
    live: { turnId: 'turn-1', agentId: 'smith', messages: [], state: 'running', startedAt: 1 },
    note: { id: 'compact', ts: 1, type: 'system_note', kind: 'info', text: LIVE_COMPACT_NOTE },
  } as TurnRow

  it('puts Compacting in the Working slot until the hook settles', () => {
    expect(isCompacting(live)).toBe(true)
    expect(turnSummary(live)).toBe(COMPACTING_STATUS)
    expect(turnSummary({ ...live, note: { ...live.note!, text: LIVE_COMPACT_DONE } })).toBe('Working…')
  })

  it('shows the CLI’s own mid-turn compaction the same way, and only while it runs', () => {
    const { note: _note, ...working } = live
    const cli = { ...working, live: { ...live.live!, context: { contextTokens: 250_000, compacting: true } } }
    expect(isCompacting(cli)).toBe(true)
    expect(turnSummary(cli)).toBe(COMPACTING_STATUS)
    // An open trace says Compacting in its own row; the status keeps Working, one line per compaction.
    expect(turnSummary(cli, true)).toBe('Working…')
    expect(turnSummary(live, true)).toBe('Working…')
    expect(isCompacting({ ...cli, live: { ...cli.live, context: { contextTokens: 40_000, compacting: false, compacted: true } } })).toBe(false)
    expect(isCompacting({ ...cli, live: { ...cli.live, state: 'done' } })).toBe(false)
  })

  it('leaves Compacting the only active thing: the newest call settles and the plan step pauses', () => {
    const events: ThreadEvent[] = [
      { id: 'plan', ts: 1, type: 'todo_update', turnId: 't', agentId: 'smith', todos: [
        { text: 'Write the plan', status: 'completed' },
        { text: 'Build V2', status: 'in_progress' },
        { text: 'Deliver V2', status: 'pending' },
      ] },
      { id: 'edit', ts: 2, type: 'tool_use', turnId: 't', agentId: 'smith', toolCallId: 'e', tool: 'Edit', subject: 'template.html', targets: ['/r/template.html'] } as ThreadEvent,
    ]
    const turnWith = (compacting: boolean) => rowsOf({
      ...emptyThread,
      events,
      liveTurns: [{ turnId: 't', agentId: 'smith', messages: [], state: 'running', startedAt: 1, context: { compacting } }],
    }).find((row): row is TurnRow => row.kind === 'turn')!
    const statuses = (turn: TurnRow) => turn.todos?.map((todo) => todo.status)
    const timelinePlan = (turn: TurnRow) => turn.segments.find((segment) => segment.kind === 'todo')

    const compacting = turnWith(true)
    expect(activeCall(compacting, activityBlocks(compacting.segments))).toBeUndefined()
    expect(statuses(compacting)).toEqual(['completed', 'paused', 'pending'])
    expect(timelinePlan(compacting)?.kind === 'todo' && timelinePlan(compacting)?.todos.map((todo) => todo.status)).toEqual(['completed', 'paused', 'pending'])

    // Work resumes: the call reads live again and the step spins, with nothing lost.
    const working = turnWith(false)
    expect(activeCall(working, activityBlocks(working.segments))?.tool.key).toBe(compacting.activities.find((step) => step.kind === 'tool')?.key)
    expect(statuses(working)).toEqual(['completed', 'in_progress', 'pending'])
  })

  it('keeps a Compacted-only turn foldable after the reply lands', () => {
    const settled = {
      ...live,
      live: undefined,
      segments: [],
      note: { ...live.note!, text: LIVE_COMPACT_DONE },
    }
    expect(hasFold(live)).toBe(false)
    expect(hasFold(settled)).toBe(true)
  })
})

describe('a provider-run helper read as a thread', () => {
  const events: ThreadEvent[] = [
    { id: 'a', ts: 1, type: 'tool_use', turnId: 't', agentId: 'smith', toolCallId: 'agent-1', tool: 'Agent', subagent: { title: 'Audit', prompt: 'Read the rail.' } },
    { id: 'c', ts: 2, type: 'tool_use', turnId: 't', agentId: 'smith', toolCallId: 'child-1', parentToolCallId: 'agent-1', tool: 'Read', targets: ['RightRail.tsx'] },
    { id: 'd', ts: 3, type: 'tool_result', turnId: 't', agentId: 'smith', toolCallId: 'child-1', parentToolCallId: 'agent-1', outcome: 'success' },
  ]
  const helper = (more: ThreadEvent[]) => chatSubagents(rowsOf({ ...emptyThread, events: [...events, ...more] }))[0]!

  it('opens on its brief, then its steps, then its result, like a Manor child', () => {
    const done = helper([{ id: 'e', ts: 4, type: 'tool_result', turnId: 't', agentId: 'smith', toolCallId: 'agent-1', outcome: 'success', output: 'It is fine.' }])
    const rows = rowsOf(providerHelperThread(done, 'done'))
    expect(rows.map((row) => row.kind)).toEqual(['event', 'turn'])
    const [brief, turn] = rows
    expect(brief?.kind === 'event' && brief.event.type === 'user_message' && [brief.event.source, brief.event.text]).toEqual(['subagent_task', 'Read the rail.'])
    expect(turn?.kind === 'turn' && turn.activities.flatMap((step) => step.kind === 'tool' ? [step.tool] : [])).toEqual(['Read'])
    expect(turn?.kind === 'turn' && turn.answer.map((reply) => reply.text)).toEqual(['It is fine.'])
    expect(turn?.kind === 'turn' && turn.live).toBeUndefined()
  })

  it('keeps the turn live while the helper works', () => {
    const rows = rowsOf(providerHelperThread(helper([]), 'running'))
    const turn = rows.find((row): row is TurnRow => row.kind === 'turn')
    expect(turn?.live?.state).toBe('running')
  })
})

describe('subagent steps', () => {
  it('uses the child session model and effort reported when a native helper completes', () => {
    const events: ThreadEvent[] = [
      { id: 'a', ts: 1, type: 'tool_use', turnId: 't', agentId: 'smith', toolCallId: 'spawn-1', tool: 'spawn_subagent', subagent: { title: 'Render hotspots' } },
      { id: 'b', ts: 2, type: 'tool_result', turnId: 't', agentId: 'smith', toolCallId: 'spawn-1', outcome: 'success', reportedModel: 'gpt-6-sol', reportedEffort: 'high' },
    ]
    const [subagent] = chatSubagents(rowsOf({ ...emptyThread, events }))
    expect(subagent?.step.subagent).toEqual({ title: 'Render hotspots', model: 'gpt-6-sol', effort: 'high' })
  })

  it('shows an explicitly stopped helper as stopped after replay', () => {
    const events: ThreadEvent[] = [
      { id: 'a', ts: 1, type: 'tool_use', turnId: 't', agentId: 'smith', toolCallId: 'codex-1', tool: 'spawn_subagent' },
      { id: 'b', ts: 2, type: 'tool_result', turnId: 't', agentId: 'smith', toolCallId: 'codex-1', outcome: 'stopped' },
    ]
    const [subagent] = chatSubagents(rowsOf({ ...emptyThread, events }))
    expect(subagent?.step.status).toBe('stopped')
    expect(subagent && subagentState(subagent.step)).toBe('stopped')
  })

  it('keeps a helper’s own steps on its row, out of the trace, while it works', () => {
    const events: ThreadEvent[] = [
      { id: 'u', ts: 1, type: 'user_message', text: 'Audit it.', mentions: [] },
      { id: 'a', ts: 2, type: 'tool_use', turnId: 't', agentId: 'smith', toolCallId: 'agent-1', tool: 'Agent', subject: 'Audit the rail', agentType: 'Explore' },
      { id: 'c', ts: 3, type: 'tool_use', turnId: 't', agentId: 'smith', toolCallId: 'child-1', parentToolCallId: 'agent-1', tool: 'Read', targets: ['RightRail.tsx'] },
    ]
    const live = { turnId: 't', agentId: 'smith', messages: [], state: 'running' as const, startedAt: 2 }
    const rows = rowsOf({ ...emptyThread, events, liveTurns: [live] })
    const turn = rows.find((row): row is TurnRow => row.kind === 'turn')!

    expect(activityBlocks(turn.segments).map((block) => block.kind)).toEqual(['subagents'])
    const [subagent] = chatSubagents(rows)
    expect(subagent?.step.status).toBe('running')
    expect(subagent?.step.agentType).toBe('Explore')
    expect(subagent?.steps.map((step) => step.key)).toEqual(['child-1'])
    expect(subagentNow(subagent!.steps)).toBe('Reading RightRail.tsx')
  })
})

describe('the helpers running now', () => {
  const helper = (key: string, status: ToolStep['status'], childChatId?: string) => ({
    step: { kind: 'tool' as const, key, tool: 'delegate_task', status, startedAt: 1, toolCallId: `subagent_${key}`, ...(childChatId === undefined ? {} : { subagent: { childChatId } }) },
    steps: [], turnKey: 't', agentId: 'smith', turnRunning: false,
  })
  const listed = (id: string, state: SubagentSummary['state']) => ({ id, state }) as SubagentSummary

  it('lists only helpers still working, by the directory’s word over a stale launch row', () => {
    const subagents = [
      // A wait:false launch answered at once; its child still works.
      helper('detached', 'done', 'child-a'),
      // The launch row still says running, but the directory says the child ended.
      helper('ended', 'running', 'child-b'),
      helper('cancelled', 'running', 'child-c'),
      // Pruned from the directory while a cached launch row still says running.
      helper('pruned', 'running', 'child-d'),
      // A provider's own helper has no child thread: its launch row is the truth.
      helper('native', 'running'),
      helper('native-done', 'done'),
    ]
    const directory = [listed('child-a', 'running'), listed('child-b', 'done'), listed('child-c', 'cancelled')]
    const summary = (childId: string) => directory.find((child) => child.id === childId)
    expect(runningSubagents(subagents, summary).map((subagent) => subagent.step.key)).toEqual(['detached', 'native'])
    expect(runningSubagents([])).toEqual([])
    // The list and its count read the same word: a pruned child is no longer working.
    const pruned = subagents.find((subagent) => subagent.step.key === 'pruned')!
    expect(subagentStateOf(pruned, summary)).toBe('stopped')
    // Just launched by a turn still going, it may not be listed yet.
    expect(subagentStateOf({ ...pruned, turnRunning: true }, summary)).toBe('running')
  })

  it('gives a row what it does now while it runs and its answer once settled', () => {
    const launch: ToolStep = { kind: 'tool', key: 'l', tool: 'delegate_task', status: 'running', startedAt: 1_000, toolCallId: 'subagent_l', subagent: { title: 'Review the diff' } }
    const reading: ToolStep = { kind: 'tool', key: 'r', tool: 'Read', subject: 'RightRail.tsx', status: 'running', startedAt: 1_500, parentToolCallId: 'subagent_l' }
    const live = subagentRowModel(launch, [reading], 'running')
    expect(live).toMatchObject({ title: 'Review the diff', state: 'running', detail: 'Reading RightRail.tsx', status: 'Working' })
    expect(subagentElapsed(live, 66_000)).toBe('1m 5s')
    const done = subagentRowModel({ ...launch, status: 'done', output: '## Verdict\n- No **P0** in [the diff](x.md), see `a.ts`' }, [], 'done', { startedAt: 1_000, endedAt: 4_000 } as SubagentSummary)
    expect(done.detail).toBe('Verdict No P0 in the diff, see a.ts')
    expect(subagentElapsed(done, 99_000)).toBe('3s')
    // A provider's own helper reports no end, so a settled row shows no time.
    expect(subagentElapsed(subagentRowModel({ ...launch, status: 'done' }, [], 'done'), 99_000)).toBeUndefined()
  })
})

describe('waiting on background work', () => {
  const turnOf = (state: typeof emptyThread) => rowsOf(state).find((row): row is TurnRow => row.kind === 'turn')!
  const start = () => {
    let state = reduceThread(emptyThread, { type: 'turn_state', chatId: 'c', turnId: 't', agentId: 'smith', state: 'running', startedAt: 1 }, 1)
    state = reduceThread(state, { type: 'event', chatId: 'c', event: {
      id: 'launch', ts: 2, type: 'tool_use', turnId: 't', agentId: 'smith', toolCallId: 'call-a', tool: 'Agent', subject: 'Draft the figure', background: true,
    } }, 2)
    return reduceThread(state, { type: 'event', chatId: 'c', event: {
      id: 'reply', ts: 3, type: 'agent_message', turnId: 't', agentId: 'smith', messageId: 'm1', text: 'Started it.',
    } }, 3)
  }

  it('says what an answered turn waits on instead of Working, and goes back when the wait ends', () => {
    let state = start()
    // The helper's call returned at once: it is not what the turn is doing right now.
    expect(currentActivity(turnOf(state))).toBeUndefined()
    expect(turnSummary(turnOf(state))).toBe('Working…')
    state = reduceThread(state, { type: 'turn_background', chatId: 'c', turnId: 't', agentId: 'smith', agents: 3, commands: 0 }, 4)
    expect(turnSummary(turnOf(state))).toBe('Waiting on 3 background agents…')
    expect(isPaused(turnOf(state))).toBe(true)
    state = reduceThread(state, { type: 'turn_background', chatId: 'c', turnId: 't', agentId: 'smith', agents: 0, commands: 0 }, 5)
    expect(turnSummary(turnOf(state))).toBe('Working…')
    expect(turnOf(state).live?.background).toBeUndefined()
  })

  it('keeps a background command running while later calls come and go', () => {
    let state = reduceThread(emptyThread, { type: 'turn_state', chatId: 'c', turnId: 't', agentId: 'smith', state: 'running', startedAt: 1 }, 1)
    state = reduceThread(state, { type: 'event', chatId: 'c', event: {
      id: 'build', ts: 2, type: 'tool_use', turnId: 't', agentId: 'smith', toolCallId: 'call-b', tool: 'Bash', command: 'pnpm build', detail: 'pnpm build', background: true,
    } }, 2)
    state = reduceThread(state, { type: 'event', chatId: 'c', event: {
      id: 'read', ts: 3, type: 'tool_use', turnId: 't', agentId: 'smith', toolCallId: 'call-r', tool: 'Read', subject: 'a.ts',
    } }, 3)
    state = reduceThread(state, { type: 'event', chatId: 'c', event: {
      id: 'read-done', ts: 4, type: 'tool_result', turnId: 't', agentId: 'smith', toolCallId: 'call-r', outcome: 'success',
    } }, 4)
    const turn = turnOf(state)
    const build = turn.activities.find((step) => step.kind === 'tool' && step.toolCallId === 'call-b')
    expect(build).toMatchObject({ status: 'running', background: true })
    // Folded or open, the row says it is still going rather than past tense.
    expect(build?.kind === 'tool' && settledLabel(build)).toBe('Building the app')
    expect(workSummary(turn.activities).label).toBe('Read files, running a command')
  })

  it('reads open background work as stopped once Stop ends its turn', () => {
    let state = reduceThread(start(), { type: 'event', chatId: 'c', event: {
      id: 'build', ts: 4, type: 'tool_use', turnId: 't', agentId: 'smith', toolCallId: 'call-b', tool: 'Bash', command: 'pnpm build', detail: 'pnpm build', background: true,
    } }, 4)
    state = reduceThread(state, { type: 'event', chatId: 'c', event: {
      id: 'stop', ts: 5, type: 'system_note', kind: 'aborted', turnId: 't', agentId: 'smith', text: 'Stopped.',
    } }, 5)
    state = reduceThread(state, { type: 'turn_state', chatId: 'c', turnId: 't', agentId: 'smith', state: 'aborted' }, 5)
    const steps = turnOf(state).activities.filter((step) => step.kind === 'tool')
    const helper = steps.find((step) => step.toolCallId === 'call-a')!
    const build = steps.find((step) => step.toolCallId === 'call-b')!
    expect(subagentState(helper)).toBe('stopped')
    expect(build.status).toBe('stopped')
    expect(settledLabel(build)).toBe('Stopped pnpm build')
  })

  it('runs the same helper row again when its agent resumes, keeping its steps', () => {
    let state = start()
    const send = (id: string, event: Record<string, unknown>) => {
      state = reduceThread(state, { type: 'event', chatId: 'c', event: { id, ts: Number(id.slice(1)), turnId: 't', agentId: 'smith', ...event } as ThreadEvent }, 9)
    }
    send('e4', { type: 'tool_use', toolCallId: 'child-read', parentToolCallId: 'call-a', tool: 'Read', subject: 'a.ts' })
    send('e5', { type: 'tool_result', toolCallId: 'call-a', outcome: 'success', output: 'First answer.' })
    send('e6', { type: 'tool_use', toolCallId: 'call-a', tool: 'Agent', subject: 'Draft the figure', background: true })
    const helpers = chatSubagents(rowsOf(state))
    expect(helpers.map(({ step }) => ({ id: step.toolCallId, status: step.status, output: step.output }))).toEqual([
      { id: 'call-a', status: 'running', output: undefined },
    ])
    expect(helpers[0]!.steps.map((step) => step.kind === 'tool' && step.toolCallId)).toEqual(['child-read'])
  })

  it('keeps a Manor child running past its turn, reading the turn as waiting until the result', () => {
    let state = reduceThread(emptyThread, { type: 'turn_state', chatId: 'c', turnId: 't', agentId: 'smith', state: 'running', startedAt: 1 }, 1)
    state = reduceThread(state, { type: 'event', chatId: 'c', event: {
      id: 'launch', ts: 2, type: 'tool_use', turnId: 't', agentId: 'smith', toolCallId: 'subagent_1', tool: 'spawn_subagent', subject: 'Count the files',
      subagent: { title: 'Count the files', prompt: 'Count the files.', model: 'gpt-6.1-sol', effort: 'high', driver: 'codex', childChatId: 'child-1' },
    } }, 2)
    state = reduceThread(state, { type: 'event', chatId: 'c', event: {
      id: 'reply', ts: 3, type: 'agent_message', turnId: 't', agentId: 'smith', messageId: 'm1', text: 'Counting in the background.',
    } }, 3)
    state = reduceThread(state, { type: 'event', chatId: 'c', event: { id: 'end', ts: 4, type: 'turn_result', turnId: 't', agentId: 'smith' } }, 4)
    state = reduceThread(state, { type: 'turn_state', chatId: 'c', turnId: 't', agentId: 'smith', state: 'done' }, 4)
    expect(turnOf(state).activities.find((step) => step.kind === 'tool')).toMatchObject({ status: 'running' })
    expect(turnSummary(turnOf(state))).toBe('Waiting on 1 background agent…')
    expect(chatWaitsOnBackground(rowsOf(state))).toBe(true)

    state = reduceThread(state, { type: 'event', chatId: 'c', event: {
      id: 'back', ts: 9, type: 'tool_result', turnId: 't', agentId: 'smith', toolCallId: 'subagent_1', outcome: 'success', output: 'There are 4 files.',
    } }, 9)
    expect(turnOf(state).activities.find((step) => step.kind === 'tool')).toMatchObject({ status: 'done' })
    expect(turnSummary(turnOf(state))).not.toContain('Waiting')
    expect(chatWaitsOnBackground(rowsOf(state))).toBe(false)
  })

  it('keeps a live session\'s background agent and command running past an answered turn, until each result', () => {
    let state = reduceThread(emptyThread, { type: 'turn_state', chatId: 'c', turnId: 't', agentId: 'smith', state: 'running', startedAt: 1 }, 1)
    const send = (event: Record<string, unknown>) => {
      state = reduceThread(state, { type: 'event', chatId: 'c', event: { turnId: 't', agentId: 'smith', ...event } as ThreadEvent }, Number(event.ts))
    }
    send({ id: 'agent', ts: 2, type: 'tool_use', toolCallId: 'call-agent', tool: 'Agent', subject: 'Audit the repo', background: true })
    send({ id: 'bash', ts: 3, type: 'tool_use', toolCallId: 'call-bash', tool: 'Bash', command: 'sleep 60', detail: 'sleep 60', background: true })
    send({ id: 'reply', ts: 4, type: 'agent_message', messageId: 'm1', text: 'Both are running.' })
    send({ id: 'end', ts: 5, type: 'turn_result' })
    state = reduceThread(state, { type: 'turn_state', chatId: 'c', turnId: 't', agentId: 'smith', state: 'done' }, 5)
    expect(turnSummary(turnOf(state))).toBe('Waiting on 1 background agent and 1 command…')
    expect(chatWaitsOnBackground(rowsOf(state))).toBe(true)

    send({ id: 'agent-end', ts: 9, type: 'tool_result', toolCallId: 'call-agent', outcome: 'success', output: 'Clean.' })
    expect(turnSummary(turnOf(state))).toBe('Waiting on 1 background command…')
    send({ id: 'bash-end', ts: 10, type: 'tool_result', toolCallId: 'call-bash', outcome: 'stopped' })
    expect(turnOf(state).activities.filter((step) => step.kind === 'tool').map((step) => step.kind === 'tool' && step.status))
      .toEqual(['done', 'stopped'])
    expect(chatWaitsOnBackground(rowsOf(state))).toBe(false)
  })

  it('marks a row background when Codex announces it at the answer, but never reopens one that ended', () => {
    let state = reduceThread(emptyThread, { type: 'turn_state', chatId: 'c', turnId: 't', agentId: 'sage', state: 'running', startedAt: 1 }, 1)
    const send = (event: Record<string, unknown>) => {
      state = reduceThread(state, { type: 'event', chatId: 'c', event: { turnId: 't', agentId: 'sage', ...event } as ThreadEvent }, Number(event.ts))
    }
    send({ id: 'serve', ts: 2, type: 'tool_use', toolCallId: 'shell-1', tool: 'Bash', command: 'npm run dev', detail: 'npm run dev' })
    send({ id: 'check', ts: 3, type: 'tool_use', toolCallId: 'shell-2', tool: 'Bash', command: 'npm test', detail: 'npm test' })
    send({ id: 'check-end', ts: 4, type: 'tool_result', toolCallId: 'shell-2', outcome: 'success' })
    send({ id: 'serve-bg', ts: 5, type: 'tool_use', toolCallId: 'shell-1', tool: 'Bash', command: 'npm run dev', detail: 'npm run dev', background: true })
    send({ id: 'check-bg', ts: 6, type: 'tool_use', toolCallId: 'shell-2', tool: 'Bash', command: 'npm test', detail: 'npm test', background: true })
    send({ id: 'end', ts: 7, type: 'turn_result' })
    state = reduceThread(state, { type: 'turn_state', chatId: 'c', turnId: 't', agentId: 'sage', state: 'done' }, 7)
    const tools = () => turnOf(state).activities.filter((step) => step.kind === 'tool')
    expect(tools().map((step) => step.kind === 'tool' && [step.toolCallId, step.status, step.background])).toEqual([
      ['shell-1', 'running', true],
      ['shell-2', 'done', undefined],
    ])
    expect(turnSummary(turnOf(state))).toBe('Waiting on 1 background command…')
  })

  it('names a single command, and both kinds together', () => {
    const waiting = (agents: number, commands: number) => backgroundWaitLabel(turnOf(reduceThread(start(),
      { type: 'turn_background', chatId: 'c', turnId: 't', agentId: 'smith', agents, commands }, 4)))
    expect(waiting(0, 1)).toBe('Waiting on 1 background command')
    expect(waiting(1, 2)).toBe('Waiting on 1 background agent and 2 commands')
  })
})

describe('work summary after failed calls', () => {
  const step = (key: string, tool: string, status: ToolStep['status']): ToolStep => ({ kind: 'tool', key, tool, status, startedAt: 1 })

  it('reads a kind whose every call failed as an attempt, and keeps one success as the work', () => {
    expect(workSummary([step('a', 'Read', 'error'), step('b', 'Read', 'error'), step('c', 'Bash', 'done')]).label)
      .toBe('Tried to read files, ran a command')
    expect(workSummary([step('a', 'Read', 'error'), step('b', 'Read', 'done')]).label).toBe('Read files')
    expect(workSummary([step('a', 'Bash', 'error'), step('b', 'Bash', 'error')]).label).toBe('Tried to run commands')
    // Landed diffs are proof the edit happened, whatever the edit call reported.
    expect(workSummary([step('a', 'Edit', 'error'), step('b', 'Read', 'done')], true).label).toBe('Edited files, read files')
  })
})

describe('the DM working indicator', () => {
  const START = 1_786_500_000_000
  let id = 0
  const event = (partial: Partial<ThreadEvent> & { type: ThreadEvent['type'] }, at = START): ThreadEvent =>
    ({ id: `evt_${(id += 1)}`, ts: at, ...partial }) as ThreadEvent
  const live = (startedAt = START) => [{ turnId: 't1', agentId: 'smith', messages: [], state: 'running' as const, startedAt }]
  const rows = (events: ThreadEvent[], liveTurns: ReturnType<typeof live> = [], pending = false) => rowsOf({
    ...emptyThread,
    events,
    liveTurns,
    pending: pending ? [{ key: 'p1', text: 'And this', images: [], files: [], pageContexts: [] }] : [],
    hasSnapshot: true,
  }, 'dm')
  const sent = event({ type: 'user_message', text: 'Look into it', mentions: [] })

  it('stands for a running turn and leaves the moment it ends', () => {
    expect(dmWorking(rows([sent], live()))?.kind).toBe('turn')
    expect(dmWorking(rows([sent, event({ type: 'agent_message', agentId: 'smith', turnId: 't1', messageId: 'm1', text: 'Done.' }), event({ type: 'turn_result', agentId: 'smith', turnId: 't1' })]))).toBeUndefined()
  })

  it('stands for a message no turn has picked up yet', () => {
    expect(dmWorking(rows([], [], true))).toEqual({ kind: 'sent' })
    // Once the server acknowledges it, until a turn draws its first row.
    expect(dmWorking(rows([{ ...sent, dispatchState: 'pending' } as ThreadEvent]))).toEqual({ kind: 'sent' })
    expect(dmWorking(rows([{ ...sent, dispatchState: 'started' } as ThreadEvent]))).toEqual({ kind: 'sent' })
    const answered = [{ ...sent, dispatchState: 'started' } as ThreadEvent, event({ type: 'agent_message', agentId: 'smith', turnId: 't1', messageId: 'm1', text: 'Done.' }), event({ type: 'turn_result', agentId: 'smith', turnId: 't1' })]
    expect(dmWorking(rows(answered))).toBeUndefined()
  })

  it('goes while the turn holds for the user’s answer', () => {
    const ask = event({ type: 'user_input_request', agentId: 'smith', turnId: 't1', requestId: 'r1', questions: [{ id: 'q', question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] } as Partial<ThreadEvent> & { type: 'user_input_request' })
    expect(dmWorking(rows([sent, ask], live()))).toBeUndefined()
  })

  it('waits on a consulted colleague only while her pair chat runs and no later turn started', () => {
    const relay = event({ type: 'agent_relay', agentId: 'smith', peerAgentId: 'iris', pairChatId: 'pair', turnId: 't1', relayId: 'r1', phase: 'sent' })
    const asked = [sent, event({ type: 'turn_result', agentId: 'smith', turnId: 't1' }), relay]
    expect(dmWorking(rows(asked), new Set(['pair']))).toEqual({ kind: 'consult', agentId: 'smith', peerAgentId: 'iris' })
    // A restart cut the relay off without a failed marker: no spinner for dead work.
    expect(dmWorking(rows(asked), new Set())).toBeUndefined()
    // A routine's handoff expects no reply, even while the pair chat runs something else.
    expect(dmWorking(rows([sent, event({ type: 'turn_result', agentId: 'smith', turnId: 't1' }), { ...relay, handoff: true } as ThreadEvent]), new Set(['pair']))).toBeUndefined()
    const back = event({ type: 'agent_relay', agentId: 'smith', peerAgentId: 'iris', pairChatId: 'pair', turnId: 't1', relayId: 'r1', phase: 'received' })
    expect(dmWorking(rows([...asked, back]), new Set(['pair']))).toBeUndefined()
    const later = [...asked, event({ type: 'user_message', text: 'Never mind', mentions: [] }), event({ type: 'agent_message', agentId: 'smith', turnId: 't2', messageId: 'm2', text: 'Ok.' }), event({ type: 'turn_result', agentId: 'smith', turnId: 't2' })]
    expect(dmWorking(rows(later), new Set(['pair']))).toBeUndefined()
  })

  it('keeps waiting when the relay landed before its own turn’s first event, and stops with that turn', () => {
    const relay = event({ type: 'agent_relay', agentId: 'smith', peerAgentId: 'iris', pairChatId: 'pair', turnId: 't1', relayId: 'r1', phase: 'sent' })
    const early = [sent, relay, event({ type: 'agent_message', agentId: 'smith', turnId: 't1', messageId: 'm1', text: 'Asked Iris.' }), event({ type: 'turn_result', agentId: 'smith', turnId: 't1' })]
    expect(dmWorking(rows(early), new Set(['pair']))).toEqual({ kind: 'consult', agentId: 'smith', peerAgentId: 'iris' })
    const stopped = [sent, relay, event({ type: 'system_note', kind: 'aborted', agentId: 'smith', turnId: 't1', text: 'Smith’s turn was stopped.' })]
    expect(dmWorking(rows(stopped), new Set(['pair']))).toBeUndefined()
    const failed = [sent, relay, event({ type: 'system_note', kind: 'error', agentId: 'smith', turnId: 't1', text: 'Smith could not answer.' })]
    expect(dmWorking(rows(failed), new Set(['pair']))).toBeUndefined()
    // A recoverable error earlier in the same turn is not how it ended.
    const recovered = [sent, event({ type: 'system_note', kind: 'error', agentId: 'smith', turnId: 't1', text: 'Draft refused.' }), event({ type: 'agent_message', agentId: 'smith', turnId: 't1', messageId: 'm1', text: 'Asked Iris.' })]
    expect(dmWorking(rows([...recovered, relay, event({ type: 'turn_result', agentId: 'smith', turnId: 't1' })]), new Set(['pair']))).toEqual({ kind: 'consult', agentId: 'smith', peerAgentId: 'iris' })
    expect(dmWorking(rows([sent, relay, ...recovered.slice(1), event({ type: 'turn_result', agentId: 'smith', turnId: 't1' })]), new Set(['pair']))).toEqual({ kind: 'consult', agentId: 'smith', peerAgentId: 'iris' })
  })

  it('thinks first, then names the kind of work, never its arguments', () => {
    const reading = rows([sent, event({ type: 'tool_use', agentId: 'smith', turnId: 't1', toolCallId: 'c1', tool: 'Read', targets: ['/secret/path.ts'] })], live())
    const turn = reading.find((row): row is TurnRow => row.kind === 'turn')!
    expect(dmWorkingLabel(turn, START + 1_000)).toBe('Thinking…')
    expect(dmWorkingLabel(turn, START + 10_000)).toBe('Reading…')
    expect(dmWorkingLabel(undefined, START)).toBe('Thinking…')
    const writing = { ...turn, live: { ...turn.live!, messages: [{ messageId: 'm1', text: 'Half' }] } }
    expect(dmWorkingLabel(writing, START + 10_000)).toBe('Writing…')
  })

  it('says a long turn takes a while, taking turns with what it is doing', () => {
    const turn = rows([sent, event({ type: 'tool_use', agentId: 'smith', turnId: 't1', toolCallId: 'c1', tool: 'Bash', command: 'pnpm test' })], live())
      .find((row): row is TurnRow => row.kind === 'turn')!
    expect(dmWorkingLabel(turn, START + 30_000)).toBe('Running a command…')
    expect(dmWorkingLabel(turn, START + 50_000)).toBe('Still working. This one takes a while.')
    expect(dmWorkingLabel(turn, START + 60_000)).toBe('Running a command…')
    expect(dmWorkingLabel(turn, START + 70_000)).toBe('Still working. This one takes a while.')
  })
})


describe('trace rows', () => {
  const tool = (key: string, toolName: string, extra: Partial<ToolStep> = {}): ToolStep =>
    ({ kind: 'tool', key, tool: toolName, status: 'done', startedAt: 0, ...extra }) as ToolStep

  it('folds consecutive reads, searches and identical calls, and lets a failure break the run', () => {
    const rows = traceRows([
      tool('a', 'Read', { targets: ['src/a.ts'] }),
      tool('b', 'Read', { targets: ['src/b.ts'] }),
      tool('c', 'Read', { targets: ['src/a.ts'] }),
      tool('d', 'Grep', { subject: '“foo” in src' }),
      tool('e', 'mcp__manor__task_result'),
      tool('f', 'mcp__manor__task_result'),
      tool('g', 'mcp__manor__task_result', { status: 'error', error: 'Unknown task id' }),
      tool('h', 'mcp__manor__task_result'),
    ])
    expect(rows.map((row) => row.kind === 'group' ? `${row.family}:${row.steps.length}` : row.key)).toEqual(['read:3', 'd', 'same:2', 'g', 'h'])
    const [reads, , polls] = rows
    expect(reads?.kind === 'group' ? groupLabel(reads) : '').toBe('Read a.ts, b.ts')
    expect(polls?.kind === 'group' ? groupLabel(polls) : '').toBe('Checked on a helper')
  })

  it('never groups different shell commands', () => {
    const rows = traceRows([
      tool('a', 'Shell', { detail: 'pnpm build' }),
      tool('b', 'Shell', { detail: 'pnpm lint' }),
    ])
    expect(rows.map((row) => row.kind)).toEqual(['tool', 'tool'])
  })

  it('opens a step onto its command, paths and failure reason, or onto nothing', () => {
    expect(stepDetail(tool('a', 'Shell', { command: 'pnpm build', status: 'error', error: 'exit 1' })))
      .toEqual({ command: 'pnpm build', error: 'exit 1' })
    expect(stepDetail(tool('b', 'Read', { targets: ['/repo/src/a.ts'] }))).toEqual({ targets: ['/repo/src/a.ts'] })
    expect(stepDetail(tool('c', 'mcp__manor__goal_reached'))).toBeUndefined()
  })
})

describe('trace thumbnails', () => {
  const read = (key: string, targets: string[], status: ToolStep['status'] = 'done'): ToolStep =>
    ({ kind: 'tool', key, tool: 'Read', targets, images: targets.map((target) => ({ target, src: `/media/${key}/${target}` })), status, startedAt: 1 })

  it('shows each picture once, none from an unfinished or failed call, and counts past the first two', () => {
    const images = stepImages([
      read('a', ['/x/1.png']),
      read('b', ['/x/1.png', '/x/2.png']),
      read('c', ['/x/3.png'], 'error'),
      read('r', ['/x/6.png'], 'running'),
      read('d', ['/x/4.png', '/x/5.png']),
    ])
    expect(images.map((image) => image.key)).toEqual(['/x/1.png', '/x/2.png', '/x/4.png', '/x/5.png'])
    expect(images[0]).toEqual({ key: '/x/1.png', src: '/media/a//x/1.png', name: '1.png' })
    const strip = thumbnailStrip(images)
    expect(strip.shown.map((image) => image.key)).toEqual(['/x/1.png', '/x/2.png'])
    expect(strip.more).toBe(2)
    expect(thumbnailStrip(images.slice(0, 1))).toEqual({ shown: images.slice(0, 1), more: 0 })
  })
})
