import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { matchRepoEntries, REPO_FILE_AUTOSAVE_MS, RepoFilesPanel } from './RepoFilesPanel'
import { repoTreeEntries, RepoFileTree } from './RepoFileTree'

vi.mock('./ui/TextEditor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./ui/TextEditor')>()),
  TextEditor: ({ path, text, onChange }: { path: string; text: string; onChange?: (text: string) => void }) => (
    <textarea aria-label={`Editor for ${path}`} value={text} onChange={(event) => onChange?.(event.target.value)} />
  ),
}))

// Motion's layout measuring needs a real page; the strip's own behaviour is covered on its own.
vi.mock('./ContentTabStrip', () => ({
  ContentTabStrip: ({ items, onClose, onNew }: { items: { id: string; name: string }[]; onClose: (id: string) => void; onNew: () => void }) => (
    <div>
      <button type="button" aria-label="New tab" onClick={onNew} />
      {items.map((item) => (
        <span key={item.id}>
          <span>{item.name}</span>
          <button type="button" aria-label={`Close ${item.name}`} onClick={() => onClose(item.id)} />
        </span>
      ))}
    </div>
  ),
}))

beforeEach(() => {
  vi.stubGlobal('document', {
    activeElement: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })
  vi.stubGlobal('window', {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
    clearTimeout: (...args: Parameters<typeof clearTimeout>) => clearTimeout(...args),
    matchMedia: vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const callbacks = {
  onToggleExpanded: () => {},
  onSelect: () => {},
  onClearSelection: () => {},
  onSave: () => true,
  onClearWrite: () => {},
  onClose: () => {},
}

describe('repository files panel', () => {
  it('keeps the resize handle available when Files floats over its chat', () => {
    let panel: ReactTestRenderer
    act(() => {
      panel = create(
        <RepoFilesPanel
          {...callbacks}
          selectedPath={null}
          canEdit
          width={574}
          expanded={false}
          overlay
          resizing={false}
          resizeProps={{ role: 'separator', 'aria-label': 'Resize files panel' }}
        />,
      )
    })

    const handle = panel!.root.findByProps({ 'aria-label': 'Resize files panel' })
    const shell = panel!.root.findByType('aside')
    expect(handle.props.className).not.toContain('hidden')
    expect(handle.props.className).not.toContain('max-[760px]:hidden')
    expect(shell.props.className).toContain('max-w-[max(calc(100%-375px),348px)]')
    act(() => panel!.unmount())
  })

  it('uses one column in a cramped pane and keeps the editor mounted when returning to the tree', () => {
    const content = (compact: boolean) => (
      <RepoFilesPanel
        {...callbacks}
        files={['note.md']}
        selectedPath="note.md"
        preview={{ path: 'note.md', result: { status: 'ready', content: 'Draft', revision: 'base' } }}
        canEdit
        width={574}
        compact={compact}
        expanded={false}
        resizing={false}
        resizeProps={{}}
      />
    )
    // Server rendering runs no effects, so this proves the first frame is compact.
    expect(renderToStaticMarkup(content(true))).not.toContain('grid-cols-[var(--files-tree-width)')
    let panel: ReactTestRenderer
    act(() => { panel = create(content(true)) })
    const editor = panel!.root.findByType('textarea')
    expect(panel!.root.findByProps({ 'aria-label': 'Show file tree' })).toBeDefined()
    act(() => panel!.root.findByProps({ 'aria-label': 'Show file tree' }).props.onClick())
    expect(panel!.root.findByProps({ 'aria-label': 'Hide file tree' })).toBeDefined()
    expect(panel!.root.findByType('textarea')).toBe(editor)
    expect(panel!.root.findByProps({ 'data-files-region': 'tree' }).props.className).toContain('grid')
    expect(panel!.root.findByProps({ 'data-files-region': 'viewer' }).props.className).toContain('hidden')
    act(() => panel!.root.findByType(RepoFileTree).props.onSelect('note.md'))
    expect(panel!.root.findByProps({ 'aria-label': 'Show file tree' })).toBeDefined()
    expect(panel!.root.findByType('textarea')).toBe(editor)
    expect(panel!.root.findByType(RepoFileTree).props.visible).toBe(false)
    expect(panel!.root.findByProps({ 'data-files-region': 'tree' }).props.className).toContain('hidden')
    expect(panel!.root.findByProps({ 'data-files-region': 'viewer' }).props.className).toContain('grid')
    act(() => panel!.update(content(false)))
    expect(panel!.root.findByProps({ 'aria-label': 'Hide file tree' })).toBeDefined()
    expect(panel!.root.findByType('textarea')).toBe(editor)
    act(() => panel!.unmount())
  })

  describe('tabs', () => {
    const KEY = 'manor:file-tabs:chat-1'
    let store: Map<string, string>
    beforeEach(() => {
      store = new Map()
      vi.stubGlobal('window', {
        ...window,
        localStorage: {
          getItem: (key: string) => store.get(key) ?? null,
          setItem: (key: string, value: string) => store.set(key, value),
          removeItem: (key: string) => store.delete(key),
        },
      })
    })
    const panel = (selectedPath: string | null, onSelect: (path: string) => void) => (
      <RepoFilesPanel
        {...callbacks}
        memoryKey="chat-1"
        files={['a.ts', 'b.ts', 'c.ts']}
        selectedPath={selectedPath}
        canEdit
        width={720}
        expanded={false}
        resizing={false}
        resizeProps={{}}
        onSelect={onSelect}
      />
    )

    it('restores the stored tabs, drops a file that is gone and opens the active one', () => {
      store.set(KEY, JSON.stringify({ tabs: [{ id: 't1', path: 'a.ts' }, { id: 't2', path: 'gone.ts' }, { id: 't3', path: 'b.ts' }], activeId: 't3' }))
      const onSelect = vi.fn()
      let view: ReactTestRenderer
      act(() => { view = create(panel(null, onSelect)) })
      expect(onSelect).toHaveBeenLastCalledWith('b.ts')
      expect(JSON.parse(store.get(KEY)!)).toEqual({ tabs: [{ id: 't1', path: 'a.ts' }, { id: 't3', path: 'b.ts' }], activeId: 't3' })
      act(() => view!.unmount())
    })

    it('never opens a restored active file that is gone, so a surviving tab keeps its file', () => {
      store.set(KEY, JSON.stringify({ tabs: [{ id: 't1', path: 'a.ts' }, { id: 't2', path: 'gone.ts' }], activeId: 't2' }))
      const onSelect = vi.fn()
      let view: ReactTestRenderer
      act(() => { view = create(panel(null, onSelect)) })
      expect(onSelect.mock.calls).toEqual([['a.ts']])
      act(() => view!.update(panel('a.ts', onSelect)))
      expect(JSON.parse(store.get(KEY)!)).toEqual({ tabs: [{ id: 't1', path: 'a.ts' }], activeId: 't1' })
      act(() => view!.unmount())
    })

    it('follows a file opened from outside into the active tab and opens a new tab from the tree', () => {
      const onSelect = vi.fn()
      let view: ReactTestRenderer
      act(() => { view = create(panel('a.ts', onSelect)) })
      act(() => view!.update(panel('b.ts', onSelect)))
      expect(JSON.parse(store.get(KEY)!).tabs.map((tab: { path: string }) => tab.path)).toEqual(['b.ts'])
      act(() => view!.root.findByType(RepoFileTree).props.onOpenInNewTab('c.ts'))
      expect(JSON.parse(store.get(KEY)!).tabs.map((tab: { path: string }) => tab.path)).toEqual(['b.ts', 'c.ts'])
      expect(onSelect).toHaveBeenLastCalledWith('c.ts')
      act(() => view!.unmount())
    })

    it('asks for a new tab\'s file once while the old file stays open in the editor', () => {
      const onSelect = vi.fn()
      let view: ReactTestRenderer
      act(() => {
        view = create(
          <RepoFilesPanel {...callbacks} memoryKey="chat-1" files={['a.ts', 'b.ts']} selectedPath="a.ts"
            preview={{ path: 'a.ts', result: { status: 'ready', content: 'export {}', revision: 'base' } }}
            canEdit width={720} expanded={false} resizing={false} resizeProps={{}} onSelect={onSelect} />,
        )
      })
      act(() => view!.root.findByType(RepoFileTree).props.onOpenInNewTab('b.ts'))
      expect(onSelect.mock.calls).toEqual([['b.ts']])
      act(() => view!.unmount())
    })

    it('fills a plus tab with the file picked in its finder', () => {
      const onSelect = vi.fn()
      const onClearSelection = vi.fn()
      let view: ReactTestRenderer
      const content = (selectedPath: string | null) => (
        <RepoFilesPanel {...callbacks} memoryKey="chat-1" files={['a.ts', 'b.ts', 'c.ts']} selectedPath={selectedPath}
          canEdit width={720} expanded={false} resizing={false} resizeProps={{}}
          onSelect={onSelect} onClearSelection={onClearSelection} />
      )
      act(() => { view = create(content('a.ts')) })
      act(() => view!.root.findByProps({ 'aria-label': 'New tab' }).props.onClick())
      expect(onClearSelection).toHaveBeenCalledOnce()
      act(() => view!.update(content(null)))
      act(() => view!.root.findByProps({ 'aria-label': 'Find a file' }).props.onChange({ target: { value: 'c' } }))
      act(() => view!.root.findByProps({ role: 'option', title: 'c.ts' }).props.onClick({ metaKey: false, ctrlKey: false }))
      expect(onSelect).toHaveBeenLastCalledWith('c.ts')
      act(() => view!.update(content('c.ts')))
      expect(JSON.parse(store.get(KEY)!).tabs.map((tab: { path: string }) => tab.path)).toEqual(['a.ts', 'c.ts'])

      // A finder that picks a file open in another tab closes and hands over to that tab.
      act(() => view!.root.findByProps({ 'aria-label': 'New tab' }).props.onClick())
      act(() => view!.update(content(null)))
      act(() => view!.root.findByProps({ 'aria-label': 'Find a file' }).props.onChange({ target: { value: 'a' } }))
      act(() => view!.root.findByProps({ role: 'option', title: 'a.ts' }).props.onClick({ metaKey: false, ctrlKey: false }))
      const stored = JSON.parse(store.get(KEY)!)
      expect(stored.tabs.map((tab: { path: string }) => tab.path)).toEqual(['a.ts', 'c.ts'])
      expect(stored.activeId).toBe(stored.tabs[0].id)
      expect(onSelect).toHaveBeenLastCalledWith('a.ts')
      act(() => view!.unmount())
    })
  })

  it('keeps the tree instead of an empty viewer when a fileless panel turns compact', () => {
    const content = (compact: boolean) => (
      <RepoFilesPanel
        {...callbacks}
        files={['note.md']}
        selectedPath={null}
        canEdit
        width={574}
        compact={compact}
        expanded={false}
        resizing={false}
        resizeProps={{}}
      />
    )
    let panel: ReactTestRenderer
    act(() => { panel = create(content(true)) })
    expect(panel!.root.findByProps({ 'data-files-region': 'tree' }).props.className).toContain('grid')
    expect(panel!.root.findByProps({ 'data-files-region': 'viewer' }).props.className).toContain('hidden')
    act(() => panel!.update(content(false)))
    expect(panel!.root.findByProps({ 'data-files-region': 'tree' }).props.className).toContain('grid')
    expect(panel!.root.findByProps({ 'data-files-region': 'viewer' }).props.className).toContain('grid')
    act(() => panel!.unmount())
  })

  it('shows the active file beside the tree toggle and clears only that file', () => {
    const onClearSelection = vi.fn()
    const onClose = vi.fn()
    let panel: ReactTestRenderer
    act(() => {
      panel = create(
        <RepoFilesPanel
          {...callbacks}
          files={['notes/brief.md']}
          selectedPath="notes/brief.md"
          canEdit
          width={360}
          compact
          expanded={false}
          resizing={false}
          resizeProps={{}}
          onClearSelection={onClearSelection}
          onClose={onClose}
        />,
      )
    })

    const toolbar = panel!.root.findByProps({ 'aria-label': 'File actions' })
    expect(toolbar.findByProps({ children: 'brief.md' })).toBeDefined()
    act(() => toolbar.findByProps({ 'aria-label': 'Close brief.md' }).props.onClick())
    expect(onClearSelection).toHaveBeenCalledOnce()
    expect(onClose).not.toHaveBeenCalled()

    act(() => panel!.unmount())
  })

  it('keeps the open file while it slides shut, though its close cleared the selection', () => {
    const content = (selectedPath: string | null, revealed: boolean) => (
      <RepoFilesPanel
        {...callbacks}
        files={['notes/brief.md']}
        selectedPath={selectedPath}
        canEdit
        width={360}
        compact
        expanded={false}
        overlay
        revealed={revealed}
        resizing={false}
        resizeProps={{}}
      />
    )
    const openFile = (panel: ReactTestRenderer) => panel.root.findAllByProps({ 'aria-label': 'File path' })
    let panel: ReactTestRenderer
    act(() => { panel = create(content('notes/brief.md', true)) })
    expect(openFile(panel!)).not.toHaveLength(0)

    // The region's close: revealed drops and the selection clears in the same update.
    act(() => panel!.update(content(null, false)))
    expect(openFile(panel!)).not.toHaveLength(0)
    expect(panel!.root.findByType('aside').props['data-open']).toBe(false)
    expect(panel!.root.findByType('aside').props.inert).toBe('')

    // Reopened during the slide, it shows what is selected now.
    act(() => panel!.update(content(null, true)))
    expect(openFile(panel!)).toHaveLength(0)
    expect(panel!.root.findByType('aside').props.inert).toBeUndefined()

    act(() => panel!.unmount())
  })

  it('only claims Save and close-tab while its thread is focused', () => {
    const props = {
      selectedPath: 'note.md', canEdit: true, width: 460, expanded: false,
      resizing: false, resizeProps: {}, ...callbacks,
    }
    let view: ReactTestRenderer
    act(() => { view = create(<RepoFilesPanel {...props} shortcutsActive={false} />) })
    const captures = () => vi.mocked(window.addEventListener).mock.calls.filter(
      ([name, , options]) => name === 'keydown' && typeof options === 'object' && options.capture,
    )
    expect(captures()).toHaveLength(0)
    act(() => view.update(<RepoFilesPanel {...props} shortcutsActive />))
    expect(captures()).toHaveLength(2)
    const handlers = captures().map(([, handler]) => handler)
    act(() => view.update(<RepoFilesPanel {...props} shortcutsActive={false} />))
    for (const handler of handlers) expect(window.removeEventListener).toHaveBeenCalledWith('keydown', handler, { capture: true })
    act(() => view.unmount())
  })

  it('puts the tree before the empty file surface when expanded', () => {
    const html = renderToStaticMarkup(
      <RepoFilesPanel
        files={['Manor/src/App.tsx']}
        selectedPath={null}
        canEdit
        width={320}
        expanded
        resizing={false}
        resizeProps={{}}
        {...callbacks}
      />,
    )

    expect(html.indexOf('aria-label="Repository files"')).toBeLessThan(html.indexOf('Open a file'))
    expect(html).toContain('aria-label="Search files"')
    expect(html).not.toContain('>Files</h2>')
  })

  it.each([false, true])('keeps the tree mounted beside a selected file when expanded is %s', (expanded) => {
    const html = renderToStaticMarkup(
      <RepoFilesPanel
        files={['Manor/src/App.tsx']}
        selectedPath="Manor/src/App.tsx"
        preview={{ path: 'Manor/src/App.tsx', result: { status: 'ready', content: 'export {}' } }}
        canEdit
        width={320}
        expanded={expanded}
        resizing={false}
        resizeProps={{}}
        {...callbacks}
      />,
    )

    expect(html).toContain('aria-label="Repository files"')
    expect(html).toContain('aria-label="File path"')
    expect(html).toContain('Manor')
    expect(html).toContain('src')
    expect(html).toContain('App.tsx')
    expect(html).toContain('dir="rtl"')
    expect(html).toContain('aria-label="Hide file tree"')
    expect(html).not.toContain('Back to files')
  })

  it('keeps the tree toggle and file actions together above the column headers', () => {
    let panel: ReactTestRenderer
    act(() => {
      panel = create(
        <RepoFilesPanel
          files={['Manor/src/App.tsx']}
          selectedPath="Manor/src/App.tsx"
          preview={{ path: 'Manor/src/App.tsx', result: { status: 'ready', content: 'export {}', revision: 'base' } }}
          apps={['cursor']}
          canEdit
          width={460}
          expanded={false}
          resizing={false}
          resizeProps={{}}
          {...callbacks}
          onOpenInApp={() => true}
        />,
      )
    })

    const toolbar = panel!.root.findByProps({ 'aria-label': 'File actions' })
    expect(toolbar.findByProps({ 'aria-label': 'Hide file tree' })).toBeDefined()
    expect(toolbar.findByProps({ 'aria-label': 'Save file' })).toBeDefined()
    expect(toolbar.findByProps({ 'aria-label': 'Open in Cursor' })).toBeDefined()
    expect(toolbar.findByProps({ 'aria-label': 'Expand files panel' })).toBeDefined()
    expect(toolbar.findByProps({ 'aria-label': 'Close files' })).toBeDefined()
    const openButton = toolbar.findByProps({ 'aria-label': 'Open in Cursor' })
    expect(openButton.props.className).toContain('text-[14px]')
    expect(openButton.props.className).not.toContain('[font:inherit]')
    expect(toolbar.findAllByProps({ 'aria-label': 'Search files' })).toHaveLength(0)
    expect(toolbar.findAllByProps({ 'aria-label': 'File path' })).toHaveLength(0)
    const search = panel!.root.findByProps({ 'aria-label': 'Search files' })
    expect(search).toBeDefined()
    expect(search.props.className).toContain('font-sans text-[12px]')
    expect(search.props.className).not.toContain('[font:inherit]')
    expect(search.parent?.props.className).toContain('w-full min-w-0 max-w-full')
    expect(panel!.root.findByProps({ 'aria-label': 'File path' })).toBeDefined()

    act(() => panel!.unmount())
  })

  it('collapses Open to one app menu button at the narrowest width', () => {
    const onOpenInApp = vi.fn(() => true)
    let panel: ReactTestRenderer
    act(() => {
      panel = create(
        <RepoFilesPanel
          {...callbacks}
          files={['note.md']}
          selectedPath="note.md"
          apps={['cursor', 'finder']}
          canEdit
          width={360}
          compact
          compactActions
          expanded={false}
          resizing={false}
          resizeProps={{}}
          onOpenInApp={onOpenInApp}
        />,
      )
    })

    expect(panel!.root.findAllByProps({ 'aria-label': 'Open in Cursor' })).toHaveLength(0)
    act(() => panel!.root.findByProps({ 'aria-label': 'Open file in application' }).props.onClick())
    act(() => panel!.root.findAllByProps({ role: 'menuitemradio' })[1]!.props.onClick())
    expect(onOpenInApp).toHaveBeenCalledWith('note.md', 'finder')

    act(() => panel!.unmount())
  })

  it('filters files by any case-insensitive part of their shown path', () => {
    const match = (files: string[], query: string) => matchRepoEntries(repoTreeEntries(files), query).map(({ sourcePath }) => sourcePath)
    expect(match(['Manor/src/App.tsx', 'Manor/README.md'], 'SRC/app')).toEqual(['Manor/src/App.tsx'])
    expect(match(['Manor/src/App.tsx'], '  ')).toEqual(['Manor/src/App.tsx'])
    expect(match(['Manor/src/App.tsx'], 'Manor')).toEqual([])
  })

  it('replaces the tree with flat filename and path search results', () => {
    let panel: ReactTestRenderer
    act(() => {
      panel = create(
        <RepoFilesPanel
          files={['Manor/src/App.tsx', 'Manor/README.md']}
          selectedPath={null}
          canEdit
          width={460}
          expanded={false}
          resizing={false}
          resizeProps={{}}
          {...callbacks}
        />,
      )
    })

    act(() => panel!.root.findByProps({ 'aria-label': 'Search files' }).props.onChange({ target: { value: 'app' } }))

    const results = panel!.root.findByProps({ 'aria-label': 'File search results' })
    expect(results).toBeDefined()
    // The host parent sits behind the RepoFileSearchResults component instance.
    expect(results.parent?.parent?.props.className).toContain('min-w-0')
    expect(panel!.root.findByProps({ 'data-files-region': 'tree' }).props.className).toContain('min-w-0')
    expect(panel!.root.findByProps({ 'data-files-region': 'tree' }).props.className).toContain('overflow-hidden')
    const result = panel!.root.findByProps({ role: 'option' })
    expect(result.props.className).toContain('font-sans text-[12px]')
    expect(result.props.className).toContain('h-8 w-full flex-none')
    expect(result.props.className).toContain('overflow-hidden')
    expect(result.props.className).not.toContain('[font:inherit]')
    // Only the matched part of the filename is emphasised; the rest stays plain.
    const highlighted = panel!.root.findByProps({ children: 'App' })
    expect(highlighted.props.className).toContain('font-semibold')
    expect(highlighted.parent?.props.className).toContain('max-w-[50%]')
    expect(highlighted.parent?.props.className).toContain('truncate')
    expect(highlighted.parent?.props.className).not.toContain('font-medium')
    expect(highlighted.parent?.props.children[1]).toBe('.tsx')
    expect(panel!.root.findByProps({ children: 'src' }).props.className).toContain('flex-1 truncate')
    expect(panel!.root.findAllByProps({ children: 'Open a file' })).toHaveLength(0)

    act(() => panel!.unmount())
  })

  it('switches Markdown between its source and reading views', () => {
    const props = {
      files: ['Manor/README.md'],
      selectedPath: 'Manor/README.md',
      preview: {
        path: 'Manor/README.md',
        result: { status: 'ready' as const, content: '# Manor', revision: 'base' },
      },
      canEdit: true,
      width: 460,
      expanded: false,
      resizing: false,
      resizeProps: {},
      ...callbacks,
    }
    let panel: ReactTestRenderer
    act(() => {
      panel = create(<RepoFilesPanel {...props} />)
    })

    const editorShell = () => panel!.root.findAllByType('div').find((node) =>
      node.props.className?.includes('overflow-y-auto bg-stage px-5 py-4')
      && node.findAllByProps({ 'aria-label': 'Editor for Manor/README.md' }).length > 0,
    )!
    expect(editorShell().props.className).toContain('hidden')
    expect(panel!.root.findAllByType('article')).toHaveLength(1)
    act(() => panel!.root.findByProps({ 'aria-label': 'Edit Markdown' }).props.onClick())
    expect(editorShell().props.className).not.toContain('hidden')
    expect(panel!.root.findAllByType('article')).toHaveLength(0)
    act(() => panel!.root.findByProps({ 'aria-label': 'Read Markdown' }).props.onClick())
    expect(editorShell().props.className).toContain('hidden')
    expect(panel!.root.findAllByType('article')).toHaveLength(1)

    act(() => panel!.unmount())
  })

  it('selects another host app without opening it until the primary action is pressed', () => {
    const onOpenInApp = vi.fn(() => true)
    const props = {
      files: ['Manor/src/App.tsx'],
      selectedPath: 'Manor/src/App.tsx',
      preview: {
        path: 'Manor/src/App.tsx',
        result: { status: 'ready' as const, content: 'export {}', revision: 'base' },
      },
      apps: ['cursor', 'finder'] as const,
      canEdit: true,
      width: 460,
      expanded: false,
      resizing: false,
      resizeProps: {},
      ...callbacks,
      onOpenInApp,
    }
    let panel: ReactTestRenderer
    act(() => {
      panel = create(<RepoFilesPanel {...props} />)
    })

    act(() => panel!.root.findByProps({ 'aria-label': 'Choose application' }).props.onClick())
    act(() => panel!.root.findAllByProps({ role: 'menuitemradio' })[1]!.props.onClick())
    expect(onOpenInApp).not.toHaveBeenCalled()
    expect(panel!.root.findByProps({ title: 'Open in Finder' })).toBeDefined()
    act(() => panel!.root.findByProps({ title: 'Open in Finder' }).props.onClick())
    expect(onOpenInApp).toHaveBeenCalledWith('Manor/src/App.tsx', 'finder')

    act(() => panel!.unmount())
  })

  it('opens safe text files directly and autosaves after the idle beat', () => {
    vi.useFakeTimers()
    const onSave = vi.fn(() => true)
    const props = {
      files: ['Manor/src/App.tsx'],
      selectedPath: 'Manor/src/App.tsx',
      preview: {
        path: 'Manor/src/App.tsx',
        result: { status: 'ready' as const, content: 'export {}', revision: 'base' },
      },
      canEdit: true,
      width: 460,
      expanded: false,
      resizing: false,
      resizeProps: {},
      ...callbacks,
      onSave,
    }
    let panel: ReactTestRenderer
    act(() => {
      panel = create(<RepoFilesPanel {...props} />)
    })

    const editor = panel!.root.findByProps({ 'aria-label': 'Editor for Manor/src/App.tsx' })
    act(() => editor.props.onChange({ target: { value: 'export const ready = true' } }))
    expect(onSave).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(REPO_FILE_AUTOSAVE_MS)
    })
    expect(onSave).toHaveBeenCalledWith('Manor/src/App.tsx', 'export const ready = true', 'base')
    expect(panel!.root.findAllByProps({ children: 'Edit' })).toHaveLength(0)

    act(() => panel!.unmount())
  })

  it('saves a dirty file before opening it in the preferred host app', () => {
    vi.useFakeTimers()
    const onSave = vi.fn(() => true)
    const onOpenInApp = vi.fn(() => true)
    const props = {
      files: ['Manor/src/App.tsx'],
      selectedPath: 'Manor/src/App.tsx',
      preview: {
        path: 'Manor/src/App.tsx',
        result: { status: 'ready' as const, content: 'export {}', revision: 'base' },
      },
      apps: ['cursor', 'finder'] as const,
      canEdit: true,
      width: 460,
      expanded: false,
      resizing: false,
      resizeProps: {},
      ...callbacks,
      onSave,
      onOpenInApp,
    }
    let panel: ReactTestRenderer
    act(() => {
      panel = create(<RepoFilesPanel {...props} />)
    })

    act(() => panel!.root.findByProps({ 'aria-label': 'Choose application' }).props.onClick())
    expect(panel!.root.findAllByProps({ role: 'menuitemradio' })).toHaveLength(2)

    act(() => {
      panel!.root.findByProps({ 'aria-label': 'Editor for Manor/src/App.tsx' }).props.onChange({
        target: { value: 'export const ready = true' },
      })
    })
    act(() => panel!.root.findByProps({ title: 'Open in Cursor' }).props.onClick())
    expect(onSave).toHaveBeenCalledWith('Manor/src/App.tsx', 'export const ready = true', 'base')
    expect(onOpenInApp).not.toHaveBeenCalled()

    act(() => {
      panel!.update(
        <RepoFilesPanel
          {...props}
          write={{ path: 'Manor/src/App.tsx', result: { status: 'saved', revision: 'saved' } }}
        />,
      )
    })
    expect(onOpenInApp).toHaveBeenCalledWith('Manor/src/App.tsx', 'cursor')

    act(() => panel!.unmount())
  })

  it('waits for an autosave already in flight before closing', () => {
    vi.useFakeTimers()
    const onSave = vi.fn(() => true)
    const onClose = vi.fn()
    const props = {
      files: ['Manor/src/App.tsx'],
      selectedPath: 'Manor/src/App.tsx',
      preview: {
        path: 'Manor/src/App.tsx',
        result: { status: 'ready' as const, content: 'export {}', revision: 'base' },
      },
      canEdit: true,
      width: 460,
      expanded: false,
      resizing: false,
      resizeProps: {},
      ...callbacks,
      onSave,
      onClose,
    }
    let panel: ReactTestRenderer
    act(() => {
      panel = create(<RepoFilesPanel {...props} />)
    })
    act(() => {
      panel!.root.findByProps({ 'aria-label': 'Editor for Manor/src/App.tsx' }).props.onChange({
        target: { value: 'export const ready = true' },
      })
    })
    act(() => {
      vi.advanceTimersByTime(REPO_FILE_AUTOSAVE_MS)
    })
    expect(onSave).toHaveBeenCalledOnce()
    act(() => {
      panel!.update(<RepoFilesPanel {...props} write={{ path: 'Manor/src/App.tsx', result: null }} />)
    })
    act(() => panel!.root.findByProps({ 'aria-label': 'Close files' }).props.onClick())
    expect(onClose).not.toHaveBeenCalled()

    act(() => {
      panel!.update(
        <RepoFilesPanel
          {...props}
          write={{ path: 'Manor/src/App.tsx', result: { status: 'saved', revision: 'saved' } }}
        />,
      )
    })
    expect(onClose).toHaveBeenCalledOnce()

    act(() => panel!.unmount())
  })

  it('cancels a pending external open when its save is rejected', () => {
    const onSave = vi.fn(() => true)
    const onOpenInApp = vi.fn(() => true)
    const onClearWrite = vi.fn()
    const props = {
      files: ['Manor/src/App.tsx'],
      selectedPath: 'Manor/src/App.tsx',
      preview: {
        path: 'Manor/src/App.tsx',
        result: { status: 'ready' as const, content: 'export {}', revision: 'base' },
      },
      apps: ['cursor'] as const,
      canEdit: true,
      width: 460,
      expanded: false,
      resizing: false,
      resizeProps: {},
      ...callbacks,
      onSave,
      onOpenInApp,
      onClearWrite,
    }
    let panel: ReactTestRenderer
    act(() => {
      panel = create(<RepoFilesPanel {...props} />)
    })
    act(() => {
      panel!.root.findByProps({ 'aria-label': 'Editor for Manor/src/App.tsx' }).props.onChange({
        target: { value: 'export const ready = true' },
      })
    })
    act(() => panel!.root.findByProps({ title: 'Open in Cursor' }).props.onClick())
    act(() => {
      panel!.update(
        <RepoFilesPanel
          {...props}
          write={{ path: 'Manor/src/App.tsx', result: { status: 'rejected', message: 'Save failed.' } }}
        />,
      )
    })
    act(() => {
      panel!.root.findAllByType('button').find((button) => button.children.includes('Dismiss'))!.props.onClick()
      panel!.update(<RepoFilesPanel {...props} />)
    })
    act(() => {
      panel!.root.findByProps({ 'aria-label': 'Save file' }).props.onClick()
      panel!.update(
        <RepoFilesPanel
          {...props}
          write={{ path: 'Manor/src/App.tsx', result: { status: 'saved', revision: 'saved' } }}
        />,
      )
    })

    expect(onSave).toHaveBeenCalledTimes(2)
    expect(onClearWrite).toHaveBeenCalledOnce()
    expect(onOpenInApp).not.toHaveBeenCalled()

    act(() => panel!.unmount())
  })
})
