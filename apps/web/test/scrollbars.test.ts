import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installScrollbarReveal } from '../src/scrollbars'

type Fake = {
  getAttribute(name: string): string | null
  setAttribute(name: string, value: string): void
  contains(node: unknown): boolean
  closest(selector: string): unknown
}

/** A scroller, or a node inside `parent`; `field` stands for a text field. */
function node(parent?: Fake, field = false): Fake {
  const attributes = new Map<string, string>()
  const self: Fake = {
    getAttribute: (name) => attributes.get(name) ?? null,
    setAttribute: (name, value) => void attributes.set(name, value),
    contains: (other) => other === self || (other as { inside?: Fake }).inside === self,
    closest: () => (field ? self : null),
  }
  return Object.assign(self, { inside: parent })
}

function page() {
  const listeners = new Map<string, (event: { target: unknown; key?: string }) => void>()
  let clock = 0
  const root = {
    documentElement: node(),
    body: {},
    addEventListener: (type: string, listener: (event: { target: unknown; key?: string }) => void) => void listeners.set(type, listener),
  }
  installScrollbarReveal(root, () => clock)
  return {
    root,
    fire: (type: string, event: { target: unknown; key?: string }) => listeners.get(type)?.(event),
    wait(ms: number) {
      clock += ms
      vi.advanceTimersByTime(ms)
    },
  }
}

describe('installScrollbarReveal', () => {
  beforeEach(() => void vi.useFakeTimers())
  afterEach(() => void vi.useRealTimers())

  it('shows the bar on a wheel scroll and turns it off a second after the last one', () => {
    const { fire, wait } = page()
    const list = node()
    fire('wheel', { target: node(list) })
    fire('scroll', { target: list })
    expect(list.getAttribute('data-scrollbar')).toBe('on')
    wait(900)
    fire('wheel', { target: node(list) })
    fire('scroll', { target: list })
    wait(900)
    expect(list.getAttribute('data-scrollbar')).toBe('on')
    wait(100)
    expect(list.getAttribute('data-scrollbar')).toBe('off')
  })

  it('leaves the bar hidden for a scroll no user input caused', () => {
    const { fire, wait } = page()
    const transcript = node()
    fire('wheel', { target: node(transcript) })
    wait(600)
    fire('scroll', { target: transcript })
    expect(transcript.getAttribute('data-scrollbar')).toBeNull()
  })

  it('keeps another pane hidden while the user scrolls this one', () => {
    const { fire } = page()
    const files = node()
    const transcript = node()
    fire('wheel', { target: node(files) })
    fire('scroll', { target: files })
    fire('scroll', { target: transcript })
    expect(files.getAttribute('data-scrollbar')).toBe('on')
    expect(transcript.getAttribute('data-scrollbar')).toBeNull()
  })

  it('ignores scroll keys typed into a text field', () => {
    const { fire } = page()
    const transcript = node()
    fire('keydown', { target: node(transcript, true), key: 'ArrowDown' })
    fire('scroll', { target: transcript })
    expect(transcript.getAttribute('data-scrollbar')).toBeNull()
    fire('keydown', { target: node(transcript), key: 'PageDown' })
    fire('scroll', { target: transcript })
    expect(transcript.getAttribute('data-scrollbar')).toBe('on')
  })

  it('counts a click on the track whose scroll lands after the release, and a long drag', () => {
    const { fire, wait } = page()
    const list = node()
    fire('pointerdown', { target: list })
    fire('pointerup', { target: list })
    fire('scroll', { target: list })
    expect(list.getAttribute('data-scrollbar')).toBe('on')
    fire('pointerdown', { target: list })
    wait(2000)
    fire('scroll', { target: list })
    expect(list.getAttribute('data-scrollbar')).toBe('on')
  })

  it('keeps the bar hidden when a released click on the content precedes a scroll', () => {
    const { fire } = page()
    const transcript = node()
    fire('pointerdown', { target: node(transcript) })
    fire('pointerup', { target: node(transcript) })
    fire('scroll', { target: transcript })
    expect(transcript.getAttribute('data-scrollbar')).toBeNull()
  })

  it('sends scroll keys with nothing focused to the pane pressed last', () => {
    const { root, fire } = page()
    const transcript = node()
    const files = node()
    fire('pointerdown', { target: node(transcript) })
    fire('pointerup', { target: node(transcript) })
    fire('wheel', { target: node(files) })
    fire('keydown', { target: root.body, key: 'PageDown' })
    fire('scroll', { target: transcript })
    expect(transcript.getAttribute('data-scrollbar')).toBe('on')
  })

  it('marks the page itself when the document scrolls', () => {
    const { root, fire } = page()
    fire('wheel', { target: root.documentElement })
    fire('scroll', { target: root })
    expect(root.documentElement.getAttribute('data-scrollbar')).toBe('on')
  })
})
