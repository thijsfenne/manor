import { CURRENT_CHECKOUT, type AgentConfig, type Chat, type Project } from '@manor/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { InboxView } from '../src/components/inbox/InboxView'
import { SubagentChildRows } from '../src/components/SubagentChildRows'
import { emptyWorkspace, inbox, type SidebarSubagent, type SubagentGroup, type WorkspaceState } from '../src/state'
import {
  expandSubagentRows,
  litSubagentId,
  rowsHidingActive,
  subagentLines,
  toggleSubagentRow,
  visibleSubagentLines,
} from '../src/subagentCollapse'

const child = (id: string, title: string): SidebarSubagent =>
  ({ id, parentChatId: 'session', toolCallId: `call-${id}`, driver: 'claude', title, state: 'running', startedAt: 1 })

// The Session row carries A, which launched A1 and A2, and B beside it.
const group: SubagentGroup = {
  children: [child('a', 'Settings slice'), child('a1', 'Inventory server'), child('a2', 'Inventory web'), child('b', 'Desktop slice')],
  depth: { a1: 1, a2: 1 },
}

const session: Chat = {
  id: 'session', projectId: 'manor', kind: 'project', routineId: null, parentChatId: null, sideModel: null, sideEffort: null,
  memberIds: [], lastMessagePreview: null, title: 'Provider options', createdAt: 1, lastMessageAt: 1, settledAt: null,
  agentIds: ['jeeves'], archivedAt: null, checkout: CURRENT_CHECKOUT,
}

const renderInbox = (active: string | undefined) => {
  const workspace: WorkspaceState = {
    ...emptyWorkspace,
    hasDirectory: true,
    openChatId: 'session',
    projects: [{ id: 'manor', name: 'Manor', color: '#8b5cf6', icon: 'folder', memoryScope: 'project', repoPaths: [] } as Project],
    chats: [session],
  }
  return renderToStaticMarkup(
    <InboxView
      inbox={inbox(workspace)}
      agents={[{ id: 'jeeves', name: 'Jeeves', color: '#8b5cf6', allowedTools: [] } as unknown as AgentConfig]}
      hasDirectory
      showChatSelection
      armed={null}
      onArm={() => {}}
      onOpenChat={() => {}}
      onDeleteChat={() => {}}
      onSetSettled={() => true}
      onSetArchived={() => true}
      onHoldPeek={() => {}}
      subagentGroups={{ session: group }}
      onOpenSubagent={() => {}}
      activeSubagents={active === undefined ? {} : { session: active }}
    />,
  )
}

/** The accessible names of the rows marked current, in order. */
const current = (html: string) => [...html.matchAll(/aria-label="([^"]+)"[^>]*aria-current="page"/g)].map((match) => match[1])

afterEach(() => expandSubagentRows(['session', 'a', 'a1', 'a2', 'b']))

describe('the active sidebar row', () => {
  it('is the Session row while its own transcript is open', () => {
    expect(current(renderInbox(undefined))).toEqual(['Open Provider options'])
  })

  it('is only the opened nested subagent, not the Session or the parent subagent', () => {
    expect(current(renderInbox('a1'))).toEqual(['Inventory server, Claude Code, Running. Open'])
  })

  it('leaves the Session row unlit while an unlisted helper lies over it', () => {
    expect(current(renderInbox('gone'))).toEqual([])
  })

  it('rests on the fold that hides the opened row once the user folds it away again', () => {
    toggleSubagentRow('a')
    expect(current(renderInbox('a1'))).toEqual(['Settings slice, Claude Code, Running. Open'])
    toggleSubagentRow('session')
    expect(current(renderInbox('a1'))).toEqual(['Open Provider options'])
  })
})

describe('collapsing subagent rows', () => {
  const lines = subagentLines(group)

  it('counts what each row would hide', () => {
    expect(lines.map((line) => [line.child.id, line.descendants])).toEqual([['a', 2], ['a1', 0], ['a2', 0], ['b', 0]])
  })

  it('hides a collapsed row’s children and keeps the row itself', () => {
    expect(visibleSubagentLines(lines, new Set(['a'])).map((line) => line.child.id)).toEqual(['a', 'b'])
  })

  it('toggles from the chevron, with its count and label', () => {
    const open = renderToStaticMarkup(<SubagentChildRows group={group} rowKey="session" onOpen={() => {}} />)
    expect(open).toContain('aria-label="Collapse Settings slice"')
    expect(open).toContain('aria-expanded="true"')
    expect(open).toContain('Inventory server')
    toggleSubagentRow('a')
    const folded = renderToStaticMarkup(<SubagentChildRows group={group} rowKey="session" onOpen={() => {}} />)
    expect(folded).toContain('aria-label="Expand Settings slice"')
    expect(folded).toContain('aria-expanded="false"')
    expect(folded).toMatch(/aria-expanded="false"[^>]*><span[^>]*>2<\/span>/)
    expect(folded).not.toContain('Inventory server')
    expect(folded).toContain('Desktop slice')
    toggleSubagentRow('a')
    expect(renderToStaticMarkup(<SubagentChildRows group={group} rowKey="session" onOpen={() => {}} />)).toContain('Inventory server')
  })

  it('hides every child under a collapsed Session row', () => {
    toggleSubagentRow('session')
    expect(renderToStaticMarkup(<SubagentChildRows group={group} rowKey="session" onOpen={() => {}} />)).toBe('')
    expect(renderInbox(undefined)).toContain('aria-label="Expand Provider options"')
  })

  it('opens every fold above the active row, and nothing for a row elsewhere', () => {
    expect(rowsHidingActive('session', lines, 'a1')).toEqual(['session', 'a'])
    expect(rowsHidingActive('session', lines, 'b')).toEqual(['session'])
    expect(rowsHidingActive('session', lines, 'gone')).toEqual([])
    expect(litSubagentId('session', group, new Set(['a']), 'a1')).toBe('a')
    expect(litSubagentId('session', group, new Set(), 'a1')).toBe('a1')
    toggleSubagentRow('session')
    toggleSubagentRow('a')
    expandSubagentRows(rowsHidingActive('session', lines, 'a1'))
    expect(renderToStaticMarkup(<SubagentChildRows group={group} rowKey="session" onOpen={() => {}} />)).toContain('Inventory server')
  })
})
