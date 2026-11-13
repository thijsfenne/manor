import { QuoteDownIcon } from '@hugeicons/core-free-icons'
import { act, create, type ReactTestInstance } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { FormatToolbar, SlashMenuList, type FormatToolbarProps } from '../src/components/knowledge/NoteFormatting'
import { filterSlashItems } from '../src/components/knowledge/slashMenu'

const noop = () => undefined

function toolbar(overrides: Partial<FormatToolbarProps> = {}) {
  const props: FormatToolbarProps = {
    block: 'h2',
    marks: { bold: true, italic: false, strike: false, code: false },
    available: { bold: true, italic: true, strike: true, code: true },
    link: false,
    linkAvailable: true,
    compact: false,
    quote: [{ id: 'quote', label: 'Quote selection', short: 'Quote', icon: QuoteDownIcon, run: noop }],
    linkDraft: null,
    onTurnInto: noop,
    onToggle: noop,
    onLink: noop,
    onLinkSubmit: noop,
    onLinkRemove: noop,
    onLinkCancel: noop,
    onQuote: noop,
    onLeave: noop,
    ...overrides,
  }
  let renderer!: ReturnType<typeof create>
  act(() => { renderer = create(<FormatToolbar {...props} />) })
  const controls = renderer.root.findAll((node) => node.type === 'button' && node.props['data-bar-control'] === true)
  return { renderer, controls }
}

const label = (node: ReactTestInstance) => node.props['aria-label'] ?? node.props.title

describe('note format toolbar', () => {
  it('runs Turn into, the marks and Link in order, with the quote action last', () => {
    const { controls } = toolbar()
    expect(controls.map(label)).toEqual(['Turn into', 'Bold', 'Italic', 'Strikethrough', 'Inline code', 'Link', 'Quote selection'])
    expect(controls.at(-1)!.props['data-quote-action']).toBe('quote')
    expect(controls.find((node) => label(node) === 'Bold')!.props['aria-pressed']).toBe(true)
    expect(controls.find((node) => label(node) === 'Italic')!.props['aria-pressed']).toBe(false)
  })

  it('folds strikethrough and code into More when narrow, and keeps the quote action last', () => {
    const { controls } = toolbar({ compact: true })
    expect(controls.map(label)).toEqual(['Turn into', 'Bold', 'Italic', 'Link', 'More formatting', 'Quote selection'])
  })

  it('hands the quote action back on a click', () => {
    const onQuote = vi.fn()
    const { controls } = toolbar({ onQuote })
    act(() => controls.at(-1)!.props.onClick())
    expect(onQuote).toHaveBeenCalledWith(expect.objectContaining({ id: 'quote' }))
  })

  it('opens Turn into away from the selection, past it when there is no room', () => {
    const menuStyle = (overrides: Partial<FormatToolbarProps>) => {
      const { renderer, controls } = toolbar(overrides)
      act(() => controls[0]!.props.onClick())
      return renderer.root.findByProps({ role: 'menu' }).props.style
    }
    expect(menuStyle({})).toEqual({ top: 'calc(100% + 10px)' })
    expect(menuStyle({ menuPlace: { side: 'up', clear: 0 } })).toEqual({ bottom: 'calc(100% + 10px)' })
    expect(menuStyle({ menuPlace: { side: 'down', clear: 30 } })).toEqual({ top: 'calc(100% + 40px)' })
  })

  it('swaps to the link field with the current address and a remove control', () => {
    const { renderer } = toolbar({ linkDraft: { url: 'https://a.b', existing: true } })
    expect(renderer.root.findByProps({ 'aria-label': 'Link address' }).props.value).toBe('https://a.b')
    expect(renderer.root.findAllByProps({ 'aria-label': 'Remove link' })).toHaveLength(1)
  })
})

describe('slash menu rows', () => {
  it('shows the filtered items with the highlight and picks on press', () => {
    const onPick = vi.fn()
    let renderer!: ReturnType<typeof create>
    act(() => { renderer = create(<ul><SlashMenuList items={filterSlashItems('head')} index={1} onPick={onPick} onHover={noop} /></ul>) })
    const options = renderer.root.findAllByProps({ role: 'option' })
    expect(options.map((option) => option.props.id)).toEqual(['manor-slash-h1', 'manor-slash-h2', 'manor-slash-h3'])
    expect(options.map((option) => option.props['aria-selected'])).toEqual([false, true, false])
    act(() => options[2]!.props.onMouseDown({ preventDefault: noop }))
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: 'h3' }))
  })
})
