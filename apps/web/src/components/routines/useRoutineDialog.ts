import { useEffect, useState } from 'react'
import type { Routine, RoutineDraft } from '@manor/contracts'
import { draftOfRoutine } from '../../routines'
import { useRequest, type RequestEvents } from '../../useRequest'

interface RoutineDialogOptions {
  requestEvents: RequestEvents
  onSave: (draft: RoutineDraft, requestId: string) => boolean
  onDismissNotice: () => void
  onDialogChange?: (open: boolean) => void
}

/**
 * Owns the request lifecycle for the routine dialog, the way `useAgentDialog` does
 * for a persona: the form stays open and keeps every value until the matching ack,
 * and a refusal drops the pending state without discarding the draft.
 */
export function useRoutineDialog({
  requestEvents,
  onSave,
  onDismissNotice,
  onDialogChange,
}: RoutineDialogOptions) {
  const [editing, setEditing] = useState<RoutineDraft | null>(null)
  const [pending, setPending] = useState(false)
  const { start, cancel } = useRequest(requestEvents)

  useEffect(() => {
    onDialogChange?.(editing !== null)
    return () => onDialogChange?.(false)
  }, [editing, onDialogChange])

  const open = (draft: RoutineDraft) => {
    onDismissNotice()
    cancel()
    setPending(false)
    setEditing(draft)
  }

  const close = () => {
    onDismissNotice()
    cancel()
    setPending(false)
    setEditing(null)
  }

  return {
    editing,
    pending: pending ? ('save' as const) : null,
    openRoutine: (routine: Routine) => open(draftOfRoutine(routine)),
    openDraft: open,
    close,
    save: (draft: RoutineDraft) => {
      const sent = start((requestId) => onSave(draft, requestId), {
        onAck: () => {
          setPending(false)
          setEditing(null)
        },
        onNotice: () => setPending(false),
      })
      if (sent) setPending(true)
      return sent
    },
  }
}
