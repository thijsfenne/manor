import { useEffect, useRef, useState, type ComponentProps, type DragEvent, type PointerEvent, type ReactNode, type RefObject } from 'react'
import { AnimatePresence, motion, Reorder, useDragControls, useReducedMotion, type PanInfo } from 'motion/react'
import { Flag02Icon, PlusSignIcon } from '@hugeicons/core-free-icons'
import type { Reminder, ReminderList } from '@manor/contracts'
import { COLUMN_SETTLE, INSTANT, TAB_REORDER } from '../../motion'
import { Icon } from '../Icon'
import { CompleteRing, ReminderMeta } from './ReminderRow'
import { inSavedOrder, isPendingId, type ReminderBoard as Board, type ReminderColumn } from './reminderViews'

const DRAG_TYPE = 'application/x-manor-reminder'
/** One column and the gap after it (`w-[288px]` and `gap-3`), to place the landing slot. */
const COLUMN_STEP = 300

interface ReminderBoardProps {
  board: Board
  lists: readonly ReminderList[]
  now: { day: string; time: string }
  selectedId: string | null
  showList: boolean
  canWrite: boolean
  /** Section columns take drops; false in plain mode, where nothing can be moved into a section. */
  canMove: boolean
  /** The list's saved column order, as section ids. Section columns follow it; the rest stay put. */
  sectionOrder?: readonly string[]
  /** Saves a column drag. Absent where columns cannot move, the time columns on a tile. */
  onReorderSections?: (order: string[]) => void
  composer?: ReactNode
  /** The new-reminder row, typed into at the foot of the column it was opened from. */
  columnComposer?: { key: string; row: ReactNode }
  /** Opens that row in a column. Absent where a column is not a place, the time columns on a tile. */
  onAddTo?: (column: ReminderColumn) => void
  /** Stands in for the time columns when nothing in the scope has a date. */
  undatedState: ReactNode
  onSelect: (id: string) => void
  onToggle: (reminder: Reminder) => void
  onMove: (reminder: Reminder, sectionId: string) => void
}

/**
 * The columns layout: one column per section on a list, time of day on a tile. A card
 * dragged into another section column moves there; the details panel's Section field
 * is the same move for a keyboard. A section column drags from its header to a new
 * place on the board. The two gestures share nothing: a card is a native drag, a column
 * a pointer drag that only its header can start.
 */
export function ReminderBoard({
  board,
  lists,
  now,
  selectedId,
  showList,
  canWrite,
  canMove,
  sectionOrder = [],
  onReorderSections,
  composer,
  columnComposer,
  onAddTo,
  undatedState,
  onSelect,
  onToggle,
  onMove,
}: ReminderBoardProps) {
  const [dragging, setDragging] = useState<Reminder | null>(null)
  const [over, setOver] = useState<string | null>(null)
  // A column drag: the order while it is held, then the column still on its way home.
  // Neighbours slide only for that long, so no other layout change here ever animates.
  const [dragOrder, setDragOrder] = useState<string[] | null>(null)
  const [moving, setMoving] = useState<string | null>(null)
  const cancelled = useRef(false)
  const stopDrag = useRef<(() => void) | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const group = useRef<HTMLDivElement>(null)
  const reduceMotion = useReducedMotion() === true
  const listOf = (reminder: Reminder) => lists.find((list) => list.id === reminder.listId)

  const movable = onReorderSections === undefined ? [] : board.columns.filter((column) => column.sectionId !== undefined)
  const reorders = movable.length > 1
  const fixed = reorders ? board.columns.filter((column) => column.sectionId === undefined) : board.columns
  // A held order only speaks for the columns it was lifted with; any section that
  // arrived since keeps the place the saved order gave it.
  const savedSections = reorders ? inSavedOrder(movable, sectionOrder) : []
  const sections = dragOrder === null ? savedSections : inSavedOrder(savedSections, dragOrder)
  const landing = sections.findIndex((column) => column.key === moving)
  const held = dragOrder !== null
  const liftedGone = moving !== null && landing === -1

  // Apple dropped the section while it was held, so no gesture will ever end this drag.
  useEffect(() => {
    if (!liftedGone) return
    setDragOrder(null)
    setMoving(null)
  }, [liftedGone])

  useEffect(() => {
    if (!held) return
    const cancelOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      cancelled.current = true
      stopDrag.current?.()
    }
    window.addEventListener('keydown', cancelOnEscape, true)
    return () => window.removeEventListener('keydown', cancelOnEscape, true)
  }, [held])

  const onBoard = ({ point }: PanInfo) => {
    const box = scroller.current?.getBoundingClientRect()
    return box !== undefined && point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom
  }

  const dropColumn = (info: PanInfo) => {
    setDragOrder(null)
    if (cancelled.current || !onBoard(info)) return
    const moved = sections.some((column, index) => column.key !== savedSections[index]?.key)
    if (moved) onReorderSections?.(sections.map((column) => column.key))
  }

  const dropsInto = (sectionId: string | undefined): sectionId is string =>
    canMove && sectionId !== undefined && dragging !== null && dragging.sectionId !== sectionId

  /** What a column is whether or not it moves: its drop zone for cards. */
  const columnShell = (column: ReminderColumn) => ({
    'aria-label': column.title,
    className: `flex max-h-full w-[288px] flex-none flex-col rounded-2xl duration-150 ease-fade motion-safe:transition-colors ${
      dropsInto(column.sectionId) && over === column.key ? 'bg-user-bg' : 'bg-surface'
    }`,
    onDragOver: (event: DragEvent) => {
      if (!dropsInto(column.sectionId)) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      if (over !== column.key) setOver(column.key)
    },
    onDragLeave: (event: DragEvent) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(null)
    },
    onDrop: (event: DragEvent) => {
      event.preventDefault()
      setOver(null)
      if (dragging !== null && dropsInto(column.sectionId)) onMove(dragging, column.sectionId)
      setDragging(null)
    },
  })

  const columnBody = (column: ReminderColumn, lift?: (event: PointerEvent) => void) => {
    const count = column.nodes.reduce((sum, node) => sum + 1 + node.subtasks.length, 0)
    return (
      <>
        <h3
          className={`m-0 flex h-10 flex-none items-center gap-2 px-3.5 text-[14px] font-medium text-text ${
            lift === undefined ? '' : 'cursor-grab touch-none select-none active:cursor-grabbing'
          }`}
          onPointerDown={lift}
        >
          <span className="min-w-0 flex-1 truncate">{column.title}</span>
          <span className="flex-none text-[12px] font-normal tabular-nums text-dim">{count}</span>
        </h3>
        <ul className="m-0 flex min-h-0 list-none flex-col gap-1.5 overflow-y-auto px-2 pb-2">
          {column.nodes.length === 0 ? (
            <li className="px-1.5 py-2 text-label text-dim">{dropsInto(column.sectionId) ? 'Drop here' : 'Nothing here'}</li>
          ) : column.nodes.map(({ reminder, subtasks }) => {
            const list = listOf(reminder)
            const selected = reminder.id === selectedId
            const draggable = canMove && canWrite && board.columns.some((candidate) => candidate.sectionId !== undefined) && !isPendingId(reminder.id)
            return (
              <li
                key={reminder.id}
                draggable={draggable}
                onDragStart={(event: DragEvent) => {
                  event.dataTransfer.effectAllowed = 'move'
                  event.dataTransfer.setData(DRAG_TYPE, reminder.id)
                  setDragging(reminder)
                }}
                onDragEnd={() => {
                  setDragging(null)
                  setOver(null)
                }}
                className={`group/card flex items-start gap-1 rounded-xl p-1.5 ${
                  selected ? 'bg-user-bg' : 'bg-surface-2 hover:bg-user-bg'
                } ${dragging?.id === reminder.id ? 'opacity-50' : ''} ${draggable ? 'cursor-grab active:cursor-grabbing' : ''}`}
              >
                <CompleteRing reminder={reminder} list={list} size={16} disabled={!canWrite || isPendingId(reminder.id)} onToggle={onToggle} />
                <button
                  type="button"
                  data-reminder-row={reminder.id}
                  aria-current={selected ? 'true' : undefined}
                  className="flex min-w-0 flex-1 cursor-pointer flex-col gap-1 border-0 bg-transparent py-[3px] pr-1 text-left text-text"
                  onClick={() => onSelect(reminder.id)}
                >
                  <span className="flex items-start gap-1.5">
                    <span className="min-w-0 flex-1 text-[14px] leading-snug [overflow-wrap:anywhere]">{reminder.title}</span>
                    {reminder.flagged ? <Icon icon={Flag02Icon} size={13} className="mt-0.5 flex-none text-warn" aria-label="Flagged" /> : null}
                  </span>
                  <ReminderMeta
                    reminder={reminder}
                    now={now}
                    {...(showList && list !== undefined ? { list } : {})}
                    subtaskCount={subtasks.length}
                    className="text-[12px]"
                  />
                </button>
              </li>
            )
          })}
        </ul>
        {columnComposer?.key === column.key ? (
          <div className="flex-none px-2 pb-2">{columnComposer.row}</div>
        ) : onAddTo === undefined ? null : (
          <button
            type="button"
            className="mx-2 mb-2 flex h-8 flex-none cursor-pointer items-center gap-1.5 rounded-lg border-0 bg-transparent px-2 text-label text-dim hover:bg-surface-2 hover:text-text"
            onClick={() => onAddTo(column)}
          >
            <Icon icon={PlusSignIcon} size={14} />
            Add reminder
          </button>
        )}
      </>
    )
  }

  return (
    <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] pt-8">
      <div className="px-4 lg:px-6">{composer}</div>
      <motion.div ref={scroller} layoutScroll className="flex min-h-0 gap-3 overflow-x-auto px-4 pt-1 pb-6 lg:px-6">
        {board.undated ? <div className="grid min-w-[320px] flex-1 place-items-center">{undatedState}</div> : null}
        {fixed.map((column) => (
          <section key={column.key} {...columnShell(column)}>{columnBody(column)}</section>
        ))}
        {reorders ? (
          <Reorder.Group
            as="div"
            axis="x"
            ref={group}
            values={sections.map((column) => column.key)}
            className="relative flex flex-none gap-3"
            onReorder={setDragOrder}
          >
            <AnimatePresence>
              {moving !== null && landing !== -1 ? (
                <motion.div
                  aria-hidden
                  className="pointer-events-none absolute inset-y-0 left-0 w-[288px] rounded-2xl bg-surface-2"
                  initial={{ opacity: 0, x: landing * COLUMN_STEP }}
                  animate={{ opacity: 1, x: landing * COLUMN_STEP }}
                  exit={{ opacity: 0 }}
                  transition={reduceMotion ? INSTANT : TAB_REORDER}
                />
              ) : null}
            </AnimatePresence>
            {sections.map((column) => (
              <SectionColumn
                key={column.key}
                {...columnShell(column)}
                value={column.key}
                bounds={group}
                sliding={moving !== null && !reduceMotion}
                lifted={moving === column.key}
                onLift={(stop) => {
                  cancelled.current = false
                  stopDrag.current = stop
                  setMoving(column.key)
                  setDragOrder(sections.map((candidate) => candidate.key))
                }}
                onRelease={dropColumn}
                onSettled={() => setMoving((current) => (current === column.key ? null : current))}
                renderBody={(lift) => columnBody(column, lift)}
              />
            ))}
          </Reorder.Group>
        ) : null}
      </motion.div>
    </div>
  )
}

interface SectionColumnProps extends Omit<ComponentProps<typeof Reorder.Item<string>>, 'value' | 'children'> {
  value: string
  bounds: RefObject<HTMLDivElement | null>
  /** A column drag is under way, so a change of place is a move and slides. */
  sliding: boolean
  lifted: boolean
  /** The drag began; `stop` ends it from outside, as Escape does. */
  onLift: (stop: () => void) => void
  onRelease: (info: PanInfo) => void
  onSettled: () => void
  renderBody: (lift: (event: PointerEvent) => void) => ReactNode
}

/** A section column on a list's board. It only follows the pointer from its header. */
function SectionColumn({ value, bounds, sliding, lifted, onLift, onRelease, onSettled, renderBody, className, ...shell }: SectionColumnProps) {
  const controls = useDragControls()
  const reduceMotion = useReducedMotion() === true
  // Same reason as a Browser tab: ref bounds at rest would nudge the column on a resize.
  const [pressed, setPressed] = useState(false)
  useEffect(() => {
    if (!pressed) return
    const release = () => setPressed(false)
    window.addEventListener('pointerup', release)
    window.addEventListener('pointercancel', release)
    return () => {
      window.removeEventListener('pointerup', release)
      window.removeEventListener('pointercancel', release)
    }
  }, [pressed])

  return (
    <Reorder.Item
      {...shell}
      as="section"
      value={value}
      layout="position"
      drag="x"
      dragListener={false}
      dragControls={controls}
      dragConstraints={pressed ? bounds : undefined}
      dragElastic={0}
      dragMomentum={false}
      {...(reduceMotion ? {} : { dragTransition: COLUMN_SETTLE })}
      transition={{ layout: sliding ? TAB_REORDER : INSTANT }}
      className={`relative ${className ?? ''} ${lifted ? 'shadow-popover' : ''}`}
      onDragStart={() => onLift(() => controls.stop())}
      onDragEnd={(_event, info) => onRelease(info)}
      onDragTransitionEnd={onSettled}
    >
      {renderBody((event) => {
        // A press with Ctrl opens the context menu on a Mac and never lets go.
        if (event.button !== 0 || event.ctrlKey) return
        setPressed(true)
        controls.start(event)
      })}
    </Reorder.Item>
  )
}
