import {
  ROUTINE_HISTORY_LIMIT,
  ROUTINE_LEASE_MS,
  ROUTINE_RESULT_MAX_CHARS,
  type Routine,
  type RoutineRun,
  type ThreadEvent,
} from '@manor/contracts'
import { routineDidNotFinish } from './composer.js'
import type { Store } from './store.js'

interface OpenRun {
  id: string
  chatId: string | null
  startedAt: number
  /** The target persona's last `turn_result` inside this boundary. */
  result: ThreadEvent | undefined
  /** Everything after the prompt, for the one-time success rule. */
  events: ThreadEvent[]
  /** The name the fire ran under, which its failure bubble quotes; a rename is later. */
  name: string
}

/** The one-bubble failure, or an error note, inside one fire's own events. */
export function alreadyExplainedRoutineFailure(events: readonly ThreadEvent[], name: string): boolean {
  const text = routineDidNotFinish(name)
  return events.some((event) =>
    (event.type === 'system_note' && event.kind === 'error') ||
    (event.type === 'agent_message' && event.text === text),
  )
}

/**
 * Done, for a one-time fire, means a published, complete result. A quiet, incomplete
 * or expired outcome, or a turn that closed on the one-bubble failure, did not do
 * what was asked, and there is no next run to make up for it. The scheduler ends the
 * row by this rule and the DM history draws by it, so the two cannot disagree.
 */
export function oneTimeSucceeded(
  answer: ThreadEvent | undefined,
  ownTurn: readonly ThreadEvent[],
  name: string,
): boolean {
  if (answer?.type !== 'turn_result') return false
  if (answer.routineOutcome === 'quiet' || answer.routineIncomplete === true || answer.routineExpired === true) return false
  return !alreadyExplainedRoutineFailure(ownTurn, name)
}

/**
 * Whether a finished run waits for the user. Only a routine that asks to be told
 * lights anything; there a failure always does and a result only when the run
 * published one, an incomplete run included, since it carries `publish` beside its
 * flag. A quiet run, or one that declared no outcome, never does. With `notify` off a failure
 * still reads as Failed on the status line, it just leaves no dot. The client's
 * `runHasResult` shows every run this lets through, so every dot can clear.
 */
export function runWantsAttention(
  routine: Pick<Routine, 'notify'>,
  run: { failed: boolean; outcome: 'quiet' | 'publish' | undefined },
): boolean {
  if (!routine.notify) return false
  return run.failed || run.outcome === 'publish'
}

/**
 * What a run said, or why it failed: the persona's messages after its last tool
 * call, which is the answer a thread shows below the fold, and any error line.
 * Narration between tool calls stays in the thread.
 */
function resultOf(events: readonly ThreadEvent[], agentId: string): Pick<RoutineRun, 'result' | 'truncated'> {
  let lastTool = -1
  events.forEach((event, index) => {
    if (event.type === 'tool_use' || event.type === 'tool_result') lastTool = index
  })
  const text = events.flatMap((event, index) =>
    (event.type === 'agent_message' && event.agentId === agentId && index > lastTool) ||
    (event.type === 'system_note' && event.kind === 'error')
      ? [event.text.trim()]
      : [],
  ).filter((part) => part.length > 0).join('\n\n')
  if (text.length === 0) return { result: null }
  if (text.length <= ROUTINE_RESULT_MAX_CHARS) return { result: text }
  return { result: `${text.slice(0, ROUTINE_RESULT_MAX_CHARS - 1).trimEnd()}…`, truncated: true }
}

/**
 * Every fire of `routine` in one transcript, oldest first, before the lease is read.
 *
 * Started user messages are the turn boundaries the orchestrator serialises on. A target
 * `turn_result` inside one boundary makes that fire done; once the boundary has
 * ended, its absence makes it failed. In a run thread the same rule keeps a reply
 * the user typed afterwards out of the run's result.
 */
function firesIn(routine: Routine, events: readonly ThreadEvent[], chatId: string): RoutineRun[] {
  const runs: RoutineRun[] = []
  let open: OpenRun | undefined

  const finishOpen = () => {
    if (open === undefined) return
    const { result } = open
    const ok = routine.runAt === null
      ? result !== undefined
      : oneTimeSucceeded(result, open.events, open.name)
    const outcome = result?.type === 'turn_result' ? result.routineOutcome : undefined
    runs.push({
      id: open.id,
      chatId: open.chatId,
      startedAt: open.startedAt,
      state: ok ? 'done' : 'failed',
      ...(outcome === undefined ? {} : { outcome }),
      ...resultOf(open.events, routine.agentId),
    })
    open = undefined
  }

  for (const event of events) {
    if (event.type === 'user_message') {
      if (event.dispatchState === 'pending') continue
      finishOpen()
      if (event.source === 'routine' && event.routineId === routine.id) {
        open = { id: event.id, chatId, startedAt: event.ts, result: undefined, events: [], name: event.routineName ?? routine.name }
      }
      continue
    }
    if (open === undefined) continue
    open.events.push(event)
    // The last result in the boundary is the run's.
    if (event.type === 'turn_result' && event.agentId === routine.agentId) open.result = event
  }
  finishOpen()
  return runs
}

/**
 * The routine lease overrides the newest fire to running while the scheduler still
 * owns it, including the few milliseconds before its prompt reaches a transcript.
 * `runs` is oldest first.
 */
function withLease(routine: Routine, runs: RoutineRun[], now: number): RoutineRun[] {
  const runningSince = routine.runningSince
  if (runningSince === null || now - runningSince >= ROUTINE_LEASE_MS) return runs
  let index = -1
  for (let candidate = runs.length - 1; candidate >= 0; candidate -= 1) {
    if ((runs[candidate]?.startedAt ?? -Infinity) < runningSince) continue
    index = candidate
    break
  }
  if (index === -1) {
    return [...runs, {
      id: `lease:${routine.id}:${runningSince}`,
      chatId: routine.chatId,
      startedAt: runningSince,
      state: 'running',
      result: null,
    }]
  }
  return runs.map((run, at) => at === index ? { ...run, state: 'running' } : run)
}

/** The newest runs, plus any older one still unread so every unread run has a row. */
function shown(routine: Routine, newestFirst: readonly RoutineRun[]): RoutineRun[] {
  const unread = new Set(routine.unreadRunIds)
  return newestFirst.filter((run, index) => index < ROUTINE_HISTORY_LIMIT || unread.has(run.id))
}

/** The execution history of a routine that speaks in a continuing DM, newest first. */
export function dmRoutineHistory(
  routine: Routine,
  events: readonly ThreadEvent[],
  now: number = Date.now(),
): RoutineRun[] {
  const chatId = routine.chatId ?? ''
  return shown(routine, withLease(routine, firesIn(routine, events, chatId), now).reverse())
}

/**
 * One routine's history, newest first, whichever target it has. A project routine's
 * runs are its threads, one fire each; a thread whose prompt never landed failed
 * before it began, unless the lease says it is only just starting.
 */
export async function routineRuns(store: Store, routine: Routine, now: number = Date.now()): Promise<RoutineRun[]> {
  if (routine.chatId !== null) return dmRoutineHistory(routine, await store.loadEvents(routine.chatId), now)
  const unread = new Set(routine.unreadRunIds)
  const threads = (await store.listRuns(routine.id))
    .filter((chat, index) => index < ROUTINE_HISTORY_LIMIT || unread.has(chat.id))
  const runs = await Promise.all(threads.map(async (chat): Promise<RoutineRun> => {
    const fire = firesIn(routine, await store.loadEvents(chat.id), chat.id)[0]
    return fire === undefined
      ? { id: chat.id, chatId: chat.id, startedAt: chat.createdAt, state: 'failed', result: null }
      : { ...fire, id: chat.id }
  }))
  return shown(routine, withLease(routine, runs.reverse(), now).reverse())
}
