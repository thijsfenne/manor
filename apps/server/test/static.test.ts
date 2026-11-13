import { createServer } from 'node:http'
import { connect } from 'node:net'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createStaticHandler } from '../src/static.js'

describe('static handler', () => {
  const dist = mkdtempSync(path.join(os.tmpdir(), 'manor-static-'))
  writeFileSync(path.join(dist, 'index.html'), '<main>the house</main>', 'utf8')
  writeFileSync(path.join(dist, 'app.js'), 'export {}\n', 'utf8')
  const handler = createStaticHandler(dist)
  if (handler === undefined) throw new Error('expected a static handler')
  const server = createServer(handler)
  let base = ''

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('expected a TCP address')
    base = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    )
  })

  it('serves an asset with security headers and immutable caching', async () => {
    const response = await fetch(`${base}/app.js`)

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('export {}\n')
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(response.headers.get('x-frame-options')).toBe('DENY')
    expect(response.headers.get('cache-control')).toContain('immutable')
  })

  it('falls back to the uncached SPA shell for an extensionless route', async () => {
    const response = await fetch(`${base}/projects/manor`)

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('the house')
    expect(response.headers.get('cache-control')).toBe('no-cache')
    expect(response.headers.get('content-security-policy')).not.toBeNull()
  })

  it('allows the local Manor origin, and no bare http, in both enforced connection policies', async () => {
    const response = await fetch(base)
    const shell = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8')
    const meta = shell.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1]

    for (const policy of [response.headers.get('content-security-policy'), meta]) {
      const connections = policy?.split(';').find((directive) => directive.trim().startsWith('connect-src '))?.trim().split(/\s+/)
      expect(connections).toContain('http://127.0.0.1:43179')
      expect(connections).toContain('http://localhost:43179')
      expect(connections).not.toContain('http://127.0.0.1:54321')
      expect(connections).not.toContain('http:')
    }
  })

  it('answers an unparseable request target with 400 and keeps serving', async () => {
    const { port } = new URL(base)
    const raw = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(port), '127.0.0.1', () => {
        socket.write('GET http://[ HTTP/1.1\r\nHost: manor\r\nConnection: close\r\n\r\n')
      })
      let received = ''
      socket.on('data', (chunk) => { received += String(chunk) })
      socket.on('end', () => resolve(received))
      socket.on('error', reject)
    })

    expect(raw.startsWith('HTTP/1.1 400')).toBe(true)
    expect((await fetch(`${base}/app.js`)).status).toBe(200)
  })

  it('answers a missing asset with an honest secured 404', async () => {
    const response = await fetch(`${base}/missing.js`)

    expect(response.status).toBe(404)
    expect(await response.text()).toBe('not found\n')
    expect(response.headers.get('content-security-policy')).not.toBeNull()
    expect(response.headers.get('cache-control')).toBe('no-cache')
  })

  it('answers safely when the SPA shell disappears during a deploy', async () => {
    rmSync(path.join(dist, 'index.html'))

    const response = await fetch(`${base}/projects/manor`)

    expect(response.status).toBe(503)
    expect(await response.text()).toBe('unavailable\n')
    expect(response.headers.get('content-security-policy')).not.toBeNull()
    expect(response.headers.get('cache-control')).toBe('no-cache')
  })
})
