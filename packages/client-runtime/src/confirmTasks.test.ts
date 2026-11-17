import type { ConfirmRequest, ThreadEvent, WorkHandoff } from '@manor/contracts'
import { describe, expect, it } from 'vitest'
import { completionFor, confirmRequestOf, confirmTasks, confirmTitle, confirmWork, foldsWhenDone, planRowKeys, planStanding, planTitle, type TaskLine } from './confirmTasks'
import { projectWorkHandoffs, rowsOf } from './transcriptState'
import { emptyThread } from './threadState'

const message = (text: string, extra: Partial<Extract<ThreadEvent, { type: 'user_message' }>> = {}): Extract<ThreadEvent, { type: 'user_message' }> =>
  ({ id: 'request_1', ts: 1, type: 'user_message', text, mentions: [], ...extra })
const tree = '- worktree /wt/manor on branch manor/session-1, linked folder /repo/Manor'

describe('Confirm tasks', () => {
  it('reads the live status only on the newest attempt, so a retried request stops spinning', () => {
    const completion = { status: 'pending' as const, operation: 'merge' as const, requestEventId: 'confirm', retries: ['retry_1'], repos: [] }
    const handoffs = [{ id: 'h', goalCompletion: completion } as unknown as WorkHandoff]
    expect(completionFor(handoffs, 'retry_1')?.status).toBe('pending')
    expect(completionFor(handoffs, 'confirm')?.status).toBe('blocked')
    expect(completionFor(handoffs, 'other')).toBeUndefined()
  })

  it('reads a request stored before it carried its own data, in each variant and the older wording', () => {
    expect(confirmRequestOf(message("[Manor] The user confirmed the goal, and that is their approval to commit. @Sage, commit this Session's reviewed changes now: …")))
      .toEqual({ variant: 'checkout', worktrees: [] })
    expect(confirmRequestOf(message(`[Manor] The user confirmed the ready result, and that is their approval to commit, not to merge. Commit …\n${tree}`)))
      .toEqual({ variant: 'worktree', worktrees: [{ branch: 'manor/session-1', folder: 'Manor', source: '/repo/Manor' }] })
    expect(confirmRequestOf(message(`[Manor] The user confirmed the ready result, and that is their approval to commit and to merge into main. For each worktree below:\n1. …\n${tree}`)))
      .toMatchObject({ variant: 'merge', mergeInto: 'main' })
    expect(confirmRequestOf(message(`[Manor] The user confirmed the ready result, and that is their approval to commit. The merge into main is withheld: the branches …\n- manor/session-1: abc Earlier\n${tree}`)))
      .toMatchObject({ variant: 'merge_withheld', mergeInto: 'main' })
    // A request stored while the server still named the person reads the same.
    expect(confirmRequestOf(message(`[Manor] Robin confirmed the ready result, and that is his approval to commit, not to merge. Commit …\n${tree}`)))
      .toEqual(confirmRequestOf(message(`[Manor] The user confirmed the ready result, and that is their approval to commit, not to merge. Commit …\n${tree}`)))
    expect(confirmRequestOf(message('The user confirmed the ready result, and that is their approval to commit.'))).toBeUndefined()
  })

  it('runs Commit then Merge in order, one spinner at a time, and fails the step that failed', () => {
    const merge = { variant: 'merge' as const, worktrees: [{ branch: 'manor/session-1', folder: 'Manor', source: '/repo/Manor' }], mergeInto: 'main' }
    const statuses = (progress: Parameters<typeof confirmTasks>[1], completion?: Parameters<typeof confirmTasks>[2]) =>
      confirmTasks(merge, progress, completion).map((line) => line.status)
    expect(confirmTasks(merge, 'pending')).toEqual([
      { text: 'Commit this Session’s changes on manor/session-1', status: 'pending' },
      { text: 'Merge into main', status: 'pending' },
    ])
    const git = { status: 'pending' as const, operation: 'merge' as const, repos: [{ path: '/wt/manor', sourcePath: '/repo/Manor', branch: 'manor/session-1', before: 'a', tree: 'b', files: ['x'] }] }
    expect(statuses('running', git)).toEqual(['in_progress', 'pending'])
    expect(statuses('running', { ...git, committed: ['/wt/manor'] })).toEqual(['completed', 'in_progress'])
    expect(statuses('ended', { ...git, committed: ['/wt/manor'] })).toEqual(['completed', 'in_progress'])
    expect(statuses('ended', { ...git, status: 'complete' })).toEqual(['completed', 'completed'])
    expect(statuses('ended', { ...git, status: 'blocked', committed: ['/wt/manor'] })).toEqual(['completed', 'blocked'])
    expect(statuses('ended', { ...git, status: 'blocked' })).toEqual(['blocked', 'pending'])
    expect(statuses('failed', git)).toEqual(['blocked', 'pending'])
    // Compacting pauses the current step until the turn works again.
    expect(statuses('compacting', git)).toEqual(['paused', 'pending'])
    // A request from before it named its folder matches by folder and branch, and never ticks a miss.
    const legacy = { ...merge, worktrees: [{ branch: 'manor/session-1', folder: 'Manor' }] }
    expect(confirmTasks(legacy, 'running', { ...git, committed: ['/wt/manor'] }).map((line) => line.status)).toEqual(['completed', 'in_progress'])
    expect(confirmTasks(legacy, 'running', { ...git, repos: [] }).map((line) => line.status)).toEqual(['in_progress', 'pending'])
    expect(confirmTasks({ ...merge, variant: 'merge_withheld' }, 'running')).toEqual([
      { text: 'Commit this Session’s changes on manor/session-1', status: 'in_progress' },
      { text: 'Merge into main, held back for earlier commits', status: 'blocked' },
    ])
  })

  it('keeps one spinner across several repos on the same branch, and fails the repo that failed', () => {
    // Manor gives every repo of a Session the same branch; the folder tells them apart.
    const request = { variant: 'merge' as const, worktrees: [{ branch: 'manor/s', folder: 'A', source: '/repos/A' }, { branch: 'manor/s', folder: 'B', source: '/repos/B' }], mergeInto: 'main' }
    const repo = (name: string) => ({ path: `/wt/${name}`, sourcePath: `/repos/${name}`, branch: 'manor/s', before: 'a', tree: 'b', files: ['x'] })
    const git = { status: 'pending' as const, operation: 'merge' as const, repos: [repo('A'), repo('B')] }
    const statuses = (progress: Parameters<typeof confirmTasks>[1], completion: Parameters<typeof confirmTasks>[2]) =>
      confirmTasks(request, progress, completion).map((line) => line.status)
    expect(statuses('running', { ...git, committed: ['/wt/A'] })).toEqual(['completed', 'in_progress', 'pending', 'pending'])
    // A merged before B committed: A's merge stays ticked, B's commit spins.
    expect(statuses('running', { ...git, committed: ['/wt/A'], merged: ['/wt/A'] })).toEqual(['completed', 'in_progress', 'completed', 'pending'])
    expect(statuses('ended', { ...git, status: 'blocked', committed: ['/wt/A', '/wt/B'], merged: ['/wt/A'] }))
      .toEqual(['completed', 'completed', 'completed', 'blocked'])
    // A repo the Session did not change has nothing to commit.
    expect(statuses('running', { ...git, repos: [repo('A')], committed: ['/wt/A'] })).toEqual(['completed', 'completed', 'in_progress', 'completed'])
  })

  it('ticks a shared checkout’s Commit only once every repo committed', () => {
    const repo = (name: string) => ({ path: `/repos/${name}`, branch: 'main', before: 'a', tree: 'b', files: ['x'] })
    const git = { status: 'blocked' as const, operation: 'commit' as const, repos: [repo('A'), repo('B')], committed: ['/repos/A'] }
    expect(confirmTasks({ variant: 'checkout', worktrees: [] }, 'ended', git).map((line) => line.status)).toEqual(['blocked'])
  })

  it('puts the card on the request row, from the stored data and the handoff Git answered', () => {
    const request = message('[Manor] The user confirmed the ready result, and that is their approval to commit. Commit …', {
      confirmRequest: { variant: 'checkout', worktrees: [] },
    })
    const handoff = (workChatId: string, status: string) => ({
      id: `h-${workChatId}`, workChatId, goalCompletion: { status, operation: 'commit', repos: [], requestEventId: request.id },
    }) as unknown as WorkHandoff
    const later = message('Something else.', { id: 'later', ts: 2 })
    const turn = [
      { id: 't1', ts: 3, type: 'agent_message' as const, turnId: 'turn-later', agentId: 'smith', text: 'Other work.' },
      { id: 't2', ts: 4, type: 'turn_result' as const, turnId: 'turn-later', agentId: 'smith' },
    ]
    const rows = rowsOf({ ...emptyThread, hasSnapshot: true, events: [request, later, ...turn] })
    // Event ids repeat across chats: another Session's completion must not answer this one.
    const shown = projectWorkHandoffs(rows, [handoff('other', 'complete'), handoff('mine', 'blocked')], [], [], [], {}, undefined, 'mine')
    expect(shown[0]).toMatchObject({ kind: 'event', confirmTasks: [{ text: 'Commit this Session’s changes', status: 'blocked' }] })
    // A later turn after another message is not the commit turn.
    expect(projectWorkHandoffs(rows, [], [], [], [], {}, undefined, 'mine')[0]).toMatchObject({ confirmTasks: [{ status: 'pending' }] })
    expect(projectWorkHandoffs(rows, [], [], [], [])[0]).not.toHaveProperty('confirmTasks')
  })

  it('follows Git alone on a request Manor commits itself, since no turn answers it', () => {
    const request = message('[Manor] The user confirmed the ready result, and that is their approval to commit and to merge into main. Manor commits …', {
      confirmRequest: { variant: 'merge', worktrees: [{ branch: 'manor/session-1', folder: 'Manor', source: '/repo/Manor' }], mergeInto: 'main', manor: true },
    })
    const rows = rowsOf({ ...emptyThread, hasSnapshot: true, events: [request] })
    const handoff = (completion: object) => ({ id: 'h', workChatId: 'mine', goalCompletion: { operation: 'merge', requestEventId: request.id,
      repos: [{ path: '/wt/manor', branch: 'manor/session-1', sourcePath: '/repo/Manor', mergeInto: 'main', before: '', tree: '', files: [] }], ...completion } }) as unknown as WorkHandoff
    const steps = (completion: object) => projectWorkHandoffs(rows, [handoff(completion)], [], [], [], {}, undefined, 'mine')[0]
    expect(steps({ status: 'pending' })).toMatchObject({ confirmTasks: [{ status: 'in_progress' }, { status: 'pending' }] })
    expect(steps({ status: 'pending', committed: ['/wt/manor'], merge: { stage: 'merging' } }))
      .toMatchObject({ confirmTasks: [{ status: 'completed' }, { status: 'in_progress' }] })
    expect(steps({ status: 'complete' })).toMatchObject({ confirmTasks: [{ status: 'completed' }, { status: 'completed' }] })
  })

  it('reads a plan as a sequence: one spinner while the turn runs, none and no open step after it', () => {
    // The recorded plan of the live-context Session (bb7e150e, evt_000099), shortened.
    const plan: ThreadEvent = { id: 'plan', ts: 2, type: 'todo_update', turnId: 'turn-1', agentId: 'smith', todos: [
      { text: 'Map', status: 'completed' },
      { text: 'Check per driver', status: 'in_progress' },
      { text: 'Add contract event', status: 'completed' },
      { text: 'Server turn stream', status: 'in_progress' },
      { text: 'Emit from each driver', status: 'pending' },
    ] }
    const turnOf = (events: ThreadEvent[], running: boolean) => rowsOf({
      ...emptyThread, hasSnapshot: true, events,
      liveTurns: running ? [{ turnId: 'turn-1', agentId: 'smith', state: 'running', startedAt: 2, messages: [] }] : [],
    }).find((row) => row.kind === 'turn')
    const statuses = (events: ThreadEvent[], running: boolean) => {
      const turn = turnOf(events, running)
      const todo = turn?.kind === 'turn' ? turn.timeline.find((item) => item.kind === 'todo') : undefined
      expect(todo?.kind === 'todo' ? todo.todos : undefined).toEqual(turn?.kind === 'turn' ? turn.todos : undefined)
      return turn?.kind === 'turn' ? turn.todos?.map((todo) => todo.status) : undefined
    }
    // Several in progress: the first spins, the later one waits; a step done out of order stays done.
    expect(statuses([plan], true)).toEqual(['completed', 'in_progress', 'completed', 'pending', 'pending'])
    // The turn ended without ticking the rest: nothing spins, and nothing reads as still to do.
    const result = { id: 'result', ts: 5, type: 'turn_result' as const, turnId: 'turn-1', agentId: 'smith' }
    expect(statuses([plan, result], false)).toEqual(['completed', 'skipped', 'completed', 'skipped', 'skipped'])
    // A turn whose goal Manor accepted claimed every step verified (Session e033ee9e,
    // evt_000155: the plan stopped at step six of nine, the work did not).
    const goal: ThreadEvent[] = [
      { id: 'goal', ts: 3, type: 'tool_use', turnId: 'turn-1', agentId: 'smith', toolCallId: 'g', tool: 'mcp__manor__goal_reached' },
      { id: 'goal-result', ts: 4, type: 'tool_result', turnId: 'turn-1', agentId: 'smith', toolCallId: 'g', outcome: 'success' },
    ]
    const accepted: ThreadEvent = { id: 'reached', ts: 6, type: 'system_note', kind: 'info', agentId: 'smith', text: 'Smith marked the goal reached.', workGoalHandoffId: 'h1' }
    expect(statuses([plan, ...goal, result, accepted], false)).toEqual(['completed', 'completed', 'completed', 'completed', 'completed'])
    // The call alone is no acceptance: a Stop, a failure or a refused final check writes no reached note.
    expect(statuses([plan, ...goal, result], false)).toEqual(['completed', 'skipped', 'completed', 'skipped', 'skipped'])
    // Shaping never rewrites what the agent sent.
    expect(plan.type === 'todo_update' ? plan.todos[3]?.status : undefined).toBe('in_progress')
  })
})

describe('planStanding', () => {
  const lines = (...statuses: TaskLine['status'][]): TaskLine[] => statuses.map((status, index) => ({ text: `Step ${index}`, status }))

  it('counts only completed lines as done and spins while a step is open', () => {
    expect(planStanding(lines('completed', 'in_progress', 'pending', 'pending'))).toEqual({ done: 1, total: 4, mark: 'working' })
    expect(planStanding(lines('completed', 'pending'))).toMatchObject({ mark: 'working' })
  })

  it('reads a list as done only when every line is, and as stopped when its turn skipped some', () => {
    expect(planStanding(lines('completed', 'completed'))).toEqual({ done: 2, total: 2, mark: 'done' })
    expect(planStanding(lines('completed', 'skipped'))).toEqual({ done: 1, total: 2, mark: 'stopped' })
  })

  it('lets a blocked step outrank the rest and a compacting turn hold still', () => {
    expect(planStanding(lines('completed', 'blocked', 'pending')).mark).toBe('blocked')
    expect(planStanding(lines('completed', 'paused', 'pending')).mark).toBe('paused')
  })
})

describe('foldsWhenDone', () => {
  const lines = (...statuses: TaskLine['status'][]): TaskLine[] => statuses.map((status, index) => ({ text: `Step ${index}`, status }))

  it('closes a card only when every line is done', () => {
    expect(foldsWhenDone(lines('completed', 'completed'))).toBe(true)
    expect(foldsWhenDone(lines('completed', 'in_progress'))).toBe(false)
    expect(foldsWhenDone(lines('completed', 'pending'))).toBe(false)
  })

  it('keeps open a card that ended unfinished, blocked or compacting', () => {
    expect(foldsWhenDone(lines('completed', 'skipped'))).toBe(false)
    expect(foldsWhenDone(lines('completed', 'blocked'))).toBe(false)
    expect(foldsWhenDone(lines('completed', 'paused'))).toBe(false)
    expect(foldsWhenDone([])).toBe(false)
  })
})

describe('a plan card across updates', () => {
  it('keeps one timeline card under a key that survives each update, so its fold does too', () => {
    const update = (id: string, status: 'pending' | 'completed'): ThreadEvent =>
      ({ id, ts: 2, type: 'todo_update', turnId: 'turn-1', agentId: 'smith', todos: [{ text: 'Map', status }] })
    const keyAfter = (events: ThreadEvent[]) => {
      const turn = rowsOf({ ...emptyThread, hasSnapshot: true, events }).find((row) => row.kind === 'turn')
      const cards = turn?.kind === 'turn' ? turn.timeline.filter((item) => item.kind === 'todo') : []
      expect(cards).toHaveLength(1)
      return cards[0]?.key
    }
    expect(keyAfter([update('a', 'pending'), update('b', 'completed')])).toBe(keyAfter([update('a', 'pending')]))
  })
})

describe('planRowKeys', () => {
  const plan = (...texts: string[]): TaskLine[] => texts.map((text) => ({ text, status: 'pending' }))

  it('keeps a step its key when the plan around it is revised, and keeps repeated wording unique', () => {
    const before = planRowKeys(plan('Read', 'Fix', 'Test'))
    const after = planRowKeys(plan('Read', 'Fix the parser', 'Add a test', 'Test'))
    expect(after).toEqual([before[0], expect.any(String), expect.any(String), before[2]])
    expect(after).not.toContain(before[1])
    expect(new Set(planRowKeys(plan('Check', 'Check'))).size).toBe(2)
  })
})

describe('tasks card titles', () => {
  const plan = (...texts: string[]): TaskLine[] => texts.map((text) => ({ text, status: 'pending' }))

  it('names a plan by the steps that do the work, past groundwork and wrap-up', () => {
    expect(planTitle(plan('Read the panel code', 'Move subagents into the panel', 'Add the summary line', 'Verify on the spike')))
      .toBe('Move subagents into the panel and add the summary line')
    // Two steps that overflow one line leave the first alone; a name keeps its capital.
    expect(planTitle(plan('Build shared title logic for plan and Confirm cards with tests', 'Wire the titles into web and phone cards')))
      .toBe('Build shared title logic for plan and Confirm cards with tests')
    expect(planTitle(plan('Fix the parser.', 'TodoList shows the title'))).toBe('Fix the parser and TodoList shows the title')
    // Only groundwork and wrap-up: its own first steps still say what it is about; a blank line never names it.
    expect(planTitle(plan(' ', 'Investigate the flaky login test', 'Report the cause'))).toBe('Investigate the flaky login test and report the cause')
    expect(planTitle(plan('Read', 'Verify'))).toBe('Read and verify')
    expect(planTitle(plan('Read the login handler', 'Fix', 'Verify the callback'))).toBe('Read the login handler and fix')
  })

  it('names what Confirm commits by the commit subject, else the brief, never a bare verb', () => {
    const merge: ConfirmRequest = { variant: 'merge', worktrees: [], mergeInto: 'main' }
    expect(confirmTitle(merge, 'Move subagents into the Session panel')).toBe('Commit and merge: Move subagents into the Session panel')
    expect(confirmTitle({ variant: 'merge_withheld', worktrees: [], mergeInto: 'main' }, 'Subagents')).toBe('Commit: Subagents')
    expect(confirmTitle({ variant: 'checkout', worktrees: [] }, undefined)).toBe('Commit this Session’s changes')

    const report = { result: 'Done.', commit: { subject: 'Move subagents into the panel' } }
    const current = { id: 'h', title: 'Subagents in the Session panel', goalReport: report, goalCompletion: { requestEventId: 'now', repos: [] } } as unknown as WorkHandoff
    expect(confirmWork([current], 'now', true)).toBe('Move subagents into the panel')
    // Before Git answers, the Session's newest request owns the current subject; an older one does not.
    const unanswered = { ...current, goalCompletion: undefined }
    expect(confirmWork([unanswered], 'now', true)).toBe('Move subagents into the panel')
    expect(confirmWork([unanswered], 'older', false)).toBe('Subagents in the Session panel')
    // Neither does a request Git answered in an earlier round, nor one the current round's Git does not answer.
    const reopened = { ...current, goalConfirmations: [{ confirmedAt: 1, version: 1, completion: { requestEventId: 'before', repos: [] } }] } as unknown as WorkHandoff
    expect(confirmWork([reopened], 'before', false)).toBe('Subagents in the Session panel')
    expect(confirmWork([current], 'older', false)).toBe('Subagents in the Session panel')
  })
})
