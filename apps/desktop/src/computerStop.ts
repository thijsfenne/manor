import { globalShortcut, ipcMain, type BrowserWindow, type WebContents } from 'electron'

/** One stop attempt; a failed one is retried, never treated as done. */
const STOP_TIMEOUT_MS = 3_000
const STOP_RETRY_MS = 1_000

interface Arm {
  contents: WebContents
  token: string
  url: string
  /** Set once a stop is being delivered; later presses and losses join it. */
  stopping: boolean
}

/**
 * The Escape stop for computer use, as one chain that does not depend on the page.
 * While the server holds the desktop lease, Escape is registered globally. A press,
 * a reload, a closed renderer or a lost server socket all post the lease's stop
 * token straight to the server from this process, retried until the server
 * answers, and Escape is let go only after that answer or after the server itself
 * disarms it.
 *
 * A global shortcut needs no Input Monitoring grant, unlike the listen-only event
 * tap Synara uses. The cost is that Escape does not reach other apps while an agent
 * drives the Mac, which is the moment the key means stop.
 */
export function registerComputerStopIpc(
  owner: () => BrowserWindow | null,
  post: (url: string, token: string) => Promise<void> = postStop,
  retryMs = STOP_RETRY_MS,
): void {
  let current: Arm | null = null

  const release = (arm: Arm) => {
    if (current !== arm) return
    arm.contents.off('did-start-loading', deliverStop)
    arm.contents.off('destroyed', deliverStop)
    globalShortcut.unregister('Escape')
    current = null
  }

  // The only stop path: sent from here, retried on failure, and Escape stays
  // registered until the server has confirmed it.
  function deliverStop() {
    const arm = current
    if (arm === null || arm.stopping) return
    arm.stopping = true
    void (async () => {
      while (current === arm) {
        try {
          await post(arm.url, arm.token)
          release(arm)
          return
        } catch {
          await new Promise((resolve) => setTimeout(resolve, retryMs))
        }
      }
    })()
  }

  ipcMain.handle('manor:computer:connection-lost', (event) => {
    const window = owner()
    if (window === null || event.sender.id !== window.webContents.id) return
    deliverStop()
  })

  ipcMain.handle('manor:computer:stop-armed', (event, armed: unknown, stop: unknown) => {
    const window = owner()
    if (window === null || event.sender.id !== window.webContents.id) {
      throw new Error('Only the Manor window can arm the computer stop.')
    }
    if (typeof armed !== 'boolean') throw new Error('The computer stop needs a boolean.')
    if (!armed) {
      if (current !== null) release(current)
      return
    }
    const { token, url } = checkedStop(stop)
    if (current !== null) release(current)
    const arm: Arm = { contents: event.sender, token, url, stopping: false }
    if (!globalShortcut.register('Escape', deliverStop)) {
      throw new Error('Escape is already taken by another app, so the computer stop could not be armed.')
    }
    current = arm
    arm.contents.on('did-start-loading', deliverStop)
    arm.contents.on('destroyed', deliverStop)
  })
}

function checkedStop(value: unknown): { token: string; url: string } {
  if (typeof value !== 'object' || value === null) throw new Error('Arming the computer stop needs its stop token.')
  const { token, url } = value as Record<string, unknown>
  if (typeof token !== 'string' || !/^[0-9a-f]{32}$/.test(token) || typeof url !== 'string') {
    throw new Error('Arming the computer stop needs its stop token.')
  }
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) ||
    parsed.pathname !== '/internal/computer-stop') {
    throw new Error('The computer stop must post to the local Manor server.')
  }
  return { token, url }
}

async function postStop(url: string, token: string): Promise<void> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
    signal: AbortSignal.timeout(STOP_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`The Manor server refused the stop (HTTP ${response.status}).`)
}
