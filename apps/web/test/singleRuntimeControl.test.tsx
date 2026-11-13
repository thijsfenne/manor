import type { AgentConfig, ChatOverride } from '@manor/contracts'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { Transcript } from '../src/components/Transcript'
import type { Row } from '../src/state'
import {
  SingleRuntimeControl,
  defaultSingleRuntime,
  readSingleRuntime,
} from '../src/components/SingleRuntimeControl'
import { AutoRulesConfigProvider } from '../src/components/settings/AutoRulesPage'
import { ComposerAutoRow, NewChatModeControl, NewChatPickerSlot, newChatRuntimeKind } from '../src/components/NewChatModeControl'
import { ComposerAutoControl, MenuRow } from '../src/components/RuntimeMenu'
import { MODELS } from '../src/runtimes'

vi.mock('../src/components/ui/Popover', () => ({
  Popover: ({ open, children, className }: { open: boolean; children: ReactNode; className?: string }) =>
    open ? <div className={className}>{children}</div> : null,
}))
vi.mock('../src/components/ui/useDismiss', () => ({ useDismiss: () => {} }))

const agent = (over: Partial<AgentConfig>): AgentConfig => ({
  id: 'agent',
  name: 'Agent',
  color: '#8b5cf6',
  character: '',
  driver: 'claude',
  model: 'claude-opus-5',
  effort: 'high',
  allowedTools: [],
  mcpServers: [],
  memoryScope: false,
  description: '',
  role: '',
  isCos: false,
  ...over,
})

describe('the single session runtime control', () => {
  it('starts from the chief of staff when that provider supports bare sessions', () => {
    expect(defaultSingleRuntime([
      agent({ id: 'first', driver: 'claude', model: 'claude-sonnet-5' }),
      agent({ id: 'cos', isCos: true, driver: 'grok', model: 'grok-4.6', effort: 'xhigh' }),
    ])).toEqual({ driver: 'grok', model: 'grok-4.6', effort: 'xhigh' })
  })

  it('falls back safely when a stored pin is incomplete', () => {
    const fallback = defaultSingleRuntime([])
    expect(readSingleRuntime({ model: 'gpt-6-astra' }, fallback)).toEqual(fallback)
  })

  it('offers every supported provider and omits speed', () => {
    let tree!: ReactTestRenderer
    act(() => {
      tree = create(
        <SingleRuntimeControl
          override={{ driver: 'claude', model: 'claude-opus-5', effort: 'high' }}
          fallback={{ driver: 'claude', model: 'claude-opus-5', effort: 'high' }}
          allowAuto={false}
          disabled={false}
          onChange={() => {}}
        />,
      )
    })
    act(() => tree.root.find((node) => node.type === 'button' && node.props.title === 'Provider, model, reasoning and speed for this chat').props.onClick())
    expect(tree.root.findAllByProps({ role: 'radio' }).map((row) => row.props['aria-label'])).toEqual([
      'Claude Code, Default',
      'Codex',
      'Grok Build',
      'Cursor',
    ])
    expect(tree.root.findByProps({ role: 'radiogroup' }).props['aria-orientation']).toBe('vertical')
    expect(tree.root.find((node) => typeof node.props.className === 'string' && node.props.className.includes('h-full min-h-0 overflow-y-auto'))).toBeDefined()
    expect(tree.root.findAllByProps({ 'aria-label': 'Fast mode' })).toHaveLength(0)
    expect(tree.root.findAll((node) => node.type === 'p' && node.children.some((child) => typeof child === 'string' && child.includes('This chat only')))).toHaveLength(0)
    act(() => tree.unmount())
  })

  it('names the composer modes Multiple and Single', () => {
    const html = renderToStaticMarkup(<NewChatModeControl mode="house" onChange={() => {}} />)

    expect(html).toContain('>Multiple<')
    expect(html).toContain('>Single<')
    expect(html).not.toContain('>The house<')
    expect(html).not.toContain('>Single agent<')
  })

  it('hides the Single picker while Auto is on and keeps the Work facepile', () => {
    expect(newChatRuntimeKind('single', true)).toBe('none')
    expect(newChatRuntimeKind('single', false)).toBe('single')
    expect(newChatRuntimeKind('house', true)).toBe('house')
  })

  it('collapses the Single picker with the card-resize transition', () => {
    const closed = renderToStaticMarkup(
      <NewChatPickerSlot open={false}>
        <span>picker</span>
      </NewChatPickerSlot>,
    )
    expect(closed).toContain('t-resize')
    expect(closed).toContain('overflow-hidden')
    expect(closed).toContain('width:0')
    expect(closed).toContain('picker')
    expect(closed).toContain('pointer-events-none')

    const shown = renderToStaticMarkup(
      <NewChatPickerSlot open>
        <span>picker</span>
      </NewChatPickerSlot>,
    )
    expect(shown).toContain('t-resize')
    expect(shown).not.toContain('overflow-hidden')
  })

  it('puts Auto left of the picker, with the rules gear after the switch', () => {
    const bare = renderToStaticMarkup(<ComposerAutoControl checked onChange={() => {}} />)
    expect(bare).toContain('>Auto<')
    expect(bare).toContain('Auto mode')
    expect(bare).toContain('gap-2.5')
    expect(bare).not.toContain('Auto mode rules')

    const html = renderToStaticMarkup(
      <AutoRulesConfigProvider open={() => {}}>
        <ComposerAutoRow
          mode="house"
          onModeChange={() => {}}
          auto={{ checked: true, onChange: () => {} }}
          picker={<span>picker</span>}
          pickerOpen
        />
      </AutoRulesConfigProvider>,
    )
    expect(html.indexOf('>Multiple<')).toBeLessThan(html.indexOf('>Auto<'))
    expect(html.indexOf('>Auto<')).toBeLessThan(html.indexOf('role="switch"'))
    expect(html.indexOf('role="switch"')).toBeLessThan(html.indexOf('Auto mode rules'))
    expect(html.indexOf('Auto mode rules')).toBeLessThan(html.indexOf('>picker<'))
  })

  it('the fallback picker after Auto is off has no Auto switch of its own', () => {
    let tree!: ReactTestRenderer
    act(() => {
      tree = create(
        <SingleRuntimeControl
          override={{ driver: 'claude', model: 'claude-opus-5', effort: 'high' }}
          fallback={{ driver: 'claude', model: 'claude-opus-5', effort: 'high' }}
          allowAuto={false}
          disabled={false}
          onChange={() => {}}
        />,
      )
    })
    act(() => tree.root.find((node) => node.type === 'button' && node.props.title === 'Provider, model, reasoning and speed for this chat').props.onClick())
    expect(tree.root.findAllByProps({ role: 'switch' })).toHaveLength(0)
    act(() => tree.unmount())
  })

  it('keeps provider, model and reasoning picks open until dismissed', () => {
    let tree!: ReactTestRenderer
    act(() => {
      tree = create(
        <SingleRuntimeControl
          override={{ driver: 'claude', model: 'claude-opus-5', effort: 'high' }}
          fallback={{ driver: 'claude', model: 'claude-opus-5', effort: 'high' }}
          allowAuto={false}
          disabled={false}
          onChange={() => {}}
        />,
      )
    })
    const trigger = tree.root.find((node) => node.type === 'button' && node.props.title === 'Provider, model, reasoning and speed for this chat')
    act(() => trigger.props.onClick())
    expect(trigger.props.className).toContain('bg-user-bg')

    act(() => tree.root.findByProps({ 'aria-label': 'Codex' }).props.onClick())
    expect(tree.root.findAllByProps({ role: 'radiogroup' })).toHaveLength(1)

    const rows = () => tree.root.findAllByProps({ role: 'menuitemradio' })
    act(() => rows()[0]!.props.onClick())
    expect(tree.root.findAllByProps({ role: 'radiogroup' })).toHaveLength(1)

    act(() => tree.root.findByProps({ type: 'range' }).props.onChange({ currentTarget: { value: '0' } }))
    expect(tree.root.findAllByProps({ role: 'radiogroup' })).toHaveLength(1)
    act(() => trigger.props.onClick())
    expect(tree.root.findAllByProps({ role: 'radiogroup' })).toHaveLength(0)
    act(() => tree.unmount())
  })

  it.each([
    { driver: 'cursor' as const, model: 'cursor-grok-4.6' },
    ...MODELS.codex.map(({ value }) => ({ driver: 'codex' as const, model: value })),
  ])('shows and stores Fast for $model', ({ driver, model }) => {
    const onChange = vi.fn()
    let tree!: ReactTestRenderer
    act(() => {
      tree = create(
        <SingleRuntimeControl
          override={{ driver, model, effort: 'high' }}
          fallback={{ driver, model, effort: 'high' }}
          allowAuto={false}
          disabled={false}
          onChange={onChange}
        />,
      )
    })
    const trigger = tree.root.find((node) => node.type === 'button' && node.props.title === 'Provider, model, reasoning and speed for this chat')
    act(() => trigger.props.onClick())
    const fast = tree.root.find((node) => node.type === 'button' && node.props['aria-label'] === 'Fast mode')
    expect(fast.props['aria-pressed']).toBe(false)
    act(() => fast.props.onClick())

    expect(onChange).toHaveBeenLastCalledWith({
      driver,
      model,
      effort: 'high',
      auto: false,
      speed: 'fast',
    })
    // A toggle beside the slider, so the menu stays open like the slider does.
    expect(tree.root.findAllByProps({ role: 'radiogroup' })).toHaveLength(1)
    act(() => tree.unmount())
  })

  it('resets effort to the original fallback after the Single voice follows a changed pin', () => {
    const fallback = { driver: 'codex' as const, model: 'gpt-5.6-sol', effort: 'high' as const }
    const onChange = vi.fn()
    let tree!: ReactTestRenderer
    act(() => { tree = create(<SingleRuntimeControl override={{ ...fallback, effort: 'max', auto: false }} fallback={fallback} disabled={false} onChange={onChange} />) })
    act(() => tree.root.find((node) => node.type === 'button' && node.props['aria-haspopup'] === 'menu').props.onClick())
    const reset = tree.root.find((node) => node.type === 'button' && node.props['aria-label'] === 'Reset reasoning to default')
    expect(reset.props.disabled).toBe(false)
    act(() => reset.props.onClick())
    expect(onChange).toHaveBeenLastCalledWith({ ...fallback, auto: false })
    expect(tree.root.findByProps({ type: 'range' })).toBeDefined()
    act(() => tree.unmount())
  })

  it('preserves the raw Max reset on Gemini Flash until a supporting model is selected', () => {
    const fallback = { driver: 'cursor' as const, model: 'cursor-claude-opus-5-5', effort: 'max' as const }
    let pin: ChatOverride = { ...fallback, model: 'cursor-gemini-3.8-flash', effort: 'low', auto: false }
    const onChange = (next: ChatOverride) => { pin = next }
    const render = () => <SingleRuntimeControl override={pin} fallback={fallback} allowAuto={false} disabled={false} onChange={onChange} />
    let tree!: ReactTestRenderer
    act(() => { tree = create(render()) })
    act(() => tree.root.find((node) => node.type === 'button' && node.props['aria-haspopup'] === 'menu').props.onClick())
    const reset = () => tree.root.find((node) => node.type === 'button' && node.props['aria-label'] === 'Reset reasoning to default')
    expect(reset().props.disabled).toBe(false)
    act(() => reset().props.onClick())
    expect(pin).toEqual({ driver: 'cursor', model: 'cursor-gemini-3.8-flash', effort: 'max', auto: false })
    act(() => tree.update(render()))
    expect(tree.root.findByProps({ type: 'range' }).props['aria-valuetext']).toBe('High')
    expect(reset().props.disabled).toBe(true)
    const modelLabel = MODELS.cursor.find((option) => option.value === fallback.model)!.label
    act(() => tree.root.findAllByType(MenuRow).find((row) => row.props.label === modelLabel)!.props.onSelect())
    act(() => tree.update(render()))
    expect(pin.effort).toBe('max')
    expect(tree.root.findByProps({ type: 'range' }).props['aria-valuetext']).toBe('Max')
    act(() => tree.unmount())
  })

  it('offers Auto on an untouched Single pin and writes a complete runtime when it is switched off', () => {
    const fallback = { driver: 'claude' as const, model: 'claude-opus-5', effort: 'high' as const }
    const onChange = vi.fn()
    let tree!: ReactTestRenderer
    act(() => {
      tree = create(
        <SingleRuntimeControl override={{}} fallback={fallback} disabled={false} onChange={onChange} />,
      )
    })
    act(() => tree.root.find((node) => node.type === 'button' && node.props.title === 'Provider, model, reasoning and speed for this chat').props.onClick())
    expect(tree.root.findByProps({ role: 'switch' }).props['aria-checked']).toBe(true)
    act(() => tree.root.findByProps({ role: 'switch' }).props.onClick())
    expect(onChange).toHaveBeenCalledWith({ ...fallback, auto: false })
    act(() => tree.unmount())
  })

  it('shows a bare reply without presenting the model as a named persona', () => {
    const reply = { kind: 'reply' as const, key: 'reply', text: 'The answer', images: [], quoteSources: [] }
    const rows: Row[] = [{
      kind: 'turn',
      key: 'turn',
      turnId: 'turn',
      agentId: '__single__',
      asks: [],
      drafts: [],
      activities: [],
      timeline: [],
      segments: [],
      answer: [reply],
      tail: [reply],
      completed: true,
    }]
    const html = renderToStaticMarkup(
      <Transcript rows={rows} agents={[]} skills={[]} hasSnapshot showSpeakers={false} />,
    )

    expect(html).toContain('The answer')
    expect(html).not.toContain('Assistant')
  })
})
