import type { BrowserPreviewImage } from '@manor/contracts'
import type { WebContents } from 'electron'
import { withTimeout } from './browserValues'
import { keepBrowserPainting } from './browserPainting'

/** Composited frames include the page's isolated cursor layer, even while parked. */
export class BrowserPreview {
  private readonly protocol: WebContents['debugger']
  private stopped = false
  private starting: Promise<void> | undefined
  private stopping: Promise<void> | undefined
  private pending: BrowserPreviewImage | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private releasePainting: (() => void) | undefined

  constructor(
    private readonly contents: WebContents,
    private readonly onFrame: (frame: BrowserPreviewImage) => void,
    private readonly onUnavailable: () => void,
  ) { this.protocol = contents.debugger }

  start(): Promise<void> {
    return this.starting ??= this.begin()
  }

  private async begin(): Promise<void> {
    if (this.stopped) return
    this.protocol.on('message', this.message)
    this.protocol.on('detach', this.unavailable)
    this.contents.on('destroyed', this.unavailable)
    try {
      this.releasePainting = await keepBrowserPainting(this.contents)
      await withTimeout(this.protocol.sendCommand('Page.startScreencast', {
        format: 'jpeg', quality: 70, maxWidth: 960, maxHeight: 960, everyNthFrame: 1,
      }), 5000)
    } catch {
      this.unavailable()
    }
  }

  private readonly message = (_event: Electron.Event, method: string, params: unknown) => {
    if (method !== 'Page.screencastFrame') return
    const frame = asRecord(params)
    if (typeof frame?.sessionId === 'number') {
      // Acknowledge dropped frames too, otherwise Chromium stops producing them.
      void this.protocol.sendCommand('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {})
    }
    if (this.stopped || typeof frame?.data !== 'string') return
    const metadata = asRecord(frame.metadata)
    const width = metadata?.deviceWidth, height = metadata?.deviceHeight
    if (typeof width !== 'number' || typeof height !== 'number' || !(width > 0) || !(height > 0)) return
    this.pending = { screenshot: `data:image/jpeg;base64,${frame.data}`, width, height }
    // One pending image, at most thirty updates per second; the last frame wins.
    this.timer ??= setTimeout(() => {
      this.timer = undefined
      this.flush()
    }, 1000 / 30)
  }

  private readonly unavailable = () => {
    if (this.stopped) return
    this.onUnavailable()
    void this.stop()
  }

  flush(): void {
    const latest = this.pending
    this.pending = undefined
    if (!this.stopped && latest !== undefined) this.onFrame(latest)
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping
    this.stopped = true
    clearTimeout(this.timer)
    this.timer = undefined
    this.pending = undefined
    this.protocol.off('message', this.message)
    this.protocol.off('detach', this.unavailable)
    this.contents.off('destroyed', this.unavailable)
    return this.stopping ??= this.finish()
  }

  private async finish(): Promise<void> {
    try {
      await this.starting
      if (this.contents.isDestroyed() || !this.protocol.isAttached()) return
      try { await withTimeout(this.protocol.sendCommand('Page.stopScreencast'), 5000) }
      catch { /* A closing page has already stopped its screencast. */ }
    } finally {
      this.releasePainting?.()
      this.releasePainting = undefined
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined
}
