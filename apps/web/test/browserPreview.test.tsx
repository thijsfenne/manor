import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserPreviewUpdate, DesktopBrowserBridge } from '@manor/contracts'
import { BrowserPreview } from '../src/components/BrowserPreview'

beforeEach(() => { vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1)); vi.stubGlobal('cancelAnimationFrame', vi.fn()) })
afterEach(() => vi.unstubAllGlobals())

function setup(manual = false) {
  const listeners: Array<(update: BrowserPreviewUpdate) => void> = []
  const unsubscribe = vi.fn()
  const startPreview = vi.fn(async (_chatId: string, _id: string) => {})
  const stopPreview = vi.fn(async (_id: string) => {})
  const endAgentUse = vi.fn(async () => {})
  const bridge = { webviews: {}, hide: vi.fn(async () => {}), show: vi.fn(async () => {}), startPreview, stopPreview, endAgentUse,
    onPreview: (listener: (update: BrowserPreviewUpdate) => void) => { listeners.push(listener); return unsubscribe },
  } as unknown as DesktopBrowserBridge
  const props = { manual, chatId: 'one', bridge, activity: manual ? undefined : { agentId: 'wren', agentName: 'Wren', tool: 'browser_click' },
    sidebarOpen: false, onOpen: vi.fn(), onStop: vi.fn(), onDismiss: vi.fn(),
    turns: [{ agentId: 'wren', turnId: 'wren-turn' }, { agentId: 'smith', turnId: 'smith-turn' }],
  }
  let tree: ReactTestRenderer
  act(() => { tree = create(<BrowserPreview {...props} />) })
  const emit = (over: Partial<BrowserPreviewUpdate> = {}, index = listeners.length - 1) => act(() => {
    listeners[index]!({ chatId: 'one', subscriptionId: startPreview.mock.calls[index]![1],
      status: 'frame', tabId: 'tab', screenshot: 'data:image/jpeg;base64,fixture', width: 800, height: 600, ...over } as BrowserPreviewUpdate)
  })
  return { tree: tree!, props, emit, startPreview, stopPreview, endAgentUse, unsubscribe }
}

describe('live browser preview', () => {
  it('waits for the first frame, opens the same browser and retains the still after completion', () => {
    const { tree, props, emit, stopPreview } = setup()
    expect(tree.root.findByProps({ role: 'status' }).children).toContain('Waiting for the browser…')
    emit()
    expect(tree.root.findAllByType('img')).toHaveLength(0)
    const windowClass = tree.root.findByType('section').props.className
    expect(tree.root.findByProps({ 'data-browser-slot': 'floating' }).props.className).toContain('aspect-video')
    act(() => tree.root.findByProps({ 'aria-label': 'Open browser' }).props.onClick())
    expect(props.onOpen).toHaveBeenCalledOnce()
    act(() => tree.update(<BrowserPreview {...props} activity={undefined} />))
    expect(tree.root.findByProps({ role: 'status' }).children).toContain('Last browser view')
    expect(tree.root.findByType('img').props.src).toBe('data:image/jpeg;base64,fixture')
    expect(tree.root.findByType('img').props.className).toContain('object-contain')
    expect(tree.root.findByType('section').props.className.replace('bg-surface', 'bg-transparent')).toBe(windowClass)
    expect(stopPreview).toHaveBeenCalledOnce()
    act(() => tree.unmount())
  })

  it('floats without an agent or retained frame and stays subscribed through agent completion', () => {
    const { tree, props, emit, startPreview, stopPreview } = setup(true)
    expect(startPreview).toHaveBeenCalledWith('one', expect.any(String), 'manual')
    expect(tree.root.findByProps({ role: 'status' }).children).toContain('Waiting for the browser…')
    emit()
    act(() => tree.update(<BrowserPreview {...props} activity={{ agentId: 'wren', agentName: 'Wren', tool: 'browser_click' }} />))
    act(() => tree.update(<BrowserPreview {...props} />))
    expect(startPreview).toHaveBeenCalledOnce()
    expect(stopPreview).not.toHaveBeenCalled()
    emit({ screenshot: 'still-live' })
    expect(tree.root.findAllByType('img')).toHaveLength(0)
    expect(tree.root.findByProps({ role: 'status' }).children).toContain('Live browser preview')
    act(() => tree.update(<BrowserPreview {...props} sidebarOpen manual={false} />))
    expect(stopPreview).toHaveBeenCalledWith(startPreview.mock.calls[0]![1])
    expect(tree.toJSON()).toBeNull()
    act(() => tree.unmount())
  })

  it('stops a manual preview on chat switch and reports missing support', () => {
    const { tree, props, emit, stopPreview } = setup(true)
    emit()
    act(() => tree.update(<BrowserPreview key="two" {...props} chatId="two" manual={false} />))
    expect(stopPreview).toHaveBeenCalledOnce()
    emit({ screenshot: 'late' }, 0)
    expect(tree.toJSON()).toBeNull()
    act(() => tree.update(<BrowserPreview {...props} bridge={undefined} />))
    expect(tree.root.findByProps({ role: 'status' }).children).toContain('Live preview needs the updated desktop app')
    act(() => tree.unmount())
  })

  it('stops only the owning persona and clears native input immediately', () => {
    const { tree, props, endAgentUse } = setup()
    act(() => tree.root.findByType('section').findAllByType('button').find((node) => node.props['aria-label'] === 'Stop browser agent')!.props.onClick())
    expect(props.onStop.mock.calls).toEqual([['wren-turn']])
    expect(endAgentUse).toHaveBeenCalledWith('one')
    expect(tree.root.findAllByType('button').find((node) => node.props['aria-label'] === 'Stopping browser')!.props.disabled).toBe(true)
    act(() => tree.unmount())
  })

  it('retains the image while toggling the sidebar and rejects stale subscriptions', () => {
    const { tree, props, emit, startPreview, stopPreview } = setup()
    emit()
    act(() => tree.update(<BrowserPreview {...props} sidebarOpen />))
    expect(tree.toJSON()).toBeNull()
    expect(stopPreview).toHaveBeenCalledOnce()
    act(() => tree.update(<BrowserPreview {...props} />))
    expect(startPreview).toHaveBeenCalledTimes(2)
    emit({ screenshot: 'stale' }, 0)
    emit({ chatId: 'another-chat', screenshot: 'wrong-chat' })
    expect(tree.root.findAllByType('img')).toHaveLength(0)
    emit({ screenshot: 'fresh' })
    act(() => tree.update(<BrowserPreview {...props} activity={undefined} />))
    expect(tree.root.findByType('img').props.src).toBe('fresh')
    act(() => tree.unmount())
  })

  it('discards frames on chat switch and ignores callbacks from the unmounted chat', async () => {
    const { tree, props, emit, unsubscribe } = setup()
    emit()
    act(() => tree.update(<BrowserPreview key="two" {...props} chatId="two" activity={undefined} />))
    emit({ screenshot: 'late' }, 0)
    expect(tree.toJSON()).toBeNull()
    await act(async () => {})
    expect(unsubscribe).toHaveBeenCalledOnce()
    act(() => tree.unmount())
  })

  it('accepts the final frame before stop resolves, without needing a continuous image stream', async () => {
    const { tree, props, emit, stopPreview } = setup()
    let finish = () => {}
    stopPreview.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
    emit({ screenshot: 'initial' })
    act(() => tree.update(<BrowserPreview {...props} activity={undefined} />))
    emit({ screenshot: 'final' })
    expect(tree.root.findByType('img').props.src).toBe('final')
    await act(async () => finish())
    emit({ screenshot: 'too-late' })
    expect(tree.root.findByType('img').props.src).toBe('final')
    act(() => tree.unmount())
  })

  it('shows capture failure and missing desktop support explicitly', async () => {
    const { tree, props, emit } = setup()
    emit({ status: 'unavailable' })
    expect(tree.root.findByProps({ role: 'status' }).children).toContain('Browser preview unavailable')
    act(() => tree.update(<BrowserPreview {...props} bridge={undefined} />))
    expect(tree.root.findByProps({ 'aria-label': 'Open browser' }).props.disabled).toBe(true)
    expect(tree.root.findByProps({ role: 'status' }).children).toContain('Live preview needs the updated desktop app')
    act(() => tree.unmount())
  })
})


describe('browser preview dismissal', () => {
  it('releases the live slot and subscription without stopping either persona, and only reopens explicitly', async () => {
    const { tree, props, emit, startPreview, stopPreview, endAgentUse, unsubscribe } = setup(true)
    const activity = { agentId: 'wren', agentName: 'Wren', tool: 'browser_click' }
    act(() => tree.update(<BrowserPreview {...props} activity={activity} />))
    emit()
    act(() => tree.root.findByProps({ 'aria-label': 'Hide browser preview' }).props.onClick())
    expect(props.onDismiss).toHaveBeenCalledOnce()
    await act(async () => tree.update(<BrowserPreview {...props} activity={activity} manual={false} dismissed />))
    expect(tree.toJSON()).toBeNull()
    expect(props.bridge.hide).toHaveBeenCalledOnce()
    expect(stopPreview).toHaveBeenCalledWith(startPreview.mock.calls[0]![1])
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(props.onStop).not.toHaveBeenCalled()
    expect(endAgentUse).not.toHaveBeenCalled()
    emit({ screenshot: 'late' })
    act(() => tree.update(<BrowserPreview {...props} manual={false} dismissed activity={{ agentId: 'smith', agentName: 'Smith', tool: 'browser_type' }} />))
    expect(tree.toJSON()).toBeNull()
    expect(startPreview).toHaveBeenCalledOnce()
    act(() => tree.update(<BrowserPreview {...props} dismissed={false} />))
    expect(startPreview).toHaveBeenCalledTimes(2)
    expect(startPreview).toHaveBeenLastCalledWith('one', expect.any(String), 'manual')
    emit()
    expect(tree.root.findAllByProps({ 'data-browser-slot': 'floating' })).toHaveLength(1)
    expect(props.onStop).not.toHaveBeenCalled()
    expect(endAgentUse).not.toHaveBeenCalled()
    act(() => tree.unmount())
  })

  it.each(['stopped', 'completed'] as const)('hides the last image after the preview is %s', async (status) => {
    const { tree, props, emit, startPreview, endAgentUse } = setup()
    emit()
    if (status === 'stopped') emit({ status: 'stopped' })
    else act(() => tree.update(<BrowserPreview {...props} activity={undefined} />))
    expect(tree.root.findAllByType('img')).toHaveLength(1)
    act(() => tree.root.findByProps({ 'aria-label': 'Hide browser preview' }).props.onClick())
    expect(props.onDismiss).toHaveBeenCalledOnce()
    await act(async () => tree.update(<BrowserPreview {...props} activity={undefined} dismissed />))
    expect(tree.toJSON()).toBeNull()
    act(() => tree.update(<BrowserPreview {...props} dismissed />))
    expect(tree.toJSON()).toBeNull()
    expect(startPreview).toHaveBeenCalledOnce()
    expect(props.onStop).not.toHaveBeenCalled()
    expect(endAgentUse).not.toHaveBeenCalled()
    act(() => tree.unmount())
  })
})
