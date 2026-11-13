import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerNotifyIpc } from './notify'
import { NOTIFY_ACTIVATE_CHANNEL } from './notifyChannels'

const host = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  shown: [] as { title: string; body: string; groupId?: string }[],
  clicks: [] as (() => void)[],
  badge: -1,
}))

vi.mock('electron', () => {
  class Notification {
    static isSupported() {
      return true
    }
    constructor(public options: { title: string; body: string; groupId?: string }) {}
    on(name: string, handler: () => void) {
      if (name === 'click') host.clicks.push(handler)
      return this
    }
    show() {
      host.shown.push(this.options)
    }
  }
  return {
    app: {
      setBadgeCount: (count: number) => {
        host.badge = count
      },
      focus: () => {},
    },
    BrowserWindow: class {},
    ipcMain: {
      handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
        host.handlers.set(channel, handler)
      },
    },
    Notification,
  }
})

const makeWindow = (focused: boolean) => {
  const sent: { channel: string; payload: unknown }[] = []
  return {
    focused,
    sent,
    raised: 0,
    isDestroyed: () => false,
    isFocused() {
      return this.focused
    },
    isMinimized: () => false,
    restore() {},
    show() {
      this.raised += 1
    },
    focus() {
      this.raised += 1
    },
    webContents: {
      id: 7,
      send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
    },
  }
}

const fromRenderer = { sender: { id: 7 } }
const NOTICE = { chatId: 'chat_1', title: 'Manor', body: 'Smith: klaar.' }

const call = (channel: string, event: unknown, ...args: unknown[]) => {
  const handler = host.handlers.get(channel)
  if (handler === undefined) throw new Error(`nothing handles ${channel}`)
  return handler(event, ...args)
}

describe('the desktop done notice', () => {
  beforeEach(() => {
    host.handlers.clear()
    host.shown.length = 0
    host.clicks.length = 0
    host.badge = -1
  })

  it('stays quiet while the window has focus, because the row already says it', () => {
    const window = makeWindow(true)
    registerNotifyIpc(() => window as never)

    call('manor:notify:show', fromRenderer, NOTICE)

    expect(host.shown).toEqual([])
  })

  it('shows the notice the renderer wrote once Manor is not the app in front', () => {
    const window = makeWindow(false)
    registerNotifyIpc(() => window as never)

    call('manor:notify:show', fromRenderer, NOTICE)

    expect(host.shown).toEqual([{ title: 'Manor', body: 'Smith: klaar.', groupId: 'chat_1' }])
  })

  it('keeps every notice, grouping repeated chats separately from other chats', () => {
    const window = makeWindow(false)
    registerNotifyIpc(() => window as never)

    call('manor:notify:show', fromRenderer, NOTICE)
    call('manor:notify:show', fromRenderer, { ...NOTICE, body: 'Smith asks: Continue?' })
    call('manor:notify:show', fromRenderer, { ...NOTICE, chatId: 'chat_2' })

    expect(host.shown).toEqual([
      { title: NOTICE.title, body: NOTICE.body, groupId: 'chat_1' },
      { title: NOTICE.title, body: 'Smith asks: Continue?', groupId: 'chat_1' },
      { title: NOTICE.title, body: NOTICE.body, groupId: 'chat_2' },
    ])
  })

  it('raises the window on a click and tells the renderer which chat it was', () => {
    const window = makeWindow(false)
    registerNotifyIpc(() => window as never)
    call('manor:notify:show', fromRenderer, NOTICE)

    host.clicks[0]?.()

    expect(window.raised).toBeGreaterThan(0)
    expect(window.sent).toEqual([{ channel: NOTIFY_ACTIVATE_CHANNEL, payload: 'chat_1' }])
  })

  it('refuses a caller that is not the Manor window', () => {
    const window = makeWindow(false)
    registerNotifyIpc(() => window as never)

    expect(() => call('manor:notify:show', { sender: { id: 99 } }, NOTICE)).toThrow(/outside the Manor window/)
    expect(host.shown).toEqual([])
  })

  it('refuses a notice that is missing its chat', () => {
    const window = makeWindow(false)
    registerNotifyIpc(() => window as never)

    expect(() => call('manor:notify:show', fromRenderer, { title: 'Manor', body: 'x' })).toThrow(/chat id/)
  })

  it('sets the dock badge, and clears it at zero', () => {
    const window = makeWindow(false)
    registerNotifyIpc(() => window as never)

    call('manor:notify:badge', fromRenderer, 3)
    expect(host.badge).toBe(3)

    call('manor:notify:badge', fromRenderer, 0)
    expect(host.badge).toBe(0)

    expect(() => call('manor:notify:badge', fromRenderer, -1)).toThrow(/count/)
  })
})
