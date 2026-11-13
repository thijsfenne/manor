import type { ManorSession } from '@manor/client-runtime/auth'
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { AppState } from 'react-native'

import { authEnabled } from '@/lib/config'
import { authClient } from '@/lib/authClient'
import { watchAuthSession } from './appLifecycle'

interface AuthContextValue {
  enabled: boolean
  ready: boolean
  session: ManorSession | null
  sessionKey: string
  getToken: () => string | null
  signIn: (email: string, password: string) => Promise<string | null>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<ManorSession | null>(null)
  const [ready, setReady] = useState(!authEnabled)

  useEffect(() => {
    if (authClient === null) return
    return watchAuthSession(authClient, AppState, (nextSession) => {
      setSession(nextSession)
      setReady(true)
    })
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({
      enabled: authEnabled,
      ready,
      session,
      sessionKey: session?.user.id ?? 'local',
      getToken: () => session?.access_token ?? null,
      signIn: async (email, password) => {
        if (authClient === null) return 'Authentication is not configured.'
        return authClient.signIn(email, password)
      },
      signOut: async () => {
        if (authClient !== null) await authClient.signOut()
      },
    }),
    [ready, session],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext)
  if (value === null) throw new Error('useAuth must be used inside AuthProvider')
  return value
}
