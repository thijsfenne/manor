import { useSyncExternalStore } from 'react'
import type { MailTab } from '../../mail'

/**
 * What the user is looking at in Mail. It lives outside the view so it survives a visit
 * to another door, and so the Archived notice's Undo can select the thread again.
 * `useMailView` reads it and `setMailView` changes it.
 */
export interface MailViewState {
  selectedId: string | null
  tab: MailTab
  query: string
  /** The latest Archive, while its notice offers Undo. */
  archived: { requestId: string; threadId: string } | null
}

let view: MailViewState = { selectedId: null, tab: 'all', query: '', archived: null }
const listeners = new Set<() => void>()

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export const mailView = (): MailViewState => view

export function setMailView(change: Partial<MailViewState>): void {
  view = { ...view, ...change }
  for (const listener of listeners) listener()
}

export const useMailView = (): MailViewState => useSyncExternalStore(subscribe, mailView, mailView)
