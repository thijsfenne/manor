import { createReadStream, existsSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
}

export const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; " +
    // assets.unicorn.studio carries the new-session stage scene's glyph texture;
    // logos.composio.dev the brand marks on the Connectors page.
    "img-src 'self' data: https://assets.unicorn.studio https://logos.composio.dev; font-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "script-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss: https: http://127.0.0.1:43179 http://localhost:43179",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
} as const

const failure = (response: ServerResponse, status: 400 | 404 | 503, message: string): void => {
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-cache',
  })
  response.end(`${message}\n`)
}

const isFile = (target: string): boolean => {
  try {
    return statSync(target).isFile()
  } catch {
    return false
  }
}

/**
 * Serves the built SPA from one directory (`MANOR_WEB_DIST`) on the same port as
 * the WebSocket, so the VPS needs no separate web server. Unknown paths fall back
 * to index.html (the SPA router owns them). Returns a handler, or undefined when
 * the directory is not configured or missing — dev keeps Vite and the plain
 * "manor server" banner.
 */
export function createStaticHandler(dist: string | undefined) {
  if (dist === undefined || dist.length === 0 || !existsSync(dist)) return undefined
  const root = path.resolve(dist)

  return (request: IncomingMessage, response: ServerResponse): void => {
    // A raw target like `http://[` makes URL throw, and this runs synchronously in the
    // server's request callback, before auth, so an uncaught throw would end the process.
    let url: URL
    try {
      url = new URL(request.url ?? '/', 'http://manor')
    } catch {
      failure(response, 400, 'bad request')
      return
    }
    const requested = path.resolve(root, `.${path.normalize(url.pathname)}`)
    // Extensionless client routes belong to the SPA. Missing assets and any path
    // outside the build are real 404s, so a broken deployment cannot look healthy.
    const inRoot = requested === root || requested.startsWith(`${root}${path.sep}`)
    const exists = inRoot && existsSync(requested) && isFile(requested)
    const isAsset = path.extname(url.pathname) !== ''
    if (!inRoot || (!exists && isAsset)) {
      failure(response, 404, 'not found')
      return
    }
    const file = exists ? requested : path.join(root, 'index.html')
    const stream = createReadStream(file)
    let opened = false
    stream.once('error', () => {
      if (!opened && !response.headersSent) {
        const shell = file.endsWith('index.html')
        failure(response, shell ? 503 : 404, shell ? 'unavailable' : 'not found')
        return
      }
      response.destroy()
    })
    stream.once('open', () => {
      opened = true
      response.writeHead(200, {
        ...SECURITY_HEADERS,
        'content-type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream',
        // The shell must never be cached stale; hashed assets may be cached hard.
        'cache-control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
      })
      stream.pipe(response)
    })
  }
}
