import { CURRENT_CHECKOUT, type AgentConfig, type Chat, type Project, type Routine } from '@manor/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { ComponentProps, ReactNode } from 'react'
import { ChatRoutinesPanel, RunHistory } from '../src/components/routines/ChatRoutinesPanel'
import { RoutineDetail, runDate } from '../src/components/routines/RoutineDetailView'
import { RoutineRunsPanel } from '../src/components/routines/RoutineRunsPanel'
import { RoutinesView, foldEarlierFor } from '../src/components/routines/RoutinesView'
import { ScheduledTabs } from '../src/components/routines/ScheduledTabs'
import { shownKind } from '../src/routines'
import { RoutineDialog } from '../src/components/routines/RoutineDialog'
import type { RequestEvents } from '../src/useRequest'

const requestEvents: RequestEvents = { subscribe: () => () => {} }

vi.mock('../src/components/Modal', () => ({
  Modal: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ModalFooter: ({ children }: { children: ReactNode }) => <footer>{children}</footer>,
}))
vi.mock('../src/components/ui/Select', () => ({
  Select: ({ label, value, options }: { label: string; value: string; options: { value: string; label: string }[] }) => (
    <select aria-label={label} value={value} onChange={() => {}}>
      {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  ),
}))

const routine: Routine = {
  id: 'routine-1',
  projectId: 'project-1',
  chatId: null,
  agentId: 'smith',
  name: 'Inbox sorter',
  description: 'Sorts new notes into the right place.',
  prompt: 'Read the inbox and route every note.\nReport what moved.',
  cron: '0 9 * * *',
  timezone: 'Europe/Amsterdam',
  enabled: true,
  notify: true,
  model: null,
  effort: null,
  nextRunAt: Date.UTC(2026, 7, 17, 7),
  lastRunAt: Date.UTC(2026, 7, 16, 7),
  lastSkippedAt: null,
  consecutiveFailures: 0,
  disabledReason: null,
  runningSince: null,
  lastContextTokens: null,
  runAt: null,
  lateUntil: null,
  action: 'run',
  endState: null,
  endedAt: null,
  unreadRunIds: [],
  createdAt: 0,
}

const runs: Chat[] = Array.from({ length: 7 }, (_, index) => ({
  id: `run-${index}`,
  projectId: routine.projectId,
  kind: 'run',
  routineId: routine.id,
  parentChatId: null,
  sideModel: null,
  sideEffort: null,
  archivedAt: null,
  checkout: CURRENT_CHECKOUT,
  memberIds: [],
  lastMessagePreview: `Run result ${index}`,
  title: routine.name,
  createdAt: Date.UTC(2026, 7, 16 - index, 7),
  lastMessageAt: Date.UTC(2026, 7, 16 - index, 7),
  settledAt: index === 0 ? null : 1,
  agentIds: [routine.agentId],
}))

const project: Project = {
  id: routine.projectId!,
  name: 'Notes',
  repoPaths: [],
  icon: 'folder',
  color: '#8A8F98',
  memoryScope: 'project',
}

const agent: AgentConfig = {
  id: 'smith',
  name: 'Smith',
  character: '',
  color: '#f59e0b',
  driver: 'mock',
  effort: 'medium',
  allowedTools: [],
  mcpServers: [],
  memoryScope: false,
  description: '',
  role: 'Engineer',
  isCos: false,
}

type PageProps = ComponentProps<typeof RoutinesView>
// The header switch and the page, with the segment worked out as App does it.
const renderPage = (props: Partial<PageProps> = {}) => {
  const routines = props.routines ?? [routine]
  const kind = props.kind ?? shownKind(routines.find((item) => item.id === props.selectedId), null)
  return renderToStaticMarkup(<ScheduledTabs kind={kind} onChange={() => {}} />) + renderToStaticMarkup(
  <RoutinesView
    loaded
    runs={{}}
    histories={{}}
    projects={[project]}
    chats={[]}
    agents={[agent]}
    notice={null}
    requestEvents={requestEvents}
    selectedId={null}
    onSelect={() => {}}
    onOpenChat={() => {}}
    onRequestHistory={() => {}}
    onMarkRunsRead={() => {}}
    onMarkAllRunsRead={() => {}}
    onSave={() => true}
    onDelete={() => true}
    onSetEnabled={() => true}
    onRunNow={() => true}
    onDismissNotice={() => {}}
    onDialogChange={() => {}}
    {...props}
    kind={kind}
    routines={routines}
  />,
)
}
const renderDetail = (props: Partial<ComponentProps<typeof RoutineDetail>> = {}) => renderToStaticMarkup(
  <RoutineDetail
    routine={routine}
    runs={runs}
    history={undefined}
    projects={[project]}
    agents={[agent]}
    notice={null}
    requestEvents={requestEvents}
    onEdit={() => {}}
    onOpenChat={() => {}}
    onRequestHistory={() => {}}
    onMarkRead={() => {}}
    onDelete={() => true}
    onDeleted={() => {}}
    onSetEnabled={() => true}
    onRunNow={() => true}
    {...props}
  />,
)

describe('routine management surfaces', () => {
  it('edits a single routine with model and effort even with no personas', () => {
    const html = renderToStaticMarkup(<RoutineDialog
      initial={{ ...routine, projectId: null, agentId: '__single__', model: 'gpt-5.6-sol', effort: 'high' }}
      projects={[]} chats={[]} agents={[]} notice={null} pending={null}
      onSave={() => true} onDismissNotice={() => {}} onClose={() => {}}
    />)
    expect(html).toContain('Single agent')
    expect(html).toContain('Model')
    expect(html).toContain('Effort')
    expect(html).not.toContain('Persona&#x27;s own')
    expect(html).toContain('No project')
    expect(html).not.toContain('Destination')
  })

  it('edits a one-time DM reminder as a moment, not a repeat', () => {
    const html = renderToStaticMarkup(<RoutineDialog
      initial={{ ...routine, projectId: null, chatId: 'dm-smith', cron: '', runAt: Date.UTC(2026, 8, 28, 8, 0), lateUntil: null, action: 'remind' }}
      projects={[project]} chats={[]} agents={[agent]} notice={null} pending={null}
      onSave={() => true} onDismissNotice={() => {}} onClose={() => {}}
    />)
    expect(html).toContain('value="2026-09-28T10:00"')
    expect(html).toContain('Only useful until')
    expect(html).toContain('Just remind me')
    expect(html).not.toContain('Custom cron')
  })

  it('keeps unknown distinct from an empty list, and says what each empty segment is for', () => {
    const loading = renderPage({ routines: [], loaded: false })
    expect(loading).toContain('Loading scheduled work…')
    expect(loading).not.toContain('Nothing coming up')

    const empty = renderPage({ routines: [] })
    expect(empty).toContain('Nothing recurring yet')
    expect(empty).toContain('>New task<')
    expect(empty).not.toContain('role="listbox"')
    expect(renderPage({ routines: [], kind: 'once' })).toContain('Nothing coming up')
  })

  it('shows the configuration, the latest result inline and every run folded', () => {
    const history = {
      chatId: null,
      runs: [
        { id: 'run-quiet', chatId: 'run-quiet', result: 'Nothing needed a ticket.', startedAt: Date.UTC(2026, 7, 17, 7), state: 'done' as const, outcome: 'quiet' as const },
        ...runs.slice(1).map((run, index) => ({
          id: run.id, chatId: run.id, result: `Moved ${index + 1} notes`, startedAt: run.createdAt, state: 'done' as const, outcome: 'publish' as const,
        })),
      ],
    }
    const html = renderDetail({ history, routine: { ...routine, unreadRunIds: ['run-3'] } })

    expect(html).toContain(routine.description)
    expect(html.match(/>Next run</g)).toHaveLength(1)
    expect(html).toContain('role="switch"')
    // The latest result skips the quiet check before it.
    expect(html).toMatch(/Latest result<\/h3>(?:(?!<h3).)*Moved 1 notes/)
    // Every run is a row; each with something to read unfolds in place.
    expect(html.match(/aria-controls="routine-run-/g)).toHaveLength(history.runs.length)
    expect(html).toContain('0 results')
    // An older unread run keeps its dot until it is unfolded.
    expect(html.match(/, unread</g)).toHaveLength(1)
    // Instructions start folded.
    expect(html).toMatch(/aria-expanded="false" aria-controls="routine-instructions"/)
    expect(html).toContain('Report what moved.')
    expect(html).not.toContain('>Scheduled tasks<')
    expect(html).not.toContain('>Open chat<')
  })

  it('shows a published run without text as a result that points to its thread', () => {
    const image = { id: 'img', chatId: 'img', result: null, startedAt: 1, state: 'done' as const, outcome: 'publish' as const }
    const html = renderDetail({ history: { chatId: null, runs: [image] }, routine: { ...routine, unreadRunIds: ['img'] } })
    expect(html).toMatch(/Latest result<\/h3>(?:(?!<h3).)*No text in this result/)
    expect(html).toContain('aria-controls="routine-run-img"')
  })

  it('says a routine has no result yet while it only ran quiet checks', () => {
    const html = renderDetail({
      history: { chatId: null, runs: [{ id: 'q', chatId: 'q', result: 'Nothing new.', startedAt: 1, state: 'done', outcome: 'quiet' }] },
    })
    expect(html).toContain('No result yet')
    expect(renderDetail()).toContain('Loading runs…')
  })

  it('gives a one-time task no switch and says how it ended once', () => {
    const once = { ...routine, projectId: null, chatId: 'dm-smith', cron: '', runAt: 1, lastRunAt: 1 }
    const done = renderDetail({ routine: { ...once, enabled: false, endState: 'done', endedAt: 1 } })
    expect(done).not.toContain('role="switch"')
    expect(done.match(/>Done/g)).toHaveLength(1)
    expect(renderDetail({ routine: { ...once, lastRunAt: null } })).not.toContain('role="switch"')
    // Previously paused, the switch is the way back on, with Off said once and its reason kept.
    const paused = renderDetail({ routine: { ...once, lastRunAt: null, enabled: false } })
    expect(paused).toContain('role="switch"')
    expect(paused.match(/>Off/g)).toHaveLength(1)
    const stopped = renderDetail({ routine: { ...once, lastRunAt: null, enabled: false, disabledReason: 'Post was removed' } })
    expect(stopped.match(/>Off/g)).toHaveLength(1)
    expect(stopped).toMatch(/text-danger[^>]*>Off: Post was removed</)
  })

  it('selects the first row and keeps every act in the detail beside the list', () => {
    const html = renderPage()

    // Only recurring work exists, so the page opens on Recurring with that row picked.
    expect(html).toMatch(/aria-selected="true"[^>]*>(?:(?!<\/button>).)*Recurring/)
    expect(html.match(/role="option"/g)).toHaveLength(1)
    expect(html).toMatch(/role="option" aria-selected="true"/)
    expect(html.match(/>Run now</g)).toHaveLength(1)
    expect(html).toContain(routine.description)
    expect(html).toContain('Next ')
  })

  it('marks a row busy while it runs and green while a result waits unread', () => {
    const waiting = renderPage({ routines: [{ ...routine, unreadRunIds: ['run-1'] }] })
    expect(waiting).toContain('aria-label="New result"')
    expect(waiting).toContain('bg-ok')
    expect(waiting).toContain('>Mark all as read<')

    const running = renderPage({ routines: [{ ...routine, runningSince: Date.now() }] })
    expect(running).toContain('aria-label="Running"')
    expect(running).toContain('bg-busy')

    // An unsettled run thread no longer lights anything; only the unread list does.
    const read = renderPage({ runs: { [routine.id]: [{ ...runs[1]!, settledAt: null }] } })
    expect(read).toContain('aria-label="Nothing new"')
    expect(read).not.toContain('>Mark all as read<')
  })

  it('shows one kind at a time, failures first, and folds what is over', () => {
    // Noon in Amsterdam, so an hour either side is still Today whenever the suite runs.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.UTC(2026, 8, 28, 10))
    onTestFinished(() => { vi.useRealTimers() })
    const now = Date.now()
    const once = { ...routine, projectId: null, chatId: 'dm-smith', cron: '', nextRunAt: null, lastRunAt: null }
    const routines: Routine[] = [
      routine,
      { ...once, id: 'tea', name: 'Make tea', action: 'remind', runAt: now + 60 * 60 * 1000, nextRunAt: now + 60 * 60 * 1000 },
      { ...once, id: 'reply', name: 'Check reply', runAt: now - 60 * 60 * 1000, enabled: false, endState: 'failed', endedAt: now - 60 * 60 * 1000 },
      { ...once, id: 'call', name: 'Call GP', action: 'remind', runAt: now - 3 * 60 * 60 * 1000, enabled: false, endState: 'done', endedAt: now - 3 * 60 * 60 * 1000 },
    ]
    // Unpicked, the page opens on Recurring even while one-time tasks exist.
    expect(renderPage({ routines })).toMatch(/aria-selected="true"[^>]*>(?:(?!<\/button>).)*Recurring/)
    const html = renderPage({ routines, kind: 'once' })

    // Recurring leads the switch.
    const order = ['>Recurring<', '>Once<', 'Check reply', 'Make tea', '>Earlier<']
    const at = order.map((text) => html.indexOf(text))
    expect(at.every((index) => index >= 0)).toBe(true)
    expect(at).toEqual([...at].sort((a, b) => a - b))
    expect(html).toMatch(/aria-selected="true"[^>]*>(?:(?!<\/button>).)*Once/)
    expect(html).toContain('Reminder · Today ')
    expect(html).toMatch(/text-danger[^>]*>Check · Failed/)
    expect(html).toMatch(/aria-expanded="false"[^>]*>(?:(?!<\/button>).)*>Earlier</)
    expect(html).not.toContain(routine.name)
    // The failure is first in Upcoming, so it is the task open beside the list.
    expect(html).toMatch(/<h2[^>]*>Check reply</)

    // A finished task picked from elsewhere opens Earlier around itself.
    const finished = renderPage({ routines, selectedId: 'call' })
    expect(finished).toMatch(/aria-expanded="true"[^>]*>(?:(?!<\/button>).)*>Earlier</)
    expect(finished).toMatch(/<h2[^>]*>Call GP</)

    // A recurring routine picked from elsewhere brings its own segment along.
    const recurring = renderPage({ routines, selectedId: routine.id })
    expect(recurring).toMatch(/aria-selected="true"[^>]*>(?:(?!<\/button>).)*Recurring/)
    expect(recurring).not.toContain('Make tea')
  })

  it('unfolds Earlier for a finished task once, and lets the user fold it with that task selected', () => {
    const closed = { open: false, openedFor: undefined }
    const opened = foldEarlierFor(closed, 'call')
    expect(opened).toEqual({ open: true, openedFor: 'call' })
    // Folding keeps the same task selected, and it does not pull Earlier open again.
    const folded = { ...opened, open: false }
    expect(foldEarlierFor(folded, 'call')).toBe(folded)
    // Another finished task picked from elsewhere unfolds it again.
    expect(foldEarlierFor(folded, 'dentist')).toEqual({ open: true, openedFor: 'dentist' })
    expect(foldEarlierFor(closed, undefined)).toBe(closed)
    // Leaving Earlier forgets the task, so coming back to the same one unfolds it again.
    const away = foldEarlierFor(folded, undefined)
    expect(away).toEqual({ open: false, openedFor: undefined })
    expect(foldEarlierFor(away, 'call')).toEqual({ open: true, openedFor: 'call' })
  })

  it('shows one kind at a time in the DM panel, opening on what is coming up', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.UTC(2026, 8, 28, 10))
    onTestFinished(() => { vi.useRealTimers() })
    const now = Date.now()
    const once = { ...routine, projectId: null, chatId: 'dm-smith', cron: '', nextRunAt: null, lastRunAt: null }
    const panel = (routines: Routine[]) => renderToStaticMarkup(
      <ChatRoutinesPanel
        chatId="dm-smith"
        agentId="smith"
        routines={routines}
        loaded
        histories={{}}
        projects={[]}
        chats={[]}
        agents={[agent]}
        notice={null}
        requestEvents={requestEvents}
        onRequestHistory={() => {}}
        onSave={() => true}
        onDelete={() => true}
        onSetEnabled={() => true}
        onRunNow={() => true}
        onDismissNotice={() => {}}
        onDialogChange={() => {}}
        onClose={() => {}}
      />,
    )
    const recurring = { ...routine, chatId: 'dm-smith', projectId: null }
    const tea = { ...once, id: 'tea', name: 'Make tea', action: 'remind' as const, runAt: now + 60 * 60 * 1000, nextRunAt: now + 60 * 60 * 1000 }
    const call = { ...once, id: 'call', name: 'Call GP', action: 'remind' as const, runAt: now - 3 * 60 * 60 * 1000, enabled: false, endState: 'done' as const, endedAt: now - 3 * 60 * 60 * 1000 }

    // Unpicked, the panel opens on Recurring even while one-time tasks exist.
    const html = panel([recurring, tea, call])
    expect(html).toMatch(/aria-selected="true"[^>]*>(?:(?!<\/button>).)*Recurring/)
    const order = ['>Scheduled tasks<', '>Recurring<', '>Once<', recurring.name]
    const at = order.map((text) => html.indexOf(text))
    expect(at.every((index) => index >= 0)).toBe(true)
    expect(at).toEqual([...at].sort((a, b) => a - b))
    expect(html).not.toContain('Make tea')
    expect(panel([])).toMatch(/aria-selected="true"[^>]*>(?:(?!<\/button>).)*Recurring/)
  })

  it('keeps every run beside the selected thread and marks the selected one', () => {
    const html = renderToStaticMarkup(
      <RoutineRunsPanel
        routine={routine}
        runs={runs}
        selectedRunId="run-3"
        onOpenRun={() => {}}
        onOpenRoutine={() => {}}
        onClose={() => {}}
      />,
    )

    expect(html).toContain('>Runs<')
    expect(html).toContain('aria-current="page"')
    expect(html.match(/View result|Running/g)).toHaveLength(runs.length)
    expect(html).not.toContain('Run result 0')
  })

  it('names the fire that found nothing, because the chat no longer shows it', () => {
    const html = renderToStaticMarkup(
      <RunHistory
        history={[
          { id: 'run-quiet', chatId: null, result: null, startedAt: Date.UTC(2026, 7, 17, 7), state: 'done', outcome: 'quiet' },
          { id: 'run-spoke', chatId: null, result: null, startedAt: Date.UTC(2026, 7, 17, 6), state: 'done', outcome: 'publish' },
          { id: 'run-failed', chatId: null, result: null, startedAt: Date.UTC(2026, 7, 17, 5), state: 'failed', outcome: 'quiet' },
        ]}
      />,
    )

    // One label, on the one row whose run is otherwise invisible. A published run
    // has its own message in the transcript, and a failure is already named Failed.
    expect(html.match(/0 results/g)).toHaveLength(1)
    expect(html).toContain('aria-label="Failed"')
    expect(html.match(/aria-label="Done"/g)).toHaveLength(2)
  })

  it('dates a DM-hung routine from the fires in that conversation', () => {
    const hung = { ...routine, projectId: null, chatId: 'dm-huxley' }
    const html = renderDetail({
      routine: hung,
      history: {
        chatId: 'dm-huxley',
        runs: [
          { id: 'fire-today', chatId: null, result: null, startedAt: Date.UTC(2026, 8, 9, 5, 40), state: 'running' },
          { id: 'fire-failed', chatId: null, result: null, startedAt: Date.UTC(2026, 8, 9, 5), state: 'failed' },
          { id: 'fire-quiet', chatId: null, result: null, startedAt: Date.UTC(2026, 8, 9, 4), state: 'done', outcome: 'quiet' },
        ],
      },
    })

    expect(html).toContain('Running')
    expect(html).toContain('Failed')
    expect(html).toContain('0 results')
    expect(html).not.toContain('Completed')
    expect(html).not.toContain('16 Aug')
    expect(html).toContain(runDate(Date.UTC(2026, 8, 9, 5, 40)))
    expect(html).toContain('>Open chat<')
  })

  it('leaves a run from before the outcome existed unlabelled rather than guessing', () => {
    const html = renderToStaticMarkup(
      <RunHistory history={[{ id: 'run-old', chatId: null, result: null, startedAt: Date.UTC(2026, 7, 17, 7), state: 'done' }]} />,
    )

    expect(html).not.toContain('0 results')
    expect(html).toContain('aria-label="Done"')
  })

})
