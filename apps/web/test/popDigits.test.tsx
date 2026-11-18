import { useState } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PopDigits } from '../src/components/ui/PopDigits'

const motion = vi.hoisted(() => ({ reduced: false }))

/** A digit that records whether it mounted moving: Motion reads `initial` only on mount. */
function Digit({ initial, children }: { initial: unknown; children: string }) {
  const [moves] = useState(initial !== false)
  return <span data-moves={moves}>{children}</span>
}

vi.mock('motion/react', () => ({ motion: { span: Digit }, useReducedMotion: () => motion.reduced }))

afterEach(() => { motion.reduced = false })

/** Each digit, marked when it mounted moving. */
const digits = (view: ReactTestRenderer) => view.root.findAllByType(Digit).map((digit) => {
  const span = digit.findByType('span')
  return `${span.props.children as string}${span.props['data-moves'] === true ? '*' : ''}`
}).join(' ')

const render = (value: number) => <PopDigits value={value} prefix="+" />

describe('a live count', () => {
  it('stands still on first render, then remounts only the digits that changed', () => {
    let view!: ReactTestRenderer
    act(() => { view = create(render(128)) })
    expect(digits(view)).toBe('1 2 8')
    act(() => view.update(render(131)))
    expect(digits(view)).toBe('1 3* 1*')
    act(() => view.update(render(132)))
    expect(digits(view)).toBe('1 3* 2*')
  })

  it('shows the end state at once under reduced motion', () => {
    motion.reduced = true
    let view!: ReactTestRenderer
    act(() => { view = create(render(9)) })
    act(() => view.update(render(10)))
    expect(digits(view)).toBe('1 0')
  })

  it('reads the signed count as one string', () => {
    let view!: ReactTestRenderer
    act(() => { view = create(render(128)) })
    expect(view.root.findByProps({ className: 'sr-only' }).props.children).toEqual(['+', 128])
    expect(view.root.findByProps({ 'aria-hidden': 'true' })).toBeDefined()
  })
})
