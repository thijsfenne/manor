import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutoRules, AutoRulesDraft, ContextFile, ProviderUsage } from '@manor/contracts'
import { AccountPopover } from '../src/components/AccountPopover'
import { AutoRulesPage } from '../src/components/settings/AutoRulesPage'
import { reconcileDrafts } from '../src/components/settings/ContextFilesPage'
import { ModePicker, ThemeGrid } from '../src/components/settings/ThemePicker'
import type { RequestResponse } from '../src/useRequest'
import { isSettingsShortcut, isWorkspaceShortcut } from '../src/components/settings/sections'
import { useSettings, type SettingsController } from '../src/useSettings'

vi.mock('../src/components/ui/useDismiss', () => ({ useDismiss: () => {} }))
vi.mock('../src/components/ui/Select', () => ({ Select: () => null }))

let tree: ReactTestRenderer | undefined
beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
})
afterEach(() => {
  act(() => tree?.unmount())
  tree = undefined
  vi.unstubAllGlobals()
})

const key = (key: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {}) =>
  ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, repeat: false, ...mods })

describe('settings guard', () => {
  let controller: SettingsController
  const Harness = ({ live = true }: { live?: boolean }) => {
    controller = useSettings(live)
    return null
  }

  it('asks before an unsaved edit is left behind, and goes once it is discarded', () => {
    act(() => { tree = create(<Harness />) })
    act(() => controller.open('agents', 'sage'))
    act(() => controller.reportDirty(true))

    act(() => controller.close())
    expect(controller.leaving).toBe(true)
    expect(controller.location).toEqual({ section: 'agents', agentId: 'sage' })

    act(() => controller.keepEditing())
    expect(controller.leaving).toBe(false)
    expect(controller.location).toEqual({ section: 'agents', agentId: 'sage' })

    act(() => controller.open('context'))
    act(() => controller.discard())
    expect(controller.location).toEqual({ section: 'context' })
  })

  it('leaves at once when nothing is unsaved', () => {
    act(() => { tree = create(<Harness />) })
    act(() => controller.open('general'))
    act(() => controller.close())
    expect(controller.leaving).toBe(false)
    expect(controller.location).toBeNull()
  })

  it('reopens the same page after a reload of the tab, and stays closed once closed', () => {
    const stored = new Map<string, string>()
    vi.stubGlobal('window', { sessionStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => { stored.set(key, value) },
      removeItem: (key: string) => { stored.delete(key) },
    } })
    const reload = () => {
      act(() => tree?.unmount())
      act(() => { tree = create(<Harness />) })
    }

    act(() => { tree = create(<Harness />) })
    expect(controller.location).toBeNull()
    act(() => controller.open('permissions'))
    // The restored page waits for the socket, since it asks for its data once on mount.
    act(() => tree?.unmount())
    act(() => { tree = create(<Harness live={false} />) })
    expect(controller.location).toBeNull()
    act(() => tree?.update(<Harness live />))
    expect(controller.location).toEqual({ section: 'permissions' })
    // A later reconnect leaves the open page where it is.
    act(() => tree?.update(<Harness live={false} />))
    expect(controller.location).toEqual({ section: 'permissions' })

    act(() => controller.open('agents', 'sage'))
    reload()
    expect(controller.location).toEqual({ section: 'agents', agentId: 'sage' })

    act(() => controller.close())
    reload()
    expect(controller.location).toBeNull()

    stored.set('manor:settings-location', '{"section":"retired-page"}')
    reload()
    expect(controller.location).toBeNull()
  })

  it('opens on the page shown last when none is named, also after a restart', () => {
    const local = new Map<string, string>()
    const storage = (map: Map<string, string>) => ({
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => { map.set(key, value) },
      removeItem: (key: string) => { map.delete(key) },
    })
    vi.stubGlobal('window', { sessionStorage: storage(new Map()), localStorage: storage(local) })

    act(() => { tree = create(<Harness />) })
    act(() => controller.open())
    expect(controller.location).toEqual({ section: 'general' })
    act(() => controller.open('voice'))
    act(() => controller.close())
    act(() => controller.open())
    expect(controller.location).toEqual({ section: 'voice' })

    // A restart starts with a fresh tab: only the last page carries over.
    act(() => controller.close())
    vi.stubGlobal('window', { sessionStorage: storage(new Map()), localStorage: storage(local) })
    act(() => tree?.unmount())
    act(() => { tree = create(<Harness />) })
    expect(controller.location).toBeNull()
    act(() => controller.open())
    expect(controller.location).toEqual({ section: 'voice' })

    local.set('manor:settings-last-section', 'usage')
    act(() => controller.close())
    act(() => controller.open())
    expect(controller.location).toEqual({ section: 'general' })
  })
})

describe('context file drafts', () => {
  const file = (content: string, hash: string): ContextFile => ({ name: 'soul.md', content, hash, updatedAt: '2026-10-04T10:00:00.000Z' })

  it('follows the disk while nothing is edited', () => {
    const drafts = reconcileDrafts({}, [file('one', 'h1')])
    expect(reconcileDrafts(drafts, [file('two', 'h2')])['soul.md']).toEqual({ text: 'two', base: 'h2', baseContent: 'two' })
  })

  it('takes its own save as the new version', () => {
    const drafts = { 'soul.md': { text: 'mine', base: 'h1', baseContent: 'one' } }
    expect(reconcileDrafts(drafts, [file('mine', 'h2')])['soul.md']).toEqual({ text: 'mine', base: 'h2', baseContent: 'mine' })
  })

  it('takes its own save as the base while typing went on past it', () => {
    const drafts = { 'soul.md': { text: 'mine, then more', base: 'h1', baseContent: 'one', sent: 'mine' } }
    expect(reconcileDrafts(drafts, [file('mine', 'h2')])['soul.md']).toEqual({ text: 'mine, then more', base: 'h2', baseContent: 'mine' })
  })

  it('keeps typed text over an outside edit, so the conflict stays visible', () => {
    const drafts = { 'soul.md': { text: 'mine', base: 'h1', baseContent: 'one' } }
    expect(reconcileDrafts(drafts, [file('theirs', 'h2')])).toBe(drafts)
  })
})

describe('auto mode rules', () => {
  const rules: AutoRules = { research: { description: 'Original', driver: 'claude', model: 'claude-opus-5-5', effort: 'high' } }
  let answer: (response: RequestResponse) => void = () => {}
  const events = { subscribe: (listener: (response: RequestResponse) => void) => { answer = listener; return () => {} } }
  const onSave = vi.fn<(rules: AutoRulesDraft, requestId: string) => boolean>(() => true)
  const page = (current: AutoRules) => (
    <AutoRulesPage rules={current} notice={null} requestEvents={events} onSave={onSave} onDismissNotice={() => {}} onDirtyChange={() => {}} onRequest={() => {}} />
  )
  const field = () => tree!.root.find((node) => node.type === 'textarea' && node.props['aria-label'] === 'Rule description')
  const status = () => tree!.root.find((node) => node.type === 'span' && node.props.role === 'status').children.join('')

  it('saves on ⌘S and keeps typing done while the save was out', () => {
    act(() => { tree = create(page(rules)) })
    act(() => field().props.onChange({ target: { value: 'Sent' } }))
    const keys = tree!.root.find((node) => node.props['data-settings-save'] === true)
    act(() => keys.props.onKeyDown({ ...key('s', { metaKey: true }), preventDefault: () => {}, stopPropagation: () => {} }))
    expect(onSave.mock.calls[0]?.[0].research?.description).toBe('Sent')

    act(() => field().props.onChange({ target: { value: 'Sent, then more' } }))
    // The file is broadcast before the save is acknowledged.
    const written = { research: { ...rules.research!, description: 'Sent' } }
    act(() => tree!.update(page(written)))
    act(() => answer({ type: 'ack', requestId: onSave.mock.calls[0]![1] }))
    expect(field().props.value).toBe('Sent, then more')
    expect(status()).toBe('Unsaved changes')
  })
})

describe('settings keys', () => {
  it('opens on ⌘, and shields the workspace keys, not editing keys', () => {
    expect(isSettingsShortcut(key(',', { metaKey: true }))).toBe(true)
    for (const pressed of ['k', 's', 'n', 'd', 'b', '[', '1']) expect(isWorkspaceShortcut(key(pressed, { metaKey: true }))).toBe(true)
    expect(isWorkspaceShortcut(key('Tab', { ctrlKey: true }))).toBe(true)
    for (const pressed of ['c', 'v', 'z', 'a', ',']) expect(isWorkspaceShortcut(key(pressed, { metaKey: true }))).toBe(false)
    expect(isWorkspaceShortcut(key('Escape'))).toBe(false)
  })
})

describe('account popover', () => {
  const usage: ProviderUsage[] = [{ provider: 'claude', status: 'ok', fetchedAt: 0, windows: [{ label: '5h', usedPercent: 18 }] }]

  it('opens on the face with usage left, the theme and Settings', () => {
    const onOpenSettings = vi.fn()
    const onTheme = vi.fn()
    const onOpenUsage = vi.fn()
    act(() => {
      tree = create(
        <AccountPopover
          name="Sam Example"
          photo="./images/sam.webp"
          providerUsage={usage}
          theme="dark"
          size={40}
          onTheme={onTheme}
          onOpenUsage={onOpenUsage}
          onOpenSettings={onOpenSettings}
        />,
        { createNodeMock: () => ({ focus: () => {}, querySelector: () => null }) },
      )
    })
    const buttons = () => tree!.root.findAllByType('button')
    const named = (label: string) => buttons().find((node) => String(node.props['aria-label'] ?? '').startsWith(label) || node.findAll((child) => child.children.includes(label)).length > 0)!

    expect(named('Settings')).toBeUndefined()
    act(() => named('Sam Example, account').props.onClick())

    expect(named('Usage').props['aria-label']).toBe('Usage, Claude 82% left')
    act(() => named('Light').props.onClick())
    expect(onTheme).toHaveBeenCalledWith('light')
    act(() => named('Settings').props.onClick())
    expect(onOpenSettings).toHaveBeenCalledOnce()
  })
})

describe('theme picker', () => {
  it('keeps only the chosen mode card in the tab order and moves the choice with the arrows', () => {
    const onChange = vi.fn()
    act(() => {
      tree = create(<ModePicker choice="dark" themes={{ light: 'manor', dark: 'manor' }} onChange={onChange} />, { createNodeMock: () => ({ focus: () => {} }) })
    })
    const cards = tree!.root.findAll((node) => node.type === 'button' && node.props.role === 'radio')
    expect(cards.map((card) => card.props['aria-checked'])).toEqual([false, false, true])
    expect(cards.map((card) => card.props.tabIndex)).toEqual([-1, -1, 0])

    act(() => cards[2]!.props.onKeyDown({ key: 'ArrowRight', preventDefault: () => {} }))
    expect(onChange).toHaveBeenLastCalledWith('system')
    act(() => cards[2]!.props.onKeyDown({ key: 'ArrowLeft', preventDefault: () => {} }))
    expect(onChange).toHaveBeenLastCalledWith('light')
  })

  it('draws the page\'s own edge over every mode card, System included', () => {
    act(() => {
      tree = create(<ModePicker choice="dark" themes={{ light: 'manor', dark: 'manor' }} onChange={() => {}} />, { createNodeMock: () => ({ focus: () => {} }) })
    })
    const cards = tree!.root.findAll((node) => node.type === 'button' && node.props.role === 'radio')
    expect(cards).toHaveLength(3)
    for (const card of cards) {
      const edge = card.findAll((node) => node.type === 'span' && node.props['data-preview-edge'] !== undefined)
      expect(edge).toHaveLength(1)
      expect(edge[0]!.props.className).toContain('border-line')
    }
  })

  it('picks the light and the dark theme apart, from different themes', () => {
    const onChange = vi.fn()
    act(() => {
      tree = create(<ThemeGrid themes={{ light: 'parchment', dark: 'manor' }} onChange={onChange} />)
    })
    const orb = (label: string) => tree!.root.find((node) => node.type === 'button' && node.props['aria-label'] === label)
    expect(orb('Parchment for light mode').props['aria-pressed']).toBe(true)
    expect(orb('Parchment for dark mode').props['aria-pressed']).toBe(false)

    act(() => orb('Indigo for dark mode').props.onClick())
    expect(onChange).toHaveBeenLastCalledWith({ light: 'parchment', dark: 'indigo' })
    onChange.mockClear()
    act(() => orb('Parchment for light mode').props.onClick())
    expect(onChange).not.toHaveBeenCalled()
  })
})
