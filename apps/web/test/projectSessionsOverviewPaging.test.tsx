import { CURRENT_CHECKOUT } from '@manor/contracts'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectSessionsOverview } from '../src/components/inbox/ProjectSessionsOverview'
import { ShowMoreRow } from '../src/components/inbox/ShowMoreRow'
import type { SessionOverview, SessionOverviewGroup, SessionOverviewRow } from '../src/state'

const row = (index: number): SessionOverviewRow => ({
  key: `session-${index}`, title: `Session ${index}`, status: 'settled',
  chat: {
    id: `session-${index}`, title: `Session ${index}`, projectId: 'project', kind: 'project',
    routineId: null, parentChatId: null, sideModel: null, sideEffort: null, memberIds: [],
    agentIds: [], createdAt: 1, lastMessageAt: 1, lastMessagePreview: null,
    settledAt: 2, archivedAt: null, checkout: CURRENT_CHECKOUT,
  },
  line: '', at: 1, waiting: false, running: false, unread: false,
})
const overview: SessionOverview = {
  waiting: Array.from({ length: 23 }, (_, index) => row(index + 100)),
  working: [],
  background: [],
  settled: Array.from({ length: 45 }, (_, index) => row(index)),
  archived: [],
  archiveKeepMs: 1,
}

describe('a project thread’s remembered sessions overview', () => {
  let view: ReactTestRenderer
  const onOpen = vi.fn()
  const mount = (threadId: string, compact = false) => {
    act(() => { view = create(<ProjectSessionsOverview agents={[]} threadId={threadId} overview={overview} compact={compact}
      onOpen={onOpen} onRevealProposal={() => {}} openLabel={(title) => `Open ${title}`} onSetSettled={() => true} onSetArchived={() => true} onDeleteChat={() => {}} project={undefined} />) })
  }
  const section = (group: SessionOverviewGroup) => view.root.findAllByType('section')[['waiting', 'working', 'settled'].indexOf(group)]!
  const header = (group: SessionOverviewGroup) => section(group).findAllByType('button').find((button) => button.props['aria-expanded'] !== undefined)!
  const shown = (group: SessionOverviewGroup) => section(group).findAllByType('button').filter((button) => button.props['aria-label']?.startsWith('Open ')).length
  const more = () => view.root.findByType(ShowMoreRow).findByType('button')
  afterEach(() => { act(() => view.unmount()); onOpen.mockClear() })

  it('keeps all folds and the expanded page through an open-session round trip, separately per thread', () => {
    mount('remembered-thread')
    expect(header('waiting').props['aria-expanded']).toBe(true)
    expect(header('working').props['aria-expanded']).toBe(true)
    expect(header('settled').props['aria-expanded']).toBe(false)
    expect(shown('waiting')).toBe(23)
    expect(shown('settled')).toBe(20)
    expect(more().findByType('span').props.children).toEqual(['Show ', 20, ' more'])

    act(() => header('waiting').props.onClick())
    act(() => header('working').props.onClick())
    act(() => header('settled').props.onClick())
    act(() => more().props.onClick())
    expect(shown('settled')).toBe(40)
    expect(more().findByType('span').props.children).toEqual(['Show ', 5, ' more'])
    act(() => section('settled').findAllByType('button').find((button) => button.props['aria-label'] === 'Open Session 25')!.props.onClick())
    expect(onOpen).toHaveBeenCalledWith('session-25')
    act(() => view.unmount())

    mount('other-thread')
    expect(header('settled').props['aria-expanded']).toBe(false)
    expect(shown('settled')).toBe(20)
    act(() => view.unmount())

    // The compact popover and full pane read the same thread state.
    mount('remembered-thread', true)
    expect(header('waiting').props['aria-expanded']).toBe(false)
    expect(header('working').props['aria-expanded']).toBe(false)
    expect(header('settled').props['aria-expanded']).toBe(true)
    expect(shown('settled')).toBe(40)
    act(() => more().props.onClick())
    expect(shown('settled')).toBe(45)
    expect(view.root.findByType(ShowMoreRow).findAllByType('button')).toHaveLength(0)
  })

  it('folds an Archived section at the foot that opens one quiet section at a time and hides expired rows', () => {
    const NOW = 1_000_000
    vi.useFakeTimers({ now: NOW })
    const archivedRow = (index: number, archivedAt: number): SessionOverviewRow => {
      const base = row(index)
      return { ...base, key: `archived-${index}`, title: `Archived ${index}`, status: 'closed', chat: { ...base.chat!, id: `archived-${index}`, title: `Archived ${index}`, archivedAt } }
    }
    const withArchive: SessionOverview = { ...overview, archiveKeepMs: 1000, archived: [archivedRow(1, NOW - 10), archivedRow(2, NOW - 500), archivedRow(3, NOW - 5000)] }
    act(() => { view = create(<ProjectSessionsOverview agents={[]} threadId="archive-thread" overview={withArchive}
      onOpen={onOpen} onRevealProposal={() => {}} openLabel={(title) => `Open ${title}`} onSetSettled={() => true} onSetArchived={() => true} onDeleteChat={() => {}} project={undefined} />) })
    try {
      const sections = view.root.findAllByType('section')
      expect(sections).toHaveLength(4)
      const archiveHeader = sections[3]!.findAllByType('button').find((button) => button.props['aria-expanded'] !== undefined)!
      // Folded by default, counting only rows still inside their restore window.
      expect(archiveHeader.props['aria-expanded']).toBe(false)
      expect(archiveHeader.findAll((node) => node.type === 'span' && String(node.props.className).includes('tabular-nums'))[0]!.props.children).toBe(2)
      act(() => header('settled').props.onClick())
      expect(header('settled').props['aria-expanded']).toBe(true)
      act(() => archiveHeader.props.onClick())
      expect(archiveHeader.props['aria-expanded']).toBe(true)
      expect(header('settled').props['aria-expanded']).toBe(false)
      expect(sections[3]!.findAllByType('li').map((li) => li.findAllByType('span')[0]?.props.children)).toEqual(['Archived 1', 'Archived 2'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives a quiet Session in Settled its live row with Settle, never Unsettle', () => {
    const quiet: SessionOverviewRow = { ...row(1), key: 'quiet', title: 'Quiet', status: 'done', chat: { ...row(1).chat!, id: 'quiet', title: 'Quiet', settledAt: null } }
    const onSetSettled = vi.fn(() => true)
    act(() => { view = create(<ProjectSessionsOverview agents={[]} threadId="quiet-thread" overview={{ ...overview, waiting: [], settled: [quiet, row(2)] }}
      onOpen={onOpen} onRevealProposal={() => {}} openLabel={(title) => `Open ${title}`} onSetSettled={onSetSettled} onSetArchived={() => true} onDeleteChat={() => {}} project={undefined} />) })
    act(() => header('settled').props.onClick())
    const labels = section('settled').findAllByType('button').map((button) => button.props['aria-label'])
    expect(labels).toContain('Settle Quiet')
    expect(labels).not.toContain('Unsettle Quiet')
    expect(labels).toContain('Unsettle Session 2')
    act(() => section('settled').findAllByType('button').find((button) => button.props['aria-label'] === 'Settle Quiet')!.props.onClick())
    expect(onSetSettled).toHaveBeenCalledWith('quiet', true)
  })

  it('reads the new thread’s state when its id changes without an unmount', () => {
    mount('switch-from')
    act(() => header('settled').props.onClick())
    act(() => view.update(<ProjectSessionsOverview agents={[]} threadId="switch-to" overview={overview}
      onOpen={onOpen} onRevealProposal={() => {}} openLabel={(title) => `Open ${title}`} onSetSettled={() => true} onSetArchived={() => true} onDeleteChat={() => {}} project={undefined} />))
    expect(header('settled').props['aria-expanded']).toBe(false)
    expect(shown('settled')).toBe(20)
  })
})
