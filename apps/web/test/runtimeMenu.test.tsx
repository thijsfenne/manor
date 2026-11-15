import type { AgentConfig, ChatOverride } from '@manor/contracts'
import type { ComponentProps, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { AutoRulesConfigProvider } from '../src/components/settings/AutoRulesPage'
import { MenuRow, RuntimeMenu, RuntimeSections } from '../src/components/RuntimeMenu'
import { RuntimeControls } from '../src/components/RuntimeControls'
import { RuntimeRoster } from '../src/components/RuntimeRoster'
import { RuntimeLabel } from '../src/components/RuntimeLabel'
import { SteppedSlider } from '../src/components/ui/SteppedSlider'
import { effortsFor, MODELS } from '../src/runtimes'

vi.mock('../src/components/ui/Popover', () => ({
  Popover: ({ open, children, className }: { open: boolean; children: ReactNode; className?: string }) =>
    open ? <div className={className}>{children}</div> : null,
}))
vi.mock('../src/components/ui/useDismiss', () => ({ useDismiss: () => {} }))

const agent = (driver: AgentConfig['driver'], model: string): AgentConfig => ({
  id: 'jeeves',
  name: 'Jeeves',
  color: '#8B7EC8',
  character: 'Chief of staff.',
  driver,
  model,
  effort: 'high',
  allowedTools: [],
  mcpServers: [],
  memoryScope: false,
  description: '',
  role: '',
  isCos: true,
})

describe('runtime sections', () => {
  it('keeps house Auto off the roster list', () => {
    const agents = [agent('codex', 'gpt-5.6-sol'), { ...agent('grok', 'grok-4.6'), id: 'sage' }]
    const html = renderToStaticMarkup(
      <RuntimeRoster
        agents={agents}
        overrides={{}}
        onChange={() => {}}
        nav={{ selectedId: null, direction: null, enter: () => {}, back: () => {}, reset: () => {} }}
      />,
    )
    expect(html).not.toContain('Auto mode')
    expect(html).toContain('Jeeves')
  })

  it('puts Auto above the provider choices and switches it', () => {
    const changed = vi.fn()
    let tree!: ReactTestRenderer
    act(() => { tree = create(<RuntimeSections agent={agent('codex', 'gpt-5.6-sol')} override={{}}
      onChange={changed} />) })
    act(() => tree.root.findByProps({ role: 'switch' }).props.onClick())
    expect(changed).toHaveBeenCalledWith({ auto: false })
    const html = renderToStaticMarkup(
      <AutoRulesConfigProvider open={() => {}}>
        <RuntimeSections agent={agent('codex', 'gpt-5.6-sol')} override={{ auto: true }} onChange={() => {}} />
      </AutoRulesConfigProvider>,
    )
    expect(html.indexOf('Auto mode')).toBeLessThan(html.indexOf('role="switch"'))
    expect(html.indexOf('role="switch"')).toBeLessThan(html.indexOf('Auto mode rules'))
    expect(html.indexOf('Auto mode')).toBeLessThan(html.indexOf('radiogroup'))
    expect(html).toContain('text-label')
    const bare = renderToStaticMarkup(<RuntimeSections agent={agent('codex', 'gpt-5.6-sol')} override={{}} allowAuto={false} onChange={() => {}} />)
    expect(bare).not.toContain('Auto mode')
    act(() => tree.unmount())
  })

  it('offers Auto only in a persona menu before that persona starts', () => {
    const agents = [agent('codex', 'gpt-5.6-sol'), { ...agent('grok', 'grok-4.6'), id: 'sage' }]
    const nav = { selectedId: null, direction: null, enter: vi.fn(), back: vi.fn(), reset: vi.fn() } as const
    const overview = renderToStaticMarkup(
      <RuntimeRoster agents={agents} overrides={{}} startedAgentIds={['jeeves']} onChange={() => {}} nav={nav} />,
    )
    expect(overview).not.toContain('Auto mode')

    const started = renderToStaticMarkup(
      <RuntimeRoster agents={agents} overrides={{}} startedAgentIds={['jeeves']} onChange={() => {}}
        nav={{ ...nav, selectedId: 'jeeves' }} />,
    )
    expect(started).not.toContain('Auto mode')

    const unused = renderToStaticMarkup(
      <RuntimeRoster agents={agents} overrides={{}} startedAgentIds={['jeeves']} onChange={() => {}}
        nav={{ ...nav, selectedId: 'sage' }} />,
    )
    expect(unused).toContain('Auto mode')

    const resolved = renderToStaticMarkup(
      <RuntimeRoster agents={agents} overrides={{ sage: { autoResolved: true } }} onChange={() => {}}
        nav={{ ...nav, selectedId: 'sage' }} />,
    )
    expect(resolved).not.toContain('Auto mode')
  })

  // Rendered rather than called: a compiled component keeps its cache in a hook.
  const directMenuAllowsAuto = (props: Partial<ComponentProps<typeof RuntimeControls>>) => {
    let tree!: ReactTestRenderer
    act(() => {
      tree = create(<RuntimeControls agents={[agent('codex', 'gpt-5.6-sol')]} overrides={{}} disabled={false} onChange={() => {}} {...props} />)
    })
    const allowAuto = tree.root.findByType(RuntimeMenu).props.allowAuto
    act(() => tree.unmount())
    return allowAuto
  }

  it('hides Auto in a direct persona menu after that persona starts', () => {
    expect(directMenuAllowsAuto({ startedAgentIds: ['jeeves'] })).toBe(false)
  })

  it('hides Auto in a persona menu when the composer strip already owns it', () => {
    expect(directMenuAllowsAuto({ allowAuto: false })).toBe(false)
  })

  it('pads the folded roster equally above the first row and below the last', () => {
    const house = ['Jeeves', 'Sage', 'Smith', 'Wren'].map((name) => ({
      ...agent('claude', 'claude-opus-5'),
      id: name.toLowerCase(),
      name,
    }))
    let tree!: ReactTestRenderer
    act(() => {
      tree = create(<RuntimeControls agents={house} overrides={{}} disabled={false} onChange={() => {}} />)
    })
    act(() => tree.root.find((node) => node.props.title === 'Model and reasoning per agent, for this chat').props.onClick())
    expect(tree.root.find((node) => typeof node.props.className === 'string' && node.props.className.includes('w-[360px]')).props.className).toContain('surface-floating p-1')
    act(() => tree.unmount())
  })

  it('uses the Fast icon in the compact DM composer control', () => {
    const html = renderToStaticMarkup(
      <RuntimeMenu
        agent={agent('cursor', 'cursor-gpt-5.6-sol')}
        override={{ speed: 'fast' }}
        disabled={false}
        onChange={() => {}}
      />,
    )

    expect(html).toContain('title="Fast mode"')
    expect(html).toContain('class="sr-only">Fast mode</span>')
    expect(html).not.toContain('>Fast<')
  })

  it('does not show a provider mark before Auto resolves', () => {
    const html = renderToStaticMarkup(
      <RuntimeMenu
        agent={agent('grok', 'grok-4.6')}
        override={{ auto: true }}
        disabled={false}
        onChange={() => {}}
      />,
    )

    expect(html).toContain('Auto')
    expect(html).not.toContain('provider-mark-grok')
  })

  it('uses compact logo-only provider tabs and offers Fast mode for Cursor', () => {
    const html = renderToStaticMarkup(
      <RuntimeSections agent={agent('cursor', 'cursor-grok-4.7')} override={{}} onChange={() => {}} />,
    )

    expect(html).toContain('role="radiogroup"')
    expect(html).toContain('aria-label="Claude Code"')
    expect(html).toContain('aria-label="Cursor, Default"')
    expect(html).toContain('class="inline-flex items-center w-full gap-1"')
    expect(html.match(/h-10 min-w-0 flex-1/g)).toHaveLength(4)
    expect(html).not.toContain('>Provider<')
    expect(html).not.toContain('>Claude Code<')
    expect(html).not.toContain('rounded-full bg-surface-2')
    expect(html.match(/class="absolute inset-0 z-0 rounded-\[inherit\] bg-menu-selected"/g)).toHaveLength(1)
    expect(html).toContain('aria-label="Fast mode"')
    expect(html).toContain('aria-pressed="false"')
  })

  it('reserves the longest provider model list, whichever provider is showing', () => {
    let tree!: ReactTestRenderer
    act(() => { tree = create(<RuntimeSections agent={agent('grok', 'grok-4.6')} override={{}} onChange={() => {}} />) })
    const sizer = tree.root.find((node) => node.props['aria-hidden'] === 'true' && String(node.props.className).includes('invisible'))
    const longest = Math.max(...(['claude', 'codex', 'grok', 'cursor'] as const).map((driver) => MODELS[driver].length))
    expect(longest).toBeGreaterThan(MODELS.grok.length)
    expect(sizer.findAllByType(MenuRow)).toHaveLength(longest)
    act(() => tree.unmount())
  })

  it('does not offer a speed control where the provider has no fast tier', () => {
    const html = renderToStaticMarkup(
      <RuntimeSections agent={agent('grok', 'grok-4.6')} override={{}} onChange={() => {}} />,
    )

    expect(html).not.toContain('Fast mode')
  })

  it.each([false, true])('freezes the sizing label until dismissal (compact %s)', (compact) => {
    let tree!: ReactTestRenderer
    const voice = agent('codex', 'gpt-5.6-sol')
    act(() => { tree = create(<RuntimeMenu agent={voice} override={{ auto: false }} compact={compact} disabled={false} onChange={() => {}} />) })
    const initialLabel = tree.root.findByType(RuntimeLabel).props
    const trigger = () => tree.root.find((node) => node.type === 'button' && node.props['aria-haspopup'] === 'menu')
    act(() => trigger().props.onClick())
    act(() => tree.update(<RuntimeMenu agent={voice} override={{ auto: false, model: 'gpt-6-astra', effort: 'max', speed: 'fast' }} compact={compact} disabled={false} onChange={() => {}} />))
    expect(trigger().props['aria-expanded']).toBe(true)
    expect(tree.root.findByType(RuntimeLabel).props).toEqual(initialLabel)
    expect(tree.root.findByProps({ type: 'range' }).props['aria-valuetext']).toBe('Max')
    act(() => trigger().props.onClick())
    expect(tree.root.findByType(RuntimeLabel).props.effort).toBe('Max')
    expect(tree.root.findByType(RuntimeLabel).props.model).not.toBe(initialLabel.model)
    act(() => tree.unmount())
  })

  it('maps sparse model capabilities to consecutive stops and updates them on a model change', () => {
    const changed = vi.fn()
    let tree!: ReactTestRenderer
    act(() => { tree = create(<RuntimeSections agent={agent('cursor', 'cursor-kimi-k3')} override={{}} onChange={changed} />) })
    expect(tree.root.findByType(SteppedSlider).props.options.map((option: { value: string }) => option.value)).toEqual(['low', 'high', 'max'])
    act(() => tree.root.findByProps({ type: 'range' }).props.onChange({ currentTarget: { value: '2' } }))
    expect(changed).toHaveBeenLastCalledWith({ effort: 'max' })
    act(() => tree.update(<RuntimeSections agent={agent('cursor', 'cursor-composer-2.5')} override={{ effort: 'max' }} onChange={changed} />))
    expect(tree.root.findByProps({ type: 'range' }).props.disabled).toBe(true)
    expect(tree.root.findByProps({ type: 'range' }).props['aria-valuetext']).toBe('High')
    act(() => tree.unmount())
  })

  it.each(['claude', 'codex', 'grok', 'cursor', 'mock'] as const)('uses the shared effort ladder for %s', (driver) => {
    let tree!: ReactTestRenderer
    act(() => { tree = create(<RuntimeSections agent={agent(driver, '')} override={{}} onChange={() => {}} />) })
    expect(tree.root.findByType(SteppedSlider).props.options).toEqual(effortsFor(driver, ''))
    act(() => tree.unmount())
  })

  it('resets reasoning without losing a pinned model or fast speed', () => {
    const changed = vi.fn()
    let tree!: ReactTestRenderer
    act(() => { tree = create(<RuntimeSections agent={agent('codex', 'gpt-5.6-sol')} override={{ model: 'gpt-6-astra', effort: 'max', speed: 'fast' }} onChange={changed} />) })
    const reset = tree.root.find((node) => node.type === 'button' && node.props['aria-label'] === 'Reset reasoning to default')
    expect(reset.props.disabled).toBe(false)
    act(() => reset.props.onClick())
    expect(changed).toHaveBeenLastCalledWith({ model: 'gpt-6-astra', speed: 'fast' })
    act(() => tree.unmount())
  })

  it('resets a Max persona on Grok without pinning its displayed High fallback', () => {
    const voice = { ...agent('claude', 'claude-opus-5'), effort: 'max' as const }
    let pin: ChatOverride = { driver: 'grok', model: 'grok-4.7', effort: 'low' }
    const onChange = (next: ChatOverride) => { pin = next }
    const render = () => <RuntimeSections agent={voice} override={pin} onChange={onChange} />
    let tree!: ReactTestRenderer
    act(() => { tree = create(render()) })
    const reset = () => tree.root.find((node) => node.type === 'button' && node.props['aria-label'] === 'Reset reasoning to default')
    expect(reset().props.disabled).toBe(false)
    act(() => reset().props.onClick())
    expect(pin).toEqual({ driver: 'grok', model: 'grok-4.7' })
    act(() => tree.update(render()))
    expect(tree.root.findByProps({ type: 'range' }).props['aria-valuetext']).toBe('High')
    expect(reset().props.disabled).toBe(true)
    act(() => tree.root.findByProps({ 'aria-label': 'Claude Code, Default' }).props.onClick())
    act(() => tree.update(render()))
    expect(tree.root.findByProps({ type: 'range' }).props['aria-valuetext']).toBe('Max')
    act(() => tree.unmount())
  })

  it('toggles Fast mode from the reasoning header without closing', () => {
    const changed = vi.fn()
    const voice = agent('cursor', 'cursor-gpt-5.6-sol')
    const fastButton = (tree: ReactTestRenderer) =>
      tree.root.find((node) => node.type === 'button' && node.props['aria-label'] === 'Fast mode')
    let tree!: ReactTestRenderer
    act(() => { tree = create(<RuntimeSections agent={voice} override={{ effort: 'low' }} onChange={changed} />) })
    act(() => fastButton(tree).props.onClick())
    expect(changed).toHaveBeenLastCalledWith({ effort: 'low', speed: 'fast' })
    act(() => tree.update(<RuntimeSections agent={voice} override={{ effort: 'low', speed: 'fast' }} onChange={changed} />))
    expect(fastButton(tree).props['aria-pressed']).toBe(true)
    act(() => fastButton(tree).props.onClick())
    expect(changed).toHaveBeenLastCalledWith({ effort: 'low' })
    act(() => tree.unmount())
  })
})
