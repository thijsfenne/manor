import type { ComponentProps } from 'react'
import { type AgentConfig, type Chat, type Project, type Routine } from '@manor/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NavRail } from '../src/components/NavRail'
import { navigateSidebarRows, Sidebar } from '../src/components/Sidebar'
import { navDestinationOf, sidebarPanelOf } from '../src/navDestination'
import { landingChat, LEFT_ON_NEW_SESSION } from '../src/useSidebar'
import { chatList, emptyWorkspace, inbox } from '../src/state'
import { useWorkspaceNav } from '../src/useWorkspaceNav'
import { readReloadLocation, writeReloadLocation, type WorkspaceLocation } from '../src/useViewHistory'

const render = (
  panel: ComponentProps<typeof Sidebar>['panel'],
  extra: Partial<ComponentProps<typeof Sidebar>> = {},
) =>
  renderToStaticMarkup(
    <Sidebar
      chats={chatList(emptyWorkspace)}
      inbox={inbox(emptyWorkspace)}
      agents={[]}
      panel={panel}
      projectThreads={[]}
      threadlessProjects={[]}
      onCreateProjectThread={() => undefined}
      onNewProjectThread={() => undefined}
      onEditProject={() => undefined}
      onDeleteProject={() => undefined}
      onRemoveProjectThread={() => undefined}
      hasDirectory
      width={288}
      collapsed={false}
      peeking={false}
      resizing={false}
      motion="pin"
      overlay={false}
      resizeProps={{}}
      activeView="chat"
      canStartChat
      draftAgentId={null}
      notice={null}
      onEditAgent={() => {}}
      onSetAgentPins={() => {}}
      onNewAgent={() => {}}
      onManageAgents={() => {}}
      onStartChat={() => {}}
      onOpenSearch={() => {}}
      onOpenChat={() => {}}
      onOpenDm={() => {}}
      onNewGroup={() => {}}
      onEditGroup={() => {}}
      onDeleteChat={() => {}}
      onSetChatSettled={() => true}
      onSetChatArchived={() => true}
      onDismissNotice={() => {}}
      onToggle={() => {}}
      onHoldPeek={() => {}}
      {...extra}
    />,
  )

const renderRail = (extra: Partial<ComponentProps<typeof NavRail>> = {}) =>
  renderToStaticMarkup(
    <NavRail
      destination="chats"
      hasVault
      hasReminders
      hasArtifacts
      hasBrowser
      agentsAttention={null}
      routineAttention={false}
      sessionsAttention={null}
      pins={[]}
      stageAgentId={null}
      providerUsage={[]}
      usageActive={false}
      theme={{ choice: 'dark', set: () => {} }}
      profile={{ name: 'Sam Example', photo: './images/sam.webp' }}
      onSelect={() => {}}
      onOpenUsage={() => {}}
      onOpenSettings={() => {}}
      onOpenUsageSettings={() => {}}
      onOpenPin={() => {}}
      {...extra}
    />,
  )

describe('navigation rail', () => {
  it('lists the eight destinations in order, Agents first and Sessions apart', () => {
    const html = renderRail()
    const order = ['Agents', 'Sessions', 'Browser', 'Knowledge', 'Reminders', 'Artifacts', 'Scheduled tasks', 'Plugins']
      .map((label) => html.indexOf(`aria-label="${label}"`))
    expect(order.every((at) => at >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(html.split('aria-label="Agents"').length - 1).toBe(1)
  })

  it('marks exactly one door as the current place', () => {
    const html = renderRail({ destination: 'browser' })
    expect(html.match(/aria-current="page"/g)?.length).toBe(1)
    expect(html).toMatch(/aria-label="Browser" aria-current="page"/)
    expect(renderRail({ destination: null })).not.toContain('aria-current="page"')
  })

  it('puts pinned faces under Plugins, and a pinned DM on stage leaves the fill on Agents', () => {
    const jeeves = { id: 'jeeves', name: 'Jeeves', color: '#888888' } as AgentConfig
    const pins = [{ agent: jeeves, unread: true, running: false, waiting: false }]
    expect(renderRail().indexOf('aria-label="Jeeves')).toBe(-1)
    const html = renderRail({ pins, stageAgentId: 'jeeves' })
    expect(html.indexOf('aria-label="Jeeves, unread messages"')).toBeGreaterThan(html.indexOf('aria-label="Plugins"'))
    expect(html.match(/aria-current="page"/g)?.length).toBe(1)
    expect(html).toMatch(/aria-label="Agents" aria-current="page"/)
    // Her face wears the edge pill instead, and only while her DM is the one open.
    expect(html).toMatch(/aria-label="Jeeves, unread messages" aria-current="true"/)
    expect(html).toContain('rounded-r-full')
    expect(renderRail({ pins, stageAgentId: 'nova' })).not.toContain('rounded-r-full')
  })

  it('drops the doors whose host is missing', () => {
    const html = renderRail({ hasVault: false, hasReminders: false, hasArtifacts: false, hasBrowser: false })
    expect(html).not.toContain('aria-label="Knowledge"')
    expect(html).not.toContain('aria-label="Reminders"')
    expect(html).not.toContain('aria-label="Artifacts"')
    expect(html).not.toContain('aria-label="Browser"')
    expect(html).toContain('aria-label="Plugins"')
  })

  it('carries unread chats on the Agents door only while another place is open', () => {
    expect(renderRail({ destination: 'work', agentsAttention: 'unread' })).toContain('aria-label="Agents, unread messages"')
    expect(renderRail({ destination: 'chats', agentsAttention: 'unread' })).not.toContain('unread messages')
    expect(renderRail({ routineAttention: true })).toContain('aria-label="Scheduled tasks, a run is done"')
    expect(renderRail({ pluginsAttention: true })).toContain('aria-label="Plugins, Composio needs a key"')
    expect(renderRail({ destination: 'plugins', pluginsAttention: true })).not.toContain('Composio needs a key')
    expect(renderRail({ destination: 'chats', sessionsAttention: 'done' })).toContain('aria-label="Sessions, a session is done"')
    expect(renderRail({ destination: 'work', sessionsAttention: 'done' })).not.toContain('a session is done')
    expect(renderRail({ destination: 'chats', sessionsAttention: 'waiting' })).toContain('aria-label="Sessions, waiting for you"')
    expect(renderRail({ destination: 'work', agentsAttention: 'waiting' })).toContain('aria-label="Agents, waiting for you"')
    expect(renderRail({ destination: 'work', agentsAttention: 'waiting' })).toContain('bg-warn-fill')
  })

  it('keeps usage and the account face at the foot, with Settings and the theme behind the face', () => {
    const html = renderRail()
    expect(html).toContain('aria-label="Usage"')
    expect(html).toContain('aria-label="Sam Example, account"')
    expect(html).toContain('src="./images/sam.webp"')
    expect(html.indexOf('Sam Example, account')).toBeGreaterThan(html.indexOf('aria-label="Plugins"'))
    expect(html).not.toContain('aria-label="Settings"')
  })
})

describe('navigation destination', () => {
  it('puts the Browser page behind the Browser door, never behind the list it was left on', () => {
    expect(navDestinationOf('browser', 'dm', 'chats')).toBe('browser')
    expect(sidebarPanelOf('browser')).toBeNull()
  })

  it('follows the open thread to the list it lives in', () => {
    expect(navDestinationOf('chat', 'dm', 'chats')).toBe('chats')
    expect(navDestinationOf('chat', 'project', 'inbox')).toBe('work')
    expect(navDestinationOf('new-chat', null, 'inbox')).toBe('work')
    expect(navDestinationOf('chat', 'run', 'inbox')).toBe('routines')
  })

  it('lets a draft follow its own target, not the run it was started from', () => {
    expect(navDestinationOf('new-chat', 'project', 'chats')).toBe('work')
    expect(navDestinationOf('new-chat', 'dm', 'inbox')).toBe('chats')
    expect(navDestinationOf('new-chat', 'run', 'inbox')).toBe('work')
  })

  it('keeps every Plugins section behind one door and Usage behind none', () => {
    for (const view of ['skills', 'connectors', 'suggestions'] as const) {
      expect(navDestinationOf(view, null, 'inbox')).toBe('plugins')
    }
    expect(navDestinationOf('usage', null, 'chats')).toBeNull()
  })

  it('gives a sidebar only to the destinations with a list', () => {
    const listed = ['work', 'chats', 'knowledge'] as const
    expect(listed.map((d) => sidebarPanelOf(d))).toEqual([...listed])
    for (const d of ['artifacts', 'browser', 'plugins', 'routines'] as const) expect(sidebarPanelOf(d)).toBeNull()
    expect(sidebarPanelOf(null)).toBeNull()
  })
})

describe('sidebar navigation', () => {
  it('drops translate once the sidebar is folded away', () => {
    const html = render('chats', { collapsed: true })
    expect(html).toContain('!hidden')
    expect(html).not.toContain('-translate-x-full')
  })

  it('shows only the Agents list and its creation acts under Agents', () => {
    const html = render('chats')

    expect(html).toContain('>Agents</h2>')
    // The window's controls (fold, back, forward, search) live in the top bar, not in the list.
    expect(html).not.toContain('aria-label="Search"')
    expect(html).not.toContain('aria-label="Back"')
    expect(html).not.toContain('aria-label="Hide sidebar"')
    expect(html).toContain('aria-label="New group"')
    expect(html).toContain('aria-label="New agent"')
    expect(html).not.toContain('aria-label="New session"')
    for (const gone of ['Plugins', 'Knowledge', 'Artifacts', 'Browser', 'Usage']) {
      expect(html).not.toContain(`>${gone}<`)
    }
  })

  it('shows only the Work list under Work', () => {
    const html = render('work')

    expect(html).toContain('>Sessions</h2>')
    expect(html).toContain('aria-label="New session"')
    expect(html).not.toContain('aria-label="New group"')
    expect(html).not.toContain('aria-label="New agent"')
  })

  it('holds no list at all for a destination without one', () => {
    const html = render(null)
    expect(html).not.toContain('</h2>')
    expect(html).not.toContain('aria-label="New session"')
    expect(html).not.toContain('aria-label="New group"')
  })

  it('carries the rail and a way out in the phone drawer', () => {
    const html = render('work', { mobile: true, width: 390, overlay: true, rail: renderRailNode() })

    expect(html).toContain('aria-label="Close sidebar"')
    expect(html).toContain('aria-label="Search"')
    expect(html).toContain('aria-label="New session"')
    expect(html).toContain('aria-label="Destinations"')
    expect(html).toContain('aria-label="Usage"')
  })
})

function renderRailNode() {
  return (
    <NavRail
      destination="work"
      hasVault
      hasReminders={false}
      hasArtifacts
      hasBrowser={false}
      agentsAttention={null}
      routineAttention={false}
      sessionsAttention={null}
      pins={[]}
      stageAgentId={null}
      providerUsage={[]}
      usageActive={false}
      theme={{ choice: 'dark', set: () => {} }}
      profile={{ name: 'Sam Example', photo: './images/sam.webp' }}
      mobile
      onSelect={() => {}}
      onOpenUsage={() => {}}
      onOpenSettings={() => {}}
      onOpenUsageSettings={() => {}}
      onOpenPin={() => {}}
    />
  )
}

describe('landing chat', () => {
  const chats = [
    { id: 'project-a', kind: 'project' as const },
    { id: 'project-b', kind: 'project' as const },
    { id: 'dm-a', kind: 'dm' as const },
    { id: 'group-a', kind: 'group' as const },
  ]

  it('returns to the thread the list was left on', () => {
    expect(landingChat(chats, 'inbox', 'project-b')?.id).toBe('project-b')
    expect(landingChat(chats, 'chats', 'group-a')?.id).toBe('group-a')
  })

  it('never lands a list on a Browser session', () => {
    const withSession = [{ id: 'browser-a', kind: 'browser' as const }, ...chats]
    expect(landingChat(withSession, 'chats', 'browser-a')?.id).toBe('dm-a')
    expect(landingChat(withSession, 'chats', null)?.id).toBe('dm-a')
  })

  it('falls back to the first thread when nothing is remembered', () => {
    expect(landingChat(chats, 'inbox', null)?.id).toBe('project-a')
    expect(landingChat(chats, 'chats', null)?.id).toBe('dm-a')
  })

  it('falls back when the remembered thread is gone or belongs to the other list', () => {
    expect(landingChat(chats, 'inbox', 'deleted')?.id).toBe('project-a')
    expect(landingChat(chats, 'inbox', 'dm-a')?.id).toBe('project-a')
    expect(landingChat(chats, 'chats', 'project-b')?.id).toBe('dm-a')
  })

  it('lands Sessions on its draft when it was left on New session', () => {
    expect(landingChat(chats, 'inbox', LEFT_ON_NEW_SESSION)).toBeUndefined()
    expect(landingChat(chats, 'chats', LEFT_ON_NEW_SESSION)?.id).toBe('dm-a')
  })

  it('has no landing in a list with no threads', () => {
    expect(landingChat([{ id: 'dm-a', kind: 'dm' as const }], 'inbox', 'dm-a')).toBeUndefined()
  })

  it('does not land on a routine run, even when that is what the inbox last had open', () => {
    const withRun = [...chats, { id: 'run-a', kind: 'run' as const }]
    expect(landingChat(withRun, 'inbox', 'run-a')?.id).toBe('project-a')
    expect(landingChat([{ id: 'run-a', kind: 'run' as const }], 'inbox', 'run-a')).toBeUndefined()
  })
})

describe('workspace startup navigation', () => {
  type Input = Parameters<typeof useWorkspaceNav>[0]
  let view: ReactTestRenderer | undefined
  let input: Input
  let nav: ReturnType<typeof useWorkspaceNav>
  function Probe({ value }: { value: Input }) {
    nav = useWorkspaceNav(value)
    return null
  }
  beforeEach(() => {
    const storage = new Map<string, string>()
    vi.stubGlobal('window', {
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      sessionStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    })
    input = {
      projects: [],
      chats: [
        { id: 'project-a', kind: 'project' },
        { id: 'dm-a', kind: 'dm', memberIds: ['iris'] },
      ] as Chat[],
      agents: [{ id: 'iris' }] as AgentConfig[], routines: [],
      hasDirectory: false, hasRoster: false, hasVault: true, hasVaultStatus: true,
      hasArtifacts: true, hasArtifactsStatus: true, hasReminders: true, hasBrowser: true,
      hasRoutines: true, canStartChat: true, sidebarView: 'chats',
      showSidebarView: vi.fn(), openChatOnServer: vi.fn(), dismissNotice: vi.fn(),
      listSkillCandidates: vi.fn(), listWorkflowSuggestions: vi.fn(),
      listMyMindObjects: vi.fn(), setChatSettledOnServer: vi.fn(), createChat: vi.fn(),
      showRunPanel: vi.fn(), beginDraft: vi.fn(), clearDraft: vi.fn(),
      newChatProject: undefined, selected: null, selectedChat: null,
      unsettledInbox: [], draftTarget: undefined,
    }
  })
  afterEach(() => {
    if (view !== undefined) act(() => view?.unmount())
    view = undefined
    vi.unstubAllGlobals()
  })
  const renderInput = () => act(() => {
    if (view === undefined) view = create(<Probe value={input} />)
    else view.update(<Probe value={input} />)
  })

  it('keeps a split settle on an intentionally empty stage without opening a draft', () => {
    const settled = input.chats[0]!
    input = {
      ...input, sidebarView: 'inbox', selected: settled, selectedChat: settled,
      setChatSettledOnServer: vi.fn(() => true), onChatSettled: vi.fn(() => true),
    }
    renderInput()
    act(() => { expect(nav.setChatSettled(settled.id, true)).toBe(true) })
    input = { ...input, hasDirectory: true, hasRoster: true, selected: null, selectedChat: null }
    renderInput()
    expect(nav.activeView).toBe('empty-chat')
    expect(input.onChatSettled).toHaveBeenCalledWith(settled.id)
    expect(input.openChatOnServer).not.toHaveBeenCalled()
    expect(input.beginDraft).not.toHaveBeenCalled()
    act(() => nav.openChat(settled.id))
    expect(nav.activeView).toBe('chat')
    expect(input.openChatOnServer).toHaveBeenCalledWith(settled.id)
  })

  it('leaves the pane intact when settling is refused', () => {
    input = { ...input, setChatSettledOnServer: vi.fn(() => false), onChatSettled: vi.fn(() => true) }
    renderInput()
    act(() => { expect(nav.setChatSettled('project-a', true)).toBe(false) })
    expect(input.onChatSettled).not.toHaveBeenCalled()
    expect(nav.activeView).toBe('chat')
  })

  it('still advances the inbox when no split handles the settle', () => {
    const selected = { ...input.chats[0]!, archivedAt: null, settledAt: null, lastMessageAt: 2 }
    const next = { ...selected, id: 'project-b', kind: 'project' as const, lastMessageAt: 1 }
    input = {
      ...input, sidebarView: 'inbox', selected, selectedChat: selected,
      chats: [selected, next],
      unsettledInbox: inbox({ ...emptyWorkspace, chats: [selected, next] }).unsettled,
      setChatSettledOnServer: vi.fn(() => true), onChatSettled: vi.fn(() => false),
    }
    renderInput()
    act(() => { nav.setChatSettled(selected.id, true) })
    expect(input.openChatOnServer).toHaveBeenCalledWith(next.id)
    expect(input.beginDraft).not.toHaveBeenCalled()
  })

  it.each(['single', 'house'] as const)('opens newly accepted %s Work from a stale callback once its directory lands', (mode) => {
    renderInput()
    const openBeforeAccept = nav.openChat
    act(() => openBeforeAccept('new-work', true))
    expect(input.openChatOnServer).not.toHaveBeenCalled()
    expect(input.showSidebarView).not.toHaveBeenCalled()
    input = { ...input, chats: [...input.chats, { id: 'new-work', kind: 'project', mode } as Chat] }
    renderInput()
    expect(input.openChatOnServer).toHaveBeenCalledTimes(1)
    expect(input.openChatOnServer).toHaveBeenCalledWith('new-work')
    expect(input.showSidebarView).toHaveBeenCalledWith('inbox')
    expect(nav.activeView).toBe('chat')
    renderInput()
    expect(input.openChatOnServer).toHaveBeenCalledTimes(1)
  })

  it('opens an accepted Work even when its directory rendered before the old Accept callback resumes', () => {
    renderInput()
    const openBeforeAccept = nav.openChat
    input = { ...input, chats: [...input.chats, { id: 'new-work', kind: 'project' } as Chat] }
    renderInput()
    act(() => openBeforeAccept('new-work', true))
    expect(input.openChatOnServer).toHaveBeenCalledTimes(1)
    expect(input.openChatOnServer).toHaveBeenCalledWith('new-work')
  })


  it.each(['chats', 'inbox'] as const)('opens the visible %s list after directory and roster arrive', (sidebarView) => {
    input = { ...input, sidebarView, chats: sidebarView === 'inbox' ? [...input.chats].reverse() : input.chats }
    renderInput()
    input = { ...input, hasDirectory: true }
    renderInput()
    expect(input.openChatOnServer).not.toHaveBeenCalled()
    input = { ...input, hasRoster: true }
    renderInput()
    expect(input.openChatOnServer).toHaveBeenCalledTimes(1)
    expect(input.openChatOnServer).toHaveBeenCalledWith(sidebarView === 'chats' ? 'dm-a' : 'project-a')
    expect(input.showSidebarView).toHaveBeenCalledWith(sidebarView)
  })

  it('does not replace a draft opened before the directory arrives', () => {
    input = { ...input, draftTarget: { kind: 'dm', agentId: 'iris' } }
    renderInput()
    input = { ...input, hasDirectory: true, hasRoster: true }
    renderInput()
    expect(input.openChatOnServer).not.toHaveBeenCalled()
    expect(input.clearDraft).not.toHaveBeenCalled()
  })

  it('does not replace an existing or pending selection', () => {
    input = { ...input, hasDirectory: true, hasRoster: true, selectedChat: input.chats[0]! }
    renderInput()
    expect(input.openChatOnServer).not.toHaveBeenCalled()
  })

  it('opens an addressed draft when the visible chat list is empty', () => {
    input = { ...input, hasDirectory: true, hasRoster: true, chats: input.chats.slice(0, 1) }
    renderInput()
    expect(input.openChatOnServer).not.toHaveBeenCalled()
    expect(input.beginDraft).toHaveBeenCalledTimes(1)
    expect(input.beginDraft).toHaveBeenCalledWith({ kind: 'dm', agentId: 'iris' })
  })

  it('restores the exact chat after unmounting, even when another chat is first', () => {
    const chosen = { id: 'dm-second', kind: 'dm', memberIds: ['iris'] } as Chat
    input = { ...input, hasDirectory: true, hasRoster: true, chats: [...input.chats, chosen], selected: chosen, selectedChat: chosen }
    renderInput()
    expect(readReloadLocation()?.location).toEqual({ kind: 'chat', chatId: chosen.id })
    act(() => view?.unmount())
    view = undefined
    input = { ...input, selected: null, selectedChat: null }
    renderInput()
    expect(input.openChatOnServer).toHaveBeenCalledTimes(1)
    expect(input.openChatOnServer).toHaveBeenCalledWith(chosen.id)
  })

  it('restores a workspace page instead of selecting a chat', () => {
    renderInput()
    act(() => nav.openConnectors())
    expect(readReloadLocation()?.location).toEqual({ kind: 'connectors' })
    act(() => view?.unmount())
    view = undefined
    input = { ...input, hasDirectory: true, hasRoster: true }
    renderInput()
    expect(nav.activeView).toBe('connectors')
    expect(input.openChatOnServer).not.toHaveBeenCalled()
  })

  // Usage is not in this list: the view asks for its own report, for the window it shows.
  it.each([
    [{ kind: 'skills' }, 'listSkillCandidates'],
    [{ kind: 'artifacts' }, 'listMyMindObjects'],
  ] as const)('reloads data for restored %j', (location, request) => {
    writeReloadLocation({ location, sidebarView: 'inbox' })
    input = { ...input, hasDirectory: true, hasRoster: true }
    renderInput()
    expect(nav.activeView).toBe(location.kind)
    expect(input[request]).toHaveBeenCalledTimes(1)
    expect(input.openChatOnServer).not.toHaveBeenCalled()
  })

  it('restores Browser on the desktop and falls back without the host', () => {
    writeReloadLocation({ location: { kind: 'browser' }, sidebarView: 'inbox' })
    input = { ...input, hasDirectory: true, hasRoster: true }
    renderInput()
    expect(nav.activeView).toBe('browser')
    input = { ...input, hasBrowser: false }
    renderInput()
    expect(nav.activeView).not.toBe('browser')
  })

  it('waits for vault availability before restoring Knowledge', () => {
    writeReloadLocation({ location: { kind: 'knowledge' }, sidebarView: 'inbox' })
    input = { ...input, hasDirectory: true, hasRoster: true, hasVault: false, hasVaultStatus: false }
    renderInput()
    expect(input.openChatOnServer).not.toHaveBeenCalled()
    input = { ...input, hasVault: true, hasVaultStatus: true }
    renderInput()
    expect(nav.activeView).toBe('knowledge')
    expect(input.openChatOnServer).not.toHaveBeenCalled()
  })

  it('restores routine detail only once the routine directory is available', () => {
    writeReloadLocation({ location: { kind: 'routines', routineId: 'r1' }, sidebarView: 'inbox' })
    input = { ...input, hasDirectory: true, hasRoster: true, hasRoutines: false }
    renderInput()
    expect(input.openChatOnServer).not.toHaveBeenCalled()
    input = { ...input, hasRoutines: true, routines: [{ id: 'r1' } as Routine] }
    renderInput()
    expect(nav.activeView).toBe('routines')
    expect(nav.routineDetailId).toBe('r1')
  })

  it.each([
    { kind: 'chat', chatId: 'deleted' },
    { kind: 'new-chat', target: { kind: 'project', projectId: 'deleted' } },
    { kind: 'knowledge' },
  ] satisfies WorkspaceLocation[])('falls back safely for unavailable %j', (location) => {
    writeReloadLocation({ location, sidebarView: 'chats' })
    input = { ...input, hasDirectory: true, hasRoster: true, hasVault: false }
    renderInput()
    expect(input.openChatOnServer).toHaveBeenCalledTimes(1)
    expect(input.openChatOnServer).toHaveBeenCalledWith('dm-a')
  })

  it('does not override navigation made while waiting for the directory', () => {
    writeReloadLocation({ location: { kind: 'chat', chatId: 'project-a' }, sidebarView: 'inbox' })
    renderInput()
    act(() => nav.openConnectors())
    input = { ...input, hasDirectory: true, hasRoster: true }
    renderInput()
    expect(nav.activeView).toBe('connectors')
    expect(input.openChatOnServer).not.toHaveBeenCalled()
    expect(readReloadLocation()?.location).toEqual({ kind: 'connectors' })
  })

  it('keeps a Browser session out of the list it returns to', () => {
    const session = { id: 'browser-a', kind: 'browser' } as Chat
    const dm = input.chats[1]!
    input = { ...input, chats: [...input.chats, session], hasDirectory: true, hasRoster: true,
      sidebarView: 'inbox', selected: dm, selectedChat: dm }
    renderInput()
    input = { ...input, selected: session, selectedChat: session }
    renderInput()
    act(() => nav.switchSidebarView())
    expect(input.openChatOnServer).toHaveBeenLastCalledWith('dm-a')
  })

  it('returns Sessions to the New session stage it was left on, and to a thread opened from it', () => {
    const underDraft = input.chats[0]!
    const project = { id: 'house' } as Project
    const draft = { kind: 'project', projectId: 'house' } as const
    input = { ...input, hasDirectory: true, hasRoster: true, sidebarView: 'inbox', newChatProject: project,
      selected: underDraft, selectedChat: underDraft }
    renderInput()
    input = { ...input, draftTarget: draft }
    renderInput()
    act(() => nav.openPlugins())
    input = { ...input, draftTarget: undefined }
    renderInput()
    act(() => nav.showSidebarDestination('inbox'))
    expect(input.beginDraft).toHaveBeenLastCalledWith(draft)
    expect(input.openChatOnServer).not.toHaveBeenCalled()

    // The thread under the draft, clicked from Sessions, is where the list is left next.
    input = { ...input, draftTarget: draft }
    renderInput()
    act(() => nav.openChat(underDraft.id))
    input = { ...input, draftTarget: undefined }
    renderInput()
    act(() => nav.openPlugins())
    renderInput()
    act(() => nav.showSidebarDestination('inbox'))
    expect(input.openChatOnServer).toHaveBeenLastCalledWith(underDraft.id)
    expect(input.beginDraft).toHaveBeenCalledTimes(1)
  })

  it('keeps the New session landing when the chat under the draft refreshes offstage', () => {
    const underDraft = input.chats[0]!
    const draft = { kind: 'project', projectId: 'house' } as const
    input = { ...input, hasDirectory: true, hasRoster: true, sidebarView: 'inbox',
      newChatProject: { id: 'house' } as Project, selected: underDraft, selectedChat: underDraft }
    renderInput()
    input = { ...input, draftTarget: draft }
    renderInput()
    act(() => nav.openPlugins())
    input = { ...input, draftTarget: undefined }
    renderInput()
    const refreshed = { ...underDraft, title: 'Updated while offstage' }
    input = { ...input, chats: [refreshed, ...input.chats.slice(1)], selected: refreshed, selectedChat: refreshed }
    renderInput()
    act(() => nav.showSidebarDestination('inbox'))
    expect(input.openChatOnServer).not.toHaveBeenCalled()
    expect(input.beginDraft).toHaveBeenLastCalledWith(draft)
  })

  it('honors an explicit list switch while the directory is still empty', () => {
    writeReloadLocation({ location: { kind: 'connectors' }, sidebarView: 'chats' })
    const chats = input.chats
    input = { ...input, chats: [], agents: [] }
    renderInput()
    act(() => nav.switchSidebarView())
    expect(input.showSidebarView).toHaveBeenCalledWith('inbox')
    input = { ...input, sidebarView: 'inbox', chats, hasDirectory: true, hasRoster: true }
    renderInput()
    expect(nav.activeView).toBe('chat')
    expect(input.openChatOnServer).toHaveBeenCalledWith('project-a')
  })
})


describe('sidebar arrow navigation', () => {
  class Row {
    dataset: { sidebarSection: string }
    disabled = false
    hidden = false
    focus = vi.fn()
    scrollIntoView = vi.fn()
    click = vi.fn()
    constructor(section: string) { this.dataset = { sidebarSection: section } }
    closest(selector: string) {
      return selector.startsWith('button') ? this : this.hidden ? this : null
    }
  }
  beforeEach(() => vi.stubGlobal('Element', Row))
  afterEach(() => vi.unstubAllGlobals())

  function press(rows: Row[], target: unknown, key: string, modifiers = {}) {
    const event = {
      key, target, nativeEvent: {}, preventDefault: vi.fn(),
      currentTarget: { contains: (row: Row) => rows.includes(row), querySelectorAll: () => rows },
      ...modifiers,
    }
    navigateSidebarRows(event as unknown as Parameters<typeof navigateSidebarRows>[0])
    return event
  }

  it.each(['unsettled', 'settled', 'chats'])('opens and focuses adjacent %s rows without crossing sections', (section) => {
    const rows = [new Row(section), new Row(section), new Row('another-section')]
    press(rows, rows[0], 'ArrowDown')
    expect(rows[1]!.click).toHaveBeenCalledOnce()
    expect(rows[1]!.focus).toHaveBeenCalledWith({ preventScroll: true })
    expect(rows[1]!.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
    press(rows, rows[1], 'ArrowDown')
    expect(rows[2]!.click).not.toHaveBeenCalled()
    press(rows, rows[1], 'ArrowUp')
    expect(rows[0]!.click).toHaveBeenCalledOnce()
    press(rows, rows[0], 'ArrowUp')
    expect(rows[1]!.click).toHaveBeenCalledOnce()
  })

  it('crosses between unsettled and settled in both directions, keeping DMs separate', () => {
    const rows = [new Row('unsettled'), new Row('settled'), new Row('chats')]
    press(rows, rows[0], 'ArrowDown')
    expect(rows[1]!.click).toHaveBeenCalledOnce()
    press(rows, rows[1], 'ArrowUp')
    expect(rows[0]!.click).toHaveBeenCalledOnce()
    press(rows, rows[1], 'ArrowDown')
    expect(rows[2]!.click).not.toHaveBeenCalled()
    press(rows, rows[2], 'ArrowUp')
    expect(rows[1]!.click).toHaveBeenCalledOnce()
  })

  it('leaves inputs, other keys, modified arrows and handled events alone', () => {
    const rows = [new Row('chats'), new Row('chats')]
    expect(press(rows, {}, 'ArrowDown').preventDefault).not.toHaveBeenCalled()
    expect(press(rows, rows[0], 'Enter').preventDefault).not.toHaveBeenCalled()
    for (const modifier of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey', 'defaultPrevented']) {
      expect(press(rows, rows[0], 'ArrowDown', { [modifier]: true }).preventDefault).not.toHaveBeenCalled()
    }
    expect(rows[1]!.click).not.toHaveBeenCalled()
  })

  it('skips folded and disabled rows', () => {
    const rows = Array.from({ length: 4 }, () => new Row('settled'))
    rows[1]!.hidden = true
    rows[2]!.disabled = true
    press(rows, rows[0], 'ArrowDown')
    expect(rows[1]!.click).not.toHaveBeenCalled()
    expect(rows[2]!.click).not.toHaveBeenCalled()
    expect(rows[3]!.click).toHaveBeenCalledOnce()
  })
})
