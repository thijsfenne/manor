import { StopIcon } from '@hugeicons/core-free-icons'
import type { SubagentSummary } from '@manor/contracts'
import {
  SUBAGENT_STATE_LABEL,
  isManorSubagent,
  launchDriver,
  subagentStateOf,
  subagentTask,
  type ChatSubagent,
  type SubagentState,
} from '@manor/client-runtime/turn-trace'
import { useState } from 'react'
import { elapsedLabel } from '../../turnLabels'
import { useNowSecond } from '../../useNowSecond'
import { ProviderMark } from '../ProviderMark'
import { subagentRuntimeLine } from '../SubagentChildRows'
import { Fold, FoldChevron } from '../ui/Fold'
import { IconButton } from '../ui/IconButton'

/** How many rows the list shows before it offers more, and how many each click adds. */
const FIRST_PAGE = 6
const NEXT_PAGE = 12
/** The logos the summary line stacks. */
const STACKED = 3

const ROW = 'flex h-8 w-full min-w-0 cursor-pointer items-center gap-2 rounded-lg border-0 bg-transparent px-2 text-left [font:inherit] hover:bg-surface-2'

interface Listed {
  subagent: ChatSubagent
  state: SubagentState
  summary: SubagentSummary | undefined
}

/**
 * The last section of the Session panel: the level's subagents as one summary line
 * (logos, "Agents", counts) that unfolds into their rows. It starts folded, and a
 * failure stays in the counts, in the danger colour, until the line is opened.
 * Running ones stand first, then the rest in the order they were launched.
 */
export function SessionAgents({ subagents, summary, onOpen, onStop }: {
  subagents: readonly ChatSubagent[]
  summary: (childId: string) => SubagentSummary | undefined
  onOpen: (toolCallId: string) => void
  /** False when the request could not be sent. */
  onStop: (toolCallId: string) => boolean
}) {
  const [open, setOpen] = useState(false)
  if (subagents.length === 0) return null
  const listed = subagents.map((subagent): Listed => {
    const childId = subagent.step.subagent?.childChatId
    return { subagent, state: subagentStateOf(subagent, summary), summary: childId === undefined ? undefined : summary(childId) }
  })
  const rows = [...listed.filter((row) => row.state === 'running'), ...listed.filter((row) => row.state !== 'running')]
  const count = (state: SubagentState) => listed.filter((row) => row.state === state).length
  const running = count('running')
  const failed = count('failed')
  const stopped = count('stopped')
  const done = count('done')
  const drivers = rows.flatMap((row) => {
    const driver = row.summary?.driver ?? launchDriver(row.subagent.step.subagent)
    return driver === undefined ? [] : [driver]
  }).slice(0, STACKED)
  const parts = [
    running === 0 ? null : <span key="running" className="text-text/85">{running} running</span>,
    failed === 0 ? null : <span key="failed" className="text-danger">{failed} failed</span>,
    stopped === 0 ? null : <span key="stopped">{stopped} stopped</span>,
    done === 0 ? null : <span key="done">{done} done</span>,
  ].filter((part) => part !== null)
  return (
    <section aria-label="Agents" className="flex-none border-t border-line px-1.5 pt-2 pb-1.5 first:border-t-0 first:pt-3">
      <button
        type="button"
        className={ROW}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span aria-hidden="true" className="flex flex-none items-center">
          {drivers.map((driver, index) => (
            <span key={index} className="-ml-1.5 grid size-[18px] place-items-center rounded-full bg-sidebar text-text first:ml-0">
              <ProviderMark driver={driver} size={13} centred />
            </span>
          ))}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-text">Agents</span>
        <span className="flex flex-none items-center gap-2 text-meta tabular-nums text-dim">
          {parts}
        </span>
        <span className="flex-none text-dim"><FoldChevron open={open} /></span>
      </button>
      <Fold open={open}>
        <PagedRows rows={rows} active={open} onPick={(toolCallId) => { if (toolCallId !== undefined) onOpen(toolCallId) }} onStop={onStop} />
      </Fold>
    </section>
  )
}

function PagedRows({ rows, active, onPick, onStop }: { rows: readonly Listed[]; active: boolean; onPick: (toolCallId: string | undefined) => void; onStop: (toolCallId: string) => boolean }) {
  const [shown, setShown] = useState(FIRST_PAGE)
  const now = useNowSecond(active && rows.some((row) => row.state === 'running'))
  const hidden = rows.length - shown
  return (
    <>
      <ul className="m-0 flex max-h-[13.5rem] list-none flex-col overflow-y-auto p-0">
        {rows.slice(0, shown).map((row) => <AgentRow key={row.subagent.step.key} row={row} now={now} onPick={onPick} onStop={onStop} />)}
      </ul>
      {hidden <= 0 ? null : (
        <button type="button" className={ROW} onClick={() => setShown((value) => value + NEXT_PAGE)}>
          <span className="min-w-0 flex-1 truncate text-[13px] text-muted">Show {Math.min(hidden, NEXT_PAGE)} more</span>
        </button>
      )}
    </>
  )
}

function AgentRow({ row: { subagent, state, summary }, now, onPick, onStop }: { row: Listed; now: number; onPick: (toolCallId: string | undefined) => void; onStop: (toolCallId: string) => boolean }) {
  const [stopping, setStopping] = useState(false)
  const { step } = subagent
  const title = subagentTask(step)
  const driver = summary?.driver ?? launchDriver(step.subagent)
  const callId = step.toolCallId
  // A provider's own helper only stops with its turn.
  const stop = state === 'running' && callId !== undefined && isManorSubagent(step) ? () => setStopping(onStop(callId)) : undefined
  const failed = state === 'failed'
  const started = summary?.startedAt ?? step.startedAt
  const ended = summary?.endedAt
  const trailing = failed || state === 'stopped' ? SUBAGENT_STATE_LABEL[state]
    : state === 'running' ? (summary?.ask !== undefined ? 'Waiting' : elapsedLabel(started, now))
    : ended === undefined ? SUBAGENT_STATE_LABEL[state] : elapsedLabel(started, ended)
  const runtime = summary === undefined ? undefined : subagentRuntimeLine(summary)
  return (
    <li className="group relative min-w-0">
      <button
        type="button"
        className={ROW}
        title={[title, runtime, SUBAGENT_STATE_LABEL[state]].filter(Boolean).join('\n')}
        onClick={() => onPick(callId)}
      >
        {driver === undefined ? null : <ProviderMark driver={driver} size={14} />}
        <span className="min-w-0 flex-1 truncate text-[13px] text-text/85">{title}</span>
        <span className={`flex-none text-meta tabular-nums ${failed ? 'text-danger' : 'text-dim'} ${stop === undefined ? '' : 'group-focus-within:opacity-0 group-hover:opacity-0 [@media(hover:none)]:opacity-0'}`}>{trailing}</span>
      </button>
      {stop === undefined ? null : (
        <IconButton
          icon={StopIcon}
          size={24}
          iconSize={13}
          label={`Stop subagent ${title}`}
          title="Stop subagent"
          disabled={stopping}
          className="absolute top-1 right-1 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
          onClick={stop}
        />
      )}
    </li>
  )
}
