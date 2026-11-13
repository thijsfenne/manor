import type { Chat } from '@manor/contracts'
import { isHomeRoom, type WorkspaceState } from './state'

type SessionWorkspace = Pick<WorkspaceState, 'projects' | 'projectHasGit' | 'sessionRepos' | 'workHandoffs' | 'checkoutStatus'>

/**
 * Whether a chat's room links a git folder, which is what gives its panel Changes and
 * Branch. The Session's own status answers once it has been read; before that the
 * project's remembered git state does, so the door is right on first paint. A failed
 * read keeps the door: the status is only asked while the panel already shows its repo
 * sections, and that panel is where the error and its Retry are.
 * A Session without a project has no door: its room is the memory system, and it
 * belongs to no repository.
 */
export function chatHasRepo(workspace: SessionWorkspace, chat: Chat): boolean {
  const project = isHomeRoom(chat.projectId) ? undefined : workspace.projects.find((candidate) => candidate.id === chat.projectId)
  if (project === undefined || project.repoPaths.length === 0) return false
  const replied = workspace.sessionRepos[chat.id]
  if (replied !== undefined) return replied.error !== undefined || replied.repos.length > 0
  return workspace.projectHasGit[project.id] === true
}

/**
 * The result in this Session that still waits for Confirm, read the way its card reads
 * it, with what that card's Confirm sends. In a worktree Session Confirm also merges,
 * into the branch its linked folders are on.
 */
export function waitingGoal(workspace: SessionWorkspace, chat: Chat): { handoffId: string; version: number; mergeInto?: string } | undefined {
  if (chat.settledAt !== null || chat.archivedAt !== null) return undefined
  const handoff = workspace.workHandoffs.find((candidate) => candidate.workChatId === chat.id &&
    candidate.goalReport !== undefined && candidate.goalConfirmedAt === undefined && candidate.state === 'active')
  if (handoff === undefined) return undefined
  const status = workspace.checkoutStatus[chat.id]
  const mergeInto = chat.checkout.mode === 'worktree' && status?.mode === 'worktree' ? status.homeBranch : undefined
  return { handoffId: handoff.id, version: handoff.version, ...(mergeInto === undefined ? {} : { mergeInto }) }
}

/** Changes whenever this Session's result moves: published, confirmed, landed, reopened. */
export function sessionHandoffKey(workspace: SessionWorkspace, chat: Chat): string {
  const handoff = workspace.workHandoffs.find((candidate) => candidate.workChatId === chat.id)
  return handoff === undefined ? '' : `${handoff.version}|${handoff.goalConfirmedAt ?? ''}|${handoff.goalCompletion?.status ?? ''}`
}
