import { useCallback, useEffect, useRef, useState } from 'react'
import { PAIRING_PATH } from '@manor/contracts'
import { checkDevice, redeemPairingLink, unpairDevice, type DeviceCredential, type PairResult } from '@manor/client-runtime/pairing'
import { authDisabled, browserName, clearCredential, loadCredential, saveCredential, serverOrigin } from './deviceAccess'
import { desktopLocalAccess } from './desktopBrowser'

/**
 * 'unknown' is the moment before the stored pairing has been read, and 'pairing' the
 * moment a pairing link is being redeemed: showing the Connect screen during either
 * would flash it at someone who is about to get in. 'local' is the desktop shell on
 * the Mac that runs the server: it holds the server's own key, so there is nothing to
 * pair and nothing to forget.
 */
export type AuthState =
  | { status: 'disabled' }
  | { status: 'unknown' }
  | { status: 'pairing' }
  | { status: 'local' }
  | { status: 'unpaired'; error: string | null }
  | { status: 'paired'; deviceId: string }

export interface Auth {
  state: AuthState
  /** Forgets this browser here and on the Mac. */
  forget: () => void
  /** The current device token, read at connect time so it is never a stale copy. */
  getToken: () => string | null
  /** Called when a socket was turned away at the door. */
  refresh: () => void
}

/** A refused handshake retries on backoff, so one check per half minute is plenty. */
const REFRESH_INTERVAL_MS = 30_000

/** The link this page was opened with, when it is a pairing link. */
const pairingLinkInLocation = (): string | null =>
  window.location.pathname === PAIRING_PATH && window.location.hash.includes('code=') ? window.location.href : null

/**
 * One redemption per link and page load. A replayed effect (development Strict Mode)
 * waits on the first request instead of spending the one-time code a second time.
 */
let redemption: { link: string; result: Promise<PairResult> } | null = null
function redeemOnce(link: string): Promise<PairResult> {
  if (redemption?.link !== link) redemption = { link, result: redeemPairingLink(link, browserName(navigator.userAgent)) }
  return redemption.result
}

/**
 * Owns this browser's way in. The desktop shell asks its own Mac for the key; any other
 * browser pairs once through a link from Settings → Phone on the Mac and keeps the
 * device token it got. Opening that link here redeems it and takes the code out of the
 * address bar.
 */
export function useAuth(): Auth {
  const [state, setState] = useState<AuthState>(authDisabled ? { status: 'disabled' } : { status: 'unknown' })
  const credentialRef = useRef<DeviceCredential | null>(null)
  const localTokenRef = useRef<string | null>(null)
  const lastRefreshRef = useRef(0)

  useEffect(() => {
    if (authDisabled) return
    let disposed = false

    const usePairing = () => {
      if (disposed) return
      const link = pairingLinkInLocation()
      if (link === null) {
        const held = loadCredential(serverOrigin())
        credentialRef.current = held
        setState(held === null ? { status: 'unpaired', error: null } : { status: 'paired', deviceId: held.deviceId })
        return
      }
      setState({ status: 'pairing' })
      void redeemOnce(link).then((result) => {
        if (disposed) return
        // The code is spent either way; it has no business staying in the address bar or history.
        window.history.replaceState(null, '', '/')
        if (!result.ok) {
          credentialRef.current = loadCredential(serverOrigin())
          setState(credentialRef.current === null ? { status: 'unpaired', error: result.error } : { status: 'paired', deviceId: credentialRef.current.deviceId })
          return
        }
        try { saveCredential(serverOrigin(), result.credential) } catch { /* Paired for this visit; the next one pairs again. */ }
        credentialRef.current = result.credential
        setState({ status: 'paired', deviceId: result.credential.deviceId })
      })
    }

    const readLocal = desktopLocalAccess()
    if (readLocal === undefined) usePairing()
    else {
      void readLocal().then(
        (token) => {
          if (disposed) return
          if (token === null) return usePairing()
          localTokenRef.current = token
          setState({ status: 'local' })
        },
        usePairing,
      )
    }
    return () => { disposed = true }
  }, [])

  const forget = useCallback(() => {
    const held = credentialRef.current
    credentialRef.current = null
    clearCredential(serverOrigin())
    setState({ status: 'unpaired', error: null })
    if (held !== null) void unpairDevice(held)
  }, [])

  const getToken = useCallback(() => localTokenRef.current ?? credentialRef.current?.token ?? null, [])

  const refresh = useCallback(() => {
    const now = Date.now()
    if (now - lastRefreshRef.current < REFRESH_INTERVAL_MS) return
    lastRefreshRef.current = now
    if (localTokenRef.current !== null) {
      // A turned-away key was replaced on disk (the file was deleted to change the lock): read it again.
      void desktopLocalAccess()?.().then((token) => { if (token !== null) localTokenRef.current = token }, () => undefined)
      return
    }
    const held = credentialRef.current
    if (held === null) return
    void checkDevice(held).then((verdict) => {
      if (verdict !== 'revoked' || credentialRef.current !== held) return
      credentialRef.current = null
      clearCredential(serverOrigin())
      setState({ status: 'unpaired', error: 'This browser was removed from Manor. Pair it again.' })
    })
  }, [])

  return { state, forget, getToken, refresh }
}
