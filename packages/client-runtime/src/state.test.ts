import { MAX_SESSION_DIFF_FILES, type AgentConfig, type Chat, type Routine, type ThreadEvent } from '@manor/contracts'
import { describe, expect, it } from 'vitest'
import {
  askMoreMyMindObjects,
  askMyMindObjects,
  clearArtifactRequest,
  chatList,
  consultationsByTurn,
  createListedState,
  emptyThread,
  emptyWorkspace,
  failedFilesStill,
  finishedSilent,
  reduce,
  rowsOf,
  runtimeStartedAgentIds,
  personaOf,
  knownAgentIds,
  rowHasQuoteSource,
  stackedConsultationMarkers,
  relayExchanges,
  relayMarkerAction,
  unannouncedConsultations,
  onlyConsulted,
  snoozeUntilTomorrow,
  subagentGroups,
  tallyDrafts,
  dmMemoryMarks,
} from './state'
import type { NativeSubagent, SubagentSummary } from '@manor/contracts'
import { askChildThread, clearRunningTurns, leaveChat, selectChat, withRoutineRunsRead } from './workspaceActions'

describe('runtime Auto eligibility', () => {
  it('tracks completed, failed and live turns without treating info notes as a turn', () => {
    expect(runtimeStartedAgentIds({
      events: [
        { id: 'reply', ts: 1, type: 'agent_message', agentId: 'sage', turnId: 'turn-1', messageId: 'message-1', text: 'Done.' },
        { id: 'info', ts: 2, type: 'system_note', kind: 'info', agentId: 'iris', turnId: 'turn-2', text: 'FYI.' },
        { id: 'failed', ts: 3, type: 'system_note', kind: 'error', agentId: 'smith', turnId: 'turn-3', text: 'Failed.' },
      ],
      liveTurns: [{ turnId: 'turn-4', agentId: 'argus', messages: [], state: 'running', startedAt: 4 }],
    })).toEqual(['argus', 'sage', 'smith'])
  })
})

describe('reconnected directory', () => {
  const chat: Chat = {
    id: 'dm_1', projectId: null, kind: 'dm', routineId: null, parentChatId: null,
    memberIds: ['sage'], sideModel: null, sideEffort: null, title: 'Sage',
    lastMessagePreview: '', createdAt: 1, lastMessageAt: 1, settledAt: null,
    archivedAt: null, agentIds: ['sage'], checkout: { mode: 'current', branch: null },
  }

  it('clears a stale running turn in a thread that was not reopened', () => {
    const running = {
      ...emptyWorkspace,
      chats: [chat],
      activity: { [chat.id]: {
        unread: false, runningTurns: ['turn_old'], runStartedAt: 10, sawStart: true,
        awaitingInput: [], answeredInput: [],
      } },
      threads: { [chat.id]: {
        ...emptyThread,
        liveTurns: [{ turnId: 'turn_old', agentId: 'sage', messages: [], state: 'running' as const, startedAt: 10 }],
      } },
    }
    const directory = { type: 'directory' as const, projects: [], chats: [chat], workHandoffs: [], runningTurns: {} }

    const reconciled = reduce(running, directory)
    expect(reconciled.activity[chat.id]?.runningTurns).toEqual([])
    expect(reconciled.threads[chat.id]?.liveTurns).toEqual([])

    const stillRunning = reduce(running, { ...directory, runningTurns: { [chat.id]: ['turn_old'] } })
    expect(stillRunning.activity[chat.id]?.runningTurns).toEqual(['turn_old'])
    expect(stillRunning.threads[chat.id]?.liveTurns).toHaveLength(1)
    const lateDirectory = reduce(reconciled, { ...directory, runningTurns: { [chat.id]: ['turn_old'] } })
    expect(lateDirectory.activity[chat.id]?.runningTurns).toEqual([])
  })

  it('lights a turn the reconnect directory lists, unless this socket already heard it end', () => {
    const connected = clearRunningTurns({ ...emptyWorkspace, chats: [chat] })
    const listing = { type: 'directory' as const, projects: [], chats: [chat], workHandoffs: [], runningTurns: { [chat.id]: ['turn_1'] } }
    expect(reduce(connected, listing).activity[chat.id]?.runningTurns).toEqual(['turn_1'])
    const ended = reduce(connected, { type: 'turn_state', chatId: chat.id, turnId: 'turn_1', agentId: 'sage', state: 'done' })
    expect(reduce(ended, listing).activity[chat.id]?.runningTurns ?? []).toEqual([])
  })
})

describe('subagents in the sidebar', () => {
  const child = (id: string, state: SubagentSummary['state'], turnId: string, startedAt: number): SubagentSummary => ({
    id, parentChatId: 'dm_1', title: id, agentId: 'sage', turnId, toolCallId: `subagent_${id}`,
    driver: 'codex', model: 'gpt-6.1-sol', effort: 'high', state, startedAt, depth: 1,
  })

  it('lists only working children, and drops a finished one even while its turn runs', () => {
    const subagents = [child('c', 'running', 'turn_2', 3), child('b', 'done', 'turn_2', 2), child('a', 'failed', 'turn_1', 1)]
    const running = {
      ...emptyWorkspace,
      subagents,
      activity: { dm_1: { unread: false, runningTurns: ['turn_2'], runStartedAt: 2, sawStart: true, awaitingInput: [], answeredInput: [] } },
    }
    expect(subagentGroups(running).dm_1!.children.map((entry) => entry.id)).toEqual(['c'])
    // Once the last one finishes the row has nothing under it.
    expect(subagentGroups({ ...running, subagents: [{ ...subagents[0]!, state: 'cancelled' }, subagents[1]!, subagents[2]!] })).toEqual({})
  })

  it('nests a child of a child under the row its line starts from', () => {
    const grandchild = { ...child('g', 'running', 'turn_c', 4), parentChatId: 'b', depth: 2 }
    const groups = subagentGroups({
      ...emptyWorkspace,
      subagents: [grandchild, child('c', 'running', 'turn_2', 3), child('b', 'running', 'turn_2', 2)],
    })
    expect(Object.keys(groups)).toEqual(['dm_1'])
    expect(groups.dm_1!.children.map((entry) => entry.id)).toEqual(['b', 'g', 'c'])
    expect(groups.dm_1!.depth).toEqual({ g: 1 })
  })

  it('keeps a finished child while its own child is still being stopped, so that one does not hang loose', () => {
    const grandchild = { ...child('g', 'running', 'turn_b', 4), parentChatId: 'b', depth: 2 }
    const subagents = [grandchild, child('b', 'done', 't', 2), child('a', 'done', 't', 1)]
    const groups = subagentGroups({ ...emptyWorkspace, subagents })
    expect(groups.dm_1!.children.map((entry) => entry.id)).toEqual(['b', 'g'])
    expect(groups.dm_1!.depth).toEqual({ g: 1 })
    expect(subagentGroups({ ...emptyWorkspace, subagents: [{ ...grandchild, state: 'done' }, subagents[1]!, subagents[2]!] })).toEqual({})
  })

  it("lists a provider's own helper under the chat whose turn started it, and under a child that started it", () => {
    const helper = (toolCallId: string, parentChatId: string): NativeSubagent => ({
      parentChatId, agentId: 'argus', turnId: 't', toolCallId, driver: 'codex', title: toolCallId, startedAt: 5,
    })
    const groups = subagentGroups({
      ...emptyWorkspace,
      subagents: [child('b', 'running', 'turn_2', 2)],
      nativeSubagents: [helper('call_1', 'dm_1'), helper('call_2', 'b')],
    })
    expect(groups.dm_1!.children.map((entry) => [entry.id, entry.state])).toEqual([['b', 'running'], ['b:call_2', 'running'], ['dm_1:call_1', 'running']])
    expect(groups.dm_1!.depth).toEqual({ 'b:call_2': 1 })
  })

  it('keeps the stored row a child thread snapshot carries', () => {
    const stored = { ...child('old_child', 'cancelled', 't', 1), reason: 'Stopped by Sam.' }
    const opened = reduce(askChildThread(emptyWorkspace, 'old_child', 'dm_1'), {
      type: 'snapshot', chatId: 'old_child', events: [], usage: {}, subagent: stored,
    })
    expect(opened.threads.old_child?.subagent).toEqual(stored)
  })

  it('holds an opened older child thread until its parent is gone', () => {
    const parent: Chat = {
      id: 'dm_1', projectId: null, kind: 'dm', routineId: null, parentChatId: null,
      memberIds: ['sage'], sideModel: null, sideEffort: null, title: 'Sage',
      lastMessagePreview: '', createdAt: 1, lastMessageAt: 1, settledAt: null,
      archivedAt: null, agentIds: ['sage'], checkout: { mode: 'current', branch: null },
    }
    const opened = reduce(askChildThread(emptyWorkspace, 'old_child', 'dm_1'), {
      type: 'snapshot', chatId: 'old_child', events: [], usage: {},
    })
    expect(opened.openChatId).toBeNull()
    const directory = { type: 'directory' as const, projects: [], chats: [parent], workHandoffs: [], subagents: [] }
    expect(reduce(opened, directory).threads.old_child).toBeDefined()
    const parentGone = reduce(opened, { ...directory, chats: [] })
    expect(parentGone.threads.old_child).toBeUndefined()
    expect(parentGone.childThreads).toEqual({})
  })
})

const dmRoutine: Routine = {
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
}

describe('routine run history replies', () => {
  it('keeps only a reply for the routine\'s current target', () => {
    const run = { id: 'prompt_1', chatId: 'dm_1', startedAt: 100, state: 'done' as const, result: null }
    const withRoutine = reduce(emptyWorkspace, { type: 'routines', routines: [dmRoutine] })
    const loaded = reduce(withRoutine, {
      type: 'routine_runs',
      routineId: dmRoutine.id,
      chatId: 'dm_1',
      runs: [run],
    })

    expect(loaded.routineHistories[dmRoutine.id]).toEqual({ chatId: 'dm_1', runs: [run] })
    expect(reduce(loaded, {
      type: 'routine_runs',
      routineId: dmRoutine.id,
      chatId: 'dm_old',
      runs: [],
    })).toBe(loaded)

    const retargeted = reduce(loaded, {
      type: 'routines',
      routines: [{ ...dmRoutine, chatId: 'dm_2' }],
    })
    expect(retargeted.routineHistories).toEqual({})
  })

  it('keeps a project routine\'s history across a routines broadcast', () => {
    const projectRoutine = { ...dmRoutine, projectId: 'p1', chatId: null }
    const run = { id: 'run_1', chatId: 'run_1', startedAt: 100, state: 'done' as const, result: 'Two tickets.' }
    const loaded = reduce(reduce(emptyWorkspace, { type: 'routines', routines: [projectRoutine] }), {
      type: 'routine_runs', routineId: projectRoutine.id, chatId: null, runs: [run],
    })

    const rebroadcast = reduce(loaded, { type: 'routines', routines: [{ ...projectRoutine, unreadRunIds: ['run_1'] }] })

    expect(rebroadcast.routineHistories[projectRoutine.id]?.runs).toEqual([run])
  })
})

describe('reading routine runs', () => {
  it('drops the named runs, or every run, before the server answers', () => {
    const unread = reduce(emptyWorkspace, {
      type: 'routines',
      routines: [
        { ...dmRoutine, unreadRunIds: ['a', 'b'] },
        { ...dmRoutine, id: 'routine_2', unreadRunIds: ['c'] },
      ],
    })

    const one = withRoutineRunsRead(unread, dmRoutine.id, ['a'])
    expect(one.routines.map((routine) => routine.unreadRunIds)).toEqual([['b'], ['c']])
    expect(withRoutineRunsRead(one, dmRoutine.id, ['a'])).toBe(one)
    expect(withRoutineRunsRead(one, null).routines.map((routine) => routine.unreadRunIds)).toEqual([[], []])
  })
})

describe('quiet routine activity', () => {
  it('clears a finished turn without marking a DM unread', () => {
    const running = reduce(emptyWorkspace, {
      type: 'turn_state', chatId: 'dm_1', turnId: 'turn_1', agentId: 'sage', state: 'running',
    })
    const quiet = reduce(running, {
      type: 'turn_state', chatId: 'dm_1', turnId: 'turn_1', agentId: 'sage', state: 'done',
      routineOutcome: 'quiet',
    })
    expect(quiet.activity.dm_1?.runningTurns).toEqual([])
    expect(quiet.activity.dm_1?.unread).toBe(false)

    const published = reduce(running, {
      type: 'turn_state', chatId: 'dm_1', turnId: 'turn_1', agentId: 'sage', state: 'done',
      routineOutcome: 'publish',
    })
    expect(published.activity.dm_1?.unread).toBe(true)
  })
})

describe('durable transcript projection', () => {
  it('names the bare session voice without turning it into a roster persona', () => {
    expect(personaOf([], '__single__')).toEqual({ name: 'Assistant', color: '#8a8f98' })
  })

  it('keeps only roster-resolved ids for a face stack, so an unknown id draws no face', () => {
    const roster = [{ id: 'wren' }, { id: 'argus' }] as AgentConfig[]
    expect(knownAgentIds(roster, ['wren', 'ghost', 'argus'])).toEqual(['wren', 'argus'])
    expect(knownAgentIds([], ['wren', 'argus'])).toEqual([])
  })

  it('groups each turn\'s distinct outgoing consultations without treating return markers as sends', () => {
    const events: ThreadEvent[] = [
      {
        id: 'relay-sage-sent', ts: 1, type: 'agent_relay', agentId: 'marlow', peerAgentId: 'sage',
        pairChatId: 'pair_sage', turnId: 'turn_1', relayId: 'relay_sage', phase: 'sent',
      },
      {
        id: 'relay-smith-sent', ts: 2, type: 'agent_relay', agentId: 'marlow', peerAgentId: 'smith',
        pairChatId: 'pair_smith', turnId: 'turn_1', relayId: 'relay_smith', phase: 'sent',
      },
      {
        id: 'relay-sage-repeat', ts: 3, type: 'agent_relay', agentId: 'marlow', peerAgentId: 'sage',
        pairChatId: 'pair_sage', turnId: 'turn_1', relayId: 'relay_sage', phase: 'sent',
      },
      {
        id: 'relay-return', ts: 4, type: 'agent_relay', agentId: 'sage', peerAgentId: 'marlow',
        pairChatId: 'pair_sage', turnId: 'remote_turn', relayId: 'relay_return', phase: 'received',
      },
    ]

    const rows = rowsOf({ ...emptyThread, events })
    const consultations = consultationsByTurn(rows)
    expect(consultations.get('turn_1')).toEqual([
      { agentId: 'sage', pairChatId: 'pair_sage' },
      { agentId: 'smith', pairChatId: 'pair_smith' },
    ])
    expect(consultations.has('remote_turn')).toBe(false)
    expect([...stackedConsultationMarkers(rows)]).toEqual([
      ['relay-sage-sent', consultations.get('turn_1')],
      ['relay-smith-sent', []],
      ['relay-sage-repeat', []],
    ])
  })

  it('lets the marker carry the question only when the asking turn said nothing', () => {
    const events: ThreadEvent[] = [
      { id: 'silent-tool', ts: 1, type: 'tool_use', turnId: 'turn_silent', agentId: 'smith', tool: 'message_agent' },
      {
        id: 'silent-sent', ts: 2, type: 'agent_relay', agentId: 'smith', peerAgentId: 'iris',
        pairChatId: 'pair_iris', turnId: 'turn_silent', relayId: 'relay_silent', phase: 'sent',
        preview: 'Which spacing should the relay rows use?',
      },
      { id: 'silent-result', ts: 3, type: 'turn_result', agentId: 'smith', turnId: 'turn_silent' },
      { id: 'ack-text', ts: 4, type: 'agent_message', agentId: 'smith', turnId: 'turn_ack', text: 'Ik vraag Iris naar de kleur; haar antwoord volgt.' },
      { id: 'ack-tool', ts: 5, type: 'tool_use', turnId: 'turn_ack', agentId: 'smith', tool: 'message_agent' },
      {
        id: 'ack-sent', ts: 6, type: 'agent_relay', agentId: 'smith', peerAgentId: 'iris',
        pairChatId: 'pair_iris', turnId: 'turn_ack', relayId: 'relay_ack', phase: 'sent',
        preview: 'And the colour?',
      },
      { id: 'ack-result', ts: 7, type: 'turn_result', agentId: 'smith', turnId: 'turn_ack' },
    ]

    const turns = rowsOf({ ...emptyThread, events }, 'dm').filter((row) => row.kind === 'turn')
    expect(turns.map((turn) => [turn.turnId, onlyConsulted(turn)])).toEqual([['turn_silent', true], ['turn_ack', false]])

    const pending = unannouncedConsultations(rowsOf({ ...emptyThread, events }, 'dm'))
    expect([...pending]).toEqual([
      ['turn_silent', [{ relayId: 'relay_silent', agentId: 'iris', question: 'Which spacing should the relay rows use?', replyPending: true }]],
    ])

    const replied = unannouncedConsultations(rowsOf({ ...emptyThread, events: [...events, {
      id: 'silent-received', ts: 8, type: 'agent_relay', agentId: 'smith', peerAgentId: 'iris',
      pairChatId: 'pair_iris', turnId: 'turn_silent', relayId: 'relay_silent', phase: 'received',
    }] }, 'dm'))
    expect(replied.get('turn_silent')?.[0]?.replyPending).toBe(false)
  })

  it('stacks consecutive incoming replies and leaves a later one on its own marker', () => {
    const events: ThreadEvent[] = [
      {
        id: 'sent-desk', ts: 1, type: 'agent_relay', agentId: 'marlow', peerAgentId: 'desk',
        pairChatId: 'pair_desk', turnId: 'turn_1', relayId: 'relay_desk', phase: 'sent',
      },
      {
        id: 'sent-mercer', ts: 2, type: 'agent_relay', agentId: 'marlow', peerAgentId: 'mercer',
        pairChatId: 'pair_mercer', turnId: 'turn_1', relayId: 'relay_mercer', phase: 'sent',
      },
      {
        id: 'sent-smith', ts: 3, type: 'agent_relay', agentId: 'marlow', peerAgentId: 'smith',
        pairChatId: 'pair_smith', turnId: 'turn_1', relayId: 'relay_smith', phase: 'sent',
      },
      {
        id: 'from-desk', ts: 4, type: 'agent_relay', agentId: 'marlow', peerAgentId: 'desk',
        pairChatId: 'pair_desk', turnId: 'turn_1', relayId: 'relay_desk', phase: 'received',
      },
      {
        id: 'from-mercer', ts: 5, type: 'agent_relay', agentId: 'marlow', peerAgentId: 'mercer',
        pairChatId: 'pair_mercer', turnId: 'turn_1', relayId: 'relay_mercer', phase: 'received',
      },
      {
        id: 'reply', ts: 6, type: 'agent_message', agentId: 'marlow', turnId: 'turn_2', text: 'Desk is back.',
      },
      { id: 'result', ts: 7, type: 'turn_result', agentId: 'marlow', turnId: 'turn_2' },
      {
        id: 'from-smith', ts: 8, type: 'agent_relay', agentId: 'marlow', peerAgentId: 'smith',
        pairChatId: 'pair_smith', turnId: 'turn_1', relayId: 'relay_smith', phase: 'received',
      },
    ]

    const rows = rowsOf({ ...emptyThread, events })
    // Desk and Mercer answered inside the same exchange, so each folds into one line.
    expect([...relayExchanges(rows).keys()]).toEqual(['sent-desk', 'from-desk', 'sent-mercer', 'from-mercer'])
    expect([...stackedConsultationMarkers(rows)]).toEqual([])
    const withoutExchanges = new Map()
    expect([...stackedConsultationMarkers(rows, withoutExchanges)]).toEqual([
      ['sent-desk', [
        { agentId: 'desk', pairChatId: 'pair_desk' },
        { agentId: 'mercer', pairChatId: 'pair_mercer' },
        { agentId: 'smith', pairChatId: 'pair_smith' },
      ]],
      ['sent-mercer', []],
      ['sent-smith', []],
      ['from-desk', [
        { agentId: 'desk', pairChatId: 'pair_desk' },
        { agentId: 'mercer', pairChatId: 'pair_mercer' },
      ]],
      ['from-mercer', []],
    ])
  })

  it('merges one agent\'s messages both ways in an exchange into one counted line', () => {
    const relay = (id: string, ts: number, peerAgentId: string, relayId: string, phase: 'sent' | 'received' | 'failed'): ThreadEvent => ({
      id, ts, type: 'agent_relay', agentId: 'marlow', peerAgentId, pairChatId: `pair_${peerAgentId}`, turnId: 'turn_1', relayId, phase,
    })
    const events: ThreadEvent[] = [
      { id: 'ask', ts: 1, type: 'agent_message', agentId: 'marlow', turnId: 'turn_1', text: 'Asking Post and Sage.' },
      { id: 'ask-result', ts: 2, type: 'turn_result', agentId: 'marlow', turnId: 'turn_1' },
      relay('to-post', 3, 'post', 'relay_post', 'sent'),
      relay('to-post-again', 4, 'post', 'relay_post', 'sent'),
      relay('to-sage', 5, 'sage', 'relay_sage', 'sent'),
      relay('to-post-2', 6, 'post', 'relay_post_2', 'sent'),
      relay('from-post', 7, 'post', 'relay_post', 'received'),
      relay('from-post-2', 8, 'post', 'relay_post_2', 'received'),
      relay('from-sage', 9, 'sage', 'relay_sage', 'failed'),
      { id: 'reply', ts: 10, type: 'agent_message', agentId: 'marlow', turnId: 'turn_2', text: 'Post answered.' },
      { id: 'reply-result', ts: 11, type: 'turn_result', agentId: 'marlow', turnId: 'turn_2' },
      relay('to-post-3', 12, 'post', 'relay_post_3', 'sent'),
    ]

    const rows = rowsOf({ ...emptyThread, events }, 'dm')
    const exchanges = relayExchanges(rows)
    // Two asks and two replies with Post count four; the duplicate durable send counts once.
    expect(exchanges.get('to-post')).toEqual({ agentId: 'post', pairChatId: 'pair_post', count: 4, relayIds: ['relay_post', 'relay_post_2'] })
    expect(['to-post-again', 'to-post-2', 'from-post', 'from-post-2'].map((id) => exchanges.get(id))).toEqual([null, null, null, null])
    // Sage's reply failed and the later send is still one-way: both keep their own markers.
    expect(exchanges.has('to-sage')).toBe(false)
    expect(exchanges.has('from-sage')).toBe(false)
    expect(exchanges.has('to-post-3')).toBe(false)
    expect(exchanges.size).toBe(5)
    expect(relayMarkerAction('sent', exchanges.get('to-post') ?? undefined)).toBe('4 messages with')
    expect(relayMarkerAction('sent', { count: 1 })).toBe('1 message with')
    expect(relayMarkerAction('sent')).toBe('Messaged')
  })

  it('never stacks replies across a visible exchange line', () => {
    const relay = (id: string, ts: number, peerAgentId: string, phase: 'sent' | 'received'): ThreadEvent => ({
      id, ts, type: 'agent_relay', agentId: 'marlow', peerAgentId, pairChatId: `pair_${peerAgentId}`, turnId: 'turn_1', relayId: `relay_${peerAgentId}`, phase,
    })
    const rows = rowsOf({ ...emptyThread, events: [
      relay('from-sage', 1, 'sage', 'received'),
      relay('to-smith', 2, 'smith', 'sent'),
      relay('from-smith', 3, 'smith', 'received'),
      relay('from-iris', 4, 'iris', 'received'),
    ] }, 'dm')
    expect(relayExchanges(rows).get('to-smith')?.count).toBe(2)
    // Sage above the Smith line and Iris below it each keep their own marker, in place.
    expect([...stackedConsultationMarkers(rows)]).toEqual([])
  })

  it('keeps an exchange whole across a silent asking turn and splits it at a visible row', () => {
    const events: ThreadEvent[] = [
      { id: 'tool', ts: 1, type: 'tool_use', turnId: 'turn_silent', agentId: 'marlow', tool: 'message_agent' },
      {
        id: 'sent', ts: 2, type: 'agent_relay', agentId: 'marlow', peerAgentId: 'post',
        pairChatId: 'pair_post', turnId: 'turn_silent', relayId: 'relay_1', phase: 'sent',
      },
      { id: 'result', ts: 3, type: 'turn_result', agentId: 'marlow', turnId: 'turn_silent' },
      {
        id: 'received', ts: 4, type: 'agent_relay', agentId: 'marlow', peerAgentId: 'post',
        pairChatId: 'pair_post', turnId: 'turn_silent', relayId: 'relay_1', phase: 'received',
      },
    ]
    expect(relayExchanges(rowsOf({ ...emptyThread, events }, 'dm')).get('sent')?.count).toBe(2)

    const split: ThreadEvent[] = [
      events[1]!,
      { id: 'user', ts: 3, type: 'user_message', text: 'Any news?', mentions: [] },
      events[3]!,
    ]
    expect(relayExchanges(rowsOf({ ...emptyThread, events: split }, 'dm')).size).toBe(0)
  })

  it('keeps relay markers and agent-authored pair messages as distinct durable rows', () => {
    const events: ThreadEvent[] = [
      {
        id: 'relay-sent', ts: 1, type: 'agent_relay', agentId: 'marlow', peerAgentId: 'sage',
        pairChatId: 'pair_1', turnId: 'turn_1', relayId: 'relay_1', phase: 'sent',
      },
      {
        id: 'pair-message', ts: 2, type: 'user_message', source: 'agent_relay', text: 'What is your verdict?', mentions: [],
        authorAgentId: 'marlow', originChatId: 'dm_1', originTurnId: 'turn_1', relayId: 'relay_1', relayDepth: 1,
      },
      {
        id: 'relay-received', ts: 3, type: 'agent_relay', agentId: 'marlow', peerAgentId: 'sage',
        pairChatId: 'pair_1', turnId: 'turn_1', relayId: 'relay_1', phase: 'received', preview: 'Not now.',
      },
    ]

    const rows = rowsOf({ ...emptyThread, events })
    expect(rows.map((row) => row.kind === 'event' ? row.event.type : row.kind)).toEqual([
      'agent_relay', 'user_message', 'agent_relay',
    ])
    expect(rows[1]).toMatchObject({
      kind: 'event',
      event: { source: 'agent_relay', authorAgentId: 'marlow', text: 'What is your verdict?' },
    })
  })

  it('hides a completed DM routine marker and turn when nothing stood as its reply', () => {
    const events: ThreadEvent[] = [
      {
        id: 'routine-prompt',
        ts: 1,
        type: 'user_message',
        text: 'Check mail.',
        mentions: [],
        source: 'routine',
        routineId: 'routine-mail',
        routineName: 'Mail catch-up',
      },
      {
        id: 'tool',
        ts: 2,
        type: 'tool_use',
        turnId: 'turn-routine',
        agentId: 'post',
        tool: 'gmail_search',
      },
      {
        id: 'old-fallback',
        ts: 3,
        type: 'system_note',
        kind: 'info',
        text: 'Post ended the turn without reporting back.',
        turnId: 'turn-routine',
        agentId: 'post',
      },
      {
        id: 'result',
        ts: 4,
        type: 'turn_result',
        turnId: 'turn-routine',
        agentId: 'post',
      },
    ]

    expect(rowsOf({ ...emptyThread, events }, 'dm')).toEqual([])
    expect(rowsOf({ ...emptyThread, events: events.filter((event) => event.id !== 'old-fallback') }, 'dm')).toEqual([])
  })

  it('hides a historical DM routine reply after its result is marked quiet', () => {
    const events: ThreadEvent[] = [
      {
        id: 'routine-prompt',
        ts: 1,
        type: 'user_message',
        text: 'Check mail.',
        mentions: [],
        source: 'routine',
        routineId: 'routine-mail',
        routineName: 'Mail catch-up',
      },
      {
        id: 'old-reply',
        ts: 2,
        type: 'agent_message',
        turnId: 'turn-routine',
        agentId: 'post',
        text: 'Nothing needs attention.',
      },
      {
        id: 'result',
        ts: 3,
        type: 'turn_result',
        turnId: 'turn-routine',
        agentId: 'post',
        routineOutcome: 'quiet',
      },
    ]

    expect(rowsOf({ ...emptyThread, events }, 'dm')).toEqual([])
  })

  it('keeps silent project runs and DM routine failures visible', () => {
    const prompt = {
      id: 'routine-prompt',
      ts: 1,
      type: 'user_message' as const,
      text: 'Check mail.',
      mentions: [],
      source: 'routine' as const,
      routineId: 'routine-mail',
      routineName: 'Mail catch-up',
    }
    const projectRows = rowsOf({
      ...emptyThread,
      events: [
        prompt,
        { id: 'result', ts: 2, type: 'turn_result', turnId: 'turn-routine', agentId: 'post' },
      ],
    }, 'run')
    const failedDmRows = rowsOf({
      ...emptyThread,
      events: [
        prompt,
        {
          id: 'error',
          ts: 2,
          type: 'system_note',
          kind: 'error',
          text: 'Post could not answer.',
          turnId: 'turn-routine',
          agentId: 'post',
        },
      ],
    }, 'dm')

    expect(projectRows.map((row) => row.kind)).toEqual(['event', 'turn'])
    // In a DM the marker folds into the turn; the failure bubble still names the routine.
    expect(failedDmRows.map((row) => row.kind)).toEqual(['turn'])
    const failedTurn = failedDmRows[0]
    expect(failedTurn?.kind === 'turn' && failedTurn.note).toBeUndefined()
    expect(failedTurn?.kind === 'turn' && failedTurn.answer.map((reply) => reply.text)).toEqual([
      "Mail catch-up didn't finish.",
    ])
  })

  it('hides a DM lease-recovery essay and leaves one failure bubble', () => {
    const rows = rowsOf({
      ...emptyThread,
      events: [
        {
          id: 'routine-prompt',
          ts: 1,
          type: 'user_message',
          text: 'Check Slack.',
          mentions: [],
          source: 'routine',
          routineId: 'routine-slack',
          routineName: 'Slack triage',
        },
        {
          id: 'partial',
          ts: 2,
          type: 'agent_message',
          turnId: 'turn-routine',
          agentId: 'desk',
          text: 'Checking Slack.',
        },
        {
          id: 'lease',
          ts: 3,
          type: 'system_note',
          kind: 'error',
          text: 'The earlier run of "Slack triage" ended without a recorded completion. Its running status has been cleared; later replies belong to a separate turn.',
        },
      ],
    }, 'dm')

    expect(rows.map((row) => row.kind)).toEqual(['turn'])
    const turn = rows[0]
    expect(turn?.kind === 'turn' && turn.note).toBeUndefined()
    expect(turn?.kind === 'turn' && turn.answer.map((reply) => reply.text)).toEqual([
      'Checking Slack.',
      "Slack triage didn't finish.",
    ])
  })

  it('pins a lease-recovery bubble to the routine turn, not a later DM turn', () => {
    const rows = rowsOf({
      ...emptyThread,
      events: [
        {
          id: 'routine-prompt',
          ts: 1,
          type: 'user_message',
          text: 'Check Slack.',
          mentions: [],
          source: 'routine',
          routineId: 'routine-slack',
          routineName: 'Slack triage',
        },
        {
          id: 'partial',
          ts: 2,
          type: 'agent_message',
          turnId: 'turn-routine',
          agentId: 'desk',
          text: 'Checking Slack.',
        },
        {
          id: 'later-user',
          ts: 3,
          type: 'user_message',
          text: 'Wat ging er mis?',
          mentions: [],
        },
        {
          id: 'later-reply',
          ts: 4,
          type: 'agent_message',
          turnId: 'turn-later',
          agentId: 'desk',
          text: 'Ik kijk even.',
        },
        {
          id: 'lease',
          ts: 5,
          type: 'system_note',
          kind: 'error',
          text: 'The earlier run of "Slack triage" ended without a recorded completion. Its running status has been cleared; later replies belong to a separate turn.',
        },
      ],
    }, 'dm')

    expect(rows.map((row) => row.kind)).toEqual(['turn', 'event', 'turn'])
    const routineTurn = rows[0]
    const laterTurn = rows[2]
    expect(routineTurn?.kind === 'turn' && routineTurn.answer.map((reply) => reply.text)).toEqual([
      'Checking Slack.',
      "Slack triage didn't finish.",
    ])
    expect(laterTurn?.kind === 'turn' && laterTurn.answer.map((reply) => reply.text)).toEqual(['Ik kijk even.'])
    expect(laterTurn?.kind === 'turn' && laterTurn.note).toBeUndefined()
  })

  it('folds a DM routine marker into the turn it started, and keeps it elsewhere', () => {
    const events: ThreadEvent[] = [
      {
        id: 'routine-prompt',
        ts: 1,
        type: 'user_message',
        text: 'Check mail.',
        mentions: [],
        source: 'routine',
        routineId: 'routine-mail',
        routineName: 'Mail catch-up',
        routineDueAt: 0,
      },
      { id: 'tool', ts: 2, type: 'tool_use', turnId: 'turn-routine', agentId: 'post', tool: 'gmail_search' },
      { id: 'reply', ts: 3, type: 'agent_message', turnId: 'turn-routine', agentId: 'post', text: 'Two mails need you.' },
      { id: 'result', ts: 4, type: 'turn_result', turnId: 'turn-routine', agentId: 'post' },
    ]
    const state = { ...emptyThread, events }
    const dm = rowsOf(state, 'dm')
    expect(dm.map((row) => row.kind)).toEqual(['turn'])
    expect(dm[0]).toMatchObject({
      routineTrigger: { name: 'Mail catch-up', ts: 1, prompt: 'Check mail.', dueAt: 0 },
    })
    // Same events, same folded turn: a stream delta elsewhere does not re-render it.
    expect(rowsOf(state, 'dm')[0]).toBe(dm[0])

    for (const kind of ['group', 'project', 'run'] as const) {
      const rows = rowsOf(state, kind)
      expect(rows.map((row) => row.kind)).toEqual(['event', 'turn'])
      expect(rows[1]?.kind === 'turn' && rows[1].routineTrigger).toBeUndefined()
    }
  })

  it('leaves a DM reminder as its message alone, and drops a marker whose turn has not started', () => {
    const marker = {
      id: 'routine-prompt',
      ts: 1,
      type: 'user_message' as const,
      text: 'Make tea.',
      mentions: [],
      source: 'routine' as const,
      routineId: 'routine-tea',
      routineName: 'Make tea',
    }
    const reminder = rowsOf({
      ...emptyThread,
      events: [
        marker,
        { id: 'reply', ts: 2, type: 'agent_message', turnId: 'turn-tea', agentId: 'sage', text: 'Make tea.' },
        { id: 'result', ts: 3, type: 'turn_result', turnId: 'turn-tea', agentId: 'sage' },
      ],
    }, 'dm')
    expect(reminder.map((row) => row.kind)).toEqual(['turn'])
    expect(reminder[0]?.kind === 'turn' && reminder[0].segments).toEqual([])
    expect(rowsOf({ ...emptyThread, events: [marker] }, 'dm')).toEqual([])
  })

  it('keeps a finished turn memory trace on the projected turn', () => {
    const events: ThreadEvent[] = [
      {
        id: 'event-1',
        ts: 1,
        type: 'agent_message',
        turnId: 'finished',
        agentId: 'smith',
        messageId: 'message-1',
        text: 'Finished.',
      },
      {
        id: 'event-2',
        ts: 2,
        type: 'turn_result',
        turnId: 'finished',
        agentId: 'smith',
        memoryTrace: {
          reads: [{ source: 'on_demand', path: '/Notes/memory/structured/manor/runtime.md' }],
          summary: {
            status: 'used',
            derivation: 'model',
            items: [{
              text: 'Kept the runtime behind the driver seam.',
              sourcePath: '/Notes/memory/structured/manor/runtime.md',
            }],
          },
        },
      },
    ]

    expect(rowsOf({ ...emptyThread, events })[0]).toMatchObject({
      kind: 'turn',
      memoryTrace: { summary: { status: 'used' } },
    })
  })

  it('keeps historical row identities while a live turn streams', () => {
    const events: ThreadEvent[] = [
      {
        id: 'event-1',
        ts: 1,
        type: 'agent_message',
        turnId: 'finished',
        agentId: 'smith',
        messageId: 'message-1',
        text: 'Finished.',
      },
      { id: 'event-2', ts: 2, type: 'turn_result', turnId: 'finished', agentId: 'smith' },
    ]
    const first = rowsOf({
      ...emptyThread,
      events,
      liveTurns: [{ turnId: 'live', agentId: 'argus', messages: [], state: 'running', startedAt: 3 }],
    })
    const second = rowsOf({
      ...emptyThread,
      events,
      liveTurns: [{
        turnId: 'live',
        agentId: 'argus',
        messages: [{ messageId: 'message-2', text: 'Streaming' }],
        state: 'running',
        startedAt: 3,
      }],
    })

    expect(second[0]).toBe(first[0])
    expect(second[1]).not.toBe(first[1])
  })

  // One event makes a new array and a full rebuild. A list that compares rows by object
  // then redraws only the row that event changed.
  it('keeps the row objects a new event did not change, and renews the one it did', () => {
    const said = (id: string, ts: number, text: string): ThreadEvent => ({ id, ts, type: 'user_message', text, mentions: [] })
    const reply = (id: string, ts: number, turnId: string): ThreadEvent => ({ id, ts, type: 'agent_message', turnId, agentId: 'smith', messageId: id, text: `${id}.` })
    const done = (id: string, ts: number, turnId: string): ThreadEvent => ({ id, ts, type: 'turn_result', turnId, agentId: 'smith' })
    // Each case is its own thread: a rebuild is compared with the last one of its thread.
    const thread = (): ThreadEvent[] => [
      said('e1', 1, 'first'), reply('e2', 2, 'turn-1'), done('e3', 3, 'turn-1'),
      said('e4', 4, 'second'), reply('e5', 5, 'turn-2'),
    ]

    // A tool step lands in the open turn: the three rows before it stay the objects they were.
    const events = thread()
    const first = rowsOf({ ...emptyThread, events })
    expect(first.map((row) => row.kind)).toEqual(['event', 'turn', 'event', 'turn'])
    const stepped = rowsOf({ ...emptyThread, events: [...events, { id: 'e6', ts: 6, type: 'tool_use', turnId: 'turn-2', agentId: 'smith', tool: 'Read' }] })
    expect(stepped[0] === first[0] && stepped[1] === first[1] && stepped[2] === first[2]).toBe(true)
    expect(stepped[3]).not.toBe(first[3])

    // A steer sent before its turn wrote anything moves into that turn once it runs, also
    // when its row was kept from an earlier pass.
    const steered: ThreadEvent[] = [...thread().slice(0, 3), { id: 'e4', ts: 4, type: 'user_message', text: 'steer', mentions: [], steersTurnId: 'turn-9' }]
    rowsOf({ ...emptyThread, events: steered }, 'project')
    const later = rowsOf({
      ...emptyThread,
      events: [...steered, said('e5', 5, 'unrelated')],
      liveTurns: [{ turnId: 'turn-9', agentId: 'smith', messages: [], state: 'running', startedAt: 6 }],
    }, 'project')
    expect(later.filter((row) => row.kind === 'event' && row.event.id === 'e4')).toEqual([])
    expect(later.find((row) => row.kind === 'turn' && row.turnId === 'turn-9')).toMatchObject({ timeline: [{ kind: 'user', row: { event: { id: 'e4' } } }] })

    // An earlier event rewritten in place renews its own row and nothing else.
    const other = thread()
    const before = rowsOf({ ...emptyThread, events: other })
    const patched = rowsOf({ ...emptyThread, events: other.map((event) => event.id === 'e4' ? said('e4', 4, 'second, edited') : event) })
    expect(patched[2]).not.toBe(before[2])
    expect(patched[2]).toMatchObject({ kind: 'event', event: { text: 'second, edited' } })
    expect(patched[0] === before[0] && patched[1] === before[1] && patched[3] === before[3]).toBe(true)
  })
})

describe('the sidebar preview', () => {
  it('keeps the last whole line when a stop cuts a reply off', () => {
    const chat: Chat = {
      id: 'dm_1', projectId: null, kind: 'dm', routineId: null, parentChatId: null,
      memberIds: ['sage'], sideModel: null, sideEffort: null, title: 'Sage',
      lastMessagePreview: 'Look into it', createdAt: 1, lastMessageAt: 1, settledAt: null,
      archivedAt: null, agentIds: ['sage'], checkout: { mode: 'current', branch: null },
    }
    const cut = reduce({ ...emptyWorkspace, chats: [chat] }, {
      type: 'event', chatId: 'dm_1',
      event: { id: 'm1', ts: 2, type: 'agent_message', turnId: 't1', agentId: 'sage', messageId: 'm1', text: 'Half a sent', interrupted: true },
    })
    expect(cut.chats[0]?.lastMessagePreview).toBe('Look into it')
  })

  it('never shows the wake prompt Manor sent a persona', () => {
    const chat: Chat = {
      id: 'dm_1', projectId: null, kind: 'dm', routineId: null, parentChatId: null,
      memberIds: ['sage'], sideModel: null, sideEffort: null, title: 'Sage',
      lastMessagePreview: 'Look into it', createdAt: 1, lastMessageAt: 1, settledAt: null,
      archivedAt: null, agentIds: ['sage'], checkout: { mode: 'current', branch: null },
    }
    const woken = reduce({ ...emptyWorkspace, chats: [chat] }, {
      type: 'event', chatId: 'dm_1',
      event: { id: 'w1', ts: 2, type: 'user_message', source: 'background_wake', mentions: [], text: 'Background work you started has ended.' },
    })
    expect(woken.chats[0]?.lastMessagePreview).toBe('Look into it')
  })
})

describe('agent pair chat list rows', () => {
  const agent = (id: string, name: string): AgentConfig => ({
    id, name, color: '#777777', character: '', driver: 'mock', effort: 'medium', allowedTools: [],
    mcpServers: [], memoryScope: false, description: '', role: '', isCos: false,
  })
  const pair: Chat = {
    id: 'pair_1', projectId: null, kind: 'pair', routineId: null, parentChatId: null,
    memberIds: ['marlow', 'sage'], sideModel: null, sideEffort: null, title: 'Agent conversation',
    lastMessagePreview: 'Sage answered.', createdAt: 1, lastMessageAt: 4, settledAt: null,
    archivedAt: null, agentIds: ['marlow', 'sage'], checkout: { mode: 'current', branch: null },
  }

  it('names the standing channel from both current persona names', () => {
    const rows = chatList({
      ...emptyWorkspace,
      agents: [agent('marlow', 'Jeeves'), agent('sage', 'Sage')],
      chats: [pair],
    })

    expect(rows.find((row) => row.kind === 'pair')).toMatchObject({
      chat: pair,
      title: 'Jeeves ⇄ Sage',
      agentIds: ['marlow', 'sage'],
      preview: 'Sage answered.',
    })
  })

  it('hides a pair row until its opening message exists', () => {
    const rows = chatList({
      ...emptyWorkspace,
      agents: [agent('marlow', 'Jeeves'), agent('sage', 'Sage')],
      chats: [{ ...pair, lastMessagePreview: null }],
    })

    expect(rows.some((row) => row.kind === 'pair')).toBe(false)
  })
})

describe('delivered files', () => {
  it('collects a turn\'s files beside its answer, and a turn that only delivered is not silent', () => {
    const file = (id: string, name: string) => ({ id, name, mime: 'application/pdf', size: 4 })
    const rows = rowsOf({
      ...emptyThread,
      events: [
        { id: 'u', ts: 1, type: 'user_message', text: 'report please', mentions: [] },
        { id: 'f1', ts: 2, type: 'file_delivery', turnId: 't1', agentId: 'smith', file: file('a', 'report.pdf') },
        { id: 'm', ts: 3, type: 'agent_message', turnId: 't1', agentId: 'smith', text: 'Here it is.' },
        { id: 'r', ts: 4, type: 'turn_result', turnId: 't1', agentId: 'smith' },
        { id: 'f2', ts: 5, type: 'file_delivery', turnId: 't2', agentId: 'sage', file: file('b', 'plan.pdf') },
        { id: 'r2', ts: 6, type: 'turn_result', turnId: 't2', agentId: 'sage' },
      ],
    })
    const turns = rows.filter((row) => row.kind === 'turn')
    expect(turns.map((turn) => [turn.agentId, turn.files?.map((delivered) => delivered.name)])).toEqual([
      ['smith', ['report.pdf']],
      ['sage', ['plan.pdf']],
    ])
    expect(turns[0]?.answer.map((reply) => reply.text)).toEqual(['Here it is.'])
    expect(finishedSilent(turns[1]!)).toBe(false)
  })
})

describe('outbound draft projection', () => {
  it('stands a prepared draft in the tail and closes it on submit', () => {
    const prepared: ThreadEvent[] = [
      {
        id: 'user',
        ts: 1,
        type: 'user_message',
        text: 'Draft a gmail to ada@example.com: Hello',
        mentions: [],
      },
      {
        id: 'draft',
        ts: 2,
        type: 'outbound_draft',
        turnId: 'turn-1',
        agentId: 'marlow',
        draftId: 'd1',
        channel: 'gmail',
        to: 'ada@example.com',
        subject: 'Hello',
        body: 'Hello **Ada**',
      },
      {
        id: 'result',
        ts: 3,
        type: 'turn_result',
        turnId: 'turn-1',
        agentId: 'marlow',
      },
    ]
    const open = rowsOf({ ...emptyThread, events: prepared })
    const turn = open.find((row) => row.kind === 'turn')
    expect(turn?.kind === 'turn' && turn.tail[0]).toMatchObject({
      kind: 'draft',
      drafts: [{ draftId: 'd1', body: 'Hello **Ada**' }],
    })

    const closed = rowsOf({
      ...emptyThread,
      events: [
        ...prepared,
        {
          id: 'closed',
          ts: 4,
          type: 'outbound_draft_closed',
          turnId: 'turn-1',
          agentId: 'marlow',
          draftId: 'd1',
          outcome: 'submitted',
          delivery: 'recorded',
          channel: 'gmail',
          to: 'ada@example.com',
          body: 'Hello Ada, edited.',
        },
      ],
    })
    const closedTurn = closed.find((row) => row.kind === 'turn')
    expect(closedTurn?.kind === 'turn' && closedTurn.drafts[0]?.closed).toEqual({
      outcome: 'submitted',
      delivery: 'recorded',
      body: 'Hello Ada, edited.',
    })
  })

  it('stacks every draft of one turn into a single block where the first one landed', () => {
    const draft = (n: number, ts: number): ThreadEvent => ({
      id: `draft-${String(n)}`,
      ts,
      type: 'outbound_draft',
      turnId: 'turn-1',
      agentId: 'marlow',
      draftId: `d${String(n)}`,
      channel: 'gmail',
      to: `person${String(n)}@example.com`,
      body: `Reply ${String(n)}`,
    })
    const events: ThreadEvent[] = [
      draft(1, 1),
      { id: 'say', ts: 2, type: 'agent_message', turnId: 'turn-1', agentId: 'marlow', messageId: 'm1', text: 'Two more.' },
      draft(2, 3),
      draft(3, 4),
      {
        id: 'closed',
        ts: 5,
        type: 'outbound_draft_closed',
        turnId: 'turn-1',
        agentId: 'marlow',
        draftId: 'd2',
        outcome: 'submitted',
        delivery: 'delivered',
        channel: 'gmail',
        to: 'person2@example.com',
        body: 'Reply 2',
      },
      { id: 'result', ts: 6, type: 'turn_result', turnId: 'turn-1', agentId: 'marlow' },
    ]
    const turn = rowsOf({ ...emptyThread, events }).find((row) => row.kind === 'turn')
    if (turn?.kind !== 'turn') throw new Error('expected a turn')
    const blocks = turn.tail.filter((segment) => segment.kind === 'draft')
    expect(blocks).toHaveLength(1)
    expect(turn.tail[0]?.kind).toBe('draft')
    expect(blocks[0]?.kind === 'draft' && blocks[0].drafts.map((entry) => entry.draftId)).toEqual(['d1', 'd2', 'd3'])
    expect(blocks[0]?.kind === 'draft' && tallyDrafts(blocks[0].drafts)).toEqual({
      open: 2,
      locked: 0,
      uncertain: 0,
      sent: 1,
      saved: 0,
      discarded: 0,
      snoozed: 0,
      ignored: 0,
    })
  })

  it('snoozes to nine the next morning, local time, even late at night', () => {
    const late = new Date(2026, 8, 1, 23, 40).getTime()
    expect(new Date(snoozeUntilTomorrow(late)).toString()).toBe(new Date(2026, 8, 2, 9, 0).toString())
  })

  it('keeps post-turn send state and failures on the original draft row', () => {
    const submissionId = '11111111-1111-4111-8111-111111111111'
    const events: ThreadEvent[] = [
      {
        id: 'draft',
        ts: 1,
        type: 'outbound_draft',
        turnId: 'turn-1',
        agentId: 'marlow',
        draftId: 'd1',
        channel: 'gmail',
        to: 'ada@example.com',
        subject: 'Original subject',
        body: 'Hello',
      },
      { id: 'result', ts: 2, type: 'turn_result', turnId: 'turn-1', agentId: 'marlow' },
      {
        id: 'started',
        ts: 3,
        type: 'outbound_draft_submission',
        turnId: 'turn-1',
        agentId: 'marlow',
        draftId: 'd1',
        submissionId,
        status: 'started',
        channel: 'gmail',
        to: 'ada@example.com',
        subject: 'Edited subject',
        body: 'Edited',
      },
      {
        id: 'failed',
        ts: 4,
        type: 'outbound_draft_submission',
        turnId: 'turn-1',
        agentId: 'marlow',
        draftId: 'd1',
        submissionId,
        status: 'failed',
        message: 'Gmail rejected authentication.',
        channel: 'gmail',
        to: 'ada@example.com',
        subject: 'Edited subject',
        body: 'Edited',
      },
    ]

    const rows = rowsOf({ ...emptyThread, events })
    const turns = rows.filter((row) => row.kind === 'turn')
    expect(turns).toHaveLength(1)
    expect(turns[0]?.kind === 'turn' && turns[0].drafts[0]).toMatchObject({
      draftId: 'd1',
      body: 'Edited',
      subject: 'Edited subject',
      failure: 'Gmail rejected authentication.',
    })
  })
})

describe('pending quote projection', () => {
  it('keeps the source and selection on the optimistic user bubble', () => {
    const quotes = [{ kind: 'message' as const, eventId: 'evt_source', text: 'Selected words', agentId: 'sage' }]
    const rows = rowsOf({ ...emptyThread, pending: [{
      key: 'pending:1', text: 'Why [Quote #1]?', images: [], files: [], pageContexts: [], quotes,
    }] })
    expect(rows).toEqual([{ kind: 'pending', key: 'pending:1', text: 'Why [Quote #1]?', images: [], files: [], pageContexts: [], quotes }])
  })
})

describe('durable quote sources', () => {
  it('keeps adjacent Work messages separate when their text is visually joined', () => {
    const events: ThreadEvent[] = [
      { id: 'first', ts: 1, type: 'agent_message', turnId: 'turn', agentId: 'sage', text: 'First thought.' },
      { id: 'second', ts: 2, type: 'agent_message', turnId: 'turn', agentId: 'sage', text: 'Second thought.' },
      { id: 'done', ts: 3, type: 'turn_result', turnId: 'turn', agentId: 'sage' },
    ]
    const turn = rowsOf({ ...emptyThread, events }).find((row) => row.kind === 'turn')
    expect(turn?.kind === 'turn' && turn.answer[0]?.quoteSources).toEqual([
      { eventId: 'first', text: 'First thought.' },
      { eventId: 'second', text: 'Second thought.' },
    ])
    if (turn === undefined) throw new Error('expected turn')
    expect(rowHasQuoteSource(turn, 'second')).toBe(true)
    expect(rowHasQuoteSource(turn, 'missing')).toBe(false)
  })
})

describe('pending reply projection', () => {
  it('keeps the targeted answer on the optimistic user bubble', () => {
    const replyTo = { turnId: 'turn_source', agentId: 'sage', text: 'The source answer.' }
    const rows = rowsOf({
      ...emptyThread,
      pending: [{
        key: 'pending:1',
        text: 'Why?',
        images: [],
        files: [],
        pageContexts: [],
        replyTo,
      }],
    })

    expect(rows).toEqual([{ kind: 'pending', key: 'pending:1', text: 'Why?', images: [], files: [], pageContexts: [], replyTo }])
  })
})

describe('outbound thread decisions', () => {
  it('keeps thread context, projects Ignore, and reopens the same draft on Restore', () => {
    const base: ThreadEvent[] = [
      {
        id: 'draft', ts: 1, type: 'outbound_draft', turnId: 'turn-1', agentId: 'smith', draftId: 'd1',
        channel: 'gmail', to: 'ada@example.com', subject: 'Re: Hello', body: 'Reply', mailAccount: 'personal',
        thread: {
          threadId: '1901234567890123456',
          previous: { from: 'Ada', at: '2026-09-01T08:00:00.000Z', text: 'Hello' },
          earlierCount: 2,
        },
      },
      {
        id: 'ignored', ts: 2, type: 'outbound_draft_closed', turnId: 'turn-1', agentId: 'smith', draftId: 'd1',
        outcome: 'ignored', channel: 'gmail', to: 'ada@example.com', mailAccount: 'personal',
      },
    ]
    const ignored = rowsOf({ ...emptyThread, events: base })
    const ignoredTurn = ignored.find((row) => row.kind === 'turn')
    expect(ignoredTurn?.kind === 'turn' && ignoredTurn.drafts[0]).toMatchObject({
      thread: { threadId: '1901234567890123456', earlierCount: 2 },
      closed: { outcome: 'ignored' },
    })
    expect(ignoredTurn?.kind === 'turn' && tallyDrafts(ignoredTurn.drafts)).toMatchObject({ ignored: 1, open: 0 })

    const restored = rowsOf({
      ...emptyThread,
      events: [...base, {
        id: 'restored', ts: 3, type: 'outbound_draft_reopened', turnId: 'turn-1', agentId: 'smith', draftId: 'd1',
      }],
    })
    const restoredTurn = restored.find((row) => row.kind === 'turn')
    expect(restoredTurn?.kind === 'turn' && restoredTurn.drafts[0]?.closed).toBeUndefined()
    expect(restoredTurn?.kind === 'turn' && tallyDrafts(restoredTurn.drafts)).toMatchObject({ ignored: 0, open: 1 })
  })
})

describe('mymind reconnect state', () => {
  it('drops a lost first-page request without discarding useful objects', () => {
    const asking = askMyMindObjects(emptyWorkspace, 'design', 'request-1')
    const reconnected = clearArtifactRequest(asking)

    expect(reconnected.artifacts).toMatchObject({
      query: '',
      requestId: null,
      askingQuery: null,
      loadingMore: false,
    })
  })

  it('drops a lost load-more request so the current query can restart', () => {
    const ready = {
      ...emptyWorkspace,
      artifacts: {
        ...emptyWorkspace.artifacts,
        query: 'design',
        requestId: 'request-1',
        hasMore: true,
      },
    }
    const loadingMore = askMoreMyMindObjects(ready, 'request-1')
    const reconnected = clearArtifactRequest(loadingMore)

    expect(reconnected.artifacts).toMatchObject({
      query: 'design',
      requestId: null,
      askingQuery: null,
      loadingMore: false,
    })
  })
})


it('replays formatted drafts for multiple personas through failure and final delivery', () => {
  const rich = (text: string) => ({ type: 'rich_text' as const, elements: [{ type: 'rich_text_section' as const, elements: [{ type: 'text' as const, text, style: { bold: true } }] }] })
  const base = { turnId: 'turn-rich', agentId: 'smith', draftId: 'rich', channel: 'slack' as const, to: 'Self', slackChannelId: 'D12345678' }
  const events: ThreadEvent[] = [
    { ...base, type: 'outbound_draft', id: 'rich', ts: 1, body: 'Original', slackRichText: rich('Original') },
    { ...base, type: 'outbound_draft', id: 'other', ts: 2, turnId: 'turn-other', agentId: 'sage', draftId: 'other', body: 'Other' },
  ]
  const current = () => rowsOf({ ...emptyThread, events: [...events] }).flatMap((row) => row.kind === 'turn' ? row.drafts : []).find((draft) => draft.draftId === 'rich')!
  expect(current().slackRichText).toEqual(rich('Original'))
  const submission = { ...base, type: 'outbound_draft_submission' as const, submissionId: '11111111-1111-4111-8111-111111111111', body: 'Edited', slackRichText: rich('Edited') }
  events.push({ ...submission, id: 'started', ts: 3, status: 'started' })
  expect(current().submission?.slackRichText).toEqual(rich('Edited'))
  events.push({ ...submission, id: 'failed', ts: 4, status: 'failed', message: 'Retry' })
  expect(current()).toMatchObject({ body: 'Edited', slackRichText: rich('Edited'), failure: 'Retry' })
  events.push({ ...submission, id: 'done', ts: 5, status: 'delivered' })
  expect(current().closed?.slackRichText).toEqual(rich('Edited'))
})

describe('Browser session snapshots', () => {
  const session = {
    id: 'browser_1', projectId: null, kind: 'browser', routineId: null, parentChatId: null,
    memberIds: [], sideModel: null, sideEffort: null, title: 'Session',
    lastMessagePreview: '', createdAt: 1, lastMessageAt: 1, settledAt: null,
    archivedAt: null, agentIds: [], checkout: { mode: 'current', branch: null },
  } as Chat
  const snapshot = { type: 'snapshot' as const, chatId: session.id, usage: {}, events: [] }

  it('loads beside the stage without becoming its open chat', () => {
    const loaded = reduce({ ...emptyWorkspace, chats: [session] }, snapshot)
    expect(loaded.openChatId).toBeNull()
    expect(loaded.threads[session.id]?.hasSnapshot).toBe(true)
  })

  it('still opens when asked for on purpose', () => {
    expect(reduce({ ...emptyWorkspace, chats: [session], pendingChatId: session.id }, snapshot).openChatId).toBe(session.id)
  })
})

describe('a snapshot that continues the held copy', () => {
  const said = (id: string, ts: number): ThreadEvent => ({ id, ts, type: 'user_message', text: id, mentions: [] })
  const whole = reduce(emptyWorkspace, { type: 'snapshot', chatId: 'dm', usage: {}, events: [said('evt_1', 1), said('evt_2', 2)] })
  const pending = { key: 'local', text: 'on its way', images: [], files: [], pageContexts: [] }
  const sending = { ...whole, threads: { dm: { ...whole.threads.dm!, pending: [pending] } } }

  it('keeps the same events when nothing followed', () => {
    const reopened = reduce(sending, { type: 'snapshot', chatId: 'dm', usage: {}, events: [], after: 'evt_2' })
    expect(reopened.threads.dm?.events).toBe(whole.threads.dm?.events)
  })

  it('appends what followed once, even when a broadcast already brought part of it', () => {
    const heard = reduce(sending, { type: 'event', chatId: 'dm', event: said('evt_3', 3) })
    const reopened = reduce(heard, { type: 'snapshot', chatId: 'dm', usage: {}, events: [said('evt_3', 3), said('evt_4', 4)], after: 'evt_2' })
    expect(reopened.threads.dm?.events.map((event) => event.id)).toEqual(['evt_1', 'evt_2', 'evt_3', 'evt_4'])
  })

  // On a new socket a broadcast can land before the reply that carries what was missed.
  it('keeps the order of the thread when a broadcast arrived ahead of the events this copy missed', () => {
    const heard = reduce(sending, { type: 'event', chatId: 'dm', event: said('evt_5', 5) })
    const reopened = reduce(heard, { type: 'snapshot', chatId: 'dm', usage: {}, events: [said('evt_3', 3), said('evt_4', 4), said('evt_5', 5)], after: 'evt_2' })
    expect(reopened.threads.dm?.events.map((event) => event.id)).toEqual(['evt_1', 'evt_2', 'evt_3', 'evt_4', 'evt_5'])
    // A reply read before that broadcast was written does not name it; it stays behind what the reply brought.
    const earlier = reduce(heard, { type: 'snapshot', chatId: 'dm', usage: {}, events: [said('evt_3', 3), said('evt_4', 4)], after: 'evt_2' })
    expect(earlier.threads.dm?.events.map((event) => event.id)).toEqual(['evt_1', 'evt_2', 'evt_3', 'evt_4', 'evt_5'])
  })

  it('takes an event that was rewritten while this copy was away, in its place', () => {
    const rewritten = { ...said('evt_1', 1), text: 'rewritten' }
    const reopened = reduce(sending, { type: 'snapshot', chatId: 'dm', usage: {}, events: [said('evt_3', 3)], after: 'evt_2', replaced: [rewritten] })
    expect(reopened.threads.dm?.events).toEqual([rewritten, said('evt_2', 2), said('evt_3', 3)])
    // A rewrite of an event this copy does not hold changes nothing.
    const other = reduce(sending, { type: 'snapshot', chatId: 'dm', usage: {}, events: [], after: 'evt_2', replaced: [said('evt_9', 9)] })
    expect(other.threads.dm?.events).toBe(whole.threads.dm?.events)
  })
})

describe('notes that stand with what they are about', () => {
  const reply = (id: string, turnId: string, agentId: string, ts: number): ThreadEvent =>
    ({ id, ts, type: 'agent_message', agentId, turnId, messageId: id, text: `${id}.` })
  const done = (id: string, turnId: string, agentId: string, ts: number, extra: Partial<Extract<ThreadEvent, { type: 'turn_result' }>> = {}): ThreadEvent =>
    ({ id, ts, type: 'turn_result', agentId, turnId, ...extra })

  it('puts trace notes into their finished turn without reopening it, and hints under the user’s message', () => {
    const rows = rowsOf({ ...emptyThread, events: [
      { id: 'ask', ts: 1, type: 'user_message', text: '@Huxley @Smith look', mentions: ['smith'] },
      { id: 'absent', ts: 2, type: 'system_note', kind: 'info', hintFor: 'ask', text: "Huxley isn't in this chat." },
      reply('answer', 'turn-1', 'smith', 3),
      done('done', 'turn-1', 'smith', 4),
      { id: 'cap', ts: 9, type: 'system_note', kind: 'info', agentId: 'smith', turnId: 'turn-1', trace: true, text: 'Argus was not asked: delegated turn limit (6) reached' },
      { id: 'orphan', ts: 10, type: 'system_note', kind: 'info', hintFor: 'gone', text: 'Saved, but Smith may not have seen it.' },
    ] }, 'project')
    expect(rows.map((row) => row.key)).toEqual(['ask', 'turn:turn-1:smith', 'orphan'])
    expect(rows[0]).toMatchObject({ hints: ["Huxley isn't in this chat."] })
    const turn = rows[1]!
    expect(turn.kind === 'turn' && turn.traceNotes).toEqual([{ key: 'cap', text: 'Argus was not asked: delegated turn limit (6) reached' }])
    // The late note does not stretch how long the turn worked.
    expect(turn.kind === 'turn' && turn.endedAt).toBe(4)
  })

  it('puts a forward under the user’s thread message and links the Session under the reply that sent it', () => {
    const forward = { sessionChatId: 'session-1', title: 'Checkmark fix', turnId: 'turn-1', agentId: '__single__' }
    const rows = rowsOf({ ...emptyThread, events: [
      { id: 'ask', ts: 1, type: 'user_message', text: 'The checkmark is still clipped', mentions: [] },
      { id: 'sent', ts: 2, type: 'system_note', kind: 'info', hintFor: 'ask', text: 'Sent to “Checkmark fix”.', sessionForward: forward },
      reply('answer', 'turn-1', '__single__', 3),
      done('done', 'turn-1', '__single__', 4),
    ] }, 'project')
    expect(rows.map((row) => row.key)).toEqual(['ask', 'turn:turn-1:__single__'])
    expect(rows[0]).toMatchObject({ forwards: [{ sessionChatId: 'session-1', title: 'Checkmark fix' }] })
    expect(rows[0]?.kind === 'event' && rows[0].hints).toBeUndefined()
    expect(rows[1]).toMatchObject({ sessionLinks: [{ sessionChatId: 'session-1', title: 'Checkmark fix' }] })
  })

  it('shows a DM turn’s memory writes on a reply bubble, the next one of that persona first', () => {
    const memory = [{ path: 'memory/agents/smith.md', kind: 'edited' }] as never
    const rows = rowsOf({ ...emptyThread, events: [
      { id: 'q', ts: 1, type: 'user_message', text: 'Plan it', mentions: [] },
      done('consult-done', 'turn-1', 'smith', 2, { memoryChanges: memory }),
      { id: 'relay', ts: 3, type: 'agent_relay', agentId: 'smith', peerAgentId: 'iris', pairChatId: 'pair', turnId: 'turn-1', relayId: 'r', phase: 'sent' },
      reply('answer', 'turn-2', 'smith', 4),
      done('answer-done', 'turn-2', 'smith', 5),
    ] }, 'dm')
    const marks = dmMemoryMarks(rows)
    expect([...marks]).toEqual([['turn:turn-2:smith', memory]])
    // Without a reply anywhere there is no bubble to carry them, and no row either.
    const lonely = rowsOf({ ...emptyThread, events: [done('only', 'turn-1', 'smith', 2, { memoryChanges: memory })] }, 'dm')
    expect([...dmMemoryMarks(lonely).keys()]).toEqual([])
  })
})

describe('a failed Session Commit', () => {
  const result = (action: 'commit' | 'push', ok: boolean) => ({
    type: 'session_git_result' as const, chatId: 'chat', root: '/repo', action, ok, text: `${action} ${ok}`,
    ...(ok ? {} : { files: ['a.ts'], message: 'Ship a' }),
  })

  const status = (uncommitted: string[], patch: { error?: string; waiting?: boolean } = {}) => ({
    type: 'session_repo' as const, chatId: 'chat', waiting: patch.waiting ?? false, changes: { files: 0, added: 0, removed: 0 },
    repos: [{ root: '/repo', label: 'repo', branch: 'main', ahead: 0, uncommitted: uncommitted.map((path) => ({ path, status: 'edited' as const, added: 1, removed: 0 })) }],
    ...(patch.error === undefined ? {} : { error: patch.error }),
  })
  const held = (state: typeof emptyWorkspace) => state.sessionCommitFailures.chat?.['/repo']

  it('outlives a later Push and a Commit of other files in that folder', () => {
    let state = reduce(emptyWorkspace, result('commit', false))
    state = reduce(state, result('push', true))
    expect(state.sessionGitResults.chat?.action).toBe('push')
    // Commit B lands while A is still uncommitted.
    state = reduce(state, result('commit', true))
    state = reduce(state, status(['a.ts']))
    expect(held(state)).toMatchObject({ files: ['a.ts'], message: 'Ship a' })
  })

  it('keeps the page a Push came back with per folder, whatever another folder does next', () => {
    const linked = { ...result('push', true), link: { label: 'Open pull request', url: 'https://git.example.test/someone/notes/pull/new/feature', branch: 'feature' } }
    let state = reduce(emptyWorkspace, linked)
    state = reduce(state, { ...result('push', true), root: '/other' })
    state = reduce(state, { ...result('commit', false), root: '/other' })
    expect(state.sessionPushedLinks.chat).toEqual({ '/repo': linked })
    // A later Push of that folder with a page of its own replaces it.
    const again = { ...linked, link: { ...linked.link, url: 'https://git.example.test/someone/notes/pull/7', label: 'View pull request' } }
    expect(reduce(state, again).sessionPushedLinks.chat?.['/repo']).toBe(again)
  })

  it('goes for good once a status read shows its files landed, so a later edit brings nothing back', () => {
    let state = reduce(emptyWorkspace, result('commit', false))
    // A failed read, or one while a result waits, proves nothing.
    state = reduce(state, status([], { error: 'Manor could not read this checkout.' }))
    state = reduce(state, status([], { waiting: true }))
    expect(held(state)).toBeDefined()
    state = reduce(state, status(['b.ts']))
    expect(held(state)).toBeUndefined()
    state = reduce(state, status(['a.ts']))
    expect(held(state)).toBeUndefined()
  })

  it('stays when the read leaves its folder out, is cut at the file limit, or lists it renamed', () => {
    const failed = reduce(emptyWorkspace, result('commit', false))
    // An unreadable checkout is left out of the read altogether.
    expect(held(reduce(failed, { ...status([]), repos: [] }))).toBeDefined()
    const full = Array.from({ length: MAX_SESSION_DIFF_FILES }, (_, index) => `f${index}.ts`)
    expect(held(reduce(failed, status(full)))).toBeDefined()
    const renamed = { ...status([]), repos: [{ ...status([]).repos[0]!, uncommitted: [{ path: 'b.ts', oldPath: 'a.ts', status: 'edited' as const, added: 1, removed: 0 }] }] }
    expect(held(reduce(failed, renamed))).toBeDefined()
    expect(failedFilesStill(['a.ts'], renamed.repos[0]!)).toEqual(['b.ts'])
  })
})

describe('accepting a Work proposal', () => {
  it('lists the new Session without changing the chat on the stage', () => {
    const chat = (id: string) => ({
      id, projectId: 'p1', kind: id === 'work_1' ? 'project' : 'dm', routineId: null, parentChatId: null, memberIds: [],
      sideModel: null, sideEffort: null, title: id, lastMessagePreview: '', createdAt: 1, lastMessageAt: 1,
      settledAt: null, archivedAt: null, agentIds: [], checkout: { mode: 'current', branch: null },
    }) as Chat
    const stage = { ...emptyWorkspace, chats: [chat('dm_1')], openChatId: 'dm_1', hasDirectory: true }
    const accepted = reduce(stage, { type: 'ack', requestId: 'work-accept-1', workChatId: 'work_1' })
    const listed = reduce(accepted, { type: 'directory', projects: [], chats: [chat('dm_1'), chat('work_1')], workHandoffs: [], runningTurns: {} })
    expect(listed.chats.map((row) => row.id)).toEqual(['dm_1', 'work_1'])
    expect(listed.openChatId).toBe('dm_1')
    expect(listed.pendingChatId).toBeNull()
  })
})

describe('leaving a chat on the phone', () => {
  const done = { type: 'turn_state' as const, chatId: 'dm_1', turnId: 'turn_1', agentId: 'sage', state: 'done' as const }

  it('gives up the selection, so a turn that ends afterwards shows unread', () => {
    const open = { ...emptyWorkspace, openChatId: 'dm_1' }
    expect(reduce(open, done).activity.dm_1?.unread).toBe(false)

    const left = leaveChat(open, 'dm_1')
    expect(left.openChatId).toBeNull()
    expect(left.pendingChatId).toBeNull()
    expect(reduce(left, done).activity.dm_1?.unread).toBe(true)
  })

  it('leaves the selection with a chat that was pushed over it', () => {
    const pushed = selectChat({ ...emptyWorkspace, openChatId: 'thread_1' }, 'session_1')
    expect(leaveChat(pushed, 'thread_1')).toBe(pushed)
  })
})

describe('the state the lists read', () => {
  it('holds still through a streamed text frame and moves with a slice a list reads', () => {
    const listedOf = createListedState()
    const open = reduce(emptyWorkspace, { type: 'snapshot', chatId: 'dm_1', events: [], usage: {} })
    const running = reduce(open, { type: 'turn_state', chatId: 'dm_1', turnId: 'turn_1', agentId: 'sage', state: 'running' })
    const listed = listedOf(running)

    const streamed = reduce(running, { type: 'delta', chatId: 'dm_1', turnId: 'turn_1', agentId: 'sage', messageId: 'm1', text: 'Hi' })
    expect(streamed).not.toBe(running)
    expect(listedOf(streamed)).toBe(listed)

    const ended = reduce(streamed, { type: 'turn_state', chatId: 'dm_1', turnId: 'turn_1', agentId: 'sage', state: 'done' })
    expect(listedOf(ended)).not.toBe(listed)
    expect(listedOf(ended).activity).toBe(ended.activity)
  })
})

describe('the tasks progress on a chat', () => {
  const chat: Chat = {
    id: 'session_1', projectId: 'p', kind: 'project', routineId: null, parentChatId: null,
    memberIds: [], sideModel: null, sideEffort: null, title: 'Build it',
    lastMessagePreview: null, createdAt: 1, lastMessageAt: 1, settledAt: null,
    archivedAt: null, agentIds: [], checkout: { mode: 'current', branch: null },
  }
  const todo = (ts: number, ...status: ('pending' | 'in_progress' | 'completed')[]) => ({
    type: 'event' as const, chatId: 'session_1',
    event: { id: `todo_${ts}`, ts, type: 'todo_update' as const, agentId: 'sage', turnId: 't1', todos: status.map((one, at) => ({ text: `Step ${at}`, status: one })) },
  })

  it('follows each tasks card as it arrives and ignores one older than the chat has seen', () => {
    let state = reduce({ ...emptyWorkspace, chats: [chat] }, todo(2, 'in_progress', 'pending'))
    expect(state.chats[0]?.planProgress).toEqual({ done: 0, total: 2 })
    state = reduce(state, todo(3, 'completed', 'in_progress'))
    expect(state.chats[0]?.planProgress).toEqual({ done: 1, total: 2 })
    const before = state.chats
    state = reduce(state, todo(3, 'completed', 'in_progress'))
    expect(state.chats).toBe(before)
    state = reduce(state, todo(1, 'pending', 'pending'))
    expect(state.chats[0]?.planProgress).toEqual({ done: 1, total: 2 })
    state = reduce(state, todo(4))
    expect(state.chats[0]?.planProgress).toBeUndefined()
  })
})
