import { SUBAGENT_VOICE, lostConnectionNote, type AgentConfig, type ThreadEvent } from '@manor/contracts'
import type { Store } from './store.js'

/**
 * A turn whose events stop without ever saying how it ended.
 *
 * The orchestrator guarantees a terminal event for anything that can be caught
 * inside the process. This is the other half: a process that is killed writes
 * nothing at all, so a restart, a crash or a reboot leaves the last turn hanging
 * with no `turn_result` and no note. Nothing inside that process can report it,
 * which is why the report happens on the way back up.
 */
export interface UnterminatedTurn {
  turnId: string
  agentId: string
  /** Timestamp of the last thing the turn managed to record. */
  lastTs: number
}

/**
 * The turn ended on the record: a result, or a note that was not the mid-turn "hit a
 * problem and carried on" kind.
 */
const isEnd = (event: ThreadEvent): boolean =>
  event.type === 'turn_result' || (event.type === 'system_note' && event.kind !== 'info')

/**
 * Every turn in one chat's transcript that never accounted for itself.
 *
 * A turn that spoke also counts as accounted for, because of what this note is for.
 * The defect being closed is a turn that left the user with nothing, so a turn that said
 * its piece needs no explanation even if it never reached a `turn_result`. Without
 * this the sweep claimed 35 hanging turns on the real transcript, almost all of them
 * old turns from before `turn_result` existed that had answered perfectly well. The
 * exception is background work it started that never reported its end: the answer
 * promised that work, and the restart took it down.
 */
export function unterminatedTurns(events: readonly ThreadEvent[]): UnterminatedTurn[] {
  const turns = new Map<string, UnterminatedTurn & { ended: boolean; spoke: boolean; background: Set<string> }>()

  for (const event of events) {
    const turnId = 'turnId' in event ? event.turnId : undefined
    const agentId = 'agentId' in event ? event.agentId : undefined
    if (turnId === undefined || agentId === undefined) continue
    let turn = turns.get(turnId)
    if (turn === undefined) {
      turn = { turnId, agentId, lastTs: event.ts, ended: false, spoke: false, background: new Set() }
      turns.set(turnId, turn)
    }
    if (turn.ended) continue
    if (isEnd(event)) {
      turn.ended = true
      continue
    }
    turn.lastTs = event.ts
    if (event.type === 'agent_message') turn.spoke = true
    else if (event.type === 'tool_use' && event.background === true && event.toolCallId !== undefined) turn.background.add(event.toolCallId)
    else if (event.type === 'tool_result') turn.background.delete(event.toolCallId)
  }

  return [...turns.values()]
    .filter((turn) => !turn.ended && (!turn.spoke || turn.background.size > 0))
    .map(({ turnId, agentId, lastTs }) => ({ turnId, agentId, lastTs }))
}

/** A background launch whose work never reported its end. */
export interface OpenBackgroundRow {
  turnId: string
  agentId: string
  toolCallId: string
  title: string
}

/**
 * Background launches still open in a chat's transcript. Since background work may
 * outlive its turn in a live session, a finished turn can hold one; a restart took
 * that process down, so nothing will ever settle it.
 */
export function openBackgroundRows(events: readonly ThreadEvent[]): OpenBackgroundRow[] {
  const open = new Map<string, OpenBackgroundRow>()
  /** Calls launched as background work: only those reopen when announced again after their end. */
  const background = new Set<string>()
  const ended = new Set<string>()
  for (const event of events) {
    if (event.type === 'tool_use' && event.background === true && event.toolCallId !== undefined &&
      event.turnId !== undefined && event.agentId !== undefined) {
      // Codex announces a row as background at its turn's answer; one that already ended stays ended.
      if (ended.has(event.toolCallId) && !background.has(event.toolCallId)) continue
      background.add(event.toolCallId)
      open.set(event.toolCallId, {
        turnId: event.turnId, agentId: event.agentId, toolCallId: event.toolCallId,
        title: event.subagent?.title ?? event.subject ?? event.detail ?? event.tool,
      })
    } else if (event.type === 'tool_result') {
      open.delete(event.toolCallId)
      ended.add(event.toolCallId)
    }
  }
  return [...open.values()]
}

const quoted = (titles: readonly string[]) => titles.map((title) => `\u201c${title}\u201d`).join(', ')

/** Why a row's background work settled as stopped on the way back up. */
export const lostBackgroundNote = (name: string, titles: readonly string[]): string =>
  `Manor restarted, so ${name}'s background work stopped: ${quoted(titles)}.`

/**
 * Background work whose provider cannot keep it past the turn or say whether it already
 * finished, so the note claims only what Manor did.
 */
export const endedBackgroundNote = (name: string, titles: readonly string[]): string =>
  `${name}'s turn ended, so Manor stopped any background work still running from it: ${quoted(titles)}.`

/** The same moment when Manor's stop could not be confirmed, so it claims no stop. */
export const unconfirmedBackgroundNote = (name: string, titles: readonly string[]): string =>
  `${name}'s turn ended. Manor tried to stop background work still running from it but could not confirm it stopped: ${quoted(titles)}.`

/**
 * What the transcript says about a turn that was cut off mid-flight.
 *
 * Deliberately not "aborted" or "failed". On 2026-08-08 a turn died this way while
 * its CLI child kept running as an orphan: every file it was writing landed, the
 * tests it started passed, and only the reply went into a socket nobody held. A note
 * claiming the work did not happen would have been the more expensive lie of the two.
 */
export { lostConnectionNote }

/**
 * Transcripts read at once by the boot sweep. Eight is a compromise with one obvious
 * failure on either side: one is the 2,4 s of dead boot time this replaces, and all of
 * them at once is a database spike at the worst possible moment for it.
 */
export const SWEEP_CONCURRENCY = 8

type WaitingInput = Extract<ThreadEvent, { type: 'user_message' }>
export type RecoveryInputs = ReadonlyMap<string, readonly WaitingInput[]>

export interface SweepOptions {
  store: Store
  /** The roster, for turning an agent id into the name the note reads with. */
  agents: readonly AgentConfig[]
  /** Reports what was closed, so a boot that swept something says so out loud. */
  onSwept?: (count: number) => void
  /** Reuses this boot read when recovering durable waiting input. */
  onRecoveryInputs?: (chatId: string, events: readonly WaitingInput[]) => void
}

/**
 * Closes every turn left hanging by the previous process, before the server accepts
 * a connection. Running it first is the whole point: a client that connects earlier
 * would render the honest snapshot and then watch it change under it, which is the
 * same "it was there a second ago" defect as showing nothing.
 *
 * Every chat is read, not just the recently active ones. Manor is single-user with a
 * handful of chats, a swept turn carries a note and is never swept twice, and the
 * alternative is a cutoff that decides some old crash is not worth explaining.
 */
export async function sweepUnterminatedTurns({ store, agents, onSwept, onRecoveryInputs }: SweepOptions): Promise<number> {
  const named = new Map([...agents.map((agent) => [agent.id, agent.name] as const), [SUBAGENT_VOICE.id, SUBAGENT_VOICE.name] as const])
  const chats = await store.listChats()
  let swept = 0

  const sweepChat = async (chatId: string): Promise<number> => {
    const events = await store.loadEvents(chatId)
    onRecoveryInputs?.(chatId, events.filter((event): event is WaitingInput =>
      event.type === 'user_message' && event.source === undefined &&
      (event.dispatchState === 'started' || event.dispatchState === 'pending')))
    let closed = 0
    // Serial within one chat: appends to a single chat are serialised anyway, and
    // this is the order the notes are written in.
    for (const turn of unterminatedTurns(events)) {
      await store.appendEvent(chatId, {
        type: 'system_note',
        kind: 'aborted',
        text: lostConnectionNote(named.get(turn.agentId) ?? turn.agentId),
        agentId: turn.agentId,
        turnId: turn.turnId,
      })
      closed += 1
    }
    // Rows a live session would have settled: each closes as stopped, one note per persona.
    const lost = openBackgroundRows(events)
    for (const row of lost) {
      await store.appendEvent(chatId, { type: 'tool_result', turnId: row.turnId, agentId: row.agentId, toolCallId: row.toolCallId, outcome: 'stopped' })
    }
    for (const agentId of new Set(lost.map((row) => row.agentId))) {
      await store.appendEvent(chatId, {
        type: 'system_note', kind: 'info', agentId,
        text: lostBackgroundNote(named.get(agentId) ?? agentId, lost.filter((row) => row.agentId === agentId).map((row) => row.title)),
      })
      closed += 1
    }
    return closed
  }

  // A few chats at a time rather than one, because every boot pays this before the
  // server listens: forty chats at ~60 ms each is ~2,4 s of dead time. Bounded rather
  // than a plain `Promise.all` over every chat, which would trade that for an
  // unbounded burst of transcript reads at the moment the process can least absorb
  // one, and each of those reads can now be several pages of its own.
  let cursor = 0
  const workers = Array.from({ length: Math.min(SWEEP_CONCURRENCY, chats.length) }, async () => {
    for (;;) {
      const chat = chats[cursor]
      cursor += 1
      if (chat === undefined) return
      const closed = await sweepChat(chat.id)
      // Read and written after the await, never `swept += await …`, which would read
      // the old value before yielding and lose every concurrent worker's count.
      swept += closed
    }
  })
  await Promise.all(workers)

  if (swept > 0) onSwept?.(swept)
  return swept
}
