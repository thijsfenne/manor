import type { WebContents } from 'electron'
import { BrowserCursor } from './browserCursor'
import type { BrowserCursorFrame } from './browserCursorRenderer'
import { withBrowserPainting } from './browserPainting'

const NATIVE_INPUT_GRACE_MS = 1_000
const sessions = new WeakMap<WebContents, BrowserInputAction>()
const viewportScales = new WeakMap<WebContents, number>()
const stopGenerations = new WeakMap<WebContents, number>()
const layouts = new WeakMap<WebContents, Promise<void>>()
const activeInputs = new WeakMap<WebContents, Set<Promise<void>>>()

/** CDP mouse coordinates address Electron's scaled surface; DOM targets remain in CSS pixels. */
export function setBrowserInputScale(contents: WebContents, scale: number): void {
  viewportScales.set(contents, scale)
}

/** Keep the measured target in place until dispatched input has finished. */
export async function waitForBrowserInputIdle(contents: WebContents): Promise<void> {
  const pending = activeInputs.get(contents)
  while (pending?.size) await Promise.all(pending)
}

/** Reserve layout before waiting, so the next input cannot measure a half-applied viewport. */
export async function withBrowserLayout(contents: WebContents, work: () => void | Promise<void>): Promise<void> {
  const previous = layouts.get(contents)
  const task = (async () => {
    await previous
    await waitForBrowserInputIdle(contents)
    if (!contents.isDestroyed()) await work()
  })()
  const settled = task.catch(() => {})
  layouts.set(contents, settled)
  try { await task }
  finally { if (layouts.get(contents) === settled) layouts.delete(contents) }
}

/** Ends cursor ownership and interrupts any input still in flight. */
export async function stopBrowserInput(contents: WebContents): Promise<void> {
  stopGenerations.set(contents, (stopGenerations.get(contents) ?? 0) + 1)
  await sessions.get(contents)?.stop()
}

/** One action may finish its dispatched input, but never continue after human input. */
export async function withBrowserInput<T>(contents: WebContents, work: (input: BrowserInputAction) => Promise<T>): Promise<T> {
  const generation = stopGenerations.get(contents) ?? 0
  while (layouts.has(contents)) await layouts.get(contents)
  if (generation !== (stopGenerations.get(contents) ?? 0)) throw new Error('Browser agent use stopped.')
  const previous = sessions.get(contents)
  if (previous?.retired) void previous.dispose()
  const input = sessions.get(contents) ?? new BrowserInputAction(contents)
  sessions.set(contents, input)
  const pending = activeInputs.get(contents) ?? new Set<Promise<void>>()
  activeInputs.set(contents, pending)
  let finish = () => {}
  const done = new Promise<void>((resolve) => { finish = resolve })
  pending.add(done)
  try {
    const result = await withBrowserPainting(contents, () => work(input))
    input.check()
    return result
  } finally {
    pending.delete(done)
    finish()
    if (input.retired) await input.dispose()
  }
}

class BrowserInputAction {
  private readonly controller = new AbortController()
  retired = false
  private readonly cursor: BrowserCursor
  // Native events may arrive after the CDP acknowledgement and the next dispatch.
  private expectedMouse: Array<Pick<Electron.MouseInputEvent, 'type' | 'button' | 'x' | 'y'> & { expiresAt: number }> = []
  private expectedKey: Array<{ type: string; key: string; expiresAt: number }> = []

  constructor(private readonly contents: WebContents) {
    this.cursor = new BrowserCursor(contents)
    contents.on('did-start-navigation', this.navigation)
    contents.on('before-mouse-event', this.mouse)
    contents.on('before-input-event', this.key)
    contents.on('destroyed', this.interrupt)
  }

  private readonly interrupt = () => {
    stopGenerations.set(this.contents, (stopGenerations.get(this.contents) ?? 0) + 1)
    this.controller.abort(new Error('Browser action interrupted by human input. Take a fresh browser_snapshot before continuing.'))
    void this.dispose()
  }

  private readonly navigation = (_event: Electron.Event, _url: string, _inPlace: boolean, mainFrame: boolean) => {
    if (mainFrame && !_inPlace) {
      this.retired = true
      void this.cursor.clear()
    }
  }

  async showCursor(phase: BrowserCursorFrame['phase'], point: { x: number; y: number }): Promise<void> {
    this.check()
    await this.cursor.show(phase, point)
    this.check()
  }

  private readonly mouse = (_event: Electron.Event, mouse: Electron.MouseInputEvent) => {
    if (!['mouseDown', 'mouseUp', 'mouseWheel'].includes(mouse.type)) return
    this.expectedMouse = this.expectedMouse.filter((expected) => expected.expiresAt > Date.now())
    const index = this.expectedMouse.findIndex((expected) =>
      mouse.type === expected.type && mouse.button === expected.button &&
      Math.abs(mouse.x - expected.x) <= 1 && Math.abs(mouse.y - expected.y) <= 1)
    if (index !== -1) {
      this.expectedMouse.splice(index, 1)
      return
    }
    this.interrupt()
  }

  private readonly key = (_event: Electron.Event, key: Electron.Input) => {
    this.expectedKey = this.expectedKey.filter((expected) => expected.expiresAt > Date.now())
    const index = this.expectedKey.findIndex((expected) =>
      key.type === expected.type && key.key === expected.key &&
      !key.shift && !key.control && !key.alt && !key.meta && !key.isAutoRepeat)
    if (index !== -1) {
      this.expectedKey.splice(index, 1)
      return
    }
    this.interrupt()
  }

  check(): void { this.controller.signal.throwIfAborted() }

  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.check()
    const result = await this.dispatch(method, params)
    this.check()
    return result
  }

  /** Releases held keys/buttons even when the action was interrupted. */
  async dispatch(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const expiresAt = Date.now() + NATIVE_INPUT_GRACE_MS
    if (method === 'Input.dispatchMouseEvent' && params) {
      const scale = viewportScales.get(this.contents) ?? 1
      params = { ...params,
        x: typeof params.x === 'number' && params.x >= 0 ? params.x * scale : params.x,
        y: typeof params.y === 'number' && params.y >= 0 ? params.y * scale : params.y,
      }
    }
    const zoom = this.contents.getZoomFactor()
    const mouse = method === 'Input.dispatchMouseEvent' && params ? {
      type: params.type === 'mousePressed' ? 'mouseDown' as const : 'mouseUp' as const,
      button: 'left' as const, x: Number(params.x) * zoom, y: Number(params.y) * zoom, expiresAt,
    } : undefined
    const key = method === 'Input.dispatchKeyEvent' && params
      ? { type: params.type === 'rawKeyDown' ? 'keyDown' : String(params.type), key: String(params.key), expiresAt }
      : undefined
    if (mouse) this.expectedMouse.push(mouse)
    if (key) this.expectedKey.push(key)
    try {
      return await this.contents.debugger.sendCommand(method, params)
    } catch (error) {
      this.expectedMouse = this.expectedMouse.filter((expected) => expected !== mouse)
      this.expectedKey = this.expectedKey.filter((expected) => expected !== key)
      throw error
    }
  }

  async evaluate(expression: string): Promise<unknown> {
    const response = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }) as {
      exceptionDetails?: unknown; result?: { value?: unknown }
    }
    if (response.exceptionDetails !== undefined) throw new Error('The browser page rejected the action.')
    return response.result?.value
  }

  async wait(work: Promise<void>): Promise<void> {
    this.check()
    let interrupt = () => {}
    const interrupted = new Promise<never>((_resolve, reject) => {
      interrupt = () => reject(this.controller.signal.reason)
      this.controller.signal.addEventListener('abort', interrupt, { once: true })
    })
    try { await Promise.race([work, interrupted]); this.check() }
    finally { this.controller.signal.removeEventListener('abort', interrupt) }
  }

  get signal(): AbortSignal { return this.controller.signal }

  get interrupted(): boolean { return this.controller.signal.aborted }

  async stop(): Promise<void> {
    this.controller.abort(new Error('Browser agent use stopped.'))
    await this.dispose()
  }

  async dispose(): Promise<void> {
    this.retired = true
    if (sessions.get(this.contents) === this) sessions.delete(this.contents)
    this.contents.off('did-start-navigation', this.navigation)
    this.contents.off('before-mouse-event', this.mouse)
    this.contents.off('before-input-event', this.key)
    this.contents.off('destroyed', this.interrupt)
    await this.cursor.clear()
  }
}
