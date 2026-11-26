import { useEffect, useState } from 'react'
import { Archive02Icon } from '@hugeicons/core-free-icons'
import { mailCards, type MailState } from '@manor/client-runtime/mail'
import { mailViewShowing } from '../../mail'
import { Icon } from '../Icon'
import type { HouseNotice } from '../NoticeStack'
import { Button } from '../ui/Button'
import { NoticeCard } from '../ui/NoticeCard'
import { mailView, setMailView, useMailView } from './mailViewStore'

/** Longer than a bare confirmation, because there is an Undo to reach for. */
const UNDO_VISIBLE_MS = 6_000

/**
 * The `Archived` card in the window's notice stack, with its Undo. It stays while the
 * pointer or focus rests on it, and goes at once when the host refused the Archive: the
 * card is back then and the refusal has its own notice.
 */
export function useMailArchivedNotice(mail: MailState, unarchive: (requestId: string, threadId: string) => boolean): HouseNotice | null {
  const { archived } = useMailView()
  const [held, setHeld] = useState<string | null>(null)
  const refused = archived !== null && mail.results[archived.requestId]?.ok === false
  const paused = archived !== null && held === archived.requestId

  useEffect(() => {
    if (refused) setMailView({ archived: null })
  }, [refused])
  useEffect(() => {
    if (archived === null || paused) return
    const timer = setTimeout(() => setMailView({ archived: null }), UNDO_VISIBLE_MS)
    return () => clearTimeout(timer)
  }, [archived, paused])

  if (archived === null || refused) return null
  const { requestId, threadId } = archived
  const dismiss = () => setMailView({ archived: null })
  const undo = () => {
    // Offline nothing leaves, and the card stays up to be pressed again.
    if (!unarchive(`mail-unarchive-${crypto.randomUUID()}`, threadId)) return
    const card = mail.archived[threadId] ?? mailCards(mail).find((entry) => entry.threadId === threadId)
    const { tab, query } = mailView()
    // A tab or search that would hide the returned card gives way, so it can be seen selected.
    setMailView({ selectedId: threadId, archived: null, ...(card === undefined ? {} : mailViewShowing(card, tab, query)) })
  }
  return {
    key: `mail-${requestId}`,
    dismiss,
    node: (
      <div onPointerEnter={() => setHeld(requestId)} onPointerLeave={() => setHeld(null)}
        onFocus={() => setHeld(requestId)} onBlur={() => setHeld(null)}>
        <NoticeCard mark={<Icon icon={Archive02Icon} size={20} className="text-muted" />} title="Archived"
          action={<Button size="small" onClick={undo}>Undo</Button>} onDismiss={dismiss} />
      </div>
    ),
  }
}
