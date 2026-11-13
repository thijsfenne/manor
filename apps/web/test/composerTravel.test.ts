import { createElement, forwardRef } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '../src/components/Composer'

const animation = vi.hoisted(() => ({
  reduced: false,
  value: { set: vi.fn() },
  stop: vi.fn(),
  start: vi.fn(),
}))
vi.mock('motion/react', async (original) => {
  const actual = await original<typeof import('motion/react')>()
  return {
    ...actual,
    motion: {
      ...actual.motion,
      div: forwardRef((props, ref) => createElement('div', { ...props, ref })),
      span: forwardRef((props, ref) => createElement('span', { ...props, ref })),
    },
    useReducedMotion: () => animation.reduced,
    useMotionValue: () => animation.value,
    animate: (...args: unknown[]) => { animation.start(...args); return { stop: animation.stop } },
  }
})
vi.mock('../src/components/ComposerEditor', () => ({
  ComposerEditor: forwardRef(({ value }: { value: string }, ref) => createElement('div', { ref }, value)),
}))

let view: ReactTestRenderer | undefined
const composer = (travelFrom: number | null) => createElement(Composer, {
  agents: [], canSend: true, blockedNote: '', onSend: () => true, travelFrom,
})
const mount = (from: number | null) => act(() => {
  view = create(composer(from), {
    createNodeMock: (element) => element.type === 'div' ? { getBoundingClientRect: () => ({ top: 500 }) } : null,
  })
})
afterEach(() => {
  act(() => view?.unmount())
  view = undefined
  animation.reduced = false
  vi.clearAllMocks()
})

const travelRoot = () => view!.root.find((node) =>
  node.type === 'div' && String(node.props.className ?? '').includes('max-w-[760px]'),
)

describe('composer arrival', () => {
  it('does not keep a travel transform on the idle new-chat box', () => {
    mount(null)
    expect(travelRoot().props.style).toBeUndefined()
  })

  it('travels from the measured position once and stops its animation on unmount', () => {
    mount(null)
    expect(animation.start).not.toHaveBeenCalled()
    act(() => view!.update(composer(200)))
    expect(travelRoot().props.style).toEqual({ y: animation.value })
    expect(animation.value.set).toHaveBeenCalledWith(-300)
    expect(animation.start).toHaveBeenCalledTimes(1)
    expect(animation.start.mock.calls[0]?.[2].duration).toBeLessThanOrEqual(0.3)
    act(() => view!.update(composer(null)))
    expect(animation.start).toHaveBeenCalledTimes(1)
    expect(animation.stop).not.toHaveBeenCalled()
    act(() => view!.unmount())
    expect(animation.stop).toHaveBeenCalledTimes(1)
    expect(animation.value.set).toHaveBeenLastCalledWith(0)
    view = undefined
  })

  it('does not animate with reduced motion', () => {
    animation.reduced = true
    mount(200)
    expect(animation.start).not.toHaveBeenCalled()
    expect(animation.value.set).not.toHaveBeenCalled()
  })

  it('does not animate an arrival that is already in place', () => {
    mount(500)
    expect(animation.start).not.toHaveBeenCalled()
  })
})
