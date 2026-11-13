import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerComputerStopIpc } from './computerStop'

type Handler = (event: unknown, armed?: unknown, stop?: unknown) => unknown
const host = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  shortcuts: new Map<string, () => void>(),
}))
const arm = (sender: unknown, ...args: unknown[]) => host.handlers.get('manor:computer:stop-armed')!({ sender }, ...args)

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: Handler) => {
      host.handlers.set(channel, handler)
    },
  },
  globalShortcut: {
    register: (key: string, callback: () => void) => {
      host.shortcuts.set(key, callback)
      return true
    },
    unregister: (key: string) => {
      host.shortcuts.delete(key)
    },
  },
}))

const TOKEN = 'a'.repeat(32)

function renderer() {
  const listeners = new Map<string, () => void>()
  return {
    id: 7,
    on: (name: string, listener: () => void) => listeners.set(name, listener),
    off: (name: string) => listeners.delete(name),
    fire: (name: string) => listeners.get(name)?.(),
  }
}

/** A stand-in for the Manor server's stop endpoint that answers only when told to. */
async function stopServer(options: { failFirst?: number } = {}) {
  const received: string[] = []
  const waiting: ServerResponse[] = []
  let failures = options.failFirst ?? 0
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    request.on('end', () => {
      received.push((JSON.parse(body) as { token: string }).token)
      if (failures > 0) {
        failures -= 1
        response.writeHead(500).end('{}')
        return
      }
      waiting.push(response)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/internal/computer-stop`,
    received,
    until: async (count: number) => {
      while (received.length < count) await new Promise((resolve) => setTimeout(resolve, 5))
    },
    answer: () => { for (const response of waiting.splice(0)) response.writeHead(200).end('{"stopped":true}') },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

describe('the computer stop shortcut', () => {
  let server: Awaited<ReturnType<typeof stopServer>>
  beforeEach(async () => {
    host.shortcuts.clear()
    server = await stopServer()
  })
  afterEach(async () => {
    server.answer()
    await server.close()
  })

  it('posts Escape to the server from the shell, not through the page', async () => {
    const contents = renderer()
    registerComputerStopIpc(() => ({ webContents: contents }) as never)
    await arm(contents, true, { token: TOKEN, url: server.url })
    host.shortcuts.get('Escape')!()
    await server.until(1)
    expect(server.received).toEqual([TOKEN])
    server.answer()
    await vi.waitFor(() => expect(host.shortcuts.has('Escape')).toBe(false))
  })

  it('keeps Escape registered through a reload until the server has confirmed the stop', async () => {
    const contents = renderer()
    registerComputerStopIpc(() => ({ webContents: contents }) as never)
    await arm(contents, true, { token: TOKEN, url: server.url })
    contents.fire('did-start-loading')
    await server.until(1)
    expect(server.received).toEqual([TOKEN])
    expect(host.shortcuts.has('Escape')).toBe(true)
    server.answer()
    await vi.waitFor(() => expect(host.shortcuts.has('Escape')).toBe(false))
  })

  it('delivers the stop on a lost server socket and holds Escape until it lands', async () => {
    const contents = renderer()
    registerComputerStopIpc(() => ({ webContents: contents }) as never)
    await arm(contents, true, { token: TOKEN, url: server.url })
    await host.handlers.get('manor:computer:connection-lost')!({ sender: contents })
    await server.until(1)
    expect(host.shortcuts.has('Escape')).toBe(true)
    server.answer()
    await vi.waitFor(() => expect(host.shortcuts.has('Escape')).toBe(false))
  })

  it('keeps Escape registered and retries when the stop request fails', async () => {
    await server.close()
    server = await stopServer({ failFirst: 2 })
    const contents = renderer()
    registerComputerStopIpc(() => ({ webContents: contents }) as never, undefined, 5)
    await arm(contents, true, { token: TOKEN, url: server.url })
    contents.fire('did-start-loading')
    await server.until(3)
    expect(server.received).toEqual([TOKEN, TOKEN, TOKEN])
    expect(host.shortcuts.has('Escape')).toBe(true)
    server.answer()
    await vi.waitFor(() => expect(host.shortcuts.has('Escape')).toBe(false))
  })

  it('retries an Escape press whose first stop request fails, then lets go of Escape', async () => {
    await server.close()
    server = await stopServer({ failFirst: 1 })
    const contents = renderer()
    registerComputerStopIpc(() => ({ webContents: contents }) as never, undefined, 5)
    await arm(contents, true, { token: TOKEN, url: server.url })
    host.shortcuts.get('Escape')!()
    host.shortcuts.get('Escape')!()
    await server.until(2)
    expect(server.received).toEqual([TOKEN, TOKEN])
    expect(host.shortcuts.has('Escape')).toBe(true)
    server.answer()
    await vi.waitFor(() => expect(host.shortcuts.has('Escape')).toBe(false))
    expect(server.received).toHaveLength(2)
  })

  it('refuses to arm without a local stop endpoint', async () => {
    const contents = renderer()
    registerComputerStopIpc(() => ({ webContents: contents }) as never)
    expect(() => arm(contents, true)).toThrow('stop token')
    expect(() => arm(contents, true, { token: TOKEN, url: 'http://example.com/internal/computer-stop' }))
      .toThrow('local Manor server')
    expect(host.shortcuts.has('Escape')).toBe(false)
  })
})
