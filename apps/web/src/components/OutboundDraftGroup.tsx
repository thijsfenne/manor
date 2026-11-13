import { useOutboundDock } from './outboundDockState'
import { ChevronDownIcon } from '@hugeicons/core-free-icons'
import { useState } from 'react'
import { plainPreview } from '@manor/client-runtime/plain-preview'
import gmailIcon from '../../../desktop/assets/Gmail_icon.svg'
import slackIcon from '../../../desktop/assets/Slack_icon.svg'
import { draftStatus, tallyDrafts, type DraftRecord, type DraftStatus } from '../state'
import { Icon } from './Icon'
import { OutboundDraftBubble, type DraftActions } from './OutboundDraftBubble'
import { Button } from './ui/Button'

interface OutboundDraftGroupProps {
  docked?: boolean
  drafts: readonly DraftRecord[]
  color: string
  connected?: boolean
  actions?: DraftActions
}

/**
 * Every draft one turn prepared. One draft is the plain bubble, exactly as before; two
 * or more become a list with a tally above it and precisely one draft unfolded at a
 * time. A list rather than a stack, because these are independent decisions taken in
 * any order and a stack hides how many are still waiting. There is deliberately no
 * "send all": one Submit is one send, and the text has been seen before it goes.
 */
export function OutboundDraftGroup({ drafts, docked = false, ...bubble }: OutboundDraftGroupProps) {
  const dock = useOutboundDock()
  if (dock !== null) drafts = drafts.filter((draft) => docked ? dock.pinned(draft) : draftStatus(draft) !== 'open')
  if (drafts.length === 0) return null
  const only = drafts.length === 1 ? drafts[0] : undefined
  if (only !== undefined) return <OutboundDraftBubble draft={only} {...bubble} />
  return <DraftList drafts={drafts} {...bubble} />
}

/**
 * Which row is unfolded. `undefined` follows the work: the first draft still open.
 * `null` is everything folded by hand. A picked row stays unfolded until it is acted
 * on, at which point the list moves on to the next open one; a settled row picked to
 * be re-read stays until it is folded again.
 */
type Choice = { draftId: string; open: boolean } | null | undefined

function DraftList({ drafts, color, connected = true, actions }: OutboundDraftGroupProps) {
  const [choice, setChoice] = useState<Choice>(undefined)
  const firstOpen = drafts.find((draft) => draftStatus(draft) === 'open')?.draftId
  const picked = choice === undefined || choice === null
    ? undefined
    : drafts.find((draft) => draft.draftId === choice.draftId)
  const unfolded =
    choice === null
      ? undefined
      : choice === undefined || picked === undefined
        ? firstOpen
        : choice.open && draftStatus(picked) !== 'open'
          ? firstOpen
          : picked.draftId

  return (
    <div className="flex w-full min-w-0 flex-col gap-1.5">
      <p className="m-0 px-0.5 text-label text-muted">{tallyLine(drafts)}</p>
      <ol className="m-0 flex list-none flex-col gap-1 p-0">
        {drafts.map((draft) => {
          const open = draft.draftId === unfolded
          const status = draftStatus(draft)
          // A thread put aside with one click gets its way back on the same row, so
          // the undo is never further away than the decision was.
          const restore = status === 'snoozed' || status === 'ignored' ? actions?.onRestore : undefined
          return (
            <li key={draft.draftId} className="flex min-w-0 flex-col">
              <div className="flex min-w-0 items-center gap-1">
                <button
                  type="button"
                  aria-expanded={open}
                  className={`group/draft flex min-h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-1.5 py-1 text-left text-[14px] [font:inherit] hover:bg-surface-2 ${
                    open ? 'text-text' : 'text-muted'
                  }`}
                  onClick={() => setChoice(open ? null : { draftId: draft.draftId, open: status === 'open' })}
                >
                  <img
                    alt=""
                    aria-hidden="true"
                    className="size-3.5 shrink-0 object-contain"
                    src={draft.channel === 'slack' ? slackIcon : gmailIcon}
                  />
                  <span className="min-w-0 shrink-0 truncate text-text" style={{ maxWidth: '38%' }}>
                    {draft.to}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{gist(draft)}</span>
                  <StatusBadge draft={draft} />
                  <span
                    className={`shrink-0 text-dim transition-transform duration-200 ease-overshoot ${open ? 'rotate-180' : ''}`}
                  >
                    <Icon icon={ChevronDownIcon} size={12} />
                  </span>
                </button>
                {restore !== undefined ? (
                  <Button
                    size="compact"
                    variant="ghost"
                    aria-label="Restore this draft"
                    disabled={!connected}
                    onClick={() => restore(draft.draftId)}
                  >
                    Restore
                  </Button>
                ) : null}
              </div>
              <div className="fold" data-open={open}>
                <div className="pt-1 pb-1">
                  <OutboundDraftBubble
                    color={color}
                    connected={connected}
                    draft={draft}
                    {...(actions === undefined ? {} : { actions })}
                  />
                </div>
              </div>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

/** The subject when there is one, else the first words of the message. */
function gist(draft: DraftRecord): string {
  const subject = draft.closed?.subject ?? draft.submission?.subject ?? draft.subject
  if (subject !== undefined && subject.trim().length > 0) return subject
  return plainPreview(draft.closed?.body ?? draft.submission?.body ?? draft.body)
}

const STATUS_LABEL: Record<DraftStatus, string> = {
  open: 'Open',
  locked: 'Sending',
  sent: 'Sent',
  saved: 'Saved',
  discarded: 'Discarded',
  snoozed: 'Later',
  ignored: 'Ignored',
}

function StatusBadge({ draft }: { draft: DraftRecord }) {
  const status = draftStatus(draft)
  const failed = status === 'open' && draft.failure !== undefined
  const uncertain = status === 'locked' && draft.submission?.status === 'uncertain'
  const tone =
    failed ? 'text-danger' : status === 'sent' ? 'text-ok' : status === 'open' ? 'text-muted' : 'text-dim'
  return (
    <span className={`shrink-0 text-label ${tone}`}>
      {failed ? 'Failed' : uncertain ? 'Uncertain' : STATUS_LABEL[status]}
    </span>
  )
}

/** "5 drafts · 2 sent · 1 discarded · 2 open", only the parts that are not zero. */
function tallyLine(drafts: readonly DraftRecord[]): string {
  const tally = tallyDrafts(drafts)
  const parts = [`${String(drafts.length)} drafts`]
  if (tally.sent > 0) parts.push(`${String(tally.sent)} sent`)
  if (tally.saved > 0) parts.push(`${String(tally.saved)} saved`)
  if (tally.locked > 0) parts.push(`${String(tally.locked)} sending`)
  if (tally.uncertain > 0) parts.push(`${String(tally.uncertain)} uncertain`)
  if (tally.discarded > 0) parts.push(`${String(tally.discarded)} discarded`)
  if (tally.snoozed > 0) parts.push(`${String(tally.snoozed)} later`)
  if (tally.ignored > 0) parts.push(`${String(tally.ignored)} ignored`)
  if (tally.open > 0) parts.push(`${String(tally.open)} open`)
  return parts.join(' · ')
}
