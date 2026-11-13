export const DEFAULT_RENDERER_URL = 'http://localhost:43179/'

/**
 * The desktop shell and the WebSocket must share one HTTP origin. A packaged
 * `file://` renderer cannot pass Manor's origin guard, and root-relative assets
 * resolve against the Mac filesystem instead of the web build.
 */
export function resolveRendererUrl(setting?: string): string {
  const url = new URL(setting ?? DEFAULT_RENDERER_URL)
  const isLoopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.protocol !== 'http:' || !isLoopback) {
    throw new Error('MANOR_DESKTOP_URL must be an http URL on the local machine.')
  }
  return url.href
}

export function isAllowedRendererNavigation(url: string, rendererUrl: string): boolean {
  return new URL(url).origin === new URL(rendererUrl).origin
}
