import { Clock01Icon } from '@hugeicons/core-free-icons'
import type { AgentConfig, SubagentSummary } from '@manor/contracts'
import { useEffect, useMemo, useRef, type CSSProperties, type ReactNode } from 'react'
import {
  launchDriver,
  providerHelperKey,
  providerHelperThread,
  subagentBarStatus,
  subagentRuntime,
  type ChatSubagent,
  type SubagentState,
} from '@manor/client-runtime/turn-trace'
import { useLiveThread } from '../liveThread'
import { rowsOf } from '../state'
import { useNowSecond } from '../useNowSecond'
import { Badge } from './ui/Badge'
import { ProviderMark } from './ProviderMark'
import { providerName } from './SubagentChildRows'
import { SubagentBar } from './SubagentBar'
import { Transcript } from './Transcript'

type ThreadShape = Parameters<typeof rowsOf>[0]

const NOT_REPORTED = 'Not reported'

/** The bar is one line, so the transcript clears it without measuring. */
const BAR_DOCK = { '--composer-dock': '60px', '--work-dock': '0px' } as CSSProperties

const startedAt = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

interface SubagentViewProps {
  subagent: ChatSubagent
  state: SubagentState
  summary: SubagentSummary | undefined
  agents: AgentConfig[]
  starter: AgentConfig | undefined
  connected: boolean
  denseText: boolean
  /** Footer inset of the stage this view lies over. */
  footerPadding: string
  /** A deeper level lies over this one, which then waits underneath. */
  covered: boolean
  /** Asks for the child's thread, again after a reconnect. */
  load: (childId: string) => void
  onOpenChild: (toolCallId: string) => void
  onOpenParent: () => void
}

/**
 * A subagent on the stage in place of the chat that started it. Hidden underneath a
 * deeper level rather than unmounted, so going back a level keeps its scroll too. It
 * stacks above the parent's footer and pinned plan, because parts of a hidden chat that
 * animate their own visibility would otherwise paint through it.
 */
export function SubagentView(props: SubagentViewProps) {
  const childId = props.subagent.step.subagent?.childChatId
  const { covered } = props
  return (
    <section
      aria-label="Subagent conversation"
      data-subagent-view=""
      className={`relative z-[4] col-start-1 row-span-2 row-start-1 grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_auto] bg-bg ${covered ? 'invisible' : ''}`}
      style={BAR_DOCK}
      {...(covered ? { inert: '' } : {})}
    >
      {childId === undefined ? <ProviderConversation {...props} /> : <ChildConversation {...props} childId={childId} />}
    </section>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-dim">{label}</dt>
      <dd className="m-0 min-w-0 text-muted">{children}</dd>
    </>
  )
}

/**
 * What the launch said and how it ended, at the head of the conversation. The title is
 * in the breadcrumb and the live state in the bar, so neither repeats here. `below`
 * sets the room under them: in a child's thread it pulls the 32px transcript gap back to
 * 10px above the handoff card.
 */
function SubagentFacts({ subagent: { step }, state, summary, starter, below, note }: Pick<SubagentViewProps, 'subagent' | 'state' | 'summary' | 'starter'> & { below: string; note?: string }) {
  const launch = step.subagent
  const driver = summary?.driver ?? launchDriver(launch)
  const runtime = subagentRuntime(driver, summary?.model ?? launch?.model, summary?.effort ?? launch?.effort)
  // Why it ended, once that is the news: a done or running helper has nothing to explain.
  const why = state === 'running' || state === 'done' ? undefined : summary?.reason
  return (
    <div data-subagent-facts="" className={`flex flex-col gap-2.5 text-[13px] ${below}`}>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <Badge icon={Clock01Icon}>
          {starter === undefined ? '' : `${starter.name} at `}<span className="tabular-nums">{startedAt(step.startedAt)}</span>
        </Badge>
        <Badge {...(driver === undefined ? {} : { mark: <ProviderMark driver={driver} size={12} /> })}>
          {driver === undefined ? NOT_REPORTED : runtime === undefined ? providerName(driver) : [runtime.model, runtime.effort].filter(Boolean).join(', ')}
        </Badge>
      </div>
      {note === undefined ? null : <p className="m-0 text-[13px] text-dim">{note}</p>}
      {why === undefined ? null : (
        <dl className="m-0 grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5">
          <Fact label={state === 'failed' ? 'Why it failed' : 'Why it stopped'}>
            <span className="[overflow-wrap:anywhere]">{why}</span>
          </Fact>
        </dl>
      )}
    </div>
  )
}

function ViewBar({ subagent, state, summary, footerPadding, onOpenParent }: Pick<SubagentViewProps, 'subagent' | 'state' | 'summary' | 'footerPadding' | 'onOpenParent'>) {
  const now = useNowSecond(state === 'running')
  const { step } = subagent
  const driver = summary?.driver ?? launchDriver(step.subagent)
  const status = subagentBarStatus(state, {
    startedAt: summary?.startedAt ?? step.startedAt,
    endedAt: summary?.endedAt,
    asking: summary?.ask !== undefined,
  }, now)
  return (
    <SubagentBar
      driver={driver}
      runtime={subagentRuntime(driver, summary?.model ?? step.subagent?.model, summary?.effort ?? step.subagent?.effort)}
      status={status}
      onOpenParent={onOpenParent}
      padding={footerPadding}
    />
  )
}

/**
 * A subagent's conversation, read-only: its task opens it as the starting persona's
 * message and its answer closes it. Nothing here can reach it, and its questions wait
 * in the parent. A Manor child's own thread and the record of a provider's helper both
 * come through here, so every level reads the same.
 */
function SubagentConversation(props: SubagentViewProps & { thread: ThreadShape; note?: string }) {
  const { thread, note, subagent, state, summary, agents, starter, connected, denseText, covered, onOpenChild } = props
  const rows = useMemo(() => rowsOf(thread), [thread])
  return (
    <>
      <main className="col-start-1 row-span-2 row-start-1 flex min-h-0 min-w-0 justify-center bg-bg">
        <Transcript
          rows={rows}
          agents={agents}
          skills={[]}
          hasSnapshot={thread.hasSnapshot}
          denseText={denseText}
          showSpeakers={false}
          connected={connected}
          onOpenSubagents={onOpenChild}
          taskRole={summary?.role ?? subagent.step.subagent?.role}
          leading={<SubagentFacts subagent={subagent} state={state} summary={summary} starter={starter} below="-mb-[22px]" {...(note === undefined ? {} : { note })} />}
          emptyNote="Nothing in this thread yet."
          held={covered}
        />
      </main>
      <ViewBar {...props} />
    </>
  )
}

/** A Manor-run child: its own thread is the whole history. */
function ChildConversation(props: SubagentViewProps & { childId: string }) {
  const { childId, connected, load } = props
  const loadRef = useRef(load)
  loadRef.current = load
  useEffect(() => {
    if (connected) loadRef.current(childId)
  }, [childId, connected])
  const thread = useLiveThread(childId)
  return <SubagentConversation {...props} thread={thread} />
}

/**
 * A helper its provider ran inside its own turn. Manor never gets that conversation, so
 * the view is built from what the launch row holds, and says so in one line.
 */
function ProviderConversation(props: SubagentViewProps) {
  const { subagent, state } = props
  const { step } = subagent
  // The launch row is rebuilt on every parent render, so the thread follows what it holds.
  const held = providerHelperKey(subagent, state)
  const subagentRef = useRef(subagent)
  subagentRef.current = subagent
  const thread = useMemo(() => providerHelperThread(subagentRef.current, state), [held, state])
  const launch = step.subagent
  const note = `${launch?.driver === undefined ? 'The provider' : providerName(launch.driver)} ran this helper inside its own turn, so Manor has its brief, its steps and its result, not its conversation.`
  return <SubagentConversation {...props} thread={thread} note={note} />
}
