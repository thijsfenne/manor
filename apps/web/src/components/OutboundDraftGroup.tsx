import { useState } from 'react'
import { draftStatus, tallyDrafts, type DraftRecord } from '../state'
import { OutboundDraftBubble, type DraftActions } from './OutboundDraftBubble'

interface OutboundDraftGroupProps {
  drafts: readonly DraftRecord[]
  color: string
  connected?: boolean
  actions?: DraftActions
  /** A DM caps the card at the agent bubble's width; elsewhere it spans the column. */
  bubble?: boolean
}

/**
 * Every draft one turn prepared, in the turn. One draft is the plain card; two or more
 * stack with a tally above them and precisely one card unfolded at a time. A stack of
 * headers rather than one card, because these are independent decisions taken in any
 * order and the reader needs to see how many still wait. There is deliberately no
 * "send all": one Send is one send, and the text has been seen before it goes.
 */
export function OutboundDraftGroup({ drafts, bubble = false, ...card }: OutboundDraftGroupProps) {
  if (drafts.length === 0) return null
  const only = drafts.length === 1 ? drafts[0] : undefined
  return (
    <div className={bubble ? 'w-full max-w-[80%] min-w-0' : 'w-full min-w-0'}>
      {only !== undefined ? <OutboundDraftBubble draft={only} {...card} /> : <DraftList drafts={drafts} {...card} />}
    </div>
  )
}

/**
 * Which card is unfolded. `undefined` follows the work: the first draft still open.
 * `null` is everything folded by hand. A picked card stays unfolded until it is acted
 * on, at which point the list moves on to the next open one; a settled card picked to
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
    <div className="flex w-full min-w-0 flex-col gap-2">
      <p className="m-0 px-0.5 text-label text-muted">{tallyLine(drafts)}</p>
      {drafts.map((draft) => {
        const open = draft.draftId === unfolded
        return (
          <OutboundDraftBubble
            key={draft.draftId}
            color={color}
            connected={connected}
            draft={draft}
            unfolded={open}
            onToggle={() => setChoice(open ? null : { draftId: draft.draftId, open: draftStatus(draft) === 'open' })}
            {...(actions === undefined ? {} : { actions })}
          />
        )
      })}
    </div>
  )
}

/** "5 drafts, 2 sent, 1 discarded, 2 open", only the parts that are not zero. */
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
  return parts.join(', ')
}
