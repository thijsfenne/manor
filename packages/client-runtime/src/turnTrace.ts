import { EFFORTS, driverForModel, modelLabel, type FileEdit, type SubagentLaunch, type SubagentSummary, type ThreadEvent } from '@manor/contracts'
import { emptyThread, isToolStep, liveWritten, type ReasoningStep, type Row, type ToolStep, type TurnActivity as TurnStep, type TurnRow, type TurnSegment } from './state'
import { activityDetail, activityKind, currentLabel, elapsedLabel, searchQuery, isBrowserTool, isMemoryWrite, isTaskTool, settledLabel, shortTarget, workedLabel } from './turnLabels'
import { waitingOn } from './sessionStatus'
import type { ThreadShape } from './quietState'
import { isCompacting, LIVE_COMPACT_DONE, LIVE_COMPACT_FAILED, LIVE_COMPACT_NOTE, LIVE_COMPACT_STOPPED } from './compacting'

export { isCompacting, LIVE_COMPACT_DONE, LIVE_COMPACT_FAILED, LIVE_COMPACT_NOTE, LIVE_COMPACT_STOPPED }
export const COMPACTING_STATUS = 'Compacting the session'

const COMPACT_NOTES = new Set([
  LIVE_COMPACT_NOTE,
  LIVE_COMPACT_DONE,
  LIVE_COMPACT_FAILED,
  LIVE_COMPACT_STOPPED,
])

/**
 * What a turn says about itself, apart from how it is drawn.
 *
 * It lives outside both components that need it because the turn's status and the
 * turn's trace are now two rows owned by two different parents — the line beside the
 * persona's name, and the list under it. One of them counting the steps differently
 * than the other is the failure this module exists to make impossible.
 */

/**
 * Drops empty work runs without changing the activity record inside a real run.
 *
 * Shell calls used to disappear here because their raw commands were noisy. Activity
 * bundles make that trade-off obsolete: the closed line says only "ran a command"
 * and the exact call stays available inside the capped accordion with the reads and
 * edits around it. Filtering it here would make that accordion an incomplete record.
 */
export function shownSegments(segments: TurnSegment[]): TurnSegment[] {
  return segments.flatMap<TurnSegment>((segment) => {
    if (segment.kind !== 'work') return [segment]
    return segment.steps.length === 0 ? [] : [segment]
  })
}

/**
 * One activity bundle keeps the identity of its first call while that call moves
 * from the live work projection into the landed-edits projection. The segment key
 * itself cannot do that: work prefixes it and edits do not, which remounted an open
 * accordion at the exact moment its current call completed.
 */
export function activityBundleKey(segment: Extract<TurnSegment, { kind: 'work' | 'edits' }>): string {
  const first = segment.kind === 'work' ? segment.steps[0]?.key : segment.key
  return `bundle:${first ?? segment.key}`
}

interface ActivityBundle {
  kind: 'bundle'
  key: string
  steps: TurnStep[]
  edits: FileEdit[]
  /** Steps that came right after a landed edit; an opened run never groups across one. */
  breaks: Set<string>
}

/** The subagents one activity run started, standing right after that run. */
interface SubagentBlock {
  kind: 'subagents'
  key: string
  agents: ToolStep[]
}

export type ActivityBlock = Exclude<TurnSegment, { kind: 'work' | 'edits' }> | ActivityBundle | SubagentBlock

export const isSubagentStep = (step: TurnStep): step is ToolStep =>
  isToolStep(step) && isTaskTool(step.tool) && step.parentToolCallId === undefined

/** The steps a subagent took, in order. Empty where the runtime reports none. */
export const subagentSteps = (activities: readonly TurnStep[], parent: ToolStep): TurnStep[] =>
  parent.toolCallId === undefined ? [] : activities.filter((step) => (step.kind === 'tool' || step.kind === 'reasoning') && step.parentToolCallId === parent.toolCallId)

/**
 * What a working subagent is doing right now, in the trace's own words. Only a call
 * still open counts: a finished read is what it did, not what it is doing.
 */
export function subagentNow(steps: readonly TurnStep[]): string | undefined {
  const open = [...steps].reverse().find((step): step is ToolStep => isToolStep(step) && step.status === 'running')
  return open === undefined ? undefined : currentLabel(open)
}

/**
 * Adjacent work and landed edits belong to the same act until narration cuts it.
 *
 * A subagent call leaves the bundle for a block of its own beside it. The bundle
 * folds to one line, and a helper that works for minutes behind "Used tools" is
 * exactly the invisible work the block exists to show.
 */
export function activityBlocks(segments: TurnSegment[]): ActivityBlock[] {
  const blocks: ActivityBlock[] = []
  let bundle: ActivityBundle | undefined
  for (const segment of segments) {
    if (segment.kind === 'work' || segment.kind === 'edits') {
      if (bundle === undefined) {
        bundle = { kind: 'bundle', key: activityBundleKey(segment), steps: [], edits: [], breaks: new Set() }
        blocks.push(bundle)
      }
      if (segment.kind === 'work') {
        bundle.steps.push(...segment.steps)
        for (const key of segment.breaks ?? []) bundle.breaks.add(key)
      } else bundle.edits.push(...segment.edits)
      continue
    }
    bundle = undefined
    blocks.push(segment)
  }
  return blocks.flatMap<ActivityBlock>((block) => {
    if (block.kind !== 'bundle') return [block]
    const agents = block.steps.filter(isSubagentStep)
    if (agents.length === 0) return [block]
    const rest: TurnStep[] = []
    const breaks = new Set<string>()
    let pending = false
    for (const step of block.steps) {
      // A break on a helper call moves to the next step that stays in the run.
      if (block.breaks.has(step.key)) pending = true
      if (isSubagentStep(step)) continue
      if (pending) breaks.add(step.key)
      pending = false
      rest.push(step)
    }
    const own: SubagentBlock = { kind: 'subagents', key: `agents:${block.key}`, agents }
    return rest.length === 0 && block.edits.length === 0 ? [own] : [{ ...block, steps: rest, breaks }, own]
  })
}

/**
 * The call a running turn is making right now, and the run it stands in: the newest
 * top-level call of the last run, until narration or a reply closes that run. Only
 * this call shimmers. A compaction is not the call, so while one runs nothing here is
 * active and Compacting stands alone; the call reads live again once the work resumes.
 * A subagent as the newest call means the run waits on it, and background work returned
 * at once: neither is what the run is doing, so neither counts.
 */
export function activeCall(turn: TurnRow, blocks: readonly ActivityBlock[]): { key: string; tool: ToolStep } | undefined {
  if (turn.live?.state !== 'running' || isCompacting(turn)) return undefined
  if (liveWritten(turn.live)) return undefined
  // A subagent block stands after the run that started it, so the run is one back.
  const tail = blocks.at(-1)
  const last = tail?.kind === 'subagents' ? blocks.at(-2) : tail
  if (last?.kind !== 'bundle') return undefined
  // Landed edit calls move from `steps` into the bundle's file evidence; the turn's
  // activity record keeps the call itself, so the newest call comes from there.
  if (last.edits.length === 0 && !last.steps.some((step) => step.kind === 'tool')) return undefined
  const tool = [...turn.activities].reverse().find((step): step is ToolStep => step.kind === 'tool' && step.parentToolCallId === undefined)
  if (tool === undefined || tool.background === true || isSubagentStep(tool)) return undefined
  return { key: last.key, tool }
}

export type SubagentState = 'running' | 'done' | 'failed' | 'stopped'

/** `unconfirmed` means the turn ended around the call, so "done" would be a guess. */
export function subagentState(step: ToolStep): SubagentState {
  if (step.status === 'running') return 'running'
  if (step.status === 'stopped') return 'stopped'
  if (step.status === 'error') return 'failed'
  return step.unconfirmed === true ? 'stopped' : 'done'
}

export const SUBAGENT_STATE_LABEL: Record<SubagentState, string> = {
  running: 'Working',
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped',
}

/**
 * Where a subagent stands in its own view's bar: a clock while it works, the time it
 * took once it is done, and a plain word otherwise. Waiting means the user owes it an
 * answer in the parent; there is nothing to do here.
 */
export function subagentBarStatus(state: SubagentState, timing: { startedAt: number; endedAt?: number | undefined; asking: boolean }, now: number): string {
  if (state === 'running') return timing.asking ? 'Waiting' : `Working ${elapsedLabel(timing.startedAt, now)}`
  if (state === 'done' && timing.endedAt !== undefined) return `Done in ${elapsedLabel(timing.startedAt, timing.endedAt)}`
  return SUBAGENT_STATE_LABEL[state]
}

/** Model and effort as a subagent's bar and facts show them; absent where the launch named no model. */
export function subagentRuntime(driver: SubagentSummary['driver'] | undefined, model: string | undefined, effort: string | undefined): { model: string; effort?: string } | undefined {
  if (driver === undefined || driver === 'mock' || model === undefined) return undefined
  const level = EFFORTS.find((option) => option.value === effort)?.label ?? effort
  return { model: modelLabel(driver, model), ...(level === undefined ? {} : { effort: level }) }
}

/**
 * Whether Manor itself runs this helper and can stop it alone. A provider's native
 * subagent only stops with its parent turn. The `subagent_` call id is minted by the
 * server's delegate route (`subagents.ts`) and nowhere else; `codex_` is the retired
 * Codex helper, kept so its settled cards still read as Manor-run.
 */
export const isManorSubagent = (step: ToolStep): boolean =>
  step.toolCallId?.startsWith('subagent_') === true || step.toolCallId?.startsWith('codex_') === true

/**
 * The provider a helper ran on: the one Manor stamped on its launch, or for a launch
 * stored before that, the one its model belongs to.
 */
export const launchDriver = (launch: SubagentLaunch | undefined) =>
  launch?.driver ?? (launch?.model === undefined ? undefined : driverForModel(launch.model))

/** "Subagent, GPT-6.1 Sol, High", as far as the launch itself reported it. */
export function subagentKindLine(step: ToolStep): string {
  const { model, effort } = step.subagent ?? {}
  const driver = launchDriver(step.subagent)
  return [
    'Subagent',
    ...(model === undefined ? [] : [driver === undefined ? model : modelLabel(driver, model)]),
    ...(effort === undefined ? [] : [EFFORTS.find((option) => option.value === effort)?.label ?? effort]),
  ].join(', ')
}

/** What the brief says, or an honest fallback when the provider sent none. */
export const subagentTask = (step: ToolStep): string => step.subagent?.title ?? step.subject ?? step.detail ?? 'Subagent'

export interface ChatSubagent {
  step: ToolStep
  /** Its own steps, reported by the runtime under this call's id. */
  steps: TurnStep[]
  turnKey: string
  agentId: string
  /** The turn that launched it is still going. */
  turnRunning: boolean
}

/** Every subagent in a chat, newest first, which is the order the rail lists them in. */
export function chatSubagents(rows: readonly Row[]): ChatSubagent[] {
  return rows
    .flatMap((row) => row.kind !== 'turn' ? [] : row.activities
      .filter(isSubagentStep)
      .map((step) => ({ step, steps: subagentSteps(row.activities, step), turnKey: row.key, agentId: row.agentId, turnRunning: row.live?.state === 'running' })))
    .reverse()
}

/**
 * Where a helper stands. A Manor child outlives the turn that started it, and its
 * launch row only learns how it ended when the result is written back, so the
 * directory's word (`summary`) comes first while the child is listed.
 */
export const subagentStateOf = (subagent: ChatSubagent, summary?: (childId: string) => SubagentSummary | undefined): SubagentState =>
  subagentStepState(subagent.step, subagent.turnRunning, summary)

/** `subagentStateOf` for a launch row read inside its turn, where `turnRunning` is that turn's own state. */
export function subagentStepState(step: ToolStep, turnRunning: boolean, summary?: (childId: string) => SubagentSummary | undefined): SubagentState {
  const launch = subagentState(step)
  const childId = step.subagent?.childChatId
  if (childId === undefined || summary === undefined) return launch
  const listed = summary(childId)?.state
  if (listed !== undefined) return listed === 'cancelled' ? 'stopped' : listed
  // Every running child is listed, bar the moment between its launch row and the next
  // directory, so past its turn a launch row still saying running only missed its end.
  return launch === 'running' && !turnRunning ? 'stopped' : launch
}

/**
 * One helper as the parent's timeline row draws it: its brief over one line of detail,
 * then where it stands and how long it took. The detail is what it does now while it
 * runs and its answer once it settled; where neither says anything the status word
 * takes the detail's place.
 */
export interface SubagentRowModel {
  title: string
  /** "Subagent, GPT-6.1 Sol, High", for the row's hover note. */
  kind: string
  state: SubagentState
  detail?: string
  status: string
  startedAt: number
  endedAt?: number
}

export function subagentRowModel(step: ToolStep, steps: readonly TurnStep[], state: SubagentState, summary?: SubagentSummary): SubagentRowModel {
  const raw = state === 'running' ? subagentNow(steps) : step.output ?? summary?.reason
  const detail = raw === undefined ? '' : plainDetail(raw)
  const endedAt = summary?.endedAt
  return {
    title: subagentTask(step),
    kind: subagentKindLine(step),
    state,
    ...(detail === '' ? {} : { detail }),
    status: SUBAGENT_STATE_LABEL[state],
    startedAt: summary?.startedAt ?? step.startedAt,
    ...(endedAt === undefined ? {} : { endedAt }),
  }
}

/** A row's elapsed time: a clock while it runs, the time it took once ended, nothing where the end is unknown. */
export const subagentElapsed = (row: Pick<SubagentRowModel, 'state' | 'startedAt' | 'endedAt'>, now: number): string | undefined =>
  row.state === 'running' ? elapsedLabel(row.startedAt, now) : row.endedAt === undefined ? undefined : elapsedLabel(row.startedAt, row.endedAt)

/** The word a wake's notice row says about how a helper ended. */
export const WAKE_NOTICE: Record<'done' | 'failed' | 'stopped', { state: SubagentState; label: string }> = {
  done: { state: 'done', label: 'Finished' },
  failed: { state: 'failed', label: 'Failed' },
  stopped: { state: 'stopped', label: 'Stopped' },
}

/** A one-line detail from markdown: link text only, no code ticks, bold, headings or bullets, whitespace collapsed. */
const plainDetail = (text: string): string => text
  .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  .replace(/`|\*\*/g, '')
  .replace(/^[ \t]*(?:[-*]|#{1,6})[ \t]+/gm, '')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 240)

/**
 * The helpers working right now, newest first: the Session panel's Subagents section.
 * A Manor child counts only while the directory lists it as running, which it does
 * for every running child; a launch row cached from before it ended would otherwise
 * keep saying Working. A provider's own helper has no listing, and its launch row is
 * closed when its turn ends.
 */
export const runningSubagents = (subagents: readonly ChatSubagent[], summary?: (childId: string) => SubagentSummary | undefined): ChatSubagent[] =>
  subagents.filter((subagent) => subagentStateOf(subagent, summary) === 'running')

/**
 * How many rows the fold actually holds, which is what the chevron promises.
 *
 * Reasoning and narration are part of the record but not "steps": the step count
 * keeps meaning tool calls, while the fold opens for a turn that only thought.
 */
export const traceCountOf = (segments: TurnSegment[]): number =>
  shownSegments(segments).filter((segment) => segment.kind !== 'ask' && segment.kind !== 'todo' && segment.kind !== 'draft'
    && segment.kind !== 'user' && !(segment.kind === 'reply' && segment.live === true)).length

/**
 * A pause rather than work: holding for the user's answer, or for background work the
 * turn started once it answered. Its clock follows the words without "for", because
 * the clock is the turn's age, not the pause's.
 */
export const isPaused = (turn: TurnRow): boolean => isWaiting(turn) || backgroundWaitLabel(turn) !== undefined

/** A turn that has stopped to ask the user something and is holding for the answer. */
export const isWaiting = (turn: TurnRow): boolean =>
  (turn.asks ?? []).some((ask) => ask.answers === undefined)

/**
 * What a turn that answered still waits on, in the words its status uses: "Waiting on
 * 3 background agents", "on 1 background command", or both kinds named.
 */
export function backgroundWaitLabel(turn: TurnRow): string | undefined {
  const wait = turn.live?.state === 'running' ? turn.live.background : undefined
  return wait === undefined ? undefined : waitingOn(wait.agents, wait.commands)
}

/**
 * Background work a finished turn started that still runs: Manor-run children, and
 * agents and commands a live session keeps. They outlive the turn, and when they end
 * their persona wakes, so the turn reads as waiting on them.
 */
export function backgroundStillRunning(turn: TurnRow): { agents: number; commands: number } {
  const counts = { agents: 0, commands: 0 }
  if (turn.live?.state === 'running') return counts
  for (const step of turn.activities) {
    if (!isToolStep(step) || step.status !== 'running' || step.parentToolCallId !== undefined) continue
    if (step.subagent?.childChatId === undefined && step.background !== true) continue
    if (isSubagentStep(step)) counts.agents += 1
    else counts.commands += 1
  }
  return counts
}

/** A chat with no turn running still waits on background work; its Stop ends it. */
export const chatWaitsOnBackground = (rows: readonly Row[]): boolean =>
  rows.some((row) => {
    if (row.kind !== 'turn') return false
    const { agents, commands } = backgroundStillRunning(row)
    return agents + commands > 0
  })

export const isCompactNote = (note: { text: string } | undefined): boolean =>
  note !== undefined && COMPACT_NOTES.has(note.text)

/** Settled compact copy belongs in the open fold, never under the answer. */
export const isSettledCompactNote = (note: { text: string } | undefined): boolean =>
  isCompactNote(note) && note?.text !== LIVE_COMPACT_NOTE

/** Chevron and toggle follow this, including a Compacted line or Manor's bookkeeping with no other trace. */
export const hasFold = (turn: TurnRow): boolean =>
  traceCountOf(turn.segments) > 0 || isSettledCompactNote(turn.note) || (turn.traceNotes?.length ?? 0) > 0

/** Working and Compacting share the shimmer; Waiting does not. */
export const statusShimmers = (summary: string): boolean =>
  summary === 'Working…' || summary === COMPACTING_STATUS

/**
 * Whether this turn has anything to say beside the name at all.
 *
 * Deliberately not "does it have a trace". A direct answer can still wait, and a manual stop says Stopped on the turn instead of a line of its own.
 */
export function hasStatus(turn: TurnRow): boolean {
  return (
    turn.live !== undefined ||
    turn.note?.kind === 'aborted' ||
    traceCountOf(turn.segments) > 0 ||
    workedLabel(turn.startedAt, turn.endedAt) !== undefined
  )
}

/**
 * The one line a turn says about itself, beside the name of whoever is running it.
 *
 * One word for the whole of running, and that is the point. "Read Avatar.tsx" is truer
 * about this half-second than "Working…" is, and "Thinking…" is truer about the next
 * one — which is exactly the problem, because a line that sits next to a persona's
 * name and swaps every time she picks up or puts down a tool makes the reader watch
 * the ticker instead of the work. Reasoning and every step she takes have their own
 * rows in the trace, beside their own icons, where they stay put.
 *
 * Two exceptions sit in the same slot. Waiting on the user, because that one is not
 * about her at all: it says the turn has stopped and is holding for the user. And a
 * compaction, a pause while the CLI rewrites its own session, but only while the
 * trace is folded: an open trace says Compacting in its own row, and one line per
 * compaction is enough.
 *
 * Settled it turns into the record, and the record is about the wait rather than the
 * work: how long it took beats how many calls it made, because the number of steps is
 * the agent's business and the wait was the user's. Only when the clock says nothing
 * does a non-zero step count carry the line; "No steps" is noise beside a reply.
 */
export function turnSummary(turn: TurnRow, traceOpen = false): string {
  // The trace's own calls; a subagent's steps are counted on its row.
  const stepCount = turn.activities.filter((step) => isToolStep(step) && step.parentToolCallId === undefined).length
  const steps = `${stepCount} ${stepCount === 1 ? 'step' : 'steps'}`
  if (turn.live?.state === 'running') {
    if (isCompacting(turn) && !traceOpen) return COMPACTING_STATUS
    if (isWaiting(turn)) return 'Waiting for you…'
    const background = backgroundWaitLabel(turn)
    return background === undefined ? 'Working…' : `${background}…`
  }
  // A deliberate stop reads as one word on the turn; whatever it produced stays below.
  if (turn.note?.kind === 'aborted') return 'Stopped'
  const still = backgroundStillRunning(turn)
  const after = waitingOn(still.agents, still.commands)
  if (after !== undefined) return `${after}…`
  // A failed turn keeps one explicit notice below this line with the actual reason.
  // Its trace control can stand without repeating that failure beside the name.
  if (turn.note?.kind === 'error') return ''
  const worked = workedLabel(turn.startedAt, turn.endedAt)
  if (worked !== undefined) return `Worked for ${worked}`
  if (stepCount === 0) return traceCountOf(turn.segments) === 0 ? '' : 'Thought it through'
  return steps
}

/**
 * What a DM's working indicator stands for: a turn of hers that is still writing,
 * a message the user sent that no turn has picked up yet, or a colleague she asked and
 * is waiting on. Nothing means the indicator is gone.
 */
export type DmWorking =
  | { kind: 'turn'; turn: TurnRow }
  | { kind: 'sent' }
  | { kind: 'consult'; agentId: string; peerAgentId: string }

/**
 * Whether a DM shows its working indicator, and for what.
 *
 * A DM renders a reply only once it is whole, so this is the one sign of life while
 * the agent works. It stands from the send until the reply is complete. A turn that
 * holds for the user's answer or only waits on background work it started has already
 * said its part, so the indicator goes there. A consultation counts while its reply
 * is outstanding and the pair chat still runs (`runningChats`), and only until a later
 * turn starts: a relay a restart cut off writes no failed marker, and a spinner that
 * outlives the work is a lie.
 */
export function dmWorking(rows: readonly Row[], runningChats?: ReadonlySet<string>): DmWorking | undefined {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!
    if (row.kind === 'turn' && row.live?.state === 'running') return isPaused(row) ? undefined : { kind: 'turn', turn: row }
  }
  let lastTurn = rows.length - 1
  while (lastTurn >= 0 && rows[lastTurn]!.kind !== 'turn') lastTurn -= 1
  if (rows.some((row, index) => row.kind === 'pending' || (index > lastTurn && isAwaitingTurn(row)))) return { kind: 'sent' }
  const answered = new Set<string>()
  // The newest turn row. A relay can land before its own turn's first durable event,
  // so only a different turn below it counts as later work; a split turn keeps its last row.
  let newest: TurnRow | undefined
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!
    if (row.kind === 'turn') {
      if (newest !== undefined && newest.turnId !== row.turnId) return undefined
      newest ??= row
      continue
    }
    // A handoff expects no reply, so nothing waits on it.
    if (row.kind !== 'event' || row.event.type !== 'agent_relay' || row.event.handoff === true) continue
    const relay = row.event
    if (relay.phase !== 'sent') answered.add(relay.relayId)
    else if (!answered.has(relay.relayId) && (runningChats === undefined || runningChats.has(relay.pairChatId))) {
      if (newest !== undefined && newest.turnId !== relay.turnId) return undefined
      // The turn that asked was stopped or failed: whatever the colleague still drains, the DM is done.
      // A recoverable error splits a turn into rows, so only its last row tells how it ended.
      const asker = newest ?? [...rows].reverse().find((other): other is TurnRow => other.kind === 'turn' && other.turnId === relay.turnId)
      const broke = asker?.note?.kind === 'aborted' || asker?.note?.kind === 'error'
      return broke ? undefined : { kind: 'consult', agentId: relay.agentId, peerAgentId: relay.peerAgentId }
    }
  }
  return undefined
}

/**
 * A message the server accepted that no turn has drawn a row for yet: queued behind
 * other work, or dispatched a moment before its first event. Waiting messages sort
 * under every turn, and a started one sits above the turn that took it, so the
 * caller asks this only of rows past the last turn row.
 */
const isAwaitingTurn = (row: Row): boolean =>
  row.kind === 'event' && row.event.type === 'user_message' && row.event.source === undefined
  && (row.event.dispatchState === 'pending' || row.event.dispatchState === 'started')

/** Until then a DM turn is only thinking, whatever it has picked up. */
const DM_THINKING_MS = 3_000
/** From here a long DM turn says so, taking turns with what it is doing. */
const DM_LONG_TURN_MS = 45_000
const DM_LONG_TURN_SWAP_MS = 12_000
const DM_LONG_TURN_LABEL = 'Still working. This one takes a while.'

/**
 * The words beside the face in a DM's working indicator.
 *
 * Unlike the status beside a name in a Session, this one moves on purpose: with the
 * reply held back until it is whole, a label that never changes reads as stuck. It
 * names only the kind of work, never a path, argument or output. `turn` is absent
 * for a message no turn has picked up yet.
 */
export function dmWorkingLabel(turn: TurnRow | undefined, now: number): string {
  if (turn === undefined) return 'Thinking…'
  if (isCompacting(turn)) return COMPACTING_STATUS
  const elapsed = now - (turn.live?.startedAt ?? now)
  if (elapsed < DM_THINKING_MS) return 'Thinking…'
  const doing = dmDoing(turn)
  if (elapsed < DM_LONG_TURN_MS) return doing
  return Math.floor((elapsed - DM_LONG_TURN_MS) / DM_LONG_TURN_SWAP_MS) % 2 === 0 ? DM_LONG_TURN_LABEL : doing
}

/**
 * The kind of work since she last said something. The newest call stands until she
 * speaks again, rather than only while it runs, so a run of quick reads holds on
 * "Reading…" instead of flickering back to "Thinking…" between every call.
 */
function dmDoing(turn: TurnRow): string {
  if (liveWritten(turn.live)) return 'Writing…'
  for (let index = turn.activities.length - 1; index >= 0; index -= 1) {
    const step = turn.activities[index]!
    if (step.kind === 'say') return 'Thinking…'
    if (!isToolStep(step) || step.parentToolCallId !== undefined || step.background === true) continue
    if (isMemoryWrite(step)) return 'Saving to memory…'
    if (isBrowserTool(step.tool)) return 'Browsing…'
    if (isTaskTool(step.tool)) return 'Working with a helper…'
    switch (activityKind(step)) {
      case 'read': return 'Reading…'
      case 'search': return 'Searching…'
      case 'edit': return 'Editing…'
      case 'shell': return 'Running a command…'
      default: return 'Working…'
    }
  }
  return 'Thinking…'
}

/**
 * One line in an opened activity run. Consecutive calls of the same sort fold into one
 * group line: reads and searches by kind, anything else only when its label is the
 * same word for word (a helper polled three times). A group opens onto its calls, so
 * the record stays complete. A failed call never joins a group, and neither does an
 * edit, whose landed diff already stands at the top of the run.
 */
export type TraceRow =
  | { kind: 'reasoning'; key: string; step: ReasoningStep }
  | { kind: 'tool'; key: string; step: ToolStep }
  | { kind: 'group'; key: string; family: TraceFamily; steps: ToolStep[] }

export type TraceFamily = 'read' | 'search' | 'same'

function familyOf(step: ToolStep): { family: TraceFamily; identity: string } | undefined {
  if (step.status === 'error' || isTaskTool(step.tool) || isMemoryWrite(step) || isBrowserTool(step.tool)) return undefined
  if ((step.edits?.length ?? 0) > 0) return undefined
  const kind = activityKind(step)
  if (kind === 'edit') return undefined
  if (kind === 'read') return { family: 'read', identity: 'read' }
  if (kind === 'search') return { family: 'search', identity: 'search' }
  // Word for word the same line: four database calls show "Used the database ×4",
  // and the opened group still lists each call with its own command.
  return { family: 'same', identity: `same:${settledLabel(step)}` }
}

export function traceRows(steps: readonly TurnStep[], breaks: ReadonlySet<string> = new Set()): TraceRow[] {
  const rows: TraceRow[] = []
  let identity: string | undefined
  for (const step of steps) {
    if (breaks.has(step.key)) identity = undefined
    if (step.kind === 'reasoning') {
      rows.push({ kind: 'reasoning', key: step.key, step })
      identity = undefined
      continue
    }
    if (step.kind !== 'tool') continue
    const family = familyOf(step)
    const last = rows.at(-1)
    if (family !== undefined && family.identity === identity && last !== undefined) {
      if (last.kind === 'group') last.steps.push(step)
      else if (last.kind === 'tool') rows[rows.length - 1] = { kind: 'group', key: last.key, family: family.family, steps: [last.step, step] }
      continue
    }
    rows.push({ kind: 'tool', key: step.key, step })
    identity = family?.identity
  }
  return rows
}

/** The objects a read or search group names, once each, in order. */
function groupObjects(steps: readonly ToolStep[]): string[] {
  const names = steps.flatMap((step) => {
    if ((step.targets?.length ?? 0) > 0 && step.subject === undefined) return step.targets!.map(shortTarget)
    const detail = activityDetail(step)
    return detail === undefined ? [] : [detail]
  })
  return [...new Set(names)]
}

/**
 * A group's settled line. Reads and searches name what they touched, joined by a dot;
 * the line truncates where the row ends and the opened group lists every call. An
 * identical-call group keeps its one label and shows the count beside it.
 */
export function groupLabel(group: Extract<TraceRow, { kind: 'group' }>): string {
  if (group.family === 'same') return settledLabel(group.steps[0]!)
  if (group.family === 'search') {
    const places = [...new Set(group.steps.flatMap((step) => {
      const place = searchQuery(step)?.place
      return place === undefined ? [] : [place]
    }))]
    return `Searched ${group.steps.length} times${places.length === 0 ? '' : ` in ${places.join(', ')}`}`
  }
  const objects = groupObjects(group.steps)
  const verb = 'Read'
  if (objects.length === 0) return group.family === 'read' ? `Read ${group.steps.length} files` : `Searched ${group.steps.length} times`
  return `${verb} ${objects.join(', ')}`
}

/** What one step's row opens onto: the exact command, every full path, and why it failed. */
export interface StepDetail {
  command?: string
  /** A search's exact pattern, which its row only summarises. */
  query?: string
  targets?: string[]
  error?: string
}

export function stepDetail(step: ToolStep): StepDetail | undefined {
  const query = activityKind(step) === 'search' ? searchQuery(step)?.pattern : undefined
  const detail: StepDetail = {
    ...(step.command === undefined ? {} : { command: step.command }),
    ...(step.command !== undefined || query === undefined ? {} : { query }),
    ...((step.targets?.length ?? 0) === 0 ? {} : { targets: step.targets }),
    ...(step.status === 'error' && step.error !== undefined ? { error: step.error } : {}),
  }
  return Object.keys(detail).length === 0 ? undefined : detail
}

/** The settled or live line for one step row, with a failure named in words, not colour. */
export const stepLabel = (step: ToolStep, active: boolean): string =>
  active && step.status !== 'error' ? currentLabel(step) : `${settledLabel(step)}${step.status === 'error' ? ', failed' : ''}`

/** One picture a step read or wrote, keyed by its path so a file read twice shows once. */
export interface StepImage {
  key: string
  src: string
  /** The file name, which the viewer shows as the picture's name. */
  name: string
}

/** How many thumbnails a line shows before the rest become a count. */
export const THUMBNAILS_SHOWN = 2

/**
 * The pictures a run of steps read or wrote, once each, in order. Only a finished call
 * counts: a running one may not have written its picture yet, and a failed one read none. The server links no picture the user attached to their own
 * message: they already see it in their bubble.
 */
export function stepImages(steps: readonly TurnStep[]): StepImage[] {
  const seen = new Map<string, StepImage>()
  for (const step of steps) {
    if (!isToolStep(step) || step.status !== 'done') continue
    for (const image of step.images ?? []) {
      if (!seen.has(image.target)) seen.set(image.target, { key: image.target, src: image.src, name: image.target.slice(image.target.lastIndexOf('/') + 1) })
    }
  }
  return [...seen.values()]
}

/** The thumbnails a line draws and how many more it counts as "+N". */
export function thumbnailStrip<Image>(images: readonly Image[]): { shown: Image[]; more: number } {
  return { shown: images.slice(0, THUMBNAILS_SHOWN), more: Math.max(images.length - THUMBNAILS_SHOWN, 0) }
}

/** What a provider helper's thread is built from, so a view rebuilds it only when one of these moved. */
export const providerHelperKey = ({ step, steps }: ChatSubagent, state: SubagentState): string => [
  state,
  step.output,
  step.subagent?.prompt,
  ...steps.map((child) => child.kind === 'tool'
    ? `${child.key}:${child.status}:${child.subject}:${child.detail}:${child.edits?.length}:${child.unconfirmed}`
    : child.key),
].join('\0')

/**
 * What Manor holds of a helper its provider ran inside its own turn, as the thread a
 * Manor-run child would have: its brief as the opening message, its steps in order and
 * its result as the answer. The view draws it with the same transcript as a child's own
 * thread; the only difference is that the steps are the launch row's record, not a
 * conversation Manor took part in.
 */
export function providerHelperThread(subagent: ChatSubagent, state: SubagentState): ThreadShape {
  const { step, steps, agentId } = subagent
  const turnId = step.toolCallId ?? step.key
  const events: ThreadEvent[] = [{
    id: `${turnId}:brief`,
    ts: step.startedAt,
    type: 'user_message',
    text: step.subagent?.prompt ?? 'Not reported',
    mentions: [],
    source: 'subagent_task',
  }]
  const base = { agentId, turnId }
  let at = step.startedAt
  for (const child of steps) {
    at = Math.max(at, child.startedAt)
    if (child.kind === 'reasoning') {
      events.push({ ...base, id: child.key, ts: child.startedAt, type: 'reasoning', text: child.text })
      continue
    }
    // A helper inside a helper has no thread of its own to open from here.
    if (child.kind !== 'tool' || isTaskTool(child.tool)) continue
    events.push({
      ...base,
      id: child.key,
      ts: child.startedAt,
      type: 'tool_use',
      ...(child.toolCallId === undefined ? {} : { toolCallId: child.toolCallId }),
      tool: child.tool,
      ...(child.agentType === undefined ? {} : { agentType: child.agentType }),
      ...(child.detail === undefined ? {} : { detail: child.detail }),
      ...(child.subject === undefined ? {} : { subject: child.subject }),
      ...(child.targets === undefined ? {} : { targets: child.targets }),
      ...(child.command === undefined ? {} : { command: child.command }),
      // A stop cut this call short, so a write it was making is a claim nobody can back.
      ...(child.edits === undefined || child.unconfirmed === true ? {} : { edits: child.edits }),
    })
    if (child.status !== 'running' && child.toolCallId !== undefined) {
      events.push({
        ...base,
        id: `${child.key}:result`,
        ts: child.startedAt,
        type: 'tool_result',
        toolCallId: child.toolCallId,
        outcome: child.status === 'done' ? 'success' : child.status,
        ...(child.error === undefined ? {} : { error: child.error }),
      })
    }
  }
  if (step.output !== undefined) {
    events.push({ ...base, id: `${turnId}:answer`, ts: at, type: 'agent_message', messageId: `${turnId}:answer`, text: step.output })
  }
  if (state === 'running') {
    return { ...emptyThread, events, hasSnapshot: true, liveTurns: [{ turnId, agentId, messages: [], state: 'running', startedAt: step.startedAt }] }
  }
  events.push({ ...base, id: `${turnId}:end`, ts: at, type: 'turn_result' })
  return { ...emptyThread, events, hasSnapshot: true }
}
