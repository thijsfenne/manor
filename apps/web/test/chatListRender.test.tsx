import { CURRENT_CHECKOUT, type AgentConfig, type Chat } from '@manor/contracts'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ChatListView } from '../src/components/chats/ChatListView'
import { GroupDialogContent } from '../src/components/chats/GroupDialog'
import { chatList, emptyWorkspace, type WorkspaceState } from '../src/state'

// No DOM here to portal into: the modal renders its title and body in place.
vi.mock('../src/components/Modal', async (original) => ({
  ...(await original<typeof import('../src/components/Modal')>()),
  Modal: ({ title, children }: { title: string; children: ReactNode }) => <div role="dialog">{title}{children}</div>,
}))

const agent = (id: string, name: string, color: string): AgentConfig =>
  ({ id, name, color, allowedTools: [] }) as unknown as AgentConfig

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

const render = (
  agents: AgentConfig[],
  chats: Chat[],
  activity: WorkspaceState['activity'] = {},
  selection: Partial<Pick<WorkspaceState, 'openChatId' | 'pendingChatId'>> = {},
  armed: string | null = null,
) => {
  const workspace: WorkspaceState = {
    ...emptyWorkspace,
    agents,
    hasRoster: true,
    hasDirectory: true,
    chats,
    activity,
    ...selection,
  }
  return renderToStaticMarkup(
    <ChatListView
      rows={chatList(workspace)}
      agents={agents}
      hasDirectory
      showChatSelection
      draftAgentId={null}
      armed={armed}
      onArm={() => {}}
      onOpenChat={() => {}}
      onOpenDm={() => {}}
      onEditAgent={() => {}}
      onEditGroup={() => {}}
      onDeleteChat={() => {}}
      onSetPins={() => {}}
    />,
  )
}

/** Every face here is an Avatar, and no persona in these fixtures has a picture. */
const faces = (html: string) => html.match(/data-avatar="blobatar"/g)?.length ?? 0

describe('the chat list on screen', () => {
  it('keeps standing pair threads out of the sidebar', () => {
    const html = render(
      [agent('jeeves', 'Jeeves', '#8b5cf6'), agent('smith', 'Smith', '#c77dbb')],
      [chat({
        id: 'pair',
        kind: 'pair',
        memberIds: ['jeeves', 'smith'],
        agentIds: ['jeeves', 'smith'],
        lastMessageAt: 10,
        lastMessagePreview: 'pong',
      })],
    )

    expect(html).not.toContain('Between agents')
    expect(html).not.toContain('View only')
    expect(html).not.toContain('pong')
  })

  it('draws a household of one', () => {
    const html = render([agent('jeeves', 'Jeeves', '#8b5cf6')], [])

    expect(html).toContain('Jeeves')
    // A persona with no picture still has a face. What colour it comes out is
    // the Avatar's own business, and `avatarBlobatar` is where that is pinned.
    expect(faces(html)).toBe(1)
    expect(html).not.toContain('aria-label="Edit Jeeves"')
    expect(html).toContain('gap-[2px]')
    // A persona nobody has written to has no age to state, and no news either.
    expect(html).not.toContain('tabular-nums')
    expect(html).not.toContain('New messages')
  })

  // The same marks the Work inbox uses: an unread answer is the green Done dot in
  // the time's place, and a quiet row shows its age.
  it('trades the time for the Done dot once there is news', () => {
    const agents = [agent('iris', 'Iris', '#8b5cf6')]
    const chats = [chat({ id: 'dm', kind: 'dm', memberIds: ['iris'], lastMessageAt: Date.now() - 120_000 })]

    const quiet = render(agents, chats)
    const loud = render(agents, chats, { dm: { unread: true, runningTurns: [], runStartedAt: null, sawStart: false, awaitingInput: [], answeredInput: [] } })

    expect(quiet).toContain('2m')
    expect(quiet).not.toContain('bg-ok')
    expect(loud).toContain('aria-label="Done"')
    expect(loud).toContain('bg-ok')
    expect(loud).not.toContain('2m')
  })

  // "Working" while an agent stands still waiting on an answer was the row lying
  // about who it was waiting for. Warn, not busy: this one is a claim on the user.
  it('says a chat is waiting rather than working once a question is open there', () => {
    const agents = [agent('iris', 'Iris', '#8b5cf6')]
    const chats = [chat({ id: 'dm', kind: 'dm', memberIds: ['iris'], lastMessageAt: Date.now() })]

    const working = render(agents, chats, {
      dm: { unread: false, runningTurns: ['turn_1'], runStartedAt: 1, sawStart: true, awaitingInput: [], answeredInput: [] },
    })
    const waiting = render(agents, chats, {
      dm: { unread: false, runningTurns: ['turn_1'], runStartedAt: 1, sawStart: true, awaitingInput: ['req_1'], answeredInput: [] },
    })

    const settled = render(agents, chats)

    // Running is her own face playing the working loop, with no spinner beside it; it settles with the turn.
    expect(working).toContain('mo-always')
    expect(working).toContain('<span class="sr-only">Working</span>')
    expect(working).not.toContain('animate-spin-calm')
    expect(working).not.toContain('thought-dots')
    expect(settled).not.toContain('mo-always')
    expect(settled).not.toContain('Working')
    expect(waiting).toContain('Waiting')
    expect(waiting).not.toContain('Working')
    expect(waiting).not.toContain('mo-always')
    expect(waiting).toContain('text-warn')
  })

  it('keeps the time and the Done dot on a row whose face is working', () => {
    const agents = [agent('iris', 'Iris', '#8b5cf6')]
    const chats = [chat({ id: 'dm', kind: 'dm', memberIds: ['iris'], lastMessageAt: Date.now() - 120_000 })]
    const turn = { runningTurns: ['turn_1'], runStartedAt: 1, sawStart: true, awaitingInput: [], answeredInput: [] }

    expect(render(agents, chats, { dm: { unread: false, ...turn } })).toContain('2m')
    expect(render(agents, chats, { dm: { unread: true, ...turn } })).toContain('aria-label="Done"')
  })

  // A group has no one face to move, so its row still says it is working the way the Work inbox does.
  it('keeps the spinner on a running group, whose row has no single face', () => {
    const agents = [agent('iris', 'Iris', '#8b5cf6'), agent('sage', 'Sage', '#22c55e')]
    const chats = [chat({ id: 'room', kind: 'group', memberIds: ['iris', 'sage'], lastMessageAt: Date.now() })]
    const working = render(agents, chats, {
      room: { unread: false, runningTurns: ['turn_1'], runStartedAt: 1, sawStart: true, awaitingInput: [], answeredInput: [] },
    })

    expect(working).toContain('aria-label="Working"')
    expect(working).toContain('animate-spin-calm')
  })

  // The stage says what it is fetching; a list that said it too would put a word
  // where the time goes and take it away again a moment later.
  it('lights the clicked row at once, and says nothing about the fetch behind it', () => {
    const agents = [agent('iris', 'Iris', '#8b5cf6'), agent('sage', 'Sage', '#22c55e')]
    const chats = [
      chat({ id: 'dm_iris', kind: 'dm', memberIds: ['iris'], lastMessageAt: Date.now() - 120_000 }),
      chat({ id: 'dm_sage', kind: 'dm', memberIds: ['sage'], lastMessageAt: Date.now() - 180_000 }),
    ]

    // Iris is still the transcript on screen, Sage is the row just clicked.
    const html = render(agents, chats, {}, { openChatId: 'dm_iris', pendingChatId: 'dm_sage' })

    expect(html).not.toContain('opening')
    expect(html).toContain('3m')
    // Exactly one row is lit, and it is the clicked one rather than the open one.
    expect(html.match(/aria-current="page"/g)?.length).toBe(1)
    expect(html.indexOf('aria-current="page"')).toBeGreaterThan(html.indexOf('Iris'))
    expect(html.indexOf('aria-current="page"')).toBeLessThan(html.indexOf('Sage'))
  })

  // A pinned persona is not one row among the others: her face sits above the list,
  // centred, and her name is gone from the rows below it.
  it('lifts a pinned chief of staff out of the list and centres her above it', () => {
    const chief = { ...agent('jeeves', 'Jeeves', '#8b5cf6'), isCos: true, pinned: true, role: 'Chief of staff' }
    const html = render([chief, agent('sage', 'Sage', '#22c55e')], [])

    expect(html.indexOf('Jeeves')).toBeLessThan(html.indexOf('Sage'))
    expect(html).toContain('flex-col items-center')
    expect(html).toContain('mx-auto my-2 size-40')
    expect(html).toContain('flex size-full')
    expect(html).toContain('items-center gap-0.5')
    // Her face stays the big one, without adding a management action to the DM list.
    expect(html).toContain('width:80px;height:80px')
    expect(html).not.toContain('aria-label="Edit Jeeves"')
    expect(html).toContain('Chief of staff')
    expect(html).toContain('bg-role-badge')
  })

  it('shows the chief working on her own face, with no spinner on her card', () => {
    const chief = { ...agent('jeeves', 'Jeeves', '#8b5cf6'), isCos: true, pinned: true }
    const chats = [chat({ id: 'dm_jeeves', kind: 'dm', memberIds: ['jeeves'], lastMessageAt: Date.now() })]
    const working = render([chief], chats, {
      dm_jeeves: { unread: false, runningTurns: ['turn_1'], runStartedAt: 1, sawStart: true, awaitingInput: [], answeredInput: [] },
    })
    const settled = render([chief], chats)

    expect(working).toContain('mo-always')
    expect(working).toContain('<span class="sr-only">Working</span>')
    expect(working).not.toContain('animate-spin-calm')
    expect(working).not.toContain('absolute right-3 top-3')
    expect(settled).not.toContain('mo-always')
    expect(settled).not.toContain('Working')
  })

  // Her place above the list is a layout, not a smaller set of acts: the delete a
  // row offers has to survive being lifted out of that list.
  it('asks before deleting the chief’s own thread, and keeps her card while it asks', () => {
    const chief = { ...agent('jeeves', 'Jeeves', '#8b5cf6'), isCos: true, pinned: true }
    const html = render(
      [chief],
      [chat({ id: 'dm_jeeves', kind: 'dm', memberIds: ['jeeves'], lastMessageAt: Date.now() })],
      {},
      {},
      'dm:jeeves',
    )

    expect(html).toContain('role="dialog">Delete “Jeeves”?')
    expect(html).toContain('All its messages go with it.')
    expect(faces(html)).toBe(1)
  })

  it('lifts only pinned personas, at most two and chief first', () => {
    const unpinnedChief = render([{ ...agent('jeeves', 'Jeeves', '#8b5cf6'), isCos: true }], [])
    expect(unpinnedChief).not.toContain('mx-auto my-2 size-40')

    const html = render(
      [
        { ...agent('nova', 'Nova', '#22c55e'), pinned: true },
        { ...agent('sage', 'Sage', '#f59e0b'), pinned: true },
        { ...agent('jeeves', 'Jeeves', '#8b5cf6'), isCos: true, pinned: true },
      ],
      [],
    )
    // Two compact cards: Jeeves then Nova. Sage, pinned third, stays a row.
    expect(html.match(/width:56px;height:56px/g)?.length).toBe(2)
    expect(html.indexOf('Jeeves')).toBeLessThan(html.indexOf('Nova'))
    expect(html.indexOf('Nova')).toBeLessThan(html.indexOf('<ul'))
    expect(html.indexOf('Sage')).toBeGreaterThan(html.indexOf('<ul'))
  })

  it('wears a persona’s role beside her name', () => {
    const html = render([{ ...agent('smith', 'Smith', '#f59e0b'), role: 'Engineer' }], [])

    expect(html).toContain('Engineer')
    expect(html.indexOf('Smith')).toBeLessThan(html.indexOf('Engineer'))
    // A persona with no role stated keeps a bare name rather than a badge saying
    // which runtime she happens to run on.
    expect(render([agent('iris', 'Iris', '#8b5cf6')], [])).not.toContain('rounded-md')
  })

  it('draws a household of several, with a group stacking its own members', () => {
    const agents = [
      agent('jeeves', 'Jeeves', '#8b5cf6'),
      agent('sage', 'Sage', '#22c55e'),
      agent('smith', 'Smith', '#f59e0b'),
    ]
    const html = render(agents, [
      chat({
        id: 'grp',
        kind: 'group',
        memberIds: ['sage', 'smith'],
        title: 'Release crew',
        lastMessagePreview: 'Ship it Monday',
        lastMessageAt: Date.now() - 120_000,
      }),
    ])

    expect(html).toContain('Release crew')
    expect(html).toContain('Ship it Monday')
    // A room is not a person, and the badge slot is where the row says so.
    expect(html).toContain('>Group<')
    // Three personas plus the two faces the group stacks.
    expect(faces(html)).toBe(5)
    expect(html).toContain('data-agent-layout="cluster"')
    expect(html).toContain('width:48px;height:48px')
    expect(html).toContain('width:34px;height:34px')
    // The group is the only row with an age, and it is the one on top.
    expect(html.indexOf('Release crew')).toBeLessThan(html.indexOf('Jeeves'))
    expect(html).toContain('2m')
  })
})

describe('the group dialog', () => {
  const agents = [
    agent('sage', 'Sage', '#22c55e'),
    agent('smith', 'Smith', '#f59e0b'),
  ]

  it('offers deletion while editing, but never while creating', () => {
    const edit = renderToStaticMarkup(
      <GroupDialogContent
        mode="edit"
        agents={agents}
        members={['sage', 'smith']}
        title="Release crew"
        onSubmit={() => true}
        onAskDelete={() => {}}
        onClose={() => {}}
      />,
    )
    const create = renderToStaticMarkup(
      <GroupDialogContent
        mode="create"
        agents={agents}
        members={[]}
        onSubmit={() => true}
        onClose={() => {}}
      />,
    )

    expect(edit).toContain('>Delete group</button>')
    expect(edit).toContain('text-danger')
    expect(create).not.toContain('Delete group')
  })
})
