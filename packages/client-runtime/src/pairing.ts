import {
  PairDeviceResponseSchema,
  PairRedeemResponseSchema,
  PAIRING_PATH,
  parsePairingLink,
} from '@manor/contracts'

/**
 * What a paired phone or browser keeps: the Mac's address and its own device token.
 * Each app stores it in its own private place (the iOS Keychain, the browser's
 * storage) and hands it back here.
 */
export interface DeviceCredential {
  origin: string
  token: string
  deviceId: string
}

/**
 * A Mac that cannot be reached would otherwise wait out the OS's own timeout, and the
 * Connect screen would spin for a minute before saying anything.
 */
const REQUEST_TIMEOUT_MS = 10_000

type Fetch = typeof fetch

const withDeadline = async (fetcher: Fetch, url: string, init: RequestInit): Promise<Response> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    return await fetcher(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

export type PairResult = { ok: true; credential: DeviceCredential } | { ok: false; error: string }

/** The words a person sees for a link that is not one, shared by the phone and the web. */
export const NOT_A_PAIRING_LINK = 'That is not a Manor pairing link. Copy it again from Settings → Phone on your Mac.'

/** Redeems a pairing link once. The code in it is spent whether or not the reply arrives. */
export async function redeemPairingLink(link: string, name: string, fetcher: Fetch = globalThis.fetch.bind(globalThis)): Promise<PairResult> {
  const parsed = parsePairingLink(link)
  if (parsed === null) return { ok: false, error: NOT_A_PAIRING_LINK }
  let response: Response
  try {
    response = await withDeadline(fetcher, `${parsed.origin}${PAIRING_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: parsed.code, name }),
    })
  } catch {
    return { ok: false, error: 'Cannot reach your Mac. Check that it is awake, Manor is running and both devices are on Tailscale.' }
  }
  if (response.status === 410 || response.status === 401) {
    return { ok: false, error: 'This pairing link has expired or was already used. Make a new one in Settings → Phone on your Mac.' }
  }
  if (!response.ok) return { ok: false, error: 'Manor could not pair this device. Try again with a new link.' }
  try {
    const body = PairRedeemResponseSchema.parse(await response.json())
    return { ok: true, credential: { origin: parsed.origin, token: body.token, deviceId: body.deviceId } }
  } catch {
    return { ok: false, error: 'Manor could not pair this device. Try again with a new link.' }
  }
}

/**
 * Whether the Mac still knows this device. Asked after a socket was turned away, so a
 * revoked device can go back to the Connect screen while a Mac that is merely asleep
 * keeps the saved connection.
 */
export async function checkDevice(credential: DeviceCredential, fetcher: Fetch = globalThis.fetch.bind(globalThis)): Promise<'paired' | 'revoked' | 'unreachable'> {
  try {
    const response = await withDeadline(fetcher, `${credential.origin}${PAIRING_PATH}/device`, {
      headers: { Authorization: `Bearer ${credential.token}` },
    })
    if (response.status === 401) return 'revoked'
    if (!response.ok) return 'unreachable'
    PairDeviceResponseSchema.parse(await response.json())
    return 'paired'
  } catch {
    return 'unreachable'
  }
}

/** Tells the Mac to forget this device. Best effort: forgetting still happens offline. */
export async function unpairDevice(credential: DeviceCredential, fetcher: Fetch = globalThis.fetch.bind(globalThis)): Promise<void> {
  try {
    await withDeadline(fetcher, `${credential.origin}${PAIRING_PATH}/device`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${credential.token}` },
    })
  } catch {
    // The device list on the Mac still offers Revoke.
  }
}

/** Reads a stored credential, or null for nothing or anything that is not one. */
export function readCredential(raw: string | null): DeviceCredential | null {
  if (raw === null) return null
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null) return null
    const { origin, token, deviceId } = value as Record<string, unknown>
    if (typeof origin !== 'string' || typeof token !== 'string' || typeof deviceId !== 'string') return null
    return { origin, token, deviceId }
  } catch {
    return null
  }
}
