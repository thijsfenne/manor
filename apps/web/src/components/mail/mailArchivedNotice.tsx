import { useEffect } from 'react'
import { Archive02Icon } from '@hugeicons/core-free-icons'
import { mailCards, type MailState } from '@manor/client-runtime/mail'
import { mailViewShowing } from '../../mail'
import { Icon } from '../Icon'
import type { HouseNotice } from '../NoticeStack'
import { Button } from '../ui/Button'
import { NoticeCard } from '../ui/NoticeCard'
import { mailView, setMailView, useMailView } from './mailViewStore'
import { useNoticeHold } from './useNoticeHold'

/**
 * The `Archived` card in the window's notice stack, with its Undo, for one Archive of one
 * or more threads. It stays while the pointer or focus rests on it. A thread the host
 * refused leaves it, and it goes at once when all were refused: those cards are back
 * then and each refusal has its own notice.
 */
export function useMailArchivedNotice(mail: MailState, unarchive: (requestId: string, threadId: string) => boolean): HouseNotice | null {
  const { archived } = useMailView()
  const kept = archived?.filter((entry) => mail.results[entry.requestId]?.ok !== false) ?? []
  const key = archived?.[0] === undefined ? null : `mail-${archived[0].requestId}`
  const refused = archived !== null && kept.length === 0

  useEffect(() => {
    if (refused) setMailView({ archived: null })
  }, [refused])
  const hold = useNoticeHold(key, () => setMailView({ archived: null }))

  if (key === null || refused) return null
  // A card on its way out, replaced by the next Archive, no longer acts: the notice up now is not its own.
  const replaced = () => mailView().archived !== archived
  const dismiss = () => {
    if (!replaced()) setMailView({ archived: null })
  }
  const undo = () => {
    if (replaced()) return
    // Offline nothing leaves, and the card stays up to be pressed again.
    const back = kept.filter((entry) => unarchive(`mail-unarchive-${crypto.randomUUID()}`, entry.threadId))
    const threadId = back[0]?.threadId
    if (threadId === undefined) return
    const card = mail.archived[threadId] ?? mailCards(mail).find((entry) => entry.threadId === threadId)
    const { tab, query } = mailView()
    // A tab or search that would hide the returned card gives way, so it can be seen selected.
    setMailView({ selectedId: threadId, picked: [], archived: null, ...(card === undefined ? {} : mailViewShowing(card, tab, query)) })
  }
  return {
    key,
    dismiss,
    node: (
      <div {...hold}>
        <NoticeCard mark={<Icon icon={Archive02Icon} size={20} className="text-muted" />}
          title={kept.length === 1 ? 'Archived' : `Archived ${kept.length} mails`}
          action={<Button size="small" onClick={undo}>Undo</Button>} onDismiss={dismiss} />
      </div>
    ),
  }
}
