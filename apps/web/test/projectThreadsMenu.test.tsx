import { CURRENT_CHECKOUT, type Chat, type Project } from '@manor/contracts'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProjectThreadRow } from '../src/state'
import { ProjectThreadsSection } from '../src/components/inbox/ProjectThreadsSection'
import { ConfirmModal } from '../src/components/Confirm'
import { ProjectDialog, emptyDraft } from '../src/components/projects/ProjectDialog'

// The test renderer has no DOM: the menu renders in place and layout animation stays off.
vi.mock('react-dom', async (original) => ({
  ...(await original<typeof import('react-dom')>()),
  createPortal: (children: unknown) => children,
}))
vi.mock('../src/components/ui/useDismiss', () => ({ useDismiss: () => {} }))
vi.mock('motion/react', async (original) => {
  const actual = await original<typeof import('motion/react')>()
  const { createElement, forwardRef } = await import('react')
  const plain = new Map<string, unknown>()
  const motion = new Proxy({}, {
    get: (_target, tag: string) => {
      if (!plain.has(tag)) {
        plain.set(tag, forwardRef<unknown, Record<string, unknown>>(
          ({ initial: _i, animate: _a, exit: _e, transition: _t, layout: _l, layoutId: _li, variants: _v, ...props }, ref) =>
            createElement(tag, { ...props, ref }),
        ))
      }
      return plain.get(tag)
    },
  })
  return { ...actual, motion, AnimatePresence: ({ children }: { children: unknown }) => children, useReducedMotion: () => true }
})

const project: Project = { id: 'manor', name: 'Manor', color: '#8b5cf6', icon: 'folder', memoryScope: 'project', repoPaths: [] }
const chat: Chat = {
  id: 'thread',
  projectId: 'manor',
  kind: 'project',
  routineId: null,
  parentChatId: null,
  sideModel: null,
  sideEffort: null,
  memberIds: [],
  lastMessagePreview: null,
  title: 'Manor',
  createdAt: 1,
  lastMessageAt: 1,
  settledAt: null,
  agentIds: [],
  archivedAt: null,
  checkout: CURRENT_CHECKOUT,
}
const row: ProjectThreadRow = { project, chat, selected: false, unread: false, running: 0, waiting: false, lastActivityAt: 1 }

// The menu and the dialog portal into document.body; no DOM here, so a stub body is enough.
vi.stubGlobal('document', { body: {}, addEventListener: vi.fn(), removeEventListener: vi.fn() })

let tree: ReactTestRenderer
afterEach(() => act(() => tree.unmount()))

const textOf = (node: ReturnType<ReactTestRenderer['root']['find']>): string =>
  node.children.map((child) => (typeof child === 'string' ? child : textOf(child))).join('')

describe('the project row menu', () => {
  it('keeps Edit and Delete and offers Hide project thread', () => {
    const onEdit = vi.fn()
    const onDelete = vi.fn()
    const onRemove = vi.fn()
    act(() => {
      tree = create(
        <ProjectThreadsSection
          rows={[row]}
          available={[]}
          showSelection={false}
          onOpen={() => {}}
          onCreate={() => {}}
          onNewProject={() => {}}
          onEdit={onEdit}
          onDelete={onDelete}
          onRemove={onRemove}
        />,
      )
    })
    act(() => tree.root.findByType('li').props.onContextMenu({ preventDefault: () => {}, clientX: 10, clientY: 10 }))
    const items = tree.root.findAllByProps({ role: 'menuitem' })
    expect(items.map(textOf)).toEqual(['Edit project thread…', 'Hide project thread', 'Delete project thread…'])
    act(() => items[0]!.props.onClick())
    expect(onEdit).toHaveBeenCalledWith('manor')
    act(() => tree.root.findByType('li').props.onContextMenu({ preventDefault: () => {}, clientX: 10, clientY: 10 }))
    act(() => tree.root.findAllByProps({ role: 'menuitem' })[2]!.props.onClick())
    expect(onDelete).toHaveBeenCalledWith('manor')
    act(() => tree.root.findByType('li').props.onContextMenu({ preventDefault: () => {}, clientX: 10, clientY: 10 }))
    act(() => tree.root.findAllByProps({ role: 'menuitem' })[1]!.props.onClick())
    expect(onRemove).toHaveBeenCalledWith('manor')
  })
})

describe('the project dialog opened to delete', () => {
  it('asks straight away, naming the project and what goes with it', () => {
    act(() => {
      tree = create(
        <ProjectDialog
          mode="edit"
          draft={{ ...emptyDraft, name: 'Manor' }}
          onDraft={() => {}}
          dirs={{ listing: null, asking: false }}
          notice={null}
          busy={false}
          onListDirs={() => {}}
          onSubmit={() => {}}
          onCancel={() => {}}
          onClose={() => {}}
          onDelete={() => {}}
          initialArmed
        />,
      )
    })
    const confirm = tree.root.findByType(ConfirmModal)
    expect(confirm.props.title).toBe('Delete “Manor”?')
    expect(confirm.props.children).toBe('Its thread, Sessions and chats go with it.')
  })
})
