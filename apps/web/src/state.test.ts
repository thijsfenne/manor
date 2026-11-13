import {
  DEFAULT_HOUSE_SETTINGS,
  CURRENT_CHECKOUT,
  DEFAULT_PROJECT_COLOR,
  type AgentConfig,
  type Chat,
  type FileEdit,
  type Project,
  type Routine,
  type ThreadEvent,
} from '@manor/contracts'
import { describe, expect, it } from 'vitest'
import {
  activityOf,
  askRepoFile,
  askRepoWrite,
  askThread,
  askThreadInBackground,
  canUnsettle,
  shouldSettleOpenRun,
  clearRepoWrite,
  clearChatSelection,
  selectChat,
  clearRunningTurns,
  echoChatOverride,
  emptyThread,
  emptyWorkspace,
  ARCHIVE_KEEP_MS,
  inbox,
  inboxSettleLanding,
  isArchiveExpired,
  reduce,
  finishedSilent,
  rowsOf,
  setViewedChats,
  settleChatOverride,
  withChatSettled,
  withChatArchived,
  wholeRoster,
  type TurnRow,
  type WorkspaceState,
} from './state'

/** How one DM turn reads; Work's deliberately different projection is tested below. */

let seq = 0
const id = (): string => `evt_${(seq += 1).toString().padStart(6, '0')}`

const message = (turnId: string, text: string, images?: { name: string; dataUrl: string }[]): ThreadEvent => ({
  id: id(),
  ts: seq,
  type: 'agent_message',
  agentId: 'smith',
  turnId,
  messageId: `msg_${seq}`,
  text,
  ...(images === undefined ? {} : { images }),
})

const toolUse = (turnId: string, toolCallId: string, edits?: FileEdit[]): ThreadEvent => ({
  id: id(),
  ts: seq,
  type: 'tool_use',
  agentId: 'smith',
  turnId,
  toolCallId,
  tool: edits === undefined ? 'Bash' : 'Edit',
  ...(edits === undefined ? {} : { edits }),
})

const turnResult = (turnId: string): ThreadEvent => ({
  id: id(),
  ts: seq,
  type: 'turn_result',
  agentId: 'smith',
  turnId,
})

const reasoning = (turnId: string, text: string): ThreadEvent => ({
  id: id(),
  ts: seq,
  type: 'reasoning',
  agentId: 'smith',
  turnId,
  text,
})

const turnsOf = (events: ThreadEvent[]): TurnRow[] =>
  rowsOf({ ...emptyThread, events }, 'dm').filter((row): row is TurnRow => row.kind === 'turn')

const workTurnsOf = (events: ThreadEvent[]): TurnRow[] =>
  rowsOf({ ...emptyThread, events }, 'project').filter((row): row is TurnRow => row.kind === 'turn')

const rosterAgent = (mentionAllowlist: string[]): AgentConfig =>
  ({
    id: 'smith',
    name: 'Smith',
    color: '#818791',
    character: 'Engineer',
    driver: 'claude',
    effort: 'high',
    allowedTools: [],
    mcpServers: [],
    skillIds: [],
    mentionAllowlist,
    memoryScope: false,
    description: 'Builds the house.',
    role: 'Engineer',
    isCos: false,
  }) as AgentConfig

describe('roster updates', () => {
  it('lands a change that only changes who a persona may summon', () => {
    const current = reduce(emptyWorkspace, { type: 'roster', agents: [rosterAgent([])] })
    const updated = reduce(current, { type: 'roster', agents: [rosterAgent(['argus'])] })

    expect(updated).not.toBe(current)
    expect(updated.agents[0]?.mentionAllowlist).toEqual(['argus'])
  })

  it('lands a move to Sessions, so the persona leaves the Agents list without a reload', () => {
    const current = reduce(emptyWorkspace, { type: 'roster', agents: [rosterAgent([])] })
    const moved = reduce(current, { type: 'roster', agents: [{ ...rosterAgent([]), placement: 'session' }] })

    expect(moved.agents[0]?.placement).toBe('session')
  })
})

describe('running snapshots', () => {
  it('keeps an intentionally empty stage empty across late snapshots until another chat is selected', () => {
    const empty = clearChatSelection({ ...emptyWorkspace, openChatId: 'left' })
    const snapshot = { type: 'snapshot' as const, chatId: 'right', events: [], usage: {} }
    const loaded = reduce(empty, snapshot)
    expect(loaded.openChatId).toBeNull()
    expect(loaded.pendingChatId).toBeNull()
    expect(loaded.threads.right?.hasSnapshot).toBe(true)
    const selected = reduce(selectChat(loaded, 'right'), snapshot)
    expect(selected.openChatId).toBe('right')
    expect(selected.selectionCleared).toBe(false)
  })
  it('loads a background thread without taking the empty stage or reading it', () => {
    // A persona's config reads her DM for its pin before anything is on the stage.
    const unread = { ...emptyWorkspace, activity: { dm: { ...activityOf(emptyWorkspace, 'dm'), unread: true } } }
    const snapshot = { type: 'snapshot' as const, chatId: 'dm', events: [], usage: {} }
    const loaded = reduce(askThreadInBackground(unread, 'dm'), snapshot)
    expect(loaded.openChatId).toBeNull()
    expect(loaded.threads.dm?.hasSnapshot).toBe(true)
    expect(activityOf(loaded, 'dm').unread).toBe(true)
    expect(loaded.backgroundThreads.has('dm')).toBe(false)
    expect(reduce(selectChat(loaded, 'dm'), snapshot).openChatId).toBe('dm')
  })
  it('restores unfinished text after reconnect', () => {
    const state = reduce(emptyWorkspace, {
      type: 'snapshot',
      chatId: 'chat_1',
      events: [],
      usage: {},
      activeTurn: {
        turnId: 'turn_1',
        agentId: 'smith',
        startedAt: 100,
        messages: [{ messageId: 'message_1', text: 'half an answer' }],
      },
    })

    expect(state.threads['chat_1']?.liveTurns[0]?.messages).toEqual([
      { messageId: 'message_1', text: 'half an answer' },
    ])
  })

  it('prefers a durable message when it completed while the snapshot was loading', () => {
    const durable: ThreadEvent = {
      id: 'evt_durable',
      ts: 101,
      type: 'agent_message',
      agentId: 'smith',
      turnId: 'turn_1',
      messageId: 'message_1',
      text: 'the whole answer',
    }
    const state = reduce(emptyWorkspace, {
      type: 'snapshot',
      chatId: 'chat_1',
      events: [durable],
      usage: {},
      activeTurn: {
        turnId: 'turn_1',
        agentId: 'smith',
        startedAt: 100,
        messages: [{ messageId: 'message_1', text: 'half an answer' }],
      },
    })

    expect(state.threads['chat_1']?.liveTurns[0]?.messages).toEqual([])
    expect(state.threads['chat_1']?.events).toEqual([durable])
  })

  it('keeps an append that reached the socket while the snapshot was loading', () => {
    const appended: ThreadEvent = {
      id: 'evt_after_query',
      ts: 102,
      type: 'agent_message',
      agentId: 'smith',
      turnId: 'turn_1',
      messageId: 'message_1',
      text: 'finished while loading',
    }
    const loaded = reduce(emptyWorkspace, {
      type: 'snapshot',
      chatId: 'chat_1',
      events: [],
      usage: {},
    })
    const withBroadcast = reduce(loaded, {
      type: 'event',
      chatId: 'chat_1',
      event: appended,
    })
    const afterSnapshot = reduce(withBroadcast, {
      type: 'snapshot',
      chatId: 'chat_1',
      events: [],
      usage: {},
    })

    expect(afterSnapshot.threads['chat_1']?.events).toEqual([appended])
  })

  it('does not revive a turn whose durable end arrived while the snapshot was loading', () => {
    const ended: ThreadEvent = {
      id: 'evt_result',
      ts: 102,
      type: 'turn_result',
      agentId: 'smith',
      turnId: 'turn_1',
    }
    const loaded = reduce(emptyWorkspace, {
      type: 'snapshot',
      chatId: 'chat_1',
      events: [],
      usage: {},
    })
    const withEnd = reduce(loaded, {
      type: 'event',
      chatId: 'chat_1',
      event: ended,
    })
    const afterSnapshot = reduce(withEnd, {
      type: 'snapshot',
      chatId: 'chat_1',
      events: [],
      usage: {},
      activeTurn: {
        turnId: 'turn_1',
        agentId: 'smith',
        startedAt: 100,
        messages: [{ messageId: 'message_1', text: 'half an answer' }],
      },
    })

    expect(afterSnapshot.threads['chat_1']?.liveTurns).toEqual([])
    expect(afterSnapshot.activity['chat_1']?.runningTurns).toEqual([])
  })

  it('treats a stop note as a durable end', () => {
    const aborted: ThreadEvent = {
      id: 'evt_aborted',
      ts: 102,
      type: 'system_note',
      kind: 'aborted',
      text: 'Stopped.',
      agentId: 'smith',
      turnId: 'turn_1',
    }
    const loaded = reduce(emptyWorkspace, {
      type: 'snapshot',
      chatId: 'chat_1',
      events: [],
      usage: {},
    })
    const withNote = reduce(loaded, {
      type: 'event',
      chatId: 'chat_1',
      event: aborted,
    })
    const afterSnapshot = reduce(withNote, {
      type: 'snapshot',
      chatId: 'chat_1',
      events: [],
      usage: {},
      activeTurn: {
        turnId: 'turn_1',
        agentId: 'smith',
        startedAt: 100,
        messages: [{ messageId: 'message_1', text: 'half an answer' }],
      },
    })

    expect(afterSnapshot.threads['chat_1']?.liveTurns).toEqual([])
  })
})

/** Everything the agent said, folded and standing, in the order it was written. */
const said = (turn: TurnRow | undefined): string[] => [
  ...(turn?.segments ?? []).flatMap((segment) => (segment.kind === 'reply' ? [segment.text] : [])),
  ...(turn?.answer ?? []).map((reply) => reply.text),
]

/** Only what is left in the transcript once the turn is over. */
const answered = (turn: TurnRow | undefined): string[] => (turn?.answer ?? []).map((reply) => reply.text)

const changed = (turn: TurnRow | undefined): string[][] =>
  (turn?.segments ?? []).flatMap((segment) =>
    segment.kind === 'edits' ? [segment.edits.map((edit) => edit.path)] : [],
  )

/** The shape of the turn on screen: runs of work, cut by what the agent said. */
const shape = (turn: TurnRow | undefined): string[] => (turn?.segments ?? []).map((segment) => segment.kind)

describe('rowsOf reply bubbling', () => {
  it('restores consecutive Work messages as one output', () => {
    const [turn] = workTurnsOf([message('t1', 'First half.'), message('t1', 'Second half.'), turnResult('t1')])

    expect(answered(turn)).toEqual(['First half.\n\nSecond half.'])
  })

  it('keeps Work narration in the fold and only its closing answer standing', () => {
    const [turn] = workTurnsOf([
      message('t1', 'Let me look.'),
      toolUse('t1', 'call_1'),
      message('t1', 'Found it.'),
      turnResult('t1'),
    ])

    expect(answered(turn)).toEqual(['Found it.'])
    expect(shape(turn)).toEqual(['reply', 'work'])
  })

  it('projects the same stored messages differently for Work and DM', () => {
    const events = [message('t1', 'One.'), message('t1', 'Two.'), turnResult('t1')]
    const thread = { ...emptyThread, events }
    const work = rowsOf(thread, 'project').find((row): row is TurnRow => row.kind === 'turn')
    const dm = rowsOf(thread, 'dm').find((row): row is TurnRow => row.kind === 'turn')

    expect(answered(work)).toEqual(['One.\n\nTwo.'])
    expect(answered(dm)).toEqual(['One.', 'Two.'])
  })

  it('keeps consecutive provider messages as separate beats', () => {
    const [turn] = turnsOf([message('t1', 'First half.'), message('t1', 'Second half.'), turnResult('t1')])

    expect(said(turn)).toEqual(['First half.', 'Second half.'])
  })

  it('makes mid-work narration a message like any other, in the order it was written', () => {
    const [turn] = turnsOf([
      message('t1', 'Let me look.'),
      toolUse('t1', 'call_1'),
      message('t1', 'Found it.'),
      turnResult('t1'),
    ])

    expect(said(turn)).toEqual(['Let me look.', 'Found it.'])
    expect(shape(turn)).toEqual(['work'])
    expect(answered(turn)).toEqual(['Let me look.', 'Found it.'])
  })

  it('keeps every beat around tool work', () => {
    const [turn] = turnsOf([
      message('t1', 'One.'),
      message('t1', 'Two.'),
      toolUse('t1', 'call_1'),
      message('t1', 'Three.'),
      message('t1', 'Four.'),
      turnResult('t1'),
    ])

    expect(said(turn)).toEqual(['One.', 'Two.', 'Three.', 'Four.'])
    expect(answered(turn)).toEqual(['One.', 'Two.', 'Three.', 'Four.'])
  })

  it('keeps the whole record, narration included, however it is presented', () => {
    const [turn] = turnsOf([
      message('t1', 'Checking the config.'),
      toolUse('t1', 'call_1'),
      message('t1', 'Now the tests.'),
      turnResult('t1'),
    ])

    expect(turn?.activities.map((step) => step.kind)).toEqual(['say', 'tool', 'say'])
  })

  it('says nothing for a turn that only worked', () => {
    const [turn] = turnsOf([toolUse('t1', 'call_1'), turnResult('t1')])

    expect(said(turn)).toEqual([])
    expect(turn?.activities).toHaveLength(1)
  })

  it('spans the turn from its first event to its last, for the worked-for label', () => {
    const events = [message('t1', 'Working.'), toolUse('t1', 'call_1'), message('t1', 'Done.'), turnResult('t1')]
    const [turn] = turnsOf(events)

    expect(turn?.startedAt).toBe(events[0]?.ts)
    expect(turn?.endedAt).toBe(events[events.length - 1]?.ts)
  })

  it('keys every beat on its own provider message', () => {
    const first = message('t1', 'One.')
    const second = message('t1', 'Two.')
    const [turn] = turnsOf([first, second])

    expect(turn?.answer.map((reply) => reply.key)).toEqual([first.id, second.id])
  })

  it('keeps an image-only provider message as its own beat', () => {
    const [turn] = turnsOf([
      message('t1', 'Here is the chart.'),
      message('t1', '', [{ name: 'chart.png', dataUrl: 'data:image/png;base64,AAAA' }]),
      turnResult('t1'),
    ])

    expect(turn?.segments).toHaveLength(0)
    expect(turn?.answer).toHaveLength(2)
    expect(turn?.answer[0]?.text).toBe('Here is the chart.')
    expect(turn?.answer[1]?.text).toBe('')
    expect(turn?.answer[1]?.images).toHaveLength(1)
  })

  it('never merges across turns, even when one persona speaks twice in a row', () => {
    const turns = turnsOf([message('t1', 'Done.'), turnResult('t1'), message('t2', 'And another thing.')])

    expect(turns).toHaveLength(2)
    expect(said(turns[0])).toEqual(['Done.'])
    expect(said(turns[1])).toEqual(['And another thing.'])
  })

  // The Mercer turn of 2026-08-09: full answer, daily-log edit, "Gelogd." sign-off.
  // The log write is housekeeping, not work, so it must not demote the answer into
  // the fold; both sentences stand and the edit row stays behind, still reviewable.
  it('lets a daily-log edit interrupt the answer without cutting it short', () => {
    const [turn] = turnsOf([
      toolUse('t1', 'call_1'),
      message('t1', 'The real answer.'),
      toolUse('t1', 'call_2', [{ path: '/Users/sam/notes/memory/daily/2026-08-09.md' }]),
      message('t1', 'Signing off.'),
      turnResult('t1'),
    ])

    expect(answered(turn)).toEqual(['The real answer.', 'Signing off.'])
    expect(shape(turn)).toEqual(['work', 'edits'])
    expect(changed(turn)).toEqual([['/Users/sam/notes/memory/daily/2026-08-09.md']])
  })

  // The shape the memory rule now asks for: answer first, then log silently. Without
  // the skip this turn would have no answer at all and read as a worked-only turn.
  it('keeps the answer standing when the turn ends on a daily-log edit', () => {
    const [turn] = turnsOf([
      message('t1', 'The real answer.'),
      toolUse('t1', 'call_1', [{ path: 'memory/daily/cloud/2026-08-09-manor.md' }]),
      turnResult('t1'),
    ])

    expect(answered(turn)).toEqual(['The real answer.'])
    expect(shape(turn)).toEqual(['edits'])
  })

  // Grok's stream writes thinking after the closing sentence. That row is
  // trace, not a job, and must not demote the reply into the fold.
  it('keeps the answer standing when the turn ends on a reasoning row', () => {
    const [turn] = turnsOf([
      toolUse('t1', 'call_1'),
      message('t1', 'The real answer.'),
      reasoning('t1', 'Let me look at ChatListView for existing search.'),
      turnResult('t1'),
    ])

    expect(answered(turn)).toEqual(['The real answer.'])
    expect(shape(turn)).toEqual(['work', 'work'])
    expect(finishedSilent(turn!)).toBe(false)
  })

  // reply → reasoning → daily-log must stay that order in the fold. Two buckets
  // that always replayed as edits-then-reasoning flipped this trace.
  it('keeps trailing housekeeping in the order it happened', () => {
    const [turn] = turnsOf([
      message('t1', 'The real answer.'),
      reasoning('t1', 'I should log this.'),
      toolUse('t1', 'call_1', [{ path: '/Users/sam/notes/memory/daily/2026-08-17.md' }]),
      turnResult('t1'),
    ])

    expect(answered(turn)).toEqual(['The real answer.'])
    expect(shape(turn)).toEqual(['work', 'edits'])
    expect(changed(turn)).toEqual([['/Users/sam/notes/memory/daily/2026-08-17.md']])
  })

  it('keeps an earlier beat standing around an ordinary edit', () => {
    const [turn] = turnsOf([
      message('t1', 'Narration.'),
      toolUse('t1', 'call_1', [{ path: 'apps/server/src/main.ts' }]),
      message('t1', 'Done.'),
      turnResult('t1'),
    ])

    expect(answered(turn)).toEqual(['Narration.', 'Done.'])
    expect(shape(turn)).toEqual(['edits'])
  })

  it('keeps completed beats visible while the turn is still running', () => {
    const rows = rowsOf({
      ...emptyThread,
      events: [message('t1', 'Let me look.'), toolUse('t1', 'call_1'), message('t1', 'Found it.')],
      liveTurns: [{ turnId: 't1', agentId: 'smith', messages: [], state: 'running', startedAt: 1 }],
    }, 'dm')
    const turn = rows.find((row): row is TurnRow => row.kind === 'turn')

    expect(answered(turn)).toEqual(['Let me look.', 'Found it.'])
    expect(shape(turn)).toEqual(['work'])
  })

  it('leaves a still-streaming message out of the segments, since no event carries it yet', () => {
    const rows = rowsOf({
      ...emptyThread,
      events: [message('t1', 'Finished text.')],
      liveTurns: [
        {
          turnId: 't1',
          agentId: 'smith',
          messages: [{ messageId: 'msg_live', text: 'still typing' }],
          state: 'running',
          startedAt: 1,
        },
      ],
    })
    const turn = rows.find((row): row is TurnRow => row.kind === 'turn')

    expect(said(turn)).toEqual(['Finished text.'])
    expect(turn?.live?.messages).toHaveLength(1)
  })
})

describe('rowsOf edit grouping', () => {
  const edit = (path: string): FileEdit => ({ path, before: 'a', after: 'b' })

  it('groups a run of edits with nothing said between them', () => {
    const [turn] = turnsOf([
      toolUse('t1', 'call_1', [edit('/a.ts')]),
      toolUse('t1', 'call_2', [edit('/b.ts')]),
      turnResult('t1'),
    ])

    expect(changed(turn)).toEqual([['/a.ts', '/b.ts']])
  })

  /**
   * A read between two writes is not a new act. It used to break the run apart, and
   * one sentence's worth of moving code came out as three groups of files with reads
   * wedged between them — three acts on screen where the agent had described one.
   * Strict chronology inside a block is what pays for that, deliberately.
   */
  it('does not let a read between two writes split one act in two', () => {
    const [turn] = turnsOf([
      toolUse('t1', 'call_1', [edit('/a.ts')]),
      toolUse('t1', 'call_2'),
      toolUse('t1', 'call_3', [edit('/b.ts')]),
      turnResult('t1'),
    ])

    expect(changed(turn)).toEqual([['/a.ts', '/b.ts']])
    expect(shape(turn)).toEqual(['edits', 'work'])
  })

  it('starts a new group once the agent has explained itself', () => {
    const [turn] = turnsOf([
      toolUse('t1', 'call_1', [edit('/a.ts')]),
      message('t1', 'Now the other half.'),
      toolUse('t1', 'call_2', [edit('/b.ts')]),
      turnResult('t1'),
    ])

    expect(changed(turn)).toEqual([['/a.ts'], ['/b.ts']])
    expect(shape(turn)).toEqual(['edits', 'edits'])
  })

  it('keeps every file of a multi-file call in one group', () => {
    const [turn] = turnsOf([toolUse('t1', 'call_1', [edit('/a.ts'), edit('/b.ts')]), turnResult('t1')])

    expect(changed(turn)).toEqual([['/a.ts', '/b.ts']])
  })
})

describe('inbox', () => {
  const project = (id: string, name: string): Project => ({
    id,
    name,
    icon: 'folder',
    color: DEFAULT_PROJECT_COLOR,
    repoPaths: [],
    memoryScope: 'project',
  })
  const chat = (
    id: string,
    projectId: string,
    lastMessageAt: number,
    settledAt: number | null = null,
    agentIds: string[] = [],
  ): Chat => ({
    id,
    projectId,
    kind: 'project',
    routineId: null,
    parentChatId: null,
    sideModel: null,
    sideEffort: null,
    memberIds: [],
    lastMessagePreview: null,
    title: id,
    createdAt: lastMessageAt,
    lastMessageAt,
    settledAt,
    archivedAt: null,
    agentIds,
    checkout: CURRENT_CHECKOUT,
  })

  const workspace = {
    ...emptyWorkspace,
    projects: [project('p1', 'Manor'), project('p2', 'Life admin')],
    chats: [
      chat('young', 'p1', 300, null, ['sage', 'smith']),
      chat('old', 'p2', 100),
      chat('middle', 'p1', 200, 250, ['marlow']),
      chat('oldest', 'p2', 50, 60),
    ],
  }

  it('waits for the whole turn before marking a closed chat unread', () => {
    const started = reduce(workspace, {
      type: 'turn_state',
      chatId: 'young',
      turnId: 'turn_1',
      agentId: 'smith',
      state: 'running',
      startedAt: 400,
    })
    const worked = reduce(started, {
      type: 'event',
      chatId: 'young',
      event: toolUse('turn_1', 'call_1'),
    })
    const streamed = reduce(worked, {
      type: 'delta',
      chatId: 'young',
      turnId: 'turn_1',
      agentId: 'smith',
      messageId: 'message_1',
      text: 'Almost done.',
    })

    expect(activityOf(started, 'young').unread).toBe(false)
    expect(activityOf(worked, 'young').unread).toBe(false)
    expect(activityOf(streamed, 'young').unread).toBe(false)

    const finished = reduce(streamed, {
      type: 'turn_state',
      chatId: 'young',
      turnId: 'turn_1',
      agentId: 'smith',
      state: 'done',
    })

    expect(activityOf(finished, 'young').unread).toBe(true)
  })

  it('does not mark a viewed split pane unread when its turn finishes', () => {
    const viewed = setViewedChats(workspace, ['young'])
    const started = reduce(viewed, {
      type: 'turn_state',
      chatId: 'young',
      turnId: 'turn_1',
      agentId: 'smith',
      state: 'running',
      startedAt: 400,
    })
    const finished = reduce(started, {
      type: 'turn_state',
      chatId: 'young',
      turnId: 'turn_1',
      agentId: 'smith',
      state: 'done',
    })

    expect(activityOf(finished, 'young').unread).toBe(false)
    expect(inbox(finished).unsettled.find((row) => row.chat.id === 'young')?.unread).toBe(false)
  })

  it('clears standing unread when a chat becomes a viewed pane', () => {
    const unread = {
      ...workspace,
      activity: {
        young: {
          unread: true,
          runningTurns: [],
          runStartedAt: null,
          sawStart: false,
          awaitingInput: [],
          answeredInput: [],
        },
      },
    }
    expect(activityOf(setViewedChats(unread, ['young']), 'young').unread).toBe(false)
  })

  it('splits settled from unsettled, newest first on both sides, across every project', () => {
    const { unsettled, settled } = inbox(workspace)

    expect(unsettled.map((entry) => entry.chat.id)).toEqual(['young', 'old'])
    expect(settled.map((entry) => entry.chat.id)).toEqual(['middle', 'oldest'])
    // A flat list has no accordion above it, so every row names its own room.
    expect(unsettled.map((entry) => entry.projectName)).toEqual(['Manor', 'Life admin'])
  })

  it('keeps every routine run out of both inbox sections', () => {
    const quiet: Chat = {
      ...chat('quiet-run', 'p1', 400, 400),
      kind: 'run',
      routineId: 'routine_1',
    }
    const notifying: Chat = {
      ...chat('notifying-run', 'p1', 500),
      kind: 'run',
      routineId: 'routine_1',
    }

    const listed = inbox({ ...workspace, chats: [...workspace.chats, quiet, notifying] })
    const ids = [...listed.unsettled, ...listed.settled].map((entry) => entry.chat.id)
    expect(ids).not.toContain('notifying-run')
    expect(ids).not.toContain('quiet-run')
  })

  // The unsettle banner is an inbox affordance. A run is not an inbox row, so
  // offering one would file it as work the inbox has already refused to list.
  it('offers the way back only to chats the inbox could have listed', () => {
    const routine = (id: string, notify: boolean): Routine =>
      ({ id, notify, name: id, projectId: 'p1', agentId: 'smith' }) as Routine
    const run = (id: string, routineId: string): Chat => ({
      ...chat(id, 'p1', 400, 400),
      kind: 'run',
      routineId,
    })
    const state = { ...workspace, routines: [routine('quiet', false), routine('loud', true)] }

    expect(canUnsettle(state, chat('middle', 'p1', 200, 250))).toBe(true)
    expect(canUnsettle(state, run('quiet-run', 'quiet'))).toBe(false)
    expect(canUnsettle(state, run('loud-run', 'loud'))).toBe(false)
  })

  it('settles a finished run that is on screen, and leaves a live one alone', () => {
    const run = {
      ...chat('run-1', 'p1', 400),
      kind: 'run' as const,
      routineId: 'routine_1',
    }

    expect(shouldSettleOpenRun(run, false)).toBe(true)
    expect(shouldSettleOpenRun(run, true)).toBe(false)
    expect(shouldSettleOpenRun({ ...run, settledAt: 400 }, false)).toBe(false)
    expect(shouldSettleOpenRun(chat('young', 'p1', 300), false)).toBe(false)
  })

  it('forgets the old start time when a reconnect clears a running turn', () => {
    const state = {
      ...workspace,
      activity: {
        young: {
          unread: false,
          runningTurns: ['turn_1'],
          runStartedAt: 123,
          sawStart: true,
          awaitingInput: [],
          answeredInput: [],
        },
      },
    }

    expect(clearRunningTurns(state).activity.young).toMatchObject({
      runningTurns: [],
      runStartedAt: null,
      sawStart: false,
    })
  })

  /**
   * A question is a different claim than a run. The chat is technically working, but
   * what it is doing is standing still until the user answers, and the row has to be
   * able to say so from the socket alone, for a chat nobody has open.
   */
  describe('a question waiting on an answer', () => {
    const turnState = (state: 'running' | 'done') =>
      ({ type: 'turn_state', chatId: 'young', turnId: 'turn_1', agentId: 'smith', state, startedAt: 400 }) as const

    const ask: ThreadEvent = {
      id: 'evt_ask',
      ts: 410,
      type: 'user_input_request',
      agentId: 'smith',
      turnId: 'turn_1',
      requestId: 'req_1',
      questions: [{ id: 'dir', question: 'Which way?', options: [{ label: 'Left' }, { label: 'Right' }] }],
    }
    const answer: ThreadEvent = {
      id: 'evt_answer',
      ts: 420,
      type: 'user_input_response',
      agentId: 'smith',
      turnId: 'turn_1',
      requestId: 'req_1',
      answers: { dir: 'Left' },
    }
    const asked = reduce(reduce(workspace, turnState('running')), {
      type: 'event',
      chatId: 'young',
      event: ask,
    })

    it('marks the chat the moment the question lands', () => {
      expect(activityOf(asked, 'young').awaitingInput).toEqual(['req_1'])
      expect(inbox(asked).unsettled.find((row) => row.chat.id === 'young')?.waiting).toBe(true)
    })

    it('lets it go on the answer', () => {
      const answered = reduce(asked, { type: 'event', chatId: 'young', event: answer })

      expect(activityOf(answered, 'young').awaitingInput).toEqual([])
      expect(activityOf(answered, 'young').runningTurns).toEqual(['turn_1'])
    })

    // Nothing can read the answer once the turn that asked is gone, so the row may
    // not keep asking for one.
    it('lets it go when the turn ends without one', () => {
      const ended = reduce(asked, turnState('done'))

      expect(activityOf(ended, 'young').awaitingInput).toEqual([])
    })

    it('rebuilds it from the durable record after a reload', () => {
      const reloaded = reduce(workspace, {
        type: 'snapshot',
        chatId: 'young',
        events: [ask],
        usage: {},
        activeTurn: { turnId: 'turn_1', agentId: 'smith', startedAt: 400 },
      })

      expect(activityOf(reloaded, 'young').awaitingInput).toEqual(['req_1'])
    })

    it('seeds waiting from the directory so a closed chat still says so after reload', () => {
      const reloaded = reduce(workspace, {
        type: 'directory',
        projects: workspace.projects,
        chats: workspace.chats,
        workHandoffs: [],
        awaitingInput: { young: ['req_1'] },
      })

      expect(activityOf(reloaded, 'young').awaitingInput).toEqual(['req_1'])
      expect(inbox(reloaded).unsettled.find((row) => row.chat.id === 'young')?.waiting).toBe(true)
    })

    it('lets the directory clear a wait the server no longer holds, such as one a steer superseded', () => {
      const listed = reduce(asked, {
        type: 'directory',
        projects: workspace.projects,
        chats: workspace.chats,
        workHandoffs: [],
        awaitingInput: {},
      })

      expect(activityOf(listed, 'young').awaitingInput).toEqual([])
    })

    it('does not let a stale directory listing revive an answered wait', () => {
      const answeredWait = reduce(asked, { type: 'event', chatId: 'young', event: answer })
      const listed = reduce(answeredWait, {
        type: 'directory',
        projects: workspace.projects,
        chats: workspace.chats,
        workHandoffs: [],
        awaitingInput: { young: ['req_1'] },
      })

      expect(activityOf(listed, 'young').awaitingInput).toEqual([])
    })

    it('does not rebuild one that was already answered', () => {
      const reloaded = reduce(workspace, {
        type: 'snapshot',
        chatId: 'young',
        events: [ask, answer],
        usage: {},
        activeTurn: { turnId: 'turn_1', agentId: 'smith', startedAt: 400 },
      })

      expect(activityOf(reloaded, 'young').awaitingInput).toEqual([])
    })
  })

  // The avatar stack reads this straight off the row, in the order the server put
  // them in: most recent speaker first, and no re-sorting on the client.
  it('carries the personas that have worked in each chat, in the order they arrived', () => {
    const { unsettled, settled } = inbox(workspace)

    expect(unsettled.map((entry) => entry.chat.agentIds)).toEqual([['sage', 'smith'], []])
    expect(settled[0]?.chat.agentIds).toEqual(['marlow'])
  })

  it('derives Working and Done from the same activity the project view reads', () => {
    const state = {
      ...workspace,
      openChatId: 'old',
      activity: {
        young: {
          unread: true,
          runningTurns: ['turn_1'],
          runStartedAt: 300,
          sawStart: true,
          awaitingInput: [],
          answeredInput: [],
        },
        old: { unread: true, runningTurns: [], runStartedAt: null, sawStart: false, awaitingInput: [], answeredInput: [] },
      },
    }
    const byId = new Map(inbox(state).unsettled.map((entry) => [entry.chat.id, entry]))

    // Working outranks Done: the view reads `unread && !running`, so a chat doing
    // both says the louder of the two and nothing says both.
    expect(byId.get('young')?.running).toBe(true)
    expect(byId.get('young')?.unread).toBe(true)
    expect(byId.get('old')).toMatchObject({ running: false, unread: true, selected: true })
  })

  // Sorting live on `lastMessageAt` made two working chats trade places all run
  // long, since every streamed message bumps it. A working chat holds the place its
  // run started at and takes its real one on the run's end, one move on a real event.
  it('keeps working chats in place while they stream, and moves them when the run ends', () => {
    const turnState = (chatId: string, state: 'running' | 'done', startedAt?: number) =>
      ({ type: 'turn_state', chatId, turnId: `turn_${chatId}`, agentId: 'smith', state, startedAt }) as const

    const oldRuns = reduce(workspace, turnState('old', 'running', 400))
    const bothRun = reduce(oldRuns, turnState('young', 'running', 500))
    expect(inbox(bothRun).unsettled.map((entry) => entry.chat.id)).toEqual(['young', 'old'])

    const streamed = reduce(bothRun, {
      type: 'event',
      chatId: 'old',
      event: {
        id: 'evt_stream',
        ts: 600,
        type: 'agent_message',
        agentId: 'smith',
        turnId: 'turn_old',
        messageId: 'msg_stream',
        text: 'Still at it.',
      },
    })
    // The row's own data moved on, the position did not.
    expect(streamed.chats.find((entry) => entry.id === 'old')?.lastMessageAt).toBe(600)
    expect(inbox(streamed).unsettled.map((entry) => entry.chat.id)).toEqual(['young', 'old'])

    const oldDone = reduce(streamed, turnState('old', 'done'))
    expect(inbox(oldDone).unsettled.map((entry) => entry.chat.id)).toEqual(['old', 'young'])
  })

  it('moves a chat between the two lists the moment it is settled, and back', () => {
    const settled = withChatSettled(workspace, 'young', true, 400)

    expect(inbox(settled).unsettled.map((entry) => entry.chat.id)).toEqual(['old'])
    expect(inbox(settled).settled.map((entry) => entry.chat.id)).toEqual(['young', 'middle', 'oldest'])
    expect(inbox(withChatSettled(settled, 'young', false)).unsettled.map((entry) => entry.chat.id)).toEqual([
      'young',
      'old',
    ])
  })

  it('moves archived chats out of the active lists into one flat archive, newest first', () => {
    const first = withChatArchived(workspace, 'old', true, 400)
    const archived = withChatArchived(first, 'middle', true, 500)
    const listed = inbox(archived)

    expect(listed.unsettled.map((entry) => entry.chat.id)).toEqual(['young'])
    expect(listed.settled.map((entry) => entry.chat.id)).toEqual(['oldest'])
    expect(listed.archived.map((entry) => entry.chat.id)).toEqual(['middle', 'old'])

    const restored = withChatArchived(archived, 'old', false)
    expect(inbox(restored).unsettled.map((entry) => entry.chat.id)).toEqual(['young', 'old'])
  })

  it('treats an archive older than ten days as expired', () => {
    const now = 20 * 24 * 60 * 60 * 1000
    expect(isArchiveExpired(now - ARCHIVE_KEEP_MS + 1, now)).toBe(false)
    expect(isArchiveExpired(now - ARCHIVE_KEEP_MS, now)).toBe(true)
  })

  it('takes the archive window from the saved house settings once they arrive', () => {
    expect(inbox(workspace).archiveKeepMs).toBe(ARCHIVE_KEEP_MS)
    const saved = reduce(workspace, { type: 'house_settings', settings: { ...DEFAULT_HOUSE_SETTINGS, archiveRetentionDays: 3 } })
    expect(saved.houseSettings?.archiveRetentionDays).toBe(3)
    const keepMs = inbox(saved).archiveKeepMs
    expect(keepMs).toBe(3 * 24 * 60 * 60 * 1000)
    const now = 20 * 24 * 60 * 60 * 1000
    expect(isArchiveExpired(now - 4 * 24 * 60 * 60 * 1000, now, keepMs)).toBe(true)
  })

  it('advances to the next open row after settling the active chat', () => {
    const open = inbox(workspace).unsettled

    expect(inboxSettleLanding(open, open[0]!.chat)).toEqual({ kind: 'chat', chatId: 'old' })
    expect(inboxSettleLanding(open, open[1]!.chat)).toEqual({ kind: 'chat', chatId: 'young' })
  })

  it('opens a new-chat draft after settling the final thread', () => {
    const [only] = inbox(workspace).unsettled

    expect(inboxSettleLanding([only!], only!.chat)).toEqual({ kind: 'new-chat' })
    expect(inboxSettleLanding([only!], chat('missing', 'p1', 400))).toBeUndefined()
  })

  it('changes nothing for a chat already in the asked-for state, or one it does not hold', () => {
    expect(withChatSettled(workspace, 'young', false)).toBe(workspace)
    expect(withChatSettled(workspace, 'middle', true)).toBe(workspace)
    expect(withChatSettled(workspace, 'ghost', true)).toBe(workspace)
  })

  // Nothing broadcasts a directory when a turn ends, so a stack that waits for one
  // is empty in exactly the chats being worked in — the only ones anyone is looking at.
  describe('the faces on a row, kept live by the stream', () => {
    const spoke = (chatId: string, agentId: string, ts: number) =>
      ({
        type: 'event',
        chatId,
        event: { type: 'agent_message', id: `m_${ts}`, turnId: 't1', agentId, text: 'hi', ts },
      }) as const

    it('adds a persona the first time it speaks', () => {
      const after = reduce(workspace, spoke('old', 'marlow', 400))

      expect(after.chats.find((chat) => chat.id === 'old')?.agentIds).toEqual(['marlow'])
    })

    it('moves the newest speaker to the front, the order the server promises', () => {
      const after = reduce(workspace, spoke('young', 'smith', 400))

      expect(after.chats.find((chat) => chat.id === 'young')?.agentIds).toEqual(['smith', 'sage'])
    })

    it('leaves the array alone when the speaker is already at the front', () => {
      const after = reduce(workspace, spoke('young', 'sage', 400))
      const before = workspace.chats.find((chat) => chat.id === 'young')

      expect(after.chats.find((chat) => chat.id === 'young')?.agentIds).toBe(before?.agentIds)
    })

    // A user message has no `agentId`, and the server's own scan skips those rows too.
    it('does not invent a face for an event nobody signed', () => {
      const after = reduce(workspace, {
        type: 'event',
        chatId: 'old',
        event: { type: 'user_message', id: 'm_1', text: 'hi', mentions: [], ts: 400 },
      })

      expect(after.chats.find((chat) => chat.id === 'old')?.agentIds).toEqual([])
      expect(after.chats.find((chat) => chat.id === 'old')?.lastMessageAt).toBe(400)
    })
  })

  // A lazily created DM is announced before its opening message exists, so the
  // directory it arrives in carries no preview at all. Without this the row shows a
  // fresh time above an empty line for as long as the tab stays open.
  describe('the line under the title, kept live by the stream', () => {
    const previewOf = (state: WorkspaceState, chatId: string) =>
      state.chats.find((chat) => chat.id === chatId)?.lastMessagePreview

    it('takes the newest spoken message, whitespace collapsed', () => {
      const after = reduce(workspace, {
        type: 'event',
        chatId: 'old',
        event: { type: 'agent_message', id: 'm_1', turnId: 't1', agentId: 'marlow', text: 'Fixed,\n\n Jevon not Jwan.', ts: 400 },
      })

      expect(previewOf(after, 'old')).toBe('Fixed, Jevon not Jwan.')
    })

    // The same rule `chat_previews` applies: a tool step or a note is not what the
    // chat is about, and neither is an image sent without a word.
    it('leaves the standing line alone for anything that is not a spoken message', () => {
      const spoken = reduce(workspace, {
        type: 'event',
        chatId: 'old',
        event: { type: 'user_message', id: 'm_1', text: 'ship it', mentions: [], ts: 400 },
      })
      const noted = reduce(spoken, {
        type: 'event',
        chatId: 'old',
        event: { type: 'system_note', id: 'm_2', kind: 'aborted', text: 'The turn was stopped.', ts: 500 },
      })
      const wordless = reduce(noted, {
        type: 'event',
        chatId: 'old',
        event: { type: 'user_message', id: 'm_3', text: '  ', mentions: [], ts: 600 },
      })

      expect(previewOf(noted, 'old')).toBe('ship it')
      expect(previewOf(wordless, 'old')).toBe('ship it')
    })

    // Manor's own wording for the model is nobody's line: a Single kickoff shows its task,
    // and a request that is all instruction (a commit request, a thread wake) leaves the line be.
    it('never shows what Manor wrote for the model, in a new row or one stored before the split', () => {
      const opening = '[Manor] Session accepted as Single with claude-opus-5-5. Complete the task below in this session.\n\n'
      const kickoff = { type: 'user_message' as const, mentions: [], source: 'work_handoff' as const, ts: 400 }
      const spoken = reduce(workspace, { type: 'event', chatId: 'old', event: { ...kickoff, id: 'm_1', text: 'Fix the border.', instruction: opening } })
      const older = reduce(workspace, { type: 'event', chatId: 'old', event: { ...kickoff, id: 'm_2', text: `${opening}Fix the border.` } })
      const request = reduce(spoken, { type: 'event', chatId: 'old', event: { type: 'user_message', id: 'm_3', text: '', instruction: '[Manor] Sam confirmed the ready result, and that is his approval to commit.', mentions: [], ts: 500 } })
      const wake = reduce(spoken, { type: 'event', chatId: 'old', event: { type: 'user_message', id: 'm_4', text: '[Manor] Queued for this thread.', source: 'project_thread', threadReason: 'report', mentions: [], ts: 600 } })

      expect(previewOf(spoken, 'old')).toBe('Fix the border.')
      expect(previewOf(older, 'old')).toBe('Fix the border.')
      expect(previewOf(request, 'old')).toBe('Fix the border.')
      expect(previewOf(wake, 'old')).toBe('Fix the border.')
    })

    // Nothing that reads this line renders Markdown, so the markers arrive as
    // literal asterisks in a sidebar row and in a system banner.
    it('flattens the Markdown of a message that just landed', () => {
      const after = reduce(workspace, {
        type: 'event',
        chatId: 'old',
        event: {
          type: 'agent_message',
          id: 'm_1',
          turnId: 't1',
          agentId: 'marlow',
          text: '**Middel:** zie [askFlow.ts:71](/Users/sam/app/askFlow.ts)',
          ts: 400,
        },
      })

      expect(previewOf(after, 'old')).toBe('Middel: zie askFlow.ts:71')
    })

    // The store keeps the line as it was written, so a listing brings the markers
    // back in on every reconnect unless they come off here too.
    it('flattens the Markdown of a preview the directory carries', () => {
      const after = reduce(workspace, {
        type: 'directory',
        projects: workspace.projects,
        chats: workspace.chats.map((chat) =>
          chat.id === 'old' ? { ...chat, lastMessagePreview: '1. **Middel:** `askFlow.ts`' } : chat,
        ),
        workHandoffs: [],
      })

      expect(previewOf(after, 'old')).toBe('Middel: askFlow.ts')
    })

    // A replayed event must not put an older line back under a newer time.
    it('ignores a message older than what the row already records', () => {
      const after = reduce(workspace, {
        type: 'event',
        chatId: 'young',
        event: { type: 'user_message', id: 'm_1', text: 'stale', mentions: [], ts: 100 },
      })

      expect(previewOf(after, 'young')).toBe(null)
      expect(after.chats.find((chat) => chat.id === 'young')?.lastMessageAt).toBe(300)
    })
  })

  // The server's directory is authoritative: it is what a refused write rolls back to.
  it('lets the next directory overrule the optimistic move', () => {
    const optimistic = withChatSettled(workspace, 'young', true, 400)
    const corrected = reduce(optimistic, {
      type: 'directory',
      projects: workspace.projects,
      chats: workspace.chats,
      workHandoffs: [],
    })

    expect(inbox(corrected).unsettled.map((entry) => entry.chat.id)).toEqual(['young', 'old'])
  })
})

describe('the side chat panel', () => {
  const chat = (id: string): Chat => ({
    id,
    projectId: 'p1',
    kind: 'project',
    routineId: null,
    parentChatId: null,
    sideModel: null,
    sideEffort: null,
    memberIds: [],
    lastMessagePreview: null,
    title: id,
    createdAt: 1,
    lastMessageAt: 1,
    settledAt: null,
    archivedAt: null,
    agentIds: [],
    checkout: CURRENT_CHECKOUT,
  })

  /** A workspace with a panel open on `parent`, and a thread loaded in it. */
  const opened = () => {
    const withPanel = reduce(
      { ...emptyWorkspace, chats: [chat('parent')] },
      { type: 'side_chat', parentChatId: 'parent', chatId: 'side', model: 'grok-4.5', effort: 'medium' },
    )
    return reduce(withPanel, {
      type: 'snapshot',
      chatId: 'side',
      events: [],
      usage: {},
    })
  }

  it('keeps the panel and its thread when the directory changes', () => {
    // Side chats are deliberately absent from the directory, so anything keyed by chat
    // id has to be told they are still alive: the next new chat would otherwise throw
    // away the open panel's transcript while the mapping still pointed at it.
    const state = opened()
    expect(state.threads['side']).toBeDefined()

    const next = reduce(state, {
      type: 'directory',
      projects: [],
      chats: [chat('parent'), chat('another')],
      workHandoffs: [],
    })

    expect(next.sideChats['parent']).toBe('side')
    expect(next.threads['side']).toBeDefined()
  })

  it('lets the panel go when the chat it hangs off does', () => {
    const next = reduce(opened(), { type: 'directory', projects: [], chats: [], workHandoffs: [] })

    expect(next.sideChats).toEqual({})
    expect(next.threads['side']).toBeUndefined()
  })

  it('never puts the panel’s own thread on the stage', () => {
    const state = opened()
    expect(state.openChatId).toBe(null)

    const reading = reduce(
      { ...state, openChatId: 'parent' },
      { type: 'snapshot', chatId: 'side', events: [], usage: {} },
    )
    expect(reading.openChatId).toBe('parent')
    expect(reading.threads['side']).toBeDefined()
  })

  it('says a thread on screen is being re-read, and keeps showing it meanwhile', () => {
    // A reconnect re-reads a thread nobody dropped. What is on screen stays there, but
    // the snapshot on its way clears `pending`, so anything sent in between would lose
    // its bubble until the turn writes the message down.
    const asked = askThread(opened(), 'side')
    expect(asked.threads['side']?.refreshing).toBe(true)
    expect(asked.threads['side']?.hasSnapshot).toBe(true)

    const landed = reduce(asked, { type: 'snapshot', chatId: 'side', events: [], usage: {} })
    expect(landed.threads['side']?.refreshing).toBe(false)
  })

  it('marks nothing for a thread nobody holds yet', () => {
    // A first ask has no bubble to lose and already reads as loading; a phantom entry
    // here would put an empty transcript in the map for a chat that may never answer.
    const first = { ...emptyWorkspace, chats: [chat('parent')] }
    expect(askThread(first, 'side')).toBe(first)
  })

  it('still refuses the stage to a snapshot that outlives the chat it hung off', () => {
    // The race this exists for: the panel asks for its thread, the chat it hangs off is
    // deleted a moment later, and the directory prunes the mapping before the snapshot
    // lands. Recognised by the mapping alone, the panel's thread would then take the
    // empty stage, which points the workspace at a thread no list holds and leaves the
    // sidebar with nothing selected and nothing to select it.
    const gone = reduce({ ...opened(), openChatId: 'parent' }, {
      type: 'directory',
      projects: [],
      chats: [],
      workHandoffs: [],
    })
    expect(gone.sideChats).toEqual({})
    expect(gone.openChatId).toBe(null)

    const late = reduce(gone, { type: 'snapshot', chatId: 'side', events: [], usage: {} })

    expect(late.openChatId).toBe(null)
  })
})

describe('the roster and the side chat speaker', () => {
  it('keeps every row it is sent, because none of them is hidden any more', () => {
    // The side chat stopped being a persona on 2026-08-17: it is a model with an
    // effort, so there is no row to split off and no mention menu to keep it out of.
    const state = reduce(emptyWorkspace, { type: 'roster', agents: [rosterAgent([])] })

    expect(state.agents.map((agent) => agent.id)).toEqual(['smith'])
    // The panel's voice is named from the contract instead, for the two surfaces that
    // label a speaker rather than offering one.
    expect(wholeRoster(state).map((agent) => agent.id)).toEqual(['smith', 'aside'])
  })

  it('returns the same state for a roster that has not moved', () => {
    // Every persona write broadcasts this message, and a fresh array each time
    // re-renders every list in the app for a roster nobody changed.
    const state = reduce(emptyWorkspace, { type: 'roster', agents: [rosterAgent([])] })

    expect(reduce(state, { type: 'roster', agents: [rosterAgent([])] })).toBe(state)
  })

  it('remembers what each panel runs on, from the open and from a later pick', () => {
    const opened = reduce(emptyWorkspace, {
      type: 'side_chat',
      parentChatId: 'parent',
      chatId: 'side',
      model: 'grok-4.5',
      effort: 'medium',
    })
    expect(opened.sideRuntimes['side']).toEqual({ model: 'grok-4.5', effort: 'medium' })

    const picked = reduce(opened, { type: 'side_runtime', chatId: 'side', model: 'grok-4.6', effort: 'low' })

    expect(picked.sideRuntimes['side']).toEqual({ model: 'grok-4.6', effort: 'low' })
    // Reply-only and about a thread nothing else shows: it must not be read as
    // transcript traffic for a chat on the stage.
    expect(picked.openChatId).toBe(null)
  })
})

describe('repo files follow the chat', () => {
  it('keys a listing by chat when the reply carries one, else by project', () => {
    const projectOnly = reduce(emptyWorkspace, {
      type: 'repo_files',
      projectId: 'project_1',
      files: ['Manor/src/a.ts'],
      truncated: false,
    })
    const isolated = reduce(projectOnly, {
      type: 'repo_files',
      projectId: 'project_1',
      chatId: 'chat_a',
      files: ['Manor/src/b.ts'],
      truncated: false,
    })

    expect(isolated.repoFiles.project_1?.files).toEqual(['Manor/src/a.ts'])
    expect(isolated.repoFiles['project_1::chat_a']?.files).toEqual(['Manor/src/b.ts'])
  })
})

describe('repo file previews', () => {
  it('ignores a late response after a newer file was selected', () => {
    const first = askRepoFile(emptyWorkspace, 'project_1', 'repo/first.ts')
    const second = askRepoFile(first, 'project_1', 'repo/second.ts')
    const stale = reduce(second, {
      type: 'repo_file',
      projectId: 'project_1',
      path: 'repo/first.ts',
      result: { status: 'ready', content: 'old' },
    })

    expect(stale).toBe(second)
    expect(stale.repoFilePreviews.project_1).toEqual({ path: 'repo/second.ts', result: null })
  })

  it('stores the response for the current selection', () => {
    const asking = askRepoFile(emptyWorkspace, 'project_1', 'repo/current.ts')
    const answered = reduce(asking, {
      type: 'repo_file',
      projectId: 'project_1',
      path: 'repo/current.ts',
      result: { status: 'ready', content: 'current' },
    })

    expect(answered.repoFilePreviews.project_1).toEqual({
      path: 'repo/current.ts',
      result: { status: 'ready', content: 'current' },
    })
  })
})

describe('repo file saves', () => {
  const saved = { status: 'saved', revision: 'rev-2' } as const

  it('ignores an answer for a file the panel has already left', () => {
    const asking = askRepoWrite(emptyWorkspace, 'project_1', 'repo/first.ts')
    const moved = askRepoWrite(asking, 'project_1', 'repo/second.ts')
    const late = reduce(moved, { type: 'repo_write', projectId: 'project_1', path: 'repo/first.ts', result: saved })

    expect(late).toBe(moved)
    expect(late.repoFileWrites.project_1).toEqual({ path: 'repo/second.ts', result: null })
  })

  it('stores the answer for the save that is out', () => {
    const asking = askRepoWrite(emptyWorkspace, 'project_1', 'repo/current.ts')
    const answered = reduce(asking, {
      type: 'repo_write',
      projectId: 'project_1',
      path: 'repo/current.ts',
      result: saved,
    })

    expect(answered.repoFileWrites.project_1).toEqual({ path: 'repo/current.ts', result: saved })
  })

  // A conflict belongs to the file it was reported for. Carrying it to the next file
  // would put a "changed on disk" strip over a file nobody has saved.
  it('drops the last answer when another file is opened', () => {
    const asking = askRepoWrite(emptyWorkspace, 'project_1', 'repo/current.ts')
    const answered = reduce(asking, {
      type: 'repo_write',
      projectId: 'project_1',
      path: 'repo/current.ts',
      result: { status: 'stale', revision: 'rev-3', content: 'theirs' },
    })

    expect(askRepoFile(answered, 'project_1', 'repo/next.ts').repoFileWrites.project_1).toBeUndefined()
    expect(clearRepoWrite(answered, 'project_1').repoFileWrites.project_1).toBeUndefined()
  })
})

describe('rowsOf todos and ask-user', () => {
  const question = {
    id: 'dir',
    question: 'Which way?',
    options: [{ label: 'Left' }, { label: 'Right' }],
  }

  it('keeps only the latest todo snapshot', () => {
    const [turn] = turnsOf([
      {
        id: id(),
        ts: seq,
        type: 'todo_update',
        agentId: 'smith',
        turnId: 't1',
        todos: [{ text: 'Old', status: 'pending' }],
      },
      {
        id: id(),
        ts: seq,
        type: 'todo_update',
        agentId: 'smith',
        turnId: 't1',
        todos: [
          { text: 'New', status: 'completed' },
          { text: 'Also', status: 'pending' },
        ],
      },
    ])

    expect(turn?.todos).toEqual([
      { text: 'New', status: 'completed' },
      { text: 'Also', status: 'skipped' },
    ])
  })

  it('pairs a request with its answer on the same card', () => {
    const [turn] = turnsOf([
      {
        id: id(),
        ts: seq,
        type: 'user_input_request',
        agentId: 'smith',
        turnId: 't1',
        requestId: 'req_1',
        questions: [question],
      },
      {
        id: id(),
        ts: seq,
        type: 'user_input_response',
        agentId: 'smith',
        turnId: 't1',
        requestId: 'req_1',
        answers: { dir: 'Left' },
      },
    ])

    expect(turn?.asks).toHaveLength(1)
    expect(turn?.asks[0]?.answers).toEqual({ dir: 'Left' })
    expect(finishedSilent(turn!)).toBe(false)
  })

  it('keeps narration, questions and the latest plan in provider order', () => {
    const [turn] = turnsOf([
      message('t1', 'I need your answer.'),
      {
        id: id(),
        ts: seq,
        type: 'user_input_request',
        agentId: 'smith',
        turnId: 't1',
        requestId: 'req_1',
        questions: [question],
      },
      {
        id: id(),
        ts: seq,
        type: 'user_input_response',
        agentId: 'smith',
        turnId: 't1',
        requestId: 'req_1',
        answers: { dir: 'Left' },
      },
      message('t1', 'I will start.'),
      {
        id: id(),
        ts: seq,
        type: 'todo_update',
        agentId: 'smith',
        turnId: 't1',
        todos: [{ text: 'Build it', status: 'in_progress' }],
      },
      message('t1', 'Plan is ready.'),
      turnResult('t1'),
    ])

    expect(turn?.tail.map((segment) => segment.kind)).toEqual([
      'reply',
      'ask',
      'reply',
      'todo',
      'reply',
    ])
    expect(turn?.answer.map((reply) => reply.text)).toEqual([
      'I need your answer.',
      'I will start.',
      'Plan is ready.',
    ])
  })

  it('keeps a question before reasoning emitted after it', () => {
    const [turn] = turnsOf([
      {
        id: id(),
        ts: seq,
        type: 'user_input_request',
        agentId: 'smith',
        turnId: 't1',
        requestId: 'req_1',
        questions: [question],
      },
      {
        id: id(),
        ts: seq,
        type: 'user_input_response',
        agentId: 'smith',
        turnId: 't1',
        requestId: 'req_1',
        answers: { dir: 'Left' },
      },
      reasoning('t1', 'Closing thought'),
      turnResult('t1'),
    ])

    expect(turn?.segments.map((segment) => segment.kind)).toEqual(['ask', 'work'])
    expect(turn?.tail).toEqual([])
  })

  it('keeps reasoning between an earlier reply and a later question', () => {
    const [turn] = turnsOf([
      message('t1', 'Before the thought.'),
      reasoning('t1', 'Closing thought'),
      {
        id: id(),
        ts: seq,
        type: 'user_input_request',
        agentId: 'smith',
        turnId: 't1',
        requestId: 'req_1',
        questions: [question],
      },
      {
        id: id(),
        ts: seq,
        type: 'user_input_response',
        agentId: 'smith',
        turnId: 't1',
        requestId: 'req_1',
        answers: { dir: 'Left' },
      },
      turnResult('t1'),
    ])

    expect(turn?.segments.map((segment) => segment.kind)).toEqual(['work'])
    expect(turn?.tail.map((segment) => segment.kind)).toEqual(['reply', 'ask'])
  })

  it('keeps a plan before a later memory-log write', () => {
    const [turn] = turnsOf([
      {
        id: id(),
        ts: seq,
        type: 'todo_update',
        agentId: 'smith',
        turnId: 't1',
        todos: [{ text: 'Build it', status: 'in_progress' }],
      },
      toolUse('t1', 'memory-write', [
        {
          path: '/Users/sam/notes/memory/daily/2026-08-21.md',
          kind: 'update',
          before: '',
          after: 'Logged',
        },
      ]),
      turnResult('t1'),
    ])

    expect(turn?.segments.map((segment) => segment.kind)).toEqual(['todo', 'edits'])
    expect(turn?.tail).toEqual([])
  })

  it('keeps a memory-log write between an earlier reply and a later plan', () => {
    const [turn] = turnsOf([
      message('t1', 'Before the log.'),
      toolUse('t1', 'memory-write', [
        {
          path: '/Users/sam/notes/memory/daily/2026-08-21.md',
          kind: 'update',
          before: '',
          after: 'Logged',
        },
      ]),
      {
        id: id(),
        ts: seq,
        type: 'todo_update',
        agentId: 'smith',
        turnId: 't1',
        todos: [{ text: 'Build it', status: 'in_progress' }],
      },
      turnResult('t1'),
    ])

    expect(turn?.segments.map((segment) => segment.kind)).toEqual(['edits'])
    expect(turn?.tail.map((segment) => segment.kind)).toEqual(['reply', 'todo'])
  })
})

describe('what a checkout status leaves behind', () => {
  const reply = (partial: Partial<Extract<Parameters<typeof reduce>[1], { type: 'checkout_status' }>>) =>
    reduce(emptyWorkspace, {
      type: 'checkout_status',
      chatId: 'chat',
      projectId: 'manor',
      mode: 'current' as const,
      branch: 'main',
      dirty: false,
      gitRoots: ['/Users/sam/Manor'],
      branches: [],
      ...partial,
    })

  it('remembers the project’s git roots from a chat’s own answer, so the next chat opens with the row already there', () => {
    const state = reply({})

    expect(state.projectHasGit.manor).toBe(true)
    // Keyed by chat: the next chat must not read this one's branch or dirt.
    expect(state.checkoutStatus.manor).toBeUndefined()
  })

  it('remembers a notes-only project as false rather than as not-yet-known', () => {
    expect(reply({ gitRoots: [] }).projectHasGit.manor).toBe(false)
  })

  it('keeps the fact when a repeated answer changes nothing else', () => {
    const first = reply({})
    const again = reduce(first, { ...first.checkoutStatus.chat! })

    expect(again.projectHasGit.manor).toBe(true)
  })
})

describe('optimistic chat overrides', () => {
  const seeded = (): WorkspaceState => ({
    ...emptyWorkspace,
    threads: { chat: { ...emptyThread, hasSnapshot: true } },
  })

  it('keeps two rapid picks through the first broadcast and both acknowledgements', () => {
    let state = echoChatOverride(seeded(), 'chat', {
      requestId: 'model',
      agentId: 'sage',
      override: { model: 'claude-sonnet-5' },
    })
    state = echoChatOverride(state, 'chat', {
      requestId: 'effort',
      agentId: 'sage',
      override: { model: 'claude-sonnet-5', effort: 'low' },
    })

    state = reduce(state, {
      type: 'chat_overrides',
      chatId: 'chat',
      perAgent: { sage: { model: 'claude-sonnet-5' } },
    })
    expect(state.threads.chat?.overrides.sage).toEqual({ model: 'claude-sonnet-5', effort: 'low' })

    state = settleChatOverride(state, 'chat', 'model')
    state = reduce(state, {
      type: 'chat_overrides',
      chatId: 'chat',
      perAgent: { sage: { model: 'claude-sonnet-5', effort: 'low' } },
    })
    state = settleChatOverride(state, 'chat', 'effort')

    expect(state.threads.chat?.overrides.sage).toEqual({ model: 'claude-sonnet-5', effort: 'low' })
    expect(state.threads.chat?.optimisticOverrides).toEqual([])
  })

  it('rolls a refused echo back to the last server document', () => {
    const pending = echoChatOverride(seeded(), 'chat', {
      requestId: 'refused',
      agentId: 'sage',
      override: { effort: 'max' },
    })

    expect(pending.threads.chat?.overrides.sage).toEqual({ effort: 'max' })
    expect(settleChatOverride(pending, 'chat', 'refused').threads.chat?.overrides).toEqual({})
  })
})
