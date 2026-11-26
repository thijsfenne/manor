import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { mailBodyBlank, readMailHtml, safeMailHref, type MailHtmlOptions } from './mailHtml'

/** The frame's height before the first measurement, small so a short mail does not jump. */
const START_HEIGHT = 48

/**
 * One untrusted mail drawn from its own HTML, mounted by the reader per message. The
 * frame is sandboxed without scripts; same origin only lets this page measure it, catch
 * its clicks and forward its keys. `onFail` asks the reader for the plain text instead.
 */
export function MailHtmlFrame({ html, later, onFail }: { html: string; later: boolean; onFail: () => void }) {
  const theme = usePageTheme()
  const prepared = useMemo(() => prepare(html, later, theme), [html, later, theme])
  const frame = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(START_HEIGHT)
  const fail = useOnce(html, onFail)
  const unusable = prepared === undefined || prepared.empty

  useEffect(() => {
    if (unusable) fail()
  }, [unusable, fail])

  // The listeners hang on the frame document, which a new mail or a theme switch replaces.
  const detach = useRef<() => void>(undefined)
  const srcDoc = unusable ? undefined : prepared.srcDoc
  useEffect(() => () => {
    detach.current?.()
    detach.current = undefined
  }, [srcDoc])

  if (unusable) return null

  // React's own load listener, so a frame that loads before the effects run is not missed.
  const onLoad = () => {
    detach.current?.()
    detach.current = undefined
    const doc = frame.current?.contentDocument
    if (doc === null || doc === undefined) fail()
    else detach.current = attach(doc, setHeight, fail)
  }

  return (
    <iframe
      ref={frame}
      title="Mail content"
      sandbox="allow-same-origin"
      srcDoc={prepared.srcDoc}
      onLoad={onLoad}
      style={{ height }}
      className={`block w-full border-0 ${prepared.paper ? 'rounded-panel' : ''}`}
    />
  )
}

function prepare(html: string, later: boolean, theme: MailHtmlOptions['theme']) {
  try {
    return readMailHtml(html, { origin: window.location.origin, later, theme })
  } catch {
    return undefined
  }
}

/**
 * Wires a loaded frame document to the page: height, failed pictures, links and keys.
 * `onBlank` fires when the failed pictures were all the mail had to show. Returns the
 * cleanup, run on the next load, on a new mail and on unmount.
 */
function attach(doc: Document, setHeight: (height: number) => void, onBlank: () => void) {
  // The root's own box, not its scroll height: that one never reports less than the frame, so a mail could not shrink back.
  const measure = () => setHeight(Math.ceil(doc.documentElement.getBoundingClientRect().height))

  // Capturing, because load and error of a picture do not bubble.
  const onPicture = (event: Event) => {
    if (event.type === 'error' && isElement(event.target) && event.target.localName === 'img') {
      event.target.remove()
      if (mailBodyBlank(doc.body)) onBlank()
    }
    measure()
  }

  const onClick = (event: MouseEvent) => {
    const link = isElement(event.target) ? event.target.closest('a[href], area[href]') : null
    if (link === null) return
    event.preventDefault()
    const href = safeMailHref(link.getAttribute('href'))
    if (href !== undefined && (event.type === 'click' || event.button === 1)) window.open(href, '_blank', 'noopener,noreferrer')
  }

  // The Mail view's key commands listen on this window, which keys typed in the frame never reach.
  const onKey = (event: KeyboardEvent) => {
    const forwarded = new KeyboardEvent('keydown', {
      key: event.key,
      code: event.code,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      repeat: event.repeat,
      bubbles: true,
      cancelable: true,
    })
    if (!window.dispatchEvent(forwarded)) event.preventDefault()
  }

  doc.addEventListener('load', onPicture, true)
  doc.addEventListener('error', onPicture, true)
  doc.addEventListener('click', onClick)
  doc.addEventListener('auxclick', onClick)
  doc.addEventListener('keydown', onKey)
  const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
  resize?.observe(doc.body)
  // A picture that failed before this load never reaches the listener above.
  for (const picture of [...doc.images]) if (picture.complete && picture.naturalWidth === 0) picture.remove()
  if (mailBodyBlank(doc.body)) onBlank()
  measure()

  return () => {
    doc.removeEventListener('load', onPicture, true)
    doc.removeEventListener('error', onPicture, true)
    doc.removeEventListener('click', onClick)
    doc.removeEventListener('auxclick', onClick)
    doc.removeEventListener('keydown', onKey)
    resize?.disconnect()
  }
}

/** Nodes of the frame belong to its own realm, so `instanceof Element` of this page is false for them. */
function isElement(target: EventTarget | null): target is Element {
  return target !== null && 'closest' in target
}

/** `onFail` at most once per mail, however often the effects that call it run. */
function useOnce(html: string, onFail: () => void) {
  const latest = useRef(onFail)
  const failed = useRef<string | undefined>(undefined)
  useEffect(() => {
    latest.current = onFail
  })
  return useMemo(() => () => {
    if (failed.current === html) return
    failed.current = html
    latest.current()
  }, [html])
}

/**
 * The app theme as the frame needs it: the scheme `useTheme` writes on `<html data-theme>`
 * and the computed text and link tokens, which a colour theme from Appearance can change
 * without touching the scheme. Read from the page, never from a second `useTheme`, which
 * would hold a theme of its own.
 */
function usePageTheme() {
  const snapshot = useSyncExternalStore(subscribeTheme, readTheme, readTheme)
  return useMemo(() => {
    const [scheme, text = '', link = ''] = snapshot.split('\n')
    return { scheme: scheme === 'light' ? 'light' : 'dark', text, link } satisfies MailHtmlOptions['theme']
  }, [snapshot])
}

/** Joined into one string so an unrelated page mutation that changes nothing renders nothing. */
function readTheme() {
  const root = document.documentElement
  const tokens = getComputedStyle(root)
  return [
    root.dataset.theme === 'light' ? 'light' : 'dark',
    tokens.getPropertyValue('--color-text').trim(),
    tokens.getPropertyValue('--accent-fg').trim(),
  ].join('\n')
}

/** The scheme and font live on `<html>`, a colour theme's palette in a style element in the head. */
function subscribeTheme(onChange: () => void) {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] })
  observer.observe(document.head, { childList: true, subtree: true, characterData: true })
  return () => observer.disconnect()
}
