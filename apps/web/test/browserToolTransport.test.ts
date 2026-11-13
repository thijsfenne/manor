import type { BrowserTabState, DesktopBrowserBridge, ServerMessage } from '@manor/contracts'
import { describe, expect, it, vi } from 'vitest'
import { answerBrowserTool } from '../src/useWorkspace'

const request = (
  tool: Extract<ServerMessage, { type: 'browser_tool_request' }>['tool'],
  arguments_: Record<string, unknown>,
): Extract<ServerMessage, { type: 'browser_tool_request' }> => ({
  type: 'browser_tool_request',
  requestId: 'request_1',
  chatId: 'chat_1',
  actor: { id: 'sage', name: 'Sage' },
  tool,
  arguments: arguments_,
})

const tab = (id: string, url: string, title: string): BrowserTabState => ({
  id, url, title, favicon: '', loading: false, canGoBack: false, canGoForward: false,
})

const bridge = (): DesktopBrowserBridge => ({
  show: vi.fn(async () => {}),
  hide: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
  navigate: vi.fn(async (url) => ({ url, title: 'Example Domain' })),
  snapshot: vi.fn(async () => ({
    url: 'https://example.com/',
    title: 'Example Domain',
    visibleText: 'Example Domain',
    interactiveElements: [],
    console: [],
  })),
  click: vi.fn(async (selector) => ({ url: '', title: '', selector })),
  type: vi.fn(async (selector) => ({ selector })),
  press: vi.fn(async (key) => ({ key })),
  scroll: vi.fn(async (deltaX, deltaY) => ({ deltaX, deltaY })),
  screenshot: vi.fn(async () => ({ url: '', title: '', screenshot: 'data:image/png;base64,AA==' })),
  selectPageContext: vi.fn(async () => null),
  tabs: vi.fn(async () => ({ chatId: 'chat_1', tabs: [], activeTabId: null })),
  newTab: vi.fn(async () => ({ chatId: 'chat_1', tabs: [], activeTabId: null })),
  closeTab: vi.fn(async () => ({ chatId: 'chat_1', tabs: [], activeTabId: null })),
  goBack: vi.fn(async () => {}),
  goForward: vi.fn(async () => {}),
  reload: vi.fn(async () => {}),
  stopLoading: vi.fn(async () => {}),
  clearData: vi.fn(async () => {}),
  onState: vi.fn(() => () => {}),
})

describe('desktop browser tool transport', () => {
  it('binds navigation to the request chat', async () => {
    const browser = bridge()
    const result = await answerBrowserTool(
      request('browser_navigate', { url: 'https://example.com/' }),
      browser,
    )
    expect(browser.navigate).toHaveBeenCalledWith('https://example.com/', 'chat_1')
    expect(result).toMatchObject({ type: 'browser_tool_result', ok: true })
  })

  it('keeps saved-login metadata out of the tab strip an agent reads', async () => {
    const browser = bridge()
    const tab = { id: 'tab_1', url: 'https://example.com/', title: 'Example', loading: false, canGoBack: false, canGoForward: false }
    vi.mocked(browser.tabs).mockResolvedValueOnce({ chatId: 'chat_1', activeTabId: 'tab_1',
      tabs: [{ ...tab, passwords: { logins: [{ id: 'login_1', username: 'me@example.com' }] } }] })
    const result = await answerBrowserTool(request('browser_tabs', {}), browser)
    expect(result).toMatchObject({ ok: true, result: { tabs: [tab] } })
    expect(JSON.stringify(result)).not.toContain('me@example.com')
  })

  it.each([
    ['browser_navigate', { url: 'https://example.com/' }, 'navigate'],
    ['browser_tabs', { open: 'https://example.com/' }, 'newTab'],
  ] as const)('stops %s between the tab lookup and the next native step', async (tool, args, next) => {
    const browser = bridge()
    let using = true
    vi.mocked(browser.tabs).mockImplementationOnce(async () => {
      using = false
      return { chatId: 'chat_1', tabs: [], activeTabId: null }
    })
    const result = await answerBrowserTool(request(tool, args), browser, () => using)
    expect(browser[next]).not.toHaveBeenCalled()
    expect(result).toMatchObject({ ok: false, error: 'Browser agent use stopped.' })
  })

  it('stops before selecting a matching tab once the turn has stopped', async () => {
    const browser = bridge()
    let using = true
    vi.mocked(browser.tabs).mockImplementationOnce(async () => {
      using = false
      return { chatId: 'chat_1', tabs: [tab('tab_1', 'https://other.test/', 'Other'), tab('tab_2', 'https://example.com/', 'Example')], activeTabId: 'tab_1' }
    })
    const result = await answerBrowserTool(request('browser_navigate', { url: 'https://example.com/' }), browser, () => using)
    expect(browser.tabs).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ ok: false, error: 'Browser agent use stopped.' })
  })

  it('returns a clean unavailable result outside Electron', async () => {
    await expect(answerBrowserTool(request('browser_snapshot', {}), undefined)).resolves.toEqual({
      type: 'browser_tool_result',
      requestId: 'request_1',
      ok: false,
      error: 'No Manor desktop browser host is connected.',
    })
  })

  it('keeps interaction tools on the same chat session', async () => {
    const browser = bridge()
    await answerBrowserTool(request('browser_click', { selector: '#learn-more' }), browser)
    expect(browser.click).toHaveBeenCalledWith('#learn-more', 'chat_1')
  })

  it('lists tabs when asked for nothing in particular', async () => {
    const browser = bridge()
    await answerBrowserTool(request('browser_tabs', {}), browser)
    expect(browser.tabs).toHaveBeenCalledWith('chat_1', undefined)
  })

  it('switches tabs when handed one, and ignores a selection that is not an id', async () => {
    const browser = bridge()
    await answerBrowserTool(request('browser_tabs', { select: 'tab_2' }), browser)
    expect(browser.tabs).toHaveBeenCalledWith('chat_1', 'tab_2')

    await answerBrowserTool(request('browser_tabs', { select: 7 }), browser)
    expect(browser.tabs).toHaveBeenLastCalledWith('chat_1', undefined)
  })

  it('prepares explicit requests without allocating blank tabs', async () => {
    const browser = bridge()
    await answerBrowserTool(request('browser_tabs', { prepare: true }), browser)
    await answerBrowserTool(request('browser_tabs', { prepare: true }), browser)
    expect(browser.newTab).not.toHaveBeenCalled()
    expect(browser.tabs).toHaveBeenCalledTimes(2)
    expect(browser.navigate).not.toHaveBeenCalled()
  })

  it('opens an explicit URL in a new tab', async () => {
    const browser = bridge()
    await answerBrowserTool(
      request('browser_tabs', { open: 'https://jobs.example.com/vacancy' }),
      browser,
    )
    expect(browser.newTab).toHaveBeenCalledWith('chat_1', 'https://jobs.example.com/vacancy')
    expect(browser.tabs).toHaveBeenCalledWith('chat_1')
  })

  it.each(['browser_navigate', 'browser_tabs'] as const)('reuses an exact URL through %s without reloading', async (tool) => {
    const browser = bridge()
    const tabs = [
      tab('tab_1', 'https://example.com/', 'Example'),
      tab('tab_2', 'https://unrelated.test/', 'Keep this'),
    ]
    vi.mocked(browser.tabs).mockImplementation(async (_chat, select) => ({ chatId: 'chat_1', tabs, activeTabId: select ?? 'tab_2' }))
    const result = await answerBrowserTool(request(tool, tool === 'browser_navigate'
      ? { url: 'https://EXAMPLE.com:443' } : { open: 'https://EXAMPLE.com:443' }), browser)
    expect(result.ok).toBe(true)
    expect(browser.tabs).toHaveBeenLastCalledWith('chat_1', 'tab_1')
    expect(browser.navigate).not.toHaveBeenCalled()
    expect(browser.newTab).not.toHaveBeenCalled()
  })

  it('prefers the active exact match but honors an explicit new-tab request', async () => {
    const browser = bridge()
    vi.mocked(browser.tabs).mockResolvedValue({ chatId: 'chat_1', activeTabId: 'b', tabs: [
      tab('a', 'https://example.com/', 'A'),
      tab('b', 'https://example.com/', 'B'),
    ] })
    await answerBrowserTool(request('browser_tabs', { open: 'https://example.com/' }), browser)
    expect(browser.tabs).toHaveBeenCalledTimes(1)
    expect(browser.newTab).not.toHaveBeenCalled()
    await answerBrowserTool(request('browser_tabs', { open: 'https://example.com/', forceNew: true }), browser)
    expect(browser.newTab).toHaveBeenCalledWith('chat_1', 'https://example.com/')
  })

  it('does not confuse different query strings or fragments with the requested document', async () => {
    const browser = bridge()
    vi.mocked(browser.tabs).mockResolvedValue({ chatId: 'chat_1', activeTabId: 'a', tabs: [
      tab('a', 'https://example.com/?doc=1#one', 'Document'),
    ] })
    await answerBrowserTool(request('browser_tabs', { open: 'https://example.com/?doc=2#one' }), browser)
    await answerBrowserTool(request('browser_tabs', { open: 'https://example.com/?doc=1#two' }), browser)
    expect(browser.newTab).toHaveBeenCalledTimes(2)
  })

  it('fails if the matching tab disappears, without navigating or opening a replacement', async () => {
    const browser = bridge()
    vi.mocked(browser.tabs)
      .mockResolvedValueOnce({ chatId: 'chat_1', activeTabId: 'b', tabs: [
        tab('a', 'https://example.com/', 'Example'),
      ] })
      .mockRejectedValueOnce(new Error('Tab closed'))
    const reply = await answerBrowserTool(request('browser_tabs', { open: 'https://example.com' }), browser)
    expect(reply).toMatchObject({ ok: false, error: 'Tab closed' })
    expect(browser.newTab).not.toHaveBeenCalled()
    expect(browser.navigate).not.toHaveBeenCalled()
  })

  it('refuses a tab listing from another chat', async () => {
    const browser = bridge()
    vi.mocked(browser.tabs).mockResolvedValue({ chatId: 'other', activeTabId: null, tabs: [] })
    expect(await answerBrowserTool(request('browser_tabs', { open: 'https://example.com' }), browser)).toMatchObject({ ok: false })
    expect(browser.newTab).not.toHaveBeenCalled()
  })

  it('refuses to report the old page if the selected tab navigated meanwhile', async () => {
    const browser = bridge()
    vi.mocked(browser.tabs)
      .mockResolvedValueOnce({ chatId: 'chat_1', activeTabId: 'b', tabs: [
        tab('a', 'https://example.com/', 'Before'),
      ] })
      .mockResolvedValueOnce({ chatId: 'chat_1', activeTabId: 'a', tabs: [
        tab('a', 'https://different.test/', 'After'),
      ] })
    expect(await answerBrowserTool(request('browser_navigate', { url: 'https://example.com' }), browser)).toMatchObject({ ok: false })
    expect(browser.navigate).not.toHaveBeenCalled()
  })

  it('reads a page without paying for a picture of it', async () => {
    const browser = bridge()
    const reply = await answerBrowserTool(request('browser_snapshot', {}), browser)
    // The whole point of the split: a snapshot carries no screenshot at all, so
    // reading a page costs its text and nothing else.
    expect(reply).toMatchObject({ ok: true })
    expect(JSON.stringify(reply)).not.toContain('base64')
  })

  it('passes a saved-login fill to the desktop in its two server-built steps', async () => {
    const browser = bridge()
    const lookup = { tabId: 'tab_1', pageId: 7, origin: 'https://github.com', login: { id: 'login_1', username: 'sam' }, passwordField: true }
    browser.findSavedLogin = vi.fn(async () => lookup)
    browser.fillSavedLogin = vi.fn(async () => ({ username: 'sam' }))

    expect(await answerBrowserTool(request('browser_fill_login', { step: 'lookup', username: 'sam' }), browser))
      .toMatchObject({ ok: true, result: lookup })
    const target = { tabId: 'tab_1', pageId: 7, origin: 'https://github.com', loginId: 'login_1' }
    expect(await answerBrowserTool(request('browser_fill_login', { step: 'fill', ...target }), browser))
      .toMatchObject({ ok: true, result: { username: 'sam' } })
    expect(browser.findSavedLogin).toHaveBeenCalledWith('chat_1', 'sam')
    expect(browser.fillSavedLogin).toHaveBeenCalledWith('chat_1', target)
  })

  it('says so in one sentence when the desktop shell cannot fill saved logins', async () => {
    expect(await answerBrowserTool(request('browser_fill_login', { step: 'lookup' }), bridge()))
      .toMatchObject({ ok: false, error: 'This Manor desktop app is too old to fill saved logins.' })
  })
})
