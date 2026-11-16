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

const noArchive = { archived: [], archiveKeepMs: 1 }

const rows = (working: SessionOverviewRow[]) => {
  const html = renderToStaticMarkup(
    <ProjectSessionsOverview
      threadId="runtime-marks-thread"
      overview={{ waiting: [], working, settled: [], ...noArchive }}
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
        overview={{ waiting: [proposal], working: [], settled: [], ...noArchive }}
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
    const live = html({ waiting: [], working: [row({ id: 'live' })], settled: [], ...noArchive })
    // Archive lives in the right-click menu: a stray click on a button archived an open Session.
    expect(live).not.toContain('Archive live')
    expect(live).toContain('aria-label="Settle live"')
    expect(live).not.toContain('Unsettle live')
    const settled = html({ waiting: [], working: [], settled: [{ ...row({ id: 'done' }), status: 'confirmed', running: false }], ...noArchive })
    expect(settled).toContain('aria-label="Unsettle done"')
    expect(settled).not.toContain('aria-label="Settle done"')
  })

  it('lead a fold\'s header with its mark, follow the label with the count and end on the chevron', () => {
    const header = html({ waiting: [], working: [row({ id: 'live' })], settled: [], ...noArchive })
    expect(header).toMatch(/<svg[^>]*class="flex-none text-dim"[^>]*>.*?<\/svg><span class="min-w-0 truncate[^"]*">Needs you<\/span><span class="flex-1[^"]*">0<\/span><span class="grid place-items-center"/)
    expect(header).toMatch(/<svg[^>]*class="flex-none text-busy"[^>]*>.*?<\/svg><span[^>]*>Working<\/span>/)
  })

  it('shows a project with no Session one line instead of folds, and every fold once it holds one', () => {
    const empty = html({ waiting: [], working: [], settled: [], ...noArchive })
    expect(empty).toContain('No Sessions yet. A proposal you accept in the thread starts one.')
    expect(empty).not.toContain('>Needs you<')
    expect(empty).not.toContain('>Working<')
    expect(empty).not.toContain('>Settled<')
    const busy = html({ waiting: [], working: [row({ id: 'live' })], settled: [], ...noArchive })
    expect(busy).toContain('>Working<')
    expect(busy).toContain('>Settled<')
  })
})
