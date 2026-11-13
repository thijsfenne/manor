import type { BrowserPageSettings, BrowserViewportBounds, PageContextAttachment } from '@manor/contracts'

export function normalizeWebsiteUrl(raw: string): string {
  const value = raw.trim()
  if (value === '') throw new Error('Enter a website URL.')

  const candidate = /^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}`
  const url = new URL(candidate)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http and https pages can open in the browser.')
  }
  return url.href
}

/**
 * Where a link the app window opens may go outside Manor: a website, or a mail
 * draft through `mailto:`. Every other scheme is refused (null).
 */
export function externalOpenUrl(raw: string): string | null {
  const value = raw.trim()
  if (/^mailto:/i.test(value)) {
    try {
      const url = new URL(value)
      return url.protocol === 'mailto:' ? url.href : null
    } catch {
      return null
    }
  }
  try {
    return normalizeWebsiteUrl(value)
  } catch {
    return null
  }
}

/**
 * The address a page may come back to without the live page. Callback URLs that
 * carry one-time codes or tokens come back blank, so a reload never replays a login.
 */
export function persistableUrl(url: string): string {
  if (url === '' || url === 'about:blank') return 'about:blank'
  try {
    const safe = normalizeWebsiteUrl(url)
    const parsed = new URL(safe)
    const oneTime = /^(code|token|access_token|id_token|refresh_token)$/i
    if ([...parsed.searchParams.keys()].some((key) => oneTime.test(key))) return 'about:blank'
    const fragment = new URLSearchParams(parsed.hash.slice(1))
    if ([...fragment.keys()].some((key) => oneTime.test(key))) return 'about:blank'
    return safe
  } catch {
    return 'about:blank'
  }
}

/** Room for any window anyone will ever open, and a ceiling on a nonsense rectangle. */
const MAX_BROWSER_EXTENT = 20_000

/**
 * The panel's frame, as the renderer measured it, rounded and sanity-checked.
 *
 * Deliberately not fitted to the window. A view is allowed to hang over the edge and
 * be clipped, and that is what makes the panel *slide* in and out: while the region
 * animates open the frame is still partly off-screen to the right, and trimming the
 * width to what is currently visible would reflow the page smaller and then grow it
 * back, which reads as the whole website being scaled.
 */
export function parseBrowserBounds(raw: unknown): BrowserViewportBounds {
  if (typeof raw !== 'object' || raw === null) throw new Error('Browser bounds are missing.')
  const value = raw as Record<string, unknown>
  const x = finiteNumber(value.x, 'x')
  const y = finiteNumber(value.y, 'y')
  const width = finiteNumber(value.width, 'width')
  const height = finiteNumber(value.height, 'height')
  if (width <= 0 || height <= 0) throw new Error('Browser bounds must have a positive size.')

  return {
    x: clampExtent(x),
    y: clampExtent(y),
    width: Math.max(1, Math.min(Math.round(width), MAX_BROWSER_EXTENT)),
    height: Math.max(1, Math.min(Math.round(height), MAX_BROWSER_EXTENT)),
  }
}

const clampExtent = (value: number) =>
  Math.min(Math.max(Math.round(value), -MAX_BROWSER_EXTENT), MAX_BROWSER_EXTENT)

function finiteNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Browser bound ${name} must be a finite number.`)
  }
  return value
}

const BROWSER_KEYS = new Map<string, { key: string; code: string; windowsVirtualKeyCode: number }>([
  ['enter', { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }],
  ['tab', { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }],
  ['escape', { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }],
  ['backspace', { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }],
  ['arrowup', { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 }],
  ['arrowdown', { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 }],
  ['arrowleft', { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 }],
  ['arrowright', { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 }],
  ['home', { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 }],
  ['end', { key: 'End', code: 'End', windowsVirtualKeyCode: 35 }],
  ['pagedown', { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 }],
  ['pageup', { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 }],
] as const)

export function normalizeBrowserKey(raw: string): { key: string; code: string; windowsVirtualKeyCode: number } {
  const key = BROWSER_KEYS.get(raw.replace(/\s+/g, '').toLowerCase())
  if (key === undefined) throw new Error('Unsupported browser key.')
  return key
}

/**
 * Bounds how long anyone waits on one browser action, never the action itself. A CDP
 * command against a blocked renderer can hang forever, and the caller holds the
 * panel's actor line for as long as it waits; losing this race
 * is reported as a failed tool call, which is the honest thing to hand an agent
 * whose page stopped answering.
 */
export class BrowserActionTimeoutError extends Error {}

export function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new BrowserActionTimeoutError('The browser did not finish that action in time.')), ms)
      timer.unref?.()
    }),
  ]).finally(() => clearTimeout(timer))
}

export function parseScrollDelta(rawX: unknown, rawY: unknown): { deltaX: number; deltaY: number } {
  const deltaX = finiteNumber(rawX, 'deltaX')
  const deltaY = finiteNumber(rawY, 'deltaY')
  if (deltaX === 0 && deltaY === 0) throw new Error('Browser scroll needs a non-zero delta.')
  return {
    deltaX: Math.max(-10_000, Math.min(10_000, deltaX)),
    deltaY: Math.max(-10_000, Math.min(10_000, deltaY)),
  }
}

/**
 * The page is an untrusted renderer. Validate its selection result locally instead
 * of importing the runtime contracts package into Electron's packaged main process,
 * where that workspace package deliberately points at TypeScript source.
 */
export function readPageContextAttachment(raw: unknown, id: string): PageContextAttachment {
  const value = record(raw)
  const kind = value?.kind
  const url = boundedString(value?.url, 1, 10_000)
  if (value === undefined || (kind !== 'text' && kind !== 'element') || url === undefined) {
    throw invalidPageContext()
  }
  try {
    const protocol = new URL(url).protocol
    if (protocol !== 'http:' && protocol !== 'https:') throw invalidPageContext()
  } catch {
    throw invalidPageContext()
  }

  const title = boundedString(value.title, 0, 500)
  const label = boundedString(value.label, 1, 240)
  const text = boundedString(value.text, 0, 6_000)
  const html = boundedString(value.html, 0, 8_000)
  const selector = value.selector === undefined ? undefined : boundedString(value.selector, 0, 2_000)
  if (title === undefined || label === undefined || text === undefined || html === undefined) {
    throw invalidPageContext()
  }
  if (value.selector !== undefined && selector === undefined) throw invalidPageContext()

  return {
    id,
    kind,
    url,
    title,
    label,
    text,
    html,
    ...(selector === undefined ? {} : { selector }),
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

function boundedString(value: unknown, min: number, max: number): string | undefined {
  return typeof value === 'string' && value.length >= min && value.length <= max ? value : undefined
}

const invalidPageContext = () => new Error('The browser page returned invalid selected context.')

/** Reject malformed IPC before it reaches Chromium or mutates a tab. */
export function parseBrowserSettings(raw: unknown): Partial<BrowserPageSettings> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Browser settings must be an object.')
  const value = raw as Record<string, unknown>
  if (Object.keys(value).some((key) => !['viewport', 'appearance', 'zoomFactor'].includes(key))) throw new Error('Unknown browser setting.')
  const settings: Partial<BrowserPageSettings> = {}
  if ('viewport' in value) {
    if (value.viewport === null) settings.viewport = null
    else {
      const viewport = value.viewport as Record<string, unknown> | null
      if (viewport === null || typeof viewport !== 'object' || Array.isArray(viewport) ||
        ![viewport.width, viewport.height].every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 100 && n <= 3840)) {
        throw new Error('Browser viewport dimensions must be whole numbers from 100 to 3840.')
      }
      settings.viewport = { width: viewport.width as number, height: viewport.height as number }
    }
  }
  if ('appearance' in value) {
    if (value.appearance !== 'system' && value.appearance !== 'light' && value.appearance !== 'dark') throw new Error('Unknown browser appearance.')
    settings.appearance = value.appearance
  }
  if ('zoomFactor' in value) {
    if (typeof value.zoomFactor !== 'number' || !Number.isFinite(value.zoomFactor) || value.zoomFactor < 0.25 || value.zoomFactor > 5) throw new Error('Browser zoom must be between 25% and 500%.')
    settings.zoomFactor = value.zoomFactor
  }
  return settings
}

/** Product tokens a stock Chrome user agent carries; anything else marks an embedded shell. */
const CHROME_UA_TOKENS = new Set(['Mozilla', 'AppleWebKit', 'Chrome', 'Safari'])

/**
 * Electron's default user agent appends `Electron/x` and the app's own `Manor/x`, and
 * sites that allowlist browsers (WhatsApp Web) answer that with "update Chrome". Drop
 * those tokens and reduce the Chrome version the way stock Chrome does, so the version
 * always follows the bundled Chromium instead of a hardcoded string.
 */
export function chromeUserAgent(electronUserAgent: string): string {
  return electronUserAgent
    .replace(/\s+([^\s()/]+)\/([^\s()]+)/g, (token, name: string, version: string) => {
      if (!CHROME_UA_TOKENS.has(name)) return ''
      return name === 'Chrome' ? ` Chrome/${version.split('.')[0]}.0.0.0` : token
    })
    .trim()
}
