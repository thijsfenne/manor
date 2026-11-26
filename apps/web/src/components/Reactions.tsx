import { useState } from 'react'
import { PlusSignIcon, SmileIcon } from '@hugeicons/core-free-icons'
import { QUICK_REACTIONS, type MessageReaction } from '@manor/contracts'
import { REACTION_PALETTE, reactionAfterPick } from '@manor/client-runtime/state'
import { accentStyle } from '../accent'
import { IconButton } from './ui/IconButton'
import { Menu, useMenu } from './ui/Menu'

/**
 * The emoji on a DM bubble's bottom outer edge: left under an agent's message, right under
 * the user's. The user's own takes itself off on a press where it may; the agent's wears its accent ring.
 */
export function ReactionBadge({ reaction, color, onRemove }: {
  reaction: MessageReaction
  /** The reacting agent's accent; absent on the user's own reaction. */
  color?: string
  onRemove?: () => void
}) {
  const side = color === undefined ? 'left-3' : 'right-3'
  const className = `absolute -bottom-3 ${side} z-[1] grid h-6 min-w-6 place-items-center rounded-full border px-1 text-[14px] leading-none surface-floating shadow-popover`
  const ring = color === undefined ? 'border-line' : 'border-[color:var(--accent)]'
  if (onRemove === undefined) {
    return (
      <span className={`${className} ${ring}`} {...(color === undefined ? {} : { style: accentStyle(color) })} role="img" aria-label={`Reacted ${reaction.emoji}`}>
        {reaction.emoji}
      </span>
    )
  }
  return (
    <button type="button" className={`${className} ${ring} cursor-pointer [font:inherit] hover:bg-user-bg`} aria-label={`Remove your ${reaction.emoji} reaction`} title="Remove reaction" onClick={onRemove}>
      {reaction.emoji}
    </button>
  )
}

/** The smiley in a DM bubble's hover row: the quick row first, the fuller set one press further. */
export function ReactionButton({ current, onPick, onOpenChange }: {
  current?: MessageReaction
  onPick: (emoji: string | null) => void
  /** Keeps the hover row standing while the picker is open. */
  onOpenChange?: (open: boolean) => void
}) {
  const [more, setMore] = useState(false)
  const [menu, trigger] = useMenu({
    // Room for the fuller set too, so near the window's foot the picker opens upward.
    maxHeight: 340,
    minHeight: 340,
    minWidth: 288,
    onClose: () => { setMore(false); onOpenChange?.(false) },
  })
  const pick = (emoji: string) => {
    menu.close()
    onPick(reactionAfterPick(current, emoji))
  }
  const choice = (emoji: string) => (
    <button
      key={emoji}
      type="button"
      role="menuitemradio"
      aria-checked={current?.emoji === emoji}
      aria-label={`React ${emoji}`}
      className="grid h-9 w-9 cursor-pointer place-items-center rounded-button-sm border-0 bg-transparent text-[20px] leading-none hover:bg-user-bg focus-visible:bg-user-bg aria-checked:bg-user-bg"
      onClick={() => pick(emoji)}
    >
      {emoji}
    </button>
  )
  return (
    <>
      <IconButton
        ref={trigger}
        icon={SmileIcon}
        iconSize={14}
        size={28}
        label="React"
        selected={menu.open}
        aria-haspopup="menu"
        aria-expanded={menu.open}
        onClick={() => { if (!menu.open) onOpenChange?.(true); menu.toggle() }}
      />
      <Menu menu={menu} label="React with an emoji">
        <div className="flex items-center justify-between gap-0.5">
          {QUICK_REACTIONS.map(choice)}
          <IconButton icon={PlusSignIcon} iconSize={15} size={36} label="More emoji" selected={more} aria-expanded={more} onClick={() => setMore((open) => !open)} />
        </div>
        {more ? (
          <div className="mt-1 border-t border-line pt-1">
            {REACTION_PALETTE.map((group) => (
              <section key={group.name} aria-label={group.name}>
                <p className="m-0 px-1.5 pt-1.5 pb-0.5 text-meta text-dim">{group.name}</p>
                <div className="grid grid-cols-8">{group.emoji.map(choice)}</div>
              </section>
            ))}
          </div>
        ) : null}
      </Menu>
    </>
  )
}
