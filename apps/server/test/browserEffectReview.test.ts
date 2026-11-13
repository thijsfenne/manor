import { describe, expect, it } from 'vitest'
import { browserReviewArguments } from '../src/browserEffectReview.js'

const page = {
  url: 'https://example.com/search', title: 'Search', visibleText: 'Find an article',
  interactiveElements: [{ selector: '#search', tag: 'input', type: 'search', label: 'Search',
    bounds: { x: 1, y: 2, width: 100, height: 30 } }],
  console: [{ text: 'unrelated diagnostic' }],
}

describe('browser Auto context', () => {
  it('keeps the exact input and target while omitting console output and geometry', () => {
    expect(browserReviewArguments('browser_type', { selector: '#search', text: 'Manor' }, page)).toEqual({
      action: { selector: '#search', text: 'Manor' },
      page: { url: page.url, title: 'Search', visibleText: 'Find an article', textTruncated: false,
        target: { selector: '#search', tag: 'input', type: 'search', label: 'Search' } },
    })
  })

  it('requires a single matching target for click and type', () => {
    expect(browserReviewArguments('browser_click', { selector: '#missing' }, page)).toBeUndefined()
    expect(browserReviewArguments('browser_type', { selector: '#search', text: 'test' },
      { ...page, interactiveElements: [...page.interactiveElements, ...page.interactiveElements] })).toBeUndefined()
    expect(browserReviewArguments('browser_click', { selector: '#search' }, {})).toBeUndefined()
  })

  it('does not pass typed passwords into review', () => {
    expect(browserReviewArguments('browser_type', { selector: '#search', text: 'private' }, {
      ...page, interactiveElements: [{ ...page.interactiveElements[0], type: 'password' }],
    })).toBeUndefined()
  })

  it('labels omitted page text and preserves the complete target and action', () => {
    expect(browserReviewArguments('browser_click', { selector: '#search' }, { ...page, visibleText: 'x'.repeat(9_000) }))
      .toMatchObject({ action: { selector: '#search' }, page: { visibleText: 'x'.repeat(8_000), textTruncated: true } })
  })
  it('binds a keypress to the focused control while older hosts have unknown focus', () => {
    expect(browserReviewArguments('browser_press', { key: 'Enter' }, { ...page, focusedSelector: '#search' }))
      .toMatchObject({ action: { key: 'Enter' }, page: { focusedSelector: '#search', target: { type: 'search' } } })
    const oldHost = browserReviewArguments('browser_press', { key: 'Enter' }, page)
    expect(oldHost).toBeUndefined()
    expect(browserReviewArguments('browser_press', { key: 'Enter' }, { ...page, focusedSelector: '#missing' }))
      .toBeUndefined()
    expect(browserReviewArguments('browser_press', { key: 'Enter' }, {
      ...page, focusedSelector: '#search', interactiveElements: [...page.interactiveElements, ...page.interactiveElements],
    })).toBeUndefined()
  })

})
