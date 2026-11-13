import type { ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VaultState } from '../src/state'
import { KnowledgePanel } from '../src/components/knowledge/KnowledgePanel'
import { NoteDocument } from '../src/components/knowledge/NoteDocument'

vi.mock('react-dom', () => ({ createPortal: (children: unknown) => children }))
vi.mock('../src/components/knowledge/NoteDocument', () => ({ NoteDocument: () => null }))
vi.mock('../src/components/ui/Dialog', () => ({
  Dialog: ({ label, children }: { label: string; children: ReactNode }) => <div data-dialog={label}>{children}</div>,
}))
vi.mock('../src/components/ui/ContextMenu', () => ({
  ContextMenu: ({ items }: { items: { label: string; onSelect: () => void }[] }) => (
    <div data-menu>{items.map((item) => <button key={item.label} onClick={item.onSelect}>{item.label}</button>)}</div>
  ),
}))
vi.mock('../src/components/ui/FileTree', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/components/ui/FileTree')>()),
  FileTree: (props: { onFileMenu: (path: string, at: { x: number; y: number }) => void }) => (
    <button data-file-menu onClick={() => props.onFileMenu('inbox/today.md', { x: 0, y: 0 })} />
  ),
}))

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('window', {
    document: { visibilityState: 'hidden', addEventListener: vi.fn(), removeEventListener: vi.fn() },
    localStorage: { getItem: () => null, setItem: vi.fn() },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    setInterval: (...args: Parameters<typeof setInterval>) => setInterval(...args),
    clearInterval: (id: ReturnType<typeof setInterval>) => clearInterval(id),
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const vault: VaultState = {
  status: 'ready',
  name: 'Notes',
  root: null,
  files: ['inbox/today.md'],
  folders: ['inbox'],
  truncated: false,
  note: { path: 'inbox/today.md', result: { status: 'ready', content: 'one', revision: 'r1' } as never },
  write: null,
}

const dock = {
  width: 480,
  compact: false,
  expanded: false,
  overlay: false,
  revealed: true,
  resizing: false,
  resizeProps: {},
  onToggleExpanded: () => undefined,
  onClosePanel: () => undefined,
} as never

const variants = {
  // Beside a chat.
  dock: { dock },
  // In the workspace sidebar.
  sidebar: { sidebarSlot: {} as HTMLElement, sidebarActionSlot: {} as HTMLElement },
  // The phone page and the web fallback.
  page: {},
} as const

describe.each(Object.entries(variants))('Knowledge in the %s variant', (_name, extra) => {
  // The dock's chat keeps the open path; the others follow the last read.
  let remembered: string | null = 'inbox/today.md'
  beforeEach(() => { remembered = 'inbox/today.md' })
  const mount = (state: VaultState, handlers: { onCreateFolder?: () => boolean; onDelete?: (id: string, path: string) => boolean; onMove?: (id: string, path: string, folder: string, notify: boolean) => boolean } = {}) => (
    <KnowledgePanel
      vault={state}
      status="live"
      {...extra}
      selectedPath={remembered}
      onRememberPath={(next) => { remembered = next }}
      onList={() => undefined}
      onCreateFolder={handlers.onCreateFolder ?? (() => true)}
      onDelete={handlers.onDelete ?? (() => true)}
      onRename={() => true}
      onMove={handlers.onMove ?? (() => true)}
      onOpen={() => true}
      onSave={() => true}
      onClearWrite={() => undefined}
      onEditNote={() => true}
      onForgetNoteEdit={() => undefined}
      noteAiModel="claude-sonnet-5-5"
      onClose={() => undefined}
    />
  )
  const byLabel = (root: ReactTestRenderer, label: string) => root.root.find((node) => node.props.label === label && typeof node.props.onClick === 'function')
  const dialog = (root: ReactTestRenderer, label: string) => root.root.findAll((node) => node.props['data-dialog'] === label)

  it('offers the two header buttons and opens the folder dialog directly', () => {
    const onCreateFolder = vi.fn(() => true)
    let root!: ReactTestRenderer
    act(() => { root = create(mount(vault, { onCreateFolder })) })
    act(() => byLabel(root, 'New folder').props.onClick())
    expect(dialog(root, 'New folder').length).toBeGreaterThan(0)
    expect(root.root.findAll((node) => node.props['data-menu'] !== undefined)).toHaveLength(0)
    act(() => root.root.find((node) => node.type === 'input' && node.props.autoFocus === true).props.onChange({ target: { value: 'ideas' } }))
    act(() => root.root.findByType('form').props.onSubmit({ preventDefault: () => undefined }))
    expect(onCreateFolder).toHaveBeenCalledWith('ideas')
    expect(byLabel(root, 'New note in the inbox')).toBeDefined()
  })

  it('opens a new inbox note in its own editor', () => {
    let root!: ReactTestRenderer
    act(() => { root = create(mount(vault)) })
    act(() => byLabel(root, 'New note in the inbox').props.onClick())
    expect(root.root.findByType(NoteDocument).props.editor.path).toBe('inbox/untitled.md')
  })

  it('moves a note to the top level from its menu', () => {
    const onMove = vi.fn(() => true)
    let root!: ReactTestRenderer
    act(() => { root = create(mount(vault, { onMove })) })
    act(() => root.root.find((node) => node.props['data-file-menu'] !== undefined).props.onClick())
    act(() => root.root.find((node) => node.type === 'button' && node.props.children === 'Move to…').props.onClick())
    expect(dialog(root, 'Move note').length).toBeGreaterThan(0)
    act(() => root.root.find((node) => node.props.role === 'option' && node.props['data-folder'] === '').props.onClick())
    act(() => root.root.find((node) => node.type === 'button' && node.props.children === 'Move').props.onClick())
    expect(onMove).toHaveBeenCalledWith(expect.any(String), 'inbox/today.md', '', false)
  })

  it('confirms a delete and closes the open editor when it lands', () => {
    const onDelete = vi.fn(() => true)
    let root!: ReactTestRenderer
    act(() => { root = create(mount(vault, { onDelete })) })
    act(() => root.root.find((node) => node.props['data-file-menu'] !== undefined).props.onClick())
    act(() => root.root.find((node) => node.type === 'button' && node.props.children === 'Delete…').props.onClick())
    expect(dialog(root, 'Delete note').length).toBeGreaterThan(0)
    act(() => root.root.find((node) => node.type === 'button' && node.props.children === 'Move to trash').props.onClick())
    expect(onDelete).toHaveBeenCalledWith(expect.any(String), 'inbox/today.md')
    const landed = { ...vault, files: [], folders: [], note: null, deleted: { requestId: 'd1', path: 'inbox/today.md', kind: 'note' as const } }
    act(() => root.update(mount(landed)))
    // The chat's own path memory is cleared by the panel, then the parent re-renders.
    act(() => root.update(mount(landed)))
    expect(root.root.findAllByType(NoteDocument)).toHaveLength(0)
  })
})
