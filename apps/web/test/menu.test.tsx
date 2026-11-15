import { forwardRef, type CSSProperties, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Menu, MenuItem, menuFocusIndex, useMenu } from '../src/components/ui/Menu'

vi.mock('react-dom', async (original) => ({ ...await original<typeof import('react-dom')>(), createPortal: (child: unknown) => child }))
// The sheet without its motion: motion refuses a ref that is not a real element, and the
// focus case below hands the card a stand-in to read the rows from.
vi.mock('../src/components/ui/Popover', () => ({
  Popover: forwardRef<HTMLDivElement, { open: boolean; className?: string; style?: CSSProperties; role?: string; 'aria-label'?: string; children: ReactNode }>(
    function Popover({ open, className, style, role, 'aria-label': label, children }, ref) {
      return open ? <div ref={ref} className={className} style={style}><div role={role} aria-label={label}>{children}</div></div> : null
    }),
}))

let tree: ReactTestRenderer | undefined
let listeners: Record<string, (event: unknown) => void>
beforeEach(() => {
  listeners = {}
  const addEventListener = (name: string, listener: (event: unknown) => void) => { listeners[name] = listener }
  vi.stubGlobal('document', { body: {}, addEventListener, removeEventListener: vi.fn() })
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal('window', { innerHeight: 800, innerWidth: 1200, addEventListener: vi.fn(), removeEventListener: vi.fn() })
})
afterEach(() => { act(() => tree?.unmount()); tree = undefined; vi.unstubAllGlobals() })

function Sample({ disabled = false, onClose, onPick }: { disabled?: boolean; onClose?: () => void; onPick?: () => void }) {
  const [menu, trigger] = useMenu({ maxHeight: 300, minHeight: 100, minWidth: 200, disabled, onClose })
  return <>
    <button ref={trigger} type="button" aria-label="Open" aria-expanded={menu.open} onClick={menu.toggle} />
    <Menu menu={menu} label="Sample">
      <button type="button" role="menuitem" aria-label="Pick" onClick={() => { menu.close(); onPick?.() }} />
    </Menu>
  </>
}

const button = (name: string) => tree!.root.findAllByProps({ 'aria-label': name }).find((node) => node.type === 'button')
const expanded = () => button('Open')!.props['aria-expanded'] as boolean

describe('menu', () => {
  it('picks the row for an arrow key, Home and End, and wraps at both ends', () => {
    expect(menuFocusIndex('ArrowDown', 0, 3)).toBe(1)
    expect(menuFocusIndex('ArrowDown', 2, 3)).toBe(0)
    expect(menuFocusIndex('ArrowUp', 0, 3)).toBe(2)
    expect(menuFocusIndex('Home', 2, 3)).toBe(0)
    expect(menuFocusIndex('End', 0, 3)).toBe(2)
    expect(menuFocusIndex('Enter', 0, 3)).toBeUndefined()
    expect(menuFocusIndex('ArrowDown', -1, 0)).toBeUndefined()
  })

  it('opens from its trigger, and closes on a pick, on Escape and when the trigger goes dead', () => {
    const onClose = vi.fn()
    const onPick = vi.fn()
    act(() => { tree = create(<Sample onClose={onClose} onPick={onPick} />) })
    expect(button('Pick')).toBeUndefined()

    act(() => button('Open')!.props.onClick())
    expect(tree!.root.findByProps({ role: 'menu' }).props['aria-label']).toBe('Sample')
    act(() => button('Pick')!.props.onClick())
    expect(onPick).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
    expect(expanded()).toBe(false)

    act(() => button('Open')!.props.onClick())
    act(() => listeners.keydown!({ key: 'Escape', preventDefault() {}, stopPropagation() {} }))
    expect(expanded()).toBe(false)
    expect(onClose).toHaveBeenCalledTimes(2)

    act(() => button('Open')!.props.onClick())
    act(() => tree!.update(<Sample disabled onClose={onClose} onPick={onPick} />))
    expect(expanded()).toBe(false)
    expect(onClose).toHaveBeenCalledTimes(3)

    act(() => tree!.update(<Sample onClose={onClose} onPick={onPick} />))
    act(() => button('Open')!.props.onClick())
    act(() => button('Open')!.props.onClick())
    expect(expanded()).toBe(false)
    expect(onClose).toHaveBeenCalledTimes(4)
  })

  it('marks the row in use with a tick, and a blocked row says why and cannot be taken', () => {
    const onPick = vi.fn()
    act(() => { tree = create(<>
      <MenuItem role="menuitemradio" checked aria-label="On">On</MenuItem>
      <MenuItem role="menuitemradio" checked={false} aria-label="Off">Off</MenuItem>
      <MenuItem blocked="Close a panel first" aria-label="Full" onClick={onPick}>Full</MenuItem>
    </>) })
    expect(button('On')!.props['aria-checked']).toBe(true)
    expect(button('On')!.findAllByType('svg')).toHaveLength(1)
    expect(button('Off')!.props['aria-checked']).toBe(false)
    expect(button('Off')!.findAllByType('svg')).toHaveLength(0)
    expect(button('Full')!.props).toMatchObject({ role: 'menuitem', 'aria-disabled': true, title: 'Close a panel first' })
    expect(button('Full')!.props.disabled).toBeUndefined()
    expect(button('Full')!.props.onClick).toBeUndefined()
    expect(onPick).not.toHaveBeenCalled()
  })

  it('hands focus to the first row on the first open, and moves it with the keys', () => {
    const rows = [{ focus: vi.fn() }, { focus: vi.fn() }]
    const selectors: string[] = []
    const createNodeMock = (element: { props: Record<string, unknown> }) => {
      if (element.props['aria-label'] === 'Open') return { focus: vi.fn(), contains: () => false,
        getBoundingClientRect: () => ({ top: 0, bottom: 24, left: 0, right: 24, width: 24, height: 24 }) }
      if (typeof element.props.className === 'string' && element.props.className.includes('shadow-menu')) return {
        contains: () => false,
        querySelector: (selector: string) => { selectors.push(selector); return rows[0] },
        querySelectorAll: () => rows,
      }
      return null
    }
    act(() => { tree = create(<Sample />, { createNodeMock }) })
    act(() => button('Open')!.props.onClick())
    expect(rows[0]!.focus).toHaveBeenCalledOnce()
    // Dead rows are never the first row, nor a stop for the arrow keys.
    expect(selectors[0]).toBe('button:not(:disabled):not([aria-disabled="true"])')

    const preventDefault = vi.fn()
    const sheet = tree!.root.findByProps({ role: 'menu' }).findAll((node) => typeof node.props.onKeyDown === 'function')[0]!
    vi.stubGlobal('document', { ...document, activeElement: rows[0] })
    act(() => sheet.props.onKeyDown({ key: 'ArrowDown', preventDefault }))
    expect(rows[1]!.focus).toHaveBeenCalledOnce()
    expect(preventDefault).toHaveBeenCalledOnce()
    act(() => sheet.props.onKeyDown({ key: 'a', preventDefault }))
    expect(preventDefault).toHaveBeenCalledOnce()
  })
})
