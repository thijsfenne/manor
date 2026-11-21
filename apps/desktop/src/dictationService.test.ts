import type { DictationModelId } from '@manor/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DictationService, IDLE_MS, MODEL_MISSING, TRANSCRIPTION_FAILED, type DictationHost, type HostRequest,
} from './dictationService'

class FakeHost implements DictationHost {
  readonly posted: HostRequest[] = []
  killed = false
  private readonly messageListeners: ((message: unknown) => void)[] = []
  private readonly exitListeners: (() => void)[] = []
  post(message: HostRequest) { this.posted.push(message) }
  onMessage(listener: (message: unknown) => void) { this.messageListeners.push(listener) }
  onExit(listener: () => void) { this.exitListeners.push(listener) }
  kill() {
    this.killed = true
    this.exit()
  }
  exit() { for (const listener of this.exitListeners) listener() }
  /** Answers the latest request with `text`, or with an error when `text` is an Error. */
  answer(text: string | Error) {
    const id = this.posted.at(-1)?.id
    for (const listener of this.messageListeners) listener(text instanceof Error ? { id, error: text.message } : { id, text })
  }
}

const samples = (seconds: number) => new Float32Array(seconds * 16_000)

function setup(ready: DictationModelId[] = ['whisper-turbo', 'parakeet-tdt-v3']) {
  const hosts: FakeHost[] = []
  const service = new DictationService({
    store: { isReady: (id) => ready.includes(id), modelDir: (id) => `/models/${id}` },
    spawnHost: () => {
      const host = new FakeHost()
      hosts.push(host)
      return host
    },
  })
  return { service, hosts }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('DictationService', () => {
  it('transcribes through the host', async () => {
    const { service, hosts } = setup()
    const result = service.transcribe({ model: 'whisper-turbo', language: 'nl', samples: samples(2) })
    await vi.advanceTimersByTimeAsync(0)
    expect(hosts[0]?.posted[0]).toMatchObject({ type: 'transcribe', model: 'whisper-turbo', folder: '/models/whisper-turbo', language: 'nl' })
    hosts[0]?.answer('Hallo daar.')
    expect(await result).toEqual({ ok: true, text: 'Hallo daar.' })
  })

  it('answers model-missing without starting a host', async () => {
    const { service, hosts } = setup([])
    expect(await service.transcribe({ model: 'whisper-turbo', language: 'auto', samples: samples(1) }))
      .toEqual({ ok: false, reason: 'model-missing', message: MODEL_MISSING })
    expect(hosts).toHaveLength(0)
  })

  it('turns a crash mid-request into the failure result, and starts a fresh host after it', async () => {
    const { service, hosts } = setup()
    const crashed = service.transcribe({ model: 'whisper-turbo', language: 'auto', samples: samples(1) })
    await vi.advanceTimersByTimeAsync(0)
    hosts[0]?.exit()
    expect(await crashed).toEqual({ ok: false, reason: 'failed', message: TRANSCRIPTION_FAILED })
    const next = service.transcribe({ model: 'whisper-turbo', language: 'auto', samples: samples(1) })
    await vi.advanceTimersByTimeAsync(0)
    expect(hosts).toHaveLength(2)
    hosts[1]?.answer('Weer goed.')
    expect(await next).toEqual({ ok: true, text: 'Weer goed.' })
  })

  it('kills a host that does not answer in time', async () => {
    const { service, hosts } = setup()
    // 15 s of audio waits the 60 s floor; 40 s of audio would wait 120 s.
    const result = service.transcribe({ model: 'whisper-turbo', language: 'auto', samples: samples(15) })
    await vi.advanceTimersByTimeAsync(59_000)
    expect(hosts[0]?.killed).toBe(false)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(hosts[0]?.killed).toBe(true)
    expect(await result).toEqual({ ok: false, reason: 'failed', message: TRANSCRIPTION_FAILED })
  })

  it('runs requests one at a time, in order', async () => {
    const { service, hosts } = setup()
    const first = service.transcribe({ model: 'whisper-turbo', language: 'auto', samples: samples(1) })
    const second = service.transcribe({ model: 'whisper-turbo', language: 'auto', samples: samples(1) })
    await vi.advanceTimersByTimeAsync(0)
    expect(hosts[0]?.posted).toHaveLength(1)
    hosts[0]?.answer('een')
    await vi.advanceTimersByTimeAsync(0)
    expect(hosts[0]?.posted).toHaveLength(2)
    hosts[0]?.answer('twee')
    expect(await first).toEqual({ ok: true, text: 'een' })
    expect(await second).toEqual({ ok: true, text: 'twee' })
    expect(hosts).toHaveLength(1)
  })

  it('restarts the host for a different model or language', async () => {
    const { service, hosts } = setup()
    const first = service.transcribe({ model: 'whisper-turbo', language: 'auto', samples: samples(1) })
    await vi.advanceTimersByTimeAsync(0)
    hosts[0]?.answer('een')
    await first
    const second = service.transcribe({ model: 'parakeet-tdt-v3', language: 'auto', samples: samples(1) })
    await vi.advanceTimersByTimeAsync(0)
    expect(hosts[0]?.killed).toBe(true)
    expect(hosts[1]?.posted[0]?.model).toBe('parakeet-tdt-v3')
    hosts[1]?.answer('twee')
    await second
    const third = service.transcribe({ model: 'parakeet-tdt-v3', language: 'nl', samples: samples(1) })
    await vi.advanceTimersByTimeAsync(0)
    expect(hosts[1]?.killed).toBe(true)
    expect(hosts).toHaveLength(3)
    hosts[2]?.answer('drie')
    expect(await third).toEqual({ ok: true, text: 'drie' })
  })

  it('stops the host after two idle minutes', async () => {
    const { service, hosts } = setup()
    const result = service.transcribe({ model: 'whisper-turbo', language: 'auto', samples: samples(1) })
    await vi.advanceTimersByTimeAsync(0)
    hosts[0]?.answer('klaar')
    await result
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1)
    expect(hosts[0]?.killed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(hosts[0]?.killed).toBe(true)
  })

  it('swallows a host that cannot start during warm', async () => {
    const service = new DictationService({
      store: { isReady: () => true, modelDir: (id) => `/models/${id}` },
      spawnHost: () => { throw new Error('No utility process.') },
    })
    await expect(service.warm('whisper-turbo', 'auto')).resolves.toBeUndefined()
  })

  it('starts no host for work still queued at stop', async () => {
    const { service, hosts } = setup()
    const result = service.transcribe({ model: 'whisper-turbo', language: 'auto', samples: samples(1) })
    service.stop()
    expect(await result).toEqual({ ok: false, reason: 'failed', message: TRANSCRIPTION_FAILED })
    expect(hosts).toHaveLength(0)
  })

  it('swallows a warm failure, and stopFor stops the host holding that model', async () => {
    const { service, hosts } = setup()
    const warm = service.warm('whisper-turbo', 'auto')
    await vi.advanceTimersByTimeAsync(0)
    expect(hosts[0]?.posted[0]?.type).toBe('warm')
    hosts[0]?.answer(new Error('The model file is damaged.'))
    await expect(warm).resolves.toBeUndefined()
    service.stopFor('parakeet-tdt-v3')
    expect(hosts[0]?.killed).toBe(false)
    service.stopFor('whisper-turbo')
    expect(hosts[0]?.killed).toBe(true)
  })
})
