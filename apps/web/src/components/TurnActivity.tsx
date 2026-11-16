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
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { accentStyle } from '../accent'
import { INSTANT, TEXT_SWAP, TEXT_SWAP_ABOVE, TEXT_SWAP_BELOW, TEXT_SWAP_REST } from '../motion'
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
  stepDetail, stepLabel, subagentStepState, traceRows, type StepDetail, type TraceRow,
} from '../turnTrace'
import { AgentBubble } from './Bubbles'
import { AskAnswers } from './AskCard'
import type { DraftActions } from './OutboundDraftBubble'
import { OutboundDraftGroup } from './OutboundDraftGroup'
import { EditGroup } from './EditGroup'
import { Icon } from './Icon'
import { SubagentRows } from './SubagentRows'
import { useSubagentDirectory } from '../subagentContext'
import { TodoList } from './TodoList'

interface TurnActivityProps {
  turn: TurnRow
  persona: Persona
  /** Outer turn fold. Bundles keep their own independent disclosure state inside. */
  open: boolean
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
  turn, persona, agents, open, connected = true, draftActions, onOpenSubagents, waitingOnAgent = false, bubble = false, renderUser,
}: TurnActivityProps) {
  const running = turn.live?.state === 'running'
  const reduce = useReducedMotion() ?? false
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
  const displayed = open
    ? blocks
    : blocks.filter((segment) => segment.kind === 'ask' || segment.kind === 'todo' || segment.kind === 'draft'
      || segment.kind === 'user'
      || (running && segment.kind === 'reply' && segment.live === true)
      || (!bubble && segment.kind === 'subagents' && (running || segment.agents.some((step) => subagentStepState(step, running, directory) === 'running'))))
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
  if (displayed.length === 0 && compactRecord === undefined && traceNotes.length === 0 && !compacting) return null

  return (
    <div className="flex w-full min-w-0 flex-col gap-1.5" style={accentStyle(persona.color)}>
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
            <li key={segment.key} data-chrome="" className="min-w-0">
              <AskAnswers
                questions={segment.ask.questions}
                {...(segment.ask.answers === undefined ? {} : { answers: segment.ask.answers })}
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
            <li key={segment.key} data-chrome="" className="min-w-0">
              <TodoList todos={segment.todos} foldKey={segment.key} />
            </li>
          ) : segment.kind === 'subagents' ? (
            <li key={segment.key} data-chrome="" className="min-w-0">
              <SubagentRows agents={segment.agents} activities={turn.activities} running={running} {...(onOpenSubagents === undefined ? {} : { onOpen: onOpenSubagents })} />
            </li>
          ) : (
            <WorkRun
              key={segment.key}
              steps={segment.steps}
              edits={segment.edits}
              breaks={segment.breaks}
              activeTool={segment.key === active?.key ? active.tool : undefined}
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
function WorkRun({ steps, edits, breaks, activeTool }: { steps: TurnStep[]; edits: FileEdit[]; breaks: ReadonlySet<string>; activeTool?: ToolStep }) {
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
    <li data-chrome="" className="min-w-0 text-[14px] text-dim">
      <button
        type="button"
        className="group/run relative flex w-full min-w-0 cursor-pointer items-start gap-2 border-0 bg-transparent p-0 text-left text-dim [font:inherit] [overflow-wrap:anywhere] hover:text-muted"
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
      {open ? (
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
      ) : null}
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
      <button
        type="button"
        className={`group/row flex w-full min-w-0 cursor-pointer items-start gap-2 border-0 bg-transparent p-0 text-left [font:inherit] hover:text-muted ${live === undefined ? 'text-dim' : 'text-muted'}`}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={`mt-[4px] shrink-0 ${live === undefined ? 'text-dim' : 'text-[var(--accent-fg)]'}`}>
          <Icon icon={toolIcon(group.steps[0]!.tool)} size={14} />
        </span>
        <span className="min-w-0 truncate">{label}</span>
        {group.family === 'same' ? <span className="shrink-0 text-dim">×{group.steps.length}</span> : null}
        <RowChevron open={open} />
      </button>
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
  const face = (
    <>
      <span className={`mt-[4px] shrink-0 ${current ? 'text-[var(--accent-fg)]' : 'text-dim'}`}>
        <Icon icon={statusIcon} size={14} />
      </span>
      <span className="min-w-0 truncate">{label}</span>
    </>
  )
  return (
    <li className={`min-w-0 text-[14px] ${current ? 'text-muted' : 'text-dim'}`}>
      {detail === undefined ? (
        <div className="flex min-w-0 items-start gap-2">{face}</div>
      ) : (
        <button
          type="button"
          className="group/row flex w-full min-w-0 cursor-pointer items-start gap-2 border-0 bg-transparent p-0 text-left text-inherit [font:inherit] hover:text-muted"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {face}
          <RowChevron open={open} />
        </button>
      )}
      {open && detail !== undefined ? <StepDetailBlock detail={detail} /> : null}
    </li>
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
