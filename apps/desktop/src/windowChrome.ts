import type { BrowserWindow, Input } from 'electron'

/** Window-point origin of the traffic lights at zoom 1. X never moves. */
export const TRAFFIC_LIGHT_X = 18
/**
 * The renderer's top bar height in CSS pixels (`TOP_BAR_HEIGHT` in the web TopBar).
 * The lights sit on its centre line, so the two change together.
 */
export const TOP_BAR_HEIGHT = 38
/** From the lights' origin down to their centre: half the 14pt button frame. */
const TRAFFIC_LIGHT_HALF = 7

const ZOOM_KEYS = new Set(['-', '=', '+', '0', 'Minus', 'Equal', 'NumpadSubtract', 'NumpadAdd'])
const ZOOM_OUT = new Set(['-', 'Minus', 'NumpadSubtract'])

/** Chromium's own step. Clamped so a few Cmd+− taps cannot collapse the chrome. */
const ZOOM_STEP = 0.5
const ZOOM_LEVEL_MIN = -3
const ZOOM_LEVEL_MAX = 3

/**
 * The page zooms the bar with everything else, so its centre line moves in window
 * points and the lights follow it on Y. X stays put; the bar holds its first control
 * at the same window-point X instead.
 */
export function trafficLightPositionForZoom(zoom: number): { x: number; y: number } {
  const safe = Number.isFinite(zoom) && zoom > 0 ? zoom : 1
  const y = (TOP_BAR_HEIGHT / 2) * safe - TRAFFIC_LIGHT_HALF
  return { x: TRAFFIC_LIGHT_X, y: Math.max(0, Math.round(y)) }
}

export function isZoomShortcut(input: Pick<Input, 'type' | 'key' | 'meta' | 'control'>): boolean {
  return input.type === 'keyDown' && (input.meta || input.control) && ZOOM_KEYS.has(input.key)
}

export function nextZoomLevel(current: number, key: string): number {
  if (key === '0') return 0
  const step = ZOOM_OUT.has(key) ? -ZOOM_STEP : ZOOM_STEP
  return Math.min(ZOOM_LEVEL_MAX, Math.max(ZOOM_LEVEL_MIN, current + step))
}

/**
 * Keeps the native lights on the first chrome row as Cmd+/− resizes the page.
 * The shell applies the zoom itself: listening after Chromium's default handler
 * raced, so the lights stayed at y=21 and the icons slid under them. X is left
 * alone; the renderer holds the icons at the same window-point X.
 */
export function bindWindowChrome(
  window: BrowserWindow,
  onZoom: (zoom: number) => void,
  onFullscreen: (fullscreen: boolean) => void,
): void {
  const sync = () => {
    if (window.isDestroyed()) return
    const zoom = window.webContents.getZoomFactor()
    if (process.platform === 'darwin') window.setWindowButtonPosition(trafficLightPositionForZoom(zoom))
    onZoom(zoom)
  }

  window.webContents.on('zoom-changed', () => {
    setTimeout(sync, 0)
    setTimeout(sync, 50)
  })
  window.webContents.on('did-finish-load', sync)
  window.webContents.on('before-input-event', (event, input) => {
    if (!isZoomShortcut(input)) return
    event.preventDefault()
    window.webContents.setZoomLevel(nextZoomLevel(window.webContents.getZoomLevel(), input.key))
    sync()
  })
  window.on('enter-full-screen', () => onFullscreen(true))
  window.on('leave-full-screen', () => onFullscreen(false))
  sync()
  onFullscreen(window.isFullScreen())
}

type FullscreenEvent = 'enter-html-full-screen' | 'leave-html-full-screen' | 'enter-full-screen' | 'leave-full-screen'
type FullscreenWindow = Pick<BrowserWindow, 'isFullScreen' | 'setFullScreen'> & {
  on(event: FullscreenEvent, listener: () => void): unknown
}

/**
 * A page video going fullscreen fills the screen, and leaving it puts the window
 * back exactly as it was. Manor owns that decision: every web contents runs with
 * `disableHtmlFullscreenWindowResize`, because Electron's own resize lost track on
 * x.com and dropped an already fullscreen Manor out of fullscreen on exit.
 *
 * macOS animates each change, reports the old state until it lands, and Electron
 * ends any page fullscreen when a window exit lands. So Manor starts at most one
 * change at a time and, when it lands, steers toward what the page wants now.
 * Queuing a second change mid-animation left Manor fullscreen with no video.
 * Enter and leave fire once per web contents (shell and guest), so they only set
 * a flag.
 */
export function bindPageFullscreen(window: FullscreenWindow): void {
  let pageFullscreen = false
  // True while Manor was windowed before the page took over and is not back yet.
  let returnToWindowed: boolean | null = null
  let changing = false
  const steer = () => {
    if (changing || returnToWindowed !== true) return
    const fullscreen = window.isFullScreen()
    if (fullscreen !== pageFullscreen) {
      changing = true
      window.setFullScreen(pageFullscreen)
    } else if (!fullscreen) {
      returnToWindowed = null
    }
  }
  const landed = () => {
    changing = false
    steer()
  }
  window.on('enter-full-screen', landed)
  window.on('leave-full-screen', landed)
  window.on('enter-html-full-screen', () => {
    pageFullscreen = true
    if (returnToWindowed === null) returnToWindowed = !window.isFullScreen()
    steer()
  })
  window.on('leave-html-full-screen', () => {
    pageFullscreen = false
    if (returnToWindowed === false) returnToWindowed = null
    steer()
  })
}
