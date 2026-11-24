import {
  Clock01Icon,
  Brain02Icon,
  CancelCircleIcon,
  ChevronDownIcon,
  CommandLineIcon,
  PencilEdit02Icon,
  Search01Icon,
  ViewIcon,
  Wrench01Icon,
} from '@hugeicons/core-free-icons'
import { ROUTINE_LATE_AFTER_MS, type AgentConfig, type FileEdit } from '@manor/contracts'
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { AnimatePresence, animate, motion, useReducedMotion } from 'motion/react'
import { accentStyle } from '../accent'
import { DISCLOSURE, DISCLOSURE_OUT, INSTANT, TEXT_SWAP, TEXT_SWAP_ABOVE, TEXT_SWAP_BELOW, TEXT_SWAP_REST } from '../motion'
import {
  type Persona,
  type ReasoningStep,
  type Row,
  type RoutineTrigger,
  type ToolStep,
  type TurnActivity as TurnStep,
  type TurnRow,
  liveWritten,
} from '../state'
import {
  currentLabel,
  isEditTool,
  isReadTool,
  isSearchTool,
  isShellTool,
  workSummary,
} from '../turnLabels'
import {
  activeCall, activityBlocks, backgroundWaitLabel, groupLabel, isCompacting, isSettledCompactNote, isWaiting, shownSegments,
  stepDetail, stepImages, stepLabel, subagentStepState, thumbnailStrip, traceRows, type StepDetail, type StepImage, type TraceRow,
} from '../turnTrace'
import { AgentBubble } from './Bubbles'
import { AskAnswers } from './AskCard'
import type { DraftActions } from './OutboundDraftBubble'
import { OutboundDraftGroup } from './OutboundDraftGroup'
import { EditGroup } from './EditGroup'
import { ZoomableImage } from './ui/ZoomableImage'
import { Icon } from './Icon'
import { SubagentRows } from './SubagentRows'
import { useSubagentDirectory } from '../subagentContext'
import { TodoList } from './TodoList'
import { MiddleCut } from './MiddleCut'

interface TurnActivityProps {
  turn: TurnRow
  persona: Persona
  /** Outer turn fold. Bundles keep their own independent disclosure state inside. */
  open: boolean
  /**
   * The user's last click on the fold, with the list's height just before it. Only a
   * click animates: a turn folding itself when it starts or settles changes at once.
   */
  foldToggle?: FoldToggle
  /** The list's own element, which the owner measures when the user clicks the fold. */
  rootRef?: RefObject<HTMLDivElement>
  /** Passed straight through to the replies folded in here, which mention like any other. */
  agents: readonly AgentConfig[]
  connected?: boolean
  draftActions?: DraftActions
  /** Opens one helper in the Subagents panel, by its launch call id. Absent where there is nowhere to open it. */
  onOpenSubagents?: (toolCallId: string) => void
  /** The turn is waiting on another agent's reply, so it is not thinking. */
  waitingOnAgent?: boolean
  /** A DM, which shows no helper cards outside the open trace: the sidebar and Agents reach them. */
  bubble?: boolean
  /**
   * Draws one steering message the user sent into this running turn, with the same
   * chrome as a top-level message row. Absent where a turn has none.
   */
  renderUser?: (row: Extract<Row, { kind: 'event' }>) => ReactNode
}

export interface FoldToggle {
  id: number
  /** The list's height in px before the click; 0 when nothing was drawn. */
  from: number
  /** Whether the click opened the fold. */
  opens: boolean
}

/**
 * The gap the turn's column puts beside this list, and on which side. A list that
 * mounts or unmounts brings that gap with it, so the fold folds it too.
 */
function columnGap(node: HTMLElement): { side: 'marginTop' | 'marginBottom'; px: number } | undefined {
  let item = node
  while (item.parentElement !== null && getComputedStyle(item.parentElement).display === 'contents') item = item.parentElement
  const column = item.parentElement
  if (column === null) return undefined
  const px = Number.parseFloat(getComputedStyle(column).rowGap) || 0
  if (px === 0) return undefined
  if (item.previousElementSibling !== null) return { side: 'marginTop', px }
  if (item.nextElementSibling !== null) return { side: 'marginBottom', px }
  return undefined
}

/**
 * The icon says what kind of step it was, not whether it worked. A column of
 * identical checkmarks is unreadable at twenty steps, and success is already the
 * default — only failure is worth a status glyph, and it gets the red one below.
 */
function toolIcon(tool: string) {
  if (isReadTool(tool)) return ViewIcon
  if (isSearchTool(tool)) return Search01Icon
  if (isEditTool(tool)) return PencilEdit02Icon
  if (isShellTool(tool)) return CommandLineIcon
  return Wrench01Icon
}

export function TurnActivity({
  turn, persona, agents, open: foldOpen, foldToggle, rootRef, connected = true, draftActions, onOpenSubagents, waitingOnAgent = false,
  bubble = false, renderUser,
}: TurnActivityProps) {
  const running = turn.live?.state === 'running'
  const reduce = useReducedMotion() ?? false
  const ownRoot = useRef<HTMLDivElement>(null)
  const root = rootRef ?? ownRoot
  const [playedFold, setPlayedFold] = useState(foldToggle?.id)
  const shown = shownSegments(turn.segments)
  const visible = shown.filter((segment) => {
    if (segment.kind === 'ask') return segment.ask.answers !== undefined || !running
    if (segment.kind === 'todo') return segment.todos.length > 0
    return true
  })
  const blocks = activityBlocks(visible)
  // Helpers stay visible in a folded turn while it runs, and a batch of them (launches
  // with no narration between) while any of its children still works past it:
  // their work is the part nobody can see otherwise. Settled,
  // they fold with the rest. A DM keeps them in the fold: helpers are Session work.
  // The user's steering messages are their own words, not work: they stay in order even
  // in a closed fold, and so does a reply still streaming in beside them.
  const directory = useSubagentDirectory()
  const folded = blocks.filter((segment) => segment.kind === 'ask' || segment.kind === 'todo' || segment.kind === 'draft'
    || segment.kind === 'user'
    || (running && segment.kind === 'reply' && segment.live === true)
    || (!bubble && segment.kind === 'subagents' && (running || segment.agents.some((step) => subagentStepState(step, running, directory) === 'running'))))
  // A click still folding. Closing onto nothing keeps the open rows until the fold is
  // shut, so they fold away instead of vanishing and taking the height with them.
  const pendingFold = foldToggle !== undefined && foldToggle.id !== playedFold
  // A turn opening or closing itself mid-fold wins: the fold settles where the turn put it.
  const folding = pendingFold && !reduce && foldOpen === foldToggle.opens
  const closingAway = folding && !foldToggle.opens && !foldOpen && folded.length === 0
  const open = foldOpen || closingAway
  const displayed = open ? blocks : folded
  const tailBlock = blocks.at(-1)
  const active = activeCall(turn, blocks)
  // Narration with nothing after it yet: the next step has not surfaced, so the turn
  // is thinking. Together with a running call's compact label this is the only text
  // that shimmers in a turn; the status beside the name leaves that to the avatar.
  const thinking =
    open &&
    running &&
    tailBlock?.kind === 'reply' &&
    !isWaiting(turn) &&
    // Answered and waiting on background work: the status beside the name says so.
    backgroundWaitLabel(turn) === undefined &&
    !waitingOnAgent &&
    !isCompacting(turn) &&
    !liveWritten(turn.live)

  // The session's history is being rewritten: Manor's live compact or the CLI's own.
  // It takes Thinking's place and settles the same way when the work resumes.
  const compacting = open && isCompacting(turn)
  const pulse = compacting ? 'Compacting' : thinking ? 'Thinking' : undefined

  const compactRecord = open && isSettledCompactNote(turn.note) ? turn.note : undefined
  // Manor's bookkeeping about this turn: there for whoever opens the trace, nowhere else.
  const traceNotes = open ? turn.traceNotes ?? [] : []

  // The list eases from the height it had before the click to the one it has now, and
  // what sits under it slides along. Mounting or unmounting, it fades and takes its gap.
  useLayoutEffect(() => {
    if (!pendingFold) return undefined
    const settle = () => setPlayedFold(foldToggle.id)
    if (!folding) {
      settle()
      return undefined
    }
    const node = root.current
    if (node === null) {
      settle()
      return undefined
    }
    const to = closingAway ? 0 : node.offsetHeight
    if (to === foldToggle.from) {
      settle()
      return undefined
    }
    const gap = foldToggle.from === 0 || to === 0 ? columnGap(node) : undefined
    const fade = gap === undefined ? {} : { opacity: foldToggle.from === 0 ? [0, 1] : [1, 0] }
    const margin = gap === undefined ? {} : { [gap.side]: foldToggle.from === 0 ? [-gap.px, 0] : [0, -gap.px] }
    node.style.overflow = 'hidden'
    const controls = animate(
      node,
      { height: [foldToggle.from, to], ...fade, ...margin },
      foldToggle.opens ? DISCLOSURE : DISCLOSURE_OUT,
    )
    let done = false
    void controls.then(() => {
      done = true
      settle()
    })
    return () => {
      controls.stop()
      // Interrupted by the next click, or finished: the list goes back to its own height.
      // A list that closed onto nothing is about to unmount and keeps its folded style.
      if (done && to === 0) return
      node.style.removeProperty('height')
      node.style.removeProperty('opacity')
      node.style.removeProperty('overflow')
      if (gap !== undefined) node.style.removeProperty(gap.side === 'marginTop' ? 'margin-top' : 'margin-bottom')
    }
  }, [pendingFold, folding, foldToggle, closingAway, root])

  if (displayed.length === 0 && compactRecord === undefined && traceNotes.length === 0 && !compacting) return null
  // In a DM every card runs as wide as a bubble may grow; replies and user rows size themselves.
  const card = bubble ? 'min-w-0 max-w-bubble' : 'min-w-0'

  return (
    <div ref={root} className="flex w-full min-w-0 flex-col gap-1.5" style={accentStyle(persona.color)}>
      {/* Narration is the boundary. Every uninterrupted run between two things the
          agent said becomes one capped accordion: closed it is one useful line,
          opened it is the complete scrollable record. */}
      <ol className="flex list-none flex-col gap-2 p-0">
        {open && turn.routineTrigger !== undefined ? <RoutineTriggerRow trigger={turn.routineTrigger} /> : null}
        {displayed.map((segment) =>
          segment.kind === 'user' ? (
            renderUser === undefined ? null : (
              <li key={segment.key} className="min-w-0">{renderUser(segment.row)}</li>
            )
          ) : segment.kind === 'reply' ? (
            // The ids let Open report land on a report written before `goal_reached`.
            // A reply still streaming has no durable event yet, so it carries none.
            <li
              key={segment.key}
              data-chrome={segment.live === true ? undefined : ''}
              {...(segment.live === true && segment.quoteSources.length === 0 ? {} : { 'data-message-ids': segment.quoteSources.map((source) => source.eventId).join(' ') })}
              className="min-w-0"
            >
              <AgentBubble
                color={persona.color}
                text={segment.text}
                agents={agents}
                images={segment.images}
                {...(segment.live === true ? { live: running } : {})}
              />
            </li>
          ) : segment.kind === 'ask' ? (
            <li key={segment.key} data-chrome="" className={card}>
              <AskAnswers
                questions={segment.ask.questions}
                {...(segment.ask.answers === undefined ? {} : { answers: segment.ask.answers })}
                superseded={segment.ask.superseded === true}
              />
            </li>
          ) : segment.kind === 'draft' ? (
            <li key={segment.key} data-chrome="" className="min-w-0">
              <OutboundDraftGroup
                bubble={bubble}
                color={persona.color}
                connected={connected}
                drafts={segment.drafts}
                {...(draftActions === undefined ? {} : { actions: draftActions })}
              />
            </li>
          ) : segment.kind === 'todo' ? (
            <li key={segment.key} data-chrome="" className={card}>
              <TodoList todos={segment.todos} foldKey={segment.key} />
            </li>
          ) : segment.kind === 'subagents' ? (
            <li key={segment.key} data-chrome="" className={card}>
              <SubagentRows agents={segment.agents} activities={turn.activities} running={running} {...(onOpenSubagents === undefined ? {} : { onOpen: onOpenSubagents })} />
            </li>
          ) : (
            <WorkRun
              key={segment.key}
              steps={segment.steps}
              edits={segment.edits}
              breaks={segment.breaks}
              activeTool={segment.key === active?.key ? active.tool : undefined}
              card={card}
            />
          ),
        )}
        <AnimatePresence initial={false}>
          {pulse === undefined ? null : (
            <motion.li
              key={pulse}
              data-chrome=""
              className="min-w-0 text-[14px]"
              initial={reduce ? false : TEXT_SWAP_BELOW}
              animate={TEXT_SWAP_REST}
              exit={{ opacity: 0 }}
              transition={reduce ? INSTANT : TEXT_SWAP}
            >
              <span className="shimmer-text" data-text={pulse}>{pulse}</span>
            </motion.li>
          )}
        </AnimatePresence>
        {compactRecord === undefined ? null : (
          <li data-chrome="" className="min-w-0 text-[14px] text-dim">{compactRecord.text}</li>
        )}
        {traceNotes.map((note) => (
          <li key={note.key} data-chrome="" className="min-w-0 text-[14px] text-dim [overflow-wrap:anywhere]">{note.text}</li>
        ))}
      </ol>
    </div>
  )
}

/** One compact activity bundle between two narration messages. */
function WorkRun({ steps, edits, breaks, activeTool, card }: { steps: TurnStep[]; edits: FileEdit[]; breaks: ReadonlySet<string>; activeTool?: ToolStep; card: string }) {
  const [open, setOpen] = useState(false)
  const reduce = useReducedMotion() ?? false
  // A failed call is settled, so shimmer must never make it look in flight.
  const current = activeTool?.status === 'error' ? undefined : activeTool
  const summary = workSummary(steps, edits.length > 0)
  const label = current === undefined ? summary.label : currentLabel(current)
  const faceKey = current === undefined ? `summary:${label}` : `tool:${current.key}`
  const rows = traceRows(steps, breaks).map((row) =>
    row.kind === 'reasoning' ? (
      <ReasoningRow key={row.key} step={row.step} />
    ) : row.kind === 'group' ? (
      <GroupRow key={row.key} group={row} current={current} />
    ) : (
      <ToolRow key={row.key} step={row.step} active={row.step.key === current?.key} />
    ),
  )
  const currentIsInRows = current !== undefined && steps.some((step) => step.key === current.key)

  return (
    <li data-chrome="" className={`${card} text-[14px] text-dim`}>
      <div className="flex min-w-0 items-start">
        <button
          type="button"
          className="group/run relative flex min-w-0 flex-1 cursor-pointer items-start gap-2 border-0 bg-transparent p-0 text-left text-dim [font:inherit] [overflow-wrap:anywhere] hover:text-muted"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {/* The compact line is one changing status, words only, like the sidebar's
              Working / Done swap. Keying a live call by its id also moves between two
              reads whose labels happen to match. */}
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={faceKey}
              className="flex min-w-0"
              initial={reduce ? false : TEXT_SWAP_BELOW}
              animate={TEXT_SWAP_REST}
              exit={reduce ? { opacity: 0 } : TEXT_SWAP_ABOVE}
              transition={reduce ? INSTANT : TEXT_SWAP}
            >
              <span
                className={`min-w-0 truncate ${current === undefined ? '' : 'shimmer-text'}`}
                {...(current === undefined ? {} : { 'data-text': label })}
              >
                {label}
              </span>
            </motion.span>
          </AnimatePresence>
          <span
            className={`mt-[5px] shrink-0 text-dim opacity-0 transition-[opacity,transform,color] duration-200 ease-overshoot group-hover/run:opacity-100 group-focus-visible/run:opacity-100 ${
              open ? 'rotate-180 opacity-100' : ''
            }`}
          >
            <Icon icon={ChevronDownIcon} size={12} />
          </span>
        </button>
        <Thumbnails images={stepImages(steps)} />
      </div>
      {/* The rows fold out of the line that holds them, so the bubbles under it slide
          instead of jumping by the list's height. */}
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            key="rows"
            className="overflow-hidden"
            initial={reduce ? false : { height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={reduce ? { opacity: 0, transition: INSTANT } : { height: 0, opacity: 0, transition: DISCLOSURE_OUT }}
            transition={reduce ? INSTANT : DISCLOSURE}
          >
            <ActivityScroll revision={`${String(steps.length)}:${String(edits.length)}`} followEnd={current !== undefined}>
              {edits.length === 0 ? null : (
                <li className="min-w-0">
                  <EditGroup edits={edits} unfolded />
                </li>
              )}
              {rows}
              {current === undefined || currentIsInRows ? null : (
                <ToolRow key={`active:${current.key}`} step={current} active />
              )}
            </ActivityScroll>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </li>
  )
}

/** A fixed-height list whose edge fades only appear where more rows are hidden. */
function ActivityScroll({ children, revision, followEnd }: { children: ReactNode; revision: string; followEnd: boolean }) {
  const scroller = useRef<HTMLOListElement>(null)
  const pinned = useRef(true)
  const [edges, setEdges] = useState({ top: false, bottom: false })

  const sync = () => {
    const node = scroller.current
    if (node === null) return
    const next = {
      top: node.scrollTop > 1,
      bottom: node.scrollHeight - node.scrollTop - node.clientHeight > 1,
    }
    pinned.current = !next.bottom
    setEdges((current) => current.top === next.top && current.bottom === next.bottom ? current : next)
  }

  useLayoutEffect(() => {
    const node = scroller.current
    if (node === null) return undefined
    const follow = () => {
      if (followEnd && pinned.current) node.scrollTop = node.scrollHeight
      sync()
    }
    follow()
    const observer = new ResizeObserver(follow)
    observer.observe(node)
    if (node.firstElementChild !== null) observer.observe(node.firstElementChild)
    return () => observer.disconnect()
  }, [revision, followEnd])

  return (
    <div className="relative mt-1.5 ml-[14px] min-w-0">
      <ol
        ref={scroller}
        data-activity-scroller
        className="flex max-h-[264px] list-none flex-col gap-1 overflow-y-auto py-1 pr-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        onScroll={sync}
      >
        {children}
      </ol>
      <div
        aria-hidden="true"
        className={`pointer-events-none absolute inset-x-0 top-0 h-6 bg-gradient-to-b from-bg to-transparent transition-opacity ${edges.top ? 'opacity-100' : 'opacity-0'}`}
      />
      <div
        aria-hidden="true"
        className={`pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t from-bg to-transparent transition-opacity ${edges.bottom ? 'opacity-100' : 'opacity-0'}`}
      />
    </div>
  )
}

/**
 * The model's own trace. Collapsed to a couple of lines by default: it is context
 * for a surprising answer, not the answer, and a wall of reasoning above every reply
 * would bury the thing the user actually came to read.
 */
function ReasoningRow({ step }: { step: ReasoningStep }) {
  const [open, setOpen] = useState(false)
  return (
    <li data-chrome="" className="flex min-w-0 items-start gap-2">
      <span className="mt-[4px] shrink-0 text-dim">
        <Icon icon={Brain02Icon} size={14} />
      </span>
      <div className="min-w-0 flex-1">
        <button
          type="button"
          className="w-full cursor-pointer border-0 bg-transparent p-0 text-left text-[12px] text-dim [font:inherit] hover:text-muted"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="italic [overflow-wrap:anywhere]">
            {open ? 'Thought' : firstLine(step.text)}
          </span>
        </button>
        {open ? (
          <p className="mt-1 mb-0 whitespace-pre-wrap text-[12px] leading-[1.55] text-muted italic [overflow-wrap:anywhere]">
            {step.text}
          </p>
        ) : null}
      </div>
    </li>
  )
}

const CLOCK = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })
const LATE_DUE = new Intl.DateTimeFormat('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })

/**
 * The routine fire that started a DM turn, as the first line of its fold rather than a
 * marker in the conversation. Opens onto the prompt, for the moment the answer makes
 * no sense and the question explains why.
 */
function RoutineTriggerRow({ trigger }: { trigger: RoutineTrigger }) {
  const [open, setOpen] = useState(false)
  const late = trigger.dueAt !== undefined && trigger.ts - trigger.dueAt > ROUTINE_LATE_AFTER_MS
  return (
    <li className="flex min-w-0 items-start gap-2">
      <span className="mt-[4px] shrink-0 text-dim">
        <Icon icon={Clock01Icon} size={14} />
      </span>
      <div className="min-w-0 flex-1">
        <button
          type="button"
          className="w-full cursor-pointer border-0 bg-transparent p-0 text-left text-[12px] text-dim [font:inherit] hover:text-muted"
          aria-expanded={open}
          title={open ? 'Hide the prompt' : 'Show the prompt'}
          onClick={() => setOpen((value) => !value)}
        >
          Routine{trigger.name === undefined ? '' : `, ${trigger.name}`}, {CLOCK.format(new Date(trigger.ts))}
          {late && trigger.dueAt !== undefined ? `, late, due ${LATE_DUE.format(new Date(trigger.dueAt))}` : ''}
        </button>
        {open ? (
          <p className="mt-1 mb-0 whitespace-pre-wrap text-[12px] leading-[1.55] text-muted [overflow-wrap:anywhere]">
            {trigger.prompt}
          </p>
        ) : null}
      </div>
    </li>
  )
}

/** The collapsed peek at a reasoning block: enough to recognise, never a paragraph. */
function firstLine(text: string): string {
  const line = text.split('\n').find((candidate) => candidate.trim().length > 0)?.trim() ?? 'Thought'
  return line.length > 110 ? `${line.slice(0, 107)}…` : line
}

/**
 * Consecutive reads, searches or identical calls as one line that opens onto each call.
 * While one of its calls runs, the line carries that call's live label instead; like a
 * live step row it never shimmers, which stays the run's own closed line.
 */
function GroupRow({ group, current }: { group: Extract<TraceRow, { kind: 'group' }>; current?: ToolStep }) {
  const [open, setOpen] = useState(false)
  const live = current !== undefined && group.steps.some((step) => step.key === current.key) ? current : undefined
  const label = live === undefined ? groupLabel(group) : currentLabel(live)
  return (
    <li className="min-w-0 text-[14px]">
      <div className="flex min-w-0 items-start">
        <button
          type="button"
          className={`group/row flex min-w-0 flex-1 cursor-pointer items-start gap-2 border-0 bg-transparent p-0 text-left [font:inherit] hover:text-muted ${live === undefined ? 'text-dim' : 'text-muted'}`}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <span className={`mt-[4px] shrink-0 ${live === undefined ? 'text-dim' : 'text-[var(--accent-fg)]'}`}>
            <Icon icon={toolIcon(group.steps[0]!.tool)} size={14} />
          </span>
          <MiddleCut text={label} />
          {group.family === 'same' ? <span className="shrink-0 text-dim">×{group.steps.length}</span> : null}
          <RowChevron open={open} />
        </button>
        <Thumbnails images={stepImages(group.steps)} />
      </div>
      {open ? (
        <ol className="mt-1 ml-[22px] flex list-none flex-col gap-1 p-0">
          {group.steps.map((step) => <ToolRow key={step.key} step={step} active={step.key === current?.key} />)}
        </ol>
      ) : null}
    </li>
  )
}

function RowChevron({ open }: { open: boolean }) {
  return (
    <span
      className={`mt-[5px] shrink-0 text-dim opacity-0 transition-[opacity,transform] duration-200 ease-overshoot group-hover/row:opacity-100 group-focus-visible/row:opacity-100 ${
        open ? 'rotate-180 opacity-100' : ''
      }`}
    >
      <Icon icon={ChevronDownIcon} size={12} />
    </span>
  )
}

/**
 * One line per step, opening onto what the line leaves out: the exact command, every
 * full path and, for a failed call, the first line of why. Failure is named in words
 * and by its icon, never by colour.
 *
 * The command sits one click down rather than on the row. Codex has no native read
 * tool, so nearly every one of its steps carries a raw shell command, and showing it
 * under each row repeated what the label and the file paths already said. A command
 * the driver could not resolve into anything better labels itself by its cleaned text
 * or a family name ("Ran tests"); a described one by the provider's own description.
 */
function ToolRow({ step, active }: { step: ToolStep; active: boolean }) {
  const [open, setOpen] = useState(false)
  const current = active && step.status !== 'error'
  const statusIcon = step.status === 'error' ? CancelCircleIcon : toolIcon(step.tool)
  const label = stepLabel(step, active)
  const detail = stepDetail(step)
  const images = stepImages([step])
  const face = (
    <>
      <span className={`mt-[4px] shrink-0 ${current ? 'text-[var(--accent-fg)]' : 'text-dim'}`}>
        <Icon icon={statusIcon} size={14} />
      </span>
      <MiddleCut text={label} />
    </>
  )
  return (
    <li className={`min-w-0 text-[14px] ${current ? 'text-muted' : 'text-dim'}`}>
      {detail === undefined ? (
        <div className="flex min-w-0 items-start gap-2">{face}<Thumbnails images={images} /></div>
      ) : (
        <div className="flex min-w-0 items-start">
          <button
            type="button"
            className="group/row flex min-w-0 flex-1 cursor-pointer items-start gap-2 border-0 bg-transparent p-0 text-left text-inherit [font:inherit] hover:text-muted"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            {face}
            <RowChevron open={open} />
          </button>
          <Thumbnails images={images} />
        </div>
      )}
      {open && detail !== undefined ? <StepDetailBlock detail={detail} /> : null}
    </li>
  )
}

/**
 * The pictures a line read or wrote, at its far right: two, then a count of the rest.
 * Each box has its size before the picture arrives and sits inside the line height, so
 * nothing moves when it loads; one that fails to load goes and leaves the count. Each
 * opens the line's pictures in the viewer, the count at the first one it stands for.
 * The strip sits beside the line's own button, never in it, so both stay pressable.
 */
function Thumbnails({ images }: { images: readonly StepImage[] }) {
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set())
  const usable = images.filter((image) => !failed.has(image.src))
  const { shown, more } = thumbnailStrip(usable)
  if (shown.length === 0) return null
  const gallery = usable.map((image) => ({ src: image.src, alt: image.name }))
  return (
    <span className="flex h-0 shrink-0 items-center gap-1 self-center pl-2">
      {shown.map((image, index) => (
        <ZoomableImage
          key={image.key}
          src={image.src}
          alt={image.name}
          frame="flex-none rounded-xs"
          gallery={{ images: gallery, index }}
          thumbnail={
            <img
              src={image.src}
              alt={image.name}
              width={24}
              height={16}
              loading="lazy"
              decoding="async"
              draggable={false}
              onError={() => setFailed((current) => new Set(current).add(image.src))}
              className="block h-4 w-6 rounded-xs bg-surface-2 object-cover"
            />
          }
        />
      ))}
      {more === 0 ? null : (
        <ZoomableImage
          src={usable[shown.length]!.src}
          alt={usable[shown.length]!.name}
          label={`Show ${String(more)} more ${more === 1 ? 'picture' : 'pictures'}`}
          frame="flex-none rounded-xs text-[12px] text-dim tabular-nums hover:text-muted"
          gallery={{ images: gallery, index: shown.length }}
          thumbnail={<span>+{more}</span>}
        />
      )}
    </span>
  )
}

function StepDetailBlock({ detail }: { detail: StepDetail }) {
  return (
    <div className="mt-1 mb-1.5 ml-[22px] flex min-w-0 flex-col gap-1.5 text-[12px] text-muted">
      {detail.error === undefined ? null : <p className="m-0 [overflow-wrap:anywhere]">{detail.error}</p>}
      {detail.targets === undefined ? null : (
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0 font-mono text-meta [overflow-wrap:anywhere]">
          {detail.targets.map((target) => <li key={target}>{target}</li>)}
        </ul>
      )}
      {(detail.command ?? detail.query) === undefined ? null : (
        <pre className="m-0 max-h-[160px] overflow-auto border-0 border-l border-solid border-line pl-2.5 font-mono text-meta leading-[1.5] whitespace-pre-wrap [overflow-wrap:anywhere]">
          {detail.command ?? detail.query}
        </pre>
      )}
    </div>
  )
}
