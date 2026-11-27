import { type ReactNode } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentConfig, Chat, MyMindArtifact, PageContextAttachment, Project } from '@manor/contracts'
import { NEW_CHAT_DRAFT_KEY } from '../src/composerDrafts'
import { type ChatDestination } from '../src/components/artifacts/AddToChatButton'
import { ArtifactsView } from '../src/components/artifacts/ArtifactsView'
import { Dialog } from '../src/components/ui/Dialog'
import { artifactsDestinations } from '../src/components/workspace/DestinationView'

vi.mock('react-dom', async (actual) => ({ ...(await actual()), createPortal: (children: ReactNode) => children }))
vi.mock('../src/components/Avatar', () => ({ Avatar: () => null }))

const agent = (id: string, name: string, more: Partial<AgentConfig> = {}) =>
  ({ id, name, color: 'teal', isCos: false, ...more }) as unknown as AgentConfig
const chat = (id: string, kind: Chat['kind'], lastMessageAt = 0, more: Partial<Chat> = {}) =>
  ({ id, kind, memberIds: [], archivedAt: null, lastMessageAt, projectId: null, title: id, ...more }) as unknown as Chat
const project = (id: string, name: string, threadChatId?: string) =>
  ({ id, name, color: 'olive', icon: 'folder', threadChatId }) as unknown as Project

let view: ReactTestRenderer
const host = (match: (node: ReactTestInstance) => boolean) => view.root.findAll((node) => typeof node.type === 'string' && match(node))
const textOf = (node: ReactTestInstance): string => node.children.map((child) => (typeof child === 'string' ? child : textOf(child))).join('')
const radios = () => host((node) => node.props.role === 'radio')

beforeEach(() => {
  vi.stubGlobal('document', { body: {} })
  vi.stubGlobal('HTMLElement', class {})
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
})
afterEach(() => {
  act(() => view?.unmount())
  vi.unstubAllGlobals()
})

describe('Artifacts add to chat', () => {
  it('lists the chat on screen, a new Session, the agents, the project threads, then recent Sessions, each once', () => {
    const chats = [
      chat('writer-dm', 'dm', 9, { memberIds: ['writer'] }),
      chat('garden-thread', 'project', 8, { projectId: 'garden' }),
      chat('hidden-thread', 'project', 7, { archivedAt: 1 } as Partial<Chat>),
      ...[1, 2, 3, 4, 5, 6].map((at) => chat(`session-${at}`, 'project', at)),
      chat('team', 'group', 10),
      chat('run', 'run', 11),
    ]
    const list = artifactsDestinations({
      agents: [agent('writer', 'Writer'), agent('chief', 'Chief', { isCos: true }), agent('builder', 'Builder', { placement: 'session' })],
      chats,
      projects: [project('garden', 'Garden', 'garden-thread'), project('hidden', 'Hidden', 'hidden-thread'), project('folder', 'Folder')],
      chatRows: [],
      open: chats[0] ?? null,
      staged: {},
      canStartChat: true,
      creating: false,
    })
    expect(list.map((target) => [target.label, target.detail])).toEqual([
      ['Writer', 'Current'],
      ['New Session', undefined],
      ['Chief', undefined],
      ['Garden', undefined],
      ['team', undefined],
      ['session-6', undefined],
      ['session-5', undefined],
      ['session-4', undefined],
      ['session-3', undefined],
    ])
    // The open DM keeps its face; a DM never opened is staged under its draft's slot.
    expect(list[0]?.owner).toEqual({ agent: expect.objectContaining({ id: 'writer' }) })
    expect(list[2]).toMatchObject({ id: 'new-chat:dm:chief', kind: 'new' })
    expect(list[3]?.owner).toEqual({ project: expect.objectContaining({ id: 'garden' }) })
  })

  it('opens the dialog from the arrow and hands every selected source to the chat picked there', () => {
    const artifacts = ['one', 'two'].map((id) => ({
      id, title: `Artifact ${id}`, kind: 'note', summary: '', note: '', tags: [], spaces: [], created: '2026-08-20T10:00:00.000Z', bumped: '2026-08-20T10:00:00.000Z',
    }) as unknown as MyMindArtifact)
    const destinations: ChatDestination[] = [
      { id: 'chat_1', kind: 'chat', label: 'Plans', detail: 'Current', usedIds: [] },
      { id: NEW_CHAT_DRAFT_KEY, kind: 'new', label: 'New Session', usedIds: [] },
      { id: 'writer-dm', kind: 'chat', label: 'Writer', owner: { agent: agent('writer', 'Writer') }, usedIds: [] },
    ]
    const onAddToChat = vi.fn<(contexts: PageContextAttachment[], destination: ChatDestination) => void>()
    act(() => {
      view = create(
        <ArtifactsView objects={artifacts} spaces={[]} query="" loading={false} loadingMore={false} hasMore={false} error={null}
          destinations={destinations} attachedContexts={[]} status="live" sidebarCollapsed={false}
          onSearch={() => {}} onLoadMore={() => {}} onOpenSource={() => {}} onAddToChat={onAddToChat} />,
      )
    })
    const press = (label: string) => act(() => host((node) => node.props['aria-label'] === label)[0]!.props.onClick({ stopPropagation: () => {} }))
    press('Select Artifact one')
    press('Select Artifact two')
    press('Choose which chat to add to')
    expect(radios().map((node) => node.props['aria-label'])).toEqual(['Plans, Current', 'New Session', 'Writer, direct message'])
    // The dialog starts on the room the wide half aims at.
    expect(radios().find((node) => node.props['aria-checked'] === true)?.props['aria-label']).toBe('Plans, Current')
    press('Writer, direct message')
    act(() => host((node) => node.type === 'button' && textOf(node) === 'Add')[0]!.props.onClick())
    expect(onAddToChat).toHaveBeenCalledOnce()
    const [contexts, destination] = onAddToChat.mock.calls[0]!
    expect(contexts.map((context) => context.id)).toEqual(['mymind:one', 'mymind:two'])
    expect(destination.id).toBe('writer-dm')
    expect(radios()).toEqual([])
  })

  it('leaves the keys of a dialog opened from inside another to that dialog', () => {
    const outer = vi.fn()
    const inner = vi.fn()
    // One stand-in per card, because the renderer asks for a node every time one is read.
    const cards = new Map<string, { contains: (target: unknown) => boolean; focus: () => void }>()
    const cardFor = (label: string) => {
      const known = cards.get(label)
      if (known !== undefined) return known
      const card = { contains: (target: unknown) => target === card, focus: () => {} }
      cards.set(label, card)
      return card
    }
    act(() => {
      view = create(
        <Dialog label="Detail" onClose={outer}>
          <Dialog label="Add to chat" onClose={inner}>Rows</Dialog>
        </Dialog>,
        { createNodeMock: (element) => cardFor(String(element.props['aria-label'])) },
      )
    })
    const [detail, picker] = host((node) => node.props.role === 'dialog')
    const escape = { key: 'Escape', target: cardFor('Add to chat'), preventDefault: () => {} }
    // React bubbles the inner dialog's key through the outer one as well.
    act(() => {
      picker!.props.onKeyDown(escape)
      detail!.props.onKeyDown(escape)
    })
    expect(inner).toHaveBeenCalledOnce()
    expect(outer).not.toHaveBeenCalled()
  })
})
