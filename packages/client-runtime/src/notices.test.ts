import { CURRENT_CHECKOUT, type AgentConfig, type Chat, type Project, type ProjectFileWrite, type Routine, type ServerMessage, type WorkHandoff } from '@manor/contracts'
import { describe, expect, it } from 'vitest'
import { createNoticeStore, DONE_FLOOR_MS, doneCount, eventNotices, noticeRoute, pushNotice, unsentPings, type AppNotice, type DonePing } from './notices'
import { clearRunningTurns, emptyThread, emptyWorkspace, inbox, reduce, setViewedChats, type WorkspaceState } from './state'

const agent = (id: string, name: string): AgentConfig =>
  ({ id, name, color: '#8b5cf6', allowedTools: [] }) as unknown as AgentConfig

const ROSTER = [agent('jeeves', 'Jeeves'), agent('smith', 'Smith')]

const chat = (chat: Partial<Chat> & Pick<Chat, 'id'>): Chat => ({
  projectId: 'proj_1',
  kind: 'project',
  routineId: null,
  parentChatId: null,
  sideModel: null,
  sideEffort: null,
  memberIds: [],
  lastMessagePreview: null,
  title: chat.id,
  createdAt: 1_000,
  lastMessageAt: 1_000,
  settledAt: null,
  agentIds: [],
  checkout: CURRENT_CHECKOUT,
  ...chat,
  archivedAt: chat.archivedAt ?? null,
})

const workspace = (chats: Chat[], extra: Partial<WorkspaceState> = {}): WorkspaceState => ({
  ...emptyWorkspace,
  agents: ROSTER,
  hasRoster: true,
  hasDirectory: true,
  chats,
  ...extra,
})

const START = 100_000
const turn = (
  turnId: string,
  state: 'running' | 'done' | 'aborted' | 'error',
  extra: Partial<{ chatId: string; agentId: string; startedAt: number }> = {},
): ServerMessage => ({
  type: 'turn_state',
  chatId: extra.chatId ?? 'chat_1',
  turnId,
  agentId: extra.agentId ?? 'smith',
  state,
  ...(state === 'running' ? { startedAt: extra.startedAt ?? START } : {}),
}) as ServerMessage

/** Folds messages, collecting whatever each one would have announced. */
const play = (
  start: WorkspaceState,
  messages: ServerMessage[],
  now: number,
): { state: WorkspaceState; pings: DonePing[] } => {
  let state = start
  const pings: DonePing[] = []
  for (const msg of messages) {
    const before = state
    // The fold's own clock is pinned to the start of the run rather than left to
    // `Date.now()`, so a message that dates a run from *now* — a delta that arrives
    // before its `turn_state` — is dated inside this file's timeline instead of at the
    // real wall clock, which would put every run in the far future and under the floor.
    state = reduce(state, msg, START)
    for (const notice of eventNotices(before, state, msg, now)) if (notice.banner !== null) pings.push(notice.banner)
  }
  return { state, pings }
}

const AFTER_FLOOR = START + DONE_FLOOR_MS + 1

describe('the done notice', () => {
  it('does not announce a quiet DM routine', () => {
    const end = { ...turn('t1', 'done'), routineOutcome: 'quiet' as const }
    const { state, pings } = play(
      workspace([chat({ id: 'chat_1', title: 'Manor' })]),
      [turn('t1', 'running'), end],
      AFTER_FLOOR,
    )
    expect(pings).toEqual([])
    expect(state.activity.chat_1?.unread).toBe(false)
  })

  it('announces a background chat whose run ended, naming the chat and what was said', () => {
    const { pings } = play(
      workspace([chat({ id: 'chat_1', title: 'Manor', lastMessagePreview: 'Klaar, alles groen.', agentIds: ['smith'] })]),
      [turn('t1', 'running'), turn('t1', 'done')],
      AFTER_FLOOR,
    )

    expect(pings).toEqual([
      { chatId: 'chat_1', key: 't1', title: 'Manor', body: 'Smith: Klaar, alles groen.' },
    ])
  })

  // The commonest way to miss an answer, and the one an `unread` gate made silent:
  // you start a long turn, switch to another app, and leave that very chat open. It
  // is never unread, because it is open. Whether you were looking is the host's
  // question — it drops the notice while the window has focus — so the renderer
  // announces this and lets the host refuse it.
  it('announces the chat that is open, because open is not the same as watched', () => {
    const { pings } = play(
      workspace([chat({ id: 'chat_1', title: 'Manor' })], { openChatId: 'chat_1' }),
      [turn('t1', 'running'), turn('t1', 'done')],
      AFTER_FLOOR,
    )

    expect(pings.map((ping) => ping.key)).toEqual(['t1'])
  })

  it('pings once for a handoff, at the end, not once per persona', () => {
    // Jeeves takes the message and @mentions Smith: the second turn starts before
    // the first one ends, so the chat is never Done in between.
    const { pings } = play(
      workspace([chat({ id: 'chat_1', title: 'Manor', agentIds: ['smith'] })]),
      [
        turn('t1', 'running', { agentId: 'jeeves' }),
        turn('t2', 'running', { agentId: 'smith' }),
        turn('t1', 'done', { agentId: 'jeeves' }),
        turn('t2', 'done', { agentId: 'smith' }),
      ],
      AFTER_FLOOR,
    )

    expect(pings.map((ping) => ping.key)).toEqual(['t2'])
  })

  it('lets a short run pass in silence', () => {
    const { pings } = play(
      workspace([chat({ id: 'chat_1' })]),
      [turn('t1', 'running'), turn('t1', 'done')],
      START + DONE_FLOOR_MS - 1,
    )

    expect(pings).toEqual([])
  })

  it('announces a one-time routine result however short its turn was', () => {
    const { pings } = play(
      workspace([chat({ id: 'chat_1' })]),
      [turn('t1', 'running'), { ...turn('t1', 'done'), notice: 'alert' } as ServerMessage],
      START + 5,
    )

    expect(pings.map((ping) => ping.key)).toEqual(['t1'])
  })

  it('keeps a routine with notify off silent on either side of the floor', () => {
    for (const at of [START + 5, AFTER_FLOOR]) {
      const { pings } = play(
        workspace([chat({ id: 'chat_1' })]),
        [turn('t1', 'running'), { ...turn('t1', 'done'), notice: 'silent' } as ServerMessage],
        at,
      )
      expect(pings).toEqual([])
    }
  })

  it('announces an aborted or failed run too, because the wait is over either way', () => {
    for (const ending of ['aborted', 'error'] as const) {
      const { pings } = play(
        workspace([chat({ id: 'chat_1' })]),
        [turn('t1', 'running'), turn('t1', ending)],
        AFTER_FLOOR,
      )
      expect(pings).toHaveLength(1)
    }
  })

  it('stays out of a settled chat, the same refusal the inbox already makes', () => {
    const { pings } = play(
      workspace([chat({ id: 'chat_1', settledAt: 5_000 })]),
      [turn('t1', 'running'), turn('t1', 'done')],
      AFTER_FLOOR,
    )

    expect(pings).toEqual([])
  })

  it('announces a dm under the persona name, with no speaker in front of it', () => {
    const { pings } = play(
      workspace([
        chat({
          id: 'dm_smith',
          kind: 'dm',
          projectId: null,
          memberIds: ['smith'],
          // The title frozen in at creation; a rename must not survive in the banner.
          title: 'Smit',
          lastMessagePreview: 'Gebouwd.',
          agentIds: ['smith'],
        }),
      ]),
      [turn('t1', 'running', { chatId: 'dm_smith' }), turn('t1', 'done', { chatId: 'dm_smith' })],
      AFTER_FLOOR,
    )

    expect(pings).toEqual([{ chatId: 'dm_smith', key: 't1', title: 'Smith', body: 'Gebouwd.' }])
  })

  it('says nothing when a reconnect blanked the dots, because nothing ended here', () => {
    const running = play(workspace([chat({ id: 'chat_1' })]), [turn('t1', 'running')], START).state
    const reconnected = clearRunningTurns(running)

    const { pings } = play(reconnected, [turn('t1', 'done')], AFTER_FLOOR)

    expect(pings).toEqual([])
  })

  // The other half of that refusal, and the one clearing the dots does not cover: a
  // client that reconnects mid-turn is handed the run whole by the snapshot, start
  // time and all. That is enough to sort the row and run the timer, and not enough
  // to call the end of it news — the work happened while this window was shut.
  it('says nothing about a run it only met through a snapshot', () => {
    const snapshot: ServerMessage = {
      type: 'snapshot',
      chatId: 'chat_1',
      events: [],
      usage: [],
      activeTurn: { turnId: 't1', agentId: 'smith', startedAt: START },
    } as unknown as ServerMessage
    const { pings } = play(workspace([chat({ id: 'chat_1', title: 'Manor' })]), [snapshot, turn('t1', 'done')], AFTER_FLOOR)

    expect(pings).toEqual([])
  })

  // The third door into the same mistake, and the one a "went from no turns to some
  // turns" rule cannot close: after a reconnect the first thing to arrive can be a
  // delta of a turn that has been running for ten minutes. That transition looks
  // exactly like a start from here, so only the explicit `turn_state: running` — which
  // the server sends once, at the real start, and never for a snapshot — may arm it.
  it('says nothing about a run it first met through a delta', () => {
    const streamed: ServerMessage = {
      type: 'delta',
      chatId: 'chat_1',
      turnId: 't1',
      agentId: 'smith',
      messageId: 'm1',
      text: 'al tien minuten bezig',
    } as unknown as ServerMessage

    const { pings } = play(
      workspace([chat({ id: 'chat_1', title: 'Manor' })]),
      [streamed, turn('t1', 'done')],
      AFTER_FLOOR,
    )

    expect(pings).toEqual([])
  })

  // But a delta arriving ahead of its own start does not cost the notice: the start
  // still comes, and it is the message that arms.
  it('announces a run whose first delta beat its own start message', () => {
    const streamed: ServerMessage = {
      type: 'delta',
      chatId: 'chat_1',
      turnId: 't1',
      agentId: 'smith',
      messageId: 'm1',
      text: 'even kijken',
    } as unknown as ServerMessage

    const { pings } = play(
      workspace([chat({ id: 'chat_1', title: 'Manor' })]),
      [streamed, turn('t1', 'running'), turn('t1', 'done')],
      AFTER_FLOOR,
    )

    expect(pings.map((ping) => ping.key)).toEqual(['t1'])
  })

  // And the run after it is ordinary again: the flag falls away with the run it
  // belonged to rather than making the chat quiet forever.
  it('announces the next run in a chat whose previous one arrived by snapshot', () => {
    const snapshot: ServerMessage = {
      type: 'snapshot',
      chatId: 'chat_1',
      events: [],
      usage: [],
      activeTurn: { turnId: 't1', agentId: 'smith', startedAt: START },
    } as unknown as ServerMessage
    const { pings } = play(
      workspace([chat({ id: 'chat_1', title: 'Manor' })]),
      [snapshot, turn('t1', 'done'), turn('t2', 'running'), turn('t2', 'done')],
      AFTER_FLOOR,
    )

    expect(pings.map((ping) => ping.key)).toEqual(['t2'])
  })

  it('falls back to a plain line when the chat has nothing quotable in it', () => {
    const { pings } = play(
      workspace([chat({ id: 'chat_1', title: 'Manor' })]),
      [turn('t1', 'running'), turn('t1', 'done')],
      AFTER_FLOOR,
    )

    expect(pings[0]?.body).toBe('Finished.')
  })
})

describe('the waiting notice', () => {
  const options = [{ label: 'Yes' }, { label: 'No' }]
  const ask = (requestId: string, question: string, extra: { chatId?: string; optionsOnly?: boolean } = {}): ServerMessage => ({
    type: 'event',
    chatId: extra.chatId ?? 'chat_1',
    event: {
      id: `ask_${requestId}`, ts: START + 1, type: 'user_input_request', agentId: 'smith', turnId: 't1', requestId,
      questions: [{ id: 'q', question, options, ...(extra.optionsOnly === true ? { optionsOnly: true } : {}) }],
    },
  }) as ServerMessage
  const fold = (start: WorkspaceState, messages: ServerMessage[]) => play(start, messages, START + 2).pings

  it('announces a question and an approval at once, while the turn still runs, and only once each', () => {
    const asked = ask('r1', 'Ship it today?')
    const pings = fold(workspace([chat({ id: 'chat_1', title: 'Manor' })]), [
      turn('t1', 'running'), asked, asked, ask('r2', 'Allow Smith to use Safari?', { optionsOnly: true }),
    ])
    expect(pings).toEqual([
      { chatId: 'chat_1', key: 'ask:r1', title: 'Manor', body: 'Smith needs you: Ship it today?' },
      { chatId: 'chat_1', key: 'ask:r2', title: 'Manor', body: 'Smith needs your approval: Allow Smith to use Safari?' },
    ])
  })

  it('names a dm by its persona and stays out of a settled chat', () => {
    const dm = chat({ id: 'dm_smith', kind: 'dm', projectId: null, memberIds: ['smith'], title: 'old name' })
    const settled = chat({ id: 'chat_2', title: 'Done work', settledAt: 2_000 })
    const pings = fold(workspace([dm, settled]), [
      turn('t1', 'running', { chatId: 'dm_smith' }), ask('r1', 'Which one?', { chatId: 'dm_smith' }),
      turn('t1', 'running', { chatId: 'chat_2' }), ask('r2', 'Still there?', { chatId: 'chat_2' }),
    ])
    expect(pings).toEqual([{ chatId: 'dm_smith', key: 'ask:r1', title: 'Smith', body: 'Needs you: Which one?' }])
  })
})

describe('the dock count', () => {
  it('counts exactly the chats the inbox stands at Done', () => {
    const start = workspace([
      chat({ id: 'chat_1', title: 'One' }),
      chat({ id: 'chat_2', title: 'Two' }),
      chat({ id: 'chat_3', title: 'Three', settledAt: 5_000 }),
    ])
    const { state } = play(
      start,
      [
        turn('t1', 'running', { chatId: 'chat_1' }),
        turn('t1', 'done', { chatId: 'chat_1' }),
        // Still working, so it is not Done and must not be counted.
        turn('t2', 'running', { chatId: 'chat_2' }),
        // Settled, and therefore out of both the list and the count.
        turn('t3', 'running', { chatId: 'chat_3' }),
        turn('t3', 'done', { chatId: 'chat_3' }),
      ],
      AFTER_FLOOR,
    )

    expect(doneCount(state)).toBe(1)
    const standing = inbox(state).unsettled.filter((row) => row.unread && !row.running)
    expect(standing.map((row) => row.chat.id)).toEqual(['chat_1'])
  })

  it('does not count a viewed split pane as Done', () => {
    const start = setViewedChats(
      workspace([chat({ id: 'chat_1', title: 'One' })], { openChatId: 'other' }),
      ['chat_1'],
    )
    const { state } = play(start, [turn('t1', 'running'), turn('t1', 'done')], AFTER_FLOOR)
    expect(doneCount(state)).toBe(0)
  })
})

describe('the send guard', () => {
  it('shows a turn once however often the fold offers it', () => {
    const ping: DonePing = { chatId: 'chat_1', key: 't1', title: 'Manor', body: 'Klaar.' }
    const sent = new Set<string>()

    expect(unsentPings([ping, ping], sent)).toEqual([ping])
    expect(unsentPings([ping], sent)).toEqual([])
  })
})

/** Folds messages, collecting every notice for either door. */
const notices = (start: WorkspaceState, messages: ServerMessage[], now: number): AppNotice[] => {
  let state = start
  const found: AppNotice[] = []
  for (const msg of messages) {
    const before = state
    state = reduce(state, msg, START)
    found.push(...eventNotices(before, state, msg, now))
  }
  return found
}

describe('the in-app notice', () => {
  const dm = chat({ id: 'dm_smith', kind: 'dm', projectId: null, memberIds: ['smith'], lastMessagePreview: 'Gebouwd.', agentIds: ['smith'] })

  it('shows a short run in the app but keeps the banner behind the floor', () => {
    const [notice] = notices(workspace([dm]), [turn('t1', 'running', { chatId: 'dm_smith' }), turn('t1', 'done', { chatId: 'dm_smith' })], START + 2)
    // The face says who, so the persona's name is not repeated under the line.
    expect(notice).toMatchObject({ kind: 'reply', title: 'Gebouwd.', body: '', face: 'smith', chatId: 'dm_smith', banner: null, sticky: false })
  })

  it('calls a project thread reply a reply under the project name, never Session done', () => {
    const thread = chat({ id: 'chat_thread', kind: 'project', projectId: 'p1', title: 'Manor', lastMessagePreview: 'Started the Session.' })
    const project = { id: 'p1', name: 'Manor', threadChatId: 'chat_thread' } as unknown as Project
    const [notice] = notices(workspace([thread], { projects: [project] }), [turn('t1', 'running', { chatId: 'chat_thread' }), turn('t1', 'done', { chatId: 'chat_thread' })], AFTER_FLOOR)
    expect(notice).toMatchObject({ kind: 'reply', title: 'Started the Session.', body: 'Manor' })
    expect(notice?.face).toBeUndefined()
  })

  it('offers Undo once for a memory line an agent wrote, and not for its undone copy, a restore or a line without Undo', () => {
    const write = (extra: Partial<ProjectFileWrite> = {}): ServerMessage => ({
      type: 'event', chatId: 'dm_smith',
      event: { id: 'e1', type: 'system_note', kind: 'info', ts: 1, text: 'Saved', projectFileWrite: { file: 'smith.md', action: 'add', line: 'Prefers a window seat', by: 'Smith', agentId: 'smith', writeId: 'w1', ...extra } },
    }) as unknown as ServerMessage
    const found = notices(workspace([dm]), [write()], START)
    expect(found.map((notice) => [notice.kind, notice.title, notice.body, notice.undo, notice.sticky])).toEqual([
      ['memory', 'Saved to memory', 'Smith: Prefers a window seat', { chatId: 'dm_smith', writeId: 'w1' }, false],
    ])
    // Manor's own date on a preference line is today's and goes; a date the agent wrote in a note stays.
    expect(notices(workspace([dm]), [write({ file: 'preferences.md', line: 'Window seats (2026-11-25)' })], START)[0]?.body).toBe('Smith: Window seats')
    expect(notices(workspace([dm]), [write({ file: 'notes.md', line: 'Trip booked (2026-12-01)' })], START)[0]?.body).toBe('Smith: Trip booked (2026-12-01)')
    // The user who has the chat open sees the line land there.
    expect(noticeRoute(found[0]!, { focused: true, onScreen: (chatId) => chatId === 'dm_smith' })).toBeNull()
    expect(notices(workspace([dm]), [write({ undone: true })], START)).toEqual([])
    expect(notices(workspace([dm]), [write({ action: 'restore' })], START)).toEqual([])
    expect(notices(workspace([dm]), [write({ writeId: undefined })], START)).toEqual([])
    // An open thread that already holds the event hears a repeat, not news.
    expect(notices(workspace([dm], { threads: { dm_smith: emptyThread } }), [write(), write()], START)).toHaveLength(1)
  })

  it('stays silent for a settled chat and for a quiet routine, as the banner does', () => {
    const settled = chat({ id: 'chat_1', settledAt: 5_000 })
    expect(notices(workspace([settled]), [turn('t1', 'running'), turn('t1', 'done')], AFTER_FLOOR)).toEqual([])
    const quiet = { ...turn('t1', 'done'), routineOutcome: 'quiet' as const }
    expect(notices(workspace([chat({ id: 'chat_1' })]), [turn('t1', 'running'), quiet], AFTER_FLOOR)).toEqual([])
    const silent = { ...turn('t1', 'done'), notice: 'silent' } as ServerMessage
    expect(notices(workspace([chat({ id: 'chat_1' })]), [turn('t1', 'running'), silent], AFTER_FLOOR)).toEqual([])
  })

  it('names a failed turn as a failure', () => {
    const [notice] = notices(workspace([chat({ id: 'chat_1', title: 'Manor' })]), [turn('t1', 'running'), turn('t1', 'error')], AFTER_FLOOR)
    expect(notice).toMatchObject({ kind: 'failed', title: 'Turn failed', body: 'Manor' })
  })

  it('calls a Session done by name, with or without a handoff', () => {
    const session = chat({ id: 'chat_1', kind: 'project', title: 'Launch checklist', lastMessagePreview: 'Here it is.' })
    const [notice] = notices(workspace([session]), [turn('t1', 'running'), turn('t1', 'done')], START + 2)
    expect(notice).toMatchObject({ kind: 'done', title: 'Session done', body: 'Launch checklist' })
  })

  it('makes a question sticky and keeps its banner', () => {
    const asked = {
      type: 'event', chatId: 'chat_1',
      event: { id: 'e', ts: START, type: 'user_input_request', agentId: 'smith', turnId: 't1', requestId: 'r1', questions: [{ id: 'q', question: 'Ship it?', options: [{ label: 'Yes' }] }] },
    } as ServerMessage
    const [notice] = notices(workspace([chat({ id: 'chat_1', title: 'Manor' })]), [turn('t1', 'running'), asked], START + 1)
    expect(notice).toMatchObject({ kind: 'waiting', sticky: true, title: 'Smith needs you: Ship it?', body: 'Manor' })
    expect(notice?.banner).toEqual({ chatId: 'chat_1', key: 'ask:r1', title: 'Manor', body: 'Smith needs you: Ship it?' })
  })

  it('announces a proposal once, and not from the first directory on a socket', () => {
    const handoff = { id: 'h1', sourceChatId: 'dm_smith', workChatId: null, acceptedAt: null, state: 'active', title: 'Fix the stack', version: 1 } as unknown as WorkHandoff
    const directory = (handoffs: WorkHandoff[]) => ({ type: 'directory', projects: [], chats: [dm], workHandoffs: handoffs }) as unknown as ServerMessage
    expect(notices(workspace([dm]), [directory([handoff])], START)).toEqual([])
    const found = notices(workspace([dm]), [directory([]), directory([handoff]), directory([handoff])], START)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ kind: 'proposal', chatId: 'dm_smith', sticky: true, body: 'Fix the stack', banner: null })
    // A proposal made while this client was offline is found by the reconnect, not announced.
    const known = notices(workspace([dm]), [directory([])], START)
    expect(known).toEqual([])
    let state = reduce(workspace([dm]), directory([]), START)
    state = clearRunningTurns(state)
    expect(eventNotices(state, reduce(state, directory([handoff]), START), directory([handoff]), START)).toEqual([])
  })

  it('points a nested helper question at the chat that answers it, once', () => {
    const helper = { id: 'sub_1', parentChatId: 'dm_smith', title: 'Research', state: 'running', startedAt: 1, depth: 1 }
    const nested = { id: 'sub_2', parentChatId: 'sub_1', title: 'Prices', state: 'running', startedAt: 2, depth: 2, ask: { requestId: 'q1', questions: [{ question: 'Which  shop?' }] } }
    const directory = (subagents: unknown[]) => ({ type: 'directory', projects: [], chats: [dm], workHandoffs: [], subagents }) as unknown as ServerMessage
    const found = notices(workspace([dm]), [directory([helper]), directory([helper, nested]), directory([helper, nested])], START)
    expect(found.map((notice) => [notice.kind, notice.chatId, notice.title, notice.sticky])).toEqual([['waiting', 'dm_smith', 'Prices needs you: Which shop?', true]])
    expect(notices(workspace([dm]), [directory([helper, nested])], START)).toEqual([])
  })

  it('says a Session waits on Confirm when its goal result lands after the turn', () => {
    const session = chat({ id: 'chat_s', kind: 'project', title: 'Launch checklist' })
    const handoff = (reached: boolean) => ({
      id: 'h1', sourceChatId: 'dm_smith', workChatId: 'chat_s', acceptedAt: 1, state: 'active', title: 'Launch checklist', version: reached ? 2 : 1,
      ...(reached ? { goalReport: { result: 'Done.' }, goalReachedAt: 5 } : {}),
    }) as unknown as WorkHandoff
    const directory = (reached: boolean) => ({ type: 'directory', projects: [], chats: [dm, session], workHandoffs: [handoff(reached)] }) as unknown as ServerMessage
    const found = notices(workspace([dm, session]), [directory(false), directory(true), directory(true)], START)
    expect(found.map((notice) => [notice.kind, notice.title, notice.slot, notice.body, notice.sticky])).toEqual([['ready', 'Waits on Confirm', 'chat_s', 'Launch checklist', true]])
  })

  it('says Merged into its branch once Manor\'s merge after Confirm lands, and nothing for a commit, a stopped merge or a reconnect', () => {
    const session = chat({ id: 'chat_s', kind: 'project', title: 'Launch checklist' })
    const handoff = (status: 'pending' | 'complete' | 'blocked', operation: 'merge' | 'commit' = 'merge') => ({
      id: 'h1', sourceChatId: 'dm_smith', workChatId: 'chat_s', acceptedAt: 1, state: 'active', title: 'Launch checklist', version: 3,
      goalReport: { result: 'Done.' }, goalReachedAt: 5, goalConfirmedAt: 6,
      goalCompletion: { status, operation, repos: [{ path: '/repo', branch: 'manor/h1', before: 'a', tree: 'b', files: [], mergeInto: 'main' }] },
    }) as unknown as WorkHandoff
    const directory = (...handoffs: WorkHandoff[]) => ({ type: 'directory', projects: [], chats: [dm, session], workHandoffs: handoffs }) as unknown as ServerMessage
    const found = notices(workspace([dm, session]), [directory(handoff('pending')), directory(handoff('complete')), directory(handoff('complete'))], START)
    expect(found.map((notice) => [notice.kind, notice.title, notice.body, notice.chatId, notice.sticky])).toEqual([['merged', 'Merged into main', 'Launch checklist', 'chat_s', false]])
    // A shared checkout only commits, and a merge that stopped is Commit needs you, not news.
    expect(notices(workspace([dm, session]), [directory(handoff('pending', 'commit')), directory(handoff('complete', 'commit'))], START)).toEqual([])
    expect(notices(workspace([dm, session]), [directory(handoff('pending')), directory(handoff('blocked'))], START).map((notice) => notice.kind)).not.toContain('merged')
    // A merge that landed while this client was away is found by the reconnect, not announced.
    expect(notices(workspace([dm, session]), [directory(handoff('complete'))], START)).toEqual([])
    const state = clearRunningTurns(reduce(workspace([dm, session]), directory(handoff('pending')), START))
    expect(eventNotices(state, reduce(state, directory(handoff('complete')), START), directory(handoff('complete')), START)).toEqual([])
  })

  it('says a settled Session was reopened when the thread sent a message on to it, and not for an open one', () => {
    const session = chat({ id: 'chat_s', kind: 'project', title: 'Launch checklist' })
    const thread = chat({ id: 'chat_thread', kind: 'project', title: 'Manor' })
    const sent = (reopened: boolean): ServerMessage => ({
      type: 'event', chatId: 'chat_thread',
      event: { id: 'n1', type: 'system_note', kind: 'info', ts: 1, text: 'Sent to “Launch checklist”.', hintFor: 'u1',
        sessionForward: { sessionChatId: 'chat_s', title: 'Launch checklist', turnId: 't1', agentId: '__single__', ...(reopened ? { reopened: true } : {}) } },
    }) as unknown as ServerMessage
    const [notice, ...rest] = notices(workspace([thread, session]), [sent(true)], START)
    expect(rest).toEqual([])
    expect(notice).toMatchObject({ kind: 'reopened', title: 'Session reopened', body: 'Launch checklist', chatId: 'chat_s', target: { chatId: 'chat_s' }, sticky: false })
    expect(notices(workspace([thread, session]), [sent(false)], START)).toEqual([])
    // The user's own Unsettle leaves its note in the Session, not a forward from the thread.
    const unsettled = { type: 'event', chatId: 'chat_s', event: { id: 'n2', type: 'system_note', kind: 'info', ts: 1, text: 'Session “Launch checklist” was reopened; the previous outcome was withdrawn.', workHandoffPhase: 'reopened' } } as unknown as ServerMessage
    expect(notices(workspace([thread, session]), [unsettled], START)).toEqual([])
    expect(notices(workspace([thread, session], { threads: { chat_thread: emptyThread } }), [sent(true), sent(true)], START)).toHaveLength(1)
    // The user who has the Session open sees it come back there.
    expect(noticeRoute(notice!, { focused: true, onScreen: (chatId) => chatId === 'chat_s' })).toBeNull()
  })

  it('announces each failed routine run once, a one-time failure included, and nothing found on reconnect', () => {
    // A failed run leaves lastRunAt where it was.
    const routine = (failures: number, extra: Partial<Routine> = {}) => ({ id: 'r1', name: 'Morning brief', chatId: 'dm_smith', consecutiveFailures: failures, lastRunAt: 7, endState: null, endedAt: null, ...extra }) as unknown as Routine
    const routines = (...list: Routine[]) => ({ type: 'routines', routines: list }) as unknown as ServerMessage
    const found = notices(workspace([dm]), [routines(routine(0)), routines(routine(0)), routines(routine(1)), routines(routine(2))], START)
    expect(found.map((notice) => [notice.kind, notice.body, notice.slot])).toEqual([['failed', 'Morning brief', 'routine:r1'], ['failed', 'Morning brief', 'routine:r1']])
    expect(new Set(found.map((notice) => notice.key)).size).toBe(2)
    const once = notices(workspace([dm]), [routines(routine(0)), routines(routine(0, { endState: 'failed', endedAt: 9 }))], START)
    expect(once.map((notice) => notice.kind)).toEqual(['failed'])
    const state = clearRunningTurns(reduce(workspace([dm]), routines(routine(0)), START))
    expect(eventNotices(state, reduce(state, routines(routine(1)), START), routines(routine(1)), START)).toEqual([])
  })

  it('announces a provider limit when the fullest window runs out', () => {
    const usage = (used: number) => ({
      type: 'provider_usage',
      perProvider: [{ provider: 'claude', status: 'ok', fetchedAt: used, windows: [{ label: 'Week', usedPercent: used }] }],
    }) as unknown as ServerMessage
    const found = notices(workspace([]), [usage(100), usage(90), usage(99.6), usage(100), usage(100)], START)
    expect(found.map((notice) => [notice.kind, notice.body, notice.target, notice.key])).toEqual([['limit', 'Claude Code', { page: 'usage' }, 'limit:claude:100']])
  })
})

describe('the notice gate', () => {
  const onScreen = (open: string) => (chatId: string) => chatId === open
  const banner = { chatId: 'chat_1', key: 't1', title: 'Manor', body: 'Klaar.' }

  it('shows in the app while focused, through the OS while not, never both', () => {
    expect(noticeRoute({ chatId: 'chat_1', banner }, { focused: true, onScreen: onScreen('other') })).toBe('app')
    expect(noticeRoute({ chatId: 'chat_1', banner }, { focused: false, onScreen: onScreen('other') })).toBe('banner')
  })

  it('suppresses a notice whose chat is on screen, but not its banner once the window is away', () => {
    expect(noticeRoute({ chatId: 'chat_1', banner }, { focused: true, onScreen: onScreen('chat_1') })).toBeNull()
    expect(noticeRoute({ chatId: 'chat_1', banner }, { focused: false, onScreen: onScreen('chat_1') })).toBe('banner')
  })

  it('keeps app-only news out of the OS', () => {
    expect(noticeRoute({ chatId: null, banner: null }, { focused: false, onScreen: onScreen('x') })).toBeNull()
    expect(noticeRoute({ chatId: null, banner: null }, { focused: true, onScreen: onScreen('x') })).toBe('app')
  })
})

describe('the notice stack', () => {
  const entry = (key: string, slot: string, extra: Partial<AppNotice> = {}): AppNotice => ({
    key, kind: 'done', slot, chatId: slot, title: key, body: slot, sticky: false, banner: null, target: { chatId: slot }, ...extra,
  })

  it('puts the newest on top and lets a newer notice replace the older one of its chat', () => {
    let stack = pushNotice([], entry('a', 'chat_1'), 1)
    stack = pushNotice(stack, entry('b', 'chat_2'), 2)
    stack = pushNotice(stack, entry('c', 'chat_1'), 3)
    expect(stack.map((item) => item.key)).toEqual(['c', 'b'])
  })

  it('keeps a notice that waits on the user when plain news for its chat arrives', () => {
    let stack = pushNotice([], entry('ask', 'chat_1', { kind: 'waiting', sticky: true }), 1)
    stack = pushNotice(stack, entry('other', 'chat_2'), 2)
    stack = pushNotice(stack, entry('done', 'chat_1'), 3)
    expect(stack.map((item) => [item.key, item.at])).toEqual([['ask', 3], ['other', 2]])
  })

  it('lets a merge take the place of the Waits on Confirm it answered, but not of a question', () => {
    let stack = pushNotice([], entry('ready', 'chat_1', { kind: 'ready', sticky: true }), 1)
    stack = pushNotice(stack, entry('merged', 'chat_1', { kind: 'merged', settles: true }), 2)
    expect(stack.map((item) => [item.key, item.sticky])).toEqual([['merged', false]])
    stack = pushNotice([], entry('ask', 'chat_1', { kind: 'waiting', sticky: true }), 1)
    stack = pushNotice(stack, entry('merged', 'chat_1', { kind: 'merged', settles: true }), 2)
    expect(stack.map((item) => item.key)).toEqual(['ask'])
  })

  it('drops only news when the stack is full, never a notice that waits on the user', () => {
    let stack = pushNotice([], entry('ask', 'chat_ask', { kind: 'waiting', sticky: true }), 0)
    for (let i = 1; i <= 20; i++) stack = pushNotice(stack, entry(`n${i}`, `chat_${i}`), i)
    expect(stack.some((item) => item.key === 'ask')).toBe(true)
    expect(stack.filter((item) => !item.sticky)).toHaveLength(12)
  })

  it('clears what a chat had standing once it is opened, and leaves the rest', () => {
    const store = createNoticeStore(() => 1)
    store.push(entry('a', 'chat_1'))
    store.push(entry('b', 'chat_2'))
    store.push({ ...entry('c', 'limit:claude'), chatId: null })
    store.clearChats((chatId) => chatId === 'chat_1')
    expect(store.get().map((item) => item.key)).toEqual(['c', 'b'])
    store.dismiss('b')
    expect(store.get().map((item) => item.key)).toEqual(['c'])
  })
})
