import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Calendar03Icon, Cancel01Icon, PlusSignIcon, Search01Icon } from '@hugeicons/core-free-icons'
import type { Reminder, ReminderChanges, ReminderWrite } from '@manor/contracts'
import {
  amsterdamNow,
  reminderCounts,
  withPendingWrites,
  type RemindersState,
} from '@manor/client-runtime/reminders'
import { EASE_TRAVEL, TOAST_IN, TOAST_OUT, TOAST_TRAVEL } from '../../motion'
import { useMinuteClock } from '../../useMinuteClock'
import type { RequestEvents } from '../../useRequest'
import type { ConnectionStatus } from '../../useWorkspace'
import { workspaceShortcut } from '../../useWorkspaceNav'
import { Icon } from '../Icon'
import { WorkspaceHeader } from '../WorkspaceHeader'
import { useHeaderRows } from '../TopBar'
import { Button } from '../ui/Button'
import { SegmentedControl, type SegmentOption } from '../ui/SegmentedControl'
import { Select } from '../ui/Select'
import { ReminderBoard } from './ReminderBoard'
import { ReminderCalendar } from './ReminderCalendar'
import { ReminderDetails } from './ReminderDetails'
import { ReminderListView } from './ReminderListView'
import { RemindersSidebar } from './RemindersSidebar'
import {
  boardColumns,
  inScope,
  isPendingId,
  listGroups,
  liveWrites,
  matchesSearch,
  monthOf,
  newReminderTarget,
  reconciledOrder,
  resolveSelection,
  sameScope,
  scopeExists,
  scopeKey,
  scopeTitle,
  type DoorWrite,
  type ReminderColumn,
  type ReminderLayout,
  type ReminderScope,
} from './reminderViews'

/** How often the open door re-reads Reminders, for edits made on the phone or by another person. */
export const REMINDERS_POLL_MS = 30_000
/** An answered write whose snapshot never moved (it changed nothing) stops overlaying after this. */
const UNDO_MS = 6_000

const SCOPE_KEY = 'manor:reminders-scope'
const LAYOUTS_KEY = 'manor:reminders-layouts'
const SECTION_ORDERS_KEY = 'manor:reminders-section-orders'
const TODAY: ReminderScope = { kind: 'tile', tile: 'today' }

const LAYOUT_OPTIONS: readonly SegmentOption<ReminderLayout>[] = [
  { value: 'list', label: 'List', tabId: 'reminders-tab-list', panelId: 'reminders-panel' },
  { value: 'columns', label: 'Columns', tabId: 'reminders-tab-columns', panelId: 'reminders-panel' },
  { value: 'calendar', label: 'Calendar', tabId: 'reminders-tab-calendar', panelId: 'reminders-panel' },
]

function readStored(key: string): unknown {
  try {
    const raw = window.localStorage.getItem(key)
    return raw === null ? null : JSON.parse(raw)
  } catch {
    return null
  }
}

function store(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Storage can be off; the door still works, it only forgets across reloads.
  }
}

function storedScope(): ReminderScope {
  const value = readStored(SCOPE_KEY)
  if (typeof value !== 'object' || value === null || !('kind' in value)) return TODAY
  if (value.kind === 'tile' && 'tile' in value && typeof value.tile === 'string' &&
    ['today', 'scheduled', 'flagged', 'assigned', 'all', 'completed'].includes(value.tile)) {
    return { kind: 'tile', tile: value.tile as Extract<ReminderScope, { kind: 'tile' }>['tile'] }
  }
  if (value.kind === 'list' && 'listId' in value && typeof value.listId === 'string') {
    const sectionId = 'sectionId' in value && typeof value.sectionId === 'string' ? value.sectionId : undefined
    return { kind: 'list', listId: value.listId, ...(sectionId === undefined ? {} : { sectionId }) }
  }
  return TODAY
}

function storedLayouts(): Record<string, ReminderLayout> {
  const value = readStored(LAYOUTS_KEY)
  if (typeof value !== 'object' || value === null) return {}
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, ReminderLayout] =>
      entry[1] === 'list' || entry[1] === 'columns' || entry[1] === 'calendar'),
  )
}

/** Column order per list, as section ids. Manor's own: To do is shared, so Apple keeps its order. */
function storedSectionOrders(): Record<string, string[]> {
  const value = readStored(SECTION_ORDERS_KEY)
  if (typeof value !== 'object' || value === null) return {}
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string[]] =>
      Array.isArray(entry[1]) && entry[1].every((id) => typeof id === 'string')),
  )
}

/** The selected reminder outlives a trip to another door, like Knowledge's open note. */
let selectedMemory: string | null = null

interface RemindersViewProps {
  reminders: RemindersState
  status: ConnectionStatus
  requestEvents: RequestEvents
  sidebarCollapsed: boolean
  onToggleSidebar?: () => void
  /** The workspace sidebar's slot for tiles and lists; null until it has mounted. */
  sidebarSlot: HTMLElement | null
  onLoad: () => boolean
  onLoadCompleted: (offset: number) => boolean
  onWrite: (requestId: string, action: ReminderWrite) => boolean
  /**
   * A reminder the ⌘K palette picked: selected with its details open, its list shown
   * when the current scope hides it. Applied once; `onSelectRequestHandled` clears it.
   */
  selectRequest?: { reminderId: string; id: number } | null
  onSelectRequestHandled?: (id: number) => void
}

/**
 * Apple Reminders as a Manor door: RemCTL's layout (tiles and lists beside, list,
 * columns or month in the middle, details on the right) in the house's surfaces. The user's
 * own clicks write at once and show before the Mac answers; a refused write rolls back.
 */
export function RemindersView({
  reminders,
  status,
  requestEvents,
  sidebarCollapsed,
  onToggleSidebar,
  sidebarSlot,
  onLoad,
  onLoadCompleted,
  onWrite,
  selectRequest,
  onSelectRequestHandled,
}: RemindersViewProps) {
  const headerRows = useHeaderRows()
  const reduce = useReducedMotion() ?? false
  const tick = useMinuteClock()
  const now = useMemo(() => amsterdamNow(new Date(tick)), [tick])
  const today = now.day
  const { snapshot, completed } = reminders

  const [scope, setScopeState] = useState(storedScope)
  const [layouts, setLayouts] = useState(storedLayouts)
  const [sectionOrders, setSectionOrders] = useState(storedSectionOrders)
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedState] = useState<string | null>(selectedMemory)
  // `column` puts the row at the foot of that board column, adding to its section.
  const [composer, setComposer] = useState<{ today: boolean; column?: { key: string; sectionId?: string } } | null>(null)
  const [month, setMonth] = useState(() => monthOf(today))
  const [writes, setWrites] = useState<DoorWrite[]>([])
  // Taken out of Completed (deleted, or back to open) and confirmed, until a page without them arrives.
  const [leftCompleted, setLeftCompleted] = useState<ReadonlySet<string>>(() => new Set())
  const [undo, setUndo] = useState<{ reminder: Reminder; key: string } | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const writesRef = useRef(writes)
  writesRef.current = writes
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot
  const searchRef = useRef<HTMLInputElement>(null)

  const setSelected = useCallback((id: string | null) => {
    selectedMemory = id
    setSelectedState(id)
  }, [])

  const plain = snapshot?.source === 'eventkit'
  const lists = snapshot?.lists ?? []
  const ready = snapshot !== null && snapshot.status === 'ready'
  const canWrite = status === 'live' && ready
  const shownScope = snapshot === null || scopeExists(scope, lists, plain) ? scope : TODAY
  const key = scopeKey(shownScope)
  const completedScope = shownScope.kind === 'tile' && shownScope.tile === 'completed'
  const layout: ReminderLayout = completedScope ? 'list' : (layouts[key] ?? 'list')

  const completedScopeRef = useRef(completedScope)
  completedScopeRef.current = completedScope

  // Fresh on arrival, on focus and on a timer; a poll that changed nothing repaints
  // nothing. Completed is paged apart from the snapshot (and the EventKit fallback's
  // revision does not cover it), so while it is open it re-reads page one too.
  useEffect(() => {
    if (status !== 'live') return
    const refresh = () => {
      onLoad()
      if (completedScopeRef.current) onLoadCompleted(0)
    }
    onLoad()
    const poll = window.setInterval(() => {
      if (document.visibilityState === 'visible') refresh()
    }, REMINDERS_POLL_MS)
    window.addEventListener('focus', refresh)
    return () => {
      window.clearInterval(poll)
      window.removeEventListener('focus', refresh)
    }
  }, [status, onLoad, onLoadCompleted])

  useEffect(() => {
    if (completedScope && status === 'live') onLoadCompleted(0)
  }, [completedScope, status, onLoadCompleted])

  useEffect(() => {
    setLoadingMore(false)
    if (completed === null) return
    const shown = new Set(completed.reminders.map((reminder) => reminder.id))
    setLeftCompleted((current) => {
      const next = new Set([...current].filter((id) => shown.has(id)))
      return next.size === current.size ? current : next
    })
  }, [completed])

  // The answer to each write ends its overlay. The socket layer folds in everything
  // that arrived before the answer first, and the server sends the snapshot that shows
  // the write before it acks, so the answer and the truth land in one render. A notice
  // is a rollback; its text shows in the sidebar foot.
  useEffect(
    () => requestEvents.subscribe((response) => {
      if (response.type !== 'ack' && response.type !== 'notice') return
      const write = writesRef.current.find((candidate) => candidate.requestId === response.requestId)
      if (write === undefined) return
      if (response.type === 'notice') {
        setWrites((current) => current.filter((candidate) => candidate.requestId !== write.requestId))
        return
      }
      // Marked rather than removed, so a create keeps its row claimed and its selection
      // until the effect below has handed both on.
      setWrites((current) => current.map((candidate) => (candidate.requestId === write.requestId ? { ...candidate, answered: true } : candidate)))
      const { action } = write
      if (action.kind === 'delete' || action.kind === 'uncomplete') {
        setLeftCompleted((current) => new Set(current).add(action.id))
      }
      if (action.kind !== 'create' && action.kind !== 'update' && completedScopeRef.current) onLoadCompleted(0)
    }),
    [requestEvents, onLoadCompleted],
  )

  // Each snapshot or answer retires the writes that are done, after handing a selected
  // pending create its real id.
  useEffect(() => {
    if (snapshot === null) return
    const selected = selectedMemory
    if (selected !== null && isPendingId(selected)) {
      const resolved = resolveSelection(selected, writes, snapshot.reminders)
      if (resolved !== selected) setSelected(resolved)
    }
    setWrites((current) => {
      const next = liveWrites(current, snapshot)
      return next.length === current.length ? current : next
    })
  }, [snapshot, writes, setSelected])

  useEffect(() => {
    if (undo === null) return
    const timer = window.setTimeout(() => setUndo(null), UNDO_MS)
    return () => window.clearTimeout(timer)
  }, [undo])

  const live = useMemo(() => (snapshot === null ? [] : liveWrites(writes, snapshot)), [writes, snapshot])
  const open = useMemo(
    () => (snapshot === null ? [] : withPendingWrites(snapshot.reminders, snapshot.lists, live)),
    [snapshot, live],
  )
  const counts = useMemo(() => reminderCounts(open, today), [open, today])
  const shownLists = useMemo(
    () => lists.map((list) => ({ ...list, open: open.filter((reminder) => reminder.listId === list.id).length })),
    [lists, open],
  )
  const sectionCounts = useMemo(() => {
    const byId = new Map<string, number>()
    for (const reminder of open) {
      if (reminder.sectionId !== undefined) byId.set(reminder.sectionId, (byId.get(reminder.sectionId) ?? 0) + 1)
    }
    return byId
  }, [open])

  // Completed's pages carry nothing the overlay touches, so a reminder taken back out
  // of Completed or deleted from it is hidden here until a page without it arrives.
  const completedRows = useMemo(() => {
    if (completed === null) return []
    const gone = new Set([...leftCompleted, ...live.flatMap((write) =>
      write.action.kind === 'uncomplete' || write.action.kind === 'delete' ? [write.action.id] : [])])
    return completed.reminders.filter((reminder) => !gone.has(reminder.id))
  }, [completed, live, leftCompleted])

  const scoped = useMemo(
    () => (completedScope ? completedRows : open.filter((reminder) => inScope(reminder, shownScope, today)))
      .filter((reminder) => matchesSearch(reminder, query)),
    [completedScope, completedRows, open, shownScope, today, query],
  )

  const selectedPool = completedScope ? [...open, ...completedRows] : open
  const selected = selectedId === null ? undefined : selectedPool.find((reminder) => reminder.id === selectedId)

  const setScope = (next: ReminderScope) => {
    if (sameScope(next, shownScope)) return
    store(SCOPE_KEY, next)
    setScopeState(next)
    setComposer(null)
    setSelected(null)
  }

  useEffect(() => {
    if (selectRequest === undefined || selectRequest === null || snapshot === null) return
    onSelectRequestHandled?.(selectRequest.id)
    const reminder = snapshot.reminders.find((candidate) => candidate.id === selectRequest.reminderId)
    if (reminder !== undefined && !inScope(reminder, shownScope, today)) setScope({ kind: 'list', listId: reminder.listId })
    setQuery('')
    setComposer(null)
    setSelected(selectRequest.reminderId)
  })

  // The plain source reads every list as sectionless, which says nothing about Apple's
  // sections, so an order only ever changes against a read that has them.
  useEffect(() => {
    const changed = (snapshot?.lists ?? []).flatMap((list) => {
      const saved = sectionOrders[list.id]
      const order = saved === undefined || list.sections.length === 0 ? null : reconciledOrder(saved, list.sections.map((section) => section.id))
      return order === null ? [] : [[list.id, order] as const]
    })
    if (changed.length === 0) return
    const updated = { ...sectionOrders, ...Object.fromEntries(changed) }
    store(SECTION_ORDERS_KEY, updated)
    setSectionOrders(updated)
  }, [snapshot, sectionOrders])

  const setSectionOrder = (listId: string, order: string[]) => {
    const updated = { ...sectionOrders, [listId]: order }
    store(SECTION_ORDERS_KEY, updated)
    setSectionOrders(updated)
  }

  const setLayout = (next: ReminderLayout) => {
    if (composer?.column !== undefined) setComposer(null)
    const updated = { ...layouts, [key]: next }
    store(LAYOUTS_KEY, updated)
    setLayouts(updated)
  }

  const send = (action: ReminderWrite, extra: Pick<DoorWrite, 'before' | 'knownIds'> = {}): string | null => {
    if (snapshotRef.current === null || !canWrite) return null
    const requestId = crypto.randomUUID()
    if (!onWrite(requestId, action)) return null
    setWrites((existing) => [...existing, { requestId, action, ...extra }])
    return requestId
  }

  const toggle = (reminder: Reminder) => {
    if (reminder.completed) {
      send({ kind: 'uncomplete', id: reminder.id }, { before: reminder })
      return
    }
    if (send({ kind: 'complete', id: reminder.id }) !== null) {
      setUndo({ reminder, key: crypto.randomUUID() })
      // Completed again after being taken out: its next page row is the real one.
      setLeftCompleted((current) => {
        if (!current.has(reminder.id)) return current
        const next = new Set(current)
        next.delete(reminder.id)
        return next
      })
    }
  }

  const update = (id: string, changes: ReminderChanges) => {
    send({ kind: 'update', id, changes })
  }

  const create = (listId: string, title: string, changes: Omit<ReminderChanges, 'title' | 'listId'>, parentId?: string) => {
    const known = new Set((snapshotRef.current?.reminders ?? []).map((reminder) => reminder.id))
    return send(
      { kind: 'create', listId, title, ...(parentId === undefined ? {} : { parentId }), ...(Object.keys(changes).length === 0 ? {} : { changes }) },
      { knownIds: known },
    )
  }

  const remove = (reminder: Reminder) => {
    if (send({ kind: 'delete', id: reminder.id }) !== null) setSelected(null)
  }

  const startComposer = useCallback((todayDate = false) => {
    setComposer({ today: todayDate })
  }, [])

  // ⌘N is the house's New chat everywhere else; in here it makes a reminder.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || workspaceShortcut(event) !== 'new-chat') return
      event.preventDefault()
      startComposer()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [startComposer])

  const target = snapshot === null ? null : newReminderTarget(shownScope, lists, today, plain)
  const title = scopeTitle(shownScope, lists)
  const showList = shownScope.kind === 'tile'

  const composerRow = composer === null || target === null ? null : (
    <NewReminderRow
      key={`${key}:${composer.column?.key ?? (composer.today ? 'today' : 'plain')}`}
      lists={lists}
      defaultListId={target.listId}
      chooseList={shownScope.kind === 'tile'}
      dueToday={composer.today && target.changes.due === undefined}
      compact={composer.column !== undefined}
      disabled={!canWrite}
      onCreate={(listId, text) => {
        // Another list keeps the scope's date and flag, but not a section or a person
        // that belong to the list it suggested. A section column (only on a list, so the
        // list is fixed) adds to its own section, the No section column to none.
        const { sectionId: _sectionId, assigneeId: _assigneeId, ...portable } = target.changes
        const { column } = composer
        const scoped = column === undefined || column.key === 'all'
          ? (listId === target.listId ? target.changes : portable)
          : (column.sectionId === undefined ? {} : { sectionId: column.sectionId })
        create(listId, text, { ...scoped, ...(composer.today ? { due: { day: today } } : {}) })
      }}
      onClose={() => setComposer(null)}
    />
  )

  const undatedState = (
    <EmptyCard
      icon={Calendar03Icon}
      title="No dated reminders"
      body={shownScope.kind === 'list'
        ? `Nothing in ${title} has a date yet. Give one a date in its details, or start one for today.`
        : 'Give a reminder a date in its details, or start one for today.'}
      action={canWrite && target !== null ? { label: 'New reminder today', onClick: () => startComposer(true) } : undefined}
    />
  )

  const emptyList = (
    <EmptyCard
      title={query.trim() !== '' ? `Nothing matches “${query.trim()}”` : emptyTitle(shownScope, title)}
      body={query.trim() !== '' ? 'Search looks at titles, notes and tags in this list.' : undefined}
      action={query.trim() === '' && canWrite && target !== null && !completedScope && composer === null
        ? { label: 'New reminder', onClick: () => startComposer() } : undefined}
    />
  )

  const detailsFor = selected === undefined ? null : (
    <ReminderDetails
      key="details"
      reminder={selected}
      lists={lists}
      subtasks={open.filter((reminder) => reminder.parentId === selected.id)}
      now={now}
      plain={plain}
      canWrite={canWrite}
      onUpdate={(changes) => update(selected.id, changes)}
      onToggle={toggle}
      onDelete={() => remove(selected)}
      onAddSubtask={(text) => create(selected.listId, text, {}, selected.id)}
      onSelect={setSelected}
      onClose={() => setSelected(null)}
    />
  )

  let body: ReactNode
  if (snapshot === null) {
    body = <StageMessage>{status === 'live' ? 'Reading Reminders…' : 'Waiting for the Mac…'}</StageMessage>
  } else if (snapshot.status === 'unavailable') {
    body = (
      <div className="grid place-items-center px-6">
        <EmptyCard
          title="Reminders could not be read"
          body={snapshot.notice ?? 'Neither RemCTL nor remindctl answered on this Mac.'}
          action={status === 'live' ? { label: 'Try again', onClick: () => onLoad() } : undefined}
        />
      </div>
    )
  } else if (completedScope && completed === null) {
    body = <StageMessage>Reading completed reminders…</StageMessage>
  } else if (layout === 'columns') {
    body = (
      <ReminderBoard
        key={key}
        board={boardColumns(scoped, shownScope, lists, now, plain)}
        lists={lists}
        now={now}
        selectedId={selectedId}
        showList={showList}
        canWrite={canWrite}
        canMove={!plain}
        composer={composer?.column === undefined ? composerRow : null}
        {...(composer?.column === undefined ? {} : { columnComposer: { key: composer.column.key, row: composerRow } })}
        {...(shownScope.kind === 'list' && canWrite && target !== null
          ? { onAddTo: (column: ReminderColumn) => setComposer({ today: false, column: { key: column.key, ...(column.sectionId === undefined ? {} : { sectionId: column.sectionId }) } }) }
          : {})}
        {...(shownScope.kind === 'list'
          ? { sectionOrder: sectionOrders[shownScope.listId] ?? [], onReorderSections: (order: string[]) => setSectionOrder(shownScope.listId, order) }
          : {})}
        undatedState={undatedState}
        onSelect={setSelected}
        onToggle={toggle}
        onMove={(reminder, sectionId) => update(reminder.id, { sectionId })}
      />
    )
  } else if (layout === 'calendar') {
    body = (
      <ReminderCalendar
        reminders={scoped}
        lists={lists}
        today={today}
        month={month}
        selectedId={selectedId}
        composer={composerRow}
        undatedState={undatedState}
        onMonth={setMonth}
        onSelect={setSelected}
      />
    )
  } else {
    body = (
      <div className="min-h-0 overflow-y-auto">
        <ReminderListView
          key={key}
          groups={completedScope
            ? [{ key: 'completed', title: null, nodes: scoped.map((reminder) => ({ reminder, subtasks: [] })) }]
            : listGroups(scoped, shownScope, lists, today, { plain, searching: query.trim() !== '' })}
          lists={lists}
          now={now}
          selectedId={selectedId}
          showList={showList}
          canWrite={canWrite}
          memoryKey={key}
          composer={composerRow}
          empty={emptyList}
          footer={completedScope && completed !== null && completed.nextOffset !== null && query.trim() === '' ? (
            <div className="flex justify-center pt-4">
              <Button
                variant="secondary"
                size="compact"
                disabled={loadingMore || status !== 'live'}
                onClick={() => {
                  if (completed.nextOffset !== null && onLoadCompleted(completed.nextOffset)) setLoadingMore(true)
                }}
              >
                {loadingMore ? 'Loading…' : `Show more (${completed.total - completed.reminders.length} left)`}
              </Button>
            </div>
          ) : null}
          onSelect={setSelected}
          onToggle={toggle}
        />
      </div>
    )
  }

  const sidebar = snapshot === null || snapshot.status === 'unavailable' ? (
    <p className="m-0 px-3 py-2 text-label text-dim">{snapshot === null ? 'Reading Reminders…' : 'Reminders is unavailable.'}</p>
  ) : (
    <RemindersSidebar
      scope={shownScope}
      counts={counts}
      completedCount={snapshot.completedCount}
      groups={snapshot.groups}
      lists={shownLists}
      sectionCounts={sectionCounts}
      plain={plain}
      notice={snapshot.notice}
      onScope={setScope}
    />
  )

  return (
    <section className={`relative grid min-h-0 min-w-0 ${headerRows} overflow-hidden bg-bg`}>
      {sidebarSlot === null ? null : createPortal(sidebar, sidebarSlot)}
      <WorkspaceHeader
        section="reminders"
        title={title}
        status={status}
        sidebarCollapsed={sidebarCollapsed}
        {...(onToggleSidebar === undefined ? {} : { onToggleSidebar })}
        accessoryGrow
        accessory={(
          <div className="flex min-w-0 items-center gap-3">
            <SegmentedControl
              label="Layout"
              options={LAYOUT_OPTIONS.map((option) => (completedScope && option.value !== 'list' ? { ...option, disabled: true } : option))}
              value={layout}
              onChange={setLayout}
            />
            <div className="ml-auto flex h-8 w-[clamp(160px,20vw,280px)] min-w-0 items-center gap-2 rounded-lg border border-line bg-stage px-2.5 text-muted focus-within:border-field-focus">
              <Icon icon={Search01Icon} size={16} className="flex-none" />
              <input
                ref={searchRef}
                type="search"
                value={query}
                placeholder="Search"
                aria-label={`Search ${title}`}
                className="min-w-0 flex-1 border-0 bg-transparent p-0 text-label text-text outline-none placeholder:text-dim [&::-webkit-search-cancel-button]:appearance-none"
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape' && query !== '') {
                    event.preventDefault()
                    setQuery('')
                  }
                }}
              />
              {query === '' ? null : (
                <button
                  type="button"
                  aria-label="Clear search"
                  title="Clear search"
                  className="grid h-6 w-6 flex-none cursor-pointer place-items-center rounded-md border-0 bg-transparent p-0 text-muted hover:bg-surface-2 hover:text-text"
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => {
                    setQuery('')
                    searchRef.current?.focus({ preventScroll: true })
                  }}
                >
                  <Icon icon={Cancel01Icon} size={14} />
                </button>
              )}
            </div>
            <Button
              variant="primary"
              size="compact"
              className="flex flex-none items-center gap-1.5"
              title="New reminder (⌘N)"
              disabled={!canWrite || target === null}
              onClick={() => startComposer()}
            >
              <Icon icon={PlusSignIcon} size={14} />
              New reminder
            </Button>
          </div>
        )}
      />

      <div className="relative grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)_auto]">
        <div id="reminders-panel" role="tabpanel" aria-labelledby={`reminders-tab-${layout}`} className="grid min-h-0 min-w-0">
          {body}
        </div>
        <AnimatePresence initial={false}>
          {detailsFor === null ? null : (
            <motion.div
              key="details"
              className="flex min-h-0 pt-2 pr-2 pb-2 max-[1180px]:absolute max-[1180px]:inset-y-0 max-[1180px]:right-0 max-[1180px]:z-[8] max-[1180px]:[&>aside]:shadow-popover"
              initial={reduce ? { opacity: 0 } : { opacity: 0, x: 10 }}
              animate={{ opacity: 1, x: 0 }}
              exit={reduce ? { opacity: 0, transition: { duration: 0.1 } } : { opacity: 0, x: 6, transition: { duration: 0.16, ease: 'easeIn' } }}
              transition={reduce ? { duration: 0.12 } : { duration: 0.28, ease: EASE_TRAVEL, opacity: { duration: 0.18 } }}
            >
              {detailsFor}
            </motion.div>
          )}
        </AnimatePresence>

        <div className="pointer-events-none absolute inset-x-0 bottom-5 z-[9] flex justify-center px-4">
          <AnimatePresence>
            {undo === null ? null : (
              <motion.div
                key={undo.key}
                role="status"
                className="pointer-events-auto flex items-center gap-3 rounded-full border border-line bg-raised py-1.5 pr-1.5 pl-4 text-label text-text shadow-pill"
                initial={reduce ? { opacity: 0 } : { opacity: 0, y: TOAST_TRAVEL }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduce ? { opacity: 0, transition: { duration: 0.1 } } : { opacity: 0, y: TOAST_TRAVEL / 2, transition: TOAST_OUT }}
                transition={reduce ? { duration: 0.12 } : TOAST_IN}
              >
                <span className="max-w-[320px] truncate">Completed “{undo.reminder.title}”</span>
                <Button
                  variant="secondary"
                  size="compact"
                  className="rounded-full"
                  disabled={!canWrite}
                  onClick={() => {
                    send({ kind: 'uncomplete', id: undo.reminder.id }, { before: undo.reminder })
                    setUndo(null)
                  }}
                >
                  Undo
                </Button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </section>
  )
}

function emptyTitle(scope: ReminderScope, title: string): string {
  if (scope.kind === 'list') return `Nothing open in ${title}`
  switch (scope.tile) {
    case 'today':
      return 'Nothing due today'
    case 'scheduled':
      return 'Nothing scheduled'
    case 'flagged':
      return 'Nothing flagged'
    case 'assigned':
      return 'Nothing assigned to you'
    case 'all':
      return 'No open reminders'
    case 'completed':
      return 'Nothing completed yet'
  }
}

function StageMessage({ children }: { children: ReactNode }) {
  return <p className="m-0 grid place-items-center px-6 text-center text-label text-dim" role="status">{children}</p>
}

function EmptyCard({
  icon,
  title,
  body,
  action,
}: {
  icon?: Parameters<typeof Icon>[0]['icon']
  title: string
  body?: string | undefined
  action?: { label: string; onClick: () => void } | undefined
}) {
  return (
    <div className="mx-auto flex max-w-[380px] flex-col items-center gap-1.5 px-6 text-center">
      {icon === undefined ? null : <Icon icon={icon} size={20} className="mb-1 text-dim" />}
      <p className="m-0 text-[15px] font-medium text-text">{title}</p>
      {body === undefined ? null : <p className="m-0 text-label leading-relaxed text-muted">{body}</p>}
      {action === undefined ? null : (
        <Button variant="secondary" size="compact" className="mt-2" onClick={action.onClick}>{action.label}</Button>
      )}
    </div>
  )
}

/**
 * The row a new reminder is typed into, where the list's next row would be. Enter
 * makes it and leaves the row open for the next one, the way Reminders.app does;
 * Escape, or leaving it empty, puts it away.
 */
function NewReminderRow({
  lists,
  defaultListId,
  chooseList,
  dueToday,
  compact = false,
  disabled,
  onCreate,
  onClose,
}: {
  lists: readonly { id: string; title: string }[]
  defaultListId: string
  /** Tiles mix lists, so the row asks which one; a list scope already says. */
  chooseList: boolean
  dueToday: boolean
  /** At the foot of a board column: card-sized, without the list row's indent. */
  compact?: boolean
  disabled: boolean
  onCreate: (listId: string, title: string) => void
  onClose: () => void
}) {
  const [text, setText] = useState('')
  const [listId, setListId] = useState(defaultListId)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => input.current?.focus({ preventScroll: false }), [])

  return (
    <div className={`flex items-center gap-2 bg-surface-2 py-1 pr-1.5 ${compact ? 'rounded-xl pl-2' : 'rounded-lg pl-[34px]'}`}>
      <span aria-hidden="true" className={`flex-none rounded-full border-[1.5px] border-dim ${compact ? 'h-4 w-4' : 'h-[18px] w-[18px]'}`} />
      <input
        ref={input}
        value={text}
        aria-label="New reminder"
        placeholder="New reminder"
        disabled={disabled}
        className={`min-w-0 flex-1 border-0 bg-transparent py-1.5 text-text outline-none placeholder:text-dim ${compact ? 'text-[14px]' : 'text-[15px]'}`}
        onChange={(event) => setText(event.target.value)}
        onBlur={(event) => {
          // A click on the list picker beside it is still this row.
          if (text.trim() === '' && !event.currentTarget.parentElement?.contains(event.relatedTarget as Node | null)) onClose()
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            onClose()
            return
          }
          if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
          event.preventDefault()
          const title = text.trim()
          if (title === '') return
          onCreate(listId, title)
          setText('')
        }}
      />
      {dueToday ? <span className="flex-none rounded-chip bg-user-bg px-2 py-0.5 text-meta text-muted">Today</span> : null}
      {!chooseList ? null : (
        <div className="w-[150px] flex-none">
          <Select label="List for the new reminder" value={listId} options={lists.map((list) => ({ value: list.id, label: list.title }))} onChange={setListId} />
        </div>
      )}
    </div>
  )
}
