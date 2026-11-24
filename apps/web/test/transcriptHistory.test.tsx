import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Transcript } from '../src/components/Transcript'
import type { Row } from '../src/state'

const rows: Row[] = Array.from({ length: 100 }, (_, index) => ({
  kind: 'pending', key: `message-${index}`, text: `Message ${index}`, images: [], files: [], pageContexts: [],
}))
let view: ReactTestRenderer
const render = (data: Row[], key = 'a') => <Transcript key={key} rows={data} agents={[]} skills={[]} hasSnapshot />
const rendered = () => JSON.stringify(view.toJSON())
afterEach(() => { act(() => view?.unmount()); vi.unstubAllGlobals() })

describe('reading transcript history', () => {
  it('opens at the latest page, prepends on demand, and keeps new messages without evicting history', () => {
    act(() => { view = create(render(rows)) })
    expect(rendered()).toContain('Message 70')
    expect(rendered()).not.toContain('Message 69')
    act(() => view.root.findAllByType('button').find(button => button.props.children === 'Load earlier messages')!.props.onClick())
    expect(rendered()).toContain('Message 40')
    expect(rendered()).not.toContain('Message 39')
    act(() => view.update(render([...rows, { ...rows[99]!, key: 'new', kind: 'pending', text: 'New reply', images: [], files: [], pageContexts: [] }])))
    expect(rendered()).toContain('Message 40')
    expect(rendered()).toContain('New reply')
    act(() => view.update(render(rows, 'b')))
    expect(rendered()).not.toContain('Message 40')
    expect(rendered()).toContain('Message 70')
  })
})

describe('staying at the bottom', () => {
  it('follows a composer or Session bar that grew before the pin\'s own scroll event, and lets go on a scroll up', () => {
    let top = 0
    const scroller = {
      scrollHeight: 1_000,
      clientHeight: 400,
      get scrollTop() { return top },
      set scrollTop(next: number) { top = Math.max(0, Math.min(next, this.scrollHeight - this.clientHeight)) },
      querySelector: () => null,
      querySelectorAll: () => [],
      getBoundingClientRect: () => ({ top: 0, bottom: 400 }),
      contains: () => false,
    }
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    act(() => {
      view = create(render(rows), { createNodeMock: (element) => (element.props.onScroll === undefined ? null : scroller) })
    })
    const scroll = () => act(() => view.root.find((node) => node.props.onScroll !== undefined).props.onScroll())
    const jumpShown = () => view.root.findAll((node) => node.props['data-jump-latest'] !== undefined).length > 0
    expect(scroller.scrollTop).toBe(600)
    // The Session bar and the composer settle 60px taller, then the pin's scroll event arrives.
    scroller.scrollHeight = 1_060
    scroll()
    expect(jumpShown()).toBe(false)
    expect(scroller.scrollTop).toBe(660)
    // The reader scrolls up past the slack: the thread lets go and offers the way back.
    scroller.scrollTop = 500
    scroll()
    expect(jumpShown()).toBe(true)
  })
})
