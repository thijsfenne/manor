import { useRef, useState } from 'react'
import { ArrowDown01Icon, BubbleChatIcon, SentIcon, Tick02Icon } from '@hugeicons/core-free-icons'
import { MAX_PAGE_CONTEXT_ATTACHMENTS } from '@manor/contracts'
import { Icon } from '../Icon'
import { Popover } from '../ui/Popover'
import { useDismiss } from '../ui/useDismiss'

/** Somewhere sources can be handed to: the chat on screen, a new one, a recent one. */
export interface ChatDestination {
  /** A chat id, or the new-chat stage's own key. */
  id: string
  /** The one that does not exist yet is a different act, and the menu separates it. */
  kind: 'new' | 'chat'
  label: string
  /** Its standing in one word, "Current chat" or the room it lives in. */
  detail?: string
  /** What is already staged there, so a target with no room left can say so. */
  usedIds: readonly string[]
  /** Why it cannot take anything at all right now. */
  unavailable?: string
}

/** Whether these sources still fit, counting the ones already staged there as free. */
export const roomFor = (destination: ChatDestination, contextIds: readonly string[]): boolean =>
  new Set([...destination.usedIds, ...contextIds]).size <= MAX_PAGE_CONTEXT_ATTACHMENTS

/**
 * Every one of them is already staged there. Sending would be a press that changes
 * nothing while looking like it did, so the row says so and the button aims elsewhere.
 */
export const alreadyHolds = (destination: ChatDestination, contextIds: readonly string[]): boolean =>
  contextIds.length > 0 && contextIds.every((id) => destination.usedIds.includes(id))

/** Why a target cannot take this handover, or undefined when it can. */
export const blockedReason = (
  destination: ChatDestination,
  contextIds: readonly string[],
): string | undefined =>
  destination.unavailable ??
  (alreadyHolds(destination, contextIds)
    ? 'Already there'
    : roomFor(destination, contextIds)
      ? undefined
      : // What is actually left there, not a flat "it is full": a chat holding two
        // refuses two more without being full, and saying so is the difference
        // between a blocked row you understand and one you argue with.
        slotsLeft(destination) === 0
        ? 'No room left'
        : slotsLeft(destination) === 1
          ? '1 slot left'
          : `${slotsLeft(destination)} slots left`)

/** How many of the target's source slots are still free. */
const slotsLeft = (destination: ChatDestination): number =>
  Math.max(0, MAX_PAGE_CONTEXT_ATTACHMENTS - new Set(destination.usedIds).size)

interface AddToChatButtonProps {
  destinations: readonly ChatDestination[]
  /** The sources this press would hand over. Empty means there is nothing to add. */
  contextIds: readonly string[]
  /** Why there is nothing to add, shown on the dead button rather than left to guess. */
  emptyNote?: string
  size?: 'sm' | 'md'
  /** Which way the menu opens. `up` for a control sitting at the foot of its surface. */
  drop?: 'down' | 'up'
  onAdd: (destination: ChatDestination) => void
}

/**
 * One act with a named target. The wide half says where the sources are going and
 * sends them there; the arrow opens the rest of the house, and picking from that list
 * sends them too rather than only re-aiming the button.
 *
 * The target is named on the face because this control navigates: pressing it leaves
 * Artifacts for the chat it names, and a button that silently picks the room you land
 * in is the thing this replaced.
 */
export function AddToChatButton({
  destinations,
  contextIds,
  emptyNote,
  size = 'md',
  drop = 'down',
  onAdd,
}: AddToChatButtonProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  useDismiss(open, () => setOpen(false), { within: [rootRef], escape: true, layoutMoved: true })

  const empty = contextIds.length === 0
  const usable = (destination: ChatDestination) => blockedReason(destination, contextIds) === undefined
  const target = destinations.find(usable) ?? destinations[0] ?? null
  const fresh = destinations.find((destination) => destination.kind === 'new')
  const existing = destinations.filter((destination) => destination.kind === 'chat')
  const targetUsable = target !== null && usable(target)
  const height = size === 'sm' ? 'h-9' : 'h-8'

  const send = (destination: ChatDestination) => {
    setOpen(false)
    onAdd(destination)
  }

  return (
    <div ref={rootRef} className="relative flex-none">
      <div
        className={`flex ${height} items-stretch overflow-hidden rounded-button-sm ${
          empty || !targetUsable ? 'bg-surface-2 text-dim' : 'bg-primary text-on-primary'
        }`}
      >
        <button
          type="button"
          disabled={empty || target === null || !targetUsable}
          onClick={() => target !== null && send(target)}
          title={
            empty
              ? emptyNote
              : target === null
                ? undefined
                : targetUsable
                  ? `Add to ${target.label}`
                  : `${target.label}: ${blockedReason(target, contextIds) ?? 'unavailable'}`
          }
          className="flex min-w-0 cursor-pointer items-center gap-1.5 border-0 bg-transparent pr-2 pl-3 text-label font-medium text-inherit [font:inherit] disabled:cursor-default"
        >
          <Icon icon={target?.kind === 'new' ? SentIcon : BubbleChatIcon} size={16} className="flex-none" />
          <span className={`truncate ${size === 'sm' ? 'max-w-[118px]' : 'max-w-[160px]'}`}>
            {target === null || empty ? 'Add to chat' : `Add to ${target.label}`}
          </span>
        </button>
        <span aria-hidden="true" className="my-1.5 w-px flex-none bg-current opacity-25" />
        <button
          type="button"
          disabled={empty}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="Choose which chat to add to"
          title={empty ? emptyNote : 'Choose which chat'}
          onClick={() => setOpen((current) => !current)}
          className="flex cursor-pointer items-center border-0 bg-transparent px-2 text-inherit [font:inherit] disabled:cursor-default"
        >
          <Icon icon={ArrowDown01Icon} size={13} />
        </button>
      </div>

      <Popover
        open={open}
        origin={drop === 'up' ? 'bottom-right' : 'top-right'}
        className={`absolute right-0 z-[9] w-[264px] rounded-xl border border-line surface-floating p-1.5 shadow-menu ${
          drop === 'up' ? 'bottom-[calc(100%+6px)]' : 'top-[calc(100%+6px)]'
        }`}
        role="menu"
        aria-label="Add these sources to"
      >
        {/* Starting one is not the same act as adding to one, so it stands on its own
            above the rooms that already exist, under the mark the sidebar starts a
            chat with. */}
        {fresh === undefined ? null : (
          <>
            <DestinationRow
              destination={fresh}
              icon={SentIcon}
              blocked={blockedReason(fresh, contextIds)}
              aimed={fresh.id === target?.id}
              onSelect={send}
            />
            {existing.length === 0 ? null : <span className="my-1.5 block h-px bg-line" aria-hidden="true" />}
          </>
        )}
        {existing.length === 0 ? null : (
          <p className="m-0 px-2 pt-0.5 pb-1 text-meta font-medium text-dim">Add to</p>
        )}
        {existing.map((destination) => (
          <DestinationRow
            key={destination.id}
            destination={destination}
            icon={BubbleChatIcon}
            blocked={blockedReason(destination, contextIds)}
            aimed={destination.id === target?.id}
            onSelect={send}
          />
        ))}
      </Popover>
    </div>
  )
}

function DestinationRow({
  destination,
  icon,
  blocked,
  aimed,
  onSelect,
}: {
  destination: ChatDestination
  icon: typeof BubbleChatIcon
  blocked: string | undefined
  /** Where the wide half of the button would send it, so the two never disagree. */
  aimed: boolean
  onSelect: (destination: ChatDestination) => void
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={blocked !== undefined}
      title={blocked}
      onClick={() => onSelect(destination)}
      className="flex w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2 py-1.5 text-left text-label text-text hover:bg-user-bg disabled:cursor-default disabled:text-dim disabled:hover:bg-transparent"
    >
      <Icon icon={icon} size={14} className="flex-none opacity-70" />
      <span className="min-w-0 flex-1 truncate">{destination.label}</span>
      {blocked !== undefined ? (
        <span className="max-w-[110px] flex-none truncate text-meta text-dim">{blocked}</span>
      ) : destination.detail !== undefined ? (
        <span className="flex-none text-meta text-dim">{destination.detail}</span>
      ) : null}
      {aimed && blocked === undefined ? (
        <Icon icon={Tick02Icon} size={13} className="flex-none" />
      ) : (
        <span className="w-[13px] flex-none" aria-hidden="true" />
      )}
    </button>
  )
}
