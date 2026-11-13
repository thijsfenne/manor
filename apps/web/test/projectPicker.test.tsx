import type { Project } from '@manor/contracts'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { pickerRows, ProjectPicker } from '../src/components/projects/ProjectPicker'

// The test renderer has no DOM: the (closed) list renders in place.
vi.mock('react-dom', async (original) => ({
  ...(await original<typeof import('react-dom')>()),
  createPortal: (children: unknown) => children,
}))
vi.mock('../src/components/ui/useDismiss', () => ({ useDismiss: () => {} }))
// No layout to measure: the open list lands at a fixed spot.
vi.mock('../src/components/ui/usePopupPlacement', () => ({
  usePopupPlacement: ({ open }: { open: boolean }) => (open ? { left: 0, top: 0, width: 300, maxHeight: 320 } : null),
}))

vi.stubGlobal('document', { body: {}, elementFromPoint: () => null })
vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {} })

const project = (id: string, name: string): Project => ({
  id, name, color: '#8b5cf6', icon: 'folder', memoryScope: 'project', repoPaths: [],
})
// A project has a thread; a folder is a row without one (2026-11-13).
const manor = { ...project('manor', 'Manor'), threadChatId: 'thread-manor' }
const folder = { ...project('folder', 'Downloads'), repoPaths: ['/Users/me/Downloads'] }
const general = project('general', 'General')
const projects = [manor, general, project('eurotrip', 'Eurotrip')]

describe('the rows the list shows', () => {
  it('lists the projects and never General, which is "no project"', () => {
    expect(pickerRows(projects, general, '').map((row) => row.id)).toEqual(['manor', 'eurotrip'])
    expect(pickerRows(projects, general, 'gen')).toEqual([])
  })

  it('leaves a removed folder off the list', () => {
    expect(pickerRows([manor, general, folder, { ...folder, id: 'gone', unlisted: true }], general, '').map((row) => row.id)).toEqual(['manor', 'folder'])
  })

  it('lists everything when there is no General', () => {
    expect(pickerRows([manor], undefined, '').map((row) => row.id)).toEqual(['manor'])
  })
})

/** The list's footer row that reads `text`. */
const labelled = (tree: ReturnType<typeof create>, text: string) =>
  tree.root.findAllByType('button').find((button) => button.findAllByType('span').some((span) => span.props.children === text))

describe('the chip', () => {
  const render = (value: string, onChange = vi.fn()) => {
    let tree!: ReturnType<typeof create>
    act(() => {
      tree = create(<ProjectPicker projects={projects} value={value} general={general} onChange={onChange} onAddFolder={() => {}} />)
    })
    return { tree, onChange }
  }

  it('reads Choose project, greyed, while the draft sits in General', () => {
    const { tree } = render('general')
    expect(JSON.stringify(tree.toJSON())).toContain('Choose project')
    expect(tree.root.findAllByType('button').filter((button) => button.props['aria-label'] === "Don't work in a project")).toHaveLength(0)
  })

  it('reads Add folder and goes straight to the folder chooser on an empty install', () => {
    const onAddFolder = vi.fn()
    let tree!: ReturnType<typeof create>
    act(() => {
      tree = create(<ProjectPicker projects={[general]} value="general" general={general} onChange={() => {}} onAddFolder={onAddFolder} />)
    })
    expect(JSON.stringify(tree.toJSON())).toContain('Add folder')
    expect(JSON.stringify(tree.toJSON())).not.toContain('Create project')
    const chip = tree.root.findAllByType('button').find((button) => button.props['aria-label'] === 'Add folder')!
    expect(chip.props['aria-haspopup']).toBeUndefined()
    act(() => chip.props.onClick())
    expect(onAddFolder).toHaveBeenCalledOnce()
  })

  it('opens the list once a folder exists, with Add folder as its last row and no New project', () => {
    const onAddFolder = vi.fn()
    let tree!: ReturnType<typeof create>
    act(() => {
      tree = create(<ProjectPicker projects={[general, folder]} value="general" general={general} onChange={() => {}} onAddFolder={onAddFolder} />)
    })
    const chip = tree.root.findAllByType('button').find((button) => button.props['aria-label'] === 'Choose project')!
    expect(chip.props['aria-haspopup']).toBe('listbox')
    act(() => chip.props.onClick())
    expect(onAddFolder).not.toHaveBeenCalled()
    expect(labelled(tree, 'New project')).toBeUndefined()
    act(() => labelled(tree, 'Add folder')!.props.onClick())
    expect(onAddFolder).toHaveBeenCalledOnce()
  })

  it('offers remove on a folder row only, never on a project', () => {
    const onRemoveFolder = vi.fn()
    let tree!: ReturnType<typeof create>
    act(() => {
      tree = create(<ProjectPicker projects={[manor, general, folder]} value="general" general={general} onChange={() => {}} onAddFolder={() => {}} onRemoveFolder={onRemoveFolder} />)
    })
    act(() => tree.root.findAllByType('button').find((button) => button.props['aria-label'] === 'Choose project')!.props.onClick())
    const removes = tree.root.findAllByType('button').filter((button) => String(button.props['aria-label']).startsWith('Remove '))
    expect(removes.map((button) => button.props['aria-label'])).toEqual(['Remove Downloads from this list'])
    act(() => removes[0]!.props.onClick())
    expect(onRemoveFolder).toHaveBeenCalledWith('folder')
  })

  it('names the project and clears back to General from the mark', () => {
    const { tree, onChange } = render('manor')
    expect(JSON.stringify(tree.toJSON())).toContain('Manor')
    const clear = tree.root.findAllByType('button').find((button) => button.props['aria-label'] === "Don't work in a project")!
    act(() => clear.props.onClick())
    expect(onChange).toHaveBeenCalledWith('general')
  })
})
