import path from 'node:path'
import type { AgentConfig, CheckoutRequest, ClientMessage, ConfirmRequest, GoalCommit, ImageAttachment, Project, ServerMessage, ThreadEvent, WorkAttachment, WorkCompletion, WorkHandoff, WorkMerge } from '@manor/contracts'
import { HOME_PROJECT_ID, MERGE_REPAIRS_MAX, agentFitsChat, contextEvents, SESSION_DEFAULT_AGENT_ID, SINGLE_CHAT_VOICE, summaryInContext, workHandoffHasLead, workSingleDefault } from '@manor/contracts'
import { MAX_CATCH_UP_CHARS, catchUpCut, renderCatchUpEvents } from './composer.js'
import { SUPERSEDED_PROPOSAL, type ChatWorktree, type LandedAttempt, type Store } from './store.js'
import { singleRuntime } from './singleChat.js'
import { PROJECT_THREAD_WRITER } from './projectFiles.js'
import { liveProjectThread } from './projectThreads.js'
import { commitsNotIn, currentBranch, effectiveRepoPaths } from './worktree.js'
import { approvalHolds, assertSameWorkResult, attemptOf, beyondApproval, beyondLine, checkoutBranches, leftStartBranch, observeWorkCompletion, ownCommitsSince, prepareWorkCompletion, repoHead, repoSteps, retryRefusal, stepTips, unconfirmedCompletion, undoCommit } from './workCompletion.js'
import { MergeLanes, committedTips, mergeSession, troubleText, type MergeOutcome } from './workMerge.js'
import type { GenerateWorkOutcome } from './workOutcome.js'
import { proposedRuntime, type WorkToolContext, type WorkToolInput } from './workTool.js'
import { goalReviewBlock, sessionChangedFiles } from './goalReview.js'
import { loadHandoffAttachments, resolveHandoffAttachments } from './handoffAttachments.js'
import { SessionGitError, commitFiles, commitPatch, fallbackCommitMessage } from './sessionGit.js'
import type { WriteCommitMessage } from './commitMessage.js'

type WorkAcceptanceOptions = Pick<Extract<ClientMessage, { type: 'accept_work_handoff' }>, 'checkout' | 'mode' | 'runtime' | 'task'>

/** Who wrote a proposal: a persona, or a project thread, which has a model and no persona. */
type HandoffAuthor = Pick<AgentConfig, 'id' | 'name' | 'placement' | 'mentionAllowlist'>

/** The project thread's part in the Work lifecycle (decided 2026-10-10). */
export interface WorkProjectThreads {
  /** Hands a DM brief to its project's thread at Accept, with the user's edit of its task; true when it did. */
  forwardBrief(handoff: WorkHandoff, options: Pick<WorkAcceptanceOptions, 'checkout' | 'mode' | 'runtime'>, task?: string): Promise<boolean>
  /** A thread published a proposal; one for a waiting brief is accepted at once. */
  proposed(handoff: WorkHandoff): Promise<void>
  /** Writes the thread proposal's own marked Notes row, so the thread never writes one. */
  noteProposal(handoff: WorkHandoff): Promise<void>
  /** Checks the confirmed Session's Notes row; the thread's guards decide when it archives. */
  completeSessionStatus(sessionChatId: string): Promise<void>
  /** Refuses a pinned or unavailable Notes file before the confirmation is stored. */
  assertSessionStatusWritable(sessionChatId: string): Promise<void>
}

interface WorkRuntime {
  isActiveTurn(chatId: string, agentId: string, turnId: string): boolean
  startStoredWorkHandoff(chatId: string, text: string, origin: WorkOrigin): Promise<void>
  discard(chatId: string): void
  /** Stops a running Work turn so settle/Reject actually ends the agents. */
  stopChat(chatId: string): void
  /** Clears a settle halt so a superseded settle can still let a queued kickoff run. */
  resumeChat(chatId: string): void
  /** Posts a message as the user, routed like one they typed. */
  submitUserMessage(chatId: string, text: string): Promise<void>
  /** Runs `fn` in the chat's turn order, so Manor's own commit never overlaps a turn. */
  runExclusive<T>(chatId: string, fn: () => Promise<T>): Promise<T>
  runStoredUserMessage(chatId: string, event: Extract<ThreadEvent, { type: 'user_message' }>): Promise<void>
}

export interface WorkOrigin {
  source: 'work_handoff'
  handoffId: string
  sourceChatId: string
  authorAgentId: string
  projectName?: string
  supportingAgentIds: string[]
  targetAgentId: string
  firstExecutorAgentId?: string
}

interface WorkModuleOptions {
  store: Store
  agents: () => readonly AgentConfig[]
  orchestrator: WorkRuntime
  broadcast: (message: ServerMessage) => void
  broadcastDirectory: () => Promise<void>
  prepareCheckout?: (chatId: string, checkout: CheckoutRequest, accept: () => Promise<void>) => Promise<void>
  generateOutcome?: GenerateWorkOutcome
  projectThreads?: WorkProjectThreads
  /** Takes a settled Session's merged worktrees and their Manor branches off disk. */
  releaseWorktrees?: (chatId: string) => Promise<unknown>
  /** Writes Confirm's commit message when the lead handed none in; Haiku in the service. */
  writeCommitMessage?: WriteCommitMessage
  /** Models turned off in Settings, Models: a project thread may not propose one. */
  offModels?: () => readonly string[]
}

const BLOCKED_POLL_MS = 30_000
/** How often Git is read for Confirm's commit step while its request runs. */
const COMMIT_WATCH_MS = 3_000

const names = (values: readonly string[]): string => values.length === 0 ? 'none' : values.join(', ')

/** Every Confirm commit runs the pre-commit hook; a failing hook is fixed or reported, never skipped. */
const HOOK_RULE = 'Let the pre-commit hook run: never pass --no-verify or skip it any other way. If it fails, fix the cause and commit again; if you cannot, stop with a real failure.'

/** How a stop reaches the user: its category, then the one thing they have to do. */
const STOP_RULE = 'If you stop, open the report with "Your choice:" when the user has to pick between versions or commits, or "Real failure:" when something is broken, followed by what blocks in at most twelve words, since their card shows that sentence (for example "Real failure: the pre-commit hook failed in apps/web tests."). Then name the one action they need to take.'

/**
 * The message the user's Confirm posts to the lead. In the current checkout it approves a
 * commit. In a worktree it approves the commit and, when the button showed a branch,
 * the merge into it, which Manor runs itself once the commit lands: it rebases the
 * branch, reruns the pre-commit hook and fast-forwards the linked folder, one Session
 * per folder at a time (`workMerge.ts`). The lead hears back only on a conflict or a
 * failing hook (`mergeTroubleRequest`). `unreviewed` lists commits the branches already
 * carried at the click; the approval never covers those, so their presence withholds the merge.
 */
export function commitRequest(lead: string | undefined, worktrees: readonly ChatWorktree[], mergeInto: string | undefined, unreviewed: readonly string[], repos: WorkCompletion['repos'] = []): string {
  // A Single Session has one voice and no persona to mention; the request is addressed to it.
  const changes = lead === undefined ? 'changes' : 'reviewed changes'
  const to = (rest: string) => lead === undefined ? `${rest[0]!.toUpperCase()}${rest.slice(1)}` : `@${lead}, ${rest}`
  if (worktrees.length === 0) {
    // The shared checkout can be switched under the turn; the approval is for these branches only.
    const branches = repos.filter((repo) => repo.sourcePath === undefined).map((repo) =>
      `Commit in ${path.basename(repo.path)} only on ${repo.branch}: check the current branch first, and if it is another one, do not commit and stop with "Real failure: ${path.basename(repo.path)} is on <that branch>, not ${repo.branch}."`)
    return [`[Manor] The user confirmed the ready result, and that is their approval to commit. ${to(`commit this Session's ${changes} now: stage only the files this Session changed, leave other chats' changes out, and do not push.`)} ${HOOK_RULE} ${STOP_RULE}`, ...branches].join('\n')
  }
  const trees = worktrees.map((row) => `- worktree ${row.worktreePath} on branch ${row.branch}, linked folder ${row.sourcePath}`).join('\n')
  if (mergeInto !== undefined && unreviewed.length > 0) {
    return [
      `[Manor] The user confirmed the ready result, and that is their approval to commit. The merge into ${mergeInto} is withheld: the branches already carry commits that are not in ${mergeInto}, and their approval does not cover them. ${to(`commit this Session's ${changes} on each worktree's branch below, leave them unmerged, do not push, and tell the user which commits blocked the merge, as their choice.`)} ${HOOK_RULE} ${STOP_RULE}`,
      ...unreviewed,
      trees,
    ].join('\n')
  }
  if (mergeInto === undefined) {
    return `[Manor] The user confirmed the ready result, and that is their approval to commit, not to merge. ${to(`commit this Session's ${changes} on each worktree's branch below and leave them unmerged. Do not push.`)} ${HOOK_RULE} ${STOP_RULE}\n${trees}`
  }
  return [
    `[Manor] The user confirmed the ready result, and that is their approval to commit and to merge into ${mergeInto}. ${to(`commit this Session's ${changes} on each worktree's branch below.`)} ${HOOK_RULE}`,
    `Do not rebase, merge or push: when your turn ends Manor rebases each branch onto ${mergeInto} and merges it, and comes back to you only if that fails. ${STOP_RULE}`,
    trees,
  ].join('\n')
}

/**
 * The Confirm request Manor runs itself in a worktree Session (2026-10-21): no turn answers
 * it. Manor commits exactly the approved files on each branch, with the message the lead
 * handed in on `goal_reached` (else one its writer composes), then merges as above. The
 * text stays in the transcript, so a later turn knows the commit was Manor's.
 */
export function manorCommitRequest(worktrees: readonly ChatWorktree[], mergeInto: string | undefined): string {
  const trees = worktrees.map((row) => `- worktree ${row.worktreePath} on branch ${row.branch}, linked folder ${row.sourcePath}`).join('\n')
  const approval = mergeInto === undefined ? 'their approval to commit, not to merge' : `their approval to commit and to merge into ${mergeInto}`
  const then = mergeInto === undefined ? 'and leaves them unmerged' : `and then merges them into ${mergeInto}`
  return `[Manor] The user confirmed the ready result, and that is ${approval}. Manor commits this Session's changes on each worktree's branch below itself ${then}; nothing is asked of you.\n${trees}`
}

/**
 * What the lead gets when Manor's own commit was refused (a failing pre-commit hook, or
 * Git declining the stage): Git's words, then Confirm's ordinary commit request for the
 * worktrees still to commit, with the message Manor tried.
 */
export function commitHandOverRequest(lead: string | undefined, worktrees: readonly ChatWorktree[], mergeInto: string | undefined, reason: string, message: string): string {
  return [
    `[Manor] Manor tried to commit this Session's confirmed change itself, and Git refused:\n\`\`\`\n${reason}\n\`\`\``,
    `Commit with this message unless your fix changes what it says:\n\`\`\`\n${message}\n\`\`\``,
    commitRequest(lead, worktrees, mergeInto, []),
  ].join('\n')
}

/**
 * Manor's one message to the lead when its own merge stopped (2026-10-19): Git's words,
 * then what to do in the worktree. The lead fixes and commits; Manor merges again once
 * the turn ends, and shows the user a conflict resolution that did more than keep both sides.
 */
export function mergeTroubleRequest(lead: string | undefined, trouble: Pick<NonNullable<WorkMerge['trouble']>, 'kind' | 'text' | 'repo'>, branch: string, mergeInto: string): string {
  const to = (rest: string) => lead === undefined ? `${rest[0]!.toUpperCase()}${rest.slice(1)}` : `@${lead}, ${rest}`
  const hands = `Do not merge, push or touch the linked folder: the merge stays Manor's.`
  const said = `\n\`\`\`\n${trouble.text}\n\`\`\`\n`
  switch (trouble.kind) {
    case 'conflict':
      return `[Manor] Manor could not merge this Session's confirmed change into ${mergeInto}.${said}${to(`in the worktree ${trouble.repo}, rebase ${branch} onto ${mergeInto} yourself and resolve the conflict so this Session's change and the conflicting commits on ${mergeInto} both keep their behaviour. Run the focused tests for this change and the tests covering the files those commits changed, fix what fails and amend it into your commit.`)} ${HOOK_RULE} ${hands} When your turn ends Manor shows the user how you resolved the conflict, unless you only kept both sides' lines, and merges after that. If the only fix drops one side's behaviour, leave ${branch} as it is and stop as the user's choice. ${STOP_RULE}`
    case 'hook':
      return `[Manor] Manor rebased ${branch} onto ${mergeInto}, and the pre-commit hook failed on the result.${said}${to(`fix the cause in the worktree ${trouble.repo} and amend it into your commit.`)} ${HOOK_RULE} ${hands} Manor runs the hook again and merges when your turn ends. ${STOP_RULE}`
    case 'rebase':
      return `[Manor] Git refused to rebase ${branch} onto ${mergeInto}.${said}${to(`make the worktree ${trouble.repo} ready to rebase: commit this Session's work or clear what blocks, never discard it, and leave the rebase itself to Manor.`)} ${HOOK_RULE} ${hands} Manor merges when your turn ends. ${STOP_RULE}`
  }
}

/** The same request as `commitRequest`, as data for the tasks card clients draw in its place. */
export function confirmRequestOf(worktrees: readonly ChatWorktree[], mergeInto: string | undefined, unreviewed: readonly string[]): ConfirmRequest {
  const rows = worktrees.map((row) => ({ branch: row.branch, folder: path.basename(row.sourcePath), source: row.sourcePath }))
  if (worktrees.length === 0) return { variant: 'checkout', worktrees: [] }
  if (mergeInto === undefined) return { variant: 'worktree', worktrees: rows }
  return { variant: unreviewed.length > 0 ? 'merge_withheld' : 'merge', worktrees: rows, mergeInto }
}

/**
 * The message Retry posts to the lead: Confirm's own request again, under the same
 * approval, for only the worktrees that hold approved files and with every approved
 * file named, so a step that already landed is not redone and nothing outside the
 * approval is staged or merged.
 */
export function retryRequest(lead: string | undefined, worktrees: readonly ChatWorktree[], mergeInto: string | undefined, held: WorkCompletion): string {
  const files = held.repos.flatMap((repo) => repo.files.map((file) => `- ${path.basename(repo.sourcePath ?? repo.path)}/${file}`))
  const approved = worktrees.filter((row) => held.repos.some((repo) => repo.sourcePath === row.sourcePath))
  const what = held.operation === 'merge' ? 'merge' : 'commit'
  return [
    `[Manor] The user pressed Retry on the blocked ${what}. Their Confirm still approves it: the approved files are unchanged since then.${held.message === undefined ? '' : ` The last attempt stopped on: ${held.message}`} A step that already shows stays done, so do not commit this change again when it is already on the branch, and stage only these approved files:`,
    ...files,
    commitRequest(lead, approved, mergeInto, [], held.repos),
  ].join('\n')
}

/** A merge approval whose branch went stale; the service answers it with a fresh checkout status. */
export class MergeTargetMoved extends Error {
  constructor(readonly chatId: string, message: string) {
    super(message)
  }
}

/** Refuses a merge approval the linked folders no longer match, before anything is stored. */
async function assertMergeTarget(chatId: string, worktrees: readonly ChatWorktree[], mergeInto: string): Promise<void> {
  if (worktrees.length === 0) throw new MergeTargetMoved(chatId, 'This Session no longer works in a worktree. Nothing was confirmed; confirm again.')
  for (const row of worktrees) {
    const live = await currentBranch(row.sourcePath)
    if (live !== mergeInto) {
      throw new MergeTargetMoved(chatId, `${row.sourcePath} is on ${live ?? 'no branch'} now, not ${mergeInto}. Nothing was confirmed; confirm again.`)
    }
  }
}

/**
 * Commits the worktree branches carry beyond `mergeInto` that this Session did not make.
 * The Session's own commits since its worktree was created (an earlier round Manor or
 * the lead committed, a rebase of only those) were reviewed with it; the branch's reflog
 * tells them apart from commits a reused branch already carried or that came from elsewhere.
 */
async function unreviewedCommits(worktrees: readonly ChatWorktree[], mergeInto: string): Promise<string[]> {
  const lines: string[] = []
  for (const row of worktrees) {
    // A row without its creation time (0) proves no authorship.
    const own = row.createdAt > 0 ? await ownCommitsSince(row.worktreePath, row.branch, row.createdAt) : new Set<string>()
    const commits = await commitsNotIn(row.worktreePath, mergeInto, own)
    if (commits === null) lines.push(`- ${row.branch}: Manor could not read its history`)
    else lines.push(...commits.map((commit) => `- ${row.branch}: ${commit}`))
  }
  return lines
}

/** A published proposal nobody accepted or rejected yet; a later revision of its assignment replaces it. */
const awaitingAccept = (row: WorkHandoff): boolean =>
  row.version > 0 && row.state === 'active' && row.acceptedAt === null && row.workChatId === null

/** Whether any turn in this chat changed files, measured by Git or reported where Git cannot see. */
async function changedFiles(store: Store, chatId: string): Promise<boolean> {
  return sessionChangedFiles(await store.loadEvents(chatId)).length > 0
}

/** A merge stage without its place in the queue, which only a waiting merge has. */
const withoutQueue = ({ after: _after, ahead: _ahead, ...merge }: WorkMerge): WorkMerge => merge
const mergeFolders = (completion: WorkCompletion) => completion.repos.map((repo) => repo.sourcePath ?? repo.path)

/** The settled note once its outcome is known, or known to be missing. */
const settledText = (title: string, outcome: string | null): string =>
  outcome === null ? `Session “${title}” settled, outcome unavailable.` : `Session “${title}” settled: ${outcome}`

/** Owns every mutation of the Chat → Work relationship. */
export class WorkModule {
  /**
   * One assignment of one Chat at a time, so a retry in the same turn and a revision in a
   * later turn see each other's writes. Other assignments and Chats never wait.
   */
  private readonly creationTails = new Map<string, Promise<void>>()
  /** Manual lifecycle writes stay ordered while their outcome writer is running. */
  private readonly lifecycleTails = new Map<string, Promise<void>>()
  private readonly lifecycleVersions = new Map<string, number>()
  /**
   * The newest Settle or Unsettle the user asked for per Chat, held from the click until
   * that request finishes. Set before any await, so an outcome arriving meanwhile sees it.
   */
  private readonly lifecycleIntents = new Map<string, { settled: boolean }>()
  private blockedPoll: ReturnType<typeof setTimeout> | undefined
  /**
   * Manor's merges of confirmed worktree Sessions, one at a time per linked folder. It
   * lives in memory: after a restart the confirmed completions, whose stage the store
   * keeps, queue again in the order they were confirmed (`reconcileCompletion`).
   */
  private readonly lanes = new MergeLanes((id) => this.runMerge(id), () => { void this.publishQueue().catch(() => undefined) })

  constructor(private readonly options: WorkModuleOptions) {}

  async useTool(context: WorkToolContext, input: WorkToolInput): Promise<unknown> {
    const key = `${context.chatId}::${input.assignmentKey}`
    const ahead = this.creationTails.get(key) ?? Promise.resolve()
    const run = ahead.then(() => this.create(context, input))
    const settled = run.then(() => undefined, () => undefined)
    this.creationTails.set(key, settled)
    try {
      return await run
    } finally {
      if (this.creationTails.get(key) === settled) this.creationTails.delete(key)
    }
  }

  private async create(context: WorkToolContext, input: WorkToolInput): Promise<unknown> {
    const { store } = this.options
    if (!this.options.orchestrator.isActiveTurn(context.chatId, context.agentId, context.turnId)) {
      throw new Error('This session capability belongs to a turn that is no longer active.')
    }
    if (context.noProposal === true) {
      throw new Error('This turn did not start from the user\'s message or a brief they handed over, so it cannot propose work. Say what you would propose; the user starts it.')
    }
    const source = await store.getChat(context.chatId)
    if (source === undefined || (source.kind !== 'dm' && source.kind !== 'group' && source.kind !== 'project' && source.kind !== 'browser')) {
      throw new Error('Sessions can only be handed off from Agents, Browser or a project session.')
    }
    if ((source.kind === 'dm' || source.kind === 'group') && !source.memberIds.includes(context.agentId)) {
      throw new Error('The acting persona is no longer in this Chat.')
    }
    // A project thread speaks as the Single voice; it authors like a chat persona and
    // may name any Session persona, the default one when it names nobody. It is not on the roster, so it
    // can never be resolved as a lead or a supporting member itself. A hidden project's
    // archived thread authors nothing, also from a turn still running when it was hidden.
    const threadAuthor = context.agentId === SINGLE_CHAT_VOICE.id && source.kind === 'project' && source.projectId !== null &&
      await liveProjectThread(store, await store.getProject(source.projectId)) === source.id
    const author: HandoffAuthor | undefined = threadAuthor
      ? { id: SINGLE_CHAT_VOICE.id, name: PROJECT_THREAD_WRITER, placement: 'chat' }
      : this.options.agents().find((agent) => agent.id === context.agentId)
    if (author === undefined) throw new Error('The handoff author no longer exists.')
    // The runtime choice is the project thread's own; persona cards keep the house default.
    const runtimeProposal = proposedRuntime(input, this.options.offModels?.())
    if (runtimeProposal !== undefined && !threadAuthor) {
      throw new Error('Only a project thread proposes a runtime. Leave provider, model, effort and runtimeReason out.')
    }
    const firstExecutor = input.firstExecutor === undefined ? undefined : this.resolveAgent(input.firstExecutor)
    if (firstExecutor !== undefined) this.validateExecutor(firstExecutor.id, author.id)
    const named = [...new Set([...(input.supportingPersonas ?? []), ...(input.firstExecutor === undefined ? [] : [input.firstExecutor])])]
    // A thread that names nobody gets the default Session persona where this install has
    // one that works in Sessions. Without it the card has no lead and runs as Single only.
    const defaultLead = named.length === 0 && threadAuthor
      ? this.options.agents().find((agent) => agent.id === SESSION_DEFAULT_AGENT_ID && agent.placement !== 'chat')
      : undefined
    const requested = (defaultLead === undefined ? named.map((reference) => this.resolveAgent(reference)) : [defaultLead])
      .filter((agent, index, all) => agent.id !== author.id && all.findIndex((candidate) => candidate.id === agent.id) === index)
    let lead: HandoffAuthor | undefined = author
    let supporting = requested
    if (author.placement === 'chat') {
      const leadIndex = requested.findIndex((agent) => firstExecutor === undefined ? agent.placement !== 'chat' : agent.id === firstExecutor.id)
      if (leadIndex >= 0) {
        lead = requested[leadIndex]!
        supporting = requested.filter((_, index) => index !== leadIndex)
      } else if (threadAuthor && requested.length === 0) {
        lead = undefined
      } else {
        throw new Error(`${author.name} stays in chat. Name a Session persona as firstExecutor to lead this assignment.`)
      }
    }

    // The home room is a destination too, by its id or its name; no list holds it.
    const home = await store.getProject(HOME_PROJECT_ID)
    const project = this.resolveProject(input.project, [...await store.listProjects(), ...(home === undefined ? [] : [home])])
    const chatPersonas = supporting.filter((agent) => agent.placement === 'chat')
    if (chatPersonas.length > 0) throw new Error(`Chat personas cannot join project work: ${names(chatPersonas.map((agent) => agent.name))}.`)
    const allowed = new Set(lead?.mentionAllowlist ?? [])
    const unsummonable = supporting.filter((agent) => !allowed.has(agent.id))
    if (unsummonable.length > 0) {
      throw new Error(`${lead?.name ?? author.name} cannot summon: ${names(unsummonable.map((agent) => agent.name))}. Update the mention allowlist or leave them out.`)
    }

    const title = input.title.trim()
    const task = input.task.trim()
    // A thread's card for a forwarded brief carries what the user saw on the brief's card.
    const inherited = threadAuthor ? await this.briefAttachments(input.assignmentKey, project.id) : []
    const attachments = await resolveHandoffAttachments(store, source.id, input.attachments ?? [], inherited)
    const replaces = await this.pendingRevisions(source.id, input.assignmentKey, context.turnId)
    // Holding each replaced proposal's lifecycle keeps a racing Accept or Reject on it
    // from starting the old version: whichever runs first, the other sees its outcome.
    return this.orderLifecycles(replaces.map((row) => row.id), async () => {
      const pending = await this.pendingRevisions(source.id, input.assignmentKey, context.turnId)
      const revision = Math.max(0, ...pending.map((row) => row.revision ?? 1)) + 1
      const reservation = await store.reserveWorkHandoff({
        sourceChatId: source.id,
        sourceTurnId: context.turnId,
        assignmentKey: input.assignmentKey,
        task,
        ...(input.summary === undefined ? {} : { summary: input.summary }),
        authorAgentId: author.id,
        projectId: project.id,
        projectName: project.name,
        title,
        // Empty when nobody leads: see `workHandoffHasLead`.
        leadAgentId: lead?.id ?? '',
        leadAgentName: lead?.name ?? '',
        ...(firstExecutor === undefined ? {} : { firstExecutor: { agentId: firstExecutor.id, agentName: firstExecutor.name } }),
        supportingAgentIds: supporting.map((agent) => agent.id),
        supportingAgentNames: supporting.map((agent) => agent.name),
        ...(revision > 1 ? { revision } : {}),
        ...(runtimeProposal === undefined ? {} : { proposedRuntime: runtimeProposal }),
        ...(attachments.length === 0 ? {} : { attachments }),
      })
      if (reservation.handoff.state === 'deleted') return this.toolResult(reservation.handoff, true)
      let saved = reservation.handoff
      const unpublished = saved.version === 0
      if (unpublished) {
        const team = supporting.length === 0 ? '' : ` Starting team: ${supporting.map((agent) => agent.name).join(', ')}.`
        const label = (saved.revision ?? 1) > 1 ? ` (v${saved.revision})` : ''
        saved = await store.finalizeWorkHandoff(saved.id, null, {
          type: 'system_note',
          kind: 'info',
          text: lead === undefined
            ? `Session “${title}”${label} awaits acceptance in ${project.name}.`
            : `Session “${title}”${label} awaits acceptance in ${project.name}, led by ${lead.name}. Starts: ${firstExecutor?.name ?? lead.name}.${team}`,
          workHandoffId: saved.id,
          workHandoffPhase: 'created',
        })
        await this.broadcastReceipt(saved).catch(() => undefined)
      }
      // A retry finishes a replacement an earlier attempt left half done, never a closed one.
      const replacing = awaitingAccept(saved) ? pending : []
      for (const row of replacing) await this.supersede(row, saved)
      if (unpublished || replacing.length > 0) await this.options.broadcastDirectory().catch(() => undefined)
      if (unpublished && threadAuthor && this.options.projectThreads !== undefined) {
        const published = saved
        // Before the call returns, so the thread sees its Session's row in the same turn.
        await this.options.projectThreads.noteProposal(published)
          .catch((error: unknown) => console.warn(`[manor] Notes row for “${published.title}” could not be written`, error))
        // After this call's lifecycle hold: accepting takes the new proposal's own.
        void Promise.resolve().then(() => this.options.projectThreads?.proposed(published)).catch(async (error: unknown) => {
          const event = await store.appendEvent(published.sourceChatId, {
            type: 'system_note', kind: 'error',
            text: `Could not start “${published.title}” for the brief: ${error instanceof Error ? error.message : String(error)}`,
          })
          this.options.broadcast({ type: 'event', chatId: published.sourceChatId, event })
        }).catch(() => undefined)
      }
      const replaced = (await store.listWorkHandoffs()).filter((row) => row.supersededById === saved.id)
      return this.toolResult(saved, !reservation.created, replaced.at(-1)?.id)
    })
  }

  /** The attachments of the forwarded brief a `brief-<id>` card is made for, in the same project. */
  private async briefAttachments(assignmentKey: string, projectId: string): Promise<WorkAttachment[]> {
    if (!assignmentKey.startsWith('brief-')) return []
    const briefId = assignmentKey.slice('brief-'.length)
    const brief = (await this.options.store.listWorkHandoffs()).find((row) => row.id === briefId)
    return brief?.forwardedAt !== undefined && brief.projectId === projectId ? brief.attachments ?? [] : []
  }

  /** Earlier proposals of this assignment in this Chat that still wait for Accept; a new call replaces them. */
  private async pendingRevisions(sourceChatId: string, assignmentKey: string, turnId: string): Promise<WorkHandoff[]> {
    return (await this.options.store.listWorkHandoffs()).filter((row) =>
      row.sourceChatId === sourceChatId && (row.assignmentKey ?? 'default') === assignmentKey &&
      row.sourceTurnId !== turnId && awaitingAccept(row))
  }

  private async supersede(row: WorkHandoff, by: WorkHandoff): Promise<void> {
    const label = `v${by.revision ?? 1}`
    const saved = await this.options.store.transitionWorkHandoff(row.id, {
      state: 'settled', result: `Replaced by ${label}.`, resultAt: Date.now(), supersededById: by.id,
    }, {
      type: 'system_note',
      kind: 'info',
      text: `Session proposal “${row.title}” was replaced by ${label}.`,
      workHandoffId: row.id,
      workHandoffPhase: 'settled',
    })
    await this.broadcastReceipt(saved).catch(() => undefined)
  }

  private async handoffFor(reference: string): Promise<WorkHandoff> {
    const handoff = (await this.options.store.listWorkHandoffs()).find((row) => row.id === reference || row.workChatId === reference)
    if (handoff === undefined) throw new Error(`unknown work handoff for ${reference}`)
    return handoff
  }

  async accept(reference: string, options: WorkAcceptanceOptions = {}): Promise<string> {
    const { checkout } = options
    const held = await this.handoffFor(reference)
    return this.orderLifecycle(held.id, async () => {
      const { store } = this.options
      let handoff = await this.handoffFor(held.id)
      if (handoff.supersededById !== undefined) await this.refuseSuperseded()
      // A brief already handed to its project thread answers with that thread.
      if (handoff.forwardedAt !== undefined) {
        const project = await store.getProject(handoff.projectId)
        if (project?.threadChatId === undefined) throw new Error('The project thread this brief went to no longer exists.')
        if (await liveProjectThread(store, project) === undefined) throw new Error(`${project.name} is hidden. Add it back under Projects to continue this brief.`)
        return project.threadChatId
      }
      // The same text is a retry of an edit that already landed, not a new edit.
      const edit = options.task === undefined || options.task === handoff.task ? undefined : options.task
      const awaiting = handoff.acceptedAt === null && handoff.workChatId === null && handoff.state === 'active'
      // Read from their source chat before anything moves, so a missing one refuses this Accept.
      const attachments = awaiting ? await loadHandoffAttachments(store, handoff.attachments ?? []) : undefined
      // The thread receives the prompt the user approved, their edit included.
      if (awaiting &&
          await this.options.projectThreads?.forwardBrief(handoff, {
            ...(options.mode === undefined ? {} : { mode: options.mode }),
            ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
            ...(checkout === undefined ? {} : { checkout }),
          }, edit) === true) {
        const project = await store.getProject(handoff.projectId)
        if (project?.threadChatId !== undefined) return project.threadChatId
      }
      // Once the session exists its kickoff is written, so an edit could only diverge from it.
      if (edit !== undefined && handoff.workChatId !== null) {
        throw new Error('This session has already been created, so its prompt can no longer be edited.')
      }
      if (handoff.acceptedAt !== null) {
        if (handoff.workChatId === null || await store.getChat(handoff.workChatId) === undefined) throw new Error('The accepted session no longer exists.')
        await this.options.broadcastDirectory().catch(() => undefined)
        return handoff.workChatId
      }
      if (handoff.state !== 'active') throw new Error('This session is no longer awaiting acceptance.')
      // A project thread's card is Single unless the user picks Multiple, on the thread's
      // proposed runtime or else the house default. A persona's card names its own mode.
      const threadCard = handoff.authorAgentId === SINGLE_CHAT_VOICE.id
      const single = (options.mode ?? (threadCard ? 'single' : 'house')) === 'single'
      const fallback = threadCard ? handoff.proposedRuntime?.runtime ?? workSingleDefault(this.options.agents(), this.options.offModels?.()) : undefined
      const runtime = single ? singleRuntime(options.runtime ?? fallback) : undefined
      if (!single && options.runtime !== undefined) throw new Error('Runtime selection requires Single mode.')
      if (!single) {
        if (!workHandoffHasLead(handoff)) {
          // Same condition and wording as `workProposalMultipleBlock` in client-runtime, which the server does not import.
          throw new Error(this.options.agents().some((agent) => agent.placement !== 'chat')
            ? 'No Session persona leads this proposal, so it runs as Single.'
            : 'Add a session agent to run Multiple.')
        }
        // Recheck the whole proposal, including old proposals that predate placement.
        for (const id of [handoff.leadAgentId, ...handoff.supportingAgentIds]) this.validateExecutor(id)
      }
      const materialized = handoff.workChatId === null
      if (materialized) {
        if (!single) this.validateExecutor(handoff.firstExecutor?.agentId ?? handoff.leadAgentId,
          handoff.firstExecutor === undefined ? undefined : handoff.authorAgentId ?? handoff.leadAgentId)
        // Copied onto the kickoff, so the Session holds its own.
        handoff = await store.materializeWorkHandoff(handoff.id, runtime, edit, attachments)
      }
      const chatId = handoff.workChatId
      if (chatId === null) throw new Error('This session has no target.')
      try {
        const room = await store.getChat(chatId)
        if (room === undefined || room.settledAt !== null || room.archivedAt !== null) {
          throw new Error('This session is no longer awaiting acceptance.')
        }
        if ((room.mode === 'single') !== single) throw new Error('An existing session cannot switch between Single and Multiple.')
        const events = await store.loadEvents(chatId)
        // Older handoffs started before Accept existed as a gate. Never replay them.
        const alreadyStarted = events.some((event) => 'turnId' in event && event.turnId !== undefined)
        const kickoff = events.find((event) => event.type === 'user_message' && event.workHandoffId === handoff.id)
        if (!alreadyStarted && (kickoff === undefined || kickoff.type !== 'user_message')) throw new Error('This session has no stored kickoff.')
        const authorAgentId = kickoff?.type === 'user_message' ? kickoff.workAuthorAgentId ?? handoff.leadAgentId : handoff.leadAgentId
        const validate = () => {
          if (!single && !alreadyStarted) this.validateExecutor(handoff.firstExecutor?.agentId ?? handoff.leadAgentId,
            handoff.firstExecutor === undefined ? undefined : authorAgentId)
        }
        validate()
        const persistAcceptance = async (startBranches?: WorkHandoff['startBranches']) => {
          validate()
          await store.acceptWorkHandoff(chatId, startBranches)
        }
        if (checkout?.mode === 'worktree') {
          if (alreadyStarted) throw new Error('A session that has already started cannot switch worktrees.')
          if (this.options.prepareCheckout === undefined) throw new Error('Worktree isolation is unavailable.')
          await this.options.prepareCheckout(chatId, checkout, persistAcceptance)
        } else {
          // A shared checkout can be switched under the Session; Confirm holds it to this branch.
          const project = alreadyStarted ? undefined : await store.getProject(handoff.projectId)
          await persistAcceptance(project === undefined ? undefined : await checkoutBranches(project.repoPaths))
        }
        if (!alreadyStarted && kickoff?.type === 'user_message') {
          this.options.orchestrator.resumeChat(chatId)
          void this.options.orchestrator.startStoredWorkHandoff(chatId, kickoff.text, {
            source: 'work_handoff', handoffId: handoff.id, sourceChatId: handoff.sourceChatId,
            authorAgentId,
            ...(kickoff.workProjectName === undefined ? {} : { projectName: kickoff.workProjectName }),
            supportingAgentIds: handoff.supportingAgentIds, targetAgentId: handoff.leadAgentId,
            ...(handoff.firstExecutor === undefined ? {} : { firstExecutorAgentId: handoff.firstExecutor.agentId }),
          }).catch(async (error: unknown) => {
            const event = await store.appendEvent(chatId, {
              type: 'system_note', kind: 'error',
              text: `Could not start the session with ${single ? runtime?.model : handoff.firstExecutor?.agentName ?? handoff.leadAgentName}: ${error instanceof Error ? error.message : String(error)}`,
            })
            this.options.broadcast({ type: 'event', chatId, event })
          }).catch(() => undefined)
        }
      } catch (error) {
        if (materialized) {
          await store.resetWorkHandoffTarget(handoff.id)
          if (await store.getChat(chatId) === undefined) this.options.orchestrator.discard(chatId)
        }
        throw error
      }
      await this.options.broadcastDirectory().catch(() => undefined)
      return chatId
    })
  }

  async reject(handoffId: string): Promise<void> {
    const held = await this.handoffFor(handoffId)
    await this.orderLifecycle(held.id, async () => {
      const handoff = await this.handoffFor(handoffId)
      if (handoff.supersededById !== undefined) await this.refuseSuperseded()
      if (handoff.acceptedAt !== null) throw new Error('This session has already been accepted.')
      if (handoff.state !== 'active') { await this.options.broadcastDirectory(); return }
      if (handoff.workChatId !== null) {
        // Legacy targets with content retain their existing lifecycle and transcript.
        try {
          await this.transitionSettled(handoff.workChatId, true, this.lifecycleVersions.get(handoff.id) ?? 0, true)
        } catch (error) {
          const room = await this.options.store.getChat(handoff.workChatId).catch(() => undefined)
          if (room?.settledAt === null) this.options.orchestrator.resumeChat(handoff.workChatId)
          throw error
        }
        return
      }
      const saved = await this.options.store.transitionWorkHandoff(handoff.id, {
        state: 'settled', result: 'Rejected before work started.', resultAt: Date.now(),
      }, {
        type: 'system_note', kind: 'info', text: `Session “${handoff.title}” rejected before work started.`,
        workHandoffId: handoff.id, workHandoffPhase: 'settled',
      })
      await this.broadcastReceipt(saved)
      await this.options.broadcastDirectory()
    })
  }

  /**
   * The user agrees the goal is reached. When the Session changed files, that click is also
   * their approval to commit. In a worktree Session Manor commits the approved files itself,
   * with the message the lead handed in on `goal_reached` (2026-10-21), and no turn starts
   * unless Git refuses that commit (`commitAttempt`). In the shared checkout, or when the
   * branches already carry commits nobody reviewed with this goal, the lead gets one
   * ordinary turn asking for the commit, routed as if they had typed it. Only the click
   * that stamps the confirmation commits, a Session that changed nothing gets the record
   * alone, and Settle stays its own step. In a worktree Session, `mergeInto` is the branch
   * the button showed, and the click also approves merging into it. Everything that can
   * refuse runs before the stamp, so a failed read or a moved linked folder stores
   * nothing and the next click retries.
   */
  async confirmGoal(handoffId: string, mergeInto?: string, version?: number): Promise<void> {
    return this.orderLifecycle(handoffId, () => this.confirmCurrentGoal(handoffId, mergeInto, version))
  }

  private async confirmCurrentGoal(handoffId: string, mergeInto?: string, version?: number): Promise<void> {
    const { store } = this.options
    const handoff = await this.handoffFor(handoffId)
    if (handoff.goalReport !== undefined && version !== handoff.version) {
      throw new Error('This result has changed. Read the current result before confirming it.')
    }
    const chatId = handoff.workChatId
    if (handoff.goalReport !== undefined && handoff.goalConfirmedAt === undefined && chatId !== null) {
      const room = await store.getChat(chatId)
      const events = await store.loadEvents(chatId)
      // Single judges review significance in its prompt; Multiple keeps Argus's gate.
      const blocked = room?.mode === 'single' ? undefined : goalReviewBlock(events, 'Argus')
      if (blocked !== undefined) throw new Error('The Session changed after review. Use Request changes on the result to get an updated one before confirming.')
    }
    const changed = handoff.goalConfirmedAt === undefined && chatId !== null && await changedFiles(store, chatId)
    const worktrees = changed && chatId !== null ? await store.loadChatWorktrees(chatId) : []
    if (changed && chatId !== null && mergeInto !== undefined) await assertMergeTarget(chatId, worktrees, mergeInto)
    const unreviewed = changed && mergeInto !== undefined ? await unreviewedCommits(worktrees, mergeInto) : []
    if (handoff.goalConfirmedAt === undefined && chatId !== null) {
      const project = await store.getProject(handoff.projectId)
      const completion = await prepareWorkCompletion(
        effectiveRepoPaths(project?.repoPaths ?? [], worktrees),
        handoff.goalChangedFiles ?? sessionChangedFiles(await store.loadEvents(chatId)), worktrees,
        unreviewed.length === 0 ? mergeInto : undefined,
      )
      // A repo whose approved files were committed elsewhere drops out of `completion`; read it live.
      const landed = (handoff.goalCompletion?.repos ?? []).filter((repo) =>
        repo.sourcePath === undefined && !completion.repos.some((now) => now.path === repo.path))
      const moved = leftStartBranch(handoff.startBranches, [...completion.repos, ...await checkoutBranches(landed.map((repo) => repo.path))])
      if (moved !== undefined) throw new Error(moved)
      if (handoff.goalCompletion !== undefined) await assertSameWorkResult(handoff.goalCompletion, completion)
      const lead = await this.addressee(handoff, chatId)
      await this.options.projectThreads?.assertSessionStatusWritable(chatId)
      // Manor commits a Session-owned worktree itself; a withheld merge needs the lead to tell the user why.
      const manor = completion.operation !== 'none' && unreviewed.length === 0 && worktrees.length > 0 &&
        completion.repos.every((repo) => repo.sourcePath !== undefined)
      const confirmed = completion.operation === 'none'
        ? await store.confirmWorkGoal(handoff.id, version, completion)
        : await store.confirmWorkGoal(handoff.id, version, completion,
          manor ? manorCommitRequest(worktrees, mergeInto) : commitRequest(lead, worktrees, mergeInto, unreviewed, completion.repos),
          { ...confirmRequestOf(worktrees, mergeInto, unreviewed), ...(manor ? { manor: true as const } : {}) })
      if (confirmed && completion.operation !== 'none') {
        const saved = await this.handoffFor(handoff.id)
        const event = (await store.loadEvents(chatId)).find((row) => row.id === saved.goalCompletion?.requestEventId)
        if (event?.type === 'user_message' && saved.goalCompletion !== undefined) {
          this.options.broadcast({ type: 'event', chatId, event })
          // The message belongs to this result: a reopened one dropped it with the report.
          if (manor) this.commitAttempt(handoff.id, chatId, event, saved.goalCompletion, handoff.goalReport?.commit)
          // Read once more after the request's dispatch is settled, so Git's answer, or
          // that it has none, replaces Merging… even when the turn's own end came too early.
          else this.runAttempt(handoff.id, chatId, event, completion)
        }
      }
      await this.options.projectThreads?.completeSessionStatus(chatId)
      await this.options.broadcastDirectory()
      return
    }
    await store.confirmWorkGoal(handoff.id, version)
    if (chatId !== null) await this.options.projectThreads?.completeSessionStatus(chatId)
    await this.options.broadcastDirectory()
  }

  /**
   * Retry on a Merge blocked or Commit blocked card. The same approval tries again: no
   * reopen, no new review, no new Confirm. Refused while the last attempt still runs,
   * or once the Session is settled. When the approved files changed since Confirm
   * (`retryRefusal`) it runs nothing and answers quietly: the card names why in place
   * of Retry, so a second error beside that line would say the same thing twice.
   */
  async retryCompletion(handoffId: string): Promise<void> {
    await this.orderLifecycle(handoffId, async () => {
      const { store } = this.options
      const handoff = await this.handoffFor(handoffId)
      const held = handoff.goalCompletion
      const chatId = handoff.workChatId
      // A reread landed it while the click was on its way; the card follows the directory.
      if (handoff.goalConfirmedAt !== undefined && held?.status === 'complete') return
      if (handoff.goalConfirmedAt === undefined || held?.status !== 'blocked' || held.requestEventId === undefined || chatId === null) {
        throw new Error('Only a blocked merge or commit can be retried.')
      }
      const room = await store.getChat(chatId)
      if (handoff.state !== 'active' || room === undefined || room.settledAt !== null || room.archivedAt !== null) {
        throw new Error('This Session is settled. Reopen it to retry.')
      }
      const attempt = (await store.loadEvents(chatId)).find((event) => event.id === attemptOf(held))
      if (attempt?.type === 'user_message' && (attempt.dispatchState === 'pending' || attempt.dispatchState === 'started')) {
        throw new Error('The last attempt is still running.')
      }
      const refused = await retryRefusal(held)
      if (refused !== undefined) {
        if (held.retryRefused !== refused) {
          await store.updateWorkCompletion(handoff.id, { ...held, retryRefused: refused })
          await this.options.broadcastDirectory()
        }
        return
      }
      const worktrees = await store.loadChatWorktrees(chatId)
      const mergeInto = held.operation === 'merge' ? held.repos.find((repo) => repo.mergeInto !== undefined)?.mergeInto : undefined
      const request = retryRequest(await this.addressee(handoff, chatId), worktrees, mergeInto, held)
      const { event } = await store.retryWorkCompletion(handoff.id, held.requestEventId, request, confirmRequestOf(worktrees, mergeInto, []))
      this.options.broadcast({ type: 'event', chatId, event })
      this.runAttempt(handoff.id, chatId, event, held)
      await this.options.broadcastDirectory()
    })
  }

  /**
   * Runs Confirm's or Retry's request. Git is read once more after the turn's dispatch
   * is settled, so its answer, or that it has none, replaces Merging… even when the
   * turn's own end came too early; a change that landed then settles the Session
   * through reconcile.
   */
  private runAttempt(handoffId: string, chatId: string, event: Extract<ThreadEvent, { type: 'user_message' }>, completion: WorkCompletion): void {
    // A merge's place in line is the click's, not the commit turn's end.
    if (completion.operation === 'merge') this.lanes.reserve(handoffId, mergeFolders(completion))
    const answered = this.options.orchestrator.runStoredUserMessage(chatId, event)
    const after = () => this.reconcileCompletion(chatId)
    // The turn is over: its merge has queued by now, or the reserved place goes.
    void answered.then(after, after).catch(() => undefined).finally(() => this.lanes.release(handoffId))
    void this.watchCommits(handoffId, event.id, answered)
  }

  /**
   * Manor's own commit of a confirmed worktree Session, in the chat's turn order so no
   * turn edits the files meanwhile. Git work runs outside the lifecycle queue: a hook may
   * test for minutes. A commit Git took goes on through reconcile, which queues the merge
   * at the place the click reserved, or settles a commit-only Session. One Git refused
   * becomes the lead's turn under the same approval (`handOverCommit`).
   */
  private commitAttempt(handoffId: string, chatId: string, event: Extract<ThreadEvent, { type: 'user_message' }>, completion: WorkCompletion, commit: GoalCommit | undefined): void {
    if (completion.operation === 'merge') this.lanes.reserve(handoffId, mergeFolders(completion))
    let handedOver = false
    void this.options.orchestrator.runExclusive(chatId, () => this.commitApproved(handoffId, chatId, event.id, completion, commit))
      .then(async (outcome) => {
        if (outcome?.kind === 'refused') handedOver = await this.handOverCommit(handoffId, chatId, event.id, outcome)
        if (outcome?.kind === 'blocked') await this.blockCommit(handoffId, chatId, event.id, outcome.reason)
        if (!handedOver) {
          await this.finishRequest(chatId, event.id)
          await this.reconcileCompletion(chatId)
        }
      })
      .catch(async () => {
        await this.finishRequest(chatId, event.id)
        await this.reconcileCompletion(chatId)
      })
      .catch(() => undefined)
      // A merge queued by now keeps its place; the turn Manor handed over releases its own.
      .finally(() => { if (!handedOver) this.lanes.release(handoffId) })
  }

  /**
   * Commits each repo's approved files with the lead's message, or the writer's when it
   * handed none in. Nothing runs once the confirmation is no longer this one's, or the
   * Session settled. Undefined when every commit landed or nothing ran. `refused` is Git's
   * refusal, with the repos still to commit and the message Manor tried, for the lead to
   * fix. `blocked` is beyond the approval, so only a new result helps: files changed while
   * the commit waited its turn, or a hook put more into the commit than Confirm approved,
   * which Manor takes back off the branch.
   */
  private async commitApproved(handoffId: string, chatId: string, requestEventId: string, completion: WorkCompletion, commit: GoalCommit | undefined) {
    const handoff = await this.handoffFor(handoffId)
    const held = handoff.goalCompletion
    const room = await this.options.store.getChat(chatId)
    if (held === undefined || attemptOf(held) !== requestEventId || held.status !== 'pending' || handoff.state !== 'active' ||
        room === undefined || room.settledAt !== null || room.archivedAt !== null) return undefined
    const written = commit === undefined ? undefined : [commit.subject, commit.body].filter((part) => part !== undefined).join('\n\n')
    for (const [at, repo] of completion.repos.entries()) {
      if (!await approvalHolds(repo)) {
        return { kind: 'blocked' as const, reason: `The Session's files changed after Confirm, so Manor did not commit them. Request a new result in the Session.` }
      }
      const message = written ?? await this.writtenMessage(chatId, repo.path, repo.files)
      const parent = await repoHead(repo.path)
      try {
        await commitFiles(repo.path, repo.files, message)
      } catch (error) {
        const reason = error instanceof SessionGitError && error.output !== undefined ? troubleText(error.message, error.output)
          : error instanceof Error ? error.message : String(error)
        return { kind: 'refused' as const, reason, message, repos: completion.repos.slice(at) }
      }
      // A hook may stage or rewrite more than the approval; then the commit comes back off.
      const beyond = await beyondApproval(repo, parent).catch(() => undefined)
      if (beyond === undefined || beyond.length > 0) {
        await undoCommit(repo.path, parent)
        return { kind: 'blocked' as const, reason: beyond === undefined
          ? 'Manor could not check its commit against what Confirm approved, so it took the commit back.'
          : beyondLine(beyond) }
      }
    }
    return undefined
  }

  /** The writer's message for one repo's approved files, or a plain one when no model answered. */
  private async writtenMessage(chatId: string, repo: string, files: readonly string[]): Promise<string> {
    const patch = await commitPatch(repo, files).catch(() => '')
    const written = patch === '' ? undefined : await this.options.writeCommitMessage?.(chatId, patch).catch(() => undefined)
    return written ?? fallbackCommitMessage(files)
  }

  /** Marks Manor's own request over, so reconcile reads Git's answer as final. */
  private async finishRequest(chatId: string, requestEventId: string): Promise<void> {
    const { store } = this.options
    const stored = (await store.loadEvents(chatId)).find((row) => row.id === requestEventId)
    if (stored?.type !== 'user_message' || stored.dispatchState !== 'started') return
    const finished = { ...stored, dispatchState: 'completed' as const }
    await store.replaceEvent(chatId, finished)
    this.options.broadcast({ type: 'event', chatId, event: finished })
  }

  /** Manor's own commit stopped beyond what the lead can fix: the card names why, and Retry stays. */
  private async blockCommit(handoffId: string, chatId: string, requestEventId: string, reason: string): Promise<void> {
    await this.orderLifecycle(handoffId, async () => {
      const held = (await this.handoffFor(handoffId)).goalCompletion
      if (held === undefined || attemptOf(held) !== requestEventId || held.status !== 'pending') return
      await this.finishRequest(chatId, requestEventId)
      await this.writeBlocked(handoffId, chatId, held, reason)
    })
  }

  /**
   * A blocked completion with Manor's reason, unless Git shows it landed after all. The
   * reason is an error note after the attempt, so every later Git read names it too.
   */
  private async writeBlocked(handoffId: string, chatId: string, held: WorkCompletion, message: string): Promise<void> {
    const { store } = this.options
    const note = await store.appendEvent(chatId, { type: 'system_note', kind: 'error', text: message })
    this.options.broadcast({ type: 'event', chatId, event: note })
    const seen = await observeWorkCompletion(held, await store.loadEvents(chatId))
    await store.updateWorkCompletion(handoffId, seen.status === 'complete' || seen.status === 'blocked' ? seen
      : { ...seen, status: 'blocked', completedAt: undefined, commits: undefined, message })
    await this.options.broadcastDirectory()
  }

  /**
   * What Manor's own commit holds beyond the approval, once Git shows it on the branch
   * and before the merge: the backstop for a restart that cut Manor's check short. Its one
   * commit sits on `before`, so the branch tip says it all. A lead's commit turn is not
   * judged here.
   */
  private async beyondScope(held: WorkCompletion, seen: WorkCompletion): Promise<string | undefined> {
    for (const repo of held.repos) {
      const unmerged = seen.status !== 'complete' && seen.committed?.includes(repo.path) === true
      if (repo.sourcePath === undefined || !(unmerged || (held.operation === 'commit' && seen.status === 'complete'))) continue
      const beyond = await beyondApproval(repo, repo.before).catch(() => undefined)
      if (beyond === undefined) return 'Manor could not check the commit against what Confirm approved.'
      if (beyond.length > 0) return beyondLine(beyond)
    }
    return undefined
  }

  /**
   * Git refused Manor's commit: the lead gets one turn to fix the cause and commit, as the
   * next attempt under the same Confirm. That turn's end reconciles, so its merge, a
   * blocked card and Retry all work as they do after any commit turn. A Session settled
   * meanwhile wakes nobody, and its card names the refusal. False when nothing was handed
   * over and reconcile has the word.
   */
  private async handOverCommit(handoffId: string, chatId: string, requestEventId: string, refused: { reason: string; message: string; repos: WorkCompletion['repos'] }): Promise<boolean> {
    return this.orderLifecycle(handoffId, async () => {
      const { store } = this.options
      const handoff = await this.handoffFor(handoffId)
      const held = handoff.goalCompletion
      if (held === undefined || attemptOf(held) !== requestEventId || held.status !== 'pending') return false
      await this.finishRequest(chatId, requestEventId)
      const room = await store.getChat(chatId)
      if (handoff.state !== 'active' || room === undefined || room.settledAt !== null || room.archivedAt !== null) {
        await this.writeBlocked(handoffId, chatId, held, `${refused.reason.split('\n')[0]} The Session is settled, so Manor did not ask the lead to fix it.`)
        return false
      }
      const left = new Set(refused.repos.map((repo) => repo.sourcePath))
      const worktrees = (await store.loadChatWorktrees(chatId)).filter((row) => left.has(row.sourcePath))
      const mergeInto = held.operation === 'merge' ? held.repos.find((repo) => repo.mergeInto !== undefined)?.mergeInto : undefined
      const request = commitHandOverRequest(await this.addressee(handoff, chatId), worktrees, mergeInto, refused.reason, refused.message)
      const { event } = await store.retryWorkCompletion(handoffId, requestEventId, request, confirmRequestOf(worktrees, mergeInto, []), 'pending')
      this.options.broadcast({ type: 'event', chatId, event })
      this.runAttempt(handoffId, chatId, event, held)
      await this.options.broadcastDirectory()
      return true
    })
  }

  /**
   * Once Git shows a confirmed change on its branch: the Session settles, its Notes row
   * is checked, and its merged worktree and Manor branch leave disk. A shared checkout
   * settles without touching a branch. Reconcile calls it for any landed live
   * completion: a turn's end, a poll that saw main move, or a boot after a restart cut
   * the settle short. The settle itself waits
   * in the lifecycle queue and checks again there, and the store writes it only while
   * that attempt is still the live confirmed one, so a message or reopen that arrived
   * meanwhile keeps the Session open.
   */
  private async afterLanded(handoffId: string): Promise<void> {
    const landed = await this.landedRoom(handoffId)
    if (landed === undefined) return
    const settled = await this.settleWhen(landed.chatId, true, async () => (await this.landedRoom(handoffId, landed.attempt)) !== undefined, landed)
    if (!settled) return
    await this.options.projectThreads?.completeSessionStatus(landed.chatId).catch(() => undefined)
    await this.options.releaseWorktrees?.(landed.chatId)
  }

  /**
   * The Session a landed confirmed change may settle, with the attempt that landed it.
   * Nothing qualifies while that attempt still runs, after any later message in the
   * Session, nor once the user took the Session back out of Settled.
   */
  private async landedRoom(handoffId: string, attempt?: string): Promise<LandedAttempt & { chatId: string } | undefined> {
    const { store } = this.options
    const handoff = await this.handoffFor(handoffId)
    const held = handoff.goalCompletion
    const chatId = handoff.workChatId
    if (chatId === null || handoff.goalConfirmedAt === undefined || held?.status !== 'complete' || held.operation === 'none') return undefined
    const landed = attemptOf(held)
    if (landed === undefined || (attempt !== undefined && landed !== attempt)) return undefined
    const room = await store.getChat(chatId)
    if (handoff.state !== 'active' || handoff.unsettledAt !== undefined || room === undefined || room.settledAt !== null || room.archivedAt !== null) return undefined
    const events = await store.loadEvents(chatId)
    const at = events.findIndex((event) => event.id === landed)
    const running = events[at]
    if (at < 0 || (running?.type === 'user_message' && (running.dispatchState === 'pending' || running.dispatchState === 'started'))) return undefined
    // Manor's own merge trouble messages belong to the attempt; anything else is new work.
    if (events.slice(at + 1).some((event) => event.type === 'user_message' && event.mergeTrouble === undefined)) return undefined
    return { chatId, attempt: landed, goalConfirmedAt: handoff.goalConfirmedAt }
  }

  /**
   * While Confirm's request runs, reads Git for each repo's commit and merge, so the card
   * ticks each step in order. It stops once every step shows, the completion is no longer
   * pending, or the turn ends; the end's reconcile has the last word.
   */
  private async watchCommits(handoffId: string, requestEventId: string, answered: Promise<void>): Promise<void> {
    let ended = false
    const end = answered.then(() => { ended = true }, () => { ended = true })
    let lastTips: string | undefined
    try {
      while (true) {
        let timer: NodeJS.Timeout | undefined
        await Promise.race([end, new Promise<void>((resolve) => { timer = setTimeout(resolve, COMMIT_WATCH_MS) })])
        clearTimeout(timer)
        if (ended) return
        const read = await this.handoffFor(handoffId)
        const held = read.goalCompletion
        if (held === undefined || attemptOf(held) !== requestEventId || held.status !== 'pending' || read.workChatId === null) return
        // Git is read outside the lifecycle queue, and only after a branch moved, so a
        // large Session's scan never holds Settle or the end's reconcile behind it.
        const tips = await stepTips(held)
        if (tips === lastTips) continue
        lastTips = tips
        const seen = await repoSteps(held, await this.options.store.loadEvents(read.workChatId))
        const finished = await this.orderLifecycle(handoffId, async () => {
          const current = (await this.handoffFor(handoffId)).goalCompletion
          if (current === undefined || attemptOf(current) !== requestEventId || current.status !== 'pending') return true
          // A step Git showed once stays ticked; a rebase moving the commit is not a step back.
          const committed = [...new Set([...current.committed ?? [], ...seen.committed])]
          const merged = [...new Set([...current.merged ?? [], ...seen.merged])]
          if (committed.length > (current.committed?.length ?? 0) || merged.length > (current.merged?.length ?? 0)) {
            await this.options.store.updateWorkCompletion(handoffId, {
              ...current, committed, ...(merged.length === 0 ? {} : { merged }),
            })
            await this.options.broadcastDirectory()
          }
          return committed.length >= current.repos.length && (current.operation !== 'merge' || merged.length >= current.repos.length)
        })
        if (finished) return
      }
    } catch {
      // A Session deleted mid-turn or a store hiccup only costs the early tick.
    }
  }

  /** Who Confirm's commit request mentions: the lead, or nobody in a Single Session. */
  private async addressee(handoff: WorkHandoff, chatId: string): Promise<string | undefined> {
    if ((await this.options.store.getChat(chatId))?.mode === 'single') return undefined
    return this.options.agents().find((agent) => agent.id === handoff.leadAgentId)?.name ?? handoff.leadAgentName
  }

  /** Also runs after boot and later corrective turns; never queues another commit. */
  async reconcileCompletion(chatId?: string): Promise<void> {
    // Oldest confirmation first, so merges a restart queues again keep their order.
    await this.reconcile(chatId === undefined
      ? [...await this.options.store.listWorkHandoffs()].sort((a, b) => (a.goalConfirmedAt ?? 0) - (b.goalConfirmedAt ?? 0))
      : [await this.options.store.workHandoffForTarget(chatId)])
  }

  /**
   * Reads Git again for every Commit blocked or Merge blocked card, the settled Session's
   * too: settling is no evidence either way, and its card still says what Git shows.
   * Runs after any exchange, panel Commit or chat open, since another Session may have
   * landed the change.
   */
  async recheckBlocked(): Promise<void> {
    await this.reconcile(await this.blocked())
  }

  private async blocked(onlyActive = false): Promise<WorkHandoff[]> {
    return (await this.options.store.listWorkHandoffs()).filter((handoff) =>
      (handoff.goalCompletion?.status === 'blocked' || handoff.goalConfirmations?.some((round) => round.completion?.status === 'blocked')) &&
      (onlyActive ? handoff.state === 'active' : handoff.state !== 'deleted'))
  }

  /**
   * Main also moves outside Manor, a commit from a terminal; while an active Session's
   * card is blocked, Git is read again every 30 seconds. A failed read keeps polling; only
   * a read that finds nothing blocked stops it. A settled Session's card waits for the
   * next exchange, so a change the user dropped for good does not poll forever.
   */
  private async pollWhileBlocked(): Promise<void> {
    if ((await this.blocked(true)).length > 0) this.armPoll()
  }

  private armPoll(): void {
    if (this.blockedPoll !== undefined) return
    this.blockedPoll = setTimeout(() => {
      this.blockedPoll = undefined
      void this.blocked(true).then((active) => this.reconcile(active)).catch(() => this.armPoll())
    }, BLOCKED_POLL_MS)
    this.blockedPoll.unref()
  }

  private async reconcile(handoffs: readonly (WorkHandoff | undefined)[]): Promise<void> {
    const landed: string[] = []
    try {
      for (const handoff of handoffs) {
        if (handoff === undefined || handoff.workChatId === null) continue
        await this.orderLifecycle(handoff.id, async () => {
          const current = await this.handoffFor(handoff.id)
          if (current.workChatId === null) return
          const live = current.goalConfirmedAt === undefined ? undefined : current.goalCompletion
          const completions = [
            ...(live === undefined ? [] : [live]),
            ...(current.goalConfirmations ?? []).flatMap((round) => round.completion === undefined ? [] : [round.completion]),
          ]
          let landedLive = live?.status === 'complete'
          for (const listed of completions) {
            if (listed.status === 'complete') continue
            const events = await this.options.store.loadEvents(current.workChatId)
            const latest = listed === live
            // A reopened result's merge has nobody left to record it: Git alone says whether it landed.
            const held: WorkCompletion = !latest && listed.merge !== undefined && listed.merge.stage !== 'blocked'
              ? { ...listed, merge: undefined } : listed
            // Manor's own merge owns this completion until it lands or stops.
            if (held.merge?.stage === 'blocked' && held.status === 'blocked') {
              // Its reason stands; only Git showing the change landed after all replaces it.
              const { merge: _merge, ...rest } = held
              const seen = await observeWorkCompletion(rest, events)
              const observed = seen.status === 'complete' ? seen : await this.withRetry(held, latest)
              if (JSON.stringify(observed) !== JSON.stringify(listed)) {
                await this.options.store.updateWorkCompletion(current.id, observed)
                await this.options.broadcastDirectory()
              }
              if (latest) landedLive = observed.status === 'complete'
              continue
            }
            if (held.merge !== undefined) {
              if (latest) this.resumeMerge(current.id, held, events)
              continue
            }
            const event = events.find((row) => row.id === attemptOf(held))
            if (event?.type === 'user_message' && event.dispatchState === 'pending') continue
            // Manor's own commit is still running: its end reconciles once it checked the commit.
            if (event?.type === 'user_message' && event.confirmRequest?.manor === true && event.dispatchState === 'started') continue
            const seen = await observeWorkCompletion(held, events)
            // The commit turn is over and Git neither shows the change nor rules it out.
            const finished = !(event?.type === 'user_message' && event.dispatchState === 'started')
            const manor = event?.type === 'user_message' && event.confirmRequest?.manor === true
            const beyond = finished && manor && listed.merge === undefined ? await this.beyondScope(held, seen) : undefined
            if (beyond !== undefined) {
              const stopped = await this.withRetry({ ...held, ...(seen.committed === undefined ? {} : { committed: seen.committed }),
                status: 'blocked', completedAt: undefined, commits: undefined, message: beyond }, latest)
              if (JSON.stringify(stopped) !== JSON.stringify(listed)) {
                await this.options.store.updateWorkCompletion(current.id, stopped)
                await this.options.broadcastDirectory()
              }
              if (latest) landedLive = false
              continue
            }
            // The lead committed every repo of an approved merge: the rest is Manor's.
            if (latest && finished && held.operation === 'merge' && held.status === 'pending' && seen.status !== 'complete' &&
                (seen.committed?.length ?? 0) >= held.repos.length) {
              const queued = { ...held, committed: seen.committed, merge: { stage: 'queued' as const, verified: await committedTips(held) } }
              await this.options.store.updateWorkCompletion(current.id, queued)
              this.enqueueMerge(current.id, queued)
              await this.options.broadcastDirectory()
              continue
            }
            // While the commit turn runs Git can tick steps, never block: the merge comes after it.
            const observed = await this.withRetry(!finished && seen.status === 'blocked'
              ? { ...held, ...(seen.committed === undefined ? {} : { committed: seen.committed }), ...(seen.merged === undefined ? {} : { merged: seen.merged }) }
              : seen.status === 'pending' && finished ? unconfirmedCompletion(seen) : seen, latest)
            if (JSON.stringify(observed) === JSON.stringify(listed)) continue
            await this.options.store.updateWorkCompletion(current.id, observed)
            await this.options.broadcastDirectory()
            if (latest) landedLive = observed.status === 'complete'
          }
          // Also a change that landed before a restart cut its settle short.
          if (landedLive && current.state === 'active') landed.push(current.id)
        })
      }
    } finally {
      await this.pollWhileBlocked().catch(() => this.armPoll())
    }
    for (const handoffId of landed) await this.afterLanded(handoffId).catch(() => undefined)
  }

  /** Only the current round's blocked card offers Retry; it says why not when it cannot. */
  private async withRetry(completion: WorkCompletion, current: boolean): Promise<WorkCompletion> {
    const { retryRefused: _refused, ...rest } = completion
    if (!current || completion.status !== 'blocked') return rest
    const refused = await retryRefusal(completion)
    return refused === undefined ? rest : { ...rest, retryRefused: refused }
  }

  /** A merge whose stage the store holds, picked up again after its turn or a restart. */
  private resumeMerge(handoffId: string, held: WorkCompletion, events: readonly ThreadEvent[]): void {
    const merge = held.merge
    if (merge === undefined || merge.stage === 'approve' || this.lanes.has(handoffId)) return
    if (merge.stage === 'fixing') {
      // The lead's turn on the failure still runs; its end reconciles again.
      const event = events.find((row) => row.id === merge.trouble?.eventId)
      if (event?.type === 'user_message' && (event.dispatchState === 'pending' || event.dispatchState === 'started')) return
    }
    this.enqueueMerge(handoffId, held)
  }

  private enqueueMerge(handoffId: string, held: WorkCompletion): void {
    this.lanes.add(handoffId, mergeFolders(held))
  }

  /** Writes each waiting merge's place, "after" the Session directly ahead of it, for its card. */
  private async publishQueue(): Promise<void> {
    const places = this.lanes.positions()
    let changed = false
    for (const [id, place] of places) {
      const after = (await this.handoffFor(place.after).catch(() => undefined))?.title.slice(0, 300)
      changed = await this.updateMerge(id, (merge) => merge.stage === 'merging' || merge.stage === 'approve' ? merge
        : { ...withoutQueue(merge), stage: 'queued', ahead: place.ahead, ...(after === undefined ? {} : { after }) }) || changed
    }
    if (changed) await this.options.broadcastDirectory().catch(() => undefined)
  }

  /** Rewrites the current merge stage when the completion is still Manor's; true when it changed. */
  private async updateMerge(handoffId: string, next: (merge: WorkMerge) => WorkMerge): Promise<boolean> {
    return this.orderLifecycle(handoffId, async () => {
      const held = (await this.handoffFor(handoffId).catch(() => undefined))?.goalCompletion
      if (held?.merge === undefined || held.status !== 'pending') return false
      const merge = next(held.merge)
      if (JSON.stringify(merge) === JSON.stringify(held.merge)) return false
      await this.options.store.updateWorkCompletion(handoffId, { ...held, merge })
      return true
    })
  }

  /**
   * One merge of a confirmed Session, run by the lanes. Git work happens outside the
   * lifecycle queue, so Settle never waits on a hook; the outcome is written only while
   * the same confirmation is current. A new message from the user reopens the result, and
   * then this merge has nothing left to write.
   */
  private async runMerge(handoffId: string): Promise<void> {
    let start: WorkCompletion | undefined
    if (await this.updateMerge(handoffId, (merge) => merge.stage === 'approve' ? merge : { ...withoutQueue(merge), stage: 'merging' }) ||
        (await this.handoffFor(handoffId)).goalCompletion?.merge?.stage === 'merging') {
      start = (await this.handoffFor(handoffId)).goalCompletion
      await this.options.broadcastDirectory().catch(() => undefined)
    }
    if (start?.merge === undefined) return
    let outcome: MergeOutcome
    try {
      outcome = await mergeSession(start, start.merge)
    } catch (error) {
      outcome = { kind: 'blocked', message: `Manor could not merge: ${error instanceof Error ? error.message : String(error)}` }
    }
    // The lead's turn is queued inside the lifecycle order, so a Settle after the trouble
    // message was stored halts that turn instead of being undone by it.
    const request = await this.orderLifecycle(handoffId, async () => {
      const request = await this.recordMerge(handoffId, start, outcome)
      if (request !== undefined) {
        this.options.broadcast({ type: 'event', chatId: request.chatId, event: request.event })
        const ended = () => this.reconcileCompletion(request.chatId)
        void this.options.orchestrator.runStoredUserMessage(request.chatId, request.event).then(ended, ended).catch(() => undefined)
      }
      return request
    })
    await this.options.broadcastDirectory().catch(() => undefined)
    if (request === undefined) {
      // Reopened meanwhile: the earlier round reads Git now that this merge is over.
      const chatId = (await this.handoffFor(handoffId).catch(() => undefined))?.workChatId
      if (chatId !== undefined && chatId !== null) await this.reconcileCompletion(chatId).catch(() => undefined)
      else await this.pollWhileBlocked().catch(() => this.armPoll())
    }
  }

  /** Stores what a merge ended in; a failure for the lead comes back as the message to run. */
  private async recordMerge(handoffId: string, start: WorkCompletion, ended: MergeOutcome) {
    const { store } = this.options
    const handoff = await this.handoffFor(handoffId)
    // Settle stops the lead's turns; a merge that ran into trouble meanwhile stops here too.
    // The repair budget caps Manor's own messages per confirmation, whatever the lead amends.
    const repairs = handoff.goalCompletion?.merge?.repairs ?? 0
    const outcome: MergeOutcome = ended.kind !== 'trouble' ? ended
      : handoff.state !== 'active' ? { kind: 'blocked', message: `${ended.trouble.text.split('\n')[0]} The Session is settled, so Manor did not ask the lead to fix it.` }
        : repairs >= MERGE_REPAIRS_MAX ? { kind: 'blocked', message: `${ended.trouble.text.split('\n')[0]} The lead had ${repairs} tries at this merge, so Manor stops here.` }
          : ended
    const held = handoff.goalCompletion
    const chatId = handoff.workChatId
    if (chatId === null) return undefined
    if (held?.merge === undefined || held.requestEventId !== start.requestEventId || held.status !== 'pending') {
      // Reopened meanwhile: the earlier round keeps only a landing, proven by the tips Manor merged.
      const round = handoff.goalConfirmations?.find((row) => row.completion?.requestEventId === start.requestEventId)?.completion
      if (outcome.kind === 'merged' && round !== undefined && round.status !== 'complete') {
        const { merge: _merge, ...rest } = round
        await store.updateWorkCompletion(handoffId, { ...rest, status: 'complete', completedAt: Date.now(), message: undefined, commits: outcome.landed,
          committed: rest.repos.map((repo) => repo.path), merged: rest.repos.map((repo) => repo.path) })
      }
      return undefined
    }
    const { merge, ...rest } = held
    const { approved, conflicts } = merge
    const kept = { ...(approved === undefined ? {} : { approved }), ...(conflicts === undefined ? {} : { conflicts }), ...(merge.repairs === undefined ? {} : { repairs: merge.repairs }) }
    if (outcome.kind === 'merged' || outcome.kind === 'blocked') {
      const seen = await observeWorkCompletion(rest, await store.loadEvents(chatId))
      // Manor fast-forwarded exactly the tips it checked were the approved commits, so those
      // tips prove the landing, even where a conflict fix the user approved rewrote lines.
      const landed = outcome.kind === 'merged' && seen.status !== 'complete' ? outcome.landed : undefined
      const done = seen.status === 'complete' ? seen
        : landed !== undefined ? { ...seen, status: 'complete' as const, completedAt: Date.now(), message: undefined, commits: landed,
          committed: rest.repos.map((repo) => repo.path), merged: rest.repos.map((repo) => repo.path) }
          : outcome.kind === 'blocked' ? { ...seen, status: 'blocked' as const, completedAt: undefined, commits: undefined, message: outcome.message,
            merge: { ...withoutQueue(merge), stage: 'blocked' as const, ...(outcome.kind === 'blocked' && outcome.verified !== undefined ? { verified: outcome.verified } : {}) } }
            : unconfirmedCompletion(seen)
      await store.updateWorkCompletion(handoffId, done)
      return undefined
    }
    if (outcome.kind === 'approve') {
      await store.updateWorkCompletion(handoffId, { ...held, merge: {
        stage: 'approve', ...kept, verified: outcome.verified, fix: outcome.fix, ...(merge.trouble === undefined ? {} : { trouble: merge.trouble }),
      } })
      return undefined
    }
    const repo = held.repos.find((row) => row.path === outcome.trouble.repo)
    const single = (await store.getChat(chatId))?.mode === 'single'
    const event = await store.appendEvent(chatId, {
      type: 'user_message',
      text: '',
      instruction: mergeTroubleRequest(await this.addressee(handoff, chatId), outcome.trouble, repo?.branch ?? 'the branch', repo?.mergeInto ?? 'the target'),
      mentions: single ? [] : [handoff.leadAgentId],
      dispatchState: 'pending',
      mergeTrouble: { handoffId, kind: outcome.trouble.kind },
    })
    if (event.type !== 'user_message') return undefined
    const { trouble } = outcome
    // The first conflict stays the baseline; a later one only marks that more followed.
    const first = conflicts?.[trouble.repo]
    const conflict = trouble.kind !== 'conflict' || trouble.base === undefined ? undefined
      : first === undefined ? { base: trouble.base, tip: trouble.tip } : { ...first, again: true }
    await store.updateWorkCompletion(handoffId, { ...held, merge: {
      stage: 'fixing', ...kept, repairs: repairs + 1, verified: outcome.verified, trouble: { ...trouble, eventId: event.id },
      ...(conflict === undefined ? {} : { conflicts: { ...conflicts, [trouble.repo]: conflict } }),
    } })
    return { chatId, event }
  }

  /** The user approves the lead's conflict fix they saw on the card; Manor merges it next. */
  async approveMergeFix(handoffId: string, tip: string): Promise<void> {
    const queued = await this.orderLifecycle(handoffId, async () => {
      const held = (await this.handoffFor(handoffId)).goalCompletion
      const fix = held?.merge?.fix
      if (held?.merge?.stage !== 'approve' || fix === undefined || fix.tip !== tip || held.status !== 'pending') {
        throw new Error('This conflict fix changed. Read the current card before approving it.')
      }
      const { fix: _fix, ...merge } = held.merge
      const next = { ...held, merge: { ...merge, stage: 'queued' as const, approved: { ...merge.approved, [fix.repo]: fix.tip } } }
      await this.options.store.updateWorkCompletion(handoffId, next)
      return next
    })
    this.enqueueMerge(handoffId, queued)
    await this.options.broadcastDirectory()
  }

  async reviseGoal(handoffId: string, version: number, text: string, images: ImageAttachment[] = []): Promise<void> {
    await this.orderLifecycle(handoffId, async () => {
      const held = await this.handoffFor(handoffId)
      const room = held.workChatId === null ? undefined : await this.options.store.getChat(held.workChatId)
      // A Single Session answers with its own voice, whoever the handoff named as lead.
      if (room?.mode !== 'single' && !this.options.agents().some((agent) => agent.id === held.leadAgentId && room !== undefined && agentFitsChat(agent, room))) {
        throw new Error('The Session lead is no longer available.')
      }
      const { handoff, event, sourceEvents } = await this.options.store.reviseWorkGoal(handoffId, version, text, images)
      for (const sourceEvent of sourceEvents) {
        this.options.broadcast({ type: 'event', chatId: handoff.sourceChatId, event: sourceEvent })
      }
      void this.options.orchestrator.runStoredUserMessage(handoff.workChatId!, event).catch(() => undefined)
      await this.options.broadcastDirectory()
    })
  }

  /** A stale client acted on a replaced proposal: send it the current directory, then refuse. */
  private async refuseSuperseded(): Promise<never> {
    await this.options.broadcastDirectory().catch(() => undefined)
    throw new Error(SUPERSEDED_PROPOSAL)
  }

  /** Holds several lifecycles at once, always in the order given. */
  private orderLifecycles<T>(ids: readonly string[], operation: () => Promise<T>): Promise<T> {
    const [first, ...rest] = ids
    return first === undefined ? operation() : this.orderLifecycle(first, () => this.orderLifecycles(rest, operation))
  }

  private async orderLifecycle<T>(chatId: string, operation: () => Promise<T>): Promise<T> {
    const ahead = this.lifecycleTails.get(chatId) ?? Promise.resolve()
    const run = ahead.then(operation)
    const finished = run.then(() => undefined, () => undefined)
    this.lifecycleTails.set(chatId, finished)
    try {
      return await run
    } finally {
      if (this.lifecycleTails.get(chatId) === finished) {
        this.lifecycleTails.delete(chatId)
        this.lifecycleVersions.delete(chatId)
      }
    }
  }

  async setSettled(chatId: string, settled: boolean): Promise<void> {
    await this.settleWhen(chatId, settled)
  }

  /**
   * Settles (or unsettles) once its turn in the lifecycle queue comes and `when`, read
   * there, still holds; `landed` makes the store check the confirmed attempt in the same
   * write. True when the chat ends in the requested state.
   */
  private async settleWhen(chatId: string, settled: boolean, when?: () => Promise<boolean>, landed?: LandedAttempt): Promise<boolean> {
    const intent = { settled }
    this.lifecycleIntents.set(chatId, intent)
    try {
      return await this.requestSettled(chatId, settled, when, landed)
    } finally {
      if (this.lifecycleIntents.get(chatId) === intent) this.lifecycleIntents.delete(chatId)
    }
  }

  private async requestSettled(chatId: string, settled: boolean, when?: () => Promise<boolean>, landed?: LandedAttempt): Promise<boolean> {
    const key = (await this.options.store.workHandoffForTarget(chatId))?.id ?? chatId
    const version = (this.lifecycleVersions.get(key) ?? 0) + 1
    this.lifecycleVersions.set(key, version)
    return this.orderLifecycle(key, async () => {
      if (when !== undefined && !(await when())) return false
      try {
        await this.transitionSettled(chatId, settled, version, false, landed)
        // A newer request that superseded this one decides; report what the row now is.
        const room = await this.options.store.getChat(chatId)
        return room !== undefined && (room.settledAt !== null) === settled
      } catch (error) {
        // Persistence may fail before commit, or delivery after it. Reconcile the
        // halt with the durable state so either failure leaves the chat usable.
        const room = await this.options.store.getChat(chatId).catch(() => undefined)
        if (room !== undefined) {
          if (room.settledAt === null) this.options.orchestrator.resumeChat(chatId)
          else this.options.orchestrator.stopChat(chatId)
        }
        throw error
      }
    })
  }

  private async transitionSettled(chatId: string, settled: boolean, requestVersion: number, rejected = false, landed?: LandedAttempt): Promise<void> {
    const { store, orchestrator } = this.options
    const before = await store.getChat(chatId)
    if (before === undefined) throw new Error(`unknown chat ${chatId}`)
    const handoff = await store.workHandoffForTarget(chatId)
    if (handoff === undefined) {
      if (settled) orchestrator.stopChat(chatId)
      else orchestrator.resumeChat(chatId)
      await store.setChatSettled(chatId, settled)
      await this.options.broadcastDirectory()
      return
    }
    // A newer Settle or Unsettle is already queued behind this one and decides. Writing
    // this one first would broadcast a state the row has already left.
    const superseded = () => (this.lifecycleVersions.get(handoff.id) ?? 0) !== requestVersion
    if (superseded()) return

    if (!settled) {
      orchestrator.resumeChat(chatId)
      const saved = await store.transitionWorkLifecycle(chatId, handoff.id, { state: 'active', result: null, resultAt: null }, {
        type: 'system_note',
        kind: 'info',
        text: `Session “${handoff.title}” was reopened; the previous outcome was withdrawn.`,
        workHandoffId: handoff.id,
        workHandoffPhase: 'reopened',
      })
      if (saved.version !== handoff.version) await this.broadcastReceipt(saved)
      await this.options.broadcastDirectory()
      return
    }
    // A Session stops only after its settle is stored: stopping broadcasts the
    // directory, and one read before the write would move the row back.
    if (handoff.state === 'settled') {
      await store.transitionWorkLifecycle(chatId, handoff.id, {
        state: 'settled', result: handoff.result, resultAt: handoff.resultAt,
      }, {
        type: 'system_note',
        kind: 'info',
        text: `Session “${handoff.title}” settled.`,
        workHandoffId: handoff.id,
        workHandoffPhase: 'settled',
      })
      orchestrator.stopChat(chatId)
      await this.options.broadcastDirectory()
      return
    }

    const known = rejected
      ? 'Rejected.'
      : handoff.acceptedAt === null && !(await store.loadEvents(chatId)).some((event) => 'turnId' in event && event.turnId !== undefined)
        ? 'Rejected before work started.'
        : handoff.goalReport?.result
    if (superseded()) return
    const writing = known === undefined && handoff.workChatId !== null && this.options.generateOutcome !== undefined
    const outcome = known?.trim() || null
    const saved = await store.transitionWorkLifecycle(chatId, handoff.id, {
      state: 'settled',
      result: outcome,
      resultAt: Date.now(),
    }, {
      type: 'system_note',
      kind: 'info',
      text: writing ? `Session “${handoff.title}” settled.` : settledText(handoff.title, outcome),
      workHandoffId: handoff.id,
      workHandoffPhase: 'settled',
    }, landed)
    // New work withdrew the landed attempt after the queue's check; the Session stays open.
    if (saved.state !== 'settled') return
    orchestrator.stopChat(chatId)
    await this.broadcastReceipt(saved)
    await this.options.broadcastDirectory()
    if (writing) void this.fillOutcome(saved)
    // Closing the Session is no evidence either way: Git says whether the confirmed
    // changes are on their branch, and a check Git cannot answer claims nothing.
    const held = handoff.goalConfirmedAt === undefined ? undefined : handoff.goalCompletion
    if (held !== undefined && held.status !== 'complete' && held.merge === undefined) {
      const observed = await observeWorkCompletion(held, await store.loadEvents(chatId))
      if (JSON.stringify(observed) !== JSON.stringify(held)) {
        await store.updateWorkCompletion(handoff.id, observed)
        await this.options.broadcastDirectory()
      }
    }
  }

  /**
   * Writes the outcome of a settle that went out without one, after the row already
   * moved. An Unsettle still pending drops it here; one that committed, or a second
   * settle, makes the store refuse it.
   */
  private async fillOutcome(settled: WorkHandoff): Promise<void> {
    try {
      let result: string | null
      try {
        result = (await this.outcome(settled))?.trim() || null
      } catch {
        result = null
      }
      // Published in the lifecycle queue, so its directory can never land after a
      // reopen that started later and replace the reopened row with a settled one.
      await this.orderLifecycle(settled.id, async () => {
        if (settled.workChatId === null || this.lifecycleIntents.get(settled.workChatId)?.settled === false) return
        const saved = await this.options.store.recordWorkOutcome(settled.id, settled.version, result, settledText(settled.title, result))
        if (saved === undefined) return
        await this.broadcastReceipt(saved)
        await this.options.broadcastDirectory()
      })
    } catch (error) {
      console.warn(`[manor] Session outcome for ${settled.id} not delivered: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async outcome(handoff: WorkHandoff): Promise<string | undefined> {
    if (handoff.workChatId === null || this.options.generateOutcome === undefined) return undefined
    const [held, loaded] = await Promise.all([
      this.options.store.getChatSummary(handoff.workChatId),
      this.options.store.loadEvents(handoff.workChatId),
    ])
    const summary = summaryInContext(held, loaded)
    const events = contextEvents(loaded)
    const through = summary === undefined ? -1 : events.findIndex((event) => event.id === summary.throughEventId)
    const tail: readonly ThreadEvent[] = events.slice(through + 1)
    // Priced uncapped, because `renderCatchUpEvents` below caps nothing: pricing this
    // tail as the catch-up would hands the outcome writer many times its own budget.
    const cut = catchUpCut({ events: tail, agents: this.options.agents() }, MAX_CATCH_UP_CHARS, 'none')
    const context = [summary?.summary ?? '', renderCatchUpEvents(tail.slice(cut.from), this.options.agents())]
      .filter((part) => part.trim().length > 0)
      .join('\n\n')
    return this.options.generateOutcome({ chatId: handoff.workChatId, title: handoff.title, context })
  }

  private validateExecutor(agentId: string, authorId?: string): void {
    const executor = this.options.agents().find((agent) => agent.id === agentId)
    if (executor === undefined) throw new Error('The first executor no longer exists. Create a new session proposal.')
    if (executor.placement === 'chat') throw new Error(`${executor.name} stays in chat. Create a proposal led by a Session persona.`)
    // A project thread has no allowlist: it may name any Session persona.
    if (authorId !== undefined && authorId !== agentId && authorId !== SINGLE_CHAT_VOICE.id) {
      // A chat author can never execute its own handoff, so naming a Session lead is
      // its only way into Work and needs no allowlist of its own; the starting team
      // is still checked against that lead's allowlist.
      const author = this.options.agents().find((agent) => agent.id === authorId)
      if (author === undefined || (author.placement !== 'chat' && !(author.mentionAllowlist ?? []).includes(agentId))) {
        throw new Error(`${author?.name ?? 'The handoff author'} cannot assign ${executor.name} as first executor. Update the mention allowlist or create a new session proposal.`)
      }
    }
  }

  private resolveProject(reference: string, projects: readonly Project[]): Project {
    const byId = projects.find((project) => project.id === reference)
    if (byId !== undefined) return byId
    const matches = projects.filter((project) => project.name === reference)
    if (matches.length === 1 && matches[0] !== undefined) return matches[0]
    if (matches.length > 1) throw new Error(`Project name ${JSON.stringify(reference)} is ambiguous; use its stable id.`)
    throw new Error(`No project matches ${JSON.stringify(reference)}.`)
  }

  private resolveAgent(reference: string): AgentConfig {
    const roster = this.options.agents()
    const byId = roster.find((agent) => agent.id === reference)
    if (byId !== undefined) return byId
    const matches = roster.filter((agent) => agent.name === reference)
    if (matches.length === 1 && matches[0] !== undefined) return matches[0]
    if (matches.length > 1) throw new Error(`Persona name ${JSON.stringify(reference)} is ambiguous; use the stable id.`)
    throw new Error(`No persona matches ${JSON.stringify(reference)}.`)
  }

  private toolResult(handoff: WorkHandoff, reused: boolean, supersededHandoffId?: string) {
    return {
      workHandoffId: handoff.id,
      assignmentKey: handoff.assignmentKey,
      // The proposal's number; above 1 it replaced the pending proposal named below,
      // which the user no longer sees as a decision.
      version: handoff.revision ?? 1,
      ...(supersededHandoffId === undefined ? {} : { supersededHandoffId }),
      workChatId: handoff.workChatId,
      title: handoff.title,
      project: handoff.projectName,
      // A card nobody leads runs as Single only; the thread reads null, never an empty name.
      lead: workHandoffHasLead(handoff) ? handoff.leadAgentName : null,
      firstExecutor: handoff.firstExecutor ?? (workHandoffHasLead(handoff) ? { agentId: handoff.leadAgentId, agentName: handoff.leadAgentName } : null),
      startingTeam: handoff.supportingAgentNames,
      ...(handoff.proposedRuntime === undefined ? {} : { proposedRuntime: handoff.proposedRuntime }),
      ...(handoff.attachments === undefined ? {} : { attachments: handoff.attachments.map((attachment) => attachment.name) }),
      reused,
    }
  }

  private async broadcastReceipt(handoff: WorkHandoff): Promise<void> {
    const event = [...await this.options.store.loadEvents(handoff.sourceChatId)].reverse().find(
      (candidate) =>
        candidate.type === 'system_note' &&
        candidate.workHandoffId === handoff.id &&
        candidate.workHandoffVersion === handoff.version,
    )
    if (event !== undefined) this.options.broadcast({ type: 'event', chatId: handoff.sourceChatId, event })
  }
}
