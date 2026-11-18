import 'react-native-url-polyfill/auto'
import {
  redeemPairingLink,
  unpairDevice,
  type DeviceCredential,
} from '@manor/client-runtime/pairing'
import { parsePairingLink } from '@manor/contracts'
import Constants from 'expo-constants'
import * as Linking from 'expo-linking'
import { deleteItemAsync, getItemAsync, setItemAsync } from 'expo-secure-store'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { createCredentialStore, resolveDevServer, setConnectionOrigin } from '@/lib/connection'

export const REVOKED_NOTICE = 'This phone was removed from Manor. Pair it again.'

/** The verify fixture's server; null in every build a person installs. */
const devServer = resolveDevServer(process.env.EXPO_PUBLIC_MANOR_DEV_SERVER, __DEV__)
setConnectionOrigin(devServer)

const credentialStore = createCredentialStore({
  getItem: getItemAsync,
  setItem: setItemAsync,
  removeItem: deleteItemAsync,
})

interface ConnectionContextValue {
  /** False until the saved connection has been read. */
  ready: boolean
  credential: DeviceCredential | null
  /** Set by the development override: no pairing, no token. */
  devServer: string | null
  /** The Mac the socket and media loads go to. */
  origin: string | null
  /** Redeems a pairing link and saves the result. Null on success, else words for the person. */
  pair: (link: string) => Promise<string | null>
  /** Tells the Mac to drop this phone, then deletes the saved connection. */
  forget: () => Promise<void>
  /** The Mac no longer knows this phone: back to the Connect screen with a note. */
  revoked: (deviceId: string) => Promise<void>
  /** Why the Connect screen is showing, when it is not a first launch. */
  notice: string | null
  /**
   * A pairing link the system opened the app with (the camera or another app) while no
   * Mac was connected, with the Mac it names, waiting for the person to confirm it.
   */
  incomingLink: { link: string; origin: string } | null
  /** Turns the incoming link down. Opening the link again offers it again. */
  dismissIncoming: () => void
}

const ConnectionContext = createContext<ConnectionContextValue | null>(null)

export function ConnectionProvider({ children }: { children: ReactNode }) {
  const [credential, setCredential] = useState<DeviceCredential | null>(null)
  const [ready, setReady] = useState(devServer !== null)
  const [notice, setNotice] = useState<string | null>(null)
  const credentialRef = useRef(credential)
  const [incomingLink, setIncomingLink] = useState<{ link: string; origin: string } | null>(null)
  const dismissIncoming = useCallback(() => setIncomingLink(null), [])

  const apply = useCallback((next: DeviceCredential | null) => {
    credentialRef.current = next
    setConnectionOrigin(next?.origin ?? devServer)
    setCredential(next)
  }, [])

  useEffect(() => {
    if (devServer !== null) return
    let active = true
    void credentialStore.load().then((saved) => {
      if (!active) return
      apply(saved)
      setReady(true)
    })
    return () => { active = false }
  }, [apply])

  // Every delivery of a link counts, so a link turned down and opened again is offered
  // again. One that arrives while a Mac is connected is dropped, and leaving a Mac drops
  // the launch link, so neither turns up later as the next Mac to join.
  useEffect(() => {
    if (devServer !== null) return
    const offer = (link: string) => {
      const parsed = parsePairingLink(link)
      if (parsed !== null && credentialRef.current === null) setIncomingLink({ link, origin: parsed.origin })
    }
    void Linking.getInitialURL().then((link) => { if (link !== null) offer(link) })
    const subscription = Linking.addEventListener('url', ({ url }) => offer(url))
    return () => subscription.remove()
  }, [])

  const pair = useCallback(async (link: string) => {
    const result = await redeemPairingLink(link, `Manor app on ${Constants.deviceName ?? 'iPhone'}`.slice(0, 80))
    if (!result.ok) return result.error
    try {
      await credentialStore.save(result.credential)
    } catch {
      return 'Manor could not keep the connection on this phone. Try again with a new link.'
    }
    apply(result.credential)
    setNotice(null)
    setIncomingLink(null)
    return null
  }, [apply])

  const forget = useCallback(async () => {
    const current = credentialRef.current
    if (current !== null) await unpairDevice(current)
    await credentialStore.clear().catch(() => {})
    setNotice(null)
    setIncomingLink(null)
    apply(null)
  }, [apply])

  const revoked = useCallback(async (deviceId: string) => {
    if (credentialRef.current?.deviceId !== deviceId) return
    await credentialStore.clear().catch(() => {})
    setNotice(REVOKED_NOTICE)
    setIncomingLink(null)
    apply(null)
  }, [apply])

  const value = useMemo<ConnectionContextValue>(
    () => ({ ready, credential, devServer, origin: credential?.origin ?? devServer, pair, forget, revoked, notice, incomingLink, dismissIncoming }),
    [ready, credential, pair, forget, revoked, notice, incomingLink, dismissIncoming],
  )

  return <ConnectionContext.Provider value={value}>{children}</ConnectionContext.Provider>
}

export function useConnection(): ConnectionContextValue {
  const value = useContext(ConnectionContext)
  if (value === null) throw new Error('useConnection must be used inside ConnectionProvider')
  return value
}
