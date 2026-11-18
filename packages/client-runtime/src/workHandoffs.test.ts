import type { AgentConfig, Chat, Project, ServerMessage, ThreadEvent, WorkHandoff } from '@manor/contracts'
import { ClientMessageSchema } from '@manor/contracts'
import { describe, expect, it } from 'vitest'
import { evidenceVisibleCount, firstSentence, goalReportEventId, messageBrief, rowsOf, threadWorkCard, workByline, openWorkDecisions, projectWorkHandoffs, sessionReadyRow, workCardInView, workCardLine, workBlockedReason, workCardStatus, workConfirmTitle, pickWorkChoice, workChangesAsked, workChoicePicked, workResultActionLabels, workResultChoiceList, workResultFiles, workResultLines, type Row, type WorkHandoffRow } from './transcriptState'
import { emptyThread } from './threadState'
import { acceptWorkProposal, updateWorkProposal, workProposalDraft, workProposalOptions, workProposalSingleOnly } from './workProposals'
import { createWorkspaceCommands } from './commands'
import { emptyWorkspace, reduce } from './workspaceState'

const project: Project = {
  id: 'project_1', name: 'Manor', icon: 'home', color: '#8A8F98', repoPaths: [], memoryScope: 'project',
}
const lead: AgentConfig = {
  id: 'sage', name: 'Sage', color: '#6FA8A0', driver: 'mock', effort: 'high',
  allowedTools: [], mcpServers: [], memoryScope: false, role: '', description: '',
  isCos: false, character: '',
}
const support: AgentConfig = { ...lead, id: 'smith', name: 'Smith' }
const target: Chat = {
  id: 'work_1', projectId: project.id, kind: 'project', routineId: null, parentChatId: null,
  sideModel: null, sideEffort: null, memberIds: [], agentIds: [], title: 'Ship handoffs',
  createdAt: 1, lastMessageAt: 1, lastMessagePreview: null, settledAt: null, archivedAt: null,
  checkout: { mode: 'current', branch: null },
}
const handoff: WorkHandoff = {
  id: 'handoff_1', sourceChatId: 'dm_1', sourceTurnId: 'turn_1', workChatId: target.id,
  projectId: project.id, projectName: project.name, title: target.title,
  leadAgentId: lead.id, leadAgentName: lead.name,
  supportingAgentIds: [support.id], supportingAgentNames: [support.name],
  acceptedAt: null, state: 'active', result: null, resultAt: null, version: 1, createdAt: 1,
}
const rows: Row[] = [
  {
    kind: 'event', key: 'created', event: {
      id: 'event_1', ts: 1, type: 'system_note', kind: 'info', text: 'Work started.',
      workHandoffId: handoff.id, workHandoffVersion: 1, workHandoffPhase: 'created',
    },
  },
  {
    kind: 'event', key: 'settled', event: {
      id: 'event_2', ts: 2, type: 'system_note', kind: 'info', text: 'Work settled.',
      workHandoffId: handoff.id, workHandoffVersion: 2, workHandoffPhase: 'settled',
    },
  },
]

describe('the shared Work handoff projection', () => {
  it('leaves the note where the lead marked it ready out of the Session, with or without its handoff', () => {
    const note = (id: string, workGoalHandoffId?: string): Row => ({
      kind: 'event', key: id, event: {
        id, ts: 3, type: 'system_note', kind: 'info', agentId: lead.id, text: 'Sage marked the goal reached.',
        ...(workGoalHandoffId === undefined ? {} : { workGoalHandoffId }),
      },
    })
    const reached = { ...handoff, acceptedAt: 1, goalReachedAt: 3 }
    expect(projectWorkHandoffs([note('older'), note('goal', handoff.id)], [reached], [target], [project], [lead]).map((row) => row.key)).toEqual(['older'])
    expect(projectWorkHandoffs([note('goal', handoff.id)], [], [target], [project], [lead])).toEqual([])
    // Confirm goes out as before; the click changes nothing locally.
    const wire: unknown[] = []
    const commands = createWorkspaceCommands((message) => wire.push(message) > 0, () => { throw new Error('no optimistic change') })
    commands.confirmWorkGoal(handoff.id, 'main', 3)
    commands.reviseWorkGoal(handoff.id, 3, 'Use the chat title.')
    const pasted = { name: 'pasted-image.jpg', dataUrl: 'data:image/jpeg;base64,/9j/4AAQ' }
    commands.reviseWorkGoal(handoff.id, 3, 'Like this.', 'req-1', [pasted])
    expect(wire).toEqual([
      { type: 'confirm_work_goal', handoffId: handoff.id, mergeInto: 'main', version: 3 },
      { type: 'revise_work_goal', handoffId: handoff.id, version: 3, text: 'Use the chat title.' },
      { type: 'revise_work_goal', handoffId: handoff.id, version: 3, text: 'Like this.', images: [pasted], requestId: 'req-1' },
    ])
    expect(ClientMessageSchema.safeParse(wire[2]).success).toBe(true)
  })

  it('gives a Session its own Ready row while its result waits, with the merge branch the linked folders agree on', () => {
    const reported = { ...handoff, acceptedAt: 1, goalReachedAt: 3, version: 3, goalReport: { result: 'Done.' } }
    type Status = Extract<ServerMessage, { type: 'checkout_status' }>
    const worktree = { ...target, checkout: { mode: 'worktree' as const, branch: 'manor/goal' } }
    const status = (homeBranch?: string): Record<string, Status> => ({
      [target.id]: {
        type: 'checkout_status', chatId: target.id, mode: 'worktree', branch: 'manor/goal', dirty: false, gitRoots: ['/a'],
        branches: [], ...(homeBranch === undefined ? {} : { homeBranch }),
      },
    })
    expect(sessionReadyRow(worktree, [reported], [worktree], [project], [lead], status('main'))?.report).toMatchObject({ decision: 'open', version: 3, mergeInto: 'main' })
    expect(sessionReadyRow(worktree, [reported], [worktree], [project], [lead], status())?.report?.mergeInto).toBeUndefined()
    expect(sessionReadyRow(worktree, [{ ...reported, goalConfirmedAt: 4 }], [worktree], [project], [lead])).toBeUndefined()
    expect(sessionReadyRow(worktree, [{ ...handoff, acceptedAt: 1 }], [worktree], [project], [lead])).toBeUndefined()
    expect(sessionReadyRow({ ...worktree, settledAt: 5 }, [reported], [{ ...worktree, settledAt: 5 }], [project], [lead])).toBeUndefined()
    const reduced = reduce(reduce(emptyWorkspace, status('main')[target.id]!), status('develop')[target.id]!)
    expect(sessionReadyRow(worktree, [reported], [worktree], [project], [lead], reduced.checkoutStatus)?.report?.mergeInto).toBe('develop')
  })

  it('shows the assigned executor independently of the lead, including renames and deletion', () => {
    const assigned = { ...handoff, firstExecutor: { agentId: support.id, agentName: support.name } }
    const projectRow = (agents: AgentConfig[], record = assigned) =>
      projectWorkHandoffs(rows, [record], [target], [project], agents)[0]
    expect(projectRow([lead, { ...support, name: 'Smith Prime' }])).toMatchObject({
      leadAgentName: 'Sage', firstExecutorName: 'Smith Prime',
    })
    expect(projectRow([lead])).toMatchObject({ firstExecutorName: 'Smith' })
    expect(projectWorkHandoffs(rows, [handoff], [target], [project], [lead])[0])
      .toMatchObject({ firstExecutorName: 'Sage' })
  })

  it('shows a kickoff or thread brief as its task alone, whether stored with an instruction or before it existed', () => {
    const task = '## Problem\nThe kickoff is a wall.\n\n[Manor] stays when it is not the opening.'
    const opening = '[Manor] Session accepted as Single with claude-opus-5-5. Complete the task below in this session.\n\n'
    const kickoff = { type: 'user_message' as const, id: 'evt_1', ts: 1, mentions: [], source: 'work_handoff' as const }
    expect(messageBrief({ ...kickoff, text: task, instruction: opening })).toBe(task)
    expect(messageBrief({ ...kickoff, text: `${opening}${task}` })).toBe(task)
    const brief = { ...kickoff, source: 'project_thread' as const, threadReason: 'brief' as const }
    expect(messageBrief({ ...brief, text: task, instruction: '[Manor] Smith handed this brief over.\nTask:\n' })).toBe(task)
    expect(messageBrief({ ...brief, text: `[Manor] Smith handed this brief over.\nTitle: Card\nTask:\n${task}` })).toBe(task)
  })

  it('carries the model of an accepted Single session for its card', () => {
    const single = { ...target, mode: 'single' as const, singleDriver: 'claude' as const, singleOverride: { driver: 'claude' as const, model: 'claude-opus-5-5' } }
    expect(projectWorkHandoffs(rows, [{ ...handoff, acceptedAt: 1 }], [single], [project], [lead])[0])
      .toMatchObject({ mode: 'single', singleDriver: 'claude', singleModel: 'claude-opus-5-5' })
  })

  it('offers isolation only after checkout_status confirms Git roots for that Work', () => {
    const withFolders = { ...project, repoPaths: ['/repo'] }
    const status = { type: 'checkout_status' as const, chatId: target.id, mode: 'current' as const,
      branch: null, dirty: false, branches: [], gitRoots: ['/repo'] }
    const projectRows = (statuses: Parameters<typeof projectWorkHandoffs>[5], folders = withFolders) =>
      projectWorkHandoffs(rows, [handoff], [target], [folders], [lead], statuses)[0]
    expect(projectRows({})).toMatchObject({ worktreeAvailable: false })
    expect(projectRows({ unrelated: status })).toMatchObject({ worktreeAvailable: false })
    expect(projectRows({ [target.id]: { ...status, gitRoots: [] } })).toMatchObject({ worktreeAvailable: false })
    expect(projectRows({ [target.id]: status })).toMatchObject({ worktreeAvailable: true })
    expect(projectRows({ [target.id]: status }, project)).toMatchObject({ worktreeAvailable: false })
    expect(projectRows({ [target.id]: status }, { ...project, repoPaths: ['/replacement'] }))
      .toMatchObject({ worktreeAvailable: false })
  })

  it('keeps threadless proposals actionable after reload and uses their project Git status', () => {
    const pending = { ...handoff, workChatId: null }
    const folders = { ...project, repoPaths: ['/repo'] }
    const status = { type: 'checkout_status' as const, projectId: project.id, mode: 'current' as const,
      branch: null, dirty: false, branches: [], gitRoots: ['/repo'] }
    expect(projectWorkHandoffs(rows, [pending], [], [folders], [lead], { [project.id]: status })[0])
      .toMatchObject({ handoffId: handoff.id, projectId: project.id, workChatId: null, status: 'Working', acceptedAt: null, worktreeAvailable: true })
    expect(projectWorkHandoffs(rows, [{ ...pending, state: 'settled' }], [], [project], [lead])[0])
      .toMatchObject({ workChatId: null, status: 'Settled' })
  })

  it('keeps the confirmed checkout branch in the card after reload', () => {
    const projected = projectWorkHandoffs(rows, [{ ...handoff, acceptedAt: 12 }],
      [{ ...target, mode: 'single', singleDriver: 'grok', checkout: { mode: 'worktree', branch: 'manor/work-1' } }], [project], [lead])
    expect(projected[0]).toMatchObject({ acceptedAt: 12, mode: 'single', singleDriver: 'grok', worktreeBranch: 'manor/work-1' })
  })

  it('anchors one card at creation and follows live renames, archive and outcome state', () => {
    const projected = projectWorkHandoffs(
      rows,
      [{ ...handoff, state: 'settled', result: 'The feature shipped.', version: 2 }],
      [{ ...target, title: 'Ship Chat handoffs', archivedAt: 10, mode: 'single' }],
      [{ ...project, name: 'Manor Desktop' }],
      [{ ...lead, name: 'Sage Prime' }, support],
    )

    expect(projected).toEqual([expect.objectContaining({
      kind: 'work_handoff',
      key: 'work:handoff_1',
      title: 'Ship Chat handoffs',
      projectName: 'Manor Desktop',
      leadAgentName: 'Sage Prime',
      supportingAgentNames: ['Smith'],
      status: 'Archived',
      result: 'The feature shipped.',
      mode: 'single',
    })])
  })

  it('survives reload and target deletion from snapshot fallback data', () => {
    const projected = projectWorkHandoffs(
      rows,
      [{ ...handoff, workChatId: null, state: 'deleted' }],
      [],
      [],
      [],
    )

    expect(projected).toEqual([expect.objectContaining({
      kind: 'work_handoff',
      workChatId: null,
      title: 'Ship handoffs',
      projectName: 'Manor',
      leadAgentName: 'Sage',
      supportingAgentNames: ['Smith'],
      status: 'Deleted',
    })])
  })

  it('leaves exactly one element per assignment, its card at the newest note, through Ready, Working and Committed', () => {
    const created = rows[0]!
    const receipt = (id: string, version: number): Row => ({
      kind: 'event', key: id, event: {
        id, ts: version, type: 'system_note', kind: 'info', text: 'Export works.\nNo empty-chat test.',
        workHandoffId: handoff.id, workHandoffVersion: version,
      },
    })
    const reopenedAt = (id: string, version: number, changed = false): Row => ({
      kind: 'event', key: id, event: {
        id, ts: 5, type: 'system_note', kind: 'info', text: 'Changes requested for “Ship handoffs”.',
        workHandoffId: handoff.id, workHandoffVersion: version, workHandoffPhase: 'reopened',
        ...(changed ? { workChangedAfterReady: true as const } : {}),
      },
    })
    const settledAt = (id: string, version: number): Row => ({
      kind: 'event', key: id, event: {
        id, ts: 7, type: 'system_note', kind: 'info', text: 'Session “Ship handoffs” settled: Export works.',
        workHandoffId: handoff.id, workHandoffVersion: version, workHandoffPhase: 'settled',
      },
    })
    const chatter: Row = { kind: 'event', key: 'chatter', event: { id: 'chatter', ts: 3, type: 'user_message', text: 'Make the title bold.', mentions: [] } }
    const completion = { status: 'ready' as const, operation: 'commit' as const, repos: [{ path: '/repo', branch: 'main', before: 'a', tree: 'b', files: ['src/a.ts', 'docs/b.md'] }] }
    const reported = {
      ...handoff, acceptedAt: 1, goalReachedAt: 4, version: 4, goalChangedFiles: ['/repo/src/a.ts', '/repo/docs/b.md'],
      goalReport: { result: 'Export works with the chat title. It also names the file.', limitations: 'No empty-chat test.' }, goalCompletion: completion,
    }
    const project_ = (record: WorkHandoff, transcript: Row[], running = false) => projectWorkHandoffs(transcript, [record], [target], [project], [lead, support, { ...lead, id: 'argus', name: 'Argus' }], {},
      () => ({ running, asking: false }))
    const shape = (projected: Row[]) => projected.map((row) => row.kind === 'work_handoff' ? 'card' : row.key)
    const history = [created, receipt('first', 2), chatter, reopenedAt('reopened', 3), receipt('second', 4)]

    expect(shape(project_(reported, history))).toEqual(['chatter', 'card'])
    const card = project_(reported, history).at(-1) as WorkHandoffRow
    expect(card.report).toMatchObject({ decision: 'open', version: 4, files: 2, reviewer: 'Argus', limitations: 'No empty-chat test.' })
    expect(workCardStatus(card)).toEqual({ tone: 'ready', text: 'Ready' })
    expect(workConfirmTitle(card.report!)).toBe('Commits the 2 reviewed files.')
    expect(workConfirmTitle({ ...card.report!, mergeInto: 'main', files: 1, reviewer: undefined })).toBe('Commits the file and merges it into main.')
    expect(workCardLine(card)).toBeNull()

    // Request changes: Working, nothing more. Changed after it was ready: Working plus the one line.
    const revised = { ...handoff, acceptedAt: 1, version: 5 }
    const working = project_(revised, [...history, reopenedAt('again', 5)], true).at(-1) as WorkHandoffRow
    expect(shape(project_(revised, [...history, reopenedAt('again', 5)]))).toEqual(['chatter', 'card'])
    expect(working.report).toBeUndefined()
    expect(working.changedAfterReady).toBeUndefined()
    expect(workCardStatus(working)).toEqual({ tone: 'busy', text: 'Working' })
    expect((project_(revised, [...history, reopenedAt('again', 5, true)]).at(-1) as WorkHandoffRow).changedAfterReady).toBe(true)

    // After Confirm the header follows the commit, and a landed one folds the card to one line.
    const accepted = (status: 'pending' | 'complete' | 'blocked', extra: Partial<WorkHandoff> = {}, transcript = history) => project_({
      ...reported, goalConfirmedAt: 6, goalCompletion: { ...completion, status, ...(status === 'blocked' ? { message: 'Commit failed.' } : {}) }, ...extra,
    }, transcript).at(-1) as WorkHandoffRow
    expect(workCardStatus(accepted('pending'))).toEqual({ tone: 'busy', text: 'Committing…' })
    expect(workCardStatus(accepted('blocked'))).toEqual({ tone: 'warn', text: 'Commit blocked' })
    expect(workBlockedReason(accepted('blocked').report!)).toBe('Commit failed.')
    expect(accepted('blocked').session).toBe('blocked')
    expect(workCardLine(accepted('blocked'))).toBeNull()
    // Never Merging… for a blocked merge, and Working again once a turn retries it.
    const merge = { ...completion, operation: 'merge' as const, status: 'blocked' as const, message: "The merge didn't land. Open the Session to continue." }
    const blockedMerge = project_({ ...reported, goalConfirmedAt: 6, goalCompletion: merge }, history).at(-1) as WorkHandoffRow
    expect(workCardStatus(blockedMerge)).toEqual({ tone: 'warn', text: 'Merge blocked' })
    expect(workBlockedReason(blockedMerge.report!)).toBe("The merge didn't land.")
    const retrying = project_({ ...reported, goalConfirmedAt: 6, goalCompletion: merge }, history, true).at(-1) as WorkHandoffRow
    expect(retrying.session).toBe('working')
    expect(workCardStatus(retrying)).toEqual({ tone: 'busy', text: 'Working' })
    // A landed commit folds to what landed, not the report's first sentence.
    expect(workCardLine(accepted('complete'))).toEqual({ summary: '2 files', status: { tone: 'ok', text: 'Committed' } })
    // Manor's own merge: its place in the folder's queue, then a conflict fix held for the user.
    const merging = (stage: NonNullable<WorkHandoff['goalCompletion']>['merge']) => project_({
      ...reported, goalConfirmedAt: 6, goalCompletion: { ...completion, operation: 'merge', status: 'pending', merge: stage },
    }, history).at(-1) as WorkHandoffRow
    expect(workCardStatus(merging({ stage: 'queued', after: 'Exportknop', ahead: 1 }))).toEqual({ tone: 'busy', text: 'Merging next, after Exportknop' })
    expect(workCardStatus(merging({ stage: 'queued', after: 'Exportknop', ahead: 2 }))).toEqual({ tone: 'busy', text: 'Waiting to merge, after Exportknop' })
    expect(workCardLine(merging({ stage: 'queued', after: 'Exportknop', ahead: 1 }))).toBeNull()
    const fix = { repo: '/wt', tip: 'abc', files: ['a.ts'], diff: '+mine' }
    const approving = merging({ stage: 'approve', fix, approved: { '/wt': 'old' }, trouble: { kind: 'conflict', text: 'x', repo: '/wt', tip: 'old' } })
    expect(approving.session).toBe('blocked')
    expect(workCardStatus(approving)).toEqual({ tone: 'warn', text: 'Conflict fix awaits you' })
    expect(approving.report?.completion?.merge).toEqual({ stage: 'approve', fix, trouble: 'conflict' })
    // Settled leaves the same one element; a commit Git never confirmed claims nothing.
    expect(shape(project_({ ...reported, goalConfirmedAt: 6, state: 'settled', goalCompletion: { ...completion, status: 'complete' } }, [...history, settledAt('settled', 7)])))
      .toEqual(['chatter', 'card'])
    expect(workCardLine(accepted('pending', { state: 'settled' }))?.status).toEqual({ tone: 'dim', text: 'Settled' })
  })

  it('lists only the cards waiting on the user, newest first: an open proposal and an open result', () => {
    const note = (id: string, phase?: 'created'): Row => ({
      kind: 'event', key: `note:${id}`, event: {
        id: `note:${id}`, ts: 1, type: 'system_note', kind: 'info', text: 'Work.',
        workHandoffId: id, workHandoffVersion: 1, ...(phase === undefined ? {} : { workHandoffPhase: phase }),
      },
    })
    const session = (id: string, extra: Partial<Chat> = {}): Chat => ({ ...target, id: `work:${id}`, title: id, ...extra })
    const report = { result: 'Done.' }
    const records: WorkHandoff[] = [
      { ...handoff, id: 'proposed', workChatId: null, title: 'proposed' },
      { ...handoff, id: 'rejected', workChatId: null, state: 'settled', title: 'rejected' },
      { ...handoff, id: 'working', workChatId: 'work:working', acceptedAt: 2 },
      { ...handoff, id: 'reported', workChatId: 'work:reported', acceptedAt: 2, goalReachedAt: 2, goalReport: report },
      { ...handoff, id: 'confirmed', workChatId: 'work:confirmed', acceptedAt: 2, goalReport: report, goalConfirmedAt: 3 },
      { ...handoff, id: 'settled', workChatId: 'work:settled', acceptedAt: 2, goalReport: report },
      { ...handoff, id: 'deleted', workChatId: null, state: 'deleted', title: 'deleted' },
    ]
    const chats = [session('working'), session('reported'), session('confirmed'), session('settled', { settledAt: 4 })]
    const transcript = records.map((record) => note(record.id, record.goalReport === undefined ? 'created' : undefined))
    const open = (handoffs: WorkHandoff[]) =>
      openWorkDecisions(projectWorkHandoffs(transcript, handoffs, chats, [project], [lead])).map((decision) => [decision.kind, decision.row.handoffId])

    expect(open(records)).toEqual([['result', 'reported'], ['proposal', 'proposed']])
    // Accepting either one takes its row away; the bar is then empty.
    expect(open(records.map((record) => record.id === 'proposed' ? { ...record, acceptedAt: 5, workChatId: 'work:working' } : record)))
      .toEqual([['result', 'reported']])
    expect(open(records.filter((record) => record.id !== 'proposed').map((record) =>
      record.id === 'reported' ? { ...record, goalConfirmedAt: 5 } : record))).toEqual([])
  })

  it('leaves cards shown in the thread out of the bar, and a replaced proposal out entirely', () => {
    const created = (id: string): Row => ({
      kind: 'event', key: `note:${id}`, event: {
        id: `note:${id}`, ts: 1, type: 'system_note', kind: 'info', text: 'Proposed.',
        workHandoffId: id, workHandoffVersion: 1, workHandoffPhase: 'created',
      },
    })
    const proposal = (id: string, extra: Partial<WorkHandoff> = {}): WorkHandoff => ({ ...handoff, id, workChatId: null, ...extra })
    const records = [
      proposal('v1', { state: 'settled', version: 2, supersededById: 'v2', result: 'Replaced by v2.' }),
      proposal('v2', { state: 'settled', version: 2, supersededById: 'v3', revision: 2, result: 'Replaced by v3.' }),
      proposal('v3', { revision: 3 }),
      proposal('other'),
    ]
    const projected = projectWorkHandoffs(records.map((record) => created(record.id)), records, [], [project], [lead])
    const cards = projected.filter((row): row is WorkHandoffRow => row.kind === 'work_handoff')
    // Every replaced card points at the version that still counts, and only that one is open.
    expect(cards.map((card) => [card.handoffId, card.revision, card.replacedBy])).toEqual([
      ['v1', undefined, { key: 'work:v3', revision: 3 }],
      ['v2', 2, { key: 'work:v3', revision: 3 }],
      ['v3', 3, undefined],
      ['other', undefined, undefined],
    ])
    const bar = (inView?: Set<string>) => openWorkDecisions(projected, inView).map((decision) => decision.row.handoffId)
    expect(bar()).toEqual(['other', 'v3'])
    expect(bar(new Set(['work:v3']))).toEqual(['other'])
    expect(bar(new Set(['work:v3', 'work:other']))).toEqual([])
  })

  it('cuts a done card’s line at the first real sentence, abbreviations included', () => {
    expect(firstSentence('Dr. Smith kept per-agent memory beside the shared layer. A pause.')).toBe('Dr. Smith kept per-agent memory beside the shared layer.')
    expect(firstSentence('Use e.g. this one. Then that.')).toBe('Use e.g. this one.')
    expect(firstSentence('No stop at all')).toBe('No stop at all')
    expect(firstSentence('Fixed it. Added regression tests.')).toBe('Fixed it.')
    expect(firstSentence('Asked J. Smith first. Then shipped.')).toBe('Asked J. Smith first.')
  })

  it('ticks Worktree by default and unticking sends the Session to the shared checkout', () => {
    const base = projectWorkHandoffs(rows, [{ ...handoff, workChatId: null }], [], [project], [lead, support])
      .find((row): row is WorkHandoffRow => row.kind === 'work_handoff')!
    const card = { ...base, handoffId: 'worktree-default', worktreeAvailable: true }
    expect(workProposalDraft(card, [lead]).isolate).toBe(true)
    expect(workProposalOptions(card, workProposalDraft(card, [lead]))).toMatchObject({ checkout: { mode: 'worktree' } })
    updateWorkProposal('worktree-default', { isolate: false })
    expect(workProposalOptions(card, workProposalDraft(card, [lead]))).not.toHaveProperty('checkout')
    // No linked git folder, no checkbox, and the default never reaches the wire.
    const noGit = { ...card, handoffId: 'no-git', worktreeAvailable: false }
    expect(workProposalOptions(noGit, workProposalDraft(noGit, [lead]))).not.toHaveProperty('checkout')
  })

  it('counts a card as shown when half of it, or half of the visible thread, is on screen', () => {
    const view = { top: 64, bottom: 600 }
    expect(workCardInView({ top: 100, bottom: 300 }, view)).toBe(true)
    // Half under the composer still counts; more than half does not.
    expect(workCardInView({ top: 500, bottom: 700 }, view)).toBe(true)
    expect(workCardInView({ top: 520, bottom: 720 }, view)).toBe(false)
    expect(workCardInView({ top: -100, bottom: 80 }, view)).toBe(false)
    expect(workCardInView({ top: 700, bottom: 900 }, view)).toBe(false)
    // A card taller than the thread counts while it fills half of it.
    expect(workCardInView({ top: 300, bottom: 2_000 }, view)).toBe(true)
    expect(workCardInView({ top: 400, bottom: 2_000 }, view)).toBe(false)
  })

  it('starts a Claude Single card on Opus 5.5 High, whatever the chief of staff runs, and keeps other providers on the CoS runtime', () => {
    const solo = { ...projectWorkHandoffs(rows, [{ ...handoff, workChatId: null }], [], [project], [lead, support])
      .find((row): row is WorkHandoffRow => row.kind === 'work_handoff')!, handoffId: 'cos-default', supportingAgentIds: [], supportingAgentNames: [] }
    const claudeCos: AgentConfig = { ...lead, id: 'cos', isCos: true, driver: 'claude', model: 'claude-fable-5-2', effort: 'medium' }
    const codexCos: AgentConfig = { ...claudeCos, driver: 'codex', model: 'gpt-6-luna' }
    expect(workProposalDraft(solo, [claudeCos]).runtime).toEqual({ driver: 'claude', model: 'claude-opus-5-5', effort: 'high' })
    expect(workProposalDraft(solo, [codexCos]).runtime).toEqual({ driver: 'codex', model: 'gpt-6-luna', effort: 'medium' })
    updateWorkProposal('cos-default', { runtime: { driver: 'claude', model: 'claude-sonnet-5-5', effort: 'high' } })
    expect(workProposalDraft(solo, [claudeCos]).runtime.model).toBe('claude-sonnet-5-5')
  })

  it('keeps a thread card Single on its proposed runtime, whatever mode an old draft holds, and accepts it as Single', async () => {
    const proposedRuntime = { runtime: { driver: 'claude', model: 'claude-sonnet-5-5', effort: 'high' } as const, reason: 'small UI change' }
    const sessionLead = { ...lead, placement: 'session' as const }
    const row = { ...projectWorkHandoffs(rows, [{ ...handoff, workChatId: null, authorAgentId: '__single__', proposedRuntime }], [], [project], [sessionLead, support])
      .find((candidate): candidate is WorkHandoffRow => candidate.kind === 'work_handoff')!, handoffId: 'thread-card' }
    expect(row).toMatchObject({ threadAuthored: true, proposedRuntime })
    // A starting team and a lead who could run Multiple do not turn a thread card into Multiple.
    expect(row.supportingAgentIds.length).toBeGreaterThan(0)
    expect(workProposalSingleOnly(row, [sessionLead])).toBe(true)
    expect(workProposalDraft(row, [sessionLead])).toMatchObject({ mode: 'single', runtime: proposedRuntime.runtime })
    updateWorkProposal('thread-card', { mode: 'house', runtime: { driver: 'claude', model: 'claude-opus-5-5', effort: 'high' } })
    expect(workProposalDraft(row, [sessionLead])).toMatchObject({ mode: 'single', runtime: { model: 'claude-opus-5-5' } })
    const sent: unknown[] = []
    await acceptWorkProposal(row, [sessionLead], (_, options) => { sent.push(options) })
    expect(sent).toEqual([{ mode: 'single', runtime: { driver: 'claude', model: 'claude-opus-5-5', effort: 'high' } }])
  })

  it('accepts a proposal with what was chosen on its card, once, from either surface', async () => {
    const row = projectWorkHandoffs(rows, [{ ...handoff, workChatId: null }], [], [project], [lead, support])
      .find((candidate): candidate is WorkHandoffRow => candidate.kind === 'work_handoff')!
    expect(workProposalDraft(row, [lead]).mode).toBe('house')
    updateWorkProposal(row.handoffId, { mode: 'single', task: 'Edited task.' })

    let release!: () => void
    const sent: unknown[] = []
    const accept = (_: string, options: unknown) => { sent.push(options); return new Promise<string>((resolve) => { release = () => resolve('work_new') }) }
    const first = acceptWorkProposal(row, [lead], accept)
    expect(await acceptWorkProposal(row, [lead], accept)).toEqual({ accepted: false })
    release()
    expect(await first).toEqual({ accepted: true, value: 'work_new' })
    expect(sent).toEqual([{ mode: 'single', runtime: workProposalDraft(row, [lead]).runtime, task: 'Edited task.' }])

    const refused = await acceptWorkProposal(row, [lead], () => Promise.reject(new Error('Already accepted.')))
    expect(refused).toEqual({ accepted: false })
    expect(workProposalDraft(row, [lead])).toMatchObject({ accepting: false, error: 'Already accepted.' })
  })
})

describe('workByline', () => {
  it('names only the model in Single', () => {
    expect(workByline({ single: true, model: 'Opus 5.5' })).toBe('Opus 5.5')
  })

  it('names the lead in Multiple, and the starter only when someone else starts', () => {
    expect(workByline({ single: false, lead: 'Wren' })).toBe('led by Wren')
    expect(workByline({ single: false, lead: 'Wren', starter: 'Wren' })).toBe('led by Wren')
    expect(workByline({ single: false, lead: 'Wren', starter: 'Smith' })).toBe('led by Wren, Smith starts')
  })
})

describe('a result card that tells the truth (2026-10-14)', () => {
  const none = { status: 'ready' as const, operation: 'none' as const, repos: [] }
  const commit = { status: 'ready' as const, operation: 'commit' as const, repos: [{ path: '/repo', branch: 'main', before: 'a', tree: 'b', files: ['src/a.ts', 'docs/b.md'] }] }
  const choices = [
    { title: 'Open large', options: ["Manor's Browser", 'a zoom view like T3'], recommended: 'zoom' },
    { title: 'Theme', options: ['injected variables', 'fixed palette', 'none'] },
    { title: 'Height', options: ['fit content', 'fixed'], recommended: 'fit content' },
    { title: 'Scripts', options: ['on', 'off'] },
  ]
  const created: Row = { kind: 'event', key: 'created', event: { id: 'c', ts: 1, type: 'system_note', kind: 'info', text: 'Proposed.', workHandoffId: handoff.id, workHandoffVersion: 1, workHandoffPhase: 'created' } }
  const card = (record: Partial<WorkHandoff>, running = false) => projectWorkHandoffs([created], [{ ...handoff, acceptedAt: 1, goalReachedAt: 3, version: 2, ...record }], [target], [project], [lead, { ...lead, id: 'argus', name: 'Argus' }], {},
    () => ({ running, asking: false })).at(-1) as WorkHandoffRow

  it('offers Follow up and Close on a report with nothing to commit, with its choices and no reviewer', () => {
    const report = card({ goalReport: { result: 'HTML can look native in the chat.', choices }, goalCompletion: none }).report!
    expect(workResultActionLabels(report)).toEqual({ secondary: 'Follow up', primary: 'Close', pending: 'Closing…' })
    expect(workResultChoiceList(report)).toEqual({ choices: choices.slice(0, 3), more: 1 })
  })

  it('keeps Request changes and Confirm on a result that commits files, choices or not', () => {
    const report = card({ goalReport: { result: 'Export works.', choices: choices.slice(0, 1) }, goalCompletion: commit, goalChangedFiles: ['/repo/src/a.ts'] }).report!
    expect(workResultActionLabels(report)).toEqual({ secondary: 'Request changes', primary: 'Confirm', pending: 'Confirming…' })
    expect(workResultChoiceList(report).choices).toHaveLength(1)
    expect(workResultFiles(report)).toBe('2 files')
  })

  it('shows just the conclusion when a report names no choices', () => {
    const report = card({ goalReport: { result: 'Nothing to decide.' }, goalCompletion: none }).report!
    expect(report.choices).toBeUndefined()
    expect(workResultChoiceList(report)).toEqual({ choices: [], more: 0 })
    expect(workResultFiles(report)).toBeUndefined()
  })

  it('shows the lead\'s points as the card\'s lines (2026-11-07)', () => {
    const report = card({ goalReport: { result: 'Helpers show as cards.', points: ['Helpers are full-width cards', 'A Finished card when each ends'] }, goalCompletion: none }).report!
    expect(workResultLines(report)).toEqual(['Helpers are full-width cards', 'A Finished card when each ends'])
  })

  it('reads a report from before points as its sentences, at most three lines', () => {
    const report = card({ goalReport: { result: 'Sessions show helpers as cards. Dr. Smith checked it.\nAgent DMs show none. One more. And another.' }, goalCompletion: none }).report!
    expect(report.points).toBeUndefined()
    expect(workResultLines(report)).toEqual(['Sessions show helpers as cards.', 'Dr. Smith checked it.', 'Agent DMs show none.'])
    expect(workResultLines({ result: 'One line without a stop' })).toEqual(['One line without a stop'])
  })

  it('writes a picked option into Follow up, one line per choice, keeping what the user wrote', () => {
    const theme = { title: 'Theme', options: ['fixed palette', 'none'] }
    const once = pickWorkChoice('', theme, 'fixed palette')
    expect(once).toBe('Theme: fixed palette')
    const both = pickWorkChoice(`Theme: keep contrast high.\n${once}\n`, { title: 'Height', options: ['fixed', 'fit'] }, 'fixed')
    expect(both).toBe('Theme: keep contrast high.\nTheme: fixed palette\nHeight: fixed')
    const changed = pickWorkChoice(both, theme, 'none')
    expect(changed).toBe('Theme: keep contrast high.\nHeight: fixed\nTheme: none')
    expect(workChoicePicked(changed, 'Theme', 'none')).toBe(true)
    expect(workChoicePicked(changed, 'Theme', 'fixed palette')).toBe(false)
  })

  it('opens Follow up for a pick that asks a change, and leaves Confirm for a pick that needs none', () => {
    const cleanup = { title: 'Stale checks', options: ['Clean up on its own', 'Leave them'], noChange: 'Leave them' }
    const height = { title: 'Height', options: ['fixed', 'fit'] }
    const choices = [cleanup, height]
    const kept = pickWorkChoice('', cleanup, 'Leave them')
    expect(workChangesAsked(kept, choices)).toBe(false)
    expect(workChangesAsked(pickWorkChoice(kept, cleanup, 'Clean up on its own'), choices)).toBe(true)
    expect(workChangesAsked(pickWorkChoice(kept, height, 'fit'), choices)).toBe(true)
    expect(workChangesAsked(`Also rename it.\n${kept}`, choices)).toBe(true)
    expect(workChangesAsked(pickWorkChoice('', height, 'fixed'), [height])).toBe(true)
    expect(workChangesAsked(kept)).toBe(true)
    const twin = { title: 'Stale checks', options: ['Leave them', 'Remove them'], noChange: 'Remove them' }
    expect(workChangesAsked(kept, [cleanup, twin])).toBe(true)
  })

  it('reads Closed after Close on a report, on the card and in the project thread', () => {
    const closed = card({ goalReport: { result: 'HTML can look native in the chat.' }, goalCompletion: none, goalConfirmedAt: 4 })
    expect(workCardStatus(closed)).toEqual({ tone: 'ok', text: 'Closed' })
    expect(threadWorkCard(closed)).toMatchObject({ shape: 'done', status: { text: 'Closed' } })
  })

  it('drops Ready from the Session bar and the card while the Session works again, and brings it back after', () => {
    const reported = { ...handoff, acceptedAt: 1, goalReachedAt: 3, version: 2, goalReport: { result: 'Done.' }, goalCompletion: none }
    const live = (running: boolean) => () => ({ running, asking: false })
    expect(sessionReadyRow(target, [reported], [target], [project], [lead], {}, live(false))?.session).toBe('ready')
    expect(sessionReadyRow(target, [reported], [target], [project], [lead], {}, live(true))).toBeUndefined()
    const working = card({ goalReport: { result: 'Done.' }, goalCompletion: none }, true)
    expect(working.session).toBe('working')
    expect(workCardStatus(working)).toEqual({ tone: 'busy', text: 'Working' })
    expect(openWorkDecisions([working])).toEqual([])
    // A question the new work asks reads Waiting, not the old Ready.
    const asking = projectWorkHandoffs([created], [reported], [target], [project], [lead], {}, () => ({ running: true, asking: true })).at(-1) as WorkHandoffRow
    expect(workCardStatus(asking)).toEqual({ tone: 'waiting', text: 'Waiting' })
    expect(sessionReadyRow(target, [reported], [target], [project], [lead], {}, () => ({ running: false, asking: true }))).toBeUndefined()
  })

  it('finds the report in the last turn that called goal_reached, the longest thing the lead said there', () => {
    const events: ThreadEvent[] = [
      { id: 'old', ts: 1, type: 'agent_message', turnId: 't1', agentId: 'sage', text: 'An earlier answer that is long but not a report at all.' },
      { id: 'old_done', ts: 2, type: 'turn_result', turnId: 't1', agentId: 'sage' },
      { id: 'report', ts: 3, type: 'agent_message', turnId: 't2', agentId: 'sage', text: 'The report: options, a recommendation and two choices for Sam.' },
      { id: 'call', ts: 4, type: 'tool_use', turnId: 't2', agentId: 'sage', tool: 'mcp__manor__goal_reached' },
      { id: 'closing', ts: 5, type: 'agent_message', turnId: 't2', agentId: 'sage', text: 'Ready for you.' },
      { id: 'done', ts: 6, type: 'turn_result', turnId: 't2', agentId: 'sage' },
    ]
    const rows = rowsOf({ ...emptyThread, events })
    expect(goalReportEventId(rows)).toBe('report')
    expect(goalReportEventId(rows.slice(0, 1))).toBeUndefined()
    // A later call the server refused ("already reached") does not move the target.
    const refused = rowsOf({ ...emptyThread, events: [
      ...events,
      { id: 'again_text', ts: 7, type: 'agent_message', turnId: 't3', agentId: 'sage', text: 'A follow-up answer longer than the closing line.' },
      { id: 'again', ts: 8, type: 'tool_use', turnId: 't3', agentId: 'sage', tool: 'mcp__manor__goal_reached', toolCallId: 'c3' },
      { id: 'again_result', ts: 9, type: 'tool_result', turnId: 't3', agentId: 'sage', toolCallId: 'c3', outcome: 'error' },
      { id: 'again_done', ts: 10, type: 'turn_result', turnId: 't3', agentId: 'sage' },
    ] })
    expect(goalReportEventId(refused)).toBe('report')
  })
})

describe('evidenceVisibleCount', () => {
  // Three 50px thumbnails 6px apart are 162px wide; the +N tile is 32px.
  const widths = [50, 50, 50]
  it('shows every screenshot while the row holds them all', () => {
    expect(evidenceVisibleCount(widths, 162, 6, 32)).toBe(3)
    expect(evidenceVisibleCount([], 0, 6, 32)).toBe(0)
  })
  it('keeps as many as fit beside the tile once they do not', () => {
    expect(evidenceVisibleCount(widths, 161, 6, 32)).toBe(2)
    expect(evidenceVisibleCount(widths, 143, 6, 32)).toBe(1)
  })
  it('never collapses below the first screenshot', () => {
    expect(evidenceVisibleCount(widths, 10, 6, 32)).toBe(1)
  })
})
