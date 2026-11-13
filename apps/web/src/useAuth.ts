import { useCallback, useEffect, useRef, useState } from 'react'
import type { ManorSession } from '@manor/client-runtime/auth'
import { authClient } from './authClient'
import { desktopLocalAccess } from './desktopBrowser'

/**
 * 'unknown' is the moment before the stored session has been read. It matters:
 * showing the login screen during it would flash a sign-in form at someone who
 * is already signed in, every single load. 'local' is the desktop shell on the Mac
 * that runs the server: it holds the server's own key, so there is no account to
 * show and nothing to sign out of.
 */
export type AuthState =
  | { status: 'disabled' }
  | { status: 'unknown' }
  | { status: 'local' }
  | { status: 'signed-out' }
  | { status: 'signed-in'; userId: string; email: string }

export interface Auth {
  state: AuthState
  /** Resolves to the error message to show, or null when the sign-in worked. */
  signIn: (email: string, password: string) => Promise<string | null>
  signOut: () => void
  /** The current access token, read at connect time so it is never a stale copy. */
  getToken: () => string | null
  /** Ask for a fresh token; called when a socket was turned away at the door. */
  refresh: () => void
}

/** A refused handshake retries on backoff, so one refresh per half minute is plenty. */
const REFRESH_INTERVAL_MS = 30_000

/**
 * Owns the session for the whole app. The auth client does the persisting and the token
 * refreshing; this hook only turns its events into something the UI can render
 * and hands the socket a way to read the current token.
 */
export function useAuth(): Auth {
  const client = authClient
  const [state, setState] = useState<AuthState>(client === null ? { status: 'disabled' } : { status: 'unknown' })
  const tokenRef = useRef<string | null>(null)
  const lastRefreshRef = useRef(0)
  const localRef = useRef(false)

  useEffect(() => {
    if (client === null) return
    let disposed = false
    let leave = () => {}

    const apply = (session: ManorSession | null) => {
      if (disposed) return
      tokenRef.current = session?.access_token ?? null
      setState(
        session === null
          ? { status: 'signed-out' }
          : { status: 'signed-in', userId: session.user.id, email: session.user.email ?? 'signed in' },
      )
    }

    const useAccount = () => {
      if (disposed) return
      const unsubscribe = client.subscribe(apply)
      // Unreadable storage opens the login form rather than holding "Opening the house…"
      // forever. Signing in reads storage again, and the client's timer announces the
      // stored session by itself if a later read recovers.
      void client.getSession().then(apply, () => apply(null))
      client.setActive(true)
      leave = () => {
        unsubscribe()
        client.setActive(false)
      }
    }

    // The desktop shell asks its own Mac for the key first. No key (a browser tab, the
    // phone, a server without one) means the account door, exactly as before.
    const readLocal = desktopLocalAccess()
    if (readLocal === undefined) useAccount()
    else {
      void readLocal().then(
        (token) => {
          if (disposed) return
          if (token === null) return useAccount()
          localRef.current = true
          tokenRef.current = token
          setState({ status: 'local' })
        },
        useAccount,
      )
    }
    return () => {
      disposed = true
      leave()
    }
  }, [client])

  const signIn = useCallback(
    async (email: string, password: string) => {
      if (client === null) return null
      return client.signIn(email, password)
    },
    [client],
  )

  const signOut = useCallback(() => {
    if (client === null) return
    void client.signOut()
  }, [client])

  const getToken = useCallback(() => tokenRef.current, [])

  const refresh = useCallback(() => {
    if (client === null) return
    const now = Date.now()
    if (now - lastRefreshRef.current < REFRESH_INTERVAL_MS) return
    lastRefreshRef.current = now
    if (!localRef.current) return void client.refresh()
    // A turned-away key was replaced on disk (the file was deleted to change the lock): read it again.
    void desktopLocalAccess()?.().then((token) => { if (token !== null) tokenRef.current = token }, () => undefined)
  }, [client])

  return { state, signIn, signOut, getToken, refresh }
}
