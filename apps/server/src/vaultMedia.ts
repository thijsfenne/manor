import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { MAX_VAULT_IMAGE_BYTES, VAULT_IMAGE_PATH, isVaultImagePath } from '@manor/contracts'
import { sniffVaultImage, type Vault } from './vault.js'

export interface VaultMedia {
  /** The signed link of one vault picture, which the listing hands to clients. */
  src(vaultPath: string): string
  /** Serves a link from `src`; false when the request is not under the vault picture prefix. */
  handle(request: IncomingMessage, response: ServerResponse): boolean
}

/** Longest request path read, so a hostile URL costs nothing to refuse. */
const MAX_URL_CHARS = 4_096

/**
 * Serves the pictures of the vault as `/media/vault/<signature>/<path>`. The signature
 * covers the vault path, with a key that lives for one server process, so only a link the
 * listing handed out opens a file and a client cannot ask for an arbitrary path. The
 * signature is not the only guard: every request is checked again as a path inside the
 * vault, a real file and a real picture by its bytes, so a link can never reach a note, a
 * dot-folder or a file a symlink points to outside the vault. The path is read from the
 * raw URL, because `new URL` would fold `..` away before it could be refused.
 */
export function createVaultMedia(options: { vault: Vault; key?: Buffer }): VaultMedia {
  const { vault } = options
  const key = options.key ?? randomBytes(32)
  const sign = (vaultPath: string) => createHmac('sha256', key).update(vaultPath).digest('base64url').slice(0, 32)

  async function serve(request: IncomingMessage, response: ServerResponse) {
    const refuse = (status: number) => {
      response.writeHead(status, { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
      response.end()
    }
    const head = request.method === 'HEAD'
    if (request.method !== 'GET' && !head) return refuse(404)

    const raw = (request.url ?? '').slice(VAULT_IMAGE_PATH.length).split(/[?#]/)[0] ?? ''
    if (raw.length > MAX_URL_CHARS) return refuse(404)
    const [signature, ...encoded] = raw.split('/')
    let segments: string[]
    try {
      segments = encoded.map(decodeURIComponent)
    } catch {
      return refuse(404)
    }
    const expected = Buffer.from(sign(segments.join('/')))
    const provided = Buffer.from(signature ?? '')
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return refuse(404)

    const unsafe = (segment: string) =>
      segment === '' || segment.startsWith('.') || segment.includes('/') || segment.includes('\\') || segment.includes('\0')
    if (segments.length === 0 || segments.some(unsafe)) return refuse(404)
    if (!isVaultImagePath(segments.at(-1)!)) return refuse(415)

    const real = await realpath(path.join(vault.root, ...segments)).catch(() => null)
    if (real === null) return refuse(404)
    if (real !== vault.root && !real.startsWith(vault.root + path.sep)) return refuse(404)

    let handle
    try {
      // The path is already fully resolved, so a link swapped in after the check still fails to open.
      handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch {
      return refuse(404)
    }
    try {
      const info = await handle.stat()
      if (!info.isFile()) return refuse(404)
      if (info.size > MAX_VAULT_IMAGE_BYTES) return refuse(413)
      const start = Buffer.alloc(32)
      const { bytesRead } = await handle.read(start, 0, start.length, 0)
      const sniffed = sniffVaultImage(start.subarray(0, bytesRead))
      if (sniffed === undefined) return refuse(415)

      const etag = `"${Math.round(info.mtimeMs).toString(36)}-${info.size.toString(36)}"`
      const headers = {
        'content-type': sniffed.mime,
        'x-content-type-options': 'nosniff',
        'cache-control': 'private, no-cache',
        'content-security-policy': "default-src 'none'; sandbox",
        'referrer-policy': 'no-referrer',
        etag,
      }
      const sent = request.headers['if-none-match']
      if (typeof sent === 'string' && sent.split(',').some((candidate) => candidate.trim() === etag || candidate.trim() === '*')) {
        response.writeHead(304, headers)
        response.end()
        return
      }
      if (head) {
        response.writeHead(200, { ...headers, 'content-length': String(info.size) })
        response.end()
        return
      }
      // Read only the size checked above: a file still growing cannot carry the read past the cap.
      const body = Buffer.alloc(info.size)
      let filled = 0
      while (filled < body.length) {
        const { bytesRead } = await handle.read(body, filled, body.length - filled, filled)
        if (bytesRead === 0) break
        filled += bytesRead
      }
      response.writeHead(200, { ...headers, 'content-length': String(filled) })
      response.end(body.subarray(0, filled))
    } finally {
      await handle.close().catch(() => undefined)
    }
  }

  return {
    src: (vaultPath) => `${VAULT_IMAGE_PATH}${sign(vaultPath)}/${vaultPath.split('/').map(encodeURIComponent).join('/')}`,
    handle(request, response) {
      if (request.url?.startsWith(VAULT_IMAGE_PATH) !== true) return false
      // Nothing here logs the URL: a vault path is a note's private name.
      void serve(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(500, { 'cache-control': 'no-store' })
        response.end()
      })
      return true
    },
  }
}
