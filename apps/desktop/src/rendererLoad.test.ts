import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { loadRenderer } from './rendererLoad'

const RENDERER = 'http://localhost:43179/'

function fakeWindow(failures: number) {
  const contents = Object.assign(new EventEmitter(), {
    loaded: [] as string[],
    loadURL: vi.fn(async (url: string) => {
      contents.loaded.push(url)
      if (url === RENDERER && contents.loaded.filter((entry) => entry === RENDERER).length <= failures) {
        contents.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', url, true)
        throw new Error('ERR_CONNECTION_REFUSED')
      }
    }),
  })
  let destroyed = false
  return {
    webContents: contents,
    show: vi.fn(),
    isDestroyed: () => destroyed,
    destroy: () => { destroyed = true },
  }
}

// The probe never answers unless a test says so, and closing the window ends the wait
// the error screen starts, so no test leaves one polling.
const quick = { attempts: 3, delayMs: 0, probeMs: 1, probe: async () => false }

describe('renderer load', () => {
  it('retries a server that is still starting and then opens the app', async () => {
    const window = fakeWindow(2)
    await loadRenderer(window, RENDERER, quick)
    expect(window.webContents.loaded).toEqual([RENDERER, RENDERER, RENDERER])
  })

  it('shows a local error screen with a retry link once the retries run out', async () => {
    const window = fakeWindow(Infinity)
    await loadRenderer(window, RENDERER, quick)
    window.destroy()
    const page = window.webContents.loaded.at(-1) ?? ''
    expect(window.webContents.loaded.filter((url) => url === RENDERER)).toHaveLength(3)
    expect(page.startsWith('data:text/html')).toBe(true)
    expect(decodeURIComponent(page)).toContain(`href="${RENDERER}"`)
    expect(window.show).toHaveBeenCalled()
  })

  it('returns to the error screen when a retry from it fails, ignoring aborted loads', async () => {
    const window = fakeWindow(Infinity)
    await loadRenderer(window, RENDERER, quick)
    const before = window.webContents.loaded.length
    window.webContents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', RENDERER, true)
    window.webContents.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'https://example.com/', true)
    expect(window.webContents.loaded).toHaveLength(before)
    window.webContents.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', RENDERER, true)
    expect(window.webContents.loaded).toHaveLength(before + 1)
    expect(window.webContents.loaded.at(-1)?.startsWith('data:text/html')).toBe(true)
    window.destroy()
  })

  it('opens the app itself once the restarted server answers again', async () => {
    const window = fakeWindow(3)
    let answers = false
    await loadRenderer(window, RENDERER, { ...quick, probe: async () => answers })
    expect(window.webContents.loaded.at(-1)?.startsWith('data:text/html')).toBe(true)
    answers = true
    await vi.waitFor(() => expect(window.webContents.loaded.at(-1)).toBe(RENDERER))
  })
})
