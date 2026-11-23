import type { RailPin } from './NavRail'
import { relativeTime } from '../relativeTime'
import { useMinuteClock } from '../useMinuteClock'
import { HoverCard } from './ui/HoverCard'
import { RoleBadge } from './ui/RoleBadge'

const WIDTH = 264

/**
 * What a pinned face's DM last said, beside the face in the rail: her name and role,
 * the line the sidebar row shows with who said it, and how long ago. A turn in flight
 * or a question for the user goes under the line, in the sidebar's words.
 */
export function RailPinPreview({
  agent,
  preview,
  fromUser,
  lastMessageAt,
  unread,
  running,
  waiting,
  anchor,
  open,
  onClose,
  onPointerEnter,
  onPointerLeave,
}: RailPin & {
  anchor: DOMRect
  open: boolean
  onClose: () => void
  onPointerEnter: () => void
  onPointerLeave: () => void
}) {
  const now = useMinuteClock()
  const speaker = fromUser === undefined ? null : fromUser ? 'You' : agent.name
  return (
    <HoverCard
      anchor={anchor}
      open={open}
      width={WIDTH}
      label={`${agent.name}, last message`}
      className="gap-1.5 p-3"
      onClose={onClose}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      <span className="flex min-w-0 items-baseline gap-1.5" data-rail-preview={agent.id}>
        <span className="min-w-0 shrink truncate text-[14px] font-medium text-text">{agent.name}</span>
        {agent.role ? (
          <span className="min-w-0 max-w-[50%] shrink-0">
            <RoleBadge label={agent.role} />
          </span>
        ) : null}
        <span className="ml-auto flex flex-none items-center gap-1.5 self-center pl-1 text-[12px] text-muted tabular-nums">
          {/* The sidebar row's unread mark, so the two never disagree about the same DM. */}
          {unread && !running && !waiting ? <span role="img" aria-label="Unread" className="block size-1.5 rounded-full bg-ok" /> : null}
          {lastMessageAt === null ? null : relativeTime(lastMessageAt, now)}
        </span>
      </span>
      {preview === '' ? (
        <p className="m-0 text-[13px] leading-[1.45] text-dim">No messages yet</p>
      ) : (
        <p className="m-0 line-clamp-3 text-[13px] leading-[1.45] text-muted [overflow-wrap:anywhere]">
          {speaker === null ? null : <span className="text-text">{speaker}: </span>}
          {preview}
        </p>
      )}
      {waiting ? (
        <span className="text-[13px] font-medium text-warn">Waiting for you</span>
      ) : running ? (
        <span className="shimmer-text text-[13px]" data-text="Working…">Working…</span>
      ) : null}
    </HoverCard>
  )
}
