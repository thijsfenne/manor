/**
 * What the renderer itself is allowed to ask Chromium for. The shell denies by
 * default: camera, microphone, geolocation and the page's own `Notification` all go
 * through here, and done notices ship through the host bridge instead precisely
 * because this says no.
 *
 * Writing to the clipboard is the one exception. Chromium routes every
 * `navigator.clipboard.writeText` through this handler, so a blanket deny turns each
 * copy button in Manor into a control that rejects silently — which is exactly what
 * happened to the note header's "copy path" between the vault landing and the in-app
 * browser's arrival. Sanitized write is a user-gesture-only, same-app capability with
 * no read side, so granting it hands out nothing the page could not already do with a
 * hidden textarea and `execCommand`.
 *
 * Fullscreen is the other: a video in the shared browser goes fullscreen through the
 * `<webview>` element that holds it, which is Manor's own page asking.
 */
const ALLOWED = new Set(['clipboard-sanitized-write', 'fullscreen'])

export function allowsRendererPermission(permission: string): boolean {
  return ALLOWED.has(permission)
}

/**
 * What a page in the shared browser may ask Chromium for: fullscreen, and nothing
 * else. A video's own fullscreen button is a user gesture Chromium already gates,
 * and it hands the page no more than the screen it was already drawing on. Every
 * other request (camera, location, notifications) stays a silent no.
 */
export function allowsBrowserPagePermission(permission: string): boolean {
  return permission === 'fullscreen'
}
