import { isAllowedRendererNavigation } from './rendererUrl'

/** Chromium's code for a load that was replaced by another navigation, not a failure. */
const ERR_ABORTED = -3

interface RendererWindow {
  webContents: {
    loadURL(url: string): Promise<void>
    on(
      event: 'did-fail-load',
      listener: (event: unknown, code: number, description: string, url: string, isMainFrame: boolean) => void,
    ): unknown
  }
  show(): void
  isDestroyed(): boolean
}

/**
 * Opens the renderer, retrying briefly while the local server is still starting. When
 * it stays unreachable the window shows a local error screen instead of a blank or
 * hidden window; its retry link navigates back to the renderer, and a failure there
 * returns to the same screen.
 *
 * A restart of the server outlasts those first retries, so the error screen keeps
 * asking the server whether it is back and opens the app itself once it answers.
 * The user restarts the server while the app is open; a window that needs a click to
 * come back is a window that sits there saying nothing is running when something is.
 */
export async function loadRenderer(
  window: RendererWindow,
  rendererUrl: string,
  { attempts = 6, delayMs = 500, probeMs = 1_000, probe = serverAnswers }: {
    attempts?: number
    delayMs?: number
    probeMs?: number
    probe?: (rendererUrl: string) => Promise<boolean>
  } = {},
): Promise<void> {
  let launching = true
  let waiting = false
  // Polls rather than reloads on a timer: a failed load would flash the window black
  // every second for as long as the server is down.
  const waitForServer = async () => {
    if (waiting) return
    waiting = true
    try {
      while (!window.isDestroyed()) {
        await new Promise((resolve) => setTimeout(resolve, probeMs))
        if (window.isDestroyed()) return
        if (await probe(rendererUrl).catch(() => false)) break
      }
    } finally {
      waiting = false
    }
    if (!window.isDestroyed()) void window.webContents.loadURL(rendererUrl).catch(() => undefined)
  }
  const showError = () => {
    if (window.isDestroyed()) return
    void window.webContents.loadURL(errorPage(rendererUrl)).catch(() => undefined)
    window.show()
    void waitForServer()
  }
  window.webContents.on('did-fail-load', (_event, code, _description, url, isMainFrame) => {
    if (launching || !isMainFrame || code === ERR_ABORTED) return
    if (isAllowedRendererNavigation(url, rendererUrl)) showError()
  })
  try {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (window.isDestroyed()) return
      try {
        await window.webContents.loadURL(rendererUrl)
        return
      } catch {
        if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs))
      }
    }
    showError()
  } finally {
    launching = false
  }
}

/** Answers whether the local server serves again, without pulling the page itself down. */
async function serverAnswers(rendererUrl: string): Promise<boolean> {
  const response = await fetch(new URL('/health', rendererUrl), { signal: AbortSignal.timeout(2_000) })
  return response.ok
}

/**
 * The renderer's tokens are unreachable by definition here, so the screen uses the
 * window's own black and plain white rather than copying token values.
 */
function errorPage(rendererUrl: string): string {
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html>
<html><head><meta charset="utf-8"><title>Manor</title><style>
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px;
    background: black; color: white; font: 15px/1.4 -apple-system, system-ui, sans-serif;
    -webkit-app-region: drag; user-select: none;
  }
  p { margin: 0; opacity: 0.72; }
  a {
    -webkit-app-region: no-drag; color: inherit; text-decoration: none; font-weight: 500;
    padding: 7px 14px; border-radius: 8px; border: 1px solid color-mix(in srgb, white 18%, transparent);
    transition: background-color 160ms ease-out;
  }
  a:hover { background: color-mix(in srgb, white 8%, transparent); }
</style></head><body>
  <p>Manor cannot reach its local server.</p>
  <a href="${rendererUrl}">Try again</a>
</body></html>`)
}
