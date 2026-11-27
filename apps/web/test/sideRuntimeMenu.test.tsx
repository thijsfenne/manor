import { SIDE_CHAT_DEFAULTS } from '@manor/contracts'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { SideRuntimeMenu } from '../src/components/SideRuntimeMenu'

vi.mock('../src/components/ui/Popover', () => ({
  Popover: ({ open, children, className }: { open: boolean; children: ReactNode; className?: string }) =>
    open ? <div className={className}>{children}</div> : null,
}))
vi.mock('../src/components/ui/useDismiss', () => ({ useDismiss: () => {} }))

describe('the menu in the composer', () => {
  const render = (disabled: boolean) =>
    renderToStaticMarkup(
      <SideRuntimeMenu
        model={SIDE_CHAT_DEFAULTS.model}
        effort={SIDE_CHAT_DEFAULTS.effort}
        disabled={disabled}
        onChange={() => {}}
      />,
    )

  it('says what the panel runs on without being opened', () => {
    const html = render(false)

    // Two spans, not one string: the model reads in text colour, the level muted.
    expect(html).toContain('>Sonnet 5.5<')
    expect(html).toContain('>Medium<')
    expect(html).not.toContain('Sonnet 5.5, Medium')
    expect(html).toContain('aria-haspopup="menu"')
    // Closed: the rows themselves need a press, which this suite has no DOM for.
    expect(html).not.toContain('Reasoning')
  })

  it('cannot be used while there is nothing to write a pick to', () => {
    expect(render(true)).toContain('disabled=""')
    expect(render(false)).not.toContain('disabled=""')
  })

  it('uses the shared split picker without speed or an explanatory footer', () => {
    const onChange = vi.fn()
    let tree!: ReactTestRenderer
    act(() => {
      tree = create(
        <SideRuntimeMenu
          model={SIDE_CHAT_DEFAULTS.model}
          effort={SIDE_CHAT_DEFAULTS.effort}
          disabled={false}
          onChange={onChange}
        />,
      )
    })
    const trigger = tree.root.find((node) =>
      node.type === 'button' && node.props.title === 'Provider, model and reasoning for this side chat',
    )
    act(() => trigger.props.onClick())

    expect(tree.root.findAllByProps({ role: 'radio' }).map((row) => row.props['aria-label'])).toEqual([
      'Claude Code, Default',
      'Codex',
      'Grok Build',
      'Cursor',
    ])
    expect(tree.root.find((node) => typeof node.props.className === 'string' && node.props.className.includes('w-[min(360px,calc(var(--side-width,396px)-36px),calc(100vw-48px))]'))).toBeDefined()
    expect(tree.root.findByProps({ type: 'range' }).props['aria-label']).toBe('Reasoning effort')
    expect(tree.root.findAllByProps({ 'aria-label': 'Fast mode' })).toHaveLength(0)
    expect(tree.root.findAll((node) => node.type === 'p' && node.children.some((child) => typeof child === 'string' && child.includes('This panel only')))).toHaveLength(0)
    act(() => tree.root.findByProps({ 'aria-label': 'Codex' }).props.onClick())
    expect(onChange).toHaveBeenCalledWith('gpt-6-luna', 'medium')
    act(() => tree.unmount())
  })

  it('keeps an unknown saved model readable', () => {
    const html = renderToStaticMarkup(
      <SideRuntimeMenu model="future-model" effort="high" disabled={false} onChange={() => {}} />,
    )
    expect(html).toContain('>future-model<')
    expect(html).toContain('>High<')
  })
})
