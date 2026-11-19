import type { BrowserSessionState, BrowserTabState, DesktopBrowserBridge } from '@manor/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { addressParts, resolveBrowserAddress } from '../src/browserAddress'
import {
  browserPanelLayoutClass,
  browserStateForChat,
  BrowserPanel,
  isPersistentBrowserProfileFailure,
  Tab,
} from '../src/components/BrowserPanel'
import { browserActorLabel } from '../src/desktopBrowser'

const tab = (over: Partial<BrowserTabState> = {}): BrowserTabState => ({
  id: 'tab_1',
  title: 'Example Domain',
  url: 'https://example.com/',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  ...over,
})

const session = (over: Partial<BrowserSessionState> = {}): BrowserSessionState => ({
  chatId: 'chat_1',
  tabs: [tab()],
  activeTabId: 'tab_1',
  ...over,
})

const bridge = (state = session()): DesktopBrowserBridge => ({
  webviews: { list: vi.fn(), onChange: vi.fn(), attach: vi.fn(), presented: vi.fn() },
  show: vi.fn(async () => {}),
  hide: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
  navigate: vi.fn(async (url) => ({ url, title: '' })),
  snapshot: vi.fn(async () => ({
    url: '',
    title: '',
    visibleText: '',
    interactiveElements: [],
    console: [],
  })),
  click: vi.fn(async (selector) => ({ url: '', title: '', selector })),
  type: vi.fn(async (selector) => ({ selector })),
  press: vi.fn(async (key) => ({ key })),
  scroll: vi.fn(async (deltaX, deltaY) => ({ deltaX, deltaY })),
  screenshot: vi.fn(async () => ({ url: '', title: '', screenshot: '' })),
  selectPageContext: vi.fn(async () => null),
  tabs: vi.fn(async () => state),
  newTab: vi.fn(async () => state),
  closeTab: vi.fn(async () => state),
  goBack: vi.fn(async () => {}),
  goForward: vi.fn(async () => {}),
  reload: vi.fn(async () => {}),
  stopLoading: vi.fn(async () => {}),
  clearData: vi.fn(async () => {}),
  onState: vi.fn(() => () => {}),
})

const panel = (props: Partial<Parameters<typeof BrowserPanel>[0]> = {}) =>
  renderToStaticMarkup(
    <BrowserPanel
      chatId="chat_1"
      bridge={bridge()}
      activity={undefined}
      searchEngine="google"
      settling={false}
      pageContextCount={0}
      onAddPageContext={() => {}}
      width={620}
      expanded={false}
      resizing={false}
      resizeProps={{}}
      onToggleExpanded={() => {}}
      onClose={() => {}}
      {...props}
    />,
  )

/** Read off the element itself: a panel-wide match would pass on a neighbour's state. */
const control = (markup: string, label: string) =>
  new RegExp(`<(?:input|button)[^>]*aria-label="${label}"[^>]*>`).exec(markup)?.[0] ?? ''

describe('the browser address field', () => {
  it('explains why an open panel is not displaying the shared native page', () => {
    expect(panel({ pageVisible: false })).toContain('Focus this thread to show its browser.')
    expect(panel()).not.toContain('Focus this thread to show its browser.')
  })

  it('sends ordinary text to the search engine', () => {
    expect(resolveBrowserAddress('in app browser', 'google')).toBe(
      'https://www.google.com/search?q=in+app+browser',
    )
  })

  it('opens website addresses, giving a bare host its scheme', () => {
    expect(resolveBrowserAddress('example.com/path', 'google')).toBe('https://example.com/path')
    expect(resolveBrowserAddress('https://example.com/path', 'google')).toBe('https://example.com/path')
    expect(resolveBrowserAddress('localhost:5173', 'google')).toBe('http://localhost:5173')
  })

  it('leaves explicit unsupported schemes for the browser host to reject', () => {
    expect(resolveBrowserAddress('javascript:alert(1)', 'google')).toBe('javascript:alert(1)')
  })

  it('rests a web address on its site, split so the pieces rejoin exactly', () => {
    expect(addressParts('https://www.example.com/pricing'))
      .toEqual({ before: 'https://www.', site: 'example.com', after: '/pricing' })
    expect(addressParts('http://localhost:5173/x')?.site).toBe('localhost:5173')
    expect(addressParts('about:blank')).toBe(null)
  })
})

describe('the shared browser panel', () => {
  it('keeps the resize handle available when the panel overlays the chat', () => {
    const props = { role: 'separator', 'aria-label': 'Resize browser panel' }
    const markup = panel({ overlay: true, resizeProps: props })
    const handle = /<div[^>]*aria-label="Resize browser panel"[^>]*>/.exec(markup)?.[0]
    expect(handle).toBeDefined()
    expect(handle).not.toMatch(/class="hidden /)
    expect(panel({ expanded: true, resizeProps: props })).not.toContain('Resize browser panel')
  })

  it('leaves the chat-only controls off the full-stage Browser', () => {
    const docked = panel({ onFloat: () => {} })
    expect(docked).toContain('Float preview over chat')
    expect(docked).toContain('Close browser panel')
    const stage = panel({ stage: true, onClose: undefined, onAddPageContext: undefined, onFloat: undefined })
    expect(stage).not.toContain('Float preview over chat')
    expect(stage).not.toContain('Select page context')
    expect(stage).not.toContain('Close browser panel')
    expect(stage).not.toContain('Expand browser panel')
    expect(stage).toContain('aria-label="Reload"')
    expect(panel({ stage: true, stageControl: <button type="button" aria-label="Hide chat" /> })).toContain('aria-label="Hide chat"')
  })

  it('places the sidebar handle before tabs and the chat handle at the other end', () => {
    const stage = panel({ stage: true,
      stageLeadingControl: <button type="button" aria-label="Show sidebar" />,
      stageControl: <button type="button" aria-label="Hide chat" /> })
    expect(stage.indexOf('aria-label="Show sidebar"')).toBeLessThan(stage.indexOf('aria-label="New tab"'))
    expect(stage.indexOf('aria-label="New tab"')).toBeLessThan(stage.indexOf('aria-label="Hide chat"'))
    expect(stage).toContain('pl-[calc(4px+var(--titlebar-inset))]')
    expect(panel({ stageLeadingControl: <button type="button" aria-label="Show sidebar" /> }))
      .not.toContain('aria-label="Show sidebar"')
  })

  it('stops frame-by-frame retries for a fail-closed Dia profile error', () => {
    expect(isPersistentBrowserProfileFailure(
      new Error('MANOR_BROWSER_PROFILE_UNAVAILABLE: Dia profile not found'),
    )).toBe(true)
    expect(isPersistentBrowserProfileFailure(new Error('MediaError while playing video'))).toBe(false)
    expect(isPersistentBrowserProfileFailure(new Error('temporary renderer failure'))).toBe(false)
  })

  it('ignores state pushed by a browser in another chat', () => {
    const visible = session()
    const background = session({ chatId: 'chat_2', tabs: [tab({ title: 'Background' })] })

    expect(browserStateForChat('chat_1', visible, background)).toBe(visible)
    expect(browserStateForChat('chat_1', null, background)).toBeNull()
  })

  it('says out loud that the browser needs the desktop app, rather than showing a dead frame', () => {
    const markup = panel({ bridge: undefined })
    expect(markup).toContain('The shared browser needs the desktop app')
    // No address field and no toolbar either: a control that cannot reach a browser
    // is the silently dead affordance the explanation replaces.
    expect(markup).not.toContain('aria-label="Address"')
    expect(markup).not.toContain('aria-label="Reload"')
  })

  it('names the agent that has the page while its action runs', () => {
    const markup = panel({
      activity: { agentId: 'sage', agentName: 'Sage', tool: 'browser_click' },
    })
    expect(markup).toContain('aria-label="Sage is using the browser"')
    expect(markup).toContain('Sage')
  })

  it('says nothing at all between agent actions, which is when the page is the user’s', () => {
    expect(panel()).not.toContain('is using the browser')
  })

  it('keeps profile actions inside the browser menu', () => {
    expect(control(panel(), 'Browser menu')).not.toContain('disabled=""')
    expect(control(panel(), 'Browser settings')).toBe('')
    expect(control(panel(), 'Clear browser data')).toBe('')
  })

  it('offers page context selection until the draft reaches its cap', () => {
    expect(control(panel(), 'Select page context')).not.toBe('')
    expect(control(panel({ pageContextCount: 3 }), 'Up to 3 page contexts per message')).toContain('disabled=""')
  })

  it('puts page context beside reload, the star in the address and the menu after it, not on the tab strip', () => {
    const markup = panel()
    const reload = markup.indexOf('aria-label="Reload"')
    const address = markup.indexOf('aria-label="Address"')
    const select = markup.indexOf('aria-label="Select page context"')
    const star = markup.search(/aria-label="(Save bookmark|Update the desktop app for bookmarks)"/)
    const menu = markup.indexOf('aria-label="Browser menu"')
    const expand = markup.indexOf('aria-label="Expand browser panel"')
    expect(address).toBeGreaterThan(-1)
    expect(select).toBeGreaterThan(reload)
    expect(address).toBeGreaterThan(select)
    expect(star).toBeGreaterThan(address)
    expect(menu).toBeGreaterThan(star)
    expect(expand).toBeGreaterThan(-1)
    expect(expand).toBeLessThan(address)
  })

  it('sets tab titles a step smaller than the rest of the chrome', () => {
    const html = renderToStaticMarkup(
      <Tab tab={tab()} active disabled={false} onSelect={() => undefined} onClose={() => undefined} />,
    )
    expect(html).toContain('text-meta')
  })

  it('marks a popup that opened behind the active tab until it is selected', () => {
    const render = (active: boolean) => renderToStaticMarkup(
      <Tab tab={{ ...tab(), unseen: true }} active={active} disabled={false} onSelect={() => undefined} onClose={() => undefined} />,
    )
    expect(render(false)).toContain('aria-label="New from the page"')
    expect(render(true)).not.toContain('New from the page')
    expect(renderToStaticMarkup(<Tab tab={tab()} active={false} disabled={false} onSelect={() => undefined} onClose={() => undefined} />))
      .not.toContain('New from the page')
  })

  it('takes every control away for exactly the length of one agent action', () => {
    const idle = panel()
    expect(control(idle, 'Address')).not.toContain('disabled=""')
    expect(control(idle, 'New tab')).not.toContain('disabled=""')

    const acting = panel({ activity: { agentId: 'sage', agentName: 'Sage', tool: 'browser_type' } })
    expect(control(acting, 'Address')).toContain('disabled=""')
    expect(control(acting, 'New tab')).toContain('disabled=""')
  })

  it('offers a new tab even before the session has one', () => {
    expect(panel()).toContain('aria-label="New tab"')
  })

  it('switches between docked and full screen without a width transition', () => {
    expect(browserPanelLayoutClass(true)).toContain('absolute inset-y-0 right-0 z-[8] my-2 mr-2 w-[calc(100%-16px)]')
    expect(browserPanelLayoutClass(false)).toContain('relative my-2 mr-2 w-[calc(var(--browser-width)-8px)]')
    expect(browserPanelLayoutClass(true)).not.toContain('transition')
    expect(browserPanelLayoutClass(false)).not.toContain('transition')
  })

  it('leaves history arrows dead until the page has somewhere to go', () => {
    // The strip arrives by push, so the first paint has no tab and no history yet.
    expect(control(panel(), 'Back')).toContain('disabled=""')
    expect(control(panel(), 'Forward')).toContain('disabled=""')
  })

  it('says nothing at all while the panel is travelling', () => {
    // The native view stands down for those 200 ms because it cannot pass behind
    // the rail, and a line of text arriving and leaving with it is a flicker.
    const markup = panel({ settling: true })
    expect(markup).not.toContain('No tabs open')
    expect(markup).not.toContain('parked while this dialog is open')
  })

  it('requires an updated shell instead of reviving native parking', () => {
    expect(panel({ bridge: { ...bridge(), webviews: undefined } })).toContain('Update the desktop app to use the browser')
  })

  it('says the session has no tabs rather than showing an unexplained rectangle', () => {
    expect(panel()).toContain('No tabs open')
  })

  it('offers the real browser only where this host has one', () => {
    expect(panel()).not.toContain('Open in default browser')
  })
})

describe('a tab in the strip', () => {
  const chip = (over: Partial<BrowserTabState> = {}, disabled = false) =>
    renderToStaticMarkup(
      <Tab tab={tab(over)} active disabled={disabled} onSelect={() => {}} onClose={() => {}} />,
    )

  it('wears the site’s own mark when the host has fetched one', () => {
    // Already inlined by the main process: Manor's own window never requests
    // anything from a page the browser visited.
    expect(chip({ favicon: 'data:image/png;base64,AA==' }))
      .toContain('src="data:image/png;base64,AA=="')
  })

  it('shows a pinned tab as one favicon button with its full name available', () => {
    const markup = chip({ pinned: true, favicon: 'data:image/png;base64,AA==' })
    expect(markup).toContain('aria-label="Example Domain, pinned tab"')
    expect(markup).toContain('src="data:image/png;base64,AA=="')
    expect(markup).not.toContain('Close Example Domain')
  })

  it('falls back to a globe rather than an empty square', () => {
    const markup = chip()
    expect(markup).not.toContain('<img')
    expect(markup).toContain('<svg')
  })

  it('keeps the close control small, so a hidden button leaves no hole', () => {
    // `h-6 w-6` as a class silently loses to the shared button's own `h-8 w-8`,
    // which is why this rides on the size prop and is asserted here.
    expect(chip()).toContain('height:20px')
  })

  it('names an untitled page by its host, and a blank one plainly', () => {
    expect(chip({ title: '' })).toContain('example.com')
    expect(chip({ title: '', url: '' })).toContain('New tab')
    expect(chip({ title: 'about:blank', url: 'about:blank' })).toContain('New tab')
  })
})

describe('browserActorLabel', () => {
  it('is null when nobody is driving', () => {
    expect(browserActorLabel(undefined)).toBe(null)
  })

  it('names the persona, never the tool', () => {
    expect(browserActorLabel({ agentId: 'smith', agentName: 'Smith', tool: 'browser_scroll' })).toBe(
      'Smith is using the browser',
    )
  })
})
