import { useMemo } from 'react'
import type { DraftActions } from './components/OutboundDraftBubble'
import type { WorkspaceState } from './state'
import type { Manor } from './useWorkspace'

type OutboundCommands = Pick<Manor, 'submitOutboundDraft' | 'discardOutboundDraft' | 'snoozeOutboundDraft'
  | 'ignoreOutboundDraft' | 'restoreOutboundDraft' | 'readOutboundThread'>

/**
 * Outbound draft commands bound to one chat, for every pane that shows its drafts.
 * Cached per chat so a pane's actions keep their identity through streaming deltas and
 * only change when a command or the thread replies do.
 */
export function useOutboundDraftActions(manor: OutboundCommands, threads: WorkspaceState['outboundThreads']) {
  const { submitOutboundDraft, discardOutboundDraft, snoozeOutboundDraft, ignoreOutboundDraft, restoreOutboundDraft, readOutboundThread } = manor
  return useMemo(() => {
    const cached = new Map<string, DraftActions>()
    return (chatId: string): DraftActions => {
      let actions = cached.get(chatId)
      if (actions === undefined) {
        actions = {
          onSubmit: (draftId, body, subject, slackRichText, cc) => submitOutboundDraft(chatId, draftId, body, subject, slackRichText, cc),
          onDiscard: (draftId) => discardOutboundDraft(chatId, draftId),
          onSnooze: (draftId, until) => snoozeOutboundDraft(chatId, draftId, until),
          onIgnore: (draftId) => ignoreOutboundDraft(chatId, draftId),
          onRestore: (draftId) => restoreOutboundDraft(chatId, draftId),
          onReadThread: (draftId) => readOutboundThread(chatId, draftId),
          threads,
        }
        cached.set(chatId, actions)
      }
      return actions
    }
  }, [submitOutboundDraft, discardOutboundDraft, snoozeOutboundDraft, ignoreOutboundDraft, restoreOutboundDraft,
    readOutboundThread, threads])
}
