import type { Chat, Project, ServerMessage, ThreadEvent, WorkHandoff } from '@manor/contracts'
import { describe, expect, it } from 'vitest'
import { NO_OPEN_THREAD_BUNDLES, feedIndexOf, openThreadBundleAt, threadBundleOpenItems, threadBundleView, fileWriteGroups, forwardedLine, projectThreadFeed, setThreadBundleOpen, threadBundleOpen, threadStretch, threadQuestionAdvice, projectWorkHandoffs, rowsOf, threadSpacing, threadWorkCard, workCardStatus, type Row, type WorkHandoffRow } from './transcriptState'
import { emptyThread } from './threadState'
import { clearRunningTurns, withChatArchived, withChatSettled } from './workspaceActions'
import { emptyWorkspace, reduce, type WorkspaceState } from './workspaceState'
import { changeableAnswers, inbox, openThreadQuestion, projectSessionOverview, projectThreads, sessionsDot, projectsByRecentActivity, sessionLiveOf, sessionThreadOf, sitsSettled, withSessionTitle } from './workspaceSelectors'

const project: Project = { id: 'p1', name: 'Manor', icon: 'home', color: '#8A8F98', repoPaths: [], memoryScope: 'project', threadChatId: 'thread' }
const chat = (id: string, extra: Partial<Chat> = {}): Chat => ({
  id, projectId: project.id, kind: 'project', routineId: null, parentChatId: null, sideModel: null, sideEffort: null,
  memberIds: [], agentIds: [], title: id, createdAt: 1, lastMessageAt: 1, lastMessagePreview: null,
  settledAt: null, archivedAt: null, checkout: { mode: 'current', branch: null }, ...extra,
})
const handoff = (id: string, extra: Partial<WorkHandoff>): WorkHandoff => ({
  id, sourceChatId: 'thread', sourceTurnId: 't', workChatId: null, projectId: project.id, projectName: project.name,
  title: id, leadAgentId: 'wren', leadAgentName: 'Wren', supportingAgentIds: [], supportingAgentNames: [],
  acceptedAt: 1, state: 'active', result: null, resultAt: null, version: 1, createdAt: 1, ...extra,
})

function workspace(handoffs: WorkHandoff[], extra: Partial<Extract<ServerMessage, { type: 'directory' }>> = {}): WorkspaceState {
  return reduce(emptyWorkspace, {
    type: 'directory',
    projects: [project],
    chats: [chat('thread', { mode: 'single', lastMessageAt: 5 }), chat('session', { lastMessageAt: 9 }), chat('loose'), chat('quiet')],
    workHandoffs: handoffs,
    ...extra,
  })
}

describe('project picker order', () => {
  it('uses the latest chat activity, keeps ties and empty projects stable, and leaves sidebar order intact', () => {
    const projects = ['empty-first', 'older', 'newest', 'tie', 'empty-last'].map((id) => ({ ...project, id, name: id }))
    const state = {
      projects,
      chats: [
        chat('thread', { projectId: 'older', lastMessageAt: 10 }),
        chat('session', { projectId: 'newest', lastMessageAt: 5 }),
        chat('follow-up', { projectId: 'newest', lastMessageAt: 30, settledAt: 31 }),
        chat('archived', { projectId: 'older', lastMessageAt: 20, archivedAt: 21 }),
        chat('equal', { projectId: 'tie', lastMessageAt: 20 }),
        chat('household', { projectId: null, lastMessageAt: 100 }),
      ],
    }
    expect(projectsByRecentActivity(state).map((entry) => entry.id)).toEqual(['newest', 'older', 'tie', 'empty-first', 'empty-last'])
    expect(state.projects.map((entry) => entry.id)).toEqual(['empty-first', 'older', 'newest', 'tie', 'empty-last'])
    state.chats.push(chat('old-thread-reused', { projectId: 'older', lastMessageAt: 40 }))
    expect(projectsByRecentActivity(state).map((entry) => entry.id)).toEqual(['older', 'newest', 'tie', 'empty-first', 'empty-last'])
  })
})

describe('project thread selectors', () => {
  const started = handoff('h1', { workChatId: 'session' })

  it('keeps the thread out of the inbox and its sessions out of the Mac list only', () => {
    const state = workspace([started])
    expect(inbox(state).unsettled.map((row) => [row.chat.id, row.viaThread ?? false])).toEqual([['session', true], ['loose', false], ['quiet', false]])
    expect(inbox(state, { hideThreadSessions: true }).unsettled.map((row) => row.chat.id)).toEqual(['loose', 'quiet'])
    expect(sessionThreadOf(state, 'session')?.threadChatId).toBe('thread')
    expect(sessionThreadOf(state, 'loose')).toBeUndefined()
  })

  it('keeps a hidden project and its archived thread out of every list, and lists its Sessions on their own', () => {
    const hidden = workspace([started], {
      chats: [chat('thread', { mode: 'single', archivedAt: 7 }), chat('session', { settledAt: 6 }), chat('loose'), chat('gone', { archivedAt: 8 })],
    })
    expect(projectThreads(hidden)).toEqual([])
    for (const lists of [inbox(hidden), inbox(hidden, { hideThreadSessions: true })]) {
      expect([...lists.unsettled, ...lists.settled, ...lists.archived].map((row) => row.chat.id)).not.toContain('thread')
      expect(lists.archived.map((row) => row.chat.id)).toEqual(['gone'])
      // No project row carries the Session while its project is hidden, so the list does.
      expect(lists.settled.map((row) => [row.chat.id, row.viaThread ?? false])).toEqual([['session', false]])
    }
    expect(sessionThreadOf(hidden, 'session')).toBeUndefined()
    // Added back through + in Projects, the same thread is the project's row again.
    const back = withChatArchived(hidden, 'thread', false)
    expect(projectThreads(back).map((row) => row.chat.id)).toEqual(['thread'])
    expect(inbox(back, { hideThreadSessions: true }).settled).toEqual([])
    expect(sessionThreadOf(back, 'session')?.threadChatId).toBe('thread')
  })

  it('rereads the sessions a thread started when only the project list changes', () => {
    const state = workspace([started], { projects: [{ ...project, threadChatId: undefined }] })
    expect(sessionThreadOf(state, 'session')).toBeUndefined()
    const threaded = { ...state, projects: [project] }
    expect(threaded.workHandoffs).toBe(state.workHandoffs)
    expect(sessionThreadOf(threaded, 'session')?.threadChatId).toBe('thread')
    expect(inbox(threaded, { hideThreadSessions: true }).unsettled.map((row) => row.chat.id)).toEqual(['loose', 'quiet'])
  })

  it('counts running sessions and says when one waits on the user', () => {
    const running = reduce(workspace([started]), { type: 'turn_state', chatId: 'session', turnId: 'turn_1', agentId: 'wren', state: 'running', startedAt: 1 })
    expect(projectThreads(running)).toMatchObject([{ chat: { id: 'thread' }, running: 1, waiting: false, lastActivityAt: 9 }])
    const asking = workspace([started], { awaitingInput: { session: ['request_1'] } })
    expect(projectThreads(asking)[0]?.waiting).toBe(true)
    const ready = workspace([{ ...started, goalReachedAt: 3, goalReport: { result: 'Done.' } }])
    expect(projectThreads(ready)[0]).toMatchObject({ running: 0, waiting: true })
    const confirmed = workspace([{ ...started, goalReachedAt: 3, goalReport: { result: 'Done.' }, goalConfirmedAt: 4 }])
    expect(projectThreads(confirmed)[0]).toMatchObject({ running: 0, waiting: false })
  })

  it('reads as waiting only for a proposal, question, result or blocked commit, never for handled Sessions', () => {
    const result = { goalReachedAt: 3, goalReport: { result: 'Done.' } }
    const handled = [
      // A no-change result Closed by the user is Confirm underneath.
      handoff('confirmed', { workChatId: 'confirmed', ...result, goalConfirmedAt: 4, goalCompletion: { status: 'complete', operation: 'none', repos: [] } }),
      // A confirmed Session the user reopened and left idle reads `done`: listed, but nothing is owed.
      handoff('reopened', { workChatId: 'reopened', ...result, goalConfirmedAt: 4, unsettledAt: 5 }),
      // A no-change investigation ended a turn without a result.
      handoff('investigation', { workChatId: 'investigation' }),
      handoff('closed', { workChatId: 'closed', state: 'settled' }),
    ]
    const chats = ['confirmed', 'reopened', 'investigation', 'closed'].map((id) => chat(id, id === 'closed' ? { settledAt: 6 } : {}))
    const quiet = workspace(handled, { chats: [chat('thread', { mode: 'single' }), ...chats] })
    expect(projectSessionOverview(quiet, 'thread').waiting.map((row) => [row.key, row.status]).sort()).toEqual([['investigation', 'done'], ['reopened', 'done']])
    expect(projectThreads(quiet)[0]?.waiting).toBe(false)
    const withChats = (extra: Chat[], more: WorkHandoff[]) => workspace([...handled, ...more], { chats: [chat('thread', { mode: 'single' }), ...chats, ...extra] })
    // A proposal waits for Accept, a result for Confirm, a question for an answer, a refused commit for a retry.
    const proposal = handoff('proposal', { acceptedAt: null })
    expect(projectThreads(withChats([], [proposal]))[0]?.waiting).toBe(true)
    const result1 = handoff('result', { workChatId: 'result', ...result })
    expect(projectThreads(withChats([chat('result')], [result1]))[0]?.waiting).toBe(true)
    const asking = workspace([...handled, handoff('question', { workChatId: 'question' })], {
      chats: [chat('thread', { mode: 'single' }), ...chats, chat('question')], awaitingInput: { question: ['request_1'] },
    })
    const asked = reduce(asking, { type: 'turn_state', chatId: 'question', turnId: 'turn_1', agentId: 'wren', state: 'running', startedAt: 2 })
    expect(projectSessionOverview(asked, 'thread').waiting.map((row) => row.status)).toContain('waiting')
    expect(projectThreads(asked)[0]?.waiting).toBe(true)
    const blocked = handoff('blocked', { workChatId: 'blocked', ...result, goalConfirmedAt: 4, goalCompletion: { status: 'blocked', operation: 'commit', repos: [] } })
    expect(projectThreads(withChats([chat('blocked')], [blocked]))[0]?.waiting).toBe(true)
  })

  it('groups the sessions the thread started into Needs you, Working and Settled', () => {
    const handoffs = [
      { ...started, goalReachedAt: 3, goalReport: { result: 'Done.' } },
      handoff('h2', { workChatId: 'busy' }),
      handoff('h3', { workChatId: 'idle' }),
      handoff('h4', { workChatId: 'quiet' }),
      handoff('h5', { workChatId: 'gone' }),
      handoff('h6', { workChatId: 'asking' }),
    ]
    let state = workspace(handoffs, {
      chats: [
        chat('thread', { mode: 'single', lastMessageAt: 5 }),
        chat('session', { lastMessageAt: 9, lastMessagePreview: 'Klaar met de knop' }),
        chat('busy', { lastMessageAt: 7 }),
        chat('idle', { lastMessageAt: 6 }),
        chat('asking', { lastMessageAt: 2 }),
        chat('quiet', { lastMessageAt: 3, settledAt: 4 }),
        chat('gone', { archivedAt: 6 }),
        chat('loose', { lastMessageAt: 8 }),
      ],
      awaitingInput: { asking: ['request_1'] },
    })
    state = reduce(state, { type: 'turn_state', chatId: 'busy', turnId: 'turn_1', agentId: 'wren', state: 'running', startedAt: 7 })
    state = reduce(state, { type: 'turn_state', chatId: 'asking', turnId: 'turn_2', agentId: 'wren', state: 'running', startedAt: 2 })
    const overview = projectSessionOverview(state, 'thread')
    // A result to confirm, a question mid-turn and a quiet session are all the user's move.
    expect(overview.waiting.map((row) => [row.key, row.line])).toEqual([['session', 'Klaar met de knop'], ['idle', ''], ['asking', '']])
    expect(overview.working.map((row) => row.key)).toEqual(['busy'])
    expect(overview.settled.map((row) => row.key)).toEqual(['quiet'])
    // Each row's marks come from its status, so the spinner and Waiting say what its card says.
    expect(overview.working[0]).toMatchObject({ running: true, waiting: false, unread: false })
    expect(overview.waiting.map((row) => [row.key, row.status, row.running, row.waiting])).toEqual([
      ['session', 'ready', false, false], ['idle', 'done', false, false], ['asking', 'waiting', false, true],
    ])
    expect(projectSessionOverview(state, 'loose')).toMatchObject({ waiting: [], working: [], settled: [], archived: [] })
  })

  it('wears one dot on the Sessions button: waiting beats finished beats working', () => {
    const handoffs = [handoff('a', { workChatId: 'a' }), handoff('b', { workChatId: 'b' })]
    const dot = (state: WorkspaceState) => sessionsDot(projectSessionOverview(state, 'thread'))
    const base = workspace(handoffs, { chats: [chat('thread', { mode: 'single' }), chat('a'), chat('b')] })
    expect(dot(base)).toBeNull()
    const running = reduce(base, { type: 'turn_state', chatId: 'a', turnId: 'turn_1', agentId: 'wren', state: 'running', startedAt: 2 })
    expect(dot(running)).toBe('working')
    // A turn that ends while the room is elsewhere is unread, and its Session is `done`.
    const finished = reduce(reduce(running, { type: 'turn_state', chatId: 'a', turnId: 'turn_1', agentId: 'wren', state: 'done', startedAt: 2 }), { type: 'turn_state', chatId: 'b', turnId: 'turn_2', agentId: 'wren', state: 'running', startedAt: 3 })
    expect(projectSessionOverview(finished, 'thread').waiting.find((row) => row.key === 'a')?.unread).toBe(true)
    expect(dot(finished)).toBe('finished')
    const asking = workspace(handoffs, { chats: [chat('thread', { mode: 'single' }), chat('a'), chat('b')], awaitingInput: { b: ['request_1'] } })
    expect(dot(reduce(asking, { type: 'turn_state', chatId: 'a', turnId: 'turn_1', agentId: 'wren', state: 'running', startedAt: 2 }))).toBe('waiting')
    expect(dot(workspace([handoff('p', { acceptedAt: null })]))).toBe('waiting')
  })

  it('lists the thread’s archived sessions newest archived first, and restoring returns them to their group', () => {
    const handoffs = ['a', 'b', 'c'].map((id) => handoff(id, { workChatId: id }))
    const chats = [chat('thread'), chat('a', { archivedAt: 100 }), chat('b', { archivedAt: 300 }), chat('c', { archivedAt: 200 }), chat('loose', { archivedAt: 400 })]
    const state = workspace(handoffs, { chats })
    const overview = projectSessionOverview(state, 'thread')
    // The Mac sidebar hides a thread's sessions, so this is the only list that shows them.
    expect(overview.archived.map((row) => row.key)).toEqual(['b', 'c', 'a'])
    expect(overview.archived[0]).toMatchObject({ status: 'closed', running: false, waiting: false, chat: { id: 'b' } })
    expect([...overview.waiting, ...overview.working, ...overview.settled]).toEqual([])
    expect(inbox(state, { hideThreadSessions: true }).archived.map((row) => row.chat.id)).toEqual(['loose'])
    expect(inbox(state).archived.map((row) => row.chat.id)).toEqual(['loose', 'b', 'c', 'a'])
    // A session another thread did not start stays out, and the retention window comes with the list.
    expect(overview.archiveKeepMs).toBeGreaterThan(0)
    const restored = projectSessionOverview(withChatArchived(state, 'b', false), 'thread')
    expect(restored.archived.map((row) => row.key)).toEqual(['c', 'a'])
    expect(restored.waiting.map((row) => row.key)).toEqual(['b'])
  })

  it('moves a session to Settled and back to its live group', () => {
    // The server settles the handoff with the chat; Unsettle reopens both at once.
    const stamped = withChatSettled(workspace([{ ...started, state: 'settled', result: 'Done.' }]), 'session', true, 10)
    expect(projectSessionOverview(stamped, 'thread').settled.map((row) => row.key)).toEqual(['session'])
    const reopened = withChatSettled(stamped, 'session', false, 11)
    expect(projectSessionOverview(reopened, 'thread').waiting.map((row) => row.key)).toEqual(['session'])
    expect(reopened.workHandoffs[0]).toMatchObject({ state: 'active', result: null })
    const state = workspace([started])
    expect(projectSessionOverview(state, 'thread').waiting.map((row) => row.key)).toEqual(['session'])
    const settled = withChatSettled(state, 'session', true, 10)
    expect(projectSessionOverview(settled, 'thread')).toMatchObject({ waiting: [], settled: [{ chat: { id: 'session' } }] })
    expect(projectSessionOverview(withChatSettled(settled, 'session', false, 11), 'thread').waiting.map((row) => row.key)).toEqual(['session'])
  })

  it('uses the current confirmation for web and phone after a new result round', () => {
    const confirmed = { ...started, goalReachedAt: 3, goalReport: { result: 'Fixed.' }, goalConfirmedAt: 4 }
    const settled = workspace([confirmed])
    expect(sitsSettled(settled, settled.chats.find((row) => row.id === 'session')!)).toBe(true)
    expect(projectSessionOverview(settled, 'thread').settled.map((row) => row.key)).toEqual(['session'])
    const reopened = { ...started, version: 2, goalConfirmations: [{ confirmedAt: 4, version: 1 }] }
    const active = workspace([reopened])
    expect(sitsSettled(active, active.chats.find((row) => row.id === 'session')!)).toBe(false)
    expect(projectSessionOverview(active, 'thread').waiting[0]?.status).toBe('done')
    expect(inbox(active).unsettled.map((row) => row.chat.id)).toContain('session')
    const working = reduce(active, { type: 'turn_state', chatId: 'session', turnId: 'follow-up', agentId: 'wren', state: 'running', startedAt: 5 })
    expect(projectSessionOverview(working, 'thread').working[0]?.status).toBe('working')
    const ready = workspace([{ ...reopened, version: 3, goalReachedAt: 6, goalReport: { result: 'Follow up fixed.' } }])
    expect(projectSessionOverview(ready, 'thread').waiting[0]?.status).toBe('ready')
    const again = workspace([{ ...ready.workHandoffs[0]!, goalConfirmedAt: 7, goalCompletion: { status: 'complete', operation: 'commit', repos: [] } }])
    expect(sitsSettled(again, again.chats.find((row) => row.id === 'session')!)).toBe(true)
    expect(projectSessionOverview(again, 'thread').settled[0]?.status).toBe('confirmed')
    expect(inbox(again).unsettled.map((row) => row.chat.id)).not.toContain('session')
  })

  it('reads one settled signal for the control and the group: stamped, confirmed, unsettled after confirm', () => {
    const control = (state: WorkspaceState) => sitsSettled(state, state.chats.find((entry) => entry.id === 'session')!)
    const inSettled = (state: WorkspaceState) => projectSessionOverview(state, 'thread').settled.some((row) => row.key === 'session')
    const confirmed = { ...started, goalReachedAt: 3, goalReport: { result: 'Done.' }, goalConfirmedAt: 4 }

    // Stamped: The user settled it.
    const stamped = withChatSettled(workspace([started]), 'session', true, 10)
    expect([control(stamped), inSettled(stamped)]).toEqual([true, true])

    // Confirmed without a stamp: listed under Settled, so the control is filled too.
    const open = workspace([confirmed])
    expect(open.chats.find((entry) => entry.id === 'session')?.settledAt).toBeNull()
    expect([control(open), inSettled(open)]).toEqual([true, true])

    // Unsettled after confirm: out of Settled, and a fresh snapshot keeps it out.
    const out = withChatSettled(open, 'session', false, 11)
    expect([control(out), inSettled(out)]).toEqual([false, false])
    expect(projectSessionOverview(out, 'thread').waiting.map((row) => row.key)).toEqual(['session'])
    const snapshot = workspace(out.workHandoffs)
    expect([control(snapshot), inSettled(snapshot)]).toEqual([false, false])

    // Settling it again stamps it and drops the record, so a later unsettle works again.
    const again = withChatSettled(out, 'session', true, 12)
    expect([control(again), inSettled(again), again.workHandoffs[0]?.unsettledAt]).toEqual([true, true, undefined])
    expect(inSettled(withChatSettled(again, 'session', false, 13))).toBe(false)

    // A stamped, confirmed session that is unsettled stays out as well.
    const stampedConfirmed = withChatSettled(workspace([{ ...confirmed, state: 'settled', result: 'Done.' }]), 'session', true, 10)
    expect(inSettled(withChatSettled(stampedConfirmed, 'session', false, 11))).toBe(false)
  })

  it('files a session under Waiting while work it started outlives its turn, from an older server too', () => {
    const state = reduce(workspace([]), {
      type: 'directory', projects: [project], backgroundChatIds: ['session'],
      workHandoffs: [handoff('h1', { workChatId: 'session' }), handoff('h2', { workChatId: 'quiet' })],
      chats: [chat('thread', { mode: 'single', lastMessageAt: 5 }), chat('session', { lastMessageAt: 9 }), chat('loose'), chat('quiet')],
    })
    const overview = projectSessionOverview(state, 'thread')
    expect(overview.working).toEqual([])
    expect(overview.background).toMatchObject([{ key: 'session', status: 'background', line: 'Waiting on background work', running: false }])
    expect(overview.waiting.map((row) => row.key)).toEqual(['quiet'])
  })

  it('offers the oldest session question until it is answered or its turn ends', () => {
    let state = workspace([started], { awaitingInput: { session: ['request_1'] } })
    const asked: ThreadEvent = {
      id: 'e1', ts: 2, type: 'system_note', kind: 'info', text: 'session vraagt: Corners?',
      sessionQuestion: { sessionChatId: 'session', requestId: 'request_1', agentId: 'wren', title: 'Corners', questions: [{ id: 'corners', question: 'Corners?', options: [{ label: 'Round' }, { label: 'Square' }] }] },
    }
    state = reduce(state, { type: 'snapshot', chatId: 'thread', events: [asked], usage: {}, overrides: {} } as ServerMessage)
    expect(openThreadQuestion(state, 'thread')).toMatchObject({ sessionChatId: 'session', requestId: 'request_1', more: 0 })
    const answered: ThreadEvent = {
      id: 'e2', ts: 3, type: 'system_note', kind: 'info', text: 'Answered: Round',
      sessionAnswer: { sessionChatId: 'session', requestId: 'request_1', answers: { corners: 'Round' }, by: 'user' },
    }
    expect(openThreadQuestion(reduce(state, { type: 'event', chatId: 'thread', event: answered }), 'thread')).toBeNull()
  })

  it('offers Other answer on an answer from preferences until the user replaced it', () => {
    const questions = [{ id: 'corners', question: 'Corners?', options: [{ label: 'Round' }, { label: 'Square' }] }]
    const asked: ThreadEvent = { id: 'q', ts: 1, type: 'system_note', kind: 'info', text: 'asks', sessionQuestion: { sessionChatId: 'session', requestId: 'r1', agentId: 'wren', title: 'Corners', questions } }
    const fromThread: ThreadEvent = { id: 'a', ts: 2, type: 'system_note', kind: 'info', text: 'Answered from preferences.md: Round', sessionAnswer: { sessionChatId: 'session', requestId: 'r1', answers: { corners: 'Round' }, by: 'thread', preference: 'Corners are always round' } }
    const changed: ThreadEvent = { id: 'c', ts: 3, type: 'system_note', kind: 'info', text: 'Changed to: Square', sessionAnswer: { sessionChatId: 'session', requestId: 'r1', answers: { corners: 'Square' }, by: 'user' } }
    expect([...changeableAnswers([asked, fromThread])]).toEqual([['a', { sessionChatId: 'session', requestId: 'r1', agentId: 'wren', title: 'Corners', questions, answers: { corners: 'Round' } }]])
    expect(changeableAnswers([asked, fromThread, changed]).size).toBe(0)
  })
})

describe('a DM brief handed to its project thread', () => {
  const note = (version: number): Row => ({
    kind: 'event', key: `n${version}`, event: { id: `n${version}`, ts: version, type: 'system_note', kind: 'info', text: 'Doorgegeven.', workHandoffId: 'brief', workHandoffVersion: version },
  })
  const card = (handoffs: WorkHandoff[]): WorkHandoffRow => {
    const [row] = projectWorkHandoffs([note(2)], handoffs, [chat('thread'), chat('session')], [project], [])
    if (row?.kind !== 'work_handoff') throw new Error('no card')
    return row
  }
  const brief = handoff('brief', { sourceChatId: 'dm', forwardedAt: 2, acceptedAt: 2, version: 2 })

  it('never offers Accept again and follows the session the thread started', () => {
    expect(card([brief])).toMatchObject({ acceptedAt: 2, status: 'Working', forwarded: { threadChatId: 'thread', phase: 'starting' } })
    expect(card([brief]).report).toBeUndefined()
    const linked = handoff('h1', { workChatId: 'session' })
    const withLink = { ...brief, threadHandoffId: 'h1' }
    expect(card([withLink, linked]).forwarded?.phase).toBe('working')
    const ready = { ...linked, goalReachedAt: 3, goalReport: { result: 'Done.' } }
    expect(forwardedLine(card([withLink, ready]))).toBe('Ready, confirm in project thread Manor')
    expect(card([withLink, ready]).report).toBeUndefined()
    expect(forwardedLine(card([withLink, { ...ready, goalConfirmedAt: 4 }]))).toBe('Confirmed in project thread Manor')
    // A report with nothing to commit is Ready and then Closed; working again, it is running, not Ready.
    const report = { ...ready, goalCompletion: { status: 'ready' as const, operation: 'none' as const, repos: [] } }
    expect(forwardedLine(card([withLink, report]))).toBe('Ready in project thread Manor')
    expect(forwardedLine(card([withLink, { ...report, goalConfirmedAt: 4 }]))).toBe('Closed in project thread Manor')
    const [running] = projectWorkHandoffs([note(2)], [withLink, report], [chat('thread'), chat('session')], [project], [], {}, () => ({ running: true, background: false, asking: false }))
    expect(running?.kind === 'work_handoff' && forwardedLine(running)).toBe('Running via project thread Manor')
    // The Session asks: the overview lists it under Needs you, and so does the line.
    const [asking] = projectWorkHandoffs([note(2)], [withLink, linked], [chat('thread'), chat('session')], [project], [], {}, () => ({ running: true, background: false, asking: true }))
    expect(asking?.kind === 'work_handoff' && forwardedLine(asking)).toBe('Needs you in project thread Manor')
    // Waiting on its own background work, with or without a report, it is neither running nor Ready.
    const waiting = () => ({ running: true, background: true, asking: false })
    for (const session of [linked, report]) {
      const [row] = projectWorkHandoffs([note(2)], [withLink, session], [chat('thread'), chat('session')], [project], [], {}, waiting)
      expect(row?.kind === 'work_handoff' && forwardedLine(row)).toBe('Waiting in project thread Manor')
    }
    // A brief whose Session has not started yet is neither running nor waiting.
    expect(forwardedLine(card([brief]))).toBe('To project thread Manor')
  })
})


describe('one status per Session, read by its card, its overview row and its project row', () => {
  const created = (handoffId: string): Row => ({
    kind: 'event', key: `note-${handoffId}`, event: {
      id: `note-${handoffId}`, ts: 1, type: 'system_note', kind: 'info', text: 'Proposed.',
      workHandoffId: handoffId, workHandoffVersion: 1, workHandoffPhase: 'created',
    },
  })
  const card = (state: WorkspaceState, handoffId: string) => {
    const rows = projectWorkHandoffs([created(handoffId)], state.workHandoffs, state.chats, state.projects, state.agents, state.checkoutStatus, sessionLiveOf(state))
    return rows[0] as WorkHandoffRow
  }
  const standing = (state: WorkspaceState, key: string) => {
    const overview = projectSessionOverview(state, 'thread')
    const group = (['waiting', 'working', 'background', 'settled'] as const).find((id) => overview[id].some((row) => row.key === key))
    const row = group === undefined ? undefined : overview[group].find((entry) => entry.key === key)
    return { group, status: row?.status, running: row?.running, waiting: row?.waiting }
  }
  const accepted = handoff('h1', { workChatId: 'session' })

  it('agrees while it works, asks, stops, settles and waits for Accept', () => {
    const running = reduce(workspace([accepted]), { type: 'turn_state', chatId: 'session', turnId: 'turn_1', agentId: 'wren', state: 'running', startedAt: 1 })
    expect(workCardStatus(card(running, 'h1'))?.text).toBe('Working')
    expect(standing(running, 'session')).toEqual({ group: 'working', status: 'working', running: true, waiting: false })
    expect(projectThreads(running)[0]).toMatchObject({ running: 1, waiting: false })

    // A question mid-turn is the user's move, so the card no longer claims Working.
    const asking = reduce(running, { type: 'directory', projects: [project], chats: running.chats, workHandoffs: [accepted], awaitingInput: { session: ['request_1'] } })
    expect(workCardStatus(card(asking, 'h1'))?.text).toBe('Waiting')
    expect(standing(asking, 'session')).toEqual({ group: 'waiting', status: 'waiting', running: false, waiting: true })
    expect(projectThreads(asking)[0]).toMatchObject({ running: 0, waiting: true })

    // Stopped, or a turn that ended without a result, reads Done under Needs you, yet the project row stays quiet.
    const stopped = reduce(running, { type: 'turn_state', chatId: 'session', turnId: 'turn_1', agentId: 'wren', state: 'done' } as ServerMessage)
    expect(workCardStatus(card(stopped, 'h1'))?.text).toBe('Done')
    expect(standing(stopped, 'session')).toEqual({ group: 'waiting', status: 'done', running: false, waiting: false })
    expect(projectThreads(stopped)[0]).toMatchObject({ running: 0, waiting: false })

    // Settled is the user's stamp, even with a turn still running.
    const settled = withChatSettled(running, 'session', true, 10)
    expect(workCardStatus(card(settled, 'h1'))?.text).toBe('Settled')
    expect(standing(settled, 'session')).toMatchObject({ group: 'settled', status: 'settled' })
    expect(projectThreads(settled)[0]).toMatchObject({ running: 0, waiting: false })
    // The phone's list card reads the same status, so it shows no spinner on a settled session either.
    expect(inbox(settled).settled.find((row) => row.chat.id === 'session')).toMatchObject({ running: false, waiting: false })

    // A proposal has no session yet; it waits on the user in the overview and on the project row.
    const proposed = workspace([handoff('h2', { acceptedAt: null, title: 'Exportknop', summary: 'Add an export button.' })])
    expect(card(proposed, 'h2')).toMatchObject({ session: 'proposed', acceptedAt: null })
    expect(workCardStatus(card(proposed, 'h2'))).toBeNull()
    expect(standing(proposed, 'work:h2')).toEqual({ group: 'waiting', status: 'proposed', running: false, waiting: true })
    expect(projectSessionOverview(proposed, 'thread').waiting[0]).toMatchObject({ chat: null, title: 'Exportknop', line: 'Add an export button.' })
    expect(projectThreads(proposed)[0]).toMatchObject({ running: 0, waiting: true })
  })

  it('reads a Session still running after a reconnect as Working, not Needs you', () => {
    const running = reduce(workspace([accepted]), { type: 'turn_state', chatId: 'session', turnId: 'turn_1', agentId: 'wren', state: 'running', startedAt: 1 })
    // The socket came back: every dot went dark, and the reconnect directory still lists the turn.
    const reconnected = reduce(clearRunningTurns(running), {
      type: 'directory', projects: [project], chats: running.chats, workHandoffs: [accepted], runningTurns: { session: ['turn_1'] },
    })
    expect(standing(reconnected, 'session')).toEqual({ group: 'working', status: 'working', running: true, waiting: false })
    expect(workCardStatus(card(reconnected, 'h1'))?.text).toBe('Working')
    // A question it still holds reads Needs you after the reconnect too.
    const asking = reduce(clearRunningTurns(running), {
      type: 'directory', projects: [project], chats: running.chats, workHandoffs: [accepted],
      runningTurns: { session: ['turn_1'] }, awaitingInput: { session: ['request_1'] },
    })
    expect(standing(asking, 'session')).toMatchObject({ group: 'waiting', status: 'waiting' })
  })

  it('reads Working once the user writes instead of answering the open question', () => {
    const running = reduce(workspace([accepted]), { type: 'turn_state', chatId: 'session', turnId: 'turn_1', agentId: 'wren', state: 'running', startedAt: 1 })
    const ask: ThreadEvent = { id: 'q1', ts: 2, type: 'user_input_request', agentId: 'wren', turnId: 'turn_1', requestId: 'request_1', questions: [{ id: 'a', question: 'Round?', options: [{ label: 'Yes' }, { label: 'No' }] }] }
    const steer: ThreadEvent = { id: 's1', ts: 3, type: 'user_message', text: 'Make it round.', mentions: [], steersTurnId: 'turn_1' }
    const asking = reduce(running, { type: 'event', chatId: 'session', event: ask })
    expect(standing(asking, 'session')).toMatchObject({ status: 'waiting' })

    // The card stays answerable, and the server says when it stops holding the turn: the
    // directory it sends on `supersede` no longer lists the question.
    const steered = reduce(asking, { type: 'event', chatId: 'session', event: steer })
    const superseded = reduce(steered, { type: 'directory', projects: [project], chats: running.chats, workHandoffs: [accepted], runningTurns: { session: ['turn_1'] }, awaitingInput: {} })
    expect(standing(superseded, 'session')).toEqual({ group: 'working', status: 'working', running: true, waiting: false })
    // Opening the Session rebuilds the same reading from its transcript.
    const opened = reduce(running, { type: 'snapshot', chatId: 'session', events: [ask, steer], usage: {}, activeTurn: { turnId: 'turn_1', agentId: 'wren', startedAt: 1 } })
    expect(standing(opened, 'session')).toMatchObject({ status: 'working' })
    // A question the steered turn asks afterwards waits on the user again.
    const again = reduce(superseded, { type: 'event', chatId: 'session', event: { ...ask, id: 'q2', ts: 4, requestId: 'request_2' } })
    expect(standing(again, 'session')).toMatchObject({ status: 'waiting' })
  })

  it('reads Waiting while work an ended turn started runs, and leaves it on a wake, its end, Stop or Settle', () => {
    const chats = workspace([accepted]).chats
    const listing = (extra: Partial<Extract<ServerMessage, { type: 'directory' }>>, handoffs = [accepted]) =>
      reduce(workspace(handoffs), { type: 'directory', projects: [project], chats, workHandoffs: handoffs, ...extra })
    const retry = { backgroundChatIds: ['session'], backgroundWork: { session: [{ title: 'Retry the  phone\nlaunch', kind: 'command' as const }] } }

    // The turn ended while its retry loop runs: Waiting, without a spinner, and not the user's move.
    const waiting = listing(retry)
    expect(standing(waiting, 'session')).toEqual({ group: 'background', status: 'background', running: false, waiting: false })
    expect(projectSessionOverview(waiting, 'thread').background[0]?.line).toBe('Retry the phone launch')
    expect(workCardStatus(card(waiting, 'h1'))).toEqual({ tone: 'ready', text: 'Waiting' })
    expect(threadWorkCard(card(waiting, 'h1'))).toEqual({ shape: 'line', status: { tone: 'ready', text: 'Waiting' } })
    expect(projectThreads(waiting)[0]).toMatchObject({ running: 0, waiting: false })
    expect(sessionsDot(projectSessionOverview(waiting, 'thread'))).toBeNull()

    // Its wake starts a turn: Working again.
    const woken = reduce(waiting, { type: 'turn_state', chatId: 'session', turnId: 'wake', agentId: 'wren', state: 'running', startedAt: 2 })
    expect(standing(woken, 'session')).toMatchObject({ group: 'working', status: 'working', running: true })

    // The work ended without a wake: back to how the turn ended, Done, or Ready for a result.
    expect(standing(listing({ backgroundChatIds: [], backgroundWork: {} }), 'session')).toMatchObject({ status: 'done' })
    const reported = { ...accepted, goalReport: { result: 'Done.' }, goalReachedAt: 3 }
    expect(standing(listing(retry, [reported]), 'session')).toMatchObject({ status: 'background' })
    expect(standing(listing({ backgroundWork: {} }, [reported]), 'session')).toMatchObject({ status: 'ready' })

    // Stop ends the work, so the next listing names none; a settled Session never waits.
    expect(standing(listing({}), 'session')).toMatchObject({ status: 'done' })
    expect(standing(withChatSettled(waiting, 'session', true, 10), 'session')).toMatchObject({ group: 'settled', status: 'settled' })

    // After Confirm, a blocked commit stays the user's move and a pending one Working, ahead of Waiting.
    const confirmed = { ...reported, goalConfirmedAt: 4 }
    const completion = (extra: Partial<NonNullable<WorkHandoff['goalCompletion']>>) => [{ ...confirmed, goalCompletion: { status: 'complete' as const, operation: 'commit' as const, repos: [], ...extra } }]
    expect(standing(listing(retry, completion({ status: 'blocked' })), 'session')).toMatchObject({ group: 'waiting', status: 'blocked' })
    expect(standing(listing(retry, completion({ status: 'pending' })), 'session')).toMatchObject({ group: 'working', status: 'working' })
    expect(standing(listing(retry, completion({})), 'session')).toMatchObject({ group: 'background', status: 'background' })

    // Several things running are counted, and a running Manor child counts as an agent.
    const child = { id: 'child', parentChatId: 'session', title: 'Review the diff', agentId: 'sage', turnId: 't', toolCallId: 'c', driver: 'claude' as const, model: 'claude-sonnet-5', effort: 'high' as const, state: 'running' as const, startedAt: 1, depth: 1 }
    expect(projectSessionOverview(listing({ subagents: [child] }), 'thread').background[0]?.line).toBe('Review the diff')
    expect(projectSessionOverview(listing({ ...retry, subagents: [child] }), 'thread').background[0]?.line).toBe('Waiting on 1 background agent and 1 command')
    // A question its child asks is the user's move, ahead of Waiting.
    const childAsks = { ...child, ask: { requestId: 'r1', questions: [{ id: 'q', question: 'Go?', options: [{ label: 'Yes' }, { label: 'No' }] }] } }
    expect(standing(listing({ ...retry, subagents: [childAsks] }), 'session')).toMatchObject({ group: 'waiting', status: 'waiting' })
  })

  it('drops a rejected or replaced proposal and files a confirmed result under Settled', () => {
    const rejected = workspace([handoff('h2', { acceptedAt: null, state: 'settled' }), handoff('h3', { acceptedAt: null, supersededById: 'h4' }), handoff('h4', { acceptedAt: null, revision: 2 })])
    expect(projectSessionOverview(rejected, 'thread').waiting.map((row) => row.key)).toEqual(['work:h4'])
    // A legacy proposal that owned its chat before Accept still leads to its card.
    const legacy = workspace([handoff('h5', { acceptedAt: null, workChatId: 'session' })])
    expect(projectSessionOverview(legacy, 'thread').waiting).toMatchObject([{ key: 'work:h5', chat: null, status: 'proposed' }])
    const confirmed = workspace([{ ...accepted, goalReachedAt: 3, goalReport: { result: 'Done.' }, goalConfirmedAt: 4 }])
    expect(workCardStatus(card(confirmed, 'h1'))?.text).toBe('Confirmed')
    expect(standing(confirmed, 'session')).toMatchObject({ group: 'settled', status: 'confirmed' })
    expect(projectThreads(confirmed)[0]).toMatchObject({ waiting: false })
    expect(inbox(confirmed).settled.find((row) => row.chat.id === 'session')).toMatchObject({ running: false, waiting: false })
  })
})

describe('a Session card in its project thread', () => {
  const note: Row = {
    kind: 'event', key: 'created', event: {
      id: 'created', ts: 1, type: 'system_note', kind: 'info', text: 'Proposed.',
      workHandoffId: 'h1', workHandoffVersion: 1, workHandoffPhase: 'created',
    },
  }
  const view = (one: WorkHandoff, extra: Partial<Extract<ServerMessage, { type: 'directory' }>> = {}, settle = false) => {
    let state = workspace([one], extra)
    if (settle) state = withChatSettled(state, 'session', true, 5)
    const row = projectWorkHandoffs([note], state.workHandoffs, state.chats, state.projects, state.agents, state.checkoutStatus, sessionLiveOf(state))[0] as WorkHandoffRow
    return threadWorkCard(row)
  }

  it('changes shape from proposal to one line to done, and its word is the overview’s', () => {
    expect(view(handoff('h1', { acceptedAt: null }))).toEqual({ shape: 'proposal' })
    // Accepted and quiet: the overview says Needs you, so the line does too.
    expect(view(handoff('h1', { workChatId: 'session' }))).toEqual({ shape: 'line', status: { tone: 'warn', text: 'Needs you' } })
    const busy = reduce(workspace([handoff('h1', { workChatId: 'session' })]), { type: 'turn_state', chatId: 'session', turnId: 't1', agentId: 'wren', state: 'running', startedAt: 1 })
    const busyRow = projectWorkHandoffs([note], busy.workHandoffs, busy.chats, busy.projects, busy.agents, busy.checkoutStatus, sessionLiveOf(busy))[0] as WorkHandoffRow
    expect(threadWorkCard(busyRow)).toEqual({ shape: 'line', status: { tone: 'busy', text: 'Working' } })
    // A result to confirm keeps the full card: The user acts on it there.
    expect(view(handoff('h1', { workChatId: 'session', goalReachedAt: 3, goalReport: { result: 'Done.' } })).shape).toBe('full')
    expect(view(handoff('h1', { workChatId: 'session', goalReachedAt: 3, goalReport: { result: 'Export works.\nDetails.' }, goalConfirmedAt: 4 })))
      .toEqual({ shape: 'done', summary: 'Export works.', status: { tone: 'ok', text: 'Confirmed' } })
    expect(view(handoff('h1', { workChatId: 'session', result: 'Notes written. More.' }), {}, true))
      .toEqual({ shape: 'done', summary: 'Notes written.', status: { tone: 'dim', text: 'Done' } })
    // A merge Git shows landed folds to what landed (2026-10-19): Merged into main, and how many files.
    expect(view(handoff('h1', { workChatId: 'session', goalReachedAt: 3, goalReport: { result: 'Export works.' }, goalConfirmedAt: 4, goalCompletion: { status: 'complete', operation: 'merge', repos: [{ path: '/repo', files: ['a.ts'], before: 'a', branch: 'manor/x', tree: 't', mergeInto: 'main' }] } })))
      .toEqual({ shape: 'done', summary: '1 file', status: { tone: 'ok', text: 'Merged into main' } })
  })

  it('keeps a commit that did not land as the full card, and a pending one as a line', () => {
    const confirmed = (status: 'pending' | 'blocked') => handoff('h1', {
      workChatId: 'session', goalReachedAt: 3, goalReport: { result: 'Done.' }, goalConfirmedAt: 4,
      goalCompletion: { status, operation: 'commit', repos: [] },
    })
    expect(view(confirmed('pending'))).toEqual({ shape: 'line', status: { tone: 'busy', text: 'Committing…' } })
    expect(view(confirmed('blocked')).shape).toBe('full')
    // Stopped before Git showed the commit: neutral Done, never a green Confirmed.
    expect(view({ ...confirmed('pending'), state: 'settled' }, {}, true))
      .toEqual({ shape: 'done', summary: 'Done.', status: { tone: 'dim', text: 'Done' } })
  })
})

describe('project file writes in the thread', () => {
  const base = { ts: 1, type: 'system_note' as const, kind: 'info' as const }
  const write = (id: string, action: 'add' | 'replace' | 'remove' | 'restore' | 'create', file: string, line: string, turnId?: string): ThreadEvent => ({
    ...base, id, text: line,
    projectFileWrite: { file, action, by: 'Project thread', ...(action === 'remove' ? { old: line } : { line }), ...(turnId === undefined ? {} : { turnId }) },
  })
  const reply = (id: string, turnId: string): ThreadEvent => ({ id, ts: 1, type: 'agent_message', turnId, agentId: '__single__', messageId: id, text: 'Saved.' })
  const end = (id: string, turnId: string): ThreadEvent => ({ id, ts: 2, type: 'turn_result', turnId, agentId: '__single__', usage: { inputTokens: 0, outputTokens: 0 } } as ThreadEvent)

  it('folds each write into the turn that made it and leaves a Session’s write and a restore on their own rows', () => {
    const events = [
      reply('m1', 'turn_1'), write('w1', 'add', 'preferences.md', 'Corners are round', 'turn_1'), end('e1', 'turn_1'),
      reply('m2', 'turn_2'), end('e2', 'turn_2'),
      // A Session's status line names no turn: it never reads as the thread's reply.
      write('w2', 'add', 'notes.md', 'Export shipped'),
      write('w3', 'restore', 'notes.md', ''),
    ]
    const rows = rowsOf({ ...emptyThread, events })
    expect(rows.map((row) => row.kind === 'turn' ? `${row.turnId}:${row.fileWrites?.map((one) => one.file).join(',') ?? ''}` : row.key))
      .toEqual(['turn_1:preferences.md', 'turn_2:', 'w2', 'w3'])
  })

  it('folds a write stored before its turn’s first event into that turn once it exists', () => {
    const early = [write('w1', 'add', 'notes.md', 'First', 'turn_1'), write('w2', 'add', 'notes.md', 'Second', 'turn_1')]
    expect(rowsOf({ ...emptyThread, events: early }).map((row) => row.key)).toEqual(['w1', 'w2'])
    const rows = rowsOf({ ...emptyThread, events: [...early, reply('m1', 'turn_1'), end('e1', 'turn_1')] })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.kind === 'turn' ? rows[0].fileWrites?.map((one) => one.line) : undefined).toEqual(['First', 'Second'])
  })

  it('groups a turn’s writes per action and file, in the order they happened', () => {
    const writes = [
      write('a', 'add', 'preferences.md', 'Corners are round'),
      write('b', 'add', 'notes.md', 'Export shipped'),
      write('c', 'add', 'preferences.md', 'Rows keep one hairline'),
      write('d', 'replace', 'preferences.md', 'Corners are round, never square'),
      write('e', 'remove', 'notes.md', 'Old status'),
    ].map((event) => (event as Extract<ThreadEvent, { type: 'system_note' }>).projectFileWrite!)
    expect(fileWriteGroups(writes).map(({ label, lines }) => ({ label, lines }))).toEqual([
      { label: 'Saved 2 lines to preferences.md', lines: ['Corners are round', 'Rows keep one hairline'] },
      { label: 'Saved 1 line to notes.md', lines: ['Export shipped'] },
      { label: 'Updated 1 line in preferences.md', lines: ['Corners are round, never square'] },
      { label: 'Removed 1 line from notes.md', lines: ['Old status'] },
    ])
    // Each line keeps its write, which is what its Undo names.
    expect(fileWriteGroups(writes)[0]!.writes).toEqual([writes[0], writes[2]])
  })

  it('names an agent’s own notes as its notes, since the file is named after the agent', () => {
    const own = { file: 'sage.md', action: 'add' as const, line: 'Write in Dutch', agentId: 'sage', by: 'Sage' }
    expect(fileWriteGroups([own]).map((group) => group.label)).toEqual(['Saved 1 line to its notes'])
  })

  it('names a card the thread created, and a dated line it put on one', () => {
    const writes = [
      write('a', 'create', 'project_client_print.md', 'Print keeps square corners (2026-10-19)'),
      write('b', 'add', 'project_client_print.md', 'Bleed is 3 mm (2026-10-19)'),
    ].map((event) => (event as Extract<ThreadEvent, { type: 'system_note' }>).projectFileWrite!)
    expect(fileWriteGroups(writes).map((group) => group.label)).toEqual(['Created project_client_print.md', 'Saved 1 line to project_client_print.md'])
  })
})

describe('the project thread feed', () => {
  const events: ThreadEvent[] = [
    { id: 'e1', ts: 1, type: 'user_message', text: 'Start de export', mentions: [] },
    { id: 'e2', ts: 2, type: 'agent_message', turnId: 't1', agentId: '__single__', messageId: 'm1', text: 'Voorgesteld.' },
    { id: 'e3', ts: 3, type: 'turn_result', turnId: 't1', agentId: '__single__' },
    { id: 'e4', ts: 4, type: 'system_note', kind: 'info', text: 'Export asks Manor: Ronde hoeken?',
      sessionQuestion: { sessionChatId: 's', requestId: 'r1', agentId: 'wren', title: 'Export', questions: [] } },
    { id: 'e5', ts: 5, type: 'user_message', source: 'project_thread', threadReason: 'question', text: 'wake', mentions: [] },
    { id: 'e6', ts: 6, type: 'agent_message', turnId: 't2', agentId: '__single__', messageId: 'm2', text: 'Beantwoord.' },
    { id: 'e7', ts: 7, type: 'turn_result', turnId: 't2', agentId: '__single__' },
    { id: 'e8', ts: 8, type: 'system_note', kind: 'info', text: 'Answered: Rond', sessionAnswer: { sessionChatId: 's', requestId: 'r1', answers: {}, by: 'user' } },
    { id: 'e9', ts: 9, type: 'system_note', kind: 'error', text: 'Verbinding weg' },
    { id: 'e10', ts: 10, type: 'user_message', source: 'project_thread', threadReason: 'brief', text: 'Task:\nBouw', mentions: [] },
    { id: 'e11', ts: 11, type: 'user_message', text: 'Top, bedankt', mentions: [] },
    { id: 'e12', ts: 12, type: 'user_message', source: 'background_wake', text: 'Helper klaar', mentions: [] },
    { id: 'e13', ts: 13, type: 'system_note', kind: 'info', agentId: '__single__', text: 'Manor runs at most 3 wakes per message.' },
  ]
  const rows = rowsOf({ ...emptyThread, events })

  it('keeps the user, his replies, errors, a DM brief and a persona\'s own notice, and bundles the rest of his stretch', () => {
    const feed = projectThreadFeed(rows)
    expect(feed.map((row) => row.key)).toEqual(['e1', 'turn:t1:__single__', 'e9', 'bundle:e1', 'e10', 'e11', 'e13'])
    // The answered question, the thread's turn for it and the answer; the wake labels never draw.
    const bundle = feed[3]
    expect(bundle?.kind === 'thread_bundle' ? bundle.items.map((row) => row.key) : []).toEqual(['e4', 'turn:t2:__single__', 'e8'])
    expect(bundle?.kind === 'thread_bundle' ? bundle.summary : '').toBe('1 answer, 1 update')
    // Its chips count the same way: the answered question stands as a card, not as a chip.
    const chips = bundle?.kind === 'thread_bundle' ? threadBundleView(bundle.items).chips : []
    expect(chips.map((chip) => `${chip.count} ${chip.label}`)).toEqual(['1 answer', '1 update'])
    // A question opens to all it asked, with who asked it; answered here, it has no chip and stands right before its answer.
    const entries = bundle?.kind === 'thread_bundle' ? threadBundleView(bundle.items).entries : []
    expect(entries.map((entry) => entry.key)).toEqual(['e4', 'e8', 'turn:t2:__single__'])
    const question = entries[0]
    expect(question?.kind === 'note' ? question.text : '').toBe('Export asks Manor: Ronde hoeken?')
    // The transcript itself is untouched: the context and the memory writer read the same events.
    expect(rows.map((row) => row.key)).toContain('e4')
  })

  it('keeps the thread\'s advice on a question with that question, never as a turn of its own', () => {
    const asked: ThreadEvent[] = [
      { id: 'u1', ts: 1, type: 'user_message', text: 'Start de export', mentions: [] },
      { id: 'q1', ts: 2, type: 'system_note', kind: 'info', text: 'Export asks Manor: Ronde hoeken?', threadPending: 'prompt',
        sessionQuestion: { sessionChatId: 's', requestId: 'r1', agentId: 'wren', title: 'Export', questions: [] } },
      { id: 'w1', ts: 3, type: 'user_message', source: 'project_thread', threadReason: 'question', threadDelivered: ['q1'], text: 'wake', mentions: [] },
      { id: 'm1', ts: 4, type: 'agent_message', turnId: 't1', agentId: '__single__', messageId: 'm1', text: 'Ik zou kiezen voor **Rond**: past bij de rest.' },
      { id: 'e1', ts: 5, type: 'turn_result', turnId: 't1', agentId: '__single__' } as ThreadEvent,
    ]
    const pending = rowsOf({ ...emptyThread, events: asked })
    // While it waits, the card above the composer carries the advice and the thread shows only the user.
    expect(threadQuestionAdvice(pending).get('r1')).toBe('Ik zou kiezen voor Rond: past bij de rest.')
    expect(projectThreadFeed(pending).map((row) => row.key)).toEqual(['u1'])
    // Answered, the question's line in the bundle opens to it.
    const answer: ThreadEvent = { id: 'a1', ts: 6, type: 'system_note', kind: 'info', text: 'Answered: Rond', sessionAnswer: { sessionChatId: 's', requestId: 'r1', answers: {}, by: 'user' } }
    const [, bundle] = projectThreadFeed(rowsOf({ ...emptyThread, events: [...asked, answer] }))
    expect(bundle?.kind === 'thread_bundle' ? [bundle.items.map((row) => row.key), bundle.summary] : []).toEqual([['q1', 'a1'], '1 answer'])
    const entries = bundle?.kind === 'thread_bundle' ? threadBundleView(bundle.items, bundle.advice).entries : []
    expect(entries.map((entry) => entry.kind === 'note' ? [entry.key, entry.advice] : entry.key)).toEqual([['q1', 'Ik zou kiezen voor Rond: past bij de rest.'], ['a1', undefined]])
    // A wake that carried more than questions, or a turn that wrote, is no advice: it stays a line of its own.
    const mixed = asked.map((event) => event.id === 'w1' ? { ...event, threadDelivered: ['q1', 'l1'] } : event)
    const learning: ThreadEvent = { id: 'l1', ts: 2, type: 'system_note', kind: 'info', text: 'Learned.', threadPending: '- note: "x"' }
    const mixedRows = rowsOf({ ...emptyThread, events: [...mixed.slice(0, 2), learning, ...mixed.slice(2)] })
    expect(threadQuestionAdvice(mixedRows).size).toBe(0)
    const wrote: ThreadEvent = { id: 'x1', ts: 4, type: 'system_note', kind: 'info', text: 'w', projectFileWrite: { file: 'notes.md', action: 'add', line: 'Export waits', by: 'Project thread', turnId: 't1' } }
    const wroteRows = rowsOf({ ...emptyThread, events: [...asked.slice(0, 4), wrote, ...asked.slice(4)] })
    expect(threadQuestionAdvice(wroteRows).size).toBe(0)
    expect(projectThreadFeed(wroteRows).map((row) => row.key)).toEqual(['u1', 'turn:t1:__single__'])
    // Nor is a reply after another wake joined the chain, or one for a question the thread answered itself.
    const report: ThreadEvent = { id: 'w2', ts: 3, type: 'user_message', source: 'project_thread', threadReason: 'report', text: 'wake', mentions: [] }
    expect(threadQuestionAdvice(rowsOf({ ...emptyThread, events: [...asked.slice(0, 3), report, ...asked.slice(3)] })).size).toBe(0)
    const itself: ThreadEvent = { ...answer, sessionAnswer: { sessionChatId: 's', requestId: 'r1', answers: {}, by: 'thread' } }
    expect(threadQuestionAdvice(rowsOf({ ...emptyThread, events: [...asked, itself] })).size).toBe(0)
    // The user wrote before they answered: the question stands alone in its stretch and still opens to the advice.
    const later: ThreadEvent = { id: 'u2', ts: 5.5, type: 'user_message', text: 'Even kijken.', mentions: [] }
    const alone = projectThreadFeed(rowsOf({ ...emptyThread, events: [...asked, later, answer] }))
    expect(alone.map((row) => row.key)).toEqual(['u1', 'bundle:u1', 'u2', 'a1'])
    expect(alone[1]?.kind === 'thread_bundle' ? threadBundleView(alone[1].items, alone[1].advice).entries.map((entry) => entry.kind === 'note' ? entry.advice : '') : [])
      .toEqual(['Ik zou kiezen voor Rond: past bij de rest.'])
  })

  it('stands each answered question right before its own answer', () => {
    const question = (id: string, requestId: string, ts: number): ThreadEvent => ({ id, ts, type: 'system_note', kind: 'info', text: `asks ${requestId}`,
      sessionQuestion: { sessionChatId: 's', requestId, agentId: 'wren', title: 'Export', questions: [] } })
    const answer = (id: string, requestId: string, ts: number): ThreadEvent => ({ id, ts, type: 'system_note', kind: 'info', text: `Answered ${requestId}`,
      sessionAnswer: { sessionChatId: 's', requestId, answers: {}, by: 'user' } })
    const [, bundle] = projectThreadFeed(rowsOf({ ...emptyThread, events: [
      { id: 'u1', ts: 1, type: 'user_message', text: 'Start', mentions: [] },
      question('q1', 'r1', 2), question('q2', 'r2', 3), answer('a1', 'r1', 4), answer('a2', 'r2', 5),
    ] }))
    expect(bundle?.kind === 'thread_bundle' ? threadBundleView(bundle.items).entries.map((entry) => entry.key) : []).toEqual(['q1', 'a1', 'q2', 'a2'])
  })

  it('stacks cards, and spaces the user and the row under a reply', () => {
    const card = { kind: 'work_handoff' } as Row
    const [mine, turn, , , brief, thanks] = projectThreadFeed(rows)
    expect(threadSpacing(card, card)).toBe('group')
    expect(threadSpacing(mine!, undefined)).toBeUndefined()
    expect(threadSpacing(thanks!, brief!)).toBeUndefined()
    expect(threadSpacing(brief!, projectThreadFeed(rows)[3])).toBe('beat')
    expect(threadSpacing(projectThreadFeed(rows)[3]!, card)).toBe('group')
    expect(threadSpacing(card, turn!)).toBe('beat')
    expect(threadSpacing(turn!, mine!)).toBeUndefined()
    expect(threadSpacing(turn!, turn!)).toBeUndefined()
    expect(threadSpacing({ kind: 'pending', key: 'p', text: 'hoi', images: [], files: [], pageContexts: [] }, turn!)).toBe('beat')
  })
})

describe('the project thread bundle', () => {
  const card = (id: string, handoffId: string, ts: number): ThreadEvent => ({
    id, ts, type: 'system_note', kind: 'info', text: 'Proposed.', workHandoffId: handoffId, workHandoffVersion: 1, workHandoffPhase: 'created',
  })
  const note = (id: string, ts: number, file: string, line: string, action: 'add' | 'create' = 'add'): ThreadEvent => ({
    id, ts, type: 'system_note', kind: 'info', text: line, projectFileWrite: { file, action, line, by: 'Export' },
  })
  const mine = (id: string, ts: number): ThreadEvent => ({ id, ts, type: 'user_message', text: 'Hoe staat het?', mentions: [] })
  const reply = (turnId: string, ts: number): ThreadEvent[] => [
    { id: `m_${turnId}`, ts, type: 'agent_message', turnId, agentId: '__single__', messageId: `m_${turnId}`, text: 'Klaar.' },
    { id: `r_${turnId}`, ts: ts + 1, type: 'turn_result', turnId, agentId: '__single__' } as ThreadEvent,
  ]
  const wake = (id: string, ts: number): ThreadEvent => ({ id, ts, type: 'user_message', source: 'project_thread', threadReason: 'report', text: 'wake', mentions: [] })
  const state = workspace([
    // Confirmed: settled in the overview, Done in the thread.
    handoff('h1', { workChatId: 'loose', goalReachedAt: 2, goalReport: { result: 'Export works.' }, goalConfirmedAt: 3 }),
    // Accepted and quiet: Needs you in both.
    handoff('h2', { workChatId: 'session' }),
    // A result to confirm and a proposal to accept: The user acts on both.
    handoff('h3', { workChatId: 'quiet', goalReachedAt: 2, goalReport: { result: 'Ready.' } }),
    handoff('h4', { acceptedAt: null }),
  ])
  const feedOf = (events: ThreadEvent[]) => projectThreadFeed(projectWorkHandoffs(
    rowsOf({ ...emptyThread, events }), state.workHandoffs, state.chats, state.projects, state.agents, state.checkoutStatus, sessionLiveOf(state)))
  const bundles = (feed: Row[]) => feed.flatMap((row) => row.kind === 'thread_bundle' ? [row] : [])

  it('folds Session notices and file writes into one line, and leaves the cards the user acts on standing', () => {
    const feed = feedOf([
      mine('u1', 1), ...reply('t1', 2),
      card('c1', 'h1', 4), card('c4', 'h4', 5), note('n1', 6, 'notes.md', 'Export shipped'), card('c2', 'h2', 7),
      note('n2', 8, 'notes.md', 'Import started'), card('c3', 'h3', 9), note('n3', 10, 'preferences.md', 'Round corners'),
      { id: 'l1', ts: 11, type: 'system_note', kind: 'info', text: 'Export reached its goal with one learning.', threadPending: '- preference: "x"' },
    ])
    expect(feed.map((row) => row.key)).toEqual(['u1', 'turn:t1:__single__', 'work:h4', 'work:h3', 'bundle:u1'])
    const [bundle] = bundles(feed)
    expect(bundle?.items.map((row) => row.key)).toEqual(['work:h1', 'n1', 'work:h2', 'n2', 'n3', 'l1'])
    expect(bundle?.summary).toBe('1 Session done, 1 needs you, 2 lines in notes.md, 1 line in preferences.md, learnings from 1 Session')
  })

  it('shows one chip per kind of thing that happened, and one tile per item, kind by kind in the chips\' order', () => {
    const feed = feedOf([
      mine('u1', 1), card('c1', 'h1', 4), note('n1', 6, 'notes.md', '**Export** shipped'), card('c2', 'h2', 7),
      note('n2', 8, 'notes.md', '[ ] Import started'), note('n3', 10, 'preferences.md', 'Round corners'),
      { id: 'l1', ts: 11, type: 'system_note', kind: 'info', text: 'Export reached its goal with one learning.', threadPending: '- preference: "x"' },
    ])
    const view = threadBundleView(bundles(feed)[0]!.items)
    // Every Session on one chip, coloured by the one that waits on the user; a file by what writing to it did.
    expect(view.chips.map((chip) => `${chip.count} ${chip.label}`)).toEqual(['2 Sessions', '2 written notes', '1 saved preference', '1 learning'])
    expect(view.chips.map((chip) => chip.tone)).toEqual(['warn', 'busy', 'busy', 'warn'])
    // Sessions first, then notes, then learnings; within a kind the order they came in.
    expect(view.entries.map((entry) => entry.key)).toEqual(['work:h1', 'work:h2', 'n1', 'n2', 'n3', 'l1'])
    expect(view.entries.map((entry) => entry.kind)).toEqual(['item', 'item', 'note', 'note', 'note', 'note'])
    // A note reads as one plain line and opens to all of it as written, a notes.md line without its checkbox.
    expect(view.entries.flatMap((entry) => entry.kind === 'note' ? [[entry.title, entry.text, entry.tag]] : [])).toEqual([
      ['Export shipped', '**Export** shipped', 'notes.md'],
      ['Import started', 'Import started', 'notes.md'],
      ['Round corners', 'Round corners', 'preferences.md'],
      ['Export reached its goal with one learning.', 'Export reached its goal with one learning.', expect.any(String)],
    ])
    // Only finished Sessions: the chip says they are done.
    expect(threadBundleView(bundles(feed)[0]!.items.slice(0, 2)).chips[0]).toMatchObject({ label: 'Session done', tone: 'ok' })
    // A card write reads as a card line, a new card as a created card, each beside its file.
    const cards = threadBundleView(bundles(feedOf([
      mine('u1', 1), note('k1', 2, 'project_client_print.md', 'Print keeps square corners', 'create'), note('k2', 3, 'project_client_print.md', 'Bleed is 3 mm'),
      note('k3', 4, 'project_client_ink.md', 'Ink is matte'),
    ]))[0]!.items)
    expect(cards.chips.map((chip) => `${chip.count} ${chip.label}`)).toEqual(['1 created card', '2 saved card lines'])
    expect(cards.entries.flatMap((entry) => entry.kind === 'note' ? [entry.tag] : [])).toEqual(['project_client_print.md', 'project_client_print.md', 'project_client_ink.md'])
    // A learning that came first still stands after a later report.
    const learned = feedOf([
      mine('u1', 1), card('c1', 'h1', 4),
      { id: 'l1', ts: 5, type: 'system_note', kind: 'info', text: 'Learned.', threadPending: '- preference: "x"' },
      { id: 'r1', ts: 6, type: 'system_note', kind: 'info', text: 'Reported.', projectReport: { from: 'Export', kind: 'note', text: 'Reported.' } },
    ])
    expect(threadBundleView(bundles(learned)[0]!.items).entries.map((entry) => entry.key)).toEqual(['work:h1', 'r1', 'l1'])
  })

  it('counts every write of a turn on the chips, and draws its reply and each write as a line', () => {
    const write = (id: string, ts: number, file: 'notes.md' | 'preferences.md', action: 'add' | 'remove' = 'add'): ThreadEvent => ({
      id, ts, type: 'system_note', kind: 'info', text: 'w', projectFileWrite: { file, action, line: id, by: 'Project thread', turnId: 't2' },
    })
    const feed = feedOf([mine('u1', 1), ...reply('t1', 2), wake('k2', 10), ...reply('t2', 11), write('w1', 12, 'notes.md'), write('w2', 12, 'notes.md'), write('w3', 12, 'preferences.md'), write('w4', 12, 'preferences.md', 'remove'), note('n1', 13, 'notes.md', 'Status')])
    const view = threadBundleView(bundles(feed)[0]!.items)
    // A removal says so; it never counts as a save.
    expect(view.chips.map((chip) => `${chip.count} ${chip.label}`)).toEqual(['3 written notes', '1 saved preference', '1 removed preference'])
    // Its reply keeps the turn's key and stands with its first write; each write is a line of its own.
    expect(view.entries.map((entry) => entry.kind === 'note' ? [entry.key, entry.glyph, entry.title, entry.tag] : entry.key)).toEqual([
      ['turn:t2:__single__', 'update', 'Klaar.', expect.any(String)],
      ['turn:t2:__single__#0', 'file', 'w1', 'notes.md'],
      ['turn:t2:__single__#1', 'file', 'w2', 'notes.md'],
      ['n1', 'file', 'Status', 'notes.md'],
      ['turn:t2:__single__#2', 'file', 'w3', 'preferences.md'],
      ['turn:t2:__single__#3', 'file', expect.any(String), 'Removed, preferences.md'],
    ])
    // A turn that only wrote: its first write takes the turn's key, so a jump to the turn opens a line.
    const silent = feedOf([mine('u1', 1), ...reply('t1', 2), wake('k2', 10), { id: 'm_t2', ts: 11, type: 'agent_message', turnId: 't2', agentId: '__single__', messageId: 'm_t2', text: '' },
      { id: 'r_t2', ts: 12, type: 'turn_result', turnId: 't2', agentId: '__single__' } as ThreadEvent, write('w1', 12, 'notes.md'), note('n1', 13, 'notes.md', 'Status')])
    expect(threadBundleView(bundles(silent)[0]!.items).entries.map((entry) => entry.key)).toEqual(['turn:t2:__single__', 'n1'])
  })

  it('opens a bundle and the line a jump lands on, and only once', () => {
    const feed = feedOf([mine('u1', 1), note('n1', 2, 'notes.md', 'One'), note('n2', 3, 'notes.md', 'Two')])
    const bundle = bundles(feed)[0]!
    const stretch = threadStretch(feed)
    const opened = openThreadBundleAt(NO_OPEN_THREAD_BUNDLES, stretch, bundle, (item) => item.key === 'n2')
    expect(threadBundleOpen(opened, stretch, bundle.key)).toBe(true)
    expect([...threadBundleOpenItems(opened, stretch, bundle)]).toEqual(['n2'])
    expect(openThreadBundleAt(opened, stretch, bundle, (item) => item.key === 'n2')).toBe(opened)
    const later = feedOf([mine('u1', 1), note('n1', 2, 'notes.md', 'One'), note('n2', 3, 'notes.md', 'Two'), mine('u2', 4)])
    expect(threadBundleOpenItems(opened, threadStretch(later), bundle).size).toBe(0)
  })

  it('counts every Session in the group the overview lists it under', () => {
    const [bundle] = bundles(feedOf([card('c1', 'h1', 1), card('c2', 'h2', 2)]))
    const overview = projectSessionOverview(state, 'thread')
    expect(overview.settled.map((row) => row.key)).toEqual(['loose'])
    expect(overview.waiting.map((row) => row.key)).toContain('session')
    expect(bundle?.summary).toBe('1 Session done, 1 needs you')
  })

  it('starts a new bundle at each message from the user and leaves the earlier one where it was', () => {
    const feed = feedOf([note('n0', 0, 'notes.md', 'Zero'), note('n1', 1, 'notes.md', 'One'), mine('u1', 2), ...reply('t1', 3), note('n2', 5, 'notes.md', 'Two'), note('n3', 6, 'notes.md', 'Three'), mine('u2', 7)])
    expect(feed.map((row) => row.key)).toEqual(['bundle:start', 'u1', 'turn:t1:__single__', 'bundle:u1', 'u2'])
    expect(bundles(feed).map((row) => row.summary)).toEqual(['2 lines in notes.md', '2 lines in notes.md'])
  })

  it('leaves a lone item on its own line instead of folding it', () => {
    const feed = feedOf([mine('u1', 1), card('c2', 'h2', 2)])
    expect(feed.map((row) => row.key)).toEqual(['u1', 'work:h2'])
    expect(bundles(feed)).toEqual([])
  })

  it('bundles the thread’s turn for a Session report with its writes, but never a turn the user started', () => {
    const write = (id: string, ts: number, turnId: string): ThreadEvent => ({
      id, ts, type: 'system_note', kind: 'info', text: 'w', projectFileWrite: { file: 'preferences.md', action: 'add', line: 'Round', by: 'Project thread', turnId },
    })
    // A report wake, then the user writes and the queue rides along with their turn.
    const feed = feedOf([
      mine('u1', 1), wake('k1', 2), ...reply('t1', 3), write('w1', 4, 't1'),
      wake('k2', 10), ...reply('t2', 11), write('w2', 12, 't2'), note('n1', 13, 'preferences.md', 'Square'),
    ])
    expect(feed.map((row) => row.key)).toEqual(['u1', 'turn:t1:__single__', 'bundle:u1'])
    expect(bundles(feed)[0]?.items.map((row) => row.key)).toEqual(['turn:t2:__single__', 'n1'])
    expect(bundles(feed)[0]?.summary).toBe('2 lines in preferences.md')
  })

  it('starts a new bundle at a turn the user steered, which stands on its own', () => {
    const feed = feedOf([
      mine('u1', 1), ...reply('t1', 2), note('n1', 4, 'notes.md', 'Before'), note('n1b', 4, 'notes.md', 'Also before'),
      wake('k1', 5),
      { id: 'm_t2', ts: 6, type: 'agent_message', turnId: 't2', agentId: '__single__', messageId: 'm_t2', text: 'Bezig' },
      { id: 's1', ts: 7, type: 'user_message', text: 'Nee, rond.', mentions: [], steersTurnId: 't2' } as ThreadEvent,
      { id: 'r_t2', ts: 8, type: 'turn_result', turnId: 't2', agentId: '__single__' } as ThreadEvent,
      note('n2', 9, 'notes.md', 'After'), note('n2b', 10, 'notes.md', 'Also after'),
    ])
    expect(feed.map((row) => row.key)).toEqual(['u1', 'turn:t1:__single__', 'bundle:u1', 'turn:t2:__single__', 'bundle:s1'])
    expect(threadStretch(feed)).toBe('s1')
    // A second steer in the same turn is a new message too, so opened bundles fold again.
    const twice = feedOf([
      mine('u1', 1), wake('k1', 5),
      { id: 'm_t2', ts: 6, type: 'agent_message', turnId: 't2', agentId: '__single__', messageId: 'm_t2', text: 'Bezig' },
      { id: 's1', ts: 7, type: 'user_message', text: 'Nee, rond.', mentions: [], steersTurnId: 't2' } as ThreadEvent,
      { id: 's2', ts: 8, type: 'user_message', text: 'En groen.', mentions: [], steersTurnId: 't2' } as ThreadEvent,
    ])
    expect(threadStretch(twice)).toBe('s2')
  })

  it('names a question whose answer came after the user wrote again', () => {
    const feed = feedOf([
      { id: 'q1', ts: 1, type: 'system_note', kind: 'info', text: 'Corners?',
        sessionQuestion: { sessionChatId: 'session', requestId: 'r1', agentId: 'wren', title: 'Corners', questions: [] } },
      note('n1', 1, 'notes.md', 'One'),
      mine('u1', 2),
      { id: 'a1', ts: 3, type: 'system_note', kind: 'info', text: 'Answered: Round', sessionAnswer: { sessionChatId: 'session', requestId: 'r1', answers: {}, by: 'user' } },
      note('n2', 4, 'notes.md', 'Two'),
    ])
    expect(bundles(feed).map((row) => row.summary)).toEqual(['1 line in notes.md, 1 question', '1 line in notes.md, 1 answer'])
  })

  it('finds a row folded into a bundle by its bundle', () => {
    const feed = feedOf([mine('u1', 1), note('n1', 2, 'notes.md', 'One'), note('n2', 3, 'notes.md', 'Two')])
    expect(feedIndexOf(feed, 'n1')).toBe(feed.findIndex((row) => row.key === 'bundle:u1'))
    expect(feedIndexOf(feed, 'u1')).toBe(0)
  })

  it('folds every opened bundle again once the user writes', () => {
    const before = feedOf([mine('u1', 1), note('n1', 2, 'notes.md', 'One')])
    const opened = setThreadBundleOpen(NO_OPEN_THREAD_BUNDLES, threadStretch(before), 'bundle:u1', true)
    expect(threadBundleOpen(opened, threadStretch(before), 'bundle:u1')).toBe(true)
    const after = feedOf([mine('u1', 1), note('n1', 2, 'notes.md', 'One'), mine('u2', 3)])
    expect(threadBundleOpen(opened, threadStretch(after), 'bundle:u1')).toBe(false)
  })

  it('keeps a wake turn standing while it runs or asks the user something', () => {
    const running = projectThreadFeed(rowsOf({
      ...emptyThread,
      events: [wake('k1', 1), { id: 'm1', ts: 2, type: 'agent_message', turnId: 't1', agentId: '__single__', messageId: 'm1', text: 'Bezig' }],
      liveTurns: [{ turnId: 't1', agentId: '__single__', state: 'running', startedAt: 2, messages: [] } as never],
    }))
    expect(running.map((row) => row.kind)).toEqual(['turn'])
    const asking = projectThreadFeed(rowsOf({ ...emptyThread, events: [
      wake('k1', 1),
      { id: 'q1', ts: 2, type: 'user_input_request', turnId: 't1', agentId: '__single__', requestId: 'r1', questions: [{ id: 'a', question: 'Welke?', options: [{ label: 'A' }, { label: 'B' }] }] } as never,
      { id: 'r_t1', ts: 3, type: 'turn_result', turnId: 't1', agentId: '__single__' } as ThreadEvent,
    ] }))
    expect(asking.map((row) => row.kind)).toEqual(['turn'])
    const reply = (text: string) => projectThreadFeed(rowsOf({ ...emptyThread, events: [
      wake('k1', 1),
      { id: 'm1', ts: 2, type: 'agent_message', turnId: 't1', agentId: '__single__', messageId: 'm1', text },
      { id: 'r_t1', ts: 3, type: 'turn_result', turnId: 't1', agentId: '__single__' } as ThreadEvent,
      { id: 'n1', ts: 4, type: 'system_note', kind: 'info', text: 'Answered.' },
    ] }))
    // A reply that asks in words waits on the user; one that only reports folds.
    expect(reply('De vraag blijft op jou wachten: kloppen de labels of niet?').map((row) => row.kind)).toEqual(['turn', 'event'])
    for (const text of ['**Kloppen de labels?**', '“Kloppen de labels?”', '(Kloppen de labels?)']) expect(reply(text).map((row) => row.kind)).toEqual(['turn', 'event'])
    expect(reply('Vastgelegd in de notities.').map((row) => row.kind)).toEqual(['thread_bundle'])
  })
})

describe('a Session before it has a title', () => {
  it('reads New Session, while a DM and a written title keep their own', () => {
    expect(withSessionTitle(chat('a', { title: 'New chat' })).title).toBe('New Session')
    expect(withSessionTitle(chat('b', { title: 'New chat', kind: 'dm' })).title).toBe('New chat')
    expect(withSessionTitle(chat('c', { title: 'Exportknop' })).title).toBe('Exportknop')
  })
})
