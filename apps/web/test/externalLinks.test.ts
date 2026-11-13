import { createElement } from 'react'
import { create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { ExternalLink, ExternalLinkProvider, isWebsiteUrl } from '../src/components/ExternalLink'
import { openWebsiteInBrowser } from '../src/desktopBrowser'
import { routeWebsiteLink } from '../src/websiteLinkRoute'

describe('external website links', () => {
  it('recognises only absolute HTTP website links', () => {
    expect(isWebsiteUrl('https://example.com')).toBe(true)
    expect(isWebsiteUrl('http://localhost:43179/docs')).toBe(true)
    expect(isWebsiteUrl('mailto:hello@example.com')).toBe(false)
    expect(isWebsiteUrl('file:///Users/sam/secret.txt')).toBe(false)
    expect(isWebsiteUrl('/relative')).toBe(false)
    expect(isWebsiteUrl('not a URL')).toBe(false)
  })

  it('leaves native navigation intact when Browser is unavailable', () => {
    const preventDefault = vi.fn()
    const link = create(createElement(ExternalLinkProvider, {
      open: () => false,
      children: createElement(ExternalLink, { href: 'https://example.com/' }, 'Example'),
    }))
    link.root.findByType('a').props.onClick({ defaultPrevented: false, preventDefault })
    expect(preventDefault).not.toHaveBeenCalled()
  })

  it('passes the owning chat to the link opener', () => {
    const open = vi.fn(() => true)
    const preventDefault = vi.fn()
    const link = create(createElement(ExternalLinkProvider, {
      open,
      chatId: 'chat_2',
      children: createElement(ExternalLink, { href: 'https://example.com/' }, 'Example'),
    }))
    link.root.findByType('a').props.onClick({ defaultPrevented: false, preventDefault })
    expect(open).toHaveBeenCalledWith('https://example.com/', 'chat_2')
    expect(preventDefault).toHaveBeenCalledOnce()
  })

  it('opens the right rail Browser for the clicked chat', () => {
    const browser = {
      newTab: vi.fn(async () => ({ chatId: 'left', tabs: [], activeTabId: null })),
      navigate: vi.fn(async (url: string) => ({ url, title: 'Example' })),
    }
    const showPanel = vi.fn()
    const onFailure = vi.fn()
    const options = { browser, phone: false, showPanel, onFailure }

    expect(routeWebsiteLink('https://example.com/left', { ...options, chat: { id: 'left', kind: 'project' } })).toBe(true)
    expect(routeWebsiteLink('https://example.com/right', { ...options, chat: { id: 'right', kind: 'project' } })).toBe(true)
    expect(showPanel.mock.calls).toEqual([['left'], ['right']])
    expect(browser.newTab.mock.calls).toEqual([
      ['left', 'https://example.com/left'],
      ['right', 'https://example.com/right'],
    ])
    expect(onFailure).not.toHaveBeenCalled()

    expect(routeWebsiteLink('https://example.com/no-chat', { ...options, chat: undefined })).toBe(false)
    expect(showPanel).toHaveBeenCalledTimes(2)
    expect(browser.newTab).toHaveBeenCalledTimes(2)
  })

  it('opens a tab in the clicked chat and reuses its active tab if adding one fails', async () => {
    const browser = {
      newTab: vi.fn(async () => ({ chatId: 'chat_1', tabs: [], activeTabId: null })),
      navigate: vi.fn(async (url: string) => ({ url, title: 'Example' })),
    }
    await openWebsiteInBrowser(browser, 'chat_1', 'https://example.com/')
    expect(browser.newTab).toHaveBeenCalledWith('chat_1', 'https://example.com/')
    expect(browser.navigate).not.toHaveBeenCalled()

    browser.newTab.mockRejectedValueOnce(new Error('12 tabs open'))
    await openWebsiteInBrowser(browser, 'chat_1', 'https://example.com/next')
    expect(browser.navigate).toHaveBeenCalledWith('https://example.com/next', 'chat_1')
  })

  it('reports failure when Browser cannot create or reuse a tab', async () => {
    const browser = {
      newTab: vi.fn(async () => { throw new Error('No tab available') }),
      navigate: vi.fn(async () => { throw new Error('Browser unavailable') }),
    }
    await expect(openWebsiteInBrowser(browser, 'chat_1', 'https://example.com/')).rejects.toThrow('No tab available')
  })
})
