import { CURRENT_CHECKOUT, type AgentConfig, type Chat } from '@manor/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Brain02Icon, BubbleChatIcon, Files01Icon } from '@hugeicons/core-free-icons'
import { ChatListView } from '../src/components/chats/ChatListView'
import { RightRail, doorsInRow } from '../src/components/RightRail'
import { chatList, emptyWorkspace } from '../src/state'

const agent = (id: string, name: string): AgentConfig =>
  ({ id, name, color: '#8b5cf6', allowedTools: [] }) as unknown as AgentConfig

const ROSTER = [agent('jeeves', 'Jeeves'), agent('sage', 'Sage')]

const dm = (id: string, memberId: string, title: string, at: number): Chat => ({
  id,
  projectId: null,
  kind: 'dm',
  routineId: null,
  parentChatId: null,
  sideModel: null,
  sideEffort: null,
  memberIds: [memberId],
  lastMessagePreview: 'Hoi',
  lastMessageAt: at,
  title,
  createdAt: at,
  settledAt: null,
  archivedAt: null,
  agentIds: [memberId],
  checkout: CURRENT_CHECKOUT,
})

const rowsFor = (openChatId: string | null) =>
  chatList({
    ...emptyWorkspace,
    agents: ROSTER,
    // Jeeves has no DM yet, so his row is the one a draft can light.
    chats: [dm('dm_sage', 'sage', 'Sage', 300)],
    openChatId,
  })

const render = (openChatId: string | null, draftAgentId: string | null = null) =>
  renderToStaticMarkup(
    <ChatListView
      rows={rowsFor(openChatId)}
      agents={ROSTER}
      hasDirectory
      showChatSelection={openChatId !== null}
      draftAgentId={draftAgentId}
      armed={null}
      onArm={() => {}}
      onOpenChat={() => {}}
      onOpenDm={() => {}}
      onEditAgent={() => {}}
      onEditGroup={() => {}}
      onDeleteChat={() => {}}
      onSetPins={() => {}}
    />,
  )

const markers = (html: string) => html.match(/pointer-events-none absolute inset-0 bg-user-bg/g)?.length ?? 0

describe('the sidebar selection marker', () => {
  it('gives the open chat one travelling fill instead of a static class', () => {
    const html = render('dm_sage')

    expect(markers(html)).toBe(1)
    // The fill is the marker's now, so no row paints it on itself.
    expect(html).not.toContain('rounded-xl bg-user-bg')
  })

  it('marks the persona an unsent DM is addressed to', () => {
    expect(markers(render(null, 'jeeves'))).toBe(1)
  })

  it('marks nothing while the stage is somewhere else entirely', () => {
    expect(markers(render(null))).toBe(0)
  })

  it('lights every open panel door and holds the rest shut at the cap', () => {
    const items = [
      { id: 'agents' as const, label: 'Agents', icon: BubbleChatIcon },
      { id: 'files' as const, label: 'Files', icon: Files01Icon },
      { id: 'side' as const, label: 'Side chat', icon: BubbleChatIcon },
      { id: 'browser' as const, label: 'Browser', icon: Files01Icon },
      { id: 'knowledge' as const, label: 'Knowledge', icon: Files01Icon },
    ]
    const two = renderToStaticMarkup(<RightRail items={items} layout={[['files'], ['agents']]} onSelect={() => {}} />)
    expect(two.match(/aria-expanded="true"/g)).toHaveLength(2)
    expect(two).not.toContain('aria-disabled')

    const four = renderToStaticMarkup(
      <RightRail items={items} layout={[['files', 'side'], ['browser'], ['agents']]} onSelect={() => {}} />,
    )
    expect(four.match(/aria-expanded="true"/g)).toHaveLength(4)
    expect(four.match(/aria-disabled="true"/g)).toHaveLength(1)
    expect(four).toContain('Knowledge, close a panel first')
  })

  it('renders project memory after the other panel doors', () => {
    const html = renderToStaticMarkup(
      <RightRail
        items={[
          { id: 'files', label: 'Files', icon: Files01Icon },
          { id: 'memory', label: 'Project memory', icon: Brain02Icon },
        ]}
        layout={[]}
        onSelect={() => {}}
      />,
    )

    expect(html.indexOf('Files')).toBeLessThan(html.indexOf('Project memory'))
  })
})

describe('doors in a narrow header', () => {
  it('keeps every door until one does not fit, then gives the More menu a slot', () => {
    expect(doorsInRow(6, null)).toBe(6)
    // Six doors are 202px with their gaps.
    expect(doorsInRow(6, 202)).toBe(6)
    expect(doorsInRow(6, 201)).toBe(4)
    expect(doorsInRow(4, 95)).toBe(1)
    expect(doorsInRow(4, 20)).toBe(0)
  })
})
