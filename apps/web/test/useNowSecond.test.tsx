import { act, create } from 'react-test-renderer'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useNowSecond } from '../src/useNowSecond'

function Label({ active = true }: { active?: boolean }) {
  return <span>{useNowSecond(active)}</span>
}

describe('useNowSecond', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(10_250)
    vi.stubGlobal('window', globalThis)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('serves a server render', () => {
    expect(renderToStaticMarkup(<Label />)).toBe('<span>10000</span>')
  })

  it('runs one timeout for all labels, on the second, and none once they unmount', () => {
    let first!: ReturnType<typeof create>
    let second!: ReturnType<typeof create>
    act(() => {
      first = create(<Label />)
      second = create(<Label />)
    })
    expect(vi.getTimerCount()).toBe(1)
    expect(first.toJSON()).toMatchObject({ children: ['10000'] })

    act(() => { vi.advanceTimersByTime(749) })
    expect(second.toJSON()).toMatchObject({ children: ['10000'] })
    act(() => { vi.advanceTimersByTime(1) })
    expect(first.toJSON()).toMatchObject({ children: ['11000'] })
    expect(second.toJSON()).toMatchObject({ children: ['11000'] })

    act(() => { first.unmount() })
    expect(vi.getTimerCount()).toBe(1)
    act(() => { second.unmount() })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stays silent while inactive', () => {
    let label!: ReturnType<typeof create>
    act(() => { label = create(<Label active={false} />) })
    expect(vi.getTimerCount()).toBe(0)
    expect(label.toJSON()).toMatchObject({ children: ['0'] })
    act(() => { label.unmount() })
  })
})
