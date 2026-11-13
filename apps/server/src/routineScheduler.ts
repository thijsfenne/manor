import {
  contextWindowFor,
  SINGLE_CHAT_VOICE,
  ROUTINE_CONTEXT_WARN_FRACTION,
  ROUTINE_LEASE_MS,
  type Chat,
  type Routine,
  type RoutineEndState,
  type ThreadEvent,
} from '@manor/contracts'
import { formatMoment, intervalAfter } from './routineSchedule.js'
import type { ClaimedRoutine, Store } from './store.js'
import { singleRoutineRuntime } from './singleChat.js'
import { routineDidNotFinish } from './composer.js'
import { alreadyExplainedRoutineFailure, oneTimeSucceeded, runWantsAttention } from './routineHistory.js'

/**
 * How often the scheduler looks for a due routine. Half a minute, because the claim
 * is one indexed select and one conditional update: cheap enough that the tick is
 * not worth reasoning about, fine-grained enough that "07:00" means 07:00 and not
 * "some time in the next quarter hour".
 */
export const ROUTINE_TICK_INTERVAL_MS = 30 * 1000

/**
 * The widest a missed run may be and still fire. A laptop that sleeps does not run
 * cron, so a 07:00 routine in practice fires shortly after the lid opens — this is
 * the number that decides how long after 07:00 that stops being what the user wanted.
 * The window is half the routine's own interval, capped here, which is why a
 * five-minute routine gets two and a half minutes and a daily one gets two hours
 * without anybody answering a knob per routine.
 */
export const MAX_ROUTINE_GRACE_MS = 2 * 60 * 60 * 1000

/** Failed runs in a row before Manor turns a routine off itself. */
export const ROUTINE_FAILURE_LIMIT = 3

export interface RoutineSchedulerOptions {
  store: Store
  /**
   * Runs one routine's turn, all the way to done, in its project run thread or its
   * continuing direct message.
   * In `main.ts` this is the orchestrator's routine seam; a test passes a stand-in,
   * which is what lets the grace window and the failure counter be driven without a
   * driver. The chat is passed explicitly so both target shapes share this seam.
   */
  runTurn: (routine: Routine, chatId: string) => Promise<void>
  /**
   * Called once the claim is won, before the turn starts. The row now says it is
   * running and every open client should hear that at the start of a long turn
   * rather than at the end of it, which is also what keeps a second Run now click
   * from being offered at all.
   */
  onClaimed?: (routine: Routine) => void | Promise<void>
  /**
   * Called once this run's thread exists, before the turn starts.
   *
   * A run makes a chat, and a chat nobody was told about is a chat that is not there:
   * the events of the turn stream into a thread the client has no row for, so the work
   * happens invisibly until something else makes it re-read the directory. This is the
   * telling, and it has to happen at creation rather than at the end, because the whole
   * point of a long run is watching it.
   */
  onRunCreated?: (chat: Chat) => void | Promise<void>
  /**
   * Called after a notifying result, with this fire's real start for notice gating.
   * `alert` marks a one-time fire, which nobody watched start and which must reach
   * the user however short it was.
   */
  onRunFinished?: (chat: Chat, startedAt: number, alert: boolean) => void | Promise<void>
  /**
   * A visible line in a chat, for a one-time routine that ends without a turn (it
   * expired while the Mac slept). `main.ts` routes it through the orchestrator so
   * open clients see it; absent, the line is only written to the store.
   */
  postNote?: (chatId: string, text: string) => Promise<void>
  /** Overridable so a test can place a run without touching the clock. */
  now?: number
}

/**
 * Tells the clients a run has begun, and never stops it.
 *
 * The claim already happened when this is reached: the slot is rolled forward and the
 * lease is taken, so a throw from here that escaped would strand a routine that is
 * owed a turn until its lease expired, having told nobody. The announcement is a
 * nicety — the row is already true in the database — and a nicety may not decide
 * whether the work runs. Logged rather than swallowed, because a client that never
 * hears the start shows a stale Run now button and that should be traceable.
 */
async function announceClaim(options: RoutineSchedulerOptions, routine: Routine): Promise<void> {
  try {
    await options.onClaimed?.(routine)
  } catch (error) {
    console.warn('manor: could not announce the start of routine', routine.id, error)
  }
}

/** The same rule for the run's thread: told, and never at the cost of the run. */
async function announceRun(options: RoutineSchedulerOptions, chat: Chat): Promise<void> {
  try {
    await options.onRunCreated?.(chat)
  } catch (error) {
    console.warn('manor: could not announce the thread of run', chat.id, error)
  }
}

/** Completion notices are auxiliary too: the recorded run is already the truth. */
async function announceFinished(
  options: RoutineSchedulerOptions,
  chat: Chat,
  startedAt: number,
  alert = false,
): Promise<void> {
  try {
    await options.onRunFinished?.(chat, startedAt, alert)
  } catch (error) {
    console.warn('manor: could not announce the end of run', chat.id, error)
  }
}

/** What one tick did, for the caller's log line and for the tests. */
export type RoutineTick =
  | { kind: 'idle' }
  /** Claimed, but too late to be what was asked for; rolled forward, nothing posted. */
  | { kind: 'skipped'; routine: Routine; dueAt: number }
  /** A one-time routine past its `lateUntil`: ended `expired`, with a visible line. */
  | { kind: 'expired'; routine: Routine; dueAt: number }
  | { kind: 'ran'; routine: Routine; ok: boolean; disabled: boolean }

/**
 * One pass of the scheduler: claim a due routine and see it through.
 *
 * Deliberately a plain function rather than a timer, the way `sweepIdleChats` is:
 * the timer in `main.ts` calls it, and so does a test that needs two of them racing.
 * One routine per pass, since the claim is what serialises servers and the next tick
 * is thirty seconds away.
 */
export async function tickRoutines(options: RoutineSchedulerOptions): Promise<RoutineTick> {
  const now = options.now ?? Date.now()
  const claimed = await options.store.claimDueRoutine(now)
  if (claimed === undefined) return { kind: 'idle' }
  return runClaimed(options, claimed, now)
}

/**
 * `run_routine_now`: the same pass, on a routine named by hand.
 *
 * It bypasses the timetable but not the claim, so a hand run that lands in the same
 * second as a tick still runs the routine exactly once — and it goes through
 * `runClaimed` below rather than around it, so a hand run is judged, counted and
 * self-disabled by the rules a scheduled one is.
 */
export async function runRoutineNow(
  options: RoutineSchedulerOptions & { routineId: string },
): Promise<RoutineTick> {
  const now = options.now ?? Date.now()
  await recoverFinishedRoutines(options.store)
  const claimed = await options.store.claimRoutine(options.routineId, now)
  // Nothing to run, and the interesting case is not "no such routine": it is a run
  // this one is already in. The lease is what answers that, and answering with
  // `idle` is what lets the caller say so rather than start a second turn.
  if (claimed === undefined) return { kind: 'idle' }
  await announceClaim(options, claimed.routine)
  // No grace check: the whole point of a hand run is that the user asked for it now.
  return runRoutine(options, claimed, now)
}

/** How long an ended one-time task stays under Earlier before the sweep removes it. */
export const ENDED_ROUTINE_KEEP_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Removes one-time DM tasks that ended more than a month ago. The DM keeps the
 * reminder and its result, so nothing goes that is not also there; the store keeps
 * any routine that still has run threads of its own.
 */
export function purgeEndedRoutines(store: Store, now: number = Date.now()): Promise<number> {
  return store.purgeEndedRoutines(now - ENDED_ROUTINE_KEEP_MS)
}

/**
 * Recover a lost scheduler completion from durable, serialised turn boundaries.
 *
 * A one-time routine also ends here once its lease is dead with nothing to show: the
 * claim already cleared its fire time, so no later tick would ever look at it again,
 * and a crash mid-run would otherwise leave it "running" for good.
 */
export async function recoverFinishedRoutines(store: Store, now: number = Date.now()): Promise<number> {
  let recovered = 0
  for (const routine of await store.listRoutines()) {
    const lease = routine.runningSince
    if (lease === null) continue
    const oneTime = routine.runAt !== null
    const leaseDead = oneTime && now - lease >= ROUTINE_LEASE_MS
    const chatId = routine.chatId ?? (await store.listRuns(routine.id))
      .find((run) => run.createdAt >= lease)?.id
    const events = chatId === undefined ? [] : await store.loadEvents(chatId)
    const prompt = events.findIndex((event) => event.type === 'user_message' &&
      event.source === 'routine' && event.routineId === routine.id && event.ts >= lease)
    if (prompt === -1) {
      if (leaseDead && await endLostOneTime(store, routine, lease, now, chatId)) recovered += 1
      continue
    }
    const ownEvents = events.slice(prompt)
    const ownTurn = ownTurnEvents(ownEvents)
    const answer = resultOf(ownTurn, routine.agentId)
    // A queued message has not begun its own turn and cannot close this run.
    if (answer === undefined && !leaseDead && !ownEvents.slice(1).some(startsAnotherTurn)) continue
    const ok = oneTime ? oneTimeSucceeded(answer, ownTurn, firedName(ownEvents, routine)) : answer !== undefined
    const failures = ok || oneTime ? 0 : routine.consecutiveFailures + 1
    const disabled = failures >= ROUTINE_FAILURE_LIMIT
    const saved = await store.recordRoutineRun(routine.id, {
      lease,
      ...unreadIf(routine, routine.chatId === null ? chatId : events[prompt]?.id, ok, answer),
      ...(advancesWatermark(answer) ? { lastRunAt: lease } : {}),
      consecutiveFailures: failures,
      disabled,
      disabledReason: disabled ? `${ROUTINE_FAILURE_LIMIT} runs in a row ended without an answer.` : null,
      contextTokens: answer?.type === 'turn_result' ? answer.contextTokens ?? null : null,
      ...(oneTime ? { ended: { state: oneTimeEnd(answer, ok), at: now } } : {}),
    })
    if (saved === undefined) continue
    recovered += 1
    if (answer === undefined && chatId !== undefined) await publishRecoveredFailure(store, routine, chatId, ownEvents)
  }
  return recovered
}

/**
 * A one-time fire whose lease died before its prompt was even written: ended
 * `failed`, and said in its DM so it does not just vanish. A project run thread that
 * was never created has nowhere to say it; its row in Routines still reads Failed.
 */
async function endLostOneTime(
  store: Store,
  routine: Routine,
  lease: number,
  now: number,
  chatId: string | undefined,
): Promise<boolean> {
  const saved = await store.recordRoutineRun(routine.id, {
    lease,
    // Only a run thread has a row to show for a fire whose prompt never landed.
    ...(routine.chatId === null && chatId !== undefined ? { unreadRunId: chatId } : {}),
    consecutiveFailures: routine.consecutiveFailures,
    disabled: false,
    disabledReason: null,
    contextTokens: null,
    ended: { state: 'failed', at: now },
  })
  if (saved === undefined) return false
  if (chatId !== undefined) await publishRecoveredFailure(store, routine, chatId, []).catch(() => undefined)
  return true
}

function startsAnotherTurn(event: ThreadEvent): boolean {
  return event.type === 'user_message' && event.dispatchState !== 'pending'
}

/** Events of this fire only. A later started message begins a different turn. */
function ownTurnEvents(ownEvents: readonly ThreadEvent[]): readonly ThreadEvent[] {
  const afterPrompt = ownEvents.slice(1)
  const nextMessage = afterPrompt.findIndex(startsAnotherTurn)
  return nextMessage === -1 ? afterPrompt : afterPrompt.slice(0, nextMessage)
}

/** The name a fire ran under, from its prompt; the failure bubble quotes that, not a later rename. */
function firedName(ownEvents: readonly ThreadEvent[], routine: Routine): string {
  const prompt = ownEvents[0]
  return prompt?.type === 'user_message' ? prompt.routineName ?? routine.name : routine.name
}

function turnIdOf(events: readonly ThreadEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event !== undefined && 'turnId' in event && event.turnId !== undefined) return event.turnId
  }
  return undefined
}

async function publishRecoveredFailure(
  store: Store,
  routine: Routine,
  chatId: string,
  ownEvents: readonly ThreadEvent[],
): Promise<void> {
  const ownTurn = ownTurnEvents(ownEvents)
  const name = firedName(ownEvents, routine)
  if (alreadyExplainedRoutineFailure(ownTurn, name)) return
  if (routine.chatId !== null) {
    await store.appendEvent(chatId, {
      type: 'agent_message',
      agentId: routine.agentId,
      turnId: turnIdOf(ownTurn) ?? `turn_routine_fail_${routine.id}`,
      text: routineDidNotFinish(name),
    })
    return
  }
  await store.appendEvent(chatId, {
    type: 'system_note', kind: 'error', agentId: routine.agentId,
    text: `The earlier run of "${routine.name}" ended without a recorded completion. Its running status has been cleared; later replies belong to a separate turn.`,
  })
}

/** The grace window for one routine: half its own interval, capped. */
export function graceFor(routine: Routine, dueAt: number): number {
  return Math.min(intervalAfter(routine.cron, routine.timezone, dueAt) / 2, MAX_ROUTINE_GRACE_MS)
}

async function runClaimed(
  options: RoutineSchedulerOptions,
  claimed: ClaimedRoutine,
  now: number,
): Promise<RoutineTick> {
  const { routine, dueAt } = claimed
  // A one-time routine has no next slot to wait for, so the grace window below does
  // not apply: a late fire runs once and says it is late, unless the routine named a
  // moment after which running it no longer makes sense.
  if (routine.runAt !== null) {
    if (routine.lateUntil !== null && now > routine.lateUntil) return expireOneTime(options, claimed, now)
    await announceClaim(options, routine)
    return runRoutine(options, claimed, now)
  }
  // Outside the window the run is dropped rather than queued. Many missed slots
  // collapse into this one skip, because the claim already rolled `nextRunAt` to
  // the next future slot; nothing is posted in the chat, and the stamp is what
  // keeps the skip from reading as a run that happened.
  if (now - dueAt > graceFor(routine, dueAt)) {
    await options.store.recordRoutineSkip(routine.id, now, claimed.lease)
    return { kind: 'skipped', routine, dueAt }
  }
  await announceClaim(options, routine)
  return runRoutine(options, claimed, now)
}

/**
 * Runs the turn and writes down how it went.
 *
 * Success is read off the durable transcript rather than plumbed out of the
 * orchestrator, which answers `Promise<void>` by design: a `turn_result` from the
 * target persona appended after the injected message is a run that happened, and its
 * absence — a driver that threw, a turn that timed out, a persona that never
 * finished — is a failure. A turn that finished saying nothing is a success, because
 * "nothing to report" is an answer.
 */
async function runRoutine(
  options: RoutineSchedulerOptions,
  claimed: ClaimedRoutine,
  now: number,
): Promise<RoutineTick> {
  const { store } = options
  const { routine, lease } = claimed
  const oneTime = routine.runAt !== null
  const target = await openTarget(options, routine)
  const cursor = routine.chatId === null || target === undefined
    ? undefined
    : (await store.loadEvents(target.id)).at(-1)?.id

  // A target can disappear after the claim. The foreign key usually deletes the
  // routine with it; recording below then loses its fence harmlessly.
  if (target === undefined) {
    const failures = oneTime ? routine.consecutiveFailures : routine.consecutiveFailures + 1
    const disabled = failures >= ROUTINE_FAILURE_LIMIT
    const saved = await store.recordRoutineRun(routine.id, {
      consecutiveFailures: failures,
      disabled,
      disabledReason: disabled
        ? `${ROUTINE_FAILURE_LIMIT} runs in a row ended without an answer from ${routine.agentId}`
        : null,
      contextTokens: null,
      lease,
      ...(oneTime ? { ended: { state: 'failed' as const, at: options.now ?? Date.now() } } : {}),
    })
    return { kind: 'ran', routine: saved ?? routine, ok: false, disabled: saved?.enabled === false }
  }

  let answer: ThreadEvent | undefined
  let ownTurn: readonly ThreadEvent[] = []
  let promptId: string | undefined
  try {
    await options.runTurn(routine, target.id)
    ;({ promptId, events: ownTurn } = ownTurnOf(await store.loadEvents(target.id), cursor, routine.id))
    answer = resultOf(ownTurn, routine.agentId)
  } catch {
    // A driver error reaches here as a throw. It is one failure, not a reason to
    // stop the tick: the counter below is what eventually turns the routine off.
    answer = undefined
  }
  // A recurring run that answered at all happened. A one-time fire is held to what
  // the user asked for: a published, complete result, never the failure bubble.
  const ok = oneTime ? oneTimeSucceeded(answer, ownTurn, routine.name) : answer !== undefined
  // What the run cost, for the row and for the note below. Null rather than the
  // previous reading when this turn reported none: the field says what the last run
  // cost, and an older number under that label is the one lie it could tell.
  const contextTokens = answer?.type === 'turn_result' ? (answer.contextTokens ?? null) : null

  // A one-time routine ends here either way, so it never counts toward the
  // three-in-a-row disable a recurring one is protected by.
  const failures = ok || oneTime ? 0 : routine.consecutiveFailures + 1
  const disabled = failures >= ROUTINE_FAILURE_LIMIT
  const reason = disabled
    ? `${ROUTINE_FAILURE_LIMIT} runs in a row ended without an answer from ${routine.agentId}`
    : null
  const saved = await store.recordRoutineRun(routine.id, {
    ...(advancesWatermark(answer) ? { lastRunAt: now } : {}),
    // A DM fire is its prompt in the DM; one that never got a prompt has no row.
    ...unreadIf(routine, routine.chatId === null ? target.id : promptId, ok, answer),
    consecutiveFailures: failures,
    disabled,
    disabledReason: reason,
    contextTokens,
    lease,
    ...(oneTime ? { ended: { state: oneTimeEnd(answer, ok), at: options.now ?? Date.now() } } : {}),
  })
  // Nothing was written: the routine is gone, or this run's lease expired and another
  // worker owns the row. Either way the notes below would be about a run nobody is
  // waiting on, and the disable message in particular would name a routine that is
  // not off. Reported as a failed run so the tick's log line says something happened.
  if (saved === undefined) {
    if (routine.notify) await announceFinished(options, target, now, oneTime)
    return { kind: 'ran', routine, ok, disabled: false }
  }
  if (!disabled) await noteExpensiveRun(store, routine, target.id, contextTokens)
  if (disabled) {
    // Said where this routine speaks: its disposable run or its continuing DM.
    await store
      .appendEvent(target.id, {
        type: 'system_note',
        kind: 'error',
        text: `The routine "${routine.name}" is off: ${ROUTINE_FAILURE_LIMIT} runs in a row ended without an answer. Turn it back on once whatever broke it is fixed.`,
        agentId: routine.agentId,
      })
      // A note that cannot be written must not swallow the disable that already
      // landed, which is the half that matters.
      .catch(() => undefined)
  }
  // Notify off means no push and no banner, one-time or not; notify on for a
  // one-time fire also skips the short-turn floor, since its result is the news.
  if (routine.notify) await announceFinished(options, target, now, oneTime)
  return { kind: 'ran', routine: saved, ok, disabled }
}

/**
 * Where this fire speaks: its continuing DM, or a fresh run thread in its project.
 * Undefined when the DM is gone.
 */
async function openTarget(options: RoutineSchedulerOptions, routine: Routine): Promise<Chat | undefined> {
  const { store } = options
  if (routine.chatId !== null) return store.getChat(routine.chatId)
  // Project routines keep their one-thread-per-fire model. Born settled unless the
  // routine asked to be told, which keeps quiet runs out of the inbox. A one-time
  // routine was asked for by name, so its one thread is never born settled.
  const created = await store.createChat({
    projectId: routine.projectId,
    kind: 'run',
    mode: routine.agentId === SINGLE_CHAT_VOICE.id ? 'single' : 'house',
    routineId: routine.id,
    title: routine.name,
    settled: !routine.notify && routine.runAt === null,
  })
  // Only a disposable run thread can take the routine's own pin. A DM uses its
  // existing chat override, so a scheduled turn never mutates later manual turns.
  if (routine.model !== null || routine.effort !== null) {
    await store.setChatOverride(created.id, routine.agentId, {
      ...(routine.agentId === SINGLE_CHAT_VOICE.id ? singleRoutineRuntime(routine) : {}),
      ...(routine.model === null ? {} : { model: routine.model }),
      ...(routine.effort === null ? {} : { effort: routine.effort }),
    })
  }
  const target = await store.getChat(created.id) ?? created
  await announceRun(options, target)
  return target
}

/**
 * The one-time fire's own events, prompt excluded. Read by the success rule, which
 * has to see the failure bubble the turn runner publishes beside a `turn_result`.
 */
function ownTurnOf(
  events: readonly ThreadEvent[],
  cursor: string | undefined,
  routineId: string,
): { promptId: string | undefined; events: readonly ThreadEvent[] } {
  const index = cursor === undefined ? -1 : events.findIndex((event) => event.id === cursor)
  const fresh = events.slice(index + 1)
  const prompt = fresh.findIndex(
    (event) => event.type === 'user_message' && event.source === 'routine' && event.routineId === routineId,
  )
  return prompt === -1
    ? { promptId: undefined, events: [] }
    : { promptId: fresh[prompt]?.id, events: ownTurnEvents(fresh.slice(prompt)) }
}

/** The record field that leaves this run unread, when it waits for the user and has a row. */
function unreadIf(
  routine: Routine,
  runId: string | undefined,
  ok: boolean,
  answer: ThreadEvent | undefined,
): { unreadRunId?: string } {
  const outcome = answer?.type === 'turn_result' ? answer.routineOutcome : undefined
  return runId !== undefined && runWantsAttention(routine, { failed: !ok, outcome }) ? { unreadRunId: runId } : {}
}

/**
 * A one-time routine claimed past its `lateUntil`: ended `expired`, and said where
 * it would have spoken, so a reminder or check slept through never just vanishes.
 */
async function expireOneTime(
  options: RoutineSchedulerOptions,
  claimed: ClaimedRoutine,
  now: number,
): Promise<RoutineTick> {
  const { routine, dueAt, lease } = claimed
  const saved = await options.store.recordRoutineRun(routine.id, {
    consecutiveFailures: routine.consecutiveFailures,
    disabled: false,
    disabledReason: null,
    contextTokens: routine.lastContextTokens,
    lease,
    ended: { state: 'expired', at: now },
  })
  if (saved === undefined) return { kind: 'expired', routine, dueAt }
  const target = await openTarget(options, saved).catch(() => undefined)
  if (target !== undefined) {
    const text = `"${routine.name}" did not run. It was due ${formatMoment(dueAt, routine.timezone)}, Manor was not running until ${formatMoment(now, routine.timezone)}, and it was only useful until ${formatMoment(routine.lateUntil ?? dueAt, routine.timezone)}.`
    // A line that cannot be written must not undo the ended state that already landed.
    await (options.postNote ?? ((chatId: string, note: string) => options.store
      .appendEvent(chatId, { type: 'system_note', kind: 'info', text: note, agentId: routine.agentId })
      .then(() => undefined)))(target.id, text).catch(() => undefined)
  }
  return { kind: 'expired', routine: saved, dueAt }
}

/**
 * The target persona's `turn_result` from after the routine's message went in, or
 * nothing. Its presence is what "the run happened" means; it is handed back rather
 * than reduced to a boolean because the same event carries what the run cost.
 */
/**
 * Whether this run may move the incremental lower bound the next prompt names. An
 * answered run that says it did not read its whole window still counts as answered
 * (no failure, no disable), but it keeps the old watermark so a mail or message that
 * arrived in that window is read next time rather than skipped for good.
 */
function advancesWatermark(answer: ThreadEvent | undefined): boolean {
  return answer?.type === 'turn_result' && answer.routineIncomplete !== true
}

function resultOf(ownTurn: readonly ThreadEvent[], agentId: string): ThreadEvent | undefined {
  return ownTurn.find((event) => event.type === 'turn_result' && event.agentId === agentId)
}

/** How a one-time fire ends: expired when its deadline passed while it queued. */
function oneTimeEnd(answer: ThreadEvent | undefined, ok: boolean): Exclude<RoutineEndState, 'cancelled'> {
  if (answer?.type === 'turn_result' && answer.routineExpired === true) return 'expired'
  return ok ? 'done' : 'failed'
}

/**
 * Says once, in the run's own thread, that one run is filling a context window.
 *
 * This used to read "your thread is getting long, start a fresh chat", which was the
 * right warning while every run appended to one chat. A run now gets its own thread,
 * so nothing accumulates and that advice has nothing left to advise. What the reading
 * still catches is the other shape of the same problem: a single run whose *input* is
 * enormous, which is a prompt to narrow rather than a thread to abandon.
 *
 * Manor cannot see the subscription cap and does not pretend to, so this measures
 * rather than guards: nothing is refused, nothing is truncated, the note is the whole
 * of it. Said on the crossing rather than on every run above the line, so a routine
 * that lives up there does not post the same sentence daily.
 */
async function noteExpensiveRun(
  store: Store,
  routine: Routine,
  chatId: string,
  contextTokens: number | null,
): Promise<void> {
  if (contextTokens === null) return
  const agent = (await store.loadRoster()).find((candidate) => candidate.id === routine.agentId)
  if (agent === undefined) return
  const window = contextWindowFor(agent.driver, agent.model)
  const limit = window * ROUTINE_CONTEXT_WARN_FRACTION
  if (contextTokens < limit) return
  // Already said on an earlier run, and still true. Read off the row as it stood
  // before this run, which is exactly what `lastContextTokens` still holds here.
  if (routine.lastContextTokens !== null && routine.lastContextTokens >= limit) return
  await store
    .appendEvent(chatId, {
      type: 'system_note',
      kind: 'info',
      text: `This run of "${routine.name}" used ${compact(contextTokens)} of ${agent.name}'s ${compact(window)} token context. One run, so nothing is accumulating; a reading this high means the instruction is asking for a lot at once and is the thing to narrow.`,
      agentId: routine.agentId,
    })
    // A note that cannot be written must not fail the run it is about.
    .catch(() => undefined)
}

const compact = (tokens: number): string =>
  new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 0 }).format(tokens)
