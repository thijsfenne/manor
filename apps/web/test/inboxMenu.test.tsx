import { CURRENT_CHECKOUT, type AgentConfig, type Chat, type Project } from '@manor/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SplitDragContext } from '../src/components/SplitDrag'
import { InboxView, OPEN_RIGHT_LABEL, inboxRowMenu } from '../src/components/inbox/InboxView'
import { emptyWorkspace, inbox, type WorkspaceState } from '../src/state'

const agent = (id: string, name: string, color: string): AgentConfig =>
  ({ id, name, color, allowedTools: [] }) as unknown as AgentConfig

const project = (id: string, name: string): Project =>
  ({ id, name, color: '#8b5cf6', icon: 'folder', memoryScope: 'project', repoPaths: [] })

const chat = (partial: Partial<Chat> & Pick<Chat, 'id'>): Chat => ({
  projectId: 'manor',
  kind: 'project',
  routineId: null,
  parentChatId: null,
  sideModel: null,
  sideEffort: null,
  memberIds: [],
  lastMessagePreview: null,
  title: partial.id,
  createdAt: 1,
  lastMessageAt: 1,
  settledAt: null,
  agentIds: ['jeeves'],
  archivedAt: null,
  checkout: CURRENT_CHECKOUT,
  ...partial,
})

const render = (chats: Chat[], activity: WorkspaceState['activity'] = {}) => {
  const workspace: WorkspaceState = {
    ...emptyWorkspace,
    hasDirectory: true,
    projects: [project('manor', 'Manor')],
    chats,
    activity,
  }
  return renderToStaticMarkup(
    <InboxView
      inbox={inbox(workspace)}
      agents={[agent('jeeves', 'Jeeves', '#8b5cf6')]}
      hasDirectory
      showChatSelection
      armed={null}
      onArm={() => {}}
      onOpenChat={() => {}}
      onDeleteChat={() => {}}
      onSetSettled={() => true}
      onSetArchived={() => true}
      onHoldPeek={() => {}}
    />,
  )
}

describe('the inbox row menu', () => {
  it('keeps archive and delete off the row at rest', () => {
    const html = render([
      chat({ id: 'live', title: 'Open thread' }),
      chat({ id: 'done', title: 'Settled thread', settledAt: 2 }),
    ])

    expect(html).toContain('Open thread')
    expect(html).toContain('Settled thread')
    expect(html).toContain('Settle')
    expect(html).not.toContain('Actions for')
    expect(html).not.toContain('Archive Session')
    expect(html).not.toContain('Delete Session')
  })

  it('leads with the thread and renders compact status and action marks', () => {
    const live = chat({ id: 'live', title: 'Thread title' })
    const running = render([live], {
      live: { unread: false, runningTurns: ['turn_1'], runStartedAt: 1, sawStart: true, awaitingInput: [], answeredInput: [] },
    })
    const done = render([live], {
      live: { unread: true, runningTurns: [], runStartedAt: null, sawStart: false, awaitingInput: [], answeredInput: [] },
    })

    expect(running).toContain('text-[14px] text-inherit"><span class="min-w-0 flex-1 truncate">Thread title</span>')
    expect(running.indexOf('Thread title</span>')).toBeLessThan(running.indexOf('>Manor</span>'))
    expect(running).toContain('color-mix(in srgb, #8b5cf6 16%, transparent)')
    expect(running).toContain('aria-label="Working"')
    expect(running).toContain('motion-safe:animate-spin-calm')
    expect(running).toContain('grid size-4 place-items-center leading-none')
    expect(running.match(/block size-4 flex-none/g)).toHaveLength(2)
    expect(running).toContain('width="16" height="16"')
    expect(running).toContain('group-hover/chat-row:w-7')
    expect(running).toContain('style="width:20px;height:20px"')
    expect(running).toContain('flex-col gap-1 overflow-hidden')
    expect(running).not.toContain('>Working</span>')
    expect(done).toContain('aria-label="Done"')
    expect(done).toContain('size-1.5 rounded-full bg-ok')
    expect(done).not.toContain('>Done</span>')
    expect(running).toContain('aria-label="Settle Thread title"')
    expect(running).toContain('aria-label="Settle Thread title"')
    expect(running).not.toContain('Archive Thread title')
    expect(running).toContain('top-1/2 -right-1.5 flex h-11 w-7')
    expect(running).not.toContain('>Settle</button>')
  })

  it('sizes settled titles at 14px without changing archived titles', () => {
    const settled = render([chat({ id: 'done', title: 'Settled thread', settledAt: 2 })])
    const archived = render([
      chat({ id: 'old', title: 'Archived thread', settledAt: 2, archivedAt: Date.now() }),
    ])

    expect(settled).toContain('text-[14px]">Settled thread</span>')
    expect(settled).toContain('truncate text-[12px] font-medium">Settled</span>')
    expect(settled).toContain('flex-none text-[12px] tabular-nums">1</span>')
    expect(archived).toContain('text-[15px]">Archived thread</span>')
  })

  it('draws an archived row like a settled one, without faces or a project header', () => {
    const html = render([
      chat({ id: 'old', title: 'Archived thread', settledAt: 2, archivedAt: Date.now() }),
    ])

    expect(html).toContain('Archived thread')
    expect(html).toContain('tabular-nums')
    expect(html).not.toContain('--accent:')
    expect(html).not.toContain('Restore Session')
    expect(html).not.toContain('Unsettle')
    // The room lives on the hover card, not as a section above the row.
    expect(html.match(/>Manor</g)?.length ?? 0).toBe(0)
  })

  it('shows the provider instead of an assistant face for a single session', () => {
    const html = render([
      chat({
        id: 'single',
        mode: 'single',
        singleDriver: 'cursor',
        agentIds: ['__single__'],
      }),
    ])

    expect(html).toContain('data-provider-mark="cursor"')
    expect(html).toContain('width="16" height="16"')
    expect(html).not.toContain('--accent:')
  })

  it('hides the archive accordion when every archived thread has expired', () => {
    const html = render([
      chat({
        id: 'gone',
        title: 'Expired thread',
        settledAt: 2,
        archivedAt: Date.now() - 11 * 24 * 60 * 60 * 1000,
      }),
    ])

    expect(html).not.toContain('Archived')
    expect(html).not.toContain('Expired thread')
  })

  it('names the split action in English', () => {
    const items = inboxRowMenu('Settle', () => {}, () => {}, () => {}, () => {})
    expect(items[0]?.label).toBe(OPEN_RIGHT_LABEL)
    expect(OPEN_RIGHT_LABEL).toBe('Open right')
    expect(inboxRowMenu('Settle', () => {}, () => {}, () => {}).some((item) => item.label === OPEN_RIGHT_LABEL)).toBe(false)
  })

  it.each(['left', 'right'])('keeps both split fills static when %s is focused', (openChatId) => {
    const workspace: WorkspaceState = {
      ...emptyWorkspace,
      hasDirectory: true,
      openChatId,
      projects: [project('manor', 'Manor')],
      chats: [chat({ id: 'left', title: 'Left thread' }), chat({ id: 'right', title: 'Right thread' })],
    }
    const html = renderToStaticMarkup(
      <InboxView
        inbox={inbox(workspace)}
        agents={[agent('jeeves', 'Jeeves', '#8b5cf6')]}
        hasDirectory
        showChatSelection
        armed={null}
        onArm={() => {}}
        onOpenChat={() => {}}
        onOpenRight={() => {}}
        occupiedChatIds={new Set(['left', 'right'])}
        onDeleteChat={() => {}}
        onSetSettled={() => true}
        onSetArchived={() => true}
        onHoldPeek={() => {}}
      />,
    )
    expect(html.match(/aria-current="page"/g)?.length).toBe(2)
    expect(html.match(/bg-user-bg/g)).toHaveLength(2)
    expect(html).not.toContain('pointer-events-none absolute inset-0 bg-user-bg')
    expect(html).not.toContain('data-split-drag')
  })

  it('lets an unoccupied work row be dragged onto the stage', () => {
    const html = renderToStaticMarkup(
      <SplitDragContext.Provider value={() => {}}>
      <InboxView
        inbox={inbox({
          ...emptyWorkspace,
          projects: [project('manor', 'Manor')],
          chats: [chat({ id: 'spare', title: 'Spare thread' })],
        })}
        agents={[agent('jeeves', 'Jeeves', '#8b5cf6')]}
        hasDirectory
        showChatSelection
        armed={null}
        onArm={() => {}}
        onOpenChat={() => {}}
        onOpenRight={() => {}}
        occupiedChatIds={new Set()}
        onDeleteChat={() => {}}
        onSetSettled={() => true}
        onSetArchived={() => true}
        onHoldPeek={() => {}}
      />
      </SplitDragContext.Provider>,
    )
    expect(html).toContain('data-split-drag')
  })
})
