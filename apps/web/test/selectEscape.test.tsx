import { act, create, type ReactTestInstance } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { Dialog } from '../src/components/ui/Dialog'
import { Select } from '../src/components/ui/Select'

// The test renderer has no DOM: portals render in place and the list lands at a fixed spot.
vi.mock('react-dom', async (original) => ({
  ...(await original<typeof import('react-dom')>()),
  createPortal: (children: unknown) => children,
}))
vi.mock('../src/components/ui/useDismiss', () => ({ useDismiss: () => {} }))
vi.mock('../src/components/ui/usePopupPlacement', () => ({
  usePopupPlacement: ({ open }: { open: boolean }) => (open ? { left: 0, top: 0, width: 200, maxHeight: 288 } : null),
}))
vi.stubGlobal('document', { body: {}, activeElement: null })
vi.stubGlobal('HTMLElement', class {})

const options = [{ value: 'daily', label: 'Daily' }, { value: 'weekly', label: 'Weekly' }]

/** Delivers a key to `target` and up through its ancestors until a handler stops it, as the browser does. */
function press(target: ReactTestInstance, key: string) {
  let stopped = false
  const event = { key, preventDefault: () => {}, stopPropagation: () => { stopped = true } }
  for (let node: ReactTestInstance | null = target; node !== null && !stopped; node = node.parent) {
    const handler: unknown = node.props.onKeyDown
    if (typeof handler === 'function') act(() => handler(event))
  }
}

describe('Escape inside a dialog with a Select', () => {
  it('closes the open list and keeps the dialog', () => {
    const onClose = vi.fn()
    let tree!: ReturnType<typeof create>
    act(() => {
      tree = create(
        <Dialog label="New task" onClose={onClose}>
          <Select label="Repeat" value="daily" options={options} onChange={() => {}} />
        </Dialog>,
      )
    })
    const trigger = tree.root.findByProps({ role: 'combobox' })
    press(trigger, 'ArrowDown')
    expect(trigger.props['aria-expanded']).toBe(true)

    press(trigger, 'Escape')
    expect(trigger.props['aria-expanded']).toBe(false)
    expect(onClose).not.toHaveBeenCalled()

    // With the list shut, the same key is the dialog's again.
    press(trigger, 'Escape')
    expect(onClose).toHaveBeenCalledOnce()
  })
})
