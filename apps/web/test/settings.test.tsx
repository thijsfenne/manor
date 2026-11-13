import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutoRules, AutoRulesDraft, ContextFile, ProviderUsage } from '@manor/contracts'
import { AccountPopover } from '../src/components/AccountPopover'
import { AutoRulesPage } from '../src/components/settings/AutoRulesPage'
import { reconcileDrafts } from '../src/components/settings/ContextFilesPage'
import { ThemePicker } from '../src/components/settings/ThemePicker'
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
  const Harness = () => {
    controller = useSettings()
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
  it('keeps only the chosen card in the tab order and moves the choice with the arrows', () => {
    const onChange = vi.fn()
    act(() => {
      tree = create(<ThemePicker choice="dark" onChange={onChange} />, { createNodeMock: () => ({ focus: () => {} }) })
    })
    const cards = tree!.root.findAll((node) => node.type === 'button' && node.props.role === 'radio')
    expect(cards.map((card) => card.props['aria-checked'])).toEqual([false, true, false])
    expect(cards.map((card) => card.props.tabIndex)).toEqual([-1, 0, -1])

    act(() => cards[1]!.props.onKeyDown({ key: 'ArrowRight', preventDefault: () => {} }))
    expect(onChange).toHaveBeenLastCalledWith('system')
    act(() => cards[1]!.props.onKeyDown({ key: 'ArrowLeft', preventDefault: () => {} }))
    expect(onChange).toHaveBeenLastCalledWith('light')
  })
})
