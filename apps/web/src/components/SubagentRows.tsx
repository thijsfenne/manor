import { useEffect, useId, useRef, useState } from 'react'
import { ArrowRight01Icon } from '@hugeicons/core-free-icons'
import type { WakeItem } from '@manor/contracts'
import { WAKE_NOTICE, launchDriver, subagentElapsed, subagentRowModel, subagentSteps, subagentStepState, type SubagentRowModel, type SubagentState } from '@manor/client-runtime/turn-trace'
import type { ToolStep, TurnActivity } from '../state'
import { useSubagentDirectory, useSubagentLaunches } from '../subagentContext'
import { useNowSecond } from '../useNowSecond'
import { WakeLine } from './Bubbles'
import { Icon } from './Icon'
import { ProviderMark } from './ProviderMark'
import { Tooltip } from './ui/Tooltip'

const DOT: Record<SubagentState, string> = {
  running: 'bg-primary',
  done: 'bg-ok',
  failed: 'bg-danger',
  stopped: 'bg-dim',
}

// A card per helper, as wide as the transcript, a little tighter above and below than at the sides.
const ROW = 'group/subagent flex w-full min-w-0 items-center gap-2.5 rounded-xl border border-line bg-composer-tray px-2.5 py-1.5 text-left text-[12px]'

/** A wake's word on how a helper ended and when, which the row shows in place of its live state. */
interface Notice {
  state: SubagentState
  label: string
  time: string
}

const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** The provider's mark in a round face with a dot for where the helper stands, as T3 draws it. */
function SubagentAvatar({ step, state }: { step: ToolStep; state: SubagentState }) {
  const driver = launchDriver(step.subagent)
  return (
    <span aria-hidden="true" className="relative inline-flex size-6 flex-none items-center justify-center rounded-full border border-line bg-surface-2">
      {driver === undefined ? null : <ProviderMark driver={driver} size={13} />}
      <span className={`absolute -right-px -bottom-px size-2 rounded-full ring-2 ring-composer-tray group-hover/subagent:ring-surface-2 ${DOT[state]}`} />
    </span>
  )
}

/**
 * One helper as a row of the parent's timeline: its brief over what it does now or
 * what it answered, then its status, its time and a chevron where it opens. A notice
 * from a wake shows how it ended and when instead of a running clock.
 */
export function SubagentRow({ step, row, notice, onOpen }: {
  step: ToolStep
  row: SubagentRowModel
  notice?: Notice
  /** Makes the row a button; absent where there is nowhere to open it. */
  onOpen?: () => void
}) {
  const state = notice?.state ?? row.state
  const status = notice?.label ?? row.status
  const running = notice === undefined && row.state === 'running'
  const now = useNowSecond(running)
  const time = notice?.time ?? subagentElapsed(row, now)
  const failed = state === 'failed'
  const tone = failed ? 'text-danger' : 'text-dim'
  // The status word stands beside the detail only where it adds something: a notice,
  // or a helper not simply done. Without a detail it takes the detail's line.
  const sideStatus = row.detail !== undefined && (notice !== undefined || state !== 'done')
  const statusText = (className: string) => (
    <span className={`${className} ${running ? 'shimmer-text text-muted' : tone}`} {...(running ? { 'data-text': status } : {})}>{status}</span>
  )
  const hover = useHoverNote()
  const body = (
    <>
      <SubagentAvatar step={step} state={state} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="min-w-0 truncate font-medium text-text">{row.title}</span>
        {row.detail === undefined ? statusText('min-w-0 truncate text-meta') : (
          <span className={`min-w-0 truncate text-meta ${tone}`}>{row.detail}</span>
        )}
      </span>
      {sideStatus ? statusText('flex-none text-meta') : null}
      {time === undefined ? null : <span className="flex-none text-meta text-dim tabular-nums">{time}</span>}
      {onOpen === undefined ? null : (
        <Icon icon={ArrowRight01Icon} size={14} className="flex-none text-dim transition-colors group-hover/subagent:text-text" />
      )}
      {hover.note(row.kind)}
    </>
  )
  return onOpen === undefined ? (
    <div className={ROW} {...hover.anchor}>{body}</div>
  ) : (
    <button
      type="button"
      className={`${ROW} cursor-pointer [font-family:inherit] hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary`}
      aria-label={`Open ${row.title}`}
      aria-description={[status, row.detail].filter(Boolean).join('. ')}
      onClick={onOpen}
      {...hover.anchor}
    >
      {body}
    </button>
  )
}

/** The row's model and effort on hover and focus, after the beat T3 waits. */
function useHoverNote() {
  const timer = useRef<number | undefined>(undefined)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const id = useId()
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const hide = () => {
    window.clearTimeout(timer.current)
    setAnchor(null)
  }
  const show = (element: HTMLElement) => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setAnchor(element), 200)
  }
  return {
    anchor: {
      onPointerEnter: (event: { currentTarget: HTMLElement }) => show(event.currentTarget),
      onPointerLeave: hide,
      onFocus: (event: { currentTarget: HTMLElement }) => show(event.currentTarget),
      onBlur: hide,
      'aria-describedby': anchor === null ? undefined : id,
    },
    note: (text: string) => anchor === null ? null : (
      <Tooltip anchor={anchor} id={id} onDismiss={hide}>{text}</Tooltip>
    ),
  }
}

/**
 * The helpers one run of work started, a row each. They stand in the turn while it
 * runs and while any of them still works after it, which only a Manor child does.
 */
export function SubagentRows({ agents, activities, running, onOpen }: {
  agents: readonly ToolStep[]
  /** The turn's whole record, which is where each helper's own steps are. */
  activities: readonly TurnActivity[]
  /** The turn that launched them still goes. */
  running: boolean
  /** Opens this row's own helper, by its launch call id. */
  onOpen?: (toolCallId: string) => void
}) {
  const directory = useSubagentDirectory()
  return (
    <ul className="m-0 flex min-w-0 list-none flex-col gap-1.5 p-0">
      {agents.map((step) => {
        const childId = step.subagent?.childChatId
        const summary = childId === undefined ? undefined : directory?.(childId)
        const row = subagentRowModel(step, subagentSteps(activities, step), subagentStepState(step, running, directory), summary)
        const callId = step.toolCallId
        return (
          <li key={step.key} className="min-w-0">
            <SubagentRow step={step} row={row} {...(onOpen === undefined || callId === undefined ? {} : { onOpen: () => onOpen(callId) })} />
          </li>
        )
      })}
    </ul>
  )
}

/**
 * A wake's line, with each helper it reports on as a notice row that opens it, the way
 * T3 shows a child's notification. Background commands and helpers this transcript did
 * not launch keep the compact line.
 */
export function WakeNotices({ items, ts }: { items: readonly WakeItem[]; ts: number }) {
  const launches = useSubagentLaunches()
  const directory = useSubagentDirectory()
  const known = items.flatMap((item) => {
    const launch = launches?.byCallId.get(item.toolCallId)
    return launch === undefined ? [] : [{ item, launch }]
  })
  const rest = items.filter((item) => !known.some((entry) => entry.item === item))
  if (known.length === 0) return <WakeLine items={items} />
  const open = launches?.open
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <ul className="m-0 flex min-w-0 list-none flex-col gap-1.5 p-0">
        {known.map(({ item, launch }) => {
          const childId = launch.step.subagent?.childChatId
          const summary = childId === undefined ? undefined : directory?.(childId)
          const notice = WAKE_NOTICE[item.state]
          const row = subagentRowModel(launch.step, launch.steps, notice.state, summary)
          return (
            <li key={item.toolCallId} className="min-w-0">
              <SubagentRow
                step={launch.step}
                row={row}
                notice={{ ...notice, time: clock(ts) }}
                {...(open === undefined ? {} : { onOpen: () => open(item.toolCallId) })}
              />
            </li>
          )
        })}
      </ul>
      {rest.length === 0 ? null : <WakeLine items={rest} />}
    </div>
  )
}
