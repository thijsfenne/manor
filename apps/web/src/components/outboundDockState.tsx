import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { draftStatus, type DraftRecord, type Row } from '../state'
import type { DraftActions } from './OutboundDraftBubble'

type Dismissal = { failure: string | undefined }
const DockContext = createContext<{
  pinned: (draft: DraftRecord) => boolean
  act: (draft: DraftRecord, send: () => boolean) => boolean
} | null>(null)

export function OutboundDockProvider({ children, rows, enabled = true }: { children: ReactNode; rows: Row[]; enabled?: boolean }) {
  const [dismissed, setDismissed] = useState<Record<string, Dismissal>>({})
  // Once the server settles or locks a draft, its status owns visibility again.
  useEffect(() => {
    setDismissed((current) => {
      const settled = new Set(rows.flatMap((row) => row.kind === 'turn'
        ? row.drafts.filter((draft) => draftStatus(draft) !== 'open').map((draft) => draft.draftId)
        : []))
      const entries = Object.entries(current).filter(([id]) => !settled.has(id))
      return entries.length === Object.keys(current).length ? current : Object.fromEntries(entries)
    })
  }, [rows])
  const dismissal = (draft: DraftRecord) => {
    const entry = dismissed[draft.draftId]
    return entry?.failure === draft.failure ? entry : undefined
  }
  return <DockContext.Provider value={enabled ? {
    pinned: (draft) => draftStatus(draft) === 'open' && dismissal(draft) === undefined,
    act: (draft, send) => {
      if (!send()) return false
      setDismissed((current) => ({ ...current, [draft.draftId]: { failure: draft.failure } }))
      return true
    },
  } : null}>{children}</DockContext.Provider>
}

export const useOutboundDock = () => useContext(DockContext)

/** Dismiss dock decisions immediately; Restore waits for the reopened draft. */
export function useDockDraftActions(draft: DraftRecord, actions: DraftActions): DraftActions {
  const dock = useOutboundDock()
  if (dock === null) return actions
  const wrap = <Args extends unknown[]>(handler: ((...args: Args) => boolean) | undefined) =>
    handler === undefined ? undefined : (...args: Args) => dock.act(draft, () => handler(...args))
  return {
    ...actions,
    onSubmit: wrap(actions.onSubmit),
    onDiscard: wrap(actions.onDiscard),
    onSnooze: wrap(actions.onSnooze),
    onIgnore: wrap(actions.onIgnore),
  }
}
