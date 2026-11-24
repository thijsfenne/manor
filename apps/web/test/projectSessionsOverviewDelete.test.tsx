import { CURRENT_CHECKOUT, type Chat } from '@manor/contracts'
import type { ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { DeleteChatConfirm } from '../src/components/Confirm'
import { LiveRow } from '../src/components/inbox/InboxView'
import { ProjectSessionsOverview } from '../src/components/inbox/ProjectSessionsOverview'
import type { SessionOverviewRow } from '../src/state'

// No DOM here to portal into: the modal renders its title and body in place.
vi.mock('../src/components/Modal', async (original) => ({
  ...(await original<typeof import('../src/components/Modal')>()),
  Modal: ({ title, children }: { title: string; children: ReactNode }) => <div role="dialog">{title}{children}</div>,
}))

const chat: Chat = {
  id: 'c1', projectId: 'p1', kind: 'project', routineId: null, parentChatId: null, sideModel: null, sideEffort: null,
  memberIds: [], lastMessagePreview: null, title: 'Fix the footer', createdAt: 1, lastMessageAt: 1, settledAt: null,
  archivedAt: null, agentIds: [], checkout: CURRENT_CHECKOUT,
}
const row: SessionOverviewRow = { key: 'c1', title: chat.title, status: 'working', chat, line: 'Latest line', at: 1, unread: false, running: true, waiting: false }

const mount = (onDeleteChat: (chatId: string) => void, onAskDelete?: (chat: { id: string; title: string }) => void) => {
  let tree: ReactTestRenderer | undefined
  act(() => {
    tree = create(
      <ProjectSessionsOverview
        threadId="delete-thread"
        overview={{ waiting: [], working: [row], settled: [], background: [], archived: [], archiveKeepMs: 1 }}
        agents={[]}
        onOpen={() => {}}
        onRevealProposal={() => {}}
        openLabel={(title) => `Open ${title}`}
        onSetSettled={() => true}
        onSetArchived={() => true}
        onDeleteChat={onDeleteChat}
        project={undefined}
        {...(onAskDelete === undefined ? {} : { onAskDelete })}
      />,
    )
  })
  return tree!
}

describe('deleting a Session from the overview', () => {
  it('asks in a modal, and deletes only once that is confirmed', () => {
    const onDeleteChat = vi.fn()
    const tree = mount(onDeleteChat)
    act(() => tree.root.findByType(LiveRow).props.onArm('chat:c1'))
    const confirm = tree.root.findByType(DeleteChatConfirm)
    expect(confirm.props.title).toBe('Fix the footer')
    expect(onDeleteChat).not.toHaveBeenCalled()
    act(() => confirm.props.onConfirm())
    expect(onDeleteChat).toHaveBeenCalledWith('c1')
    expect(tree.root.findAllByType(DeleteChatConfirm)).toHaveLength(0)
  })

  it('hands the question to the popover\'s door when it asks elsewhere', () => {
    const onAskDelete = vi.fn()
    const tree = mount(() => {}, onAskDelete)
    act(() => tree.root.findByType(LiveRow).props.onArm('chat:c1'))
    expect(onAskDelete).toHaveBeenCalledWith({ id: 'c1', title: 'Fix the footer' })
    expect(tree.root.findAllByType(DeleteChatConfirm)).toHaveLength(0)
  })
})
