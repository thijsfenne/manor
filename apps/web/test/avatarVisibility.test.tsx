import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { Avatar } from '../src/components/Avatar'
import { Blobatar } from '@manor/blobatar/react'

/** Whether the latest render asked for the busy loop. */
const busy = vi.hoisted(() => ({ active: undefined as boolean | undefined }))
vi.mock('../src/components/busyFace', async (original) => {
  const actual = await original<typeof import('../src/components/busyFace')>()
  return {
    ...actual,
    useBusyFace: (...args: Parameters<typeof actual.useBusyFace>) => {
      busy.active = args[1]
      return actual.useBusyFace(...args)
    },
  }
})

let view: ReactTestRenderer

afterEach(() => { act(() => view?.unmount()); vi.unstubAllGlobals() })

it('pauses a working face while the page is hidden', () => {
  let intersect: (entries: { isIntersecting: boolean }[]) => void = () => {}
  let visibilityChange: () => void = () => {}
  const disconnect = vi.fn()
  const remove = vi.fn()
  const document = {
    visibilityState: 'visible',
    hasFocus: () => true,
    addEventListener: (_event: string, callback: () => void) => { visibilityChange = callback },
    removeEventListener: remove,
  }
  vi.stubGlobal('document', document)
  vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {} })
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: typeof intersect) { intersect = callback }
    observe() {}
    disconnect = disconnect
  })
  act(() => { view = create(<Avatar name="Smith" color="var(--color-dim)" size={32} working />, { createNodeMock: () => ({ querySelector: () => null, querySelectorAll: () => [] }) }) })
  act(() => intersect([{ isIntersecting: false }]))
  expect(view.root.findByType(Blobatar).props.animate).toBe('always')
  // The busy loop is the costly part, so it waits until the face is in view.
  expect(busy.active).toBe(false)
  act(() => intersect([{ isIntersecting: true }]))
  expect(view.root.findByType(Blobatar).props.animate).toBe('always')
  expect(busy.active).toBe(true)
  act(() => { document.visibilityState = 'hidden'; visibilityChange() })
  expect(view.root.findByType(Blobatar).props.animate).toBeUndefined()
  expect(busy.active).toBe(false)
  act(() => { document.visibilityState = 'visible'; visibilityChange() })
  expect(view.root.findByType(Blobatar).props.animate).toBe('always')
  expect(busy.active).toBe(true)
  act(() => view.unmount())
  expect(disconnect).toHaveBeenCalledOnce()
  expect(remove).toHaveBeenCalledWith('visibilitychange', visibilityChange)
})
