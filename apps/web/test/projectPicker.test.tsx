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

vi.stubGlobal('document', { body: {}, elementFromPoint: () => null })
vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {} })

const project = (id: string, name: string): Project => ({
  id, name, color: '#8b5cf6', icon: 'folder', memoryScope: 'project', repoPaths: [],
})
const manor = project('manor', 'Manor')
const general = project('general', 'General')
const projects = [manor, general, project('eurotrip', 'Eurotrip')]

describe('the rows the list shows', () => {
  it('lists the projects and never General, which is "no project"', () => {
    expect(pickerRows(projects, general, '').map((row) => row.id)).toEqual(['manor', 'eurotrip'])
    expect(pickerRows(projects, general, 'gen')).toEqual([])
  })

  it('lists everything when there is no General', () => {
    expect(pickerRows([manor], undefined, '').map((row) => row.id)).toEqual(['manor'])
  })
})

describe('the chip', () => {
  const render = (value: string, onChange = vi.fn()) => {
    let tree!: ReturnType<typeof create>
    act(() => {
      tree = create(<ProjectPicker projects={projects} value={value} general={general} onChange={onChange} onNewProject={() => {}} />)
    })
    return { tree, onChange }
  }

  it('reads Choose project, greyed, while the draft sits in General', () => {
    const { tree } = render('general')
    expect(JSON.stringify(tree.toJSON())).toContain('Choose project')
    expect(tree.root.findAllByType('button').filter((button) => button.props['aria-label'] === "Don't work in a project")).toHaveLength(0)
  })

  it('reads Create project and opens the form when General is the only project', () => {
    const onNewProject = vi.fn()
    let tree!: ReturnType<typeof create>
    act(() => {
      tree = create(<ProjectPicker projects={[general]} value="general" general={general} onChange={() => {}} onNewProject={onNewProject} />)
    })
    expect(JSON.stringify(tree.toJSON())).toContain('Create project')
    const chip = tree.root.findAllByType('button').find((button) => button.props['aria-label'] === 'Create project')!
    expect(chip.props['aria-haspopup']).toBeUndefined()
    act(() => chip.props.onClick())
    expect(onNewProject).toHaveBeenCalledOnce()
  })

  it('names the project and clears back to General from the mark', () => {
    const { tree, onChange } = render('manor')
    expect(JSON.stringify(tree.toJSON())).toContain('Manor')
    const clear = tree.root.findAllByType('button').find((button) => button.props['aria-label'] === "Don't work in a project")!
    act(() => clear.props.onClick())
    expect(onChange).toHaveBeenCalledWith('general')
  })
})
