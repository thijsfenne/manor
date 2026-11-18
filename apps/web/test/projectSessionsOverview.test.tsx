import { CURRENT_CHECKOUT, type AgentConfig, type Chat } from '@manor/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ProjectSessionsOverview } from '../src/components/inbox/ProjectSessionsOverview'
import type { SessionOverviewRow } from '../src/state'

/**
 * A project room's overview row carries the same runtime mark as the sidebar card:
 * a Single session its provider, a Multiple one its personas' faces.
 */

const agent = (id: string, name: string): AgentConfig =>
  ({ id, name, color: '#C77DBB', allowedTools: [] }) as unknown as AgentConfig

const chat = (fields: Partial<Chat> & Pick<Chat, 'id'>): Chat => ({
  projectId: 'p1',
  kind: 'project',
  routineId: null,
  parentChatId: null,
  sideModel: null,
  sideEffort: null,
  memberIds: [],
  lastMessagePreview: null,
  title: fields.id,
  createdAt: 1,
  lastMessageAt: 1,
  settledAt: null,
  archivedAt: null,
  agentIds: [],
  checkout: CURRENT_CHECKOUT,
  ...fields,
})

const row = (fields: Partial<Chat> & Pick<Chat, 'id'>): SessionOverviewRow =>
  ({ key: fields.id, title: fields.title ?? fields.id, status: 'working', chat: chat(fields), line: 'Latest line', at: 1, unread: false, running: true, waiting: false })

const noWaitOrArchive = { background: [], archived: [], archiveKeepMs: 1 }

const rows = (working: SessionOverviewRow[]) => {
  const html = renderToStaticMarkup(
    <ProjectSessionsOverview
      threadId="runtime-marks-thread"
      overview={{ waiting: [], working, settled: [], ...noWaitOrArchive }}
      agents={[agent('wren', 'Wren'), agent('iris', 'Iris')]}
      onOpen={() => {}}
      onRevealProposal={() => {}}
      openLabel={(title) => `Open ${title}`}
      onSetSettled={() => true} onSetArchived={() => true} onDeleteChat={() => {}} project={undefined}
    />,
  )
  return html.split('<li').slice(1)
}

describe('the sessions overview row mark', () => {
  it('shows a Single session\'s provider and a Multiple session\'s faces, like the sidebar card', () => {
    const [single, multiple, unpinned] = rows([
      row({ id: 'single', mode: 'single', singleDriver: 'claude' }),
      row({ id: 'multiple', mode: 'house', agentIds: ['wren', 'iris'] }),
      row({ id: 'unpinned', mode: 'single', agentIds: ['wren'] }),
    ])
    expect(single).toContain('fill="#D97757"')
    expect(single).not.toContain('title="Wren')
    expect(multiple).toContain('title="Wren, Iris"')
    expect(multiple).not.toContain('fill="#D97757"')
    // A Single session without a driver gets no mark, the same as its sidebar card.
    expect(unpinned).not.toContain('fill="#D97757"')
    expect(unpinned).not.toContain('title="Wren')
  })
})

describe('the working row progress', () => {
  it('shows the tasks count in place of the age and the unread dot, and nothing before a card exists', () => {
    const [planned = '', bare = '', unread = ''] = rows([
      row({ id: 'planned', planProgress: { done: 2, total: 7 } }),
      row({ id: 'bare' }),
      { ...row({ id: 'unread', planProgress: { done: 1, total: 3 } }), unread: true },
    ])
    expect(planned).toContain('data-plan-ring="2/7"')
    expect(planned).toContain('>2/7<')
    expect(planned).not.toContain('now')
    expect(bare).not.toContain('data-plan-ring')
    expect(bare).not.toContain('now')
    expect(unread).toContain('data-plan-ring="1/3"')
    expect(unread).not.toContain('bg-ok')
  })
})

describe('the worktree mark', () => {
  it('sits left of the provider for a worktree Session and is absent in the shared checkout', () => {
    const [isolated = '', shared = ''] = rows([
      row({ id: 'isolated', mode: 'single', singleDriver: 'claude', checkout: { mode: 'worktree', branch: 'manor/x' } }),
      row({ id: 'shared', mode: 'single', singleDriver: 'claude' }),
    ])
    expect(isolated).toContain('aria-label="Worktree"')
    expect(isolated).toContain('title="Worktree"')
    expect(isolated.indexOf('Worktree')).toBeLessThan(isolated.indexOf('fill="#D97757"'))
    expect(shared).not.toContain('Worktree')
  })
})

describe('a proposal in the sessions overview', () => {
  it('waits on the user and leads to its card, with nothing to settle yet', () => {
    const proposal: SessionOverviewRow = {
      key: 'work:h9', title: 'Exportknop', chat: null, status: 'proposed',
      line: 'Add an export button.', at: 1, unread: false, running: false, waiting: true,
    }
    const html = renderToStaticMarkup(
      <ProjectSessionsOverview
        threadId="proposal-thread"
        overview={{ waiting: [proposal], working: [], settled: [], ...noWaitOrArchive }}
        agents={[]}
        onOpen={() => {}}
        onRevealProposal={() => {}}
        openLabel={(title) => `Open ${title}`}
        onSetSettled={() => true} onSetArchived={() => true} onDeleteChat={() => {}} project={undefined}
      />,
    )
    expect(html).toMatch(/Needs you<\/span><span[^>]*>1</)
    expect(html).toContain('aria-label="Show proposal Exportknop"')
    // The fold's header says it waits; the row itself does not repeat it.
    expect(html).not.toContain('>Waiting<')
    expect(html).not.toContain('Settle Exportknop')
  })
})

describe('the sessions overview rows', () => {
  const html = (overview: Parameters<typeof ProjectSessionsOverview>[0]['overview']) => renderToStaticMarkup(
    <ProjectSessionsOverview
      threadId="sidebar-rows-thread"
      overview={overview}
      agents={[]}
      project={{ name: 'Manor', icon: 'folder', color: '#8A8F98' }}
      onOpen={() => {}}
      onRevealProposal={() => {}}
      openLabel={(title) => `Open ${title}`}
      onSetSettled={() => true}
      onSetArchived={() => true}
      onDeleteChat={() => {}}
    />,
  )

  it('wear the sidebar rows: Settle on a live one, Unsettle on a settled one, and no one-click Archive', () => {
    const live = html({ waiting: [], working: [row({ id: 'live' })], settled: [], ...noWaitOrArchive })
    // Archive lives in the right-click menu: a stray click on a button archived an open Session.
    expect(live).not.toContain('Archive live')
    expect(live).toContain('aria-label="Settle live"')
    expect(live).not.toContain('Unsettle live')
    const settled = html({ waiting: [], working: [], settled: [{ ...row({ id: 'done' }), status: 'confirmed', running: false }], ...noWaitOrArchive })
    expect(settled).toContain('aria-label="Unsettle done"')
    expect(settled).not.toContain('aria-label="Settle done"')
  })

  it('lead a fold\'s header with its mark, follow the label with the count and end on the chevron', () => {
    const header = html({ waiting: [], working: [row({ id: 'live' })], settled: [], ...noWaitOrArchive })
    expect(header).toMatch(/<svg[^>]*class="flex-none text-dim"[^>]*>.*?<\/svg><span class="min-w-0 truncate[^"]*">Needs you<\/span><span class="flex-1[^"]*">0<\/span><span class="grid place-items-center"/)
    expect(header).toMatch(/<svg[^>]*class="flex-none text-busy"[^>]*>.*?<\/svg><span[^>]*>Working<\/span>/)
  })

  it('shows a project with no Session one line instead of folds, and every fold once it holds one', () => {
    const empty = html({ waiting: [], working: [], settled: [], ...noWaitOrArchive })
    expect(empty).toContain('No Sessions yet. A proposal you accept in the thread starts one.')
    expect(empty).not.toContain('>Needs you<')
    expect(empty).not.toContain('>Working<')
    expect(empty).not.toContain('>Settled<')
    const busy = html({ waiting: [], working: [row({ id: 'live' })], settled: [], ...noWaitOrArchive })
    expect(busy).toContain('>Working<')
    expect(busy).toContain('>Settled<')
    // Waiting appears only while a Session waits on background work, never as an empty fold.
    expect(busy).not.toContain('>Waiting<')
  })

  it('show a Waiting fold for a Session waiting on its background work, with what it waits on and no spinner', () => {
    const waiting = { ...row({ id: 'retry', title: 'Phone check' }), status: 'background' as const, running: false, line: 'Retry the phone launch' }
    const markup = html({ ...noWaitOrArchive, waiting: [], working: [], background: [waiting], settled: [] })
    expect(markup).toMatch(/<svg[^>]*class="flex-none text-muted"[^>]*>.*?<\/svg><span[^>]*>Waiting<\/span><span[^>]*>1</)
    expect(markup).toContain('Retry the phone launch')
    expect(markup).not.toContain('animate-spin')
  })
})
