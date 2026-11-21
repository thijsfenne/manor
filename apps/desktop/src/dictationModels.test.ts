import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { DictationModelStatus } from '@manor/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DictationCatalog, DictationModel } from './dictationCatalog'
import { DOWNLOAD_FAILED, DictationModelStore, type DictationFetch } from './dictationModels'

const encoder = Buffer.alloc(300, 1)
const tokens = Buffer.from('a 0\nb 1\n')
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const tiny = (files: { name: string; role: 'encoder' | 'tokens'; body: Buffer }[]): DictationModel => ({
  repo: 'test/tiny',
  revision: 'abc',
  files: files.map(({ name, role, body }) => ({ name, role, bytes: body.length, sha256: sha(body) })),
  engine: 'transducer',
  maxPartSeconds: 60,
  windowSeconds: 5,
})
const catalog: DictationCatalog = {
  'whisper-turbo': tiny([{ name: 'encoder.onnx', role: 'encoder', body: encoder }, { name: 'tokens.txt', role: 'tokens', body: tokens }]),
  'parakeet-tdt-v3': tiny([{ name: 'tokens.txt', role: 'tokens', body: tokens }]),
}
const bodies: Record<string, Buffer> = { 'encoder.onnx': encoder, 'tokens.txt': tokens }

/** Serves each file in 100 byte chunks; `override` replaces the answer for one file name. */
function fakeFetch(override: Record<string, () => Response> = {}) {
  const asked: string[] = []
  const fetch: DictationFetch = async (url) => {
    const name = url.split('/').at(-1) ?? ''
    asked.push(name)
    const replace = override[name]
    if (replace !== undefined) return replace()
    const body = bodies[name] ?? Buffer.alloc(0)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let start = 0; start < body.length; start += 100) controller.enqueue(new Uint8Array(body.subarray(start, start + 100)))
        controller.close()
      },
    })
    return new Response(stream)
  }
  return { fetch, asked }
}

const roots: string[] = []
function storeWith(fetch: DictationFetch) {
  const root = mkdtempSync(path.join(tmpdir(), 'manor-dictation-'))
  roots.push(root)
  const pushed: DictationModelStatus[][] = []
  const store = new DictationModelStore({ root, fetch, catalog, onChange: (models) => pushed.push(models) })
  const whisper = () => store.statuses().find((model) => model.id === 'whisper-turbo')
  return { root, store, pushed, whisper, folder: store.modelDir('whisper-turbo') }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('DictationModelStore', () => {
  it('downloads every file into place and ends ready, pushing progress on the way', async () => {
    const { store, pushed, whisper, folder } = storeWith(fakeFetch().fetch)
    expect(whisper()).toEqual({ id: 'whisper-turbo', bytes: encoder.length + tokens.length, state: 'missing', progress: 0 })
    await store.download('whisper-turbo')
    expect(whisper()?.state).toBe('ready')
    expect(store.isReady('whisper-turbo')).toBe(true)
    expect(readdirSync(folder).sort()).toEqual(['encoder.onnx', 'tokens.txt'])
    const progress = pushed.flatMap((models) => models.filter((model) => model.id === 'whisper-turbo' && model.state === 'downloading').map((model) => model.progress))
    expect(progress.length).toBeGreaterThan(2)
    expect(progress).toEqual([...progress].sort((a, b) => a - b))
    expect(pushed.at(-1)?.find((model) => model.id === 'whisper-turbo')?.state).toBe('ready')
  })

  it('fails on a wrong hash and leaves no file behind', async () => {
    const wrong = Buffer.alloc(encoder.length, 2)
    const { store, whisper, folder } = storeWith(fakeFetch({ 'encoder.onnx': () => new Response(wrong) }).fetch)
    await store.download('whisper-turbo')
    expect(whisper()).toMatchObject({ state: 'failed', error: DOWNLOAD_FAILED })
    expect(readdirSync(folder)).toEqual([])
  })

  it('fails on a body longer than the catalogue says', async () => {
    const { store, whisper, folder } = storeWith(fakeFetch({ 'encoder.onnx': () => new Response(Buffer.concat([encoder, encoder])) }).fetch)
    await store.download('whisper-turbo')
    expect(whisper()).toMatchObject({ state: 'failed', error: DOWNLOAD_FAILED })
    expect(readdirSync(folder)).toEqual([])
  })

  it('fails on an HTTP error, and a retry clears the failure', async () => {
    let broken = true
    const { store, whisper } = storeWith(fakeFetch({ 'encoder.onnx': () => broken ? new Response('gone', { status: 503 }) : new Response(encoder) }).fetch)
    await store.download('whisper-turbo')
    expect(whisper()).toMatchObject({ state: 'failed', error: DOWNLOAD_FAILED })
    broken = false
    await store.download('whisper-turbo')
    expect(whisper()?.state).toBe('ready')
  })

  it('ends missing on cancel, with no part file left', async () => {
    // Sends the first 100 bytes, then hangs as a stalled connection would.
    const { fetch } = fakeFetch({
      'encoder.onnx': () => new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array(encoder.subarray(0, 100))) },
      })),
    })
    const { store, whisper, folder } = storeWith(fetch)
    const download = store.download('whisper-turbo')
    await vi.waitFor(() => expect(whisper()?.progress).toBeGreaterThan(0))
    expect(whisper()?.state).toBe('downloading')
    await store.cancelDownload('whisper-turbo')
    await download
    expect(whisper()).toEqual(expect.objectContaining({ state: 'missing', progress: 0 }))
    expect(readdirSync(folder)).toEqual([])
  })

  it('skips a file that already finished', async () => {
    const { fetch, asked } = fakeFetch()
    const { store, whisper, folder } = storeWith(fetch)
    await mkdir(folder, { recursive: true })
    writeFileSync(path.join(folder, 'encoder.onnx'), encoder)
    await store.download('whisper-turbo')
    expect(asked).toEqual(['tokens.txt'])
    expect(whisper()?.state).toBe('ready')
  })

  it('treats a second download of the same model as a no-op', async () => {
    const { fetch, asked } = fakeFetch()
    const { store } = storeWith(fetch)
    await Promise.all([store.download('whisper-turbo'), store.download('whisper-turbo')])
    expect(asked).toEqual(['encoder.onnx', 'tokens.txt'])
  })

  it('removes a model back to missing, and is not ready from the moment removal starts', async () => {
    const { store, whisper, folder } = storeWith(fakeFetch().fetch)
    await store.download('whisper-turbo')
    const removal = store.remove('whisper-turbo')
    expect(store.isReady('whisper-turbo')).toBe(false)
    await removal
    expect(whisper()?.state).toBe('missing')
    expect(existsSync(folder)).toBe(false)
  })
})
