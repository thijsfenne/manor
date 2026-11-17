import { Fragment, useCallback, useEffect, useRef, useState, type MouseEvent, type PointerEvent, type ReactNode } from 'react'
import {
  Archive04Icon,
  ArchiveRestoreIcon,
  BubbleChatIcon,
  CheckmarkCircle02Icon,
  Delete02Icon,
  SidebarRightIcon,
  Undo02Icon,
} from '@hugeicons/core-free-icons'
import type { Variants } from 'motion/react'
import type { AgentConfig } from '@manor/contracts'
import { isArchiveExpired, type Inbox, type InboxChat, type SubagentGroup } from '../../state'
import { ProjectBadge } from '../ProjectBadge'
import { relativeTime } from '../../relativeTime'
import { useMinuteClock } from '../../useMinuteClock'
import { ConfirmStrip } from '../Confirm'
import { Icon } from '../Icon'
import { ContextMenu, type ContextMenuItem } from '../ui/ContextMenu'
import { SETTLED_LIST_VARIANTS } from '../../motion'
import { FoldChevron, FoldItem, FoldList } from '../ui/Fold'
import { SelectionMarker, SIDEBAR_ROW_MARKER } from '../ui/SelectionMarker'
import { useHoverCard } from '../ui/useHoverCard'
import { SessionMark } from './SessionMark'
import { Standing } from './Standing'
import { useSplitDragGrab } from '../SplitDrag'
import { InboxCard } from './InboxCard'
import { SubagentChildRows } from '../SubagentChildRows'
import { QUIET_PAGE_SIZE } from '@manor/client-runtime/session-overview-ui'
import { ShowMoreRow } from './ShowMoreRow'

const ROW_EXIT_MS = 140
const ROW_ENTER_MS = 180
const STATUS_MARK_SIZE = 16
/** Drag a Work row onto the stage to open it on the right. */
export const OPEN_RIGHT_LABEL = 'Open right'

type RowMotion = { chatId: string; kind: 'settle-out' | 'unsettle-in' }

/** Motion belongs to the active list only. The settled list changes quietly. */
export function inboxRowMotionClass(motion: RowMotion | null, chatId: string): string {
  if (motion?.chatId !== chatId) return ''
  return `inbox-row-${motion.kind}`
}

const reduceMotion = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

interface InboxViewProps {
  inbox: Inbox
  /** The household, for resolving the faces in a thread from the ids the chat carries. */
  agents: AgentConfig[]
  mobile?: boolean
  /** False until the first directory lands, so "empty" is never guessed. */
  hasDirectory: boolean
  /** A chat row is only selected while a chat is what the stage is showing. */
  showChatSelection: boolean
  /** Which row has its delete confirm up, shared with the projects view above. */
  armed: string | null
  onArm: (key: string | null) => void
  onOpenChat: (chatId: string) => void
  /** Desktop Work only. Absent on the phone, where one thread stays on stage. */
  onOpenRight?: (chatId: string) => void
  /** Threads already in a pane, so the menu does not offer to open them again. */
  occupiedChatIds?: ReadonlySet<string>
  onDeleteChat: (chatId: string) => void
  onSetSettled: (chatId: string, settled: boolean) => boolean
  onSetArchived: (chatId: string, archived: boolean) => boolean
  /** Keeps a peeking sidebar on screen for as long as a settled row's card is up. */
  onHoldPeek: (claim: boolean) => void
  /** A project thread has a Session running or waiting, which this list leaves out; its empty line then says so. */
  projectWorkOpen?: boolean
  /** Delegated children by parent chat id, nested under the live rows that started them. */
  subagentGroups?: Record<string, SubagentGroup>
  /** Opens a parent with one child, or the whole list (null), in its Subagents panel. */
  onOpenSubagent?: (parentChatId: string, toolCallId: string | null) => void
}

/**
 * Every chat in the house as one list, newest first, with the settled ones folded
 * away underneath. The panel's other view answers "where does this live"; this one
 * answers "what is still waiting for me", which is why nothing here is grouped by
 * project and why settling is the only act the row leads with.
 */
export function InboxView({
  inbox,
  agents,
  mobile = false,
  hasDirectory,
  showChatSelection,
  armed,
  onArm,
  onOpenChat,
  onOpenRight,
  occupiedChatIds,
  onDeleteChat,
  onSetSettled,
  onSetArchived,
  onHoldPeek,
  projectWorkOpen = false,
  subagentGroups,
  onOpenSubagent,
}: InboxViewProps) {
  // One quiet section open at a time: each fills the room the live list leaves,
  // and two splitting it left neither enough to read.
  const [quietSection, setQuietSection] = useState<'settled' | 'archived' | null>(null)
  const toggleQuiet = (section: 'settled' | 'archived') =>
    setQuietSection((open) => (open === section ? null : section))
  const [visibleSettled, setVisibleSettled] = useState(QUIET_PAGE_SIZE)
  const [visibleArchived, setVisibleArchived] = useState(QUIET_PAGE_SIZE)
  const [rowMotion, setRowMotion] = useState<RowMotion | null>(null)
  const movingChat = useRef<string | null>(null)
  const mounted = useRef(true)
  // The exit delays the write. Read the newest handler when it fires so a selection
  // changed during those 140 ms is respected rather than pulled back by stale state.
  const setSettled = useRef(onSetSettled)
  setSettled.current = onSetSettled
  const now = useMinuteClock()
  const { unsettled, settled } = inbox
  const shownSettled = settled.slice(0, visibleSettled)
  const moreSettled = settled.length - shownSettled.length
  // Split rows already have their own fill. Focus changes only the pane's wash.
  const markedChatId =
    occupiedChatIds === undefined && showChatSelection
      ? [...unsettled, ...shownSettled].find((entry) => entry.selected)?.chat.id
      : undefined

  useEffect(
    () => {
      mounted.current = true
      return () => {
        mounted.current = false
      }
    },
    [],
  )

  /**
   * Settling waits until the active row has shrunk away before writing. Unsettling
   * writes first so the active row can mount into the exact reverse motion. If the
   * sidebar disappears mid-exit the write still completes, because the click already
   * expressed the user's intent.
   */
  const moveRow = useCallback(
    (chatId: string, settled: boolean) => {
      if (movingChat.current !== null) return false
      if (reduceMotion()) return setSettled.current(chatId, settled)

      movingChat.current = chatId
      if (!settled) {
        const moved = setSettled.current(chatId, false)
        if (!moved) {
          movingChat.current = null
          return false
        }
        setRowMotion({ chatId, kind: 'unsettle-in' })
        window.setTimeout(() => {
          if (!mounted.current) return
          movingChat.current = null
          setRowMotion(null)
        }, ROW_ENTER_MS)
        return true
      }

      setRowMotion({ chatId, kind: 'settle-out' })
      window.setTimeout(() => {
        setSettled.current(chatId, true)
        if (!mounted.current) return
        movingChat.current = null
        setRowMotion(null)
      }, ROW_EXIT_MS)
      return true
    },
    [],
  )

  if (!hasDirectory) {
    return <p className="m-0 px-2.5 py-2 text-[12px] text-dim">Loading the workspace…</p>
  }

  const archived = inbox.archived.filter((entry) => {
    const archivedAt = entry.chat.archivedAt
    return archivedAt !== null && !isArchiveExpired(archivedAt, now, inbox.archiveKeepMs)
  })
  const settledOpen = quietSection === 'settled' && settled.length > 0
  const archivedOpen = quietSection === 'archived' && archived.length > 0
  const quietOpen = settledOpen || archivedOpen

  return (
    <div className={`flex h-full flex-col ${mobile ? 'pt-2' : ''}`}>
      {/* Grows while every quiet section is folded, which is what docks them at the
          bottom; gives the room up once one opens and scrolls on its own. */}
      <ul
        className={`-mx-2.5 my-0 flex min-h-0 list-none flex-col overflow-y-auto px-2.5 py-0 motion-safe:transition-[flex-grow] ${
          quietOpen ? 'grow-0 duration-[260ms] ease-arrive' : 'grow duration-200 ease-leave'
        }`}
      >
        {unsettled.length === 0 ? (
          <li className="m-0 px-3 py-2 text-[12px] text-dim">
            {settled.length === 0 ? 'No sessions yet' : projectWorkOpen ? 'Nothing else open' : 'All settled'}
          </li>
        ) : (
          unsettled.map((entry) => (
            <Fragment key={entry.chat.id}>
            <LiveRow
              entry={entry}
              agents={agents}
              selected={
                occupiedChatIds !== undefined
                  ? occupiedChatIds.has(entry.chat.id)
                  : showChatSelection && entry.selected
              }
              marked={entry.chat.id === markedChatId}
              motionClass={inboxRowMotionClass(rowMotion, entry.chat.id)}
              now={now}
              armed={armed}
              onArm={onArm}
              onOpen={onOpenChat}
              onOpenRight={onOpenRight}
              occupied={occupiedChatIds?.has(entry.chat.id) === true}
              onDelete={onDeleteChat}
              onSetSettled={moveRow}
              onSetArchived={onSetArchived}
            />
            {onOpenSubagent === undefined || subagentGroups?.[entry.chat.id] === undefined ? null : (
              <li className="m-0 list-none">
                <SubagentChildRows
                  group={subagentGroups[entry.chat.id]}
                  onOpen={(toolCallId) => onOpenSubagent(entry.chat.id, toolCallId)}
                />
              </li>
            )}
            </Fragment>
          ))
        )}
      </ul>

      {settled.length === 0 ? null : (
        <QuietSection
          label="Settled"
          count={settled.length}
          open={settledOpen}
          mobile={mobile}
          variants={SETTLED_LIST_VARIANTS}
          onToggle={() => toggleQuiet('settled')}
        >
          {shownSettled.map((entry) => (
            <QuietRow
              key={entry.chat.id}
              entry={entry}
              agents={agents}
              selected={
                occupiedChatIds !== undefined
                  ? occupiedChatIds.has(entry.chat.id)
                  : showChatSelection && entry.selected
              }
              marked={entry.chat.id === markedChatId}
              now={now}
              armed={armed}
              onArm={onArm}
              onOpen={onOpenChat}
              onOpenRight={onOpenRight}
              occupied={occupiedChatIds?.has(entry.chat.id) === true}
              onDelete={onDeleteChat}
              onSetSettled={moveRow}
              onSetArchived={onSetArchived}
              onHoldPeek={onHoldPeek}
              mode="settled"
            />
          ))}
          <ShowMoreRow
            remaining={moreSettled}
            mode="settled"
            onClick={() => setVisibleSettled((count) => count + QUIET_PAGE_SIZE)}
          />
        </QuietSection>
      )}

      {archived.length === 0 ? null : (
        <QuietSection
          label="Archived"
          count={archived.length}
          open={archivedOpen}
          mobile={mobile}
          onToggle={() => toggleQuiet('archived')}
        >
          {archived.slice(0, visibleArchived).map((entry) => (
            <QuietRow
              key={entry.chat.id}
              entry={entry}
              agents={agents}
              selected={showChatSelection && entry.selected}
              now={now}
              armed={armed}
              onArm={onArm}
              onOpen={onOpenChat}
              onDelete={onDeleteChat}
              onSetSettled={moveRow}
              onSetArchived={onSetArchived}
              onHoldPeek={onHoldPeek}
              mode="archived"
            />
          ))}
          <ShowMoreRow
            remaining={archived.length - visibleArchived}
            mode="archived"
            onClick={() => setVisibleArchived((count) => count + QUIET_PAGE_SIZE)}
          />
        </QuietSection>
      )}
    </div>
  )
}

/**
 * Settled and Archived, docked folded at the foot of the panel. Opened, a section
 * takes the room the live list leaves (never less than 40% of the panel) and scrolls
 * inside it, so history fills what is free without pushing live sessions out of view.
 * The rows sit in an absolute frame so their height never feeds the section's own
 * size; only the grow decides it, which is also what animates.
 */
function QuietSection({
  label,
  count,
  open,
  mobile,
  variants,
  onToggle,
  children,
}: {
  label: string
  count: number
  open: boolean
  mobile: boolean
  variants?: Variants
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <section
      className={`flex shrink-0 flex-col pt-3 motion-safe:transition-[flex-grow,min-height] ${
        open ? 'min-h-[40%] grow duration-[260ms] ease-arrive' : 'min-h-0 grow-0 duration-200 ease-leave'
      }`}
    >
      <button
        type="button"
        className={`flex w-full flex-none cursor-pointer items-center gap-1.5 rounded-lg border-0 bg-transparent px-2 text-left text-[12px] text-dim [font:inherit] hover:bg-surface-2 hover:text-text ${mobile ? 'h-11' : 'h-8'}`}
        aria-expanded={open}
        onClick={onToggle}
      >
        <FoldChevron open={open} />
        {/* Sized on the spans, not the button: `[font:inherit]` there outranks any
            text-size utility, so both would follow the inherited body size. */}
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{label}</span>
        <span className="flex-none text-[12px] tabular-nums">{count}</span>
      </button>

      <div className="relative min-h-0 flex-1">
        <FoldList
          open={open}
          {...(variants === undefined ? {} : { variants })}
          frameClassName="absolute inset-y-0 -inset-x-2.5"
          className="m-0 flex h-full list-none flex-col gap-0.5 overflow-y-auto px-2.5 py-0 [&>li]:shrink-0"
        >
          {children}
        </FoldList>
      </div>
    </section>
  )
}

interface RowProps {
  entry: InboxChat
  agents: AgentConfig[]
  selected: boolean
  /** True when this row is the one carrying the sidebar's travelling fill. */
  marked?: boolean
  motionClass: string
  /** The clock the age is read against, held above so every row reads the same one. */
  now: number
  armed: string | null
  onArm: (key: string | null) => void
  onOpen: (chatId: string) => void
  onOpenRight?: (chatId: string) => void
  occupied?: boolean
  onDelete: (chatId: string) => void
  onSetSettled: (chatId: string, settled: boolean) => boolean
  onSetArchived: (chatId: string, archived: boolean) => boolean
  /** The line under the title in place of the project badge, for a list already inside one project. */
  detail?: string
  /** What the row's open button is called, when "Open <title>" is not the whole story. */
  openLabel?: string
  /** The side a quiet row's hover card opens on; the sessions overview asks for the left. */
  cardSide?: 'left' | 'right'
}

/** The confirm replaces the row it belongs to, exactly as it does in a project. */
function ArmedRow({ title, onConfirm, onCancel }: { title: string; onConfirm: () => void; onCancel: () => void }) {
  return (
    <li className="flex items-center gap-0.5 rounded-lg pr-1">
      <ConfirmStrip question={`Delete “${title}” and all messages?`} onConfirm={onConfirm} onCancel={onCancel} />
    </li>
  )
}

/** Right-click is the only way into a row's menu. The hover card yields at once. */
function openChatMenu(
  event: MouseEvent,
  open: (position: { x: number; y: number }) => void,
  dismissHover?: () => void,
) {
  event.preventDefault()
  dismissHover?.()
  open({ x: event.clientX, y: event.clientY })
}

/** The acts every live or settled inbox row offers on right-click. */
export const inboxRowMenu = (
  act: 'Settle' | 'Unsettle',
  onSetSettled: () => void,
  onArchive: () => void,
  onArmDelete: () => void,
  onOpenRight?: () => void,
): ContextMenuItem[] => [
  ...(onOpenRight === undefined
    ? []
    : [{ label: OPEN_RIGHT_LABEL, icon: SidebarRightIcon, onSelect: onOpenRight }]),
  { label: 'Archive Session', icon: Archive04Icon, onSelect: onArchive },
  { label: act, icon: act === 'Settle' ? CheckmarkCircle02Icon : Undo02Icon, onSelect: onSetSettled },
  { label: 'Delete Session', icon: Delete02Icon, tone: 'danger', onSelect: onArmDelete },
]

/**
 * A chat still wanted: room above, conversation below, who is in it and where it
 * stands on the right. The state at rest crossfades into the one act the row exists
 * for, in the same slot, so nothing moves under the pointer.
 */
export function LiveRow({
  entry,
  agents,
  selected,
  marked = false,
  motionClass,
  now,
  armed,
  onArm,
  onOpen,
  onOpenRight,
  occupied = false,
  onDelete,
  onSetSettled,
  onSetArchived,
  detail,
  openLabel,
}: RowProps) {
  const { chat, projectName, projectColor, unread, running, waiting } = entry
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const key = `chat:${chat.id}`
  const standingWidth = waiting ? 'w-14' : running || unread ? 'w-4' : 'w-7'
  const grab = useSplitDragGrab()
  const canDrag = grab !== null && onOpenRight !== undefined && !occupied

  if (armed === key) {
    return (
      <ArmedRow
        title={chat.title}
        onConfirm={() => {
          onArm(null)
          onDelete(chat.id)
        }}
        onCancel={() => onArm(null)}
      />
    )
  }

  return (
    <li
      // The clip belongs to the settle animation, not to the row: at rest it would
      // also clip the travelling fill to whichever row it is landing in, so the
      // marker appeared in place instead of moving there.
      className={`group/chat-row relative mb-1 grid grid-rows-[1fr] rounded-lg last:mb-0 ${
        motionClass === '' ? '' : 'overflow-hidden'
      } ${motionClass} ${
        selected
          ? `text-text ${marked ? '' : 'bg-user-bg'}`
          : 'text-muted hover:bg-surface-2 hover:text-text'
      } ${canDrag ? 'cursor-grab' : ''}`}
      data-split-drag={canDrag ? '' : undefined}
      onPointerDown={canDrag ? (event: PointerEvent<HTMLLIElement>) => grab({ kind: 'chat', chatId: chat.id }, event) : undefined}
      onContextMenu={(event: MouseEvent<HTMLLIElement>) => openChatMenu(event, setMenu)}
    >
      {marked ? <SelectionMarker layoutId={SIDEBAR_ROW_MARKER} className="rounded-lg" /> : null}

      {/* The whole row opens the chat, and it does so from underneath: the settle
          control sits on the first line beside the status it replaces, and a button
          cannot live inside a button. Everything above this is pointer-transparent
          except that one control. */}
      <button
        type="button"
        className="absolute inset-0 z-0 w-full cursor-pointer rounded-lg border-0 bg-transparent [font:inherit]"
        aria-label={openLabel ?? `Open ${chat.title}`}
        data-sidebar-section="unsettled"
        aria-current={selected ? 'page' : undefined}
        onClick={() => onOpen(chat.id)}
      />

      {/* The conversation leads; its room follows as quieter wayfinding. */}
      <div className="inbox-row-body pointer-events-none relative z-[1] flex min-h-0 flex-col gap-1 overflow-hidden px-3 py-1.5">
        <div className="relative flex min-w-0 items-center gap-1.5 text-[14px] text-inherit">
          <span className="min-w-0 flex-1 truncate">{chat.title}</span>

          {/* The slot only reserves what its resting state needs, then grows to fit
              both actions on hover. Long titles therefore keep the unused space. */}
          <span
            className={`relative h-5 flex-none duration-150 ease-arrive ${standingWidth} group-hover/chat-row:w-14 group-focus-within/chat-row:w-14 [@media(hover:none)]:w-14 motion-safe:transition-[width]`}
          >
            <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center justify-end text-right duration-150 ease-fade group-hover/chat-row:opacity-0 group-focus-within/chat-row:opacity-0 [@media(hover:none)]:opacity-0 motion-safe:transition-opacity">
              <Standing
                waiting={waiting}
                unread={unread}
                running={running}
                lastMessageAt={chat.lastMessageAt}
                now={now}
              />
            </span>

            {/* Archive is the right-click menu's and the hover card's, never a one-click
                button here: a stray click on it once archived an open Session. The
                settle control keeps the slot's right edge, where it already sat. */}
            <span className="pointer-events-none absolute top-1/2 -right-1.5 flex h-11 w-14 -translate-y-1/2 items-center justify-end text-muted opacity-0 duration-150 ease-fade group-hover/chat-row:opacity-100 group-focus-within/chat-row:opacity-100 [@media(hover:none)]:opacity-100 motion-safe:transition-opacity">
              <button
                type="button"
                className="pointer-events-auto grid h-11 w-7 cursor-pointer place-items-center border-0 bg-transparent text-inherit [font:inherit] hover:text-text"
                title={`Settle ${chat.title}`}
                aria-label={`Settle ${chat.title}`}
                onClick={() => onSetSettled(chat.id, true)}
              >
                <Icon className="block size-4 flex-none" icon={CheckmarkCircle02Icon} size={STATUS_MARK_SIZE} />
              </button>
            </span>
          </span>
        </div>

        <div className="flex min-w-0 items-center gap-1.5 text-[13px] text-dim">
          {detail === undefined ? (
            <>
              <ProjectBadge name={projectName} icon={entry.projectIcon} color={projectColor} noProject={entry.noProject} />
              {entry.viaThread === true ? <span className="min-w-0 truncate text-[12px] text-dim">via project thread</span> : null}
            </>
          ) : (
            <span className="min-w-0 truncate text-[13px] text-dim">{detail}</span>
          )}
          <span className="min-w-0 flex-1" />
          <SessionMark chat={chat} agents={agents} onOpen={() => onOpen(chat.id)} />
        </div>
      </div>

      {menu === null ? null : (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={inboxRowMenu(
            'Settle',
            () => onSetSettled(chat.id, true),
            () => onSetArchived(chat.id, true),
            () => onArm(key),
            occupied || onOpenRight === undefined ? undefined : () => onOpenRight(chat.id),
          )}
          onClose={() => setMenu(null)}
        />
      )}
    </li>
  )
}

/**
 * A chat that has been dealt with: one quiet line, and everything the live row shows
 * in two moved into the card that opens beside it. Compact on purpose, because this
 * list is history and history should not cost as much room as work. Settled and
 * archived wear the same row; only the hover act and the card's actions differ.
 */
export function QuietRow({
  entry,
  agents,
  selected,
  marked = false,
  now,
  armed,
  onArm,
  onOpen,
  onOpenRight,
  occupied = false,
  onDelete,
  onSetSettled,
  onSetArchived,
  onHoldPeek,
  cardSide,
  openLabel,
  mode,
}: Omit<RowProps, 'motionClass'> & {
  onHoldPeek: (claim: boolean) => void
  mode: 'settled' | 'archived'
}) {
  const { chat } = entry
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const {
    anchorRef: rowRef,
    card,
    show: showCard,
    hide: hideCard,
    dismiss: dismissCard,
    scheduleShow,
    scheduleHide,
  } = useHoverCard<HTMLLIElement>({ onHoldPeek, suspended: menu !== null })
  const key = `chat:${chat.id}`
  const archived = mode === 'archived'

  if (armed === key) {
    return (
      <ArmedRow
        title={chat.title}
        onConfirm={() => {
          onArm(null)
          onDelete(chat.id)
        }}
        onCancel={() => onArm(null)}
      />
    )
  }

  return (
    <FoldItem
      ref={rowRef}
      className={`group/chat-row relative flex h-8 items-center rounded-lg ${
        selected
          ? `text-text ${marked ? '' : 'bg-user-bg'}`
          : 'text-dim hover:bg-surface-2 hover:text-muted'
      }`}
      onContextMenu={(event: MouseEvent<HTMLLIElement>) => openChatMenu(event, setMenu, dismissCard)}
      onPointerDown={(event) => {
        if (event.button === 2) dismissCard()
      }}
      onPointerEnter={scheduleShow}
      onPointerLeave={scheduleHide}
    >
      {marked ? <SelectionMarker layoutId={SIDEBAR_ROW_MARKER} className="rounded-lg" /> : null}
      <button
        type="button"
        className="relative flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg border-0 bg-transparent pr-10 pl-3 text-left text-[13px] text-inherit [font:inherit]"
        data-sidebar-section={mode === 'settled' ? 'settled' : undefined}
        {...(openLabel === undefined ? {} : { 'aria-label': openLabel })}
        aria-current={selected ? 'page' : undefined}
        onClick={() => onOpen(chat.id)}
      >
        <Icon className="flex-none" icon={BubbleChatIcon} size={13} />
        {/* Sized here, not on the button: `[font:inherit]` there outranks a text
            utility, so the title would fall back to the 16px body size. */}
        <span className={`min-w-0 flex-1 truncate ${archived ? 'text-[15px]' : 'text-[14px]'}`}>
          {chat.title}
        </span>
      </button>

      <span
        className={`pointer-events-none absolute right-3 text-[12px] tabular-nums duration-150 ease-fade [@media(hover:none)]:opacity-0 motion-safe:transition-opacity ${
          archived ? '' : 'group-hover/chat-row:opacity-0 group-focus-within/chat-row:opacity-0'
        }`}
      >
        {relativeTime(chat.lastMessageAt, now)}
      </span>

      {archived ? null : (
        <button
          type="button"
          className="absolute top-1/2 right-1 grid h-7 w-7 -translate-y-1/2 cursor-pointer place-items-center rounded-button-sm border-0 bg-transparent text-muted opacity-0 duration-150 ease-fade [font:inherit] hover:bg-bg hover:text-text group-hover/chat-row:opacity-100 group-focus-within/chat-row:opacity-100 [@media(hover:none)]:opacity-100 motion-safe:transition-opacity"
          title={`Unsettle ${chat.title}`}
          aria-label={`Unsettle ${chat.title}`}
          onClick={() => onSetSettled(chat.id, false)}
        >
          <Icon icon={Undo02Icon} size={13} />
        </button>
      )}

      {card === null ? null : (
        <InboxCard
          title={chat.title}
          projectName={entry.projectName}
          projectIcon={entry.projectIcon}
          projectColor={entry.projectColor}
          noProject={entry.noProject}
          agentIds={chat.agentIds}
          agents={agents}
          lastMessageAt={chat.lastMessageAt}
          {...(chat.mode === 'single' && chat.singleOverride !== undefined ? { single: chat.singleOverride } : {})}
          actions={
            archived
              ? [
                  {
                    kind: 'restore',
                    onSelect: () => {
                      dismissCard()
                      onSetArchived(chat.id, false)
                    },
                  },
                  {
                    kind: 'delete',
                    onSelect: () => {
                      dismissCard()
                      onArm(key)
                    },
                  },
                ]
              : [
                  {
                    kind: 'archive',
                    onSelect: () => {
                      dismissCard()
                      onSetArchived(chat.id, true)
                    },
                  },
                  {
                    kind: 'delete',
                    onSelect: () => {
                      dismissCard()
                      onArm(key)
                    },
                  },
                ]
          }
          {...(cardSide === undefined ? {} : { side: cardSide })}
          anchor={card.anchor}
          open={card.open}
          onClose={hideCard}
          onPointerEnter={showCard}
          onPointerLeave={scheduleHide}
        />
      )}

      {menu === null ? null : (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={
            archived
              ? [
                  { label: 'Restore Session', icon: ArchiveRestoreIcon, onSelect: () => onSetArchived(chat.id, false) },
                  { label: 'Delete Session', icon: Delete02Icon, tone: 'danger', onSelect: () => onArm(key) },
                ]
              : inboxRowMenu(
                  'Unsettle',
                  () => onSetSettled(chat.id, false),
                  () => onSetArchived(chat.id, true),
                  () => onArm(key),
                  occupied || onOpenRight === undefined ? undefined : () => onOpenRight(chat.id),
                )
          }
          onClose={() => setMenu(null)}
        />
      )}
    </FoldItem>
  )
}
