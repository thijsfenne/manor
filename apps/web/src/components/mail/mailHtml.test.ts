// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { mailHtmlSetsColours, readMailHtml, safeMailHref, type MailHtmlOptions } from './mailHtml'

const ORIGIN = 'http://127.0.0.1:43179'
const options: MailHtmlOptions = {
  origin: ORIGIN,
  later: false,
  paper: false,
  theme: { scheme: 'dark', text: 'oklch(0.9 0 0)', link: 'oklch(0.7 0.1 250)' },
}

/** The prepared document parsed back, so assertions read elements rather than markup. */
const prepared = (html: string, more: Partial<MailHtmlOptions> = {}) =>
  new DOMParser().parseFromString(readMailHtml(html, { ...options, ...more }).srcDoc, 'text/html')

describe('readMailHtml', () => {
  it('removes active and embedded content', () => {
    const doc = prepared(`
      <head><link rel="stylesheet" href="https://example.com/a.css"><base href="https://example.com/">
      <meta http-equiv="refresh" content="0;url=https://example.com"></head>
      <body><p>Hello</p><script>alert(1)</script><noscript>no</noscript><iframe src="https://example.com"></iframe>
      <object data="x"></object><embed src="x"><applet code="x"></applet><audio src="x"></audio>
      <video src="x"><source src="y"></video><svg><a xlink:href="https://example.com">x</a></svg><frameset><frame src="x"></frameset></body>`)
    for (const tag of ['script', 'noscript', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'link', 'base', 'audio', 'video', 'source', 'svg']) {
      expect(doc.querySelector(tag), tag).toBeNull()
    }
    expect(doc.querySelector('meta[http-equiv="refresh"]')).toBeNull()
    expect(doc.body.textContent).toContain('Hello')
  })

  it('removes every event handler attribute', () => {
    const doc = prepared('<p onclick="x()" ONMOUSEOVER="y()" class="kept">Hi</p><img src="https://example.com/a.png" onerror="z()">')
    const paragraph = doc.querySelector('p')
    expect(paragraph?.getAttributeNames()).toEqual(['class'])
    expect(doc.querySelector('img')?.hasAttribute('onerror')).toBe(false)
  })

  it('replaces a form by its children', () => {
    const doc = prepared('<form action="https://example.com"><p>Inside</p><button>Send</button></form>')
    expect(doc.querySelector('form')).toBeNull()
    expect(doc.querySelector('p')?.textContent).toBe('Inside')
    expect(doc.querySelector('button')).not.toBeNull()
  })

  it('leaves nothing to type in', () => {
    const doc = prepared('<p contenteditable="true">Hi</p><input value="a"><textarea>b</textarea><select><option>c</option></select>')
    expect(doc.querySelector('input, textarea, select, [contenteditable]')).toBeNull()
    expect(doc.body.textContent).toBe('Hi')
  })

  it('routes a remote picture through the image proxy on the page origin', () => {
    const src = 'https://example.com/pic.png?a=1&b=2'
    const doc = prepared(`<img src="${src.replace('&', '&amp;')}" srcset="https://example.com/2x.png 2x" sizes="100vw">`)
    const image = doc.querySelector('img')
    expect(image?.getAttribute('src')).toBe(`${ORIGIN}/media/remote?url=${encodeURIComponent(src)}`)
    expect(image?.hasAttribute('srcset')).toBe(false)
    expect(image?.hasAttribute('sizes')).toBe(false)
    expect(image?.hasAttribute('loading')).toBe(false)
  })

  it('keeps a raster data picture and drops every other source', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo='
    const doc = prepared(`<p>x</p><img src="${png}"><img src="cid:part1@example.com"><img src="images/logo.png">
      <img src="blob:https://example.com/1"><img src="data:image/svg+xml;base64,PHN2Zz4="><img>`)
    const sources = [...doc.querySelectorAll('img')].map((image) => image.getAttribute('src'))
    expect(sources).toEqual([png])
  })

  it('keeps web and mail links and strips every other href', () => {
    const doc = prepared(`<a id="web" href="https://example.com/a">a</a><a id="mail" href="mailto:someone@example.com">b</a>
      <a id="script" href="javascript:alert(1)">c</a><a id="data" href="data:text/html,x">d</a><a id="relative" href="/inbox">e</a>`)
    const href = (id: string) => doc.getElementById(id)?.getAttribute('href') ?? null
    expect(href('web')).toBe('https://example.com/a')
    expect(href('mail')).toBe('mailto:someone@example.com')
    expect(href('script')).toBeNull()
    expect(href('data')).toBeNull()
    expect(href('relative')).toBeNull()
    // The sandbox refuses a new window, so a click before the page listens goes nowhere.
    expect(doc.getElementById('web')?.getAttribute('target')).toBe('_blank')
    expect(doc.getElementById('mail')?.getAttribute('target')).toBe('_blank')
    expect(doc.getElementById('script')?.textContent).toBe('c')
  })

  it('drops quoted history only for a later message', () => {
    const html = '<p>Reply</p><div class="gmail_quote">Earlier</div><blockquote type="cite">Older</blockquote><blockquote>Quote</blockquote>'
    expect(prepared(html).body.textContent).toContain('Earlier')
    const later = prepared(html, { later: true })
    expect(later.body.textContent).not.toContain('Earlier')
    expect(later.body.textContent).not.toContain('Older')
    expect(later.body.textContent).toContain('Quote')
  })

  it('opens the head with charset, policy and the base sheet ahead of the mail styles', () => {
    const doc = prepared('<head><style>p{margin:4px}</style></head><body><p>x</p></body>')
    const [charset, policy, base, own] = [...doc.head.children]
    expect(charset?.getAttribute('charset')).toBe('utf-8')
    expect(policy?.getAttribute('http-equiv')).toBe('Content-Security-Policy')
    expect(policy?.getAttribute('content')).toBe(
      `default-src 'none'; img-src ${ORIGIN}/media/remote data:; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'`)
    expect(base?.textContent).toContain('img{max-width:100%;height:auto}')
    expect(base?.textContent).toContain('overflow-y:hidden')
    expect(own?.textContent).toBe('p{margin:4px}')
  })

  it('draws a mail of a thread on paper as paper, with its own colours kept', () => {
    const doc = prepared('<body style="background-color: navy"><p style="color: red">x</p></body>', { paper: true })
    const base = doc.head.querySelector('style')?.textContent ?? ''
    expect(base).toContain(':root{color-scheme:light}html{background:Canvas;color:CanvasText}')
    expect(base).not.toContain(options.theme.text)
    expect(base).not.toContain('padding')
    expect(doc.querySelector('p')?.getAttribute('style')).toBe('color: red')
  })

  it('dresses a mail without colours in the app theme', () => {
    const base = prepared('<p>x</p>', { theme: { scheme: 'light', text: 'oklch(0.9 0 0)', link: 'oklch(0.6 0.1 250)' } }).head.querySelector('style')?.textContent ?? ''
    expect(base).toContain(':root{color-scheme:light}html{background:transparent;color:oklch(0.9 0 0)}a{color:oklch(0.6 0.1 250)}')
    expect(base).not.toContain('Canvas')
    expect(base).not.toContain('padding')
  })

  it('keeps a theme value from closing the style sheet', () => {
    const base = prepared('<p>x</p>', { theme: { scheme: 'dark', text: 'red}</style><script>', link: 'blue' } }).head.querySelector('style')?.textContent ?? ''
    expect(base).not.toContain('</style')
    expect(base).not.toContain('}<')
  })

  it('reports a document with nothing visible as empty', () => {
    expect(readMailHtml('<style>p{color:red}</style><p>&nbsp;&zwnj;</p>', options).empty).toBe(true)
    expect(readMailHtml('<p><img src="cid:x"></p>', options).empty).toBe(true)
    expect(readMailHtml('<p>Hi</p>', options).empty).toBe(false)
    expect(readMailHtml('<img src="https://example.com/a.png">', options).empty).toBe(false)
  })
})

describe('mailHtmlSetsColours', () => {
  it.each([
    ['a bgcolor attribute', '<table bgcolor="white"><tr><td>x</td></tr></table>'],
    ['a background in a style attribute', '<div style="background: white">x</div>'],
    ['a background colour in a style attribute', '<div style="padding:0;background-color:white">x</div>'],
    ['a colour in a style attribute', '<span style="color:black">x</span>'],
    ['a colour in a style element', '<style>.a { color: black }</style><p class="a">x</p>'],
    ['a font colour', '<font color="red">x</font>'],
  ])('is true for %s', (_name, html) => {
    expect(mailHtmlSetsColours(html, false)).toBe(true)
  })

  it.each([
    ['plain markup', '<p>Hello <b>there</b></p>'],
    ['a border colour only', '<div style="border-color: red; border: 1px solid">x</div>'],
    ['a background image only', '<style>.a{background-image:none}</style><p class="a">x</p>'],
  ])('is false for %s', (_name, html) => {
    expect(mailHtmlSetsColours(html, false)).toBe(false)
  })

  it('does not count colours in the quoted history a later message drops', () => {
    const reply = '<p>Fine by me.</p><div class="gmail_quote"><p style="color: navy">Earlier</p></div>'
    expect(mailHtmlSetsColours(reply, true)).toBe(false)
    expect(mailHtmlSetsColours(reply, false)).toBe(true)
  })
})

describe('safeMailHref', () => {
  it('passes web and mail addresses only', () => {
    expect(safeMailHref('https://example.com')).toBe('https://example.com/')
    expect(safeMailHref('mailto:a@example.com')).toBe('mailto:a@example.com')
    expect(safeMailHref('javascript:alert(1)')).toBeUndefined()
    expect(safeMailHref('/relative')).toBeUndefined()
    expect(safeMailHref(null)).toBeUndefined()
  })
})
