import { markdownImageSource, REMOTE_IMAGE_PATH } from '@manor/contracts'

export type MailHtmlOptions = {
  /** The page origin the image proxy is served from, `window.location.origin`. */
  origin: string
  /** A later message of a thread, whose quoted history the earlier messages already show. */
  later: boolean
  /** The thread is drawn on paper, decided by the reader with `mailHtmlSetsColours`. */
  paper: boolean
  /** The app theme, worn only by a mail of a thread that is not on paper. */
  theme: { scheme: 'light' | 'dark'; text: string; link: string }
}

/** What the reader needs from one parse: the frame document and whether it shows anything. */
export type PreparedMail = {
  srcDoc: string
  /** Nothing visible survived: no text and no picture. The reader falls back to plain text. */
  empty: boolean
}

const REMOVED = [
  'script', 'noscript', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
  'link', 'base', 'meta[http-equiv]', 'meta[charset]', 'audio', 'video', 'source',
  'svg', 'math', 'input', 'textarea', 'select',
].join(', ')

/** Quoted history in the two shapes mail clients write it. */
const QUOTED = '.gmail_quote, blockquote[type="cite"]'

const COLOUR_DECLARATION = /(?:^|[\s;{])(?:background|background-color|color)\s*:/i

/** Whitespace and the zero-width characters mail templates pad their preview text with. */
const INVISIBLE = /[\s\u200b-\u200d\u034f\ufeff]/g

const FONT_STACK = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"

const BASE_STYLE = [
  'html,body{margin:0}',
  `body{font:14px/1.5 ${FONT_STACK};overflow-y:hidden;overflow-wrap:anywhere}`,
  'img{max-width:100%;height:auto}',
  'table{max-width:100%}',
].join('')

/**
 * The href a click inside the mail may open from the parent page: http(s) and mailto only.
 * Shared by the hygiene below and the frame's click listener.
 */
export function safeMailHref(href: string | null): string | undefined {
  if (href === null) return undefined
  try {
    const url = new URL(href.trim())
    return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:' ? url.href : undefined
  } catch {
    return undefined
  }
}

/**
 * Turns an untrusted mail into the `srcdoc` of a frame sandboxed without scripts. The
 * sandbox and the document CSP are the boundary; the removals here are hygiene, so
 * dead markup does not take space, try to load, or keep a link the parent would open.
 * Remote pictures go through the server's image proxy on `options.origin`, because
 * the frame may load pictures from that proxy and data URLs only. Every link gets a
 * target the sandbox refuses, so a click does nothing until the page opens it itself.
 */
export function readMailHtml(html: string, options: MailHtmlOptions): PreparedMail {
  const doc = parse(html)

  for (const element of doc.querySelectorAll(REMOVED)) element.remove()
  for (const form of doc.querySelectorAll('form')) form.replaceWith(...form.childNodes)
  if (options.later) dropQuoted(doc)

  for (const element of doc.querySelectorAll('*')) {
    for (const { name } of [...element.attributes]) {
      if (name.toLowerCase().startsWith('on') || name === 'contenteditable') element.removeAttribute(name)
    }
  }

  for (const image of doc.querySelectorAll('img')) {
    const source = markdownImageSource(image.getAttribute('src') ?? undefined)
    if (source === undefined) {
      image.remove()
      continue
    }
    image.setAttribute('src', source.startsWith(REMOTE_IMAGE_PATH) ? `${options.origin}${source}` : source)
    image.removeAttribute('srcset')
    image.removeAttribute('sizes')
  }

  for (const link of doc.querySelectorAll('a[href], area[href]')) {
    if (safeMailHref(link.getAttribute('href')) === undefined) link.removeAttribute('href')
    else link.setAttribute('target', '_blank')
  }

  const head = [
    meta(doc, { charset: 'utf-8' }),
    meta(doc, { 'http-equiv': 'Content-Security-Policy', content: framePolicy(options.origin) }),
    style(doc, BASE_STYLE + colourStyle(options.paper, options.theme)),
  ]
  doc.head.prepend(...head)

  const srcDoc = `<!doctype html>${doc.documentElement.outerHTML}`
  return { srcDoc, empty: mailBodyBlank(doc.body) }
}

function parse(html: string) {
  return new DOMParser().parseFromString(html, 'text/html')
}

/**
 * Whether the mail paints any colour of its own. Such a mail was designed on white, so
 * the reader puts its whole thread on paper; a thread without one wears the app theme.
 * Throws where there is no DOM parser, as `readMailHtml` does.
 */
export function mailHtmlSetsColours(html: string, later: boolean): boolean {
  const doc = parse(html)
  // Asked of the mail as it is drawn: colours in history the frame drops do not count.
  if (later) dropQuoted(doc)
  return setsColours(doc)
}

function dropQuoted(doc: Document) {
  for (const quote of doc.querySelectorAll(QUOTED)) quote.remove()
}

function setsColours(doc: Document) {
  if (doc.querySelector('[bgcolor], font[color]') !== null) return true
  for (const element of doc.querySelectorAll('[style]')) {
    if (COLOUR_DECLARATION.test(element.getAttribute('style') ?? '')) return true
  }
  for (const sheet of doc.querySelectorAll('style')) {
    if (COLOUR_DECLARATION.test(sheet.textContent ?? '')) return true
  }
  return false
}

function framePolicy(origin: string) {
  return `default-src 'none'; img-src ${origin}${REMOTE_IMAGE_PATH} data:; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'`
}

function colourStyle(paper: boolean, theme: MailHtmlOptions['theme']) {
  if (paper) return ':root{color-scheme:light}html{background:Canvas;color:CanvasText}'
  return `:root{color-scheme:${theme.scheme}}html{background:transparent;color:${cssValue(theme.text)}}a{color:${cssValue(theme.link)}}`
}

/** A computed colour pasted into the style sheet, kept to the characters a colour value uses. */
function cssValue(value: string) {
  return value.replace(/[^\w\s#%().,/-]/g, '') || 'inherit'
}

function meta(doc: Document, attributes: Record<string, string>) {
  const element = doc.createElement('meta')
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value)
  return element
}

function style(doc: Document, css: string) {
  const element = doc.createElement('style')
  element.textContent = css
  return element
}

const visibleLength = (text: string | null) => (text ?? '').replace(INVISIBLE, '').length

/**
 * Nothing to see: no picture, and no text outside the body's style sheets. Asked of the
 * parsed mail, and of the loaded frame once its broken pictures are gone.
 */
export function mailBodyBlank(body: HTMLElement): boolean {
  if (body.querySelector('img') !== null) return false
  let left = visibleLength(body.textContent)
  for (const sheet of body.querySelectorAll('style')) left -= visibleLength(sheet.textContent)
  return left === 0
}
