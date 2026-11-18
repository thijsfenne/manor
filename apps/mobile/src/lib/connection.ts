import { readCredential, type DeviceCredential } from '@manor/client-runtime/pairing'

/** The part of a key-value store the saved connection needs; the Keychain on the phone, a map in tests. */
export interface CredentialStorage {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
  removeItem(key: string): Promise<void>
}

/** One entry holds the Mac's origin and this phone's device token together. */
export const CREDENTIAL_KEY = 'manor.device'

export function createCredentialStore(storage: CredentialStorage) {
  return {
    /** A read that fails (a locked Keychain) lands as not paired, so the Connect screen shows instead of a spinner that never ends. */
    load: async (): Promise<DeviceCredential | null> => {
      try {
        return readCredential(await storage.getItem(CREDENTIAL_KEY))
      } catch {
        return null
      }
    },
    save: (credential: DeviceCredential): Promise<void> => storage.setItem(CREDENTIAL_KEY, JSON.stringify(credential)),
    clear: (): Promise<void> => storage.removeItem(CREDENTIAL_KEY),
  }
}

/**
 * The development server named for the verify fixture: an http(s) origin, honoured
 * only in a development build. Anything else, a path included, is ignored.
 */
export function resolveDevServer(value: string | undefined, isDev: boolean): string | null {
  if (!isDev) return null
  const origin = value?.trim().replace(/\/+$/, '')
  return origin !== undefined && /^https?:\/\/[^/?#\s]+$/i.test(origin) ? origin : null
}

let currentOrigin: string | null = null

/** Set by the connection provider whenever the saved connection or the dev override changes. */
export function setConnectionOrigin(origin: string | null): void {
  currentOrigin = origin
}

/** The Mac this app is the remote for, as its address names it. */
export const hostName = (): string => (currentOrigin === null ? undefined : /^https?:\/\/([^/:?#]+)/i.exec(currentOrigin)?.[1]) ?? 'Mac'

/**
 * An absolute URL for something the server hosts. Off-site pictures come back as
 * their own URL and are handed through; a Manor path is only loadable once the
 * Mac is in front of it, and stays undefined when no Mac is connected.
 */
export const serverMediaUri = (url: string): string | undefined =>
  /^https?:\/\//i.test(url) ? url : currentOrigin === null ? undefined : `${currentOrigin}${url}`
