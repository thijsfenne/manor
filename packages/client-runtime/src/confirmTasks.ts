import { CONFIRM_REQUEST_PREFIX, type ConfirmRequest, type ThreadEvent, type TodoItem, type WorkCompletion, type WorkHandoff } from '@manor/contracts'

/**
 * One line of a tasks card: a task in a plan, or a step the user's Confirm asked for.
 * `skipped` is a plan step its turn ended without ticking; `paused` is the step in
 * progress while its turn compacts, which spins again once the work resumes.
 */
export interface TaskLine {
  text: string
  status: TodoItem['status'] | 'blocked' | 'skipped' | 'paused'
}

/** What a tasks card header says about the whole list: the mark it wears and the "done/total" counter. */
export interface PlanStanding {
  done: number
  total: number
  mark: 'working' | 'paused' | 'blocked' | 'stopped' | 'done'
}

/**
 * A plan has no progress number of its own, so the header reads it off its lines. Only a completed line counts as done. A blocked step outranks the rest, a
 * running or waiting one spins. With nothing left open it is `done` only when every
 * line is, and `stopped` when its turn ended with lines skipped: never a check.
 */
export function planStanding(tasks: readonly TaskLine[]): PlanStanding {
  const has = (status: TaskLine['status']) => tasks.some((task) => task.status === status)
  const mark = has('blocked') ? 'blocked'
    : has('in_progress') ? 'working'
    : has('paused') ? 'paused'
    : has('pending') ? 'working'
    : has('skipped') ? 'stopped'
    : 'done'
  return { done: tasks.filter((task) => task.status === 'completed').length, total: tasks.length, mark }
}

/**
 * A finished card renders closed: only its header shows until the user opens it. Anything
 * short of every line done (running, blocked, or ended with lines skipped) stays open so
 * the open work stays in view.
 */
export const foldsWhenDone = (tasks: readonly TaskLine[]): boolean => tasks.length > 0 && planStanding(tasks).mark === 'done'

/**
 * Opening words of a step that prepares or wraps up the work rather than doing it. A
 * plan title skips these, so "Read the card code" does not name a plan that rebuilds it.
 */
const SIDE_STEP = /^(?:read|reread|explore|investigate|inspect|map|research|locate|find|trace|understand|study|look|gather|check|review|verify|test|run|typecheck|lint|prove|report|summari[sz]e|commit|confirm|call|lees|onderzoek|bekijk|controleer|verifieer|rapporteer)\b/i
const TITLE_MAX = 72

const plain = (text: string) => text.trim().replace(/[.:;]+$/, '')
/** Lowercases the first letter of a joined step, unless it opens an acronym or a name like "TodoList". */
const joined = (text: string) => /^[A-Z][a-z]+(?:\s|$)/.test(text) ? text[0]!.toLowerCase() + text.slice(1) : text

/**
 * What a tasks card's header calls a plan. No plan tool Manor drives carries a title
 * (Claude's and Grok's todos, Codex's update_plan, Cursor's updateTodos), and the
 * Session's own title already stands above the card, so the plan is named by what it
 * does: its first step that does the work, joined by the next when both fit one line.
 * A plan of only groundwork and wrap-up is named by its own first steps the same way.
 */
export function planTitle(tasks: readonly TaskLine[]): string {
  const lines = tasks.map((task) => plain(task.text)).filter((text) => text.length > 0)
  // A one-word step ("Fix") does not name anything on its own.
  const work = lines.filter((text) => text.includes(' ') && !SIDE_STEP.test(text))
  const [first, second] = work.length > 0 ? work : lines
  if (first === undefined) return ''
  const both = second === undefined ? undefined : `${first} and ${joined(second)}`
  return both !== undefined && both.length <= TITLE_MAX ? both : first
}

/**
 * What a Confirm card's header calls its request: the verb it asked for and the work it
 * commits, by the lead's commit subject or else the Session's brief title.
 */
export function confirmTitle(request: ConfirmRequest, work: string | undefined): string {
  const verb = request.variant === 'merge' ? 'Commit and merge' : 'Commit'
  return work === undefined || work.trim().length === 0 ? `${verb} this Session’s changes` : `${verb}: ${plain(work)}`
}

/**
 * Row keys that follow a step's wording, not its place, so a revised plan only moves
 * what changed: an inserted step leaves its neighbours mounted, and a renamed one leaves
 * as itself while its new wording arrives. Repeated wording counts up to stay unique.
 */
export function planRowKeys(tasks: readonly TaskLine[]): string[] {
  const seen = new Map<string, number>()
  return tasks.map(({ text }) => {
    const nth = seen.get(text) ?? 0
    seen.set(text, nth + 1)
    return `${nth}:${text}`
  })
}

/** Every wording the server has used for a Confirm request; see the pattern itself. */
const CONFIRM_PREFIX = CONFIRM_REQUEST_PREFIX
const TREE_LINE = /^- worktree .+ on branch (\S+), linked folder (.+)$/gm

const basename = (folder: string): string => folder.replace(/\/+$/, '').split('/').at(-1) ?? folder

/**
 * What a Confirm message asked the lead to do. The server stores it beside the text;
 * a request written before that is read back from its own wording.
 */
export function confirmRequestOf(event: Extract<ThreadEvent, { type: 'user_message' }>): ConfirmRequest | undefined {
  if (event.confirmRequest !== undefined) return event.confirmRequest
  if (event.source !== undefined || !CONFIRM_PREFIX.test(event.text)) return undefined
  const worktrees = [...event.text.matchAll(TREE_LINE)].map((match) => ({ branch: match[1]!, folder: basename(match[2]!), source: match[2]! }))
  const withheld = /The merge into (\S+) is withheld:/.exec(event.text)?.[1]
  if (withheld !== undefined) return { variant: 'merge_withheld', worktrees, mergeInto: withheld }
  const merge = /approval to commit and to merge into (\S+)\./.exec(event.text)?.[1]
  if (merge !== undefined) return { variant: 'merge', worktrees, mergeInto: merge }
  return worktrees.length > 0 ? { variant: 'worktree', worktrees } : { variant: 'checkout', worktrees: [] }
}

/**
 * Where the commit turn stands. Git's answer wins once it is in; before that the turn
 * does, and a turn that ended with Git still reading stays in progress. A turn that
 * compacts pauses its current step, like a plan's.
 */
export type ConfirmProgress = 'pending' | 'running' | 'compacting' | 'ended' | 'failed'

/**
 * Confirm's steps as a sequence: every Commit, then every Merge. A step is done once Git
 * shows it (a commit on its own branch, a merge on the target, or the whole request
 * complete); the first step not done is the one that runs, fails or waits, and the open
 * steps after it wait. One repo merged before the next commits still reads as merged.
 */
export function confirmTasks(request: ConfirmRequest, progress: ConfirmProgress, completion?: WorkCompletion): TaskLine[] {
  const several = request.worktrees.length > 1
  // Every repo of a Session shares one branch, so a line finds its repo by linked folder.
  // A folder the completion does not hold had nothing to commit; without `source` (an
  // older request) the line cannot tell that from a miss and waits for Git's answer.
  const shows = (tree: ConfirmRequest['worktrees'][number], paths: readonly string[] | undefined) => {
    if (completion === undefined) return false
    const repo = completion.repos.find((candidate) => tree.source === undefined
      ? candidate.branch === tree.branch && basename(candidate.sourcePath ?? candidate.path) === tree.folder
      : candidate.sourcePath === tree.source)
    return repo === undefined ? tree.source !== undefined : paths?.includes(repo.path) === true
  }
  const steps: { text: string; done: boolean }[] = request.variant === 'checkout'
    ? [{
      text: 'Commit this Session’s changes',
      done: completion !== undefined && completion.repos.length > 0 &&
        completion.repos.every((repo) => completion.committed?.includes(repo.path) === true),
    }]
    : request.worktrees.map((tree) => ({
      text: several ? `Commit ${tree.folder} on ${tree.branch}` : `Commit this Session’s changes on ${tree.branch}`,
      done: shows(tree, completion?.committed),
    }))
  const merges = request.mergeInto === undefined ? [] : request.worktrees.map((tree) => ({
    text: several ? `Merge ${tree.folder} into ${request.mergeInto}` : `Merge into ${request.mergeInto}`,
    done: shows(tree, completion?.merged),
  }))
  const withheld = request.variant === 'merge_withheld'
  if (!withheld) steps.push(...merges)
  // A request from before Git was read only has its turn to go on.
  const finished = completion?.status === 'complete' || (progress === 'ended' && completion === undefined)
  const failed = completion?.status === 'blocked' || progress === 'failed'
  // Manor's own merge waits its turn behind another Session, or waits on the user to approve a conflict fix.
  const stage = completion?.merge?.stage
  const current: TaskLine['status'] = failed || stage === 'approve' ? 'blocked' : progress === 'pending' || stage === 'queued' ? 'pending'
    : progress === 'compacting' ? 'paused' : 'in_progress'
  let reached = false
  const lines = steps.map((step): TaskLine => {
    if (finished || step.done) return { text: step.text, status: 'completed' }
    if (reached) return { text: step.text, status: 'pending' }
    reached = true
    return { text: step.text, status: current }
  })
  return withheld ? [...lines, ...merges.map(({ text }): TaskLine => ({ text: `${text}, held back for earlier commits`, status: 'blocked' }))] : lines
}

/**
 * Where the turn that published a plan stands: running, compacting (running, but only
 * Compacting reads as active), over, or over with its goal reached.
 */
export type PlanEnd = 'running' | 'compacting' | 'ended' | 'reached'

/**
 * A plan as its card reads it: a sequence with at most one spinner. While the turn runs
 * the first step the agent marked in progress keeps it and any later one waits; while the
 * turn compacts that step pauses instead, keeping its place without the spin. Once the
 * turn is over nothing reads as still to do: a turn that reached its goal claimed every
 * step verified, and any other ends the steps it never ticked as skipped.
 */
export function planTasks(todos: TaskLine[], end: PlanEnd): TaskLine[] {
  const slot = PLAN_ENDS.indexOf(end)
  const held = shapedPlans.get(todos)?.[slot]
  if (held !== undefined) return held
  let spinning = false
  let changed = false
  const shaped = todos.map((todo): TaskLine => {
    const status = end === 'running' || end === 'compacting'
      ? todo.status !== 'in_progress' ? todo.status : spinning ? 'pending' : end === 'running' ? 'in_progress' : 'paused'
      : todo.status === 'completed' ? 'completed' : end === 'reached' ? 'completed' : 'skipped'
    if (todo.status === 'in_progress') spinning = true
    if (status === todo.status) return todo
    changed = true
    return { ...todo, status }
  })
  const result = changed ? shaped : todos
  const slots = shapedPlans.get(todos) ?? []
  slots[slot] = result
  shapedPlans.set(todos, slots)
  return result
}

const PLAN_ENDS: readonly PlanEnd[] = ['running', 'compacting', 'ended', 'reached']

/** A live turn reshapes its plan on every stream frame; the same plan keeps the same lines. */
const shapedPlans = new WeakMap<TaskLine[], (TaskLine[] | undefined)[]>()

/**
 * Every completion Manor holds for a request, the current round's and earlier ones. A
 * request is Confirm's own or one of its Retries; only the newest attempt reads the live
 * status, since an earlier one ended blocked or Retry would not have run.
 */
const attemptsOf = (completion: WorkCompletion) => [completion.requestEventId, ...(completion.retries ?? [])]

export function completionFor(handoffs: readonly WorkHandoff[], requestEventId: string): WorkCompletion | undefined {
  const attempt = (completion: WorkCompletion | undefined) => {
    if (completion === undefined) return undefined
    const attempts = attemptsOf(completion)
    const index = attempts.indexOf(requestEventId)
    if (index === -1) return undefined
    return index === attempts.length - 1 ? completion : { ...completion, status: 'blocked' as const }
  }
  for (const handoff of handoffs) {
    const found = attempt(handoff.goalCompletion) ??
      handoff.goalConfirmations?.map((round) => attempt(round.completion)).find((completion) => completion !== undefined)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * The work a Confirm request commits, for its card's header. The lead's commit subject
 * belongs to the current result only: the request Git answers in the current round, or,
 * before Git answers, the newest request in the Session. Any other request names its
 * Session's brief title instead.
 */
export function confirmWork(handoffs: readonly WorkHandoff[], requestEventId: string, newest: boolean): string | undefined {
  const answers = (completion: WorkCompletion | undefined) => completion !== undefined && attemptsOf(completion).includes(requestEventId)
  const earlier = (handoff: WorkHandoff) => handoff.goalConfirmations?.some((round) => answers(round.completion)) === true
  const handoff = handoffs.find((candidate) => answers(candidate.goalCompletion) || earlier(candidate))
    ?? (handoffs.length === 1 ? handoffs[0] : undefined)
  if (handoff === undefined) return undefined
  const current = answers(handoff.goalCompletion) || (newest && handoff.goalCompletion === undefined && !earlier(handoff))
  return (current ? handoff.goalReport?.commit?.subject : undefined) ?? handoff.title
}
