import { createHash } from 'node:crypto'
import { createWriteStream, statSync } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import type { DictationModelId, DictationModelStatus } from '@manor/contracts'
import { fileUrl, modelBytes, type DictationCatalog } from './dictationCatalog'

export const DOWNLOAD_FAILED = 'The download did not finish. Check your connection and try again.'

/** Electron's `net.fetch` in the app, so the system proxy applies; a fake in tests. */
export type DictationFetch = (url: string, init: { signal: AbortSignal }) => Promise<Response>

interface Download {
  controller: AbortController
  done: number
  total: number
  percent: number
  finished: Promise<void>
}

/**
 * The speech models on disk, one folder per model under `root`. A model is `ready`
 * when every catalogue file is there with its exact size; a file only gets its real
 * name after its byte count and sha256 matched, so a size match is enough to trust it.
 * Every change reaches `onChange` with all statuses, which main pushes to the window.
 */
export class DictationModelStore {
  private readonly downloads = new Map<DictationModelId, Download>()
  private readonly failures = new Map<DictationModelId, string>()
  /** Models whose folder is being deleted: not ready, and no download starts until it is gone. */
  private readonly removing = new Set<DictationModelId>()

  constructor(private readonly options: {
    root: string
    fetch: DictationFetch
    catalog: DictationCatalog
    onChange: (models: DictationModelStatus[]) => void
  }) {}

  modelDir(id: DictationModelId): string {
    return path.join(this.options.root, id)
  }

  isReady(id: DictationModelId): boolean {
    return !this.removing.has(id) && this.options.catalog[id].files.every((file) => sizeOf(path.join(this.modelDir(id), file.name)) === file.bytes)
  }

  statuses(): DictationModelStatus[] {
    return this.ids().map((id) => {
      const bytes = modelBytes(this.options.catalog[id])
      const download = this.downloads.get(id)
      if (download !== undefined) return { id, bytes, state: 'downloading', progress: download.done / download.total }
      const error = this.failures.get(id)
      if (error !== undefined) return { id, bytes, state: 'failed', progress: 0, error }
      return { id, bytes, state: this.isReady(id) ? 'ready' : 'missing', progress: 0 }
    })
  }

  /** Resolves when the download ended, however it ended. A second call while one runs is a no-op. */
  download(id: DictationModelId): Promise<void> {
    if (this.downloads.has(id) || this.removing.has(id)) return Promise.resolve()
    const model = this.options.catalog[id]
    const controller = new AbortController()
    const download: Download = { controller, done: 0, total: modelBytes(model), percent: 0, finished: Promise.resolve() }
    this.downloads.set(id, download)
    this.failures.delete(id)
    this.changed()
    download.finished = (async () => {
      try {
        await mkdir(this.modelDir(id), { recursive: true })
        for (const file of model.files) {
          controller.signal.throwIfAborted()
          const target = path.join(this.modelDir(id), file.name)
          // A retry resumes at the first file that did not finish.
          if (sizeOf(target) !== file.bytes) await this.fetchFile(fileUrl(model, file), target, file, download)
          else this.advance(download, file.bytes)
        }
      } catch (error: unknown) {
        if (!controller.signal.aborted) {
          console.warn('[manor] dictation model download failed', error instanceof Error ? error.message : String(error))
          this.failures.set(id, DOWNLOAD_FAILED)
        }
      } finally {
        this.downloads.delete(id)
        this.changed()
      }
    })()
    return download.finished
  }

  /** Ends in `missing`, unless the last file was already being renamed into place, which ends `ready`. */
  async cancelDownload(id: DictationModelId): Promise<void> {
    const download = this.downloads.get(id)
    if (download === undefined) return
    download.controller.abort()
    await download.finished
  }

  /** Marks the model gone before the first await, so a queued transcription sees it missing at once. */
  async remove(id: DictationModelId): Promise<void> {
    if (this.removing.has(id)) return
    this.removing.add(id)
    try {
      await this.cancelDownload(id)
      await rm(this.modelDir(id), { recursive: true, force: true })
    } finally {
      this.removing.delete(id)
      this.failures.delete(id)
      this.changed()
    }
  }

  /** At quit: aborts every download, leaving only `.part` files that never get trusted. */
  stop(): void {
    for (const download of this.downloads.values()) download.controller.abort()
  }

  private async fetchFile(url: string, target: string, file: { bytes: number; sha256: string }, download: Download): Promise<void> {
    const part = `${target}.part`
    const hash = createHash('sha256')
    let bytes = 0
    try {
      const response = await this.options.fetch(url, { signal: download.controller.signal })
      if (!response.ok || response.body === null) throw new Error(`${url} answered ${response.status}`)
      const count = new Transform({
        transform: (chunk: Buffer, _encoding, next) => {
          // A body longer than the catalogue says is wrong already; stop writing it.
          if (bytes + chunk.length > file.bytes) return next(new Error(`${url} is longer than ${file.bytes} bytes`))
          hash.update(chunk)
          bytes += chunk.length
          this.advance(download, chunk.length)
          next(null, chunk)
        },
      })
      // Through `fromWeb` with the signal: a web stream handed to `pipeline` directly ignores an
      // abort while its read is pending, so cancelling a stalled download would hang. The cast
      // only bridges the global and the `node:stream/web` declarations of the same class.
      const body = Readable.fromWeb(response.body as WebReadableStream<Uint8Array>, { signal: download.controller.signal })
      await pipeline(body, count, createWriteStream(part), { signal: download.controller.signal })
      if (bytes !== file.bytes) throw new Error(`${url} gave ${bytes} bytes, expected ${file.bytes}`)
      if (hash.digest('hex') !== file.sha256) throw new Error(`${url} did not match its sha256`)
      download.controller.signal.throwIfAborted()
      await rename(part, target)
    } finally {
      await rm(part, { force: true })
    }
  }

  private advance(download: Download, bytes: number): void {
    download.done += bytes
    const percent = Math.floor((download.done / download.total) * 100)
    if (percent === download.percent) return
    download.percent = percent
    this.changed()
  }

  private changed(): void {
    this.options.onChange(this.statuses())
  }

  private ids(): DictationModelId[] {
    return Object.keys(this.options.catalog) as DictationModelId[]
  }
}

function sizeOf(file: string): number | null {
  return statSync(file, { throwIfNoEntry: false })?.size ?? null
}
