import { act, create } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAddFolder } from '../src/useAddFolder'

afterEach(() => vi.unstubAllGlobals())

const harness = (chooseFolder: (() => Promise<string | null>) | undefined, addFolder: (path: string) => Promise<string>) => {
  vi.stubGlobal('window', chooseFolder === undefined ? {} : { manorDesktop: { chooseFolder } })
  const manor = { addFolder: vi.fn(addFolder), listDirs: vi.fn(), closeDirs: vi.fn() }
  const onAdded = vi.fn()
  let hook!: ReturnType<typeof useAddFolder>
  function Probe() {
    hook = useAddFolder(manor, onAdded)
    return null
  }
  let tree!: ReturnType<typeof create>
  act(() => {
    tree = create(<Probe />)
  })
  return { manor, onAdded, hook: () => hook, unmount: () => act(() => tree.unmount()) }
}

describe('Add folder', () => {
  it('opens Finder on the desktop and puts the draft in the folder Manor added', async () => {
    const { manor, onAdded, hook } = harness(async () => '/Users/me/Notes', async () => 'folder-1')
    await act(() => hook().start())
    expect(manor.addFolder).toHaveBeenCalledWith('/Users/me/Notes')
    expect(manor.listDirs).not.toHaveBeenCalled()
    expect(onAdded).toHaveBeenCalledWith('folder-1')
    expect(hook().browsing).toBe(false)
  })

  it('does nothing when Finder is cancelled', async () => {
    const { manor, onAdded, hook } = harness(async () => null, async () => 'folder-1')
    await act(() => hook().start())
    expect(manor.addFolder).not.toHaveBeenCalled()
    expect(onAdded).not.toHaveBeenCalled()
  })

  it('leaves the draft alone when the answer lands after a cancel, and opens again at once', async () => {
    let answer!: (id: string) => void
    const { manor, onAdded, hook } = harness(undefined, () => new Promise<string>((resolve) => { answer = resolve }))
    await act(() => hook().start())
    let adding!: Promise<void>
    act(() => {
      adding = hook().add('/Users/me/Notes')
    })
    act(() => hook().cancel())
    expect(hook().busy).toBe(false)
    await act(() => hook().start())
    expect(manor.listDirs).toHaveBeenCalledTimes(2)
    await act(async () => {
      answer('folder-1')
      await adding
    })
    expect(onAdded).not.toHaveBeenCalled()
  })

  it('drops a Finder choice that comes back after the stage has gone', async () => {
    let pick!: (path: string) => void
    const { manor, onAdded, hook, unmount } = harness(() => new Promise<string>((resolve) => { pick = resolve }), async () => 'folder-1')
    let starting!: Promise<void>
    act(() => {
      starting = hook().start()
    })
    unmount()
    pick('/Users/me/Notes')
    await starting
    expect(manor.addFolder).not.toHaveBeenCalled()
    expect(onAdded).not.toHaveBeenCalled()
  })

  it('walks the server folders where there is no Finder, and opens on a refusal', async () => {
    const { manor, onAdded, hook } = harness(undefined, async () => {
      throw new Error('There is nothing at /nowhere.')
    })
    await act(() => hook().start())
    expect(hook().browsing).toBe(true)
    expect(manor.listDirs).toHaveBeenCalledOnce()
    await act(() => hook().add('/nowhere'))
    expect(hook().error).toBe('There is nothing at /nowhere.')
    expect(onAdded).not.toHaveBeenCalled()
  })
})
