import { CURRENT_CHECKOUT, ClientMessageSchema, type AgentConfig, type Chat } from '@manor/contracts'
import { describe, expect, it } from 'vitest'
import {
  chatList,
  emptyWorkspace,
  filterChatRows,
  inbox,
  searchThreads,
  type ThreadSearchHit,
  type WorkspaceState,
} from '../src/state'
import { sidebarViewForChat, sidebarViewFrom } from '../src/useSidebar'
import { createChatMessage } from '../src/useWorkspace'

const agent = (id: string, name: string): AgentConfig =>
  ({ id, name, color: '#8b5cf6', allowedTools: [] }) as unknown as AgentConfig

const ROSTER = [agent('jeeves', 'Jeeves'), agent('sage', 'Sage'), agent('smith', 'Smith')]

const chat = (chat: Partial<Chat> & Pick<Chat, 'id' | 'lastMessageAt'>): Chat => ({
  projectId: null,
  kind: 'project',
  routineId: null,
  parentChatId: null,
  sideModel: null,
  sideEffort: null,
  memberIds: [],
  lastMessagePreview: null,
  title: chat.id,
  createdAt: chat.lastMessageAt,
  settledAt: null,
  agentIds: [],
  checkout: CURRENT_CHECKOUT,
  ...chat,
  archivedAt: chat.archivedAt ?? null,
})

const workspace = (chats: Chat[], extra: Partial<WorkspaceState> = {}): WorkspaceState => ({
  ...emptyWorkspace,
  agents: ROSTER,
  hasRoster: true,
  hasDirectory: true,
  chats,
  ...extra,
})

describe('the sidebar chat list', () => {
  it('gives every persona a row, whether or not a DM exists yet', () => {
    const rows = chatList(workspace([]))

    // Roster order, because nothing has happened to order them by.
    expect(rows.map((row) => row.title)).toEqual(['Jeeves', 'Sage', 'Smith'])
    expect(rows.every((row) => row.chat === null && row.lastMessageAt === null && row.preview === '')).toBe(
      true,
    )
    expect(rows.map((row) => row.key)).toEqual(['dm:jeeves', 'dm:sage', 'dm:smith'])
  })

  it('binds a DM chat to its persona and carries the server preview', () => {
    const rows = chatList(
      workspace([
        chat({
          id: 'dm_sage',
          kind: 'dm',
          memberIds: ['sage'],
          title: 'Sage',
          lastMessagePreview: 'Ik kijk ernaar',
          lastMessageAt: 300,
        }),
      ]),
    )

    expect(rows[0]).toMatchObject({
      key: 'dm:sage',
      kind: 'dm',
      agentId: 'sage',
      title: 'Sage',
      preview: 'Ik kijk ernaar',
      lastMessageAt: 300,
    })
    expect(rows[0]?.chat?.id).toBe('dm_sage')
  })

  it('mixes groups in and sorts on last activity, personas with no DM at the bottom', () => {
    const rows = chatList(
      workspace([
        chat({ id: 'dm_smith', kind: 'dm', memberIds: ['smith'], title: 'Smith', lastMessageAt: 100 }),
        chat({
          id: 'grp',
          kind: 'group',
          memberIds: ['sage', 'smith'],
          title: 'Release crew',
          lastMessageAt: 500,
        }),
        // A project chat is not in this list: it lives in a room, and the inbox is
        // where the whole house is listed.
        chat({ id: 'proj', projectId: 'p1', lastMessageAt: 900 }),
      ]),
    )

    expect(rows.map((row) => row.title)).toEqual(['Release crew', 'Smith', 'Jeeves', 'Sage'])
    expect(rows[0]).toMatchObject({ kind: 'group', agentId: null, agentIds: ['sage', 'smith'] })
    expect(rows.some((row) => row.chat?.id === 'proj')).toBe(false)
  })

  it('reads unread, running and selection off the same activity every other view does', () => {
    const rows = chatList(
      workspace(
        [
          chat({ id: 'dm_sage', kind: 'dm', memberIds: ['sage'], title: 'Sage', lastMessageAt: 300 }),
          chat({ id: 'dm_smith', kind: 'dm', memberIds: ['smith'], title: 'Smith', lastMessageAt: 200 }),
        ],
        {
          openChatId: 'dm_sage',
          pendingChatId: 'dm_smith',
          activity: {
            dm_sage: { unread: false, runningTurns: ['turn_1'], runStartedAt: null, sawStart: false, awaitingInput: [], answeredInput: [] },
            dm_smith: { unread: true, runningTurns: [], runStartedAt: null, sawStart: false, awaitingInput: [], answeredInput: [] },
          },
        },
      ),
    )
    const byKey = new Map(rows.map((row) => [row.key, row]))

    // Sage's transcript is still the one on screen, but Smith's row is the one that
    // was clicked, so the click is what the list lights and only one row wears it.
    expect(byKey.get('dm:sage')).toMatchObject({ selected: false, running: true, unread: false })
    expect(byKey.get('dm:smith')).toMatchObject({ selected: true, unread: true })
    // A row with no chat behind it has no standing of its own to report.
    expect(byKey.get('dm:jeeves')).toMatchObject({ selected: false, running: false })
  })

  it('filters on what the row is called, whatever the case', () => {
    const rows = chatList(
      workspace([
        chat({
          id: 'grp',
          kind: 'group',
          memberIds: ['sage', 'smith'],
          title: 'Release crew',
          lastMessageAt: 500,
        }),
      ]),
    )

    expect(filterChatRows(rows, 'sa').map((row) => row.title)).toEqual(['Sage'])
    expect(filterChatRows(rows, 'RELEASE').map((row) => row.title)).toEqual(['Release crew'])
    expect(filterChatRows(rows, '  ').map((row) => row.title)).toEqual(rows.map((row) => row.title))
    expect(filterChatRows(rows, 'nobody')).toEqual([])
  })

  it('searches threads on title, preview and extra fields, newest first', () => {
    const hits: ThreadSearchHit[] = [
      {
        chatId: 'old',
        title: 'Release notes',
        preview: 'Ship Monday',
        lastMessageAt: 1,
        fields: ['Release notes', 'Ship Monday', 'Manor'],
        projectName: 'Manor',
      },
      {
        chatId: 'new',
        title: 'Inbox sorter',
        preview: 'Sorted one note',
        lastMessageAt: 2,
        fields: ['Inbox sorter', 'Sorted one note'],
        projectName: '',
      },
    ]

    expect(searchThreads(hits, '  ').map((hit) => hit.chatId)).toEqual([])
    expect(searchThreads(hits, 'monday').map((hit) => hit.chatId)).toEqual(['old'])
    expect(searchThreads(hits, 'Manor').map((hit) => hit.chatId)).toEqual(['old'])
    expect(searchThreads(hits, 'Manor')[0]?.projectName).toBe('Manor')
    expect(searchThreads(hits, 's').map((hit) => hit.chatId)).toEqual(['new', 'old'])
    expect(searchThreads(hits, 'nobody')).toEqual([])
  })

  // A renamed persona must not keep her old name in the list until someone writes to
  // her again, so the row reads the roster and not the title frozen into the chat.
  it('names a DM row after the persona, not after the stored title', () => {
    const rows = chatList(
      workspace([
        chat({ id: 'dm_sage', kind: 'dm', memberIds: ['sage'], title: 'Sage (old)', lastMessageAt: 1 }),
      ]),
    )

    expect(rows[0]?.title).toBe('Sage')
  })
})

describe('the inbox with home chats in it', () => {
  // The inbox is the list of work still waiting, and a dm or a group is an endless
  // thread that can never be ticked off. So it is a list of project chats only.
  it('lists project chats and leaves dms and groups out of both halves', () => {
    const house = inbox(
      workspace([
        chat({ id: 'dm_sage', kind: 'dm', memberIds: ['sage'], title: 'Sage', lastMessageAt: 300 }),
        chat({
          id: 'grp',
          kind: 'group',
          memberIds: ['sage', 'smith'],
          title: 'Release crew',
          lastMessageAt: 200,
        }),
        chat({ id: 'proj', projectId: 'ghost', lastMessageAt: 100 }),
      ]),
    )

    expect(house.unsettled.map((row) => row.chat.id)).toEqual(['proj'])
    expect(house.settled).toEqual([])
    // A project chat whose room the directory has not listed still renders, which is
    // the case that used to reach `rooms.get(null)`.
    expect(house.unsettled[0]?.projectName).toBe('')
  })

  // Belt and braces: the sweep no longer stamps a home chat, but one stamped before
  // that rule existed must not surface in the settled list either.
  it('keeps a home chat out even when it carries a settled stamp from before', () => {
    const house = inbox(
      workspace([
        chat({ id: 'dm_sage', kind: 'dm', memberIds: ['sage'], title: 'Sage', lastMessageAt: 300, settledAt: 400 }),
        chat({ id: 'grp', kind: 'group', memberIds: ['sage', 'smith'], lastMessageAt: 200, settledAt: 400 }),
      ]),
    )

    expect(house.unsettled).toEqual([])
    expect(house.settled).toEqual([])
  })
})

describe('the DM that is created by its first send', () => {
  it('carries only the chosen mode runtime after switching a draft in either direction', () => {
    const single = { driver: 'codex', model: 'gpt-5.6-sol', effort: 'medium' } as const
    const overrides = { __single__: single, sage: { model: 'opus' } }
    const singleMessage = createChatMessage({ kind: 'project', projectId: 'p1', mode: 'single' }, undefined, overrides)
    expect(singleMessage)
      .toMatchObject({ mode: 'single', overrides: { __single__: single } })
    expect(singleMessage).not.toHaveProperty('overrides.sage')
    const house = createChatMessage({ kind: 'project', projectId: 'p1', mode: 'house' }, undefined, overrides)
    expect(house).toMatchObject({ mode: 'house', overrides: { sage: { model: 'opus' } } })
    expect(house).not.toHaveProperty('overrides.__single__')
    expect(overrides).toEqual({ __single__: single, sage: { model: 'opus' } })
  })
  it('sends a dm create with no project and exactly one member', () => {
    const message = createChatMessage({ kind: 'dm', agentId: 'sage' }, { text: 'hoi', images: [] })

    expect(message).toEqual({
      type: 'create_chat',
      kind: 'dm',
      memberIds: ['sage'],
      openingMessage: { text: 'hoi' },
    })
    // The wire is the contract's, not this test's reading of it.
    expect(ClientMessageSchema.safeParse(message).success).toBe(true)
  })

  it('still sends a project chat exactly as it always did', () => {
    const message = createChatMessage({ kind: 'project', projectId: 'p1' }, { text: 'hoi', images: [] }, {
      sage: { model: 'opus' },
    })

    expect(message).toMatchObject({ type: 'create_chat', projectId: 'p1', overrides: { sage: { model: 'opus' } } })
    expect(message).not.toHaveProperty('kind')
    expect(ClientMessageSchema.safeParse(message).success).toBe(true)
  })

  it('leaves a blank group name to the server and keeps a typed one', () => {
    expect(createChatMessage({ kind: 'group', memberIds: ['sage', 'smith'], title: '' })).toEqual({
      type: 'create_chat',
      kind: 'group',
      memberIds: ['sage', 'smith'],
    })
    expect(
      createChatMessage({ kind: 'group', memberIds: ['sage', 'smith'], title: 'Release crew' }),
    ).toMatchObject({ title: 'Release crew' })
  })
})

describe('the remembered sidebar view', () => {
  it('reads the old projects value as the chat list that replaced it', () => {
    expect(sidebarViewFrom('projects')).toBe('chats')
    expect(sidebarViewFrom('chats')).toBe('chats')
    expect(sidebarViewFrom('inbox')).toBe('inbox')
    expect(sidebarViewFrom(null)).toBe('chats')
    expect(sidebarViewFrom('nonsense')).toBe('chats')
  })

  it('keeps project work in the inbox and household conversations in chats', () => {
    expect(sidebarViewForChat('project')).toBe('inbox')
    expect(sidebarViewForChat('run')).toBe('inbox')
    expect(sidebarViewForChat('dm')).toBe('chats')
    expect(sidebarViewForChat('group')).toBe('chats')
  })
})
