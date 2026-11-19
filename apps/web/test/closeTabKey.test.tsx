import { act, create } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useCloseTabKey } from '../src/contentTabs'

class FakeElement {}
type Fired = Omit<Partial<KeyboardEvent>, 'target'> & { target?: unknown }
type Listener = (event: Fired) => void
let listeners: { name: string; handler: Listener }[]
let claimCloseTab: ReturnType<typeof vi.fn>
const panel = new FakeElement()
const composer = new FakeElement()
const fire = (name: string, event: Fired) => { for (const listener of listeners) if (listener.name === name) listener.handler(event) }
const press = () => fire('keydown', { metaKey: true, key: 'w', target: window, preventDefault: () => {}, stopPropagation: () => {} })

beforeEach(() => {
  listeners = []
  claimCloseTab = vi.fn()
  const listen = (name: string, handler: Listener) => listeners.push({ name, handler })
  const unlisten = (name: string, handler: Listener) => { listeners = listeners.filter((item) => item.name !== name || item.handler !== handler) }
  vi.stubGlobal('Element', FakeElement)
  vi.stubGlobal('document', { activeElement: null, addEventListener: listen, removeEventListener: unlisten })
  vi.stubGlobal('window', { addEventListener: listen, removeEventListener: unlisten, manorDesktop: { claimCloseTab } })
})
afterEach(() => vi.unstubAllGlobals())

function Surface({ enabled, onClose }: { enabled: boolean; onClose: () => void }) {
  useCloseTabKey(enabled, (element) => element === (panel as unknown as Element), onClose)
  return null
}

it('claims ⌘W from the last press or focus on the surface, whatever the key event targets', () => {
  const onClose = vi.fn()
  let view: ReturnType<typeof create>
  // The press that wakes the surface (activating its pane) lands before it listens, and still counts.
  act(() => { view = create(<Surface enabled={false} onClose={onClose} />) })
  fire('pointerdown', { target: panel })
  act(() => view!.update(<Surface enabled onClose={onClose} />))
  expect(claimCloseTab).toHaveBeenLastCalledWith(true)
  press()
  // The closed tab took its focused button along; the hold stays for the next ⌘W.
  press()
  expect(onClose).toHaveBeenCalledTimes(2)

  fire('focusin', { target: composer })
  expect(claimCloseTab).toHaveBeenLastCalledWith(false)
  press()
  expect(onClose).toHaveBeenCalledTimes(2)

  fire('focusin', { target: panel })
  act(() => view!.unmount())
  expect(claimCloseTab).toHaveBeenLastCalledWith(false)
  expect(claimCloseTab).toHaveBeenCalledTimes(4)
})
