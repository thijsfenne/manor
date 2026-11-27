import { useSyncExternalStore } from 'react'
import type { MailLabel } from '@manor/contracts'
import type { MailTab } from '../../mail'

/**
 * What the user is looking at in Mail, and the replies being written there. It lives outside
 * the view so it survives a visit to another door, and so the Undo of the Archived and the
 * Moved notices can select the thread again.
 * `useMailView` reads it and `setMailView` changes it.
 */
export interface MailViewState {
  selectedId: string | null
  tab: MailTab
  query: string
  /**
   * Two or more cards picked with Cmd or Shift, which hide the open thread until they are
   * cleared; empty otherwise. `selectedId` stays the thread that comes back then.
   */
  picked: string[]
  /** The latest Archive, one entry per thread, while its notice offers Undo. */
  archived: { requestId: string; threadId: string }[] | null
  /**
   * The latest label key that moved the open mail, while its notice is up: `previous` is the
   * label its Undo sets again, null for a mail that had none.
   */
  relabelled: { id: string; threadId: string; label: MailLabel; previous: MailLabel | null } | null
  /** Replies and forwards being written, by thread id; one stays until it is closed, sent or archived. */
  replies: Record<string, MailReply>
}

/** One reply or forward as its pane left it, so the pane comes back the same on any return. */
export interface MailReply {
  /**
   * A forward of the newest message rather than a reply: no draft is asked for, and it leaves
   * under `Fwd:`. `files` are that message's attachments that still go along, each with its
   * place in the message's list, which Send names; the pane's Remove filters one out.
   */
  forward?: { messageId: string; files: { index: number; name: string; kb: number }[] }
  /** The latest draft asked for; undefined until the first left, which the pane then asks for. */
  draftId?: string
  /** The latest send, and whom it went to, for the notice once it is confirmed. */
  sendId?: string
  sentTo?: string
  to: string
  cc: string
  body: string
  /** `draftId:status` of the finished draft last copied into `body`, so it is copied once. */
  settled?: string
}

let view: MailViewState = { selectedId: null, tab: 'reply', query: '', picked: [], archived: null, relabelled: null, replies: {} }
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

export function openMailReply(threadId: string, reply: MailReply): void {
  setMailView({ replies: { ...view.replies, [threadId]: reply } })
}

/** Changes a reply that is still there; one closed meanwhile stays closed. */
export function changeMailReply(threadId: string, change: Partial<MailReply>): void {
  const held = view.replies[threadId]
  if (held !== undefined) setMailView({ replies: { ...view.replies, [threadId]: { ...held, ...change } } })
}

export function dropMailReplies(threadIds: readonly string[]): void {
  if (!threadIds.some((threadId) => threadId in view.replies)) return
  setMailView({ replies: Object.fromEntries(Object.entries(view.replies).filter(([threadId]) => !threadIds.includes(threadId))) })
}

export const useMailView = (): MailViewState => useSyncExternalStore(subscribe, mailView, mailView)
