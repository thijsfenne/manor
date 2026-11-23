import { afterEach, describe, expect, it, vi } from 'vitest'
import { ARCHIVE_RETENTION_MS } from '@manor/contracts'
import { createMemoryStore } from '../src/stores/memoryStore.js'
import { sessionIdIn } from './helpers.js'

/** Every test starts from the seeded project + chat, the same shape as the database. */
async function seeded() {
  const store = createMemoryStore()
  const [project] = await store.listProjects()
  const [chat] = await store.listChats()
  if (project === undefined || chat === undefined) throw new Error('the memory store should seed a project and a chat')
  return { store, project, chat }
}

describe('memoryStore', () => {
  afterEach(() => void vi.useRealTimers())

  it('files a browser session in no project, single or house, without members', async () => {
    const { store, project } = await seeded()
    await expect(store.createChat({ kind: 'browser', mode: 'single' })).resolves.toMatchObject({ projectId: null, mode: 'single' })
    await expect(store.createChat({ kind: 'browser', projectId: project.id })).rejects.toThrow('a browser chat belongs to no project')
    await expect(store.createChat({ kind: 'browser', memberIds: ['sage'] })).rejects.toThrow('takes no members')
  })

  it('lists chats most recently active first, and an old chat picked up again leads', async () => {
    // The clock is driven, because the ordering this asserts is millisecond-fine and
    // two chats created in the same tick would tie.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-07T09:00:00Z'))
    const { store, project, chat } = await seeded()
    vi.setSystemTime(new Date('2026-08-07T10:00:00Z'))
    const newer = await store.createChat({ projectId: project.id, title: 'Second' })

    expect((await store.listChats()).map((entry) => entry.id)).toEqual([newer.id, chat.id])

    vi.setSystemTime(new Date('2026-08-07T11:00:00Z'))
    await store.appendEvent(chat.id, { type: 'user_message', text: 'and one more thing', mentions: [] })

    const listed = await store.listChats()
    expect(listed.map((entry) => entry.id)).toEqual([chat.id, newer.id])
    expect(listed[0]?.createdAt).toBe(new Date('2026-08-07T09:00:00Z').getTime())
    expect(listed[0]?.lastMessageAt).toBe(new Date('2026-08-07T11:00:00Z').getTime())
  })

  // What the sidebar's avatar stack is built from. Derived from the transcript in
  // both stores — `chat_participants` groups the same thing in SQL — because a chat
  // has personas in it whether or not their driver ever handed back a session.
  it('names the personas that have worked in a chat, most recent first, once each', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-10T09:00:00Z'))
    const { store, project, chat } = await seeded()
    const quiet = await store.createChat({ projectId: project.id, title: 'Nobody has answered here' })

    await store.appendEvent(chat.id, { type: 'user_message', text: 'both of you', mentions: ['sage', 'smith'] })
    await store.appendEvent(chat.id, { type: 'agent_message', agentId: 'sage', turnId: 't1', text: 'On it.' })
    vi.setSystemTime(new Date('2026-08-10T09:05:00Z'))
    await store.appendEvent(chat.id, { type: 'tool_use', agentId: 'smith', turnId: 't2', toolCallId: 'c1', tool: 'Bash' })
    vi.setSystemTime(new Date('2026-08-10T09:10:00Z'))
    await store.appendEvent(chat.id, { type: 'turn_result', agentId: 'sage', turnId: 't1' })

    const chats = new Map((await store.listChats()).map((entry) => [entry.id, entry]))
    // Sage spoke first and last, so she leads; the user's own message names nobody.
    expect(chats.get(chat.id)?.agentIds).toEqual(['sage', 'smith'])
    expect(chats.get(quiet.id)?.agentIds).toEqual([])
  })

  it('seeds one project with one chat and the roster', async () => {
    const { store, project, chat } = await seeded()

    expect(chat.projectId).toBe(project.id)
    expect((await store.loadRoster()).map((agent) => agent.id)).toEqual(['marlow', 'sage', 'smith'])
    // Exactly one chief of staff: routing picks the single isCos entry.
    expect((await store.loadRoster()).filter((agent) => agent.isCos).map((agent) => agent.id)).toEqual(['marlow'])
    expect(await store.loadEvents(chat.id)).toEqual([])
  })

  it('renames an existing chat and refuses to rename a missing one', async () => {
    const { store, chat } = await seeded()

    await store.setChatTitle(chat.id, 'Sidebar redesign')

    expect((await store.listChats()).find((candidate) => candidate.id === chat.id)?.title).toBe('Sidebar redesign')
    await expect(store.setChatTitle('missing', 'Ghost')).rejects.toThrow(/unknown chat/)
  })

  it('stamps ids in order per chat and keeps chats apart', async () => {
    const { store, project, chat } = await seeded()
    const other = await store.createChat({ projectId: project.id, title: 'Second' })

    const first = await store.appendEvent(chat.id, { type: 'user_message', text: 'hello', mentions: ['sage'] })
    const second = await store.appendEvent(chat.id, {
      type: 'agent_message',
      agentId: 'sage',
      turnId: 'turn_1',
      text: 'hi',
    })
    const elsewhere = await store.appendEvent(other.id, { type: 'user_message', text: 'other', mentions: [] })

    expect([first.id, second.id]).toEqual(['evt_000001', 'evt_000002'])
    expect(first.ts).toBeGreaterThan(0)
    // Ids are per chat, so the second chat starts at one again.
    expect(elsewhere.id).toBe('evt_000001')
    expect((await store.loadEvents(chat.id)).map((event) => event.id)).toEqual([first.id, second.id])
    expect(await store.loadEvents(other.id)).toHaveLength(1)
  })

  it('refuses to append to a chat that no longer exists, the way the foreign key does', async () => {
    const { store, chat } = await seeded()
    await store.deleteChat(chat.id)

    await expect(store.appendEvent(chat.id, { type: 'user_message', text: 'ghost', mentions: [] })).rejects.toThrow(
      /unknown chat/,
    )
  })

  it('archives a chat without dropping its transcript, then restores it', async () => {
    const { store, chat } = await seeded()
    await store.appendEvent(chat.id, { type: 'user_message', text: 'kept', mentions: [] })

    await store.setChatArchived(chat.id, true)
    expect((await store.getChat(chat.id))?.archivedAt).toBeTypeOf('number')
    expect(await store.loadEvents(chat.id)).toHaveLength(1)

    await store.setChatArchived(chat.id, false)
    expect((await store.getChat(chat.id))?.archivedAt).toBeNull()
    expect(await store.loadEvents(chat.id)).toHaveLength(1)
  })

  it('hard-deletes only expired project archives and cascades through their side chats', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-01T09:00:00Z'))
    const { store, project, chat } = await seeded()
    const side = await store.sideChatFor(chat.id)
    await store.appendEvent(chat.id, { type: 'user_message', text: 'old', mentions: [] })
    await store.setSession(chat.id, 'sage', 'session-old')
    await store.setChatArchived(chat.id, true)

    // Bad historical data must not let this sweep erase a house-wide conversation.
    const dm = await store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })
    await store.setChatArchived(dm.id, true)
    const restored = await store.createChat({ projectId: project.id, title: 'Restored in time' })
    await store.setChatArchived(restored.id, true)
    await store.setChatArchived(restored.id, false)

    vi.setSystemTime(new Date('2026-08-02T09:00:00Z'))
    const recent = await store.createChat({ projectId: project.id, title: 'Still restorable' })
    await store.setChatArchived(recent.id, true)

    const cutoff = new Date('2026-08-01T09:00:00Z').getTime()
    expect(await store.deleteExpiredArchivedChats(cutoff)).toEqual([chat.id, side.id])
    expect(await store.getChat(chat.id)).toBeUndefined()
    expect(await store.getChat(side.id)).toBeUndefined()
    expect(await store.loadEvents(chat.id)).toEqual([])
    expect(await sessionIdIn(store, chat.id, 'sage')).toBeUndefined()
    expect(await store.getChat(dm.id)).toBeDefined()
    expect(await store.getChat(restored.id)).toBeDefined()
    expect(await store.getChat(recent.id)).toBeDefined()
    expect(ARCHIVE_RETENTION_MS).toBe(10 * 24 * 60 * 60 * 1000)
  })

  it('cascades a project delete through its chats, events and sessions', async () => {
    const { store, project, chat } = await seeded()
    const keeper = await store.createProject('Keeper')
    const keeperChat = await store.createChat({ projectId: keeper.id, title: 'Kept' })
    await store.appendEvent(chat.id, { type: 'user_message', text: 'doomed', mentions: [] })
    await store.setSession(chat.id, 'sage', 'session-a')
    await store.setSession(keeperChat.id, 'sage', 'session-b')
    const routine = await store.saveRoutine({
      projectId: project.id,
      chatId: null,
      agentId: 'sage',
      name: 'Doomed routine',
      prompt: 'Sweep',
      cron: '0 7 * * *',
      timezone: 'Europe/Amsterdam',
      enabled: true,
      notify: false,
      model: null,
      effort: null,
    })
    const run = await store.createChat({ projectId: project.id, kind: 'run', routineId: routine.id, title: 'Doomed run' })

    await store.deleteProject(project.id)

    expect((await store.listProjects()).map((entry) => entry.id)).toEqual([keeper.id])
    expect((await store.listChats()).map((entry) => entry.id)).toEqual([keeperChat.id])
    expect(await store.loadEvents(chat.id)).toEqual([])
    expect(await sessionIdIn(store, chat.id, 'sage')).toBeUndefined()
    expect(await sessionIdIn(store, keeperChat.id, 'sage')).toBe('session-b')
    expect(await store.listRoutines()).toEqual([])
    expect(await store.getChat(run.id)).toBeUndefined()
  })

  it('links folders to a project and unlinks them', async () => {
    const { store, project } = await seeded()
    const other = await store.createProject('Elsewhere')

    expect(await store.getProject(project.id)).toEqual(project)

    await store.updateProject(project.id, project.name, ['/repos/manor', '/home/sam/notes'])

    expect((await store.listProjects()).find((entry) => entry.id === project.id)?.repoPaths).toEqual([
      '/repos/manor',
      '/home/sam/notes',
    ])
    expect(await store.getProject(project.id)).toEqual({
      id: project.id,
      name: project.name,
      icon: project.icon,
      color: project.color,
      memoryScope: 'project',
      repoPaths: ['/repos/manor', '/home/sam/notes'],
    })
    // One project's folders are nobody else's.
    expect((await store.listProjects()).find((entry) => entry.id === other.id)).toEqual(other)

    await store.updateProject(project.id, project.name, [])

    // Unlinked means an empty list, the same shape a project born without one has.
    expect((await store.listProjects()).find((entry) => entry.id === project.id)).toEqual({
      id: project.id,
      name: project.name,
      icon: project.icon,
      color: project.color,
      memoryScope: 'project',
      repoPaths: [],
    })
  })

  it('renames a project without touching its folders', async () => {
    const { store, project } = await seeded()
    await store.updateProject(project.id, project.name, ['/repos/manor'])

    await store.updateProject(project.id, 'Knowledge work', ['/repos/manor'])

    expect((await store.listProjects()).find((entry) => entry.id === project.id)).toEqual({
      id: project.id,
      name: 'Knowledge work',
      icon: project.icon,
      color: project.color,
      memoryScope: 'project',
      repoPaths: ['/repos/manor'],
    })
  })

  it('creates a project with folders already attached, and one without', async () => {
    const { store } = await seeded()

    const linked = await store.createProject('Linked', ['/repos/manor', '/home/sam/notes'])
    const bare = await store.createProject('Bare')

    expect(linked.repoPaths).toEqual(['/repos/manor', '/home/sam/notes'])
    expect((await store.listProjects()).find((entry) => entry.id === linked.id)).toEqual(linked)
    // Created without folders means an empty list, the shape unlinking leaves behind.
    expect(bare).toEqual({
      id: bare.id,
      name: 'Bare',
      icon: 'folder',
      color: '#8A8F98',
      memoryScope: 'project',
      repoPaths: [],
    })
  })

  it('stores a project icon and colour without disturbing its folders', async () => {
    const { store, project } = await seeded()
    await store.updateProject(project.id, project.name, ['/repos/manor'], 'rocket', '#7AA2F7')

    expect((await store.listProjects()).find((entry) => entry.id === project.id)).toEqual({
      id: project.id,
      name: project.name,
      icon: 'rocket',
      color: '#7AA2F7',
      memoryScope: 'project',
      repoPaths: ['/repos/manor'],
    })
  })

  it('keeps letters until a repo icon or the glyph replaces them, never both at once', async () => {
    const { store, project } = await seeded()
    const icon = { folder: '/repos/manor', path: 'favicon.ico' }
    await store.updateProject(project.id, project.name, ['/repos/manor'], 'rocket', undefined, undefined, icon)
    await store.updateProject(project.id, project.name, ['/repos/manor'], 'rocket', undefined, undefined, 'letters')
    const lettered = await store.getProject(project.id)
    expect(lettered).toMatchObject({ letters: true, icon: 'rocket' })
    expect(lettered?.repoIcon).toBeUndefined()

    await store.updateProject(project.id, 'Renamed', ['/repos/manor'])
    expect((await store.getProject(project.id))?.letters).toBe(true)
    await store.updateProject(project.id, 'Renamed', ['/repos/manor'], 'rocket', undefined, undefined, icon)
    expect(await store.getProject(project.id)).toMatchObject({ repoIcon: icon })
    expect((await store.getProject(project.id))?.letters).toBeUndefined()
  })

  it('keeps a project and its folders when its chat is deleted', async () => {
    const { store, project, chat } = await seeded()
    await store.updateProject(project.id, project.name, ['/repos/manor'])

    await store.deleteChat(chat.id)

    expect(await store.getChat(chat.id)).toBeUndefined()
    // The project outlives its chat, folders and all.
    expect((await store.listProjects()).at(0)?.repoPaths).toEqual(['/repos/manor'])
  })

  it('inserts a persona with a derived id and updates one in place', async () => {
    const { store } = await seeded()
    const nova = { name: 'Nova', color: '#111111', character: 'You are Nova.', driver: 'mock' as const, effort: 'high' as const }
    const shape = { allowedTools: [], mcpServers: [], memoryScope: false, description: '', role: '', isCos: false }

    const created = await store.saveAgent({ ...nova, ...shape })

    expect(created.id).toBe('nova')
    // Absent optionals stay absent, the way the null columns read.
    expect('model' in created).toBe(false)
    expect('avatar' in created).toBe(false)
    expect('avatarShape' in created).toBe(false)

    const updated = await store.saveAgent({ ...nova, ...shape, id: 'nova', name: 'Nova the Second', model: 'opus' })

    expect(updated).toMatchObject({ id: 'nova', name: 'Nova the Second', model: 'opus' })
    expect((await store.loadRoster()).map((agent) => agent.id)).toEqual(['marlow', 'sage', 'smith', 'nova'])
  })

  it('keeps chosen avatar settings and the pin, and drops them when the next save omits them', async () => {
    const { store } = await seeded()
    const nova = { name: 'Nova', color: '#111111', character: 'You are Nova.', driver: 'mock' as const, effort: 'high' as const }
    const fields = { allowedTools: [], mcpServers: [], memoryScope: false, description: '', role: '', isCos: false }

    const created = await store.saveAgent({ ...nova, ...fields, avatarShape: 'sun', avatarTone: 0.9, pinned: true, railPinned: true })
    expect(created.pinned).toBe(true)
    expect(created.railPinned).toBe(true)
    expect(created.avatarShape).toBe('sun')
    expect(created.avatarTone).toBe(0.9)

    const cleared = await store.saveAgent({ ...nova, ...fields, id: 'nova' })
    expect('avatarShape' in cleared).toBe(false)
    const reloaded = (await store.loadRoster()).find((agent) => agent.id === 'nova')
    expect(reloaded).toBeDefined()
    expect('avatarShape' in (reloaded ?? {})).toBe(false)
    expect('avatarTone' in (reloaded ?? {})).toBe(false)
    expect('pinned' in (reloaded ?? {})).toBe(false)
    expect('railPinned' in (reloaded ?? {})).toBe(false)
  })

  it('refuses to update a persona that is not there, the way "no row matched" does', async () => {
    const { store } = await seeded()

    await expect(
      store.saveAgent({
        id: 'ghost',
        name: 'Ghost',
        color: '#111111',
        character: 'boo',
        driver: 'mock',
        effort: 'high',
        mcpServers: [],
        memoryScope: false,
        role: '',
        description: '',
        isCos: false,
      }),
    ).rejects.toThrow(/unknown agent/)
  })

  it('keeps at most one chief of staff, whoever was flagged before', async () => {
    const { store } = await seeded()
    const marlow = (await store.loadRoster()).find((agent) => agent.id === 'marlow')
    if (marlow === undefined) throw new Error('the seed roster should hold Marlow')

    await store.saveAgent({ ...marlow, id: 'sage', name: 'Sage', isCos: true })

    const roster = await store.loadRoster()
    expect(roster.filter((agent) => agent.isCos).map((agent) => agent.id)).toEqual(['sage'])
    expect(roster.map((agent) => agent.id)).toEqual(['marlow', 'sage', 'smith'])
  })

  it('takes a deleted persona\'s CLI sessions with it, the way the cascade does', async () => {
    const { store, project, chat } = await seeded()
    const other = await store.createChat({ projectId: project.id, title: 'Second' })
    await store.setSession(chat.id, 'sage', 'session-a')
    await store.setSession(chat.id, 'sage', 'session-a-codex', { driver: 'codex' })
    await store.setSession(other.id, 'sage', 'session-b')
    await store.setSession(chat.id, 'smith', 'session-c')

    await store.deleteAgent('sage')

    expect((await store.loadRoster()).map((agent) => agent.id)).toEqual(['marlow', 'smith'])
    expect(await store.getSessions(chat.id, 'sage')).toEqual([])
    expect(await sessionIdIn(store, other.id, 'sage')).toBeUndefined()
    // Somebody else's session in the same chat is none of this delete's business.
    expect(await sessionIdIn(store, chat.id, 'smith')).toBe('session-c')
  })

  it('scopes session ids per chat and per agent', async () => {
    const { store, project, chat } = await seeded()
    const other = await store.createChat({ projectId: project.id, title: 'Second' })

    await store.setSession(chat.id, 'sage', 'one')
    await store.setSession(other.id, 'sage', 'two')
    await store.setSession(chat.id, 'smith', 'three')

    expect(await sessionIdIn(store, chat.id, 'sage')).toBe('one')
    expect(await sessionIdIn(store, other.id, 'sage')).toBe('two')

    await store.clearSession(chat.id, 'sage')

    expect(await sessionIdIn(store, chat.id, 'sage')).toBeUndefined()
    expect(await sessionIdIn(store, chat.id, 'smith')).toBe('three')
    expect(await sessionIdIn(store, other.id, 'sage')).toBe('two')
  })

  it('keeps one session per provider and clears one provider or all of them', async () => {
    const { store, chat } = await seeded()
    await store.setSession(chat.id, 'sage', 'on-claude', { driver: 'claude' })
    await store.setSession(chat.id, 'sage', 'on-codex', { driver: 'codex' })
    await store.setSession(chat.id, 'sage', 'on-claude-again', { driver: 'claude' })

    // A write replaces only the session of the provider that minted it.
    expect((await store.getSessions(chat.id, 'sage')).map((held) => [held.driver, held.sessionId]))
      .toEqual([['claude', 'on-claude-again'], ['codex', 'on-codex']])

    // A dead or rolled-over session names its provider; the others stay resumable.
    await store.clearSession(chat.id, 'sage', 'claude')
    expect((await store.getSessions(chat.id, 'sage')).map((held) => held.sessionId)).toEqual(['on-codex'])

    // Without a provider, everything the pair holds goes, as stale folders require.
    await store.setSession(chat.id, 'sage', 'on-claude', { driver: 'claude' })
    await store.clearSession(chat.id, 'sage')
    expect(await store.getSessions(chat.id, 'sage')).toEqual([])

    await store.setSession(chat.id, 'sage', 'on-claude', { driver: 'claude' })
    await store.setSession(chat.id, 'sage', 'on-codex', { driver: 'codex' })
    await store.clearSessions([chat.id])
    expect(await store.getSessions(chat.id, 'sage')).toEqual([])
  })

  // Home-scope chats. Every rule below has a matching check constraint in
  // `20260811210454_chats_dm_and_groups.sql`; they live here as well because the
  // memory store is what `MANOR_STORE=memory` and every test runs against, and a
  // laxer double is how a contract bug reaches production unseen.
  it('makes a DM with one member and a group with two, both outside any project', async () => {
    const { store } = await seeded()

    const dm = await store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })
    const group = await store.createChat({ kind: 'group', memberIds: ['sage', 'smith'] })

    expect([dm.projectId, dm.kind, dm.memberIds, dm.title]).toEqual([null, 'dm', ['sage'], 'Sage'])
    expect([group.projectId, group.kind, group.memberIds]).toEqual([null, 'group', ['sage', 'smith']])
  })

  it('answers a second DM request with the chat that already exists', async () => {
    // The sidebar creates a DM lazily on first send, so asking twice is the normal
    // path and not an error: the database's partial unique index says the same.
    const { store } = await seeded()

    const first = await store.createChat({ kind: 'dm', memberIds: ['sage'] })
    const again = await store.createChat({ kind: 'dm', memberIds: ['sage'] })
    const other = await store.createChat({ kind: 'dm', memberIds: ['smith'] })

    expect(again.id).toBe(first.id)
    expect(other.id).not.toBe(first.id)
    expect((await store.listChats()).filter((chat) => chat.kind === 'dm')).toHaveLength(2)
  })

  it('keeps one standing chat per unordered agent pair and deletes it with either persona', async () => {
    const { store } = await seeded()

    const first = await store.pairChatFor('smith', 'sage')
    const reverse = await store.pairChatFor('sage', 'smith')

    expect(reverse.id).toBe(first.id)
    expect(first).toMatchObject({ kind: 'pair', projectId: null, memberIds: ['sage', 'smith'] })
    expect((await store.listChats()).filter((chat) => chat.kind === 'pair')).toHaveLength(1)

    await store.deleteAgent('sage')
    expect(await store.getChat(first.id)).toBeUndefined()
  })

  // One case per guard, so removing any single rule fails exactly one of these.
  it('refuses every chat shape the database would refuse', async () => {
    const { store, project } = await seeded()

    await expect(store.createChat({})).rejects.toThrow('a project chat needs a project')
    await expect(store.createChat({ projectId: project.id, memberIds: ['sage'] })).rejects.toThrow(
      'takes no members',
    )
    await expect(store.createChat({ kind: 'dm', projectId: project.id, memberIds: ['sage'] })).rejects.toThrow(
      'a dm chat belongs to no project',
    )
    await expect(store.createChat({ kind: 'dm', memberIds: [] })).rejects.toThrow('exactly one member')
    await expect(store.createChat({ kind: 'dm', memberIds: ['sage', 'smith'] })).rejects.toThrow('exactly one member')
    await expect(store.createChat({ kind: 'group', projectId: project.id, memberIds: ['sage', 'smith'] })).rejects.toThrow(
      'a group chat belongs to no project',
    )
    await expect(store.createChat({ kind: 'group', memberIds: ['sage'] })).rejects.toThrow('at least two members')
    // Duplicates are a slip, not an instruction, so they are dropped — and dropping
    // them is what makes this a one-member group rather than a two-member one.
    await expect(store.createChat({ kind: 'group', memberIds: ['sage', 'sage'] })).rejects.toThrow(
      'at least two members',
    )
    await expect(store.createChat({ kind: 'pair', memberIds: ['sage'] })).rejects.toThrow('exactly two distinct members')
    await expect(store.createChat({ kind: 'pair', memberIds: ['sage', 'sage'] })).rejects.toThrow('exactly two distinct members')
    await expect(store.createChat({ kind: 'pair', projectId: project.id, memberIds: ['sage', 'smith'] })).rejects.toThrow(
      'a pair chat belongs to no project',
    )
  })

  it('edits a group\'s membership and refuses to edit anything else\'s', async () => {
    const { store, chat } = await seeded()
    const group = await store.createChat({ kind: 'group', memberIds: ['sage', 'smith'] })
    const dm = await store.createChat({ kind: 'dm', memberIds: ['sage'] })

    await store.setChatMembers(group.id, ['sage', 'marlow', 'marlow'])
    expect((await store.getChat(group.id))?.memberIds).toEqual(['sage', 'marlow'])

    await expect(store.setChatMembers(group.id, ['sage'])).rejects.toThrow('at least two members')
    await expect(store.setChatMembers(dm.id, ['sage', 'smith'])).rejects.toThrow('only a group chat')
    await expect(store.setChatMembers(chat.id, ['sage', 'smith'])).rejects.toThrow('only a group chat')
    await expect(store.setChatMembers('chat_nope', ['sage', 'smith'])).rejects.toThrow('unknown chat')
  })

  it('shows a group its invited members as avatars before anyone has spoken', async () => {
    // Invited beats spoken: a group made a second ago already has its avatar stack,
    // where a project chat has to wait for the transcript to fill in.
    const { store } = await seeded()
    const group = await store.createChat({ kind: 'group', memberIds: ['sage', 'smith'] })

    await store.appendEvent(group.id, { type: 'agent_message', agentId: 'sage', turnId: 't1', text: 'Hello.' })

    expect((await store.listChats()).find((chat) => chat.id === group.id)?.agentIds).toEqual(['sage', 'smith'])
  })

  it('previews the last thing said, on one line and cut short', async () => {
    const { store, chat } = await seeded()
    const quiet = await store.createChat({ projectId: chat.projectId ?? '', title: 'Nothing said here' })

    await store.appendEvent(chat.id, { type: 'user_message', text: 'first\n\nquestion', mentions: [] })
    await store.appendEvent(chat.id, {
      type: 'agent_message',
      agentId: 'sage',
      turnId: 't1',
      text: `  a reply that runs on ${'and on '.repeat(40)}`,
    })
    // Neither of these is what the chat is about, so neither may become its preview.
    await store.appendEvent(chat.id, { type: 'system_note', kind: 'info', text: 'a note nobody said' })
    await store.appendEvent(chat.id, { type: 'tool_use', agentId: 'sage', turnId: 't1', toolCallId: 'c1', tool: 'Bash' })

    const listed = new Map((await store.listChats()).map((entry) => [entry.id, entry]))
    const preview = listed.get(chat.id)?.lastMessagePreview ?? ''
    expect(preview.startsWith('a reply that runs on and on')).toBe(true)
    expect(preview).toHaveLength(120)
    expect(preview).not.toContain('\n')
    expect(listed.get(quiet.id)?.lastMessagePreview).toBeNull()
  })

  it('replaces a stored event in place without adding a row', async () => {
    const { store, chat } = await seeded()
    const note = await store.appendEvent(chat.id, { type: 'system_note', kind: 'info', text: 'Compacting the live session…' })
    if (note.type !== 'system_note') throw new Error('expected a system note')
    await store.replaceEvent(chat.id, { ...note, text: 'Compacted the live session.' })
    expect(await store.loadEvents(chat.id)).toEqual([
      { ...note, text: 'Compacted the live session.' },
    ])
    await expect(store.replaceEvent(chat.id, { ...note, id: 'evt_999999' })).rejects.toThrow('unknown event')
  })

  it('gives a chat whose only message is blank no preview at all', async () => {
    // "Nothing said yet" and "said something blank" look identical in a sidebar, and
    // only one of them deserves a line of its own.
    const { store, chat } = await seeded()
    await store.appendEvent(chat.id, { type: 'user_message', text: '   \n  ', mentions: [] })

    expect((await store.listChats()).find((entry) => entry.id === chat.id)?.lastMessagePreview).toBeNull()
  })

  it('treats an empty worktree mapping as current checkout, and any row as isolated', async () => {
    const { store, chat } = await seeded()

    expect(chat.checkout).toEqual({ mode: 'current', branch: null })
    expect(await store.loadChatWorktrees(chat.id)).toEqual([])

    await store.replaceChatWorktrees(chat.id, [
      {
        sourcePath: '/repos/manor',
        worktreePath: '/tmp/worktrees/manor/chat/Manor',
        branch: 'manor/abcd1234',
        createdAt: 1,
      },
    ])

    expect((await store.getChat(chat.id))?.checkout).toEqual({ mode: 'worktree', branch: 'manor/abcd1234' })
    expect((await store.listChats()).find((entry) => entry.id === chat.id)?.checkout).toEqual({
      mode: 'worktree',
      branch: 'manor/abcd1234',
    })

    await store.replaceChatWorktrees(chat.id, [])
    expect((await store.getChat(chat.id))?.checkout).toEqual({ mode: 'current', branch: null })
    expect(await store.loadChatWorktrees(chat.id)).toEqual([])
  })

  it('cascades worktree rows when the chat is deleted, the way the foreign key does', async () => {
    const { store, chat } = await seeded()
    await store.replaceChatWorktrees(chat.id, [
      {
        sourcePath: '/repos/manor',
        worktreePath: '/tmp/worktrees/manor/chat/Manor',
        branch: 'manor/abcd1234',
        createdAt: 1,
      },
    ])

    await store.deleteChat(chat.id)

    expect(await store.loadChatWorktrees(chat.id)).toEqual([])
    await expect(
      store.replaceChatWorktrees(chat.id, [
        {
          sourcePath: '/repos/manor',
          worktreePath: '/tmp/worktrees/manor/chat/Manor',
          branch: 'manor/abcd1234',
          createdAt: 1,
        },
      ]),
    ).rejects.toThrow(/unknown chat/)
  })

  it('round-trips one summary, refuses an older cursor and cascades it with the chat', async () => {
    const { store, chat } = await seeded()
    await store.appendEvent(chat.id, { type: 'user_message', text: 'one', mentions: [] })
    await store.appendEvent(chat.id, { type: 'user_message', text: 'two', mentions: [] })

    await store.setChatSummary(chat.id, 'Through two.', 'evt_000002')
    await store.setChatSummary(chat.id, 'Stale.', 'evt_000001')
    await store.setChatSummary(chat.id, 'Duplicate.', 'evt_000002')

    expect(await store.getChatSummary(chat.id)).toMatchObject({
      summary: 'Through two.',
      throughEventId: 'evt_000002',
      updatedAt: expect.any(Number),
    })

    await store.deleteChat(chat.id)
    expect(await store.getChatSummary(chat.id)).toBeUndefined()
  })
})
