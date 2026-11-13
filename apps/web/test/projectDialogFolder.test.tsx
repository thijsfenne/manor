import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptyDraft, ProjectDialog, type ProjectDraft } from '../src/components/projects/ProjectDialog'

vi.mock('../src/components/Modal', () => ({
  Modal: ({ children }: { children: unknown }) => children,
  ModalFooter: ({ children }: { children: unknown }) => children,
}))
vi.mock('../src/components/projects/ProjectIdentityField', () => ({ ProjectIdentityField: () => null }))
// The dropdown needs a DOM; the form only has to place it.
vi.mock('../src/components/ui/Select', () => ({ Select: ({ label, value }: { label: string; value: string }) => `select:${label}=${value}` }))

let tree: ReactTestRenderer | undefined
afterEach(() => {
  act(() => tree?.unmount())
  tree = undefined
  vi.unstubAllGlobals()
})

function dialog(draft: ProjectDraft = emptyDraft) {
  const onDraft = vi.fn()
  const onListDirs = vi.fn()
  act(() => {
    tree = create(
      <ProjectDialog
        mode="create"
        draft={draft}
        onDraft={onDraft}
        dirs={{ listing: null, asking: false }}
        notice={null}
        busy={false}
        onListDirs={onListDirs}
        onSubmit={() => {}}
        onCancel={() => {}}
        onClose={() => {}}
      />,
    )
  })
  return { onDraft, onListDirs }
}

const button = (label: string) =>
  tree!.root.findAllByType('button').find((node) => node.children.includes(label))

describe('linking a folder', () => {
  it('on the desktop shell adds the path the Finder dialog returns', async () => {
    const chooseFolder = vi.fn(async () => '/Users/sam/Notes')
    vi.stubGlobal('window', { manorDesktop: { chooseFolder } })
    const { onDraft, onListDirs } = dialog()

    await act(async () => button('Add a folder…')!.props.onClick())

    expect(chooseFolder).toHaveBeenCalledTimes(1)
    expect(onDraft).toHaveBeenCalledWith({ ...emptyDraft, repoPaths: ['/Users/sam/Notes'] })
    expect(onListDirs).not.toHaveBeenCalled()
    expect(button('Paste a path')).toBeUndefined()
  })

  it('changes nothing when the dialog is cancelled or fails', async () => {
    const chooseFolder = vi.fn<() => Promise<string | null>>().mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('no window'))
    vi.stubGlobal('window', { manorDesktop: { chooseFolder } })
    const { onDraft } = dialog()

    await act(async () => button('Add a folder…')!.props.onClick())
    await act(async () => button('Add a folder…')!.props.onClick())

    expect(chooseFolder).toHaveBeenCalledTimes(2)
    expect(onDraft).not.toHaveBeenCalled()
  })

  it('ignores a folder chosen after the dialog closed', async () => {
    let answer: (path: string) => void = () => {}
    const chooseFolder = vi.fn(() => new Promise<string | null>((resolve) => { answer = resolve }))
    vi.stubGlobal('window', { manorDesktop: { chooseFolder } })
    const { onDraft } = dialog()

    let pending: Promise<void> = Promise.resolve()
    act(() => { pending = button('Add a folder…')!.props.onClick() })
    act(() => tree!.unmount())
    await act(async () => { answer('/Users/sam/Notes'); await pending })

    expect(onDraft).not.toHaveBeenCalled()
  })

  it('offers the thread model only for a new project, and no memory switch at all', () => {
    vi.stubGlobal('window', {})
    dialog()
    const created = JSON.stringify(tree!.toJSON())
    // Plain dropdowns, on the house default until the user picks.
    expect(created).toContain('select:Provider=claude')
    expect(created).toContain('select:Model=claude-opus-5-5')
    expect(created).toContain('select:Reasoning=high')
    expect(created).not.toContain('Knowledge work memory')
    expect(created).toContain('Project thread model')
    expect(created).not.toContain('welcomes you on this model')

    act(() => {
      tree!.update(
        <ProjectDialog mode="edit" draft={emptyDraft} onDraft={() => {}} dirs={{ listing: null, asking: false }} notice={null} busy={false}
          onListDirs={() => {}} onSubmit={() => {}} onCancel={() => {}} onClose={() => {}} />,
      )
    })
    // An existing project's thread has its own picker; the form does not offer a second one.
    expect(JSON.stringify(tree!.toJSON())).not.toContain('select:Provider')
  })

  it('without the desktop shell still opens the server folder browser', () => {
    vi.stubGlobal('window', {})
    const { onListDirs } = dialog()

    act(() => button('Add a folder…')!.props.onClick())

    expect(onListDirs).toHaveBeenCalledTimes(1)
    expect(button('Add this folder')).toBeDefined()
  })
})
