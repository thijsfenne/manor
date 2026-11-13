import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NoteQuoteContextChip, QuoteBlock } from './QuoteContextChip'

let rendered: ReactTestRenderer | undefined
afterEach(() => {
  act(() => rendered?.unmount())
  rendered = undefined
})

describe('sent quote block', () => {
  it('opens the source message and prints the author only when given one', () => {
    const onOpen = vi.fn()
    act(() => {
      rendered = create(createElement(QuoteBlock, { quote: { eventId: 'source-3', text: 'Those words' }, author: 'Sage', onOpen }))
    })

    act(() => rendered?.root.findByProps({ 'aria-label': 'Open source message from Sage' }).props.onClick())
    expect(onOpen).toHaveBeenCalledOnce()

    act(() => {
      rendered?.update(createElement(QuoteBlock, { quote: { eventId: 'source-3', text: 'Those words' } }))
    })
    expect(rendered?.root.findAllByProps({ children: 'Sage' })).toHaveLength(0)
  })
})

describe('knowledge note quote chip', () => {
  it('names the file and keeps the path on the full title', () => {
    act(() => {
      rendered = create(createElement(NoteQuoteContextChip, {
        quote: { path: 'inbox/untitled.md', text: 'Keep this slice' },
      }))
    })

    expect(rendered?.root.findByProps({ title: 'inbox/untitled.md\nKeep this slice' })).toBeDefined()
  })
})
