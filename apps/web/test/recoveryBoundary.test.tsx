import type { FunctionComponent } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ShellBoundary, ViewBoundary, retryableLazy } from '../src/components/RecoveryBoundary'

let tree: ReactTestRenderer
beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}) })
afterEach(() => {
  if (tree) act(() => tree.unmount())
  vi.restoreAllMocks()
})

const buttonNamed = (text: string) =>
  tree.root.find((node: ReactTestInstance) => node.type === 'button' && node.children.includes(text))
const text = () => JSON.stringify(tree.toJSON())

const Loaded: FunctionComponent<{ label: string }> = ({ label }) => <p>{label}</p>

describe('view boundary', () => {
  it('shows a retry for a rejected lazy chunk and imports again on retry', async () => {
    const load = vi.fn<() => Promise<FunctionComponent<{ label: string }>>>()
      .mockRejectedValueOnce(new Error('chunk failed'))
      .mockResolvedValueOnce(Loaded)
    const View = retryableLazy(load)
    await act(async () => {
      tree = create(<ViewBoundary resetKey="usage" loading="Loading"><View label="Usage view" /></ViewBoundary>)
    })
    expect(text()).toContain('This view did not load.')

    await act(async () => buttonNamed('Try again').props.onClick())
    expect(load).toHaveBeenCalledTimes(2)
    expect(text()).toContain('Usage view')
  })

  it('shows a retry for a render exception, recovers on retry, and resets when the view changes', () => {
    let broken = true
    const Flaky = () => {
      if (broken) throw new Error('render failed')
      return <p>Rendered</p>
    }
    act(() => { tree = create(<ViewBoundary resetKey="chat:a" loading={null}><Flaky /></ViewBoundary>) })
    expect(text()).toContain('This view did not load.')

    broken = false
    act(() => buttonNamed('Try again').props.onClick())
    expect(text()).toContain('Rendered')

    broken = true
    act(() => tree.update(<ViewBoundary resetKey="chat:a" loading={null}><Flaky key="again" /></ViewBoundary>))
    expect(text()).toContain('This view did not load.')
    broken = false
    act(() => tree.update(<ViewBoundary resetKey="chat:b" loading={null}><Flaky key="again" /></ViewBoundary>))
    expect(text()).toContain('Rendered')
  })
})

describe('shell boundary', () => {
  it('replaces a crashed app with a reload action', () => {
    const reload = vi.fn()
    vi.stubGlobal('window', { location: { reload } })
    const Crash = () => { throw new Error('boom') }
    act(() => { tree = create(<ShellBoundary><Crash /></ShellBoundary>) })
    expect(text()).toContain('Manor ran into a problem.')
    buttonNamed('Reload').props.onClick()
    expect(reload).toHaveBeenCalledOnce()
    vi.unstubAllGlobals()
  })
})
