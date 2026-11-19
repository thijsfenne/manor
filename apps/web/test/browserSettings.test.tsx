import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { DEFAULT_HOUSE_SETTINGS, type HouseSettings } from '@manor/contracts'
import { BrowserGroup } from '../src/components/settings/BrowserSettings'

vi.mock('motion/react', () => ({
  motion: { div: (props: Record<string, unknown>) => <div {...props} />, span: (props: Record<string, unknown>) => <span {...props} /> },
  AnimatePresence: ({ children }: { children: unknown }) => children,
  useReducedMotion: () => true,
}))
// The real Select portals its menu into document.body; this stand-in shows its options and picks Kagi.
vi.mock('../src/components/ui/Select', () => ({
  Select: ({ value, options, onChange }: { value: string; options: { label: string }[]; onChange: (value: string) => void }) => (
    <button data-value={value} onClick={() => onChange('kagi')}>{options.map((option) => option.label).join(', ')}</button>
  ),
}))

afterEach(() => { vi.unstubAllGlobals() })

function render(settings: HouseSettings | null) {
  const onSave = vi.fn()
  let group!: ReactTestRenderer
  act(() => { group = create(<BrowserGroup settings={settings} onSave={onSave} />) })
  const button = (text: string) => group.root.findAll((node) => node.type === 'button' && node.children.join('').includes(text))[0]!
  return { group, onSave, button }
}

it('shows nothing outside the desktop app or before the settings have arrived', () => {
  expect(render(DEFAULT_HOUSE_SETTINGS).group.toJSON()).toBe(null)
  vi.stubGlobal('window', { manorDesktop: { browser: {} } })
  expect(render(null).group.toJSON()).toBe(null)
})

it('lists the engines by name, saves a pick at once and restores the default', () => {
  vi.stubGlobal('window', { manorDesktop: { browser: {} } })
  // A kept setting that is not at its default, so a save that resets the rest shows.
  const kept = { ...DEFAULT_HOUSE_SETTINGS, backupRetentionDays: 30 }
  const { onSave, button } = render(kept)
  expect(button('Google').children.join('')).toBe('Google, DuckDuckGo, Bing, Brave Search, Ecosia, Kagi')
  expect(button('Restore defaults').props.disabled).toBe(true)
  act(() => button('Google').props.onClick())
  expect(onSave).toHaveBeenCalledWith({ ...kept, browserSearchEngine: 'kagi' })

  const picked = render({ ...kept, browserSearchEngine: 'kagi' })
  expect(picked.button('Restore defaults').props.disabled).toBe(false)
  act(() => picked.button('Restore defaults').props.onClick())
  expect(picked.onSave).toHaveBeenCalledWith(kept)
})
