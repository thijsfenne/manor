import { useContext, useId, useRef, useMemo, useState, type ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import {
  ArrowDown01Icon,
  BubbleChatDoneIcon,
  BubbleChatQuestionIcon,
  CellsIcon,
  FileEditIcon,
  Idea01Icon,
  InformationCircleIcon,
  Note01Icon,
} from '@hugeicons/core-free-icons'
import { threadBundleView, type Row, type ThreadBundleEntry, type ThreadBundleGlyph, type ThreadBundleRow, type ThreadBundleTone } from '../state'
import { DISCLOSURE, LATE_MARK } from '../motion'
import { Icon } from './Icon'
import { SIDE_SURFACE } from './ui/dockPanel'
import { AnswerChange, BUNDLE_TILE, BUNDLE_TILE_HOVER, InBundle, OTHER_ANSWER } from './bundleTile'

const GLYPH: Record<ThreadBundleGlyph, typeof CellsIcon> = {
  session: CellsIcon,
  file: Note01Icon,
  learning: Idea01Icon,
  report: FileEditIcon,
  answer: BubbleChatDoneIcon,
  question: BubbleChatQuestionIcon,
  update: InformationCircleIcon,
}

const TONE: Record<ThreadBundleTone, string> = { ok: 'text-ok', busy: 'text-busy', warn: 'text-warn', dim: 'text-dim' }

/**
 * What Sessions and the thread posted since the user's last message, as one line in their
 * project thread with a chip per kind of thing that happened: "2 Sessions done", "1 written
 * note". A press opens it to one filled tile per item, Sessions first, then notes, then
 * learnings: a Session as its one-line thread line, anything else (a quiet turn's reply and
 * writes too) as its first line that a press opens in full. Every bundle starts closed; the
 * transcript holds which bundles and notes stand open, so a jump to a quoted item can
 * open both.
 */
export function ThreadBundle({ row, open, openItems, onOpenChange, renderItem }: {
  row: ThreadBundleRow
  open: boolean
  openItems: ReadonlySet<string>
  /** Opens or closes the bundle (its own key) or one of its notes (the item's key). */
  onOpenChange: (key: string, open: boolean) => void
  renderItem: (item: Row) => ReactNode
}) {
  const view = useMemo(() => threadBundleView(row.items, row.advice), [row.items, row.advice])
  // Clipped only while it folds or unfolds: a Session card's hover actions hang past its edge.
  const [moving, setMoving] = useState(false)
  // Only a press unfolds with motion; a jump to an item inside opens at once, so the
  // scroll lands on where the item rests.
  const pressed = useRef(false)
  const reduce = useReducedMotion() ?? false
  const listId = useId()
  // The chips fade only when an item joined; a thread that opens draws them at once.
  const [shown, setShown] = useState(row.summary)
  const [changed, setChanged] = useState(false)
  if (shown !== row.summary) {
    setShown(row.summary)
    setChanged(true)
  }
  const fold = reduce ? { opacity: 0 } : { height: 0, opacity: 0 }
  const unfold = reduce ? { opacity: 1 } : { height: 'auto', opacity: 1 }
  // On the sidebar's step, so it stands off the stage. Dark `dim` is 3:1 on a tile; here it takes `muted`.
  return (
    <div className={`mx-auto flex w-full max-w-[620px] min-w-0 flex-col rounded-[10px] ${SIDE_SURFACE} [--color-dim:var(--color-muted)]`}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={row.summary}
        onClick={() => {
          pressed.current = true
          onOpenChange(row.key, !open)
        }}
        className={`flex w-full min-w-0 cursor-pointer items-center gap-1.5 border-0 bg-transparent py-1.5 pr-2.5 pl-2 text-left text-[12.5px] leading-4 text-text [font-family:inherit] hover:bg-surface-2/40 ${open ? 'rounded-t-[10px]' : 'rounded-[10px]'}`}
      >
        <motion.span key={row.summary} initial={changed ? { opacity: 0 } : false} animate={{ opacity: 1 }} transition={LATE_MARK} className="flex min-w-0 flex-1 flex-wrap gap-1.5">
          {view.chips.map((chip) => (
            <span key={chip.key} className="inline-flex flex-none items-center gap-1.5 rounded-full bg-surface-2 py-0.75 pr-2.25 pl-1.75 whitespace-nowrap">
              <Icon icon={GLYPH[chip.glyph]} size={14} className={`flex-none ${TONE[chip.tone]}`} />
              <span className="font-medium">{chip.count}</span>
              <span className="text-muted">{chip.label}</span>
            </span>
          ))}
        </motion.span>
        <Icon icon={ArrowDown01Icon} size={14} className={`flex-none text-dim transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
      </button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            key="items"
            id={listId}
            initial={pressed.current ? fold : false}
            animate={unfold}
            exit={fold}
            transition={DISCLOSURE}
            onAnimationStart={() => setMoving(!reduce)}
            onAnimationComplete={() => {
              pressed.current = false
              setMoving(false)
            }}
            className={`flex min-w-0 flex-col${moving ? ' overflow-hidden' : ''}`}
          >
            <InBundle.Provider value>
              <div className="flex min-w-0 flex-col gap-0.5 px-0.5 pb-0.5">
                <AnimatePresence initial={false}>
                  {view.entries.map((entry) => (
                    // An item that joins while the bundle is open fades in where it lands; its
                    // row anchor lets a reveal by row key find it here; a turn's first line carries its key.
                    <motion.div key={entry.key} data-transcript-row={entry.key} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={LATE_MARK} className="flex min-w-0 flex-col">
                      {entry.kind === 'note'
                        ? <NoteTile note={entry} open={openItems.has(entry.key)} onOpenChange={(value) => onOpenChange(entry.key, value)} />
                        : renderItem(entry.item)}
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>
            </InBundle.Provider>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  )
}

/**
 * A note in an open bundle, a tile like a Session's: its mark, its first line, a small tag. A press shows all of it.
 * An answer the thread gave from a preference also offers Other answer at its end.
 */
function NoteTile({ note, open, onOpenChange }: {
  note: Extract<ThreadBundleEntry, { kind: 'note' }>
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const change = useContext(AnswerChange)
  const noteId = note.item.kind === 'event' ? note.item.event.id : undefined
  const changeable = change !== null && noteId !== undefined && change.ids.has(noteId)
  // Open, the text runs to its full length and the mark and tag stay on its first line.
  const lead = open ? 'pt-0.5' : ''
  return (
    <div className={`${BUNDLE_TILE} ${open ? 'items-start' : 'items-center'} ${BUNDLE_TILE_HOVER}`}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
        className={`flex min-w-0 flex-1 cursor-pointer gap-2.5 border-0 bg-transparent p-0 text-left text-inherit text-text [font:inherit] ${open ? 'items-start' : 'items-center'}`}
      >
        <span className={`flex w-4 flex-none ${lead}`}><Icon icon={GLYPH[note.glyph]} size={15} className={TONE[note.tone]} /></span>
        {open ? (
          <span className="flex min-w-0 flex-1 flex-col gap-1.5 leading-[19px] break-words whitespace-pre-wrap">
            <span>{note.text}</span>
            {note.advice === undefined ? null : <span className="text-muted"><span className="text-dim">Suggested · </span>{note.advice}</span>}
          </span>
        ) : <span className="min-w-0 flex-1 truncate">{note.title}</span>}
        {note.tag === '' ? null : <span className={`max-w-[45%] flex-none truncate text-[12px] text-dim ${lead}`}>{note.tag}</span>}
      </button>
      {changeable ? (
        <button
          type="button"
          onClick={() => change.onChange(noteId)}
          className={`flex-none cursor-pointer rounded-md border-0 bg-transparent p-0 text-[12px] text-muted [font:inherit] hover:text-text ${lead}`}
        >
          {OTHER_ANSWER}
        </button>
      ) : null}
    </div>
  )
}
