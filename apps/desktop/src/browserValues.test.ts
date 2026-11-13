import { describe, expect, it, vi } from 'vitest'
import {
  chromeUserAgent,
  externalOpenUrl,
  normalizeBrowserKey,
  normalizeWebsiteUrl,
  parseBrowserBounds,
  parseBrowserSettings,
  parseScrollDelta,
  readPageContextAttachment,
  withTimeout,
} from './browserValues'

describe('normalizeWebsiteUrl', () => {
  it('adds https to an ordinary hostname', () => {
    expect(normalizeWebsiteUrl('example.com/path')).toBe('https://example.com/path')
  })

  it('rejects protocols that do not load websites', () => {
    expect(() => normalizeWebsiteUrl('file:///tmp/private')).toThrow('Only http and https')
    expect(() => normalizeWebsiteUrl('javascript:alert(1)')).toThrow('Only http and https')
  })
})

describe('externalOpenUrl', () => {
  it('lets websites and mailto leave the app window', () => {
    expect(externalOpenUrl('https://example.com/a')).toBe('https://example.com/a')
    expect(externalOpenUrl('mailto:someone@example.com')).toBe('mailto:someone@example.com')
  })

  it.each([
    'javascript:alert(1)',
    'file:///etc/hosts',
    'data:text/html,<script>alert(1)</script>',
    'manor-custom://open',
    'vscode://file/x',
  ])('refuses %s', (url) => {
    expect(externalOpenUrl(url)).toBeNull()
  })
})

describe('browser interaction values', () => {
  it('normalizes the supported key names', () => {
    expect(normalizeBrowserKey('page down')).toMatchObject({ key: 'PageDown', windowsVirtualKeyCode: 34 })
    expect(() => normalizeBrowserKey('Meta+R')).toThrow('Unsupported browser key')
  })

  it('requires movement and caps pathological scroll deltas', () => {
    expect(parseScrollDelta(0, 50_000)).toEqual({ deltaX: 0, deltaY: 10_000 })
    expect(() => parseScrollDelta(0, 0)).toThrow('non-zero')
  })
})

describe('readPageContextAttachment', () => {
  const selected = {
    kind: 'text',
    url: 'https://example.com/vacancy',
    title: 'Vacancy',
    label: 'Senior product designer',
    text: 'Senior product designer',
    html: '<strong>Senior product designer</strong>',
    selector: 'main > strong',
  }

  it('accepts one bounded website quote without a runtime schema dependency', () => {
    expect(readPageContextAttachment(selected, 'page_1')).toEqual({ id: 'page_1', ...selected })
  })

  it('rejects malformed, non-website and oversized page results', () => {
    expect(() => readPageContextAttachment({ ...selected, url: 'file:///tmp/private' }, 'page_1'))
      .toThrow('invalid selected context')
    expect(() => readPageContextAttachment({ ...selected, text: 'x'.repeat(6_001) }, 'page_1'))
      .toThrow('invalid selected context')
    expect(() => readPageContextAttachment({ ...selected, label: '' }, 'page_1'))
      .toThrow('invalid selected context')
  })
})

describe('parseBrowserBounds', () => {
  it('rounds the rectangle the renderer measured', () => {
    expect(parseBrowserBounds({ x: -4.4, y: 20.6, width: 899.5, height: 500.2 }))
      .toEqual({ x: -4, y: 21, width: 900, height: 500 })
  })

  it('keeps the size of a frame hanging off the edge, so a sliding panel does not scale', () => {
    // Mid-slide the panel is still half off-screen to the right. Fitting it to what
    // is visible would shrink the page and grow it back, which reads as the whole
    // website being scaled rather than moved.
    expect(parseBrowserBounds({ x: 1_700, y: 54, width: 620, height: 800 }))
      .toEqual({ x: 1_700, y: 54, width: 620, height: 800 })
  })

  it('rejects empty and non-finite rectangles', () => {
    expect(() => parseBrowserBounds({ x: 0, y: 0, width: 0, height: 20 })).toThrow('positive size')
    expect(() => parseBrowserBounds({ x: 0, y: Number.NaN, width: 20, height: 20 }))
      .toThrow('finite number')
  })

  it('caps a nonsense rectangle rather than handing Chromium a screen-sized surprise', () => {
    expect(parseBrowserBounds({ x: 0, y: 0, width: 1e9, height: 1e9 }))
      .toEqual({ x: 0, y: 0, width: 20_000, height: 20_000 })
  })
})

describe('withTimeout', () => {
  it('passes a finished action straight through', async () => {
    await expect(withTimeout(Promise.resolve('read'), 25)).resolves.toBe('read')
  })

  it('gives up on a page that never answers, so the shield and the actor line come down', async () => {
    vi.useFakeTimers()
    const stuck = withTimeout(new Promise<never>(() => {}), 25)
    const assertion = expect(stuck).rejects.toThrow('did not finish that action in time')
    await vi.advanceTimersByTimeAsync(25)
    await assertion
    vi.useRealTimers()
  })

  it('keeps a failed action\'s own message rather than reporting a timeout', async () => {
    await expect(withTimeout(Promise.reject(new Error('No such element.')), 25))
      .rejects.toThrow('No such element.')
  })
})

describe('browser menu settings', () => {
  it('accepts partial settings and the way out of responsive mode', () => {
    expect(parseBrowserSettings({ viewport: { width: 390, height: 844 }, appearance: 'dark' }))
      .toEqual({ viewport: { width: 390, height: 844 }, appearance: 'dark' })
    expect(parseBrowserSettings({ viewport: null, zoomFactor: 1 })).toEqual({ viewport: null, zoomFactor: 1 })
  })

  it.each([null, [], { viewport: {} }, { viewport: { width: 0, height: 844 } },
    { viewport: { width: 390.5, height: 844 } }, { viewport: { width: 390, height: 3841 } },
    { zoomFactor: NaN }, { zoomFactor: 0 }, { appearance: 'sepia' }, { unexpected: true }])('rejects malformed settings %j', (value) => {
    expect(() => parseBrowserSettings(value)).toThrow()
  })
})

describe('chromeUserAgent', () => {
  it('drops the Electron and app tokens and reduces the Chrome version', () => {
    const electron = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Manor/0.0.2 Chrome/148.0.7778.97 Electron/43.4.1 Safari/537.36'
    expect(chromeUserAgent(electron)).toBe(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    )
  })
})
