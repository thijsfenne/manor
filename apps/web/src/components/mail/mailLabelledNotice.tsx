import { Tag01Icon } from '@hugeicons/core-free-icons'
import { MAIL_LABEL_NAME, type MailLabel } from '@manor/contracts'
import { mailCards, type MailState } from '@manor/client-runtime/mail'
import { mailViewShowing } from '../../mail'
import { Icon } from '../Icon'
import type { HouseNotice } from '../NoticeStack'
import { Button } from '../ui/Button'
import { NoticeCard } from '../ui/NoticeCard'
import { mailView, setMailView, useMailView } from './mailViewStore'
import { useNoticeHold } from './useNoticeHold'

/**
 * The `Moved to …` card in the window's notice stack after a label key gave the open mail
 * another label, so a stray key never moves mail without a word. Its Undo sets the label
 * the mail had; a mail that had none gets no Undo, as no command clears a label. The next
 * move replaces it, and it stays while the pointer or focus rests on it. It goes when the
 * mail left the Inbox or got another label since, so Undo never overwrites a newer state.
 */
export function useMailLabelledNotice(mail: MailState, setLabel: (threadId: string, label: MailLabel) => boolean): HouseNotice | null {
  const { relabelled } = useMailView()
  const hold = useNoticeHold(relabelled?.id ?? null, () => setMailView({ relabelled: null }))

  const card = relabelled === null ? undefined : mailCards(mail).find((entry) => entry.threadId === relabelled.threadId)
  if (relabelled === null || card?.label !== relabelled.label) return null
  const { id, threadId, label, previous } = relabelled
  // A card on its way out, replaced by the next move, no longer acts: the notice up now is not its own.
  const replaced = () => mailView().relabelled !== relabelled
  const dismiss = () => {
    if (!replaced()) setMailView({ relabelled: null })
  }
  const undo = (back: MailLabel) => {
    // Offline nothing leaves, and the card stays up to be pressed again.
    if (replaced() || !setLabel(threadId, back)) return
    const { tab, query } = mailView()
    // A tab or search that would hide the mail under its old label gives way, so it can be seen selected.
    setMailView({ selectedId: threadId, picked: [], relabelled: null, ...mailViewShowing({ ...card, label: back }, tab, query) })
  }
  return {
    key: id,
    dismiss,
    node: (
      <div {...hold}>
        <NoticeCard mark={<Icon icon={Tag01Icon} size={20} className="text-muted" />} title={`Moved to ${MAIL_LABEL_NAME[label]}`}
          {...(previous === null ? {} : { action: <Button size="small" onClick={() => undo(previous)}>Undo</Button> })} onDismiss={dismiss} />
      </div>
    ),
  }
}
