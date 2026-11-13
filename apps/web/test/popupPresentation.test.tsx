import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { AnimatePresence } from 'motion/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Popover } from '../src/components/ui/Popover'
import { Select } from '../src/components/ui/Select'

vi.mock('react-dom', async (original) => ({ ...await original<typeof import('react-dom')>(), createPortal: (child: unknown) => child }))
vi.mock('../src/components/ui/usePopupPlacement', () => ({ usePopupPlacement: () => ({ left: 0, top: 40, width: 200, maxHeight: 288 }) }))
let tree: ReactTestRenderer | undefined
beforeEach(() => {
  vi.stubGlobal('document', { body: {}, addEventListener: vi.fn(), removeEventListener: vi.fn() })
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
})
afterEach(() => { act(() => tree?.unmount()); tree = undefined; vi.unstubAllGlobals() })
const visible = () => !!tree!.root.findByType(AnimatePresence).props.children

describe('DOM popup presentation', () => {
  it('opens immediately and focuses once, without refocusing on new callback identities', () => {
    const first = vi.fn(), next = vi.fn()
    act(() => { tree = create(<Popover open onReady={first}>Menu</Popover>) })
    expect(visible()).toBe(true)
    expect(first).toHaveBeenCalledOnce()
    act(() => tree!.update(<Popover open onReady={next}>Updated menu</Popover>))
    expect(next).not.toHaveBeenCalled()
    act(() => tree!.update(<Popover open={false}>Menu</Popover>))
    expect(visible()).toBe(false)
  })
  it('opens presets immediately and retains keyboard selection and focus return', () => {
    const onChange = vi.fn(), focus = vi.fn()
    act(() => { tree = create(<Select label="Preset" value="desktop" options={[{ value: 'desktop', label: 'Desktop' }, { value: 'mobile', label: 'Mobile' }]} onChange={onChange} />, {
      createNodeMock: (element) => element.props.role === 'combobox' ? { focus } : null,
    }) })
    const trigger = () => tree!.root.findByProps({ role: 'combobox' })
    act(() => trigger().props.onClick())
    expect(visible()).toBe(true)
    act(() => trigger().props.onKeyDown({ key: 'ArrowDown', preventDefault: vi.fn() }))
    act(() => trigger().props.onKeyDown({ key: 'Enter', preventDefault: vi.fn() }))
    expect(onChange).toHaveBeenCalledWith('mobile')
    expect(focus).toHaveBeenCalled()
    expect(visible()).toBe(false)
  })
})
