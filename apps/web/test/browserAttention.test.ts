import { describe, expect, it } from 'vitest'
import { addBrowserAttention, browserRevealAction, consumeBrowserAttention } from '../src/useWorkspace'

describe('browser panel attention', () => {
  it('keeps first use pending for every background chat until that chat opens', () => {
    let pending: ReadonlySet<string> = new Set()
    pending = addBrowserAttention(pending, 'chat_1')
    pending = addBrowserAttention(pending, 'chat_2')
    pending = consumeBrowserAttention(pending, 'chat_2')

    expect([...pending]).toEqual(['chat_1'])
  })

  it('waits for the chosen page after an explicit request lists existing tabs', () => {
    expect(browserRevealAction(false, false, 'browser_tabs', { prepare: true })).toBe('prepare')
    expect(browserRevealAction(true, true, 'browser_tabs', {})).toBe('none')
    expect(browserRevealAction(true, true, 'browser_navigate', { url: 'https://example.com' })).toBe('reveal')
    expect(browserRevealAction(true, true, 'browser_tabs', { select: 'tab_1' })).toBe('reveal')
    expect(browserRevealAction(true, true, 'browser_snapshot', {})).toBe('reveal')
  })

  it('does not reopen a manually closed panel for later ordinary actions', () => {
    expect(browserRevealAction(true, false, 'browser_click', { selector: 'a' })).toBe('none')
    expect(browserRevealAction(false, false, 'browser_snapshot', {})).toBe('none')
    expect(browserRevealAction(false, false, 'browser_navigate', { url: 'https://example.com' })).toBe('reveal')
  })
})
