import type { BrowserImportStatus, ImportBrowserId } from '@manor/contracts'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { BrowserImportCard, BrowserImportHint, importProfileLabel } from '../src/components/BrowserImport'

const NAMES: Record<ImportBrowserId, string> = { chrome: 'Chrome', arc: 'Arc', brave: 'Brave', edge: 'Edge', dia: 'Dia' }
const status = (installed: ImportBrowserId[], over: Partial<BrowserImportStatus> = {}): BrowserImportStatus => ({
  enabled: false,
  available: installed.length > 0,
  browser: installed[0] ?? 'chrome',
  browsers: (Object.keys(NAMES) as ImportBrowserId[]).map((id) => ({ id, name: NAMES[id], installed: installed.includes(id) })),
  ...over,
})
const render = (value: BrowserImportStatus, onChange = vi.fn()) => {
  let card!: ReactTestRenderer
  act(() => { card = create(<BrowserImportCard status={value} syncing={false} onChange={onChange} />) })
  const pills = () => card.root.findAll((node) => node.type === 'button' && node.props['aria-pressed'] !== undefined)
  const toggle = () => card.root.find((node) => node.type === 'button' && node.props.role === 'switch')
  return { card, onChange, pills, toggle, text: () => JSON.stringify(card.toJSON()) }
}

it('offers only the browsers on this Mac and switches on the one that is picked', () => {
  const { onChange, pills, toggle } = render(status(['chrome', 'dia']))
  expect(pills().map((pill) => pill.children.join(''))).toEqual(['Chrome', 'Dia'])

  // Off, a pick is only a choice. Nothing reaches the desktop until the switch is thrown.
  act(() => pills()[1]!.props.onClick())
  expect(onChange).not.toHaveBeenCalled()
  expect(pills()[1]!.props['aria-pressed']).toBe(true)
  act(() => toggle().props.onClick())
  expect(onChange).toHaveBeenCalledWith(true, 'dia')
})

it('replaces the copy when another browser is picked while it is on, and turns off for the one in use', () => {
  const { onChange, pills, toggle, text } = render(status(['chrome', 'arc'], { enabled: true, browser: 'arc', profileName: 'Default' }))
  expect(text()).toContain('Using a managed copy of Arc (Default).')
  act(() => pills()[0]!.props.onClick())
  expect(onChange).toHaveBeenCalledWith(true, 'chrome')
  act(() => toggle().props.onClick())
  expect(onChange).toHaveBeenLastCalledWith(false, 'arc')
})

it('shows no picker for a single browser and nothing to switch on without one', () => {
  expect(render(status(['brave'])).pills()).toHaveLength(0)
  const none = render(status([]))
  expect(none.toggle().props.disabled).toBe(true)
  expect(none.text()).toContain('was found on this Mac')
})

it('names the profile in use and hints only while there is something to copy', () => {
  expect(importProfileLabel(null)).toBe('Default')
  expect(importProfileLabel(status(['edge'], { enabled: true, browser: 'edge', profileName: 'Profile 1' }))).toBe('Edge · Profile 1')

  const onSetUp = vi.fn()
  let hint!: ReactTestRenderer
  act(() => { hint = create(<BrowserImportHint status={status(['arc'])} onSetUp={onSetUp} onDismiss={() => undefined} />) })
  expect(JSON.stringify(hint.toJSON())).toContain('Arc')
  act(() => hint.root.findAllByType('button')[0]!.props.onClick())
  expect(onSetUp).toHaveBeenCalled()

  for (const quiet of [status([]), status(['arc'], { enabled: true })]) {
    act(() => { hint = create(<BrowserImportHint status={quiet} onSetUp={onSetUp} onDismiss={() => undefined} />) })
    expect(hint.toJSON()).toBeNull()
  }
})
