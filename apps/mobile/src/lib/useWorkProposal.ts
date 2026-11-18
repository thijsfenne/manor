import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { AgentConfig } from '@manor/contracts'
import type { WorkHandoffRow } from '@manor/client-runtime/state'
import { readWorkProposalEdits, subscribeWorkProposals, workProposalDraft } from '@manor/client-runtime/work-proposals'
import { useOffModels } from '@/useOffModels'

/** A proposal's choices and Accept state, shared by its card and its row above the composer. */
export function useWorkProposal(row: WorkHandoffRow, agents: readonly AgentConfig[], household: readonly AgentConfig[] = agents) {
  const read = useCallback(() => readWorkProposalEdits(row.handoffId), [row.handoffId])
  const edits = useSyncExternalStore(subscribeWorkProposals, read, read)
  // The card shows the runtime Accept sends, so a model turned off elsewhere redraws it.
  const off = useOffModels()
  return useMemo(() => workProposalDraft(row, agents, edits, household, off), [row, agents, edits, household, off])
}
