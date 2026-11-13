import { execFile } from 'node:child_process'
import type { LocalServer } from '@manor/contracts'

const PROBE_TIMEOUT_MS = 800
const TITLE_MAX_BYTES = 64 * 1024
const LOOPBACK_OR_ANY = new Set(['*', '0.0.0.0', '::', '127.0.0.1', '::1', 'localhost'])

/**
 * Ports this user's processes listen on, from `lsof -F cn` records. Only loopback or
 * wildcard binds count, and never the privileged range, so a new tab offers what
 * `localhost:<port>` would reach.
 */
export function parseListeningPorts(output: string): Map<number, string> {
  const ports = new Map<number, string>()
  let command = ''
  for (const line of output.split('\n')) {
    if (line.startsWith('c')) command = line.slice(1)
    if (!line.startsWith('n')) continue
    const endpoint = line.slice(1)
    const colon = endpoint.lastIndexOf(':')
    const host = endpoint.slice(0, colon).replace(/^\[|\]$/g, '')
    const port = Number(endpoint.slice(colon + 1))
    if (colon < 0 || !Number.isInteger(port) || port < 1024 || !LOOPBACK_OR_ANY.has(host)) continue
    if (!ports.has(port)) ports.set(port, command)
  }
  return ports
}

/** The page's own `<title>`, entity-decoded and collapsed, or null when it has none. */
export function pageTitle(html: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  if (!match) return null
  const title = (match[1] ?? '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/\s+/g, ' ').trim()
  return title === '' ? null : title.slice(0, 200)
}

/**
 * Local servers a browser tab can open: a listening port counts only when it answers
 * with a web page. That one probe filters out databases, app helpers and RPC sockets
 * without keeping a list of process names. `exclude` holds Manor's own ports.
 */
export async function listLocalServers(
  exclude: ReadonlySet<number>,
  // Tests pass their own listeners: probing every port on the machine reaches other suites' servers.
  listeners: () => Promise<string> = lsofListeners,
): Promise<LocalServer[]> {
  const output = await listeners()
  const candidates = [...parseListeningPorts(output)].filter(([port]) => !exclude.has(port))
  const probed = await Promise.all(candidates.map(async ([port, command]) => {
    const title = await probe(port)
    return title === undefined ? null : { url: `http://localhost:${port}`, port, title: title ?? command }
  }))
  return probed.filter((server) => server !== null).sort((a, b) => a.port - b.port)
}

function lsofListeners(): Promise<string> {
  return new Promise((resolve) => {
    // lsof exits 1 when some processes are not inspectable; what it printed still holds.
    execFile('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'cn'], { maxBuffer: 2 * 1024 * 1024 },
      (_error, stdout) => resolve(typeof stdout === 'string' ? stdout : ''))
  })
}

/** The page title, null for a page without one, undefined when the port serves no page. */
async function probe(port: number): Promise<string | null | undefined> {
  try {
    const response = await fetch(`http://localhost:${port}/`, {
      headers: { accept: 'text/html' },
      redirect: 'manual',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel()
      return null
    }
    if (!(response.headers.get('content-type') ?? '').includes('text/html')) {
      await response.body?.cancel()
      return undefined
    }
    return pageTitle(await readPrefix(response))
  } catch {
    return undefined
  }
}

async function readPrefix(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const decoder = new TextDecoder()
  let text = ''
  let bytes = 0
  while (bytes < TITLE_MAX_BYTES) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.byteLength
    text += decoder.decode(value, { stream: true })
    if (/<\/title>/i.test(text)) break
  }
  await reader.cancel()
  return text
}
