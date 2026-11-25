import { Fragment, useState, type MouseEvent, type PointerEvent } from 'react'
import { Delete02Icon, LayoutLeftIcon, PinIcon, PinOffIcon, Settings01Icon, UserMultiple02Icon } from '@hugeicons/core-free-icons'
import type { AgentConfig } from '@manor/contracts'
import { CHAT_LIST_PIN_LIMIT, chatListPins, personaOf, type ChatListRow, type SubagentGroup } from '../../state'
import { useMinuteClock } from '../../useMinuteClock'
import { Avatar } from '../Avatar'
import { DeleteChatConfirm } from '../Confirm'
import { AgentStack } from '../inbox/AgentStack'
import { Standing } from '../inbox/Standing'
import { ContextMenu, type ContextMenuItem } from '../ui/ContextMenu'
import { RoleBadge } from '../ui/RoleBadge'
import { SelectionMarker, SIDEBAR_ROW_MARKER } from '../ui/SelectionMarker'
import { useSplitDragGrab } from '../SplitDrag'
import { SubagentChildRows } from '../SubagentChildRows'

/** The faces column, so a group's stack and a DM's portrait start their text at the same x. */
const FACE_WIDTH = 48
const GROUP_FACE_SIZE = 34
const CHIEF_FACE_SIZE = 80
/** Small enough that two pinned personas share one row. */
const PINNED_FACE_SIZE = 56

interface ChatListViewProps {
  rows: ChatListRow[]
  /** The household, for the faces a group row stacks. */
  agents: AgentConfig[]
  /** False until the first directory lands, so "empty" is never guessed. */
  hasDirectory: boolean
  /** A row is only selected while a chat is what the stage is showing. */
  showChatSelection: boolean
  /**
   * The persona an unsent DM on the stage is addressed to. Its row reads as selected
   * even though no chat exists yet, because the stage is that row's.
   */
  draftAgentId: string | null
  /** DMs in a split on the stage. Each keeps a static fill; the travelling one follows focus. */
  occupiedChatIds?: ReadonlySet<string>
  /** Which row has its delete confirm up, shared with the inbox view beside it. */
  armed: string | null
  onArm: (key: string | null) => void
  onOpenChat: (chatId: string) => void
  /** A persona with no DM yet: the stage opens addressed to them, the chat waits. */
  onOpenDm: (agentId: string) => void
  /** Opens the persona form behind a row, whether or not a chat exists yet. */
  onEditAgent: (agentId: string) => void
  onEditGroup: (chatId: string) => void
  onDeleteChat: (chatId: string) => void
  /** Flips one of a persona's two pins, through the same save as her settings. */
  onSetPins: (agentId: string, pins: AgentPins) => void
  /** Delegated children by parent chat id, nested under the conversation that started them. */
  subagentGroups?: Record<string, SubagentGroup>
  /** The child whose view lies over a chat: its row is the active one, the chat's own is not. */
  activeSubagents?: Readonly<Record<string, string>>
  /** Opens a parent with one child, or the whole list (null), in its Subagents panel. */
  onOpenSubagent?: (parentChatId: string, toolCallId: string | null) => void
}

export type AgentPins = { pinned: boolean } | { railPinned: boolean }

/**
 * The two pin toggles a persona's right-click menu leads with, read off the roster
 * the way her settings read them. A full top is refused, never made room for: the
 * user picks who leaves.
 */
export function pinMenuItems(agent: AgentConfig, agents: readonly AgentConfig[], onSetPins: (agentId: string, pins: AgentPins) => void): ContextMenuItem[] {
  const pinned = agent.pinned === true
  const railPinned = agent.railPinned === true
  // Counted over the others, so unpinning and pinning again is always allowed.
  const topFull = !pinned && agents.filter((each) => each.id !== agent.id && each.pinned === true).length >= CHAT_LIST_PIN_LIMIT
  return [
    {
      label: pinned ? 'Unpin' : 'Pin to top',
      icon: pinned ? PinOffIcon : PinIcon,
      disabled: topFull,
      ...(topFull ? { hint: `Already ${CHAT_LIST_PIN_LIMIT} pinned there; unpin one first.` } : {}),
      onSelect: () => onSetPins(agent.id, { pinned: !pinned }),
    },
    { label: railPinned ? 'Remove from rail' : 'Add to rail', icon: LayoutLeftIcon, onSelect: () => onSetPins(agent.id, { railPinned: !railPinned }) },
  ]
}

/** A list row's text starts after the face column; its children line up under that text, clear of the face. */
const CHILD_INDENT = 10 + FACE_WIDTH + 6

/**
 * Everyone in the house as one messaging list: a row per persona whether or not
 * there is a conversation behind it yet, the groups mixed in, most recent first. The
 * panel's other view answers "what is still waiting for me"; this one answers "who
 * am I talking to", which is why nothing here is grouped and why a name with no
 * history still gets a row.
 */
export function ChatListView({
  rows,
  agents,
  hasDirectory,
  showChatSelection,
  draftAgentId,
  occupiedChatIds,
  armed,
  onArm,
  onOpenChat,
  onOpenDm,
  onEditAgent,
  onEditGroup,
  onDeleteChat,
  onSetPins,
  subagentGroups,
  activeSubagents,
  onOpenSubagent,
}: ChatListViewProps) {
  const now = useMinuteClock()
  // A DM drags onto the stage like a Sessions row, opening beside the DM already there.
  const grab = useSplitDragGrab()
  const occupied = (row: ChatListRow) => row.chat !== null && occupiedChatIds?.has(row.chat.id) === true
  const dragOf = (row: ChatListRow) => {
    const agentId = row.agentId
    if (grab === null || agentId === null || row.kind !== 'dm' || occupied(row)) return undefined
    return (event: PointerEvent<HTMLElement>) => grab({ kind: 'agent', agentId }, event)
  }
  // The fill a split pane gives its chat goes to the child that lies over it.
  const filled = (row: ChatListRow) => occupied(row) && (row.chat === null || activeSubagents?.[row.chat.id] === undefined)
  const shown = rows.filter((row) => row.kind !== 'pair')
  // Resolved once for the whole list rather than per row: the travelling fill is a
  // single surface, so exactly one row may claim it even if the stage somehow lights
  // a chat and a DM draft in the same frame.
  const litKey = shown.find((row) =>
    row.chat === null
      ? draftAgentId !== null && row.agentId === draftAgentId
      : showChatSelection && row.selected,
  )?.key
  // A subagent's view over the lit chat carries the travelling fill onto its row.
  const markedKey = shown.some((row) => row.key === litKey && row.chat !== null && activeSubagents?.[row.chat.id] !== undefined)
    ? undefined
    : litKey
  // Whoever the user pinned, at most two, is lifted out of the recency order and given
  // a card above it, the same shape the phone uses. Chief first, then roster order.
  const heads = chatListPins(agents).flatMap((agent) => {
    const row = shown.find((candidate) => candidate.kind === 'dm' && candidate.agentId === agent.id)
    return row === undefined ? [] : [{ agent, row }]
  })
  const headKeys = new Set(heads.map((head) => head.row.key))
  const listRows = shown.filter((row) => !headKeys.has(row.key))
  const armedRow = shown.find((row) => row.key === armed)
  const armedChatId = armedRow?.chat?.id
  const childrenOf = (row: ChatListRow, indent?: number) => {
    const chat = row.chat
    const group = chat === null ? undefined : subagentGroups?.[chat.id]
    if (chat === null || group === undefined || onOpenSubagent === undefined) return null
    return (
      <SubagentChildRows
        group={group}
        rowKey={chat.id}
        marked={row.key === litKey}
        {...(activeSubagents?.[chat.id] === undefined ? {} : { activeId: activeSubagents[chat.id] })}
        {...(indent === undefined ? {} : { indent })}
        onOpen={(toolCallId) => onOpenSubagent(chat.id, toolCallId)}
      />
    )
  }
  const renderHead = ({ agent, row }: (typeof heads)[number]) => (
    <HeadCard
      key={row.key}
      agent={agent}
      row={row}
      compact={heads.length > 1}
      selected={row.key === markedKey}
      occupied={filled(row)}
      onGrab={dragOf(row)}
      onArm={onArm}
      onOpen={() => (row.chat !== null ? onOpenChat(row.chat.id) : onOpenDm(agent.id))}
      pinItems={pinMenuItems(agent, agents, onSetPins)}
      onEditAgent={() => onEditAgent(agent.id)}
    />
  )

  return (
    <div className="pt-1">
      {!hasDirectory ? (
        <p className="m-0 px-2.5 py-2 text-[12px] text-dim">Loading the workspace…</p>
      ) : rows.length === 0 ? (
        <p className="m-0 px-2.5 py-2 text-[12px] text-dim">No personas yet</p>
      ) : shown.length === 0 ? (
        <p className="m-0 px-2.5 py-2 text-[12px] text-dim">No conversations yet</p>
      ) : (
        <>
          {heads.length === 1 ? (
            renderHead(heads[0]!)
          ) : heads.length > 1 ? (
            <div className="my-2 flex gap-1">{heads.map(renderHead)}</div>
          ) : null}
          {/* A pinned card has no text column to indent from, so its children sit at
              the list's own first level, below the card or the pair of them. */}
          {heads.map((head) => <Fragment key={head.row.key}>{childrenOf(head.row)}</Fragment>)}
          {listRows.length === 0 ? null : (
            <ul className="m-0 flex list-none flex-col gap-[2px] p-0">
              {listRows.map((row) => (
                <Fragment key={row.key}>
                <ChatRow
                  row={row}
                  agents={agents}
                  // A DM being written for the first time has no chat to be active, so
                  // the stage's own draft is what lights its row. A project draft lights
                  // nothing here: the stage has left this list entirely.
                  selected={row.key === markedKey}
                  occupied={filled(row)}
                  onGrab={dragOf(row)}
                  now={now}
                  onArm={onArm}
                  onOpenChat={onOpenChat}
                  onOpenDm={onOpenDm}
                  onEditAgent={onEditAgent}
                  onEditGroup={onEditGroup}
                  onSetPins={onSetPins}
                />
                {row.chat !== null && subagentGroups?.[row.chat.id] !== undefined ? (
                  <li className="m-0 list-none">{childrenOf(row, CHILD_INDENT)}</li>
                ) : null}
                </Fragment>
              ))}
            </ul>
          )}
        </>
      )}
      {/* Beside the list rather than in a row, so the row's drag and menu never see it. */}
      {armedRow === undefined || armedChatId === undefined ? null : (
        <DeleteChatConfirm
          title={armedRow.title}
          onConfirm={() => {
            onArm(null)
            onDeleteChat(armedChatId)
          }}
          onCancel={() => onArm(null)}
        />
      )}
    </div>
  )
}

/**
 * A pinned persona, above the list and centred under her own face; usually the
 * chief of staff, since everything unaddressed goes to her. With two pinned they
 * share the row at a smaller size.
 *
 * While her turn runs the face itself says so: it plays the working loop, the way
 * the transcript's does, and nothing else marks it. Waiting and unread standing
 * remain beside her name.
 *
 * Being lifted out of the list costs her nothing a row has: the same right-click
 * menu and the same confirm strip in the same place, because the thread behind the
 * face is an ordinary DM and the one act that can undo it must not depend on where
 * the list happens to draw its owner.
 */
function HeadCard({
  row,
  agent,
  compact,
  selected,
  occupied,
  onGrab,
  onArm,
  onOpen,
  pinItems,
  onEditAgent,
}: {
  row: ChatListRow
  agent: AgentConfig
  /** Sharing the top with pinned personas: a smaller face in an equal share of the width. */
  compact: boolean
  selected: boolean
  occupied: boolean
  onGrab: ((event: PointerEvent<HTMLElement>) => void) | undefined
  onArm: (key: string | null) => void
  onOpen: () => void
  pinItems: ContextMenuItem[]
  onEditAgent: () => void
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const { chat } = row


  return (
    <div
      className={`relative rounded-2xl ${compact ? 'min-w-0 flex-1' : 'mx-auto my-2 size-40'} ${
        selected ? 'text-text' : occupied ? 'bg-user-bg text-text' : 'text-muted hover:bg-surface-2 hover:text-text'
      } ${onGrab === undefined ? '' : 'cursor-grab'}`}
      onPointerDown={onGrab}
      onContextMenu={(event: MouseEvent<HTMLDivElement>) => {
        event.preventDefault()
        setMenu({ x: event.clientX, y: event.clientY })
      }}
    >
      {selected ? <SelectionMarker layoutId={SIDEBAR_ROW_MARKER} className="rounded-2xl" /> : null}
      <button
        type="button"
        className="relative flex size-full cursor-pointer flex-col items-center gap-0.5 rounded-2xl border-0 bg-transparent px-2.5 py-3 [font:inherit]"
        data-sidebar-section="chats"
        aria-current={selected ? 'page' : undefined}
        onClick={onOpen}
      >
        <Avatar name={agent.name} color={agent.color} src={agent.avatar} shape={agent.avatarShape} tone={agent.avatarTone} finish={agent.avatarFinish} size={compact ? PINNED_FACE_SIZE : CHIEF_FACE_SIZE} center working={row.running && !row.waiting} />
        {row.running && !row.waiting ? <span className="sr-only">Working</span> : null}
        <span className="flex max-w-full min-w-0 flex-col items-center gap-1">
          {/* The mark hangs beside the name instead of in its flow, so the name stays centred
              under the face when it comes and goes. The padding is its room on both sides,
              which keeps a long name truncating short of it. */}
          <span className={`flex max-w-full min-w-0 justify-center ${row.waiting ? 'px-[3.375rem]' : 'px-[1.375rem]'}`}>
            <span className="relative flex min-w-0">
              <span className="min-w-0 truncate text-[15px] font-medium text-text">{agent.name}</span>
              <span className="absolute left-full top-1/2 ml-1.5 flex -translate-y-1/2">
                <Standing waiting={row.waiting} unread={row.unread} running={false} lastMessageAt={null} now={0} />
              </span>
            </span>
          </span>
          {agent.role || agent.isCos ? <RoleBadge label={agent.role || 'Default agent'} /> : null}
        </span>
      </button>
      {menu === null ? null : (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={[
            ...pinItems,
            { label: 'Agent settings', icon: Settings01Icon, onSelect: onEditAgent },
            // Nothing to delete before her first message, the same as any other DM.
            ...(chat === null ? [] : [{ label: 'Delete chat', icon: Delete02Icon, tone: 'danger' as const, separatorBefore: true, onSelect: () => onArm(row.key) }]),
          ]}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}

interface ChatRowProps {
  row: ChatListRow
  agents: AgentConfig[]
  selected: boolean
  occupied: boolean
  onGrab: ((event: PointerEvent<HTMLElement>) => void) | undefined
  /** The clock the age is read against, held above so every row reads the same one. */
  now: number
  onArm: (key: string | null) => void
  onOpenChat: (chatId: string) => void
  onOpenDm: (agentId: string) => void
  onEditAgent: (agentId: string) => void
  onEditGroup: (chatId: string) => void
  onSetPins: (agentId: string, pins: AgentPins) => void
}

/**
 * One conversation, or one that has not started yet. Nothing on this row is
 * hover-only: the whole row is the button, and the acts that can undo it (delete,
 * edit the members) live on the right-click menu, which a touch device reaches with
 * a long press.
 */
function ChatRow({
  row,
  agents,
  selected,
  occupied,
  onGrab,
  now,
  onArm,
  onOpenChat,
  onOpenDm,
  onEditAgent,
  onEditGroup,
  onSetPins,
}: ChatRowProps) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const { chat } = row


  const open = () => {
    if (chat !== null) onOpenChat(chat.id)
    else if (row.agentId !== null) onOpenDm(row.agentId)
  }

  const agentId = row.agentId
  const persona = agentId === null ? null : personaOf(agents, agentId)
  // Beside the name: what she is in the house, or that this row is a room rather than
  // a person. Her own words only, never the driver she runs on: that is a runtime
  // fact, and this list is about who is being talked to.
  const agent = agentId === null ? undefined : agents.find((candidate) => candidate.id === agentId)
  const badge =
    persona === null
      ? row.kind === 'pair' ? 'View only' : 'Group'
      : agent?.role || null

  return (
    <li
      className={`group/chat-row relative rounded-xl ${
        selected ? 'text-text' : occupied ? 'bg-user-bg text-text' : 'text-muted hover:bg-surface-2 hover:text-text'
      } ${onGrab === undefined ? '' : 'cursor-grab'}`}
      onPointerDown={onGrab}
      onContextMenu={(event: MouseEvent<HTMLLIElement>) => {
        // A group with no chat behind it does not exist; a persona without one can
        // still be edited.
        if (chat === null && row.agentId === null) return
        event.preventDefault()
        setMenu({ x: event.clientX, y: event.clientY })
      }}
    >
      {selected ? <SelectionMarker layoutId={SIDEBAR_ROW_MARKER} className="rounded-xl" /> : null}
      <button
        type="button"
        className="relative flex w-full cursor-pointer items-center gap-1.5 rounded-xl border-0 bg-transparent px-2.5 py-2 text-left [font:inherit]"
        data-sidebar-section="chats"
        aria-current={selected ? 'page' : undefined}
        onClick={open}
      >
        <span className="flex flex-none justify-center" style={{ width: FACE_WIDTH }}>
          {persona !== null ? (
            <Avatar name={persona.name} color={persona.color} src={persona.avatar} shape={persona.avatarShape} tone={persona.avatarTone} finish={persona.avatarFinish} size={FACE_WIDTH} working={row.running && !row.waiting} />
          ) : (
            <AgentStack agentIds={row.agentIds} agents={agents} size={GROUP_FACE_SIZE} footprint={FACE_WIDTH} />
          )}
        </span>

        <span className="flex min-w-0 flex-1 flex-col gap-px">
          <span className="flex min-w-0 items-baseline gap-1.5">
            {/* The name gives way before the badge does: a truncated name is still
                the row you are looking for, a truncated role says nothing. */}
            <span className="min-w-0 shrink truncate text-[14px] font-medium text-text">{row.title}</span>
            {badge === null ? null : (
              <span className="min-w-0 max-w-[45%] shrink-0">
                <RoleBadge label={badge} />
              </span>
            )}
            <span className="ml-auto flex flex-none self-center pl-1">
              {/* A persona's own face plays the working loop while her turn runs, so the row
                  keeps its time. A group has no one face to move and keeps the spinner. */}
              <Standing
                waiting={row.waiting}
                unread={row.unread}
                running={row.running && persona === null}
                lastMessageAt={row.lastMessageAt}
                now={now}
              />
              {row.running && !row.waiting && persona !== null ? <span className="sr-only">Working</span> : null}
            </span>
          </span>
          {/* Reserved even when empty: a persona nobody has written to yet keeps the
              same row height as the conversation above it. */}
          <span className="min-h-[16px] truncate text-[12px] leading-4 text-dim">{row.preview}</span>
        </span>
      </button>

      {menu === null ? null : (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={[
            ...(agent === undefined ? [] : pinMenuItems(agent, agents, onSetPins)),
            ...(agentId === null ? [] : [{ label: 'Agent settings', icon: Settings01Icon, onSelect: () => onEditAgent(agentId) }]),
            ...(chat !== null && row.kind === 'group'
              ? [{ label: 'Edit members…', icon: UserMultiple02Icon, onSelect: () => onEditGroup(chat.id) }]
              : []),
            ...(chat === null ? [] : [{ label: 'Delete chat', icon: Delete02Icon, tone: 'danger' as const, separatorBefore: true, onSelect: () => onArm(row.key) }]),
          ]}
          onClose={() => setMenu(null)}
        />
      )}
    </li>
  )
}
