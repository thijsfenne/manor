import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserBookmark, BrowserSessionState, BrowserShortcut, DesktopBrowserBridge } from '@manor/contracts'
import { BrowserDeviceToolbar } from '../src/components/BrowserDeviceToolbar'
import { BrowserFindBar } from '../src/components/BrowserFindBar'
import { BrowserPanel } from '../src/components/BrowserPanel'
import { ConfirmStrip } from '../src/components/Confirm'
import { Switch } from '../src/components/ui/Switch'
import { BrowserMenu } from '../src/components/BrowserMenu'
import { BrowserBookmarksMenu } from '../src/components/BrowserBookmarksMenu'
import { Select } from '../src/components/ui/Select'

vi.mock('react-dom', async (original) => ({ ...await original<typeof import('react-dom')>(), createPortal: (child: unknown) => child }))

let tree: ReactTestRenderer | undefined
beforeEach(() => {
  vi.stubGlobal('document', { body: {}, addEventListener: vi.fn(), removeEventListener: vi.fn() })
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
})
afterEach(() => { act(() => tree?.unmount()); tree = undefined; vi.useRealTimers(); vi.unstubAllGlobals() })
const button = (name: string) => tree!.root.findAllByType('button').find((node) => node.props['aria-label'] === name || node.findAll((descendant) => descendant.children.some((child) => typeof child === 'string' && child.trim() === name)).length > 0)!
const click = async (name: string) => { await act(async () => button(name).props.onClick()) }

function menu(viewport: { width: number; height: number } | null = null, old = false, createNodeMock?: (element: { props: Record<string, unknown> }) => object | null) {
  const bridge = Object.fromEntries(['configure', 'hardReload', 'openDevTools', 'openPreviewWindow', 'clearCookies', 'clearCache']
    .map((method) => [method, vi.fn(async () => {})]))
  const onError = vi.fn()
  const props = { bridge: (old ? {} : bridge) as unknown as DesktopBrowserBridge, chatId: 'chat', disabled: false,
    pageDisabled: false, settingsOpen: false, settingsDisabled: false, clearDisabled: false, onSettings: vi.fn(), onClearData: vi.fn(),
    profile: 'Default', settings: { viewport, appearance: 'system' as const, zoomFactor: 1.5 }, onError, onStart: vi.fn() }
  act(() => { tree = create(<BrowserMenu {...props} />, createNodeMock && { createNodeMock }) })
  return { bridge, props, onError }
}

describe('browser menu', () => {
  it('uses the distinct native actions without changing page presentation', async () => {
    const { bridge } = menu()
    for (const [label, method] of [['Hard reload', 'hardReload'], ['Open DevTools', 'openDevTools'],
      ['Open separate preview window', 'openPreviewWindow'], ['Clear cookies', 'clearCookies'], ['Clear cache', 'clearCache']]) {
      await click('Browser menu')
      await click(label!)
      expect(bridge[method!]!).toHaveBeenCalledOnce()
    }
    expect(bridge.hardReload).toHaveBeenCalledWith('chat')
    expect(bridge.clearCookies).toHaveBeenCalledWith()
  })

  it('crosses a page between a chat and Browser from the menu', async () => {
    const { props } = menu()
    const onSendToBrowser = vi.fn(async () => {})
    act(() => tree!.update(<BrowserMenu {...props} onSendToBrowser={onSendToBrowser} />))
    await click('Browser menu'); await click('Send to Browser')
    expect(onSendToBrowser).toHaveBeenCalledOnce()

    const onOpen = vi.fn(async () => {})
    const targets = [{ chatId: 'dm-iris', title: 'Iris' }, { chatId: 'work-1', title: 'Audit', detail: 'Manor' }]
    act(() => tree!.update(<BrowserMenu {...props} openInChat={{ targets, onOpen }} />))
    await click('Browser menu')
    expect(button('Send to Browser')).toBeUndefined()
    await click('Open in chat'); await click('Audit')
    expect(onOpen).toHaveBeenCalledWith('work-1')

    act(() => tree!.update(<BrowserMenu {...props} openInChat={{ targets: [], onOpen }} />))
    await click('Browser menu'); await click('Open in chat')
    expect(JSON.stringify(tree!.toJSON())).toContain('No recent chats yet.')
  })

  it('hands the page to the default browser from the menu', async () => {
    const onOpenExternal = vi.fn()
    const { props } = menu()
    act(() => tree!.update(<BrowserMenu {...props} onOpenExternal={onOpenExternal} />))
    await click('Browser menu'); await click('Open in default browser')
    expect(onOpenExternal).toHaveBeenCalledOnce()
  })

  it('keeps profile actions available without a tab and preserves their disabled states', async () => {
    const { props } = menu()
    act(() => tree!.update(<BrowserMenu {...props} pageDisabled />))
    await click('Browser menu')
    expect(button('Hard reload').props.disabled).toBe(true)
    expect(button('Browser settings').findAllByType('svg')).toHaveLength(1)
    expect(button('Clear browser data').findAllByType('svg')).toHaveLength(1)
    await click('Browser settings')
    expect(props.onSettings).toHaveBeenCalledOnce()
    expect(button('Browser menu').props['aria-expanded']).toBe(false)
    await click('Browser menu'); await click('Clear browser data')
    expect(props.onClearData).toHaveBeenCalledOnce()
    act(() => tree!.update(<BrowserMenu {...props} settingsOpen settingsDisabled clearDisabled />))
    await click('Browser menu')
    expect(button('Browser settings').props['aria-expanded']).toBe(true)
    expect(button('Browser settings').props.disabled).toBe(true)
    expect(button('Clear browser data').props.disabled).toBe(true)
  })

  it('configures website appearance and zoom from reported settings', async () => {
    const { bridge } = menu({ width: 390, height: 844 })
    await click('Browser menu'); await click('Appearance'); await click('Dark')
    expect(bridge.configure).toHaveBeenLastCalledWith('chat', { appearance: 'dark' })
    await click('Zoom in')
    expect(bridge.configure).toHaveBeenLastCalledWith('chat', { zoomFactor: 1.6 })
    await click('Reset zoom')
    expect(bridge.configure).toHaveBeenLastCalledWith('chat', { zoomFactor: 1 })
  })

  it('surfaces native failures', async () => {
    const { bridge, onError } = menu()
    bridge.hardReload!.mockRejectedValueOnce(new Error('Reload failed'))
    await click('Browser menu'); await click('Hard reload')
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Reload failed' }))
  })

  it('leaves focus with the page a press closed it for, and returns it to the button only on Escape', async () => {
    vi.useFakeTimers()
    const focus = vi.fn()
    menu(null, false, (element) => element.props['aria-label'] !== 'Browser menu' ? null : { focus, contains: () => false,
      getBoundingClientRect: () => ({ top: 0, bottom: 24, left: 0, right: 24, width: 24, height: 24 }) })
    const listener = (type: string) => vi.mocked(document.addEventListener).mock.calls.filter(([name]) => name === type).at(-1)![1] as (event?: unknown) => void
    await click('Browser menu')
    Object.assign(document, { activeElement: { localName: 'webview' } })
    act(() => { listener('focusin')(); vi.runAllTimers() })
    expect(button('Browser menu').props['aria-expanded']).toBe(false)
    expect(focus).not.toHaveBeenCalled()
    await click('Browser menu')
    act(() => listener('keydown')({ key: 'Escape', preventDefault: () => {} }))
    expect(button('Browser menu').props['aria-expanded']).toBe(false)
    expect(focus).toHaveBeenCalledOnce()
  })

  it('keeps unavailable older-host options visibly disabled', async () => {
    menu(null, true); await click('Browser menu')
    for (const label of ['Hard reload', 'Open DevTools', 'Open separate preview window', 'Appearance', 'Clear cookies', 'Clear cache']) {
      expect(button(label).props.disabled).toBe(true)
    }
    expect(JSON.stringify(tree!.toJSON())).toContain('Update the desktop app')
  })
})

describe('device toolbar', () => {
  it('applies presets, rotation and proportional dimensions', async () => {
    const onChange = vi.fn(), onError = vi.fn()
    act(() => { tree = create(<BrowserDeviceToolbar viewport={{ width: 1280, height: 720 }} disabled={false} onChange={onChange} onError={onError} />) })
    act(() => tree!.root.findByType(Select).props.onChange('mobile'))
    expect(onChange).toHaveBeenLastCalledWith({ width: 390, height: 844 })
    await click('Rotate viewport')
    expect(onChange).toHaveBeenLastCalledWith({ width: 720, height: 1280 })
    await click('Lock aspect ratio')
    act(() => tree!.root.findByProps({ 'aria-label': 'Viewport width' }).props.onChange({ target: { value: '640' } }))
    act(() => tree!.root.findByProps({ 'aria-label': 'Viewport width' }).props.onBlur())
    expect(onChange).toHaveBeenLastCalledWith({ width: 640, height: 360 })
    expect(onError).not.toHaveBeenCalled()
  })

  it('closes responsive sizing through the toolbar X', async () => {
    const onChange = vi.fn()
    act(() => { tree = create(<BrowserDeviceToolbar viewport={{ width: 390, height: 844 }} disabled={false} onChange={onChange} onError={vi.fn()} />) })
    expect(button('Close device toolbar').props.className).toContain('ml-auto')
    await click('Close device toolbar')
    expect(onChange).toHaveBeenCalledWith(null)
  })

  it('rejects invalid dimensions and follows active-tab settings', () => {
    const onChange = vi.fn(), onError = vi.fn()
    const props = { viewport: { width: 390, height: 844 }, disabled: false, onChange, onError }
    act(() => { tree = create(<BrowserDeviceToolbar {...props} />) })
    act(() => tree!.root.findByProps({ 'aria-label': 'Viewport height' }).props.onChange({ target: { value: '99' } }))
    act(() => tree!.root.findByProps({ 'aria-label': 'Viewport height' }).props.onBlur())
    expect(onChange).not.toHaveBeenCalled(); expect(onError).toHaveBeenCalledOnce()
    act(() => tree!.update(<BrowserDeviceToolbar key="other-tab" {...props} viewport={{ width: 768, height: 1024 }} />))
    expect(tree!.root.findByProps({ 'aria-label': 'Viewport width' }).props.value).toBe('768')
    expect(tree!.root.findByProps({ 'aria-label': 'Viewport height' }).props.value).toBe('1024')
  })
})


describe('browser panel menu integration', () => {
  async function mountPanel(stage = false) {
    const state: BrowserSessionState = { chatId: 'chat', activeTabId: 'tab', tabs: [{
      id: 'tab', title: 'Example', url: 'https://example.com', loading: false, canGoBack: false, canGoForward: false,
    }] }
    let push: (state: BrowserSessionState) => void = () => {}
    let shortcut: (name: BrowserShortcut) => void = () => {}
    let saved: BrowserBookmark[] = []
    const browserArea = {}
    const addressFocus = vi.fn()
    const addressSelect = vi.fn()
    const bridge = {
      webviews: {},
      onState: (listener: typeof push) => { push = listener; return () => {} },
      onShortcut: (listener: typeof shortcut) => { shortcut = listener; return () => { shortcut = () => {} } },
      setShortcutFocus: vi.fn(),
      tabs: vi.fn(async () => state), hide: vi.fn(async () => {}),
      localServers: vi.fn(async () => [{ url: 'http://localhost:5173', port: 5173, title: 'Kevin Cox' }]),
      newTab: vi.fn(async () => state), closeTab: vi.fn(async () => state),
      reload: vi.fn(async () => {}), goBack: vi.fn(async () => {}), goForward: vi.fn(async () => {}),
      bookmarks: vi.fn(async () => saved),
      toggleBookmark: vi.fn(async (url: string, title: string) => {
        saved = saved.some((bookmark) => bookmark.url === url) ? saved.filter((bookmark) => bookmark.url !== url)
          : [{ url, title, addedAt: 1 }, ...saved]
        return saved
      }),
      browserImportStatus: vi.fn(async () => ({ enabled: false, available: true, browser: 'dia' as const, browsers: [] })),
      history: vi.fn(async () => [{
        url: 'https://history.example/', title: 'History result', visitCount: 2, lastVisitedAt: 1_720_000_000_000,
      }]),
      navigate: vi.fn(async (url: string) => ({ url, title: '' })),
      clearData: vi.fn(async () => {}), configure: vi.fn(async () => {}),
      startPreview: vi.fn(async () => {}), stopPreview: vi.fn(async () => {}), onPreview: vi.fn(() => () => {}),
    }
    const props = { bridge: bridge as unknown as DesktopBrowserBridge, chatId: 'chat', activity: undefined,
      shown: true, stage, settling: false, revealed: true, width: 620, expanded: false, resizing: false,
      resizeProps: {}, pageContextCount: 0, onAddPageContext: vi.fn(), onToggleExpanded: vi.fn(), onClose: vi.fn(), onFloat: vi.fn() }
    await act(async () => { tree = create(<BrowserPanel {...props} />, {
      createNodeMock: (element) => element.type === 'input' ? { focus: addressFocus, select: addressSelect, blur: vi.fn() }
        : element.type === 'aside' ? { contains: (target: unknown) => target === browserArea } : null,
    }) })
    return { state, props, bridge, browserArea, addressFocus, addressSelect,
      shortcut: async (name: BrowserShortcut) => { await act(async () => { shortcut(name) }) },
      push: (next: BrowserSessionState) => act(() => push(next)) }
  }

  it('lists local servers on a blank tab and opens one there, keeping the browser and its shortcuts', async () => {
    const { state, bridge, push, shortcut } = await mountPanel(true)
    expect(bridge.localServers).not.toHaveBeenCalled()
    push({ ...state, tabs: [{ ...state.tabs[0]!, url: 'about:blank', title: '' }] })
    await act(async () => {})
    // Parking the slot would unregister the browser with the host and send ⌘T, ⌘W and ⌘R elsewhere.
    expect(bridge.hide).not.toHaveBeenCalled()
    await shortcut('new-tab')
    expect(bridge.newTab).toHaveBeenCalledOnce()
    await click('Kevin Cox')
    expect(bridge.navigate).toHaveBeenCalledWith('http://localhost:5173', 'chat')
    bridge.localServers.mockResolvedValueOnce([])
    await click('Refresh local servers')
    expect(bridge.localServers).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(tree!.toJSON())).toContain('No local servers running.')
  })

  it('offers local servers when the browser opens without tabs, a pick opening the first tab', async () => {
    const { state, bridge, push } = await mountPanel(true)
    push({ ...state, tabs: [], activeTabId: null })
    await act(async () => {})
    expect(JSON.stringify(tree!.toJSON())).not.toContain('No tabs open')
    await click('Kevin Cox')
    expect(bridge.newTab).toHaveBeenCalledWith('chat', 'http://localhost:5173')
  })

  it('leaves a blank tab without the local list on a shell that cannot list servers', async () => {
    const { state, bridge, push } = await mountPanel(true)
    delete (bridge as Partial<typeof bridge>).localServers
    push({ ...state, tabs: [{ ...state.tabs[0]!, url: 'about:blank', title: '' }] })
    await act(async () => {})
    expect(JSON.stringify(tree!.toJSON())).not.toContain('Local')
  })

  it('restores browser shortcuts when clicking empty browser space after focusing chat', async () => {
    const { bridge, browserArea } = await mountPanel(true)
    const listener = (name: string) => vi.mocked(document.addEventListener).mock.calls
      .find(([event]) => event === name)?.[1] as EventListener
    act(() => listener('focusin')({ target: {} } as Event))
    expect(bridge.setShortcutFocus).toHaveBeenLastCalledWith(false)
    act(() => listener('pointerdown')({ target: browserArea } as Event))
    act(() => listener('focusin')({ target: {} } as Event))
    act(() => listener('pointerup')({ target: browserArea } as Event))
    expect(bridge.setShortcutFocus).toHaveBeenLastCalledWith(true)
  })

  it('keeps chat focus when a drag ends over empty browser space', async () => {
    const { bridge, browserArea } = await mountPanel(true)
    const listener = (name: string) => vi.mocked(document.addEventListener).mock.calls
      .find(([event]) => event === name)?.[1] as EventListener
    act(() => listener('pointerdown')({ target: {} } as Event))
    const calls = bridge.setShortcutFocus.mock.calls.length
    act(() => listener('pointerup')({ target: browserArea } as Event))
    expect(bridge.setShortcutFocus).toHaveBeenLastCalledWith(false)
    expect(bridge.setShortcutFocus).toHaveBeenCalledTimes(calls)
  })

  it('keeps pinned tabs outside the ordinary tab scroller', async () => {
    const { state, push } = await mountPanel(true)
    push({ ...state, tabs: [
      { ...state.tabs[0]!, id: 'regular', title: 'Regular' },
      { ...state.tabs[0]!, id: 'pinned', title: 'Pinned', pinned: true },
    ] })
    const pins = tree!.root.findByProps({ role: 'group', 'aria-label': 'Pinned tabs' })
    const regular = tree!.root.findByProps({ role: 'group', 'aria-label': 'Tabs' })
    // Two sibling scrollers, each with a hidden bar, so the pins never scroll away.
    expect(regular.findAllByProps({ 'aria-label': 'Pinned, pinned tab' })).toHaveLength(0)
    for (const group of [pins, regular]) expect(group.props.className).toContain('overflow-x-auto scrollbar-hidden')
    expect(pins.findByProps({ 'aria-label': 'Pinned, pinned tab' })).toBeDefined()
  })

  it('hands a tab its drag bounds only while pressed, released anywhere in the window', async () => {
    const { props, state } = await mountPanel(true)
    // Motion's layout pass reads the page scroll, which the bare document stub lacks.
    vi.stubGlobal('document', { ...document, documentElement: { scrollLeft: 0, scrollTop: 0 } })
    const moveTab = vi.fn(async () => state)
    await act(async () => tree!.update(<BrowserPanel {...props} bridge={{ ...props.bridge, moveTab }} />))
    // Motion rescales a resting item inside ref bounds on every resize, which stacked tabs.
    const tab = () => tree!.root.findAll((node) => node.props.value === 'tab' && 'dragConstraints' in node.props)[0]!
    expect(tab().props.dragConstraints).toBeUndefined()
    act(() => tab().props.onPointerDown())
    expect(tab().props.dragConstraints).toBeDefined()
    // Let go just past the tab's edge, short of a drag: only the window hears it.
    const release = vi.mocked(window.addEventListener).mock.calls.filter(([type]) => type === 'pointerup').pop()![1] as () => void
    act(() => release())
    expect(tab().props.dragConstraints).toBeUndefined()
  })

  it('saves the current page with the star and opens a saved page in this tab', async () => {
    const { bridge, state, push } = await mountPanel()
    await click('Save bookmark')
    expect(bridge.toggleBookmark).toHaveBeenCalledWith('https://example.com/', 'Example')
    expect(button('Remove bookmark').props['aria-pressed']).toBe(true)
    await click('Bookmarks')
    const savedPage = tree!.root.findAllByProps({ role: 'menuitem' }).find((node) =>
      node.findAll((child) => child.children.includes('https://example.com/')).length > 0)
    await act(async () => savedPage!.props.onClick())
    expect(bridge.navigate).toHaveBeenCalledWith('https://example.com/', 'chat')
    push({ ...state, activeTabId: null, tabs: [] })
    await click('Bookmarks')
    const savedPageWithoutTab = tree!.root.findAllByProps({ role: 'menuitem' }).find((node) =>
      node.findAll((child) => child.children.includes('https://example.com/')).length > 0)
    await act(async () => savedPageWithoutTab!.props.onClick())
    expect(bridge.newTab).toHaveBeenCalledWith('chat', 'https://example.com/')
    push(state)
    await click('Remove bookmark')
    expect(button('Save bookmark').props['aria-pressed']).toBe(false)
  })

  it('refreshes saved state when a chat browser becomes visible again', async () => {
    const { bridge, props } = await mountPanel()
    await act(async () => { tree!.update(<BrowserPanel {...props} shown={false} pageVisible={false} />) })
    await bridge.toggleBookmark('https://example.com/', 'Example')
    await act(async () => { tree!.update(<BrowserPanel {...props} shown pageVisible />) })
    expect(bridge.bookmarks).toHaveBeenCalledTimes(2)
    expect(button('Remove bookmark').props['aria-pressed']).toBe(true)
    await click('Remove bookmark')
    expect(button('Save bookmark').props['aria-pressed']).toBe(false)
  })

  it('runs Browser shortcuts while the Browser stage is active', async () => {
    const { bridge, state, push, addressFocus, addressSelect, shortcut } = await mountPanel(true)
    await shortcut('focus-address')
    expect(addressFocus).toHaveBeenCalledOnce()
    expect(addressSelect).toHaveBeenCalledOnce()
    await shortcut('new-tab')
    await shortcut('close-tab')
    await shortcut('reload')
    await shortcut('toggle-bookmark')
    expect(bridge.newTab).toHaveBeenCalledWith('chat')
    expect(bridge.closeTab).toHaveBeenCalledWith('tab', 'chat')
    expect(bridge.reload).toHaveBeenCalledWith('chat')
    expect(bridge.toggleBookmark).toHaveBeenCalledWith('https://example.com/', 'Example')
    const first = { ...state.tabs[0]!, canGoBack: true, canGoForward: true }
    const second = { ...first, id: 'second', title: 'Second' }
    push({ ...state, activeTabId: 'tab', tabs: [first, second] })
    await shortcut('back')
    await shortcut('forward')
    await shortcut('next-tab')
    push({ ...state, activeTabId: 'second', tabs: [first, second] })
    await shortcut('previous-tab')
    expect(bridge.goBack).toHaveBeenCalledWith('chat')
    expect(bridge.goForward).toHaveBeenCalledWith('chat')
    expect(bridge.tabs).toHaveBeenCalledWith('chat', 'second')
    expect(bridge.tabs).toHaveBeenCalledWith('chat', 'tab')
  })

  it('opens the device toolbar at desktop size from its own button, and closes it there', async () => {
    const { bridge, state, push } = await mountPanel()
    await click('Show device toolbar')
    expect(bridge.configure).toHaveBeenLastCalledWith('chat', { viewport: { width: 1440, height: 900 } })
    push({ ...state, tabs: [{ ...state.tabs[0]!, settings: { viewport: { width: 1440, height: 900 }, appearance: 'system', zoomFactor: 1 } }] })
    expect(button('Hide device toolbar').props['aria-pressed']).toBe(true)
    await click('Hide device toolbar')
    expect(bridge.configure).toHaveBeenLastCalledWith('chat', { viewport: null })
  })

  it('runs the same shortcuts in a chat panel, but not while its page is hidden', async () => {
    const { bridge, props, shortcut } = await mountPanel(false)
    await shortcut('new-tab')
    expect(bridge.newTab).toHaveBeenCalledOnce()
    expect(bridge.setShortcutFocus).toHaveBeenCalled()
    await act(async () => { tree!.update(<BrowserPanel {...props} pageVisible={false} />) })
    await shortcut('new-tab')
    expect(bridge.newTab).toHaveBeenCalledOnce()
  })

  it('focuses only the address field of the tab New tab created', async () => {
    const { state, push, addressFocus, shortcut } = await mountPanel(true)
    const older = { ...state.tabs[0]!, id: 'older', title: 'Older' }
    push({ ...state, tabs: [...state.tabs, older] })
    await shortcut('new-tab')
    push({ ...state, activeTabId: 'older', tabs: [...state.tabs, older] })
    expect(addressFocus).not.toHaveBeenCalled()
    const address = () => tree!.root.findByProps({ 'aria-label': 'Address' })
    // A real focus() runs the field's focus handler on the spot.
    addressFocus.mockImplementation(() => address().props.onFocus({ currentTarget: { select: vi.fn() } }))
    const created = { ...state.tabs[0]!, id: 'created', url: 'about:blank' }
    push({ ...state, activeTabId: 'created', tabs: [...state.tabs, older, created] })
    expect(addressFocus).toHaveBeenCalledOnce()
    // Focused for typing, but the suggestions wait for the first keystroke.
    expect(address().props['aria-expanded']).toBe(false)
    act(() => address().props.onChange({ target: { value: 'l' } }))
    expect(address().props['aria-expanded']).toBe(true)
  })

  it('shows an empty list and a retry when loading bookmarks fails', async () => {
    await mountPanel()
    await click('Bookmarks')
    expect(JSON.stringify(tree!.toJSON())).toContain('No bookmarks yet.')
    const props = tree!.root.findByType(BrowserBookmarksMenu).props as Parameters<typeof BrowserBookmarksMenu>[0]
    const retry = vi.fn()
    act(() => tree!.update(<BrowserBookmarksMenu {...props} bookmarks={null} error="Could not read bookmarks" onRetry={retry} />))
    await click('Bookmarks')
    expect(JSON.stringify(tree!.toJSON())).toContain('Could not read bookmarks')
    await click('Try again')
    expect(retry).toHaveBeenCalledOnce()
  })

  it('opens the existing settings and confirms full data clearing from the menu', async () => {
    const { bridge } = await mountPanel()
    await click('Browser menu'); await click('Browser settings')
    expect(tree!.root.findByType(Switch).props.label).toBe('Use logins from another browser')
    await click('Browser menu'); await click('Browser settings')
    expect(tree!.root.findAllByType(Switch)).toHaveLength(0)
    await click('Browser menu'); await click('Clear browser data')
    expect(bridge.clearData).not.toHaveBeenCalled()
    act(() => tree!.root.findByType(ConfirmStrip).props.onCancel())
    expect(tree!.root.findAllByType(ConfirmStrip)).toHaveLength(0)
    await click('Browser menu'); await click('Clear browser data')
    await act(async () => tree!.root.findByType(ConfirmStrip).props.onConfirm())
    expect(bridge.clearData).toHaveBeenCalledOnce()
    expect(tree!.root.findAllByType(ConfirmStrip)).toHaveLength(0)
  })

  it('shows recent history on address focus and navigates a chosen result', async () => {
    const { bridge } = await mountPanel()
    const address = tree!.root.findByProps({ 'aria-label': 'Address' })
    const select = vi.fn()
    await act(async () => address.props.onFocus({ currentTarget: { select } }))

    expect(select).toHaveBeenCalledOnce()
    expect(bridge.history).toHaveBeenCalledWith('')
    const result = tree!.root.findByProps({ role: 'option' })
    await act(async () => result.props.onClick())
    expect(bridge.navigate).toHaveBeenCalledWith('https://history.example/', 'chat')
  })

  it('closes the suggestions when the window resizes, since they were placed from the field', async () => {
    await mountPanel()
    const address = tree!.root.findByProps({ 'aria-label': 'Address' })
    await act(async () => address.props.onFocus({ currentTarget: { select: vi.fn() } }))
    expect(tree!.root.findAllByProps({ role: 'listbox' })).toHaveLength(1)
    const resize = vi.mocked(window.addEventListener).mock.calls.filter(([name]) => name === 'resize').at(-1)![1] as () => void
    act(() => resize())
    expect(tree!.root.findAllByProps({ role: 'listbox' })).toHaveLength(0)
  })

  it('searches history once after rapid address typing settles', async () => {
    vi.useFakeTimers()
    const { bridge } = await mountPanel()
    const address = tree!.root.findByProps({ 'aria-label': 'Address' })
    await act(async () => address.props.onFocus({ currentTarget: { select: vi.fn() } }))
    bridge.history.mockClear()

    act(() => address.props.onChange({ target: { value: 'h' } }))
    act(() => address.props.onChange({ target: { value: 'history' } }))
    await act(async () => { await vi.advanceTimersByTimeAsync(119) })
    expect(bridge.history).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(bridge.history).toHaveBeenCalledOnce()
    expect(bridge.history).toHaveBeenCalledWith('history')
    vi.useRealTimers()
  })

  it('keeps typing and history responses out of the surrounding browser chrome', async () => {
    vi.useFakeTimers()
    await mountPanel()
    const address = tree!.root.findByProps({ 'aria-label': 'Address' })
    const menuProps = tree!.root.findByType(BrowserMenu).props
    await act(async () => address.props.onFocus({ currentTarget: { select: vi.fn() } }))
    act(() => address.props.onChange({ target: { value: 'history' } }))
    expect(address.props.value).toBe('history')
    expect(tree!.root.findByType(BrowserMenu).props).toBe(menuProps)
    await act(async () => { await vi.advanceTimersByTimeAsync(120) })
    expect(tree!.root.findByType(BrowserMenu).props).toBe(menuProps)
    // The visit that starts with what was typed leads, and the typed row follows it.
    expect(tree!.root.findAllByProps({ role: 'option' })).toHaveLength(2)
  })

  it('hints the completion without typing it, and takes it only on Tab', async () => {
    vi.useFakeTimers()
    await mountPanel()
    const address = () => tree!.root.findByProps({ 'aria-label': 'Address' })
    await act(async () => address().props.onFocus({ currentTarget: { select: vi.fn() } }))
    act(() => address().props.onChange({ target: { value: 'hist' } }))
    await act(async () => { await vi.advanceTimersByTimeAsync(120) })
    const hint = () => tree!.root.findAll((node) => node.type === 'span' && node.props.children === 'ory.example')
    expect(address().props.value).toBe('hist')
    expect(hint()).toHaveLength(1)
    const options = () => tree!.root.findAllByProps({ role: 'option' })
    act(() => options()[1]!.props.onMouseMove())
    expect(options()[1]!.props['aria-selected']).toBe(true)
    expect(hint()).toHaveLength(0)
    act(() => options()[0]!.props.onMouseMove())
    act(() => address().props.onKeyDown({ key: 'Tab', preventDefault: vi.fn(), currentTarget: { value: 'hist', selectionStart: 4, selectionEnd: 4 } }))
    expect(address().props.value).toBe('history.example')
  })

  async function typeIntoAddress(text: string) {
    const mounted = await mountPanel()
    Object.assign(mounted.bridge, { addressMatches: vi.fn(async () => ({
      sites: [{ url: 'https://www.twitch.tv/', title: '(99+) Twitch', visitCount: 523, lastVisitedAt: 1 }],
      pages: [{ url: 'https://www.twitch.tv/zoomaa', title: 'Zoomaa - Twitch', visitCount: 400, lastVisitedAt: 1 }],
    })) })
    const address = () => tree!.root.findByProps({ 'aria-label': 'Address' })
    await act(async () => address().props.onFocus({ currentTarget: { select: vi.fn() } }))
    act(() => address().props.onChange({ target: { value: text }, nativeEvent: { inputType: 'insertText' } }))
    await act(async () => { await vi.advanceTimersByTimeAsync(120) })
    const key = (name: string) => act(() => address().props.onKeyDown({
      key: name, preventDefault: vi.fn(), currentTarget: { value: text, selectionStart: text.length, selectionEnd: text.length, select: vi.fn() },
    }))
    const hint = (rest: string) => tree!.root.findAll((node) => node.type === 'span' && node.props.children === rest)
    const submit = () => act(async () => tree!.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() }))
    return { ...mounted, address, key, hint, submit }
  }

  it('completes a prefix to the site and opens its root, not its most visited page', async () => {
    vi.useFakeTimers()
    const { bridge, hint, submit } = await typeIntoAddress('twitc')
    expect(hint('h.tv')).toHaveLength(1)
    const rows = tree!.root.findAllByProps({ role: 'option' })
    expect(rows.map((row) => row.props.id.split('-').slice(1).join('-'))).toEqual(
      expect.arrayContaining(['site:https://www.twitch.tv/', 'search', 'https://www.twitch.tv/zoomaa']),
    )
    await submit()
    expect(bridge.navigate).toHaveBeenLastCalledWith('https://www.twitch.tv/', 'chat')
  })

  it('removes only the completion on Backspace, so the typed text searches', async () => {
    vi.useFakeTimers()
    const { bridge, address, key, hint, submit } = await typeIntoAddress('twitc')
    key('Backspace')
    expect(hint('h.tv')).toHaveLength(0)
    expect(address().props.value).toBe('twitc')
    await submit()
    expect(bridge.navigate).toHaveBeenLastCalledWith('https://www.google.com/search?q=twitc', 'chat')
  })

  it('leaves keys alone while an input method is composing', async () => {
    vi.useFakeTimers()
    const { address, hint } = await typeIntoAddress('twitc')
    act(() => address().props.onKeyDown({ key: 'Backspace', nativeEvent: { isComposing: true }, preventDefault: vi.fn(), currentTarget: { value: 'twitc', selectionStart: 5, selectionEnd: 5 } }))
    expect(hint('h.tv')).toHaveLength(1)
    act(() => address().props.onChange({ target: { value: 'twitch' }, nativeEvent: { inputType: 'insertCompositionText' } }))
    expect(hint('.tv')).toHaveLength(0)
  })

  it('walks the rows with the arrow keys and closes on Escape with the page address back', async () => {
    vi.useFakeTimers()
    const { bridge, address, key, hint, submit } = await typeIntoAddress('twitc')
    key('ArrowDown')
    // The completion shows only while its site row is the one Enter takes.
    expect(hint('h.tv')).toHaveLength(0)
    await submit()
    expect(bridge.navigate).toHaveBeenLastCalledWith('https://www.google.com/search?q=twitc', 'chat')
    act(() => address().props.onChange({ target: { value: 'twitc' }, nativeEvent: { inputType: 'insertText' } }))
    key('Escape')
    expect(tree!.root.findAllByProps({ role: 'listbox' })).toHaveLength(0)
    expect(address().props.value).toBe('https://example.com')
  })

  it('keeps the resting field hidden under the site while an agent holds the page', async () => {
    const { props } = await mountPanel()
    await act(async () => tree!.update(<BrowserPanel {...props} activity={{ agentId: 'smith', agentName: 'Smith', tool: 'browser_click' }} />))
    const field = tree!.root.findByProps({ 'aria-label': 'Address' })
    expect(field.props.disabled).toBe(true)
    // The site dims itself; a disabled opacity on the hidden field would bring the full address back on top of it.
    expect(field.props.className).toContain('opacity-0')
    expect(field.props.className).not.toContain('disabled:opacity-60')
  })

  it('shows a fresh tab as an empty address', async () => {
    const { state, push } = await mountPanel()
    push({ ...state, tabs: [{ ...state.tabs[0]!, url: 'about:blank#manor-3', title: '' }] })
    expect(tree!.root.findByProps({ 'aria-label': 'Address' }).props.value).toBe('')
  })

  it('takes the highlighted suggestion on Enter and moves it with the arrow keys', async () => {
    vi.useFakeTimers()
    const { bridge } = await mountPanel()
    const address = () => tree!.root.findByProps({ 'aria-label': 'Address' })
    const key = (name: string) => act(() => address().props.onKeyDown({ key: name, preventDefault: vi.fn(), currentTarget: { value: 'history', selectionStart: 7, selectionEnd: 7 } }))
    const submit = () => act(async () => tree!.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() }))
    await act(async () => address().props.onFocus({ currentTarget: { select: vi.fn() } }))
    act(() => address().props.onChange({ target: { value: 'history' } }))
    await act(async () => { await vi.advanceTimersByTimeAsync(120) })
    key('ArrowDown')
    expect(tree!.root.findAllByProps({ role: 'option' })[1]!.props['aria-selected']).toBe(true)
    key('ArrowUp')
    await submit()
    expect(bridge.navigate).toHaveBeenLastCalledWith('https://history.example/', 'chat')
  })


  it('submits the current address immediately while suggestions are still pending', async () => {
    vi.useFakeTimers()
    const { bridge } = await mountPanel()
    const address = tree!.root.findByProps({ 'aria-label': 'Address' })
    act(() => address.props.onChange({ target: { value: 'my search' } }))
    await act(async () => tree!.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() }))
    expect(bridge.navigate).toHaveBeenCalledWith('https://www.google.com/search?q=my+search', 'chat')
    await act(async () => { await vi.advanceTimersByTimeAsync(120) })
    expect(bridge.history).not.toHaveBeenCalled()
    expect(tree!.root.findAllByProps({ role: 'listbox' })).toHaveLength(0)
  })

  it('discards a pending history response when switching tabs', async () => {
    const { bridge, state, push } = await mountPanel()
    let finish = () => {}
    bridge.history.mockImplementationOnce(() => new Promise((resolve) => {
      finish = () => resolve([{ url: 'https://old.example/', title: 'Old result', visitCount: 1, lastVisitedAt: 0 }])
    }))
    await act(async () => tree!.root.findByProps({ 'aria-label': 'Address' }).props.onFocus({ currentTarget: { select: vi.fn() } }))
    const nextTab = { ...state.tabs[0]!, id: 'next', url: 'https://next.example/' }
    push({ ...state, activeTabId: nextTab.id, tabs: [...state.tabs, nextTab] })
    await act(async () => finish())
    expect(tree!.root.findByProps({ 'aria-label': 'Address' }).props.value).toBe(nextTab.url)
    expect(tree!.root.findAllByProps({ role: 'listbox' })).toHaveLength(0)
  })

  it('ignores a superseded search and locks address submission while an agent owns the page', async () => {
    vi.useFakeTimers()
    const { bridge, props } = await mountPanel()
    let finish = () => {}
    bridge.history.mockImplementationOnce(() => new Promise((resolve) => {
      finish = () => resolve([{ url: 'https://old.example/', title: 'Old result', visitCount: 1, lastVisitedAt: 0 }])
    }))
    const address = tree!.root.findByProps({ 'aria-label': 'Address' })
    await act(async () => address.props.onFocus({ currentTarget: { select: vi.fn() } }))
    act(() => address.props.onChange({ target: { value: 'history' } }))
    await act(async () => { await vi.advanceTimersByTimeAsync(120) })
    await act(async () => finish())
    expect(tree!.root.findAllByProps({ role: 'option' })[0]!.findAll((node) => node.children.includes('History result'))).not.toHaveLength(0)
    expect(JSON.stringify(tree!.toJSON())).not.toContain('Old result')
    await act(async () => tree!.update(<BrowserPanel {...props} activity={{ agentId: 'smith', agentName: 'Smith', tool: 'browser_click' }} />))
    expect(tree!.root.findByProps({ 'aria-label': 'Address' }).props.disabled).toBe(true)
    expect(tree!.root.findAllByProps({ role: 'listbox' })).toHaveLength(0)
    await act(async () => tree!.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() }))
    expect(bridge.navigate).not.toHaveBeenCalled()
  })

  it('floats from the address bar and disables the action on older bridges', async () => {
    const { props } = await mountPanel()
    const buttons = tree!.root.findAllByType('button')
    expect(buttons.indexOf(button('Float preview over chat')) + 1).toBe(buttons.indexOf(button('Browser menu')))
    await click('Float preview over chat')
    expect(props.onFloat).toHaveBeenCalledOnce()
    await act(async () => tree!.update(<BrowserPanel {...props} bridge={{ ...props.bridge, startPreview: undefined }} />))
    expect(button('Float preview over chat').props.disabled).toBe(true)
  })

  it('allows reopening the floating view while an agent owns browser input', async () => {
    const { props } = await mountPanel()
    await act(async () => tree!.update(<BrowserPanel {...props} activity={{ agentId: 'smith', agentName: 'Smith', tool: 'browser_click' }} />))
    expect(button('Float preview over chat').props.disabled).toBe(false)
    await click('Float preview over chat')
    expect(props.onFloat).toHaveBeenCalledOnce()
  })

  it('restores natural sizing when the device toolbar closes', async () => {
    const { state, bridge, push } = await mountPanel()
    push({ ...state, tabs: [{ ...state.tabs[0]!, settings: { viewport: { width: 390, height: 844 }, appearance: 'system', zoomFactor: 1 } }] })
    await click('Close device toolbar')
    expect(bridge.configure).toHaveBeenCalledWith('chat', { viewport: null })
    push(state)
    expect(tree!.root.findAllByType(BrowserDeviceToolbar)).toHaveLength(0)
  })

  it('keeps the sidebar slot when a passive separate preview opens', async () => {
    const { state, push, bridge } = await mountPanel()
    push({ ...state, previewWindowOpen: true })
    expect(tree!.root.findByProps({ 'data-browser-slot': 'sidebar' })).toBeDefined()
    expect(JSON.stringify(tree!.toJSON())).not.toContain('Close that window')
    expect(tree!.root.findAllByType('img')).toHaveLength(0)
    expect(bridge.hide).not.toHaveBeenCalled()
  })
})

describe('find bar', () => {
  it('searches again when the visible document changes or finishes loading, with no edit', async () => {
    const findInPage = vi.fn(async () => ({ matches: 3, active: 1 }))
    const bridge = { findInPage, stopFind: vi.fn(async () => {}) }
    const bar = (page: string, loading = false) => (
      <BrowserFindBar bridge={bridge} chatId="chat" page={page} loading={loading} summon={0} onClose={vi.fn()} />
    )
    await act(async () => { tree = create(bar('sign-in https://login.example/')) })
    await act(async () => tree!.root.findByType('input').props.onChange({ target: { value: 'apples' } }))
    const status = () => tree!.root.findByProps({ 'aria-live': 'polite' }).children.join('')
    expect(status()).toBe('1 of 3')

    findInPage.mockResolvedValue({ matches: 0, active: 0 })
    await act(async () => tree!.update(bar('page https://signin.example/')))
    expect(findInPage).toHaveBeenCalledTimes(2)
    expect(status()).toBe('No results')

    await act(async () => tree!.update(bar('page https://signin.example/', true)))
    expect(status()).toBe('')
    findInPage.mockResolvedValue({ matches: 2, active: 1 })
    await act(async () => tree!.update(bar('page https://signin.example/')))
    expect(findInPage).toHaveBeenCalledTimes(3)
    expect(status()).toBe('1 of 2')
  })
})
