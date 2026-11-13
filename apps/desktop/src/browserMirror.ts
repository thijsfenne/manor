import { BrowserWindow, type WebContents } from 'electron'
import { BrowserPreview } from './browserPreview'

/** A passive mirror. The actual guest stays mounted in the main renderer. */
export class BrowserMirror {
  private readonly window = new BrowserWindow({ width: 640, height: 400, show: false,
    title: 'Browser preview', webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } })
  private stream: BrowserPreview | undefined
  private target: WebContents | undefined
  private pending = Promise.resolve()
  private closed = false
  private readonly ready: Promise<void>

  constructor(private readonly onClosed: () => void) {
    this.ready = this.window.loadURL('data:text/html,' + encodeURIComponent(
      '<meta http-equiv="Content-Security-Policy" content="default-src \'none\';img-src data:;style-src \'unsafe-inline\'">' +
      '<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:black}img{width:100%;height:100%;object-fit:contain;pointer-events:none}</style>' +
      '<img id="preview" alt="Live browser preview">'))
    this.window.once('closed', () => {
      this.closed = true
      void this.stream?.stop()
      this.onClosed()
    })
  }

  show(): void { if (!this.closed) this.window.showInactive() }

  setTarget(contents: WebContents | undefined): Promise<void> {
    const work = this.pending.then(async () => {
      await this.ready
      if (this.closed || this.target === contents) return
      await this.stream?.stop()
      this.stream = undefined
      this.target = contents
      if (!contents || contents.isDestroyed()) return
      let delivering = false
      this.stream = new BrowserPreview(contents, (frame) => {
        if (this.closed || this.target !== contents || delivering) return
        delivering = true
        void this.window.webContents.executeJavaScript(
          `document.getElementById('preview').src = ${JSON.stringify(frame.screenshot)}; undefined`,
        ).catch(() => {}).finally(() => { delivering = false })
      }, () => { this.target = undefined })
      await this.stream.start()
    })
    this.pending = work.catch(() => {})
    return work
  }

  close(): void { if (!this.closed) this.window.destroy() }
}
