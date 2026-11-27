import { useState } from 'react'
import { ArrowDown01Icon, BubbleChatIcon, SentIcon } from '@hugeicons/core-free-icons'
import { MAX_PAGE_CONTEXT_ATTACHMENTS, type AgentConfig, type Project } from '@manor/contracts'
import { AddToChatDialog } from '../AddToChatDialog'
import { Icon } from '../Icon'

/** Somewhere sources can be handed to: the chat on screen, a new one, a recent one. */
export interface ChatDestination {
  /** A chat id, or the new-chat stage's own key. */
  id: string
  /** A chat that does not exist yet: the new-chat stage, or a DM never opened. */
  kind: 'new' | 'chat'
  label: string
  /** Whose room it is, which draws its mark: an agent's face for a DM, a project's icon for its thread. */
  owner?: { agent: AgentConfig } | { project: Project }
  /** Its standing in one word, such as "Current". */
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
  onAdd: (destination: ChatDestination) => void
}

/**
 * One act with a named target. The wide half says where the sources are going and
 * sends them there; the arrow opens the Add to chat dialog with every other room, and
 * Add there sends them too rather than only re-aiming the button.
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
  onAdd,
}: AddToChatButtonProps) {
  const [open, setOpen] = useState(false)

  const empty = contextIds.length === 0
  const blocked = (destination: ChatDestination) => blockedReason(destination, contextIds)
  const target = destinations.find((destination) => blocked(destination) === undefined) ?? destinations[0] ?? null
  const targetUsable = target !== null && blocked(target) === undefined
  const height = size === 'sm' ? 'h-9' : 'h-8'

  return (
    <div className="flex-none">
      <div
        className={`flex ${height} items-stretch overflow-hidden rounded-button-sm ${
          empty || !targetUsable ? 'bg-surface-2 text-dim' : 'bg-primary text-on-primary'
        }`}
      >
        <button
          type="button"
          disabled={empty || target === null || !targetUsable}
          onClick={() => target !== null && onAdd(target)}
          title={
            empty
              ? emptyNote
              : target === null
                ? undefined
                : targetUsable
                  ? `Add to ${target.label}`
                  : `${target.label}: ${blocked(target) ?? 'unavailable'}`
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
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label="Choose which chat to add to"
          title={empty ? emptyNote : 'Choose which chat'}
          onClick={() => setOpen(true)}
          className="flex cursor-pointer items-center border-0 bg-transparent px-2 text-inherit [font:inherit] disabled:cursor-default"
        >
          <Icon icon={ArrowDown01Icon} size={13} />
        </button>
      </div>

      {/* Picks the row the wide half aims at, so the two never disagree. */}
      {!open ? null : (
        <AddToChatDialog
          targets={destinations}
          blocked={blocked}
          initialId={target?.id}
          onAdd={onAdd}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  )
}
