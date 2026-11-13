import { expect, it, vi } from 'vitest'
import { keepBrowserPainting, registerBrowserPainting, withBrowserPainting } from './browserPainting'

it('waits for visible pixels and keeps overlapping work awake until the last release', async () => {
  const contents = {} as never
  let ready = () => {}
  const setPainting = vi.fn((active: boolean) => active ? new Promise<void>(resolve => { ready = resolve }) : Promise.resolve())
  registerBrowserPainting(contents, setPainting)
  let started = false
  const first = keepBrowserPainting(contents).then(release => { started = true; return release })
  const second = keepBrowserPainting(contents)
  await new Promise(setImmediate)
  expect(started).toBe(false)
  expect(setPainting.mock.calls).toEqual([[true]])
  ready()
  const releaseFirst = await first, releaseSecond = await second
  releaseFirst(); releaseFirst()
  expect(setPainting.mock.calls).toEqual([[true]])
  releaseSecond()
  await new Promise(setImmediate)
  expect(setPainting.mock.calls).toEqual([[true], [false]])
})

it('releases after failed actions and can retry after failed waking', async () => {
  const contents = {} as never
  const setPainting = vi.fn(async (_active: boolean) => {})
  registerBrowserPainting(contents, setPainting)
  await expect(withBrowserPainting(contents, async () => { throw new Error('action') })).rejects.toThrow('action')
  await new Promise(setImmediate)
  expect(setPainting.mock.calls).toEqual([[true], [false]])
  setPainting.mockRejectedValueOnce(new Error('closed'))
  await expect(keepBrowserPainting(contents)).rejects.toThrow('closed')
  await new Promise(setImmediate)
  expect(setPainting).toHaveBeenLastCalledWith(false)
  await expect(withBrowserPainting(contents, async () => 'ready')).resolves.toBe('ready')
})

it('finishes hiding before a subsequent action wakes the page again', async () => {
  const contents = {} as never
  let hidden = () => {}
  const setPainting = vi.fn((active: boolean) => active ? Promise.resolve() : new Promise<void>(resolve => { hidden = resolve }))
  registerBrowserPainting(contents, setPainting)
  const release = await keepBrowserPainting(contents)
  release()
  const next = keepBrowserPainting(contents)
  await new Promise(setImmediate)
  expect(setPainting.mock.calls).toEqual([[true], [false]])
  hidden()
  const releaseNext = await next
  expect(setPainting.mock.calls).toEqual([[true], [false], [true]])
  releaseNext()
  await new Promise(setImmediate)
  hidden()
})
