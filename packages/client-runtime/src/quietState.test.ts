import { describe, expect, it } from 'vitest'
import type { ServerMessage } from '@manor/contracts'
import { createQuietWorkspace, createWorkspaceStore, liveThreadOf, liveWritten, NO_LIVE_WORKSPACE, streamedMessages } from './quietState'
import { emptyThread } from './threadState'
import { rowsOf } from './transcriptState'
import { emptyWorkspace, reduce, type WorkspaceState } from './workspaceState'

const opened: WorkspaceState = { ...emptyWorkspace, threads: { work: emptyThread, other: emptyThread } }
const running: ServerMessage = { type: 'turn_state', chatId: 'work', turnId: 't1', agentId: 'sage', state: 'running', startedAt: 1 }
const delta = (text: string, messageId = 'm1'): ServerMessage =>
  ({ type: 'delta', chatId: 'work', turnId: 't1', agentId: 'sage', messageId, text })

const apply = (state: WorkspaceState, ...messages: ServerMessage[]) =>
  messages.reduce((next, message) => reduce(next, message, 5), state)

describe('quiet workspace', () => {
  it('keeps its identity while only streamed text grows', () => {
    const toQuiet = createQuietWorkspace()
    let live = apply(opened, running, delta('Hello'))
    const quiet = toQuiet(live)
    for (const text of [' there', ', how', ' are', ' you?']) {
      live = apply(live, delta(text))
      expect(toQuiet(live)).toBe(quiet)
    }
    // The live state did grow; only the quiet view stood still.
    expect(streamedMessages(live.threads.work!.liveTurns[0])[0]?.text).toBe('Hello there, how are you?')
  })

  it('strips the text, so a quiet reader cannot show a stale reply', () => {
    const quiet = createQuietWorkspace()(apply(opened, running, delta('Hello')))
    const turn = quiet.threads.work!.liveTurns[0]!
    expect(turn.messages).toEqual([{ messageId: 'm1', written: true }])
    expect('text' in turn.messages[0]!).toBe(false)
    expect(streamedMessages(turn)).toEqual([])
    expect(liveWritten(turn)).toBe(true)
  })

  it.each<[string, ServerMessage]>([
    ['a new message', delta('Next', 'm2')],
    ['a turn ending', { type: 'turn_state', chatId: 'work', turnId: 't1', agentId: 'sage', state: 'done' }],
    ['a second turn starting', { ...running, turnId: 't2', agentId: 'smith' }],
    ['a context reading', { type: 'turn_context', chatId: 'work', turnId: 't1', agentId: 'sage', context: { contextTokens: 9, compacting: true } }],
    ['background work', { type: 'turn_background', chatId: 'work', turnId: 't1', agentId: 'sage', agents: 1, commands: 0 }],
    ['an event', { type: 'event', chatId: 'work', event: { id: 'e1', ts: 4, type: 'tool_use', turnId: 't1', agentId: 'sage', toolCallId: 'c1', tool: 'Read', detail: 'a.ts' } }],
    ['usage', { type: 'usage', chatId: 'work', perAgent: {} }],
  ])('passes %s through', (_name, message) => {
    const toQuiet = createQuietWorkspace()
    const live = apply(opened, running, delta('Hello'))
    const quiet = toQuiet(live)
    const next = toQuiet(apply(live, message))
    expect(next).not.toBe(quiet)
    // The thread nothing touched keeps its quiet identity.
    expect(next.threads.other).toBe(quiet.threads.other)
  })

  it('passes a first write into an empty message through', () => {
    const toQuiet = createQuietWorkspace()
    const live = apply(opened, running, delta(''))
    const quiet = toQuiet(live)
    expect(liveWritten(quiet.threads.work!.liveTurns[0])).toBe(false)
    const written = toQuiet(apply(live, delta('Hi')))
    expect(written).not.toBe(quiet)
    expect(liveWritten(written.threads.work!.liveTurns[0])).toBe(true)
  })

  it('passes a workspace slice outside the threads through', () => {
    const toQuiet = createQuietWorkspace()
    const live = apply(opened, running, delta('Hello'))
    const quiet = toQuiet(live)
    const next = toQuiet({ ...live, openChatId: 'work' })
    expect(next).not.toBe(quiet)
    expect(next.threads).toBe(quiet.threads)
  })

  it('reaches a store subscriber on every change, with the quiet view held through text', () => {
    const store = createWorkspaceStore(opened)
    let calls = 0
    const stop = store.subscribe(() => { calls += 1 })
    store.update((state) => apply(state, running, delta('Hello')))
    const quiet = store.quiet()
    store.update((state) => apply(state, delta(' world')))
    expect(calls).toBe(2)
    expect(store.quiet()).toBe(quiet)
    expect(streamedMessages(store.get().threads.work!.liveTurns[0])[0]?.text).toBe('Hello world')
    // An update that changes nothing notifies nobody.
    store.update((state) => state)
    expect(calls).toBe(2)
    stop()
    store.update((state) => apply(state, delta('!')))
    expect(calls).toBe(2)
  })

  it('hands a live reader its own thread, held while another chat streams', () => {
    const store = createWorkspaceStore(opened)
    store.update((state) => apply(state, running, delta('Hello')))
    const other = liveThreadOf(store, 'other')
    const work = liveThreadOf(store, 'work')
    store.update((state) => apply(state, delta(' world')))
    expect(liveThreadOf(store, 'other')).toBe(other)
    expect(liveThreadOf(store, 'work')).not.toBe(work)
    expect(streamedMessages(liveThreadOf(store, 'work').liveTurns[0])[0]?.text).toBe('Hello world')
    expect(liveThreadOf(store, 'missing')).toBe(emptyThread)
    expect(liveThreadOf(store, null)).toBe(emptyThread)
    expect(liveThreadOf(NO_LIVE_WORKSPACE, 'work')).toBe(emptyThread)
  })

  // A screen places a row by the quiet rows and a list draws the live ones, so the two
  // must agree on which rows there are, steered turn and DM included.
  it.each(['dm', 'project'] as const)('builds the same rows from the quiet and the live %s thread', (kind) => {
    const steer: ServerMessage = {
      type: 'event',
      chatId: 'work',
      event: { id: 'u2', ts: 6, type: 'user_message', text: 'And shorter', mentions: [], steersTurnId: 't1', steerAfter: { messageId: 'm1', textOffset: 5 } },
    }
    const live = apply(
      opened,
      { type: 'event', chatId: 'work', event: { id: 'u1', ts: 1, type: 'user_message', text: 'Write it', mentions: [] } },
      running,
      { type: 'event', chatId: 'work', event: { id: 'e1', ts: 4, type: 'tool_use', turnId: 't1', agentId: 'sage', toolCallId: 'c1', tool: 'Read', detail: 'a.ts' } },
      delta('Hello there'),
      steer,
      delta(', and more', 'm2'),
    )
    const liveRows = rowsOf(live.threads.work!, kind)
    const quietRows = rowsOf(createQuietWorkspace()(live).threads.work!, kind)
    expect(quietRows.map((row) => `${row.kind}:${row.key}`)).toEqual(liveRows.map((row) => `${row.kind}:${row.key}`))
    expect(liveRows.some((row) => row.kind === 'turn')).toBe(true)
  })
})
