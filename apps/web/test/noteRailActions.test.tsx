import type { ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VaultState } from '../src/state'
import { deleteQuestion, filterNotes, FOLDER_OPEN_DELAY_MS, NoteRail } from '../src/components/knowledge/NoteRail'
import type { TreeDrag } from '../src/components/ui/FileTree'

vi.mock('react-dom', () => ({ createPortal: (children: unknown) => children }))
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
  FileTree: (props: { drag: TreeDrag; onFolderMenu: (path: string, at: { x: number; y: number }) => void; onFileMenu: (path: string, at: { x: number; y: number }) => void }) => (
    <div data-drag={props.drag}>
      <button data-folder-menu onClick={() => props.onFolderMenu('research', { x: 0, y: 0 })} />
      <button data-file-menu onClick={() => props.onFileMenu('inbox/today.md', { x: 0, y: 0 })} />
    </div>
  ),
}))

const files = ['inbox/today.md', 'research/a.md', 'research/wiki/b.md', 'research/wiki/c.md']
const folders = ['inbox', 'research', 'research/wiki']

type MoveHandler = (requestId: string, path: string, folder: string, notify: boolean) => boolean
function rail(
  deletion: VaultState['deletion'],
  onDelete: (requestId: string, path: string) => boolean,
  onCreate: () => void = () => undefined,
  moving: { move?: VaultState['move']; onMove?: MoveHandler; onToggleFolder?: (path: string) => void } = {},
) {
  return (
    <NoteRail
      vaultName="Notes"
      folders={folders}
      previews={{}}
      folderWrite={undefined}
      deletion={deletion}
      trash="/data/trash/knowledge"
      onDelete={onDelete}
      onCreateAt={() => undefined}
      onRename={() => undefined}
      move={moving.move}
      onMove={moving.onMove ?? (() => true)}
      onCreateFolder={() => true}
      onFolderCreated={() => undefined}
      files={files}
      truncated={false}
      filter=""
      onFilter={() => undefined}
      tree={filterNotes(files, '', folders).tree}
      openFolders={new Set()}
      onToggleFolder={moving.onToggleFolder ?? (() => undefined)}
      selectedPath={null}
      dirtyPath={null}
      onSelect={() => undefined}
      onCreate={onCreate}
      canCreate
      creating={false}
      filterRef={{ current: null }}
      variant="page"
    />
  )
}

const labels = (root: ReactTestRenderer) =>
  root.root.findAll((node) => node.type === 'div' && node.props['data-menu'] !== undefined)
    .flatMap((menu) => menu.findAllByType('button').map((button) => button.props.children as string))
const press = (root: ReactTestRenderer, label: string) =>
  act(() => { root.root.find((node) => node.type === 'button' && node.props.children === label).props.onClick() })
const text = (root: ReactTestRenderer) => JSON.stringify(root.toJSON())

describe('Knowledge tree actions', () => {
  it('offers new note and folder at the root and in a folder, and delete beside rename', () => {
    let root!: ReactTestRenderer
    act(() => { root = create(rail(undefined, () => true)) })
    // The empty area of the tree is the way to a named top level note.
    act(() => { root.root.find((node) => typeof node.props.onContextMenu === 'function').props.onContextMenu({ defaultPrevented: false, preventDefault: () => undefined, clientX: 0, clientY: 0 }) })
    expect(labels(root)).toEqual(['New folder…', 'New note…'])
    act(() => { root.root.find((node) => node.props['data-folder-menu'] !== undefined).props.onClick() })
    expect(labels(root)).toEqual(['New note…', 'New folder…', 'Move to…', 'Delete…'])
    act(() => { root.root.find((node) => node.props['data-file-menu'] !== undefined).props.onClick() })
    expect(labels(root)).toEqual(['Rename', 'Move to…', 'Delete…'])
  })

  it('makes the inbox note with one click, with no menu', () => {
    const made = vi.fn()
    let root!: ReactTestRenderer
    act(() => { root = create(rail(undefined, () => true, made)) })
    act(() => { root.root.find((node) => node.props.label === 'New note in the inbox').props.onClick() })
    expect(made).toHaveBeenCalledTimes(1)
    expect(labels(root)).toEqual([])
  })

  it('opens the top level folder dialog with one click, with no menu', () => {
    let root!: ReactTestRenderer
    act(() => { root = create(rail(undefined, () => true)) })
    act(() => { root.root.find((node) => node.props.label === 'New folder').props.onClick() })
    expect(labels(root)).toEqual([])
    expect(text(root)).toContain('At the top of Notes')
    expect(root.root.findAll((node) => node.props['data-dialog'] === 'New folder').length).toBeGreaterThan(0)
  })

  it('asks before a folder delete with its count and the trash, then closes when the delete lands', () => {
    const asked: string[] = []
    let sent = ''
    const onDelete = (requestId: string, path: string) => { asked.push(path); sent = requestId; return true }
    let root!: ReactTestRenderer
    act(() => { root = create(rail(undefined, onDelete)) })
    act(() => { root.root.find((node) => node.props['data-folder-menu'] !== undefined).props.onClick() })
    press(root, 'Delete…')
    expect(text(root)).toContain('with 3 notes and 1 folder')
    expect(text(root)).toContain('/data/trash/knowledge')
    press(root, 'Move to trash')
    expect(asked).toEqual(['research'])
    expect(text(root)).toContain('Moving…')
    act(() => { root.update(rail({ requestId: sent, path: 'research', result: { status: 'deleted', kind: 'folder', trashPath: '/data/trash/knowledge/x/research' } }, onDelete)) })
    expect(text(root)).not.toContain('Move to trash')
    expect(text(root)).not.toContain('Moving…')
  })

  it('words the confirm for a note, an empty folder and an older server', () => {
    expect(deleteQuestion('inbox/today.md', 'file', files, folders, '/t')).toBe('Delete “today.md”? It moves to Manor\'s trash at /t, so you can get it back from there.')
    expect(deleteQuestion('research/wiki', 'folder', files, folders, null)).toContain('with 2 notes? It moves to Manor\'s trash folder')
    expect(deleteQuestion('empty', 'folder', files, folders, '/t')).toContain('with no notes?')
  })

  it('says at least when the listing is capped', () => {
    expect(deleteQuestion('research/wiki', 'folder', files, folders, '/t', true)).toContain('with at least 2 notes?')
  })
})

describe('Moving notes in the Knowledge tree', () => {
  const options = (root: ReactTestRenderer) => root.root.findAll((node) => node.type === 'div' && node.props.role === 'option')
  const option = (root: ReactTestRenderer, folder: string) => root.root.find((node) => node.type === 'div' && node.props.role === 'option' && node.props['data-folder'] === folder)

  it('lists every folder under the top level with the current one marked, and sends the move', () => {
    const onMove = vi.fn<MoveHandler>(() => true)
    let root!: ReactTestRenderer
    act(() => { root = create(rail(undefined, () => true, undefined, { onMove })) })
    act(() => { root.root.find((node) => node.props['data-file-menu'] !== undefined).props.onClick() })
    press(root, 'Move to…')
    expect(root.root.findAll((node) => node.props['data-dialog'] === 'Move note').length).toBeGreaterThan(0)
    expect(text(root)).toContain('Choose a folder for “today”.')
    expect(options(root).map((node) => node.props['data-folder'])).toEqual(['', 'inbox', 'research', 'research/wiki'])
    expect(option(root, 'inbox').props['aria-disabled']).toBe(true)
    expect(option(root, 'research/wiki').props.style).toEqual({ paddingLeft: 8 + 2 * 16 })
    const move = () => root.root.find((node) => node.type === 'button' && node.props.children === 'Move')
    expect(move().props.disabled).toBe(true)
    // The current folder cannot be picked, so Move stays off.
    act(() => option(root, 'inbox').props.onClick())
    expect(move().props.disabled).toBe(true)
    // Arrows skip the current folder: down from nothing is the top level, then research.
    const list = root.root.find((node) => node.type === 'div' && node.props.role === 'listbox')
    const key = (name: string) => act(() => list.props.onKeyDown({ key: name, preventDefault: () => undefined }))
    key('ArrowDown')
    key('ArrowDown')
    expect(option(root, 'research').props['aria-selected']).toBe(true)
    key('Enter')
    expect(onMove).toHaveBeenCalledWith(expect.any(String), 'inbox/today.md', 'research', false)
    expect(text(root)).toContain('Moving…')
  })

  it('keeps a refusal inside the dialog and leaves it open', () => {
    let sent = ''
    const onMove: MoveHandler = (requestId) => { sent = requestId; return true }
    let root!: ReactTestRenderer
    act(() => { root = create(rail(undefined, () => true, undefined, { onMove })) })
    act(() => { root.root.find((node) => node.props['data-file-menu'] !== undefined).props.onClick() })
    press(root, 'Move to…')
    act(() => option(root, '').props.onClick())
    press(root, 'Move')
    const clash = 'The top level already has a note or folder named “today.md”. Rename one of them first.'
    act(() => { root.update(rail(undefined, () => true, undefined, { onMove, move: { requestId: sent, path: 'inbox/today.md', folder: '', notify: false, result: { status: 'rejected', message: clash } } })) })
    expect(text(root)).toContain(clash)
    expect(root.root.findAll((node) => node.props['data-dialog'] === 'Move note').length).toBeGreaterThan(0)
    expect(root.root.find((node) => node.type === 'button' && node.props.children === 'Move').props.disabled).toBe(false)
  })

  it('keeps the keys in the list while a move is out and after its refusal', () => {
    let sent = ''
    const onMove: MoveHandler = (requestId) => { sent = requestId; return true }
    // The Move button disables itself while the move is out; focus must not fall to the page with it.
    const listbox = { focus: vi.fn(), ownerDocument: { activeElement: null }, querySelectorAll: () => [] }
    const createNodeMock = (element: { props: Record<string, unknown> }) =>
      element.props['role'] === 'listbox' ? listbox : { focus: () => undefined, querySelectorAll: () => [] }
    let root!: ReactTestRenderer
    act(() => { root = create(rail(undefined, () => true, undefined, { onMove }), { createNodeMock }) })
    act(() => { root.root.find((node) => node.props['data-file-menu'] !== undefined).props.onClick() })
    press(root, 'Move to…')
    act(() => option(root, '').props.onClick())
    listbox.focus.mockClear()
    press(root, 'Move')
    expect(listbox.focus).toHaveBeenCalledTimes(1)
    listbox.focus.mockClear()
    const clash = 'The top level already has a note or folder named “today.md”. Rename one of them first.'
    act(() => { root.update(rail(undefined, () => true, undefined, { onMove, move: { requestId: sent, path: 'inbox/today.md', folder: '', notify: false, result: { status: 'rejected', message: clash } } })) })
    expect(listbox.focus).toHaveBeenCalledTimes(1)
    const list = root.root.find((node) => node.type === 'div' && node.props.role === 'listbox')
    expect(list.props['aria-activedescendant']).toBe(option(root, '').props.id)
    expect(root.root.find((node) => node.props.role === 'alert').props.children).toBe(clash)
  })

  it('blocks a folder from moving into itself or its own folders', () => {
    let root!: ReactTestRenderer
    act(() => { root = create(rail(undefined, () => true)) })
    act(() => { root.root.find((node) => node.props['data-folder-menu'] !== undefined).props.onClick() })
    press(root, 'Move to…')
    expect(root.root.findAll((node) => node.props['data-dialog'] === 'Move folder').length).toBeGreaterThan(0)
    expect(options(root).filter((node) => node.props['aria-disabled'] === true).map((node) => node.props['data-folder'])).toEqual(['', 'research', 'research/wiki'])
  })

  describe('drag and drop', () => {
    const ghost = { textContent: '', className: '', remove: vi.fn() }
    beforeEach(() => {
      vi.useFakeTimers()
      vi.stubGlobal('window', {
        document: { createElement: () => ghost, body: { append: vi.fn() } },
        setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
        clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
      })
    })
    afterEach(() => {
      vi.unstubAllGlobals()
      vi.useRealTimers()
    })
    const event = () => ({
      dataTransfer: { types: ['application/x-manor-vault-entry'], setData: vi.fn(), setDragImage: vi.fn(), effectAllowed: '', dropEffect: '' },
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      currentTarget: { contains: () => false },
      relatedTarget: null,
    }) as never
    const drag = (root: ReactTestRenderer) => root.root.find((node) => node.props['data-drag'] !== undefined).props['data-drag'] as TreeDrag

    it('moves a note dropped on a folder, sends nothing for its own folder, and opens a closed folder after a rest', () => {
      const onMove = vi.fn<MoveHandler>(() => true)
      const onToggleFolder = vi.fn()
      let root!: ReactTestRenderer
      act(() => { root = create(rail(undefined, () => true, undefined, { onMove, onToggleFolder })) })
      act(() => drag(root).start('inbox/today.md', true, event()))
      expect(ghost.textContent).toBe('today')
      expect(drag(root).source).toBe('inbox/today.md')

      // Its own folder: no highlight and no drop.
      const own = event()
      act(() => drag(root).overFolder('inbox', true, own))
      expect((own as { preventDefault: () => void }).preventDefault).not.toHaveBeenCalled()
      expect(drag(root).target).toBeNull()
      act(() => drag(root).dropOnFolder('inbox', event()))
      expect(onMove).not.toHaveBeenCalled()

      act(() => drag(root).start('inbox/today.md', true, event()))
      const over = event()
      act(() => drag(root).overFolder('research', false, over))
      expect((over as { preventDefault: () => void }).preventDefault).toHaveBeenCalled()
      expect(drag(root).target).toBe('research')
      act(() => { vi.advanceTimersByTime(FOLDER_OPEN_DELAY_MS) })
      expect(onToggleFolder).toHaveBeenCalledWith('research')
      act(() => drag(root).dropOnFolder('research', event()))
      expect(onMove).toHaveBeenCalledWith(expect.any(String), 'inbox/today.md', 'research', true)
      expect(drag(root).source).toBeNull()
      expect(drag(root).target).toBeNull()
    })
  })
})
