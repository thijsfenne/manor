import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

const contentsById = vi.hoisted(() => new Map<number, unknown>())
vi.mock('electron', () => ({ webContents: { fromId: (id: number) => contentsById.get(id) } }))
import { BrowserWebviews, guardWebviewAttachments } from './browserWebviews'

function fixture() {
  const shell = Object.assign(new EventEmitter(), { isDestroyed: () => false, getZoomFactor: () => 1.25, send: vi.fn(), setBackgroundThrottling: vi.fn() })
  const scripts: Array<{ id: string }> = []
  const profile = { getPreloadScripts: () => scripts, registerPreloadScript: (script: { id: string }) => { scripts.push(script) } }
  const window = { webContents: shell, isDestroyed: () => false }
  const registry = new BrowserWebviews(window as never, profile as never)
  const guest = (src: string) => Object.assign(new EventEmitter(), {
    isDestroyed: () => false, getType: () => 'webview', hostWebContents: shell, session: profile,
    getURL: () => src, setBackgroundThrottling: vi.fn(), close: vi.fn(),
  })
  return { shell, profile, window, registry, guest }
}

describe('browser webview registry', () => {
  it('denies webviews while no browser manager is accepting them', () => {
    const { registry, shell, window } = fixture()
    let active: BrowserWebviews | undefined
    guardWebviewAttachments(window as never, () => active)
    const denied = { preventDefault: vi.fn() }
    shell.emit('will-attach-webview', denied, {}, { src: 'about:blank', partition: 'other' })
    expect(denied.preventDefault).toHaveBeenCalled()

    active = registry
    const creating = registry.create('tab')
    const surface = registry.list().surfaces[0]!
    const admitted = { preventDefault: vi.fn() }
    shell.emit('will-attach-webview', admitted, {}, { src: surface.src, partition: surface.partition })
    expect(admitted.preventDefault).not.toHaveBeenCalled()
    void creating.catch(() => undefined)
    registry.close()
    const afterClose = { preventDefault: vi.fn() }
    shell.emit('will-attach-webview', afterClose, {}, { src: 'about:blank', partition: 'other' })
    expect(afterClose.preventDefault).toHaveBeenCalled()
  })

  it('admits only requested guests, overrides unsafe preferences and retains the managed Session', async () => {
    const { registry, shell, profile, guest } = fixture()
    const creating = registry.create('tab')
    const surface = registry.list().surfaces[0]!
    const event = { preventDefault: vi.fn() }
    const preferences = { nodeIntegration: true, sandbox: false, preload: '/untrusted.js', partition: 'other' }
    shell.emit('will-attach-webview', event, preferences, { src: surface.src, partition: surface.partition })
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(preferences).toMatchObject({ session: profile, nodeIntegration: false, sandbox: true, contextIsolation: true, webviewTag: false, disableHtmlFullscreenWindowResize: true })
    expect(preferences).not.toHaveProperty('preload')
    expect(preferences).not.toHaveProperty('partition')
    // Manor's guest script comes from the Session, once, so sign-in popups get it too.
    const otherShell = Object.assign(new EventEmitter(), { isDestroyed: () => false, setBackgroundThrottling: vi.fn() })
    new BrowserWebviews({ webContents: otherShell, isDestroyed: () => false } as never, profile as never)
    expect(profile.getPreloadScripts()).toEqual([expect.objectContaining({ id: 'manor-browser-guest', type: 'frame' })])
    shell.emit('will-attach-webview', event, {}, { src: surface.src, partition: surface.partition })
    expect(event.preventDefault).toHaveBeenCalledOnce()
    const foreign = guest(surface.src)
    foreign.session = {} as never
    contentsById.set(1, foreign)
    await expect(registry.attach('tab', surface.token, 1)).rejects.toThrow('does not belong')
    const contents = guest(surface.src)
    contentsById.set(2, contents)
    await registry.attach('tab', surface.token, 2)
    const view = await creating
    expect(view.webContents).toBe(contents)
    expect(contents.setBackgroundThrottling).toHaveBeenCalledWith(true)
    registry.close()
    expect(contents.close).toHaveBeenCalledOnce()
    expect(shell.listenerCount('will-attach-webview')).toBe(0)
  })

  it('waits for applied bounds, converts shell zoom and rejects stale/future acknowledgements', async () => {
    const { registry, guest, shell } = fixture()
    const creating = registry.create('tab')
    const initial = registry.list().surfaces[0]!
    shell.emit('will-attach-webview', { preventDefault: vi.fn() }, {}, { src: initial.src, partition: initial.partition })
    contentsById.set(3, guest(initial.src))
    await registry.attach('tab', initial.token, 3)
    const view = await creating
    let applied = false
    const layout = view.present({ x: 125, y: 50, width: 500, height: 750 }, 'sidebar').then(() => { applied = true })
    const next = registry.list().surfaces[0]!
    expect(next.bounds).toEqual({ x: 100, y: 40, width: 400, height: 600 })
    registry.presented('tab', initial.token, initial.revision)
    await Promise.resolve()
    expect(applied).toBe(false)
    expect(() => registry.presented('tab', 'stale-token', next.revision)).toThrow('no longer current')
    expect(() => registry.presented('tab', next.token, next.revision + 1)).toThrow('revision')
    registry.presented('tab', next.token, next.revision)
    await layout
    view.close()
    expect(registry.list().surfaces).toEqual([])
    registry.close()
  })

  it('removes a tab immediately while attachment is still pending', async () => {
    const { registry } = fixture()
    const creating = registry.create('pending')
    const failed = expect(creating).rejects.toThrow('closed')
    registry.destroy('pending')
    await failed
    expect(registry.list().surfaces).toEqual([])
    registry.close()
  })

  it('releases pending attachment at shutdown and never resets snapshot ordering on profile replacement', async () => {
    const first = fixture()
    const creating = first.registry.create('pending')
    const failed = expect(creating).rejects.toThrow('closed')
    const before = first.registry.list().revision
    first.registry.close()
    await failed
    const next = fixture()
    expect(next.registry.list().revision).toBeGreaterThan(before)
    next.registry.close()
  })
})
