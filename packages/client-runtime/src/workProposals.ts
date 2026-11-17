import { EFFORTS, modelLabel, workSingleDefault, type AgentConfig, type ChatMode, type SingleRuntime } from '@manor/contracts'
import type { WorkAcceptanceOptions } from './commands'
import type { WorkHandoffRow } from './transcriptState'

/**
 * What the user set on a proposal before Accept, kept per proposal outside the card. The
 * card in the thread and its row in the bar above the composer both read and accept
 * through this, so Accept in the bar starts what the card shows.
 */
export interface WorkProposalDraft {
  mode: ChatMode
  runtime: SingleRuntime
  isolate: boolean
  /** Set only when the user edited the proposed task. */
  task?: string
  accepting: boolean
  error: string | null
}

/** Only what was changed is stored; the rest follows the proposal as it is now. */
export type WorkProposalEdits = Partial<WorkProposalDraft>

const NO_EDITS: WorkProposalEdits = {}
const edits = new Map<string, WorkProposalEdits>()
const listeners = new Set<() => void>()

export function subscribeWorkProposals(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** The same object until the proposal's edits change, which is what `useSyncExternalStore` needs. */
export const readWorkProposalEdits = (handoffId: string): WorkProposalEdits => edits.get(handoffId) ?? NO_EDITS

export function updateWorkProposal(handoffId: string, patch: WorkProposalEdits): void {
  const next = { ...readWorkProposalEdits(handoffId), ...patch }
  if ('task' in patch && patch.task === undefined) delete next.task
  edits.set(handoffId, next)
  for (const listener of listeners) listener()
}

/**
 * Results whose Request changes field is open. The card and its bar row share it, so
 * Request changes in the bar opens the field on the card it scrolls to.
 */
const changesOpen = new Set<string>()

export const readWorkChangesOpen = (handoffId: string): boolean => changesOpen.has(handoffId)

export function setWorkChangesOpen(handoffId: string, open: boolean): void {
  if (changesOpen.has(handoffId) === open) return
  if (open) changesOpen.add(handoffId)
  else changesOpen.delete(handoffId)
  for (const listener of listeners) listener()
}

/**
 * The card's defaults with the user's edits on top. A project thread's card is always Single
 * (2026-11-17), on the runtime it proposed; any other card is Multiple for a team and Single
 * for one agent. `household` is every agent, for the Multiple block; it defaults to `agents`.
 */
export function workProposalDraft(row: WorkHandoffRow, agents: readonly AgentConfig[], changed = readWorkProposalEdits(row.handoffId), household: readonly AgentConfig[] = agents): WorkProposalDraft {
  const draft: WorkProposalDraft = {
    mode: row.supportingAgentIds.length === 0 ? 'single' : 'house',
    runtime: row.proposedRuntime?.runtime ?? workSingleDefault(agents),
    isolate: true,
    accepting: false,
    error: null,
    ...changed,
  }
  // Multiple cannot start this card (its lead is gone, or nobody works in Sessions), so it stands on Single.
  return workProposalSingleOnly(row, household) ? { ...draft, mode: 'single' } : draft
}

/**
 * True when the card offers no Single/Multiple choice: a project thread's card, which
 * always starts Single, or one that Multiple cannot start.
 */
export function workProposalSingleOnly(row: Pick<WorkHandoffRow, 'leadAgentId' | 'threadAuthored'>, household: readonly AgentConfig[]): boolean {
  return row.threadAuthored === true || workProposalMultipleBlock(row, household) !== undefined
}

/**
 * Why Multiple cannot start this proposal, or undefined when it can. Multiple starts the
 * lead, so the lead must be a persona of this household that works in Sessions. The card
 * disables Multiple with this reason instead of letting Accept fail. `household` is every
 * agent, not the card's `agents`, which a project thread hands in empty.
 */
export function workProposalMultipleBlock(row: Pick<WorkHandoffRow, 'leadAgentId'>, household: readonly AgentConfig[]): string | undefined {
  const lead = household.find((agent) => agent.id === row.leadAgentId)
  if (lead !== undefined && lead.placement !== 'chat') return undefined
  return household.some((agent) => agent.placement !== 'chat')
    ? 'No Session persona leads this proposal, so it runs as Single'
    : 'Add a session agent to run Multiple'
}

/** A Single runtime as the card names it, as in "Sonnet 5.5, High". */
export function workProposalRuntimeName(runtime: SingleRuntime): string {
  const effort = EFFORTS.find((option) => option.value === runtime.effort)?.label ?? runtime.effort
  return `${modelLabel(runtime.driver, runtime.model)}, ${effort}`
}

/**
 * What goes along with the kickoff, as in "2 attachments: mockup.html, screen.png".
 * Pictures alone are only counted, "3 images": a pasted image's name says nothing.
 */
export function workProposalAttachmentLine(row: Pick<WorkHandoffRow, 'attachments' | 'attachmentsAllImages'>): string | undefined {
  const count = workProposalAttachmentCount(row)
  if (count === undefined || row.attachmentsAllImages === true) return count
  return `${count}: ${(row.attachments ?? []).join(', ')}`
}

/** The attachments counted without their names, as in "1 image" or "2 attachments", for the phone's runtime line. */
export function workProposalAttachmentCount(row: Pick<WorkHandoffRow, 'attachments' | 'attachmentsAllImages'>): string | undefined {
  const count = row.attachments?.length ?? 0
  if (count === 0) return undefined
  const noun = row.attachmentsAllImages === true ? 'image' : 'attachment'
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

export function workProposalOptions(row: WorkHandoffRow, draft: WorkProposalDraft): WorkAcceptanceOptions {
  return {
    mode: draft.mode,
    ...(draft.mode === 'single' ? { runtime: draft.runtime } : {}),
    ...(draft.isolate && row.worktreeAvailable === true ? { checkout: { mode: 'worktree' } } : {}),
    ...(draft.task === undefined ? {} : { task: draft.task }),
  }
}

/**
 * Accepts a proposal once, from whichever surface asked first. A second click while one
 * is in flight is ignored. A refusal stays on the draft for both surfaces to show.
 */
export async function acceptWorkProposal<T>(
  row: WorkHandoffRow,
  agents: readonly AgentConfig[],
  accept: (handoffId: string, options: WorkAcceptanceOptions) => Promise<T> | T,
  household: readonly AgentConfig[] = agents,
): Promise<{ accepted: true; value: T } | { accepted: false }> {
  const draft = workProposalDraft(row, agents, undefined, household)
  if (draft.accepting) return { accepted: false }
  updateWorkProposal(row.handoffId, { accepting: true, error: null })
  try {
    const value = await accept(row.handoffId, workProposalOptions(row, draft))
    updateWorkProposal(row.handoffId, { accepting: false })
    return { accepted: true, value }
  } catch (cause) {
    updateWorkProposal(row.handoffId, {
      accepting: false,
      error: cause instanceof Error ? cause.message : 'Could not accept this session. Try again.',
    })
    return { accepted: false }
  }
}
