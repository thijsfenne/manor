import type { DictationLanguage, DictationModelId, DictationRequest, DictationResult } from '@manor/contracts'
import { SAMPLE_RATE } from './dictationAudio'

/** What main sends the dictation host; `folder` is the model's folder in the store. */
export type HostRequest =
  | { id: number; type: 'warm'; model: DictationModelId; folder: string; language: DictationLanguage }
  | { id: number; type: 'transcribe'; model: DictationModelId; folder: string; language: DictationLanguage; samples: Float32Array }
export type HostReply = { id: number; text: string } | { id: number; error: string }

/** The utility process as the service sees it; main wraps `utilityProcess.fork`, tests a fake. */
export interface DictationHost {
  post(message: HostRequest): void
  onMessage(listener: (message: unknown) => void): void
  onExit(listener: () => void): void
  kill(): void
}

export const MODEL_MISSING = 'Download a dictation model in Settings first.'
export const TRANSCRIPTION_FAILED = 'Manor could not transcribe this recording. Try again.'
export const IDLE_MS = 2 * 60_000
const MIN_TIMEOUT_MS = 60_000

interface Running {
  host: DictationHost
  model: DictationModelId
  language: DictationLanguage
  pending: Map<number, { resolve: (text: string) => void; reject: (error: Error) => void }>
}

/**
 * Transcription for the composer, in a utility process so a 1 to 2.5 GB model and a
 * multi-second decode stay out of the main process. One request at a time, in order.
 * The host starts on first use, restarts when the model or language changes, and stops
 * after two idle minutes, which is when its memory goes back to the system.
 */
export class DictationService {
  private running: Running | null = null
  private queue = Promise.resolve()
  private busy = 0
  private idle: ReturnType<typeof setTimeout> | null = null
  private nextId = 1
  /** Set at quit, so work still queued behind the last request cannot start a new host. */
  private stopped = false

  constructor(private readonly options: {
    spawnHost: () => DictationHost
    store: { isReady(id: DictationModelId): boolean; modelDir(id: DictationModelId): string }
  }) {}

  /** Loads the model ahead of a recording. A failure here shows up, if at all, on the transcribe after it. */
  async warm(model: DictationModelId, language: DictationLanguage): Promise<void> {
    await this.serial(async () => {
      if (!this.options.store.isReady(model)) return
      const folder = this.options.store.modelDir(model)
      await this.request(model, language, (id) => ({ id, type: 'warm', model, folder, language }), MIN_TIMEOUT_MS)
    }).catch(() => undefined)
  }

  transcribe({ model, language, samples }: DictationRequest): Promise<DictationResult> {
    return this.serial(async (): Promise<DictationResult> => {
      if (!this.options.store.isReady(model)) return { ok: false, reason: 'model-missing', message: MODEL_MISSING }
      const folder = this.options.store.modelDir(model)
      const timeout = Math.max(MIN_TIMEOUT_MS, 3 * (samples.length / SAMPLE_RATE) * 1_000)
      try {
        const text = await this.request(model, language, (id) => ({ id, type: 'transcribe', model, folder, language, samples }), timeout)
        return { ok: true, text }
      } catch (error: unknown) {
        console.warn('[manor] dictation failed', error instanceof Error ? error.message : String(error))
        return { ok: false, reason: 'failed', message: TRANSCRIPTION_FAILED }
      }
    })
  }

  /** Before a model's files go, so no host holds them open. */
  stopFor(model: DictationModelId): void {
    if (this.running?.model === model) this.kill(new Error('The model was removed.'))
  }

  stop(): void {
    this.stopped = true
    this.clearIdle()
    this.kill(new Error('Dictation stopped.'))
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    this.busy += 1
    this.clearIdle()
    const result = this.queue.then(run)
    this.queue = result.then(() => undefined, () => undefined).then(() => {
      this.busy -= 1
      if (this.busy === 0 && this.running !== null) this.idle = setTimeout(() => this.kill(new Error('Idle.')), IDLE_MS)
    })
    return result
  }

  private request(model: DictationModelId, language: DictationLanguage, message: (id: number) => HostRequest, timeoutMs: number): Promise<string> {
    const running = this.hostFor(model, language)
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.kill(new Error(`The dictation host did not answer within ${timeoutMs} ms.`)), timeoutMs)
      running.pending.set(id, {
        resolve: (text) => { clearTimeout(timer); resolve(text) },
        reject: (error) => { clearTimeout(timer); reject(error) },
      })
      try {
        running.host.post(message(id))
      } catch (error: unknown) {
        this.kill(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private hostFor(model: DictationModelId, language: DictationLanguage): Running {
    if (this.stopped) throw new Error('Dictation stopped.')
    if (this.running !== null && (this.running.model !== model || this.running.language !== language)) {
      this.kill(new Error('The dictation model changed.'))
    }
    if (this.running !== null) return this.running
    const running: Running = { host: this.options.spawnHost(), model, language, pending: new Map() }
    running.host.onMessage((message) => {
      const reply = parseReply(message)
      const waiting = reply === null ? undefined : running.pending.get(reply.id)
      if (reply === null || waiting === undefined) return
      running.pending.delete(reply.id)
      if ('error' in reply) waiting.reject(new Error(reply.error))
      else waiting.resolve(reply.text)
    })
    running.host.onExit(() => this.drop(running, new Error('The dictation host exited.')))
    this.running = running
    return running
  }

  private kill(error: Error): void {
    const running = this.running
    if (running === null) return
    this.drop(running, error)
    running.host.kill()
  }

  /** Fails whatever that host still owed; safe to reach twice (kill, then its exit). */
  private drop(running: Running, error: Error): void {
    if (this.running === running) this.running = null
    for (const waiting of running.pending.values()) waiting.reject(error)
    running.pending.clear()
  }

  private clearIdle(): void {
    if (this.idle !== null) clearTimeout(this.idle)
    this.idle = null
  }
}

function parseReply(message: unknown): HostReply | null {
  if (typeof message !== 'object' || message === null) return null
  const { id, text, error } = message as Record<string, unknown>
  if (typeof id !== 'number') return null
  if (typeof error === 'string') return { id, error }
  return typeof text === 'string' ? { id, text } : null
}
