import { NEW_SINGLE_CHAT_DEFAULT, type AgentConfig, type Project, type ThreadEvent } from '@manor/contracts'
import { emptyThread, rowsOf } from '@manor/client-runtime/state'
import { renderToStaticMarkup } from 'react-dom/server'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it } from 'vitest'
import { Transcript } from '../src/components/Transcript'
import { WorkHandoffCard } from '../src/components/WorkHandoffCard'
import { WorkResultBody, type WorkResultActions } from '../src/components/WorkResultBody'
import { modelLabel } from '../src/runtimes'
import type { Row, WorkHandoffRow } from '../src/state'

const sage: AgentConfig = {
  id: 'sage', name: 'Sage', color: '#6FA8A0', character: '', driver: 'mock', effort: 'medium',
  allowedTools: [], mcpServers: [], memoryScope: false, description: '', role: '', isCos: false,
}
const jeeves = { ...sage, id: 'marlow', name: 'Jeeves' }

const card = (status: WorkHandoffRow['status']): WorkHandoffRow => ({
  kind: 'work_handoff',
  key: 'work:handoff_1',
  handoffId: 'handoff_1',
  projectId: 'project_1',
  workChatId: null,
  title: 'Keep DM browser tabs',
  projectName: 'Manor',
  projectIcon: 'home',
  projectColor: '#388B83',
  leadAgentId: 'sage',
  leadAgentName: 'Sage',
  supportingAgentIds: [],
  supportingAgentNames: [],
  status,
  session: status === 'Working' ? 'proposed' : 'closed',
  result: null,
  acceptedAt: null,
  worktreeAvailable: true,
})

describe('Work handoff card verbs', () => {
  it('shows a kickoff as its brief alone, without a project badge', () => {
    const row = {
      kind: 'event' as const,
      key: 'kickoff',
      event: {
        id: 'kickoff', ts: 1, type: 'user_message' as const, source: 'work_handoff' as const, mentions: [],
        text: '[Manor] Session accepted as Single with claude-opus-5-5. Complete the task below in this session.\n\nDo the task.',
        workAuthorAgentId: 'marlow', workAuthorAgentName: 'Jeeves', workTargetLeadId: 'sage',
      },
    }
    const markup = renderToStaticMarkup(
      <Transcript rows={[row]} agents={[]} identityAgents={[jeeves, sage]} skills={[]} hasSnapshot showSpeakers={false} />)
    expect(markup).toContain('Do the task.')
    expect(markup).not.toContain('[Manor]')
    expect(markup).not.toContain('Session accepted')
    expect(markup).not.toContain('Kickoff from')
    expect(markup).not.toContain('prepared by')
  })

  it('shows a DM brief handed to the project thread as the same card, with only its task', () => {
    const row = {
      kind: 'event' as const,
      key: 'brief',
      event: {
        id: 'brief', ts: 1, type: 'user_message' as const, source: 'project_thread' as const, threadReason: 'brief' as const, mentions: [],
        text: '[Manor] Smith handed this brief over from a DM. Call start_work in this turn.\nTitle: Card\nTask:\nDo the brief.',
      },
    }
    const markup = renderToStaticMarkup(
      <Transcript rows={[row]} agents={[]} identityAgents={[sage]} skills={[]} hasSnapshot showSpeakers={false} />)
    expect(markup).toContain('Do the brief.')
    expect(markup).not.toContain('start_work')
    expect(markup).not.toContain('Brief from a DM')
  })

  it('names what goes along on the proposal, and draws it on the kickoff', () => {
    const proposal = renderToStaticMarkup(<Transcript rows={[{ ...card('Working'), task: 'Do it.', attachments: ['screen.png', 'mockup.html'] }]} agents={[sage]} skills={[]} hasSnapshot
      onAcceptWork={() => undefined} onRejectWork={() => undefined} />)
    expect(proposal).toContain('2 attachments: screen.png, mockup.html')
    const plain = renderToStaticMarkup(<Transcript rows={[{ ...card('Working'), task: 'Do it.' }]} agents={[sage]} skills={[]} hasSnapshot
      onAcceptWork={() => undefined} onRejectWork={() => undefined} />)
    expect(plain).not.toContain('attachment')
    const kickoff = {
      kind: 'event' as const,
      key: 'kickoff',
      event: {
        id: 'kickoff', ts: 1, type: 'user_message' as const, source: 'work_handoff' as const, mentions: [], text: 'Build it.',
        images: [{ name: 'screen.png', src: '/media/screen.png' }],
        files: [{ name: 'mockup.html', mime: 'text/html', content: '<p>mockup</p>' }],
      },
    }
    const markup = renderToStaticMarkup(<Transcript rows={[kickoff]} agents={[]} identityAgents={[sage]} skills={[]} hasSnapshot showSpeakers={false} />)
    expect(markup).toContain('/media/screen.png')
    expect(markup).toContain('mockup.html')
  })

  it('keeps mode, model and the prompt behind one Options button, and shows Worktree ticked on the action row, so the card shows Options, Worktree, Reject and Accept', () => {
    const proposal = renderToStaticMarkup(<Transcript rows={[{ ...card('Working'), task: 'Do it.' }]} agents={[sage]} skills={[]} hasSnapshot
      onAcceptWork={() => undefined} onRejectWork={() => undefined} />)

    expect(proposal).toMatch(/aria-expanded="false"[^>]*aria-controls="work-handoff-handoff_1-options"[^>]*>Options</)
    expect(proposal.match(/<button/g)).toHaveLength(3)
    expect(proposal).not.toContain('mode-single')
    expect(proposal).toMatch(/<input[^>]*checked=""[^>]*>[\s\S]*Worktree[\s\S]*>Reject</)
    expect(proposal).not.toContain('View prompt')
    expect(proposal).not.toContain('awaits acceptance')
  })

  it('keeps separate acceptance cards for multiple assignments from one message', () => {
    const rows = ['Quote messages', 'Browser destination', 'Subscription graph'].map((title, index) => ({
      ...card('Working'), key: `work:handoff_${index}`, handoffId: `handoff_${index}`, workChatId: `work_${index}`, title,
    }))
    const markup = renderToStaticMarkup(<Transcript rows={rows} agents={[sage]} skills={[]} hasSnapshot
      onAcceptWork={() => undefined} onRejectWork={() => undefined} />)
    for (const row of rows) expect(markup).toContain(row.title)
    expect(markup.match(/>Accept</g)).toHaveLength(3)
    expect(markup.match(/>Reject</g)).toHaveLength(3)
  })

  it('names the lead and the executor beside the project badge without a separate start line', () => {
    const markup = renderToStaticMarkup(<Transcript rows={[{
      ...card('Working'), firstExecutorName: 'Smith', supportingAgentIds: ['rune'], supportingAgentNames: ['Rune'],
    }]} agents={[sage, { ...sage, id: 'rune', name: 'Rune' }]} skills={[]} hasSnapshot onAcceptWork={() => undefined} />)
    expect(markup).toContain('>led by Sage, Smith starts<')
    expect(markup).not.toContain('>Rune<')
    expect(markup).toContain('color-mix(in srgb, #388B83 16%, transparent)')
    expect(markup).not.toContain('Starts:')
  })

  it('labels a revised proposal and folds the version it replaced into one line without actions', () => {
    const markup = renderToStaticMarkup(<Transcript rows={[
      { ...card('Settled'), replacedBy: { key: 'work:handoff_2', revision: 2 } },
      { ...card('Working'), key: 'work:handoff_2', handoffId: 'handoff_2', revision: 2 },
    ]} agents={[sage]} skills={[]} hasSnapshot onAcceptWork={() => undefined} onRejectWork={() => undefined} />)
    expect(markup).toContain('>Replaced by v2<')
    expect(markup).not.toContain('>Rejected<')
    expect(markup).toContain('>v2<')
    expect(markup.match(/>Accept</g)).toHaveLength(1)
    expect(markup.match(/>Reject</g)).toHaveLength(1)
  })

  it('shows the proposed task until Accept and puts Accept after Reject', () => {
    const task = 'Research how Hermes keeps memory per bot.'
    const pending = renderToStaticMarkup(<Transcript rows={[{ ...card('Working'), task }]} agents={[sage]} skills={[]} hasSnapshot
      onAcceptWork={() => undefined} onRejectWork={() => undefined} />)
    expect(pending).toContain(task)
    expect(pending.indexOf('>Reject<')).toBeLessThan(pending.indexOf('>Accept<'))
    const accepted = renderToStaticMarkup(<Transcript rows={[{ ...card('Working'), task, workChatId: 'work_1', acceptedAt: 1, session: 'working' }]}
      agents={[sage]} skills={[]} hasSnapshot onAcceptWork={() => undefined} onOpenAgentRelay={() => undefined} />)
    expect(accepted).not.toContain(task)
    // Working is the whole state; the card itself opens the Session.
    expect(accepted).toContain('aria-label="Open Session Keep DM browser tabs"')
    expect(accepted).toContain('cursor-pointer')
    expect(accepted).not.toContain('>Open Session<')
  })

  it('prefers the author summary over the task on the goal line', () => {
    const markup = renderToStaticMarkup(<Transcript rows={[{
      ...card('Working'), task: 'Review commit 78388511 in /Users/sam/Manor.', summary: 'Find why clearing a chat fails.',
    }]} agents={[sage]} skills={[]} hasSnapshot onAcceptWork={() => undefined} />)
    expect(markup).toContain('>Find why clearing a chat fails.<')
    expect(markup).not.toContain('>Review commit 78388511')
  })

  it('folds a settled Session to one line: title, the first sentence of its outcome, and how it ended', () => {
    const markup = renderToStaticMarkup(<Transcript rows={[{
      ...card('Settled'), workChatId: 'work_1', acceptedAt: 1, result: 'Dr. Smith kept per-agent memory beside the shared layer. It reads well.\nA pause switch is still open.',
    }]} agents={[sage]} skills={[]} hasSnapshot onOpenAgentRelay={() => undefined} />)
    expect(markup).toContain('>Keep DM browser tabs</span>, Dr. Smith kept per-agent memory beside the shared layer.<')
    expect(markup).not.toContain('It reads well.')
    expect(markup).not.toContain('A pause switch is still open.')
    expect(markup).toContain('Settled')
    expect(markup).toMatch(/<button[^>]*title="Open Session"/)
  })

  it('shows a ready result with its file count, reviewer and a Confirm that says what it commits', () => {
    const report = {
      handoffId: 'handoff_1', workChatId: 'work_1', version: 3, result: 'Export works.', limitations: 'Not tested on an empty chat.',
      leadAgentName: 'Sage', files: 12, reviewer: 'Argus', operation: 'commit', worktree: false, decision: 'open', evidence: [],
    } as const
    const markup = renderToStaticMarkup(<Transcript rows={[{ ...card('Working'), workChatId: 'work_1', acceptedAt: 1, session: 'ready', report }]}
      agents={[sage]} skills={[]} hasSnapshot onOpenAgentRelay={() => undefined} onOpenDiff={() => undefined}
      resultActions={{ requestEvents: { subscribe: () => () => undefined }, connected: true, accept: () => true, revise: () => true, retry: () => true, askCheckout: () => undefined }} />)
    expect(markup).toMatch(/text-text"[^>]*><span aria-hidden="true"[^>]*><\/span>Ready</)
    // Layout D: the file count opens the diff; the reviewer line went with the meta line.
    expect(markup).toMatch(/title="Show the diff"[^>]*>12 files<\/button>/)
    expect(markup).not.toContain('Reviewed by')
    expect(markup).toContain('line-clamp-2')
    expect(markup).toMatch(/title="Commits the 12 reviewed files\."[^>]*>Confirm</)
    expect(markup).not.toContain('Confirm lets')
    expect(markup).not.toContain('>Open Session<')
  })

  it('says once on a Working card that it changed after it was ready, and names a commit that did not land', () => {
    const reopened = renderToStaticMarkup(<Transcript rows={[{ ...card('Working'), workChatId: 'work_1', acceptedAt: 1, changedAfterReady: true }]}
      agents={[sage]} skills={[]} hasSnapshot />)
    expect(reopened).toContain('Changed after it was ready. Sage is preparing a new version.')
    // A Single Session has no persona: the card names none.
    const single = renderToStaticMarkup(<Transcript rows={[{ ...card('Working'), workChatId: 'work_1', acceptedAt: 1, mode: 'single', changedAfterReady: true }]}
      agents={[sage]} skills={[]} hasSnapshot />)
    expect(single).toContain('Changed after it was ready. A new version is being prepared.')
    expect(single).not.toContain('Sage is preparing')
    const blocked = renderToStaticMarkup(<Transcript rows={[{
      ...card('Working'), workChatId: 'work_1', acceptedAt: 1, report: {
        handoffId: 'handoff_1', workChatId: 'work_1', version: 3, result: 'Export works.', leadAgentName: 'Sage', files: 1,
        operation: 'commit', worktree: false, decision: 'accepted', evidence: [],
        completion: { status: 'blocked', operation: 'commit', message: 'a.ts is not committed on main.' },
      },
    }]} agents={[sage]} skills={[]} hasSnapshot onOpenAgentRelay={() => undefined} />)
    // The header says what happened, never Committing…; the body says why and leads into the Session.
    expect(blocked).toMatch(/text-warn"[^>]*><span aria-hidden="true"[^>]*><\/span>Commit blocked</)
    expect(blocked).not.toContain('Committing…')
    expect(blocked).toMatch(/role="status" title="a\.ts is not committed on main\."[^>]*>a\.ts is not committed on main\.</)
    expect(blocked).toContain('>Open Session</button>')
    // With actions, Retry sits beside Open Session; a refusal replaces it with its reason.
    const blockedRow = (completion: { retryRefused?: string } = {}, status: 'Working' | 'Settled' = 'Working') => renderToStaticMarkup(<Transcript rows={[{
      ...card(status), workChatId: 'work_1', acceptedAt: 1, report: {
        handoffId: 'handoff_1', workChatId: 'work_1', version: 3, result: 'Export works.', leadAgentName: 'Sage', files: 1,
        operation: 'commit', worktree: true, decision: 'accepted', evidence: [],
        completion: { status: 'blocked', operation: 'merge', message: 'Hook failed: apps/web test.', ...completion },
      },
    }]} agents={[sage]} skills={[]} hasSnapshot onOpenAgentRelay={() => undefined}
      resultActions={{ requestEvents: { subscribe: () => () => undefined }, connected: true, accept: () => true, revise: () => true, retry: () => true, askCheckout: () => undefined }} />)
    expect(blockedRow()).toMatch(/>Open Session<\/button>.*>Retry<\/button>/)
    expect(blockedRow()).not.toContain('>Confirm<')
    const refused = blockedRow({ retryRefused: 'a.ts changed since Confirm. Request a new result in the Session.' })
    expect(refused).not.toContain('>Retry<')
    expect(refused).toContain('>a.ts changed since Confirm. Request a new result in the Session.<')
    expect(blockedRow({}, 'Settled')).not.toContain('>Retry<')
    const committed = renderToStaticMarkup(<Transcript rows={[{
      ...card('Working'), workChatId: 'work_1', acceptedAt: 1, report: {
        handoffId: 'handoff_1', workChatId: 'work_1', version: 3, result: 'Export works. Also faster.', leadAgentName: 'Sage', files: 1,
        operation: 'commit', worktree: true, decision: 'accepted', evidence: [], completion: { status: 'complete', operation: 'merge', mergeInto: 'main' },
      },
    }]} agents={[sage]} skills={[]} hasSnapshot />)
    // A landed merge folds to what landed: the title, the file count, Merged into main.
    expect(committed).toContain('>, 1 file<')
    expect(committed).toContain('Merged into main')
    expect(committed).not.toContain('Export works.')
  })

  it.each([
    [{ ...card('Settled'), result: 'Rejected before work started.' }, 'Rejected'],
    [card('Deleted'), 'Deleted'],
  ] as const)('collapses a proposal that never ran to one struck line', (row, label) => {
    const markup = renderToStaticMarkup(<Transcript rows={[row]} agents={[sage]} skills={[]} hasSnapshot />)
    expect(markup).toContain('line-through')
    expect(markup).toContain(`>${label}<`)
    expect(markup).not.toContain('Rejected before work started.')
    expect(markup).not.toContain('bg-surface-2')
  })

  it('keeps a legacy settled Work with its own chat reachable as one line, not a struck one', () => {
    const markup = renderToStaticMarkup(<Transcript rows={[{
      ...card('Settled'), workChatId: 'work_1', result: 'Kept per-agent memory.',
    }]} agents={[sage]} skills={[]} hasSnapshot onOpenAgentRelay={() => undefined} />)
    expect(markup).not.toContain('line-through')
    expect(markup).toContain('Kept per-agent memory.')
    expect(markup).toMatch(/<button[^>]*title="Open Session"/)
  })

  it('names only the chosen model, no lead and no persona start, while Single is selected or after Single is accepted', () => {
    const pending = renderToStaticMarkup(<Transcript rows={[{ ...card('Working'), firstExecutorName: 'Smith' }]}
      agents={[sage]} skills={[]} hasSnapshot onAcceptWork={() => undefined} />)
    const accepted = renderToStaticMarkup(<Transcript rows={[{
      ...card('Working'), workChatId: 'work_1', acceptedAt: 123, mode: 'single', singleDriver: 'codex', singleModel: 'gpt-6-luna', firstExecutorName: 'Smith',
    }]} agents={[sage]} skills={[]} hasSnapshot onAcceptWork={() => undefined} />)

    expect(pending).toContain(`>${modelLabel(NEW_SINGLE_CHAT_DEFAULT.driver, NEW_SINGLE_CHAT_DEFAULT.model)}, High<`)
    expect(pending).not.toContain('led by')
    expect(pending).not.toContain('Smith starts')
    expect(pending).not.toContain('data-agent-layout="cluster"')
    expect(accepted).toContain('>GPT-6 Luna<')
    expect(accepted).not.toContain('led by')
    expect(accepted).not.toContain('Smith starts')
  })

  it.each([undefined, false])('hides isolation without confirmed Git roots (%s)', (worktreeAvailable) => {
    const markup = renderToStaticMarkup(<Transcript rows={[{ ...card('Working'), worktreeAvailable }]}
      agents={[sage]} skills={[]} hasSnapshot onAcceptWork={() => undefined} onRejectWork={() => undefined} />)
    expect(markup).not.toContain('Worktree')
    expect(markup).toContain('Accept')
    expect(markup).toContain('Reject')
  })

  it('offers Accept and Reject only while the Work is live', () => {
    const working = renderToStaticMarkup(
      <Transcript
        rows={[card('Working')]}
        agents={[sage]}
        skills={[]}
        hasSnapshot
        onAcceptWork={() => undefined}
        onRejectWork={() => undefined}
      />,
    )
    expect(working).toContain('>Options<')
    expect(working).toContain(' checked=')
    expect(working).not.toContain('Working')
    expect(working).toContain('bg-primary')
    expect(working).toContain('Accept')
    expect(working).toContain('Reject')
    expect(working).toContain('Keep DM browser tabs')

    const accepted = renderToStaticMarkup(
      <Transcript
        rows={[{ ...card('Working'), acceptedAt: 123, session: 'working', worktreeBranch: 'manor/work-1' }]}
        agents={[sage]}
        skills={[]}
        hasSnapshot
        onAcceptWork={() => undefined}
        onRejectWork={() => undefined}
      />,
    )
    expect(accepted).not.toContain('Accept')
    expect(accepted).not.toContain('Reject')
    expect(accepted).toContain('Working')
    expect(accepted).toContain('text-busy')
    expect(accepted).toContain('manor/work-1')
    expect(accepted).not.toContain('Worktree')
    // The header follows the Session's shared status, for a question and for a turn that ended.
    const live = (session: WorkHandoffRow['session']) => renderToStaticMarkup(
      <Transcript rows={[{ ...card('Working'), acceptedAt: 123, session }]} agents={[sage]} skills={[]} hasSnapshot onAcceptWork={() => undefined} />,
    )
    expect(live('waiting')).toContain('Waiting')
    expect(live('waiting')).toContain('text-warn')
    expect(live('waiting')).not.toContain('Working')
    expect(live('done')).toContain('Done')
    expect(live('done')).not.toContain('text-busy')

    const settled = renderToStaticMarkup(
      <Transcript
        rows={[{ ...card('Settled'), workChatId: 'work_1', acceptedAt: 123 }]}
        agents={[sage]}
        skills={[]}
        hasSnapshot
        onAcceptWork={() => undefined}
        onRejectWork={() => undefined}
      />,
    )
    expect(settled).not.toContain('Accept')
    expect(settled).not.toContain('Reject')

    const archived = renderToStaticMarkup(
      <Transcript
        rows={[card('Archived')]}
        agents={[sage]}
        skills={[]}
        hasSnapshot
        onAcceptWork={() => undefined}
        onRejectWork={() => undefined}
      />,
    )
    expect(archived).not.toContain('Accept')
    expect(archived).not.toContain('Worktree')
    expect(archived).not.toContain('Reject')
  })
})

describe('the result actions while Manor is offline', () => {
  const result = {
    handoffId: 'h1', workChatId: 'w1', version: 2, result: 'Export button added.', leadAgentName: 'Wren', files: 1,
    operation: 'commit', worktree: false, decision: 'open', evidence: [],
  } as const
  const actions = (connected: boolean): WorkResultActions => ({
    requestEvents: { subscribe: () => () => undefined }, connected,
    accept: () => true, revise: () => true, retry: () => true, askCheckout: () => undefined,
  })
  const disabled = (html: string, label: string) =>
    new RegExp(`<button[^>]*disabled=""[^>]*>${label}</button>`).test(html)

  it('holds Confirm and Request changes until the connection is back', () => {
    const offline = renderToStaticMarkup(<WorkResultBody result={result} actions={actions(false)} />)
    expect(disabled(offline, 'Confirm')).toBe(true)
    expect(disabled(offline, 'Request changes')).toBe(true)
    const live = renderToStaticMarkup(<WorkResultBody result={result} actions={actions(true)} />)
    expect(disabled(live, 'Confirm')).toBe(false)
    expect(live).not.toContain('>Accept<')
  })
})

const threadProject = { id: 'project_1', name: 'Manor', icon: 'folder', color: '#388B83' } as Project

describe('a Session card in its project thread', () => {
  const render = (row: WorkHandoffRow) => renderToStaticMarkup(
    <Transcript rows={[row]} agents={[]} identityAgents={[sage]} skills={[]} hasSnapshot showSpeakers={false}
      onAcceptWork={() => {}} onRejectWork={() => {}} onOpenAgentRelay={() => {}} threadProject={threadProject} />,
  )

  it('keeps a proposal whole without the project badge, then folds an accepted one to a line with the overview’s word', () => {
    const proposal = render({ ...card('Working'), task: 'Keep the tabs a DM opened.' })
    expect(proposal).toContain('>Accept<')
    expect(proposal).toContain('>Keep the tabs a DM opened.<')
    expect(proposal).toContain('>Opus 5.5, High<')
    expect(proposal).not.toContain('led by')
    expect(proposal).not.toContain('>Manor<')
    const accepted = { ...card('Working'), workChatId: 'work_1', acceptedAt: 2, worktreeBranch: 'manor/tabs' }
    const waiting = render({ ...accepted, session: 'done' })
    expect(waiting).toContain('aria-label="Open Session Keep DM browser tabs, Waiting on you"')
    expect(waiting).not.toContain('>Accept<')
    expect(waiting).not.toContain('manor/tabs')
    expect(render({ ...accepted, session: 'working' })).toContain('Open Session Keep DM browser tabs, Working')
  })
})

describe('quiet turn chrome in a project thread', () => {
  it('hides a finished turn’s status and actions until hover or focus, on the first reply too', () => {
    const turn = (id: string, model: string): ThreadEvent[] => [
      { id: `m_${id}`, ts: 1_000, type: 'agent_message', turnId: id, agentId: '__single__', messageId: `m_${id}`, text: `Reply ${id}` },
      { id: `e_${id}`, ts: 5_000, type: 'turn_result', turnId: id, agentId: '__single__', reportedModel: model, usage: { inputTokens: 0, outputTokens: 0 } } as ThreadEvent,
    ]
    const rows = rowsOf({ ...emptyThread, events: [...turn('t1', 'claude-opus-5-5'), ...turn('t2', 'claude-fable-5-2')] })
    const quietIn = (markup: string) => markup.split('group-focus-within/turn:opacity-100').length - 1
    const thread = renderToStaticMarkup(<Transcript rows={rows} agents={[]} skills={[]} hasSnapshot showSpeakers={false} threadProject={threadProject} />)
    // Both footers and both Worked for lines; a changed model keeps nothing shown.
    expect(thread.match(/Worked for 4s/g)).toHaveLength(2)
    expect(quietIn(thread)).toBe(4)
    expect(thread).not.toContain('Opus 5.5')
    // Outside a thread the footers stay shown, and the Worked for lines still wait.
    expect(quietIn(renderToStaticMarkup(<Transcript rows={rows} agents={[]} skills={[]} hasSnapshot showSpeakers={false} />))).toBe(2)
  })
})

describe('the rhythm of a project thread', () => {
  const events: ThreadEvent[] = [
    { id: 'm1', ts: 1, type: 'agent_message', turnId: 't1', agentId: '__single__', messageId: 'm1', text: 'Voorgesteld.' },
    { id: 'e1', ts: 2, type: 'turn_result', turnId: 't1', agentId: '__single__' },
    { id: 'u1', ts: 3, type: 'user_message', text: 'Top, bedankt', mentions: [] },
  ]
  const turn = rowsOf({ ...emptyThread, events })
  const cards = ['a', 'b'].map((key): Row => ({ ...card('Working'), key, handoffId: key, workChatId: key, acceptedAt: 2 }))
  const rows = [turn[0]!, ...cards, turn[1]!]
  const render = (props: { threadProject?: Project; variant?: 'panel' }) =>
    renderToStaticMarkup(<Transcript rows={rows} agents={[]} skills={[]} hasSnapshot showSpeakers={false} {...props} />)
  const rowClass = (markup: string, key: string) => markup.match(new RegExp(`data-transcript-row="${key}" class="([^"]*)"`))?.[1]

  it('stacks cards that follow each other and sets the user and the row under a reply lower', () => {
    const markup = render({ threadProject })
    expect(rowClass(markup, 'a')).toContain(' mt-4')
    expect(rowClass(markup, 'b')).toContain('-mt-6')
    expect(rowClass(markup, 'u1')).toContain(' mt-4')
    expect(rowClass(render({ threadProject, variant: 'panel' }), 'b')).toContain('-mt-4')
    // Everywhere else the feed keeps its one gap.
    expect(rowClass(render({}), 'b')).not.toMatch(/mt-/)
    expect(rowClass(render({}), 'u1')).not.toMatch(/mt-/)
  })
})

describe('the screenshots under a result', () => {
  const base = {
    handoffId: 'h1', workChatId: 'w1', version: 2, result: 'The card shows screenshots.', leadAgentName: 'Wren', files: 1,
    operation: 'commit', worktree: false, decision: 'open',
  } as const

  it('shows each screenshot as a small thumbnail that opens the viewer, and nothing without any', () => {
    const shots = ['one.png', 'two.png', 'three.png'].map((name) => ({ name, src: `/media/w1/${name}/e/sig`, width: 1440, height: 900 }))
    const markup = renderToStaticMarkup(<WorkResultBody result={{ ...base, evidence: shots }} />)
    expect(markup).toContain('aria-label="Screenshots"')
    expect(markup.match(/aria-label="Enlarge (one|two|three)\.png"/g)).toHaveLength(3)
    expect(markup).toContain('h-8')
    expect(renderToStaticMarkup(<WorkResultBody result={{ ...base, evidence: [] }} />)).not.toContain('Screenshots')
  })
})

describe('the two result cards (2026-10-14)', () => {
  const actions: WorkResultActions = {
    requestEvents: { subscribe: () => () => undefined }, connected: true, accept: () => true, revise: () => true, retry: () => true, askCheckout: () => undefined,
  }
  const choices = [
    { title: 'Open large', options: ["Manor's Browser", 'a zoom view like T3'], recommended: 'zoom' },
    { title: 'Theme', options: ['injected', 'fixed'] },
    { title: 'Height', options: ['fit', 'fixed'] },
    { title: 'Scripts', options: ['on', 'off'] },
  ]
  const base = {
    handoffId: 'handoff_1', workChatId: 'work_1', version: 3, leadAgentName: 'Sage', worktree: false, decision: 'open', evidence: [],
  } as const
  const render = (report: WorkHandoffRow['report'], session: WorkHandoffRow['session'] = 'ready') => renderToStaticMarkup(
    <Transcript rows={[{ ...card('Working'), workChatId: 'work_1', acceptedAt: 1, session, report }]} agents={[sage]} skills={[]} hasSnapshot
      onOpenAgentRelay={() => undefined} onOpenReport={() => undefined} onOpenDiff={() => undefined} resultActions={actions} />)

  it('puts the conclusion, the open choices and Open report on a report, with Follow up and Close and no reviewer', () => {
    const markup = render({ ...base, result: 'HTML can look native in the chat.', files: 0, operation: 'none', choices })
    expect(markup).toContain('HTML can look native in the chat.')
    expect(markup).not.toContain('choices open')
    expect(markup).not.toContain('Reviewed by')
    // Each question on its line, its options as buttons that are not yet picked.
    expect(markup).toContain('>Open large</p>')
    expect(markup).toMatch(/aria-pressed="false"[^>]*><span[^>]*>Manor&#x27;s Browser<\/span>/)
    expect(markup).toMatch(/aria-pressed="false"[^>]*><span[^>]*>a zoom view like T3<\/span>/)
    expect(markup).toContain('>+1 more in the report<')
    expect(markup).not.toContain('>Scripts</p>')
    expect(markup).toMatch(/>Open report<\/button>.*>Follow up<\/button>.*>Close<\/button>/s)
    expect(markup).not.toContain('>Confirm<')
    expect(markup).not.toContain('>Request changes<')
    // Working again: the header says so and Close waits until the Session is done.
    const working = render({ ...base, result: 'HTML can look native in the chat.', files: 0, operation: 'none', choices }, 'working')
    expect(working).toContain('Working')
    expect(working).not.toContain('>Close<')
    expect(working).not.toContain('>Follow up<')
  })

  it('keeps Request changes and Confirm with its tooltip on a result with files, and shows no Open report without choices', () => {
    const markup = render({ ...base, result: 'Export works.', files: 12, reviewer: 'Argus', operation: 'commit' })
    expect(markup).toMatch(/title="Show the diff"[^>]*>12 files<\/button>/)
    expect(markup).toMatch(/title="Commits the 12 reviewed files\."[^>]*>Confirm</)
    expect(markup).toContain('>Request changes<')
    expect(markup).not.toContain('more in the report')
    expect(markup).not.toContain('>Open report<')
    expect(markup).not.toContain('>Close<')
  })
})

describe('a thread proposal nobody leads', () => {
  const textOf = (node: ReactTestInstance): string =>
    node.children.map((child) => typeof child === 'string' ? child : textOf(child)).join('')
  /** Opens Options on the card and returns its Multiple segment and the visible text. */
  const openOptions = (row: WorkHandoffRow, household: AgentConfig[]) => {
    let tree!: ReactTestRenderer
    act(() => {
      tree = create(<WorkHandoffCard row={row} agents={[]} identityAgents={household} onReveal={() => undefined}
        onAccept={() => undefined} onReject={() => undefined} inThread />)
    })
    const options = tree.root.findAll((node) => node.type === 'button' && textOf(node).startsWith('Options'))[0]!
    act(() => { options.props.onClick() })
    const multiple = tree.root.find((node) => node.type === 'button' && textOf(node) === 'Multiple')
    return { multiple, text: textOf(tree.root) }
  }
  const leadless: WorkHandoffRow = { ...card('Working'), handoffId: 'handoff_leadless', leadAgentId: '', leadAgentName: '', firstExecutorName: '', threadAuthored: true }

  it('disables Multiple and says to add a session agent when the install has none', () => {
    const { multiple, text } = openOptions(leadless, [{ ...sage, placement: 'chat' }])
    expect(multiple.props.disabled).toBe(true)
    expect(text).toContain('Add a session agent to run Multiple')
  })

  it('disables Multiple with its reason when Session personas exist but none leads the card', () => {
    const { multiple, text } = openOptions({ ...leadless, handoffId: 'handoff_unled' }, [{ ...sage, id: 'pilot', name: 'Pilot', placement: 'session' }])
    expect(multiple.props.disabled).toBe(true)
    expect(text).toContain('No Session persona leads this proposal, so it runs as Single')
  })

  it('starts a team card on Single when its lead is gone', () => {
    const team: WorkHandoffRow = { ...card('Working'), handoffId: 'handoff_gone', leadAgentId: 'deleted', leadAgentName: 'Gone', supportingAgentIds: ['pilot'], supportingAgentNames: ['Pilot'] }
    let tree!: ReactTestRenderer
    act(() => {
      tree = create(<WorkHandoffCard row={team} agents={[]} identityAgents={[{ ...sage, id: 'pilot', name: 'Pilot', placement: 'session' }]}
        onReveal={() => undefined} onAccept={() => undefined} onReject={() => undefined} />)
    })
    const options = tree.root.findAll((node) => node.type === 'button' && textOf(node).startsWith('Options'))[0]!
    act(() => { options.props.onClick() })
    const single = tree.root.find((node) => node.type === 'button' && textOf(node) === 'Single')
    expect(single.props['aria-selected']).toBe(true)
  })

  it('keeps Multiple open on a card a Session persona leads', () => {
    const { multiple, text } = openOptions({ ...card('Working'), handoffId: 'handoff_led', threadAuthored: true }, [{ ...sage, placement: 'session' }])
    expect(multiple.props.disabled).toBe(false)
    expect(text).not.toContain('session agent')
  })
})

describe('a DM brief forwarded to its project thread', () => {
  const forwarded = (workChatId: string | null): WorkHandoffRow => ({
    ...card('Working'), workChatId, acceptedAt: 2, session: 'waiting', forwarded: { threadChatId: 'thread', phase: 'working' },
  })
  const press = (row: WorkHandoffRow) => {
    const opened: string[] = []
    let tree!: ReactTestRenderer
    act(() => {
      tree = create(<WorkHandoffCard row={row} agents={[]} identityAgents={[sage]} onReveal={() => undefined} onOpenThread={(chatId) => opened.push(chatId)} />)
    })
    act(() => { tree.root.find((node) => node.type === 'button').props.onClick() })
    return opened
  }

  it('opens the Session on the right of the room once it exists, and the thread before that', () => {
    expect(press(forwarded('session'))).toEqual(['session'])
    expect(press(forwarded(null))).toEqual(['thread'])
  })
})
