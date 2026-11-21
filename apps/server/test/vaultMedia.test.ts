import { createHmac } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { request as httpRequest, createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { VAULT_IMAGE_PATH } from '@manor/contracts'
import { openVault, type Vault } from '../src/vault.js'
import { createVaultMedia } from '../src/vaultMedia.js'

const KEY = Buffer.alloc(32, 7)
const sign = (vaultPath: string) => createHmac('sha256', KEY).update(vaultPath).digest('base64url').slice(0, 32)
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24)])

let root: string
let outside: string
let vault: Vault
let server: Server
let base: string
let media: ReturnType<typeof createVaultMedia>

beforeEach(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), 'manor-vaultmedia-'))
  outside = mkdtempSync(path.join(os.tmpdir(), 'manor-vaultmedia-out-'))
  mkdirSync(path.join(root, 'pics'))
  mkdirSync(path.join(root, '.obsidian'))
  writeFileSync(path.join(root, 'pics', 'real.png'), PNG)
  writeFileSync(path.join(root, 'pics', 'text.png'), 'this is not a picture')
  writeFileSync(path.join(root, 'pics', 'note.md'), '# note')
  writeFileSync(path.join(root, '.obsidian', 'hidden.png'), PNG)
  writeFileSync(path.join(outside, 'secret.png'), PNG)
  symlinkSync(path.join(outside, 'secret.png'), path.join(root, 'pics', 'link.png'))
  symlinkSync(outside, path.join(root, 'linked-folder'))
  const opened = await openVault(root)
  if (!opened.ok) throw new Error(opened.message)
  vault = opened.vault
  media = createVaultMedia({ vault, key: KEY })
  server = createServer((request, response) => {
    if (!media.handle(request, response)) {
      response.writeHead(418)
      response.end()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = String((server.address() as AddressInfo).port)
})

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

/** A raw request path, because fetch and `new URL` would fold `..` away before the server saw it. */
const get = (rawPath: string, headers: Record<string, string> = {}, method = 'GET') =>
  new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: Number(base), path: rawPath, method, headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    req.end()
  })

/** A link as the server would hand it out, for a path it was never asked to link. */
const signed = (decoded: string, encoded = decoded.split('/').map(encodeURIComponent).join('/')) =>
  `${VAULT_IMAGE_PATH}${sign(decoded)}/${encoded}`

describe('vault picture route', () => {
  it('serves a real picture with the type its bytes declare, and answers a revalidation with 304', async () => {
    const first = await get(media.src('pics/real.png').replace(/^(\/media\/vault\/)[^/]+/, `$1${sign('pics/real.png')}`))
    expect(first.status).toBe(200)
    expect(first.headers['content-type']).toBe('image/png')
    expect(first.headers['content-length']).toBe(String(PNG.length))
    expect(first.headers['x-content-type-options']).toBe('nosniff')
    expect(first.headers['cache-control']).toBe('private, no-cache')
    expect(first.headers['content-security-policy']).toBe("default-src 'none'; sandbox")
    expect(first.headers['referrer-policy']).toBe('no-referrer')
    expect(first.body.equals(PNG)).toBe(true)

    const etag = String(first.headers.etag)
    const again = await get(signed('pics/real.png'), { 'if-none-match': etag })
    expect(again.status).toBe(304)
    expect(again.body.length).toBe(0)
  })

  it('links with encoded segments that sign the decoded path', async () => {
    writeFileSync(path.join(root, 'pics', 'my pic #1.png'), PNG)
    const src = createVaultMedia({ vault, key: KEY }).src('pics/my pic #1.png')
    expect(src).toBe(`${VAULT_IMAGE_PATH}${sign('pics/my pic #1.png')}/pics/my%20pic%20%231.png`)
    expect((await get(src)).status).toBe(200)
  })

  it('answers HEAD without a body', async () => {
    const result = await get(signed('pics/real.png'), {}, 'HEAD')
    expect(result.status).toBe(200)
    expect(result.body.length).toBe(0)
  })

  it('is 404 for a missing file, a bad signature and a missing signature', async () => {
    expect((await get(signed('pics/gone.png'))).status).toBe(404)
    expect((await get(`${VAULT_IMAGE_PATH}${'a'.repeat(32)}/pics/real.png`)).status).toBe(404)
    expect((await get(`${VAULT_IMAGE_PATH}pics/real.png`)).status).toBe(404)
    expect((await get(VAULT_IMAGE_PATH)).status).toBe(404)
  })

  it('refuses a traversal even when it carries a valid signature', async () => {
    expect((await get(signed('../secret.png'))).status).toBe(404)
    expect((await get(signed('pics/../../secret.png'))).status).toBe(404)
    expect((await get(signed('../secret.png', '%2e%2e/secret.png'))).status).toBe(404)
    expect((await get(signed('pics/../../secret.png', 'pics/%2e%2e/%2e%2e/secret.png'))).status).toBe(404)
    expect((await get(signed(path.join(outside, 'secret.png'), encodeURIComponent(path.join(outside, 'secret.png'))))).status).toBe(404)
    expect((await get(signed(`/${path.join(outside, 'secret.png')}`))).status).toBe(404)
    expect((await get(signed('pics%2f..%2f..%2fsecret.png', 'pics%252f..%252f..%252fsecret.png'))).status).toBe(404)
  })

  it('refuses a dot-folder and a NUL even with a valid signature', async () => {
    expect((await get(signed('.obsidian/hidden.png'))).status).toBe(404)
    expect((await get(signed('pics/real.png\0'))).status).toBe(404)
  })

  it('refuses a symlink that points outside the vault, to a file or to a folder', async () => {
    expect((await get(signed('pics/link.png'))).status).toBe(404)
    expect((await get(signed('linked-folder/secret.png'))).status).toBe(404)
  })

  it('refuses what is not a picture: a text file named .png, a note and a folder', async () => {
    expect((await get(signed('pics/text.png'))).status).toBe(415)
    expect((await get(signed('pics/note.md'))).status).toBe(415)
    expect((await get(signed('pics'))).status).toBe(415)
    expect((await get(signed('pics/real.png/'))).status).toBe(404)
  })

  it('refuses writes and ignores other prefixes', async () => {
    expect((await get(signed('pics/real.png'), {}, 'POST')).status).toBe(404)
    expect((await get('/media/chat/anything')).status).toBe(418)
  })
})
