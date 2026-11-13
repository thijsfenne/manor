const normalizeWebSocketUrl = (value: string | undefined): string => {
  const configured = value?.trim()
  return configured === undefined || configured === '' ? 'ws://127.0.0.1:43179/ws' : configured
}

export const mobileConfig = {
  webSocketUrl: normalizeWebSocketUrl(process.env.EXPO_PUBLIC_MANOR_WS),
}

/** The Mac this app is the remote for, as the socket names it. */
export const hostName = /^wss?:\/\/([^/:?#]+)/.exec(mobileConfig.webSocketUrl)?.[1] ?? 'Mac'

/**
 * The same server over plain HTTP. The Mac answers the websocket and serves its
 * capability-signed media on one port, so the socket URL is the only address this
 * app ever needs to be told.
 */
export const httpOrigin = /^wss?:\/\/[^/?#]+/.exec(mobileConfig.webSocketUrl)?.[0].replace(/^ws/, 'http') ?? ''

/**
 * An absolute URL for something the server hosts. Off-site pictures come back as
 * their own URL and are handed through; a Manor path is only loadable once the
 * host is in front of it, and stays undefined when there is no host to name.
 */
export const serverMediaUri = (url: string): string | undefined =>
  /^https?:\/\//i.test(url) ? url : httpOrigin === '' ? undefined : `${httpOrigin}${url}`

export const authEnabled = process.env.EXPO_PUBLIC_MANOR_AUTH !== 'off'
