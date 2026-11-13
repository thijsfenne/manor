import { randomUUID } from 'node:crypto'
import { browserCursorAppearance } from './browserCursorAppearance'
import type { WebContents } from 'electron'
import { createBrowserCursorRenderer, type BrowserCursorFrame, type BrowserCursorRenderer } from './browserCursorRenderer'

/** One browser-use session owns a cursor in this document until takeover or turn end. */
export class BrowserCursor {
  private readonly actionId = randomUUID()
  private context: Promise<number | undefined> | undefined
  private cleared = false
  private clearing: Promise<void> | undefined

  constructor(private readonly contents: WebContents) {}

  async show(phase: BrowserCursorFrame['phase'], point: { x: number; y: number }): Promise<void> {
    if (this.cleared || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return
    try {
      const contextId = await (this.context ??= this.createContext())
      if (this.cleared || contextId === undefined) return
      const frame: BrowserCursorFrame = { actionId: this.actionId, phase, x: point.x, y: point.y }
      await this.contents.debugger.sendCommand('Runtime.evaluate', {
        contextId,
        expression: `(${renderBrowserCursorFrame.toString()})(${JSON.stringify(this.actionId)}, ${JSON.stringify(frame)}, (root) => (${createBrowserCursorRenderer.toString()})(root, ${JSON.stringify(browserCursorAppearance)}))`,
        awaitPromise: true,
        returnByValue: true,
      })
    } catch {
      // Decoration must not turn a successful browser action into a failed tool.
    }
  }

  clear(): Promise<void> {
    this.cleared = true
    return this.clearing ??= this.remove()
  }

  private async remove(): Promise<void> {
    try {
      const contextId = await this.context
      if (contextId === undefined || this.contents.isDestroyed()) return
      await this.contents.debugger.sendCommand('Runtime.evaluate', {
        contextId,
        expression: `(${renderBrowserCursorFrame.toString()})(${JSON.stringify(this.actionId)}, null)`,
        returnByValue: true,
      })
    } catch {
      // Navigation or closing the tab already destroyed the old document and cursor.
    }
  }

  private async createContext(): Promise<number | undefined> {
    const tree = await this.contents.debugger.sendCommand('Page.getFrameTree') as {
      frameTree?: { frame?: { id?: string } }
    }
    const frameId = tree.frameTree?.frame?.id
    if (this.cleared || !frameId) return undefined
    const world = await this.contents.debugger.sendCommand('Page.createIsolatedWorld', {
      frameId, worldName: 'manor-browser-cursor',
    }) as { executionContextId?: number }
    return world.executionContextId
  }
}

/** Runs only in Chromium's isolated world. No page-supplied code or host privileges. */
export async function renderBrowserCursorFrame(
  actionId: string,
  frame: BrowserCursorFrame | null,
  createRenderer?: (root: ShadowRoot) => BrowserCursorRenderer,
): Promise<void> {
  const world = globalThis as typeof globalThis & {
    __manorBrowserCursor?: { actionId: string; host: HTMLDivElement; renderer: BrowserCursorRenderer }
  }
  const remove = () => {
    const cursor = world.__manorBrowserCursor
    delete world.__manorBrowserCursor
    if (!cursor) return
    try { cursor.renderer.dispose() }
    finally { cursor.host.remove() }
  }
  if (frame === null) {
    if (world.__manorBrowserCursor?.actionId === actionId) remove()
    return
  }
  if (!createRenderer || !document.documentElement) return
  if (world.__manorBrowserCursor?.actionId !== actionId) {
    remove()
    const host = document.createElement('div')
    host.setAttribute('data-manor-browser-cursor', '')
    host.setAttribute('aria-hidden', 'true')
    host.setAttribute('popover', 'manual')
    host.style.cssText = 'all:initial;position:fixed;inset:0;width:100vw;height:100vh;margin:0;padding:0;border:0;background:transparent;overflow:visible;pointer-events:none;z-index:2147483647'
    const root = host.attachShadow({ mode: 'closed' })
    const style = document.createElement('style')
    style.textContent = ':host::backdrop{background:transparent;pointer-events:none}'
    root.append(style)
    document.documentElement.append(host)
    try {
      host.showPopover()
      world.__manorBrowserCursor = { actionId, host, renderer: createRenderer(root) }
    } catch (error) {
      host.remove()
      throw error
    }
  }
  const cursor = world.__manorBrowserCursor
  if (!cursor) return
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.resolve(cursor.renderer.render(frame)).then(() => new Promise<void>((resolve) => {
        // Let Chromium commit the pointer-transparent layer before sending real input.
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      })),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, 1000) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
