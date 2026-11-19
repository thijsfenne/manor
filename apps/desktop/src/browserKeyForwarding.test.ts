import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, Input } from 'electron'
import { browserKeyForwarding } from './browserKeyForwarding'
import { HOUSE_KEY_CHANNEL } from './browserChannels'

const key = (value: string, changes: Partial<Input> = {}) =>
  ({ type: 'keyDown', key: value, meta: true, control: false, shift: false, alt: false, isAutoRepeat: false, ...changes }) as Input

function setup(claimed: boolean) {
  const send = vi.fn()
  const window = { isDestroyed: () => false, webContents: { send, reload: vi.fn() } } as unknown as BrowserWindow
  const keys = browserKeyForwarding({ window: () => window, chromeFocused: () => false, accepts: () => false, closeTabClaimed: () => claimed })
  const press = (input: Input) => {
    const event = { preventDefault: vi.fn() }
    keys.fromKey(event as unknown as Electron.Event, input)
    return event.preventDefault.mock.calls.length > 0
  }
  return { send, press }
}

describe('browserKeyForwarding close-tab claim', () => {
  it('takes ⌘W from Close Window and replays it while a surface claims it', () => {
    const { send, press } = setup(true)
    expect(press(key('w'))).toBe(true)
    expect(send).toHaveBeenCalledWith(HOUSE_KEY_CHANNEL, 'w')
  })

  it('leaves ⌘W to the window menu without a claim, and ⇧⌘W always', () => {
    expect(setup(false).press(key('w'))).toBe(false)
    expect(setup(true).press(key('w', { shift: true }))).toBe(false)
  })
})
