import { Brain02Icon, Copy01Icon, MoreHorizontalIcon, NoteEditIcon, ReplyIcon, TaskDone01Icon, Tick02Icon } from '@hugeicons/core-free-icons'
import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'motion/react'
import type { MemoryChange, MemoryChangeLine, MessageReaction, MemoryTrace } from '@manor/contracts'
import type { IconSvgElement } from '@hugeicons/react'
import { LATE_MARK } from '../motion'
import { distinctReadPaths, messageTime, readsLabel } from '../messageMeta'
import { baseName, FileMark } from './fileMark'
import { copyText } from '../clipboard'
import { ReactionButton } from './Reactions'
import { IconButton } from './ui/IconButton'
import { Menu, MenuItem, useMenu } from './ui/Menu'
import { Popover } from './ui/Popover'
import { useDismiss } from './ui/useDismiss'

/** How long the copy button stands as a tick before it goes back to being a copy. */
const COPIED_MS = 1_600
/** Aimed at deliberately, not passed over, so this is shorter than the sidebar's 320. */
const OPEN_DELAY_MS = 140
/** The grace that lets the pointer cross the gap from the icon into the card. */
const CLOSE_DELAY_MS = 140

export const CARD_WIDTH = 640
/** Narrower than this the two columns stop being two columns; it overhangs instead. */
const MIN_CARD_WIDTH = 240
const GAP = 6
const INSET = 8
/** Below this the card is a slit, and it is better off on the other side of the icon. */
const MIN_CARD = 120

/**
 * Marks the region a message card may use. The transcript wears it, in the stage and
 * in the side chat alike.
 */
export const BOUNDS_ATTRIBUTE = 'data-message-bounds'

interface MessageFooterProps {
  /**
   * The reply as it was written, which is what the copy button puts on the clipboard:
   * the markdown, not the rendered text. A turn that never spoke passes an empty
   * string and gets no copy button, because there is nothing to copy.
   */
  text: string
  /** When the turn stopped. Absent on a record written before turns carried one. */
  endedAt?: number
  /** Absent on an older turn, and on a persona whose Memory toggle is off. */
  trace?: MemoryTrace
  /** What the turn changed in memory. The daily-log writer's part lands after the turn. */
  memoryChanges?: MemoryChange[]
  /** Offered only in DMs and groups, where a finished answer may be targeted. */
  onReply?: () => void
}

/**
 * The quiet row under a finished turn group: copy it, see what memory it stood on,
 * and when it was said. Work keeps those actions visible; a DM still hides its
 * per-beat icons until that bubble is hovered. The timestamp stays the settled
 * signature on the right.
 *
 * It repeats down the whole transcript, so everything on it is the smallest legible
 * size and the dimmest tone that still reads, and nothing on it moves on its own. The
 * memory mark is the one thing here that is new rather than conventional, and it is
 * deliberately mute until hovered: the count of what a turn read is a number nobody
 * needs while reading the answer, and the one time it matters is the moment you doubt
 * the answer.
 */
export function MessageFooter({ text, endedAt, trace, memoryChanges, onReply }: MessageFooterProps) {
  if (text.length === 0 && trace === undefined && !hasMemoryChanges(memoryChanges)) return null

  return (
    <div className="mt-0.5 flex min-w-0 items-center gap-0.5">
      <MessageActions
        text={text}
        trace={trace}
        memoryChanges={memoryChanges}
        onReply={onReply}
      />
      <span className="min-w-0 flex-1" />
      {endedAt === undefined ? null : (
        <time className="flex-none pr-1 text-meta text-dim" dateTime={new Date(endedAt).toISOString()}>
          {messageTime(endedAt, Date.now())}
        </time>
      )}
    </div>
  )
}

const hasMemoryChanges = (changes: MemoryChange[] | undefined): changes is MemoryChange[] =>
  changes !== undefined && changes.some((change) => change.lines.length > 0)

/** Copy, reply and memory for one bubble or, outside DMs, one whole turn. */
export function MessageActions({
  text,
  trace,
  memoryChanges,
  onReply,
  className = '',
}: {
  text: string
  trace?: MemoryTrace
  memoryChanges?: MemoryChange[]
  onReply?: () => void
  className?: string
}) {
  const [copied, copy] = useCopied(text)
  // Changes already there when the row mounted are history, and history does not
  // animate. Only the writer's diff landing under an answer already on screen fades in.
  const [changesAtMount] = useState(() => hasMemoryChanges(memoryChanges))

  return (
    <div className={`flex flex-none items-center gap-0.5 ${className}`}>
      {text.length === 0 ? null : (
        <>
          <IconButton
            icon={copied ? Tick02Icon : Copy01Icon}
            iconSize={14}
            size={28}
            swapKey={copied ? 'copied' : 'copy'}
            label={copied ? 'Copied' : 'Copy the reply'}
            onClick={() => void copy()}
          />
          {onReply === undefined ? null : (
            <IconButton
              icon={ReplyIcon}
              iconSize={14}
              size={28}
              label="Reply to this message"
              onClick={onReply}
            />
          )}
        </>
      )}
      {trace === undefined ? null : <MemoryMark trace={trace} />}
      {hasMemoryChanges(memoryChanges) ? (
        <motion.span
          className="flex"
          initial={changesAtMount ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={LATE_MARK}
        >
          <MemoryChangesMark changes={memoryChanges} />
        </motion.span>
      ) : null}
    </div>
  )
}

/**
 * The hover row beside one DM bubble: react, reply, and a menu with copy and the memory
 * the turn read or wrote. It stands while its picker, menu or card is open, so a
 * pointer leaving the bubble does not pull the row out from under a choice.
 */
/**
 * A message's copy control: whether the tick shows, and the copy itself. A copy that did
 * not land shows no tick, which is the honest answer to "did that copy".
 */
function useCopied(text: string): [boolean, () => Promise<void>] {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const copy = async () => {
    if (!await copyText(text)) return
    setCopied(true)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(false), COPIED_MS)
  }
  return [copied, copy]
}

/** The rows of a DM bubble's three-dots menu, in order. */
export const bubbleMenu = (text: string, trace: MemoryTrace | undefined, changes: MemoryChange[] | undefined, steps = false) => [
  ...(text.length > 0 ? [{ key: 'copy' as const, label: 'Copy' }] : []),
  ...(steps ? [{ key: 'steps' as const, label: 'Show steps' }] : []),
  ...(trace === undefined ? [] : [{ key: 'trace' as const, label: markLabel(trace) }]),
  ...(changes === undefined ? [] : [{ key: 'changes' as const, label: changesLabel(changes) }]),
]

export function BubbleActions({ text, trace, memoryChanges, onReply, reaction, onReact, onShowSteps }: {
  text: string
  trace?: MemoryTrace
  memoryChanges?: MemoryChange[]
  onReply?: () => void
  /** The user's current reaction on this message. */
  reaction?: MessageReaction
  /** Absent where the bubble cannot take a reaction, such as one still arriving. */
  onReact?: (emoji: string | null) => void
  /** Opens the turn's steps where its Worked for line has no room to hang. */
  onShowSteps?: () => void
}) {
  const [copied, copy] = useCopied(text)
  const [picking, setPicking] = useState(false)
  const [card, setCard] = useState<'trace' | 'changes' | null>(null)
  const [menu, trigger] = useMenu({ maxHeight: 240, minHeight: 80, minWidth: 220 })
  const changes = hasMemoryChanges(memoryChanges) ? memoryChanges : undefined
  const entries = bubbleMenu(text, trace, changes, onShowSteps !== undefined)
  const standing = picking || menu.open || card !== null || copied
  return (
    <div className={`mb-0.5 flex flex-none items-center gap-0.5 transition-opacity ${standing ? 'opacity-100' : 'opacity-0 group-hover/beat:opacity-100 focus-within:opacity-100'}`}>
      {onReact === undefined ? null : <ReactionButton {...(reaction === undefined ? {} : { current: reaction })} onPick={onReact} onOpenChange={setPicking} />}
      {onReply === undefined || text.length === 0 ? null : (
        <IconButton icon={ReplyIcon} iconSize={14} size={28} label="Reply to this message" onClick={onReply} />
      )}
      {entries.length > 0 ? (
        <>
          <IconButton
            ref={trigger}
            icon={copied ? Tick02Icon : MoreHorizontalIcon}
            swapKey={copied ? 'copied' : 'more'}
            iconSize={14}
            size={28}
            label={copied ? 'Copied' : 'More actions'}
            selected={menu.open || card !== null}
            aria-haspopup="menu"
            aria-expanded={menu.open}
            onClick={menu.toggle}
          />
          <Menu menu={menu} label="Message actions">
            {entries.map((entry) => (
              <MenuItem
                key={entry.key}
                icon={entry.key === 'copy' ? Copy01Icon : entry.key === 'steps' ? TaskDone01Icon : entry.key === 'trace' ? Brain02Icon : NoteEditIcon}
                onClick={() => {
                  if (entry.key === 'copy') { menu.close(); void copy(); return }
                  if (entry.key === 'steps') { menu.close(); onShowSteps?.(); return }
                  menu.close(false)
                  setCard(entry.key)
                }}
              >
                {entry.label}
              </MenuItem>
            ))}
          </Menu>
          <AnchoredCard anchor={trigger} open={card !== null} onClose={() => setCard(null)}>
            {card === 'trace' && trace !== undefined ? <MemoryTraceCard trace={trace} />
              : card === 'changes' && changes !== undefined ? <MemoryChangesCard changes={changes} /> : null}
          </AnchoredCard>
        </>
      ) : null}
    </div>
  )
}

/** A memory card opened from a menu row, hung off the button that opened the menu. */
function AnchoredCard({ anchor, open, onClose, children }: {
  anchor: RefObject<HTMLButtonElement>
  open: boolean
  onClose: () => void
  children: ReactNode
}) {
  const [placement, setPlacement] = useState<Placement | null>(null)
  const card = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const trigger = anchor.current
    if (!open || trigger === null) return
    const region = trigger.closest(`[${BOUNDS_ATTRIBUTE}]`)?.getBoundingClientRect() ?? null
    setPlacement(placeCard(trigger.getBoundingClientRect(), region, { width: window.innerWidth, height: window.innerHeight }))
  }, [open, anchor])
  useDismiss(open, onClose, { within: [card], layoutMoved: true, escape: true, windowBlur: true })
  if (typeof document === 'undefined') return null
  return createPortal(
    <Popover
      ref={card}
      open={open && placement !== null}
      origin={placement?.upward === false ? 'top-left' : 'bottom-left'}
      className="fixed z-30 overflow-y-auto rounded-xl border border-line surface-floating shadow-popover"
      style={{
        left: placement?.left ?? 0,
        width: placement?.width ?? CARD_WIDTH,
        maxHeight: placement?.maxHeight,
        ...(placement?.top === undefined ? {} : { top: placement.top }),
        ...(placement?.bottom === undefined ? {} : { bottom: placement.bottom }),
      }}
      contentClassName="px-4 py-3.5"
      role="dialog"
    >
      {children}
    </Popover>,
    document.body,
  )
}

const changesLabel = (changes: MemoryChange[]) => {
  const count = changes.reduce((total, change) => total + change.lines.length, 0)
  return `Memory updated, ${count === 1 ? '1 change' : `${count} changes`}`
}

interface Placement {
  left: number
  width: number
  maxHeight: number
  /** The card sits over the answer it belongs to; below is only where above has no room. */
  upward: boolean
  top?: number
  bottom?: number

}

/** The edges of a box, which is every property of a `DOMRect` this needs. */
interface Box {
  left: number
  right: number
  top: number
  bottom: number
}

/** Fit the card to its conversation region; DOM stacking handles overlapping browser guests. */
export function placeCard(
  trigger: Box,
  region: Box | null,
  viewport: { width: number; height: number },
): Placement {
  const leftEdge = Math.max(INSET, region?.left ?? 0)
  const rightEdge = Math.min(viewport.width - INSET, region?.right ?? viewport.width)
  const width = Math.max(MIN_CARD_WIDTH, Math.min(CARD_WIDTH, rightEdge - leftEdge))
  const above = trigger.top - GAP - INSET
  const below = viewport.height - trigger.bottom - GAP - INSET
  // Over the answer by preference: the card is a second opinion about the text still
  // being read, and below the mark there is usually the next turn rather than room.
  const upward = above >= MIN_CARD || above >= below
  return {
    left: Math.max(leftEdge, Math.min(trigger.left, rightEdge - width)),
    width,
    upward,
    maxHeight: Math.max(MIN_CARD, upward ? above : below),
    ...(upward ? { bottom: viewport.height - trigger.top + GAP } : { top: trigger.bottom + GAP }),
  }
}

function MemoryMark({ trace }: { trace: MemoryTrace }) {
  return (
    <CardMark icon={Brain02Icon} label={markLabel(trace)}>
      <MemoryTraceCard trace={trace} />
    </CardMark>
  )
}

function MemoryChangesMark({ changes }: { changes: MemoryChange[] }) {
  return (
    <CardMark icon={NoteEditIcon} label={changesLabel(changes)}>
      <MemoryChangesCard changes={changes} />
    </CardMark>
  )
}

/**
 * A footer mark and the card it opens, on hover, focus or press.
 *
 * The card hangs over the bubble rather than pushing it down, because it is a second
 * opinion about an answer that is still the thing being read. It portals out of the
 * transcript's scroller, so the only honest thing to do when that scroller moves is
 * leave: a card measured once and left behind points at the wrong message.
 */
function CardMark({ icon, label, children }: { icon: IconSvgElement; label: string; children: ReactNode }) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  // Once up, the portal stays for the life of the row so the card can play itself out
  // on the way back. It is never rendered on the server, which has no document.
  const [mounted, setMounted] = useState(false)
  const [placement, setPlacement] = useState<Placement | null>(null)
  const openTimer = useRef<number | undefined>(undefined)
  const closeTimer = useRef<number | undefined>(undefined)

  const clear = () => {
    window.clearTimeout(openTimer.current)
    window.clearTimeout(closeTimer.current)
  }
  useEffect(() => clear, [])

  const show = () => {
    clear()
    setMounted(true)
    setOpen(true)
  }
  const hide = () => {
    clear()
    setOpen(false)
  }
  const scheduleShow = (pointerType: string) => {
    // Touch has no hover, and a finger resting on a 28px mark must not arm anything;
    // the press below opens it instead.
    if (pointerType !== 'mouse') return
    clear()
    openTimer.current = window.setTimeout(show, OPEN_DELAY_MS)
  }
  const scheduleHide = () => {
    clear()
    closeTimer.current = window.setTimeout(hide, CLOSE_DELAY_MS)
  }

  useLayoutEffect(() => {
    const trigger = triggerRef.current
    if (!open || trigger === null) return
    const region = trigger.closest(`[${BOUNDS_ATTRIBUTE}]`)?.getBoundingClientRect() ?? null
    setPlacement(
      placeCard(trigger.getBoundingClientRect(), region, {
        width: window.innerWidth,
        height: window.innerHeight,
      }),
    )
  }, [open])

  useDismiss(open, hide, { layoutMoved: true, escape: true, windowBlur: true })

  // Generated rather than derived from the trace: two turns that both read nothing
  // would otherwise share one id, and a transcript is full of both.
  const cardId = useId()
  return (
    <>
      <IconButton
        ref={triggerRef}
        icon={icon}
        iconSize={15}
        size={28}
        selected={open}
        label={label}
        aria-expanded={open}
        {...(open ? { 'aria-describedby': cardId } : {})}
        onPointerEnter={(event) => scheduleShow(event.pointerType)}
        onPointerLeave={scheduleHide}
        onFocus={show}
        onBlur={hide}
        onClick={() => (open ? hide() : show())}
      />
      {!mounted || typeof document === 'undefined'
        ? null
        : createPortal(
            <Popover
              open={open && placement !== null}
              // Only where the card could not otherwise be seen at all. Blanking a
              // whole browser panel because a pointer rested on an icon in the
              // transcript is a side effect out of all proportion to a hover.
              origin={placement?.upward === false ? 'top-left' : 'bottom-left'}
              className="fixed z-30 overflow-y-auto rounded-xl border border-line surface-floating shadow-popover"
              style={{
                left: placement?.left ?? 0,
                width: placement?.width ?? CARD_WIDTH,
                maxHeight: placement?.maxHeight,
                ...(placement?.top === undefined ? {} : { top: placement.top }),
                ...(placement?.bottom === undefined ? {} : { bottom: placement.bottom }),
              }}
              contentClassName="px-4 py-3.5"
              role="tooltip"
              id={cardId}
            >
              <div onPointerEnter={clear} onPointerLeave={scheduleHide}>
                {children}
              </div>
            </Popover>,
            document.body,
          )}
    </>
  )
}

/** What the mark says on its own, for a pointer that rests on it and for a reader who cannot see it. */
function markLabel(trace: MemoryTrace): string {
  switch (trace.summary.status) {
    case 'used':
      return `Memory used, ${trace.summary.items.length === 1 ? '1 note' : `${trace.summary.items.length} notes`}`
    case 'none':
      return 'Memory read, none of it used'
    case 'not_read':
      return 'No memory read this turn'
    case 'unavailable':
      return 'Memory use could not be established'
  }
}

/**
 * What the turn stood on, and where each piece came from.
 *
 * Two different kinds of truth live in here and they are never mixed. What was opened
 * is observed: Manor watched the reads go past and the paths are exact. What was
 * *used* is a separate cheap model's reading of the answer afterwards, so the card
 * says so in as many words at the bottom rather than presenting a guess as a record.
 *
 * The empty endings matter more than the full one. A turn that read three memory
 * files and used none of them looks identical to a good turn from the outside, and
 * that gap is the only thing the event stream cannot show on its own.
 */
export function MemoryTraceCard({ trace }: { trace: MemoryTrace }) {
  const summary = trace.summary
  if (summary.status === 'not_read') {
    return <p className="m-0 text-label leading-5 text-muted">No memory was read this turn.</p>
  }
  if (summary.status === 'used') {
    return (
      <div className="flex flex-col gap-3">
        <ul className="m-0 flex list-none flex-col gap-3.5 p-0">
          {summary.items.map((item, index) => (
            <li key={`${item.sourcePath}:${index}`} className="flex min-w-0 flex-col gap-1">
              <Claim text={item.text} />
              <SourceChip path={item.sourcePath} />
            </li>
          ))}
        </ul>
        <Derivation>Inferred after the turn, {readsLabel(trace.reads)}</Derivation>
      </div>
    )
  }
  const paths = distinctReadPaths(trace.reads)
  return (
    <div className="flex flex-col gap-2">
      <div className="flex min-w-0 items-start gap-2">
        {summary.status === 'none' ? (
          // The one ending worth a colour: read and unused is the failure that is
          // invisible everywhere else, and it reads exactly like a good turn without it.
          <span className="mt-[5px] h-1.5 w-1.5 flex-none rounded-full bg-danger" aria-hidden="true" />
        ) : null}
        <span className="min-w-0 flex-1 text-label leading-5 text-text">
          {summary.status === 'none' ? 'Nothing from memory in the answer' : 'Could not establish what the answer used'}
        </span>
      </div>
      {/* One running line rather than a chip each. Chips in a wrapping row all shrink
          together, so six of them turned into six single letters and an ellipsis:
          a list of filenames that named no file. Names wrap here like words, and the
          path nobody can fit is on the title where hovering finds it. */}
      <p className="m-0 text-meta leading-5 text-muted">
        {paths.map((path, index) => (
          <Fragment key={path}>
            {index === 0 ? null : <span className="text-dim">, </span>}
            <span className="font-mono" title={path}>
              {baseName(path)}
            </span>
          </Fragment>
        ))}
      </p>
      <Derivation>
        {summary.status === 'none' ? 'Inferred after the turn, ' : ''}
        {readsLabel(trace.reads)}
      </Derivation>
    </div>
  )
}

/** Past this the card is a document, and the claim it is cutting is one of five. */
const CLAIM_LINES = 3

/**
 * One inferred claim, cut to three lines with the way back underneath it.
 *
 * The same `.clamp` the chat bubbles use, at a third of their height, because these
 * arrive at whatever length the deriving model felt like and five loose paragraphs
 * made the card taller than the answer it was explaining. The link hangs on a
 * measured overflow rather than on a character count, so it never offers to expand
 * something that is already whole; at three lines most claims never show it at all.
 */
function Claim({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const [clipped, setClipped] = useState(false)
  const body = useRef<HTMLParagraphElement>(null)

  useLayoutEffect(() => {
    const node = body.current
    // Closed only: open, the two heights agree by definition and re-measuring here
    // would delete the way back the moment it is used.
    if (node === null || open) return
    const measure = () => setClipped(node.scrollHeight - node.clientHeight > 1)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [open, text])

  return (
    <>
      <p
        ref={body}
        className="clamp m-0 text-meta leading-[1.5] text-text"
        data-open={open}
        data-clipped={clipped}
        style={{ '--clamp-lines': CLAIM_LINES, '--clamp-fade-lines': 1.1 } as CSSProperties}
      >
        {text}
      </p>
      {clipped || open ? (
        <button
          type="button"
          aria-expanded={open}
          className="cursor-pointer self-start border-0 bg-transparent p-0 text-meta text-dim [font:inherit] hover:text-muted"
          onClick={() => setOpen((current) => !current)}
        >
          {open ? 'Show less' : 'Show more'}
        </button>
      ) : null}
    </>
  )
}

/**
 * The line that keeps the card honest. Everything above it about *use* came from a
 * second model reading the answer, and a citation that does not say so is a claim
 * dressed as evidence.
 */
function Derivation({ children }: { children: ReactNode }) {
  return <p className="m-0 border-t border-line pt-2.5 text-meta text-dim">{children}</p>
}

/**
 * Where a claim came from, under the claim rather than beside it. Beside it, the
 * text wrapped into half a card while the gutter holding one filename stayed empty
 * for four lines; under it, the claim gets the whole width and the source reads as
 * what it is, a footnote.
 */
function SourceChip({ path }: { path: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5" title={path}>
      <FileMark path={path} size={12} />
      <span className="min-w-0 truncate font-mono text-meta text-muted">{baseName(path)}</span>
    </span>
  )
}

/** A replacement reads as the old line going and the new one arriving, like any diff. */
function changeRows(line: MemoryChangeLine): { kind: 'added' | 'removed'; text: string }[] {
  if (line.kind === 'replaced') {
    return [
      { kind: 'removed', text: line.before },
      { kind: 'added', text: line.after },
    ]
  }
  return [{ kind: line.kind, text: line.text }]
}

/**
 * What the turn wrote into memory, file by file, as the lines it added, dropped or
 * rewrote. Only the changed lines: a daily log is a list of independent facts, so the
 * neighbouring lines a code diff shows for orientation would only be noise here.
 */
export function MemoryChangesCard({ changes }: { changes: MemoryChange[] }) {
  return (
    <div className="flex flex-col gap-3.5">
      {changes
        .filter((change) => change.lines.length > 0)
        .map((change) => (
          <section key={change.path} className="flex min-w-0 flex-col gap-1.5">
            <SourceChip path={change.path} />
            <div className="overflow-hidden rounded-md border border-line">
              <div className="m-0 py-1 font-mono text-meta leading-[1.5]">
                {change.lines.flatMap(changeRows).map((row, index) => (
                  <div
                    key={index}
                    className={
                      row.kind === 'added'
                        ? 'flex bg-[color-mix(in_srgb,var(--color-ok)_15%,transparent)] px-2 text-ok'
                        : 'flex bg-[color-mix(in_srgb,var(--color-danger)_15%,transparent)] px-2 text-danger'
                    }
                  >
                    <span className="mr-2 shrink-0 select-none diff-quiet" aria-hidden="true">
                      {row.kind === 'added' ? '+' : '-'}
                    </span>
                    <span className="sr-only">{row.kind === 'added' ? 'Added: ' : 'Removed: '}</span>
                    <span className="min-w-0 flex-1 whitespace-pre-wrap wrap-anywhere">{row.text}</span>
                  </div>
                ))}
              </div>
            </div>
            {change.truncated ? <p className="m-0 text-meta text-dim">Shortened, only the first lines are shown.</p> : null}
          </section>
        ))}
    </div>
  )
}
