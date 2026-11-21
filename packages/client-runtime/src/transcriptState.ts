import { CODE_REVIEWER_ID, DEFAULT_PROJECT_COLOR, DEFAULT_PROJECT_ICON, GOAL_CHOICES_SHOWN, MAX_GOAL_POINTS, SINGLE_CHAT_VOICE, isCommandGoal, isProjectThreadFile, isProseFile, projectFileWriteDetail, projectFileWriteLabel, splitUserMessage, writtenFileName } from '@manor/contracts'
import type {
  ConnectCardKind,
  DeliveredFile,
  SlackRichText,
  AgentConfig,
  Chat,
  ChatMode,
  FileAttachment,
  FileEdit,
  GoalChoice,
  TurnFileChange,
  EventImage,
  ImageAttachment,
  MemoryChange,
  NotesUpdate,
  MemoryTrace,
  MessageReply,
  InlineQuote,
  OutboundChannel,
  OutboundMailAccount,
  OutboundDraftThread,
  PageContextAttachment,
  Project,
  ProjectFileWrite,
  ProjectThreadFile,
  ServerMessage,
  SubagentLaunch,
  ThreadEvent,
  Usage,
  UserInputAnswers,
  UserInputQuestion,
  WorkHandoff,
  WorkMerge,
} from '@manor/contracts'
import type { PendingDocument } from './threadState'
import { streamedMessages, type LiveTurnShape, type ThreadShape } from './quietState'
import { QUIET_SESSION, sessionGroup, sessionStatus, type SessionLive, type SessionStatus } from './sessionStatus'
import { isCompacting } from './compacting'
import { completionFor, confirmRequestOf, confirmTasks, confirmTitle, confirmWork, planTasks, type ConfirmProgress, type TaskLine } from './confirmTasks'
import { plainDraftText, plainPreview } from './plainPreview'
import { clockOf } from './usage'
import { reuseRows } from './rowReuse'

export type { PlanStanding, TaskLine } from './confirmTasks'
export { foldsWhenDone, planRowKeys, planStanding, planTitle } from './confirmTasks'

type UserEvent = Extract<ThreadEvent, { type: 'user_message' }>
type AgentEvent = Extract<ThreadEvent, { type: 'agent_message' }>
type SystemEvent = Extract<ThreadEvent, { type: 'system_note' }>
type RelayEvent = Extract<ThreadEvent, { type: 'agent_relay' }>

export interface ToolStep {
  kind: 'tool'
  key: string
  toolCallId?: string
  tool: string
  detail?: string
  subject?: string
  targets?: string[]
  /** Signed links to the pictures among `targets`, which the trace shows as thumbnails. */
  images?: { target: string; src: string }[]
  command?: string
  edits?: FileEdit[]
  /** The subagent call this step ran inside. Such steps stay out of the turn's own trace. */
  parentToolCallId?: string
  /** What kind of helper a subagent call started, when the provider names it. */
  agentType?: string
  /** A subagent launch's brief, title, model and effort, each only where reported. */
  subagent?: SubagentLaunch
  /** A subagent's final answer. */
  output?: string
  /** The first line of a failed call's output, redacted by the server. Only on `error`. */
  error?: string
  /**
   * Work the persona did not wait for. It stays running until that work ends, and is
   * never what the turn is doing right now.
   */
  background?: true
  /** This helper's own reported usage, separate from its parent's turn. */
  usage?: Usage
  status: 'running' | 'done' | 'error' | 'stopped'
  /**
   * Set where the status is a guess rather than an answer: the turn was stopped or
   * died with this call still open. `status` reads `done` there because the step is
   * no longer going anywhere, and that word is too strong to hang a claim about the
   * disk on.
   */
  unconfirmed?: true
  startedAt: number
}

/**
 * Whether this call's `edits` describe the disk, or only what it was about to do.
 *
 * Every driver attaches edits at `tool_use` time, from the tool's *input*, because
 * that is the only moment the two sides of the change are known. So a step carrying
 * edits is a claim about intent until the call comes back, and there are exactly two
 * ways for it never to: the result said error, or the turn was stopped or crashed
 * with the call still open and the sweep below settled it by guessing.
 *
 * A missing result on a turn that ended *normally* is deliberately not one of them.
 * That shape is all over the transcripts, and reading it as "did not land" blanks the
 * file changes of ordinary turns — a bigger lie than the one this prevents, told far
 * more often.
 *
 * One predicate rather than a status check at each call site, because the two call
 * sites are the trace and the summary card under it, and a turn whose trace and card
 * disagree about what changed is worse than either being wrong alone.
 */
export const landed = (step: ToolStep): boolean => step.status === 'done' && step.unconfirmed !== true

/** One block of the model's own trace, kept in place between the tool calls. */
export interface ReasoningStep {
  kind: 'reasoning'
  key: string
  text: string
  parentToolCallId?: string
  startedAt: number
}

/**
 * Assistant text the agent wrote while still working: the "let me check X" before a
 * tool call. It belongs in the trace at the position it was written, not under the
 * answer, because it is narration of the work rather than the result of it.
 */
export interface SayStep {
  kind: 'say'
  key: string
  text: string
  images: EventImage[]
  startedAt: number
  /** The provider message this text is (all or a slice of), which a steer anchors to. */
  messageId?: string
  /** Durable messages folded into this visual beat, kept separate for exact quoting. */
  quoteSources: MessageQuoteSource[]
  /** Partial text a stop or failure cut off and Manor saved as it stood. */
  interrupted?: true
  /** Streamed text not yet durable. Only projected for a turn with an inline steer. */
  live?: boolean
}

export type TurnActivity = ToolStep | ReasoningStep | SayStep

export const isToolStep = (step: TurnActivity): step is ToolStep => step.kind === 'tool'
// `isTaskTool` in turnLabels, repeated because that module imports this one.
const isSubagentCall = (step: ToolStep) => /^(task|agent|spawn_subagent)$/i.test(step.tool)
export const isSayStep = (step: TurnActivity): step is SayStep => step.kind === 'say'
export const isReasoningStep = (step: TurnActivity): step is ReasoningStep => step.kind === 'reasoning'

/** One provider-authored beat, kept whole as one assistant bubble. */
export interface TurnReply {
  kind: 'reply'
  key: string
  text: string
  images: EventImage[]
  /** One entry ordinarily; Work may visually join adjacent provider messages. */
  quoteSources: MessageQuoteSource[]
  /** Never finished: a DM, which shows only whole messages, leaves it out. */
  interrupted?: true
  /** Streamed text not yet durable. Only projected for a turn with an inline steer. */
  live?: boolean
}

/** Rejoins slices of one provider message without adding paragraph breaks at a steer. */
export function answerTextOf(replies: readonly TurnReply[]): string {
  return replies.reduce((text, reply, index) => {
    const source = reply.quoteSources.find((source) => source.text.length > 0)?.eventId
      ?? (reply.text.length === 0 ? reply.quoteSources[0]?.eventId : undefined)
    const continued = source !== undefined && source === replies[index - 1]?.quoteSources.at(-1)?.eventId
    return text + (index === 0 || continued ? '' : '\n\n') + reply.text
  }, '')
}

/**
 * The user's message sent while a non-DM turn was running, kept where the turn read it.
 * Wraps the whole event row so its hints and forwards stay with it; never an outer row.
 */
export interface TurnUser {
  kind: 'user'
  key: string
  row: Extract<Row, { kind: 'event' }>
}

export interface MessageQuoteSource {
  eventId: string
  text: string
}

/**
 * A run of file changes with nothing the agent said in between. Grouped because a
 * burst of edits is one act — "I rewrote the composer" — and listing each file as
 * its own paragraph-level row buries the sentences around it.
 */
export interface TurnEdits {
  kind: 'edits'
  key: string
  edits: FileEdit[]
}

/**
 * One uninterrupted run of work: the steps and thoughts between two things the agent
 * said. A run rather than a flat list, because what the agent said next explains the
 * steps immediately before it, and nothing else.
 */
export interface TurnWork {
  kind: 'work'
  key: string
  steps: TurnActivity[]
  /** Steps that came right after a landed edit, which the edits block took out of the run. */
  breaks?: Set<string>
}

/**
 * The turn as it reads. A message ends the block before it and the next step opens a
 * new one, so the record never runs past the sentence that explains it. The sentences
 * are in the order they were written; inside one block the steps and the changes are
 * each gathered once instead of interleaved, so a single act reads as a single act.
 * `TurnRow.timeline` keeps the true order for anything that needs it.
 */
export interface TurnTodo {
  kind: 'todo'
  key: string
  todos: TaskLine[]
}

export interface TurnAsk {
  kind: 'ask'
  key: string
  ask: AskRecord
}

/** One prepared draft where it landed in the turn's timeline. */
interface DraftItem {
  kind: 'draft'
  key: string
  draft: DraftRecord
}

/**
 * Every draft the turn prepared, as one block where the first one landed. A routine
 * that finds five mails is one act with five independent decisions in it, and the
 * reader needs to see how many are left far more than the exact moment each was
 * written. `TurnRow.timeline` keeps the true order for anything that needs it.
 */
export interface TurnDraft {
  kind: 'draft'
  key: string
  drafts: DraftRecord[]
}

export type TurnStanding = TurnReply | TurnTodo | TurnAsk | TurnDraft | TurnUser
export type TurnSegment = TurnWork | TurnReply | TurnEdits | TurnTodo | TurnAsk | TurnDraft | TurnUser
type TurnTimelineItem = TurnActivity | TurnTodo | TurnAsk | DraftItem | TurnUser

/** One ask-user card on a turn. Answers land later on the same record. */
export interface AskRecord {
  key: string
  requestId: string
  questions: UserInputQuestion[]
  answers?: UserInputAnswers
}

/**
 * One connect card. `ready` waits for the first click; `waiting` means a sign-in is
 * open in the browser. The link itself never reaches a client.
 */
export interface ConnectRecord {
  key: string
  connectId: string
  kind: ConnectCardKind
  app: string
  alias?: string
  status: 'ready' | 'waiting' | 'connected' | 'failed'
  reason?: string
  /** Connected after the agent stopped waiting, so its tools arrive on the next message. */
  nextMessage?: true
  /** Failed for good: Retry would only fail again. */
  final?: true
}

/** Prepared Gmail/Slack copy and its terminal state. */
export interface DraftRecord {
  key: string
  draftId: string
  channel: OutboundChannel
  to: string
  subject?: string
  cc?: string
  /** The sending address, when the server knew it at prepare time. */
  from?: string
  /** False when the host cannot read the whole thread; the quote stays, Show more goes. */
  fullThread?: false
  body: string
  mailAccount?: OutboundMailAccount
  slackChannelId?: string
  slackThreadTs?: string
  slackRichText?: SlackRichText
  thread?: OutboundDraftThread
  submission?: {
    slackRichText?: SlackRichText
    status: 'started' | 'uncertain'
    body: string
    subject?: string
    cc?: string
    message?: string
  }
  failure?: string
  closed?: {
    slackRichText?: SlackRichText
    outcome: 'submitted' | 'discarded' | 'snoozed' | 'ignored'
    until?: number
    delivery?: 'recorded' | 'delivered'
    body?: string
    subject?: string
    cc?: string
  }
}

/**
 * One word for where a draft stands, read the same by every row and tally. `open`
 * includes a draft whose last send failed safely: it is editable again and the
 * failure line under it says why. `locked` is a send in flight or one whose fate is
 * unknown; nothing may act on it until the server says.
 */
export type DraftStatus = 'open' | 'locked' | 'sent' | 'saved' | 'discarded' | 'snoozed' | 'ignored'

export function draftStatus(draft: DraftRecord): DraftStatus {
  if (draft.closed !== undefined) {
    if (draft.closed.outcome === 'snoozed') return 'snoozed'
    if (draft.closed.outcome === 'ignored') return 'ignored'
    if (draft.closed.outcome === 'discarded') return 'discarded'
    return draft.closed.delivery === 'delivered' ? 'sent' : 'saved'
  }
  return draft.submission === undefined ? 'open' : 'locked'
}

/** The word a card shows beside its app name: "Discarded", "Sent", and so on. */
export function draftStatusLabel(draft: DraftRecord): string {
  const status = draftStatus(draft)
  if (status === 'open') return draft.failure === undefined ? 'Draft' : 'Failed'
  if (status === 'locked') return draft.submission?.status === 'uncertain' ? 'Uncertain' : 'Sending'
  return { sent: 'Sent', saved: 'Saved', discarded: 'Discarded', snoozed: 'Later', ignored: 'Ignored' }[status]
}

/**
 * A card folds to its header once its decision is taken. Open drafts wait for one, and a
 * send in flight or of unknown fate stays unfolded so its warning line stays in view.
 */
export const draftSettled = (draft: DraftRecord): boolean => {
  const status = draftStatus(draft)
  return status !== 'open' && status !== 'locked'
}

/**
 * What a decided card shows when it is reopened. A send keeps exactly what left, so a
 * field the user cleared stays empty; Discard, Later and Ignore keep the prepared draft.
 */
export function draftShown(draft: DraftRecord): { subject: string; cc: string; body: string } {
  const sent = draft.closed?.outcome === 'submitted' ? draft.closed : draft.submission
  if (sent !== undefined) return { subject: sent.subject ?? '', cc: sent.cc ?? '', body: sent.body ?? draft.body }
  return { subject: draft.subject ?? '', cc: draft.cc ?? '', body: draft.body }
}

/** How many of a group stand where, for the line above a stack of drafts. */
export function tallyDrafts(drafts: readonly DraftRecord[]): Record<DraftStatus | 'uncertain', number> {
  const tally: Record<DraftStatus | 'uncertain', number> = {
    open: 0,
    locked: 0,
    uncertain: 0,
    sent: 0,
    saved: 0,
    discarded: 0,
    snoozed: 0,
    ignored: 0,
  }
  for (const draft of drafts) {
    const status = draftStatus(draft)
    tally[status === 'locked' && draft.submission?.status === 'uncertain' ? 'uncertain' : status] += 1
  }
  return tally
}

/**
 * The one snooze the bubble offers: tomorrow at nine, local time. A date picker in a
 * chat card is a small form, and someone who needs one is better off in the mailbox.
 */
export function snoozeUntilTomorrow(now = Date.now()): number {
  const until = new Date(now)
  until.setDate(until.getDate() + 1)
  until.setHours(9, 0, 0, 0)
  return until.getTime()
}

export interface TurnRow {
  kind: 'turn'
  key: string
  turnId: string
  agentId: string
  /** Latest plan snapshot. Later todo_update events replace it, they do not stack. */
  todos?: TaskLine[]
  /** Questions this turn asked, in order, with answers once they land. */
  asks: AskRecord[]
  /** Outbound Gmail/Slack drafts prepared on this turn. */
  drafts: DraftRecord[]
  /** Files the persona handed over with `deliver_file`, shown under the answer. */
  files?: DeliveredFile[]
  /** Accounts this turn needed connected, as cards under the answer. */
  connects?: ConnectRecord[]
  /** Provider activity in order, kept separately for summaries and tool state. */
  activities: TurnActivity[]
  /** Provider-neutral messages, work, plans and questions in the order they arrived. */
  timeline: TurnTimelineItem[]
  /** Everything the turn did before its answer, in order, behind one "Worked" header. */
  segments: TurnSegment[]
  /**
   * The last thing the agent said, and all that is left standing once the turn is
   * done. Everything written before it narrated work that is now over, and folds
   * away with that work.
   */
  answer: TurnReply[]
  /** Everything after the last work step, kept standing in its original order. */
  tail: TurnStanding[]
  /** First and last durable event of the turn, which is what "Worked for 4m" counts. */
  startedAt?: number
  endedAt?: number
  /**
   * The model the CLI said served this turn, in the provider's own words. Absent on
   * turns written before drivers reported it, and on any driver that does not. Never
   * the persona's configured or pinned value: those are what was asked for, and the
   * only reason this exists is that the two can differ and a persona cannot be asked.
   */
  reportedModel?: string
  /** Observed sources plus the separate model's post-turn usage judgment. */
  memoryTrace?: MemoryTrace
  /**
   * What this turn changed in memory, per file. The daily-log writer's lines
   * arrive after the turn finished, on the chain's last turn. These paths never
   * count as changed files.
   */
  memoryChanges?: MemoryChange[]
  /** The persona's own notes changed in this turn: the "Updated its notes" line with View and Undo. */
  notesUpdate?: NotesUpdate
  /** A memory-off persona's lasting rule, offered as a line for its instructions. */
  instructionsOffer?: string
  /**
   * In a project thread: the lines this turn wrote to preferences.md or notes.md, in
   * order. Clients show them as one footnote under the reply, not as rows of their own.
   */
  fileWrites?: ProjectFileWrite[]
  /** Measured worktree changes for this finished turn, when snapshots succeeded. */
  fileChanges?: TurnFileChange[]
  /** Absolute roots covered by the measurement. */
  fileChangeRoots?: string[]
  /** Reported edit paths inside those roots that the measurement cannot see. */
  fileChangeUnmeasured?: string[]
  live?: LiveTurnShape
  note?: SystemEvent
  /**
   * Bookkeeping Manor wrote about this turn (a cap, background work stopped, a problem it
   * carried on from). Shown only inside the open trace, never as a line of the thread.
   */
  traceNotes?: { key: string; text: string }[]
  /** A project thread turn's link to each Session it sent the user's message on to, under its reply. */
  sessionLinks?: SessionLink[]
  /** Set only by the durable terminal event; live state disappearing is not enough. */
  completed?: true
  /** Manor accepted this turn's goal_reached: the reached note followed it. */
  goalReached?: true
  /** A durable outgoing consultation explains a turn that yields without a reply. */
  hasSentRelay?: true
  /**
   * The routine fire that started this turn, set only in a DM. There the scheduler's
   * marker leaves the transcript and stands as the first line of the turn's fold, so a
   * DM with a daily routine reads as the conversation rather than a column of alarms.
   */
  routineTrigger?: RoutineTrigger
  /** Lets a continuing DM hide an explicitly quiet historical run, including old reply rows. */
  routineOutcome?: 'quiet' | 'publish'
}

/**
 * A turn that is over and never said anything. Worth its own line in the transcript,
 * because the failure it usually means is invisible otherwise: a turn whose process
 * was killed keeps every step it managed to record and simply stops, which renders as
 * a collapsed "Worked for 2m" with nothing underneath and reads as a finished turn.
 *
 * A note beats this, so a turn the server has explained (an error, an abort, the
 * startup sweep's "connection lost") is not silent, it is reported.
 */
export const finishedSilent = (turn: TurnRow): boolean =>
  turn.live === undefined &&
  turn.note === undefined &&
  turn.hasSentRelay !== true &&
  turn.answer.length === 0 &&
  (turn.asks ?? []).length === 0 &&
  (turn.drafts ?? []).length === 0 &&
  (turn.files ?? []).length === 0

/** A card a running DM turn shows before its reply is whole: a draft, a todo list, or a question already answered. */
export const dmLiveCard = (segment: TurnSegment): boolean =>
  segment.kind === 'draft'
  || (segment.kind === 'todo' && segment.todos.length > 0)
  || (segment.kind === 'ask' && segment.ask.answers !== undefined)

/**
 * A finished turn whose only trace is a consultation. In a DM it draws nothing: no face
 * without words to sign, and its fold only opens from that face. Its relay marker says
 * what happened, so clients drop the row instead of leaving an empty gap above it.
 */
export const onlyConsulted = (turn: TurnRow): boolean =>
  turn.live === undefined &&
  turn.note === undefined &&
  turn.hasSentRelay === true &&
  turn.tail.length === 0 &&
  (turn.files ?? []).length === 0 &&
  (turn.memoryChanges ?? []).length === 0 &&
  turn.segments.every((segment) => segment.kind === 'work' || segment.kind === 'edits')

/**
 * Where each DM turn's memory writes are reachable: the notepad in the hover icons of a
 * reply bubble, never a row of their own. A turn that wrote memory without a reply of
 * its own (it messaged someone, the answer came back in a later turn) hands its writes
 * to the same persona's next turn with a reply, or else its previous one. With neither
 * the chat shows no mark; the write stays in the memory folder and in the turn's steps (the user's
 * call, 2026-10-07). Keyed by turn row key.
 */
export function dmMemoryMarks(rows: readonly Row[]): ReadonlyMap<string, MemoryChange[]> {
  const turns = rows.filter((row): row is TurnRow => row.kind === 'turn')
  const replies = (turn: TurnRow) => turn.tail.some((segment) => segment.kind === 'reply')
  const carried = new Map<string, MemoryChange[]>()
  turns.forEach((turn, index) => {
    const changes = turn.memoryChanges
    if (changes === undefined || changes.length === 0 || replies(turn)) return
    const same = (other: TurnRow) => other.agentId === turn.agentId && replies(other)
    const host = turns.slice(index + 1).find(same) ?? turns.slice(0, index).reverse().find(same)
    if (host !== undefined) carried.set(host.key, [...carried.get(host.key) ?? [], ...changes])
  })
  // A turn that only shows its own writes keeps their array, so memoized rows stay put.
  const marks = new Map<string, MemoryChange[]>()
  for (const turn of turns) {
    const own = replies(turn) ? turn.memoryChanges ?? [] : []
    const extra = carried.get(turn.key)
    const shown = extra === undefined ? own : [...own, ...extra]
    if (shown.length > 0) marks.set(turn.key, extra === undefined ? turn.memoryChanges! : shown)
  }
  return marks
}

/** What a routine marker said, carried into the fold of the turn it started. */
export interface RoutineTrigger {
  /** Frozen into the event, so a rename since does not rewrite what happened. */
  name?: string
  ts: number
  prompt: string
  /** A one-time fire's own moment, so a late one can say so. */
  dueAt?: number
}

/** A Session the project thread sent one of the user's messages on to (`send_to_session`). */
export interface SessionLink {
  sessionChatId: string
  title: string
}

export type Row =
  | {
      kind: 'event'
      key: string
      event: UserEvent | SystemEvent | RelayEvent
      /** On the user's own message: what Manor says about it, shown under the bubble. */
      hints?: string[]
      /** On the user's own message in a project thread: the Sessions it was sent on to. */
      forwards?: SessionLink[]
      /** On the commit request Confirm posted: its steps, drawn as a tasks card instead of the text. */
      confirmTasks?: TaskLine[]
      /** With `confirmTasks`: the card's header, naming what the request commits. */
      confirmTitle?: string
    }
  | WorkHandoffRow
  | {
      kind: 'pending'
      key: string
      text: string
      images: ImageAttachment[]
      files: FileAttachment[]
      documents?: PendingDocument[]
      pageContexts: PageContextAttachment[]
      replyTo?: MessageReply
      quotes?: InlineQuote[]
    }
  | TurnRow
  | ThreadBundleRow

/**
 * In a project thread: everything Sessions and the thread posted since the user's last
 * message that needs nothing from the user, as one summary line that opens to the items
 * (2026-10-17). Built by `projectThreadFeed`; no other room has one.
 */
export interface ThreadBundleRow {
  kind: 'thread_bundle'
  key: string
  /** In the order they arrived, each drawn as it would stand on its own. */
  items: Row[]
  /** "2 Sessions done, 1 needs you, 3 lines in notes.md". */
  summary: string
  /** The thread's advice on a question in this bundle, by its requestId (`threadQuestionAdvice`). */
  advice?: Readonly<Record<string, string>>
}

/** Finds the visual row that owns a quote's durable source event. */
export const rowHasQuoteSource = (row: Row, eventId: string): boolean => row.kind === 'event'
  ? row.event.id === eventId
  : row.kind === 'thread_bundle' ? row.items.some((item) => rowHasQuoteSource(item, eventId))
  : row.kind === 'turn' && row.timeline.some((item) =>
      item.kind === 'user' ? item.row.event.id === eventId
        : item.kind === 'say' && item.quoteSources.some((source) => source.eventId === eventId),
    )

/**
 * The message a Session's result card means by "Open report": the longest thing the
 * lead said in the last turn that called `goal_reached`, since the call itself asks for
 * only a short closing line after the report. Undefined when no loaded turn called it.
 */
export function goalReportEventId(rows: readonly Row[]): string | undefined {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!
    // Only a call that landed reported: a refused ("already reached") or stopped one did not.
    if (row.kind !== 'turn' || !row.activities.some((step) => isToolStep(step) && landed(step) && /goal_reached$/.test(step.tool))) continue
    let report: { eventId: string; length: number } | undefined
    for (const item of row.timeline) {
      if (item.kind !== 'say') continue
      const source = item.quoteSources[0]
      if (source !== undefined && (report === undefined || item.text.length > report.length)) report = { eventId: source.eventId, length: item.text.length }
    }
    return report?.eventId
  }
  return undefined
}

/** One durable outgoing consultation, and the standing pair that contains it. */
export interface TurnConsultation {
  agentId: string
  pairChatId: string
}

/**
 * The personas a turn messaged, derived from its durable sent markers. Received and
 * failed markers keep their own transcript rows but cannot join an outgoing pile:
 * in the peer's DM they may name a turn that does not exist in that thread.
 */
export function consultationsByTurn(rows: readonly Row[]): ReadonlyMap<string, readonly TurnConsultation[]> {
  const byTurn = new Map<string, TurnConsultation[]>()
  for (const row of rows) {
    if (row.kind !== 'event' || row.event.type !== 'agent_relay' || row.event.phase !== 'sent') continue
    const event = row.event
    const consultations = byTurn.get(event.turnId) ?? []
    if (consultations.some((consultation) => consultation.agentId === event.peerAgentId)) continue
    consultations.push({ agentId: event.peerAgentId, pairChatId: event.pairChatId })
    byTurn.set(event.turnId, consultations)
  }
  return byTurn
}

/** A consultation its own turn never mentioned, so the marker has to say it. */
export interface UnannouncedConsultation {
  relayId: string
  agentId: string
  /** The first line of the question, as the sent marker stored it. */
  question: string
  /** Until the matching reply or failure lands, the marker says one is coming. */
  replyPending: boolean
}

/**
 * Outgoing consultations whose asking turn finished without a word of its own, keyed by
 * that turn's id. The prompt asks every persona to say whom it asked and why, but no
 * driver guarantees it; this lets the marker carry the question instead. A turn that
 * did acknowledge leaves no entry, so the question is never shown twice.
 */
export function unannouncedConsultations(rows: readonly Row[]): ReadonlyMap<string, readonly UnannouncedConsultation[]> {
  const silentTurns = new Set<string>()
  const answered = new Set<string>()
  for (const row of rows) {
    if (row.kind === 'turn' && row.live === undefined && row.answer.length === 0) silentTurns.add(`${row.turnId}\0${row.agentId}`)
    if (row.kind === 'event' && row.event.type === 'agent_relay' && row.event.phase !== 'sent') answered.add(row.event.relayId)
  }
  const byTurn = new Map<string, UnannouncedConsultation[]>()
  for (const row of rows) {
    if (row.kind !== 'event' || row.event.type !== 'agent_relay' || row.event.phase !== 'sent') continue
    const event = row.event
    if (event.preview === undefined || !silentTurns.has(`${event.turnId}\0${event.agentId}`)) continue
    const consultations = byTurn.get(event.turnId) ?? []
    if (consultations.some((consultation) => consultation.relayId === event.relayId)) continue
    consultations.push({
      relayId: event.relayId,
      agentId: event.peerAgentId,
      question: event.preview,
      replyPending: !answered.has(event.relayId),
    })
    byTurn.set(event.turnId, consultations)
  }
  return byTurn
}

/** One agent's messages both ways within one exchange, drawn as a single "N messages with" line. */
export interface RelayExchange extends TurnConsultation {
  /** Distinct messages: each sent and each received relay counts once. */
  count: number
  relayIds: readonly string[]
}

/** The words before a relay marker's face: "Messaged", "Message from", or an exchange's "3 messages with". */
export function relayMarkerAction(phase: RelayEvent['phase'], exchange?: Pick<RelayExchange, 'count'>): string {
  if (exchange !== undefined) return `${exchange.count} ${exchange.count === 1 ? 'message' : 'messages'} with`
  return phase === 'sent' ? 'Messaged' : phase === 'received' ? 'Message from' : 'Message failed from'
}

/**
 * Merges each agent's sent and received markers within one exchange into one line. An
 * exchange is a run of relay markers with nothing visible between them; a silent
 * asking turn draws nothing in a DM, so it does not break the run. An agent with only
 * sends, only replies or a failure in the run keeps its own markers. The line sits on
 * the agent's first marker, keyed by event id; its other markers map to null.
 */
export function relayExchanges(rows: readonly Row[]): ReadonlyMap<string, RelayExchange | null> {
  const exchanges = new Map<string, RelayExchange | null>()
  let run: RelayEvent[] = []
  const flush = () => {
    const byPeer = new Map<string, RelayEvent[]>()
    for (const event of run) {
      if (event.phase === 'failed') continue
      const key = `${event.agentId}\0${event.peerAgentId}`
      byPeer.set(key, [...(byPeer.get(key) ?? []), event])
    }
    for (const events of byPeer.values()) {
      const [first] = events
      if (first === undefined || !events.some((event) => event.phase === 'sent') || !events.some((event) => event.phase === 'received')) continue
      const messages = new Set(events.map((event) => `${event.relayId}\0${event.phase}`))
      exchanges.set(first.id, {
        agentId: first.peerAgentId,
        pairChatId: first.pairChatId,
        count: messages.size,
        relayIds: [...new Set(events.map((event) => event.relayId))],
      })
      for (const event of events.slice(1)) exchanges.set(event.id, null)
    }
    run = []
  }
  for (const row of rows) {
    if (row.kind === 'event' && row.event.type === 'agent_relay') run.push(row.event)
    else if (!(row.kind === 'turn' && onlyConsulted(row))) flush()
  }
  flush()
  return exchanges
}

/**
 * Marks the first row of a stacked group with the facepile and every later row
 * with an empty group, so clients can collapse several durable markers into one.
 * Outgoing markers stack by the sending turn; incoming ones stack only while they
 * sit next to each other, so a later reply cannot jump up past a message in between.
 * Single consultations keep their original marker and therefore do not appear here,
 * and neither do markers merged into an exchange line (`relayExchanges`).
 */
export function stackedConsultationMarkers(
  allRows: readonly Row[],
  exchanges: ReadonlyMap<string, RelayExchange | null> = relayExchanges(allRows),
): ReadonlyMap<string, readonly TurnConsultation[]> {
  // Hidden exchange markers drop out; a visible exchange line stays a row, so replies around it never stack across it.
  const rows = exchanges.size === 0 ? allRows : allRows.filter((row) => row.kind !== 'event' || exchanges.get(row.event.id) !== null)
  const merged = (event: RelayEvent) => exchanges.has(event.id)
  const byTurn = consultationsByTurn(rows.filter((row) => row.kind !== 'event' || !exchanges.has(row.event.id)))
  const seen = new Set<string>()
  const markers = new Map<string, readonly TurnConsultation[]>()
  for (const row of rows) {
    if (row.kind !== 'event' || row.event.type !== 'agent_relay' || row.event.phase !== 'sent' || merged(row.event)) continue
    const event = row.event
    const consultations = byTurn.get(event.turnId)
    if (consultations === undefined || consultations.length < 2) continue
    markers.set(event.id, seen.has(event.turnId) ? [] : consultations)
    seen.add(event.turnId)
  }

  let receivedIds: string[] = []
  let received: TurnConsultation[] = []
  const flushReceived = () => {
    if (received.length >= 2) {
      const [first, ...rest] = receivedIds
      if (first !== undefined) markers.set(first, received)
      for (const id of rest) markers.set(id, [])
    }
    receivedIds = []
    received = []
  }
  for (const row of rows) {
    if (row.kind === 'event' && row.event.type === 'agent_relay' && row.event.phase === 'received' && !merged(row.event)) {
      const event = row.event
      receivedIds.push(event.id)
      if (!received.some((consultation) => consultation.agentId === event.peerAgentId)) {
        received.push({ agentId: event.peerAgentId, pairChatId: event.pairChatId })
      }
      continue
    }
    flushReceived()
  }
  flushReceived()
  return markers
}

/** A Session's current reported result, carried by the assignment's one card in the DM that briefed it. */
export interface WorkResult {
  handoffId: string
  workChatId: string | null
  /** The handoff version the result belongs to; Accept and feedback send it back. */
  version: number
  result: string
  limitations?: string
  /** The card's result lines as the lead wrote them; older reports have none. */
  points?: readonly string[]
  leadAgentName: string
  /** How many files Confirm commits, the "12 files" that opens the diff. */
  files: number
  /** Who passed the diff, when the result changed code and so had to be reviewed. */
  reviewer?: string
  /** What Accept approves. Merge needs `mergeInto`, which is only known for a worktree Session. */
  operation: 'none' | 'commit'
  mergeInto?: string
  /** The Session runs in a worktree, so the merge branch is worth asking for. */
  worktree: boolean
  decision: 'open' | 'accepted' | 'closed'
  /** After Accept: whether the lead's commit or merge actually landed. */
  completion?: {
    status: 'ready' | 'pending' | 'complete' | 'blocked'
    operation: 'none' | 'commit' | 'merge'
    mergeInto?: string
    message?: string
    /** On a blocked one: why Retry is not offered. Absent means it is. */
    retryRefused?: string
    /** Manor's own merge after the lead's commit: its place in the folder's queue, or the conflict fix it holds for the user. */
    merge?: WorkMergeView
  }
  /** Screenshots the lead named, shown as thumbnails under the result. Empty when there are none. */
  evidence: readonly { name: string; src: string; width?: number; height?: number }[]
  /** Decisions the report leaves to the user, under "Your call". Absent when it names none. */
  choices?: readonly GoalChoice[]
}

export interface WorkHandoffRow {
  kind: 'work_handoff'
  key: string
  handoffId: string
  projectId: string
  workChatId: string | null
  title: string
  /** The mode-neutral task as proposed. Legacy proposals that stored a kickoff have none. */
  task?: string
  /** The author's one-sentence goal; proposals without one show the start of `task`. */
  summary?: string
  projectName: string
  projectIcon: Project['icon']
  projectColor: string
  leadAgentId: string
  leadAgentName: string
  firstExecutorName?: string
  supportingAgentIds: string[]
  supportingAgentNames: string[]
  /** A project thread wrote this card, so it opens in Single (2026-10-11). */
  threadAuthored?: true
  /**
   * A persona's brief whose project has a live thread: Accept hands it to that thread,
   * so like the thread's own card it starts Single (2026-11-21).
   */
  threadBound?: true
  /** The Single runtime the thread proposed and its one-line reason; the card opens on it. */
  proposedRuntime?: WorkHandoff['proposedRuntime']
  /** Names of the images and files that go along with the kickoff. */
  attachments?: string[]
  /** Set when every attachment is a picture, which the card counts instead of naming. */
  attachmentsAllImages?: true
  /** The handoff's lifecycle, which decides what the card can still offer. Not a running claim. */
  status: 'Working' | 'Settled' | 'Archived' | 'Deleted'
  /** Where the Session stands, the same reading its overview row and project row use. */
  session: SessionStatus
  result: string | null
  /** The proposal's number from v2 on, which its card names beside the title. */
  revision?: number
  /** A newer revision replaced this proposal: its card is one line pointing at that one. */
  replacedBy?: { key: string; revision: number }
  /** The Session's current result, from goal reached until it is accepted or replaced by feedback. */
  report?: WorkResult
  /** Working again because code changed after it was ready, which the card says in one line. */
  changedAfterReady?: true
  acceptedAt: number | null
  mode?: ChatMode
  singleDriver?: Chat['singleDriver']
  /** The model an accepted Single session runs on, its assignee on the card. */
  singleModel?: string
  worktreeAvailable?: boolean
  worktreeBranch?: string | null
  /**
   * A DM brief handed to its project thread at Accept (2026-10-10). The card follows
   * the session the thread started and opens the thread, where Confirm lives.
   */
  forwarded?: { threadChatId: string | null; phase: 'starting' | 'working' | 'ready' | 'confirmed'; nothingToCommit?: true }
}

/**
 * What a project thread shows (2026-10-17): The user's own messages, the thread's replies to
 * the user, and what waits on the user, each on its own; everything else since the user's last message as
 * one `ThreadBundleRow` at the end of that stretch, or the item itself when it is alone. A new message from the user starts the
 * next bundle, so earlier ones stay where they were, collapsed.
 *
 * Standing alone: the user's messages and a brief handed over from a DM, the thread's turns the user
 * started, a proposal to accept, a result to confirm or a commit that did not land, an
 * error note, and the notice a persona's turn writes about itself (the wake limit, a
 * stop), the only word that stalled work will not resume until the user writes again.
 *
 * Bundled: a Session's card once it waits on nothing, info notes (file writes, learnings,
 * reports, answers) and the thread's own turns for a Session's report, result or question,
 * once they finished without asking or handing the user anything.
 *
 * Never drawn: the wake labels and a background helper's wake line, which the turn after
 * them already explains, and a relayed Session question until it is answered: the
 * question card above the composer is where it waits. The thread's advice on that
 * question is not drawn as a turn either: it stands on the card, and later under the
 * question's line in its bundle (`threadQuestionAdvice`). The transcript itself keeps all of
 * it for the thread's context and the memory writer.
 */
export function projectThreadFeed(rows: readonly Row[]): Row[] {
  const answered = new Set(rows.flatMap((row) =>
    row.kind === 'event' && row.event.type === 'system_note' && row.event.sessionAnswer !== undefined ? [row.event.sessionAnswer.requestId] : []))
  const feed: Row[] = []
  let start = 'start'
  let items: Row[] = []
  // Who the next turn answers: a wake for a Session, unless the user wrote since the last turn.
  let woken = false
  let mine = false
  // One item needs no fold: it stands on its own line, and a second one turns it into a bundle.
  const adviceKeys = adviceTurns(rows)
  const advice = threadQuestionAdvice(rows, adviceKeys)
  const close = () => {
    const held = Object.fromEntries(items.flatMap((item) => {
      const requestId = item.kind === 'event' && item.event.type === 'system_note' ? item.event.sessionQuestion?.requestId : undefined
      const text = requestId === undefined ? undefined : advice.get(requestId)
      return requestId === undefined || text === undefined ? [] : [[requestId, text]]
    }))
    const advised = Object.keys(held).length > 0
    // A question alone in its stretch still folds when it carries advice: its row is where the advice opens.
    if (items.length === 1 && !advised) feed.push(items[0]!)
    else if (items.length > 0) feed.push({ kind: 'thread_bundle', key: `bundle:${start}`, items, summary: threadBundleSummary(items), ...(advised ? { advice: held } : {}) })
    items = []
  }
  for (const row of rows) {
    const boundary = stretchKeyOf(row)
    if (boundary !== undefined) {
      close()
      start = boundary
      // A turn the user steered answers them; a message of theirs makes the next turn theirs.
      mine = row.kind !== 'turn'
      woken = false
      feed.push(row)
      continue
    }
    if (row.kind === 'turn') {
      const housekeeping = woken && !mine && quietWakeTurn(row)
      woken = false
      mine = false
      // Its advice stands with the question it answers, on the card and on that question's line.
      if (adviceKeys.has(row.key)) continue
      ;(housekeeping ? items : feed).push(row)
      continue
    }
    if (row.kind === 'work_handoff') {
      ;(threadCardWaits(row) ? feed : items).push(row)
      continue
    }
    if (row.kind !== 'event') {
      feed.push(row)
      continue
    }
    const event = row.event
    if (event.type === 'user_message') {
      if (event.source === 'project_thread' && event.threadReason !== undefined && SESSION_WAKES.has(event.threadReason)) woken = true
      else if (event.source !== 'project_thread' && event.source !== 'background_wake') feed.push(row)
      continue
    }
    if (event.type !== 'system_note' || event.kind !== 'info' || event.agentId !== undefined) {
      feed.push(row)
      continue
    }
    if (event.sessionQuestion !== undefined && !answered.has(event.sessionQuestion.requestId)) continue
    items.push(row)
  }
  close()
  return feed
}

/**
 * The thread's turns that advise on Session questions, by turn key, each with the
 * requestIds it advises on: the quiet turn right after a wake that carried only
 * questions, which wrote nothing. Its prompt asks for a pick and its reason, so the reply
 * is that advice and stands with the question instead of on its own.
 */
function adviceTurns(rows: readonly Row[]): ReadonlyMap<string, readonly string[]> {
  const questions = new Map(rows.flatMap((row) =>
    row.kind === 'event' && row.event.type === 'system_note' && row.event.sessionQuestion !== undefined ? [[row.event.id, row.event.sessionQuestion.requestId] as const] : []))
  // A question the thread answered itself from preferences.md: its reply reports that answer.
  const selfAnswered = new Set(rows.flatMap((row) =>
    row.kind === 'event' && row.event.type === 'system_note' && row.event.sessionAnswer?.by === 'thread' ? [row.event.sessionAnswer.requestId] : []))
  const turns = new Map<string, readonly string[]>()
  let asked: string[] = []
  for (const row of rows) {
    if (stretchKeyOf(row) !== undefined) {
      asked = []
      continue
    }
    if (row.kind === 'turn') {
      if (asked.length > 0 && !asked.some((id) => selfAnswered.has(id)) && quietWakeTurn(row) && (row.fileWrites ?? []).length === 0 && replyText(row) !== '') turns.set(row.key, asked)
      asked = []
      continue
    }
    if (row.kind !== 'event' || row.event.type !== 'user_message') continue
    // Only a wake that carried nothing but questions makes the next reply advice; any other wake before it (a report riding the same chain) ends that.
    const delivered = row.event.source === 'project_thread' && row.event.threadReason === 'question' ? row.event.threadDelivered ?? [] : []
    asked = delivered.length > 0 && delivered.every((id) => questions.has(id)) ? delivered.map((id) => questions.get(id)!) : []
  }
  return turns
}

/**
 * What the thread advised on each Session question it was woken for, by requestId: its
 * reply, as plain text. The question card above the composer and the question's line in
 * a bundle show it; the turn itself does not draw.
 */
export function threadQuestionAdvice(rows: readonly Row[], turns = adviceTurns(rows)): ReadonlyMap<string, string> {
  const advice = new Map<string, string>()
  for (const row of rows) {
    const requestIds = row.kind === 'turn' ? turns.get(row.key) : undefined
    if (row.kind !== 'turn' || requestIds === undefined) continue
    for (const requestId of requestIds) if (!advice.has(requestId)) advice.set(requestId, replyText(row))
  }
  return advice
}

/** A finished turn's reply as plain words, its messages one paragraph each. */
const replyText = (turn: TurnRow): string => plainDraftText(turn.answer.map((reply) => reply.text).join('\n\n'))

/** The wakes that bring a Session's report, result or question; a brief or the seed is the user's business. */
const SESSION_WAKES: ReadonlySet<string> = new Set(['question', 'report', 'result'])

/** A question mark at the end, past any closing emphasis, quote or bracket. */
const ENDS_ON_QUESTION = /\?[\s*_`"'”’)\]]*$/

/**
 * A finished wake turn that asked nothing and handed nothing over, so it can sit in a
 * bundle. A reply that ends on a question asks the user in words, so it stands on its own.
 */
const quietWakeTurn = (turn: TurnRow): boolean =>
  turn.live === undefined &&
  turn.asks.length === 0 &&
  !ENDS_ON_QUESTION.test(turn.answer.at(-1)?.text ?? '') &&
  turn.drafts.length === 0 &&
  (turn.files ?? []).length === 0 &&
  (turn.connects ?? []).length === 0 &&
  (turn.note === undefined || turn.note.kind === 'info')

/** A Session card the user acts on: a proposal to accept, a result to confirm, a commit that did not land. */
function threadCardWaits(row: WorkHandoffRow): boolean {
  if (row.replacedBy !== undefined || closedWorkHandoff(row) !== null) return false
  const shape = threadWorkCard(row).shape
  return shape === 'proposal' || shape === 'full'
}

/**
 * A bundle's one line, counted from its items. A Session counts under its overview group
 * (`sessionGroup` of the same `session` status the overview reads), in the words its own
 * card uses, so the line never disagrees with either. File lines count per file.
 */
/** A question whose answer sits in the same bundle is told by that answer, on its line and its chips. */
const answeredHere = (items: readonly Row[]): ReadonlySet<string> => new Set(items.flatMap((item) =>
  item.kind === 'event' && item.event.type === 'system_note' && item.event.sessionAnswer !== undefined ? [item.event.sessionAnswer.requestId] : []))

export function threadBundleSummary(items: readonly Row[]): string {
  const sessions = new Map<SessionGroup | 'closed', number>()
  const files = new Map<string, { lines: number; restored: boolean }>()
  let learnings = 0
  let reports = 0
  let answers = 0
  let questions = 0
  let updates = 0
  const answered = answeredHere(items)
  const count = <K,>(map: Map<K, number>, key: K) => map.set(key, (map.get(key) ?? 0) + 1)
  const wrote = (write: ProjectFileWrite) => {
    const file = files.get(write.file) ?? { lines: 0, restored: false }
    if (write.action === 'restore') file.restored = true
    else file.lines += 1
    files.set(write.file, file)
  }
  for (const item of items) {
    if (item.kind === 'work_handoff') count(sessions, sessionGroup(item.session) ?? 'closed')
    else if (item.kind === 'turn') {
      const writes = item.fileWrites ?? []
      writes.forEach(wrote)
      if (writes.length === 0) updates += 1
    } else if (item.kind === 'event' && item.event.type === 'system_note') {
      const event = item.event
      if (event.projectFileWrite !== undefined) wrote(event.projectFileWrite)
      else if (event.sessionAnswer !== undefined) answers += 1
      else if (event.sessionQuestion !== undefined) questions += answered.has(event.sessionQuestion.requestId) ? 0 : 1
      else if (event.projectReport !== undefined) reports += 1
      else if (event.threadPending !== undefined) learnings += 1
      else updates += 1
    } else updates += 1
  }
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
  const parts: string[] = []
  for (const group of SUMMARY_GROUPS) {
    const n = sessions.get(group)
    if (n === undefined) continue
    const word = group === 'closed' ? 'closed' : THREAD_SESSION_STATUS[group].text.toLowerCase()
    parts.push(parts.length === 0 ? `${plural(n, 'Session', 'Sessions')} ${word}` : `${n} ${word}`)
  }
  for (const [file, { lines, restored }] of files) {
    if (lines > 0) parts.push(`${plural(lines, 'line', 'lines')} in ${file}`)
    if (restored) parts.push(`${file} restored`)
  }
  if (learnings > 0) parts.push(`learnings from ${plural(learnings, 'Session', 'Sessions')}`)
  if (reports > 0) parts.push(plural(reports, 'report', 'reports'))
  if (answers > 0) parts.push(plural(answers, 'answer', 'answers'))
  if (questions > 0) parts.push(plural(questions, 'question', 'questions'))
  if (updates > 0) parts.push(plural(updates, 'update', 'updates'))
  return parts.join(', ')
}

/** The order a bundle's line names Sessions in: what finished first, then what still runs or waits. */
const SUMMARY_GROUPS = ['settled', 'working', 'background', 'waiting', 'closed'] as const

/** The mark a bundle chip or note wears; each client maps it to its own icon. */
export type ThreadBundleGlyph = 'session' | 'file' | 'learning' | 'report' | 'answer' | 'question' | 'update'

export type ThreadBundleTone = 'ok' | 'busy' | 'warn' | 'dim'

/** One chip on a bundle's closed line: a count and what happened, "2 Sessions", "1 written note". */
export interface ThreadBundleChip {
  key: string
  glyph: ThreadBundleGlyph
  tone: ThreadBundleTone
  count: number
  label: string
}

/**
 * One item in an open bundle, each a filled tile (the user's Paper states, 2026-10-18). A
 * Session draws as its one-line thread line; anything else as a note: its mark, its
 * words on one line that a press opens in full, and a small tag on the right. A quiet
 * turn is a note too, its reply one and each line it wrote another (2026-10-19).
 */
export type ThreadBundleEntry =
  | { kind: 'item'; key: string; item: WorkHandoffRow }
  | {
      kind: 'note'
      key: string
      item: Row
      glyph: 'file' | NoteKind
      tone: ThreadBundleTone
      /** The one line it reads as while closed. */
      title: string
      /** All of it as written, a notes.md line without its checkbox; what a press opens. */
      text: string
      /** The file it went to, or for a note its time. */
      tag: string
      /** On a Session question: what the thread advised, shown under it when open. */
      advice?: string
    }

export interface ThreadBundleView {
  chips: ThreadBundleChip[]
  /** Every item, kind by kind in the chips' order (Sessions, notes, learnings), each kind in arrival order. */
  entries: ThreadBundleEntry[]
}

/** Which Session state colours the Sessions chip: the one that asks most of the user. */
const SESSION_URGENCY = ['waiting', 'working', 'background', 'settled', 'closed'] as const
const SESSION_TONE = { waiting: 'warn', working: 'busy', background: 'dim', settled: 'ok', closed: 'dim' } as const

/** What a write to each thread file holds, and the verb its chip says for an add or update. */
const FILE_NOUN: Record<ProjectThreadFile, { one: string; many: string; kept: string }> = {
  'notes.md': { one: 'note', many: 'notes', kept: 'written' },
  'preferences.md': { one: 'preference', many: 'preferences', kept: 'saved' },
}
/** A memory card takes dated lines, and the thread may create one the user confirmed. */
const CARD_NOUN = { one: 'card line', many: 'card lines', kept: 'saved' }

/** A file write's chip, keyed by file and verb so a removal never reads as a save. */
function fileChipLabel(write: ProjectFileWrite): { key: string; one: string; many: string } {
  // Cards share one chip per verb, so two cards never show as two identical chips.
  const kind = isProjectThreadFile(write.file) ? write.file : 'card'
  if (write.action === 'create') return { key: `file:${kind}:created`, one: 'created card', many: 'created cards' }
  const noun = isProjectThreadFile(write.file) ? FILE_NOUN[write.file] : CARD_NOUN
  const verb = write.action === 'remove' ? 'removed' : write.action === 'restore' ? 'restored' : noun.kept
  return { key: `file:${kind}:${verb}`, one: `${verb} ${noun.one}`, many: `${verb} ${noun.many}` }
}

// Chip order, which is also the open list's order: learnings come last, after every other note.
const NOTE_KINDS = {
  report: { tone: 'busy', one: 'report', many: 'reports' },
  answer: { tone: 'ok', one: 'answer', many: 'answers' },
  question: { tone: 'busy', one: 'question', many: 'questions' },
  update: { tone: 'dim', one: 'update', many: 'updates' },
  learning: { tone: 'warn', one: 'learning', many: 'learnings' },
} as const satisfies Record<string, { tone: ThreadBundleTone; one: string; many: string }>

type NoteKind = keyof typeof NOTE_KINDS

/** A notes.md line's task-list checkbox, which is how the file tracks it, not what it says. */
const withoutCheckbox = (line: string): string => line.replace(/^\[[ xX]\]\s+/, '')

/** The first line of a reply or note as plain words, without a task list's checkbox. */
function titleLine(text: string): string {
  const line = text.split('\n').find((part) => part.trim().length > 0) ?? ''
  return withoutCheckbox(plainPreview(line))
}

type NoteEntry = Extract<ThreadBundleEntry, { kind: 'note' }>

/** A line written to a thread file: an added or updated line reads as itself, a removal or restore says so beside its file. */
function writeEntry(key: string, item: Row, write: ProjectFileWrite): NoteEntry {
  const current = write.action === 'add' || write.action === 'replace' || write.action === 'create'
  const text = (current ? write.line : projectFileWriteDetail(write)) ?? projectFileWriteLabel(write)
  const tag = current ? write.file : `${write.action === 'remove' ? 'Removed' : 'Restored'}, ${write.file}`
  return { kind: 'note', key, item, glyph: 'file', tone: 'busy', title: titleLine(text), text: withoutCheckbox(text.trim()), tag }
}

const noteEntry = (item: Row, kind: NoteKind, text: string, at: number | undefined, title = text): NoteEntry =>
  ({ kind: 'note', key: item.key, item, glyph: kind, tone: NOTE_KINDS[kind].tone, title: titleLine(title), text: text.trim(), tag: at === undefined ? '' : clockOf(at) })

/**
 * A quiet turn's lines in a bundle, each with the chip it sorts under: its reply, which
 * stands with its first write, then each write under its own file. The first line keeps
 * the turn's key, so a jump to the turn opens it.
 */
function turnEntries(turn: TurnRow): { entry: NoteEntry; chip: string }[] {
  const writes = turn.fileWrites ?? []
  const text = replyText(turn)
  const reply = text === '' && writes.length > 0 ? [] : [{ entry: noteEntry(turn, 'update', text, turn.endedAt ?? turn.startedAt), chip: writes[0] === undefined ? 'update' : fileChipLabel(writes[0]).key }]
  return [...reply, ...writes.map((write, index) => ({
    entry: writeEntry(reply.length === 0 && index === 0 ? turn.key : `${turn.key}#${index}`, turn, write),
    chip: fileChipLabel(write).key,
  }))]
}

/** Every other item's line in a bundle: a Session as itself, a note as its words. */
function bundleEntry(item: Row, advice: Readonly<Record<string, string>>): ThreadBundleEntry {
  if (item.kind === 'work_handoff') return { kind: 'item', key: item.key, item }
  const note = (kind: NoteKind, text: string, at: number | undefined, title = text) => noteEntry(item, kind, text, at, title)
  if (item.kind !== 'event' || item.event.type !== 'system_note') return note('update', 'Update', undefined)
  const event = item.event
  if (event.projectFileWrite !== undefined) return writeEntry(item.key, item, event.projectFileWrite)
  if (event.sessionAnswer !== undefined) return note('answer', event.text, event.ts)
  const question = event.sessionQuestion
  if (question !== undefined) {
    // Its first question is the line; a press shows them all, with who asked, and the thread's advice.
    const entry = note('question', event.text, event.ts, question.questions[0]?.question ?? event.text)
    const said = advice[question.requestId]
    return said === undefined ? entry : { ...entry, advice: said }
  }
  if (event.projectReport !== undefined) return note('report', event.projectReport.text, event.ts)
  if (event.threadPending !== undefined) return note('learning', event.text, event.ts)
  return note('update', event.text, event.ts)
}

/**
 * How a bundle draws: its closed line shows one chip per kind of thing that happened,
 * Sessions first, then each file in the order it was first written, then other notes,
 * learnings last; open, it lists every item in that same order, arrival order within a kind.
 */
export function threadBundleView(items: readonly Row[], advice: Readonly<Record<string, string>> = {}): ThreadBundleView {
  const answered = answeredHere(items)
  const sessions = new Set<(typeof SESSION_URGENCY)[number]>()
  const files = new Map<string, { label: ReturnType<typeof fileChipLabel>; count: number }>()
  const notes = new Map<NoteKind, number>()
  const wrote = (write: ProjectFileWrite) => {
    const label = fileChipLabel(write)
    files.set(label.key, { label, count: (files.get(label.key)?.count ?? 0) + 1 })
  }
  let sessionCount = 0
  const count = (kind: NoteKind) => notes.set(kind, (notes.get(kind) ?? 0) + 1)
  const entries: ThreadBundleEntry[] = []
  // The chip each card belongs to, which sets where it stands in the open list.
  const kindOf = new Map<ThreadBundleEntry, string>()
  // A question answered in this bundle has no chip of its own: it stands right before its answer.
  const told = new Map<string, ThreadBundleEntry>()
  for (const item of items) {
    if (item.kind === 'turn') {
      // A turn's chips count every write it made, or the turn itself as an update.
      const writes = item.fileWrites ?? []
      if (writes.length === 0) count('update')
      writes.forEach(wrote)
      for (const { entry, chip } of turnEntries(item)) {
        entries.push(entry)
        kindOf.set(entry, chip)
      }
      continue
    }
    const entry = bundleEntry(item, advice)
    if (item.kind === 'work_handoff') {
      sessionCount += 1
      sessions.add(sessionGroup(item.session) ?? 'closed')
      kindOf.set(entry, 'sessions')
    } else if (entry.kind === 'note' && item.kind === 'event' && item.event.type === 'system_note') {
      const { projectFileWrite: write, sessionQuestion: question } = item.event
      if (question !== undefined && answered.has(question.requestId)) {
        told.set(question.requestId, entry)
        continue
      }
      if (write !== undefined) wrote(write)
      else if (entry.glyph !== 'file') count(entry.glyph)
      kindOf.set(entry, write === undefined ? entry.glyph : fileChipLabel(write).key)
    }
    entries.push(entry)
  }
  const chip = (key: string, glyph: ThreadBundleGlyph, tone: ThreadBundleTone, count: number, one: string, many: string): ThreadBundleChip =>
    ({ key, glyph, tone, count, label: count === 1 ? one : many })
  const chips: ThreadBundleChip[] = []
  const urgent = SESSION_URGENCY.find((group) => sessions.has(group))
  // "2 Sessions done" once every one is done; while one still runs or waits, its tone says so.
  const done = urgent === 'settled' || urgent === 'closed' ? ' done' : ''
  if (urgent !== undefined) chips.push(chip('sessions', 'session', SESSION_TONE[urgent], sessionCount, `Session${done}`, `Sessions${done}`))
  for (const { label, count } of files.values()) chips.push(chip(label.key, 'file', 'busy', count, label.one, label.many))
  for (const kind of Object.keys(NOTE_KINDS) as NoteKind[]) {
    const count = notes.get(kind)
    if (count !== undefined) chips.push(chip(kind, kind, NOTE_KINDS[kind].tone, count, NOTE_KINDS[kind].one, NOTE_KINDS[kind].many))
  }
  // A note without a chip stands after the other notes, still before learnings; sort is
  // stable, so arrival order holds within a kind.
  const learnings = chips.findIndex((each) => each.key === 'learning')
  const rank = (entry: ThreadBundleEntry) => {
    const at = chips.findIndex((each) => each.key === kindOf.get(entry))
    if (at !== -1) return at
    return learnings === -1 ? chips.length : learnings - 0.5
  }
  const sorted = [...entries].sort((a, b) => rank(a) - rank(b)).flatMap((entry) => {
    const requestId = entry.item.kind === 'event' && entry.item.event.type === 'system_note' ? entry.item.event.sessionAnswer?.requestId : undefined
    const question = requestId === undefined ? undefined : told.get(requestId)
    if (question === undefined) return [entry]
    told.delete(requestId!)
    return [question, entry]
  })
  return { chips, entries: sorted }
}

/** The user's own bubble in a project thread, or the brief they handed it, as opposed to anything the house wrote. */
const isOwnBeat = (row: Row): boolean =>
  row.kind === 'pending' ||
  (row.kind === 'event' && row.event.type === 'user_message' &&
    (row.event.source === undefined || (row.event.source === 'project_thread' && row.event.threadReason === 'brief')))

/**
 * The message a new bundle starts at: one of the user's, or in a turn the user steered, their last
 * steer, so every message the user sends starts the next stretch.
 */
function stretchKeyOf(row: Row): string | undefined {
  if (isOwnBeat(row)) return row.key
  if (row.kind !== 'turn') return undefined
  let key: string | undefined
  for (const item of row.timeline) if (item.kind === 'user' && isOwnBeat(item.row)) key = item.key
  return key
}

/** Where the feed draws a row: in its own place, or in the bundle it folded into. */
export const feedIndexOf = (feed: readonly Row[], key: string): number =>
  feed.findIndex((row) => row.key === key || (row.kind === 'thread_bundle' && row.items.some((item) => item.key === key)))

/**
 * The thread bundles a reader opened. The user's next message folds them all again, so an
 * opened bundle never stays open in history; `stretch` is the feed's newest boundary.
 */
export interface OpenThreadBundles {
  stretch: string
  keys: ReadonlySet<string>
}

export const NO_OPEN_THREAD_BUNDLES: OpenThreadBundles = { stretch: 'start', keys: new Set() }

/** The key of the feed's newest boundary, `start` before the user's first message. */
export function threadStretch(feed: readonly Row[]): string {
  for (let index = feed.length - 1; index >= 0; index -= 1) {
    const key = stretchKeyOf(feed[index]!)
    if (key !== undefined) return key
  }
  return 'start'
}

export const threadBundleOpen = (open: OpenThreadBundles, stretch: string, key: string): boolean =>
  open.stretch === stretch && open.keys.has(key)

export function setThreadBundleOpen(open: OpenThreadBundles, stretch: string, key: string, value: boolean): OpenThreadBundles {
  const keys = new Set(open.stretch === stretch ? open.keys : [])
  if (value) keys.add(key)
  else keys.delete(key)
  return { stretch, keys }
}

/**
 * The bundle's lines that stand open, keyed like the bundle itself. A jump to an item
 * opens both its bundle and its line, so the item it lands on is drawn.
 */
export const threadBundleOpenItems = (open: OpenThreadBundles, stretch: string, bundle: ThreadBundleRow): ReadonlySet<string> =>
  new Set(open.stretch === stretch
    ? [...open.keys].filter((key) => bundle.items.some((item) => key === item.key || key.startsWith(`${item.key}#`)))
    : [])

/** Opens a bundle and the lines inside it that `holds` picks; unchanged when they already stand open. */
export function openThreadBundleAt(open: OpenThreadBundles, stretch: string, bundle: ThreadBundleRow, holds: (item: Row) => boolean): OpenThreadBundles {
  const wanted = [bundle.key, ...bundle.items.filter(holds).map((item) => item.key)]
  if (wanted.every((key) => threadBundleOpen(open, stretch, key))) return open
  return { stretch, keys: new Set([...(open.stretch === stretch ? open.keys : []), ...wanted]) }
}

const isCardRow = (row: Row): boolean => row.kind === 'work_handoff' || row.kind === 'thread_bundle'

/**
 * How a project thread row sits against the row above it, beyond the feed's own gap.
 * `group` stacks cards and the bundle line that follow each other (8px apart, one group). `beat` opens 16px
 * more room above the user's own message, so it reads as a new beat, and under a reply,
 * where its copy and reply actions hang on hover and need clear room before the next
 * card or message. Web and phone map both onto the same spacing scale.
 */
export function threadSpacing(row: Row, previous: Row | undefined): 'group' | 'beat' | undefined {
  if (previous === undefined) return undefined
  if (isCardRow(row) && isCardRow(previous)) return 'group'
  if (isOwnBeat(row)) return isOwnBeat(previous) ? undefined : 'beat'
  // A reply after a reply already has its own header slot to hold the actions.
  return previous.kind === 'turn' && row.kind !== 'turn' ? 'beat' : undefined
}

/** The one line a forwarded brief's card reads in its DM. */
export function forwardedLine(row: Pick<WorkHandoffRow, 'projectName' | 'forwarded' | 'status' | 'session'>): string {
  const phase = row.forwarded?.phase
  const report = row.forwarded?.nothingToCommit === true
  if (phase === 'confirmed') return `${report ? 'Closed' : 'Confirmed'} in project thread ${row.projectName}`
  if (row.status === 'Settled' || row.status === 'Archived') return `Settled in project thread ${row.projectName}`
  if (phase === 'ready') return report ? `Ready in project thread ${row.projectName}` : `Ready, confirm in project thread ${row.projectName}`
  // The overview's own fold decides: a question, a result to confirm or a quiet Session is the user's move.
  if (phase === 'working') {
    const group = sessionGroup(row.session)
    return `${group === 'waiting' ? 'Needs you in' : group === 'background' ? 'Waiting in' : 'Running via'} project thread ${row.projectName}`
  }
  return `To project thread ${row.projectName}`
}

/**
 * The line under a Work card's title, one wording for the proposal card on web and phone.
 * In Single no persona runs, so it names only the model; the author's name belongs to
 * Multiple, where the lead is named and the starter only when someone else starts.
 */
export const workByline = (
  input: { single: true; model: string } | { single: false; lead: string; starter?: string | undefined },
): string => {
  if (input.single) return input.model
  return input.starter === undefined || input.starter === input.lead
    ? `led by ${input.lead}`
    : `led by ${input.lead}, ${input.starter} starts`
}

/**
 * What a Session's kickoff card, or the brief a project thread was handed, says: the task
 * alone. Manor's own wording for the model is stored apart from it (`instruction`), and
 * rows from before that are split by the same rule, so no card strips anything itself.
 */
export const messageBrief = (event: UserEvent): string => splitUserMessage(event).visible

/**
 * The branch a worktree Session's linked folders are on, which is where its Confirm
 * merges. The server names it only when every linked folder agrees; otherwise the
 * button offers no merge rather than guess.
 */
function goalMergeTarget(status: Extract<ServerMessage, { type: 'checkout_status' }> | undefined): string | undefined {
  return status?.mode === 'worktree' ? status.homeBranch : undefined
}

/**
 * Coalesces an assignment's notes in the DM into one live card, the only element an
 * assignment leaves there. The card sits at the newest of its proposal, result and
 * reopened notes, so a delivery lands where the user is reading; the earlier notes and the
 * settled ones only update it. In the Session itself, the note where the lead marked it
 * ready is left out too: Confirm lives in the bar above the composer and in the diff.
 */
export function projectWorkHandoffs(
  rows: readonly Row[],
  handoffs: readonly WorkHandoff[],
  chats: readonly Chat[],
  projects: readonly Project[],
  agents: readonly AgentConfig[],
  checkoutStatus: Readonly<Record<string, Extract<ServerMessage, { type: 'checkout_status' }>>> = {},
  live: (chatId: string) => SessionLive = () => QUIET_SESSION,
  /** The chat these rows belong to; without it Confirm's request keeps its text. */
  chatId?: string,
): Row[] {
  const byId = new Map(handoffs.map((handoff) => [handoff.id, handoff]))
  const anchor = new Map<string, SystemEvent>()
  for (const row of rows) {
    if (row.kind === 'event' && row.event.type === 'system_note' && row.event.workHandoffId !== undefined && isCardNote(row.event)) {
      anchor.set(row.event.workHandoffId, row.event)
    }
  }
  let changed = false
  const projected: Row[] = []
  for (const row of rows) {
    if (row.kind !== 'event' || row.event.type !== 'system_note' || (row.event.workHandoffId === undefined && row.event.workGoalHandoffId === undefined)) {
      projected.push(row)
      continue
    }
    changed = true
    const handoff = row.event.workHandoffId === undefined ? undefined : byId.get(row.event.workHandoffId)
    if (handoff === undefined) continue
    // `/goal` sets a Session's goal in that Session: no brief to accept, so the line stands as it is.
    if (isCommandGoal(handoff) && row.event.workHandoffPhase === 'created') {
      projected.push(row)
      continue
    }
    if (anchor.get(handoff.id)?.id !== row.event.id) continue
    projected.push(workHandoffRow(handoff, row.event, chats, projects, agents, byId, checkoutStatus, live))
  }
  const shown = changed ? projected : [...rows]
  return chatId === undefined ? shown : withConfirmCards(shown, handoffs.filter((handoff) => handoff.workChatId === chatId))
}

/** Confirm's commit request reads as its steps, following the turn that answers it. */
function withConfirmCards(rows: Row[], handoffs: readonly WorkHandoff[]): Row[] {
  const requests = rows.map((row) => row.kind === 'event' && row.event.type === 'user_message' ? confirmRequestOf(row.event) : undefined)
  let newest = requests.length - 1
  while (newest >= 0 && requests[newest] === undefined) newest -= 1
  return rows.map((row, index) => {
    if (row.kind !== 'event' || row.event.type !== 'user_message') return row
    const request = requests[index]
    if (request === undefined) return row
    // The turn that answers it comes before anything else the user sends.
    const next = rows.slice(index + 1).find((candidate) => candidate.kind === 'turn' || candidate.kind === 'pending'
      || (candidate.kind === 'event' && candidate.event.type === 'user_message'))
    const turn = next?.kind === 'turn' ? next : undefined
    const completion = completionFor(handoffs, row.event.id)
    // Manor commits its own request: no turn answers it, and Git's record says how far it got.
    const progress: ConfirmProgress = request.manor === true ? completion === undefined ? 'ended' : 'running'
      : turn === undefined ? 'pending'
        : turn.live?.state === 'running' ? isCompacting(turn) ? 'compacting' : 'running'
          : turn.note?.kind === 'error' || turn.note?.kind === 'aborted' ? 'failed' : 'ended'
    return {
      ...row,
      confirmTasks: confirmTasks(request, progress, completion),
      confirmTitle: confirmTitle(request, confirmWork(handoffs, row.event.id, index === newest)),
    }
  })
}

/**
 * The card a Session's result reads as in that Session's own bar above the composer:
 * the same row its briefing DM carries, while the result waits on the user. Gone while the
 * Session works again, since a bar saying Ready then is a lie (2026-10-14).
 */
export function sessionReadyRow(
  chat: Chat,
  handoffs: readonly WorkHandoff[],
  chats: readonly Chat[],
  projects: readonly Project[],
  agents: readonly AgentConfig[],
  checkoutStatus: Readonly<Record<string, Extract<ServerMessage, { type: 'checkout_status' }>>> = {},
  live: (chatId: string) => SessionLive = () => QUIET_SESSION,
): WorkHandoffRow | undefined {
  const handoff = handoffs.find((candidate) => candidate.workChatId === chat.id)
  if (handoff?.goalReport === undefined) return undefined
  const row = workHandoffRow(handoff, undefined, chats, projects, agents, new Map(handoffs.map((item) => [item.id, item])), checkoutStatus, live)
  return workResultWaits(row) ? row : undefined
}

function workHandoffRow(
  handoff: WorkHandoff,
  note: SystemEvent | undefined,
  chats: readonly Chat[],
  projects: readonly Project[],
  agents: readonly AgentConfig[],
  byId: ReadonlyMap<string, WorkHandoff>,
  checkoutStatus: Readonly<Record<string, Extract<ServerMessage, { type: 'checkout_status' }>>>,
  live: (chatId: string) => SessionLive,
): WorkHandoffRow {
  const project = projects.find((candidate) => candidate.id === handoff.projectId)
  // A hidden project's archived thread is not somewhere to open or to hand a brief to.
  const liveThreadId = chats.some((chat) => chat.id === project?.threadChatId && chat.archivedAt === null) ? project?.threadChatId : undefined
  // A forwarded brief has no session of its own: it reads the one its thread started.
  const linked = handoff.forwardedAt === undefined || handoff.threadHandoffId === undefined ? undefined : byId.get(handoff.threadHandoffId)
  if (handoff.forwardedAt !== undefined) {
    const own = workHandoffRow(
      { ...handoff, forwardedAt: undefined, workChatId: linked?.workChatId ?? null, acceptedAt: linked?.acceptedAt ?? null, ...(linked?.state === undefined ? {} : { state: linked.state }) },
      note, chats, projects, agents, byId, checkoutStatus, live,
    )
    const { report: _report, ...rest } = own
    return {
      ...rest,
      // Accepted in the DM already, so the card never offers Accept again.
      acceptedAt: handoff.acceptedAt,
      forwarded: {
        threadChatId: liveThreadId ?? null,
        // Ready only while the linked Session waits, as on its own card.
        phase: linked?.goalConfirmedAt !== undefined ? 'confirmed'
          : linked?.goalReport !== undefined && own.session !== 'working' && own.session !== 'waiting' && own.session !== 'background' ? 'ready'
            : linked?.acceptedAt != null ? 'working' : 'starting',
        ...(linked?.goalCompletion?.operation === 'none' ? { nothingToCommit: true } : {}),
      },
    }
  }
  const target = handoff.workChatId === null ? undefined : chats.find((chat) => chat.id === handoff.workChatId)
  const lead = agents.find((agent) => agent.id === handoff.leadAgentId)
  const supporting = handoff.supportingAgentIds.map((agentId, index) => {
    const agent = agents.find((candidate) => candidate.id === agentId)
    return { id: agentId, name: agent?.name ?? handoff.supportingAgentNames[index] ?? agentId }
  })
  const status =
    handoff.state === 'deleted' || (target === undefined && (handoff.workChatId !== null || handoff.acceptedAt !== null))
      ? 'Deleted'
      : target !== undefined && target.archivedAt !== null
        ? 'Archived'
        : handoff.state === 'settled' || (target !== undefined && target.settledAt !== null)
          ? 'Settled'
          : 'Working'
  const report = workReport(handoff, target, checkoutStatus, lead?.name ?? handoff.leadAgentName, agents)
  const replacement = status === 'Deleted' ? undefined : currentRevision(handoff, byId)
  const changedAfterReady = note?.workHandoffPhase === 'reopened' && note.workChangedAfterReady === true &&
    status === 'Working' && report === undefined
  return {
    kind: 'work_handoff',
    key: `work:${handoff.id}`,
    handoffId: handoff.id,
    projectId: handoff.projectId,
    workChatId: handoff.workChatId,
    title: target?.title ?? handoff.title,
    ...(handoff.task === undefined ? {} : { task: handoff.task }),
    ...(handoff.summary === undefined ? {} : { summary: handoff.summary }),
    projectName: project?.name ?? handoff.projectName,
    projectIcon: project?.icon ?? DEFAULT_PROJECT_ICON,
    projectColor: project?.color ?? DEFAULT_PROJECT_COLOR,
    leadAgentId: handoff.leadAgentId,
    leadAgentName: lead?.name ?? handoff.leadAgentName,
    firstExecutorName: handoff.firstExecutor === undefined
      ? lead?.name ?? handoff.leadAgentName
      : agents.find((agent) => agent.id === handoff.firstExecutor?.agentId)?.name ?? handoff.firstExecutor.agentName,
    supportingAgentIds: supporting.map((agent) => agent.id),
    supportingAgentNames: supporting.map((agent) => agent.name),
    ...(handoff.authorAgentId === SINGLE_CHAT_VOICE.id ? { threadAuthored: true as const }
      : liveThreadId !== undefined ? { threadBound: true as const } : {}),
    ...(handoff.proposedRuntime === undefined ? {} : { proposedRuntime: handoff.proposedRuntime }),
    ...(handoff.attachments === undefined || handoff.attachments.length === 0 ? {} : {
      attachments: handoff.attachments.map((attachment) => attachment.name),
      ...(handoff.attachments.every((attachment) => attachment.kind === 'image') ? { attachmentsAllImages: true as const } : {}),
    }),
    status,
    session: sessionStatus(handoff, target, target === undefined ? QUIET_SESSION : live(target.id)),
    result: handoff.result,
    ...((handoff.revision ?? 1) > 1 ? { revision: handoff.revision } : {}),
    ...(replacement === undefined ? {} : { replacedBy: { key: `work:${replacement.id}`, revision: replacement.revision ?? 1 } }),
    acceptedAt: handoff.acceptedAt,
    ...(report === undefined ? {} : { report }),
    ...(changedAfterReady ? { changedAfterReady: true as const } : {}),
    ...(target === undefined ? {} : { mode: target.mode ?? 'house' }),
    ...(target?.singleDriver === undefined ? {} : { singleDriver: target.singleDriver }),
    ...(target?.singleOverride?.model === undefined ? {} : { singleModel: target.singleOverride.model }),
    worktreeAvailable: ((checkoutStatus[target?.id ?? handoff.projectId] ?? checkoutStatus[handoff.projectId])?.gitRoots.some((root) => project?.repoPaths.includes(root)) ?? false),
    worktreeBranch: target?.checkout.mode === 'worktree' ? target.checkout.branch : null,
  }
}

/**
 * The newest revision that replaced this proposal, following v1 to v2 to v3, so an old
 * card always points at the one that still counts. Undefined when nothing replaced it
 * or the replacement is not in the directory.
 */
function currentRevision(handoff: WorkHandoff, byId: ReadonlyMap<string, WorkHandoff>): WorkHandoff | undefined {
  let current: WorkHandoff | undefined
  const seen = new Set([handoff.id])
  for (let next = handoff.supersededById; next !== undefined && !seen.has(next); next = current?.supersededById) {
    const found = byId.get(next)
    if (found === undefined) break
    seen.add(next)
    current = found
  }
  return current
}

/** The notes that place an assignment's card: its proposal, each result, each reopening. Settled notes only update it. */
function isCardNote(event: SystemEvent): boolean {
  if (event.type !== 'system_note' || event.workHandoffId === undefined) return false
  const phase = event.workHandoffPhase
  return phase === 'created' || phase === 'reopened' || (phase === undefined && event.workHandoffVersion !== undefined)
}

/** The result the user decides on, while the Session holds one. Feedback clears it until the next report. */
function workReport(
  handoff: WorkHandoff,
  target: Chat | undefined,
  checkoutStatus: Readonly<Record<string, Extract<ServerMessage, { type: 'checkout_status' }>>>,
  leadAgentName: string,
  agents: readonly AgentConfig[],
): WorkResult | undefined {
  const report = handoff.goalReport
  if (report === undefined) return undefined
  const open = handoff.state === 'active' && target !== undefined && target.settledAt === null && target.archivedAt === null
  const decision: WorkResult['decision'] = handoff.goalConfirmedAt !== undefined ? 'accepted' : open ? 'open' : 'closed'
  const worktree = target?.checkout.mode === 'worktree'
  const mergeInto = worktree ? goalMergeTarget(checkoutStatus[target.id]) : undefined
  const completion = decision === 'accepted' ? handoff.goalCompletion : undefined
  const files = handoff.goalCompletion?.repos.reduce((count, repo) => count + repo.files.length, 0) ?? handoff.goalChangedFiles?.length ?? 0
  // A Multiple result that changed code could only be marked ready after Argus passed it.
  // Single has no reviewer persona to name; its review ran as a subagent.
  const reviewed = target?.mode !== 'single' && handoff.goalChangedFiles?.some((file) => !isProseFile(file)) === true
  return {
    handoffId: handoff.id,
    workChatId: handoff.workChatId,
    version: handoff.version,
    result: report.result,
    ...(report.limitations === undefined ? {} : { limitations: report.limitations }),
    ...(report.points === undefined || report.points.length === 0 ? {} : { points: report.points }),
    ...(report.choices === undefined || report.choices.length === 0 ? {} : { choices: report.choices }),
    leadAgentName,
    files,
    ...(reviewed ? { reviewer: agents.find((agent) => agent.id === CODE_REVIEWER_ID)?.name ?? 'Argus' } : {}),
    operation: handoff.goalCompletion?.operation === 'none' ? 'none' : 'commit',
    ...(mergeInto === undefined ? {} : { mergeInto }),
    worktree,
    decision,
    // Only linked ones: the server signs each stored screenshot on its way to a client.
    evidence: (report.evidence ?? []).flatMap((item) => item.src === undefined ? [] : [{
      name: item.name, src: item.src,
      ...(item.width === undefined ? {} : { width: item.width }),
      ...(item.height === undefined ? {} : { height: item.height }),
    }]),
    ...(completion === undefined ? {} : {
      completion: {
        status: completion.status,
        operation: completion.operation,
        ...(completion.repos[0]?.mergeInto === undefined ? {} : { mergeInto: completion.repos[0].mergeInto }),
        ...(completion.message === undefined ? {} : { message: completion.message }),
        ...(completion.retryRefused === undefined ? {} : { retryRefused: completion.retryRefused }),
        ...(completion.merge === undefined ? {} : { merge: mergeView(completion.merge) }),
      },
    }),
  }
}

/** What a card shows of Manor's merge; the approvals and verified tips stay server-side. */
export type WorkMergeView = Pick<WorkMerge, 'stage' | 'after' | 'ahead' | 'fix'> & { trouble?: NonNullable<WorkMerge['trouble']>['kind'] }

const FIXING: Record<NonNullable<WorkMergeView['trouble']>, string> = {
  conflict: 'Resolving a conflict…',
  hook: 'Fixing a failing hook…',
  rebase: 'Fixing the rebase…',
}

const mergeView = ({ stage, after, ahead, fix, trouble }: WorkMerge): WorkMergeView => ({
  stage,
  ...(after === undefined ? {} : { after }),
  ...(ahead === undefined ? {} : { ahead }),
  ...(fix === undefined ? {} : { fix }),
  ...(trouble === undefined ? {} : { trouble: trouble.kind }),
})

/**
 * Said when the connection drops before Manor answers Accept or Request changes. The
 * outcome is unknown, not failed: the card shows it once Manor is back, and a repeat
 * against the same version is refused if the first one landed.
 */
export const WORK_RESULT_CONNECTION_LOST = 'The connection dropped before Manor answered. This card shows the outcome once Manor is back.'

/** One state word on a card or a bar row, with the tone it is drawn in. */
export interface WorkStatus {
  /** `waiting` is a question on the user; `warn` is a commit that did not land, said in the card's body. */
  tone: 'busy' | 'ready' | 'ok' | 'warn' | 'waiting' | 'dim'
  text: string
}

/**
 * What Confirm does, said in its tooltip before the click. Undefined when the Session
 * changed no files, since then Confirm only records the decision.
 */
export function workConfirmTitle(result: WorkResult): string | undefined {
  if (result.operation === 'none') return undefined
  const reviewed = result.reviewer === undefined ? '' : 'reviewed '
  const files = result.files === 1 ? `the ${reviewed}file` : `the ${result.files} ${reviewed}files`
  return result.mergeInto === undefined
    ? `Commits ${files}.`
    : `Commits ${files} and merges ${result.files === 1 ? 'it' : 'them'} into ${result.mergeInto}.`
}

/**
 * The two actions on a result, on its card and in every bar (2026-10-14). They follow
 * from what will land: a result with nothing to commit is closed or followed up, one
 * with files is confirmed (which commits them) or sent back with Request changes. Close
 * and Follow up are Confirm and Request changes underneath.
 */
export function workResultActionLabels(result: Pick<WorkResult, 'operation'>) {
  return result.operation === 'none'
    ? { secondary: 'Follow up', primary: 'Close', pending: 'Closing…' } as const
    : { secondary: 'Request changes', primary: 'Confirm', pending: 'Confirming…' } as const
}

/**
 * The result card's lines (2026-11-07): the lead's points, or for a report written
 * before them, the sentences of its result, so an older card reads in the same style.
 * Never more than `MAX_GOAL_POINTS`; the whole report stays in the Session.
 */
export function workResultLines(result: Pick<WorkResult, 'result' | 'points'>): string[] {
  if (result.points !== undefined && result.points.length > 0) return result.points.slice(0, MAX_GOAL_POINTS)
  const lines: string[] = []
  let rest = result.result.replace(/\s+/g, ' ').trim()
  while (rest !== '' && lines.length < MAX_GOAL_POINTS) {
    const sentence = firstSentence(rest)
    lines.push(sentence.trim())
    rest = rest.slice(sentence.length).trim()
  }
  return lines
}

/** "2 files" on the footer of a result that lands files, until it closes; the Mac's opens the diff. */
export function workResultFiles(result: Pick<WorkResult, 'operation' | 'files' | 'decision'>): string | undefined {
  if (result.operation === 'none' || result.files === 0 || result.decision === 'closed') return undefined
  return `${result.files} ${result.files === 1 ? 'file' : 'files'}`
}

/** The open choices the card shows as buttons, and how many more the report holds. */
export function workResultChoiceList(result: Pick<WorkResult, 'choices'>): { choices: readonly GoalChoice[]; more: number } {
  const choices = result.choices ?? []
  return { choices: choices.slice(0, GOAL_CHOICES_SHOWN), more: Math.max(0, choices.length - GOAL_CHOICES_SHOWN) }
}

/**
 * A choice's option, picked on the card, written into the Follow up text as one line,
 * "Title: option". A second pick for the same choice replaces only the line an earlier
 * pick wrote; everything else the user wrote stays.
 */
export function pickWorkChoice(text: string, choice: Pick<GoalChoice, 'title' | 'options'>, option: string): string {
  const picks = new Set(choice.options.map((each) => workChoiceLine(choice.title, each)))
  const lines = text.split('\n').filter((line) => !picks.has(line))
  while (lines.length > 0 && lines.at(-1)!.trim() === '') lines.pop()
  return [...lines, workChoiceLine(choice.title, option)].join('\n')
}

const workChoiceLine = (title: string, option: string): string => `${title}: ${option}`

/** Whether the Follow up text already carries this option for its choice. */
export const workChoicePicked = (text: string, title: string, option: string): boolean =>
  text.split('\n').includes(workChoiceLine(title, option))

/**
 * Whether the Follow up text asks the Session for a change: any line beyond a pick of a
 * choice's `noChange` option. After a pick the card opens Follow up only when it does,
 * so a no-change pick leaves Confirm in place. A line another choice also writes as a
 * change counts as a change.
 */
export function workChangesAsked(text: string, choices: readonly Pick<GoalChoice, 'title' | 'options' | 'noChange'>[] = []): boolean {
  const changes = new Set(choices.flatMap((choice) => choice.options.filter((option) => option !== choice.noChange).map((option) => workChoiceLine(choice.title, option))))
  const kept = new Set(choices.flatMap((choice) => choice.noChange === undefined ? [] : [workChoiceLine(choice.title, choice.noChange)]).filter((line) => !changes.has(line)))
  return text.split('\n').some((line) => line.trim() !== '' && !kept.has(line))
}

/**
 * Why Confirm (or Close) waits on the card's choices, said in its tooltip, or undefined
 * when it may go (2026-11-20). It waits until every choice the card shows has a pick, and
 * after that while the Follow up text asks a change, which goes with Request changes
 * instead. A result without choices never waits here. Every Confirm surface reads this,
 * with the same Follow up text, so the card, the bar and the phone agree.
 */
export function workConfirmWait(text: string, result: Pick<WorkResult, 'choices'>): string | undefined {
  const { choices } = workResultChoiceList(result)
  if (choices.length === 0) return undefined
  if (!choices.every((choice) => choice.options.some((option) => workChoicePicked(text, choice.title, option)))) return 'Pick an answer first'
  return workChangesAsked(text, result.choices) ? 'Your answer asks for a change, so send it instead' : undefined
}

/**
 * A result that waits on the user right now: open, and its Session finished. A Session the user
 * sent a new instruction keeps its result open, but reads Working, or Waiting while it
 * asks the user something, until it ends.
 */
export const workResultWaits = (row: Pick<WorkHandoffRow, 'report' | 'session'>): boolean =>
  row.report?.decision === 'open' && row.session === 'ready'

/** What happened after Confirm, in one short status. Success shows only once Git shows it. */
export function workResultStatus(result: WorkResult): WorkStatus | null {
  if (result.decision !== 'accepted') return null
  // Close on a result with nothing to commit ends there (2026-10-14).
  if (result.operation === 'none') return { tone: 'ok', text: 'Closed' }
  const completion = result.completion
  if (completion === undefined || completion.operation === 'none') return { tone: 'ok', text: 'Confirmed' }
  const merge = completion.operation === 'merge'
  if (completion.status === 'complete') {
    return { tone: 'ok', text: merge && completion.mergeInto !== undefined ? `Merged into ${completion.mergeInto}` : 'Committed' }
  }
  // Git does not show it landing and the commit turn is over; the reason is `workBlockedReason`.
  if (completion.status === 'blocked') return { tone: 'warn', text: merge ? 'Merge blocked' : 'Commit blocked' }
  switch (completion.merge?.stage) {
    // Busy, not dim: a dim status reads as a finished card and folds to one line.
    case 'queued': {
      const after = completion.merge.after
      if (after === undefined) return { tone: 'busy', text: 'Merging next' }
      return { tone: 'busy', text: `${(completion.merge.ahead ?? 1) > 1 ? 'Waiting to merge' : 'Merging next'}, after ${after}` }
    }
    case 'fixing':
      return { tone: 'busy', text: FIXING[completion.merge.trouble ?? 'rebase'] }
    case 'approve':
      return { tone: 'warn', text: 'Conflict fix awaits you' }
  }
  return { tone: 'busy', text: merge ? 'Merging…' : 'Committing…' }
}

/** The conflict fix a confirmed card holds for the user's approval, or undefined when it holds none. */
export function workMergeFix(result: WorkResult) {
  const merge = result.completion?.merge
  return result.decision === 'accepted' && merge?.stage === 'approve' ? merge.fix : undefined
}

/** A fix's diff as lines the card colours: what the fix added, removed, or the headers around them. */
export function mergeFixLines(diff: string): { text: string; kind: 'add' | 'remove' | 'meta' | 'context' }[] {
  return diff.split('\n').map((text) => ({
    text,
    kind: /^(?:diff |index |--- |\+\+\+ |@@)/.test(text) ? 'meta' : text.startsWith('+') ? 'add' : text.startsWith('-') ? 'remove' : 'context',
  }))
}

/**
 * A result screenshot's thumbnail width for its height: its own shape, held between
 * portrait and wide so a phone shot is no sliver and a wide one no ribbon.
 */
export const evidenceThumbnailRatio = (item: WorkResult['evidence'][number]): number =>
  item.width === undefined || item.height === undefined ? 16 / 10 : Math.min(16 / 9, Math.max(3 / 4, item.width / item.height))

/**
 * How many result screenshots a row `available` px wide shows in full, given each
 * thumbnail's width, the gap between them and the width of the "+N" tile that stands
 * for the rest. All of them when they fit, otherwise as many as fit beside the tile,
 * never fewer than one.
 */
export function evidenceVisibleCount(widths: readonly number[], available: number, gap: number, tile: number): number {
  const total = widths.reduce((sum, width) => sum + width, 0) + gap * Math.max(0, widths.length - 1)
  if (total <= available) return widths.length
  let used = tile
  let count = 0
  for (const width of widths) {
    if (used + gap + width > available) break
    used += gap + width
    count += 1
  }
  return Math.max(1, count)
}

/**
 * The one line under Merge blocked or Commit blocked: why, as Git read it, or the
 * plain fact when an older server sent no reason. Undefined for anything else.
 */
export function workBlockedReason(result: WorkResult): string | undefined {
  const completion = result.completion
  if (result.decision !== 'accepted' || completion?.status !== 'blocked') return undefined
  // Servers before 2026-10-11 wrote the instruction itself here; the card has its own Open Session.
  const message = completion.message?.replace(/\s*Open the Session to continue\.$/, '')
  if (message !== undefined && message.length > 0) return message
  return completion.operation === 'merge' ? "The merge didn't land." : "The commit didn't land."
}

/**
 * The status an assignment's card names in its header, one at a time. Working, Waiting
 * or Done come from the Session's shared status, then Ready, then the commit after
 * Confirm, then how the Session ended. A commit that did not land is `warn`: Merge blocked
 * or Commit blocked in the header, its reason in the body, Working again once a turn runs
 * on it. Null while a proposal waits for the user, since its actions already say that.
 */
export function workCardStatus(row: WorkHandoffRow): WorkStatus | null {
  if (row.status === 'Archived' || row.status === 'Deleted') return { tone: 'dim', text: row.status }
  const result = row.report
  if (result?.decision === 'accepted') {
    const status = workResultStatus(result)
    // A closed Session runs no commit any more, so a pending one claims nothing.
    if (status?.tone === 'busy' && row.status === 'Settled') return { tone: 'dim', text: 'Settled' }
    // The user asked the Session to retry a blocked merge: it is working on it now.
    return status?.tone === 'warn' && row.session === 'working' ? SESSION_CARD_STATUS.working ?? status : status
  }
  if (result?.decision === 'open') return row.session === 'ready' ? READY : SESSION_CARD_STATUS[row.session] ?? READY
  if (row.status === 'Settled') return { tone: 'ok', text: 'Settled' }
  if (row.acceptedAt === null || result !== undefined) return null
  return SESSION_CARD_STATUS[row.session] ?? null
}

const READY: WorkStatus = { tone: 'ready', text: 'Ready' }

/** The live part of a card's header, the words its overview row and project row also claim. */
const SESSION_CARD_STATUS: Partial<Record<SessionStatus, WorkStatus>> = {
  working: { tone: 'busy', text: 'Working' },
  waiting: { tone: 'waiting', text: 'Waiting' },
  // Work it started runs on and will wake it: no spinner, not the user's move, and not
  // finished either, which `dim` would claim.
  background: { tone: 'ready', text: 'Waiting' },
  done: { tone: 'ready', text: 'Done' },
}

/**
 * A finished card is one line: its title, the first sentence of what came of it, and
 * the outcome. A commit or merge Git shows landed reads by what landed instead,
 * "Export, 3 files" beside Merged into main. Null while the card still has something to
 * show or decide, including a commit Git says did not land, which keeps the card and its
 * warning.
 */
export function workCardLine(row: WorkHandoffRow): { summary: string; status: WorkStatus } | null {
  if (row.replacedBy !== undefined || closedWorkHandoff(row) !== null) return null
  const status = workCardStatus(row)
  if (status === null || (status.tone !== 'ok' && status.tone !== 'dim')) return null
  const files = landedFiles(row.report)
  if (files !== undefined) return { summary: files, status }
  return { summary: firstSentence(splitWorkOutcome(row.report?.result ?? row.result ?? '').lead), status }
}

/** "3 files" for a confirmed result whose commit or merge Git shows landed; undefined otherwise. */
function landedFiles(result: WorkResult | undefined): string | undefined {
  const completion = result?.completion
  if (result?.decision !== 'accepted' || completion?.status !== 'complete' || completion.operation === 'none' || result.files === 0) return undefined
  return `${result.files} ${result.files === 1 ? 'file' : 'files'}`
}

/** Words a full stop follows inside a sentence, English and Dutch. */
const ABBREVIATIONS = new Set(['dr', 'mr', 'mrs', 'ms', 'st', 'vs', 'cf', 'nr', 'ca', 'bv', 'bijv', 'dhr', 'mevr', 'zgn', 'incl', 'excl'])

/**
 * Up to the first stop that ends a sentence. A full stop after a known abbreviation, an
 * initial or inside a dotted abbreviation does not count, so "Dr. Smith", "J. Smith"
 * and "e.g. this" stay whole while "Fixed it." ends.
 */
export function firstSentence(text: string): string {
  const pattern = /(\S+)([.!?])(?=\s|$)/g
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const word = match[1]!
    const letters = word.replace(/[^\p{L}]/gu, '')
    if (match[2] === '.' && (word.includes('.') || /^\p{Lu}$/u.test(letters) || ABBREVIATIONS.has(letters.toLowerCase()))) continue
    return text.slice(0, match.index + match[0].length)
  }
  return text
}

/**
 * How a proposal that never ran reads on its card: one struck line with this word.
 * Null for every card that still carries something to read or decide. Only a
 * proposal without a Work chat counts as rejected: legacy handoffs owned their chat
 * from the start and settled with a null `acceptedAt`, so their thread stays reachable.
 */
export function closedWorkHandoff(row: WorkHandoffRow): 'Rejected' | 'Deleted' | null {
  if (row.status === 'Deleted') return 'Deleted'
  return row.status === 'Settled' && row.acceptedAt === null && row.workChatId === null ? 'Rejected' : null
}

/** One kind of write to one file, as a footnote under a project thread reply names it. */
export interface FileWriteGroup {
  label: string
  lines: string[]
  /** The write behind each line, in the same order, for the Undo each line offers. */
  writes: ProjectFileWrite[]
}

const WRITE_VERB: Record<ProjectFileWrite['action'], (lines: string, file: string) => string> = {
  add: (lines, file) => `Saved ${lines} to ${file}`,
  replace: (lines, file) => `Updated ${lines} in ${file}`,
  remove: (lines, file) => `Removed ${lines} from ${file}`,
  restore: (_lines, file) => `Restored ${file}`,
  create: (_lines, file) => `Created ${file}`,
}

/**
 * A turn's memory writes, one group per action and file in the order they first
 * happened: "Saved 2 lines to preferences.md", "Updated 1 line in notes.md", "Saved 1
 * line to its notes". Each group keeps the lines it touched, which the footnote shows
 * when it is opened, and the write behind each line for its Undo.
 */
export function fileWriteGroups(writes: readonly ProjectFileWrite[]): FileWriteGroup[] {
  const groups = new Map<string, ProjectFileWrite[]>()
  for (const write of writes) {
    const key = `${write.action}\0${write.file}`
    groups.set(key, [...groups.get(key) ?? [], write])
  }
  return [...groups.values()].map((group) => {
    const kept = group.filter((write) => (projectFileWriteDetail(write) ?? '') !== '')
    return {
      label: WRITE_VERB[group[0]!.action](`${group.length} ${group.length === 1 ? 'line' : 'lines'}`, writtenFileName(group[0]!)),
      lines: kept.map((write) => projectFileWriteDetail(write)!),
      writes: kept,
    }
  })
}

/**
 * The shape a Session's card takes in its project thread (2026-10-11): one card that
 * changes. A proposal is the full card with Accept and Reject; a result waiting for
 * Confirm, or a commit that did not land, keeps the full card because the user acts on it;
 * an accepted Session is one line with its state; a finished one is one line with its
 * outcome. The line's word is the overview group of the row's shared `session` status,
 * so the line and the overview never disagree about Working and Needs you.
 */
export type ThreadWorkCard =
  | { shape: 'proposal' }
  | { shape: 'full' }
  | { shape: 'line'; status: WorkStatus }
  | { shape: 'done'; summary: string; status: WorkStatus }

export const THREAD_SESSION_STATUS: Record<SessionGroup, WorkStatus> = {
  working: { tone: 'busy', text: 'Working' },
  waiting: { tone: 'warn', text: 'Needs you' },
  background: { tone: 'ready', text: 'Waiting' },
  // Muted until the user confirms it; Confirmed carries the green.
  settled: { tone: 'dim', text: 'Done' },
}

/**
 * A finished Session in its thread reads Done, or Confirmed once the user accepted its
 * result, never the commit detail or branch name the Session's own card carries.
 * Archived and Deleted keep their word. A Session stopped before Git showed its commit
 * keeps the neutral tone and reads Done, since Confirmed would claim the commit landed.
 */
function threadOutcome(row: WorkHandoffRow, status: WorkStatus): WorkStatus {
  if (row.status === 'Archived' || row.status === 'Deleted') return status
  if (row.report?.decision !== 'accepted') return THREAD_SESSION_STATUS.settled
  if (status.tone !== 'ok') return { tone: status.tone, text: 'Done' }
  if (row.report.operation === 'none') return { tone: 'ok', text: 'Closed' }
  // What Git shows landed, Merged into main or Committed, says more than the click.
  return row.report.completion?.status === 'complete' ? status : { tone: 'ok', text: 'Confirmed' }
}

/** The overview's groups, as the thread's card reads them. Same names as `SessionOverviewGroup`. */
export type SessionGroup = NonNullable<ReturnType<typeof sessionGroup>>

export function threadWorkCard(row: WorkHandoffRow): ThreadWorkCard {
  const group = sessionGroup(row.session) ?? undefined
  if (workProposalOpen(row)) return { shape: 'proposal' }
  const done = workCardLine(row)
  if (done !== null) return { shape: 'done', summary: done.summary, status: threadOutcome(row, done.status) }
  const own = workCardStatus(row)
  if (row.report?.decision === 'open' || own?.tone === 'warn') return { shape: 'full' }
  // After Confirm the card's own word follows the commit: Committing…, then done.
  if (row.report?.decision === 'accepted' && own !== null) return { shape: 'line', status: own }
  // Settled in the overview before this card heard of it still reads as done.
  if (group === 'settled') return { shape: 'done', summary: firstSentence(splitWorkOutcome(row.result ?? '').lead), status: THREAD_SESSION_STATUS.settled }
  return { shape: 'line', status: group === undefined ? own ?? THREAD_SESSION_STATUS.working : THREAD_SESSION_STATUS[group] }
}

/** A card in a thread that waits on the user: a proposal to accept, or a Session result to accept. */
export interface OpenWorkDecision {
  kind: 'proposal' | 'result'
  row: WorkHandoffRow
}

/** A proposal that can still be accepted. Rejected, deleted and settled ones cannot. */
export const workProposalOpen = (row: WorkHandoffRow): boolean => row.acceptedAt === null && row.status === 'Working'

/** Whether a card waits on the user: a proposal to accept, or a result to confirm. */
export const workDecisionOpen = (row: WorkHandoffRow): boolean => row.report?.decision === 'open' || workProposalOpen(row)

/**
 * The cards this thread waits on the user for, newest first, which is what the bar above
 * the composer lists. An accepted, rejected, replaced or settled card drops out on its
 * own, because the directory update that closes it also re-projects the rows. Cards in
 * `inView` show in the thread right now, so the bar leaves them out.
 */
export function openWorkDecisions(rows: readonly Row[], inView: ReadonlySet<string> = NONE_IN_VIEW): OpenWorkDecision[] {
  const open: OpenWorkDecision[] = []
  for (const row of rows) {
    if (row.kind !== 'work_handoff' || inView.has(row.key)) continue
    if (workResultWaits(row)) open.unshift({ kind: 'result', row })
    else if (workProposalOpen(row)) open.unshift({ kind: 'proposal', row })
  }
  return open
}

const NONE_IN_VIEW: ReadonlySet<string> = new Set()

/** A vertical stretch on screen, in one coordinate space. */
export interface ScreenSpan { top: number; bottom: number }

/**
 * Whether a card counts as shown in the visible part of the thread: at least half of
 * it, or for a card taller than that part, at least half of the part. The bar above
 * the composer hides a card's row while this holds.
 */
export function workCardInView(card: ScreenSpan, view: ScreenSpan): boolean {
  const shown = Math.min(card.bottom, view.bottom) - Math.max(card.top, view.top)
  return shown > 0 && shown >= Math.min(card.bottom - card.top, view.bottom - view.top) / 2
}

/**
 * The outcome writer puts its conclusion alone on the first line; cards set that line
 * apart from what follows. Splitting on the line break, not the first period, keeps
 * "Dr." or "e.g." inside the conclusion.
 */
export function splitWorkOutcome(result: string): { lead: string; rest: string } {
  const [lead = '', ...rest] = result.trim().split('\n')
  return { lead: lead.trim(), rest: rest.join('\n').trim() }
}

/** The question a chat is blocked on, with the persona whose turn is waiting on it. */
export interface OpenAsk {
  requestId: string
  agentId: string
  questions: UserInputQuestion[]
  /** How many further questions are open behind this one, usually none. */
  more: number
}

/**
 * The question this transcript is waiting on, oldest first, or null.
 *
 * Oldest and not newest: a second request arriving while the first is half answered
 * used to take the card over, which threw away everything already picked and read as
 * the card resetting itself. They queue instead, and the next one appears when this
 * one is answered.
 *
 * Only a running turn's: answerability is a fact about the process, not about the
 * transcript. A question whose turn is over can no longer be answered by anyone, so
 * it stays where it stands and says so, rather than being pinned over the composer
 * looking live.
 */
export function openAsk(rows: Row[]): OpenAsk | null {
  let first: Omit<OpenAsk, 'more'> | null = null
  let more = 0
  for (const row of rows) {
    if (row.kind !== 'turn' || row.live?.state !== 'running') continue
    for (const ask of row.asks ?? []) {
      if (ask.answers !== undefined) continue
      if (first === null) {
        first = { requestId: ask.requestId, agentId: row.agentId, questions: ask.questions }
      } else {
        more += 1
      }
    }
  }
  return first === null ? null : { ...first, more }
}

/**
 * The one empty image list every message without pictures shares, which is nearly all
 * of them. Durable rows stay cached across stream deltas, and sharing this list keeps
 * those cached props stable too. Never mutated: images only arrive by replacement.
 */
const NO_IMAGES: EventImage[] = []

/** Adds one durable assistant message to the turn's lossless timeline. */
function appendSay(turn: TurnRow, event: AgentEvent): void {
  const images = event.images ?? NO_IMAGES
  const step: SayStep = {
    kind: 'say',
    key: event.id,
    text: event.text,
    images,
    startedAt: event.ts,
    ...(event.messageId === undefined ? {} : { messageId: event.messageId }),
    quoteSources: [{ eventId: event.id, text: event.text }],
    ...(event.interrupted === true ? { interrupted: true as const } : {}),
  }
  turn.activities.push(step)
  turn.timeline.push(step)
}

/**
 * An edits segment that only touched the user's memory folder daily log. Matched on the path
 * because it holds for both branches of the memory rule: a local append lands under
 * `.../memory/daily/`, a cloud relay file under `memory/daily/cloud/`.
 */
const isMemoryLog = (segment: TurnEdits): boolean =>
  segment.edits.every((edit) => edit.path.includes('memory/daily/'))

/**
 * Cuts the timeline into folded work and the assistant text that stays in the chat.
 *
 * The sentence is the boundary, and the only one. A message closes the block before
 * it and the next step opens a new one, so within one block the steps gather into a
 * single run and the file changes into a single group however the two interleaved.
 * That costs strict chronology inside a block and buys back what the block is: one
 * act, already named by the sentence above it. "I'll move that" splitting into three
 * edit groups because a read fell between them showed three acts where there was one.
 * A DM keeps every provider-authored message standing as its own beat. Work preserves
 * the older reading: intermediate narration folds with the work and adjacent closing
 * messages become one output. Tool calls, reasoning and edits remain in the existing
 * fold. A trailing card still stands where the answer boundary puts it, so asks,
 * todos and drafts keep their settled behaviour.
 *
 * Nothing is moved out of `activities`: this is a second reading of the same list, so
 * the record stays whole no matter how it is presented.
 */
function joinReplyText(before: string, after: string): string {
  if (before.length === 0) return after
  if (after.length === 0) return before
  return `${before}\n\n${after}`
}

/**
 * Work keeps the old readable answer blocks: adjacent provider messages are one
 * output until a tool or standing card starts a new act. DMs keep the lossless
 * provider boundary because each message becomes an actionable bubble there.
 */
function presentationTimeline(turn: TurnRow, dmBeats: boolean): TurnTimelineItem[] {
  if (dmBeats) return turn.timeline
  const timeline: TurnTimelineItem[] = []
  let reply: SayStep | undefined
  for (const step of withSteers(turn)) {
    if (step.kind === 'say') {
      if (reply === undefined) {
        reply = { ...step }
        timeline.push(reply)
      } else {
        reply.text = joinReplyText(reply.text, step.text)
        reply.quoteSources = [...reply.quoteSources, ...step.quoteSources]
        if (step.images.length > 0) reply.images = [...reply.images, ...step.images]
        if (step.live === true) reply.live = true
      }
      continue
    }
    timeline.push(step)
    if (step.kind === 'tool' || step.kind === 'todo' || step.kind === 'ask' || step.kind === 'draft' || step.kind === 'user') reply = undefined
  }
  return timeline
}

/**
 * Puts each inline steer where the user sent it. The saved event lands in the transcript
 * wherever the server wrote it, but the user sent it into a message that was still being
 * written, `steerAfter` characters in. Such a message, durable or still streaming, is
 * cut there and the steer stands between the halves, so the text is never repeated or
 * lost. A steer with no anchor, or whose message is not known (yet), stays where it
 * was saved. Streamed text only joins the timeline for a turn with a steer; every
 * other turn keeps reading exactly as before.
 */
function withSteers(turn: TurnRow): TurnTimelineItem[] {
  if (!turn.timeline.some((item) => item.kind === 'user')) return turn.timeline
  const items = [...turn.timeline]
  const known = new Set(items.flatMap((item) => item.kind === 'say' && item.messageId !== undefined ? [item.messageId] : []))
  for (const message of streamedMessages(turn.live)) {
    if (message.text.length === 0 || known.has(message.messageId)) continue
    known.add(message.messageId)
    items.push({
      kind: 'say', key: `live:${message.messageId}`, messageId: message.messageId, text: message.text,
      images: NO_IMAGES, startedAt: turn.live!.startedAt, quoteSources: [], live: true,
    })
  }
  type AnchoredMessage = { message: SayStep; offset: number; pieces: SayStep[]; users: TurnUser[] }
  const messages = new Map<string, AnchoredMessage>()
  for (const item of items) {
    if (item.kind === 'say' && item.messageId !== undefined) {
      messages.set(item.messageId, { message: item, offset: 0, pieces: [], users: [] })
    }
  }
  const anchored = new Map<TurnUser, AnchoredMessage>()
  for (const item of items) {
    const anchor = item.kind === 'user' && item.row.event.type === 'user_message'
      ? item.row.event.steerAfter
      : undefined
    const message = anchor === undefined ? undefined : messages.get(anchor.messageId)
    if (item.kind === 'user' && message !== undefined) {
      message.users.push(item)
      anchored.set(item, message)
    }
  }
  if (anchored.size === 0) return items
  const placed = new Set<TurnUser>()
  const out: TurnTimelineItem[] = []
  const piece = (state: AnchoredMessage, offset: number, final: boolean) => {
    const item = state.message
    const end = Math.max(state.offset, Math.min(offset, item.text.length))
    const text = item.text.slice(state.offset, end)
    state.offset = end
    if (text.length === 0 && !(final && item.images.length > 0)) return
    const next: SayStep = {
      ...item,
      key: state.pieces.length === 0 ? item.key : `${item.key}:${state.pieces.length}`,
      text,
      images: final ? item.images : NO_IMAGES,
      quoteSources: item.quoteSources.length === 1 ? [{ eventId: item.quoteSources[0]!.eventId, text }] : [],
    }
    delete next.interrupted
    state.pieces.push(next)
    out.push(next)
  }
  const placeUser = (user: TurnUser, state: AnchoredMessage) => {
    if (placed.has(user)) return
    piece(state, user.row.event.type === 'user_message' ? user.row.event.steerAfter!.textOffset : 0, false)
    out.push(user)
    placed.add(user)
  }
  for (const item of items) {
    if (item.kind === 'user' && anchored.has(item)) {
      placeUser(item, anchored.get(item)!)
    } else if (item.kind === 'say' && item.messageId !== undefined && messages.get(item.messageId)!.users.length > 0) {
      const state = messages.get(item.messageId)!
      // A completed message may reach storage before its steer. Its saved text
      // boundary still wins; later work stays after a steer already placed above.
      for (const user of state.users) placeUser(user, state)
      piece(state, item.text.length, true)
      if (item.interrupted === true && state.pieces.length > 0) state.pieces.at(-1)!.interrupted = true
    } else {
      out.push(item)
    }
  }
  return out
}

function segmentsOf(
  turn: TurnRow,
  running: boolean,
  dmBeats: boolean,
): { segments: TurnSegment[]; answer: TurnReply[]; tail: TurnStanding[] } {
  const segments: TurnSegment[] = []
  // Both stay open until the next thing the agent says, which is what makes the
  // sentence the only boundary. A step arriving after a write joins the run that is
  // already there rather than starting a second one below the files.
  let work: TurnWork | undefined
  let edits: TurnEdits | undefined

  // The turn's one draft block, wherever the first draft landed. Later drafts join it
  // rather than opening a second one below the narration that introduced them.
  let drafts: TurnDraft | undefined
  let afterEdit = false

  for (const step of presentationTimeline(turn, dmBeats)) {
    if (step.kind === 'draft') {
      work = undefined
      edits = undefined
      if (drafts === undefined) {
        drafts = { kind: 'draft', key: step.key, drafts: [step.draft] }
        segments.push(drafts)
      } else drafts.drafts.push(step.draft)
      continue
    }
    if (step.kind === 'user') {
      // The user speaking mid-turn ends the run before it and starts a new one after.
      work = undefined
      edits = undefined
      segments.push(step)
      continue
    }
    if (step.kind === 'todo' || step.kind === 'ask') {
      work = undefined
      edits = undefined
      segments.push(step)
      continue
    }
    if (isSayStep(step)) {
      if (step.text.length === 0 && step.images.length === 0) continue
      work = undefined
      edits = undefined
      segments.push({
        kind: 'reply', key: step.key, text: step.text, images: step.images, quoteSources: step.quoteSources,
        ...(step.interrupted === true ? { interrupted: true as const } : {}),
        ...(step.live === true ? { live: true } : {}),
      })
      continue
    }
    // A call that did not land is a step, never a change: it stays in the run, where
    // its own row and the failure line above it can find it, instead of becoming an
    // "Edited index.ts +12" for a write nobody confirmed.
    if (isToolStep(step) && landed(step) && step.edits !== undefined && step.edits.length > 0) {
      afterEdit = work !== undefined && work.steps.length > 0
      if (edits === undefined) {
        edits = { kind: 'edits', key: step.key, edits: [...step.edits] }
        segments.push(edits)
      } else edits.edits.push(...step.edits)
      continue
    }
    if (work === undefined) {
      work = { kind: 'work', key: `work:${step.key}`, steps: [] }
      segments.push(work)
    }
    if (afterEdit) (work.breaks ??= new Set()).add(step.key)
    afterEdit = false
    work.steps.push(step)
  }

  if (!dmBeats) {
    const answer: TurnReply[] = []
    const tail: TurnStanding[] = []
    if (!running) {
      const skipped: Array<TurnEdits | TurnWork> = []
      let movedCard = false
      for (;;) {
        const last = segments.at(-1)
        if (last?.kind === 'reply' || last?.kind === 'user' || ((last?.kind === 'todo' || last?.kind === 'ask' || last?.kind === 'draft') && skipped.length === 0)) {
          const standing = segments.pop() as TurnStanding
          tail.unshift(standing)
          if (standing.kind === 'reply') answer.unshift(standing)
          else if (standing.kind !== 'user') movedCard = true
        } else if (last?.kind === 'edits' && isMemoryLog(last)) {
          if (movedCard) break
          skipped.unshift(segments.pop() as TurnEdits)
        } else if (
          last?.kind === 'work' &&
          last.steps.length > 0 &&
          last.steps.every(isReasoningStep)
        ) {
          if (movedCard) break
          skipped.unshift(segments.pop() as TurnWork)
        } else break
      }
      segments.push(...skipped)
    }
    return { segments, answer, tail }
  }

  // In a DM every provider message is an actionable beat. It stays visible even
  // while later tool work runs; the trace remains independently foldable above it.
  const allSegments = [...segments]
  const answer = allSegments.filter((segment): segment is TurnReply => segment.kind === 'reply')
  const standingKeys = new Set(answer.map((reply) => reply.key))
  if (!running) {
    // A trailing daily-log write does not end the answer. Memory lives in the walls,
    // and a persona that logs between (or after) its closing sentences is doing
    // housekeeping, not work; without this, the log edit demotes the real answer
    // into the fold and only the sign-off survives. The skipped rows stay in the
    // fold, where the write remains reviewable.
    const skipped: Array<TurnEdits | TurnWork> = []
    let movedCard = false
    for (;;) {
      const last = segments.at(-1)
      if (last?.kind === 'reply' || ((last?.kind === 'todo' || last?.kind === 'ask' || last?.kind === 'draft') && skipped.length === 0)) {
        const standing = last as TurnStanding
        standingKeys.add(standing.key)
        segments.pop()
        if (standing.kind !== 'reply') movedCard = true
      } else if (last?.kind === 'edits' && isMemoryLog(last)) {
        if (movedCard) break
        skipped.unshift(segments.pop() as TurnEdits)
      } else if (
        last?.kind === 'work' &&
        last.steps.length > 0 &&
        last.steps.every(isReasoningStep)
      ) {
        if (movedCard) break
        skipped.unshift(segments.pop() as TurnWork)
      } else break
    }
    segments.push(...skipped)
  }
  const tail = allSegments.filter((segment): segment is TurnStanding => standingKeys.has(segment.key))
  return {
    segments: segments.filter((segment) => !standingKeys.has(segment.key)),
    answer,
    tail,
  }
}

interface DurableRows {
  /** Stable rows for the durable event array, already projected as finished. */
  rows: Row[]
  /** Unfinished durable groups before the finished-state sweep, for live projection. */
  open: Map<string, TurnRow>
  occurrences: Map<string, number>
  /** Messages still waiting for their own turn; they belong under everything running. */
  waiting: Row[]
  /** Non-DM steers whose turn has no durable event yet, by turn id; a live turn claims them. */
  unattached: Map<string, Extract<Row, { kind: 'event' }>[]>
}

const turnIdentity = (turnId: string, agentId: string): string => `${turnId}\0${agentId}`
const turnKey = (turnId: string, agentId: string, occurrence: number): string =>
  `turn:${turnId}:${agentId}${occurrence > 1 ? `:${occurrence}` : ''}`

/**
 * Event arrays are immutable. Keep their expensive durable transcript projection for
 * as long as that exact array lives, so a stream delta only projects its live turn.
 */
const durableRowsCache = new WeakMap<ThreadEvent[], Map<boolean, DurableRows>>()

/**
 * The rows last built for a thread, found by its first event, which every later array
 * of that thread still starts with. A rebuild hands back the row objects of this list
 * wherever a row did not change (`reuseRows`), so one new event redraws the rows it
 * changed and not every mounted row.
 */
const lastDurableRows = new WeakMap<ThreadEvent, Map<boolean, { rows: Row[]; waiting: Row[] }>>()

/**
 * A turn is mutable while it is assembled. Clone the linked timeline graph before a
 * live projection changes tool status or segment placement, without cloning payloads
 * such as images, edits and question definitions that are immutable contract data.
 */
function cloneTurn(turn: TurnRow): TurnRow {
  const activities = new Map<TurnActivity, TurnActivity>()
  for (const activity of turn.activities) activities.set(activity, { ...activity })
  const asks = new Map<AskRecord, AskRecord>()
  for (const ask of turn.asks) asks.set(ask, { ...ask })
  const drafts = new Map<DraftRecord, DraftRecord>()
  for (const draft of turn.drafts) drafts.set(draft, { ...draft })
  return {
    ...turn,
    asks: turn.asks.map((ask) => asks.get(ask)!),
    drafts: turn.drafts.map((draft) => drafts.get(draft)!),
    activities: turn.activities.map((activity) => activities.get(activity)!),
    timeline: turn.timeline.map((item) => {
      if (item.kind === 'ask') return { ...item, ask: asks.get(item.ask)! }
      if (item.kind === 'draft') return { ...item, draft: drafts.get(item.draft)! }
      if (item.kind === 'todo' || item.kind === 'user') return { ...item }
      return activities.get(item)!
    }),
    segments: [],
    answer: [],
    tail: [],
  }
}

/** Applies the status sweep and readable segment projection to one isolated turn. */
function finishTurn(turn: TurnRow, dmBeats: boolean): void {
  const running = turn.live?.state === 'running'
  const tools = turn.activities.filter(isToolStep)
  // "Last" is judged per scope: a subagent's steps run beside the turn's own, so the
  // newest child must not make its still-working parent look finished.
  const lastInScope = new Map<string | undefined, ToolStep>()
  for (const tool of tools) lastInScope.set(tool.parentToolCallId, tool)
  const liveParents = new Set(tools.flatMap((tool) => tool.status === 'running' && tool.toolCallId !== undefined ? [tool.toolCallId] : []))
  for (const activity of tools) {
    if (activity.status !== 'running') continue
    // A Manor-run child, and background work in a live session, outlive the turn that
    // started them. Manor always writes their result when they end, Stop and a restart
    // included, so such a row runs until that result. A stopped or failed turn keeps
    // no live session: its process went down with whatever it still ran.
    const outlives = activity.subagent?.childChatId !== undefined ||
      (activity.background === true && turn.note?.kind !== 'aborted' && turn.note?.kind !== 'error')
    if (outlives && activity.toolCallId !== undefined) continue
    // Legacy tool_use rows have no provider id and therefore no matching result.
    // Only the last one can plausibly still be current while the turn runs. A
    // subagent always answers with a result, and several can run side by side; so does
    // background work, which answers when it ends.
    const parentLive = activity.parentToolCallId === undefined || liveParents.has(activity.parentToolCallId)
    if (running && parentLive && (activity === lastInScope.get(activity.parentToolCallId) || isSubagentCall(activity) || activity.background === true)) continue
    // Background work still open when its turn ended went down with the process.
    activity.status = activity.background === true ? 'stopped' : turn.note?.kind === 'error' ? 'error' : 'done'
    // `done` here is the sweep giving up, not the provider answering. That only
    // means the call did not finish when the turn itself did not finish: a Stop or
    // a crash cuts the process mid-call, and the write it was making is a claim
    // nobody can back. A turn that ended normally is the opposite case: it did its
    // work and the missing echo is a gap in the transcript, not a failed write, and
    // treating those as unconfirmed would blank the edits of ordinary turns.
    if (turn.note !== undefined) activity.unconfirmed = true
  }
  // The plan's card reads as a sequence: one spinner while the turn works, none while
  // it compacts or after it ends.
  const end = running ? isCompacting(turn) ? 'compacting' : 'running' : turn.goalReached === true ? 'reached' : 'ended'
  if (turn.todos !== undefined) turn.todos = planTasks(turn.todos, end)
  for (const item of turn.timeline) if (item.kind === 'todo') item.todos = planTasks(item.todos, end)
  const read = segmentsOf(turn, running, dmBeats)
  turn.segments = read.segments
  turn.answer = read.answer
  turn.tail = read.tail
}

/**
 * One durable agent turn is one grouped visual unit. Its lossless provider messages
 * can project as DM beats or Work answer blocks; tool events stay in the same fold.
 */
function durableRowsOf(events: ThreadEvent[], dmBeats: boolean): DurableRows {
  const cached = durableRowsCache.get(events)?.get(dmBeats)
  if (cached !== undefined) return cached
  const rows: Row[] = []
  const groups: TurnRow[] = []
  const sentRelays = new Set<string>()
  /**
   * Only the groups still taking events. A turn id is unique per turn now, but every
   * transcript written before that reuses ids across server restarts, so a group is
   * closed by its own terminal event and an event from another persona opens a new
   * one. Without both, an old block swallows a later turn's replies and signs them
   * with the wrong name, halfway up the thread.
   */
  const open = new Map<string, TurnRow>()
  /**
   * Draft actions happen after the preparing turn has finished, so their closing
   * event cannot rely on that turn still being present in `open`.
   */
  const draftsById = new Map<string, DraftRecord>()
  // Where each connect card lives: a status swaps in a fresh record so memoised rows redraw.
  const connectTurns = new Map<string, TurnRow>()
  /**
   * Each turn's tool steps by call id, so a `tool_result` finds its step instead of
   * re-filtering the turn's whole activity list. That filter was quadratic within one
   * turn (2,9 ms at 400 steps) and ran again on every delta. The first step for a call
   * id wins, which is what `find` did, including the shared `undefined` key a driver
   * that sends no call id gives all of its steps.
   */
  const toolsByCall = new Map<TurnRow, Map<string | undefined, ToolStep>>()
  /**
   * The turn each launch row lives in, by turn identity and call id. A Manor-run child
   * outlives its turn, so its result arrives after the turn closed and must land on
   * the launch row rather than open an empty turn of its own.
   */
  const launchedIn = new Map<string, TurnRow>()
  const occurrences = new Map<string, number>()
  /** The newest group of each turn identity, open or closed, for notes written after it ended. */
  const latest = new Map<string, TurnRow>()
  /** The user's message rows by event id, for the notes that stand under one of them. */
  const userRows = new Map<string, Extract<Row, { kind: 'event' }>>()
  /** The newest group of each turn id, whoever spoke, for a project file write naming it. */
  const byTurnId = new Map<string, TurnRow>()
  /** Writes stored before any event of the turn they name. */
  const earlyWrites: { row: Row; write: ProjectFileWrite; turnId: string }[] = []

  const unattached = new Map<string, Extract<Row, { kind: 'event' }>[]>()

  const turnFor = (turnId: string, agentId: string, ts?: number): TurnRow => {
    const identity = turnIdentity(turnId, agentId)
    const known = open.get(identity)
    if (known !== undefined) {
      // Every event of the turn moves the end, so a finished turn knows how long it
      // worked without the live shell that is gone by then.
      if (ts !== undefined) known.endedAt = ts
      return known
    }
    const occurrence = (occurrences.get(identity) ?? 0) + 1
    occurrences.set(identity, occurrence)
    const created: TurnRow = {
      kind: 'turn',
      key: turnKey(turnId, agentId, occurrence),
      turnId,
      agentId,
      asks: [],
      drafts: [],
      activities: [],
      timeline: [],
      segments: [],
      answer: [],
      tail: [],
      ...(ts === undefined ? {} : { startedAt: ts, endedAt: ts }),
    }
    // A steer sent before the turn wrote anything opens this turn's timeline.
    const early = unattached.get(turnId)
    if (early !== undefined) {
      unattached.delete(turnId)
      for (const row of early) {
        rows.splice(rows.indexOf(row), 1)
        created.timeline.push({ kind: 'user', key: row.key, row })
      }
      created.startedAt = Math.min(created.startedAt ?? Infinity, early[0]!.event.ts)
      created.endedAt ??= created.startedAt
    }
    open.set(identity, created)
    latest.set(identity, created)
    byTurnId.set(turnId, created)
    groups.push(created)
    rows.push(created)
    return created
  }

  const waiting: Row[] = []
  const queuedBehind = new Map<string, Row[]>()
  for (const event of events) {
    switch (event.type) {
      case 'user_message': {
        const row: Extract<Row, { kind: 'event' }> = { kind: 'event', key: event.id, event }
        userRows.set(event.id, row)
        if (event.dispatchState === 'pending') {
          waiting.push(row)
          break
        }
        if (event.queuedAfter !== undefined) {
          queuedBehind.set(event.queuedAfter, [...queuedBehind.get(event.queuedAfter) ?? [], row])
          break
        }
        const steered = event.steersTurnId === undefined
          ? undefined
          : [...open.values()].reverse().find((turn) => turn.turnId === event.steersTurnId)
        if (!dmBeats && steered !== undefined) {
          // Outside a DM the steer is part of the turn it redirected, not a row above it.
          steered.timeline.push({ kind: 'user', key: row.key, row })
          steered.endedAt = Math.max(steered.endedAt ?? event.ts, event.ts)
          break
        }
        rows.push(row)
        if (event.steersTurnId !== undefined) {
          if (steered !== undefined) {
            const previous = rows.indexOf(steered)
            if (previous >= 0) rows.splice(previous, 1)
            rows.push(steered)
          } else if (!dmBeats && !byTurnId.has(event.steersTurnId)) {
            unattached.set(event.steersTurnId, [...unattached.get(event.steersTurnId) ?? [], row])
          }
        }
        break
      }
      case 'agent_relay':
        if (event.phase === 'sent') sentRelays.add(`${event.turnId}\0${event.agentId}`)
        rows.push({ kind: 'event', key: event.id, event })
        break
      case 'agent_message': {
        const turn = turnFor(event.turnId, event.agentId, event.ts)
        appendSay(turn, event)
        break
      }
      case 'reasoning': {
        const turn = turnFor(event.turnId, event.agentId, event.ts)
        const step: ReasoningStep = {
          kind: 'reasoning',
          key: event.id,
          text: event.text,
          ...(event.parentToolCallId === undefined ? {} : { parentToolCallId: event.parentToolCallId }),
          startedAt: event.ts,
        }
        turn.activities.push(step)
        // A subagent's own steps belong to its row, not to the turn's trace.
        if (event.parentToolCallId === undefined) turn.timeline.push(step)
        break
      }
      case 'tool_use': {
        const turn = turnFor(event.turnId, event.agentId, event.ts)
        // A resumed background agent reports under its launch's call again: that row
        // runs again with its steps kept, and its next answer replaces the last one.
        const launched = event.background === true && event.toolCallId !== undefined
          ? toolsByCall.get(turn)?.get(event.toolCallId)
          : undefined
        if (launched?.background === true) {
          launched.status = 'running'
          delete launched.output
          delete launched.unconfirmed
          break
        }
        // Codex says a row is background work only when its turn answers with it still
        // running. One that ended before that announcement reached the store stays ended.
        if (launched !== undefined) {
          if (launched.status === 'running') launched.background = true
          break
        }
        const step: ToolStep = {
          kind: 'tool',
          key: event.toolCallId ?? event.id,
          ...(event.toolCallId === undefined ? {} : { toolCallId: event.toolCallId }),
          tool: event.tool,
          ...(event.detail === undefined ? {} : { detail: event.detail }),
          ...(event.subject === undefined ? {} : { subject: event.subject }),
          ...(event.targets === undefined ? {} : { targets: event.targets }),
          ...(event.images === undefined ? {} : { images: event.images }),
          ...(event.command === undefined ? {} : { command: event.command }),
          ...(event.edits === undefined ? {} : { edits: event.edits }),
          ...(event.parentToolCallId === undefined ? {} : { parentToolCallId: event.parentToolCallId }),
          ...(event.agentType === undefined ? {} : { agentType: event.agentType }),
          ...(event.subagent === undefined ? {} : { subagent: event.subagent }),
          ...(event.background === true ? { background: true as const } : {}),
          status: 'running',
          startedAt: event.ts,
        }
        // Kept in `activities` so a subagent's edits still reach the changed files.
        turn.activities.push(step)
        if (event.parentToolCallId === undefined) turn.timeline.push(step)
        let byCall = toolsByCall.get(turn)
        if (byCall === undefined) {
          byCall = new Map()
          toolsByCall.set(turn, byCall)
        }
        if (!byCall.has(step.toolCallId)) byCall.set(step.toolCallId, step)
        if (step.toolCallId !== undefined) launchedIn.set(`${turnIdentity(event.turnId, event.agentId)}\n${step.toolCallId}`, turn)
        break
      }
      case 'tool_result': {
        // The turn's own clock stops at its end: a late child result does not stretch it.
        const identity = turnIdentity(event.turnId, event.agentId)
        const closed = open.has(identity) ? undefined : launchedIn.get(`${identity}\n${event.toolCallId}`)
        const turn = closed ?? turnFor(event.turnId, event.agentId, event.ts)
        const activity = toolsByCall.get(turn)?.get(event.toolCallId)
        if (activity !== undefined) {
          activity.status = event.outcome === 'error' ? 'error' : event.outcome === 'stopped' ? 'stopped' : 'done'
          if (event.tool !== undefined) activity.tool = event.tool
          if (event.subject !== undefined) activity.subject = event.subject
          if (event.output !== undefined) activity.output = event.output
          if (event.outcome === 'error' && event.error !== undefined) activity.error = event.error
          if (event.usage !== undefined) activity.usage = event.usage
          if (isSubagentCall(activity) && (event.reportedModel !== undefined || event.reportedEffort !== undefined)) {
            activity.subagent = {
              ...activity.subagent,
              ...(event.reportedModel === undefined ? {} : { model: event.reportedModel }),
              ...(event.reportedEffort === undefined ? {} : { effort: event.reportedEffort }),
            }
          }
          if (event.outcome === 'success' && event.edits !== undefined) activity.edits = event.edits
        }
        break
      }
      case 'todo_update': {
        const turn = turnFor(event.turnId, event.agentId, event.ts)
        turn.todos = event.todos
        const previous = turn.timeline.findIndex((item) => item.kind === 'todo')
        if (previous >= 0) turn.timeline.splice(previous, 1)
        // Keyed by the turn's own key (ids can repeat in old history), not the event: each update replaces the card, which keeps its fold.
        turn.timeline.push({ kind: 'todo', key: `todo:${turn.key}`, todos: event.todos })
        break
      }
      case 'user_input_request': {
        const turn = turnFor(event.turnId, event.agentId, event.ts)
        if (turn.asks.some((ask) => ask.requestId === event.requestId)) break
        const ask: AskRecord = {
          key: event.id,
          requestId: event.requestId,
          questions: event.questions,
        }
        turn.asks.push(ask)
        turn.timeline.push({ kind: 'ask', key: event.id, ask })
        break
      }
      case 'user_input_response': {
        const turn = turnFor(event.turnId, event.agentId, event.ts)
        const ask = turn.asks.find((entry) => entry.requestId === event.requestId)
        if (ask !== undefined) ask.answers = event.answers
        break
      }
      case 'file_delivery': {
        const turn = turnFor(event.turnId, event.agentId, event.ts)
        turn.files = [...turn.files ?? [], event.file]
        break
      }
      case 'connect_request': {
        if (connectTurns.has(event.connectId)) break
        const turn = turnFor(event.turnId, event.agentId, event.ts)
        const card: ConnectRecord = {
          key: event.id, connectId: event.connectId, kind: event.kind, app: event.app, status: 'ready',
          ...(event.alias === undefined ? {} : { alias: event.alias }),
        }
        turn.connects = [...turn.connects ?? [], card]
        connectTurns.set(event.connectId, turn)
        break
      }
      case 'connect_status': {
        const turn = connectTurns.get(event.connectId)
        if (turn?.connects === undefined) break
        turn.connects = turn.connects.map((card) => card.connectId !== event.connectId ? card : {
          key: card.key, connectId: card.connectId, kind: card.kind, app: card.app,
          ...(card.alias === undefined ? {} : { alias: card.alias }),
          status: event.status,
          ...(event.reason === undefined ? {} : { reason: event.reason }),
          ...(event.nextMessage === undefined ? {} : { nextMessage: event.nextMessage }),
          ...(event.final === undefined ? {} : { final: event.final }),
        })
        break
      }
      case 'outbound_draft': {
        const turn = turnFor(event.turnId, event.agentId, event.ts)
        if (turn.drafts.some((draft) => draft.draftId === event.draftId)) break
        const draft: DraftRecord = {
          key: event.id,
          draftId: event.draftId,
          channel: event.channel,
          to: event.to,
          ...(event.subject === undefined ? {} : { subject: event.subject }),
          ...(event.cc === undefined ? {} : { cc: event.cc }),
          ...(event.from === undefined ? {} : { from: event.from }),
          ...(event.fullThread === undefined ? {} : { fullThread: event.fullThread }),
          ...(event.slackRichText === undefined ? {} : { slackRichText: event.slackRichText }),
          ...(event.mailAccount === undefined ? {} : { mailAccount: event.mailAccount }),
          ...(event.slackChannelId === undefined ? {} : { slackChannelId: event.slackChannelId }),
          ...(event.slackThreadTs === undefined ? {} : { slackThreadTs: event.slackThreadTs }),
          ...(event.thread === undefined ? {} : { thread: event.thread }),
          body: event.body,
        }
        turn.drafts.push(draft)
        turn.timeline.push({ kind: 'draft', key: event.id, draft })
        draftsById.set(event.draftId, draft)
        break
      }
      case 'outbound_draft_closed': {
        const draft = draftsById.get(event.draftId)
        if (draft !== undefined) {
          draft.closed = {
            outcome: event.outcome,
            ...(event.delivery === undefined ? {} : { delivery: event.delivery }),
            ...(event.body === undefined ? {} : { body: event.body }),
            ...(event.subject === undefined ? {} : { subject: event.subject }),
            ...(event.cc === undefined ? {} : { cc: event.cc }),
            ...(event.slackRichText === undefined ? {} : { slackRichText: event.slackRichText }),
            ...(event.until === undefined ? {} : { until: event.until }),
          }
        }
        break
      }
      case 'outbound_draft_reopened': {
        const draft = draftsById.get(event.draftId)
        if (draft !== undefined) {
          delete draft.closed
          delete draft.failure
          delete draft.submission
        }
        break
      }
      case 'outbound_draft_submission': {
        const draft = draftsById.get(event.draftId)
        if (draft === undefined) break
        if (event.status === 'failed') {
          delete draft.submission
          draft.body = event.body
          if (event.slackRichText === undefined) delete draft.slackRichText
          else draft.slackRichText = event.slackRichText
          if (event.subject === undefined) delete draft.subject
          else draft.subject = event.subject
          if (event.cc === undefined) delete draft.cc
          else draft.cc = event.cc
          draft.failure = event.message ?? 'This draft could not be sent.'
          break
        }
        delete draft.failure
        if (event.status === 'started' || event.status === 'uncertain') {
          draft.submission = {
            status: event.status,
            body: event.body,
            ...(event.subject === undefined ? {} : { subject: event.subject }),
            ...(event.cc === undefined ? {} : { cc: event.cc }),
            ...(event.slackRichText === undefined ? {} : { slackRichText: event.slackRichText }),
            ...(event.message === undefined ? {} : { message: event.message }),
          }
          break
        }
        delete draft.submission
        draft.closed = {
          outcome: 'submitted',
          ...(event.delivery === undefined ? {} : { delivery: event.delivery }),
          body: event.body,
          ...(event.subject === undefined ? {} : { subject: event.subject }),
          ...(event.cc === undefined ? {} : { cc: event.cc }),
          ...(event.slackRichText === undefined ? {} : { slackRichText: event.slackRichText }),
        }
        break
      }
      case 'turn_result': {
        const turn = turnFor(event.turnId, event.agentId, event.ts)
        if (event.reportedModel !== undefined) turn.reportedModel = event.reportedModel
        if (event.memoryTrace !== undefined) turn.memoryTrace = event.memoryTrace
        if (event.memoryChanges !== undefined) turn.memoryChanges = event.memoryChanges
        if (event.notesUpdate !== undefined) turn.notesUpdate = event.notesUpdate
        if (event.instructionsOffer !== undefined) turn.instructionsOffer = event.instructionsOffer.line
        if (event.fileChanges !== undefined) turn.fileChanges = event.fileChanges
        if (event.fileChangeRoots !== undefined) turn.fileChangeRoots = event.fileChangeRoots
        if (event.fileChangeUnmeasured !== undefined) turn.fileChangeUnmeasured = event.fileChangeUnmeasured
        if (event.routineOutcome !== undefined) turn.routineOutcome = event.routineOutcome
        turn.completed = true
        open.delete(turnIdentity(event.turnId, event.agentId))
        break
      }
      case 'system_note': {
        // A thread's own write joins the turn that made it. One without a turn is a
        // Session's status line (or predates turn ids) and a restore is Manor undoing
        // someone else: those keep their own row, which the thread's bundle holds.
        const write = event.projectFileWrite
        const writer = write === undefined || write.action === 'restore' || write.turnId === undefined ? undefined
          : byTurnId.get(write.turnId)
        if (write !== undefined && writer !== undefined) {
          writer.fileWrites = [...writer.fileWrites ?? [], write]
          break
        }
        // The write can be stored before its turn's first event (the tool call and the
        // stream are concurrent); it stands for now and joins the turn once it exists.
        if (write?.turnId !== undefined && write.action !== 'restore') {
          const row: Row = { kind: 'event', key: event.id, event }
          earlyWrites.push({ row, write, turnId: write.turnId })
          rows.push(row)
          break
        }
        // Manor's reached note comes after the turn whose goal_reached it accepted; a call
        // the server then refused (review gate, late edit) never gets one.
        for (let index = groups.length - 1; event.workGoalHandoffId !== undefined && index >= 0; index -= 1) {
          const turn = groups[index]!
          if (turn.agentId !== event.agentId || !turn.activities.some((step) => isToolStep(step) &&
            /goal_reached$/.test(step.tool) && step.status !== 'error' && step.status !== 'stopped')) continue
          turn.goalReached = true
          break
        }
        const forward = event.sessionForward
        if (forward !== undefined) {
          // One note, two places: under the user's message, and under the reply of the turn that sent it.
          const link = { sessionChatId: forward.sessionChatId, title: forward.title }
          const message = event.hintFor === undefined ? undefined : userRows.get(event.hintFor)
          if (message !== undefined) message.forwards = [...message.forwards ?? [], link]
          const identity = turnIdentity(forward.turnId, forward.agentId)
          const turn = open.get(identity) ?? latest.get(identity) ?? turnFor(forward.turnId, forward.agentId, event.ts)
          turn.sessionLinks = [...turn.sessionLinks ?? [], link]
          break
        }
        const about = event.hintFor === undefined ? undefined : userRows.get(event.hintFor)
        if (about !== undefined) {
          about.hints = [...about.hints ?? [], event.text]
          break
        }
        if (event.trace === true && event.turnId !== undefined && event.agentId !== undefined) {
          // Written after the turn may have ended: it joins that turn without reopening it.
          const identity = turnIdentity(event.turnId, event.agentId)
          const turn = open.get(identity) ?? latest.get(identity)
          if (turn !== undefined) turn.traceNotes = [...turn.traceNotes ?? [], { key: event.id, text: event.text }]
          break
        }
        if (event.turnId !== undefined && event.agentId !== undefined) {
          turnFor(event.turnId, event.agentId, event.ts).note = event
          // An error or an abort ends the turn; the info note is the mid-turn
          // "hit a problem and carried on", which the same turn keeps writing past.
          if (event.kind !== 'info') open.delete(turnIdentity(event.turnId, event.agentId))
        } else {
          rows.push({ kind: 'event', key: event.id, event })
        }
        break
      }
    }
    const released = queuedBehind.get(event.id)
    if (released !== undefined) {
      rows.push(...released)
      queuedBehind.delete(event.id)
    }
  }
  for (const held of queuedBehind.values()) rows.push(...held)
  // Newest first, so prepending keeps the writes in the order they happened.
  for (const { row, write, turnId } of [...earlyWrites].reverse()) {
    const writer = byTurnId.get(turnId)
    if (writer === undefined) continue
    writer.fileWrites = [write, ...writer.fileWrites ?? []]
    rows.splice(rows.indexOf(row), 1)
  }

  for (const turn of groups) {
    if (sentRelays.has(`${turn.turnId}\0${turn.agentId}`)) turn.hasSentRelay = true
  }
  const unfinished = new Map<string, TurnRow>()
  for (const [identity, turn] of open) {
    unfinished.set(identity, cloneTurn(turn))
  }
  for (const turn of groups) finishTurn(turn, dmBeats)

  // An appended event makes a new array, and every row above was built anew from it.
  // Rows that say what they said before give way to the objects they were.
  const first = events[0]
  const before = first === undefined ? undefined : lastDurableRows.get(first)?.get(dmBeats)
  const kept = reuseRows(before?.rows, rows)
  const keptWaiting = reuseRows(before?.waiting, waiting)
  if (first !== undefined) {
    const lastByMode = lastDurableRows.get(first) ?? new Map<boolean, { rows: Row[]; waiting: Row[] }>()
    lastByMode.set(dmBeats, { rows: kept, waiting: keptWaiting })
    lastDurableRows.set(first, lastByMode)
  }

  const derived = { rows: kept, open: unfinished, occurrences, waiting: keptWaiting, unattached }
  const cachedByMode = durableRowsCache.get(events) ?? new Map<boolean, DurableRows>()
  cachedByMode.set(dmBeats, derived)
  durableRowsCache.set(events, cachedByMode)
  return derived
}

/**
 * Adds the small volatile shell to cached durable rows. A stream frame now clones and
 * recalculates only its active turn; all historical row identities stay stable.
 */
export function rowsOf(state: ThreadShape, chatKind?: Chat['kind']): Row[] {
  const dmBeats = chatKind === 'dm'
  const durable = durableRowsOf(state.events, dmBeats)
  let rows = durable.rows
  const projected = new Map<string, TurnRow>()
  const claimed = new Set<string>()

  for (const live of [...state.liveTurns].sort((a, b) => a.startedAt - b.startedAt)) {
    const identity = turnIdentity(live.turnId, live.agentId)
    let turn = projected.get(identity)
    if (turn === undefined) {
      const existing = durable.open.get(identity)
      if (existing !== undefined) {
        turn = cloneTurn(existing)
        if (rows === durable.rows) rows = [...rows]
        const rowIndex = rows.findIndex((row) => row.kind === 'turn' && row.key === existing.key)
        if (rowIndex !== -1) rows[rowIndex] = turn
      } else {
        // Steers sent before this turn wrote anything move into it from their own rows.
        const early = claimed.has(live.turnId) ? undefined : durable.unattached.get(live.turnId)
        claimed.add(live.turnId)
        turn = {
          kind: 'turn',
          key: turnKey(live.turnId, live.agentId, (durable.occurrences.get(identity) ?? 0) + 1),
          turnId: live.turnId,
          agentId: live.agentId,
          startedAt: Math.min(live.startedAt, ...early?.map((row) => row.event.ts) ?? []),
          asks: [],
          drafts: [],
          activities: [],
          timeline: early?.map((row): TurnUser => ({ kind: 'user', key: row.key, row })) ?? [],
          segments: [],
          answer: [],
          tail: [],
        }
        // By key: a row that did not change keeps an earlier object than the one `unattached` holds.
        if (early !== undefined) rows = rows.filter((row) => !early.some((steer) => steer.key === row.key))
        else if (rows === durable.rows) rows = [...rows]
        const later = rows.findIndex((row) => row.kind === 'turn' && (row.startedAt ?? Infinity) > live.startedAt)
        rows.splice(later === -1 ? rows.length : later, 0, turn)
      }
      projected.set(identity, turn)
    }
    turn.live = live
  }
  for (const turn of projected.values()) finishTurn(turn, dmBeats)

  if (durable.waiting.length > 0) rows = [...rows, ...durable.waiting]
  if (state.pending.length > 0) {
    if (rows === durable.rows) rows = [...rows]
    // The server decides whether a send steers; a steered one moves above the turn when it lands.
    rows.push(...state.pending.map((pending): Row => ({
      kind: 'pending',
      key: pending.key,
      text: pending.text,
      images: pending.images,
      files: pending.files,
      ...(pending.documents === undefined ? {} : { documents: pending.documents }),
      pageContexts: pending.pageContexts,
      ...(pending.replyTo === undefined ? {} : { replyTo: pending.replyTo }),
      ...(pending.quotes === undefined ? {} : { quotes: pending.quotes }),
    })))
  }

  if (chatKind === 'dm') rows = projectDmRoutineFailures(rows)

  // A continuing routine shares its DM with useful conversation. When a successful
  // fire produced no standing reply, its execution already lives in routine history;
  // keeping the injected marker and an empty work block here only adds feed noise.
  // Disposable run threads deliberately keep the same shape visible because that
  // thread is their sole record. Failures stay as one bubble; raw dumps do not.
  const hidden = new Set<number>()
  for (let index = 0; index < rows.length - 1; index += 1) {
    const marker = rows[index]
    const turn = rows[index + 1]
    if (
      marker?.kind === 'event' &&
      marker.event.type === 'user_message' &&
      marker.event.source === 'routine' &&
      chatKind === 'dm' &&
      turn?.kind === 'turn' &&
      turn.completed === true &&
      turn.live === undefined &&
      (
        turn.routineOutcome === 'quiet' ||
        (turn.tail.length === 0 && (turn.note === undefined || turn.note.kind === 'info'))
      )
    ) {
      hidden.add(index)
      hidden.add(index + 1)
    }
  }
  const shown = hidden.size === 0 ? rows : rows.filter((_, index) => !hidden.has(index))
  return chatKind === 'dm' ? foldDmRoutineMarkers(shown) : shown
}

/** One folded copy per cached turn, so a stream delta elsewhere keeps its props stable. */
const triggeredTurns = new WeakMap<TurnRow, { event: UserEvent; turn: TurnRow }>()

/**
 * In a DM the routine marker stops being a row of its own (2026-09-28): it
 * moves into the fold of the turn right after it. A marker with no turn behind it yet
 * is dropped too, so a queued fire does not flash a line that then jumps into a fold.
 * A literal reminder has no fold, so its message simply stands alone.
 */
function foldDmRoutineMarkers(rows: Row[]): Row[] {
  if (!rows.some(isRoutineMarker)) return rows
  const out: Row[] = []
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!
    if (!isRoutineMarker(row)) {
      out.push(row)
      continue
    }
    const next = rows[index + 1]
    if (next?.kind !== 'turn') continue
    const cached = triggeredTurns.get(next)
    const turn = cached?.event === row.event ? cached.turn : {
      ...next,
      routineTrigger: {
        ...(row.event.routineName === undefined ? {} : { name: row.event.routineName }),
        ts: row.event.ts,
        prompt: row.event.text,
        ...(row.event.routineDueAt === undefined ? {} : { dueAt: row.event.routineDueAt }),
      },
    }
    triggeredTurns.set(next, { event: row.event, turn })
    out.push(turn)
    index += 1
  }
  return out
}

const isRoutineMarker = (row: Row): row is Extract<Row, { kind: 'event' }> & { event: UserEvent } =>
  row.kind === 'event' && row.event.type === 'user_message' && row.event.source === 'routine'

export interface Persona {
  name: string
  color: string
  /** A `data:image/…` portrait, or absent for the personas that have none. */
  avatar?: string
  /** The silhouette her generated face wears, or absent to let her name pick one. */
  avatarShape?: string
  avatarTone?: number
}

/** A persona no longer on the roster, who still owns the turns she ran. */
export const UNKNOWN_ACCENT = '#8a8f98'

/** Visible DM copy when a routine dies before it can publish an outcome. */
export function routineDidNotFinish(name?: string): string {
  const label = name?.trim()
  return `${label === undefined || label.length === 0 ? 'The routine' : label} didn't finish.`
}

function isStaleRoutineLeaseNote(text: string): boolean {
  return text.includes('ended without a recorded completion')
}

function withRoutineFailureNotice(turn: TurnRow, name: string | undefined): TurnRow {
  const text = routineDidNotFinish(name)
  if (turn.answer.some((reply) => reply.text === text) && turn.note?.kind !== 'error') return turn
  const reply: TurnReply = {
    kind: 'reply',
    key: `routine-fail:${turn.turnId}`,
    text,
    images: [],
    quoteSources: [],
  }
  const already = turn.answer.some((entry) => entry.text === text)
  return {
    ...turn,
    ...(turn.note?.kind === 'error' ? { note: undefined } : {}),
    ...(already ? {} : { answer: [...turn.answer, reply], tail: [...turn.tail, reply] }),
  }
}

/**
 * DM routine failures stay visible as one bubble. The raw provider dump and the
 * lease-recovery essay are the same fact twice, in red.
 */
function projectDmRoutineFailures(rows: readonly Row[]): Row[] {
  const stale = new Set<number>()
  const softened = new Map<number, TurnRow>()
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    if (
      row?.kind === 'event' &&
      row.event.type === 'system_note' &&
      row.event.kind === 'error' &&
      isStaleRoutineLeaseNote(row.event.text)
    ) {
      stale.add(index)
      for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
        const marker = rows[cursor]
        if (marker?.kind !== 'event' || marker.event.type !== 'user_message' || marker.event.source !== 'routine') {
          continue
        }
        const turn = rows[cursor + 1]
        if (turn?.kind === 'turn') {
          softened.set(cursor + 1, withRoutineFailureNotice(
            softened.get(cursor + 1) ?? turn,
            marker.event.routineName,
          ))
        }
        break
      }
      continue
    }
    const marker = rows[index]
    const turn = rows[index + 1]
    if (
      marker?.kind === 'event' &&
      marker.event.type === 'user_message' &&
      marker.event.source === 'routine' &&
      turn?.kind === 'turn' &&
      turn.note?.kind === 'error'
    ) {
      softened.set(index + 1, withRoutineFailureNotice(
        softened.get(index + 1) ?? turn,
        marker.event.routineName,
      ))
    }
  }
  if (stale.size === 0 && softened.size === 0) return rows as Row[]
  return rows.flatMap((row, index) => {
    if (stale.has(index)) return []
    return [softened.get(index) ?? row]
  })
}

/**
 * An agent id with no roster entry shows the raw id rather than an invented name.
 * That is the ordinary state of a deleted persona: the messages she wrote stay in
 * the transcript with her id on them, so this fallback is what renders them.
 */
export function personaOf(agents: AgentConfig[], agentId: string): Persona {
  const agent = agents.find((candidate) => candidate.id === agentId)
  if (!agent) {
    return agentId === SINGLE_CHAT_VOICE.id
      ? { name: SINGLE_CHAT_VOICE.name, color: UNKNOWN_ACCENT }
      : { name: agentId, color: UNKNOWN_ACCENT }
  }
  return {
    name: agent.name,
    color: agent.color,
    avatar: agent.avatar,
    avatarShape: agent.avatarShape,
    avatarTone: agent.avatarTone,
  }
}

/**
 * The ids a face stack may draw: only those the roster resolves. A face is a claim
 * about who is there, so an id with no persona behind it (a deleted one, or a roster
 * the room trimmed) draws nothing rather than a grey face seeded from the raw id.
 */
export function knownAgentIds(agents: readonly AgentConfig[], agentIds: readonly string[]): string[] {
  return agentIds.filter((agentId) => agents.some((agent) => agent.id === agentId))
}

/** The personas who have actually taken part in this transcript, once each. */
export function participantIds(thread: ThreadShape): string[] {
  const ids = new Set<string>()
  for (const event of thread.events) {
    if ('agentId' in event && event.agentId !== undefined) ids.add(event.agentId)
  }
  for (const turn of thread.liveTurns) ids.add(turn.agentId)
  return [...ids]
}

/** Personas whose first turn has started, including a turn that is still live. */
export function runtimeStartedAgentIds(thread: Pick<ThreadShape, 'events' | 'liveTurns'>): string[] {
  const ids = new Set(thread.liveTurns.map((turn) => turn.agentId))
  for (const event of thread.events) {
    if (event.type === 'agent_message' || event.type === 'turn_result') {
      ids.add(event.agentId)
    } else if (
      event.type === 'system_note' &&
      event.kind !== 'info' &&
      event.turnId !== undefined &&
      event.agentId !== undefined
    ) {
      ids.add(event.agentId)
    }
  }
  return [...ids]
}

export interface UsageRow extends Persona {
  id: string
  usage: Usage | undefined
  /**
   * How full this persona's context window was at the end of her most recent turn.
   */
  contextTokens: number | undefined
}

/**
 * Per agent, the context size of the newest turn that reported one.
 *
 * There is deliberately no fallback to `usage.inputTokens`. That field is the
 * turn's total spend across every request the provider made, which on a
 * tool-heavy turn runs several times the real context (measured 4x on both CLIs)
 * and, on Codex, is a running session total that never stops growing. A gauge
 * that reads half-full when the window holds 8% is not a rough number, it is a
 * number the user makes decisions on, so a persona whose driver cannot report this
 * shows no bar at all until it can.
 */
function contextTokensPerAgent(events: readonly ThreadEvent[]): Record<string, number> {
  const latest: Record<string, number> = {}
  for (const event of events) {
    if (event.type !== 'turn_result' || event.contextTokens === undefined) continue
    latest[event.agentId] = event.contextTokens
  }
  return latest
}

/**
 * Roster order, with any usage for agents outside the roster appended rather than
 * dropped. The roster is the workspace's and the usage is one chat's, so the two
 * halves arrive separately and a persona deleted mid-chat keeps her totals.
 */
export function usageRows(agents: AgentConfig[], thread: ThreadShape): UsageRow[] {
  const contexts = contextTokensPerAgent(thread.events)
  const rostered = agents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    color: agent.color,
    avatar: agent.avatar,
    avatarShape: agent.avatarShape,
    avatarTone: agent.avatarTone,
    usage: thread.usage[agent.id],
    contextTokens: contexts[agent.id],
  }))
  const strays = Object.entries(thread.usage)
    .filter(([id]) => !agents.some((agent) => agent.id === id))
    .map(([id, usage]) => ({ id, name: id, color: UNKNOWN_ACCENT, usage, contextTokens: contexts[id] }))
  return [...rostered, ...strays]
}
