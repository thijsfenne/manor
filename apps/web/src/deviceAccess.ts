import { readCredential, type DeviceCredential } from '@manor/client-runtime/pairing'

/** A test server can turn the door off, the mirror of the server's `MANOR_AUTH=off`. */
export const authDisabled = import.meta.env.VITE_MANOR_AUTH === 'off'

/** One stored pairing per browser profile and Mac address. */
const storageKey = (origin: string) => `manor.device.${origin}`

/** The Mac this page talks to: the origin that served it, or the dev socket's host. */
export const serverOrigin = (): string =>
  import.meta.env.VITE_MANOR_WS?.replace(/^ws/, 'http').replace(/\/ws$/, '') || window.location.origin

export function loadCredential(origin: string): DeviceCredential | null {
  try {
    return readCredential(window.localStorage.getItem(storageKey(origin)))
  } catch {
    return null
  }
}

export function saveCredential(origin: string, credential: DeviceCredential): void {
  window.localStorage.setItem(storageKey(origin), JSON.stringify(credential))
}

export function clearCredential(origin: string): void {
  try {
    window.localStorage.removeItem(storageKey(origin))
  } catch {
    // Storage that refuses to delete still loses the token from memory.
  }
}

/** A short name for this browser in the Mac's device list, such as "Browser on iPhone". */
export function browserName(userAgent: string): string {
  const device = /iPhone/.test(userAgent) ? 'iPhone'
    : /iPad/.test(userAgent) ? 'iPad'
    : /Android/.test(userAgent) ? 'Android'
    : /Macintosh/.test(userAgent) ? 'Mac'
    : /Windows/.test(userAgent) ? 'Windows'
    : undefined
  return device === undefined ? 'Browser' : `Browser on ${device}`
}
