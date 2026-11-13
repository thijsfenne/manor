import { CURRENT_CHECKOUT, type AgentConfig, type Chat, type ServerMessage } from '@manor/contracts'
import { describe, expect, it } from 'vitest'
import { DONE_FLOOR_MS, doneCount, noticePing, unsentPings, type DonePing } from '../src/doneNotice'
import { clearRunningTurns, emptyWorkspace, inbox, reduce, setViewedChats, type WorkspaceState } from '../src/state'

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
    const ping = noticePing(before, state, msg, now)
    if (ping !== null) pings.push(ping)
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
      { chatId: 'chat_1', key: 'ask:r1', title: 'Manor', body: 'Smith is waiting on you: Ship it today?' },
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
    expect(pings).toEqual([{ chatId: 'dm_smith', key: 'ask:r1', title: 'Smith', body: 'Is waiting on you: Which one?' }])
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
