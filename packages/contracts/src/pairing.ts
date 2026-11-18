import { z } from 'zod'

/**
 * Pairing a phone or a browser with the Mac. Settings on the Mac makes a one-time link,
 * `<origin>/pair#code=<code>`; the device redeems the code once over HTTPS and keeps the
 * device token it gets back. The code rides in the fragment, so it never reaches a
 * request line, a proxy log or a referrer.
 */
export const PAIRING_PATH = '/pair'

/** 32 random bytes, base64url: what a pairing code and a device secret both are. */
const SECRET = /^[A-Za-z0-9_-]{43}$/
export const PairingCodeSchema = z.string().regex(SECRET)
/** `<device id>.<secret>`; the server keeps only a hash of the secret. */
export const DeviceTokenSchema = z.string().regex(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/)
export const DeviceNameSchema = z.string().trim().min(1).max(80)

export const PairRedeemRequestSchema = z.object({ code: PairingCodeSchema, name: DeviceNameSchema })
export const PairRedeemResponseSchema = z.object({ token: DeviceTokenSchema, deviceId: z.string().uuid() })
/** `GET /pair/device` with the token as a bearer: who the server takes this device for. */
export const PairDeviceResponseSchema = z.object({ deviceId: z.string().uuid(), name: z.string() })
export const PairErrorSchema = z.object({ error: z.string() })

export const PairedDeviceSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  pairedAt: z.number().int().nonnegative(),
  lastSeenAt: z.number().int().nonnegative().nullable(),
  connected: z.boolean(),
})
export type PairedDevice = z.infer<typeof PairedDeviceSchema>

/**
 * What Tailscale on the Mac can do for Manor. Every state but `ready` names what the
 * user has to fix, so the panel never has to guess.
 */
export const TailscaleStatusSchema = z.discriminatedUnion('state', [
  /** Not asked yet since the server started. */
  z.object({ state: z.literal('checking') }),
  z.object({ state: z.literal('missing') }),
  z.object({ state: z.literal('stopped') }),
  z.object({ state: z.literal('logged_out') }),
  /**
   * Signed in, but the tailnet has no MagicDNS name or no HTTPS certificates. `serving`
   * says Manor's mapping is still there from before, so the switch can still remove it.
   */
  z.object({ state: z.literal('no_https'), serving: z.boolean() }),
  /** Port 443 on this Mac's tailnet name already serves something else, or Funnel is on for it. */
  z.object({ state: z.literal('conflict'), address: z.string(), funnel: z.boolean() }),
  z.object({ state: z.literal('ready'), address: z.string(), serving: z.boolean() }),
  z.object({ state: z.literal('error'), message: z.string() }),
])
export type TailscaleStatus = z.infer<typeof TailscaleStatusSchema>

export const PhoneAccessSchema = z.object({
  tailscale: TailscaleStatusSchema,
  devices: z.array(PairedDeviceSchema),
})
export type PhoneAccess = z.infer<typeof PhoneAccessSchema>

export const PairingLinkSchema = z.object({
  link: z.string(),
  expiresAt: z.number().int().nonnegative(),
})
export type PairingLink = z.infer<typeof PairingLinkSchema>

export function pairingLink(origin: string, code: string): string {
  return `${origin}${PAIRING_PATH}#${new URLSearchParams({ code }).toString()}`
}

/**
 * The server origin and code in a pairing link, or null for anything else. Accepts the
 * link with stray whitespace around it, as a paste or a QR payload may carry.
 */
export function parsePairingLink(text: string): { origin: string; code: string } | null {
  let url: URL
  try {
    url = new URL(text.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (url.pathname !== PAIRING_PATH) return null
  const code = new URLSearchParams(url.hash.replace(/^#/, '')).get('code')
  if (code === null || !SECRET.test(code)) return null
  return { origin: url.origin, code }
}

/** The socket address for a server origin. */
export const webSocketUrlFor = (origin: string): string => `${origin.replace(/^http/, 'ws')}/ws`
