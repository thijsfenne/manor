import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { listLocalServers, pageTitle, parseListeningPorts } from './localServers'

describe('parseListeningPorts', () => {
  it('keeps loopback and wildcard binds above the privileged range, once per port', () => {
    const output = [
      'p100', 'cnode', 'n127.0.0.1:5173', 'n[::1]:5173',
      'p200', 'cControlCe', 'n*:7000', 'n192.168.1.4:7001',
      'p300', 'cpostgres', 'n*:80',
    ].join('\n')
    expect([...parseListeningPorts(output)]).toEqual([[5173, 'node'], [7000, 'ControlCe']])
  })
})

describe('pageTitle', () => {
  it('reads and decodes the title', () => {
    expect(pageTitle('<head><title>\n  Sam Example &amp; co\n</title>')).toBe('Sam Example & co')
    expect(pageTitle('<title></title>')).toBeNull()
  })
})

describe('listLocalServers', () => {
  const servers: Server[] = []
  afterEach(() => { for (const server of servers.splice(0)) server.close() })

  it('offers a port that serves a page and skips one that does not', async () => {
    const page = await listen((_, response) => {
      response.setHeader('content-type', 'text/html')
      response.end('<title>Uren tracker</title>')
    })
    const api = await listen((_, response) => {
      response.setHeader('content-type', 'application/json')
      response.end('{}')
    })
    const listeners = async () => ['p1', 'cnode', `n127.0.0.1:${page}`, `n127.0.0.1:${api}`].join('\n')
    const found = await listLocalServers(new Set(), listeners)
    expect(found).toEqual([{ url: `http://localhost:${page}`, port: page, title: 'Uren tracker' }])
    expect(await listLocalServers(new Set([page]), listeners)).toEqual([])
  })

  async function listen(handler: Parameters<typeof createServer>[1]): Promise<number> {
    const server = createServer(handler)
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return (server.address() as AddressInfo).port
  }
})
