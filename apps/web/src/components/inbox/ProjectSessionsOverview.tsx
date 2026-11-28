import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { projectLettersField } from '../../projectAppearance'
import { QUIET_PAGE_SIZE, readSessionOverviewUI, subscribeSessionOverviewUI, toggleSessionOverviewSection, updateSessionOverviewUI, type SessionOverviewSection } from '@manor/client-runtime/session-overview-ui'
import { createPortal } from 'react-dom'
import type { IconSvgElement } from '@hugeicons/react'
import { AlertCircleIcon, Archive02Icon, CheckListIcon, CheckmarkCircle02Icon, CircleCheckIcon, HourglassIcon, Progress03Icon, Undo02Icon } from '@hugeicons/core-free-icons'
import { DEFAULT_PROJECT_COLOR, DEFAULT_PROJECT_ICON, type AgentConfig, type Project } from '@manor/contracts'
import { isArchiveExpired, type SessionOverview, type SessionOverviewRow } from '../../state'
import { useMinuteClock } from '../../useMinuteClock'
import { DeleteChatConfirm } from '../Confirm'
import { Icon } from '../Icon'
import { Fold, FoldChevron } from '../ui/Fold'
import { IconButton } from '../ui/IconButton'
import { Popover } from '../ui/Popover'
import { useDismiss } from '../ui/useDismiss'
import { usePopupPlacement } from '../ui/usePopupPlacement'
import { Standing } from './Standing'
import { LiveRow, QuietRow } from './InboxView'
import { ShowMoreRow } from './ShowMoreRow'

interface ProjectSessionsOverviewProps {
  threadId: string
  overview: SessionOverview
  /** Resolves a Multiple session's faces, the way the sidebar card does. */
  agents: AgentConfig[]
  /** Opens the session beside the thread, or on the stage where no split fits. */
  onOpen: (chatId: string) => void
  /** Brings a proposal's card into view in the thread, where its Accept is. */
  onRevealProposal: (rowKey: string) => void
  /** How an open row reads to a screen reader: "on the right" in the split. */
  openLabel: (title: string) => string
  /** The same settle the sidebar and the session header use; true when it went out. */
  onSetSettled: (chatId: string, settled: boolean) => boolean
  /** The sidebar's archive and delete, which its rows and hover card offer too. */
  onSetArchived: (chatId: string, archived: boolean) => boolean
  onDeleteChat: (chatId: string) => void
  /** The thread's project, which the rows' hover card names. */
  project: Pick<Project, 'name' | 'icon' | 'color' | 'repoIconSrc' | 'letters'> | undefined
  /** The popover's tighter gutters; the pane keeps the transcript's. */
  compact?: boolean
  /**
   * Asks about a delete outside the overview. The popover sets it: a modal cannot sit
   * above the popover, so the popover closes and its door asks instead.
   */
  onAskDelete?: (chat: { id: string; title: string }) => void
}

// Each fold leads with its state's mark: only the two live states carry colour, and a fold
// with no rows drops to dim like the quiet ones. Waiting and Archived show only with rows.
const GROUPS: { id: SessionOverviewSection; label: string; hint?: string; icon: IconSvgElement; tone: string }[] = [
  { id: 'waiting', label: 'Needs you', hint: 'Proposals, questions, reviews and results to confirm.', icon: AlertCircleIcon, tone: 'text-warn' },
  { id: 'working', label: 'Working', icon: Progress03Icon, tone: 'text-busy' },
  { id: 'background', label: 'Waiting', hint: 'Sessions waiting on background work they started.', icon: HourglassIcon, tone: 'text-muted' },
  { id: 'settled', label: 'Settled', icon: CircleCheckIcon, tone: 'text-dim' },
  { id: 'archived', label: 'Archived', icon: Archive02Icon, tone: 'text-dim' },
]

/** A fold's mark carries its colour only with rows, and Working only while one of them runs. */
const lit = (id: SessionOverviewSection, rows: readonly SessionOverviewRow[]) =>
  id === 'working' ? rows.some((row) => row.status === 'working') : rows.length > 0

/**
 * A project thread's sessions (decided 2026-10-10, grouped 2026-10-11): the right pane
 * beside the thread, or the header toggle's popover where the window is too narrow to
 * split. Three folds with a count, Settled folded by default, so the thread can be read
 * without opening every session. Settled holds only settled Sessions; one gone quiet without
 * a result stays under Working with the circle check (2026-11-28). Waiting joins them only while a Session waits on
 * background work it started (2026-11-18). A project with no Session yet shows one quiet line
 * instead of folds counting zero. Each row settles or unsettles in place. Archived sits
 * folded at the foot, only while it has rows: the sidebar's list leaves a thread's
 * sessions out, so this is where one archived by mistake comes back.
 */
export function ProjectSessionsOverview({ threadId, overview, agents, onOpen, onRevealProposal, openLabel, onSetSettled, onSetArchived, onDeleteChat, project, compact = false, onAskDelete }: ProjectSessionsOverviewProps) {
  const read = () => readSessionOverviewUI(threadId)
  const { open, visibleSettled, visibleArchived } = useSyncExternalStore(subscribeSessionOverviewUI, read, read)
  const now = useMinuteClock()
  // The chat whose delete question is up, as in the sidebar.
  const [armed, setArmed] = useState<{ id: string; title: string } | null>(null)
  const askDelete = onAskDelete ?? setArmed
  const gutter = compact ? 'px-1.5' : 'px-1'
  // Past its restore window a row is as good as gone, and the hourly sweep deletes it.
  const archived = overview.archived.filter((row) => row.chat?.archivedAt != null && !isArchiveExpired(row.chat.archivedAt, now, overview.archiveKeepMs))
  const empty = overview.waiting.length + overview.working.length + overview.background.length + overview.settled.length + archived.length === 0

  return (
    <div className={`flex min-h-0 min-w-0 flex-col overflow-y-auto ${gutter} ${compact ? 'max-h-[min(520px,70vh)] py-1.5' : 'h-full pt-2 pb-4'}`}>
      {empty ? <p className="m-0 px-3 py-1.5 text-[13px] text-dim">No Sessions yet. A proposal you accept in the thread starts one.</p> : null}
      {empty ? null : GROUPS.map(({ id, label, hint, icon, tone }) => {
        const rows = id === 'archived' ? archived : overview[id]
        if ((id === 'archived' || id === 'background') && rows.length === 0) return null
        const shown = id === 'settled' ? rows.slice(0, visibleSettled) : id === 'archived' ? rows.slice(0, visibleArchived) : rows
        return (
          <section key={id} aria-label={label} className="flex flex-none flex-col pb-2">
            <button
              type="button"
              className="flex h-8 w-full flex-none cursor-pointer items-center gap-1.5 rounded-lg border-0 bg-surface-2/50 px-2 text-left text-dim [font:inherit] hover:bg-surface-2 hover:text-text"
              aria-expanded={open[id]}
              onClick={() => updateSessionOverviewUI(threadId, (current) => toggleSessionOverviewSection(current, id))}
            >
              <Icon icon={icon} size={14} className={`flex-none ${lit(id, rows) ? tone : 'text-dim'}`} />
              {/* Sized on the spans: `[font:inherit]` on the button outranks a text-size utility there. */}
              <span className="min-w-0 truncate text-[12px] font-medium">{label}</span>
              <span className="flex-1 text-[12px] text-dim tabular-nums">{rows.length}</span>
              <FoldChevron open={open[id]} />
            </button>
            <Fold open={open[id]}>
              {rows.length === 0 ? (
                hint === undefined ? null : <p className="m-0 px-3 pt-1.5 pb-1 text-[13px] text-dim">{hint}</p>
              ) : (
                <ul className="m-0 flex list-none flex-col gap-0.5 p-0 pt-1.5">
                  {shown.map((row) => {
                    if (row.chat === null) return <ProposalRow key={row.key} row={row} now={now} onReveal={onRevealProposal} />
                    // The sidebar's own rows: live ones with Archive and Settle, settled ones
                    // as a quiet line whose card opens to the left, away from the right pane's edge.
                    // The fold's header already says running or waiting, so the row keeps only unread and age,
                    // and a Working row's age ("now", always) gives way to its tasks progress, with no unread dot: the fold already says it works.
                    // A Waiting row's detail is what it waits on (`SessionOverviewRow.line`).
                    const entry = {
                      chat: row.chat, selected: false, unread: row.unread, running: false, waiting: false,
                      projectName: project?.name ?? '', projectIcon: project?.icon ?? DEFAULT_PROJECT_ICON,
                      ...(project?.repoIconSrc === undefined ? {} : { projectIconSrc: project.repoIconSrc }), ...projectLettersField(project), projectColor: project?.color ?? DEFAULT_PROJECT_COLOR,
                    }
                    const chat = row.chat
                    const shared = {
                      entry, agents, selected: false, now, onArm: () => askDelete({ id: chat.id, title: chat.title }), onOpen,
                      onSetSettled, onSetArchived, openLabel: openLabel(row.title),
                    }
                    return id === 'archived' || id === 'settled'
                      ? <QuietRow key={row.key} {...shared} cardSide="left" mode={id} onHoldPeek={noHold} />
                      : <LiveRow key={row.key} {...shared} motionClass="" detail={row.line} {...(row.status === 'done' ? { done: true } : id === 'working' ? { plan: row.chat.planProgress ?? null } : {})} />
                  })}
                  {id !== 'settled' && id !== 'archived' ? null : (
                    <ShowMoreRow
                      mode={id}
                      remaining={rows.length - shown.length}
                      onClick={() => updateSessionOverviewUI(threadId, (current) => id === 'settled'
                        ? { ...current, visibleSettled: current.visibleSettled + QUIET_PAGE_SIZE }
                        : { ...current, visibleArchived: current.visibleArchived + QUIET_PAGE_SIZE })}
                    />
                  )}
                </ul>
              )}
            </Fold>
          </section>
        )
      })}
      {armed === null ? null : (
        <DeleteChatConfirm
          title={armed.title}
          onConfirm={() => {
            setArmed(null)
            onDeleteChat(armed.id)
          }}
          onCancel={() => setArmed(null)}
        />
      )}
    </div>
  )
}

const noHold = () => undefined

/** A proposal has no session yet: its row leads to the card in the thread, where Accept is. */
function ProposalRow({ row, now, onReveal }: { row: SessionOverviewRow; now: number; onReveal: (rowKey: string) => void }) {
  return (
    <li className="relative m-0 min-w-0 rounded-lg text-muted hover:bg-surface-2 hover:text-text focus-within:bg-surface-2">
      <button
        type="button"
        className="absolute inset-0 z-0 w-full cursor-pointer rounded-lg border-0 bg-transparent [font:inherit] outline-none"
        aria-label={`Show proposal ${row.title}`}
        onClick={() => onReveal(row.key)}
      />
      <div className="pointer-events-none relative z-[1] flex min-w-0 flex-col gap-1 px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-[14px] text-text">{row.title}</span>
          <span className="flex h-5 flex-none items-center">
            <Standing waiting={false} unread={false} running={false} lastMessageAt={row.at} now={now} />
          </span>
        </div>
        {row.line === '' ? null : <span className="min-w-0 truncate text-[13px] text-dim">{row.line}</span>}
      </div>
    </li>
  )
}

/**
 * Settle and its way back from one control, wearing the sidebar's two glyphs: the
 * check circle settles a live session, the undo arrow puts a settled one back in its
 * live group. The session header uses it; the overview rows wear the sidebar's own.
 */
export function SettleButton({ settled, size, onToggle }: {
  settled: boolean
  size?: number
  onToggle: () => void
}) {
  return (
    <IconButton
      icon={settled ? Undo02Icon : CheckmarkCircle02Icon}
      iconSize={16}
      {...(size === undefined ? {} : { size })}
      swapKey={settled ? 'settled' : 'live'}
      label={settled ? 'Unsettle' : 'Settle'}
      onClick={onToggle}
    />
  )
}

/** How long the pointer rests on the door before the overview peeks, and how long it may stray before it leaves. */
const PEEK_OPEN_MS = 200
const PEEK_CLOSE_MS = 160
const ROW_OVERLAY = '[data-hover-card], [role="menu"]'

/**
 * The project thread's header toggle for its sessions side. Beside a split it shows or
 * hides the right pane (`onToggle`); where no split fits it opens the overview as a
 * popover instead, and a pick there opens the session on the stage. While the side is
 * closed, resting the pointer on the door peeks the same popover (2026-10-12);
 * a click on it pins it open, and the pointer leaving the door, the popover and a row's
 * hover card closes an unpinned one.
 */
export function SessionsOverviewDoor({
  threadId,
  shown,
  onToggle,
  overview,
  agents,
  onOpen,
  onRevealProposal,
  onSetSettled,
  onSetArchived,
  onDeleteChat,
  project,
  size,
}: {
  threadId: string
  /** The sessions side is on screen beside the thread. */
  shown: boolean
  /** Present while a split fits: the toggle drives the pane. */
  onToggle?: () => void
  overview: SessionOverview
  agents: AgentConfig[]
  onOpen: (chatId: string) => void
  onRevealProposal: (rowKey: string) => void
  onSetSettled: (chatId: string, settled: boolean) => boolean
  onSetArchived: (chatId: string, archived: boolean) => boolean
  onDeleteChat: (chatId: string) => void
  project: Pick<Project, 'name' | 'icon' | 'color' | 'repoIconSrc' | 'letters'> | undefined
  /** The phone header's 44px touch target. */
  size?: number
}) {
  const trigger = useRef<HTMLButtonElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [asking, setAsking] = useState<{ id: string; title: string } | null>(null)
  // A peek follows the pointer; a pin (a click in popover mode) stays until dismissed.
  const [pinned, setPinned] = useState(false)
  const peekTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const close = useCallback((refocus = true) => {
    clearTimeout(peekTimer.current)
    setOpen(false)
    setPinned(false)
    if (refocus) trigger.current?.focus()
  }, [])
  const popover = onToggle === undefined
  const placement = usePopupPlacement({ open, triggerRef: trigger, maxHeight: 520, minHeight: 160, minWidth: 340, align: 'end' })
  // A row's hover card and right-click menu portal to the body, outside `popup`, but a press on
  // their actions is still a press inside the overview. One of them is up at a time.
  const rowOverlay = { get current() { return document.querySelector<HTMLElement>(ROW_OVERLAY) } }
  // Escape returns focus to the door only when it was inside the overview; a peek must not steal the composer's.
  const escape = () => close(popup.current?.contains(document.activeElement) === true || document.activeElement === trigger.current)
  useDismiss(open, () => close(false), { within: [trigger, popup, rowOverlay], onEscape: escape, layoutMoved: true })
  const lit = popover ? open : shown
  // Beside the split the pane is the overview; peeking is for when it is closed.
  const canPeek = popover ? !open : !shown

  useEffect(() => {
    if (shown && !popover) close(false)
  }, [shown, popover, close])

  // An unpinned peek leaves once the pointer is off the door, the popover and the card.
  useEffect(() => {
    if (!open || pinned) return
    let leave: ReturnType<typeof setTimeout> | undefined
    const onMove = (event: PointerEvent) => {
      const inside = [trigger.current, popup.current, document.querySelector(ROW_OVERLAY)]
        .some((node) => node?.contains(event.target as Node) === true)
      if (inside) {
        clearTimeout(leave)
        leave = undefined
      } else leave ??= setTimeout(() => close(false), PEEK_CLOSE_MS)
    }
    document.addEventListener('pointermove', onMove)
    return () => {
      clearTimeout(leave)
      document.removeEventListener('pointermove', onMove)
    }
  }, [open, pinned, close])

  return (
    <>
      {/* Named by its word, at the far right of the header (2026-10-11): bare at
          rest, lit like a panel door while hovered or while the sessions side is open. */}
      <button
        ref={trigger}
        type="button"
        className={`flex h-8 flex-none cursor-pointer items-center gap-1.5 rounded-button border-0 px-2.5 [font:inherit] hover:bg-icon-fill hover:text-text ${
          lit ? 'bg-icon-fill text-text' : 'bg-transparent text-muted'
        }`}
        {...(size === undefined ? {} : { style: { height: size } })}
        title={lit ? 'Hide overview' : 'Show overview'}
        aria-expanded={lit}
        aria-haspopup="dialog"
        onPointerEnter={(event) => {
          // Touch has no hover, so only a mouse peeks.
          if (event.pointerType !== 'mouse' || !canPeek) return
          clearTimeout(peekTimer.current)
          peekTimer.current = setTimeout(() => setOpen(true), PEEK_OPEN_MS)
        }}
        onPointerLeave={() => clearTimeout(peekTimer.current)}
        onClick={() => {
          clearTimeout(peekTimer.current)
          if (!popover) {
            close(false)
            onToggle()
          } else if (open && pinned) close(false)
          else {
            setOpen(true)
            setPinned(true)
          }
        }}
      >
        <Icon icon={CheckListIcon} size={16} className="flex-none" />
        {/* Sized on the span: `[font:inherit]` on the button outranks a text-size utility there. */}
        <span className="text-[13px] font-medium">Sessions</span>
      </button>
      {typeof document === 'undefined' ? null : createPortal(
        <Popover
          open={open && placement !== null}
          ref={popup}
          origin="top-right"
          role="dialog"
          aria-label="Sessions overview"
          className="fixed z-40 overflow-hidden rounded-xl border border-line surface-floating shadow-menu"
          style={placement ?? undefined}
        >
          <ProjectSessionsOverview
            threadId={threadId}
            overview={overview}
            agents={agents}
            compact
            openLabel={(title) => `Open ${title}`}
            onSetSettled={onSetSettled}
            onSetArchived={onSetArchived}
            onDeleteChat={onDeleteChat}
            project={project}
            onOpen={(chatId) => {
              close(false)
              onOpen(chatId)
            }}
            onRevealProposal={(rowKey) => {
              close(false)
              onRevealProposal(rowKey)
            }}
            onAskDelete={(chat) => {
              close()
              setAsking(chat)
            }}
          />
        </Popover>,
        document.body,
      )}
      {asking === null ? null : (
        <DeleteChatConfirm
          title={asking.title}
          onConfirm={() => {
            setAsking(null)
            onDeleteChat(asking.id)
          }}
          onCancel={() => setAsking(null)}
        />
      )}
    </>
  )
}

