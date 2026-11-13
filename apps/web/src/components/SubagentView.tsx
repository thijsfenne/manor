import { Clock01Icon } from '@hugeicons/core-free-icons'
import type { AgentConfig, SubagentSummary } from '@manor/contracts'
import { useEffect, useMemo, useRef, type CSSProperties, type ReactNode } from 'react'
import {
  launchDriver,
  subagentBarStatus,
  subagentNow,
  subagentRuntime,
  subagentStepLabel,
  type ChatSubagent,
  type SubagentState,
} from '@manor/client-runtime/turn-trace'
import { useLiveThread } from '../liveThread'
import { rowsOf } from '../state'
import { useNowSecond } from '../useNowSecond'
import { Badge } from './ui/Badge'
import { Markdown } from './Markdown'
import { ProviderMark } from './ProviderMark'
import { providerName } from './SubagentChildRows'
import { SubagentBar } from './SubagentBar'
import { useTopBarSlot } from './TopBar'
import { Transcript } from './Transcript'

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
      {childId === undefined ? <ProviderRecord {...props} /> : <ChildConversation {...props} childId={childId} />}
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
function SubagentFacts({ subagent: { step }, state, summary, starter, below }: Pick<SubagentViewProps, 'subagent' | 'state' | 'summary' | 'starter'> & { below: string }) {
  const launch = step.subagent
  const driver = summary?.driver ?? launchDriver(launch)
  const runtime = subagentRuntime(driver, summary?.model ?? launch?.model, summary?.effort ?? launch?.effort)
  const role = summary?.role ?? launch?.role
  // Why it ended, once that is the news: a done or running helper has nothing to explain.
  const why = state === 'running' || state === 'done' ? undefined : summary?.reason
  return (
    <div data-subagent-facts="" className={`flex flex-col gap-2.5 text-[13px] ${below}`}>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <Badge icon={Clock01Icon}>
          {starter === undefined ? '' : `${starter.name} at `}<span className="tabular-nums">{startedAt(step.startedAt)}</span>
        </Badge>
        <Badge {...(driver === undefined ? {} : { mark: <ProviderMark driver={driver} size={12} /> })}>
          {driver === undefined ? NOT_REPORTED : runtime === undefined ? providerName(driver) : [runtime.model, runtime.effort].filter(Boolean).join(' · ')}
        </Badge>
      </div>
      {role === undefined && why === undefined ? null : (
        <dl className="m-0 grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5">
          {role === undefined ? null : <Fact label="Role"><span className="[overflow-wrap:anywhere]">{role}</span></Fact>}
          {why === undefined ? null : (
            <Fact label={state === 'failed' ? 'Why it failed' : 'Why it stopped'}>
              <span className="[overflow-wrap:anywhere]">{why}</span>
            </Fact>
          )}
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
 * A Manor-run child's own thread, which is the whole history: its task opens it as the
 * starting persona's message and its answer closes it. Read-only: nothing here can
 * reach it, and its questions wait in the parent.
 */
function ChildConversation(props: SubagentViewProps & { childId: string }) {
  const { childId, subagent, state, summary, agents, starter, connected, denseText, covered, load, onOpenChild } = props
  const loadRef = useRef(load)
  loadRef.current = load
  useEffect(() => {
    if (connected) loadRef.current(childId)
  }, [childId, connected])
  const thread = useLiveThread(childId)
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
          leading={<SubagentFacts subagent={subagent} state={state} summary={summary} starter={starter} below="-mb-[22px]" />}
          emptyNote="Nothing in this thread yet."
          held={covered}
        />
      </main>
      <ViewBar {...props} />
    </>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h4 className="m-0 text-meta font-medium text-dim">{title}</h4>
      {children}
    </section>
  )
}

/**
 * A helper its provider ran inside its own turn. Manor never gets that conversation, so
 * this shows what the launch row holds and says so, rather than dressing it up as a thread.
 */
function ProviderRecord(props: SubagentViewProps) {
  const { subagent, state, summary, starter } = props
  const { step, steps } = subagent
  const launch = step.subagent
  const now = state === 'running' ? subagentNow(steps) : undefined
  const headerInBar = useTopBarSlot() !== null
  return (
    <>
      <main className="col-start-1 row-span-2 row-start-1 flex min-h-0 min-w-0 justify-center bg-bg">
        <div className="scrollbar-hidden flex min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto">
          <div
            data-reading-column=""
            className={`mx-auto flex w-full max-w-[780px] flex-1 flex-col gap-5 px-5 ${headerInBar ? 'pt-8' : 'pt-[76px]'} pb-[calc(var(--composer-dock,0px)+3.5rem)] text-label text-text`}
          >
            <SubagentFacts subagent={subagent} state={state} summary={summary} starter={starter} below="pb-4" />
            <p className="m-0 text-[13px] text-dim">
              {launch?.driver === undefined ? 'The provider' : providerName(launch.driver)} ran this helper inside its own turn, so Manor has its brief, its steps and its result, not its conversation.
            </p>
            <Section title="Brief">
              {launch?.prompt === undefined ? <p className="m-0 text-dim">{NOT_REPORTED}</p> : (
                <div className="rounded-xl bg-surface-2/45 px-3 py-2.5 leading-[1.55]"><Markdown text={launch.prompt} /></div>
              )}
            </Section>
            <Section title="Steps">
              {steps.length === 0 ? <p className="m-0 text-dim">{state === 'running' ? 'None yet' : NOT_REPORTED}</p> : (
                <ol className="m-0 flex list-none flex-col gap-1 p-0 text-[13px] text-muted">
                  {steps.map((child) => <li key={child.key} className="truncate">{subagentStepLabel(child)}</li>)}
                </ol>
              )}
              {now === undefined ? null : <p className="m-0 truncate text-[13px] text-muted shimmer-text" data-text={now}>{now}</p>}
            </Section>
            <Section title="Result">
              {step.output !== undefined
                ? <div className="leading-[1.55]"><Markdown text={step.output} /></div>
                : <p className="m-0 text-dim">{state === 'running' ? 'Still working' : NOT_REPORTED}</p>}
            </Section>
          </div>
        </div>
      </main>
      <ViewBar {...props} />
    </>
  )
}
