interface BrowserLocation {
  protocol: string
  host: string
}

/**
 * A production build talks back to the origin that served it. That keeps one
 * artifact valid at localhost and behind a private HTTPS reverse proxy. Dev can
 * still point at a separate backend with VITE_MANOR_WS.
 */
export function resolveWebSocketUrl(configured: string | undefined, location: BrowserLocation): string {
  if (configured !== undefined && configured.trim() !== '') return configured
  if (location.protocol === 'http:' || location.protocol === 'https:') {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${protocol}//${location.host}/ws`
  }
  return 'ws://localhost:8787/ws'
}
