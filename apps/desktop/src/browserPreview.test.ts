import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserPreview } from './browserPreview'
import { registerBrowserPainting } from './browserPainting'

function setup() {
  const sendCommand = vi.fn(async (_method: string, _params?: unknown) => ({}))
  const debugger_ = Object.assign(new EventEmitter(), { sendCommand, isAttached: () => true })
  const contents = Object.assign(new EventEmitter(), { debugger: debugger_, isDestroyed: (): boolean => false, setBackgroundThrottling: vi.fn() })
  const setPainting = vi.fn(async (_active: boolean) => {})
  registerBrowserPainting(contents as never, setPainting)
  const onFrame = vi.fn(), unavailable = vi.fn()
  const preview = new BrowserPreview(contents as never, onFrame, unavailable)
  const frame = (data: string) => debugger_.emit('message', {}, 'Page.screencastFrame', {
    sessionId: 7, data, metadata: { deviceWidth: 1200, deviceHeight: 800 },
  })
  return { setPainting, contents, debugger_, sendCommand, onFrame, unavailable, preview, frame }
}

afterEach(() => vi.useRealTimers())

describe('composited browser preview', () => {
  it('keeps hidden painting active for the preview and releases it on stop', async () => {
    const { preview, setPainting } = setup()
    await preview.start()
    expect(setPainting).toHaveBeenLastCalledWith(true)
    await preview.stop()
    await new Promise(setImmediate)
    expect(setPainting.mock.calls).toEqual([[true], [false]])
  })

  it('acknowledges every frame and coalesces to the last image at thirty fps', async () => {
    vi.useFakeTimers()
    const { preview, frame, onFrame, sendCommand } = setup()
    await preview.start()
    frame('first'); frame('last')
    expect(onFrame).not.toHaveBeenCalled()
    expect(sendCommand.mock.calls.filter(([m]) => m === 'Page.screencastFrameAck')).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(34)
    expect(onFrame).toHaveBeenCalledOnce()
    expect(onFrame).toHaveBeenCalledWith({ screenshot: 'data:image/jpeg;base64,last', width: 1200, height: 800 })
    await preview.stop()
  })

  it('flushes the final pending image and removes timers and listeners on stop', async () => {
    vi.useFakeTimers()
    const { preview, frame, onFrame, contents, debugger_, sendCommand } = setup()
    await preview.start()
    frame('final'); preview.flush()
    await preview.stop(); await preview.stop()
    frame('late')
    await vi.runAllTimersAsync()
    expect(onFrame).toHaveBeenCalledOnce()
    expect(debugger_.listenerCount('message')).toBe(0)
    expect(contents.listenerCount('destroyed')).toBe(0)
    expect(sendCommand.mock.calls.filter(([m]) => m === 'Page.stopScreencast')).toHaveLength(1)
  })

  it('reports capture failure without failing browser actions', async () => {
    const { preview, sendCommand, unavailable, debugger_ } = setup()
    sendCommand.mockRejectedValueOnce(new Error('capture unavailable'))
    await preview.start()
    await preview.stop()
    expect(unavailable).toHaveBeenCalledOnce()
    expect(debugger_.listenerCount('message')).toBe(0)
  })

  it('can close a mirror after its guest has already been destroyed', async () => {
    const { preview, contents, debugger_ } = setup()
    await preview.start()
    contents.isDestroyed = () => true
    Object.defineProperty(contents, 'debugger', { get: () => { throw new Error('Object has been destroyed') } })
    contents.emit('destroyed')
    await preview.stop()
    await preview.stop()
    expect(debugger_.listenerCount('message')).toBe(0)
  })

  it('stops a late start before a replacement may start on the same page', async () => {
    const { preview, sendCommand } = setup()
    let ready = () => {}
    sendCommand.mockImplementationOnce(() => new Promise((resolve) => { ready = () => resolve({}) }))
    const starting = preview.start()
    const stopping = preview.stop()
    await new Promise(setImmediate)
    expect(sendCommand).toHaveBeenCalledTimes(1)
    ready()
    await Promise.all([starting, stopping])
    expect(sendCommand).toHaveBeenLastCalledWith('Page.stopScreencast')
  })
})
